// services/operationCosting.js
//
// Costing a list of operations — turning "Collar attach, 1m 20s" into a
// rupee figure per piece.
//
// 2 Sept 2026, explicit request: when Sales approves a sample, R&D's
// submitted operations must land on the product "and also the operation wise
// cost... u can take reference from the department designation value of each
// and every operation defined in the operations schema".
//
// WHERE EACH PIECE COMES FROM
//   • the SAM (minutes + seconds) is what R&D typed on the sample;
//   • the salary BASIS (department + designation) is NOT typed per sample —
//     it is set once when the operation is registered
//     (Configurations/Operation.salaryDept / .salaryDesig, added 26 Aug 2026
//     precisely so "no need to do the department, designation selection for
//     each and every product"), so it is looked up from there by code first,
//     then by name;
//   • the SALARY is the average net salary of active employees on that
//     department/designation, decrypted the same way
//     stockItems.js's /data/salary-lookup does it.
//
// THE FORMULA IS THE STOCK-ITEM EDITOR'S OWN, deliberately duplicated rather
// than approximated: a month is 26 working days × 8 hours, so a minute of
// operator time costs `salary / 12480`. If that ever changes in
// app/sales/dashboard/stock-items/new-stock-item/[id]/page.js, it has to
// change here too or an approved sample will cost a product differently than
// the editor shows it.

"use strict";

const WORK_DAYS_PER_MONTH = 26;
const HOURS_PER_DAY = 8;
const MINUTES_PER_MONTH = WORK_DAYS_PER_MONTH * HOURS_PER_DAY * 60; // 12,480

/** SAM in minutes for one operation row. */
const samMinutes = (op) =>
  (Number(op?.minutes) || 0) + (Number(op?.seconds) || 0) / 60;

/**
 * Average NET salary for a department/designation, in rupees per month.
 *
 * Salaries are encrypted at rest (utils/salaryEncryption, keyed on
 * SALARY_ENCRYPTION_KEY), so this decrypts row by row and skips anything it
 * cannot read rather than failing the whole lookup — one unreadable payroll
 * record must not stop a sample being approved.
 */
async function avgSalaryFor(department, designation) {
  const Employee = require("../models/Employee");
  const { decryptSalaryFields } = require("../utils/salaryEncryption");

  const filter = { isActive: true };
  if (department) filter.department = department;
  if (designation) filter.designation = designation;
  if (!department && !designation) return 0;

  const employees = await Employee.find(filter).select("salary").lean();
  if (!employees.length) return 0;

  let total = 0;
  let counted = 0;
  for (const emp of employees) {
    try {
      const s = decryptSalaryFields(emp.salary || {});
      const net = parseFloat(s.netSalary) || 0;
      if (net > 0) { total += net; counted++; }
    } catch { /* unreadable record — skip */ }
  }
  return counted > 0 ? Math.round(total / counted) : 0;
}

/**
 * Resolve the salary basis + cost for every operation in a list.
 *
 * Returns a NEW array; the input is not mutated.
 *
 * THE SALARY BASIS IS RESOLVED IN THREE STEPS, most specific first:
 *   1. whatever the row already carries — R&D's picker copies the register's
 *      values onto the row at pick time, so this is usually the answer;
 *   2. the REGISTERED operation's own default (Configurations/Operation);
 *   3. `fallbackFrom` — the operations already on the product being
 *      overwritten, matched by code then name.
 *
 * Step 3 is not a nicety. Measured 2 Sept 2026 on live data: 0 of 259
 * registered operations carry a salary basis, while 2,883 of 2,886
 * operations ON PRODUCTS do. The basis was filled in per product, not on the
 * register. Without this fallback, approving one sample would blank the
 * salary basis on every operation of that product and zero its operations
 * cost — the change meant to ADD costing would have destroyed the costing
 * that already existed.
 *
 * Never throws: a costing failure returns the operations uncosted rather
 * than taking down the approval that triggered it. The caller decides
 * whether an uncosted operation is acceptable (it is — the operation itself
 * is the record; the money is derived).
 *
 * @param {Array} operations rows of { type, operationCode, minutes, seconds, … }
 * @param {{fallbackFrom?: Array}} [opts] operations to inherit a basis from
 * @returns {Promise<Array>} the same rows plus salaryDept/salaryDesig/
 *   operatorSalary/operatorCost
 */
