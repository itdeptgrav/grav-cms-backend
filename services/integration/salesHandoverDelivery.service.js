// services/integration/salesHandoverDelivery.service.js
//
// CARRYING SALES' HANDOVER EVENTS TO MERCHANDISING.
//
// ── THE SMALLEST MECHANISM THAT IS ACTUALLY RELIABLE ────────────────────────
// Sales commits its version change and its outbox row in one transaction, so
// a published statement always has an announcement waiting. This walks those
// pending rows and asks the Merchandising receiver to apply each one.
//
// That is the whole design, and the things it deliberately is not:
//
//   · not a message broker — no queue server, no topics, no subscribers, and
//     nothing that other domains can start publishing into. Two applications
//     in one process share a database; a broker between them would be
//     infrastructure bought to solve a problem neither has;
//   · not a background daemon — `deliverPending` is called by the Sales route
//     immediately after its transaction commits, and can be called again by
//     an operator or a future sweep. Nothing runs on a timer that nobody
//     asked for;
//   · not a transaction that spans both applications. It cannot be: the whole
//     point is that Sales' commercial act survives a receiver that is
//     temporarily unable to apply it.
//
// ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────
// It is the one place that legitimately knows about both sides, so it is the
// one place that has to be looked at when the boundary is questioned. Keeping
// it inside the producer would have meant the producer importing Merchandising
// again — the very thing being corrected — and keeping it inside the receiver
// would have meant Merchandising deciding when Sales' outbox is drained.
//
// ── WHAT A FAILURE MEANS ────────────────────────────────────────────────────
// The event stays PENDING, the attempt is counted, the error is stored, and
// the Sales response is unaffected. A merchandiser sees the handover in their
// inbox regardless — the inbox reads the version record, not this — so a
// delivery that has not happened yet delays a mirrored cancellation, not the
// work itself.
"use strict";

const producer = require("../sales/merchandisingHandover.service");
const receiver = require("../merchandising/handoverIntake.service");

const str = (v) => String(v ?? "").trim();

/**
 * Deliver pending Sales handover events to Merchandising.
 *
 * Oldest first, by when Sales ACTED — so a sweep catching up on three events
 * applies them in the order they happened, and a delayed supersession cannot
 * land after the cancellation that followed it.
 *
 * Never throws. A caller that has just committed a commercial decision must
 * not have that decision reported as failed because an announcement could not
 * be carried; the row stays pending and the summary says what happened.
 *
 * @param {{companyId?:any, correlationId?:string, limit?:number}} scope
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
      const result = await receiver.receive(event);
      /* A duplicate IS a delivery: the event has been applied, by this
         attempt or an earlier one, and leaving it pending would make the
         sweep retry it for ever. */
      await producer.markOutboxDelivered(event._id);
      if (result.duplicate) summary.duplicates += 1;
      else summary.delivered += 1;
    } catch (err) {
      /* Left PENDING on purpose. An event that was not applied has not been
         delivered, whatever the attempt count says. */
      summary.failed += 1;
      summary.errors.push(`${event.kind}: ${str(err?.message)}`);
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
