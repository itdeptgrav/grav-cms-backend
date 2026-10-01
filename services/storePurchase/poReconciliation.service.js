// services/storePurchase/poReconciliation.service.js
//
// PURCHASE THREE-WAY MATCH — order / accepted-receipt / bill reconciliation, read only.
//
// ── WHAT THIS IS ────────────────────────────────────────────────────────────
// It answers, for ONE purchase order: what was approved & committed, ordered,
// received, ACCEPTED at inspection, billed, posted and paid — and where the
// recorded figures disagree. The quantity match is against the ACCEPTED quantity
// from the immutable Goods Receipt inspection line, NOT the mere received
// quantity: goods arriving is not goods passing inspection. A receipt with no
// inspection is "Received, awaiting inspection", never "accepted zero", and no
// three-way match is available for that quantity. It writes nothing.
//
// ── EVERY JOIN IS BY A STORED ID ────────────────────────────────────────────
// PO → SpendRequest via `spendRequestId`; SpendRequest → BudgetCommitment via
// `spendRequestId`; a PO line → its commitment allocation & request line via
// `spendLineId`; PO → purchase vouchers via `purchaseOrderId`; a voucher entry →
// a PO line via `poItemId` (primary) then `spendLineId` (secondary, only when it
// maps to exactly one PO line); a GoodsReceipt/inspection/disposition line → a PO
// line via the stored `poItemId`; a GRN → its inspection via `goodsReceiptId`.
// Nothing is matched by amount, item name, array position or supplier name.
//
// ── UNIT DISCIPLINE ─────────────────────────────────────────────────────────
// Every quantity comparison is within ONE line's own business unit. If the
// ordered / received / accepted / billed units for a line are not all the same,
// the line shows "Unit comparison unavailable" and no quantity match is claimed.
// Quantities are NEVER totalled across unlike units.
//
// PURE — handed already-fetched lean documents, returns the reconciliation.

"use strict";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

// Live vouchers count as real; cancelled/void are history only.
const LIVE_VOUCHER = new Set(["draft", "pending_approval", "posted"]);
const IN_PROGRESS = new Set(["draft", "pending_approval"]);
const normUnit = (u) => String(u || "").trim().toLowerCase();

const STATUS = Object.freeze({
  AWAITING_RECEIPT: "Awaiting receipt",
  PARTLY_RECEIVED: "Partly received",
  RECEIVED_AWAITING_INSPECTION: "Received, awaiting inspection",
  PARTLY_ACCEPTED: "Partly accepted",
  ACCEPTED_AWAITING_BILL: "Accepted, awaiting bill",
  BILL_AWAITING_POSTING: "Bill recorded, awaiting posting",
  THREE_WAY_MATCHED: "Three-way matched",
  QTY_VARIANCE: "Quantity variance",
  RATE_VARIANCE: "Rate variance",
  GST_VARIANCE: "GST variance",
  CHARGES_VARIANCE: "Charges variance",
  OVER_RECEIVED: "Over-received",
  BILLED_ABOVE_ACCEPTED: "Billed above accepted quantity",
  QUARANTINE_UNRESOLVED: "Quarantined quantity unresolved",
  REJECTED_RECORDED: "Rejected quantity recorded",
  UNLINKED_BILL: "Unlinked bill line",
  BUDGET_ALLOCATION_UNAVAILABLE: "Budget allocation unavailable",
  LEGACY_EVIDENCE_INCOMPLETE: "Legacy evidence incomplete",
  UNIT_COMPARISON_UNAVAILABLE: "Unit comparison unavailable",
});

// A tolerance used only as the displayed comparison default. It blocks nothing.
const TOL = 0.01;

/**
 * Build the three-way reconciliation for one purchase order.
 *
 * @param {object}   purchaseOrder  lean PO (items[], deliveries[], header charges)
 * @param {object?}  spendRequest   lean SpendRequest via spendRequestId
 * @param {object?}  commitment     lean Acc_BudgetCommitment via spendRequestId
 * @param {object[]} vouchers       lean purchase vouchers via purchaseOrderId
 * @param {object[]} goodsReceipts  lean GoodsReceipt docs (per-line received evidence)
 * @param {object[]} inspections    lean GoodsReceiptInspection docs (immutable accepted/quarantined/rejected)
 * @param {object[]} dispositions   lean GoodsReceiptDisposition docs (quarantine resolution)
 * @param {object}   [links]        href builders for the UI
 */
