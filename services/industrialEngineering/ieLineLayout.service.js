// services/industrialEngineering/ieLineLayout.service.js
//
// THE LINE LAYOUT (Chunk 6A).
//
// Four things happen here: open (or resume) the layout for a file's current
// bulletin, list a file's layouts, read one with its metrics, and edit its
// stations. Nothing submits, approves, releases or acknowledges anything to
// Production, and nothing assigns a person or a machine — see the model header.
//
// ── ONLY AN APPROVED STANDARD TIME MAY DRIVE A BALANCE ──────────────────────
// The minutes behind every figure come from Chunk 4B: a method study for that
// exact bulletin row and operation revision, APPROVED by somebody other than
// its submitter. Not the row's proposed SAM, which is an engineer's opening
// estimate, and never a number a client sent — a client-supplied total would
// make the whole balance an assertion rather than a calculation.
//
// A file whose rows do not all carry one cannot have a layout at all, and the
// refusal names every row and why. Half a balance is worse than none: it reads
// as a line that is 60% efficient when it is really 60% measured.
//
// ── BOUND, AND NEVER REBASED ────────────────────────────────────────────────
// The bulletin revision, the ordered row identities and the approved times are
// copied in at opening. When the source moves the layout is reported
// SOURCE_CHANGED and refuses edits; it is not rewritten and not deleted,
// because it is the evidence for the balance somebody struck against the work
// content as it was. A new layout opens for the new source beside it.
//
// ── AND "THE SOURCE" IS TWO THINGS, NOT ONE ─────────────────────────────────
// A layout is stale when EITHER moves:
//
//   BULLETIN_REVISION_CHANGED — the file's revision is not the one bound. Any
//     accepted bulletin save moves it, including a note-only or proposed-SAM
//     edit that leaves every row identity alone. Comparing identities instead
//     of the revision left those edits looking CURRENT, which let somebody keep
//     editing a layout the bulletin had moved out from under.
//
//   APPROVED_STANDARD_CHANGED — the approved evidence behind an unchanged row
//     is a different approval. Chunk 4B lets an approved row be re-timed and
//     approved again with the bulletin untouched, and that is a different
//     standard even when the new figure happens to equal the old one: a
//     different study, decided by different people on a different day.
//
// The second is caught by a server-computed fingerprint over the complete
// ordered source, which is part of the layout's stored identity — see the
// model. Both reasons are published, and both together when both moved.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const IeLineLayout = require("../../models/CMS_Models/IndustrialEngineering/IeLineLayout");
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const IeBulletinVersion = require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");
const IeMethodStudy = require("../../models/CMS_Models/IndustrialEngineering/IeMethodStudy");
const { fail } = require("../storePurchase/errors");
const { calculateLineBalance } = require("./lineBalanceCalculation");
const { encodeCursor, decodeCursor, pageSize } = require("./ieRead.service");

const { LIMITS } = IeLineLayout;

const SOURCE_STATE = Object.freeze({ CURRENT: "CURRENT", SOURCE_CHANGED: "SOURCE_CHANGED" });

/** Why a layout is no longer a balance of the current source. */
const SOURCE_CHANGE_REASON = Object.freeze({
  /* Chunk 7C2. The version this layout balances is no longer the file's
     approved one — a later version has been approved and superseded it. The
     layout is untouched and stays exactly as it was; what changed is the answer
     to "is this still a balance of the current approved bulletin", and that is
     worth saying rather than leaving a reader to compare version numbers. */
  VERSION_SUPERSEDED: "BULLETIN_VERSION_SUPERSEDED",
  BULLETIN: "BULLETIN_REVISION_CHANGED",
  APPROVAL: "APPROVED_STANDARD_CHANGED",
  /* Chunk 6B: the frozen required-machine evidence behind a row is different
     evidence — a replaced operation, or a row authored since the freeze
     existed. A different requirement version is a different thing to plan
     against, so it supersedes the layout exactly as a new approval does. */
  REQUIREMENT: "REQUIREMENT_EVIDENCE_CHANGED",
});

/** Compatibility between an assignment's requirement and its station's plan. */
const COMPATIBILITY = Object.freeze({
  COMPATIBLE: "COMPATIBLE",
  INCOMPATIBLE: "INCOMPATIBLE",
  /* Never a false zero and never "compatible by default": unknown is what an
     unprovable or unconfigured input produces. */
  UNKNOWN: "UNKNOWN",
});

const COMPATIBILITY_REASON = Object.freeze({
  NOT_PROVABLE: "REQUIREMENTS_NOT_PROVABLE",
  NOT_CONFIGURED: "REQUIREMENTS_NOT_CONFIGURED",
  STATION_UNSPECIFIED: "STATION_MACHINE_TYPE_MISSING",
  MISSING_TYPE: "STATION_MISSING_REQUIRED_MACHINE_TYPE",
  SHORT_QUANTITY: "STATION_PLANS_TOO_FEW_MACHINES",
  NONE_REQUIRED: "NO_MACHINE_REQUIRED",
  SATISFIED: "STATION_PLANS_REQUIRED_MACHINE_TYPES",
});

/* The editable surface. Stations are replaced as a whole — a layout is edited
   as a sequence, exactly like a bulletin, and stable station ids plus one
   atomic revision check are what make that safe. */
const PATCH_FIELDS = Object.freeze(["expectedRevision", "stations"]);
const STATION_FIELDS = Object.freeze(["stationId", "label", "note", "assignments", "plannedMachineTypes"]);
const ASSIGNMENT_FIELDS = Object.freeze(["rowId"]);

/* Fields somebody will reasonably try to send, refused by name with where the
   fact actually lives. Every calculated figure is on this list: the server
   computes them, and accepting one would let a client publish a balance it
   asserted rather than one that was measured. */
const REFUSED_FIELDS = Object.freeze({
  companyId: "the company — that comes from your own membership, never a body",
  ieStyleFileId: "which engineering file it belongs to",
  bulletinRevision: "the bulletin revision it is bound to",
  sourceRows: "its bound source rows, which the server captures at opening",
  sourceFingerprint: "the fingerprint of its source, which only the server computes",
  sourceApprovalDigest: "part of its source fingerprint, which only the server computes",
  sourceRequirementDigest: "part of its source fingerprint, which only the server computes",
  requirementSnapshot: "the frozen requirement evidence, which the bulletin row captured",
  compatibility: "a compatibility verdict — the server decides it from frozen evidence",
  compatible: "a compatibility verdict — the server decides it from frozen evidence",
  machineTypeCompatibility: "a compatibility verdict — the server decides it",
  barcodeId: "a barcode — a printed piece is Production's record, not an engineering requirement",
  scanId: "a scan — Production owns scanning, and IE owns the standard it is measured against",
  operatorIdentityId: "an operator session, which Production owns",
  activeOps: "a scanner's active-operation state, which Production owns",
  status: "its own status",
  revision: "its own revision — send `expectedRevision` to say which one you read",
  history: "its own audit trail",
  totalWorkContentMinutes: "a calculated total — the server sums the approved standard times",
  stationWorkloadMinutes: "a calculated workload — the server sums the station's assignments",
  pitchMinutes: "a calculated figure",
  bottleneckMinutes: "a calculated figure",
  balanceEfficiencyPercent: "a calculated figure",
  balanceLossPercent: "a calculated figure",
  standardTimeMinutes: "a standard time — it comes from the approved method study, not from a body",
  employeeId: "an employee. A layout arranges WORK, never people",
  employeeName: "an employee. A layout arranges WORK, never people",
  operatorId: "an operator. A layout arranges WORK, never people",
  machineId: "a specific machine. A layout is an engineering standard, not a floor allocation",
  serialNumber: "a machine serial number, which is an asset record",
  assetId: "an asset id, which is an asset record",
  targetOutput: "a target output, which is capacity planning and a later chunk",
  shift: "a shift, which is capacity planning and a later chunk",
  capacity: "a capacity figure, which is a later chunk",
});

/* ═══ HELPERS ══════════════════════════════════════════════════════════════ */

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v ?? ""));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

/** One indistinguishable refusal for absent, foreign and malformed alike. */
const layoutNotFound = () => fail("IE_LINE_LAYOUT_NOT_FOUND", "That line layout was not found.");
const fileNotFound = () => fail("IE_FILE_NOT_FOUND", "That engineering file was not found.");

const mintStationId = () => `stn_${crypto.randomBytes(9).toString("hex")}`;
const mintEventId = () => `lle_${crypto.randomBytes(9).toString("hex")}`;

const actorName = (actor) => str(actor?.name || actor?.email);
const actorId = (actor) => (isId(actor?.id) ? oid(actor.id) : null);

const event = (type, { actor, layoutRevision, changed = [], summary = "" }) => ({
  eventId: mintEventId(),
  type,
  at: new Date(),
  actorId: actorId(actor),
  actorName: actorName(actor),
  layoutRevision,
  changed,
  summary: summary.slice(0, LIMITS.SUMMARY),
});

const gap = (code, action, message, extra = {}) => ({
  code, owner: "INDUSTRIAL_ENGINEERING", action, message, ...extra,
});

/* ═══ THE SOURCE ═══════════════════════════════════════════════════════════ */

async function loadOwnedFile(ctx, fileId) {
  assertContext(ctx);
  if (!isId(fileId)) throw fileNotFound();
  const doc = await IeStyleFile.findOne({ _id: oid(fileId), companyId: ctx.companyId })
    .select("_id companyId sampleStyleId revision bulletin.rows "
      + "currentApprovedBulletinVersionId currentApprovedVersionNo").lean();
  if (!doc) throw fileNotFound();
  return doc;
}

/**
 * WHICH OF TWO APPROVALS IS THE CURRENT ONE — deterministically.
 *
 * Newest `approved.at` wins; where two approvals share a timestamp — which two
 * decisions made in the same millisecond genuinely do — the larger `_id` wins.
 * Falling back to whatever order the database returned would make "the current
 * standard" depend on a query plan, so two identical requests could bind two
 * different studies and produce two different fingerprints for one source.
 *
 * Used everywhere the current approved standard is resolved, so a layout is
 * opened against exactly the study a later read will compare it with.
 */
function laterApproval(a, b) {
  if (!a) return b;
  if (!b) return a;
  const at = (s) => (s.approved?.at ? new Date(s.approved.at).getTime() : 0);
  if (at(a) !== at(b)) return at(a) > at(b) ? a : b;
  return String(a._id) > String(b._id) ? a : b;
}

/**
 * A stable hash over the COMPLETE ordered source a layout is built from.
 *
 * Canonical serialisation first — one line per row, fields in a fixed order,
 * separated by characters that cannot occur in an id, and the minutes written
 * to the four decimal places Chunk 4B stores so 1 and 1.0000 cannot hash
 * differently. Then SHA-256, which is stable across processes and releases in a
 * way `JSON.stringify` key order is not.
 *
 * It covers the evidence, not just the numbers: two approvals of the same
 * figure are two different sources, because they are two different decisions.
 * Versioned (`v1`) so a later change to what the fingerprint covers cannot
 * silently make old layouts look current.
 */
function requirementDigestOf(snapshot) {
  if (!snapshot) return "";
  /* Machine types sorted, so the order somebody typed them in is not a
     different requirement. Quantity travels with the type. */
  const types = (snapshot.machineTypes || [])
    .map((m) => `${String(m.machineType).trim().toUpperCase()}:${m.quantity}`)
    .sort()
    .join(",");
  return [
    snapshot.ieOperationRevision ?? "",
    snapshot.requirementsConfigured ? "1" : "0",
    types,
  ].join("~");
}

/** The approval half: the ordered rows and the standard approved for each. */
function approvalCanonicalOf(rows = []) {
  return rows.map((r) => [
    r.rowId,
    String(r.ieOperationId),
    String(r.ieOperationRevision),
    r.methodStudyId ? String(r.methodStudyId) : "",
    r.approvedSubmissionId || "",
    Number(r.standardTimeMinutes).toFixed(4),
  ].join("\u001f")).join("\u001e");
}

