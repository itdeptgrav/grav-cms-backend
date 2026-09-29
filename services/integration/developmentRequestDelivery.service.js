// services/integration/developmentRequestDelivery.service.js
//
// CARRYING SALES' DEVELOPMENT REQUESTS TO MERCHANDISING.
//
// The fifth carrier, and the pre-order sibling of the first: the same Sales →
// Merchandising hop `salesHandoverDelivery.service.js` makes, for a request
// instead of a handover, reusing that outbox's own attempt and error
// bookkeeping.
//
// Not a broker, not a daemon, not a transaction across the two applications.
// Called by the Sales route immediately after its transaction commits, and
// again by an operator from the ops surface. Never throws: a salesperson who
// has just asked for materials must not be told it failed because an
// announcement could not be carried.
"use strict";

const {
  SalesHandoverOutboxEvent,
} = require("../../models/CMS_Models/Sales/SalesHandoverEvent");
const receiver = require("../merchandising/developmentIntake.service");
const { DEVELOPMENT_EVENT_KINDS } = require("../sales/developmentRequest.service");

const str = (v) => String(v ?? "").trim();

const CARRIED_KINDS = Object.freeze(Object.values(DEVELOPMENT_EVENT_KINDS));

/**
 * Deliver pending development events.
 *
 * Oldest first by when SALES ACTED, so a sweep catching up applies an issue
 * before the release that followed it — otherwise a file could be released
 * before the request that justified it had arrived.
 */
async function deliverPending({ companyId, correlationId, limit = 100 } = {}) {
  const summary = { considered: 0, delivered: 0, duplicates: 0, failed: 0, failures: [] };
  try {
    const query = { status: "PENDING", kind: { $in: CARRIED_KINDS } };
    if (companyId) query.companyId = companyId;
    if (correlationId) query.correlationId = str(correlationId);

    const rows = await SalesHandoverOutboxEvent.find(query)
      .sort({ occurredAt: 1, _id: 1 }).limit(Math.min(Number(limit) || 100, 500));
    summary.considered = rows.length;

    for (const row of rows) {
      const at = new Date();
      try {
        const result = await receiver.receive(row.toObject());
        /* A duplicate is a delivery: the receiver already has it, and leaving
           the row pending would retry for ever against a ledger that will
           keep saying the same thing. */
        row.status = "DELIVERED";
        row.deliveredAt = at;
        row.attempts = (row.attempts || 0) + 1;
        row.lastAttemptAt = at;
        row.lastError = "";
        await row.save();
        if (result.duplicate) summary.duplicates += 1;
        else summary.delivered += 1;
      } catch (err) {
        /* PENDING with the reason and the attempt count. There is no terminal
           FAILED, because a failed row is one somebody has to notice and
           nobody notices a status. */
        row.attempts = (row.attempts || 0) + 1;
        row.lastAttemptAt = at;
        row.lastError = str(err?.message).slice(0, 500);
        try { await row.save(); } catch { /* the sweep must not die reporting */ }
        summary.failed += 1;
        summary.failures.push({
          eventId: str(row._id), kind: str(row.kind),
          attempts: row.attempts, message: row.lastError,
        });
      }
    }
    return summary;
  } catch (err) {
    summary.failures.push({ eventId: null, kind: null, attempts: 0, message: str(err?.message) });
    return summary;
  }
}

module.exports = { CARRIED_KINDS, deliverPending };
