// services/industrialEngineering/ieStyleFile.service.js
//
// THE STYLE ENGINEERING FILE AND ITS DRAFT BULLETIN (Chunk 3A).
//
// Four things happen here: open a file for a style on an order, read it, edit
// its draft bulletin, and read its history. Nothing approves, nothing releases,
// and no field in this slice carries an approved standard time.
//
// ── THE ORDER IS WHAT PROVES THE STYLE ──────────────────────────────────────
// A SampleStyle carries no company of its own; its company is proved through
// its Sales parents, and Chunk 1B/1D already resolved that once, carefully, in
// `ieOrders.readOrder`. So a file is opened THROUGH an order and this service
// re-uses that resolver rather than writing a second one: the order must be
// provably this company's, and the style must be among the styles that order
// provably carries. A style named on a request but not on the order is
// `IE_STYLE_NOT_ON_ORDER`, which is the same shape of answer as an order that
// does not exist — because "is that style yours" is not a question a tenant
// boundary answers.
//
// ── THE SOURCE IS COPIED, NOT FOLLOWED ──────────────────────────────────────
// Created from `technicalRecord.approvedRevisionOf()` — the same resolver
// Central Costing reads, so "which version is approved" has one answer in this
// codebase and not two. The frozen snapshot is copied in and never re-read. If
// R&D approves a newer revision afterwards the file is NOT rewritten: a gap
// says the source moved, and re-basing is a decision an engineer makes.
//
// ── AND NO ROUTE IS MAPPED BY GUESSWORK ─────────────────────────────────────
// The R&D snapshot's operations name the LEGACY global register
// (`operationId`), which has duplicate codes, no company and no retirement.
// The bulletin may name only the Chunk 2A company library (`ieOperationId`).
// No stored mapping between the two exists, and matching on code, name,
// machine type or array position would be a guess that reads as a fact for
// ever afterwards. So a new file starts with an EMPTY bulletin and a typed
// mapping gap naming how many source operations are waiting to be chosen by a
// person.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const IeOperation = require("../../models/CMS_Models/IndustrialEngineering/IeOperation");
const { fail } = require("../storePurchase/errors");
const technicalRecord = require("../centralCosting/technicalRecord.service");
const ieOrders = require("./ieOrders.service");

const { LIMITS } = IeStyleFile;

const model = (name, path) => mongoose.models[name] || require(path);
const SampleStyle = () => model("SampleStyle", "../../models/CMS_Models/Sales/SampleStyle");
/* Lazily, like SampleStyle above: the version module requires this one, and a
   top-level require in both directions is a cycle. */
const IeBulletinVersion = () => model(
  "IeBulletinVersion", "../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion",
);

/** Who a gap belongs to. Same vocabulary the Chunk 1 reads publish. */
const GAP_OWNER = Object.freeze({
  IE: "INDUSTRIAL_ENGINEERING",
  RND: "RESEARCH_DEVELOPMENT",
});

const GAP = Object.freeze({
  SOURCE_ROUTE_UNMAPPED: "IE_SOURCE_ROUTE_UNMAPPED",
  BULLETIN_EMPTY: "IE_BULLETIN_EMPTY",
  OPERATION_RETIRED: "IE_BULLETIN_OPERATION_RETIRED",
  PROPOSED_SAM_MISSING: "IE_PROPOSED_SAM_MISSING",
  SOURCE_VERSION_SUPERSEDED: "IE_SOURCE_VERSION_SUPERSEDED",
  /* The file has been moved onto a newer R&D revision and what that move put
     back in question has not been looked at yet. Its own gap, because the
     answer is a review and not a re-base. */
  REBASE_REVIEW_OUTSTANDING: "IE_SOURCE_REBASE_REVIEW_OUTSTANDING",
});

/* The writable surface of a bulletin row. Everything else about a row — the
   operation's code, name, machine type and revision — is produced by the
   server from the library, because a browser may not tell an engineering
   document what an operation is called or which revision it was taken from. */
const ROW_FIELDS = Object.freeze(["rowId", "ieOperationId", "proposedSamMinutes", "note"]);
const PATCH_FIELDS = Object.freeze(["expectedRevision", "rows"]);

const ROW_REFUSED = Object.freeze({
  sequence: "its own position — the order of `rows` is the sequence",
  ieOperationRevision: "the operation revision, which the server reads from the library",
  operationCode: "the operation's code, which the server takes from the library",
  operationName: "the operation's name, which the server takes from the library",
  machineType: "the machine type, which the server takes from the library",
  samMinutes: "an approved standard time — this bulletin holds a PROPOSAL, and approval is a later chunk",
  approvedSamMinutes: "an approved standard time — approval is a later chunk",
  allowance: "an allowance policy, which this slice does not model",
});

/* ═══ SMALL HELPERS ════════════════════════════════════════════════════════ */

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v ?? ""));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

/** One indistinguishable refusal for absent, foreign and malformed alike. */
const fileNotFound = () => fail("IE_FILE_NOT_FOUND", "That engineering file was not found.");

/* One indistinguishable refusal for a style that does not exist, belongs to
   another company, or is reachable from no parent that proves a company. A
   refusal that varied with the answer would be an oracle for which style ids
   are real — the same rule `technicalSource.service.js` states about itself. */
const styleNotOurs = () => fail("IE_STYLE_NOT_FOUND", "That style was not found.");

/* Lazy, and pointing at Central Costing's resolver deliberately: see
   `resolveOwnedStyle` below for why IE does not grow a second ownership rule. */
const technicalSourceOwnership = () => require("../centralCosting/technicalSource.service");

/** A stable, server-minted row identity. */
const mintRowId = () => `row_${crypto.randomBytes(9).toString("hex")}`;
const mintEventId = () => `evt_${crypto.randomBytes(9).toString("hex")}`;

/**
 * SAM totals, computed the same way every time.
 *
 * Summed in stored row order and rounded once at the end to four decimals —
 * a fixed order and a single rounding are what make two reads of the same rows
 * return the same number. Rows with no proposal contribute nothing and are
 * what makes `samComplete` false; a row proposed at 0 contributes 0 and is
 * complete, because somebody said zero.
 */
function samTotals(rows) {
  let total = 0;
  let missing = 0;
  for (const row of rows) {
    if (row.proposedSamMinutes === null || row.proposedSamMinutes === undefined) { missing += 1; continue; }
    total += Number(row.proposedSamMinutes);
  }
  return {
    totalProposedSamMinutes: rows.length ? Math.round(total * 10000) / 10000 : null,
    rowsMissingProposedSam: missing,
    samComplete: rows.length > 0 && missing === 0,
  };
}

const gap = (code, owner, action, message, extra = {}) => ({ code, owner, action, message, ...extra });

/* ═══ THE PUBLISHED SHAPES ═════════════════════════════════════════════════ */

function publishRow(row) {
  const snapshot = row.requirementSnapshot || null;
  return {
    rowId: row.rowId,
    sequence: row.sequence,
    ieOperationId: String(row.ieOperationId),
    ieOperationRevision: row.ieOperationRevision,
    operationCode: row.operationCode || "",
    operationName: row.operationName || "",
    machineType: row.machineType || "",
    proposedSamMinutes: row.proposedSamMinutes ?? null,
    note: row.note || "",
    /* The frozen required-machine evidence, or an explicit statement that this
       row has none — never an empty list standing in for "we do not know". */
    requirementSnapshot: publishRequirementSnapshot(snapshot),
    requirementEvidence: snapshot
      ? (snapshot.requirementsConfigured ? "FROZEN" : "FROZEN_NOT_CONFIGURED")
      : "NOT_PROVABLE",
  };
}

function publishEvent(event) {
  return {
    eventId: event.eventId,
    type: event.type,
    at: event.at ? new Date(event.at).toISOString() : null,
    actorName: event.actorName || "",
    fileRevision: event.fileRevision,
    rowId: event.rowId || "",
    summary: event.summary || "",
  };
}

/**
 * The file, as the contract publishes it.
 *
 * `history` is NOT here — it has its own endpoint, because a file read on
 * every keystroke of a bulletin editor should not carry five hundred audit
 * lines. The source snapshot is published in summary rather than raw: it is
 * R&D's frozen record and the parts IE needs from it are the version identity
 * and the route it has to map.
 */
