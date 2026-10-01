// models/CMS_Models/Inventory/Sourcing/SourcingDecision.js
//
// WHICH QUOTATION STORE CHOSE, FOR ONE REQUIREMENT, ON ONE ORDER.
//
// ── THE DECISION THAT HAD NOWHERE TO LIVE ───────────────────────────────────
// When several quotations can price the same requirement, somebody has to
// choose. That choice used to be `quotationChoices` — a `{lineKey: offerId}`
// map held in React state and posted with the calculation. It was a real
// decision with a real commercial consequence, and it existed for as long as
// the tab was open. Nobody's name was on it, nothing recorded when it was
// made, and reopening the costing asked again.
//
// It was also being made in the wrong app. Which supplier the company buys
// from is Store's decision — lead time, quality history, capacity, terms and
// the relationship are all Store's to weigh, and none of them is in a rate.
// Central Costing was merely the screen where the absence was noticed.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
// NOT a preferred supplier. It is scoped to one costing's one requirement, and
// it records the quantity, unit and date it was judged against. A choice made
// for 500 pieces in September is not an answer about 5,000 pieces in March,
// and the shape of this record is what stops it from silently becoming one.
//
// NOT a price. The rate is not stored here and is never read from here: the
// quotation is re-read from its own register every time a costing is
// calculated. Storing the rate would create a second copy that could drift
// from the register it came from — which is the whole defect the supplier
// offer registers exist to prevent.
//
// NOT a purchase. Nothing is ordered, committed or reserved. It is a statement
// about which quotation prices a costing, and a costing is an estimate.
//
// ── AND IT IS REVALIDATED, NEVER TRUSTED ────────────────────────────────────
// Every read re-checks the chosen quotation against the live register at the
// costing's own quantities and date. A withdrawn, superseded, expired,
// below-MOQ, wrong-unit or lane-changed decision becomes UNRESOLVED and is
// reported back to Store — it is never silently substituted for another
// quotation, and never silently dropped. The context columns below exist so
// that a reader can see WHY it went stale without re-deriving it.
//
// Frozen `CostingVersion` documents keep the quotation and provenance they
// actually used. Nothing here reaches back into one.
"use strict";

const mongoose = require("mongoose");

/**
 * What kind of requirement is being sourced.
 *
 * Each names a different register, and they are deliberately not collapsed
 * into one "offer" type: a material quotation is identified by an item and a
 * variant, a service quotation by a service, and a freight quotation by a
 * LANE — where it starts, where it ends, and how it travels. A single generic
 * subject would have to hold the union of those and validate none of them.
 */
const SUBJECT_KINDS = Object.freeze([
  "MATERIAL",
  "PACKAGING",
  "SERVICE",
  /* Setup work bought outside — priced from the service register like any
     other outside job, and separated because it dilutes across the run
     instead of scaling with it. The DECISION is the same shape. */
  "DEVELOPMENT",
  "FREIGHT",
]);

/** Which register the chosen quotation lives in. */
const OFFER_KINDS = Object.freeze([
  "SUPPLIER_OFFER",
  "SERVICE_SUPPLIER_OFFER",
  "FREIGHT_OFFER",
]);

const STATES = Object.freeze(["ACTIVE", "WITHDRAWN"]);

/**
 * The subject. Only the fields the register in question actually keys on.
 *
 * Every one of them is nullable because no single kind uses them all, and the
 * service layer refuses a subject whose required fields for its kind are
 * absent — a check that belongs where the kind is known rather than in a
 * schema-wide `required`.
 */
const subjectSchema = new mongoose.Schema({
  kind: { type: String, enum: SUBJECT_KINDS, required: true },

  /* MATERIAL and PACKAGING. */
  itemId: { type: mongoose.Schema.Types.ObjectId, default: null },
  variantId: { type: mongoose.Schema.Types.ObjectId, default: null },

  /* SERVICE and DEVELOPMENT. */
  serviceId: { type: mongoose.Schema.Types.ObjectId, default: null },

  /* FREIGHT. The lane, structured — see `FreightOffer` for why a lane cannot
     be a service name. */
  originWarehouseId: { type: mongoose.Schema.Types.ObjectId, default: null },
  destinationAddressId: { type: mongoose.Schema.Types.ObjectId, default: null },
  destinationLabel: { type: String, trim: true, default: "" },
  mode: { type: String, trim: true, default: "" },

  /* What the requirement is called, for a reader. Never matched on. */
  label: { type: String, trim: true, default: "", maxlength: 300 },
}, { _id: false });

