// models/CMS_Models/IndustrialEngineering/IeCapacityStandard.js
//
// IE CHUNK 7A — A DRAFT CAPACITY STANDARD FOR ONE EXACT LINE LAYOUT.
//
// This record answers one question: given this balanced line, this garment SAM
// and these stated working-time assumptions, how many pieces an hour, a shift
// and a day is the line a STANDARD for. It is an engineering statement, not a
// promise: it books nothing, schedules nothing and commits no delivery date.
//
// ── WHY EVERY SOURCE FACT IS FROZEN HERE ────────────────────────────────────
// A capacity target is quoted, planned against and argued about weeks after it
// was computed. If it re-read its inputs it would silently restate itself: one
// newly approved method study would move a target somebody had already planned
// a shipment on, and no reader could tell it had moved. So the layout
// revision, the layout's own frozen source fingerprint and bulletin revision,
// and the garment SAM derived from that layout's frozen rows are all copied in
// at creation. They are EVIDENCE. Nothing here ever rebases them: when the
// source moves, this record stops being editable and a new one is created
// against the new exact source.
//
// ── WHERE THE GARMENT SAM COMES FROM, AND WHERE IT DOES NOT ─────────────────
// It is the sum of the layout's frozen `sourceRows[].standardTimeMinutes` —
// standard times a second person approved in Chunk 4B, captured by Chunk 6A
// when the layout was opened. It is server-derived on every path. A client
// cannot send it, because a client that could send a SAM could make any target
// come out at any number.
//
// ── AND WHY THE WORKING TIME IS AN ASSUMPTION, NOT A CALENDAR ───────────────
// The Chunk 7A source audit found no safe company-scoped factory working-time
// source. Merchandising's working calendar is company-scoped, versioned and
// frozen when published, but it models WORKING DAYS for delivery deadlines and
// carries no shift length, no break minutes and no shifts per day.
// `ProductionSchedule` carries shift minutes and breaks but has no company
// scope at all, no revision and no version, and it is Production's own booking
// document. HR attendance carries a named general shift per employee, is
// likewise unscoped, and is attendance rather than a standard.
//
// None of those can be cited in a reproducible calculation, so this record
// makes the assumption EXPLICIT instead of borrowing an unsafe one:
// `workingTimeSource.kind` is `IE_PLANNING_ASSUMPTION`, the calendar linkage is
// published as UNKNOWN, and the readiness comes back PROVISIONAL — never READY
// — for as long as that is true. `PROVED_CALENDAR_VERSION` exists as the shape
// a future authoritative source will fill, and nothing writes it yet.
//
// ── WHAT THIS RECORD CANNOT EXPRESS ─────────────────────────────────────────
// There is no machine id, no serial number, no asset, no availability, no
// maintenance status, no employee, no operator identity, no attendance, no
// barcode, no scan, no Production allocation or booking, and no approval or
// release state — and no field one could be put in. Planned operators and
// helpers are COUNTS of a requirement, in the same vocabulary Chunk 6B uses for
// planned machine types. "This line is planned with 24 operators" is an
// engineering statement; "Meena is on line 4 on Tuesday" is HR's and
// Production's, and this schema cannot hold it.
"use strict";

const mongoose = require("mongoose");

/* ── DRAFT IS WHERE A TARGET IS PLANNED; APPROVED IS WHERE IT STOPS ────────
   Chunk 7C3 adds the second. An APPROVED capacity standard is permanent
   evidence that a second person accepted these stated assumptions and the
   target they produce. It is never edited, never recalculated and never
   rebased, and the way to change a target is a new standard. */
const STATUS = Object.freeze(["DRAFT", "APPROVED"]);

/* Every event this record can record. There is still no release,
   acknowledgement or publication type — Chunk 7C3 approves a standard and
   publishes nothing downstream, and an audit trail that could name such an
   event would invite a screen to render a control for it. */
const EVENT_TYPES = Object.freeze([
  "CAPACITY_STANDARD_CREATED",
  "CAPACITY_STANDARD_EDITED",
  "CAPACITY_STANDARD_APPROVED",
]);

