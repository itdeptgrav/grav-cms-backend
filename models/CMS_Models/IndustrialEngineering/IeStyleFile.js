// models/CMS_Models/IndustrialEngineering/IeStyleFile.js
//
// THE STYLE ENGINEERING FILE, AND THE ONE DRAFT BULLETIN IT HOLDS.
//
// One company, one Sample Style, one file. It is IE's own record of how a
// style will be made: which operations, in what order, and what time IE is
// PROPOSING for each of them. It is reached through an order — the order is
// what proves the style is this company's — and it is created from the exact
// approved R&D technical version, whose frozen snapshot it keeps for ever.
//
// ── WHY A SNAPSHOT AND NOT A LIVE READ OF R&D ───────────────────────────────
// `SampleStyle.techSheet.technicalRevisions[]` already freezes each submitted
// revision, and `technicalRecord.approvedRevisionOf()` is the one resolver that
// says which of them a downstream module may read. This file copies that frozen
// snapshot in at creation and never re-reads it. R&D approving a NEWER revision
// afterwards does not rewrite this file — it raises a readiness gap saying the
// source moved, because silently re-basing an engineering file under somebody
// who is mid-bulletin is how a route stops matching the garment.
//
// ── WHY THE HISTORY IS EMBEDDED ─────────────────────────────────────────────
// Chunk 3A requires that a mutation and its audit event commit together or not
// at all. A separate events collection would need a transaction, and this
// deployment's own helpers (services/sales/merchandisingHandover.js `withTxn`)
// refuse outright without a replica set — so an audit trail in a second
// collection would be one that silently stops being atomic wherever Mongo is a
// standalone. Embedded, the file update and its event are literally the same
// single-document write, which Mongo guarantees atomically everywhere.
// It is bounded: each event is a short summary, never a copy of the file, and
// the array is capped by `$slice` at write time.
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
// No approval, no release, no APPROVED standard time, no allowances, no method
// study, no attachments, no skills, no line or station assignment, and no
// capacity. `proposedSamMinutes` is a PROPOSAL — Chunk 4 owns submission,
// review and approval, and naming the field `proposedSamMinutes` rather than
// `samMinutes` is how a later reader can tell that nobody has approved it.
"use strict";

const mongoose = require("mongoose");
const { processRouteSchema } = require("./processRoute.schema");

/* Only one status exists in this chunk, and it is written out rather than
   implied: a file that cannot yet be anything but DRAFT should still SAY
   DRAFT, so a screen never has to infer the lifecycle from its absence. */
const FILE_STATUS = ["DRAFT"];

const EVENT_TYPES = [
  "FILE_CREATED",
  "BULLETIN_ROW_ADDED",
  "BULLETIN_ROW_EDITED",
  "BULLETIN_ROW_REMOVED",
  "BULLETIN_REORDERED",
  /* Chunk 7C1. The file's own record of the three moments its bulletin left or
     returned to its hands. The VERSION holds the decision and its reasons; these
     say only that the file's draft was frozen, released or superseded, which is
     the part that belongs to the file. */
  "BULLETIN_VERSION_SUBMITTED",
  "BULLETIN_VERSION_RETURNED",
  "BULLETIN_VERSION_APPROVED",
  /* The draft process route changed — which stages, their order, whether each
     applies. Its own event so the trail never records a route decision as a
     bulletin row edit. */
  "PROCESS_ROUTE_EDITED",
  /* ── THE FILE RE-BASED ONTO A NEWER R&D REVISION ──────────────────────
     R&D approving a newer technical revision used to be the end of the road:
     the file stayed frozen against the revision it was opened from, every
     submission was refused as superseded, and the costing side said
     IE_TECHNICAL_APPROVAL_STALE for ever. These two events are the explicit
     way forward — somebody opened a successor cycle against the newer
     revision, and somebody reviewed what the move changed. */
  "SOURCE_REBASED",
  "SOURCE_REBASE_REVIEWED",
];

const LIMITS = Object.freeze({
  ROWS: 400,
  NOTE: 1000,
  SUMMARY: 300,
  HISTORY: 500,
  SAM_MINUTES: 10000,
});

/**
 * One bulletin row.
 *
 * `rowId` is the row's identity and is minted by the server once. It survives
 * reordering, re-timing and renaming, because a row is a decision somebody
 * made and the audit trail has to be able to name the same decision twice.
 * Sequence is a position, not an identity — it is renumbered on every save.
 */
