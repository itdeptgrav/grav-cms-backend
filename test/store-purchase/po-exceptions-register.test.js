// test/store-purchase/po-exceptions-register.test.js
//
// PURCHASE EXCEPTIONS REGISTER — the pure derivation. Driven with in-memory
// lean documents: rows are DERIVED from the accepted reconciliation, grouped,
// severity-scored, filtered, ordered and paginated, with money grouped per
// currency and cancelled vouchers excluded from live figures.
"use strict";

const {
  buildExceptionsRegister, filterRows, sortRows, paginate, summarize,
  outstandingExpectation, GROUPS, SEVERITY,
} = require("../../services/storePurchase/poExceptionsRegister.service");

const ASOF = new Date("2026-06-01T09:00:00Z"); // deterministic as-of for tests

// A clean, fully-matched order (no exceptions).
const cleanPO = (over = {}) => ({
  _id: "poClean", poNumber: "PO/CLEAN", status: "COMPLETED", vendorName: "Acme",
  orderDate: new Date("2026-05-01"), spendRequestId: "srC", spendRequestNumber: "SR-C",
  items: [{ _id: "lc1", spendLineId: "slc1", itemName: "Bolt", unit: "pcs", quantity: 10, unitPrice: 100, totalPrice: 1000, gstRate: 18, gstAmount: 180, receivedQuantity: 10, pendingQuantity: 0 }],
  deliveries: [], ...over,
});
// One GRN + inspection accepting `accepted` of `received` for a single-line PO.
const grnJoins = (poId, poItemId, received, accepted = received) => ({
  goodsReceiptsByPoId: new Map([[poId, [{ _id: `${poId}-grn`, receiptNumber: `${poId}/GRN`, status: "RECORDED", lines: [{ _id: `${poId}-grl`, poItemId, poUnit: "pcs", receivedQuantity: received }] }]]]),
  inspectionsByPoId: new Map([[poId, [{ _id: `${poId}-insp`, goodsReceiptId: `${poId}-grn`, lines: [{ goodsReceiptLineId: `${poId}-grl`, poItemId, unit: "pcs", receivedQuantity: accepted, acceptedQuantity: accepted, quarantinedQuantity: 0, rejectedQuantity: 0 }] }]]]),
});
const cleanJoins = () => ({
  spendRequestsById: new Map([["srC", { _id: "srC", requestNumber: "SR-C", items: [{ _id: "slc1", amount: 1000, name: "Bolt" }] }]]),
  commitmentsByRequestId: new Map([["srC", { _id: "cC", amount: 1000, status: "released", allocations: [{ spendLineId: "slc1", amount: 1000, releasedAmount: 1000, remainingAmount: 0, status: "released", ledgerId: "led1", ledgerName: "Repairs" }] }]]),
  vouchersByPoId: new Map([["poClean", [{ _id: "vC", voucherNumber: "PV-C", status: "posted", voucherDate: new Date("2026-05-02"), inventoryEntries: [{ poItemId: "lc1", spendLineId: "slc1", quantity: 10, rate: 100, amount: 1000, taxAmount: 180 }] }]]]),
  ...grnJoins("poClean", "lc1", 10, 10),
});

// An order still awaiting part of its delivery (LOW severity, "still to receive").
const pendingPO = () => ({
  _id: "poPend", poNumber: "PO/PEND", status: "PARTIALLY_RECEIVED", vendorName: "Beta",
  orderDate: new Date("2026-03-01"), spendRequestId: "srP", spendRequestNumber: "SR-P",
  items: [{ _id: "lp1", spendLineId: "slp1", itemName: "Wire", unit: "m", quantity: 100, unitPrice: 10, totalPrice: 1000, gstRate: 18, gstAmount: 180, receivedQuantity: 40, pendingQuantity: 60 }],
  deliveries: [],
});
const pendingJoins = () => ({
  spendRequestsById: new Map([["srP", { _id: "srP", requestNumber: "SR-P", items: [{ _id: "slp1", amount: 1000 }] }]]),
  commitmentsByRequestId: new Map([["srP", { _id: "cP", amount: 1000, status: "committed", allocations: [{ spendLineId: "slp1", amount: 1000, releasedAmount: 0, remainingAmount: 1000, status: "committed", ledgerId: "led1", ledgerName: "Repairs" }] }]]),
  vouchersByPoId: new Map(),
  // The 40 received are inspected & accepted (unit 'm'), so only the 60 pending
  // outstanding balance drives the row — no "awaiting inspection".
  goodsReceiptsByPoId: new Map([["poPend", [{ _id: "poPend-grn", receiptNumber: "PEND/GRN", status: "RECORDED", lines: [{ _id: "poPend-grl", poItemId: "lp1", poUnit: "m", receivedQuantity: 40 }] }]]]),
  inspectionsByPoId: new Map([["poPend", [{ _id: "poPend-insp", goodsReceiptId: "poPend-grn", lines: [{ goodsReceiptLineId: "poPend-grl", poItemId: "lp1", unit: "m", receivedQuantity: 40, acceptedQuantity: 40, quarantinedQuantity: 0, rejectedQuantity: 0 }] }]]]),
});

