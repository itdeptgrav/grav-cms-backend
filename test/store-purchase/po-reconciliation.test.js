// test/store-purchase/po-reconciliation.test.js
//
// PURCHASE THREE-WAY MATCH — the pure order / ACCEPTED-receipt / bill comparison.
// Driven with in-memory lean documents (no DB): every join is by a stored id, the
// quantity match uses the immutable inspection ACCEPTED quantity (never the mere
// received quantity), and the statuses, variances and subtotals are asserted
// directly.
"use strict";

const { buildReconciliation, STATUS } = require("../../services/storePurchase/poReconciliation.service");

// A base scenario: one PO line, fully linked, received 10 via a GRN, inspected
// (accepted 10), billed 10 and posted — i.e. a genuine three-way match.
const base = () => ({
  purchaseOrder: {
    _id: "po1", poNumber: "PO/1", status: "ISSUED", vendorName: "Acme",
    spendRequestId: "sr1", spendRequestNumber: "SR-1",
    subtotal: 1000, taxAmount: 180, totalAmount: 1180,
    items: [{
      _id: "li1", spendLineId: "sl1", rawItem: "raw1", itemName: "Bolt", sku: "B1",
      unit: "pcs", quantity: 10, unitPrice: 100, totalPrice: 1000, gstRate: 18, gstAmount: 180,
      itemChargesTotal: 0, receivedQuantity: 10, pendingQuantity: 0,
    }],
    deliveries: [],
  },
  spendRequest: { _id: "sr1", requestNumber: "SR-1", items: [{ _id: "sl1", amount: 1000, name: "Bolt" }] },
  commitment: {
    _id: "c1", amount: 1000, status: "released",
    allocations: [{ spendLineId: "sl1", amount: 1000, releasedAmount: 1000, remainingAmount: 0, status: "released", ledgerId: "led1", ledgerName: "Repairs" }],
  },
  vouchers: [{
    _id: "v1", voucherNumber: "PV-1", status: "posted", referenceNumber: "INV-9", grandTotal: 1180,
    inventoryEntries: [{ poItemId: "li1", spendLineId: "sl1", unit: "pcs", quantity: 10, rate: 100, amount: 1000, taxAmount: 180 }],
  }],
  goodsReceipts: [{ _id: "grn1", receiptNumber: "GRN/1", status: "RECORDED", lines: [{ _id: "grl1", poItemId: "li1", poUnit: "pcs", receivedQuantity: 10 }] }],
  inspections: [{ _id: "insp1", goodsReceiptId: "grn1", lines: [{ goodsReceiptLineId: "grl1", poItemId: "li1", unit: "pcs", receivedQuantity: 10, acceptedQuantity: 10, quarantinedQuantity: 0, rejectedQuantity: 0 }] }],
  dispositions: [],
});

// Set the GRN received + inspection split for li1 together (in the line's own unit).
function setReceipt(s, { received, accepted = received, quarantined = 0, rejected = 0, inspect = true, grnUnit = "pcs", inspectUnit = "pcs" }) {
  s.goodsReceipts = [{ _id: "grn1", receiptNumber: "GRN/1", status: "RECORDED", lines: [{ _id: "grl1", poItemId: "li1", poUnit: grnUnit, receivedQuantity: received }] }];
  s.inspections = inspect
    ? [{ _id: "insp1", goodsReceiptId: "grn1", lines: [{ goodsReceiptLineId: "grl1", poItemId: "li1", unit: inspectUnit, receivedQuantity: accepted + quarantined + rejected, acceptedQuantity: accepted, quarantinedQuantity: quarantined, rejectedQuantity: rejected }] }]
    : [];
  s.purchaseOrder.items[0].receivedQuantity = received;
  s.purchaseOrder.items[0].pendingQuantity = Math.max(0, s.purchaseOrder.items[0].quantity - received);
  return s;
}

