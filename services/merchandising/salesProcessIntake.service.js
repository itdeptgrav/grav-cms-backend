"use strict";
// services/merchandising/salesProcessIntake.service.js
//
// WHAT SALES CONFIRMED, TURNED INTO WORK SOMEBODY REVIEWS — NOT WORK SOMEBODY
// INVENTS.
//
// A merchandiser opening a fresh order used to face an empty Development
// Requirements list and had to remember, from reading the handover, that the buyer
// had asked for embroidery. Nothing on the screen said so, nothing checked that
// the list matched what Sales confirmed, and the only record that the buyer
// required a wash sat three tabs away in an immutable Sales version. So the demo's
// six beautifully-worded requirement rows were a person's translation of a story —
// which is exactly the thing an order cannot depend on.
//
// This service reads the Sales statement and proposes. It does not create, it does
// not schedule, and it does not decide anything a department owns.
//
// ── THE MAPPING IS DETERMINISTIC, AND SO IS THE SILENCE ─────────────────────
//   EMBROIDERY + REQUIRED    → propose an Embroidery development requirement
//   PRINTING   + REQUIRED    → propose a Print development requirement
//   WASHING    + REQUIRED    → propose a Wash development requirement
//   anything   + NOT_REQUIRED→ a confirmed statement, shown, with NO work item
//   UNKNOWN or never stated  → an INFORMATION GAP, shown as one
//
// The last line is the one that matters most. "Sales has not said" and "Sales said
// no" are different facts, and collapsing them into "not required" is how an order
// ships without the embroidery the buyer assumed. Nothing here ever infers the
// second from the first.
//
// ── AND WHAT A PROPOSAL DELIBERATELY DOES NOT CARRY ─────────────────────────
// No responsible department, no required-by date, no status, no progress, no
// approved reference, no supplier, no cost, no consumption. Every one of those is
// somebody's decision or somebody's result; a proposal that filled them in would be
// this service quietly doing four other departments' jobs and signing their names.
// The merchandiser supplies the owner and the date at adoption, deliberately.

const crypto = require("crypto");
const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const {
  DevelopmentRevision, REVISION_FAMILY, REVISION_STATE, DEVELOPMENT_TYPE, SOURCE_APPLICATION,
} = require("../../models/CMS_Models/Merchandising/SelectionRevision");
const { fail } = require("../storePurchase/errors");
const selection = require("./selection.service");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

/* ── THE MAP, IN ONE PLACE ─────────────────────────────────────────────────
   Sales' vocabulary is EMBROIDERY / PRINTING / WASHING (lineProcessRequirement);
   a development requirement's is EMBROIDERY / PRINT / WASH. They are not the same
   words and never have been, which is precisely why the translation belongs in one
   named table rather than in whichever screen needs it. */
const PROCESS_MAP = Object.freeze({
  EMBROIDERY: { requirementType: DEVELOPMENT_TYPE.EMBROIDERY, work: "Embroidery development" },
  PRINTING: { requirementType: DEVELOPMENT_TYPE.PRINT, work: "Print development" },
  WASHING: { requirementType: DEVELOPMENT_TYPE.WASH, work: "Wash development" },
});

/** What a proposal is, from the order's point of view. */
const PROPOSAL_STANDING = Object.freeze({
  /* Sales requires it and no requirement row covers it — the merchandiser adopts. */
  PROPOSED: "PROPOSED",
  /* Sales requires it and a row already covers it. Nothing to do. */
  ALREADY_COVERED: "ALREADY_COVERED",
  /* Sales confirmed it is not required. Stated, never actionable. */
  CONFIRMED_NOT_REQUIRED: "CONFIRMED_NOT_REQUIRED",
  /* Sales has not answered. An information gap to take back to Sales. */
  NOT_STATED: "NOT_STATED",
});

/** What reconciliation found, per process. */
const RECONCILIATION = Object.freeze({
  COVERED: "COVERED",
  CONFIRMED_NOT_REQUIRED: "CONFIRMED_NOT_REQUIRED",
  REQUIRED_BUT_MISSING: "REQUIRED_BUT_MISSING",
  SALES_STATEMENT_CHANGED: "SALES_STATEMENT_CHANGED",
  CONFLICT_NOT_REQUIRED_BUT_WORK_EXISTS: "CONFLICT_NOT_REQUIRED_BUT_WORK_EXISTS",
  NOT_STATED: "NOT_STATED",
});

