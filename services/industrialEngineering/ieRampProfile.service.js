// services/industrialEngineering/ieRampProfile.service.js
//
// IE CHUNK 7B — COMPANY-SCOPED, VERSIONED RAMP PROFILES.
//
// A register of stated ramp assumptions, on exactly the terms every other IE
// register has held since Chunk 2A: company-scoped from proved membership,
// optimistic revisions, honest no-ops, reversible retirement instead of
// deletion, one active name, a bounded trail, and typed field-level refusals.
//
// ── WHAT A PROFILE MAY SAY ──────────────────────────────────────────────────
// That production days one to three are planned at forty per cent, four to ten
// at sixty, and eleven onward at eighty. That is the whole vocabulary. It cannot
// say what a line actually achieved, because it holds no date, no scan, no
// output, no operator and no machine — and there is no field one could be put
// in. Which stage applies to a capacity standard is stated by the person
// planning it, never inferred here.
//
// ── AND WHY THE STAGES MUST TILE ────────────────────────────────────────────
// Overlaps are refused because two stages claiming day five make the answer
// depend on which one a reader picks first. Gaps are refused because a profile
// silent about day five would hand a capacity standard nothing for that day, and
// this lane settled long ago what silence means: it is a gap, never a zero. A
// profile whose stages tile its own range from day one can produce neither.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const IeRampProfile = require("../../models/CMS_Models/IndustrialEngineering/IeRampProfile");
const { fail } = require("../storePurchase/errors");
const { encodeCursor, decodeCursor, pageSize } = require("./ieRead.service");

const { STATUS, LIMITS, nameKeyOf } = IeRampProfile;

/* ═══ THE ACCEPTED SURFACE ══════════════════════════════════════════════════ */

const CREATE_FIELDS = Object.freeze(["name", "description", "stages"]);
const PATCH_FIELDS = Object.freeze(["expectedRevision", "name", "description", "stages"]);
const STAGE_FIELDS = Object.freeze([
  "label", "fromProductionDay", "toProductionDay", "targetEfficiencyPercent",
]);
const LIFECYCLE_FIELDS = Object.freeze(["expectedRevision"]);

/* Fields somebody will reasonably try to send, refused BY NAME with where the
   fact actually lives. Every derived value and every concept this record must
   not hold is here — above all, anything that would turn a stated assumption
   into a claim about what happened. */
const REFUSED_FIELDS = Object.freeze({
  companyId: "the company — that comes from your own membership, never a body",
  rampProfileId: "its own id",
  status: "its own status — retire and restore are their own actions",
  revision: "its own revision — send `expectedRevision` to say which one you read",
  history: "its own audit trail",
  nameKey: "the uniqueness form of its name, which only the server derives",
  stageId: "a stage id, which the server mints",
  sequence: "a stage's order, which the server derives from its production days",
  /* ── THE LINE BETWEEN A PLAN AND AN OUTCOME ── */
  actualEfficiencyPercent: "an achieved efficiency. A ramp profile states what is PLANNED",
  achievedEfficiencyPercent: "an achieved efficiency. A ramp profile states what is PLANNED",
  actualOutput: "an actual output, which is Chunk 9 and Production's record",
  producedQuantity: "an actual output, which is Chunk 9 and Production's record",
  goodOutput: "an actual output, which is Chunk 9 and Production's record",
  startDate: "a calendar date. A stage is a production-DAY range, not a diary entry",
  endDate: "a calendar date. A stage is a production-DAY range, not a diary entry",
  runStartedAt: "when a run began, which nothing here observes",
  workOrderId: "a work order. A profile is a reusable assumption, bound to no order",
  barcodeId: "a barcode — a printed piece is Production's record",
  scanId: "a scan — Production owns scanning",
  machineId: "a specific machine. A ramp is an assumption about a LINE, not an allocation",
  employeeId: "an employee. A ramp plans efficiency, never people",
  operatorId: "an operator. A ramp plans efficiency, never people",
  attendance: "attendance, which HR owns",
  availability: "an availability, which Maintenance and Production own",
  calendarId: "a working-calendar reference. A ramp is counted in production days, "
    + "not calendar days, and no authoritative company working-time calendar exists to cite",
  approvedAt: "an approval. Nothing here approves or releases anything",
  releasedAt: "a release. Nothing here approves or releases anything",
});

