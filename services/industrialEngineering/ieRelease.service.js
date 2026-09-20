// services/industrialEngineering/ieRelease.service.js
//
// IE CHUNK 8A-i — ISSUING A RELEASE.
//
// Industrial Engineering hands Planning a complete, approved aggregate: one
// approved Operation Bulletin Version, one approved Line Layout at one exact
// revision, and one approved Capacity Standard bound to that revision. The
// release freezes all three and is immutable from the instant it exists.
//
// ── FOUR EFFECTS, AND ONLY FOUR ────────────────────────────────────────────
//   1. allocate the next version number for this style's release line;
//   2. create the immutable release;
//   3. supersede the release it replaces;
//   4. record the answer in the command ledger.
//
// There is no fifth. No outbox, no event, no PPC receipt, no work-order write.
// Delivery is a READ of this collection, and an event that delivers nothing does
// not belong inside a transaction that guards a version chain.
//
// ── ALL FOUR ARE ONE FACT, OR NONE OF THEM HAPPEN ──────────────────────────
// They span three documents. A crash between the second and the third would
// leave two ISSUED releases in one chain — a chain with two heads, which every
// downstream reader would then have to disambiguate by guessing. So the command
// runs inside a real MongoDB transaction and FAILS CLOSED where it cannot: a
// standalone `mongod` accepts a session and then commits outside it, so support
// is settled by the repository's own probe before any domain work. Store &
// Purchase's degraded MARKED mode is safe for a single-document effect with a
// marker; a multi-document version chain has no equivalent marker, so it is not
// accepted here.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");
const IeCommandLedger = require("../../models/CMS_Models/IndustrialEngineering/IeCommandLedger");
const IeBulletinVersion = require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");
const IeLineLayout = require("../../models/CMS_Models/IndustrialEngineering/IeLineLayout");
const IeCapacityStandard = require("../../models/CMS_Models/IndustrialEngineering/IeCapacityStandard");
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const IeOperation = require("../../models/CMS_Models/IndustrialEngineering/IeOperation");
const { fail } = require("../storePurchase/errors");
const { transactionsAvailable } = require("../storePurchase/unitOfWork.service");
const { calculateLineBalance } = require("./lineBalanceCalculation");
const capacity = require("./ieCapacityStandard.service");
const { aggregateFingerprintOf, requestHashOf } = require("./releaseFingerprint");

const { STATE, LIMITS } = IeRelease;

/** The ledger scope. One command, one scope; two commands sharing a key are
 *  two different things and must not replay each other's answers. */
const SCOPE = "IE_RELEASE_ISSUE";

/* ═══ HELPERS ══════════════════════════════════════════════════════════════ */

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v ?? ""));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const mintEventId = () => `rel_${crypto.randomBytes(9).toString("hex")}`;
const actorName = (actor) => str(actor?.name || actor?.email);
const actorId = (actor) => (isId(actor?.id) ? oid(actor.id) : null);

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

const fileNotFound = () => fail("IE_FILE_NOT_FOUND", "That engineering file was not found.");

const event = (type, { actor, versionNo, summary = "" }) => ({
  eventId: mintEventId(),
  type,
  at: new Date(),
  actorId: actorId(actor),
  actorName: actorName(actor),
  versionNo,
  summary: summary.slice(0, LIMITS.SUMMARY),
});

/* ═══ THE ACCEPTED SURFACE ═════════════════════════════════════════════════ */

const BODY_FIELDS = Object.freeze([
  "bulletinVersionId", "expectedBulletinVersionNo",
  "lineLayoutId", "expectedLayoutRevision",
  "capacityStandardId", "expectedCapacityRevision",
  "retiredOperationOverrides", "note",
]);
const OVERRIDE_FIELDS = Object.freeze(["ieOperationId", "ieOperationRevision", "reason"]);

/* Server-owned facts somebody will reasonably try to send, refused by name. */
const REFUSED_FIELDS = Object.freeze({
  companyId: "the company — that comes from your own membership, never a body",
  releaseRef: "the release reference, which the server owns and keeps stable across versions",
  versionNo: "a release version number, which the server allocates",
  state: "its own state — a release exists only once it is issued",
  aggregateFingerprint: "an aggregate fingerprint, which only the server computes",
  source: "the frozen payload, which the server copies from the approved records",
  issuedBy: "who issued it, which comes from your session",
  issuedByName: "who issued it, which comes from your session",
  issuedAt: "when it was issued, which the server stamps",
  supersededByVersionNo: "a supersession, which only the issue transaction writes",
  history: "its own audit trail",
  ieStyleFileId: "which engineering file it is for — that is in the address",
  sampleStyleId: "which style it is for, which the server reads from the file",
  idempotencyKey: "the idempotency key, which travels in the `Idempotency-Key` header",
  acknowledgement: "an acknowledgement, which is Planning's answer and a later chunk",
  acknowledgedAt: "an acknowledgement, which is Planning's answer and a later chunk",
  workOrderId: "a work order. Releasing publishes nothing into Production",
  barcodeId: "a barcode. Releasing changes no printed piece",
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
      refused ? `A release cannot carry ${refused}.` : `"${key}" is not part of ${what}.`,
      {
        field: key,
        fieldErrors: [{
          field: key, code: "NOT_ACCEPTED",
          message: refused ? `This command does not accept "${key}".` : `"${key}" is not part of ${what}.`,
        }],
      });
  }
}