const bulletinRowSchema = new mongoose.Schema(
  {
    rowId: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, min: 1 },

    /* ── THE ONLY OPERATION REGISTER THIS FILE MAY NAME ──────────────────
       `ieOperationId` / `ref: "IeOperation"` is the company library from Chunk
       2A. The legacy global register is named `operationId` / `ref:
       "Operation"` wherever it appears, and the two names never mix — that
       rule was fixed in IeOperation.js before this, its first consumer. */
    ieOperationId: { type: mongoose.Schema.Types.ObjectId, ref: "IeOperation", required: true },
    /* WHICH revision of that operation this row was built from, captured by
       the server. The library moving afterwards does not silently change what
       this bulletin says it was engineered against. */
    ieOperationRevision: { type: Number, required: true, min: 1 },

    /* Server-produced snapshots, so a bulletin still reads correctly when the
       library row is later renamed — and so a browser can never dictate what
       an operation is called on an engineering document. */
    operationCode: { type: String, trim: true, default: "" },
    operationName: { type: String, trim: true, default: "" },
    machineType: { type: String, trim: true, default: "" },

    /* ── A PROPOSAL, AND NULL IS NOT ZERO ────────────────────────────────
       `null` means "IE has not proposed a time yet" and raises a readiness
       gap. `0` means "this operation is proposed at no time", which is a
       statement somebody made and is not a gap. Defaulting null to 0 would
       turn every untimed row into a completed one. */
    proposedSamMinutes: { type: Number, default: null, min: 0, max: LIMITS.SAM_MINUTES },
    note: { type: String, trim: true, default: "", maxlength: LIMITS.NOTE },

    /* ── THE REQUIRED-MACHINE EVIDENCE, FROZEN (Chunk 6B) ──────────────────
       Which machine types the operation required WHEN THIS ROW WAS AUTHORED.
       Copied from the Chunk 5A profile at that moment and never re-read.

       This field is the prerequisite Chunk 6B had to add before compatibility
       could mean anything. `IeOperation.requirements` holds ONE profile — the
       current one — and its history records which categories somebody touched,
       never their values. So the requirements as of an older
       `ieOperationRevision` are unrecoverable: judging a layout by re-reading
       the library today would silently restate what a row was planned against.

       `null` on every row authored before this chunk, and deliberately left
       null: there is no backfill, because there is nothing truthful to backfill
       WITH. Compatibility for such a row is reported UNKNOWN, never compatible,
       incompatible, empty or zero. */
    requirementSnapshot: {
      type: new mongoose.Schema({
        capturedAt: { type: Date, required: true },
        /* The operation revision the evidence was read from — the same number
           the row itself carries, kept beside the evidence so the pair can be
           audited without inference. */
        ieOperationRevision: { type: Number, required: true, min: 1 },
        /* 5A's own flag at capture time. FALSE means nobody had decided what
           the operation requires, which is not the same as "requires nothing". */
        requirementsConfigured: { type: Boolean, required: true },
        machineTypes: {
          type: [new mongoose.Schema({
            machineType: { type: String, required: true, trim: true },
            quantity: { type: Number, required: true, min: 1 },
          }, { _id: false })],
          default: () => [],
        },
        /* ── CHUNK 8A-iii: THE OTHER TWO DIMENSIONS, ADDED ADDITIVELY ──
           Chunk 5A models three requirement dimensions on an operation —
           machine, attachment and labour — but only the machine half was ever
           frozen here. A comparison that silently reported the other two as
           "unchanged" would be a reassurance nobody had evidence for.

           These fields are OPTIONAL and there is no backfill. A row frozen
           before this existed simply has no `dimensionsCaptured`, which is what
           makes "never captured" distinguishable from "captured, and genuinely
           empty" — without that marker an operation needing no attachment would
           be indistinguishable from a snapshot taken before anybody looked. */
        dimensionsCaptured: { type: [String], default: undefined },
        machines: {
          type: [new mongoose.Schema({
            requirementId: { type: String, required: true, trim: true },
            sequence: { type: Number, required: true, min: 1 },
            machineType: { type: String, required: true, trim: true },
            quantity: { type: Number, required: true, min: 1 },
          }, { _id: false })],
          default: undefined,
        },
        attachments: {
          type: [new mongoose.Schema({
            requirementId: { type: String, required: true, trim: true },
            sequence: { type: Number, required: true, min: 1 },
            code: { type: String, required: true, trim: true },
            name: { type: String, required: true, trim: true },
            quantity: { type: Number, required: true, min: 1 },
            note: { type: String, trim: true, default: "" },
          }, { _id: false })],
          default: undefined,
        },
        labour: {
          type: [new mongoose.Schema({
            requirementId: { type: String, required: true, trim: true },
            sequence: { type: Number, required: true, min: 1 },
            workerType: { type: String, required: true, trim: true },
            quantity: { type: Number, required: true, min: 1 },
            skillCode: { type: String, trim: true, default: "" },
            skillName: { type: String, trim: true, default: "" },
            grade: { type: String, trim: true, default: "" },
            note: { type: String, trim: true, default: "" },
          }, { _id: false })],
          default: undefined,
        },
      }, { _id: false }),
      default: null,
    },
  },
  { _id: false },
);

