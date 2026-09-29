// services/industrialEngineering/ieReleaseImpact.service.js
//
// IE CHUNK 8A-iii — WHAT HAS MOVED SINCE THIS RELEASE WAS ISSUED.
//
// Read-only, computed on demand, and stored NOWHERE. The audit's §5.7 is
// explicit about that and the reason is not tidiness: a cached impact record is
// a second, weaker copy of a fact both sides already hold, and the moment it
// disagrees with them nobody can say which is right. So this module writes
// nothing — no release, no style file, no bulletin version, no receipt, no
// history event, no outbox row, no work order, no barcode, no scan record.
//
// ── THE TWO THINGS BEING COMPARED ───────────────────────────────────────────
// The release's own FROZEN bulletin evidence, and the style file's CURRENT
// approved bulletin version. Both are immutable documents; neither is re-derived
// and neither is read live from the operation library — re-answering an issued
// handover from today's library is exactly the defect that would make a frozen
// release worthless.
//
// ── AND IDENTITY IS STABLE, NEVER POSITIONAL AND NEVER A LABEL ──────────────
// Rows are matched by `rowId`, and an unmatched row is given one more chance
// against `ieOperationId`. Array position proves nothing — one insertion
// re-indexes everything after it and every row downstream would read as changed.
// `operationCode` proves nothing either: it is a mutable display label, two
// operations may legitimately share one, and renaming an operation must never
// read as replacing it.
//
// ── SIMULTANEOUS CHANGES STAY SIMULTANEOUS ──────────────────────────────────
// A row can be re-timed AND re-sequenced AND have its requirements change, and
// each of those has a different owner and a different fix. Picking one as the
// "primary" result would hide the other two behind an arbitrary precedence
// nobody chose, so every row carries a LIST of classifications and a reason for
// each one.
"use strict";

const mongoose = require("mongoose");

const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const IeBulletinVersion = require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

const { styleOwnerFrom } = require("../companyContext/merchandisingScope.service");
const { OWNERSHIP_MODE } = require("./workOrderStyleLink.service");
/* The ONE published shape for frozen requirement evidence — shared with the
   draft bulletin and the bulletin version rather than re-spelled here. */
const { publishRequirementSnapshot } = require("./ieStyleFile.service");
/* The ONE canonical form of a frozen requirement — shared with the stored
   source digest, so the two can never disagree about what a change is. */
const {
  DIMENSIONS, canonicalDimension, machineLevel, canonicalMachineReduced,
} = require("./requirementCanonical");
const {
  calculateCapacity, toUnits, unitsToMinutes,
} = require("./capacityCalculation");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const iso = (d) => (d ? new Date(d).toISOString() : null);
/* ── AND AN ABSENCE IS NEVER A ZERO ──────────────────────────────────────
   `Number(null)` and `Number("")` are both 0 and both finite, so the obvious
   one-liner silently turns "this side has no figure" into "this side is nought"
   — and a delta against a nought is a confident, wrong number rather than an
   honest unknown. Absences are screened out before the conversion. */
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ── THE CLOSED SET OF ROW RESULTS ─────────────────────────────────────────
   Closed on purpose: a screen branches on these, and a classification added by
   one service and unknown to another is how two surfaces come to disagree
   about the same row. */
const CHANGE = Object.freeze({
  UNCHANGED: "UNCHANGED",
  RETIMED: "RETIMED",
  REQUIREMENT_CHANGED: "REQUIREMENT_CHANGED",
  ADDED: "ADDED",
  REMOVED: "REMOVED",
  RESEQUENCED: "RESEQUENCED",
  OPERATION_REPLACED: "OPERATION_REPLACED",
});

/** How the two bulletins relate. Three answers, never inferred from silence. */
const COMPARISON = Object.freeze({
  CURRENT: "CURRENT",
  MOVED: "MOVED",
  NO_CURRENT_APPROVED: "NO_CURRENT_APPROVED",
});

/** A sentence per capacity refusal. A code alone is something to look up. */
const CAPACITY_MESSAGE = Object.freeze({
  NO_CURRENT_APPROVED_BULLETIN:
    "There is no current approved bulletin version to compare against, so no comparable capacity "
    + "target can be derived. Approve a bulletin version for this style file.",
  RELEASED_ASSUMPTIONS_INCOMPLETE:
    "The capacity standard this release froze does not carry every planning assumption the "
    + "calculation needs, so the comparison cannot be made. Re-issue from a complete standard.",
  CURRENT_CAPACITY_UNAVAILABLE:
    "The current bulletin does not yield a capacity target — usually because its garment SAM is "
    + "not yet established. Approve the outstanding standard times and try again.",
  RELEASED_TARGET_UNAVAILABLE:
    "This release froze no capacity target, so there is nothing to compare the current one with.",
});

/** Why a work order could not be proved. Stable, so it can be reported on. */
const UNPROVABLE = Object.freeze({
  NO_STYLE_LINK: "NO_STYLE_LINK",
  DIFFERENT_STYLE: "DIFFERENT_STYLE",
  STYLE_NOT_FOUND: "STYLE_NOT_FOUND",
  OWNERSHIP_UNPROVEN: "OWNERSHIP_UNPROVEN",
  COMPANY_MISMATCH: "COMPANY_MISMATCH",
});