// A HIGH-severity order: billed at a different rate than ordered (price variance).
const priceVarPO = () => ({
  _id: "poPrice", poNumber: "PO/PRICE", status: "COMPLETED", vendorName: "Gamma",
  orderDate: new Date("2026-04-15"), spendRequestId: "srG", spendRequestNumber: "SR-G",
  items: [{ _id: "lg1", spendLineId: "slg1", itemName: "Sheet", unit: "pcs", quantity: 10, unitPrice: 100, totalPrice: 1000, gstRate: 18, gstAmount: 180, receivedQuantity: 10, pendingQuantity: 0 }],
  deliveries: [],
});
const priceVarJoins = () => ({
  spendRequestsById: new Map([["srG", { _id: "srG", requestNumber: "SR-G", items: [{ _id: "slg1", amount: 1000 }] }]]),
  commitmentsByRequestId: new Map([["srG", { _id: "cG", amount: 1000, status: "released", allocations: [{ spendLineId: "slg1", amount: 1000, releasedAmount: 1000, remainingAmount: 0, status: "released", ledgerId: "led1", ledgerName: "Repairs" }] }]]),
  vouchersByPoId: new Map([["poPrice", [{ _id: "vG", voucherNumber: "PV-G", status: "posted", voucherDate: new Date("2026-04-20"), inventoryEntries: [{ poItemId: "lg1", spendLineId: "slg1", quantity: 10, rate: 130, amount: 1300, taxAmount: 234 }] }]]]),
  ...grnJoins("poPrice", "lg1", 10, 10),   // received & accepted 10 — only the RATE differs
});

const mergeJoins = (...js) => ({
  spendRequestsById: new Map(js.flatMap((j) => [...j.spendRequestsById])),
  commitmentsByRequestId: new Map(js.flatMap((j) => [...j.commitmentsByRequestId])),
  vouchersByPoId: new Map(js.flatMap((j) => [...j.vouchersByPoId])),
  goodsReceiptsByPoId: new Map(js.flatMap((j) => [...(j.goodsReceiptsByPoId || new Map())])),
  inspectionsByPoId: new Map(js.flatMap((j) => [...(j.inspectionsByPoId || new Map())])),
});

test("1 · a fully matched order produces a row with NO exceptions and zero severity", () => {
  const rows = buildExceptionsRegister({ purchaseOrders: [cleanPO()], ...cleanJoins() });
  expect(rows).toHaveLength(1);
  expect(rows[0].exceptionCount).toBe(0);
  expect(rows[0].severity).toBe(0);
  expect(rows[0].totals.ordered).toBe(1180);
  expect(rows[0].totals.posted).toBe(1180);
});

test("2 · a partial delivery is 'Still to receive' (LOW) — never 'overdue'", () => {
  const rows = buildExceptionsRegister({ purchaseOrders: [pendingPO()], ...pendingJoins() });
  const groups = rows[0].exceptions.map((e) => e.group);
  expect(groups).toContain("STILL_TO_RECEIVE");
  expect(rows[0].severity).toBe(SEVERITY.LOW);
  expect(rows[0].exceptions.find((e) => e.group === "STILL_TO_RECEIVE").label).toBe("Still to receive");
  // No group in the whole register uses the word "overdue".
  for (const g of Object.values(GROUPS)) expect(g.label.toLowerCase()).not.toContain("overdue");
});

test("3 · a price variance is HIGH severity and carries a plain-language next action", () => {
  const rows = buildExceptionsRegister({ purchaseOrders: [priceVarPO()], ...priceVarJoins() });
  const ex = rows[0].exceptions.find((e) => e.group === "PRICE_VARIANCE");
  expect(ex).toBeTruthy();
  expect(ex.severity).toBe(SEVERITY.HIGH);
  expect(rows[0].severity).toBe(SEVERITY.HIGH);
  expect(ex.nextAction).toMatch(/rate/i);
});

