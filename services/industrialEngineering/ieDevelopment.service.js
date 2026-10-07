// services/industrialEngineering/ieDevelopment.service.js
//
// IE DEVELOPMENT — THE PRE-ORDER REGISTER, AS A READ AND NOTHING ELSE.
//
// ── WHAT THIS ANSWERS ───────────────────────────────────────────────────────
// Industrial Engineering used to be reachable only through a confirmed order,
// which put the department that states the standard AFTER the sale that is
// priced against it. The engineering file itself was already openable from a
// style alone (`POST /styles/:styleId/engineering-file`); what was missing was
// the register that shows the work coming. This is that register.
//
// A row exists because a company-scoped SALES style/development case exists. IE
// does not wait for an order, and it does not wait for R&D to finish before it
// can see what is on its way — but before R&D has approved a technical revision
// the row is TRACKING ONLY, and says so. The existing file-creation gate in
// `ieStyleFile.service.approvedSourceOf` remains the authority on whether a
// file may be opened; this read reports that gate's answer, it does not hold a
// second copy of it.
//
// ── SO IT READS, AND IT COMPOSES ────────────────────────────────────────────
// There is no `IeDevelopmentFile` collection and this file creates none. Every
// figure below is composed from records somebody else already owns:
//
//   Sales          `SampleStyle.stage`, `materials.status`, `sample.status`
//   Merchandising  `merchandising_development_files` (lifecycle, released BOM)
//   R&D            `SampleStyle.techSheet.technical` + `technicalRevisions[]`
//   IE             `IeStyleFile` and its approved children
//
// No save, no update, no findOneAndUpdate, no backfill, and the router above it
// exposes no verb that could reach one. Opening a file is still a POST somebody
// has to make deliberately; READING this list opens nothing.
//
// ── THE MERCHANDISING LINEAGE IS UNPROVABLE TODAY, AND SAYS SO ──────────────
// The audit (docs/audits/sales-merchandising-rnd-ie-development-connection-audit
// .md §4) records the missing receiver contract: R&D's technical revision does
// not name the Merchandising development/BOM revision it consumed. That is not
// a gap in this file — `SampleStyle.techSheet.technicalRevisions[]` carries no
// such field at all, so the link cannot be proved from anything stored.
//
// Therefore `merchandising.lineage` is never `PROVEN`. A development file that
// names this style is published as `UNPROVEN` with the reason, and one that
// does not exist is `ABSENT`. It is deliberately NOT inferred from the product
// name, the buyer label or "the most recent development file", which are the
// three guesses that would each look right on the demo and be wrong in
// production.
//
// ── AND WHAT IE MAY BE TOLD ─────────────────────────────────────────────────
// Every shape is built field by field, as everywhere else in this department. A
// spread of a `SampleStyle` publishes the Journey, the enquiry and the buyer;
// a spread of a development file publishes Sales' required-by date and the
// buyer's display label. Neither is spread. No price, quotation, margin,
// supplier, rate, stock, named operator, physical machine or barcode payload
// appears on a row — see the audit's §5.3 exclusion list.
"use strict";

const mongoose = require("mongoose");

const { fail } = require("../storePurchase/errors");
const technicalRecord = require("../centralCosting/technicalRecord.service");
const { ownershipProofFor } = require("../centralCosting/technicalSource.service");
/* The ONE style-ownership clause this CMS has. See ieRead.service.js for why a
   second one is how a company's styles appear in another company's queue. */
const { styleOwnershipClause } = require("../companyContext/merchandisingScope.service");
/* Reused, never reimplemented: which technical revision a file is engineered
   from today, and which rebased rows nobody has confirmed. A second answer to
   either would be a second answer to "is this standard current". */
const ieStyleFile = require("./ieStyleFile.service");
const { roleAtLeast } = require("../departmentRoles");
/* ── THE GARMENT, AND WHAT WAS WRITTEN DOWN ABOUT IT ───────────────────────
   A narrowly additive, READ-ONLY projection over records this boundary already
   reads: the references Sales attached, the artwork, R&D's sample photographs
   and the technical document each frozen revision carries. It adds no model, no
   write route and no copy of a document, and its allowlist is its own code. */
const evidence = require("./ieDevelopmentEvidence");
/* The manufacturing facts IE engineers from — its own read-only projection,
   built the same way the evidence one is: its own module, its own fields. */
const manufacturing = require("./ieDevelopmentManufacturing");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));
/* Absent is `null`, never 0. `Number(null)` is 0 and `Number("")` is 0, and a
   release numbered zero beside "no release" is how a screen comes to print a
   figure for a record that does not exist. */
const num = (v) => (v === null || v === undefined || v === ""
  ? null
  : (Number.isFinite(Number(v)) ? Number(v) : null));

const model = (name, path) => (mongoose.models[name] || require(path));
const SampleStyle = () => model("SampleStyle", "../../models/CMS_Models/Sales/SampleStyle");
/* Merchandising exports its three collections as NAMED properties of one
   module, so this one is not reached through `model()`. */
const DevelopmentFile = () => (mongoose.models.DevelopmentFile
  || require("../../models/CMS_Models/Merchandising/Development").DevelopmentFile);
const IeStyleFile = () => model("IeStyleFile", "../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const IeBulletinVersion = () => model("IeBulletinVersion", "../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");
const IeLineLayout = () => model("IeLineLayout", "../../models/CMS_Models/IndustrialEngineering/IeLineLayout");
const IeCapacityStandard = () => model("IeCapacityStandard", "../../models/CMS_Models/IndustrialEngineering/IeCapacityStandard");
const IeRelease = () => model("IeRelease", "../../models/CMS_Models/IndustrialEngineering/IeRelease");
const IeOperation = () => model("IeOperation", "../../models/CMS_Models/IndustrialEngineering/IeOperation");

const CODES = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "VALIDATION",
  COMPANY_CONTEXT_UNAVAILABLE: "COMPANY_CONTEXT_UNAVAILABLE",
});

/* ── VIEWS ARE PROJECTIONS, NOT A STATUS FIELD ─────────────────────────────
 * Nothing stored says "this style is awaiting review". It is derived, every
 * time, from source and lifecycle facts — which is why adding a mutable
 * `developmentStatus` to `IeStyleFile` was refused: two writers and one truth.
 *
 * A row carries EXACTLY ONE classification, so the counts sum to the `all`
 * count and a person moving between tabs never sees one row twice. The
 * precedence below is the order of the checks in `classify`, and the reason
 * `NEEDS_ATTENTION` outranks `RELEASED` is that a released standard built on a
 * superseded technical revision is the single most expensive thing on this
 * screen to leave unnoticed. */
const CLASSIFICATION = Object.freeze({
  UPSTREAM: "UPSTREAM",
  READY_FOR_IE: "READY_FOR_IE",
  NEEDS_ATTENTION: "NEEDS_ATTENTION",
  AWAITING_REVIEW: "AWAITING_REVIEW",
  RELEASED: "RELEASED",
  APPROVED_STANDARD: "APPROVED_STANDARD",
  IN_ENGINEERING: "IN_ENGINEERING",
});

