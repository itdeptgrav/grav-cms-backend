// services/merchandising/executionPack.service.js
//
// ASSEMBLING, GATING AND SENDING ONE EXACT VERSION OF MERCHANDISING'S WORK.
//
// A pack version says: *these are the approved Merchandising records for this
// order line, and Merchandising declares its own part complete.* PPC receives
// one version and decides what to do about it.
//
// ── THE GATES ARE ALL MERCHANDISING'S OWN FACTS ─────────────────────────────
// Seven gates: an accepted handover, three approved revisions, a settled
// internal approval position, an approved T&A baseline, and units that
// reconcile. Read them and there is nothing about Store stock, supplier
// confirmation, PPC capacity, production planning, Quality results or
// logistics readiness.
//
// That absence is designed, not an oversight. Gating Merchandising's
// submission on another department's readiness would make Merchandising the
// judge of that department's work, and would let one department's silence stop
// a handover indefinitely. A pack may legitimately be submitted while every
// source department reads UNKNOWN — PPC owns the receiving decision, and PPC
// is exactly who should be looking at those unknowns.
//
// Department status therefore travels beside the gates as CONTEXT, in its own
// band, never counted into `allPassed`.
//
// ── REFERENCES, AND A SNAPSHOT THAT SAYS WHEN ───────────────────────────────
// `contents` holds ids and version numbers, not copies — see the model. The
// one genuine snapshot is `forecastPosition`, which carries `asOf` precisely
// so nobody reads it as live. The plan keeps moving after a pack is sent; the
// pack records where it was when it went.
//
// ── AND THE COMPLETENESS RESULT IS FROZEN WITH IT ───────────────────────────
// `completeness` is evaluated once, at submission, and stored. Recomputing it
// on read would mean a pack that was correct in March displays as incomplete
// in June because a later revision superseded one of its references — telling
// somebody the handover was wrong when it was right.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const ExecutionUnit = require("../../models/CMS_Models/Merchandising/ExecutionUnit");
const HandoverReceipt = require("../../models/CMS_Models/Merchandising/HandoverReceipt");
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const {
  MaterialTrimRevision, PackagingRevision, DevelopmentRevision, REVISION_STATE,
} = require("../../models/CMS_Models/Merchandising/SelectionRevision");
const {
  ApprovalRegister, APPROVAL_OWNER, OBSERVED_STATUS,
} = require("../../models/CMS_Models/Merchandising/ApprovalRegister");
const { TnaPlan, TnaBaseline, TnaMilestone } = require("../../models/CMS_Models/Merchandising/TnaPlan");
const { ExecutionPack, PACK_STATE, GATE, GATE_ORDER } = require("../../models/CMS_Models/Merchandising/ExecutionPack");
const {
  DownstreamHandoverReceipt, RECEIPT_STATE,
} = require("../../models/CMS_Models/PPC/DownstreamHandoverReceipt");
const {
  MerchandisingAuditEvent, MerchandisingOutboxEvent, MerchandisingCommandLedger, OUTBOX_KIND,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** The exact statement a submitter is asked to make. Stored with the pack. */
const DECLARATION_STATEMENT = (versionNo) =>
  `Merchandising's execution pack for this order line is complete as stated in version ${versionNo}. `
  + "Each reference above is an approved Merchandising record. Source department status is shown as "
  + "reported and is not a Merchandising assertion.";

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

/** A retry replays the original answer instead of taking the decision twice. */
async function once(ctx, { scope, idempotencyKey, request }, run) {
  const key = str(idempotencyKey);
  if (!key) {
    throw fail("IDEMPOTENCY_KEY_REQUIRED",
      "Send an idempotency key with this command, so a retry cannot take the decision twice.",
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
      result: {
        revisionId: result?.packId ? new mongoose.Types.ObjectId(str(result.packId)) : null,
        revisionNo: result?.packVersionNo ?? null,
        state: str(result?.state),
        note: str(result?.note),
      },
      at: new Date(),
    }]);
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  return { replayed: false, ...result };
}

async function loadFile(ctx, fileId, session = null) {
  assertContext(ctx);
  if (!isId(fileId)) throw fail("NOT_FOUND", "Execution file not found.");
  const q = ExecutionFile.findOne({ _id: fileId, companyId: ctx.companyId });
  const file = session ? await q.session(session) : await q;
  if (!file) throw fail("NOT_FOUND", "Execution file not found.");
  return file;
}