test("4 · unresolved-only hides clean orders; scope 'all' keeps them", () => {
  const pos = [cleanPO(), pendingPO()];
  const joins = mergeJoins(cleanJoins(), pendingJoins());
  const rows = buildExceptionsRegister({ purchaseOrders: pos, ...joins });
  expect(filterRows(rows, { unresolvedOnly: true })).toHaveLength(1);
  expect(filterRows(rows, { unresolvedOnly: false })).toHaveLength(2);
});

test("5 · a group filter keeps only orders carrying that group", () => {
  const pos = [pendingPO(), priceVarPO()];
  const joins = mergeJoins(pendingJoins(), priceVarJoins());
  const rows = buildExceptionsRegister({ purchaseOrders: pos, ...joins });
  expect(filterRows(rows, { group: "PRICE_VARIANCE" }).map((r) => r.poNumber)).toEqual(["PO/PRICE"]);
  expect(filterRows(rows, { group: "STILL_TO_RECEIVE" }).map((r) => r.poNumber)).toEqual(["PO/PEND"]);
});

test("6 · default order is severity desc, then oldest activity, then PO number", () => {
  const pos = [pendingPO(), priceVarPO()];   // LOW (older) vs HIGH (newer)
  const joins = mergeJoins(pendingJoins(), priceVarJoins());
  const rows = sortRows(buildExceptionsRegister({ purchaseOrders: pos, ...joins }));
  expect(rows.map((r) => r.poNumber)).toEqual(["PO/PRICE", "PO/PEND"]);  // HIGH first
});

test("6b · within equal severity, the oldest last-activity sorts first, PO number breaks ties", () => {
  const a = priceVarPO(); a._id = "poA"; a.poNumber = "PO/A"; a.orderDate = new Date("2026-01-01");
  const b = priceVarPO(); b._id = "poB"; b.poNumber = "PO/B"; b.orderDate = new Date("2026-02-01");
  const ja = priceVarJoins(); ja.spendRequestsById = new Map(); ja.commitmentsByRequestId = new Map();
  ja.vouchersByPoId = new Map([["poA", [{ _id: "vA", voucherNumber: "PV-A", status: "posted", voucherDate: new Date("2026-01-05"), inventoryEntries: [{ poItemId: "lg1", quantity: 10, rate: 130, amount: 1300, taxAmount: 234 }] }]]]);
  const jb = priceVarJoins(); jb.spendRequestsById = new Map(); jb.commitmentsByRequestId = new Map();
  jb.vouchersByPoId = new Map([["poB", [{ _id: "vB", voucherNumber: "PV-B", status: "posted", voucherDate: new Date("2026-02-05"), inventoryEntries: [{ poItemId: "lg1", quantity: 10, rate: 130, amount: 1300, taxAmount: 234 }] }]]]);
  const rows = sortRows(buildExceptionsRegister({ purchaseOrders: [b, a], ...mergeJoins(ja, jb) }));
  expect(rows.map((r) => r.poNumber)).toEqual(["PO/A", "PO/B"]);  // A older → first
});

test("7 · pagination total describes the full FILTERED result, not the page", () => {
  const pos = []; const joins = { spendRequestsById: new Map(), commitmentsByRequestId: new Map(), vouchersByPoId: new Map() };
  for (let i = 0; i < 7; i++) {
    const p = pendingPO(); p._id = `poP${i}`; p.poNumber = `PO/P${i}`;
    p.spendRequestId = `srP${i}`; p.items[0]._id = `lp${i}`;
    pos.push(p);
    joins.commitmentsByRequestId.set(`srP${i}`, { amount: 1000, status: "committed", allocations: [{ spendLineId: `slp${i}`, amount: 1000, releasedAmount: 0, remainingAmount: 1000, status: "committed", ledgerId: "led1", ledgerName: "Repairs" }] });
    p.items[0].spendLineId = `slp${i}`;
  }
  const rows = filterRows(buildExceptionsRegister({ purchaseOrders: pos, ...joins }), {});
  const paged = paginate(rows, { page: 1, pageSize: 3 });
  expect(paged.total).toBe(7);
  expect(paged.totalPages).toBe(3);
  expect(paged.rows).toHaveLength(3);
  expect(paginate(rows, { page: 3, pageSize: 3 }).rows).toHaveLength(1);
});

