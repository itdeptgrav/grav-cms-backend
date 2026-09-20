// models/CMS_Models/IndustrialEngineering/IeOperation.js
//
// INDUSTRIAL ENGINEERING'S OWN OPERATION MASTER — COMPANY-SCOPED, RETIRABLE.
//
// ── WHY A SECOND COLLECTION AND NOT A COLUMN ON THE OLD ONE ─────────────────
// `models/CMS_Models/Inventory/Configurations/Operation.js` is the legacy global
// register: no `companyId`, no retirement state, duplicate codes present in live
// data (TS008 among them, reported by the configuration screen and refused by
// the costing resolver rather than reconciled), a hard `DELETE` route, and an
// import that writes rows in bulk. Store, Sales, QC, Production and the costing
// resolver all read it, and none of them may change.
//
// Adding `companyId: required` and a unique `(companyId, code)` index to THAT
// schema would have done three things, each on its own disqualifying:
//
//   1. made every existing document invalid on its next `save()` — including
//      documents saved by routes this chunk is forbidden to touch;
//   2. failed to build the unique index at all, because the live register
//      already holds the duplicates the index would forbid;
//   3. forced a backfill decision — whose company does a 2024 operation belong
//      to? — that nobody can answer from the data, and that this slice is
//      explicitly not allowed to guess at.
//
// So the legacy register keeps its meaning: a single global list, still read by
// `GET /api/cms/ie/operations` with its scope limitation published on the
// response, still written only by the Store/Configuration routes. This is a new
// register beside it, and the two never merge silently.
//
// ── HOW A LATER ROUTE ROW WILL SAY WHICH REGISTER IT MEANS ──────────────────
// The two registers hold ObjectIds that look identical, so a field name is the
// only thing that can distinguish them. The rule, fixed here so Chunk 3's
// bulletin rows cannot get it wrong:
//
//   · `operationId`, `ref: "Operation"`   → the LEGACY global register.
//     Already stored on SampleStyle.techSheet.technical.operations[] and on
//     SampleStyle …product.operations[]. Untouched by this chunk.
//   · `ieOperationId`, `ref: "IeOperation"` → THIS register, plus
//     `ieOperationRevision` for the standard the row was copied from.
//
// A row must never carry the same id under both names, and no code in this
// slice writes either — the rule exists before the first consumer so the first
// consumer has something to follow.
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
// No SAM, no allowed time, no skill grade, no attachments, no method study, no
// import/export, no category, no replacement reference, no effective dating and
// no approval state. Chunk 2A is identity, uniqueness, machine type, aliases,
// retirement and optimistic concurrency — nothing that carries an engineering
// STANDARD, because a standard needs the approval lifecycle Chunk 2B/3 adds and
// storing a number nobody approved is how an unapproved SAM ends up priced.
//
// ── CHUNK 5A: WHAT AN OPERATION REQUIRES TO BE RUN ──────────────────────────
// Machine types, attachments, and operators or helpers at a skill and grade.
// REQUIREMENTS, not allocations: this record says "this operation needs one
// single-needle lockstitch, a right-side binder and one operator at grade B",
// and it never says which machine, which binder or which person. Availability,
// assignment, shortage and capacity are other departments' answers to other
// questions, and none of them is stored here.
//
// ── WHY SNAPSHOTS AND NOT FOREIGN KEYS ──────────────────────────────────────
// The audit for this chunk looked for a canonical master to point at and found
// none that is safe to store:
//
//   · `MachineType` is a GLOBAL name-unique list with no company, so a
//     reference from a company-scoped record would cross the tenant boundary
//     the whole department is built on;
//   · `Machine` is a physical asset — serial number, location, maintenance
//     dates — which is exactly what a requirement must NOT name;
//   · there is no Skill, Grade or Designation master anywhere in the codebase;
//     `designation` exists only as free text on employee and payroll records.
//
// So the requirement rows hold normalised SNAPSHOT text. When Maintenance and
// HR publish company-scoped masters — the IE plan has them supplying machine
// availability and anonymised skill counts — a later chunk can add an id
// beside the snapshot without rewriting what was recorded here. Inventing a
// cross-department master in this slice would have made IE the owner of two
// other departments' vocabularies.
//
// ── AND NO SALARY ───────────────────────────────────────────────────────────
// The legacy register carries `salaryDept`/`salaryDesig`, which is how a
// costing resolves what a minute costs. Section 5.1 of the IE plan lists that
// coupling as defect 9: IE owns the TIME, payroll owns the money. This master
// therefore holds no salary field of any kind, and no route here reads one.
"use strict";

const mongoose = require("mongoose");

/** Explicit lifecycle. Retirement replaces deletion; nothing is ever removed. */
const STATUSES = ["ACTIVE", "RETIRED"];

