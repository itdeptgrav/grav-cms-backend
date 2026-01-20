// models/Employee.js

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const employeeSchema = new mongoose.Schema({
  // Basic Information
  firstName: { type: String, trim: true },
  lastName: { type: String, trim: true },
  email: { type: String, lowercase: true, trim: true },
  password: { type: String },
  phone: { type: String },
  alternatePhone: { type: String },
  dateOfBirth: { type: Date },
  gender: { type: String, enum: ["male", "female", "other"] },
  maritalStatus: {
    type: String,
    enum: ["single", "married", "divorced", "widowed"],
  },

  // Work Information
  employeeId: { type: String, unique: true },
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
    ],
  },
  jobPosition: { type: String },
  jobTitle: { type: String },
  // Add managerId field
  managerId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
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
    enum: ["full_time", "part_time", "contract", "intern"],
  },
  workLocation: { type: String, default: "GRAV Clothing" },
  departmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Department",
  },
  designation: {
    type: String,
    trim: true,
  },

  // Salary Information
  salary: {
    basic: { type: Number, min: [0, "Salary cannot be negative"] },
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
  },

  // Address Information
  address: {
    current: {
      street: String,
      city: String,
      state: String,
      pincode: String,
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
    default: "draft",
  },
  isActive: { type: Boolean, default: false },

  // System Fields
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Single pre-save hook
employeeSchema.pre("save", async function () {
  // Ensure email lowercase
  if (this.email) this.email = this.email.toLowerCase();

  // Hash password if modified
  if (this.isModified("password") && this.password) {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  }

  // Calculate net salary
  if (this.salary && this.salary.basic !== undefined) {
    this.salary.netSalary =
      (this.salary.basic || 0) +
      (this.salary.allowances || 0) -
      (this.salary.deductions || 0);
  }

  this.updatedAt = Date.now();
});

// Virtual for full name
employeeSchema.virtual("fullName").get(function () {
  return `${this.firstName} ${this.lastName}`;
});

module.exports = mongoose.model("Employee", employeeSchema);
