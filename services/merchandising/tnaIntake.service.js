// services/merchandising/tnaIntake.service.js
//
// MILESTONES COMPLETED BY SOMETHING HAPPENING, NOT BY SOMEBODY TICKING A BOX.
//
// A T&A plan whose dates are all typed in by hand is a spreadsheet with extra
// steps. The milestones that matter most — "trim card approved", "packaging
// signed off", "development requirements approved" — already have a moment of
// truth somewhere else in Merchandising, and this is what connects the two.
//
// ── WHY THE SOURCE OWNS THE DATE ────────────────────────────────────────────
// A milestone declared `SOURCE_EVENT` cannot be completed by hand. The whole
// point is that its actual date is the date the thing actually happened, taken
// from the record that happened — not a merchandiser's recollection of it a
// fortnight later. `tnaPlan.completeMilestone` refuses those with
// `TNA_SOURCE_OWNED`, and this is the door they come through instead.
//
// ── AND WHY THIS READS EVENTS, NOT M4's TABLES ──────────────────────────────
// The standing constraint is that T&A does not reach into M4's collections.
// It would work — and it would mean every future change to a selection
// revision's shape silently broke the schedule. Instead T&A consumes M4's
// published outbox events, which are a contract M4 made deliberately, and
// keeps only the identifiers it needs. The one thing it stores from the
// source is a REFERENCE — kind, id, ref — so a reader can get back to the
// record that closed the milestone without T&A having copied it.
//
// ── STALE EVENTS ────────────────────────────────────────────────────────────
// Delivery is not ordered, so a superseded approval can arrive after the
// approval that replaced it. Two rules settle every case:
//
//   · an event older than the actual already recorded is a NOOP, not a
//     correction — the milestone keeps the earlier, truer date;
//   · an event for a milestone that no longer exists (template changed, plan
//     cancelled) is a NOOP, not a failure, because there is nothing to retry
//     into.
//
// Both are recorded in the ledger as NOOP, which is a successful delivery.
// A delivery that failed would be retried for ever against a plan that will
// never accept it.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const {
  TnaPlan, TnaMilestone, PLAN_STATE, MILESTONE_STATUS,
} = require("../../models/CMS_Models/Merchandising/TnaPlan");
const {
  MerchandisingAuditEvent, MerchandisingOutboxEvent, MerchandisingIntakeLedger, OUTBOX_KIND,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const plans = require("./tnaPlan.service");
const cal = require("./tnaCalendar");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();

/* ── THE KINDS T&A LISTENS FOR ─────────────────────────────────────────────
   Read off M4's actual published contract rather than guessed at: these are
   the three approval events M4 emits. The approval REGISTER emits none — it
   records external approvals it does not own — so a milestone waiting on a
   buyer's sign-off stays `AWAITING_SOURCE_RECORD` until somebody outside
   Merchandising publishes one, and T&A says exactly that instead of
   pretending to know. */
const CONSUMED_KINDS = Object.freeze([
  OUTBOX_KIND.MATERIAL_TRIM_APPROVED,
  OUTBOX_KIND.PACKAGING_APPROVED,
  OUTBOX_KIND.DEVELOPMENT_APPROVED,
]);

const isConsumed = (kind) => CONSUMED_KINDS.includes(str(kind));

async function withTxn(work) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await work(session); });
    return out;
  } finally { session.endSession(); }
}

/**
 * The date an event says something happened, as a plan date-string.
 *
 * Prefers the source's own stated date; falls back to when the event was
 * written. Converted in the PLAN's timezone, because a 23:40 IST approval is
 * the 9th in Delhi and the 9th is the date the merchandiser will look for.
 */
function eventDate(event, timezone) {
  /* A producer that states the date it means is believed. M4's approval
     payload does not carry one today, so the fallback below — the moment the
     event was written, read in the plan's zone — is what the register shows;
     the branch is here so a producer that starts stating one is honoured
     without a change to this consumer. */
  const stated = str(event?.payload?.approvedOn) || str(event?.payload?.effectiveDate);
  if (/^\d{4}-\d{2}-\d{2}$/.test(stated)) return stated;
  const at = event?.occurredAt || event?.at || event?.createdAt;
  return cal.todayInZone(timezone, at ? new Date(at) : undefined);
}

/* ═══ THE DOOR ═════════════════════════════════════════════════════════════ */

/**
 * Apply one source event to whatever milestones are waiting on it.
 *
 * One event may close several milestones — the same trim-card approval can
 * satisfy a per-delivery milestone on each drop of the same file. All of them
 * settle in one transaction with one ledger row, because they are one fact.
 */
