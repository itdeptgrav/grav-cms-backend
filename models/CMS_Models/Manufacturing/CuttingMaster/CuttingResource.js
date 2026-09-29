// models/CMS_Models/Manufacturing/CuttingMaster/CuttingResource.js
//
// A CUTTING RESOURCE — A TABLE, A KNIFE, A CUTTER, AS CUTTING RUNS IT.
//
// Industrial Engineering states how much work a piece is. THIS record states
// what the cutting room actually has: which tables and knives, on which days,
// for how many minutes, with how many people in which roles, and how well it
// really runs. PPC reads both and previews a window. It owns neither.
//
// ── WHY A NEW RECORD, AND WHY IT IS CUTTING'S ───────────────────────────────
// Nothing in this system held these facts. `Machine` is an asset and
// maintenance record — no company, no shifts, no crew — and could not be
// company-scoped without changing what it is for every other reader.
// `PpcCapacityLine` is PPC's own reservation of a SEWING line and is
// deliberately not reused: a sewing line is booked by PPC against a plan, a
// cutting resource is operated by Cutting and merely READ by PPC. Sharing one
// record would put Cutting's shift roster under PPC's booking index and make
// each department's edit a risk to the other.
//
// ── VERSIONED, BECAUSE A ROSTER IS A STATEMENT ABOUT A PERIOD ───────────────
// Cutting publishes a version: this is the pattern, these are the people,
// from this date. A plan previewed against it can say which version it read.
// A published version takes no edit — a change is a new version, and the old
// one stays readable, exactly as IE's releases and PPC's plans do. The DRAFT
// is Cutting's workspace and is never published to anybody.
//
// ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
// Not a booking: nothing here is reserved, and there is no field for a plan,
// an order or a work order. Not a target: it commits Cutting to nothing. Not
// an actual: what was cut is `CuttingMasterRecord`'s, and stays there. And not
// an engineering standard — the minutes per piece are IE's, frozen in the
// release, and this record deliberately has nowhere to put one.
"use strict";

const mongoose = require("mongoose");

const {
  CUTTING_RESOURCE_TYPES, CREW_ROLES,
} = require("../../IndustrialEngineering/processRoute.schema");

/* Cutting's own resource types are IE's vocabulary, imported rather than
   restated: a resource typed in words IE does not use could never match an
   approved standard, and the mismatch would surface as an empty preview
   nobody could explain. */
const RESOURCE_TYPES = CUTTING_RESOURCE_TYPES;

const RESOURCE_STATE = Object.freeze({
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
  SUPERSEDED: "SUPERSEDED",
  /* Cutting has withdrawn it: the resource exists but is not to be planned
     against. Different from a version that simply has a later successor. */
  RETIRED: "RETIRED",
});
const RESOURCE_STATES = Object.freeze(Object.values(RESOURCE_STATE));

const LIMITS = Object.freeze({
  NAME: 120, SITE: 120, NOTE: 2000, REASON: 400,
  SHIFTS_PER_DAY: 4, EXCEPTIONS: 400, ROLES: 10,
  MAX_CREW: 60, MIN_EFFICIENCY: 1, MAX_EFFICIENCY: 200,
});

const clock = {
  validator: (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || "")),
  message: "A time is written HH:MM.",
};
const businessDate = {
  validator: (v) => v === null || v === undefined || /^\d{4}-\d{2}-\d{2}$/.test(String(v)),
  message: "A date is written YYYY-MM-DD.",
};

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true, default: "" },
});

/** One shift: its clock times and its unpaid break. Overnight is allowed. */
const shiftSchema = new mongoose.Schema(
  {
    shiftKey: { type: String, trim: true, required: true, maxlength: 40 },
    start: { type: String, required: true, validate: clock },
    end: { type: String, required: true, validate: clock },
    breakMinutes: { type: Number, required: true, min: 0, max: 600 },
  },
  { _id: false },
);

/** One weekday in the pattern, Monday first. */
const dayPatternSchema = new mongoose.Schema(
  {
    working: { type: Boolean, required: true },
    shifts: {
      type: [shiftSchema], default: () => [],
      validate: [(v) => !Array.isArray(v) || v.length <= LIMITS.SHIFTS_PER_DAY,
        `At most ${LIMITS.SHIFTS_PER_DAY} shifts a day.`],
    },
  },
  { _id: false },
);

/**
 * A named day that is not what the week pattern says.
 *
 * `WORKING_DAY` carries its own shifts, because a make-up Sunday is rarely a
 * normal Monday. `HOLIDAY` and `DOWNTIME` are zero-minute days — a public
 * holiday and a planned maintenance stop are both "nothing is cut", and they
 * stay different words because the person reading the plan in March needs to
 * know which it was.
 */
const exceptionSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, validate: businessDate },
    kind: { type: String, enum: ["WORKING_DAY", "HOLIDAY", "DOWNTIME"], required: true },
    shifts: { type: [shiftSchema], default: () => [] },
    reason: { type: String, trim: true, default: "", maxlength: LIMITS.REASON },
  },
  { _id: false },
);

/** How many people of one role this resource actually has on a normal day. */
const crewRoleSchema = new mongoose.Schema(
  {
    role: { type: String, enum: CREW_ROLES, required: true },
    count: { type: Number, required: true, min: 0, max: LIMITS.MAX_CREW },
  },
  { _id: false },
);

