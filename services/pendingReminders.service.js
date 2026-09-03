// services/pendingReminders.service.js
//
// "You still have things waiting on you." Hourly, and only if asked.
//
// ── IT COUNTS WHAT IS ACTUALLY OUTSTANDING ──────────────────────────────────
// Not "send the last notification again". Each type is a live query for work
// that is genuinely still pending, so the moment somebody approves the last
// leave in their queue the reminders stop — without anything having to
// remember that a reminder was owed. A reminder that keeps arriving after the
// work is done is the fastest way to teach somebody to ignore reminders.
//
// ── OFF UNLESS SOMEBODY TURNED IT ON ────────────────────────────────────────
// Every repeat preference defaults to false. This job reaches only the devices
// whose owner switched that type's repeat on, and only ever hourly per device
// per type. Somebody with three devices who enabled it on one gets it on one.
//
// ── IT NEVER TELLS ANYBODY ABOUT SOMEBODY ELSE'S QUEUE ──────────────────────
// Each query is scoped to the approver it is about to notify. The counts in the
// message are that person's own.

"use strict";

const NotificationDevice = require("../models/Access/NotificationDevice");
const { notifyEmployeeDevices } = require("./notifyDevices.service");

/** An hour, less a minute of slack so a job that runs at :00:05 is not skipped. */
const REPEAT_INTERVAL_MS = 59 * 60 * 1000;

/**
 * How many items of each repeatable type are pending FOR THIS PERSON.
 *
 * Each entry returns a count and the words to say. A type whose model is not
 * present in this deployment simply contributes nothing rather than failing the
 * whole sweep.
 */
const PENDING_COUNTERS = [
  {
    type: "leave_pending",
    async count(employee) {
      const { LeaveApplication } = require("../models/HR_Models/LeaveManagement");
      if (!LeaveApplication) return 0;
      return LeaveApplication.countDocuments({
        status: { $in: ["pending", "manager_approved"] },
        "managersNotified.managerId": employee._id,
      });
    },
    say: (n) => ({
      title: "Leave waiting for you",
      body: `${n} leave application${n === 1 ? "" : "s"} still need${n === 1 ? "s" : ""} your decision.`,
    }),
  },
  {
    type: "regularization_pending",
    async count(employee) {
      const { RegularizationRequest } = require("../models/HR_Models/LeaveManagement");
      if (!RegularizationRequest) return 0;
      return RegularizationRequest.countDocuments({
        status: { $in: ["pending", "manager_approved"] },
        "managersNotified.managerId": employee._id,
      });
    },
    say: (n) => ({
      title: "Attendance corrections waiting",
      body: `${n} correction${n === 1 ? "" : "s"} still need${n === 1 ? "s" : ""} your approval.`,
    }),
  },
  {
    type: "overtime_pending",
    async count(employee) {
      let OvertimeRequest;
      try {
        ({ OvertimeRequest } = require("../models/HR_Models/LeaveManagement"));
      } catch { return 0; }
      if (!OvertimeRequest) return 0;
      return OvertimeRequest.countDocuments({
        status: { $in: ["pending", "manager_approved"] },
        "managersNotified.managerId": employee._id,
      });
    },
    say: (n) => ({
      title: "Overtime waiting for you",
      body: `${n} overtime report${n === 1 ? "" : "s"} still need${n === 1 ? "s" : ""} sign-off.`,
    }),
  },
  {
    type: "department_approval",
    async count(employee) {
      const ChangeRequest = require("../models/Access/ChangeRequest");
      const { listRoles, roleAtLeast } = require("./departmentRoles");
      const email = String(employee.email || "").toLowerCase();
      if (!email) return 0;
      /* Only the departments this person can actually decide in. Counting a
         queue they cannot clear would be a reminder about somebody else's
         work. */
      const slugs = [];
      for (const slug of ["hr", "sales", "store", "qc", "accountant", "project-manager"]) {
        const rows = await listRoles(slug).catch(() => []);
        const mine = rows.find((r) => String(r.email).toLowerCase() === email && r.isActive !== false);
        if (mine && roleAtLeast(mine.role, "approver")) slugs.push(slug);
      }
      if (!slugs.length) return 0;
      return ChangeRequest.countDocuments({
        departmentSlug: { $in: slugs },
        status: { $in: ["pending", "failed"] },
      });
    },
    say: (n) => ({
      title: "Changes waiting for approval",
      body: `${n} change${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} waiting in your queue.`,
    }),
  },
];

