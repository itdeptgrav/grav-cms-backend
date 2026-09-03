// services/salaryResync.js
//
// When a salary rule changes, everybody it applies to changes with it.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Each employee's salary is STORED, not derived on read — encrypted component
// by component on the employee document. That is deliberate (payroll reads it,
// and it must not silently move under a payslip already issued), but it means
// editing a company-wide rule changed nothing at all on its own: the new EDLI
// ceiling applied only to whoever HR happened to open and re-save afterwards.
// A rule the company sets has to reach the people it governs without anyone
// re-typing 105 records.
//
// ── WHAT IT WILL NOT TOUCH ──────────────────────────────────────────────────
//   - Overrides. An `epfOverride` / `edliOverride` / `adminOverride` is a
//     deliberate statement about one person; a company rule does not overrule
//     it. The formula already honours them, so a resync leaves those figures
//     exactly where HR put them.
//   - Gross. Nothing here decides what anybody is paid. Gross and stipend are
//     inputs; only the figures DERIVED from them are rewritten.
//   - Interns. Their branch has no rule inputs to respond to.
//   - Anyone whose numbers do not move. A no-op employee is not written, so
//     the resync does not churn `updatedAt` across the company or fill the
//     audit log with rows where nothing changed.
//
// ── EVERY PERSON WHOSE PAY MOVED GETS THEIR OWN HISTORY ENTRY ───────────────
// One line saying "applied to 88 employees" is not an answer to "why is my
// EDLI different this month". Each employee whose figures moved gets an entry
// on their OWN record, field by field, flagged `critical` because it is pay.
// Employees who did not move get nothing — an entry saying a record was
// touched and unchanged is noise in the one log that must stay readable.
//
// ── IT IS NOT RETROACTIVE ───────────────────────────────────────────────────
// This rewrites the employee's STANDING salary — what they are paid from now
// on. It does not touch a payroll run, so months already processed keep the
// figures they were processed with. `effectiveFrom` records which month the
// new rules start applying to, and every entry says so.
//
// ── IT REPORTS BEFORE IT COMMITS ────────────────────────────────────────────
// `dryRun: true` returns exactly what would change, per employee and per
// field, writing nothing. The settings screen uses it to show the impact
// BEFORE the rule is saved, because "this will change 47 people's CTC" is the
// thing an HR manager needs in order to decide, and finding out afterwards is
// not a decision.

"use strict";

const Employee = require("../models/Employee");
const SalaryConfig = require("../models/Salaryconfig");
const { computeSalary } = require("./salaryFormula");
const {
  encryptSalaryFields,
  decryptSalaryFields,
} = require("../utils/salaryEncryption");

/* The derived figures a rule change can move. Gross, stipend and the override
   flags are deliberately absent — those are inputs, not outputs. */
const DERIVED = [
  "basic",
  "hra",
  "epf",
  "edli",
  "adminCharges",
  "eeesic",
  "erEsic",
  "foodAllowance",
  "employerCost",
  "totalDeduction",
  "netSalary",
  "allowances",
  "deductions",
];

/** What each derived figure is called on the salary form. */
const FIELD_LABELS = {
  basic: "Basic",
  hra: "HRA",
  epf: "EPF",
  edli: "EDLI",
  adminCharges: "PF Admin Charges",
  eeesic: "ESIC (Employee)",
  erEsic: "ESIC (Employer)",
  foodAllowance: "Food Allowance",
  employerCost: "CTC / Employer Cost",
  totalDeduction: "Total Deductions",
  netSalary: "Net Salary",
  allowances: "Allowances",
  deductions: "Deductions",
};

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Recompute every staff salary against the current (or a proposed) config.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun]  report only; write nothing
 * @param {object}  [opts.config]  a config to test INSTEAD of the saved one,
 *                                 so the screen can preview an unsaved edit
 * @returns {{scanned,changed,skipped,employees:Array}}
 */
async function resyncAllSalaries({ dryRun = false, config = null, req = null } = {}) {
  const { recordChange } = require("./changeLog");
  /* The month the new rules take effect from. Payroll for earlier months is
     already processed and is not revisited, so this is a statement of fact
     rather than a setting. */
  const now = new Date();
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];
  const effectiveFrom = `${MONTHS[now.getMonth()]} ${now.getFullYear()}`;

  const cfgDoc = config || (await SalaryConfig.getSingleton());
  const cfg = cfgDoc.toObject ? cfgDoc.toObject() : cfgDoc;

  const staff = await Employee.find({
    $or: [{ isActive: { $ne: false } }, { status: "active" }],
  })
    .select("firstName lastName biometricId employmentType salary")
    .lean();

  const employees = [];
  let changed = 0;
  let skipped = 0;

  for (const emp of staff) {
    if (emp.employmentType === "intern") {
      skipped += 1;
      continue;
    }

    const before = decryptSalaryFields(emp.salary || {});
    /* No gross means nothing to derive from — an incomplete record, not one
       this rule change has an opinion about. */
    if (!money(before.gross)) {
      skipped += 1;
      continue;
    }

    const after = computeSalary(before, cfg, emp.employmentType);

    const fields = [];
    for (const key of DERIVED) {
      const from = money(before[key]);
      const to = money(after[key]);
      if (from !== to) fields.push({ key, from, to });
    }
    if (!fields.length) {
      skipped += 1;
      continue;
    }

    changed += 1;
    employees.push({
      id: String(emp._id),
      name: [emp.firstName, emp.lastName].filter(Boolean).join(" ").trim(),
      biometricId: emp.biometricId || "",
      fields,
    });

    if (!dryRun) {
      const encrypted = encryptSalaryFields(after);
      // The override flags are booleans and are never encrypted.
      encrypted.epfOverride = after.epfOverride;
      encrypted.edliOverride = after.edliOverride;
      encrypted.adminOverride = after.adminOverride;
      /* updateOne, not save(): the pre-save hook would recompute from the
         config all over again, which is the same answer at twice the cost, and
         it would fire every other hook on the document for a change that only
         touches salary. */
      await Employee.updateOne(
        { _id: emp._id },
        { $set: { salary: encrypted, updatedAt: new Date() } },
      );

      /* On the EMPLOYEE's own record, so it shows up where somebody looking at
         that person would find it — not only on the settings page.

         `fields` is passed explicitly rather than letting recordChange diff
         before/after: the salary object is encrypted at rest, so a diff of the
         raw documents would compare ciphertext and report every field as
         changed. These are the decrypted numbers, already narrowed to the ones
         that moved. */
      await recordChange(req, {
        departmentSlug: "hr",
        section: "hr:employees",
        entity: "employee",
        entityId: String(emp._id),
        entityLabel:
          [emp.firstName, emp.lastName].filter(Boolean).join(" ").trim() ||
          emp.biometricId ||
          "",
        action: "update",
        origin: "system",
        critical: true,
        fields: fields.map((f) => ({
          path: `salary.${f.key}`,
          label: FIELD_LABELS[f.key] || f.key,
          from: f.from,
          to: f.to,
          kind: "changed",
        })),
        summary:
          `Salary recalculated from the company rules, effective ${effectiveFrom}. ` +
          `${fields.length} figure${fields.length === 1 ? "" : "s"} changed. ` +
          `Payroll already processed for earlier months is unchanged.`,
      });
    }
  }

  return { scanned: staff.length, changed, skipped, employees, effectiveFrom };
}

module.exports = { resyncAllSalaries, DERIVED };
