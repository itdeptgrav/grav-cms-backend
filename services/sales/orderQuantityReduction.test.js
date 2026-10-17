// node --test services/sales/orderQuantityReduction.test.js
// The pure half of Sales reducing a released bulk order's quantities.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const r = require("./orderQuantityReduction");

const wo = (over = {}) => ({
  _id: "wo1", workOrderNumber: "WO-0001", status: "in_progress",
  stockItemId: "p1", stockItemName: "Polo shirt", variantId: "v1",
  variantAttributes: [{ name: "Size", value: "M" }],
  quantity: 100, ...over,
});

test("requestEditable: bulk, sales-approved and open only", () => {
  const ok = { requestType: "bulk", status: "quotation_sales_approved", quotations: [{ status: "sales_approved" }] };
  assert.equal(r.requestEditable(ok).ok, true);
  assert.equal(r.requestEditable({ ...ok, status: "production" }).ok, true);
  assert.equal(r.requestEditable({ ...ok, requestType: "measurement_conversion" }).code, r.CODES.NOT_BULK);
  assert.equal(r.requestEditable({ ...ok, measurementId: "m1" }).code, r.CODES.NOT_BULK);
  assert.equal(r.requestEditable({ ...ok, quotations: [{ status: "sent_to_customer" }] }).code, r.CODES.NOT_APPROVED);
  assert.equal(r.requestEditable({ ...ok, quotations: [] }).code, r.CODES.NOT_APPROVED);
  assert.equal(r.requestEditable({ ...ok, status: "shipping" }).code, r.CODES.ORDER_CLOSED);
  assert.equal(r.requestEditable({ ...ok, status: "cancelled" }).code, r.CODES.ORDER_CLOSED);
  assert.equal(r.requestEditable(null).ok, false);
});

test("floorFor: the highest thing the floor has done holds the floor, else 1", () => {
  assert.deepEqual(r.floorFor(wo()), { floor: 1, reason: "nothing is made yet — down to 1 piece" });
  assert.equal(r.floorFor(wo({ cuttingProgress: { completed: 30 } })).floor, 30);
  assert.equal(r.floorFor(wo({ packagedQuantity: 12, dispatchedQuantity: 5 })).floor, 12);
  const scanned = r.floorFor(wo({ productionCompletion: { overallCompletedQuantity: 3, operationCompletion: [{ completedUnitNumbers: [1, 2, 41] }] } }));
  assert.equal(scanned.floor, 41, "piece 41 exists even though only 3 are finished");
  assert.match(scanned.reason, /piece 41/);
  assert.equal(r.floorFor(wo({ qcCompletion: { completedQuantity: 7 }, cuttingProgress: { completed: 6 } })).floor, 7);
});

test("matchRequestVariant: by line reference, variant id, attributes, or the lone variant", () => {
  const request = { items: [
    { lineRef: "LN-aaaaaaaaaaaa", stockItemId: "p1", variants: [{ variantId: "v1", attributes: [{ name: "Size", value: "M" }], quantity: 100 }, { variantId: "v2", attributes: [{ name: "Size", value: "L" }], quantity: 50 }] },
    { lineRef: "LN-bbbbbbbbbbbb", stockItemId: "p2", variants: [{ variantId: "v9", attributes: [], quantity: 10 }] },
  ] };
  assert.equal(r.matchRequestVariant(request, wo()).variant.variantId, "v1");
  assert.equal(r.matchRequestVariant(request, wo({ variantId: "other", variantAttributes: [{ name: "Size", value: "L" }] })).variant.variantId, "v2", "by attributes");
  assert.equal(r.matchRequestVariant(request, wo({ stockItemId: "p2", variantId: "zzz", variantAttributes: [] })).variant.variantId, "v9", "the lone variant");
  assert.equal(r.matchRequestVariant(request, wo({ stockItemId: "p3" })).variant, null);
  const byRef = r.matchRequestVariant(request, wo({ salesLineLink: { lineRef: "LN-bbbbbbbbbbbb" }, stockItemId: "p2", variantId: "v9" }));
  assert.equal(byRef.item.lineRef, "LN-bbbbbbbbbbbb");
});

test("lineView: what the drawer reads", () => {
  const request = {
    items: [{ stockItemId: "p1", variants: [{ variantId: "v1", attributes: [{ name: "Size", value: "M" }], quantity: 100 }] }],
    quotations: [{ items: [{ stockItemId: "p1", attributes: [{ name: "Size", value: "M" }], unitPrice: 250, gstPercentage: 5 }] }],
  };
  const v = r.lineView(request, wo({ packagedQuantity: 20, originalQuantity: 120, quantityChanges: [{ from: 120, to: 100, reason: "typo", changedBy: { name: "R" } }] }));
  assert.equal(v.reference, "WO-0001"); assert.equal(v.variant, "Size: M");
  assert.equal(v.quantity, 100); assert.equal(v.originalQuantity, 120); assert.equal(v.floor, 20);
  assert.equal(v.unitPrice, 250); assert.equal(v.gstPercentage, 5);
  assert.equal(v.canReduce, true); assert.equal(v.onRequest, true);
  assert.deepEqual(v.changes[0].from, 120); assert.equal(v.changes[0].by, "R");
  assert.equal(r.lineView(request, wo({ status: "completed" })).canReduce, false);
  assert.equal(r.lineView(request, wo({ quantity: 1 })).canReduce, false, "already at the floor");
});