/* How the working time behind this calculation is known. */
const WORKING_TIME_SOURCE = Object.freeze([
  /* Somebody stated it, and said so. The only kind Chunk 7A can write. */
  "IE_PLANNING_ASSUMPTION",
  /* A company-scoped, versioned, published-frozen working-time calendar,
     cited by id and version. No such source exists yet; the shape is declared
     so a later chunk fills it rather than redefining the record. */
  "PROVED_CALENDAR_VERSION",
]);

const LIMITS = Object.freeze({
  SHIFT_MINUTES: 1440,        // a shift cannot be longer than a day
  OPERATORS: 5000,
  HELPERS: 5000,
  SHIFTS_PER_DAY: 3,
  NOTE: 1000,
  SUMMARY: 300,
  HISTORY: 200,
});

/** A bounded audit line. Never a copy of the inputs or of the calculation. */
const capacityEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    type: { type: String, enum: EVENT_TYPES, required: true },
    at: { type: Date, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorName: { type: String, trim: true, default: "" },
    standardRevision: { type: Number, required: true, min: 1 },
    /* Which INPUT GROUPS moved — "workingTime", "manpower", "efficiency",
       "effectivePeriod", "sourceClassification", "note", "ramp". Never a
       field-by-field diff, and never a fabricated approval. */
    changed: { type: [{ type: String, trim: true }], default: () => [] },
    summary: { type: String, trim: true, default: "", maxlength: LIMITS.SUMMARY },
  },
  { _id: false },
);

/**
 * The stated working time, and how it is known.
 *
 * `availableShiftMinutes` is the gross length of one shift. `breakMinutes` is
 * the non-productive part of it, modelled separately on purpose: a reader who
 * is told only "net 480" cannot tell whether breaks were subtracted or
 * forgotten, and the two numbers are argued about independently.
 */
const workingTimeSchema = new mongoose.Schema(
  {
    availableShiftMinutes: { type: Number, required: true, min: 1, max: LIMITS.SHIFT_MINUTES },
    breakMinutes: { type: Number, required: true, min: 0, max: LIMITS.SHIFT_MINUTES, default: 0 },
    shiftsPerDay: { type: Number, required: true, min: 1, max: LIMITS.SHIFTS_PER_DAY, default: 1 },

    /* WHERE those minutes came from. */
    source: {
      kind: { type: String, enum: WORKING_TIME_SOURCE, required: true },
      /* Filled only by `PROVED_CALENDAR_VERSION`, and null for as long as no
         authoritative source exists. A null here is a real answer — "nothing
         proves this" — and is never read as a calendar of zero days. */
      calendarId: { type: mongoose.Schema.Types.ObjectId, default: null },
      calendarVersionNo: { type: Number, default: null, min: 1 },
      calendarRef: { type: String, trim: true, default: "" },
      /* Why the assumption was made, in the author's own words. */
      note: { type: String, trim: true, default: "", maxlength: LIMITS.NOTE },
    },
  },
  { _id: false },
);

/**
 * The planned manpower — counts of a requirement, never people.
 *
 * `plannedOperatorCount` is the only one the formula uses. `plannedHelperCount`
 * is recorded as an INFORMATIONAL requirement and is deliberately absent from
 * every calculation: a helper does not earn standard minutes against the
 * garment SAM, and quietly adding helpers to the operator count would inflate
 * every target on the floor by a number nobody agreed to.
 */
const manpowerSchema = new mongoose.Schema(
  {
    plannedOperatorCount: { type: Number, required: true, min: 1, max: LIMITS.OPERATORS },
    plannedHelperCount: { type: Number, required: true, min: 0, max: LIMITS.HELPERS, default: 0 },
  },
  { _id: false },
);

/**
 * The frozen evidence this calculation is a calculation OF.
 *
 * Copied once, at creation, from the layout the acting company owns. Never
 * re-read, never rebased, and never accepted from a client.
 */
