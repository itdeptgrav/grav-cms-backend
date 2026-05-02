// models/Employee.js

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

// Custom field schema - allows HR to add dynamic fields per section
const customFieldSchema = new mongoose.Schema(
  {
    key: { type: String, trim: true, required: true },
    label: { type: String, trim: true, required: true },
    value: { type: String, trim: true },
    fieldType: {
      type: String,
      enum: ["text", "number", "date", "select", "boolean"],
      default: "text",
    },
  },
  { _id: false }
);

const employeeSchema = new mongoose.Schema({
  // ─── PERSONAL / BASIC INFORMATION ────────────────────────────────────────────
  title: { type: String, enum: ["Mr.", "Mrs.", "Ms.", "Dr.", ""], default: "" },
  firstName: { type: String, trim: true },
  middleName: { type: String, trim: true },
  lastName: { type: String, trim: true },
  nickName: { type: String, trim: true },

  email: {
    type: String,
    lowercase: true,
    trim: true,
    sparse: true, // unique when provided, allows multiple null/undefined
  },
  password: { type: String },
  temporaryPassword: { type: String, select: false },

  phone: { type: String },
  alternatePhone: { type: String },
  extension: { type: String },           // office extension number

  dateOfBirth: { type: Date },
  gender: { type: String, enum: ["male", "female", "other", ""], default: "" },
  bloodGroup: { type: String },
  maritalStatus: {
    type: String,
    enum: ["single", "married", "divorced", "widowed", ""],
    default: "",
  },
  marriageDate: { type: Date },
  spouseName: { type: String, trim: true },
  spouseDOB: { type: Date },
  nationality: { type: String, trim: true },
  religion: { type: String, trim: true },
  placeOfBirth: { type: String, trim: true },
  countryOfOrigin: { type: String, trim: true },
  residentialStatus: { type: String, trim: true },

  // Parent / Family
  fatherFirstName: { type: String, trim: true },
  fatherMiddleName: { type: String, trim: true },
  fatherLastName: { type: String, trim: true },
  fatherDateOfBirth: { type: Date },
  motherFirstName: { type: String, trim: true },
  motherMiddleName: { type: String, trim: true },
  motherLastName: { type: String, trim: true },

  // Flags
  isDirector: { type: Boolean, default: false },
  isInternational: { type: Boolean, default: false },
  isPhysicallyChallenged: { type: Boolean, default: false },

  // Personal Email (separate from work email)
  personalEmail: { type: String, lowercase: true, trim: true },

  // Profile Photo
  profilePhoto: {
    url: String,
    publicId: String,
  },

  // Custom fields for Personal Info section
  personalCustomFields: { type: [customFieldSchema], default: [] },

  // ─── WORK INFORMATION ────────────────────────────────────────────────────────
  biometricId: { type: String, sparse: true },
  identityId: { type: String, sparse: true },
  needsToOperate: { type: Boolean, default: false },

  department: { type: String },
  departmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Department" },
  designation: { type: String, trim: true },
  jobPosition: { type: String },       // kept for backward compat
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
  confirmationDate: { type: Date },
  probationPeriod: { type: Number, default: 0 }, // in months

  employmentType: {
    type: String,
    enum: ["full_time", "part_time", "contract", "intern", ""],
    default: "",
  },
  workLocation: { type: String, default: "GRAV Clothing" },
  shift: { type: String, trim: true },

  status: { type: String, default: "active" },
  isActive: { type: Boolean, default: true },

  // Custom fields for Work section
  workCustomFields: { type: [customFieldSchema], default: [] },

  // ─── SALARY INFORMATION ──────────────────────────────────────────────────────
  //  All monetary fields are stored as AES-256-GCM encrypted strings.
  //  Schema type is Mixed so Mongoose accepts either the legacy Number
  //  (old records before encryption was added) or the new encrypted String.
  //  Use salaryEncryption.decryptEmployeeDoc() to get plain numbers back.
  salary: {
    // ── HR Input ──────────────────────────────────────────────────────────────
    gross: { type: mongoose.Schema.Types.Mixed, default: 0 },

    // ── Earnings (auto) ───────────────────────────────────────────────────────
    basic: { type: mongoose.Schema.Types.Mixed, default: 0 },
    hra: { type: mongoose.Schema.Types.Mixed, default: 0 },
    specialAllowance: { type: mongoose.Schema.Types.Mixed, default: 0 },

    // ── PF (auto) ─────────────────────────────────────────────────────────────
    epf: { type: mongoose.Schema.Types.Mixed, default: 0 },
    edli: { type: mongoose.Schema.Types.Mixed, default: 0 },
    edliOverride: { type: Boolean, default: false },  // kept as boolean
    adminCharges: { type: mongoose.Schema.Types.Mixed, default: 0 },
    adminOverride: { type: Boolean, default: false },  // kept as boolean

    // ── ESI on Basic ─────────────────────────────────────────────────────────
    eeesic: { type: mongoose.Schema.Types.Mixed, default: 0 },
    erEsic: { type: mongoose.Schema.Types.Mixed, default: 0 },
    foodAllowance: { type: mongoose.Schema.Types.Mixed, default: 0 },

    // ── Totals (auto) ─────────────────────────────────────────────────────────
    employerCost: { type: mongoose.Schema.Types.Mixed, default: 0 },
    totalDeduction: { type: mongoose.Schema.Types.Mixed, default: 0 },
    netSalary: { type: mongoose.Schema.Types.Mixed, default: 0 },

    // ── Legacy ────────────────────────────────────────────────────────────────
    allowances: { type: mongoose.Schema.Types.Mixed, default: 0 },
    deductions: { type: mongoose.Schema.Types.Mixed, default: 0 },
  },

  // Bank Details
  bankDetails: {
    bankName: { type: String },
    accountNumber: { type: String },
    ifscCode: { type: String },
    accountType: { type: String, enum: ["savings", "current", ""], default: "" },
    branchName: { type: String },
  },

  // Custom fields for Salary section
  salaryCustomFields: { type: [customFieldSchema], default: [] },

  // ─── DOCUMENTS ───────────────────────────────────────────────────────────────
  documents: {
    aadharNumber: { type: String, sparse: true },
    panNumber: { type: String, sparse: true },
    uanNumber: { type: String, sparse: true },
    passportNumber: { type: String },
    voterIdNumber: { type: String },
    drivingLicenseNumber: { type: String },
    esicNumber: { type: String },
    pfNumber: { type: String },

    // File uploads
    aadharFile: { url: String, publicId: String },
    panFile: { url: String, publicId: String },
    resumeFile: { url: String, publicId: String },
    offerLetterFile: { url: String, publicId: String },
    appointmentLetterFile: { url: String, publicId: String },
    educationalCertificates: [{ url: String, publicId: String, title: String }],
    additionalDocuments: [
      {
        title: String,
        url: String,
        publicId: String,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
  },

  // Custom fields for Documents section
  documentCustomFields: { type: [customFieldSchema], default: [] },

  // ─── ADDRESS ─────────────────────────────────────────────────────────────────
  address: {
    current: {
      street: { type: String },
      city: { type: String },
      state: { type: String },
      pincode: { type: String },
      country: { type: String, default: "India" },
      ownershipType: {
        type: String,
        enum: ["rental", "owned", "company_provided", ""],
        default: "",
      },
    },
    permanent: {
      street: String,
      city: String,
      state: String,
      pincode: String,
      country: { type: String, default: "India" },
      ownershipType: {
        type: String,
        enum: ["rental", "owned", "company_provided", ""],
        default: "",
      },
    },
  },

  // Custom fields for Address section
  addressCustomFields: { type: [customFieldSchema], default: [] },

  // ─── EMAIL TRACKING ──────────────────────────────────────────────────────────
  welcomeEmailSent: { type: Boolean, default: false },
  emailSentAt: { type: Date },
  emailError: { type: String },

  pushToken: { type: String, default: null },

  // ─── SYSTEM ──────────────────────────────────────────────────────────────────
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// ─── INDEXES ────────────────────────────────────────────────────────────────────
employeeSchema.index({ email: 1 }, { unique: true, sparse: true });
employeeSchema.index({ biometricId: 1 }, { unique: true, sparse: true });
employeeSchema.index({ identityId: 1 }, { unique: true, sparse: true });

// ─── PRE-SAVE HOOKS ──────────────────────────────────────────────────────────────
employeeSchema.pre("save", async function (next) {
  if (!this.salary) { this.updatedAt = Date.now(); return next(); }
  try {
    const SalaryConfig = require("./Salaryconfig");
    const { decryptSalaryFields, encryptSalaryFields } = require("../utils/salaryEncryption");

    const cfg = await SalaryConfig.getSingleton();

    // ── 1. Decrypt first so all arithmetic works on plain numbers ────────────
    const s = decryptSalaryFields(this.salary);

    const basicPct = (cfg.basicPct ?? 50) / 100;
    const hraPct = (cfg.hraPct ?? 50) / 100;
    const eepfPct = (cfg.eepfPct ?? 12) / 100;
    const epfCapAmount = cfg.epfCapAmount ?? 1800;
    const edliPct = (cfg.edliPct ?? 0.5) / 100;
    const edliCapAmount = cfg.edliCapAmount ?? 15000;
    const adminPct = (cfg.adminChargesPct ?? 0.5) / 100;
    const esiWageLimit = cfg.esiWageLimit ?? 21000;
    const eeEsicPct = (cfg.eeEsicPct ?? 0.75) / 100;
    const erEsicPct = (cfg.erEsicPct ?? 3.25) / 100;

    const gross = s.gross || 0;
    const basic = Math.round(gross * basicPct);
    const hra = Math.round(gross * hraPct);

    const epf = Math.round(Math.min(basic * eepfPct, epfCapAmount));
    const edli = s.edliOverride ? (s.edli || 0) : Math.round(Math.min(basic * edliPct, edliCapAmount));
    const adminCharges = s.adminOverride ? (s.adminCharges || 0) : Math.round(basic * adminPct);

    const esiApplicable = basic <= esiWageLimit;
    const eeesic = esiApplicable ? Math.ceil(basic * eeEsicPct) : 0;
    const erEsic = esiApplicable ? Math.ceil(basic * erEsicPct) : 0;

    const foodAllowance = cfg.foodAllowance ?? 1600;
    const employerCost = gross + epf + erEsic + foodAllowance;
    const totalDeduction = epf + eeesic;
    const netSalary = Math.max(gross - totalDeduction, 0);

    // ── 2. Build the plain calculated object ─────────────────────────────────
    const calculated = {
      gross, basic, hra,
      epf, edli, adminCharges,
      edliOverride: this.salary.edliOverride || false,
      adminOverride: this.salary.adminOverride || false,
      eeesic, erEsic, foodAllowance,
      employerCost, totalDeduction, netSalary,
      allowances: hra, deductions: totalDeduction,
    };

    // ── 3. Encrypt all monetary fields before persisting ─────────────────────
    const encrypted = encryptSalaryFields(calculated);
    // Preserve boolean override flags (not encrypted)
    encrypted.edliOverride = calculated.edliOverride;
    encrypted.adminOverride = calculated.adminOverride;

    this.salary = encrypted;
    this.updatedAt = Date.now();
    next();
  } catch (err) { next(err); }
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

// ─── VIRTUALS ────────────────────────────────────────────────────────────────────
employeeSchema.virtual("fullName").get(function () {
  return [this.firstName, this.middleName, this.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
});

// Backward compat virtual
employeeSchema.virtual("employeeId").get(function () {
  return this.biometricId;
});

module.exports = mongoose.model("Employee", employeeSchema);