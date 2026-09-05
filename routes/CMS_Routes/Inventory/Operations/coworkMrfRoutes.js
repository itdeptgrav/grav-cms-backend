// routes/CMS_Routes/Inventory/Operations/coworkMrfRoutes.js
// ──────────────────────────────────────────────────────────────────────────────
// MRF endpoints for the COWORK side.
//
// Serves two audiences from the same Firebase session:
//   • the requester    — raises requests, tracks them, chats
//   • the TL / Primary Manager — approvals queue, approve / reject, chat
//
// Approval flow:  Employee → Primary Manager/TL → Store
// The Project Manager is not part of this flow.
//
// req.coworkUser = { employeeId, role, name, authUid, employeeData }
//   employeeId = biometricId string (e.g. "GR022")  ← what TL routing keys on
//   role       = "employee" | "tl" | "ceo"
// ──────────────────────────────────────────────────────────────────────────────

const express = require("express")
const router = express.Router()
const MRF = require("../../../../models/CMS_Models/Inventory/Operations/MRF")
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem")
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit")
const Employee = require("../../../../models/Employee")
const NotificationService = require("../../../../services/NotificationService")
const RawItemAddRequest = require("../../../../models/CMS_Models/Inventory/Operations/RawItemAddRequest")

const mrfApprover = require("../../../../services/mrfApprover.service")
const mrfNotify = require("../../../../services/mrfNotify.service")
const mrfChat = require("../../../../services/mrfChat.service")
const { buildContext } = require("../../../../services/mrfContext.service")
const { buildUnitConversions, enrichItemsWithStock } = require("../../../../services/mrfUnits.service")

const {
  verifyCoworkToken,
  verifyEmployeeToken,
} = require("../../../../Middlewear/coworkAuth")

// ── TWO FRONT DOORS, ONE SET OF HANDLERS ─────────────────────────────────────
//
// Everything below is the requester-and-TL half of MRF: raise a request, track
// it, approve or reject the ones routed to you. It runs on the CMS's own Mongo
// data, the same collection the store side reads at /api/cms/inventory/mrf —
// the only thing that was ever "Cowork" about it was the door it came in by.
//
// Material Requests is a CMS app now, opened from the launcher with a CMS
// login, and a person may hold it without holding Cowork at all. So the same
// handlers are mounted twice, behind two different authentications:
//
//   /api/cowork/mrf   Firebase session   — the Cowork app, unchanged
//   /api/cms/mrf      CMS employee JWT   — the Material Requests app
//
// Each door only has to end up at the same `req.user`: an employee's
// biometricId, their role, and their name. That is the whole of what the
// handlers below read — TL routing keys on biometricId and `primaryManager`,
// neither of which knows or cares which door was used.
//
// Deliberately NOT a copy of the file. Two copies of an approval flow is two
// approval flows, and the second one is always the one nobody remembers to fix.
const attach = (req, _res, next) => {
  req.user = {
    id: req.coworkUser.employeeId,  // biometricId string
    role: req.coworkUser.role,
    name: req.coworkUser.name,
  }
  next()
}

/**
 * The CMS door.
 *
 * `EmployeeAuth` has already verified the CMS cookie or bearer token and put
 * the employee on `req.user`; this restates it in the shape the handlers read.
 *
 * `employeeId` is the biometricId, which is what every approver lookup keys on
 * — an employee whose token carries no biometricId cannot be routed to a TL,
 * so they are refused here rather than silently landing in nobody's queue.
 *
 * The role is mapped, not trusted: the CMS has a dozen department roles and
 * this file understands three. Anything that is not the executive office is an
 * ordinary requester, and whether they can approve is decided by the approver
 * service from the org chart, not by the word in their token.
 */
