"use strict";
// services/merchandising/preProductionMeeting.service.js
//
// THE PRE-PRODUCTION MEETING, AS A RECORD RATHER THAN AS A STATUS.
//
// PPM is Pre-Production MEETING. PPC — Production Planning and Control — is a
// different application, reads this later, and is the only one that decides
// whether an order can be planned or released. Nothing in this file books
// capacity, allocates a line, releases production or writes another
// department's record.
//
// ── THE ONE THING THAT MAKES THIS HARD ──────────────────────────────────────
// A minute is only evidence if it says which VERSION of each thing was on the
// table. "We reviewed the trim card" is worthless; "we reviewed Materials &
// Trims revision 3, approved on the 8th" can be checked. So the source
// snapshot is SERVER-DERIVED, every time, from each owning application's own
// published read — and the browser cannot state any of it. A client that could
// post `materialTrimRevisionNo: 3` could record a meeting about a revision
// that never existed.
//
// ── AND THE SECOND THING ────────────────────────────────────────────────────
// Most of those sources belong to other departments, and several of them will
// say nothing at all: Store is not reporting yet, IE may not have released,
// PPC may not have answered. A minute that turned silence into "ready" would
// be the single most dangerous record in the system, because it reads like
// evidence. So absence is carried as ABSENCE — UNAVAILABLE, NOT_REPORTED or
// UNKNOWN, each meaning a different thing — straight into the frozen snapshot,
// and issuing is never blocked on it. Merchandising cannot make another
// department answer, and pretending otherwise would only stop the meeting
// being minuted.
//
// ── WHAT ISSUING ACTUALLY REQUIRES ──────────────────────────────────────────
// Only what Merchandising owns: that the meeting happened, who chaired it, who
// was there, the snapshot, a conclusion, and decisions that are structurally
// whole. Everything else is recorded as it stands.

const crypto = require("crypto");
const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const {
  PreProductionMeeting, PPM_STATE, OPEN_STATES, FROZEN_STATES,
  PPM_CONCLUSION, REVIEW_TOPIC, REVIEW_TOPICS,
  DECISION_STATUS, DECISION_STATUSES, UNRESOLVED_STATUSES,
  OWNER_DEPARTMENTS, SOURCE_AVAILABILITY,
} = require("../../models/CMS_Models/Merchandising/PreProductionMeeting");
const {
  MerchandisingAuditEvent, MerchandisingCommandLedger,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { Counter } = require("../salesJourneyRef");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

/* ═══ WHAT MAY BE STATED, AND BY WHOM ══════════════════════════════════════ */

/**
 * THE ONLY FIELDS A BROWSER MAY SEND.
 *
 * An allowlist by construction, the same discipline every other Merchandising
 * command uses. Everything a SERVER owns — the file, the order line, the
 * style, every source version, the conclusion, the state, the issuer — is
 * absent from it, so there is no path by which a client states one.
 */
const DRAFT_FIELDS = Object.freeze([
  "plannedMeetingDate", "actualMeetingAt", "locationOrMode",
  "chairperson", "merchandisingRepresentative", "attendees", "absentDepartments",
  "reviewNotes", "decisions",
  "expectedRevision", "idempotencyKey",
]);

/** Named so a refusal can say WHOSE fact it is, rather than "not allowed". */
const REFUSED_FIELDS = Object.freeze({
  fileId: "the Execution File this meeting is rooted in",
  fileNumber: "the Execution File's own number",
  orderRef: "the order, which Sales confirmed",
  orderLineRef: "the order line's permanent reference",
  styleRef: "the style, which Sales owns",
  sampleStyleId: "the style record",
  ppmRef: "the meeting's own reference",
  versionNo: "the version number",
  state: "the lifecycle state",
  conclusion: "the meeting's outcome, which is derived from its decisions",
  sourceReferences: "the reviewed versions, which the server reads from each owner",
  sourcesCapturedAt: "when the snapshot was taken",
  conductedAt: "when the meeting happened, recorded by conducting it",
  conductedBy: "who conducted it",
  issuedAt: "when the minutes were issued",
  issuedBy: "who issued them",
  supersededByVersionNo: "supersession, which a successor records",
  successorOfVersionNo: "the predecessor, which the server carries forward",
  topicsRequiringReReview: "which topics moved, which the server compares",
  companyId: "your company, which is proved from your grant",
});

function assertShape(body) {
  const unexpected = Object.keys(body || {}).filter((k) => !DRAFT_FIELDS.includes(k));
  if (!unexpected.length) return;
  const owner = REFUSED_FIELDS[unexpected[0]];
  throw fail("FIELD_NOT_ACCEPTED",
    owner
      ? `"${unexpected[0]}" is ${owner}. A pre-production meeting records what was reviewed; it does not state it.`
      : `"${unexpected[0]}" is not a field a pre-production meeting carries.`,
    { field: unexpected[0], allowed: DRAFT_FIELDS });
}

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

async function withTxn(work) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await work(session); });
    return out;
  } catch (err) {
    if (/Transaction numbers|replica set|transactions are not supported/i.test(str(err?.message))) {
      throw fail("MERCHANDISING_TRANSACTION_REQUIRED",
        "This deployment cannot record the decision atomically. Ask an operator — the database needs a replica set.");
    }
    throw err;
  } finally { session.endSession(); }
}

const hashRequest = (value) => crypto.createHash("sha256")
  .update(JSON.stringify(value ?? null)).digest("hex");

/**
 * THE SAME COMMAND LEDGER EVERY OTHER MERCHANDISING COMMAND USES, WITH TWO
 * PROPERTIES THIS SLICE NEEDS FROM IT.
 *
 * ── ONE: A REPLAY IS THE FIRST ANSWER, NOT A SUMMARY OF IT ──────────────────
 * The stored `payload` is the public response verbatim. A caller whose
 * connection dropped and who retried gets back exactly what the caller who
 * did not would have got, so "did that go through?" is answered by repeating
 * the command rather than by inspecting the record and guessing.
 *
 * ── TWO: THE LEDGER AND THE RECORD CANNOT DISAGREE ──────────────────────────
 * The ledger row is written INSIDE the command's own transaction. Written
 * afterwards, a crash in between leaves a command that happened with no
 * record that it did — and the retry then re-runs it. Both land or neither
 * does, and a refused command writes no row at all, so its key stays usable
 * once the reason for the refusal is gone.
 *
 * The lookup happens twice on purpose: once cheaply before the transaction,
 * and once inside it. The inner one is what makes a racing duplicate work —
 * the loser's transaction is retried by the driver, and on the retry it finds
 * the winner's row and replays it instead of failing.
 *
 * `prepare` runs between the two, outside the transaction. It is for the
 * reads that call other applications: holding a transaction open across a
 * slow department would make that department a Merchandising outage.
 */
async function once(ctx, { scope, idempotencyKey, request, prepare }, run) {
  const key = str(idempotencyKey);
  if (!key) {
    throw fail("IDEMPOTENCY_KEY_REQUIRED",
      "Send an idempotency key with this command, so a retry cannot take the decision twice.",
      { field: "idempotencyKey" });
  }
  const requestHash = hashRequest(request);
  const where = { companyId: ctx.companyId, scope, idempotencyKey: key };

  const replayOf = (held) => {
    if (held.requestHash !== requestHash) {
      throw fail("IDEMPOTENCY_KEY_REUSED",
        "That idempotency key was already used for a different request.",
        { field: "idempotencyKey" });
    }
    return { replayed: true, ...(held.payload || held.result) };
  };

  const held = await MerchandisingCommandLedger.findOne(where).lean();
  if (held) return replayOf(held);

  const prepared = prepare ? await prepare() : undefined;

  return withTxn(async (session) => {
    const inFlight = await MerchandisingCommandLedger.findOne(where).session(session).lean();
    if (inFlight) return replayOf(inFlight);

    const result = await run(session, prepared);
    await MerchandisingCommandLedger.create([{
      ...where,
      requestHash,
      /* The summary every other command writes, unchanged… */
      result: {
        revisionId: result?.ppmId ? new mongoose.Types.ObjectId(result.ppmId) : null,
        revisionNo: result?.versionNo ?? null,
        state: str(result?.state), note: str(result?.ppmRef),
      },
      /* …and the reply itself, which is what a retry gets back. */
      payload: result,
      at: new Date(),
    }], { session, ordered: true });
    return { replayed: false, ...result };
  });
}

