// models/CMS_Models/Merchandising/SelectionRevision.js
//
// WHAT MERCHANDISING HAS SELECTED FOR AN EXECUTION FILE, AS VERSIONS.
//
// Two families of the same shape:
//
//   MATERIAL_TRIM   fabric, trims, labels, accessories — the Digital Trim Card
//   PACKAGING       polybag, carton, tags, marks — the packing specification
//
// They share one lifecycle, one numbering rule, one row-identity rule and one
// audit vocabulary, so they share one base schema and one service. They do NOT
// share a row shape, because a carton mark is not a colourway and pretending
// otherwise would give both families a column neither uses.
//
// ── THE ROOT IS THE EXECUTION FILE ──────────────────────────────────────────
// Never the SampleStyle. That document is a SHARED R&D record which Sales and
// Product Development also write, it has no company of its own, and one style
// can legitimately be executed on two order lines with different trims and
// different packing. Rooting a permanent selection there would make the
// selection a property of the design rather than of the commitment, and would
// hand two other applications write access to it. The transitional packaging
// data that lives there is adopted FROM, never adopted INTO.
//
// ── WHY ROWS CARRY AN OPAQUE REFERENCE ──────────────────────────────────────
// A row is followed across revisions: "the main label changed placement at
// revision 4" is a sentence only possible if the main label is the same row in
// revisions 3 and 4. Array position cannot do that — a withdrawn row above it
// renumbers everything below — and neither can the component name, which is
// exactly the field somebody corrects. So each row is minted `MTR-`/`PKG-` and
// twelve hex characters once, and a clone carries it forward unchanged. This
// is the same lesson the order line learned in M2.1.
//
// ── WHAT HAS NOWHERE TO GO ──────────────────────────────────────────────────
// No rate, price, supplier, quotation, purchase order, stock, lot, reservation,
// ordered/received/issued quantity, consumption, wastage or laboratory result.
// Those belong to Supply Chain, Store, Product Development and Quality. The
// request contract refuses them by name; this schema has no field that could
// hold one, which is the guarantee that survives somebody adding a new door.
//
// A row may REFERENCE another application's record — an authorised item in a
// catalogue — through `catalogueRef`, which stores an identity and a source
// version and nothing operational. Referencing is not owning.
"use strict";

const mongoose = require("mongoose");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/** The two families. One lifecycle, two row shapes. */
const REVISION_FAMILY = Object.freeze({
  MATERIAL_TRIM: "MATERIAL_TRIM",
  PACKAGING: "PACKAGING",
  /* M4. A third family of the same shape: what Merchandising REQUIRES to be
     developed for this file — a fit sample, a screen, a wash recipe. It is
     versioned and approved exactly like the other two, because "what we asked
     for" changes over a season and the question "what did we ask for in
     March" has to stay answerable. */
  DEVELOPMENT: "DEVELOPMENT",
});

/**
 * The lifecycle, and the one decision that is not a state.
 *
 * DRAFT → SUBMITTED → APPROVED, and an APPROVED revision becomes SUPERSEDED
 * the moment a later one is approved. "Changes required" is a DECISION taken
 * on a submitted revision that returns it to DRAFT with the reason recorded —
 * not a fourth state, because the revision is once again the thing somebody is
 * editing and a register that showed it as anything else would be describing
 * the approver's opinion rather than the record's condition.
 */
const REVISION_STATE = Object.freeze({
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
  APPROVED: "APPROVED",
  SUPERSEDED: "SUPERSEDED",
});

/* ── COMPONENT CLASSES — STABLE CODES, SEPARATE DISPLAY TEXT ───────────────
   The code is the identity and the name is what a person reads. A category
   renamed from "Trim" to "Trims & Fastenings" must not orphan every row filed
   under it, which is what happens when the visible text is the key. */
const COMPONENT_GROUP = Object.freeze({
  FABRIC: "FABRIC",
  TRIM: "TRIM",
  LABEL: "LABEL",
  ACCESSORY: "ACCESSORY",
  OTHER: "OTHER",
});

const PACKAGING_GROUP = Object.freeze({
  POLYBAG: "POLYBAG",
  CARTON: "CARTON",
  TAG: "TAG",
  STICKER: "STICKER",
  TISSUE_OR_INSERT: "TISSUE_OR_INSERT",
  OTHER: "OTHER",
});