function assertExpected(doc, expected, what) {
  if (expected === undefined || expected === null || expected === "") {
    throw fail("VALIDATION", `Say which revision of the ${what} you are changing.`,
      { field: "expectedRevision" });
  }
  if (Number(expected) !== Number(doc.revision ?? 0)) {
    throw fail("REVISION_CONFLICT",
      `Somebody else changed this ${what} while you were working. Reload and try again.`,
      { expected: Number(expected), actual: Number(doc.revision ?? 0) });
  }
}

/* ═══ THE SNAPSHOT ═════════════════════════════════════════════════════════ */

/** The approved revision of one family, or null. */
async function approvedRevision(Model, ctx, fileId, session = null) {
  const q = Model.findOne({
    companyId: ctx.companyId, fileId, state: REVISION_STATE.APPROVED,
  }).sort({ revisionNo: -1 });
  return session ? q.session(session).lean() : q.lean();
}

const revisionRef = (doc) => (doc
  ? {
    revisionId: doc._id,
    revisionNo: doc.revisionNo ?? null,
    approvedAt: doc.approvedAt || null,
    approvedByName: str(doc.approvedBy?.name),
  }
  : { revisionId: null, revisionNo: null, approvedAt: null, approvedByName: "" });

/**
 * Everything the pack points at, read at this moment.
 *
 * Read-only throughout: assembling a pack must never change the records it
 * describes. A draft that is stale is refreshed, not repaired.
 */
async function snapshot(ctx, file, session = null) {
  const fileId = file._id;

  const [
    handoverVersion, receipt, materialTrim, packaging, development,
    register, plan, units,
  ] = await Promise.all([
    file.currentHandoverVersionId
      ? SalesHandoverVersion.findOne({
        _id: file.currentHandoverVersionId, companyId: ctx.companyId,
      }).lean()
      : null,
    HandoverReceipt.findOne({
      companyId: ctx.companyId, handoverVersionId: file.currentHandoverVersionId,
    }).lean(),
    approvedRevision(MaterialTrimRevision, ctx, fileId, session),
    approvedRevision(PackagingRevision, ctx, fileId, session),
    approvedRevision(DevelopmentRevision, ctx, fileId, session),
    ApprovalRegister.findOne({ companyId: ctx.companyId, fileId }).lean(),
    TnaPlan.findOne({ companyId: ctx.companyId, fileId, state: { $ne: "CANCELLED" } }).lean(),
    ExecutionUnit.find({ companyId: ctx.companyId, fileId }).sort({ unitDiscriminator: 1 }).lean(),
  ]);

  const [baseline, milestones] = plan
    ? await Promise.all([
      TnaBaseline.findOne({ companyId: ctx.companyId, planId: plan._id, state: "ACTIVE" }).lean(),
      TnaMilestone.find({ companyId: ctx.companyId, planId: plan._id }).lean(),
    ])
    : [null, []];

  /* ── THE APPROVAL POSITION ──────────────────────────────────────────────
     Only MERCHANDISING-owned rows count toward the gate. An outstanding buyer
     approval is Sales' to chase and a fit-sample sign-off is Product
     Development's; counting either would turn this into a gate on somebody
     else's work through the back door. Every row is still LISTED, so the pack
     records the whole position — the count is what is narrowed, not the
     record. */
  const rows = (register?.rows || []);
  const outstanding = rows.filter((r) => (
    r.owningApplication === APPROVAL_OWNER.MERCHANDISING
    && r.observation?.status !== OBSERVED_STATUS.APPROVED
  ));

  const asOf = new Date();
  const open = milestones.filter((m) => !m.actualDate);

  return {
    salesHandover: {
      versionId: handoverVersion?._id || file.currentHandoverVersionId || null,
      versionNo: handoverVersion?.versionNo ?? null,
      handoverRef: str(file.handoverRef),
      handoverLineRef: str(file.handoverLineRef),
      acceptedAt: receipt?.decidedAt || null,
    },
    materialTrim: revisionRef(materialTrim),
    packaging: revisionRef(packaging),
    developmentRequirements: revisionRef(development),
    approvalRegister: {
      position: outstanding.length ? "OUTSTANDING" : "COMPLETE",
      outstandingCount: outstanding.length,
      entries: rows.map((r) => ({
        approvalRef: str(r.approvalRequirementRef),
        category: str(r.category),
        owningApplication: str(r.owningApplication),
        state: str(r.observation?.status) || OBSERVED_STATUS.AWAITING_SOURCE_RECORD,
        decidedAt: r.observation?.decidedAt || null,
      })),
    },
    timeAndAction: {
      planId: plan?._id || null,
      baselineNo: baseline?.baselineNo ?? null,
      baselineApprovedAt: baseline?.approvedAt || null,
      templateVersionId: plan?.templateVersionId || null,
      templateVersionNo: plan?.templateVersionNo ?? null,
      calendarVersionId: plan?.calendarVersionId || null,
    },
    forecastPosition: {
      /* Labelled with the moment it was taken — see the header. */
      asOf,
      milestonesTotal: milestones.length,
      completed: milestones.length - open.length,
      overdue: milestones.filter((m) => m.status === "OVERDUE").length,
      forecastLate: milestones.filter((m) => m.status === "FORECAST_LATE").length,
      deliveryAtRisk: milestones.some((m) => ["OVERDUE", "FORECAST_LATE"].includes(m.status)),
    },
    executionUnits: units.map((u) => ({
      unitDiscriminator: str(u.unitDiscriminator),
      quantity: Number(u.quantity) || 0,
      dropRef: str(u.dropRef),
      committedDeliveryDate: u.committedDeliveryDate || null,
      active: u.active !== false,
    })),
  };
}

