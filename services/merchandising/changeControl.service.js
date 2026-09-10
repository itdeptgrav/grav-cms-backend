// services/merchandising/changeControl.service.js
//
// WHAT A SALES CHANGE COSTS US INTERNALLY — RECORDED, NOT DECIDED.
//
// Merchandising does not approve the buyer's change. Sales authorised it and
// the company accepted it. What Merchandising does is say what it costs to
// execute, produce whatever new revisions that requires, tell the applications
// it affects, and track what they say back.
//
// ── THE RULE THIS SERVICE EXISTS TO ENFORCE ─────────────────────────────────
// **Impact creates revisions; it never overwrites history.**
//
// Not one line here writes an approved M3 or M4 revision, a T&A baseline date,
// a submitted pack's contents, or an accepted PPC receipt. Where a change
// requires one of those to move, this service calls the SERVICE THAT OWNS IT
// and records the number of the new revision that came back. Those services
// carry their own immutability guards, so the guarantee is structural rather
// than a promise this file makes about itself.
//
// The reason is the whole point of versioning. Six weeks after a quantity
// change, "what did we approve in March, and what did we approve after the
// change" has to have two answers. An impact that edited the March revision
// would leave one.
//
// ── AND WHY THE ACKNOWLEDGEMENT IS NOT COVERAGE ─────────────────────────────
// A coordinated change is announced to the applications it affects. What comes
// back is their statement that they have SEEN it — not that they have done
// anything, and not that they are ready. An acknowledgement naming an older
// change version is shown as STALE and never counted, because a department
// that agreed to version 1 has not agreed to version 2.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const ExecutionUnit = require("../../models/CMS_Models/Merchandising/ExecutionUnit");
const { SalesChangeNotice, NOTICE_STATE } = require("../../models/CMS_Models/Sales/SalesChangeNotice");
const {
  ChangeIntakeReceipt, ChangeImpact, ChangeAcknowledgement,
  INTAKE_STATE, CLARIFICATION_CATEGORY, MIN_REASON,
  IMPACT_STATE, IMPACT_DECISION, AFFECTED_APPLICATION, ACK_STATE,
} = require("../../models/CMS_Models/Merchandising/ChangeControl");
const {
  MerchandisingAuditEvent, MerchandisingOutboxEvent, MerchandisingCommandLedger, OUTBOX_KIND,
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

const hashRequest = (r) => crypto.createHash("sha256").update(JSON.stringify(r ?? null)).digest("hex");

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
      result: { revisionNo: result?.changeVersionNo ?? null, state: str(result?.state), note: str(result?.note) },
      at: new Date(),
    }]);
  } catch (err) { if (err?.code !== 11000) throw err; }
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

