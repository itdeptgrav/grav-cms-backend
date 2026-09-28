// models/CMS_Models/Costing/CostingVersion.js
//
// Central Costing — Chunk 1. A FROZEN COSTING.
//
// ── THE RULE THIS MODEL ENFORCES ────────────────────────────────────────────
// Roadmap decision 8: "Every costing is a frozen version. Later changes to a
// supplier price, overhead policy or BOM create a new version and never alter
// old history."
//
// A comment saying that would not enforce it, so the schema does: once a
// version document exists, every `save()` that would change its commercial or
// calculation content is refused by the hook at the bottom of this file, and
// there is no route that offers an in-place edit. A correction is version N+1
// carrying `supersedesVersionNumber`.
//
// ── WHY THE SCENARIOS ARE EMBEDDED AND NOT THEIR OWN COLLECTION ─────────────
// The roadmap names `CostingScenario` as a concept. It is not a separate owner:
// a scenario has no life outside the version it belongs to, is never queried
// across versions, and freezes and supersedes with its parent. A second
// collection would buy a join and a way for the two to disagree about which
// version a scenario belongs to. It is embedded, and Chunk 2 fills in the
// arithmetic that is deliberately absent here.
//
// ── WHAT IS RESERVED, AND WHY IT IS EMPTY RATHER THAN ZERO ──────────────────
// `cost`, `margin` and `output` are declared and left ABSENT. A zeroed total
// would be a statement — "this garment costs nothing" — and Chunk 1 has no
// calculator, so it has no such statement to make. Missing and zero stay
// different all the way down.
"use strict";

const mongoose = require("mongoose");

const { SUPPORTED_CURRENCIES, DEFAULT_CURRENCY } = require("../../../services/centralCosting/money");

/**
 * Version lifecycle.
 *
 * All three values are declared because a version's status is what tells a
 * reader whether a frozen record is the live one; but only `DRAFT` is
 * reachable in this chunk — nothing transitions a version, and the approval
 * controls that must precede `APPROVED` are Chunk 6's.
 */
const VERSION_STATES = Object.freeze(["DRAFT", "APPROVED", "SUPERSEDED"]);

/** Where a version's content came from. */
const VERSION_ORIGINS = Object.freeze([
  "MANUAL",          // somebody raised it in the costing app
  "CORRECTION",      // a later version replacing an earlier one
  "LEGACY_IMPORT",   // adopted from Enquiry.costingSheets — Chunk 2's adapter
]);

/* ── TYPED SOURCE REFERENCES ────────────────────────────────────────────────
 * What a version was built from, and what those things said AT THE TIME.
 *
 * Two halves, and the split is the point:
 *   · the REFERENCE (`sourceType` + `sourceId`/`sourceKey`) lets a reader
 *     navigate back to the master;
 *   · the SNAPSHOT is what the master said when the version froze, so a later
 *     price change cannot silently rewrite what this costing was based on.
 *
 * A reference is never a `ref`, for the same reason the context is not: a
 * populate would show today's value against a frozen number.
 *
 * `confidence` is carried from the first version onward because the roadmap
 * requires provisional inputs to be labelled honestly rather than presented as
 * verified — "they are never live references".
 */
const SOURCE_TYPES = Object.freeze([
  "RAW_ITEM",
  "STOCK_ITEM",
  "SERVICE",
  "SUPPLIER_OFFER",
  "BOM",
  "OPERATION",
  "COMPANY_POLICY",
  "ENQUIRY_COSTING_SHEET",
  "MANUAL_ENTRY",
]);

const SOURCE_CONFIDENCE = Object.freeze(["PROVISIONAL", "VERIFIED"]);

/* One snapshotted fact from a source. Exactly one of the three value columns
   is populated, so there is no `Mixed` and no way to smuggle an object in.
   `money` is stored the only way canonical money is stored: integer minor
   units plus a currency. */
const sourceFactSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 64 },
    text: { type: String, trim: true, maxlength: 300, default: undefined },
    num: { type: Number, default: undefined },
    money: {
      type: new mongoose.Schema(
        {
          amountMinor: { type: Number, required: true },
          currency: { type: String, required: true, enum: SUPPORTED_CURRENCIES },
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { _id: false },
);

const sourceReferenceSchema = new mongoose.Schema(
  {
    sourceType: { type: String, enum: SOURCE_TYPES, required: true },
    /* Whichever identifies the source. An ObjectId for a master record; a key
       for a source addressed by name (a legacy costing sheet's product). */
    sourceId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
    sourceKey: { type: String, trim: true, maxlength: 200, default: undefined },

    label: { type: String, trim: true, maxlength: 300, default: "" },
    confidence: { type: String, enum: SOURCE_CONFIDENCE, default: "PROVISIONAL" },
    capturedAt: { type: Date, default: Date.now },

    /* What the source said, then. Bounded in count by the parser. */
    snapshot: { type: [sourceFactSchema], default: () => [] },
  },
  { _id: false },
);

/* ── SCENARIO CONTAINER — SHAPE ONLY, RESERVED FOR CHUNK 2 ──────────────────
 * A scenario is "this costing at this quantity, on this demand basis". Chunk 5
 * adds the three demand bases and the dilution arithmetic; Chunk 2 adds the
 * first quantity break. Here it is a declared, typed container with no
 * computed field at all — so Chunk 2 extends it rather than replacing it, and
 * nothing in Chunk 1 can write a number that looks calculated. */
const scenarioSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 64 },
    label: { type: String, trim: true, maxlength: 200, default: "" },
    quantity: { type: Number, default: undefined, min: 0 },
    quantityUom: { type: String, trim: true, maxlength: 32, default: undefined },
    isPrimary: { type: Boolean, default: false },
  },
  { _id: false },
);

const costingVersionSchema = new mongoose.Schema(
  {
    /* ── SCOPE ─────────────────────────────────────────────────────────────
       Company is carried on the version as well as on the parent, and that
       duplication is deliberate. A version read must be scoped without first
       joining to its parent, and a version whose company disagreed with its
       parent's would be detectable rather than invisible. */
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true },
    costingId: { type: mongoose.Schema.Types.ObjectId, ref: "Costing", required: true },

    /* Monotonic within one costing. Uniqueness is enforced by the index below,
       not by reading the maximum and adding one. */
    versionNumber: { type: Number, required: true, min: 1 },

    status: { type: String, enum: VERSION_STATES, default: "DRAFT", required: true },

    /* ── THE CURRENCY EVERY NUMBER IN THIS VERSION IS IN ───────────────────
       Frozen with the version. A company changing its base currency later does
       not restate history; it produces new versions in the new currency. */
    baseCurrency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: SUPPORTED_CURRENCIES,
      default: DEFAULT_CURRENCY,
    },

    /* Which set of calculation rules produced this version's numbers. Zero
       means "no calculator ran" — which is the truth in Chunk 1, and is why
       it is a placeholder rather than a lie about schema 1. */
    calculationSchemaVersion: { type: Number, default: 0, min: 0 },

    /* ── IMMUTABLE CREATION PROVENANCE ────────────────────────────────────
       Who made this version, when, from what, and in answer to which request.
       Written once; the guard below refuses any later change. */
    provenance: {
      origin: { type: String, enum: VERSION_ORIGINS, default: "MANUAL", required: true },
      createdByActorId: { type: String, trim: true, default: "" },
      createdByActorName: { type: String, trim: true, default: "" },
      createdAt: { type: Date, default: Date.now, required: true },
      /* The request that produced it, so a version can be traced back to one
         HTTP call in the idempotency record and the server log. */
      requestId: { type: String, trim: true, maxlength: 120, default: "" },
      idempotencyKey: { type: String, trim: true, maxlength: 200, default: "" },
      /* Set on a correction. A version never rewrites the one it replaces; it
         names it. */
      supersedesVersionNumber: { type: Number, default: null },
      note: { type: String, trim: true, maxlength: 500, default: "" },
    },

    /* What this version was built from, as it read then. */
    sourceReferences: { type: [sourceReferenceSchema], default: () => [] },

    /* Reserved for Chunk 2. Empty, not zeroed. */
    scenarios: { type: [scenarioSchema], default: () => [] },
  },
  { timestamps: true, collection: "costing_versions" },
);

