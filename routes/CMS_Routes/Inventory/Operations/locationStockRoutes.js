// routes/CMS_Routes/Inventory/Operations/locationStockRoutes.js
//
// Warehouse Stock V1 — make warehouse/location records operational.
// Mount: app.use("/api/cms/inventory/locations", require("./routes/..."))
//
// Answers "which warehouse/location holds this item?" from an immutable
// location ledger, WITHOUT becoming a second on-hand authority:
//   · RawItem.quantity stays the company-wide on-hand total;
//   · a location's balance is DERIVED by replaying applied LocationMovements
//     (a guarded LocationBalance projection makes concurrent placement safe);
//   · this router ONLY places stock that already exists — assign (legacy /
//     unplaced stock) and transfer (between locations) — never changing the
//     company total. Receipts and issues that DO change the company total run
//     through the canonical operations (PO receipt, stock adjustment, MRF,
//     returns), which now capture location in their own unit of work; the old
//     standalone /receipt and /issue are retired (410).
// Legacy stock with no location history reads as "Unassigned", never zero and
// never guessed onto some warehouse.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../../../models/CMS_Models/Inventory/Configurations/Warehouse");
const LocationMovement = require("../../../../models/CMS_Models/Inventory/Operations/LocationMovement");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const {
  requireTenant, requireCapability, refuseLegacyWrite, withIdempotency,
} = require("../../../../Middlewear/storePurchaseTenant");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const { CAPABILITIES } = tenantContext;
const unitOfWork = require("../../../../services/storePurchase/unitOfWork.service");
const idempotency = require("../../../../services/storePurchase/idempotency.service");
const actionHistory = require("../../../../services/storePurchase/actionHistory.service");
const { fail, sendError } = require("../../../../services/storePurchase/errors");
const loc = require("../../../../services/storePurchase/locationStock.service");

const ENTITY = "LOCATION_MOVEMENT";

router.use(EmployeeAuthMiddleware);
router.use(requireTenant);

const scoped = (req, extra = {}) => {
  const tenant = tenantContext.tenantFilter(req.tenant);
  const clauses = [tenant];
  if (extra && Object.keys(extra).length) clauses.push(extra);
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
};
const objectId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null);
const strictQty = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? loc.round4(n) : null;
};

// The same MARKED-safe wrapper the other stock routes use: settle the mode
// before any write, mark the effect before the first irreversible one.
async function runStockMutation(req, { mutate }) {
  if (await unitOfWork.transactionsAvailable()) {
    return unitOfWork.run(req.tenant, { idempotencyRecord: req.idempotent?.record || null, mutate });
  }
  if (req.idempotent?.record) {
    await idempotency.markEffectApplied({ record: req.idempotent.record, entityType: ENTITY, entityId: null });
  }
  const { entry, result, entityId, entityType } = await mutate(null);
  await actionHistory.record(req.tenant, { ...entry, atomicityDegraded: true });
  if (req.idempotent?.record) {
    await idempotency.markEffectApplied({ record: req.idempotent.record, entityType: entityType || ENTITY, entityId });
  }
  return { result, mode: "MARKED" };
}

// Load the item (tenant-scoped) or 404; resolve the variant if asked.
async function loadItem(req, rawItemId, variantId) {
  const oid = objectId(rawItemId);
  if (!oid) throw fail("VALIDATION", "A valid item id is required.", { reason: "INVALID_ITEM" });
  const item = await RawItem.findOne(scoped(req, { _id: oid })).lean();
  if (!item) throw fail("NOT_FOUND", "Item not found in this company.", { reason: "ITEM_NOT_FOUND" });
  let variant = null;
  if (variantId) {
    const vid = objectId(variantId);
    variant = vid ? (item.variants || []).find((v) => String(v._id) === String(vid)) : null;
    if (!variant) throw fail("NOT_FOUND", "Variant not found on this item.", { reason: "VARIANT_NOT_FOUND" });
  }
  return { item, variant, variantId: variant ? String(variant._id) : null };
}

