// scripts/fixLogin.js
//
// Repair an employee sign-in once scripts/diagnoseLogin.js has told you WHY it
// is failing. Every action is explicit — nothing happens without a flag — and
// the script prints the record before and after so the change is auditable.
//
//   Reactivate a deactivated employee (the common one — a "delete" only marks
//   the record inactive, and an inactive record is refused with the same
//   "Invalid email or password" as a wrong password):
//     node scripts/fixLogin.js --email someone@grav.in --reactivate
//
//   Set a fresh sign-in password (stored as a bcrypt hash, temporaryPassword
//   cleared):
//     node scripts/fixLogin.js --email someone@grav.in --set-password "NewPass123"
//
//   Assign the department they sign in to (by slug), if it was lost:
//     node scripts/fixLogin.js --email someone@grav.in --assign-dept hr
//
//   Flags combine:
//     node scripts/fixLogin.js --email someone@grav.in --reactivate --set-password "NewPass123"
//
// This only ever touches the ONE employee record named by --email.

"use strict";

require("dotenv").config();

// `mongodb+srv://` needs a DNS SRV lookup at connect time. On networks whose
// resolver refuses SRV queries the driver dies with "querySrv ECONNREFUSED"
// before it ever reaches Atlas. Point the resolver this script uses at public
// DNS so the lookup succeeds regardless of the machine's configured resolver.
try { require("dns").setServers(["1.1.1.1", "8.8.8.8"]); } catch { /* older node */ }

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const Employee = require("../models/Employee");
const AccessDepartment = require("../models/Access/AccessDepartment");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : "";
}
const has = (name) => process.argv.includes(`--${name}`);

const ok = (s) => console.log(`  ✓ ${s}`);
const no = (s) => console.log(`  ✗ ${s}`);

async function main() {
  const email = String(arg("email") || "").toLowerCase().trim();
  if (!email) {
    console.error('\n  node scripts/fixLogin.js --email someone@grav.in [--reactivate] [--set-password "X"] [--assign-dept slug]\n');
    process.exit(1);
  }

  const reactivate = has("reactivate");
  const newPassword = arg("set-password");
  const deptSlug = String(arg("assign-dept") || "").toLowerCase().trim();

  if (!reactivate && !newPassword && !deptSlug) {
    console.error("\n  Nothing to do. Pass at least one of --reactivate, --set-password, --assign-dept.\n");
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) { console.error("MONGODB_URI is not set."); process.exit(1); }

  await mongoose.connect(uri);
  console.log(`\nDatabase: ${mongoose.connection.name}`);
  console.log(`Account : ${email}\n`);

  const employee = await Employee.findOne({ email });
  if (!employee) {
    no("No employee record has this email address. Nothing was changed.");
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log("BEFORE");
  console.log(`  isActive : ${employee.isActive}`);
  console.log(`  status   : ${employee.status}`);
  console.log(`  password : ${employee.password ? (employee.password.startsWith("$2") ? "bcrypt hash" : "plaintext") : "(none)"}`);
  console.log(`  dept id  : ${employee.accessDepartmentId || "(none)"}\n`);

  const $set = {};

  if (reactivate) {
    $set.isActive = true;
    $set.status = "active";
    ok("will reactivate (isActive: true, status: active)");
  }

  if (newPassword) {
    $set.password = await bcrypt.hash(newPassword, 10);
    $set.temporaryPassword = "";
    ok("will set a new bcrypt password and clear temporaryPassword");
  }

  if (deptSlug) {
    const dept = await AccessDepartment.findOne({ slug: deptSlug, isActive: true });
    if (!dept) {
      no(`No active department with slug "${deptSlug}". Nothing was changed.`);
      await mongoose.disconnect();
      process.exit(1);
    }
    $set.accessDepartmentId = dept._id;
    ok(`will assign department: ${dept.name} (/${dept.slug})`);
  }

  await Employee.updateOne({ _id: employee._id }, { $set }, { runValidators: false });

  const after = await Employee.findById(employee._id);
  console.log("\nAFTER");
  console.log(`  isActive : ${after.isActive}`);
  console.log(`  status   : ${after.status}`);
  console.log(`  password : ${after.password ? (after.password.startsWith("$2") ? "bcrypt hash" : "plaintext") : "(none)"}`);
  console.log(`  dept id  : ${after.accessDepartmentId || "(none)"}`);
  console.log("\nDone. Try signing in again.\n");

  await mongoose.disconnect();
}


main().catch(async (err) => {
  console.error("\nFailed:", err.message);
  try { await mongoose.disconnect(); } catch { /* already down */ }
  process.exit(1);
});
