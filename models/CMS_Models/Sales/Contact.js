// models/CRM_Models/Contact.js
const mongoose = require("mongoose");

const contactSchema = new mongoose.Schema(
  {
    contactId: { type: String, unique: true },

    // Personal Info
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    whatsapp: { type: String, trim: true },
    alternatePhone: { type: String, trim: true },
    avatar: { type: String }, // Cloudinary URL

    // Professional Info
    company: { type: String, trim: true },
    designation: { type: String, trim: true },
    department: { type: String, trim: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount" },

    // Classification
    type: {
      type: String,
      enum: ["lead", "prospect", "customer", "partner", "vendor", "other"],
      default: "prospect",
    },
    status: {
      type: String,
      enum: ["active", "inactive", "blocked"],
      default: "active",
    },

    // Location
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true, default: "India" },
    postalCode: { type: String, trim: true },

    // Preferences
    preferredContact: {
      type: String,
      enum: ["email", "phone", "whatsapp"],
      default: "phone",
    },
    timezone: { type: String, default: "Asia/Kolkata" },

    // Social
    linkedin: { type: String, trim: true },
    instagram: { type: String, trim: true },

    // Tracking
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
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
    },
    assignedToName: { type: String },
    lastContactedAt: { type: Date },
    nextFollowUpAt: { type: Date },

    // Linked data
    linkedLeads: [{ type: mongoose.Schema.Types.ObjectId, ref: "Lead" }],
    linkedCustomer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },

    tags: [{ type: String, trim: true }],
    notes: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

contactSchema.pre("save", async function (next) {
  if (!this.contactId) {
    const count = await mongoose.model("CRMContact").countDocuments();
    this.contactId = `CONT-${String(count + 1).padStart(4, "0")}`;
  }
  next();
});

module.exports = mongoose.model("CRMContact", contactSchema);
