// models/CMS_Models/Merchandising/TnaMilestoneDefinition.js
//
// THE COMPANY'S CONTROLLED LIST OF MILESTONES.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// A template version used to carry a milestone's code, its name, its owning
// department and its completion rule as fields somebody TYPED. Two people
// writing two templates produced "Trim card approved" under `TRIM_APPROVED`
// and the same words under `TRIM_CARD_APPROVED`; "Fabric in house" exists
// twice; `PPC_HANDOVER` means "Execution pack handed to PPC" in one template
// and "File handed to PPC" in another. Once those reach plans, no report can
// answer "how late is the trim card, across every order" — because there is no
// single thing called the trim card.
//
// So the identity of a milestone is a RECORD, maintained by whoever maintains
// the company's process, and a template selects from it. A template step
// chooses which milestone applies, where it sits and what its date is measured
// from. It does not get to say what the milestone IS.
//
// ── AND THE PLAN STILL KEEPS ITS OWN COPY ───────────────────────────────────
// Nothing here reaches into a running plan. `TnaMilestone` already snapshots
// the name, the owner and the completion rule at the moment a plan is created,
// and the plan pins the template version it was built from. Renaming a
// definition next quarter changes what NEW plans are created with and nothing
// else — an order already running keeps the words its schedule was agreed in.
//
// ── THE WORDS ON SCREEN ARE NOT THE WORDS IN THE DATABASE ───────────────────
// `milestoneCode` is precise and internal. `name` is what a merchandiser
// reads, and it is deliberately short and ordinary — "Goods dispatched", not
// "Ex-factory"; "Packaging approved", not "Packaging specification approved".
// `explanation` is the sentence that settles an argument about what counts.
"use strict";

const mongoose = require("mongoose");

const { OWNER_DEPARTMENT, actorRef } = require("./TnaTemplate");
const { CONFIG_KIND, TnaConfiguration } = require("./TnaConfiguration");

/* ── WHERE IN THE COMPANY'S WORK THIS BELONGS ──────────────────────────────
   The boundary this whole library exists to hold. Development proves the
   product; Order Execution makes a confirmed order production-ready and
   ships it. Printing and embroidery development sit in BOTH_CONDITIONAL:
   they belong to Development, and they reappear in an order ONLY when that
   order needs work the development file did not already settle. */
const MILESTONE_STAGE = Object.freeze({
  DEVELOPMENT: "DEVELOPMENT",
  ORDER_EXECUTION: "ORDER_EXECUTION",
  BOTH_CONDITIONAL: "BOTH_CONDITIONAL",
});

/** What the milestone is about, for grouping a long library on screen. */
const MILESTONE_CATEGORY = Object.freeze({
  ORDER: "ORDER",
  BUYER_INPUT: "BUYER_INPUT",
  MATERIALS: "MATERIALS",
  PRINTING: "PRINTING",
  EMBROIDERY: "EMBROIDERY",
  WASHING: "WASHING",
  SAMPLING: "SAMPLING",
  TESTING: "TESTING",
  PACKAGING: "PACKAGING",
  HANDOVER: "HANDOVER",
  PRODUCTION: "PRODUCTION",
  INSPECTION: "INSPECTION",
  DISPATCH: "DISPATCH",
});

/**
 * HOW A MILESTONE GETS ITS DATE.
 *
 * ── TWO WORDS FOR ONE IDEA, AND WHY BOTH SURVIVE ──────────────────────────
 * The template and the plan have always said `completionAuthority`:
 * `MERCHANDISING` or `SOURCE_EVENT`. Those are the right words THERE, because
 * they answer "who may write `actualDate` on this row". A library entry is
 * answering a different question — "is this something a person records, or
 * something a system action records" — and `MANUAL` / `SYSTEM_EVENT` is how a
 * process owner would say it.
 *
 * They map one to one, in `tnaMilestoneLibrary.authorityFor`, and nothing
 * converts them anywhere else. Renaming the existing pair instead would have
 * touched every consumer of a plan for a vocabulary change.
 */
const COMPLETION_METHOD = Object.freeze({
  MANUAL: "MANUAL",
  SYSTEM_EVENT: "SYSTEM_EVENT",
});

