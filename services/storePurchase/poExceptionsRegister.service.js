// services/storePurchase/poExceptionsRegister.service.js
//
// PURCHASE EXCEPTIONS REGISTER — the company-wide, read-only queue that answers
// "which purchases need attention today, why, and where do I go to resolve them?"
//
// It is NOT a second reconciliation. Every row is DERIVED from the accepted
// per-order reconciliation (poReconciliation.service) — this module only reads
// that output, groups the issues into business-facing exception groups, scores
// severity by impact, and totals money in the company's base currency (only
// when that currency is known; never inventing one). It writes nothing.
//
// Delivery expectation uses the expected-delivery dates the records DO hold
// (PO line date, else PO header date), classified against an injected `asOf`
// so tests do not depend on the wall clock. A cancelled line — or every line of
// a cancelled order — is no longer expected, so it raises no "still to receive"
// or "past expected delivery"; its financial history (bills, commitments) is
// preserved.
//
// The route hands us an already-loaded page of POs plus the three batched
// stored-ID joins (spend requests, commitments, vouchers) so the whole register
// costs a constant number of queries — never one reconciliation round-trip per
// order.

"use strict";

const { buildReconciliation } = require("./poReconciliation.service");

const TOL = 0.01;

// Business impact, highest first. Used only for ordering and the row badge.
const SEVERITY = Object.freeze({ HIGH: 3, MEDIUM: 2, LOW: 1 });

// The exception groups the register speaks in — operational language, never an
// internal enum, and never a claim (inspection, acceptance, payment) the
// records do not prove. An outstanding balance is "Past expected delivery" only
// when a stored expected date has actually passed; otherwise "Still to receive"
// (with, or without, a recorded expected date).
const GROUPS = Object.freeze({
  PAST_EXPECTED_DELIVERY: { label: "Past expected delivery",        severity: SEVERITY.MEDIUM, nextAction: "The expected delivery date has passed — follow up with the supplier." },
  STILL_TO_RECEIVE:       { label: "Still to receive",              severity: SEVERITY.LOW,    nextAction: "Record the goods receipt when the balance arrives." },
  OVER_RECEIPT:           { label: "Over-receipt",                  severity: SEVERITY.MEDIUM, nextAction: "Check the receipt — more was recorded than ordered." },
  AWAITING_INSPECTION:    { label: "Received, awaiting inspection", severity: SEVERITY.MEDIUM, nextAction: "Inspect the receipt — a three-way match is not available until goods pass inspection." },
  QUARANTINE_UNRESOLVED:  { label: "Quarantine unresolved",         severity: SEVERITY.HIGH,   nextAction: "Resolve the quarantined quantity (release or supplier return)." },
  RECEIVED_NO_BILL:       { label: "Accepted, bill not recorded",   severity: SEVERITY.MEDIUM, nextAction: "Record the supplier bill for the accepted quantity in Accounting." },
  BILL_OVER_RECEIVED:     { label: "Billed above received",         severity: SEVERITY.HIGH,   nextAction: "Hold the bill — it exceeds the received quantity." },
  BILL_OVER_ACCEPTED:     { label: "Billed above accepted quantity", severity: SEVERITY.HIGH,  nextAction: "Hold the bill — it exceeds the quantity that passed inspection." },
  QTY_VARIANCE:           { label: "Quantity differs from accepted", severity: SEVERITY.HIGH,  nextAction: "Reconcile the billed quantity against the accepted quantity." },
  PRICE_VARIANCE:         { label: "Rate differs from order",       severity: SEVERITY.HIGH,   nextAction: "Reconcile the billed rate against the ordered rate." },
  TAX_VARIANCE:           { label: "GST differs from order",        severity: SEVERITY.MEDIUM, nextAction: "Reconcile the billed GST against the ordered GST." },
  CHARGE_VARIANCE:        { label: "Charges differ from order",     severity: SEVERITY.MEDIUM, nextAction: "Reconcile the billed line charges against the ordered line charges." },
  BILL_AWAITING_POSTING:  { label: "Bill awaiting posting",         severity: SEVERITY.LOW,    nextAction: "Post the recorded bill to update the budget actual." },
  COMMITMENT_NOT_RELEASED:{ label: "Budget commitment not released", severity: SEVERITY.MEDIUM, nextAction: "Release the budget commitment against the posted bill." },
  UNLINKED_BILL:          { label: "Unlinked bill line",            severity: SEVERITY.HIGH,   nextAction: "A live bill line matches no order line — check the bill." },
  MISSING_LINEAGE:        { label: "Missing request or budget lineage", severity: SEVERITY.LOW, nextAction: "No spend request is linked, so approval and budget cannot be traced." },
  LEGACY_LINKAGE:         { label: "Legacy evidence incomplete",    severity: SEVERITY.LOW,    nextAction: "This order predates line-level linkage, so some evidence is unavailable." },
});

