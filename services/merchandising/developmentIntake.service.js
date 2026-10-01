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
  RECEIPT_STATE, LIFECYCLE, BOM_STATE,
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

  /* ── THE EVENT SAYS WHICH REVISION, AND THIS DOES NOT ARGUE WITH IT ────
     Sales bound `{companyId, developmentFileId, revisionNo}` at the moment of
     authorisation. Reading `file.currentBomRevisionNo` here instead — which is
     what this handler used to do — quietly substitutes whatever is current at
     DELIVERY time, and delivery is asynchronous. A revision approved in the
     gap would be released to R&D having been reviewed by nobody.

     So the transported identity is verified, never re-derived. Every part of
     it has to agree with Merchandising's own records: the file the event names
     must be the file this line resolves to, and the revision must exist under
     that company and that file, in the state it was released in. A revision
     belonging to another file, line, journey or company matches none of that
     and is refused. */
  const claimedFileId = str(p.developmentFileId);
  const claimedRevisionNo = Number(p.bomRevisionNo);

  if (!claimedFileId || !Number.isInteger(claimedRevisionNo) || claimedRevisionNo < 1) {
    return {
      outcome: "NOOP",
      note: `${file.developmentNumber} was released without naming a BOM revision. Nothing was released.`,
    };
  }
  if (claimedFileId !== str(file._id)) {
    return {
      outcome: "NOOP",
      note: `That release names development file ${claimedFileId}, which is not `
        + `${file.developmentNumber}. Nothing was released.`,
    };
  }

  const bound = await DevelopmentBomRevision.findOne({
    companyId,
    developmentFileId: file._id,
    revisionNo: claimedRevisionNo,
    state: BOM_STATE.APPROVED,
  }).select("revisionNo").session(session).lean();
  if (!bound) {
    return {
      outcome: "NOOP",
      note: `${file.developmentNumber} has no approved revision ${claimedRevisionNo} to release. `
        + "Nothing was released.",
    };
  }

  const at = event.occurredAt || new Date();
  const previous = file.lifecycleStatus;
  file.lifecycleStatus = LIFECYCLE.RELEASED_TO_RND;
  file.releasedToRndAt = at;
  file.releasedBy = event.actor || undefined;
  file.releaseReference = str(p.releaseReference);
  /* What R&D is working against, recorded on the file as its own fact rather
     than left to be inferred from a pointer that keeps moving. */
  file.releasedBomRevisionNo = bound.revisionNo;
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
      developmentFileId: str(file._id),
      bomRevisionNo: bound.revisionNo,
    },
  }], { session, ordered: true });

  return {
    outcome: "APPLIED",
    note: `${file.developmentNumber} released to R&D against BOM revision ${bound.revisionNo}.`,
  };
}

/**
 * SALES ASKED FOR THE SELECTION TO CHANGE.
 *
 * The other half of the Sales decision, and the mirror of `onReleased`: the
 * same binding is verified the same way, and what changes is what it means
 * for Merchandising's records.
 *
 * ── WHAT IT DOES, AND WHAT IT REFUSES TO DO ─────────────────────────────────
 * The approved revision is NOT touched. It stays APPROVED, with its rows, its
 * approver and its dates exactly as they were — R&D and Costing may already
 * have read it, and a history that changes under a reader is not history. The
 * successor is a NEW DRAFT cloned from it, which is the same device
 * Merchandising's own `createDraft(fromRevisionNo)` uses.
 *
 * ── AND IT DOES NOT MAKE SALES THE AUTHOR ───────────────────────────────────
 * `createdBy` is deliberately left empty. Sales did not choose these
 * materials — they are Merchandising's rows, carried forward — and stamping
 * the salesperson on them would put their name on a technical selection they
 * are not competent to make and did not make. It would also defeat
 * maker/checker: `approveBom` refuses an approval by the revision's author,
 * so a Sales-authored draft would silently narrow who in Merchandising may
 * approve it.
 *
 * What IS recorded against Sales is the thing Sales actually did:
 * `changesRequestedBy` and `changeReason`. The merchandiser who then edits
 * and submits becomes `submittedBy`, and a different colleague approves.
 */
