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
/* The calculation shapes and the one money contract every writer obeys.
   Required at the top rather than beside the scenario container below,
   because `minorUnits` is used by the source-fact money schema further up —
   a `const` require lower in the file is in its own temporal dead zone here. */
const {
  costLineSchema, policySnapshotSchema, scenarioSchema, warningSchema, commercialSchema,
  completenessSchema, minorUnits,
} = require("./costingCalculation");

/**
 * Version lifecycle.
 *
 * All three values are declared because a version's status is what tells a
 * reader whether a frozen record is the live one; but only `DRAFT` is
 * reachable in this chunk — nothing transitions a version, and the approval
 * controls that must precede `APPROVED` are Chunk 6's.
 */
/* ── IN_REVIEW JOINS THE VOCABULARY (Chunk 6A) ──────────────────────────────
 * A calculated version is not yet a commercial one. `DRAFT → APPROVED` in a
 * single step would mean the approver's decision and the editor's submission
 * were the same act, and there would be nothing on the record saying anyone
 * had asked. The middle state is what makes "who put this forward, and when"
 * answerable. */
const VERSION_STATES = Object.freeze(["DRAFT", "IN_REVIEW", "APPROVED", "SUPERSEDED"]);

/**
 * The only transitions that exist. Anything else is refused by name rather
 * than by omission, so a caller learns it asked for something impossible
 * instead of watching a write silently do nothing.
 *
 * `SUPERSEDED` is reachable only from `APPROVED`, and only as the side effect
 * of approving a later version — nobody supersedes a version directly.
 */
const VERSION_TRANSITIONS = Object.freeze({
  DRAFT: ["IN_REVIEW"],
  IN_REVIEW: ["APPROVED", "DRAFT"],
  APPROVED: ["SUPERSEDED"],
  SUPERSEDED: [],
});

/** Where a version's content came from. */
const VERSION_ORIGINS = Object.freeze([
  "MANUAL",          // somebody raised it in the costing app
  "CORRECTION",      // a later version replacing an earlier one
  "LEGACY_IMPORT",   // adopted from Enquiry.costingSheets — Chunk 2's adapter
  /* ── AND THE ONE THAT REPLACED "MANUAL" ─────────────────────────────
     Sales pressed Prepare or Refresh on the enquiry, and the orchestration
     service resolved every source and wrote this. "MANUAL" was accurate
     while somebody opened the costing app and pressed Calculate; it is not
     accurate now, and a version that claims a person composed it when a
     service resolved it is a provenance that misleads. */
  "SALES_PREPARATION",
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
  /* ── A DEPARTMENT'S OWN "THIS DOES NOT APPLY" ─────────────────────────
     Merchandising saying a style ships loose, Production saying nothing goes
     outside, Store saying every material is bought in India. Read from their
     record at calculation time and frozen as evidence of a decision somebody
     with the facts actually made.

     Distinct from `MANUAL_ENTRY`, which is what these used to be: a reason
     typed in Costing, by whoever was costing, on another desk's behalf. Old
     versions keep theirs and go on reading; nothing produces another. */
  "DEPARTMENT_DECISION",
  /* ── WHAT SALES ASKED TO BE COSTED ────────────────────────────────────
     The confirmed brief this version answered — its id and its revision, so a
     reader can tell a costing made against Monday's requested quantities from
     one made against Thursday's. VERIFIED: a confirmed commercial decision
     with a named author, not somebody's guess at one. */
  "SALES_COSTING_BRIEF",
  "MANUAL_ENTRY",
]);

const SOURCE_CONFIDENCE = Object.freeze(["PROVISIONAL", "VERIFIED"]);

/* One snapshotted fact from a source. Exactly one of the three value columns
   is populated, so there is no `Mixed` and no way to smuggle an object in.
   `money` is stored the only way canonical money is stored: integer minor
   units plus a currency. */
/* ── THE MONEY RULES LIVE IN THE SCHEMA, NOT ONLY IN THE PARSER ─────────────
 * `services/centralCosting/costingInput.js` refuses malformed money on the way
 * in from HTTP. That is the right place for it and it is not enough: Chunk 2's
 * legacy import, Chunk 3's supplier-offer snapshotting and any future
 * background job write these documents WITHOUT going through a request parser,
 * and each of them would otherwise be free to store 412.5 paise, an unbounded
 * float, or a currency nothing can convert.
 *
 * So the same rules are asserted here, where every writer passes. A validator
 * that repeats a parser is not duplication when the parser is optional. */
const moneySchema = new mongoose.Schema(
  {
    /* Through the shared helper, so a snapshotted supplier price obeys exactly
       the same rule as a calculated total: integer, because paise are not
       divisible; SAFE integer, because beyond 2^53 addition silently stops
       being exact. Zero passes — a waived charge is a real amount, and
       distinguishing it from "nobody said" is the whole reason money is a
       sub-document rather than a bare number. */
    amountMinor: minorUnits({ required: true, label: "amountMinor" }),
    currency: { type: String, required: true, enum: SUPPORTED_CURRENCIES },
  },
  { _id: false },
);

const sourceFactSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 64 },
    text: { type: String, trim: true, maxlength: 300, default: undefined },
    num: {
      type: Number,
      default: undefined,
      validate: {
        /* `NaN` and `Infinity` are what a bad division produces, and mongoose
           will store both happily. A snapshotted "consumption: NaN" is worse
           than a missing one: it looks like a measurement. */
        validator: (v) => v === undefined || v === null || Number.isFinite(v),
        message: (props) => `A numeric source detail must be finite (got ${props.value}).`,
      },
    },
    money: { type: moneySchema, default: undefined },
  },
  { _id: false },
);

/* ── EXACTLY ONE VALUE PER FACT ────────────────────────────────────────────
 * Two columns would make "which one is the real value" a question every later
 * reader has to answer, and they would not all answer it the same way. None
 * at all is a labelled blank pretending to be a snapshot. Both are refused at
 * the schema, so a service that skips the request parser still cannot write
 * one. */
sourceFactSchema.pre("validate", function (next) {
  const given = ["text", "num", "money"].filter(
    (k) => this[k] !== undefined && this[k] !== null,
  );
  if (given.length === 1) return next();
  const err = new Error(
    given.length === 0
      ? `Source detail "${this.key}" carries no value; a fact must record one of text, num or money.`
      : `Source detail "${this.key}" carries ${given.join(" and ")}; a fact records exactly one value.`,
  );
  err.name = "CostingSourceFactError";
  return next(err);
});

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

