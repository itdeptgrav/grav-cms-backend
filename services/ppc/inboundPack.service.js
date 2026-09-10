// services/ppc/inboundPack.service.js
//
// PPC'S SIDE OF THE HANDOVER. PPC WRITES; MERCHANDISING DOES NOT.
//
// This is the inversion that makes M6's exit condition true. Merchandising
// submits a pack and announces it. Everything after that — reading the queue,
// accepting, asking for clarification — happens here, behind PPC's own live
// grant, writing PPC's own record.
//
// Nothing in `services/merchandising/` imports this module or the receipt
// model, and a test scans for it. The reverse direction is a READ: this
// service reads the pack it is deciding about, because a decision needs
// something to decide about, and it writes back to Merchandising's records
// through exactly one narrow, deliberate path — see `mirrorDecision` below.
//
// ── WHY THE MIRROR IS NOT A CROSS-APP WRITE ─────────────────────────────────
// PPC's acceptance has to move the Merchandising file to HANDED_OVER, or the
// register can never show it. Two ways to do that: PPC writes the file
// directly, or PPC publishes and Merchandising's own receiver applies it.
//
// The second is correct and it is what happens: `mirrorDecision` writes the
// receipt and an event in one transaction, and `downstreamReceiptIntake`
// — a MERCHANDISING service — is what touches the Merchandising records. PPC
// never edits a pack's contents, a file's assignment, a selection or a
// milestone. It changes exactly two mirrored display fields plus the
// lifecycle, and it does so through Merchandising's own receiver.
//
// ── AND THERE IS NO REJECT ──────────────────────────────────────────────────
// The receipt enum has no such member. PPC may ask for clarification, which
// returns the file to OPEN and lets Merchandising send a corrected version.
// Refusing a commercial commitment outright is not PPC's call, exactly as
// declining a Sales handover is not Merchandising's.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const { ExecutionPack, PACK_STATE } = require("../../models/CMS_Models/Merchandising/ExecutionPack");
const {
  DownstreamHandoverReceipt, RECEIPT_STATE, CLARIFICATION_CATEGORY, MIN_REASON,
} = require("../../models/CMS_Models/PPC/DownstreamHandoverReceipt");
const {
  MerchandisingAuditEvent, MerchandisingCommandLedger,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

async function withTxn(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } catch (err) {
    if (/Transaction numbers|replica set|transactions are not supported/i.test(str(err?.message))) {
      throw fail("MERCHANDISING_TRANSACTION_REQUIRED",
        "This deployment cannot record the decision atomically. Ask an operator — the database needs a replica set.");
    }
    throw err;
  } finally { session.endSession(); }
}

const hashRequest = (req) => crypto.createHash("sha256")
  .update(JSON.stringify(req ?? null)).digest("hex");

async function once(ctx, { scope, idempotencyKey, request }, run) {
  const key = str(idempotencyKey);
  if (!key) {
    throw fail("IDEMPOTENCY_KEY_REQUIRED",
      "Send an idempotency key with this decision, so a retry cannot take it twice.",
      { field: "idempotencyKey" });
  }
  const requestHash = hashRequest(request);
  const held = await MerchandisingCommandLedger.findOne({
    companyId: ctx.companyId, scope, idempotencyKey: key,
  }).lean();
  if (held) {
    if (held.requestHash !== requestHash) {
      throw fail("IDEMPOTENCY_KEY_REUSED",
        "That idempotency key was already used for a different request.", { field: "idempotencyKey" });
    }
    return { replayed: true, ...held.result };
  }
  const result = await run();
  try {
    await MerchandisingCommandLedger.create([{
      companyId: ctx.companyId, scope, idempotencyKey: key, requestHash,
      result: { revisionNo: result?.packVersionNo ?? null, state: str(result?.state), note: str(result?.note) },
      at: new Date(),
    }]);
  } catch (err) { if (err?.code !== 11000) throw err; }
  return { replayed: false, ...result };
}

/* ═══ THE QUEUE ════════════════════════════════════════════════════════════ */

/**
 * What has been handed to PPC and not yet decided.
 *
 * Read-only, and deliberately narrow: the pack's own references and the file
 * it belongs to. No Merchandising working state, no selection rows, no
 * milestone list — PPC receives a handover, not Merchandising's workspace.
 */