/* ── LIMITS, STATED ONCE ──────────────────────────────────────────────────
   Shared with the service so a refusal quotes the same number the schema
   enforces — a form told "too long" without the limit cannot be fixed. */
const LIMITS = Object.freeze({
  CODE: 40,
  NAME: 200,
  MACHINE_TYPE: 60,
  ALIAS: 120,
  ALIASES: 20,
  /* Chunk 5A. Caps rather than open arrays: an operation needing thirty
     different machine types is a data-entry accident, and an unbounded array on
     a record every bulletin reads is how a collection becomes unreadable. */
  MACHINE_REQUIREMENTS: 20,
  ATTACHMENT_REQUIREMENTS: 30,
  LABOUR_REQUIREMENTS: 20,
  QUANTITY: 999,
  GRADE: 40,
  REQUIREMENT_NOTE: 500,
  SUMMARY: 300,
  HISTORY: 200,
});

/** Who does the work — the two roles a garment operation is staffed with. */
const WORKER_TYPES = ["OPERATOR", "HELPER"];

/** The audit vocabulary this record keeps. */
const EVENT_TYPES = ["OPERATION_REQUIREMENTS_UPDATED"];

/**
 * The uniqueness form of a code.
 *
 * Case-folded and internal whitespace collapsed, so "sew 01" and "SEW  01" are
 * one code. Separators are NOT stripped: `SEW-01` and `SEW01` are different
 * codes in every register this factory already keeps, and quietly merging them
 * would make one of them unreachable.
 *
 * Exported because the service, the index and any later importer must agree —
 * two normalisers is how a unique index starts admitting duplicates.
 */
function normaliseCode(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

/** The display form: same collapsing, original case kept. */
function displayCode(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

/* ── ONE MACHINE-TYPE REQUIREMENT ────────────────────────────────────────
   A TYPE and a count. Not a machine: "one single-needle lockstitch" is an
   engineering requirement that stays true when the factory replaces the
   machine, and "machine SN-4471" is a maintenance record that does not. */
const machineRequirementSchema = new mongoose.Schema(
  {
    requirementId: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, min: 1 },
    machineType: { type: String, required: true, trim: true, maxlength: LIMITS.MACHINE_TYPE },
    quantity: { type: Number, required: true, min: 1, max: LIMITS.QUANTITY },
  },
  { _id: false },
);

/** One attachment — folder, binder, guide, gauge — by code and name. */
const attachmentRequirementSchema = new mongoose.Schema(
  {
    requirementId: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, min: 1 },
    code: { type: String, required: true, trim: true, maxlength: LIMITS.CODE },
    name: { type: String, required: true, trim: true, maxlength: LIMITS.NAME },
    quantity: { type: Number, required: true, min: 1, max: LIMITS.QUANTITY },
    note: { type: String, trim: true, default: "", maxlength: LIMITS.REQUIREMENT_NOTE },
  },
  { _id: false },
);

/* ── ONE LABOUR REQUIREMENT ──────────────────────────────────────────────
   A ROLE, a count, and the skill and grade that role has to hold. There is no
   employee id and no name here, and there is no field one could be put in:
   IE states what the work needs, and who does it on a given day is HR's and
   Production's to decide. `skillCode`/`skillName`/`grade` are snapshots — see
   the header for why they are not foreign keys. */
const labourRequirementSchema = new mongoose.Schema(
  {
    requirementId: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, min: 1 },
    workerType: { type: String, enum: WORKER_TYPES, required: true },
    quantity: { type: Number, required: true, min: 1, max: LIMITS.QUANTITY },
    skillCode: { type: String, trim: true, default: "", maxlength: LIMITS.CODE },
    skillName: { type: String, trim: true, default: "", maxlength: LIMITS.NAME },
    grade: { type: String, trim: true, default: "", maxlength: LIMITS.GRADE },
    note: { type: String, trim: true, default: "", maxlength: LIMITS.REQUIREMENT_NOTE },
  },
  { _id: false },
);

/** A bounded audit line. Never a copy of the requirement rows. */
const operationEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    type: { type: String, enum: EVENT_TYPES, required: true },
    at: { type: Date, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorName: { type: String, trim: true, default: "" },
    operationRevision: { type: Number, required: true, min: 1 },
    /* WHICH GROUPS moved — "machine", "attachment", "labour" — not their
       contents. The rows are on the record; the history says who touched what
       kind of thing, and when. */
    changed: { type: [{ type: String, trim: true }], default: () => [] },
    summary: { type: String, trim: true, default: "", maxlength: LIMITS.SUMMARY },
  },
  { _id: false },
);

