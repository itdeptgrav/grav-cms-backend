// routes/CMS_Routes/Inventory/Operations/mrfRoutes.js
// Mount: app.use("/api/cms/inventory/mrf", mrfRoutes)

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const MRF = require("../../../../models/CMS_Models/Inventory/Operations/MRF");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");
const Employee = require("../../../../models/Employee");
const EmployeeAuth = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const NotificationService = require("../../../../services/NotificationService");
const RawItemAddRequest = require("../../../../models/CMS_Models/Inventory/Operations/RawItemAddRequest");

const mrfNotify = require("../../../../services/mrfNotify.service");
const mrfChat = require("../../../../services/mrfChat.service");
const { buildContext } = require("../../../../services/mrfContext.service");
const mrfUnits = require("../../../../services/mrfUnits.service");
const fulfilment = require("../../../../services/storeFulfilment.service");

/* ── Chunk 1B: tenancy, authority, history, safe stock effects ─────────────
 * Chunk 0 measured what this router does today: every authenticated caller
 * whose role is not literally "employee" sees and mutates every material
 * request in the database, across every company, with no capability check and
 * no idempotency — so a retried issue moves stock twice. */
const {
  requireTenant, requireCapability, refuseLegacyWrite, withIdempotency,
} = require("../../../../Middlewear/storePurchaseTenant");
const { CAPABILITIES, hasAll } = require("../../../../services/storePurchase/capabilities");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const mrfAuthority = require("../../../../services/storePurchase/mrfAuthority.service");
const actionHistory = require("../../../../services/storePurchase/actionHistory.service");
const unitOfWork = require("../../../../services/storePurchase/unitOfWork.service");
const idempotencyService = require("../../../../services/storePurchase/idempotency.service");
const documentSequence = require("../../../../services/storePurchase/documentSequence.service");
const { fail, sendError } = require("../../../../services/storePurchase/errors");

const MRF_ENTITY = "MRF";

router.use(EmployeeAuth);
router.use(requireTenant);

/**
 * Load a request within the tenant, or answer as though it does not exist.
 *
 * Never `findById`: another company's id must be indistinguishable from a
 * missing one, or the endpoint becomes a way to discover which requests
 * exist elsewhere.
 */
async function loadMrf(req, id, { lean = false } = {}) {
  const query = MRF.findOne({ _id: id, ...tenantContext.tenantFilter(req.tenant) });
  const doc = lean ? await query.lean() : await query;
  if (!doc) throw fail("NOT_FOUND", "That material request was not found.");
  return doc;
}

/** The CMS actor as an Employee record, for relationship authority. */
async function actorEmployee(req) {
  if (req._actorEmployee !== undefined) return req._actorEmployee;
  const or = [];
  if (mongoose.Types.ObjectId.isValid(req.user?.id)) or.push({ _id: req.user.id });
  if (req.user?.employeeId) or.push({ biometricId: req.user.employeeId }, { identityId: req.user.employeeId });
  if (req.user?.email) or.push({ email: String(req.user.email).toLowerCase().trim() });
  req._actorEmployee = or.length
    ? await Employee.findOne({ $or: or })
        .select("_id firstName lastName name email biometricId identityId department")
        .lean()
        .catch(() => null)
    : null;
  return req._actorEmployee;
}

/** Assert the authority matrix for one action on one request. */
async function may(req, action, mrf) {
  return mrfAuthority.assertMay(action, {
    mrf, ctx: req.tenant, employee: await actorEmployee(req),
  });
}

/**
 * Note a state change in the request's own thread.
 *
 * Awaited, not fired and forgotten: the thread is how the requester finds out
 * why their request changed, and a promise nobody waits on loses that silently.
 * The key is derived from the action's own idempotency key, so a retry of the
 * action recovers the same note instead of posting a second one — which is
 * what makes awaiting safe here.
 */
const noteInThread = (req, mrf, text, who) => mrfChat.systemMessage(mrf, text, who, {
  ctx: req.tenant,
  idempotencyKey: req.idempotent?.key ? `${req.idempotent.key}:system` : null,
});

/**
 * Commit a governed change to a material request.
 *
 * ── WHY THE SAVE AND THE HISTORY ARE ONE STEP ───────────────────────────────
 * Routes used to save the request, then write history separately, then answer
 * through the generic idempotency wrapper. If the history write failed, the
 * mutation was already committed, the caller got a 500, and a retry took an
 * "already approved" shortcut that never repaired the missing history — the
 * change had happened and nothing immutable recorded it.
 *
 * The unit of work puts them together: one transaction where the deployment
 * supports it, and where it does not, an effect marker written before the
 * history so a retry recovers rather than repeats. Every governed mutation
 * goes through here, so none of them can drift back to the old shape.
 */
const commitMrf = (req, mrf, entry) =>
  unitOfWork.run(req.tenant, {
    idempotencyRecord: req.idempotent?.record,
    mutate: async (session) => {
      await mrf.save(session ? { session } : {});
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
      };
    },
  });

/**
 * A retry of an action whose effect already landed.
 *
 * Repairs the immutable history if that is what went missing, then answers
 * with what the first attempt would have said. It never re-applies anything —
 * that is the whole point of the effect marker that routed us here.
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
  });
  return req.idempotent.succeed(status, payload, {
    entityType: MRF_ENTITY, entityId: mrf._id,
  });
};

/** History for a governed material-request mutation. */
const mrfHistory = (req, mrf, entry) => actionHistory.record(req.tenant, {
  entityType: MRF_ENTITY,
  entityId: mrf._id,
  documentNumber: mrf.mrfNumber,
  requestId: req.id || "",
  idempotencyKey: req.idempotent?.key || "",
  ...entry,
});

// ── Approval flow ─────────────────────────────────────────────────────────
// Employee → Primary Manager/TL (in cowork) → Store.
// The store no longer approves or rejects MRFs; by the time one appears here
// it has already been approved by the requester's TL, or auto-forwarded
// because no TL could be resolved. What the store owns is availability and
// issuance — see PATCH /:id/availability and POST /:id/unfulfilled.
const isStoreActionable = (mrf) =>
  mrf.tlApproved || mrf.autoForwarded || mrf.creationMode === "BYPASS" || mrf.pmApproved;

// ── helpers ───────────────────────────────────────────────────────────────────
function buildFullName(emp) {
  if (!emp) return "";
  return [emp.firstName, emp.middleName, emp.lastName]
    .filter(Boolean).join(" ").trim() || emp.email || emp.name || "";
}

// EmployeeAuthMiddleware sets req.user._id (ObjectId) on the store/PM side.
// On the cowork/employee side it may set req.user.id as a string.
// Always prefer _id for ObjectId fields.
function getActorId(req) {
  return req.user._id || req.user.id;
}

// Unit handling is centralised in mrfUnits.service: the requester's chosen
// unit is authoritative for every displayed and entered quantity, and
// conversion to the catalogue base unit happens only where stock is touched.
const convertQty = mrfUnits.convertQty;

async function adjustStock(rawItemId, variantId, variantCombination, delta, txnMeta) {
  const raw = await RawItem.findById(rawItemId);
  if (!raw) throw new Error(`RawItem ${rawItemId} not found`);
  const prevQty = raw.quantity || 0;

  let matchedVariant = null;
  if (variantId && raw.variants?.length) matchedVariant = raw.variants.id(variantId);
  if (!matchedVariant && variantCombination?.length && raw.variants?.length) {
    matchedVariant = raw.variants.find(v =>
      v.combination?.length === variantCombination.length &&
      v.combination.every((val, i) => val === variantCombination[i])
    );
  }
  if (matchedVariant) {
    matchedVariant.quantity = Math.max(0, (matchedVariant.quantity || 0) + delta);
    matchedVariant.status =
      matchedVariant.quantity === 0 ? "Out of Stock" :
        matchedVariant.quantity <= (matchedVariant.minStock || raw.minStock || 0) ? "Low Stock" : "In Stock";
  }

  raw.quantity = Math.max(0, prevQty + delta);
  raw.status =
    raw.quantity === 0 ? "Out of Stock" :
      raw.quantity <= (raw.minStock || 0) ? "Low Stock" : "In Stock";

  raw.stockTransactions.push({
    ...txnMeta,
    previousQuantity: prevQty,
    newQuantity: raw.quantity,
    ...(matchedVariant ? { variantId, variantCombination } : {}),
  });
  await raw.save();
}

const buildUnitConversions = mrfUnits.buildUnitConversions;

/** Actor label for audit entries and chat system messages. */
const actorName = (req) => req.user?.name || req.user?.firstName || "Store";

/**
 * READ-ONLY LEGACY: whether the store could act on a pre-cutover
 * RawItemAddRequest doc. Product requests are no longer their own thing —
 * "not in the catalogue" items are just MRF items (itemStatus UNMATCHED),
 * gated by the ordinary isStoreActionable() above — but this still backs the
 * legacy GET /product-requests/:id read route below, for anything raised
 * before this changed.
 */
function prStoreActionable(doc) {
  if (!doc) return false;
  if (doc.approvalStatus === "TL_APPROVED") return true;
  if (doc.approvalStatus === "TL_REJECTED") return false;
  if (doc.autoForwarded) return true;
  return (doc.products || []).some(p => p.status && p.status !== "PENDING");
}

/** Resolves who approves an MRF this route raises on someone's behalf. */
async function approverPatchFor(employeeId) {
  const mrfApprover = require("../../../../services/mrfApprover.service");
  const emp = await Employee.findById(employeeId)
    .select("_id firstName middleName lastName name biometricId identityId department primaryManager isActive status")
    .lean();
  if (!emp) {
    return {
      patch: {
        approverResolution: "MANAGER_NOT_FOUND",
        approvalRoute: "AUTO_STORE",
        autoForwarded: true,
        autoForwardReason: "Requester's HR record could not be read — sent directly to the Store.",
      },
      requestedForId: "",
    };
  }
  const patch = await mrfApprover.resolveApprover(emp);
  return { patch, requestedForId: emp.biometricId || emp.identityId || "" };
}

