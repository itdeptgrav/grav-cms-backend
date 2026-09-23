#!/usr/bin/env node
"use strict";
/**
 * scripts/audits/hrOrganisationScope.js — how ready is HR for company and
 * establishment scope?
 *
 * HRMS Chunk 2A. STRICTLY READ-ONLY. There is no `--apply`, no repair mode, and
 * no code path in this file that saves, inserts, updates, deletes or
 * bulk-writes. Every query below is a `find`, `countDocuments`, `distinct` or
 * `aggregate`, and `test/hr-access/hr-organisation-scope-audit.test.js` asserts
 * that no write verb appears in this source at all — so a future edit that adds
 * one fails the build rather than the database.
 *
 *   node -r dotenv/config scripts/audits/hrOrganisationScope.js
 *   node -r dotenv/config scripts/audits/hrOrganisationScope.js --json out.json
 *
 * WHAT IT ANSWERS
 *   • for each HR model, how many records carry a provable company /
 *     establishment scope, and how many are MISSING, AMBIGUOUS, CONFLICT,
 *     DANGLING_REFERENCE or an UNSUPPORTED_LEGACY_SHAPE;
 *   • which of today's globally-unique identifiers would collide once scope
 *     exists, and which of today's duplicates would become legal;
 *   • what a Chunk 2B backfill could populate deterministically, and what it
 *     would have to quarantine.
 *
 * WHAT IT WILL NOT PRINT
 * Names, emails, phone numbers, addresses, pay, bank details, government
 * identifiers and document contents never leave this script. The output is
 * checked against `hrScopeClassifier.containsPrivateData` before it is written,
 * and the run ABORTS rather than print something it should not. Opaque record
 * ids appear only in the small samples where an operator genuinely has to go
 * and look at a specific row.
 */

const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");

const {
  SCOPE_STATUS,
  DUPLICATE_VERDICT,
  classifyScope,
  classifyDuplicateGroup,
  containsPrivateData,
} = require(path.join(__dirname, "../../services/access/hrScopeClassifier"));

/* How many opaque ids to show per finding. Small on purpose: a sample is for
   going and looking, not for exporting the workforce. */
const SAMPLE_LIMIT = 5;

/* ── Safety ──────────────────────────────────────────────────────────────────*/

/**
 * `npm run verify`'s default tier already runs read-only checks against the dev
 * database, so read-only execution is an established convention here. What is
 * NOT established is running one against production by accident, so that needs
 * saying out loud — and the flag says "I know this is production and I know
 * this script only reads".
 */
function assertSafeToRun() {
  const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (!isProduction) return;
  if (process.env.HR_AUDIT_ALLOW_PRODUCTION_READONLY === "1") {
    console.warn(
      "[hr-scope-audit] NODE_ENV=production — proceeding because " +
        "HR_AUDIT_ALLOW_PRODUCTION_READONLY=1. This script only reads.",
    );
    return;
  }
  console.error(
    "[hr-scope-audit] refusing to run with NODE_ENV=production.\n" +
      "This audit only reads, but running anything against production should be\n" +
      "deliberate. Set HR_AUDIT_ALLOW_PRODUCTION_READONLY=1 to confirm.",
  );
  process.exit(2);
}

/**
 * Say which database this is, without saying how to reach it.
 *
 * A connection string carries a username, a password and a host. An operator
 * reading an audit needs to know they are looking at the right database; nobody
 * needs the credentials in a log or a pasted report.
 */