async function costOperations(operations, { fallbackFrom = [] } = {}) {
  const rows = Array.isArray(operations) ? operations : [];
  if (!rows.length) return [];

  // Whatever the product already knows about this operation — its salary
  // basis, or failing that the figures it was already costed at. Keyed the
  // same two ways the register is.
  const priorByCode = new Map();
  const priorByName = new Map();
  for (const p of Array.isArray(fallbackFrom) ? fallbackFrom : []) {
    if (!p) continue;
    const usable = p.salaryDept || p.salaryDesig
      || Number(p.operatorSalary) > 0 || Number(p.operatorCost) > 0 || p.machineType;
    if (!usable) continue;
    const code = String(p.operationCode || "").trim();
    const name = String(p.type || "").trim().toLowerCase();
    if (code && !priorByCode.has(code)) priorByCode.set(code, p);
    if (name && !priorByName.has(name)) priorByName.set(name, p);
  }

  try {
    const Operation = require("../models/CMS_Models/Inventory/Configurations/Operation");

    // One query for every registered operation these rows could match,
    // rather than one per row.
    const codes = [...new Set(rows.map((o) => String(o.operationCode || "").trim()).filter(Boolean))];
    const names = [...new Set(rows.map((o) => String(o.type || "").trim()).filter(Boolean))];
    const registered = (codes.length || names.length)
      ? await Operation.find({
          $or: [
            ...(codes.length ? [{ operationCode: { $in: codes } }] : []),
            ...(names.length ? [{ name: { $in: names } }] : []),
          ],
        }).select("name operationCode salaryDept salaryDesig machineType").lean()
      : [];

    /* ── A CODE THAT NAMES TWO RECORDS NAMES NEITHER ──────────────────────
       The register genuinely holds duplicate codes (TS008 among them). This
       used to `set` in a loop, so the LAST record the database happened to
       return won — silently, and a different one could win tomorrow. Two
       operations under one code may carry different salary groups, which
       makes that an arbitrary choice of labour rate.

       Ambiguous codes are collected instead. A row matching one resolves to
       NOTHING here and is reported, so the caller refuses rather than costs
       against a coin toss. Names are handled the same way for the same
       reason. Nothing is merged or deleted: reconciling two real records is a
       production decision, not this function's. */
    const byCode = new Map();
    const byName = new Map();
    const ambiguousCodes = new Set();
    const ambiguousNames = new Set();
    for (const r of registered) {
      if (r.operationCode) {
        if (byCode.has(r.operationCode)) ambiguousCodes.add(r.operationCode);
        else byCode.set(r.operationCode, r);
      }
      if (r.name) {
        const key = r.name.toLowerCase();
        if (byName.has(key)) ambiguousNames.add(key);
        else byName.set(key, r);
      }
    }
    /* An ambiguous key resolves to nothing at all — keeping the first would
       be the same arbitrary pick wearing a different hat. */
    for (const c of ambiguousCodes) byCode.delete(c);
    for (const n of ambiguousNames) byName.delete(n);

    // Salary lookups are the expensive part and repeat heavily across rows
    // (most operations on a garment share one department), so each distinct
    // dept|desig pair is resolved once.
    const salaryCache = new Map();
    const salaryFor = async (dept, desig) => {
      const key = `${dept || ""}|${desig || ""}`;
      if (salaryCache.has(key)) return salaryCache.get(key);
      const value = await avgSalaryFor(dept, desig);
      salaryCache.set(key, value);
      return value;
    };

    const out = [];
    for (const op of rows) {
      const code = String(op.operationCode || "").trim();
      const name = String(op.type || "").trim().toLowerCase();
      /* ── STABLE IDENTITY FIRST, CODE ONLY AS A FALLBACK ────────────────
         A row that already carries the registered record's id says exactly
         which operation it is, and no duplicate code can confuse it. Codes
         are matched only when there is no id — which is every row written
         before identity was recorded. */
      const byIdMatch = op.operationId
        ? registered.find((r) => String(r._id) === String(op.operationId))
        : null;
      const match =
        byIdMatch ||
        (code && byCode.get(code)) ||
        (name && byName.get(name)) ||
        null;
      /* Named so the caller can say WHICH code is ambiguous rather than
         reporting an operation that simply "could not be costed". */
      /* Identity precedence also governs ambiguity. A unique exact code is a
         complete match even when another registered operation happens to
         share its display name under a different code. Name ambiguity matters
         only when no usable code match exists. */
      const ambiguous = !byIdMatch && (
        (code && ambiguousCodes.has(code))
        || (!(code && byCode.has(code)) && name && ambiguousNames.has(name))
      );
      const prior =
        (code && priorByCode.get(code)) ||
        (name && priorByName.get(name)) ||
        null;

      const salaryDept = String(op.salaryDept || match?.salaryDept || prior?.salaryDept || "").trim();
      const salaryDesig = String(op.salaryDesig || match?.salaryDesig || prior?.salaryDesig || "").trim();
      const machineType = String(op.machineType || match?.machineType || prior?.machineType || "").trim();

      // NEVER REPLACE A REAL FIGURE WITH ZERO. Measured 2 Sept 2026: no
      // registered operation and no product operation carries a salary
      // basis, yet 179 product operations DO carry a non-zero cost — entered
      // some other way. Costing that resolves to nothing must leave those
      // alone, or "add operation costing" would read as "wipe the costing
      // that was there".
      let operatorSalary = (salaryDept || salaryDesig)
        ? await salaryFor(salaryDept, salaryDesig)
        : 0;
      if (!operatorSalary && Number(prior?.operatorSalary) > 0) {
        operatorSalary = Number(prior.operatorSalary);
      }

      let operatorCost = operatorSalary > 0
        ? Number(((operatorSalary / MINUTES_PER_MONTH) * samMinutes(op)).toFixed(2))
        : 0;
      // Nothing to price from at all, but the product had a cost recorded —
      // keep it, and only while the timing it was priced against is
      // unchanged. A cost against a different SAM is not the same cost.
      if (!operatorCost
          && Number(prior?.operatorCost) > 0
          && Math.abs(samMinutes(op) - samMinutes(prior)) < 1e-6) {
        operatorCost = Number(prior.operatorCost);
      }

      out.push({
        ...op,
        /* The identity that was actually resolved, carried forward so the next
           read never has to match on a code again. */
        ...(match ? { operationId: match._id } : {}),
        machineType, salaryDept, salaryDesig, operatorSalary, operatorCost,
        /* ── SET *OR* CLEARED, NEVER LEFT ────────────────────────────────
           Stamped so downstream can refuse with the exact code rather than a
           generic failure. Written on EVERY row, including as an empty
           string, because `...op` above carries a previous run's marker
           forward — and a row that was ambiguous last time and is fine now
           would otherwise stay blocked after the manager had already
           reconciled the duplicate. */
        ambiguousOperationCode: ambiguous ? (code || op.type || "") : "",
      });
    }
    return out;
  } catch (err) {
    console.error("[operationCosting] costing failed, returning uncosted:", err.message);
    return rows.map((op) => ({ ...op }));
  }
}

module.exports = { costOperations, avgSalaryFor, samMinutes, MINUTES_PER_MONTH };
