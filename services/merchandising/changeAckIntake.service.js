// services/merchandising/changeAckIntake.service.js
//
// WHAT EACH AFFECTED APPLICATION SAYS BACK. RECEIVED, NEVER AUTHORED.
//
// The mirror image of `departmentStatusIntake`: Merchandising announces a
// coordinated change, and each application answers for itself. This is the
// only thing that writes a `ChangeAcknowledgement`, and it writes one only
// from an event the answering application published.
//
// There is no route, no service export and no model path that lets
// Merchandising acknowledge on somebody's behalf, and a test scans for all
// three. That absence is what makes the coverage figure mean anything: a
// number Merchandising could top up itself would measure nothing.
//
// ── AN ACKNOWLEDGEMENT IS NOT READINESS ─────────────────────────────────────
// `ACCEPTED` means the application has seen the change and says it applies to
// them. It does not mean they have done anything about it. The register says
// so on every accepted row, because "8 of 8 acknowledged" would otherwise read
// as "8 of 8 done" — and a merchandiser who believed that would stop chasing.
//
// ── AND A STALE ANSWER IS SHOWN, NOT COUNTED ────────────────────────────────
// An acknowledgement naming an older change version is recorded and displayed
// with the version it answered. It is never counted as coverage of the current
// one, because agreeing to what version 1 said is not agreeing to version 2.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const { SalesChangeNotice } = require("../../models/CMS_Models/Sales/SalesChangeNotice");
const {
  ChangeAcknowledgement, AFFECTED_APPLICATION, ACK_STATE,
} = require("../../models/CMS_Models/Merchandising/ChangeControl");
const {
  MerchandisingAuditEvent, MerchandisingIntakeLedger,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();

/** The kind each application publishes. A kind not here is not consumed. */
const ACK_EVENT_KIND = Object.freeze({
  "product_development.change_acknowledgement.recorded": AFFECTED_APPLICATION.PRODUCT_DEVELOPMENT,
  "supply_chain.change_acknowledgement.recorded": AFFECTED_APPLICATION.SUPPLY_CHAIN,
  "store.change_acknowledgement.recorded": AFFECTED_APPLICATION.STORE,
  "ie.change_acknowledgement.recorded": AFFECTED_APPLICATION.IE,
  "ppc.change_acknowledgement.recorded": AFFECTED_APPLICATION.PPC,
  "quality.change_acknowledgement.recorded": AFFECTED_APPLICATION.QUALITY,
  "production.change_acknowledgement.recorded": AFFECTED_APPLICATION.PRODUCTION,
  "logistics.change_acknowledgement.recorded": AFFECTED_APPLICATION.LOGISTICS,
});

const CONSUMED_KINDS = Object.freeze(Object.keys(ACK_EVENT_KIND));
const applicationForKind = (kind) => ACK_EVENT_KIND[str(kind)] || null;

/* ── WHICH APPLICATIONS ACTUALLY ANSWER TODAY ─────────────────────────────
   NONE. No application in this repository publishes any of the eight kinds
   above, so every announced application reads PENDING until one does — and
   PENDING is displayed as "has not answered yet", which is the truth rather
   than a gap. Add a slug here in the same change that makes that app publish,
   never in advance. */
const ANSWERING_APPS = Object.freeze([]);

const MIN_REASON = 15;

async function withTxn(work) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await work(session); });
    return out;
  } finally { session.endSession(); }
}

/**
 * Apply one application's acknowledgement.
 *
 * @returns {Promise<{applied:boolean, duplicate:boolean, outcome:string, note:string}>}
 */