/** The current version of one change on one file. */
async function loadNotice(ctx, file, changeRef, session = null) {
  const q = SalesChangeNotice.findOne({
    companyId: ctx.companyId,
    changeRef: str(changeRef),
    handoverRef: str(file.handoverRef),
    handoverLineRef: str(file.handoverLineRef),
  }).sort({ versionNo: -1 });
  const notice = session ? await q.session(session) : await q;
  if (!notice) throw fail("CHANGE_NOT_FOUND", "That change is not on this file.");
  return notice;
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

/* ═══ VIEWS ════════════════════════════════════════════════════════════════ */

const noticeView = (n) => (n ? {
  id: str(n._id),
  changeRef: str(n.changeRef),
  versionNo: n.versionNo,
  state: str(n.state),
  changeKind: str(n.changeKind),
  /* The typed projection, both sides — the before/after a merchandiser
     compares. Nothing from the buyer conversation can be here: the schema
     has no field for it. */
  before: n.before || null,
  after: n.after || null,
  reasonCode: str(n.reasonCode),
  reason: str(n.reason),
  authorisedByName: str(n.authorisedBy?.name),
  authorisedAt: n.authorisedAt || null,
  effectiveFrom: n.effectiveFrom || null,
  cancelledAt: n.cancelledAt || null,
  createdAt: n.createdAt || null,
} : null);

const receiptView = (r, notice) => {
  if (!notice) return null;
  if (!r) {
    /* PENDING computed, never stored — a notice with no receipt is pending,
       and writing one at arrival would be Merchandising answering before
       anybody had looked. */
    return {
      state: "PENDING",
      sentence: "Merchandising has not answered this change yet.",
      decidedByName: "", decidedAt: null, clarification: null,
      changeVersionNo: notice.versionNo,
    };
  }
  return {
    state: str(r.state),
    sentence: r.state === INTAKE_STATE.ACKNOWLEDGED
      ? "Merchandising has acknowledged this change."
      : r.state === INTAKE_STATE.CLARIFICATION_REQUESTED
        ? "Merchandising has asked Sales for clarification."
        : r.state === INTAKE_STATE.SUPERSEDED
          ? "A later version of this change replaced the one this answered."
          : "Sales withdrew this change.",
    decidedByName: str(r.decidedBy?.name),
    decidedAt: r.decidedAt || null,
    clarification: r.clarification?.category
      ? { category: str(r.clarification.category), reason: str(r.clarification.reason) }
      : null,
    changeVersionNo: r.changeVersionNo,
  };
};

const impactView = (i) => (i ? {
  impactRef: str(i.impactRef),
  changeRef: str(i.changeRef),
  changeVersionNo: i.changeVersionNo,
  state: str(i.state),
  decision: str(i.decision) || null,
  affectedUnits: (i.affectedUnits || []).map(str),
  materialTrimImpact: i.materialTrimImpact || null,
  packagingImpact: i.packagingImpact || null,
  developmentImpact: i.developmentImpact || null,
  approvalImpact: i.approvalImpact || null,
  tnaImpact: i.tnaImpact || null,
  downstreamImpact: i.downstreamImpact || null,
  affectedApplications: (i.affectedApplications || []).map(str),
  coordinationReason: i.coordinationReason || null,
  assessedByName: str(i.assessedBy?.name),
  assessedAt: i.assessedAt || null,
  coordinatedByName: str(i.coordinatedBy?.name),
  coordinatedAt: i.coordinatedAt || null,
  closedAt: i.closedAt || null,
  revision: i.revision ?? 0,
} : null);

/**
 * One application's answer, with staleness derived rather than stored.
 *
 * An acknowledgement of version 1 against a current version 2 is STALE. It is
 * shown — the department did answer — and never counted as coverage, because
 * agreeing to what version 1 said is not agreeing to what version 2 says.
 */
const ackView = (a, currentVersionNo, application) => {
  const words = String(application || "").replace(/_/g, " ").toLowerCase();
  if (!a) {
    return {
      application,
      state: "PENDING",
      sentence: `${application} has not answered yet.`,
      changeVersionNo: null,
      stale: false,
      counted: false,
      reason: "",
      acknowledgedByName: "",
      acknowledgedAt: null,
    };
  }
  const stale = Number(a.changeVersionNo) < Number(currentVersionNo);
  return {
    application: str(a.application),
    state: str(a.state),
    sentence: stale
      ? `Answered version ${a.changeVersionNo}, which is no longer the current version.`
      : a.state === ACK_STATE.ACCEPTED
        ? `Acknowledged. This is not a statement that ${words} is ready.`
        : a.state === ACK_STATE.CLARIFICATION_REQUESTED
          ? "Asked for clarification before acknowledging."
          : a.state === ACK_STATE.REJECTED_AS_INVALID
            ? "States the change does not apply to them."
            : "No longer current.",
    changeVersionNo: a.changeVersionNo,
    stale,
    /* Only a current ACCEPTED counts toward coverage. */
    counted: !stale && a.state === ACK_STATE.ACCEPTED,
    reason: str(a.reason),
    acknowledgedByName: str(a.acknowledgedBy?.name),
    acknowledgedAt: a.acknowledgedAt || null,
  };
};

/* ═══ READS ════════════════════════════════════════════════════════════════ */

/** Every change on one file, newest first, with its receipt and impact. */
async function listChanges(ctx, { fileId, cursor, limit } = {}) {
  const file = await loadFile(ctx, fileId);
  const size = Math.min(Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT, MAX_LIMIT);

  const query = {
    companyId: ctx.companyId,
    handoverRef: str(file.handoverRef),
    handoverLineRef: str(file.handoverLineRef),
  };
  if (str(cursor)) {
    const at = new Date(Number(cursor));
    if (Number.isNaN(at.getTime())) {
      throw fail("VALIDATION", "That page marker is not one this list issued.", { field: "cursor" });
    }
    query.createdAt = { $lt: at };
  }

  const notices = await SalesChangeNotice.find(query)
    .sort({ createdAt: -1, _id: -1 }).limit(size + 1).lean();
  const page = notices.slice(0, size);

  /* One lookup each for the page's receipts and impacts, not one per row. */
  const [receipts, impacts] = await Promise.all([
    ChangeIntakeReceipt.find({
      companyId: ctx.companyId, noticeId: { $in: page.map((n) => n._id) },
    }).lean(),
    ChangeImpact.find({
      companyId: ctx.companyId, fileId: file._id,
      changeRef: { $in: page.map((n) => n.changeRef) },
    }).lean(),
  ]);
  const byNotice = new Map(receipts.map((r) => [str(r.noticeId), r]));
  const byImpact = new Map(impacts.map((i) => [`${i.changeRef}:${i.changeVersionNo}`, i]));

  return {
    rows: page.map((n) => ({
      notice: noticeView(n),
      receipt: receiptView(byNotice.get(str(n._id)) || null, n),
      impact: impactView(byImpact.get(`${n.changeRef}:${n.versionNo}`) || null),
    })),
    nextCursor: notices.length > size
      ? String(new Date(page[page.length - 1].createdAt).getTime()) : null,
    hasMore: notices.length > size,
  };
}

/** One change, in full: the notice, the answer, the impact, the acks. */
async function getChange(ctx, { fileId, changeRef } = {}) {
  const file = await loadFile(ctx, fileId);
  const notice = await loadNotice(ctx, file, changeRef);

  const [receipt, impact, acks, units] = await Promise.all([
    ChangeIntakeReceipt.findOne({ companyId: ctx.companyId, noticeId: notice._id }).lean(),
    ChangeImpact.findOne({
      companyId: ctx.companyId, fileId: file._id,
      changeRef: notice.changeRef, changeVersionNo: notice.versionNo,
    }).lean(),
    ChangeAcknowledgement.find({
      companyId: ctx.companyId, changeRef: notice.changeRef,
    }).sort({ changeVersionNo: -1 }).lean(),
    ExecutionUnit.find({ companyId: ctx.companyId, fileId: file._id })
      .select("unitDiscriminator quantity dropRef active").lean(),
  ]);

  /* Every version of every application's answer is loaded; the register shows
     the most recent per application and marks it stale where it is. */
  const latestByApp = new Map();
  for (const a of acks) if (!latestByApp.has(a.application)) latestByApp.set(a.application, a);

  const announced = impact?.affectedApplications || [];
  const acknowledgements = announced.map(
    (app) => ackView(latestByApp.get(app) || null, notice.versionNo, app),
  );

  return {
    notice: noticeView(notice),
    receipt: receiptView(receipt, notice),
    impact: impactView(impact),
    acknowledgements,
    coverage: {
      announced: announced.length,
      /* Only current acceptances. A stale answer is not coverage. */
      acknowledged: acknowledgements.filter((a) => a.counted).length,
      stale: acknowledgements.filter((a) => a.stale).length,
      pending: acknowledgements.filter((a) => a.state === "PENDING").length,
    },
    units: units.map((u) => ({
      unitDiscriminator: str(u.unitDiscriminator),
      quantity: Number(u.quantity) || 0,
      dropRef: str(u.dropRef),
      active: u.active !== false,
    })),
    clarificationCategories: CLARIFICATION_CATEGORY,
    applications: Object.values(AFFECTED_APPLICATION),
    decisions: Object.values(IMPACT_DECISION),
  };
}

/** The cross-file change portfolio. */
async function listPortfolio(ctx, { state = "open", cursor, limit } = {}) {
  assertContext(ctx);
  const size = Math.min(Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT, MAX_LIMIT);

  const query = { companyId: ctx.companyId };
  if (state === "open") query.state = { $ne: IMPACT_STATE.CLOSED };
  else if (state !== "all") query.state = str(state).toUpperCase();

  if (str(cursor)) {
    if (!isId(cursor)) {
      throw fail("VALIDATION", "That page marker is not one this list issued.", { field: "cursor" });
    }
    query._id = { $lt: new mongoose.Types.ObjectId(str(cursor)) };
  }

  const impacts = await ChangeImpact.find(query)
    .sort({ updatedAt: -1, _id: -1 }).limit(size + 1).lean();
  const page = impacts.slice(0, size);

  const files = await ExecutionFile.find({
    _id: { $in: page.map((i) => i.fileId) }, companyId: ctx.companyId,
  }).select("fileNumber handoverRef currentExecutionProjection responsibleMerchandiser").lean();
  const byFile = new Map(files.map((f) => [str(f._id), f]));

  return {
    rows: page.map((i) => {
      const f = byFile.get(str(i.fileId));
      const p = f?.currentExecutionProjection || {};
      return {
        impactRef: str(i.impactRef),
        changeRef: str(i.changeRef),
        changeVersionNo: i.changeVersionNo,
        state: str(i.state),
        decision: str(i.decision) || null,
        fileId: str(i.fileId),
        fileNumber: str(f?.fileNumber),
        orderRef: str(p.orderRef) || str(f?.handoverRef),
        buyerDisplayLabel: str(p.buyerDisplayLabel),
        productName: str(p.productName),
        responsibleMerchandiser: str(f?.responsibleMerchandiser?.name),
        affectedApplications: (i.affectedApplications || []).map(str),
        updatedAt: i.updatedAt || null,
      };
    }),
    nextCursor: impacts.length > size ? str(page[page.length - 1]._id) : null,
    hasMore: impacts.length > size,
    states: ["open", "DRAFT", "ASSESSED", "COORDINATED", "CLOSED", "all"],
  };
}

/* ═══ COMMANDS ═════════════════════════════════════════════════════════════ */

const auditRow = ({ file, recordType, recordId, action, actor, at, correlationId, details, reason = "" }) => ({
  companyId: file.companyId,
  recordType,
  recordId,
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

/** A change must be live before Merchandising answers or assesses it. */
function assertLive(notice) {
  if (notice.state === NOTICE_STATE.CANCELLED) {
    throw fail("CHANGE_STATE_CONFLICT",
      `Sales withdrew change ${notice.changeRef}. There is nothing to answer.`,
      { changeRef: notice.changeRef });
  }
  if (notice.state === NOTICE_STATE.SUPERSEDED) {
    throw fail("CHANGE_VERSION_STALE",
      `Version ${notice.versionNo} was replaced by a later one. Answer the current version.`,
      { changeRef: notice.changeRef, versionNo: notice.versionNo });
  }
}

/**
 * ACKNOWLEDGE — Merchandising has read the change and will execute against it.
 *
 * Not approval. Sales authorised the change and the company accepted it;
 * acknowledging says Merchandising has it and is acting. There is deliberately
 * no refusal here, for the same reason Merchandising cannot decline a
 * handover: refusing a commercially authorised requirement is not its call.
 */
async function acknowledgeChange(ctx, { fileId, changeRef, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);
  const notice = await loadNotice(ctx, file, changeRef);
  assertLive(notice);

  return once(ctx, {
    scope: `change:ack:${str(notice._id)}`,
    idempotencyKey,
    request: { noticeId: str(notice._id) },
  }, async () => withTxn(async (session) => {
    const existing = await ChangeIntakeReceipt.findOne({
      companyId: ctx.companyId, noticeId: notice._id,
    }).session(session);
    if (existing) {
      throw fail("CHANGE_ALREADY_DECIDED",
        `Merchandising already answered version ${notice.versionNo} — `
        + `${str(existing.state).toLowerCase().replace(/_/g, " ")}.`,
        { state: existing.state });
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    const [receipt] = await ChangeIntakeReceipt.create([{
      companyId: ctx.companyId,
      changeRef: notice.changeRef,
      changeVersionNo: notice.versionNo,
      noticeId: notice._id,
      fileId: file._id,
      state: INTAKE_STATE.ACKNOWLEDGED,
      decidedBy: actor || undefined,
      decidedAt: at,
    }], { session });

    await MerchandisingAuditEvent.create([auditRow({
      file, recordType: "CHANGE_NOTICE", recordId: notice._id,
      action: "CHANGE_ACKNOWLEDGED", actor, at, correlationId,
      details: { changeRef: notice.changeRef, changeVersionNo: notice.versionNo },
    })], { session, ordered: true });

    return {
      changeRef: notice.changeRef, changeVersionNo: notice.versionNo,
      state: receipt.state, note: "Acknowledged. Assess the impact next.",
    };
  }));
}

/** CLARIFY — ask Sales a question, with a category and a usable reason. */
async function clarifyChange(ctx, { fileId, changeRef, body = {}, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);
  const notice = await loadNotice(ctx, file, changeRef);
  assertLive(notice);

  const category = str(body?.category).toUpperCase();
  const reason = str(body?.reason);
  if (!CLARIFICATION_CATEGORY.includes(category)) {
    throw fail("VALIDATION", "Say what kind of clarification this is.",
      { field: "category", allowed: CLARIFICATION_CATEGORY });
  }
  if (reason.length < MIN_REASON) {
    throw fail("VALIDATION",
      "A clarification goes back to a salesperson who has to act on it, so say enough to act on.",
      { field: "reason", minimum: MIN_REASON });
  }

  return once(ctx, {
    scope: `change:clarify:${str(notice._id)}`,
    idempotencyKey,
    request: { noticeId: str(notice._id), category, reason },
  }, async () => withTxn(async (session) => {
    const existing = await ChangeIntakeReceipt.findOne({
      companyId: ctx.companyId, noticeId: notice._id,
    }).session(session);
    if (existing) {
      throw fail("CHANGE_ALREADY_DECIDED",
        `Merchandising already answered version ${notice.versionNo}.`, { state: existing.state });
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    await ChangeIntakeReceipt.create([{
      companyId: ctx.companyId,
      changeRef: notice.changeRef,
      changeVersionNo: notice.versionNo,
      noticeId: notice._id,
      fileId: file._id,
      state: INTAKE_STATE.CLARIFICATION_REQUESTED,
      clarification: { category, reason: reason.slice(0, 2000) },
      decidedBy: actor || undefined,
      decidedAt: at,
    }], { session });

    await MerchandisingAuditEvent.create([auditRow({
      file, recordType: "CHANGE_NOTICE", recordId: notice._id,
      action: "CHANGE_CLARIFICATION_REQUESTED", actor, at, correlationId,
      reason,
      details: { changeRef: notice.changeRef, changeVersionNo: notice.versionNo, category },
    })], { session, ordered: true });

    return {
      changeRef: notice.changeRef, changeVersionNo: notice.versionNo,
      state: INTAKE_STATE.CLARIFICATION_REQUESTED,
      note: "Sales has been asked. The change stays open until they answer.",
    };
  }));
}

/* ── WHAT AN IMPACT MAY STATE ─────────────────────────────────────────────
   Declared, so an unexpected key is refused rather than silently ignored —
   somebody who sends `baselineDate` expecting it to move a commitment must be
   told this record cannot do that, not have it quietly dropped. */
const IMPACT_FIELDS = Object.freeze([
  "affectedUnits", "decision", "reasonCode", "note", "expectedRevision", "idempotencyKey",
  "materialTrimImpact", "packagingImpact", "developmentImpact",
  "approvalImpact", "tnaImpact", "downstreamImpact", "affectedApplications",
]);

/* The fields of one area impact a caller may state. `newRevisionNo` is NOT
   among them at assess time — it is written when a revision is genuinely
   produced, by the service that produced it. */
const AREA_FIELDS = Object.freeze(["impacted", "note"]);

function shapeArea(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") {
    throw fail("VALIDATION", `"${name}" must state whether the area is impacted.`, { field: name });
  }
  const unexpected = Object.keys(value).filter((k) => !AREA_FIELDS.includes(k));
  if (unexpected.length) {
    throw fail("VALIDATION",
      `"${name}.${unexpected[0]}" is not something an impact assessment states. `
      + "A revision number is recorded when the revision is actually produced, by the service "
      + "that owns it.",
      { field: `${name}.${unexpected[0]}`, allowed: AREA_FIELDS });
  }
  return { impacted: value.impacted === true, note: str(value.note).slice(0, 1000) };
}

/**
 * ASSESS — record what this change costs internally.
 *
 * Writes an impact record and NOTHING ELSE. No revision is created here, no
 * date moves, no approval reopens. Assessing is saying what will need to
 * happen; making it happen is done through each owning service's own command,
 * and the resulting revision numbers are recorded back onto this impact.
 */
async function assessImpact(ctx, { fileId, changeRef, body = {}, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);
  const notice = await loadNotice(ctx, file, changeRef);
  assertLive(notice);

  const unexpected = Object.keys(body || {}).filter((k) => !IMPACT_FIELDS.includes(k));
  if (unexpected.length) {
    throw fail("VALIDATION",
      `"${unexpected[0]}" is not part of an impact assessment.`,
      { field: unexpected[0], allowed: IMPACT_FIELDS });
  }

  const decision = str(body.decision).toUpperCase();
  if (!Object.values(IMPACT_DECISION).includes(decision)) {
    throw fail("VALIDATION", "Say what is being done about this change.",
      { field: "decision", allowed: Object.values(IMPACT_DECISION) });
  }
  const note = str(body.note);
  if (note.length < MIN_REASON) {
    throw fail("VALIDATION",
      "An impact assessment is read by other departments, so say enough for them to act on.",
      { field: "note", minimum: MIN_REASON });
  }

  /* Affected units must be units this file actually has. */
  const units = await ExecutionUnit.find({ companyId: ctx.companyId, fileId: file._id })
    .select("unitDiscriminator").lean();
  const known = new Set(units.map((u) => str(u.unitDiscriminator)));
  const affectedUnits = (Array.isArray(body.affectedUnits) ? body.affectedUnits : []).map(str);
  const unknown = affectedUnits.filter((u) => !known.has(u));
  if (unknown.length) {
    throw fail("VALIDATION",
      `"${unknown[0]}" is not an execution unit on this file.`,
      { field: "affectedUnits", known: [...known] });
  }

  const applications = (Array.isArray(body.affectedApplications) ? body.affectedApplications : [])
    .map((a) => str(a).toUpperCase());
  const badApp = applications.find((a) => !Object.values(AFFECTED_APPLICATION).includes(a));
  if (badApp) {
    throw fail("VALIDATION", `"${badApp}" is not an application a change is announced to.`,
      { field: "affectedApplications", allowed: Object.values(AFFECTED_APPLICATION) });
  }

  return once(ctx, {
    scope: `change:impact:${str(notice._id)}`,
    idempotencyKey,
    request: { noticeId: str(notice._id), decision, note },
  }, async () => withTxn(async (session) => {
    const at = new Date();
    const correlationId = crypto.randomUUID();

    let impact = await ChangeImpact.findOne({
      companyId: ctx.companyId, fileId: file._id,
      changeRef: notice.changeRef, changeVersionNo: notice.versionNo,
    }).session(session);

    if (impact) {
      if (impact.state === IMPACT_STATE.CLOSED) {
        throw fail("IMPACT_STATE_CONFLICT",
          "That impact is closed. A further change is a new change version.");
      }
      assertExpected(impact, body?.expectedRevision, "impact");
    }

    const patch = {
      affectedUnits,
      decision,
      coordinationReason: { reasonCode: str(body.reasonCode).slice(0, 80), note: note.slice(0, 2000) },
      affectedApplications: [...new Set(applications)],
      state: IMPACT_STATE.ASSESSED,
      assessedBy: actor || undefined,
      assessedAt: at,
    };
    for (const [key, name] of [
      ["materialTrimImpact", "materialTrimImpact"],
      ["packagingImpact", "packagingImpact"],
      ["developmentImpact", "developmentImpact"],
    ]) {
      const shaped = shapeArea(body[key], name);
      if (shaped) patch[key] = shaped;
    }
    if (body.tnaImpact !== undefined) {
      const shaped = shapeArea(body.tnaImpact, "tnaImpact");
      if (shaped) patch.tnaImpact = { ...shaped };
    }
    if (body.downstreamImpact !== undefined) {
      const shaped = shapeArea(body.downstreamImpact, "downstreamImpact");
      if (shaped) patch.downstreamImpact = { ...shaped };
    }
    if (body.approvalImpact !== undefined) {
      const refs = Array.isArray(body.approvalImpact?.reopenedApprovalRefs)
        ? body.approvalImpact.reopenedApprovalRefs.map(str) : [];
      patch.approvalImpact = { reopenedApprovalRefs: refs, note: str(body.approvalImpact?.note).slice(0, 1000) };
    }

    if (impact) {
      Object.assign(impact, patch);
      impact.revision += 1;
      await impact.save({ session });
    } else {
      [impact] = await ChangeImpact.create([{
        companyId: ctx.companyId,
        changeRef: notice.changeRef,
        changeVersionNo: notice.versionNo,
        fileId: file._id,
        impactRef: `IMP-${crypto.randomBytes(5).toString("hex")}`,
        ...patch,
      }], { session });
    }

    await MerchandisingAuditEvent.create([auditRow({
      file, recordType: "CHANGE_IMPACT", recordId: impact._id,
      action: "CHANGE_IMPACT_ASSESSED", actor, at, correlationId, reason: note,
      details: {
        changeRef: notice.changeRef, changeVersionNo: notice.versionNo,
        impactRef: impact.impactRef, decision,
        affectedApplications: impact.affectedApplications,
      },
    })], { session, ordered: true });

    return {
      impactRef: impact.impactRef, changeRef: notice.changeRef,
      changeVersionNo: notice.versionNo, state: impact.state, decision,
      note: "Assessed. Nothing has been revised — produce each revision through its own tab, "
        + "then coordinate.",
    };
  }));
}

/**
 * RECORD A REVISION THIS CHANGE PRODUCED.
 *
 * The one write that connects a change to the records it moved — and it takes
 * only a NUMBER. The revision itself was created by the service that owns it,
 * through that service's own command, with that service's own guards. This
 * records which one, so "what did this change actually produce" is answerable
 * without the impact ever having touched a revision.
 */
async function recordProducedRevision(ctx, { fileId, changeRef, body = {}, actor = null } = {}) {
  const file = await loadFile(ctx, fileId);
  const notice = await loadNotice(ctx, file, changeRef);

  const AREA = {
    MATERIAL_TRIM: "materialTrimImpact",
    PACKAGING: "packagingImpact",
    DEVELOPMENT: "developmentImpact",
    TNA: "tnaImpact",
    DOWNSTREAM: "downstreamImpact",
  };
  const area = AREA[str(body?.area).toUpperCase()];
  if (!area) {
    throw fail("VALIDATION", "Say which area produced a revision.",
      { field: "area", allowed: Object.keys(AREA) });
  }
  const revisionNo = Number(body?.revisionNo);
  if (!Number.isInteger(revisionNo) || revisionNo < 1) {
    throw fail("VALIDATION", "A produced revision has a whole number.", { field: "revisionNo" });
  }

  return withTxn(async (session) => {
    const impact = await ChangeImpact.findOne({
      companyId: ctx.companyId, fileId: file._id,
      changeRef: notice.changeRef, changeVersionNo: notice.versionNo,
    }).session(session);
    if (!impact) throw fail("IMPACT_NOT_FOUND", "Assess this change before recording what it produced.");
    if (impact.state === IMPACT_STATE.CLOSED) {
      throw fail("IMPACT_STATE_CONFLICT", "That impact is closed.");
    }
    assertExpected(impact, body?.expectedRevision, "impact");

    const at = new Date();
    if (area === "tnaImpact") {
      /* M5 wrote the baseline. This records its NUMBER — the date itself is
         M5's and was written by M5's own revise command. */
      impact.tnaImpact.impacted = true;
      impact.tnaImpact.baselineRevisionNo = revisionNo;
      impact.tnaImpact.milestonesMoved = Number(body?.milestonesMoved) || 0;
      impact.tnaImpact.deliveryAtRisk = body?.deliveryAtRisk === true;
    } else if (area === "downstreamImpact") {
      impact.downstreamImpact.impacted = true;
      impact.downstreamImpact.packSupersededVersionNo = revisionNo;
      impact.downstreamImpact.resubmissionRequired = body?.resubmissionRequired !== false;
    } else {
      impact[area].impacted = true;
      impact[area].newRevisionNo = revisionNo;
    }
    impact.revision += 1;
    await impact.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file, recordType: "CHANGE_IMPACT", recordId: impact._id,
      action: "CHANGE_IMPACT_ASSESSED", actor, at, correlationId: crypto.randomUUID(),
      details: {
        changeRef: notice.changeRef, changeVersionNo: notice.versionNo,
        impactRef: impact.impactRef, area, producedRevisionNo: revisionNo,
      },
    })], { session, ordered: true });

    return { impactRef: impact.impactRef, area, revisionNo, revision: impact.revision };
  });
}

