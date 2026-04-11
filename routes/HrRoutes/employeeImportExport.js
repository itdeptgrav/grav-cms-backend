/**
 * Employee Import / Export Routes
 * Mount at: /api/employees/import-export
 *
 * GET  /template          → download static .xlsx template
 * POST /import/preview    → parse uploaded .xlsx → structured preview
 * POST /import/confirm    → save to MongoDB
 *
 * DYNAMIC EXTRA COLUMNS
 * ---------------------
 * Any column in the Excel that is NOT in the standard HEADER_MAP is checked
 * against EXTRA_FIELD_MAP. If matched, the value is applied to the correct
 * Employee schema field automatically. This lets HR add columns like "Title",
 * "Religion", "Spouse Name" etc. to the template without backend changes.
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
// STANDARD HEADER MAP
// These are the columns in the official template (v4).
// Normalised header text (no trailing *) → internal field key.
// ─────────────────────────────────────────────────────────────────────────────
const HEADER_MAP = {
    "Employee Name": "employeeName",
    "Father / Husband Name": "fatherName",
    "Gender": "gender",
    "Date of Birth": "dateOfBirth",
    "Mobile Number": "phone",
    "Alternate Phone": "alternatePhone",
    "Personal Email": "personalEmail",
    "Work Email": "workEmail",
    "Marital Status": "maritalStatus",
    "Blood Group": "bloodGroup",
    "Nationality": "nationality",
    "Physically Challenged": "physicallyChallenged",
    "Street / Area": "currStreet",
    "City": "currCity",
    "State": "currState",
    "Pincode": "currPincode",
    "Biometric ID": "biometricId",
    "Date of Joining": "dateOfJoining",
    "Department": "department",
    "Designation": "designation",
    "Employee Type": "employeeType",
    "Work Location": "workLocation",
    "Shift": "shift",
    "Is Director": "isDirector",
    "Needs to Operate": "needsToOperate",
    "Bank Name": "bankName",
    "Account Number": "accountNumber",
    "IFSC Code": "ifscCode",
    "Account Type": "accountType",
    "Gross Salary": "grossSalary",
    // Auto-calc salary cols — parsed but server always recalculates from Gross
    "Basic Salary": "_skip",
    "HRA": "_skip",
    "EPF (Employee)": "_skip",
    "ESIC (Employee)": "_skip",
    "Total Deductions": "_skip",
    "Net Salary": "_skip",
    "EPF (Employer)": "_skip",
    "ESIC (Employer)": "_skip",
    "Food Allowance": "_skip",
    "Employer Cost (CTC)": "_skip",
    "Aadhaar Number": "aadhaarNumber",
    "PAN Number": "panNumber",
    "UAN Number": "uanNumber",
    "ESI Number": "esiNumber",
    "PF Number": "pfNumber",
};

// ─────────────────────────────────────────────────────────────────────────────
// EXTRA / OPTIONAL FIELD MAP
// Any column NOT in HEADER_MAP is checked against this map.
// If found, the value is applied to the Employee document automatically.
//
// Format: "Normalised Column Header" → { field, type, nested? }
//   type:   "string" | "date" | "number" | "bool" | "enum"
//   nested: which top-level field holds this (for bankDetails sub-fields)
// ─────────────────────────────────────────────────────────────────────────────
const EXTRA_FIELD_MAP = {
    // Personal — removed from standard template but accepted if HR adds them
    "Title": { field: "title", type: "enum", values: ["Mr.", "Mrs.", "Ms.", "Dr.", ""] },
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
    // Work — optional extras
    "Identity ID": { field: "identityId", type: "string" },
    "Job Position": { field: "jobPosition", type: "string" },
    "Job Title": { field: "jobTitle", type: "string" },
    "Confirmation Date": { field: "confirmationDate", type: "date" },
    "Probation Period": { field: "probationPeriod", type: "number" },
    "Probation Period (Months)": { field: "probationPeriod", type: "number" },
    "Extension": { field: "extension", type: "string" },
    // Bank — nested extras
    "Branch Name": { field: "branchName", type: "string", nested: "bankDetails" },
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

// Strips commas/₹ — xlsx.js with raw:false may format numbers as "28,000"
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
};
const ACCT_TYPE_MAP = { savings: "savings", current: "current" };
const TITLE_MAP = {
    "mr.": "Mr.", mr: "Mr.", "mrs.": "Mrs.", mrs: "Mrs.",
    "ms.": "Ms.", ms: "Ms.", "dr.": "Dr.", dr: "Dr."
};

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

/**
 * Apply a value from an EXTRA_FIELD_MAP entry onto the employee object.
 * Handles string, date, number, bool, enum types.
 * For nested="bankDetails", writes into emp.bankDetails instead of top-level.
 */