/** How a work order came to be examined at all. Never a proof of anything. */
const CANDIDATE_SOURCE = Object.freeze({
  DIRECT_STYLE_LINK: "DIRECT_STYLE_LINK",
  STYLE_FILE_PROVENANCE: "STYLE_FILE_PROVENANCE",
  SHARED_STOCK_ITEM: "SHARED_STOCK_ITEM",
});

/** Why a comparable current capacity target could not be honestly derived. */
const CAPACITY_UNKNOWN = Object.freeze({
  NO_CURRENT_APPROVED_BULLETIN: "NO_CURRENT_APPROVED_BULLETIN",
  RELEASED_ASSUMPTIONS_INCOMPLETE: "RELEASED_ASSUMPTIONS_INCOMPLETE",
  CURRENT_CAPACITY_UNAVAILABLE: "CURRENT_CAPACITY_UNAVAILABLE",
  RELEASED_TARGET_UNAVAILABLE: "RELEASED_TARGET_UNAVAILABLE",
});

/* A foreign company's release, one that never existed and a malformed id are
   ONE answer — anything else lets a caller probe what exists elsewhere. */
const notFound = () => fail("IE_RELEASE_NOT_FOUND", "That engineering release does not exist.");

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

/* ═══ DECIMAL-SAFE SIGNED DELTAS ═══════════════════════════════════════════
   Through the same scaled-integer helpers the capacity calculator uses, so a
   delta of 0.1 + 0.2 is 0.3 here and not 0.30000000000000004. Null when either
   side is unknown — a delta against an unknown is not nought. */
const deltaMinutes = (from, to) => {
  const a = num(from);
  const b = num(to);
  if (a === null || b === null) return null;
  return unitsToMinutes(toUnits(b) - toUnits(a));
};
const deltaWhole = (from, to) => {
  const a = num(from);
  const b = num(to);
  if (a === null || b === null) return null;
  return b - a;
};

/* ═══ REQUIREMENT EVIDENCE — TRI-STATE, PER DIMENSION ═════════════════════
 *
 * Chunk 5A models three dimensions on an operation: machine, attachment and
 * labour. Chunk 8A-iii freezes all three onto a bulletin row at submission, so
 * a version submitted from now on can be compared on all three.
 *
 * A version submitted BEFORE that froze only the machine half, and there is no
 * backfill — restating a historical version is the one thing a frozen record
 * must never do. Those rows therefore compare as `NOT_CAPTURED`, which is a
 * THIRD answer and not a quiet "unchanged": saying two sides agree about
 * evidence neither of them holds is a reassurance nobody earned.
 *
 * So every dimension answers one of three things, and `REQUIREMENT_CHANGED`
 * names exactly which comparable dimensions moved.
 */
const DIMENSION_STATE = Object.freeze({
  CAPTURED: "CAPTURED",
  NOT_CAPTURED: "NOT_CAPTURED",
});

/** MOVED / UNCHANGED / null — null being "these two cannot be compared". */
const DIMENSION_COMPARISON = Object.freeze({
  MOVED: "MOVED",
  UNCHANGED: "UNCHANGED",
  NOT_COMPARABLE: "NOT_COMPARABLE",
});

const requirementEvidence = (snapshot) => {
  const published = publishRequirementSnapshot(snapshot);
  if (!published) {
    return {
      configured: null,
      capturedAt: null,
      ieOperationRevision: null,
      dimensionsCaptured: [],
      machines: [],
      attachments: [],
      labour: [],
      dimensionState: {
        MACHINE: DIMENSION_STATE.NOT_CAPTURED,
        ATTACHMENT: DIMENSION_STATE.NOT_CAPTURED,
        LABOUR: DIMENSION_STATE.NOT_CAPTURED,
      },
    };
  }
  const captured = published.dimensionsCaptured || [];
  /* The machine half has been frozen since Chunk 6B, in `machineTypes`, so a
     legacy row IS comparable on machines even without the marker. The richer
     `machines` array — with the stable requirement id and sequence — exists
     only from Chunk 8A-iii, so a legacy row's machine list is rebuilt from
     `machineTypes` with those two stated as absent rather than invented. */
  const machines = published.machines
    || (published.machineTypes || []).map((m) => ({
      requirementId: null, sequence: null,
      machineType: m.machineType, quantity: num(m.quantity),
    }));
  return {
    configured: published.requirementsConfigured,
    capturedAt: published.capturedAt,
    ieOperationRevision: published.ieOperationRevision,
    dimensionsCaptured: [...captured],
    machines,
    /* Empty list when a dimension was captured and is genuinely empty; empty
       list AND a NOT_CAPTURED state when it was never frozen. The state is what
       a reader branches on — the list alone cannot tell the two apart. */
    attachments: published.attachments || [],
    labour: published.labour || [],
    dimensionState: {
      MACHINE: DIMENSION_STATE.CAPTURED,
      ATTACHMENT: published.attachments ? DIMENSION_STATE.CAPTURED : DIMENSION_STATE.NOT_CAPTURED,
      LABOUR: published.labour ? DIMENSION_STATE.CAPTURED : DIMENSION_STATE.NOT_CAPTURED,
    },
  };
};

