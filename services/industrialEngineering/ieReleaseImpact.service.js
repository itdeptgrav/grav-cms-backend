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
  SAME_APPROVED_BULLETIN: "SAME_APPROVED_BULLETIN",
  APPROVED_BULLETIN_MOVED: "APPROVED_BULLETIN_MOVED",
  NO_CURRENT_APPROVED_BULLETIN: "NO_CURRENT_APPROVED_BULLETIN",
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

/* ═══ REQUIREMENT EVIDENCE ═════════════════════════════════════════════════
 *
 * ── WHAT IS ACTUALLY FROZEN, AND WHAT IS NOT ──────────────────────────────
 * Chunk 5A models three requirement dimensions on an operation — machine,
 * attachment and labour — but the bulletin row freezes only the MACHINE half
 * (`IeBulletinVersion.rows[].requirementSnapshot.machineTypes`, and the style
 * file's draft row before it). Attachment and labour requirements were never
 * captured into a bulletin version, so neither the released side nor the
 * current side holds them.
 *
 * They are therefore published as `NOT_CAPTURED` on BOTH sides and compared as
 * `UNKNOWN`. Reading them live from the operation library would re-answer an
 * issued handover with today's configuration; reporting them as `[]` would say
 * "this operation needs no attachment", which is a claim nobody made. An
 * unknown stays an unknown, and the gap names the contract that would close it.
 */
const REQUIREMENT_DIMENSION = Object.freeze({
  CAPTURED: "CAPTURED",
  NOT_CAPTURED: "NOT_CAPTURED",
});

const machineEvidence = (snapshot) => (snapshot ? {
  state: REQUIREMENT_DIMENSION.CAPTURED,
  capturedAt: iso(snapshot.capturedAt),
  ieOperationRevision: snapshot.ieOperationRevision ?? null,
  requirementsConfigured: Boolean(snapshot.requirementsConfigured),
  machineTypes: (snapshot.machineTypes || [])
    .map((m) => ({ machineType: str(m.machineType), quantity: num(m.quantity) })),
} : {
  state: REQUIREMENT_DIMENSION.NOT_CAPTURED,
  capturedAt: null,
  ieOperationRevision: null,
  requirementsConfigured: false,
  machineTypes: [],
});

const uncapturedDimension = (dimension) => ({
  state: REQUIREMENT_DIMENSION.NOT_CAPTURED,
  dimension,
  items: [],
  /* Said plainly, because an empty list is otherwise read as a requirement of
     nothing — and that is a claim this chunk has no evidence for. */
  note: "No bulletin version has ever frozen this requirement dimension, so neither the "
    + "released nor the current side holds it and the two cannot be compared.",
});

const requirementEvidence = (snapshot) => ({
  machine: machineEvidence(snapshot),
  attachment: uncapturedDimension("ATTACHMENT"),
  labour: uncapturedDimension("LABOUR"),
});

/* Order-independent equality over the machine multiset: a plan needing two SNLS
   and one OL4 is the same plan whichever order the pair was typed in. */
const machineKey = (evidence) => (evidence.machineTypes || [])
  .map((m) => `${m.machineType}:${m.quantity}`)
  .sort()
  .join("|");

function machineRequirementMoved(before, after) {
  if (before.state !== after.state) return true;
  if (before.state === REQUIREMENT_DIMENSION.NOT_CAPTURED) return false;
  if (before.requirementsConfigured !== after.requirementsConfigured) return true;
  return machineKey(before) !== machineKey(after);
}

/* ═══ ROW IDENTITY AND EVIDENCE ════════════════════════════════════════════ */

const rowIdentity = (r) => (r ? {
  rowId: str(r.rowId),
  sequence: num(r.sequence),
  ieOperationId: r.ieOperationId ? String(r.ieOperationId) : null,
  ieOperationRevision: num(r.ieOperationRevision),
  operationCode: str(r.operationCode),
  operationName: str(r.operationName),
  machineType: str(r.machineType),
} : null);

/* Both timing identities, named on every row rather than only on a changed one:
   a reader asking "which study produced this number" must not have to infer it
   from whether anything moved. */
const timingEvidence = (r) => (r ? {
  standardTimeMinutes: num(r.standardTimeMinutes),
  standardTimeSource: str(r.standardTimeSource),
  methodStudyId: r.methodStudyId ? String(r.methodStudyId) : null,
  approvedSubmissionId: str(r.approvedSubmissionId),
  approvedAt: iso(r.approvedAt),
} : null);