/** The requirement half: the frozen required-machine evidence per row. */
function requirementCanonicalOf(rows = []) {
  return rows.map((r) => `${r.rowId}\u001f${requirementDigestOf(r.requirementSnapshot)}`).join("\u001e");
}

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function sourceFingerprintOf(rows = []) {
  const approval = approvalCanonicalOf(rows);
  const hasEvidence = (rows || []).some((r) => r.requirementSnapshot);
  /* ── WHY THE REQUIREMENT SECTION IS APPENDED, NOT ALWAYS PRESENT ────────
     A layout written before the freeze existed has no evidence on any row, and
     its stored fingerprint was computed from the approval half alone. Omitting
     the section entirely in that case keeps those fingerprints valid, so
     existing layouts stay CURRENT and readable without a migration — which is
     the one thing this chunk is forbidden to perform. The moment any row
     carries frozen evidence, the section joins the hash and a genuine change of
     evidence supersedes the layout. */
  return digest(hasEvidence
    ? `v1\u001d${approval}\u001c${requirementCanonicalOf(rows)}`
    : `v1\u001d${approval}`);
}

/** The two halves, stored beside the fingerprint so a miss can name which moved. */
const sourceDigestsOf = (rows = []) => ({
  approval: digest(`a1\u001d${approvalCanonicalOf(rows)}`),
  requirement: (rows || []).some((r) => r.requirementSnapshot)
    ? digest(`r1\u001d${requirementCanonicalOf(rows)}`)
    : "",
});

/**
 * The approved standard time for each bulletin row, or the reason there is none.
 *
 * A row is matched to a method study by its OWN identity — the row id plus the
 * operation and revision the row currently carries — so a study approved
 * against a different operation cannot lend its minutes to this one.
 *
 * More than one approved study can legitimately exist for a row-operation: it
 * is approved, re-timed and approved again. The LATEST approval is the current
 * standard, chosen by the deterministic rule above, and which one was used is
 * published on the bound row (`methodStudyId`, `approvedSubmissionId`,
 * `approvedAt`) rather than left for somebody to guess.
 */
async function approvedTimesFor(ctx, file) {
  const rows = (file.bulletin?.rows || []).map((r) => ({ ...r }));
  if (!rows.length) return { bound: [], gaps: [] };

  const studies = await IeMethodStudy.find({
    companyId: ctx.companyId,
    ieStyleFileId: file._id,
    bulletinRowId: { $in: rows.map((r) => r.rowId) },
    status: "APPROVED",
  }).select("_id bulletinRowId ieOperationId ieOperationRevision approved approvedSubmissionId").lean();

  const byRow = new Map();
  for (const study of studies) {
    const key = `${study.bulletinRowId}|${String(study.ieOperationId)}|${study.ieOperationRevision}`;
    byRow.set(key, laterApproval(byRow.get(key), study));
  }

  const bound = [];
  const gaps = [];
  for (const row of rows) {
    const key = `${row.rowId}|${String(row.ieOperationId)}|${row.ieOperationRevision}`;
    const found = byRow.get(key);
    const minutes = found?.approved?.standardTimeMinutes;

    if (!found) {
      gaps.push({
        rowId: row.rowId,
        operationCode: row.operationCode || "",
        reason: "NO_APPROVED_METHOD_STUDY",
        message: `${row.operationCode || row.operationName || "This row"} has no approved method study, so it has no standard time.`,
      });
      continue;
    }
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) {
      /* An approved study whose figure cannot be read is not a zero. */
      gaps.push({
        rowId: row.rowId,
        operationCode: row.operationCode || "",
        reason: "APPROVED_STANDARD_TIME_UNREADABLE",
        message: `${row.operationCode || row.operationName || "This row"} has an approved study with no usable standard time.`,
      });
      continue;
    }

    bound.push({
      rowId: row.rowId,
      sequence: bound.length + 1,
      ieOperationId: row.ieOperationId,
      ieOperationRevision: row.ieOperationRevision,
      operationCode: row.operationCode || "",
      operationName: row.operationName || "",
      standardTimeMinutes: minutes,
      standardTimeSource: found.approved?.standardTimeSource || "",
      methodStudyId: found._id,
      approvedSubmissionId: found.approvedSubmissionId || found.approved?.submissionId || "",
      approvedAt: found.approved?.at || null,
      /* The bulletin row's own frozen evidence, carried so compatibility is
         decided from the layout alone. `null` for a row authored before the
         freeze existed — and nothing invents one. */
      requirementSnapshot: row.requirementSnapshot
        ? {
          capturedAt: row.requirementSnapshot.capturedAt || null,
          ieOperationRevision: row.requirementSnapshot.ieOperationRevision ?? null,
          requirementsConfigured: Boolean(row.requirementSnapshot.requirementsConfigured),
          machineTypes: (row.requirementSnapshot.machineTypes || []).map((m) => ({
            machineType: m.machineType, quantity: m.quantity,
          })),
        }
        : null,
    });
  }
  return { bound, gaps };
}

/**
 * THE CURRENT SOURCE OF A FILE — resolved once, and shared.
 *
 * Every path needs the same answer: what the bulletin is now, what is approved
 * for it now, and the fingerprint of the two together. Resolved once per
 * request and passed down, so a list of twenty layouts asks the approval
 * question once rather than twenty times.
 */
async function currentSourceFor(ctx, file) {
  const { bound, gaps } = await approvedTimesFor(ctx, file);
  return {
    bulletinRevision: file.revision,
    rows: bound,
    gaps,
    /* Null when the bulletin has rows nobody has approved: there is no complete
       current source to fingerprint. A layout is never called stale on the
       strength of a fingerprint that could not be computed — the revision
       comparison alone decides in that case. */
    fingerprint: gaps.length ? null : sourceFingerprintOf(bound),
    digests: gaps.length ? null : sourceDigestsOf(bound),
  };
}

/**
 * How this layout relates to the source as it stands now.
 *
 * TWO comparisons, and either one is enough to make a layout stale:
 *
 *   · the exact bulletin revision. Any accepted bulletin save moves it — a
 *     note, a proposed SAM, a reorder — and a layout bound to the previous one
 *     is no longer a balance of what the bulletin says. Comparing row
 *     identities instead let note-only and SAM-only edits pass as CURRENT.
 *   · the source fingerprint, which catches a later approval of the same row
 *     at the same operation revision — a different standard the bulletin knows
 *     nothing about.
 *
 * Both reasons are reported, and both together when both moved.
 */
function sourceStateOf(layout, current) {
  const reasons = [];
  /* ── A VERSION-BACKED LAYOUT IS JUDGED AGAINST ITS VERSION (Chunk 7C2) ──
     Not against the Style File's successor draft, which starts moving the
     moment the version is approved. `current` for such a layout is the version
     itself, so the comparisons below are against an immutable record and the
     answer is stable for ever. Both halves are still compared, because a layout
     whose stored evidence no longer matches the version it names is not a
     balance of that version whatever its pointer says. */
  if (layout.ieBulletinVersionId && current.bulletinVersionState
    && current.bulletinVersionState !== "APPROVED") {
    reasons.push(SOURCE_CHANGE_REASON.VERSION_SUPERSEDED);
  }
  if (Number(layout.bulletinRevision) !== Number(current.bulletinRevision)) {
    reasons.push(SOURCE_CHANGE_REASON.BULLETIN);
  }
  if (current.fingerprint && str(layout.sourceFingerprint) !== current.fingerprint) {
    /* WHICH half moved, where the layout stored the halves to compare with. A
       missing stored half — a layout written before Chunk 6B — is never read as
       a changed one, so those layouts are judged on the approval half and the
       revision alone. */
    const approvalMoved = current.digests
      && str(layout.sourceApprovalDigest)
      && str(layout.sourceApprovalDigest) !== current.digests.approval;
    const requirementMoved = current.digests
      && str(layout.sourceRequirementDigest)
      && str(layout.sourceRequirementDigest) !== current.digests.requirement;

    if (approvalMoved) reasons.push(SOURCE_CHANGE_REASON.APPROVAL);
    if (requirementMoved) reasons.push(SOURCE_CHANGE_REASON.REQUIREMENT);
    if (!approvalMoved && !requirementMoved) {
      /* The fingerprint moved and no stored half explains it: the honest answer
         is the general one rather than a guess at which. */
      reasons.push(SOURCE_CHANGE_REASON.APPROVAL);
    }
  }
  return {
    state: reasons.length ? SOURCE_STATE.SOURCE_CHANGED : SOURCE_STATE.CURRENT,
    reasons,
  };
}

/* ═══ REQUIRED-MACHINE COMPATIBILITY (Chunk 6B) ════════════════════════════
 *
 * One question, asked per assignment: does the station this operation is placed
 * at plan the machine types the operation was FROZEN as requiring?
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 * Not availability, not a machine, not capacity. It compares two engineering
 * statements — "this operation requires one single-needle lockstitch" against
 * "this station is planned with two" — and reads no `Machine`, no maintenance
 * status, no operator and no scan. Chunk 5B stays blocked, and nothing here
 * needs it.
 *
 * ── AND UNKNOWN IS A REAL ANSWER ────────────────────────────────────────────
 * Three inputs can be missing, and each produces UNKNOWN rather than a verdict:
 * a row with no frozen evidence (authored before the freeze existed), evidence
 * that says nobody had configured the operation's requirements, and a station
 * nobody has said what to equip. Calling any of those "compatible" would be a
 * planning green light nobody gave; calling them "incompatible" would send
 * somebody to fix a line that may be perfectly correct.
 *
 * ── ONE ASSIGNMENT AT A TIME, DELIBERATELY ──────────────────────────────────
 * Quantities are compared per assignment: an operation needing two machines of
 * a type is satisfied by a station planning two. Demand is NOT summed across the
 * assignments at a station — two operations each needing one machine do not make
 * the station need two, because whether they run concurrently is a capacity
 * question, and capacity is Chunk 7. Stated here so nobody reads this as one.
 */

const upperType = (v) => str(v).replace(/\s+/g, " ").toUpperCase();

function compatibilityOf(assignment, station, sourceByRow) {
  const source = sourceByRow.get(assignment.rowId);
  const snapshot = source?.requirementSnapshot || null;
  const planned = station.plannedMachineTypes || [];

  if (!snapshot) {
    return {
      state: COMPATIBILITY.UNKNOWN,
      reason: COMPATIBILITY_REASON.NOT_PROVABLE,
      message: "This row was authored before its required machine types were frozen, so what it requires cannot be proved.",
      requiredMachineTypes: null,
      missingMachineTypes: [],
    };
  }
  const required = (snapshot.machineTypes || []).map((m) => ({ machineType: m.machineType, quantity: m.quantity }));

  if (!snapshot.requirementsConfigured) {
    return {
      state: COMPATIBILITY.UNKNOWN,
      reason: COMPATIBILITY_REASON.NOT_CONFIGURED,
      message: "Nobody had decided what this operation requires when the row was authored.",
      requiredMachineTypes: required,
      missingMachineTypes: [],
    };
  }
  if (!required.length) {
    /* Configured, and configured as needing no machine. That IS an answer. */
    return {
      state: COMPATIBILITY.COMPATIBLE,
      reason: COMPATIBILITY_REASON.NONE_REQUIRED,
      message: "This operation requires no machine, so any station suits it.",
      requiredMachineTypes: [],
      missingMachineTypes: [],
    };
  }
  if (!planned.length) {
    return {
      state: COMPATIBILITY.UNKNOWN,
      reason: COMPATIBILITY_REASON.STATION_UNSPECIFIED,
      message: "This station has no planned machine types, so there is nothing to compare the requirement with.",
      requiredMachineTypes: required,
      missingMachineTypes: [],
    };
  }

  const plannedByType = new Map(planned.map((m) => [upperType(m.machineType), m.quantity]));
  const missing = required
    .map((r) => {
      const have = plannedByType.get(upperType(r.machineType));
      if (have === undefined) return { ...r, planned: 0, reason: COMPATIBILITY_REASON.MISSING_TYPE };
      if (have < r.quantity) return { ...r, planned: have, reason: COMPATIBILITY_REASON.SHORT_QUANTITY };
      return null;
    })
    .filter(Boolean);

  if (missing.length) {
    return {
      state: COMPATIBILITY.INCOMPATIBLE,
      reason: missing[0].reason,
      message: missing[0].reason === COMPATIBILITY_REASON.MISSING_TYPE
        ? `This station does not plan ${missing.map((m) => m.machineType).join(", ")}.`
        : `This station plans too few ${missing.map((m) => m.machineType).join(", ")}.`,
      requiredMachineTypes: required,
      missingMachineTypes: missing,
    };
  }
  return {
    state: COMPATIBILITY.COMPATIBLE,
    reason: COMPATIBILITY_REASON.SATISFIED,
    message: "This station plans every machine type the operation requires.",
    requiredMachineTypes: required,
    missingMachineTypes: [],
  };
}

