// models/CMS_Models/IndustrialEngineering/IeLineTemplate.js
//
// A REUSABLE LINE TEMPLATE — THE PATTERN, NOT THE LINE.
//
// An engineering PATTERN somebody wants to reuse: how many stations, in what
// order, what each is called, what each is planned to be equipped with, and
// which operations belong at each. It is captured from a layout that already
// exists, and from then on it lives its own life — editing the template changes
// no layout, and editing a layout changes no template.
//
// ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
// Not Production's floor layout, not an allocation of any machine, not a
// capacity plan, not a shift or an operator or an employee, not an approval and
// not a barcode. There is no field for any of them, so nothing built on this
// record can grow one by accident. Production's `CanvasLayout` is untouched.
//
// ── AND IT CARRIES NO IDENTITY IT COULD LEND ────────────────────────────────
// This is the whole of the chunk's risk. A template captured from one style's
// layout must never be able to make another style's layout claim that style's
// rows, source, revision, history or ownership. So:
//
//   · a slot names an operation by `ieOperationId` — the STABLE library
//     identity — and never by `operationCode`, which is mutable and which two
//     companies may both use;
//   · a slot names WHICH OCCURRENCE of that operation it means, because a
//     bulletin may place the same operation more than once, and "the second
//     buttonhole" has to survive being applied somewhere else;
//   · `bulletinRowId` is deliberately absent. A row id belongs to one file's
//     bulletin, and copying one into a template would be the mechanism by
//     which another style's layout inherited a row it does not have;
//   · `templateStationId` is the TEMPLATE's own station identity and is never
//     written into a layout — applying mints fresh layout station ids;
//   · `capturedFrom` is provenance for a person to read, never a key anything
//     resolves through.
"use strict";

const mongoose = require("mongoose");

const TEMPLATE_STATUS = ["ACTIVE", "RETIRED"];

const EVENT_TYPES = [
  "LINE_TEMPLATE_CREATED",
  "LINE_TEMPLATE_EDITED",
  "LINE_TEMPLATE_RETIRED",
  "LINE_TEMPLATE_RESTORED",
];

const LIMITS = Object.freeze({
  STATIONS: 200,
  SLOTS_PER_STATION: 100,
  MACHINE_TYPES_PER_STATION: 20,
  NAME: 160,
  LABEL: 120,
  NOTE: 1000,
  DESCRIPTION: 1000,
  SUMMARY: 300,
  HISTORY: 200,
  MACHINE_QUANTITY: 999,
});

/**
 * The uniqueness form of a template name.
 *
 * One normaliser, used by the index and by every writer, because two
 * normalisers is how a unique index starts admitting duplicates.
 */
const nameKeyOf = (v) => String(v ?? "").trim().replace(/\s+/g, " ").toUpperCase();

/**
 * ONE REUSABLE OPERATION SLOT.
 *
 * `ieOperationId` plus `occurrence` is the whole of the identity, and both are
 * needed. A bulletin that places "attach button" three times has three separate
 * decisions about where each goes, and a template that recorded only the
 * operation could not say which station the second one belonged to.
 *
 * `operationCode` and `operationName` are captured for a person to read and are
 * explicitly NOT how anything is matched — a code can be re-used after an
 * operation is retired, and matching on it is how one company's pattern would
 * resolve against another's library.
 */
const slotSchema = new mongoose.Schema(
  {
    slotId: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, min: 1 },
    ieOperationId: { type: mongoose.Schema.Types.ObjectId, required: true },
    /* Which occurrence of that operation, counted in the SOURCE's own order,
       starting at 1. */
    occurrence: { type: Number, required: true, min: 1 },
    /* Display only. Never a matching key — see the note above. */
    operationCode: { type: String, trim: true, default: "" },
    operationName: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

/** One station of the pattern. Its id is the TEMPLATE's, never a layout's. */
const templateStationSchema = new mongoose.Schema(
  {
    templateStationId: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, min: 1 },
    label: { type: String, trim: true, default: "", maxlength: LIMITS.LABEL },
    note: { type: String, trim: true, default: "", maxlength: LIMITS.NOTE },
    /* The same vocabulary Chunk 6B put on a layout station: a machine TYPE and
       a count. No machine, no serial, no availability, no operator. */
    plannedMachineTypes: {
      type: [new mongoose.Schema({
        machineType: { type: String, required: true, trim: true, maxlength: LIMITS.LABEL },
        quantity: { type: Number, required: true, min: 1, max: LIMITS.MACHINE_QUANTITY },
      }, { _id: false })],
      default: () => [],
    },
    slots: { type: [slotSchema], default: () => [] },
  },
  { _id: false },
);