function publishFile(doc, { readiness }) {
  const rows = (doc.bulletin?.rows || []).map(publishRow);
  return {
    fileId: String(doc._id),
    companyId: String(doc.companyId),
    sampleStyleId: String(doc.sampleStyleId),
    status: doc.status,
    revision: doc.revision,
    source: {
      technicalRevision: doc.source?.technicalRevision ?? null,
      submittedAt: doc.source?.submittedAt ? new Date(doc.source.submittedAt).toISOString() : null,
      approvedAt: doc.source?.approvedAt ? new Date(doc.source.approvedAt).toISOString() : null,
      operationCount: doc.source?.operationCount ?? 0,
      /* The frozen route, read-only and clearly labelled as R&D's — this is
         what a person maps into the bulletin by hand. */
      operations: (doc.source?.snapshot?.operations || []).map((o) => ({
        operationCode: str(o.operationCode),
        name: str(o.name),
        machineType: str(o.machineType),
        samMinutes: o.samMinutes ?? null,
      })),
    },
    bulletin: {
      rows,
      rowCount: rows.length,
      ...samTotals(rows),
      /* The DRAFT process route: `routeState: "UNKNOWN"` with `stages: null`
         until somebody declares one. Approved only when frozen into a version. */
      processRoute: require("./ieProcessRoute.service").publishRoute(doc.bulletin?.processRoute),
    },
    /* ── THE BULLETIN VERSION POINTERS (Chunk 7C1) ───────────────────────
       On every file envelope, so a client renders "frozen, under review as v3"
       without a second request. `null` on the wire where the stored field is
       absent: the distinction that matters — never considered versus considered
       and empty — is a storage rule, and it is kept where it belongs, in the
       document. */
    bulletinReviewVersionId: doc.bulletinReviewVersionId ? String(doc.bulletinReviewVersionId) : null,
    bulletinReviewVersionNo: doc.bulletinReviewVersionNo ?? null,
    currentApprovedBulletinVersionId: doc.currentApprovedBulletinVersionId
      ? String(doc.currentApprovedBulletinVersionId) : null,
    currentApprovedVersionNo: doc.currentApprovedVersionNo ?? null,
    /* The draft cannot be edited while a submission is in review. */
    bulletinEditable: !doc.bulletinReviewVersionId,

    readiness,
    createdByName: doc.createdByName || "",
    updatedByName: doc.updatedByName || "",
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    /* Said in the payload so no screen infers an approval control from a
       DRAFT status: this chunk has no submit, no approve and no release. */
    canApprove: false,
    approvalChunk: "CHUNK_4",
  };
}

/* ═══ READINESS ════════════════════════════════════════════════════════════
 *
 * Computed on every read, never stored. Two of the five gaps are facts that
 * live OUTSIDE this document — an operation retired in the library, a newer
 * revision approved by R&D — so a stored copy would be right only until
 * somebody else acted, and a readiness list that is right only sometimes is
 * worse than none because it is believed.
 */
/* ══ THE SOURCE IN FORCE ═══════════════════════════════════════════════════
 *
 * `source` is the revision this file was OPENED from. `sourceCycle` is the one
 * it has since been deliberately moved onto. One resolver, because every
 * reader of "which R&D revision is this file being engineered against" — the
 * readiness projection, the submission gates and the frozen technical source
 * on a version — has to give the same answer. Two spellings of it is how a
 * version gets frozen against a revision the gates were checking a different
 * one of.
 */
function currentSourceOf(file) {
  const cycle = file?.sourceCycle;
  if (cycle && Number(cycle.cycleNo) >= 2) {
    return {
      cycleNo: Number(cycle.cycleNo),
      technicalRevision: Number(cycle.technicalRevision ?? 0),
      submittedAt: cycle.submittedAt || null,
      approvedAt: cycle.approvedAt || null,
      snapshot: cycle.snapshot || null,
      operationCount: Number(cycle.operationCount ?? 0),
    };
  }
  const source = file?.source || {};
  return {
    cycleNo: 1,
    technicalRevision: Number(source.technicalRevision ?? 0),
    submittedAt: source.submittedAt || null,
    approvedAt: source.approvedAt || null,
    snapshot: source.snapshot || null,
    operationCount: Number(source.operationCount ?? 0),
  };
}

/** The rows a re-base put back in question and nobody has confirmed yet. */
function outstandingRebaseReview(file) {
  const cycle = file?.sourceCycle;
  if (!cycle || Number(cycle.cycleNo) < 2) return null;
  const review = cycle.review || {};
  const rowIds = Array.isArray(review.requiredRowIds) ? review.requiredRowIds : [];
  /* Rows that have since been deleted from the draft cannot be reviewed and
     are not held against the submission — what is gone is not in question. */
  const live = new Set((file.bulletin?.rows || []).map((r) => String(r.rowId)));
  const pending = rowIds.map(String).filter((id) => live.has(id));
  const acknowledged = Boolean(review.acknowledgedAt);
  if (!pending.length && acknowledged) return null;
  return {
    cycleNo: Number(cycle.cycleNo),
    technicalRevision: Number(cycle.technicalRevision ?? 0),
    predecessorTechnicalRevision: Number(cycle.predecessorTechnicalRevision ?? 0),
    rowIds: pending,
    acknowledged,
    materialsChanged: review.materialsChanged === true,
    operationsChanged: review.operationsChanged === true,
  };
}

async function readinessFor(doc, { currentApprovedRevision = null } = {}) {
  const rows = doc.bulletin?.rows || [];
  const gaps = [];

  const inForce = currentSourceOf(doc);

  if (!rows.length) {
    gaps.push(gap(GAP.BULLETIN_EMPTY, GAP_OWNER.IE, "ADD_BULLETIN_ROWS",
      "This engineering file has no bulletin rows yet."));
    const sourceOps = inForce.operationCount || 0;
    if (sourceOps > 0) {
      gaps.push(gap(GAP.SOURCE_ROUTE_UNMAPPED, GAP_OWNER.IE, "MAP_SOURCE_ROUTE_TO_LIBRARY",
        `The approved technical version carries ${sourceOps} operation${sourceOps === 1 ? "" : "s"}, `
        + "and nothing stored says which company operation each one is. Choose them from the operation library.",
        { sourceOperationCount: sourceOps }));
    }
  }

  /* One library read for every operation the bulletin names, so "is this one
     retired" is answered from the library as it is NOW. */
  const referenced = [...new Set(rows.map((r) => String(r.ieOperationId)))];
  if (referenced.length) {
    const live = await IeOperation.find({
      _id: { $in: referenced.map(oid) },
      companyId: doc.companyId,
    }).select("_id status code name revision").lean();
    const byId = new Map(live.map((o) => [String(o._id), o]));

    for (const row of rows) {
      const op = byId.get(String(row.ieOperationId));
      if (op && op.status === "RETIRED") {
        gaps.push(gap(GAP.OPERATION_RETIRED, GAP_OWNER.IE, "REPLACE_RETIRED_OPERATION",
          `${op.code} (${op.name}) has been retired in the operation library, and this bulletin still uses it.`,
          { rowId: row.rowId, ieOperationId: String(row.ieOperationId) }));
      }
      if (row.proposedSamMinutes === null || row.proposedSamMinutes === undefined) {
        gaps.push(gap(GAP.PROPOSED_SAM_MISSING, GAP_OWNER.IE, "PROPOSE_SAM",
          `${row.operationCode || row.operationName || "This row"} has no proposed SAM.`,
          { rowId: row.rowId }));
      }
    }
  }

  if (currentApprovedRevision !== null
    && Number(currentApprovedRevision) !== Number(inForce.technicalRevision)) {
    /* ── AND NOW IT NAMES THE WAY FORWARD ─────────────────────────────────
       This used to be the end of the line: the file stayed on the revision it
       was opened from, every submission was refused as superseded, and the
       costing side said the IE approval was stale for ever. The gap says the
       same thing it always said and adds the one action that resolves it. */
    gaps.push(gap(GAP.SOURCE_VERSION_SUPERSEDED, GAP_OWNER.RND, "REBASE_ONTO_NEW_TECHNICAL_VERSION",
      `This file is engineered from technical revision ${inForce.technicalRevision}, and revision `
      + `${currentApprovedRevision} has since been approved. Nothing has been rewritten — open a `
      + "successor cycle against the newer revision and review what moved.",
      {
        fileSourceRevision: inForce.technicalRevision ?? null,
        sourceCycleNo: inForce.cycleNo,
        approvedRevision: Number(currentApprovedRevision),
      }));
  }

  const outstanding = outstandingRebaseReview(doc);
  if (outstanding) {
    gaps.push(gap(GAP.REBASE_REVIEW_OUTSTANDING, GAP_OWNER.IE, "REVIEW_REBASED_ROWS",
      outstanding.rowIds.length
        ? `This file was moved onto technical revision ${outstanding.technicalRevision}. `
          + `${outstanding.rowIds.length} bulletin row${outstanding.rowIds.length === 1 ? "" : "s"} `
          + "the change reaches must be reviewed again before it can be submitted."
        : `This file was moved onto technical revision ${outstanding.technicalRevision}. `
          + "Confirm what changed before submitting it.",
      {
        rowIds: outstanding.rowIds,
        sourceCycleNo: outstanding.cycleNo,
        technicalRevision: outstanding.technicalRevision,
        predecessorTechnicalRevision: outstanding.predecessorTechnicalRevision,
        materialsChanged: outstanding.materialsChanged,
        operationsChanged: outstanding.operationsChanged,
      }));
  }

  const rowTotals = samTotals(rows.map((r) => ({ proposedSamMinutes: r.proposedSamMinutes })));
  return {
    ready: gaps.length === 0,
    samComplete: rowTotals.samComplete,
    gaps,
  };
}

/* ═══ OWNERSHIP ════════════════════════════════════════════════════════════ */

/**
 * The order, the style on it, and the style's own record — all proved.
 *
 * `ieOrders.readOrder` is the accepted Chunk 1B boundary: it refuses an order
 * this company cannot prove, and it publishes only the styles that order
 * provably carries. Reusing it is the point — a second ownership path would be
 * a second answer to the one question this department was built around.
 */
