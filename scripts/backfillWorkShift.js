"use strict";
// scripts/backfillWorkShift.js
//
// Give every employee an explicit shift category.
//
// The employee form used to offer a fourth choice, "use their department's
// shift", and that was the default. It is gone: everyone belongs to exactly
// one of Core, General or Custom. This stamps the people who predate that
// rule with the category their department already implied, so the change is
// invisible to them — the same shift they were being judged against
// yesterday, now written down instead of inferred.
//
// Writing it down is the point. An inferred shift changes silently when
// somebody edits the department lists in attendance settings; a stored one
// does not, and it shows on the employee's record where HR can see and
// correct it.
//
//   node -r dotenv/config scripts/backfillWorkShift.js            # dry run
//   node -r dotenv/config scripts/backfillWorkShift.js --apply    # write
//
// Idempotent: employees who already have a mode are left alone, so re-running
// it is safe and only ever touches the stragglers.

const mongoose = require("mongoose");
const Employee = require("../models/Employee");
const AttendanceSettings = require("../models/HR_Models/Attendancesettings");
const { resolveShift } = require("../services/shiftPolicy");

const APPLY = process.argv.includes("--apply");

/** A readable label for the legacy free-text `shift` field. */
function labelFor(mode, ws) {
  if (mode === "custom") return `Custom ${ws.start}–${ws.end}`;
  return mode === "core" ? "Core" : "General";
}

async function main() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  await mongoose.connect(uri);
  console.log(`connected: ${uri.replace(/\/\/[^@]*@/, "//***@")}`);

  const settings = await AttendanceSettings.getConfig();
  const employees = await Employee.find({}).lean();

  const already = [];
  const toStamp = [];
  for (const emp of employees) {
    if (emp.workShift?.mode) {
      already.push(emp);
      continue;
    }
    // Ask the resolver what this employee gets TODAY, then freeze that answer.
    // Deriving it any other way here would risk stamping a different shift
    // from the one they are currently being judged against.
    const shift = resolveShift(emp, settings);
    toStamp.push({ emp, mode: shift.mode, shift });
  }

  const byMode = toStamp.reduce((a, r) => ((a[r.mode] = (a[r.mode] || 0) + 1), a), {});
  console.log(`\n${employees.length} employees`);
  console.log(`  already set : ${already.length}`);
  console.log(`  to stamp    : ${toStamp.length}`);
  for (const [m, n] of Object.entries(byMode)) console.log(`      ${m.padEnd(8)} ${n}`);

  // Show a handful so the operator can sanity-check before committing.
  console.log("\nsample:");
  for (const r of toStamp.slice(0, 10)) {
    const name = [r.emp.firstName, r.emp.lastName].filter(Boolean).join(" ");
    console.log(
      `  ${String(r.emp.biometricId || "—").padEnd(8)} ${name.padEnd(24)} ` +
        `${String(r.emp.department || "—").padEnd(16)} -> ${r.mode} (${r.shift.start}-${r.shift.end})`,
    );
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply.");
    await mongoose.disconnect();
    return;
  }

  let written = 0;
  for (const r of toStamp) {
    // Only the mode. Core and General take their hours from settings, so
    // copying times onto the employee would freeze a copy that stops
    // following the settings page.
    const workShift = { mode: r.mode };
    await Employee.updateOne(
      { _id: r.emp._id },
      { $set: { workShift, shift: labelFor(r.mode, r.shift) } },
    );
    written++;
  }
  console.log(`\nstamped ${written} employees.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