async function buildMrfItems(items) {
  const built = [];
  for (const it of items) {
    if (!it.rawItemId || !it.requestedQty || parseFloat(it.requestedQty) <= 0) continue;
    const raw = await RawItem.findById(it.rawItemId)
      .select("name sku unit customUnit").lean();
    if (!raw) continue;
    const baseUnit = raw.customUnit || raw.unit || "unit";
    built.push({
      rawItem: raw._id,
      rawItemName: raw.name,
      rawItemSku: raw.sku || "",
      variantId: it.variantId || null,
      variantCombination: it.variantCombination || [],
      description: String(it.description || "").trim().slice(0, 1000),
      specifications: String(it.specifications || "").trim().slice(0, 1000),
      images: Array.isArray(it.images)
        ? it.images
          .filter(im => im?.url && /^https?:\/\//i.test(im.url))
          .slice(0, 5)
          .map(im => ({ url: im.url, publicId: im.publicId || "", name: im.name || "" }))
        : [],
      requestedQty: parseFloat(it.requestedQty),
      // The unit the requester chose is authoritative for this line.
      unit: it.unit || baseUnit,
      baseUnit,
      itemStatus: "PENDING",
      availability: "UNREVIEWED",
    });
  }
  return built;
}

function markOverdue(mrfs) {
  const now = new Date();
  mrfs.forEach(mrf => {
    if (mrf.requestType === "TIME_BASED" && mrf.deadline && new Date(mrf.deadline) < now) {
      mrf.items.forEach(item => {
        if (item.itemStatus === "ISSUED") item.itemStatus = "OVERDUE";
      });
    }
  });
}

// ── GET /data/raw-items ───────────────────────────────────────────────────────
router.get("/data/raw-items", async (req, res) => {
  try {
    const { search = "" } = req.query;
    const filter = search
      ? { $or: [{ name: { $regex: search, $options: "i" } }, { sku: { $regex: search, $options: "i" } }] }
      : {};
    const items = await RawItem.find(filter)
      .select("name sku unit customUnit quantity variants")
      .sort({ name: 1 }).limit(50).lean();
    const unitMap = await buildUnitConversions();
    const formatted = items.map(item => {
      const baseUnit = item.customUnit || item.unit || "unit";
      return {
        _id: item._id, name: item.name, sku: item.sku, baseUnit,
        quantity: item.quantity || 0,
        conversions: unitMap[baseUnit] || [],
        variants: (item.variants || []).map(v => ({
          _id: v._id, combination: v.combination || [],
          quantity: v.quantity || 0, sku: v.sku || "", status: v.status || "Out of Stock",
        })),
      };
    });
    res.json({ success: true, rawItems: formatted });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /data/employees ───────────────────────────────────────────────────────
router.get("/data/employees", async (req, res) => {
  try {
    const { search = "" } = req.query;
    if (!search.trim()) return res.json({ success: true, employees: [] });
    const s = search.trim();
    const filter = {
      $or: [
        { firstName: { $regex: s, $options: "i" } },
        { middleName: { $regex: s, $options: "i" } },
        { lastName: { $regex: s, $options: "i" } },
        { biometricId: { $regex: s, $options: "i" } },
        { identityId: { $regex: s, $options: "i" } },
        { email: { $regex: s, $options: "i" } },
        { name: { $regex: s, $options: "i" } },  // fallback for single-field name
        {
          $expr: {
            $regexMatch: {
              input: {
                $trim: {
                  input: {
                    $concat: [
                      { $ifNull: ["$firstName", ""] }, " ",
                      { $ifNull: ["$middleName", ""] }, " ",
                      { $ifNull: ["$lastName", ""] }
                    ]
                  }
                }
              },
              regex: s, options: "i"
            }
          }
        }
      ],
      isActive: { $ne: false },
    };
    const employees = await Employee.find(filter)
      .select("firstName middleName lastName name biometricId identityId email department designation")
      .limit(20).lean();
    res.json({
      success: true,
      employees: employees.map(e => ({
        _id: e._id,
        fullName: buildFullName(e),
        biometricId: e.biometricId || e.identityId || "",
        department: e.department || "",
        email: e.email || "",
        designation: e.designation || "",
      })),
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET / — list MRFs ─────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const {
      status, requestType, creationMode, priority,
      page = 1, limit = 20, search = ""
    } = req.query;

    /* ── Chunk 1B ───────────────────────────────────────────────────────────
     * This used to read: scope to own requests IF the JWT role is literally
     * "employee", otherwise return everything. Every other role — and every
     * other company — saw the whole collection.
     *
     * Now the tenant filter is the floor, and within the company a caller
     * without Store read authority sees only what is theirs: the requests
     * raised for them and the ones routed to them for a decision. */
    const filter = { ...tenantContext.tenantFilter(req.tenant) };

    if (!req.tenant.capabilitySet.has(CAPABILITIES.READ)) {
      const me = await actorEmployee(req);
      const badgeIds = [me?.biometricId, me?.identityId, req.user?.employeeId].filter(Boolean).map(String);
      const mine = [];
      if (me?._id) mine.push({ requestedFor: me._id }, { approverEmployee: me._id });
      if (badgeIds.length) {
        mine.push({ requestedForId: { $in: badgeIds } });
        mine.push({ approverBiometricId: { $in: badgeIds } });
        mine.push({ approverAltIds: { $in: badgeIds } });
      }
      /* Nothing identifies this caller on any request — then nothing is
         theirs. An empty `$or` would match everything, so it is refused. */
      if (!mine.length) {
        return res.json({ success: true, mrfs: [], pagination: { total: 0, page: 1, pages: 0 }, stats: {} });
      }
      filter.$and = [{ $or: mine }];
    }

    if (status) filter.status = status;
    if (requestType) filter.requestType = requestType;
    if (creationMode) filter.creationMode = creationMode;
    if (priority) filter.priority = priority;
    if (search) {
      /* Into `$and`, not `$or`: a bare `$or` here would REPLACE the authority
         clause above and hand every caller the whole company. */
      filter.$and = [...(filter.$and || []), { $or: [
        { mrfNumber: { $regex: search, $options: "i" } },
        { requestedForName: { $regex: search, $options: "i" } },
        { requestedForId: { $regex: search, $options: "i" } },
        { reason: { $regex: search, $options: "i" } },
        { costCentre: { $regex: search, $options: "i" } },
        { projectReference: { $regex: search, $options: "i" } },
      ] }];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await MRF.countDocuments(filter);
    const mrfs = await MRF.find(filter)
      .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit))
      .populate("requestedFor", "firstName middleName lastName biometricId identityId name department")
      .populate("approvedBy", "firstName lastName name")
      .populate("rejectedBy", "firstName lastName name")
      .lean();

    mrfs.forEach(mrf => {
      if (mrf.requestedFor && typeof mrf.requestedFor === "object") {
        mrf.requestedFor._fullName = buildFullName(mrf.requestedFor);
      }
      // Same contextual copy the requester and TL see, phrased for the store.
      mrf.context = buildContext(mrf, "store");
      mrf.storeActionable = isStoreActionable(mrf);
    });
    markOverdue(mrfs);

    // Attach "originally requested as X" to any MRF that was spawned from a
    // product-request match/approve — one batched lookup, not one per MRF.
    const mrfIds = mrfs.map(m => m._id);
    if (mrfIds.length) {
      /* Scoped: the ids come from an already-scoped list, but a legacy
         product request in another company must not surface its requester's
         name through this join. */
      const sourceDocs = await RawItemAddRequest.find({
        "products.spawnedMrf": { $in: mrfIds },
        ...tenantContext.tenantFilter(req.tenant),
      })
        .select("products requestedByName")
        .lean();
      const sourceByMrfId = {};
      sourceDocs.forEach(doc => {
        (doc.products || []).forEach(p => {
          if (p.spawnedMrf) {
            sourceByMrfId[p.spawnedMrf.toString()] = { itemName: p.itemName, requestedByName: doc.requestedByName };
          }
        });
      });
      mrfs.forEach(mrf => {
        mrf.sourceProductRequest = sourceByMrfId[mrf._id.toString()] || null;
      });
    }

    /* Stats for the store dashboard. They used to be deliberately global —
       "no filter, always global counts" — which across a tenant boundary
       leaks another company's volume even while its rows stay hidden. The
       same tenant filter as the list. */
    const statsAgg = await MRF.aggregate([
      { $match: { ...tenantContext.tenantFilter(req.tenant) } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          pending: { $sum: { $cond: [{ $eq: ["$status", "PENDING"] }, 1, 0] } },
          approved: { $sum: { $cond: [{ $eq: ["$status", "APPROVED"] }, 1, 0] } },
          issued: { $sum: { $cond: [{ $in: ["$status", ["ISSUED", "PARTIALLY_ISSUED"]] }, 1, 0] } },
          bypass: { $sum: { $cond: [{ $eq: ["$creationMode", "BYPASS"] }, 1, 0] } },
          // Approved and sitting with the store, availability not yet recorded.
          awaitingStore: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$status", "APPROVED"] }, { $eq: ["$storeReviewedAt", null] }] },
                1, 0,
              ],
            },
          },
        }
      },
    ]);
    const stats = statsAgg[0] || { total: 0, pending: 0, approved: 0, issued: 0, bypass: 0, awaitingStore: 0 };
    delete stats._id;

    res.json({
      success: true, mrfs, stats,
      // MRF approval now happens in cowork (Employee → TL → Store). The store
      // never approves; these flags tell the UI to render accordingly.
      approvalFlow: "TL",
      pmApprovalRequired: false,
      storeCanApprove: false,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (e) { console.error("[MRF GET /]", e); res.status(500).json({ success: false, message: e.message }); }
});

/**
 * Product requests are legacy-global: `RawItemAddRequest` has no company field,
 * so every record that exists predates the boundary and none can be created.
 *
 * The adopted policy therefore applies in full — excluded from ordinary lists,
 * reachable only when the caller both holds `sp.legacy.read` and explicitly
 * asks with `?scope=legacy`, and never writable. `requireTenant` has already
 * checked the capability by the time this runs; what it adds is the refusal to
 * serve a legacy record through an ordinary read, which would otherwise be an
 * unowned record quietly appearing inside a company.
 */
function requireLegacyRead(req, res, next) {
  if (!req.tenant?.legacyMode) {
    return sendError(res, fail(
      "LEGACY_ACCESS_REQUIRED",
      "Product requests are legacy records. Ask for them explicitly with ?scope=legacy.",
      { scope: "legacy", readOnly: true },
    ));
  }
  next();
}

/** Any write to a legacy record, named for what it is. */
const refuseLegacyProductRequestWrite = (replacedBy) => (req, res) =>
  sendError(res, fail(
    "LEGACY_ACCESS_REQUIRED",
    "Product requests are read-only. Act on the material request itself.",
    { readOnly: true, ...(replacedBy ? { replacedBy } : {}) },
  ));

// ═══════════════════════════════════════════════════════════════════════════
// STORE-SIDE: New Product Registration Requests (from cowork employees)
// Registered BEFORE "/:id" — otherwise Express matches "/:id" first and
// treats "product-requests" as an MRF id, returning nothing.
// ═══════════════════════════════════════════════════════════════════════════
router.get("/product-requests", async (req, res) => {
  try {
    const { status } = req.query;
    // The Store SEES every product request, approved or not — so they know
    // what is coming and can ask about it in the chat. What they cannot do is
    // ACT on one (match / register / reject) before the requester's Primary
    // Manager/TL has approved it; that gate lives on the mutating routes
    // below, not here. Hiding unapproved requests entirely would leave the
    // store unable to prepare or answer questions about them.
    const filter = { ...tenantContext.tenantFilter(req.tenant) };
    if (status) filter.status = status;
    const requests = await RawItemAddRequest.find(filter)
      .sort({ createdAt: -1 })
      .populate("requestedBy", "firstName middleName lastName name department")
      .populate("matchedTo", "name sku")
      .populate("products.matchedTo", "name sku")
      .populate("products.spawnedMrf", "mrfNumber status")
      .lean();
    res.json({ success: true, requests });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get("/product-requests/:id", requireLegacyRead, async (req, res) => {
  try {
    const request = await RawItemAddRequest.findOne({
      _id: req.params.id, ...tenantContext.tenantFilter(req.tenant),
    })
      .populate("requestedBy", "firstName middleName lastName name department")
      .populate("matchedTo", "name sku")
      .populate("products.matchedTo", "name sku")
      .populate("products.spawnedMrf", "mrfNumber status")
      .lean();
    if (!request) return res.status(404).json({ success: false, message: "Product request not found" });
    // Viewable either way; whether the store can act on it is a separate
    // question the UI reads off `storeActionable`.
    res.json({
      success: true,
      request,
      storeActionable: prStoreActionable(request),
      awaitingTlMessage: prStoreActionable(request)
        ? ""
        : request.approvalStatus === "TL_REJECTED"
          ? `Rejected by ${request.tlRejectedByName || "the requester's Primary Manager/TL"}.${request.tlRejectionNote ? ` Reason: "${request.tlRejectionNote}"` : ""}`
          : `Awaiting approval from ${request.approverName || "the requester's Primary Manager/TL"}. You can discuss it in the chat, but it cannot be matched or registered until they approve.`,
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Product request chat — store side of the same thread ─────────────────
// Registered before "/:id" so Express does not read "product-requests" as an
// MRF id.
router.get("/product-requests/:id/chat", requireLegacyRead, async (req, res) => {
  try {
    const doc = await RawItemAddRequest.findOne({
      _id: req.params.id, ...tenantContext.tenantFilter(req.tenant),
    }).select("products approvalStatus status companyId").lean();
    if (!doc) return res.status(404).json({ success: false, message: "Product request not found" });

    /* Read only. Marking the thread read is a write, and a legacy record takes
       no writes — not even one this small. The thread is history now. */
    const messages = await mrfChat.listMessages(doc, {
      ctx: req.tenant, subjectType: "PRODUCT_REQUEST",
      limit: req.query.limit, before: req.query.before,
    });

    res.json({
      success: true,
      messages,
      mrfNumber: mrfChat.describeSubject(doc, "PRODUCT_REQUEST").label,
      status: doc.status,
      isFinal: doc.status === "RESOLVED" || doc.status === "REJECTED",
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post(
  "/product-requests/:id/chat",
  refuseLegacyProductRequestWrite("POST /api/cms/inventory/mrf/:id/chat"),
);

/* Mark-read is a mutation too, and was never registered on this door. It stays
   unregistered deliberately, so nothing can be marked read on a legacy thread. */

function cartesianProduct(arrays) {
  if (!arrays || arrays.length === 0) return [[]];
  return arrays.reduce((acc, vals) => {
    const result = [];
    for (const prefix of acc) {
      for (const val of vals) {
        result.push([...prefix, val]);
      }
    }
    return result;
  }, [[]]);
}

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY — match/register/reject for pre-cutover RawItemAddRequest docs only.
// Nothing creates a new one of these any more (see createMrfRequest in
// coworkMrfRoutes.js); a NEW request's not-yet-catalogued items are resolved
// by the item-scoped /:id/items/:itemId/* routes further down, in place, on
// the request's own MRF. This trio stays only so a product request that was
// still open at cutover isn't stranded — delete once none remain PENDING.
// ═══════════════════════════════════════════════════════════════════════════
/* ── LEGACY, READ-ONLY ────────────────────────────────────────────────────
 * Product requests were retired: "not in the catalogue" items are now MRF
 * lines with itemStatus UNMATCHED, handled by /:id/items/:itemId/*. This
 * write route survived only because a frontend once called it, which is
 * not a reason to keep an ungoverned second path into the same data.
 * Refused clearly; the legacy READS below stay. */
router.patch("/product-requests/:id/match", (req, res) =>
  sendError(res, fail(
    "LEGACY_ACCESS_REQUIRED",
    "Product requests are read-only. Match or register the line on the material request itself.",
    { readOnly: true, replacedBy: "PATCH /api/cms/inventory/mrf/:id/items/:itemId/match" },
  )));

/* Body retained unreferenced: it documents exactly what the retired route
   did, and deleting it would lose that record while the replacement on the
   material request itself is still bedding in. */

/* ── LEGACY, READ-ONLY ────────────────────────────────────────────────────
 * Product requests were retired: "not in the catalogue" items are now MRF
 * lines with itemStatus UNMATCHED, handled by /:id/items/:itemId/*. This
 * write route survived only because a frontend once called it, which is
 * not a reason to keep an ungoverned second path into the same data.
 * Refused clearly; the legacy READS below stay. */
router.patch("/product-requests/:id/approve", (req, res) =>
  sendError(res, fail(
    "LEGACY_ACCESS_REQUIRED",
    "Product requests are read-only. Match or register the line on the material request itself.",
    { readOnly: true, replacedBy: "PATCH /api/cms/inventory/mrf/:id/items/:itemId/approve" },
  )));

/* Body retained unreferenced: it documents exactly what the retired route
   did, and deleting it would lose that record while the replacement on the
   material request itself is still bedding in. */

/* ── LEGACY, READ-ONLY ────────────────────────────────────────────────────
 * Product requests were retired: "not in the catalogue" items are now MRF
 * lines with itemStatus UNMATCHED, handled by /:id/items/:itemId/*. This
 * write route survived only because a frontend once called it, which is
 * not a reason to keep an ungoverned second path into the same data.
 * Refused clearly; the legacy READS below stay. */
router.patch("/product-requests/:id/reject", (req, res) =>
  sendError(res, fail(
    "LEGACY_ACCESS_REQUIRED",
    "Product requests are read-only. Match or register the line on the material request itself.",
    { readOnly: true, replacedBy: "PATCH /api/cms/inventory/mrf/:id/items/:itemId/reject" },
  )));

/* Body retained unreferenced: it documents exactly what the retired route
   did, and deleting it would lose that record while the replacement on the
   material request itself is still bedding in. */

// ═══════════════════════════════════════════════════════════════════════════
// Resolving an UNMATCHED item — the Store links it to the catalogue (or
// registers it as new) IN PLACE, on this same MRF. No spawned document, no
// second number, no redirect: the request the store is already looking at
// is the same one they keep working on.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * PATCH /:id/items/:itemId/match — link an UNMATCHED item (or edit an
 * already-matched one, as long as nothing has been issued yet) to an
 * existing catalogue item.
 */
router.patch(
  "/:id/items/:itemId/match",
  requireCapability(CAPABILITIES.MRF_FULFIL),
  refuseLegacyWrite,
  withIdempotency("MRF_MATCH"),
  async (req, res) => {
  try {
    const { rawItemId, variantId, variantCombination, requestedQty } = req.body;
    if (!rawItemId) return res.status(400).json({ success: false, message: "rawItemId required" });

    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) });
    if (!mrf) return res.status(404).json({ success: false, message: "Request not found" });
    /* The authority matrix: relationship authority for the requester and
       the assigned approver, capability authority for the store. A
       request this caller may not even see is answered as missing. */
    await may(req, "MATCH", mrf);
    if (!isStoreActionable(mrf)) {
      return res.status(403).json({ success: false, message: "This request has not been approved yet." });
    }

    const item = mrf.items.id(req.params.itemId);
    if (!item) return res.status(404).json({ success: false, message: "Item not found on this request" });
    const wasRematch = item.itemStatus === "APPROVED";
    const canMatch = item.itemStatus === "UNMATCHED"
      || (wasRematch && (item.issuedQty || 0) === 0);
    if (!canMatch) {
      return res.status(400).json({
        success: false,
        message: `Cannot match — this item is already ${item.itemStatus.toLowerCase()}${(item.issuedQty || 0) > 0 ? " with quantity issued" : ""}.`,
      });
    }

    const rawItem = await RawItem.findById(rawItemId).select("name sku unit customUnit variants").lean();
    if (!rawItem) return res.status(404).json({ success: false, message: "Raw item not found" });
    if ((rawItem.variants || []).length > 0 && !variantId) {
      return res.status(400).json({ success: false, message: "This item has variants — pick one before matching" });
    }

    // The store confirming the match is also the point where a genuinely
    // wrong quantity the requester typed can be corrected — optional, and
    // never below what's already issued (can't happen on an UNMATCHED item,
    // but a re-match keeps the same floor for safety).
    if (requestedQty !== undefined && requestedQty !== null && requestedQty !== "") {
      const q = parseFloat(requestedQty);
      if (!Number.isFinite(q) || q <= 0) {
        return res.status(400).json({ success: false, message: "Quantity must be a positive number" });
      }
      if (q < (item.issuedQty || 0)) {
        return res.status(400).json({ success: false, message: `Cannot set quantity below the ${item.issuedQty} ${item.unit} already issued` });
      }
      item.requestedQty = q;
    }

    // The matched product's own unit wins, not whatever the requester typed —
    // a request raised as "2 pc" against a product actually stocked in "Mtr"
    // has to be tracked in Mtr from here on, or every stock/issued comparison
    // downstream compares two different units as if they were the same
    // number. (Previously the requester's unit was kept "authoritative" on
    // the theory that matching only decides WHICH item this is — but the
    // unit is a property of the item too, not a free-standing fact the
    // requester gets to fix in advance of knowing what it would be matched
    // to.)
    const matchedUnit = rawItem.customUnit || rawItem.unit || "unit";
    item.rawItem = rawItem._id;
    item.rawItemName = rawItem.name;
    item.rawItemSku = rawItem.sku || "";
    item.variantId = variantId || null;
    item.variantCombination = variantCombination || [];
    item.unit = matchedUnit;
    item.baseUnit = matchedUnit;
    item.itemStatus = "APPROVED";
    item.category = "";
    item.attributes = [];

    mrf.logEvent({
      action: wasRematch ? "ITEM_REMATCHED" : "ITEM_MATCHED", actorName: actorName(req), actorRole: "store",
      detail: `"${item.rawItemName}" matched to "${rawItem.name}" — ready to issue.`,
    });
    await commitMrf(req, mrf, {
      action: wasRematch ? "ITEM_REMATCHED" : "ITEM_MATCHED",
      previousState: mrf.status, resultingState: mrf.status,
      changes: [{ field: item.rawItemName, from: null, to: rawItem.name }],
      metadata: { itemId: String(item._id), rawItemId: String(rawItem._id) },
    });

    NotificationService.sendToUser(mrf.requestedFor, {
      title: wasRematch ? "Item Re-matched" : "Item Matched",
      body: `"${rawItem.name}" was found in inventory for your request ${mrf.mrfNumber} — ready to be issued.`,
      type: "request",
      url: "/coworking/mrf",
      tag: `mrf-item-matched-${mrf._id}-${item._id}`,
    }).catch(() => { });

    const matchedPayload = { success: true, message: "Matched to existing item", mrf, wasRematch };
    return req.idempotent
      ? await req.idempotent.succeed(200, matchedPayload, { entityType: MRF_ENTITY, entityId: mrf._id })
      : res.json(matchedPayload);
  } catch (e) {
    /* A structured refusal (forbidden, wrong tenant, invalid transition,
       idempotency conflict) must reach the client as itself, not as a
       generic 500 the browser cannot reason about. */
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    console.error("[Match MRF item]", e);
    res.status(500).json({ success: false, message: e.message });
  }
},
);

/**
 * PATCH /:id/items/:itemId/register — nothing in the catalogue matches; add
 * it as a new RawItem from what the requester described (name/category/
 * attributes, carried on the item since it was raised) and link this same
 * item to it.
 */
router.patch(
  "/:id/items/:itemId/register",
  requireCapability(CAPABILITIES.MRF_FULFIL),
  refuseLegacyWrite,
  withIdempotency("MRF_REGISTER"),
  async (req, res) => {
  try {
    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) });
    if (!mrf) return res.status(404).json({ success: false, message: "Request not found" });
    /* The authority matrix: relationship authority for the requester and
       the assigned approver, capability authority for the store. A
       request this caller may not even see is answered as missing. */
    await may(req, "REGISTER", mrf);
    if (!isStoreActionable(mrf)) {
      return res.status(403).json({ success: false, message: "This request has not been approved yet." });
    }

    const item = mrf.items.id(req.params.itemId);
    if (!item) return res.status(404).json({ success: false, message: "Item not found on this request" });
    if (item.itemStatus !== "UNMATCHED") {
      return res.status(400).json({ success: false, message: `Cannot register — this item's status is ${item.itemStatus}` });
    }

    let variants = [];
    if (item.attributes && item.attributes.length > 0) {
      const combos = cartesianProduct(item.attributes.map(a => a.values));
      variants = combos.map(combo => ({
        combination: combo.map((val, idx) => ({ attribute: item.attributes[idx].name, value: val })),
        quantity: 0,
        status: "Out of Stock",
        sku: `${item.rawItemName.substring(0, 3)}-${combo.join('-')}`.toUpperCase(),
      }));
    }

    const newRawItem = new RawItem({
      name: item.rawItemName,
      category: item.category || "",
      unit: item.unit || "unit",
      customUnit: item.unit || "unit",
      quantity: 0,
      status: "Out of Stock",
      variants,
      sku: `${item.rawItemName.substring(0, 4)}-${Date.now()}`.toUpperCase(),
      minStock: 0,
    });
    await newRawItem.save();

    item.rawItem = newRawItem._id;
    item.rawItemSku = newRawItem.sku;
    item.baseUnit = newRawItem.customUnit || newRawItem.unit;
    item.itemStatus = "APPROVED";
    item.category = "";
    item.attributes = [];

    mrf.logEvent({
      action: "ITEM_REGISTERED", actorName: actorName(req), actorRole: "store",
      detail: `"${item.rawItemName}" registered as a new inventory item — ready to issue.`,
    });
    await commitMrf(req, mrf, {
      action: "ITEM_REGISTERED",
      previousState: mrf.status, resultingState: mrf.status,
      changes: [{ field: item.rawItemName, from: null, to: "registered in catalogue" }],
      metadata: { itemId: String(item._id) },
    });

    NotificationService.sendToUser(mrf.requestedFor, {
      title: "Item Added to Inventory",
      body: `"${item.rawItemName}" was added to inventory for your request ${mrf.mrfNumber} — ready to be issued.`,
      type: "request",
      url: "/coworking/mrf",
      tag: `mrf-item-registered-${mrf._id}-${item._id}`,
    }).catch(() => { });

    const registeredPayload = { success: true, message: "Item added to inventory", mrf, rawItem: newRawItem };
    return req.idempotent
      ? await req.idempotent.succeed(200, registeredPayload, { entityType: MRF_ENTITY, entityId: mrf._id })
      : res.json(registeredPayload);
  } catch (e) {
    /* A structured refusal (forbidden, wrong tenant, invalid transition,
       idempotency conflict) must reach the client as itself, not as a
       generic 500 the browser cannot reason about. */
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    console.error("[Register MRF item]", e);
    res.status(500).json({ success: false, message: e.message });
  }
},
);

/** PATCH /:id/items/:itemId/reject — the store can't supply this still-unmatched line at all. */
router.patch(
  "/:id/items/:itemId/reject",
  requireCapability(CAPABILITIES.MRF_FULFIL),
  refuseLegacyWrite,
  withIdempotency("MRF_LINE_REJECT"),
  async (req, res) => {
  try {
    const { note } = req.body;
    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) });
    if (!mrf) return res.status(404).json({ success: false, message: "Request not found" });
    /* The authority matrix: relationship authority for the requester and
       the assigned approver, capability authority for the store. A
       request this caller may not even see is answered as missing. */
    await may(req, "MATCH", mrf);
    if (!isStoreActionable(mrf)) {
      return res.status(403).json({ success: false, message: "This request has not been approved yet." });
    }

    const item = mrf.items.id(req.params.itemId);
    if (!item) return res.status(404).json({ success: false, message: "Item not found on this request" });
    if (item.itemStatus !== "UNMATCHED") {
      return res.status(400).json({ success: false, message: `Cannot reject — this item's status is ${item.itemStatus}` });
    }

    item.itemStatus = "REJECTED";
    item.storeNotes = note || "";

    mrf.logEvent({
      action: "ITEM_REJECTED", actorName: actorName(req), actorRole: "store",
      detail: `"${item.rawItemName}" rejected${note ? `: ${note}` : "."}`,
    });
    await commitMrf(req, mrf, {
      action: "ITEM_REJECTED", reason: note || "",
      previousState: mrf.status, resultingState: mrf.status,
      changes: [{ field: item.rawItemName, from: null, to: "REJECTED" }],
      metadata: { itemId: String(item._id) },
    });

    NotificationService.sendToUser(mrf.requestedFor, {
      title: "Item Rejected",
      body: note ? `Reason: ${note}` : `"${item.rawItemName}" on your request ${mrf.mrfNumber} was rejected by the Store.`,
      type: "request",
      url: "/coworking/mrf",
      tag: `mrf-item-rejected-${mrf._id}-${item._id}`,
    }).catch(() => { });

    const rejectedItemPayload = { success: true, message: "Item rejected", mrf };
    return req.idempotent
      ? await req.idempotent.succeed(200, rejectedItemPayload, { entityType: MRF_ENTITY, entityId: mrf._id })
      : res.json(rejectedItemPayload);
  } catch (e) {
    /* A structured refusal (forbidden, wrong tenant, invalid transition,
       idempotency conflict) must reach the client as itself, not as a
       generic 500 the browser cannot reason about. */
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    console.error("[Reject MRF item]", e);
    res.status(500).json({ success: false, message: e.message });
  }
},
);

// ── GET /:id ──────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) })
      .populate("requestedFor", "firstName middleName lastName biometricId identityId name department email designation")
      .populate("approvedBy", "firstName lastName name")
      .populate("rejectedBy", "firstName lastName name")
      .lean();
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    /* Reading a request is an authority question too: relationship
       authority for the requester and the assigned approver, capability
       authority for the store. Gating only the mutations left detail,
       stock-check, chat and budget-head readable by any colleague in
       the company. Unviewable is answered as missing. */
    await may(req, "VIEW", mrf);
    if (mrf.requestedFor && typeof mrf.requestedFor === "object")
      mrf.requestedFor._fullName = buildFullName(mrf.requestedFor);
    markOverdue([mrf]);
    res.json({
      success: true,
      mrf,
      context: buildContext(mrf, "store"),
      storeActionable: isStoreActionable(mrf),
    });
  } catch (e) {
    /* A structured refusal (forbidden, wrong tenant) must reach the
       client as itself, not as a generic 500. */
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST / — employee creates own MRF ────────────────────────────────────────
router.post(
  "/",
  refuseLegacyWrite,
  withIdempotency("MRF_CREATE"),
  async (req, res) => {
  try {
    const { requestType, deadline, reason = "", priority = "NORMAL", costCentre = "", projectReference = "", items } = req.body;
    if (!["TIME_BASED", "USES_BASED"].includes(requestType))
      return res.status(400).json({ success: false, message: "Invalid requestType" });
    if (requestType === "TIME_BASED" && !deadline)
      return res.status(400).json({ success: false, message: "Deadline required for TIME_BASED" });
    if (!items?.length)
      return res.status(400).json({ success: false, message: "At least one item required" });

    const builtItems = await buildMrfItems(items);
    if (!builtItems.length)
      return res.status(400).json({ success: false, message: "No valid items found" });

    const actorId = getActorId(req);
    const employee = await Employee.findOne({
      $or: [{ _id: actorId }, { biometricId: req.user.id }, { identityId: req.user.id }]
    }).select("firstName middleName lastName name biometricId identityId department").lean();

    const fullName = buildFullName(employee) || req.user.name || "";
    const biometricId = employee?.biometricId || employee?.identityId || "";

    // Same routing as the cowork side: Employee → Primary Manager/TL → Store,
    // falling through to the Store when no TL can be resolved.
    const { patch: approver } = await approverPatchFor(employee?._id || actorId);
    const autoForward = approver.approvalRoute === "AUTO_STORE";

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
      });
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
      requestedFor: employee?._id || actorId,
      requestedForName: fullName,
      requestedForDept: employee?.department || "",
      requestedForId: biometricId,
      creationMode: "SELF",
      createdByRef: employee?._id || actorId,
      createdByModel: "Employee",
      createdByName: fullName,
      requestType,
      deadline: requestType === "TIME_BASED" ? new Date(deadline) : null,
      reason, priority, costCentre, projectReference,
      ...approver,
      status: autoForward ? "APPROVED" : "PENDING",
      items: autoForward
        ? builtItems.map(i => ({ ...i, itemStatus: "APPROVED" }))
        : builtItems,
      ...(autoForward ? { approvedAt: new Date() } : {}),
    });
    mrf.logEvent({
      action: "CREATED", actorName: fullName, actorRole: "employee",
      detail: autoForward ? approver.autoForwardReason : `Submitted for approval by ${approver.approverName}.`,
    });
    /* The request and the record that it was created land together, so a
       failure after the save cannot leave a request nothing accounts for. */
    await commitMrf(req, mrf, {
      action: "CREATED",
      previousState: null,
      resultingState: mrf.status,
      metadata: { itemCount: builtItems.length, autoForwarded: Boolean(autoForward) },
    });

    // Only once the creation is authoritative.
    if (autoForward) mrfNotify.autoForwarded(mrf).catch(() => { });
    else mrfNotify.submitted(mrf).catch(() => { });

    const createdPayload = {
      success: true,
      message: autoForward
        ? approver.autoForwardReason
        : `${mrf.mrfNumber} submitted — waiting for approval from ${approver.approverName}.`,
      mrf,
    };
    return req.idempotent
      ? await req.idempotent.succeed(201, createdPayload, { entityType: MRF_ENTITY, entityId: mrf._id })
      : res.status(201).json(createdPayload);
  } catch (e) { console.error("[MRF POST /]", e); res.status(500).json({ success: false, message: e.message }); }
},
);

// ── POST /bypass ──────────────────────────────────────────────────────────────
// Frontend sends: { employeeMongoId, requestType, deadline?, reason, priority?, items }
router.post(
  "/bypass",
  requireCapability(CAPABILITIES.MRF_FULFIL),
  refuseLegacyWrite,
  withIdempotency("MRF_BYPASS_CREATE"),
  async (req, res) => {
  try {
    const {
      employeeMongoId,   // ← frontend sends this (MongoDB _id of the employee)
      requestType, deadline, reason = "",
      priority = "NORMAL", costCentre = "", projectReference = "", items,
    } = req.body;

    if (!employeeMongoId)
      return res.status(400).json({ success: false, message: "employeeMongoId is required" });
    if (!["TIME_BASED", "USES_BASED"].includes(requestType))
      return res.status(400).json({ success: false, message: "Invalid requestType" });
    if (requestType === "TIME_BASED" && !deadline)
      return res.status(400).json({ success: false, message: "Deadline required for TIME_BASED" });
    if (!items?.length)
      return res.status(400).json({ success: false, message: "At least one item required" });

    const employee = await Employee.findById(employeeMongoId)
      .select("firstName middleName lastName name biometricId identityId email department designation").lean();
    if (!employee)
      return res.status(404).json({ success: false, message: "Employee not found" });

    const builtItems = await buildMrfItems(items);
    if (!builtItems.length)
      return res.status(400).json({ success: false, message: "No valid items found" });

    const actorId = getActorId(req);
    const empFullName = buildFullName(employee);
    const biometricId = employee.biometricId || employee.identityId || "";

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
      });
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
      requestedFor: employee._id,
      requestedForName: empFullName,
      requestedForDept: employee.department || "",
      requestedForId: biometricId,
      creationMode: "BYPASS",
      createdByRef: actorId,           // ← PM's ObjectId, not a string
      createdByModel: "ProjectManager",
      createdByName: req.user.name || "",
      requestType,
      deadline: requestType === "TIME_BASED" ? new Date(deadline) : null,
      reason, priority, costCentre, projectReference,
      // A bypass MRF is raised by the store, standing in front of the
      // employee — there is no TL step to wait for.
      approverResolution: "RESOLVED",
      approvalRoute: "AUTO_STORE",
      autoForwarded: true,
      autoForwardReason: `Raised on behalf of ${empFullName} by the Store — no TL approval step applies.`,
      status: "APPROVED",
      items: builtItems.map(i => ({ ...i, itemStatus: "APPROVED" })),
      approvedBy: actorId,
      approvedAt: new Date(),
      storeNotes: `Bypass MRF raised by ${req.user.name || "Store"}`,
    });
    mrf.logEvent({
      action: "CREATED", actorName: actorName(req), actorRole: "store",
      detail: `Raised on behalf of ${empFullName} — no TL approval required.`,
    });
    await commitMrf(req, mrf, {
      action: "CREATED",
      previousState: null,
      resultingState: mrf.status,
      metadata: { itemCount: builtItems.length, onBehalfOf: String(employee._id), mode: "BYPASS" },
    });

    // Tell the employee it exists — they did not raise it themselves.
    if (mrf.requestedForId) {
      mrfNotify.notifyCowork({
        recipientIds: [mrf.requestedForId],
        type: "request",
        tag: `mrf-bypass-${mrf._id}`,
        title: "Material request raised for you",
        body: `${mrf.mrfNumber}: the Store raised a material request on your behalf for ${builtItems.length} item(s).`,
        data: { mrfId: String(mrf._id), mrfNumber: mrf.mrfNumber, url: "/coworking/mrf" },
      }).catch(() => { });
    }

    const bypassPayload = {
      success: true,
      message: "On-behalf MRF created and approved — ready to issue.",
      mrf,
    };
    return req.idempotent
      ? await req.idempotent.succeed(201, bypassPayload, { entityType: MRF_ENTITY, entityId: mrf._id })
      : res.status(201).json(bypassPayload);
  } catch (e) { console.error("[MRF POST /bypass]", e); res.status(500).json({ success: false, message: e.message }); }
},
);