/* ═══ THE GATES ════════════════════════════════════════════════════════════ */

/**
 * Evaluate every gate against a snapshot, and say which tab fixes each failure.
 *
 * Each gate is independent and each carries its own sentence: somebody
 * assembling a handover needs the whole list of what is missing, or they fix
 * one thing, resubmit, and are refused again.
 */
function evaluateGates(contents, file) {
  const confirmedQuantity = Number(file.currentExecutionProjection?.totalQuantity) || 0;
  const activeUnits = (contents.executionUnits || []).filter((u) => u.active);
  const unitTotal = activeUnits.reduce((t, u) => t + (Number(u.quantity) || 0), 0);

  const gates = [
    {
      key: GATE.HANDOVER_ACCEPTED,
      passed: Boolean(contents.salesHandover?.versionId),
      detail: "This file has no accepted Sales handover version. It cannot be handed downstream.",
    },
    {
      key: GATE.MATERIAL_TRIM_APPROVED,
      passed: Boolean(contents.materialTrim?.revisionId),
      detail: "No approved Materials & Trims revision. Approve one on the Materials & Trims tab.",
    },
    {
      key: GATE.PACKAGING_APPROVED,
      passed: Boolean(contents.packaging?.revisionId),
      detail: "No approved Packaging specification. Approve one on the Packaging tab.",
    },
    {
      key: GATE.DEVELOPMENT_APPROVED,
      passed: Boolean(contents.developmentRequirements?.revisionId),
      detail: "No approved Development Requirements revision. Approve one on the "
        + "Development Requirements tab.",
    },
    {
      key: GATE.APPROVALS_SETTLED,
      passed: (contents.approvalRegister?.outstandingCount ?? 0) === 0,
      /* Merchandising-owned only, and the sentence says so — otherwise a
         merchandiser reads this as being blocked by the buyer. */
      detail: `${contents.approvalRegister?.outstandingCount ?? 0} Merchandising-owned approval(s) `
        + "are still outstanding on the Approvals tab. Approvals owned by other departments do not "
        + "block this submission.",
    },
    {
      key: GATE.TNA_BASELINED,
      passed: Boolean(contents.timeAndAction?.baselineNo),
      detail: "The Time & Action plan has no approved baseline, so there are no committed dates to "
        + "hand over. Approve baseline 1 on the Time & Action tab.",
    },
    {
      key: GATE.UNITS_RECONCILE,
      /* M2.1's rule: the active units total the confirmed line quantity
         exactly once. A file with no stated quantity cannot be reconciled
         against one, and says that rather than passing by default. */
      passed: confirmedQuantity > 0 && unitTotal === confirmedQuantity,
      detail: confirmedQuantity > 0
        ? `The execution units total ${unitTotal} against a confirmed ${confirmedQuantity}. `
          + "Sales must restate the split before this can be handed over."
        : "This file has no confirmed quantity to reconcile the execution units against.",
    },
  ];

  /* Ordered as declared, so the checklist reads the same way every time. */
  gates.sort((a, b) => GATE_ORDER.indexOf(a.key) - GATE_ORDER.indexOf(b.key));

  return {
    gates: gates.map((g) => ({ key: g.key, passed: g.passed, detail: g.passed ? "" : g.detail })),
    allPassed: gates.every((g) => g.passed),
    evaluatedAt: new Date(),
  };
}

