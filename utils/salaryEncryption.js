/**
 * salaryEncryption.js
 *
 * AES-256-GCM field-level encryption for salary data stored in MongoDB.
 *
 * WHY AES-256-GCM:
 *   - Industry standard authenticated encryption (not just scrambling)
 *   - GCM mode detects tampering (auth tag) — you know if data was modified
 *   - Each value gets a unique random IV so two employees with the same salary
 *     produce completely different ciphertext in the DB
 *   - Reversible: HR can still read and update the actual numbers
 *   - Fast: sub-millisecond per field
 *
 * SETUP:
 *   Add to your .env:
 *     SALARY_ENCRYPTION_KEY=<64 hex chars = 32 bytes>
 *
 *   Generate a key once:
 *     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * WHAT IS ENCRYPTED:
 *   Employee model salary fields only (gross, basic, hra, etc.)
 *   PayrollItem is NOT encrypted (derived data, schema compatibility, performance)
 *
 * HOW IT WORKS IN MONGO:
 *   { "salary.gross": "enc:a1b2c3...:iv...:tag..." }
 *   The "enc:" prefix lets us detect encrypted vs legacy plain-number fields
 *   so old records degrade gracefully without crashing.
 */

"use strict";

const crypto = require("crypto");

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;   // 96-bit IV — recommended for GCM
const TAG_BYTES = 16;   // 128-bit auth tag — GCM default
const PREFIX = "enc:";

// Salary fields that should be encrypted (Employee model only)
const SALARY_NUM_FIELDS = [
    "gross", "basic", "hra", "specialAllowance",
    "epf", "edli", "adminCharges",
    "eeesic", "erEsic", "foodAllowance",
    "employerCost", "totalDeduction", "netSalary",
    "allowances", "deductions",
];

// ─── Key management ──────────────────────────────────────────────────────────

let _cachedKey = null;

function getKey() {
    if (_cachedKey) return _cachedKey;
    const hex = process.env.SALARY_ENCRYPTION_KEY;
    if (!hex) {
        throw new Error(
            "SALARY_ENCRYPTION_KEY is not set in .env. " +
            "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
        );
    }
    if (hex.length !== 64) {
        throw new Error(
            `SALARY_ENCRYPTION_KEY must be 64 hex characters (32 bytes), got ${hex.length}`
        );
    }
    _cachedKey = Buffer.from(hex, "hex");
    return _cachedKey;
}

// ─── Primitives ──────────────────────────────────────────────────────────────

/**
 * Encrypt a numeric value.
 * Returns a string like:  enc:<cipherHex>:<ivHex>:<tagHex>
 */
