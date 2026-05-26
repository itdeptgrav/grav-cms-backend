// models/CRM_Models/Account.js
const mongoose = require("mongoose");

const accountSchema = new mongoose.Schema(
  {
    accountId: { type: String, unique: true },

    // Company Info
    companyName: { type: String, required: true, trim: true },
    legalName: { type: String, trim: true },
    logo: { type: String }, // Cloudinary URL
    website: { type: String, trim: true },
    gstNumber: { type: String, trim: true },
    panNumber: { type: String, trim: true },

    // Classification
    industry: {
      type: String,
      enum: [
        "garments",
        "retail",
        "wholesale",
        "export",
        "corporate",
        "school_uniform",
        "hospitality",
        "healthcare",
        "other",
      ],
      default: "other",
    },
    type: {
      type: String,
      enum: ["prospect", "customer", "partner", "competitor", "other"],
      default: "prospect",
    },
    size: {
      type: String,
      enum: ["1-10", "11-50", "51-200", "201-500", "500+"],
    },
    status: {
      type: String,
      enum: ["active", "inactive", "blocked"],
      default: "active",
    },

    // Contact Info
    primaryEmail: { type: String, lowercase: true, trim: true },
    primaryPhone: { type: String, trim: true },
    alternatePhone: { type: String, trim: true },

    // Location
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true, default: "India" },
    postalCode: { type: String, trim: true },

    // Business Details
    annualRevenue: { type: Number },
    employeeCount: { type: Number },
    foundedYear: { type: Number },
    description: { type: String, trim: true },

    // CRM Tracking
    rating: {
      type: String,
      enum: ["hot", "warm", "cold"],
      default: "warm",
    },
    totalDealsValue: { type: Number, default: 0 },
    totalOrdersValue: { type: Number, default: 0 },
    lastActivityAt: { type: Date },
    nextFollowUpAt: { type: Date },

    // Assignment
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
    },
    assignedToName: { type: String },

    // Linked data
    linkedCustomer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    primaryContact: { type: mongoose.Schema.Types.ObjectId, ref: "CRMContact" },

    tags: [{ type: String, trim: true }],
    notes: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

accountSchema.pre("save", async function (next) {
  if (!this.accountId) {
    const count = await mongoose.model("CRMAccount").countDocuments();
    this.accountId = `ACC-${String(count + 1).padStart(4, "0")}`;
  }
  next();
});

module.exports = mongoose.model("CRMAccount", accountSchema);
