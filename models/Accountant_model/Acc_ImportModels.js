// models/Accountant_model/Acc_ImportModels.js
// =============================================================================
// TALLY IMPORT INFRASTRUCTURE
// -----------------------------------------------------------------------------
// Two models:
//   1. Acc_FieldMapping — saved column→field mapping templates (mirrors
//      Tally's own .tsf "mapping templates"). Lets the user re-import the
//      same Excel format next month without re-mapping everything.
//   2. Acc_ImportSession — one row per import attempt; holds the raw upload,
//      the parsed preview, validation errors, the per-row commit status, and
//      the option to roll back the whole batch if anything went wrong.
// =============================================================================

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// 1. FIELD MAPPING TEMPLATE
// ─────────────────────────────────────────────────────────────────────────────
const fieldMappingSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true }, // user-given e.g. "Tally Daybook v1"
    description: { type: String, trim: true },

    // Which entity does this template map?
    entityType: {
      type: String,
      enum: ["ledger", "stock_item", "voucher_sales", "voucher_purchase", "voucher_payment",
             "voucher_receipt", "voucher_journal", "voucher_contra", "voucher_credit_note",
             "voucher_debit_note", "stock_group", "group", "cost_centre", "unit"],
      required: true,
      index: true,
    },

    // The file shape the user typically uploads
    fileShape: {
      hasHeaders:      { type: Boolean, default: true },
      headerRow:       { type: Number, default: 1 },     // 1-indexed
      dataStartRow:    { type: Number, default: 2 },
      sheetName:       { type: String, trim: true },     // for Excel; null = first sheet
      delimiter:       { type: String, default: "," },   // for CSV
      dateFormat:      { type: String, default: "DD-MM-YYYY" },
      decimalSeparator:{ type: String, default: "." },
      thousandSeparator:{type: String, default: "," },
    },

    // Column → field mapping. We store the SOURCE column name (or index
    // if no headers) and the TARGET model field path.
    mappings: [
      {
        sourceColumn: { type: String, required: true, trim: true }, // "Voucher Date"
        sourceIndex:  { type: Number },                              // optional 0-based index
        targetField:  { type: String, required: true, trim: true },  // "voucherDate"
        dataType:     {
          type: String,
          enum: ["string", "number", "date", "boolean", "currency", "ledger_ref", "stock_ref", "dr_cr"],
          default: "string",
        },
        required:     { type: Boolean, default: false },
        defaultValue: { type: mongoose.Schema.Types.Mixed },

        // Lightweight transform DSL (executed in services/tallyTransforms.js)
        transform: {
          type: String,
          enum: ["none", "uppercase", "lowercase", "trim", "split_first", "split_last",
                 "abs", "negate", "parse_indian_currency", "parse_dr_cr_suffix"],
          default: "none",
        },
      },
    ],

    // Multi-row voucher rules (Tally's "Ledger Details from Multiple Rows")
    multiRowRule: {
      enabled:       { type: Boolean, default: false },
      groupByColumn: { type: String, trim: true },  // e.g. "Voucher Number"
      // When true, rows with the same value in `groupByColumn` are merged into
      // a single voucher; each row becomes one ledger entry.
    },

    // Auto-creation policy: if the import references a ledger that doesn't
    // exist yet, should we create it on the fly?
    autoCreate: {
      ledgers:    { type: Boolean, default: true },
      stockItems: { type: Boolean, default: false },
      groups:     { type: Boolean, default: false },
    },
    // Default group for auto-created ledgers — Tally requires every ledger
    // belong to a group, so we need a fallback.
    defaultLedgerGroup: { type: String, default: "Sundry Debtors" },

    isActive:      { type: Boolean, default: true },
    timesUsed:     { type: Number, default: 0 },
    lastUsedAt:    { type: Date },
    createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
    companyId:     { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company" }, // null = global template
  },
  { timestamps: true, collection: "acc_field_mappings" }
);

