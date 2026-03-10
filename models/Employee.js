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
  salary: {
    // ── Inputs (HR fills these) ───────────────────────────────────────────────
    gross: { type: Number, min: 0, default: 0 },  // CTC / gross monthly salary
    calendarDays: { type: Number, default: 0 },          // total days in the month
    actualWorkingDays: { type: Number, default: 0 },          // days employee actually worked

    // ── Earnings (auto-calculated) ────────────────────────────────────────────
    basic: { type: Number, default: 0 },  // 50% of gross
    hra: { type: Number, default: 0 },  // 20% of gross (non-metro default)

    // ── Employer PF Contributions (auto-calculated) ───────────────────────────
    // EPF = 12% of Basic — split: EPS 8.33% capped ₹1250, EEPF remainder
    eepf: { type: Number, default: 0 },  // Employee share: 12% of basic
    eps: { type: Number, default: 0 },  // Employer share: 8.33% of basic, max ₹1250
    epf: { type: Number, default: 0 },  // Employer share: 3.67% of basic (EPF - EPS)
    edli: { type: Number, default: 0 },  // 0.5% of basic, max ₹75/month
    adminCharges: { type: Number, default: 0 },  // 0.5% of basic (EPF admin)

    // ── ESI (applicable only if gross ≤ ₹21,000) ─────────────────────────────
    eeesic: { type: Number, default: 0 },  // Employee ESI: 0.75% of gross
    erEsic: { type: Number, default: 0 },  // Employer ESI: 3.25% of gross

    // ── Deductions ────────────────────────────────────────────────────────────
    salaryAdvance: { type: Number, default: 0 },  // manual entry
    loan: { type: Number, default: 0 },  // manual entry
    otherDeductions: { type: Number, default: 0 },  // manual entry

    // ── Totals (auto-calculated) ──────────────────────────────────────────────
    totalDeduction: { type: Number, default: 0 },  // eepf + eeesic + advance + loan + other
    netSalary: { type: Number, default: 0 },  // payable gross - totalDeduction

    // ── Legacy (kept for backward compat) ────────────────────────────────────
    allowances: { type: Number, default: 0 },
    deductions: { type: Number, default: 0 },
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
// Auto-calculate all payroll fields using config rates stored in SalaryConfig collection
employeeSchema.pre("save", async function (next) {
  if (!this.salary) { this.updatedAt = Date.now(); return next(); }
  try {
    // Lazy-require to avoid circular dependency issues at startup
    const SalaryConfig = require("./Salaryconfig");
    const cfg = await SalaryConfig.getSingleton();

    const s = this.salary;
    const basicPct = (cfg.basicPct ?? 50) / 100;
    const hraPct = (cfg.hraPct ?? 20) / 100;
    const eepfPct = (cfg.eepfPct ?? 12) / 100;
    const epsPct = (cfg.epsPct ?? 8.33) / 100;
    const epsCapAmount = cfg.epsCapAmount ?? 1250;
    const edliPct = (cfg.edliPct ?? 0.5) / 100;
    const edliCapAmount = cfg.edliCapAmount ?? 75;
    const adminPct = (cfg.adminChargesPct ?? 0.5) / 100;
    const esiWageLimit = cfg.esiWageLimit ?? 21000;
    const eeEsicPct = (cfg.eeEsicPct ?? 0.75) / 100;
    const erEsicPct = (cfg.erEsicPct ?? 3.25) / 100;

    const gross = s.gross || 0;
    const calDays = s.calendarDays || 0;
    const workDays = s.actualWorkingDays || 0;

    const payableGross = (calDays > 0 && workDays > 0 && workDays <= calDays)
      ? Math.round((gross / calDays) * workDays)
      : gross;

    const basic = Math.round(payableGross * basicPct);
    const hra = Math.round(payableGross * hraPct);

    const eepf = Math.round(basic * eepfPct);
    const eps = Math.min(Math.round(basic * epsPct), epsCapAmount);
    const epf = Math.round(basic * eepfPct) - eps;
    const edli = Math.min(Math.round(basic * edliPct), edliCapAmount);
    const adminCharges = Math.round(basic * adminPct);

    const esiApplicable = gross <= esiWageLimit;
    const eeesic = esiApplicable ? Math.round(payableGross * eeEsicPct) : 0;
    const erEsic = esiApplicable ? Math.round(payableGross * erEsicPct) : 0;

    const salaryAdvance = s.salaryAdvance || 0;
    const loan = s.loan || 0;
    const otherDeductions = s.otherDeductions || 0;

    const totalDeduction = eepf + eeesic + salaryAdvance + loan + otherDeductions;
    const netSalary = Math.max(payableGross - totalDeduction, 0);

    s.basic = basic; s.hra = hra;
    s.eepf = eepf; s.eps = eps; s.epf = epf;
    s.edli = edli; s.adminCharges = adminCharges;
    s.eeesic = eeesic; s.erEsic = erEsic;
    s.totalDeduction = totalDeduction; s.netSalary = netSalary;
    s.allowances = hra; s.deductions = totalDeduction;

    this.updatedAt = Date.now();
    next();
  } catch (err) {
    next(err);
  }
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