/* ═══ VIEWS ════════════════════════════════════════════════════════════════ */

const packView = (p) => (p ? {
  id: str(p._id),
  packVersionNo: p.packVersionNo,
  state: str(p.state),
  contents: p.contents || null,
  completeness: p.completeness || null,
  declaration: p.declaration?.at
    ? {
      statement: str(p.declaration.statement),
      byName: str(p.declaration.byActor?.name),
      at: p.declaration.at,
    }
    : null,
  submittedByName: str(p.submittedBy?.name),
  submittedAt: p.submittedAt || null,
  supersedesPackVersionNo: p.supersedesPackVersionNo ?? null,
  supersededByPackVersionNo: p.supersededByPackVersionNo ?? null,
  supersededAt: p.supersededAt || null,
  withdrawnByName: str(p.withdrawnBy?.name),
  withdrawnAt: p.withdrawnAt || null,
  withdrawalReason: str(p.withdrawalReason),
  cancelledAt: p.cancelledAt || null,
  revision: p.revision ?? 0,
  createdAt: p.createdAt || null,
} : null);

/**
 * PPC's decision, as Merchandising may read it.
 *
 * `PENDING` is computed here, never stored — a submitted pack with no receipt
 * row is pending, and writing one at submission would be Merchandising
 * creating a PPC record before PPC had done anything.
 */
const receiptView = (receipt, pack) => {
  if (!pack || pack.state === PACK_STATE.DRAFT) return null;
  if (!receipt) {
    return {
      state: "PENDING",
      sentence: "Awaiting PPC's decision.",
      decidedByName: "", decidedAt: null, clarification: null,
      packVersionNo: pack.packVersionNo,
    };
  }
  return {
    state: str(receipt.state),
    sentence: receipt.state === RECEIPT_STATE.ACCEPTED
      ? "PPC accepted this version."
      : receipt.state === RECEIPT_STATE.CLARIFICATION_REQUESTED
        ? "PPC has asked for clarification before accepting."
        : receipt.state === RECEIPT_STATE.SUPERSEDED
          ? "A later version replaced this one."
          : "The order was cancelled.",
    decidedByName: str(receipt.decidedBy?.name),
    decidedAt: receipt.decidedAt || null,
    clarification: receipt.clarification?.category
      ? {
        category: str(receipt.clarification.category),
        reason: str(receipt.clarification.reason),
      }
      : null,
    packVersionNo: receipt.packVersionNo,
  };
};

/* ═══ READS ════════════════════════════════════════════════════════════════ */

/** The pack in force, with a LIVE gate evaluation beside it while it is a draft. */
async function getPack(ctx, { fileId } = {}) {
  const file = await loadFile(ctx, fileId);

  /* The one in force: a draft if there is one, else the most recent version.
     A draft is what somebody is working on; anything else is history. */
  const [draft, latest] = await Promise.all([
    ExecutionPack.findOne({ companyId: ctx.companyId, fileId: file._id, state: PACK_STATE.DRAFT }).lean(),
    ExecutionPack.findOne({ companyId: ctx.companyId, fileId: file._id })
      .sort({ packVersionNo: -1 }).lean(),
  ]);
  const current = draft || latest;

  const receipt = current && current.state !== PACK_STATE.DRAFT
    ? await DownstreamHandoverReceipt.findOne({
      companyId: ctx.companyId, packId: current._id,
    }).lean()
    : null;

  /* ── A DRAFT IS GATED LIVE; A SENT PACK KEEPS ITS FROZEN RESULT ────────
     While it is a draft, what matters is whether it COULD be submitted right
     now. Once sent, what matters is what was true when it went — see the
     header. */
  const live = draft
    ? evaluateGates(await snapshot(ctx, file), file)
    : null;

  return {
    pack: packView(current),
    liveCompleteness: live,
    receipt: receiptView(receipt, current),
    /* So a screen can offer "create a draft" without inferring it. */
    canDraft: !draft && ![PACK_STATE.SUBMITTED].includes(str(latest?.state)),
    fileLifecycle: str(file.lifecycleStatus),
    executionPhase: str(file.executionPhase),
  };
}