/** The view keys a caller may ask for. `all` is every classification. */
const VIEW = Object.freeze({
  UPSTREAM: "upstream",
  READY: "ready",
  IN_ENGINEERING: "in-engineering",
  AWAITING_REVIEW: "awaiting-review",
  NEEDS_ATTENTION: "needs-attention",
  APPROVED: "approved",
  RELEASED: "released",
  ALL: "all",
});

const VIEW_CLASSIFICATION = Object.freeze({
  [VIEW.UPSTREAM]: CLASSIFICATION.UPSTREAM,
  [VIEW.READY]: CLASSIFICATION.READY_FOR_IE,
  [VIEW.IN_ENGINEERING]: CLASSIFICATION.IN_ENGINEERING,
  [VIEW.AWAITING_REVIEW]: CLASSIFICATION.AWAITING_REVIEW,
  [VIEW.NEEDS_ATTENTION]: CLASSIFICATION.NEEDS_ATTENTION,
  [VIEW.APPROVED]: CLASSIFICATION.APPROVED_STANDARD,
  [VIEW.RELEASED]: CLASSIFICATION.RELEASED,
});

const VIEWS = Object.freeze(Object.values(VIEW));

/** Which desk can move a row forward. Named, because "blocked" tells nobody. */
const OWNER = Object.freeze({
  SALES: "SALES",
  MERCHANDISING: "MERCHANDISING",
  RND: "RESEARCH_DEVELOPMENT",
  IE: "INDUSTRIAL_ENGINEERING",
  NOBODY: "NOBODY",
});

/** The one thing that moves this row. A code; the screen owns the sentence. */
const NEXT_ACTION = Object.freeze({
  SEND_STYLE_TO_MERCHANDISING: "SEND_STYLE_TO_MERCHANDISING",
  COMPLETE_MATERIAL_SELECTION: "COMPLETE_MATERIAL_SELECTION",
  RELEASE_SELECTION_TO_RND: "RELEASE_SELECTION_TO_RND",
  APPROVE_TECHNICAL_RECORD: "APPROVE_TECHNICAL_RECORD",
  RECONCILE_DUPLICATE_APPROVED_REVISION: "RECONCILE_DUPLICATE_APPROVED_REVISION",
  OPEN_ENGINEERING_FILE: "OPEN_ENGINEERING_FILE",
  MAP_SOURCE_ROUTE_TO_LIBRARY: "MAP_SOURCE_ROUTE_TO_LIBRARY",
  COMPLETE_BULLETIN: "COMPLETE_BULLETIN",
  SUBMIT_BULLETIN_FOR_REVIEW: "SUBMIT_BULLETIN_FOR_REVIEW",
  DECIDE_BULLETIN_REVIEW: "DECIDE_BULLETIN_REVIEW",
  REWORK_RETURNED_BULLETIN: "REWORK_RETURNED_BULLETIN",
  REBASE_ONTO_NEW_TECHNICAL_VERSION: "REBASE_ONTO_NEW_TECHNICAL_VERSION",
  REVIEW_REBASED_ROWS: "REVIEW_REBASED_ROWS",
  REPLACE_RETIRED_OPERATION: "REPLACE_RETIRED_OPERATION",
  BUILD_LINE_LAYOUT: "BUILD_LINE_LAYOUT",
  APPROVE_LINE_LAYOUT: "APPROVE_LINE_LAYOUT",
  RECORD_CAPACITY_STANDARD: "RECORD_CAPACITY_STANDARD",
  APPROVE_CAPACITY_STANDARD: "APPROVE_CAPACITY_STANDARD",
  ISSUE_ENGINEERING_RELEASE: "ISSUE_ENGINEERING_RELEASE",
  NOTHING_OUTSTANDING: "NOTHING_OUTSTANDING",
});

/**
 * How well the Merchandising lineage is known.
 *
 * `PROVEN` is declared and deliberately never returned — see the header. It is
 * in the vocabulary so the day IE-D0 lands, the frontend that already renders
 * three states does not need a fourth added to it.
 */
const LINEAGE = Object.freeze({
  PROVEN: "PROVEN",
  UNPROVEN: "UNPROVEN",
  ABSENT: "ABSENT",
});

/** Why a file may not be opened from this row. Never a bare `false`. */
const OPEN_BLOCKED = Object.freeze({
  ALREADY_OPEN: "ALREADY_OPEN",
  SOURCE_VERSION_REQUIRED: "SOURCE_VERSION_REQUIRED",
  SOURCE_VERSION_AMBIGUOUS: "SOURCE_VERSION_AMBIGUOUS",
  ROLE_REQUIRED: "ROLE_REQUIRED",
});

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/* ── THE SCAN IS BOUNDED, AND THE BOUND IS PUBLISHED ───────────────────────
 * A view is a projection, so it cannot be a database filter: whether a style
 * is "awaiting review" is only known after its IE file and that file's
 * children have been read. So one bounded pass classifies the company's live
 * style population, and the view and the counts are both taken from it.
 *
 * That pass is SIX queries whatever the page size — the styles, then one `$in`
 * per child collection — and never one query per row. What it is not is
 * unbounded: past the cap the register says it stopped counting rather than
 * quietly reporting a subtotal as a total. */
const SCAN_CAP = 500;

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail(CODES.COMPANY_CONTEXT_UNAVAILABLE, "Your company could not be resolved.");
  }
}

/** One indistinguishable refusal for absent, foreign and unprovable alike. */
const styleNotFound = () => fail(CODES.NOT_FOUND, "That development style was not found.");

/* ═══ PAGING ═══════════════════════════════════════════════════════════════
 *
 * The cursor is a POSITION in this list's deterministic sort — the same
 * `(updatedAt, _id)` pair `ieRead.listStyles` pages by, and encoded by that
 * module's own helpers so the two lists cannot drift into two cursor formats.
 * Applied AFTER classification, because the sort is over styles and the view
 * is a filter over the classified rows. */

function pageSize(limit) {
  const asked = limit === undefined || limit === null || limit === "" ? DEFAULT_LIMIT : Number(limit);
  if (!Number.isFinite(asked) || asked < 1 || Math.floor(asked) !== asked) {
    throw fail(CODES.VALIDATION, "Ask for a whole number of rows.", { field: "limit" });
  }
  return Math.min(asked, MAX_LIMIT);
}

function readView(value) {
  const asked = str(value);
  if (!asked) return VIEW.READY;
  if (!VIEWS.includes(asked)) {
    throw fail(CODES.VALIDATION, "That is not a view this register has.",
      { field: "view", allowed: VIEWS });
  }
  return asked;
}

/* ═══ SOURCES, PROJECTED FIELD BY FIELD ════════════════════════════════════ */

