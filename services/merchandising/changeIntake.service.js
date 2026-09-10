// services/merchandising/changeIntake.service.js
//
// RECEIVING A SALES-AUTHORISED CHANGE.
//
// The `handoverIntake.service.js` pattern, unchanged: one handler per event
// kind, `{outcome: "APPLIED"|"NOOP", note}`, a ledger row keyed on the unique
// and immutable `sourceEventId`, `11000` treated as a duplicate rather than a
// failure — idempotency as a DATABASE fact.
//
// ── WHAT ARRIVING DOES, AND WHAT IT DOES NOT ────────────────────────────────
// A change arriving makes it VISIBLE on the execution file. It does not
// acknowledge it, assess it, revise anything, or move a single date. Every one
// of those is a Merchandising decision made by a person with a capability, on
// a later request. An intake that quietly started revising records would be
// Sales editing Merchandising's work through a side door.
//
// ── STALE AND SUPERSEDED ────────────────────────────────────────────────────
// Delivery is not ordered. A version-2 notice can arrive before version 1, and
// a cancellation before the issue it cancels. Two rules settle every case:
// a notice older than the version already recorded is a NOOP, and a notice for
// a line with no execution file is a NOOP — there is nothing to retry into.
//
// ── AND A PRIOR RECEIPT IS NEVER DESTROYED ──────────────────────────────────
// When version 2 supersedes version 1, Merchandising's receipt on version 1
// moves to SUPERSEDED and keeps its decision. "We acknowledged version 1 on
// the 4th" stays true afterwards.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const { SalesChangeNotice } = require("../../models/CMS_Models/Sales/SalesChangeNotice");
const {
  ChangeIntakeReceipt, ChangeImpact, INTAKE_STATE,
} = require("../../models/CMS_Models/Merchandising/ChangeControl");
const {
  MerchandisingAuditEvent, MerchandisingIntakeLedger,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { CHANGE_EVENT_KINDS } = require("../sales/changeNotice.service");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();

async function withTxn(work) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await work(session); });
    return out;
  } finally { session.endSession(); }
}

/**
 * Which file this change is about.
 *
 * M2.1's permanent line identity — `(companyId, handoverRef, handoverLineRef)`,
 * the unique immutable index — never a style id.
 */
async function resolveFile(event, session) {
  const handoverRef = str(event.payload?.handoverRef);
  const handoverLineRef = str(event.payload?.handoverLineRef);
  if (!handoverRef || !handoverLineRef) return null;
  return ExecutionFile.findOne({
    companyId: event.companyId, handoverRef, handoverLineRef,
  }).session(session);
}

/** The highest change version this file has already seen for this ref. */
async function seenVersionNo(companyId, changeRef, session) {
  const latest = await SalesChangeNotice.findOne({ companyId, changeRef })
    .sort({ versionNo: -1 }).select("versionNo").session(session).lean();
  return latest?.versionNo ?? 0;
}

/* ═══ HANDLERS ═════════════════════════════════════════════════════════════ */

/**
 * A change was issued. Make it visible; decide nothing.
 *
 * The file gains no state and no flag beyond what a query can derive — the
 * open-change count on the register is a COUNT of issued notices with no
 * closed impact, not a mirrored boolean that could drift.
 */
async function onIssued(event, session) {
  const file = await resolveFile(event, session);
  if (!file) {
    return { outcome: "NOOP", note: "No execution file has been opened from that order line." };
  }
  if (str(file.lifecycleStatus) === "CANCELLED") {
    return { outcome: "NOOP", note: "That file was cancelled with the order." };
  }

  const changeRef = str(event.payload?.changeRef);
  const versionNo = Number(event.payload?.versionNo) || 0;

  /* ── NOTHING MOVES BACKWARDS ──────────────────────────────────────────
     An out-of-order redelivery of version 1 must not reopen a change the
     file has already seen version 2 of. */
  const seen = await seenVersionNo(event.companyId, changeRef, session);
  if (seen > versionNo) {
    return {
      outcome: "NOOP",
      note: `Version ${versionNo} arrived after version ${seen}, which is already recorded.`,
    };
  }

  /* Supersede this file's receipt on the previous version — keeping its
     decision, which stays true. */
  const priorReceipts = await ChangeIntakeReceipt.find({
    companyId: event.companyId, fileId: file._id, changeRef,
    changeVersionNo: { $lt: versionNo },
    state: { $in: [INTAKE_STATE.ACKNOWLEDGED, INTAKE_STATE.CLARIFICATION_REQUESTED] },
  }).session(session);
  for (const receipt of priorReceipts) {
    receipt.state = INTAKE_STATE.SUPERSEDED;
    receipt.revision += 1;
    await receipt.save({ session });
  }

  await MerchandisingAuditEvent.create([{
    companyId: event.companyId,
    recordType: "CHANGE_NOTICE",
    recordId: event.payload?.noticeId || event._id,
    recordRevision: versionNo,
    fileId: file._id,
    fileNumber: str(file.fileNumber),
    /* OBSERVED. Sales decided this; Merchandising recorded that it arrived. */
    action: "CHANGE_OBSERVED",
    source: "sales",
    at: event.occurredAt || new Date(),
    correlationId: str(event.correlationId) || crypto.randomUUID(),
    reason: str(event.payload?.reason),
    details: {
      changeRef,
      changeVersionNo: versionNo,
      changeKind: str(event.payload?.changeKind),
      supersededReceipts: priorReceipts.length,
    },
  }], { session, ordered: true });

  return {
    outcome: "APPLIED",
    note: `Change ${changeRef} version ${versionNo} is on the file.`
      + (priorReceipts.length ? ` ${priorReceipts.length} earlier receipt(s) superseded.` : ""),
  };
}