/**
 * ── A DISCRIMINATOR ON `TnaConfiguration`, NOT A COLLECTION OF ITS OWN ─────
 * `companyId`, `code` and `isActive` come from the base and are not repeated
 * here. `kind` is set to `MILESTONE` by Mongoose on every save and added to
 * every query on this model, so a milestone can never be read as a reason code
 * or the other way round. The base's header says why the collection is shared.
 *
 * `code` IS the milestone code. The service and every response call it
 * `milestoneCode`, because that is what it is to a reader of a template; on
 * disk it is the shared collection's identity field, which is how the existing
 * unique index `{companyId, code, kind}` gives company-scoped milestone-code
 * uniqueness without a new index being built on a live cluster.
 */
const definitionSchema = new mongoose.Schema(
  {

    /* What a merchandiser reads. Short, ordinary, and no jargon. */
    name: { type: String, trim: true, required: true, maxlength: 80 },

    /* ── THE NAME'S IDENTITY, WHICH IS NOT THE NAME ────────────────────
       "Fabric in house", "fabric in house", "Fabric-in-house" and
       "Fabric  in  house" are four spellings of one milestone, and a unique
       index on the raw name accepts all four — which is how the duplicates
       this list exists to end would come straight back.

       So the DISPLAY name stays exactly as typed, and uniqueness is enforced
       on a derived key: folded case, collapsed spacing, punctuation reduced
       to spaces. Derived by the server in `nameIdentity`, never accepted from
       a caller, and rewritten by the same hook whenever the display name
       changes — a key that could drift from its name would be worse than no
       key at all. */
    nameKey: { type: String, trim: true, required: true, index: true },

    /* The sentence that settles an argument about what counts as done. */
    explanation: { type: String, trim: true, default: "", maxlength: 400 },

    category: { type: String, enum: Object.values(MILESTONE_CATEGORY), required: true },
    stage: { type: String, enum: Object.values(MILESTONE_STAGE), required: true, index: true },

    /* Whose work it is. NOT who can see it: Merchandising can read every
       milestone on an order and owns almost none of them. */
    ownerDepartment: {
      type: String, enum: Object.values(OWNER_DEPARTMENT), required: true,
    },

    completionMethod: {
      type: String, enum: Object.values(COMPLETION_METHOD), required: true,
    },

    /* ── ONE KEY, FROM THE REGISTRY, AND NEVER TYPED ──────────────────
       Set only on a SYSTEM_EVENT milestone, and only to a key the server's
       own event registry knows. A free-text key here is a milestone that
       waits for a message nobody will ever send. */
    systemEventKey: { type: String, trim: true, default: "" },

    /* What has to be true for this to count as done — in the words of the
       department that owns it, not in Merchandising's. */
    completionCriteria: { type: String, trim: true, default: "", maxlength: 400 },

    /* A document, a photograph, an approval reference. Stated here so a
       template author does not have to remember it per order. */
    proofRequired: { type: String, trim: true, default: "", maxlength: 200 },

    createdBy: actorRef(),
    updatedBy: actorRef(),
    revision: { type: Number, default: 0 },
  },
  { timestamps: true },
);

/* ── WHAT ENFORCES ONE MILESTONE PER CODE, AND WHERE IT LIVES ──────────────
   Nothing here. The collection already carries `{companyId, code, kind}` unique,
   declared by `reasonCodeSchema` in `TnaPlan.js`, and with `kind: "MILESTONE"`
   that IS "one milestone per code per company". Re-declaring it would be a
   second definition of one index. This is the single biggest reason the shared
   collection was the right answer rather than merely the available one: the
   guarantee was already built, on a live cluster, and did not have to be. */

/* ── AND ONE SET OF WORDS, WHICH DOES NEED A NEW INDEX ─────────────────────
   Partial, so it constrains only milestones and leaves every reason code in
   this collection alone — a reason code has no `nameKey`, and without the
   filter they would all collide on a missing value.

   On `nameKey`, not `name`: "Fabric in house", "fabric in house",
   "Fabric-in-house" and "Fabric  in  house" are one milestone, and a unique
   index on the raw string accepts all four. See `nameIdentity` below.

   THE INDEX IS THE GUARANTEE, not the service's look-up: two people saving two
   spellings in the same second both read nothing and both insert.

   `autoIndex` is off in production (`server.js`), so declaring it here builds
   it in development and in tests and does NOT touch a live cluster. The exact
   command for production is in
   `scripts/migrations/tna-milestone-name-index.js`, which is a dry run by
   default and is awaiting explicit approval. */
