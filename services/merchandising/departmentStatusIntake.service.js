// services/merchandising/departmentStatusIntake.service.js
//
// THE ONLY THING THAT MAY WRITE A DEPARTMENT'S STATUS.
//
// Copied in mechanism from `handoverIntake.service.js`, because that is the
// audited receiver pattern: one handler per event kind,
// `{outcome: "APPLIED"|"NOOP", note}`, a ledger row keyed on the unique and
// immutable `sourceEventId`, and `11000` treated as a duplicate rather than a
// failure — idempotency as a DATABASE fact, not as a property of however
// carefully the handler was written.
//
// ── THE ALLOWLIST IS A REFUSAL, NOT A FILTER ────────────────────────────────
// A `statusCode` outside its department's list is a NOOP with the reason. It
// is never stored, never rendered, never coerced to something near it. If Store
// starts sending a status nobody agreed to, the register keeps saying what it
// last legitimately knew and the ledger records that something arrived and was
// declined — which is a bug report, where silently displaying it would be a
// bug in production wearing Merchandising's chrome.
//
// ── STALE EVENTS ────────────────────────────────────────────────────────────
// Delivery is not ordered. An event is applied only when its `sourceObservedAt`
// is LATER than the current row's, so a redelivered old status cannot roll the
// register backwards. An older event is a NOOP with a note saying so — not a
// failure, because there is nothing to retry into.
//
// ── AND SUPERSEDING KEEPS THE PREVIOUS ROW ──────────────────────────────────
// The old row is marked `isCurrent: false` and stays. "Store said
// PARTIALLY_RECEIVED on the 3rd and RECEIVED on the 9th" is exactly the
// history somebody needs when a shortage turns up later.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const {
  DepartmentStatusProjection,
} = require("../../models/CMS_Models/Merchandising/DepartmentStatusProjection");
const {
  MerchandisingAuditEvent, MerchandisingIntakeLedger,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const contract = require("./departmentStatus.contract");
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
 * Which file an event is about.
 *
 * Resolved by M2.1's permanent line identity — `(companyId, handoverRef,
 * handoverLineRef)`, the unique immutable index — never by a style id. A style
 * can appear on two commercial lines of one order; a line reference cannot.
 */
async function resolveFile(event, session) {
  const companyId = event.companyId;
  const direct = event.payload?.executionFileId || event.recordId;
  if (direct) {
    const byId = await ExecutionFile.findOne({ _id: direct, companyId }).session(session).lean();
    if (byId) return byId;
  }
  const handoverRef = str(event.payload?.handoverRef);
  const handoverLineRef = str(event.payload?.handoverLineRef);
  if (!handoverRef || !handoverLineRef) return null;
  return ExecutionFile.findOne({ companyId, handoverRef, handoverLineRef }).session(session).lean();
}

/* ═══ THE DOOR ═════════════════════════════════════════════════════════════ */

/**
 * Apply one source department's event.
 *
 * @returns {Promise<{applied:boolean, duplicate:boolean, outcome:string, note:string}>}
 */
async function receive(event) {
  const kind = str(event?.kind);
  const department = contract.departmentForKind(kind);
  if (!department) {
    /* Not a delivery to retry for ever — a contract this receiver does not
       implement, and saying so is more useful than a queue that never drains. */
    throw fail("VALIDATION",
      `Merchandising does not consume "${kind}" as a department status.`,
      { kind, listensFor: contract.CONSUMED_KINDS });
  }

  const already = await MerchandisingIntakeLedger.findOne({ sourceEventId: event._id }).lean();
  if (already) {
    return { applied: false, duplicate: true, outcome: already.outcome, note: already.note };
  }

  return withTxn(async (session) => {
    const raced = await MerchandisingIntakeLedger.findOne({ sourceEventId: event._id })
      .session(session).lean();
    if (raced) return { applied: false, duplicate: true, outcome: raced.outcome, note: raced.note };

    const result = await applyEvent(event, department, session);

    await MerchandisingIntakeLedger.create([{
      sourceEventId: event._id,
      sourceKind: kind,
      companyId: event.companyId,
      handoverRef: str(event.payload?.handoverRef),
      handoverLineRef: str(event.payload?.handoverLineRef),
      sourceVersionNo: Number(event.payload?.sourceRecordVersion) || null,
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

async function applyEvent(event, department, session) {
  const companyId = event.companyId;
  const p = event.payload || {};

  const file = await resolveFile(event, session);
  if (!file) {
    return { outcome: "NOOP", note: "No execution file matches that order line." };
  }
  /* A cancelled order has no coordination left to inform. Not a failure —
     there is nothing this event could ever usefully be retried into. */
  if (str(file.lifecycleStatus) === "CANCELLED") {
    return { outcome: "NOOP", note: "That file was cancelled with the order." };
  }

  const statusCode = str(p.statusCode).toUpperCase();
  if (!contract.isAllowedStatus(department, statusCode)) {
    /* Refused at the boundary — see the header. Recorded so the producer's
       bug is visible rather than silent. */
    return {
      outcome: "NOOP",
      note: `"${statusCode || "(none)"}" is not a status ${contract.DEPARTMENT_WORDS[department]} `
        + "may report. Nothing was stored.",
    };
  }

  const sourceRecordRef = str(p.sourceRecordRef);
  if (!sourceRecordRef) {
    return { outcome: "NOOP", note: "The event names no source record, so it cannot be attributed." };
  }

  const sourceObservedAt = p.sourceObservedAt || event.occurredAt || event.createdAt || new Date();
  const observed = new Date(sourceObservedAt);
  if (Number.isNaN(observed.getTime())) {
    return { outcome: "NOOP", note: "The event carries no usable observation time." };
  }

  const current = await DepartmentStatusProjection.findOne({
    companyId, fileId: file._id, department, sourceRecordRef, isCurrent: true,
  }).session(session);

  /* ── NOTHING MOVES BACKWARDS ────────────────────────────────────────────
     An out-of-order redelivery of an older statement must not overwrite the
     newer one the register is already showing. */
  if (current && new Date(current.sourceObservedAt).getTime() >= observed.getTime()) {
    return {
      outcome: "NOOP",
      note: `A ${contract.DEPARTMENT_WORDS[department]} statement from `
        + `${new Date(current.sourceObservedAt).toISOString()} is already recorded; this one is older.`,
    };
  }

  const at = new Date();
  const correlationId = str(event.correlationId) || crypto.randomUUID();

  /* Step the old row down BEFORE creating the new one: the partial unique
     index allows exactly one current row and is checked per write. */
  if (current) {
    current.isCurrent = false;
    await current.save({ session });
  }

  const [row] = await DepartmentStatusProjection.create([{
    companyId,
    fileId: file._id,
    projectionRef: `DSP-${crypto.randomBytes(5).toString("hex")}`,
    department,
    sourceApp: str(p.sourceApp) || department.toLowerCase(),
    sourceRecordType: str(p.sourceRecordType),
    sourceRecordRef,
    sourceRecordVersion: Number.isFinite(Number(p.sourceRecordVersion))
      ? Number(p.sourceRecordVersion) : null,
    statusCode,
    statusLabel: str(p.statusLabel).slice(0, 200),
    availability: str(p.availability).toUpperCase() === contract.AVAILABILITY.NOT_APPLICABLE
      ? contract.AVAILABILITY.NOT_APPLICABLE
      : contract.AVAILABILITY.AVAILABLE,
    unitDiscriminator: str(p.unitDiscriminator),
    sourceObservedAt: observed,
    receivedAt: at,
    sourceEventId: event._id,
    isCurrent: true,
  }], { session });

  if (current) {
    current.supersededByProjectionId = row._id;
    await current.save({ session });
  }

  await MerchandisingAuditEvent.create([{
    companyId,
    recordType: "DEPARTMENT_STATUS",
    recordId: row._id,
    fileId: file._id,
    fileNumber: str(file.fileNumber),
    /* OBSERVED, not recorded-by. Nobody in Merchandising decided this. */
    action: "DEPARTMENT_STATUS_OBSERVED",
    source: "merchandising",
    at,
    correlationId,
    reason: "",
    details: {
      department,
      statusCode,
      availability: row.availability,
      sourceRecordRef,
      sourceEventId: str(event._id),
      previousStatusCode: current ? str(current.statusCode) : null,
    },
  }], { session, ordered: true });

  return {
    outcome: "APPLIED",
    note: `${contract.DEPARTMENT_WORDS[department]} reported ${statusCode}.`,
  };
}

/* ── WHY THERE IS NO `drain()` HERE ────────────────────────────────────────
 *
 * The T&A intake has one, because the events it consumes are Merchandising's
 * OWN — M4 approval events, sitting in Merchandising's own outbox, which a
 * sweep can legitimately walk.
 *
 * These eight are different: they belong to Product Development, Supply Chain,
 * Store, IE, PPC, Quality, Production and Logistics. Their events live in
 * THEIR stores, and Merchandising's outbox is for what Merchandising
 * announces — putting another application's event kinds into it would be
 * Merchandising publishing on their behalf, which is the same inversion this
 * whole milestone exists to prevent.
 *
 * So the integration point is `receive(event)`, called by the producing
 * application's own delivery carrier after its own transaction commits —
 * exactly how `salesHandoverDelivery` calls `handoverIntake.receive`. The
 * event is a plain object; it does not have to be persisted anywhere
 * Merchandising owns.
 *
 * No application in this repository publishes any of the eight kinds yet, so
 * every department currently reads UNKNOWN or UNAVAILABLE — and the register
 * says exactly that rather than showing a gap. When one starts publishing, it
 * calls this door and nothing here changes.
 */

module.exports = { receive, applyEvent, resolveFile };
