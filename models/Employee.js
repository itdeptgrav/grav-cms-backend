const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const employeeSchema = new mongoose.Schema({
  // Basic Information - all optional except email (for unique identification)
  firstName: { type: String, trim: true },
  lastName: { type: String, trim: true },
  email: {
    type: String,
    lowercase: true,
    trim: true,
    sparse: true, // allows multiple null/undefined but unique when provided
  },
  password: { type: String },
  temporaryPassword: { type: String, select: false },
  phone: { type: String },
  alternatePhone: { type: String },
  dateOfBirth: { type: Date },
  gender: {
    type: String,
  },
  maritalStatus: {
    type: String,
  },

  // Profile Photo
  profilePhoto: {
    url: String,
    publicId: String,
  },

  bloodGroup: {
    type: String,
  },

  // Work Information
  biometricId: { type: String, sparse: true }, // unique when provided, optional
  identityId: { type: String, sparse: true },
  needsToOperate: { type: Boolean, default: false },

  department: {
    type: String,
  },
  jobPosition: { type: String },
  jobTitle: { type: String },
  primaryManager: {
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    managerName: { type: String },
  },
  secondaryManager: {
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    managerName: { type: String },
  },
  dateOfJoining: { type: Date },
  employmentType: {
    type: String,
  },
  workLocation: { type: String, default: "GRAV Clothing" },
  departmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Department",
  },
  designation: { type: String, trim: true },

  // Salary Information
  salary: {
    basic: { type: Number, min: [0, "Salary cannot be negative"], default: 0 },
    allowances: { type: Number, default: 0, min: [0, "Allowances cannot be negative"] },
    deductions: { type: Number, default: 0, min: [0, "Deductions cannot be negative"] },
    netSalary: { type: Number, default: 0 },
  },

  // Bank Details
  bankDetails: {
    bankName: { type: String },
    accountNumber: { type: String },
    ifscCode: { type: String },
  },

  // Documents
  documents: {
    aadharNumber: { type: String, sparse: true },
    panNumber: { type: String, sparse: true },
    uanNumber: { type: String, sparse: true },
    aadharFile: { url: String, publicId: String },
    panFile: { url: String, publicId: String },
    resumeFile: { url: String, publicId: String },
    additionalDocuments: [
      {
        title: String,
        url: String,
        publicId: String,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
  },

  // Address Information
  address: {
    current: {
      street: { type: String },
      city: { type: String },
      state: { type: String },
      pincode: { type: String },
      country: { type: String, default: "India" },
    },
    permanent: {
      street: String,
      city: String,
      state: String,
      pincode: String,
      country: { type: String, default: "India" },
    },
  },

  // Status
  status: {
    type: String,
    default: "active",
  },
  isActive: { type: Boolean, default: true },

  // Email tracking
  welcomeEmailSent: { type: Boolean, default: false },
  emailSentAt: { type: Date },
  emailError: { type: String },

  // System Fields
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Add sparse unique indexes manually (allows multiple nulls, unique when present)
employeeSchema.index({ email: 1 }, { unique: true, sparse: true });
employeeSchema.index({ biometricId: 1 }, { unique: true, sparse: true });
employeeSchema.index({ identityId: 1 }, { unique: true, sparse: true });

// Calculate net salary before saving
employeeSchema.pre("save", async function () {
  if (this.salary) {
    this.salary.netSalary =
      (this.salary.basic || 0) +
      (this.salary.allowances || 0) -
      (this.salary.deductions || 0);
  }
  this.updatedAt = Date.now();
});

// Hash password before saving
employeeSchema.pre("save", async function (next) {
  try {
    if (!this.isModified("password") || !this.password) return next();
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// Virtual for full name
employeeSchema.virtual("fullName").get(function () {
  return `${this.firstName || ""} ${this.lastName || ""}`.trim();
});

// Virtual for backward compatibility
employeeSchema.virtual("employeeId").get(function () {
  return this.biometricId;
});

module.exports = mongoose.model("Employee", employeeSchema);