test("1 · a fully linked request→commitment→PO→GRN→inspection(accepted)→posted bill is Three-way matched", () => {
  const r = buildReconciliation(base());
  const l = r.lines[0];
  expect(l.requestNumber).toBe("SR-1");
  expect(l.budgetHead.ledgerName).toBe("Repairs");
  expect(l.receivedQty).toBe(10);
  expect(l.acceptedQty).toBe(10);
  expect(l.billed.total).toBe(1180);
  expect(l.billed.posted).toBe(1180);
  expect(l.threeWayMatched).toBe(true);
  expect(l.statuses).toContain(STATUS.THREE_WAY_MATCHED);
  expect(r.summary.threeWayMatchedCount).toBe(1);
  expect(r.summary.budgetActual).toBe(1180);
  expect(r.exceptions).toHaveLength(0);
});

test("REQ8a · received 10, accepted 8, billed 8 → the quantity match passes (Three-way matched)", () => {
  const s = base();
  setReceipt(s, { received: 10, accepted: 8, quarantined: 0, rejected: 2 });
  s.vouchers[0].inventoryEntries[0] = { poItemId: "li1", spendLineId: "sl1", unit: "pcs", quantity: 8, rate: 100, amount: 800, taxAmount: 144 };
  const r = buildReconciliation(s);
  const l = r.lines[0];
  expect(l.acceptedQty).toBe(8);
  expect(l.billed.qty).toBe(8);
  expect(l.uninspectedQty).toBe(0);           // 10 received, all inspected
  expect(l.threeWayMatched).toBe(true);       // billed 8 == accepted 8
  expect(l.statuses).toContain(STATUS.REJECTED_RECORDED);   // the 2 rejected still shown
});

test("REQ8b · received 10, accepted 8, billed 10 → Billed above accepted quantity", () => {
  const s = base();
  setReceipt(s, { received: 10, accepted: 8, rejected: 2 });
  s.vouchers[0].inventoryEntries[0] = { poItemId: "li1", spendLineId: "sl1", unit: "pcs", quantity: 10, rate: 100, amount: 1000, taxAmount: 180 };
  const r = buildReconciliation(s);
  const l = r.lines[0];
  expect(l.threeWayMatched).toBe(false);
  expect(l.statuses).toContain(STATUS.BILLED_ABOVE_ACCEPTED);
  expect(r.exceptions.some((e) => e.code === "BILLED_ABOVE_ACCEPTED")).toBe(true);
});

test("REQ8c · received but NOT inspected → Received, awaiting inspection (never accepted zero)", () => {
  const s = base();
  setReceipt(s, { received: 10, inspect: false });    // GRN exists, no inspection
  s.vouchers = [];
  const r = buildReconciliation(s);
  const l = r.lines[0];
  expect(l.receivedQty).toBe(10);
  expect(l.hasInspection).toBe(false);
  expect(l.acceptedQty).toBe(0);
  expect(l.uninspectedQty).toBe(10);
  expect(l.statuses).toContain(STATUS.RECEIVED_AWAITING_INSPECTION);
  expect(l.statuses).not.toContain(STATUS.ACCEPTED_AWAITING_BILL);   // NOT "accepted zero"
  expect(l.threeWayMatched).toBe(false);
  expect(r.exceptions.some((e) => e.code === "AWAITING_INSPECTION")).toBe(true);
});

test("REQ8d · accepted / quarantined / rejected are kept separate", () => {
  const s = base();
  setReceipt(s, { received: 10, accepted: 6, quarantined: 3, rejected: 1 });
  s.vouchers = [];
  const r = buildReconciliation(s);
  const l = r.lines[0];
  expect(l.acceptedQty).toBe(6);
  expect(l.quarantinedQty).toBe(3);
  expect(l.rejectedQty).toBe(1);
  expect(l.uninspectedQty).toBe(0);
  expect(l.statuses).toContain(STATUS.PARTLY_ACCEPTED);
  expect(l.statuses).toContain(STATUS.QUARANTINE_UNRESOLVED);   // 3 quarantined, no disposition
  expect(l.statuses).toContain(STATUS.REJECTED_RECORDED);
  expect(l.statuses).toContain(STATUS.ACCEPTED_AWAITING_BILL);  // 6 accepted, not billed
});