async function receive(event) {
  const kind = str(event?.kind);
  const application = applicationForKind(kind);
  if (!application) {
    throw fail("VALIDATION",
      `Merchandising does not consume "${kind}" as a change acknowledgement.`,
      { kind, listensFor: CONSUMED_KINDS });
  }

  const already = await MerchandisingIntakeLedger.findOne({ sourceEventId: event._id }).lean();
  if (already) {
    return { applied: false, duplicate: true, outcome: already.outcome, note: already.note };
  }

  return withTxn(async (session) => {
    const raced = await MerchandisingIntakeLedger.findOne({ sourceEventId: event._id })
      .session(session).lean();
    if (raced) return { applied: false, duplicate: true, outcome: raced.outcome, note: raced.note };

    const result = await applyEvent(event, application, session);

    await MerchandisingIntakeLedger.create([{
      sourceEventId: event._id,
      sourceKind: kind,
      companyId: event.companyId,
      handoverRef: str(event.payload?.handoverRef),
      handoverLineRef: str(event.payload?.handoverLineRef),
      sourceVersionNo: Number(event.payload?.changeVersionNo) || null,
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

async function applyEvent(event, application, session) {
  const companyId = event.companyId;
  const p = event.payload || {};
  const changeRef = str(p.changeRef);
  const changeVersionNo = Number(p.changeVersionNo);

  if (!changeRef || !Number.isInteger(changeVersionNo)) {
    return { outcome: "NOOP", note: "The event names no change version, so it cannot be attributed." };
  }

  const state = str(p.state).toUpperCase();
  if (!Object.values(ACK_STATE).includes(state)) {
    /* Refused at the boundary, like a department status outside its
       allowlist — never stored as free text. */
    return {
      outcome: "NOOP",
      note: `"${state || "(none)"}" is not an acknowledgement state. Nothing was stored.`,
    };
  }

  const reason = str(p.reason);
  if ([ACK_STATE.CLARIFICATION_REQUESTED, ACK_STATE.REJECTED_AS_INVALID].includes(state)
    && reason.length < MIN_REASON) {
    /* Asking for clarification or saying a change does not apply are both
       statements a merchandiser has to act on. Without a reason there is
       nothing to act on. */
    return {
      outcome: "NOOP",
      note: `${application} sent ${state} without a usable reason. Nothing was stored.`,
    };
  }

  const notice = await SalesChangeNotice.findOne({ companyId, changeRef, versionNo: changeVersionNo })
    .session(session).lean();
  if (!notice) {
    return { outcome: "NOOP", note: `Change ${changeRef} version ${changeVersionNo} is not on record.` };
  }

  const file = await ExecutionFile.findOne({
    companyId, handoverRef: notice.handoverRef, handoverLineRef: notice.handoverLineRef,
  }).session(session).lean();
  if (!file) {
    return { outcome: "NOOP", note: "No execution file matches that order line." };
  }

  const existing = await ChangeAcknowledgement.findOne({
    companyId, changeRef, changeVersionNo, application,
  }).session(session);
  if (existing) {
    /* One answer per application per version. A second is a duplicate, not a
       correction — a later VERSION is how an application changes its mind. */
    return {
      outcome: "NOOP",
      note: `${application} already answered version ${changeVersionNo}.`,
    };
  }

  const at = new Date();
  const [row] = await ChangeAcknowledgement.create([{
    companyId,
    changeRef,
    changeVersionNo,
    application,
    fileId: file._id,
    state,
    reason: reason.slice(0, 2000),
    /* The receiver's own person. Merchandising never fills this in. */
    acknowledgedBy: p.actor && typeof p.actor === "object"
      ? { name: str(p.actor.name), email: str(p.actor.email) }
      : undefined,
    acknowledgedAt: p.acknowledgedAt ? new Date(p.acknowledgedAt) : at,
    sourceEventId: event._id,
  }], { session });

  await MerchandisingAuditEvent.create([{
    companyId,
    recordType: "CHANGE_IMPACT",
    recordId: row._id,
    fileId: file._id,
    fileNumber: str(file.fileNumber),
    /* RECEIVED, not recorded-by. Passive, because Merchandising did not
       decide it. */
    action: "CHANGE_ACK_RECEIVED",
    source: "merchandising",
    at,
    correlationId: str(event.correlationId) || crypto.randomUUID(),
    reason,
    details: {
      changeRef, changeVersionNo, application, ackState: state,
      sourceEventId: str(event._id),
    },
  }], { session, ordered: true });

  return {
    outcome: "APPLIED",
    note: `${application} answered ${state} on version ${changeVersionNo}.`,
  };
}

module.exports = {
  ACK_EVENT_KIND, CONSUMED_KINDS, applicationForKind, ANSWERING_APPS, MIN_REASON,
  receive, applyEvent,
};