/** Only what a register row and its detail need. Never the Journey or buyer. */
const STYLE_PROJECTION = [
  "_id", "sampleStyleId", "styleCode", "productName", "variantLabel", "variantKey",
  "stage", "status", "updatedAt",
  /* ── THE PARENTS PROVE THE COMPANY AND THEN STOP ───────────────────────────
     `readDevelopment` opens ONE style, so it proves ownership row-wise through
     `ownershipProofFor`, which reads these two references and `isActive`. They
     are selected, used, and never published: every field that leaves this
     module is written out by hand and neither reference is among them. */
  "journeyId", "enquiryId", "isActive",
  "materials.status", "sample.status",
  "techSheet.technical.status", "techSheet.technical.revision",
  "techSheet.technicalRevisions.revision", "techSheet.technicalRevisions.outcome",
  "techSheet.technicalRevisions.submittedAt", "techSheet.technicalRevisions.decidedAt",
  /* ── AND THE ONE PICTURE A REGISTER ROW MAY SHOW ─────────────────────────
     Read from the style's own document, which this list already has. A
     thumbnail may not cost a query per row: a register that issued one would be
     slower for a picture than for everything else on the page put together. */
  evidence.EVIDENCE_LIST_PROJECTION,
].join(" ");

/** Everything the ONE-STYLE read additionally needs for its evidence. */
const STYLE_DETAIL_PROJECTION = [
  STYLE_PROJECTION,
  evidence.EVIDENCE_DETAIL_PROJECTION,
  manufacturing.MANUFACTURING_DETAIL_PROJECTION,
].join(" ");

/** Merchandising's file, as evidence — no BOM rows, no buyer, no required-by. */
const DEVELOPMENT_PROJECTION = [
  "_id", "developmentNumber", "sampleStyleId", "lifecycleStatus", "lifecycleReason",
  "currentBomRevisionNo", "releasedBomRevisionNo", "releasedToRndAt", "releaseReference",
  "updatedAt",
].join(" ");

/**
 * SALES' POSITION ON THE SHARED STYLE.
 *
 * `stage` is the kanban column Sales moves ("brief" → "materials" → "rnd") and
 * `materials.status` is how far the selection on that shared record has got.
 * Both are read; neither is written, and IE has no control that could move them.
 */
function salesPositionOf(style) {
  return {
    stage: str(style.stage) || "brief",
    materialsStatus: str(style.materials?.status) || "pending",
    /* R&D's physical sample, which is a different gate from the technical
       record and is shown beside it rather than folded into it. */
    sampleStatus: str(style.sample?.status) || "not_started",
  };
}

/**
 * R&D'S TECHNICAL POSITION, AND THE EXACT REVISION IE WOULD WORK FROM.
 *
 * `approvedRevisionOf` is Central Costing's rule, reused: the HIGHEST approved
 * revision number, not the last element of the array. `ambiguous` is the case
 * `approvedSourceOf` refuses a file for — two frozen revisions carrying one
 * number — reported here so the register can say why the row cannot be opened
 * instead of offering a control that fails.
 */
function technicalPositionOf(style) {
  const techSheet = style.techSheet || {};
  const status = str(techSheet.technical?.status) || technicalRecord.STATUS.NOT_STARTED;
  const revisions = Array.isArray(techSheet.technicalRevisions) ? techSheet.technicalRevisions : [];
  const approvedRows = revisions.filter((r) => r.outcome === "approved");
  const top = technicalRecord.approvedRevisionOf(techSheet);
  const tied = top ? approvedRows.filter((r) => Number(r.revision) === Number(top.revision)) : [];
  return {
    status,
    approved: Boolean(top) && tied.length === 1,
    ambiguous: Boolean(top) && tied.length > 1,
    revision: top ? num(top.revision) : null,
    approvedAt: top?.decidedAt || null,
    submittedAt: top?.submittedAt || null,
    revisionCount: revisions.length,
  };
}

/**
 * MERCHANDISING'S POSITION — AND WHY IT CAN ONLY EVER BE `UNPROVEN`.
 *
 * The file is matched on `sampleStyleId`, which is a stored reference and not
 * a guess. What is unproven is not WHICH file this is; it is that the approved
 * R&D technical revision was actually engineered from that file's released BOM
 * revision, because nothing on the revision records which BOM it consumed.
 *
 * So the identity is published and the CONSUMPTION is not asserted.
 */
function merchandisingPositionOf(file) {
  if (!file) {
    return {
      lineage: LINEAGE.ABSENT,
      developmentNumber: "",
      lifecycleStatus: "",
      bomRevisionNo: null,
      releasedBomRevisionNo: null,
      releasedAt: null,
      releaseReference: "",
    };
  }
  return {
    lineage: LINEAGE.UNPROVEN,
    developmentNumber: str(file.developmentNumber),
    lifecycleStatus: str(file.lifecycleStatus),
    bomRevisionNo: num(file.currentBomRevisionNo),
    releasedBomRevisionNo: num(file.releasedBomRevisionNo),
    releasedAt: file.releasedToRndAt || null,
    releaseReference: str(file.releaseReference),
  };
}

/**
 * IE'S OWN POSITION — the file, its bulletin, and its approved children.
 *
 * Every state is `NONE` where the record does not exist, which is a different
 * fact from `DRAFT` and is never rendered as one. The bulletin's review state
 * is read from the FILE (`bulletinReviewVersionNo` / `currentApprovedVersionNo`
 * are the freeze, see IeStyleFile) with the version collection consulted only
 * for a RETURNED decision, which the file does not record.
 */
function engineeringPositionOf(file, children) {
  if (!file) {
    return {
      fileId: null,
      fileRevision: null,
      sourceTechnicalRevision: null,
      sourceCycleNo: null,
      bulletinRowCount: null,
      bulletinState: "NONE",
      approvedVersionNo: null,
      reviewVersionNo: null,
      layoutState: "NONE",
      capacityState: "NONE",
      releaseState: "NONE",
      releaseNo: null,
      samMinutes: null,
      rowsMissingSam: null,
      samComplete: false,
    };
  }
  const inForce = ieStyleFile.currentSourceOf(file);
  const rows = Array.isArray(file.bulletin?.rows) ? file.bulletin.rows : [];
  const totals = ieStyleFile.samTotals(rows.map((r) => ({ proposedSamMinutes: r.proposedSamMinutes })));

  const reviewNo = num(file.bulletinReviewVersionNo);
  const approvedNo = num(file.currentApprovedVersionNo);
  const bulletinState = reviewNo ? "IN_REVIEW"
    : approvedNo ? "APPROVED"
      : children.returned ? "RETURNED"
        : rows.length ? "DRAFT" : "NONE";

  return {
    fileId: str(file._id),
    fileRevision: num(file.revision),
    sourceTechnicalRevision: num(inForce.technicalRevision),
    sourceCycleNo: num(inForce.cycleNo),
    bulletinRowCount: rows.length,
    bulletinState,
    approvedVersionNo: approvedNo,
    reviewVersionNo: reviewNo,
    layoutState: children.layout || "NONE",
    capacityState: children.capacity || "NONE",
    releaseState: children.releaseState || "NONE",
    releaseNo: num(children.releaseVersionNo),
    samMinutes: totals.totalProposedSamMinutes,
    rowsMissingSam: totals.rowsMissingProposedSam,
    samComplete: totals.samComplete,
  };
}

