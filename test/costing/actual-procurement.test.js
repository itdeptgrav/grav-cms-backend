// test/costing/actual-procurement.test.js
//
// WHAT COUNTS AS AN ACTUAL, AND WHAT MUST NEVER BE MISTAKEN FOR ONE.
//
// Every dangerous mistake here produces a confident number. Treating received
// stock as accepted. Treating a draft bill as posted. Putting recoverable GST
// into cost. Adding the same freight twice. Rolling three causes into one
// "variance". Dividing a partial posted amount by the output quantity to make
// a unit cost. Each reads as a finding and is not one.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const A = require("../../services/centralCosting/actualProcurement.service");
const { STATE, GAP } = A;

const orderLine = (over = {}) => ({
  kind: "PURCHASE_ORDER", orderId: "po1", orderNumber: "PO-1", lineId: "pol1",
  supplierId: "sup1", supplierName: "Arvind Mills",
  quantity: 700, unit: "m", rate: 412.5, net: 288750, status: "issued", ...over,
});
const voucher = (over = {}) => ({
  voucherId: "v1", voucherNumber: "PV-1", voucherDate: new Date("2026-08-01"),
  status: "posted", quantity: 700, rate: 412.5, net: 288750,
  taxAmount: 0, taxRecoverable: undefined, lineMatched: true, ...over,
});
const requestLine = (over = {}) => ({
  requestId: "r1", requestNumber: "SPR-1", requestType: "PRODUCT", requestStatus: "approved",
  spendLineId: "sl1", requestQuantity: 700, requestUnit: "m", requestRateMinor: 41250, ...over,
});
const measure = (over = {}) => A.measureLine({
  requestLine: over.requestLine === null ? null : (over.requestLine || requestLine()),
  orderLines: over.orderLines || [orderLine()],
  receipts: over.receipts || [],
  inspections: over.inspections || [],
  vouchers: over.vouchers || [],
  allocations: over.allocations || [],
});

/* ₹200/m estimated, 700 m, ₹1,40,000 — against the fixtures above. */
const estimate = (over = {}) => ({
  quantity: "700", unit: "m", rateMinor: 41250, netMinor: 28875000,
  nonRecoverableTaxMinor: 0, recoverableTaxMinor: 5197500, landedMinor: null,
  supplierId: "sup1", supplierName: "Arvind Mills", quotation: "Q-14", quotationRevision: 2, ...over,
});

/* ── 7, 8 · RECEIVED IS NOT ACCEPTED ─────────────────────────────────────── */

describe("what has actually been accepted", () => {
  test("received but uninspected is never counted as accepted", () => {
    const m = measure({ receipts: [{ receivedQuantity: 700, receiptNumber: "GRN-1" }] });
    expect(m.receivedQuantity).toBe(700);
    /* THE POINT: inspection is the only authority on acceptance. */
    expect(m.acceptedQuantity).toBe(0);
    expect(m.gaps).toContain(GAP.NO_INSPECTION);
    expect(A.stateOf({ requestLine: requestLine(), measured: m })).toBe(STATE.AWAITING_INSPECTION);
  });

  test("quarantined quantity is neither accepted nor rejected, and keeps the line open", () => {
    const m = measure({
      receipts: [{ receivedQuantity: 700 }],
      inspections: [{ acceptedQuantity: 600, quarantinedQuantity: 100, rejectedQuantity: 0 }],
    });
    expect(m.acceptedQuantity).toBe(600);
    expect(m.quarantinedQuantity).toBe(100);
    expect(m.gaps).toContain(GAP.OPEN_QUARANTINE);
    /* A posted bill does not settle a line with stock still in quarantine. */
    const withBill = measure({
      receipts: [{ receivedQuantity: 700 }],
      inspections: [{ acceptedQuantity: 600, quarantinedQuantity: 100, rejectedQuantity: 0 }],
      vouchers: [voucher()],
    });
    expect(A.stateOf({ requestLine: requestLine(), measured: withBill })).toBe(STATE.PARTLY_ACCEPTED);
  });

  test("a rejected quantity does not disappear", () => {
    const m = measure({
      receipts: [{ receivedQuantity: 700 }],
      inspections: [{ acceptedQuantity: 650, quarantinedQuantity: 0, rejectedQuantity: 50 }],
    });
    expect(m.rejectedQuantity).toBe(50);
    expect(m.gaps).toContain(GAP.OPEN_RETURN);
    expect(A.stateOf({ requestLine: requestLine(), measured: m })).toBe(STATE.RETURNED);
  });
});

