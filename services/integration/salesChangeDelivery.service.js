// services/integration/salesChangeDelivery.service.js
//
// CARRYING SALES' CHANGE NOTICES TO MERCHANDISING.
//
// The fourth carrier, and the closest sibling of the first: this is the same
// Sales → Merchandising hop `salesHandoverDelivery.service.js` makes, for a
// change instead of a handover, reusing that outbox's own attempt and error
// bookkeeping.
//
// Not a broker, not a daemon, not a transaction across the two applications —
// the three things every carrier in this repository is careful not to be.
// `deliverPending` is called by the Sales route immediately after its
// transaction commits, and again by an operator from the ops surface.
//
// Never throws: a salesperson who has just authorised a change must not be
// told it failed because an announcement could not be carried. The change IS
// issued — that is committed. The row stays PENDING with its reason and the
// next sweep tries again.
"use strict";

const {
  SalesHandoverOutboxEvent,
} = require("../../models/CMS_Models/Sales/SalesHandoverEvent");
const receiver = require("../merchandising/changeIntake.service");
const { CHANGE_EVENT_KINDS } = require("../sales/changeNotice.service");

const str = (v) => String(v ?? "").trim();

const CARRIED_KINDS = Object.freeze(Object.values(CHANGE_EVENT_KINDS));

/**
 * Deliver pending change events.
 *
 * Oldest first by when SALES ACTED, so a sweep catching up applies an issue
 * before the cancellation that followed it — otherwise a file could show a
 * withdrawn change as newly arrived.
 *
 * @returns {Promise<{considered, delivered, duplicates, failed, failures: Array}>}
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
        /* ── A DUPLICATE IS A DELIVERY ──────────────────────────────────
           The receiver already has it. Leaving the row pending would mean
           retrying for ever against a ledger that will keep saying the same
           thing. */
        row.status = "DELIVERED";
        row.deliveredAt = at;
        row.attempts = (row.attempts || 0) + 1;
        row.lastAttemptAt = at;
        row.lastError = "";
        await row.save();
        if (result.duplicate) summary.duplicates += 1;
        else summary.delivered += 1;
      } catch (err) {
        /* PENDING, with the reason and the attempt count. Retryable for
           ever: there is deliberately no terminal FAILED, because a failed
           row is a row somebody has to notice and nobody notices a status. */
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