function cmsAttach(req, res, next) {
  const employeeId = req.user?.employeeId
  if (!employeeId) {
    return res.status(403).json({
      success: false,
      message:
        "Your staff record has no employee ID, so material requests cannot be routed to an approver. Ask HR to add one.",
    })
  }
  const role = String(req.user.role || "").toLowerCase()
  req.coworkUser = {
    employeeId,
    role: role === "ceo" ? "ceo" : "employee",
    name: req.user.name || "",
  }
  req.user = { id: employeeId, role: req.coworkUser.role, name: req.coworkUser.name }
  next()
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/* ── Chunk 1B: tenancy, idempotency and history on the requester door ──────
 * This door already scopes correctly by RELATIONSHIP — a requester sees their
 * own requests, an approver sees the ones routed to them — which is why it
 * keeps that logic unchanged. What it never had is a company boundary, a
 * defence against a retried submission, or an immutable record of the
 * decisions taken through it. */
const {
  requireTenantForEmployee, withIdempotency, refuseLegacyWrite,
} = require("../../../../Middlewear/storePurchaseTenant")
const tenantContext = require("../../../../services/storePurchase/tenantContext.service")
const mrfAuthority = require("../../../../services/storePurchase/mrfAuthority.service")
const actionHistory = require("../../../../services/storePurchase/actionHistory.service")
const unitOfWork = require("../../../../services/storePurchase/unitOfWork.service")
const documentSequence = require("../../../../services/storePurchase/documentSequence.service")
const { fail, sendError } = require("../../../../services/storePurchase/errors")

const MRF_ENTITY = "MRF"

const buildFullName = mrfApprover.buildFullName

// Resolve biometricId string → Employee doc
async function resolveEmployee(biometricId) {
  return Employee.findOne({
    $or: [{ biometricId }, { identityId: biometricId }]
  })
    .select("_id firstName middleName lastName name email department biometricId identityId primaryManager isActive status")
    .lean()
}

const MAX_IMAGES_PER_ITEM = 5

// Product images arrive as already-uploaded results from the client —
// `publicId` from the old Cloudinary path, `fileId` from the Google Drive
// path the Cowork uploader (components/features/mrf/MrfPhotoUploader.tsx)
// uses now. Both are kept: `publicId` so an image attached before the switch
// still round-trips unchanged, `fileId` because it is what lets the frontend
// render a Drive image reliably (lh3 CDN, then the backend's own byte proxy)
// instead of the bare `url` alone, which 404s on the CDN until Google indexes
// a just-uploaded file and has no fallback when it does. Only the fields we
// render are kept — anything else the client sends is dropped rather than
// persisted blindly.
function cleanImages(images) {
  if (!Array.isArray(images)) return []
  return images
    .filter(im => im && typeof im.url === "string" && /^https?:\/\//i.test(im.url))
    .slice(0, MAX_IMAGES_PER_ITEM)
    .map(im => ({
      url: im.url.trim(),
      publicId: String(im.publicId || "").trim(),
      fileId: String(im.fileId || "").trim(),
      name: String(im.name || "").trim().slice(0, 120),
    }))
}

// Parent-attribute / values pairs, mirroring RawItem's own attribute shape —
// only meaningful for an item with no rawItemId (see below).
function cleanAttributes(attributes) {
  if (!Array.isArray(attributes)) return []
  return attributes
    .map(a => ({
      name: String(a?.name || "").trim(),
      values: Array.isArray(a?.values) ? a.values.map(v => String(v).trim()).filter(Boolean) : [],
    }))
    .filter(a => a.name && a.values.length)
}

async function buildMrfItems(items) {
  const built = []
  for (const it of items) {
    if (!it.requestedQty || parseFloat(it.requestedQty) <= 0) continue

    // Picked from the catalogue — the existing path.
    if (it.rawItemId) {
      const raw = await RawItem.findById(it.rawItemId).select("name sku unit customUnit").lean()
      if (!raw) continue
      const baseUnit = raw.customUnit || raw.unit || "unit"
      built.push({
        rawItem: raw._id,
        rawItemName: raw.name,
        rawItemSku: raw.sku || "",
        variantId: it.variantId || null,
        variantCombination: it.variantCombination || [],
        // Requester-supplied context — shown to the TL and the Store Person.
        description: String(it.description || "").trim().slice(0, 1000),
        specifications: String(it.specifications || "").trim().slice(0, 1000),
        images: cleanImages(it.images),
        requestedQty: parseFloat(it.requestedQty),
        // The unit the requester picked wins; baseUnit only as a fallback.
        unit: it.unit || baseUnit,
        baseUnit,
        itemStatus: "PENDING",
        availability: "UNREVIEWED",
      })
      continue
    }

    // Not in the catalogue — describe it instead. There's no catalogue unit
    // to fall back to, so the requester's own unit is mandatory here.
    const itemName = String(it.itemName || "").trim()
    const unit = String(it.unit || "").trim()
    if (!itemName || !unit) continue
    built.push({
      rawItem: null,
      rawItemName: itemName,
      rawItemSku: "",
      variantId: null,
      variantCombination: [],
      category: String(it.category || "").trim(),
      attributes: cleanAttributes(it.attributes),
      description: String(it.notes || it.description || "").trim().slice(0, 1000),
      specifications: String(it.specifications || "").trim().slice(0, 1000),
      images: cleanImages(it.images),
      requestedQty: parseFloat(it.requestedQty),
      unit,
      baseUnit: "",
      itemStatus: "PENDING",
      availability: "UNREVIEWED",
    })
  }
  return built
}

function markOverdue(mrfs) {
  const now = new Date()
  mrfs.forEach(mrf => {
    if (mrf.requestType === "TIME_BASED" && mrf.deadline && new Date(mrf.deadline) < now) {
      mrf.items.forEach(item => { if (item.itemStatus === "ISSUED") item.itemStatus = "OVERDUE" })
    }
  })
}

/** Attach the shared contextual message to each MRF for the given audience. */
function withContext(mrfs, audience) {
  const list = Array.isArray(mrfs) ? mrfs : [mrfs]
  list.forEach(m => { m.context = buildContext(m, audience) })
  return mrfs
}

/**
 * The one thing this door decides for itself: which TL a pre-routing MRF
 * belongs to.
 *
 * MRFs raised before approver routing existed have no approver stored at all.
 * Those are matched to a TL through the requester's live HR primaryManager
 * link — the same fallback GET /approvals uses to list them. Without it, such
 * a request appears in a TL's queue and then refuses every action they take.
 *
 * This resolves an IDENTITY. It does not decide authority: the resolved
 * approver is written onto the request and the canonical matrix is then asked,
 * exactly as it is for every other request.
 */
async function backfillApprover(mrf, user) {
  if (!mrf || mrf.approverBiometricId) return null
  const requester = await Employee.findById(mrf.requestedFor)
    .select("primaryManager").lean()
  const managerId = requester?.primaryManager?.managerId
  if (!managerId) return null
  const me = await resolveEmployee(user.id)
  return me && String(me._id) === String(managerId) ? me : null
}

/**
 * Authority on the Cowork door — the SAME matrix the store door uses.
 *
 * ── WHY THERE IS NO SECOND IMPLEMENTATION ANY MORE ──────────────────────────
 * This door used to answer the question itself, and the two answers had
 * already drifted: the local version returned `canApprove: true` for every
 * user whose session role was "ceo", so a chief executive could approve any
 * request in the company regardless of who the org chart routed it to, and it
 * checked "is this person the approver" before "is this person the requester",
 * so a record naming somebody as their own approver let them approve
 * themselves. Neither was true on the store door. One matrix, asked from both
 * doors, is the only way those cannot diverge again — a CEO now reads what
 * their capabilities allow and approves what is actually assigned to them.
 */
/**
 * Commit a governed change to a material request — save and immutable history
 * as one step, with an effect marker where the deployment cannot give a
 * transaction. Mirrors commitMrf on the store door; see the note there for why
 * saving and recording separately was unsafe.
 */
const commitMrf = (req, mrf, entry) =>
  unitOfWork.run(req.tenant, {
    idempotencyRecord: req.idempotent?.record,
    mutate: async (session) => {
      await mrf.save(session ? { session } : {})
      return {
        entityType: MRF_ENTITY,
        entityId: mrf._id,
        result: true,
        entry: {
          entityType: MRF_ENTITY,
          entityId: mrf._id,
          documentNumber: mrf.mrfNumber,
          requestId: req.id || "",
          idempotencyKey: req.idempotent?.key || "",
          ...entry,
        },
      }
    },
  })

/**
 * A retry whose effect already landed: repair the history if that is what
 * went missing, then answer as the first attempt would have.
 */
const recoverMrf = async (req, mrf, entry, payload, status = 200) => {
  await unitOfWork.recover(req.tenant, {
    entityType: MRF_ENTITY,
    entityId: mrf._id,
    idempotencyKey: req.idempotent.key,
    entry: {
      documentNumber: mrf.mrfNumber,
      requestId: req.id || "",
      idempotencyKey: req.idempotent.key,
      resultingState: mrf.status,
      metadata: { recovered: true },
      ...entry,
    },
  })
  return req.idempotent.succeed(status, payload, { entityType: MRF_ENTITY, entityId: mrf._id })
}

/**
 * The request is already in the state this call wanted.
 *
 * ── WHY THIS IS NOT JUST AN EARLY RETURN ────────────────────────────────────
 * It used to answer "Already approved" and stop. That is right about the
 * request and wrong about the record: if the decision committed and the
 * history write then failed, every retry took this path and cheerfully
 * reported success while nothing immutable said who decided. The state agreed;
 * the audit trail was missing, permanently and invisibly.
 *
 * So the shortcut repairs first. `unitOfWork.recover` writes the entry only if
 * it is genuinely absent, which makes calling it on every replay harmless.
 */
const alreadyInState = async (req, mrf, entry, message) => {
  const payload = { success: true, message, mrf, alreadyDone: true }
  return recoverMrf(req, mrf, entry, payload)
}

/**
 * Note a state change in the request's own thread.
 *
 * Awaited rather than fired and forgotten: the thread is how the requester
 * finds out why their request changed, and a promise nobody waits on loses
 * that silently. Keyed off the action's own idempotency key, so a retry
 * recovers the same note — which is what makes awaiting safe.
 */
const noteInThread = (req, mrf, text, who) => mrfChat.systemMessage(mrf, text, who, {
  ctx: req.tenant,
  idempotencyKey: req.idempotent?.key ? `${req.idempotent.key}:system` : null,
})

async function may(req, action, mrf) {
  return mrfAuthority.assertMay(action, {
    mrf,
    ctx: req.tenant,
    employee: req.tenant?.employee || (await resolveEmployee(req.user?.id)),
  })
}

/** Write a live-resolved approver onto the MRF so the fallback runs once. */
function applyBackfill(mrf, me) {
  if (!me) return
  const ids = mrfApprover.coworkIdsOf(me)
  mrf.approverEmployee = me._id
  mrf.approverBiometricId = ids[0] || ""
  mrf.approverAltIds = ids
  mrf.approverName = buildFullName(me)
  mrf.approverResolution = "RESOLVED"
  mrf.approvalRoute = "TL"
}

const chatSenderFor = (req, emp, roleOverride) => ({
  senderRef: emp?._id || null,
  senderBiometricId: req.user.id,
  senderName: buildFullName(emp) || req.user.name || "",
  senderRole: roleOverride
    || (req.user.role === "ceo" ? "ceo" : (req.user.role === "tl" ? "tl" : "employee")),
})

// ─────────────────────────────────────────────────────────────────────────────
// Reference data
// ─────────────────────────────────────────────────────────────────────────────
router.get("/data/categories", async (req, res) => {
  try {
    const categories = await RawItem.distinct("category")
    res.json({ success: true, categories: categories.filter(Boolean).sort() })
  } catch (err) { res.status(500).json({ success: false, message: err.message }) }
})

router.get("/data/units", async (req, res) => {
  try {
    const units = await Unit.distinct("name")
    res.json({ success: true, units: units.filter(Boolean).sort() })
  } catch (err) { res.status(500).json({ success: false, message: err.message }) }
})

router.get("/data/raw-items", async (req, res) => {
  try {
    const { search = "" } = req.query
    const filter = search
      ? { $or: [{ name: { $regex: search, $options: "i" } }, { sku: { $regex: search, $options: "i" } }] }
      : {}
    const items = await RawItem.find(filter)
      // A picker should show what the thing looks like — choosing between six
      // similarly-named items is guesswork from names alone. There is no
      // item-level picture in this model; the registered ones hang off the
      // variants, so `variants` (already selected) is where it comes from.
      .select("name sku unit customUnit quantity variants")
      .sort({ name: 1 }).limit(50).lean()
    const unitMap = await buildUnitConversions()
    const formatted = items.map(item => {
      const baseUnit = item.customUnit || item.unit || "unit"
      return {
        _id: item._id,
        name: item.name,
        sku: item.sku,
        /* The first variant that was actually photographed. An item nobody
           photographed has none, which is a real answer and not a gap. */
        image: (item.variants || []).map((v) => v.image).find(Boolean) || "",
        baseUnit,
        quantity: item.quantity || 0,
        conversions: unitMap[baseUnit] || [],
        variants: (item.variants || []).map(v => ({
          _id: v._id,
          combination: v.combination || [],
          image: v.image || "",
          quantity: v.quantity || 0,
          sku: v.sku || "",
          status: v.status || "Out of Stock",
        })),
      }
    })
    res.json({ success: true, rawItems: formatted })
  } catch (err) {
    /* A structured refusal (forbidden, wrong tenant, invalid transition)
       must reach the client as itself, not as a generic 500. */
    if (err?.name === "StorePurchaseError") return sendError(res, err)
    res.status(500).json({ success: false, message: err.message })
  }
})

/**
 * Who approves my requests? Shown in the new-request drawer so the requester
 * knows up front where it is going — and hears about a missing HR link before
 * they spend time filling the form.
 */
router.get("/my-approver", async (req, res) => {
  try {
    const emp = await resolveEmployee(req.user.id)
    if (!emp) return res.json({ success: true, approver: null, resolution: "NO_HR_RECORD" })
    const a = await mrfApprover.resolveApprover(emp)
    res.json({
      success: true,
      approver: a.approverBiometricId
        ? { name: a.approverName, biometricId: a.approverBiometricId }
        : null,
      resolution: a.approverResolution,
      willAutoForward: a.approvalRoute === "AUTO_STORE",
      message: a.approvalRoute === "AUTO_STORE"
        ? a.autoForwardReason
        : `Requests you raise go to ${a.approverName} for approval.`,
    })
  } catch (err) { res.status(500).json({ success: false, message: err.message }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// TL / PRIMARY MANAGER — approvals queue
// Registered before "/:id" so Express does not read "approvals" as an id.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /approvals — every MRF this user is the Primary Manager/TL for.
 *
 * Matched on approverBiometricId, which was resolved from the requester's HR
 * record at submission time. MRFs raised before approver routing existed have
 * no approverBiometricId, so they are also matched via the requester's
 * primaryManager link — otherwise they would be invisible to everyone.
 */
router.get("/approvals", async (req, res) => {
  try {
    const { status = "PENDING", page = 1, limit = 20, search = "" } = req.query

    const legacyIds = await mrfApprover.listManagedEmployeeIds(req.user.id)
    /* Tenancy first, relationship second: an approver may only ever decide a
       request inside their own company, even one the org chart routed to
       them. */
    const scope = {
      ...tenantContext.tenantFilter(req.tenant),
      $or: [
        // Either id the approver's HR record carries may be the one their
        // cowork session presents — match both, same as the authority matrix does.
        { approverBiometricId: req.user.id },
        { approverAltIds: req.user.id },
        ...(legacyIds.length
          ? [{
            $and: [
              { $or: [{ approverBiometricId: { $in: ["", null] } }, { approverBiometricId: { $exists: false } }] },
              { requestedFor: { $in: legacyIds } },
            ],
          }]
          : []),
      ],
    }

    const filter = { ...scope }
    if (status && status !== "ALL") filter.status = status
    if (search) {
      filter.$and = [{
        $or: [
          { mrfNumber: { $regex: search, $options: "i" } },
          { requestedForName: { $regex: search, $options: "i" } },
          { requestedForId: { $regex: search, $options: "i" } },
          { reason: { $regex: search, $options: "i" } },
        ],
      }]
    }

    const skip = (parseInt(page) - 1) * parseInt(limit)
    const total = await MRF.countDocuments(filter)
    const mrfs = await MRF.find(filter)
      .sort({ priority: -1, createdAt: -1 })
      .skip(skip).limit(parseInt(limit))
      .lean()

    markOverdue(mrfs)
    withContext(mrfs, "tl")

    const statsAgg = await MRF.aggregate([
      { $match: scope },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          pending: { $sum: { $cond: [{ $eq: ["$status", "PENDING"] }, 1, 0] } },
          approved: { $sum: { $cond: [{ $eq: ["$status", "APPROVED"] }, 1, 0] } },
          rejected: { $sum: { $cond: [{ $eq: ["$status", "REJECTED"] }, 1, 0] } },
          issued: { $sum: { $cond: [{ $in: ["$status", ["ISSUED", "PARTIALLY_ISSUED"]] }, 1, 0] } },
        },
      },
    ])
    const stats = statsAgg[0] || { total: 0, pending: 0, approved: 0, rejected: 0, issued: 0 }
    delete stats._id

    // A request with items not yet matched to the catalogue is still just an
    // MRF — those items carry itemStatus "UNMATCHED" once approved, and the
    // Store resolves them on this same document. Nothing else to fetch here.

    res.json({
      success: true,
      mrfs,
      stats,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) },
    })
  } catch (err) {
    /* A structured refusal (forbidden, wrong tenant, invalid transition)
       must reach the client as itself, not as a generic 500. */
    if (err?.name === "StorePurchaseError") return sendError(res, err)
    console.error("[CoworkMRF GET /approvals]", err)
    res.status(500).json({ success: false, message: err.message })
  }
})

/**
 * PATCH /:id/tl-approve — the only approval step in the flow.
 * On success the request moves straight to the Store.
 *
 * Deliberately does NOT block on stock. The store reports availability after
 * approval; a TL approving "yes, this person may have it" is a separate
 * question from "does the store have it today".
 */
router.patch(
  "/:id/tl-approve",
  refuseLegacyWrite,
  withIdempotency("MRF_TL_APPROVE"),
  async (req, res) => {
  try {
    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) })
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" })

    /* ── AN INTERRUPTED DECISION FINISHES; IT DOES NOT START AGAIN ──────────
     * The change committed on an earlier attempt and something after it did
     * not — usually the history write. Falling through to the transition
     * checks below would refuse this as "already {state}": true of the
     * request, useless to the caller, and it would leave the missing history
     * missing forever. So recovery comes first — repair the record, then
     * answer as the first attempt would have. */
    if (req.idempotent?.recovering) {
      return await recoverMrf(req, mrf, { action: "TL_APPROVED", previousState: "PENDING" }, {
        success: true, message: "Already approved", mrf, alreadyDone: true,
      })
    }

    /* Resolve a pre-routing approver onto the request FIRST, so the matrix
       judges the request as it will be stored, then ask the one matrix. */
    const backfill = await backfillApprover(mrf, req.user)
    if (backfill) applyBackfill(mrf, backfill)
    await may(req, "APPROVE", mrf)

    if (mrf.status === "CANCELLED")
      return res.status(400).json({ success: false, message: "This request was cancelled by the requester." })
    if (mrf.tlApproved)
      return await alreadyInState(req, mrf, {
        action: "TL_APPROVED", previousState: "PENDING",
      }, "Already approved")
    if (mrf.status !== "PENDING")
      return res.status(400).json({ success: false, message: `Cannot approve — this request is already ${mrf.status.toLowerCase().replace(/_/g, " ")}.` })

    const { itemDecisions, note = "" } = req.body

    // Per-item approve/reject. Everything not explicitly rejected is approved
    // — except a line the requester raised without a catalogue match, which
    // becomes UNMATCHED: TL-approved (they may have it), but the Store still
    // has to match it to an item or register it before it's issuable.
    const nextStatus = (item) => (item.rawItem ? "APPROVED" : "UNMATCHED")
    if (itemDecisions && typeof itemDecisions === "object") {
      mrf.items.forEach(item => {
        const d = itemDecisions[String(item._id)]
        item.itemStatus = d === "REJECTED" || d === "reject" ? "REJECTED" : nextStatus(item)
      })
      if (mrf.items.every(i => i.itemStatus === "REJECTED"))
        return res.status(400).json({
          success: false,
          message: "Every item was rejected — use Reject on the whole request instead.",
        })
    } else {
      mrf.items.forEach(item => { item.itemStatus = nextStatus(item) })
    }

    const actor = await resolveEmployee(req.user.id)
    const actorName = buildFullName(actor) || req.user.name || ""

    mrf.tlApproved = true
    mrf.tlApprovedBy = actor?._id || null
    mrf.tlApprovedByName = actorName
    mrf.tlApprovedAt = new Date()
    mrf.tlRejected = false
    mrf.tlRejectedBy = null; mrf.tlRejectedAt = null; mrf.tlRejectionNote = ""
    mrf.status = "APPROVED"
    mrf.approvedAt = new Date()
    if (note) mrf.storeNotes = note

    const rejectedCount = mrf.items.filter(i => i.itemStatus === "REJECTED").length
    mrf.logEvent({
      action: "TL_APPROVED",
      actorName, actorRole: "tl",
      detail: rejectedCount
        ? `Approved with ${rejectedCount} item(s) rejected.${note ? ` Note: ${note}` : ""}`
        : (note || "Approved and forwarded to the Store."),
    })

    /* The decision and the record of it land together. Written separately,
       a history failure left the request approved with nothing immutable
       saying who approved it — and the `alreadyDone` shortcut below then
       hid that gap from every retry. */
    await commitMrf(req, mrf, {
      action: "TL_APPROVED",
      previousState: "PENDING",
      resultingState: mrf.status,
      reason: note || "",
      metadata: { lineCount: (mrf.items || []).length },
    })

    await noteInThread(req, mrf, `${actorName || "The TL"} approved this request — it is now with the Store.`, actorName)
    mrfNotify.tlApproved(mrf).catch(e => console.error("[tlApprove notify]", e.message))

    const approvedPayload = { success: true, message: "Approved and sent to the Store", mrf, context: buildContext(mrf.toObject(), "tl") }
    return req.idempotent
      ? await req.idempotent.succeed(200, approvedPayload, { entityType: MRF_ENTITY, entityId: mrf._id })
      : res.json(approvedPayload)
  } catch (err) {
    /* A structured refusal (forbidden, wrong tenant, invalid transition)
       must reach the client as itself, not as a generic 500. */
    if (err?.name === "StorePurchaseError") return sendError(res, err)
    console.error("[CoworkMRF tl-approve]", err)
    res.status(500).json({ success: false, message: err.message })
  }
},
)