test("8 · money is totalled ONLY in a known company base currency, and is otherwise withheld", () => {
  const rows = buildExceptionsRegister({ purchaseOrders: [priceVarPO()], ...priceVarJoins() });

  // Known company base currency → one total, carrying that currency + provenance.
  const known = summarize(rows, { currency: "INR", currencyBasis: "company_base_currency", currencySymbol: "₹" });
  expect(known.aggregateAvailable).toBe(true);
  expect(known.currency).toBe("INR");
  expect(known.total.currency).toBe("INR");
  expect(known.total.ordered).toBe(rows[0].totals.ordered);

  // No recorded currency → NO cross-order total, and a stated reason. No INR invented.
  const unknown = summarize(rows);   // defaults to not_recorded
  expect(unknown.aggregateAvailable).toBe(false);
  expect(unknown.currency).toBeNull();
  expect(unknown.total).toBeNull();
  expect(unknown.aggregateUnavailableReason).toMatch(/not recorded/i);
});

test("8b · the row itself invents no currency — PurchaseOrder stores none", () => {
  const rows = buildExceptionsRegister({ purchaseOrders: [priceVarPO()], ...priceVarJoins() });
  expect(rows[0].currency).toBeUndefined();
});

test("9 · a cancelled voucher is history — it creates no live exception and no live billed total", () => {
  const po = priceVarPO();
  const joins = priceVarJoins();
  // The only voucher is cancelled: the price variance must vanish (no live bill).
  joins.vouchersByPoId = new Map([["poPrice", [{ _id: "vG", voucherNumber: "PV-G", status: "cancelled", voucherDate: new Date("2026-04-20"), inventoryEntries: [{ poItemId: "lg1", spendLineId: "slg1", quantity: 10, rate: 130, amount: 1300, taxAmount: 234 }] }]]]);
  const rows = buildExceptionsRegister({ purchaseOrders: [po], ...joins });
  expect(rows[0].totals.billedLive).toBe(0);
  expect(rows[0].exceptions.some((e) => e.group === "PRICE_VARIANCE")).toBe(false);
  // With a live bill gone, a received-but-unbilled line is the honest state.
  expect(rows[0].exceptions.some((e) => e.group === "RECEIVED_NO_BILL")).toBe(true);
});

test("10 · a legacy order with no spend request shows missing lineage + legacy linkage", () => {
  const po = { _id: "poLeg", poNumber: "PO/LEG", status: "ISSUED", vendorName: "Delta", orderDate: new Date("2026-02-10"),
    items: [{ _id: "ll1", itemName: "Widget", unit: "pcs", quantity: 5, unitPrice: 100, totalPrice: 500, receivedQuantity: 0, pendingQuantity: 5 }], deliveries: [] };
  const rows = buildExceptionsRegister({ purchaseOrders: [po], spendRequestsById: new Map(), commitmentsByRequestId: new Map(), vouchersByPoId: new Map() });
  const groups = rows[0].exceptions.map((e) => e.group);
  expect(groups).toContain("MISSING_LINEAGE");
  expect(groups).toContain("LEGACY_LINKAGE");
});

test("11 · the summary counts ORDERS per concern, never adding unlike quantities", () => {
  const pos = [cleanPO(), pendingPO(), priceVarPO()];
  const joins = mergeJoins(cleanJoins(), pendingJoins(), priceVarJoins());
  const rows = filterRows(buildExceptionsRegister({ purchaseOrders: pos, ...joins }), {});
  const s = summarize(rows);
  expect(s.ordersNeedingAttention).toBe(2);       // pending + price (clean excluded)
  expect(s.stillToReceive).toBe(1);
  expect(s.financialVariances).toBe(1);           // the price-variance order
});

test("12 · affected-line count reflects only line-scoped issues", () => {
  const rows = buildExceptionsRegister({ purchaseOrders: [priceVarPO()], ...priceVarJoins() });
  expect(rows[0].affectedLineCount).toBe(1);
  expect(rows[0].reconciliationHref).toBe("/store/dashboard/operations/purchase-order/poPrice?tab=reconciliation");
});

/* ── Correction 3 — expected-delivery dates that actually exist ─────────────── */

