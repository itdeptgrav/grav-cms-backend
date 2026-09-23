// services/industrialEngineering/approvedStandard.service.js
//
// WHICH OPERATION STANDARD IE HAS ACTUALLY APPROVED FOR A STYLE — READ, NEVER GUESSED.
//
// ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
// IE Orders derived a style's operation count, its SAM and its readiness only
// from the two LEGACY route sources: R&D's technical route and the product's
// route. Neither knows the approved Operation Bulletin Version exists. So a
// style with a seven-operation, 6.25-minute bulletin — approved by two people
// and already part of an issued release — read "0 operations", "SAM not
// recorded" and NO_ROUTE_RECORDED, because R&D's own route happened to be
// empty. The department's own signed-off standard was invisible on the
// department's own worklist.
//
// ── ONE PATH TO THE ANSWER, AND ONLY ONE ────────────────────────────────────
// The style's company-scoped engineering file, then that file's
// `currentApprovedBulletinVersionId`, then EXACTLY that version. Nothing else
// is consulted, because everything else is a way of being wrong:
//
//   · the file's embedded draft bulletin is a working copy nobody approved;
//   · an IN_REVIEW, RETURNED or SUPERSEDED version is not the standard;
//   · an APPROVED version the file does not point at has been superseded, even
//     if its own state was never moved — "the latest approved" is a query, and
//     the pointer is a decision two people took;
//   · a file or version from another company, or belonging to another style or
//     file, is not this style's evidence however it was reached;
//   · and no identifier a caller supplied is trusted — this reads only ids the
//     server itself stored.
//
// ── EVERY LINK IS PROVED, NOT ASSUMED ───────────────────────────────────────
// Company, style, file id, version id, version number and APPROVED state must
// all agree. A version that fails any one of them is reported with the exact
// reason it failed — never quietly treated as absent, and never promoted.
//
// ── TWO QUERIES FOR A WHOLE PAGE ────────────────────────────────────────────
// Batched across every style on the page: one read of engineering files, one
// read of bulletin versions. `{companyId, sampleStyleId}` is unique on
// `ie_style_files`, so a style has at most one file and the first query is
// exact rather than a guess among several. No per-style reads.
//
// Read-only. Nothing here writes anything.
"use strict";

const mongoose = require("mongoose");

const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const IeBulletinVersion = require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");
const { toUnits, unitsToMinutes } = require("./capacityCalculation");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));
const iso = (d) => (d ? new Date(d).toISOString() : null);
/* `Number(null)` is 0 and finite — an absence must never become a zero. */
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Where a style's approved standard stands. Exactly one of these, always.
 *
 * Every state but `APPROVED_CURRENT` is a reason the style has NO approved IE
 * standard, named so a reader knows which link broke rather than being told
 * only that something is missing.
 */
const STANDARD_STATE = Object.freeze({
  /* Every link proved: this is the approved IE operation standard. */
  APPROVED_CURRENT: "APPROVED_CURRENT",
  /* IE has not opened an engineering file for this style in this company. */
  NO_ENGINEERING_FILE: "NO_ENGINEERING_FILE",
  /* A file exists and names no approved version — nothing has been approved,
     or a submission is still in review or was returned. */
  NO_APPROVED_VERSION: "NO_APPROVED_VERSION",
  /* The file names a version this company does not hold — deleted, or another
     company's. Reported, never followed. */
  POINTER_UNRESOLVED: "POINTER_UNRESOLVED",
  /* The version exists but belongs to another file, or its number disagrees
     with the number the file recorded beside the pointer. */
  POINTER_MISMATCH: "POINTER_MISMATCH",
  /* The pointed version is not APPROVED — in review, returned or superseded. */
  VERSION_NOT_APPROVED: "VERSION_NOT_APPROVED",
});

/** Where the headline figures on a style row came from. Stated, never implied. */
const STANDARD_SOURCE = Object.freeze({
  APPROVED_BULLETIN_VERSION: "APPROVED_BULLETIN_VERSION",
  LEGACY_TECHNICAL_ROUTE: "LEGACY_TECHNICAL_ROUTE",
  NONE: "NONE",
});

const MESSAGE = Object.freeze({
  NO_ENGINEERING_FILE:
    "Industrial Engineering has not opened an engineering file for this style, so there is no "
    + "approved operation standard for it yet.",
  NO_APPROVED_VERSION:
    "This style's engineering file has no approved bulletin version. A submission may be in review "
    + "or returned; the working draft is not a standard until it is approved.",
  POINTER_UNRESOLVED:
    "This style's engineering file names an approved bulletin version that cannot be found in your "
    + "company, so it cannot be treated as the standard.",
  POINTER_MISMATCH:
    "This style's engineering file names a bulletin version that does not belong to it, or whose "
    + "number disagrees with the file's record, so it cannot be treated as the standard.",
  VERSION_NOT_APPROVED:
    "The bulletin version this style's engineering file names is not approved, so it cannot be "
    + "treated as the standard.",
});