/** The layout-level verdict, and never a false zero. */
function compatibilitySummaryOf(perAssignment) {
  const counts = {
    evaluated: perAssignment.length,
    compatible: perAssignment.filter((c) => c.state === COMPATIBILITY.COMPATIBLE).length,
    incompatible: perAssignment.filter((c) => c.state === COMPATIBILITY.INCOMPATIBLE).length,
    unknown: perAssignment.filter((c) => c.state === COMPATIBILITY.UNKNOWN).length,
  };
  /* An incompatibility is the loudest fact; otherwise any unknown makes the
     whole verdict unknown, because a line is only provably compatible when
     every placed operation is. Nothing placed at all is UNKNOWN too — not
     "compatible", and not a zero. */
  const state = counts.incompatible > 0
    ? COMPATIBILITY.INCOMPATIBLE
    : (counts.unknown > 0 || counts.evaluated === 0 ? COMPATIBILITY.UNKNOWN : COMPATIBILITY.COMPATIBLE);
  return { ...counts, state };
}

/* ═══ THE PUBLISHED SHAPE ══════════════════════════════════════════════════ */

const publishSourceRow = (r) => ({
  rowId: r.rowId,
  sequence: r.sequence,
  /* Stable provenance — see `productionLink`. */
  ieOperationId: String(r.ieOperationId),
  ieOperationRevision: r.ieOperationRevision,
  operationCode: r.operationCode || "",
  operationName: r.operationName || "",
  requirementSnapshot: r.requirementSnapshot ? {
    capturedAt: r.requirementSnapshot.capturedAt ? new Date(r.requirementSnapshot.capturedAt).toISOString() : null,
    ieOperationRevision: r.requirementSnapshot.ieOperationRevision ?? null,
    requirementsConfigured: Boolean(r.requirementSnapshot.requirementsConfigured),
    machineTypes: (r.requirementSnapshot.machineTypes || []).map((m) => ({
      machineType: m.machineType, quantity: m.quantity,
    })),
  } : null,
  requirementEvidence: r.requirementSnapshot
    ? (r.requirementSnapshot.requirementsConfigured ? "FROZEN" : "FROZEN_NOT_CONFIGURED")
    : "NOT_PROVABLE",
  standardTimeMinutes: r.standardTimeMinutes,
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
  layoutRevision: e.layoutRevision,
  changed: Array.isArray(e.changed) ? [...e.changed] : [],
  summary: e.summary || "",
  /* Structured on a template application, null on every other event — a
     template's NAME is not its identity, so the trail carries the id. */
  templateId: e.templateId ? String(e.templateId) : null,
  templateRevision: e.templateRevision ?? null,
});

/** Everything unfinished about this layout, each with its own code. */
function readinessFor(layout, { sourceState, sourceReasons = [], metrics, compatibility = [] }) {
  const gaps = [];
  const assigned = new Set();
  for (const station of layout.stations || []) {
    for (const a of station.assignments || []) assigned.add(a.rowId);
  }

  const unassigned = (layout.sourceRows || []).filter((r) => !assigned.has(r.rowId));
  if (unassigned.length) {
    gaps.push(gap("IE_LAYOUT_ROWS_UNASSIGNED", "ASSIGN_REMAINING_OPERATIONS",
      `${unassigned.length} operation${unassigned.length === 1 ? " is" : "s are"} not placed at a station yet.`,
      {
        rowIds: unassigned.map((r) => r.rowId),
        operationCodes: unassigned.map((r) => r.operationCode || r.operationName || r.rowId),
      }));
  }
  if (!(layout.stations || []).length) {
    gaps.push(gap("IE_LAYOUT_NO_STATIONS", "ADD_STATIONS", "This layout has no stations yet."));
  }
  if (!metrics.metricsAvailable) {
    /* Never a zero-percent efficiency dressed up as a balanced line. */
    gaps.push(gap("IE_LAYOUT_METRICS_UNAVAILABLE", "ASSIGN_WORK_TO_STATIONS",
      metrics.metricsUnavailableReason === "NO_STATIONS"
        ? "There are no stations, so there is no balance to calculate."
        : "No work is assigned to any station, so there is no balance to calculate.",
      { reason: metrics.metricsUnavailableReason }));
  }
  const emptyStations = (layout.stations || []).filter((s) => !(s.assignments || []).length);
  if (emptyStations.length && (layout.stations || []).length) {
    gaps.push(gap("IE_LAYOUT_EMPTY_STATION", "REVIEW_EMPTY_STATIONS",
      `${emptyStations.length} station${emptyStations.length === 1 ? " has" : "s have"} no work assigned. `
      + "An empty station still counts towards the balance.",
      { stationIds: emptyStations.map((s) => s.stationId) }));
  }
  /* ── COMPATIBILITY GAPS, ONE CODE PER CAUSE ────────────────────────────
     Each names the rows or stations it is about, so a screen marks the line
     rather than printing a sentence about it. */
  const byReason = (reason) => compatibility.filter((c) => c.reason === reason);
  for (const [reason, code, action, message] of [
    [COMPATIBILITY_REASON.NOT_PROVABLE, "IE_LAYOUT_REQUIREMENTS_NOT_PROVABLE", "REAUTHOR_ROW_TO_FREEZE_REQUIREMENTS",
      "were authored before their required machine types were frozen, so their compatibility cannot be proved."],
    [COMPATIBILITY_REASON.NOT_CONFIGURED, "IE_LAYOUT_REQUIREMENTS_NOT_CONFIGURED", "CONFIGURE_OPERATION_REQUIREMENTS",
      "were authored while nobody had decided what their operation requires."],
    [COMPATIBILITY_REASON.STATION_UNSPECIFIED, "IE_LAYOUT_STATION_MACHINE_TYPE_MISSING", "PLAN_STATION_MACHINE_TYPES",
      "are at stations with no planned machine types, so there is nothing to compare their requirement with."],
  ]) {
    const hits = byReason(reason);
    if (!hits.length) continue;
    gaps.push(gap(code, action, `${hits.length} placed operation${hits.length === 1 ? "" : "s"} ${message}`, {
      rowIds: hits.map((h) => h.rowId),
      stationIds: [...new Set(hits.map((h) => h.stationId))],
    }));
  }
  const incompatible = compatibility.filter((c) => c.state === COMPATIBILITY.INCOMPATIBLE);
  if (incompatible.length) {
    gaps.push(gap("IE_LAYOUT_OPERATION_STATION_INCOMPATIBLE", "MOVE_OPERATION_OR_PLAN_MACHINE_TYPE",
      `${incompatible.length} placed operation${incompatible.length === 1 ? " is" : "s are"} at a station that does not plan the machine types it requires.`,
      {
        rowIds: incompatible.map((c) => c.rowId),
        stationIds: [...new Set(incompatible.map((c) => c.stationId))],
        missingMachineTypes: [...new Set(incompatible.flatMap((c) => c.missingMachineTypes.map((m) => m.machineType)))],
      }));
  }
  /* A station planning machine types with nothing placed at it is not wrong,
     but it is unsupported configuration: the plan is stated and unused. */
  const unusedPlan = (layout.stations || []).filter(
    (s) => (s.plannedMachineTypes || []).length && !(s.assignments || []).length,
  );
  if (unusedPlan.length) {
    gaps.push(gap("IE_LAYOUT_STATION_MACHINE_TYPE_UNUSED", "REVIEW_STATION_PLAN",
      `${unusedPlan.length} station${unusedPlan.length === 1 ? "" : "s"} plan machine types but have no operations placed.`,
      { stationIds: unusedPlan.map((s) => s.stationId) }));
  }

  if (sourceState === SOURCE_STATE.SOURCE_CHANGED) {
    gaps.push(gap("IE_LAYOUT_SOURCE_CHANGED", "OPEN_LAYOUT_FOR_CURRENT_SOURCE",
      sourceReasons.includes(SOURCE_CHANGE_REASON.APPROVAL)
        && sourceReasons.includes(SOURCE_CHANGE_REASON.BULLETIN)
        ? "The bulletin has changed and a newer standard time has been approved since this layout was balanced."
        : sourceReasons.includes(SOURCE_CHANGE_REASON.APPROVAL)
          ? "A newer method study has been approved since this layout was balanced, so its times are no longer the current standard."
          : "The bulletin has changed since this layout was balanced.",
      {
        reasons: sourceReasons,
        boundBulletinRevision: layout.bulletinRevision,
        /* Nothing has been rewritten — the fix is a new layout, not a rebase. */
        resolution: "OPEN_NEW_LAYOUT",
      }));
  }
  return { ready: gaps.length === 0, gaps };
}