/** A bounded audit line. Never a copy of the file. */
const fileEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    type: { type: String, enum: EVENT_TYPES, required: true },
    at: { type: Date, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorName: { type: String, trim: true, default: "" },
    /* The revision the file reached BY this event, so the history and the
       record can be lined up without guessing. */
    fileRevision: { type: Number, required: true, min: 1 },
    rowId: { type: String, trim: true, default: "" },
    summary: { type: String, trim: true, default: "", maxlength: LIMITS.SUMMARY },
  },
  { _id: false },
);

const ieStyleFileSchema = new mongoose.Schema(
  {
    /* Both from the resolved session context and the proven order-to-style
       attachment. Neither is ever read from a request body. */
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },
    sampleStyleId: { type: mongoose.Schema.Types.ObjectId, ref: "SampleStyle", required: true },

    /* Which order this file was opened through. Provenance, not authority:
       ownership is re-proved on every request, and a style reachable through
       two orders still has ONE engineering file. */
    openedFromOrderId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* ── THE SOURCE, FROZEN ──────────────────────────────────────────────── */
    source: {
      /* R&D's own version number for this style's technical record. */
      technicalRevision: { type: Number, required: true, min: 0 },
      submittedAt: { type: Date, default: null },
      approvedAt: { type: Date, default: null },
      /* Deliberately `Mixed`, exactly as `technicalRevisions[].snapshot` is: a
         frozen record must keep the shape it had, not be re-validated against
         a schema that has moved on. */
      snapshot: { type: mongoose.Schema.Types.Mixed, default: null },
      /* Read off the snapshot once, so a reader does not have to walk Mixed
         data to answer "did the source have a route at all". */
      operationCount: { type: Number, default: 0, min: 0 },
    },

    /* ── THE SUCCESSOR CYCLE, WHEN THERE IS ONE ──────────────────────────
       `source` above is the revision this file was OPENED from, and it is
       never rewritten: it is the provenance of the file itself and of every
       version already approved against it. When R&D approves a newer revision
       and IE deliberately moves onto it, the new basis is recorded HERE, as a
       second fact beside the first, and the pair reads as the history it is.

       Absent on every file that has never been re-based — and absent is the
       truth, not cycle 1 written out: a `default` would assert that every
       legacy file had been considered and left alone.

       Why not a second file: `{companyId, sampleStyleId}` is unique by
       design, and the index is what makes opening a file idempotent under two
       simultaneous requests. Re-basing does not need a second file — it needs
       a second SOURCE, and the versions frozen against the first one are
       already immutable documents of their own. */
    sourceCycle: {
      /* 2 for the first successor. Cycle 1 is `source` and is never written
         here, so the number cannot disagree with which field is in force. */
      cycleNo: { type: Number, min: 2 },
      technicalRevision: { type: Number, min: 0 },
      submittedAt: { type: Date },
      approvedAt: { type: Date },
      snapshot: { type: mongoose.Schema.Types.Mixed },
      operationCount: { type: Number, min: 0 },

      openedAt: { type: Date },
      openedBy: { type: mongoose.Schema.Types.ObjectId },
      openedByName: { type: String, trim: true },
      reason: { type: String, trim: true, maxlength: LIMITS.NOTE },

      /* What this cycle succeeded, so the chain is readable without inferring
         it from timestamps. The predecessor VERSION keeps its own state — it
         is superseded by the approval of the next one, exactly as any other
         successor version is, and never by this. */
      predecessorTechnicalRevision: { type: Number, min: 0 },
      predecessorVersionId: { type: mongoose.Schema.Types.ObjectId, ref: "IeBulletinVersion" },
      predecessorVersionNo: { type: Number, min: 1 },

      /* ── WHAT MOVED, AND WHAT HAS TO BE LOOKED AT AGAIN ────────────────
         The draft rows carry forward by their own `rowId` — they are IE's
         work and R&D's numbers do not author them. What R&D's change DOES do
         is put specific rows back in question, and those are named here
         rather than left to a reader to work out. A submission is refused
         while any of them stands, so "carried forward" can never quietly mean
         "approved again". */
      review: {
        materialsChanged: { type: Boolean },
        operationsChanged: { type: Boolean },
        requiredRowIds: { type: [String], default: undefined },
        changes: { type: mongoose.Schema.Types.Mixed },
        acknowledgedAt: { type: Date },
        acknowledgedBy: { type: mongoose.Schema.Types.ObjectId },
        acknowledgedByName: { type: String, trim: true },
      },
    },

    status: { type: String, enum: FILE_STATUS, default: "DRAFT", required: true },

    /* Optimistic concurrency for the whole file. Every accepted mutation
       increments it inside the same conditional update that writes. */
    revision: { type: Number, default: 1, min: 1 },

    /* THE one draft bulletin. Embedded rather than a second collection: it is
       edited as a whole, it is meaningless without its file, and embedding is
       what lets a bulletin change and its audit event be one atomic write. */
    bulletin: {
      rows: { type: [bulletinRowSchema], default: () => [] },
      /* ── THE DRAFT PROCESS ROUTE ──────────────────────────────────────
         Which production processes this style passes through, in what order,
         and which optional ones do NOT apply. Beside the rows because it is
         frozen with them: submitting the bulletin freezes the route into the
         same version, and the same review approves both. Absent until somebody
         declares one — see processRoute.schema.js. */
      processRoute: { type: processRouteSchema, default: undefined },
    },

    /* ── THE BULLETIN VERSION POINTERS (Chunk 7C1) ────────────────────────
       Four fields, and NONE of them carries a default. That is deliberate and
       it is the Chunk 1D rule: `default: null` writes a null onto every legacy
       document the moment an unrelated field is saved, and a stored null here
       would assert "this file was considered and has no submission" about files
       nobody has ever looked at. Absent is the truthful answer, and absent is
       what a legacy file keeps.

       ── THE REVIEW POINTER IS THE FREEZE ───────────────────────────────────
       `bulletinReviewVersionId` / `bulletinReviewVersionNo` name the one
       submitted version currently freezing the draft. Their PRESENCE is the
       freeze — there is no boolean beside them to fall out of step. Because the
       fact lives on this document, the existing bulletin PATCH enforces it in
       the same atomic filter that already enforces the revision, rather than
       reading another collection first and acting on what it found. Two reads
       are what a race gets between; one filter is not.

       Both are set by exactly one command (submit) and cleared by exactly two
       (return, approve), always inside the transaction that moves the version
       itself. Neither is ever written on its own. */
    currentApprovedBulletinVersionId: { type: mongoose.Schema.Types.ObjectId, ref: "IeBulletinVersion" },
    currentApprovedVersionNo: { type: Number, min: 1 },
    bulletinReviewVersionId: { type: mongoose.Schema.Types.ObjectId, ref: "IeBulletinVersion" },
    bulletinReviewVersionNo: { type: Number, min: 1 },

    history: { type: [fileEventSchema], default: () => [] },

    createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdByName: { type: String, trim: true, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    updatedByName: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "ie_style_files" },
);

/* ── ONE FILE PER STYLE PER COMPANY, DECIDED BY THE DATABASE ────────────────
 * Idempotent creation cannot be a service-level "check then insert": two
 * simultaneous requests both find nothing and both insert. This index is what
 * makes the second one lose, and the service turns that loss into "here is the
 * file that already exists" rather than an error. */
ieStyleFileSchema.index(
  { companyId: 1, sampleStyleId: 1 },
  { unique: true, name: "ie_style_file_one_per_style_per_company" },
);

module.exports = mongoose.models.IeStyleFile
  || mongoose.model("IeStyleFile", ieStyleFileSchema);
module.exports.FILE_STATUS = FILE_STATUS;
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.LIMITS = LIMITS;