/* ═══ GAPS ═════════════════════════════════════════════════════════════════
 *
 * A gap is a NAMED thing somebody owes, with the desk that owes it. The codes
 * and the owner vocabulary are `ieStyleFile.GAP` / `GAP_OWNER` where one
 * already exists, so the register and the workspace call the same condition by
 * the same name rather than by two.
 *
 * What the register does NOT do is re-derive the workspace's per-row readiness.
 * `readinessFor` reads the operation library once per file; doing that for
 * every row of a page is the N+1 this boundary exists to avoid. The register
 * carries the gaps a bounded batch can prove, and the workspace carries the
 * authoritative, complete set for the one file that is open. */

const gap = (code, owner, action, message, details = null) => ({
  code, owner, action, message, ...(details ? { details } : {}),
});

/**
 * WHERE THIS ROW STANDS, FROM THE FACTS AND NOTHING ELSE.
 *
 * Pure: it takes the four positions and returns the classification, the desk
 * that owes the next move, that move, the gaps and whether a file may be
 * opened. No database, no clock, no request. Which is what makes the register's
 * whole vocabulary testable without a Mongo instance — see
 * test/industrial-engineering/ie-development.route.test.js.
 *
 * @param {object} input.sales
 * @param {object} input.technical
 * @param {object} input.merchandising
 * @param {object} input.engineering
 * @param {object|null} input.rebase        outstanding rebase review, or null
 * @param {string[]} input.retiredOperations  codes this bulletin still uses
 * @param {number|null} input.currentApprovedRevision  R&D's revision NOW
 * @param {boolean} input.mayWrite          the actor holds an IE editor seat
 */