// ── PATCH /:id/approve — retired ─────────────────────────────────────────────
// Approval moved to the requester's Primary Manager/TL in cowork. Kept as an
// explicit 403 rather than deleted so any stale client gets told why instead
// of a confusing 404.
router.patch("/:id/approve", (req, res) => {
  res.status(403).json({
    success: false,
    message: "MRFs are approved by the requester's Primary Manager/TL in CoWork. The store records availability and issues material — it does not approve.",
  });
});

// ── PATCH /:id/reject — retired ──────────────────────────────────────────────
router.patch("/:id/reject", (req, res) => {
  res.status(403).json({
    success: false,
    message: "Only the requester's Primary Manager/TL can reject an MRF. If the material cannot be supplied, use 'Cannot Fulfil' instead so the requester sees the correct reason.",
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /:id/availability — the store's core action
//
// Records what the store actually found, per item:
//   AVAILABLE | PARTIAL | NOT_AVAILABLE | ALTERNATIVE
// This is independent of issuance — it is how the requester and TL learn
// whether their material exists before anything is handed over.
//
// Body: { items: [{ itemId, availability, availableQty?, note?,
//                   alternativeName?, alternativeRawItemId? }], storeNotes? }
// ═══════════════════════════════════════════════════════════════════════════
const AVAILABILITY_VALUES = ["AVAILABLE", "PARTIAL", "NOT_AVAILABLE", "ALTERNATIVE"];

router.patch(
  "/:id/availability",
  requireCapability(CAPABILITIES.MRF_FULFIL),
  refuseLegacyWrite,
  withIdempotency("MRF_AVAILABILITY"),
  async (req, res) => {
  try {
    const { items = [], storeNotes } = req.body;
    if (!Array.isArray(items) || !items.length)
      return res.status(400).json({ success: false, message: "No availability updates supplied" });

    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) });
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    /* The authority matrix: relationship authority for the requester and
       the assigned approver, capability authority for the store. A
       request this caller may not even see is answered as missing. */
    await may(req, "AVAILABILITY", mrf);

    if (!isStoreActionable(mrf))
      return res.status(403).json({
        success: false,
        message: `This request has not been approved yet — it is still with ${mrf.approverName || "the requester's Primary Manager/TL"}.`,
      });
    if (["REJECTED", "CANCELLED"].includes(mrf.status))
      return res.status(400).json({ success: false, message: `Cannot update — this request is ${mrf.status.toLowerCase()}.` });

    const who = actorName(req);
    const summary = [];

    for (const line of items) {
      const item = mrf.items.id(line.itemId);
      if (!item) continue;
      if (["REJECTED", "UNFULFILLED"].includes(item.itemStatus)) continue;

      const availability = String(line.availability || "").toUpperCase();
      if (!AVAILABILITY_VALUES.includes(availability))
        return res.status(400).json({
          success: false,
          message: `Invalid availability "${line.availability}" — expected one of ${AVAILABILITY_VALUES.join(", ")}.`,
        });

      const remaining = Math.max(0, (item.requestedQty || 0) - (item.issuedQty || 0));

      // availableQty is always in the requester's unit — the same unit the
      // store person is looking at on screen.
      let availableQty;
      if (availability === "AVAILABLE") availableQty = remaining;
      else if (availability === "NOT_AVAILABLE") availableQty = 0;
      else if (availability === "PARTIAL") {
        availableQty = parseFloat(line.availableQty);
        if (!Number.isFinite(availableQty) || availableQty <= 0)
          return res.status(400).json({
            success: false,
            message: `Enter how much of "${item.rawItemName}" is available — a partial quantity must be greater than zero.`,
          });
        if (availableQty >= remaining) {
          // "Partial" that covers the whole remainder is just available.
          availableQty = remaining;
        }
      } else {
        availableQty = line.availableQty === undefined || line.availableQty === null
          ? null : parseFloat(line.availableQty);
      }

      const finalAvailability =
        availability === "PARTIAL" && availableQty >= remaining ? "AVAILABLE" : availability;

      if (finalAvailability === "ALTERNATIVE" && !String(line.alternativeName || "").trim())
        return res.status(400).json({
          success: false,
          message: `Name the alternative product you are offering for "${item.rawItemName}".`,
        });

      item.availability = finalAvailability;
      item.availableQty = availableQty;
      item.availabilityNote = String(line.note || "").trim().slice(0, 500);
      item.availabilityUpdatedAt = new Date();
      item.availabilityUpdatedBy = getActorId(req);
      item.availabilityUpdatedByName = who;
      item.alternativeItem = finalAvailability === "ALTERNATIVE"
        ? {
          rawItem: line.alternativeRawItemId || null,
          name: String(line.alternativeName || "").trim(),
          note: String(line.alternativeNote || "").trim().slice(0, 500),
        }
        : { rawItem: null, name: "", note: "" };

      summary.push({
        itemId: String(item._id),
        name: item.rawItemName,
        unit: item.unit,
        availability: finalAvailability,
        requested: item.requestedQty,
        available: availableQty,
        note: item.availabilityNote,
        alternativeName: item.alternativeItem?.name || "",
      });
    }

    if (!summary.length)
      return res.status(400).json({ success: false, message: "None of the supplied items are on this request." });

    if (storeNotes !== undefined) mrf.storeNotes = String(storeNotes || "").trim();
    if (!mrf.storeReviewedAt) mrf.storeReviewedAt = new Date();

    const detail = summary
      .map(s => `${s.name}: ${s.availability.replace(/_/g, " ").toLowerCase()}${s.availability === "PARTIAL" ? ` (${s.available} of ${s.requested} ${s.unit})` : ""}`)
      .join("; ");
    mrf.logEvent({ action: "AVAILABILITY_UPDATED", actorName: who, actorRole: "store", detail });

    await commitMrf(req, mrf, {
      action: "AVAILABILITY_UPDATED",
      previousState: mrf.status, resultingState: mrf.status,
      changes: summary.map((x) => ({ field: x.name, from: null, to: x.availability })),
      metadata: { lineCount: summary.length },
    });

    await noteInThread(req, mrf, `Store availability update — ${detail}`, who);
    mrfNotify.availabilityUpdated(mrf, summary).catch(e => console.error("[availability notify]", e.message));

    const obj = mrf.toObject();
    const availabilityPayload = {
      success: true,
      message: "Availability recorded — the requester and their TL have been notified.",
      mrf: obj,
      summary,
      context: buildContext(obj, "store"),
    };
    return req.idempotent
      ? await req.idempotent.succeed(200, availabilityPayload, { entityType: MRF_ENTITY, entityId: mrf._id })
      : res.json(availabilityPayload);
  } catch (e) {
    /* A structured refusal (forbidden, wrong tenant, invalid transition,
       idempotency conflict) must reach the client as itself, not as a
       generic 500 the browser cannot reason about. */
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    console.error("[MRF availability]", e);
    res.status(500).json({ success: false, message: e.message });
  }
},
);

// ═══════════════════════════════════════════════════════════════════════════
// POST /:id/unfulfilled — close an approved request the store cannot supply.
//
// Deliberately NOT called "reject": rejection means the TL said no. This means
// the TL said yes and the material does not exist. The requester sees two
// different messages because they need to do two different things.
// ═══════════════════════════════════════════════════════════════════════════
router.post(
  "/:id/unfulfilled",
  requireCapability(CAPABILITIES.MRF_FULFIL),
  refuseLegacyWrite,
  withIdempotency("MRF_UNFULFILLED"),
  async (req, res) => {
  try {
    const reason = String(req.body.reason || "").trim();
    if (!reason)
      return res.status(400).json({
        success: false,
        message: "A reason is required — the requester and their TL both see it.",
      });

    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) });
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    /* The authority matrix: relationship authority for the requester and
       the assigned approver, capability authority for the store. A
       request this caller may not even see is answered as missing. */
    await may(req, "UNFULFILLED", mrf);

    if (!isStoreActionable(mrf))
      return res.status(403).json({ success: false, message: "This request has not been approved yet." });
    if (["REJECTED", "CANCELLED", "UNFULFILLED", "COMPLETED"].includes(mrf.status))
      return res.status(400).json({ success: false, message: `This request is already ${mrf.status.toLowerCase()}.` });

    /* Captured before the close mutates it — read afterwards, the history
       row would claim the request was already UNFULFILLED. */
    const stateBeforeUnfulfilled = mrf.status;
    const anyIssued = mrf.items.some(i => (i.issuedQty || 0) > 0);
    const who = actorName(req);

    mrf.items.forEach(i => {
      // Anything already handed over keeps its issued state; only what is
      // still owed becomes unfulfillable.
      if ((i.issuedQty || 0) > 0) return;
      if (i.itemStatus === "REJECTED") return;
      i.itemStatus = "UNFULFILLED";
      if (i.availability === "UNREVIEWED") i.availability = "NOT_AVAILABLE";
    });

    // If some material already went out, the request is partially issued and
    // closed — not wholly unfulfilled.
    mrf.status = anyIssued ? "PARTIALLY_ISSUED" : "UNFULFILLED";
    mrf.unfulfilledAt = new Date();
    mrf.unfulfilledBy = getActorId(req);
    mrf.unfulfilledByName = who;
    mrf.unfulfilledReason = reason;
    if (!mrf.storeReviewedAt) mrf.storeReviewedAt = new Date();

    mrf.logEvent({
      action: "STORE_UNFULFILLED", actorName: who, actorRole: "store",
      detail: anyIssued ? `Remaining quantity cannot be supplied. ${reason}` : reason,
    });
    await commitMrf(req, mrf, {
      action: "STORE_UNFULFILLED", reason,
      previousState: stateBeforeUnfulfilled, resultingState: mrf.status,
      metadata: { partial: Boolean(anyIssued) },
    });

    await noteInThread(req, mrf, `The Store cannot supply ${anyIssued ? "the remaining quantity" : "this request"}. Reason: ${reason}`, who);
    mrfNotify.unfulfilled(mrf).catch(e => console.error("[unfulfilled notify]", e.message));

    const obj = mrf.toObject();
    const unfulfilledPayload = {
      success: true,
      message: "Request closed as unfulfillable — the requester and their TL have been notified.",
      mrf: obj,
      context: buildContext(obj, "store"),
    };
    return req.idempotent
      ? await req.idempotent.succeed(200, unfulfilledPayload, { entityType: MRF_ENTITY, entityId: mrf._id })
      : res.json(unfulfilledPayload);
  } catch (e) {
    /* A structured refusal (forbidden, wrong tenant, invalid transition,
       idempotency conflict) must reach the client as itself, not as a
       generic 500 the browser cannot reason about. */
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    console.error("[MRF unfulfilled]", e);
    res.status(500).json({ success: false, message: e.message });
  }
},
);