function readId(value, field) {
  if (!isId(value)) {
    throw fail("VALIDATION", `${field} is an id.`, {
      field, fieldErrors: [{ field, code: "NOT_AN_ID", message: `${field} is an id.` }],
    });
  }
  return oid(value);
}

function readVersionNumber(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw fail("VALIDATION", `${field} is a whole number.`, {
      field, fieldErrors: [{ field, code: "NOT_AN_INTEGER", message: `${field} is a whole number.` }],
    });
  }
  return n;
}

const normalize = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

/* ═══ THE AGGREGATE, PROVED ════════════════════════════════════════════════
 *
 * Every member must belong to this company, this file and this style, be
 * APPROVED, match the revision the caller says they read, and still be bound to
 * the members beside it. Unapproved members are collected and returned TOGETHER:
 * an engineer told about one at a time learns only that the system is
 * withholding.
 */

async function resolveAggregate(ctx, file, body) {
  const bulletinVersionId = readId(body.bulletinVersionId, "bulletinVersionId");
  const lineLayoutId = readId(body.lineLayoutId, "lineLayoutId");
  const capacityStandardId = readId(body.capacityStandardId, "capacityStandardId");
  const expectedBulletinVersionNo = readVersionNumber(body.expectedBulletinVersionNo, "expectedBulletinVersionNo");
  const expectedLayoutRevision = readVersionNumber(body.expectedLayoutRevision, "expectedLayoutRevision");
  const expectedCapacityRevision = readVersionNumber(body.expectedCapacityRevision, "expectedCapacityRevision");

  /* Every lookup is scoped by company AND by this file, so a member belonging
     to another company, another file or another style is indistinguishable from
     one that does not exist. */
  const [version, layout, standard] = await Promise.all([
    IeBulletinVersion.findOne({
      _id: bulletinVersionId, companyId: ctx.companyId,
      ieStyleFileId: file._id, sampleStyleId: file.sampleStyleId,
    }).lean(),
    IeLineLayout.findOne({
      _id: lineLayoutId, companyId: ctx.companyId,
      ieStyleFileId: file._id, sampleStyleId: file.sampleStyleId,
    }).lean(),
    IeCapacityStandard.findOne({
      _id: capacityStandardId, companyId: ctx.companyId, ieStyleFileId: file._id,
    }).lean(),
  ]);

  /* ── EVERY UNAPPROVED MEMBER, TOGETHER ────────────────────────────────── */
  const unapproved = [];
  const member = (kind, id, doc, approvedState) => {
    if (!doc) return unapproved.push({ member: kind, id: String(id), reason: "NOT_FOUND", state: null });
    if (doc.state !== undefined ? doc.state !== approvedState : doc.status !== approvedState) {
      return unapproved.push({
        member: kind, id: String(id), reason: "NOT_APPROVED",
        state: doc.state ?? doc.status ?? null,
      });
    }
    return null;
  };
  member("BULLETIN_VERSION", bulletinVersionId, version, "APPROVED");
  member("LINE_LAYOUT", lineLayoutId, layout, "APPROVED");
  member("CAPACITY_STANDARD", capacityStandardId, standard, "APPROVED");
  if (unapproved.length) {
    throw fail("IE_RELEASE_NOT_APPROVED",
      `${unapproved.length} member${unapproved.length === 1 ? "" : "s"} of this aggregate `
      + `${unapproved.length === 1 ? "is" : "are"} not an approved record of this style file.`,
      { fileId: String(file._id), members: unapproved });
  }

  /* ── THE REVISIONS THE CALLER SAYS THEY READ ──────────────────────────── */
  const conflicts = [];
  if (version.versionNo !== expectedBulletinVersionNo) {
    conflicts.push({
      member: "BULLETIN_VERSION", field: "expectedBulletinVersionNo",
      expected: expectedBulletinVersionNo, actual: version.versionNo,
    });
  }
  if (layout.revision !== expectedLayoutRevision) {
    conflicts.push({
      member: "LINE_LAYOUT", field: "expectedLayoutRevision",
      expected: expectedLayoutRevision, actual: layout.revision,
    });
  }
  if (standard.revision !== expectedCapacityRevision) {
    conflicts.push({
      member: "CAPACITY_STANDARD", field: "expectedCapacityRevision",
      expected: expectedCapacityRevision, actual: standard.revision,
    });
  }
  if (conflicts.length) {
    throw fail("IE_RELEASE_REVISION_CONFLICT",
      "Somebody changed part of this aggregate while you were reading it. Re-read it and decide again.",
      { fileId: String(file._id), conflicts });
  }

  /* ── THE LAYOUT IS A BALANCE OF THIS EXACT BULLETIN VERSION ───────────── */
  if (String(layout.ieBulletinVersionId || "") !== String(version._id)
    || Number(layout.bulletinVersionNo) !== Number(version.versionNo)) {
    throw fail("IE_RELEASE_CAPACITY_NOT_BOUND",
      "This line layout is not a balance of the bulletin version being released.",
      {
        lineLayoutId: String(layout._id),
        layoutBulletinVersionId: layout.ieBulletinVersionId ? String(layout.ieBulletinVersionId) : null,
        layoutBulletinVersionNo: layout.bulletinVersionNo ?? null,
        bulletinVersionId: String(version._id),
        bulletinVersionNo: version.versionNo,
      });
  }
  /* And its frozen evidence still IS that version's, field by field. */
  if (str(layout.sourceFingerprint) !== str(version.sourceFingerprint)
    || str(layout.sourceApprovalDigest) !== str(version.sourceApprovalDigest)
    || str(layout.sourceRequirementDigest) !== str(version.sourceRequirementDigest)
    || !sameFrozenRows(layout.sourceRows || [], version.rows || [])) {
    throw fail("IE_RELEASE_SOURCE_CHANGED",
      "This line layout's frozen source is no longer the bulletin version's. Nothing was released.",
      { lineLayoutId: String(layout._id), bulletinVersionId: String(version._id) });
  }

  /* ── THE LAYOUT IS STILL A COMPLETE PLAN ──────────────────────────────── */
  const metrics = calculateLineBalance(layout.stations || []);
  if (!metrics.metricsAvailable || !(layout.stations || []).length) {
    throw fail("IE_RELEASE_LAYOUT_NOT_READY",
      "This line layout has no calculable balance, so there is no line to release.",
      {
        lineLayoutId: String(layout._id),
        reason: metrics.metricsUnavailableReason || "NO_STATIONS",
      });
  }

  /* ── THE CAPACITY STANDARD IS A TARGET FOR THIS EXACT LAYOUT REVISION ── */
  if (String(standard.lineLayoutId) !== String(layout._id)
    || Number(standard.source?.lineLayoutRevision) !== Number(layout.revision)) {
    throw fail("IE_RELEASE_CAPACITY_NOT_BOUND",
      "This capacity standard is not a target for the line layout revision being released.",
      {
        capacityStandardId: String(standard._id),
        standardLineLayoutId: String(standard.lineLayoutId),
        standardLineLayoutRevision: standard.source?.lineLayoutRevision ?? null,
        lineLayoutId: String(layout._id),
        lineLayoutRevision: layout.revision,
      });
  }

  /* And its complete frozen source still matches the layout — re-derived by the
     capacity service's own comparison, never by a second one here. */
  const versionSource = layouts0SourceFor(version);
  const mismatches = capacity.frozenSourceMismatches(standard, layout, versionSource);
  if (mismatches.length) {
    throw fail("IE_RELEASE_SOURCE_CHANGED",
      "This capacity standard's frozen source no longer matches the line layout it names. "
      + "Nothing was released.",
      {
        capacityStandardId: String(standard._id),
        lineLayoutId: String(layout._id),
        reasons: [...new Set(mismatches.map((m) => m.code))],
        mismatches,
      });
  }

  /* ── AND ITS TARGET CAN ACTUALLY BE CALCULATED ────────────────────────── */
  const published = capacity.publishStandard(standard, {
    sourceState: capacity.SOURCE_STATE.CURRENT,
    current: versionSource,
    currentLineLayoutRevision: layout.revision,
    lineLayoutStatus: layout.status,
  });
  if (!published.calculation?.available) {
    throw fail("IE_RELEASE_CAPACITY_NOT_BOUND",
      "This capacity standard produces no calculable target, so there is nothing to release.",
      {
        capacityStandardId: String(standard._id),
        reasons: published.calculation?.unavailableReasons || [],
      });
  }

  return { version, layout, standard, metrics, published };
}