/** The sentence each finding reads as. Never a code on a screen. */
const RECONCILIATION_WORDS = Object.freeze({
  [RECONCILIATION.COVERED]: "Covered by a development requirement",
  [RECONCILIATION.CONFIRMED_NOT_REQUIRED]: "Sales confirmed this is not required",
  [RECONCILIATION.REQUIRED_BUT_MISSING]: "Required by Sales, and not in this list",
  [RECONCILIATION.SALES_STATEMENT_CHANGED]: "Sales changed this statement after the requirement was added",
  [RECONCILIATION.CONFLICT_NOT_REQUIRED_BUT_WORK_EXISTS]:
    "Sales says this is not required, but this list contains work for it",
  [RECONCILIATION.NOT_STATED]: "Sales has not stated this process",
});

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to Merchandising.");
}

/** The file, and the Sales version in force on it. */
async function load(ctx, fileId, session = null) {
  assertContext(ctx);
  if (!isId(fileId)) throw fail("NOT_FOUND", "Execution file not found.");
  const file = await ExecutionFile
    .findOne({ _id: fileId, companyId: ctx.companyId }).session(session);
  if (!file) throw fail("NOT_FOUND", "Execution file not found.");

  /* The version the file ACCEPTED, by its own recorded id — never "the current
     one for this line", which may be a version nobody has reviewed. */
  const version = file.currentHandoverVersionId
    ? await SalesHandoverVersion.findOne({
      _id: file.currentHandoverVersionId, companyId: ctx.companyId,
    }).session(session).lean()
    : null;
  return { file, version };
}

/** The open draft or the approved revision — whichever states the requirements now. */
async function requirementRevision(ctx, fileId, session = null) {
  const draft = await DevelopmentRevision.findOne({
    companyId: ctx.companyId, fileId, state: REVISION_STATE.DRAFT,
  }).sort({ revisionNo: -1 }).session(session).lean();
  if (draft) return draft;
  return DevelopmentRevision.findOne({
    companyId: ctx.companyId, fileId, state: REVISION_STATE.APPROVED,
  }).sort({ revisionNo: -1 }).session(session).lean();
}

/**
 * The rows of a revision that answer one Sales process.
 *
 * Matched on `requirementType`, which is the stored fact — never on a title
 * somebody typed. A row called "Embroidery sample" whose type is FIT_SAMPLE is a
 * fit sample, and treating it as embroidery coverage would tick a box the buyer's
 * embroidery has not actually been arranged behind.
 */
const rowsFor = (revision, requirementType) =>
  (revision?.rows || []).filter((r) => str(r.requirementType) === requirementType);

/** Everything Sales said about processes on this version, normalised. */
function statedProcesses(version) {
  const stated = version?.executionProjection?.processRequirements;
  const rows = Array.isArray(stated?.processes) ? stated.processes : [];
  const byProcess = new Map();
  for (const row of rows) {
    const process = str(row.process).toUpperCase();
    if (!PROCESS_MAP[process]) continue;     // OTHER carries no deterministic map
    byProcess.set(process, {
      process,
      requirement: str(row.requirement).toUpperCase(),
      buyerSpecification: str(row.buyerSpecification),
      evidence: row.evidence
        ? {
          kind: str(row.evidence.kind),
          buyerApprovalRef: str(row.evidence.buyerApprovalRef),
          poNumber: str(row.evidence.poNumber),
          approvedAt: row.evidence.approvedAt || null,
        }
        : null,
    });
  }
  return { statedAt: stated?.statedAt || null, byProcess };
}

/**
 * WHICH UNITS A PROPOSAL APPLIES TO.
 *
 * Only where Sales stated enough to know. A line with one split and one drop has
 * one unit and the answer is "all of it"; a line with four units and a buyer
 * statement that does not name any of them is genuinely unresolved, and the
 * merchandiser resolves it at adoption. Guessing "all units" there would silently
 * commit three units to embroidery nobody asked for.
 */
function applicabilityFor(file) {
  const units = (file.currentExecutionProjection?.breakdown || []).length;
  const drops = (file.currentExecutionProjection?.deliveries || []).length;
  if (units <= 1 && drops <= 1) {
    return { appliesToAllUnits: true, resolved: true, reason: "SINGLE_UNIT" };
  }
  return { appliesToAllUnits: false, resolved: false, reason: "MULTIPLE_UNITS" };
}

/**
 * THE SOURCE REFERENCE A PROPOSAL CARRIES.
 *
 * Built HERE, on the server, from the version the file itself accepted. It is
 * never taken from a request body — a client that could state its own lineage
 * could claim a requirement came from a buyer-approved Sales statement that never
 * mentioned it, which is the one claim in this whole flow that nobody downstream
 * would think to question.
 */