// ── PATCH /:id/cancel ─────────────────────────────────────────────────────────
router.patch(
  "/:id/cancel",
  refuseLegacyWrite,
  withIdempotency("MRF_CANCEL"),
  async (req, res) => {
  try {
    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) });
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    /* The authority matrix: relationship authority for the requester and
       the assigned approver, capability authority for the store. A
       request this caller may not even see is answered as missing. */
    await may(req, "CANCEL", mrf);
    if (!["PENDING", "APPROVED"].includes(mrf.status))
      return res.status(400).json({ success: false, message: "Only PENDING or APPROVED MRFs can be cancelled" });

    /* Captured before the cancellation mutates it. */
    const stateBeforeCancel = mrf.status;

    mrf.status = "CANCELLED";
    mrf.cancelledBy = getActorId(req);
    mrf.cancelledByModel = req.user.role === "employee" ? "Employee" : "ProjectManager";
    mrf.cancelledAt = new Date();
    mrf.cancellationNote = req.body.cancellationNote || "";
    mrf.items.forEach(i => { if (i.itemStatus !== "ISSUED") i.itemStatus = "REJECTED"; });
    await commitMrf(req, mrf, {
      action: "CANCELLED",
      reason: mrf.cancellationNote || "",
      previousState: stateBeforeCancel,
      resultingState: mrf.status,
    });
    const cancelledPayload = { success: true, message: "MRF cancelled", mrf };
    return req.idempotent
      ? await req.idempotent.succeed(200, cancelledPayload, { entityType: MRF_ENTITY, entityId: mrf._id })
      : res.json(cancelledPayload);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
},
);