/** The version, in the shape the capacity service reads a layout source in. */
const layouts0SourceFor = (version) => ({
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

/** Two frozen row sets, compared on every field a layout copies from a version. */
function sameFrozenRows(a = [], b = []) {
  if (a.length !== b.length) return false;
  const shape = (r) => [
    r.rowId, r.sequence, String(r.ieOperationId), r.ieOperationRevision,
    r.operationCode || "", r.operationName || "",
    r.standardTimeMinutes, r.standardTimeSource || "",
    r.methodStudyId ? String(r.methodStudyId) : "",
    r.approvedSubmissionId || "",
    r.approvedAt ? new Date(r.approvedAt).getTime() : 0,
  ].join("|");
  return a.every((row, i) => shape(row) === shape(b[i]));
}

/* ═══ RETIRED OPERATIONS — ONE DECISION, TAKEN ONCE ════════════════════════
 *
 * Chunk 7C1 already refused to APPROVE a bulletin version naming a retired
 * operation, with no override at that gate. So an operation reaching this point
 * retired was ACTIVE when the bulletin was approved and was retired afterwards —
 * a library change nobody made against this plan.
 *
 * Blocking the release outright would strand an approved bulletin behind that
 * change, so it may be overridden. Once, with a reason, by somebody other than
 * the person who retired it, and with everything needed to re-examine the
 * decision frozen onto the release.
 */

function readOverrides(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw fail("VALIDATION", "Retired-operation overrides are a list.", {
      field: "retiredOperationOverrides",
      fieldErrors: [{ field: "retiredOperationOverrides", code: "NOT_A_LIST", message: "This is a list." }],
    });
  }
  const seen = new Set();
  return raw.map((entry, i) => {
    const at = (f) => `retiredOperationOverrides.${i}.${f}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw fail("VALIDATION", "An override is an object.", { field: `retiredOperationOverrides.${i}` });
    }
    for (const key of Object.keys(entry)) {
      if (OVERRIDE_FIELDS.includes(key)) continue;
      throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of a retired-operation override.`, {
        field: at(key),
        fieldErrors: [{ field: at(key), code: "NOT_ACCEPTED", message: `"${key}" is not accepted.`, index: i }],
      });
    }
    const ieOperationId = readId(entry.ieOperationId, at("ieOperationId"));
    const ieOperationRevision = readVersionNumber(entry.ieOperationRevision, at("ieOperationRevision"));

    /* ── A REASON, NORMALISED, AND LONG ENOUGH TO BE ONE ─────────────────
       An override replaces a rule with a judgement, and a judgement nobody
       wrote down is indistinguishable from a mistake six months later. Ten
       characters is not a high bar; it is high enough to exclude "ok". */
    const reason = normalize(entry.reason);
    if (!reason || reason.length < LIMITS.OVERRIDE_REASON_MIN) {
      throw fail("IE_RELEASE_OVERRIDE_REASON_REQUIRED",
        `Say why this retired operation may be released, in at least ${LIMITS.OVERRIDE_REASON_MIN} characters.`,
        {
          field: at("reason"),
          fieldErrors: [{ field: at("reason"), code: "REQUIRED", message: "Give a reason.", index: i }],
          ieOperationId: String(ieOperationId),
        });
    }
    if (reason.length > LIMITS.OVERRIDE_REASON_MAX) {
      throw fail("VALIDATION", `A reason is at most ${LIMITS.OVERRIDE_REASON_MAX} characters.`, {
        field: at("reason"),
        fieldErrors: [{ field: at("reason"), code: "TOO_LONG", message: "Too long.", index: i }],
      });
    }

    const key = `${String(ieOperationId)}@${ieOperationRevision}`;
    if (seen.has(key)) {
      throw fail("IE_RELEASE_OVERRIDE_NOT_APPLICABLE",
        "The same operation is overridden twice in one request.",
        { field: at("ieOperationId"), ieOperationId: String(ieOperationId), index: i });
    }
    seen.add(key);
    return { ieOperationId, ieOperationRevision, reason, index: i };
  });
}