function publishLayout(doc, { current, withHistory = false } = {}) {
  const { state, reasons } = sourceStateOf(doc, current);
  const metrics = calculateLineBalance(doc.stations || []);
  const workloadById = new Map(metrics.stationWorkloads.map((s) => [s.stationId, s]));
  const sourceByRow = new Map((doc.sourceRows || []).map((r) => [r.rowId, r]));
  const allCompatibility = [];

  return {
    layoutId: String(doc._id),
    companyId: String(doc.companyId),
    ieStyleFileId: String(doc.ieStyleFileId),
    sampleStyleId: String(doc.sampleStyleId),
    status: doc.status,
    revision: doc.revision,

    /* What this balance is a balance OF — and how that compares with what the
       file's source is now. The captured rows are never recalculated against
       current times; they are the evidence. */
    /* ── WHICH APPROVED BULLETIN VERSION THIS BALANCES (Chunk 7C2) ───────
       `null` on the wire for a pre-7C1 layout, and `versionBacked` says which
       kind of record a reader is holding rather than leaving them to infer it
       from a null. A legacy layout is never labelled as version-backed. */
    bulletinVersion: doc.ieBulletinVersionId ? {
      bulletinVersionId: String(doc.ieBulletinVersionId),
      versionNo: doc.bulletinVersionNo ?? null,
      state: current.bulletinVersionState ?? null,
    } : null,
    versionBacked: Boolean(doc.ieBulletinVersionId),

    /* ── AND WHETHER SOMEBODY ACCEPTED IT ──────────────────────────────── */
    approval: doc.status === "APPROVED" ? {
      approvedByName: doc.approvedByName || "",
      approvedAt: doc.approvedAt ? new Date(doc.approvedAt).toISOString() : null,
      approvedRevision: doc.approvedRevision ?? null,
    } : null,

    source: {
      bulletinRevision: doc.bulletinRevision,
      currentBulletinRevision: current.bulletinRevision ?? null,
      fingerprint: doc.sourceFingerprint,
      currentFingerprint: current.fingerprint,
      approvalDigest: doc.sourceApprovalDigest || null,
      requirementDigest: doc.sourceRequirementDigest || null,
      state,
      /* Empty while CURRENT; BULLETIN_REVISION_CHANGED, APPROVED_STANDARD_CHANGED,
         or both, once it is not. */
      changeReasons: reasons,
      rowCount: (doc.sourceRows || []).length,
      rows: (doc.sourceRows || []).map(publishSourceRow),
    },

    stations: (doc.stations || []).map((s) => ({
      stationId: s.stationId,
      sequence: s.sequence,
      label: s.label || "",
      note: s.note || "",
      /* What this station is PLANNED to be equipped with — types and counts,
         never a machine, an availability or a maintenance status. */
      plannedMachineTypes: (s.plannedMachineTypes || []).map((m) => ({
        machineType: m.machineType, quantity: m.quantity,
      })),
      assignments: (s.assignments || []).map((a) => {
        const compatibility = compatibilityOf(a, s, sourceByRow);
        allCompatibility.push({ ...compatibility, stationId: s.stationId, rowId: a.rowId });
        return {
          rowId: a.rowId,
          sequence: a.sequence,
          operationCode: a.operationCode || "",
          operationName: a.operationName || "",
          standardTimeMinutes: a.standardTimeMinutes,
          /* Server-decided, from frozen evidence. A client cannot send it — the
             field is refused by name on the way in. */
          machineTypeCompatibility: compatibility,
        };
      }),
      workloadMinutes: workloadById.get(s.stationId)?.workloadMinutes ?? 0,
      idleMinutes: workloadById.get(s.stationId)?.idleMinutes ?? null,
      isBottleneck: Boolean(workloadById.get(s.stationId)?.isBottleneck),
    })),

    metrics: {
      totalWorkContentMinutes: metrics.totalWorkContentMinutes,
      stationCount: metrics.stationCount,
      pitchMinutes: metrics.pitchMinutes,
      bottleneckMinutes: metrics.bottleneckMinutes,
      balanceEfficiencyPercent: metrics.balanceEfficiencyPercent,
      balanceLossPercent: metrics.balanceLossPercent,
      available: metrics.metricsAvailable,
      unavailableReason: metrics.metricsUnavailableReason,
      /* One rounding policy, stated in the payload: half-up to four decimals,
         applied once here and nowhere else. */
      rounding: "HALF_UP_4DP",
    },

    /* The line-level verdict. UNKNOWN whenever anything placed cannot be
       proved, and UNKNOWN when nothing is placed — never a zero that reads as
       a clean line. */
    machineTypeCompatibility: compatibilitySummaryOf(allCompatibility),

    /* ── THE PRODUCTION CONNECTION, STATED AS UNKNOWN ────────────────────
       Chunk 8 will freeze IE's stable references — bulletin row, operation,
       operation revision, requirement version and standard version — beside the
       operation code in a released work-order snapshot, and Chunk 9 will read
       Production's barcode and machine actuals against exactly that frozen
       standard. Neither exists yet, and the only key the two sides share TODAY
       is the operation CODE, which is mutable. So the connection is published as
       unknown and the code is labelled for what it is: a legacy compatibility
       path, never an identity to match on silently. */
    productionLink: {
      state: "UNKNOWN",
      reason: "NO_STABLE_SHARED_IDENTITY",
      legacyCompatibilityKey: "OPERATION_CODE",
      message: "Industrial Engineering and Production share no stable identifier yet. "
        + "The operation code is a legacy compatibility path only; released snapshots (Chunk 8) "
        + "and actuals comparison (Chunk 9) will carry the frozen IE references instead.",
      /* The stable provenance a later chunk will freeze, already on every bound
         row: rowId, ieOperationId, ieOperationRevision, the requirement version
         and the standard version. Named here so it is not re-derived. */
      provenanceFields: [
        "source.rows[].rowId",
        "source.rows[].ieOperationId",
        "source.rows[].ieOperationRevision",
        "source.rows[].requirementSnapshot.ieOperationRevision",
        "source.rows[].methodStudyId",
        "source.rows[].approvedSubmissionId",
      ],
    },

    readiness: readinessFor(doc, {
      sourceState: state, sourceReasons: reasons, metrics, compatibility: allCompatibility,
    }),
    /* An approved layout is evidence: current, readable, and not editable. */
    editable: state === SOURCE_STATE.CURRENT && doc.status === "DRAFT",
    /* ── WHETHER APPROVAL IS EVEN THE RIGHT QUESTION FOR THIS RECORD ──────
       True for a DRAFT that can prove which approved bulletin version it
       balances. False for one already approved, and false for a pre-7C1 layout,
       which can never prove it. It does NOT mean the gates would pass — those
       are answered by `readiness`, and answering them here would mean computing
       an approval verdict on every read of every layout. */
    canApprove: doc.status === "DRAFT" && Boolean(doc.ieBulletinVersionId),
    ...(withHistory ? { history: [...(doc.history || [])].reverse().map(publishEvent) } : {}),
    createdByName: doc.createdByName || "",
    updatedByName: doc.updatedByName || "",
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    /* Chunk 7C2 approves a LINE LAYOUT and nothing else. It releases nothing,
       acknowledges nothing, assigns nobody and books no capacity. */
    canRelease: false,
    allocates: false,
  };
}

/* ═══ OPEN ═════════════════════════════════════════════════════════════════ */

/**
 * Open — or resume — the layout for this file's CURRENT bulletin revision.
 *
 * The unique partial index on (company, file, bulletin revision) is what makes
 * that idempotent: two simultaneous requests both find nothing and only one
 * insert survives, and the loser reads the winner's layout.
 */
/**
 * OPEN (or resume) the layout for this file's CURRENT APPROVED bulletin version.
 *
 * ── WHY THE VERSION AND NOT THE DRAFT (Chunk 7C2) ──────────────────────────
 * Before 7C1 a layout was balanced against the Style File's embedded bulletin,
 * which is a working draft: it moves whenever somebody edits it, so a layout
 * opened from it was a balance of whatever the bulletin happened to be that
 * afternoon. Now there is an immutable record of what a second person approved,
 * and that is the only thing worth balancing. The frozen rows, the fingerprint
 * and both digests are COPIED from it; nothing here re-resolves a method study,
 * an operation requirement or a standard time, because the version already did
 * that once and re-deriving them would be a second answer to a settled question.
 *
 * `bulletinRevision` keeps exactly the meaning it has always had — the file
 * revision the rows were taken from — and takes it from the version's own
 * `fileRevisionAtSubmit`. Nothing on the layout is renamed or reinterpreted.
 *
 * ── AND THE SUCCESSOR DRAFT IS NOT READ ────────────────────────────────────
 * Once a version is approved the Style File's bulletin becomes the successor
 * draft, and people start editing it straight away. A layout opened from the
 * approved version must not see any of that.
 */
async function createLayout(ctx, { fileId, body = {}, actor = null } = {}) {
  assertContext(ctx);
  for (const key of Object.keys(body || {})) {
    /* Including the two version fields: which approved version a layout is
       opened from is the server's answer, read from the file's own pointer. A
       caller that could name one could balance a line against a version nobody
       approved for this style. */
    throw fail("FIELD_NOT_ACCEPTED",
      `A line layout is opened from this file's approved bulletin version. It cannot carry "${key}".`,
      { field: key, fieldErrors: [{ field: key, code: "NOT_ACCEPTED", message: `"${key}" is not part of opening a layout.` }] });
  }

  const file = await loadOwnedFileForVersion(ctx, fileId);
  const version = await approvedVersionFor(ctx, file);

  /* ── RESUME THE ONE DRAFT FOR THIS EXACT VERSION ─────────────────────── */
  const key = {
    companyId: ctx.companyId,
    ieStyleFileId: file._id,
    ieBulletinVersionId: version._id,
    status: "DRAFT",
  };
  const current = versionAsSource(version);

  const existing = await IeLineLayout.findOne(key).lean();
  if (existing) {
    return { layout: publishLayout(existing, { current, withHistory: true }), created: false };
  }

  const doc = {
    ...key,
    bulletinVersionNo: version.versionNo,
    sampleStyleId: file.sampleStyleId,
    /* The existing meaning, from the version's own record of it. */
    bulletinRevision: version.fileRevisionAtSubmit,
    sourceFingerprint: version.sourceFingerprint,
    sourceApprovalDigest: version.sourceApprovalDigest || "",
    sourceRequirementDigest: version.sourceRequirementDigest || "",
    sourceRows: version.rows.map((r) => ({ ...r })),
    revision: 1,
    stations: [],
    history: [event("LINE_LAYOUT_CREATED", {
      actor,
      layoutRevision: 1,
      summary: `Opened against approved bulletin version ${version.versionNo} `
        + `(file revision ${version.fileRevisionAtSubmit}) — ${version.rows.length} operations to place`,
    })],
    createdBy: actorId(actor),
    createdByName: actorName(actor),
    updatedBy: actorId(actor),
    updatedByName: actorName(actor),
  };

  try {
    const created = await IeLineLayout.create(doc);
    return { layout: publishLayout(created.toObject(), { current, withHistory: true }), created: true };
  } catch (err) {
    if (err?.code !== 11000 && !/E11000|duplicate key/i.test(str(err?.message))) throw err;
    /* Two simultaneous opens: the index decides, and the loser resumes the
       winner's layout rather than being told it failed. */
    const winner = await IeLineLayout.findOne(key).lean();
    if (!winner) throw err;
    return { layout: publishLayout(winner, { current, withHistory: true }), created: false };
  }
}

/** The file, with the pointer fields a layout needs, under this company. */
async function loadOwnedFileForVersion(ctx, fileId) {
  assertContext(ctx);
  if (!isId(fileId)) throw fileNotFound();
  const doc = await IeStyleFile.findOne({ _id: oid(fileId), companyId: ctx.companyId })
    .select("_id companyId sampleStyleId revision currentApprovedBulletinVersionId currentApprovedVersionNo")
    .lean();
  if (!doc) throw fileNotFound();
  return doc;
}

/**
 * The approved bulletin version this file currently points at — PROVED.
 *
 * The pointer is not taken on trust: the version it names must exist, belong to
 * this company, this file and this style, and still be APPROVED. Every failure
 * answers identically, so a foreign, mismatched, returned or superseded version
 * cannot be told apart from a file that has never had one approved.
 */
async function approvedVersionFor(ctx, file) {
  const notApproved = () => fail("IE_LAYOUT_BULLETIN_NOT_APPROVED",
    "This engineering file has no approved operation bulletin to balance a line against. "
    + "Submit the bulletin and have it approved first.",
    { fileId: String(file._id) });

  const pointer = file.currentApprovedBulletinVersionId;
  if (!pointer) throw notApproved();

  const version = await IeBulletinVersion.findOne({
    _id: pointer,
    companyId: ctx.companyId,
    ieStyleFileId: file._id,
    sampleStyleId: file.sampleStyleId,
    state: "APPROVED",
  }).lean();
  if (!version) throw notApproved();
  return version;
}

/**
 * An approved bulletin version, in the shape `publishLayout` reads a source in.
 *
 * A version-backed layout's source IS its version, and a version is immutable —
 * so this is a constant, and such a layout stays CURRENT for as long as it
 * points at it. What used to make a layout stale was the Style File moving
 * underneath it; a version cannot move, which is the whole reason 7C1 exists.
 */
const versionAsSource = (version) => ({
  bulletinRevision: version.fileRevisionAtSubmit,
  rows: version.rows,
  gaps: [],
  fingerprint: version.sourceFingerprint,
  digests: {
    approval: version.sourceApprovalDigest || "",
    requirement: version.sourceRequirementDigest || "",
  },
  bulletinVersionNo: version.versionNo,
  bulletinVersionState: version.state,
});


/* ═══ READ ═════════════════════════════════════════════════════════════════ */