function classify({
  sales, technical, merchandising, engineering,
  rebase = null, retiredOperations = [], currentApprovedRevision = null, mayWrite = false,
} = {}) {
  const gaps = [];

  /* ── UPSTREAM: R&D HAS NOT APPROVED ANYTHING TO ENGINEER FROM ───────────
     Visible on purpose. IE seeing the work coming is the whole reason the
     register starts at the Sales style rather than at the IE file — but it is
     CONTEXT, and `trackingOnly` is what stops a screen offering IE's controls
     against an unfinished source. */
  if (!technical.approved) {
    if (technical.ambiguous) {
      gaps.push(gap("TECHNICAL_REVISION_AMBIGUOUS", OWNER.RND,
        NEXT_ACTION.RECONCILE_DUPLICATE_APPROVED_REVISION,
        `Technical revision ${technical.revision} is recorded as approved more than once, so nothing `
        + "stored says which one an engineering file would be built from.",
        { technicalRevision: technical.revision }));
    } else {
      gaps.push(gap("TECHNICAL_RECORD_NOT_APPROVED", OWNER.RND, NEXT_ACTION.APPROVE_TECHNICAL_RECORD,
        "R&D has not approved a technical revision for this style, so there is no signed-off source "
        + "for Industrial Engineering to work from.",
        { technicalStatus: technical.status }));
    }
    if (merchandising.lineage === LINEAGE.ABSENT) {
      gaps.push(gap("MERCHANDISING_DEVELOPMENT_ABSENT", OWNER.MERCHANDISING,
        NEXT_ACTION.COMPLETE_MATERIAL_SELECTION,
        "No Merchandising development file names this style, so the material identity this style "
        + "will be engineered against is not recorded anywhere."));
    }

    /* Whose move it is upstream, read off the two positions Sales and
       Merchandising actually own — in the order the work happens. */
    const owner = technical.ambiguous ? OWNER.RND
      : sales.stage === "brief" ? OWNER.SALES
        : merchandising.lineage === LINEAGE.ABSENT ? OWNER.MERCHANDISING
          : merchandising.lifecycleStatus && merchandising.lifecycleStatus !== "RELEASED_TO_RND"
            ? OWNER.MERCHANDISING
            : OWNER.RND;
    /* ── A STOPPED DEVELOPMENT FILE IS NOT ONE SOMEBODY IS WORKING ON ─────
       CLOSED, CANCELLED and ON_HOLD are Merchandising's own words for "not in
       progress". Reading them as "selection in progress" would put a row on
       IE's register with a next action nobody is going to take, and it is the
       sort of wrong answer that looks right on a demo where every file is
       ACTIVE. There is nothing outstanding to name, so nothing is named. */
    const halted = ["CLOSED", "CANCELLED", "ON_HOLD"].includes(merchandising.lifecycleStatus);
    const nextAction = technical.ambiguous ? NEXT_ACTION.RECONCILE_DUPLICATE_APPROVED_REVISION
      : owner === OWNER.SALES ? NEXT_ACTION.SEND_STYLE_TO_MERCHANDISING
        : owner === OWNER.MERCHANDISING
          ? (halted ? NEXT_ACTION.NOTHING_OUTSTANDING
            : merchandising.lifecycleStatus === "APPROVED"
              ? NEXT_ACTION.RELEASE_SELECTION_TO_RND
              : NEXT_ACTION.COMPLETE_MATERIAL_SELECTION)
          : NEXT_ACTION.APPROVE_TECHNICAL_RECORD;
    if (halted) {
      gaps.push(gap("MERCHANDISING_DEVELOPMENT_HALTED", OWNER.MERCHANDISING,
        NEXT_ACTION.NOTHING_OUTSTANDING,
        `Development ${merchandising.developmentNumber || "file"} is ${merchandising.lifecycleStatus} `
        + "in Merchandising, so no material selection is in progress for this style.",
        { lifecycleStatus: merchandising.lifecycleStatus }));
    }

    return {
      classification: CLASSIFICATION.UPSTREAM,
      trackingOnly: true,
      owner,
      nextAction,
      gaps,
      canOpenEngineeringFile: false,
      openBlockedReason: technical.ambiguous
        ? OPEN_BLOCKED.SOURCE_VERSION_AMBIGUOUS
        : OPEN_BLOCKED.SOURCE_VERSION_REQUIRED,
    };
  }

  /* From here the source is approved and unambiguous, which is exactly the
     condition `approvedSourceOf` opens a file on. */
  if (merchandising.lineage === LINEAGE.UNPROVEN) {
    gaps.push(gap("MERCHANDISING_LINEAGE_UNPROVEN", OWNER.RND, NEXT_ACTION.NOTHING_OUTSTANDING,
      `Development ${merchandising.developmentNumber || "file"} names this style, but the approved `
      + "technical revision does not record which released BOM revision it was drawn from. The "
      + "material lineage is therefore not proved.",
      { developmentNumber: merchandising.developmentNumber || null,
        releasedBomRevisionNo: merchandising.releasedBomRevisionNo }));
  } else {
    gaps.push(gap("MERCHANDISING_DEVELOPMENT_ABSENT", OWNER.MERCHANDISING,
      NEXT_ACTION.NOTHING_OUTSTANDING,
      "No Merchandising development file names this style, so this engineering work has no recorded "
      + "material lineage at all."));
  }

  /* ── READY FOR IE: NOBODY HAS OPENED THE FILE ───────────────────────────
     The only row on the register where IE's own first action is a WRITE, and
     the only one that publishes `canOpenEngineeringFile: true`. */
  if (!engineering.fileId) {
    return {
      classification: CLASSIFICATION.READY_FOR_IE,
      trackingOnly: false,
      owner: OWNER.IE,
      nextAction: NEXT_ACTION.OPEN_ENGINEERING_FILE,
      gaps: [gap("ENGINEERING_FILE_NOT_OPENED", OWNER.IE, NEXT_ACTION.OPEN_ENGINEERING_FILE,
        `R&D approved technical revision ${technical.revision}. No engineering file has been opened `
        + "against it yet.", { technicalRevision: technical.revision }), ...gaps],
      canOpenEngineeringFile: mayWrite,
      openBlockedReason: mayWrite ? null : OPEN_BLOCKED.ROLE_REQUIRED,
    };
  }

  /* A file exists, so it cannot be opened again — the control is replaced by
     the link to it, and the reason is published rather than left as a bare
     false a screen has to interpret. */
  const opened = { canOpenEngineeringFile: false, openBlockedReason: OPEN_BLOCKED.ALREADY_OPEN };

  /* ── NEEDS ATTENTION, AND IT OUTRANKS EVERYTHING BELOW ──────────────────
     Three conditions, each of which makes the standard on this file untrue or
     unsubmittable, and each of which is invisible on any other view. */
  const superseded = currentApprovedRevision !== null
    && num(engineering.sourceTechnicalRevision) !== null
    && Number(currentApprovedRevision) !== Number(engineering.sourceTechnicalRevision);

  if (superseded) {
    gaps.push(gap(ieStyleFile.GAP.SOURCE_VERSION_SUPERSEDED, OWNER.RND,
      NEXT_ACTION.REBASE_ONTO_NEW_TECHNICAL_VERSION,
      `This file is engineered from technical revision ${engineering.sourceTechnicalRevision}, and `
      + `revision ${currentApprovedRevision} has since been approved.`,
      { fileSourceRevision: engineering.sourceTechnicalRevision,
        approvedRevision: Number(currentApprovedRevision) }));
  }
  if (rebase) {
    gaps.push(gap(ieStyleFile.GAP.REBASE_REVIEW_OUTSTANDING, OWNER.IE,
      NEXT_ACTION.REVIEW_REBASED_ROWS,
      `This file was moved onto technical revision ${rebase.technicalRevision}. `
      + `${rebase.rowIds.length} bulletin row${rebase.rowIds.length === 1 ? "" : "s"} must be `
      + "reviewed again before it can be submitted.",
      { rowIds: rebase.rowIds, technicalRevision: rebase.technicalRevision }));
  }
  if (retiredOperations.length) {
    gaps.push(gap(ieStyleFile.GAP.OPERATION_RETIRED, OWNER.IE, NEXT_ACTION.REPLACE_RETIRED_OPERATION,
      `${retiredOperations.join(", ")} ${retiredOperations.length === 1 ? "has" : "have"} been `
      + "retired in the operation library, and this bulletin still uses "
      + `${retiredOperations.length === 1 ? "it" : "them"}.`,
      { operationCodes: retiredOperations }));
  }
  if (engineering.bulletinState === "RETURNED") {
    gaps.push(gap("BULLETIN_VERSION_RETURNED", OWNER.IE, NEXT_ACTION.REWORK_RETURNED_BULLETIN,
      "The last bulletin version submitted for review was returned. Nothing is frozen; the draft "
      + "is editable again."));
  }

  if (superseded || rebase || retiredOperations.length || engineering.bulletinState === "RETURNED") {
    const nextAction = engineering.bulletinState === "RETURNED"
      ? NEXT_ACTION.REWORK_RETURNED_BULLETIN
      : rebase ? NEXT_ACTION.REVIEW_REBASED_ROWS
        : retiredOperations.length ? NEXT_ACTION.REPLACE_RETIRED_OPERATION
          : NEXT_ACTION.REBASE_ONTO_NEW_TECHNICAL_VERSION;
    return {
      classification: CLASSIFICATION.NEEDS_ATTENTION,
      trackingOnly: false,
      /* A superseded source is R&D's fact and IE's move: IE opens the
         successor cycle. The owner is IE unless that is the ONLY finding, in
         which case naming R&D says where the change came from. */
      owner: OWNER.IE,
      nextAction,
      gaps,
      ...opened,
    };
  }

  /* ── AWAITING REVIEW: A VERSION IS FROZEN AND SOMEBODY MUST DECIDE ──────── */
  if (engineering.bulletinState === "IN_REVIEW") {
    return {
      classification: CLASSIFICATION.AWAITING_REVIEW,
      trackingOnly: false,
      owner: OWNER.IE,
      nextAction: NEXT_ACTION.DECIDE_BULLETIN_REVIEW,
      gaps: [gap("BULLETIN_VERSION_IN_REVIEW", OWNER.IE, NEXT_ACTION.DECIDE_BULLETIN_REVIEW,
        `Bulletin version ${engineering.reviewVersionNo} is frozen in review. The draft cannot be `
        + "edited until it is approved or returned.",
        { versionNo: engineering.reviewVersionNo }), ...gaps],
      ...opened,
    };
  }

  /* ── NO APPROVED BULLETIN YET: THE WORK IS IN PROGRESS ──────────────────── */
  if (engineering.bulletinState !== "APPROVED") {
    const empty = !engineering.bulletinRowCount;
    if (empty) {
      gaps.push(gap(ieStyleFile.GAP.BULLETIN_EMPTY, OWNER.IE, NEXT_ACTION.MAP_SOURCE_ROUTE_TO_LIBRARY,
        "This engineering file has no bulletin rows yet."));
    } else if (!engineering.samComplete) {
      gaps.push(gap(ieStyleFile.GAP.PROPOSED_SAM_MISSING, OWNER.IE, NEXT_ACTION.COMPLETE_BULLETIN,
        "Some bulletin rows carry no proposed SAM, so the total covers only the timed rows."));
    }
    return {
      classification: CLASSIFICATION.IN_ENGINEERING,
      trackingOnly: false,
      owner: OWNER.IE,
      nextAction: empty ? NEXT_ACTION.MAP_SOURCE_ROUTE_TO_LIBRARY
        : engineering.samComplete ? NEXT_ACTION.SUBMIT_BULLETIN_FOR_REVIEW
          : NEXT_ACTION.COMPLETE_BULLETIN,
      gaps,
      ...opened,
    };
  }

  /* ── AN APPROVED BULLETIN. WHAT IS STILL MISSING BELOW IT? ───────────────
     Layout, then capacity, then the release — in that order, because each is
     built on the one before it and an approved standard with no layout is a
     real and common state the register must not report as finished. */
  if (engineering.layoutState !== "APPROVED") {
    gaps.push(gap("LINE_LAYOUT_NOT_APPROVED", OWNER.IE,
      engineering.layoutState === "NONE" ? NEXT_ACTION.BUILD_LINE_LAYOUT : NEXT_ACTION.APPROVE_LINE_LAYOUT,
      engineering.layoutState === "NONE"
        ? "The approved bulletin has no standard line layout balanced against it."
        : "A line layout exists as a draft and has not been approved.",
      { layoutState: engineering.layoutState }));
  }
  if (engineering.capacityState !== "APPROVED") {
    gaps.push(gap("CAPACITY_STANDARD_NOT_APPROVED", OWNER.IE,
      engineering.capacityState === "NONE" ? NEXT_ACTION.RECORD_CAPACITY_STANDARD : NEXT_ACTION.APPROVE_CAPACITY_STANDARD,
      engineering.capacityState === "NONE"
        ? "No capacity standard or target has been recorded against this layout."
        : "A capacity standard exists as a draft and has not been approved.",
      { capacityState: engineering.capacityState }));
  }

  if (engineering.releaseState === "ISSUED") {
    return {
      classification: CLASSIFICATION.RELEASED,
      trackingOnly: false,
      owner: OWNER.NOBODY,
      nextAction: NEXT_ACTION.NOTHING_OUTSTANDING,
      gaps,
      ...opened,
    };
  }

  const missingBelow = engineering.layoutState !== "APPROVED" || engineering.capacityState !== "APPROVED";
  return {
    classification: CLASSIFICATION.APPROVED_STANDARD,
    trackingOnly: false,
    owner: OWNER.IE,
    nextAction: engineering.layoutState !== "APPROVED"
      ? (engineering.layoutState === "NONE" ? NEXT_ACTION.BUILD_LINE_LAYOUT : NEXT_ACTION.APPROVE_LINE_LAYOUT)
      : engineering.capacityState !== "APPROVED"
        ? (engineering.capacityState === "NONE" ? NEXT_ACTION.RECORD_CAPACITY_STANDARD : NEXT_ACTION.APPROVE_CAPACITY_STANDARD)
        : NEXT_ACTION.ISSUE_ENGINEERING_RELEASE,
    gaps: missingBelow ? gaps : [gap("ENGINEERING_RELEASE_NOT_ISSUED", OWNER.IE,
      NEXT_ACTION.ISSUE_ENGINEERING_RELEASE,
      "The bulletin, layout and capacity standard are all approved and no engineering release has "
      + "been issued from them yet."), ...gaps],
    ...opened,
  };
}