/* ═══ HELPERS ══════════════════════════════════════════════════════════════ */

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v ?? ""));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const mintStageId = () => `rst_${crypto.randomBytes(9).toString("hex")}`;
const mintEventId = () => `rpe_${crypto.randomBytes(9).toString("hex")}`;

const actorName = (actor) => str(actor?.name || actor?.email);
const actorId = (actor) => (isId(actor?.id) ? oid(actor.id) : null);

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

/** One indistinguishable refusal for absent, foreign and malformed alike. */
const profileNotFound = () => fail("IE_RAMP_PROFILE_NOT_FOUND", "That ramp profile was not found.");

const isDuplicateKey = (err) => err?.code === 11000 || /E11000|duplicate key/i.test(str(err?.message));

const duplicateName = (name) => fail("IE_RAMP_PROFILE_NAME_TAKEN",
  `Another active ramp profile in this company is already called ${name}.`,
  { field: "name", name, fieldErrors: [{ field: "name", code: "TAKEN", message: "That name is taken." }] });

const event = (type, { actor, profileRevision, changed = [], summary = "" }) => ({
  eventId: mintEventId(),
  type,
  at: new Date(),
  actorId: actorId(actor),
  actorName: actorName(actor),
  profileRevision,
  changed: [...changed],
  summary: summary.slice(0, LIMITS.SUMMARY),
});

/** Anything not on the allowlist is refused by name, never quietly dropped. */
function refuseUnknown(body, allowed, what) {
  if (body === null || body === undefined) return;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw fail("VALIDATION", `${what} is an object.`, { field: "body" });
  }
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue;
    const refused = REFUSED_FIELDS[key];
    throw fail("FIELD_NOT_ACCEPTED",
      refused ? `A ramp profile cannot carry ${refused}.` : `"${key}" is not part of ${what}.`,
      {
        field: key,
        fieldErrors: [{
          field: key, code: "NOT_ACCEPTED",
          message: refused ? `This record does not accept "${key}".` : `"${key}" is not part of ${what}.`,
        }],
      });
  }
}