/**
 * One dimension, compared three ways — from the SAME canonical form the stored
 * requirement digest is built from.
 *
 * Deliberately taken from the RAW frozen snapshot rather than from the
 * published side object: the digest hashes the stored shape, and a comparison
 * reading a projection of it could drift from the digest by one mapping
 * decision. Then a release would report REQUIREMENT_CHANGED while its own
 * requirement digest said nothing had moved, and nobody could say which was
 * right.
 *
 * `NOT_COMPARABLE` whenever EITHER side failed to freeze the dimension:
 * comparing an absence against a list would report a change that is really just
 * the arrival of the evidence, and comparing two absences would report
 * agreement about nothing.
 */
function compareDimension(dimension, beforeSnapshot, afterSnapshot) {
  /* ── ONE MIXED CASE, ANSWERED HONESTLY ────────────────────────────────
     A release frozen with full machine identity, compared against a bulletin
     version frozen before that existed (or the reverse). Their requirement ids
     differ because one side HAS them and the other never did — the identity did
     not move, it arrived. Reporting MOVED there would send somebody to look for
     a machine change that never happened.

     So both sides drop to the granularity both can answer — type and quantity,
     which Chunk 6B has always frozen — and the reduction travels with the
     verdict. Nothing is silently equated: a reader is told the identities were
     not compared. */
  const reduced = dimension === "MACHINE"
    && machineLevel(beforeSnapshot) !== machineLevel(afterSnapshot);
  const before = reduced
    ? canonicalMachineReduced(beforeSnapshot) : canonicalDimension(beforeSnapshot, dimension);
  const after = reduced
    ? canonicalMachineReduced(afterSnapshot) : canonicalDimension(afterSnapshot, dimension);
  if (before === null || after === null) {
    return { verdict: DIMENSION_COMPARISON.NOT_COMPARABLE, reduced: false };
  }
  return {
    verdict: before === after ? DIMENSION_COMPARISON.UNCHANGED : DIMENSION_COMPARISON.MOVED,
    reduced,
  };
}

/** Which comparable dimensions actually moved, plus the configured flag. */
function requirementMovement(beforeSnapshot, afterSnapshot) {
  const perDimension = {};
  const moved = [];
  const notComparable = [];
  const reducedGranularity = [];
  for (const dimension of DIMENSIONS) {
    const { verdict, reduced } = compareDimension(dimension, beforeSnapshot, afterSnapshot);
    perDimension[dimension] = verdict;
    if (verdict === DIMENSION_COMPARISON.MOVED) moved.push(dimension);
    if (verdict === DIMENSION_COMPARISON.NOT_COMPARABLE) notComparable.push(dimension);
    if (reduced) reducedGranularity.push(dimension);
  }
  /* "Nobody has decided what this operation requires" becoming "somebody has"
     is a requirement change even when no list moved with it. */
  const beforeConfigured = beforeSnapshot ? Boolean(beforeSnapshot.requirementsConfigured) : null;
  const afterConfigured = afterSnapshot ? Boolean(afterSnapshot.requirementsConfigured) : null;
  const configuredMoved = beforeConfigured !== null && afterConfigured !== null
    && beforeConfigured !== afterConfigured;
  return {
    perDimension,
    moved,
    notComparable,
    /* Compared, but only on the fields both sides could answer. Stated so a
       MACHINE "UNCHANGED" is never read as "the identities agree". */
    reducedGranularity,
    configuredMoved,
    changed: moved.length > 0 || configuredMoved,
  };
}

/* ═══ ROW IDENTITY AND EVIDENCE ════════════════════════════════════════════ */

/**
 * ONE SIDE OF A ROW — released, or current.
 *
 * The identity belongs to the SIDE, never to the row: when an operation is
 * replaced the two sides are two different operations, each with its own id and
 * revision, and a single row-level identity could only ever name one of them,
 * hiding the very fact the classification reports.
 *
 * `null` when the row exists on one side only. An empty object there would
 * render as a row of blanks that reads like missing data rather than like an
 * operation that is genuinely not there.
 */
const side = (r) => (r ? {
  ieOperationId: r.ieOperationId ? String(r.ieOperationId) : null,
  ieOperationRevision: num(r.ieOperationRevision),
  operationCode: str(r.operationCode),
  operationName: str(r.operationName),
  sequence: num(r.sequence),
  standardTimeMinutes: num(r.standardTimeMinutes),
  standardTimeSource: str(r.standardTimeSource),
  /* The timing IDENTITY, on every row and not only a changed one: a reader
     asking "which study produced this number" must not have to infer it from
     whether anything moved. */
  methodStudyId: r.methodStudyId ? String(r.methodStudyId) : null,
  approvedSubmissionId: str(r.approvedSubmissionId) || null,
  approvedAt: iso(r.approvedAt),
  machineType: str(r.machineType),
  requirements: requirementEvidence(r.requirementSnapshot),
} : null);

const reason = (change, code, message, extra = {}) => ({ change, code, message, ...extra });