async function listPackVersions(ctx, { fileId, cursor, limit } = {}) {
  const file = await loadFile(ctx, fileId);
  const size = Math.min(
    Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT, MAX_LIMIT,
  );
  const query = { companyId: ctx.companyId, fileId: file._id };
  if (str(cursor)) {
    const at = Number(cursor);
    if (!Number.isInteger(at)) {
      throw fail("VALIDATION", "That page marker is not one this list issued.", { field: "cursor" });
    }
    query.packVersionNo = { $lt: at };
  }
  const rows = await ExecutionPack.find(query)
    .sort({ packVersionNo: -1 }).limit(size + 1).lean();
  const page = rows.slice(0, size);

  /* One lookup for the page's receipts, not one per row. */
  const receipts = await DownstreamHandoverReceipt.find({
    companyId: ctx.companyId, packId: { $in: page.map((p) => p._id) },
  }).lean();
  const byPack = new Map(receipts.map((r) => [str(r.packId), r]));

  return {
    rows: page.map((p) => ({
      ...packView(p),
      /* The list does not need every reference; it needs what happened. */
      contents: undefined,
      receipt: receiptView(byPack.get(str(p._id)) || null, p),
    })),
    nextCursor: rows.length > size ? String(page[page.length - 1].packVersionNo) : null,
    hasMore: rows.length > size,
  };
}

async function getPackVersion(ctx, { fileId, packVersionNo } = {}) {
  const file = await loadFile(ctx, fileId);
  const no = Number(packVersionNo);
  if (!Number.isInteger(no) || no < 1) {
    throw fail("PACK_NOT_FOUND", "That pack version does not exist.");
  }
  const pack = await ExecutionPack.findOne({
    companyId: ctx.companyId, fileId: file._id, packVersionNo: no,
  }).lean();
  if (!pack) throw fail("PACK_NOT_FOUND", "That pack version does not exist.");
  const receipt = await DownstreamHandoverReceipt.findOne({
    companyId: ctx.companyId, packId: pack._id,
  }).lean();
  return { pack: packView(pack), receipt: receiptView(receipt, pack) };
}

/** PPC's decision on the version in force, read-only. */
async function getReceipt(ctx, { fileId } = {}) {
  const file = await loadFile(ctx, fileId);
  const pack = await ExecutionPack.findOne({ companyId: ctx.companyId, fileId: file._id })
    .sort({ packVersionNo: -1 }).lean();
  if (!pack) return { receipt: null, pack: null };
  const receipt = await DownstreamHandoverReceipt.findOne({
    companyId: ctx.companyId, packId: pack._id,
  }).lean();
  return { receipt: receiptView(receipt, pack), pack: packView(pack) };
}

/**
 * PREVIEW — what a submission would carry and whether it could happen.
 *
 * Reads and computes; writes nothing at all, including no draft. Somebody must
 * be able to find out what is missing without creating a record.
 */
async function previewPack(ctx, { fileId } = {}) {
  const file = await loadFile(ctx, fileId);
  const contents = await snapshot(ctx, file);
  const completeness = evaluateGates(contents, file);
  const next = await nextVersionNo(ctx, file._id);
  return {
    contents,
    completeness,
    wouldBeVersionNo: next,
    declarationStatement: DECLARATION_STATEMENT(next),
    note: "Nothing has been created. This is what a submission would carry.",
  };
}

/** Counted from the highest EVER issued, so a withdrawn version is not reused. */
async function nextVersionNo(ctx, fileId, session = null) {
  const q = ExecutionPack.findOne({ companyId: ctx.companyId, fileId })
    .sort({ packVersionNo: -1 }).select("packVersionNo");
  const highest = session ? await q.session(session).lean() : await q.lean();
  return (highest?.packVersionNo ?? 0) + 1;
}

/* ═══ COMMANDS ═════════════════════════════════════════════════════════════ */

const auditRow = ({ file, pack, action, actor, at, correlationId, details, reason = "" }) => ({
  companyId: file.companyId,
  recordType: "EXECUTION_PACK",
  recordId: pack._id,
  recordRevision: pack.revision ?? 0,
  fileId: file._id,
  fileNumber: str(file.fileNumber),
  action,
  actor: actor || undefined,
  source: "merchandising",
  at: at || new Date(),
  reason: str(reason),
  correlationId,
  details: details || {},
});