function encryptNumber(num) {
    if (num === null || num === undefined || num === "") return null;
    const plaintext = String(num);            // "7000"
    const key = getKey();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${encrypted.toString("hex")}:${iv.toString("hex")}:${tag.toString("hex")}`;
}

/**
 * Decrypt an encrypted salary string back to a number.
 * Returns the original Number, or 0 if the value is empty / can't decrypt.
 *
 * If the value is already a plain number (legacy doc before encryption was
 * added), it is returned as-is — so old records still work.
 */
function decryptNumber(val) {
    if (val === null || val === undefined || val === "") return 0;

    // Plain number — legacy record or value was 0 and never encrypted
    if (typeof val === "number") return val;

    const str = String(val);

    // Not encrypted (legacy plain-number stored as string, or 0)
    if (!str.startsWith(PREFIX)) {
        const n = Number(str);
        return isNaN(n) ? 0 : n;
    }

    try {
        const parts = str.slice(PREFIX.length).split(":");
        if (parts.length !== 3) return 0;
        const [encHex, ivHex, tagHex] = parts;
        const key = getKey();
        const iv = Buffer.from(ivHex, "hex");
        const tag = Buffer.from(tagHex, "hex");
        const encBuf = Buffer.from(encHex, "hex");
        const decipher = crypto.createDecipheriv(ALGO, key, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([
            decipher.update(encBuf),
            decipher.final(),
        ]);
        return Number(decrypted.toString("utf8"));
    } catch (e) {
        console.error("[salaryEncryption] decryptNumber failed:", e.message);
        return 0;
    }
}

// ─── Object-level helpers ────────────────────────────────────────────────────

/**
 * Encrypt all numeric salary fields in a salary sub-object.
 * Non-salary keys (edliOverride, adminOverride) are passed through unchanged.
 *
 * @param  {Object} salaryObj  e.g. req.body.salary or employee.salary
 * @returns {Object}           same shape but with encrypted string values
 */
function encryptSalaryFields(salaryObj) {
    if (!salaryObj || typeof salaryObj !== "object") return salaryObj;
    const result = { ...salaryObj };
    for (const field of SALARY_NUM_FIELDS) {
        if (field in result && result[field] !== undefined && result[field] !== null) {
            // Skip 0 values — storing "0" encrypted wastes space and still reveals nothing
            result[field] = result[field] === 0 ? 0 : encryptNumber(result[field]);
        }
    }
    return result;
}

/**
 * Decrypt all encrypted salary fields in a salary sub-object.
 * Returns plain numbers so the rest of the code (recalculation, payslip
 * generation) works without any changes.
 *
 * @param  {Object} salaryObj  salary sub-doc from MongoDB (may have enc: strings)
 * @returns {Object}           same shape with numeric values restored
 */
function decryptSalaryFields(salaryObj) {
    if (!salaryObj || typeof salaryObj !== "object") return salaryObj;
    const result = typeof salaryObj.toObject === "function" ? salaryObj.toObject() : { ...salaryObj };
    for (const field of SALARY_NUM_FIELDS) {
        if (field in result) {
            result[field] = decryptNumber(result[field]);
        }
    }
    return result;
}

/**
 * Decrypt salary from a full employee document (plain object or Mongoose doc).
 * Safe to call even if the employee has no salary sub-doc.
 *
 * @param  {Object} employeeDoc
 * @returns {Object}  new object with salary decrypted
 */
function decryptEmployeeDoc(employeeDoc) {
    if (!employeeDoc) return employeeDoc;
    const doc = typeof employeeDoc.toObject === "function"
        ? employeeDoc.toObject({ virtuals: true })
        : { ...employeeDoc };

    if (doc.salary) {
        doc.salary = decryptSalaryFields(doc.salary);
    }
    return doc;
}

/**
 * Decrypt salary from an array of employee documents.
 */
function decryptEmployeeDocs(docs) {
    if (!Array.isArray(docs)) return docs;
    return docs.map(decryptEmployeeDoc);
}

// ─── Migration helper ────────────────────────────────────────────────────────

/**
 * Returns true if a salary object has already been encrypted
 * (i.e. contains at least one "enc:" prefixed string).
 */
function isEncrypted(salaryObj) {
    if (!salaryObj) return false;
    return SALARY_NUM_FIELDS.some(
        f => typeof salaryObj[f] === "string" && salaryObj[f].startsWith(PREFIX)
    );
}

/**
 * Migrate all existing employees in MongoDB from plain-number salary storage
 * to encrypted storage.
 *
 * Call this ONCE after deploying:
 *   const { migrateSalaryData } = require("./salaryEncryption");
 *   await migrateSalaryData();
 *
 * Idempotent — already-encrypted records are skipped.
 */
async function migrateSalaryData() {
    const Employee = require("../models/Employee");
    const employees = await Employee.find({}).select("salary").lean();
    let migrated = 0, skipped = 0, errors = 0;

    for (const emp of employees) {
        if (!emp.salary || isEncrypted(emp.salary)) { skipped++; continue; }
        try {
            const encrypted = encryptSalaryFields(emp.salary);
            await Employee.updateOne({ _id: emp._id }, { $set: { salary: encrypted } });
            migrated++;
        } catch (e) {
            console.error(`[migrate] ${emp._id}: ${e.message}`);
            errors++;
        }
    }

    console.log(`[salaryEncryption] migration done: ${migrated} migrated, ${skipped} skipped, ${errors} errors`);
    return { migrated, skipped, errors };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    encryptNumber,
    decryptNumber,
    encryptSalaryFields,
    decryptSalaryFields,
    decryptEmployeeDoc,
    decryptEmployeeDocs,
    isEncrypted,
    migrateSalaryData,
    SALARY_NUM_FIELDS,
};