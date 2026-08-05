"use strict";
/**
 * models/HR_Models/EmployeeDocument.js
 * ───────────────────────────────────────────────────────────────────────────
 * HR-ISSUED LETTERS, BEHIND A RELEASE GATE.
 *
 * One row = one document instance, for one employee, of one type. A row may
 * exist before its file does — that is exactly what an unfulfilled employee
 * request is.
 *
 * THE WHOLE POINT OF THIS MODEL is that two states are INDEPENDENT booleans,
 * never one enum:
 *
 *     generated : the file exists on the HR side
 *     released  : the employee may see it
 *
 * HR can generate an appointment letter and sit on it for a month. Until
 * `released` flips, that row must be unreachable from every employee-facing
 * route — not in a list, not by guessing an _id. Collapsing these two into a
 * single status field silently deletes the feature.
 *
 * A third, ORTHOGONAL axis tracks the employee's ask:
 *
 *     requestStatus : none | requested | fulfilled | declined | cancelled
 *
 * `revoked` is deliberately NOT a stored boolean. A row is revoked iff
 * `released === false && revokedAt != null`. Releasing clears the revoke trio.
 * There is exactly one truth for visibility, and it is `released`.
 *
 * The employee never receives the raw booleans — see `employeeStatus()` /
 * `employeeStatusOf()` below, which is the ONE place a row becomes a state
 * word the app's StatusTag can key on.
 *
 * Collection: employee_documents
 */

const mongoose = require("mongoose");

const DOC_TYPES = [
  "appointment", // Appointment letter
  "offer", // Offer letter
  "warning", // Warning letter          ← HR-ONLY, not requestable
  "experience", // Experience letter
  "relieving", // Relieving letter
  "salary_certificate", // Salary certificate
  "other", // Other  (requires otherTypeLabel)
];

// What an employee may ASK for in the app. Two exclusions, for different
// reasons — and neither removes the type from DOC_TYPES, because HR can still
// issue both and rows of both kinds already exist:
//
//   warning            nobody asks HR to warn them. Allowing it turns the
//                      queue into a joke and the enum into a bug.
//   salary_certificate the app already ships payslips, which carry the same
//                      figures with more detail and need no approval. Offering
//                      a second, slower route to the same number just creates
//                      a request queue for something already downloadable.
const HR_ONLY_TYPES = ["warning", "salary_certificate"];
const EMPLOYEE_REQUESTABLE = DOC_TYPES.filter((t) => !HR_ONLY_TYPES.includes(t));

const TYPE_LABEL = {
  appointment: "Appointment letter",
  offer: "Offer letter",
  warning: "Warning letter",
  experience: "Experience letter",
  relieving: "Relieving letter",
  salary_certificate: "Salary certificate",
  other: "Other",
};

const REQUEST_STATUSES = [
  "none",
  "requested",
  "fulfilled",
  "declined",
  "cancelled",
];

const HISTORY_ACTIONS = [
  "requested",
  "generated",
  "file_replaced",
  "released",
  "revoked",
  "declined",
  "cancelled",
];

const historyEntrySchema = new mongoose.Schema(
  {
    action: { type: String, enum: HISTORY_ACTIONS, required: true },
    at: { type: Date, default: Date.now },
    byId: { type: mongoose.Schema.Types.ObjectId }, // Employee _id or HRDepartment _id
    byName: { type: String, default: "" },
    byRole: { type: String, enum: ["employee", "hr"], required: true },
    note: { type: String, default: "" },
  },
  { _id: false },
);