const frozenSourceSchema = new mongoose.Schema(
  {
    /* The exact layout revision, and the exact source it was a balance of. */
    lineLayoutRevision: { type: Number, required: true, min: 1 },
    layoutFingerprint: { type: String, required: true, trim: true },
    bulletinRevision: { type: Number, required: true, min: 1 },
    /* The two halves, so a superseded record can say WHICH moved. */
    approvalDigest: { type: String, trim: true, default: "" },
    requirementDigest: { type: String, trim: true, default: "" },

    /* ── THE SERVER-DERIVED GARMENT SAM, AND ITS PROVENANCE ─────────────
       The minutes, how they were derived, and how many frozen rows they were
       summed over — so the figure can be re-derived and audited from this
       record alone, without reading the layout back. */
    garmentSamMinutes: { type: Number, required: true, min: 0 },
    samDerivation: { type: String, trim: true, required: true },
    samRowCount: { type: Number, required: true, min: 0 },
    /* What the layout's own readiness said on the day. Recorded so a reader
       can see the line was, for example, only half assigned when the target
       was computed. */
    layoutReady: { type: Boolean, default: false },
    layoutGapCodes: { type: [{ type: String, trim: true }], default: () => [] },
    capturedAt: { type: Date, required: true },
  },
  { _id: false },
);

/**
 * THE RAMP ASSUMPTION THIS STANDARD FROZE (Chunk 7B).
 *
 * Null when no ramp was applied, which is the ordinary case: a standard states
 * a steady-state target, and a ramp is an extra, explicitly chosen stage of a
 * run planned beside it.
 *
 * ── FROZEN, NOT REFERENCED ─────────────────────────────────────────────────
 * The profile id and revision, the stage identity, the stage's own percentage
 * and the day range it covers are all COPIED at the moment the ramp is applied.
 * Nothing reads them back. So the profile may afterwards be corrected, restaged
 * or retired, and this standard keeps saying what it said on the day — exactly
 * as the layout source and the garment SAM already do. A ramp that could be
 * edited under a standard would silently restate a first-week target somebody
 * had already staffed a line against.
 *
 * The name is kept beside the id for the same reason the layout event keeps the
 * template's: a person reads the name, and an id is what a reader resolves by.
 */
const frozenRampSchema = new mongoose.Schema(
  {
    rampProfileId: { type: mongoose.Schema.Types.ObjectId, required: true },
    rampProfileRevision: { type: Number, required: true, min: 1 },
    rampProfileName: { type: String, trim: true, default: "" },
    stageId: { type: String, required: true, trim: true },
    stageSequence: { type: Number, required: true, min: 1 },
    stageLabel: { type: String, trim: true, default: "" },
    fromProductionDay: { type: Number, required: true, min: 1 },
    toProductionDay: { type: Number, default: null, min: 1 },
    /* The stage's own percentage, on the same terms as every other efficiency
       in this lane: a percentage, greater than zero and at most 100. */
    targetEfficiencyPercent: { type: Number, required: true, min: 0, max: 100 },
    capturedAt: { type: Date, required: true },
  },
  { _id: false },
);

const ieCapacityStandardSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },

    /* What this is a capacity standard for. Both are recorded because a reader
       asks both questions — "which style" and "which balance of it". */
    ieStyleFileId: { type: mongoose.Schema.Types.ObjectId, ref: "IeStyleFile", required: true },
    lineLayoutId: { type: mongoose.Schema.Types.ObjectId, ref: "IeLineLayout", required: true },

    source: { type: frozenSourceSchema, required: true },

    /* The planning inputs — the only things an edit may touch. */
    workingTime: { type: workingTimeSchema, required: true },
    manpower: { type: manpowerSchema, required: true },

    /* ── EFFICIENCY IS A PERCENTAGE, EVERYWHERE, WITHOUT EXCEPTION ───────
       Stored as a percentage, accepted as a percentage, published as a
       percentage, and named `...Percent` on every surface so no reader has to
       guess whether 0.85 means 85% or 0.85%. Greater than zero and at most
       100: a line cannot be planned to earn more standard minutes than it is
       attended for, and a zero target is not a plan. */
    targetEfficiencyPercent: { type: Number, required: true, min: 0, max: 100 },

    /* Optional calendar dates this standard is intended for. Dates only — no
       zone, no time — because "from the first of October" is a calendar fact. */
    effectiveFrom: { type: Date, default: null },
    effectiveTo: { type: Date, default: null },

    note: { type: String, trim: true, default: "", maxlength: LIMITS.NOTE },

    /* Null unless a ramp stage was explicitly applied — see `frozenRampSchema`. */
    ramp: { type: frozenRampSchema, default: null },

    status: { type: String, enum: STATUS, default: "DRAFT", required: true },
    revision: { type: Number, default: 1, min: 1 },

    /* ── WHO ACCEPTED THIS TARGET, AND WHICH REVISION OF IT ────────────────
       `approvedRevision` is the revision that was APPROVED — the one the
       approver read and decided on — while `revision` moves to the next number
       in the same write. A reader can then say "revision 4 was approved, and
       the record is at 5" without inferring it.

       None carries a default. A DRAFT has no approver, and a stored null would
       say somebody considered it and declined to sign — the same Chunk 1D rule
       that keeps the bulletin-version pointers absent on a legacy file.

       ── AND APPROVAL PROVES NOTHING ABOUT THE CALENDAR ───────────────────
       There is deliberately no field here that could record one. Approving a
       standard means a second person accepts the working-time assumptions this
       record states on its face; it does not make them calendar-proved, and the
       record keeps saying so afterwards. */
    approvedBy: { type: mongoose.Schema.Types.ObjectId },
    approvedByName: { type: String, trim: true },
    approvedAt: { type: Date },
    approvedRevision: { type: Number, min: 1 },

    history: { type: [capacityEventSchema], default: () => [] },

    createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdByName: { type: String, trim: true, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    updatedByName: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "ie_capacity_standards" },
);

/* Listing and reading are always company-first, and a layout's standards are
   read newest-first. No unique index: one layout may legitimately hold several
   capacity standards — a conservative one and an optimistic one, or one per
   effective period — and nothing here decides which is "the" standard, because
   deciding that is approval, and approval is a later chunk. */
ieCapacityStandardSchema.index({ companyId: 1, createdAt: -1, _id: -1 });
ieCapacityStandardSchema.index({ companyId: 1, lineLayoutId: 1, createdAt: -1 });
ieCapacityStandardSchema.index({ companyId: 1, ieStyleFileId: 1, createdAt: -1 });

/* ═══ AN APPROVED STANDARD IS PERMANENT EVIDENCE ═══════════════════════════
 *
 * The service filters on `status: "DRAFT"` in every mutation, so nothing
 * legitimate reaches an approved standard. This is the second layer, for the
 * writes that do not go through a service — and it is needed because document
 * middleware runs on `save()` and on nothing else, while every IE mutation is
 * an atomic update query.
 *
 * ── THE RULE IS ABOUT THE QUERY, NOT ABOUT THE FIELDS ─────────────────────
 * Not a list of protected paths. Such a list can only ever contain the ways
 * somebody has already thought of, and it would leave `companyId`,
 * `lineLayoutId`, `createdBy`, `updatedByName` and every field added to this
 * schema in future writable on an approved record — and moving an approved
 * target into another company is not a lesser rewrite than moving its inputs.
 *
 * So any non-empty mutation must name the exact scalar `status: "DRAFT"` in its
 * filter. That is the only proof a query can offer, without a second read, that
 * it cannot land on an approved standard, and it is what every service mutation
 * already carries. A filter naming several statuses (`$in`, `$ne`) is not
 * enough: it would be safe for one member and not for another.
 */
const approvedImmutable = (what) => {
  const err = new Error(
    "An approved capacity standard is permanent evidence of a target somebody accepted. "
    + `${what} Create a new draft standard instead.`,
  );
  err.name = "IeCapacityStandardImmutable";
  err.code = "IE_CAPACITY_STANDARD_IMMUTABLE";
  return err;
};

/* `save()` — creation is allowed; every later save on an approved record is
   refused, and no save may move the status in either direction, because
   approval is one conditional update in the service and nothing else. */
ieCapacityStandardSchema.pre("save", function freezeApproved(next) {
  if (this.isNew) return next();
  const touched = [...new Set(this.modifiedPaths().map((p) => String(p).split(".")[0]))];
  if (!touched.length) return next();
  if (touched.includes("status")) {
    return next(approvedImmutable("A standard's status is moved by approving it, not by saving it."));
  }
  if (this.status !== "APPROVED") return next();
  return next(approvedImmutable(`${touched.join(", ")} cannot change.`));
});