/** A version was replaced. The issue handler already did the work. */
async function onSuperseded(event, session) {
  const file = await resolveFile(event, session);
  if (!file) return { outcome: "NOOP", note: "No execution file for that order line." };
  return {
    outcome: "NOOP",
    note: `Version ${event.payload?.versionNo} was replaced; the successor carries the change.`,
  };
}

/**
 * Sales withdrew the change.
 *
 * Merchandising's receipt and any open impact are marked, and both are KEPT.
 * The assessment happened; a cancelled change does not un-happen the work
 * somebody did on it, and the history has to show that work was done.
 */
async function onCancelled(event, session) {
  const file = await resolveFile(event, session);
  if (!file) return { outcome: "NOOP", note: "No execution file for that order line." };

  const changeRef = str(event.payload?.changeRef);
  const at = event.occurredAt || new Date();
  const correlationId = str(event.correlationId) || crypto.randomUUID();
  const notes = [];

  const receipts = await ChangeIntakeReceipt.find({
    companyId: event.companyId, fileId: file._id, changeRef,
    state: { $in: [INTAKE_STATE.ACKNOWLEDGED, INTAKE_STATE.CLARIFICATION_REQUESTED] },
  }).session(session);
  for (const receipt of receipts) {
    receipt.state = INTAKE_STATE.CANCELLED_BY_SALES;
    receipt.revision += 1;
    await receipt.save({ session });
  }
  if (receipts.length) notes.push(`${receipts.length} receipt(s) withdrawn.`);

  /* An open impact is CLOSED, not deleted — what was assessed stays readable. */
  const impacts = await ChangeImpact.find({
    companyId: event.companyId, fileId: file._id, changeRef,
    state: { $ne: "CLOSED" },
  }).session(session);
  for (const impact of impacts) {
    impact.state = "CLOSED";
    impact.closedAt = at;
    impact.revision += 1;
    await impact.save({ session });
  }
  if (impacts.length) notes.push(`${impacts.length} impact assessment(s) closed.`);

  await MerchandisingAuditEvent.create([{
    companyId: event.companyId,
    recordType: "CHANGE_NOTICE",
    recordId: event.payload?.noticeId || event._id,
    fileId: file._id,
    fileNumber: str(file.fileNumber),
    action: "CHANGE_OBSERVED",
    source: "sales",
    at,
    correlationId,
    reason: str(event.payload?.reason),
    details: {
      changeRef,
      changeVersionNo: Number(event.payload?.versionNo) || null,
      cancelled: true,
    },
  }], { session, ordered: true });

  return {
    outcome: "APPLIED",
    note: notes.concat(`Change ${changeRef} withdrawn by Sales.`).join(" "),
  };
}

const HANDLERS = Object.freeze({
  [CHANGE_EVENT_KINDS.ISSUED]: onIssued,
  [CHANGE_EVENT_KINDS.SUPERSEDED]: onSuperseded,
  [CHANGE_EVENT_KINDS.CANCELLED]: onCancelled,
});

/* ═══ THE DOOR ═════════════════════════════════════════════════════════════ */

async function receive(event) {
  const kind = str(event?.kind);
  const handler = HANDLERS[kind];
  if (!handler) {
    throw fail("VALIDATION",
      `Merchandising cannot receive "${kind}" as a change.`,
      { kind, listensFor: Object.values(CHANGE_EVENT_KINDS) });
  }

  const already = await MerchandisingIntakeLedger.findOne({ sourceEventId: event._id }).lean();
  if (already) {
    return { applied: false, duplicate: true, outcome: already.outcome, note: already.note };
  }

  return withTxn(async (session) => {
    const raced = await MerchandisingIntakeLedger.findOne({ sourceEventId: event._id })
      .session(session).lean();
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
    if (err?.code === 11000) {
      return { applied: false, duplicate: true, outcome: "NOOP", note: "Delivered concurrently." };
    }
    throw err;
  });
}

module.exports = { receive, resolveFile, HANDLERS, onIssued, onSuperseded, onCancelled };
