// models/CMS_Models/Merchandising/DemandRelease.js
//
// ONE RELEASE OF APPROVED MATERIAL DEMAND INTO PROCUREMENT.
//
// ── WHY A RECORD AND NOT A FLAG ─────────────────────────────────────────────
// Releasing demand commits the company to go and buy things. "Has this been
// released?" is asked months later, by somebody reconciling what was bought
// against what was ordered, and a boolean on the order line cannot answer it:
// it cannot say WHICH approved costing the demand was derived from, WHICH
// technical revision was frozen at the time, or what happened when the buyer
// changed the quantity and a second release had to supersede the first.
//
// So each release is its own immutable row naming every identity it rested on.
//
// ── THE IDENTITY THAT MAKES A RETRY A RETRY ─────────────────────────────────
// `releaseKey` is the whole subject of the decision: company, order, order
// LINE, the approved costing version, the frozen requirement revision, and the
// ordered quantity. A unique index over it is what makes a retry idempotent
// without a bookkeeping row that can expire — the same six facts produce the
// same key, and the second insert loses to the index rather than creating a
// second set of purchasing drafts.
//
// Any of those six changing produces a DIFFERENT key, which is exactly right:
// it is a different decision about a different subject, and it supersedes
// rather than overwrites. `supersedesReleaseId` links the chain, and the
// earlier row keeps its own demand references for ever.
//
// ── AND IT CARRIES NO MONEY ─────────────────────────────────────────────────
// No cost, no floor, no markup, no supplier, no rate, no Board policy. It
// records WHAT was released and on WHOSE authority, not what any of it is
// worth. The figures live on the costing version, behind the capabilities that
// guard them.
"use strict";

const mongoose = require("mongoose");

/* ── PENDING IS THE CLAIM, NOT A DRAFT ──────────────────────────────────────
   Written BEFORE the spend requests are raised, so an interruption between
   the two leaves a row a retry can find and finish. Without it the retry saw
   active requests, no release, and no way to tell "already done" from "never
   started" — so it raised a second set.

   It is never a resting state: a PENDING row is either completed by the next
   attempt or stays visible as an unfinished one. */
const RELEASE_STATES = Object.freeze(["PENDING", "RELEASED", "SUPERSEDED"]);

const demandReleaseSchema = new mongoose.Schema(
  {
    /* Stored rather than derived through the order, because an audit read
       must be answerable with one query. */
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    /* ── THE CONFIRMED ORDER LINE THIS SPEAKS FOR ────────────────────────
       The CustomerRequest and the line's own permanent `lineRef` — an order
       may legitimately carry the same style on two commercial lines, and
       those are two releases. A style identity is not a line identity. */
    orderId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    orderNumber: { type: String, trim: true, default: "" },
    lineRef: { type: String, trim: true, required: true },
    orderStatusAtRelease: { type: String, trim: true, default: "" },

    /* What is being made, and how many. The quantity is the ORDER's, matched
       against a scenario the approved costing froze — never interpolated. */
    sampleStyleId: { type: mongoose.Schema.Types.ObjectId, required: true },
    styleCode: { type: String, trim: true, default: "" },
    productName: { type: String, trim: true, default: "" },
    orderedQuantity: { type: String, trim: true, required: true },
    scenarioKey: { type: String, trim: true, required: true },

    /* ── THE COMMERCIAL DECISION IT RESTS ON ─────────────────────────────
       The exact approved version, frozen. Never "the latest": demand derived
       from a costing nobody approved is demand nobody agreed to. */
    costingId: { type: mongoose.Schema.Types.ObjectId, required: true },
    costingVersionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    costingVersionNumber: { type: Number, default: null },
    /* Which pricing contract approved it. A historical band version cannot be
       released, and storing this is what makes that refusal auditable. */
    pricingContract: { type: String, trim: true, default: "" },

    /* ── THE REQUIREMENTS THAT WERE FROZEN ───────────────────────────────
       R&D's approved technical revision as the costing version froze it, plus
       the gates that made it approved. A later revision does not rewrite this
       release; it produces a successor. */
    requirementRevision: {
      technicalRevision: { type: String, trim: true, default: "" },
      bomApprovalStatus: { type: String, trim: true, default: "" },
      sampleStatus: { type: String, trim: true, default: "" },
    },

    /* The one string that decides whether a second request is a retry. */
    releaseKey: { type: String, trim: true, required: true },

    /* ── THE COMMAND, FROZEN BEFORE IT RAN ───────────────────────────────
       Which requirements this release is for, resolved and validated at
       claim time and stored verbatim.

       Selection cannot be re-derived on recovery: once the first attempt has
       created requests, those requirements read as already spoken for, so
       re-running selection returns an EMPTY list and the retry refuses a
       release that in fact succeeded. Freezing the command is what lets the
       replay send exactly what the interrupted attempt sent.

       The idempotency key travels with it for the same reason — the handoff
       recognises a replay by that key, and a regenerated one would be a
       different request. */
    handoffCommand: {
      scenarioKey: { type: String, trim: true, default: "" },
      requirementIds: { type: [String], default: () => [] },
      idempotencyKey: { type: String, trim: true, default: "" },
      purpose: { type: String, trim: true, default: "" },
    },

    state: { type: String, enum: RELEASE_STATES, default: "PENDING", required: true },
    supersedesReleaseId: { type: mongoose.Schema.Types.ObjectId, default: null },
    supersededByReleaseId: { type: mongoose.Schema.Types.ObjectId, default: null },
    supersededAt: { type: Date, default: null },

    /* ── WHAT PROCUREMENT ACTUALLY RECEIVED ──────────────────────────────
       References to the drafts `costingDemand` created, so "what was released"
       is answerable without re-deriving it. Ids only. */
    demand: {
      spendRequestIds: { type: [mongoose.Schema.Types.ObjectId], default: () => [] },
      productRequestId: { type: mongoose.Schema.Types.ObjectId, default: null },
      serviceRequestId: { type: mongoose.Schema.Types.ObjectId, default: null },
      requirementCount: { type: Number, default: 0 },
    },

    releasedByActorId: { type: String, trim: true, required: true },
    releasedByActorName: { type: String, trim: true, default: "" },
    releasedAt: { type: Date, default: Date.now, required: true },
  },
  { timestamps: true, collection: "merchandising_demand_releases" },
);