// Reconciliation's per-line statuses → register groups (line-scoped). The
// statuses are the correctly GATED per-line verdict: "Price variance" and "Tax
// variance" only appear once a live bill exists, so a merely-unbilled line is
// never mistaken for a variance. (The looser exceptions[] price/tax codes fire
// on any line that carries GST but has no bill yet, so they are NOT used here.)
// NB: the "still to receive" family is NOT taken from these statuses. An
// outstanding balance is re-classified here against the stored expected date and
// suppressed for cancelled lines — a distinction the reconciliation statuses do
// not carry — so "Awaiting receipt"/"Partly received"/QTY_DUE are handled by the
// delivery-expectation logic below, not mapped straight through.
const STATUS_TO_GROUP = Object.freeze({
  "Over-received": "OVER_RECEIPT",
  "Received, awaiting inspection": "AWAITING_INSPECTION",
  "Quarantined quantity unresolved": "QUARANTINE_UNRESOLVED",
  "Accepted, awaiting bill": "RECEIVED_NO_BILL",
  "Bill recorded, awaiting posting": "BILL_AWAITING_POSTING",
  "Billed above accepted quantity": "BILL_OVER_ACCEPTED",
  "Quantity variance": "QTY_VARIANCE",
  "Rate variance": "PRICE_VARIANCE",
  "GST variance": "TAX_VARIANCE",
  "Charges variance": "CHARGE_VARIANCE",
  "Legacy evidence incomplete": "LEGACY_LINKAGE",
});

// Reconciliation's actionable exception codes → register groups. Only the codes
// that are specific and correctly gated are used; price/tax come from statuses,
// and the outstanding-delivery family is computed from stored dates below.
const EXCEPTION_TO_GROUP = Object.freeze({
  OVER_RECEIPT: "OVER_RECEIPT",
  AWAITING_INSPECTION: "AWAITING_INSPECTION",
  QUARANTINE_UNRESOLVED: "QUARANTINE_UNRESOLVED",
  BILLED_ABOVE_ACCEPTED: "BILL_OVER_ACCEPTED",
  CHARGES_DIFF: "CHARGE_VARIANCE",
  COMMITMENT_NOT_RELEASED: "COMMITMENT_NOT_RELEASED",
  POSTED_UNMAPPED_ALLOCATION: "COMMITMENT_NOT_RELEASED",
});

// Purchasing/receipt EXPECTATIONS that a cancellation ends. A cancelled line
// keeps its financial history (bills, commitments, unlinked live bills) but is
// no longer awaited, so these two groups are suppressed for it.
const EXPECTATION_GROUPS = Object.freeze(new Set(["STILL_TO_RECEIVE", "PAST_EXPECTED_DELIVERY", "AWAITING_INSPECTION"]));

// Calendar-day key (UTC) so an expected date "today" is not read as past merely
// because `asOf` carries a later time on the same day.
const dayKey = (d) => {
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return null;
  return t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate();
};

/**
 * Classify ONE outstanding (pending > 0, not cancelled) line's delivery
 * expectation from the dates the records actually hold.
 *   1. the line's own expected date, when present;
 *   2. otherwise the PO header's expected date;
 *   3. before `asOf` (by calendar day) → Past expected delivery;
 *   4. today or later → Still to receive;
 *   5. no date recorded → Still to receive (undated).
 */
