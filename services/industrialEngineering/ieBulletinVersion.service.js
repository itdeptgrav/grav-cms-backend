// services/industrialEngineering/ieBulletinVersion.service.js
//
// IE CHUNK 7C1 — THE IMMUTABLE BULLETIN VERSION LIFECYCLE.
//
// Submit snapshots the Style File's draft bulletin into a frozen
// `IeBulletinVersion` and freezes the draft; return unfreezes it; approve
// freezes the snapshot as the file's current approved bulletin. The draft
// itself never moves house: `IeStyleFile.bulletin` stays the one writable
// bulletin and `PATCH /engineering-files/:fileId/bulletin` stays its only
// writer.
//
// ── ALL THREE COMMANDS WRITE TWO DOCUMENTS, SO ALL THREE ARE TRANSACTIONS ───
// The version and the Style File move together or not at all. A submit that
// created a snapshot and then failed before setting the review pointer would
// leave a version `IN_REVIEW` beside a draft somebody could still edit — which
// is precisely the divergence this lifecycle exists to prevent. So the snapshot
// and the freeze commit together, and the edit path tests that same stored fact
// in its own atomic filter.
//
// ── AND SUPPORT IS SETTLED BEFORE ANY DOMAIN WORK ───────────────────────────
// A standalone `mongod` accepts `startSession()` and `startTransaction()` and
// then silently commits outside any transaction, so "try it and see" is not
// safe: by the time the deployment's answer surfaces, half the work may already
// have committed unprotected. The repository's own probe — which writes inside a
// real transaction against a scratch collection — is consulted first, and all
// three commands FAIL CLOSED with `IE_BULLETIN_VERSION_ATOMICITY_UNAVAILABLE`
// 503 rather than accepting a degraded mode. A 503 is truthful and retryable;
// writing one document of two would be neither.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const IeBulletinVersion = require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const IeOperation = require("../../models/CMS_Models/IndustrialEngineering/IeOperation");
const IeMethodStudy = require("../../models/CMS_Models/IndustrialEngineering/IeMethodStudy");
const { fail } = require("../storePurchase/errors");
const { transactionsAvailable } = require("../storePurchase/unitOfWork.service");
const { encodeCursor, decodeCursor, pageSize } = require("./ieRead.service");
const styleFiles = require("./ieStyleFile.service");
/* ── ONE RESOLVER FOR APPROVED TIMES, AND IT ALREADY EXISTS ────────────────
   `approvedTimesFor` carries the `laterApproval` tie-break — newest
   `approved.at`, then the larger `_id`. A version and any layout later opened
   from the same file must bind the SAME study, so a second resolver here would
   not be a convenience, it would be a second answer that eventually disagrees
   with the first about which approval was current. */
const layouts = require("./ieLineLayout.service");
const processRoutes = require("./ieProcessRoute.service");

const { STATE, LIMITS } = IeBulletinVersion;

/* ═══ HELPERS ══════════════════════════════════════════════════════════════ */

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v ?? ""));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const mintEventId = () => `bve_${crypto.randomBytes(9).toString("hex")}`;
const mintFileEventId = () => `fev_${crypto.randomBytes(9).toString("hex")}`;

const actorName = (actor) => str(actor?.name || actor?.email);
const actorId = (actor) => (isId(actor?.id) ? oid(actor.id) : null);

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

/** One indistinguishable refusal for absent, foreign and malformed alike. */
const versionNotFound = () => fail("IE_BULLETIN_VERSION_NOT_FOUND", "That bulletin version was not found.");
const fileNotFound = () => fail("IE_FILE_NOT_FOUND", "That engineering file was not found.");

/** Maker-checker needs an identity. A display name is not one. */
function requireActorIdentity(actor, what) {
  const id = actorId(actor);
  if (!id) throw fail("IE_BULLETIN_VERSION_MAKER_CHECKER", `${what} has to be attributable to a person.`);
  return id;
}

const versionEvent = (type, { actor, versionNo, summary = "" }) => ({
  eventId: mintEventId(),
  type,
  at: new Date(),
  actorId: actorId(actor),
  actorName: actorName(actor),
  versionNo,
  summary: summary.slice(0, LIMITS.SUMMARY),
});

/**
 * The file's own trail entry. The VERSION holds the decision and its reasons;
 * the file records only that its draft was frozen, released or superseded.
 *
 * `fileRevision` is THE REVISION THE FILE REACHES by this event — the same
 * meaning `IeStyleFile`'s own schema gives it, where it is required and at
 * least 1. It is passed in rather than derived here because only the caller
 * knows which revision its conditional update is about to produce.
 */
const fileEvent = (type, { actor, fileRevision, summary = "" }) => {
  if (!Number.isInteger(fileRevision) || fileRevision < 1) {
    /* A programming error, not a user one: an event that cannot say which
       revision it belongs to cannot be lined up with the record afterwards, and
       `$push` does not run subdocument validators to catch it. */
    throw new Error(`A file history event needs the revision it belongs to, not ${fileRevision}.`);
  }
  return {
    eventId: mintFileEventId(),
    type,
    at: new Date(),
    actorId: actorId(actor),
    actorName: actorName(actor),
    fileRevision,
    summary: summary.slice(0, 300),
  };
};