function buildReconciliation({ purchaseOrder: po, spendRequest = null, commitment = null, vouchers = [], goodsReceipts = [], inspections = [], dispositions = [], links = {} } = {}) {
  const poId = String(po._id);
  const items = Array.isArray(po.items) ? po.items : [];
  const allVouchers = Array.isArray(vouchers) ? vouchers : [];

  // ── Received evidence — GoodsReceipt lines, joined by stored `poItemId`. A
  //    voided receipt is history, not live evidence. Track each line's unit so a
  //    unit mismatch can be detected. ────────────────────────────────────────
  const grnList = Array.isArray(goodsReceipts) ? goodsReceipts : [];
  const nonVoidGrnIds = new Set(grnList.filter((g) => g.status !== "VOID").map((g) => String(g._id)));
  const grnByPoItem = new Map();   // poItemId → { received, grnNumbers:Set, grnIds:Map(number→id), units:Set }
  for (const g of grnList) {
    if (g.status === "VOID") continue;
    for (const gl of (g.lines || [])) {
      if (gl.poItemId == null) continue;
      const k = String(gl.poItemId);
      const acc = grnByPoItem.get(k) || { received: 0, grnNumbers: new Set(), grnIds: new Map(), units: new Set() };
      acc.received = r4(acc.received + (Number(gl.receivedQuantity) || 0));
      if (g.receiptNumber) { acc.grnNumbers.add(g.receiptNumber); acc.grnIds.set(g.receiptNumber, String(g._id)); }
      if (gl.poUnit) acc.units.add(normUnit(gl.poUnit));
      grnByPoItem.set(k, acc);
    }
  }

  // ── Accepted evidence — the IMMUTABLE inspection line, joined by `poItemId`,
  //    only for inspections whose GoodsReceipt is non-void. Accepted +
  //    quarantined + rejected sum to the inspected received quantity. ─────────
  const inspByPoItem = new Map();  // poItemId → { accepted, quarantined, rejected, inspectedReceived, units:Set }
  for (const insp of (Array.isArray(inspections) ? inspections : [])) {
    if (insp.goodsReceiptId != null && !nonVoidGrnIds.has(String(insp.goodsReceiptId))) continue;
    for (const il of (insp.lines || [])) {
      if (il.poItemId == null) continue;
      const k = String(il.poItemId);
      const acc = inspByPoItem.get(k) || { accepted: 0, quarantined: 0, rejected: 0, inspectedReceived: 0, units: new Set() };
      acc.accepted = r4(acc.accepted + (Number(il.acceptedQuantity) || 0));
      acc.quarantined = r4(acc.quarantined + (Number(il.quarantinedQuantity) || 0));
      acc.rejected = r4(acc.rejected + (Number(il.rejectedQuantity) || 0));
      acc.inspectedReceived = r4(acc.inspectedReceived + (Number(il.receivedQuantity) || 0));
      if (il.unit) acc.units.add(normUnit(il.unit));
      inspByPoItem.set(k, acc);
    }
  }

  // ── Quarantine resolution — RELEASE/REJECT dispositions, by `poItemId`, for
  //    non-void GRNs. Unresolved quarantine = quarantined − resolved. ─────────
  const resolvedQuarByPoItem = new Map();
  for (const d of (Array.isArray(dispositions) ? dispositions : [])) {
    if (d.goodsReceiptId != null && !nonVoidGrnIds.has(String(d.goodsReceiptId))) continue;
    if (d.poItemId == null) continue;
    const k = String(d.poItemId);
    resolvedQuarByPoItem.set(k, r4((resolvedQuarByPoItem.get(k) || 0) + (Number(d.quantity) || 0)));
  }

  // ── Commitment allocations & request lines, indexed by spendLineId ─────────
  const allocByLine = new Map();
  for (const a of (commitment?.allocations || [])) {
    if (a.spendLineId != null) allocByLine.set(String(a.spendLineId), a);
  }
  const srLineById = new Map();
  for (const l of (spendRequest?.items || [])) {
    if (l._id != null) srLineById.set(String(l._id), l);
  }

  // ── Voucher entries → PO line, by stored id (poItemId primary, spendLineId
  //    secondary when unambiguous). PRODUCT entries and CHARGE entries (isCharge)
  //    are kept apart: charges never inflate the product quantity/rate match. ──
  const poItemIds = new Set(items.map((l) => String(l._id)));
  const spendLinePoCount = new Map();
  for (const l of items) {
    const s = l.spendLineId != null ? String(l.spendLineId) : null;
    if (s) spendLinePoCount.set(s, (spendLinePoCount.get(s) || 0) + 1);
  }
  const uniquePoLineBySpendLine = new Map();
  for (const l of items) {
    const s = l.spendLineId != null ? String(l.spendLineId) : null;
    if (s && spendLinePoCount.get(s) === 1) uniquePoLineBySpendLine.set(s, String(l._id));
  }

  const resolveTarget = (ePoItem, eSpendLine) => {
    if (ePoItem && poItemIds.has(ePoItem)) return { targetPoItem: ePoItem, matchedBy: "poItemId" };
    if (eSpendLine && uniquePoLineBySpendLine.has(eSpendLine)) return { targetPoItem: uniquePoLineBySpendLine.get(eSpendLine), matchedBy: "spendLineId" };
    return { targetPoItem: null, matchedBy: null };
  };

  const entriesByPoItem = new Map();      // product entries per PO line
  const chargeByPoItem = new Map();       // Σ line-level charge amount per PO line
  const orderLevelBilledCharges = [];     // charge lines with no PO line (order-level)
  const unlinkedVoucherLines = [];        // product lines that match no PO line
  for (const v of allVouchers) {
    const isLive = LIVE_VOUCHER.has(v.status);
    for (const e of (v.inventoryEntries || [])) {
      const ePoItem = e.poItemId != null ? String(e.poItemId) : null;
      const eSpendLine = e.spendLineId != null ? String(e.spendLineId) : null;
      const { targetPoItem, matchedBy } = resolveTarget(ePoItem, eSpendLine);

      if (e.isCharge) {
        // A charge is a non-stock line. Attached to a PO line by stored id → a
        // line charge; otherwise an ORDER-LEVEL charge, shown separately (never
        // spread across lines to make totals reconcile, never an "unlinked bill").
        const chargeRow = {
          voucherId: String(v._id), voucherNumber: v.voucherNumber || "", voucherStatus: v.status, isLive,
          description: e.chargeDescription || "", amount: r2(Number(e.amount) || 0), taxAmount: r2(Number(e.taxAmount) || 0),
          poItemId: ePoItem, href: links.voucher ? links.voucher(String(v._id)) : null,
        };
        if (targetPoItem && isLive) {
          chargeByPoItem.set(targetPoItem, r2((chargeByPoItem.get(targetPoItem) || 0) + chargeRow.amount));
        } else if (isLive) {
          orderLevelBilledCharges.push(chargeRow);
        }
        continue;
      }

      const row = {
        voucherId: String(v._id), voucherNumber: v.voucherNumber || "",
        voucherStatus: v.status, isLive, isPosted: v.status === "posted",
        referenceNumber: v.referenceNumber || "", voucherDate: v.voucherDate || null,
        poItemId: ePoItem, spendLineId: eSpendLine, matchedBy,
        unit: e.unit || "",
        quantity: Number(e.quantity) || 0, rate: Number(e.rate) || 0,
        amount: Number(e.amount) || 0, taxAmount: Number(e.taxAmount) || 0, taxRate: Number(e.taxRate) || 0,
        href: links.voucher ? links.voucher(String(v._id)) : null,
      };
      if (targetPoItem) {
        if (!entriesByPoItem.has(targetPoItem)) entriesByPoItem.set(targetPoItem, []);
        entriesByPoItem.get(targetPoItem).push(row);
      } else {
        row.unlinkedReason = eSpendLine && spendLinePoCount.get(eSpendLine) > 1
          ? "ambiguous_spend_line"
          : ePoItem ? "stale_po_item"
            : eSpendLine ? "unknown_spend_line" : "no_line_id";
        unlinkedVoucherLines.push(row);
      }
    }
  }

  // ── Per-line reconciliation ────────────────────────────────────────────────
  const lines = items.map((l) => {
    const poItemId = String(l._id);
    const spendLineId = l.spendLineId != null ? String(l.spendLineId) : null;
    const alloc = spendLineId ? allocByLine.get(spendLineId) || null : null;
    const srLine = spendLineId ? srLineById.get(spendLineId) || null : null;

    // Ordered
    const orderedQty = Number(l.quantity) || 0;
    const orderUnit = l.unit || "";
    const unitPrice = Number(l.unitPrice) || 0;
    const netAmount = Number(l.totalPrice) || 0;
    const gstRate = Number(l.gstRate) || 0;
    const gstAmount = Number(l.gstAmount) || 0;
    const orderedCharges = r2(Number(l.itemChargesTotal) || 0);
    const hasOrderedLineCharge = (Array.isArray(l.itemCharges) && l.itemCharges.length > 0) || orderedCharges > TOL;
    const orderedTotal = r2(netAmount + gstAmount + orderedCharges);

    // Received (recorded, per line) — GRN evidence when present, else the PO
    // line's stored aggregate (legacy order-level deliveries).
    const grnEvidence = grnByPoItem.get(poItemId) || null;
    const receivedSource = grnEvidence ? "goods_receipt" : "legacy_aggregate";
    const receivedQty = grnEvidence ? grnEvidence.received : (Number(l.receivedQuantity) || 0);
    const grnNumbers = grnEvidence ? [...grnEvidence.grnNumbers] : [];
    const grnIds = grnEvidence ? grnNumbers.map((n) => grnEvidence.grnIds.get(n) || null) : [];
    const pendingQty = grnEvidence
      ? r4(Math.max(0, orderedQty - receivedQty))
      : (l.pendingQuantity != null ? Number(l.pendingQuantity) : r4(Math.max(0, orderedQty - receivedQty)));
    const overReceivedQty = r4(Math.max(0, receivedQty - orderedQty));

    // Accepted (immutable inspection) — the billing-eligible quantity.
    const insp = inspByPoItem.get(poItemId) || null;
    const hasInspection = Boolean(insp);
    const acceptedQty = insp ? insp.accepted : 0;
    const quarantinedQty = insp ? insp.quarantined : 0;
    const rejectedQty = insp ? insp.rejected : 0;
    const inspectedReceived = insp ? insp.inspectedReceived : 0;
    // Anything received but not yet reconciled by an inspection line.
    const uninspectedQty = r4(Math.max(0, receivedQty - inspectedReceived));
    const resolvedQuarantine = r4(resolvedQuarByPoItem.get(poItemId) || 0);
    const unresolvedQuarantine = r4(Math.max(0, quarantinedQty - resolvedQuarantine));

    // Unit comparability — ordered vs every received/accepted unit seen.
    const unitsSeen = new Set([orderUnit, ...(grnEvidence ? grnEvidence.units : []), ...(insp ? insp.units : [])].map(normUnit).filter(Boolean));
    const unitComparable = unitsSeen.size <= 1;

    // Billed — LIVE product vouchers only; posted vs in-progress kept apart.
    const entries = entriesByPoItem.get(poItemId) || [];
    const live = entries.filter((e) => e.isLive);
    const billedQty = r4(live.reduce((t, e) => t + e.quantity, 0));
    const billedNet = r2(live.reduce((t, e) => t + e.amount, 0));
    const billedTax = r2(live.reduce((t, e) => t + e.taxAmount, 0));
    const billedTotal = r2(billedNet + billedTax);
    const billedRate = billedQty > TOL ? r4(billedNet / billedQty) : null;
    const postedEntries = live.filter((e) => e.isPosted);
    const postedQty = r4(postedEntries.reduce((t, e) => t + e.quantity, 0));
    const postedNet = r2(postedEntries.reduce((t, e) => t + e.amount + e.taxAmount, 0));
    const inProgressNet = r2(live.filter((e) => IN_PROGRESS.has(e.voucherStatus)).reduce((t, e) => t + e.amount + e.taxAmount, 0));
    const postedFully = billedQty > TOL && Math.abs(postedQty - billedQty) <= TOL;

    // Billed line charges — compared ONLY where both sides carry genuine
    // line-level charge evidence; never fabricated from a header charge.
    const billedLineCharge = chargeByPoItem.has(poItemId) ? r2(chargeByPoItem.get(poItemId)) : null;
    const hasBilledLineCharge = billedLineCharge != null;
    let chargeComparison;
    if (hasOrderedLineCharge && hasBilledLineCharge) {
      chargeComparison = { comparable: true, orderedCharges, billedCharges: billedLineCharge, diff: r2(billedLineCharge - orderedCharges), missing: null };
    } else if (hasOrderedLineCharge || hasBilledLineCharge) {
      chargeComparison = { comparable: false, orderedCharges: hasOrderedLineCharge ? orderedCharges : null, billedCharges: hasBilledLineCharge ? billedLineCharge : null, missing: hasOrderedLineCharge ? "billed_line_charge" : "ordered_line_charge" };
    } else {
      chargeComparison = { comparable: false, orderedCharges: 0, billedCharges: null, missing: null };  // nothing to compare
    }

    // Approved / committed
    const approvedLineAmount = srLine ? r2(srLine.amount) : null;
    const committedAmount = alloc ? r2(alloc.amount) : null;
    const releasedAmount = alloc ? r2(alloc.releasedAmount) : null;
    const commitmentRemaining = alloc
      ? r2(alloc.remainingAmount != null ? alloc.remainingAmount : (alloc.amount - (alloc.releasedAmount || 0)))
      : null;
    const unbudgeted = alloc ? alloc.status === "unbudgeted" : false;

    // GST is compared against the ordered RATE applied to the BILLED net — so a
    // partial bill is not flagged merely because it carries less tax than the
    // whole order. Comparable when either side records GST (so a bill that adds
    // GST to a GST-free line, or drops it, is still surfaced).
    const gstComparable = gstRate > 0 || gstAmount > 0 || billedTax > TOL;
    const expectedTaxOnBilled = r2(billedNet * (gstRate / 100));
    // Variances — each stated separately, never merged. Quantity is compared ONLY
    // when units are comparable.
    const variances = {
      orderVsReceivedQty: unitComparable ? r4(orderedQty - receivedQty) : null,
      acceptedVsBilledQty: unitComparable && (billedQty > 0 || acceptedQty > 0) ? r4(acceptedQty - billedQty) : null,
      rateDiff: unitComparable && billedRate != null ? r4(billedRate - unitPrice) : null,
      gstDiff: (gstComparable && billedQty > TOL) ? r2(billedTax - expectedTaxOnBilled) : null,
      chargesDiff: chargeComparison.comparable ? chargeComparison.diff : null,
      orderedVsBilledTotal: r2(orderedTotal - billedTotal),
      commitmentVsPosted: alloc ? r2((alloc.amount || 0) - postedNet) : null,
    };

    // ── Honest statuses — an ARRAY, so several truths show at once ────────────
    const statuses = [];
    if (!spendLineId) statuses.push(STATUS.LEGACY_EVIDENCE_INCOMPLETE);
    if (unbudgeted) statuses.push(STATUS.BUDGET_ALLOCATION_UNAVAILABLE);
    if (overReceivedQty > TOL) statuses.push(STATUS.OVER_RECEIVED);

    if (receivedQty <= TOL) {
      statuses.push(STATUS.AWAITING_RECEIPT);
    } else {
      if (receivedQty + TOL < orderedQty) statuses.push(STATUS.PARTLY_RECEIVED);
      if (uninspectedQty > TOL) statuses.push(STATUS.RECEIVED_AWAITING_INSPECTION);
      if (hasInspection && acceptedQty > TOL && (quarantinedQty + rejectedQty) > TOL) statuses.push(STATUS.PARTLY_ACCEPTED);
    }
    if (unresolvedQuarantine > TOL) statuses.push(STATUS.QUARANTINE_UNRESOLVED);
    if (rejectedQty > TOL) statuses.push(STATUS.REJECTED_RECORDED);
    if (!unitComparable) statuses.push(STATUS.UNIT_COMPARISON_UNAVAILABLE);

    if (billedQty <= TOL) {
      // Accepted stock awaits a bill only once receiving is complete — a line still
      // taking deliveries reads as "Partly received", not "awaiting bill".
      if (acceptedQty > TOL && pendingQty <= TOL) statuses.push(STATUS.ACCEPTED_AWAITING_BILL);
    } else {
      if (unitComparable) {
        if (billedQty > acceptedQty + TOL) statuses.push(STATUS.BILLED_ABOVE_ACCEPTED);
        else if (Math.abs(acceptedQty - billedQty) > TOL) statuses.push(STATUS.QTY_VARIANCE);
        if (variances.rateDiff != null && Math.abs(variances.rateDiff) > TOL) statuses.push(STATUS.RATE_VARIANCE);
        if (variances.gstDiff != null && Math.abs(variances.gstDiff) > TOL) statuses.push(STATUS.GST_VARIANCE);
        if (chargeComparison.comparable && Math.abs(chargeComparison.diff) > TOL) statuses.push(STATUS.CHARGES_VARIANCE);
      }
      if (!postedFully) statuses.push(STATUS.BILL_AWAITING_POSTING);
    }

    // ── THREE-WAY MATCHED — allowed only when the whole chain agrees ──────────
    const threeWayMatched = Boolean(
      unitComparable && spendLineId && !unbudgeted
      && receivedQty > TOL && overReceivedQty <= TOL
      && uninspectedQty <= TOL              // no relevant receipt remains uninspected
      && unresolvedQuarantine <= TOL        // no quarantined quantity left unresolved
      && billedQty > TOL
      && Math.abs(acceptedQty - billedQty) <= TOL         // accepted == live billed
      && billedRate != null && Math.abs(billedRate - unitPrice) <= TOL   // rate agrees
      && (variances.gstDiff == null || Math.abs(variances.gstDiff) <= TOL)  // GST agrees where comparable
      && (!chargeComparison.comparable || Math.abs(chargeComparison.diff) <= TOL)  // charges agree where comparable
      && postedFully,                        // the bill is posted
    );
    if (threeWayMatched) statuses.push(STATUS.THREE_WAY_MATCHED);

    return {
      poItemId,
      spendLineId,
      // Approved/committed
      requestNumber: spendRequest?.requestNumber || null,
      spendLine: spendLineId,
      budgetHead: alloc ? { ledgerId: alloc.ledgerId ? String(alloc.ledgerId) : null, ledgerName: alloc.ledgerName || "", href: alloc.ledgerId && links.budgetHead ? links.budgetHead(String(alloc.ledgerId)) : null } : null,
      plannedItem: alloc?.name || srLine?.name || null,
      approvedLineAmount, committedAmount, releasedAmount, commitmentRemaining,
      unbudgeted,
      unbudgetedReason: unbudgeted ? (alloc?.resolutionReason || "") : "",
      allocationStatus: alloc?.status || null,
      hasAllocation: Boolean(alloc),
      // Ordered
      item: {
        rawItemId: l.rawItem ? String(l.rawItem._id || l.rawItem) : null,
        name: l.itemName || (l.rawItem && l.rawItem.name) || "",
        sku: l.sku || (l.rawItem && l.rawItem.sku) || "",
        variantId: l.variantId ? String(l.variantId) : null,
        variantName: l.variantName || "",
        variantSku: l.variantSku || "",
      },
      orderedQty, uom: orderUnit, unitPrice, netAmount, gstRate, gstAmount, chargesTotal: orderedCharges, orderedTotal,
      // Received (recorded quantity — NOT an acceptance decision)
      receivedQty, pendingQty, overReceivedQty, receivedSource, grnNumbers, grnIds,
      // Accepted (the IMMUTABLE inspection decision — the billing-eligible quantity)
      acceptedQty, quarantinedQty, rejectedQty, uninspectedQty, inspectedReceived,
      resolvedQuarantine, unresolvedQuarantine, hasInspection,
      unitComparable, unitEvidence: [...unitsSeen],
      // Billed
      billed: {
        qty: billedQty, rate: billedRate, net: billedNet, tax: billedTax, total: billedTotal,
        posted: postedNet, postedQty, inProgress: inProgressNet, postedFully,
        lineCharges: billedLineCharge,
        vouchers: entries.map((e) => ({
          voucherId: e.voucherId, voucherNumber: e.voucherNumber, status: e.voucherStatus,
          isLive: e.isLive, referenceNumber: e.referenceNumber, voucherDate: e.voucherDate,
          qty: e.quantity, rate: e.rate, net: e.amount, tax: e.taxAmount, total: r2(e.amount + e.taxAmount),
          matchedBy: e.matchedBy, href: e.href,
        })),
      },
      charges: chargeComparison,
      variances,
      statuses,
      threeWayMatched,
    };
  });

  // ── Source & budget: one entry per budget HEAD (multi-head safe) ───────────
  const headMap = new Map();
  for (const a of (commitment?.allocations || [])) {
    const key = a.ledgerId ? String(a.ledgerId) : (a.status === "unbudgeted" ? "__unbudgeted__" : "__none__");
    const row = headMap.get(key) || {
      ledgerId: a.ledgerId ? String(a.ledgerId) : null,
      ledgerName: a.ledgerName || (a.status === "unbudgeted" ? "Unbudgeted" : ""),
      committed: 0, released: 0, remaining: 0, unbudgeted: a.status === "unbudgeted",
      href: a.ledgerId && links.budgetHead ? links.budgetHead(String(a.ledgerId)) : null,
    };
    row.committed = r2(row.committed + (a.amount || 0));
    row.released = r2(row.released + (a.releasedAmount || 0));
    row.remaining = r2(row.remaining + (a.remainingAmount != null ? a.remainingAmount : (a.amount - (a.releasedAmount || 0))));
    headMap.set(key, row);
  }

  // ── Receipt evidence (compatibility summary of the authoritative GRNs) ─────
  const receipts = (po.deliveries || []).map((d) => ({
    deliveryDate: d.deliveryDate || d.createdAt || null,
    quantityReceived: Number(d.quantityReceived) || 0,
    invoiceNumber: d.invoiceNumber || "",
    receivedByName: (d.receivedBy && (d.receivedBy.name || d.receivedBy)) ? (d.receivedBy.name || "") : "",
    notes: d.notes || "",
    goodsReceiptId: d.goodsReceiptId ? String(d.goodsReceiptId) : null,
    goodsReceiptNumber: d.goodsReceiptNumber || "",
    isLegacy: !d.goodsReceiptId,
  }));
  const hasLegacyDeliveries = receipts.some((r) => r.isLegacy);
  const goodsReceiptNumbers = [...new Set([...grnByPoItem.values()].flatMap((g) => [...g.grnNumbers]))];

  // ── Bills — the Accounting purchase vouchers themselves. BILL status (draft /
  //    pending / posted) is distinct from PAYMENT: settlement is a separate
  //    payment voucher owned by Accounting and is never inferred here. ─────────
  const bills = allVouchers.map((v) => ({
    voucherId: String(v._id), voucherNumber: v.voucherNumber || "",
    billStatus: v.status,                    // draft | pending_approval | posted | cancelled | void
    isPosted: v.status === "posted", isLive: LIVE_VOUCHER.has(v.status),
    referenceNumber: v.referenceNumber || "", voucherDate: v.voucherDate || null,
    grandTotal: r2(v.grandTotal),
    href: links.voucher ? links.voucher(String(v._id)) : null,
  }));
  const billsSummary = {
    total: bills.length,
    posted: bills.filter((b) => b.isPosted).length,
    inProgress: bills.filter((b) => IN_PROGRESS.has(b.billStatus)).length,
    postedTotal: r2(bills.filter((b) => b.isPosted).reduce((t, b) => t + b.grandTotal, 0)),
    // Payment (settlement) is owned by Accounting via payment vouchers — this
    // read-only reconciliation reports the BILL state, not a paid figure.
    paymentOwnedByAccounting: true,
  };

  // ── Order-level charges — header charges are shown SEPARATELY and never
  //    distributed across lines to make a total reconcile. ────────────────────
  const orderedHeaderCharges = [];
  if (Number(po.shippingCharges) > TOL) orderedHeaderCharges.push({ label: "Shipping", amount: r2(po.shippingCharges) });
  for (const c of (po.customCharges || [])) if (Number(c.amount) > TOL) orderedHeaderCharges.push({ label: c.label || "Charge", amount: r2(c.amount) });
  const orderCharges = {
    ordered: orderedHeaderCharges,
    orderedTotal: r2(orderedHeaderCharges.reduce((t, c) => t + c.amount, 0)),
    billed: orderLevelBilledCharges.map((c) => ({ description: c.description, amount: c.amount, tax: c.taxAmount, voucherNumber: c.voucherNumber, href: c.href })),
    billedTotal: r2(orderLevelBilledCharges.reduce((t, c) => t + c.amount, 0)),
    // Header charges cannot be matched to lines; a comparison is not claimed.
    comparable: false,
    note: "Order-level charges are shown separately and are never distributed across lines.",
  };

  // ── Summary — money totalled; quantities NEVER summed across unlike units ──
  const summary = {
    orderedTotal: r2(lines.reduce((t, l) => t + l.orderedTotal, 0)),
    billedLive: r2(lines.reduce((t, l) => t + l.billed.total, 0)),
    posted: r2(lines.reduce((t, l) => t + l.billed.posted, 0)),
    inProgress: r2(lines.reduce((t, l) => t + l.billed.inProgress, 0)),
    committed: r2([...headMap.values()].reduce((t, h) => t + h.committed, 0)),
    released: r2([...headMap.values()].reduce((t, h) => t + h.released, 0)),
    commitmentRemaining: r2([...headMap.values()].reduce((t, h) => t + h.remaining, 0)),
    // Budget "actual" is posted vouchers alone — never a draft/pending promise.
    budgetActual: r2(lines.reduce((t, l) => t + l.billed.posted, 0)),
    lineCount: lines.length,
    threeWayMatchedCount: lines.filter((l) => l.threeWayMatched).length,
    unlinkedVoucherLineCount: unlinkedVoucherLines.length,
  };

  // ── Exceptions — ONLY actionable issues, derived from the accepted-based match
  const exceptions = [];
  if (!po.spendRequestId) exceptions.push({ code: "NO_REQUEST", message: "This order has no originating spend request — approval and budget cannot be reconciled." });
  for (const l of lines) {
    const name = l.item.name || l.spendLine || l.poItemId;
    if (l.pendingQty > TOL && l.overReceivedQty <= TOL) exceptions.push({ code: "QTY_DUE", poItemId: l.poItemId, message: `${name}: ${l.pendingQty} ${l.uom} still to receive.` });
    if (l.overReceivedQty > TOL) exceptions.push({ code: "OVER_RECEIPT", poItemId: l.poItemId, message: `${name}: ${l.overReceivedQty} ${l.uom} received over the ordered quantity.` });
    if (l.uninspectedQty > TOL) exceptions.push({ code: "AWAITING_INSPECTION", poItemId: l.poItemId, message: `${name}: ${l.uninspectedQty} ${l.uom} received but not yet inspected — no three-way match is available for it.` });
    if (l.unresolvedQuarantine > TOL) exceptions.push({ code: "QUARANTINE_UNRESOLVED", poItemId: l.poItemId, message: `${name}: ${l.unresolvedQuarantine} ${l.uom} in quarantine is unresolved.` });
    if (l.unitComparable && l.billed.qty - l.acceptedQty > TOL) exceptions.push({ code: "BILLED_ABOVE_ACCEPTED", poItemId: l.poItemId, message: `${name}: billed ${l.billed.qty} but only ${l.acceptedQty} ${l.uom} passed inspection.` });
    if (l.variances.rateDiff != null && Math.abs(l.variances.rateDiff) > TOL) exceptions.push({ code: "RATE_DIFF", poItemId: l.poItemId, message: `${name}: billed rate differs from the ordered rate by ${r4(l.variances.rateDiff)}.` });
    if (l.variances.gstDiff != null && Math.abs(l.variances.gstDiff) > TOL) exceptions.push({ code: "GST_DIFF", poItemId: l.poItemId, message: `${name}: billed GST differs from the ordered GST by ${r2(l.variances.gstDiff)}.` });
    if (l.charges.comparable && Math.abs(l.charges.diff) > TOL) exceptions.push({ code: "CHARGES_DIFF", poItemId: l.poItemId, message: `${name}: billed line charges differ from the ordered line charges by ${r2(l.charges.diff)}.` });
    // A posted bill exists but the commitment allocation cannot be released.
    if (l.billed.posted > TOL) {
      if (!l.hasAllocation) {
        exceptions.push({ code: "POSTED_UNMAPPED_ALLOCATION", poItemId: l.poItemId, message: `${name}: a bill has posted but no budget commitment allocation maps to it, so the commitment cannot be released.` });
      } else if (l.releasedAmount != null && l.releasedAmount <= TOL && !l.unbudgeted) {
        exceptions.push({ code: "COMMITMENT_NOT_RELEASED", poItemId: l.poItemId, message: `${name}: a bill has posted but its budget commitment has not been released.` });
      }
    }
  }
  for (const u of unlinkedVoucherLines) {
    if (u.isLive && u.quantity > 0) exceptions.push({ code: "UNLINKED_BILL", voucherId: u.voucherId, message: `Bill ${u.voucherNumber || ""} has a line that matches no PO line on this order.` });
  }
  const voucherRefs = new Set(allVouchers.filter((v) => LIVE_VOUCHER.has(v.status)).map((v) => String(v.referenceNumber || "").trim().toLowerCase()).filter(Boolean));
  for (const rc of receipts) {
    const ref = String(rc.invoiceNumber || "").trim();
    if (ref && !voucherRefs.has(ref.toLowerCase())) {
      exceptions.push({ code: "RECEIPT_INVOICE_NO_VOUCHER", message: `A receipt records supplier invoice "${ref}" but no accounting voucher is linked for it.` });
    }
  }

  // ── Honest limitations of the underlying records ───────────────────────────
  const limitations = [];
  if (hasLegacyDeliveries) {
    limitations.push("Some receipts predate line-level Goods Receipts and are recorded at the ORDER level only — for those the per-line received quantity is the stored aggregate, and no inspection (accepted) evidence exists. These are labelled legacy receipt records.");
  }
  limitations.push("The three-way match compares the ACCEPTED quantity from the immutable inspection line against the live billed quantity. A received quantity with no inspection is 'Received, awaiting inspection' and is not yet matchable.");
  if (lines.some((l) => !l.unitComparable)) {
    limitations.push("One or more lines record ordered, received or accepted quantities in different units, so their quantity comparison is withheld ('Unit comparison unavailable') rather than assumed equal.");
  }
  if (lines.some((l) => !l.spendLineId)) {
    limitations.push("One or more PO lines predate line-level request linkage (`spendLineId`), so their approval, budget head and commitment cannot be shown.");
  }

  return {
    purchaseOrder: {
      id: poId,
      number: po.poNumber || po.orderNumber || po.purchaseOrderNumber || po.number || "",
      status: po.status || "",
      vendorName: (po.vendor && po.vendor.companyName) || po.vendorName || "",
      spendRequestId: po.spendRequestId ? String(po.spendRequestId) : null,
      spendRequestNumber: po.spendRequestNumber || spendRequest?.requestNumber || "",
      subtotal: r2(po.subtotal), taxAmount: r2(po.taxAmount), totalAmount: r2(po.totalAmount),
    },
    source: {
      request: po.spendRequestId
        ? { id: String(po.spendRequestId), number: spendRequest?.requestNumber || po.spendRequestNumber || "", href: links.request ? links.request(String(po.spendRequestId), spendRequest) : null }
        : null,
      commitment: commitment ? { id: String(commitment._id), amount: r2(commitment.amount), status: commitment.status } : null,
      heads: [...headMap.values()],
    },
    lines,
    unlinkedVoucherLines,
    orderCharges,
    receipts,
    goodsReceiptNumbers,
    bills,
    billsSummary,
    summary,
    exceptions,
    limitations,
  };
}

module.exports = { buildReconciliation, STATUS, LIVE_VOUCHER };