test("planReduction: up or down, never below the floor, every refusal named", () => {
  const list = [wo(), wo({ _id: "wo2", workOrderNumber: "WO-0002", variantAttributes: [{ name: "Size", value: "L" }], quantity: 50, packagedQuantity: 10 })];
  const ok = r.planReduction(list, [{ workOrderId: "wo1", quantity: 80 }, { workOrderId: "wo2", quantity: 50 }]);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.changes, [{ workOrderId: "wo1", from: 100, to: 80 }]);
  assert.deepEqual(ok.unchanged, ["wo2"]);
  const up = r.planReduction(list, [{ workOrderId: "wo1", quantity: 120 }, { workOrderId: "wo2", quantity: 60 }]);
  assert.deepEqual(up.errors, [], "raising a variant is allowed (17 Oct 2026, owner)");
  assert.deepEqual(up.changes, [{ workOrderId: "wo1", from: 100, to: 120 }, { workOrderId: "wo2", from: 50, to: 60 }]);
  assert.deepEqual(r.planReduction(list, [{ workOrderId: "wo2", quantity: 12 }]).errors, [], "lowering to above the floor is fine");
  assert.match(r.planReduction(list, [{ workOrderId: "wo1", quantity: r.MAX_PIECES + 1 }]).errors[0], /more than 100000 pieces/);
  assert.equal(r.planChange, r.planReduction);
  assert.match(r.planReduction(list, [{ workOrderId: "wo2", quantity: 5 }]).errors[0], /cannot go below 10 — 10 piece\(s\) are packed/);
  assert.match(r.planReduction(list, [{ workOrderId: "wo1", quantity: 0 }]).errors[0], /at least 1/);
  assert.match(r.planReduction(list, [{ workOrderId: "wo1", quantity: 2.5 }]).errors[0], /whole number/);
  assert.match(r.planReduction(list, [{ workOrderId: "nope", quantity: 2 }]).errors[0], /not on this order/);
  assert.match(r.planReduction(list, [{ workOrderId: "wo1", quantity: 2 }, { workOrderId: "wo1", quantity: 3 }]).errors[0], /twice/);
  assert.match(r.planReduction(list, [{ workOrderId: "wo2", quantity: 50 }]).errors[0], /Nothing changed/);
  assert.match(r.planReduction(list, []).errors[0], /which work orders/);
  assert.match(r.planReduction([wo({ status: "completed" })], [{ workOrderId: "wo1", quantity: 5 }]).errors[0], /history/);
});

test("applyToWorkOrder: quantity, original kept, the log, cutting remaining and completion totals re-based", () => {
  const w = wo({ cuttingProgress: { completed: 10, remaining: 90 }, productionCompletion: { overallCompletedQuantity: 20, overallCompletionPercentage: 20, operationCompletion: [{ operationNumber: 1, completedQuantity: 20, totalQuantity: 100, completionPercentage: 20, status: "in_progress" }, { operationNumber: 2, completedQuantity: 40, totalQuantity: 100, completionPercentage: 40, status: "in_progress" }] } });
  r.applyToWorkOrder(w, { workOrderId: "wo1", from: 100, to: 40 }, { reason: "typo", actor: { id: "u1", name: "Rakesh" } });
  assert.equal(w.quantity, 40); assert.equal(w.originalQuantity, 100);
  assert.deepEqual([w.quantityChanges[0].from, w.quantityChanges[0].to, w.quantityChanges[0].reason, w.quantityChanges[0].changedBy.name], [100, 40, "typo", "Rakesh"]);
  assert.equal(w.cuttingProgress.remaining, 30);
  assert.equal(w.productionCompletion.operationCompletion[0].totalQuantity, 40);
  assert.equal(w.productionCompletion.operationCompletion[0].completionPercentage, 50);
  assert.equal(w.productionCompletion.operationCompletion[1].completionPercentage, 100);
  assert.equal(w.productionCompletion.operationCompletion[1].status, "completed");
  assert.equal(w.productionCompletion.overallCompletionPercentage, 50);
  /* a second change keeps the first original */
  r.applyToWorkOrder(w, { workOrderId: "wo1", from: 40, to: 35 });
  assert.equal(w.originalQuantity, 100); assert.equal(w.quantityChanges.length, 2);
});

