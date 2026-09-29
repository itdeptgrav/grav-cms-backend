// test/store-purchase/inventory-valuation.engine.test.js
//
// Inventory Valuation V1 — the pure moving weighted-average engine. No DB:
// every proof here is an assertion about valueItem()/summarizeValued() over a
// hand-built movement stream, so the arithmetic and the honesty rules are
// pinned independently of any route.
"use strict";

const mongoose = require("mongoose");
const {
  valueItem,
  summarizeValued,
  matchesStatus,
  REASON,
  STATUS,
} = require("../../services/inventoryValuation.service");

// A movement builder. `t` orders movements (ms offset); `_id` breaks ties.
let seq = 0;
const oid = () => new mongoose.Types.ObjectId();
const mv = (over = {}) => ({
  _id: over._id || oid(),
  type: "ADD",
  quantity: 0,
  unitPrice: undefined,
  createdAt: new Date(1_700_000_000_000 + (over.t != null ? over.t : seq++) * 1000),
  ...over,
});
// A priced receipt carries a PO link so a recorded 0 reads as recorded, not missing.
const receipt = (qty, price, over = {}) =>
  mv({ type: "ADD", quantity: qty, unitPrice: price, purchaseOrderId: oid(), ...over });
const issue = (qty, over = {}) => mv({ type: "REDUCE", quantity: qty, ...over });

const item = (over = {}) => ({
  _id: oid(),
  sku: "RAW-1",
  name: "Cotton fabric",
  unit: "KG",
  quantity: 0,
  variants: [],
  stockTransactions: [],
  ...over,
});

describe("moving weighted-average arithmetic", () => {
  // 1
  test("two priced receipts at different prices produce the correct weighted average", () => {
    const it = item({ quantity: 20, stockTransactions: [receipt(10, 100, { t: 0 }), receipt(10, 200, { t: 1 })] });
    const v = valueItem(it);
    expect(v.valuedQty).toBe(20);
    expect(v.knownValue).toBe(3000);
    expect(v.avgCost).toBe(150);
    expect(v.status).toBe(STATUS.COMPLETE);
  });

  // 2
  test("an issue removes value at the average that held immediately before it", () => {
    const it = item({ quantity: 15, stockTransactions: [receipt(10, 100, { t: 0 }), receipt(10, 200, { t: 1 }), issue(5, { t: 2 })] });
    const v = valueItem(it);
    expect(v.valuedQty).toBe(15);
    expect(v.knownValue).toBe(2250); // 3000 − 5×150
    expect(v.avgCost).toBe(150); // an issue does not move the average
  });

  // 3
  test("a later receipt recalculates the average correctly", () => {
    const it = item({
      quantity: 30,
      stockTransactions: [receipt(10, 100, { t: 0 }), receipt(10, 200, { t: 1 }), issue(5, { t: 2 }), receipt(15, 300, { t: 3 })],
    });
    const v = valueItem(it);
    expect(v.valuedQty).toBe(30);
    expect(v.knownValue).toBe(6750); // 2250 + 15×300
    expect(v.avgCost).toBe(225);
  });
});

describe("recorded zero versus missing price", () => {
  // 4
  test("an explicit zero price remains a recorded zero (valued, not unvalued)", () => {
    const it = item({ quantity: 10, stockTransactions: [receipt(10, 0, { t: 0 })] });
    const v = valueItem(it);
    expect(v.valuedQty).toBe(10); // the quantity IS valued …
    expect(v.knownValue).toBe(0); // … at a recorded zero
    expect(v.unvaluedQty).toBe(0);
    expect(v.avgCost).toBe(0);
    expect(v.fullyValued).toBe(true);
    expect(v.status).toBe(STATUS.COMPLETE);
  });

  // 5
  test("a missing price produces incomplete valuation, never a silent ₹0", () => {
    const it = item({ quantity: 10, stockTransactions: [mv({ type: "ADD", quantity: 10, t: 0 })] });
    const v = valueItem(it);
    expect(v.valuedQty).toBe(0);
    expect(v.unvaluedQty).toBe(10); // exposed, not valued at zero
    expect(v.knownValue).toBe(0);
    expect(v.fullyValued).toBe(false);
    expect(v.status).toBe(STATUS.INCOMPLETE);
    expect(v.reasons).toContain(REASON.MISSING_INBOUND_PRICE);
  });

  test("recorded-zero and missing-price are genuinely distinct outcomes", () => {
    const zero = valueItem(item({ quantity: 10, stockTransactions: [receipt(10, 0)] }));
    const missing = valueItem(item({ quantity: 10, stockTransactions: [mv({ type: "ADD", quantity: 10 })] }));
    expect(zero.unvaluedQty).toBe(0);
    expect(missing.unvaluedQty).toBe(10);
    expect(zero.fullyValued).toBe(true);
    expect(missing.fullyValued).toBe(false);
  });

  // 6
  test("missing opening-stock cost is surfaced as unvalued quantity with its unit", () => {
    const it = item({ unit: "M", quantity: 100, stockTransactions: [mv({ type: "ADD", quantity: 100, reason: "Opening stock" })] });
    const v = valueItem(it);
    expect(v.unvaluedQty).toBe(100);
    expect(v.knownValue).toBe(0);
    expect(v.reasons).toContain(REASON.MISSING_INBOUND_PRICE);
    const s = summarizeValued([v]);
    expect(s.unvaluedByUnit).toEqual({ M: 100 });
    expect(s.incompleteCount).toBe(1);
  });
});