/**
 * Prove every operation the bulletin names, and every override offered for one.
 *
 * Returns the frozen override evidence to store. Refuses with every uncovered
 * retired operation together — one at a time would be five round trips and an
 * engineer who learns only that the system is withholding.
 */
async function proveOperations(ctx, { version, overrides, actor }) {
  const rows = version.rows || [];
  const wanted = [...new Set(rows.map((r) => String(r.ieOperationId)))];
  const live = wanted.length
    ? await IeOperation.find({ _id: { $in: wanted.map(oid) }, companyId: ctx.companyId })
      .select("_id code name status revision statusChangedAt statusChangedBy statusChangedByName").lean()
    : [];
  const byId = new Map(live.map((o) => [String(o._id), o]));
  const rowByOperation = new Map();
  for (const row of rows) {
    if (!rowByOperation.has(String(row.ieOperationId))) rowByOperation.set(String(row.ieOperationId), row);
  }

  const approver = actorId(actor);
  const bulletinApprovedAt = version.approvedAt ? new Date(version.approvedAt) : null;
  const offered = new Map(overrides.map((o) => [String(o.ieOperationId), o]));
  const accepted = [];
  const uncovered = [];

  for (const operationId of wanted) {
    const op = byId.get(operationId);
    const row = rowByOperation.get(operationId);
    /* An operation the library no longer holds cannot be proved ACTIVE, and is
       reported with the retired ones rather than waved through. */
    if (!op || op.status !== "ACTIVE") {
      const offer = offered.get(operationId);
      if (!offer) {
        uncovered.push({
          ieOperationId: operationId,
          ieOperationRevision: row?.ieOperationRevision ?? null,
          operationCode: op?.code || row?.operationCode || "",
          operationName: op?.name || row?.operationName || "",
          status: op?.status ?? "NOT_IN_LIBRARY",
          retiredAt: op?.statusChangedAt ? new Date(op.statusChangedAt).toISOString() : null,
        });
        continue;
      }
      accepted.push(proveOverride({ offer, op, row, bulletinApprovedAt, approver, actor }));
    }
  }

  if (uncovered.length) {
    throw fail("IE_RELEASE_OPERATION_RETIRED",
      `${uncovered.length} operation${uncovered.length === 1 ? "" : "s"} on this bulletin `
      + `${uncovered.length === 1 ? "is" : "are"} no longer active in your company's library. `
      + "Name each one in `retiredOperationOverrides` with a reason, or restore it.",
      { bulletinVersionId: String(version._id), operations: uncovered });
  }

  /* An override offered for an operation that is not on the bulletin at all is
     not applicable — it decides nothing about this release. */
  for (const offer of overrides) {
    if (!rowByOperation.has(String(offer.ieOperationId))) {
      throw notApplicable(offer, "NOT_ON_BULLETIN",
        "That operation is not on the bulletin version being released.");
    }
    if (!accepted.some((a) => String(a.ieOperationId) === String(offer.ieOperationId))) {
      /* On the bulletin, and active — so there is nothing to override. */
      throw notApplicable(offer, "OPERATION_IS_ACTIVE",
        "That operation is active, so its retirement does not need overriding.");
    }
  }
  return accepted;
}

