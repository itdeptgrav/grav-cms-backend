// test/costing/production-actual.test.js
//
// WHAT PRODUCTION ACTUALLY COST — AND THE ONE FIGURE THIS SYSTEM CANNOT GIVE.
//
// The audit behind this chunk found three things that decide almost every
// assertion here:
//
//   · `MRF.items[].consumedQty` is `issuedQty − returnedQty`, computed by the
//     MRF routes. It is NET ISSUE wearing the word "consumed".
//   · There is no QC inspection-result collection. `qcCompletion` on a work
//     order is a project manager's manual mark, which the model says stands in
//     for results that live per-barcode and are never rolled up.
//   · No payroll or work-order labour posting exists at all.
//
// So: no confirmed consumption, no authoritative good output, no paid-labour
// actual. Each test below is really asking whether the report says so instead
// of producing a confident number anyway.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const P = require("../../services/centralCosting/productionActual.service");
const { BASIS, BLOCKER } = P;

const oid = () => require("mongoose").Types.ObjectId().toString?.() || String(Math.random());
const ITEM = "aaaaaaaaaaaaaaaaaaaaaaa1";
const VARIANT = "bbbbbbbbbbbbbbbbbbbbbbb1";
const STOCK_ITEM = "ccccccccccccccccccccccc1";

const workOrder = (over = {}) => ({
  _id: "wo1", workOrderNumber: "WO-1", customerRequestId: "cr1",
  stockItemId: STOCK_ITEM, variantId: null, status: "in_progress", quantity: 500,
  cuttingProgress: { completed: 500 },
  productionCompletion: { overallCompletedQuantity: 480, efficiencyMetrics: [] },
  qcCompletion: { completedQuantity: 470 },
  packagedQuantity: 0, bulkDispatchHistory: [], ...over,
});
const issuance = (over = {}) => ({
  _id: "si1", direction: "debit", manufacturingOrder: "cr1",
  items: [{ rawItem: ITEM, variantId: VARIANT, nativeQty: 740, nativeUnit: "m" }], ...over,
});

/* ── 2 · LINEAGE BY STORED IDENTITY ──────────────────────────────────────── */

describe("which work orders belong to this costing", () => {
  test("a work order for another product under the same customer order is excluded", () => {
    const mine = workOrder();
    /* Same customer request, same everything a name would match on — a
       different product. Attributing it would charge one garment's material
       to another. */
    const theirs = workOrder({ _id: "wo2", workOrderNumber: "WO-2", stockItemId: "dddddddddddddddddddddd99" });
    const s = P.selectWorkOrders([mine, theirs], { stockItemId: STOCK_ITEM });
    expect(s.attributed.map((w) => w._id)).toEqual(["wo1"]);
    /* And it is not silently dropped — it stays as unlinked evidence. */
    expect(s.unlinked.map((w) => w._id)).toEqual(["wo2"]);
  });

  test("a same-name decoy with no stored product identity is never attributed", () => {
    const decoy = workOrder({ _id: "wo3", workOrderNumber: "WO-1", stockItemId: null });
    const s = P.selectWorkOrders([workOrder(), decoy], { stockItemId: STOCK_ITEM });
    expect(s.attributed).toHaveLength(1);
    expect(s.attributed[0]._id).toBe("wo1");
    expect(s.unlinked[0]._id).toBe("wo3");
  });

  test("a different variant of the same stock item is a different garment", () => {
    const other = workOrder({ _id: "wo4", variantId: "zzzzzzzzzzzzzzzzzzzzzzz9" });
    const s = P.selectWorkOrders([other], { stockItemId: STOCK_ITEM, variantId: VARIANT });
    expect(s.attributed).toHaveLength(0);
    expect(s.unlinked).toHaveLength(1);
  });

  test("split work orders aggregate exactly once; cancelled work is excluded but kept", () => {
    const a = workOrder({ _id: "a", productionCompletion: { overallCompletedQuantity: 200, efficiencyMetrics: [] } });
    const b = workOrder({ _id: "b", productionCompletion: { overallCompletedQuantity: 300, efficiencyMetrics: [] } });
    const dead = workOrder({ _id: "c", status: "cancelled", productionCompletion: { overallCompletedQuantity: 999, efficiencyMetrics: [] } });
    const s = P.selectWorkOrders([a, b, dead], { stockItemId: STOCK_ITEM });
    expect(s.attributed).toHaveLength(2);
    expect(s.cancelled).toHaveLength(1);
    const out = P.outputFrom(s.attributed);
    /* 500, not 1,499 — and not 200 or 300 twice. */
    expect(out.completed).toBe(500);
    expect(out.workOrderCount).toBe(2);
  });
});