/** PATCH /:id/tl-reject — reason is mandatory, the requester is told why. */
router.patch(
  "/:id/tl-reject",
  refuseLegacyWrite,
  withIdempotency("MRF_TL_REJECT"),
  async (req, res) => {
  try {
    const note = String(req.body.note || req.body.rejectionNote || "").trim()
    if (!note)
      return res.status(400).json({ success: false, message: "A rejection reason is required — the requester sees it." })

    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) })
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" })

    /* ── AN INTERRUPTED DECISION FINISHES; IT DOES NOT START AGAIN ──────────
     * The change committed on an earlier attempt and something after it did
     * not — usually the history write. Falling through to the transition
     * checks below would refuse this as "already {state}": true of the
     * request, useless to the caller, and it would leave the missing history
     * missing forever. So recovery comes first — repair the record, then
     * answer as the first attempt would have. */
    if (req.idempotent?.recovering) {
      return await recoverMrf(req, mrf, { action: "TL_REJECTED", previousState: "PENDING" }, {
        success: true, message: "Already rejected", mrf, alreadyDone: true,
      })
    }

    /* Resolve a pre-routing approver onto the request FIRST, so the matrix
       judges the request as it will be stored, then ask the one matrix. */
    const backfill = await backfillApprover(mrf, req.user)
    if (backfill) applyBackfill(mrf, backfill)
    await may(req, "REJECT", mrf)

    if (["ISSUED", "PARTIALLY_ISSUED", "PARTIALLY_RETURNED", "COMPLETED"].includes(mrf.status))
      return res.status(400).json({ success: false, message: "Cannot reject — the Store has already issued material against this request." })
    if (mrf.status === "CANCELLED")
      return res.status(400).json({ success: false, message: "This request was already cancelled." })
    if (mrf.tlRejected)
      return await alreadyInState(req, mrf, {
        action: "TL_REJECTED", previousState: "PENDING",
      }, "Already rejected")

    const actor = await resolveEmployee(req.user.id)
    const actorName = buildFullName(actor) || req.user.name || ""

    mrf.tlRejected = true
    mrf.tlRejectedBy = actor?._id || null
    mrf.tlRejectedByName = actorName
    mrf.tlRejectedAt = new Date()
    mrf.tlRejectionNote = note
    mrf.tlApproved = false
    mrf.status = "REJECTED"
    mrf.rejectedAt = new Date()
    mrf.rejectionNote = note
    mrf.items.forEach(i => { if (i.itemStatus !== "ISSUED") i.itemStatus = "REJECTED" })

    mrf.logEvent({ action: "TL_REJECTED", actorName, actorRole: "tl", detail: note })
    /* The change and the record of it land together — written separately,
       a history failure left the request changed with nothing immutable
       saying who changed it, and the `alreadyDone` shortcut then hid the
       gap from every retry. */
    await commitMrf(req, mrf, {
      action: "TL_REJECTED",
      previousState: "PENDING",
      resultingState: mrf.status,
      reason: req.body?.note || req.body?.reason || "",
      metadata: { lineCount: (mrf.items || []).length },
    })

    await noteInThread(req, mrf, `${actorName || "The TL"} rejected this request. Reason: ${note}`, actorName)
    mrfNotify.tlRejected(mrf).catch(e => console.error("[tlReject notify]", e.message))

    const rejectedPayload = { success: true, message: "Request rejected", mrf, context: buildContext(mrf.toObject(), "tl") }
    return req.idempotent
      ? await req.idempotent.succeed(200, rejectedPayload, { entityType: MRF_ENTITY, entityId: mrf._id })
      : res.json(rejectedPayload)
  } catch (err) {
    /* A structured refusal (forbidden, wrong tenant, invalid transition)
       must reach the client as itself, not as a generic 500. */
    if (err?.name === "StorePurchaseError") return sendError(res, err)
    console.error("[CoworkMRF tl-reject]", err)
    res.status(500).json({ success: false, message: err.message })
  }
},
)