/* ── 9, 10, 11, 12 · ONLY A POSTED VOUCHER IS AN ACTUAL ──────────────────── */

describe("what counts as a financial actual", () => {
  const accepted = { receipts: [{ receivedQuantity: 700 }], inspections: [{ acceptedQuantity: 700, quarantinedQuantity: 0, rejectedQuantity: 0 }] };

  test("a posted bill becomes the actual", () => {
    const m = measure({ ...accepted, vouchers: [voucher()] });
    expect(m.postedNetMinor).toBe(28875000);
    expect(m.postedActualMinor).toBe(28875000);
    expect(A.stateOf({ requestLine: requestLine(), measured: m })).toBe(STATE.POSTED);
  });

  test("a draft or pending bill is shown but never enters the actual", () => {
    for (const status of ["draft", "pending_approval"]) {
      const m = measure({ ...accepted, vouchers: [voucher({ status })] });
      expect(m.postedNetMinor).toBe(0);
      expect(m.postedActualMinor).toBe(0);
      /* Shown, so nobody thinks the bill is missing... */
      expect(m.recordedNotPosted).toHaveLength(1);
      expect(m.gaps).toContain(GAP.BILL_NOT_POSTED);
      /* ...and named for what it is. */
      expect(A.stateOf({ requestLine: requestLine(), measured: m })).toBe(STATE.BILL_NOT_POSTED);
    }
  });

  test("accepted with no bill at all waits for one", () => {
    const m = measure(accepted);
    expect(m.gaps).toContain(GAP.NO_BILL);
    expect(A.stateOf({ requestLine: requestLine(), measured: m })).toBe(STATE.AWAITING_BILL);
    expect(A.NEXT_ACTION[STATE.AWAITING_BILL]).toBe("Waiting for supplier bill.");
  });

  test("recoverable GST is excluded from cost; non-recoverable is included where recorded", () => {
    const recoverable = measure({ ...accepted, vouchers: [voucher({ taxAmount: 51975, taxRecoverable: true })] });
    expect(recoverable.postedRecoverableMinor).toBe(5197500);
    /* The company gets it back, so it is not cost. */
    expect(recoverable.postedActualMinor).toBe(28875000);

    const nonRecoverable = measure({ ...accepted, vouchers: [voucher({ taxAmount: 51975, taxRecoverable: false })] });
    expect(nonRecoverable.postedNonRecoverableMinor).toBe(5197500);
    expect(nonRecoverable.postedActualMinor).toBe(28875000 + 5197500);
  });

  test("tax with no recorded treatment is counted as neither", () => {
    /* Nobody saying is not the same as "recoverable". It is added to nothing
       and reported as unrecorded. */
    const m = measure({ ...accepted, vouchers: [voucher({ taxAmount: 51975, taxRecoverable: undefined })] });
    expect(m.postedNonRecoverableMinor).toBe(0);
    expect(m.postedRecoverableMinor).toBe(0);
    expect(m.posted[0].taxTreatmentRecorded).toBe(false);
    expect(m.postedActualMinor).toBe(28875000);
  });

  test("a posted bill that names the order but not the line stays visible and unattributed", () => {
    const m = measure({ ...accepted, vouchers: [voucher({ lineMatched: false })] });
    /* It is not silently attributed to this requirement... */
    expect(m.postedNetMinor).toBe(0);
    /* ...and it is not hidden either. */
    expect(m.unattributedVouchers).toHaveLength(1);
    expect(m.gaps).toContain(GAP.UNLINKED_VOUCHER);
    expect(A.stateOf({ requestLine: requestLine(), measured: m })).toBe(STATE.RECONCILE);
  });
});

/* ── 13, 14 · LANDED CHARGES ─────────────────────────────────────────────── */

describe("landed charges", () => {
  const accepted = { receipts: [{ receivedQuantity: 700 }], inspections: [{ acceptedQuantity: 700, quarantinedQuantity: 0, rejectedQuantity: 0 }] };

  test("an allocated charge is added once", () => {
    const m = measure({ ...accepted, vouchers: [voucher()], allocations: [{ allocatedAmount: 5000, voucherNumber: "PV-9" }] });
    expect(m.landedMinor).toBe(500000);
    expect(m.postedActualMinor).toBe(28875000 + 500000);
    /* And reading it twice does not add it twice — the sum is over the
       allocations passed, and only ACTIVE ones are read. */
    const twice = measure({ ...accepted, vouchers: [voucher()], allocations: [{ allocatedAmount: 5000 }, { allocatedAmount: 5000 }] });
    expect(twice.landedMinor).toBe(1000000);
  });

  test("an unallocated charge is an exception, not a share spread over the lines", () => {
    const m = measure({ ...accepted, vouchers: [voucher()], allocations: [{ allocatedAmount: 0, unallocated: true }] });
    expect(m.landedMinor).toBe(0);
    expect(m.gaps).toContain(GAP.UNALLOCATED_CHARGE);
    expect(A.GAP_TEXT.UNALLOCATED_CHARGE).toMatch(/has not been allocated/i);
  });
});