/* ═══ WHO IS DOING THIS ════════════════════════════════════════════════════ */

/**
 * THE AUTHENTICATED IDENTITY, WHICH IS AN ID AND NOT A LABEL.
 *
 * ── WHY NOT EMAIL, AND WHY NOT A NAME ───────────────────────────────────────
 * Both are labels people carry, and both move. An address changes on a
 * marriage, a rebrand or a typo correction, and the moment it does, a
 * maker/checker rule comparing addresses stops recognising the person it was
 * written to catch — silently, and in the direction that permits rather than
 * refuses. Names are worse: two people called A. Kumar are two people, and a
 * rule that reads them as one blocks a real second signature for ever.
 *
 * So the comparison is on the stable authenticated id and on nothing else.
 * The name and address travel alongside it because minutes are read by humans
 * and "issued by 64f2…c1" is not a sentence — but they are display, never
 * evidence of who acted.
 *
 * ── AND IT FAILS CLOSED ─────────────────────────────────────────────────────
 * A request that arrives without one cannot conduct or issue. An unattributed
 * decision on permanent evidence is worse than a refused one: the refusal is
 * visible and somebody fixes it, whereas the record of a meeting nobody can
 * be shown to have taken is discovered years later by an auditor.
 */
function identityOf(actor) {
  const id = str(actor?.id);
  if (!id) {
    throw fail("PPM_IDENTITY_REQUIRED",
      "This decision is recorded against the person taking it, and your session "
      + "carries no stable identity. Sign in again.",
      { field: "actor" });
  }
  return { id, name: str(actor?.name), email: str(actor?.email) };
}

/** The same person, decided on the id. Absent either side, it is not. */
const samePerson = (a, b) => Boolean(str(a?.id) && str(b?.id) && str(a.id) === str(b.id));

/**
 * Fields a COMMAND body may carry, and the refusal for everything else.
 *
 * Commands are small — a key, an expected revision, and for cancellation a
 * reason — so the list is short and anything outside it is a caller trying to
 * state something the server owns. `actorId`, `conductedBy` and `issuedBy` are
 * the ones that matter: identity comes from the session, and a body that could
 * name the actor is a body that could sign somebody else's name.
 */
const COMMAND_FIELDS = Object.freeze([
  "idempotencyKey", "expectedRevision", "reason",
  "expectedIssuedVersionNo", "expectedIssuedRevision", "plannedMeetingDate",
]);

function assertCommandShape(body) {
  const unexpected = Object.keys(body || {}).filter((k) => !COMMAND_FIELDS.includes(k));
  if (!unexpected.length) return;
  const field = unexpected[0];
  const owner = REFUSED_FIELDS[field];
  throw fail("FIELD_NOT_ACCEPTED",
    ["actorId", "actor", "createdBy", "updatedBy"].includes(field)
      ? `"${field}" is not accepted. Who is acting is read from your session, never from the request.`
      : owner
        ? `"${field}" is ${owner}. A command does not state it.`
        : `"${field}" is not a field this command carries.`,
    { field, allowed: COMMAND_FIELDS });
}

function assertExpected(doc, expected) {
  if (expected === undefined || expected === null || expected === "") {
    throw fail("VALIDATION", "Say which revision of the meeting you are changing.",
      { field: "expectedRevision" });
  }
  if (Number(expected) !== Number(doc.revision ?? 0)) {
    throw fail("PPM_REVISION_CONFLICT",
      "Somebody else changed this meeting while you were working. Reload and try again.",
      { expected: Number(expected), actual: Number(doc.revision ?? 0) });
  }
}

/* ═══ THE FILE, AND THE IDENTITY IT CARRIES ════════════════════════════════ */

async function loadFile(ctx, fileId, session = null) {
  assertContext(ctx);
  /* A malformed id, a missing file and a foreign one are ONE answer. Any
     difference between them lets a stranger test whether a file exists. */
  if (!isId(fileId)) throw fail("NOT_FOUND", "Execution file not found.");
  const q = ExecutionFile.findOne({ _id: fileId, companyId: ctx.companyId });
  const file = session ? await q.session(session) : await q;
  if (!file) throw fail("NOT_FOUND", "Execution file not found.");
  return file;
}