// ═════════════════════════════════════════════════════════════════════════════
// REQUESTER — own requests
// ═════════════════════════════════════════════════════════════════════════════

router.get("/", async (req, res) => {
  try {
    const { status, requestType, priority, page = 1, limit = 20 } = req.query

    const emp = await resolveEmployee(req.user.id)
    if (!emp) return res.json({
      success: true, mrfs: [],
      stats: { total: 0, pending: 0, approved: 0, issued: 0 },
      pagination: { total: 0, page: 1, totalPages: 1 },
    })

    const filter = { requestedFor: emp._id, ...tenantContext.tenantFilter(req.tenant) }
    if (status) filter.status = status
    if (requestType) filter.requestType = requestType
    if (priority) filter.priority = priority

    const skip = (parseInt(page) - 1) * parseInt(limit)
    const total = await MRF.countDocuments(filter)
    const mrfs = await MRF.find(filter)
      .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit))
      .lean()

    markOverdue(mrfs)
    withContext(mrfs, "requester")

    const statsAgg = await MRF.aggregate([
      { $match: { requestedFor: emp._id, ...tenantContext.tenantFilter(req.tenant) } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          pending: { $sum: { $cond: [{ $eq: ["$status", "PENDING"] }, 1, 0] } },
          approved: { $sum: { $cond: [{ $eq: ["$status", "APPROVED"] }, 1, 0] } },
          issued: { $sum: { $cond: [{ $in: ["$status", ["ISSUED", "PARTIALLY_ISSUED"]] }, 1, 0] } },
        }
      },
    ])
    const stats = statsAgg[0] || { total: 0, pending: 0, approved: 0, issued: 0 }
    delete stats._id

    res.json({ success: true, mrfs, stats, pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) } })
  } catch (err) {
    /* A structured refusal (forbidden, wrong tenant, invalid transition)
       must reach the client as itself, not as a generic 500. */
    if (err?.name === "StorePurchaseError") return sendError(res, err)
    console.error("[CoworkMRF GET /]", err)
    res.status(500).json({ success: false, message: err.message })
  }
})