/** A bounded audit line. Never a copy of the stations. */
const templateEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    type: { type: String, enum: EVENT_TYPES, required: true },
    at: { type: Date, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorName: { type: String, trim: true, default: "" },
    templateRevision: { type: Number, required: true, min: 1 },
    changed: { type: [{ type: String, trim: true }], default: () => [] },
    summary: { type: String, trim: true, default: "", maxlength: LIMITS.SUMMARY },
  },
  { _id: false },
);

const ieLineTemplateSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: LIMITS.NAME },
    /* Derived, never accepted from a caller — see `nameKeyOf`. */
    nameKey: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "", maxlength: LIMITS.DESCRIPTION },

    status: { type: String, enum: TEMPLATE_STATUS, default: "ACTIVE", required: true },
    revision: { type: Number, default: 1, min: 1 },

    stations: { type: [templateStationSchema], default: () => [] },

    /* ── WHERE THE PATTERN CAME FROM ───────────────────────────────────────
       Provenance a person reads: which layout it was captured from, of which
       file, at which bulletin revision, and when. NOTHING resolves through it.
       It is recorded because "where did this pattern come from" is a fair
       question, and because a template captured from a layout that has since
       been superseded is still a perfectly good pattern.

       Capturing it does NOT tie the two records together: the layout may be
       edited, superseded or left alone afterwards and this template does not
       move, and this template may be edited or retired afterwards and that
       layout does not move. */
    capturedFrom: {
      type: new mongoose.Schema({
        layoutId: { type: mongoose.Schema.Types.ObjectId, default: null },
        ieStyleFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
        bulletinRevision: { type: Number, default: null },
        layoutRevision: { type: Number, default: null },
        capturedAt: { type: Date, default: null },
      }, { _id: false }),
      default: null,
    },

    history: { type: [templateEventSchema], default: () => [] },

    createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdByName: { type: String, trim: true, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    updatedByName: { type: String, trim: true, default: "" },
    statusChangedAt: { type: Date, default: null },
    statusChangedByName: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "ie_line_templates" },
);

/* ── ONE ACTIVE NAME PER COMPANY ───────────────────────────────────────────
 * A name is how somebody picks a template out of a list, so two ACTIVE ones
 * called the same thing make the list unusable. "Look then insert" is two
 * operations that two simultaneous requests both pass, so the database decides
 * it.
 *
 * Partial on ACTIVE, exactly as the operation library's code index is: retiring
 * a template RELEASES its name, so the name can be used again, and restoring
 * one can therefore be refused when it has been taken in the meantime. That is
 * the same shape of answer Chunk 2A already gives for an operation code, and
 * the same shape of resolution.
 */
ieLineTemplateSchema.index(
  { companyId: 1, nameKey: 1 },
  {
    unique: true,
    name: "ie_line_template_one_active_name_per_company",
    partialFilterExpression: { status: "ACTIVE" },
  },
);

/* The company's templates, newest first — the list endpoint's own order. */
ieLineTemplateSchema.index({ companyId: 1, createdAt: -1, _id: -1 });
/* And the same list filtered by status, which is the other way it is read. */
ieLineTemplateSchema.index({ companyId: 1, status: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.models.IeLineTemplate
  || mongoose.model("IeLineTemplate", ieLineTemplateSchema);
module.exports.TEMPLATE_STATUS = TEMPLATE_STATUS;
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.LIMITS = LIMITS;
module.exports.nameKeyOf = nameKeyOf;
