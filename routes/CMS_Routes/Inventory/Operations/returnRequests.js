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
const router   = express.Router({ mergeParams: true }); // mergeParams to get :poId
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem       = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
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
 * Find the variant a return line refers to, if it names one.
 *
 * Kept separate from the write so availability can be checked before anything
 * is changed.
 */
function matchVariant(rawItem, variantId, variantCombination) {
  if (variantId && rawItem.variants?.length) {
    const byId = rawItem.variants.id(variantId);
    if (byId) return byId;
  }
  if (variantCombination?.length && rawItem.variants?.length) {
    return rawItem.variants.find(v =>
      v.combination?.length === variantCombination.length &&
      v.combination.every((val, i) => val === variantCombination[i])
    ) || null;
  }
  return null;
}

/**
 * Move stock for a return, refusing rather than clamping.
 *
 * ── WHY THE OLD CLAMP WAS THE WORST KIND OF BUG ─────────────────────────────
 * `Math.max(0, prev + delta)` turns "you cannot take 40 from a shelf of 10"
 * into "the shelf now holds 0" and returns success. Nobody is told, the return
 * is recorded as though 40 came off, and the discrepancy surfaces weeks later
 * during a count with no trail explaining it. A refusal is a worse afternoon
 * and a far better system: the caller finds out immediately, while they are
 * standing next to the goods.
 *
 * The check and the write are in one function on purpose — separating them
 * invites a caller to skip the check.
 */