fieldMappingSchema.index({ entityType: 1, isActive: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// 2. IMPORT SESSION — one per upload attempt
// ─────────────────────────────────────────────────────────────────────────────
const importRowSchema = new mongoose.Schema(
  {
    rowNumber: { type: Number, required: true }, // source row in the file
    rawData:   { type: mongoose.Schema.Types.Mixed }, // original parsed row
    status: {
      type: String,
      enum: ["pending", "valid", "invalid", "imported", "skipped", "duplicate", "error"],
      default: "pending",
    },
    errors:   [{ field: String, message: String }],
    warnings: [{ field: String, message: String }],

    // What got created from this row
    createdEntity: {
      type:        { type: String }, // "ledger", "voucher", etc.
      collection:  { type: String },
      objectId:    { type: mongoose.Schema.Types.ObjectId },
      identifier:  { type: String }, // human-readable e.g. voucher number
    },
  },
  { _id: true }
);

const tallyImportSessionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },

    // Upload metadata
    fileName:    { type: String, required: true },
    fileType:    { type: String, enum: ["xlsx", "xls", "csv", "xml", "json"], required: true },
    fileSize:    { type: Number },                        // bytes
    fileUrl:     { type: String },                        // Cloudinary / S3 — if persisted
    fileChecksum:{ type: String },                        // SHA-256 — duplicate-upload guard

    importType: {
      type: String,
      enum: ["masters", "transactions", "ledgers_only", "stock_items_only",
             "vouchers_only", "full_company", "day_book"],
      required: true,
    },
    entityType: {
      type: String,
      enum: ["ledger", "stock_item", "voucher_sales", "voucher_purchase",
             "voucher_payment", "voucher_receipt", "voucher_journal",
             "voucher_contra", "voucher_credit_note", "voucher_debit_note",
             "stock_group", "group", "cost_centre", "unit", "mixed"],
      required: true,
    },

    // Mapping used (saved or one-off)
    fieldMappingId:   { type: mongoose.Schema.Types.ObjectId, ref: "Acc_FieldMapping" },
    fieldMappingSnapshot: { type: mongoose.Schema.Types.Mixed }, // copy of the mapping at time of import

    // ── Lifecycle ───────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["uploaded", "parsing", "parsed", "mapping", "previewing",
             "validating", "validated", "importing", "completed",
             "completed_with_errors", "failed", "cancelled", "rolled_back"],
      default: "uploaded",
      index: true,
    },

    // Parse phase
    detectedColumns:   [{ type: String }], // header row
    detectedSheetNames:[{ type: String }], // for Excel
    activeSheetName:   { type: String },
    totalRows:         { type: Number, default: 0 },
    sampleRows:        { type: mongoose.Schema.Types.Mixed }, // first ~10 rows for preview

    // Per-row tracking — kept compact (only failed rows fully detailed)
    rows: { type: [importRowSchema], default: [] },

    // Aggregates
    summary: {
      total:    { type: Number, default: 0 },
      valid:    { type: Number, default: 0 },
      invalid:  { type: Number, default: 0 },
      imported: { type: Number, default: 0 },
      skipped:  { type: Number, default: 0 },
      duplicates:{ type: Number, default: 0 },
      errors:   { type: Number, default: 0 },
    },

    // Created entity counts (for quick UI summary)
    createdCounts: {
      ledgers:     { type: Number, default: 0 },
      groups:      { type: Number, default: 0 },
      stockItems:  { type: Number, default: 0 },
      vouchers:    { type: Number, default: 0 },
      costCentres: { type: Number, default: 0 },
    },

    // Auto-link to existing CMS entities by name match
    linkedToCMS: {
      customersLinked: { type: Number, default: 0 },
      vendorsLinked:   { type: Number, default: 0 },
      employeesLinked: { type: Number, default: 0 },
    },

    // Warnings / errors at the session level (not row-specific)
    sessionWarnings: [{ type: String }],
    sessionErrors:   [{ type: String }],

    // Rollback support — store enough to delete created docs if user rolls back
    rollbackTokens: [
      {
        collection: { type: String },
        objectId:   { type: mongoose.Schema.Types.ObjectId },
      },
    ],

    // Timing
    startedAt:    { type: Date, default: Date.now },
    parsedAt:     { type: Date },
    validatedAt:  { type: Date },
    importedAt:   { type: Date },
    completedAt:  { type: Date },
    rolledBackAt: { type: Date },

    // Notes
    notes: { type: String, trim: true },

    initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
  },
  { timestamps: true, collection: "acc_import_sessions" }
);

tallyImportSessionSchema.index({ companyId: 1, createdAt: -1 });
tallyImportSessionSchema.index({ status: 1 });
tallyImportSessionSchema.index({ entityType: 1 });

// Helper: progress percentage for the UI poll
tallyImportSessionSchema.virtual("progress").get(function () {
  if (this.summary.total === 0) return 0;
  return Math.min(100, Math.round((this.summary.imported / this.summary.total) * 100));
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
const Acc_FieldMapping   = mongoose.model("Acc_FieldMapping",   fieldMappingSchema);
const Acc_ImportSession  = mongoose.model("Acc_ImportSession",  tallyImportSessionSchema);

module.exports = {
  Acc_FieldMapping,
  Acc_ImportSession,
};