function outstandingExpectation({ lineExpectedDate, headerExpectedDate, asOf }) {
  const chosen = lineExpectedDate || headerExpectedDate || null;
  const dateSource = lineExpectedDate ? "line" : (headerExpectedDate ? "header" : null);
  const key = chosen ? dayKey(chosen) : null;
  if (key === null) return { group: "STILL_TO_RECEIVE", expectedDate: null, dateSource: null, undated: true, past: false };
  const past = key < dayKey(asOf);
  return {
    group: past ? "PAST_EXPECTED_DELIVERY" : "STILL_TO_RECEIVE",
    expectedDate: new Date(chosen), dateSource, undated: false, past,
  };
}

// The Purchase Reconciliation tab is URL-addressable; "Open reconciliation"
// deep-links straight to it. One place, so a route change is one edit.
const defaultReconciliationHref = (id) => `/store/dashboard/operations/purchase-order/${id}?tab=reconciliation`;

const maxDate = (dates) => {
  let best = null;
  for (const d of dates) {
    if (!d) continue;
    const t = new Date(d);
    if (Number.isNaN(t.getTime())) continue;
    if (best === null || t > best) best = t;
  }
  return best;
};

/**
 * Turn one order's reconciliation into a register row.
 * @param {object}   po        the lean purchase order
 * @param {object}   recon     buildReconciliation(...) output for this PO
 * @param {object[]} vouchers  the PO's live+history vouchers (for last-activity)
 * @param {object}   links     href builders
 */
