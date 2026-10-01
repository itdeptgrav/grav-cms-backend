// services/integration/marketingOutcomeDelivery.service.js
//
// CARRYING SALES' DECISIONS BACK TO MARKETING.
//
// The return leg of marketingProspectDelivery.service.js. Same mechanism, same
// refusals, opposite direction: Sales' outcome outbox is walked and Marketing's
// receiver is asked to apply each row.
//
// This leg is the one that makes the product's central claim true — "when Sales
// accepts or rejects a Prospect, the outcome must be returned to Marketing so
// that campaigns and scoring can improve". Without it the two applications
// share work in one direction only, and Marketing keeps campaigning at people
// Sales has already taken over.
"use strict";

const producer = require("../sales/marketingHandoverDecision.service");
const receiver = require("../marketing/salesOutcomeIntake.service");

const str = (v) => String(v ?? "").trim();

/**
 * Walk Sales' outcome outbox and apply each row to Marketing.
 *
 * ── REPAIR FIRST, THEN DELIVER ─────────────────────────────────────────────
 * A decision is stored before its announcement is created, and nothing spans
 * the two. A decided receipt with no announcement is therefore possible, and it
 * is invisible: the outbox has nothing pending, so a sweep that only walked
 * pending rows would report a clean run for ever while Marketing never heard
 * and no acquisition hold was ever raised.
 *
 * So the sweep asks first whether any decided receipt is missing its
 * announcement, creates the missing ones, and only then delivers. Both halves
 * are bounded and company-scoped. Neither is a scheduler: this runs when a
 * decision is recorded, when a replay arrives, or when an operator asks.
 */
async function deliverPending({
  companyId = null, limit = 50, repair = true, repairCursor = null,
} = {}) {
  const summary = {
    attempted: 0, delivered: 0, duplicates: 0, failed: 0, errors: [],
    repairedOutcomeEvents: 0,
    /* ── WHY THE SWEEP REPORTS ITS OWN INCOMPLETENESS ────────────────────
       A scan that stopped early and found nothing looks exactly like a scan
       that examined everything and found nothing. The difference matters: the
       first means "there may be a decision Marketing has still never heard
       about", and a caller that cannot tell them apart will report a clean run
       over an unrepaired gap. `repairComplete` is false whenever the scan was
       truncated, and `repairCursor` says where to resume. */
    repairComplete: null,
    repairCursor: null,
  };

  /* Only with a company: the reconciliation reads every decided receipt a
     company has, and an unscoped sweep across companies is not a query this
     service is allowed to make. */
  if (repair && companyId) {
    try {
      const repaired = await producer.repairMissingOutcomeEvents({ companyId, limit, cursor: repairCursor });
      summary.repairedOutcomeEvents = repaired.repaired;
      summary.repairComplete = repaired.complete;
      summary.repairCursor = repaired.nextCursor;
      if (repaired.failed) summary.errors.push(...repaired.errors);
    } catch (err) {
      /* A repair that could not run is not a complete one. */
      summary.repairComplete = false;
      summary.errors.push(`outcome-event repair: ${str(err?.message)}`);
    }
  }

  let events = [];
  try {
    events = await producer.pendingOutboxEvents({ companyId, limit });
  } catch (err) {
    summary.failed += 1;
    summary.errors.push(str(err?.message));
    return summary;
  }

  for (const event of events) {
    summary.attempted += 1;
    try {
      const result = await receiver.receive(event);
      await producer.markOutboxDelivered(event._id, event.companyId);
      if (result.duplicate) summary.duplicates += 1;
      else summary.delivered += 1;
    } catch (err) {
      summary.failed += 1;
      summary.errors.push(`${event.payload?.handoverRef || event.kind}: ${str(err?.message)}`);
      try {
        await producer.markOutboxAttemptFailed(event._id, err, event.companyId);
      } catch { /* still PENDING, which is the state that matters */ }
    }
  }

  return summary;
}

module.exports = { deliverPending };
