// routes/CMS_Routes/Inventory/Operations/returnRequests.js
//
// Supplier returns — Store & Purchase Chunk 1C.
//
// Mount as:
//   app.use("/api/cms/inventory/operations/purchase-orders/:poId/returns", returnRoutes);
//
//   GET    /                    → list the returns raised against a PO
//   POST   /                    → raise a return; deducts the damaged quantity
//   POST   /:returnId/receive   → record the vendor's replacement; credits stock
//   PATCH  /:returnId/cancel    → cancel an open return
//
// ── WHAT WAS WRONG WITH THIS FILE ───────────────────────────────────────────
// Three things, all of which move real stock:
//
//   · No company boundary at all. Every route did `PurchaseOrder.findById`, so
//     any signed-in employee could list, raise and settle returns against any
//     company's orders.
//   · Stock moved before the order was safely settled, with no idempotency
//     key. A retried "receive" credited the replacement twice; a retried
//     "create" deducted twice.
//   · The stock helper clamped with `Math.max(0, prev + delta)`. Deducting 40
//     from a shelf holding 10 silently wrote 0 and reported success — the
//     ledger and the shelf then disagreed by 30 units, and nothing recorded
//     that it had happened.
//
// All three mutations are now governed operations: tenant-scoped, capability
// gated, keyed, and committed through the unit of work so the stock movement
// and the record of it cannot come apart.

const express  = require("express");
const mongoose = require("mongoose");
const router   = express.Router({ mergeParams: true }); // mergeParams to get :poId
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem       = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse     = require("../../../../models/CMS_Models/Inventory/Configurations/Warehouse");
const locStock      = require("../../../../services/storePurchase/locationStock.service");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

const {
  requireTenant, requireCapability, refuseLegacyWrite, withIdempotency,
} = require("../../../../Middlewear/storePurchaseTenant");
const { CAPABILITIES } = require("../../../../services/storePurchase/capabilities");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const unitOfWork = require("../../../../services/storePurchase/unitOfWork.service");
const actionHistory = require("../../../../services/storePurchase/actionHistory.service");
const SpActionHistory = require("../../../../models/CMS_Models/StorePurchase/SpActionHistory");
const { fail, sendError } = require("../../../../services/storePurchase/errors");
// The canonical supplier-return stock mutation lives in ONE service so the Goods
// Receipt exception handoff reuses it rather than reproducing it. The concurrency
// seam moved there too; `at`/`moveStock` are used by the receive/cancel handlers
// below, and `__hooks` is re-exported so the existing return tests still register.
const supplierReturn = require("../../../../services/storePurchase/supplierReturn.service");
const { at, moveStock, frozenBaseFactor } = supplierReturn;
// The SAME strict Goods Receipt UoM resolver the receive flow uses — a PO-unit
// quantity is converted into the RawItem's registered base unit, refusing when a
// differing unit has no finite positive conversion. No second algorithm.
const { resolveConversion } = require("../../../../services/storePurchase/goodsReceipt.service");

const ENTITY = "PURCHASE_ORDER";

router.use(EmployeeAuthMiddleware);
/* Every route below is tenant-resolved. A caller whose company cannot be
   proved is refused here rather than handed an unscoped result. */
router.use(requireTenant);

/**
 * The order this return belongs to, or nothing.
 *
 * Scoped, never fetched globally and checked afterwards: an id from another
 * company must be indistinguishable from one that does not exist, and a
 * `findById` followed by a comparison is one forgotten `return` away from
 * leaking. Legacy-global orders (no `companyId`) are excluded from ordinary
 * reads by the same filter — they are reachable only in explicit legacy mode,
 * which no write may use.
 */
const loadPo = (req) => PurchaseOrder.findOne({
  _id: req.params.poId,
  ...tenantContext.tenantFilter(req.tenant),
});

/** The non-disclosing refusal every cross-company id gets. */
const notFound = (res, what = "Purchase order") =>
  res.status(404).json({ success: false, message: `${what} not found` });

/** Append-only history for a governed return mutation. */
const historyEntry = (req, po, entry) => ({
  entityType: ENTITY,
  entityId: po._id,
  documentNumber: po.poNumber,
  requestId: req.id || "",
  idempotencyKey: req.idempotent?.key || "",
  ...entry,
});

/**
 * Warehouse Stock V1 — resolve and validate an EXPLICIT warehouse/location a
 * store person chose for a supplier return (source) or a replacement receipt
 * (destination). Returns a lean `{ warehouse, location }`, or null when none was
 * named. A named-but-unusable location (inactive, foreign, or not in that
 * warehouse) throws — a source/destination is never guessed.
 */
async function resolveLocation(req, warehouseId, locationId) {
  if (!warehouseId || !locationId) {
    if (warehouseId || locationId) {
      throw fail("VALIDATION", "A location needs both a warehouse and a location.", { reason: "LOCATION_INCOMPLETE" });
    }
    return null;
  }
  const warehouse = await Warehouse.findOne({ _id: warehouseId, ...tenantContext.tenantFilter(req.tenant) }).lean();
  const location = locStock.findLocation(warehouse, locationId);
  const err = locStock.usableLocationError(warehouse, location, req.tenant.companyId);
  if (err) throw fail("VALIDATION", err.message, { reason: err.reason });
  return { warehouse, location };
}

/** Snapshot the source/destination onto a return / receipt subdocument. */
const sourceSnapshot = (loc) => (loc ? {
  sourceWarehouseId: loc.warehouse._id,
  sourceLocationId: loc.location._id,
  sourceWarehouseName: loc.warehouse.name || "",
  sourceWarehouseShortName: loc.warehouse.shortName || "",
  sourceLocationCode: loc.location.code || "",
  sourceLocationName: loc.location.name || "",
} : {});
const destSnapshot = (loc) => (loc ? {
  destWarehouseId: loc.warehouse._id,
  destLocationId: loc.location._id,
  destWarehouseName: loc.warehouse.name || "",
  destWarehouseShortName: loc.warehouse.shortName || "",
  destLocationCode: loc.location.code || "",
  destLocationName: loc.location.name || "",
} : {});

