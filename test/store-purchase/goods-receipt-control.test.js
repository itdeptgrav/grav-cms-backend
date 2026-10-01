// test/store-purchase/goods-receipt-control.test.js
//
// GOODS RECEIPT CONTROL (V1) — the pure derivation. Inspection reconciliation
// per line (never across units), stage/flag/count derivation, remaining-to-
// put-away, and honest blockers — all without a database.
"use strict";

const { deriveControl, validateInspection, allocateRejectedSources, STAGE } = require("../../services/storePurchase/goodsReceiptControl.service");

const grn = (lines) => ({ _id: "gr1", receiptNumber: "GRN/1", lines });
const line = (id, qty, unit = "pcs", over = {}) => ({
  _id: id, receivedQuantity: qty, poUnit: unit, baseUnit: unit, conversionFactor: 1,
  rawItemId: `raw-${id}`, poItemId: `po-${id}`, itemName: `Item ${id}`, sku: `SKU-${id}`, variantCombination: [], ...over,
});
const insp = (lines) => ({ _id: "insp1", lines });

/* ── Inspection reconciliation ─────────────────────────────────────────────── */

test("1 · each line's accepted + quarantined + rejected must equal its received quantity", () => {
  const g = grn([line("L1", 10)]);
  const ok = validateInspection({ goodsReceipt: g, lines: [{ goodsReceiptLineId: "L1", acceptedQuantity: 6, quarantinedQuantity: 3, rejectedQuantity: 1 }] });
  expect(ok.plans[0].accepted).toBe(6);
  expect(ok.plans[0].quarantined).toBe(3);
  expect(ok.plans[0].rejected).toBe(1);
  // A sum that does not reconcile refuses.
  expect(() => validateInspection({ goodsReceipt: g, lines: [{ goodsReceiptLineId: "L1", acceptedQuantity: 6, quarantinedQuantity: 3, rejectedQuantity: 2 }] }))
    .toThrow(/must equal the received quantity/i);
});

test("2 · negative quantities refuse; a missing line refuses", () => {
  const g = grn([line("L1", 10)]);
  expect(() => validateInspection({ goodsReceipt: g, lines: [{ goodsReceiptLineId: "L1", acceptedQuantity: -1, quarantinedQuantity: 11, rejectedQuantity: 0 }] })).toThrow(/zero or more/i);
  expect(() => validateInspection({ goodsReceipt: grn([line("L1", 10), line("L2", 5)]), lines: [{ goodsReceiptLineId: "L1", acceptedQuantity: 10, quarantinedQuantity: 0, rejectedQuantity: 0 }] })).toThrow(/Every received line must be inspected/i);
});

test("3 · mixed units are never summed — each line reconciles in its OWN unit", () => {
  const g = grn([line("Lm", 100, "m"), line("Lkg", 10, "kg")]);
  // Correct: metres reconcile against metres, kilograms against kilograms.
  const ok = validateInspection({ goodsReceipt: g, lines: [
    { goodsReceiptLineId: "Lm", acceptedQuantity: 60, quarantinedQuantity: 40, rejectedQuantity: 0 },
    { goodsReceiptLineId: "Lkg", acceptedQuantity: 10, quarantinedQuantity: 0, rejectedQuantity: 0 },
  ] });
  expect(ok.plans).toHaveLength(2);
  expect(ok.plans[0].unit).toBe("m");
  expect(ok.plans[1].unit).toBe("kg");
  // A wrong sum on ONE line fails on that line alone (never a cross-unit total).
  expect(() => validateInspection({ goodsReceipt: g, lines: [
    { goodsReceiptLineId: "Lm", acceptedQuantity: 60, quarantinedQuantity: 30, rejectedQuantity: 0 }, // 90 ≠ 100
    { goodsReceiptLineId: "Lkg", acceptedQuantity: 10, quarantinedQuantity: 0, rejectedQuantity: 0 },
  ] })).toThrow(/Item Lm/);
});

test("4 · a non-unit conversion factor is carried onto the plan for the base-unit move", () => {
  const g = grn([line("Lb", 2, "box", { baseUnit: "pcs", conversionFactor: 12 })]);
  const ok = validateInspection({ goodsReceipt: g, lines: [{ goodsReceiptLineId: "Lb", acceptedQuantity: 1, quarantinedQuantity: 1, rejectedQuantity: 0 }] });
  expect(ok.plans[0].quarantinedBase).toBe(12);   // 1 box * 12
  expect(ok.plans[0].baseUnit).toBe("pcs");
});

/* ── Stage / flag / count derivation ───────────────────────────────────────── */