/**
 * POST / — employee raises a material request.
 *
 * Resolves the Primary Manager/TL from the HR record and routes there. If no
 * TL can be resolved the request is auto-forwarded to the Store rather than
 * blocked, flagged so every screen can explain why nobody approved it.
 *
 * Items may be picked from the catalogue (`rawItemId`) or, for something not
 * in the catalogue yet, just described (`itemName` + `unit`, no `rawItemId`)
 * — see buildMrfItems above. Either way this produces exactly ONE MRF with
 * one mrfNumber; an unmatched item is resolved on this same document later,
 * never a separate one. Named (not inline) so /product-requests below can
 * forward into it.
 */
async function createMrfRequest(req, res) {
  try {
    const { requestType, deadline, neededBy, reason = "", priority = "NORMAL", items } = req.body

    if (!["TIME_BASED", "USES_BASED"].includes(requestType))
      return res.status(400).json({ success: false, message: "Invalid requestType" })
    if (requestType === "TIME_BASED" && !deadline)
      return res.status(400).json({ success: false, message: "Deadline required for TIME_BASED" })
    if (!items?.length)
      return res.status(400).json({ success: false, message: "At least one item required" })

    const builtItems = await buildMrfItems(items)
    if (!builtItems.length)
      return res.status(400).json({ success: false, message: "No valid items found" })

    const emp = await resolveEmployee(req.user.id)
    if (!emp) return res.status(404).json({ success: false, message: "Your HR record not found. Contact HR." })

    // ── Accidental double-submit guard ──────────────────────────────────
    // Same person, same items, same quantities, still open, within 2 minutes →
    // return the request they already have instead of minting a second one.
    // `rawItemName` is included so two different not-yet-catalogued items
    // with the same quantity/unit don't collide on `rawItem: null`.
    const signature = builtItems
      .map(i => `${i.rawItem}:${i.rawItemName}:${i.variantId || ""}:${i.requestedQty}:${i.unit}`)
      .sort().join("|")
    /* ── AN INTERRUPTED CREATION IS FINISHED, NOT REPEATED ─────────────────
     * The request was saved on an earlier attempt and something after it
     * failed. Without this the retry would build and save a SECOND request,
     * with a second number, for one person asking once. The effect marker
     * recorded which request was made; recovery repairs its history and
     * hands it back. */
    if (req.idempotent?.recovering) {
      const existing = await MRF.findOne({
        _id: req.idempotent.recovering.entityId,
        ...tenantContext.tenantFilter(req.tenant),
      })
      if (existing) {
        return await recoverMrf(req, existing, {
          action: "CREATED", previousState: null,
        }, {
          success: true,
          message: `${existing.mrfNumber} was already submitted.`,
          mrf: existing,
          alreadyDone: true,
        }, 201)
      }
    }

    /* Scoped like every other read. A person can hold membership in more than
       one company, and an unscoped scan would call their request in company A
       a duplicate of the one they just raised in company B — and then answer
       with the other company's number. */
    const recent = await MRF.find({
      ...tenantContext.tenantFilter(req.tenant),
      requestedFor: emp._id,
      status: { $in: ["PENDING", "APPROVED"] },
      createdAt: { $gte: new Date(Date.now() - 2 * 60 * 1000) },
    }).lean()
    const dupe = recent.find(m =>
      (m.items || []).map(i => `${i.rawItem}:${i.rawItemName}:${i.variantId || ""}:${i.requestedQty}:${i.unit}`)
        .sort().join("|") === signature
    )
    if (dupe) {
      /* A double-tap without a matching key — kinder than an error, and it is
         still a real request, so its history must exist before we say so.
         `recover` writes only if the entry is genuinely absent. */
      await unitOfWork.recover(req.tenant, {
        entityType: MRF_ENTITY,
        entityId: dupe._id,
        idempotencyKey: "",
        entry: {
          documentNumber: dupe.mrfNumber,
          action: "CREATED",
          previousState: null,
          resultingState: dupe.status,
          requestId: req.id || "",
          idempotencyKey: "",
          metadata: { recovered: true, reason: "NEAR_DUPLICATE_SUBMIT" },
        },
      })
      return res.status(200).json({
        success: true,
        duplicate: true,
        message: `You already raised this exact request a moment ago (${dupe.mrfNumber}). We have not created a second one.`,
        mrf: dupe,
      })
    }

    const fullName = buildFullName(emp)
    const biometricId = emp.biometricId || emp.identityId || req.user.id
    const approver = await mrfApprover.resolveApprover(emp)
    const autoForward = approver.approvalRoute === "AUTO_STORE"

    /* Server-owned and atomic: one $inc, so two requests submitted in
       the same moment cannot receive the same number. */
    const allocated = await documentSequence.allocate({
      companyId: req.tenant.companyId,
      documentType: "MATERIAL_REQUEST",
      siteId: req.tenant.siteId || null,
    })
    const mrf = new MRF({
      mrfNumber: allocated.number,
      /* Tenancy from resolved context ONLY — never from the payload. */
    ...tenantContext.stamp(req.tenant),
      requestedFor: emp._id,
      requestedForName: fullName || req.user.name || "",
      requestedForDept: emp.department || "",
      requestedForId: biometricId,
      // The id this session actually authenticates as — notifications must be
      // addressed to it, and it is not always the HR biometricId.
      requesterCoworkId: req.user.id,
      creationMode: "SELF",
      createdByRef: emp._id,
      createdByModel: "Employee",
      createdByName: fullName || req.user.name || "",
      requestType,
      deadline: requestType === "TIME_BASED" ? new Date(deadline) : null,
      // When the requester needs it in hand — shown to them, the TL and the Store.
      neededBy: neededBy ? new Date(neededBy) : null,
      reason, priority,
      ...approver,
      // No TL to approve → it goes straight to the Store, already approved
      // (or UNMATCHED, for a line with no catalogue item yet).
      status: autoForward ? "APPROVED" : "PENDING",
      items: autoForward
        ? builtItems.map(i => ({ ...i, itemStatus: i.rawItem ? "APPROVED" : "UNMATCHED" }))
        : builtItems,
      ...(autoForward ? { approvedAt: new Date() } : {}),
    })

    mrf.logEvent({
      action: "CREATED",
      actorName: fullName || req.user.name || "",
      actorRole: "employee",
      detail: autoForward
        ? approver.autoForwardReason
        : `Submitted for approval by ${approver.approverName}.`,
    })
    if (autoForward) {
      mrf.logEvent({
        action: "AUTO_FORWARDED",
        actorName: "System", actorRole: "system",
        detail: approver.autoForwardReason,
      })
    }

    await commitMrf(req, mrf, {
      action: "CREATED",
      previousState: null,
      resultingState: mrf.status,
      metadata: { itemCount: (mrf.items || []).length, autoForwarded: Boolean(autoForward) },
    })

    // Only once the creation is authoritative.
    if (autoForward) {
      mrfNotify.autoForwarded(mrf).catch(e => console.error("[mrf autoForward notify]", e.message))
    } else {
      mrfNotify.submitted(mrf).catch(e => console.error("[mrf submitted notify]", e.message))
    }

    const obj = mrf.toObject()
    const createdPayload = {
      success: true,
      message: autoForward
        ? approver.autoForwardReason
        : `${mrf.mrfNumber} submitted — waiting for approval from ${approver.approverName}.`,
      mrf: obj,
      context: buildContext(obj, "requester"),
    }
    return req.idempotent
      ? await req.idempotent.succeed(201, createdPayload, { entityType: MRF_ENTITY, entityId: mrf._id })
      : res.status(201).json(createdPayload)
  } catch (err) {
    /* A structured refusal (forbidden, wrong tenant, invalid transition)
       must reach the client as itself, not as a generic 500. */
    if (err?.name === "StorePurchaseError") return sendError(res, err)
    console.error("[CoworkMRF POST /]", err)
    res.status(500).json({ success: false, message: err.message })
  }
}
router.post("/", refuseLegacyWrite, withIdempotency("MRF_REQUESTER_CREATE"), createMrfRequest)