describe("directions, corrections, exceptions", () => {
  // 7
  test("a supplier return removes at the moving average; an internal return adds", () => {
    const it = item({
      quantity: 9,
      stockTransactions: [
        receipt(10, 100, { t: 0 }),
        // supplier return OUT (REDUCE, links a PO, no price) → remove at average
        mv({ type: "REDUCE", quantity: 3, t: 1, purchaseOrderId: oid(), reason: "Return request — damaged" }),
        // internal return IN (ADD, no captured cost) → adds unvalued quantity
        mv({ type: "ADD", quantity: 2, t: 2, reason: "MRF Return — MRF/1" }),
      ],
    });
    const v = valueItem(it);
    expect(v.valuedQty).toBe(7); // 10 − 3
    expect(v.knownValue).toBe(700); // 1000 − 3×100
    expect(v.unvaluedQty).toBe(2); // the internal return, cost unknown
    expect(v.replayedOnHand).toBe(9);
  });

  // 8
  test("a compensating correction affects value exactly once", () => {
    // The route maps a StockLedger COMPENSATING debit to a REDUCE movement; the
    // engine applies each movement once.
    const it = item({
      quantity: 12,
      stockTransactions: [receipt(10, 100, { t: 0 }), receipt(5, 100, { t: 1 }), issue(3, { t: 2, reason: "Correction" })],
    });
    const v = valueItem(it);
    expect(v.valuedQty).toBe(12); // 15 − 3, once
    expect(v.knownValue).toBe(1200); // 1500 − 3×100, once
  });

  // 9
  test("an unknown movement type is reported and never assumed to be stock-in", () => {
    const it = item({ quantity: 10, stockTransactions: [receipt(10, 100, { t: 0 }), mv({ type: "TELEPORT", quantity: 5, unitPrice: 999, t: 1 })] });
    const v = valueItem(it);
    expect(v.valuedQty).toBe(10); // the mystery movement added nothing
    expect(v.knownValue).toBe(1000);
    expect(v.hasExceptions).toBe(true);
    expect(v.exceptions[0].reason).toBe(REASON.UNKNOWN_MOVEMENT_TYPE);
    expect(v.exceptions[0].type).toBe("TELEPORT");
    expect(v.fullyValued).toBe(false);
  });

  // 10
  test("non-finite and negative data are reported safely, not crashed on", () => {
    const it = item({
      quantity: 10,
      stockTransactions: [
        receipt(10, 100, { t: 0 }),
        mv({ type: "ADD", quantity: Number.NaN, t: 1 }),
        mv({ type: "REDUCE", quantity: -5, t: 2 }),
        mv({ type: "ADD", quantity: 3, unitPrice: -20, t: 3 }),
      ],
    });
    const v = valueItem(it);
    expect(v.knownValue).toBe(1000); // only the valid receipt counted
    const reasons = v.exceptions.map((e) => e.reason);
    expect(reasons).toContain(REASON.INVALID_QUANTITY);
    expect(reasons).toContain(REASON.INVALID_PRICE);
  });

  // 11
  test("same-timestamp movements replay in a deterministic _id order", () => {
    const a = new mongoose.Types.ObjectId("64b000000000000000000001"); // earlier id → receipt first
    const b = new mongoose.Types.ObjectId("64b000000000000000000002");
    const when = new Date(1_700_000_500_000);
    const fixedId = new mongoose.Types.ObjectId("64b0000000000000000000ff");
    const build = () =>
      item({
        _id: fixedId,
        quantity: 5,
        stockTransactions: [
          mv({ _id: b, type: "REDUCE", quantity: 5, createdAt: when }),
          mv({ _id: a, type: "ADD", quantity: 10, unitPrice: 100, purchaseOrderId: oid(), createdAt: when }),
        ],
      });
    const v1 = valueItem(build());
    const v2 = valueItem(build());
    // Receipt (id …0001) sorts before issue (id …0002): 10 in @100, then 5 out.
    expect(v1.valuedQty).toBe(5);
    expect(v1.knownValue).toBe(500);
    expect(v2).toEqual(v1); // stable across runs
  });

  // 12
  test("a stored-versus-replayed balance mismatch is shown, not forced", () => {
    const it = item({ quantity: 100, stockTransactions: [receipt(90, 100, { t: 0 })] });
    const v = valueItem(it);
    expect(v.storedOnHand).toBe(100);
    expect(v.replayedOnHand).toBe(90);
    expect(v.difference).toBe(10);
    expect(v.reconciled).toBe(false);
    expect(v.status).toBe(STATUS.UNRECONCILED);
    expect(v.reasons).toContain(REASON.BALANCE_MISMATCH);
  });
});