function readExpectedRevision(value, what) {
  if (value === undefined || value === null || value === "") {
    throw fail("VALIDATION", `Say which revision of this ${what} you read.`, {
      field: "expectedRevision",
      fieldErrors: [{ field: "expectedRevision", code: "REQUIRED", message: `Say which revision of this ${what} you read.` }],
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

/* Anything not on the allowlist is refused by name, never quietly dropped. */
const SUBMIT_FIELDS = Object.freeze(["expectedRevision"]);
const RETURN_BODY_FIELDS = Object.freeze(["expectedRevision", "reason"]);
const APPROVE_FIELDS = Object.freeze(["expectedRevision"]);

/* Every derived fact, and every concept a submitted snapshot must not take from
   a caller. The digests above all: a client that could send a fingerprint could
   make one source look like another. */
const REFUSED_FIELDS = Object.freeze({
  companyId: "the company — that comes from your own membership, never a body",
  bulletinVersionId: "its own id",
  versionNo: "its own version number, which the server allocates",
  state: "its own state — submit, return and approve are their own actions",
  revision: "its own revision — send `expectedRevision` to say which one you read",
  history: "its own audit trail",
  rows: "the bulletin rows — a version is a SNAPSHOT of the draft, taken by the server",
  totals: "a calculated total",
  sourceFingerprint: "a source fingerprint, which only the server computes",
  sourceApprovalDigest: "a source digest, which only the server computes",
  sourceRequirementDigest: "a source digest, which only the server computes",
  standardTimeMinutes: "a standard time — that comes from the approved method study",
  methodStudyId: "a method study reference, which the server resolves",
  submittedBy: "who submitted it, which comes from your session",
  approvedBy: "who approved it, which comes from your session",
  approvedAt: "when it was approved, which the server stamps",
  reviewedBy: "who reviewed it, which comes from your session",
  supersededByVersionNo: "a supersession, which only the approval transaction writes",
  fileRevisionAtSubmit: "which file revision was snapshotted, which the server reads",
  allowancePolicyId: "the allowance policy, which the server reads from the approved studies",
  /* The whole point of it: a caller who could send this could make a version
     confirm an R&D revision nobody reviewed. It is copied from the file the
     server read, inside the submit transaction, and never again. */
  technicalSource: "the R&D revision this version confirms, which the server freezes from the file",
});

function refuseUnknown(body, allowed, what) {
  if (body === null || body === undefined) return;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw fail("VALIDATION", `${what} is an object.`, { field: "body" });
  }
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue;
    const refused = REFUSED_FIELDS[key];
    throw fail("FIELD_NOT_ACCEPTED",
      refused ? `A bulletin version cannot carry ${refused}.` : `"${key}" is not part of ${what}.`,
      {
        field: key,
        fieldErrors: [{
          field: key, code: "NOT_ACCEPTED",
          message: refused ? `This record does not accept "${key}".` : `"${key}" is not part of ${what}.`,
        }],
      });
  }
}

/* ═══ THE TRANSACTION BOUNDARY ═════════════════════════════════════════════ */

/**
 * Run one command as a single unit, or refuse to run it at all.
 *
 * The probe is consulted BEFORE any domain work, so a deployment that cannot
 * commit two documents together never starts writing one of them.
 */
async function inTransaction(what, body) {
  if (!(await transactionsAvailable())) {
    throw fail("IE_BULLETIN_VERSION_ATOMICITY_UNAVAILABLE",
      `${what} writes both the bulletin version and its engineering file, and this deployment `
      + "cannot commit them together. Nothing was written.",
      { requires: "MONGODB_TRANSACTIONS", wrote: "NOTHING" });
  }

  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => {
      out = await body(session);
    });
    return out;
  } finally {
    await session.endSession().catch(() => {});
  }
}

/* ═══ THE READINESS GATES ══════════════════════════════════════════════════
 *
 * §11.10. Checked at submit — so an unusable snapshot is refused before a
 * reviewer is asked to look at it — and again at approve, because the operation
 * library and R&D can both move in between.
 *
 * ── THE COMPLETE LIST, NEVER THE FIRST FAILURE ────────────────────────────
 * Every gate is evaluated and every failure is returned together. Stopping at
 * the first turns one refusal into five round trips, and an engineer who fixes
 * what they were told and is refused again learns only that the system is
 * withholding.
 */
const gap = (code, action, message, extra = {}) => ({
  code, owner: "INDUSTRIAL_ENGINEERING", action, message, ...extra,
});

async function readinessGapsFor(ctx, file, { bound, timeGaps }) {
  const rows = file.bulletin?.rows || [];
  const gaps = [];

  /* 1 — an empty bulletin is not a submission. */
  if (!rows.length) {
    gaps.push(gap("IE_BULLETIN_EMPTY", "ADD_BULLETIN_ROWS",
      "This engineering file has no bulletin rows, so there is nothing to submit."));
  }

  /* 2 — the same row twice. The draft's own writer refuses this, so reaching it
     here means something wrote rows another way; the gate holds regardless. */
  const seen = new Set();
  const duplicated = new Set();
  for (const row of rows) {
    if (seen.has(row.rowId)) duplicated.add(row.rowId);
    seen.add(row.rowId);
  }
  if (duplicated.size) {
    gaps.push(gap("IE_BULLETIN_ROW_DUPLICATE", "REMOVE_DUPLICATE_ROWS",
      `${duplicated.size} bulletin row${duplicated.size === 1 ? " appears" : "s appear"} twice.`,
      { rowIds: [...duplicated] }));
  }

  /* 3 — every row needs an APPROVED method study at its exact operation
     revision. `approvedTimesFor` already answers this, with its own reasons. */
  for (const miss of timeGaps) {
    gaps.push(gap("IE_BULLETIN_ROW_NO_APPROVED_TIME", "APPROVE_METHOD_STUDY",
      miss.message,
      { rowId: miss.rowId, operationCode: miss.operationCode || "", reason: miss.reason }));
  }

  /* 4 — every operation ACTIVE, read from the library as it is NOW. §6.1, and
     there is no override at this gate in 7C1. */
  const referenced = [...new Set(rows.map((r) => String(r.ieOperationId)))];
  if (referenced.length) {
    const live = await IeOperation.find({
      _id: { $in: referenced.map(oid) }, companyId: ctx.companyId,
    }).select("_id status code name").lean();
    const byId = new Map(live.map((o) => [String(o._id), o]));
    const retired = [];
    const missing = [];
    for (const row of rows) {
      const op = byId.get(String(row.ieOperationId));
      if (!op) { missing.push(row); continue; }
      if (op.status !== "ACTIVE") retired.push({ row, op });
    }
    if (retired.length) {
      gaps.push(gap("IE_BULLETIN_VERSION_OPERATION_RETIRED", "REPLACE_RETIRED_OPERATION",
        `${retired.length} operation${retired.length === 1 ? " is" : "s are"} retired in the operation `
        + "library and this bulletin still uses them. A retired operation cannot be approved into a "
        + "bulletin version, and there is no override at this gate.",
        {
          rowIds: retired.map((r) => r.row.rowId),
          operationCodes: retired.map((r) => r.op.code),
          ieOperationIds: retired.map((r) => String(r.row.ieOperationId)),
        }));
    }
    if (missing.length) {
      /* An operation this company's library does not hold at all. Reported as
         its own gap rather than folded into "retired", which it is not. */
      gaps.push(gap("IE_BULLETIN_OPERATION_NOT_FOUND", "REPLACE_UNKNOWN_OPERATION",
        `${missing.length} bulletin row${missing.length === 1 ? " names an operation" : "s name operations"} `
        + "your company's library does not hold.",
        { rowIds: missing.map((r) => r.rowId) }));
    }
  }

  /* 5 — the file's R&D source version is still the approved one. Read from
     the source IN FORCE, so a file that has been moved onto the newer revision
     passes the gate it was failing — which is the whole point of the move. */
  const inForce = styleFiles.currentSourceOf(file);
  const currentApproved = await styleFiles.currentApprovedRevisionOf(file.sampleStyleId);
  if (currentApproved !== null
    && Number(currentApproved) !== Number(inForce.technicalRevision)) {
    gaps.push(gap("IE_SOURCE_VERSION_SUPERSEDED", "REBASE_ONTO_NEW_TECHNICAL_VERSION",
      `This file is engineered from technical revision ${inForce.technicalRevision}, and revision `
      + `${currentApproved} has since been approved. Nothing has been rewritten — open a successor `
      + "cycle against the newer revision and review what moved.",
      {
        fileSourceRevision: inForce.technicalRevision ?? null,
        sourceCycleNo: inForce.cycleNo,
        approvedRevision: Number(currentApproved),
      }));
  }

  /* 6 — and a move that has not been reviewed is not submittable. Carrying a
     row forward is not the same as confirming it still holds against the
     revision it is now being costed under; without this gate "carried
     forward" would quietly become "approved again". */
  const outstanding = styleFiles.outstandingRebaseReview(file);
  if (outstanding) {
    gaps.push(gap("IE_SOURCE_REBASE_REVIEW_OUTSTANDING", "REVIEW_REBASED_ROWS",
      outstanding.rowIds.length
        ? `This file was moved onto technical revision ${outstanding.technicalRevision}. `
          + `${outstanding.rowIds.length} row${outstanding.rowIds.length === 1 ? "" : "s"} the change `
          + "reaches must be reviewed again before this bulletin can be submitted."
        : `This file was moved onto technical revision ${outstanding.technicalRevision}. Confirm the `
          + "technical basis before submitting it.",
      {
        rowIds: outstanding.rowIds,
        sourceCycleNo: outstanding.cycleNo,
        technicalRevision: outstanding.technicalRevision,
        predecessorTechnicalRevision: outstanding.predecessorTechnicalRevision,
        materialsChanged: outstanding.materialsChanged,
        operationsChanged: outstanding.operationsChanged,
      }));
  }

  /* `bound` is unused by the gates themselves, and is taken as an argument so
     the caller resolves approved times exactly once for both the gates and the
     snapshot. */
  void bound;
  return gaps;
}