// ── POST /:id/issue ───────────────────────────────────────────────────────────
// ── GET /:id/budget-head ─────────────────────────────────────────────────────
//
// What the head this request is charged to has left on it, right now.
//
// ── WHY THIS IS ITS OWN ROUTE ───────────────────────────────────────────────
// Store is about to decide whether to spend a department's money, and
// "Consumables" on its own does not tell them whether that is a comfortable
// decision. The MRF carries WHICH head — the requester's manager chose it —
// but not what is left on it, and a figure snapshotted at approval time would
// be weeks stale by the time the store person reads it.
//
// Additive: nothing else's response changed, so no existing screen has to know
// this exists. READ-ONLY, and deliberately so — Store may see the envelope and
// may not choose it. The head is the manager's decision and stays theirs.
//
// Scoped to the REQUESTER's department, never the store person's. A store
// employee looking at a Tech request is looking at Tech's envelope, and
// answering with Store's would be the wrong number presented confidently.
router.get("/:id/budget-head", async (req, res) => {
  try {
    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) })
      .select("budgetLedgerId budgetLedgerName budgetFinancialYear budgetDepartment budgetHeadRequested requestedForDept companyId siteId status requestedFor requestedForId approverEmployee approverBiometricId approverAltIds")
      .lean();
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    /* Reading a request is an authority question too: relationship
       authority for the requester and the assigned approver, capability
       authority for the store. Gating only the mutations left detail,
       stock-check, chat and budget-head readable by any colleague in
       the company. Unviewable is answered as missing. */
    await may(req, "VIEW", mrf);

    if (!mrf.budgetLedgerId) {
      return res.json({
        success: true,
        head: null,
        /* A head the department ASKED for is a real decision, not a gap — it
           simply has no envelope behind it yet. Said plainly so the screen can
           tell the two apart. */
        requestedHeadName: mrf.budgetHeadRequested ? mrf.budgetLedgerName || null : null,
        message: mrf.budgetHeadRequested
          ? "A new head was requested for this — finance decides the envelope."
          : "No budget head was set on this request.",
      });
    }

    /* The books this request belongs to — the request says so. Scanning for
       "the only company" refused to answer at all in a multi-company
       deployment, and answered from the wrong company's budget when it did. */
    const booksCompanyId = mrf.companyId || req.tenant?.companyId;
    if (!booksCompanyId) {
      return res.json({ success: true, head: null, message: "The books are not configured for this yet." });
    }

    const budgetMatch = require("../../../../services/budgetCommitment.service");
    const { heads } = await budgetMatch.approvedHeadsFor({
      companyId: booksCompanyId,
      department: mrf.budgetDepartment || mrf.requestedForDept || "",
    });
    const head = heads.find((h) => String(h.ledgerId) === String(mrf.budgetLedgerId)) || null;

    res.json({
      success: true,
      head: head
        ? {
            ledgerId: head.ledgerId,
            ledgerName: head.name,
            financialYear: head.financialYear,
            department: head.department,
            approved: head.approved,
            committed: head.committed,
            actual: head.actual,
            available: head.available,
          }
        : null,
      /* The head was chosen and has since been withdrawn from the department's
         budget. Not a gap and not an envelope — a thing to say out loud. */
      message: head
        ? null
        : `"${mrf.budgetLedgerName || "That head"}" is no longer in this department's approved budget.`,
    });
  } catch (e) {
    /* A structured refusal (forbidden, wrong tenant, invalid transition,
       idempotency conflict) must reach the client as itself, not as a
       generic 500 the browser cannot reason about. */
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    console.error("[MRF budget-head]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /:id/fulfilment-decision ────────────────────────────────────────────
//
// CAN WE GIVE THEM THIS, OR DO WE HAVE TO BUY IT?
//
// The step between the TL agreeing a department needs something and finance
// agreeing to pay for it. A request does not reach finance because it exists —
// it reaches finance because money has to be spent, and the only people who
// can see the shelf are the ones who know whether that is true.
//
// Three answers, and only two of them cost anything:
//
//   issue_from_stock     stock moves. No spend request, no budget commitment,
//                        no finance step. Issuing what the company already
//                        owns spends nothing.
//   partial_buy_balance  what is on the shelf is issued; ONLY the shortfall is
//                        priced and sent on.
//   buy_or_service       priced and sent on whole.
//
// ── WHAT THE STORE OWNS, AND WHAT IT DOES NOT ───────────────────────────────
// Store owns pricing and sourcing: vendor, rate, tax, delivery date. It does
// NOT own the budget head — that was chosen by the requester's own manager,
// who holds the department's envelope, and it is carried here read-only. A
// request that arrived without one cannot become a purchase; it goes back.
//
// ── AND WHAT THIS DOES NOT DO ───────────────────────────────────────────────
// It does not commit budget. The spend request it creates goes to finance at
// `pending_finance`, and the commitment is made when FINANCE says yes — see
// budgetCommitment.service. Nothing here reserves money, and the stock half
// never touches a budget at all.
router.post(
  "/:id/fulfilment-decision",
  requireCapability(CAPABILITIES.MRF_FULFIL),
  refuseLegacyWrite,
  withIdempotency("MRF_FULFILMENT_DECISION"),
  async (req, res) => {
  try {
    const b = req.body || {};
    const decision = String(b.decision || "").toLowerCase();

    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) });
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    /* The authority matrix: relationship authority for the requester and
       the assigned approver, capability authority for the store. A
       request this caller may not even see is answered as missing. */
    await may(req, "FULFILMENT_DECISION", mrf);

    /* ── AN INTERRUPTED DECISION IS NOT RE-RUN ─────────────────────────────
     * This route moves stock too — `applyIssue` below is the same function
     * the Issue button calls. Without this branch, an attempt that deducted
     * stock and then failed would, once its claim went stale, be re-run by a
     * retry and deduct a second time. */
    if (req.idempotent?.recovering) {
      const issuedAlready = (mrf.items || []).some((i) => (i.issuedQty || 0) > 0);
      await unitOfWork.recover(req.tenant, {
        entityType: MRF_ENTITY,
        entityId: mrf._id,
        idempotencyKey: req.idempotent.key,
        entry: {
          documentNumber: mrf.mrfNumber,
          action: issuedAlready ? "STORE_FULFILMENT_DECISION" : "FULFILMENT_RECONCILIATION_REQUIRED",
          resultingState: mrf.status,
          requestId: req.id || "",
          idempotencyKey: req.idempotent.key,
          reason: issuedAlready ? "" : "Stock moved but the request did not record the decision.",
          metadata: { recovered: true },
        },
      });
      if (!issuedAlready) {
        throw fail(
          "LIFECYCLE_BLOCKED",
          "This fulfilment decision was interrupted after the stock moved but before the request recorded it. Check the item's stock and correct the request — do not decide again.",
          { reason: "PARTIAL_FULFILMENT_NEEDS_RECONCILIATION", mrfNumber: mrf.mrfNumber },
        );
      }
      return await req.idempotent.succeed(200, {
        success: true,
        message: "This decision was already recorded.",
        mrf: mrf.toObject(),
      }, { entityType: MRF_ENTITY, entityId: mrf._id });
    }

    if (!isStoreActionable(mrf)) {
      return res.status(403).json({
        success: false,
        message: `This request has not been approved yet — it is still with ${mrf.approverName || "the requester's Primary Manager/TL"}.`,
      });
    }
    if (!["APPROVED", "PARTIALLY_ISSUED"].includes(mrf.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot decide fulfilment — this request is ${String(mrf.status).toLowerCase()}.`,
      });
    }

    /* Live stock, in the requester's own unit — the same figure the store
       person was looking at. Read now rather than trusted from the page: the
       shelf may have moved since it loaded. A line with no catalogue item has
       no stock figure at all, which is `null` and not zero. */
    const enriched = await mrfUnits.enrichItemsWithStock(mrf.items.map((i) => i.toObject()));
    const availableByItem = new Map();
    mrf.items.forEach((item, i) => {
      const live = enriched[i];
      availableByItem.set(
        String(item._id),
        live && live.available !== undefined ? live.available : null,
      );
    });

    const plan = fulfilment.planFor({
      decision,
      items: mrf.items.map((i) => i.toObject()),
      plan: Array.isArray(b.lines) ? b.lines : [],
      availableByItem,
    });
    if (!plan.ok) return res.status(400).json({ success: false, message: plan.reason });

    const who = actorName(req);
    const actorId = getActorId(req);
    const now = new Date();
    /* Captured before the decision moves anything. */
    const stateBeforeDecision = mrf.status;

    /* ── THE HALF THAT COMES OFF THE SHELF ────────────────────────────── */
    const planned = plan.lines
      .filter((l) => l.issueQty > 0)
      .map((l) => ({ mrfItem: mrf.items.id(l.itemId), issueQty: l.issueQty }))
      .filter((x) => x.mrfItem)
      .map((x) => ({ mrfItem: x.mrfItem, issuedQty: x.issueQty, notes: "" }));

    /* Every line has to be matched to a catalogue item before its stock can
       move — the same rule the Issue button enforces, checked before anything
       is written so a refusal leaves nothing half-done. */
    const unmatched = planned.filter((x) => !x.mrfItem.rawItem);
    if (unmatched.length) {
      return res.status(400).json({
        success: false,
        message: `"${unmatched[0].mrfItem.rawItemName}" isn't matched to a catalogue item yet — match or register it before issuing.`,
      });
    }

    let issuedLines = [];
    if (planned.length) {
      /* Before the first deduction, for the reason given on the Issue route:
         the marker is what makes the stock movement at-most-once. */
      if (req.idempotent?.record) {
        await idempotencyService.markEffectApplied({
          record: req.idempotent.record, entityType: MRF_ENTITY, entityId: mrf._id,
        });
      }
      issuedLines = await applyIssue({ mrf, planned, actorId, storeNotes: "" });
    }

    /* ── THE HALF THAT HAS TO BE BOUGHT ───────────────────────────────── */
    let spend = null;
    const buying = plan.lines.filter((l) => l.buyQty > 0);

    if (fulfilment.needsPurchase(decision)) {
      const missingRate = buying.find((l) => !(l.rate > 0));
      if (missingRate) {
        return res.status(400).json({
          success: false,
          message: `"${missingRate.name}" is being bought but has no rate. Finance approves a figure, so it needs one.`,
        });
      }

      const vendorName = String(b.vendorName || "").trim();
      const price = fulfilment.priceFor({ lines: buying, gstPercent: b.gstPercent });

      /* The budget head is the requester's manager's decision, carried. Store
         does not choose it and cannot override it — a head picked by the
         person who knows the shelf rather than the envelope is exactly the
         mistake the head moved up a level to prevent. */
      if (!mrf.budgetLedgerId && !mrf.budgetHeadRequested) {
        return res.status(400).json({
          success: false,
          message:
            "No budget head was set on this request, so it cannot become a purchase. " +
            "Send it back to the requester's manager to choose one.",
        });
      }

      /* ── THE BOOKS THIS REQUEST BELONGS TO ─────────────────────────────
       * This used to scan for companies and refuse if there was more than
       * one, because a request could not say which set of books it belonged
       * to. It can now: the request carries its company, resolved when it was
       * raised. Reading "the first company" was also how a budget head from
       * one company could be validated against another's books. */
      const { Acc_Ledger } = require("../../../../models/Accountant_model/Acc_MasterModels");
      const booksCompanyId = mrf.companyId || req.tenant?.companyId;
      if (!booksCompanyId) {
        return res.status(409).json({
          success: false,
          message: "This request has no company, so it cannot become a purchase. Ask finance to configure this.",
        });
      }

      const { Acc_Company } = require("../../../../models/Accountant_model/Acc_MasterModels");
      const booksCompany = await Acc_Company.findById(booksCompanyId).select("_id companyName").lean();
      if (!booksCompany) {
        return res.status(409).json({
          success: false,
          message: "This request's company is not set up in the books. Ask finance to create it.",
        });
      }

      const ledger = mrf.budgetLedgerId
        ? await Acc_Ledger.findOne({ _id: mrf.budgetLedgerId, companyId: booksCompanyId })
            .select("_id name").lean()
        : null;
      if (mrf.budgetLedgerId && !ledger) {
        return res.status(400).json({ success: false, message: "That budget head is not in the books." });
      }

      const spendCreate = require("../../../../services/spendRequestCreate.service");
      const requester = await Employee.findById(mrf.requestedFor)
        .select("_id biometricId identityId department").lean();

      const lines = buying.map((l) => ({
        name: l.name,
        /* Every line says why. The request's own purpose stands in where the
           line had nothing of its own — the field is required, and an empty
           one would read as nobody having asked. */
        whyNeeded: l.note || mrf.reason || "Requested material the store cannot supply from stock",
        quantity: l.buyQty,
        unit: l.unit,
        rate: l.rate,
        amount: Math.round(l.buyQty * l.rate * 100) / 100,
      }));

      const created = await spendCreate.createSpendRequest({
        emp: {
          _id: mrf.requestedFor,
          biometricId: requester?.biometricId || mrf.requestedForId,
          identityId: requester?.identityId,
          department: mrf.requestedForDept,
        },
        actorName: mrf.requestedForName || "",
        company: booksCompany,
        title: `${mrf.mrfNumber} — balance to buy`,
        purpose: mrf.reason || "Material the store cannot supply from stock",
        requestType: String(b.requestType || "PRODUCT").toUpperCase() === "SERVICE" ? "SERVICE" : "PRODUCT",
        priority: mrf.priority || "NORMAL",
        neededBy: mrf.neededBy || null,
        vendorName,
        gstin: String(b.gstin || "").trim().toUpperCase(),
        lines,
        totalAmount: price.subtotal,
        ledger,
        asksForNewHead: !mrf.budgetLedgerId && Boolean(mrf.budgetHeadRequested),
        requestedHeadName: mrf.budgetLedgerName || "",
        requestedHeadReason: "Carried from the request the store could not fill from stock",
        /* The manager the MRF was addressed to, carried whole — the approval
           is a record of who was asked, and this request is the same ask. */
        approver: {
          approverEmployee: mrf.approverEmployee || null,
          approverName: mrf.approverName || "",
          approverBiometricId: mrf.approverBiometricId || "",
          approverAltIds: mrf.approverAltIds || [],
          approverResolution: mrf.approverResolution || "RESOLVED",
          approverResolutionNote: "",
        },
        /* Straight to finance. The TL already agreed the department needs it;
           sending it back would be the same person answering twice. */
        startAt: "pending_finance",
        tlApproval: mrf.tlApprovedAt
          ? { by: mrf.tlApprovedBy, byName: mrf.tlApprovedByName, at: mrf.tlApprovedAt }
          : null,
        /* The store's own words travel with it. Finance is deciding on a
           vendor and a price they had no part in choosing, and "only vendor
           who stocks this grade" is most of the case for the figure. */
        historyNote:
          `Raised by ${who} from ${mrf.mrfNumber} — the store could not supply this from stock.` +
          (String(b.note || "").trim() ? ` ${String(b.note).trim().slice(0, 400)}` : ""),
        now,
      });

      spend = created.request;
      /* The commercial detail, stamped after creation so the shared creator
         stays the one place a spend request is built. `pricedAt` is the gate
         finance approval sits behind. */
      spend.gstPercent = price.gstPercent;
      spend.taxAmount = price.taxAmount;
      spend.grandTotal = price.grandTotal;
      spend.expectedDeliveryDate = b.expectedDeliveryDate ? new Date(b.expectedDeliveryDate) : undefined;
      spend.pricedBy = actorId;
      spend.pricedByName = who;
      spend.pricedAt = now;
      spend.sourceMrfId = mrf._id;
      spend.sourceMrfNumber = mrf.mrfNumber;
      await spend.save();

      mrf.spendRequestId = spend._id;
      mrf.spendRequestNumber = spend.requestNumber;
      buying.forEach((l) => {
        const item = mrf.items.id(l.itemId);
        if (item) item.buyQty = l.buyQty;
      });
    }

    /* ── RECORD THE DECISION ──────────────────────────────────────────── */
    mrf.fulfilmentDecision = decision;
    mrf.fulfilmentDecidedAt = now;
    mrf.fulfilmentDecidedBy = actorId;
    mrf.fulfilmentDecidedByName = who;
    mrf.fulfilmentNote = String(b.note || "").trim().slice(0, 500);
    if (!mrf.storeReviewedAt) mrf.storeReviewedAt = now;

    /* Status follows what actually moved, by the same rule the Issue button
       uses. A request whose whole balance went to finance keeps its status —
       nothing has been issued and nothing is settled until the goods arrive. */
    const live = mrf.items.filter((i) => !["REJECTED", "UNFULFILLED"].includes(i.itemStatus));
    const allIssued = live.length > 0 && live.every((i) => i.itemStatus === "ISSUED");
    const someIssued = mrf.items.some((i) => (i.issuedQty || 0) > 0);
    mrf.status = allIssued ? "ISSUED" : someIssued ? "PARTIALLY_ISSUED" : mrf.status;

    const detail =
      fulfilment.DECISION_LABEL[decision] +
      (issuedLines.length
        ? ` — issued ${issuedLines.map((l) => `${l.issuedQty} ${l.unit} of ${l.name}`).join("; ")}`
        : "") +
      (spend ? ` — ${spend.requestNumber} sent to finance` : "");
    mrf.logEvent({ action: "STORE_FULFILMENT_DECISION", actorName: who, actorRole: "store", detail });

    await commitMrf(req, mrf, {
      action: "STORE_FULFILMENT_DECISION",
      previousState: stateBeforeDecision,
      resultingState: mrf.status,
      changes: issuedLines.map((l) => ({ field: l.name, from: null, to: `${l.issuedQty} ${l.unit}` })),
      metadata: {
        decision,
        issuedLines: issuedLines.length,
        spendRequest: spend ? spend.requestNumber : null,
      },
    });

    await noteInThread(req, mrf, detail, who);
    if (issuedLines.length) {
      mrfNotify.issued(mrf, issuedLines).catch((e) => console.error("[fulfilment issue notify]", e.message));
    }

    const obj = mrf.toObject();
    const decisionPayload = {
      success: true,
      message: spend
        ? `${spend.requestNumber} is with finance for ${spend.grandTotal ? `₹${spend.grandTotal}` : "pricing"}.` +
          (issuedLines.length ? " What was on the shelf has been issued." : "")
        : "Issued from stock — nothing to buy, so finance is not involved.",
      mrf: obj,
      issued: issuedLines,
      spendRequest: spend
        ? {
            _id: String(spend._id),
            requestNumber: spend.requestNumber,
            status: spend.status,
            totalAmount: spend.totalAmount,
            gstPercent: spend.gstPercent,
            taxAmount: spend.taxAmount,
            grandTotal: spend.grandTotal,
          }
        : null,
      context: buildContext(obj, "store"),
    };
    return req.idempotent
      ? await req.idempotent.succeed(200, decisionPayload, { entityType: MRF_ENTITY, entityId: mrf._id })
      : res.json(decisionPayload);
  } catch (e) {
    /* A structured refusal (forbidden, wrong tenant, invalid transition,
       idempotency conflict) must reach the client as itself, not as a
       generic 500 the browser cannot reason about. */
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    console.error("[MRF fulfilment-decision]", e);
    res.status(500).json({ success: false, message: e.message });
  }
},
);

