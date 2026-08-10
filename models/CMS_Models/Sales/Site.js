// models/CMS_Models/Sales/Site.js
//
// CRMSite — an operational location belonging to an account: head office,
// branch, campus, hospital, hotel, factory, warehouse, delivery point. Distinct
// from an Address because a site carries contacts, departments, and (later)
// uniform fulfilment — an address alone cannot. Sites can nest (a campus under
// a head office) and that tree must stay acyclic (see services/crmHierarchy).
const mongoose = require("mongoose");
const { SITE_TYPE_CODES } = require("../../../constants/crm");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
});

const siteSchema = new mongoose.Schema(
  {
    siteId: { type: String, unique: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", required: true, index: true },
    parentSiteId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMSite" },

    siteCode: { type: String, trim: true }, // unique within the account
    name: { type: String, required: true, trim: true },
    siteType: { type: String, enum: SITE_TYPE_CODES, default: "branch" },
    status: { type: String, enum: ["active", "inactive", "archived"], default: "active" },

    // Address
    addressLine1: { type: String, trim: true },
    addressLine2: { type: String, trim: true },
    city: { type: String, trim: true },
    region: { type: String, trim: true },
    postalCode: { type: String, trim: true },
    country: { type: String, trim: true, default: "India" },
    countryCode: { type: String, trim: true },
    timeZone: { type: String, trim: true, default: "Asia/Kolkata" },
    phone: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },
    deliveryInstructions: { type: String, trim: true },

    isPrimary: { type: Boolean, default: false }, // one primary per account
    isUniformProgramSite: { type: Boolean, default: false },

    createdBy: actorRef(),
    updatedBy: actorRef(),
    archivedAt: { type: Date },
    archivedBy: actorRef(),
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

siteSchema.index({ accountId: 1, isActive: 1 });
// Site code unique WITHIN an account (only when a code is set).
siteSchema.index(
  { accountId: 1, siteCode: 1 },
  { unique: true, partialFilterExpression: { siteCode: { $type: "string" } } },
);

siteSchema.pre("save", async function (next) {
  if (!this.siteId) {
    const count = await mongoose.model("CRMSite").countDocuments();
    this.siteId = `SITE-${String(count + 1).padStart(4, "0")}`;
  }
  next();
});

module.exports = mongoose.model("CRMSite", siteSchema);
