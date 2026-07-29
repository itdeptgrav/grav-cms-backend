// scripts/createPlatformAdmin.js
//
// Grant platform-administrator rights.
//
//   node scripts/createPlatformAdmin.js --email you@grav.in --password "..."
//   node scripts/createPlatformAdmin.js --email ceo@grav.in            (existing account)
//
// Environment variables work too (ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME),
// but the flags are the documented form because `VAR=x node …` is bash syntax
// and does nothing in PowerShell.
//
// PROMOTING AN EXISTING ACCOUNT DOES NOT MOVE IT
// ----------------------------------------------
// Administration is a boolean on the user, not a role and not a department.
// An earlier version of this script reassigned the account to the
// platform_admin department and overwrote its legacyRole — which for, say, the
// CEO account would have rewritten "ceo" to "platform_admin" and silently
// revoked access to every CEO route, since all ten ceoAuth arrays test for the
// literal "ceo". So an existing user keeps their department, their role and
// their dashboard, and simply gains the admin flag.
//
// Run by hand, never on boot. A seeder that recreates an admin account is a
// permanent back door.

"use strict";

require("dotenv").config();
const mongoose = require("mongoose");

const AccessDepartment = require("../models/Access/AccessDepartment");
const DeptUser = require("../models/Access/DeptUser");

/** Read `--flag value` from argv, falling back to an env var. */
function arg(name, envName) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  return process.env[envName] || "";
}

const MIN_PASSWORD = 12;

async function main() {
  const email = String(arg("email", "ADMIN_EMAIL")).toLowerCase().trim();
  const password = arg("password", "ADMIN_PASSWORD");
  const name = arg("name", "ADMIN_NAME") || "Platform Administrator";

  if (!email) {
    console.error(
      "\n  Usage:\n" +
      '    node scripts/createPlatformAdmin.js --email you@grav.in --password "a-long-password"\n\n' +
      "  To promote an account that already exists, the password is optional:\n" +
      "    node scripts/createPlatformAdmin.js --email ceo@grav.in\n",
    );
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) { console.error("MONGODB_URI is not set."); process.exit(1); }

  await mongoose.connect(uri);
  console.log(`\nConnected to ${mongoose.connection.name}`);

  const existing = await DeptUser.findOne({ email });

  /* ── Promote an account that already exists ─────────────────────── */
  if (existing) {
    const dept = await AccessDepartment.findById(existing.departmentId);

    console.log(`\n  Found ${email} in ${dept ? dept.name : "an unknown department"}.`);

    if (password && password.length < MIN_PASSWORD) {
      console.error(`\n  Password must be at least ${MIN_PASSWORD} characters. Nothing changed.\n`);
      await mongoose.disconnect();
      process.exit(1);
    }

    existing.isAdmin = true;
    existing.isActive = true;
    // Department, legacyRole and legacyModel are deliberately UNTOUCHED — see
    // the header. This account keeps working exactly as it did.

    if (password) {
      await existing.setPassword(password);
      console.log("  Password reset. Every existing session for this account is now signed out.");
    } else {
      // Rights changed, so outstanding tokens must be re-issued to carry the
      // new isAdmin claim.
      existing.tokenVersion += 1;
    }

    await existing.save();

    console.log(`\n  ${email} is now a platform administrator.`);
    console.log(`  Their department (${dept ? dept.name : "?"}) and role (${existing.legacyRole || "—"}) are unchanged.`);
    console.log(`  Sign in at /admin/login — the same credentials as their normal login.\n`);

    await mongoose.disconnect();
    return;
  }

  /* ── Create a dedicated admin account ───────────────────────────── */
  if (!password) {
    console.error(
      `\n  No account exists for ${email}, so a password is required to create one:\n` +
      `    node scripts/createPlatformAdmin.js --email ${email} --password "a-long-password"\n`,
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  if (password.length < MIN_PASSWORD) {
    console.error(
      `\n  Password must be at least ${MIN_PASSWORD} characters — this account can ` +
      `reset everyone else's.\n`,
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  const dept = await AccessDepartment.findOne({ key: "platform_admin" });
  if (!dept) {
    console.error(
      "\n  No platform_admin department found.\n" +
      "  Run: node scripts/migrations/001-seed-access-departments.js --apply\n",
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  const user = new DeptUser({
    name,
    email,
    departmentId: dept._id,
    isAdmin: true,
    isActive: true,
    // NOT "admin". That literal appears in fifteen-plus allow-lists across the
    // backend as a role no model issues; minting it would hand this account
    // every CEO dashboard and accountant write path as a side effect.
    legacyRole: "platform_admin",
    passwordHash: "pending",
  });

  await user.setPassword(password);
  user.mustChangePassword = false;
  await user.save();

  console.log(`\n  Created platform administrator: ${email}`);
  console.log(`  Sign in at /admin/login\n`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("\nFailed:", err.message);
  try { await mongoose.disconnect(); } catch { /* already down */ }
  process.exit(1);
});