// ─────────────────────────────────────────────────────────────────────────────
// GET /product-requests — employee's own raw-item add requests
// Registered before "/:id".
//
// READ-ONLY LEGACY: kept only so pre-cutover RawItemAddRequest documents
// remain visible/resolvable. Nothing is written here any more — new "not in
// the catalogue" items are just MRF items with itemStatus UNMATCHED, created
// via POST / like everything else. See createMrfRequest above.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/product-requests", requireLegacyRead, async (req, res) => {
  try {
    const emp = await resolveEmployee(req.user.id)
    if (!emp) return res.json({ success: true, requests: [] })
    const requests = await RawItemAddRequest.find({ requestedBy: emp._id, ...tenantContext.tenantFilter(req.tenant) })
      .sort({ createdAt: -1 })
      .populate("matchedTo", "name sku")
      .populate("products.matchedTo", "name sku")
      .populate("products.spawnedMrf", "mrfNumber status")
      .lean()
    res.json({ success: true, requests })
  } catch (err) {
    /* A structured refusal (forbidden, wrong tenant, invalid transition)
       must reach the client as itself, not as a generic 500. */
    if (err?.name === "StorePurchaseError") return sendError(res, err)
    res.status(500).json({ success: false, message: err.message })
  }
})

/**
 * POST /product-requests — BACKWARD-COMPAT SHIM ONLY.
 *
 * Product requests are no longer their own thing — "not in the catalogue"
 * items are just MRF items with itemStatus UNMATCHED (see createMrfRequest /
 * buildMrfItems above), so this single request gets one real mrfNumber
 * instead of the old separate, number-less RawItemAddRequest.
 *
 * This route exists only so a not-yet-redeployed Coworking client (still
 * calling the old endpoint/payload shape) doesn't 404 during the rollout
 * window — it translates the old `products[]` shape into `items[]` and
 * forwards into createMrfRequest. Delete this route once Coworking has
 * redeployed against POST / directly.
 */
