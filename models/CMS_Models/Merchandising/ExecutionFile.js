// models/CMS_Models/Merchandising/ExecutionFile.js
//
// THE MERCHANDISING EXECUTION FILE — the permanent order-level coordination
// record the final plan puts at the root of the Merchandising app.
//
// ── HOW ONE COMES TO EXIST, AND THE ONLY WAY ────────────────────────────────
// As the transactional consequence of ACCEPTING a valid Sales handover
// version. There is no POST /files, no manual create, no import path and no
// screen that offers one: a file that did not start from an accepted,
// versioned Sales confirmation would be a coordination record for a promise
// nobody made.
//
// Identity is (companyId, handoverRef, handoverLineRef), unique in the
// database — which is what makes acceptance idempotent and concurrent
// acceptance produce exactly one file: the second writer loses at the index,
// not at a comment.
//
// ── WHAT MERCHANDISING MAY AND MAY NOT TOUCH ────────────────────────────────
// The commercial projection embedded here is a COPY of the accepted handover
// version and stays read-only: quantity, deliveries, requirements and
// references change only when Sales issues a new version and Merchandising
// accepts it, which re-stamps the copy and appends to the source history.
//
// Merchandising owns everything else: the responsible merchandiser, the
// lifecycle (open / on hold / closed / reopened), tags, the coordination
// note. Lifecycle moves through dedicated commands with reasons and audit
// events — never through a generic PATCH, which is how a status becomes a
// field somebody "fixes".
//
// CANCELLED is not a Merchandising state. It mirrors a Sales-owned
// cancellation, arrives with the source version that authorised it, and no
// Merchandising command can set or reverse it.
"use strict";

const mongoose = require("mongoose");

const { executionProjectionSchema } = require("../Sales/executionProjection");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/** Every lifecycle value a file can hold, and who may produce each. */
const LIFECYCLE = Object.freeze({
  OPEN: "OPEN",                 // Merchandising — the state acceptance creates
  ON_HOLD: "ON_HOLD",           // Merchandising, with a reason
  CLOSED: "CLOSED",             // Merchandising, with a reason
  CANCELLED: "CANCELLED",       // mirrored from Sales; irreversible here
  /* ── M6 ────────────────────────────────────────────────────────────────
     The file has been handed downstream and PPC has ACCEPTED the pack.

     Merchandising cannot produce this state by itself, and that is the point:
     it is written by the receiver-decision mirror when PPC accepts, and
     reversed to OPEN when PPC asks for clarification or Merchandising
     supersedes the pack. Submitting is not handing over — a submitted pack
     nobody has accepted leaves the file OPEN, because the receiving decision
     is PPC's and the register must not claim it was made.

     Before M6 the register mapped a `handed-over` view onto this name with
     nothing able to produce it. The view is now real. */
  HANDED_OVER: "HANDED_OVER",   // written only by PPC's acceptance, mirrored
});