async function onChangesRequested(event, session) {
  const companyId = event.companyId;
  const p = event.payload || {};
  const file = await DevelopmentFile.findOne({
    companyId, journeyId: p.journeyId, productLineRef: str(p.productLineRef),
  }).session(session);
  if (!file) return { outcome: "NOOP", note: "No development file matches that request." };

  const claimedFileId = str(p.developmentFileId);
  const claimedRevisionNo = Number(p.bomRevisionNo);
  const reason = str(p.reason);

  if (!claimedFileId || !Number.isInteger(claimedRevisionNo) || claimedRevisionNo < 1) {
    return {
      outcome: "NOOP",
      note: `${file.developmentNumber} had changes requested without naming a revision. Nothing was reopened.`,
    };
  }
  if (claimedFileId !== str(file._id)) {
    return {
      outcome: "NOOP",
      note: `That decision names development file ${claimedFileId}, which is not `
        + `${file.developmentNumber}. Nothing was reopened.`,
    };
  }
  /* ── A RELEASED FILE IS REOPENED ONLY BY A DECISION THAT SAID SO ──────
     An ordinary review decision that arrives after a release is stale
     delivery: it answered a question the record has since moved past, and
     reopening on it would undo a release nobody meant to undo. A reopen
     decision is the opposite — it was taken KNOWING the line was released,
     and the flag is how it says so. */
  const reopening = Boolean(p.reopenReleased);
  if (file.lifecycleStatus === LIFECYCLE.RELEASED_TO_RND && !reopening) {
    return {
      outcome: "NOOP",
      note: `${file.developmentNumber} was already released to R&D. Nothing was reopened.`,
    };
  }
  if (reopening && file.lifecycleStatus !== LIFECYCLE.RELEASED_TO_RND) {
    return {
      outcome: "NOOP",
      note: `${file.developmentNumber} is ${str(file.lifecycleStatus).toLowerCase()}, not released. `
        + "Nothing was reopened.",
    };
  }
  if (reopening && Number(file.releasedBomRevisionNo) !== claimedRevisionNo) {
    return {
      outcome: "NOOP",
      note: `${file.developmentNumber} released revision ${file.releasedBomRevisionNo}, `
        + `not revision ${claimedRevisionNo}. Nothing was reopened.`,
    };
  }

  const approved = await DevelopmentBomRevision.findOne({
    companyId, developmentFileId: file._id, revisionNo: claimedRevisionNo,
    state: BOM_STATE.APPROVED,
  }).session(session);
  if (!approved) {
    return {
      outcome: "NOOP",
      note: `${file.developmentNumber} has no approved revision ${claimedRevisionNo} to send back. `
        + "Nothing was reopened.",
    };
  }

  /* ── ONE SUCCESSOR, HOWEVER MANY TIMES THIS ARRIVES ──────────────────
     A draft already open means this decision has been applied — by an earlier
     delivery of the same event, or by a merchandiser who has since started
     work. Either way a second draft is two answers to one question, and the
     partial unique index would refuse it. */
  const existingDraft = await DevelopmentBomRevision.findOne({
    companyId, developmentFileId: file._id, state: BOM_STATE.DRAFT,
  }).session(session).lean();
  if (existingDraft) {
    return {
      outcome: "NOOP",
      note: `${file.developmentNumber} already has revision ${existingDraft.revisionNo} open as a draft.`,
    };
  }

  const at = event.occurredAt || new Date();
  const highest = await DevelopmentBomRevision.findOne({
    companyId, developmentFileId: file._id,
  }).sort({ revisionNo: -1 }).select("revisionNo").session(session).lean();
  const revisionNo = (highest?.revisionNo || 0) + 1;

  const [draft] = await DevelopmentBomRevision.create([{
    companyId,
    developmentFileId: file._id,
    revisionNo,
    state: BOM_STATE.DRAFT,
    /* Merchandising's rows, carried forward unchanged, to be revised by
       Merchandising. */
    rows: (approved.rows || []).map((r) => ({ ...(r.toObject ? r.toObject() : r) })),
    clonedFromRevisionNo: approved.revisionNo,
    /* NOT `createdBy`. See the note above this function. */
    changesRequestedBy: event.actor || undefined,
    changesRequestedAt: at,
    changesRequestedSource: "SALES",
    changeReason: reason.slice(0, 2000),
  }], { session });

  const previous = file.lifecycleStatus;
  file.lifecycleStatus = LIFECYCLE.ACTIVE;
  file.lifecycleReason = reopening
    ? `Sales reopened released revision ${approved.revisionNo} at the customer's request.`
    : `Sales asked for changes to revision ${approved.revisionNo}.`;
  /* ── THE RELEASE IS NOT ERASED ────────────────────────────────────────
     `releasedToRndAt`, `releasedBy`, `releaseReference` and
     `releasedBomRevisionNo` are all left exactly as they are, including on a
     reopen. They record a decision that was taken and work that was done
     against it; the file moving on does not make either of those untrue.
     They are also what the staleness comparison reads, so clearing them here
     would make a superseded release look like no release at all. */
  file.revision += 1;
  await file.save({ session });

  await MerchandisingAuditEvent.create([{
    companyId,
    recordType: "DEVELOPMENT_BOM",
    recordId: draft._id,
    recordRevision: draft.revision,
    developmentFileId: file._id,
    developmentNumber: str(file.developmentNumber),
    action: "DEVELOPMENT_CHANGES_REQUESTED_BY_SALES",
    actor: event.actor || undefined,
    source: "sales",
    at,
    correlationId: str(event.correlationId) || crypto.randomUUID(),
    reason,
    previousState: previous,
    resultingState: LIFECYCLE.ACTIVE,
    details: {
      requestRef: str(p.requestRef),
      reviewedBomRevisionNo: approved.revisionNo,
      openedBomRevisionNo: revisionNo,
      reopenedRelease: reopening,
      ...(reopening ? { releasedBomRevisionNo: Number(file.releasedBomRevisionNo) } : {}),
    },
  }], { session, ordered: true });

  return {
    outcome: "APPLIED",
    note: reopening
      ? `Sales reopened released revision ${approved.revisionNo} of ${file.developmentNumber}. `
        + `Revision ${revisionNo} is open as a draft; the release stays on the record.`
      : `Sales asked for changes to revision ${approved.revisionNo} of ${file.developmentNumber}. `
        + `Revision ${revisionNo} is open as a draft.`,
  };
}