/* ── 4 · OUTPUT: COMPLETED IS NOT GOOD ───────────────────────────────────── */

describe("production output", () => {
  test("good accepted output stays unavailable until every run is CLOSED", () => {
    /* No closeouts passed — the work order is still open. */
    const out = P.outputFrom([workOrder()], []);
    expect(out.completed).toBe(480);
    expect(out.completedBasis).toBe(BASIS.MEASURED);
    /* A partial accepted total is not a denominator, so it is withheld — and
       the reason now names the missing ACTION rather than a missing source,
       because 8C connected the source. */
    expect(out.goodAccepted).toBeNull();
    expect(out.goodAcceptedBasis).toBe(BASIS.UNAVAILABLE);
    expect(out.goodAcceptedReason).toMatch(/have not had their production closed/i);
    expect(out.closeoutCoverage.complete).toBe(false);
    expect(out.closeoutCoverage.open[0].number).toBe("WO-1");
  });

  test("a closed run makes accepted output authoritative and measured", () => {
    const out = P.outputFrom([workOrder()], [
      { workOrderId: "wo1", output: { acceptedGoodQty: 460, rejectedQty: 15, openReworkQty: 0 } },
    ]);
    expect(out.goodAccepted).toBe(460);
    expect(out.goodAcceptedBasis).toBe(BASIS.MEASURED);
    expect(out.rejected).toBe(15);
    expect(out.closeoutCoverage.complete).toBe(true);
    /* The manual mark is still shown, still a proxy, and still not it. */
    expect(out.qcMarked).toBe(470);
    expect(out.qcMarkedBasis).toBe(BASIS.PROXY);
    expect(out.goodAccepted).not.toBe(out.qcMarked);
  });

  test("one unclosed run among several keeps accepted output withheld", () => {
    const a = workOrder({ _id: "a" });
    const b = workOrder({ _id: "b" });
    const out = P.outputFrom([a, b], [{ workOrderId: "a", output: { acceptedGoodQty: 200 } }]);
    /* 200 is a subtotal, and a subtotal used as a denominator is wrong
       rather than provisional. */
    expect(out.goodAccepted).toBeNull();
    expect(out.closeoutCoverage.closed).toBe(1);
    expect(out.closeoutCoverage.total).toBe(2);
  });

  test("the manual QC mark is shown, labelled a proxy, and never used as good output", () => {
    const out = P.outputFrom([workOrder()]);
    expect(out.qcMarked).toBe(470);
    expect(out.qcMarkedBasis).toBe(BASIS.PROXY);
    expect(out.qcMarkedNote).toMatch(/Marked by a project manager/i);
    /* It is a different field from goodAccepted, which stays null. */
    expect(out.goodAccepted).not.toBe(470);
  });
});

/* ── 3 · MATERIAL: NET ISSUED, NOT CONSUMED ──────────────────────────────── */

