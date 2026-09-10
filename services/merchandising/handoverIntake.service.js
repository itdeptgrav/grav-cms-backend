// services/merchandising/handoverIntake.service.js
//
// MERCHANDISING RECEIVES WHAT SALES PUBLISHED.
//
// ── THE HALF OF THE BOUNDARY THAT LIVES HERE ────────────────────────────────
// Sales states a commercial fact — a handover issued, superseded, withdrawn —
// and records it in its own outbox. This is the only code that reads those
// events and changes a Merchandising record because of one. Sales owns the
// event; Merchandising owns the mutation.
//
// Before this existed the producer did both: it set the Execution File to
// CANCELLED with its own hands and wrote its history into the Merchandising
// audit trail. Nothing about that was wrong in its effect, and everything
// about it was wrong in its arrangement — a Merchandising rule could only be
// changed by editing Sales, a Merchandising write could be rolled back by a
// Sales failure, and the Merchandising audit trail held rows that no
// Merchandising code had written or could explain.
//
// ── EVERY HANDLER IS IDEMPOTENT, AND SAYS SO IN THE DATABASE ────────────────
// Delivery is at-least-once by design: the Sales route asks for an immediate
// attempt, and a sweep can retry anything still pending. So each event is
// recorded in an intake ledger keyed on the event's own id, and a second
// delivery of the same event finds that row and changes nothing. The handlers
// are written to be safe on their own as well — a cancellation checks the
// file is not already cancelled — because a ledger is a guarantee about
// events and the handlers are a guarantee about state.
//
// ── AND ORDER CANNOT BE ASSUMED ─────────────────────────────────────────────
// A retry sweep may deliver a week-old event after a newer one has already
// been applied. So nothing here moves a record backwards: a cancellation is
// never undone, a stale event is never applied over a newer accepted version,
// and an already-accepted projection is never replaced by anything but an
// explicit acceptance of a newer version by a merchandiser. An event that
// arrives too late to matter is not an error — it is delivered, recorded as
// having changed nothing, and the reason is stored beside it.
"use strict";

const mongoose = require("mongoose");

const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const { HANDOVER_EVENT_KINDS } = require("../../models/CMS_Models/Sales/SalesHandoverEvent");
const HandoverReceipt = require("../../models/CMS_Models/Merchandising/HandoverReceipt");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const { ExecutionPack } = require("../../models/CMS_Models/Merchandising/ExecutionPack");
const {
  DownstreamHandoverReceipt,
} = require("../../models/CMS_Models/PPC/DownstreamHandoverReceipt");
const {
  MerchandisingAuditEvent, MerchandisingIntakeLedger,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();

/** One transaction or a refusal — a mirrored cancellation and the audit event
 *  that explains it must not be able to exist without one another. */
async function withTxn(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } catch (err) {
    if (/Transaction numbers|replica set|transactions are not supported/i.test(str(err?.message))) {
      throw fail("MERCHANDISING_TRANSACTION_REQUIRED",
        "This deployment cannot receive the handover event atomically. Ask an operator — the database needs a replica set.");
    }
    throw err;
  } finally {
    session.endSession();
  }
}

/** The highest version this file has ever ACCEPTED — the line past which an
 *  older event has nothing left to say. */
function latestAcceptedVersionNo(file) {
  return (file?.sourceVersionHistory || [])
    .filter((h) => h.event === "ACCEPTED")
    .reduce((best, h) => Math.max(best, Number(h.versionNo) || 0), 0);
}

/* ═══ THE THREE THINGS SALES CAN SAY ═══════════════════════════════════════ */

/**
 * ISSUED — a new statement is in force for this line.
 *
 * Nothing to mutate. The inbox reads current handover versions directly, so
 * the version became visible to Merchandising the moment Sales committed it;
 * a file is deliberately NOT created, because a file records a decision a
 * merchandiser has taken and nobody has taken one yet.
 *
 * What this does do is record the observation, so the file's history can show
 * Sales' acts in Merchandising's own trail without Sales ever writing into it.
 */
async function onIssued(event, session) {
  await MerchandisingAuditEvent.create([{
    companyId: event.companyId,
    recordType: "HANDOVER_VERSION",
    recordId: event.payload.handoverVersionId,
    recordRevision: event.payload.versionNo,
    action: "HANDOVER_ISSUED",
    /* No actor: this is the source application's act, observed. Inventing a
       Merchandising person for it would be a false attribution. */
    source: "sales",
    at: event.occurredAt,
    correlationId: event.correlationId,
    resultingState: "CURRENT",
    details: {
      handoverRef: event.payload.handoverRef,
      handoverLineRef: event.payload.handoverLineRef,
      versionNo: event.payload.versionNo,
    },
  }], { session, ordered: true });

  return { outcome: "APPLIED", note: "Handover version observed." };
}

