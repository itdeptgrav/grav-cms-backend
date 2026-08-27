/**
 * GRAV-CMS-BACKEND/services/partyTermsImpactOrchestrator.service.js
 *
 * The Mongo-touching half of Chunk 1-F's party-terms workflow: load a
 * company's open bills enriched with the C0-F ladder rung that dated them and
 * the protections on their sidecar rows, and aggregate that per party.
 *
 * ── WHY THIS IS A SERVICE AND NOT ROUTE-LOCAL ───────────────────────────────
 * Extracted from `Acc_partyTermsImpact.js` when Chunk 1-G's action center
 * needed the same analysis. Two copies of "which rung dated this bill, and is
 * it protected" would be two things free to drift, and the whole point of the
 * source breakdown is that one answer holds across the backfill, the forecast,
 * the cleanup workflow and now the action queue.
 *
 * READ-ONLY. Every query here is a `find`. Nothing in this file writes.
 */

const openItems = require("./openItems.service");
const backfill = require("./billTermsBackfillOrchestrator.service");
const forecastOrch = require("./cashFlowForecastOrchestrator.service");
const creditTerms = require("./creditTerms.service");
const impact = require("./partyTermsImpact.service");

/** Midnight UTC today — the reference for "is this bill already overdue". */
function today() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Every open bill of a company, enriched with the C0-F ladder rung that
 * produced its due date and the 1-C protections on its sidecar row.
 *
 * Reuses `billTermsBackfillOrchestrator`'s own resolvers and the forecast's
 * `classifySource`, so "which rung dated this" has one implementation across
 * the backfill, the forecast and this workflow.
 */
async function loadEnrichedBills(cid, ledgerIds) {
  const ledgers = await backfill.resolvePartyLedgers(cid, ledgerIds);
  const ids = ledgers.map((l) => l._id);
  if (ids.length === 0) return { ledgers: [], bills: [] };

  const [billMap, sidecar] = await Promise.all([
    openItems.billsByLedger(cid, ids),
    backfill.fetchExistingBillTerms(cid, ids),
  ]);

  const asOf = today();
  const bills = [];

  for (const b of billMap.values()) {
    if (!openItems.isOpen(b)) continue;
    const row = sidecar.get(`${b.ledgerId}||${b.billName}`) || null;
    const currentDueDate = b.dueDate || b.voucherDueDate || (row && row.dueDate) || null;
    const { source } = forecastOrch.classifySource(b, row);

    bills.push({
      ledgerId: String(b.ledgerId),
      billName: b.billName,
      amount: Math.abs(b.remaining),
      basisDate: b.firstVoucherDate || null,
      currentDueDate,
      source,
      isManualSidecar: !!(row && (row.isManual || row.source === "manual")),
      hasManualExpectedDate: !!(row && row.forecastExpectedDate),
      overdue: !!(currentDueDate && new Date(currentDueDate) < asOf),
    });
  }

  return { ledgers, bills };
}


/**
 * Per-party aggregation of default-derived exposure, clustering and
 * protections, ranked. Shared by the cleanup workflow and the action center.
 */
async function analyseParties(cid) {
  const { ledgers, bills } = await loadEnrichedBills(cid);
  const nameById = new Map(ledgers.map((l) => [String(l._id), l.name]));
  const daysById = new Map(ledgers.map((l) => [String(l._id), l.creditPeriodDays]));

  const byLedger = new Map();
  for (const b of bills) {
    if (!byLedger.has(b.ledgerId)) byLedger.set(b.ledgerId, []);
    byLedger.get(b.ledgerId).push(b);
  }

  const parties = [];
  for (const [ledgerId, rows] of byLedger) {
    const defaultDerived = rows.filter((r) => r.source === "company_default");
    const dated = rows.filter((r) => r.currentDueDate);

    const dateMap = new Map();
    for (const r of dated) {
      const k = new Date(r.currentDueDate).toISOString().slice(0, 10);
      if (!dateMap.has(k)) dateMap.set(k, { date: k, amount: 0, count: 0 });
      const e = dateMap.get(k);
      e.amount += r.amount;
      e.count += 1;
    }
    const topDates = [...dateMap.values()]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 3)
      .map((d) => ({ ...d, amount: Math.round(d.amount * 100) / 100 }));

    const times = dated.map((r) => new Date(r.currentDueDate).getTime());
    const storedDays = daysById.get(ledgerId);

    const party = {
      ledgerId,
      ledgerName: nameById.get(ledgerId) || null,
      currentCreditPeriodDays: creditTerms.isTermSet(storedDays) ? storedDays : null,
      openItemCount: rows.length,
      projectedAmount: Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100,
      companyDefaultDerivedCount: defaultDerived.length,
      companyDefaultDerivedAmount:
        Math.round(defaultDerived.reduce((s, r) => s + r.amount, 0) * 100) / 100,
      manualExpectedDateCount: rows.filter((r) => r.hasManualExpectedDate).length,
      manualSidecarCount: rows.filter((r) => r.isManualSidecar).length,
      overdueCount: rows.filter((r) => r.overdue).length,
      earliestDueDate: times.length ? new Date(Math.min(...times)) : null,
      latestDueDate: times.length ? new Date(Math.max(...times)) : null,
      topDates,
    };
    party.suggestedPriorityReason = impact.suggestedPriorityReason(party);
    parties.push(party);
  }

  return impact.rankParties(parties);
}

module.exports = { today, loadEnrichedBills, analyseParties };