async function loadOwnedLayout(ctx, layoutId) {
  assertContext(ctx);
  if (!isId(layoutId)) throw layoutNotFound();
  const doc = await IeLineLayout.findOne({ _id: oid(layoutId), companyId: ctx.companyId }).lean();
  if (!doc) throw layoutNotFound();
  return doc;
}

async function readLayout(ctx, { layoutId } = {}) {
  const doc = await loadOwnedLayout(ctx, layoutId);
  /* The file under the SAME company bound, so a layout whose file somehow left
     this company reads as not found rather than as current. */
  const file = await IeStyleFile.findOne({ _id: doc.ieStyleFileId, companyId: ctx.companyId })
    .select("_id revision bulletin.rows").lean();
  if (!file) throw layoutNotFound();
  /* Compared against the source this layout was actually balanced against —
     its own immutable bulletin version, or, for a pre-7C1 layout, the file's
     current bulletin exactly as before. The captured rows, times, stations and
     metrics are published exactly as they were stored either way. */
  const current = await sourceForLayout(ctx, doc, file);
  return { layout: publishLayout(doc, { current, withHistory: true }) };
}

/** Every layout for one file, newest first — including superseded ones. */
async function listLayouts(ctx, { fileId, limit, cursor } = {}) {
  const file = await loadOwnedFile(ctx, fileId);
  const size = pageSize(limit);
  const after = decodeCursor(cursor, "time");

  const and = [{ companyId: ctx.companyId, ieStyleFileId: file._id }];
  if (after) {
    and.push({
      $or: [
        { createdAt: { $lt: new Date(after.t) } },
        { createdAt: new Date(after.t), _id: { $lt: oid(after.i) } },
      ],
    });
  }
  const found = await IeLineLayout.find({ $and: and }).sort({ createdAt: -1, _id: -1 }).limit(size + 1).lean();
  const page = found.slice(0, size);
  const last = page[page.length - 1];

  /* ── ONE RESOLUTION PER DISTINCT SOURCE, NOT ONE PER LAYOUT ────────────
     Version-backed layouts on one page usually share a version, and the file's
     own bulletin is resolved at most once for whatever legacy layouts remain.
     Each layout is still judged against its OWN source: a page cannot make a
     record answer for evidence it was not balanced against. */
  const fileSource = await currentSourceFor(ctx, file);
  const byVersion = new Map();
  for (const l of page) {
    const key = l.ieBulletinVersionId ? String(l.ieBulletinVersionId) : "";
    if (key && !byVersion.has(key)) byVersion.set(key, await sourceForLayout(ctx, l, file));
  }
  const sourceOf = (l) => (l.ieBulletinVersionId
    ? byVersion.get(String(l.ieBulletinVersionId))
    : fileSource);

  return {
    ieStyleFileId: String(file._id),
    currentBulletinRevision: file.revision,
    currentSourceFingerprint: fileSource.fingerprint,
    currentApprovedBulletinVersionId: file.currentApprovedBulletinVersionId
      ? String(file.currentApprovedBulletinVersionId) : null,
    currentApprovedVersionNo: file.currentApprovedVersionNo ?? null,
    layouts: page.map((l) => publishLayout(l, { current: sourceOf(l) })),
    limit: size,
    hasMore: found.length > size,
    nextCursor: found.length > size
      ? encodeCursor({ t: new Date(last.createdAt).getTime(), i: String(last._id) })
      : null,
    sort: "createdAt:desc,_id:desc",
  };
}

/**
 * An approved layout refuses every write, and says which one it refused.
 *
 * Shared by the edit path and by Chunk 6C's template application, so the two
 * cannot drift into describing the same record differently.
 */
const layoutImmutable = (layout, verb) => fail("IE_LAYOUT_IMMUTABLE",
  `This line layout was approved and is permanent evidence of the plan somebody accepted. `
  + `It cannot be ${verb} — open a new draft layout for the current approved bulletin version.`,
  {
    layoutId: String(layout._id),
    status: layout.status,
    approvedRevision: layout.approvedRevision ?? null,
    approvedByName: layout.approvedByName || "",
    resolution: "OPEN_NEW_DRAFT_LAYOUT",
  });

/**
 * THE SOURCE A LAYOUT IS JUDGED AGAINST.
 *
 * A version-backed layout is judged against its own immutable bulletin version;
 * a pre-7C1 layout keeps exactly the behaviour it has always had, judged against
 * the Style File's current bulletin. Both answers are honest about what the
 * record can prove, and neither is relabelled as the other.
 */
async function sourceForLayout(ctx, layout, file) {
  if (!layout.ieBulletinVersionId) return currentSourceFor(ctx, file);
  const version = await IeBulletinVersion.findOne({
    _id: layout.ieBulletinVersionId,
    companyId: ctx.companyId,
    ieStyleFileId: layout.ieStyleFileId,
  }).lean();
  /* A version that cannot be resolved is not a reason to fall back to the
     mutable draft: that would silently re-judge the layout against something it
     was never balanced against. The fingerprint simply cannot be compared, and
     the layout is reported on its stored evidence alone. */
  if (!version) {
    return {
      bulletinRevision: layout.bulletinRevision,
      rows: [], gaps: [], fingerprint: null, digests: null,
      bulletinVersionNo: layout.bulletinVersionNo ?? null,
      bulletinVersionState: null,
    };
  }
  return versionAsSource(version);
}

/* ═══ EDIT ═════════════════════════════════════════════════════════════════ */

function readExpectedRevision(value) {
  if (value === undefined || value === null || value === "") {
    throw fail("VALIDATION", "Say which revision of this layout you read.", {
      field: "expectedRevision",
      fieldErrors: [{ field: "expectedRevision", code: "REQUIRED", message: "Say which revision of this layout you read." }],
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

function assertPatchShape(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw fail("VALIDATION", "That is not a line layout.");
  }
  for (const key of Object.keys(body)) {
    const refused = REFUSED_FIELDS[key];
    if (refused) {
      throw fail("FIELD_NOT_ACCEPTED", `A line layout cannot carry ${refused}.`,
        { field: key, fieldErrors: [{ field: key, code: "NOT_ACCEPTED", message: `This record does not accept "${key}".` }] });
    }
    if (!PATCH_FIELDS.includes(key)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of a layout edit.`,
        { field: key, fieldErrors: [{ field: key, code: "NOT_ACCEPTED", message: `"${key}" is not part of a layout edit.` }] });
    }
  }
}

const text = (v, field, max, errs, index) => {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") {
    errs.push({ field, code: "INVALID", message: "This is text.", index });
    return "";
  }
  const out = v.trim().replace(/\s+/g, " ");
  if (out.length > max) {
    errs.push({ field, code: "TOO_LONG", message: `This is at most ${max} characters.`, index });
    return "";
  }
  return out;
};

/**
 * Shape the stations a caller sent into stations this layout may store.
 *
 * EVERYTHING is validated before anything is written: one bad station refuses
 * the whole save, because a half-applied line is a balance nobody struck. A
 * `stationId` the layout already holds keeps that station's identity through
 * relabelling and reordering; one it does not hold is refused rather than
 * quietly minted. Every assignment's minutes come from the BOUND source row —
 * the body carries a row id and nothing else.
 */
function shapeStations(list, { existingIds, existingById = new Map(), sourceByRow }) {
  if (!Array.isArray(list)) {
    throw fail("IE_LINE_LAYOUT_STATION_INVALID", "Stations are an ordered list.", {
      field: "stations",
      fieldErrors: [{ field: "stations", code: "NOT_A_LIST", message: "Stations are an ordered list." }],
    });
  }
  if (list.length > LIMITS.STATIONS) {
    throw fail("IE_LINE_LAYOUT_STATION_INVALID", `A layout holds at most ${LIMITS.STATIONS} stations.`, {
      field: "stations",
      fieldErrors: [{ field: "stations", code: "TOO_MANY", message: `At most ${LIMITS.STATIONS} stations.` }],
    });
  }

  const errs = [];
  const seenStations = new Set();
  const seenRows = new Map();
  const shaped = [];

  for (let i = 0; i < list.length; i += 1) {
    const raw = list[i];
    const at = (f) => `stations.${i}.${f}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errs.push({ field: `stations.${i}`, code: "INVALID", message: "Every station is an object.", index: i });
      continue;
    }
    for (const field of Object.keys(raw)) {
      const refused = REFUSED_FIELDS[field];
      if (refused) {
        throw fail("FIELD_NOT_ACCEPTED", `A station cannot carry ${refused}.`,
          { field: at(field), fieldErrors: [{ field: at(field), code: "NOT_ACCEPTED", message: `A station cannot carry "${field}".`, index: i }] });
      }
      if (!STATION_FIELDS.includes(field)) {
        throw fail("FIELD_NOT_ACCEPTED", `"${field}" is not part of a station.`,
          { field: at(field), fieldErrors: [{ field: at(field), code: "NOT_ACCEPTED", message: `"${field}" is not part of a station.`, index: i }] });
      }
    }

    let stationId = str(raw.stationId);
    if (stationId) {
      if (!existingIds.has(stationId)) {
        errs.push({ field: at("stationId"), code: "INVALID", message: "That station is not part of this layout.", stationId, index: i });
      } else if (seenStations.has(stationId)) {
        errs.push({ field: at("stationId"), code: "DUPLICATE", message: "The same station appears twice.", stationId, index: i });
      }
      seenStations.add(stationId);
    } else {
      stationId = mintStationId();
    }

    const label = text(raw.label, at("label"), LIMITS.LABEL, errs, i);
    const note = text(raw.note, at("note"), LIMITS.NOTE, errs, i);

    /* ── WHAT THIS STATION IS PLANNED TO HOLD ─────────────────────────────
       Machine TYPES and counts, in the same vocabulary an operation states its
       requirement in. Omitted means "left as it was"; an explicit `[]` means
       "nothing planned yet", which compatibility reads as UNKNOWN rather than
       as a station that needs no machine. */
    const plannedMachineTypes = [];
    if (raw.plannedMachineTypes !== undefined) {
      if (!Array.isArray(raw.plannedMachineTypes)) {
        throw fail("IE_LAYOUT_STATION_MACHINE_TYPE_INVALID",
          "Planned machine types are a list of types and quantities.",
          {
            field: at("plannedMachineTypes"), index: i,
            fieldErrors: [{ field: at("plannedMachineTypes"), code: "NOT_A_LIST", message: "This is a list.", index: i }],
          });
      }
      if (raw.plannedMachineTypes.length > 20) {
        throw fail("IE_LAYOUT_STATION_MACHINE_TYPE_INVALID", "A station plans at most 20 machine types.",
          { field: at("plannedMachineTypes"), index: i,
            fieldErrors: [{ field: at("plannedMachineTypes"), code: "TOO_MANY", message: "At most 20.", index: i }] });
      }
      const seenTypes = new Set();
      for (let k = 0; k < raw.plannedMachineTypes.length; k += 1) {
        const entry = raw.plannedMachineTypes[k];
        const mf = (f) => `${at("plannedMachineTypes")}.${k}.${f}`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw fail("IE_LAYOUT_STATION_MACHINE_TYPE_INVALID", "Every planned machine type is an object.",
            { field: `${at("plannedMachineTypes")}.${k}`, index: k,
              fieldErrors: [{ field: `${at("plannedMachineTypes")}.${k}`, code: "INVALID", message: "Every entry is an object.", index: k }] });
        }
        for (const field of Object.keys(entry)) {
          const refused = REFUSED_FIELDS[field];
          if (refused || !["machineType", "quantity"].includes(field)) {
            throw fail("FIELD_NOT_ACCEPTED",
              refused
                ? `A planned machine type cannot carry ${refused}.`
                : `"${field}" is not part of a planned machine type. A station plans a TYPE and a count, nothing else.`,
              { field: mf(field), fieldErrors: [{ field: mf(field), code: "NOT_ACCEPTED", message: `"${field}" is not accepted.`, index: k }] });
          }
        }
        const machineType = text(entry.machineType, mf("machineType"), LIMITS.LABEL, errs, k);
        if (!machineType) {
          throw fail("IE_LAYOUT_STATION_MACHINE_TYPE_INVALID", "Name the machine type this station plans.",
            { field: mf("machineType"), index: k,
              fieldErrors: [{ field: mf("machineType"), code: "REQUIRED", message: "Name the machine type.", index: k }] });
        }
        const quantity = entry.quantity;
        if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
          throw fail("IE_LAYOUT_STATION_MACHINE_TYPE_INVALID",
            "A planned quantity is a whole number from 1 to 999.",
            { field: mf("quantity"), index: k,
              fieldErrors: [{ field: mf("quantity"), code: "OUT_OF_RANGE", message: "A whole number from 1 to 999.", index: k }] });
        }
        const key = upperType(machineType);
        if (seenTypes.has(key)) {
          /* One type, one row: two rows for the same type make "how many does
             this station plan" have two answers. */
          throw fail("IE_LAYOUT_STATION_MACHINE_TYPE_DUPLICATE",
            `${machineType} is planned twice at this station. Record it once with the quantity it needs.`,
            { field: mf("machineType"), machineType, index: k,
              fieldErrors: [{ field: mf("machineType"), code: "DUPLICATE", message: "Planned twice.", index: k }] });
        }
        seenTypes.add(key);
        plannedMachineTypes.push({ machineType, quantity });
      }
    } else if (stationId && existingIds.has(stationId)) {
      const was = existingById.get(stationId);
      plannedMachineTypes.push(...((was?.plannedMachineTypes || []).map((m) => ({ ...m }))));
    }

    const rawAssignments = raw.assignments === undefined ? [] : raw.assignments;
    if (!Array.isArray(rawAssignments)) {
      errs.push({ field: at("assignments"), code: "NOT_A_LIST", message: "Assignments are an ordered list.", index: i });
      continue;
    }
    if (rawAssignments.length > LIMITS.ASSIGNMENTS_PER_STATION) {
      errs.push({ field: at("assignments"), code: "TOO_MANY", message: `At most ${LIMITS.ASSIGNMENTS_PER_STATION} per station.`, index: i });
      continue;
    }

    const assignments = [];
    for (let j = 0; j < rawAssignments.length; j += 1) {
      const entry = rawAssignments[j];
      const af = (f) => `stations.${i}.assignments.${j}.${f}`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errs.push({ field: `stations.${i}.assignments.${j}`, code: "INVALID", message: "Every assignment is an object.", index: j });
        continue;
      }
      for (const field of Object.keys(entry)) {
        const refused = REFUSED_FIELDS[field];
        if (refused) {
          throw fail("FIELD_NOT_ACCEPTED", `An assignment cannot carry ${refused}.`,
            { field: af(field), fieldErrors: [{ field: af(field), code: "NOT_ACCEPTED", message: `An assignment cannot carry "${field}".`, index: j }] });
        }
        if (!ASSIGNMENT_FIELDS.includes(field)) {
          throw fail("FIELD_NOT_ACCEPTED", `"${field}" is not part of an assignment. An assignment names a bulletin row; the server supplies its operation and time.`,
            { field: af(field), fieldErrors: [{ field: af(field), code: "NOT_ACCEPTED", message: `"${field}" is not part of an assignment.`, index: j }] });
        }
      }

      const rowId = str(entry.rowId);
      const source = sourceByRow.get(rowId);
      if (!rowId || !source) {
        /* Unknown here, and a row from another file's bulletin, are the same
           answer: this layout is bound to a fixed set of rows. */
        throw fail("IE_LINE_LAYOUT_ROW_NOT_IN_SOURCE",
          "That operation is not one of the bulletin rows this layout was opened against.",
          {
            field: af("rowId"), rowId, index: j,
            fieldErrors: [{ field: af("rowId"), code: "UNKNOWN_ROW", message: "That operation is not part of this layout's bulletin.", rowId, index: j }],
          });
      }
      if (seenRows.has(rowId)) {
        /* One operation, one place on the line. Splitting an operation across
           stations is deliberately out of scope for this chunk. */
        throw fail("IE_LINE_LAYOUT_ROW_DUPLICATE",
          `${source.operationCode || source.operationName || "That operation"} is assigned to more than one station.`,
          {
            field: af("rowId"), rowId, index: j, alreadyAt: seenRows.get(rowId),
            fieldErrors: [{ field: af("rowId"), code: "DUPLICATE_ROW", message: "This operation is already assigned to a station.", rowId, index: j }],
          });
      }
      seenRows.set(rowId, stationId);

      assignments.push({
        rowId,
        sequence: assignments.length + 1,
        /* Captured by the SERVER from the bound source row. */
        operationCode: source.operationCode || "",
        operationName: source.operationName || "",
        standardTimeMinutes: source.standardTimeMinutes,
      });
    }

    shaped.push({ stationId, sequence: shaped.length + 1, label, note, plannedMachineTypes, assignments });
  }

  if (errs.length) {
    throw fail("IE_LINE_LAYOUT_STATION_INVALID", "Some of these stations need fixing.",
      { fieldErrors: errs, field: errs[0].field });
  }
  return shaped;
}