describe("material movement", () => {
  test("returns reduce the net exactly once", () => {
    const m = P.materialMovement([
      issuance(),
      issuance({ _id: "si2", direction: "credit", items: [{ rawItem: ITEM, variantId: VARIANT, nativeQty: 40, nativeUnit: "m" }] }),
    ], { itemId: ITEM, variantId: VARIANT });
    expect(m.issuedQty).toBe(740);
    expect(m.returnedQty).toBe(40);
    expect(m.netIssuedQty).toBe(700);
  });

  test("net issue is never called confirmed consumption", () => {
    const m = P.materialMovement([issuance()], { itemId: ITEM, variantId: VARIANT });
    expect(m.basis).toBe("Net issued to production");
    /* Nothing in this system records what production actually used. */
    expect(m.confirmedConsumedQty).toBeNull();
    const line = P.materialLine({
      requirement: { requirementId: "fabric:PHYSICAL", reference: { itemId: ITEM, variantId: VARIANT }, identity: { name: "Oxford cotton" }, quantity: { consumptionPerUnit: "1.4", orderQuantity: "700", consumptionUom: "m" }, kind: "PHYSICAL" },
      movement: m,
      outputBasis: { quantity: 480, basis: BASIS.MEASURED },
    });
    expect(line.actualBasis).toBe("Net issued to production");
    expect(line.confirmedConsumedQty).toBeNull();
    expect(line.blockers).toContain(BLOCKER.CONSUMPTION_PROXY);
  });

  test("another item's or another variant's issues are never absorbed", () => {
    const m = P.materialMovement([
      issuance(),
      issuance({ _id: "si3", items: [{ rawItem: "eeeeeeeeeeeeeeeeeeeeeee9", variantId: VARIANT, nativeQty: 999, nativeUnit: "m" }] }),
      issuance({ _id: "si4", items: [{ rawItem: ITEM, variantId: "fffffffffffffffffffffff9", nativeQty: 888, nativeUnit: "m" }] }),
    ], { itemId: ITEM, variantId: VARIANT });
    expect(m.issuedQty).toBe(740);
  });

  test("incompatible units refuse the comparison rather than adding", () => {
    const m = P.materialMovement([
      issuance(),
      issuance({ _id: "si5", items: [{ rawItem: ITEM, variantId: VARIANT, nativeQty: 12, nativeUnit: "kg" }] }),
    ], { itemId: ITEM, variantId: VARIANT });
    expect(m.unitConflict).toBe(true);
    expect(m.basis).toBe(BASIS.UNAVAILABLE);
    const line = P.materialLine({
      requirement: { requirementId: "x", reference: { itemId: ITEM, variantId: VARIANT }, identity: {}, quantity: { orderQuantity: "700", consumptionUom: "m" }, kind: "PHYSICAL" },
      movement: m, outputBasis: { quantity: 480, basis: BASIS.MEASURED },
    });
    /* No variance, no per-unit figure — an incompatible comparison is worse
       than none. */
    expect(line.quantityVariance).toBeNull();
    expect(line.perGoodUnit).toBeNull();
    expect(line.blockers).toContain(BLOCKER.MATERIAL_UNIT);
  });

  test("consumed material VALUE is never taken from today's item price", () => {
    const line = P.materialLine({
      requirement: { requirementId: "x", reference: { itemId: ITEM }, identity: {}, quantity: { orderQuantity: "700" }, kind: "PHYSICAL" },
      movement: P.materialMovement([issuance()], { itemId: ITEM }),
      outputBasis: { quantity: 480, basis: BASIS.MEASURED },
    });
    /* A price today is not the price this issue was made at. */
    expect(line.consumedValueMinor).toBeNull();
    expect(line.consumedValueBasis).toBe(BASIS.UNAVAILABLE);
    expect(line.consumedValueReason).toMatch(/historical issue value is not available/i);
    /* The QUANTITY truth is still reported. */
    expect(line.netIssuedQty).toBe(740);
  });
});

/* ── 5 · LABOUR CLASSIFICATION ───────────────────────────────────────────── */