const notApplicable = (offer, code, message) => fail("IE_RELEASE_OVERRIDE_NOT_APPLICABLE", message, {
  field: `retiredOperationOverrides.${offer.index}.ieOperationId`,
  ieOperationId: String(offer.ieOperationId),
  ieOperationRevision: offer.ieOperationRevision,
  reason: code,
});

/**
 * One override, proved.
 *
 * Four conditions, and each exists because its absence would let a different
 * kind of wrong decision through.
 */
function proveOverride({ offer, op, row, bulletinApprovedAt, approver, actor }) {
  /* The revision has to be the one the bulletin FROZE. Overriding "whatever
     that operation is now" would sign off a row nobody read. */
  if (Number(offer.ieOperationRevision) !== Number(row.ieOperationRevision)) {
    throw notApplicable(offer, "REVISION_MISMATCH",
      `That override names revision ${offer.ieOperationRevision}, and the bulletin froze `
      + `revision ${row.ieOperationRevision}.`);
  }
  if (!op) {
    throw notApplicable(offer, "NOT_IN_LIBRARY",
      "That operation is not in your company's library, so its retirement cannot be examined.");
  }
  /* ── RETIRED AFTER THE BULLETIN WAS APPROVED, NOT BEFORE ───────────────
     One retired BEFORE approval could never have reached this gate — Chunk 7C1
     refuses to approve a bulletin naming one — so an override claiming it is
     describing something that did not happen. */
  const retiredAt = op.statusChangedAt ? new Date(op.statusChangedAt) : null;
  if (!retiredAt || !bulletinApprovedAt || retiredAt <= bulletinApprovedAt) {
    throw notApplicable(offer, "RETIRED_BEFORE_APPROVAL",
      "That operation was not retired after this bulletin version was approved, so there is no "
      + "post-approval retirement to override.");
  }
  /* ── AND NOT BY THE PERSON WHO RETIRED IT ──────────────────────────────
     Not a missing role — the wrong PERSON. An owner and a platform
     administrator are refused on identical terms, and the comparison is of
     stable ids: a name is editable by the person it belongs to. */
  if (op.statusChangedBy && String(op.statusChangedBy) === String(approver)) {
    throw fail("IE_RELEASE_OVERRIDE_MAKER_CHECKER",
      "The person who retired an operation may not be the person who overrides its retirement.",
      {
        field: `retiredOperationOverrides.${offer.index}.ieOperationId`,
        ieOperationId: String(offer.ieOperationId),
        retiredByName: op.statusChangedByName || "",
      });
  }

  return {
    ieOperationId: op._id,
    ieOperationRevision: row.ieOperationRevision,
    operationCode: op.code || "",
    operationName: op.name || "",
    retiredAt,
    retiredByName: op.statusChangedByName || "",
    bulletinApprovedAt,
    reason: offer.reason,
    overriddenBy: approver,
    overriddenByName: actorName(actor),
    overriddenAt: new Date(),
  };
}

/* ═══ THE FROZEN PAYLOAD ═══════════════════════════════════════════════════ */

const frozenRow = (r) => ({
  rowId: r.rowId,
  sequence: r.sequence,
  ieOperationId: r.ieOperationId,
  ieOperationRevision: r.ieOperationRevision,
  operationCode: r.operationCode || "",
  operationName: r.operationName || "",
  machineType: r.machineType || "",
  standardTimeMinutes: r.standardTimeMinutes,
  standardTimeSource: r.standardTimeSource || "",
  methodStudyId: r.methodStudyId ?? null,
  approvedSubmissionId: r.approvedSubmissionId || "",
  approvedAt: r.approvedAt ?? null,
  requirementSnapshot: r.requirementSnapshot ?? null,
});

/**
 * Everything the release freezes, copied and never referenced.
 *
 * The capacity standard's own publisher produces its half, so the release says
 * exactly what the standard says — including the provisional calendar truth,
 * which approval never cleared and a release must never quietly upgrade.
 */