/** Has this device already had this type within the hour? */
function repeatedRecently(device, type, now) {
  const last = device.lastRepeatAt?.get?.(type) || device.lastRepeatAt?.[type];
  if (!last) return false;
  return now - new Date(last).getTime() < REPEAT_INTERVAL_MS;
}

/**
 * One sweep.
 *
 * Starts from the DEVICES that asked for repeats rather than from every
 * employee: almost nobody turns this on, so the sweep costs one small query
 * plus the counts for the few people who did — not a scan of the company every
 * hour.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] report what would be sent, send nothing
 */
async function runPendingReminders({ dryRun = false } = {}) {
  const now = Date.now();
  const report = { employees: 0, sent: 0, skipped: 0, byType: {} };

  /* Any device with at least one repeat switched on. A Map query cannot be
     indexed usefully here, so the candidates are narrowed in memory — the
     collection is one row per device, and only enabled ones are read. */
  const devices = await NotificationDevice.find({ enabled: true }).lean();
  const wantsRepeat = new Map(); // employeeId -> Set(type)

  for (const d of devices) {
    const prefs = d.prefs || {};
    const entries = prefs instanceof Map ? [...prefs.entries()] : Object.entries(prefs);
    for (const [type, p] of entries) {
      if (!p?.repeat || !p?.enabled) continue;
      const key = String(d.employeeId);
      if (!wantsRepeat.has(key)) wantsRepeat.set(key, new Set());
      wantsRepeat.get(key).add(type);
    }
  }

  if (!wantsRepeat.size) return report;

  const Employee = require("../models/Employee");
  for (const [employeeId, types] of wantsRepeat) {
    const employee = await Employee.findById(employeeId).select("_id email firstName lastName").lean();
    if (!employee) continue;
    report.employees += 1;

    for (const counter of PENDING_COUNTERS) {
      if (!types.has(counter.type)) continue;

      /* Every device of this person that wants THIS type and has not had it
         within the hour. If none, the count query is not even run. */
      const due = devices.filter((d) => {
        if (String(d.employeeId) !== employeeId) return false;
        const prefs = d.prefs || {};
        const p = prefs instanceof Map ? prefs.get(counter.type) : prefs[counter.type];
        return p?.enabled && p?.repeat && !repeatedRecently(d, counter.type, now);
      });
      if (!due.length) { report.skipped += 1; continue; }

      let n = 0;
      try {
        n = await counter.count(employee);
      } catch (err) {
        console.warn(`[reminders] ${counter.type} count failed:`, err.message);
        continue;
      }
      /* Nothing outstanding — no reminder. This is what makes the reminders
         stop on their own the moment the queue is cleared. */
      if (!n) continue;

      report.byType[counter.type] = (report.byType[counter.type] || 0) + 1;
      if (dryRun) { report.sent += 1; continue; }

      const words = counter.say(n);
      const out = await notifyEmployeeDevices(
        employee,
        { type: counter.type, title: words.title, body: words.body },
        { isRepeat: true },
      );
      report.sent += out.sent;
      report.skipped += out.skipped;
    }
  }

  return report;
}

/**
 * Register the hourly sweep.
 *
 * setInterval rather than node-cron, matching the two schedules already in
 * server.js. Started once at boot; a second call is a no-op so a hot reload
 * cannot stack two sweeps.
 */
let timer = null;
function startPendingReminders({ everyMs = 60 * 60 * 1000 } = {}) {
  if (timer) return timer;
  timer = setInterval(() => {
    runPendingReminders().catch((e) => console.warn("[reminders]", e.message));
  }, everyMs);
  /* Does not hold the process open: a sweep is never the reason to stay
     alive. */
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { runPendingReminders, startPendingReminders, PENDING_COUNTERS, REPEAT_INTERVAL_MS };