test("REQ8e · two GRNs and two inspections aggregate by stored poItemId", () => {
  const s = base();
  s.goodsReceipts = [
    { _id: "grnA", receiptNumber: "GRN/A", status: "RECORDED", lines: [{ _id: "glA", poItemId: "li1", poUnit: "pcs", receivedQuantity: 4 }] },
    { _id: "grnB", receiptNumber: "GRN/B", status: "RECORDED", lines: [{ _id: "glB", poItemId: "li1", poUnit: "pcs", receivedQuantity: 6 }] },
  ];
  s.inspections = [
    { _id: "iA", goodsReceiptId: "grnA", lines: [{ goodsReceiptLineId: "glA", poItemId: "li1", unit: "pcs", receivedQuantity: 4, acceptedQuantity: 4, quarantinedQuantity: 0, rejectedQuantity: 0 }] },
    { _id: "iB", goodsReceiptId: "grnB", lines: [{ goodsReceiptLineId: "glB", poItemId: "li1", unit: "pcs", receivedQuantity: 6, acceptedQuantity: 5, quarantinedQuantity: 0, rejectedQuantity: 1 }] },
  ];
  const r = buildReconciliation(s);
  const l = r.lines[0];
  expect(l.receivedQty).toBe(10);   // 4 + 6
  expect(l.acceptedQty).toBe(9);    // 4 + 5
  expect(l.rejectedQty).toBe(1);
  expect(l.grnNumbers.sort()).toEqual(["GRN/A", "GRN/B"]);
});

test("REQ8f · a VOID GoodsReceipt's inspection is ignored (foreign/stale evidence never counted)", () => {
  const s = base();
  s.goodsReceipts[0].status = "VOID";
  s.purchaseOrder.items[0].receivedQuantity = 0;   // the void receipt left no stored aggregate
  s.purchaseOrder.items[0].pendingQuantity = 10;
  const r = buildReconciliation(s);
  const l = r.lines[0];
  expect(l.receivedQty).toBe(0);     // the void GRN provides no live received evidence
  expect(l.acceptedQty).toBe(0);     // its inspection is ignored too
  expect(l.statuses).toContain(STATUS.AWAITING_RECEIPT);
});

test("REQ8g · incompatible units refuse the quantity comparison ('Unit comparison unavailable')", () => {
  const s = base();
  // GRN received in 'box' while the PO line and inspection are in 'pcs'.
  setReceipt(s, { received: 10, accepted: 10, grnUnit: "box", inspectUnit: "pcs" });
  const r = buildReconciliation(s);
  const l = r.lines[0];
  expect(l.unitComparable).toBe(false);
  expect(l.statuses).toContain(STATUS.UNIT_COMPARISON_UNAVAILABLE);
  expect(l.threeWayMatched).toBe(false);           // never matched on unlike units
  expect(l.variances.acceptedVsBilledQty).toBeNull();   // no quantity variance computed
});

test("REQ8h · a released quarantine disposition clears the unresolved-quarantine flag", () => {
  const s = base();
  setReceipt(s, { received: 10, accepted: 8, quarantined: 2 });
  s.dispositions = [{ goodsReceiptId: "grn1", poItemId: "li1", dispositionType: "REJECT", quantity: 2 }];
  s.vouchers[0].inventoryEntries[0] = { poItemId: "li1", spendLineId: "sl1", unit: "pcs", quantity: 8, rate: 100, amount: 800, taxAmount: 144 };
  const r = buildReconciliation(s);
  const l = r.lines[0];
  expect(l.quarantinedQty).toBe(2);
  expect(l.resolvedQuarantine).toBe(2);
  expect(l.unresolvedQuarantine).toBe(0);
  expect(l.statuses).not.toContain(STATUS.QUARANTINE_UNRESOLVED);
  expect(l.threeWayMatched).toBe(true);   // 8 accepted, 8 billed, quarantine resolved, posted
});