describe("labour and conversion", () => {
  const metric = (over = {}) => ({ operationCode: "STITCH", unitsCompleted: 480, totalProductiveTime: 0, ...over });

  test("recorded time at a frozen rate is APPLIED conversion, never paid labour", () => {
    const l = P.labourFrom({
      workOrders: [workOrder({ productionCompletion: { overallCompletedQuantity: 480, efficiencyMetrics: [metric({ totalProductiveTime: 6000 })] } })],
      operationEstimates: [{ code: "STITCH", ratePerMinuteMinor: 500, perUnitMinor: 1000 }],
    });
    expect(l.operations[0].basis).toBe("Applied conversion cost");
    expect(l.operations[0].amountMinor).toBe(Math.round((6000 / 60) * 500));
    expect(l.basis).toBe("Applied conversion cost");
    /* And the paid figure is stated as absent, always. */
    expect(l.postedActualMinor).toBeNull();
    expect(l.postedActualReason).toMatch(/no payroll or work-order labour posting/i);
  });

  test("units with no recorded time are ABSORBED at the approved rate", () => {
    const l = P.labourFrom({
      workOrders: [workOrder({ productionCompletion: { overallCompletedQuantity: 480, efficiencyMetrics: [metric()] } })],
      operationEstimates: [{ code: "STITCH", perUnitMinor: 1000 }],
    });
    expect(l.operations[0].basis).toBe("Absorbed at approved rate");
    expect(l.operations[0].amountMinor).toBe(480000);
    expect(l.operations[0].note).toMatch(/No production time was recorded/i);
  });

  test("a mixed total takes the weaker label, never the stronger one", () => {
    const l = P.labourFrom({
      workOrders: [workOrder({ productionCompletion: { overallCompletedQuantity: 480, efficiencyMetrics: [
        metric({ operationCode: "STITCH", totalProductiveTime: 6000 }),
        metric({ operationCode: "PRESS" }),
      ] } })],
      operationEstimates: [
        { code: "STITCH", ratePerMinuteMinor: 500, perUnitMinor: 1000 },
        { code: "PRESS", perUnitMinor: 200 },
      ],
    });
    expect(l.basis).toBe("Absorbed at approved rate");
    expect(l.totalMinor).toBe(50000 + 96000);
  });

  test("an operation with no approved rate is unavailable, not free", () => {
    const l = P.labourFrom({
      workOrders: [workOrder({ productionCompletion: { overallCompletedQuantity: 480, efficiencyMetrics: [metric({ operationCode: "UNKNOWN" })] } })],
      operationEstimates: [],
    });
    expect(l.operations[0].amountMinor).toBeNull();
    expect(l.operations[0].basis).toBe(BASIS.UNAVAILABLE);
    expect(l.totalMinor).toBeNull();
  });

  test("no employee salary is ever looked up", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../services/centralCosting/productionActual.service.js"), "utf8",
    );
    /* A current salary applied to past production restates history under a
       label that says "actual". */
    for (const forbidden of ["Employee.find", "salary", "Salary", "payrollLookup", "EmployeeSalary"]) {
      expect(src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n")).not.toContain(forbidden);
    }
  });
});

/* ── 6, 7 · THE BRIDGE AND THE GATE ──────────────────────────────────────── */