// Resolve an ACTIVE location in this company, or refuse with a clear reason.
async function loadActiveLocation(req, warehouseId, locationId) {
  const wid = objectId(warehouseId);
  const warehouse = wid ? await Warehouse.findOne(scoped(req, { _id: wid })).lean() : null;
  const location = loc.findLocation(warehouse, locationId);
  const err = loc.usableLocationError(warehouse, location, req.tenant.companyId);
  if (err) throw fail("VALIDATION", err.message, { reason: err.reason });
  return { warehouse, location };
}

// Applied movements for one item (+variant), scoped to the company.
async function movementsFor(req, itemId, variantId) {
  return LocationMovement.find(scoped(req, {
    itemId: objectId(itemId),
    variantId: variantId ? objectId(variantId) : null,
  })).lean();
}

// ── GET /item/:id — total on hand, assigned by location, and unassigned ──────
router.get("/item/:id", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const { item } = await loadItem(req, req.params.id, null);
    const variants = Array.isArray(item.variants) ? item.variants : [];

    async function forScope(variantId) {
      const movements = await movementsFor(req, item._id, variantId);
      const balances = loc.deriveLocationBalances(movements);
      const onHand = loc.onHandOf(item, variantId);
      return { ...loc.reconcile({ onHand, balances }), balances };
    }

    const whole = await forScope(null);
    const perVariant = [];
    for (const v of variants) {
      const r = await forScope(String(v._id));
      perVariant.push({ variantId: String(v._id), sku: v.sku || "", combination: v.combination || [], ...r });
    }

    res.json({
      success: true,
      itemId: String(item._id),
      sku: item.sku || "",
      name: item.name || "",
      baseUnit: loc.baseUnitOf(item),
      item: whole, // { onHand, assigned, unassigned, overAssigned, balances[] }
      variants: perVariant,
    });
  } catch (e) {
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    console.error("[location-stock] item:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /warehouse/:id — items held in each location of a warehouse ──────────
router.get("/warehouse/:id", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const wid = objectId(req.params.id);
    const warehouse = wid ? await Warehouse.findOne(scoped(req, { _id: wid })).lean() : null;
    if (!warehouse) return res.status(404).json({ success: false, message: "Warehouse not found in this company." });

    const rows = await LocationMovement.find(scoped(req, { warehouseId: wid })).lean();
    // Group by location, then by item+variant, deriving on-hand per line.
    const byLoc = new Map();
    for (const m of rows) {
      if (m.applied === false) continue;
      const lk = String(m.locationId);
      if (!byLoc.has(lk)) byLoc.set(lk, new Map());
      const items = byLoc.get(lk);
      const ik = `${m.itemId}:${m.variantId || ""}`;
      const prev = items.get(ik) || { itemId: String(m.itemId), variantId: m.variantId ? String(m.variantId) : null, baseUnit: m.baseUnit || "", onHand: 0 };
      prev.onHand += m.direction === "in" ? Number(m.quantity) : -Number(m.quantity);
      items.set(ik, prev);
    }
    const locations = (warehouse.locations || []).map((l) => {
      const items = [...(byLoc.get(String(l._id))?.values() || [])]
        .map((x) => ({ ...x, onHand: loc.round4(x.onHand) }))
        .filter((x) => Math.abs(x.onHand) > loc.QTY_TOL);
      return { locationId: String(l._id), code: l.code, name: l.name, type: l.type, status: l.status, items };
    });

    res.json({ success: true, warehouseId: String(warehouse._id), name: warehouse.name, locations });
  } catch (e) {
    console.error("[location-stock] warehouse:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /assign — place unassigned stock into a location (total unchanged) ───
router.post("/assign", requireCapability(CAPABILITIES.STOCK_ADJUST), refuseLegacyWrite,
  withIdempotency("LOCATION_ASSIGN"), async (req, res) => {
  try {
    if (req.idempotent?.recovering) return replayed(req, res);
    const { rawItemId, variantId, warehouseId, locationId, note = "" } = req.body || {};
    const qty = strictQty(req.body?.quantity);
    if (qty === null) throw fail("VALIDATION", "Quantity must be a positive number.", { reason: "INVALID_QUANTITY" });

    const { item, variantId: vId } = await loadItem(req, rawItemId, variantId);
    const { warehouse, location } = await loadActiveLocation(req, warehouseId, locationId);

    // Assigned across locations may never exceed current on-hand.
    const balances = loc.deriveLocationBalances(await movementsFor(req, item._id, vId));
    const onHand = loc.onHandOf(item, vId);
    const assigned = loc.assignedTotalOf(balances);
    if (loc.round4(assigned + qty) > loc.round4(onHand) + loc.QTY_TOL) {
      throw fail("VALIDATION",
        `Cannot assign ${qty}: only ${loc.round4(onHand - assigned)} is unassigned for this item.`,
        { reason: "EXCEEDS_ON_HAND", onHand, assigned, requested: qty });
    }

    const { result } = await runStockMutation(req, {
      mutate: async (session) => {
        // ATOMIC headroom guard: two concurrent assignments cannot both spend
        // the same unassigned quantity — the guarded $inc refuses the loser.
        const ok = await loc.incAssignedTotal(session, req.tenant.companyId, item._id, vId, qty, onHand);
        if (!ok) {
          throw fail("VALIDATION",
            `Cannot assign ${qty}: it would place more than this item's on-hand of ${onHand}.`,
            { reason: "EXCEEDS_ON_HAND", onHand, requested: qty });
        }
        await loc.incLocation(session, req.tenant.companyId, item._id, vId, warehouse._id, location._id, qty);
        const mv = await loc.writeMovement(session, {
          ...tenantContext.stamp(req.tenant),
          ...loc.buildMovement({
            companyId: req.tenant.companyId, siteId: req.tenant.siteId, item, variantId: vId,
            warehouse, location, direction: "in", quantity: qty, type: "opening_assignment",
            source: { kind: "assignment", id: req.idempotent?.record?._id || null, reference: "" },
            actor: { id: req.user?.id, name: req.user?.name }, note, idempotencyKey: req.idempotent?.key || "",
          }),
        });
        return {
          entityType: ENTITY, entityId: mv._id,
          entry: { entityType: ENTITY, entityId: mv._id, documentNumber: String(mv._id), action: "STOCK_LOCATION_ASSIGNED", reason: note || "", requestId: req.id || "", idempotencyKey: req.idempotent?.key || "", metadata: { warehouseId: String(warehouse._id), locationId: String(location._id), quantity: qty } },
          result: { movement: mv.toObject() },
        };
      },
    });
    return succeed(req, res, 201, { success: true, movement: result.movement }, result.movement._id);
  } catch (e) { return handle(res, e, "assign"); }
});

// ── POST /transfer — move between two active locations (total unchanged) ──────
router.post("/transfer", requireCapability(CAPABILITIES.STOCK_ADJUST), refuseLegacyWrite,
  withIdempotency("LOCATION_TRANSFER"), async (req, res) => {
  try {
    if (req.idempotent?.recovering) return replayed(req, res);
    const { rawItemId, variantId, fromWarehouseId, fromLocationId, toWarehouseId, toLocationId, note = "" } = req.body || {};
    const qty = strictQty(req.body?.quantity);
    if (qty === null) throw fail("VALIDATION", "Quantity must be a positive number.", { reason: "INVALID_QUANTITY" });
    if (String(fromWarehouseId) === String(toWarehouseId) && String(fromLocationId) === String(toLocationId)) {
      throw fail("VALIDATION", "Source and destination must be different.", { reason: "SAME_LOCATION" });
    }

    const { item, variantId: vId } = await loadItem(req, rawItemId, variantId);
    const from = await loadActiveLocation(req, fromWarehouseId, fromLocationId);
    const to = await loadActiveLocation(req, toWarehouseId, toLocationId);

    // Source must hold enough.
    const balances = loc.deriveLocationBalances(await movementsFor(req, item._id, vId));
    const srcBal = balances.find((b) => b.warehouseId === String(from.warehouse._id) && b.locationId === String(from.location._id));
    const srcOnHand = srcBal ? srcBal.onHand : 0;
    if (qty > loc.round4(srcOnHand) + loc.QTY_TOL) {
      throw fail("VALIDATION", `Source location holds only ${loc.round4(srcOnHand)}.`, { reason: "INSUFFICIENT_AT_SOURCE", available: loc.round4(srcOnHand), requested: qty });
    }

    const transferId = new mongoose.Types.ObjectId();
    const { result } = await runStockMutation(req, {
      mutate: async (session) => {
        const common = {
          companyId: req.tenant.companyId, siteId: req.tenant.siteId, item, variantId: vId,
          transferId, actor: { id: req.user?.id, name: req.user?.name }, note, idempotencyKey: req.idempotent?.key || "",
          source: { kind: "transfer", id: transferId, reference: "" },
        };
        // ATOMIC source guard: the loser of two concurrent transfers spending
        // the same source balance is refused, never driven below zero.
        const ok = await loc.decLocationGuarded(session, req.tenant.companyId, item._id, vId, from.warehouse._id, from.location._id, qty);
        if (!ok) {
          throw fail("VALIDATION", `Source location ${from.location.code} no longer holds ${qty}.`, { reason: "INSUFFICIENT_AT_SOURCE", requested: qty });
        }
        await loc.incLocation(session, req.tenant.companyId, item._id, vId, to.warehouse._id, to.location._id, qty);
        // Equal out/in legs, one transfer identity. Company total unchanged.
        await LocationMovement.create([
          { ...tenantContext.stamp(req.tenant), ...loc.buildMovement({ ...common, warehouse: from.warehouse, location: from.location, direction: "out", quantity: qty, type: "transfer_out" }) },
          { ...tenantContext.stamp(req.tenant), ...loc.buildMovement({ ...common, warehouse: to.warehouse, location: to.location, direction: "in", quantity: qty, type: "transfer_in" }) },
        ], { session, ordered: true });
        return {
          entityType: ENTITY, entityId: transferId,
          entry: { entityType: ENTITY, entityId: transferId, documentNumber: String(transferId), action: "STOCK_TRANSFERRED", reason: note || "", requestId: req.id || "", idempotencyKey: req.idempotent?.key || "", metadata: { transferId: String(transferId), quantity: qty } },
          result: { transferId: String(transferId), quantity: qty },
        };
      },
    });
    return succeed(req, res, 201, { success: true, transfer: result }, transferId);
  } catch (e) { return handle(res, e, "transfer"); }
});

// ── Retired standalone stock-changing endpoints ──────────────────────────────
// V1 shipped standalone /receipt and /issue that changed company stock (or
// pretended to) OUTSIDE the canonical operations, so valuation and history
// disagreed with on-hand. They are removed: a goods receipt goes through PO
// receipt or the stock-adjustment "in", and an issue goes through the canonical
// stock-adjustment / MRF issue — each now captures its location in the SAME
// unit of work. Placing already-counted stock is the /assign action.
const retired = (canonical) => (req, res) => res.status(410).json({
  success: false, reason: "ENDPOINT_RETIRED",
  message: `This standalone location endpoint was removed. Use ${canonical}; it records the stock movement, its evidence and the location together.`,
});
router.post("/receipt", retired("PO goods receipt or Stock adjustment (in)"));
router.post("/issue", retired("the Stock adjustment / issue operation"));

// ── shared success / replay / error plumbing ─────────────────────────────────
function succeed(req, res, status, body, entityId) {
  return req.idempotent
    ? req.idempotent.succeed(status, body, { entityType: ENTITY, entityId })
    : res.status(status).json(body);
}
async function replayed(req, res) {
  // The effect already landed under this key; do not re-run. Return a plain
  // acknowledgement (V1 keeps no separate document to echo).
  return req.idempotent.succeed(200, { success: true, replayed: true }, { entityType: ENTITY, entityId: req.idempotent.recovering?.entityId || null });
}
function handle(res, e, where) {
  if (e?.name === "StorePurchaseError") return sendError(res, e);
  console.error(`[location-stock] ${where}:`, e);
  return res.status(500).json({ success: false, message: e.message });
}

module.exports = router;