router.post(
  "/product-requests",
  /* It creates a real, company-owned MRF, so it is governed exactly like the
     endpoint it forwards into — same legacy refusal, same required key, same
     stamping, numbering, history and recovery. A compatibility shim that
     skipped those would be a second, ungoverned way to create a request. */
  refuseLegacyWrite,
  withIdempotency("MRF_REQUESTER_CREATE"),
  async (req, res) => {
  const { products, priority, reason, neededBy } = req.body
  if (!Array.isArray(products) || !products.length)
    return res.status(400).json({ success: false, message: "At least one product is required" })

  req.body = {
    requestType: "USES_BASED",
    deadline: null,
    neededBy,
    reason,
    priority,
    items: products
      .filter(p => p.itemName?.trim())
      .map(p => ({
        itemName: p.itemName,
        category: p.category,
        unit: p.unit,
        requestedQty: p.requestedQty,
        notes: p.notes,
        attributes: p.attributes,
        images: p.images,
      })),
  }
  return createMrfRequest(req, res)
},
)

// ═════════════════════════════════════════════════════════════════════════════
// Product requests — LEGACY, READ-ONLY
//
// `RawItemAddRequest` has no company field, so every record that exists
// predates the tenant boundary and nothing creates another (the shim above
// makes a real MRF instead). The adopted legacy policy applies in full:
// excluded from ordinary reads, reachable only with `sp.legacy.read` AND an
// explicit `?scope=legacy`, and never writable — no TL decision, no chat post,
// not even a mark-read, because marking read is still a write to a record
// nobody owns. Adopting one into whichever company asked first would be a
// silent, unauditable transfer of somebody else's data.
//
// The approve/reject/chat implementations that used to live here are gone
// rather than commented out; git history is the record.
// ═════════════════════════════════════════════════════════════════════════════

/** Legacy records answer only in explicit legacy mode. */
function requireLegacyRead(req, res, next) {
  if (!req.tenant?.legacyMode) {
    return sendError(res, fail(
      "LEGACY_ACCESS_REQUIRED",
      "Product requests are legacy records. Ask for them explicitly with ?scope=legacy.",
      { scope: "legacy", readOnly: true },
    ))
  }
  next()
}

const refuseLegacyProductRequestWrite = (replacedBy) => (req, res) =>
  sendError(res, fail(
    "LEGACY_ACCESS_REQUIRED",
    "Product requests are read-only. Raise a material request instead.",
    { readOnly: true, ...(replacedBy ? { replacedBy } : {}) },
  ))

router.patch("/product-requests/:id/tl-approve", refuseLegacyProductRequestWrite("PATCH /api/cowork/mrf/:id/tl-approve"))
router.patch("/product-requests/:id/tl-reject", refuseLegacyProductRequestWrite("PATCH /api/cowork/mrf/:id/tl-reject"))
router.post("/product-requests/:id/chat", refuseLegacyProductRequestWrite("POST /api/cowork/mrf/:id/chat"))
router.patch("/product-requests/:id/chat/read", refuseLegacyProductRequestWrite())

/** The thread is history. Readable under explicit legacy scope; not marked read. */
router.get("/product-requests/:id/chat", requireLegacyRead, async (req, res) => {
  try {
    const doc = await RawItemAddRequest.findOne({
      _id: req.params.id, ...tenantContext.tenantFilter(req.tenant),
    }).select("products status companyId").lean()
    if (!doc) return res.status(404).json({ success: false, message: "Product request not found" })

    const messages = await mrfChat.listMessages(doc, {
      ctx: req.tenant, subjectType: "PRODUCT_REQUEST",
      limit: req.query.limit, before: req.query.before,
    })
    res.json({
      success: true,
      messages,
      mrfNumber: mrfChat.describeSubject(doc, "PRODUCT_REQUEST").label,
      status: doc.status,
      isFinal: true,
    })
  } catch (err) {
    if (err?.name === "StorePurchaseError") return sendError(res, err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Single MRF — detail, cancel, chat
// ─────────────────────────────────────────────────────────────────────────────

/** GET /:id — full detail with live stock, for requester / TL / CEO. */
router.get("/:id", async (req, res) => {
  try {
    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) })
      .populate("requestedFor", "firstName middleName lastName name department designation email biometricId identityId")
      .lean()
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" })
    /* Unviewable answers as missing, the same way it does on the store door —
       a 403 here confirmed that a request with that id exists. */
    const via = await may(req, "VIEW", mrf)

    markOverdue([mrf])
    const audience = via?.via === "requester" ? "requester" : "tl"
    const itemsWithStock = await enrichItemsWithStock(mrf.items || [])

    res.json({
      success: true,
      mrf,
      itemsWithStock,
      context: buildContext(mrf, audience),
      audience,
      canApprove: access.canApprove && mrf.status === "PENDING",
    })
  } catch (err) { res.status(500).json({ success: false, message: err.message }) }
})

/**
 * PATCH /:id/cancel — the requester withdraws.
 * Allowed while PENDING, and while APPROVED as long as nothing has been
 * issued yet; once material has moved, cancelling would desync stock.
 */
router.patch(
  "/:id/cancel",
  refuseLegacyWrite,
  withIdempotency("MRF_REQUESTER_CANCEL"),
  async (req, res) => {
  try {
    const emp = await resolveEmployee(req.user.id)
    const mrf = await MRF.findOne({ _id: req.params.id, requestedFor: emp?._id, ...tenantContext.tenantFilter(req.tenant) })
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" })

    /* Captured before the cancellation mutates it — reading `mrf.status`
       after the save would record the new state as the old one. */
    const stateBeforeCancel = mrf.status

    /* An interrupted cancellation finishes rather than being refused as
       "already cancelled", which would strand the missing history. */
    if (req.idempotent?.recovering) {
      return await recoverMrf(req, mrf, {
        action: "CANCELLED",
        previousState: stateBeforeCancel,
        /* A cancellation must record why, on the recovery path as much as the
           first one — an entry written without it is refused by the schema,
           which is the schema doing its job. */
        reason: req.body?.cancellationNote || req.body?.reason
          || mrf.cancellationNote || "Withdrawn by the requester",
      }, {
        success: true, message: "Request cancelled", mrf, alreadyDone: true,
      })
    }

    if (["CANCELLED", "REJECTED"].includes(mrf.status))
      return res.status(400).json({ success: false, message: `This request is already ${mrf.status.toLowerCase()}.` })

    const anyIssued = mrf.items.some(i => (i.issuedQty || 0) > 0)
    if (anyIssued)
      return res.status(400).json({
        success: false,
        message: "Material has already been issued against this request — it cannot be cancelled. Return the issued material to the Store instead.",
      })
    if (!["PENDING", "APPROVED"].includes(mrf.status))
      return res.status(400).json({ success: false, message: `Cannot cancel — this request is ${mrf.status.toLowerCase().replace(/_/g, " ")}.` })

    const wasApproved = mrf.status === "APPROVED"
    const actorName = buildFullName(emp) || req.user.name || ""

    mrf.status = "CANCELLED"
    mrf.cancelledBy = emp._id
    mrf.cancelledByModel = "Employee"
    mrf.cancelledAt = new Date()
    mrf.cancellationNote = req.body.cancellationNote || "Cancelled by employee"
    mrf.items.forEach(i => { if (i.itemStatus !== "ISSUED") i.itemStatus = "REJECTED" })
    mrf.logEvent({
      action: "CANCELLED", actorName, actorRole: "employee",
      detail: mrf.cancellationNote + (wasApproved ? " (was already with the Store)" : ""),
    })
    /* The change and the record of it land together — written separately,
       a history failure left the request changed with nothing immutable
       saying who changed it, and the `alreadyDone` shortcut then hid the
       gap from every retry. */
    await commitMrf(req, mrf, {
      action: "CANCELLED",
      previousState: stateBeforeCancel,
      resultingState: mrf.status,
      reason: req.body?.reason || req.body?.note || "Withdrawn by the requester",
      metadata: { lineCount: (mrf.items || []).length },
    })

    await noteInThread(req, mrf, `${actorName || "The requester"} cancelled this request. ${mrf.cancellationNote}`, actorName)
    mrfNotify.cancelled(mrf).catch(e => console.error("[mrf cancel notify]", e.message))

    const cancelledPayload = { success: true, message: "Request cancelled", mrf, context: buildContext(mrf.toObject(), "requester") }
    return req.idempotent
      ? await req.idempotent.succeed(200, cancelledPayload, { entityType: MRF_ENTITY, entityId: mrf._id })
      : res.json(cancelledPayload)
  } catch (err) {
    /* A structured refusal (forbidden, wrong tenant, invalid transition)
       must reach the client as itself, not as a generic 500. */
    if (err?.name === "StorePurchaseError") return sendError(res, err)
    res.status(500).json({ success: false, message: err.message })
  }
},
)

/** GET /:id/chat — the MRF's own thread. */
router.get("/:id/chat", async (req, res) => {
  try {
    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) }).lean()
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" })
    await may(req, "VIEW", mrf)

    const messages = await mrfChat.listMessages(mrf, {
      ctx: req.tenant, limit: req.query.limit, before: req.query.before,
    })
    await mrfChat.markRead(mrf, { ctx: req.tenant, readerId: req.user.id })

    res.json({
      success: true,
      messages,
      mrfNumber: mrf.mrfNumber,
      // The thread stays open on a closed request — a store person may still
      // need to explain something — but the UI flags it.
      isFinal: ["COMPLETED", "REJECTED", "CANCELLED", "UNFULFILLED"].includes(mrf.status),
      status: mrf.status,
    })
  } catch (err) { res.status(500).json({ success: false, message: err.message }) }
})