const executionFileSchema = new mongoose.Schema(
  {
    /* Human, audit-facing reference — MEF-YYYY-NNNN, minted atomically at
       acceptance from the shared CRM counter collection. */
    fileNumber: { type: String, required: true, unique: true, immutable: true, trim: true },

    /* Stamped from the accepting actor's resolved scope inside the acceptance
       transaction. Never body-authored; the route refuses the field by name. */
    companyId: {
      type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company",
      required: true, index: true, immutable: true,
    },

    handoverRef: { type: String, trim: true, required: true, immutable: true },
    handoverLineRef: { type: String, trim: true, required: true, immutable: true },

    /* The accepted version currently in force, and every version that has
       ever been in force here — append-only, oldest first. */
    currentHandoverVersionId: {
      type: mongoose.Schema.Types.ObjectId, ref: "SalesHandoverVersion", required: true,
    },
    sourceVersionHistory: [
      new mongoose.Schema(
        {
          versionId: { type: mongoose.Schema.Types.ObjectId, required: true },
          versionNo: { type: Number, required: true },
          event: { type: String, enum: ["ACCEPTED", "CANCELLED_BY_SALES"], required: true },
          at: { type: Date, required: true },
          by: actorRef(),
        },
        { _id: false },
      ),
    ],

    /* ── THE READ-ONLY COMMERCIAL COPY ────────────────────────────────────
       The accepted version's projection, re-stamped whole on each acceptance,
       declared with the SAME schema the version itself uses.
       
       It was `Schema.Types.Mixed`, which is not a copy of a contract but the
       absence of one: anything at all could be written into the accepted
       projection and nothing would object — a stray price copied by some
       future helper, a renamed field arriving as a second spelling, a nested
       object of a shape nobody agreed. The allowlist guarding the door meant
       nothing once the record behind it accepted everything. Strict mode now
       does what the allowlist alone could not. */
    currentExecutionProjection: { type: executionProjectionSchema(), required: true },

    lifecycleStatus: {
      type: String, enum: Object.values(LIFECYCLE), default: LIFECYCLE.OPEN, index: true,
    },
    /* Why the file is where it is — the reason the last lifecycle command
       carried. The full trail is in the audit events; this is the one line a
       register row can show. */
    lifecycleReason: { type: String, trim: true, default: "" },

    /* The coarse phase for the register column. Each value is produced by a
       real act and by nothing else:

         INTAKE          acceptance opened the file
         COORDINATION    a pack draft exists — somebody is assembling the
                         handover
         PACK_SUBMITTED  a version was submitted and is awaiting PPC
         HANDED_OVER     PPC accepted it

       The phase never runs ahead of the record that moves it, and it moves
       BACKWARDS when the world does: a clarification returns the file to
       COORDINATION, because that is honestly where the work is again. */
    executionPhase: {
      type: String,
      enum: ["INTAKE", "COORDINATION", "PACK_SUBMITTED", "HANDED_OVER"],
      default: "INTAKE",
    },

    /* ── M6: WHAT WAS HANDED DOWN, AND WHAT CAME BACK ─────────────────────
       Both are DISPLAY MIRRORS of records that live elsewhere — the pack
       version in force, and PPC's decision on it. The authoritative answers
       are `ExecutionPack` and PPC's own `DownstreamHandoverReceipt`; these
       exist so the register can draw a page of rows without a lookup per row,
       and the register says "as PPC recorded it" wherever it shows them.

       `downstreamReceiptState` is never written by a Merchandising decision.
       It is mirrored when PPC's decision is delivered back. */
    currentPackVersionNo: { type: Number, default: null },
    downstreamReceiptState: { type: String, trim: true, default: null },

    /* ── M7: WHERE THIS FILE SITS IN THE ORGANISATION ─────────────────────
       Filters, never permission boundaries. Authority stays the company-scoped
       department grant, and nothing in the access layer reads any of these —
       the same rule `responsibleMerchandiser` has followed since M2.

       Every one defaults to EMPTY rather than to a guess. There is no
       authoritative division or team register in this repository yet, so a
       file whose division nobody has stated reads "unassigned" on screen. An
       invented default would be a filter that quietly excluded records from a
       register somebody was relying on. `buyerRef` and `factoryRef` are
       populated from the Sales projection where it states them. */
    divisionRef: { type: String, trim: true, default: "", index: true },
    teamRef: { type: String, trim: true, default: "", index: true },
    factoryRef: { type: String, trim: true, default: "" },
    buyerRef: { type: String, trim: true, default: "" },

    /* ── M7: ARCHIVED HIDES, IT NEVER DELETES ─────────────────────────────
       A closed or handed-over file beyond the retention age is excluded from
       the default register queries and stays fully readable by reference,
       exportable, and present in every audit trail. Nothing is removed. */
    /* ── M8: THE DEVELOPMENT JOB THIS ORDER CAME FROM ─────────────────────
       Copied from the accepted handover version. A reference, so the order
       can offer to adopt the approved development selection into its own
       Materials & Trims and Packaging drafts — and so "what did we sample
       against" stays answerable from the order for ever. Null for an order
       that never went through development. */
    developmentReference: {
      developmentFileId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
      developmentNumber: { type: String, trim: true, default: "" },
      bomRevisionNo: { type: Number, default: null },
      releaseReference: { type: String, trim: true, default: "" },
    },

    archived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    archivedReason: { type: String, trim: true, default: "", maxlength: 500 },

    /* ── RESPONSIBILITY, NOT AUTHORITY ────────────────────────────────────
       Who answers for this file. A record attribute and a filter — never a
       permission: the access layer deliberately does not read it. */
    responsibleMerchandiser: {
      email: { type: String, trim: true, lowercase: true },
      name: { type: String, trim: true },
      assignedAt: { type: Date },
      assignedBy: actorRef(),
    },
    assignmentHistory: [
      new mongoose.Schema(
        {
          email: { type: String, trim: true, lowercase: true },
          name: { type: String, trim: true },
          reason: { type: String, trim: true, default: "" },
          at: { type: Date, required: true },
          by: actorRef(),
        },
        { _id: false },
      ),
    ],

    tags: [{ type: String, trim: true, maxlength: 60 }],
    coordinationNote: { type: String, trim: true, default: "", maxlength: 4000 },

    /* Sales' cancellation, mirrored with its authority. */
    cancellation: {
      sourceVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      reason: { type: String, trim: true, default: "" },
      at: { type: Date, default: null },
    },

    /* Optimistic concurrency for every mutable command. A stale write is a
       409, never a silent overwrite. */
    revision: { type: Number, default: 0 },

    createdBy: actorRef(),
    updatedBy: actorRef(),
  },
  { timestamps: true },
);

/* ONE file per handover line per company. The invariant everything else —
   idempotent acceptance, concurrent acceptance, "retry returns the same
   file" — rests on. */
executionFileSchema.index(
  { companyId: 1, handoverRef: 1, handoverLineRef: 1 },
  { unique: true },
);

/* The register's list reads: by lifecycle, newest movement first; and the
   Assigned-to-me filter. */
executionFileSchema.index({ companyId: 1, lifecycleStatus: 1, updatedAt: -1, _id: -1 });
executionFileSchema.index({ companyId: 1, "responsibleMerchandiser.email": 1, updatedAt: -1 });

/* ── M7 INDEXES ───────────────────────────────────────────────────────────
   Every register query this milestone adds is an index scan. Declared here,
   beside the fields they cover, and asserted by a query-plan test rather than
   by a wall-clock number. */
executionFileSchema.index({ companyId: 1, buyerRef: 1, updatedAt: -1 });
executionFileSchema.index({ companyId: 1, factoryRef: 1, updatedAt: -1 });
executionFileSchema.index({ companyId: 1, divisionRef: 1, updatedAt: -1 });
/* The default register excludes archived rows, so the flag leads the index. */
executionFileSchema.index({ companyId: 1, archived: 1, lifecycleStatus: 1, updatedAt: -1, _id: -1 });

executionFileSchema.statics.LIFECYCLE = LIFECYCLE;

module.exports = mongoose.models.MerchandisingExecutionFile
  || mongoose.model("MerchandisingExecutionFile", executionFileSchema);
