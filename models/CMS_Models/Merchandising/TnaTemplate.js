// models/CMS_Models/Merchandising/TnaTemplate.js
//
// THE T&A PROCESS, AND ITS EFFECTIVE-DATED VERSIONS.
//
// A template is the NAME of a process — "Knits, export, standard" — and holds
// nothing else. Its versions hold the milestones, the dependencies and the
// offsets, and each one is frozen the moment it is published.
//
// ── WHY THE VERSION IS FROZEN, AND WHY THAT IS THE WHOLE POINT ──────────────
// A baseline is a promise about dates. If the template it was computed from
// could still be edited, the promise would be unreproducible: nobody could
// answer "why is fabric in-house on the 12th" six weeks later, because the
// rule that produced the 12th would have moved. So a published version is
// immutable, a change is a NEW version, and a plan pins the version it was
// created with. Publishing version 7 changes nothing for a file baselined on
// version 6 — that is not a nicety, it is the difference between a commitment
// and a suggestion.
//
// ── AND WHY SELECTORS, NOT SEPARATE PROCESSES ───────────────────────────────
// A buyer who needs an extra approval round, a factory with a longer lead time
// — those are the same process with different parameters. Modelling them as
// separate workflows is how a company ends up with fourteen processes nobody
// can compare. Selectors choose a version by STABLE REFERENCE (buyer, brand,
// product category, factory), never by display text, and specificity decides.
"use strict";

const mongoose = require("mongoose");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/** A calendar date, never an instant. See tnaCalendar.js for why. */
const dateOnly = (extra = {}) => ({
  type: String, trim: true,
  match: [/^\d{4}-\d{2}-\d{2}$/, "Dates are written YYYY-MM-DD."],
  ...extra,
});

/** Who owns the fact that a milestone happened. */
const OWNER_DEPARTMENT = Object.freeze({
  MERCHANDISING: "MERCHANDISING",
  SALES: "SALES",
  PRODUCT_DEVELOPMENT: "PRODUCT_DEVELOPMENT",
  QUALITY: "QUALITY",
  STORE_SUPPLY_CHAIN: "STORE_SUPPLY_CHAIN",
  IE_PPC_PRODUCTION: "IE_PPC_PRODUCTION",
  LOGISTICS: "LOGISTICS",
});

/**
 * Who may write `actualDate`.
 *
 * `MERCHANDISING` is only valid where Merchandising owns the fact. Everything
 * else waits for an authoritative event from the application that does — see
 * the publish guard, which refuses the pairing rather than trusting a
 * configurer to remember.
 */
const COMPLETION_AUTHORITY = Object.freeze({
  MERCHANDISING: "MERCHANDISING",
  SOURCE_EVENT: "SOURCE_EVENT",
});

/** What a milestone's offset is measured from. */
const ANCHOR = Object.freeze({
  PLAN_START: "PLAN_START",
  DELIVERY: "DELIVERY",
  EX_FACTORY: "EX_FACTORY",
  PREDECESSOR: "PREDECESSOR",
});

/** One milestone per line, per delivery drop, or per execution unit. */
const MILESTONE_SCOPE = Object.freeze({
  FILE: "FILE",
  PER_DELIVERY: "PER_DELIVERY",
  PER_UNIT: "PER_UNIT",
});

const VERSION_STATE = Object.freeze({
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
  RETIRED: "RETIRED",
});

/* ── THE TEMPLATE ──────────────────────────────────────────────────────── */

const templateSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company",
      required: true, index: true, immutable: true,
    },
    templateRef: { type: String, trim: true, required: true, immutable: true },
    /* Display text only. Renaming must not orphan a version or a plan. */
    name: { type: String, trim: true, required: true, maxlength: 160 },
    description: { type: String, trim: true, default: "", maxlength: 2000 },
    /* Deactivating hides it from NEW plans. Live plans are untouched. */
    isActive: { type: Boolean, default: true },
    createdBy: actorRef(),
  },
  { timestamps: true, collection: "merchandising_tna_templates" },
);

templateSchema.index({ companyId: 1, templateRef: 1 }, { unique: true });

/* ── ONE MILESTONE, AS THE PROCESS DEFINES IT ──────────────────────────── */