function pairRows(releasedRows, currentRows) {
  const pairs = [];
  const currentByRowId = new Map();
  for (const row of currentRows) currentByRowId.set(str(row.rowId), row);
  const claimed = new Set();

  const unmatchedReleased = [];
  for (const released of releasedRows) {
    const byRowId = currentByRowId.get(str(released.rowId));
    if (byRowId && !claimed.has(byRowId)) {
      claimed.add(byRowId);
      pairs.push({ released, current: byRowId, matchedBy: "ROW_ID" });
      continue;
    }
    unmatchedReleased.push(released);
  }

  for (const released of unmatchedReleased) {
    const opId = released.ieOperationId ? String(released.ieOperationId) : null;
    const candidates = opId
      ? currentRows.filter((c) => !claimed.has(c) && String(c.ieOperationId || "") === opId)
      : [];
    if (candidates.length === 1) {
      claimed.add(candidates[0]);
      pairs.push({ released, current: candidates[0], matchedBy: "OPERATION_ID" });
      continue;
    }
    pairs.push({ released, current: null, matchedBy: null });
  }

  for (const current of currentRows) {
    if (!claimed.has(current)) pairs.push({ released: null, current, matchedBy: null });
  }
  return pairs;
}

function comparePair({ released, current, matchedBy }) {
  const releasedSide = side(released);
  const currentSide = side(current);
  /* `rowId` names the POSITION the two sides are compared at, which is what
     makes them comparable — it is not an operation identity. */
  const rowId = str(released?.rowId) || str(current?.rowId) || null;
  const base = { rowId, matchedBy, released: releasedSide, current: currentSide };

  if (!current) {
    return {
      ...base,
      classifications: [CHANGE.REMOVED],
      reasons: [reason(CHANGE.REMOVED, "NO_MATCHING_CURRENT_ROW",
        "No row in the current approved bulletin carries this row id, and no single current row "
        + "carries this operation either.")],
      requirementMovement: null,
      labelsChanged: null,
    };
  }
  if (!released) {
    return {
      ...base,
      classifications: [CHANGE.ADDED],
      reasons: [reason(CHANGE.ADDED, "NOT_IN_RELEASED_BULLETIN",
        "The current approved bulletin carries this row and the released one did not.")],
      requirementMovement: null,
      labelsChanged: null,
    };
  }

  const classifications = [];
  const reasons = [];

  /* ── THE OPERATION ITSELF ────────────────────────────────────────────────
     By stable id ONLY. A renamed or re-coded operation is the SAME operation
     and must never read as a replacement — the codes and names travel as
     evidence on both sides so a reader can see the rename for what it is. */
  const labelsChanged = releasedSide.operationCode !== currentSide.operationCode
    || releasedSide.operationName !== currentSide.operationName;

  if (releasedSide.ieOperationId !== currentSide.ieOperationId) {
    classifications.push(CHANGE.OPERATION_REPLACED);
    reasons.push(reason(CHANGE.OPERATION_REPLACED, "STABLE_OPERATION_ID_DIFFERS",
      "This row names a different Industrial Engineering operation than the released bulletin did.",
      {
        releasedIeOperationId: releasedSide.ieOperationId,
        currentIeOperationId: currentSide.ieOperationId,
      }));
  }

  /* ── TIMING ──────────────────────────────────────────────────────────────
     The number, and the evidence behind it. Either moving is a re-timing, and
     the two are reported separately so "same minutes, new study" is not
     mistaken for "nothing happened". */
  const timeMoved = releasedSide.standardTimeMinutes !== currentSide.standardTimeMinutes;
  const studyMoved = releasedSide.methodStudyId !== currentSide.methodStudyId
    || releasedSide.approvedSubmissionId !== currentSide.approvedSubmissionId;
  if (timeMoved || studyMoved) {
    classifications.push(CHANGE.RETIMED);
    reasons.push(reason(CHANGE.RETIMED,
      timeMoved && studyMoved ? "STANDARD_TIME_AND_STUDY_MOVED"
        : timeMoved ? "STANDARD_TIME_MOVED" : "TIMING_EVIDENCE_MOVED",
      timeMoved
        ? "The approved standard time for this row is not the one the release froze."
        : "The standard time is unchanged, but a different study or submission is now the approved "
          + "evidence for it.",
      {
        standardTimeChanged: timeMoved,
        timingEvidenceChanged: studyMoved,
        deltaMinutes: deltaMinutes(
          releasedSide.standardTimeMinutes, currentSide.standardTimeMinutes,
        ),
        releasedMethodStudyId: releasedSide.methodStudyId,
        currentMethodStudyId: currentSide.methodStudyId,
        releasedApprovedSubmissionId: releasedSide.approvedSubmissionId,
        currentApprovedSubmissionId: currentSide.approvedSubmissionId,
      }));
  }

  /* ── REQUIREMENTS, PER DIMENSION ─────────────────────────────────────────
     `REQUIREMENT_CHANGED` names exactly which comparable dimensions moved, and
     lists the ones that could not be compared beside them. A dimension neither
     side froze is never reported as unchanged. */
  const movement = requirementMovement(released.requirementSnapshot, current.requirementSnapshot);
  if (movement.changed) {
    classifications.push(CHANGE.REQUIREMENT_CHANGED);
    reasons.push(reason(CHANGE.REQUIREMENT_CHANGED, "REQUIREMENT_EVIDENCE_MOVED",
      movement.moved.length
        ? `The frozen ${movement.moved.map((d) => d.toLowerCase()).join(" and ")} requirement `
          + "evidence for this row is not the evidence the release froze."
        : "Whether this operation's requirements had been decided at all has changed since the "
          + "release froze it.",
      {
        movedDimensions: movement.moved,
        notComparableDimensions: movement.notComparable,
        perDimension: movement.perDimension,
        configuredChanged: movement.configuredMoved,
        releasedConfigured: releasedSide.requirements.configured,
        currentConfigured: currentSide.requirements.configured,
      }));
  }

  /* ── SEQUENCE ────────────────────────────────────────────────────────────
     The row's own stated sequence, not its index in the array. */
  if (releasedSide.sequence !== currentSide.sequence) {
    classifications.push(CHANGE.RESEQUENCED);
    reasons.push(reason(CHANGE.RESEQUENCED, "SEQUENCE_MOVED",
      "This row sits at a different point in the bulletin than the release froze it at.",
      { releasedSequence: releasedSide.sequence, currentSequence: currentSide.sequence }));
  }

  if (!classifications.length) {
    classifications.push(CHANGE.UNCHANGED);
    reasons.push(labelsChanged
      ? reason(CHANGE.UNCHANGED, "LABEL_ONLY_RENAME",
        "The operation's code or name was edited, but it is the same operation at the same time, "
        + "with the same requirements, in the same place. A rename is not a replacement.",
        {
          releasedOperationCode: releasedSide.operationCode,
          currentOperationCode: currentSide.operationCode,
          releasedOperationName: releasedSide.operationName,
          currentOperationName: currentSide.operationName,
          notComparableDimensions: movement.notComparable,
        })
      : reason(CHANGE.UNCHANGED, "NO_MOVEMENT",
        "Same operation, same approved standard time and evidence, same comparable requirements, "
        + "same sequence.",
        { notComparableDimensions: movement.notComparable }));
  }

  return {
    ...base, classifications, reasons, requirementMovement: movement, labelsChanged,
  };
}

