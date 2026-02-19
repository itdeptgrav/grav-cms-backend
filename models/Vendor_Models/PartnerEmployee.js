const mongoose = require("mongoose");

const partnerEmployeeSchema = new mongoose.Schema({
  // Basic Information
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  phone: {
    type: String,
    required: true,
    trim: true,
  },
  gender: {
    type: String,
    enum: ["male", "female", "other"],
    required: true,
  },

  // ID Fields
  biometricId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  identityId: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
  },

  // Status
  isActive: {
    type: Boolean,
    default: true,
  },

  // Reference to admin who created this operator
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "VendorDetails",
    required: true,
  },

  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Update timestamp on save
partnerEmployeeSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Virtual for formatted display
partnerEmployeeSchema.virtual("displayName").get(function () {
  return this.name;
});

module.exports = mongoose.model("PartnerEmployee", partnerEmployeeSchema);