const reason = (change, code, message, extra = {}) => ({ change, code, message, ...extra });

/* ═══ THE ROW COMPARISON ═══════════════════════════════════════════════════ */

/**
 * Pair the released rows with the current ones by stable identity.
 *
 * `rowId` first, because a bulletin row keeps its id across every version of
 * the file it belongs to. Only where that fails does `ieOperationId` get a
 * turn, and only when it matches EXACTLY ONE unclaimed current row — two
 * candidates is an ambiguity, and guessing between them would invent a history
 * the records do not support, so both sides are reported as REMOVED and ADDED.
 */
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
  const releasedEvidence = {
    identity: rowIdentity(released),
    timing: timingEvidence(released),
    requirements: released ? requirementEvidence(released.requirementSnapshot) : null,
  };
  const currentEvidence = {
    identity: rowIdentity(current),
    timing: timingEvidence(current),
    requirements: current ? requirementEvidence(current.requirementSnapshot) : null,
  };
  const base = { matchedBy, released: releasedEvidence, current: currentEvidence };

  if (!current) {
    return {
      ...base,
      changes: [CHANGE.REMOVED],
      reasons: [reason(CHANGE.REMOVED, "NO_MATCHING_CURRENT_ROW",
        "No row in the current approved bulletin carries this row id, and no single current row "
        + "carries this operation either.")],
    };
  }
  if (!released) {
    return {
      ...base,
      changes: [CHANGE.ADDED],
      reasons: [reason(CHANGE.ADDED, "NOT_IN_RELEASED_BULLETIN",
        "The current approved bulletin carries this row and the released one did not.")],
    };
  }

  const changes = [];
  const reasons = [];

  /* ── THE OPERATION ITSELF ────────────────────────────────────────────────
     By stable id ONLY. A renamed or re-coded operation is the SAME operation
     and must never read as a replacement — the codes and names travel as
     evidence on both sides so a reader can see the rename for what it is. */
  const releasedOp = releasedEvidence.identity.ieOperationId;
  const currentOp = currentEvidence.identity.ieOperationId;
  const labelsMoved = releasedEvidence.identity.operationCode !== currentEvidence.identity.operationCode
    || releasedEvidence.identity.operationName !== currentEvidence.identity.operationName;

  if (releasedOp !== currentOp) {
    changes.push(CHANGE.OPERATION_REPLACED);
    reasons.push(reason(CHANGE.OPERATION_REPLACED, "STABLE_OPERATION_ID_DIFFERS",
      "This row names a different Industrial Engineering operation than the released bulletin did.",
      { releasedIeOperationId: releasedOp, currentIeOperationId: currentOp }));
  }

  /* ── TIMING ──────────────────────────────────────────────────────────────
     The number, and the evidence behind it. Either moving is a re-timing, and
     the two are reported separately so "same minutes, new study" is not
     mistaken for "nothing happened". */
  const timeMoved = releasedEvidence.timing.standardTimeMinutes !== currentEvidence.timing.standardTimeMinutes;
  const studyMoved = releasedEvidence.timing.methodStudyId !== currentEvidence.timing.methodStudyId
    || releasedEvidence.timing.approvedSubmissionId !== currentEvidence.timing.approvedSubmissionId;
  if (timeMoved || studyMoved) {
    changes.push(CHANGE.RETIMED);
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
          releasedEvidence.timing.standardTimeMinutes, currentEvidence.timing.standardTimeMinutes,
        ),
        releasedMethodStudyId: releasedEvidence.timing.methodStudyId,
        currentMethodStudyId: currentEvidence.timing.methodStudyId,
        releasedApprovedSubmissionId: releasedEvidence.timing.approvedSubmissionId,
        currentApprovedSubmissionId: currentEvidence.timing.approvedSubmissionId,
      }));
  }

  /* ── REQUIREMENTS ────────────────────────────────────────────────────────
     Machine only, because machine is the only dimension either side froze.
     Attachment and labour are `NOT_CAPTURED` on both and are never claimed to
     have changed OR to have stayed the same. */
  if (machineRequirementMoved(releasedEvidence.requirements.machine, currentEvidence.requirements.machine)) {
    changes.push(CHANGE.REQUIREMENT_CHANGED);
    reasons.push(reason(CHANGE.REQUIREMENT_CHANGED, "MACHINE_REQUIREMENT_EVIDENCE_MOVED",
      "The frozen machine requirement evidence for this row is not the evidence the release froze.",
      {
        dimension: "MACHINE",
        releasedMachineTypes: releasedEvidence.requirements.machine.machineTypes,
        currentMachineTypes: currentEvidence.requirements.machine.machineTypes,
        releasedRequirementsConfigured: releasedEvidence.requirements.machine.requirementsConfigured,
        currentRequirementsConfigured: currentEvidence.requirements.machine.requirementsConfigured,
        uncomparedDimensions: ["ATTACHMENT", "LABOUR"],
      }));
  }

  /* ── SEQUENCE ────────────────────────────────────────────────────────────
     The row's own stated sequence, not its index in the array. */
  if (releasedEvidence.identity.sequence !== currentEvidence.identity.sequence) {
    changes.push(CHANGE.RESEQUENCED);
    reasons.push(reason(CHANGE.RESEQUENCED, "SEQUENCE_MOVED",
      "This row sits at a different point in the bulletin than the release froze it at.",
      {
        releasedSequence: releasedEvidence.identity.sequence,
        currentSequence: currentEvidence.identity.sequence,
      }));
  }

  if (!changes.length) {
    changes.push(CHANGE.UNCHANGED);
    reasons.push(labelsMoved
      ? reason(CHANGE.UNCHANGED, "LABEL_ONLY_RENAME",
        "The operation's code or name was edited, but it is the same operation at the same time, "
        + "with the same requirements, in the same place. A rename is not a replacement.",
        {
          releasedOperationCode: releasedEvidence.identity.operationCode,
          currentOperationCode: currentEvidence.identity.operationCode,
          releasedOperationName: releasedEvidence.identity.operationName,
          currentOperationName: currentEvidence.identity.operationName,
        })
      : reason(CHANGE.UNCHANGED, "NO_MOVEMENT",
        "Same operation, same approved standard time and evidence, same frozen machine "
        + "requirements, same sequence."));
  }

  return { ...base, changes, reasons, labelsChanged: labelsMoved };
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
     One provable path and two weak ones. The weak paths exist ONLY so that the
     orders somebody might expect to see here are named and refused rather than
     quietly absent; neither of them can make an order provable. */
    const or = [{ sampleStyleId: new mongoose.Types.ObjectId(releaseStyleId) }];
  if (isId(file?.openedFromOrderId)) {
    or.push({ _id: new mongoose.Types.ObjectId(str(file.openedFromOrderId)) });
  }
  if (isId(releaseStyle?.sourceStockItemId)) {
    or.push({ stockItemId: new mongoose.Types.ObjectId(str(releaseStyle.sourceStockItemId)) });
  }
  const candidates = await WorkOrder.find({ $or: or })
    .select("_id workOrderNumber sampleStyleId stockItemId status")
    .sort({ _id: 1 })
    .lean();

  const sourceOf = (wo) => {
    if (str(wo.sampleStyleId) === releaseStyleId) return CANDIDATE_SOURCE.DIRECT_STYLE_LINK;
    if (isId(file?.openedFromOrderId) && str(wo._id) === str(file.openedFromOrderId)) {
      return CANDIDATE_SOURCE.STYLE_FILE_PROVENANCE;
    }
    return CANDIDATE_SOURCE.SHARED_STOCK_ITEM;
  };

  /* Ownership for every OTHER style these candidates name, so a foreign or
     parentless style is answered with its own reason rather than a shrug. */
  const otherStyleIds = candidates.map((w) => str(w.sampleStyleId)).filter((id) => id && id !== releaseStyleId);
  const otherOwners = await ownershipFor(otherStyleIds);

  const affected = [];
  const unprovable = [];

  for (const wo of candidates) {
    const head = {
      workOrderId: str(wo._id),
      workOrderNumber: str(wo.workOrderNumber),
      candidateSource: sourceOf(wo),
    };
    const linked = str(wo.sampleStyleId);

    if (!linked) {
      unprovable.push({
        ...head, reason: UNPROVABLE.NO_STYLE_LINK, ownershipReason: null,
        message: "This work order stores no style reference, so nothing links it to this release. "
          + "Its product or order number may look right; neither is proof.",
      });
      continue;
    }
    if (linked !== releaseStyleId) {
      /* Resolved so the reason is specific, but NOTHING about the other
         company or the other style leaves — not its id, not its owner. */
      const other = otherOwners.get(linked);
      unprovable.push({
        ...head,
        reason: other ? UNPROVABLE.DIFFERENT_STYLE : UNPROVABLE.STYLE_NOT_FOUND,
        ownershipReason: other ? other.reason : "STYLE_RECORD_MISSING",
        message: other
          ? "This work order is linked to a different style from the one this release covers."
          : "This work order names a style record that no longer exists, so nothing about it can "
            + "be proved either way.",
      });
      continue;
    }

    const verdict = owners.get(releaseStyleId);
    if (!verdict) {
      unprovable.push({
        ...head, reason: UNPROVABLE.STYLE_NOT_FOUND, ownershipReason: "STYLE_RECORD_MISSING",
        message: "The style this release covers no longer exists as a record, so ownership cannot "
          + "be proved.",
      });
      continue;
    }
    if (!verdict.companyId) {
      unprovable.push({
        ...head, reason: UNPROVABLE.OWNERSHIP_UNPROVEN, ownershipReason: verdict.reason,
        message: "The company that owns this order's style cannot be proved from its sales "
          + "records. Correct the style's journey or enquiry in Sales.",
      });
      continue;
    }
    if (str(verdict.companyId) !== str(ctx.companyId)) {
      unprovable.push({
        ...head, reason: UNPROVABLE.COMPANY_MISMATCH, ownershipReason: verdict.reason,
        message: "This order's style belongs to a different company from the one you are working "
          + "in.",
      });
      continue;
    }

    affected.push({
      ...head,
      status: str(wo.status),
      /* Both halves of the proof, stated rather than implied. */
      provenBy: { styleLink: "SAMPLE_STYLE_ID", ownership: verdict.reason },
    });
  }

  return {
    examinedCount: candidates.length,
    affected,
    unprovable,
    /* Said explicitly so a reader never reads this list as an instruction. */
    readOnly: true,
    writesProduction: false,
  };
}