/* ── THE CALCULATION SHAPES ─────────────────────────────────────────────────
 * Chunk 1 declared an empty scenario container and said Chunk 2 would fill it
 * in. It did, and it EXTENDED it rather than replacing it: a scenario is still
 * `{key, label, quantity, isPrimary}` and now also carries what those inputs
 * worked out to. The subschemas live in their own file because there are a
 * dozen of them and they are about arithmetic, not about identity. */
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

    /* ── THE LIFECYCLE RECORD, ON THE VERSION ITSELF ─────────────────────
       Written ONLY by `services/centralCosting/lifecycle.service.js`, through
       the narrow mechanism documented with the immutability guard below. The
       full evidence — including the policy revision the decision was taken
       against and the request identity — is a separate immutable document
       (`CostingTransition`); these fields are the part a reader of the
       version needs without a second query.

       Absent on a draft. Not defaulted to empty strings, because "" and
       "nobody has done this" would then be the same value. */
    lifecycle: {
      submittedBy: { type: String, trim: true },
      submittedByName: { type: String, trim: true },
      submittedAt: { type: Date },
      submissionNote: { type: String, trim: true },

      /* ── RETURNED TO SALES ────────────────────────────────────────
         The reviewer's reason, and who gave it. Held here as well as on the
         immutable transition so a screen showing a DRAFT can say why it is
         a draft again without a second query — which is the same reason
         the submission fields are here.

         Cleared on the next submission, so a version cannot read as both
         returned and under review at once. */
      returnedBy: { type: String, trim: true },
      returnedByName: { type: String, trim: true },
      returnedAt: { type: Date },
      returnReason: { type: String, trim: true },

      approvedBy: { type: String, trim: true },
      approvedByName: { type: String, trim: true },
      approvedAt: { type: Date },
      /* The approver's reason. Required by the SERVICE, not the schema: a
         draft legitimately has none, and a schema-required field would make
         every draft invalid. */
      approvalNote: { type: String, trim: true },
      /* Which policy revision the decision was taken against — so a later
         policy change cannot make an old approval look like it was judged
         against today's floor. */
      policyRevisionAtApproval: { type: Number },

      /* Set when a LATER version is approved. Says which one replaced this,
         so a superseded record explains itself without a search. */
      supersededByVersionId: { type: mongoose.Schema.Types.ObjectId },
      supersededByVersionNumber: { type: Number },
      supersededAt: { type: Date },
    },

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

      /* ── ONE USER ACTION, ONE VERSION ──────────────────────────────────
         The same durable creation claim the parent costing carries, for the
         same reason: the idempotency effect marker is a second write and a
         second write can fail, so the defence has to be on the record the
         write itself creates, enforced by an index rather than by a code path
         that remembers to check. Derived on the server from {company, actor,
         operation, idempotency key}; absent on a version created by an
         internal import, which has no HTTP retry to protect against. */
      creationClaimId: { type: String, trim: true, default: undefined },
      creationRequestHash: { type: String, trim: true, default: undefined },
      /* ── WHAT THE KEY WAS SPENT ON ─────────────────────────────────────
         The claim id deliberately does NOT include the target (see
         Middlewear/centralCostingContext.js), so the same key aimed at a
         different costing collides here rather than quietly succeeding once
         the bookkeeping row has expired. This field is what lets the handler
         tell the two apart and answer 409 instead of replaying somebody
         else's costing. */
      creationClaimTarget: { type: String, trim: true, default: undefined },

      /* ── AND ONE LEGACY SOURCE, ONE VERSION ────────────────────────────
         A content hash of the legacy costing sheet this version was imported
         from. Re-importing an UNCHANGED sheet hits the unique index below and
         is recovered rather than duplicated; re-importing a CHANGED one has a
         different key and legitimately produces a new version, which is what
         a new version is for. */
      legacyImportKey: { type: String, trim: true, default: undefined },

      /* ── WHAT THIS VERSION WAS CALCULATED FROM, AS ONE VALUE ───────────
         A hash over every source fact that materially moves the estimate: the
         Sales brief's revision, the approved technical revision, each
         material's effective consumption and allowance, the route and its
         SAM, the service requirements, the shipment facts, every quotation
         identity and revision, Store's sourcing decisions, and the identity
         of each Board policy in force on the costing date.

         ── WHY A STORED HASH AND NOT A LIVE COMPARISON ─────────────────
         "Have the inputs changed since this was costed?" cannot be answered
         by reading today's sources alone — there is nothing to compare them
         to. It needs what the version was actually built from, and it has to
         survive on the frozen record, because the question is asked about
         versions that were frozen months ago.

         ── AND THE PARTS, NOT ONLY THE HASH ────────────────────────────
         A hash alone says something changed and cannot say what. "Inputs
         changed — refresh the estimate" is a message somebody can act on;
         "inputs changed" with no way to learn which is a message that gets
         ignored, and a false positive nobody can debug. Each part is a short
         opaque token, never the value it summarises: a quotation's identity
         and revision, never its rate. */
      sourceFingerprint: { type: String, trim: true, default: undefined },
      sourceFingerprintParts: {
        type: [new mongoose.Schema({
          key: { type: String, trim: true, required: true, maxlength: 60 },
          /* A token, not a figure. `mat:<id>:1.5225` is a consumption that
             can be compared and cannot be read back as a price. */
          token: { type: String, trim: true, required: true, maxlength: 200 },
          /* What a person is told changed. No value, no rate, no policy
             percentage — the name of the fact and its owner. */
          label: { type: String, trim: true, maxlength: 160 },
          owner: { type: String, trim: true, maxlength: 60 },
        }, { _id: false })],
        default: undefined,
      },
    },

    /* What this version was built from, as it read then. */
    sourceReferences: { type: [sourceReferenceSchema], default: () => [] },

    /* ── THE INPUTS, VERBATIM ─────────────────────────────────────────────
       The explicit cost lines the calculation ran on. Stored so the number is
       re-derivable from the version alone: given these, this policy and this
       engine version, the scenarios below follow. */
    /* ── FROZEN COMMERCIAL EVIDENCE (Chunk 3.2) ─────────────────────────
       One entry per quotation-backed line: which offer, which revision, which
       tier, through what conversion, and what it was valid until — as it all
       stood on the costing date.

       A SNAPSHOT, not a reference. Store may revise or withdraw that
       quotation tomorrow; this version must go on saying what produced its
       rate, or every historical costing silently re-prices itself the moment
       a supplier sends a new quote. `strict: false` on the subdocument would
       be the easy way to carry it and is deliberately not used — a field
       nobody declared is a field nobody can rely on. */
    /* ── WHAT THE COMPANY CHARGED FOR ITS OWN DEVELOPMENT WORK ─────────
       A one-time charge Finance published, for work nobody outside was paid
       for. It has no supplier, no quotation reference and no tier, so it is
       NOT an offer — putting it among them would leave a reader looking for
       evidence that was never claimed.

       Declared rather than carried by `strict: false`, like everything else
       here: a field nobody declared is a field nobody can rely on. */
    policyProvenance: {
      type: [new mongoose.Schema({
        lineKey: { type: String, trim: true, required: true },
        state: { type: String, trim: true, default: "COMPANY_POLICY" },
        chargeKey: { type: String, trim: true },
        chargeLabel: { type: String, trim: true },
        /* ── HOW THE FIGURE WAS ARRIVED AT ────────────────────────────
           A total alone cannot be checked a year later. `FLAT_PER_RUN` says
           the amount IS the charge; `PER_REQUIREMENT_UNIT` says it was a
           quantity of something at a unit rate, and both halves have to be
           on the record for anybody to re-do the arithmetic. */
        calculation: { type: String, trim: true, default: undefined },
        unit: { type: String, trim: true, default: null },
        /* Decimal-safe as a string, like every other quantity here. */
        quantity: { type: String, trim: true, default: null },
        unitAmountMinor: { type: Number, default: null },
        /* The total for the run: the amount itself, or quantity × unit. */
        amountMinor: { type: Number },
        currency: { type: String, trim: true },
        basis: { type: String, trim: true },
        /* The SELECTED rate period, frozen — not the definition's whole
           history. A later period added beside it does not move this one, and
           a reader can find exactly the rate this costing used. */
        effectiveFrom: { type: Date, default: null },
        effectiveTo: { type: Date, default: null },
        /* Which revision of the policy carried it. */
        policyRevision: { type: Number, default: null },
        asOf: { type: Date },
        /* ── AND WHICH REQUIREMENT ASKED FOR IT ───────────────────────
           A style may legitimately need the same charge twice. Without the
           row's own identity the two are indistinguishable on the record. */
        requirementKey: { type: String, trim: true, default: null },
        evidence: { type: String, trim: true, default: null },
      }, { _id: false })],
      default: undefined,
    },

    /* ── HOW THE FINISHED ORDER GETS THERE, AND WHAT THAT COST ──────────
       A freight figure is only checkable if the lane, the shipment and the
       quotation behind it are all on the record. "₹8,400" a year later
       cannot be argued with; "7 cartons at ₹1,200, Ludhiana to Bengaluru by
       road, on quotation TR-2026-114" can be.

       A recorded ZERO is frozen here too, with the arrangement that produced
       it — an ex-works order costs the company nothing to deliver, and that
       is an answer somebody gave rather than a line nobody wrote. */
    freightProvenance: {
      type: new mongoose.Schema({
        lineKey: { type: String, trim: true, required: true },
        /* `RECORDED_ZERO` or `SUPPLIER_QUOTATION`. */
        state: { type: String, trim: true, required: true },
        /* Who bears it, and whether that was agreed on this enquiry or is the
           customer's standing term — different claims about different things. */
        arrangement: { type: String, trim: true },
        arrangementSource: { type: String, trim: true },
        prepaidTreatment: { type: String, trim: true, default: null },
        /* ── WHICH ACCOUNTING OUTCOME ─────────────────────────────────
           `COMPANY_BEARS` — inside the price. `RECOVERED_SEPARATELY` — paid
           by us and billed on at cost, out of the garment's price basis and
           onto its own line. The same arrangement produces both, so the
           record has to say which. */
        recovery: { type: String, trim: true, default: null },
        recoveryMarkup: { type: String, trim: true, default: null },
        enquiryRef: { type: String, trim: true, default: "" },

        /* The lane, as both identity and snapshot: the id so it can be found
           again, the words so it stays readable when the record moves. */
        originWarehouseId: { type: mongoose.Schema.Types.ObjectId, default: null },
        originName: { type: String, trim: true, default: "" },
        originCity: { type: String, trim: true, default: "" },
        destinationAddressId: { type: mongoose.Schema.Types.ObjectId, default: null },
        destinationLabel: { type: String, trim: true, default: "" },
        destinationCity: { type: String, trim: true, default: "" },
        destinationRegion: { type: String, trim: true, default: "" },
        destinationCountry: { type: String, trim: true, default: "" },
        mode: { type: String, trim: true, default: null },

        /* The transporter and the quotation. */
        supplierId: { type: mongoose.Schema.Types.ObjectId, default: null },
        supplierName: { type: String, trim: true, default: "" },
        offerId: { type: mongoose.Schema.Types.ObjectId, default: null },
        offerRevision: { type: Number, default: null },
        quotationReference: { type: String, trim: true, default: "" },
        quotationDate: { type: Date, default: null },
        effectiveFrom: { type: Date, default: null },
        validUntil: { type: Date, default: null },

        basis: { type: String, trim: true, default: null },
        rateMinor: { type: Number, default: null },
        currency: { type: String, trim: true, default: null },
        minimumChargeMinor: { type: Number, default: null },
        taxTreatment: { type: String, trim: true, default: null },
        gstRatePercent: { type: Number, default: null },
        sacCode: { type: String, trim: true, default: null },

        /* What the garment ships as — the facts the working rests on. */
        packedWeightGrams: { type: Number, default: null },
        garmentsPerCarton: { type: Number, default: null },
        deliveryCount: { type: Number, default: null },

        /* One working per scenario: 100 garments and 1,000 fill different
           numbers of cartons, and each is shown as it was arrived at. */
        scenarios: {
          type: [new mongoose.Schema({
            scenarioKey: { type: String, trim: true, required: true },
            quantity: { type: String, trim: true },
            chargeableUnit: { type: String, trim: true },
            chargeable: { type: String, trim: true },
            working: { type: mongoose.Schema.Types.Mixed },
            beforeMinimumMinor: { type: Number, default: null },
            minimumChargeApplied: { type: Boolean, default: false },
            freightMinor: { type: Number, default: null },
          }, { _id: false })],
          default: undefined,
        },

        asOf: { type: Date },
      }, { _id: false }),
      default: undefined,
    },

    /* ── WHAT IT COST TO WAIT TO BE PAID, AND WHY THAT NUMBER ──────────
       A financing figure is only checkable if the rule AND the agreement
       behind it are both on the record. "1.04% of the subtotal" a year later
       cannot be argued with; "12% a year, on the 70% still outstanding, for
       45 days from the invoice, under the policy the Board approved on 1 July"
       can be.

       Both halves are copied BY VALUE, not referenced. `boardPolicyId` is here
       so the decision can be found; every figure beside it is here so the
       calculation can be checked without finding it — and so that approving a
       new policy, backdating one, or Sales renegotiating with the customer
       cannot restate a costing that was frozen before any of it happened.

       A recorded ZERO is frozen here too, with the terms that produced it: an
       order paid in full up front costs nothing to finance, and that is an
       answer somebody gave rather than a line nobody wrote. So is a stated
       "financing does not apply". Neither reads the same as silence, which
       produces no line and no record at all. */
    /* ── WHAT THE COMPANY ADDED TO COVER RUNNING ITSELF, AND WHY ───────
       Overhead was the one cost family a version could not explain. The
       snapshot carried a rate and a basis NAME, and neither is checkable a
       year later: `DIRECT_PLUS_FIXED` is a computed subtotal that depends on
       every other line on the version, so "12% of direct plus fixed" cannot be
       re-derived from the record without recalculating the whole costing.

       So three things are frozen together — the Board's decision (identified
       AND copied, so it can be found and checked without being found), the
       rule itself, and per scenario the amount the percentage was applied to
       beside the amount it produced.

       Absent on a version calculated before the Board took the rate over.
       Those keep `policySnapshot.overheadRatePercent`, which IS what they were
       calculated with — reading them through this field would claim a Board
       approval that never happened. */
    /* ── WHAT A MINUTE OF AN OPERATOR'S TIME COST, AND WHY ─────────────
       Labour was the family a version could explain least. The snapshot
       carried four assumptions and no working, so "₹3.54 for this operation"
       could not be checked without re-reading the sample, the operation master
       and the policy — and if any of the three had moved since, it could not
       be checked at all.

       Two things are frozen together. The Board's DECISION, copied by value so
       it can be checked without being found. And the per-operation WORKINGS —
       the SAM, the salary basis, the employer monthly cost, the productive
       minutes, the cost per minute and the resulting figure — which the
       assembly has always computed and no version has ever kept.

       ── AND THE METHOD IS NOT THE NUMBER ────────────────────────────────
       "80% efficiency" is what the Board decided; 9,984 minutes is what the
       arithmetic divided by. Both are here, because a reader checking a rate
       needs the second and an auditor asking what was agreed needs the first.

       Absent on a version calculated before the Board took the methodology
       over. Those keep `policySnapshot`'s four fields, which IS what they were
       calculated with. */
    /* ── WHETHER THE TAX ON EVERY PURCHASE WAS COST, AND WHO DECIDED ───
       The per-line workings were already frozen and stay where they are: each
       cost line carries `tax.treatment` and `tax.ratePercent`, each scenario's
       line result carries `taxMinor`, each scenario carries
       `recoverableTaxMinor`, and `offerProvenance` carries the quotation's own
       rate and the offer it came from.

       What no version could say is WHICH company decision produced the
       treatment on those lines. `policySnapshot.inputGstTreatment` recorded the
       value and nothing about its authority — no approver, no effective date,
       no version to point at. This is that missing half.

       Absent on a version calculated before the Board took the treatment over.
       Those keep the snapshot's own field, which IS what they were priced
       with; reading them through this block would claim an approval that never
       happened. */
    gstProvenance: {
      type: new mongoose.Schema({
        state: { type: String, trim: true, required: true },
        boardPolicyId: { type: mongoose.Schema.Types.ObjectId, default: null },
        policyKey: { type: String, trim: true, default: "GST_TAX_POLICY" },
        policyEffectiveFrom: { type: Date, default: null },
        policyApprovedAt: { type: Date, default: null },
        policyApprovedByName: { type: String, trim: true, default: "" },
        /* `RECOVERABLE` or `NON_RECOVERABLE`. Never `NONE`: that is a
           QUOTATION's statement that a supply is not taxable, and it lives on
           the line, not on the company decision. */
        inputGstTreatment: { type: String, trim: true, default: null },
        asOf: { type: Date },
      }, { _id: false }),
      default: undefined,
    },

    /* ── AND WHAT CUSTOMS CHARGED TO BRING THE IMPORTED PARTS IN ────────
       One entry per imported input that produced a duty line, frozen with the
       three desks' facts that made it computable: Store's quotation and its
       revision, the item's tariff heading, and the Board's rule.

       ── AND THE BASE IT WAS CHARGED ON, SAID EXPLICITLY ────────────────
       `assessableBasis` is on every entry because this is NOT the statutory
       CIF assessable value — no inbound freight, insurance or exchange rate is
       recorded anywhere in this system, so CIF cannot be computed. A version
       that did not say which base it used could be read years later as a
       customs computation it never was.

       ── AND A ZERO-RATED ENTRY IS NOT A MISSING ONE ────────────────────
       `state` distinguishes `APPLIED` from `ZERO_RATED`: the Board checking a
       heading and approving 0% is evidence, and it must not read the same as
       no rule having existed.

       ── NOR IS AN ENTRY THAT CHARGED NOTHING AT ALL ────────────────────
       An import whose quoted rate ALREADY includes the duty produces an entry
       with `dutyInQuotedRate: "INCLUDED"`, no rate and no scenarios: a
       recorded reason why this costing has no duty line for that input,
       rather than an omission a later reader would have to guess at. */
    dutyProvenance: {
      type: [new mongoose.Schema({
        state: { type: String, trim: true, required: true },
        /* The material or packaging line the duty was charged on — or, for an
           `INCLUDED` entry, the line whose rate already carries it. */
        dutiedLineKey: { type: String, trim: true, required: true },
        /* The position in the words the screens use, so the record explains
           itself without the reader reconstructing it from the state. */
        note: { type: String, trim: true, default: "" },

        boardPolicyId: { type: mongoose.Schema.Types.ObjectId, default: null },
        policyKey: { type: String, trim: true, default: "DUTY_POLICY" },
        policyEffectiveFrom: { type: Date, default: null },
        policyApprovedAt: { type: Date, default: null },
        policyApprovedByName: { type: String, trim: true, default: "" },

        /* The rule, by its permanent key, with the window it was in force for
           — the thing a reader has to be able to find again. */
        ruleKey: { type: String, trim: true, default: null },
        ruleLabel: { type: String, trim: true, default: "" },
        ruleEffectiveFrom: { type: Date, default: null },
        ruleEffectiveTo: { type: Date, default: null },

        customsTariffCode: { type: String, trim: true, default: null },
        countryOfOrigin: { type: String, trim: true, default: null },
        ratePercent: { type: String, trim: true, default: null },

        assessableBasis: { type: String, trim: true, default: "QUOTATION_PURCHASE_AMOUNT" },

        /* Store's evidence, identified so the claim traces to paper. The
           supplier's RATE is never here — the basis amount below is what a
           reader needs, and it is already this costing's own figure. */
        offerId: { type: mongoose.Schema.Types.ObjectId, default: null },
        offerReference: { type: String, trim: true, default: "" },
        offerRevision: { type: Number, default: null },
        dutyInQuotedRate: { type: String, trim: true, default: null },

        scenarios: {
          type: [new mongoose.Schema({
            scenarioKey: { type: String, trim: true, required: true },
            basisAmountMinor: { type: Number, default: null },
            dutyMinor: { type: Number, default: null },
          }, { _id: false })],
          default: undefined,
        },
        asOf: { type: Date },
      }, { _id: false })],
      default: undefined,
    },

    /* ── AND WHICH APPROVED BAND EVERY PRICE BREAK WAS SOLVED FROM ──────
       The band VALUES are already frozen in `policySnapshot` and are what the
       engine used; `commercial.bridge` carries where each proposed price stood
       against them. What no version could say is which approved DECISION set
       them, and who stands behind it.

       Absent on a version calculated before the Board took the band over.
       Those keep `policySnapshot`'s three fields, which IS what they were
       priced with; reading them through this block would claim an approval
       that never happened. */
    marginProvenance: {
      type: new mongoose.Schema({
        state: { type: String, trim: true, required: true },
        boardPolicyId: { type: mongoose.Schema.Types.ObjectId, default: null },
        policyKey: { type: String, trim: true, default: "MARGIN_POLICY" },
        policyEffectiveFrom: { type: Date, default: null },
        policyApprovedAt: { type: Date, default: null },
        policyApprovedByName: { type: String, trim: true, default: "" },
        rationale: { type: String, trim: true, default: "" },

        /* ── WHICH PRICING CONTRACT PRICED THIS VERSION ──────────────────
           `MARKUP_FLOOR_V2` for a floor, `MARGIN_BAND_V1` for the retired
           band. Absent on versions frozen before the contract was named,
           which are all bands. Stored rather than inferred from which fields
           are filled: a reader must be able to ask the version what it is,
           not deduce it from what it happens to be missing. */
        pricingContract: { type: String, trim: true, default: undefined },
        /* The one figure management approved, frozen beside the identity of
           the decision that set it. */
        floorMarkupPercent: { type: String, trim: true, default: null },
        calculationMethod: { type: String, trim: true, default: undefined },

        /* Margins, never markup: price = cost / (1 - margin). */
        minimumMarginPercent: { type: String, trim: true, default: null },
        targetMarginPercent: { type: String, trim: true, default: null },
        preferredMarginPercent: { type: String, trim: true, default: null },

        /* ── RECORDED, AND SAID NOT TO BE ENFORCED ────────────────────
           Nothing in this system consults a threshold — there is no costing
           approval workflow that reads one. Freezing the number without this
           flag beside it would let a reader years later assume a price below
           it had passed an approval that never existed. */
        approvalThresholdMarginPercent: { type: String, trim: true, default: null },
        approvalThresholdEnforced: { type: Boolean, default: false },

        /* An AFTER-TAX PROFIT ESTIMATE. Not GST — that is `gstProvenance`,
           it is about tax on purchases, and it changes what a garment costs.
           This changes no cost and no price; it turns a pre-tax profit figure
           into an after-tax one in the commentary. */
        estimatedIncomeTaxRatePercent: { type: String, trim: true, default: null },
        asOf: { type: Date },
      }, { _id: false }),
      default: undefined,
    },

    /* ── AND WHETHER A STANDARD CONTINGENCY WAS ADDED, AND WHO SAID SO ──
       The one provenance block in this family that is frozen even when NOTHING
       WAS CHARGED, and that is the whole reason it exists.

       A version with no contingency line is mute. It cannot say whether the
       company had decided it does not add one — a real commercial posture,
       with a name and a date behind it — or whether nobody had ever considered
       the question when this price went out. Under the retired
       `policySnapshot.contingencyRatePercent` those two were the same absence.

       So `state` is `APPLIED`, `DECIDED_NONE` or `POLICY_MISSING`, and for the
       middle one the `rationale` IS the evidence: it is what an auditor reads
       in place of a line.

       Absent on a version calculated before the Board took contingency over.
       Those keep `policySnapshot`'s two fields, which IS what they were
       calculated with. */
    contingencyProvenance: {
      type: new mongoose.Schema({
        state: { type: String, trim: true, required: true },
        /* `APPLY` or `NONE`. Null where no policy was in force — the mode is
           the Board's answer, and there is no answer to record. */
        mode: { type: String, trim: true, default: null },
        boardPolicyId: { type: mongoose.Schema.Types.ObjectId, default: null },
        policyKey: { type: String, trim: true, default: "CONTINGENCY_POLICY" },
        policyEffectiveFrom: { type: Date, default: null },
        policyApprovedAt: { type: Date, default: null },
        policyApprovedByName: { type: String, trim: true, default: "" },
        /* Carried onto the version rather than left on the policy: a `NONE`
           decision has no arithmetic, so its reason is the only thing that
           explains the absence of a line. */
        rationale: { type: String, trim: true, default: "" },
        ratePercent: { type: String, trim: true, default: null },
        basis: { type: String, trim: true, default: null },
        /* ── THE WORKING, PER SCENARIO ────────────────────────────────
           What the rate was charged ON and what it came to, read off the
           engine's own result rather than recomputed — a block that
           recalculated the figure could disagree with the figure it
           describes. Empty for every state but APPLIED: there is no working
           behind a decision not to charge something. */
        scenarios: {
          type: [new mongoose.Schema({
            scenarioKey: { type: String, trim: true, required: true },
            basisAmountMinor: { type: Number, default: null },
            contingencyMinor: { type: Number, default: null },
          }, { _id: false })],
          default: undefined,
        },
      }, { _id: false }),
      default: undefined,
    },

    /* ── AND WHICH APPROVED CATALOGUE THE DEVELOPMENT CHARGES CAME FROM ─
       The per-line workings were already frozen and stay exactly where they
       are: `policyProvenance` carries, for each line priced in-house, the
       charge key and label, the calculation, the unit, the quantity, the unit
       amount, the total and the rate period that was selected.

       What no version could say is which approved CATALOGUE that charge was
       read out of, and who approved it — the outer of the two dating layers.
       This is that half. It carries no amounts: the amounts that mattered are
       already on the lines, and copying every rate the company publishes onto
       every costing would put a rate card on a garment.

       Absent on a version calculated before the Board took the catalogue over.
       Those keep `policySnapshot.developmentCharges`, which IS the table they
       were priced from. */
    developmentProvenance: {
      type: new mongoose.Schema({
        state: { type: String, trim: true, required: true },
        boardPolicyId: { type: mongoose.Schema.Types.ObjectId, default: null },
        policyKey: { type: String, trim: true, default: "DEVELOPMENT_CHARGE_POLICY" },
        policyEffectiveFrom: { type: Date, default: null },
        policyApprovedAt: { type: Date, default: null },
        policyApprovedByName: { type: String, trim: true, default: "" },
        /* How many charges the catalogue held — enough to notice that a
           costing was priced against a catalogue of three when today's has
           eleven, without reproducing either. */
        chargeCount: { type: Number, default: null },
        asOf: { type: Date },
      }, { _id: false }),
      default: undefined,
    },

    labourProvenance: {
      type: new mongoose.Schema({
        state: { type: String, trim: true, required: true },

        /* The Board's decision, identified and copied. */
        boardPolicyId: { type: mongoose.Schema.Types.ObjectId, default: null },
        policyKey: { type: String, trim: true, default: "LABOUR_METHODOLOGY" },
        policyEffectiveFrom: { type: Date, default: null },
        policyApprovedAt: { type: Date, default: null },
        policyApprovedByName: { type: String, trim: true, default: "" },

        /* The method the Board chose, and the minutes it came to. */
        productiveBasis: { type: String, trim: true, default: null },
        productiveMinutesPerMonth: { type: Number, default: null },
        labourEfficiencyPercent: { type: String, trim: true, default: null },
        productiveMinutesResolved: { type: String, trim: true, default: null },

        employerBurdenPercent: { type: String, trim: true, default: null },
        machineBurdenTreatment: { type: String, trim: true, default: null },
        /* An exclusion has to say why. Only `NOT_COSTED` carries one. */
        machineExclusionReason: { type: String, trim: true, default: "" },

        /* ── WHAT AN APPROVED POLICY STILL LEFT OPEN ──────────────────
           `IN_OPERATION_RATE` with no machine master, or `IN_OVERHEAD` with no
           overhead policy in force. Frozen as it stood, so a version costed
           while the source was missing goes on saying so rather than looking
           complete the day somebody builds one. */
        dependencies: {
          type: [new mongoose.Schema({
            code: { type: String, trim: true },
            message: { type: String, trim: true },
          }, { _id: false })],
          default: undefined,
        },

        /* ── ONE WORKING PER OPERATION ────────────────────────────────
           Not per scenario: an operation's labour is a PER_UNIT rate, the same
           on every run size. What differs between operations is the SAM and
           the salary basis, and those are what a reader is checking. */
        operations: {
          type: [new mongoose.Schema({
            lineKey: { type: String, trim: true, required: true },
            label: { type: String, trim: true, default: "" },
            samMinutes: { type: String, trim: true, default: null },
            netSalaryPerMonth: { type: String, trim: true, default: null },
            employerCostPerMonth: { type: String, trim: true, default: null },
            productiveMinutesPerMonth: { type: String, trim: true, default: null },
            productiveBasisLabel: { type: String, trim: true, default: "" },
            costPerMinute: { type: String, trim: true, default: null },
            amountMinor: { type: Number, default: null },
          }, { _id: false })],
          default: undefined,
        },

        asOf: { type: Date },
      }, { _id: false }),
      default: undefined,
    },

    overheadProvenance: {
      type: new mongoose.Schema({
        lineKey: { type: String, trim: true, required: true },
        state: { type: String, trim: true, required: true },

        /* The Board's decision, identified and copied. */
        boardPolicyId: { type: mongoose.Schema.Types.ObjectId, default: null },
        policyKey: { type: String, trim: true, default: "OVERHEAD" },
        policyEffectiveFrom: { type: Date, default: null },
        policyApprovedAt: { type: Date, default: null },
        policyApprovedByName: { type: String, trim: true, default: "" },

        /* The rule. Both halves: a rate without the subtotal it applies to is
           a percentage of something unstated. */
        ratePercent: { type: String, trim: true, default: null },
        basis: { type: String, trim: true, default: null },

        /* ── ONE WORKING PER SCENARIO ─────────────────────────────────
           The same rate on the same basis produces different money at 500
           garments and at 3,000, and each is shown as it was arrived at.
           `basisAmountMinor` is the figure a reader needs to re-do the
           arithmetic and is not otherwise recoverable from the version — it
           is a subtotal across a category set, not a line. */
        scenarios: {
          type: [new mongoose.Schema({
            scenarioKey: { type: String, trim: true, default: null },
            quantity: { type: String, trim: true, default: null },
            basisAmountMinor: { type: Number, default: null },
            overheadMinor: { type: Number, default: null },
            perUnitMinor: { type: Number, default: null },
          }, { _id: false })],
          default: undefined,
        },

        asOf: { type: Date },
      }, { _id: false }),
      default: undefined,
    },

    financingProvenance: {
      type: new mongoose.Schema({
        lineKey: { type: String, trim: true, required: true },
        /* `CALCULATED`, `RECORDED_ZERO` or `NOT_APPLICABLE`. The two states
           that mean nobody had decided yet never reach a version — they
           produce no line, which is the point. */
        state: { type: String, trim: true, required: true },

        /* The Board's decision, identified and copied. */
        boardPolicyId: { type: mongoose.Schema.Types.ObjectId, default: null },
        policyKey: { type: String, trim: true, default: "FINANCING" },
        policyEffectiveFrom: { type: Date, default: null },
        policyApprovedAt: { type: Date, default: null },
        policyApprovedByName: { type: String, trim: true, default: "" },
        /* Per year, always — the reason `dayCountBasis` is beside it. */
        annualRatePercent: { type: String, trim: true, default: null },
        basis: { type: String, trim: true, default: null },
        /* Whether the advance came off the financed amount. A Board decision,
           and the single assumption that most changes the figure on an order
           with a large advance — so it is recorded, never inferred. */
        advanceTreatment: { type: String, trim: true, default: null },
        dayCountBasis: { type: Number, default: null },

        /* Sales' side of it, copied for the same reason. */
        enquiryRef: { type: String, trim: true, default: "" },
        termsState: { type: String, trim: true, default: null },
        advancePercent: { type: String, trim: true, default: null },
        creditDays: { type: Number, default: null },
        /* Thirty days from the invoice and thirty from the bill of lading
           differ by the whole shipping time. */
        creditDaysFrom: { type: String, trim: true, default: null },
        termsSource: { type: String, trim: true, default: null },
        termsConfirmedAt: { type: Date, default: null },
        termsConfirmedByName: { type: String, trim: true, default: "" },
        notApplicableReason: { type: String, trim: true, default: "" },

        /* And the arithmetic, so nobody has to reconstruct it from the two
           halves and hope they combined them the way the engine did. */
        financedSharePercent: { type: String, trim: true, default: null },
        effectivePercent: { type: String, trim: true, default: null },
        formula: { type: String, trim: true, default: null },

        asOf: { type: Date },
      }, { _id: false }),
      default: undefined,
    },

    offerProvenance: {
      type: [new mongoose.Schema({
        lineKey: { type: String, trim: true, required: true },
        /* ── WHETHER THE RATE INCLUDED GETTING IT HERE ────────────────
           `INCLUSIVE_LANDED` means the quoted material rate delivers to our
           warehouse, so no inbound freight belongs beside it.
           `EXCLUSIVE` means it does not. Absent means nobody asked — which is
           an unanswered question and not a landed rate. */
        freightTerms: { type: String, trim: true, default: null },
        incoterm: { type: String, trim: true, default: null },
        /* Which rule selected this quotation over the others that applied —
           `VARIANT_SPECIFIC_PREFERRED`, `VARIANT_SPECIFIC` or `WHOLE_ITEM`.
           "Why this rate and not the other" is the question asked six months
           later, when the register has moved. */
        selectionRule: { type: String, trim: true, default: null },
        variantSpecific: { type: Boolean, default: false },
        state: { type: String, trim: true, default: "SUPPLIER_QUOTATION" },
        offerId: { type: mongoose.Schema.Types.ObjectId },
        offerRevision: { type: Number },
        supplierId: { type: mongoose.Schema.Types.ObjectId },
        supplierName: { type: String, trim: true },
        itemId: { type: mongoose.Schema.Types.ObjectId },
        variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
        supplierItemCode: { type: String, trim: true },
        supplierItemName: { type: String, trim: true },
        /* ── READABLE AFTER THE MASTERS MOVE ON ─────────────────────────
           An id is not evidence. A costing from March must still say which
           item and which variant it costed after both have been renamed,
           and which quotation document it came from after the supplier
           recoded their catalogue. Plain strings, never a live handle. */
        itemName: { type: String, trim: true },
        itemSku: { type: String, trim: true },
        variantLabel: { type: String, trim: true },
        variantSku: { type: String, trim: true },
        document: {
          label: { type: String, trim: true },
          url: { type: String, trim: true },
          storedAt: { type: String, trim: true },
        },
        quotationReference: { type: String, trim: true },
        quotationDate: { type: Date },
        asOf: { type: Date },
        currency: { type: String, trim: true },
        quotedAmountMinor: { type: Number },
        priceBasis: { type: String, trim: true },
        /* Null is "not recorded". 0 is a recorded zero-rate. */
        gstRatePercent: { type: Number, default: null },
        gstRecorded: { type: Boolean, default: false },
        /* ── WHETHER THE COMPANY GOT THAT GST BACK ──────────────────────
           The rate alone does not say it, and it is the difference between
           the tax being garment cost and not being garment cost. A version
           that recorded only the rate could not be re-read a year later. */
        gstTreatment: { type: String, trim: true },
        /* The quotation's own HSN/SAC. The RawItem master carries none, so
           this is the only place the classification is recorded — and saying
           where it came from is part of the evidence. */
        hsnCode: { type: String, trim: true },
        /* The tax split as it was worked out, so a reader is not left to
           re-derive it from a rate and a rounding rule that have since moved. */
        gstAmountMinor: { type: Number, default: null },
        grossRateMinor: { type: Number, default: null },
        roundingMode: { type: String, trim: true },
        netRateMinor: { type: Number },
        netRateDerived: { type: Boolean, default: false },
        purchaseUom: { type: String, trim: true },
        consumptionUom: { type: String, trim: true },
        /* Strings, because a conversion factor is a decimal and storing it as
           a float is the drift this module spends its life avoiding. */
        conversionFactor: { type: String, trim: true },
        conversionPath: { type: String, trim: true },
        priceSource: { type: String, trim: true },
        tierMinQuantity: { type: Number, default: null },
        /* Null is an open-ended band, not a missing ceiling. */
        tierMaxQuantity: { type: Number, default: null },
        /* ── THE QUANTITY THE TIER WAS JUDGED ON ────────────────────────
           A tier is stated in the supplier's purchase unit, so the number it
           was compared against is a supplier quantity — not the garment
           count. Without this, "why did this line get the 700-unit price"
           is unanswerable a year later. Strings, because a derived quantity
           is a decimal. */
        quantityPerUnit: { type: String, trim: true },
        appliedPurchaseQuantity: { type: String, trim: true },
        /* ── PACKAGING AND OUTSIDE SERVICES ─────────────────────────────
           Declared rather than carried by `strict: false`, for the reason
           stated above: a field nobody declared is a field nobody can rely
           on, and this list is what an auditor reads.

           `behaviour` and `quantityPerRun` are the packaging half. A carton
           bought for the ORDER has no per-piece consumption, and freezing a
           zero for it would read as one — so the field that was actually
           used is named. */
        behaviour: { type: String, trim: true },
        quantityPerRun: { type: String, trim: true },
        fixedAmountMinor: { type: Number, default: null },
        /* And the service half. A service is not an item: it has its own
           master, its own register, a billing unit with no conversion, and a
           minimum charge that floors the line total rather than the quantity
           ordered. None of those has a material equivalent to borrow. */
        family: { type: String, trim: true },
        serviceId: { type: mongoose.Schema.Types.ObjectId },
        serviceCode: { type: String, trim: true },
        serviceName: { type: String, trim: true },
        supplierServiceCode: { type: String, trim: true },
        supplierServiceName: { type: String, trim: true },
        sacCode: { type: String, trim: true },
        billingUnit: { type: String, trim: true },
        /* The unit the REQUIREMENT was measured in. Frozen beside the
           quotation's own so a reader can see they matched — there is no
           conversion factor between them to re-derive it from. */
        requestedUnit: { type: String, trim: true },
        basis: { type: String, trim: true },
        /* ── MEASURED, OR ONLY PLANNED ──────────────────────────────────
           A verified rate multiplied by a quantity no sample demonstrated is
           not a verified line, and a reader a year later must be able to see
           which it was without the technical record still saying so. */
        evidence: { type: String, trim: true },
        minimumChargeMinor: { type: Number, default: null },
        minimumChargeApplied: { type: Boolean, default: false },
        appliedServiceQuantity: { type: String, trim: true },
        /* ── WHAT EACH QUANTITY ACTUALLY REACHED (Chunk 5A) ─────────────
           The fields above record what the LINE is — one quotation, one
           conversion, one tax position. These record what each SCENARIO
           reached: its own supplier quantity, its own tier, its own net and
           effective rate.

           Frozen rather than re-derivable, because "why was 3,000 cheaper"
           must be answerable a year later without the quotation still being
           active — which is precisely what a frozen version may not depend
           on. Absent on every version written before this chunk, and absence
           means one rate applied to every scenario. */
        scenarios: {
          type: [new mongoose.Schema({
            scenarioKey: { type: String, trim: true, required: true },
            outputQuantity: { type: String, trim: true },
            purchaseQuantity: { type: String, trim: true },
            purchaseUom: { type: String, trim: true },
            priceSource: { type: String, trim: true },
            tierMinQuantity: { type: Number, default: null },
            tierMaxQuantity: { type: Number, default: null },
            quotedAmountMinor: { type: Number },
            netRateMinor: { type: Number },
            netRateDerived: { type: Boolean, default: false },
            gstAmountMinor: { type: Number, default: null },
            grossRateMinor: { type: Number, default: null },
            /* Per one consumption unit — the number the engine multiplied. */
            effectiveRateMinor: { type: Number },
            conversionFactor: { type: String, trim: true },
            /* The service half of a scenario row. Both the figure before the
               minimum charge and the figure after it, so the floor is visible
               doing its work rather than an unexplained total. */
            serviceQuantity: { type: String, trim: true },
            billingUnit: { type: String, trim: true },
            lineNetBeforeMinimumMinor: { type: Number, default: null },
            lineNetMinor: { type: Number, default: null },
            minimumChargeApplied: { type: Boolean, default: false },
            taxTreatment: { type: String, trim: true },
          }, { _id: false })],
          default: undefined,
        },
        scenarioQuantities: {
          type: [new mongoose.Schema({
            outputQuantity: { type: String, trim: true },
            purchaseQuantity: { type: String, trim: true },
          }, { _id: false })],
          default: undefined,
        },
        moq: { type: Number, default: null },
        orderMultiple: { type: Number, default: null },
        leadTimeDays: { type: Number, default: null },
        effectiveFrom: { type: Date },
        validUntil: { type: Date },
      }, { _id: false })],
      default: undefined,
    },

    inputs: { type: [costLineSchema], default: () => [] },

    /* ── THE POLICY THAT WAS IN FORCE ─────────────────────────────────────
       A COPY. Finance raising the target margin in October must not rewrite
       what a June costing said in June. */
    policySnapshot: { type: policySnapshotSchema, default: undefined },

    /* One entry per quantity costed, each with its own totals, unit cost,
       price band and the reason it differs from the primary one. */
    scenarios: { type: [scenarioSchema], default: () => [] },

    /* ── WAS EVERY COST FAMILY ADDRESSED? (Chunk 4C) ──────────────────────
       Server-derived, frozen, and the thing approval is judged against. A
       later supplier price, policy change or master edit cannot alter what
       this version recorded about which questions had been answered.

       ABSENT on versions frozen before this existed. Absent is NOT complete:
       those are labelled as unassessed rather than quietly passing. */
    completeness: { type: completenessSchema, default: undefined },

    /* ── THE COMMERCIAL ANSWER (Chunk 4B) ─────────────────────────────────
       What somebody proposed to sell at, and what that leaves before and
       after estimated income tax. Its own block, beside the cost and never
       inside it: a proposed price is a commercial decision taken after the
       cost is known, and no cost figure may move when one changes.

       Absent on a costing nobody has proposed a price for, which is the
       honest state for most drafts. */
    commercial: { type: commercialSchema, default: undefined },

    /* Which rules produced these numbers, and what the engine wanted the
       reader to know. Warnings are not errors: a calculation that emitted one
       still ran, and hiding it would leave a provisional input looking as
       solid as a verified one. */
    calculation: {
      engineVersion: { type: Number, default: 0 },
      calculatedAt: { type: Date, default: undefined },
      warnings: { type: [warningSchema], default: () => [] },
    },
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