const notReady = (what, gaps) => fail("IE_BULLETIN_VERSION_NOT_READY",
  `This bulletin cannot be ${what}: ${gaps.length} thing${gaps.length === 1 ? "" : "s"} `
  + `need${gaps.length === 1 ? "s" : ""} attention.`,
  { gaps, gapCodes: gaps.map((g) => g.code) });

/* ═══ THE R&D SOURCE, FROZEN ═══════════════════════════════════════════════ */

/**
 * A stable key for one R&D technical revision.
 *
 * `SampleStyle.techSheet.technicalRevisions[]` is `{ _id: false }`, so there is
 * no document id to name. The number alone is not identity either: it is R&D's
 * own counter, and a record re-approved under the same number is a different
 * decision. So the key digests the revision's identity fields — the number, the
 * two moments and the outcome — and any of them moving produces a different
 * key, which is what lets a later reader say "not the revision that was
 * confirmed" rather than "same number, must be the same thing".
 *
 * Exported so the costing side computes it from exactly this rule rather than
 * a second spelling of it.
 */
function technicalRevisionKeyOf(revision) {
  if (!revision) return "";
  const at = (v) => (v ? new Date(v).toISOString() : "");
  return crypto.createHash("sha256").update([
    "rev", String(revision.revision ?? ""),
    "submitted", at(revision.submittedAt),
    "decided", at(revision.decidedAt),
    "outcome", str(revision.outcome),
  ].join("|")).digest("hex").slice(0, 32);
}

/**
 * What this submission confirms about R&D's record.
 *
 * Copied from the FILE, which froze it at creation and never re-reads it — the
 * gates above have already refused to submit when R&D has approved a newer
 * revision since, so what the file holds is what the reviewer is being asked
 * about.
 *
 * Counts are read off the snapshot once. They are counts and never totals: a
 * total consumption or a total SAM would be a figure this record is not the
 * authority for.
 */
function technicalSourceOf(file) {
  /* ── THE SOURCE IN FORCE, NOT THE ONE THE FILE WAS OPENED FROM ────────
     A file that has been moved onto a newer approved revision is engineered
     against THAT one, and the version being frozen has to say so — freezing
     the opening revision here would stamp a version with a key the gates had
     just finished checking a different one of, and the costing side would
     read it as stale the moment it was approved. `currentSourceOf` is the one
     resolver both sides ask. */
  const source = styleFiles.currentSourceOf(file);
  const snapshot = source.snapshot || null;
  const materials = Array.isArray(snapshot?.materials) ? snapshot.materials : [];
  const operations = Array.isArray(snapshot?.operations) ? snapshot.operations : [];
  return {
    sampleStyleId: file.sampleStyleId,
    technicalRevision: Number(source.technicalRevision ?? 0),
    technicalRevisionKey: technicalRevisionKeyOf({
      revision: source.technicalRevision,
      submittedAt: source.submittedAt,
      decidedAt: source.approvedAt,
      outcome: "approved",
    }),
    submittedAt: source.submittedAt || null,
    approvedAt: source.approvedAt || null,
    snapshot,
    materialCount: materials.length,
    operationCount: operations.length,
    fileSourceRevision: Number(source.technicalRevision ?? 0),
    /* Which cycle of this file's technical source the version was frozen
       against. 1 is the revision the file was opened from; 2 and up are
       successors it was deliberately moved onto. */
    sourceCycleNo: Number(source.cycleNo || 1),
    frozenAt: new Date(),
  };
}

/* ═══ THE SNAPSHOT ═════════════════════════════════════════════════════════ */

/**
 * Resolve the approved evidence and build the frozen rows.
 *
 * The draft row is the base — so the snapshot equals the draft field for field —
 * and the five evidence fields come from `approvedTimesFor`.
 */
async function snapshotOf(ctx, file) {
  const { bound, gaps: timeGaps } = await layouts.approvedTimesFor(ctx, file);
  const evidenceByRow = new Map(bound.map((b) => [b.rowId, b]));
  const draftRows = file.bulletin?.rows || [];

  const rows = draftRows.map((row, i) => {
    const evidence = evidenceByRow.get(row.rowId);
    return {
      rowId: row.rowId,
      /* The DRAFT's own order, not the resolver's running count: a snapshot that
         renumbered its rows would not equal the draft it was taken from. */
      sequence: i + 1,
      ieOperationId: row.ieOperationId,
      ieOperationRevision: row.ieOperationRevision,
      operationCode: row.operationCode || "",
      operationName: row.operationName || "",
      machineType: row.machineType || "",
      proposedSamMinutes: row.proposedSamMinutes ?? null,
      note: row.note || "",
      /* ── THE FROZEN REQUIREMENT EVIDENCE, COPIED WHOLE ─────────────────
         Copied from the draft row, never re-read from the operation library:
         a version is evidence of what the bulletin said when it was submitted.

         Chunk 8A-iii adds the attachment and labour halves. They are carried
         only when the DRAFT row actually froze them — `dimensionsCaptured` is
         what says so — because a version cannot invent evidence its draft never
         held, and a row drafted before this existed stays NOT_CAPTURED. */
      requirementSnapshot: freezeRequirementSnapshot(row.requirementSnapshot),
      standardTimeMinutes: evidence?.standardTimeMinutes ?? null,
      standardTimeSource: evidence?.standardTimeSource || "",
      methodStudyId: evidence?.methodStudyId ?? null,
      approvedSubmissionId: evidence?.approvedSubmissionId || "",
      approvedAt: evidence?.approvedAt ?? null,
    };
  });

  return { rows, bound, timeGaps };
}