/**
 * MOVE THE STOCK. The one place a requester-unit quantity becomes a ledger
 * movement.
 *
 * ── WHY THIS IS A FUNCTION AND NOT TWO COPIES ──────────────────────────────
 * Two things issue material now: the store's Issue button, and the fulfilment
 * decision, which issues what is on the shelf before sending the shortfall to
 * be bought. Both have to convert units the same way, write the same ledger
 * reason, set the same line status and push the same history — and if they
 * ever stopped agreeing, the disagreement would be between the stock ledger
 * and the request, which is the one pair nobody can reconcile after the fact.
 *
 * The CALLER validates: what is owed, whether the line is matched, and whether
 * the shelf can still cover it. This function trusts `planned` and does the
 * moving, because the two callers refuse for different reasons and in
 * different words.
 *
 * Does not save. The caller decides what else changes in the same write.
 */
async function applyIssue({ mrf, planned, actorId, storeNotes = "" }) {
  const issuedLines = [];

  for (const { mrfItem, issuedQty, notes } of planned) {
    // The only place a requester-unit quantity is converted to the
    // catalogue's base unit: the stock ledger.
    const deductQty = await convertQty(issuedQty, mrfItem.unit, mrfItem.baseUnit);
    await adjustStock(
      mrfItem.rawItem, mrfItem.variantId, mrfItem.variantCombination, -deductQty,
      {
        type: mrfItem.variantId ? "VARIANT_REDUCE" : "REDUCE",
        quantity: deductQty,
        reason: `MRF Issue — ${mrf.mrfNumber}`,
        notes: `Issued to ${mrf.requestedForName} (${mrf.requestedForDept}). MRF: ${mrf.mrfNumber}`,
        performedBy: actorId,
      }
    );
    mrfItem.issuedQty += issuedQty;
    mrfItem.consumedQty = mrfItem.issuedQty - mrfItem.returnedQty;
    mrfItem.itemStatus = mrfItem.issuedQty >= mrfItem.requestedQty - 0.001 ? "ISSUED" : "PARTIALLY_ISSUED";
    // Issuing settles the availability question for what just went out.
    if (mrfItem.itemStatus === "ISSUED") mrfItem.availability = "AVAILABLE";
    if (notes) mrfItem.storeNotes = notes;
    mrfItem.issueHistory = mrfItem.issueHistory || [];
    mrfItem.issueHistory.push({
      issuedQty,
      notes: notes || storeNotes || "",
      recordedBy: actorId,
      recordedAt: new Date(),
    });

    issuedLines.push({
      name: mrfItem.rawItemName,
      unit: mrfItem.unit,
      issuedQty,
      remaining: Math.max(0, (mrfItem.requestedQty || 0) - mrfItem.issuedQty),
    });
  }

  return issuedLines;
}