describe("the product-cost bridge", () => {
  const procurementReport = (over = {}) => ({
    summary: {
      complete: true, postedActualMinor: 28875000, landedPostedMinor: 500000,
      recoverableTaxMinor: 5197500, nonRecoverableTaxMinor: 0,
      estimatedProcurementMinor: 28875000, ...over.summary,
    },
    requirements: over.requirements || [
      { kind: "PHYSICAL", actual: { postedActualMinor: 28875000 }, variance: { causes: [] } },
    ],
  });

  test("a missing family is null and is never totalled as zero", () => {
    const b = P.bridgeFrom({
      procurementReport: procurementReport(), materials: [], policy: null,
      labour: { totalMinor: null, basis: BASIS.UNAVAILABLE, postedActualReason: "x", appliedMinor: null, absorbedMinor: null },
    });
    const by = Object.fromEntries(b.families.map((f) => [f.key, f]));
    expect(by.financing.amountMinor).toBeNull();
    expect(by.financing.coverage).toBe("unavailable");
    expect(by.labour.amountMinor).toBeNull();
    /* The known total contains only what is known. */
    expect(b.knownTotalMinor).toBe(28875000 + 500000);
    expect(b.missingFamilies.map((f) => f.key)).toEqual(expect.arrayContaining(["financing", "labour", "freight"]));
  });

  test("recoverable GST is excluded and income tax is only a note", () => {
    const b = P.bridgeFrom({
      procurementReport: procurementReport(), materials: [], policy: null,
      labour: { totalMinor: null, basis: BASIS.UNAVAILABLE, postedActualReason: "x" },
    });
    expect(b.knownTotalMinor).not.toBe(28875000 + 500000 + 5197500);
    expect(b.recoverableTaxNote).toMatch(/not product cost/i);
    expect(b.incomeTaxNote).toMatch(/company taxable profit, not included in this product/i);
  });

  test("applied overhead is labelled applied, never a posted ledger figure", () => {
    const b = P.bridgeFrom({
      procurementReport: procurementReport(), materials: [], policy: { overheadMinor: 1200000 },
      labour: { totalMinor: null, basis: BASIS.UNAVAILABLE, postedActualReason: "x" },
    });
    const oh = b.families.find((f) => f.key === "overhead");
    expect(oh.amountMinor).toBe(1200000);
    expect(oh.basis).toBe("Applied overhead");
    expect(oh.note).toMatch(/not a posted ledger figure/i);
  });

  test("an unclosed run blocks the unit cost, and names the closeout as the gap", () => {
    const c = P.completenessOf({
      procurementReport: procurementReport(),
      output: P.outputFrom([workOrder()], []),
      materials: [], labour: { postedActualMinor: null },
      workOrders: { attributed: [workOrder()], unlinked: [], cancelled: [] },
    });
    expect(c.complete).toBe(false);
    expect(c.label).toBe("Known cost to date — incomplete");
    const keys = c.blockers.map((b) => b.key);
    expect(keys).toContain(BLOCKER.CLOSEOUT_INCOMPLETE);
    expect(keys).toContain(BLOCKER.LABOUR_SOURCE);
  });

  test("with production closed, the remaining gap is named as issue VALUE, not quantity", () => {
    const closed = P.outputFrom([workOrder()], [
      { workOrderId: "wo1", output: { acceptedGoodQty: 460, rejectedQty: 20, openReworkQty: 0 } },
    ]);
    const c = P.completenessOf({
      procurementReport: procurementReport(),
      output: closed,
      /* Quantity is known; value is not — which is exactly the state 8C
         leaves the system in. */
      materials: [{ blockers: [], consumedValueMinor: null }],
      labour: { postedActualMinor: null },
      workOrders: { attributed: [workOrder()], unlinked: [], cancelled: [] },
    });
    const keys = c.blockers.map((b) => b.key);
    expect(keys).not.toContain(BLOCKER.CLOSEOUT_INCOMPLETE);
    expect(keys).not.toContain(BLOCKER.NO_GOOD_OUTPUT);
    expect(keys).toContain(BLOCKER.ISSUE_VALUE);
    const message = c.blockers.find((b) => b.key === BLOCKER.ISSUE_VALUE).message;
    expect(message).toMatch(/Production quantities are closed, but historical issue value is not connected/i);
  });

  test("zero accepted output is valid evidence but never a denominator", () => {
    const closed = P.outputFrom([workOrder()], [
      { workOrderId: "wo1", output: { acceptedGoodQty: 0, rejectedQty: 480, openReworkQty: 0 } },
    ]);
    expect(closed.goodAccepted).toBe(0);
    const c = P.completenessOf({
      procurementReport: procurementReport(), output: closed,
      materials: [], labour: { postedActualMinor: null },
      workOrders: { attributed: [workOrder()], unlinked: [], cancelled: [] },
    });
    expect(c.blockers.map((b) => b.key)).toContain(BLOCKER.NO_GOOD_OUTPUT);
  });
});

/* ── 8 · MARGIN LANGUAGE ─────────────────────────────────────────────────── */

