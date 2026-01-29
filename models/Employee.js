const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const employeeSchema = new mongoose.Schema({
  // Basic Information
  firstName: { type: String, trim: true, required: true },
  lastName: { type: String, trim: true, required: true },
  email: {
    type: String,
    lowercase: true,
    trim: true,
    required: true,
    unique: true,
  },
  password: { type: String },
  temporaryPassword: { type: String, select: false },
  phone: { type: String, required: true },
  alternatePhone: { type: String },
  dateOfBirth: { type: Date },
  gender: {
    type: String,
    enum: ["male", "female", "other"],
    required: true,
  },
  maritalStatus: {
    type: String,
    enum: ["single", "married", "divorced", "widowed"],
  },

  // Profile Photo
  profilePhoto: {
    url: String,
    publicId: String,
  },

  bloodGroup: {
    type: String,
    enum: ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"],
  },

  // Work Information - UPDATED: REMOVED employeeId, added new IDs
  biometricId: { type: String, unique: true, required: true }, // REPLACES employeeId
  identityId: { type: String, unique: true, sparse: true }, // NEW FIELD
  needsToOperate: { type: Boolean, default: false }, // NEW FIELD

  department: {
    type: String,
    enum: [
      "Administration",
      "House-Keeping",
      "IT",
      "Corporate",
      "Production",
      "Sales",
      "Marketing",
      "Finance",
      "HR",
      "Operator",
      "Design",
      "Quality Control",
      "Inventory",
      "Operations",
    ],
    required: true,
  },
  jobPosition: { type: String },
  jobTitle: { type: String, required: true },
  primaryManager: {
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    managerName: { type: String },
  },
  secondaryManager: {
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    managerName: { type: String },
  },
  dateOfJoining: { type: Date, required: true },
  employmentType: {
    type: String,
    enum: ["full_time", "part_time", "contract", "intern"],
    required: true,
  },
  workLocation: { type: String, default: "GRAV Clothing", required: true },
  departmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Department",
  },
  designation: {
    type: String,
    trim: true,
    required: true,
  },

  // Salary Information
  salary: {
    basic: {
      type: Number,
      min: [0, "Salary cannot be negative"],
      required: true,
    },
    allowances: {
      type: Number,
      default: 0,
      min: [0, "Allowances cannot be negative"],
    },
    deductions: {
      type: Number,
      default: 0,
      min: [0, "Deductions cannot be negative"],
    },
    netSalary: { type: Number, default: 0 },
  },

  // Bank Details
  bankDetails: {
    bankName: { type: String, required: true },
    accountNumber: { type: String, required: true },
    ifscCode: { type: String, required: true },
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
      street: { type: String, required: true },
      city: { type: String, required: true },
      state: { type: String, required: true },
      pincode: { type: String, required: true },
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
    enum: ["draft", "active", "inactive", "on_leave"],
    default: "active",
  },
  isActive: { type: Boolean, default: true },

  // System Fields
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Calculate net salary before saving
employeeSchema.pre("save", async function () {
  if (this.salary && this.salary.basic !== undefined) {
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
    if (!this.isModified("password")) return next();

    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);

    next();
  } catch (err) {
    next(err);
  }
});

// Virtual for full name
employeeSchema.virtual("fullName").get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// Virtual for backward compatibility (if needed for existing code)
employeeSchema.virtual("employeeId").get(function () {
  return this.biometricId; // Map biometricId to employeeId for backward compatibility
});

module.exports = mongoose.model("Employee", employeeSchema);