function registerRow(po, recon, vouchers, links = {}, asOf = new Date()) {
  // Group the reconciliation's own findings — never re-derive from raw fields.
  const lineSets = new Map();   // group → Set(poItemId)   (line-scoped issues)
  const occ = new Map();        // group → count            (order-level issues)
  const addLine = (g, id) => { if (!lineSets.has(g)) lineSets.set(g, new Set()); lineSets.get(g).add(id); };
  const addOcc = (g) => occ.set(g, (occ.get(g) || 0) + 1);

  // A cancelled line (or every line of a cancelled order) is no longer awaited,
  // so its RECEIPT and INSPECTION expectations end. Its financial history (bills,
  // variances, commitments, quarantined stock) is preserved.
  const orderCancelled = po.status === "CANCELLED";
  const lineMetaById = new Map();
  for (const it of (po.items || [])) lineMetaById.set(String(it._id), it);
  const isLineCancelled = (id) => orderCancelled || (lineMetaById.get(String(id)) && lineMetaById.get(String(id)).status === "CANCELLED");
  const addLineGuarded = (g, id) => { if (EXPECTATION_GROUPS.has(g) && isLineCancelled(id)) return; addLine(g, id); };

  for (const l of recon.lines) {
    for (const s of l.statuses) {
      const g = STATUS_TO_GROUP[s];
      if (g) addLineGuarded(g, l.poItemId);
    }
  }
  for (const e of recon.exceptions) {
    if (e.code === "NO_REQUEST") addOcc("MISSING_LINEAGE");
    else if (e.code === "UNLINKED_BILL") addOcc("UNLINKED_BILL");
    else if (e.code === "RECEIPT_INVOICE_NO_VOUCHER") addOcc("RECEIVED_NO_BILL");
    else if (EXCEPTION_TO_GROUP[e.code] && e.poItemId) addLineGuarded(EXCEPTION_TO_GROUP[e.code], e.poItemId);
  }

  // ── Outstanding-delivery expectation, from the dates the records DO hold ────
  const deliveryDetail = new Map();  // group → { key, expectedDate, dateSource, datedCount, undatedCount }
  for (const l of recon.lines) {
    if (!(l.pendingQty > TOL)) continue;
    const meta = lineMetaById.get(String(l.poItemId));
    if (isLineCancelled(l.poItemId)) continue;   // suppress the expectation cancellation ended
    const exp = outstandingExpectation({ lineExpectedDate: meta && meta.expectedDeliveryDate, headerExpectedDate: po.expectedDeliveryDate, asOf });
    addLine(exp.group, l.poItemId);
    const d = deliveryDetail.get(exp.group) || { key: null, expectedDate: null, dateSource: null, datedCount: 0, undatedCount: 0 };
    if (exp.undated) d.undatedCount += 1;
    else {
      d.datedCount += 1;
      const k = dayKey(exp.expectedDate);
      if (d.key === null || k < d.key) { d.key = k; d.expectedDate = exp.expectedDate; d.dateSource = exp.dateSource; }
    }
    deliveryDetail.set(exp.group, d);
  }

  const present = new Set([...lineSets.keys(), ...occ.keys()]);
  const exceptions = [...present].map((g) => {
    const lineCount = lineSets.has(g) ? lineSets.get(g).size : 0;
    const occCount = occ.get(g) || 0;
    const entry = {
      group: g,
      label: GROUPS[g].label,
      severity: GROUPS[g].severity,
      nextAction: GROUPS[g].nextAction,
      count: lineCount + occCount,   // affected lines + order-level occurrences
    };
    // Delivery groups expose the chosen date, its source, and how many lines
    // carry no recorded expected date at all.
    const dd = deliveryDetail.get(g);
    if (dd) {
      entry.expectedDate = dd.expectedDate ? dd.expectedDate.toISOString() : null;
      entry.dateSource = dd.dateSource;               // "line" | "header" | null
      entry.datedCount = dd.datedCount;
      entry.undatedCount = dd.undatedCount;
    }
    return entry;
  }).sort((a, b) => b.severity - a.severity || a.label.localeCompare(b.label));

  // Affected LINES = the union of every line-scoped issue (order-level issues
  // like a missing request are not a "line" and are not counted here).
  const affectedLines = new Set();
  for (const set of lineSets.values()) for (const id of set) affectedLines.add(id);

  const severity = exceptions.reduce((m, e) => Math.max(m, e.severity), 0);

  const lastActivity = maxDate([
    po.orderDate, po.updatedAt,
    ...(po.deliveries || []).map((d) => d.deliveryDate || d.createdAt),
    ...(vouchers || []).map((v) => v.voucherDate),
  ]);

  // The PurchaseOrder stores no per-order currency, so none is invented here.
  // Amounts are recorded figures; whether they carry a currency (the company
  // base) or must be shown as "currency not recorded" is decided once, at the
  // register level, from the company record.
  return {
    poId: recon.purchaseOrder.id,
    poNumber: recon.purchaseOrder.number,
    supplierName: recon.purchaseOrder.vendorName || "",
    vendorId: po.vendor ? String(po.vendor._id || po.vendor) : null,
    status: recon.purchaseOrder.status || "",
    orderDate: po.orderDate || null,
    requestId: recon.source.request ? recon.source.request.id : null,
    requestNumber: recon.source.request ? recon.source.request.number : (po.spendRequestNumber || ""),
    severity,
    exceptions,
    exceptionCount: exceptions.length,
    affectedLineCount: affectedLines.size,
    lineCount: recon.summary.lineCount,
    totals: {
      ordered: recon.summary.orderedTotal,
      billedLive: recon.summary.billedLive,
      posted: recon.summary.posted,
    },
    lastActivity,
    reconciliationHref: (links.reconciliation || defaultReconciliationHref)(recon.purchaseOrder.id),
  };
}

/**
 * Build every register row from an already-loaded page of POs and the three
 * batched joins. Constant query cost — the joins are Maps, not per-PO reads.
 */
function buildExceptionsRegister({ purchaseOrders = [], spendRequestsById = new Map(), commitmentsByRequestId = new Map(), vouchersByPoId = new Map(), goodsReceiptsByPoId = new Map(), inspectionsByPoId = new Map(), dispositionsByPoId = new Map(), links = {}, asOf = new Date() } = {}) {
  return purchaseOrders.map((po) => {
    const key = po.spendRequestId ? String(po.spendRequestId) : null;
    const spendRequest = key ? (spendRequestsById.get(key) || null) : null;
    const commitment = key ? (commitmentsByRequestId.get(key) || null) : null;
    const vouchers = vouchersByPoId.get(String(po._id)) || [];
    const goodsReceipts = goodsReceiptsByPoId.get(String(po._id)) || [];
    const inspections = inspectionsByPoId.get(String(po._id)) || [];
    const dispositions = dispositionsByPoId.get(String(po._id)) || [];
    const recon = buildReconciliation({ purchaseOrder: po, spendRequest, commitment, vouchers, goodsReceipts, inspections, dispositions, links });
    return registerRow(po, recon, vouchers, links, asOf);
  });
}