const GAP_OWNER_IE = "INDUSTRIAL_ENGINEERING";

/** An unavailable standard: every figure a stated absence, the reason named. */
function unavailable(state, { styleFileId = null, pointer = null } = {}) {
  return {
    state,
    available: false,
    styleFileId,
    bulletinVersionId: null,
    versionNo: null,
    approvalState: null,
    pointer,
    /* Nulls, never zeroes: "no approved standard" is not "a standard of 0
       operations and 0 minutes". */
    operationCount: null,
    garmentSamMinutes: null,
    samRowCount: null,
    digests: null,
    approvedAt: null,
    approvedByName: null,
    gaps: [{
      code: `IE_STANDARD_${state}`,
      owner: GAP_OWNER_IE,
      action: state === STANDARD_STATE.NO_ENGINEERING_FILE
        ? "OPEN_ENGINEERING_FILE" : "APPROVE_BULLETIN_VERSION",
      message: MESSAGE[state],
    }],
  };
}

/**
 * The approved IE operation standard for each style, company-scoped.
 *
 * @param {string} companyId  the ACTING company — never a caller-named one
 * @param {string[]} styleIds  styles already proved to belong to that company
 * @returns {Promise<Map<string, object>>}  styleId → standard, one per style
 */
async function approvedStandardsFor(companyId, styleIds) {
  const out = new Map();
  const wanted = [...new Set((styleIds || []).map(str).filter(isId))];
  if (!wanted.length || !isId(companyId)) return out;

  /* ── QUERY 1 OF 2: THE FILES ──────────────────────────────────────────
     Company-scoped in the query itself, so another company's file is never
     loaded and there is nothing to forget to filter afterwards. */
  const files = await IeStyleFile.find({
    companyId: oid(companyId),
    sampleStyleId: { $in: wanted.map(oid) },
  }).select("_id companyId sampleStyleId currentApprovedBulletinVersionId currentApprovedVersionNo")
    .lean();
  const fileByStyle = new Map(files.map((f) => [str(f.sampleStyleId), f]));

  /* ── QUERY 2 OF 2: ONLY THE VERSIONS THE FILES POINT AT ───────────────
     Not "the latest approved version of each file". The pointer is the
     decision; a newer query result is not. Company-scoped again, so a pointer
     that names another company's version resolves to nothing. `rows.rowId` is
     projected alone because the operation count is all this needs from the
     rows, and a whole bulletin per style is not a price the list should pay. */
  const pointers = files
    .map((f) => str(f.currentApprovedBulletinVersionId))
    .filter(isId);
  const versions = pointers.length
    ? await IeBulletinVersion.find({
      _id: { $in: pointers.map(oid) },
      companyId: oid(companyId),
    }).select([
      "_id companyId ieStyleFileId versionNo state totals",
      "sourceFingerprint sourceApprovalDigest sourceRequirementDigest",
      "approvedAt approvedByName rows.rowId",
    ].join(" ")).lean()
    : [];
  const versionById = new Map(versions.map((v) => [str(v._id), v]));

  for (const styleId of wanted) {
    const file = fileByStyle.get(styleId);
    if (!file) {
      out.set(styleId, unavailable(STANDARD_STATE.NO_ENGINEERING_FILE));
      continue;
    }
    const styleFileId = str(file._id);
    const pointerId = str(file.currentApprovedBulletinVersionId);
    const pointer = {
      currentApprovedBulletinVersionId: pointerId || null,
      currentApprovedVersionNo: num(file.currentApprovedVersionNo),
      /* Filled in below once the version is read. `null` until proved. */
      matches: null,
    };

    if (!isId(pointerId)) {
      out.set(styleId, unavailable(STANDARD_STATE.NO_APPROVED_VERSION, { styleFileId, pointer }));
      continue;
    }

    const version = versionById.get(pointerId);
    if (!version) {
      out.set(styleId, unavailable(STANDARD_STATE.POINTER_UNRESOLVED, {
        styleFileId, pointer: { ...pointer, matches: false },
      }));
      continue;
    }

    /* ── EVERY LINK, PROVED ─────────────────────────────────────────────
       Company is already in both queries. What remains is that the version
       belongs to THIS file and carries the number the file recorded beside the
       pointer — a version reached by id but owned by another file is another
       style's standard, however it came to be named here. */
    const sameFile = str(version.ieStyleFileId) === styleFileId;
    const sameNumber = num(version.versionNo) !== null
      && num(version.versionNo) === num(file.currentApprovedVersionNo);
    const sameCompany = str(version.companyId) === str(companyId)
      && str(file.companyId) === str(companyId);
    if (!sameFile || !sameNumber || !sameCompany) {
      out.set(styleId, unavailable(STANDARD_STATE.POINTER_MISMATCH, {
        styleFileId, pointer: { ...pointer, matches: false },
      }));
      continue;
    }

    if (str(version.state) !== "APPROVED") {
      out.set(styleId, {
        ...unavailable(STANDARD_STATE.VERSION_NOT_APPROVED, {
          styleFileId, pointer: { ...pointer, matches: true },
        }),
        /* The version IS the pointed one; it is just not approved. Its state is
           published so a reader knows which of the three it is. */
        approvalState: str(version.state),
      });
      continue;
    }

    const rows = Array.isArray(version.rows) ? version.rows : [];
    out.set(styleId, {
      state: STANDARD_STATE.APPROVED_CURRENT,
      available: true,
      styleFileId,
      bulletinVersionId: str(version._id),
      versionNo: num(version.versionNo),
      approvalState: "APPROVED",
      pointer: { ...pointer, matches: true },
      operationCount: rows.length,
      garmentSamMinutes: num(version.totals?.garmentSamMinutes),
      samRowCount: num(version.totals?.samRowCount),
      /* The three the bulletin-version read already publishes, under the names
         it publishes them — not a second spelling. */
      digests: {
        fingerprint: str(version.sourceFingerprint) || null,
        approvalDigest: str(version.sourceApprovalDigest) || null,
        requirementDigest: str(version.sourceRequirementDigest) || null,
      },
      approvedAt: iso(version.approvedAt),
      approvedByName: str(version.approvedByName),
      /* An approved version passed every readiness gate at approval — every row
         timed, identified and active — so there is nothing outstanding on it. */
      gaps: [],
    });
  }
  return out;
}