test("5 · before inspection the stage is 'awaiting inspection' and all received sits in Receiving", () => {
  const c = deriveControl(grn([line("L1", 10)]), null, [], { receivingLocationActive: true });
  expect(c.stage).toBe(STAGE.AWAITING_INSPECTION);
  expect(c.flags.awaitingInspection).toBe(true);
  expect(c.lines[0].stillInReceiving).toBe(10);
  expect(c.actions.canInspect).toBe(true);
});

test("6 · mixed accepted/quarantined/rejected: quarantine-decision headlines, flags stay independent", () => {
  const g = grn([line("L1", 10)]);
  const i = insp([{ goodsReceiptLineId: "L1", acceptedQuantity: 6, quarantinedQuantity: 3, rejectedQuantity: 1 }]);
  const c = deriveControl(g, i, [], { receivingLocationActive: true, usableAvailable: true, returnsAvailable: true });
  // Unresolved quarantine is the most urgent open decision → the headline stage.
  expect(c.stage).toBe(STAGE.QUARANTINE_DECISION);
  // …but the independent flags still show it awaits put-away AND a supplier return.
  expect(c.flags.awaitingPutaway).toBe(true);
  expect(c.flags.hasQuarantined).toBe(true);         // unresolved quarantine remains
  expect(c.flags.hasRejected).toBe(true);            // rejected awaits supplier return
  expect(c.flags.complete).toBe(false);              // never complete with exceptions open
  expect(c.lines[0].remainingToPutAway).toBe(6);
  expect(c.lines[0].unresolvedQuarantine).toBe(3);
  expect(c.lines[0].rejectedAwaitingReturn).toBe(1);
  expect(c.actions.canPutaway).toBe(true);
  expect(c.actions.canDisposition).toBe(true);
  expect(c.actions.canSupplierReturn).toBe(true);
});

test("7 · a clean accepted-only line: partial put-away leaves the remainder; full completes", () => {
  const g = grn([line("L1", 10)]);
  const i = insp([{ goodsReceiptLineId: "L1", acceptedQuantity: 10, quarantinedQuantity: 0, rejectedQuantity: 0 }]);
  const partial = deriveControl(g, i, [{ goodsReceiptLineId: "L1", quantity: 5 }], { receivingLocationActive: true, usableAvailable: true });
  expect(partial.lines[0].putAway).toBe(5);
  expect(partial.lines[0].remainingToPutAway).toBe(5);
  expect(partial.stage).toBe(STAGE.AWAITING_PUTAWAY);
  const full = deriveControl(g, i, [{ goodsReceiptLineId: "L1", quantity: 5 }, { goodsReceiptLineId: "L1", quantity: 5 }], { receivingLocationActive: true });
  expect(full.lines[0].remainingToPutAway).toBe(0);
  expect(full.flags.complete).toBe(true);
  expect(full.stage).toBe(STAGE.COMPLETE);
});

test("7b · unresolved quarantine keeps a fully-put-away receipt OUT of 'complete'", () => {
  const g = grn([line("L1", 10)]);
  const i = insp([{ goodsReceiptLineId: "L1", acceptedQuantity: 8, quarantinedQuantity: 2, rejectedQuantity: 0 }]);
  // Accepted 8 fully put away, but 2 remain quarantined with no disposition yet.
  const c = deriveControl(g, i, [{ goodsReceiptLineId: "L1", quantity: 8 }], { receivingLocationActive: true, returnsAvailable: true });
  expect(c.flags.awaitingPutaway).toBe(false);       // accepted done
  expect(c.flags.complete).toBe(false);              // but quarantine unresolved
  expect(c.stage).toBe(STAGE.QUARANTINE_DECISION);
  expect(c.lines[0].unresolvedQuarantine).toBe(2);
});

test("7c · put-away readiness is a boolean + per-unit grouping — NEVER a cross-unit total", () => {
  const g = grn([line("Lm", 100, "m"), line("Lkg", 10, "kg")]);
  const i = insp([
    { goodsReceiptLineId: "Lm", acceptedQuantity: 100, quarantinedQuantity: 0, rejectedQuantity: 0 },
    { goodsReceiptLineId: "Lkg", acceptedQuantity: 10, quarantinedQuantity: 0, rejectedQuantity: 0 },
  ]);
  const c = deriveControl(g, i, [], { receivingLocationActive: true, usableAvailable: true });
  expect(c.hasRemainingToPutAway).toBe(true);
  expect("totalRemainingToPutAway" in c).toBe(false);            // the aggregate is GONE
  expect(c.remainingToPutAwayByUnit).toEqual({ m: 100, kg: 10 }); // grouped per unit
  expect(JSON.stringify(c.remainingToPutAwayByUnit)).not.toMatch(/110/); // never 100+10
});