const applyExtraField = (emp, meta, rawValue) => {
    if (rawValue === undefined || rawValue === null) return;
    const s = String(rawValue).trim();
    if (!s) return;

    let value;
    switch (meta.type) {
        case "date": value = parseDate(s); break;
        case "number": value = toNum(s); break;
        case "bool": value = toBool(s); break;
        case "enum":
            // Map to valid enum value — if the raw string isn't recognised, skip (return null → don't write)
            value = TITLE_MAP[s.toLowerCase()] ?? null;
            break;
        default: value = s;
    }

    // null or undefined means the value couldn't be mapped — don't write garbage to the document
    if (value === undefined || value === null) return;
    // Skip empty strings too (except explicit boolean false which is valid)
    if (typeof value !== "boolean" && value === "") return;

    if (meta.nested === "bankDetails") {
        emp.bankDetails[meta.field] = value;
    } else {
        emp[meta.field] = value;
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PARSE SHEET
// Template structure:
//   Row 1 = company banner  → skip
//   Row 2 = section banners → skip
//   Row 3 = column headers  → range:2 (0-based) uses as key row
//   Row 4+ = data
// ─────────────────────────────────────────────────────────────────────────────
const parseSheet = async (buffer) => {
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: true, raw: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];

    const raw = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "", range: 2 });
    if (!raw || raw.length === 0) {
        throw new Error("No data rows found. Make sure you are using the correct template.");
    }

    // Build normalised-header → xlsx-object-key lookup
    const normKeyMap = {};
    for (const key of Object.keys(raw[0])) {
        normKeyMap[normalizeHeader(key)] = key;
    }

    // Identify any extra columns that exist in the file but are not in HEADER_MAP
    // Check each against EXTRA_FIELD_MAP
    const standardNorms = new Set(Object.keys(HEADER_MAP).map(normalizeHeader));
    const extraColumns = []; // [{ normHeader, xlsxKey, meta }]

    for (const [normHeader, xlsxKey] of Object.entries(normKeyMap)) {
        if (standardNorms.has(normHeader)) continue;
        // Check EXTRA_FIELD_MAP (also normalise those keys for matching)
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

        // Map standard headers
        const row = {};
        for (const [rawHeader, fieldKey] of Object.entries(HEADER_MAP)) {
            if (fieldKey === "_skip") continue;
            const xlsxKey = normKeyMap[normalizeHeader(rawHeader)];
            row[fieldKey] = xlsxKey !== undefined
                ? String(rawRow[xlsxKey] ?? "").trim()
                : "";
        }

        const excelRow = i + 4;
        const employeeNum = i + 1;
        const rowErrors = [];

        if (!row.employeeName) rowErrors.push("Employee Name is required");
        if (!row.biometricId) rowErrors.push("Biometric ID is required");
        if (!row.department) rowErrors.push("Department is required");
        if (!row.designation) rowErrors.push("Designation is required");
        if (!row.phone) rowErrors.push("Mobile Number is required");
        if (!row.gender) rowErrors.push("Gender is required");

        // Split full name
        const nameParts = (row.employeeName || "").trim().split(/\s+/);
        const firstName = nameParts[0] || "";
        const lastName = nameParts.slice(1).join(" ") || "";

        // Salary
        const gross = toNum(row.grossSalary);
        const salary = recalcSalary(gross, cfg);

        const emp = {
            _excelRow: excelRow,
            _employeeNum: employeeNum,
            _errors: rowErrors,
            _extraFields: extraColumns.map(c => ({        // metadata for UI display
                column: c.normHeader,
                field: c.meta.field,
                value: String(rawRow[c.xlsxKey] ?? "").trim(),
            })).filter(x => x.value),
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

        // Apply extra columns onto emp
        for (const { xlsxKey, meta } of extraColumns) {
            const rawValue = String(rawRow[xlsxKey] ?? "").trim();
            applyExtraField(emp, meta, rawValue);
        }

        rows.push(emp);
        if (rowErrors.length > 0) errors.push({ row: excelRow, employeeNum, errors: rowErrors });
    }

    const extraDetected = extraColumns.map(c => ({
        column: c.normHeader,
        schemaField: c.meta.field,
    }));

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
                extraDetected,   // tells UI which extra columns were found & mapped
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

                // Build empData from all fields on row (extra fields already applied during parseSheet)
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

module.exports = router;