/* ═══ THE ORDER-LEVEL AGGREGATE ════════════════════════════════════════════
 *
 * THE RULE, STATED ONCE:
 *
 *   · With no styles linked, there is nothing to sum: unavailable.
 *   · When EVERY linked style has an APPROVED_CURRENT standard, the summary is
 *     complete: the operation count is the sum of the styles' approved counts,
 *     and `garmentSamMinutes` is the sum of their approved garment SAMs —
 *     one garment of EACH style, added decimal-safely on the lane's one
 *     rounding policy. It is NOT a per-order workload: it does not multiply by
 *     any quantity, because a quantity per style is Production's to decide.
 *   · When ANY linked style lacks one, nothing is summed. Adding an approved
 *     6.25 to an unknown would publish a total that looks like the order's
 *     standard and is not — so the totals are null and the reason is named,
 *     with the counts that explain it.
 *
 * Deterministic: the same set of approved versions always yields the same
 * figures, whatever order the styles were read in.
 */
const SUMMARY_UNAVAILABLE = Object.freeze({
  NO_STYLES_LINKED: "NO_STYLES_LINKED",
  APPROVED_STANDARD_MISSING_FOR_SOME_STYLES: "APPROVED_STANDARD_MISSING_FOR_SOME_STYLES",
});

function standardSummaryOf(standards) {
  const list = standards || [];
  const approved = list.filter((s) => s?.state === STANDARD_STATE.APPROVED_CURRENT);
  const base = {
    styles: list.length,
    stylesWithApprovedStandard: approved.length,
    stylesWithoutApprovedStandard: list.length - approved.length,
    rule: "SUM_OF_ONE_GARMENT_OF_EACH_STYLE_ONLY_WHEN_EVERY_STYLE_IS_APPROVED",
  };
  if (!list.length) {
    return {
      ...base, complete: false, operationCount: null, garmentSamMinutes: null,
      unavailableReason: SUMMARY_UNAVAILABLE.NO_STYLES_LINKED,
    };
  }
  if (approved.length !== list.length) {
    return {
      ...base, complete: false, operationCount: null, garmentSamMinutes: null,
      unavailableReason: SUMMARY_UNAVAILABLE.APPROVED_STANDARD_MISSING_FOR_SOME_STYLES,
    };
  }
  const samUnits = approved.reduce((sum, s) => sum + toUnits(s.garmentSamMinutes ?? 0), 0);
  return {
    ...base,
    complete: true,
    operationCount: approved.reduce((sum, s) => sum + (s.operationCount || 0), 0),
    garmentSamMinutes: unitsToMinutes(samUnits),
    unavailableReason: null,
  };
}

module.exports = {
  STANDARD_STATE, STANDARD_SOURCE, SUMMARY_UNAVAILABLE,
  approvedStandardsFor, standardSummaryOf,
};