/**
 * WHICH EXECUTION UNITS A ROW APPLIES TO.
 *
 * Most rows apply to the whole line, and saying so explicitly is better than
 * an empty list that could mean "everything" or "nothing chosen yet". A row
 * that applies to some units names them by `unitDiscriminator` — the stable
 * identity M2.1 built from source references — and the service proves every
 * one of them belongs to THIS file and company before it is stored.
 */
const applicabilityFields = () => ({
  appliesToAllUnits: { type: Boolean, default: true },
  unitRefs: [{ type: String, trim: true }],
});

/** A reference to somebody else's record: identity and version, never data. */
const sourceRefSchema = () => new mongoose.Schema(
  {
    app: { type: String, trim: true },
    recordType: { type: String, trim: true },
    recordId: { type: mongoose.Schema.Types.ObjectId },
    recordRef: { type: String, trim: true },
    sourceVersion: { type: String, trim: true },
    /* The state the source record was in when it was referenced. Structured
       rather than folded into a note, because "this came from a selection
       that was only PROPOSED" is a fact somebody filters on, not prose. */
    sourceState: { type: String, trim: true },
  },
  { _id: false },
);

/* ── THE MATERIAL / TRIM ROW ───────────────────────────────────────────── */

const materialTrimRowSchema = new mongoose.Schema(
  {
    rowRef: { type: String, trim: true, required: true },
    group: { type: String, enum: Object.values(COMPONENT_GROUP), required: true },
    /* The configurable category's stable code, where one is configured. */
    componentCode: { type: String, trim: true, default: "" },
    componentName: { type: String, trim: true, required: true },
    internalRef: { type: String, trim: true, default: "" },
    buyerRef: { type: String, trim: true, default: "" },
    colourOrShade: { type: String, trim: true, default: "" },
    finish: { type: String, trim: true, default: "" },
    placement: { type: String, trim: true, default: "" },
    sizeOrDimension: { type: String, trim: true, default: "" },
    specification: { type: String, trim: true, default: "", maxlength: 2000 },
    notes: { type: String, trim: true, default: "", maxlength: 2000 },
    ...applicabilityFields(),
    /* An authorised catalogue item, by reference. Never its rate or stock. */
    catalogueRef: sourceRefSchema(),
    sourceRef: sourceRefSchema(),
  },
  { _id: false },
);

/* ── THE PACKAGING ROW ─────────────────────────────────────────────────── */

const packagingRowSchema = new mongoose.Schema(
  {
    rowRef: { type: String, trim: true, required: true },
    group: { type: String, enum: Object.values(PACKAGING_GROUP), required: true },
    componentCode: { type: String, trim: true, default: "" },
    componentName: { type: String, trim: true, required: true },
    buyerRef: { type: String, trim: true, default: "" },
    colourOrShade: { type: String, trim: true, default: "" },
    placement: { type: String, trim: true, default: "" },
    sizeOrDimension: { type: String, trim: true, default: "" },
    specification: { type: String, trim: true, default: "", maxlength: 2000 },
    notes: { type: String, trim: true, default: "", maxlength: 2000 },
    ...applicabilityFields(),
    catalogueRef: sourceRefSchema(),
    sourceRef: sourceRefSchema(),
  },
  { _id: false },
);

/* ── WHAT DEVELOPMENT IS REQUIRED ──────────────────────────────────────────
 *
 * Merchandising states the REQUIREMENT: what kind of development or tooling
 * this order needs, what it is for, when it is needed by, and which units it
 * applies to. The specialist department then does the work and records the
 * result on its own record — which this references and never contains.
 *
 * So there is no measurement, no pattern, no marker, no consumption, no sample
 * round, no test result and no correction here. `sourceRef` points at the
 * record that will hold them, with the version it was read at, and
 * `approvedReferenceExpected` says whether this requirement is one that ends
 * in somebody else's approved reference — which is what the Approvals register
 * then watches for. */
const DEVELOPMENT_TYPE = Object.freeze({
  FIT_SAMPLE: "FIT_SAMPLE",
  SIZE_SET_SAMPLE: "SIZE_SET_SAMPLE",
  PRE_PRODUCTION_SAMPLE: "PRE_PRODUCTION_SAMPLE",
  SHIPMENT_SAMPLE: "SHIPMENT_SAMPLE",
  PRINT: "PRINT",
  EMBROIDERY: "EMBROIDERY",
  WASH: "WASH",
  ARTWORK: "ARTWORK",
  MOULD: "MOULD",
  SCREEN: "SCREEN",
  DIE: "DIE",
  OTHER: "OTHER",
});