describe("units and variants", () => {
  // 13
  test("quantities of different units are never summed", () => {
    const kg = valueItem(item({ unit: "KG", quantity: 10, stockTransactions: [receipt(10, 100)] }));
    const m = valueItem(item({ unit: "M", quantity: 5, stockTransactions: [receipt(5, 40)] }));
    const s = summarizeValued([kg, m]);
    expect(s.onHandByUnit).toEqual({ KG: 10, M: 5 }); // grouped, not 15
    expect(s.knownInventoryValue).toBe(1200); // currency may be totalled
  });

  // 14
  test("variant and unassigned movements are kept separate, never merged", () => {
    const vId = oid();
    const it = item({
      quantity: 30,
      variants: [{ _id: vId, sku: "RAW-1-RED", quantity: 20, combination: ["Red"] }],
      stockTransactions: [
        mv({ type: "VARIANT_ADD", quantity: 20, unitPrice: 100, purchaseOrderId: oid(), variantId: vId, t: 0 }),
        mv({ type: "ADD", quantity: 10, unitPrice: 50, purchaseOrderId: oid(), t: 1 }), // whole-item / unassigned
      ],
    });
    const v = valueItem(it, { withVariants: true });
    const variant = v.variants.find((x) => String(x.variantId) === String(vId));
    const unassigned = v.variants.find((x) => x.unassigned);
    expect(variant.replayedOnHand).toBe(20);
    expect(variant.knownValue).toBe(2000);
    expect(unassigned.replayedOnHand).toBe(10);
    expect(unassigned.knownValue).toBe(500);
    // The two buckets are not added together into one variant figure.
    expect(variant.replayedOnHand).not.toBe(30);
  });

  test("variant stored totals that disagree with the item total are flagged", () => {
    const vId = oid();
    const it = item({
      quantity: 30, // item says 30 …
      variants: [{ _id: vId, quantity: 20 }], // … variants only account for 20
      stockTransactions: [mv({ type: "VARIANT_ADD", quantity: 20, unitPrice: 100, purchaseOrderId: oid(), variantId: vId })],
    });
    const v = valueItem(it, { withVariants: true });
    expect(v.variantTotalMismatch).toBe(true);
    expect(v.reasons).toContain(REASON.VARIANT_TOTAL_MISMATCH);
  });
});