async function resolveOrderStyle(ctx, { orderId, styleId }) {
  assertContext(ctx);
  const opened = await ieOrders.readOrder(ctx, { orderId });
  const wanted = str(styleId);
  const attached = (opened.styles || []).find((s) => s.styleId === wanted);
  if (!attached) {
    /* Not on this order, not provably linked to it, or not a style at all —
       one answer, and the same one a foreign style gets. */
    throw fail("IE_STYLE_NOT_ON_ORDER", "That style is not on that order.");
  }
  return { order: opened.order, attached };
}

/** The approved technical version, or the typed reason there is not one. */
function approvedSourceOf(style) {
  const techSheet = style?.techSheet || {};
  const technical = techSheet.technical || {};
  if (technical.status !== technicalRecord.STATUS.APPROVED) {
    throw fail("IE_SOURCE_VERSION_REQUIRED",
      "This style has no approved technical version yet. Industrial Engineering works from what R&D approved.",
      { technicalStatus: str(technical.status) || technicalRecord.STATUS.NOT_STARTED });
  }
  const revisions = Array.isArray(techSheet.technicalRevisions) ? techSheet.technicalRevisions : [];
  const approved = revisions.filter((r) => r.outcome === "approved");
  if (!approved.length) {
    throw fail("IE_SOURCE_VERSION_REQUIRED",
      "This style is marked approved but carries no frozen approved revision to engineer from.",
      { technicalStatus: technical.status });
  }
  /* The same rule Central Costing reads by: the highest revision number, not
     the last element — array order is not a guarantee. */
  const top = approved.reduce((best, r) => (r.revision > (best?.revision ?? -1) ? r : best), null);
  const tied = approved.filter((r) => r.revision === top.revision);
  if (tied.length > 1) {
    /* Two frozen revisions carrying the same number and both approved. Nothing
       stored says which one was engineered against, and choosing "the last
       one" would put a guess at the root of the whole file. */
    throw fail("IE_SOURCE_VERSION_AMBIGUOUS",
      `Technical revision ${top.revision} is recorded as approved more than once. `
      + "R&D has to reconcile that before an engineering file can be created from it.",
      { technicalRevision: top.revision, approvedCopies: tied.length });
  }
  return top;
}

/* ═══ CREATE ═══════════════════════════════════════════════════════════════ */

const actorName = (actor) => str(actor?.name || actor?.email);
const actorId = (actor) => (isId(actor?.id) ? oid(actor.id) : null);

const event = (type, { actor, fileRevision, rowId = "", summary = "" }) => ({
  eventId: mintEventId(),
  type,
  at: new Date(),
  actorId: actorId(actor),
  actorName: actorName(actor),
  fileRevision,
  rowId,
  summary: summary.slice(0, LIMITS.SUMMARY),
});

/**
 * Open the engineering file for a style on an order — idempotently.
 *
 * ── WHY THE IDEMPOTENCE IS THE INDEX AND NOT A CHECK ────────────────────────
 * "Look for one, create it if absent" is two operations, and two simultaneous
 * requests both find nothing. The unique `(companyId, sampleStyleId)` index is
 * what actually decides; the loser reads the winner's file and returns it.
 * So the guarantee holds for two requests a millisecond apart, which is
 * exactly when a double-clicked button sends them.
 */
function refuseCreationBody(body) {
  /* Creation takes no body at all. Company, style and source version are all
     resolved server-side, and accepting any of them from a browser would make
     the authority for this file something a caller typed. */
  for (const key of Object.keys(body || {})) {
    throw fail("FIELD_NOT_ACCEPTED",
      `An engineering file is opened from the approved technical version. It cannot carry "${key}".`,
      { field: key, fieldErrors: [{ field: key, code: "NOT_ACCEPTED", message: `"${key}" is not part of opening an engineering file.` }] });
  }
}

/**
 * Open (or return) the one file for a style whose ownership is ALREADY proved.
 *
 * Shared by both entry points on purpose. The two differ only in HOW the style
 * is proved to be this company's — through an order, or through the style's own
 * Sales parents — and a second copy of the creation itself would be a second
 * place for the source freeze to drift.
 *
 * @param {Function} notOurs  the caller's own non-disclosing refusal, so an
 *                            order route still answers IE_STYLE_NOT_ON_ORDER
 *                            and a style route answers its own equivalent.
 */
async function openFileForProvedStyle(ctx, { styleId, orderId = null, actor = null, notOurs }) {
  const existing = await IeStyleFile.findOne({ companyId: ctx.companyId, sampleStyleId: oid(styleId) }).lean();
  if (existing) {
    /* ── THE SAME FILE, LATER REACHED THROUGH AN ORDER ──────────────────
       A file opened from the enquiry line before any order existed is THE
       file. When the order arrives it attaches to this one rather than becoming
       a second: `openedFromOrderId` is provenance, and the unique
       `{companyId, sampleStyleId}` index means a second file is not even
       representable. Only ever filled in when it was empty — the first order a
       file was opened through is a fact, not a field to overwrite. */
    if (isId(orderId) && !existing.openedFromOrderId) {
      const attached = await IeStyleFile.findOneAndUpdate(
        {
          _id: existing._id, companyId: ctx.companyId,
          $or: [{ openedFromOrderId: null }, { openedFromOrderId: { $exists: false } }],
        },
        { $set: { openedFromOrderId: oid(orderId) } },
        { new: true },
      ).lean();
      return { file: await readPublished(attached || existing), created: false };
    }
    return { file: await readPublished(existing), created: false };
  }

  const style = await SampleStyle().findById(oid(styleId))
    .select("techSheet.technical.status techSheet.technical.revision techSheet.technicalRevisions")
    .lean();
  /* Ownership was already proved above; a style that vanished between the two
     reads gets the caller's own non-disclosing answer. */
  if (!style) throw notOurs();

  const approved = approvedSourceOf(style);
  const snapshot = approved.snapshot || null;
  const operationCount = Array.isArray(snapshot?.operations) ? snapshot.operations.length : 0;

  const doc = {
    companyId: ctx.companyId,
    sampleStyleId: oid(styleId),
    /* Null when the file was opened from the enquiry line. An order attaches
       itself above the first time one is opened through it. */
    openedFromOrderId: isId(orderId) ? oid(orderId) : null,
    source: {
      technicalRevision: approved.revision,
      submittedAt: approved.submittedAt || null,
      approvedAt: approved.decidedAt || null,
      snapshot,
      operationCount,
    },
    status: "DRAFT",
    revision: 1,
    /* EMPTY, deliberately. See the header: no stored mapping exists between
       the legacy operations in the snapshot and the company library, and
       inventing one from a code or a position would be a guess wearing the
       clothes of a fact. */
    bulletin: { rows: [] },
    history: [event("FILE_CREATED", {
      actor,
      fileRevision: 1,
      summary: `Opened from approved technical revision ${approved.revision}`
        + (operationCount ? `, ${operationCount} source operation${operationCount === 1 ? "" : "s"} to map.` : "."),
    })],
    createdBy: actorId(actor),
    createdByName: actorName(actor),
    updatedBy: actorId(actor),
    updatedByName: actorName(actor),
  };

  try {
    const created = await IeStyleFile.create(doc);
    return { file: await readPublished(created.toObject()), created: true };
  } catch (err) {
    if (err?.code !== 11000 && !/E11000|duplicate key/i.test(str(err?.message))) throw err;
    /* Somebody else opened it first — the same answer as asking twice. */
    const winner = await IeStyleFile.findOne({ companyId: ctx.companyId, sampleStyleId: oid(styleId) }).lean();
    if (!winner) throw err;
    return { file: await readPublished(winner), created: false };
  }
}

/**
 * Open the engineering file for a style on an order — idempotently.
 *
 * The original entry point, unchanged in behaviour: the order proves the style.
 */
async function createFile(ctx, { orderId, styleId, body = {}, actor = null } = {}) {
  assertContext(ctx);
  refuseCreationBody(body);
  await resolveOrderStyle(ctx, { orderId, styleId });
  return openFileForProvedStyle(ctx, {
    styleId, orderId, actor,
    notOurs: () => fail("IE_STYLE_NOT_ON_ORDER", "That style is not on that order."),
  });
}

/* ═══ OPENING FROM THE STYLE, BEFORE ANY ORDER EXISTS ══════════════════ */

/**
 * Prove a style is this company's WITHOUT an order.
 *
 * ── WHY THIS ENTRY POINT EXISTS ──────────────────────────────────────
 * Engineering used to be reachable only through an order, which put IE after
 * the sale. But nothing may be quoted until IE has confirmed the technical
 * facts a price is built on — so IE has to be able to work on an enquiry line
 * that has no order and may never get one. The file is the same file: the
 * unique `{companyId, sampleStyleId}` index means there is one per style
 * however it was opened, and an order opened later attaches to it.
 *
 * ── AND WHY IT REUSES THE COSTING RESOLVER ────────────────────────────
 * `technicalSource.ownershipProofFor` is this deployment's established answer
 * to "does this company own this SampleStyle", proved through the Sales Journey
 * first and the enquiry second, and it already refuses a foreign journey rather
 * than falling through to the enquiry. A second ownership rule in IE would be a
 * second answer to the one question the department is built around, and the two
 * would eventually disagree about a tenancy boundary.
 */