/** Which application owns the work a requirement asks for. */
const SOURCE_APPLICATION = Object.freeze({
  PRODUCT_DEVELOPMENT: "PRODUCT_DEVELOPMENT",
  QUALITY: "QUALITY",
  SALES: "SALES",
  MERCHANDISING: "MERCHANDISING",
});

const developmentRowSchema = new mongoose.Schema(
  {
    /* Named `rowRef` in storage so one lifecycle serves all three families;
       the Development view calls it `requirementRef`, which is what it is. */
    rowRef: { type: String, trim: true, required: true },
    requirementType: { type: String, enum: Object.values(DEVELOPMENT_TYPE), required: true },
    /* The configurable sub-type's stable code, where one is configured. */
    requirementCode: { type: String, trim: true, default: "" },
    title: { type: String, trim: true, required: true },
    brief: { type: String, trim: true, default: "", maxlength: 4000 },
    requiredByDate: { type: Date, default: null },
    /* Whose work this is. Merchandising asks; somebody else answers. */
    responsibleApplication: {
      type: String, enum: Object.values(SOURCE_APPLICATION),
      default: SOURCE_APPLICATION.PRODUCT_DEVELOPMENT,
    },
    /* Whether this requirement is expected to end in an approved reference
       from that application — which is what the Approvals register watches. */
    approvedReferenceExpected: { type: Boolean, default: true },
    coordinationNote: { type: String, trim: true, default: "", maxlength: 2000 },
    ...applicabilityFields(),
    sourceRef: sourceRefSchema(),
  },
  { _id: false },
);

/* ── THE PACKING INSTRUCTIONS ──────────────────────────────────────────────
   Buyer-facing prose that describes the whole specification rather than one
   component: how the garment is folded, how sizes and colours are assorted,
   what the carton is marked with. They sit on the revision, not on a row,
   because "fold in three, chest label up" is not a property of the polybag. */
const packingInstructionSchema = new mongoose.Schema(
  {
    foldingMethod: { type: String, trim: true, default: "", maxlength: 2000 },
    assortmentInstruction: { type: String, trim: true, default: "", maxlength: 2000 },
    ratioDescription: { type: String, trim: true, default: "", maxlength: 2000 },
    cartonMarks: { type: String, trim: true, default: "", maxlength: 2000 },
    /* ── HOW MANY GARMENTS ONE CARTON HOLDS ──────────────────────────────
       The numeric half of the pack-out the prose above describes, and the one
       a costing needs: freight and per-carton packaging are charged by the
       carton, with ceiling division, so 250 garments at 40 a carton is seven
       cartons and the seventh is paid for in full.

       Here rather than on a row, for the same reason the folding method is —
       it is a property of the pack-out, not of the polybag. Absent, never
       zero: a carton holding no garments is not a pack configuration. */
    garmentsPerCarton: { type: Number, min: 1, default: undefined },
    additionalInstruction: { type: String, trim: true, default: "", maxlength: 4000 },
  },
  { _id: false },
);

/* ── THE REVISION ──────────────────────────────────────────────────────── */

/**
 * One revision of one family, for one Execution File.
 *
 * `rows` is the family's own row schema; everything else is shared.
 */