function sourceRefFor(version, process) {
  return {
    app: "sales",
    recordType: "handover_version",
    recordId: str(version._id),
    recordRef: `${str(version.handoverRef)}/${str(version.handoverLineRef)}#${process}`,
    sourceVersion: String(version.versionNo),
    sourceState: str(version.publication?.state) || "CURRENT",
  };
}

/* ═══ WHAT SALES IMPLIES ═══════════════════════════════════════════════════ */

/**
 * The suggestions for one file, and the confirmed statements and gaps beside them.
 *
 * Read-only. Reopening this screen a hundred times creates nothing.
 */
async function suggest(ctx, { fileId } = {}) {
  const { file, version } = await load(ctx, fileId);
  if (!version) {
    return {
      handover: null,
      suggestions: [],
      statements: [],
      gaps: [],
      note: "This file has no accepted Sales handover version, so there is nothing to read.",
    };
  }

  const revision = await requirementRevision(ctx, file._id);
  const { statedAt, byProcess } = statedProcesses(version);
  const applicability = applicabilityFor(file);

  const suggestions = [];
  const statements = [];
  const gaps = [];

  for (const [process, map] of Object.entries(PROCESS_MAP)) {
    const said = byProcess.get(process) || null;
    const covering = rowsFor(revision, map.requirementType);

    if (!said || said.requirement === "UNKNOWN" || !said.requirement) {
      /* An information gap — NOT "not required". The difference between these two
         is an order that ships without the embroidery the buyer assumed. */
      gaps.push({
        process,
        words: said ? "Sales answered “unknown”" : "Sales has not stated this process",
        requirementType: map.requirementType,
        askSales: true,
      });
      continue;
    }

    if (said.requirement === "NOT_REQUIRED") {
      statements.push({
        process,
        requirement: "NOT_REQUIRED",
        words: `Sales confirmed ${map.work.toLowerCase()} is not required`,
        buyerSpecification: said.buyerSpecification,
        evidence: said.evidence,
        /* Stated, and never an actionable row. A conflict — a row exists anyway —
           is reconciliation's business, not a suggestion's. */
        actionable: false,
      });
      continue;
    }

    /* REQUIRED. */
    if (covering.length) {
      statements.push({
        process,
        requirement: "REQUIRED",
        words: `${map.work} is already in this list`,
        coveredBy: covering.map((r) => ({ requirementRef: str(r.rowRef), title: str(r.title) })),
        actionable: false,
        standing: PROPOSAL_STANDING.ALREADY_COVERED,
      });
      continue;
    }

    suggestions.push({
      /* Stable for this file and process, so the same suggestion has the same name
         every time the screen is opened — which is what makes adoption idempotent
         without the browser having to remember anything. */
      suggestionRef: `SPS-${process}`,
      standing: PROPOSAL_STANDING.PROPOSED,
      process,
      requirementType: map.requirementType,
      /* A title a person would write, from the buyer's own words where there are
         any. Editable at adoption — it is a starting point, not a decision. */
      title: map.work,
      brief: said.buyerSpecification
        ? `Buyer requires ${process.toLowerCase()}: ${said.buyerSpecification}`
        : `Buyer requires ${process.toLowerCase()}. Sales stated no further specification.`,
      buyerSpecification: said.buyerSpecification,
      /* WHY this is here, and on whose authority. */
      salesAuthority: said.evidence,
      handoverVersionNo: version.versionNo,
      statedAt,
      applicability,
      /* ── WHAT THIS PROPOSAL REFUSES TO DECIDE ────────────────────────────
         Named explicitly so a screen can render the gaps as inputs rather than
         as blanks somebody might read as "none". */
      decidesNothingAbout: [
        "responsibleApplication", "requiredByDate", "approvedReferenceExpected",
        "status", "progress", "supplier", "cost", "consumption",
      ],
    });
  }

  return {
    handover: {
      handoverVersionId: str(version._id),
      versionNo: version.versionNo,
      statedAt,
      state: str(version.publication?.state),
    },
    revision: revision
      ? { revisionNo: revision.revisionNo, state: str(revision.state) }
      : null,
    suggestions,
    statements,
    gaps,
  };
}

/* ═══ RECONCILIATION ═══════════════════════════════════════════════════════ */