/* ── ONE USER ACTION, ONE VERSION — ENFORCED BY THE DATABASE ────────────────
 * PARTIAL rather than sparse, for the reason Costing.js sets out: a compound
 * sparse index still indexes documents that have any of its keys, and
 * `companyId` always does, so every import-created version would collide under
 * a null claim. Company-scoped, because an idempotency key is only meaningful
 * within one company. */
costingVersionSchema.index(
  { companyId: 1, "provenance.creationClaimId": 1 },
  { unique: true, partialFilterExpression: { "provenance.creationClaimId": { $type: "string" } } },
);

/* And one legacy sheet, in one state, imported once. */
costingVersionSchema.index(
  { companyId: 1, "provenance.legacyImportKey": 1 },
  { unique: true, partialFilterExpression: { "provenance.legacyImportKey": { $type: "string" } } },
);

/* ── THE IMMUTABILITY GUARD ─────────────────────────────────────────────────
 * A persisted version is frozen COMPLETELY in Chunk 1 — content and status
 * alike.
 *
 * ── WHY STATUS IS NO LONGER AN EXCEPTION ────────────────────────────────────
 * It was, on the reasoning that a version legitimately becomes APPROVED and
 * later SUPERSEDED without its content changing. True, and beside the point:
 * that transition is a CONTROLLED act — it needs an approver identity, a
 * decision, a time, a reason and a margin-policy check, all of which are
 * Chunk 6's. Leaving the field writable now meant the only thing standing
 * between a draft and an "approved" costing was that nobody had written the
 * line of code yet. An unguarded door is not a door.
 *
 * So nothing moves until Chunk 6 introduces a transition service that writes
 * the decision and the status together. Until then `APPROVED` and
 * `SUPERSEDED` are declared vocabulary that no code path can reach, and this
 * file deliberately offers no bypass for one to be built on quietly.
 *
 * ── WHAT THIS DOES AND DOES NOT PROTECT ─────────────────────────────────────
 * These are MONGOOSE middlewares. They cover every path this codebase uses to
 * write a version — `save`, `updateOne`, `updateMany`, `findOneAndUpdate`,
 * `replaceOne`, `findOneAndReplace`. They do NOT and cannot stop an authorised
 * administrator with a shell on the database, and nothing claimed here should
 * be read as saying otherwise; that is what database roles, backups and audit
 * are for.
 *
 * They also do not cover `Model.bulkWrite`, `Model.collection.*`, an
 * aggregation `$merge`/`$out`, or a raw driver handle, all of which bypass
 * mongoose middleware by design. Rather than build elaborate protection for
 * paths nothing uses, the boundary is stated and enforced by convention: NO
 * production costing code may write or remove a version through a bulk or
 * raw-collection path. Today there are exactly two writers, both in this
 * repository and both named:
 *
 *   · `services/centralCosting/costingCreation.service.js` — `Model.create`;
 *   · `deleteOrphanVersion` at the bottom of THIS file, which is the single
 *     deliberate raw-driver write in the domain and is confined, by checks it
 *     performs itself, to a version whose parent costing does not exist.
 *
 * Anything added later must go through a model method so these guards apply.
 */