test("13 · outstandingExpectation picks line date over header, and classifies past/future/undated by asOf", () => {
  // Line date wins, and it is in the past → past expected delivery.
  const past = outstandingExpectation({ lineExpectedDate: new Date("2026-05-01"), headerExpectedDate: new Date("2026-07-01"), asOf: ASOF });
  expect(past.group).toBe("PAST_EXPECTED_DELIVERY");
  expect(past.dateSource).toBe("line");

  // No line date → header date is used; it is in the future → still to receive.
  const future = outstandingExpectation({ lineExpectedDate: null, headerExpectedDate: new Date("2026-07-01"), asOf: ASOF });
  expect(future.group).toBe("STILL_TO_RECEIVE");
  expect(future.dateSource).toBe("header");
  expect(future.past).toBe(false);

  // Expected today is NOT past (calendar-day comparison, not timestamp).
  const today = outstandingExpectation({ lineExpectedDate: new Date("2026-06-01"), headerExpectedDate: null, asOf: ASOF });
  expect(today.group).toBe("STILL_TO_RECEIVE");

  // No date at all → still to receive, undated.
  const undated = outstandingExpectation({ lineExpectedDate: null, headerExpectedDate: null, asOf: ASOF });
  expect(undated.group).toBe("STILL_TO_RECEIVE");
  expect(undated.undated).toBe(true);
});

const outstandingPO = (over = {}) => ({
  _id: "poOut", poNumber: "PO/OUT", status: "ISSUED", vendorName: "Zed", orderDate: new Date("2026-04-01"),
  items: [{ _id: "lo1", itemName: "Cable", unit: "m", quantity: 100, unitPrice: 10, totalPrice: 1000, gstRate: 0, gstAmount: 0, receivedQuantity: 40, pendingQuantity: 60, ...over }],
  deliveries: [],
});
const noJoins = () => ({ spendRequestsById: new Map(), commitmentsByRequestId: new Map(), vouchersByPoId: new Map() });

test("14 · a line past its expected date is 'Past expected delivery' (MEDIUM), exposing the date + source", () => {
  const po = outstandingPO({ expectedDeliveryDate: new Date("2026-05-10") });
  const rows = buildExceptionsRegister({ purchaseOrders: [po], ...noJoins(), asOf: ASOF });
  const ex = rows[0].exceptions.find((e) => e.group === "PAST_EXPECTED_DELIVERY");
  expect(ex).toBeTruthy();
  expect(ex.severity).toBe(SEVERITY.MEDIUM);
  expect(ex.dateSource).toBe("line");
  expect(ex.expectedDate).toContain("2026-05-10");
  expect(rows[0].exceptions.some((e) => e.group === "STILL_TO_RECEIVE")).toBe(false);
});

test("15 · a future expected date stays 'Still to receive'; an undated line is flagged undated", () => {
  const future = buildExceptionsRegister({ purchaseOrders: [outstandingPO({ expectedDeliveryDate: new Date("2026-07-10") })], ...noJoins(), asOf: ASOF });
  const fx = future[0].exceptions.find((e) => e.group === "STILL_TO_RECEIVE");
  expect(fx.dateSource).toBe("line");
  expect(fx.undatedCount).toBe(0);
  expect(future[0].exceptions.some((e) => e.group === "PAST_EXPECTED_DELIVERY")).toBe(false);

  const undated = buildExceptionsRegister({ purchaseOrders: [outstandingPO()], ...noJoins(), asOf: ASOF });
  const ux = undated[0].exceptions.find((e) => e.group === "STILL_TO_RECEIVE");
  expect(ux.undatedCount).toBe(1);
  expect(ux.expectedDate).toBeNull();
});

test("16 · header expected date is used when the line has none", () => {
  const po = outstandingPO();               // line has no expected date
  po.expectedDeliveryDate = new Date("2026-05-05");   // header does
  const rows = buildExceptionsRegister({ purchaseOrders: [po], ...noJoins(), asOf: ASOF });
  const ex = rows[0].exceptions.find((e) => e.group === "PAST_EXPECTED_DELIVERY");
  expect(ex.dateSource).toBe("header");
});

/* ── Correction 4 — cancelled order and line semantics ─────────────────────── */

test("17 · a cancelled LINE with pending quantity is no longer outstanding", () => {
  const po = outstandingPO({ status: "CANCELLED", expectedDeliveryDate: new Date("2026-05-01") });
  const rows = buildExceptionsRegister({ purchaseOrders: [po], ...noJoins(), asOf: ASOF });
  expect(rows[0].exceptions.some((e) => e.group === "STILL_TO_RECEIVE" || e.group === "PAST_EXPECTED_DELIVERY")).toBe(false);
});

