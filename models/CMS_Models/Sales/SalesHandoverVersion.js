// models/CMS_Models/Sales/SalesHandoverVersion.js
//
// ONE ISSUED VERSION OF A SALES → MERCHANDISING HANDOVER.
//
// ── WHOSE RECORD THIS IS, AND WHY IT MOVED HERE ─────────────────────────────
// Sales'. It is the versioned, allowlisted execution projection of ONE
// confirmed order line — the controlled brief that crosses from Sales — and
// only the Sales producer writes it. Merchandising reads it, accepts it or
// asks for clarification, and never edits a field of it.
//
// It used to sit under the Merchandising model directory on the reasoning that
// a record belongs beside the domain it feeds. That reasoning put the one
// record Sales owns in the middle of the records Sales must not touch, and the
// producer duly reached past it into the Execution File and the Merchandising
// audit trail — because everything around it was already within arm's reach.
// Write ownership and directory are different facts, but keeping them apart
// invited exactly the confusion it was supposed to tolerate. The collection
// name is pinned below so the move costs no data.
//
// ── IMMUTABILITY, AND WHAT IS DELIBERATELY NOT IMMUTABLE ────────────────────
// The BUSINESS PAYLOAD — the execution projection, the source stamp, the
// version identity — is written once at issue and never edited: a change to
// what Sales confirmed is a NEW version that links back through
// `supersedesVersionId`. Old versions stay readable for ever; that is the
// whole point of versioning them.
//
// `publication` is the one mutable region, and it is system-controlled
// metadata about the version's standing — CURRENT, SUPERSEDED, CANCELLED —
// not about its content. Flipping a version to SUPERSEDED changes nothing a
// merchandiser accepted; it says a newer statement exists.
//
// ── THE LINE THIS SPEAKS FOR ────────────────────────────────────────────────
// `handoverLineRef` is the CustomerRequest item's permanent `lineRef`, minted
// and owned by the Sales order record. It is NOT the selected style: one
// confirmed order may legitimately carry the same style on two commercial
// lines — separate deliveries, buyer references, destinations or contractual
// splits — and those are two handovers, two files and two independent version
// histories. A style identity is not an order-line identity.
//
// ── WHAT NEVER APPEARS HERE ─────────────────────────────────────────────────
// No quotation, price, cost, margin, payment terms, credit, currency amount,
// negotiation, buyer message, pipeline state or journey workspace. The
// producer refuses those fields BY NAME; the embedded projection schema simply
// has nowhere to put them, which is the stronger guarantee.
"use strict";

const mongoose = require("mongoose");

const { executionProjectionSchema } = require("./executionProjection");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

const salesHandoverVersionSchema = new mongoose.Schema(
  {
    /* Stamped by the producer from the actor's resolved Sales scope — never
       from a body field. The receiver filters on it directly, which is what
       makes the inbox a bounded indexed read instead of a per-row proof. */
    companyId: {
      type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company",
      required: true, index: true,
    },

    /* Sales' identifiers, deliberately: order and order-line identity are
       Sales-owned facts, and minting a parallel reference would be a second
       name for one thing. `handoverRef` is the CustomerRequest's human
       reference; `handoverLineRef` is that order line's permanent `lineRef`. */
    handoverRef: { type: String, trim: true, required: true },
    handoverLineRef: { type: String, trim: true, required: true },
    versionNo: { type: Number, min: 1, required: true },

    /* The version this one replaces. Null on version 1. */
    supersedesVersionId: {
      type: mongoose.Schema.Types.ObjectId, ref: "SalesHandoverVersion", default: null,
    },

    /* Where this projection came from, exactly. `sourceVersion` is the state
       marker of the source at issue (its updatedAt, ISO) — CustomerRequest
       carries no version number of its own, and pretending it did would be a
       fact nobody stored. */
    sourceRecord: {
      app: { type: String, enum: ["sales"], required: true },
      recordType: { type: String, enum: ["customer_request"], required: true },
      recordId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
      sourceVersion: { type: String, trim: true, required: true },
      issuedAt: { type: Date, required: true },
    },

    /* The allowlisted execution projection — one declared shape, shared with
       the accepted copy the Execution File keeps. */
    executionProjection: { type: executionProjectionSchema(), required: true },

    /* ── M8: WHAT WAS DEVELOPED BEFORE THIS ORDER ─────────────────────────
       Optional, and exact. When the order came out of a development job, this
       names the Development File, the approved BOM revision Merchandising
       settled on, and Sales' own release reference.

       It is a REFERENCE, never a copy: the selection lives on the development
       file, immutably, and the order adopts from it deliberately. Absent for
       an order that never went through development, which is a normal case
       and not a gap. */
    developmentReference: {
      developmentFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
      developmentNumber: { type: String, trim: true, default: "" },
      bomRevisionNo: { type: Number, default: null },
      releaseReference: { type: String, trim: true, default: "" },
    },

    /* System-controlled publication standing. The ONE mutable region. */
    publication: {
      state: {
        type: String, enum: ["CURRENT", "SUPERSEDED", "CANCELLED"],
        default: "CURRENT", index: true,
      },
      supersededByVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      supersededAt: { type: Date, default: null },
      cancelledAt: { type: Date, default: null },
      cancelReason: { type: String, trim: true, default: "" },
    },

    issuedBy: actorRef(),
  },
  /* Pinned rather than derived from the model name: this record moved
     directories once, and the data must not move with it. */
  { timestamps: true, collection: "saleshandoverversions" },
);

/* ── THE BUYER'S PROCESS DECISION IS FROZEN AFTER ISSUE ─────────────────────
   Sales' stated embroidery / printing / washing requirement, and the buyer
   approval each answer rests on, are compared value for value against what
   was loaded: a saved version may not change them in place — a change is a
   new version. Narrow on purpose: a save that re-casts the stored projection
   (strict mode stripping a field nobody agreed) leaves the decision equal and
   still passes, as the contract-integrity suite relies on. */
const processDecision = (doc) => JSON.stringify(doc.executionProjection?.processRequirements ?? null);
salesHandoverVersionSchema.post("init", function rememberProcessDecision() {
  this.$locals.loadedProcessDecision = processDecision(this);
});
salesHandoverVersionSchema.pre("save", function freezeProcessDecision(next) {
  if (this.isNew || this.$locals.loadedProcessDecision === undefined) return next();
  if (processDecision(this) !== this.$locals.loadedProcessDecision) {
    const err = new Error(
      "An issued handover version's buyer-approved processes cannot change — issue a new version instead.",
    );
    err.name = "SalesHandoverVersionImmutable";
    return next(err);
  }
  return next();
});

/* One version number exists once per line, per company — enforced by the
   database, not by check-then-create. */
salesHandoverVersionSchema.index(
  { companyId: 1, handoverRef: 1, handoverLineRef: 1, versionNo: 1 },
  { unique: true },
);

/* And at most ONE current version per line. Two "current" statements of the
   same requirement is two truths, and the partial index makes the race that
   would create them lose at the database rather than in prose. */
salesHandoverVersionSchema.index(
  { companyId: 1, handoverRef: 1, handoverLineRef: 1 },
  { unique: true, partialFilterExpression: { "publication.state": "CURRENT" } },
);

/* The inbox: current versions of a company, newest first. */
salesHandoverVersionSchema.index({ companyId: 1, "publication.state": 1, createdAt: -1 });

module.exports = mongoose.models.SalesHandoverVersion
  || mongoose.model("SalesHandoverVersion", salesHandoverVersionSchema);