router.post(
  "/:id/issue",
  requireCapability(CAPABILITIES.STOCK_ISSUE),
  refuseLegacyWrite,
  withIdempotency("MRF_ISSUE"),
  async (req, res) => {
  try {
    const { items = [], storeNotes = "" } = req.body;
    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) });
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    /* The authority matrix: relationship authority for the requester and
       the assigned approver, capability authority for the store. A
       request this caller may not even see is answered as missing. */
    await may(req, "ISSUE", mrf);

    /* ── RECOVERY ───────────────────────────────────────────────────────────
     * A previous attempt with this key already moved stock; something after
     * it failed. Re-running would deduct the same material twice, which is
     * the failure the effect marker exists to prevent. */
    if (req.idempotent?.recovering) {
      const issuedAlready = (mrf.items || []).some((i) => (i.issuedQty || 0) > 0);
      await unitOfWork.recover(req.tenant, {
        entityType: MRF_ENTITY,
        entityId: mrf._id,
        idempotencyKey: req.idempotent.key,
        entry: {
          documentNumber: mrf.mrfNumber,
          action: issuedAlready ? "ISSUED" : "ISSUE_RECONCILIATION_REQUIRED",
          resultingState: mrf.status,
          requestId: req.id || "",
          idempotencyKey: req.idempotent.key,
          reason: issuedAlready ? "" : "Stock moved but the request did not record the issue.",
          metadata: { recovered: true },
        },
      });
      if (!issuedAlready) {
        throw fail(
          "LIFECYCLE_BLOCKED",
          "This issue was interrupted after the stock moved but before the request recorded it. Check the item's stock and correct the request — do not issue again.",
          { reason: "PARTIAL_ISSUE_NEEDS_RECONCILIATION", mrfNumber: mrf.mrfNumber },
        );
      }
      const recoveredObj = mrf.toObject();
      return await req.idempotent.succeed(200, {
        success: true,
        message: "This material was already issued.",
        mrf: recoveredObj,
        issued: [],
        context: buildContext(recoveredObj, "store"),
      }, { entityType: MRF_ENTITY, entityId: mrf._id });
    }

    // Approval gate — the requester's Primary Manager/TL must have approved,
    // unless no TL could be resolved (auto-forwarded) or the store raised it.
    if (!isStoreActionable(mrf)) {
      return res.status(403).json({
        success: false,
        message: `Cannot issue — this request is still awaiting approval from ${mrf.approverName || "the requester's Primary Manager/TL"}.`,
      });
    }

    if (mrf.status === "CANCELLED")
      return res.status(400).json({ success: false, message: "This request was cancelled by the requester — do not issue against it." });
    if (!["APPROVED", "PARTIALLY_ISSUED"].includes(mrf.status))
      return res.status(400).json({ success: false, message: `Cannot issue — status is ${mrf.status}` });

    // ── Validate every line before touching stock ──────────────────────────
    // All-or-nothing: a partially applied issue would leave stock and the MRF
    // disagreeing, and two store people issuing at once makes that likely.
    const planned = [];
    for (const line of items) {
      const mrfItem = mrf.items.id(line.itemId);
      if (!mrfItem) continue;
      const issuedQty = parseFloat(line.issuedQty) || 0;
      if (issuedQty <= 0) continue;

      if (["REJECTED", "UNFULFILLED"].includes(mrfItem.itemStatus))
        return res.status(400).json({
          success: false,
          message: `"${mrfItem.rawItemName}" is marked ${mrfItem.itemStatus.toLowerCase()} on this request and cannot be issued.`,
        });
      if (!mrfItem.rawItem)
        return res.status(400).json({
          success: false,
          message: `"${mrfItem.rawItemName}" isn't matched to a catalogue item yet — match or register it before issuing.`,
        });

      const remaining = Math.max(0, (mrfItem.requestedQty || 0) - (mrfItem.issuedQty || 0));
      if (issuedQty > remaining + 0.001)
        return res.status(400).json({
          success: false,
          message: `Cannot issue ${issuedQty} ${mrfItem.unit} of "${mrfItem.rawItemName}" — only ${remaining} ${mrfItem.unit} is still owed on this request.`,
        });

      planned.push({ mrfItem, issuedQty, notes: line.storeNotes || "" });
    }

    if (!planned.length)
      return res.status(400).json({ success: false, message: "Enter at least one quantity to issue." });

    // Re-check live stock at the moment of issue — inventory may have moved
    // since the store person opened the page.
    const stockNow = await mrfUnits.enrichItemsWithStock(planned.map(p => p.mrfItem.toObject()));
    const short = [];
    planned.forEach((p, i) => {
      const live = stockNow[i];
      if (live.available !== null && p.issuedQty > live.available + 0.001) {
        short.push(`${p.mrfItem.rawItemName}: trying to issue ${p.issuedQty} ${p.mrfItem.unit} but only ${live.available} ${p.mrfItem.unit} is in stock right now`);
      }
    });
    if (short.length)
      return res.status(409).json({
        success: false,
        message: "Stock changed since this page was loaded — nothing was issued.",
        details: short,
      });

    const who = actorName(req);
    const previousState = mrf.status;

    /* ── THE MARKER GOES BEFORE THE FIRST STOCK WRITE ───────────────────────
     * `applyIssue` deducts item by item, outside any transaction on a
     * standalone deployment. Marking the effect first makes the deduction
     * at-most-once: any failure from here on routes the retry into recovery
     * above, which never re-runs it. */
    if (req.idempotent?.record) {
      await idempotencyService.markEffectApplied({
        record: req.idempotent.record, entityType: MRF_ENTITY, entityId: mrf._id,
      });
    }

    const issuedLines = await applyIssue({
      mrf, planned, actorId: getActorId(req), storeNotes,
    });

    if (storeNotes) mrf.storeNotes = storeNotes;
    if (!mrf.storeReviewedAt) mrf.storeReviewedAt = new Date();

    // Fully issued only when every live line is done; UNFULFILLED lines are
    // settled and must not hold the request open, but must not fake completion
    // either — the status stays PARTIALLY_ISSUED if anything is still owed.
    const live = mrf.items.filter(i => !["REJECTED", "UNFULFILLED"].includes(i.itemStatus));
    const allIssued = live.length > 0 && live.every(i => i.itemStatus === "ISSUED");
    const someIssued = mrf.items.some(i => (i.issuedQty || 0) > 0);
    mrf.status = allIssued ? "ISSUED" : someIssued ? "PARTIALLY_ISSUED" : mrf.status;

    const detail = issuedLines
      .map(l => `${l.issuedQty} ${l.unit} of ${l.name}${l.remaining > 0 ? ` (${l.remaining} ${l.unit} still pending)` : ""}`)
      .join("; ");
    mrf.logEvent({
      action: allIssued ? "FULLY_ISSUED" : "PARTIALLY_ISSUED",
      actorName: who, actorRole: "store", detail,
    });

    /* Request state, its history entry and the idempotency completion as one
       unit — transactional where the deployment supports it. */
    await unitOfWork.run(req.tenant, {
      idempotencyRecord: req.idempotent?.record,
      mutate: async (session) => {
        await mrf.save(session ? { session } : {});
        return {
          entityType: MRF_ENTITY,
          entityId: mrf._id,
          result: true,
          entry: {
            entityType: MRF_ENTITY,
            entityId: mrf._id,
            documentNumber: mrf.mrfNumber,
            action: "ISSUED",
            previousState,
            resultingState: mrf.status,
            requestId: req.id || "",
            idempotencyKey: req.idempotent?.key || "",
            changes: issuedLines.map((l) => ({ field: l.name, from: null, to: `${l.issuedQty} ${l.unit}` })),
            metadata: { lineCount: issuedLines.length, fullyIssued: allIssued },
          },
        };
      },
    });

    /* Only after the authoritative effect is committed. A notification sent
       before the save can announce an issue that then fails to persist, and a
       replay must not send a second one — which is why this sits past the
       recovery branch, on the path a replay never reaches. */
    await noteInThread(req, mrf, `Store issued ${detail}.`, who);
    mrfNotify.issued(mrf, issuedLines).catch(e => console.error("[issue notify]", e.message));

    const obj = mrf.toObject();
    const issueBody = {
      success: true,
      message: allIssued
        ? "All requested material issued."
        : `Issued. ${issuedLines.filter(l => l.remaining > 0).map(l => `${l.remaining} ${l.unit} of ${l.name}`).join(", ")} still pending on this request.`,
      mrf: obj,
      issued: issuedLines,
      context: buildContext(obj, "store"),
    };
    return req.idempotent
      ? await req.idempotent.succeed(200, issueBody, { entityType: MRF_ENTITY, entityId: mrf._id })
      : res.json(issueBody);
  } catch (e) { console.error("[MRF issue]", e); res.status(500).json({ success: false, message: e.message }); }
},
);