// Satisfied lineage (linked request + fully released commitment), so a test can
// isolate delivery behaviour with no missing-lineage/legacy noise.
const releasedLineage = (spendLineId) => ({
  spendRequestsById: new Map([["srC", { _id: "srC", requestNumber: "SR-C", items: [{ _id: spendLineId, amount: 1000 }] }]]),
  commitmentsByRequestId: new Map([["srC", { _id: "cC", amount: 1000, status: "released", allocations: [{ spendLineId, amount: 1000, releasedAmount: 1000, remainingAmount: 0, status: "released", ledgerId: "led1", ledgerName: "Repairs" }] }]]),
  vouchersByPoId: new Map(),
});

test("18 · a cancelled ORDER with no bill raises no purchasing/receipt expectation", () => {
  const po = outstandingPO({ spendLineId: "slc1", expectedDeliveryDate: new Date("2026-05-01") });
  po.status = "CANCELLED"; po.spendRequestId = "srC"; po.spendRequestNumber = "SR-C";
  const rows = buildExceptionsRegister({ purchaseOrders: [po], ...releasedLineage("slc1"), asOf: ASOF });
  expect(rows[0].exceptions.some((e) => e.group === "STILL_TO_RECEIVE" || e.group === "PAST_EXPECTED_DELIVERY")).toBe(false);
  expect(rows[0].exceptionCount).toBe(0);
});

test("19 · a cancelled order with a LIVE bill still surfaces the financial exception", () => {
  const po = outstandingPO({ expectedDeliveryDate: new Date("2026-05-01"), receivedQuantity: 40, pendingQuantity: 60 });
  po.status = "CANCELLED";
  // A posted bill for 40 @ a different rate than ordered: a real reconciliation
  // concern that cancellation does NOT erase.
  const joins = noJoins();
  joins.vouchersByPoId = new Map([["poOut", [{ _id: "vC", voucherNumber: "PV-C", status: "posted", voucherDate: new Date("2026-05-02"), inventoryEntries: [{ poItemId: "lo1", quantity: 40, rate: 15, amount: 600, taxAmount: 0 }] }]]]);
  const rows = buildExceptionsRegister({ purchaseOrders: [po], ...joins, asOf: ASOF });
  // No delivery expectation…
  expect(rows[0].exceptions.some((e) => e.group === "STILL_TO_RECEIVE" || e.group === "PAST_EXPECTED_DELIVERY")).toBe(false);
  // …but the price variance survives, and the live bill still counts.
  expect(rows[0].exceptions.some((e) => e.group === "PRICE_VARIANCE")).toBe(true);
  expect(rows[0].totals.billedLive).toBe(600);
});

test("20 · a mixed order — one active line, one cancelled — expects only the active line", () => {
  const po = {
    _id: "poMix", poNumber: "PO/MIX", status: "PARTIALLY_RECEIVED", vendorName: "Mix", orderDate: new Date("2026-04-01"),
    spendRequestId: "srM", spendRequestNumber: "SR-M",
    items: [
      { _id: "lm1", spendLineId: "slm1", itemName: "Active", unit: "pcs", quantity: 10, unitPrice: 100, totalPrice: 1000, receivedQuantity: 2, pendingQuantity: 8, status: "PARTIALLY_RECEIVED", expectedDeliveryDate: new Date("2026-05-01") },
      { _id: "lm2", spendLineId: "slm2", itemName: "Cancelled", unit: "pcs", quantity: 5, unitPrice: 50, totalPrice: 250, receivedQuantity: 0, pendingQuantity: 5, status: "CANCELLED", expectedDeliveryDate: new Date("2026-05-01") },
    ],
    deliveries: [],
  };
  const joins = {
    spendRequestsById: new Map([["srM", { _id: "srM", requestNumber: "SR-M", items: [{ _id: "slm1", amount: 1000 }, { _id: "slm2", amount: 250 }] }]]),
    commitmentsByRequestId: new Map([["srM", { _id: "cM", amount: 1250, status: "released", allocations: [
      { spendLineId: "slm1", amount: 1000, releasedAmount: 1000, remainingAmount: 0, status: "released", ledgerId: "led1", ledgerName: "Repairs" },
      { spendLineId: "slm2", amount: 250, releasedAmount: 250, remainingAmount: 0, status: "released", ledgerId: "led1", ledgerName: "Repairs" },
    ] }]]),
    vouchersByPoId: new Map(),
  };
  const rows = buildExceptionsRegister({ purchaseOrders: [po], ...joins, asOf: ASOF });
  const past = rows[0].exceptions.find((e) => e.group === "PAST_EXPECTED_DELIVERY");
  expect(past).toBeTruthy();
  expect(past.count).toBe(1);          // only the active line, not the cancelled one
  expect(rows[0].affectedLineCount).toBe(1);
});