const touchedCapacityPaths = (update = {}) => {
  const paths = new Set();
  for (const [key, value] of Object.entries(update)) {
    if (key.startsWith("$")) {
      if (key === "$setOnInsert") continue;
      for (const path of Object.keys(value || {})) paths.add(String(path).split(".")[0]);
      continue;
    }
    paths.add(String(key).split(".")[0]);
  }
  return [...paths];
};

const namesDraft = (filter = {}) => filter.status === "DRAFT";

for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace"]) {
  ieCapacityStandardSchema.pre(op, function refuseApprovedWrite(next) {
    if (this.getOptions?.().upsert) {
      /* An upsert would create a standard with no layout behind it. Creating
         inserts; nothing upserts. */
      return next(approvedImmutable("A capacity standard is created, never upserted."));
    }
    const touched = touchedCapacityPaths(this.getUpdate() || {});
    if (!touched.length) return next();
    if (namesDraft(this.getFilter?.() || {})) return next();
    return next(approvedImmutable(
      `${touched.join(", ")} cannot be written without naming \`status: "DRAFT"\`, `
      + "so the write cannot be shown not to land on an approved standard.",
    ));
  });
}

/* ── A REPLACEMENT IS REFUSED WHATEVER ITS FILTER SAYS ──────────────────────
 * Both paths, and unconditionally — not merely when the filter cannot prove a
 * DRAFT target. A replacement's field set is the WHOLE document, so a
 * DRAFT-filtered `findOneAndReplace` would overwrite the frozen source
 * evidence, the calculation inputs and the entire audit trail of a perfectly
 * ordinary draft in one operation, and every one of those is server-owned. A
 * draft is edited through the atomic update the service already performs; there
 * is no legitimate caller that needs to replace one. */
for (const op of ["replaceOne", "findOneAndReplace"]) {
  ieCapacityStandardSchema.pre(op, function refuseReplace(next) {
    return next(approvedImmutable(
      "A capacity standard cannot be replaced wholesale — its frozen source and its audit trail "
      + "are the server's, and a replacement would rewrite both.",
    ));
  });
}

/* ── AND NO CAPACITY STANDARD IS EVER DELETED ───────────────────────────────
 * There is no deletion lifecycle in this product: a capacity standard that was
 * wrong is superseded by a new one, and one that was approved is permanent
 * evidence of a target somebody accepted. Nothing in Industrial Engineering
 * deletes a record — not an operation, not a bulletin version, not a layout —
 * and the reason is the same every time: a register whose rows can disappear
 * cannot be cited afterwards.
 *
 * So deletion is refused UNIVERSALLY rather than conditionally. A rule that
 * allowed drafts to be deleted would need every caller to prove the target's
 * status, and the first one to forget would take an approved record with it.
 *
 * Every path Mongoose offers is covered. `findByIdAndDelete` and
 * `findOneAndRemove` are not hooks in their own right — they run through
 * `findOneAndDelete`, which is — and the document method runs through the
 * document `deleteOne` hook.
 */
const noDeletion = () => {
  const err = new Error(
    "A capacity standard is never deleted. One that was wrong is superseded by a new standard, "
    + "and one that was approved is permanent evidence of a target somebody accepted.",
  );
  err.name = "IeCapacityStandardImmutable";
  err.code = "IE_CAPACITY_STANDARD_IMMUTABLE";
  return err;
};

/* The query paths. */
for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"]) {
  ieCapacityStandardSchema.pre(op, { query: true, document: false }, function refuseQueryDelete(next) {
    return next(noDeletion());
  });
}

/* And the document method, which is a different hook with the same name. */
ieCapacityStandardSchema.pre("deleteOne", { document: true, query: false }, function refuseDocDelete(next) {
  return next(noDeletion());
});

module.exports = mongoose.models.IeCapacityStandard
  || mongoose.model("IeCapacityStandard", ieCapacityStandardSchema);

module.exports.STATUS = STATUS;
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.WORKING_TIME_SOURCE = WORKING_TIME_SOURCE;
module.exports.LIMITS = LIMITS;
module.exports.NEVER_DELETED = true;