function freezeAggregate({ version, layout, standard, metrics, published }) {
  return {
    bulletinVersionId: version._id,
    bulletinVersionNo: version.versionNo,
    sourceFingerprint: version.sourceFingerprint,
    sourceApprovalDigest: version.sourceApprovalDigest || "",
    sourceRequirementDigest: version.sourceRequirementDigest || "",
    rows: (version.rows || []).map(frozenRow),
    garmentSamMinutes: version.totals?.garmentSamMinutes ?? 0,
    samRowCount: version.totals?.samRowCount ?? 0,
    samDerivation: version.totals?.samDerivation || "",

    lineLayout: {
      id: layout._id,
      revision: layout.revision,
      approvedRevision: layout.approvedRevision ?? null,
      stationCount: (layout.stations || []).length,
      stations: (layout.stations || []).map((s) => ({
        stationId: s.stationId,
        sequence: s.sequence,
        label: s.label || "",
        note: s.note || "",
        plannedMachineTypes: (s.plannedMachineTypes || []).map((m) => ({
          machineType: m.machineType, quantity: m.quantity,
        })),
        assignments: (s.assignments || []).map((a) => ({
          rowId: a.rowId, sequence: a.sequence,
          operationCode: a.operationCode || "",
          standardTimeMinutes: a.standardTimeMinutes,
        })),
      })),
      metrics: {
        totalWorkContentMinutes: metrics.totalWorkContentMinutes,
        stationCount: metrics.stationCount,
        pitchMinutes: metrics.pitchMinutes,
        bottleneckMinutes: metrics.bottleneckMinutes,
        balanceEfficiencyPercent: metrics.balanceEfficiencyPercent,
        balanceLossPercent: metrics.balanceLossPercent,
        rounding: "HALF_UP_4DP",
      },
    },

    capacityStandard: {
      id: standard._id,
      revision: standard.revision,
      approvedRevision: standard.approvedRevision ?? null,
      inputs: published.inputs,
      calculation: published.calculation,
      rampCalculation: published.rampCalculation,
      /* ── THE PROVISIONAL TRUTH, CARRIED THROUGH VERBATIM ───────────────
         Approving a capacity standard accepted a stated assumption; it proved no
         calendar, and a release must not be the place that quietly says
         otherwise. So the linkage, the working-time source and the readiness —
         gaps and all — are copied exactly as the standard publishes them. */
      workingTimeSource: published.workingTimeSource,
      calendarLinkage: published.calendarLinkage,
      readiness: published.readiness,
    },
    ramp: published.ramp,

    capturedAt: new Date(),
  };
}

/* ═══ ISSUE ════════════════════════════════════════════════════════════════ */

/** The release line for one style file. Server-owned, stable across versions. */
const releaseRefFor = (file) => `IEREL-${String(file._id).slice(-10).toUpperCase()}`;

async function issueRelease(ctx, { fileId, body = {}, idempotencyKey, actor } = {}) {
  assertContext(ctx);
  const key = normalize(idempotencyKey);
  if (!key) {
    throw fail("IDEMPOTENCY_KEY_REQUIRED",
      "Issuing a release needs an `Idempotency-Key` header, so a retry cannot become a second release.",
      { header: "Idempotency-Key" });
  }
  refuseUnknown(body, BODY_FIELDS, "a release");

  if (!isId(fileId)) throw fileNotFound();
  const file = await IeStyleFile.findOne({ _id: oid(fileId), companyId: ctx.companyId })
    .select("_id companyId sampleStyleId revision").lean();
  if (!file) throw fileNotFound();

  const requestHash = requestHashOf({ fileId: String(file._id), ...body });

  /* ── A REPLAY, ANSWERED BEFORE ANY WORK ─────────────────────────────────
     And a DIFFERENT request under the same key refused loudly: replaying the
     first answer would tell somebody their second, different intention had
     succeeded. */
  const replayed = await replayFor(ctx, key, requestHash);
  if (replayed) return replayed;

  const note = normalize(body.note);
  if (note.length > LIMITS.NOTE) {
    throw fail("VALIDATION", `A note is at most ${LIMITS.NOTE} characters.`, {
      field: "note", fieldErrors: [{ field: "note", code: "TOO_LONG", message: "Too long." }],
    });
  }

  const overrides = readOverrides(body.retiredOperationOverrides);
  const aggregate = await resolveAggregate(ctx, file, body);
  const acceptedOverrides = await proveOperations(ctx, {
    version: aggregate.version, overrides, actor,
  });

  const source = freezeAggregate(aggregate);
  const aggregateFingerprint = aggregateFingerprintOf(source);

  /* ── EVERY ACCEPTED KEY IS BOUND, INCLUDING A NO-OP'S ───────────────────
     Which is why the transaction probe is consulted here rather than after the
     identical-aggregate check below. A no-op still ACCEPTS the command: it
     answers 200 with the release that already exists, and that answer has to be
     recorded, or the key would stay free to be reused for a different request
     and the second caller would be handed an unrelated release. Recording it
     needs a durable write, so a deployment that cannot make one fails closed
     here exactly as an issuing one does. */
  if (!(await transactionsAvailable())) {
    throw fail("IE_RELEASE_ATOMICITY_UNAVAILABLE",
      "Issuing a release writes the release, its predecessor's supersession and the command "
      + "ledger together, and this deployment cannot commit them as one. Nothing was written.",
      { requires: "MONGODB_TRANSACTIONS", wrote: "NOTHING" });
  }

  const releaseRef = releaseRefFor(file);
  const args = {
    file, releaseRef, source, aggregateFingerprint, note,
    overrides: acceptedOverrides, actor, key, requestHash,
  };

  /* ── AN IDENTICAL AGGREGATE IS A NO-OP, NOT A SECOND VERSION ────────────
     The caller asked for a state of the world that is already true. Detected
     here so an unchanged re-issue does no domain work, and DECIDED AGAIN inside
     the transaction that binds the key — because between this read and that
     write somebody else may have superseded it, and a ledger row claiming a
     release that is no longer the head would replay a stale answer for ever. */
  const already = await IeRelease.findOne({
    companyId: ctx.companyId, ieStyleFileId: file._id,
    aggregateFingerprint, state: STATE.ISSUED,
  }).lean();
  if (already) return runIssueTransaction(ctx, args);

  return runIssueTransaction(ctx, args);
}

