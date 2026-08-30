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
 * Who may see and act on this MRF.
 *
 * The stored approverBiometricId is the fast path, but MRFs raised before
 * approver routing existed have no approver stored at all — those are matched
 * to a TL through the requester's live HR primaryManager link (the same
 * fallback GET /approvals uses to list them). Without this, such a request
 * shows up in a TL's queue and then refuses every action they take on it.
 *
 * Returns { canView, canApprove, backfill } — `backfill` means the approver
 * was resolved live and should be written onto the MRF the next time it is
 * saved, so the fallback only ever runs once per request.
 */
async function resolveAccess(mrf, user) {
  if (!mrf) return { canView: false, canApprove: false }

  const isRequester =
    (!!mrf.requestedForId && mrf.requestedForId === user.id) ||
    (!!mrf.requesterCoworkId && mrf.requesterCoworkId === user.id)
  const isApprover =
    (!!mrf.approverBiometricId && mrf.approverBiometricId === user.id) ||
    (mrf.approverAltIds || []).includes(user.id)

  if (isApprover) return { canView: true, canApprove: true }
  if (user.role === "ceo") return { canView: true, canApprove: true }
  if (isRequester) return { canView: true, canApprove: false, isRequester: true }

  // ── Legacy: no approver was ever stored on this MRF ──────────────────
  if (!mrf.approverBiometricId) {
    const requester = await Employee.findById(mrf.requestedFor)
      .select("primaryManager").lean()
    const managerId = requester?.primaryManager?.managerId
    if (managerId) {
      const me = await resolveEmployee(user.id)
      if (me && String(me._id) === String(managerId)) {
        return { canView: true, canApprove: true, backfill: me }
      }
    }
  }

  return { canView: false, canApprove: false }
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
    const scope = {
      $or: [
        // Either id the approver's HR record carries may be the one their
        // cowork session presents — match both, same as resolveAccess does.
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
router.patch("/:id/tl-approve", async (req, res) => {
  try {
    const mrf = await MRF.findById(req.params.id)
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" })

    const access = await resolveAccess(mrf.toObject(), req.user)
    if (!access.canApprove)
      return res.status(403).json({ success: false, message: "You are not the approver for this request." })
    if (access.backfill) applyBackfill(mrf, access.backfill)

    if (mrf.status === "CANCELLED")
      return res.status(400).json({ success: false, message: "This request was cancelled by the requester." })
    if (mrf.tlApproved)
      return res.json({ success: true, message: "Already approved", mrf, alreadyDone: true })
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

    await mrf.save()

    mrfChat.systemMessage(mrf, `${actorName || "The TL"} approved this request — it is now with the Store.`, actorName)
    mrfNotify.tlApproved(mrf).catch(e => console.error("[tlApprove notify]", e.message))

    res.json({ success: true, message: "Approved and sent to the Store", mrf, context: buildContext(mrf.toObject(), "tl") })
  } catch (err) {
    console.error("[CoworkMRF tl-approve]", err)
    res.status(500).json({ success: false, message: err.message })
  }
})

/** PATCH /:id/tl-reject — reason is mandatory, the requester is told why. */
router.patch("/:id/tl-reject", async (req, res) => {
  try {
    const note = String(req.body.note || req.body.rejectionNote || "").trim()
    if (!note)
      return res.status(400).json({ success: false, message: "A rejection reason is required — the requester sees it." })

    const mrf = await MRF.findById(req.params.id)
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" })

    const access = await resolveAccess(mrf.toObject(), req.user)
    if (!access.canApprove)
      return res.status(403).json({ success: false, message: "You are not the approver for this request." })
    if (access.backfill) applyBackfill(mrf, access.backfill)

    if (["ISSUED", "PARTIALLY_ISSUED", "PARTIALLY_RETURNED", "COMPLETED"].includes(mrf.status))
      return res.status(400).json({ success: false, message: "Cannot reject — the Store has already issued material against this request." })
    if (mrf.status === "CANCELLED")
      return res.status(400).json({ success: false, message: "This request was already cancelled." })
    if (mrf.tlRejected)
      return res.json({ success: true, message: "Already rejected", mrf, alreadyDone: true })

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
    await mrf.save()

    mrfChat.systemMessage(mrf, `${actorName || "The TL"} rejected this request. Reason: ${note}`, actorName)
    mrfNotify.tlRejected(mrf).catch(e => console.error("[tlReject notify]", e.message))

    res.json({ success: true, message: "Request rejected", mrf, context: buildContext(mrf.toObject(), "tl") })
  } catch (err) {
    console.error("[CoworkMRF tl-reject]", err)
    res.status(500).json({ success: false, message: err.message })
  }
})

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

    const filter = { requestedFor: emp._id }
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
      { $match: { requestedFor: emp._id } },
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
    const recent = await MRF.find({
      requestedFor: emp._id,
      status: { $in: ["PENDING", "APPROVED"] },
      createdAt: { $gte: new Date(Date.now() - 2 * 60 * 1000) },
    }).lean()
    const dupe = recent.find(m =>
      (m.items || []).map(i => `${i.rawItem}:${i.rawItemName}:${i.variantId || ""}:${i.requestedQty}:${i.unit}`)
        .sort().join("|") === signature
    )
    if (dupe) {
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

    const mrf = new MRF({
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

    await mrf.save()

    if (autoForward) {
      mrfNotify.autoForwarded(mrf).catch(e => console.error("[mrf autoForward notify]", e.message))
    } else {
      mrfNotify.submitted(mrf).catch(e => console.error("[mrf submitted notify]", e.message))
    }

    const obj = mrf.toObject()
    res.status(201).json({
      success: true,
      message: autoForward
        ? approver.autoForwardReason
        : `${mrf.mrfNumber} submitted — waiting for approval from ${approver.approverName}.`,
      mrf: obj,
      context: buildContext(obj, "requester"),
    })
  } catch (err) {
    console.error("[CoworkMRF POST /]", err)
    res.status(500).json({ success: false, message: err.message })
  }
}
router.post("/", createMrfRequest)

// ─────────────────────────────────────────────────────────────────────────────
// GET /product-requests — employee's own raw-item add requests
// Registered before "/:id".
//
// READ-ONLY LEGACY: kept only so pre-cutover RawItemAddRequest documents
// remain visible/resolvable. Nothing is written here any more — new "not in
// the catalogue" items are just MRF items with itemStatus UNMATCHED, created
// via POST / like everything else. See createMrfRequest above.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/product-requests", async (req, res) => {
  try {
    const emp = await resolveEmployee(req.user.id)
    if (!emp) return res.json({ success: true, requests: [] })
    const requests = await RawItemAddRequest.find({ requestedBy: emp._id })
      .sort({ createdAt: -1 })
      .populate("matchedTo", "name sku")
      .populate("products.matchedTo", "name sku")
      .populate("products.spawnedMrf", "mrfNumber status")
      .lean()
    res.json({ success: true, requests })
  } catch (err) {
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
router.post("/product-requests", async (req, res) => {
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
})

// ═════════════════════════════════════════════════════════════════════════════
// Product request — TL approval
//
// Mirrors the MRF approval endpoints. Only after the TL approves does the
// Store see the request at all, so matching against the catalogue never
// happens ahead of approval.
// ═════════════════════════════════════════════════════════════════════════════

/** Same legacy-safe approver check used for MRFs, applied to product requests. */
async function resolvePrAccess(doc, user) {
  if (!doc) return { canView: false, canApprove: false }

  const isRequester =
    (!!doc.requesterCoworkId && doc.requesterCoworkId === user.id)
  const isApprover =
    (!!doc.approverBiometricId && doc.approverBiometricId === user.id) ||
    (doc.approverAltIds || []).includes(user.id)

  if (isApprover) return { canView: true, canApprove: true }
  if (user.role === "ceo") return { canView: true, canApprove: true }
  if (isRequester) return { canView: true, canApprove: false, isRequester: true }

  // Raised before approver routing existed — fall back to the live HR link.
  if (!doc.approverBiometricId) {
    const requester = await Employee.findById(doc.requestedBy).select("primaryManager").lean()
    const managerId = requester?.primaryManager?.managerId
    if (managerId) {
      const me = await resolveEmployee(user.id)
      if (me && String(me._id) === String(managerId)) {
        return { canView: true, canApprove: true, backfill: me }
      }
    }
  }
  return { canView: false, canApprove: false }
}

// LEGACY — for pre-cutover RawItemAddRequest docs only. A not-yet-catalogued
// item on a NEW request is TL-approved on the same /:id/tl-approve every
// other MRF item uses (see createMrfRequest / nextStatus above); nothing
// creates a new RawItemAddRequest any more. This pair stays so a request
// that was still PENDING_TL at cutover isn't stranded with no way to ever be
// decided — delete once none remain in that state.
router.patch("/product-requests/:id/tl-approve", async (req, res) => {
  try {
    const doc = await RawItemAddRequest.findById(req.params.id)
    if (!doc) return res.status(404).json({ success: false, message: "Product request not found" })

    const access = await resolvePrAccess(doc.toObject(), req.user)
    if (!access.canApprove)
      return res.status(403).json({ success: false, message: "You are not the approver for this request." })

    if (access.backfill) {
      const ids = mrfApprover.coworkIdsOf(access.backfill)
      doc.approverEmployee = access.backfill._id
      doc.approverBiometricId = ids[0] || ""
      doc.approverAltIds = ids
      doc.approverName = buildFullName(access.backfill)
    }

    if (doc.approvalStatus === "TL_APPROVED")
      return res.json({ success: true, message: "Already approved", request: doc, alreadyDone: true })
    if (doc.approvalStatus === "TL_REJECTED")
      return res.status(400).json({ success: false, message: "This request was already rejected." })

    const actor = await resolveEmployee(req.user.id)
    const actorName = buildFullName(actor) || req.user.name || ""

    doc.approvalStatus = "TL_APPROVED"
    doc.tlApproved = true
    doc.tlApprovedBy = actor?._id || null
    doc.tlApprovedByName = actorName
    doc.tlApprovedAt = new Date()
    doc.tlRejected = false
    doc.tlRejectedAt = null
    doc.tlRejectionNote = ""
    await doc.save()

    mrfNotify.productRequestTlApproved(doc).catch(e => console.error("[pr approve notify]", e.message))

    res.json({ success: true, message: "Approved — the Store can now register or match this product.", request: doc })
  } catch (err) {
    console.error("[CoworkMRF pr tl-approve]", err)
    res.status(500).json({ success: false, message: err.message })
  }
})

router.patch("/product-requests/:id/tl-reject", async (req, res) => {
  try {
    const note = String(req.body.note || "").trim()
    if (!note)
      return res.status(400).json({ success: false, message: "A rejection reason is required — the requester sees it." })

    const doc = await RawItemAddRequest.findById(req.params.id)
    if (!doc) return res.status(404).json({ success: false, message: "Product request not found" })

    const access = await resolvePrAccess(doc.toObject(), req.user)
    if (!access.canApprove)
      return res.status(403).json({ success: false, message: "You are not the approver for this request." })

    if (doc.approvalStatus === "TL_REJECTED")
      return res.json({ success: true, message: "Already rejected", request: doc, alreadyDone: true })
    if (doc.products.some(p => p.status !== "PENDING"))
      return res.status(400).json({ success: false, message: "The Store has already acted on this request — it cannot be rejected now." })

    const actor = await resolveEmployee(req.user.id)
    const actorName = buildFullName(actor) || req.user.name || ""

    doc.approvalStatus = "TL_REJECTED"
    doc.tlRejected = true
    doc.tlRejectedBy = actor?._id || null
    doc.tlRejectedByName = actorName
    doc.tlRejectedAt = new Date()
    doc.tlRejectionNote = note
    doc.tlApproved = false
    doc.status = "REJECTED"
    doc.products.forEach(p => {
      if (p.status === "PENDING") {
        p.status = "REJECTED"
        p.storeNote = `Rejected by ${actorName || "Primary Manager/TL"}: ${note}`
        p.resolvedAt = new Date()
      }
    })
    await doc.save()

    mrfNotify.productRequestTlRejected(doc).catch(e => console.error("[pr reject notify]", e.message))

    res.json({ success: true, message: "Product request rejected", request: doc })
  } catch (err) {
    console.error("[CoworkMRF pr tl-reject]", err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// ── Product request chat — same thread mechanism as MRFs ─────────────────
// READ-ONLY-DATA LEGACY: the thread itself (and posting to it) still works
// for old RawItemAddRequest docs; nothing new creates one of these docs.
router.get("/product-requests/:id/chat", async (req, res) => {
  try {
    const doc = await RawItemAddRequest.findById(req.params.id).lean()
    if (!doc) return res.status(404).json({ success: false, message: "Product request not found" })
    const access = await resolvePrAccess(doc, req.user)
    if (!access.canView)
      return res.status(403).json({ success: false, message: "You do not have access to this conversation." })

    const messages = await mrfChat.listMessages(doc._id, {
      subjectType: "PRODUCT_REQUEST", limit: req.query.limit, before: req.query.before,
    })
    await mrfChat.markRead(doc._id, req.user.id, "PRODUCT_REQUEST")

    res.json({
      success: true,
      messages,
      mrfNumber: mrfChat.describeSubject(doc, "PRODUCT_REQUEST").label,
      status: doc.approvalStatus,
      isFinal: doc.approvalStatus === "TL_REJECTED" || doc.status === "RESOLVED",
    })
  } catch (err) { res.status(500).json({ success: false, message: err.message }) }
})

router.post("/product-requests/:id/chat", async (req, res) => {
  try {
    const doc = await RawItemAddRequest.findById(req.params.id)
    if (!doc) return res.status(404).json({ success: false, message: "Product request not found" })
    const access = await resolvePrAccess(doc.toObject(), req.user)
    if (!access.canView)
      return res.status(403).json({ success: false, message: "You do not have access to this conversation." })

    const emp = await resolveEmployee(req.user.id)
    const message = await mrfChat.postMessage(doc, {
      subjectType: "PRODUCT_REQUEST",
      body: req.body.body,
      attachments: cleanImages(req.body.attachments).map(a => ({ ...a, type: "image" })),
      ...chatSenderFor(req, emp, access.isRequester ? "employee" : undefined),
    })

    // See the note on the MRF chat route below: the notifier existed and was
    // wired to nothing, so these conversations reached only whoever was
    // already looking at them.
    mrfNotify.productRequestChatMessage(doc, message)
      .catch(e => console.error("[pr chat notify]", e.message))

    res.status(201).json({ success: true, message })
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message })
  }
})

router.patch("/product-requests/:id/chat/read", async (req, res) => {
  try {
    const r = await mrfChat.markRead(req.params.id, req.user.id, "PRODUCT_REQUEST")
    res.json({ success: true, ...r })
  } catch (err) { res.status(500).json({ success: false, message: err.message }) }
})

// ─────────────────────────────────────────────────────────────────────────────
// Single MRF — detail, cancel, chat
// ─────────────────────────────────────────────────────────────────────────────

/** GET /:id — full detail with live stock, for requester / TL / CEO. */
router.get("/:id", async (req, res) => {
  try {
    const mrf = await MRF.findById(req.params.id)
      .populate("requestedFor", "firstName middleName lastName name department designation email biometricId identityId")
      .lean()
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" })
    const access = await resolveAccess(mrf, req.user)
    if (!access.canView)
      return res.status(403).json({ success: false, message: "You do not have access to this request." })

    markOverdue([mrf])
    const audience = access.isRequester ? "requester" : "tl"
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
router.patch("/:id/cancel", async (req, res) => {
  try {
    const emp = await resolveEmployee(req.user.id)
    const mrf = await MRF.findOne({ _id: req.params.id, requestedFor: emp?._id })
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" })

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
    await mrf.save()

    mrfChat.systemMessage(mrf, `${actorName || "The requester"} cancelled this request. ${mrf.cancellationNote}`, actorName)
    mrfNotify.cancelled(mrf).catch(e => console.error("[mrf cancel notify]", e.message))

    res.json({ success: true, message: "Request cancelled", mrf, context: buildContext(mrf.toObject(), "requester") })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

/** GET /:id/chat — the MRF's own thread. */
router.get("/:id/chat", async (req, res) => {
  try {
    const mrf = await MRF.findById(req.params.id).lean()
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" })
    const access = await resolveAccess(mrf, req.user)
    if (!access.canView)
      return res.status(403).json({ success: false, message: "You do not have access to this conversation." })

    const messages = await mrfChat.listMessages(mrf._id, {
      limit: req.query.limit, before: req.query.before,
    })
    await mrfChat.markRead(mrf._id, req.user.id)

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
router.post("/:id/chat", async (req, res) => {
  try {
    const mrf = await MRF.findById(req.params.id)
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" })
    const access = await resolveAccess(mrf.toObject(), req.user)
    if (!access.canView)
      return res.status(403).json({ success: false, message: "You do not have access to this conversation." })
    if (access.backfill) { applyBackfill(mrf, access.backfill); await mrf.save() }

    const emp = await resolveEmployee(req.user.id)
    const message = await mrfChat.postMessage(mrf, {
      body: req.body.body,
      attachments: cleanImages(req.body.attachments).map(a => ({ ...a, type: "image" })),
      // Label by role ON THIS REQUEST, not the account's global role — a TL
      // raising their own MRF is the requester in that thread.
      ...chatSenderFor(req, emp, access.isRequester ? "employee" : undefined),
    })

    // `mrfNotify.chatMessage` was written for exactly this and wired to
    // nothing, so an MRF conversation notified nobody: the requester answering
    // the store's question, or the store answering theirs, reached only whoever
    // happened to have the thread open. It already addresses the requester and
    // the TL and excludes the sender, so there is nothing to decide here.
    mrfNotify.chatMessage(mrf, message).catch(e => console.error("[mrf chat notify]", e.message))

    res.status(201).json({ success: true, message })
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message })
  }
})

/** PATCH /:id/chat/read — clear this user's unread badge. */
router.patch("/:id/chat/read", async (req, res) => {
  try {
    const r = await mrfChat.markRead(req.params.id, req.user.id)
    res.json({ success: true, ...r })
  } catch (err) { res.status(500).json({ success: false, message: err.message }) }
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
module.exports.firebaseChain = [verifyCoworkToken, verifyEmployeeToken, attach]
module.exports.cmsChain = [require("../../../../Middlewear/EmployeeAuthMiddlewear"), cmsAttach]