/**
 * The stored form of a frozen requirement snapshot on a bulletin version.
 *
 * Deliberately NOT `publishRequirementSnapshot` — that one is the wire shape,
 * with ISO dates and nulls for the dimensions a row never captured. This is
 * what goes on disk, and it keeps the draft's own types and omits what the
 * draft omitted, so a legacy row stores exactly the three fields it always did.
 */
function freezeRequirementSnapshot(snapshot) {
  if (!snapshot) return null;
  const frozen = {
    capturedAt: snapshot.capturedAt || null,
    ieOperationRevision: snapshot.ieOperationRevision ?? null,
    requirementsConfigured: Boolean(snapshot.requirementsConfigured),
    machineTypes: (snapshot.machineTypes || []).map((m) => ({
      machineType: m.machineType, quantity: m.quantity,
    })),
  };
  const captured = Array.isArray(snapshot.dimensionsCaptured) ? snapshot.dimensionsCaptured : [];
  if (!captured.length) return frozen;

  frozen.dimensionsCaptured = [...captured];
  frozen.machines = (snapshot.machines || []).map((m) => ({
    requirementId: m.requirementId,
    sequence: m.sequence,
    machineType: m.machineType,
    quantity: m.quantity,
  }));
  frozen.attachments = (snapshot.attachments || []).map((a) => ({
    requirementId: a.requirementId,
    sequence: a.sequence,
    code: a.code,
    name: a.name,
    quantity: a.quantity,
    note: a.note || "",
  }));
  frozen.labour = (snapshot.labour || []).map((l) => ({
    requirementId: l.requirementId,
    sequence: l.sequence,
    workerType: l.workerType,
    quantity: l.quantity,
    skillCode: l.skillCode || "",
    skillName: l.skillName || "",
    grade: l.grade || "",
    note: l.note || "",
  }));
  return frozen;
}

/** Decimal-safe totals, on the lane's one rounding policy. */
function totalsOf(rows) {
  const units = rows.reduce(
    (sum, r) => sum + (Number.isFinite(r.standardTimeMinutes) ? Math.round(r.standardTimeMinutes * 10000) : 0),
    0,
  );
  return {
    garmentSamMinutes: Math.round((units / 10000) * 10000) / 10000,
    samRowCount: rows.length,
    samDerivation: "SUM_OF_APPROVED_METHOD_STUDY_STANDARD_TIMES",
  };
}

/**
 * The published allowance policy behind these approved times.
 *
 * Read off the approved studies themselves rather than re-resolved by date: the
 * studies recorded which policy decided them, and re-resolving could name a
 * different one that has been published since. Null when the studies disagree —
 * a single value would be a claim none of them supports.
 */
async function allowancePolicyOf(ctx, rows) {
  const unknown = { allowancePolicyId: null, allowancePolicyRevision: null };

  const studyIds = rows.map((r) => r.methodStudyId).filter(Boolean);
  if (!studyIds.length) return unknown;

  const studies = await IeMethodStudy.find({
    _id: { $in: studyIds }, companyId: ctx.companyId,
  }).select("_id allowancePolicy.policyId allowancePolicy.policyRevision").lean();

  /* Every study this snapshot binds has to be readable. One that is not leaves
     a policy nobody can account for, and an answer drawn from the rest would be
     a claim about studies that were never consulted. */
  if (studies.length !== studyIds.length) return unknown;

  /* ── THE IDENTITY IS THE PAIR, NOT THE ID ──────────────────────────────
     A policy is versioned, and two revisions of one policy are two different
     sets of allowance percentages. Publishing the id alone when the revisions
     disagree would name a policy that decided none of these times — and the
     reader who used it to explain a standard minute would be reading the wrong
     percentages off the right record, which is worse than being told nothing.

     `null` is not "no policy". It is "these times do not share one", and a
     reader who needs the policy behind a particular row reads that row's own
     study. */
  const pairs = new Set(studies.map((st) => {
    const id = st.allowancePolicy?.policyId;
    const revision = st.allowancePolicy?.policyRevision;
    return `${id ? String(id) : ""}@${revision ?? ""}`;
  }));
  if (pairs.size !== 1) return unknown;

  const [only] = studies;
  const policyId = only.allowancePolicy?.policyId || null;
  const policyRevision = Number(only.allowancePolicy?.policyRevision);
  /* A policy named without a revision is half an identity, and half an identity
     is not one. Checked as a whole number of at least 1 rather than merely as a
     finite one, because `Number(null)` is 0 and a revision of 0 is not a
     revision — it is an absence that would have been stored as a number. */
  if (!policyId || !Number.isInteger(policyRevision) || policyRevision < 1) return unknown;
  return { allowancePolicyId: policyId, allowancePolicyRevision: policyRevision };
}

/* ═══ PUBLISHING ═══════════════════════════════════════════════════════════ */

const publishRow = (r) => ({
  rowId: r.rowId,
  sequence: r.sequence,
  ieOperationId: String(r.ieOperationId),
  ieOperationRevision: r.ieOperationRevision,
  operationCode: r.operationCode || "",
  operationName: r.operationName || "",
  machineType: r.machineType || "",
  proposedSamMinutes: r.proposedSamMinutes ?? null,
  note: r.note || "",
  /* The one shared wire projection — see `ieStyleFile.service.js`. Three
     surfaces publishing frozen requirement evidence in three spellings is how
     a screen ends up reading the draft's shape and the version's shape as two
     different kinds of fact. */
  requirementSnapshot: styleFiles.publishRequirementSnapshot(r.requirementSnapshot),
  standardTimeMinutes: r.standardTimeMinutes ?? null,
  standardTimeSource: r.standardTimeSource || "",
  methodStudyId: r.methodStudyId ? String(r.methodStudyId) : null,
  approvedSubmissionId: r.approvedSubmissionId || "",
  approvedAt: r.approvedAt ? new Date(r.approvedAt).toISOString() : null,
});

const publishEvent = (e) => ({
  eventId: e.eventId,
  type: e.type,
  at: e.at ? new Date(e.at).toISOString() : null,
  actorName: e.actorName || "",
  versionNo: e.versionNo,
  summary: e.summary || "",
});