/**
 * SUPERSEDED — an older statement has been replaced.
 *
 * A clarification Merchandising asked for against that statement is settled
 * by the replacement, so its receipt is marked SUPERSEDED and KEPT: what was
 * asked, by whom and why is part of why the new version exists.
 *
 * An ACCEPTED receipt is left exactly as it is, and so is the file's accepted
 * projection. Merchandising accepted a specific version; a newer one becomes
 * the file's truth when a merchandiser accepts it and not a moment before.
 */
async function onSuperseded(event, session) {
  const receipt = await HandoverReceipt.findOne({
    companyId: event.companyId, handoverVersionId: event.payload.handoverVersionId,
  }).session(session);

  if (!receipt) return { outcome: "NOOP", note: "No decision had been recorded on that version." };
  if (receipt.state === "ACCEPTED") {
    return { outcome: "NOOP", note: "The accepted decision on that version stands until a newer one is accepted." };
  }
  if (receipt.state === "SUPERSEDED") {
    return { outcome: "NOOP", note: "Already recorded as superseded." };
  }

  receipt.state = "SUPERSEDED";
  await receipt.save({ session });

  await MerchandisingAuditEvent.create([{
    companyId: event.companyId,
    recordType: "HANDOVER_RECEIPT",
    recordId: receipt._id,
    recordRevision: receipt.sourceVersionNo,
    action: "HANDOVER_SUPERSEDED",
    source: "sales",
    at: event.occurredAt,
    correlationId: event.correlationId,
    previousState: "CLARIFICATION_REQUESTED",
    resultingState: "SUPERSEDED",
    details: {
      versionNo: event.payload.versionNo,
      supersededByVersionNo: event.payload.supersededByVersionNo,
    },
  }], { session, ordered: true });

  return { outcome: "APPLIED", note: "Clarification settled by a newer version." };
}

/**
 * CANCELLED — Sales has withdrawn the commercial requirement.
 *
 * The Execution File opened from this line mirrors it: lifecycle CANCELLED,
 * stamped with the source version that authorised it and the reason Sales
 * gave, appended to the file's source history, and audited as the SOURCE's
 * act. No Merchandising command can set or reverse that state.
 *
 * Nothing here is destructive: the lifecycle it replaces, the assignment, the
 * units and the whole version history stay exactly as they were.
 */
async function onCancelled(event, session) {
  const notes = [];

  const receipt = await HandoverReceipt.findOne({
    companyId: event.companyId, handoverVersionId: event.payload.handoverVersionId,
  }).session(session);
  if (receipt && !["ACCEPTED", "CANCELLED_BY_SALES"].includes(receipt.state)) {
    receipt.state = "CANCELLED_BY_SALES";
    await receipt.save({ session });
    notes.push("Receipt withdrawn.");
  }

  const file = await ExecutionFile.findOne({
    companyId: event.companyId,
    handoverRef: event.payload.handoverRef,
    handoverLineRef: event.payload.handoverLineRef,
  }).session(session);

  if (!file) {
    return {
      outcome: notes.length ? "APPLIED" : "NOOP",
      note: notes.concat("No execution file had been opened from this line.").join(" "),
    };
  }
  if (file.lifecycleStatus === "CANCELLED") {
    return { outcome: notes.length ? "APPLIED" : "NOOP", note: notes.concat("File already cancelled.").join(" ") };
  }
  /* ── A LATE EVENT DOES NOT UNDO A NEWER DECISION ────────────────────── */
  const accepted = latestAcceptedVersionNo(file);
  if (accepted && Number(event.payload.versionNo) < accepted) {
    return {
      outcome: notes.length ? "APPLIED" : "NOOP",
      note: notes.concat(`Version ${event.payload.versionNo} was withdrawn, but version ${accepted} has since been accepted.`).join(" "),
    };
  }

  const previous = file.lifecycleStatus;
  const why = str(event.payload.reason).slice(0, 1000);
  file.lifecycleStatus = "CANCELLED";
  file.lifecycleReason = why;
  file.cancellation = {
    sourceVersionId: event.payload.handoverVersionId, reason: why, at: event.occurredAt,
  };
  file.sourceVersionHistory.push({
    versionId: event.payload.handoverVersionId,
    versionNo: event.payload.versionNo,
    event: "CANCELLED_BY_SALES",
    at: event.occurredAt,
    by: event.actor || undefined,
  });
  file.revision += 1;
  await file.save({ session });

  await MerchandisingAuditEvent.create([{
    companyId: event.companyId,
    recordType: "EXECUTION_FILE",
    recordId: file._id,
    recordRevision: file.revision,
    action: "SALES_CANCELLATION_MIRRORED",
    actor: event.actor || undefined,
    source: "sales",
    at: event.occurredAt,
    reason: why,
    correlationId: event.correlationId,
    previousState: previous,
    resultingState: "CANCELLED",
    details: { versionNo: event.payload.versionNo },
  }], { session, ordered: true });

  /* ── M6: A CANCELLED ORDER CANCELS ITS HANDOVER TOO ──────────────────
     Merchandising never AUTHORS a pack cancellation — it mirrors Sales', the
     same way it mirrors the file's. A pack left SUBMITTED against a cancelled
     order would sit in PPC's queue asking them to accept work that no longer
     exists.

     Every pack version is marked, not just the one in force: a superseded
     version is history and keeps its state, but anything still live —
     draft, submitted, or accepted — is now about an order that was called
     off. PPC's own receipt moves with it, and PPC's recorded DECISION is
     preserved underneath. */
  const live = await ExecutionPack.find({
    companyId: event.companyId,
    fileId: file._id,
    state: { $in: ["DRAFT", "SUBMITTED", "ACCEPTED", "CLARIFICATION_REQUESTED"] },
  }).session(session);

  for (const pack of live) {
    pack.state = "CANCELLED";
    pack.cancelledAt = event.occurredAt;
    pack.cancellationReason = why;
    pack.revision += 1;
    await pack.save({ session });

    const receipt = await DownstreamHandoverReceipt.findOne({
      companyId: event.companyId, packId: pack._id,
    }).session(session);
    if (receipt && receipt.state !== "CANCELLED_BY_MERCHANDISING") {
      receipt.state = "CANCELLED_BY_MERCHANDISING";
      receipt.revision += 1;
      await receipt.save({ session });
    }

    await MerchandisingAuditEvent.create([{
      companyId: event.companyId,
      recordType: "EXECUTION_PACK",
      recordId: pack._id,
      recordRevision: pack.revision,
      fileId: file._id,
      fileNumber: str(file.fileNumber),
      action: "PACK_CANCELLED",
      actor: event.actor || undefined,
      source: "sales",
      at: event.occurredAt,
      reason: why,
      correlationId: event.correlationId,
      details: { packVersionNo: pack.packVersionNo },
    }], { session, ordered: true });
  }
  if (live.length) {
    notes.push(`${live.length} execution pack version(s) cancelled.`);
  }

  return { outcome: "APPLIED", note: notes.concat("Execution file cancelled.").join(" ") };
}