/* ═══ BATCH LOADS — SIX QUERIES, WHATEVER THE PAGE SIZE ════════════════════ */

/**
 * The Merchandising development file per style, by stored reference only.
 *
 * Where a company has more than one file naming one style the NEWEST by
 * `updatedAt` is kept and `duplicate: true` is published on it, because
 * silently choosing one of two would be exactly the inference §4 of the audit
 * forbids — and the audit's own recommendation is to say so.
 */
async function developmentFilesFor(companyId, styleIds) {
  if (!styleIds.length) return new Map();
  const found = await DevelopmentFile().find({
    companyId: oid(companyId),
    sampleStyleId: { $in: styleIds.map(oid) },
  }).select(DEVELOPMENT_PROJECTION).sort({ updatedAt: -1, _id: -1 }).lean();

  const byStyle = new Map();
  for (const file of found) {
    const key = str(file.sampleStyleId);
    if (byStyle.has(key)) { byStyle.get(key).duplicate = true; continue; }
    byStyle.set(key, { ...file, duplicate: false });
  }
  return byStyle;
}

/** Every IE file this company holds for the scanned styles. */
async function styleFilesFor(companyId, styleIds) {
  if (!styleIds.length) return new Map();
  const found = await IeStyleFile().find({
    companyId: oid(companyId),
    sampleStyleId: { $in: styleIds.map(oid) },
  }).lean();
  return new Map(found.map((f) => [str(f.sampleStyleId), f]));
}

/**
 * The approved children of a set of files, per file — one query each.
 *
 * A DRAFT and an APPROVED record are both reported, because "no layout" and
 * "a layout nobody approved" are different answers and a register that showed
 * them the same way would send somebody to build one that already exists.
 */
async function childrenFor(companyId, fileIds) {
  const empty = new Map();
  if (!fileIds.length) return empty;
  const company = oid(companyId);
  const files = fileIds.map(oid);

  const [versions, layouts, capacities, releases] = await Promise.all([
    /* Only what the file itself cannot say: a RETURNED decision. The freeze
       and the current approval are fields on the file. */
    IeBulletinVersion().find({ companyId: company, ieStyleFileId: { $in: files } })
      .select("ieStyleFileId versionNo state updatedAt").sort({ versionNo: -1 }).lean(),
    IeLineLayout().find({ companyId: company, ieStyleFileId: { $in: files } })
      .select("ieStyleFileId status updatedAt").lean(),
    IeCapacityStandard().find({ companyId: company, ieStyleFileId: { $in: files } })
      .select("ieStyleFileId status updatedAt").lean(),
    IeRelease().find({ companyId: company, ieStyleFileId: { $in: files } })
      .select("ieStyleFileId state versionNo issuedAt").sort({ versionNo: -1 }).lean(),
  ]);

  const out = new Map(fileIds.map((id) => [str(id), {
    returned: false, layout: "NONE", capacity: "NONE", releaseState: "NONE", releaseVersionNo: null,
  }]));

  /* Sorted by version descending, so the FIRST row seen for a file is its
     latest — which is the one whose RETURNED verdict is still standing. */
  const seenVersion = new Set();
  for (const v of versions) {
    const key = str(v.ieStyleFileId);
    if (!out.has(key) || seenVersion.has(key)) continue;
    seenVersion.add(key);
    if (str(v.state) === "RETURNED") out.get(key).returned = true;
  }
  const best = (current, status) => (current === "APPROVED" ? current : (status === "APPROVED" ? "APPROVED" : "DRAFT"));
  for (const l of layouts) {
    const at = out.get(str(l.ieStyleFileId));
    if (at) at.layout = best(at.layout, str(l.status));
  }
  for (const c of capacities) {
    const at = out.get(str(c.ieStyleFileId));
    if (at) at.capacity = best(at.capacity, str(c.status));
  }
  const seenRelease = new Set();
  for (const r of releases) {
    const key = str(r.ieStyleFileId);
    const at = out.get(key);
    if (!at) continue;
    /* An ISSUED release always wins, whatever its number: a superseded one is
       history, and a withdrawn one is not a standard anybody may build on. */
    if (str(r.state) === "ISSUED") {
      at.releaseState = "ISSUED";
      at.releaseVersionNo = num(r.versionNo);
      seenRelease.add(key);
      continue;
    }
    if (seenRelease.has(key)) continue;
    seenRelease.add(key);
    at.releaseState = str(r.state) || "NONE";
    at.releaseVersionNo = num(r.versionNo);
  }
  return out;
}

/**
 * Which operation codes the scanned bulletins name that are now RETIRED.
 *
 * One query for the whole scan, bounded by the operations these bulletins
 * actually reference rather than by the size of the library.
 */