/** PPM-YYYY-NNNN, from the shared CRM counter. */
async function nextPpmRef(year = new Date().getFullYear()) {
  const doc = await Counter.findOneAndUpdate(
    { key: `merchandisingPreProductionMeeting:${year}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return `PPM-${year}-${String(doc.seq).padStart(4, "0")}`;
}

/* ═══ THE SOURCE SNAPSHOT ══════════════════════════════════════════════════ */

/** Which sources a meeting reviews, and which topic each one belongs under. */
const SOURCE = Object.freeze({
  EXECUTION_PACK: { key: "EXECUTION_PACK", label: "Merchandising execution pack", topic: null },
  MATERIAL_TRIM: { key: "MATERIAL_TRIM", label: "Materials & trims", topic: REVIEW_TOPIC.MATERIAL_TRIM },
  PACKAGING: { key: "PACKAGING", label: "Packaging specification", topic: REVIEW_TOPIC.PACKAGING_PRESENTATION },
  DEVELOPMENT: { key: "DEVELOPMENT", label: "Development requirements", topic: REVIEW_TOPIC.CONSTRUCTION },
  APPROVALS: { key: "APPROVALS", label: "Samples and approvals", topic: REVIEW_TOPIC.MEASUREMENT_FIT },
  TNA_BASELINE: { key: "TNA_BASELINE", label: "Time & Action baseline", topic: REVIEW_TOPIC.SHIPMENT_CRITICAL },
  IE_RELEASE: { key: "IE_RELEASE", label: "Engineering release", topic: REVIEW_TOPIC.MACHINE_ATTACHMENT },
  PPC_IE_RECEIPT: { key: "PPC_IE_RECEIPT", label: "PPC's answer to the engineering release", topic: null },
  DEPARTMENT_STATUS: { key: "DEPARTMENT_STATUS", label: "Department status observations", topic: null },
});
const SOURCE_KEYS = Object.freeze(Object.keys(SOURCE));

/**
 * THE SOURCE-SNAPSHOT CONTRACT VERSION.
 *
 *   (absent) — minutes captured before the contract was versioned. They may
 *              carry an IE_RELEASE row, but it names no record id, so nothing
 *              downstream can tell which release it was.
 *   2        — every source that can be identified by record IS, and an
 *              absent row is a positive statement that there was nothing to
 *              review rather than a gap in what could be captured.
 *
 * Bumped when the MEANING of a captured row changes, never for a cosmetic
 * one: a reader keyed to this number is deciding whether an absence is
 * evidence, and that is not a question a display change may move.
 */
const SOURCES_CONTRACT_VERSION = 2;

const present = (key, fields) => ({
  key, label: SOURCE[key].label, availability: SOURCE_AVAILABILITY.PRESENT, ...fields,
});
const absent = (key, availability, note) => ({
  key, label: SOURCE[key].label, availability, note,
  reference: "", versionNo: null, revisionNo: null, state: "", sourceUpdatedAt: null,
  recordId: null,
});

/**
 * WHAT WAS ON THE TABLE, READ FROM EACH OWNER'S OWN PUBLISHED CONTRACT.
 *
 * Every read below goes through the owning application's public service. Not
 * one of them opens another application's collection: a join written here
 * would keep answering the old question the day that application changes what
 * it means, silently, because a stale join returns rows rather than an error.
 *
 * A source that cannot be read is recorded as absent, with WHICH KIND of
 * absence. None of them ever becomes zero, complete, approved or ready.
 */
async function captureSources(ctx, file) {
  const rows = [];
  const at = new Date();

  /* ── MERCHANDISING'S OWN, THROUGH ITS OWN SERVICES ─────────────────── */
  const selection = require("./selection.service");
  const executionPack = require("./executionPack.service");
  const approvals = require("./approvalRegister.service");
  const tna = require("./tnaPlan.service");
  const departmentStatus = require("./departmentStatus.service");

  try {
    const pack = await executionPack.getPack(ctx, { fileId: file._id });
    const p = pack?.pack;
    rows.push(p
      ? present(SOURCE.EXECUTION_PACK.key, {
        reference: str(file.fileNumber), versionNo: p.packVersionNo ?? null,
        revisionNo: null, state: str(p.state), sourceUpdatedAt: p.updatedAt || null,
      })
      : absent(SOURCE.EXECUTION_PACK.key, SOURCE_AVAILABILITY.UNKNOWN,
        "No execution pack has been assembled on this file yet."));
  } catch {
    rows.push(absent(SOURCE.EXECUTION_PACK.key, SOURCE_AVAILABILITY.UNKNOWN,
      "The execution pack could not be read."));
  }

  try {
    const { selections } = await selection.fileSelectionStatus(ctx, { fileId: file._id });
    for (const key of ["MATERIAL_TRIM", "PACKAGING", "DEVELOPMENT"]) {
      const s = selections[key];
      rows.push(s?.approvedRevisionNo
        ? present(key, {
          reference: str(s.documentName), versionNo: null,
          revisionNo: s.approvedRevisionNo, state: str(s.status),
          sourceUpdatedAt: s.approvedAt || null,
        })
        : absent(key, SOURCE_AVAILABILITY.UNKNOWN,
          `Nothing has been approved for ${str(s?.label) || key.toLowerCase()} on this file.`));
    }
  } catch {
    for (const key of ["MATERIAL_TRIM", "PACKAGING", "DEVELOPMENT"]) {
      rows.push(absent(key, SOURCE_AVAILABILITY.UNKNOWN, "The selection could not be read."));
    }
  }

  try {
    const summary = await approvals.approvalSummary(ctx, { fileId: file._id });
    const total = Number(summary?.counts?.total ?? 0);
    rows.push(total > 0
      ? present(SOURCE.APPROVALS.key, {
        reference: "Approval register", versionNo: null, revisionNo: total,
        state: "RECORDED", sourceUpdatedAt: at,
      })
      : absent(SOURCE.APPROVALS.key, SOURCE_AVAILABILITY.UNKNOWN,
        "No sample or approval reference has been recorded on this file."));
  } catch {
    rows.push(absent(SOURCE.APPROVALS.key, SOURCE_AVAILABILITY.UNKNOWN,
      "The approval register could not be read."));
  }

  try {
    const plan = await tna.getPlan(ctx, { fileId: file._id });
    const baseline = plan?.baseline;
    rows.push(baseline
      ? present(SOURCE.TNA_BASELINE.key, {
        reference: str(plan.plan?.templateName), versionNo: plan.plan?.templateVersionNo ?? null,
        revisionNo: baseline.baselineNo ?? null, state: str(plan.plan?.state),
        sourceUpdatedAt: baseline.approvedAt || plan.plan?.updatedAt || null,
      })
      : absent(SOURCE.TNA_BASELINE.key, SOURCE_AVAILABILITY.UNKNOWN,
        plan?.plan
          ? "The Time & Action plan has no approved baseline, so no dates are committed."
          : "No Time & Action plan has been created on this file."));
  } catch {
    rows.push(absent(SOURCE.TNA_BASELINE.key, SOURCE_AVAILABILITY.UNKNOWN,
      "The Time & Action plan could not be read."));
  }

  /* ── INDUSTRIAL ENGINEERING'S OWN PUBLICATION ─────────────────────────
     IE says which release is in force for this style. A join from here
     through IE's style file would be Merchandising knowing IE's shape. */
  const sampleStyleId = file.currentExecutionProjection?.sampleStyleId || null;
  let ieRelease = null;
  try {
    const ie = require("../industrialEngineering/ieRelease.service");
    ieRelease = sampleStyleId
      ? await ie.currentReleaseForStyle(ctx, { sampleStyleId })
      : null;
    rows.push(ieRelease
      ? present(SOURCE.IE_RELEASE.key, {
        /* The RECORD and its version, which is what "the same release" means
           downstream. The ref travels beside them to be read, never matched
           on: PPC compares ids and versions, and a renamed release must not
           read as a different one, nor a reused code as the same one. */
        recordId: ieRelease.releaseId || null,
        reference: str(ieRelease.releaseRef), versionNo: ieRelease.versionNo ?? null,
        revisionNo: null, state: str(ieRelease.state),
        sourceUpdatedAt: ieRelease.updatedAt || ieRelease.issuedAt || null,
      })
      : absent(SOURCE.IE_RELEASE.key, SOURCE_AVAILABILITY.NOT_REPORTED,
        sampleStyleId
          ? "Industrial Engineering has issued no release for this style."
          : "This order line names no style record, so no engineering release can be resolved."));
  } catch {
    rows.push(absent(SOURCE.IE_RELEASE.key, SOURCE_AVAILABILITY.UNAVAILABLE,
      "Industrial Engineering could not be asked."));
  }

  /* ── AND PPC'S OWN ANSWER TO IT ───────────────────────────────────── */
  try {
    if (!ieRelease) {
      rows.push(absent(SOURCE.PPC_IE_RECEIPT.key, SOURCE_AVAILABILITY.NOT_REPORTED,
        "There is no engineering release for PPC to have answered."));
    } else {
      const ppc = require("../ppc/ieReleaseAck.service");
      const receipt = await ppc.receiptStateFor(ctx, {
        releaseRef: ieRelease.releaseRef, versionNo: ieRelease.versionNo,
      });
      rows.push(receipt && receipt.state !== "PENDING"
        ? present(SOURCE.PPC_IE_RECEIPT.key, {
          reference: str(receipt.releaseRef), versionNo: receipt.versionNo ?? null,
          revisionNo: null, state: str(receipt.state),
          sourceUpdatedAt: receipt.decidedAt || null,
        })
        : absent(SOURCE.PPC_IE_RECEIPT.key, SOURCE_AVAILABILITY.NOT_REPORTED,
          "PPC has not yet decided on this engineering release."));
    }
  } catch {
    rows.push(absent(SOURCE.PPC_IE_RECEIPT.key, SOURCE_AVAILABILITY.UNAVAILABLE,
      "PPC could not be asked."));
  }

  /* ── WHAT THE OTHER DEPARTMENTS HAVE REPORTED, IF ANYTHING ─────────── */
  try {
    const register = await departmentStatus.register(ctx, { fileId: file._id });
    /* A department that has actually said something has a status code. Every
       other row is a sentence explaining why it has not, and counting those
       would turn eight silences into "eight reported". */
    const reported = (register?.rows || []).filter((r) => str(r.statusCode));
    rows.push(reported.length
      ? present(SOURCE.DEPARTMENT_STATUS.key, {
        reference: "Department status", versionNo: null, revisionNo: reported.length,
        state: "REPORTED", sourceUpdatedAt: at,
      })
      : absent(SOURCE.DEPARTMENT_STATUS.key, SOURCE_AVAILABILITY.NOT_REPORTED,
        "No department is reporting to Merchandising on this file yet."));
  } catch {
    rows.push(absent(SOURCE.DEPARTMENT_STATUS.key, SOURCE_AVAILABILITY.UNAVAILABLE,
      "The department status register could not be read."));
  }

  return { rows, at, contractVersion: SOURCES_CONTRACT_VERSION };
}

/* ═══ THE CONCLUSION ═══════════════════════════════════════════════════════ */

const unresolvedOf = (decisions) =>
  (decisions || []).filter((d) => UNRESOLVED_STATUSES.includes(str(d.status)));

/**
 * The meeting's outcome, DERIVED and never stated.
 *
 * Neither word is "ready". A meeting that closed every clarification has still
 * not decided that this order can go to production — that is PPC's decision,
 * made later, against this evidence among other things.
 */
const concludeFrom = (decisions) => (unresolvedOf(decisions).length
  ? PPM_CONCLUSION.CONDUCTED_WITH_OPEN_CLARIFICATIONS
  : PPM_CONCLUSION.CONDUCTED_WITHOUT_OPEN_CLARIFICATIONS);

/* ═══ WHAT A CALLER MAY WRITE INTO A DRAFT ═════════════════════════════════ */

const dateOrNull = (v, field) => {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw fail("VALIDATION", `"${field}" is not a date.`, { field });
  return d;
};

function shapeAttendees(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw fail("VALIDATION", "Attendees are a list.", { field: "attendees" });
  }
  return value.map((a, i) => {
    const name = str(a?.name);
    const department = str(a?.department).toUpperCase();
    if (!name) {
      throw fail("VALIDATION", "An attendee has a name.", { field: `attendees[${i}].name` });
    }
    if (!OWNER_DEPARTMENTS.includes(department)) {
      throw fail("VALIDATION",
        `"${department || "(blank)"}" is not a department somebody can be recorded as representing.`,
        { field: `attendees[${i}].department`, allowed: OWNER_DEPARTMENTS });
    }
    return { name, department, role: str(a?.role) };
  });
}

function shapeDepartments(value, field) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw fail("VALIDATION", `"${field}" is a list.`, { field });
  return value.map((d) => {
    const dept = str(d).toUpperCase();
    if (!OWNER_DEPARTMENTS.includes(dept)) {
      throw fail("VALIDATION", `"${dept || "(blank)"}" is not a department.`,
        { field, allowed: OWNER_DEPARTMENTS });
    }
    return dept;
  });
}

function shapeReviewNotes(value, actor, at) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw fail("VALIDATION", "Review notes are a list.", { field: "reviewNotes" });
  }
  return value.map((n, i) => {
    const topic = str(n?.topic).toUpperCase();
    if (!REVIEW_TOPICS.includes(topic)) {
      throw fail("VALIDATION",
        `"${topic || "(blank)"}" is not a topic a pre-production meeting reviews.`,
        { field: `reviewNotes[${i}].topic`, allowed: REVIEW_TOPICS });
    }
    const observation = str(n?.observation);
    if (observation.length < 3) {
      throw fail("VALIDATION", "A review note records what was said.",
        { field: `reviewNotes[${i}].observation` });
    }
    const sourceKey = str(n?.sourceKey).toUpperCase();
    if (sourceKey && !SOURCE_KEYS.includes(sourceKey)) {
      throw fail("VALIDATION", `"${sourceKey}" is not a source this meeting reviews.`,
        { field: `reviewNotes[${i}].sourceKey`, allowed: SOURCE_KEYS });
    }
    return {
      topic, observation, sourceKey,
      recordedBy: n?.recordedBy?.name ? n.recordedBy : (actor || undefined),
      recordedAt: n?.recordedAt ? new Date(n.recordedAt) : at,
    };
  });
}

/** The fields a decision row may carry. No assignee, no due date, no reminder. */
const DECISION_FIELDS = Object.freeze([
  "decisionRef", "topic", "decision", "ownerDepartment", "status",
  "sourceKey", "closureNote", "externalTaskRef",
]);
const TASKY_FIELDS = Object.freeze({
  assignee: "an assignee", assignedTo: "an assignee", dueDate: "a due date",
  due: "a due date", reminder: "a reminder", priority: "a priority",
  checklist: "a checklist", subtasks: "subtasks",
});

function shapeDecisions(value, actor, at, existing = []) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw fail("VALIDATION", "Decisions are a list.", { field: "decisions" });
  }
  const before = new Map((existing || []).map((d) => [str(d.decisionRef), d]));
  return value.map((d, i) => {
    for (const k of Object.keys(d || {})) {
      if (TASKY_FIELDS[k]) {
        /* ── THE TASKS APP OWNS TASKS ────────────────────────────────────
           A minute that grew an assignee and a due date would become a task
           list with worse notifications, and the real one would go unused. */
        throw fail("FIELD_NOT_ACCEPTED",
          `A decision carries no ${TASKY_FIELDS[k]}. Follow-up work lives in the Tasks app; `
          + "record its reference in `externalTaskRef` instead.",
          { field: `decisions[${i}].${k}` });
      }
      if (!DECISION_FIELDS.includes(k)) {
        throw fail("FIELD_NOT_ACCEPTED", `"${k}" is not a field a decision carries.`,
          { field: `decisions[${i}].${k}`, allowed: DECISION_FIELDS });
      }
    }
    const text = str(d?.decision);
    if (text.length < 3) {
      throw fail("VALIDATION", "A decision says what was decided or asked.",
        { field: `decisions[${i}].decision` });
    }
    const ownerDepartment = str(d?.ownerDepartment).toUpperCase();
    if (!OWNER_DEPARTMENTS.includes(ownerDepartment)) {
      throw fail("VALIDATION",
        `"${ownerDepartment || "(blank)"}" is not a department a decision can be owned by.`,
        { field: `decisions[${i}].ownerDepartment`, allowed: OWNER_DEPARTMENTS });
    }
    const status = str(d?.status).toUpperCase() || DECISION_STATUS.OPEN;
    if (!DECISION_STATUSES.includes(status)) {
      throw fail("VALIDATION", `"${status}" is not a decision status.`,
        { field: `decisions[${i}].status`, allowed: DECISION_STATUSES });
    }
    if ([DECISION_STATUS.CLOSED, DECISION_STATUS.NOT_APPLICABLE].includes(status)
      && !str(d?.closureNote)) {
      throw fail("VALIDATION",
        "A decision that is closed or not applicable says why, so the minute can be read later.",
        { field: `decisions[${i}].closureNote` });
    }
    const topic = str(d?.topic).toUpperCase();
    if (topic && !REVIEW_TOPICS.includes(topic)) {
      throw fail("VALIDATION", `"${topic}" is not a topic.`,
        { field: `decisions[${i}].topic`, allowed: REVIEW_TOPICS });
    }
    const sourceKey = str(d?.sourceKey).toUpperCase();
    if (sourceKey && !SOURCE_KEYS.includes(sourceKey)) {
      throw fail("VALIDATION", `"${sourceKey}" is not a source this meeting reviews.`,
        { field: `decisions[${i}].sourceKey`, allowed: SOURCE_KEYS });
    }
    /* A reference a caller already holds is kept, so an open point keeps its
       identity across an edit and across a successor. */
    const ref = str(d?.decisionRef) && before.has(str(d.decisionRef))
      ? str(d.decisionRef)
      : `PD-${crypto.randomBytes(5).toString("hex")}`;
    const prior = before.get(ref);
    return {
      decisionRef: ref,
      topic: topic || undefined,
      decision: text,
      ownerDepartment,
      status,
      sourceKey,
      closureNote: str(d?.closureNote),
      externalTaskRef: str(d?.externalTaskRef),
      recordedBy: prior?.recordedBy || actor || undefined,
      recordedAt: prior?.recordedAt || at,
      updatedBy: prior ? (actor || undefined) : undefined,
      updatedAt: prior ? at : null,
    };
  });
}

/* ═══ VIEWS ════════════════════════════════════════════════════════════════ */

const actorView = (a) => (a?.name || a?.email
  ? { name: str(a.name), email: str(a.email) } : null);

const sourceView = (s) => ({
  key: str(s.key), label: str(s.label), availability: str(s.availability),
  reference: str(s.reference), versionNo: s.versionNo ?? null,
  revisionNo: s.revisionNo ?? null, state: str(s.state),
  sourceUpdatedAt: s.sourceUpdatedAt || null, note: str(s.note),
});

function ppmView(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    ppmRef: str(doc.ppmRef),
    versionNo: doc.versionNo,
    state: str(doc.state),
    fileId: String(doc.fileId),
    fileNumber: str(doc.fileNumber),
    handoverRef: str(doc.handoverRef),
    handoverLineRef: str(doc.handoverLineRef),
    orderRef: str(doc.orderRef),
    orderLineRef: str(doc.orderLineRef),
    styleRef: str(doc.styleRef),

    plannedMeetingDate: doc.plannedMeetingDate || null,
    actualMeetingAt: doc.actualMeetingAt || null,
    locationOrMode: str(doc.locationOrMode),
    chairperson: str(doc.chairperson),
    merchandisingRepresentative: str(doc.merchandisingRepresentative),
    attendees: (doc.attendees || []).map((a) => ({
      name: str(a.name), department: str(a.department), role: str(a.role),
    })),
    absentDepartments: (doc.absentDepartments || []).map(str),

    sourceReferences: (doc.sourceReferences || []).map(sourceView),
    sourcesCapturedAt: doc.sourcesCapturedAt || null,

    reviewNotes: (doc.reviewNotes || []).map((n) => ({
      topic: str(n.topic), observation: str(n.observation), sourceKey: str(n.sourceKey),
      recordedByName: str(n.recordedBy?.name), recordedAt: n.recordedAt || null,
    })),
    decisions: (doc.decisions || []).map((d) => ({
      decisionRef: str(d.decisionRef), topic: str(d.topic) || null,
      decision: str(d.decision), ownerDepartment: str(d.ownerDepartment),
      status: str(d.status), sourceKey: str(d.sourceKey),
      closureNote: str(d.closureNote), externalTaskRef: str(d.externalTaskRef),
      recordedByName: str(d.recordedBy?.name), recordedAt: d.recordedAt || null,
      updatedByName: str(d.updatedBy?.name), updatedAt: d.updatedAt || null,
    })),
    openClarificationCount: unresolvedOf(doc.decisions).length,

    conclusion: str(doc.conclusion) || null,
    conductedAt: doc.conductedAt || null,
    conductedBy: actorView(doc.conductedBy),
    issuedAt: doc.issuedAt || null,
    issuedBy: actorView(doc.issuedBy),
    cancelledAt: doc.cancelledAt || null,
    cancellationReason: str(doc.cancellationReason),

    supersededAt: doc.supersededAt || null,
    supersededByVersionNo: doc.supersededByVersionNo ?? null,
    successorOfVersionNo: doc.successorOfVersionNo ?? null,
    topicsRequiringReReview: (doc.topicsRequiringReReview || []).map(str),

    revision: doc.revision ?? 0,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** The read-only order and style band, from the file's OWN accepted projection. */
function orderView(file) {
  const p = file.currentExecutionProjection || {};
  const deliveries = (p.deliveries || []).map((d) => ({
    dropRef: str(d.dropRef),
    committedDeliveryDate: d.committedDeliveryDate || null,
    quantity: d.quantity ?? null,
    nominatedFactoryRef: str(d.nominatedFactoryRef),
  }));
  return {
    fileId: String(file._id),
    fileNumber: str(file.fileNumber),
    buyerDisplayLabel: str(p.buyerDisplayLabel),
    orderRef: str(p.orderRef),
    orderLineRef: str(p.orderLineRef),
    styleRef: str(p.styleRef),
    buyerStyleRef: str(p.buyerStyleRef),
    productName: str(p.productName),
    /* The colourway/variant, where the order line records one. */
    breakdown: (p.breakdown || []).map((b) => ({
      lineSplitRef: str(b.lineSplitRef),
      sizeRange: str(b.sizeRange),
      quantity: b.quantity ?? null,
      attributes: (b.attributes || []).map((a) => ({ name: str(a.name), value: str(a.value) })),
    })),
    totalQuantity: p.totalQuantity ?? null,
    deliveries,
    /* Only where it is actually recorded. A blank factory is blank. */
    factoryRefs: deliveries.map((d) => d.nominatedFactoryRef).filter(Boolean),
    lifecycleStatus: str(file.lifecycleStatus),
  };
}

/* ═══ READS ════════════════════════════════════════════════════════════════ */

const currentQuery = (ctx, file) => ({
  companyId: ctx.companyId, fileId: file._id,
  state: { $in: [...OPEN_STATES, PPM_STATE.ISSUED] },
});

/** The file's PPM position: the version being worked on, and the one in force. */
async function getCurrent(ctx, { fileId } = {}) {
  const file = await loadFile(ctx, fileId);
  const [working, issued] = await Promise.all([
    PreProductionMeeting.findOne({
      companyId: ctx.companyId, fileId: file._id, state: { $in: [...OPEN_STATES] },
    }).lean(),
    PreProductionMeeting.findOne({
      companyId: ctx.companyId, fileId: file._id, state: PPM_STATE.ISSUED,
    }).lean(),
  ]);
  return {
    order: orderView(file),
    working: ppmView(working),
    issued: ppmView(issued),
    topics: REVIEW_TOPICS,
    departments: OWNER_DEPARTMENTS,
    decisionStatuses: DECISION_STATUSES,
    sourceKeys: SOURCE_KEYS,
  };
}

async function listVersions(ctx, { fileId } = {}) {
  const file = await loadFile(ctx, fileId);
  const rows = await PreProductionMeeting
    .find({ companyId: ctx.companyId, fileId: file._id })
    .sort({ versionNo: -1 }).lean();
  return {
    fileId: String(file._id),
    versions: rows.map((r) => ({
      id: String(r._id), ppmRef: str(r.ppmRef), versionNo: r.versionNo,
      state: str(r.state), conclusion: str(r.conclusion) || null,
      actualMeetingAt: r.actualMeetingAt || null,
      issuedAt: r.issuedAt || null, issuedByName: str(r.issuedBy?.name),
      supersededByVersionNo: r.supersededByVersionNo ?? null,
      openClarificationCount: unresolvedOf(r.decisions).length,
    })),
  };
}

async function getVersion(ctx, { fileId, versionNo } = {}) {
  const file = await loadFile(ctx, fileId);
  const doc = await PreProductionMeeting.findOne({
    companyId: ctx.companyId, fileId: file._id, versionNo: Number(versionNo),
  }).lean();
  if (!doc) throw fail("PPM_NOT_FOUND", "That version of the meeting does not exist.");
  return { order: orderView(file), meeting: ppmView(doc) };
}

/**
 * HOW THE SOURCES STAND NOW AGAINST WHAT A VERSION RECORDED.
 *
 * A comparison, never a repair: an issued minute is not rewritten because the
 * world moved, and this is what tells somebody a successor is needed.
 */
async function sourceHealth(ctx, { fileId, versionNo } = {}) {
  const file = await loadFile(ctx, fileId);
  const query = { companyId: ctx.companyId, fileId: file._id };
  const doc = versionNo
    ? await PreProductionMeeting.findOne({ ...query, versionNo: Number(versionNo) }).lean()
    : await PreProductionMeeting.findOne({ ...query, state: PPM_STATE.ISSUED }).lean();

  const { rows: now, at } = await captureSources(ctx, file);
  if (!doc) {
    return {
      comparedAt: at, versionNo: null,
      sources: now.map((s) => ({ ...sourceView(s), movement: "NOT_REVIEWED", reviewedState: null })),
      movedTopics: [], anyMoved: false,
    };
  }

  const before = new Map((doc.sourceReferences || []).map((s) => [str(s.key), s]));
  const sources = now.map((s) => {
    const was = before.get(str(s.key));
    if (!was) return { ...sourceView(s), movement: "NOT_REVIEWED", reviewedState: null };
    const same = (was.versionNo ?? null) === (s.versionNo ?? null)
      && (was.revisionNo ?? null) === (s.revisionNo ?? null)
      && str(was.state) === str(s.state)
      && str(was.availability) === str(s.availability);
    return {
      ...sourceView(s),
      movement: same ? "UNCHANGED" : "MOVED",
      reviewedState: {
        availability: str(was.availability), versionNo: was.versionNo ?? null,
        revisionNo: was.revisionNo ?? null, state: str(was.state),
      },
    };
  });
  const movedTopics = [...new Set(sources
    .filter((s) => s.movement === "MOVED")
    .map((s) => SOURCE[s.key]?.topic)
    .filter(Boolean))];

  return {
    comparedAt: at,
    versionNo: doc.versionNo,
    versionState: str(doc.state),
    sources,
    movedTopics,
    anyMoved: sources.some((s) => s.movement === "MOVED"),
  };
}

/* ═══ COMMANDS ═════════════════════════════════════════════════════════════ */

const audit = (file, doc, action, actor, details, { at, correlationId, reason = "" } = {}) => ({
  companyId: file.companyId,
  recordType: "PRE_PRODUCTION_MEETING",
  recordId: doc._id,
  recordRevision: doc.revision ?? 0,
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
 * START THE MINUTE BOOK.
 *
 * One at a time: a second draft alongside an open one would be two minute
 * books for one conversation. A cancelled version keeps its number, so the
 * next draft is the next version rather than a second version 1.
 */
async function createDraft(ctx, { fileId, body = {}, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);
  assertCommandShape(body);
  const who = identityOf(actor);

  return once(ctx, {
    scope: `ppm:draft:${String(file._id)}`,
    idempotencyKey,
    request: { fileId: String(file._id) },
  }, async (session) => {
    const open = await PreProductionMeeting.findOne({
      companyId: ctx.companyId, fileId: file._id, state: { $in: [...OPEN_STATES] },
    }).session(session).lean();
    if (open) {
      throw fail("PPM_STATE_CONFLICT",
        `Version ${open.versionNo} of this meeting is still ${str(open.state).toLowerCase()}. `
        + "Finish or cancel it before starting another.",
        { versionNo: open.versionNo, state: open.state });
    }
    const issued = await PreProductionMeeting.findOne({
      companyId: ctx.companyId, fileId: file._id, state: PPM_STATE.ISSUED,
    }).session(session).lean();
    if (issued) {
      throw fail("PPM_STATE_CONFLICT",
        `Version ${issued.versionNo} has been issued. A later meeting is a SUCCESSOR to it, `
        + "so that the earlier minutes stay readable.",
        { versionNo: issued.versionNo, useSuccessor: true });
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    const p = file.currentExecutionProjection || {};
    const ppmRef = await nextPpmRef();
    /* A cancelled meeting keeps its version number. It happened — somebody
       booked it and called it off — and reusing the number would make the
       history read as though it never existed. */
    const last = await PreProductionMeeting.findOne({
      companyId: ctx.companyId, fileId: file._id,
    }).sort({ versionNo: -1 }).select("versionNo").session(session).lean();
    const versionNo = Number(last?.versionNo ?? 0) + 1;

    const [doc] = await PreProductionMeeting.create([{
      companyId: ctx.companyId,
      fileId: file._id,
      fileNumber: str(file.fileNumber),
      handoverRef: str(file.handoverRef),
      handoverLineRef: str(file.handoverLineRef),
      orderRef: str(p.orderRef),
      orderLineRef: str(p.orderLineRef) || str(file.handoverLineRef),
      styleRef: str(p.styleRef),
      sampleStyleId: p.sampleStyleId || null,
      ppmRef,
      versionNo,
      state: PPM_STATE.DRAFT,
      plannedMeetingDate: dateOrNull(body?.plannedMeetingDate, "plannedMeetingDate"),
      createdBy: who,
      updatedBy: who,
    }], { session });

    await MerchandisingAuditEvent.create([audit(file, doc, "PPM_DRAFTED", who, {
      ppmRef: str(doc.ppmRef), versionNo,
    }, { at, correlationId })], { session, ordered: true });

    return {
      ppmId: String(doc._id), ppmRef: str(doc.ppmRef), versionNo,
      state: doc.state, revision: doc.revision,
    };
  });
}

/** Load the version a command is about, and refuse a frozen one by name. */
async function loadWritable(ctx, file, session) {
  const doc = await PreProductionMeeting.findOne({
    companyId: ctx.companyId, fileId: file._id, state: { $in: [...OPEN_STATES] },
  }).session(session);
  if (!doc) {
    const frozen = await PreProductionMeeting.findOne({
      companyId: ctx.companyId, fileId: file._id, state: { $in: [...FROZEN_STATES] },
    }).sort({ versionNo: -1 }).session(session).lean();
    if (frozen?.state === PPM_STATE.ISSUED) {
      throw fail("PPM_IMMUTABLE",
        `Version ${frozen.versionNo} has been issued. Issued minutes are permanent evidence and `
        + "take no edit — create a successor instead.",
        { versionNo: frozen.versionNo, state: frozen.state });
    }
    throw fail("PPM_NOT_FOUND", "There is no pre-production meeting in progress on this file.");
  }
  return doc;
}

async function updateDraft(ctx, { fileId, body = {}, actor = null } = {}) {
  const file = await loadFile(ctx, fileId);
  assertShape(body);

  return withTxn(async (session) => {
    const doc = await loadWritable(ctx, file, session);
    assertExpected(doc, body.expectedRevision);

    const at = new Date();
    const correlationId = crypto.randomUUID();

    if ("plannedMeetingDate" in body) doc.plannedMeetingDate = dateOrNull(body.plannedMeetingDate, "plannedMeetingDate");
    if ("actualMeetingAt" in body) doc.actualMeetingAt = dateOrNull(body.actualMeetingAt, "actualMeetingAt");
    if ("locationOrMode" in body) doc.locationOrMode = str(body.locationOrMode);
    if ("chairperson" in body) doc.chairperson = str(body.chairperson);
    if ("merchandisingRepresentative" in body) {
      doc.merchandisingRepresentative = str(body.merchandisingRepresentative);
    }
    const attendees = shapeAttendees(body.attendees);
    if (attendees !== undefined) doc.attendees = attendees;
    const absent_ = shapeDepartments(body.absentDepartments, "absentDepartments");
    if (absent_ !== undefined) doc.absentDepartments = absent_;
    const notes = shapeReviewNotes(body.reviewNotes, actor, at);
    if (notes !== undefined) {
      doc.reviewNotes = notes;
      /* ── A TOPIC IS RE-REVIEWED BY BEING OBSERVED AGAIN ───────────────
         A successor carries forward the topics whose source moved. Writing a
         fresh note under one is what clears it; nothing else does, and there
         is no control that dismisses the requirement without looking. */
      const seen = new Set(notes.map((n) => n.topic));
      doc.topicsRequiringReReview = (doc.topicsRequiringReReview || []).filter((t) => !seen.has(t));
    }
    const decisions = shapeDecisions(body.decisions, actor, at, doc.decisions);
    if (decisions !== undefined) doc.decisions = decisions;

    doc.revision += 1;
    doc.updatedBy = actor || undefined;
    await doc.save({ session });

    await MerchandisingAuditEvent.create([audit(file, doc, "PPM_UPDATED", actor, {
      ppmRef: str(doc.ppmRef), versionNo: doc.versionNo,
      attendeeCount: (doc.attendees || []).length,
      reviewNoteCount: (doc.reviewNotes || []).length,
      decisionCount: (doc.decisions || []).length,
    }, { at, correlationId })], { session, ordered: true });

    return { ppmId: String(doc._id), versionNo: doc.versionNo, state: doc.state, revision: doc.revision };
  });
}

/**
 * THE MEETING HAPPENED.
 *
 * This is where the source snapshot is taken: what was on the table is what
 * was on the table AT THE MEETING, not what it had become by the time somebody
 * got round to issuing the minutes.
 */
async function conduct(ctx, { fileId, body = {}, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);
  assertCommandShape(body);
  /* Fails closed. A meeting recorded as held by nobody in particular is not
     evidence that it was held. */
  const who = identityOf(actor);

  return once(ctx, {
    scope: `ppm:conduct:${String(file._id)}`,
    idempotencyKey,
    request: { expectedRevision: body?.expectedRevision },
    /* Read OUTSIDE the transaction: the snapshot calls several other
       applications, and holding a transaction open across them would make one
       slow department a Merchandising outage. */
    prepare: () => captureSources(ctx, file),
  }, async (session, captured) => {
    const doc = await loadWritable(ctx, file, session);
    assertExpected(doc, body?.expectedRevision);
    if (doc.state !== PPM_STATE.DRAFT) {
      throw fail("PPM_STATE_CONFLICT",
        `This meeting is already ${str(doc.state).toLowerCase()}.`, { state: doc.state });
    }
    if (!doc.actualMeetingAt) {
      throw fail("PPM_INCOMPLETE",
        "A meeting that happened has a date and time. Record when it was held.",
        { field: "actualMeetingAt" });
    }
    if (!str(doc.chairperson)) {
      throw fail("PPM_INCOMPLETE", "Record who chaired the meeting.", { field: "chairperson" });
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();

    doc.sourceReferences = captured.rows;
    doc.sourcesCapturedAt = captured.at;
    doc.sourcesContractVersion = captured.contractVersion;
    doc.state = PPM_STATE.CONDUCTED;
    doc.conductedAt = at;
    doc.conductedBy = who;
    doc.revision += 1;
    doc.updatedBy = who;
    await doc.save({ session });

    await MerchandisingAuditEvent.create([audit(file, doc, "PPM_CONDUCTED", who, {
      ppmRef: str(doc.ppmRef), versionNo: doc.versionNo,
      sourceCount: captured.rows.length,
      /* Recorded plainly: how much of what was reviewed was actually there. */
      sourcesPresent: captured.rows.filter((r) => r.availability === SOURCE_AVAILABILITY.PRESENT).length,
    }, { at, correlationId })], { session, ordered: true });

    return {
      ppmId: String(doc._id), versionNo: doc.versionNo,
      state: doc.state, revision: doc.revision,
      sourcesCapturedAt: captured.at,
    };
  });
}

/**
 * ISSUE THE MINUTES — AND, IF THIS IS A SUCCESSOR, RETIRE THE ONE IT FOLLOWS.
 *
 * ── WHY THE RETIREMENT IS HERE AND NOT AT THE DRAFT ─────────────────────────
 * Booking a follow-up meeting is not a decision about the last one. A draft
 * that retired its predecessor would leave the file with NO minutes in force
 * from the moment somebody opened it — through the write-up, through the
 * meeting itself, and permanently if the meeting were then called off, because
 * a superseded version takes no edit and there is no way back.
 *
 * So version 1 stands, untouched, until version 2 is actually issued. The two
 * facts then land in one transaction under one correlation id: there is no
 * instant at which the file has two current minutes or none.
 */
async function issue(ctx, { fileId, body = {}, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);
  assertCommandShape(body);
  const who = identityOf(actor);

  return once(ctx, {
    scope: `ppm:issue:${String(file._id)}`,
    idempotencyKey,
    request: { expectedRevision: body?.expectedRevision },
  }, async (session) => {
    const doc = await loadWritable(ctx, file, session);
    assertExpected(doc, body?.expectedRevision);

    if (doc.state !== PPM_STATE.CONDUCTED) {
      throw fail("PPM_STATE_CONFLICT",
        "Minutes are issued for a meeting that has been held. Conduct it first.",
        { state: doc.state });
    }

    /* ── MAKER/CHECKER, ON THE ONE THING THAT DOES NOT MOVE ─────────────
       The person who took the minutes does not certify them, and "the same
       person" is decided on the authenticated id — not an address they might
       have changed, and not a display name somebody else may share. */
    if (samePerson(who, doc.conductedBy)) {
      throw fail("PPM_SELF_ISSUE",
        "Minutes are issued by somebody other than the person who conducted the meeting.",
        { versionNo: doc.versionNo });
    }

    if (!(doc.attendees || []).length) {
      throw fail("PPM_INCOMPLETE",
        "Record who attended. A meeting with no attendee record is not evidence of a meeting.",
        { field: "attendees" });
    }
    if (!(doc.sourceReferences || []).length || !doc.sourcesCapturedAt) {
      throw fail("PPM_INCOMPLETE",
        "The reviewed-source snapshot is missing. Conduct the meeting again to take one.",
        { field: "sourceReferences" });
    }
    if ((doc.topicsRequiringReReview || []).length) {
      throw fail("PPM_REVIEW_REQUIRED",
        "A source behind "
        + `${doc.topicsRequiringReReview.join(", ")} moved since the previous minutes. `
        + "Record what was said about it before issuing.",
        { topics: doc.topicsRequiringReReview });
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    const conclusion = concludeFrom(doc.decisions);
    const rows = [];

    /* ── THE PREDECESSOR STEPS DOWN, FIRST AND ONLY NOW ─────────────────
       Ordered before the issue because the partial unique index allows one
       ISSUED version and is checked as each write lands. Both writes are in
       this transaction, so a failure anywhere below leaves version 1 exactly
       where it was. */
    if (Number.isInteger(doc.successorOfVersionNo)) {
      const prior = await PreProductionMeeting.findOne({
        companyId: ctx.companyId, fileId: file._id, state: PPM_STATE.ISSUED,
      }).session(session);
      if (prior) {
        if (prior.versionNo !== doc.successorOfVersionNo) {
          throw fail("PPM_STATE_CONFLICT",
            `These minutes follow version ${doc.successorOfVersionNo}, but version `
            + `${prior.versionNo} is the one in force. Start a successor to that one instead.`,
            { expected: doc.successorOfVersionNo, actual: prior.versionNo });
        }
        prior.state = PPM_STATE.SUPERSEDED;
        prior.supersededAt = at;
        prior.supersededByVersionNo = doc.versionNo;
        prior.revision += 1;
        /* The declaration the record's own guard demands. Nothing else in
           this application sets it. */
        prior.$locals.supersedingToVersionNo = doc.versionNo;
        await prior.save({ session });

        rows.push(audit(file, prior, "PPM_SUPERSEDED", who, {
          ppmRef: str(prior.ppmRef), versionNo: prior.versionNo,
          supersededByVersionNo: doc.versionNo,
        }, { at, correlationId }));
      }
    }

    doc.conclusion = conclusion;
    doc.state = PPM_STATE.ISSUED;
    doc.issuedAt = at;
    doc.issuedBy = who;
    doc.revision += 1;
    await doc.save({ session });

    rows.push(audit(file, doc, "PPM_ISSUED", who, {
      ppmRef: str(doc.ppmRef), versionNo: doc.versionNo, conclusion,
      openClarificationCount: unresolvedOf(doc.decisions).length,
      supersededVersionNo: Number.isInteger(doc.successorOfVersionNo)
        ? doc.successorOfVersionNo : null,
    }, { at, correlationId }));
    await MerchandisingAuditEvent.create(rows, { session, ordered: true });

    return {
      ppmId: String(doc._id), versionNo: doc.versionNo, state: doc.state,
      revision: doc.revision, conclusion,
      supersededVersionNo: rows.some((r) => r.action === "PPM_SUPERSEDED")
        ? doc.successorOfVersionNo : null,
    };
  });
}

/** Call off a meeting that has not been issued. The version number is kept. */
async function cancelDraft(ctx, { fileId, body = {}, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);
  assertCommandShape(body);
  const who = identityOf(actor);
  const reason = str(body?.reason);
  if (reason.length < 10) {
    throw fail("VALIDATION", "Say why the meeting was abandoned — a sentence.",
      { field: "reason", minimum: 10 });
  }

  return once(ctx, {
    scope: `ppm:cancel:${String(file._id)}`,
    idempotencyKey,
    request: { reason },
  }, async (session) => {
    const doc = await loadWritable(ctx, file, session);
    assertExpected(doc, body?.expectedRevision);

    const at = new Date();
    const correlationId = crypto.randomUUID();
    doc.state = PPM_STATE.CANCELLED;
    doc.cancelledAt = at;
    doc.cancelledBy = who;
    doc.cancellationReason = reason;
    doc.revision += 1;
    await doc.save({ session });

    await MerchandisingAuditEvent.create([audit(file, doc, "PPM_CANCELLED", who, {
      ppmRef: str(doc.ppmRef), versionNo: doc.versionNo,
      /* Said explicitly, because it is the reassuring half of the fact: a
         cancelled successor leaves the issued minutes exactly as they were. */
      successorOfVersionNo: doc.successorOfVersionNo ?? null,
    }, { at, correlationId, reason })], { session, ordered: true });

    return { ppmId: String(doc._id), versionNo: doc.versionNo, state: doc.state };
  });
}

/**
 * A LATER MEETING, AGAINST A NAMED PREDECESSOR.
 *
 * ── WHY IT DEMANDS THE VERSION IT THINKS IS IN FORCE ────────────────────────
 * This command is the beginning of a supersession, and the caller read the
 * current minutes some seconds ago on a screen. If somebody else has issued a
 * further version in between, the meeting being booked is a follow-up to a
 * document that is no longer current — and the right answer is to say so, not
 * to quietly attach it to whatever is there now.
 *
 * The expectation is part of the idempotency hash for the same reason: the
 * same key against a different predecessor is a different command wearing the
 * same name, and replaying the old answer to it would be a lie.
 *
 * It creates a DRAFT and nothing else. The predecessor is untouched until
 * that draft is issued.
 */
async function createSuccessor(ctx, { fileId, body = {}, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);
  assertCommandShape(body);
  const who = identityOf(actor);

  const expectedVersionNo = Number(body?.expectedIssuedVersionNo);
  const expectedRevision = Number(body?.expectedIssuedRevision);
  if (!Number.isInteger(expectedVersionNo) || !Number.isFinite(expectedRevision)) {
    throw fail("VALIDATION",
      "Say which issued version this meeting follows, and the revision you read it at.",
      { fields: ["expectedIssuedVersionNo", "expectedIssuedRevision"] });
  }

  return once(ctx, {
    scope: `ppm:successor:${String(file._id)}`,
    idempotencyKey,
    request: { fileId: String(file._id), expectedVersionNo, expectedRevision },
    prepare: () => sourceHealth(ctx, { fileId: String(file._id) }),
  }, async (session, health) => {
    const open = await PreProductionMeeting.findOne({
      companyId: ctx.companyId, fileId: file._id, state: { $in: [...OPEN_STATES] },
    }).session(session).lean();
    if (open) {
      throw fail("PPM_STATE_CONFLICT",
        `Version ${open.versionNo} is still ${str(open.state).toLowerCase()}.`,
        { versionNo: open.versionNo });
    }
    const prior = await PreProductionMeeting.findOne({
      companyId: ctx.companyId, fileId: file._id, state: PPM_STATE.ISSUED,
    }).session(session).lean();
    if (!prior) {
      throw fail("PPM_NOT_FOUND", "There are no issued minutes on this file to succeed.");
    }
    if (prior.versionNo !== expectedVersionNo || Number(prior.revision ?? 0) !== expectedRevision) {
      throw fail("PPM_STATE_CONFLICT",
        `The minutes in force are version ${prior.versionNo}, not the version you read. `
        + "Reload and start the successor again.",
        {
          expected: { versionNo: expectedVersionNo, revision: expectedRevision },
          actual: { versionNo: prior.versionNo, revision: prior.revision ?? 0 },
        });
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    const last = await PreProductionMeeting.findOne({
      companyId: ctx.companyId, fileId: file._id,
    }).sort({ versionNo: -1 }).select("versionNo").session(session).lean();
    const versionNo = Number(last?.versionNo ?? prior.versionNo) + 1;

    /* Context forward: who was there, and what is still open. A decision
       somebody already closed is not re-opened by a second meeting. */
    const carried = (prior.decisions || [])
      .filter((d) => UNRESOLVED_STATUSES.includes(str(d.status)))
      .map((d) => ({
        decisionRef: str(d.decisionRef), topic: d.topic, decision: str(d.decision),
        ownerDepartment: str(d.ownerDepartment), status: str(d.status),
        sourceKey: str(d.sourceKey), closureNote: str(d.closureNote),
        externalTaskRef: str(d.externalTaskRef),
        recordedBy: d.recordedBy, recordedAt: d.recordedAt,
        updatedBy: undefined, updatedAt: null,
      }));

    const [doc] = await PreProductionMeeting.create([{
      companyId: ctx.companyId,
      fileId: file._id,
      fileNumber: prior.fileNumber,
      handoverRef: prior.handoverRef,
      handoverLineRef: prior.handoverLineRef,
      orderRef: prior.orderRef,
      orderLineRef: prior.orderLineRef,
      styleRef: prior.styleRef,
      sampleStyleId: prior.sampleStyleId,
      ppmRef: prior.ppmRef,
      versionNo,
      state: PPM_STATE.DRAFT,
      successorOfVersionNo: prior.versionNo,
      plannedMeetingDate: dateOrNull(body?.plannedMeetingDate, "plannedMeetingDate"),
      locationOrMode: str(prior.locationOrMode),
      chairperson: "",
      merchandisingRepresentative: str(prior.merchandisingRepresentative),
      attendees: (prior.attendees || []).map((a) => ({
        name: str(a.name), department: str(a.department), role: str(a.role),
      })),
      decisions: carried,
      /* Empty: a successor's observations are a NEW meeting's observations.
         Copying the last meeting's notes forward would make it impossible to
         tell what the second meeting actually said. */
      reviewNotes: [],
      topicsRequiringReReview: health.movedTopics,
      createdBy: who,
      updatedBy: who,
    }], { session });

    const rows = [audit(file, doc, "PPM_DRAFTED", who, {
      ppmRef: str(doc.ppmRef), versionNo, successorOf: prior.versionNo,
      carriedDecisions: carried.length,
      topicsRequiringReReview: health.movedTopics,
    }, { at, correlationId })];
    if (health.movedTopics.length) {
      rows.push(audit(file, doc, "PPM_SOURCE_MOVED", who, {
        ppmRef: str(doc.ppmRef), versionNo,
        movedSources: health.sources.filter((s) => s.movement === "MOVED").map((s) => s.key),
        topics: health.movedTopics,
      }, { at, correlationId }));
    }
    await MerchandisingAuditEvent.create(rows, { session, ordered: true });

    return {
      ppmId: String(doc._id), ppmRef: str(doc.ppmRef), versionNo,
      state: doc.state, revision: doc.revision,
      successorOfVersionNo: prior.versionNo,
      topicsRequiringReReview: health.movedTopics,
    };
  });
}

/* ═══ THE PRINTABLE MINUTE ═════════════════════════════════════════════════ */

/**
 * The issued minutes, as a document.
 *
 * Identity, evidence and the two neutral sentences. No cost, no rate, no
 * supplier, no margin: none of those is on the record and none is fetched to
 * put here, because a minute that carried a price would be circulated to
 * everyone who attended the meeting.
 */
async function printable(ctx, { fileId, versionNo } = {}) {
  const file = await loadFile(ctx, fileId);
  const query = { companyId: ctx.companyId, fileId: file._id };
  const doc = versionNo
    ? await PreProductionMeeting.findOne({ ...query, versionNo: Number(versionNo) }).lean()
    : await PreProductionMeeting.findOne({
      ...query, state: { $in: [PPM_STATE.ISSUED, PPM_STATE.SUPERSEDED] },
    }).sort({ versionNo: -1 }).lean();

  if (!doc) throw fail("PPM_NOT_FOUND", "There are no issued minutes on this file.");
  if (![PPM_STATE.ISSUED, PPM_STATE.SUPERSEDED].includes(str(doc.state))) {
    throw fail("PPM_STATE_CONFLICT",
      "Minutes are printable once they are issued.", { state: doc.state });
  }

  const meeting = ppmView(doc);
  return {
    documentName: "Pre-Production Meeting Minutes",
    order: orderView(file),
    meeting,
    /* Said in the document itself, so a printed copy cannot be read as a
       clearance somebody forgot to qualify. */
    statement: meeting.conclusion === PPM_CONCLUSION.CONDUCTED_WITHOUT_OPEN_CLARIFICATIONS
      ? "This meeting was held and closed every clarification raised in it. "
        + "Whether this order may be planned or released is PPC's decision."
      : "This meeting was held and left clarifications open, listed below. "
        + "Whether this order may be planned or released is PPC's decision.",
    generatedAt: new Date(),
  };
}


module.exports = {
  DRAFT_FIELDS, REFUSED_FIELDS, DECISION_FIELDS, SOURCE, SOURCE_KEYS,
  SOURCES_CONTRACT_VERSION,
  assertShape, assertContext, assertExpected, once, withTxn,
  captureSources, concludeFrom, unresolvedOf, ppmView, orderView,
  getCurrent, listVersions, getVersion, sourceHealth,
  createDraft, updateDraft, conduct, issue, cancelDraft, createSuccessor, printable,
};