async function receive(event) {
  const kind = str(event?.kind);
  if (!isConsumed(kind)) {
    throw fail("VALIDATION",
      `Time & Action does not listen for "${kind}".`, { kind, listensFor: CONSUMED_KINDS });
  }

  const already = await MerchandisingIntakeLedger.findOne({ sourceEventId: event._id }).lean();
  if (already) {
    return { applied: false, duplicate: true, outcome: already.outcome, note: already.note };
  }

  return withTxn(async (session) => {
    const raced = await MerchandisingIntakeLedger.findOne({ sourceEventId: event._id })
      .session(session).lean();
    if (raced) return { applied: false, duplicate: true, outcome: raced.outcome, note: raced.note };

    const result = await applyEvent(event, session);

    await MerchandisingIntakeLedger.create([{
      sourceEventId: event._id,
      sourceKind: kind,
      companyId: event.companyId,
      handoverRef: str(event.payload?.handoverRef),
      handoverLineRef: str(event.payload?.handoverLineRef),
      sourceVersionNo: Number(event.payload?.revisionNo) || null,
      outcome: result.outcome,
      note: str(result.note).slice(0, 500),
      appliedAt: new Date(),
    }], { session, ordered: true });

    return { applied: result.outcome === "APPLIED", duplicate: false, ...result };
  }).catch((err) => {
    if (err?.code === 11000) {
      return { applied: false, duplicate: true, outcome: "NOOP", note: "Delivered concurrently." };
    }
    throw err;
  });
}

async function applyEvent(event, session) {
  const kind = str(event.kind);
  /* M4's approval events are file-scoped and name the file directly — the
     spec's `(handoverRef, handoverLineRef)` resolution was written for Sales
     events, which is a different producer. Both are accepted: the direct id
     where the producer states one, and the permanent line identity where it
     does not, so a future Sales-side source event needs no change here. */
  let fileId = event.payload?.executionFileId || event.recordId || event.payload?.fileId;
  if (!fileId && str(event.payload?.handoverRef) && str(event.payload?.handoverLineRef)) {
    const byLine = await ExecutionFile.findOne({
      companyId: event.companyId,
      handoverRef: str(event.payload.handoverRef),
      handoverLineRef: str(event.payload.handoverLineRef),
    }).select("_id").session(session).lean();
    fileId = byLine?._id || null;
  }
  if (!fileId) {
    return { outcome: "NOOP", note: "The event names no execution file.", closed: [] };
  }

  const plan = await TnaPlan.findOne({
    companyId: event.companyId, fileId, state: { $ne: PLAN_STATE.CANCELLED },
  }).session(session);
  if (!plan) {
    /* Not a failure. This file has no plan, or its plan was cancelled; there
       is nothing this event could ever be retried into. */
    return { outcome: "NOOP", note: "That file has no live Time & Action plan.", closed: [] };
  }

  const waiting = await TnaMilestone.find({
    companyId: event.companyId,
    planId: plan._id,
    completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: kind,
  }).sort({ sequenceRank: 1 }).session(session);

  if (!waiting.length) {
    return { outcome: "NOOP", note: "No milestone on this plan waits for that event.", closed: [] };
  }

  const at = new Date();
  const correlationId = str(event.correlationId) || crypto.randomUUID();
  const on = eventDate(event, plan.timezone);
  const file = await ExecutionFile.findById(plan.fileId).session(session).lean();

  const closed = [];
  const skipped = [];
  const correctedRows = [];
  for (const m of waiting) {
    /* ── EARLIER CORRECTS LATER, NEVER THE REVERSE ──────────────────────
       Delivery is not ordered, so an authoritative observation can arrive
       after a later one. If it says the thing happened EARLIER than what is
       recorded, it is a correction and it wins — an approval genuinely
       granted on the 3rd is not made truer by a duplicate delivered on the
       9th. If it is the same date or later, the recorded date already is the
       earliest authoritative statement and nothing moves; the plan does not
       drift forward because a message was slow. */
    if (m.actualDate && on >= m.actualDate) {
      skipped.push({
        milestoneRef: m.milestoneRef,
        reason: on === m.actualDate
          ? `Already completed on ${m.actualDate}.`
          : `Already completed on ${m.actualDate}; this event says ${on}, which is later.`,
      });
      continue;
    }
    const corrects = m.actualDate || null;
    if (m.status === MILESTONE_STATUS.NOT_APPLICABLE) {
      skipped.push({ milestoneRef: m.milestoneRef, reason: "Not applicable on this plan." });
      continue;
    }

    m.actualDate = on;
    m.status = MILESTONE_STATUS.COMPLETED;
    if (corrects) correctedRows.push({ milestoneRef: m.milestoneRef, was: corrects, now: on });
    m.completedAt = at;
    /* No actor. Nobody completed this — a record did, and naming a person
       would put a signature on a statement they did not make. */
    m.completion = {
      recordedVia: "SOURCE_EVENT",
      sourceApp: "MERCHANDISING",
      sourceEventId: event._id,
      sourceEventKind: kind,
      sourceRecordType: str(event.payload?.family),
      sourceRecordRef: str(event.payload?.revisionId),
      sourceRecordVersion: Number(event.payload?.revisionNo) || null,
      /* When the SOURCE says it happened, not when we heard. */
      observedAt: event.occurredAt || event.at || event.createdAt || at,
    };
    /* A blocked milestone that the world has just completed is no longer
       blocked; leaving the flag would leave the register contradicting
       itself. */
    if (m.blocked) m.blocked = null;
    m.revision += 1;
    await m.save({ session });
    closed.push(m.milestoneRef);
  }

  if (!closed.length) {
    return {
      outcome: "NOOP",
      note: skipped[0]?.reason || "Nothing on this plan needed to change.",
      closed: [], skipped,
    };
  }

  /* Downstream dates move because an upstream fact landed — the whole
     reason this connection exists. */
  const outboxRows = [];
  await plans.repropagate({ ctx: { companyId: event.companyId }, plan, file, session, actor: null });
  await plans.settlePlanState({
    plan, session, file, actor: null, correlationId, outboxRows,
  });
  plan.revision += 1;
  await plan.save({ session });

  await MerchandisingAuditEvent.create([{
    companyId: event.companyId,
    recordType: "TNA_PLAN",
    recordId: plan._id,
    fileId: plan.fileId,
    fileNumber: str(file?.fileNumber),
    /* OBSERVED, not COMPLETED. The distinction is the point of this whole
       path: nobody completed this milestone, a record did, and the history
       should not read as though somebody signed for it. */
    action: "TNA_MILESTONE_COMPLETION_OBSERVED",
    source: "merchandising",
    at,
    correlationId,
    reason: "",
    details: {
      planId: str(plan._id),
      milestoneRefs: closed,
      actualDate: on,
      sourceKind: kind,
      sourceEventId: str(event._id),
      corrected: correctedRows,
      skipped,
    },
  }], { session, ordered: true });

  if (outboxRows.length) {
    await MerchandisingOutboxEvent.create(outboxRows, { session, ordered: true });
  }

  return {
    outcome: "APPLIED",
    note: `Closed ${closed.length} milestone${closed.length === 1 ? "" : "s"} on ${on}.`
      + (correctedRows.length ? ` Corrected ${correctedRows.length} earlier than recorded.` : ""),
    closed, skipped, corrected: correctedRows,
  };
}