test("8 · an all-rejected receipt awaits a supplier return; an all-quarantined one awaits a decision", () => {
  const g = grn([line("L1", 10)]);
  const rej = deriveControl(g, insp([{ goodsReceiptLineId: "L1", acceptedQuantity: 0, quarantinedQuantity: 0, rejectedQuantity: 10 }]), [], {});
  expect(rej.stage).toBe(STAGE.SUPPLIER_RETURN);
  expect(rej.lines[0].rejectedAwaitingReturn).toBe(10);
  const quar = deriveControl(g, insp([{ goodsReceiptLineId: "L1", acceptedQuantity: 0, quarantinedQuantity: 10, rejectedQuantity: 0 }]), [], {});
  expect(quar.stage).toBe(STAGE.QUARANTINE_DECISION);
  expect(quar.lines[0].unresolvedQuarantine).toBe(10);
});

test("9 · a receipt with no active Receiving location is blocked from inspection, honestly", () => {
  const c = deriveControl(grn([line("L1", 10)]), null, [], { receivingLocationActive: false });
  expect(c.actions.canInspect).toBe(false);
  expect(c.blockers.some((b) => b.code === "NO_RECEIVING_LOCATION")).toBe(true);
});

test("10 · register counts are per-line, never a cross-unit total", () => {
  const g = grn([line("Lm", 100, "m"), line("Lkg", 10, "kg")]);
  const i = insp([
    { goodsReceiptLineId: "Lm", acceptedQuantity: 100, quarantinedQuantity: 0, rejectedQuantity: 0 },
    { goodsReceiptLineId: "Lkg", acceptedQuantity: 5, quarantinedQuantity: 5, rejectedQuantity: 0 },
  ]);
  const c = deriveControl(g, i, [], {});
  expect(c.counts.linesNeedingPutaway).toBe(2);              // both have accepted awaiting
  expect(c.counts.linesNeedingQuarantineDecision).toBe(1);  // only the kg line
  // No summed quantity across m and kg anywhere in the derived object.
  expect(JSON.stringify(c.counts)).not.toMatch(/105|110/);
});

/* ── Exception resolution: dispositions + supplier returns (derivation) ─────── */

const disp = (lineId, type, qty) => ({ goodsReceiptLineId: lineId, dispositionType: type, quantity: qty });
const sret = (lineId, qty, receipts = []) => ({ goodsReceiptLineId: lineId, damagedQuantity: qty, receipts });

test("11 · releasing quarantine adds put-away capacity WITHOUT editing the inspection", () => {
  const g = grn([line("L1", 10)]);
  const i = insp([{ goodsReceiptLineId: "L1", acceptedQuantity: 6, quarantinedQuantity: 4, rejectedQuantity: 0 }]);
  // Release 3 of the 4 quarantined → accepted capacity becomes 6 + 3 = 9.
  const c = deriveControl(g, i, [], { receivingLocationActive: true, usableAvailable: true, returnsAvailable: true }, { dispositions: [disp("L1", "RELEASE", 3)] });
  expect(c.lines[0].accepted).toBe(6);               // original inspection figure, unchanged
  expect(c.lines[0].quarantineReleased).toBe(3);
  expect(c.lines[0].acceptedCapacity).toBe(9);       // derived, not stored on the inspection
  expect(c.lines[0].remainingToPutAway).toBe(9);
  expect(c.lines[0].unresolvedQuarantine).toBe(1);   // 4 − 3
  expect(c.stage).toBe(STAGE.QUARANTINE_DECISION);   // 1 still to decide
});

test("12 · rejecting quarantine adds to the returnable pool; a supplier return reduces it", () => {
  const g = grn([line("L1", 10)]);
  const i = insp([{ goodsReceiptLineId: "L1", acceptedQuantity: 2, quarantinedQuantity: 5, rejectedQuantity: 3 }]);
  // Reject all 5 quarantined → rejected pool 3 + 5 = 8. Return 6 to the supplier.
  const c = deriveControl(g, i, [{ goodsReceiptLineId: "L1", quantity: 2 }],
    { receivingLocationActive: true, returnsAvailable: true },
    { dispositions: [disp("L1", "REJECT", 5)], supplierReturns: [sret("L1", 6)] });
  expect(c.lines[0].unresolvedQuarantine).toBe(0);
  expect(c.lines[0].rejectedTotal).toBe(8);
  expect(c.lines[0].returnedToSupplier).toBe(6);
  expect(c.lines[0].rejectedAwaitingReturn).toBe(2); // 8 − 6
  expect(c.stage).toBe(STAGE.SUPPLIER_RETURN);        // quarantine done, 2 still to return
});