const employeeDocumentSchema = new mongoose.Schema(
  {
    // ── SUBJECT ──────────────────────────────────────────────────────────
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },
    // Denormalised at write time, exactly as RegularizationRequest does, so the
    // HR queue renders without an N+1 populate and an audit row survives an
    // employee rename.
    biometricId: { type: String, default: "", uppercase: true, trim: true },
    employeeName: { type: String, default: "" },
    department: { type: String, default: "" },
    designation: { type: String, default: "" },

    // ── WHAT ─────────────────────────────────────────────────────────────
    type: { type: String, enum: DOC_TYPES, required: true, index: true },
    // Required when type === "other". Free text, HR- or employee-supplied.
    otherTypeLabel: { type: String, default: "", trim: true, maxlength: 120 },
    // HR-editable display title. Defaults to TYPE_LABEL[type] on create.
    title: { type: String, default: "", trim: true, maxlength: 160 },

    // ── REQUEST STATE (the employee's ask) ───────────────────────────────
    requestStatus: {
      type: String,
      enum: REQUEST_STATUSES,
      default: "none",
      index: true,
    },
    requestedAt: { type: Date, default: null },
    requestReason: { type: String, default: "", trim: true, maxlength: 500 },
    cancelledAt: { type: Date, default: null },
    declinedAt: { type: Date, default: null },
    declinedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRDepartment",
      default: null,
    },
    declinedByName: { type: String, default: "" },
    // Shown to the employee. Write it as a sentence they can act on.
    declineReason: { type: String, default: "", trim: true, maxlength: 500 },

    // ── GENERATED STATE (exists on the HR side) ──────────────────────────
    generated: { type: Boolean, default: false, index: true },
    generatedAt: { type: Date, default: null },
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRDepartment",
      default: null,
    },
    generatedByName: { type: String, default: "" },

    // NEVER projected to an employee unless `released === true`.
    //
    // Storage: Cloudinary `raw`, uploaded by the BACKEND from a multer memory
    // buffer — never by the browser, or a client could inject an arbitrary URL
    // into an employee-visible record. `resource_type` is "raw", not "auto":
    // `auto` classifies a PDF as `image`, which Cloudinary's default PDF
    // delivery restriction then blocks.
    //
    // ACCEPTED LIMITATION: a Cloudinary secure_url is public and permanent.
    // The release gate is therefore a DISCOVERY gate — an unreleased
    // document's URL appears in no employee-facing response, and a revoked
    // document's URL disappears again, but anyone who already captured the URL
    // keeps it. Making revocation cryptographically real needs the
    // Drive-stream pattern (services/mediaUpload.service.js →
    // getDriveFileStream) and is out of scope for v1. Do not silently switch
    // providers.
    file: {
      // ── Where the bytes actually live ────────────────────────────────────
      // "drive" is the only thing written now: the letter goes to a PRIVATE
      // Google Drive folder and is streamed back through our own route, so
      // withdrawing a letter genuinely withdraws it.
      //
      // "cloudinary" exists for rows written before that change. Those carry a
      // PUBLIC, PERMANENT secure_url in `url`, which is exactly the weakness
      // the move to Drive fixes — anyone who once held the link keeps it. Read
      // paths must handle both; write paths must only ever produce "drive".
      storage: {
        type: String,
        enum: ["drive", "cloudinary"],
        default: "drive",
      },
      driveFileId: { type: String, default: "" }, // storage === "drive"
      url: { type: String, default: "" }, // legacy Cloudinary secure_url only
      publicId: { type: String, default: "" }, // legacy Cloudinary public_id
      fileName: { type: String, default: "" }, // e.g. "Appointment letter - GR0067.pdf"
      mimeType: { type: String, default: "application/pdf" },
      bytes: { type: Number, default: 0 },
      resourceType: { type: String, default: "raw" },
    },

    // Merge fields the Employee model does not carry. Employee has NO
    // lastWorkingDay / resignationDate / noticePeriod. They are captured here
    // at generation time rather than bolted onto Employee.
    letterMeta: {
      referenceNo: { type: String, default: "", trim: true },
      issueDate: { type: Date, default: null },
      effectiveDate: { type: Date, default: null },
      lastWorkingDay: { type: Date, default: null },
      resignationDate: { type: Date, default: null },
      noticePeriodDays: { type: Number, default: null },
      // A plain string HR typed or confirmed. Salary on Employee is AES-256-GCM
      // encrypted (utils/salaryEncryption.js) — it is decrypted ONCE, in the HR
      // prefill endpoint, and never stored back here in ciphertext form.
      annualCTC: { type: String, default: "" },
      signatoryName: { type: String, default: "" },
      signatoryDesignation: { type: String, default: "" },
      remarks: { type: String, default: "", maxlength: 1000 },

      // WHICH appointment letter was issued: "executive" (office terms) or
      // "worker" (factory terms — shift hours, overtime, a Professional Tax
      // row). The two are different contracts, so which one an employee signed
      // has to be recoverable from the record and not only from the PDF.
      //
      // Enumerated rather than free text, and empty for every other type. The
      // CMS mirror is APPOINTMENT_VARIANTS in
      // app/hr/dashboard/documents/appointmentTemplate.js — a key added there
      // and not here is silently dropped by parseLetterMeta.
      variant: {
        type: String,
        enum: ["executive", "worker", ""],
        default: "",
      },
    },

    // Internal. NEVER in any employee projection.
    hrNotes: { type: String, default: "", maxlength: 2000 },

    // ── RELEASE STATE (employee-visible) ─────────────────────────────────
    released: { type: Boolean, default: false, index: true },
    releasedAt: { type: Date, default: null },
    releasedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRDepartment",
      default: null,
    },
    releasedByName: { type: String, default: "" },
    // Increments on every release, including a re-release after a revoke.
    releaseCount: { type: Number, default: 0 },

    revokedAt: { type: Date, default: null },
    revokedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRDepartment",
      default: null,
    },
    revokedByName: { type: String, default: "" },
    revokeReason: { type: String, default: "", trim: true, maxlength: 500 },

    // ── AUDIT ────────────────────────────────────────────────────────────
    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true },
);

