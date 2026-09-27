#!/usr/bin/env node
// scripts/migrations/gac2-accounting-role-only.js
//
// GAC-2 correction — give EXISTING Accounting role rows explicit non-login
// semantics.
//
// Before GAC-2, Access Control created an Acc_User for an employee (or a
// department login) with a random, unknowable password: a role row that was,
// technically, still a login record. New rows are now created with
// `loginMode: "none"` and no hash. This script finds the OLD ones — Acc_User
// rows whose person's canonical identity is a DeptUser or an active Employee —
// and, only with --apply, marks them `loginMode: "none"` and removes the hash.
//
// The live code already refuses these rows at the books login (it requires the
// canonical identity to BE the Acc_User), so this is defence in depth and
// data hygiene, not the only boundary.
//
// DEFAULT MODE IS A DRY RUN. Nothing is written without `--apply`, and
// `--apply` must not be run against a shared database without the dry-run
// report being reviewed and explicitly approved.
//
//   node -r dotenv/config scripts/migrations/gac2-accounting-role-only.js
//   node -r dotenv/config scripts/migrations/gac2-accounting-role-only.js --apply
//
// Output: COUNTS ONLY — no email, name, hash, token or connection string.
//
// What --apply does, per candidate (idempotent; a second run plans nothing):
//   $set { loginMode: "none" }, $unset { passwordHash }, $inc { tokenVersion }
// The role, activation, organisation and history are untouched; the person's
// Accounting sessions end once (they re-enter through their GRAV login).
//
// Left alone, and counted separately:
//   · accounting-only people (no DeptUser, no active Employee) — their row IS
//     their login;
//   · rows whose email is ambiguous (two active Employees) — resolve first.
//
// ROLLBACK: the removed hashes were random and unknown; there is nothing to
// restore. To make a row a login again, set loginMode "password" and have the
// person set a password through the accounting-only path.
"use strict";

const lower = (v) => String(v || "").toLowerCase().trim();

async function plan() {
  const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
  const DeptUser = require("../../models/Access/DeptUser");
  const Employee = require("../../models/Employee");

  const rows = await Acc_User.find({ loginMode: { $ne: "none" } }).select("_id email").lean();
  const counts = { accUsersWithLoginMode: rows.length, candidates: 0, accountingOnly: 0, ambiguous: 0 };
  const candidateIds = [];
  for (const r of rows) {
    const email = lower(r.email);
    const dept = await DeptUser.exists({ email });
    const activeEmployees = dept ? 0 : await Employee.countDocuments({ email, isActive: { $ne: false }, status: { $ne: "inactive" } });
    if (dept || activeEmployees === 1) { counts.candidates += 1; candidateIds.push(r._id); }
    else if (activeEmployees > 1) counts.ambiguous += 1;
    else counts.accountingOnly += 1;
  }
  return { counts, candidateIds };
}

async function apply(candidateIds) {
  const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
  if (!candidateIds.length) return { modified: 0 };
  const res = await Acc_User.collection.updateMany(
    { _id: { $in: candidateIds }, loginMode: { $ne: "none" } },
    { $set: { loginMode: "none" }, $unset: { passwordHash: "" }, $inc: { tokenVersion: 1 } },
  );
  return { modified: res.modifiedCount || 0 };
}

async function main() {
  const mongoose = require("mongoose");
  const doApply = process.argv.includes("--apply");
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  try {
    const { counts, candidateIds } = await plan();
    console.log(JSON.stringify({ mode: doApply ? "apply" : "dry-run", ...counts }, null, 2));
    if (doApply) console.log(JSON.stringify(await apply(candidateIds), null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error("failed:", err?.message || err); process.exit(1); });
}

module.exports = { plan, apply };
