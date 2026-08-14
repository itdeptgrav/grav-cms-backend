// models/CMS_Models/Sales/Contact.js
//
// CRMContact — a person at an account. Step 01 adds: site/department linkage,
// many-to-many contact roles (decision maker, approver, uniform coordinator…),
// a single-primary-per-account flag, consent + do-not-contact handling, and
// normalized name/email for duplicate warnings. Wearer measurements are NOT
// stored here — that is a privacy-controlled entity for the later uniform module.
const mongoose = require("mongoose");
const {
  CONTACT_ROLE_CODES,
  CONTACT_STATUS_CODES,
  PREFERRED_CHANNEL_CODES,
  CONSENT_STATUS_CODES,
  normalizeRoleList,
} = require("../../../constants/crm");
const { normalizeName } = require("../../../services/crmDuplicates");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
});

const contactSchema = new mongoose.Schema(
  {
    contactId: { type: String, unique: true },

    // Personal Info
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },
    alternateEmail: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    mobile: { type: String, trim: true },
    whatsapp: { type: String, trim: true },
    alternatePhone: { type: String, trim: true },
    avatar: { type: String },

    // Professional Info
    company: { type: String, trim: true },
    jobTitle: { type: String, trim: true },
    designation: { type: String, trim: true }, // legacy alias of jobTitle
    department: { type: String, trim: true }, // free-text legacy; structured link below
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount" },
    siteId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMSite" },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMDepartment" },

    // Classification
    type: {
      type: String,
      enum: ["lead", "prospect", "customer", "partner", "vendor", "other"],
      default: "prospect",
    },
    // Step-01 many-to-many business roles.
    roles: { type: [String], enum: CONTACT_ROLE_CODES, default: [] },
    status: { type: String, enum: CONTACT_STATUS_CODES, default: "active" },
    isPrimary: { type: Boolean, default: false }, // one primary per account

    // Location
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true, default: "India" },
    postalCode: { type: String, trim: true },

    // Preferences
    preferredContact: { type: String, enum: ["email", "phone", "whatsapp"], default: "phone" }, // legacy
    preferredChannel: { type: String, enum: PREFERRED_CHANNEL_CODES, default: "phone" },
    preferredLanguage: { type: String, trim: true },
    timezone: { type: String, default: "Asia/Kolkata" },

    // Consent / suppression
    consentStatus: { type: String, enum: CONSENT_STATUS_CODES, default: "unknown" },
    doNotContact: { type: Boolean, default: false },
    doNotContactReason: { type: String, trim: true },
    doNotContactAt: { type: Date },

    // Social
    linkedin: { type: String, trim: true },
    instagram: { type: String, trim: true },

    // Tracking
    source: {
      type: String,
      enum: ["website", "referral", "cold_call", "trade_show", "social_media", "existing_customer", "advertisement", "walk_in", "other"],
      default: "other",
    },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "SalesDepartment" },
    assignedToName: { type: String },
    lastContactedAt: { type: Date },
    nextFollowUpAt: { type: Date },

    // Linked data
    linkedLeads: [{ type: mongoose.Schema.Types.ObjectId, ref: "Lead" }],
    linkedCustomer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },

    // Derived for search + duplicate detection
    normalizedName: { type: String, index: true },

    tags: [{ type: String, trim: true }],
    notes: { type: String, trim: true },

    createdBy: actorRef(),
    updatedBy: actorRef(),
    archivedAt: { type: Date },
    archivedBy: actorRef(),
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

contactSchema.index({ accountId: 1, isActive: 1 });
contactSchema.index({ email: 1 });
contactSchema.index({ roles: 1 });

function applyDerived(doc) {
  const first = doc.firstName || "";
  const last = doc.lastName || "";
  doc.normalizedName = normalizeName(`${first} ${last}`);
  if (Array.isArray(doc.roles)) doc.roles = normalizeRoleList(doc.roles, CONTACT_ROLE_CODES);
}

// Derive (normalizedName, role cleanup) and enforce "at least a first or last
// name" BEFORE validation. `invalidate` produces a normal ValidationError, so
// callers see the same 400 shape as any other field.
contactSchema.pre("validate", function (next) {
  applyDerived(this);
  if (!this.firstName && !this.lastName) {
    this.invalidate("firstName", "A contact needs at least a first or last name.");
  }
  next();
});

contactSchema.pre("save", async function (next) {
  if (!this.contactId) {
    const count = await mongoose.model("CRMContact").countDocuments();
    this.contactId = `CONT-${String(count + 1).padStart(4, "0")}`;
  }
  next();
});

contactSchema.pre("findOneAndUpdate", function (next) {
  const u = this.getUpdate() || {};
  const rebuilt = {};
  const $set = { ...(u.$set || {}) };
  for (const k of Object.keys(u)) {
    if (k === "$set") continue;
    if (k.startsWith("$")) rebuilt[k] = u[k];
    else $set[k] = u[k];
  }
  if ($set.firstName != null || $set.lastName != null) {
    $set.normalizedName = normalizeName(`${$set.firstName || ""} ${$set.lastName || ""}`);
  }
  if (Array.isArray($set.roles)) $set.roles = normalizeRoleList($set.roles, CONTACT_ROLE_CODES);
  rebuilt.$set = $set;
  this.setUpdate(rebuilt);
  next();
});

module.exports = mongoose.model("CRMContact", contactSchema);
