// models/CMS_Models/Sales/Account.js
//
// CRMAccount — the core organization record for the whole CRM. One account can
// carry MANY business roles (a company may be both a brand and a direct
// customer), so roles is an array, not a mutually-exclusive `type`. The older
// `type` field is kept for backward compatibility with the existing accounts UI
// while `roles`/`lifecycleStage` become the richer classification (Step 01).
//
// Buying house, brand, billing party and consignee are NOT stored as free text
// here — each is its own Account, connected through CRMAccountRelationship.
const mongoose = require("mongoose");
const {
  ACCOUNT_ROLE_CODES,
  ACCOUNT_STATUS_CODES,
  LIFECYCLE_STAGE_CODES,
  CUSTOMER_TIER_CODES,
  CUSTOMER_TYPE_CODES,
  GST_TREATMENT_CODES,
  FREIGHT_ARRANGEMENT_CODES,
  CREDIT_STATUS_CODES,
  BUSINESS_MODEL_CODES,
  PRODUCT_CATEGORY_CODES,
  CONSTRUCTION_TYPE_CODES,
  WEARER_CONSUMER_CATEGORY_CODES,
  ORDER_FREQUENCY_CODES,
  CUSTOMER_POTENTIAL_CODES,
  COMPLIANCE_REQUIREMENT_CODES,
  PERSONALIZATION_TYPE_CODES,
  ORDERING_MODELS,
  FULFILLMENT_MODELS,
  SIZING_MODELS,
  FREIGHT_MODES,
  ISSUE_FREQUENCIES,
  normalizeRoleList,
} = require("../../../constants/crm");
const { normalizeName } = require("../../../services/crmDuplicates");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
});