const MUTABLE_AFTER_CREATION = new Set(["updatedAt", "__v"]);

/* ══ THE NARROW MECHANISM CHUNK 6A NEEDED (amends A1.5) ══════════════════════
 *
 * A1.5 froze `status` and said, in as many words, that no bypass was being
 * left for Chunk 6 to build on quietly — it would have to introduce an
 * explicit transition service. This is that service's door, and it is
 * deliberately the narrowest one that works.
 *
 * ── HOW IT IS NARROW ────────────────────────────────────────────────────────
 *   1. It opens on a module-private `Symbol`. A symbol is not a string, is not
 *      enumerable on the document, and cannot be guessed, JSON-encoded or
 *      arrived at from a request body. Nothing outside this file can produce
 *      the value except by calling `beginLifecycleTransition`, which this file
 *      exports by name.
 *   2. It opens on ONE document instance, through `$locals` — not a module
 *      flag. A global flag would be open for every concurrent save in the
 *      process for as long as it was set, which under load is "always".
 *   3. It closes itself. The token is cleared in the same hook that reads it,
 *      so a second `save()` on the same document is refused like any other.
 *   4. It permits only `status` and `lifecycle`. A transition that also tried
 *      to change a cost line, a scenario, the policy snapshot or the
 *      provenance is refused with the ordinary immutability error — which is
 *      the whole promise: a lifecycle move must not be able to smuggle a
 *      content edit alongside it.
 *   5. It is `save`-only. `updateOne`, `updateMany`, `findOneAndUpdate`,
 *      `replaceOne` and `findOneAndReplace` gained nothing and still refuse
 *      every status write, so there is no query-level bypass to find.
 *
 * The limits A1.5 stated are unchanged and are not re-argued here: these are
 * mongoose middlewares, they do not stop a database shell, and they do not
 * cover `bulkWrite` or `Model.collection.*`. The convention stands — no
 * production costing code writes a version through a bulk or raw path.
 */