test("2 · multiple PO lines map to their OWN commitment allocations by spendLineId", () => {
  const s = base();
  s.purchaseOrder.items.push({ _id: "li2", spendLineId: "sl2", itemName: "Nut", sku: "N1", unit: "pcs", quantity: 5, unitPrice: 40, totalPrice: 200, gstRate: 18, gstAmount: 36, receivedQuantity: 5, pendingQuantity: 0 });
  s.spendRequest.items.push({ _id: "sl2", amount: 200, name: "Nut" });
  s.commitment.allocations.push({ spendLineId: "sl2", amount: 200, releasedAmount: 0, remainingAmount: 200, status: "committed", ledgerId: "led2", ledgerName: "Consumables" });
  const r = buildReconciliation(s);
  expect(r.lines[0].budgetHead.ledgerName).toBe("Repairs");
  expect(r.lines[1].budgetHead.ledgerName).toBe("Consumables");
  expect(r.lines[1].committedAmount).toBe(200);
  expect(r.source.heads.map((h) => h.ledgerName).sort()).toEqual(["Consumables", "Repairs"]);
});

test("3 · two PO lines for the SAME RawItem are distinguished by poItemId, not the item", () => {
  const s = base();
  s.purchaseOrder.items = [
    { _id: "liA", spendLineId: "slA", rawItem: "rawSAME", itemName: "Fabric", sku: "F1", unit: "m", quantity: 100, unitPrice: 50, totalPrice: 5000, gstRate: 5, gstAmount: 250, receivedQuantity: 100, pendingQuantity: 0 },
    { _id: "liB", spendLineId: "slB", rawItem: "rawSAME", itemName: "Fabric", sku: "F1", unit: "m", quantity: 40, unitPrice: 55, totalPrice: 2200, gstRate: 5, gstAmount: 110, receivedQuantity: 40, pendingQuantity: 0 },
  ];
  s.spendRequest.items = [{ _id: "slA", amount: 5000 }, { _id: "slB", amount: 2200 }];
  s.commitment.allocations = [
    { spendLineId: "slA", amount: 5000, releasedAmount: 0, remainingAmount: 5000, status: "committed", ledgerId: "led1", ledgerName: "Repairs" },
    { spendLineId: "slB", amount: 2200, releasedAmount: 0, remainingAmount: 2200, status: "committed", ledgerId: "led1", ledgerName: "Repairs" },
  ];
  s.goodsReceipts = []; s.inspections = [];
  s.vouchers = [{ _id: "v1", voucherNumber: "PV-1", status: "posted", inventoryEntries: [
    { poItemId: "liB", spendLineId: "slB", quantity: 40, rate: 55, amount: 2200, taxAmount: 110 },
  ] }];
  const r = buildReconciliation(s);
  expect(r.lines[0].billed.qty).toBe(0);   // liA not billed
  expect(r.lines[1].billed.qty).toBe(40);  // liB billed — matched by poItemId
});

test("4 · a partial receipt reads Partly received with the pending quantity", () => {
  const s = base();
  setReceipt(s, { received: 6, accepted: 6 });
  s.vouchers = [];
  const r = buildReconciliation(s);
  expect(r.lines[0].statuses).toContain(STATUS.PARTLY_RECEIVED);
  expect(r.lines[0].pendingQty).toBe(4);
  expect(r.exceptions.some((e) => e.code === "QTY_DUE")).toBe(true);
});

test("5 · an over-receipt is flagged as over-received, not silently absorbed", () => {
  const s = base();
  setReceipt(s, { received: 12, accepted: 12 });
  s.vouchers = [];
  const r = buildReconciliation(s);
  expect(r.lines[0].overReceivedQty).toBe(2);
  expect(r.lines[0].statuses).toContain(STATUS.OVER_RECEIVED);
  expect(r.exceptions.some((e) => e.code === "OVER_RECEIPT")).toBe(true);
});