// Garment Sales Profile (spec §7.2A) — stable, account-level commercial
// indicators used by sales/merchandising. NOT a replacement for opportunity
// quantities, style specs, quotations, contracts, or wearer records (those
// stay out of this subdocument per the spec's own boundary). Nested under one
// `garmentSalesProfile` key rather than flattened onto the account so the
// four spec subsections (business/product, compliance, buying-house/brand,
// uniform) stay legible and can be validated/rendered as one unit.
const garmentSalesProfileSchema = new mongoose.Schema(
  {
    // -- Business and product profile --------------------------------------
    businessModels: { type: [String], enum: BUSINESS_MODEL_CODES, default: [] },
    productCategories: { type: [String], enum: PRODUCT_CATEGORY_CODES, default: [] },
    constructionTypes: { type: [String], enum: CONSTRUCTION_TYPE_CODES, default: [] },
    wearerOrConsumerCategories: { type: [String], enum: WEARER_CONSUMER_CATEGORY_CODES, default: [] },
    targetMarkets: { type: [String], default: [] }, // free country/region text
    estimatedAnnualPieces: { type: Number, min: 0 },
    estimatedAnnualStyles: { type: Number, min: 0 },
    typicalOrderQuantityMin: { type: Number, min: 0 },
    typicalOrderQuantityMax: { type: Number, min: 0 },
    expectedMOQ: { type: Number, min: 0 },
    targetPriceBandMin: { type: Number, min: 0 },
    targetPriceBandMax: { type: Number, min: 0 },
    targetPriceCurrency: { type: String, trim: true },
    expectedDevelopmentLeadDays: { type: Number, min: 0 },
    expectedBulkLeadDays: { type: Number, min: 0 },
    orderFrequency: { type: String, enum: ORDER_FREQUENCY_CODES },
    peakSeasons: { type: [String], default: [] },
    buyingCalendarNotes: { type: String, trim: true },
    customerPotential: { type: String, enum: CUSTOMER_POTENTIAL_CODES },

    // -- Compliance and quality profile -------------------------------------
    requiredCertifications: { type: [String], enum: COMPLIANCE_REQUIREMENT_CODES, default: [] },
    socialComplianceRequirements: { type: [String], enum: COMPLIANCE_REQUIREMENT_CODES, default: [] },
    sustainabilityRequirements: { type: [String], enum: COMPLIANCE_REQUIREMENT_CODES, default: [] },
    restrictedSubstanceRequirements: { type: [String], enum: COMPLIANCE_REQUIREMENT_CODES, default: [] },
    defaultTestingProtocol: { type: String, trim: true },
    defaultInspectionStandard: { type: String, trim: true },
    defaultAqlLevel: { type: String, trim: true },
    // `set` strips "" entries BEFORE Mongoose casts the array to ObjectId —
    // an empty multi-select can submit "" placeholders, and casting those
    // throws a BSONError long before any pre("validate") cleanup would run.
    nominatedLaboratoryAccountIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount" }],
      set: (arr) => (Array.isArray(arr) ? arr.filter((v) => v !== "") : arr),
    },
    nominatedSupplierAccountIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount" }],
      set: (arr) => (Array.isArray(arr) ? arr.filter((v) => v !== "") : arr),
    },
    qualityManualRef: { type: String, trim: true },
    complianceReminderAt: { type: Date },

    // -- Buying-house and brand profile --------------------------------------
    vendorCode: { type: String, trim: true },
    brandDivision: { type: String, trim: true },
    buyingOffice: { type: String, trim: true },
    buyingOfficeCountry: { type: String, trim: true },
    // Same "" → unset rule as above, applied per-field (an unselected party
    // picker submits "" rather than omitting the key).
    defaultPoIssuerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", set: (v) => (v === "" ? undefined : v) },
    defaultBillToAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", set: (v) => (v === "" ? undefined : v) },
    defaultImporterAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", set: (v) => (v === "" ? undefined : v) },
    defaultAgentAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", set: (v) => (v === "" ? undefined : v) },
    defaultCommissionRef: { type: String, trim: true }, // restricted — see crmVisibility
    defaultDeliveryCountry: { type: String, trim: true },
    preferredFreightMode: { type: String, enum: FREIGHT_MODES },
    buyerManualRef: { type: String, trim: true },
    packagingManualRef: { type: String, trim: true },
    routingGuideRef: { type: String, trim: true },
    seasonalCalendarNotes: { type: String, trim: true },

    // -- Uniform-customer profile ---------------------------------------------
    estimatedWearerCount: { type: Number, min: 0 },
    estimatedSiteCount: { type: Number, min: 0 },
    orderingModel: { type: String, enum: ORDERING_MODELS },
    fulfillmentModel: { type: String, enum: FULFILLMENT_MODELS },
    sizingModel: { type: String, enum: SIZING_MODELS },
    personalizationTypes: { type: [String], enum: PERSONALIZATION_TYPE_CODES, default: [] },
    typicalIssueFrequency: { type: String, enum: ISSUE_FREQUENCIES },
    newJoinerProcessSummary: { type: String, trim: true },
    replacementProcessSummary: { type: String, trim: true },
    serviceCoverageNotes: { type: String, trim: true },
    expectedTenderCycle: { type: String, trim: true },
  },
  { _id: false },
);

// Cross-field rules the schema's own field-level validators can't express
// (ranges, "currency required alongside a value"). Mongoose subdocuments run
// their own validation as part of the parent's, so this fires whenever the
// parent account is validated/saved.
garmentSalesProfileSchema.pre("validate", function (next) {
  const g = this;
  const invalidate = (path, msg) => this.invalidate ? this.invalidate(path, msg) : null;

  // Untouched dropdowns/selects send "" for "no selection" — same forgiving
  // rule as the parent account's customerTier/size (see applyDerived below).
  for (const f of ["orderFrequency", "customerPotential", "orderingModel", "fulfillmentModel", "sizingModel", "typicalIssueFrequency", "preferredFreightMode"]) {
    if (g[f] === "") g[f] = undefined;
  }
  for (const f of ["defaultPoIssuerAccountId", "defaultBillToAccountId", "defaultImporterAccountId", "defaultAgentAccountId"]) {
    if (g[f] === "") g[f] = undefined;
  }
  for (const f of ["nominatedLaboratoryAccountIds", "nominatedSupplierAccountIds"]) {
    if (Array.isArray(g[f])) g[f] = g[f].filter(Boolean);
  }

  if (g.typicalOrderQuantityMin != null && g.typicalOrderQuantityMax != null && g.typicalOrderQuantityMin > g.typicalOrderQuantityMax) {
    invalidate("typicalOrderQuantityMin", "typicalOrderQuantityMin cannot exceed typicalOrderQuantityMax.");
  }
  if (g.targetPriceBandMin != null && g.targetPriceBandMax != null && g.targetPriceBandMin > g.targetPriceBandMax) {
    invalidate("targetPriceBandMin", "targetPriceBandMin cannot exceed targetPriceBandMax.");
  }
  if ((g.targetPriceBandMin != null || g.targetPriceBandMax != null) && !g.targetPriceCurrency) {
    invalidate("targetPriceCurrency", "targetPriceCurrency is required when a target price band is set.");
  }
  next();
});