/**
 * CREATE A DRAFT — a snapshot of where every reference stands right now.
 *
 * The draft is a working document: it can be refreshed, withdrawn, and gated
 * live. Nothing about it is announced downstream, because nothing has been
 * handed over.
 */
async function createDraft(ctx, { fileId, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);

  if ([ "CANCELLED", "CLOSED" ].includes(str(file.lifecycleStatus))) {
    throw fail("PACK_STATE_CONFLICT",
      `A ${str(file.lifecycleStatus).toLowerCase()} file cannot be handed over.`,
      { lifecycleStatus: file.lifecycleStatus });
  }

  return once(ctx, {
    scope: `pack:draft:${str(file._id)}`, idempotencyKey, request: { fileId: str(file._id) },
  }, async () => withTxn(async (session) => {
    const live = await ExecutionFile.findById(file._id).session(session);

    const existingDraft = await ExecutionPack.findOne({
      companyId: ctx.companyId, fileId: live._id, state: PACK_STATE.DRAFT,
    }).session(session);
    if (existingDraft) {
      throw fail("PACK_EXISTS",
        `Version ${existingDraft.packVersionNo} is already a draft on this file. `
        + "Refresh it or withdraw it — two drafts of one handover is two answers to one question.",
        { packVersionNo: existingDraft.packVersionNo });
    }
    const submitted = await ExecutionPack.findOne({
      companyId: ctx.companyId, fileId: live._id, state: PACK_STATE.SUBMITTED,
    }).session(session);
    if (submitted) {
      throw fail("PACK_STATE_CONFLICT",
        `Version ${submitted.packVersionNo} is with PPC and undecided. `
        + "Wait for their decision, or supersede it by submitting once they respond.",
        { packVersionNo: submitted.packVersionNo });
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    const packVersionNo = await nextVersionNo(ctx, live._id, session);
    const contents = await snapshot(ctx, live, session);

    const [pack] = await ExecutionPack.create([{
      companyId: ctx.companyId,
      fileId: live._id,
      packVersionNo,
      state: PACK_STATE.DRAFT,
      contents,
      completeness: evaluateGates(contents, live),
      createdBy: actor || undefined,
    }], { session });

    /* The file is being assembled for handover — a real phase move, produced
       by a real record. */
    if (live.executionPhase === "INTAKE") {
      live.executionPhase = "COORDINATION";
      live.revision += 1;
      await live.save({ session });
    }

    await MerchandisingAuditEvent.create([auditRow({
      file: live, pack, action: "PACK_DRAFTED", actor, at, correlationId,
      details: { packVersionNo },
    })], { session, ordered: true });

    return {
      packId: str(pack._id), packVersionNo, state: PACK_STATE.DRAFT,
      note: "Draft created. Nothing has been sent downstream.",
    };
  }));
}

/** REFRESH — re-snapshot a draft against what the records say now. */
async function refreshDraft(ctx, { fileId, body = {}, actor = null } = {}) {
  const file = await loadFile(ctx, fileId);
  return withTxn(async (session) => {
    const pack = await ExecutionPack.findOne({
      companyId: ctx.companyId, fileId: file._id, state: PACK_STATE.DRAFT,
    }).session(session);
    if (!pack) throw fail("PACK_NOT_FOUND", "There is no draft pack on this file to refresh.");
    assertExpected(pack, body?.expectedRevision, "pack");

    const at = new Date();
    const correlationId = crypto.randomUUID();
    const before = pack.completeness?.allPassed === true;

    pack.contents = await snapshot(ctx, file, session);
    pack.completeness = evaluateGates(pack.contents, file);
    pack.revision += 1;
    await pack.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file, pack, action: "PACK_REFRESHED", actor, at, correlationId,
      details: {
        packVersionNo: pack.packVersionNo,
        allPassed: pack.completeness.allPassed,
        wasPassing: before,
      },
    })], { session, ordered: true });

    return {
      packId: str(pack._id), packVersionNo: pack.packVersionNo,
      state: pack.state, completeness: pack.completeness,
    };
  });
}

/**
 * SUBMIT — gate, freeze, announce.
 *
 * The pack, its audit event and its outbox row commit in ONE transaction, so a
 * sent version and the announcement of it cannot exist without each other.
 * Delivery to PPC happens after the commit, never inside it — see
 * `services/integration/executionPackDelivery.service.js` for why.
 */
