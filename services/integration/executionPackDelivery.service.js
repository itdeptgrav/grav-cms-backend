// services/integration/executionPackDelivery.service.js
//
// CARRYING A SUBMITTED EXECUTION PACK TO PPC.
//
// The third carrier, beside `salesHandoverDelivery` and `tnaSourceDelivery`,
// and the same shape for the same reasons. What is different here is the
// direction: this one crosses an APPLICATION boundary, from Merchandising to
// PPC, and it is the boundary M6 exists to establish.
//
// ── WHAT DELIVERY MEANS WHEN BOTH SIDES SHARE A DATABASE ────────────────────
// It would be easy to pretend. Merchandising's submit already commits the
// pack, and PPC's queue reads submitted packs directly, so a carrier could
// mark every row delivered the instant it saw it and always succeed.
//
// That would be a lie dressed as infrastructure. So this checks the thing that
// actually has to be true for the announcement to have landed: the pack the
// event names still exists, in this company, in a state PPC can act on. If it
// does, the announcement has genuinely reached its destination — PPC's queue
// will show it — and the row is marked delivered. If it does not, the row
// stays PENDING with the reason recorded, and the next sweep tries again.
//
// This is not a broker. There is no queue server, no topic, no subscriber
// registry, and nothing another domain can start publishing into. Two
// applications share a process and a database; a broker between them would be
// infrastructure bought to solve a problem neither has.
//
// ── NEVER THROWS ────────────────────────────────────────────────────────────
// A merchandiser who has just submitted a pack must not be told the submission
// failed because an announcement could not be carried. The pack IS submitted —
// that is committed. This is bookkeeping about it.
//
// ── AND THERE IS NO DAEMON ──────────────────────────────────────────────────
// `deliverPending` is called by the submit route immediately after its
// transaction commits, and can be called again by an operator through
// `POST /downstream/delivery/retry`. Nothing runs on a timer nobody asked for.
"use strict";

const {
  MerchandisingOutboxEvent, OUTBOX_KIND,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { ExecutionPack, PACK_STATE } = require("../../models/CMS_Models/Merchandising/ExecutionPack");

const str = (v) => String(v ?? "").trim();

/** The three kinds this carrier is responsible for. */
const CARRIED_KINDS = Object.freeze([
  OUTBOX_KIND.PACK_SUBMITTED,
  OUTBOX_KIND.PACK_SUPERSEDED,
  OUTBOX_KIND.PACK_WITHDRAWN,
]);

/** The pack states PPC can genuinely see and act on. */
const VISIBLE_TO_PPC = Object.freeze([
  PACK_STATE.SUBMITTED, PACK_STATE.ACCEPTED, PACK_STATE.CLARIFICATION_REQUESTED,
  PACK_STATE.SUPERSEDED, PACK_STATE.CANCELLED,
]);

/**
 * Carry every pending pack announcement.
 *
 * Oldest first by when Merchandising ACTED, so a sweep catching up applies a
 * submission before the supersession that followed it — otherwise PPC's queue
 * could show a superseded version arriving after its replacement.
 *
 * @returns {Promise<{considered, delivered, pending, failures: Array}>}
 */
async function deliverPending({ companyId, limit = 200 } = {}) {
  const summary = { considered: 0, delivered: 0, pending: 0, failures: [] };
  try {
    const query = { kind: { $in: CARRIED_KINDS }, status: "PENDING" };
    if (companyId) query.companyId = companyId;

    const rows = await MerchandisingOutboxEvent.find(query)
      .sort({ createdAt: 1, _id: 1 }).limit(Math.min(Number(limit) || 200, 1000));
    summary.considered = rows.length;

    for (const row of rows) {
      const at = new Date();
      try {
        const packId = row.payload?.packId;
        const pack = packId
          ? await ExecutionPack.findOne({ _id: packId, companyId: row.companyId })
            .select("state packVersionNo").lean()
          : null;

        if (!pack) {
          throw new Error("The pack this announcement names is not readable.");
        }
        if (!VISIBLE_TO_PPC.includes(pack.state)) {
          throw new Error(`The pack is ${str(pack.state).toLowerCase()}, which PPC cannot act on.`);
        }

        row.status = "DELIVERED";
        row.deliveredAt = at;
        row.attempts = (row.attempts || 0) + 1;
        row.lastAttemptAt = at;
        row.lastError = "";
        await row.save();
        summary.delivered += 1;
      } catch (err) {
        /* PENDING, with the reason. Retryable for ever, by design — see the
           header on why there is no terminal failure. */
        row.attempts = (row.attempts || 0) + 1;
        row.lastAttemptAt = at;
        row.lastError = str(err?.message).slice(0, 500);
        try { await row.save(); } catch { /* the sweep must not die reporting */ }
        summary.pending += 1;
        summary.failures.push({
          eventId: str(row._id), kind: str(row.kind),
          attempts: row.attempts, message: row.lastError,
        });
      }
    }
    return summary;
  } catch (err) {
    /* The sweep itself could not run. Reported, never thrown. */
    summary.failures.push({ eventId: null, kind: null, attempts: 0, message: str(err?.message) });
    return summary;
  }
}

/** What is still undelivered, for the screen that offers a retry. */
async function pendingSummary({ companyId } = {}) {
  const query = { kind: { $in: CARRIED_KINDS }, status: "PENDING" };
  if (companyId) query.companyId = companyId;
  const rows = await MerchandisingOutboxEvent.find(query)
    .sort({ createdAt: 1 }).limit(50).lean();
  return {
    pending: rows.length,
    rows: rows.map((r) => ({
      eventId: str(r._id),
      kind: str(r.kind),
      packVersionNo: r.payload?.packVersionNo ?? null,
      attempts: r.attempts || 0,
      lastAttemptAt: r.lastAttemptAt || null,
      lastError: str(r.lastError),
      createdAt: r.createdAt || null,
    })),
  };
}

module.exports = { CARRIED_KINDS, VISIBLE_TO_PPC, deliverPending, pendingSummary };