/**
 * Drain whatever T&A has not yet consumed.
 *
 * The outbox is app-local and nothing else dispatches these kinds to T&A, so
 * this is the sweep: every consumable event with no ledger row, oldest first.
 * Safe to run twice — the ledger is what makes it so.
 */
async function drain({ companyId, limit = 200 } = {}) {
  const query = { kind: { $in: CONSUMED_KINDS } };
  if (companyId) query.companyId = companyId;

  const candidates = await MerchandisingOutboxEvent.find(query)
    .sort({ createdAt: 1 }).limit(Math.min(Number(limit) || 200, 1000)).lean();
  if (!candidates.length) return { considered: 0, applied: 0, duplicates: 0, noops: 0, failures: [] };

  const done = await MerchandisingIntakeLedger
    .find({ sourceEventId: { $in: candidates.map((c) => c._id) } })
    .select("sourceEventId").lean();
  const seen = new Set(done.map((d) => str(d.sourceEventId)));

  const summary = { considered: candidates.length, applied: 0, duplicates: 0, noops: 0, failures: [] };
  for (const event of candidates) {
    if (seen.has(str(event._id))) { summary.duplicates += 1; continue; }
    try {
      const result = await receive(event);
      if (result.duplicate) summary.duplicates += 1;
      else if (result.applied) summary.applied += 1;
      else summary.noops += 1;
    } catch (err) {
      /* One poisonous event does not stop the sweep, and it is named rather
         than swallowed. */
      summary.failures.push({ sourceEventId: str(event._id), message: str(err?.message) });
    }
  }
  return summary;
}

module.exports = { CONSUMED_KINDS, isConsumed, eventDate, receive, applyEvent, drain };
