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

  /* ── THE MOVEMENT ITSELF IS ONE OPERATION ──────────────────────────────
   * This used to read the item, adjust it in memory and save the whole
   * document. Four returns raised at the same moment each read 100, each
   * computed 95, and each saved — the shelf ended at 95 having given out 20.
   * A full-document save cannot express "subtract five from whatever is there
   * now", which is the only thing that is actually true.
   *
   * So the read-modify-write is replaced by a conditional `$inc`: the filter
   * carries the sufficiency check, and MongoDB applies both together. A
   * simultaneous movement that emptied the shelf first makes this one's filter
   * fail to match, and it is refused having changed nothing. The ledger line
   * is appended in the same operation so it can never be lost separately —
   * it is the evidence recovery reads.
   */
  const take = delta < 0 ? Math.abs(delta) : 0;
  const filter = { _id: rawItem._id };
  if (take > 0) {
    filter.quantity = { $gte: take };
    if (matchedVariant) {
      filter.variants = { $elemMatch: { _id: matchedVariant._id, quantity: { $gte: take } } };
    }
  }

  const statusExpr = (qtyExpr, minExpr) => ({
    $switch: {
      branches: [
        { case: { $lte: [qtyExpr, 0] }, then: "Out of Stock" },
        { case: { $lte: [qtyExpr, { $ifNull: [minExpr, 0] }] }, then: "Low Stock" },
      ],
      default: "In Stock",
    },
  });

  const nextQty = { $add: [{ $ifNull: ["$quantity", 0] }, delta] };

  /* ── THE VARIANT'S BALANCE, READ WHERE IT IS BEING WRITTEN ────────────────
   * These were taken from `matchedVariant`, which is a JavaScript snapshot
   * read before this update ran. Under concurrent movements it is exactly as
   * stale as the item-level read that this pipeline exists to replace: two
   * simultaneous variant movements both recorded "was 20, now 15", and the
   * ledger's before/after chain broke where it is most needed. Both values are
   * therefore computed by MongoDB from the document it is actually updating. */
  const variantQtyNow = matchedVariant
    ? {
      $ifNull: [
        {
          $first: {
            $map: {
              input: {
                $filter: {
                  input: { $ifNull: ["$variants", []] },
                  as: "v",
                  cond: { $eq: ["$$v._id", matchedVariant._id] },
                },
              },
              as: "v",
              in: { $ifNull: ["$$v.quantity", 0] },
            },
          },
        },
        0,
      ],
    }
    : null;

  /* Between reading the item (which is where `matchedVariant` comes from) and
     writing it. A test parks here to make that read genuinely stale — which is
     the only way to show the ledger values are derived from the document being
     written rather than from the snapshot. */
  await at("stock:beforeWrite", { rawItemId: rawItem._id, operationId });

  const stampedAt = new Date();
  const pipeline = [
    {
      $set: {
        stockTransactions: {
          $concatArrays: [
            { $ifNull: ["$stockTransactions", []] },
            [{
              ...txn,
              operationId,
              previousQuantity: { $ifNull: ["$quantity", 0] },
              newQuantity: nextQty,
              ...(matchedVariant ? {
                variantPreviousQuantity: variantQtyNow,
                variantNewQuantity: { $add: [variantQtyNow, delta] },
              } : {}),
              /* Mongoose's timestamps do not run for a pipeline update, so a
                 ledger line written this way carried none at all. */
              createdAt: stampedAt,
              updatedAt: stampedAt,
            }],
          ],
        },
        quantity: nextQty,
      },
    },
    {
      $set: {
        status: statusExpr("$quantity", "$minStock"),
        ...(matchedVariant ? {
          variants: {
            $map: {
              input: { $ifNull: ["$variants", []] },
              as: "v",
              in: {
                $cond: [
                  { $eq: ["$$v._id", matchedVariant._id] },
                  {
                    $mergeObjects: ["$$v", {
                      quantity: { $add: [{ $ifNull: ["$$v.quantity", 0] }, delta] },
                      status: statusExpr(
                        { $add: [{ $ifNull: ["$$v.quantity", 0] }, delta] },
                        { $ifNull: ["$$v.minStock", { $ifNull: ["$minStock", 0] }] },
                      ),
                    }],
                  },
                  "$$v",
                ],
              },
            },
          },
        } : {}),
      },
    },
  ];

  const update = RawItem.findOneAndUpdate(filter, pipeline, { new: true });
  if (session) update.session(session);
  const updated = await update;

  if (!updated) {
    /* The filter did not match: somebody else took the stock between the read
       above and this write, or there was never enough. Re-read to say which
       and by how much — the figures are stable now that this attempt has
       failed to change anything. */
    const now = await RawItem.findById(rawItem._id).lean();
    const available = now?.quantity || 0;
    const variantNow = matchedVariant
      ? (now?.variants || []).find((v) => String(v._id) === String(matchedVariant._id))
      : null;
    if (matchedVariant && (variantNow?.quantity || 0) < take) {
      throw fail(
        "INVALID_TRANSITION",
        `Cannot take ${take} of that variant of "${rawItem.name}" out of stock — only ${variantNow?.quantity || 0} is there. Nothing was changed.`,
        {
          reason: "INSUFFICIENT_VARIANT_STOCK",
          available: variantNow?.quantity || 0, requested: take, itemName: rawItem.name,
        },
      );
    }
    throw fail(
      "INVALID_TRANSITION",
      `Cannot take ${take} ${rawItem.unit || "unit"} of "${rawItem.name}" out of stock — only ${available} is there. Nothing was changed.`,
      { reason: "INSUFFICIENT_STOCK", available, requested: take, itemName: rawItem.name },
    );
  }

  const newQuantity = updated.quantity || 0;
  return { previousQuantity: newQuantity - delta, newQuantity };
}