describe("purity and status filtering", () => {
  // 18 (engine half) — the engine mutates nothing it is given.
  test("valueItem does not mutate the item or its transactions", () => {
    const txns = [receipt(10, 100, { t: 0 }), issue(4, { t: 1 })];
    const it = item({ quantity: 6, stockTransactions: txns });
    const frozenTxns = txns.map((t) => Object.freeze({ ...t }));
    const frozenItem = Object.freeze({ ...it, stockTransactions: Object.freeze(frozenTxns) });
    const before = JSON.stringify(frozenItem);
    const v = valueItem(frozenItem, { withVariants: true }); // must not throw on frozen input
    expect(v.knownValue).toBe(600);
    expect(JSON.stringify(frozenItem)).toBe(before); // unchanged
  });

  test("status filter matches an item under every real condition it meets", () => {
    const unrec = valueItem(item({ quantity: 100, stockTransactions: [receipt(90, 100)] }));
    // an unreconciled item is also not fully valued? no — it is fully valued but unreconciled
    expect(matchesStatus(unrec, STATUS.UNRECONCILED)).toBe(true);
    expect(matchesStatus(unrec, STATUS.COMPLETE)).toBe(false);
    const incomplete = valueItem(item({ quantity: 10, stockTransactions: [mv({ type: "ADD", quantity: 10 })] }));
    expect(matchesStatus(incomplete, STATUS.INCOMPLETE)).toBe(true);
    const complete = valueItem(item({ quantity: 10, stockTransactions: [receipt(10, 100)] }));
    expect(matchesStatus(complete, STATUS.COMPLETE)).toBe(true);
  });
});

// ═══ V1 CORRECTION — no unsupported certainty ════════════════════════════════
describe("indeterminate cost composition (no valued-first assumption)", () => {
  const unpricedIn = (qty, over = {}) => mv({ type: "ADD", quantity: qty, ...over }); // no unitPrice

  // 4
  test("valued + unpriced receipt with NO outbound stays partly-valued and incomplete", () => {
    const it = item({ quantity: 15, stockTransactions: [receipt(10, 100, { t: 0 }), unpricedIn(5, { t: 1 })] });
    const v = valueItem(it);
    expect(v.valueState).toBe("partly_unvalued");
    expect(v.indeterminate).toBe(false);
    expect(v.knownValue).toBe(1000); // the valued portion is still exact
    expect(v.avgCost).toBe(100);
    expect(v.unvaluedQty).toBe(5);
    expect(v.status).toBe(STATUS.INCOMPLETE);
  });

  // 5 + 7
  test("an outbound while unvalued stock exists makes composition indeterminate (null, not 0)", () => {
    const it = item({ quantity: 12, stockTransactions: [receipt(10, 100, { t: 0 }), unpricedIn(5, { t: 1 }), issue(3, { t: 2 })] });
    const v = valueItem(it);
    expect(v.indeterminate).toBe(true);
    expect(v.status).toBe(STATUS.INDETERMINATE);
    expect(v.knownValue).toBeNull(); // NOT ₹0
    expect(v.avgCost).toBeNull();
    expect(v.valuedQty).toBeNull();
    expect(v.replayedOnHand).toBe(12); // quantity is still known
    expect(v.reasons).toContain(REASON.COST_COMPOSITION_INDETERMINATE);
    expect(v.indeterminateFrom).toBeTruthy();
  });

  // 6 — direction/size of the outbound relative to the valued portion is irrelevant
  test("indeterminacy holds whether the outbound is smaller or larger than the valued portion", () => {
    const small = valueItem(item({ quantity: 14, stockTransactions: [receipt(10, 100, { t: 0 }), unpricedIn(5, { t: 1 }), issue(1, { t: 2 })] }));
    const large = valueItem(item({ quantity: 3, stockTransactions: [receipt(10, 100, { t: 0 }), unpricedIn(5, { t: 1 }), issue(12, { t: 2 })] }));
    expect(small.indeterminate).toBe(true);
    expect(large.indeterminate).toBe(true);
    expect(small.knownValue).toBeNull();
    expect(large.knownValue).toBeNull();
  });

  // 8
  test("reaching exactly zero resets the uncertainty", () => {
    const it = item({
      quantity: 0,
      stockTransactions: [receipt(10, 100, { t: 0 }), unpricedIn(5, { t: 1 }), issue(3, { t: 2 }), issue(12, { t: 3 })], // 15 in, 15 out → 0
    });
    const v = valueItem(it);
    expect(v.replayedOnHand).toBe(0);
    expect(v.indeterminate).toBe(false); // remaining value is exactly zero
    expect(v.knownValue).toBe(0);
  });

  // 9
  test("a fully priced receipt after zero establishes a clean average again", () => {
    const it = item({
      quantity: 4,
      stockTransactions: [
        receipt(10, 100, { t: 0 }), unpricedIn(5, { t: 1 }), issue(3, { t: 2 }), issue(12, { t: 3 }), // → 0, reset
        receipt(4, 250, { t: 4 }), // clean new period
      ],
    });
    const v = valueItem(it);
    expect(v.indeterminate).toBe(false);
    expect(v.valueState).toBe("complete");
    expect(v.knownValue).toBe(1000);
    expect(v.avgCost).toBe(250);
  });

  test("an unapplied (pending) correction count marks attention but changes no quantity/value", () => {
    const base = item({ quantity: 10, stockTransactions: [receipt(10, 100, { t: 0 })] });
    const clean = valueItem(base);
    const withPending = valueItem(base, { pendingCorrectionCount: 1 });
    expect(withPending.knownValue).toBe(clean.knownValue); // unchanged
    expect(withPending.replayedOnHand).toBe(clean.replayedOnHand); // unchanged
    expect(withPending.reasons).toContain(REASON.UNAPPLIED_CORRECTION);
    expect(withPending.status).toBe(STATUS.INCOMPLETE); // attention
  });
});