/**
 * WHAT MADE THIS QUOTATION APPLICABLE WHEN IT WAS CHOSEN.
 *
 * ── WHY THE CONTEXT IS STORED AND NOT RE-DERIVED ────────────────────────────
 * Applicability is a question about a quantity, a unit and a date. The answer
 * changes when any of them does — a quotation that covers 3,000 metres may be
 * below its own minimum at 500, and one effective in September may not be in
 * March.
 *
 * Revalidation asks the register the question again, so it does not need this.
 * What needs it is the PERSON: a decision that has gone stale has to be able
 * to say what it was made against, or "choose again" is an instruction with no
 * information in it. These columns are read by humans and by the queue's
 * explanation, and by nothing that calculates.
 */
const contextSchema = new mongoose.Schema({
  /* The quantity the candidates were judged at — the largest run size in the
     costing at the time, because a quotation that cannot supply the largest
     run cannot price the costing. */
  judgedQuantity: { type: String, trim: true, default: "" },
  judgedUom: { type: String, trim: true, default: "" },
  /* The date applicability was judged at. A costing is calculated "as of" a
     date, and effective-from/valid-until are read against it. */
  asOf: { type: Date, default: null },
  currency: { type: String, trim: true, default: "" },

  /* Which revision of the quotation was chosen. A revision is a NEW document
     in these registers, so this is a legibility aid rather than a key — but a
     reader looking at a superseded decision wants to see that the thing they
     chose was revision 2 and the live one is revision 3. */
  offerRevision: { type: Number, default: null },
  quotationReference: { type: String, trim: true, default: "" },
  /* Recorded so the queue and the audit read as sentences rather than ids.
     Never used to resolve anything — the offer id is the identity. */
  supplierName: { type: String, trim: true, default: "" },

  /* How many quotations the chooser was picking between. A decision taken
     among five is a different act from one taken among two. */
  candidateCount: { type: Number, default: null },
}, { _id: false });

const sourcingDecisionSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },

  /* ── THE SMALLEST TRUTHFUL IDENTITY ──────────────────────────────────────
     A costing, and a requirement line within it.

     The costing carries the company, the enquiry, the product and the style;
     the line key carries the subject and its variant. Together they are one
     requirement on one order, which is the narrowest thing this decision can
     honestly be about.

     Deliberately NOT keyed by item alone. "Which supplier do we use for
     Oxford cotton" is a different question — a standing sourcing preference —
     and answering it with a choice somebody made for one enquiry at one run
     size is how a decision outlives the facts it was made on. If the company
     wants a standing preference it should be a different record, stated as
     one, and this is not it.

     Deliberately NOT keyed by scenario either. A costing prices several run
     sizes from ONE assembled row set, and the quotation has to supply the
     largest of them; a per-scenario decision would let a costing be priced
     from two different suppliers at two quantities and present the pair as
     one comparison. */
  costingId: { type: mongoose.Schema.Types.ObjectId, ref: "Costing", required: true, index: true },
  lineKey: { type: String, required: true, trim: true, maxlength: 200 },

  subject: { type: subjectSchema, required: true },

  offerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  offerKind: { type: String, enum: OFFER_KINDS, required: true },

  context: { type: contextSchema, default: () => ({}) },

  state: { type: String, enum: STATES, default: "ACTIVE", required: true },

  /* ── WHOSE DECISION IT WAS ───────────────────────────────────────────────
     Stamped server-side from the session. An actor a client could name is an
     actor a client could name as somebody else, and this is a commercial
     decision with a supplier on the other end of it. */
  decidedByActorId: { type: String, trim: true, default: "" },
  decidedByActorName: { type: String, trim: true, default: "" },
  decidedAt: { type: Date, default: Date.now },
  /* Why this supplier. Optional, because a reason nobody requires is a reason
     people actually write; a mandatory one becomes "n/a". */
  note: { type: String, trim: true, default: "", maxlength: 500 },
}, { timestamps: true });

/* ── ONE ACTIVE DECISION PER REQUIREMENT ───────────────────────────────────
   Partial on `state` so a withdrawn decision stays readable beside the one
   that replaced it — the history of a supplier choice is worth as much as the
   choice, and deleting the old row to make space for the new one throws it
   away. */
sourcingDecisionSchema.index(
  { companyId: 1, costingId: 1, lineKey: 1 },
  { unique: true, partialFilterExpression: { state: "ACTIVE" } },
);

/* The Store queue reads by company and recency. */
sourcingDecisionSchema.index({ companyId: 1, decidedAt: -1 });

sourcingDecisionSchema.statics.SUBJECT_KINDS = SUBJECT_KINDS;
sourcingDecisionSchema.statics.OFFER_KINDS = OFFER_KINDS;
sourcingDecisionSchema.statics.STATES = STATES;

module.exports = mongoose.models.SourcingDecision
  || mongoose.model("SourcingDecision", sourcingDecisionSchema);
module.exports.SUBJECT_KINDS = SUBJECT_KINDS;
module.exports.OFFER_KINDS = OFFER_KINDS;
module.exports.STATES = STATES;
