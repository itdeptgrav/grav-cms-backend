// services/home/employeeHome.service.js
//
// GET /api/me/home — the employee home (/onboarding) for the signed-in person:
// what is waiting on them personally, what their day holds, and the company's
// people moments. GET /api/me/people — a minimal colleague search.
//
// ── WHO "ME" IS ─────────────────────────────────────────────────────────────
// A CMS session is one of three identities (appAccess.service.verifiedIdentity):
//   employee     → the Employee itself (token id = Employee _id)
//   dept_user    → its `employeeRef` Employee, else the Employee carrying its
//                  badge (`DeptUser.employeeId` = `Employee.biometricId`), else
//                  the one active Employee with its email
//   accountant   → the one active Employee with its email
// Nothing is taken from the token beyond those identifiers. A person with no
// Employee record still gets the company sections and their own Planner.
//
// ── WHAT IS SHOWN ───────────────────────────────────────────────────────────
// Only what exists in the database (owner, 10 Oct 2026: "only show what
// exists"): attendance today, the person's own leave applications,
// regularisations and HR document requests, their Planner, HR interviews they
// sit in, Cowork meetings, company holidays, who is on approved leave today,
// and birthdays / work anniversaries / new joiners. No announcements, kudos,
// events, training or tickets — none of those exist yet.
//
// ── COST ────────────────────────────────────────────────────────────────────
// Every section is read at once and bounded (SECTION_TIMEOUT_MS); a failure is
// `{status:"unavailable"}`, never an empty list. The answer is memoised per
// identity for HOME_CACHE_MS (30 s); the company-wide people list for
// PEOPLE_CACHE_MS (10 min). The Cowork meetings read is one Firestore query.

"use strict";

const { SHIFT } = require("../manufacturing/shiftHours");
const mongoose = require("mongoose");
const {
  istToday, istDateStr, peopleMoments, covers, asDate, isTodayIst, displayName,
} = require("./homeDates");
const { withTimeout } = require("../actionables/actionablesSummary");