/**
 * The one place a row becomes an employee-facing state word.
 *
 * ORDER IS LOAD-BEARING: release beats everything, then withdrawal, then the
 * request's own state.
 *
 * Wire values, fixed forever, byte-identical in all three repos:
 *     available | withdrawn | requested | declined | cancelled
 * Renaming one later is a migration plus a synchronised three-repo deploy in
 * which every missed predicate fails silently.
 */
function employeeStatusOf(row) {
  if (!row) return "requested";
  if (row.released) return "available";
  if (row.revokedAt) return "withdrawn";
  if (row.requestStatus === "requested") return "requested";
  if (row.requestStatus === "declined") return "declined";
  if (row.requestStatus === "cancelled") return "cancelled";
  // generated-but-never-released with no request: this row must never have
  // been in an employee response at all. Reaching here is a bug.
  return "requested";
}

/** Instance-method twin of employeeStatusOf, for hydrated documents. */
employeeDocumentSchema.methods.employeeStatus = function () {
  return employeeStatusOf(this);
};

// ── INDEXES ─────────────────────────────────────────────────────────────────

// The employee list.
employeeDocumentSchema.index({ employeeId: 1, released: 1, createdAt: -1 });

// The request-adoption lookup and the HR per-employee library.
employeeDocumentSchema.index({ employeeId: 1, type: 1, released: 1 });

// The HR request queue, sorted newest first.
employeeDocumentSchema.index({ requestStatus: 1, createdAt: -1 });

// The HR library filters — the generated/released cross-tab.
employeeDocumentSchema.index({ generated: 1, released: 1, createdAt: -1 });

// ONE open request per (employee, type). Partial so the index only covers open
// asks — a fulfilled row must not block the next request for the same type (a
// second salary certificate a year later is legitimate).
//
// NOTE: for type "other" this caps an employee at one open "other" request
// regardless of otherTypeLabel. That is intended.
//
// This is the belt-and-braces half of the duplicate check: the app validates,
// the handler checks, and the database refuses with 11000.
employeeDocumentSchema.index(
  { employeeId: 1, type: 1 },
  { unique: true, partialFilterExpression: { requestStatus: "requested" } },
);

module.exports =
  mongoose.models.EmployeeDocument ||
  mongoose.model("EmployeeDocument", employeeDocumentSchema, "employee_documents");

module.exports.DOC_TYPES = DOC_TYPES;
module.exports.EMPLOYEE_REQUESTABLE = EMPLOYEE_REQUESTABLE;
module.exports.TYPE_LABEL = TYPE_LABEL;
module.exports.REQUEST_STATUSES = REQUEST_STATUSES;
module.exports.HISTORY_ACTIONS = HISTORY_ACTIONS;
module.exports.employeeStatusOf = employeeStatusOf;