test("applyToRequestItems: the variant, the line total and the estimate per piece", () => {
  const request = { items: [{ stockItemId: "p1", totalQuantity: 150, totalEstimatedPrice: 37500, variants: [
    { variantId: "v1", attributes: [{ name: "Size", value: "M" }], quantity: 100, estimatedPrice: 25000 },
    { variantId: "v2", attributes: [{ name: "Size", value: "L" }], quantity: 50, estimatedPrice: 12500 },
  ] }] };
  const out = r.applyToRequestItems(request, wo(), { workOrderId: "wo1", from: 100, to: 60 });
  assert.deepEqual(out, { found: true, before: 100, after: 60 });
  assert.equal(request.items[0].variants[0].quantity, 60);
  assert.equal(request.items[0].variants[0].estimatedPrice, 15000);
  assert.equal(request.items[0].totalQuantity, 110);
  assert.equal(request.items[0].totalEstimatedPrice, 27500);
  assert.equal(r.applyToRequestItems(request, wo({ stockItemId: "p9" }), { to: 1 }).found, false);
});

test("rebasePaymentSchedule: amounts follow the percentages; paid money is kept and an excess is said", () => {
  const q = { grandTotal: 1000, paymentSchedule: [
    { stepNumber: 1, name: "Advance", percentage: 30, amount: 600, paidAmount: 600, status: "paid" },
    { stepNumber: 2, name: "Balance", percentage: 70, amount: 1400, paidAmount: 0, status: "pending" },
    { stepNumber: 3, name: "Odd", percentage: 0, amount: 5 },
  ] };
  const over = r.rebasePaymentSchedule(q);
  assert.equal(q.paymentSchedule[0].amount, 300); assert.equal(q.paymentSchedule[0].paidAmount, 600);
  assert.equal(q.paymentSchedule[1].amount, 700); assert.equal(q.paymentSchedule[1].status, "pending");
  assert.equal(q.paymentSchedule[2].amount, 5, "a step with no percentage is left alone");
  assert.deepEqual(over, [{ stepNumber: 1, name: "Advance", amount: 300, paidAmount: 600, excess: 300 }]);
  const q2 = { grandTotal: 1000, paymentSchedule: [{ stepNumber: 1, percentage: 50, amount: 800, paidAmount: 500, status: "partial" }] };
  r.rebasePaymentSchedule(q2);
  assert.equal(q2.paymentSchedule[0].status, "paid", "fully paid at the new amount");
  const q3 = { grandTotal: 2000, paymentSchedule: [
    { stepNumber: 1, percentage: 30, amount: 300, paidAmount: 300, status: "paid" },
    { stepNumber: 2, percentage: 70, amount: 700, paidAmount: 0, status: "paid" },
  ] };
  assert.deepEqual(r.rebasePaymentSchedule(q3), []);
  assert.equal(q3.paymentSchedule[0].amount, 600);
  assert.equal(q3.paymentSchedule[0].status, "partially_paid", "a raised total leaves a paid step part-paid");
  assert.equal(q3.paymentSchedule[1].status, "pending");
});

test("changeNote reads in words", () => {
  const note = r.changeNote([{ workOrderId: "wo1", from: 100, to: 80 }], [wo()], { reason: "customer PO was 80", by: "Rakesh" });
  assert.equal(note, "Order quantity reduced by 20 pieces by Rakesh: Polo shirt (Size: M) 100 → 80. Reason: customer PO was 80");
  assert.equal(r.movementText([{ from: 100, to: 110 }]), "Order quantity raised by 10 pieces");
  assert.equal(r.movementText([{ from: 100, to: 110 }, { from: 50, to: 49 }]), "Order quantity changed: +10 pieces, −1 piece");
});

test("applyToWorkOrder on a raise: more pieces left to cut, percentages fall, the log says increase", () => {
  const w = wo({ cuttingProgress: { completed: 10, remaining: 90 }, productionCompletion: { overallCompletedQuantity: 50, overallCompletionPercentage: 50, operationCompletion: [{ operationNumber: 1, completedQuantity: 100, totalQuantity: 100, completionPercentage: 100, status: "completed" }] } });
  r.applyToWorkOrder(w, { workOrderId: "wo1", from: 100, to: 200 }, { reason: "PO was 200" });
  assert.equal(w.quantity, 200); assert.equal(w.originalQuantity, 100);
  assert.equal(w.quantityChanges[0].source, "sales-increase");
  assert.equal(w.cuttingProgress.remaining, 190);
  assert.equal(w.productionCompletion.overallCompletionPercentage, 25);
  assert.equal(w.productionCompletion.operationCompletion[0].completionPercentage, 50);
  assert.equal(w.productionCompletion.operationCompletion[0].status, "in_progress");
  assert.equal(r.lineView({ items: [], quotations: [] }, w).canChange, true);
});
