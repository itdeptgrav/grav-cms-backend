// models/Cms_Models/HistoryReport/Vendor.js

const mongoose = require("mongoose");

const vendorSchema = new mongoose.Schema({
  // Basic Information
  companyName: {
    type: String,
    required: true,
    trim: true
  },
  vendorType: {
    type: String,
    default: "Raw Material Supplier"
  },
  
  // Contact Information
  contactPerson: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true
  },
  phone: {
    type: String,
    trim: true
  },
  alternatePhone: {
    type: String,
    trim: true
  },
  
  // Address Information
  address: {
    street: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    country: { type: String, trim: true, default: "India" }
  },
  
  // Business Information
  gstNumber: {
    type: String,
    trim: true,
    uppercase: true
  },
  panNumber: {
    type: String,
    trim: true,
    uppercase: true
  },
  
  // Product/Service Details
  primaryProducts: [{
    type: String,
    trim: true
  }],
  
  // Bank Details
  bankDetails: {
    accountName: { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    bankName: { type: String, trim: true },
    ifscCode: { type: String, trim: true, uppercase: true },
    branch: { type: String, trim: true }
  },
  
  // Status and Additional Info
  status: {
    type: String,
    /* Additive: "Archived" is new. Nothing that was storable before stops
       being storable, because Accounting reads these same records. */
    enum: ["Active", "Inactive", "Blacklisted", "Archived"],
    default: "Active"
  },
  /* ── A RATING NOBODY GAVE IS NOT A RATING ─────────────────────────────────
   * This defaulted to 3, and the form pre-filled it, so most stored ratings
   * were the application's invention rather than anybody's assessment — and
   * the supplier screen presented all of them alike. There is no default now:
   * absent means nobody has assessed this supplier.
   *
   * Records carrying a rating with no recorded author predate this and cannot
   * be told apart from the old default, so their provenance is unknown and
   * they are labelled as such rather than attributed to a person. */
  rating: {
    type: Number,
    min: 1,
    max: 5,
    default: null,
  },
  ratingRecordedBy:     { type: mongoose.Schema.Types.ObjectId, default: null },
  ratingRecordedByName: { type: String, default: "" },
  ratingRecordedAt:     { type: Date, default: null },
  ratingReason:         { type: String, trim: true, default: "" },
  notes: {
    type: String,
    trim: true
  },

  isVerified:             { type: Boolean, default: false },
  verifiedAt:             { type: Date, default: null },
  verifiedBy:             { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
  verifiedByName:         { type: String, default: null },
  verificationSignature:  { type: String, default: null }, // typed full name / drawn data-URI
  
  /* ── OWNERSHIP ────────────────────────────────────────────────────────────
   * Added, not backfilled. Every supplier that existed before this field did
   * has `companyId: null` and stays that way: a supplier two companies both
   * traded with cannot be assigned to one of them by a script that cannot know
   * which. Those records are legacy — readable through the explicit legacy
   * contract, never writable — until a migration with a human decision behind
   * it says whose they are.
   *
   * Server-owned. Both fields come from the resolved session context and are
   * never read from a request body. */
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", default: null, index: true },
  siteId:    { type: mongoose.Schema.Types.ObjectId, default: null },

  /* A code people use on paper and in conversation. Unique inside a company;
     two companies may each have their own "SUP-1". */
  supplierCode: { type: String, trim: true, uppercase: true, default: "" },

  /* ── NORMALISED IDENTITY KEYS ─────────────────────────────────────────────
   * Duplicate detection has to compare identities, not spellings: "29abcde…"
   * and "29ABCDE…" are one GSTIN, and a unique index over the raw field would
   * let both be stored. These are derived on save from the fields above and
   * are what the company-scoped unique indexes are built on. */
  gstNormalised:   { type: String, default: "" },
  panNormalised:   { type: String, default: "" },
  emailNormalised: { type: String, default: "" },

  /* ── LIFECYCLE METADATA ───────────────────────────────────────────────────
   * Who did it, when, and why — recorded where the state is, so a blacklisted
   * supplier can always answer "on what grounds". All server-set. */
  blacklist: {
    at:     { type: Date, default: null },
    by:     { type: mongoose.Schema.Types.ObjectId, default: null },
    byName: { type: String, default: "" },
    reason: { type: String, trim: true, default: "" },
  },
  archive: {
    at:     { type: Date, default: null },
    by:     { type: mongoose.Schema.Types.ObjectId, default: null },
    byName: { type: String, default: "" },
    reason: { type: String, trim: true, default: "" },
  },

  /* ── A RECOVERY MARKER, NOT THE AUDIT TRAIL ───────────────────────────────
   * This was described as the immutable lifecycle history. It is not: it is a
   * mutable array inside a document that ordinary saves rewrite, and nothing
   * stops a later write replacing it wholesale. The authoritative audit stream
   * is `SpActionHistory`, written through `actionHistory.service.js` — tenant
   * scoped, append-only, actor-attributed, and outside this document.
   *
   * What stays here is the idempotency effect marker: the operation id of a
   * lifecycle change that landed, so a retry can recognise its own effect
   * instead of repeating it. That is a recovery aid, and it is the only thing
   * this array is read for. Existing rows are left in place. */
  lifecycleHistory: [{
    at:          { type: Date, default: Date.now },
    by:          { type: mongoose.Schema.Types.ObjectId, default: null },
    byName:      { type: String, default: "" },
    action:      { type: String, default: "" },
    fromState:   { type: String, default: "" },
    toState:     { type: String, default: "" },
    reason:      { type: String, trim: true, default: "" },
    /* The idempotency record that produced it, so a retry can recognise its
       own effect instead of appending a second identical line. */
    operationId: { type: mongoose.Schema.Types.ObjectId, default: null },
  }],

  /* ── OPTIMISTIC CONCURRENCY ─────────────────────────────────────────────
   * Two people editing one supplier from two screens both read, both decided,
   * and the later save silently replaced the earlier — with no trace that a
   * decision had been overwritten. Every governed write states the version it
   * was decided against, and the write only lands if that is still current.
   *
   * Additive: existing records read as 0, and `__v` is left alone — Mongoose
   * bumps that on array operations for reasons unrelated to business intent,
   * which would make it a misleading thing to condition a decision on. */
  recordVersion: { type: Number, default: 0 },

  /* Where a record came from, for the migration that has not run. */
  legacySource: { type: String, default: "" },
  migratedAt:   { type: Date, default: null },

  // Audit Fields
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProjectManager",
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProjectManager"
  }
}, { timestamps: true });