/**
 * The guard that makes two simultaneous returns safe.
 *
 * ── WHY THE CHECK CANNOT LIVE IN JAVASCRIPT ─────────────────────────────────
 * Reading the order, adding up its existing returns, and deciding there is room
 * is three steps with gaps between them. Two store people raising a return at
 * the same moment — separate requests, separate idempotency keys, both entirely
 * legitimate — each read the same "15 already returned of 20 received", each
 * concluded 5 was fine, and both pushed. The line ended up 25 returned against
 * 20 received. Idempotency does not help: these are two different actions, and
 * each is individually correct.
 *
 * So the sum is computed by MongoDB as part of the update's own filter. The
 * document is matched and modified in one operation, and the loser's filter is
 * re-evaluated against the winner's already-updated document — where the room
 * is gone, so it simply does not match. No transaction required, which matters
 * because this deployment does not have them.
 */
function returnableGuard(poItemId, dmgQty) {
  const alreadyReturned = {
    $sum: {
      $map: {
        input: {
          $filter: {
            input: { $ifNull: ["$returnRequests", []] },
            as: "r",
            cond: { $eq: ["$$r.poItemId", poItemId] },
          },
        },
        as: "r",
        in: { $ifNull: ["$$r.damagedQuantity", 0] },
      },
    },
  };
  const received = {
    $ifNull: [
      {
        $first: {
          $map: {
            input: {
              $filter: {
                input: { $ifNull: ["$items", []] },
                as: "i",
                cond: { $eq: ["$$i._id", poItemId] },
              },
            },
            as: "i",
            in: { $ifNull: ["$$i.receivedQuantity", 0] },
          },
        },
      },
      0,
    ],
  };
  return { $expr: { $lte: [{ $add: [dmgQty, alreadyReturned] }, received] } };
}

/**
 * What is actually left on a line, read fresh.
 *
 * Only called once the atomic guard has already refused, to turn "the update
 * matched nothing" into a sentence naming the real figures. Reading it earlier
 * would be the race all over again.
 */
function returnableNow(po, poItemId) {
  const item = (po.items || []).find((i) => String(i._id) === String(poItemId));
  const received = item?.receivedQuantity || 0;
  const alreadyReturned = (po.returnRequests || [])
    .filter((r) => String(r.poItemId) === String(poItemId))
    .reduce((sum, r) => sum + (r.damagedQuantity || 0), 0);
  return { received, alreadyReturned, remaining: Math.max(0, received - alreadyReturned) };
}

/* ── A NARROW SEAM FOR PROVING INTERLEAVINGS ────────────────────────────────
 * The guards in this file each exist for one instant: the moment between one
 * request deciding there is room and another writing that room away. Firing
 * two requests with `Promise.all` and hoping they collide proves very little —
 * it usually passes because the first finished before the second started, and
 * it would go on passing if the guard were deleted.
 *
 * So each contested boundary announces itself. Nothing is registered in normal
 * operation, and `at()` is then a property lookup on an empty object. A test
 * registers a function, holds the first request exactly there, drives the
 * second one to completion, and only then lets the first continue — so the
 * interleaving is something the test states rather than something it hopes for.
 *
 * Deliberately not a general event bus: four named points, no ordering
 * guarantees, and no caller anywhere outside tests. */