async function listInbound(ctx, { view = "pending", cursor, limit } = {}) {
  assertContext(ctx);
  const size = Math.min(Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT, MAX_LIMIT);

  const states = view === "decided"
    ? [PACK_STATE.ACCEPTED, PACK_STATE.CLARIFICATION_REQUESTED]
    : view === "all"
      ? [PACK_STATE.SUBMITTED, PACK_STATE.ACCEPTED, PACK_STATE.CLARIFICATION_REQUESTED,
        PACK_STATE.SUPERSEDED]
      : [PACK_STATE.SUBMITTED];

  const query = { companyId: ctx.companyId, state: { $in: states } };
  if (str(cursor)) {
    if (!isId(cursor)) {
      throw fail("VALIDATION", "That page marker is not one this list issued.", { field: "cursor" });
    }
    query._id = { $lt: new mongoose.Types.ObjectId(str(cursor)) };
  }

  const packs = await ExecutionPack.find(query)
    .sort({ submittedAt: -1, _id: -1 }).limit(size + 1).lean();
  const page = packs.slice(0, size);

  const [files, receipts] = await Promise.all([
    ExecutionFile.find({
      _id: { $in: page.map((p) => p.fileId) }, companyId: ctx.companyId,
    }).select("fileNumber handoverRef currentExecutionProjection lifecycleStatus").lean(),
    DownstreamHandoverReceipt.find({
      companyId: ctx.companyId, packId: { $in: page.map((p) => p._id) },
    }).lean(),
  ]);
  const byFile = new Map(files.map((f) => [str(f._id), f]));
  const byPack = new Map(receipts.map((r) => [str(r.packId), r]));

  return {
    rows: page.map((p) => {
      const f = byFile.get(str(p.fileId));
      const proj = f?.currentExecutionProjection || {};
      const receipt = byPack.get(str(p._id));
      return {
        packId: str(p._id),
        packVersionNo: p.packVersionNo,
        packState: str(p.state),
        fileId: str(p.fileId),
        fileNumber: str(f?.fileNumber),
        orderRef: str(proj.orderRef) || str(f?.handoverRef),
        buyerDisplayLabel: str(proj.buyerDisplayLabel),
        productName: str(proj.productName),
        styleRef: str(proj.styleRef),
        submittedAt: p.submittedAt || null,
        submittedByName: str(p.submittedBy?.name),
        /* Computed, never stored — a submitted pack with no receipt IS pending. */
        receiptState: receipt ? str(receipt.state) : "PENDING",
        decidedAt: receipt?.decidedAt || null,
        deliveryAtRisk: p.contents?.forecastPosition?.deliveryAtRisk === true,
      };
    }),
    nextCursor: packs.length > size ? str(page[page.length - 1]._id) : null,
    hasMore: packs.length > size,
    views: ["pending", "decided", "all"],
  };
}

/** One pack, in full, for the person deciding on it. */
async function getInbound(ctx, { packId } = {}) {
  assertContext(ctx);
  if (!isId(packId)) throw fail("PACK_NOT_FOUND", "That execution pack does not exist.");
  const pack = await ExecutionPack.findOne({ _id: packId, companyId: ctx.companyId }).lean();
  if (!pack) throw fail("PACK_NOT_FOUND", "That execution pack does not exist.");
  if (pack.state === PACK_STATE.DRAFT) {
    /* A draft was never handed over. PPC must not be able to see, let alone
       decide on, something Merchandising has not sent. */
    throw fail("PACK_NOT_FOUND", "That execution pack has not been submitted.");
  }
  const [file, receipt] = await Promise.all([
    ExecutionFile.findOne({ _id: pack.fileId, companyId: ctx.companyId })
      .select("fileNumber handoverRef handoverLineRef currentExecutionProjection lifecycleStatus").lean(),
    DownstreamHandoverReceipt.findOne({ companyId: ctx.companyId, packId: pack._id }).lean(),
  ]);
  return {
    pack: {
      packId: str(pack._id),
      packVersionNo: pack.packVersionNo,
      state: str(pack.state),
      contents: pack.contents || null,
      completeness: pack.completeness || null,
      declaration: pack.declaration?.at
        ? {
          statement: str(pack.declaration.statement),
          byName: str(pack.declaration.byActor?.name),
          at: pack.declaration.at,
        }
        : null,
      submittedAt: pack.submittedAt || null,
      submittedByName: str(pack.submittedBy?.name),
      supersedesPackVersionNo: pack.supersedesPackVersionNo ?? null,
    },
    file: file ? {
      fileId: str(file._id),
      fileNumber: str(file.fileNumber),
      orderRef: str(file.currentExecutionProjection?.orderRef) || str(file.handoverRef),
      buyerDisplayLabel: str(file.currentExecutionProjection?.buyerDisplayLabel),
      productName: str(file.currentExecutionProjection?.productName),
      lifecycleStatus: str(file.lifecycleStatus),
    } : null,
    receipt: receipt ? {
      state: str(receipt.state),
      decidedByName: str(receipt.decidedBy?.name),
      decidedAt: receipt.decidedAt || null,
      clarification: receipt.clarification?.category
        ? { category: str(receipt.clarification.category), reason: str(receipt.clarification.reason) }
        : null,
    } : { state: "PENDING", decidedByName: "", decidedAt: null, clarification: null },
    clarificationCategories: CLARIFICATION_CATEGORY,
  };
}

/* ═══ THE DECISION ═════════════════════════════════════════════════════════ */

/**
 * Write PPC's decision, and hand Merchandising the news through its own door.
 *
 * The receipt, the pack's state, the audit event and the mirrored file fields
 * commit together — they are one fact, and a receipt that existed without the
 * register reflecting it would leave two screens disagreeing.
 *
 * This is the ONE place a PPC action reaches Merchandising records, and it
 * reaches exactly three fields: the pack's state, the file's lifecycle and the
 * file's two mirrored display fields. It does not touch a pack's contents, a
 * selection, a milestone, an assignment or a note.
 */