/* ── 5, 6 · SUPPLIER SPLITTING ───────────────────────────────────────────── */

describe("one requirement across several suppliers", () => {
  test("several order lines are kept separate, each with its own supplier and rate", () => {
    const m = measure({
      orderLines: [
        orderLine({ orderId: "po1", orderNumber: "PO-1", lineId: "a", supplierId: "sup1", supplierName: "Arvind Mills", quantity: 400, rate: 412.5, net: 165000 }),
        orderLine({ orderId: "po2", orderNumber: "PO-2", lineId: "b", supplierId: "sup2", supplierName: "Coats India", quantity: 300, rate: 420, net: 126000 }),
      ],
    });
    expect(m.ordered).toHaveLength(2);
    expect(m.orderedQuantity).toBe(700);
    expect(m.orderedNetMinor).toBe(16500000 + 12600000);
    /* Neither collapsed into the other. */
    expect(m.ordered.map((o) => o.supplierName)).toEqual(["Arvind Mills", "Coats India"]);
    expect(m.ordered.map((o) => o.rateMinor)).toEqual([41250, 42000]);
  });

  test("an approved request with no order says exactly that", () => {
    const m = measure({ orderLines: [] });
    expect(m.gaps).toContain(GAP.NO_ORDER);
    const state = A.stateOf({ requestLine: requestLine(), measured: m });
    expect(state).toBe(STATE.APPROVED_NOT_ORDERED);
    expect(A.NEXT_ACTION[state]).toMatch(/has not yet been converted into the required supplier orders/);
  });

  test("a substitution is stated as a fact, and never counted as money twice", () => {
    const m = measure({
      orderLines: [orderLine({ supplierId: "sup9", supplierName: "Someone Else Ltd" })],
      receipts: [{ receivedQuantity: 700 }],
      inspections: [{ acceptedQuantity: 700, quarantinedQuantity: 0, rejectedQuantity: 0 }],
      vouchers: [voucher()],
    });
    const v = A.varianceFor({ estimate: estimate(), measured: m });
    expect(v.supplierSubstituted).toBe(true);
    expect(v.estimatedSupplier).toBe("Arvind Mills");
    expect(v.actualSuppliers).toEqual(["Someone Else Ltd"]);
    /* The money it moved is already inside the rate variance; there is no
       separate substitution amount to double-count. */
    expect(v.causes.some((c) => c.cause === "SUBSTITUTION")).toBe(false);
  });
});

/* ── 21, 22 · VARIANCE, CAUSE BY CAUSE ───────────────────────────────────── */