function readExpectedRevision(value) {
  if (value === undefined || value === null || value === "") {
    throw fail("VALIDATION", "Say which revision of this ramp profile you read.", {
      field: "expectedRevision",
      fieldErrors: [{ field: "expectedRevision", code: "REQUIRED", message: "Say which revision of this ramp profile you read." }],
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

const text = (raw, field, max, errs, index) => {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") {
    errs.push({ field, code: "NOT_TEXT", message: `${field} is text.`, ...(index === undefined ? {} : { index }) });
    return "";
  }
  const value = raw.replace(/\s+/g, " ").trim();
  if (value.length > max) {
    errs.push({
      field, code: "TOO_LONG", message: `${field} is at most ${max} characters.`,
      ...(index === undefined ? {} : { index }),
    });
    return "";
  }
  return value;
};

function readName(value, { required = true } = {}) {
  const errs = [];
  const name = text(value, "name", LIMITS.NAME, errs);
  if (errs.length) {
    throw fail("VALIDATION", `A ramp profile name is at most ${LIMITS.NAME} characters.`,
      { field: "name", fieldErrors: errs });
  }
  if (!name && required) {
    throw fail("VALIDATION", "Give this ramp profile a name.", {
      field: "name",
      fieldErrors: [{ field: "name", code: "REQUIRED", message: "Give this ramp profile a name." }],
    });
  }
  return name;
}

function readDescription(value) {
  const errs = [];
  const description = text(value, "description", LIMITS.DESCRIPTION, errs);
  if (errs.length) {
    throw fail("VALIDATION", `A description is at most ${LIMITS.DESCRIPTION} characters.`,
      { field: "description", fieldErrors: errs });
  }
  return description;
}

/* ═══ THE STAGES ═══════════════════════════════════════════════════════════ */

const stageErrors = (errs) => fail("IE_RAMP_STAGE_INVALID",
  errs.length === 1 ? errs[0].message : `${errs.length} ramp stages are not usable.`,
  { field: errs[0].field, fieldErrors: errs });

/**
 * Read, validate and ORDER the stages.
 *
 * Ordering is deterministic and derived, never sent: stages are sorted by their
 * first production day, and `sequence` is assigned from that order. A caller
 * cannot express two different orders for the same day ranges, so two profiles
 * with the same stages are the same profile.
 *
 * Existing stage ids are preserved by day range where an edit leaves a stage
 * where it was, so a capacity standard that froze `stageId` can still be
 * explained against the profile it came from.
 */
function shapeStages(raw, { existing = [] } = {}) {
  /* Absent, null and empty are one answer: a ramp profile with no stages says
     nothing, and would publish a stage count of zero that a picker would read as
     a profile ready to use. */
  if (raw === undefined || raw === null || (Array.isArray(raw) && !raw.length)) {
    throw stageErrors([{
      field: "stages", code: "REQUIRED",
      message: "A ramp profile states at least one stage.",
    }]);
  }
  if (!Array.isArray(raw)) {
    throw stageErrors([{ field: "stages", code: "NOT_A_LIST", message: "Stages are a list." }]);
  }
  if (raw.length > LIMITS.STAGES) {
    throw stageErrors([{
      field: "stages", code: "TOO_MANY",
      message: `A ramp profile holds at most ${LIMITS.STAGES} stages.`,
    }]);
  }

  const errs = [];
  const read = raw.map((entry, i) => {
    const at = (f) => `stages.${i}.${f}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errs.push({ field: `stages.${i}`, code: "NOT_AN_OBJECT", message: "A stage is an object.", index: i });
      return null;
    }
    for (const field of Object.keys(entry)) {
      if (STAGE_FIELDS.includes(field)) continue;
      const refused = REFUSED_FIELDS[field];
      throw fail("FIELD_NOT_ACCEPTED",
        refused ? `A ramp stage cannot carry ${refused}.` : `"${field}" is not part of a ramp stage.`,
        {
          field: at(field),
          fieldErrors: [{ field: at(field), code: "NOT_ACCEPTED", message: `"${field}" is not accepted.`, index: i }],
        });
    }

    const label = text(entry.label, at("label"), LIMITS.LABEL, errs, i);
    const from = readDay(entry.fromProductionDay, at("fromProductionDay"), errs, i, { required: true });
    /* Null is a real answer on the last stage and means "from here on". */
    const to = entry.toProductionDay === undefined || entry.toProductionDay === null
      ? null
      : readDay(entry.toProductionDay, at("toProductionDay"), errs, i, { required: false });
    const percent = readPercent(entry.targetEfficiencyPercent, at("targetEfficiencyPercent"), errs, i);

    if (from !== null && to !== null && to < from) {
      errs.push({
        field: at("toProductionDay"), code: "BEFORE_FROM", index: i,
        message: "A stage ends on or after the day it starts.",
      });
    }
    return { label, fromProductionDay: from, toProductionDay: to, targetEfficiencyPercent: percent };
  });

  if (errs.length) throw stageErrors(errs);

  /* ── DETERMINISTIC ORDER, DERIVED FROM THE DAYS THEMSELVES ────────────── */
  const ordered = read
    .map((s, i) => ({ ...s, submittedIndex: i }))
    .sort((a, b) => a.fromProductionDay - b.fromProductionDay
      || a.submittedIndex - b.submittedIndex);

  /* ── THE STAGES MUST TILE THE RUN FROM DAY ONE ────────────────────────── */
  const tiling = [];
  if (ordered[0].fromProductionDay !== 1) {
    tiling.push({
      field: `stages.${ordered[0].submittedIndex}.fromProductionDay`,
      code: "MUST_START_AT_DAY_ONE", index: ordered[0].submittedIndex,
      message: "A ramp starts on production day 1.",
    });
  }
  ordered.forEach((stage, n) => {
    const previous = ordered[n - 1];
    if (!previous) return;
    if (previous.toProductionDay === null) {
      /* An open-ended stage that is not the last one swallows every stage after
         it — two stages then claim the same day. */
      tiling.push({
        field: `stages.${previous.submittedIndex}.toProductionDay`,
        code: "OPEN_ENDED_NOT_LAST", index: previous.submittedIndex,
        message: "Only the last stage of a ramp may be open-ended.",
      });
      return;
    }
    if (stage.fromProductionDay <= previous.toProductionDay) {
      tiling.push({
        field: `stages.${stage.submittedIndex}.fromProductionDay`,
        code: "OVERLAPS_PREVIOUS_STAGE", index: stage.submittedIndex,
        message: `Production day ${stage.fromProductionDay} is already covered by the stage `
          + `for days ${previous.fromProductionDay}–${previous.toProductionDay}.`,
      });
      return;
    }
    if (stage.fromProductionDay > previous.toProductionDay + 1) {
      tiling.push({
        field: `stages.${stage.submittedIndex}.fromProductionDay`,
        code: "LEAVES_A_GAP", index: stage.submittedIndex,
        message: `Nothing states an efficiency for production day ${previous.toProductionDay + 1}. `
          + "A ramp covers every day it spans — a day with no stage would be unknown, not zero.",
      });
    }
  });
  if (tiling.length) throw stageErrors(tiling);

  /* ── IDS: KEPT WHERE A STAGE STAYED, MINTED WHERE IT DID NOT ──────────── */
  const byRange = new Map(
    (existing || []).map((s) => [`${s.fromProductionDay}:${s.toProductionDay ?? "end"}`, s.stageId]),
  );
  return ordered.map((s, n) => {
    const key = `${s.fromProductionDay}:${s.toProductionDay ?? "end"}`;
    const stageId = byRange.get(key) || mintStageId();
    byRange.delete(key);
    return {
      stageId,
      sequence: n + 1,
      label: s.label,
      fromProductionDay: s.fromProductionDay,
      toProductionDay: s.toProductionDay,
      targetEfficiencyPercent: s.targetEfficiencyPercent,
    };
  });
}

function readDay(raw, field, errs, index, { required }) {
  if (raw === undefined || raw === null || raw === "") {
    if (required) errs.push({ field, code: "REQUIRED", message: `${field} is required.`, index });
    return null;
  }
  if (typeof raw === "boolean" || typeof raw === "object") {
    errs.push({ field, code: "NOT_A_NUMBER", message: `${field} is a whole number of production days.`, index });
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    errs.push({ field, code: "NOT_A_NUMBER", message: `${field} is a whole number of production days.`, index });
    return null;
  }
  if (!Number.isInteger(n)) {
    errs.push({ field, code: "NOT_AN_INTEGER", message: `${field} is a whole number of production days.`, index });
    return null;
  }
  if (n < 1) {
    errs.push({ field, code: "TOO_SMALL", message: "A production day is 1 or more.", index });
    return null;
  }
  if (n > LIMITS.PRODUCTION_DAY) {
    errs.push({ field, code: "TOO_LARGE", message: `A production day is at most ${LIMITS.PRODUCTION_DAY}.`, index });
    return null;
  }
  return n;
}

/** The same rule Chunk 7A's steady-state target obeys, stated once more here. */
function readPercent(raw, field, errs, index) {
  if (raw === undefined || raw === null || raw === "") {
    errs.push({ field, code: "REQUIRED", message: `${field} is required.`, index });
    return null;
  }
  if (typeof raw === "boolean" || typeof raw === "object") {
    errs.push({ field, code: "NOT_A_NUMBER", message: `${field} is a number.`, index });
    return null;
  }
  const n = Number(raw);
  if (Number.isNaN(n)) {
    errs.push({ field, code: "NOT_A_NUMBER", message: `${field} is a number.`, index });
    return null;
  }
  if (!Number.isFinite(n)) {
    errs.push({ field, code: "NOT_FINITE", message: `${field} is a finite number.`, index });
    return null;
  }
  if (n <= 0) {
    errs.push({
      field, code: "TOO_SMALL", index,
      message: `${field} is greater than 0 and at most 100.`,
    });
    return null;
  }
  if (n > 100) {
    errs.push({
      field, code: "TOO_LARGE", index,
      message: `${field} is greater than 0 and at most 100.`,
    });
    return null;
  }
  return n;
}

/* ═══ PUBLISHING ═══════════════════════════════════════════════════════════ */

const publishStage = (s) => ({
  stageId: s.stageId,
  sequence: s.sequence,
  label: s.label || "",
  fromProductionDay: s.fromProductionDay,
  toProductionDay: s.toProductionDay ?? null,
  targetEfficiencyPercent: s.targetEfficiencyPercent,
  efficiencyUnit: "PERCENT",
});

const publishEvent = (e) => ({
  eventId: e.eventId,
  type: e.type,
  at: e.at ? new Date(e.at).toISOString() : null,
  actorName: e.actorName || "",
  profileRevision: e.profileRevision,
  changed: Array.isArray(e.changed) ? [...e.changed] : [],
  summary: e.summary || "",
});

function publishProfile(doc, { withHistory = false } = {}) {
  const stages = (doc.stages || []).map(publishStage);
  const last = stages[stages.length - 1];
  return {
    rampProfileId: String(doc._id),
    companyId: String(doc.companyId),
    name: doc.name,
    description: doc.description || "",
    status: doc.status,
    isActive: doc.status === STATUS.ACTIVE,
    revision: doc.revision,
    stages,
    stageCount: stages.length,
    /* Null when the ramp runs open-ended, which is an answer and not a limit. */
    coversThroughProductionDay: last ? last.toProductionDay : null,
    statusChangedAt: doc.statusChangedAt ? new Date(doc.statusChangedAt).toISOString() : null,
    statusChangedByName: doc.statusChangedByName || "",
    ...(withHistory ? { history: [...(doc.history || [])].reverse().map(publishEvent) } : {}),
    createdByName: doc.createdByName || "",
    updatedByName: doc.updatedByName || "",
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    /* A stated assumption. It approves nothing, releases nothing, and observes
       nothing about what a line actually did. */
    canApprove: false,
    canRelease: false,
    describesActuals: false,
  };
}

/* ═══ CREATE ═══════════════════════════════════════════════════════════════ */

async function createProfile(ctx, { body = {}, actor } = {}) {
  assertContext(ctx);
  refuseUnknown(body, CREATE_FIELDS, "a new ramp profile");

  const name = readName(body.name);
  const description = readDescription(body.description);
  const stages = shapeStages(body.stages);

  try {
    const created = await IeRampProfile.create({
      companyId: ctx.companyId,
      name, nameKey: nameKeyOf(name), description, stages,
      status: STATUS.ACTIVE,
      revision: 1,
      history: [event("RAMP_PROFILE_CREATED", {
        actor, profileRevision: 1, changed: ["name", "stages"],
        summary: `Ramp profile created with ${stages.length} stage${stages.length === 1 ? "" : "s"}`,
      })],
      createdBy: actorId(actor), createdByName: actorName(actor),
      updatedBy: actorId(actor), updatedByName: actorName(actor),
    });
    return { created: true, profile: publishProfile(created.toObject(), { withHistory: true }) };
  } catch (err) {
    /* The index decides, not a look-then-insert: two simultaneous creates both
       pass a pre-check and only one can hold the name. */
    if (isDuplicateKey(err)) throw duplicateName(name);
    throw err;
  }
}

/* ═══ READ AND LIST ════════════════════════════════════════════════════════ */

async function loadOwnedProfile(ctx, rampProfileId) {
  assertContext(ctx);
  if (!isId(rampProfileId)) throw profileNotFound();
  const doc = await IeRampProfile.findOne({ _id: oid(rampProfileId), companyId: ctx.companyId }).lean();
  if (!doc) throw profileNotFound();
  return doc;
}

async function readProfile(ctx, { rampProfileId } = {}) {
  const doc = await loadOwnedProfile(ctx, rampProfileId);
  return { profile: publishProfile(doc, { withHistory: true }) };
}

/** The company's profiles, newest first — retired ones included and labelled. */
async function listProfiles(ctx, { status, limit, cursor } = {}) {
  assertContext(ctx);
  const size = pageSize(limit);
  const after = decodeCursor(cursor, "time");

  const wanted = str(status).toUpperCase();
  if (wanted && !Object.values(STATUS).includes(wanted)) {
    throw fail("VALIDATION", "A ramp profile is ACTIVE or RETIRED.", {
      field: "status",
      fieldErrors: [{ field: "status", code: "INVALID", message: "ACTIVE or RETIRED." }],
    });
  }

  const and = [{ companyId: ctx.companyId }];
  if (wanted) and.push({ status: wanted });
  if (after) {
    and.push({
      $or: [
        { createdAt: { $lt: new Date(after.t) } },
        { createdAt: new Date(after.t), _id: { $lt: oid(after.i) } },
      ],
    });
  }

  const found = await IeRampProfile.find({ $and: and })
    .sort({ createdAt: -1, _id: -1 }).limit(size + 1).lean();
  const page = found.slice(0, size);
  const last = page[page.length - 1];
  return {
    profiles: page.map((p) => publishProfile(p)),
    statusFilter: wanted || null,
    limit: size,
    hasMore: found.length > size,
    nextCursor: found.length > size
      ? encodeCursor({ t: new Date(last.createdAt).getTime(), i: String(last._id) })
      : null,
    sort: "createdAt:desc,_id:desc",
  };
}

/* ═══ EDIT ═════════════════════════════════════════════════════════════════ */

const sameStages = (a = [], b = []) => a.length === b.length && a.every((s, i) => (
  s.fromProductionDay === b[i].fromProductionDay
  && (s.toProductionDay ?? null) === (b[i].toProductionDay ?? null)
  && Number(s.targetEfficiencyPercent) === Number(b[i].targetEfficiencyPercent)
  && str(s.label) === str(b[i].label)
));

function changedCategories(before, after) {
  const changed = [];
  if (str(before.name) !== str(after.name)) changed.push("name");
  if (str(before.description) !== str(after.description)) changed.push("description");
  if (!sameStages(before.stages || [], after.stages || [])) changed.push("stages");
  return changed;
}

async function updateProfile(ctx, { rampProfileId, body = {}, actor } = {}) {
  const current = await loadOwnedProfile(ctx, rampProfileId);
  refuseUnknown(body, PATCH_FIELDS, "a ramp profile edit");
  const expected = readExpectedRevision(body.expectedRevision);

  if (current.status === STATUS.RETIRED) {
    throw fail("IE_RAMP_PROFILE_ALREADY_RETIRED",
      "This ramp profile is retired. Restore it before editing it.",
      { rampProfileId: String(current._id), allowedAction: "RESTORE" });
  }
  /* A stale request conflicts even when its outcome would be a no-op: the
     caller decided from a state that no longer exists. */
  if (current.revision !== expected) {
    throw fail("IE_RAMP_PROFILE_REVISION_CONFLICT",
      "Somebody changed this ramp profile while you were reading it. Re-read it and decide again.",
      { expected, actual: current.revision, rampProfileId: String(current._id) });
  }

  const after = {
    name: body.name === undefined ? current.name : readName(body.name),
    description: body.description === undefined ? str(current.description) : readDescription(body.description),
    stages: body.stages === undefined
      ? (current.stages || [])
      : shapeStages(body.stages, { existing: current.stages || [] }),
  };

  const changed = changedCategories(current, after);
  if (!changed.length) {
    /* An honest no-op: nothing written, no revision, no timestamp, no entry. */
    return { updated: false, profile: publishProfile(current, { withHistory: true }), events: [] };
  }

  const nextRevision = expected + 1;
  const audit = event("RAMP_PROFILE_EDITED", {
    actor, profileRevision: nextRevision, changed,
    summary: `Changed ${changed.join(", ")}`,
  });

  const $set = {
    description: after.description,
    stages: after.stages,
    updatedBy: actorId(actor), updatedByName: actorName(actor),
  };
  if (changed.includes("name")) {
    $set.name = after.name;
    $set.nameKey = nameKeyOf(after.name);
  }

  let updated;
  try {
    updated = await IeRampProfile.findOneAndUpdate(
      { _id: current._id, companyId: ctx.companyId, revision: expected, status: STATUS.ACTIVE },
      { $set, $inc: { revision: 1 }, $push: { history: { $each: [audit], $slice: -LIMITS.HISTORY } } },
      { new: true },
    ).lean();
  } catch (err) {
    if (isDuplicateKey(err)) throw duplicateName(after.name);
    throw err;
  }

  if (!updated) {
    const now = await IeRampProfile.findOne({ _id: current._id, companyId: ctx.companyId })
      .select("_id revision status").lean();
    if (!now) throw profileNotFound();
    if (now.status === STATUS.RETIRED) {
      throw fail("IE_RAMP_PROFILE_ALREADY_RETIRED",
        "This ramp profile is retired. Restore it before editing it.",
        { rampProfileId: String(now._id), allowedAction: "RESTORE" });
    }
    throw fail("IE_RAMP_PROFILE_REVISION_CONFLICT",
      "Somebody changed this ramp profile while you were reading it. Re-read it and decide again.",
      { expected, actual: now.revision, rampProfileId: String(now._id) });
  }

  return {
    updated: true,
    profile: publishProfile(updated, { withHistory: true }),
    events: [publishEvent(audit)],
  };
}

/* ═══ RETIRE AND RESTORE ═══════════════════════════════════════════════════
 *
 * Retiring removes no record and rewrites no capacity standard. It takes the
 * profile out of the pickers and RELEASES its active name, which is why
 * restoring can be refused: two active profiles of one name would be chosen
 * between by whichever a screen listed first.
 */

async function retireProfile(ctx, { rampProfileId, body = {}, actor } = {}) {
  const current = await loadOwnedProfile(ctx, rampProfileId);
  refuseUnknown(body, LIFECYCLE_FIELDS, "a ramp profile retirement");
  const expected = readExpectedRevision(body.expectedRevision);

  if (current.status === STATUS.RETIRED) {
    throw fail("IE_RAMP_PROFILE_ALREADY_RETIRED", "This ramp profile is already retired.",
      { rampProfileId: String(current._id), allowedAction: "RESTORE" });
  }
  if (current.revision !== expected) {
    throw fail("IE_RAMP_PROFILE_REVISION_CONFLICT",
      "Somebody changed this ramp profile while you were reading it. Re-read it and decide again.",
      { expected, actual: current.revision, rampProfileId: String(current._id) });
  }

  const nextRevision = expected + 1;
  const audit = event("RAMP_PROFILE_RETIRED", {
    actor, profileRevision: nextRevision, changed: ["status"],
    summary: "Retired",
  });
  const updated = await IeRampProfile.findOneAndUpdate(
    { _id: current._id, companyId: ctx.companyId, revision: expected, status: STATUS.ACTIVE },
    {
      $set: {
        status: STATUS.RETIRED, statusChangedAt: new Date(), statusChangedByName: actorName(actor),
        updatedBy: actorId(actor), updatedByName: actorName(actor),
      },
      $inc: { revision: 1 },
      $push: { history: { $each: [audit], $slice: -LIMITS.HISTORY } },
    },
    { new: true },
  ).lean();

  if (!updated) {
    const fresh = await IeRampProfile.findOne({ _id: current._id, companyId: ctx.companyId })
      .select("_id revision status").lean();
    if (!fresh) throw profileNotFound();
    if (fresh.status === STATUS.RETIRED) {
      throw fail("IE_RAMP_PROFILE_ALREADY_RETIRED", "This ramp profile is already retired.",
        { rampProfileId: String(fresh._id), allowedAction: "RESTORE" });
    }
    throw fail("IE_RAMP_PROFILE_REVISION_CONFLICT",
      "Somebody changed this ramp profile while you were reading it. Re-read it and decide again.",
      { expected, actual: fresh.revision, rampProfileId: String(fresh._id) });
  }
  return { updated: true, profile: publishProfile(updated, { withHistory: true }), events: [publishEvent(audit)] };
}

async function restoreProfile(ctx, { rampProfileId, body = {}, actor } = {}) {
  const current = await loadOwnedProfile(ctx, rampProfileId);
  refuseUnknown(body, LIFECYCLE_FIELDS, "a ramp profile restoration");
  const expected = readExpectedRevision(body.expectedRevision);

  if (current.status === STATUS.ACTIVE) {
    throw fail("IE_RAMP_PROFILE_ALREADY_ACTIVE", "This ramp profile is already active.",
      { rampProfileId: String(current._id) });
  }
  if (current.revision !== expected) {
    throw fail("IE_RAMP_PROFILE_REVISION_CONFLICT",
      "Somebody changed this ramp profile while you were reading it. Re-read it and decide again.",
      { expected, actual: current.revision, rampProfileId: String(current._id) });
  }

  const nextRevision = expected + 1;
  const audit = event("RAMP_PROFILE_RESTORED", {
    actor, profileRevision: nextRevision, changed: ["status"],
    summary: "Restored",
  });

  let updated;
  try {
    updated = await IeRampProfile.findOneAndUpdate(
      { _id: current._id, companyId: ctx.companyId, revision: expected, status: STATUS.RETIRED },
      {
        $set: {
          status: STATUS.ACTIVE, statusChangedAt: new Date(), statusChangedByName: actorName(actor),
          updatedBy: actorId(actor), updatedByName: actorName(actor),
        },
        $inc: { revision: 1 },
        $push: { history: { $each: [audit], $slice: -LIMITS.HISTORY } },
      },
      { new: true },
    ).lean();
  } catch (err) {
    /* Retiring RELEASED the name, so another profile may hold it by now.
       Nothing is renamed automatically: the resolution is a deliberate act. */
    if (isDuplicateKey(err)) {
      throw fail("IE_RAMP_PROFILE_NAME_TAKEN",
        `Another active ramp profile in this company is already called ${current.name}. `
        + "Rename or retire that one, then restore this.",
        {
          field: "name", name: current.name,
          fieldErrors: [{ field: "name", code: "TAKEN", message: "That name is taken." }],
        });
    }
    throw err;
  }

  if (!updated) {
    const fresh = await IeRampProfile.findOne({ _id: current._id, companyId: ctx.companyId })
      .select("_id revision status").lean();
    if (!fresh) throw profileNotFound();
    if (fresh.status === STATUS.ACTIVE) {
      throw fail("IE_RAMP_PROFILE_ALREADY_ACTIVE", "This ramp profile is already active.",
        { rampProfileId: String(fresh._id) });
    }
    throw fail("IE_RAMP_PROFILE_REVISION_CONFLICT",
      "Somebody changed this ramp profile while you were reading it. Re-read it and decide again.",
      { expected, actual: fresh.revision, rampProfileId: String(fresh._id) });
  }
  return { updated: true, profile: publishProfile(updated, { withHistory: true }), events: [publishEvent(audit)] };
}

/* ═══ RESOLVING A STAGE FOR A CAPACITY STANDARD ════════════════════════════
 *
 * Called by the capacity service and by nothing else. It returns the facts to
 * FREEZE — never a live reference — so a later edit or retirement of the profile
 * cannot restate a target already calculated.
 */
async function resolveStageForCapture(ctx, { rampProfileId, rampStageId } = {}) {
  const profile = await loadOwnedProfile(ctx, rampProfileId);

  /* A retired profile may not be newly applied. One already frozen on a
     standard stays exactly as it was — this path is not consulted for it. */
  if (profile.status === STATUS.RETIRED) {
    throw fail("IE_RAMP_PROFILE_RETIRED",
      "That ramp profile is retired and cannot be applied to a new capacity standard.",
      { rampProfileId: String(profile._id), allowedAction: "RESTORE" });
  }

  const wanted = str(rampStageId);
  if (!wanted) {
    throw fail("IE_RAMP_STAGE_NOT_IN_PROFILE",
      "Say which stage of this ramp profile the capacity standard is planned for.",
      {
        field: "rampStageId",
        fieldErrors: [{ field: "rampStageId", code: "REQUIRED", message: "Choose a ramp stage." }],
        rampProfileId: String(profile._id),
        stageIds: (profile.stages || []).map((s) => s.stageId),
      });
  }
  const stage = (profile.stages || []).find((s) => s.stageId === wanted);
  if (!stage) {
    /* The profile was found; what did not resolve is a field in the request. */
    throw fail("IE_RAMP_STAGE_NOT_IN_PROFILE",
      "That stage is not part of this ramp profile.",
      {
        field: "rampStageId",
        fieldErrors: [{ field: "rampStageId", code: "UNKNOWN_STAGE", message: "That stage is not in this profile." }],
        rampProfileId: String(profile._id),
        rampProfileRevision: profile.revision,
      });
  }

  /* Everything a reader needs months later to explain the calculation, copied
     rather than referenced. */
  return {
    rampProfileId: profile._id,
    rampProfileRevision: profile.revision,
    rampProfileName: profile.name,
    stageId: stage.stageId,
    stageSequence: stage.sequence,
    stageLabel: stage.label || "",
    fromProductionDay: stage.fromProductionDay,
    toProductionDay: stage.toProductionDay ?? null,
    targetEfficiencyPercent: stage.targetEfficiencyPercent,
    capturedAt: new Date(),
  };
}

module.exports = {
  STATUS, LIMITS, nameKeyOf,
  CREATE_FIELDS, PATCH_FIELDS, STAGE_FIELDS, LIFECYCLE_FIELDS, REFUSED_FIELDS,
  shapeStages, changedCategories, sameStages, publishProfile, publishStage, publishEvent,
  createProfile, readProfile, listProfiles, updateProfile,
  retireProfile, restoreProfile, resolveStageForCapture,
};