/**
 * Take one receipt back out of a return, atomically.
 *
 * Everything here is expressed relative to the document as MongoDB finds it,
 * never relative to a value this process read earlier:
 *
 *   · it matches only if this operation's receipt is still present, so a
 *     compensation cannot run twice or undo somebody else's receipt;
 *   · it subtracts that receipt's own quantity rather than assigning a total;
 *   · it derives PENDING / PARTIAL / COMPLETED from the quantities that
 *     result, so a receipt that succeeded in the meantime keeps its effect on
 *     the status.
 *
 * @returns {Promise<boolean>} whether the receipt was confirmed removed
 */
async function compensateReceipt({ poId, returnId, operationId, session = null }) {
  if (!operationId) return false;

  const q = PurchaseOrder.findOneAndUpdate(
    {
      _id: poId,
      returnRequests: {
        $elemMatch: { _id: returnId, "receipts.operationId": operationId },
      },
    },
    [{
      $set: {
        returnRequests: {
          $map: {
            input: "$returnRequests",
            as: "r",
            in: {
              $cond: [
                { $eq: ["$$r._id", returnId] },
                {
                  $let: {
                    vars: {
                      keptReceipts: {
                        $filter: {
                          input: { $ifNull: ["$$r.receipts", []] },
                          as: "rc",
                          cond: { $ne: ["$$rc.operationId", operationId] },
                        },
                      },
                      /* ── REVERSE WHAT WAS STORED, NOT WHAT WAS ASKED FOR ───
                       * The quantity used to come from the request that was
                       * failing. That is a value this process is holding, not
                       * the one the receipt actually recorded, and the two can
                       * only ever agree by luck. Summing the receipt being
                       * removed makes the compensation literally the inverse
                       * of the row it deletes: whatever went in comes out. */
                      removedQty: {
                        $sum: {
                          $map: {
                            input: {
                              $filter: {
                                input: { $ifNull: ["$$r.receipts", []] },
                                as: "rc",
                                cond: { $eq: ["$$rc.operationId", operationId] },
                              },
                            },
                            as: "rc",
                            in: { $ifNull: ["$$rc.quantityReceived", 0] },
                          },
                        },
                      },
                    },
                    in: {
                      $let: {
                        vars: {
                          returnedAfter: {
                            $subtract: [{ $ifNull: ["$$r.returnedQuantity", 0] }, "$$removedQty"],
                          },
                          pendingAfter: {
                            $add: [{ $ifNull: ["$$r.pendingReturnQty", 0] }, "$$removedQty"],
                          },
                        },
                        in: {
                          $mergeObjects: ["$$r", {
                            receipts: "$$keptReceipts",
                            returnedQuantity: "$$returnedAfter",
                            pendingReturnQty: "$$pendingAfter",
                            status: {
                              $cond: [
                                /* ── A CANCELLATION IS NOT UNDONE BY A ROLLBACK
                                 * Cancelled is terminal and somebody chose it.
                                 * Deriving a status from quantities would have
                                 * quietly reopened a return that a colleague
                                 * closed while this receipt was failing — the
                                 * rollback of one receipt silently overturning
                                 * a decision it has nothing to do with. */
                                { $eq: [{ $ifNull: ["$$r.status", "PENDING"] }, "CANCELLED"] },
                                "CANCELLED",
                                /* Otherwise derived, not restored: a receipt
                                   that landed meanwhile keeps its effect. */
                                {
                                  $switch: {
                                    branches: [
                                      { case: { $lte: ["$$pendingAfter", 0] }, then: "COMPLETED" },
                                      { case: { $gt: ["$$returnedAfter", 0] }, then: "PARTIAL" },
                                    ],
                                    default: "PENDING",
                                  },
                                },
                              ],
                            },
                          }],
                        },
                      },
                    },
                  },
                },
                "$$r",
              ],
            },
          },
        },
      },
    }],
    { new: true },
  );
  if (session) q.session(session);

  try {
    const updated = await q;
    return Boolean(updated);
  } catch (e) {
    console.error("[returns] receipt compensation failed:", e.message);
    return false;
  }
}

/** The operation this request is: stable across every retry of the same key. */
const operationIdOf = (req) => req.idempotent?.record?._id || null;

/**
 * Did THIS operation already move stock?
 *
 * Asked before doing anything, on every attempt — not only when the idempotency
 * record says `recovering`. In non-transactional mode a failure between the
 * stock save and the order save leaves no effect marker at all, so the record
 * is still merely IN_PROGRESS and will eventually be reclaimed as stale. The
 * stock ledger is the only place that remembers, and it remembers by operation.
 */
async function stockMovedBy(operationId) {
  if (!operationId) return false;
  return Boolean(await RawItem.exists({ "stockTransactions.operationId": operationId }));
}