/* ── THE INDEX THAT MAKES A RETRY LOSE, NOT DUPLICATE ────────────────────────
   Unique on the release key within a company. A concurrent double-press does
   not need a lock: the second insert is refused by the database, and the
   caller reads back the row the first one wrote. */
demandReleaseSchema.index({ companyId: 1, releaseKey: 1 }, { unique: true });

/* ── ONE ACTIVE SLOT PER ORDER LINE ─────────────────────────────────────────
   The release key protects IDENTICAL facts. Two concurrent successors with
   different quantities or costing versions hash to two different keys, so the
   key alone would let both claim — and Store would receive two sets of
   actionable demand for one order line.

   A partial unique index over `{companyId, orderId, lineRef}` restricted to
   PENDING and RELEASED rows makes the database enforce it: whichever
   transaction commits second is refused, whatever facts it carries. Superseded
   rows are excluded, so the history of an order line stays as long as it
   needs to be while only one row is ever live. */
demandReleaseSchema.index(
  { companyId: 1, orderId: 1, lineRef: 1 },
  {
    unique: true,
    name: "one_active_release_per_line",
    partialFilterExpression: { state: { $in: ["PENDING", "RELEASED"] } },
  },
);
/* The chain, and the ordinary reads: everything released for one order line. */
demandReleaseSchema.index({ companyId: 1, orderId: 1, lineRef: 1, releasedAt: -1 });

/* ── IMMUTABLE, EXCEPT FOR BEING SUPERSEDED ──────────────────────────────────
   The business payload is written once. `state`, `supersededByReleaseId` and
   `supersededAt` are the only mutable region, and they are system-controlled
   metadata about this row's standing — not about what it released. */
/* `demand` joins them: it is stamped exactly once, when the claim completes
   and the requests it names actually exist. Everything describing WHAT was
   released — order, line, style, quantity, costing, requirement revision — is
   written at claim time and never changes. */
const MUTABLE = new Set([
  "state", "supersededByReleaseId", "supersededAt", "updatedAt", "demand",
]);

demandReleaseSchema.pre("save", function guardImmutable(next) {
  if (this.isNew) return next();
  const touched = this.modifiedPaths().filter((p) => !MUTABLE.has(p.split(".")[0]));
  if (touched.length) {
    return next(new Error(`A demand release is immutable; refused change to: ${touched.join(", ")}`));
  }
  return next();
});

const refuseUpdate = function refuseUpdate(next) {
  const update = this.getUpdate() || {};
  const fields = Object.keys({ ...(update.$set || {}), ...update }).filter((k) => !k.startsWith("$"));
  const illegal = fields.filter((f) => !MUTABLE.has(String(f).split(".")[0]));
  if (illegal.length) {
    return next(new Error(`A demand release is immutable; refused change to: ${illegal.join(", ")}`));
  }
  return next();
};
demandReleaseSchema.pre("updateOne", refuseUpdate);
demandReleaseSchema.pre("updateMany", refuseUpdate);
demandReleaseSchema.pre("findOneAndUpdate", refuseUpdate);
demandReleaseSchema.pre("replaceOne", refuseUpdate);

module.exports = mongoose.models.DemandRelease
  || mongoose.model("DemandRelease", demandReleaseSchema);
module.exports.RELEASE_STATES = RELEASE_STATES;