/** Stations compared as they are persisted — the no-op test. */
function sameStations(before = [], after = []) {
  if (before.length !== after.length) return false;
  for (let i = 0; i < after.length; i += 1) {
    const a = after[i];
    const b = before[i];
    for (const f of ["stationId", "label", "note"]) {
      if ((a[f] ?? "") !== (b[f] ?? "")) return false;
    }
    if (a.sequence !== b.sequence) return false;
    const ap = a.plannedMachineTypes || [];
    const bp = b.plannedMachineTypes || [];
    if (ap.length !== bp.length) return false;
    for (let k = 0; k < ap.length; k += 1) {
      if (upperType(ap[k].machineType) !== upperType(bp[k].machineType)) return false;
      if ((ap[k].quantity ?? null) !== (bp[k].quantity ?? null)) return false;
    }
    const aa = a.assignments || [];
    const bb = b.assignments || [];
    if (aa.length !== bb.length) return false;
    for (let j = 0; j < aa.length; j += 1) {
      if (aa[j].rowId !== bb[j].rowId) return false;
      if (aa[j].sequence !== bb[j].sequence) return false;
      if ((aa[j].standardTimeMinutes ?? null) !== (bb[j].standardTimeMinutes ?? null)) return false;
    }
  }
  return true;
}

/** WHICH KINDS of thing changed — for the history, which stores no stations. */
function changedCategories(before, after) {
  const changed = [];
  const beforeIds = before.map((s) => s.stationId);
  const afterIds = after.map((s) => s.stationId);
  if (afterIds.some((id) => !beforeIds.includes(id))) changed.push("stations_added");
  if (beforeIds.some((id) => !afterIds.includes(id))) changed.push("stations_removed");

  const surviving = afterIds.filter((id) => beforeIds.includes(id));
  if (surviving.length > 1 && beforeIds.filter((id) => afterIds.includes(id)).join("|") !== surviving.join("|")) {
    changed.push("stations_reordered");
  }
  const byId = new Map(before.map((s) => [s.stationId, s]));
  for (const station of after) {
    const was = byId.get(station.stationId);
    if (!was) continue;
    const wasRows = (was.assignments || []).map((a) => a.rowId).join("|");
    const nowRows = (station.assignments || []).map((a) => a.rowId).join("|");
    if (wasRows !== nowRows && !changed.includes("assignments")) changed.push("assignments");
    if (((was.label || "") !== (station.label || "") || (was.note || "") !== (station.note || ""))
      && !changed.includes("labels")) changed.push("labels");
    const wasPlan = (was.plannedMachineTypes || []).map((m) => `${upperType(m.machineType)}:${m.quantity}`).join("|");
    const nowPlan = (station.plannedMachineTypes || []).map((m) => `${upperType(m.machineType)}:${m.quantity}`).join("|");
    if (wasPlan !== nowPlan && !changed.includes("machine_plan")) changed.push("machine_plan");
  }
  return changed.length ? changed : ["stations"];
}

/**
 * Replace the stations.
 *
 * The write is ONE conditional update carrying ownership, the expected revision
 * and the DRAFT status, incrementing the revision and appending the audit line
 * in the same operation. A layout whose bulletin has moved is refused before
 * any of it: it is evidence of a balance against work content that no longer
 * exists, and rebasing it would silently restate somebody's line.
 */
async function updateLayout(ctx, { layoutId, body = {}, actor = null } = {}) {
  const current = await loadOwnedLayout(ctx, layoutId);
  assertPatchShape(body);
  const expected = readExpectedRevision(body.expectedRevision);

  if (!("stations" in body)) {
    /* Required rather than defaulted: a PATCH with no stations is a client that
       lost them, and treating it as "clear the layout" would answer a mistake
       by deleting somebody's balance. */
    throw fail("VALIDATION", "Send the stations you want this layout to have.", {
      field: "stations",
      fieldErrors: [{ field: "stations", code: "REQUIRED", message: "Send the stations you want this layout to have." }],
    });
  }

  /* ── AN APPROVED LAYOUT IS EVIDENCE, AND IS ASKED ABOUT FIRST ───────────
     Before the source and before the revision. Both of those answers tell
     somebody to re-read and try again, and no amount of re-reading will make an
     approved layout editable — the way to change the plan is a new draft. */
  if (current.status === "APPROVED") throw layoutImmutable(current, "edited");

  const file = await IeStyleFile.findOne({ _id: current.ieStyleFileId, companyId: ctx.companyId })
    .select("_id revision bulletin.rows").lean();
  if (!file) throw layoutNotFound();

  /* ── THE SOURCE IS CHECKED BEFORE THE REVISION AND BEFORE THE NO-OP ─────
     A stale layout cannot accept an edit at all, so "your revision is stale" and
     "nothing changed" are both the wrong answer for it — the first sends
     somebody to re-read and try again for ever, and the second would report
     success for a save against work content that no longer exists. */
  const source = await sourceForLayout(ctx, current, file);
  const { state, reasons } = sourceStateOf(current, source);
  if (state !== SOURCE_STATE.CURRENT) {
    throw fail("IE_LINE_LAYOUT_SOURCE_CHANGED",
      reasons.includes(SOURCE_CHANGE_REASON.APPROVAL) && !reasons.includes(SOURCE_CHANGE_REASON.BULLETIN)
        ? "A newer method study has been approved since this layout was balanced. It stays as evidence and cannot be edited — open a layout for the current source."
        : "The bulletin has changed since this layout was balanced. It stays as evidence and cannot be edited — open a layout for the current source.",
      {
        layoutId: String(current._id),
        reasons,
        boundBulletinRevision: current.bulletinRevision,
        currentBulletinRevision: file.revision,
        resolution: "OPEN_NEW_LAYOUT",
      });
  }
  if (current.revision !== expected) {
    throw fail("IE_LINE_LAYOUT_REVISION_CONFLICT",
      "Somebody changed this layout while you were editing it. Re-read it and decide again.",
      { expected, actual: current.revision, layoutId: String(current._id) });
  }

  const before = (current.stations || []).map((s) => ({ ...s, assignments: (s.assignments || []).map((a) => ({ ...a })) }));
  const stations = shapeStations(body.stations, {
    existingIds: new Set(before.map((s) => s.stationId)),
    existingById: new Map(before.map((s) => [s.stationId, s])),
    sourceByRow: new Map((current.sourceRows || []).map((r) => [r.rowId, r])),
  });

  if (sameStations(before, stations)) {
    return {
      layout: publishLayout(current, { current: source, withHistory: true }),
      updated: false,
      events: [],
    };
  }

  const changed = changedCategories(before, stations);
  const nextRevision = expected + 1;
  const metrics = calculateLineBalance(stations);
  const audit = event("LINE_LAYOUT_EDITED", {
    actor,
    layoutRevision: nextRevision,
    changed,
    summary: `Changed ${changed.join(", ")} — ${stations.length} stations, `
      + `${metrics.metricsAvailable ? `${metrics.balanceEfficiencyPercent}% balance` : "no balance yet"}`,
  });

  const updated = await IeLineLayout.findOneAndUpdate(
    { _id: current._id, companyId: ctx.companyId, revision: expected, status: "DRAFT" },
    {
      $set: { stations, updatedBy: actorId(actor), updatedByName: actorName(actor) },
      $inc: { revision: 1 },
      $push: { history: { $each: [audit], $slice: -LIMITS.HISTORY } },
    },
    { new: true },
  ).lean();

  if (!updated) {
    const now = await IeLineLayout.findOne({ _id: current._id, companyId: ctx.companyId })
      .select("_id revision status").lean();
    if (!now) throw layoutNotFound();
    throw fail("IE_LINE_LAYOUT_REVISION_CONFLICT",
      "Somebody changed this layout while you were editing it. Re-read it and decide again.",
      { expected, actual: now.revision, layoutId: String(now._id) });
  }

  return {
    layout: publishLayout(updated, { current: source, withHistory: true }),
    updated: true,
    events: [publishEvent(audit)],
  };
}