function publishVersion(doc, { withRows = true, withHistory = false } = {}) {
  return {
    bulletinVersionId: String(doc._id),
    companyId: String(doc.companyId),
    styleFileId: String(doc.ieStyleFileId),
    sampleStyleId: String(doc.sampleStyleId),
    versionNo: doc.versionNo,
    state: doc.state,
    revision: doc.revision,
    fileRevisionAtSubmit: doc.fileRevisionAtSubmit,

    ...(withRows ? { rows: (doc.rows || []).map(publishRow) } : {}),
    rowCount: (doc.rows || []).length,
    totals: {
      garmentSamMinutes: doc.totals?.garmentSamMinutes ?? null,
      samRowCount: doc.totals?.samRowCount ?? 0,
      samDerivation: doc.totals?.samDerivation || "",
    },
    allowancePolicyId: doc.allowancePolicyId ? String(doc.allowancePolicyId) : null,
    allowancePolicyRevision: doc.allowancePolicyRevision ?? null,

    /* The route frozen with this version: DECLARED with its stages, or
       UNKNOWN with `stages: null` when none was declared at submission. */
    processRoute: processRoutes.publishRoute(doc.processRoute),

    source: {
      fingerprint: doc.sourceFingerprint,
      approvalDigest: doc.sourceApprovalDigest,
      requirementDigest: doc.sourceRequirementDigest || "",
    },

    /* ── WHAT THIS VERSION CONFIRMS ABOUT R&D ─────────────────────────────
       Identity and counts. The SNAPSHOT itself is deliberately not published
       here: this projection is read by IE screens and by order listings, and
       R&D's full technical content is not theirs to hand out. Central Costing
       reads the snapshot from the stored document, having proved the version
       is the current approved one.

       `null` on a version submitted before this existed — which a reader must
       treat as "confirms no revision", never as revision 0. */
    technicalSource: doc.technicalSource
      ? {
          sampleStyleId: String(doc.technicalSource.sampleStyleId || ""),
          technicalRevision: doc.technicalSource.technicalRevision ?? null,
          technicalRevisionKey: doc.technicalSource.technicalRevisionKey || "",
          approvedAt: doc.technicalSource.approvedAt
            ? new Date(doc.technicalSource.approvedAt).toISOString() : null,
          materialCount: doc.technicalSource.materialCount ?? 0,
          operationCount: doc.technicalSource.operationCount ?? 0,
        }
      : null,

    submittedByName: doc.submittedByName || "",
    submittedAt: doc.submittedAt ? new Date(doc.submittedAt).toISOString() : null,
    reviewedByName: doc.reviewedByName || "",
    reviewedAt: doc.reviewedAt ? new Date(doc.reviewedAt).toISOString() : null,
    returnReason: doc.returnReason || "",
    approvedByName: doc.approvedByName || "",
    approvedAt: doc.approvedAt ? new Date(doc.approvedAt).toISOString() : null,

    supersedesVersionNo: doc.supersedesVersionNo ?? null,
    supersededByVersionNo: doc.supersededByVersionNo ?? null,

    /* A submitted snapshot is frozen from the instant it exists. Said in the
       payload so no screen infers an edit control from a non-terminal state. */
    contentEditable: false,
    isTerminal: IeBulletinVersion.TERMINAL.has(doc.state),

    ...(withHistory ? { history: [...(doc.history || [])].reverse().map(publishEvent) } : {}),
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

/* ═══ OWNERSHIP ════════════════════════════════════════════════════════════ */

async function loadOwnedFile(ctx, fileId) {
  assertContext(ctx);
  if (!isId(fileId)) throw fileNotFound();
  const doc = await IeStyleFile.findOne({ _id: oid(fileId), companyId: ctx.companyId }).lean();
  if (!doc) throw fileNotFound();
  return doc;
}

async function loadOwnedVersion(ctx, versionId) {
  assertContext(ctx);
  if (!isId(versionId)) throw versionNotFound();
  const doc = await IeBulletinVersion.findOne({ _id: oid(versionId), companyId: ctx.companyId }).lean();
  if (!doc) throw versionNotFound();
  return doc;
}

/* ═══ SUBMIT ═══════════════════════════════════════════════════════════════ */

async function submitVersion(ctx, { fileId, body = {}, actor } = {}) {
  const file = await loadOwnedFile(ctx, fileId);
  refuseUnknown(body, SUBMIT_FIELDS, "a bulletin submission");
  const expected = readExpectedRevision(body.expectedRevision, "engineering file");
  const submitter = requireActorIdentity(actor, "Submitting a bulletin");

  /* ── ALREADY UNDER REVIEW, ANSWERED BEFORE ANY WORK ─────────────────────
     The conditional file update below would refuse this anyway, and the partial
     unique index would refuse it again. This read-first branch exists only to
     name the version already in review, which neither of those can do. */
  if (file.bulletinReviewVersionId) throw submissionExists(file);

  const { rows, timeGaps } = await snapshotOf(ctx, file);
  const gaps = await readinessGapsFor(ctx, file, { bound: null, timeGaps });
  if (gaps.length) throw notReady("submitted", gaps);

  const totals = totalsOf(rows);
  const policy = await allowancePolicyOf(ctx, rows);
  /* Server-computed from the same helpers Chunk 6A uses over a layout's bound
     rows, so a version and a layout of the same source agree digit for digit. */
  const digests = layouts.sourceDigestsOf(rows);
  const fingerprint = layouts.sourceFingerprintOf(rows);
  const frozenRoute = processRoutes.freezeRoute(file.bulletin?.processRoute);

  /* ── A DUPLICATE KEY HERE IS A LOST RACE, AND IS ANSWERED AS ONE ────────
     Two mechanisms refuse a second submission and either is sufficient: the
     file's `bulletinReviewVersionId: { $exists: false }` clause, and the partial
     unique index on `state: "IN_REVIEW"`. When the index is the one that
     answers, the driver raises E11000 inside the transaction — which aborts it,
     writing nothing, and must reach the caller as the 409 it is rather than as
     an unclassified failure. The unique `versionNo` index can answer the same
     way when two submissions allocate the same number. One company-scoped
     re-read then says which. */
  try {
    return await submitInTransaction();
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const now = await IeStyleFile.findOne({ _id: file._id, companyId: ctx.companyId })
      .select("_id revision bulletinReviewVersionId bulletinReviewVersionNo").lean();
    if (now?.bulletinReviewVersionId) throw submissionExists(now);
    throw fail("IE_FILE_REVISION_CONFLICT",
      "Somebody submitted this bulletin while you were preparing this submission. "
      + "Re-read it and decide again. Nothing was submitted.",
      { expected, actual: now?.revision ?? null, fileId: String(file._id) });
  }

  async function submitInTransaction() {
  return inTransaction("Submitting a bulletin", async (session) => {
    /* ── ALLOCATE THE VERSION NUMBER INSIDE THE TRANSACTION ──────────────
       The highest for this file plus one — never a count, which would reuse a
       number the moment anything was ever removed and would quietly hide a gap.
       The unique index is the actual arbiter: a racing pair means the loser's
       transaction aborts on the duplicate key rather than minting a twin. */
    const highest = await IeBulletinVersion
      .findOne({ companyId: ctx.companyId, ieStyleFileId: file._id })
      .sort({ versionNo: -1 }).select("versionNo").session(session).lean();
    const versionNo = (highest?.versionNo ?? 0) + 1;

    const previousApproved = await IeBulletinVersion
      .findOne({ companyId: ctx.companyId, ieStyleFileId: file._id, state: STATE.APPROVED })
      .select("versionNo").session(session).lean();

    const submittedAt = new Date();
    const [created] = await IeBulletinVersion.create([{
      companyId: ctx.companyId,
      ieStyleFileId: file._id,
      sampleStyleId: file.sampleStyleId,
      versionNo,
      state: STATE.IN_REVIEW,
      revision: 1,
      fileRevisionAtSubmit: expected,
      rows,
      /* The draft route, frozen with the rows it was declared beside. Left
         absent — never an empty route — when the draft declared none. */
      ...(frozenRoute ? { processRoute: frozenRoute } : {}),
      totals,
      allowancePolicyId: policy.allowancePolicyId,
      allowancePolicyRevision: policy.allowancePolicyRevision,
      sourceFingerprint: fingerprint,
      sourceApprovalDigest: digests.approval,
      sourceRequirementDigest: digests.requirement,
      /* What this version confirms about R&D. Frozen here, inside the same
         transaction that mints the version, so a version can never exist
         without saying which technical revision it was reviewed against. */
      technicalSource: technicalSourceOf(file),
      submittedBy: submitter,
      submittedByName: actorName(actor),
      submittedAt,
      supersedesVersionNo: previousApproved?.versionNo ?? null,
      history: [versionEvent("BULLETIN_VERSION_SUBMITTED", {
        actor, versionNo,
        summary: `Submitted version ${versionNo} from file revision ${expected} — `
          + `${rows.length} row${rows.length === 1 ? "" : "s"}, `
          + `${totals.garmentSamMinutes} standard minutes`,
      })],
    }], { session });

    /* ── AND THE FREEZE, IN THE SAME TRANSACTION ─────────────────────────
       `bulletinReviewVersionId: { $exists: false }` is what makes a second
       submission impossible before the partial unique index is even consulted:
       a file already holding a review pointer matches no filter. */
    const nextFileRevision = expected + 1;
    const frozen = await IeStyleFile.findOneAndUpdate(
      {
        _id: file._id, companyId: ctx.companyId, revision: expected, status: "DRAFT",
        bulletinReviewVersionId: { $exists: false },
      },
      {
        $set: {
          bulletinReviewVersionId: created._id,
          bulletinReviewVersionNo: versionNo,
          updatedBy: actorId(actor), updatedByName: actorName(actor),
        },
        $inc: { revision: 1 },
        $push: {
          history: {
            $each: [fileEvent("BULLETIN_VERSION_SUBMITTED", {
              actor, fileRevision: nextFileRevision,
              summary: `Bulletin submitted as version ${versionNo}; the draft is frozen until it is returned or approved`,
            })],
            $slice: -IeStyleFile.LIMITS.HISTORY,
          },
        },
      },
      { new: true, session },
    ).lean();

    if (!frozen) {
      /* ── THE SNAPSHOT GOES BACK WITH IT ───────────────────────────────
         Throwing aborts the transaction, so the version created moments ago is
         rolled back too. There is no interleaving that leaves an orphan
         `IN_REVIEW` version beside an editable draft. */
      const now = await IeStyleFile.findOne({ _id: file._id, companyId: ctx.companyId })
        .select("_id revision status bulletinReviewVersionId bulletinReviewVersionNo")
        .session(session).lean();
      if (!now) throw fileNotFound();
      if (now.bulletinReviewVersionId) throw submissionExists(now);
      throw fail("IE_FILE_REVISION_CONFLICT",
        "Somebody changed this engineering file while you were preparing this submission. "
        + "Re-read it and decide again. Nothing was submitted.",
        { expected, actual: now.revision, fileId: String(now._id) });
    }

    return {
      created: true,
      version: publishVersion(created.toObject(), { withHistory: true }),
      file: await styleFiles.readPublished(frozen),
    };
  });
  }
}

const isDuplicateKey = (err) =>
  err?.code === 11000 || /E11000|duplicate key/i.test(str(err?.message));

const submissionExists = (file) => fail("IE_BULLETIN_VERSION_SUBMISSION_EXISTS",
  "This bulletin already has a submission under review. It has to be returned or approved "
  + "before another can be submitted.",
  {
    fileId: String(file._id),
    bulletinReviewVersionId: String(file.bulletinReviewVersionId),
    bulletinReviewVersionNo: file.bulletinReviewVersionNo ?? null,
  });

/* ═══ READ AND LIST ════════════════════════════════════════════════════════ */

async function readVersion(ctx, { versionId } = {}) {
  const doc = await loadOwnedVersion(ctx, versionId);
  return { version: publishVersion(doc, { withHistory: true }) };
}

/** This file's versions, newest version number first. */
async function listVersions(ctx, { fileId, state, limit, cursor } = {}) {
  const file = await loadOwnedFile(ctx, fileId);
  const size = pageSize(limit);
  const after = decodeCursor(cursor, "id");

  const wanted = str(state).toUpperCase();
  if (wanted && !IeBulletinVersion.STATES.includes(wanted)) {
    throw fail("VALIDATION", `A bulletin version is ${IeBulletinVersion.STATES.join(", ")}.`, {
      field: "state",
      fieldErrors: [{ field: "state", code: "INVALID", message: IeBulletinVersion.STATES.join(", ") }],
    });
  }

  const and = [{ companyId: ctx.companyId, ieStyleFileId: file._id }];
  if (wanted) and.push({ state: wanted });
  if (after) {
    /* The shared decoder validates the id half; the version number is this
       list's own and is validated here. A marker this list did not issue is
       refused by name rather than silently restarting at page one, which reads
       as duplicated work rather than an error. */
    const from = Number(after.v);
    if (!Number.isInteger(from) || from < 1) {
      throw fail("VALIDATION", "That page marker is not one this list issued.", { field: "cursor" });
    }
    and.push({ versionNo: { $lt: from } });
  }

  const found = await IeBulletinVersion.find({ $and: and })
    .sort({ versionNo: -1 }).limit(size + 1).lean();
  const page = found.slice(0, size);
  const last = page[page.length - 1];

  return {
    /* The list omits the rows: a page of ten versions of a four-hundred-row
       bulletin is four thousand rows nobody asked for. One version's rows come
       from its own read. */
    versions: page.map((v) => publishVersion(v, { withRows: false })),
    stateFilter: wanted || null,
    limit: size,
    hasMore: found.length > size,
    nextCursor: found.length > size ? encodeCursor({ v: last.versionNo, i: String(last._id) }) : null,
    sort: "versionNo:desc",
  };
}

/* ═══ RETURN ═══════════════════════════════════════════════════════════════ */

async function returnVersion(ctx, { versionId, body = {}, actor } = {}) {
  const current = await loadOwnedVersion(ctx, versionId);
  refuseUnknown(body, RETURN_BODY_FIELDS, "a bulletin return");
  const expected = readExpectedRevision(body.expectedRevision, "bulletin version");
  const reviewer = requireActorIdentity(actor, "Returning a bulletin version");

  const reason = str(body.reason);
  if (!reason) {
    /* A rejection nobody wrote down is indistinguishable from a mistake six
       months later, and the person who has to act on it learns nothing. */
    throw fail("IE_BULLETIN_VERSION_REVIEW_REASON_REQUIRED",
      "Say why this bulletin version is being returned.",
      {
        field: "reason",
        fieldErrors: [{ field: "reason", code: "REQUIRED", message: "Say why this is being returned." }],
      });
  }
  if (reason.length > LIMITS.RETURN_REASON) {
    throw fail("VALIDATION", `A return reason is at most ${LIMITS.RETURN_REASON} characters.`, {
      field: "reason",
      fieldErrors: [{ field: "reason", code: "TOO_LONG", message: `At most ${LIMITS.RETURN_REASON} characters.` }],
    });
  }
  if (current.state !== STATE.IN_REVIEW) throw transitionInvalid(current, "returned");

  return inTransaction("Returning a bulletin version", async (session) => {
    const returned = await IeBulletinVersion.findOneAndUpdate(
      {
        _id: current._id, companyId: ctx.companyId, ieStyleFileId: current.ieStyleFileId,
        state: STATE.IN_REVIEW, revision: expected,
      },
      {
        $set: {
          state: STATE.RETURNED,
          reviewedBy: reviewer, reviewedByName: actorName(actor), reviewedAt: new Date(),
          returnReason: reason,
        },
        $inc: { revision: 1 },
        $push: {
          history: {
            $each: [versionEvent("BULLETIN_VERSION_RETURNED", {
              actor, versionNo: current.versionNo,
              summary: `Returned: ${reason}`,
            })],
            $slice: -LIMITS.HISTORY,
          },
        },
      },
      { new: true, session },
    ).lean();

    if (!returned) throw await classifyMiss(ctx, current, expected, "returned", session);

    /* ── THE FILE'S REVISION, READ INSIDE THE TRANSACTION ────────────────
       So the history event can say which revision it belongs to. Read here
       rather than before the transaction because anything read outside it could
       have moved by the time the update runs, and the event would then name a
       revision the file never reached. */
    const before = await IeStyleFile
      .findOne({ _id: current.ieStyleFileId, companyId: ctx.companyId })
      .select("_id revision bulletinReviewVersionId").session(session).lean();
    if (!before) throw fileNotFound();
    const nextFileRevision = before.revision + 1;

    /* ── THE PREDICATE IS THE POINT ──────────────────────────────────────
       `bulletinReviewVersionId: current._id`. A blind `$unset` would let a
       return for one version release a freeze belonging to another — and since
       only one version can be in review at a time, that freeze would then be
       protecting nothing while its own version still claimed it.

       `revision: before.revision` joins it, so the event pushed in this same
       write names exactly the revision the `$inc` produces. If anything moved
       the file between the read above and this write, the filter misses and the
       whole transaction rolls back rather than recording a revision that never
       existed. */
    const file = await IeStyleFile.findOneAndUpdate(
      {
        _id: current.ieStyleFileId, companyId: ctx.companyId,
        bulletinReviewVersionId: current._id, revision: before.revision,
      },
      {
        $unset: { bulletinReviewVersionId: "", bulletinReviewVersionNo: "" },
        $set: { updatedBy: actorId(actor), updatedByName: actorName(actor) },
        $inc: { revision: 1 },
        $push: {
          history: {
            $each: [fileEvent("BULLETIN_VERSION_RETURNED", {
              actor, fileRevision: nextFileRevision,
              summary: `Version ${current.versionNo} was returned; the draft is editable again`,
            })],
            $slice: -IeStyleFile.LIMITS.HISTORY,
          },
        },
      },
      { new: true, session },
    ).lean();

    if (!file) {
      /* The version said it was in review and the file does not name it. That is
         the divergence the transaction exists to prevent, so nothing commits. */
      throw fail("IE_BULLETIN_VERSION_TRANSITION_INVALID",
        "This bulletin version is not the one freezing its engineering file's draft. Nothing was changed.",
        { bulletinVersionId: String(current._id), fileId: String(current.ieStyleFileId) });
    }

    return {
      updated: true,
      version: publishVersion(returned, { withHistory: true }),
      file: await styleFiles.readPublished(file),
    };
  });
}

/* ═══ APPROVE ══════════════════════════════════════════════════════════════ */

async function approveVersion(ctx, { versionId, body = {}, actor } = {}) {
  const current = await loadOwnedVersion(ctx, versionId);
  refuseUnknown(body, APPROVE_FIELDS, "a bulletin approval");
  const expected = readExpectedRevision(body.expectedRevision, "bulletin version");
  const approver = requireActorIdentity(actor, "Approving a bulletin version");

  if (current.state !== STATE.IN_REVIEW) throw transitionInvalid(current, "approved");

  /* ── MAKER-CHECKER FIRST, AND BY ID ──────────────────────────────────────
     Not a missing role — the wrong PERSON. An owner and a platform
     administrator are refused on identical terms, and the comparison is of
     stable actor ids, never display names: two people share a name far more
     often than they share an id, and a name is editable by its owner.

     Asked before readiness so that somebody who may not decide is not handed a
     detailed account of what remains to be fixed. */
  if (String(current.submittedBy) === String(approver)) {
    throw fail("IE_BULLETIN_VERSION_MAKER_CHECKER",
      "A bulletin version has to be approved by somebody other than the person who submitted it.",
      { bulletinVersionId: String(current._id), submittedByName: current.submittedByName || "" });
  }

  /* ── AND THE GATES AGAIN, AGAINST THE FILE AS IT IS NOW ──────────────────
     Checked at submit too, but the operation library and R&D can both move
     while a submission waits, and approving a bulletin that names an operation
     retired yesterday would release work nobody can perform. */
  const file = await IeStyleFile.findOne({ _id: current.ieStyleFileId, companyId: ctx.companyId }).lean();
  if (!file) throw versionNotFound();
  const { timeGaps } = await snapshotOf(ctx, file);
  const gaps = await readinessGapsFor(ctx, file, { bound: null, timeGaps });
  if (gaps.length) throw notReady("approved", gaps);

  return inTransaction("Approving a bulletin version", async (session) => {
    const approvedAt = new Date();
    const approved = await IeBulletinVersion.findOneAndUpdate(
      {
        _id: current._id, companyId: ctx.companyId, ieStyleFileId: current.ieStyleFileId,
        state: STATE.IN_REVIEW, revision: expected,
      },
      {
        $set: {
          state: STATE.APPROVED,
          approvedBy: approver, approvedByName: actorName(actor), approvedAt,
        },
        $inc: { revision: 1 },
        $push: {
          history: {
            $each: [versionEvent("BULLETIN_VERSION_APPROVED", {
              actor, versionNo: current.versionNo,
              summary: `Approved version ${current.versionNo}`,
            })],
            $slice: -LIMITS.HISTORY,
          },
        },
      },
      { new: true, session },
    ).lean();

    if (!approved) throw await classifyMiss(ctx, current, expected, "approved", session);

    /* ── SUPERSEDE THE PREDECESSOR, IF THERE IS ONE ──────────────────────
       The only path in the system that may move APPROVED → SUPERSEDED, and the
       model's guard permits it by naming those two fields rather than by
       exempting this caller. */
    let superseded = null;
    /* Read first, because the event about to be pushed onto the predecessor is
       the PREDECESSOR'S event and has to carry the predecessor's own version
       number. An event on version 1 reading `versionNo: 2` would say that
       version 2 was superseded, which is the opposite of what happened. */
    const standing = await IeBulletinVersion.findOne({
      companyId: ctx.companyId, ieStyleFileId: current.ieStyleFileId,
      state: STATE.APPROVED, _id: { $ne: current._id },
    }).select("_id versionNo revision").session(session).lean();

    if (standing) {
      const predecessor = await IeBulletinVersion.findOneAndUpdate(
        {
          _id: standing._id, companyId: ctx.companyId, ieStyleFileId: current.ieStyleFileId,
          state: STATE.APPROVED,
        },
        {
          $set: { state: STATE.SUPERSEDED, supersededByVersionNo: current.versionNo },
          $inc: { revision: 1 },
          $push: {
            history: {
              $each: [versionEvent("BULLETIN_VERSION_SUPERSEDED", {
                actor,
                /* Whose event this is… */
                versionNo: standing.versionNo,
                /* …and who displaced it. */
                summary: `Superseded by version ${current.versionNo}`,
              })],
              $slice: -LIMITS.HISTORY,
            },
          },
        },
        { new: true, session },
      ).lean();
      /* It was APPROVED a moment ago inside this transaction, so a miss means
         something moved it concurrently and nothing here may commit. */
      if (!predecessor) {
        throw fail("IE_BULLETIN_VERSION_TRANSITION_INVALID",
          "The previously approved version moved while this approval was being made. Nothing was changed.",
          { bulletinVersionId: String(standing._id), versionNo: standing.versionNo });
      }
      superseded = predecessor.versionNo;
    }

    /* ── ONE FILE UPDATE: THE FREEZE CLEARED AND THE POINTER MOVED ───────
       Both in the same `$set`/`$unset`, so a file pointing at a version that is
       not approved, an approved version the file does not point at, and a
       cleared freeze with no new pointer are each unreachable rather than
       merely unlikely. */
    /* The file's revision, read inside the transaction, so the event names
       exactly the revision the `$inc` below produces — and joined to the filter
       so a concurrent move rolls the whole approval back rather than recording
       a revision the file never reached. */
    const beforeFile = await IeStyleFile
      .findOne({ _id: current.ieStyleFileId, companyId: ctx.companyId })
      .select("_id revision bulletinReviewVersionId").session(session).lean();
    if (!beforeFile) throw versionNotFound();
    const nextFileRevision = beforeFile.revision + 1;

    const updatedFile = await IeStyleFile.findOneAndUpdate(
      {
        _id: current.ieStyleFileId, companyId: ctx.companyId,
        bulletinReviewVersionId: current._id, revision: beforeFile.revision,
      },
      {
        $unset: { bulletinReviewVersionId: "", bulletinReviewVersionNo: "" },
        $set: {
          currentApprovedBulletinVersionId: current._id,
          currentApprovedVersionNo: current.versionNo,
          updatedBy: actorId(actor), updatedByName: actorName(actor),
        },
        $inc: { revision: 1 },
        $push: {
          history: {
            $each: [fileEvent("BULLETIN_VERSION_APPROVED", {
              actor, fileRevision: nextFileRevision,
              summary: `Version ${current.versionNo} approved`
                + (superseded ? `, superseding version ${superseded}` : "")
                + "; the draft is editable again as the successor",
            })],
            $slice: -IeStyleFile.LIMITS.HISTORY,
          },
        },
      },
      { new: true, session },
    ).lean();

    if (!updatedFile) {
      throw fail("IE_BULLETIN_VERSION_TRANSITION_INVALID",
        "This bulletin version is not the one freezing its engineering file's draft. Nothing was changed.",
        { bulletinVersionId: String(current._id), fileId: String(current.ieStyleFileId) });
    }

    return {
      updated: true,
      version: publishVersion(approved, { withHistory: true }),
      file: await styleFiles.readPublished(updatedFile),
      ...(superseded ? { supersededVersionNo: superseded } : {}),
    };
  });
}

/* ═══ CLASSIFYING A MISSED CONDITIONAL WRITE ═══════════════════════════════ */

const transitionInvalid = (doc, verb) => fail("IE_BULLETIN_VERSION_TRANSITION_INVALID",
  `A bulletin version in ${doc.state} cannot be ${verb}.`
  + (IeBulletinVersion.TERMINAL.has(doc.state)
    ? " That state is final — edit the draft and submit a new version."
    : ""),
  { bulletinVersionId: String(doc._id), state: doc.state, versionNo: doc.versionNo });

/**
 * One company-scoped re-read to say WHICH precondition failed, and no more.
 *
 * Both the approval and the return filter on `state` AND `revision`, so a miss
 * is one of two things and the caller deserves to know which: a race with the
 * other decision, or a stale `expectedRevision`.
 */
async function classifyMiss(ctx, current, expected, verb, session) {
  const now = await IeBulletinVersion
    .findOne({ _id: current._id, companyId: ctx.companyId })
    .select("_id state revision versionNo").session(session).lean();
  if (!now) return versionNotFound();
  if (now.state !== STATE.IN_REVIEW) return transitionInvalid(now, verb);
  return fail("IE_BULLETIN_VERSION_REVISION_CONFLICT",
    "Somebody acted on this bulletin version while you were reading it. Re-read it and decide again.",
    { expected, actual: now.revision, bulletinVersionId: String(now._id) });
}

module.exports = {
  technicalRevisionKeyOf,
  STATE, LIMITS,
  SUBMIT_FIELDS, RETURN_BODY_FIELDS, APPROVE_FIELDS, REFUSED_FIELDS,
  publishVersion, publishRow, publishEvent, readinessGapsFor, snapshotOf, totalsOf,
  submitVersion, readVersion, listVersions, returnVersion, approveVersion,
};