async function resolveOwnedStyle(ctx, { styleId }) {
  if (!isId(styleId)) throw styleNotOurs();
  const style = await SampleStyle().findById(oid(styleId)).select("journeyId enquiryId").lean();
  if (!style) throw styleNotOurs();
  const owned = await technicalSourceOwnership().ownershipProofFor(style, ctx.companyId);
  if (!owned) throw styleNotOurs();
  return { style, proof: owned.proof };
}

/**
 * Open the engineering file for a style, from the style itself.
 *
 * Idempotent on the same unique index as the order entry point, so a
 * double-clicked button and a race both get the one file.
 */
async function createFileForStyle(ctx, { styleId, body = {}, actor = null } = {}) {
  assertContext(ctx);
  refuseCreationBody(body);
  await resolveOwnedStyle(ctx, { styleId });
  return openFileForProvedStyle(ctx, { styleId, orderId: null, actor, notOurs: styleNotOurs });
}

/** The file for a style, ownership re-proved through the style's own parents. */
async function readFileForOwnedStyle(ctx, { styleId } = {}) {
  assertContext(ctx);
  await resolveOwnedStyle(ctx, { styleId });
  const doc = await IeStyleFile.findOne({ companyId: ctx.companyId, sampleStyleId: oid(styleId) }).lean();
  if (!doc) throw fileNotFound();
  return { file: await readPublished(doc) };
}

/* ═══ READ ═════════════════════════════════════════════════════════════════ */

/** The current approved revision of the style this file was made from. */
async function currentApprovedRevisionOf(sampleStyleId) {
  const style = await SampleStyle().findById(oid(sampleStyleId))
    .select("techSheet.technical.status techSheet.technicalRevisions")
    .lean();
  if (!style) return null;
  const approved = technicalRecord.approvedRevisionOf(style.techSheet || {});
  return approved ? approved.revision : null;
}

async function readPublished(doc) {
  const currentApprovedRevision = await currentApprovedRevisionOf(doc.sampleStyleId);
  const readiness = await readinessFor(doc, { currentApprovedRevision });
  return publishFile(doc, { readiness });
}

/** The file for a style on an order, with ownership re-proved on every read. */
async function readFileForStyle(ctx, { orderId, styleId } = {}) {
  await resolveOrderStyle(ctx, { orderId, styleId });
  const doc = await IeStyleFile.findOne({ companyId: ctx.companyId, sampleStyleId: oid(styleId) }).lean();
  if (!doc) throw fileNotFound();
  return { file: await readPublished(doc) };
}

/** One file of THIS company, by its own id. */
async function loadOwnedFile(ctx, fileId) {
  assertContext(ctx);
  if (!isId(fileId)) throw fileNotFound();
  const doc = await IeStyleFile.findOne({ _id: oid(fileId), companyId: ctx.companyId }).lean();
  if (!doc) throw fileNotFound();
  return doc;
}

/** The audit trail, newest first. */
async function readHistory(ctx, { fileId, limit } = {}) {
  const doc = await loadOwnedFile(ctx, fileId);
  const asked = limit === undefined || limit === null || limit === "" ? 100 : Number(limit);
  if (!Number.isInteger(asked) || asked < 1) {
    throw fail("VALIDATION", "Ask for a whole number of events.", {
      field: "limit",
      fieldErrors: [{ field: "limit", code: "NOT_AN_INTEGER", message: "Ask for a whole number of events." }],
    });
  }
  const size = Math.min(asked, LIMITS.HISTORY);
  const events = [...(doc.history || [])].reverse().slice(0, size);
  return {
    fileId: String(doc._id),
    fileRevision: doc.revision,
    events: events.map(publishEvent),
    limit: size,
    /* The array is capped at write time, so a file can be older than its
       oldest event. Said rather than implied. */
    retained: LIMITS.HISTORY,
    truncated: (doc.history || []).length >= LIMITS.HISTORY,
  };
}

/* ═══ THE BULLETIN ═════════════════════════════════════════════════════════
 *
 * ── WHY THE WHOLE BULLETIN IS REPLACED IN ONE PATCH ─────────────────────────
 * A bulletin is edited as a sequence: a person drags a row, re-times two
 * others and deletes one, then saves. Add/edit/remove/reorder as four
 * endpoints would make that four requests, four revisions and four chances to
 * half-apply an edit somebody thought was one change.
 *
 * Whole-bulletin replacement is only safe with two things, and this chunk has
 * both: stable `rowId`s, so replacement is not "delete everything and recreate
 * it" but a diff — a row that keeps its id keeps its identity through
 * reordering and re-timing; and one atomic conditional update carrying
 * `expectedRevision`, so a save composed against a bulletin somebody else has
 * since changed is refused rather than silently overwriting them.
 *
 * The audit trail is therefore derived from the diff: one PATCH appends an
 * ADDED, EDITED, REMOVED or REORDERED event for what actually changed, so the
 * history reads as decisions rather than as "saved, saved, saved".
 */