const accountSchema = new mongoose.Schema(
  {
    accountId: { type: String, unique: true },

    // Company Info
    companyName: { type: String, required: true, trim: true }, // customer-facing name
    displayName: { type: String, trim: true }, // defaults to companyName
    legalName: { type: String, trim: true },
    logo: { type: String },
    website: { type: String, trim: true },
    gstNumber: { type: String, trim: true },
    panNumber: { type: String, trim: true },
    taxRegistrationNumber: { type: String, trim: true }, // restricted — see crmVisibility
    registrationNumber: { type: String, trim: true },

    // Brand the customer trades/markets under, when different from the legal
    // company name (e.g. a hotel group's property brand).
    brandName: { type: String, trim: true },

    // Classification
    // The sales-facing "who are they" — hotel / corporate / school / hospital /
    // retail brand / distributor / government / export buyer. See constants/crm.
    customerType: { type: String, enum: CUSTOMER_TYPE_CODES },
    industry: {
      type: String,
      enum: ["garments", "retail", "wholesale", "export", "corporate", "school_uniform", "hospitality", "healthcare", "other"],
      default: "other",
    },
    // Legacy single-type (kept so the existing accounts page keeps working).
    type: {
      type: String,
      enum: ["prospect", "customer", "partner", "competitor", "other"],
      default: "prospect",
    },
    // Step-01 multi-role classification. Stable codes only — see constants/crm.
    roles: {
      type: [String],
      enum: ACCOUNT_ROLE_CODES,
      default: [],
    },
    lifecycleStage: { type: String, enum: LIFECYCLE_STAGE_CODES, default: "prospect" },
    customerTier: { type: String, enum: CUSTOMER_TIER_CODES },
    size: { type: String, enum: ["1-10", "11-50", "51-200", "201-500", "500+"] },
    status: { type: String, enum: ACCOUNT_STATUS_CODES, default: "active" },

    // Hierarchy — a parent account within the same corporate group.
    parentAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount" },

    // Contact Info
    primaryEmail: { type: String, lowercase: true, trim: true },
    primaryPhone: { type: String, trim: true },
    alternatePhone: { type: String, trim: true },

    // Location
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true, default: "India" },
    countryCode: { type: String, trim: true }, // ISO
    postalCode: { type: String, trim: true },

    // Communication defaults
    defaultCurrency: { type: String, trim: true, default: "INR" },
    language: { type: String, trim: true },
    timeZone: { type: String, trim: true, default: "Asia/Kolkata" },

    // Commercial profile
    paymentTermsCode: { type: String, trim: true },
    creditDays: { type: Number, min: 0 }, // standard days-to-pay this customer runs on
    gstTreatment: { type: String, enum: GST_TREATMENT_CODES },
    freightArrangement: { type: String, enum: FREIGHT_ARRANGEMENT_CODES },
    negotiatedTerms: { type: String, trim: true }, // free-text: special rates / standing agreements
    defaultIncoterm: { type: String, trim: true },
    creditStatus: { type: String, enum: CREDIT_STATUS_CODES, default: "not_checked" }, // restricted
    creditLimit: { type: Number, min: 0 }, // restricted
    annualRevenue: { type: Number, min: 0 },
    annualRevenueCurrency: { type: String, trim: true },
    annualVolumeEstimate: { type: Number, min: 0 },
    employeeCount: { type: Number, min: 0 },
    foundedYear: { type: Number },
    description: { type: String, trim: true },

    // CRM Tracking
    rating: { type: String, enum: ["hot", "warm", "cold"], default: "warm" },
    totalDealsValue: { type: Number, default: 0 },
    totalOrdersValue: { type: Number, default: 0 },
    lastActivityAt: { type: Date },
    nextFollowUpAt: { type: Date },

    // Assignment (legacy single-owner; richer team lives in CRMAccountTeam)
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "SalesDepartment" },
    assignedToName: { type: String },

    // Linked data
    linkedCustomer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    primaryContact: { type: mongoose.Schema.Types.ObjectId, ref: "CRMContact" },

    // Provenance
    sourceSystem: { type: String, trim: true, default: "CRM" },
    externalReference: { type: String, trim: true },

    tags: [{ type: String, trim: true }],
    notes: { type: String, trim: true },
    notesSummary: { type: String, trim: true },

    // Garment Sales Profile (spec §7.2A) — see garmentSalesProfileSchema above.
    garmentSalesProfile: { type: garmentSalesProfileSchema, default: () => ({}) },

    // Derived, maintained on save/update — powers search + duplicate detection.
    normalizedName: { type: String, index: true },

    // Audit / lifecycle
    createdBy: actorRef(),
    updatedBy: actorRef(),
    archivedAt: { type: Date },
    archivedBy: actorRef(),
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// Indexes for the list screen (search, filter, sort) and cross-references at
// scale — see the spec's search/performance section.
accountSchema.index({ status: 1, isActive: 1 });
accountSchema.index({ roles: 1 });
accountSchema.index({ assignedTo: 1 });
accountSchema.index({ parentAccountId: 1 });
accountSchema.index({ updatedAt: -1 });
accountSchema.index(
  { sourceSystem: 1, externalReference: 1 },
  { unique: true, partialFilterExpression: { externalReference: { $type: "string" } } },
);