/* ═══ APPROVE (Chunk 7C2) ══════════════════════════════════════════════════
 *
 * A second person accepts this balance as the plan. Nothing leaves Industrial
 * Engineering: approving a layout releases nothing, acknowledges nothing,
 * assigns nobody and books no capacity.
 *
 * ── IT PROVES, IT DOES NOT REBUILD ────────────────────────────────────────
 * Every gate below reads what is already stored and compares it with the
 * immutable bulletin version the layout names. Nothing is re-resolved: no
 * method study is read again, no requirement profile, no standard time. A gate
 * that rebuilt the evidence could approve a layout whose stored evidence says
 * something else, which is the one thing this record exists to prevent.
 */

const APPROVE_FIELDS = Object.freeze(["expectedRevision"]);

/* Server-owned facts somebody will reasonably try to send, refused by name. */
const APPROVE_REFUSED = Object.freeze({
  companyId: "the company — that comes from your own membership, never a body",
  layoutId: "its own id, which is in the address",
  status: "its own status — approval is its own action",
  revision: "its own revision — send `expectedRevision` to say which one you read",
  approvedBy: "who approved it, which comes from your session",
  approvedByName: "who approved it, which comes from your session",
  approvedAt: "when it was approved, which the server stamps",
  approvedRevision: "which revision was approved, which the server records",
  history: "its own audit trail",
  stations: "the stations — approve what is there, or edit it first",
  sourceRows: "the frozen source rows, which came from the approved bulletin version",
  sourceFingerprint: "a source fingerprint, which only the server computes",
  ieBulletinVersionId: "which bulletin version it balances, which was settled when it was opened",
  bulletinVersionNo: "which bulletin version it balances, which was settled when it was opened",
  reason: "a reason. An approval is a decision, not an explanation — a RETURN carries the reason",
});

function assertApproveShape(body) {
  if (body === null || body === undefined) return;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw fail("VALIDATION", "An approval is an object.", { field: "body" });
  }
  for (const key of Object.keys(body)) {
    if (APPROVE_FIELDS.includes(key)) continue;
    const refused = APPROVE_REFUSED[key];
    throw fail("FIELD_NOT_ACCEPTED",
      refused ? `Approving a line layout cannot carry ${refused}.` : `"${key}" is not part of approving a layout.`,
      {
        field: key,
        fieldErrors: [{
          field: key, code: "NOT_ACCEPTED",
          message: refused ? `This action does not accept "${key}".` : `"${key}" is not part of approving a layout.`,
        }],
      });
  }
}

/**
 * WHO LAST AUTHORED THIS DRAFT — the person an approver must not be.
 *
 * `updatedBy` is the last person to change the layout, and `createdBy` the
 * person who opened it. Either is an author; the comparison is against the most
 * recent one, because that is whose work is being accepted.
 *
 * ── FAIL CLOSED, ALWAYS ────────────────────────────────────────────────────
 * A layout with no provable author id cannot be approved at all. Treating an
 * unknown author as "not the approver" would turn every unattributable record
 * into one that anybody may wave through, which is precisely the record where
 * a second pair of eyes matters most.
 */
function authorOf(layout) {
  const author = layout.updatedBy || layout.createdBy || null;
  if (!author) {
    throw fail("IE_LAYOUT_MAKER_CHECKER",
      "Nothing stored says who authored this layout, so it cannot be approved by somebody "
      + "other than its author. Edit it, which records an author, and approve it then.",
      { layoutId: String(layout._id) });
  }
  return String(author);
}

/**
 * Every reason this layout may not be approved — all of them, together.
 *
 * Never the first failure alone: an engineer who fixes what they were told and
 * is refused again learns only that the system is withholding.
 */
function approvalGapsFor(layout, { sourceState, sourceReasons, metrics, compatibility, version }) {
  const gaps = [];

  /* ── THE FROZEN SOURCE STILL IS THE VERSION'S ─────────────────────────── */
  if (sourceState !== SOURCE_STATE.CURRENT) {
    gaps.push(gap("IE_LAYOUT_SOURCE_CHANGED", "OPEN_LAYOUT_FOR_CURRENT_SOURCE",
      "This layout's stored evidence no longer matches the approved bulletin version it names, "
      + "so it is not a balance of that version.",
      { reasons: sourceReasons, boundBulletinRevision: layout.bulletinRevision }));
  }
  if (version) {
    /* Compared field by field rather than by fingerprint alone, because a
       fingerprint proves the rows were equal when it was computed and this has
       to prove they are equal NOW. */
    if (String(layout.sourceFingerprint) !== String(version.sourceFingerprint)
      || str(layout.sourceApprovalDigest) !== str(version.sourceApprovalDigest || "")
      || str(layout.sourceRequirementDigest) !== str(version.sourceRequirementDigest || "")) {
      gaps.push(gap("IE_LAYOUT_SOURCE_CHANGED", "OPEN_LAYOUT_FOR_CURRENT_SOURCE",
        "This layout's source fingerprint or digests do not match the approved bulletin version it names.",
        { boundFingerprint: layout.sourceFingerprint, versionFingerprint: version.sourceFingerprint }));
    } else if (!sameFrozenRows(layout.sourceRows || [], version.rows || [])) {
      gaps.push(gap("IE_LAYOUT_SOURCE_CHANGED", "OPEN_LAYOUT_FOR_CURRENT_SOURCE",
        "This layout's frozen source rows are not the rows of the approved bulletin version it names.",
        { rowCount: (layout.sourceRows || []).length, versionRowCount: (version.rows || []).length }));
    }
  }

  /* ── AND THE PLAN IS COMPLETE ─────────────────────────────────────────── */
  const assigned = new Set();
  const twice = new Set();
  for (const station of layout.stations || []) {
    for (const a of station.assignments || []) {
      if (assigned.has(a.rowId)) twice.add(a.rowId);
      assigned.add(a.rowId);
    }
  }
  const unassigned = (layout.sourceRows || []).filter((r) => !assigned.has(r.rowId));
  if (unassigned.length || twice.size) {
    gaps.push(gap("IE_LAYOUT_ROWS_UNASSIGNED", "ASSIGN_REMAINING_OPERATIONS",
      twice.size
        ? `${twice.size} operation${twice.size === 1 ? " is" : "s are"} placed more than once.`
        : `${unassigned.length} operation${unassigned.length === 1 ? " is" : "s are"} not placed at a station yet.`,
      {
        rowIds: unassigned.map((r) => r.rowId),
        duplicatedRowIds: [...twice],
        operationCodes: unassigned.map((r) => r.operationCode || r.operationName || r.rowId),
      }));
  }
  if (!(layout.stations || []).length) {
    gaps.push(gap("IE_LAYOUT_NO_STATIONS", "ADD_STATIONS", "This layout has no stations yet."));
  }
  const empty = (layout.stations || []).filter((s) => !(s.assignments || []).length);
  if (empty.length) {
    gaps.push(gap("IE_LAYOUT_EMPTY_STATION", "REVIEW_EMPTY_STATIONS",
      `${empty.length} station${empty.length === 1 ? " has" : "s have"} no work assigned.`,
      { stationIds: empty.map((s) => s.stationId) }));
  }
  if (!metrics.metricsAvailable) {
    gaps.push(gap("IE_LAYOUT_METRICS_UNAVAILABLE", "ASSIGN_WORK_TO_STATIONS",
      metrics.metricsUnavailableReason === "NO_STATIONS"
        ? "There are no stations, so there is no balance to calculate."
        : "No work is assigned to any station, so there is no balance to calculate.",
      { reason: metrics.metricsUnavailableReason }));
  }

  /* ── AND EVERY PLACED OPERATION IS PROVABLY COMPATIBLE ─────────────────
     PROVABLY — not "not known to be incompatible". An UNKNOWN verdict is
     exactly the case where nobody can say whether the station suits the work:
     the row's requirement evidence cannot be proved, or nobody configured what
     the operation needs, or the station plans no machine types at all. This
     lane decided long ago that unknown is a real answer and never a quiet yes,
     and an approval is the last moment it could still be caught.

     The codes and the meanings are `readinessFor`'s own, reused rather than
     reinvented, so a screen that already renders a layout's readiness renders
     an approval refusal with no new vocabulary. Each cause is its own gap,
     because each has a different fix and a different owner. */
  const byReason = (reason) => compatibility.filter(
    (c) => c.state === COMPATIBILITY.UNKNOWN && c.reason === reason,
  );
  for (const [reason, code, action, message] of [
    [COMPATIBILITY_REASON.NOT_PROVABLE, "IE_LAYOUT_REQUIREMENTS_NOT_PROVABLE", "REAUTHOR_ROW_TO_FREEZE_REQUIREMENTS",
      "were authored before their required machine types were frozen, so their compatibility cannot be proved."],
    [COMPATIBILITY_REASON.NOT_CONFIGURED, "IE_LAYOUT_REQUIREMENTS_NOT_CONFIGURED", "CONFIGURE_OPERATION_REQUIREMENTS",
      "were authored while nobody had decided what their operation requires."],
    [COMPATIBILITY_REASON.STATION_UNSPECIFIED, "IE_LAYOUT_STATION_MACHINE_TYPE_MISSING", "PLAN_STATION_MACHINE_TYPES",
      "are at stations with no planned machine types, so there is nothing to compare their requirement with."],
  ]) {
    const hits = byReason(reason);
    if (!hits.length) continue;
    gaps.push(gap(code, action,
      `${hits.length} placed operation${hits.length === 1 ? "" : "s"} ${message}`,
      {
        rowIds: hits.map((h) => h.rowId),
        stationIds: [...new Set(hits.map((h) => h.stationId))],
      }));
  }
  /* Any other UNKNOWN reason is still an UNKNOWN, and is refused rather than
     falling through a list of the reasons that existed when this was written. */
  const named = new Set([
    COMPATIBILITY_REASON.NOT_PROVABLE,
    COMPATIBILITY_REASON.NOT_CONFIGURED,
    COMPATIBILITY_REASON.STATION_UNSPECIFIED,
  ]);
  const otherUnknown = compatibility.filter(
    (c) => c.state === COMPATIBILITY.UNKNOWN && !named.has(c.reason),
  );
  if (otherUnknown.length) {
    gaps.push(gap("IE_LAYOUT_REQUIREMENTS_NOT_PROVABLE", "REAUTHOR_ROW_TO_FREEZE_REQUIREMENTS",
      `${otherUnknown.length} placed operation${otherUnknown.length === 1 ? "'s" : "s'"} `
      + "machine-type compatibility cannot be proved.",
      {
        rowIds: otherUnknown.map((c) => c.rowId),
        stationIds: [...new Set(otherUnknown.map((c) => c.stationId))],
        reasons: [...new Set(otherUnknown.map((c) => c.reason))],
      }));
  }

  const incompatible = compatibility.filter((c) => c.state === COMPATIBILITY.INCOMPATIBLE);
  if (incompatible.length) {
    gaps.push(gap("IE_LAYOUT_OPERATION_STATION_INCOMPATIBLE", "MOVE_OPERATION_OR_PLAN_MACHINE_TYPE",
      `${incompatible.length} placed operation${incompatible.length === 1 ? " is" : "s are"} at a station `
      + "that does not plan the machine types it requires.",
      {
        rowIds: incompatible.map((c) => c.rowId),
        stationIds: [...new Set(incompatible.map((c) => c.stationId))],
        missingMachineTypes: [...new Set(incompatible.flatMap((c) => c.missingMachineTypes.map((m) => m.machineType)))],
      }));
  }
  return gaps;
}

