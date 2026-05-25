// models/CRM_Models/Lead.js
const mongoose = require("mongoose");

const activitySchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["call", "email", "meeting", "note", "status_change", "task"],
    },
    title: { type: String, trim: true },
    description: { type: String, trim: true },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
    },
    performedByName: { type: String },
    scheduledAt: { type: Date },
    completedAt: { type: Date },
    outcome: { type: String, trim: true },
  },
  { _id: true, timestamps: true },
);

const leadSchema = new mongoose.Schema(
  {
    leadId: { type: String, unique: true },
    // Basic Info
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    whatsapp: { type: String, trim: true },

    // Company Info
    company: { type: String, trim: true },
    designation: { type: String, trim: true },
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
    companySize: {
      type: String,
      enum: ["1-10", "11-50", "51-200", "201-500", "500+"],
    },
    website: { type: String, trim: true },

    // Lead Details
    source: {
      type: String,
      enum: [
        "website",
        "referral",
        "cold_call",
        "trade_show",
        "social_media",
        "existing_customer",
        "advertisement",
        "walk_in",
        "other",
      ],
      default: "other",
    },
    stage: {
      type: String,
      enum: [
        "new",
        "contacted",
        "qualified",
        "proposal_sent",
        "negotiation",
        "won",
        "lost",
      ],
      default: "new",
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
    },
    estimatedValue: { type: Number, default: 0 },
    probability: { type: Number, min: 0, max: 100, default: 20 },
    expectedCloseDate: { type: Date },

    // Requirements
    productInterest: [{ type: String, trim: true }],
    estimatedQuantity: { type: Number },
    deliveryTimeline: { type: String, trim: true },
    budget: { type: String, trim: true },
    requirements: { type: String, trim: true },

    // Assignment
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
    },
    assignedToName: { type: String },

    // Location
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true, default: "India" },

    // Tracking
    lastContactedAt: { type: Date },
    nextFollowUpAt: { type: Date },
    lostReason: { type: String, trim: true },
    notes: { type: String, trim: true },
    tags: [{ type: String, trim: true }],

    // Conversion
    convertedToCustomer: { type: Boolean, default: false },
    convertedCustomerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
    },
    convertedAt: { type: Date },

    // Related
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount" },
    activities: [activitySchema],

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// Auto-generate leadId
leadSchema.pre("save", async function (next) {
  if (!this.leadId) {
    const count = await mongoose.model("Lead").countDocuments();
    this.leadId = `LEAD-${String(count + 1).padStart(4, "0")}`;
  }
  next();
});

module.exports = mongoose.model("Lead", leadSchema);
