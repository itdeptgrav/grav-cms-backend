// models/CMS_Models/Manufacturing/Production/ProductionCostCloseout.js
//
// WHAT A WORK ORDER ACTUALLY PRODUCED, AND WHAT HAPPENED TO THE MATERIAL.
//
// ── WHY THIS RECORD EXISTS ──────────────────────────────────────────────────
// Central Costing could not state a per-garment actual cost because two facts
// were nowhere: how many pieces were genuinely ACCEPTED, and what became of
// the material issued for them. The pieces were inspectable one barcode at a
// time; nothing said "this run is finished, and here is what it came to".
//
// This is that statement, made once per work order by somebody accountable for
// it, and frozen when they make it.
//
// ── IT RECORDS; IT DOES NOT MOVE ANYTHING ───────────────────────────────────
// Closing writes no stock movement, no accounting voucher, no payroll entry
// and no change to any costing version. Surplus material goes back through the
// Store's own return workflow, which is where it always went — this record
// links to that and never substitutes for it.
//
// ── AND A CLOSED RESULT IS NEVER REWRITTEN ──────────────────────────────────
// A correction creates a NEW revision carrying its reason and supersedes the
// previous one. Exactly one revision is live, and only a live CLOSED revision
// reaches costing. What was closed in March still reads as it did in March —
// the same promise the frozen costing version makes.

"use strict";

const mongoose = require("mongoose");

const STATUSES = ["DRAFT", "READY_FOR_REVIEW", "CLOSED", "SUPERSEDED"];

/**
 * One material, and what became of it.
 *
 * ── THE IDENTITY IS AN ID, AND THE UNIT IS THE ISSUE'S OWN ──────────────────
 * Quantities are held in the unit the STOCK ISSUE was recorded in, so nothing
 * here converts anything: a conversion invented at closeout would be a second
 * answer to one the issue already gave.
 */
const materialLineSchema = new mongoose.Schema(
  {
    rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /* Readable after the masters move on, exactly as the costing freezes
       names beside ids. */
    itemName: { type: String, trim: true, default: "" },
    sku: { type: String, trim: true, default: "" },
    variantLabel: { type: String, trim: true, default: "" },
    unit: { type: String, trim: true, required: true },

    /* ── WHAT THE STORE RECORDS SAY, RE-READ AT CLOSE ─────────────────
       Server-derived from StockIssuance, never taken from the browser. */
    issuedQty: { type: Number, required: true, min: 0 },
    returnedQty: { type: Number, required: true, min: 0 },
    netIssuedQty: { type: Number, required: true },

    /* ── WHAT THE PERSON CLOSING SAYS BECAME OF IT ────────────────────
       The three must sum to `netIssuedQty` exactly. Unreturned material is
       NOT automatically scrap: somebody has to say which of the three it
       was, because "we lost it in cutting" and "it is still on the rack" are
       different facts with different consequences. */
    usedQty: { type: Number, required: true, min: 0 },
    scrapQty: { type: Number, required: true, min: 0 },
    remainingQty: { type: Number, required: true, min: 0 },

    /* The movements this line was reconciled from, so a reader a year later
       can see exactly which issues and returns were counted. */
    issuanceIds: { type: [mongoose.Schema.Types.ObjectId], default: () => [] },
    note: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { _id: false },
);

const closeoutSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },

    /* ── IDENTITY, FROM SERVER-RESOLVED RECORDS ───────────────────────
       Every one of these is read from the work order itself. A request body
       may name the work order and nothing else. */
    workOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder", required: true, index: true },
    workOrderNumber: { type: String, trim: true, default: "" },
    customerRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest", default: null, index: true },
    stockItemId: { type: mongoose.Schema.Types.ObjectId, ref: "StockItem", default: null },
    variantId: { type: String, default: null },

    status: { type: String, enum: STATUSES, default: "DRAFT", index: true },

    /* ── PRODUCTION OUTPUT ────────────────────────────────────────────
       `completedQty` is the scan evidence. The three classifications plus
       whatever is still unclassified must add to it exactly — enforced by
       the service, and stored so the arithmetic stays auditable rather than
       re-derived from figures that may since have moved. */
    output: {
      plannedQty: { type: Number, default: 0, min: 0 },
      completedQty: { type: Number, default: 0, min: 0 },
      acceptedGoodQty: { type: Number, default: 0, min: 0 },
      rejectedQty: { type: Number, default: 0, min: 0 },
      openReworkQty: { type: Number, default: 0, min: 0 },
      unclassifiedQty: { type: Number, default: 0, min: 0 },
      /* How the accepted figure was arrived at, so it can never be confused
         with the project manager's manual mark. */
      evidenceBasis: { type: String, trim: true, default: "" },
      /* Kept beside it, labelled, and never promoted. */
      legacyManualQcQty: { type: Number, default: null },
    },

    materials: { type: [materialLineSchema], default: () => [] },

    /* ── WHO, WHEN AND WHY ────────────────────────────────────────────
       On every close, supersede and correction. A closed result with no
       named actor is a result nobody can be asked about. */
    preparedByActorId: { type: String, trim: true, default: "" },
    preparedByName: { type: String, trim: true, default: "" },
    closedByActorId: { type: String, trim: true, default: "" },
    closedByName: { type: String, trim: true, default: "" },
    closedAt: { type: Date, default: null },
    reason: { type: String, trim: true, maxlength: 1000, default: "" },

    /* ── REVISIONS ────────────────────────────────────────────────────
       A correction is a new document, not an edit. `supersedes` points back
       so the chain is walkable, and the superseded one keeps its own closed
       figures forever. */
    revision: { type: Number, default: 1, min: 1 },
    supersedes: { type: mongoose.Schema.Types.ObjectId, ref: "ProductionCostCloseout", default: null },
    supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProductionCostCloseout", default: null },

    /* The key the creating action ran under, so a retry cannot produce a
       second closeout for the same work order. */
    idempotencyKey: { type: String, trim: true, default: "", index: true },
  },
  { timestamps: true },
);

/* ── EXACTLY ONE LIVE CLOSEOUT PER WORK ORDER ───────────────────────────────
   A DRAFT, a READY_FOR_REVIEW or a CLOSED revision is the live one;
   SUPERSEDED ones are history and sit outside the index, so any number may
   accumulate. The unique partial index is the guarantee, not a check somebody
   remembered to write. */
closeoutSchema.index(
  { companyId: 1, workOrderId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["DRAFT", "READY_FOR_REVIEW", "CLOSED"] } } },
);
/* A retry with the same key resolves to the same document. */
closeoutSchema.index(
  { companyId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
);
closeoutSchema.index({ customerRequestId: 1, status: 1 });

const Model = mongoose.models.ProductionCostCloseout
  || mongoose.model("ProductionCostCloseout", closeoutSchema);
Model.STATUSES = STATUSES;
module.exports = Model;