async function retiredOperationsFor(companyId, files) {
  const referenced = new Set();
  for (const file of files) {
    for (const row of (file.bulletin?.rows || [])) {
      if (isId(row.ieOperationId)) referenced.add(str(row.ieOperationId));
    }
  }
  if (!referenced.size) return new Map();
  const retired = await IeOperation().find({
    _id: { $in: [...referenced].map(oid) },
    companyId: oid(companyId),
    status: "RETIRED",
  }).select("_id code name").lean();
  if (!retired.length) return new Map();
  const byId = new Map(retired.map((o) => [str(o._id), str(o.code) || str(o.name)]));

  const byFile = new Map();
  for (const file of files) {
    const codes = [];
    for (const row of (file.bulletin?.rows || [])) {
      const code = byId.get(str(row.ieOperationId));
      if (code && !codes.includes(code)) codes.push(code);
    }
    if (codes.length) byFile.set(str(file._id), codes);
  }
  return byFile;
}

/* ═══ THE ROW ══════════════════════════════════════════════════════════════ */

/**
 * WHAT A DEVELOPMENT ROW MAY CONTAIN.
 *
 * Built field by field. `reference` is the style's own code — never a buyer's
 * name and never an enquiry number; the Journey and the enquiry proved the
 * company and stop at that proof.
 */
function developmentRow(style, { sales, technical, merchandising, engineering, verdict, duplicateDevelopment }) {
  return {
    styleId: str(style._id),
    reference: str(style.styleCode) || str(style.sampleStyleId),
    productName: str(style.productName),
    variantLabel: str(style.variantLabel),
    updatedAt: style.updatedAt || null,
    /* ── ONE PICTURE, OR NONE ────────────────────────────────────────────
       `null` where the style carries no reference image, which is an ordinary
       state on an early development. The row draws a placeholder for it; it
       does not draw a stock photograph of somebody else's garment. */
    thumbnail: evidence.thumbnailFor(style),

    sales,
    rnd: technical,
    merchandising: { ...merchandising, duplicate: Boolean(duplicateDevelopment) },
    engineering,

    classification: verdict.classification,
    trackingOnly: verdict.trackingOnly,
    owner: verdict.owner,
    nextAction: verdict.nextAction,
    gaps: verdict.gaps,
    canOpenEngineeringFile: verdict.canOpenEngineeringFile,
    openBlockedReason: verdict.openBlockedReason,
  };
}

/** The literal-text match a caller's search runs against. */
function matchesTerm(style, merchandising, term) {
  if (!term) return true;
  const needle = term.toLowerCase();
  return [
    style.styleCode, style.sampleStyleId, style.productName, style.variantLabel,
    merchandising.developmentNumber,
  ].some((v) => str(v).toLowerCase().includes(needle));
}

/* ═══ THE REGISTER ═════════════════════════════════════════════════════════ */

/**
 * THE DEVELOPMENT REGISTER — one bounded pass, one view, honest counts.
 *
 * @param {object} ctx  `{ companyId, role }` — the role decides only whether
 *   `canOpenEngineeringFile` is offered. The server re-checks it on the POST
 *   regardless; this is a courtesy so a viewer is not handed a control that
 *   refuses them.
 */
async function listDevelopment(ctx, { view, q, limit, cursor } = {}) {
  assertContext(ctx);
  const size = pageSize(limit);
  const asked = readView(view);
  const term = str(q);
  const after = cursor ? decodePosition(cursor) : null;
  const mayWrite = roleAtLeast(str(ctx.role) || "viewer", "editor");

  const bound = await styleOwnershipClause(ctx.companyId);
  /* A company that owns no Sales parent owns no style. Zero is TRUE here, and
     truthful zeros are published as counts rather than withheld. */
  if (!bound) return emptyRegister(asked, size, term);

  const styles = await SampleStyle().find(bound)
    .select(STYLE_PROJECTION)
    .sort({ updatedAt: -1, _id: -1 })
    .limit(SCAN_CAP + 1)
    .lean();

  const capped = styles.length > SCAN_CAP;
  const scanned = capped ? styles.slice(0, SCAN_CAP) : styles;
  const styleIds = scanned.map((s) => str(s._id));

  const [developments, files] = await Promise.all([
    developmentFilesFor(ctx.companyId, styleIds),
    styleFilesFor(ctx.companyId, styleIds),
  ]);
  const fileList = [...files.values()];
  const [children, retired] = await Promise.all([
    childrenFor(ctx.companyId, fileList.map((f) => str(f._id))),
    retiredOperationsFor(ctx.companyId, fileList),
  ]);

  const counts = Object.fromEntries(VIEWS.map((v) => [v, 0]));
  const classified = [];

  for (const style of scanned) {
    const key = str(style._id);
    const development = developments.get(key) || null;
    const file = files.get(key) || null;
    const childState = file
      ? (children.get(str(file._id)) || { returned: false, layout: "NONE", capacity: "NONE", releaseState: "NONE", releaseVersionNo: null })
      : {};

    const sales = salesPositionOf(style);
    const technical = technicalPositionOf(style);
    const merchandising = merchandisingPositionOf(development);
    const engineering = engineeringPositionOf(file, childState);

    const verdict = classify({
      sales, technical, merchandising, engineering,
      rebase: file ? ieStyleFile.outstandingRebaseReview(file) : null,
      retiredOperations: file ? (retired.get(str(file._id)) || []) : [],
      /* R&D's revision AS IT IS NOW, from the very style document this row was
         built from — so "is this standard stale" needs no second read. */
      currentApprovedRevision: technical.approved ? technical.revision : null,
      mayWrite,
    });

    counts[VIEW.ALL] += 1;
    for (const [v, c] of Object.entries(VIEW_CLASSIFICATION)) {
      if (c === verdict.classification) counts[v] += 1;
    }

    if (!matchesTerm(style, merchandising, term)) continue;
    const wanted = asked === VIEW.ALL || VIEW_CLASSIFICATION[asked] === verdict.classification;
    if (!wanted) continue;

    classified.push({
      position: positionOf(style),
      row: developmentRow(style, {
        sales, technical, merchandising, engineering, verdict,
        duplicateDevelopment: development?.duplicate,
      }),
    });
  }

  /* The cursor is applied to the CLASSIFIED list, in the same order the styles
     were read. Applied before classification it would have paged a population
     the view does not show. */
  const from = after ? classified.findIndex((c) => isAfter(c.position, after)) : 0;
  const start = from < 0 ? classified.length : from;
  const page = classified.slice(start, start + size);
  const hasMore = classified.length > start + size;
  const last = page[page.length - 1];

  return {
    view: asked,
    rows: page.map((c) => c.row),
    limit: size,
    hasMore,
    nextCursor: hasMore && last ? encodePosition(last.position) : null,
    sort: "updatedAt:desc,_id:desc",
    /* ── COUNTS, OR NOTHING ────────────────────────────────────────────────
       Published only where the whole population was actually classified. Past
       the cap they are a subtotal, and a subtotal shown as a total is how a
       planner concludes a factory has five styles in engineering when it has
       fifty. `null` is the honest answer, and the screen draws no badge. */
    counts: capped ? null : counts,
    countsState: capped ? "SCAN_CAPPED" : "COMPLETE",
    scanned: scanned.length,
    scanCap: SCAN_CAP,
    /* Searching narrows the ROWS, never the counts: a tab badge that moved
       while somebody typed would be measuring the search, not the register. */
    searched: Boolean(term),
  };
}