function assertPatchShape(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw fail("VALIDATION", "That is not a bulletin.");
  }
  for (const key of Object.keys(body)) {
    if (!PATCH_FIELDS.includes(key)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of a bulletin edit.`,
        { field: key, fieldErrors: [{ field: key, code: "NOT_ACCEPTED", message: `"${key}" is not part of a bulletin edit.` }] });
    }
  }
}

function readExpectedRevision(value) {
  if (value === undefined || value === null || value === "") {
    throw fail("VALIDATION", "Say which revision of this file you read.", {
      field: "expectedRevision",
      fieldErrors: [{ field: "expectedRevision", code: "REQUIRED", message: "Say which revision of this file you read." }],
    });
  }
  const expected = Number(value);
  if (!Number.isInteger(expected) || expected < 1) {
    throw fail("VALIDATION", "A revision is a whole number.", {
      field: "expectedRevision",
      fieldErrors: [{ field: "expectedRevision", code: "NOT_AN_INTEGER", message: "A revision is a whole number." }],
    });
  }
  return expected;
}

/** A proposed SAM: a finite number of minutes, or nothing at all. */
function readProposedSam(value, index, errs) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errs.push({ field: `rows.${index}.proposedSamMinutes`, code: "INVALID", message: "A proposed SAM is a number of minutes, or left empty." });
    return null;
  }
  if (value < 0) {
    errs.push({ field: `rows.${index}.proposedSamMinutes`, code: "INVALID", message: "A proposed SAM cannot be negative." });
    return null;
  }
  if (value > LIMITS.SAM_MINUTES) {
    errs.push({ field: `rows.${index}.proposedSamMinutes`, code: "TOO_LONG", message: `A proposed SAM is at most ${LIMITS.SAM_MINUTES} minutes.` });
    return null;
  }
  /* Stored to four decimals, the same precision the total is rounded to, so a
     stored row and a recomputed total can never disagree. */
  return Math.round(value * 10000) / 10000;
}

/**
 * Shape the rows a caller sent into rows this file may store.
 *
 * EVERYTHING is validated before anything is written — one bad row on a
 * fifty-row save refuses the whole save, because a partially applied bulletin
 * is a route nobody authored.
 */
async function shapeRows(ctx, rows, existingById) {
  if (!Array.isArray(rows)) {
    throw fail("VALIDATION", "A bulletin is an ordered list of rows.", {
      field: "rows",
      fieldErrors: [{ field: "rows", code: "NOT_A_LIST", message: "A bulletin is an ordered list of rows." }],
    });
  }
  if (rows.length > LIMITS.ROWS) {
    throw fail("VALIDATION", `A bulletin holds at most ${LIMITS.ROWS} rows.`, {
      field: "rows",
      fieldErrors: [{ field: "rows", code: "TOO_MANY", message: `A bulletin holds at most ${LIMITS.ROWS} rows.` }],
    });
  }

  const errs = [];
  const seenRowIds = new Set();
  const shaped = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      errs.push({ field: `rows.${i}`, code: "INVALID", message: "Every bulletin row is an object." });
      continue;
    }
    for (const key of Object.keys(row)) {
      const refused = ROW_REFUSED[key];
      if (refused) {
        throw fail("FIELD_NOT_ACCEPTED", `A bulletin row cannot carry ${refused}.`,
          { field: `rows.${i}.${key}`, fieldErrors: [{ field: `rows.${i}.${key}`, code: "NOT_ACCEPTED", message: `A bulletin row cannot carry "${key}".` }] });
      }
      if (!ROW_FIELDS.includes(key)) {
        throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of a bulletin row.`,
          { field: `rows.${i}.${key}`, fieldErrors: [{ field: `rows.${i}.${key}`, code: "NOT_ACCEPTED", message: `"${key}" is not part of a bulletin row.` }] });
      }
    }

    /* An id the file already holds keeps its row's identity. An id it does not
       hold is refused rather than silently minted: a client sending an unknown
       id is out of step with the file, and inventing the row would hide that. */
    let rowId = str(row.rowId);
    if (rowId) {
      if (!existingById.has(rowId)) {
        errs.push({ field: `rows.${i}.rowId`, code: "INVALID", message: "That row is not part of this bulletin." });
      }
      if (seenRowIds.has(rowId)) {
        throw fail("IE_BULLETIN_ROW_DUPLICATE", "The same row appears twice in this bulletin.",
          { rowId, field: `rows.${i}.rowId` });
      }
      seenRowIds.add(rowId);
    } else {
      rowId = mintRowId();
    }

    if (!isId(row.ieOperationId)) {
      errs.push({ field: `rows.${i}.ieOperationId`, code: "REQUIRED", message: "Choose an operation from the company operation library." });
      continue;
    }

    const note = row.note === undefined || row.note === null ? "" : String(row.note);
    if (typeof row.note === "number" || (row.note !== undefined && row.note !== null && typeof row.note !== "string")) {
      errs.push({ field: `rows.${i}.note`, code: "INVALID", message: "A note is text." });
    } else if (note.length > LIMITS.NOTE) {
      errs.push({ field: `rows.${i}.note`, code: "TOO_LONG", message: `A note is at most ${LIMITS.NOTE} characters.` });
    }

    shaped.push({
      rowId,
      sequence: shaped.length + 1,
      ieOperationId: String(row.ieOperationId),
      proposedSamMinutes: readProposedSam(row.proposedSamMinutes, i, errs),
      note: note.trim(),
    });
  }

  if (errs.length) {
    throw fail("VALIDATION", "This bulletin cannot be saved yet.", { fieldErrors: errs, field: errs[0].field });
  }

  /* ── WHICH ROWS ACTUALLY NEED THE LIBRARY ─────────────────────────────
     A row whose `ieOperationId` is unchanged keeps the operation snapshot it
     was created with — its revision, code, name and machine type. Renaming an
     operation in the library, or bumping its revision, must NOT reach into
     every bulletin that already uses it the next time somebody fixes a typo in
     a note: the bulletin would silently start claiming it was engineered
     against a revision nobody chose, and the audit trail would not say when.
     Re-basing a row onto a newer operation revision is a decision, and this
     chunk deliberately offers no action that makes it — the only ways a row's
     snapshot changes are being ADDED and having its operation REPLACED.

     So the library is read only for the rows that need capturing: new rows,
     and rows whose operation the caller explicitly changed. A preserved row is
     also never made unsaveable by what has happened to the library since —
     including retirement, which stays readable and raises its readiness gap
     rather than blocking the save. */
  const capture = shaped.filter((r) => {
    const was = existingById.get(r.rowId);
    return !was || String(was.ieOperationId) !== r.ieOperationId;
  });

  const wanted = [...new Set(capture.map((r) => r.ieOperationId))];
  const library = wanted.length
    ? await IeOperation.find({ _id: { $in: wanted.map(oid) }, companyId: ctx.companyId })
      /* `requirements` joins the projection for Chunk 6B: a row being authored
         freezes the machine types its operation requires AT THAT MOMENT. */
      .select("_id code name machineType revision status requirements").lean()
    : [];
  const byId = new Map(library.map((o) => [String(o._id), o]));

  const missing = wanted.filter((id) => !byId.has(id));
  if (missing.length) {
    throw fail("IE_BULLETIN_OPERATION_NOT_FOUND",
      missing.length === 1
        ? "That operation is not in your company's operation library."
        : `${missing.length} of those operations are not in your company's operation library.`,
      {
        /* The ids the caller sent back, so a form can mark its own rows. No
           statement about whether they exist anywhere else. */
        ieOperationIds: missing,
        field: "rows",
        fieldErrors: shaped
          .map((r, i) => (missing.includes(r.ieOperationId) ? { field: `rows.${i}.ieOperationId`, code: "INVALID", message: "That operation is not in your company's operation library." } : null))
          .filter(Boolean),
      });
  }

  /* The server writes the identity half of every row: for a new or replaced
     operation, what the library says NOW; for an untouched one, exactly what
     the row already carried. */
  return shaped.map((r) => {
    const was = existingById.get(r.rowId);
    const preserved = was && String(was.ieOperationId) === r.ieOperationId;
    const op = preserved ? null : byId.get(r.ieOperationId);
    return {
      rowId: r.rowId,
      sequence: r.sequence,
      ieOperationId: oid(r.ieOperationId),
      ieOperationRevision: preserved ? was.ieOperationRevision : op.revision,
      operationCode: preserved ? (was.operationCode || "") : op.code,
      operationName: preserved ? (was.operationName || "") : op.name,
      machineType: preserved ? (was.machineType || "") : (op.machineType || ""),
      proposedSamMinutes: r.proposedSamMinutes,
      note: r.note,
      /* ── THE REQUIRED-MACHINE EVIDENCE (Chunk 6B) ────────────────────────
         Captured for a NEW row and for one whose operation was explicitly
         REPLACED, from that operation's Chunk 5A profile as it stands now.
         Preserved byte-for-byte otherwise — a note, a proposed SAM or a
         reorder must not silently re-read the library and restate what the row
         was planned against. A preserved row that never had evidence keeps
         `null`, and nothing invents one for it. */
      requirementSnapshot: preserved
        ? (was.requirementSnapshot || null)
        : requirementSnapshotOf(op),
    };
  });
}

/**
 * The frozen copy of an operation's required machine types.
 *
 * `requirementsConfigured: false` is carried through deliberately: "nobody has
 * decided what this operation requires" is not the same fact as "it requires no
 * machine", and a compatibility check has to be able to tell them apart.
 */
function requirementSnapshotOf(op) {
  const requirements = op?.requirements || {};
  return {
    capturedAt: new Date(),
    ieOperationRevision: op.revision,
    requirementsConfigured: Boolean(requirements.configured),
    /* The original machine shape, unchanged. Chunk 6B compatibility, the line
       layout and every stored digest read this exact field, and widening it
       would restate evidence that has already been approved against. */
    machineTypes: (requirements.machine || []).map((m) => ({
      machineType: m.machineType,
      quantity: m.quantity,
    })),

    /* ── CHUNK 8A-iii: ALL THREE DIMENSIONS, FROZEN ────────────────────────
       Chunk 5A has modelled attachment and labour requirements since it
       landed; nothing ever froze them onto a bulletin row, so a release could
       not say whether they had moved. They are captured here, at the same
       moment and from the same profile as the machine half.

       `dimensionsCaptured` is the marker that makes an EMPTY list meaningful:
       without it, an operation that genuinely needs no attachment is
       indistinguishable from a row frozen before anybody captured attachments
       at all. Rows written before this exist without it and read as
       NOT_CAPTURED for ever — nothing is backfilled and no historical version
       is restated. */
    dimensionsCaptured: [...REQUIREMENT_DIMENSIONS],
    machines: (requirements.machine || []).map((m) => ({
      requirementId: m.requirementId,
      sequence: m.sequence,
      machineType: m.machineType,
      quantity: m.quantity,
    })),
    attachments: (requirements.attachment || []).map((a) => ({
      requirementId: a.requirementId,
      sequence: a.sequence,
      code: a.code,
      name: a.name,
      quantity: a.quantity,
      note: a.note || "",
    })),
    labour: (requirements.labour || []).map((l) => ({
      requirementId: l.requirementId,
      sequence: l.sequence,
      workerType: l.workerType,
      quantity: l.quantity,
      skillCode: l.skillCode || "",
      skillName: l.skillName || "",
      grade: l.grade || "",
      note: l.note || "",
    })),
  };
}

/** The three dimensions a snapshot taken from now on covers. */
const REQUIREMENT_DIMENSIONS = Object.freeze(["MACHINE", "ATTACHMENT", "LABOUR"]);

/**
 * The published form of a frozen requirement snapshot.
 *
 * One projection, used by the draft bulletin, the bulletin version and the
 * release-impact comparison, so the three cannot drift into three spellings of
 * the same evidence. A snapshot taken before Chunk 8A-iii carries no
 * `dimensionsCaptured`, and its attachment and labour arrays are published as
 * `null` — a stated absence, never an empty list that would read as "this
 * operation needs none".
 */
function publishRequirementSnapshot(snapshot) {
  if (!snapshot) return null;
  const captured = Array.isArray(snapshot.dimensionsCaptured) ? snapshot.dimensionsCaptured : [];
  const has = (d) => captured.includes(d);
  return {
    capturedAt: snapshot.capturedAt ? new Date(snapshot.capturedAt).toISOString() : null,
    ieOperationRevision: snapshot.ieOperationRevision ?? null,
    requirementsConfigured: Boolean(snapshot.requirementsConfigured),
    dimensionsCaptured: [...captured],
    machineTypes: (snapshot.machineTypes || []).map((m) => ({
      machineType: m.machineType, quantity: m.quantity,
    })),
    machines: has("MACHINE")
      ? (snapshot.machines || []).map((m) => ({
        requirementId: m.requirementId || null,
        sequence: m.sequence ?? null,
        machineType: m.machineType || "",
        quantity: m.quantity ?? null,
      }))
      : null,
    attachments: has("ATTACHMENT")
      ? (snapshot.attachments || []).map((a) => ({
        requirementId: a.requirementId || null,
        sequence: a.sequence ?? null,
        code: a.code || "",
        name: a.name || "",
        quantity: a.quantity ?? null,
        note: a.note || "",
      }))
      : null,
    labour: has("LABOUR")
      ? (snapshot.labour || []).map((l) => ({
        requirementId: l.requirementId || null,
        sequence: l.sequence ?? null,
        workerType: l.workerType || "",
        quantity: l.quantity ?? null,
        skillCode: l.skillCode || "",
        skillName: l.skillName || "",
        grade: l.grade || "",
        note: l.note || "",
      }))
      : null,
  };
}