/** POST /:id/chat — requester or TL posts a message. */
router.post(
  "/:id/chat",
  refuseLegacyWrite,
  withIdempotency("MRF_REQUESTER_CHAT"),
  async (req, res) => {
  try {
    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) })
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" })
    const backfill = await backfillApprover(mrf, req.user)
    if (backfill) { applyBackfill(mrf, backfill); await mrf.save() }
    const via = await may(req, "CHAT", mrf)

    const emp = await resolveEmployee(req.user.id)
    /* Creation of the message IS the effect marker — the unique index over
       (company, subject, key) means a retry recovers this message instead of
       posting a second one. See services/mrfChat.service.js. */
    const { message, created } = await mrfChat.postMessage(mrf, {
      ctx: req.tenant,
      idempotencyKey: req.idempotent?.key || null,
      body: req.body.body,
      attachments: cleanImages(req.body.attachments).map(a => ({ ...a, type: "image" })),
      // Label by role ON THIS REQUEST, not the account's global role — a TL
      // raising their own MRF is the requester in that thread.
      ...chatSenderFor(req, emp, via?.via === "requester" ? "employee" : undefined),
    })

    /* Recorded whether or not this call created the message. A retry that
       recovered an existing message is exactly the case where the first
       attempt's history write may be what failed — skipping it here would
       make the gap permanent. `recover` writes only if the entry is absent. */
    await unitOfWork.recover(req.tenant, {
      entityType: MRF_ENTITY,
      entityId: mrf._id,
      idempotencyKey: req.idempotent?.key || "",
      entry: {
        documentNumber: mrf.mrfNumber,
        action: "CHAT_MESSAGE",
        previousState: mrf.status,
        resultingState: mrf.status,
        requestId: req.id || "",
        idempotencyKey: req.idempotent?.key || "",
        metadata: { messageId: String(message._id) },
      },
    })

    if (created) {

      // `mrfNotify.chatMessage` was written for exactly this and wired to
      // nothing, so an MRF conversation notified nobody. Only for a message
      // this call created — a replay must not notify twice.
      mrfNotify.chatMessage(mrf, message).catch(e => console.error("[mrf chat notify]", e.message))
    }

    const payload = { success: true, message }
    return req.idempotent
      ? await req.idempotent.succeed(201, payload, { entityType: MRF_ENTITY, entityId: mrf._id })
      : res.status(201).json(payload)
  } catch (err) {
    if (err?.name === "StorePurchaseError") return sendError(res, err)
    res.status(err.status || 500).json({ success: false, message: err.message })
  }
})

/**
 * PATCH /:id/chat/read — clear this user's unread badge.
 *
 * Marking read writes to somebody else's conversation, so it needs the same
 * parent load, tenant scope and authority as reading it. It previously passed
 * `req.params.id` straight to the chat service, which meant a guessed id from
 * another company marked that company's messages read.
 */
router.patch("/:id/chat/read", async (req, res) => {
  try {
    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) })
      .select("companyId siteId status requestedFor requestedForId requesterCoworkId approverEmployee approverBiometricId approverAltIds")
      .lean()
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" })
    await may(req, "VIEW", mrf)

    const r = await mrfChat.markRead(mrf, { ctx: req.tenant, readerId: req.user.id })
    res.json({ success: true, ...r })
  } catch (err) {
    if (err?.name === "StorePurchaseError") return sendError(res, err)
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router

/* ── THE TWO DOORS, APPLIED AT THE MOUNT ─────────────────────────────────────
 * Neither chain may live on the router itself: `router.use` runs for every
 * mount of that router, so a Firebase check installed here would run on the
 * CMS door too — which is exactly what happened, and it refused a perfectly
 * good CMS session for having no "kid" claim.
 *
 * So the router carries handlers only, and server.js puts the right chain in
 * front of each mount. */
/**
 * Tenant context for this door.
 *
 * Both chains end at a biometricId on `req.user.id` and nothing else — no
 * ObjectId, no email — so the company cannot be resolved from the token. The
 * HR employee record is the authority, looked up the same way every other
 * handler here looks it up, and the context is built from that.
 */
const mrfTenant = requireTenantForEmployee(async (req) => resolveEmployee(req.user?.id))

module.exports.firebaseChain = [verifyCoworkToken, verifyEmployeeToken, attach, mrfTenant]
module.exports.cmsChain = [
  require("../../../../Middlewear/EmployeeAuthMiddlewear"), cmsAttach, mrfTenant,
]
