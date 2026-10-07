"use strict";
/**
 * services/startupRepairs.js — data repairs that travel with the CODE.
 *
 * Several fixes made on 5–6 Oct 2026 were first applied by running a one-off
 * script against the development database. Production is a DIFFERENT
 * database, so a deploy carried the new code and none of the repaired data,
 * and the same complaints came back there. Everything below is the code form of
 * those repairs: it runs once on every boot of the instance that runs the
 * background jobs, against whatever database that instance is connected to,
 * and each step is idempotent — a second boot finds nothing to do.
 *
 *   1. lateRegularized — a day whose late arrival was taken away by an
 *      approved regularization keeps its place in the late streak (3rd late =
 *      late half day, 5th = absent). New regularizations stamp the marker as
 *      they are applied; this stamps the ones approved before that existed.
 *      Evidence is the request's own `originalSnapshot` — never a guess.
 *   2. departed employees — nobody current reports to, waits on, or is
 *      approved by somebody who has left. New departures are detached when HR
 *      marks them inactive; this catches everyone who left before that.
 *   3. platform administrators can read Accounting — the CEO dashboard's
 *      accounting pages sign as the CEO's own Accounting record. A database
 *      where the CEO has none answered every one of them with a refusal.
 *
 * Nothing here deletes anything, and nothing here grants anybody who is not a
 * platform administrator a thing.
 */

const { detachDepartedEmployee, hasLeft } = require("./employeeDeparture");

const LATE_PREDICTIONS = ["P*", "LHD", "LAB"];

/* ── 1 ─────────────────────────────────────────────────────────────────── */
async function repairLateRegularized(db) {
  const requests = await db
    .collection("regularizationrequests")
    .find(
      {
        status: "hr_approved",
        appliedToAttendance: true,
        "originalSnapshot.lateMins": { $gt: 0 },
        "originalSnapshot.systemPrediction": { $in: LATE_PREDICTIONS },
      },
      { projection: { employeeId: 1, biometricId: 1, dateStr: 1 } },
    )
    .toArray();

  let stamped = 0;
  for (const r of requests) {
    const day = await db.collection("dailyattendances").findOne({ dateStr: r.dateStr }, { projection: { employees: 1 } });
    if (!day) continue;
    const k = (day.employees || []).findIndex(
      (e) => (r.employeeId && String(e.employeeDbId) === String(r.employeeId)) || (r.biometricId && e.biometricId === r.biometricId),
    );
    if (k < 0) continue;
    const e = day.employees[k];
    /* Still late (the regularization did not take the late away) or already
       stamped: nothing to do. */
    if (e.isLate || e.lateRegularized) continue;
    await db.collection("dailyattendances").updateOne({ _id: day._id }, { $set: { [`employees.${k}.lateRegularized`]: true } });
    stamped++;
  }
  return { checked: requests.length, stamped };
}

/* ── 2 ─────────────────────────────────────────────────────────────────── */
async function repairDepartedEmployees(db) {
  const gone = await db
    .collection("employees")
    .find({ $or: [{ isActive: false }, { status: "inactive" }] })
    .project({ firstName: 1, lastName: 1, biometricId: 1, email: 1, isActive: 1, status: 1 })
    .toArray();

  const touched = [];
  for (const emp of gone) {
    if (!hasLeft(emp)) continue;
    const plan = await detachDepartedEmployee(db, emp, { dryRun: true });
    const n = plan.reports.length + plan.departments.length + plan.requests.length + plan.grants.length;
    if (!n) continue;
    await detachDepartedEmployee(db, emp, { by: "startup repair" });
    touched.push(`${plan.employee}: ${n}`);
  }
  return { departed: gone.length, detached: touched };
}

/* ── 3 ─────────────────────────────────────────────────────────────────── */
async function ensureAdminAccounting(db) {
  const admins = await db.collection("dept_users").find({ isAdmin: true, isActive: { $ne: false } }).toArray();
  if (!admins.length) return { admins: 0, created: [] };

  const orgs = await db.collection("acc_organizations").find({}).project({ _id: 1 }).toArray();
  /* One set of books is the only case where "which organisation" has a single
     answer. With several, an administrator must be placed deliberately. */
  if (orgs.length !== 1) return { admins: admins.length, created: [], skipped: `${orgs.length} organisations` };

  const { Acc_User } = require("../models/Accountant_model/Acc_OrgModels");
  const created = [];
  for (const a of admins) {
    const email = String(a.email || "").toLowerCase().trim();
    if (!email) continue;
    /* Any row at all — even an INACTIVE one — is somebody's decision, and is
       left exactly as it is. Only a missing row is filled in. */
    if (await db.collection("acc_users").findOne({ email })) continue;
    await Acc_User.create({
      organizationId: orgs[0]._id,
      name: a.name || email,
      email,
      loginMode: "none",
      role: "approver",
      isActive: true,
    });
    created.push(email);
  }
  return { admins: admins.length, created };
}

async function runStartupRepairs(db, log = console) {
  const steps = [
    ["late streak markers", repairLateRegularized],
    ["departed employees", repairDepartedEmployees],
    ["administrator accounting access", ensureAdminAccounting],
  ];
  for (const [name, step] of steps) {
    try {
      log.log(`[startup-repair] ${name}:`, JSON.stringify(await step(db)));
    } catch (err) {
      /* One failed repair never stops the others, and never the server. */
      log.error(`[startup-repair] ${name} failed:`, err?.message || err);
    }
  }
}

module.exports = { runStartupRepairs, repairLateRegularized, repairDepartedEmployees, ensureAdminAccounting };