definitionSchema.index(
  { companyId: 1, nameKey: 1 },
  {
    unique: true,
    name: "tna_milestone_name_unique",
    partialFilterExpression: { kind: CONFIG_KIND.MILESTONE },
  },
);

definitionSchema.index({ companyId: 1, stage: 1, category: 1 });

/**
 * THE ONE DERIVATION OF A NAME'S IDENTITY.
 *
 * Exported because three places need the SAME answer: this model's own hook,
 * the service's clash message, and the reconciliation report that lists
 * collisions for a person to resolve. A second copy of these rules would let a
 * report disagree with the index it is reporting on.
 */
function nameIdentity(value) {
  return String(value ?? "")
    .normalize("NFKD")             // "café" and "cafe\u0301" are one word
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")   // hyphens, slashes, ampersands, punctuation
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * ── THE CODE'S RULES, HELD IN A HOOK RATHER THAN ON THE PATH ───────────────
 * `code` is declared on the base, and a Mongoose discriminator may not redeclare
 * a base path — so the milestone's own requirements for it live here. They are
 * the requirements that were on `milestoneCode` before this record moved into
 * the shared collection, unchanged:
 *
 *   • required, and shaped A–Z, 0–9 and underscores;
 *   • IMMUTABLE. A renamed milestone is the same control point under a better
 *     label; a DIFFERENT control point is a different code. Letting this change
 *     would let one report silently start counting two things as one, and every
 *     template and plan that quotes the code would still quote the old meaning.
 */
definitionSchema.pre("validate", function checkCode(next) {
  const code = String(this.code ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,39}$/.test(code)) {
    return next(new Error(
      "A milestone code is A–Z, 0–9 and underscores, three characters or more.",
    ));
  }
  this.code = code;
  if (!this.isNew && this.isModified("code")) {
    return next(new Error(
      `A milestone's code cannot change. ${this.$locals?.originalCode || code} names a `
      + "control point that templates and running plans already quote; a different "
      + "control point is a different milestone.",
    ));
  }
  return next();
});

definitionSchema.post("init", function rememberCode() {
  this.$locals.originalCode = this.code;
});

/* Derived on every save, so the key cannot drift from the name it identifies. */
definitionSchema.pre("validate", function deriveNameKey(next) {
  this.nameKey = nameIdentity(this.name);
  if (!this.nameKey) {
    return next(new Error("A milestone's name must contain at least one letter or digit."));
  }
  return next();
});

/* ── WHAT THE SCHEMA CANNOT SAY ────────────────────────────────────────── */
definitionSchema.pre("validate", function coherentCompletion(next) {
  const manual = this.completionMethod === COMPLETION_METHOD.MANUAL;

  if (manual && this.systemEventKey) {
    return next(new Error(
      `${this.code} is completed by a person, so it cannot also name a `
      + "system event. A milestone has one way of being completed, not two.",
    ));
  }
  if (!manual && !this.systemEventKey) {
    return next(new Error(
      `${this.code} is completed by a system action, so it must name which one. `
      + "A milestone waiting for an unnamed event waits for ever.",
    ));
  }
  /* ── MERCHANDISING DOES NOT MARK ANOTHER DEPARTMENT READY ──────────
     The same rule the template guard already enforces, held one level
     earlier so a library entry cannot be authored into that state at all.
     A manual milestone is one a person in the OWNING department records,
     and the only department with a hand on this application is
     Merchandising. */
  if (manual && this.ownerDepartment !== OWNER_DEPARTMENT.MERCHANDISING) {
    return next(new Error(
      `${this.code} is owned by ${this.ownerDepartment}, so Merchandising cannot `
      + "be the one to mark it done. Give it the system event that will close it.",
    ));
  }
  return next();
});

module.exports = {
  MILESTONE_STAGE, MILESTONE_CATEGORY, COMPLETION_METHOD, nameIdentity,
  MILESTONE_KIND: CONFIG_KIND.MILESTONE,
  TnaMilestoneDefinition: mongoose.models.TnaMilestoneDefinition
    || TnaConfiguration.discriminator(
      "TnaMilestoneDefinition", definitionSchema, CONFIG_KIND.MILESTONE,
    ),
};
