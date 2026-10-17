"use strict";

const crypto = require("crypto");
const Employee = require("../models/Employee");
const Preference = require("../models/Access/VoiceAutomationPreference");
const Session = require("../models/MrfVoiceApprovalSession");
const voice = require("./mrfVoiceApproval.service");
const { homeFor } = require("./home/employeeHome.service");
const { notifyEmployeeDevices } = require("./notifyDevices.service");

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_DAYS = [1, 2, 3, 4, 5];
const SCHEDULE_WINDOW_MINUTES = 10;

function istParts(now = new Date()) {
  const shifted = new Date(now.getTime() + 330 * 60 * 1000);
  return {
    date: shifted.toISOString().slice(0, 10),
    time: shifted.toISOString().slice(11, 16),
    weekday: shifted.getUTCDay(),
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function minuteOf(value) {
  if (!TIME_RE.test(String(value || ""))) return null;
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours * 60 + minutes;
}

function cleanWeekdays(value) {
  const days = [...new Set((Array.isArray(value) ? value : DEFAULT_DAYS)
    .map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
  return days.length ? days : DEFAULT_DAYS;
}

function normalizeInput(input = {}, installedLanguages = ["en"]) {
  const time = String(input.time || "09:15");
  if (!TIME_RE.test(time)) {
    const error = new Error("Choose a valid morning brief time.");
    error.code = "MORNING_BRIEF_TIME_INVALID";
    throw error;
  }
  const language = String(input.language || "en").toLowerCase();
  if (!installedLanguages.includes(language)) {
    const error = new Error("That morning brief voice is not installed.");
    error.code = "MORNING_BRIEF_LANGUAGE_UNAVAILABLE";
    throw error;
  }
  return { enabled: Boolean(input.enabled), time, weekdays: cleanWeekdays(input.weekdays), language };
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function buildSummary(home, approvalCounts = {}) {
  const sections = home?.sections || {};
  const sentences = [];
  const attendance = sections.attendance || {};
  if (attendance.status === "unavailable") sentences.push("Attendance is temporarily unavailable.");
  else if (attendance.status === "ok" && attendance.recorded && attendance.inTime) {
    sentences.push(`You checked in at ${attendance.inTime}${attendance.late ? ", marked late" : ""}.`);
  } else if (attendance.status === "ok" && !attendance.recorded) sentences.push("There is no attendance punch recorded yet.");

  const meetingCount = sections.meetings?.status === "ok" ? (sections.meetings.items || []).length : 0;
  const interviewCount = sections.interviews?.status === "ok" ? (sections.interviews.items || []).length : 0;
  if (meetingCount || interviewCount) {
    sentences.push(`Today you have ${plural(meetingCount, "meeting")} and ${plural(interviewCount, "interview")}.`);
  }

  const tasks = sections.tasks || {};
  const planner = sections.planner || {};
  const overdue = Number(tasks.overdue || 0) + Number(planner.overdue || 0);
  const dueToday = Number(tasks.dueToday || 0) + Number(planner.dueToday || 0);
  const reviews = Number(tasks.toReview || 0);
  if (overdue || dueToday || reviews) {
    sentences.push(`Work needs attention: ${plural(overdue, "overdue item")}, ${plural(dueToday, "item due today")}, and ${plural(reviews, "review")}.`);
  }

  const approvals = Object.values(approvalCounts).reduce((sum, value) => sum + Number(value || 0), 0);
  if (approvals) sentences.push(`${plural(approvals, "approval")} ${approvals === 1 ? "is" : "are"} waiting for you.`);

  const leave = sections.leave || {};
  if (leave.status === "ok" && leave.today) sentences.push("Your approved leave covers today, so the scheduled call should normally be skipped.");
  else if (leave.status === "ok" && (leave.pending || []).length) sentences.push(`${plural(leave.pending.length, "leave request")} of yours is still pending.`);

  if (!sentences.length) sentences.push("Nothing urgent is showing in your personal work summary right now.");
  return {
    text: sentences.join(" ").slice(0, 1800),
    sections: {
      attendance: attendance.status || "none",
      meetings: meetingCount,
      interviews: interviewCount,
      overdue,
      dueToday,
      reviews,
      approvals,
    },
    skipForLeave: Boolean(leave.status === "ok" && leave.today),
  };
}

async function employeeFor({ biometricId, employeeId }, { EmployeeModel = Employee } = {}) {
  const or = [];
  if (employeeId) or.push({ _id: employeeId });
  if (biometricId) or.push({ biometricId: String(biometricId) }, { identityId: String(biometricId) });
  if (!or.length) return null;
  return EmployeeModel.findOne({ $or: or, isActive: { $ne: false }, status: { $ne: "inactive" } })
    .select("_id biometricId identityId email firstName middleName lastName")
    .lean();
}

function employeeName(employee) {
  return [employee?.firstName, employee?.middleName, employee?.lastName].filter(Boolean).join(" ") || "GRAV colleague";
}

async function preferenceForActor({ companyId, biometricId }, deps = {}) {
  const PreferenceModel = deps.PreferenceModel || Preference;
  const employee = await employeeFor({ biometricId }, deps);
  if (!employee) return null;
  const row = await PreferenceModel.findOne({ companyId, employee: employee._id }).lean();
  const configured = row?.morningBrief || {};
  return {
    employeeId: String(employee._id),
    timezone: row?.timezone || "Asia/Kolkata",
    morningBrief: {
      enabled: Boolean(configured.enabled),
      time: configured.time || "09:15",
      weekdays: cleanWeekdays(configured.weekdays),
      language: configured.language || "en",
    },
  };
}

async function savePreference({ companyId, biometricId, input }, deps = {}) {
  const PreferenceModel = deps.PreferenceModel || Preference;
  const employee = await employeeFor({ biometricId }, deps);
  if (!employee) {
    const error = new Error("Your employee record is not linked for morning briefs.");
    error.code = "MORNING_BRIEF_IDENTITY_MISSING";
    throw error;
  }
  const normalized = normalizeInput(input, voice.config(deps.env || process.env).languages);
  const row = await PreferenceModel.findOneAndUpdate(
    { companyId, employee: employee._id },
    {
      $set: {
        biometricId: String(employee.biometricId || employee.identityId || biometricId),
        timezone: "Asia/Kolkata",
        "morningBrief.enabled": normalized.enabled,
        "morningBrief.time": normalized.time,
        "morningBrief.weekdays": normalized.weekdays,
        "morningBrief.language": normalized.language,
      },
      $setOnInsert: { companyId, employee: employee._id },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  return {
    employeeId: String(employee._id),
    timezone: row.timezone,
    morningBrief: normalized,
  };
}

async function approvalCounts(employee) {
  const { PENDING_COUNTERS } = require("./pendingReminders.service");
  const wanted = new Set(["leave_pending", "regularization_pending", "overtime_pending"]);
  const counts = {};
  await Promise.all(PENDING_COUNTERS.filter((counter) => wanted.has(counter.type)).map(async (counter) => {
    try { counts[counter.type] = await counter.count(employee); }
    catch { counts[counter.type] = 0; }
  }));
  return counts;
}

async function createCall({ companyId, employee, language = "en", scheduledDate = "", manual = false, notify = false, now = new Date() }, deps = {}) {
  const SessionModel = deps.SessionModel || Session;
  const homeLoader = deps.homeFor || homeFor;
  const countLoader = deps.approvalCounts || approvalCounts;
  const notifier = deps.notifyEmployeeDevices || notifyEmployeeDevices;
  const state = voice.readiness(deps.env || process.env);
  if (!state.ready) {
    const error = new Error(`Voice workflow is not ready: ${state.missing.join(", ")}.`);
    error.code = "MRF_VOICE_NOT_READY";
    throw error;
  }
  const biometricId = String(employee.biometricId || employee.identityId || "").trim();
  if (!companyId || !employee?._id || !biometricId) {
    const error = new Error("Your employee record is not linked for morning briefs.");
    error.code = "MORNING_BRIEF_IDENTITY_MISSING";
    throw error;
  }
  const user = { id: String(employee._id), email: employee.email || "", subject: "employee", name: employeeName(employee) };
  const [home, counts] = await Promise.all([homeLoader(user, { fresh: true }), countLoader(employee)]);
  const brief = buildSummary(home, counts);
  if (!manual && brief.skipForLeave) return { skipped: "on_leave", call: null };

  const day = scheduledDate || istParts(now).date;
  const occurrenceKey = manual
    ? `morning-brief:${companyId}:${employee._id}:manual:${crypto.randomUUID()}`
    : `morning-brief:${companyId}:${employee._id}:${day}`;
  await SessionModel.updateMany(
    {
      companyId,
      approverBiometricId: biometricId,
      status: { $in: voice.ACTIVE },
      expiresAt: { $lte: now },
    },
    { $set: { status: "STALE", completedAt: now } },
  );
  const active = await SessionModel.findOne({
    companyId,
    approverBiometricId: biometricId,
    status: { $in: voice.ACTIVE },
    expiresAt: { $gt: now },
  });
  if (active) return { skipped: "recipient_busy", call: voice.publicView(active) };

  try {
    const row = await SessionModel.create({
      companyId,
      workflowKey: "morning_brief",
      occurrenceKey,
      subjectLabel: `Morning brief · ${day}`,
      workflowTitle: "Your GRAV morning brief",
      workflowSummary: brief.text,
      workflowSnapshot: { generatedAt: home.generatedAt, today: home.today, sections: brief.sections },
      approverEmployee: employee._id,
      approverBiometricId: biometricId,
      approverName: employeeName(employee),
      language,
      expiresAt: new Date(now.getTime() + 20 * 60 * 1000),
    });
    if (notify) {
      await notifier(employee, {
        type: "morning_brief_call",
        title: "Your GRAV morning brief is ready",
        body: "Answer to hear today's priorities, meetings and work needing attention.",
        url: `/onboarding?mrfVoiceCall=${encodeURIComponent(String(row._id))}`,
        tag: `mrf-call-${String(row._id)}`,
        ttlSeconds: 10 * 60,
        data: { sessionId: String(row._id), workflowKey: "morning_brief" },
      });
    }
    return { skipped: "", call: voice.publicView(row) };
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await SessionModel.findOne({ occurrenceKey });
      return { skipped: "duplicate", call: voice.publicView(existing) };
    }
    throw error;
  }
}

async function callNow({ companyId, biometricId }, deps = {}) {
  const employee = await employeeFor({ biometricId }, deps);
  if (!employee) {
    const error = new Error("Your employee record is not linked for morning briefs.");
    error.code = "MORNING_BRIEF_IDENTITY_MISSING";
    throw error;
  }
  const pref = await preferenceForActor({ companyId, biometricId }, deps);
  return createCall({ companyId, employee, language: pref?.morningBrief.language || "en", manual: true }, deps);
}

async function runScheduled({ now = new Date() } = {}, deps = {}) {
  const PreferenceModel = deps.PreferenceModel || Preference;
  const parts = istParts(now);
  const rows = await PreferenceModel.find({ "morningBrief.enabled": true }).lean();
  const report = { checked: rows.length, queued: 0, skipped: 0, failures: 0 };
  for (const pref of rows) {
    const due = minuteOf(pref.morningBrief?.time);
    const weekdays = cleanWeekdays(pref.morningBrief?.weekdays);
    if (due == null || !weekdays.includes(parts.weekday) || parts.minute < due || parts.minute - due > SCHEDULE_WINDOW_MINUTES) continue;
    if (pref.morningBrief?.lastScheduledLocalDate === parts.date) continue;
    try {
      const employee = await employeeFor({ employeeId: pref.employee }, deps);
      if (!employee) { report.skipped += 1; continue; }
      const result = await createCall({
        companyId: pref.companyId,
        employee,
        language: pref.morningBrief?.language || "en",
        scheduledDate: parts.date,
        notify: true,
        now,
      }, deps);
      await PreferenceModel.updateOne({ _id: pref._id }, { $set: { "morningBrief.lastScheduledLocalDate": parts.date } });
      if (result.call && !result.skipped) report.queued += 1;
      else report.skipped += 1;
    } catch (error) {
      report.failures += 1;
      console.warn("[morning-brief] schedule failed:", error.message);
    }
  }
  return report;
}

let timer = null;
function startScheduler({ everyMs = 60 * 1000 } = {}) {
  if (timer) return timer;
  const tick = () => runScheduled().catch((error) => console.warn("[morning-brief]", error.message));
  tick();
  timer = setInterval(tick, everyMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  DEFAULT_DAYS,
  SCHEDULE_WINDOW_MINUTES,
  buildSummary,
  callNow,
  createCall,
  istParts,
  normalizeInput,
  preferenceForActor,
  runScheduled,
  savePreference,
  startScheduler,
};