/* ═══ THE ANSWER ═══════════════════════════════════════════════════════════ */

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

  const comparisonState = !current
    ? COMPARISON.NO_CURRENT_APPROVED_BULLETIN
    : (String(current._id) === String(src.bulletinVersionId)
      ? COMPARISON.SAME_APPROVED_BULLETIN
      : COMPARISON.APPROVED_BULLETIN_MOVED);

  const rows = pairRows(releasedRows, currentRows).map(comparePair);
  const tally = {};
  for (const row of rows) for (const change of row.changes) tally[change] = (tally[change] || 0) + 1;

  /* ── THE TWO DIGESTS, SEPARATELY ───────────────────────────────────────
     They answer different questions — "did an approval move" and "did a
     requirement move" — and a single "something changed" flag would send a
     reader to the wrong department half the time. */
  const releasedApprovalDigest = str(src.sourceApprovalDigest);
  const currentApprovalDigest = current ? str(current.sourceApprovalDigest) : null;
  const releasedRequirementDigest = str(src.sourceRequirementDigest);
  const currentRequirementDigest = current ? str(current.sourceRequirementDigest) : null;

  const releasedSam = num(src.garmentSamMinutes);
  const currentSam = current ? num(current.totals?.garmentSamMinutes) : null;

  /* ── THE CAPACITY TARGET, RE-DERIVED ONCE ──────────────────────────────
     The SAME calculator every other IE surface uses — there is deliberately no
     second capacity formula here. The released plan's own frozen assumptions
     are held fixed and only the garment SAM moves, which is what "the same
     plan, against the bulletin as it now stands" means.

     Null plus a typed reason whenever that cannot be done honestly. An unknown
     target is never a target of nought. */
  const inputs = src.capacityStandard?.inputs || {};
  const releasedTarget = num(src.capacityStandard?.calculation?.wholePieceDailyTarget);

  let currentTarget = null;
  let capacityUnknownReason = null;
  let capacityUnavailableReasons = [];
  if (!current) {
    capacityUnknownReason = CAPACITY_UNKNOWN.NO_CURRENT_APPROVED_BULLETIN;
  } else if ([inputs.availableShiftMinutes, inputs.breakMinutes, inputs.shiftsPerDay,
    inputs.plannedOperatorCount, inputs.targetEfficiencyPercent].some((v) => num(v) === null)) {
    capacityUnknownReason = CAPACITY_UNKNOWN.RELEASED_ASSUMPTIONS_INCOMPLETE;
  } else {
    const recomputed = calculateCapacity({
      availableShiftMinutes: inputs.availableShiftMinutes,
      breakMinutes: inputs.breakMinutes,
      shiftsPerDay: inputs.shiftsPerDay,
      plannedOperatorCount: inputs.plannedOperatorCount,
      targetEfficiencyPercent: inputs.targetEfficiencyPercent,
      garmentSamMinutes: currentSam,
    });
    if (recomputed.available) {
      currentTarget = num(recomputed.wholePieceDailyTarget);
    } else {
      capacityUnknownReason = CAPACITY_UNKNOWN.CURRENT_CAPACITY_UNAVAILABLE;
      capacityUnavailableReasons = [...(recomputed.unavailableReasons || [])];
    }
  }
  if (currentTarget !== null && releasedTarget === null) {
    capacityUnknownReason = CAPACITY_UNKNOWN.RELEASED_TARGET_UNAVAILABLE;
  }

  const workOrders = await workOrderImpact(ctx, release, file);

  return {
    impact: {
      release: {
        releaseId: String(release._id),
        releaseRef: release.releaseRef,
        versionNo: release.versionNo,
        state: release.state,
        issuedAt: iso(release.issuedAt),
        styleFileId: String(release.ieStyleFileId),
      },

      comparison: {
        state: comparisonState,
        releasedBulletin: {
          bulletinVersionId: src.bulletinVersionId ? String(src.bulletinVersionId) : null,
          versionNo: num(src.bulletinVersionNo),
          sourceFingerprint: str(src.sourceFingerprint),
        },
        currentBulletin: current ? {
          bulletinVersionId: String(current._id),
          versionNo: num(current.versionNo),
          sourceFingerprint: str(current.sourceFingerprint),
        } : null,
        /* The verdict in one word, beside the evidence for it. */
        moved: comparisonState === COMPARISON.APPROVED_BULLETIN_MOVED,
        sourceFingerprintChanged: current
          ? str(src.sourceFingerprint) !== str(current.sourceFingerprint) : null,
      },

      digests: {
        approval: {
          released: releasedApprovalDigest || null,
          current: currentApprovalDigest || null,
          approvalDigestChanged: current ? releasedApprovalDigest !== currentApprovalDigest : null,
        },
        requirement: {
          released: releasedRequirementDigest || null,
          current: currentRequirementDigest || null,
          requirementDigestChanged: current
            ? releasedRequirementDigest !== currentRequirementDigest : null,
        },
      },

      garmentSam: {
        released: releasedSam,
        current: currentSam,
        deltaMinutes: deltaMinutes(releasedSam, currentSam),
        unit: "MINUTES",
        rounding: "HALF_UP_4DP",
      },

      capacity: {
        released: releasedTarget,
        current: currentTarget,
        delta: deltaWhole(releasedTarget, currentTarget),
        unit: "WHOLE_PIECES_PER_DAY",
        wholePiecePolicy: "FLOOR",
        /* Null when it is known. Never a zero standing in for an unknown. */
        unknownReason: currentTarget === null || releasedTarget === null
          ? capacityUnknownReason : null,
        unavailableReasons: capacityUnavailableReasons,
        /* Said out loud: only the SAM moved. The shift, break, manpower and
           efficiency assumptions are the release's own, held fixed. */
        basis: "RELEASED_ASSUMPTIONS_WITH_CURRENT_GARMENT_SAM",
        assumptionsFrom: "RELEASED_CAPACITY_STANDARD",
      },

      /* Chunk 5A models three requirement dimensions; a bulletin version has
         only ever frozen the machine half, so the other two are stated as
         uncompared rather than silently reported as unchanged. */
      requirementCoverage: {
        compared: ["MACHINE"],
        uncompared: ["ATTACHMENT", "LABOUR"],
        reason: "NOT_FROZEN_BY_ANY_BULLETIN_VERSION",
        requiredUpstreamContract: "BULLETIN_ROW_ATTACHMENT_AND_LABOUR_REQUIREMENT_SNAPSHOT",
      },

      rows,
      rowTally: tally,
      changeVocabulary: Object.values(CHANGE),

      workOrders,

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
  CHANGE, COMPARISON, UNPROVABLE, CANDIDATE_SOURCE, CAPACITY_UNKNOWN, REQUIREMENT_DIMENSION,
  pairRows, comparePair, requirementEvidence, machineRequirementMoved,
  deltaMinutes, deltaWhole, ownershipFor, workOrderImpact,
  readImpact,
};