/**
 * The immutable Sales statement against the current requirement revision.
 *
 * Computed on the SERVER, from both records, because a claim like "Sales requires
 * embroidery and this order has none" decides whether a revision may be submitted.
 * A browser that computed it could be looking at a stale copy of either side, and
 * the answer would be a screen's opinion rather than the file's position.
 */
async function reconcile(ctx, { fileId } = {}) {
  const { file, version } = await load(ctx, fileId);
  const revision = await requirementRevision(ctx, file._id);

  if (!version) {
    return {
      findings: [], blocking: [], maySubmit: true,
      note: "No accepted Sales handover version, so there is nothing to reconcile against.",
    };
  }

  const { byProcess } = statedProcesses(version);
  const findings = [];

  for (const [process, map] of Object.entries(PROCESS_MAP)) {
    const said = byProcess.get(process) || null;
    const rows = rowsFor(revision, map.requirementType);
    const adopted = rows.filter((r) => str(r.sourceRef?.app) === "sales");

    /* ── A ROW BUILT ON A STATEMENT THAT HAS SINCE MOVED ──────────────────
       Checked before anything else: a row adopted from version 2 while the file
       now holds version 3 may be answering a question the buyer has changed. It
       is not automatically wrong — the statement may be identical — but it has to
       be LOOKED AT, and only a person can do that. */
    const stale = adopted.filter(
      (r) => String(r.sourceRef?.sourceVersion || "") !== String(version.versionNo),
    );
    if (stale.length) {
      findings.push({
        process,
        state: RECONCILIATION.SALES_STATEMENT_CHANGED,
        words: RECONCILIATION_WORDS[RECONCILIATION.SALES_STATEMENT_CHANGED],
        detail: `Added from handover version ${stale[0].sourceRef?.sourceVersion || "?"}; `
          + `version ${version.versionNo} is in force.`,
        requirementRefs: stale.map((r) => str(r.rowRef)),
        blocking: true,
      });
      continue;
    }

    if (!said || !said.requirement || said.requirement === "UNKNOWN") {
      findings.push({
        process,
        state: RECONCILIATION.NOT_STATED,
        words: RECONCILIATION_WORDS[RECONCILIATION.NOT_STATED],
        detail: rows.length
          ? "This list contains work for it, which is allowed — Sales simply has not stated it."
          : "Take it back to Sales if the buyer's intention matters to this order.",
        requirementRefs: rows.map((r) => str(r.rowRef)),
        /* NEVER blocking. An unstated process is a question for Sales, not a
           reason to stop Merchandising working. */
        blocking: false,
      });
      continue;
    }

    if (said.requirement === "NOT_REQUIRED") {
      if (rows.length) {
        const excepted = rows.every((r) => str(r.coordinationNote).length > 0);
        findings.push({
          process,
          state: RECONCILIATION.CONFLICT_NOT_REQUIRED_BUT_WORK_EXISTS,
          words: RECONCILIATION_WORDS[RECONCILIATION.CONFLICT_NOT_REQUIRED_BUT_WORK_EXISTS],
          detail: excepted
            ? "A note on every row records why it stands despite that."
            : "Either remove the work, or record on the row why it stands anyway.",
          requirementRefs: rows.map((r) => str(r.rowRef)),
          /* A justified exception is the merchandiser's to record, and a recorded
             one stops blocking. Without one the two records simply disagree. */
          blocking: !excepted,
        });
      } else {
        findings.push({
          process,
          state: RECONCILIATION.CONFIRMED_NOT_REQUIRED,
          words: RECONCILIATION_WORDS[RECONCILIATION.CONFIRMED_NOT_REQUIRED],
          detail: said.buyerSpecification || "",
          requirementRefs: [],
          blocking: false,
        });
      }
      continue;
    }

    /* REQUIRED. */
    if (!rows.length) {
      findings.push({
        process,
        state: RECONCILIATION.REQUIRED_BUT_MISSING,
        words: RECONCILIATION_WORDS[RECONCILIATION.REQUIRED_BUT_MISSING],
        detail: said.buyerSpecification
          ? `Buyer requirement: ${said.buyerSpecification}`
          : "Sales stated no further specification.",
        requirementRefs: [],
        blocking: true,
      });
    } else {
      findings.push({
        process,
        state: RECONCILIATION.COVERED,
        words: RECONCILIATION_WORDS[RECONCILIATION.COVERED],
        detail: "",
        requirementRefs: rows.map((r) => str(r.rowRef)),
        blocking: false,
      });
    }
  }

  const blocking = findings.filter((f) => f.blocking);
  return {
    handoverVersionNo: version.versionNo,
    revision: revision ? { revisionNo: revision.revisionNo, state: str(revision.state) } : null,
    findings,
    blocking,
    maySubmit: blocking.length === 0,
  };
}