/** The stored answer for this key, or null — refusing a changed request. */
async function replayFor(ctx, key, requestHash, session = null) {
  const q = IeCommandLedger.findOne({ companyId: ctx.companyId, scope: SCOPE, idempotencyKey: key });
  if (session) q.session(session);
  const row = await q.lean();
  if (!row) return null;
  if (str(row.requestHash) !== str(requestHash)) {
    throw fail("IDEMPOTENCY_KEY_REUSED",
      "That idempotency key was already used for a different release request. "
      + "Use a new key, or repeat the original request exactly.",
      { key, scope: SCOPE });
  }
  return { created: false, release: row.responseBody?.release ?? null, replayed: true };
}

/**
 * The four effects, inside one real transaction.
 *
 * Bounded retry: a concurrent command can lose on the version index or the
 * aggregate index, and either loss means somebody else committed the thing this
 * caller wanted. Re-reading and handing over the winner is the right answer;
 * looping for ever is not.
 */
async function runIssueTransaction(ctx, args, attempt = 0) {
  const session = await mongoose.startSession();
  try {
    let out = null;
    await session.withTransaction(async () => {
      out = await issueInside(ctx, args, session);
    });
    return out;
  } catch (err) {
    if (!isRaceLoss(err) || attempt >= 2) throw err;
    /* ── SOMEBODY ELSE COMMITTED WHILE THIS WAS IN FLIGHT ─────────────────
       The answer to this caller is the state of the world now — but it is still
       an ACCEPTED command under its own distinct key, so it is retried rather
       than answered from here. The retry re-enters the transaction, finds the
       winner as an identical aggregate, and binds THIS caller's key to it. A
       path that returned the winner directly would leave the loser's key free to
       be reused for a different request. */
    const replayed = await replayFor(ctx, args.key, args.requestHash);
    if (replayed) return replayed;
    return runIssueTransaction(ctx, args, attempt + 1);
  } finally {
    await session.endSession().catch(() => {});
  }
}

const isRaceLoss = (err) => err?.code === 11000
  || /E11000|duplicate key/i.test(str(err?.message))
  || err?.hasErrorLabel?.("TransientTransactionError");

async function issueInside(ctx, args, session) {
  const { file, releaseRef, source, aggregateFingerprint, note, overrides, actor, key, requestHash } = args;

  /* Re-checked INSIDE the transaction: a concurrent command may have written
     the ledger row between the read above and this write. */
  const replayed = await replayFor(ctx, key, requestHash, session);
  if (replayed) return replayed;

  /* ── THE NO-OP, DECIDED HERE AND BOUND HERE ────────────────────────────
     Re-read inside the transaction, so the release this key is bound to is the
     one that is the head AT COMMIT. Its ledger row records the 200 answer, which
     is what makes the key permanently spent: reusing it for a different request
     is then refused rather than quietly issuing something else. */
  const identical = await IeRelease.findOne({
    companyId: ctx.companyId, ieStyleFileId: file._id,
    aggregateFingerprint, state: STATE.ISSUED,
  }).session(session).lean();
  if (identical) {
    const release = publishRelease(identical);
    await bindKey(ctx, {
      key, requestHash, actor, session,
      release: identical, releaseRef, versionNo: identical.versionNo,
      aggregateFingerprint, responseStatus: 200,
      responseBody: { success: true, created: false, release },
    });
    return { created: false, release };
  }

  /* ── 1. ALLOCATE THE NEXT VERSION ──────────────────────────────────────
     The highest for this release line plus one — never a count, which would
     reuse a number the moment anything was ever removed. The unique index is
     the actual arbiter. */
  const highest = await IeRelease.findOne({ companyId: ctx.companyId, releaseRef })
    .sort({ versionNo: -1 }).select("versionNo").session(session).lean();
  const versionNo = (highest?.versionNo ?? 0) + 1;

  /* ── 2. CREATE THE IMMUTABLE RELEASE ───────────────────────────────────── */
  const issuedAt = new Date();
  const [created] = await IeRelease.create([{
    companyId: ctx.companyId,
    releaseRef,
    versionNo,
    ieStyleFileId: file._id,
    sampleStyleId: file.sampleStyleId,
    state: STATE.ISSUED,
    aggregateFingerprint,
    source,
    issuedBy: actorId(actor),
    issuedByName: actorName(actor),
    issuedAt,
    retiredOperationOverrides: overrides,
    note,
    history: [event("RELEASE_ISSUED", {
      actor, versionNo,
      summary: `Issued version ${versionNo} — bulletin version ${source.bulletinVersionNo}, `
        + `line layout revision ${source.lineLayout.revision}, `
        + `capacity standard revision ${source.capacityStandard.revision}`
        + (overrides.length ? `, ${overrides.length} retired-operation override(s)` : ""),
    })],
  }], { session });

  /* ── 3. SUPERSEDE THE PREDECESSOR ──────────────────────────────────────
     Read first, so the event pushed onto it carries ITS version number: an
     event on version 1 reading `versionNo: 2` would say version 2 was
     superseded, which is the opposite of what happened. */
  let supersededVersionNo = null;
  const standing = await IeRelease.findOne({
    companyId: ctx.companyId, releaseRef, state: STATE.ISSUED, _id: { $ne: created._id },
  }).select("_id versionNo").session(session).lean();

  if (standing) {
    const superseded = await IeRelease.findOneAndUpdate(
      { _id: standing._id, companyId: ctx.companyId, state: STATE.ISSUED },
      {
        $set: { state: STATE.SUPERSEDED, supersededByVersionNo: versionNo },
        $push: {
          history: {
            $each: [event("RELEASE_SUPERSEDED", {
              actor, versionNo: standing.versionNo,
              summary: `Superseded by version ${versionNo}`,
            })],
            $slice: -LIMITS.HISTORY,
          },
        },
      },
      { new: true, session },
    ).lean();
    if (!superseded) {
      /* It was ISSUED a moment ago inside this transaction, so a miss means
         something moved it concurrently and nothing here may commit. */
      throw fail("IE_RELEASE_REVISION_CONFLICT",
        "The release this one replaces moved while it was being issued. Nothing was released.",
        { releaseRef, versionNo: standing.versionNo });
    }
    supersededVersionNo = superseded.versionNo;
  }

  const release = publishRelease(created.toObject(), { supersededVersionNo });
  const responseBody = { success: true, created: true, release };

  /* ── 4. RECORD THE ANSWER ──────────────────────────────────────────────
     INSIDE the transaction. A ledger row written afterwards could survive a
     rollback and replay a release that does not exist; one written before could
     claim a release that was never created. */
  await bindKey(ctx, {
    key, requestHash, actor, session,
    release: created, releaseRef, versionNo,
    aggregateFingerprint, responseStatus: 201, responseBody,
  });

  return { created: true, release, supersededVersionNo };
}