/* ═══ WORK ORDERS — REPORTED, NEVER TOUCHED ════════════════════════════════
 *
 * Read-only and deliberately narrow. The ONLY thing that makes a work order
 * provably affected is its own stored `sampleStyleId` naming this release's
 * style, with the SHARED `styleOwnerFrom` then proving that style belongs to
 * the acting company. Nothing else proves anything: not the order number, not
 * the stock item, not the customer request, not the status, not display text.
 *
 * ── AND EVERY CANDIDATE EXAMINED IS REPORTED ──────────────────────────────
 * A work order reached through a weak link and then found unprovable is
 * REPORTED as unprovable, never dropped. Dropping it would make the answer look
 * complete when it is not, and the audit's "6 of 147" is only meaningful
 * because the other 141 were named rather than hidden.
 */
async function ownershipFor(styleIds) {
  const wanted = [...new Set(styleIds.map(str).filter(isId))];
  if (!wanted.length) return new Map();
  const styles = await SampleStyle
    .find({ _id: { $in: wanted.map((id) => new mongoose.Types.ObjectId(id)) } })
    .select("_id journeyId enquiryId isActive status sourceStockItemId").lean();
  const journeyIds = [...new Set(styles.map((s) => str(s.journeyId)).filter(isId))];
  const enquiryIds = [...new Set(styles.map((s) => str(s.enquiryId)).filter(isId))];
  const [journeys, enquiries] = await Promise.all([
    journeyIds.length
      ? SalesJourney.find({ _id: { $in: journeyIds.map((id) => new mongoose.Types.ObjectId(id)) } })
        .select("_id companyId").lean() : [],
    enquiryIds.length
      ? Enquiry.find({ _id: { $in: enquiryIds.map((id) => new mongoose.Types.ObjectId(id)) } })
        .select("_id companyId").lean() : [],
  ]);
  const jc = new Map(journeys.map((j) => [str(j._id), str(j.companyId)]));
  const ec = new Map(enquiries.map((e) => [str(e._id), str(e.companyId)]));

  const out = new Map();
  for (const style of styles) {
    /* The SHARED rule, in the IE Lane A mode IE Orders already uses: a
       completed or cancelled style still proves ownership, and parentage is
       what is never relaxed. */
    const verdict = styleOwnerFrom(style, {
      journeyCompanyOf: (id) => jc.get(id) || null,
      enquiryCompanyOf: (id) => ec.get(id) || null,
    }, OWNERSHIP_MODE);
    out.set(str(style._id), { ...verdict, style });
  }
  return out;
}