const emptyRegister = (view, size, term) => ({
  view,
  rows: [],
  limit: size,
  hasMore: false,
  nextCursor: null,
  sort: "updatedAt:desc,_id:desc",
  counts: Object.fromEntries(VIEWS.map((v) => [v, 0])),
  countsState: "COMPLETE",
  scanned: 0,
  scanCap: SCAN_CAP,
  searched: Boolean(term),
});

/* ── THE CURSOR ────────────────────────────────────────────────────────────
 * The same `(updatedAt, _id)` position `ieRead.listStyles` pages by, encoded
 * with that module's own helpers so this register and the style list cannot
 * drift into two cursor formats. */
const positionOf = (style) => ({
  t: style.updatedAt ? new Date(style.updatedAt).getTime() : 0,
  i: str(style._id),
});
const encodePosition = (position) => require("./ieRead.service").encodeCursor(position);
const decodePosition = (raw) => require("./ieRead.service").decodeCursor(raw, "time");
/** Strictly after, in the list's own descending order. */
const isAfter = (position, after) => position.t < after.t
  || (position.t === after.t && position.i < after.i);

/* ═══ ONE ROW, WITH ITS EVIDENCE ═══════════════════════════════════════════ */

/**
 * ONE DEVELOPMENT STYLE — the same composition, plus the read-only evidence
 * the workspace's Source & Handoff section shows.
 *
 * Absent, another company's and unprovable all return the same refusal, for
 * the reason `ieRead.readStyle` gives: a refusal that varies with the answer is
 * an oracle for which style ids are real and whose they are.
 */
async function readDevelopment(ctx, { styleId } = {}) {
  assertContext(ctx);
  if (!isId(styleId)) throw styleNotFound();
  const mayWrite = roleAtLeast(str(ctx.role) || "viewer", "editor");

  const style = await SampleStyle().findById(oid(styleId)).select(STYLE_DETAIL_PROJECTION).lean();
  if (!style) throw styleNotFound();
  /* Proved one style at a time, through the Sales parent that carries the
     company. Neither parent appears below. */
  if (!(await ownershipProofFor(style, ctx.companyId))) throw styleNotFound();

  const key = str(style._id);
  const [developments, files] = await Promise.all([
    developmentFilesFor(ctx.companyId, [key]),
    styleFilesFor(ctx.companyId, [key]),
  ]);
  const development = developments.get(key) || null;
  const file = files.get(key) || null;
  const [children, retired] = await Promise.all([
    childrenFor(ctx.companyId, file ? [str(file._id)] : []),
    retiredOperationsFor(ctx.companyId, file ? [file] : []),
  ]);
  const childState = file
    ? (children.get(str(file._id)) || { returned: false, layout: "NONE", capacity: "NONE", releaseState: "NONE", releaseVersionNo: null })
    : {};

  const sales = salesPositionOf(style);
  const technical = technicalPositionOf(style);
  const merchandising = merchandisingPositionOf(development);
  const engineering = engineeringPositionOf(file, childState);
  const verdict = classify({
    sales, technical, merchandising, engineering,
    rebase: file ? ieStyleFile.outstandingRebaseReview(file) : null,
    retiredOperations: file ? (retired.get(str(file._id)) || []) : [],
    currentApprovedRevision: technical.approved ? technical.revision : null,
    mayWrite,
  });

  return {
    row: developmentRow(style, {
      sales, technical, merchandising, engineering, verdict,
      duplicateDevelopment: development?.duplicate,
    }),
    /* ── THE EVIDENCE, ATTRIBUTED TO THE DESK THAT OWNS IT ────────────────
       Read-only by construction: there is no PATCH on this boundary, and each
       block names the record it came from so a screen can attribute it without
       guessing. `lineageNote` is the one sentence the audit asks for in place
       of an inferred link. */
    evidence: {
      sales: {
        source: "SampleStyle",
        reference: str(style.styleCode) || str(style.sampleStyleId),
        stage: sales.stage,
        styleStatus: str(style.status),
        materialsStatus: sales.materialsStatus,
        sampleStatus: sales.sampleStatus,
      },
      merchandising: development ? {
        source: "Merchandising development file",
        developmentNumber: str(development.developmentNumber),
        lifecycleStatus: str(development.lifecycleStatus),
        lifecycleReason: str(development.lifecycleReason),
        bomRevisionNo: num(development.currentBomRevisionNo),
        releasedBomRevisionNo: num(development.releasedBomRevisionNo),
        releasedAt: development.releasedToRndAt || null,
        releaseReference: str(development.releaseReference),
        duplicate: Boolean(development.duplicate),
      } : null,
      rnd: {
        source: "SampleStyle technical record",
        technicalStatus: technical.status,
        approvedRevision: technical.revision,
        approvedAt: technical.approvedAt,
        submittedAt: technical.submittedAt,
        revisionCount: technical.revisionCount,
        ambiguous: technical.ambiguous,
        sampleStatus: sales.sampleStatus,
      },
      /* ── THE GARMENT ITSELF ────────────────────────────────────────────
         Read AFTER the company was proved, from the style this actor is
         permitted to see and from the product and the Sales request that style
         names. Two bounded queries at most, neither issued when the reference
         is absent. Nothing here is fetched by a browser: Sales', Merchandising's
         and R&D's own endpoints are not called from the client and are not
         called from here — these are fields on records this boundary already
         reads, published through an allowlist of its own. */
      ...(await evidence.evidenceFor({ style, development })),
      lineage: {
        state: merchandising.lineage,
        note: merchandising.lineage === LINEAGE.ABSENT
          ? "No Merchandising development file names this style."
          : "The approved technical revision does not record which released BOM revision it was "
            + "drawn from, so the material lineage between Merchandising and R&D is not proved.",
      },
    },

    /* ── WHAT IE WAS GIVEN TO ENGINEER FROM ──────────────────────────────
       A sibling of `row` and `evidence`, never a member of either: `row` is
       shared with the register's list, and anything added there would land on
       every row of it. Built from records this read already holds, so the
       detail costs no extra query. */
    manufacturingInputs: manufacturing.manufacturingInputsFor({ style, development }),
  };
}

module.exports = {
  CODES, CLASSIFICATION, VIEW, VIEWS, VIEW_CLASSIFICATION, OWNER, NEXT_ACTION, LINEAGE,
  OPEN_BLOCKED, DEFAULT_LIMIT, MAX_LIMIT, SCAN_CAP, STYLE_DETAIL_PROJECTION,
  /* Pure, and exported because it is the register's entire vocabulary. Every
     classification, owner, next action and gap this department publishes is
     decided here and nowhere else. */
  classify,
  salesPositionOf, technicalPositionOf, merchandisingPositionOf, engineeringPositionOf,
  matchesTerm, readView, pageSize,
  listDevelopment, readDevelopment,
};