/* ═══ ADOPTION ═════════════════════════════════════════════════════════════ */

const DECISION_FIELDS = Object.freeze([
  "suggestionRef", "responsibleApplication", "requiredByDate",
  "approvedReferenceExpected", "coordinationNote", "appliesToAllUnits", "unitRefs",
  "title", "brief",
]);

/**
 * A merchandiser's decision about one suggestion.
 *
 * The two required answers are the two this service refuses to invent. Everything
 * else has a defensible default; an owner and a date do not — a requirement with
 * nobody responsible and no date is a sentence in a list, and a list of those is
 * what the demo's six rows actually were.
 */
function readDecision(raw, allowed, covered) {
  for (const key of Object.keys(raw || {})) {
    if (!DECISION_FIELDS.includes(key)) {
      throw fail("VALIDATION", `"${key}" is not part of adopting a suggestion.`, { field: key });
    }
  }
  const ref = str(raw?.suggestionRef);
  const suggestion = allowed.get(ref);
  if (!suggestion) {
    /* ── ALREADY DONE IS NOT AN ERROR ──────────────────────────────────────
       A suggestion stops being offered the moment its process is covered, so a
       replayed call — the same key retried, or the ordinary double-click with a
       fresh one — names something that is no longer on the list. The caller's
       intention ("this order should have embroidery development") is already
       satisfied, and refusing it would turn a harmless retry into an error the
       operator has to interpret.

       A suggestion that is neither offered NOR covered is a different thing
       entirely — an invented one, for a process Sales did not require — and that
       is still refused. */
    if (covered.has(ref)) return { skip: { suggestionRef: ref, reason: "ALREADY_IN_DRAFT" } };
    throw fail("VALIDATION",
      "That suggestion is not one this order's Sales statement implies. Re-read the suggestions.",
      { field: "suggestionRef", value: ref });
  }

  const owner = str(raw?.responsibleApplication).toUpperCase();
  if (!owner) {
    throw fail("VALIDATION",
      `Say whose work ${suggestion.title.toLowerCase()} is. Nothing here guesses that — a `
      + "requirement with nobody responsible is a sentence in a list.",
      { field: "responsibleApplication", suggestionRef: ref });
  }
  if (!Object.values(SOURCE_APPLICATION).includes(owner)) {
    throw fail("VALIDATION", "That is not a department this company hands work to.",
      { field: "responsibleApplication", value: owner });
  }

  const due = str(raw?.requiredByDate);
  if (!due) {
    throw fail("VALIDATION",
      `Say when ${suggestion.title.toLowerCase()} is needed by. A date nobody set is a date `
      + "nobody is working to.",
      { field: "requiredByDate", suggestionRef: ref });
  }
  const dueDate = new Date(due);
  if (Number.isNaN(dueDate.getTime())) {
    throw fail("VALIDATION", "That is not a date.", { field: "requiredByDate", value: due });
  }

  return {
    suggestion,
    row: {
      requirementType: suggestion.requirementType,
      title: str(raw?.title) || suggestion.title,
      brief: str(raw?.brief) || suggestion.brief,
      requiredByDate: due,
      responsibleApplication: owner,
      approvedReferenceExpected: raw?.approvedReferenceExpected !== false,
      ...(str(raw?.coordinationNote) ? { coordinationNote: str(raw.coordinationNote) } : {}),
      ...(raw?.appliesToAllUnits === false
        ? { appliesToAllUnits: false, unitRefs: Array.isArray(raw?.unitRefs) ? raw.unitRefs : [] }
        : { appliesToAllUnits: true }),
    },
  };
}

/**
 * ADOPT the reviewed suggestions into a DRAFT.
 *
 * ── IT APPROVES NOTHING ─────────────────────────────────────────────────────
 * A draft is Merchandising still working. Submission and approval keep their own
 * maker/checker separation, untouched by this: adoption is the same act as typing
 * the rows by hand, with the lineage recorded and the buyer's words carried over.
 *
 * ── AND IT CANNOT BE MADE TO HAPPEN TWICE ───────────────────────────────────
 * Idempotent on two levels. The command ledger replays an identical call, and — the
 * one that actually matters, because a second click is usually a second key — a
 * suggestion whose process is ALREADY covered in the draft is skipped by name.
 * Reopening the screen and adopting again cannot produce two embroidery rows.
 */