// ── POST /:id/items/:itemId/return ────────────────────────────────────────────
router.post(
  "/:id/items/:itemId/return",
  requireCapability(CAPABILITIES.STOCK_RETURN),
  refuseLegacyWrite,
  withIdempotency("MRF_RETURN"),
  async (req, res) => {
  try {
    const { returnedQty, notes = "" } = req.body;
    const qty = parseFloat(returnedQty) || 0;
    if (qty <= 0) return res.status(400).json({ success: false, message: "returnedQty must be > 0" });

    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) });
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    /* The authority matrix: relationship authority for the requester and
       the assigned approver, capability authority for the store. A
       request this caller may not even see is answered as missing. */
    await may(req, "RETURN", mrf);
    const mrfItem = mrf.items.id(req.params.itemId);
    if (!mrfItem) return res.status(404).json({ success: false, message: "Item not found in MRF" });

    /* ── RECOVERY ───────────────────────────────────────────────────────────
     * Stock was already credited by an earlier attempt with this key. Adding
     * it again would invent material that never came back. */
    if (req.idempotent?.recovering) {
      const recordedAlready = (mrfItem.returnHistory || []).length > 0;
      await unitOfWork.recover(req.tenant, {
        entityType: MRF_ENTITY,
        entityId: mrf._id,
        idempotencyKey: req.idempotent.key,
        entry: {
          documentNumber: mrf.mrfNumber,
          action: recordedAlready ? "RETURNED" : "RETURN_RECONCILIATION_REQUIRED",
          resultingState: mrf.status,
          requestId: req.id || "",
          idempotencyKey: req.idempotent.key,
          reason: recordedAlready ? "" : "Stock was credited but the request did not record the return.",
          metadata: { recovered: true },
        },
      });
      if (!recordedAlready) {
        throw fail(
          "LIFECYCLE_BLOCKED",
          "This return was interrupted after the stock was credited but before the request recorded it. Check the item's stock and correct the request — do not record the return again.",
          { reason: "PARTIAL_RETURN_NEEDS_RECONCILIATION", mrfNumber: mrf.mrfNumber },
        );
      }
      const recoveredObj = mrf.toObject();
      return await req.idempotent.succeed(200, {
        success: true,
        message: "This return was already recorded.",
        mrf: recoveredObj,
        context: buildContext(recoveredObj, "store"),
      }, { entityType: MRF_ENTITY, entityId: mrf._id });
    }

    const previousReturnState = mrf.status;
    const maxReturn = mrfItem.issuedQty - mrfItem.returnedQty;
    if (qty > maxReturn + 0.001)
      return res.status(400).json({ success: false, message: `Cannot return ${qty} — max returnable is ${maxReturn.toFixed(3)} ${mrfItem.unit}` });

    /* Marker before the stock is credited, for the same reason as the issue:
       any failure afterwards must recover, never repeat. */
    if (req.idempotent?.record) {
      await idempotencyService.markEffectApplied({
        record: req.idempotent.record, entityType: MRF_ENTITY, entityId: mrf._id,
      });
    }

    const creditQty = await convertQty(qty, mrfItem.unit, mrfItem.baseUnit);
    await adjustStock(
      mrfItem.rawItem, mrfItem.variantId, mrfItem.variantCombination, +creditQty,
      {
        type: mrfItem.variantId ? "VARIANT_ADD" : "ADD",
        quantity: creditQty,
        reason: `MRF Return — ${mrf.mrfNumber}`,
        notes: notes || `Return from ${mrf.requestedForName}. MRF: ${mrf.mrfNumber}`,
        performedBy: getActorId(req),
      }
    );

    mrfItem.returnedQty += qty;
    mrfItem.consumedQty = mrfItem.issuedQty - mrfItem.returnedQty;
    mrfItem.returnHistory.push({
      returnedQty: qty, notes,
      recordedBy: getActorId(req), recordedByModel: "ProjectManager",
      // The schema field is `returnedAt`. This used to push `recordedAt`,
      // which Mongoose stripped as unknown — the timestamp only survived
      // because `returnedAt` has a Date.now default, and anything reading
      // `recordedAt` (the store's own activity log) got undefined.
      returnedAt: new Date(),
    });

    const fullyReturned = mrfItem.returnedQty >= mrfItem.issuedQty - 0.001;
    mrfItem.itemStatus = fullyReturned ? "RETURNED" : "PARTIALLY_RETURNED";

    const allReturned = mrf.items.every(i => ["RETURNED", "REJECTED"].includes(i.itemStatus));
    const someReturned = mrf.items.some(i => ["RETURNED", "PARTIALLY_RETURNED"].includes(i.itemStatus));
    mrf.status = allReturned ? "COMPLETED" : someReturned ? "PARTIALLY_RETURNED" : mrf.status;

    const who = actorName(req);
    mrf.logEvent({
      action: allReturned ? "FULLY_RETURNED" : "RETURNED",
      actorName: who, actorRole: "store",
      detail: `${qty} ${mrfItem.unit} of ${mrfItem.rawItemName} returned${notes ? ` — ${notes}` : ""}`,
    });

    await unitOfWork.run(req.tenant, {
      idempotencyRecord: req.idempotent?.record,
      mutate: async (session) => {
        await mrf.save(session ? { session } : {});
        return {
          entityType: MRF_ENTITY,
          entityId: mrf._id,
          result: true,
          entry: {
            entityType: MRF_ENTITY,
            entityId: mrf._id,
            documentNumber: mrf.mrfNumber,
            action: "RETURNED",
            previousState: previousReturnState,
            resultingState: mrf.status,
            reason: notes || "",
            requestId: req.id || "",
            idempotencyKey: req.idempotent?.key || "",
            changes: [{ field: mrfItem.rawItemName, from: null, to: `${qty} ${mrfItem.unit} returned` }],
            metadata: { fullyReturned },
          },
        };
      },
    });

    // A return was the one movement that told nobody. The requester needs to
    // know their return was recorded (it clears what they owe), and the TL
    // needs it because the request may now be complete.
    await noteInThread(
      req, mrf,
      `${who} recorded a return of ${qty} ${mrfItem.unit} of ${mrfItem.rawItemName}.${notes ? ` Note: ${notes}` : ""}`,
      who,
    );
    mrfNotify.returned(mrf, {
      name: mrfItem.rawItemName,
      unit: mrfItem.unit,
      returnedQty: qty,
      outstanding: Math.max(0, (mrfItem.issuedQty || 0) - (mrfItem.returnedQty || 0)),
      complete: allReturned,
    }).catch(e => console.error("[return notify]", e.message));

    const returnBody = { success: true, message: `${qty} ${mrfItem.unit} returned & stock credited`, mrf };
    return req.idempotent
      ? await req.idempotent.succeed(200, returnBody, { entityType: MRF_ENTITY, entityId: mrf._id })
      : res.json(returnBody);
  } catch (e) {
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    console.error("[MRF return]", e); res.status(500).json({ success: false, message: e.message }); }
},
);


router.get("/:id/stock-check", async (req, res) => {
  try {
    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) })
      .populate(
        "requestedFor",
        "firstName middleName lastName name biometricId identityId department designation email phone"
      )
      .populate("approvedBy", "firstName lastName name")
      .lean();

    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    /* Reading a request is an authority question too: relationship
       authority for the requester and the assigned approver, capability
       authority for the store. Gating only the mutations left detail,
       stock-check, chat and budget-head readable by any colleague in
       the company. Unviewable is answered as missing. */
    await may(req, "VIEW", mrf);

    // Attach resolved full name
    if (mrf.requestedFor && typeof mrf.requestedFor === "object") {
      mrf.requestedFor._fullName = buildFullName(mrf.requestedFor);
    }

    // Mark overdue flag (reuse existing helper)
    markOverdue([mrf]);

    // ── Live stock lookup for each item ──────────────────────────────────
    // `available` comes back in the REQUESTER's unit, not the catalogue base
    // unit. The store UI prints it beside `item.unit`, so returning the base
    // figure here (as this endpoint used to) showed the wrong number whenever
    // the two differed — 20 pcs in stock reading as "20 packets available"
    // against a request for 2 packets.
    const itemsWithStock = await mrfUnits.enrichItemsWithStock(mrf.items || []);

    // If this MRF was spawned from a product-request match/approve, find
    // that source so the page can link back to it — that's where "Edit
    // Match" lives, and there's otherwise no trail back to it once resolved.
    let sourceProductRequest = null;
    /* Product requests are legacy-global — they carry no company — so this
       back-link is a legacy read and is offered only to a caller who may make
       one. Everyone else simply gets a page with no back-link, which is what
       they would see anyway once the last of these is closed. */
    const sourceDoc = hasAll(req.tenant?.capabilitySet, CAPABILITIES.LEGACY_READ)
      ? await RawItemAddRequest.findOne({ "products.spawnedMrf": req.params.id })
          .select("products requestedByName")
          .lean()
      : null;
    if (sourceDoc) {
      const sourceProduct = (sourceDoc.products || []).find(
        p => p.spawnedMrf && p.spawnedMrf.toString() === req.params.id
      );
      if (sourceProduct) {
        sourceProductRequest = {
          id: sourceDoc._id,
          itemName: sourceProduct.itemName,
          requestedByName: sourceDoc.requestedByName,
        };
      }
    }

    return res.json({
      success: true,
      mrf,
      itemsWithStock,
      // Approval belongs to the requester's TL in cowork — the store never
      // approves, so these stay false for every client.
      approvalFlow: "TL",
      pmApprovalRequired: false,
      storeCanApprove: false,
      storeActionable: isStoreActionable(mrf),
      context: buildContext(mrf, "store"),
      sourceProductRequest,
    });
  } catch (err) {
    /* A structured refusal (forbidden, wrong tenant, invalid transition,
       idempotency conflict) must reach the client as itself, not as a
       generic 500 the browser cannot reason about. */
    if (err?.name === "StorePurchaseError") return sendError(res, err);
    console.error("MRF stock-check error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MRF chat — store side of the same thread the requester and TL use.
// Auth here is the CMS JWT; the cowork side hits the mirror of these routes in
// coworkMrfRoutes.js. Both go through services/mrfChat.service.js.
// ═══════════════════════════════════════════════════════════════════════════

router.get("/:id/chat", async (req, res) => {
  try {
    /* `companyId` is selected deliberately: the chat service scopes messages
       by the parent's company, and a parent loaded without it looks like a
       legacy record to that service. */
    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) })
      .select("mrfNumber status companyId siteId requestedFor requestedForId approverEmployee approverBiometricId approverAltIds")
      .lean();
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    await may(req, "VIEW", mrf);

    const messages = await mrfChat.listMessages(mrf, {
      ctx: req.tenant, limit: req.query.limit, before: req.query.before,
    });
    await mrfChat.markRead(mrf, { ctx: req.tenant, readerId: getActorId(req) });

    res.json({
      success: true,
      messages,
      mrfNumber: mrf.mrfNumber,
      status: mrf.status,
      // A closed request keeps its thread open — the store may still owe the
      // requester an explanation — but the UI flags it.
      isFinal: ["COMPLETED", "REJECTED", "CANCELLED", "UNFULFILLED"].includes(mrf.status),
    });
  } catch (e) {
    /* A structured refusal (forbidden, wrong tenant) must reach the
       client as itself, not as a generic 500. */
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post(
  "/:id/chat",
  refuseLegacyWrite,
  withIdempotency("MRF_CHAT"),
  async (req, res) => {
  try {
    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) });
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    /* The authority matrix: relationship authority for the requester and
       the assigned approver, capability authority for the store. A
       request this caller may not even see is answered as missing. */
    await may(req, "CHAT", mrf);

    const attachments = Array.isArray(req.body.attachments)
      ? req.body.attachments
        .filter(a => a?.url && /^https?:\/\//i.test(a.url))
        .slice(0, 5)
        .map(a => ({ url: a.url, publicId: a.publicId || "", name: a.name || "", type: a.type || "image" }))
      : [];

    /* The key goes to the chat service, where message creation IS the effect
       marker — a retry collides on the unique index instead of posting twice.
       See services/mrfChat.service.js. */
    const { message, created } = await mrfChat.postMessage(mrf, {
      ctx: req.tenant,
      idempotencyKey: req.idempotent?.key || null,
      body: req.body.body,
      attachments,
      senderRef: getActorId(req),
      senderName: actorName(req),
      senderRole: "store",
    });

    /* Recorded whether or not this call created the message — a retry that
       recovered an existing message is exactly the case where the first
       attempt's history write may be what failed. `recover` writes only if
       the entry is genuinely absent. */
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
        metadata: { messageId: String(message._id), attachments: attachments.length },
      },
    });

    const payload = { success: true, message };
    return req.idempotent
      ? await req.idempotent.succeed(201, payload, { entityType: MRF_ENTITY, entityId: mrf._id })
      : res.status(201).json(payload);
  } catch (e) {
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    res.status(e.status || 500).json({ success: false, message: e.message });
  }
},
);

/* Marking a thread read is a write to somebody else's conversation, so it
   needs the same parent load, tenant scope and authority as reading it. It
   previously took `req.params.id` straight to the chat service, which meant a
   guessed id from another company marked that company's messages read. */
router.patch("/:id/chat/read", async (req, res) => {
  try {
    const mrf = await MRF.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) })
      .select("companyId siteId status requestedFor requestedForId approverEmployee approverBiometricId approverAltIds")
      .lean();
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    await may(req, "VIEW", mrf);

    const r = await mrfChat.markRead(mrf, { ctx: req.tenant, readerId: getActorId(req) });
    res.json({ success: true, ...r });
  } catch (e) {
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    res.status(500).json({ success: false, message: e.message });
  }
});


module.exports = router;