/**
 * TWO FROZEN ROW SETS, COMPARED ON EVERY FIELD A LAYOUT ACTUALLY COPIES.
 *
 * Every field `createLayout` copies out of an immutable Bulletin Version and
 * into `sourceRows[]` is compared here, and the list is derived from that copy
 * rather than remembered separately — the whole point of this check is that a
 * layout's stored evidence still IS the version's, and a comparison that
 * skipped a field would bless a layout whose evidence had quietly moved in it.
 *
 * `operationCode` and `operationName` are on the list for a reason that looks
 * cosmetic and is not: they are what a person reads on a station card, and a
 * plan approved against "OP-4 Buttonhole" is not evidence of a plan approved
 * against "OP-4 Bartack". Likewise the requirement snapshot's `capturedAt` and
 * `ieOperationRevision`: they say WHICH version of an operation's requirements
 * was frozen, and swapping them changes what the compatibility verdict was
 * computed from while leaving the machine types looking identical.
 *
 * ── NORMALISED SO ONLY REAL DIFFERENCES SHOW ───────────────────────────────
 * Ids become strings, dates become epoch milliseconds, absent and null become
 * one value, and machine types are compared as a sorted list of type and
 * quantity. Row ORDER is significant and is not sorted away: a layout's rows
 * are a sequence, and two rows exchanging places is a different plan.
 *
 * ── AND ONLY WHAT THE LAYOUT STORES ────────────────────────────────────────
 * A Bulletin Version row also carries `proposedSamMinutes` and `note`, which a
 * layout deliberately does not copy — IE's proposal and its notes belong to the
 * bulletin, and a balance is calculated from approved standard times. Comparing
 * them would refuse every layout ever opened.
 */
const FROZEN_ROW_FIELDS = Object.freeze([
  "rowId", "sequence",
  "ieOperationId", "ieOperationRevision", "operationCode", "operationName",
  "standardTimeMinutes", "standardTimeSource",
  "methodStudyId", "approvedSubmissionId", "approvedAt",
]);

/** One value, in a form where equal things compare equal and nothing else does. */
function frozenValue(value) {
  if (value === undefined || value === null) return "\u0000";
  if (value instanceof Date) return `d:${value.getTime()}`;
  if (typeof value === "object" && value._bsontype === "ObjectId") return `o:${String(value)}`;
  if (typeof value === "number") return `n:${value}`;
  if (typeof value === "boolean") return `b:${value}`;
  /* An id that arrives as a string and one that arrives as an ObjectId are the
     same id, so both reduce to the same 24 characters. */
  const text = String(value);
  return /^[0-9a-f]{24}$/i.test(text) ? `o:${text.toLowerCase()}` : `s:${text}`;
}

/** The requirement snapshot, whole — absent and present are different answers. */
function frozenRequirement(snapshot) {
  if (!snapshot) return "\u0000";
  const types = (snapshot.machineTypes || [])
    .map((m) => `${String(m.machineType)}:${Number(m.quantity)}`)
    .sort()
    .join(",");
  return [
    frozenValue(snapshot.capturedAt),
    frozenValue(snapshot.ieOperationRevision),
    frozenValue(Boolean(snapshot.requirementsConfigured)),
    types,
  ].join("\u001d");
}

const frozenRowShape = (row) => [
  ...FROZEN_ROW_FIELDS.map((f) => frozenValue(row?.[f])),
  frozenRequirement(row?.requirementSnapshot),
].join("\u001f");

function sameFrozenRows(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((row, i) => frozenRowShape(row) === frozenRowShape(b[i]));
}

async function approveLayout(ctx, { layoutId, body = {}, actor = null } = {}) {
  const current = await loadOwnedLayout(ctx, layoutId);
  assertApproveShape(body);
  const expected = readExpectedRevision(body.expectedRevision);

  /* ── ALREADY APPROVED IS NOT A NO-OP ────────────────────────────────────
     Answering "nothing changed" would report a second approval as a success and
     leave two people believing they each took the decision. */
  if (current.status === "APPROVED") {
    throw fail("IE_LAYOUT_NOT_APPROVABLE",
      "This line layout has already been approved.",
      {
        layoutId: String(current._id),
        status: current.status,
        approvedRevision: current.approvedRevision ?? null,
        approvedByName: current.approvedByName || "",
      });
  }

  /* ── A PRE-7C1 LAYOUT CANNOT PROVE WHAT IT BALANCED ─────────────────────
     It stays readable historical evidence. No approval and no backfill can make
     it provable, so the refusal is its own code and the resolution is a new
     layout rather than a wait. */
  if (!current.ieBulletinVersionId) {
    throw fail("IE_LAYOUT_BULLETIN_VERSION_UNPROVEN",
      "This layout was balanced before operation bulletins were versioned, so nothing stored says "
      + "which approved bulletin it is a balance of. It stays as historical evidence — open a new "
      + "layout from the current approved bulletin version to plan against something provable.",
      { layoutId: String(current._id), resolution: "OPEN_NEW_DRAFT_LAYOUT" });
  }

  /* ── THE VERSION IT NAMES MUST STILL BE APPROVED, AND STILL BE ITS ────── */
  const version = await IeBulletinVersion.findOne({
    _id: current.ieBulletinVersionId,
    companyId: ctx.companyId,
    ieStyleFileId: current.ieStyleFileId,
    sampleStyleId: current.sampleStyleId,
  }).lean();
  if (!version || version.state !== "APPROVED") {
    throw fail("IE_LAYOUT_BULLETIN_NOT_APPROVED",
      "The operation bulletin version this layout balances is not the approved one any more, "
      + "so the plan is a balance of something nobody currently stands behind.",
      {
        layoutId: String(current._id),
        bulletinVersionId: String(current.ieBulletinVersionId),
        bulletinVersionNo: current.bulletinVersionNo ?? null,
        bulletinVersionState: version?.state ?? null,
      });
  }

  /* ── MAKER-CHECKER, BY ACTOR ID ─────────────────────────────────────────
     Not a missing role — the wrong PERSON. An owner and a platform
     administrator are refused on identical terms, and the comparison is of
     stable ids: two people share a display name far more often than they share
     an id, and a name is editable by the person it belongs to. */
  const approver = actorId(actor);
  if (!approver) {
    throw fail("IE_LAYOUT_MAKER_CHECKER", "Approving a line layout has to be attributable to a person.");
  }
  const author = authorOf(current);
  if (author === String(approver)) {
    throw fail("IE_LAYOUT_MAKER_CHECKER",
      "A line layout has to be approved by somebody other than the person who last worked on it.",
      { layoutId: String(current._id), authoredByName: current.updatedByName || current.createdByName || "" });
  }

  /* ── AND THE PLAN ITSELF, PROVED FROM WHAT IS STORED ──────────────────── */
  const source = versionAsSource(version);
  const { state, reasons } = sourceStateOf(current, source);
  const metrics = calculateLineBalance(current.stations || []);
  const sourceByRow = new Map((current.sourceRows || []).map((r) => [r.rowId, r]));
  const compatibility = [];
  for (const station of current.stations || []) {
    for (const a of station.assignments || []) {
      compatibility.push({ ...compatibilityOf(a, station, sourceByRow), stationId: station.stationId, rowId: a.rowId });
    }
  }

  const gaps = approvalGapsFor(current, {
    sourceState: state, sourceReasons: reasons, metrics, compatibility, version,
  });
  if (gaps.length) {
    throw fail("IE_LAYOUT_NOT_APPROVABLE",
      `This line layout cannot be approved: ${gaps.length} thing${gaps.length === 1 ? "" : "s"} `
      + `need${gaps.length === 1 ? "s" : ""} attention.`,
      { layoutId: String(current._id), gaps, gapCodes: gaps.map((g) => g.code) });
  }

  /* ── ONE CONDITIONAL WRITE ──────────────────────────────────────────────
     `status: "DRAFT"` and `revision: expected` together, so two simultaneous
     approvals produce exactly one winner and the loser is told which
     precondition failed. Nothing about the bulletin version is touched: this
     write cannot rebase, restate or re-approve it. */
  const nextRevision = expected + 1;
  const audit = event("LINE_LAYOUT_APPROVED", {
    actor,
    layoutRevision: nextRevision,
    changed: ["status"],
    summary: `Approved revision ${expected} against bulletin version ${version.versionNo} — `
      + `${(current.stations || []).length} stations, `
      + `${metrics.metricsAvailable ? `${metrics.balanceEfficiencyPercent}% balance` : "no balance"}`,
  });

  const updated = await IeLineLayout.findOneAndUpdate(
    { _id: current._id, companyId: ctx.companyId, revision: expected, status: "DRAFT" },
    {
      $set: {
        status: "APPROVED",
        approvedBy: approver,
        approvedByName: actorName(actor),
        approvedAt: new Date(),
        approvedRevision: expected,
        updatedBy: actorId(actor),
        updatedByName: actorName(actor),
      },
      $inc: { revision: 1 },
      $push: { history: { $each: [audit], $slice: -LIMITS.HISTORY } },
    },
    { new: true },
  ).lean();

  if (!updated) {
    /* One company-scoped re-read to say WHICH precondition failed. */
    const now = await IeLineLayout.findOne({ _id: current._id, companyId: ctx.companyId })
      .select("_id revision status approvedRevision approvedByName").lean();
    if (!now) throw layoutNotFound();
    if (now.status === "APPROVED") {
      throw fail("IE_LAYOUT_NOT_APPROVABLE", "This line layout has already been approved.",
        {
          layoutId: String(now._id), status: now.status,
          approvedRevision: now.approvedRevision ?? null,
          approvedByName: now.approvedByName || "",
        });
    }
    throw fail("IE_LINE_LAYOUT_REVISION_CONFLICT",
      "Somebody changed this layout while you were reading it. Re-read it and decide again.",
      { expected, actual: now.revision, layoutId: String(now._id) });
  }

  return {
    updated: true,
    layout: publishLayout(updated, { current: source, withHistory: true }),
    events: [publishEvent(audit)],
  };
}

module.exports = {
  SOURCE_STATE, SOURCE_CHANGE_REASON, COMPATIBILITY, COMPATIBILITY_REASON,
  PATCH_FIELDS, STATION_FIELDS, ASSIGNMENT_FIELDS, REFUSED_FIELDS,
  compatibilityOf, compatibilitySummaryOf, requirementDigestOf, sourceDigestsOf,
  publishLayout, publishEvent, sourceStateOf, sameStations, changedCategories, shapeStations,
  approvedTimesFor, readinessFor, currentSourceFor, sourceFingerprintOf, laterApproval,
  createLayout, readLayout, listLayouts, updateLayout, approveLayout,
  approvalGapsFor, sameFrozenRows, authorOf, versionAsSource, sourceForLayout,
  APPROVE_FIELDS, APPROVE_REFUSED,
};
