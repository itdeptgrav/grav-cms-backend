// services/integration/marketingProspectDelivery.service.js
//
// CARRYING MARKETING'S HANDOVERS TO SALES.
//
// The same mechanism as salesHandoverDelivery.service.js, pointed the other
// way — read that file first; everything it says about what this deliberately
// is NOT (a broker, a daemon, a cross-application transaction) applies here
// unchanged.
//
// ── WHY IT IS ITS OWN MODULE ───────────────────────────────────────────────
// It is the one place that legitimately knows about both applications, so it
// is the one place to look when the boundary is questioned. Putting it inside
// Marketing would mean Marketing importing Sales; putting it inside Sales
// would mean Sales deciding when Marketing's outbox is drained.
//
// ── WHAT A FAILURE MEANS ───────────────────────────────────────────────────
// The row stays PENDING, the attempt is counted, the error is stored, and the
// marketer's response is unaffected. Their handover exists and is visible in
// Marketing regardless — the Marketing inbox reads the handover record, not
// this — so an undelivered event delays the Sales inbox, not the work.
"use strict";

const producer = require("../marketing/prospectHandover.service");
const receiver = require("../sales/marketingProspectIntake.service");

const str = (v) => String(v ?? "").trim();

/**
 * Deliver pending Marketing handover events to Sales.
 *
 * Never throws. A marketer who has just submitted a handover must not have it
 * reported as failed because an announcement could not be carried.
 *
 * @returns {Promise<{attempted:number, delivered:number, duplicates:number, failed:number, errors:string[]}>}
 */
async function deliverPending({ companyId = null, correlationId = "", limit = 50 } = {}) {
  const summary = { attempted: 0, delivered: 0, duplicates: 0, failed: 0, errors: [] };

  let events = [];
  try {
    events = await producer.pendingOutboxEvents({ companyId, correlationId, limit });
  } catch (err) {
    summary.failed += 1;
    summary.errors.push(str(err?.message));
    return summary;
  }

  for (const event of events) {
    summary.attempted += 1;
    try {
      /* The reader is INJECTED from here rather than reached for inside the
         Sales receiver. This module is the one that legitimately knows both
         applications; handing Sales the function keeps "Sales reads the
         authoritative handover" true without Sales importing Marketing. */
      const result = await receiver.receive(event, { readHandover: producer.readByRef });
      /* A duplicate IS a delivery: the event has been applied, by this attempt
         or an earlier one, and leaving it pending would retry it for ever. */
      await producer.markOutboxDelivered(event._id);
      if (result.duplicate) summary.duplicates += 1;
      else summary.delivered += 1;
    } catch (err) {
      summary.failed += 1;
      summary.errors.push(`${event.payload?.handoverRef || event.kind}: ${str(err?.message)}`);
      try {
        await producer.markOutboxAttemptFailed(event._id, err);
      } catch {
        /* Even the bookkeeping failed. The row is still PENDING, which is the
           state that matters, and the next attempt will find it. */
      }
    }
  }

  return summary;
}

module.exports = { deliverPending };