// ═══════════════════════════════════════════════════════════════════════════
// GET / — the returns raised against this order
// ═══════════════════════════════════════════════════════════════════════════
router.get("/", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const po = await loadPo(req)
      .select("poNumber returnRequests companyId")
      .populate("returnRequests.reportedBy", "name")
      .populate("returnRequests.receipts.receivedBy", "name")
      .lean();

    if (!po) return notFound(res);

    res.json({ success: true, returnRequests: po.returnRequests || [] });
  } catch (err) {
    if (err?.name === "StorePurchaseError") return sendError(res, err);
    console.error("[returns GET /]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// POST / — raise a return, and take the damaged goods off the shelf
// Body: { poItemId, damagedQuantity, reason }
// ═══════════════════════════════════════════════════════════════════════════
router.post(
  "/",
  requireCapability(CAPABILITIES.STOCK_RETURN),
  refuseLegacyWrite,
  withIdempotency("PO_RETURN_CREATE"),
  async (req, res) => {
  try {
    const { poItemId, damagedQuantity, reason = "", warehouseId = null, locationId = null } = req.body;

    if (!poItemId) return res.status(400).json({ success: false, message: "poItemId required" });
    const dmgQty = parseFloat(damagedQuantity);
    if (isNaN(dmgQty) || dmgQty <= 0) {
      return res.status(400).json({ success: false, message: "Valid damagedQuantity required" });
    }

    const po = await loadPo(req);
    if (!po) return notFound(res);

    const operationId = operationIdOf(req);

    /* ── DID THIS OPERATION ALREADY RUN? ───────────────────────────────────
     * Matched on the operation id and nothing else. The previous version
     * looked for a return with the same (poItemId, damagedQuantity), so a
     * genuinely new return for the same item and quantity — the ordinary case
     * when a second box of the same delivery turns out to be damaged — was
     * mistaken for the earlier one, and the caller was told their new return
     * had been created when nothing had happened. */
    const mine = operationId
      ? (po.returnRequests || []).find((r) => String(r.operationId || "") === String(operationId))
      : null;

    /* Both halves have to be present before this counts as done. The return
       is written first now, so "the return exists" on its own no longer proves
       the stock came off the shelf — replaying success on that alone would
       report a deduction that never happened. */
    if (mine && !(await stockMovedBy(operationId))) {
      await unitOfWork.recover(req.tenant, {
        entityType: ENTITY,
        entityId: po._id,
        idempotencyKey: req.idempotent?.key || "",
        entry: historyEntry(req, po, {
          action: "RETURN_RECONCILIATION_REQUIRED",
          resultingState: po.status,
          reason: "The return was recorded but the damaged stock never came off the shelf.",
          metadata: { recovered: true, returnId: String(mine._id) },
        }),
      });
      throw fail(
        "LIFECYCLE_BLOCKED",
        "This return was interrupted after the order recorded it but before the damaged stock came off the shelf. Check the item's stock and correct the order — do not raise the return again.",
        { reason: "PARTIAL_RETURN_NEEDS_RECONCILIATION", poNumber: po.poNumber },
      );
    }

    if (mine) {
      /* The return exists and its stock moved. Whatever failed came after
         both, so repair the history if that is what went missing and answer as
         the first attempt would have. */
      await unitOfWork.recover(req.tenant, {
        entityType: ENTITY,
        entityId: po._id,
        idempotencyKey: req.idempotent?.key || "",
        entry: historyEntry(req, po, {
          action: "SUPPLIER_RETURN_RAISED",
          resultingState: mine.status,
          reason: mine.reason || "Damaged goods reported by store",
          metadata: { recovered: true, returnId: String(mine._id), damagedQuantity: mine.damagedQuantity },
        }),
      });
      const already = { success: true, message: "This return was already raised.", returnRequest: mine };
      return req.idempotent
        ? await req.idempotent.succeed(200, already, { entityType: ENTITY, entityId: po._id })
        : res.json(already);
    }

    /* Stock moved under this operation but the order never recorded the
       return: the two halves of one action came apart. Never re-run — say so
       and ask for a human, which is the honest answer on a deployment without
       transactions. */
    if (await stockMovedBy(operationId)) {
      await unitOfWork.recover(req.tenant, {
        entityType: ENTITY,
        entityId: po._id,
        idempotencyKey: req.idempotent?.key || "",
        entry: historyEntry(req, po, {
          action: "RETURN_RECONCILIATION_REQUIRED",
          resultingState: po.status,
          reason: "Stock was deducted but the order did not record the return.",
          metadata: { recovered: true, operationId: String(operationId) },
        }),
      });
      throw fail(
        "LIFECYCLE_BLOCKED",
        "This return was interrupted after the damaged stock came off the shelf but before the order recorded it. Check the item's stock and correct the order — do not raise the return again.",
        { reason: "PARTIAL_RETURN_NEEDS_RECONCILIATION", poNumber: po.poNumber },
      );
    }

    const poItem = po.items.id(poItemId);
    if (!poItem) return notFound(res, "PO item");

    /* ── WAREHOUSE STOCK V1: THE EXPLICIT SOURCE LOCATION ──────────────────
     * The damaged goods leave a specific location. If this item/variant is
     * location-tracked, a valid source is REQUIRED — never guessed from
     * Unassigned — and it must actually hold the quantity, checked HERE before
     * anything moves so an over-return at a location changes nothing. A legacy
     * (untracked) item keeps the existing company-level behaviour. */
    const loc = await resolveLocation(req, warehouseId, locationId);
    const scopeVariantId = poItem.variantId || null;
    if (!loc && await locStock.isLocationTracked(req.tenant.companyId, poItem.rawItem, scopeVariantId)) {
      return res.status(400).json({
        success: false,
        reason: "LOCATION_REQUIRED",
        message: `"${poItem.itemName}" is tracked by location — choose the warehouse and location to return it from.`,
      });
    }
    const rawUnit = await RawItem.findById(poItem.rawItem).select("unit customUnit").lean();

    /* ── ONE UNIT CONTRACT — business vs base ──────────────────────────────
     * The return is raised in the PO line's BUSINESS unit, but stock lives in the
     * RawItem's registered BASE unit. Convert once, fail closed on a missing/zero/
     * negative conversion, and use the BASE quantity for every stock decision —
     * the location sufficiency check, the RawItem deduction and the location move.
     * The returnable limit stays in business units. */
    const baseUnit = rawUnit?.customUnit || rawUnit?.unit || poItem.unit;
    const conv = await resolveConversion({ quantity: dmgQty, fromUnit: poItem.unit, toUnit: baseUnit });
    const baseQty = conv.baseQuantity;

    if (loc) {
      const onHand = await locStock.locationOnHand(
        null, req.tenant.companyId, poItem.rawItem, scopeVariantId, loc.warehouse._id, loc.location._id,
      );
      // Compare BASE quantity to the base-unit balance, and state both representations.
      if (baseQty > onHand + 1e-6) {
        return res.status(409).json({
          success: false,
          reason: "INSUFFICIENT_AT_LOCATION",
          message: `Returning ${dmgQty} ${poItem.unit} requires ${baseQty} ${baseUnit} at ${loc.location.code}, but only ${onHand} ${baseUnit} ${onHand === 1 ? "is" : "are"} recorded there.`,
        });
      }
    }

    /* ── WHAT IS STILL RETURNABLE ON THIS LINE ─────────────────────────────
     * Checking each return against the line's RECEIVED quantity in isolation
     * let two 15-unit returns be raised against a line that received 20: each
     * passed on its own, and 30 units came off a shelf that only ever got 20.
     *
     * Cancelled returns count towards the total, because cancelling does not
     * put the goods back — the stock stays deducted, so the quantity is spent
     * whatever the return's status says. */
    /* The subdocument is built here, with its own id, so the atomic push below
       stores exactly this and the stock movement can name it. */
    const newReturn = {
      _id: new mongoose.Types.ObjectId(),
      poItemId:          poItem._id,
      rawItem:           poItem.rawItem,
      itemName:          poItem.itemName,
      sku:               poItem.sku,
      unit:              poItem.unit,
      variantId:         poItem.variantId || null,
      variantCombination: poItem.variantCombination || [],
      damagedQuantity:   dmgQty,          // BUSINESS quantity, in `unit`
      returnedQuantity:  0,
      pendingReturnQty:  dmgQty,
      /* Frozen conversion evidence — the stock (base) quantity actually taken off,
         so the returnable limit stays in business units while stock moves in base
         units, and a replacement is credited on the SAME basis. */
      baseQuantity:      baseQty,
      baseUnit,
      conversionFactor:  conv.factor,
      status:            "PENDING",
      reason,
      reportedBy:        req.user?.id || null,
      reportedAt:        new Date(),
      operationId,
      receipts:          [],
      /* The source location, snapshotted so the return history reads correctly
         after a warehouse is renamed. Empty for a legacy company-level return. */
      ...sourceSnapshot(loc),
      createdAt:         new Date(),
      updatedAt:         new Date(),
    };

    let moved;
    let before = null;
    await unitOfWork.run(req.tenant, {
      idempotencyRecord: req.idempotent?.record,
      mutate: async (session) => {
        /* The concurrency gate, the company + location deductions, and the
           compensation on stock failure are ONE shared operation now, so the
           Goods Receipt exception handoff reuses exactly this — see
           services/storePurchase/supplierReturn.service.js. */
        const out = await supplierReturn.raiseSupplierReturnStock({
          session, tenant: req.tenant, po, poItem, dmgQty, stockQty: baseQty, stockUnit: baseUnit, reason, loc, rawUnit,
          actor: { id: req.user?.id || null, name: req.user?.name || "" },
          operationId, idempotencyKey: req.idempotent?.key || "", newReturn,
        });
        moved = out.moved;
        before = out.before;

        return {
          entityType: ENTITY,
          entityId: po._id,
          result: true,
          entry: historyEntry(req, po, {
            action: "SUPPLIER_RETURN_RAISED",
            previousState: "PENDING",
            resultingState: "PENDING",
            reason: reason || "Damaged goods reported by store",
            changes: [{
              field: poItem.itemName,
              from: String(moved.previousQuantity),
              to: String(moved.newQuantity),
            }],
            metadata: {
              returnId: String(newReturn._id),
              operationId: String(operationId || ""),
              damagedQuantity: dmgQty,
              remainingReturnable: before.remaining,
              unit: poItem.unit,
            },
          }),
        };
      },
    });

    const payload = {
      success: true,
      message: `Return request created. ${dmgQty} ${poItem.unit} deducted from stock.`,
      returnRequest: newReturn,
    };
    return req.idempotent
      ? await req.idempotent.succeed(201, payload, { entityType: ENTITY, entityId: po._id })
      : res.status(201).json(payload);
  } catch (err) {
    if (err?.name === "StorePurchaseError") return sendError(res, err);
    console.error("[returns POST /]", err);
    res.status(500).json({ success: false, message: err.message });
  }
},
);


// ═══════════════════════════════════════════════════════════════════════════
// POST /:returnId/receive — the vendor's replacement arrives, in part or full
// Body: { quantityReceived, notes }
// ═══════════════════════════════════════════════════════════════════════════
router.post(
  "/:returnId/receive",
  requireCapability(CAPABILITIES.RECEIPT_RECORD),
  refuseLegacyWrite,
  withIdempotency("PO_RETURN_RECEIVE"),
  async (req, res) => {
  try {
    const { quantityReceived, notes = "", warehouseId = null, locationId = null } = req.body;
    const recvQty = parseFloat(quantityReceived);

    if (isNaN(recvQty) || recvQty <= 0) {
      return res.status(400).json({ success: false, message: "Valid quantityReceived required" });
    }

    const po = await loadPo(req);
    if (!po) return notFound(res);

    const returnReq = po.returnRequests.id(req.params.returnId);
    if (!returnReq) return notFound(res, "Return request");

    /* ── WAREHOUSE STOCK V1: THE EXPLICIT DESTINATION ──────────────────────
     * A replacement comes back INTO a chosen location — ANY usable one, not
     * necessarily where the damaged goods left. For a location-tracked return a
     * valid active destination is REQUIRED; a legacy return keeps company-level
     * behaviour. Each partial receipt may enter a different location. */
    const dest = await resolveLocation(req, warehouseId, locationId);
    const scopeVariantId = returnReq.variantId || null;
    if (!dest && await locStock.isLocationTracked(req.tenant.companyId, returnReq.rawItem, scopeVariantId)) {
      return res.status(400).json({
        success: false,
        reason: "LOCATION_REQUIRED",
        message: `"${returnReq.itemName}" is tracked by location — choose the warehouse and location to receive the replacement into.`,
      });
    }
    const rawUnit = await RawItem.findById(returnReq.rawItem).select("unit customUnit").lean();

    // BUSINESS vs STOCK quantity. The vendor sends the replacement in the return's
    // BUSINESS unit (recvQty drives the return's pending/received maths and the
    // receipt record). The stock credited to RawItem / LocationBalance is the
    // converted BASE quantity, on the SAME frozen basis the outbound stock left in
    // — so returning 1 carton (factor 10) credits exactly 10 pieces. Fails closed
    // when a differing frozen base has no valid conversion evidence, and refuses a
    // LEGACY return whose unit differs from the item's registered base unit rather
    // than guessing 1:1.
    const recvBaseUnit = rawUnit?.customUnit || rawUnit?.unit || returnReq.unit || "";
    const recvFactor = frozenBaseFactor(returnReq, recvBaseUnit);
    const recvBaseQty = Math.round(recvQty * recvFactor * 10000) / 10000;

    const operationId = operationIdOf(req);

    /* ── DID THIS OPERATION ALREADY RUN? ───────────────────────────────────
     * Matched on the operation id. The previous version treated ANY existing
     * receipt as proof this attempt had landed, so on a return that had
     * already taken a partial replacement, a brand-new receipt was reported as
     * "already recorded" and the vendor's second delivery was never credited. */
    const mine = operationId
      ? (returnReq.receipts || []).find((r) => String(r.operationId || "") === String(operationId))
      : null;

    /* Both halves, as on the create route: the receipt is written first now,
       so its presence alone does not prove the stock was credited. Replaying
       success on the receipt alone would report a credit that never happened. */
    if (mine && !(await stockMovedBy(operationId))) {
      await unitOfWork.recover(req.tenant, {
        entityType: ENTITY,
        entityId: po._id,
        idempotencyKey: req.idempotent?.key || "",
        entry: historyEntry(req, po, {
          action: "RETURN_RECEIPT_RECONCILIATION_REQUIRED",
          resultingState: returnReq.status,
          reason: "The receipt was recorded but the replacement stock was never credited.",
          metadata: { recovered: true, returnId: String(returnReq._id) },
        }),
      });
      throw fail(
        "LIFECYCLE_BLOCKED",
        "This replacement was interrupted after the return recorded it but before the stock was credited. Check the item's stock and correct the return — do not record the replacement again.",
        { reason: "PARTIAL_RETURN_RECEIPT_NEEDS_RECONCILIATION", poNumber: po.poNumber },
      );
    }

    if (mine) {
      await unitOfWork.recover(req.tenant, {
        entityType: ENTITY,
        entityId: po._id,
        idempotencyKey: req.idempotent?.key || "",
        entry: historyEntry(req, po, {
          action: "SUPPLIER_RETURN_RECEIVED",
          resultingState: returnReq.status,
          metadata: { recovered: true, returnId: String(returnReq._id), quantityReceived: mine.quantityReceived },
        }),
      });
      const already = {
        success: true, message: "This replacement was already recorded.", returnRequest: returnReq,
      };
      return req.idempotent
        ? await req.idempotent.succeed(200, already, { entityType: ENTITY, entityId: po._id })
        : res.json(already);
    }

    if (await stockMovedBy(operationId)) {
      await unitOfWork.recover(req.tenant, {
        entityType: ENTITY,
        entityId: po._id,
        idempotencyKey: req.idempotent?.key || "",
        entry: historyEntry(req, po, {
          action: "RETURN_RECEIPT_RECONCILIATION_REQUIRED",
          resultingState: returnReq.status,
          reason: "Stock was credited but the return did not record the receipt.",
          metadata: { recovered: true, operationId: String(operationId) },
        }),
      });
      throw fail(
        "LIFECYCLE_BLOCKED",
        "This replacement was interrupted after the stock was credited but before the return recorded it. Check the item's stock and correct the return — do not record the replacement again.",
        { reason: "PARTIAL_RETURN_RECEIPT_NEEDS_RECONCILIATION", poNumber: po.poNumber },
      );
    }

    /* A closed return takes nothing further. Stated as a transition problem,
       because that is what it is — the caller has the authority, the return
       has moved on. */
    if (returnReq.status === "COMPLETED") {
      throw fail("INVALID_TRANSITION", "This return is already complete.", { state: returnReq.status });
    }
    if (returnReq.status === "CANCELLED") {
      throw fail("INVALID_TRANSITION", "This return was cancelled.", { state: returnReq.status });
    }

    /* No pre-check on the pending quantity here. It read the copy loaded at
       the start of the request, so under concurrency it both raced and
       disagreed with the gate below — the same refusal arrived as a bare 400
       from here or as a structured 409 from there depending on timing. The
       atomic gate is the only place that decides, and it decides against the
       document as it actually is. */

    const previousState = returnReq.status;
    const receipt = {
      _id: new mongoose.Types.ObjectId(),
      quantityReceived: recvQty,          // BUSINESS quantity, in the return's unit
      unit:             returnReq.unit || "",
      /* The base quantity actually credited to stock, on the SAME frozen basis —
         so a replacement's audit trail carries both representations, and a replay
         reproduces identical evidence. */
      baseQuantityReceived: recvBaseQty,
      baseUnit:         recvBaseUnit,
      conversionFactor: recvFactor,
      receivedDate:     new Date(),
      notes,
      receivedBy:       req.user?.id || null,
      operationId,
      /* The destination this receipt entered, snapshotted so history stays
         readable after a rename. Empty for a legacy company-level replacement. */
      ...destSnapshot(dest),
      createdAt:        new Date(),
      updatedAt:        new Date(),
    };

    let moved;
    let settled = null;
    await unitOfWork.run(req.tenant, {
      idempotencyRecord: req.idempotent?.record,
      mutate: async (session) => {
        /* ── THE CONCURRENCY GATE ──────────────────────────────────────────
         * Two replacements recorded at the same moment each read "6 still
         * owed", each accepted 6, and both credited — 12 units of stock for a
         * vendor who sent 6. The pending quantity is therefore decremented by
         * the database, in the same operation that checks there is enough of
         * it left and appends the receipt. The loser's `$elemMatch` no longer
         * matches, so it is refused having changed nothing.
         *
         * A pipeline update, so the status lands atomically with the numbers
         * it is derived from rather than in a second write that could be lost. */
        const q = PurchaseOrder.findOneAndUpdate(
          {
            _id: po._id,
            ...tenantContext.tenantFilter(req.tenant),
            returnRequests: {
              $elemMatch: {
                _id: returnReq._id,
                status: { $in: ["PENDING", "PARTIAL"] },
                pendingReturnQty: { $gte: recvQty },
              },
            },
          },
          [{
            $set: {
              returnRequests: {
                $map: {
                  input: "$returnRequests",
                  as: "r",
                  in: {
                    $cond: [
                      { $eq: ["$$r._id", returnReq._id] },
                      {
                        $mergeObjects: ["$$r", {
                          receipts: { $concatArrays: [{ $ifNull: ["$$r.receipts", []] }, [receipt]] },
                          returnedQuantity: { $add: [{ $ifNull: ["$$r.returnedQuantity", 0] }, recvQty] },
                          pendingReturnQty: { $subtract: [{ $ifNull: ["$$r.pendingReturnQty", 0] }, recvQty] },
                          status: {
                            $cond: [
                              { $lte: [{ $subtract: [{ $ifNull: ["$$r.pendingReturnQty", 0] }, recvQty] }, 0] },
                              "COMPLETED",
                              "PARTIAL",
                            ],
                          },
                        }],
                      },
                      "$$r",
                    ],
                  },
                },
              },
            },
          }],
          { new: true },
        );
        if (session) q.session(session);
        const updated = await q;

        if (!updated) {
          /* Lost the race, or the return closed underneath us. Re-read to say
             which, now that nothing else is in flight. */
          const fresh = await loadPo(req).lean();
          const row = (fresh?.returnRequests || []).find(
            (r) => String(r._id) === String(returnReq._id),
          );
          if (!row) throw fail("NOT_FOUND", "That return request was not found.");
          if (row.status === "COMPLETED") {
            throw fail("INVALID_TRANSITION", "This return is already complete.", { state: row.status });
          }
          if (row.status === "CANCELLED") {
            throw fail("INVALID_TRANSITION", "This return was cancelled.", { state: row.status });
          }
          throw fail(
            "INVALID_TRANSITION",
            `Cannot receive ${recvQty} — only ${row.pendingReturnQty || 0} ${row.unit} is still owed on this return.`,
            {
              reason: "PENDING_RETURN_QUANTITY_EXCEEDED",
              pendingReturnQty: row.pendingReturnQty || 0,
              requested: recvQty,
              unit: row.unit,
            },
          );
        }

        settled = (updated.returnRequests || []).find(
          (r) => String(r._id) === String(returnReq._id),
        );

        /* Between recording the receipt and crediting the stock. */
        await at("receipt:beforeStock", { poId: po._id, returnId: returnReq._id, operationId });
        try {
          moved = await moveStock({
          rawItemId: returnReq.rawItem,
          variantId: returnReq.variantId,
          variantCombination: returnReq.variantCombination,
          delta: recvBaseQty,
          session,
          operationId,
          txn: {
            type: returnReq.variantId ? "VARIANT_ADD" : "ADD",
            quantity: recvBaseQty, baseUnit: recvBaseUnit,
            reason: `Return receipt from vendor (PO: ${po.poNumber})`,
            notes: notes || "Vendor replacement received against return request",
            variantId: returnReq.variantId || undefined,
            variantCombination: returnReq.variantCombination?.length ? returnReq.variantCombination : undefined,
            purchaseOrder: po.poNumber,
            purchaseOrderId: po._id,
            performedBy: req.user?.id || null,
          },
          });

          /* Warehouse Stock V1: the SAME unit of work writes ONE location-IN
             movement — the replacement entering the CHOSEN destination — with
             the session, so it commits (or rolls back) with the company credit
             and the receipt record. Per-receipt movement key: distinct on the
             deployed index, idempotent on replay. A failure lands in the SAME
             catch as a stock failure, which compensates this receipt. */
          if (dest) {
            const inMv = await locStock.applyLocationIn(session, {
              companyId: req.tenant.companyId, siteId: req.tenant.siteId || null,
              item: { _id: returnReq.rawItem, unit: rawUnit?.unit, customUnit: rawUnit?.customUnit },
              variantId: scopeVariantId,
              warehouse: dest.warehouse, location: dest.location,
              quantity: recvBaseQty, type: "replacement_receipt", intent: "receive",
              source: {
                kind: "replacement_receipt", id: po._id, reference: po.poNumber,
                returnId: returnReq._id, poLineId: returnReq.poItemId, receiptId: receipt._id,
              },
              actor: { id: req.user?.id || null, name: req.user?.name || "" },
              note: notes || "Vendor replacement received",
              idempotencyKey: locStock.movementLineKey(req.idempotent?.key || "", receipt._id, "replacement_receipt"),
              operationKey: req.idempotent?.key || "",
            });
            if (!inMv.ok) {
              throw fail("INVALID_TRANSITION", `Could not credit ${dest.location.code}. Nothing was changed.`, { reason: inMv.reason });
            }
          }
        } catch (stockError) {
          /* ── UNDOING ONLY THIS RECEIPT, WITHOUT ASSUMING NOTHING ELSE MOVED
           * The receipt is recorded and the credit failed, so the receipt has
           * to come back out. The previous version also wrote back the status
           * it had captured before starting — which is wrong the moment
           * another receipt succeeds in between: rolling back a 3 on a return
           * that a colleague has since completed would reinstate "PARTIAL" on
           * a return that is genuinely finished.
           *
           * So nothing captured earlier is written back. The update matches
           * only if THIS operation's receipt is still there, removes only that
           * receipt, reverses only that receipt's quantity, and derives the
           * status from what the quantities actually become. */
          /* A test can hold the compensation here — long enough for another
             receipt to land first — or set `skip` to leave the interrupted
             state standing so the reconciliation path can be exercised. */
          const gate = await at("receipt:beforeCompensate", {
            poId: po._id, returnId: returnReq._id, operationId, skip: false,
          });
          const compensated = gate.skip ? false : await compensateReceipt({
            poId: po._id, returnId: returnReq._id, operationId, session,
          });
          if (!compensated) {
            /* The receipt could not be confirmed removed. Saying so is the
               honest outcome: the retry will find a receipt with no stock
               behind it and refuse for reconciliation. */
            console.error(
              "[returns] could not undo receipt %s on return %s — reconciliation required",
              String(operationId), String(returnReq._id),
            );
          }
          throw stockError;
        }

        return {
          entityType: ENTITY,
          entityId: po._id,
          result: true,
          entry: historyEntry(req, po, {
            action: "SUPPLIER_RETURN_RECEIVED",
            previousState,
            resultingState: settled?.status || previousState,
            reason: notes || "",
            changes: [{
              field: returnReq.itemName,
              from: String(moved.previousQuantity),
              to: String(moved.newQuantity),
            }],
            metadata: {
              returnId: String(returnReq._id),
              operationId: String(operationId || ""),
              quantityReceived: recvQty,
              returnedQuantity: settled?.returnedQuantity ?? 0,
              pendingReturnQty: settled?.pendingReturnQty ?? 0,
              unit: returnReq.unit,
            },
          }),
        };
      },
    });

    const payload = {
      success: true,
      message: `${recvQty} ${settled?.unit || returnReq.unit} credited back to stock.`,
      returnRequest: settled || returnReq,
    };
    return req.idempotent
      ? await req.idempotent.succeed(200, payload, { entityType: ENTITY, entityId: po._id })
      : res.json(payload);
  } catch (err) {
    if (err?.name === "StorePurchaseError") return sendError(res, err);
    console.error("[returns POST /:returnId/receive]", err);
    res.status(500).json({ success: false, message: err.message });
  }
},
);


// ═══════════════════════════════════════════════════════════════════════════
// PATCH /:returnId/cancel — close an open return
//
// Deliberately does NOT put the stock back: the goods are still damaged or
// still missing. Cancelling says "we are no longer chasing the vendor for a
// replacement", not "the damage never happened".
// ═══════════════════════════════════════════════════════════════════════════
router.patch(
  "/:returnId/cancel",
  requireCapability(CAPABILITIES.STOCK_RETURN),
  refuseLegacyWrite,
  withIdempotency("PO_RETURN_CANCEL"),
  async (req, res) => {
  try {
    const po = await loadPo(req);
    if (!po) return notFound(res);

    const returnReq = po.returnRequests.id(req.params.returnId);
    if (!returnReq) return notFound(res, "Return request");

    /* Cancelling twice is not an error and not a second cancellation: the
       caller wanted this return closed and it is closed. Answering the same
       way each time is what makes a retry safe to send. */
    if (returnReq.status === "CANCELLED") {
      /* Repair a missing record, but do not append a second one. History is a
         log of what HAPPENED to this return, not of how many times somebody
         asked. Matching on the return rather than the idempotency key is what
         makes that true across separate attempts with separate keys — the
         second cancellation is a different request and the same non-event. */
      const alreadyRecorded = await SpActionHistory.exists({
        companyId: req.tenant.companyId,
        entityId: po._id,
        action: "SUPPLIER_RETURN_CANCELLED",
        "metadata.returnId": String(returnReq._id),
      });
      if (!alreadyRecorded) {
        await actionHistory.record(req.tenant, {
          ...historyEntry(req, po, {
            action: "SUPPLIER_RETURN_CANCELLED",
            resultingState: "CANCELLED",
            reason: req.body?.reason || returnReq.reason || "Cancelled by the store",
            metadata: { recovered: true, returnId: String(returnReq._id) },
          }),
          atomicityDegraded: true,
        });
      }
      const already = {
        success: true, message: "Return request cancelled", returnRequest: returnReq, alreadyDone: true,
      };
      return req.idempotent
        ? await req.idempotent.succeed(200, already, { entityType: ENTITY, entityId: po._id })
        : res.json(already);
    }

    if (returnReq.status === "COMPLETED") {
      throw fail(
        "INVALID_TRANSITION",
        "This return is already complete — the replacement arrived, so there is nothing to cancel.",
        { state: returnReq.status },
      );
    }

    const previousState = returnReq.status;
    let cancelled = null;

    await unitOfWork.run(req.tenant, {
      idempotencyRecord: req.idempotent?.record,
      mutate: async (session) => {
        /* ── CANCELLING WITHOUT OVERWRITING WHAT ELSE ARRIVED ───────────────
         * This used to set the status on the loaded subdocument and save the
         * whole order. A replacement receipt landing in between was written
         * into a copy this request had never seen, and the save put the old
         * copy back — the receipt, its quantities and its ledger link all
         * disappeared, silently, from a request that only meant to change one
         * status field.
         *
         * One conditional update instead: it touches the single status field,
         * and only while the return is still in a state that may be
         * cancelled. Everything else on the order is left exactly as whoever
         * wrote it left it. */
        await at("cancel:beforeWrite", { poId: po._id, returnId: returnReq._id });

        const q = PurchaseOrder.findOneAndUpdate(
          {
            _id: po._id,
            ...tenantContext.tenantFilter(req.tenant),
            returnRequests: {
              $elemMatch: { _id: returnReq._id, status: { $in: ["PENDING", "PARTIAL"] } },
            },
          },
          { $set: { "returnRequests.$[r].status": "CANCELLED" } },
          /* ── THE PREIMAGE IS THE ONLY HONEST "BEFORE" ──────────────────────
           * History was recording the status this request read when it first
           * loaded the order, which is not the state the change was actually
           * applied to. A replacement arriving in between moved the return to
           * PARTIAL, and the audit trail then said PENDING → CANCELLED for a
           * transition the database never made. `returnDocument: "before"`
           * hands back the document the update matched, so the entry describes
           * the write that happened rather than the read that preceded it. */
          {
            returnDocument: "before",
            arrayFilters: [{ "r._id": returnReq._id }],
          },
        );
        if (session) q.session(session);
        const preimage = await q;
        const updated = preimage;

        if (!updated) {
          /* Something changed underneath: the return completed, or another
             request cancelled it first. Re-read to say which. */
          const fresh = await loadPo(req).lean();
          const row = (fresh?.returnRequests || []).find(
            (r) => String(r._id) === String(returnReq._id),
          );
          if (!row) throw fail("NOT_FOUND", "That return request was not found.");
          if (row.status === "CANCELLED") {
            /* Somebody got there first. That is the outcome this request
               wanted, so it is not an error — the replay branch above answers
               the same way. */
            cancelled = row;
            /* ── A NO-OP IS NOT A TRANSITION ────────────────────────────────
             * Somebody else cancelled it first. This request changed nothing,
             * so recording CANCELLED → CANCELLED under the same action as a
             * real cancellation would put a second closure in the trail for a
             * return that was closed once. It is kept — an attempt is worth
             * seeing — under its own action, with both states equal so it can
             * never be mistaken for the change itself. */
            return {
              entityType: ENTITY,
              entityId: po._id,
              result: true,
              entry: historyEntry(req, po, {
                action: "SUPPLIER_RETURN_CANCEL_NOOP",
                previousState: "CANCELLED",
                resultingState: "CANCELLED",
                reason: req.body?.reason || "Cancelled by the store",
                metadata: {
                  returnId: String(returnReq._id),
                  stockRestored: false,
                  damagedQuantity: row.damagedQuantity,
                  /* Said explicitly: another request had already closed it. */
                  alreadyCancelled: true,
                },
              }),
            };
          }
          throw fail(
            "INVALID_TRANSITION",
            "This return is already complete — the replacement arrived, so there is nothing to cancel.",
            { state: row.status },
          );
        }

        /* The row as the update found it, and as it now stands. Only the
           status changed, so the postimage is the preimage with that one
           field replaced — no second read required. */
        const beforeRow = (preimage.returnRequests || []).find(
          (r) => String(r._id) === String(returnReq._id),
        );
        /* ── SPREADING A SUBDOCUMENT DOES NOT GIVE YOU ITS FIELDS ───────────
         * `beforeRow` is a Mongoose array subdocument. `{ ...beforeRow }`
         * copies the machinery around the data — `_doc`, `$__`, `$__parent`,
         * `__parentArray` — and leaves `_id`, `poItemId`, `damagedQuantity`
         * and `reason` inside `_doc`, where no caller looks. The response was
         * malformed while its `status` read correctly, because `status` was
         * the one field assigned afterwards, so every test that checked only
         * the status was satisfied by it.
         *
         * `toObject()` is the conversion that actually yields the fields. */
        if (!beforeRow) {
          /* The update matched this `_id` through its own arrayFilter, so the
             pre-image has to contain it. If it somehow does not, say so rather
             than answering with a status and nothing else — and describe the
             return from the copy this request loaded, which is the best
             account available and still carries every identifying field. */
          console.error(
            "[returns] cancellation pre-image did not contain return %s on PO %s",
            String(returnReq._id), String(po._id),
          );
        }
        const describes = beforeRow || returnReq;
        cancelled = {
          ...(typeof describes?.toObject === "function" ? describes.toObject() : describes),
          status: "CANCELLED",
        };

        return {
          entityType: ENTITY,
          entityId: po._id,
          result: true,
          entry: historyEntry(req, po, {
            action: "SUPPLIER_RETURN_CANCELLED",
            previousState: beforeRow?.status || previousState,
            resultingState: "CANCELLED",
            reason: req.body?.reason || "Cancelled by the store",
            metadata: {
              returnId: String(returnReq._id),
              /* Said plainly, because it surprises people: the deduction
                 stands. The goods really were damaged. */
              stockRestored: false,
              damagedQuantity: beforeRow?.damagedQuantity ?? returnReq.damagedQuantity,
            },
          }),
        };
      },
    });

    const payload = {
      success: true, message: "Return request cancelled", returnRequest: cancelled || returnReq,
    };
    return req.idempotent
      ? await req.idempotent.succeed(200, payload, { entityType: ENTITY, entityId: po._id })
      : res.json(payload);
  } catch (err) {
    if (err?.name === "StorePurchaseError") return sendError(res, err);
    console.error("[returns PATCH cancel]", err);
    res.status(500).json({ success: false, message: err.message });
  }
},
);

module.exports = router;
/* Test seam — now owned by supplierReturn.service, re-exported here so the
   existing return tests keep registering hooks by the same object. Absent
   entirely outside a test run. */
if (supplierReturn.__hooks) module.exports.__hooks = supplierReturn.__hooks;