const HANDLERS = Object.freeze({
  [DEVELOPMENT_EVENT_KINDS.ISSUED]: onIssued,
  [DEVELOPMENT_EVENT_KINDS.SUPERSEDED]: onSuperseded,
  [DEVELOPMENT_EVENT_KINDS.CANCELLED]: onCancelled,
  [DEVELOPMENT_EVENT_KINDS.RELEASED]: onReleased,
  [DEVELOPMENT_EVENT_KINDS.CHANGES_REQUESTED]: onChangesRequested,
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
  }).catch(async (err) => {
    if (err?.code !== 11000) throw err;
    return classifyDuplicate(err, event);
  });
}

/**
 * A DUPLICATE KEY IS NOT AUTOMATICALLY A DUPLICATE DELIVERY.
 *
 * This used to treat EVERY `11000` as "delivered concurrently" — an answer
 * that reports success and applies nothing. That is only true for a key whose
 * collision genuinely means "this work is already done". For any other key it
 * reported a failed write as a completed one, and the caller never found out.
 *
 * The concrete case it hid: `developmentNumber` was globally unique while the
 * number is allocated per company, so the SECOND company's first file of a
 * year always collided. The file was never created, the Sales request sat
 * ISSUED with no Merchandising file behind it, and the ledger said the event
 * had been delivered. The index is company-scoped now, and this is the guard
 * that stops the same class of mistake being silent next time.
 *
 * Two keys, and only two, mean the work is already done:
 *
 *   · the ledger's own `sourceEventId` — this exact event was applied by a
 *     concurrent delivery of it;
 *   · the development file's line identity — a file already exists for this
 *     company, journey and permanent product line, which is exactly what this
 *     delivery would have created. It is re-read and CHECKED rather than
 *     assumed, so the claim in the note is one the record supports.
 *
 * Anything else is a real write failure. It is re-thrown, the ledger row is
 * never written, and the outbox retries the event.
 */
async function classifyDuplicate(err, event) {
  const key = err?.keyPattern || {};

  if (key.sourceEventId) {
    return { applied: false, duplicate: true, outcome: "NOOP", note: "Delivered concurrently." };
  }

  if (key.companyId && key.journeyId && key.productLineRef) {
    const p = event?.payload || {};
    const existing = await DevelopmentFile.findOne({
      companyId: event.companyId,
      journeyId: p.journeyId,
      productLineRef: str(p.productLineRef),
    }).select("_id developmentNumber").lean();
    if (existing) {
      return {
        applied: false, duplicate: true, outcome: "NOOP",
        note: `Development file ${existing.developmentNumber} already exists for this product line.`,
      };
    }
  }

  /* Named, so the retry that follows is investigated rather than shrugged at.
     `keyValue` says which value collided, which is the whole diagnosis. */
  throw fail("CONFLICT",
    "Merchandising could not record that development request. Nothing was applied; it will be retried.",
    { index: Object.keys(key).join("+") || "unknown", value: err?.keyValue || {} });
}

module.exports = {
  receive, HANDLERS, mintDevelopmentNumber, classifyDuplicate,
  onIssued, onSuperseded, onCancelled, onReleased, onChangesRequested,
};