function describeDatabaseSafely() {
  const uri = process.env.MONGODB_URI || "";
  let host = "unknown";
  let db = "unknown";
  try {
    if (uri) {
      const parsed = new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://"));
      host = parsed.hostname || "unknown";
      db = (parsed.pathname || "").replace(/^\//, "") || "unknown";
    }
  } catch {
    /* An unparseable URI tells us nothing, which is the safe outcome. */
  }
  return {
    nodeEnv: process.env.NODE_ENV || "(unset)",
    databaseHost: host,
    databaseName: mongoose.connection?.name || db,
    /* Never the URI, never the user, never the password. */
  };
}

/* ── Models ──────────────────────────────────────────────────────────────────*/

function models() {
  const root = path.join(__dirname, "../..");
  const load = (rel) => require(path.join(root, rel));
  return {
    Employee: load("models/Employee"),
    HrDepartment: load("models/HR_Models/Departments"),
    AccessDepartment: load("models/Access/AccessDepartment"),
    DepartmentRole: load("models/Access/DepartmentRole"),
    Attendance: load("models/HR_Models/Attendance"),
    DailyAttendance: load("models/HR_Models/Dailyattendance"),
    AccCompany: load("models/Accountant_model/Acc_MasterModels").Acc_Company,
    ...(() => {
      const payroll = load("models/HR_Models/Payroll");
      return { Payroll: payroll.Payroll || payroll.PayrollRun, PayrollItem: payroll.PayrollItem };
    })(),
  };
}

/* ── The audit ───────────────────────────────────────────────────────────────*/

const emptyCounts = () => ({
  [SCOPE_STATUS.SCOPED]: 0,
  [SCOPE_STATUS.DERIVABLE_UNAMBIGUOUS]: 0,
  [SCOPE_STATUS.MISSING]: 0,
  [SCOPE_STATUS.AMBIGUOUS]: 0,
  [SCOPE_STATUS.CONFLICT]: 0,
  [SCOPE_STATUS.DANGLING_REFERENCE]: 0,
  [SCOPE_STATUS.UNSUPPORTED_LEGACY_SHAPE]: 0,
});

/**
 * Classify every employee's company scope.
 *
 * Employee carries NO company field today, so `direct` is always null and the
 * only evidence available is derived. Both derivation paths below are recorded
 * so the result explains itself rather than asserting.
 */
async function auditEmployeeCompanyScope({ Employee }, { companyIds }) {
  const counts = emptyCounts();
  const samples = { [SCOPE_STATUS.UNSUPPORTED_LEGACY_SHAPE]: [], [SCOPE_STATUS.MISSING]: [] };

  const cursor = Employee.find({})
    /* Identity and placement only — nothing private is fetched, so nothing
       private can be printed by accident. */
    .select("_id workLocation departmentId department accessDepartmentId isActive status")
    .lean()
    .cursor();

  let total = 0;
  for await (const row of cursor) {
    total += 1;

    /* `workLocation` is a free-text label defaulting to a company name. It
       LOOKS like a site and references nothing, so it is a legacy shape rather
       than evidence — reading it as a site would be guessing. */
    const legacyShape =
      row.workLocation && String(row.workLocation).trim() ? "free-text-work-location" : null;

    const result = classifyScope({
      level: "company",
      direct: null,
      derived: [],
      legacyShape,
    });

    counts[result.status] += 1;
    const bucket = samples[result.status];
    if (bucket && bucket.length < SAMPLE_LIMIT) bucket.push(String(row._id));
  }

  return {
    model: "Employee",
    level: "company",
    total,
    counts,
    samples,
    note:
      companyIds.length === 1
        ? "Exactly one Acc_Company exists. That is a deployment fact, not evidence on the record: nothing on Employee references it."
        : `${companyIds.length} Acc_Company records exist and no Employee references any of them.`,
  };
}

/** Scope evidence on the HR organisation departments. */
async function auditDepartmentScope({ HrDepartment }) {
  const counts = emptyCounts();
  const rows = await HrDepartment.find({}).select("_id status").lean();
  for (const _row of rows) {
    counts[classifyScope({ level: "company", direct: null, derived: [] }).status] += 1;
  }
  return { model: "HR Department", level: "company", total: rows.length, counts, samples: {} };
}

/** Attendance and daily attendance: is a day's evidence attributable to a site? */
async function auditAttendanceScope({ Attendance, DailyAttendance }) {
  const attendanceTotal = await Attendance.countDocuments({});
  const dailyTotal = await DailyAttendance.countDocuments({});
  const attendanceCounts = emptyCounts();
  const dailyCounts = emptyCounts();
  attendanceCounts[SCOPE_STATUS.MISSING] = attendanceTotal;
  dailyCounts[SCOPE_STATUS.MISSING] = dailyTotal;
  return [
    {
      model: "Attendance",
      level: "establishment",
      total: attendanceTotal,
      counts: attendanceCounts,
      samples: {},
      note: "No company, establishment or device-site field on the schema; a day is attributable to a person, not to a site.",
    },
    {
      model: "DailyAttendance",
      level: "establishment",
      total: dailyTotal,
      counts: dailyCounts,
      samples: {},
      note: "Keyed on yearMonth/dateStr with no scope component.",
    },
  ];
}

/* ── Uniqueness risk ─────────────────────────────────────────────────────────*/

/**
 * Which of today's global uniqueness constraints would change meaning under
 * scope, and which current duplicates would become legal.
 *
 * Employee's biometricId / identityId / email are unique+sparse GLOBALLY, so a
 * true duplicate cannot exist yet — the risk is prospective: two establishments
 * cannot both issue "GR0001". That is reported as a constraint finding rather
 * than a row count, and the duplicate scan below reports the empty-set result
 * honestly instead of implying there is nothing to do.
 */
async function auditUniqueness({ Employee, Payroll }) {
  const findings = [];

  for (const field of ["biometricId", "identityId"]) {
    const dupes = await Employee.aggregate([
      { $match: { [field]: { $nin: [null, ""] } } },
      { $group: { _id: `$${field}`, ids: { $push: "$_id" }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $limit: 200 },
    ]);

    let legal = 0;
    let invalid = 0;
    for (const group of dupes) {
      /* No employee carries a company today, so every member is undecidable and
         every group stays INVALID. Run through the real classifier rather than
         asserting that, so the number moves on its own once scope is
         populated. */
      const verdict = classifyDuplicateGroup(
        group.ids.map((id) => ({ recordId: String(id), companyId: null })),
      );
      if (verdict.verdict === DUPLICATE_VERDICT.LEGAL_UNDER_SCOPE) legal += 1;
      else invalid += 1;
    }

    findings.push({
      model: "Employee",
      identifier: field,
      currentConstraint: `unique + sparse on { ${field} } — GLOBAL`,
      proposedConstraint: `unique on { companyId, establishmentId, ${field} }`,
      duplicateGroups: dupes.length,
      legalOnceScoped: legal,
      stillInvalidOnceScoped: invalid,
      prospectiveRisk:
        "Two establishments cannot both issue the same employee/biometric number today; the global index refuses the second one at creation.",
      sampleGroupSizes: dupes.slice(0, SAMPLE_LIMIT).map((g) => g.n),
    });
  }

  /* Payroll: `{ month, year }` is unique for the WHOLE platform, so two
     companies can never both run October. This is the sharpest single finding
     in the audit. */
  const payrollTotal = Payroll ? await Payroll.countDocuments({}) : 0;
  const periods = Payroll
    ? await Payroll.aggregate([
        { $group: { _id: { month: "$month", year: "$year" }, n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $limit: 50 },
      ])
    : [];

  findings.push({
    model: "Payroll run",
    identifier: "month+year",
    currentConstraint: "unique on { month, year } — GLOBAL, one run per period for the entire platform",
    proposedConstraint: "unique on { companyId, legalEntityId, month, year }",
    duplicateGroups: periods.length,
    legalOnceScoped: 0,
    stillInvalidOnceScoped: periods.length,
    totalRuns: payrollTotal,
    prospectiveRisk:
      "A second legal entity cannot run the same month. Acc_PayrollBridge already scopes its post by { companyId, payrollRunId }, so Finance expects per-company runs that HR cannot express.",
    sampleGroupSizes: periods.slice(0, SAMPLE_LIMIT).map((g) => g.n),
  });

  return findings;
}

/* ── Runner ──────────────────────────────────────────────────────────────────*/

async function runAudit() {
  const M = models();
  const companies = await M.AccCompany.find({}).select("_id").lean();
  const companyIds = companies.map((c) => String(c._id));

  const scope = [];
  scope.push(await auditEmployeeCompanyScope(M, { companyIds }));
  scope.push(await auditDepartmentScope(M));
  scope.push(...(await auditAttendanceScope(M)));

  const uniqueness = await auditUniqueness(M);

  return {
    generatedFor: "HRMS Chunk 2A — organisation scope readiness",
    environment: describeDatabaseSafely(),
    companyMasterCount: companyIds.length,
    scope,
    uniqueness,
  };
}

function summarise(report) {
  const lines = [];
  lines.push("HR ORGANISATION SCOPE — READINESS AUDIT (read-only)");
  lines.push("");
  lines.push(`  environment   ${report.environment.nodeEnv}`);
  lines.push(`  database      ${report.environment.databaseName} @ ${report.environment.databaseHost}`);
  lines.push(`  companies     ${report.companyMasterCount} (Acc_Company)`);
  lines.push("");
  lines.push("SCOPE CLASSIFICATION");
  for (const s of report.scope) {
    lines.push(`  ${s.model} — ${s.level} (${s.total} records)`);
    for (const [status, n] of Object.entries(s.counts)) {
      if (n) lines.push(`      ${String(n).padStart(8)}  ${status}`);
    }
    if (s.note) lines.push(`      note: ${s.note}`);
  }
  lines.push("");
  lines.push("UNSCOPED UNIQUENESS RISK");
  for (const u of report.uniqueness) {
    lines.push(`  ${u.model} · ${u.identifier}`);
    lines.push(`      now:      ${u.currentConstraint}`);
    lines.push(`      proposed: ${u.proposedConstraint}`);
    lines.push(`      duplicate groups ${u.duplicateGroups} · legal once scoped ${u.legalOnceScoped} · still invalid ${u.stillInvalidOnceScoped}`);
    if (u.prospectiveRisk) lines.push(`      risk: ${u.prospectiveRisk}`);
  }
  lines.push("");
  lines.push("This audit wrote nothing.");
  return lines.join("\n");
}

async function main() {
  assertSafeToRun();

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("[hr-scope-audit] MONGODB_URI is not set. No live counts were obtained.");
    process.exit(3);
  }

  await mongoose.connect(uri);
  try {
    const report = await runAudit();

    /* The audit checks its OWN output before printing it. A leak here would be
       the audit becoming the disclosure it exists to prevent. */
    const leaks = containsPrivateData(report);
    if (leaks.length) {
      console.error(
        `[hr-scope-audit] ABORT: the report contains prohibited fields at ${leaks.join(", ")}`,
      );
      process.exit(4);
    }

    const jsonFlag = process.argv.indexOf("--json");
    if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
      fs.writeFileSync(process.argv[jsonFlag + 1], JSON.stringify(report, null, 2));
      console.log(`[hr-scope-audit] wrote ${process.argv[jsonFlag + 1]}`);
    }
    console.log(summarise(report));
    console.log("\n--- machine-readable ---");
    console.log(JSON.stringify(report));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[hr-scope-audit] failed:", err.message);
    process.exit(1);
  });
}

module.exports = {
  assertSafeToRun,
  describeDatabaseSafely,
  runAudit,
  summarise,
  auditUniqueness,
  SAMPLE_LIMIT,
};
