#!/usr/bin/env node
// verify.js — one entry point for the verification harnesses.
//
//   npm run verify          the safe set: no database writes. Seconds.
//   npm run verify:all      everything, including the ones that write.
//   node verify.js --list   what exists, and which tier each is in.
//   node verify.js salary   just the ones whose name matches "salary".
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The harnesses were 29 loose files in the repository root with no runner. A
// check nobody can find is a check nobody runs, and the honest description of
// that is clutter rather than coverage. Naming them here also makes the tiers
// explicit — which matters, because some of these WRITE to the shared dev
// database and a person should choose that deliberately.
//
// ── THE TIERS ───────────────────────────────────────────────────────────────
// PURE      no database, no network. Business rules — the salary formula, the
//           approval policy, the audit floor. Run these constantly; they cost
//           nothing and they are what breaks silently.
// READONLY  reads the real dev database and asserts against real records.
//           Safe to run any time; slower, because Mongo is far away.
// WRITES    creates its own throwaway rows and deletes them again, including
//           on a crash. Safe by design, but it is somebody's live dev database
//           — run these when you are changing that area, not by reflex.
//
// A harness is not a unit test: `npm test` runs the node:test files under
// services/. These are hand-run scripts that check whole features end to end.

"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PURE = [
  "verifyApprovalPolicy",      // which edits need an approver
  "verifySalaryRules",         // EDLI/admin caps, CTC composition
  "verifySalaryParity",        // the form's preview agrees with the server
  "verifyFoodAllowance",       // proration and the other deduction
  "verifyAuditFloor",          // what the change log will and will not record
  "verifyBuiltInFields",       // the field registry still matches the form
  "verifyCompanyDocuments",    // the company-documents model
  "verifyHrWriteCoverage",     // every HR write is guarded or deliberately exempt
];

const READONLY = [
  "verifyAttendanceRules",     // the late ladder, and the national-holiday rule
  "verifyPayrollLadder",       // that ladder reaching pay
  "verifyLedgerBalances",      // chart of accounts equals the ledger page
  "verifyRoleResolution",      // approvers resolve; orphan grants are named
  "verifyManagerChain",        // who may be offered as a manager
];

const WRITES = [
  "verifyApprovalReplay",      // an approval actually applies, once
  "verifyApprovalDetail",      // the card names the fields; the right people hear
  "verifyDepartmentTeam",      // an owner manages roles, and cannot lock the door
  "verifyHrChangeHistory",     // the audit spine end to end
  "verifyNotificationSettings",// per-device notification preferences
  "verifyRegularizationApply", // an approved correction reaches attendance
  "verifySalaryResyncHistory", // a rule change records who it moved
  "verifyFieldHiding",         // hiding a built-in field reaches the form
  "verifyPayrollLedgerMap",    // the payroll → accounting bridge balances
  "verifyDeveloperSide",       // the anomaly scan catches what it promises
  "verifyAdminCenter",         // form definitions, job control, role floors
];

const TIERS = { pure: PURE, readonly: READONLY, writes: WRITES };

function exists(name) {
  return fs.existsSync(path.join(__dirname, `${name}.js`));
}

function run(name) {
  const started = Date.now();
  try {
    const out = execFileSync(
      process.execPath,
      ["-r", "dotenv/config", `${name}.js`],
      { cwd: __dirname, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const line = (out.match(/(\d+) passed, (\d+) failed/) || [])[0] || "completed";
    return { ok: true, line, ms: Date.now() - started };
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    const line = (out.match(/(\d+) passed, (\d+) failed/) || [])[0] || "CRASHED";
    return { ok: false, line, ms: Date.now() - started, out };
  }
}

const args = process.argv.slice(2);

if (args.includes("--list")) {
  for (const [tier, names] of Object.entries(TIERS)) {
    console.log(`\n${tier.toUpperCase()}`);
    for (const n of names) console.log(`  ${exists(n) ? " " : "!"} ${n}${exists(n) ? "" : "   (missing)"}`);
  }
  console.log("");
  process.exit(0);
}

const all = args.includes("--all");
const filter = args.find((a) => !a.startsWith("--"));

let selected = all ? [...PURE, ...READONLY, ...WRITES] : [...PURE, ...READONLY];
if (filter) {
  const needle = filter.toLowerCase();
  selected = [...PURE, ...READONLY, ...WRITES].filter((n) =>
    n.toLowerCase().includes(needle),
  );
}
selected = selected.filter(exists);

if (!selected.length) {
  console.error(filter ? `Nothing matches "${filter}".` : "Nothing to run.");
  process.exit(1);
}

console.log(
  `\nRunning ${selected.length} harness${selected.length === 1 ? "" : "es"}` +
    `${all || filter ? "" : " (safe set — add --all for the ones that write)"}\n`,
);

const failures = [];
for (const name of selected) {
  process.stdout.write(`  ${name.padEnd(30)}`);
  const r = run(name);
  console.log(`${r.line.padEnd(22)} ${(r.ms / 1000).toFixed(1)}s`);
  if (!r.ok) failures.push({ name, out: r.out });
}

if (failures.length) {
  console.log(`\n${failures.length} failed:\n`);
  for (const f of failures) {
    console.log(`── ${f.name} ${"─".repeat(Math.max(0, 60 - f.name.length))}`);
    console.log(
      (f.out || "")
        .split("\n")
        .filter((l) => /FAIL|Error|crashed/i.test(l))
        .slice(0, 8)
        .join("\n") || "(no detail captured)",
    );
    console.log("");
  }
  process.exit(1);
}

console.log("\nAll green.\n");