/* ── INDEXES ────────────────────────────────────────────────────────────────
   The uniqueness that makes version numbering safe: two concurrent creates
   with the same number, one wins the index and the other is refused. It is
   scoped to the costing (and the company ahead of it) rather than global —
   version 1 exists in every costing, and a global unique index on a tenant
   collection is a cross-tenant collision waiting to happen. */
costingVersionSchema.index(
  { companyId: 1, costingId: 1, versionNumber: 1 },
  { unique: true },
);
/* The version list, newest first, without touching the unique index's order. */
costingVersionSchema.index({ companyId: 1, costingId: 1, createdAt: -1 });

/* ── THE IMMUTABILITY GUARD ─────────────────────────────────────────────────
 * Everything except `status` is frozen once the document exists. Status is the
 * single exception because a version legitimately becomes APPROVED and later
 * SUPERSEDED without its content changing — and Chunk 6, not this chunk, is
 * what will be allowed to move it.
 *
 * This refuses at the model, so it holds for a route that has not been written
 * yet, a migration script and a REPL session alike. It is not a substitute for
 * there being no edit endpoint; it is the backstop for one being added.
 */
const MUTABLE_AFTER_CREATION = new Set(["status", "updatedAt", "__v"]);

function refuseContentMutation(doc) {
  const changed = doc.modifiedPaths().filter((p) => {
    const root = p.split(".")[0];
    return !MUTABLE_AFTER_CREATION.has(root);
  });
  if (!changed.length) return null;
  const err = new Error(
    `A costing version is immutable once created. Create a later version instead of changing ${changed.join(", ")}.`,
  );
  err.name = "CostingVersionImmutableError";
  err.changedPaths = changed;
  return err;
}

costingVersionSchema.pre("save", function (next) {
  if (this.isNew) return next();
  const err = refuseContentMutation(this);
  return err ? next(err) : next();
});

/* `updateOne`/`findOneAndUpdate` bypass the save hook entirely, so they are
   guarded too — otherwise the model's promise would hold only for the one code
   path that happens to use `save()`. */
function refuseUpdateMutation(next) {
  const update = this.getUpdate() || {};
  const touched = new Set();
  for (const [op, payload] of Object.entries(update)) {
    /* `$setOnInsert` only ever applies when the update CREATES the document,
       and mongoose adds `createdAt` to it for every timestamped update. An
       insert is not a mutation, so counting it as one would refuse an upsert
       that had nothing to rewrite. */
    if (op === "$setOnInsert") continue;
    if (op.startsWith("$")) {
      for (const path of Object.keys(payload || {})) touched.add(path.split(".")[0]);
    } else {
      touched.add(op.split(".")[0]);
    }
  }
  const changed = [...touched].filter((p) => !MUTABLE_AFTER_CREATION.has(p));
  if (!changed.length) return next();
  const err = new Error(
    `A costing version is immutable once created. Create a later version instead of changing ${changed.join(", ")}.`,
  );
  err.name = "CostingVersionImmutableError";
  err.changedPaths = changed;
  return next(err);
}

costingVersionSchema.pre("updateOne", refuseUpdateMutation);
costingVersionSchema.pre("findOneAndUpdate", refuseUpdateMutation);
costingVersionSchema.pre("updateMany", refuseUpdateMutation);

module.exports =
  mongoose.models.CostingVersion || mongoose.model("CostingVersion", costingVersionSchema);
module.exports.VERSION_STATES = VERSION_STATES;
module.exports.VERSION_ORIGINS = VERSION_ORIGINS;
module.exports.SOURCE_TYPES = SOURCE_TYPES;
module.exports.SOURCE_CONFIDENCE = SOURCE_CONFIDENCE;