test("6 · partial billing against accepted is a Quantity variance", () => {
  const s = base();
  s.vouchers[0].inventoryEntries[0] = { poItemId: "li1", spendLineId: "sl1", unit: "pcs", quantity: 6, rate: 100, amount: 600, taxAmount: 108 };
  const r = buildReconciliation(s);
  expect(r.lines[0].billed.qty).toBe(6);
  expect(r.lines[0].acceptedQty).toBe(10);
  expect(r.lines[0].statuses).toContain(STATUS.QTY_VARIANCE);
  expect(r.lines[0].variances.acceptedVsBilledQty).toBe(4);
});

test("7 · a bill for more than was received is surfaced as an exception", () => {
  const s = base();
  setReceipt(s, { received: 8, accepted: 8 });
  s.vouchers[0].inventoryEntries[0] = { poItemId: "li1", spendLineId: "sl1", unit: "pcs", quantity: 10, rate: 100, amount: 1000, taxAmount: 180 };
  const r = buildReconciliation(s);
  expect(r.exceptions.some((e) => e.code === "BILLED_ABOVE_ACCEPTED")).toBe(true);
});

test("8 · a rate difference is a Rate variance, stated separately", () => {
  const s = base();
  s.vouchers[0].inventoryEntries[0].rate = 110;
  s.vouchers[0].inventoryEntries[0].amount = 1100; // billed rate 110 vs ordered 100
  s.vouchers[0].inventoryEntries[0].taxAmount = 198; // 18% of the new net → GST stays consistent
  const r = buildReconciliation(s);
  expect(r.lines[0].statuses).toContain(STATUS.RATE_VARIANCE);
  expect(r.lines[0].variances.rateDiff).toBe(10);
  expect(r.lines[0].statuses).not.toContain(STATUS.GST_VARIANCE); // not merged
});

test("9 · a GST difference is a GST variance, stated separately", () => {
  const s = base();
  s.vouchers[0].inventoryEntries[0].taxAmount = 200; // billed GST 200 vs ordered 180
  const r = buildReconciliation(s);
  expect(r.lines[0].statuses).toContain(STATUS.GST_VARIANCE);
  expect(r.lines[0].variances.gstDiff).toBe(20);
  expect(r.lines[0].statuses).not.toContain(STATUS.RATE_VARIANCE);
});

test("9b · a bill that adds GST to a GST-free line is a GST variance (not silently comparable-less)", () => {
  const s = base();
  s.purchaseOrder.items[0].gstRate = 0; s.purchaseOrder.items[0].gstAmount = 0;
  s.purchaseOrder.items[0].totalPrice = 1000; s.purchaseOrder.items[0].orderedTotal = 1000;
  s.vouchers[0].inventoryEntries[0] = { poItemId: "li1", spendLineId: "sl1", unit: "pcs", quantity: 10, rate: 100, amount: 1000, taxAmount: 50 };
  const r = buildReconciliation(s);
  expect(r.lines[0].variances.gstDiff).toBe(50);
  expect(r.lines[0].statuses).toContain(STATUS.GST_VARIANCE);
  expect(r.lines[0].threeWayMatched).toBe(false);
});

test("10 · a draft/pending voucher is in-progress, NOT posted actual, and does not match", () => {
  const s = base();
  s.vouchers[0].status = "pending_approval";
  const r = buildReconciliation(s);
  expect(r.lines[0].billed.total).toBe(1180);      // live billed
  expect(r.lines[0].billed.posted).toBe(0);        // not posted
  expect(r.lines[0].billed.inProgress).toBe(1180); // shown as in progress
  expect(r.lines[0].statuses).toContain(STATUS.BILL_AWAITING_POSTING);
  expect(r.lines[0].threeWayMatched).toBe(false);  // an unposted bill never matches
  expect(r.summary.budgetActual).toBe(0);          // actual is posted-only
});

test("11 · a cancelled voucher is excluded from live billed totals but kept as history", () => {
  const s = base();
  s.vouchers[0].status = "cancelled";
  const r = buildReconciliation(s);
  expect(r.lines[0].billed.qty).toBe(0);   // not live
  expect(r.lines[0].billed.total).toBe(0);
  expect(r.lines[0].billed.vouchers.some((v) => v.status === "cancelled" && !v.isLive)).toBe(true);
});