function revisionSchema({ family, rows, extra = {}, collection }) {
  const schema = new mongoose.Schema(
    {
      companyId: {
        type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company",
        required: true, index: true, immutable: true,
      },
      fileId: {
        type: mongoose.Schema.Types.ObjectId, ref: "MerchandisingExecutionFile",
        required: true, index: true, immutable: true,
      },
      /* Stored as well as implied by the collection, so an audit row, an
         outbox payload and a response can all name the family the same way. */
      family: { type: String, enum: [family], default: family, immutable: true },

      revisionNo: { type: Number, min: 1, required: true, immutable: true },
      state: {
        type: String, enum: Object.values(REVISION_STATE),
        default: REVISION_STATE.DRAFT, required: true, index: true,
      },

      rows: { type: [rows], default: [] },
      ...extra,

      /* The revision this one was cloned from, and the one that replaced it. */
      clonedFromRevisionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      supersedesRevisionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      supersededByRevisionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      supersededAt: { type: Date, default: null },

      /* ── WHO DID WHAT ────────────────────────────────────────────────
         Author and submitter are kept apart from the approver on purpose:
         maker/checker separation is a comparison between them, and it can
         only be made if both were recorded at the time. */
      createdBy: actorRef(),
      submittedBy: actorRef(),
      submittedAt: { type: Date, default: null },
      approvedBy: actorRef(),
      approvedAt: { type: Date, default: null },

      /* The last changes-required decision, kept on the revision it was made
         about so the draft somebody reopens still says why. */
      changesRequired: {
        reason: { type: String, trim: true, default: "" },
        by: actorRef(),
        at: { type: Date, default: null },
      },

      /* Where a revision created by adopting transitional data came from. */
      adoption: {
        batchId: { type: String, trim: true, default: "" },
        sourceRecordType: { type: String, trim: true, default: "" },
        sourceRecordId: { type: mongoose.Schema.Types.ObjectId, default: null },
        sourceUpdatedAt: { type: Date, default: null },
        adoptedAt: { type: Date, default: null },
        adoptedBy: actorRef(),
      },

      /* Optimistic concurrency. A stale write is a 409, never a silent
         overwrite of somebody else's edit. */
      revision: { type: Number, default: 0 },
      updatedBy: actorRef(),
    },
    { timestamps: true, collection },
  );

  /* Numbers are unique per file and family, and never reset. */
  schema.index({ companyId: 1, fileId: 1, revisionNo: 1 }, { unique: true });

  /* ── THE TWO INVARIANTS THE DATABASE OWNS ─────────────────────────────
     At most one revision being edited, and at most one in force. Partial
     unique indexes rather than a check in code: two approvals racing is
     exactly the case a check-then-write loses, and the loser must fail at
     the index rather than produce a second current truth. */
  schema.index(
    { companyId: 1, fileId: 1 },
    { unique: true, partialFilterExpression: { state: REVISION_STATE.DRAFT }, name: "one_draft_per_file" },
  );
  schema.index(
    { companyId: 1, fileId: 1 },
    { unique: true, partialFilterExpression: { state: REVISION_STATE.SUBMITTED }, name: "one_submitted_per_file" },
  );
  schema.index(
    { companyId: 1, fileId: 1 },
    { unique: true, partialFilterExpression: { state: REVISION_STATE.APPROVED }, name: "one_approved_per_file" },
  );

  /* The history read: this file's revisions, newest first. */
  schema.index({ companyId: 1, fileId: 1, revisionNo: -1 });
  /* Adoption idempotency: has this source already been taken in? */
  schema.index({ companyId: 1, fileId: 1, "adoption.sourceRecordId": 1 });

  return schema;
}

const MaterialTrimRevision = mongoose.models.MerchandisingMaterialTrimRevision
  || mongoose.model(
    "MerchandisingMaterialTrimRevision",
    revisionSchema({
      family: REVISION_FAMILY.MATERIAL_TRIM,
      rows: materialTrimRowSchema,
      collection: "merchandising_material_trim_revisions",
    }),
  );

const PackagingRevision = mongoose.models.MerchandisingPackagingRevision
  || mongoose.model(
    "MerchandisingPackagingRevision",
    revisionSchema({
      family: REVISION_FAMILY.PACKAGING,
      rows: packagingRowSchema,
      extra: { instructions: { type: packingInstructionSchema, default: () => ({}) } },
      collection: "merchandising_packaging_revisions",
    }),
  );

const DevelopmentRevision = mongoose.models.MerchandisingDevelopmentRevision
  || mongoose.model(
    "MerchandisingDevelopmentRevision",
    revisionSchema({
      family: REVISION_FAMILY.DEVELOPMENT,
      rows: developmentRowSchema,
      collection: "merchandising_development_revisions",
    }),
  );

module.exports = {
  REVISION_FAMILY, REVISION_STATE, COMPONENT_GROUP, PACKAGING_GROUP,
  DEVELOPMENT_TYPE, SOURCE_APPLICATION,
  MaterialTrimRevision, PackagingRevision, DevelopmentRevision,
};