const templateMilestoneSchema = new mongoose.Schema(
  {
    /* ── THE STABLE IDENTITY ──────────────────────────────────────────
       Upper-case code, never the label. "PP sample approved" renamed to
       "Pre-production sample signed off" is the same control point, and an
       identity built from the label would make it a different one. */
    milestoneCode: {
      type: String, trim: true, required: true,
      match: [/^[A-Z][A-Z0-9_]{2,39}$/, "A milestone code is A–Z, 0–9 and underscores."],
    },
    name: { type: String, trim: true, required: true, maxlength: 160 },
    ownerDepartment: {
      type: String, enum: Object.values(OWNER_DEPARTMENT), required: true,
    },
    completionAuthority: {
      type: String, enum: Object.values(COMPLETION_AUTHORITY), required: true,
    },
    /* Which event kinds may complete it. A declared list rather than a switch
       statement, so a new source application is configuration. */
    sourceEventKinds: [{ type: String, trim: true }],
    anchor: { type: String, enum: Object.values(ANCHOR), default: ANCHOR.PLAN_START },
    /* Signed. Negative counts BACK from the anchor, which is how every date
       before a delivery is actually expressed. */
    offsetWorkingDays: { type: Number, default: 0 },
    scope: { type: String, enum: Object.values(MILESTONE_SCOPE), default: MILESTONE_SCOPE.FILE },
    /* Informational. The real critical path is computed from the graph. */
    criticalPathCandidate: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
  },
  { _id: false },
);

const templateDependencySchema = new mongoose.Schema(
  {
    dependencyRef: { type: String, trim: true, required: true },
    predecessorCode: { type: String, trim: true, required: true },
    successorCode: { type: String, trim: true, required: true },
    /* FINISH_TO_START only. Start-to-start and finish-to-finish are not
       needed to answer "what threatens the delivery date", and each one added
       multiplies the forecast engine's cases. */
    type: { type: String, enum: ["FINISH_TO_START"], default: "FINISH_TO_START" },
    lagWorkingDays: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

/* ── THE VERSION ───────────────────────────────────────────────────────── */

const templateVersionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    versionNo: { type: Number, min: 1, required: true, immutable: true },
    state: {
      type: String, enum: Object.values(VERSION_STATE),
      default: VERSION_STATE.DRAFT, index: true,
    },

    effectiveFrom: dateOnly(),
    effectiveTo: dateOnly({ default: null }),

    /* ── WHICH FILES THIS VERSION IS FOR ──────────────────────────────
       All optional, all matched by stable reference. An empty selector set
       is the company default and scores zero; specificity wins. */
    selectors: {
      buyerRefs: [{ type: String, trim: true }],
      brandRefs: [{ type: String, trim: true }],
      productCategoryRefs: [{ type: String, trim: true }],
      factoryRefs: [{ type: String, trim: true }],
    },

    milestones: { type: [templateMilestoneSchema], default: [] },
    dependencies: { type: [templateDependencySchema], default: [] },

    /* The working calendar a plan inherits when it is created from this. */
    defaultCalendarId: { type: mongoose.Schema.Types.ObjectId, default: null },

    publishedBy: actorRef(),
    publishedAt: { type: Date, default: null },
    retiredAt: { type: Date, default: null },
    createdBy: actorRef(),
  },
  { timestamps: true, collection: "merchandising_tna_template_versions" },
);

templateVersionSchema.index({ companyId: 1, templateId: 1, versionNo: 1 }, { unique: true });
/* One draft at a time, exactly as a selection revision does. */
templateVersionSchema.index(
  { companyId: 1, templateId: 1 },
  { unique: true, partialFilterExpression: { state: VERSION_STATE.DRAFT }, name: "one_tpl_draft" },
);
/* The resolution read: this company's published versions, by date. */
templateVersionSchema.index({ companyId: 1, state: 1, effectiveFrom: 1 });

/**
 * A PUBLISHED version is frozen.
 *
 * Only the three fields that record its STANDING may move — the state itself,
 * the date a successor closed it, and when it was retired. Everything else is
 * what a baseline was computed from, and a baseline that cannot be recomputed
 * is not a commitment.
 */
const VERSION_MUTABLE_AFTER_PUBLISH = new Set([
  "state", "effectiveTo", "retiredAt", "updatedAt", "__v",
]);

templateVersionSchema.pre("save", function freezePublished(next) {
  if (this.isNew) return next();
  const wasPublished = this.$__.originalState?.state === VERSION_STATE.PUBLISHED
    || (this.state !== VERSION_STATE.DRAFT && !this.isModified("state"))
    || (this.publishedAt && !this.isModified("publishedAt"));
  if (!wasPublished) return next();

  const touched = this.modifiedPaths().filter(
    (p) => !VERSION_MUTABLE_AFTER_PUBLISH.has(p.split(".")[0]),
  );
  if (touched.length) {
    const err = new Error(
      `A published template version is frozen. ${touched.join(", ")} cannot change — publish a new version instead.`,
    );
    err.name = "TnaTemplateImmutable";
    err.touched = touched;
    return next(err);
  }
  return next();
});

module.exports = {
  OWNER_DEPARTMENT, COMPLETION_AUTHORITY, ANCHOR, MILESTONE_SCOPE, VERSION_STATE,
  VERSION_MUTABLE_AFTER_PUBLISH, dateOnly, actorRef,
  TnaTemplate: mongoose.models.TnaTemplate
    || mongoose.model("TnaTemplate", templateSchema),
  TnaTemplateVersion: mongoose.models.TnaTemplateVersion
    || mongoose.model("TnaTemplateVersion", templateVersionSchema),
};