const HANDLERS = Object.freeze({
  [HANDOVER_EVENT_KINDS.ISSUED]: onIssued,
  [HANDOVER_EVENT_KINDS.SUPERSEDED]: onSuperseded,
  [HANDOVER_EVENT_KINDS.CANCELLED]: onCancelled,
});

/* ═══ THE DOOR ═════════════════════════════════════════════════════════════ */

/**
 * Apply one Sales handover event to Merchandising's records.
 *
 * Everything — the ledger row, the receipt, the file, the audit event —
 * commits together. A failure leaves no ledger row, so the event stays
 * undelivered on the Sales side and will be tried again; a success leaves
 * one, so it will not be applied twice.
 *
 * @returns {Promise<{applied:boolean, duplicate:boolean, outcome:string, note:string}>}
 */
async function receive(event) {
  const kind = str(event?.kind);
  const handler = HANDLERS[kind];
  if (!handler) {
    /* An unrecognised kind is not a delivery failure to retry for ever — it
       is a contract this receiver does not implement, and saying so is more
       useful than a queue that never drains. */
    throw fail("VALIDATION", `Merchandising cannot receive "${kind}".`, { kind });
  }

  const already = await MerchandisingIntakeLedger.findOne({ sourceEventId: event._id }).lean();
  if (already) {
    return { applied: false, duplicate: true, outcome: already.outcome, note: already.note };
  }

  return withTxn(async (session) => {
    /* Re-checked inside the transaction: two attempts can race here, and the
       unique index below is what settles it. */
    const raced = await MerchandisingIntakeLedger.findOne({ sourceEventId: event._id }).session(session).lean();
    if (raced) return { applied: false, duplicate: true, outcome: raced.outcome, note: raced.note };

    const result = await handler(event, session);

    await MerchandisingIntakeLedger.create([{
      sourceEventId: event._id,
      sourceKind: kind,
      companyId: event.companyId,
      handoverRef: str(event.payload?.handoverRef),
      handoverLineRef: str(event.payload?.handoverLineRef),
      sourceVersionNo: Number(event.payload?.versionNo) || null,
      outcome: result.outcome,
      note: str(result.note).slice(0, 500),
      appliedAt: new Date(),
    }], { session, ordered: true });

    return { applied: result.outcome === "APPLIED", duplicate: false, ...result };
  }).catch((err) => {
    /* Two deliveries reached the ledger at once; the loser reports the
       duplicate it lost to rather than a failure that would be retried. */
    if (err?.code === 11000) {
      return { applied: false, duplicate: true, outcome: "NOOP", note: "Delivered concurrently." };
    }
    throw err;
  });
}

/** The version a receiver-side reader may need — exposed so the dispatcher
 *  never has to reach into the Sales version collection itself. */
async function readVersion(companyId, versionId) {
  return SalesHandoverVersion.findOne({ companyId, _id: versionId }).lean();
}

module.exports = { receive, readVersion, latestAcceptedVersionNo, HANDLERS };