const cuttingResourceSchema = new mongoose.Schema(
  {
    /* ── IDENTITY, STABLE ACROSS EVERY VERSION ───────────────────────── */
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    /* Cutting's own permanent reference for this table or knife. It survives
       a rename, which the display name does not. */
    resourceRef: { type: String, trim: true, required: true, immutable: true, maxlength: 60 },
    name: { type: String, trim: true, required: true, maxlength: LIMITS.NAME },
    siteRef: { type: String, trim: true, required: true, maxlength: LIMITS.SITE },

    /* IE's vocabulary. A resource whose type no approved standard names can
       never be eligible, and the preview says so by name rather than by
       returning nothing. */
    resourceType: { type: String, enum: RESOURCE_TYPES, required: true },

    /* Is Cutting running this resource at all? Separate from a version's
       state: a retired table has versions that were once published. */
    isActive: { type: Boolean, required: true, default: true },

    /* The factory's own frame. Dates in this record are calendar dates there,
       never instants, and never the reader's timezone. */
    timezone: { type: String, trim: true, required: true, maxlength: 60 },

    /* ── WHAT THIS VERSION SAYS ──────────────────────────────────────── */
    versionNo: { type: Number, required: true, min: 1, immutable: true },
    state: { type: String, enum: RESOURCE_STATES, required: true, default: RESOURCE_STATE.DRAFT },
    /* The period this version describes. A date outside it is NOT a
       non-working day — it is a day this version says nothing about, and the
       preview reports that rather than assuming a rest day. */
    effectiveFrom: { type: String, required: true, validate: businessDate },
    effectiveTo: { type: String, default: null, validate: businessDate },

    /* Monday first, seven entries. */
    weekPattern: {
      type: [dayPatternSchema], default: () => [],
      validate: [(v) => !Array.isArray(v) || v.length === 0 || v.length === 7,
        "A week pattern has seven days, Monday first."],
    },
    exceptions: {
      type: [exceptionSchema], default: () => [],
      validate: [(v) => !Array.isArray(v) || v.length <= LIMITS.EXCEPTIONS, "Too many exceptions."],
    },

    /* Who is on this resource, by role. Compared against the crew composition
       IE's standard requires — which is why the roles are IE's vocabulary. */
    crew: {
      type: [crewRoleSchema], default: () => [],
      validate: [(v) => !Array.isArray(v) || v.length <= LIMITS.ROLES, "Too many roles."],
    },

    /**
     * How well this resource actually runs, as Cutting observes it.
     *
     * NOT the same number as IE's `standardEfficiencyPercent`, and never
     * multiplied with it. IE's figure says what its own minutes already
     * assume; this one says what this table really achieves. The preview
     * applies exactly one of them and states which — see
     * services/ppc/cuttingCapacityPreview.service.js.
     */
    operationalEfficiencyPercent: {
      type: Number, required: true,
      min: LIMITS.MIN_EFFICIENCY, max: LIMITS.MAX_EFFICIENCY,
    },

    note: { type: String, trim: true, default: "", maxlength: LIMITS.NOTE },

    /* ── WHO PUBLISHED IT, AND WHEN ──────────────────────────────────── */
    publishedBy: actorRef(),
    publishedAt: { type: Date, default: null },
    supersededByVersionNo: { type: Number, default: null },
    retiredReason: { type: String, trim: true, default: "", maxlength: LIMITS.REASON },
    createdBy: actorRef(),
    updatedBy: actorRef(),
    revision: { type: Number, required: true, min: 1, default: 1 },
  },
  { timestamps: true, collection: "cutting_resources" },
);

/* One version number per resource. */
cuttingResourceSchema.index({ companyId: 1, resourceRef: 1, versionNo: 1 }, { unique: true });
/* At most one PUBLISHED version per resource, enforced by the database rather
   than by a check that races itself when two people publish at once. */
cuttingResourceSchema.index(
  { companyId: 1, resourceRef: 1 },
  { unique: true, partialFilterExpression: { state: RESOURCE_STATE.PUBLISHED }, name: "cutting_resource_one_published" },
);
/* The preview's own read: this company's published resources of a type. */
cuttingResourceSchema.index({ companyId: 1, state: 1, resourceType: 1 });

/*
 * A published version is a statement Cutting made on a date. Only its
 * standing may move afterwards — to SUPERSEDED when a successor publishes, or
 * RETIRED when Cutting withdraws it. Everything else is a new version.
 */
const MUTABLE_AFTER_PUBLISH = new Set([
  "state", "supersededByVersionNo", "retiredReason", "updatedBy", "revision", "updatedAt", "__v",
]);
cuttingResourceSchema.pre("save", function freezePublished(next) {
  if (this.isNew) return next();
  const wasPublished = this.$locals?.wasPublished;
  if (!wasPublished) return next();
  const touched = this.modifiedPaths().filter((p) => !MUTABLE_AFTER_PUBLISH.has(p.split(".")[0]));
  if (touched.length) {
    const err = new Error(
      `A published cutting resource version is frozen. ${touched.join(", ")} cannot change — `
      + "publish a new version instead.",
    );
    err.name = "CuttingResourceImmutable";
    err.code = "CUTTING_RESOURCE_IMMUTABLE";
    return next(err);
  }
  return next();
});

const CuttingResource = mongoose.models.CuttingResource
  || mongoose.model("CuttingResource", cuttingResourceSchema);

module.exports = {
  CuttingResource, RESOURCE_STATE, RESOURCE_STATES, RESOURCE_TYPES, LIMITS,
};