/**
 * Normalised keys are derived here, never accepted from a caller.
 *
 * `Vendor.updateOne` and friends bypass this hook, which is why every write in
 * the Supplier Master router goes through a document save.
 */
vendorSchema.pre("save", function (next) {
  const squash = (v) => String(v || "").replace(/\s+/g, "").toUpperCase();
  this.gstNormalised = squash(this.gstNumber);
  this.panNormalised = squash(this.panNumber);
  this.emailNormalised = String(this.email || "").trim().toLowerCase();
  next();
});

/* ── COMPANY-SCOPED UNIQUENESS ──────────────────────────────────────────────
 * Partial, so the rules apply only where there is an identity to compare:
 *   - a supplier with no code is not a duplicate of every other codeless one;
 *   - a blank GSTIN is an absence, and absences do not collide;
 *   - legacy records (companyId null, no code, no normalised GSTIN) fall
 *     outside both indexes and are left exactly as they are.
 *
 * Mongoose never DROPS an index it stops declaring, so nothing here removes
 * an existing one. The reviewable migration script is what creates these
 * against a real database, and it has not been run. */
/* ── IDENTICAL TO THE MIGRATION, INCLUDING THE NAME ─────────────────────────
 * These filtered on the identity alone while the migration also required
 * `companyId: {$type: "objectId"}`. Two different definitions under the same
 * generated name is an index-options conflict: whichever ran first wins, and
 * the comments above — which say legacy records fall outside these indexes —
 * were false for the schema's version. The names are stated explicitly so the
 * migration can verify the definition rather than trust a generated string. */
vendorSchema.index(
  { companyId: 1, supplierCode: 1 },
  {
    name: "companyId_1_supplierCode_1",
    unique: true,
    partialFilterExpression: {
      companyId: { $type: "objectId" },
      supplierCode: { $gt: "" },
    },
  },
);
vendorSchema.index(
  { companyId: 1, gstNormalised: 1 },
  {
    name: "companyId_1_gstNormalised_1",
    unique: true,
    partialFilterExpression: {
      companyId: { $type: "objectId" },
      gstNormalised: { $gt: "" },
    },
  },
);
/* The register's ordinary reads: this company, by status, newest first. */
vendorSchema.index({ companyId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("Vendor", vendorSchema);