const SECTION_TIMEOUT_MS = Number(process.env.HOME_SECTION_TIMEOUT_MS || 6000);
const HOME_CACHE_MS = envMs("HOME_CACHE_MS", 30_000);
const PEOPLE_CACHE_MS = envMs("HOME_PEOPLE_CACHE_MS", 10 * 60_000);
const IST_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function envMs(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

const isOid = (v) => Boolean(v) && mongoose.Types.ObjectId.isValid(String(v));
const lower = (v) => String(v || "").toLowerCase().trim();

const M = {
  Employee: () => require("../../models/Employee"),
  DeptUser: () => require("../../models/Access/DeptUser"),
  Leave: () => require("../../models/HR_Models/LeaveManagement"),
  DailyAttendance: () => require("../../models/HR_Models/Dailyattendance"),
  EmployeeDocument: () => require("../../models/HR_Models/EmployeeDocument"),
  EmployeeTask: () => require("../../models/HR_Models/EmployeeTask"),
  PlannerTask: () => require("../../models/Planner/PlannerTask"),
  firestore: () => require("../../config/firebaseAdmin").db,
};

const EMPLOYEE_FIELDS = "firstName lastName name designation jobTitle department profilePhoto.url biometricId identityId coworkEmployeeId email dateOfJoining isActive status";
const ACTIVE = { isActive: { $ne: false }, status: { $ne: "inactive" } };

/* ── identity ─────────────────────────────────────────────────────────── */

async function oneByEmail(email) {
  const e = lower(email);
  if (!e) return null;
  const rows = await M.Employee().find({ email: e, ...ACTIVE }).select(EMPLOYEE_FIELDS).limit(2).lean();
  return rows.length === 1 ? rows[0] : null;
}

/** The caller's Employee record (or null) and how it was found. */
async function resolveEmployee(user) {
  const Employee = M.Employee();
  const subject = user?.subject || "";
  if (subject === "employee") {
    if (!isOid(user.id)) return { employee: null, via: "none" };
    const e = await Employee.findOne({ _id: user.id, ...ACTIVE }).select(EMPLOYEE_FIELDS).lean();
    return { employee: e || null, via: e ? "employee" : "none" };
  }
  if (subject === "accountant") {
    const e = await oneByEmail(user.email);
    return { employee: e, via: e ? "email" : "none" };
  }
  // A department login (and an unlabelled older token, which names one).
  if (isOid(user?.id)) {
    const du = await M.DeptUser().findById(user.id).select("employeeRef employeeId email").lean();
    if (du?.employeeRef) {
      const e = await Employee.findOne({ _id: du.employeeRef, ...ACTIVE }).select(EMPLOYEE_FIELDS).lean();
      if (e) return { employee: e, via: "linked" };
    }
    if (du?.employeeId) {
      const badge = String(du.employeeId).trim();
      const rows = await Employee.find({ biometricId: badge, ...ACTIVE, isDepartmentAccount: { $ne: true } })
        .select(EMPLOYEE_FIELDS).limit(2).lean();
      if (rows.length === 1) return { employee: rows[0], via: "badge" };
    }
    if (!du && subject !== "dept_user") {
      const e = await Employee.findOne({ _id: user.id, ...ACTIVE }).select(EMPLOYEE_FIELDS).lean();
      if (e) return { employee: e, via: "employee" };
    }
  }
  const e = await oneByEmail(user?.email);
  return { employee: e, via: e ? "email" : "none" };
}

/* ── sections ─────────────────────────────────────────────────────────── */

/** IST day bounds as instants, widened to also hold a day stored at UTC midnight. */
function dayWindow(now) {
  const { y, m, d } = istToday(now);
  const utcMidnight = Date.UTC(y, m, d);
  return { start: new Date(utcMidnight - IST_MS), end: new Date(utcMidnight + DAY_MS) };
}

async function attendanceSection(emp, today) {
  const bio = String(emp?.biometricId || "").trim().toUpperCase();
  if (!bio) return { status: "none" };
  const doc = await M.DailyAttendance()
    .findOne({ dateStr: today }, { dateStr: 1, employees: { $elemMatch: { biometricId: bio } } })
    .lean();
  const row = doc?.employees?.[0];
  if (!row) return { status: "ok", recorded: false };
  return {
    status: "ok",
    recorded: true,
    inTime: row.inTime || null,
    outTime: row.finalOut || null,
    code: row.hrFinalStatus || row.systemPrediction || null,
    shiftStart: row.shiftStart || null,
    shiftEnd: row.shiftEnd || null,
    late: Boolean(row.isLate),
    workedMins: Number(row.netWorkMins) || 0,
  };
}

const LEAVE_OPEN = ["pending", "manager_approved", "withdraw_pending"];

async function leaveSection(emp, today) {
  if (!emp) return { status: "none" };
  const { LeaveApplication } = M.Leave();
  const rows = await LeaveApplication.find({
    employeeId: emp._id,
    $or: [
      { status: { $in: LEAVE_OPEN } },
      { status: "hr_approved", toDate: { $gte: today } },
    ],
  })
    .select("leaveType fromDate toDate status isHalfDay halfDaySlot reason")
    .sort({ fromDate: 1 })
    .limit(12)
    .lean();
  const view = (r) => ({
    id: String(r._id), type: r.leaveType, from: r.fromDate, to: r.toDate, status: r.status,
    halfDay: Boolean(r.isHalfDay), slot: r.halfDaySlot || null,
  });
  const pending = rows.filter((r) => LEAVE_OPEN.includes(r.status)).map(view);
  const approved = rows.filter((r) => r.status === "hr_approved").map(view);
  return {
    status: "ok",
    pending,
    upcoming: approved.filter((r) => !covers(r.from, r.to, today)),
    today: approved.find((r) => covers(r.from, r.to, today)) || null,
  };
}

async function requestsSection(emp) {
  if (!emp) return { status: "none" };
  const { RegularizationRequest } = M.Leave();
  const [regularizations, documents] = await Promise.all([
    RegularizationRequest.countDocuments({ employeeId: emp._id, status: { $in: ["pending", "manager_approved"] } }).maxTimeMS(4000),
    M.EmployeeDocument().countDocuments({ employeeId: emp._id, requestStatus: "requested" }).maxTimeMS(4000),
  ]);
  return { status: "ok", regularizations, documents };
}

async function plannerSection(user, now) {
  if (!isOid(user?.id)) return { status: "none" };
  const { end } = dayWindow(now);
  const { y, m, d } = istToday(now);
  const startOfToday = Date.UTC(y, m, d) - IST_MS;
  const rows = await M.PlannerTask()
    .find({ ownerId: user.id, status: { $ne: "done" }, dueOn: { $lt: end } })
    .select("title status dueOn")
    .sort({ dueOn: 1 })
    .limit(20)
    .lean();
  const items = rows.map((t) => {
    const due = asDate(t.dueOn);
    const dueDay = due ? istDateStr(due) : null;
    const overdue = Boolean(due) && due.getTime() < startOfToday && dueDay !== istDateStr(now);
    return { id: String(t._id), title: t.title, status: t.status, dueOn: t.dueOn, overdue };
  });
  return {
    status: "ok",
    overdue: items.filter((t) => t.overdue).length,
    dueToday: items.filter((t) => !t.overdue).length,
    items: items.slice(0, 6),
  };
}

async function interviewsSection(emp, now) {
  if (!emp) return { status: "none" };
  const { start, end } = dayWindow(now);
  const rows = await M.EmployeeTask()
    .find({
      "participants.employeeId": emp._id,
      scheduledDate: { $gte: start, $lt: end },
      status: { $in: ["scheduled", "rescheduled", "in_progress"] },
    })
    .select("title scheduledDate scheduledTime duration location meetingRoom meetingLink interviewType status")
    .sort({ scheduledTime: 1 })
    .limit(10)
    .lean();
  return {
    status: "ok",
    items: rows.map((t) => ({
      id: String(t._id),
      title: t.title,
      time: t.scheduledTime || null,
      minutes: t.duration || null,
      place: t.meetingRoom || t.location || null,
      link: typeof t.meetingLink === "string" && /^https?:\/\//.test(t.meetingLink) ? t.meetingLink : null,
      kind: t.interviewType || null,
    })),
  };
}

async function meetingsSection(emp, now) {
  const coworkId = String(emp?.coworkEmployeeId || emp?.biometricId || "").trim();
  if (!coworkId) return { status: "none" };
  const db = M.firestore();
  // The organiser is always in `participants` (createCoworkMeet), so one query.
  const snap = await db.collection("cowork_scheduled_meets").where("participants", "array-contains", coworkId).get();
  const items = [];
  snap.forEach((doc) => {
    const m = doc.data() || {};
    if (m.isCancelled || m.status === "cancelled") return;
    if (!isTodayIst(m.dateTime, now)) return;
    const start = asDate(m.dateTime);
    const end = asDate(m.endsAt);
    items.push({
      id: doc.id,
      title: m.title || "Meeting",
      start: start ? start.toISOString() : null,
      end: end ? end.toISOString() : null,
      link: typeof m.googleMeetLink === "string" && /^https?:\/\//.test(m.googleMeetLink) ? m.googleMeetLink : null,
      organiser: m.createdBy === coworkId,
    });
  });
  items.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return { status: "ok", items: items.slice(0, 10) };
}

/* `items`: the next four from today. `month`: every holiday in this month and
   the next — what the home's calendar marks (it shows those two months). */
async function holidaysSection(today) {
  const { CompanyHoliday } = M.Leave();
  const [y, m] = today.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const after = m >= 11 ? `${y + 1}-${String(m - 10).padStart(2, "0")}-01` : `${y}-${String(m + 2).padStart(2, "0")}-01`;
  const view = (h) => ({ date: h.date, name: h.name, type: h.type || null });
  const [rows, month] = await Promise.all([
    CompanyHoliday.find({ date: { $gte: today } }).select("date name type").sort({ date: 1 }).limit(4).lean(),
    CompanyHoliday.find({ date: { $gte: from, $lt: after } }).select("date name type").sort({ date: 1 }).limit(40).lean(),
  ]);
  return { status: "ok", items: rows.map(view), month: month.map(view), range: { from, before: after } };
}

async function awaySection(emp, today) {
  const { LeaveApplication } = M.Leave();
  const rows = await LeaveApplication.find({ status: "hr_approved", fromDate: { $lte: today }, toDate: { $gte: today } })
    .select("employeeId employeeName isHalfDay")
    .limit(200)
    .lean();
  const others = rows.filter((r) => !emp || String(r.employeeId) !== String(emp._id));
  return {
    status: "ok",
    count: others.length,
    people: others.slice(0, 6).map((r) => ({ name: r.employeeName || "A colleague", halfDay: Boolean(r.isHalfDay) })),
  };
}

/* ── people (company-wide, memoised) ──────────────────────────────────── */

let peopleMemo = { at: 0, rows: null };

async function companyPeople() {
  if (peopleMemo.rows && Date.now() - peopleMemo.at < PEOPLE_CACHE_MS) return peopleMemo.rows;
  const rows = await M.Employee()
    .find({ ...ACTIVE, isDepartmentAccount: { $ne: true } })
    .select("firstName lastName name designation jobTitle department profilePhoto.url dateOfBirth dateOfJoining")
    .lean();
  const people = rows.map((e) => ({
    id: String(e._id),
    name: displayName(e),
    role: e.designation || e.jobTitle || null,
    department: e.department || null,
    photo: e.profilePhoto?.url || null,
    dateOfBirth: e.dateOfBirth || null,
    dateOfJoining: e.dateOfJoining || null,
  })).filter((p) => p.name);
  peopleMemo = { at: Date.now(), rows: people };
  return people;
}

async function peopleSection(now) {
  const people = await companyPeople();
  return { status: "ok", ...peopleMoments(people, { now }) };
}

/* ── the home ─────────────────────────────────────────────────────────── */

async function section(name, fn) {
  try {
    return await withTimeout(Promise.resolve().then(fn), SECTION_TIMEOUT_MS, `home:${name}`);
  } catch (err) {
    console.warn(`[home] ${name}:`, err?.message || err);
    return { status: "unavailable" };
  }
}

async function compute(user, now = new Date()) {
  const today = istDateStr(now);
  let resolved = { employee: null, via: "none" };
  try {
    resolved = await withTimeout(resolveEmployee(user), SECTION_TIMEOUT_MS, "home:identity");
  } catch (err) {
    console.warn("[home] identity:", err?.message || err);
  }
  const emp = resolved.employee;

  const [attendance, leave, requests, planner, interviews, meetings, holidays, away, people] = await Promise.all([
    section("attendance", () => attendanceSection(emp, today)),
    section("leave", () => leaveSection(emp, today)),
    section("requests", () => requestsSection(emp)),
    section("planner", () => plannerSection(user, now)),
    section("interviews", () => interviewsSection(emp, now)),
    section("meetings", () => meetingsSection(emp, now)),
    section("holidays", () => holidaysSection(today)),
    section("away", () => awaySection(emp, today)),
    section("people", () => peopleSection(now)),
  ]);

  return {
    generatedAt: now.toISOString(),
    today,
    /* The factory's hours (services/manufacturing/shiftHours.js) — the home's
       shift clock falls back to them when the day has no attendance row. */
    shift: { start: SHIFT.start, end: SHIFT.end },
    me: {
      name: emp ? displayName(emp) : user?.name || "",
      role: emp?.designation || emp?.jobTitle || null,
      department: emp?.department || null,
      photo: emp?.profilePhoto?.url || null,
      employeeId: emp ? String(emp._id) : null,
      linked: Boolean(emp),
      via: resolved.via,
      /* The /api/employee/** routes read the token id as the Employee _id, so
         applying for leave and reading payslips from the dashboard works only
         for an employee login. Anyone else is pointed to their HR record. */
      selfService: Boolean(emp) && user?.subject === "employee" && String(user.id) === String(emp._id),
    },
    sections: { attendance, leave, requests, planner, interviews, meetings, holidays, away, people },
  };
}

const cache = new Map();
const inFlight = new Map();

function keyOf(user) {
  return `${user?.subject || ""}:${user?.id || ""}:${user?.email || ""}:${user?.tv || 0}`;
}

async function homeFor(user, { fresh = false } = {}) {
  const key = keyOf(user);
  const hit = cache.get(key);
  if (!fresh && HOME_CACHE_MS > 0 && hit && Date.now() - hit.at < HOME_CACHE_MS) return hit.value;
  if (inFlight.has(key)) return inFlight.get(key);
  const p = compute(user)
    .then((value) => {
      if (HOME_CACHE_MS > 0) {
        cache.set(key, { at: Date.now(), value });
        if (cache.size > 2000) cache.delete(cache.keys().next().value);
      }
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/* ── colleague search ─────────────────────────────────────────────────── */

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Name, role, department and photo — nothing else (owner, 10 Oct 2026). Any
 * signed-in member of staff may ask. At least two characters, at most eight
 * answers; read from the memoised company list, so a keystroke costs nothing.
 */
async function searchPeople(q) {
  const text = String(q || "").trim().slice(0, 60);
  if (text.length < 2) return [];
  const words = text.split(/\s+/).filter(Boolean).map((w) => new RegExp(escapeRegex(w), "i"));
  const people = await companyPeople();
  const scored = [];
  for (const p of people) {
    const hay = `${p.name} ${p.role || ""} ${p.department || ""}`;
    if (!words.every((w) => w.test(hay))) continue;
    const starts = new RegExp(`^${escapeRegex(text)}`, "i").test(p.name) ? 0 : 1;
    scored.push({ starts, p });
  }
  scored.sort((a, b) => a.starts - b.starts || a.p.name.localeCompare(b.p.name));
  return scored.slice(0, 8).map(({ p }) => ({ id: p.id, name: p.name, role: p.role, department: p.department, photo: p.photo }));
}

module.exports = {
  homeFor, searchPeople, resolveEmployee,
  // exported for the tests
  _compute: compute, _models: M, _resetMemo: () => { cache.clear(); peopleMemo = { at: 0, rows: null }; },
};