describe("margin", () => {
  test("it is margin at the approved price, never realised profit", () => {
    const m = P.marginFrom({ approvedPriceMinor: 30000, estimatedCostMinor: 20000, actualUnitCostMinor: null, goodOutput: null });
    expect(m.label).toBe("Margin at approved selling price");
    expect(m.estimatedMarginMinor).toBe(10000);
    /* No actual margin while there is no actual unit cost. */
    expect(m.actualMarginMinor).toBeNull();
    expect(m.totalMarginMinor).toBeNull();
    expect(m.caveat).toMatch(/not realised profit/i);
    const words = JSON.stringify(m);
    expect(words).not.toMatch(/cash in pocket|realised profit(?!\.)/i);
  });

  test("no income-tax percentage is ever subtracted from a product margin", () => {
    const m = P.marginFrom({ approvedPriceMinor: 30000, estimatedCostMinor: 20000, actualUnitCostMinor: 21000, goodOutput: 480 });
    /* ₹300 − ₹210 = ₹90, with nothing taken off for tax. */
    expect(m.actualMarginMinor).toBe(9000);
    expect(m.marginVarianceMinor).toBe(9000 - 10000);
    expect(m.totalMarginMinor).toBe(9000 * 480);
    expect(m.incomeTaxNote).toMatch(/not included in this product's manufacturing cost/i);
  });
});

/* ── 9 · THE RECONCILIATION IDENTITY ─────────────────────────────────────── */

describe("variance reconciles exactly", () => {
  test("explained plus unexplained equals the total, on a worked example", () => {
    /* Estimated ₹2,88,750. Known ₹3,38,750 — ₹2,88,750 posted purchase,
       ₹5,000 landed. Procurement explains ₹24,750 quantity + ₹5,700 rate;
       conversion adds ₹19,550. */
    const procurementReport = {
      summary: { complete: true, postedActualMinor: 28875000, landedPostedMinor: 500000, recoverableTaxMinor: 0, estimatedProcurementMinor: 28875000 },
      requirements: [{
        kind: "PHYSICAL", actual: { postedActualMinor: 28875000 },
        variance: { causes: [
          { cause: "QUANTITY", label: "Purchase quantity variance", amountMinor: 2475000 },
          { cause: "RATE", label: "Supplier price variance", amountMinor: 570000 },
        ] },
      }],
    };
    const bridge = P.bridgeFrom({
      procurementReport, materials: [], policy: null,
      labour: { totalMinor: 1955000, basis: BASIS.ABSORBED, postedActualReason: "x", appliedMinor: null, absorbedMinor: 1955000 },
    });
    const v = P.varianceFrom({ procurementReport, bridge, estimatedTotalMinor: 28875000 });

    /* ₹2,88,750 + ₹5,000 + ₹19,550 = ₹3,13,300 known. */
    expect(bridge.knownTotalMinor).toBe(28875000 + 500000 + 1955000);
    expect(v.totalMinor).toBe(bridge.knownTotalMinor - 28875000);
    /* THE IDENTITY, exactly — not approximately. */
    expect(v.explainedMinor + v.unexplainedMinor).toBe(v.totalMinor);
    expect(v.identity).toBe("explained + unexplained = total");
  });

  test("what the causes cannot account for is stated, never widened into a cause", () => {
    const procurementReport = {
      summary: { complete: true, postedActualMinor: 28875000, landedPostedMinor: 0, recoverableTaxMinor: 0 },
      requirements: [{ kind: "PHYSICAL", actual: { postedActualMinor: 28875000 }, variance: { causes: [] } }],
    };
    const bridge = P.bridgeFrom({
      procurementReport, materials: [], policy: null,
      labour: { totalMinor: null, basis: BASIS.UNAVAILABLE, postedActualReason: "x" },
    });
    const v = P.varianceFrom({ procurementReport, bridge, estimatedTotalMinor: 20000000 });
    expect(v.causes).toHaveLength(0);
    expect(v.unexplainedMinor).toBe(28875000 - 20000000);
    expect(v.reconciles).toBe(false);
    expect(v.explainedMinor + v.unexplainedMinor).toBe(v.totalMinor);
  });
});

/* ── 1 · THE AUDIT IS WRITTEN DOWN, NOT ASSUMED ──────────────────────────── */

test("every basis label distinguishes measured, posted, applied and absent", () => {
  expect(BASIS.MEASURED).toBe("Measured actual");
  expect(BASIS.POSTED).toBe("Posted accounting actual");
  expect(BASIS.APPLIED).toBe("Applied conversion cost");
  expect(BASIS.ABSORBED).toBe("Absorbed at approved rate");
  expect(BASIS.POLICY).toBe("Applied overhead");
  expect(BASIS.NET_ISSUED).toBe("Net issued to production");
  expect(BASIS.UNAVAILABLE).toBe("Actual source not connected");
  /* None of them says "paid" or "actual payroll". */
  const all = Object.values(BASIS).join(" ");
  expect(all).not.toMatch(/paid labour|actual payroll/i);
});