// ── Derived filters (only knowable AFTER reconciliation) ─────────────────────
function filterRows(rows, { group = null, unresolvedOnly = true } = {}) {
  return rows.filter((r) => {
    if (unresolvedOnly && r.exceptionCount === 0) return false;
    if (group && !r.exceptions.some((e) => e.group === group)) return false;
    return true;
  });
}

// ── Default ordering: severity desc → oldest activity → PO number ────────────
function sortRows(rows) {
  return [...rows].sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    const at = a.lastActivity ? new Date(a.lastActivity).getTime() : Infinity;   // no activity sorts last
    const bt = b.lastActivity ? new Date(b.lastActivity).getTime() : Infinity;
    if (at !== bt) return at - bt;                                               // oldest first
    return String(a.poNumber).localeCompare(String(b.poNumber));                // stable tie-break
  });
}

function paginate(rows, { page = 1, pageSize = 25 } = {}) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), totalPages);
  const start = (p - 1) * pageSize;
  return { page: p, pageSize, total, totalPages, rows: rows.slice(start, start + pageSize) };
}

// ── Summary cards — counts of ORDERS, never unlike quantities added together ─
// `currency` describes the company base currency and its provenance; a cross-
// order money total is produced ONLY when that currency is known, and is
// otherwise withheld with a stated reason (no currency is invented).
function summarize(rows, { currency = null, currencyBasis = "not_recorded", currencySymbol = null } = {}) {
  const withGroup = (g) => rows.filter((r) => r.exceptions.some((e) => e.group === g)).length;
  const financial = rows.filter((r) => r.exceptions.some((e) => ["PRICE_VARIANCE", "TAX_VARIANCE", "CHARGE_VARIANCE", "QTY_VARIANCE", "BILL_OVER_RECEIVED", "BILL_OVER_ACCEPTED"].includes(e.group))).length;

  const currencyKnown = currencyBasis === "company_base_currency" && Boolean(currency);
  let total = null;
  if (currencyKnown) {
    total = { currency, ordered: 0, billedLive: 0, posted: 0, orders: rows.length };
    for (const r of rows) {
      total.ordered = Math.round((total.ordered + (r.totals.ordered || 0)) * 100) / 100;
      total.billedLive = Math.round((total.billedLive + (r.totals.billedLive || 0)) * 100) / 100;
      total.posted = Math.round((total.posted + (r.totals.posted || 0)) * 100) / 100;
    }
  }

  return {
    ordersNeedingAttention: rows.filter((r) => r.exceptionCount > 0).length,
    pastExpectedDelivery: withGroup("PAST_EXPECTED_DELIVERY"),
    stillToReceive: withGroup("STILL_TO_RECEIVE"),
    awaitingInspection: withGroup("AWAITING_INSPECTION"),
    quarantineUnresolved: withGroup("QUARANTINE_UNRESOLVED"),
    receivedNoBill: withGroup("RECEIVED_NO_BILL"),
    billedAboveAccepted: withGroup("BILL_OVER_ACCEPTED"),
    billsAwaitingPosting: withGroup("BILL_AWAITING_POSTING"),
    financialVariances: financial,
    budgetReleaseExceptions: withGroup("COMMITMENT_NOT_RELEASED"),
    currency: currencyKnown ? currency : null,
    currencyBasis,
    currencySymbol: currencyKnown ? currencySymbol : null,
    total,                                   // one company-currency total, or null
    aggregateAvailable: currencyKnown,
    aggregateUnavailableReason: currencyKnown ? null : "Order currency is not recorded, so amounts cannot be totalled across orders.",
  };
}

module.exports = {
  buildExceptionsRegister, registerRow,
  filterRows, sortRows, paginate, summarize,
  outstandingExpectation, dayKey,
  GROUPS, SEVERITY, TOL, EXPECTATION_GROUPS,
};