async function decide(ctx, { packId, decision, body = {}, actor = null, idempotencyKey } = {}) {
  assertContext(ctx);
  if (!isId(packId)) throw fail("PACK_NOT_FOUND", "That execution pack does not exist.");

  const accepting = decision === "accept";
  let category = "";
  let reason = "";
  if (!accepting) {
    category = str(body?.category).toUpperCase();
    reason = str(body?.reason);
    if (!CLARIFICATION_CATEGORY.includes(category)) {
      throw fail("VALIDATION",
        "Say what kind of clarification this is.",
        { field: "category", allowed: CLARIFICATION_CATEGORY });
    }
    if (reason.length < MIN_REASON) {
      throw fail("VALIDATION",
        "A clarification goes back to a merchandiser who has to act on it, so say enough to act on.",
        { field: "reason", minimum: MIN_REASON });
    }
  }

  return once(ctx, {
    scope: `ppc:pack:${str(packId)}`,
    idempotencyKey,
    request: { decision, category, reason },
  }, async () => withTxn(async (session) => {
    const pack = await ExecutionPack.findOne({ _id: packId, companyId: ctx.companyId }).session(session);
    if (!pack) throw fail("PACK_NOT_FOUND", "That execution pack does not exist.");
    if (pack.state === PACK_STATE.DRAFT) {
      throw fail("PACK_NOT_FOUND", "That execution pack has not been submitted.");
    }
    if (pack.state !== PACK_STATE.SUBMITTED) {
      throw fail("PACK_ALREADY_DECIDED",
        `Version ${pack.packVersionNo} is ${str(pack.state).toLowerCase().replace(/_/g, " ")} `
        + "and is no longer awaiting a decision.",
        { packVersionNo: pack.packVersionNo, state: pack.state });
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    const file = await ExecutionFile.findOne({
      _id: pack.fileId, companyId: ctx.companyId,
    }).session(session);
    if (!file) throw fail("NOT_FOUND", "Execution file not found.");

    const [receipt] = await DownstreamHandoverReceipt.create([{
      companyId: ctx.companyId,
      packId: pack._id,
      packVersionNo: pack.packVersionNo,
      fileId: pack.fileId,
      state: accepting ? RECEIPT_STATE.ACCEPTED : RECEIPT_STATE.CLARIFICATION_REQUESTED,
      clarification: accepting ? undefined : { category, reason: reason.slice(0, 2000) },
      decidedBy: actor || undefined,
      decidedAt: at,
    }], { session });

    pack.state = accepting ? PACK_STATE.ACCEPTED : PACK_STATE.CLARIFICATION_REQUESTED;
    pack.revision += 1;
    await pack.save({ session });

    /* ── THE MIRROR ────────────────────────────────────────────────────────
       Acceptance is what hands the file over; a clarification returns it to
       where the work actually is. Both are honest states produced by a real
       decision, and neither is authored by Merchandising. */
    if (accepting) {
      file.lifecycleStatus = "HANDED_OVER";
      file.executionPhase = "HANDED_OVER";
    } else {
      file.lifecycleStatus = "OPEN";
      file.executionPhase = "COORDINATION";
    }
    file.downstreamReceiptState = receipt.state;
    file.currentPackVersionNo = pack.packVersionNo;
    file.revision += 1;
    await file.save({ session });

    await MerchandisingAuditEvent.create([{
      companyId: ctx.companyId,
      recordType: "EXECUTION_PACK",
      recordId: pack._id,
      recordRevision: pack.revision,
      fileId: file._id,
      fileNumber: str(file.fileNumber),
      action: accepting ? "PACK_ACCEPTED_BY_PPC" : "PACK_CLARIFICATION_REQUESTED_BY_PPC",
      /* PPC's person, named as PPC's — the history says who decided, and the
         sentence says which department they decided for. */
      actor: actor || undefined,
      source: "merchandising",
      at,
      correlationId,
      reason: accepting ? "" : reason,
      details: {
        packVersionNo: pack.packVersionNo,
        receiptState: receipt.state,
        ...(accepting ? {} : { clarificationCategory: category }),
      },
    }], { session, ordered: true });

    return {
      packId: str(pack._id),
      packVersionNo: pack.packVersionNo,
      state: pack.state,
      receiptState: receipt.state,
      fileLifecycle: file.lifecycleStatus,
      note: accepting
        ? "Accepted. The execution file is now handed over."
        : "Clarification requested. The file has returned to Merchandising.",
    };
  }));
}

const accept = (ctx, args) => decide(ctx, { ...args, decision: "accept" });
const requestClarification = (ctx, args) => decide(ctx, { ...args, decision: "clarify" });

module.exports = {
  DEFAULT_LIMIT, MAX_LIMIT, CLARIFICATION_CATEGORY,
  listInbound, getInbound, decide, accept, requestClarification,
};
