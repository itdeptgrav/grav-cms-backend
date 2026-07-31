// scripts/diagnoseLogin.js
//
// Why can this person not sign in?
//
//   node scripts/diagnoseLogin.js --email someone@grav.in
//   node scripts/diagnoseLogin.js --email someone@grav.in --password "guess"
//
// "Invalid email or password" is the correct thing to show a user — telling
// them which half was wrong hands an attacker an account enumerator. But it is
// useless to an administrator, and the alternative has been guessing, reading
// raw documents in Compass, and reasoning about which of four password formats
// an account happens to be carrying.
//
// This answers it directly and prints NO passwords. With --password it reports
// only whether that string matches and by which route, never what the real one
// is — nothing here reveals a credential that was not already supplied.

"use strict";

require("dotenv").config();

// `mongodb+srv://` needs a DNS SRV lookup at connect time. On networks whose
// resolver refuses SRV queries the driver dies with "querySrv ECONNREFUSED"
// before it ever reaches Atlas. Point the resolver this script uses at public
// DNS so the lookup succeeds regardless of the machine's configured resolver.
try { require("dns").setServers(["1.1.1.1", "8.8.8.8"]); } catch { /* older node */ }

const mongoose = require("mongoose");

const Employee = require("../models/Employee");
const DeptUser = require("../models/Access/DeptUser");
const AccessDepartment = require("../models/Access/AccessDepartment");
const { matchesEmployeePassword } = require("../utils/employeePassword");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : "";
}

const ok = (s) => console.log(`  ✓ ${s}`);
const no = (s) => console.log(`  ✗ ${s}`);
const info = (s) => console.log(`    ${s}`);

async function main() {
  const email = String(arg("email") || "").toLowerCase().trim();
  const password = arg("password");

  if (!email) {
    console.error("\n  node scripts/diagnoseLogin.js --email someone@grav.in [--password \"guess\"]\n");
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) { console.error("MONGODB_URI is not set."); process.exit(1); }

  await mongoose.connect(uri);
  console.log(`\nDatabase: ${mongoose.connection.name}`);
  console.log(`Account : ${email}\n`);

  /* ── 1. department account ───────────────────────────────────────── */
  const deptUser = await DeptUser.findOne({ email });
  const employeeExists = await Employee.exists({ email });

  // Report BOTH identities. Stopping at the first match is what made this
  // confusing in the first place: an inactive department login looked like the
  // whole story while a perfectly good employee record sat behind it.
  if (deptUser && employeeExists) {
    console.log("⚠  This address names TWO separate accounts:\n");
    console.log("   • a department login (dept_users)");
    console.log("   • an employee record (employees)\n");
    console.log("   They have independent passwords and independent access.");
    console.log("   Sign-in tries the department login first, then the employee.\n");
  }

  if (deptUser) {
    console.log("DEPARTMENT LOGIN (dept_users)\n");
    deptUser.isActive
      ? ok("account is active")
      : no("account is INACTIVE — this identity cannot be used (the employee record still can)");
    deptUser.isLocked()
      ? no(`locked until ${deptUser.lockedUntil.toLocaleString()} after repeated failures`)
      : ok("not locked out");

    const dept = await AccessDepartment.findById(deptUser.departmentId);
    if (!dept) no("its department no longer exists");
    else if (!dept.isActive) no(`department "${dept.name}" is INACTIVE`);
    else ok(`department: ${dept.name} (/${dept.slug}) → ${dept.resolveRedirect()}`);

    if (deptUser.isAdmin) ok("is a platform administrator");

    if (password) {
      const good = await deptUser.verifyPassword(password);
      good
        ? ok("the supplied password MATCHES this department login")
        : no("the supplied password does NOT match this department login");
    }

    // Deliberately NOT returning here — carry on and report the employee
    // record too, if one shares this address.
    if (!employeeExists) {
      await mongoose.disconnect();
      return;
    }
    console.log("");
  }

  /* ── 2. employee ─────────────────────────────────────────────────── */
  // No projection except the genuinely select:false field. A `+field` mixed
  // into an inclusive projection makes mongoose drop it — which is exactly the
  // bug this script was written to find, and it had the same bug itself.
  const employee = await Employee.findOne({ email }).select("+temporaryPassword");

  if (!employee) {
    no("No employee record has this email address.");
    info("Check for a typo, or that the employee record actually carries this email.");
    await mongoose.disconnect();
    return;
  }

  console.log("Matched an EMPLOYEE record.\n");

  const active = employee.isActive !== false && employee.status !== "inactive";
  active ? ok("employee is active") : no(`employee is INACTIVE (status: ${employee.status})`);

  /* department assignment */
  if (employee.accessDepartmentId) {
    const dept = await AccessDepartment.findById(employee.accessDepartmentId);
    if (!dept) no("assigned to a department that no longer exists");
    else if (!dept.isActive) no(`assigned to "${dept.name}", which is INACTIVE`);
    else ok(`assigned to ${dept.name} (/${dept.slug}) → ${dept.resolveRedirect()}`);
  } else {
    no("NOT assigned to any department — sign-in is refused with NO_DEPARTMENT");
    info("Fix: CEO → Access Control → Employee Access → pick a department.");
    if (employee.department) {
      const guess = await AccessDepartment.find({
        name: new RegExp(`^${String(employee.department).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
        isActive: true,
      });
      info(
        `Their HR record says "${employee.department}" — ` +
        (guess.length === 1
          ? `that matches "${guess[0].name}" exactly, so the name fallback WILL let them in.`
          : `that matches ${guess.length} departments, so the name fallback cannot be used.`),
      );
    }
  }

  /* what shape is the stored password in? */
  console.log("");
  const stored = employee.password || "";
  if (!stored) {
    no("no password is stored at all");
  } else if (stored.startsWith("$2")) {
    ok("password is stored as a bcrypt hash");
  } else {
    no("password is stored as PLAINTEXT (it will be upgraded on next successful sign-in)");
  }

  if (employee.temporaryPassword) {
    no("a temporaryPassword is still stored on this record");
    info("That is a readable copy of a live credential. Setting a new password from");
    info("Access Control clears it.");
  }

  /* which alternative routes could work at all */
  const canNameDob = Boolean(employee.firstName && employee.dateOfBirth);
  const canPhone = String(employee.phone || "").replace(/\D/g, "").length === 10;
  console.log("");
  console.log("  Password routes available to this account:");
  info(`hash            : ${stored.startsWith("$2") ? "yes" : "no"}`);
  info(`legacy plaintext: ${stored && !stored.startsWith("$2") ? "yes" : "no"}`);
  info(`Firstname@MMDDYYYY: ${canNameDob ? "yes" : "no — needs firstName AND dateOfBirth"}`);
  info(`phone default   : ${canPhone ? "yes" : "no — needs a 10-digit phone"}`);

  if (password) {
    console.log("");
    const match = await matchesEmployeePassword(employee, password);
    if (match.ok) {
      ok(`the supplied password MATCHES (via ${match.via})`);
      if (match.needsUpgrade) info("It will be converted to a bcrypt hash on next sign-in.");
    } else {
      no("the supplied password does NOT match any accepted route");
      info("Fix: CEO → Access Control → Employee Access → Set password.");
    }
  }

  console.log("");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("\nFailed:", err.message);
  try { await mongoose.disconnect(); } catch { /* already down */ }
  process.exit(1);
});