function applyDerived(doc) {
  if (doc.companyName != null) {
    doc.normalizedName = normalizeName(doc.companyName);
    if (!doc.displayName) doc.displayName = doc.companyName;
  }
  if (Array.isArray(doc.roles)) doc.roles = normalizeRoleList(doc.roles, ACCOUNT_ROLE_CODES);
  // Optional enums with no schema default (customerTier, size): an untouched
  // dropdown sends "" for "no selection", but Mongoose's enum validator
  // rejects "" unless it's a listed value. Treat "" as "not set" rather than
  // 400ing every create/update that leaves one of these blank — this is a
  // server-side rule, not just a frontend convention, so any future caller
  // (import, Step 02, direct API use) gets the same forgiving behaviour.
  if (doc.customerTier === "") doc.customerTier = undefined;
  if (doc.size === "") doc.size = undefined;
}

// Derive BEFORE validation so invalid role codes are cleaned (not rejected)
// and normalizedName/displayName are always populated.
accountSchema.pre("validate", function (next) {
  applyDerived(this);
  next();
});

accountSchema.pre("save", async function (next) {
  if (!this.accountId) {
    const count = await mongoose.model("CRMAccount").countDocuments();
    this.accountId = `ACC-${String(count + 1).padStart(4, "0")}`;
  }
  next();
});

// findByIdAndUpdate / findOneAndUpdate bypass document middleware, so keep the
// derived fields in step here too. Everything is folded into a single `$set`
// (which is how Mongoose treats a plain update anyway) so the derived fields
// are never lost to top-level-vs-$set casting differences.
accountSchema.pre("findOneAndUpdate", function (next) {
  const u = this.getUpdate() || {};
  const rebuilt = {};
  const $set = { ...(u.$set || {}) };
  for (const k of Object.keys(u)) {
    if (k === "$set") continue;
    if (k.startsWith("$")) rebuilt[k] = u[k];
    else $set[k] = u[k];
  }
  if ($set.companyName != null) {
    $set.normalizedName = normalizeName($set.companyName);
    if ($set.displayName == null) $set.displayName = $set.companyName;
  }
  if (Array.isArray($set.roles)) $set.roles = normalizeRoleList($set.roles, ACCOUNT_ROLE_CODES);

  // Same "" → not-set rule as applyDerived, but an update needs $unset rather
  // than a bare undefined (Mongo drops undefined keys silently either way, but
  // being explicit means the field is actually cleared, not left stale).
  const unset = {};
  for (const f of ["customerTier", "size"]) {
    if ($set[f] === "") { delete $set[f]; unset[f] = ""; }
  }

  rebuilt.$set = $set;
  if (Object.keys(unset).length) rebuilt.$unset = { ...(rebuilt.$unset || {}), ...unset };
  this.setUpdate(rebuilt);
  next();
});

module.exports = mongoose.model("CRMAccount", accountSchema);