test("13 · complete only once quarantine resolved, all rejected returned, and accepted put away", () => {
  const g = grn([line("L1", 10)]);
  const i = insp([{ goodsReceiptLineId: "L1", acceptedQuantity: 6, quarantinedQuantity: 2, rejectedQuantity: 2 }]);
  // Release 2 quarantined → capacity 8; put away 8; return the 2 rejected.
  const c = deriveControl(g, i, [{ goodsReceiptLineId: "L1", quantity: 8 }],
    { receivingLocationActive: true },
    { dispositions: [disp("L1", "RELEASE", 2)], supplierReturns: [sret("L1", 2, [{ quantityReceived: 2 }])] });
  expect(c.lines[0].unresolvedQuarantine).toBe(0);
  expect(c.lines[0].rejectedAwaitingReturn).toBe(0);
  expect(c.lines[0].remainingToPutAway).toBe(0);
  expect(c.lines[0].replacementReceived).toBe(2);    // proven by the receipt
  expect(c.flags.complete).toBe(true);
  expect(c.stage).toBe(STAGE.COMPLETE);
});

test("14 · reconciliation figures are per line and never summed across units", () => {
  const g = grn([line("Lm", 100, "m"), line("Lkg", 10, "kg")]);
  const i = insp([
    { goodsReceiptLineId: "Lm", acceptedQuantity: 0, quarantinedQuantity: 100, rejectedQuantity: 0 },
    { goodsReceiptLineId: "Lkg", acceptedQuantity: 0, quarantinedQuantity: 0, rejectedQuantity: 10 },
  ]);
  const c = deriveControl(g, i, [], { receivingLocationActive: true, returnsAvailable: true },
    { dispositions: [disp("Lm", "REJECT", 100)], supplierReturns: [sret("Lm", 40)] });
  // Metres line: 100 rejected out of quarantine, 40 returned → 60 awaiting.
  expect(c.lines[0].rejectedAwaitingReturn).toBe(60);
  // Kg line untouched: 10 awaiting.
  expect(c.lines[1].rejectedAwaitingReturn).toBe(10);
  // No 110 / 70 cross-unit total anywhere.
  expect(JSON.stringify(c.lines)).not.toMatch(/"[^"]*":\s*110\b/);
  expect(c.counts.linesAwaitingSupplierReturn).toBe(2);
});

/* ── Rejected-source allocation (pure, deterministic, base-carrying) ─────────── */

const src = (type, id, qty) => ({ sourceType: type, sourceId: id, quantity: qty });
const INS = "INSPECTION_REJECTION", DISP = "QUARANTINE_DISPOSITION";

test("15 · a return wholly from the initial inspection rejection allocates to it alone", () => {
  const a = allocateRejectedSources({ rBefore: 0, quantity: 3, sources: [src(INS, "i1", 3)], factor: 10, unit: "ctn", baseUnit: "pc" });
  expect(a).toEqual([{ sourceType: INS, sourceId: "i1", quantity: 3, unit: "ctn", baseQuantity: 30, baseUnit: "pc" }]);
});

test("16 · a return wholly from one reject disposition allocates to that disposition", () => {
  // Inspection rejected 0; the whole pool is one disposition of 3.
  const a = allocateRejectedSources({ rBefore: 0, quantity: 3, sources: [src(DISP, "d1", 3)], factor: 10, unit: "ctn", baseUnit: "pc" });
  expect(a).toEqual([{ sourceType: DISP, sourceId: "d1", quantity: 3, unit: "ctn", baseQuantity: 30, baseUnit: "pc" }]);
});

test("17 · one return spanning inspection + multiple dispositions splits exactly, cumulative == quantity", () => {
  const sources = [src(INS, "i1", 2), src(DISP, "d1", 2), src(DISP, "d2", 2)]; // pool 6
  const a = allocateRejectedSources({ rBefore: 0, quantity: 5, sources, factor: 10, unit: "ctn", baseUnit: "pc" });
  expect(a.map((x) => [x.sourceType, x.sourceId, x.quantity, x.baseQuantity])).toEqual([[INS, "i1", 2, 20], [DISP, "d1", 2, 20], [DISP, "d2", 1, 10]]);
  expect(a.reduce((s, x) => s + x.quantity, 0)).toBe(5);   // cumulative business exactly 5
  expect(a.reduce((s, x) => s + x.baseQuantity, 0)).toBe(50);
});

test("18 · a second, partial return consumes only the UN-consumed remainder (no double-allocation)", () => {
  const sources = [src(INS, "i1", 2), src(DISP, "d1", 2), src(DISP, "d2", 2)];
  // First return already took [0,3): all of i1 + 1 of d1.
  const a = allocateRejectedSources({ rBefore: 3, quantity: 3, sources, factor: 1, unit: "pc", baseUnit: "pc" });
  expect(a.map((x) => [x.sourceType, x.sourceId, x.quantity])).toEqual([[DISP, "d1", 1], [DISP, "d2", 2]]);
});
