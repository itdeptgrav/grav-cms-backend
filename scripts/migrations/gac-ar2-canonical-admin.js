#!/usr/bin/env node
// scripts/migrations/gac-ar2-canonical-admin.js
//
// GAC-AR2 — make ray@grav.in the canonical full-system administrator login,
// and mark ceo@grav.in as a transitional duplicate. ONE PERSON, ONE LOGIN.
//
// DEFAULT MODE IS A DRY RUN. Nothing is written without `--apply`.
//
//   node -r dotenv/config scripts/migrations/gac-ar2-canonical-admin.js
//   node -r dotenv/config scripts/migrations/gac-ar2-canonical-admin.js --apply
//
// What --apply does (all idempotent; a second run plans nothing):
//   1. Creates — or updates — the canonical DeptUser for the target email.
//      On CREATE its passwordHash is the target's existing Acc_User bcrypt
//      hash, copied as an opaque string: the password is never known, never
//      printed, never re-hashed. An existing DeptUser keeps its own hash.
//   2. Home application: the Executive Office (`ceo`).
//   3. `isAdmin: true`, set explicitly on that row. Administrator status is
//      never derived from the Accounting owner role.
//   4. Leaves the target's Acc_User untouched — the Accounting owner role is
//      preserved exactly.
//   5. Checks there is an active administrator before and after every write.
//   6. Marks the duplicate (ceo@grav.in) with `identityTransition`
//      (supersededBy…, eligibleForDeactivation: false). It stays ACTIVE and
//      is NOT deleted.
//   Runs in a MongoDB transaction when the deployment supports one.
//
// A SEPARATE, LATER step deactivates the duplicate — never in the same run:
//
//   … --deactivate-transitional            (dry run of that step)
//   … --deactivate-transitional --apply
//
// It refuses unless: the canonical admin exists, is active, is an
// administrator, and has SIGNED IN since the migration (lastLogin after
// identityTransition.markedAt); and at least one OTHER active administrator
// remains after the duplicate is deactivated (last-active-admin protection).
// Deactivation bumps the duplicate's tokenVersion so its sessions end; the
// row is kept (isActive: false), never deleted.
//
// Output: action codes and counts only — no password, hash or token.
//
// ROLLBACK (after --apply of step 1):
//   · the created canonical DeptUser can be deactivated (isActive:false) or
//     removed by an administrator — it was new, nothing else references it;
//     if it was UPDATED, restore isAdmin/departmentId from the before-report;
//   · `$unset: { identityTransition: 1 }` on the duplicate;
//   · the Acc_User was never modified.
// ROLLBACK (after --deactivate-transitional --apply):
//   · set the duplicate back to isActive:true (its old sessions stay revoked).
"use strict";

const TARGET_EMAIL = "ray@grav.in";
const DUPLICATE_EMAIL = "ceo@grav.in";
const HOME_SLUG = "ceo";
const BCRYPT_RE = /^\$2[aby]\$\d\d\$.{53}$/;

const lower = (v) => String(v || "").toLowerCase().trim();

/**
 * Work out what the migration WOULD do. No writes.
 * @param {{ DeptUser, AccessDepartment, Acc_User }} m  mongoose models
 */