const LIFECYCLE_TOKEN = Symbol("costing.version.lifecycleTransition");
const LIFECYCLE_PATHS = new Set(["status", "lifecycle"]);

/**
 * Arm ONE document for ONE lifecycle save.
 *
 * Called only by `services/centralCosting/lifecycle.service.js`. Returns the
 * document so a caller reads as a single expression, but the effect is the
 * arming — and it lasts exactly until the next `save()`.
 */
function beginLifecycleTransition(doc) {
  if (!doc || typeof doc.$locals !== "object") {
    throw new Error("beginLifecycleTransition needs a costing version document.");
  }
  doc.$locals[LIFECYCLE_TOKEN] = true;
  return doc;
}

function refuseContentMutation(doc) {
  const armed = doc?.$locals?.[LIFECYCLE_TOKEN] === true;
  /* Spent on read, whether or not it is used — a token that survived its save
     would leave the door open for the next one. */
  if (armed) delete doc.$locals[LIFECYCLE_TOKEN];

  const changed = doc.modifiedPaths().filter((p) => {
    const root = p.split(".")[0];
    if (MUTABLE_AFTER_CREATION.has(root)) return false;
    /* Armed or not, only these two paths are ever forgivable — and only when
       armed. Everything else is content. */
    if (armed && LIFECYCLE_PATHS.has(root)) return false;
    return true;
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

/* `updateOne`/`updateMany`/`findOneAndUpdate` bypass the save hook entirely, so
   they are guarded too — otherwise the model's promise would hold only for the
   one code path that happens to use `save()`. */
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

/* ── A REPLACEMENT IS NOT AN UPDATE, IT IS EVERY UPDATE AT ONCE ─────────────
 * `replaceOne` and `findOneAndReplace` take a whole document rather than
 * operators, so the update-shaped guard above cannot read them meaningfully —
 * and left alone they were the one way to rewrite a frozen version's entire
 * content in a single call.
 *
 * ── WHY THIS IS NOT "REFUSE IF IT ALREADY EXISTS" ───────────────────────────
 * It was, and that was a check-then-write race with a real losing case: an
 * upserting replacement could ask "does it exist?", be told no, and then
 * replace a document that was inserted in the interval. The window is small
 * and the consequence is the total loss of a frozen audit record, which is
 * exactly the trade this domain must not make.
 *
 * There is also no reason to allow the upsert-insert it was protecting. A new
 * version is created by `services/centralCosting/costingCreation.service.js`
 * (and, from Chunk 2, the version service beside it), which allocates the
 * number, stamps the provenance and maintains the parent's pointer. A
 * replacement API can do none of that; a version created through one would be
 * a version nothing had numbered.
 *
 * So both are refused unconditionally — no query, no race, no exceptions. */
function refuseReplace(next) {
  const err = new Error(
    "A costing version cannot be replaced. Create a later version through the costing version service instead.",
  );
  err.name = "CostingVersionImmutableError";
  err.changedPaths = ["*"];
  return next(err);
}

costingVersionSchema.pre("replaceOne", refuseReplace);
costingVersionSchema.pre("findOneAndReplace", refuseReplace);

/* ── DELETION IS NOT A CORRECTION EITHER ────────────────────────────────────
 * A persisted version is audit history: a quotation may have been priced from
 * it, a budget committed against it, an approval recorded on it. "Remove the
 * wrong one" is the same instinct that produces an edited invoice, and the
 * answer is the same — supersede it, do not erase it.
 *
 * Guarded on every mongoose deletion path, including the document-level
 * `doc.deleteOne()`, which is separate middleware from the query-level call of
 * the same name. `findByIdAndDelete` is covered because mongoose routes it
 * through `findOneAndDelete`.
 */
function refuseDelete(next) {
  const err = new Error(
    "A costing version cannot be deleted; it is audit history. Create a later version instead.",
  );
  err.name = "CostingVersionImmutableError";
  return next(err);
}

costingVersionSchema.pre("deleteOne", { document: true, query: true }, refuseDelete);
costingVersionSchema.pre("deleteMany", refuseDelete);
costingVersionSchema.pre("findOneAndDelete", refuseDelete);

const CostingVersionModel =
  mongoose.models.CostingVersion || mongoose.model("CostingVersion", costingVersionSchema);

/**
 * Remove a version whose parent costing was NEVER CREATED.
 *
 * ── WHY AN ESCAPE HATCH EXISTS AT ALL ───────────────────────────────────────
 * On a deployment without transactions, a costing is created by writing the
 * version first and the parent second — deliberately, so the half a crash can
 * leave behind is the unreachable one. When the parent insert fails, that
 * version must be cleaned up, and the guard above would otherwise make the
 * compensating delete impossible.
 *
 * ── WHY IT IS NOT A BYPASS FLAG ─────────────────────────────────────────────
 * A `{ force: true }` option, or a mutable "allow the next delete" switch,
 * would be one careless `...req.body` away from being reachable from a
 * request, and a mutable switch would additionally be wrong under
 * concurrency. There is no flag here. The narrowing is a FACT this function
 * verifies for itself, immediately before it acts:
 *
 *   · the version must exist in the caller's company;
 *   · its parent costing must NOT exist in that company.
 *
 * A version whose parent exists is reachable history and is refused, whoever
 * asks and however they ask. Nothing a client can send changes either check,
 * because neither reads anything a client sent — only the two documents.
 *
 * The delete itself goes through the driver rather than the model, because the
 * model's own guard is unconditional and correctly so. That is the one place
 * in this domain that writes below mongoose, it is named, and it is confined
 * to a document that no read path can reach.
 *
 * @returns {Promise<{deleted:number, reason:string}>}
 */
async function deleteOrphanVersion({ _id, companyId } = {}) {
  if (!_id || !companyId) {
    const err = new Error("An orphan cleanup must name the version and its company.");
    err.name = "CostingVersionCleanupError";
    throw err;
  }

  const version = await CostingVersionModel.findOne({ _id, companyId }).select("costingId").lean();
  if (!version) return { deleted: 0, reason: "ALREADY_ABSENT" };

  /* Required here rather than at the top of the file: Costing.js does not
     require this module, so there is no cycle either way, and a lazy require
     keeps the model graph loaded in the order the app already loads it. */
  const Costing = require("./Costing");
  const parent = await Costing.exists({ _id: version.costingId, companyId });
  if (parent) {
    const err = new Error(
      "That costing version has a parent costing, so it is history rather than an orphan and cannot be deleted.",
    );
    err.name = "CostingVersionCleanupError";
    throw err;
  }

  const res = await CostingVersionModel.collection.deleteOne({
    _id: new mongoose.Types.ObjectId(String(_id)),
    companyId: new mongoose.Types.ObjectId(String(companyId)),
  });
  return { deleted: res.deletedCount || 0, reason: "ORPHAN_REMOVED" };
}

module.exports = CostingVersionModel;
module.exports.VERSION_STATES = VERSION_STATES;
module.exports.VERSION_TRANSITIONS = VERSION_TRANSITIONS;
/* Exported by name so the one legitimate writer can arm a transition, and so
   a reader grepping for "who can change a status" finds exactly one answer. */
module.exports.beginLifecycleTransition = beginLifecycleTransition;
module.exports.VERSION_ORIGINS = VERSION_ORIGINS;
module.exports.SOURCE_TYPES = SOURCE_TYPES;
module.exports.SOURCE_CONFIDENCE = SOURCE_CONFIDENCE;
module.exports.deleteOrphanVersion = deleteOrphanVersion;