async function submitPack(ctx, { fileId, body = {}, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);

  /* ── THE DECLARATION IS NOT A CHECKBOX THE SERVER CAN TICK ─────────────
     A pack sent without somebody explicitly saying "this is complete" would
     be the system asserting completeness on a person's behalf. */
  if (body?.declarationAcknowledged !== true) {
    throw fail("PACK_DECLARATION_REQUIRED",
      "Submitting states that Merchandising's own work on this order is complete. "
      + "That statement has to be made by a person, so acknowledge the declaration.",
      { field: "declarationAcknowledged" });
  }

  return once(ctx, {
    scope: `pack:submit:${str(file._id)}`,
    idempotencyKey,
    request: { fileId: str(file._id), expectedRevision: body?.expectedRevision },
  }, async () => withTxn(async (session) => {
    const live = await ExecutionFile.findById(file._id).session(session);
    const pack = await ExecutionPack.findOne({
      companyId: ctx.companyId, fileId: live._id, state: PACK_STATE.DRAFT,
    }).session(session);
    if (!pack) throw fail("PACK_NOT_FOUND", "There is no draft pack on this file to submit.");
    assertExpected(pack, body?.expectedRevision, "pack");

    const at = new Date();
    const correlationId = crypto.randomUUID();

    /* Re-snapshot and re-gate AT SUBMISSION. A draft assembled an hour ago
       may reference a revision that has since been superseded, and sending
       what was true an hour ago would be sending something false. */
    const contents = await snapshot(ctx, live, session);
    const completeness = evaluateGates(contents, live);

    if (!completeness.allPassed) {
      const failed = completeness.gates.filter((g) => !g.passed);
      throw fail("PACK_GATE_FAILED",
        `${failed.length} thing(s) must be settled before this can be handed over.`,
        {
          /* Every failure, not the first — see the header on evaluateGates. */
          gates: failed.map((g) => ({ key: g.key, detail: g.detail })),
          /* Said explicitly, because the question always comes up. */
          note: "No gate here is another department's readiness. Source department status is "
            + "context beside this pack, never a condition on it.",
        });
    }

    /* ── SUPERSEDE THE PREVIOUS VERSION FIRST ──────────────────────────────
       The partial unique index allows one SUBMITTED pack per file and is
       checked as each write lands, not at commit — the same ordering the
       handover version and the T&A baseline both follow. */
    const previous = await ExecutionPack.findOne({
      companyId: ctx.companyId, fileId: live._id,
      state: { $in: [PACK_STATE.SUBMITTED, PACK_STATE.ACCEPTED, PACK_STATE.CLARIFICATION_REQUESTED] },
    }).sort({ packVersionNo: -1 }).session(session);

    const outbox = [];
    if (previous) {
      previous.state = PACK_STATE.SUPERSEDED;
      previous.supersededByPackVersionNo = pack.packVersionNo;
      previous.supersededAt = at;
      previous.revision += 1;
      await previous.save({ session });
      pack.supersedesPackVersionNo = previous.packVersionNo;

      /* PPC's decision on the old version is preserved; only its row's state
         moves, and PPC's own decision fields are untouched. */
      const oldReceipt = await DownstreamHandoverReceipt.findOne({
        companyId: ctx.companyId, packId: previous._id,
      }).session(session);
      if (oldReceipt && [RECEIPT_STATE.ACCEPTED, RECEIPT_STATE.CLARIFICATION_REQUESTED]
        .includes(oldReceipt.state)) {
        oldReceipt.state = RECEIPT_STATE.SUPERSEDED;
        oldReceipt.revision += 1;
        await oldReceipt.save({ session });
      }

      outbox.push({
        companyId: ctx.companyId,
        kind: OUTBOX_KIND.PACK_SUPERSEDED,
        payload: {
          executionFileId: live._id,
          packId: previous._id,
          packVersionNo: previous.packVersionNo,
          supersedesPackVersionNo: pack.packVersionNo,
        },
        correlationId,
      });
    }

    pack.state = PACK_STATE.SUBMITTED;
    pack.contents = contents;
    pack.completeness = completeness;
    pack.declaration = {
      statement: DECLARATION_STATEMENT(pack.packVersionNo),
      byActor: actor || undefined,
      at,
    };
    pack.submittedBy = actor || undefined;
    pack.submittedAt = at;
    pack.revision += 1;
    await pack.save({ session });

    /* ── SUBMITTED IS NOT HANDED OVER ──────────────────────────────────────
       Submitting does not move the file to HANDED_OVER. Handing over is PPC
       accepting, and the register must not claim a decision nobody has made.
       The PHASE moves, because assembling is genuinely finished.

       ── AND SUPERSEDING TAKES THE HANDOVER BACK ────────────────────────────
       The one case where the lifecycle DOES move here, and it moves backwards.
       If PPC had accepted version 1 and Merchandising now sends version 2,
       the accepted thing has been replaced and nobody has accepted its
       replacement. Leaving the file HANDED_OVER would show it in the register
       as handed over on the strength of a decision about a version that is no
       longer in force — which is the same class of lie as a forecast change
       rewriting a baseline. It returns to OPEN until PPC decides again. */
    if (live.lifecycleStatus === "HANDED_OVER") {
      live.lifecycleStatus = "OPEN";
      live.lifecycleReason = `Superseded by execution pack version ${pack.packVersionNo}, `
        + "which PPC has not yet decided on.";
    }
    live.currentPackVersionNo = pack.packVersionNo;
    live.downstreamReceiptState = null;
    live.executionPhase = "PACK_SUBMITTED";
    live.revision += 1;
    await live.save({ session });

    outbox.push({
      companyId: ctx.companyId,
      kind: OUTBOX_KIND.PACK_SUBMITTED,
      payload: {
        executionFileId: live._id,
        packId: pack._id,
        packVersionNo: pack.packVersionNo,
        ...(previous ? { supersedesPackVersionNo: previous.packVersionNo } : {}),
      },
      correlationId,
    });

    await MerchandisingAuditEvent.create([auditRow({
      file: live, pack, action: "PACK_SUBMITTED", actor, at, correlationId,
      details: {
        packVersionNo: pack.packVersionNo,
        supersedesPackVersionNo: previous?.packVersionNo ?? null,
        gateCount: completeness.gates.length,
      },
    })], { session, ordered: true });

    await MerchandisingOutboxEvent.create(outbox, { session, ordered: true });

    return {
      packId: str(pack._id),
      packVersionNo: pack.packVersionNo,
      state: PACK_STATE.SUBMITTED,
      supersededPackVersionNo: previous?.packVersionNo ?? null,
      note: "Submitted. The file stays open until PPC decides — accepting is theirs.",
    };
  }));
}