async function planMigration(m, { targetEmail = TARGET_EMAIL, duplicateEmail = DUPLICATE_EMAIL } = {}) {
  const target = lower(targetEmail);
  const duplicate = lower(duplicateEmail);
  const blockers = [];
  const actions = [];

  const [home, accUsers, existing, dup, activeAdminsBefore] = await Promise.all([
    m.AccessDepartment.findOne({ slug: HOME_SLUG }).lean(),
    m.Acc_User.find({ email: target }).select("passwordHash role isActive name organizationId").lean(),
    m.DeptUser.findOne({ email: target }).lean(),
    m.DeptUser.findOne({ email: duplicate }).lean(),
    m.DeptUser.countDocuments({ isAdmin: true, isActive: true }),
  ]);

  if (!home || !home.isActive) blockers.push("HOME_APPLICATION_MISSING_OR_INACTIVE");
  const activeAcc = accUsers.filter((a) => a.isActive !== false);
  if (!existing) {
    if (activeAcc.length === 0) blockers.push("TARGET_HAS_NO_ACTIVE_CREDENTIAL");
    if (activeAcc.length > 1) blockers.push("TARGET_CREDENTIAL_AMBIGUOUS");
    if (activeAcc.length === 1 && !BCRYPT_RE.test(String(activeAcc[0].passwordHash || ""))) {
      blockers.push("TARGET_CREDENTIAL_NOT_BCRYPT");
    }
  }
  if (activeAdminsBefore < 1) blockers.push("NO_ACTIVE_ADMINISTRATOR_BEFORE");

  if (!existing) {
    actions.push("CREATE_CANONICAL_DEPT_USER_REUSING_ACC_USER_BCRYPT");
  } else {
    if (!existing.isAdmin) actions.push("SET_IS_ADMIN_TRUE");
    if (existing.isActive === false) actions.push("REACTIVATE_CANONICAL");
    if (home && String(existing.departmentId) !== String(home._id)) actions.push("SET_HOME_APPLICATION_EXECUTIVE_OFFICE");
  }

  const canonicalId = existing?._id || null;
  if (dup) {
    const t = dup.identityTransition;
    const alreadyMarked = t && lower(t.supersededByEmail) === target;
    if (!alreadyMarked) actions.push("MARK_DUPLICATE_TRANSITIONAL");
  }

  // Admin count after: the canonical row becomes an active admin; nothing is
  // deactivated by this step.
  const canonicalWillBeAdmin = true;
  const canonicalWasActiveAdmin = Boolean(existing?.isAdmin && existing.isActive !== false);
  const activeAdminsAfter = activeAdminsBefore + (canonicalWillBeAdmin && !canonicalWasActiveAdmin ? 1 : 0);
  if (activeAdminsAfter < 1) blockers.push("NO_ACTIVE_ADMINISTRATOR_AFTER");

  return {
    mode: "plan",
    actions,
    blockers,
    counts: {
      targetAccUsers: accUsers.length,
      targetActiveAccUsers: activeAcc.length,
      targetAccountingOwner: activeAcc.filter((a) => a.role === "owner").length,
      targetDeptUserExists: existing ? 1 : 0,
      duplicateDeptUserExists: dup ? 1 : 0,
      activeAdminsBefore,
      activeAdminsAfter,
      recordsToDelete: 0,
    },
    _internal: { home, credential: activeAcc[0] || null, existing, dup, canonicalId, target, duplicate },
  };
}

/** Apply a plan. Idempotent: each action re-checks its own precondition. */
async function applyMigration(m, plan, { session = null, now = new Date() } = {}) {
  if (plan.blockers.length) throw new Error(`Refusing to apply: ${plan.blockers.join(", ")}`);
  const { home, credential, existing, target, duplicate } = plan._internal;
  const opts = session ? { session } : {};
  let canonicalId = existing?._id || null;

  if (plan.actions.includes("CREATE_CANONICAL_DEPT_USER_REUSING_ACC_USER_BCRYPT")) {
    // Raw collection insert: no model hook may touch or re-hash the credential.
    const res = await m.DeptUser.collection.insertOne({
      email: target,
      name: credential.name || target,
      passwordHash: credential.passwordHash, // opaque bcrypt string, copied as-is
      departmentId: home._id,
      isAdmin: true,
      isActive: true,
      mustChangePassword: false,
      tokenVersion: 0,
      failedLoginCount: 0,
      legacyRole: home.legacyRole || HOME_SLUG,
      profile: {},
      capabilityOverrides: { grant: [], deny: [] },
      createdAt: now,
      updatedAt: now,
    }, opts);
    canonicalId = res.insertedId;
  } else if (existing) {
    const $set = { updatedAt: now };
    if (plan.actions.includes("SET_IS_ADMIN_TRUE")) $set.isAdmin = true;
    if (plan.actions.includes("REACTIVATE_CANONICAL")) $set.isActive = true;
    if (plan.actions.includes("SET_HOME_APPLICATION_EXECUTIVE_OFFICE")) $set.departmentId = home._id;
    if (Object.keys($set).length > 1) await m.DeptUser.collection.updateOne({ _id: existing._id }, { $set }, opts);
  }

  if (plan.actions.includes("MARK_DUPLICATE_TRANSITIONAL")) {
    await m.DeptUser.collection.updateOne(
      { email: duplicate },
      { $set: { identityTransition: {
        supersededByEmail: target,
        supersededById: canonicalId,
        eligibleForDeactivation: false,
        reason: "GAC-AR2: one person, one login — superseded by the canonical administrator login",
        markedAt: now,
      }, updatedAt: now } },
      opts,
    );
  }

  const activeAdmins = await m.DeptUser.countDocuments({ isAdmin: true, isActive: true }).session(session || null);
  if (activeAdmins < 1) throw new Error("Invariant broken: no active administrator after apply");
  return { mode: "applied", actions: plan.actions, activeAdminsAfter: activeAdmins };
}

/**
 * The later, separate step: may the transitional duplicate be deactivated?
 * Pure decision over current state; no writes.
 */