// ═══ V2 LANDED-COST OVERLAY ══════════════════════════════════════════════════
describe("landed-cost overlay onto priced receipts", () => {
  const landed = (movementId, perUnit, sources = []) =>
    new Map([[String(movementId), { perUnit, sources }]]);

  // 13 (engine half) + 14 + 15
  test("effective receipt cost = base + per-unit landed; weighted average rises correctly", () => {
    const rid = oid();
    const it = item({ quantity: 10, stockTransactions: [receipt(10, 100, { _id: rid, t: 0 })] });
    const v = valueItem(it, { landedByMovement: landed(rid, 8) });
    expect(v.baseStockValue).toBe(1000); // base unchanged
    expect(v.landedInStock).toBe(80); // 10 × 8
    expect(v.knownValue).toBe(1080); // effective
    expect(v.avgCost).toBe(108); // base 100 + landed 8
    expect(v.baseAvgCost).toBe(100);
    expect(v.receipts[0].baseUnitCost).toBe(100);
    expect(v.receipts[0].landedPerUnit).toBe(8);
    expect(v.receipts[0].effectiveUnitCost).toBe(108);
  });

  // 16
  test("a partial issue leaves only the proportional landed cost in current stock", () => {
    const rid = oid();
    const it = item({ quantity: 6, stockTransactions: [receipt(10, 100, { _id: rid, t: 0 }), issue(4, { t: 1 })] });
    const v = valueItem(it, { landedByMovement: landed(rid, 8) });
    expect(v.replayedOnHand).toBe(6);
    expect(v.baseStockValue).toBe(600); // 6 × 100
    expect(v.landedInStock).toBe(48); // 6/10 of the ₹80 landed — the rest left with the issue
    expect(v.knownValue).toBe(648);
    expect(v.avgCost).toBe(108); // an issue does not move the average
  });

  // 17 — landed cannot rescue an unpriced receipt
  test("landed cost on an unpriced receipt does not make it valued (honesty preserved)", () => {
    const rid = oid();
    const it = item({ quantity: 10, stockTransactions: [mv({ type: "ADD", quantity: 10, _id: rid, t: 0 })] }); // no price
    const v = valueItem(it, { landedByMovement: landed(rid, 8) });
    expect(v.unvaluedQty).toBe(10);
    expect(v.knownValue).toBe(0);
    expect(v.reasons).toContain(REASON.LANDED_WITHOUT_BASE);
    expect(v.reasons).toContain(REASON.MISSING_INBOUND_PRICE);
  });

  // 18
  test("a landed allocation whose target movement is missing is an exception, not a guess", () => {
    const rid = oid();
    const it = item({ quantity: 10, stockTransactions: [receipt(10, 100, { _id: rid, t: 0 })] });
    const v = valueItem(it, { landedByMovement: landed(oid() /* not in item */, 8) });
    expect(v.knownValue).toBe(1000); // the real receipt is untouched by the stray allocation
    expect(v.hasExceptions).toBe(true);
    expect(v.exceptions.some((e) => e.reason === REASON.MISSING_ALLOCATION_TARGET)).toBe(true);
  });

  test("indeterminate items stay indeterminate even with a landed allocation", () => {
    const rid = oid();
    const it = item({
      quantity: 12,
      stockTransactions: [receipt(10, 100, { _id: rid, t: 0 }), mv({ type: "ADD", quantity: 5, t: 1 }), issue(3, { t: 2 })],
    });
    const v = valueItem(it, { landedByMovement: landed(rid, 8) });
    expect(v.indeterminate).toBe(true);
    expect(v.knownValue).toBeNull(); // never a landed-inflated ₹ figure
    expect(v.landedInStock).toBeNull();
  });
});