const ieOperationSchema = new mongoose.Schema(
  {
    /* Ownership, from the resolved session context only — never from a body,
       a query or the record being edited. */
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
      index: true,
    },

    /* What a person reads and quotes on paper. */
    code: { type: String, required: true, trim: true, maxlength: LIMITS.CODE },
    /* What uniqueness is decided on. Derived, never accepted from a caller. */
    codeNormalised: { type: String, required: true },

    name: { type: String, required: true, trim: true, maxlength: LIMITS.NAME },

    /* Optional on purpose: pressing, inspection, marking and hand finishing are
       real operations with no machine, and a required field would be filled
       with "MANUAL" or "NA" until it meant nothing. */
    machineType: { type: String, trim: true, default: "", maxlength: LIMITS.MACHINE_TYPE },

    /* ── ALIASES ARE SEARCH TERMS, NOT SECOND CODES ─────────────────────────
       The floor calls one operation four things, and an importer will meet all
       four. Aliases let a search and a later import FIND this row; they are not
       identity. There is deliberately NO unique index on them: making an alias
       unique would turn a typo in a synonym into a hard refusal on an unrelated
       operation, and would give one operation several codes — which is the
       ambiguity the legacy register is being replaced to end. Section 5.1 of
       the IE plan lists aliases beside the code, and names only the CODE as
       unique. */
    aliases: {
      type: [{ type: String, trim: true, maxlength: LIMITS.ALIAS }],
      default: () => [],
    },

    status: { type: String, enum: STATUSES, default: "ACTIVE", required: true },
    statusChangedAt: { type: Date, default: null },
    statusChangedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    statusChangedByName: { type: String, trim: true, default: "" },

    /* ── OPTIMISTIC CONCURRENCY ────────────────────────────────────────────
       Incremented by every accepted mutation, lifecycle included. A caller
       sends the revision they composed against; a mismatch is refused rather
       than merged, because two engineers editing one standard from two screens
       is not a merge that can be done safely without asking. */
    revision: { type: Number, default: 1, min: 1 },

    /* ── THE RESOURCE-REQUIREMENT PROFILE (Chunk 5A) ──────────────────────
       `configured` is STORED rather than derived from emptiness, because three
       empty arrays mean two different things: nobody has said yet, and somebody
       has said "none required". A screen that cannot tell those apart shows a
       finished profile for an operation nobody has looked at. It is set the
       first time a profile is accepted and never goes back to false. */
    requirements: {
      configured: { type: Boolean, default: false },
      machine: { type: [machineRequirementSchema], default: () => [] },
      attachment: { type: [attachmentRequirementSchema], default: () => [] },
      labour: { type: [labourRequirementSchema], default: () => [] },
    },

    history: { type: [operationEventSchema], default: () => [] },

    createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdByName: { type: String, trim: true, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    updatedByName: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "ie_operations" },
);

/* Derived in the schema as well as the service, so a code written by a future
   importer, a script or a test fixture cannot escape the uniqueness rule by
   skipping the service.
   On `validate` rather than `save`: mongoose registers validation as its own
   first pre-save hook, so a `pre("save")` here would run AFTER the required
   check on the field it exists to fill. */
ieOperationSchema.pre("validate", function setNormalisedCode(next) {
  this.code = displayCode(this.code);
  this.codeNormalised = normaliseCode(this.code);
  next();
});

/* ── UNIQUE ACTIVE CODE PER COMPANY, ENFORCED BY THE DATABASE ───────────────
 * Partial, on `status: "ACTIVE"`, which is the rule stated three ways at once:
 *
 *   · two ACTIVE operations in one company cannot share a code — and because
 *     it is an index, two simultaneous creates cannot both win the race, which
 *     a service pre-check alone can never prevent;
 *   · two companies may each hold `SEW-01`, independently;
 *   · a RETIRED row keeps its code and is not counted, so the code becomes
 *     available again for reuse — see the code-reuse decision in the service.
 *
 * Restoring a retired row therefore has to pass this index too: if somebody
 * else has taken the code in the meantime, the restore is refused by the
 * database rather than by hope.
 */
ieOperationSchema.index(
  { companyId: 1, codeNormalised: 1 },
  {
    unique: true,
    name: "ie_operation_active_code_per_company",
    partialFilterExpression: { status: "ACTIVE" },
  },
);

/* The register's own listing order: a company's operations by name. */
ieOperationSchema.index({ companyId: 1, status: 1, name: 1, _id: 1 });

module.exports = mongoose.models.IeOperation
  || mongoose.model("IeOperation", ieOperationSchema);
module.exports.STATUSES = STATUSES;
module.exports.WORKER_TYPES = WORKER_TYPES;
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.LIMITS = LIMITS;
module.exports.normaliseCode = normaliseCode;
module.exports.displayCode = displayCode;