/**
 * COORDINATE — announce the assessed change to the applications it affects.
 *
 * The impact and its outbox row commit together. Delivery happens after the
 * commit, never inside it — a coordination decision must survive a receiver
 * that is momentarily unable to take it.
 */
async function coordinateImpact(ctx, { fileId, changeRef, body = {}, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);
  const notice = await loadNotice(ctx, file, changeRef);
  assertLive(notice);

  return once(ctx, {
    scope: `change:coordinate:${str(notice._id)}`,
    idempotencyKey,
    request: { noticeId: str(notice._id) },
  }, async () => withTxn(async (session) => {
    const impact = await ChangeImpact.findOne({
      companyId: ctx.companyId, fileId: file._id,
      changeRef: notice.changeRef, changeVersionNo: notice.versionNo,
    }).session(session);
    if (!impact) throw fail("IMPACT_NOT_FOUND", "Assess this change before coordinating it.");
    if (impact.state === IMPACT_STATE.DRAFT) {
      throw fail("IMPACT_STATE_CONFLICT", "Assess the impact before announcing it.");
    }
    if (impact.state === IMPACT_STATE.CLOSED) {
      throw fail("IMPACT_STATE_CONFLICT", "That impact is closed.");
    }
    assertExpected(impact, body?.expectedRevision, "impact");

    if (!(impact.affectedApplications || []).length) {
      throw fail("VALIDATION",
        "Name at least one application this change affects, or close the impact as absorbed — "
        + "coordinating to nobody announces nothing.",
        { field: "affectedApplications" });
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    impact.state = IMPACT_STATE.COORDINATED;
    impact.coordinatedBy = actor || undefined;
    impact.coordinatedAt = at;
    impact.revision += 1;
    await impact.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file, recordType: "CHANGE_IMPACT", recordId: impact._id,
      action: "CHANGE_IMPACT_COORDINATED", actor, at, correlationId,
      details: {
        changeRef: notice.changeRef, changeVersionNo: notice.versionNo,
        impactRef: impact.impactRef,
        affectedApplications: impact.affectedApplications,
      },
    })], { session, ordered: true });

    await MerchandisingOutboxEvent.create([{
      companyId: ctx.companyId,
      kind: OUTBOX_KIND.CHANGE_IMPACT_COORDINATED,
      payload: {
        executionFileId: file._id,
        changeRef: notice.changeRef,
        changeVersionNo: notice.versionNo,
        impactRef: impact.impactRef,
        changeKind: str(notice.changeKind),
        decision: str(impact.decision),
        affectedApplications: impact.affectedApplications,
      },
      correlationId,
    }], { session, ordered: true });

    return {
      impactRef: impact.impactRef, changeRef: notice.changeRef,
      changeVersionNo: notice.versionNo, state: impact.state,
      announcedTo: impact.affectedApplications.length,
      note: "Announced. Each application answers for itself; an acknowledgement is not readiness.",
    };
  }));
}