test("12 · a voucher line matching no PO line is surfaced as unlinked, never guessed", () => {
  const s = base();
  s.vouchers[0].inventoryEntries.push({ poItemId: "GHOST", quantity: 3, rate: 10, amount: 30, taxAmount: 5 });
  const r = buildReconciliation(s);
  expect(r.unlinkedVoucherLines.length).toBe(1);
  expect(r.unlinkedVoucherLines[0].poItemId).toBe("GHOST");
  expect(r.exceptions.some((e) => e.code === "UNLINKED_BILL")).toBe(true);
  expect(r.lines[0].billed.qty).toBe(10);
});

test("13 · a legacy PO with no SpendRequest reads honestly, not as a failure", () => {
  const s = base();
  s.purchaseOrder.spendRequestId = null;
  s.purchaseOrder.items[0].spendLineId = null;
  s.spendRequest = null;
  s.commitment = null;
  const r = buildReconciliation(s);
  expect(r.source.request).toBeNull();
  expect(r.lines[0].statuses).toContain(STATUS.LEGACY_EVIDENCE_INCOMPLETE);
  expect(r.lines[0].committedAmount).toBeNull();
  expect(r.exceptions.some((e) => e.code === "NO_REQUEST")).toBe(true);
});

test("14 · a receipt invoice reference with no linked voucher is surfaced", () => {
  const s = base();
  s.purchaseOrder.deliveries = [{ deliveryDate: new Date("2026-05-01"), quantityReceived: 10, invoiceNumber: "SUP-INV-77" }];
  s.vouchers = [];
  const r = buildReconciliation(s);
  expect(r.exceptions.some((e) => e.code === "RECEIPT_INVOICE_NO_VOUCHER")).toBe(true);
  expect(r.receipts[0].invoiceNumber).toBe("SUP-INV-77");
});

test("REQ8-budget · a posted MAPPED bill shows its released allocation; remaining commitment stands", () => {
  const s = base();
  s.commitment.status = "partially_released";
  s.commitment.allocations[0] = { spendLineId: "sl1", amount: 1000, releasedAmount: 600, remainingAmount: 400, status: "partially_released", ledgerId: "led1", ledgerName: "Repairs" };
  setReceipt(s, { received: 6, accepted: 6 });
  s.vouchers[0].inventoryEntries[0] = { poItemId: "li1", spendLineId: "sl1", unit: "pcs", quantity: 6, rate: 100, amount: 600, taxAmount: 108 };
  const r = buildReconciliation(s);
  expect(r.lines[0].releasedAmount).toBe(600);
  expect(r.lines[0].commitmentRemaining).toBe(400);
  expect(r.summary.commitmentRemaining).toBe(400);
});

test("REQ8-budget2 · a posted UNMAPPED bill leaves the commitment live with a visible exception", () => {
  const s = base();
  // A posted bill line whose PO line carries no allocation (no matching spendLineId).
  s.commitment.allocations = [];    // nothing maps
  const r = buildReconciliation(s);
  expect(r.lines[0].hasAllocation).toBe(false);
  expect(r.lines[0].commitmentRemaining).toBeNull();
  expect(r.exceptions.some((e) => e.code === "POSTED_UNMAPPED_ALLOCATION")).toBe(true);
});

test("REQ8-budget3 · a draft bill is not a posted actual and releases no budget", () => {
  const s = base();
  s.vouchers[0].status = "draft";
  s.commitment.allocations[0] = { spendLineId: "sl1", amount: 1000, releasedAmount: 0, remainingAmount: 1000, status: "committed", ledgerId: "led1", ledgerName: "Repairs" };
  const r = buildReconciliation(s);
  expect(r.summary.budgetActual).toBe(0);
  expect(r.lines[0].commitmentRemaining).toBe(1000);   // nothing released by a draft
  expect(r.exceptions.some((e) => e.code === "COMMITMENT_NOT_RELEASED")).toBe(false);
});