async function workOrderImpact(ctx, release, file) {
  const releaseStyleId = str(release.sampleStyleId);
  const owners = await ownershipFor([releaseStyleId]);
  const releaseStyle = owners.get(releaseStyleId)?.style || null;

  /* ── THE CANDIDATE SET ─────────────────────────────────────────────────
     One provable path and two weak ones. The weak paths exist ONLY so that an
     order somebody might expect to see here is accounted for rather than
     quietly absent; neither of them can make an order provable, and neither of
     them is allowed to make an order IDENTIFIABLE — see below. */
  const or = [{ sampleStyleId: new mongoose.Types.ObjectId(releaseStyleId) }];
  if (isId(file?.openedFromOrderId)) {
    or.push({ _id: new mongoose.Types.ObjectId(str(file.openedFromOrderId)) });
  }
  if (isId(releaseStyle?.sourceStockItemId)) {
    or.push({ stockItemId: new mongoose.Types.ObjectId(str(releaseStyle.sourceStockItemId)) });
  }
  const candidates = await WorkOrder.find({ $or: or })
    .select("_id workOrderNumber sampleStyleId stockItemId status quantity")
    .sort({ _id: 1 })
    .lean();

  const sourceOf = (wo) => {
    if (str(wo.sampleStyleId) === releaseStyleId) return CANDIDATE_SOURCE.DIRECT_STYLE_LINK;
    if (isId(file?.openedFromOrderId) && str(wo._id) === str(file.openedFromOrderId)) {
      return CANDIDATE_SOURCE.STYLE_FILE_PROVENANCE;
    }
    return CANDIDATE_SOURCE.SHARED_STOCK_ITEM;
  };

  /* Ownership for every OTHER style these candidates name — resolved so that a
     tenant decision can be made about each one, never so that it can be
     reported on. */
  const otherStyleIds = candidates
    .map((w) => str(w.sampleStyleId))
    .filter((id) => id && id !== releaseStyleId);
  const otherOwners = await ownershipFor(otherStyleIds);

  const mine = (styleId) => {
    const verdict = styleId === releaseStyleId ? owners.get(releaseStyleId) : otherOwners.get(styleId);
    if (!verdict) return { proved: false, reason: "STYLE_RECORD_MISSING" };
    if (!verdict.companyId) return { proved: false, reason: verdict.reason };
    if (str(verdict.companyId) !== str(ctx.companyId)) {
      return { proved: false, reason: "COMPANY_MISMATCH" };
    }
    return { proved: true, reason: verdict.reason };
  };

  const identity = (wo) => ({
    workOrderId: str(wo._id),
    workOrderRef: str(wo.workOrderNumber),
    status: str(wo.status),
    quantity: num(wo.quantity),
    /* Which bulletin version this order was raised against, when IE knows.
       Absent rather than guessed: Production does not store one today. */
    bulletinVersionNo: num(wo.ieBulletinVersionNo),
  });

  const provablyAffected = [];
  const ownershipUnproven = [];
  /* ── WHAT THE ACTING COMPANY IS NOT TOLD ───────────────────────────────
     A candidate whose linked style is NOT proved to belong to the acting
     company contributes nothing identifiable: no id, no order number, no
     customer, no style, and no count. Hiding only the foreign company id was
     not enough — an order number is itself a tenant's record, and an exact
     count of them is an enumeration oracle: a caller could add one stock item
     at a time and read another company's order volume off the difference.

     So the hidden candidates collapse into ONE boolean. A reader is told the
     sweep was not exhaustive and why; nothing about the records themselves
     survives to the wire. */
  let withheld = false;
  const withheldReasons = new Set();

  for (const wo of candidates) {
    const linked = str(wo.sampleStyleId);

    if (!linked) {
      /* Legacy: no stored style reference at all, so nothing about this order
         can be attributed to any company — least of all to the caller's. */
      withheld = true;
      withheldReasons.add(UNPROVABLE.NO_STYLE_LINK);
      continue;
    }

    const ownership = mine(linked);
    if (!ownership.proved) {
      withheld = true;
      withheldReasons.add(ownership.reason === "STYLE_RECORD_MISSING"
        ? UNPROVABLE.STYLE_NOT_FOUND
        : ownership.reason === "COMPANY_MISMATCH"
          ? UNPROVABLE.COMPANY_MISMATCH
          : UNPROVABLE.OWNERSHIP_UNPROVEN);
      continue;
    }

    /* From here the order's style is PROVED to belong to the acting company,
       so naming the order discloses nothing that is not already theirs. */
    if (linked === releaseStyleId) {
      provablyAffected.push({
        ...identity(wo),
        candidateSource: sourceOf(wo),
        provenBy: { styleLink: "SAMPLE_STYLE_ID", ownership: ownership.reason },
      });
      continue;
    }

    /* The caller's own order, on a different style of theirs — reachable
       through a weak path, actionable, and safe to name. */
    ownershipUnproven.push({
      ...identity(wo),
      candidateSource: sourceOf(wo),
      reasonCode: UNPROVABLE.DIFFERENT_STYLE,
      reasonMessage: "This order belongs to your company but is linked to a different style from "
        + "the one this release covers, so this release does not govern it.",
    });
  }

  return {
    provablyAffected,
    ownershipUnproven,
    /* ── THE AGGREGATE COVERAGE WARNING ──────────────────────────────────
       A boolean and a set of reason codes. Deliberately NO count and no
       identity: the point of the warning is "do not read this list as the
       whole factory", which needs neither. */
    coverage: {
      complete: !withheld,
      withheldForTenantSafety: withheld,
      withheldReasonCodes: [...withheldReasons].sort(),
      message: withheld
        ? "Some work orders reached by product or provenance could not be proved to belong to your "
          + "company, so they are not listed. Link them to a style in Sales to see them here."
        : "",
    },
    /* Said explicitly so a reader never reads this list as an instruction. */
    readOnly: true,
    writesProduction: false,
  };
}

/* ═══ THE ANSWER ═══════════════════════════════════════════════════════════ */

/* ═══ TRI-STATE EVIDENCE ═══════════════════════════════════════════════════
 *
 * `true`, `false` and "not stated" are THREE answers. Collapsing the third into
 * `false` hands out a denial the server never made; collapsing it into `true`
 * hands out a reassurance. Every published boolean below that could be unknown
 * is `null` when it is.
 */