/** CLOSE — the change has been dealt with. The record stays for ever. */
async function closeImpact(ctx, { fileId, changeRef, body = {}, actor = null } = {}) {
  const file = await loadFile(ctx, fileId);
  const notice = await loadNotice(ctx, file, changeRef);

  return withTxn(async (session) => {
    const impact = await ChangeImpact.findOne({
      companyId: ctx.companyId, fileId: file._id,
      changeRef: notice.changeRef, changeVersionNo: notice.versionNo,
    }).session(session);
    if (!impact) throw fail("IMPACT_NOT_FOUND", "There is no impact on this change to close.");
    if (impact.state === IMPACT_STATE.CLOSED) {
      throw fail("IMPACT_STATE_CONFLICT", "That impact is already closed.");
    }
    assertExpected(impact, body?.expectedRevision, "impact");

    const at = new Date();
    const correlationId = crypto.randomUUID();
    impact.state = IMPACT_STATE.CLOSED;
    impact.closedBy = actor || undefined;
    impact.closedAt = at;
    impact.revision += 1;
    await impact.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file, recordType: "CHANGE_IMPACT", recordId: impact._id,
      action: "CHANGE_IMPACT_CLOSED", actor, at, correlationId,
      reason: str(body?.note),
      details: {
        changeRef: notice.changeRef, changeVersionNo: notice.versionNo,
        impactRef: impact.impactRef,
      },
    })], { session, ordered: true });

    await MerchandisingOutboxEvent.create([{
      companyId: ctx.companyId,
      kind: OUTBOX_KIND.CHANGE_IMPACT_CLOSED,
      payload: {
        executionFileId: file._id,
        changeRef: notice.changeRef,
        changeVersionNo: notice.versionNo,
        impactRef: impact.impactRef,
      },
      correlationId,
    }], { session, ordered: true });

    return { impactRef: impact.impactRef, state: impact.state };
  });
}

module.exports = {
  DEFAULT_LIMIT, MAX_LIMIT,
  assertContext, withTxn, once, loadFile, loadNotice, assertExpected,
  noticeView, receiptView, impactView, ackView,
  listChanges, getChange, listPortfolio,
  IMPACT_FIELDS, AREA_FIELDS, shapeArea, assertLive, auditRow,
  acknowledgeChange, clarifyChange, assessImpact, recordProducedRevision,
  coordinateImpact, closeImpact,
};