/**
 * Is the bulletin the caller composed the bulletin that is already stored?
 *
 * Compared AFTER shaping, so it is the two persisted representations being
 * compared and not the two request bodies: the same rows sent with different
 * whitespace, or with the fields in another order, are the same bulletin.
 * Order is part of the comparison — moving two rows and moving them back is a
 * no-op; moving one is not.
 */
function sameBulletin(before, after) {
  if (before.length !== after.length) return false;
  /* `requirementSnapshot` is deliberately NOT compared: it is server-owned and
     moves only when `ieOperationId` or `ieOperationRevision` does, both of which
     are compared here. Comparing a freshly stamped `capturedAt` would make every
     resend of an unchanged bulletin look like a change. */
  const fields = ["rowId", "sequence", "ieOperationRevision", "operationCode", "operationName", "machineType", "note"];
  for (let i = 0; i < after.length; i += 1) {
    const a = after[i];
    const b = before[i];
    if (String(a.ieOperationId) !== String(b.ieOperationId)) return false;
    if ((a.proposedSamMinutes ?? null) !== (b.proposedSamMinutes ?? null)) return false;
    for (const f of fields) {
      if ((a[f] ?? "") !== (b[f] ?? "")) return false;
    }
  }
  return true;
}

/** What changed, as audit events — derived from the diff, not from intent. */
function eventsForDiff(before, after, { actor, fileRevision }) {
  const beforeById = new Map(before.map((r) => [r.rowId, r]));
  const afterById = new Map(after.map((r) => [r.rowId, r]));
  const events = [];

  for (const row of after) {
    const was = beforeById.get(row.rowId);
    if (!was) {
      events.push(event("BULLETIN_ROW_ADDED", {
        actor, fileRevision, rowId: row.rowId,
        summary: `Added ${row.operationCode || row.operationName} at position ${row.sequence}`,
      }));
      continue;
    }
    const changed = [];
    if (String(was.ieOperationId) !== String(row.ieOperationId)) changed.push("operation");
    if ((was.proposedSamMinutes ?? null) !== (row.proposedSamMinutes ?? null)) changed.push("proposed SAM");
    if ((was.note || "") !== (row.note || "")) changed.push("note");
    if (changed.length) {
      events.push(event("BULLETIN_ROW_EDITED", {
        actor, fileRevision, rowId: row.rowId,
        summary: `Changed ${changed.join(", ")} on ${row.operationCode || row.operationName}`,
      }));
    }
  }

  for (const row of before) {
    if (!afterById.has(row.rowId)) {
      events.push(event("BULLETIN_ROW_REMOVED", {
        actor, fileRevision, rowId: row.rowId,
        summary: `Removed ${row.operationCode || row.operationName}`,
      }));
    }
  }

  /* Reordering is its own event, and only when the SURVIVING rows changed
     places — otherwise every add would also report a reorder. */
  const survivingBefore = before.filter((r) => afterById.has(r.rowId)).map((r) => r.rowId);
  const survivingAfter = after.filter((r) => beforeById.has(r.rowId)).map((r) => r.rowId);
  if (survivingBefore.length > 1 && survivingBefore.join("|") !== survivingAfter.join("|")) {
    events.push(event("BULLETIN_REORDERED", {
      actor, fileRevision, summary: `Reordered ${survivingAfter.length} rows`,
    }));
  }

  return events;
}

/**
 * Replace the draft bulletin.
 *
 * The write is ONE conditional update: ownership, the expected revision and
 * the DRAFT status are all in the filter, the revision is incremented in the
 * same operation, and the audit events are pushed by the same write — so the
 * bulletin and its history commit together or neither commits, without needing
 * a transaction this deployment may not have.
 */
/**
 * The draft is frozen because a submission is in review (Chunk 7C1).
 *
 * Names the version and its number so a screen can say "frozen, under review as
 * v3" and link to it, rather than telling somebody to try again.
 */
const draftUnderReview = (file) => fail("IE_BULLETIN_VERSION_IN_REVIEW",
  "This bulletin has been submitted and is under review, so the draft is frozen. "
  + "It becomes editable again when the submission is returned or approved.",
  {
    fileId: String(file._id),
    bulletinReviewVersionId: String(file.bulletinReviewVersionId),
    bulletinReviewVersionNo: file.bulletinReviewVersionNo ?? null,
  });

async function updateBulletin(ctx, { fileId, body = {}, actor = null } = {}) {
  assertContext(ctx);
  if (!isId(fileId)) throw fileNotFound();
  assertPatchShape(body);
  const expected = readExpectedRevision(body.expectedRevision);

  if (body.rows === undefined) {
    /* Required rather than defaulted to "what is already there": a PATCH with
       no rows is a client that forgot them, and treating it as "keep the
       bulletin" would answer a mistake with a success. */
    throw fail("VALIDATION", "Send the bulletin rows you want this file to have.", {
      field: "rows",
      fieldErrors: [{ field: "rows", code: "REQUIRED", message: "Send the bulletin rows you want this file to have." }],
    });
  }

  const current = await IeStyleFile.findOne({ _id: oid(fileId), companyId: ctx.companyId }).lean();
  if (!current) throw fileNotFound();

  const before = (current.bulletin?.rows || []).map((r) => ({ ...r, ieOperationId: String(r.ieOperationId) }));
  const existingById = new Map(before.map((r) => [r.rowId, r]));
  const rows = await shapeRows(ctx, body.rows, existingById);

  /* ── A SAVE THAT CHANGES NOTHING CHANGES NOTHING ───────────────────────
     An editor that re-sends its rows on every blur would otherwise walk the
     revision up and fill the history with entries nobody can act on — and
     since the revision is what a second engineer's form is holding, a
     no-op save would refuse THEIR real edit. So the write is skipped
     entirely: no document update, no revision, no event.

     Every precondition is still enforced first. `expectedRevision` in
     particular: a request composed against an older bulletin is a conflict
     even when it happens to arrive matching the current rows, because the
     caller is deciding from a state that no longer exists. */
  if (current.status !== "DRAFT") {
    throw fail("IE_FILE_REVISION_CONFLICT", "This engineering file is no longer a draft.",
      { expected, actual: current.revision, fileId: String(current._id) });
  }
  /* ── THE FREEZE IS ASKED ABOUT FIRST (Chunk 7C1) ────────────────────────
     Before the revision, deliberately. A submission moves the file's revision
     as it freezes the draft, so a caller who read the file before the
     submission fails BOTH preconditions — and of the two answers, "the draft is
     frozen under review as v3" is the one that is actionable. "Somebody changed
     this file, re-read it and decide again" would send them back to a draft
     they cannot edit however carefully they re-read it.

     It is also checked here rather than only in the atomic filter below because
     the no-op branch returns before that filter is ever reached: a caller who
     re-sends unchanged rows must be told the draft is frozen, not handed a
     cheerful "nothing changed" implying they could have changed something. */
  if (current.bulletinReviewVersionId) throw draftUnderReview(current);
  if (current.revision !== expected) {
    throw fail("IE_FILE_REVISION_CONFLICT",
      "Somebody changed this engineering file while you were editing it. Re-read it and decide again.",
      { expected, actual: current.revision, fileId: String(current._id) });
  }
  if (sameBulletin(before, rows)) {
    return { file: await readPublished(current), updated: false, events: [] };
  }

  const nextRevision = expected + 1;
  const events = eventsForDiff(before, rows.map((r) => ({ ...r, ieOperationId: String(r.ieOperationId) })), {
    actor, fileRevision: nextRevision,
  });

  const updated = await IeStyleFile.findOneAndUpdate(
    /* ── ONE CLAUSE ADDED, AND IT IS THE WHOLE FREEZE (Chunk 7C1) ─────────
       `bulletinReviewVersionId: { $exists: false }`. Reading the version
       collection first and then writing would be two operations, and two
       operations are what a race gets between. The freeze is a field on the
       very document being written, so the same filter that already enforces the
       revision enforces the freeze — atomically, at no extra cost, and with no
       interleaving in which a snapshot and an edited draft both exist. */
    {
      _id: oid(fileId), companyId: ctx.companyId, revision: expected, status: "DRAFT",
      bulletinReviewVersionId: { $exists: false },
    },
    {
      $set: {
        "bulletin.rows": rows,
        updatedBy: actorId(actor),
        updatedByName: actorName(actor),
      },
      $inc: { revision: 1 },
      /* Same write, so there is no window in which the bulletin moved and its
         history did not. `$slice` keeps the array bounded in the same breath. */
      ...(events.length ? { $push: { history: { $each: events, $slice: -LIMITS.HISTORY } } } : {}),
    },
    { new: true },
  ).lean();

  if (!updated) {
    /* One company-scoped re-read to say WHICH precondition failed, and no
       more. It cannot describe anything outside this company. */
    const now = await IeStyleFile.findOne({ _id: oid(fileId), companyId: ctx.companyId })
      .select("_id revision status bulletinReviewVersionId bulletinReviewVersionNo").lean();
    if (!now) throw fileNotFound();
    /* A file now carrying a review pointer lost to a submission, not to another
       edit. Answering "somebody changed this file" would misdescribe what
       happened and send the caller to re-read a draft they cannot change. */
    if (now.bulletinReviewVersionId) throw draftUnderReview(now);
    throw fail("IE_FILE_REVISION_CONFLICT",
      "Somebody changed this engineering file while you were editing it. Re-read it and decide again.",
      { expected, actual: now.revision, fileId: String(now._id) });
  }

  return { file: await readPublished(updated), updated: true, events: events.map(publishEvent) };
}


