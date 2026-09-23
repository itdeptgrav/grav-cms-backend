// routes/CMS_Routes/Inventory/Operations/mrfRoutes.js
// Mount: app.use("/api/cms/inventory/mrf", mrfRoutes)

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const MRF = require("../../../../models/CMS_Models/Inventory/Operations/MRF");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../../../models/CMS_Models/Inventory/Configurations/Warehouse");
const locStock = require("../../../../services/storePurchase/locationStock.service");
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
const documentSequence = require("../../../../services/storePurchase/documentSequence.service");
const { fail, sendError } = require("../../../../services/storePurchase/errors");
// Chunk 9A — stock reservations & picking. The reservation record/projection
// live here; the CONTROLLED ISSUE reuses this file's own adjustStock engine.
const reservationSvc = require("../../../../services/storePurchase/reservation.service");
const StockReservation = require("../../../../models/CMS_Models/Inventory/Operations/StockReservation");
const { resolveConversion } = require("../../../../services/storePurchase/goodsReceipt.service");

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
const commitMrf = (req, mrf, entry, { beforeSave = null, applyTargets = null } = {}) =>
  unitOfWork.run(req.tenant, {
    idempotencyRecord: req.idempotent?.record,
    /* The entity identity, so unitOfWork.run owns the marker ordering: stamped
       INSIDE the transaction (transactional — rolls back with a failure) or
       BEFORE the mutation (standalone — at-most-once). */
    entityType: MRF_ENTITY,
    entityId: mrf._id,
    mutate: async (session) => {
      /* When `applyTargets` is given, the caller's changes are applied to a
         FRESH document loaded in THIS session, so a `withTransaction` retry
         reruns them against the rolled-back state and lands once. Legacy callers
         (no applyTargets) save the document they mutated in the handler. */
      let doc = mrf;
      if (applyTargets) {
        doc = await MRF.findById(mrf._id).session(session || null);
        if (!doc) throw new Error(`MRF ${mrf._id} disappeared mid-commit`);
        await applyTargets(doc, session);
      }
      /* Any domain writes that must share the MRF's transaction run here, with
         the SAME session — e.g. the fulfilment decision's stock issue. */
      if (beforeSave) await beforeSave(session);
      await doc.save(session ? { session } : {});
      // `entry` may be a function so it can read state produced by applyTargets.
      const resolvedEntry = typeof entry === "function" ? entry(doc) : entry;
      return {
        entityType: MRF_ENTITY,
        entityId: doc._id,
        result: doc,
        entry: {
          entityType: MRF_ENTITY,
          entityId: doc._id,
          documentNumber: doc.mrfNumber,
          requestId: req.id || "",
          idempotencyKey: req.idempotent?.key || "",
          ...resolvedEntry,
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

async function adjustStock(rawItemId, variantId, variantCombination, delta, txnMeta, loc = null, session = null) {
  /* Warehouse Stock V1 (atomicity): every write below takes the caller's
     `session`, so on a transaction-capable deployment the RawItem save, the
     guarded location-balance change, the assigned-total change and the
     LocationMovement all commit — or roll back — together with the MRF save in
     the same unit of work. On a standalone the session is null and the marker-
     first ordering in the route is what keeps the effect at-most-once. */
  const raw = await RawItem.findById(rawItemId).session(session || null);
  if (!raw) throw new Error(`RawItem ${rawItemId} not found`);
  const prevQty = raw.quantity || 0;

  /* When a location is chosen, an OUTflow is guarded BEFORE any stock moves so
     the location can't go below zero and a refusal leaves nothing applied. */
  if (loc && loc.location && delta < 0) {
    const ok = await locStock.decLocationGuarded(session, loc.companyId, rawItemId, variantId, loc.warehouse._id, loc.location._id, Math.abs(delta));
    if (!ok) throw fail("VALIDATION", `${loc.location.code} does not hold ${Math.abs(delta)} of this item.`, { reason: "INSUFFICIENT_AT_LOCATION" });
  }

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
    ...(loc && loc.location ? locStock.txLocationSnapshot(loc.warehouse, loc.location) : {}),
  });
  await raw.save(session ? { session } : {});

  if (loc && loc.location) {
    const common = {
      companyId: loc.companyId, siteId: loc.siteId || null,
      item: raw, variantId: variantId || null,
      warehouse: loc.warehouse, location: loc.location, quantity: Math.abs(delta),
      type: loc.type, source: loc.source || {},
      actor: loc.actor || {}, note: txnMeta.reason || "",
      // Per-line movement key (deploy-compatible identity); the originating
      // operation key kept separately for audit/recovery.
      idempotencyKey: loc.idempotencyKey || "",
      operationKey: loc.operationKey || "",
    };
    if (delta < 0) {
      // the location was already guarded+decremented above; finish the pair
      await locStock.incAssignedTotal(session, loc.companyId, rawItemId, variantId, -Math.abs(delta), null);
      await locStock.writeMovement(session, locStock.buildMovement({ ...common, direction: "out" }));
    } else {
      await locStock.applyLocationIn(session, { ...common, intent: "receive" });
    }
  }
}

/**
 * Warehouse Stock V1 — resolve and validate the EXPLICIT source/destination
 * location a store person chose for an MRF line. `line` may carry its own
 * warehouseId/locationId; otherwise the request's top-level pair is the
 * fallback. Returns a lean `{ warehouse, location }`, or null when none was
 * named. A named-but-unusable location (inactive, foreign to the company, or
 * not in that warehouse) throws — a source is never guessed.
 */
async function resolveMrfLocation(req, line) {
  const wid = line?.warehouseId || req.body?.warehouseId || null;
  const lid = line?.locationId || req.body?.locationId || null;
  if (!wid || !lid) {
    if (wid || lid) throw fail("VALIDATION", "A location needs both a warehouse and a location.", { reason: "LOCATION_INCOMPLETE" });
    return null;
  }
  const warehouse = await Warehouse.findOne({ _id: wid, ...tenantContext.tenantFilter(req.tenant) }).lean();
  const location = locStock.findLocation(warehouse, lid);
  const err = locStock.usableLocationError(warehouse, location, req.tenant.companyId);
  if (err) throw fail("VALIDATION", err.message, { reason: err.reason });
  return { warehouse, location };
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
    const RequestsSettings = require("../../../../models/CMS_Models/Configurations/RequestsSettings");
    const requestsSettings = await RequestsSettings.get();
    const budgetInvolvementEnabled = requestsSettings.mrfBudgetEnabled !== false;

    const mrf = await MRF.findById(req.params.id)
      .select("budgetLedgerId budgetLedgerName budgetFinancialYear budgetDepartment budgetHeadRequested requestedForDept")
      .lean();
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    /* Reading a request is an authority question too: relationship
       authority for the requester and the assigned approver, capability
       authority for the store. Gating only the mutations left detail,
       stock-check, chat and budget-head readable by any colleague in
       the company. Unviewable is answered as missing. */
    await may(req, "VIEW", mrf);

    /* PAUSED. The CEO has switched off finance/budget involvement in MRF —
       see RequestsSettings' header for what that changes. Reported plainly
       rather than falling through to "no budget head was set", which reads as
       a gap in the request instead of a deliberate, reversible setting. */
    if (!budgetInvolvementEnabled) {
      return res.json({
        success: true,
        budgetInvolvementEnabled: false,
        head: null,
        message: "Budget & finance review is currently paused for MRF — Store can buy or arrange this directly.",
      });
    }

    if (!mrf.budgetLedgerId) {
      return res.json({
        success: true,
        budgetInvolvementEnabled: true,
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

    const { Acc_Company } = require("../../../../models/Accountant_model/Acc_MasterModels");
    const companies = await Acc_Company.find({}).select("_id").limit(2).lean();
    if (companies.length !== 1) {
      return res.json({ success: true, budgetInvolvementEnabled: true, head: null, message: "The books are not configured for this yet." });
    }

    const budgetMatch = require("../../../../services/budgetCommitment.service");
    const { heads } = await budgetMatch.approvedHeadsFor({
      companyId: booksCompanyId,
      department: mrf.budgetDepartment || mrf.requestedForDept || "",
    });
    const head = heads.find((h) => String(h.ledgerId) === String(mrf.budgetLedgerId)) || null;

    res.json({
      success: true,
      budgetInvolvementEnabled: true,
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

    const RequestsSettings = require("../../../../models/CMS_Models/Configurations/RequestsSettings");
    const requestsSettings = await RequestsSettings.get();
    /* PAUSED. See RequestsSettings' header. When false, a request that has to
       be bought skips the budget-head requirement below and the resulting
       SpendRequest starts already `approved` instead of `pending_finance` —
       Store can raise the purchase order immediately, no finance step in
       between. Nothing about SpendRequest or the accountant module changes;
       only where this one starts on that chain. */
    const budgetInvolvementEnabled = requestsSettings.mrfBudgetEnabled !== false;

    const mrf = await MRF.findById(req.params.id);
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

    /* Warehouse Stock V1: the source location for each issued line, taken from
       the SAME confirmation step (the request's `lines`), not a separate flow.
       A location-tracked item cannot be auto-fulfilled from Unassigned — it is
       blocked with LOCATION_REQUIRED. All checked BEFORE the marker so a refusal
       leaves nothing applied. */
    const sourceByItem = new Map(
      (Array.isArray(b.lines) ? b.lines : []).map((l) => [String(l.itemId), l]),
    );
    for (const p of planned) {
      p.loc = await resolveMrfLocation(req, sourceByItem.get(String(p.mrfItem._id)) || {});
      if (!p.loc && await locStock.isLocationTracked(req.tenant.companyId, p.mrfItem.rawItem, p.mrfItem.variantId || null)) {
        return res.status(400).json({
          success: false,
          reason: "LOCATION_REQUIRED",
          message: `"${p.mrfItem.rawItemName}" is tracked by location — choose the warehouse and location to issue it from before completing fulfilment.`,
        });
      }
      if (p.loc) {
        const deductQty = await convertQty(p.issuedQty, p.mrfItem.unit, p.mrfItem.baseUnit);
        const onHand = await locStock.locationOnHand(
          null, req.tenant.companyId, p.mrfItem.rawItem, p.mrfItem.variantId,
          p.loc.warehouse._id, p.loc.location._id,
        );
        if (deductQty > onHand + 0.001) {
          return res.status(409).json({
            success: false,
            message: `${p.mrfItem.rawItemName}: ${p.loc.location.code} holds ${onHand} ${p.mrfItem.baseUnit}, cannot issue ${deductQty} ${p.mrfItem.baseUnit}.`,
          });
        }
      }
    }

    let issuedLines = [];
    /* No marker is written before the transaction. commitMrf passes the entity
       identity to unitOfWork.run, which stamps the marker INSIDE the transaction
       (transactional — rolled back on failure) or BEFORE the mutation
       (standalone — at-most-once). */

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
         mistake the head moved up a level to prevent.
         SKIPPED WHILE PAUSED: with budget involvement off, a request can
         become a purchase with no head at all — see the note on
         budgetInvolvementEnabled above. */
      if (budgetInvolvementEnabled && !mrf.budgetLedgerId && !mrf.budgetHeadRequested) {
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
           sending it back would be the same person answering twice.
           PAUSED: starts already `approved` (services/spendApproval.service.js's
           APPROVED constant — "Approved — with Store for fulfilment") instead,
           so Store can raise the purchase order immediately with no finance
           step in between. */
        startAt: budgetInvolvementEnabled ? "pending_finance" : "approved",
        tlApproval: mrf.tlApprovedAt
          ? { by: mrf.tlApprovedBy, byName: mrf.tlApprovedByName, at: mrf.tlApprovedAt }
          : null,
        /* The store's own words travel with it. Finance is deciding on a
           vendor and a price they had no part in choosing, and "only vendor
           who stocks this grade" is most of the case for the figure. */
        historyNote:
          `Raised by ${who} from ${mrf.mrfNumber} — the store could not supply this from stock.` +
          (budgetInvolvementEnabled ? "" : " Budget & finance review is currently paused for MRF.") +
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
    }

    /* PLAN the issue once (no MRF mutation, no DB writes) — its absolute item
       targets and IDEMPOTENT ledger writes are applied to a FRESH MRF inside the
       transactional callback below. */
    let stockPlans = [];
    let itemTargets = [];
    if (planned.length) {
      const applied = await applyIssue({
        mrf, planned, actorId, storeNotes: "",
        operationKey: req.idempotent?.key || "", tenant: req.tenant,
      });
      issuedLines = applied.issuedLines;
      stockPlans = applied.stockPlans;
      itemTargets = applied.itemTargets;
    }

    const fulfilmentNote = String(b.note || "").trim().slice(0, 500);
    const detail =
      fulfilment.DECISION_LABEL[decision] +
      (issuedLines.length
        ? ` — issued ${issuedLines.map((l) => `${l.issuedQty} ${l.unit} of ${l.name}`).join("; ")}`
        : "") +
      (spend
        ? budgetInvolvementEnabled
          ? ` — ${spend.requestNumber} sent to finance`
          : ` — ${spend.requestNumber} approved for purchase`
        : "");

    /* Every MRF change is applied to a FRESH document inside the transactional
       callback (so a `withTransaction` retry lands once), and the shelf
       deduction runs with the same session. The marker is written inside the
       transaction by unitOfWork.run — a rollback rolls it back too. */
    const { result: committed } = await commitMrf(
      req, mrf,
      (doc) => ({
        action: "STORE_FULFILMENT_DECISION",
        previousState: stateBeforeDecision,
        resultingState: doc.status,
        changes: issuedLines.map((l) => ({ field: l.name, from: null, to: `${l.issuedQty} ${l.unit}` })),
        metadata: {
          decision,
          issuedLines: issuedLines.length,
          spendRequest: spend ? spend.requestNumber : null,
        },
      }),
      {
        applyTargets: (doc) => {
          if (spend) {
            doc.spendRequestId = spend._id;
            doc.spendRequestNumber = spend.requestNumber;
            buying.forEach((l) => {
              const item = doc.items.id(l.itemId);
              if (item) item.buyQty = l.buyQty;
            });
          }
          doc.fulfilmentDecision = decision;
          doc.fulfilmentDecidedAt = now;
          doc.fulfilmentDecidedBy = actorId;
          doc.fulfilmentDecidedByName = who;
          doc.fulfilmentNote = fulfilmentNote;
          if (!doc.storeReviewedAt) doc.storeReviewedAt = now;

          applyItemIssueTargets(doc, itemTargets);
          // A request whose whole balance went to finance keeps its status —
          // nothing is issued or settled until the goods arrive.
          doc.status = issueStatusOf(doc).status;
          doc.logEvent({ action: "STORE_FULFILMENT_DECISION", actorName: who, actorRole: "store", detail });
        },
        beforeSave: async (session) => {
          await applyStockPlans(stockPlans, session);
        },
      },
    );

    await noteInThread(req, committed, detail, who);
    if (issuedLines.length) {
      mrfNotify.issued(committed, issuedLines).catch((e) => console.error("[fulfilment issue notify]", e.message));
    }

    const obj = committed.toObject();
    const decisionPayload = {
      success: true,
      message: spend
        ? budgetInvolvementEnabled
          ? `${spend.requestNumber} is with finance for ${spend.grandTotal ? `₹${spend.grandTotal}` : "pricing"}.` +
            (issuedLines.length ? " What was on the shelf has been issued." : "")
          : `${spend.requestNumber} is approved for purchase.` +
            (issuedLines.length ? " What was on the shelf has been issued." : "")
        : "Issued from stock — nothing to buy, so finance is not involved.",
      budgetInvolvementEnabled,
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
 * Pure PLANNER: it neither saves nor touches the database, and it does NOT
 * mutate the MRF. It computes, ONCE, the immutable business plan for the issue:
 *   · `stockPlans` — the ledger writes (applied later with a session);
 *   · `itemTargets` — DETERMINISTIC absolute target values for each line
 *     (targetIssuedQty, targetItemStatus, the one history entry to append);
 *   · `issuedLines` — for the response and notifications.
 * The caller applies `itemTargets` to a FRESH MRF loaded inside each
 * transactional attempt (see applyIssueTargets), so a `withTransaction` retry —
 * which reruns the whole callback against the rolled-back state — lands the
 * same result exactly once. Nothing here uses `+=` against a captured document.
 */
async function applyIssue({ mrf, planned, actorId, storeNotes = "", operationKey = "", tenant = null }) {
  const issuedLines = [];
  const stockPlans = [];
  const itemTargets = [];
  const recordedAt = new Date(); // stamped once, so every retry writes the same

  for (const { mrfItem, issuedQty, notes, loc } of planned) {
    // The only place a requester-unit quantity is converted to the
    // catalogue's base unit: the stock ledger.
    const deductQty = await convertQty(issuedQty, mrfItem.unit, mrfItem.baseUnit);

    /* Warehouse Stock V1: when a source location was chosen, the issue also
       writes a location-OUT movement — sharing ONE source identity with the
       canonical RawItem deduction (the MRF), and a per-line movement key so a
       replay cannot duplicate it. adjustStock guards the location BEFORE any
       stock change, so an over-issue refuses with nothing applied. */
    const adjustLoc = loc && loc.location
      ? {
          companyId: tenant?.companyId, siteId: tenant?.siteId || null,
          warehouse: loc.warehouse, location: loc.location,
          type: "issue",
          source: { kind: "mrf_issue", id: mrf._id, reference: mrf.mrfNumber },
          actor: { id: actorId, name: "" },
          idempotencyKey: locStock.movementLineKey(operationKey, mrfItem._id, "issue"),
          operationKey,
        }
      : null;

    stockPlans.push({
      rawItemId: mrfItem.rawItem,
      variantId: mrfItem.variantId,
      variantCombination: mrfItem.variantCombination,
      delta: -deductQty,
      txnMeta: {
        type: mrfItem.variantId ? "VARIANT_REDUCE" : "REDUCE",
        quantity: deductQty,
        reason: `MRF Issue — ${mrf.mrfNumber}`,
        notes: `Issued to ${mrf.requestedForName} (${mrf.requestedForDept}). MRF: ${mrf.mrfNumber}`,
        performedBy: actorId,
      },
      loc: adjustLoc,
    });

    // Absolute targets, computed from the base value read at validation time.
    const targetIssuedQty = (mrfItem.issuedQty || 0) + issuedQty;
    itemTargets.push({
      mrfItemId: String(mrfItem._id),
      targetIssuedQty,
      targetItemStatus: targetIssuedQty >= (mrfItem.requestedQty || 0) - 0.001 ? "ISSUED" : "PARTIALLY_ISSUED",
      storeNote: notes || "",
      issueHistoryEntry: {
        issuedQty,
        notes: notes || storeNotes || "",
        recordedBy: actorId,
        recordedAt,
      },
    });

    issuedLines.push({
      name: mrfItem.rawItemName,
      unit: mrfItem.unit,
      issuedQty,
      remaining: Math.max(0, (mrfItem.requestedQty || 0) - targetIssuedQty),
    });
  }

  return { issuedLines, stockPlans, itemTargets };
}

/**
 * Apply issue `itemTargets` to the lines of a FRESH MRF document. Absolute sets
 * and a single history append — deterministic and idempotent per attempt,
 * because the document is reloaded fresh in each transactional callback.
 */
function applyItemIssueTargets(doc, itemTargets) {
  for (const t of itemTargets) {
    const it = doc.items.id(t.mrfItemId);
    if (!it) continue;
    it.issuedQty = t.targetIssuedQty;
    it.consumedQty = it.issuedQty - (it.returnedQty || 0);
    it.itemStatus = t.targetItemStatus;
    if (t.targetItemStatus === "ISSUED") it.availability = "AVAILABLE";
    if (t.storeNote) it.storeNote = t.storeNote;
    it.issueHistory = it.issueHistory || [];
    it.issueHistory.push(t.issueHistoryEntry);
  }
}

// The whole-request rule the Issue button and the fulfilment decision share:
// fully issued only when every LIVE line is done. UNFULFILLED/REJECTED lines are
// settled and must not hold the request open, nor fake completion.
function issueStatusOf(doc) {
  const live = doc.items.filter(i => !["REJECTED", "UNFULFILLED"].includes(i.itemStatus));
  const allIssued = live.length > 0 && live.every(i => i.itemStatus === "ISSUED");
  const someIssued = doc.items.some(i => (i.issuedQty || 0) > 0);
  return { allIssued, status: allIssued ? "ISSUED" : someIssued ? "PARTIALLY_ISSUED" : doc.status };
}

/**
 * The Issue-button flavour: item targets + store review + status + the
 * FULLY/PARTIALLY_ISSUED log event, on a fresh document. Returns whether the
 * request is now fully issued.
 */
function applyIssueTargets(doc, itemTargets, { storeNotes, reviewedAt, who, detail }) {
  applyItemIssueTargets(doc, itemTargets);
  if (storeNotes) doc.storeNotes = storeNotes;
  if (!doc.storeReviewedAt) doc.storeReviewedAt = reviewedAt;
  const { allIssued, status } = issueStatusOf(doc);
  doc.status = status;
  doc.logEvent({
    action: allIssued ? "FULLY_ISSUED" : "PARTIALLY_ISSUED",
    actorName: who, actorRole: "store", detail,
  });
  return allIssued;
}

/**
 * Apply prepared stock plans (from applyIssue, or a single return credit) to the
 * ledger with the caller's session. Every write reloads the RawItem fresh and
 * sets absolute values, so this is safe to REPLAY — a transaction retry re-runs
 * it against the rolled-back state and lands the same result.
 */
async function applyStockPlans(stockPlans, session) {
  for (const sp of stockPlans) {
    await adjustStock(sp.rawItemId, sp.variantId, sp.variantCombination, sp.delta, sp.txnMeta, sp.loc, session);
  }
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

      /* Warehouse Stock V1: the EXPLICIT source location for this line. When the
         item is location-tracked, a valid source is REQUIRED — never silently
         issue from Unassigned. A named-but-unusable location throws (→ 400). */
      const loc = await resolveMrfLocation(req, line);
      if (!loc && await locStock.isLocationTracked(req.tenant.companyId, mrfItem.rawItem, mrfItem.variantId || null)) {
        return res.status(400).json({
          success: false,
          reason: "LOCATION_REQUIRED",
          message: `"${mrfItem.rawItemName}" is tracked by location — choose the warehouse and location to issue it from.`,
        });
      }

      planned.push({ mrfItem, issuedQty, notes: line.storeNotes || "", loc });
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
    /* And, for a chosen location, that the LOCATION itself holds enough — refused
       here, BEFORE the effect marker, so an over-issue at a location leaves every
       stock record untouched and does not lock the key into recovery. */
    for (const p of planned) {
      if (!p.loc) continue;
      const deductQty = await convertQty(p.issuedQty, p.mrfItem.unit, p.mrfItem.baseUnit);
      const onHand = await locStock.locationOnHand(
        null, req.tenant.companyId, p.mrfItem.rawItem, p.mrfItem.variantId,
        p.loc.warehouse._id, p.loc.location._id,
      );
      if (deductQty > onHand + 0.001) {
        short.push(`${p.mrfItem.rawItemName}: ${p.loc.location.code} holds ${onHand} ${p.mrfItem.baseUnit}, cannot issue ${deductQty} ${p.mrfItem.baseUnit}`);
      }
    }
    if (short.length)
      return res.status(409).json({
        success: false,
        message: "Stock changed since this page was loaded — nothing was issued.",
        details: short,
      });

    const who = actorName(req);
    const previousState = mrf.status;
    const reviewedAt = new Date();

    /* PLAN the issue once — no MRF mutation, no DB writes. The MRF is mutated
       only on a FRESH document loaded inside the transactional callback below,
       so a `withTransaction` retry that reruns the callback lands the same
       result exactly once and never persists a doubly-incremented quantity. */
    const { issuedLines, stockPlans, itemTargets } = await applyIssue({
      mrf, planned, actorId: getActorId(req), storeNotes,
      operationKey: req.idempotent?.key || "", tenant: req.tenant,
    });

    const detail = issuedLines
      .map(l => `${l.issuedQty} ${l.unit} of ${l.name}${l.remaining > 0 ? ` (${l.remaining} ${l.unit} still pending)` : ""}`)
      .join("; ");

    /* No marker is written out here. unitOfWork.run stamps it INSIDE the
       transaction (transactional) — so a rollback rolls the marker back and a
       retry is a clean first attempt — or BEFORE the mutation (standalone),
       given the entity identity passed below, for at-most-once. */
    const { result: committed } = await unitOfWork.run(req.tenant, {
      idempotencyRecord: req.idempotent?.record,
      entityType: MRF_ENTITY,
      entityId: mrf._id,
      mutate: async (session) => {
        const doc = await MRF.findById(mrf._id).session(session || null);
        if (!doc) throw new Error(`MRF ${mrf._id} disappeared mid-issue`);
        const fullyIssued = applyIssueTargets(doc, itemTargets, { storeNotes, reviewedAt, who, detail });
        await applyStockPlans(stockPlans, session);
        await doc.save(session ? { session } : {});
        return {
          entityType: MRF_ENTITY,
          entityId: doc._id,
          result: doc,
          entry: {
            entityType: MRF_ENTITY,
            entityId: doc._id,
            documentNumber: doc.mrfNumber,
            action: "ISSUED",
            previousState,
            resultingState: doc.status,
            requestId: req.id || "",
            idempotencyKey: req.idempotent?.key || "",
            changes: issuedLines.map((l) => ({ field: l.name, from: null, to: `${l.issuedQty} ${l.unit}` })),
            metadata: { lineCount: issuedLines.length, fullyIssued },
          },
        };
      },
    });

    const allIssued = committed.status === "ISSUED";

    /* Only after the authoritative effect is committed. A notification sent
       before the save can announce an issue that then fails to persist, and a
       replay must not send a second one — which is why this sits past the
       recovery branch, on the path a replay never reaches. */
    await noteInThread(req, committed, `Store issued ${detail}.`, who);
    mrfNotify.issued(committed, issuedLines).catch(e => console.error("[issue notify]", e.message));

    const obj = committed.toObject();
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
  } catch (e) {
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    console.error("[MRF issue]", e); res.status(500).json({ success: false, message: e.message });
  }
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

    /* Warehouse Stock V1: the EXPLICIT "Return to" destination. A location-in
       movement, linked to this MRF (and so to the original issue), preserves
       item/variant/quantity/unit identity. A location-tracked item must name a
       destination — never credited silently to Unassigned. Resolved and
       validated BEFORE the marker so a bad destination leaves nothing applied. */
    const loc = await resolveMrfLocation(req, req.body);
    if (!loc && await locStock.isLocationTracked(req.tenant.companyId, mrfItem.rawItem, mrfItem.variantId || null)) {
      return res.status(400).json({
        success: false,
        reason: "LOCATION_REQUIRED",
        message: `"${mrfItem.rawItemName}" is tracked by location — choose the warehouse and location to return it to.`,
      });
    }

    const creditQty = await convertQty(qty, mrfItem.unit, mrfItem.baseUnit);
    const who = actorName(req);
    const mrfItemId = String(mrfItem._id);
    const returnedAt = new Date();
    const returnDetail = `${qty} ${mrfItem.unit} of ${mrfItem.rawItemName} returned${notes ? ` — ${notes}` : ""}`;

    /* PLAN once — deterministic absolute targets, computed from the base values
       read at validation time. NO MRF mutation here; the document is mutated
       only on a fresh copy inside the transactional callback. */
    const targetReturnedQty = (mrfItem.returnedQty || 0) + qty;
    const fullyReturned = targetReturnedQty >= (mrfItem.issuedQty || 0) - 0.001;
    const returnHistoryEntry = {
      returnedQty: qty, notes,
      recordedBy: getActorId(req), recordedByModel: "ProjectManager",
      // The schema field is `returnedAt`. This used to push `recordedAt`,
      // which Mongoose stripped as unknown — the timestamp only survived
      // because `returnedAt` has a Date.now default, and anything reading
      // `recordedAt` (the store's own activity log) got undefined.
      returnedAt,
    };

    const returnPlan = {
      rawItemId: mrfItem.rawItem, variantId: mrfItem.variantId, variantCombination: mrfItem.variantCombination,
      delta: +creditQty,
      txnMeta: {
        type: mrfItem.variantId ? "VARIANT_ADD" : "ADD",
        quantity: creditQty,
        reason: `MRF Return — ${mrf.mrfNumber}`,
        notes: notes || `Return from ${mrf.requestedForName}. MRF: ${mrf.mrfNumber}`,
        performedBy: getActorId(req),
      },
      loc: loc && loc.location
        ? {
            companyId: req.tenant.companyId, siteId: req.tenant.siteId || null,
            warehouse: loc.warehouse, location: loc.location,
            type: "return",
            source: { kind: "mrf_return", id: mrf._id, reference: mrf.mrfNumber },
            actor: { id: getActorId(req), name: who },
            idempotencyKey: locStock.movementLineKey(req.idempotent?.key || "", mrfItem._id, "return"),
            operationKey: req.idempotent?.key || "",
          }
        : null,
    };

    /* The credit and its location-in movement (idempotent — RawItem reloaded
       fresh, absolute values) plus the request save happen INSIDE one unit of
       work, on a FRESH MRF loaded in the session, so a `withTransaction` retry
       lands the return exactly once, and the marker is written (transactional)
       inside the transaction — rolling back with the credit if it aborts. */
    const { result: committed } = await unitOfWork.run(req.tenant, {
      idempotencyRecord: req.idempotent?.record,
      entityType: MRF_ENTITY,
      entityId: mrf._id,
      mutate: async (session) => {
        const doc = await MRF.findById(mrf._id).session(session || null);
        if (!doc) throw new Error(`MRF ${mrf._id} disappeared mid-return`);
        const it = doc.items.id(mrfItemId);
        it.returnedQty = targetReturnedQty;
        it.consumedQty = (it.issuedQty || 0) - it.returnedQty;
        it.itemStatus = fullyReturned ? "RETURNED" : "PARTIALLY_RETURNED";
        it.returnHistory.push(returnHistoryEntry);

        const allReturned = doc.items.every(i => ["RETURNED", "REJECTED"].includes(i.itemStatus));
        const someReturned = doc.items.some(i => ["RETURNED", "PARTIALLY_RETURNED"].includes(i.itemStatus));
        doc.status = allReturned ? "COMPLETED" : someReturned ? "PARTIALLY_RETURNED" : doc.status;
        doc.logEvent({ action: allReturned ? "FULLY_RETURNED" : "RETURNED", actorName: who, actorRole: "store", detail: returnDetail });

        await applyStockPlans([returnPlan], session);
        await doc.save(session ? { session } : {});
        return {
          entityType: MRF_ENTITY,
          entityId: doc._id,
          result: doc,
          entry: {
            entityType: MRF_ENTITY,
            entityId: doc._id,
            documentNumber: doc.mrfNumber,
            action: "RETURNED",
            previousState: previousReturnState,
            resultingState: doc.status,
            reason: notes || "",
            requestId: req.id || "",
            idempotencyKey: req.idempotent?.key || "",
            changes: [{ field: mrfItem.rawItemName, from: null, to: `${qty} ${mrfItem.unit} returned` }],
            metadata: { fullyReturned },
          },
        };
      },
    });

    const committedItem = committed.items.id(mrfItemId);
    const allReturned = committed.status === "COMPLETED";

    // A return was the one movement that told nobody. The requester needs to
    // know their return was recorded (it clears what they owe), and the TL
    // needs it because the request may now be complete.
    await noteInThread(
      req, committed,
      `${who} recorded a return of ${qty} ${mrfItem.unit} of ${mrfItem.rawItemName}.${notes ? ` Note: ${notes}` : ""}`,
      who,
    );
    mrfNotify.returned(committed, {
      name: mrfItem.rawItemName,
      unit: mrfItem.unit,
      returnedQty: qty,
      outstanding: Math.max(0, (committedItem?.issuedQty || 0) - (committedItem?.returnedQty || 0)),
      complete: allReturned,
    }).catch(e => console.error("[return notify]", e.message));

    const returnBody = { success: true, message: `${qty} ${mrfItem.unit} returned & stock credited`, mrf: committed };
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

// ═══════════════════════════════════════════════════════════════════════════
// CHUNK 9A — STOCK RESERVATIONS, PICKING & CONTROLLED ISSUE
//
// An approved demand is not issued directly. It is checked, reserved from chosen
// usable locations (a live record; on-hand never changes), picked, then issued
// through THIS file's own adjustStock engine. Reservations never appear in the
// movement ledger.
// ═══════════════════════════════════════════════════════════════════════════

const sameIdLocal = (a, b) => String(a ?? "") === String(b ?? "");

// The company's active warehouses (with their embedded locations).
const companyWarehouses = (req) =>
  Warehouse.find({ ...tenantContext.tenantFilter(req.tenant), status: "Active" }).lean();

// Freeze the business→base conversion for a line, failing closed on a missing
// path (never treating unlike units as equal).
async function lineConversion(line, raw) {
  const baseUnit = line.baseUnit || (raw && (raw.customUnit || raw.unit)) || line.unit;
  const conv = await resolveConversion({ quantity: 1, fromUnit: line.unit, toUnit: baseUnit });
  return { baseUnit, factor: conv.factor };
}

// Why a line cannot be reserved — a matched physical item is required; a service
// / buy line follows the Service Order workflow, not inventory reservation.
function reservableRefusal(mrf, line) {
  if (!line) return { code: "UNKNOWN_LINE", message: "That line is not part of this request." };
  if (["REJECTED", "UNFULFILLED"].includes(line.itemStatus)) return { code: "LINE_CLOSED", message: "This line is closed and cannot be reserved." };
  if (!line.rawItem) {
    if (mrf.fulfilmentDecision === "buy_or_service") {
      return { code: "SERVICE_NOT_RESERVABLE", message: "This line follows the Service Order / purchase workflow, not inventory reservation." };
    }
    return { code: "LINE_NOT_MATCHED", message: "Match this line to a catalogue item before reserving stock." };
  }
  return null;
}

// Shape one reservation for the API (business-unit figures + derived state).
function reservationView(r) {
  const factor = Number(r.conversionFactor) || 1;
  const activeReserved = reservationSvc.r4(Math.max(0, (r.reservedQty || 0) - (r.issuedQty || 0) - (r.releasedQty || 0)));
  return {
    id: String(r._id), mrfId: String(r.mrfId), mrfNumber: r.mrfNumber, mrfLineId: String(r.mrfLineId),
    requestedForName: r.requestedForName || "", requestedForDept: r.requestedForDept || "", neededBy: r.neededBy || null,
    item: { rawItemId: String(r.rawItemId), name: r.itemName, sku: r.sku, variantId: r.variantId ? String(r.variantId) : null, variant: (r.variantCombination || []).join(" • ") },
    unit: r.unit, baseUnit: r.baseUnit, conversionFactor: factor,
    requestedQty: r.requestedQty, reservedQty: r.reservedQty, activeReservedQty: activeReserved,
    pickedQty: r.pickedQty || 0, issuedQty: r.issuedQty || 0, releasedQty: r.releasedQty || 0, backorderedQty: r.backorderedQty || 0,
    status: r.status, group: reservationSvc.queueGroup(r),
    allocations: (r.allocations || []).map((a) => ({
      id: String(a._id), warehouseId: String(a.warehouseId), warehouseName: a.warehouseName, warehouseShortName: a.warehouseShortName,
      locationId: String(a.locationId), locationCode: a.locationCode, locationName: a.locationName,
      reservedQty: a.reservedQty, issuedQty: a.issuedQty || 0, releasedQty: a.releasedQty || 0,
      activeQty: reservationSvc.r4(Math.max(0, (a.reservedQty || 0) - (a.issuedQty || 0) - (a.releasedQty || 0))),
    })),
    reservedByName: r.reservedByName || "", reservedAt: r.reservedAt || null,
    history: (r.history || []).map((h) => ({ action: h.action, qty: h.qty, at: h.at, byName: h.byName, reason: h.reason })),
  };
}

// ── GET /:id/items/:itemId/availability — usable locations + on hand/reserved/available
router.get("/:id/items/:itemId/availability", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const mrf = await loadMrf(req, req.params.id, { lean: true });
    const line = (mrf.items || []).find((it) => String(it._id) === String(req.params.itemId));
    const refuse = reservableRefusal(mrf, line);
    if (refuse) return res.status(400).json({ success: false, ...refuse });

    const raw = await RawItem.findById(line.rawItem).select("unit customUnit").lean();
    const { baseUnit, factor } = await lineConversion(line, raw);
    const warehouses = await companyWarehouses(req);
    const rows = await reservationSvc.availabilityFor({
      companyId: req.tenant.companyId, itemId: line.rawItem, variantId: line.variantId || null,
      warehouses, preferredWarehouseId: line.warehouseId || null,
    });
    // Convert base figures to the requester's unit for display (never total across units).
    const toBiz = (base) => (factor > 0 ? reservationSvc.r4(base / factor) : base);
    res.json({
      success: true,
      line: { itemId: String(line._id), name: line.rawItemName, sku: line.rawItemSku, unit: line.unit, baseUnit, conversionFactor: factor, requestedQty: line.requestedQty, issuedQty: line.issuedQty || 0 },
      locations: rows.map((r) => ({
        warehouseId: r.warehouseId, warehouseName: r.warehouseName, warehouseShortName: r.warehouseShortName,
        locationId: r.locationId, locationCode: r.locationCode, locationName: r.locationName,
        onHand: toBiz(r.onHandBase), reserved: toBiz(r.reservedBase), available: toBiz(r.availableBase),
        onHandBase: r.onHandBase, reservedBase: r.reservedBase, availableBase: r.availableBase,
      })),
      totals: {
        available: reservationSvc.r4(rows.reduce((t, r) => t + toBiz(r.availableBase), 0)),
        onHand: reservationSvc.r4(rows.reduce((t, r) => t + toBiz(r.onHandBase), 0)),
      },
    });
  } catch (e) {
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /:id/items/:itemId/reserve — reserve from explicit chosen locations ──
router.post("/:id/items/:itemId/reserve",
  requireCapability(CAPABILITIES.MRF_FULFIL), refuseLegacyWrite,
  withIdempotency("MRF_RESERVE", { target: (req) => req.params.id }),
  async (req, res) => {
    try {
      const mrf = await loadMrf(req, req.params.id);
      const line = mrf.items.id(req.params.itemId);
      const refuse = reservableRefusal(mrf, line);
      if (refuse) return res.status(400).json({ success: false, ...refuse });

      if (req.idempotent?.recovering) {
        const existing = await StockReservation.findOne({ companyId: req.tenant.companyId, mrfLineId: line._id, idempotencyKey: req.idempotent.key }).lean();
        if (existing) return await req.idempotent.succeed(200, { success: true, message: "This reservation was already recorded.", reservation: reservationView(existing) }, { entityType: MRF_ENTITY, entityId: mrf._id });
        throw fail("LIFECYCLE_BLOCKED", "This reservation was interrupted. Re-check availability before reserving again.", { reason: "PARTIAL_RESERVATION_NEEDS_RECHECK" });
      }

      const raw = await RawItem.findById(line.rawItem).select("unit customUnit variants").lean();
      if (!raw) return res.status(400).json({ success: false, reason: "ITEM_MISSING", message: "The matched catalogue item no longer exists." });
      // Variant identity must match exactly (incl. null vs non-null).
      if (line.variantId && !(raw.variants || []).some((v) => sameIdLocal(v._id, line.variantId))) {
        return res.status(409).json({ success: false, reason: "VARIANT_MISMATCH", message: "The line's variant no longer exists on the item." });
      }
      const { baseUnit, factor } = await lineConversion(line, raw);

      const reqAllocs = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
      if (reqAllocs.length === 0) return res.status(400).json({ success: false, reason: "NO_ALLOCATIONS", message: "Choose at least one location and quantity to reserve." });

      const warehouses = await companyWarehouses(req);
      const whById = new Map(warehouses.map((w) => [String(w._id), w]));
      // Validate every chosen location up front (usable, active, in this company).
      const resolved = [];
      for (const a of reqAllocs) {
        const qty = Number(a.qty);
        if (!(qty > 0)) return res.status(400).json({ success: false, reason: "INVALID_QUANTITY", message: "Each allocation needs a positive quantity." });
        const wh = whById.get(String(a.warehouseId));
        const loc = locStock.findLocation(wh, a.locationId);
        if (!wh || !loc || loc.status !== "Active" || loc.type !== reservationSvc.USABLE_TYPE) {
          return res.status(400).json({ success: false, reason: "INVALID_LOCATION", message: "Reserve only from active usable-stock locations." });
        }
        resolved.push({ wh, loc, qty, baseQty: reservationSvc.r4(qty * factor) });
      }

      // Refuse a duplicate active reservation for a DIFFERENT item (substitution
      // must release the old reservation first — never a silent rematch).
      const current = await StockReservation.findOne({ companyId: req.tenant.companyId, mrfLineId: line._id, active: true });
      if (current && !sameIdLocal(current.rawItemId, line.rawItem)) {
        return res.status(409).json({ success: false, reason: "SUBSTITUTION_REQUIRES_RELEASE", message: "This line is reserved against a different item. Release that reservation before reserving a substitute." });
      }

      if (req.idempotent?.record) await require("../../../../services/storePurchase/idempotency.service").markEffectApplied({ record: req.idempotent.record, entityType: MRF_ENTITY, entityId: mrf._id });

      let saved = null;
      await unitOfWork.run(req.tenant, {
        idempotencyRecord: req.idempotent?.record, entityType: MRF_ENTITY, entityId: mrf._id,
        mutate: async (session) => {
          const doc = current || new StockReservation({
            companyId: req.tenant.companyId, siteId: req.tenant.siteId || null,
            mrfId: mrf._id, mrfNumber: mrf.mrfNumber, mrfLineId: line._id,
            requestedForName: mrf.requestedForName || "", requestedForDept: mrf.requestedForDept || "", neededBy: mrf.neededBy || null,
            rawItemId: line.rawItem, variantId: line.variantId || null, variantCombination: line.variantCombination || [],
            itemName: line.rawItemName, sku: line.rawItemSku,
            unit: line.unit, requestedQty: line.requestedQty, baseUnit, conversionFactor: factor, requestedBaseQty: reservationSvc.r4(line.requestedQty * factor),
            allocations: [], reservedBy: req.user?.id || null, reservedByName: actorName(req), reservedAt: new Date(),
          });

          const placed = [];
          for (const rz of resolved) {
            const onHand = await locStock.locationOnHand(session, req.tenant.companyId, line.rawItem, line.variantId || null, rz.wh._id, rz.loc._id);
            // Atomic guard — the serialization point. Refuses more than availability.
            const ok = await reservationSvc.reserveAtLocation({
              session, companyId: req.tenant.companyId, itemId: line.rawItem, variantId: line.variantId || null,
              warehouseId: rz.wh._id, locationId: rz.loc._id, requestedBase: rz.baseQty, onHand,
            });
            if (!ok) throw fail("VALIDATION", `${rz.loc.code} does not have ${rz.qty} ${line.unit} available to reserve.`, { reason: "INSUFFICIENT_AVAILABILITY", locationCode: rz.loc.code });
            // Merge into an existing allocation for the same location, or add one.
            const found = doc.allocations.find((x) => sameIdLocal(x.locationId, rz.loc._id));
            if (found) { found.reservedQty = reservationSvc.r4(found.reservedQty + rz.qty); found.reservedBaseQty = reservationSvc.r4(found.reservedBaseQty + rz.baseQty); }
            else doc.allocations.push({ warehouseId: rz.wh._id, warehouseName: rz.wh.name || "", warehouseShortName: rz.wh.shortName || "", locationId: rz.loc._id, locationCode: rz.loc.code || "", locationName: rz.loc.name || "", reservedQty: rz.qty, reservedBaseQty: rz.baseQty });
            placed.push({ locationCode: rz.loc.code, qty: rz.qty, baseQty: rz.baseQty });
          }

          Object.assign(doc, reservationSvc.rollUp(doc));
          doc.idempotencyKey = req.idempotent?.key || "";
          doc.history.push({ action: "RESERVE", qty: reservationSvc.r4(placed.reduce((t, p) => t + p.qty, 0)), baseQty: reservationSvc.r4(placed.reduce((t, p) => t + p.baseQty, 0)), byId: req.user?.id || null, byName: actorName(req), reason: req.body?.reason || "", allocations: placed });
          await doc.save(session ? { session } : {});
          saved = doc.toObject();
          return { entityType: MRF_ENTITY, entityId: mrf._id, result: doc, entry: { entityType: MRF_ENTITY, entityId: mrf._id, documentNumber: mrf.mrfNumber, action: "STOCK_RESERVED", requestId: req.id || "", idempotencyKey: req.idempotent?.key || "", metadata: { mrfLineId: String(line._id), reservedQty: reservationSvc.r4(placed.reduce((t, p) => t + p.qty, 0)) } } };
        },
      });

      const body = { success: true, message: saved.backorderedQty > reservationSvc.TOL ? "Reserved what was available; the remainder is backordered." : "Stock reserved.", reservation: reservationView(saved) };
      return req.idempotent ? await req.idempotent.succeed(201, body, { entityType: MRF_ENTITY, entityId: mrf._id }) : res.status(201).json(body);
    } catch (e) {
      if (e?.name === "StorePurchaseError") return sendError(res, e);
      console.error("[mrf-reserve]", e);
      res.status(500).json({ success: false, message: e.message });
    }
  });

// Load one active reservation within the tenant, or 404.
async function loadReservation(req, reservationId, { lean = false } = {}) {
  const q = StockReservation.findOne({ _id: reservationId, companyId: req.tenant.companyId });
  const doc = lean ? await q.lean() : await q;
  if (!doc) throw fail("NOT_FOUND", "That reservation was not found.");
  return doc;
}

// ── POST /:id/reservations/:reservationId/pick — record the gathered quantity ──
// Pick = stock physically gathered and HELD against the reservation. It posts NO
// movement and does not change on-hand — the reserved stock stays in its location
// until issue. (pickedQty is a field on the record, never a false location balance.)
router.post("/:id/reservations/:reservationId/pick",
  requireCapability(CAPABILITIES.MRF_FULFIL), refuseLegacyWrite,
  async (req, res) => {
    try {
      const r = await loadReservation(req, req.params.reservationId);
      if (String(r.mrfId) !== String(req.params.id)) return res.status(404).json({ success: false, message: "That reservation is not part of this request." });
      const active = reservationSvc.r4(Math.max(0, (r.reservedQty || 0) - (r.issuedQty || 0) - (r.releasedQty || 0)));
      const qty = Number(req.body?.qty);
      if (!(qty > 0)) return res.status(400).json({ success: false, reason: "INVALID_QUANTITY", message: "A positive picked quantity is required." });
      if (qty > active + reservationSvc.TOL) return res.status(400).json({ success: false, reason: "OVER_PICK", message: `Only ${active} ${r.unit} is reserved and available to pick.` });
      r.pickedQty = reservationSvc.r4(Math.max(r.pickedQty || 0, qty));
      r.history.push({ action: "PICK", qty, byId: req.user?.id || null, byName: actorName(req), reason: req.body?.reason || "" });
      await r.save();
      res.json({ success: true, message: "Pick recorded (stock held against the reservation, not yet issued).", reservation: reservationView(r.toObject()) });
    } catch (e) {
      if (e?.name === "StorePurchaseError") return sendError(res, e);
      res.status(500).json({ success: false, message: e.message });
    }
  });

// ── POST /:id/reservations/:reservationId/release — release unissued reserved ──
// Restores availability immediately; on-hand is unchanged; the record is never
// deleted. Refuses releasing more than the unissued reserved balance.
router.post("/:id/reservations/:reservationId/release",
  requireCapability(CAPABILITIES.MRF_FULFIL), refuseLegacyWrite,
  withIdempotency("MRF_RESERVE_RELEASE", { target: (req) => req.params.reservationId }),
  async (req, res) => {
    try {
      const r = await loadReservation(req, req.params.reservationId);
      if (String(r.mrfId) !== String(req.params.id)) return res.status(404).json({ success: false, message: "That reservation is not part of this request." });
      const active = reservationSvc.r4(Math.max(0, (r.reservedQty || 0) - (r.issuedQty || 0) - (r.releasedQty || 0)));
      if (active <= reservationSvc.TOL) return res.status(400).json({ success: false, reason: "NOTHING_TO_RELEASE", message: "This reservation has no unissued reserved quantity to release." });
      const cancel = req.body?.cancel === true;
      let want = cancel ? active : Number(req.body?.qty);
      if (!cancel && !(want > 0)) return res.status(400).json({ success: false, reason: "INVALID_QUANTITY", message: "A positive release quantity is required." });
      if (want > active + reservationSvc.TOL) return res.status(400).json({ success: false, reason: "OVER_RELEASE", message: `Only ${active} ${r.unit} can be released.` });
      const factor = Number(r.conversionFactor) || 1;

      if (req.idempotent?.record) await require("../../../../services/storePurchase/idempotency.service").markEffectApplied({ record: req.idempotent.record, entityType: MRF_ENTITY, entityId: r.mrfId });

      let saved = null;
      await unitOfWork.run(req.tenant, {
        idempotencyRecord: req.idempotent?.record, entityType: MRF_ENTITY, entityId: r.mrfId,
        mutate: async (session) => {
          const doc = await StockReservation.findById(r._id).session(session || null);
          let remaining = reservationSvc.r4(want);
          const touched = [];
          for (const a of doc.allocations) {
            if (remaining <= reservationSvc.TOL) break;
            const aActive = reservationSvc.r4(Math.max(0, (a.reservedQty || 0) - (a.issuedQty || 0) - (a.releasedQty || 0)));
            if (aActive <= reservationSvc.TOL) continue;
            const take = reservationSvc.r4(Math.min(aActive, remaining));
            const takeBase = reservationSvc.r4(take * factor);
            // Just decrement the reservation projection — LocationBalance is untouched.
            await reservationSvc.reduceReservationAtLocation({ session, companyId: doc.companyId, itemId: doc.rawItemId, variantId: doc.variantId || null, warehouseId: a.warehouseId, locationId: a.locationId, baseQty: takeBase });
            a.releasedQty = reservationSvc.r4((a.releasedQty || 0) + take);
            remaining = reservationSvc.r4(remaining - take);
            touched.push({ locationCode: a.locationCode, qty: take, baseQty: takeBase });
          }
          Object.assign(doc, reservationSvc.rollUp(doc));
          doc.releasedBy = req.user?.id || null; doc.releasedByName = actorName(req); doc.releasedAt = new Date();
          doc.history.push({ action: cancel ? "CANCEL" : "RELEASE", qty: reservationSvc.r4(touched.reduce((t, x) => t + x.qty, 0)), byId: req.user?.id || null, byName: actorName(req), reason: req.body?.reason || "", allocations: touched });
          if (cancel && doc.status === "RELEASED") doc.status = "CANCELLED";
          doc.active = doc.status === "RELEASED" || doc.status === "CANCELLED" || doc.status === "ISSUED" ? false : doc.active;
          await doc.save(session ? { session } : {});
          saved = doc.toObject();
          return { entityType: MRF_ENTITY, entityId: r.mrfId, result: doc, entry: { entityType: MRF_ENTITY, entityId: r.mrfId, documentNumber: doc.mrfNumber, action: "RESERVATION_RELEASED", requestId: req.id || "", idempotencyKey: req.idempotent?.key || "", metadata: { reservationId: String(doc._id), releasedQty: want } } };
        },
      });
      const body = { success: true, message: "Reservation released — availability restored, on-hand unchanged.", reservation: reservationView(saved) };
      return req.idempotent ? await req.idempotent.succeed(200, body, { entityType: MRF_ENTITY, entityId: r.mrfId }) : res.json(body);
    } catch (e) {
      if (e?.name === "StorePurchaseError") return sendError(res, e);
      console.error("[mrf-reserve-release]", e);
      res.status(500).json({ success: false, message: e.message });
    }
  });

// ── POST /:id/reservations/:reservationId/issue — controlled issue ────────────
// Consumes the reservation and issues through THIS file's adjustStock engine:
// one location deduction + one company on-hand reduction + one LocationMovement,
// the reserved quantity reduced, the MRF line's issuedQty raised. Partial
// supported; the remaining reservation/backorder stays visible.
router.post("/:id/reservations/:reservationId/issue",
  requireCapability(CAPABILITIES.STOCK_ISSUE), refuseLegacyWrite,
  withIdempotency("MRF_RESERVE_ISSUE", { target: (req) => req.params.reservationId }),
  async (req, res) => {
    try {
      const mrf = await loadMrf(req, req.params.id);
      const r = await loadReservation(req, req.params.reservationId);
      if (String(r.mrfId) !== String(mrf._id)) return res.status(404).json({ success: false, message: "That reservation is not part of this request." });
      const line = mrf.items.id(r.mrfLineId);
      if (!line) return res.status(409).json({ success: false, reason: "PROVENANCE_CONFLICT", message: "The reserved line is no longer on this request." });
      // Never accept a client-supplied replacement item — issue the reserved item.
      if (!sameIdLocal(line.rawItem, r.rawItemId) || !sameIdLocal(line.variantId, r.variantId)) {
        return res.status(409).json({ success: false, reason: "SUBSTITUTION_REQUIRES_RELEASE", message: "The line's matched item/variant differs from the reservation. Release and reserve the correct item first." });
      }
      const active = reservationSvc.r4(Math.max(0, (r.reservedQty || 0) - (r.issuedQty || 0) - (r.releasedQty || 0)));
      if (active <= reservationSvc.TOL) return res.status(400).json({ success: false, reason: "NOTHING_TO_ISSUE", message: "This reservation has no reserved quantity left to issue." });
      const want = req.body?.qty != null ? Number(req.body.qty) : active;
      if (!(want > 0)) return res.status(400).json({ success: false, reason: "INVALID_QUANTITY", message: "A positive issue quantity is required." });
      if (want > active + reservationSvc.TOL) return res.status(400).json({ success: false, reason: "OVER_ISSUE", message: `Only ${active} ${r.unit} is reserved and available to issue.` });

      if (req.idempotent?.recovering) {
        // Idempotent replay is handled by the marker; recovery just surfaces state.
        const fresh = await StockReservation.findById(r._id).lean();
        return await req.idempotent.succeed(200, { success: true, message: "This issue was already recorded.", reservation: reservationView(fresh) }, { entityType: MRF_ENTITY, entityId: mrf._id });
      }

      // Resolve each allocation's warehouse/location for the movement snapshot.
      const warehouses = await companyWarehouses(req);
      const whById = new Map(warehouses.map((w) => [String(w._id), w]));
      const factor = Number(r.conversionFactor) || 1;
      // Plan issue across allocations, oldest first, up to `want`.
      let remaining = reservationSvc.r4(want);
      const plans = []; const consume = [];
      for (const a of r.allocations) {
        if (remaining <= reservationSvc.TOL) break;
        const aActive = reservationSvc.r4(Math.max(0, (a.reservedQty || 0) - (a.issuedQty || 0) - (a.releasedQty || 0)));
        if (aActive <= reservationSvc.TOL) continue;
        const take = reservationSvc.r4(Math.min(aActive, remaining));
        const takeBase = reservationSvc.r4(take * factor);
        const wh = whById.get(String(a.warehouseId));
        const loc = locStock.findLocation(wh, a.locationId);
        if (!wh || !loc) return res.status(409).json({ success: false, reason: "LOCATION_MISSING", message: `The reserved location ${a.locationCode} no longer exists.` });
        plans.push({
          rawItemId: r.rawItemId, variantId: r.variantId || null, variantCombination: r.variantCombination || [],
          delta: -takeBase,
          txnMeta: { type: r.variantId ? "VARIANT_REDUCE" : "REDUCE", quantity: takeBase, reason: `MRF Issue — ${mrf.mrfNumber}`, performedBy: req.user?.id || null },
          loc: {
            companyId: req.tenant.companyId, siteId: req.tenant.siteId || null, warehouse: wh, location: loc, type: "issue",
            source: { kind: "mrf_issue", id: mrf._id, reference: mrf.mrfNumber },
            actor: { id: req.user?.id || null, name: actorName(req) },
            idempotencyKey: locStock.movementLineKey(req.idempotent?.key || "", `${String(r._id)}:${String(a.locationId)}`, "issue"),
            operationKey: req.idempotent?.key || "",
          },
        });
        consume.push({ allocId: String(a._id), warehouseId: a.warehouseId, locationId: a.locationId, take, takeBase, locationCode: a.locationCode });
        remaining = reservationSvc.r4(remaining - take);
      }

      if (req.idempotent?.record) await require("../../../../services/storePurchase/idempotency.service").markEffectApplied({ record: req.idempotent.record, entityType: MRF_ENTITY, entityId: mrf._id });

      let savedRes = null;
      await unitOfWork.run(req.tenant, {
        idempotencyRecord: req.idempotent?.record, entityType: MRF_ENTITY, entityId: mrf._id,
        mutate: async (session) => {
          // 1) The ONE stock engine: deduct location + company on-hand + movement.
          await applyStockPlans(plans, session);
          // 2) Consume the reservation projection + record (same unit of work).
          const doc = await StockReservation.findById(r._id).session(session || null);
          for (const c of consume) {
            await reservationSvc.reduceReservationAtLocation({ session, companyId: doc.companyId, itemId: doc.rawItemId, variantId: doc.variantId || null, warehouseId: c.warehouseId, locationId: c.locationId, baseQty: c.takeBase });
            const a = doc.allocations.id(c.allocId);
            if (a) a.issuedQty = reservationSvc.r4((a.issuedQty || 0) + c.take);
          }
          doc.pickedQty = reservationSvc.r4(Math.max(doc.pickedQty || 0, (doc.issuedQty || 0) + want));
          Object.assign(doc, reservationSvc.rollUp(doc));
          doc.history.push({ action: "ISSUE", qty: reservationSvc.r4(want - remaining), baseQty: reservationSvc.r4((want - remaining) * factor), byId: req.user?.id || null, byName: actorName(req), reason: req.body?.reason || "", allocations: consume.map((c) => ({ locationCode: c.locationCode, qty: c.take, baseQty: c.takeBase })) });
          await doc.save(session ? { session } : {});
          savedRes = doc.toObject();

          // 3) The MRF line's issuedQty rises through the SAME status machinery.
          const mrfDoc = await MRF.findById(mrf._id).session(session || null);
          const it = mrfDoc.items.id(r.mrfLineId);
          const targetIssued = reservationSvc.r4((it.issuedQty || 0) + (want - remaining));
          const targetStatus = targetIssued >= (it.requestedQty || 0) - reservationSvc.TOL ? "ISSUED" : "PARTIALLY_ISSUED";
          applyItemIssueTargets(mrfDoc, [{ mrfItemId: it._id, targetIssuedQty: targetIssued, targetItemStatus: targetStatus, issueHistoryEntry: { issuedQty: reservationSvc.r4(want - remaining), notes: `Issued from reservation`, recordedBy: req.user?.id || null, recordedAt: new Date() } }]);
          mrfDoc.status = issueStatusOf(mrfDoc).status;
          mrfDoc.logEvent({ action: "ISSUED", actorName: actorName(req), actorRole: "store", detail: `Issued ${reservationSvc.r4(want - remaining)} ${r.unit} from reservation` });
          await mrfDoc.save(session ? { session } : {});

          return { entityType: MRF_ENTITY, entityId: mrf._id, result: doc, entry: { entityType: MRF_ENTITY, entityId: mrf._id, documentNumber: mrf.mrfNumber, action: "ISSUED", requestId: req.id || "", idempotencyKey: req.idempotent?.key || "", metadata: { reservationId: String(r._id), issuedQty: reservationSvc.r4(want - remaining) } } };
        },
      });

      const body = { success: true, message: "Stock issued from the reservation.", reservation: reservationView(savedRes) };
      return req.idempotent ? await req.idempotent.succeed(201, body, { entityType: MRF_ENTITY, entityId: mrf._id }) : res.status(201).json(body);
    } catch (e) {
      if (e?.name === "StorePurchaseError") return sendError(res, e);
      console.error("[mrf-reserve-issue]", e);
      res.status(500).json({ success: false, message: e.message });
    }
  });

// ── GET /:id/reservations — the reservations for one MRF ──────────────────────
router.get("/:id/reservations", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const mrf = await loadMrf(req, req.params.id, { lean: true });
    const rows = await StockReservation.find({ companyId: req.tenant.companyId, mrfId: mrf._id }).sort({ createdAt: 1 }).lean();
    res.json({ success: true, reservations: rows.map(reservationView) });
  } catch (e) {
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /:id/reservations/:reservationId/pick-list — the pick list ────────────
router.get("/:id/reservations/:reservationId/pick-list", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const r = await loadReservation(req, req.params.reservationId, { lean: true });
    if (String(r.mrfId) !== String(req.params.id)) return res.status(404).json({ success: false, message: "That reservation is not part of this request." });
    const view = reservationView(r);
    res.json({
      success: true,
      pickList: {
        mrfNumber: r.mrfNumber, requestedForName: r.requestedForName, requestedForDept: r.requestedForDept, neededBy: r.neededBy,
        item: view.item, unit: r.unit, baseUnit: r.baseUnit, conversionFactor: r.conversionFactor,
        // Lot-level picking is not available — location stock is not lot-controlled here.
        lotPicking: { available: false, note: "Lot-level picking is not available for this stock record." },
        lines: view.allocations.map((a) => ({
          warehouseName: a.warehouseName, warehouseShortName: a.warehouseShortName, locationCode: a.locationCode, locationName: a.locationName,
          reservedQty: a.reservedQty, activeQty: a.activeQty, issuedQty: a.issuedQty, unit: r.unit,
        })),
        reservedQty: view.reservedQty, pickedQty: view.pickedQty, issuedQty: view.issuedQty, remaining: view.activeReservedQty,
      },
    });
  } catch (e) {
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /reservations/queue — the Reservations & Picking workspace ────────────
// Server-side filtered + paged. Rows are reservations (all groups) PLUS approved
// stock lines with no active reservation ("Ready to reserve"). Bounded scan.
router.get("/reservations/queue", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const q = req.query || {};
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize, 10) || 25));
    const CAP = 500;

    // 1) All reservations for the company (bounded, newest first).
    const reservations = await StockReservation.find({ companyId: req.tenant.companyId }).sort({ updatedAt: -1 }).limit(CAP).lean();
    const reservedLineIds = new Set(reservations.filter((r) => r.active).map((r) => String(r.mrfLineId)));

    // 2) Approved stock lines with no active reservation → "Ready to reserve".
    const mrfs = await MRF.find({
      ...tenantContext.tenantFilter(req.tenant),
      status: { $in: ["APPROVED", "PARTIALLY_ISSUED"] },
    }).select("mrfNumber requestedForName requestedForDept neededBy status fulfilmentDecision items").sort({ neededBy: 1, createdAt: -1 }).limit(CAP).lean();

    const rows = [];
    for (const r of reservations) {
      const v = reservationView(r);
      rows.push({
        kind: "reservation", reservationId: v.id, mrfId: v.mrfId, mrfNumber: v.mrfNumber, mrfLineId: v.mrfLineId,
        requestedForName: v.requestedForName, requestedForDept: v.requestedForDept, neededBy: v.neededBy,
        item: v.item, unit: v.unit, requestedQty: v.requestedQty, reservedQty: v.reservedQty, activeReservedQty: v.activeReservedQty,
        issuedQty: v.issuedQty, backorderedQty: v.backorderedQty, status: v.status, group: v.group,
        allocations: v.allocations.map((a) => ({ warehouseShortName: a.warehouseShortName, locationCode: a.locationCode, activeQty: a.activeQty })),
      });
    }
    for (const m of mrfs) {
      if (m.fulfilmentDecision === "buy_or_service") continue;
      for (const it of (m.items || [])) {
        if (!it.rawItem) continue;
        if (["REJECTED", "UNFULFILLED", "ISSUED", "RETURNED"].includes(it.itemStatus)) continue;
        if ((it.issuedQty || 0) >= (it.requestedQty || 0) - reservationSvc.TOL) continue;
        if (reservedLineIds.has(String(it._id))) continue;
        rows.push({
          kind: "line", mrfId: String(m._id), mrfNumber: m.mrfNumber, mrfLineId: String(it._id),
          requestedForName: m.requestedForName || "", requestedForDept: m.requestedForDept || "", neededBy: m.neededBy || null,
          item: { rawItemId: String(it.rawItem), name: it.rawItemName, sku: it.rawItemSku, variantId: it.variantId ? String(it.variantId) : null, variant: (it.variantCombination || []).join(" • ") },
          unit: it.unit, requestedQty: it.requestedQty, reservedQty: 0, activeReservedQty: 0, issuedQty: it.issuedQty || 0, backorderedQty: 0,
          status: "UNRESERVED", group: "READY_TO_RESERVE", allocations: [],
        });
      }
    }

    // Filters (derived, in memory over the bounded set).
    let filtered = rows;
    if (q.group) filtered = filtered.filter((r) => r.group === q.group);
    if (q.department) filtered = filtered.filter((r) => (r.requestedForDept || "").toLowerCase() === String(q.department).toLowerCase());
    if (q.warehouse) filtered = filtered.filter((r) => (r.allocations || []).some((a) => (a.warehouseShortName || "").toLowerCase() === String(q.warehouse).toLowerCase()));
    if (q.status) filtered = filtered.filter((r) => r.status === q.status);
    if (q.requiredBy && !Number.isNaN(Date.parse(q.requiredBy))) { const by = new Date(q.requiredBy); filtered = filtered.filter((r) => r.neededBy && new Date(r.neededBy) <= by); }
    const search = typeof q.search === "string" ? q.search.trim().toLowerCase() : "";
    if (search) filtered = filtered.filter((r) => [r.mrfNumber, r.item.name, r.item.sku, r.requestedForName].filter(Boolean).some((s) => String(s).toLowerCase().includes(search)));

    const groupOrder = reservationSvc.GROUPS;
    filtered.sort((a, b) => {
      const ga = (groupOrder[a.group]?.order || 99), gb = (groupOrder[b.group]?.order || 99);
      if (ga !== gb) return ga - gb;
      const na = a.neededBy ? new Date(a.neededBy).getTime() : Infinity;
      const nb = b.neededBy ? new Date(b.neededBy).getTime() : Infinity;
      if (na !== nb) return na - nb;
      return String(a.mrfNumber).localeCompare(String(b.mrfNumber));
    });

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = (Math.min(page, totalPages) - 1) * pageSize;
    const paged = filtered.slice(start, start + pageSize);
    const counts = {};
    for (const gk of Object.keys(groupOrder)) counts[gk] = filtered.filter((r) => r.group === gk).length;

    res.json({
      success: true,
      queue: {
        rows: paged,
        groups: Object.fromEntries(Object.entries(groupOrder).map(([k, v]) => [k, v.label])),
        counts,
        pagination: { page: Math.min(page, totalPages), pageSize, total, totalPages, scope: "inspectedSet" },
        coverage: { scannedReservations: reservations.length, scannedRequests: mrfs.length, scanCap: CAP, truncated: reservations.length >= CAP || mrfs.length >= CAP },
      },
    });
  } catch (e) {
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    console.error("[mrf-reservation-queue]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;