async function planDeactivation(m, { targetEmail = TARGET_EMAIL, duplicateEmail = DUPLICATE_EMAIL } = {}) {
  const target = lower(targetEmail);
  const duplicate = lower(duplicateEmail);
  const [canonical, dup] = await Promise.all([
    m.DeptUser.findOne({ email: target }).lean(),
    m.DeptUser.findOne({ email: duplicate }).lean(),
  ]);
  const blockers = [];
  if (!dup) blockers.push("DUPLICATE_NOT_FOUND");
  if (dup && dup.isActive === false) return { mode: "plan", actions: [], blockers: [], counts: { alreadyInactive: 1 } };
  if (!dup?.identityTransition || lower(dup.identityTransition.supersededByEmail) !== target) blockers.push("DUPLICATE_NOT_MARKED_TRANSITIONAL");
  if (!canonical) blockers.push("CANONICAL_NOT_FOUND");
  if (canonical && (!canonical.isActive || !canonical.isAdmin)) blockers.push("CANONICAL_NOT_ACTIVE_ADMIN");
  const markedAt = dup?.identityTransition?.markedAt ? new Date(dup.identityTransition.markedAt) : null;
  if (canonical && (!canonical.lastLogin || !markedAt || new Date(canonical.lastLogin) <= markedAt)) {
    blockers.push("CANONICAL_NOT_VERIFIED_BY_SIGN_IN");
  }
  const otherActiveAdmins = await m.DeptUser.countDocuments({
    isAdmin: true, isActive: true, ...(dup ? { _id: { $ne: dup._id } } : {}),
  });
  if (otherActiveAdmins < 1) blockers.push("LAST_ACTIVE_ADMINISTRATOR");
  return {
    mode: "plan",
    actions: blockers.length ? [] : ["DEACTIVATE_TRANSITIONAL_DUPLICATE"],
    blockers,
    counts: { otherActiveAdmins, recordsToDelete: 0 },
    _internal: { dup },
  };
}

async function applyDeactivation(m, plan, { session = null, now = new Date() } = {}) {
  if (plan.blockers.length) throw new Error(`Refusing to deactivate: ${plan.blockers.join(", ")}`);
  if (!plan.actions.length) return { mode: "applied", actions: [] };
  const opts = session ? { session } : {};
  await m.DeptUser.collection.updateOne(
    { _id: plan._internal.dup._id, isActive: true },
    { $set: { isActive: false, "identityTransition.eligibleForDeactivation": true, updatedAt: now }, $inc: { tokenVersion: 1 } },
    opts,
  );
  const activeAdmins = await m.DeptUser.countDocuments({ isAdmin: true, isActive: true }).session(session || null);
  if (activeAdmins < 1) throw new Error("Invariant broken: no active administrator after deactivation");
  return { mode: "applied", actions: plan.actions, activeAdminsAfter: activeAdmins };
}

/** Run a step inside a transaction when the deployment supports one. */
async function withOptionalTransaction(mongoose, fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    try {
      await session.withTransaction(async () => { out = await fn(session); });
      return { ...out, transaction: true };
    } catch (err) {
      if (/Transaction numbers are only allowed|replica set|not supported/i.test(String(err?.message))) {
        out = await fn(null);
        return { ...out, transaction: false };
      }
      throw err;
    }
  } finally {
    await session.endSession();
  }
}

const publicView = (p) => ({ mode: p.mode, actions: p.actions, blockers: p.blockers, counts: p.counts });

async function main(argv = process.argv.slice(2)) {
  const mongoose = require("mongoose");
  const apply = argv.includes("--apply");
  const deactivate = argv.includes("--deactivate-transitional");
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const m = {
      DeptUser: require("../../models/Access/DeptUser"),
      AccessDepartment: require("../../models/Access/AccessDepartment"),
      Acc_User: require("../../models/Accountant_model/Acc_OrgModels").Acc_User,
    };
    const step = deactivate ? "deactivate-transitional" : "canonical-admin";
    const plan = deactivate ? await planDeactivation(m) : await planMigration(m);
    const report = { step, dryRun: !apply, before: publicView(plan) };
    if (apply && !plan.blockers.length && plan.actions.length) {
      report.result = await withOptionalTransaction(mongoose, (session) =>
        (deactivate ? applyDeactivation(m, plan, { session }) : applyMigration(m, plan, { session })));
      const after = deactivate ? await planDeactivation(m) : await planMigration(m);
      report.after = publicView(after);
    }
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    await mongoose.disconnect();
  }
}

module.exports = { planMigration, applyMigration, planDeactivation, applyDeactivation, publicView, TARGET_EMAIL, DUPLICATE_EMAIL };

if (require.main === module) {
  main().then((r) => process.exit(r.before.blockers.length ? 1 : 0)).catch((err) => {
    console.error(JSON.stringify({ error: String(err?.message || err) }));
    process.exit(2);
  });
}