/* ══ THE SUCCESSOR CYCLE ═══════════════════════════════════════════════════
 *
 * ── THE DEAD END THIS OPENS ────────────────────────────────────────────────
 * A file froze the R&D revision it was opened from and never re-read it, which
 * is right: re-basing an engineering file under somebody who is mid-bulletin is
 * how a route stops matching the garment. But nothing was offered INSTEAD. R&D
 * approving a newer revision left the file permanently unsubmittable
 * (`IE_SOURCE_VERSION_SUPERSEDED` at both gates) and the costing side saying
 * `IE_TECHNICAL_APPROVAL_STALE` with no action that could ever clear it.
 *
 * So the move exists now, and it is explicit: somebody asks for it, names the
 * revision they mean, and is told what changed. Nothing about it is automatic,
 * and nothing about it rewrites history.
 */

/** Materials keyed the way the two snapshots can actually be compared. */
const materialKeyOf = (m = {}) => [str(m.rawItemId), str(m.variantId)].join("|");
const operationKeyOf = (o = {}) => (str(o.operationCode) || str(o.name)).toLowerCase();

/**
 * What moved between the revision this file is on and the one it is moving to.
 *
 * Field by field, and only over fields both snapshots actually carry. A diff
 * that reported "changed" for a field one side never had would send an engineer
 * looking for a decision nobody made.
 */
function diffSnapshots(fromSnapshot, toSnapshot) {
  const from = fromSnapshot || {};
  const to = toSnapshot || {};

  const fromMaterials = new Map((Array.isArray(from.materials) ? from.materials : [])
    .map((m) => [materialKeyOf(m), m]));
  const toMaterials = new Map((Array.isArray(to.materials) ? to.materials : [])
    .map((m) => [materialKeyOf(m), m]));

  const MATERIAL_FIELDS = ["consumptionPerPiece", "allowancePercent", "unit", "specification"];
  const materials = { added: [], removed: [], changed: [] };
  for (const [key, row] of toMaterials) {
    const prior = fromMaterials.get(key);
    if (!prior) { materials.added.push({ key, rawItemName: str(row.rawItemName) }); continue; }
    const fields = MATERIAL_FIELDS.filter((f) => str(prior[f]) !== str(row[f]));
    if (fields.length) materials.changed.push({ key, rawItemName: str(row.rawItemName), fields });
  }
  for (const [key, row] of fromMaterials) {
    if (!toMaterials.has(key)) materials.removed.push({ key, rawItemName: str(row.rawItemName) });
  }

  const fromOps = new Map((Array.isArray(from.operations) ? from.operations : [])
    .map((o) => [operationKeyOf(o), o]));
  const toOps = new Map((Array.isArray(to.operations) ? to.operations : [])
    .map((o) => [operationKeyOf(o), o]));

  const OPERATION_FIELDS = ["samMinutes", "machineType", "name"];
  const operations = { added: [], removed: [], changed: [] };
  for (const [key, row] of toOps) {
    const prior = fromOps.get(key);
    if (!prior) { operations.added.push({ key, operationCode: str(row.operationCode) }); continue; }
    const fields = OPERATION_FIELDS.filter((f) => str(prior[f]) !== str(row[f]));
    if (fields.length) operations.changed.push({ key, operationCode: str(row.operationCode), fields });
  }
  for (const [key, row] of fromOps) {
    if (!toOps.has(key)) operations.removed.push({ key, operationCode: str(row.operationCode) });
  }

  return { materials, operations };
}

/**
 * Which draft rows the move puts back in question.
 *
 * ── WHY IT IS MATCHED ON THE OPERATION AND NOT ON EVERYTHING ────────────────
 * A bulletin row is IE's own work: it names an operation from IE's library, at
 * an IE revision, with IE's proposed time. Nothing stored links it to a row of
 * R&D's snapshot — the bulletin is created EMPTY precisely because no such
 * mapping exists and inventing one from a code would be a guess wearing the
 * clothes of a fact.
 *
 * What CAN be said truthfully is narrower and is what this says: a row whose
 * operation code is one R&D has changed or dropped is a row whose time was
 * proposed against something that has moved. Those are named. A row matching
 * nothing in either snapshot is left alone rather than swept up — it was always
 * IE's own, and flagging every row on every re-base would make the review a
 * formality somebody clicks through.
 *
 * Material changes reach no row at all, so they raise the CYCLE-level
 * acknowledgement instead of a row list nobody could act on.
 */
function rowsPutInQuestion(rows, diff) {
  const moved = new Set([
    ...diff.operations.changed.map((o) => o.key),
    ...diff.operations.removed.map((o) => o.key),
  ].filter(Boolean));
  if (!moved.size) return [];
  return (rows || [])
    .filter((r) => moved.has(String(r.operationCode || "").trim().toLowerCase()))
    .map((r) => String(r.rowId));
}

const rebaseBody = Object.freeze(["expectedRevision", "reason", "technicalRevision"]);

/**
 * Move this file onto the newer approved R&D revision.
 *
 * Refuses unless there IS one. Freezes the exact revision it moved to, records
 * what it succeeded, carries the draft forward by row identity, and names the
 * rows the change reaches. It writes no approval and clears none: the standing
 * approved version keeps standing until a NEW one is submitted and approved by
 * somebody other than its author, through the paths that already exist.
 */
