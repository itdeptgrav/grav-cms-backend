/**
 * Employee Import / Export Routes
 * Mount at: /api/employees/import-export
 *
 * GET  /template          → download static .xlsx template
 * POST /import/preview    → parse uploaded .xlsx → structured preview
 * POST /import/confirm    → save to MongoDB
 * GET  /export            → export employees as styled .xlsx (re-importable)
 *
 * EXPORT FORMAT
 * -------------
 * The exported file uses the EXACT same column layout as the import template
 * (employee_import_filled_main format) so that export → re-import is lossless.
 * Salary auto-calc fields get live Excel formulas so the file is also usable
 * as a reference / payroll document.
 *
 * DYNAMIC EXTRA COLUMNS
 * ---------------------
 * Any column in the Excel that is NOT in the standard HEADER_MAP is checked
 * against EXTRA_FIELD_MAP. If matched, the value is applied to the correct
 * Employee schema field automatically.
 */

const path = require("path");
const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const Employee = require("../../models/Employee");
const SalaryConfig = require("../../models/Salaryconfig");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");

// ── multer ────────────────────────────────────────────────────────────────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok =
            file.mimetype.includes("spreadsheet") ||
            file.mimetype.includes("excel") ||
            file.originalname.endsWith(".xlsx") ||
            file.originalname.endsWith(".xls");
        cb(ok ? null : new Error("Only .xlsx / .xls files are allowed"), ok);
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1: DOWNLOAD STATIC TEMPLATE
// ─────────────────────────────────────────────────────────────────────────────
router.get("/template", EmployeeAuthMiddlewear, (req, res) => {
    const filePath = path.join(__dirname, "../../employee_import_template.xlsx");
    res.download(filePath, "employee_import_template.xlsx", (err) => {
        if (err && !res.headersSent) {
            console.error("Template download error:", err.message);
            res.status(500).json({ success: false, message: "Template file not found." });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// COLUMN DEFINITIONS
// This single array drives both import parsing and export generation.
// Keeping them in sync guarantees export → re-import is always lossless.
//
// Each entry:
//   header      — exact text shown in row 3 (column-header row)
//   field       — internal key used during import parsing
//   section     — which row-2 section banner this column belongs to
//   skip        — if true, column is auto-calculated (formulas, not raw data)
//   required    — adds " *" suffix to header and validates during import
// ─────────────────────────────────────────────────────────────────────────────
const COLUMNS = [
    // ── BASIC DETAILS ─────────────────────────────────────────────────────
    { header: "Employee Name", field: "employeeName", section: "BASIC DETAILS", required: true },
    { header: "Title", field: "title", section: "BASIC DETAILS" },
    { header: "Father / Husband Name", field: "fatherName", section: "BASIC DETAILS" },
    { header: "Gender", field: "gender", section: "BASIC DETAILS", required: true },
    { header: "Date of Birth", field: "dateOfBirth", section: "BASIC DETAILS" },
    { header: "Mobile Number", field: "phone", section: "BASIC DETAILS", required: true },
    { header: "Alternate Phone", field: "alternatePhone", section: "BASIC DETAILS" },
    { header: "Personal Email", field: "personalEmail", section: "BASIC DETAILS" },
    { header: "Work Email", field: "workEmail", section: "BASIC DETAILS" },
    { header: "Marital Status", field: "maritalStatus", section: "BASIC DETAILS" },
    { header: "Blood Group", field: "bloodGroup", section: "BASIC DETAILS" },
    { header: "Nationality", field: "nationality", section: "BASIC DETAILS" },
    { header: "Physically Challenged", field: "physicallyChallenged", section: "BASIC DETAILS" },
    // ── ADDRESS ───────────────────────────────────────────────────────────
    { header: "Street / Area", field: "currStreet", section: "ADDRESS" },
    { header: "City", field: "currCity", section: "ADDRESS" },
    { header: "State", field: "currState", section: "ADDRESS" },
    { header: "Pincode", field: "currPincode", section: "ADDRESS" },
    // ── EMPLOYMENT DETAILS ────────────────────────────────────────────────
    { header: "Biometric ID", field: "biometricId", section: "EMPLOYMENT DETAILS", required: true },
    { header: "Date of Joining", field: "dateOfJoining", section: "EMPLOYMENT DETAILS" },
    { header: "Department", field: "department", section: "EMPLOYMENT DETAILS", required: true },
    { header: "Designation", field: "designation", section: "EMPLOYMENT DETAILS", required: true },
    { header: "Employee Type", field: "employeeType", section: "EMPLOYMENT DETAILS" },
    { header: "Work Location", field: "workLocation", section: "EMPLOYMENT DETAILS" },
    { header: "Shift", field: "shift", section: "EMPLOYMENT DETAILS" },
    { header: "Is Director", field: "isDirector", section: "EMPLOYMENT DETAILS" },
    { header: "Needs to Operate", field: "needsToOperate", section: "EMPLOYMENT DETAILS" },
    // ── BANK DETAILS ──────────────────────────────────────────────────────
    { header: "Bank Name", field: "bankName", section: "BANK DETAILS" },
    { header: "Account Number", field: "accountNumber", section: "BANK DETAILS" },
    { header: "IFSC Code", field: "ifscCode", section: "BANK DETAILS" },
    { header: "Account Type", field: "accountType", section: "BANK DETAILS" },
    // ── SALARY DETAILS ────────────────────────────────────────────────────
    { header: "Gross Salary", field: "grossSalary", section: "SALARY DETAILS", required: true },
    { header: "Basic Salary", field: "_skip", section: "SALARY DETAILS", formula: true },
    { header: "HRA", field: "_skip", section: "SALARY DETAILS", formula: true },
    { header: "EPF (Employee)", field: "_skip", section: "SALARY DETAILS", formula: true },
    { header: "ESIC (Employee)", field: "_skip", section: "SALARY DETAILS", formula: true },
    { header: "Total Deductions", field: "_skip", section: "SALARY DETAILS", formula: true },
    { header: "Net Salary", field: "_skip", section: "SALARY DETAILS", formula: true },
    { header: "EPF (Employer)", field: "_skip", section: "SALARY DETAILS", formula: true },
    { header: "ESIC (Employer)", field: "_skip", section: "SALARY DETAILS", formula: true },
    { header: "Food Allowance", field: "_skip", section: "SALARY DETAILS", formula: true },
    { header: "Employer Cost (CTC)", field: "_skip", section: "SALARY DETAILS", formula: true },
    // ── STATUTORY DETAILS ─────────────────────────────────────────────────
    { header: "Aadhaar Number", field: "aadhaarNumber", section: "STATUTORY DETAILS" },
    { header: "PAN Number", field: "panNumber", section: "STATUTORY DETAILS" },
    { header: "UAN Number", field: "uanNumber", section: "STATUTORY DETAILS" },
    { header: "ESI Number", field: "esiNumber", section: "STATUTORY DETAILS" },
    { header: "PF Number", field: "pfNumber", section: "STATUTORY DETAILS" },
];

// Column indices (0-based) for quick lookup
const colIndex = {};
COLUMNS.forEach((col, i) => { colIndex[col.header] = i; });

// ─────────────────────────────────────────────────────────────────────────────
// STANDARD HEADER MAP (for import — derived from COLUMNS above)
// ─────────────────────────────────────────────────────────────────────────────
const HEADER_MAP = {};
COLUMNS.forEach(col => {
    HEADER_MAP[col.header] = col.field;
});

// ─────────────────────────────────────────────────────────────────────────────
// EXTRA / OPTIONAL FIELD MAP
// ─────────────────────────────────────────────────────────────────────────────
const EXTRA_FIELD_MAP = {
    "Nick Name": { field: "nickName", type: "string" },
    "Place Of Birth": { field: "placeOfBirth", type: "string" },
    "Place of Birth": { field: "placeOfBirth", type: "string" },
    "Residential Status": { field: "residentialStatus", type: "string" },
    "Religion": { field: "religion", type: "string" },
    "Country Of Origin": { field: "countryOfOrigin", type: "string" },
    "Country of Origin": { field: "countryOfOrigin", type: "string" },
    "Spouse Name": { field: "spouseName", type: "string" },
    "Marriage Date": { field: "marriageDate", type: "date" },
    "Spouse DOB": { field: "spouseDOB", type: "date" },
    "Mother First Name": { field: "motherFirstName", type: "string" },
    "Mother Last Name": { field: "motherLastName", type: "string" },
    "Father Middle Name": { field: "fatherMiddleName", type: "string" },
    "Is International": { field: "isInternational", type: "bool" },
    "Identity ID": { field: "identityId", type: "string" },
    "Job Position": { field: "jobPosition", type: "string" },
    "Job Title": { field: "jobTitle", type: "string" },
    "Confirmation Date": { field: "confirmationDate", type: "date" },
    "Probation Period": { field: "probationPeriod", type: "number" },
    "Probation Period (Months)": { field: "probationPeriod", type: "number" },
    "Extension": { field: "extension", type: "string" },
    "Branch Name": { field: "branchName", type: "string", nested: "bankDetails" },
    "Passport Number": { field: "passportNumber", type: "string" },
    "Voter ID": { field: "voterIdNumber", type: "string" },
    "Driving License": { field: "drivingLicenseNumber", type: "string" },
    "Primary Manager": { field: "primaryManagerName", type: "string" },
    "Secondary Manager": { field: "secondaryManagerName", type: "string" },
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION STYLING CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const SECTION_STYLES = {
    "BASIC DETAILS": { bg: "3B82F6", text: "FFFFFF" }, // blue
    "ADDRESS": { bg: "0891B2", text: "FFFFFF" }, // cyan
    "EMPLOYMENT DETAILS": { bg: "5B21B6", text: "FFFFFF" }, // purple
    "BANK DETAILS": { bg: "0F766E", text: "FFFFFF" }, // teal
    "SALARY DETAILS": { bg: "059669", text: "FFFFFF" }, // green
    "STATUTORY DETAILS": { bg: "DC2626", text: "FFFFFF" }, // red
};

// Column header row background — required cols get light purple, others get light gray
// Formula/auto cols get light green
const getColHeaderBg = (col) => {
    if (col.formula) return "ECFDF5";  // light green for auto-calc
    if (col.required) return "EDE9FE"; // light purple for required
    return "F3F4F6";                   // light gray for optional
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const normalizeHeader = (h) =>
    String(h || "")
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ")
        .replace(/\s*\*\s*$/, "")
        .trim();

const parseDate = (val) => {
    if (!val) return undefined;
    if (val instanceof Date) return isNaN(val.getTime()) ? undefined : val;
    if (typeof val === "number") {
        const p = XLSX.SSF.parse_date_code(val);
        return p ? new Date(p.y, p.m - 1, p.d) : undefined;
    }
    const s = String(val).trim();
    if (!s) return undefined;
    const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m1) return new Date(`${m1[3]}-${m1[2].padStart(2, "0")}-${m1[1].padStart(2, "0")}`);
    const m2 = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (m2) return new Date(`${m2[3]}-${m2[2].padStart(2, "0")}-${m2[1].padStart(2, "0")}`);
    const d = new Date(s);
    return isNaN(d.getTime()) ? undefined : d;
};

const toNum = (v) => {
    if (typeof v === "number") return isNaN(v) ? 0 : v;
    const s = String(v || "").replace(/[,₹\s]/g, "");
    const n = Number(s);
    return isNaN(n) ? 0 : n;
};

const toBool = (v) => {
    if (typeof v === "boolean") return v;
    return String(v || "").toLowerCase().trim() === "yes";
};

const normalizeEnum = (val, map) => map[String(val || "").toLowerCase().trim()] || "";

const GENDER_MAP = { male: "male", female: "female", other: "other" };
const MARITAL_MAP = { single: "single", married: "married", divorced: "divorced", widowed: "widowed" };
const EMP_TYPE_MAP = {
    permanent: "full_time", trainee: "intern", contract: "contract", intern: "intern",
    full_time: "full_time", "part time": "part_time", part_time: "part_time",
    "full time": "full_time",
};
const ACCT_TYPE_MAP = { savings: "savings", current: "current" };
const TITLE_MAP = {
    "mr.": "Mr.", mr: "Mr.", "mrs.": "Mrs.", mrs: "Mrs.",
    "ms.": "Ms.", ms: "Ms.", "dr.": "Dr.", dr: "Dr."
};

const fmtDate = (v) => {
    if (!v) return "";
    try {
        const d = new Date(v);
        if (isNaN(d.getTime())) return "";
        const dd = String(d.getDate()).padStart(2, "0");
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        return `${dd}/${mm}/${d.getFullYear()}`;
    } catch { return ""; }
};

const capFirst = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ") : "";

/** Server-side canonical salary recalculation from Gross */
const recalcSalary = (gross, cfg) => {
    gross = Number(gross) || 0;
    const basicPct = (cfg.basicPct ?? 50) / 100;
    const hraPct = (cfg.hraPct ?? 50) / 100;
    const eepfPct = (cfg.eepfPct ?? 12) / 100;
    const epfCap = cfg.epfCapAmount ?? 1800;
    const edliPct = (cfg.edliPct ?? 0.5) / 100;
    const edliCap = cfg.edliCapAmount ?? 15000;
    const adminPct = (cfg.adminChargesPct ?? 0.5) / 100;
    const esiLimit = cfg.esiWageLimit ?? 21000;
    const eeEsicPct = (cfg.eeEsicPct ?? 0.75) / 100;
    const erEsicPct = (cfg.erEsicPct ?? 3.25) / 100;
    const food = cfg.foodAllowance ?? 1600;
    const basic = Math.round(gross * basicPct);
    const hra = Math.round(gross * hraPct);
    const epf = Math.round(Math.min(basic * eepfPct, epfCap));
    const edli = Math.round(Math.min(basic * edliPct, edliCap));
    const adminCharges = Math.round(basic * adminPct);
    const esiOk = basic <= esiLimit;
    const eeesic = esiOk ? Math.ceil(basic * eeEsicPct) : 0;
    const erEsic = esiOk ? Math.ceil(basic * erEsicPct) : 0;
    return {
        gross, basic, hra, epf,
        edli, edliOverride: false,
        adminCharges, adminOverride: false,
        eeesic, erEsic,
        foodAllowance: food,
        employerCost: gross + epf + erEsic + food,
        totalDeduction: epf + eeesic,
        netSalary: Math.max(gross - (epf + eeesic), 0),
        allowances: hra, deductions: epf + eeesic,
        specialAllowance: Math.max(gross - basic - hra, 0),
    };
};

const applyExtraField = (emp, meta, rawValue) => {
    if (rawValue === undefined || rawValue === null) return;
    const s = String(rawValue).trim();
    if (!s) return;
    let value;
    switch (meta.type) {
        case "date": value = parseDate(s); break;
        case "number": value = toNum(s); break;
        case "bool": value = toBool(s); break;
        case "enum": value = TITLE_MAP[s.toLowerCase()] ?? null; break;
        default: value = s;
    }
    if (value === undefined || value === null) return;
    if (typeof value !== "boolean" && value === "") return;
    if (meta.nested === "bankDetails") {
        emp.bankDetails[meta.field] = value;
    } else {
        emp[meta.field] = value;
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PARSE SHEET (import)
// ─────────────────────────────────────────────────────────────────────────────
const parseSheet = async (buffer) => {
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: true, raw: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];

    // The export/template has:
    //   Row 1 = banner
    //   Row 2 = section colours
    //   Row 3 = column headers  ← range: 2 (0-based index 2 = row 3)
    //   Row 4+ = data
    const raw = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "", range: 2 });
    if (!raw || raw.length === 0) {
        throw new Error("No data rows found. Make sure you are using the correct template.");
    }

    const normKeyMap = {};
    for (const key of Object.keys(raw[0])) {
        normKeyMap[normalizeHeader(key)] = key;
    }

    const standardNorms = new Set(Object.keys(HEADER_MAP).map(normalizeHeader));
    const extraColumns = [];
    for (const [normHeader, xlsxKey] of Object.entries(normKeyMap)) {
        if (standardNorms.has(normHeader)) continue;
        for (const [extraKey, meta] of Object.entries(EXTRA_FIELD_MAP)) {
            if (normalizeHeader(extraKey) === normHeader) {
                extraColumns.push({ normHeader, xlsxKey, meta });
                break;
            }
        }
    }

    if (extraColumns.length > 0) {
        console.log(`[Import] Detected ${extraColumns.length} extra column(s):`,
            extraColumns.map(c => `"${c.normHeader}" → ${c.meta.field}`).join(", "));
    }

    const cfg = await SalaryConfig.getSingleton();
    const rows = [];
    const errors = [];

    for (let i = 0; i < raw.length; i++) {
        const rawRow = raw[i];
        const allVals = Object.values(rawRow).map(v => String(v || "").trim());
        if (allVals.every(v => v === "")) continue;

        const row = {};
        for (const [rawHeader, fieldKey] of Object.entries(HEADER_MAP)) {
            if (fieldKey === "_skip") continue;
            const xlsxKey = normKeyMap[normalizeHeader(rawHeader)];
            row[fieldKey] = xlsxKey !== undefined ? String(rawRow[xlsxKey] ?? "").trim() : "";
        }

        const employeeNum = i + 1;
        const rowErrors = [];

        if (!row.employeeName) rowErrors.push("Employee Name is required");
        if (!row.biometricId) rowErrors.push("Biometric ID is required");
        if (!row.department) rowErrors.push("Department is required");
        if (!row.designation) rowErrors.push("Designation is required");
        if (!row.phone) rowErrors.push("Mobile Number is required");
        if (!row.gender) rowErrors.push("Gender is required");

        const nameParts = (row.employeeName || "").trim().split(/\s+/);
        const firstName = nameParts[0] || "";
        const lastName = nameParts.slice(1).join(" ") || "";

        const gross = toNum(row.grossSalary);
        const salary = recalcSalary(gross, cfg);

        const emp = {
            _employeeNum: employeeNum,
            _errors: rowErrors,
            _extraFields: extraColumns
                .map(c => ({ column: c.normHeader, field: c.meta.field, value: String(rawRow[c.xlsxKey] ?? "").trim() }))
                .filter(x => x.value),
            firstName,
            lastName,
            fatherFirstName: (row.fatherName || "").split(/\s+/)[0] || "",
            fatherLastName: (row.fatherName || "").split(/\s+/).slice(1).join(" ") || "",
            gender: normalizeEnum(row.gender, GENDER_MAP),
            dateOfBirth: parseDate(row.dateOfBirth),
            phone: row.phone || "",
            alternatePhone: row.alternatePhone || "",
            personalEmail: row.personalEmail || "",
            email: row.workEmail || "",
            maritalStatus: normalizeEnum(row.maritalStatus, MARITAL_MAP),
            bloodGroup: row.bloodGroup || "",
            nationality: row.nationality || "",
            isPhysicallyChallenged: toBool(row.physicallyChallenged),
            isDirector: toBool(row.isDirector),
            isInternational: false,
            needsToOperate: toBool(row.needsToOperate),
            biometricId: row.biometricId || "",
            department: row.department || "",
            designation: row.designation || "",
            employmentType: normalizeEnum(row.employeeType, EMP_TYPE_MAP),
            workLocation: row.workLocation || "GRAV Clothing",
            shift: row.shift || "",
            dateOfJoining: parseDate(row.dateOfJoining),
            salary,
            bankDetails: {
                bankName: row.bankName || "",
                accountNumber: row.accountNumber || "",
                ifscCode: row.ifscCode || "",
                accountType: normalizeEnum(row.accountType, ACCT_TYPE_MAP),
                branchName: "",
            },
            documents: {
                aadharNumber: row.aadhaarNumber || "",
                panNumber: row.panNumber || "",
                uanNumber: row.uanNumber || "",
                esicNumber: row.esiNumber || "",
                pfNumber: row.pfNumber || "",
            },
            address: {
                current: {
                    street: row.currStreet || "", city: row.currCity || "",
                    state: row.currState || "", pincode: row.currPincode || "",
                    country: "India",
                },
                permanent: {
                    street: row.currStreet || "", city: row.currCity || "",
                    state: row.currState || "", pincode: row.currPincode || "",
                    country: "India",
                },
            },
        };

        for (const { xlsxKey, meta } of extraColumns) {
            const rawValue = String(rawRow[xlsxKey] ?? "").trim();
            applyExtraField(emp, meta, rawValue);
        }

        rows.push(emp);
        if (rowErrors.length > 0) errors.push({ employeeNum, errors: rowErrors });
    }

    const extraDetected = extraColumns.map(c => ({ column: c.normHeader, schemaField: c.meta.field }));
    return { rows, errors, extraDetected };
};

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 2: PREVIEW
// ─────────────────────────────────────────────────────────────────────────────
router.post("/import/preview", EmployeeAuthMiddlewear, upload.single("file"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded." });
        const { rows, errors, extraDetected } = await parseSheet(req.file.buffer);
        res.json({
            success: true,
            data: {
                total: rows.length,
                valid: rows.filter(r => r._errors.length === 0).length,
                invalid: rows.filter(r => r._errors.length > 0).length,
                extraDetected,
                docUploadNote:
                    "Profile photos and scanned documents cannot be uploaded via Excel. " +
                    "After import, visit each employee's HRMS profile to upload their documents.",
                rows,
                errors,
            },
        });
    } catch (err) {
        console.error("Import preview error:", err);
        res.status(500).json({ success: false, message: err.message || "Failed to parse file." });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 3: CONFIRM IMPORT
// ─────────────────────────────────────────────────────────────────────────────
router.post("/import/confirm", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        const { rows } = req.body;
        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ success: false, message: "No rows to import." });
        }

        const results = { created: 0, failed: 0, errors: [] };

        for (const row of rows) {
            try {
                if (row._errors && row._errors.length > 0) {
                    results.failed++;
                    results.errors.push({ employeeNum: row._employeeNum, errors: row._errors });
                    continue;
                }

                const tempPass = Math.random().toString(36).slice(-8);

                const empData = {
                    firstName: row.firstName,
                    lastName: row.lastName || "",
                    fatherFirstName: row.fatherFirstName || undefined,
                    fatherLastName: row.fatherLastName || undefined,
                    fatherMiddleName: row.fatherMiddleName || undefined,
                    motherFirstName: row.motherFirstName || undefined,
                    motherLastName: row.motherLastName || undefined,
                    title: ["Mr.", "Mrs.", "Ms.", "Dr.", ""].includes(row.title) ? row.title : "",
                    nickName: row.nickName || undefined,
                    gender: row.gender || undefined,
                    dateOfBirth: row.dateOfBirth || undefined,
                    phone: row.phone || undefined,
                    alternatePhone: row.alternatePhone || undefined,
                    extension: row.extension || undefined,
                    personalEmail: row.personalEmail || undefined,
                    email: row.email || undefined,
                    maritalStatus: row.maritalStatus || undefined,
                    marriageDate: row.marriageDate || undefined,
                    spouseName: row.spouseName || undefined,
                    spouseDOB: row.spouseDOB || undefined,
                    bloodGroup: row.bloodGroup || undefined,
                    nationality: row.nationality || undefined,
                    religion: row.religion || undefined,
                    placeOfBirth: row.placeOfBirth || undefined,
                    countryOfOrigin: row.countryOfOrigin || undefined,
                    residentialStatus: row.residentialStatus || undefined,
                    isPhysicallyChallenged: row.isPhysicallyChallenged || false,
                    isDirector: row.isDirector || false,
                    isInternational: row.isInternational || false,
                    needsToOperate: row.needsToOperate || false,
                    biometricId: row.biometricId,
                    identityId: row.identityId || undefined,
                    department: row.department,
                    designation: row.designation,
                    jobTitle: row.jobTitle || undefined,
                    jobPosition: row.jobPosition || undefined,
                    employmentType: row.employmentType || undefined,
                    workLocation: row.workLocation || "GRAV Clothing",
                    shift: row.shift || undefined,
                    dateOfJoining: row.dateOfJoining || undefined,
                    confirmationDate: row.confirmationDate || undefined,
                    probationPeriod: row.probationPeriod || 0,
                    salary: row.salary,
                    bankDetails: row.bankDetails,
                    documents: row.documents,
                    address: row.address,
                    password: tempPass,
                    temporaryPassword: tempPass,
                    createdBy: user?.id,
                    createdAt: new Date(),
                };

                // Attach primary/secondary manager names if present (from extra cols)
                if (row.primaryManagerName) {
                    empData.primaryManager = { managerName: row.primaryManagerName };
                }
                if (row.secondaryManagerName) {
                    empData.secondaryManager = { managerName: row.secondaryManagerName };
                }

                const emp = new Employee(empData);
                await emp.save();
                results.created++;
            } catch (err) {
                results.failed++;
                const msg = err.code === 11000
                    ? `Duplicate: ${Object.keys(err.keyPattern || {}).join(", ")} already exists`
                    : err.message || "Unknown error";
                results.errors.push({
                    employeeNum: row._employeeNum,
                    biometricId: row.biometricId,
                    name: [row.firstName, row.lastName].filter(Boolean).join(" "),
                    errors: [msg],
                });
            }
        }

        res.json({
            success: true,
            message: `Import complete: ${results.created} created, ${results.failed} failed.`,
            data: results,
        });
    } catch (err) {
        console.error("Import confirm error:", err);
        res.status(500).json({ success: false, message: err.message || "Import failed." });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 4: EXPORT
// Produces a styled .xlsx that exactly mirrors the import template format.
// All auto-calc salary fields get live Excel formulas.
// Extra employee fields (passport, voter ID etc.) are written as extra columns
// appended after the standard block so they're preserved on re-import via
// the EXTRA_FIELD_MAP.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/export", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { department, status, search } = req.query;

        let filter = {};
        if (department && department !== "all") filter.department = department;
        if (status && status !== "all") filter.status = status;
        if (search) {
            filter.$or = [
                { firstName: { $regex: search, $options: "i" } },
                { lastName: { $regex: search, $options: "i" } },
                { email: { $regex: search, $options: "i" } },
                { biometricId: { $regex: search, $options: "i" } },
            ];
        }

        const employees = await Employee.find(filter).sort({ createdAt: -1 }).lean();
        const cfg = await SalaryConfig.getSingleton();

        // ── Extra columns to append (fields not in standard COLUMNS) ───────────
        // These map directly to EXTRA_FIELD_MAP so re-import picks them up.
        const EXTRA_EXPORT_COLS = [
            { header: "Job Title", getValue: e => e.jobTitle || "" },
            { header: "Nick Name", getValue: e => e.nickName || "" },
            { header: "Religion", getValue: e => e.religion || "" },
            { header: "Place of Birth", getValue: e => e.placeOfBirth || "" },
            { header: "Country of Origin", getValue: e => e.countryOfOrigin || "" },
            { header: "Residential Status", getValue: e => e.residentialStatus || "" },
            { header: "Is International", getValue: e => e.isInternational ? "Yes" : "No" },
            { header: "Spouse Name", getValue: e => e.spouseName || "" },
            { header: "Marriage Date", getValue: e => fmtDate(e.marriageDate) },
            { header: "Confirmation Date", getValue: e => fmtDate(e.confirmationDate) },
            { header: "Probation Period", getValue: e => e.probationPeriod ? String(e.probationPeriod) : "" },
            { header: "Identity ID", getValue: e => e.identityId || "" },
            { header: "Branch Name", getValue: e => e.bankDetails?.branchName || "" },
            { header: "Passport Number", getValue: e => e.documents?.passportNumber || "" },
            { header: "Voter ID", getValue: e => e.documents?.voterIdNumber || "" },
            { header: "Driving License", getValue: e => e.documents?.drivingLicenseNumber || "" },
            { header: "Primary Manager", getValue: e => e.primaryManager?.managerName || "" },
            { header: "Secondary Manager", getValue: e => e.secondaryManager?.managerName || "" },
            // Permanent address (separate from current in standard cols)
            { header: "Permanent Street", getValue: e => e.address?.permanent?.street || "" },
            { header: "Permanent City", getValue: e => e.address?.permanent?.city || "" },
            { header: "Permanent State", getValue: e => e.address?.permanent?.state || "" },
            { header: "Permanent Pincode", getValue: e => e.address?.permanent?.pincode || "" },
        ];

        // Total columns = standard + extra
        const totalCols = COLUMNS.length + EXTRA_EXPORT_COLS.length;

        // ── xlsx-js raw workbook ───────────────────────────────────────────────
        const ws = {};
        const encode = (r, c) => XLSX.utils.encode_cell({ r, c });

        // Style helpers
        const cell = (v, t, s, f) => {
            const c = { v, t: t || (typeof v === "number" ? "n" : "s"), s: s || {} };
            if (f) c.f = f;
            return c;
        };

        const border = (style = "thin") => ({
            top: { style, color: { rgb: "E5E7EB" } },
            bottom: { style, color: { rgb: "E5E7EB" } },
            left: { style, color: { rgb: "E5E7EB" } },
            right: { style, color: { rgb: "E5E7EB" } },
        });

        const dataCellStyle = (isEven) => ({
            font: { name: "Arial", sz: 9 },
            fill: { fgColor: { rgb: isEven ? "FFFFFF" : "F9FAFB" } },
            alignment: { vertical: "center" },
            border: border(),
        });

        // ── ROW 1: Full-width banner ───────────────────────────────────────────
        ws[encode(0, 0)] = cell(
            "EMPLOYEE EXPORT  •  Fields marked * are required on re-import  •  Gross Salary drives all auto-calculated salary fields",
            "s",
            {
                fill: { fgColor: { rgb: "5B21B6" } },
                font: { bold: true, sz: 10, color: { rgb: "FFFFFF" }, name: "Arial" },
                alignment: { horizontal: "center", vertical: "center" },
            }
        );

        // ── ROW 2: Section banners ─────────────────────────────────────────────
        // Track which columns belong to each section so we can span-merge them
        const sectionSpans = {};
        COLUMNS.forEach((col, i) => {
            if (!sectionSpans[col.section]) sectionSpans[col.section] = { start: i, end: i };
            else sectionSpans[col.section].end = i;
        });
        // Extra cols get their own "EXTRA INFO" section banner
        if (EXTRA_EXPORT_COLS.length > 0) {
            sectionSpans["EXTRA INFO"] = {
                start: COLUMNS.length,
                end: COLUMNS.length + EXTRA_EXPORT_COLS.length - 1,
            };
        }

        // Write section headers in column 0 of each section span
        Object.entries(sectionSpans).forEach(([sectionName, span]) => {
            const style = SECTION_STYLES[sectionName] || { bg: "6B7280", text: "FFFFFF" };
            // Write into the first column of the span; merging handled in !merges
            ws[encode(1, span.start)] = cell(
                sectionName,
                "s",
                {
                    fill: { fgColor: { rgb: style.bg } },
                    font: { bold: true, sz: 9, color: { rgb: style.text }, name: "Arial" },
                    alignment: { horizontal: "center", vertical: "center" },
                    border: border(),
                }
            );
        });

        // ── ROW 3: Column headers ──────────────────────────────────────────────
        COLUMNS.forEach((col, i) => {
            const displayHeader = col.required ? `${col.header} *` : col.header;
            ws[encode(2, i)] = cell(
                displayHeader,
                "s",
                {
                    fill: { fgColor: { rgb: getColHeaderBg(col) } },
                    font: { bold: true, sz: 9, name: "Arial" },
                    alignment: { horizontal: "center", vertical: "center", wrapText: true },
                    border: border(),
                }
            );
        });
        // Extra col headers (light blue-gray to distinguish)
        EXTRA_EXPORT_COLS.forEach((col, i) => {
            ws[encode(2, COLUMNS.length + i)] = cell(
                col.header,
                "s",
                {
                    fill: { fgColor: { rgb: "EFF6FF" } },
                    font: { bold: true, sz: 9, name: "Arial" },
                    alignment: { horizontal: "center", vertical: "center", wrapText: true },
                    border: border(),
                }
            );
        });

        // ── Salary column positions (for formulas) ────────────────────────────
        const salaryColIdx = {
            gross: colIndex["Gross Salary"],
            basic: colIndex["Basic Salary"],
            hra: colIndex["HRA"],
            epfEE: colIndex["EPF (Employee)"],
            esicEE: colIndex["ESIC (Employee)"],
            totDed: colIndex["Total Deductions"],
            net: colIndex["Net Salary"],
            epfER: colIndex["EPF (Employer)"],
            esicER: colIndex["ESIC Employer"] !== undefined ? colIndex["ESIC Employer"] : colIndex["ESIC (Employer)"],
            food: colIndex["Food Allowance"],
            ctc: colIndex["Employer Cost (CTC)"],
        };

        // Compute correct ESIC Employer col index
        salaryColIdx.esicER = COLUMNS.findIndex(c => c.header === "ESIC (Employer)");

        const colLetter = (idx) => XLSX.utils.encode_col(idx);
        const basicPct = cfg.basicPct ?? 50;
        const hraPct = cfg.hraPct ?? 50;
        const eepfPct = cfg.eepfPct ?? 12;
        const epfCap = cfg.epfCapAmount ?? 1800;
        const esiLimit = cfg.esiWageLimit ?? 21000;
        const eeEsicPct = cfg.eeEsicPct ?? 0.75;
        const erEsicPct = cfg.erEsicPct ?? 3.25;
        const foodAmt = cfg.foodAllowance ?? 1600;

        const G_ = colLetter(salaryColIdx.gross);
        const BA_ = colLetter(salaryColIdx.basic);
        const HR_ = colLetter(salaryColIdx.hra);
        const EPF_ = colLetter(salaryColIdx.epfEE);
        const SEE_ = colLetter(salaryColIdx.esicEE);
        const TD_ = colLetter(salaryColIdx.totDed);
        const NS_ = colLetter(salaryColIdx.net);
        const SER_ = colLetter(salaryColIdx.esicER);
        const FA_ = colLetter(salaryColIdx.food);
        const CTC_ = colLetter(salaryColIdx.ctc);
        const EPR_ = colLetter(salaryColIdx.epfEE); // EPF Employer = EPF Employee (same amount)

        // Formula style
        const fStyle = {
            fill: { fgColor: { rgb: "ECFDF5" } },
            font: { sz: 9, name: "Arial" },
            alignment: { vertical: "center" },
            border: border(),
        };

        // ── DATA ROWS (starting at Excel row 4 = index 3) ─────────────────────
        employees.forEach((emp, rowOffset) => {
            const r = 3 + rowOffset;   // 0-based row index
            const excelRow = r + 1;            // 1-based for formulas
            const isEven = rowOffset % 2 === 0;
            const ds = dataCellStyle(isEven);

            // Helper to write a regular data cell
            const dc = (colI, value, overrideStyle) => {
                const v = value === null || value === undefined ? "" : value;
                const t = typeof v === "number" ? "n" : "s";
                ws[encode(r, colI)] = { v, t, s: overrideStyle || ds };
            };

            // ── Standard columns ──────────────────────────────────────────────
            const fatherFullName = [emp.fatherFirstName, emp.fatherMiddleName, emp.fatherLastName].filter(Boolean).join(" ");

            const VALUES = {
                "Employee Name": `${emp.firstName || ""} ${emp.lastName || ""}`.trim(),
                "Title": emp.title || "",
                "Father / Husband Name": fatherFullName,
                "Gender": capFirst(emp.gender || ""),
                "Date of Birth": fmtDate(emp.dateOfBirth),
                "Mobile Number": emp.phone || "",
                "Alternate Phone": emp.alternatePhone || "",
                "Personal Email": emp.personalEmail || "",
                "Work Email": emp.email || "",
                "Marital Status": capFirst(emp.maritalStatus || ""),
                "Blood Group": emp.bloodGroup || "",
                "Nationality": emp.nationality || "",
                "Physically Challenged": emp.isPhysicallyChallenged ? "Yes" : "No",
                "Street / Area": emp.address?.current?.street || "",
                "City": emp.address?.current?.city || "",
                "State": emp.address?.current?.state || "",
                "Pincode": emp.address?.current?.pincode || "",
                "Biometric ID": emp.biometricId || "",
                "Date of Joining": fmtDate(emp.dateOfJoining),
                "Department": emp.department || "",
                "Designation": emp.designation || "",
                "Employee Type": capFirst(emp.employmentType || ""),
                "Work Location": emp.workLocation || "",
                "Shift": emp.shift || "",
                "Is Director": emp.isDirector ? "Yes" : "No",
                "Needs to Operate": emp.needsToOperate ? "Yes" : "No",
                "Bank Name": emp.bankDetails?.bankName || "",
                "Account Number": emp.bankDetails?.accountNumber || "",
                "IFSC Code": emp.bankDetails?.ifscCode || "",
                "Account Type": capFirst(emp.bankDetails?.accountType || ""),
                "Gross Salary": emp.salary?.gross || 0,
                // Salary formula cols are written below
                "Aadhaar Number": emp.documents?.aadharNumber || "",
                "PAN Number": emp.documents?.panNumber || "",
                "UAN Number": emp.documents?.uanNumber || "",
                "ESI Number": emp.documents?.esicNumber || "",
                "PF Number": emp.documents?.pfNumber || "",
            };

            COLUMNS.forEach((col, colI) => {
                if (col.formula) return; // handled separately below
                const v = VALUES[col.header];
                const t = typeof v === "number" ? "n" : "s";
                ws[encode(r, colI)] = { v: v === undefined ? "" : v, t, s: ds };
            });

            // ── Salary formulas ───────────────────────────────────────────────
            const R = excelRow;
            if (salaryColIdx.basic >= 0)
                ws[encode(r, salaryColIdx.basic)] = { t: "n", f: `IF(${G_}${R}="","",ROUND(${G_}${R}*${basicPct / 100},0))`, s: fStyle };
            if (salaryColIdx.hra >= 0)
                ws[encode(r, salaryColIdx.hra)] = { t: "n", f: `IF(${G_}${R}="","",ROUND(${G_}${R}*${hraPct / 100},0))`, s: fStyle };
            if (salaryColIdx.epfEE >= 0)
                ws[encode(r, salaryColIdx.epfEE)] = { t: "n", f: `IF(${BA_}${R}="","",ROUND(MIN(${BA_}${R}*${eepfPct / 100},${epfCap}),0))`, s: fStyle };
            if (salaryColIdx.esicEE >= 0)
                ws[encode(r, salaryColIdx.esicEE)] = { t: "n", f: `IF(${BA_}${R}="","",IF(${BA_}${R}<=${esiLimit},CEILING(${BA_}${R}*${eeEsicPct / 100},1),0))`, s: fStyle };
            if (salaryColIdx.totDed >= 0)
                ws[encode(r, salaryColIdx.totDed)] = { t: "n", f: `IF(${EPF_}${R}="","",${EPF_}${R}+IF(${SEE_}${R}="",0,${SEE_}${R}))`, s: fStyle };
            if (salaryColIdx.net >= 0)
                ws[encode(r, salaryColIdx.net)] = { t: "n", f: `IF(${G_}${R}="","",MAX(${G_}${R}-IF(${TD_}${R}="",0,${TD_}${R}),0))`, s: fStyle };
            if (salaryColIdx.epfEE >= 0 && COLUMNS.findIndex(c => c.header === "EPF (Employer)") >= 0)
                ws[encode(r, COLUMNS.findIndex(c => c.header === "EPF (Employer)"))] = { t: "n", f: `IF(${EPF_}${R}="","",${EPF_}${R})`, s: fStyle };
            if (salaryColIdx.esicER >= 0)
                ws[encode(r, salaryColIdx.esicER)] = { t: "n", f: `IF(${BA_}${R}="","",IF(${BA_}${R}<=${esiLimit},CEILING(${BA_}${R}*${erEsicPct / 100},1),0))`, s: fStyle };
            // Food Allowance — fixed value
            if (salaryColIdx.food >= 0)
                ws[encode(r, salaryColIdx.food)] = { t: "n", f: `IF(${G_}${R}="","",${foodAmt})`, s: fStyle };
            if (salaryColIdx.ctc >= 0)
                ws[encode(r, salaryColIdx.ctc)] = { t: "n", f: `IF(${G_}${R}="","",${G_}${R}+IF(${EPF_}${R}="",0,${EPF_}${R})+IF(${SER_}${R}="",0,${SER_}${R})+IF(${FA_}${R}="",0,${FA_}${R}))`, s: fStyle };

            // ── Extra columns ─────────────────────────────────────────────────
            EXTRA_EXPORT_COLS.forEach((col, i) => {
                const v = col.getValue(emp);
                ws[encode(r, COLUMNS.length + i)] = { v: v || "", t: "s", s: ds };
            });
        });

        // ── !ref ──────────────────────────────────────────────────────────────
        const lastRow = 3 + employees.length; // 0-based last row index
        ws["!ref"] = XLSX.utils.encode_range({ r: 0, c: 0 }, { r: lastRow, c: totalCols - 1 });

        // ── Merges: banner + section headers ──────────────────────────────────
        const merges = [];
        // Row 1 full-width merge
        merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } });
        // Row 2 section header merges
        Object.entries(sectionSpans).forEach(([, span]) => {
            if (span.end > span.start) {
                merges.push({ s: { r: 1, c: span.start }, e: { r: 1, c: span.end } });
            }
        });
        ws["!merges"] = merges;

        // ── Column widths ─────────────────────────────────────────────────────
        const colWidths = COLUMNS.map(col => {
            const nameWidth = {
                "Employee Name": 28, "Father / Husband Name": 25,
                "Work Email": 32, "Personal Email": 28,
                "Department": 20, "Designation": 22,
                "Gross Salary": 14, "Basic Salary": 12, "HRA": 10,
                "EPF (Employee)": 14, "ESIC (Employee)": 14,
                "Total Deductions": 16, "Net Salary": 12,
                "EPF (Employer)": 14, "ESIC (Employer)": 14,
                "Employer Cost (CTC)": 18,
                "Aadhaar Number": 18, "Account Number": 18,
                "Street / Area": 22,
            };
            return { wch: nameWidth[col.header] || 14 };
        });
        EXTRA_EXPORT_COLS.forEach(() => colWidths.push({ wch: 18 }));
        ws["!cols"] = colWidths;

        // ── Row heights ───────────────────────────────────────────────────────
        const rowHeights = [
            { hpt: 24 },  // Row 1: banner
            { hpt: 18 },  // Row 2: sections
            { hpt: 36 },  // Row 3: headers (taller for wrap)
        ];
        for (let i = 0; i < employees.length; i++) rowHeights.push({ hpt: 18 });
        ws["!rows"] = rowHeights;

        // ── Freeze panes (top 3 rows + first column) ──────────────────────────
        ws["!freeze"] = { xSplit: 1, ySplit: 3 };

        // ── Workbook ──────────────────────────────────────────────────────────
        const wb_out = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb_out, ws, "Employee Import");

        // ── Export Info sheet ─────────────────────────────────────────────────
        const infoData = [
            ["EMPLOYEE EXPORT — INFORMATION", ""],
            ["", ""],
            ["Generated on", new Date().toLocaleString("en-IN")],
            ["Total employees", employees.length],
            ["Department filter", department !== "all" ? department : "All"],
            ["Search filter", search || "None"],
            ["", ""],
            ["— SALARY CONFIG USED —", ""],
            ["Basic %", `${cfg.basicPct ?? 50}%`],
            ["HRA %", `${cfg.hraPct ?? 50}%`],
            ["EPF Employee %", `${cfg.eepfPct ?? 12}%`],
            ["EPF Cap (₹)", cfg.epfCapAmount ?? 1800],
            ["ESI Wage Limit (₹)", cfg.esiWageLimit ?? 21000],
            ["ESIC Employee %", `${cfg.eeEsicPct ?? 0.75}%`],
            ["ESIC Employer %", `${cfg.erEsicPct ?? 3.25}%`],
            ["Food Allowance (₹)", cfg.foodAllowance ?? 1600],
            ["", ""],
            ["— RE-IMPORT NOTES —", ""],
            ["This file can be re-imported as-is.", ""],
            ["Auto-calc salary columns will be recalculated from Gross during import.", ""],
            ["Extra columns (Job Title, Religion etc.) are automatically detected.", ""],
        ];
        const infoSheet = XLSX.utils.aoa_to_sheet(infoData);
        infoSheet["!cols"] = [{ wch: 35 }, { wch: 25 }];
        // Style the title cell
        if (infoSheet["A1"]) {
            infoSheet["A1"].s = {
                fill: { fgColor: { rgb: "5B21B6" } },
                font: { bold: true, sz: 11, color: { rgb: "FFFFFF" }, name: "Arial" },
                alignment: { vertical: "center" },
            };
        }
        XLSX.utils.book_append_sheet(wb_out, infoSheet, "Export Info");

        const buffer = XLSX.write(wb_out, { type: "buffer", bookType: "xlsx", cellStyles: true });
        const dateStr = new Date().toISOString().split("T")[0];

        res.setHeader("Content-Disposition", `attachment; filename=employee_export_${dateStr}.xlsx`);
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.send(buffer);

    } catch (err) {
        console.error("Export error:", err);
        res.status(500).json({ success: false, message: err.message || "Export failed." });
    }
});

module.exports = router;