/**
 * Did a digest move?
 *
 * `null` unless BOTH values exist. A digest is opaque: with only one side there
 * is nothing to compare, and answering `true` ("it moved") or `false` ("it did
 * not") would both be inventions. An absent released digest is a legacy record
 * that never carried one; an absent current digest is usually no current
 * bulletin at all.
 */
const digestBlock = (released, current) => {
  const a = str(released) || null;
  const b = str(current) || null;
  return { released: a, current: b, moved: a !== null && b !== null ? a !== b : null };
};

async function readImpact(ctx, { releaseId } = {}) {
  assertContext(ctx);
  if (!isId(releaseId)) throw notFound();

  const release = await IeRelease.findOne({ _id: releaseId, companyId: ctx.companyId }).lean();
  if (!release) throw notFound();

  const file = await IeStyleFile.findOne({
    _id: release.ieStyleFileId, companyId: ctx.companyId,
  }).select("_id currentApprovedBulletinVersionId currentApprovedVersionNo openedFromOrderId").lean();

  /* ── ONE CURRENT BULLETIN, READ ONCE ───────────────────────────────────
     Every current-side fact in this response — the rows, the fingerprint, the
     two digests and the garment SAM — comes from THIS one document. Reading the
     pointer for one fact and the latest-approved for another is how a single
     answer ends up describing two different versions. */
  const current = isId(file?.currentApprovedBulletinVersionId)
    ? await IeBulletinVersion.findOne({
      _id: file.currentApprovedBulletinVersionId,
      companyId: ctx.companyId,
      ieStyleFileId: release.ieStyleFileId,
      state: "APPROVED",
    }).lean()
    : null;

  const src = release.source || {};
  const releasedRows = src.rows || [];
  const currentRows = current ? (current.rows || []) : [];

  const verdict = !current
    ? COMPARISON.NO_CURRENT_APPROVED
    : (String(current._id) === String(src.bulletinVersionId)
      ? COMPARISON.CURRENT
      : COMPARISON.MOVED);

  const rows = pairRows(releasedRows, currentRows).map(comparePair);
  const tally = {};
  for (const row of rows) {
    for (const change of row.classifications) tally[change] = (tally[change] || 0) + 1;
  }
  const unchangedRowCount = rows.filter(
    (r) => r.classifications.length === 1 && r.classifications[0] === CHANGE.UNCHANGED,
  ).length;

  const releasedSam = num(src.garmentSamMinutes);
  const currentSam = current ? num(current.totals?.garmentSamMinutes) : null;

  /* ── THE CAPACITY TARGET, RE-DERIVED ONCE ──────────────────────────────
     The SAME calculator every other IE surface uses — there is deliberately no
     second capacity formula here. The released plan's own frozen assumptions
     are held fixed and only the garment SAM moves, which is what "the same
     plan, against the bulletin as it now stands" means.

     `available` is three-state: `true` when a comparable target was derived,
     `false` when it could not be and the reason is stated, and `null` only
     where the question has not been reached at all. An unknown target is never
     a target of nought. */
  const inputs = src.capacityStandard?.inputs || {};
  const releasedTarget = num(src.capacityStandard?.calculation?.wholePieceDailyTarget);
  /* ── THE THIRD ANSWER, AND WHEN IT IS THE TRUE ONE ─────────────────────
     A release that froze NO capacity standard raises no capacity question at
     all: there is no target to compare and no derivation that failed. Saying
     `false` there would report a failure nobody attempted, and `true` would be
     worse. That is what `null` means on this field, and it is why the field is
     three-state rather than a boolean with a reason beside it. */
  const hasFrozenStandard = Boolean(src.capacityStandard);

  let currentTarget = null;
  let unknownReason = null;
  let unavailableReasons = [];
  if (!hasFrozenStandard) {
    unknownReason = null;
  } else if (!current) {
    unknownReason = CAPACITY_UNKNOWN.NO_CURRENT_APPROVED_BULLETIN;
  } else if ([inputs.availableShiftMinutes, inputs.breakMinutes, inputs.shiftsPerDay,
    inputs.plannedOperatorCount, inputs.targetEfficiencyPercent].some((v) => num(v) === null)) {
    unknownReason = CAPACITY_UNKNOWN.RELEASED_ASSUMPTIONS_INCOMPLETE;
  } else {
    const recomputed = calculateCapacity({
      availableShiftMinutes: inputs.availableShiftMinutes,
      breakMinutes: inputs.breakMinutes,
      shiftsPerDay: inputs.shiftsPerDay,
      plannedOperatorCount: inputs.plannedOperatorCount,
      targetEfficiencyPercent: inputs.targetEfficiencyPercent,
      garmentSamMinutes: currentSam,
    });
    if (recomputed.available) currentTarget = num(recomputed.wholePieceDailyTarget);
    else {
      unknownReason = CAPACITY_UNKNOWN.CURRENT_CAPACITY_UNAVAILABLE;
      unavailableReasons = [...(recomputed.unavailableReasons || [])];
    }
  }
  if (hasFrozenStandard && currentTarget !== null && releasedTarget === null) {
    unknownReason = CAPACITY_UNKNOWN.RELEASED_TARGET_UNAVAILABLE;
  }
  const capacityDelta = deltaWhole(releasedTarget, currentTarget);
  /* Explicitly three-state:
       true  — a comparable target was derived;
       false — it could not be, and `unavailableReason` says why;
       null  — the release raises no capacity question at all.
     Derived from whether a COMPARISON was possible, never from whether one
     number happens to be present. */
  const capacityAvailable = capacityDelta !== null
    ? true
    : (hasFrozenStandard ? false : null);

  const workOrders = await workOrderImpact(ctx, release, file);

  return {
    impact: {
      release: {
        releaseId: String(release._id),
        releaseRef: release.releaseRef,
        versionNo: num(release.versionNo),
        state: release.state,
        issuedAt: iso(release.issuedAt),
        issuedByName: str(release.issuedByName),
        styleFileId: String(release.ieStyleFileId),
        companyId: String(release.companyId),
      },

      /* ── THE COMPARISON, AS A VERDICT ──────────────────────────────────
         One of three words, decided here. Not left to a browser to infer from
         two version numbers: a version number can be equal while the content
         behind it was corrected, and the digests are what say so. */
      bulletin: {
        releasedBulletinVersionId: src.bulletinVersionId ? String(src.bulletinVersionId) : null,
        releasedVersionNo: num(src.bulletinVersionNo),
        currentBulletinVersionId: current ? String(current._id) : null,
        currentVersionNo: current ? num(current.versionNo) : null,
        verdict,
        /* `null`, not `false`, with no current bulletin: "it did not move" and
           "there is nothing to have moved to" are different facts, and only one
           of them is a reassurance. */
        moved: verdict === COMPARISON.NO_CURRENT_APPROVED ? null : verdict === COMPARISON.MOVED,
        sourceFingerprint: digestBlock(
          src.sourceFingerprint, current ? current.sourceFingerprint : null,
        ),
        approvalDigest: digestBlock(
          src.sourceApprovalDigest, current ? current.sourceApprovalDigest : null,
        ),
        requirementDigest: digestBlock(
          src.sourceRequirementDigest, current ? current.sourceRequirementDigest : null,
        ),
      },

      garmentSam: {
        released: releasedSam,
        current: currentSam,
        delta: deltaMinutes(releasedSam, currentSam),
        unit: "min",
        rounding: "HALF_UP_4DP",
      },

      capacity: {
        released: releasedTarget,
        current: currentTarget,
        delta: capacityDelta,
        unit: "pcs/day",
        wholePiecePolicy: "FLOOR",
        available: capacityAvailable,
        unavailableReason: unknownReason || "",
        /* A sentence somebody can act on, not a code to look up. */
        unavailableMessage: unknownReason ? CAPACITY_MESSAGE[unknownReason] : "",
        unavailableReasons,
        /* Said out loud: only the SAM moved. The shift, break, manpower and
           efficiency assumptions are the release's own, held fixed. */
        basis: "RELEASED_ASSUMPTIONS_WITH_CURRENT_GARMENT_SAM",
        assumptionsFrom: "RELEASED_CAPACITY_STANDARD",
      },

      /* Which requirement dimensions this response could compare at all. Row
         level says it per row; this says it once, for a banner. */
      requirementCoverage: {
        dimensions: [...DIMENSIONS],
        comparedOnAtLeastOneRow: DIMENSIONS.filter((d) => rows.some(
          (r) => r.requirementMovement?.perDimension?.[d]
            && r.requirementMovement.perDimension[d] !== DIMENSION_COMPARISON.NOT_COMPARABLE,
        )),
        notComparableOnAtLeastOneRow: DIMENSIONS.filter((d) => rows.some(
          (r) => r.requirementMovement?.perDimension?.[d] === DIMENSION_COMPARISON.NOT_COMPARABLE,
        )),
        reason: "A bulletin version frozen before attachment and labour evidence was captured "
          + "cannot be compared on those dimensions, and nothing is backfilled onto it.",
      },

      rows,
      changeVocabulary: Object.values(CHANGE),

      workOrders,

      /* ── THE SERVER'S OWN COUNTS ───────────────────────────────────────
         Published rather than left to the browser: a count computed there
         becomes "how many rows this page happens to hold", which is a different
         number the moment anything is paginated or filtered. */
      summary: {
        totalRowCount: rows.length,
        changedRowCount: rows.length - unchangedRowCount,
        unchangedRowCount,
        affectedWorkOrderCount: workOrders.provablyAffected.length,
        /* The DISCLOSED unproven rows only — every one of which belongs to the
           acting company. Withheld candidates are never counted; see
           `workOrders.coverage`. */
        unprovenWorkOrderCount: workOrders.ownershipUnproven.length,
        rowTally: tally,
      },

      /* Computed on demand and kept nowhere — stated on the wire so nothing
         built against this treats it as a stored record with a freshness. */
      computedAt: new Date().toISOString(),
      stored: false,
      acknowledges: false,
      booksCapacity: false,
      writesProduction: false,
    },
  };
}

module.exports = {
  CHANGE, COMPARISON, UNPROVABLE, CANDIDATE_SOURCE, CAPACITY_UNKNOWN, CAPACITY_MESSAGE,
  DIMENSIONS, DIMENSION_STATE, DIMENSION_COMPARISON,
  pairRows, comparePair, side, requirementEvidence, compareDimension, requirementMovement,
  digestBlock, deltaMinutes, deltaWhole, ownershipFor, workOrderImpact,
  readImpact,
};