async function rebaseSource(ctx, { fileId, body = {}, actor = null } = {}) {
  assertContext(ctx);
  for (const key of Object.keys(body || {})) {
    if (!rebaseBody.includes(key)) {
      throw fail("FIELD_NOT_ACCEPTED",
        `Re-basing an engineering file cannot carry "${key}".`,
        { field: key, fieldErrors: [{ field: key, code: "NOT_ACCEPTED", message: `"${key}" is not part of re-basing a file.` }] });
    }
  }
  const expected = readExpectedRevision(body.expectedRevision);
  const current = await loadOwnedFile(ctx, fileId);
  const inForce = currentSourceOf(current);

  /* ── A FROZEN DRAFT IS NOT RE-BASED UNDER ITS REVIEWER ─────────────────
     A submitted version is a question somebody has been asked about the draft
     as it stood. Moving the draft onto another revision while they hold it
     would change the question without withdrawing it. */
  if (current.bulletinReviewVersionId) throw draftUnderReview(current);

  /* ── THE NEWER REVISION, FROM R&D'S OWN RESOLVER ───────────────────────
     `approvedSourceOf` is the same rule the file was opened by and the same
     rule Central Costing reads: the one approved revision R&D currently stands
     behind. Nothing here takes a revision, a snapshot or a timestamp from the
     caller — `technicalRevision` in the body is accepted only so a caller can
     SAY which revision they believe they are moving to, and is compared. */
  const style = await SampleStyle().findById(current.sampleStyleId)
    .select("techSheet.technical.status techSheet.technical.revision techSheet.technicalRevisions")
    .lean();
  if (!style) throw fileNotFound();

  const approved = approvedSourceOf(style);

  if (Number(approved.revision) === Number(inForce.technicalRevision)) {
    throw fail("IE_SOURCE_REBASE_NOT_REQUIRED",
      `This file is already engineered from technical revision ${inForce.technicalRevision}, `
      + "which is the one R&D currently stands behind.",
      { fileSourceRevision: inForce.technicalRevision, approvedRevision: Number(approved.revision) });
  }
  if (Number(approved.revision) < Number(inForce.technicalRevision)) {
    /* R&D standing behind an OLDER revision than this file is already on is
       not a successor, and re-basing backwards would quietly undo work that
       was approved against the newer one. */
    throw fail("IE_SOURCE_REBASE_NOT_NEWER",
      `R&D's current approved revision is ${approved.revision}, and this file is already engineered `
      + `from revision ${inForce.technicalRevision}. A file is not moved backwards.`,
      { fileSourceRevision: inForce.technicalRevision, approvedRevision: Number(approved.revision) });
  }
  if (body.technicalRevision !== undefined
    && Number(body.technicalRevision) !== Number(approved.revision)) {
    throw fail("IE_SOURCE_REBASE_REVISION_MISMATCH",
      `You asked to move onto revision ${body.technicalRevision}, and the revision R&D currently `
      + `stands behind is ${approved.revision}. Re-read it and decide again.`,
      { askedRevision: Number(body.technicalRevision), approvedRevision: Number(approved.revision) });
  }

  const reason = String(body.reason || "").trim().slice(0, LIMITS.NOTE);
  const snapshot = approved.snapshot || null;
  const operationCount = Array.isArray(snapshot?.operations) ? snapshot.operations.length : 0;
  const diff = diffSnapshots(inForce.snapshot, snapshot);
  const rows = current.bulletin?.rows || [];
  const requiredRowIds = rowsPutInQuestion(rows, diff);
  const materialsChanged = Boolean(
    diff.materials.added.length || diff.materials.removed.length || diff.materials.changed.length,
  );
  const operationsChanged = Boolean(
    diff.operations.added.length || diff.operations.removed.length || diff.operations.changed.length,
  );

  /* The version this cycle succeeds, named rather than inferred. It keeps its
     own state: an approved version is superseded by the APPROVAL of the next
     one, which is the existing rule, and never by this command. */
  const standing = await IeBulletinVersion()
    .findOne({ companyId: ctx.companyId, ieStyleFileId: current._id, state: "APPROVED" })
    .select("_id versionNo").lean();

  const nextCycleNo = Number(inForce.cycleNo || 1) + 1;
  const fileRevision = expected + 1;

  const updated = await IeStyleFile.findOneAndUpdate(
    {
      _id: current._id, companyId: ctx.companyId, revision: expected, status: "DRAFT",
      bulletinReviewVersionId: { $exists: false },
    },
    {
      $set: {
        sourceCycle: {
          cycleNo: nextCycleNo,
          technicalRevision: Number(approved.revision),
          submittedAt: approved.submittedAt || null,
          approvedAt: approved.decidedAt || null,
          snapshot,
          operationCount,
          openedAt: new Date(),
          openedBy: actorId(actor),
          openedByName: actorName(actor),
          ...(reason ? { reason } : {}),
          predecessorTechnicalRevision: Number(inForce.technicalRevision),
          ...(standing
            ? { predecessorVersionId: standing._id, predecessorVersionNo: standing.versionNo }
            : {}),
          review: {
            materialsChanged,
            operationsChanged,
            requiredRowIds,
            changes: diff,
          },
        },
        updatedBy: actorId(actor),
        updatedByName: actorName(actor),
      },
      $inc: { revision: 1 },
      $push: {
        history: {
          $each: [event("SOURCE_REBASED", {
            actor,
            fileRevision,
            summary: `Moved from technical revision ${inForce.technicalRevision} to `
              + `${approved.revision}${requiredRowIds.length ? `, ${requiredRowIds.length} row(s) to review` : ""}.`,
          })],
          $slice: -LIMITS.HISTORY,
        },
      },
    },
    { new: true },
  ).lean();

  if (!updated) {
    const now = await IeStyleFile.findOne({ _id: current._id, companyId: ctx.companyId })
      .select("_id revision status bulletinReviewVersionId bulletinReviewVersionNo").lean();
    if (!now) throw fileNotFound();
    if (now.bulletinReviewVersionId) throw draftUnderReview(now);
    throw fail("IE_FILE_REVISION_CONFLICT",
      "Somebody changed this engineering file while you were deciding. Re-read it and decide again.",
      { expected, actual: now.revision, fileId: String(now._id) });
  }

  return {
    file: await readPublished(updated),
    rebased: true,
    cycleNo: nextCycleNo,
    fromRevision: Number(inForce.technicalRevision),
    toRevision: Number(approved.revision),
    changes: diff,
    reviewRequiredRowIds: requiredRowIds,
  };
}

const reviewBody = Object.freeze(["expectedRevision", "rowIds", "acknowledgeSource", "note"]);

/**
 * Record that somebody looked at what the move changed.
 *
 * ── WHY IT IS NOT CLEARED BY EDITING THE ROW ────────────────────────────────
 * Touching a row proves somebody typed in it. This is a statement that the row
 * was looked at against the new technical basis and still says what it should —
 * which is the thing the next approver is relying on, and which an incidental
 * save does not establish.
 *
 * Idempotent: naming a row twice is not an error, and naming one that was never
 * in question is refused by name rather than silently accepted, because a
 * caller doing that has misread which rows moved.
 */
async function confirmRebaseReview(ctx, { fileId, body = {}, actor = null } = {}) {
  assertContext(ctx);
  for (const key of Object.keys(body || {})) {
    if (!reviewBody.includes(key)) {
      throw fail("FIELD_NOT_ACCEPTED",
        `Reviewing a re-based file cannot carry "${key}".`,
        { field: key, fieldErrors: [{ field: key, code: "NOT_ACCEPTED", message: `"${key}" is not part of the review.` }] });
    }
  }
  const expected = readExpectedRevision(body.expectedRevision);
  const current = await loadOwnedFile(ctx, fileId);
  const cycle = current.sourceCycle;
  if (!cycle || Number(cycle.cycleNo) < 2) {
    throw fail("IE_SOURCE_NOT_REBASED",
      "This engineering file has not been moved onto a newer technical revision, so there is "
      + "nothing to review.",
      { fileId: String(current._id) });
  }

  const asked = Array.isArray(body.rowIds) ? body.rowIds.map((v) => String(v).trim()).filter(Boolean) : [];
  const outstanding = new Set(
    (Array.isArray(cycle.review?.requiredRowIds) ? cycle.review.requiredRowIds : []).map(String),
  );
  const live = new Set((current.bulletin?.rows || []).map((r) => String(r.rowId)));
  const unknown = asked.filter((id) => !outstanding.has(id) && !live.has(id));
  if (unknown.length) {
    throw fail("IE_BULLETIN_ROW_NOT_FOUND",
      `${unknown.length} row${unknown.length === 1 ? " is" : "s are"} not on this bulletin.`,
      { rowIds: unknown });
  }

  const remaining = [...outstanding].filter((id) => !asked.includes(id));
  const acknowledge = body.acknowledgeSource === true;
  const alreadyAcknowledged = Boolean(cycle.review?.acknowledgedAt);
  if (!asked.length && !acknowledge) {
    throw fail("VALIDATION",
      "Name the rows you have reviewed, or acknowledge the technical basis.",
      { field: "rowIds" });
  }

  const set = { "sourceCycle.review.requiredRowIds": remaining };
  if (acknowledge && !alreadyAcknowledged) {
    set["sourceCycle.review.acknowledgedAt"] = new Date();
    set["sourceCycle.review.acknowledgedBy"] = actorId(actor);
    set["sourceCycle.review.acknowledgedByName"] = actorName(actor);
  }

  const fileRevision = expected + 1;
  const updated = await IeStyleFile.findOneAndUpdate(
    { _id: current._id, companyId: ctx.companyId, revision: expected, status: "DRAFT" },
    {
      $set: { ...set, updatedBy: actorId(actor), updatedByName: actorName(actor) },
      $inc: { revision: 1 },
      $push: {
        history: {
          $each: [event("SOURCE_REBASE_REVIEWED", {
            actor,
            fileRevision,
            summary: `Reviewed ${asked.length} row${asked.length === 1 ? "" : "s"} against technical `
              + `revision ${cycle.technicalRevision}${acknowledge ? ", technical basis acknowledged" : ""}.`,
          })],
          $slice: -LIMITS.HISTORY,
        },
      },
    },
    { new: true },
  ).lean();

  if (!updated) {
    const now = await IeStyleFile.findOne({ _id: current._id, companyId: ctx.companyId })
      .select("_id revision status bulletinReviewVersionId").lean();
    if (!now) throw fileNotFound();
    if (now.bulletinReviewVersionId) throw draftUnderReview(now);
    throw fail("IE_FILE_REVISION_CONFLICT",
      "Somebody changed this engineering file while you were reviewing it. Re-read it and decide again.",
      { expected, actual: now.revision, fileId: String(now._id) });
  }

  return {
    file: await readPublished(updated),
    reviewed: asked,
    outstanding: remaining,
    acknowledged: acknowledge || alreadyAcknowledged,
  };
}

module.exports = {
  /* Opening a file from the enquiry line, before any order exists — and the
     read that goes with it. See `resolveOwnedStyle`. */
  createFileForStyle,
  /* The successor cycle: the way out of a superseded technical source. */
  rebaseSource, confirmRebaseReview, currentSourceOf, outstandingRebaseReview, diffSnapshots,
  readFileForOwnedStyle,
  GAP, GAP_OWNER, ROW_FIELDS, PATCH_FIELDS, ROW_REFUSED,
  readPublished, currentApprovedRevisionOf, draftUnderReview,
  samTotals, sameBulletin, publishFile, publishRow, publishEvent, readinessFor,
  /* Shared so the bulletin version and the release-impact comparison publish
     frozen requirement evidence in ONE spelling rather than three. */
  REQUIREMENT_DIMENSIONS, requirementSnapshotOf, publishRequirementSnapshot,
  resolveOrderStyle, approvedSourceOf,
  createFile, readFileForStyle, readHistory, updateBulletin,
};