async function adopt(ctx, { fileId, decisions = [], actor = null, idempotencyKey = "" } = {}) {
  assertContext(ctx);
  const rows = Array.isArray(decisions) ? decisions : [];
  if (!rows.length) {
    throw fail("VALIDATION", "Choose at least one suggestion to add.", { field: "decisions" });
  }

  /* Re-derived HERE, from the file's own accepted version. The client sends which
     suggestions and what it decided about them; it never sends what the suggestion
     was, and it never sends where it came from. */
  const offered = await suggest(ctx, { fileId });
  const allowed = new Map(offered.suggestions.map((s) => [s.suggestionRef, s]));
  /* Processes this order's Sales statement requires that are ALREADY covered —
     the shape a replay arrives in. Named the same way a suggestion is, so a
     retry of the same body resolves. */
  const covered = new Set(
    offered.statements
      .filter((s) => s.standing === PROPOSAL_STANDING.ALREADY_COVERED)
      .map((s) => `SPS-${s.process}`),
  );

  const read = rows.map((raw) => readDecision(raw, allowed, covered));
  const seen = new Set();
  for (const p of read) {
    const ref = p.skip ? p.skip.suggestionRef : p.suggestion.suggestionRef;
    if (seen.has(ref)) {
      throw fail("VALIDATION", "That suggestion is in this request twice.",
        { field: "decisions", suggestionRef: ref });
    }
    seen.add(ref);
  }
  const prepared = read.filter((p) => !p.skip);
  const alreadyThere = read.filter((p) => p.skip).map((p) => p.skip);

  const { version } = await load(ctx, fileId);
  const key = str(idempotencyKey) || crypto.randomUUID();

  /* The draft is created by the selection service if there is none — its own
     lifecycle, its own audit, its own maker/checker. Nothing here reimplements it. */
  const current = prepared.length
    ? await selection.getCurrent(ctx, { fileId, family: REVISION_FAMILY.DEVELOPMENT })
      .catch(() => null)
    : { working: { state: REVISION_STATE.DRAFT } };
  /* `working` is the open draft; `approved` is the frozen one. A file with an
     approved revision and no draft needs a new draft, which is what a revision IS. */
  if (!current?.working || str(current.working.state) !== REVISION_STATE.DRAFT) {
    await selection.createDraft(ctx, {
      fileId, family: REVISION_FAMILY.DEVELOPMENT, actor, idempotencyKey: `${key}-draft`,
    });
  }

  const added = [];
  const skipped = [...alreadyThere];
  for (const { suggestion, row } of prepared) {
    /* Re-read each time: adding one row moves the draft's revision, and the next
       row's own addition is checked against what the draft holds NOW. */
    const revision = await requirementRevision(ctx, fileId);
    if (rowsFor(revision, suggestion.requirementType).length) {
      /* Already there — from an earlier adoption, a retry, or somebody typing it.
         Skipped by NAME rather than refused, because the caller's intent ("this
         order should have embroidery development") is already satisfied. */
      skipped.push({
        suggestionRef: suggestion.suggestionRef,
        reason: "ALREADY_IN_DRAFT",
        requirementType: suggestion.requirementType,
      });
      continue;
    }

    const out = await selection.addRow(ctx, {
      fileId,
      family: REVISION_FAMILY.DEVELOPMENT,
      body: { ...row, expectedRevision: revision?.revision },
      actor,
      /* SERVER-ONLY. The route does not accept it and cannot pass it; this
         service has just read the version it names. */
      sourceRef: sourceRefFor(version, suggestion.process),
    });
    added.push({
      suggestionRef: suggestion.suggestionRef,
      requirementType: suggestion.requirementType,
      /* The row's permanent name, which the Development view calls a
         `requirementRef` and storage calls a `rowRef`. */
      requirementRef: str(out?.rowRef),
    });
  }

  return {
    added,
    skipped,
    revision: await requirementRevision(ctx, fileId).then((r) => (r
      ? { revisionNo: r.revisionNo, state: str(r.state) }
      : null)),
    /* Said out loud, because the whole point is that this is not an approval. */
    note: "Added to the draft. Nothing is approved: submit the revision for checking as usual.",
  };
}

module.exports = {
  PROCESS_MAP, PROPOSAL_STANDING, RECONCILIATION, RECONCILIATION_WORDS,
  statedProcesses, applicabilityFor, sourceRefFor,
  suggest, reconcile, adopt,
};