async function moveStock({
  rawItemId, variantId, variantCombination, delta, txn, session = null, operationId = null,
}) {
  const q = RawItem.findById(rawItemId);
  if (session) q.session(session);
  const rawItem = await q;
  if (!rawItem) {
    throw fail("VALIDATION", "That item is no longer in the catalogue, so its stock cannot be adjusted.", {
      rawItemId: String(rawItemId || ""),
    });
  }

  const prevQty = rawItem.quantity || 0;
  const wantsVariant = Boolean(variantId) || Boolean(variantCombination?.length);
  const matchedVariant = matchVariant(rawItem, variantId, variantCombination);

  /* ── A NAMED VARIANT THAT CANNOT BE FOUND IS A REFUSAL ──────────────────
   * The old helper fell through to adjusting only the item-level balance, so
   * a return against a variant that had been renamed or removed quietly took
   * the quantity off the parent and left every variant's count untouched. The
   * two then disagree, and nothing says why. */
  if (wantsVariant && !matchedVariant) {
    throw fail(
      "INVALID_TRANSITION",
      `That variant of "${rawItem.name}" is no longer in the catalogue, so its stock cannot be adjusted. Nothing was changed.`,
      {
        reason: "VARIANT_NOT_FOUND",
        itemName: rawItem.name,
        variantId: variantId ? String(variantId) : null,
        variantCombination: variantCombination || [],
      },
    );
  }

  if (delta < 0) {
    const take = Math.abs(delta);
    if (prevQty < take) {
      throw fail(
        "INVALID_TRANSITION",
        `Cannot take ${take} ${rawItem.unit || "unit"} of "${rawItem.name}" out of stock — only ${prevQty} is there. Nothing was changed.`,
        { reason: "INSUFFICIENT_STOCK", available: prevQty, requested: take, itemName: rawItem.name },
      );
    }
    if (matchedVariant && (matchedVariant.quantity || 0) < take) {
      throw fail(
        "INVALID_TRANSITION",
        `Cannot take ${take} of that variant of "${rawItem.name}" out of stock — only ${matchedVariant.quantity || 0} is there. Nothing was changed.`,
        {
          reason: "INSUFFICIENT_VARIANT_STOCK",
          available: matchedVariant.quantity || 0, requested: take, itemName: rawItem.name,
        },
      );
    }
  }

  const statusFor = (qty, minStock) =>
    qty === 0 ? "Out of Stock" : qty <= (minStock || 0) ? "Low Stock" : "In Stock";

  let variantPrev = null;
  if (matchedVariant) {
    variantPrev = matchedVariant.quantity || 0;
    matchedVariant.quantity = variantPrev + delta;
    matchedVariant.status = statusFor(
      matchedVariant.quantity, matchedVariant.minStock || rawItem.minStock,
    );
  }

  rawItem.quantity = prevQty + delta;
  rawItem.status = statusFor(rawItem.quantity, rawItem.minStock);

  rawItem.stockTransactions.push({
    ...txn,
    /* Stamped so a retry can ask "did MY attempt move this?" — see the
       recovery branches. Without it, recovery has only quantity and item to go
       on, which two separate returns legitimately share. */
    operationId,
    previousQuantity: prevQty,
    newQuantity: rawItem.quantity,
    ...(matchedVariant ? {
      variantPreviousQuantity: variantPrev,
      variantNewQuantity: matchedVariant.quantity,
    } : {}),
  });

  await rawItem.save(session ? { session } : {});
  return { previousQuantity: prevQty, newQuantity: rawItem.quantity };
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
    const { poItemId, damagedQuantity, reason = "" } = req.body;

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

    if (mine) {
      /* The return exists. Whatever failed came after it, so repair the
         history if that is what went missing and answer as the first attempt
         would have. */
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

    /* ── WHAT IS STILL RETURNABLE ON THIS LINE ─────────────────────────────
     * Checking each return against the line's RECEIVED quantity in isolation
     * let two 15-unit returns be raised against a line that received 20: each
     * passed on its own, and 30 units came off a shelf that only ever got 20.
     *
     * Cancelled returns count towards the total, because cancelling does not
     * put the goods back — the stock stays deducted, so the quantity is spent
     * whatever the return's status says. */
    const received = poItem.receivedQuantity || 0;
    const alreadyRemoved = (po.returnRequests || [])
      .filter((r) => String(r.poItemId) === String(poItem._id))
      .reduce((sum, r) => sum + (r.damagedQuantity || 0), 0);
    const remaining = Math.max(0, received - alreadyRemoved);

    if (dmgQty > remaining) {
      throw fail(
        "INVALID_TRANSITION",
        alreadyRemoved > 0
          ? `Only ${remaining} ${poItem.unit} of "${poItem.itemName}" can still be returned — ${received} was received and ${alreadyRemoved} has already been returned.`
          : `Damaged qty (${dmgQty}) cannot exceed received qty (${received}).`,
        {
          reason: "RETURNABLE_QUANTITY_EXCEEDED",
          receivedQuantity: received,
          alreadyReturnedQuantity: alreadyRemoved,
          remainingReturnable: remaining,
          requested: dmgQty,
          unit: poItem.unit,
          itemName: poItem.itemName,
        },
      );
    }

    po.returnRequests.push({
      poItemId:          poItem._id,
      rawItem:           poItem.rawItem,
      itemName:          poItem.itemName,
      sku:               poItem.sku,
      unit:              poItem.unit,
      variantId:         poItem.variantId || null,
      variantCombination: poItem.variantCombination || [],
      damagedQuantity:   dmgQty,
      returnedQuantity:  0,
      pendingReturnQty:  dmgQty,
      status:            "PENDING",
      reason,
      reportedBy:        req.user?.id || null,
      reportedAt:        new Date(),
      operationId,
      receipts:          [],
    });
    const newReturn = po.returnRequests[po.returnRequests.length - 1];

    /* ── ONE UNIT OF WORK ─────────────────────────────────────────────────
     * The stock movement is INSIDE the mutation, so where the deployment
     * supports transactions the RawItem write, the order write, the history
     * entry and the effect marker all share one session and commit or roll
     * back together.
     *
     * Where it does not, the marker is written after the mutation rather than
     * before it. That is deliberate: marking first meant an attempt that never
     * reached the stock still claimed EFFECT_APPLIED, so a retry was refused as
     * "already done" when nothing had been done at all. Now a failure before
     * the stock moves leaves the record retryable, and a failure after it is
     * caught by the operation-stamped stock line above. */
    let moved;
    await unitOfWork.run(req.tenant, {
      idempotencyRecord: req.idempotent?.record,
      mutate: async (session) => {
        moved = await moveStock({
          rawItemId: poItem.rawItem,
          variantId: poItem.variantId,
          variantCombination: poItem.variantCombination,
          delta: -dmgQty,
          session,
          operationId,
          txn: {
            type: poItem.variantId ? "VARIANT_REDUCE" : "REDUCE",
            quantity: dmgQty,
            reason: `Return request — damaged/faulty (PO: ${po.poNumber})`,
            notes: reason || "Damaged goods reported by store",
            variantId: poItem.variantId || undefined,
            variantCombination: poItem.variantCombination?.length ? poItem.variantCombination : undefined,
            purchaseOrder: po.poNumber,
            purchaseOrderId: po._id,
            performedBy: req.user?.id || null,
          },
        });

        await po.save(session ? { session } : {});
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
              remainingReturnable: remaining - dmgQty,
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
    const { quantityReceived, notes = "" } = req.body;
    const recvQty = parseFloat(quantityReceived);

    if (isNaN(recvQty) || recvQty <= 0) {
      return res.status(400).json({ success: false, message: "Valid quantityReceived required" });
    }

    const po = await loadPo(req);
    if (!po) return notFound(res);

    const returnReq = po.returnRequests.id(req.params.returnId);
    if (!returnReq) return notFound(res, "Return request");

    const operationId = operationIdOf(req);

    /* ── DID THIS OPERATION ALREADY RUN? ───────────────────────────────────
     * Matched on the operation id. The previous version treated ANY existing
     * receipt as proof this attempt had landed, so on a return that had
     * already taken a partial replacement, a brand-new receipt was reported as
     * "already recorded" and the vendor's second delivery was never credited. */
    const mine = operationId
      ? (returnReq.receipts || []).find((r) => String(r.operationId || "") === String(operationId))
      : null;

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

    const pending = returnReq.pendingReturnQty || 0;
    if (recvQty > pending) {
      return res.status(400).json({
        success: false,
        message: `Cannot receive ${recvQty} — only ${pending} ${returnReq.unit} is still owed on this return.`,
      });
    }

    const previousState = returnReq.status;

    returnReq.receipts.push({
      quantityReceived: recvQty,
      receivedDate:     new Date(),
      notes,
      receivedBy:       req.user?.id || null,
      operationId,
    });
    returnReq.returnedQuantity = (returnReq.returnedQuantity || 0) + recvQty;
    returnReq.pendingReturnQty = Math.max(0, returnReq.damagedQuantity - returnReq.returnedQuantity);
    returnReq.status = returnReq.pendingReturnQty <= 0 ? "COMPLETED" : "PARTIAL";

    /* Stock and order together — one session where the deployment allows it,
       and where it does not, the marker lands after the mutation so a failure
       before the credit leaves the record retryable. */
    let moved;
    await unitOfWork.run(req.tenant, {
      idempotencyRecord: req.idempotent?.record,
      mutate: async (session) => {
        moved = await moveStock({
          rawItemId: returnReq.rawItem,
          variantId: returnReq.variantId,
          variantCombination: returnReq.variantCombination,
          delta: recvQty,
          session,
          operationId,
          txn: {
            type: returnReq.variantId ? "VARIANT_ADD" : "ADD",
            quantity: recvQty,
            reason: `Return receipt from vendor (PO: ${po.poNumber})`,
            notes: notes || "Vendor replacement received against return request",
            variantId: returnReq.variantId || undefined,
            variantCombination: returnReq.variantCombination?.length ? returnReq.variantCombination : undefined,
            purchaseOrder: po.poNumber,
            purchaseOrderId: po._id,
            performedBy: req.user?.id || null,
          },
        });

        await po.save(session ? { session } : {});
        return {
          entityType: ENTITY,
          entityId: po._id,
          result: true,
          entry: historyEntry(req, po, {
            action: "SUPPLIER_RETURN_RECEIVED",
            previousState,
            resultingState: returnReq.status,
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
              returnedQuantity: returnReq.returnedQuantity,
              pendingReturnQty: returnReq.pendingReturnQty,
              unit: returnReq.unit,
            },
          }),
        };
      },
    });

    const payload = {
      success: true,
      message: `${recvQty} ${returnReq.unit} credited back to stock.`,
      returnRequest: returnReq,
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
    returnReq.status = "CANCELLED";

    await unitOfWork.run(req.tenant, {
      idempotencyRecord: req.idempotent?.record,
      mutate: async (session) => {
        await po.save(session ? { session } : {});
        return {
          entityType: ENTITY,
          entityId: po._id,
          result: true,
          entry: historyEntry(req, po, {
            action: "SUPPLIER_RETURN_CANCELLED",
            previousState,
            resultingState: "CANCELLED",
            reason: req.body?.reason || "Cancelled by the store",
            metadata: {
              returnId: String(returnReq._id),
              /* Said plainly, because it surprises people: the deduction
                 stands. The goods really were damaged. */
              stockRestored: false,
              damagedQuantity: returnReq.damagedQuantity,
            },
          }),
        };
      },
    });

    const payload = { success: true, message: "Return request cancelled", returnRequest: returnReq };
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