/** WITHDRAW — a draft only, with a reason. Nothing sent can be taken back. */
async function withdrawDraft(ctx, { fileId, body = {}, actor = null } = {}) {
  const file = await loadFile(ctx, fileId);
  const reason = str(body?.reason);
  if (reason.length < 10) {
    throw fail("VALIDATION",
      "Say why this draft is being withdrawn — it stays in the file's history.",
      { field: "reason" });
  }
  return withTxn(async (session) => {
    const pack = await ExecutionPack.findOne({
      companyId: ctx.companyId, fileId: file._id, state: PACK_STATE.DRAFT,
    }).session(session);
    if (!pack) throw fail("PACK_NOT_FOUND", "There is no draft pack on this file to withdraw.");
    assertExpected(pack, body?.expectedRevision, "pack");

    const at = new Date();
    const correlationId = crypto.randomUUID();
    pack.state = PACK_STATE.WITHDRAWN;
    pack.withdrawnBy = actor || undefined;
    pack.withdrawnAt = at;
    pack.withdrawalReason = reason.slice(0, 2000);
    pack.revision += 1;
    await pack.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file, pack, action: "PACK_WITHDRAWN", actor, at, correlationId,
      details: { packVersionNo: pack.packVersionNo }, reason,
    })], { session, ordered: true });

    /* ── THE VERSION NUMBER IS NOT REUSED ──────────────────────────────────
       `nextVersionNo` counts from the highest EVER issued. A withdrawn
       version 3 leaves the next draft as 4, so "version 3" always means one
       thing in this file's history. */
    return { packId: str(pack._id), packVersionNo: pack.packVersionNo, state: PACK_STATE.WITHDRAWN };
  });
}

module.exports = {
  DEFAULT_LIMIT, MAX_LIMIT, DECLARATION_STATEMENT,
  assertContext, withTxn, once, loadFile, assertExpected,
  approvedRevision, revisionRef, snapshot, evaluateGates,
  packView, receiptView, auditRow, nextVersionNo,
  getPack, listPackVersions, getPackVersion, getReceipt, previewPack,
  createDraft, refreshDraft, submitPack, withdrawDraft,
};