/* ── AND IT CANNOT FIRE OUTSIDE A TEST RUN ──────────────────────────────────
 * A mutable object that any code could write a function into, consulted on the
 * path that moves stock, is a way to pause a production request forever. The
 * risk is small and the mitigation costs nothing, so the seam is switched off
 * unless a test runner is what is running: outside one, `at()` returns its
 * argument without so much as a property lookup, and `__hooks` is not exported
 * for anything to reach.
 *
 * `JEST_WORKER_ID` is set by the runner in every worker, including
 * `--runInBand`; NODE_ENV covers a runner that does not set it. */
const TESTING = Boolean(process.env.JEST_WORKER_ID) || process.env.NODE_ENV === "test";

const hooks = TESTING ? Object.create(null) : null;

const at = TESTING
  ? async function at(point, ctx = {}) {
    const fn = hooks[point];
    if (typeof fn === "function") await fn(ctx);
    return ctx;
  }
  /* Production: a function that returns its argument. Nothing to register a
     hook in, and nothing that can wait. */
  : async (point, ctx = {}) => ctx;

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
      damagedQuantity:   dmgQty,
      returnedQuantity:  0,
      pendingReturnQty:  dmgQty,
      status:            "PENDING",
      reason,
      reportedBy:        req.user?.id || null,
      reportedAt:        new Date(),
      operationId,
      receipts:          [],
      createdAt:         new Date(),
      updatedAt:         new Date(),
    };

    let moved;
    let before = null;
    await unitOfWork.run(req.tenant, {
      idempotencyRecord: req.idempotent?.record,
      mutate: async (session) => {
        /* ── THE CONCURRENCY GATE, BEFORE ANY STOCK MOVES ──────────────────
         * One operation: match the order only if this line still has room,
         * and push the return in the same breath. A simultaneous return that
         * used up the room loses here — and loses having changed nothing,
         * which is why this comes before the deduction rather than after it. */
        const q = PurchaseOrder.findOneAndUpdate(
          {
            _id: po._id,
            ...tenantContext.tenantFilter(req.tenant),
            ...returnableGuard(poItem._id, dmgQty),
          },
          { $push: { returnRequests: newReturn } },
          { new: true },
        );
        if (session) q.session(session);
        const updated = await q;

        if (!updated) {
          /* The guard refused. Read the current figures — now that the race is
             over, they are stable — and say precisely what is left. */
          const fresh = await loadPo(req).lean();
          const state = fresh
            ? returnableNow(fresh, poItem._id)
            : { received: 0, alreadyReturned: 0, remaining: 0 };
          throw fail(
            "INVALID_TRANSITION",
            state.alreadyReturned > 0
              ? `Only ${state.remaining} ${poItem.unit} of "${poItem.itemName}" can still be returned — ${state.received} was received and ${state.alreadyReturned} has already been returned.`
              : `Damaged qty (${dmgQty}) cannot exceed received qty (${state.received}).`,
            {
              reason: "RETURNABLE_QUANTITY_EXCEEDED",
              receivedQuantity: state.received,
              alreadyReturnedQuantity: state.alreadyReturned,
              remainingReturnable: state.remaining,
              requested: dmgQty,
              unit: poItem.unit,
              itemName: poItem.itemName,
            },
          );
        }
        before = returnableNow(updated, poItem._id);

        /* ── IF THE STOCK WILL NOT MOVE, THE RETURN MUST NOT STAND ─────────
         * The push had to come first to win the race; that leaves a window
         * where the return exists and the deduction has not happened. Inside a
         * transaction the abort takes care of it. Without one, the push is
         * undone explicitly — a return claiming stock came off a shelf it
         * never left is worse than no return at all, and the caller is about
         * to be told plainly why (insufficient stock, missing variant). */
        /* Between winning the room on the order and taking the stock. */
        await at("returnCreate:beforeStock", { poId: po._id, operationId });
        try {
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
        } catch (stockError) {
          /* As on the receipt path: a test can leave the interrupted state
             standing so the reconciliation branch is what a retry meets. */
          const gate = await at("returnCreate:beforeCompensate", {
            poId: po._id, operationId, skip: false,
          });
          if (gate.skip) throw stockError;

          const undo = PurchaseOrder.updateOne(
            { _id: po._id },
            { $pull: { returnRequests: { operationId } } },
          );
          if (session) undo.session(session);
          await undo.catch((e) => {
            /* The compensation itself failed. Said out loud: the retry will
               find a return with no stock behind it and refuse for
               reconciliation, which is the honest outcome. */
            console.error("[returns] could not undo the return after a stock failure:", e.message);
          });
          throw stockError;
        }

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
      quantityReceived: recvQty,
      receivedDate:     new Date(),
      notes,
      receivedBy:       req.user?.id || null,
      operationId,
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
/* Test seam — see the note beside `at()`. Absent entirely outside a test run. */
if (TESTING) module.exports.__hooks = hooks;