test("16 · every displayed subtotal reconciles to its contributing rows", () => {
  const s = base();
  s.purchaseOrder.items.push({ _id: "li2", spendLineId: "sl2", itemName: "Nut", unit: "pcs", quantity: 5, unitPrice: 40, totalPrice: 200, gstRate: 18, gstAmount: 36, receivedQuantity: 5, pendingQuantity: 0 });
  s.spendRequest.items.push({ _id: "sl2", amount: 200 });
  s.commitment.allocations.push({ spendLineId: "sl2", amount: 200, releasedAmount: 200, remainingAmount: 0, status: "released", ledgerId: "led1", ledgerName: "Repairs" });
  s.vouchers[0].inventoryEntries.push({ poItemId: "li2", spendLineId: "sl2", quantity: 5, rate: 40, amount: 200, taxAmount: 36 });
  const r = buildReconciliation(s);
  const sumOrdered = r.lines.reduce((t, l) => t + l.orderedTotal, 0);
  expect(r.summary.orderedTotal).toBe(Math.round(sumOrdered * 100) / 100);
  expect(r.summary.commitmentRemaining).toBe(0);
});

test("17 · unbudgeted allocation carries its status → Budget allocation unavailable", () => {
  const s = base();
  s.commitment.allocations[0] = { spendLineId: "sl1", amount: 1000, releasedAmount: 0, remainingAmount: 1000, status: "unbudgeted", resolutionReason: "No approved head for this department yet", name: "Bolt" };
  s.vouchers = [];
  const r = buildReconciliation(s);
  expect(r.lines[0].unbudgeted).toBe(true);
  expect(r.lines[0].unbudgetedReason).toMatch(/no approved head/i);
  expect(r.lines[0].statuses).toContain(STATUS.BUDGET_ALLOCATION_UNAVAILABLE);
});

test("18 · differences are never merged — rate AND GST both show", () => {
  const s = base();
  s.vouchers[0].inventoryEntries[0].rate = 110;
  s.vouchers[0].inventoryEntries[0].amount = 1100;
  s.vouchers[0].inventoryEntries[0].taxAmount = 210;
  const r = buildReconciliation(s);
  expect(r.lines[0].statuses).toContain(STATUS.RATE_VARIANCE);
  expect(r.lines[0].statuses).toContain(STATUS.GST_VARIANCE);
});

/* ── Charges — line vs header ──────────────────────────────────────────────── */

test("REQ6a · line charges compare ONLY when both sides carry line-level evidence", () => {
  const s = base();
  s.purchaseOrder.items[0].itemChargesTotal = 100;          // ordered line charge
  s.vouchers[0].inventoryEntries.push({ poItemId: "li1", isCharge: true, chargeDescription: "Packing", quantity: 0, rate: 0, amount: 130, taxAmount: 0 });
  const r = buildReconciliation(s);
  const l = r.lines[0];
  expect(l.charges.comparable).toBe(true);
  expect(l.charges.orderedCharges).toBe(100);
  expect(l.charges.billedCharges).toBe(130);
  expect(l.statuses).toContain(STATUS.CHARGES_VARIANCE);
  expect(l.billed.qty).toBe(10);          // the charge never inflates the product quantity
});

test("REQ6b · a line charge on only ONE side is 'Charge comparison unavailable', not a variance", () => {
  const s = base();
  s.purchaseOrder.items[0].itemChargesTotal = 100;   // ordered, but no billed line charge
  const r = buildReconciliation(s);
  const l = r.lines[0];
  expect(l.charges.comparable).toBe(false);
  expect(l.charges.missing).toBe("billed_line_charge");
  expect(l.statuses).not.toContain(STATUS.CHARGES_VARIANCE);
});

