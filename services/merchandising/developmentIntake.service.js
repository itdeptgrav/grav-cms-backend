// services/merchandising/developmentIntake.service.js
//
// RECEIVING A SALES DEVELOPMENT REQUEST, AND OPENING THE FILE.
//
// The `handoverIntake.service.js` pattern, one stage earlier: one handler per
// event kind, `{outcome, note}`, a ledger row keyed on the unique and
// immutable `sourceEventId`, `11000` treated as a duplicate.
//
// ── WHAT ARRIVING DOES ──────────────────────────────────────────────────────
// Opens a Development File, in state NEW, and nothing else. It does not
// accept the request, assign anybody, select a single material or approve
// anything — every one of those is a Merchandising decision made by a person
// with a capability, on a later request.
//
// The file is opened rather than merely queued because the file IS the queue:
// a request with nowhere to land would leave a merchandiser reading Sales'
// records to find their own work.
//
// ── AND SALES NEVER TOUCHES IT ──────────────────────────────────────────────
// This service is the only thing that creates a Development File from a Sales
// event, and it lives in Merchandising. Sales publishes; Merchandising's own
// receiver decides what that means for Merchandising's records — the same
// inversion M1 established, for the same reason.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const {
  SalesDevelopmentRequest,
} = require("../../models/CMS_Models/Sales/DevelopmentRequest");
const {
  DevelopmentFile, DevelopmentRequestReceipt, DevelopmentBomRevision,
  RECEIPT_STATE, LIFECYCLE,
} = require("../../models/CMS_Models/Merchandising/Development");
const {
  MerchandisingAuditEvent, MerchandisingIntakeLedger,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { DEVELOPMENT_EVENT_KINDS } = require("../sales/developmentRequest.service");
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

/** `MDV-YYYY-NNNN`, minted from a per-company yearly counter. */
async function mintDevelopmentNumber(companyId, session) {
  const year = new Date().getUTCFullYear();
  const prefix = `MDV-${year}-`;
  const last = await DevelopmentFile.findOne({
    companyId, developmentNumber: new RegExp(`^${prefix}`),
  }).sort({ developmentNumber: -1 }).select("developmentNumber").session(session).lean();
  const next = last ? Number(str(last.developmentNumber).slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

/* ═══ HANDLERS ═════════════════════════════════════════════════════════════ */

/**
 * A request was issued. Open the file, or record the new version on it.
 *
 * The file's grain is the product line, so a reissue lands on the SAME file:
 * a merchandiser who has already selected fabric against version 1 keeps
 * their work and sees that the brief moved.
 */
async function onIssued(event, session) {
  const companyId = event.companyId;
  const p = event.payload || {};
  const requestRef = str(p.requestRef);
  const versionNo = Number(p.requestVersionNo) || 0;
  const productLineRef = str(p.productLineRef);

  const request = await SalesDevelopmentRequest.findOne({
    companyId, requestRef, versionNo,
  }).session(session).lean();
  if (!request) {
    return { outcome: "NOOP", note: `Request ${requestRef} version ${versionNo} is not on record.` };
  }

  const at = event.occurredAt || new Date();
  const correlationId = str(event.correlationId) || crypto.randomUUID();

  let file = await DevelopmentFile.findOne({
    companyId, journeyId: request.journeyId, productLineRef,
  }).session(session);

  /* ── NOTHING MOVES BACKWARDS ────────────────────────────────────────── */
  if (file && Number(file.currentRequestVersionNo) > versionNo) {
    return {
      outcome: "NOOP",
      note: `Version ${versionNo} arrived after version ${file.currentRequestVersionNo}.`,
    };
  }

  let created = false;
  if (!file) {
    [file] = await DevelopmentFile.create([{
      developmentNumber: await mintDevelopmentNumber(companyId, session),
      companyId,
      journeyId: request.journeyId,
      journeyRef: str(request.journeyRef),
      productLineRef,
      currentRequestId: request._id,
      currentRequestVersionNo: versionNo,
      requestHistory: [{
        requestId: request._id, versionNo, event: "ISSUED", at, by: event.actor || undefined,
      }],
      productName: str(request.productName),
      styleRef: str(request.styleRef),
      buyerDisplayLabel: str(request.buyerDisplayLabel),
      sampleStyleId: request.sampleStyleId || null,
      stockItemId: request.stockItemId || null,
      requiredByDate: request.requiredByDate || null,
      lifecycleStatus: LIFECYCLE.NEW,
    }], { session });
    created = true;
  } else {
    /* A reissue against an existing file. Merchandising's selection is kept —
       the brief moved, the work did not vanish — and the receipt on the
       previous version is superseded so the file asks to be answered again. */
    const prior = await DevelopmentRequestReceipt.find({
      companyId, developmentFileId: file._id,
      requestVersionNo: { $lt: versionNo },
      state: { $in: [RECEIPT_STATE.ACCEPTED, RECEIPT_STATE.CLARIFICATION_REQUESTED] },
    }).session(session);
    for (const receipt of prior) {
      receipt.state = RECEIPT_STATE.SUPERSEDED;
      receipt.revision += 1;
      await receipt.save({ session });
    }
    file.currentRequestId = request._id;
    file.currentRequestVersionNo = versionNo;
    file.requestHistory.push({
      requestId: request._id, versionNo, event: "REISSUED", at, by: event.actor || undefined,
    });
    /* An approved file whose brief has changed is no longer settled. It goes
       back to ACTIVE; the approved BOM revision stays exactly as it is, and a
       merchandiser decides whether it still answers the new brief. */
    if ([LIFECYCLE.APPROVED, LIFECYCLE.AWAITING_APPROVAL].includes(file.lifecycleStatus)) {
      file.lifecycleStatus = LIFECYCLE.ACTIVE;
      file.lifecycleReason = `Sales reissued the request as version ${versionNo}.`;
    }
    file.revision += 1;
    await file.save({ session });
  }

  await MerchandisingAuditEvent.create([{
    companyId,
    recordType: "DEVELOPMENT_REQUEST",
    recordId: request._id,
    recordRevision: versionNo,
    developmentFileId: file._id,
    developmentNumber: str(file.developmentNumber),
    /* OBSERVED. Sales asked; Merchandising recorded that it arrived. */
    action: created ? "DEVELOPMENT_FILE_CREATED" : "DEVELOPMENT_OBSERVED",
    source: "sales",
    at,
    correlationId,
    reason: str(request.requirementSummary).slice(0, 1000),
    details: {
      requestRef, requestVersionNo: versionNo, productLineRef,
      developmentNumber: str(file.developmentNumber),
    },
  }], { session, ordered: true });

  return {
    outcome: "APPLIED",
    note: created
      ? `Development file ${file.developmentNumber} opened.`
      : `Request version ${versionNo} recorded on ${file.developmentNumber}.`,
  };
}

/** A version was replaced. The issue handler already did the work. */
async function onSuperseded(event) {
  return {
    outcome: "NOOP",
    note: `Version ${event.payload?.requestVersionNo} was replaced; the successor carries it.`,
  };
}

/** Sales withdrew the request. The file is cancelled; nothing is deleted. */
async function onCancelled(event, session) {
  const companyId = event.companyId;
  const p = event.payload || {};
  const file = await DevelopmentFile.findOne({
    companyId, journeyId: p.journeyId, productLineRef: str(p.productLineRef),
  }).session(session);
  if (!file) return { outcome: "NOOP", note: "No development file was opened from that request." };
  if (file.lifecycleStatus === LIFECYCLE.CANCELLED) {
    return { outcome: "NOOP", note: "That file was already cancelled." };
  }

  const at = event.occurredAt || new Date();
  const previous = file.lifecycleStatus;
  file.lifecycleStatus = LIFECYCLE.CANCELLED;
  file.lifecycleReason = str(p.reason).slice(0, 500);
  file.revision += 1;
  await file.save({ session });

  const receipts = await DevelopmentRequestReceipt.find({
    companyId, developmentFileId: file._id,
    state: { $in: [RECEIPT_STATE.ACCEPTED, RECEIPT_STATE.CLARIFICATION_REQUESTED] },
  }).session(session);
  for (const receipt of receipts) {
    receipt.state = RECEIPT_STATE.CANCELLED_BY_SALES;
    receipt.revision += 1;
    await receipt.save({ session });
  }

  await MerchandisingAuditEvent.create([{
    companyId,
    recordType: "DEVELOPMENT_FILE",
    recordId: file._id,
    recordRevision: file.revision,
    developmentFileId: file._id,
    developmentNumber: str(file.developmentNumber),
    action: "DEVELOPMENT_OBSERVED",
    source: "sales",
    at,
    correlationId: str(event.correlationId) || crypto.randomUUID(),
    reason: str(p.reason),
    previousState: previous,
    resultingState: LIFECYCLE.CANCELLED,
    details: { requestRef: str(p.requestRef), cancelled: true },
  }], { session, ordered: true });

  /* The approved BOM is NOT touched. A cancelled opportunity does not
     un-happen the selection somebody made, and the record of it is history. */
  return { outcome: "APPLIED", note: `Development file ${file.developmentNumber} cancelled.` };
}

/**
 * SALES AUTHORISED RELEASE TO R&D.
 *
 * Mirrored onto the file. Merchandising cannot produce this state itself —
 * there is no route for it, and the refusal that would be raised if somebody
 * tried names Sales as the owner.
 */
async function onReleased(event, session) {
  const companyId = event.companyId;
  const p = event.payload || {};
  const file = await DevelopmentFile.findOne({
    companyId, journeyId: p.journeyId, productLineRef: str(p.productLineRef),
  }).session(session);
  if (!file) return { outcome: "NOOP", note: "No development file matches that request." };

  if (file.lifecycleStatus !== LIFECYCLE.APPROVED) {
    /* Releasing something Merchandising has not settled would send R&D a
       selection that could still change underneath them. */
    return {
      outcome: "NOOP",
      note: `${file.developmentNumber} is ${str(file.lifecycleStatus).toLowerCase()}, not approved. `
        + "Nothing was released.",
    };
  }

  const at = event.occurredAt || new Date();
  const previous = file.lifecycleStatus;
  file.lifecycleStatus = LIFECYCLE.RELEASED_TO_RND;
  file.releasedToRndAt = at;
  file.releasedBy = event.actor || undefined;
  file.releaseReference = str(p.releaseReference);
  file.revision += 1;
  await file.save({ session });

  await MerchandisingAuditEvent.create([{
    companyId,
    recordType: "DEVELOPMENT_FILE",
    recordId: file._id,
    recordRevision: file.revision,
    developmentFileId: file._id,
    developmentNumber: str(file.developmentNumber),
    action: "DEVELOPMENT_RELEASED_BY_SALES",
    /* Sales' act, recorded in Merchandising's history and attributed to them. */
    actor: event.actor || undefined,
    source: "sales",
    at,
    correlationId: str(event.correlationId) || crypto.randomUUID(),
    reason: str(p.reason),
    previousState: previous,
    resultingState: LIFECYCLE.RELEASED_TO_RND,
    details: {
      requestRef: str(p.requestRef),
      releaseReference: str(p.releaseReference),
      bomRevisionNo: file.currentBomRevisionNo,
    },
  }], { session, ordered: true });

  return {
    outcome: "APPLIED",
    note: `${file.developmentNumber} released to R&D against BOM revision ${file.currentBomRevisionNo}.`,
  };
}

const HANDLERS = Object.freeze({
  [DEVELOPMENT_EVENT_KINDS.ISSUED]: onIssued,
  [DEVELOPMENT_EVENT_KINDS.SUPERSEDED]: onSuperseded,
  [DEVELOPMENT_EVENT_KINDS.CANCELLED]: onCancelled,
  [DEVELOPMENT_EVENT_KINDS.RELEASED]: onReleased,
});

/* ═══ THE DOOR ═════════════════════════════════════════════════════════════ */

async function receive(event) {
  const kind = str(event?.kind);
  const handler = HANDLERS[kind];
  if (!handler) {
    throw fail("VALIDATION",
      `Merchandising cannot receive "${kind}" as a development request.`,
      { kind, listensFor: Object.values(DEVELOPMENT_EVENT_KINDS) });
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
      handoverRef: str(event.payload?.requestRef),
      handoverLineRef: str(event.payload?.productLineRef),
      sourceVersionNo: Number(event.payload?.requestVersionNo) || null,
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

module.exports = {
  receive, HANDLERS, mintDevelopmentNumber,
  onIssued, onSuperseded, onCancelled, onReleased,
};