/**
 * BIND ONE ACCEPTED KEY TO THE ANSWER IT WAS GIVEN.
 *
 * The single place a ledger row is written, so an issue and a no-op cannot drift
 * into recording different things. Always inside the caller's transaction: a row
 * written outside one could survive a rollback and replay a release that does
 * not exist, and a command whose ledger write failed must leave no trace at all
 * rather than a half-accepted key.
 */
async function bindKey(ctx, {
  key, requestHash, actor, session,
  release, releaseRef, versionNo, aggregateFingerprint, responseStatus, responseBody,
}) {
  await IeCommandLedger.create([{
    companyId: ctx.companyId,
    scope: SCOPE,
    idempotencyKey: key,
    requestHash,
    resultType: "IE_RELEASE",
    resultId: release._id,
    releaseRef,
    releaseVersionNo: versionNo,
    aggregateFingerprint,
    responseStatus,
    responseBody,
    actorId: actorId(actor),
    actorName: actorName(actor),
  }], { session });
}

/* ═══ PUBLISHING ═══════════════════════════════════════════════════════════ */

const publishEvent = (e) => ({
  eventId: e.eventId,
  type: e.type,
  at: e.at ? new Date(e.at).toISOString() : null,
  actorName: e.actorName || "",
  versionNo: e.versionNo,
  summary: e.summary || "",
});

function publishRelease(doc, { supersededVersionNo = null } = {}) {
  return {
    releaseId: String(doc._id),
    companyId: String(doc.companyId),
    releaseRef: doc.releaseRef,
    versionNo: doc.versionNo,
    styleFileId: String(doc.ieStyleFileId),
    sampleStyleId: String(doc.sampleStyleId),
    state: doc.state,
    aggregateFingerprint: doc.aggregateFingerprint,
    source: doc.source,
    issuedByName: doc.issuedByName || "",
    issuedAt: doc.issuedAt ? new Date(doc.issuedAt).toISOString() : null,
    supersededByVersionNo: doc.supersededByVersionNo ?? null,
    supersededPredecessorVersionNo: supersededVersionNo,
    retiredOperationOverrides: (doc.retiredOperationOverrides || []).map((o) => ({
      ieOperationId: String(o.ieOperationId),
      ieOperationRevision: o.ieOperationRevision,
      operationCode: o.operationCode || "",
      operationName: o.operationName || "",
      retiredAt: o.retiredAt ? new Date(o.retiredAt).toISOString() : null,
      retiredByName: o.retiredByName || "",
      bulletinApprovedAt: o.bulletinApprovedAt ? new Date(o.bulletinApprovedAt).toISOString() : null,
      reason: o.reason,
      overriddenByName: o.overriddenByName || "",
      overriddenAt: o.overriddenAt ? new Date(o.overriddenAt).toISOString() : null,
    })),
    note: doc.note || "",
    history: [...(doc.history || [])].reverse().map(publishEvent),
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    /* A release hands a plan over. It acknowledges nothing, books nothing and
       writes nothing into Production — those are later chunks and other
       departments, and a screen built against this cannot infer a control. */
    acknowledgement: null,
    booksCapacity: false,
    writesProduction: false,
  };
}

module.exports = { SCOPE, BODY_FIELDS, OVERRIDE_FIELDS, REFUSED_FIELDS,
  issueRelease, publishRelease, freezeAggregate, proveOperations, readOverrides, releaseRefFor,
  resolveAggregate, sameFrozenRows, refuseUnknown, normalize, event,
  aggregateFingerprintOf, requestHashOf, transactionsAvailable,
  IeRelease, IeCommandLedger, IeOperation, IeStyleFile, STATE, LIMITS,
  str, isId, oid, actorId, actorName, assertContext, fileNotFound, readId, readVersionNumber };