test("REQ6c · a header/order-level charge is shown separately, never distributed to lines", () => {
  const s = base();
  s.purchaseOrder.shippingCharges = 500;
  s.purchaseOrder.customCharges = [{ label: "Insurance", amount: 200 }];
  s.vouchers[0].inventoryEntries.push({ isCharge: true, chargeDescription: "Freight", quantity: 0, rate: 0, amount: 500, taxAmount: 0 });  // no poItemId
  const r = buildReconciliation(s);
  expect(r.orderCharges.orderedTotal).toBe(700);            // 500 + 200, header-level
  expect(r.orderCharges.billed.some((c) => c.description === "Freight")).toBe(true);
  expect(r.orderCharges.comparable).toBe(false);            // never matched to lines
  expect(r.lines[0].chargesTotal).toBe(0);                  // header charge not pushed onto the line
  expect(r.lines[0].billed.qty).toBe(10);                   // the freight charge is not a product line
});

/* ── The voucher-entry → PO-line join, primary then secondary ──────────────── */

test("19 · a voucher entry linked by poItemId records matchedBy 'poItemId' (primary)", () => {
  const r = buildReconciliation(base());
  expect(r.lines[0].billed.qty).toBe(10);
  expect(r.lines[0].billed.vouchers[0].matchedBy).toBe("poItemId");
  expect(r.unlinkedVoucherLines).toHaveLength(0);
});

test("20 · poItemId absent → a UNIQUE spendLineId links the entry (secondary), matchedBy 'spendLineId'", () => {
  const s = base();
  delete s.vouchers[0].inventoryEntries[0].poItemId;
  const r = buildReconciliation(s);
  expect(r.lines[0].billed.qty).toBe(10);
  expect(r.lines[0].billed.vouchers[0].matchedBy).toBe("spendLineId");
  expect(r.unlinkedVoucherLines).toHaveLength(0);
});

test("21 · a STALE poItemId falls back to a unique spendLineId rather than going unlinked", () => {
  const s = base();
  s.vouchers[0].inventoryEntries[0].poItemId = "ghost-line";
  const r = buildReconciliation(s);
  expect(r.lines[0].billed.qty).toBe(10);
  expect(r.lines[0].billed.vouchers[0].matchedBy).toBe("spendLineId");
});

test("22 · an AMBIGUOUS spendLineId (two PO lines share it, no poItemId) stays UNLINKED — never guessed", () => {
  const s = base();
  s.purchaseOrder.items = [
    { _id: "liA", spendLineId: "slDUP", itemName: "Bolt", unit: "pcs", quantity: 6, unitPrice: 100, totalPrice: 600, gstRate: 18, gstAmount: 108, receivedQuantity: 6, pendingQuantity: 0 },
    { _id: "liB", spendLineId: "slDUP", itemName: "Bolt", unit: "pcs", quantity: 4, unitPrice: 100, totalPrice: 400, gstRate: 18, gstAmount: 72, receivedQuantity: 4, pendingQuantity: 0 },
  ];
  s.spendRequest.items = [{ _id: "slDUP", amount: 1000, name: "Bolt" }];
  s.commitment.allocations = [{ spendLineId: "slDUP", amount: 1000, releasedAmount: 0, remainingAmount: 1000, status: "committed", ledgerId: "led1", ledgerName: "Repairs" }];
  s.goodsReceipts = []; s.inspections = [];
  s.vouchers = [{ _id: "v1", voucherNumber: "PV-1", status: "posted", inventoryEntries: [
    { spendLineId: "slDUP", quantity: 10, rate: 100, amount: 1000, taxAmount: 180 },
  ] }];
  const r = buildReconciliation(s);
  expect(r.lines[0].billed.qty).toBe(0);
  expect(r.lines[1].billed.qty).toBe(0);
  expect(r.unlinkedVoucherLines).toHaveLength(1);
  expect(r.unlinkedVoucherLines[0].unlinkedReason).toBe("ambiguous_spend_line");
});

test("23 · a stale poItemId AND an unknown spend line reports the primary-key failure 'stale_po_item'", () => {
  const s = base();
  s.vouchers[0].inventoryEntries[0].poItemId = "ghost";
  s.vouchers[0].inventoryEntries[0].spendLineId = "ghost-sl";
  const r = buildReconciliation(s);
  expect(r.lines[0].billed.qty).toBe(0);
  expect(r.unlinkedVoucherLines[0].unlinkedReason).toBe("stale_po_item");
});