describe("variance decomposition", () => {
  const accepted = { receipts: [{ receivedQuantity: 760 }], inspections: [{ acceptedQuantity: 760, quarantinedQuantity: 0, rejectedQuantity: 0 }] };

  test("quantity and price variances are separate and do not double-count", () => {
    /* 760 m billed at ₹420 against 700 m estimated at ₹412.50. */
    const m = measure({ ...accepted, vouchers: [voucher({ quantity: 760, rate: 420, net: 319200 })] });
    const v = A.varianceFor({ estimate: estimate(), measured: m });
    const by = Object.fromEntries(v.causes.map((c) => [c.cause, c]));

    /* 60 extra metres at the ESTIMATE's rate — no price effect in it. */
    expect(by.QUANTITY.amountMinor).toBe(Math.round(60 * 41250));
    /* ₹7.50 more per metre across the ACTUAL quantity — no volume effect. */
    expect(by.RATE.amountMinor).toBe(Math.round(750 * 760));
    /* Together they account for the whole difference. */
    expect(by.QUANTITY.amountMinor + by.RATE.amountMinor).toBe(31920000 - 28875000);
    expect(v.reconciles).toBe(true);
    expect(v.unexplainedMinor).toBe(0);
  });

  test("a tax-treatment change is its own cause, not folded into the rate", () => {
    const m = measure({
      receipts: [{ receivedQuantity: 700 }],
      inspections: [{ acceptedQuantity: 700, quarantinedQuantity: 0, rejectedQuantity: 0 }],
      vouchers: [voucher({ taxAmount: 51975, taxRecoverable: false })],
    });
    const v = A.varianceFor({ estimate: estimate(), measured: m });
    const by = Object.fromEntries(v.causes.map((c) => [c.cause, c]));
    expect(by.TAX.amountMinor).toBe(5197500);
    expect(by.RATE).toBeUndefined();
    expect(by.QUANTITY).toBeUndefined();
    expect(v.reconciles).toBe(true);
  });

  test("a landed charge nobody estimated is its own cause", () => {
    const m = measure({
      receipts: [{ receivedQuantity: 700 }],
      inspections: [{ acceptedQuantity: 700, quarantinedQuantity: 0, rejectedQuantity: 0 }],
      vouchers: [voucher()], allocations: [{ allocatedAmount: 5000 }],
    });
    const v = A.varianceFor({ estimate: estimate(), measured: m });
    const by = Object.fromEntries(v.causes.map((c) => [c.cause, c]));
    expect(by.LANDED.amountMinor).toBe(500000);
    expect(v.reconciles).toBe(true);
  });

  test("what the causes cannot explain is stated, never forced to zero", () => {
    /* A posted amount that matches neither the quantity nor the rate on
       record — the kind of thing a credit note or a manual edit produces. */
    const m = measure({
      receipts: [{ receivedQuantity: 700 }],
      inspections: [{ acceptedQuantity: 700, quarantinedQuantity: 0, rejectedQuantity: 0 }],
      vouchers: [voucher({ lineMatched: false })],
    });
    const v = A.varianceFor({ estimate: estimate(), measured: m });
    /* Nothing was attributable, so no cause could be computed... */
    expect(v.comparable).toBe(false);
    /* ...and the whole difference is reported as unexplained rather than
       silently absorbed. */
    expect(v.totalMinor).toBe(-28875000);
    expect(v.unexplainedMinor).toBe(-28875000);
    expect(v.reconciles).toBe(false);
  });
});

/* ── 8, 23 · FAMILIES ────────────────────────────────────────────────────── */

describe("cost families", () => {
  test("connected and unconnected families are distinguished, and none is ₹0", () => {
    const connected = Object.entries(A.FAMILY_FEEDBACK).filter(([, f]) => f.connected).map(([k]) => k);
    const not = Object.entries(A.FAMILY_FEEDBACK).filter(([, f]) => !f.connected).map(([k]) => k);
    expect(connected).toEqual(expect.arrayContaining(["materials", "packaging", "services", "freight", "development"]));
    expect(not).toEqual(expect.arrayContaining(["operations", "financing", "overhead"]));
    /* An unmeasurable family says so instead of reading as free. */
    for (const key of not) {
      expect(A.FAMILY_FEEDBACK[key].reason).toMatch(/Actual source not connected/i);
      expect(A.FAMILY_FEEDBACK[key]).not.toHaveProperty("amountMinor");
    }
    expect(Object.keys(A.FAMILY_FEEDBACK)).toHaveLength(9);
  });

  test("what is not yet connected is named as a later connection", () => {
    expect(A.LATER).toEqual(expect.arrayContaining([
      "Actual material consumption from production",
      "Actual labour and operation cost",
      "Final finished-product unit cost",
    ]));
    expect(A.STANDING).toMatch(/not the full finished-product actual cost/i);
    expect(A.TITLE).toBe("Procurement cost feedback");
  });
});

/* ── 10 · MANAGEMENT LANGUAGE ────────────────────────────────────────────── */

test("no internal identifier or status enum reaches the reader's words", () => {
  const words = JSON.stringify(A.STATE) + JSON.stringify(A.NEXT_ACTION)
    + JSON.stringify(A.GAP_TEXT) + A.STANDING + A.TITLE;
  for (const jargon of [
    "spendLineId", "costingDemandSource", "poItemId", "projectionRequirementId",
    "pending_approval", "APPROVED_COSTING_PROJECTION", "collection", "voucherType",
  ]) {
    expect(words).not.toContain(jargon);
  }
  /* And the recommended copy is actually used. */
  expect(Object.values(A.NEXT_ACTION)).toEqual(expect.arrayContaining([
    "Waiting for inspection.", "Waiting for supplier bill.", "Bill recorded but not posted.",
  ]));
});
