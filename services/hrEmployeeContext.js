"use strict";
/**
 * services/hrEmployeeContext.js — per-employee HR lookup for the central assistant.
 *
 * Answers "tell me about <person>" / "how many leaves does <person> have" /
 * "what is <person>'s attendance this month" for an AUTHORISED HR caller. It is
 * deliberately minimal: profile basics (never salary, never home address), the
 * current-year leave balance, and a last-30-day attendance tally. Nothing here
 * is written; it only reads.
 *
 * `resolveEmployeeByQuery` is shared with hrLeaveContext so a named employee is
 * resolved the same way everywhere.
 */

const Employee = require("../models/Employee");
const { LeaveBalance, LeaveApplication } = require("../models/HR_Models/LeaveManagement");
const DailyAttendance = require("../models/HR_Models/Dailyattendance");

// ── IST date helpers (attendance/leave domain is IST throughout) ───────────────
function istNow() {
  return new Date(Date.now() + 330 * 60 * 1000);
}
function istDateStr(d = istNow()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}
function istYear() {
  return istNow().getUTCFullYear();
}

// A biometric / employee code like "GR0067" or "E000".
const BIO_RE = /\b([A-Z]{1,3}\d{2,6}|E\d{3,4})\b/i;

// Plain-English status words for a single person's day (clearer than codes).
const STATUS_WORD = {
  P: "present", "P*": "present (arrived late)", "P~": "present",
  AB: "absent", LAB: "absent", EAB: "absent",
  HD: "half-day", LHD: "half-day", MP: "present (missed a punch)",
  WO: "weekly off", FH: "holiday", NH: "holiday", OH: "holiday", RH: "holiday", PH: "holiday",
  "L-CL": "on leave (casual)", "L-SL": "on leave (sick)", "L-EL": "on leave (earned)",
  LWP: "on leave (unpaid)", CO: "comp-off", WFH: "work from home",
};

function fmtIST(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
}

// The Employee model stores the name split across first/middle/last — there is
// NO single `name` field — so assemble a display name from the parts.
function fullName(emp) {
  if (!emp) return null;
  const n = [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(" ").trim();
  return n || null;
}

// Same status buckets the daily-attendance page uses, so summaries agree with it.
const CATEGORY_OF = {};
for (const [cat, codes] of Object.entries({
  present: ["P", "P*", "P~"],
  late: ["P*"],
  halfDay: ["HD", "LHD"],
  missedPunch: ["MP"],
  absent: ["AB", "LAB", "EAB"],
  weeklyOff: ["WO", "FH", "NH", "OH", "RH", "PH"],
  leave: ["L-CL", "L-SL", "L-EL", "LWP", "CO", "WFH"],
})) {
  for (const code of codes) {
    // A code may map to more than one bucket (P* is present AND late); keep both.
    (CATEGORY_OF[code] = CATEGORY_OF[code] || []).push(cat);
  }
}

const NAME_SELECT =
  "firstName middleName lastName biometricId department departmentId designation dateOfJoining status isActive gender primaryManager";

// Edit distance (Levenshtein) — for typo-/mishearing-tolerant name matching, so
// "umung arora" still resolves to "Umang Arora".
function editDistance(a, b) {
  a = String(a || "");
  b = String(b || "");
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
// 0..1 similarity between two tokens (1 = identical).
function sim(a, b) {
  a = String(a || "").toLowerCase();
  b = String(b || "").toLowerCase();
  if (!a || !b) return 0;
  if (a === b) return 1;
  // A short token contained in a longer name-part counts as a strong match
  // ("ram" in "ramesh"), which pure edit distance would under-score.
  if (b.startsWith(a) || a.startsWith(b)) return 0.9;
  const d = editDistance(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

/**
 * Best fuzzy score of one query token against a person's name parts.
 */
function tokenScore(token, parts) {
  let best = 0;
  for (const p of parts) {
    const s = sim(token, p);
    if (s > best) best = s;
  }
  return best;
}

/**
 * Resolve a person from free text: a biometric code wins; otherwise a name.
 * Tries an exact (substring) match first, then a fuzzy match tolerant of typos
 * and mishearings. Active employees are preferred. Returns the lean doc or null.
 */
async function resolveEmployeeByQuery(query) {
  const q = String(query || "").trim();
  if (!q) return null;

  const bio = (q.match(BIO_RE) || [])[1];
  if (bio) {
    const byBio = await Employee.findOne({ biometricId: new RegExp(`^${bio}$`, "i") })
      .lean()
      .catch(() => null);
    if (byBio) return byBio;
  }

  // Name match: strip filler words, then match each remaining token against any
  // of the split name parts (first/middle/last). Requiring every token to land
  // somewhere keeps "soumya biswal" from matching a different Soumya.
  const cleaned = q
    .replace(
      /\b(how many|leaves?|balance|attendance|status|of|for|is|are|was|were|the|show|me|tell|about|employee|does|do|have|has|when|did|what|whats|what's|which|department|designation|profile|details?|joining|joined|join|reporting|manager|his|her|their|present|absent|late|here|come|came|attend|attending|working|work|today|yesterday|tomorrow|day|before|on|in|out|off|this|morning|now)\b/gi,
      " ",
    )
    // Date words must not become "name" tokens ("was Umang present on the fifth
    // of August" -> the resolver would otherwise demand an employee also named
    // "fifth"/"august" and find no one).
    .replace(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|twenty|thirty|st|nd|rd|th)\b/gi,
      " ",
    )
    .replace(/[^a-zA-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned.split(" ").filter((t) => t.length >= 2);
  if (!tokens.length) return null;

  // 1) Exact (substring) match — fast path for correctly-spelled names.
  const and = tokens.map((tok) => {
    const r = new RegExp(tok, "i");
    return { $or: [{ firstName: r }, { middleName: r }, { lastName: r }] };
  });
  const exact = await Employee.find({ $and: and }).select(NAME_SELECT).limit(5).lean().catch(() => []);
  if (exact.length) return exact.find((m) => m.isActive !== false) || exact[0];

  // 2) Fuzzy fallback — tolerate typos / mishearings ("umung arora" -> "Umang
  //    Arora"). Score every employee: each query token must land near SOME of
  //    their name parts; require all tokens to clear a similarity threshold.
  const everyone = await Employee.find({}).select(NAME_SELECT).lean().catch(() => []);
  const THRESHOLD = 0.7; // ~1 typo on a 5-char name still passes
  let best = null;
  let bestScore = 0;
  for (const e of everyone) {
    const parts = [e.firstName, e.middleName, e.lastName].filter(Boolean).map((x) => String(x).toLowerCase());
    if (!parts.length) continue;
    let minTok = 1;
    let sum = 0;
    for (const t of tokens) {
      const s = tokenScore(t, parts);
      if (s < minTok) minTok = s;
      sum += s;
    }
    if (minTok < THRESHOLD) continue; // every token must match a name part well
    // Prefer active employees and higher total similarity.
    const score = sum / tokens.length + (e.isActive !== false ? 0.05 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

async function leaveBalanceFor(employee) {
  const year = istYear();
  const bal = await LeaveBalance.findOne({
    $or: [{ employeeId: employee._id }, { biometricId: employee.biometricId }],
    year,
  })
    .lean()
    .catch(() => null);
  if (!bal) return { year, available: false };
  // The LeaveBalance doc stores `entitlement` and `consumed` (NOT allocated/used).
  const rem = (k) => Math.max(0, (bal.entitlement?.[k] || 0) - (bal.consumed?.[k] || 0));
  return {
    year,
    available: true,
    CL: { entitled: bal.entitlement?.CL || 0, used: bal.consumed?.CL || 0, remaining: rem("CL") },
    SL: { entitled: bal.entitlement?.SL || 0, used: bal.consumed?.SL || 0, remaining: rem("SL") },
    PL: { entitled: bal.entitlement?.PL || 0, used: bal.consumed?.PL || 0, remaining: rem("PL") },
  };
}

// The employee's actual leave applications with DATES (so "on which dates did X
// take leave" is answered from real records, not guessed). Newest first.
async function leaveHistoryFor(biometricId) {
  const apps = await LeaveApplication.find({ biometricId })
    .sort({ fromDate: -1 })
    .limit(40)
    .lean()
    .catch(() => []);
  return apps.map((a) => ({
    type: a.leaveType,
    from: a.fromDate,
    to: a.toDate,
    days: a.totalDays,
    // Only hr_approved leaves were actually taken; others are pending/rejected.
    status: a.status,
    taken: a.status === "hr_approved",
  }));
}

const LEAVE_TYPE_WORD = { CL: "casual leave", SL: "sick leave", PL: "privilege leave", LOP: "loss of pay" };
// A clear, grouped sentence of the approved leaves, e.g.
// "Umang Arora's approved leaves: casual leave (CL) on 2026-05-11 and 2026-05-22;
//  sick leave (SL) on 2026-08-03."
function leaveSummaryText(name, history) {
  const taken = (history || []).filter((l) => l.taken);
  if (!taken.length) return `${name} has no approved leave in the records.`;
  const byType = {};
  for (const l of taken) {
    const span = l.from === l.to ? l.from : `${l.from} to ${l.to}`;
    const g = (byType[l.type] = byType[l.type] || { total: 0, dates: [] });
    g.total += Number(l.days) || 0;
    g.dates.push(`${span} (${l.days} day${l.days === 1 ? "" : "s"})`);
  }
  const parts = Object.entries(byType).map(
    ([type, g]) => `${LEAVE_TYPE_WORD[type] || type} (${type}): ${g.total} day${g.total === 1 ? "" : "s"} total, on ${g.dates.join(" and ")}`,
  );
  return `${name}'s approved leaves — ${parts.join("; ")}.`;
}

async function attendanceSummary(biometricId, fromStr, toStr) {
  const rows = await DailyAttendance.aggregate([
    { $match: { dateStr: { $gte: fromStr, $lte: toStr } } },
    { $unwind: "$employees" },
    { $match: { "employees.biometricId": biometricId } },
    {
      $project: {
        eff: {
          $cond: [
            {
              $and: [
                { $ne: ["$employees.hrFinalStatus", null] },
                { $ne: ["$employees.hrFinalStatus", ""] },
              ],
            },
            "$employees.hrFinalStatus",
            "$employees.systemPrediction",
          ],
        },
      },
    },
    { $group: { _id: "$eff", count: { $sum: 1 } } },
  ]).catch(() => []);

  const totals = { present: 0, late: 0, halfDay: 0, missedPunch: 0, absent: 0, weeklyOff: 0, leave: 0 };
  let daysRecorded = 0;
  for (const r of rows) {
    daysRecorded += r.count;
    for (const cat of CATEGORY_OF[r._id] || []) totals[cat] += r.count;
  }
  return { from: fromStr, to: toStr, daysRecorded, ...totals };
}

// One employee's status on a specific day (for "was X present on <day>").
async function attendanceOnDate(biometricId, dateStr) {
  const rows = await DailyAttendance.aggregate([
    { $match: { dateStr } },
    { $unwind: "$employees" },
    { $match: { "employees.biometricId": biometricId } },
    { $project: { e: "$employees" } },
  ]).catch(() => []);
  const e = rows[0] && rows[0].e;
  if (!e) return { date: dateStr, available: false };
  const code = e.hrFinalStatus && e.hrFinalStatus !== "" ? e.hrFinalStatus : e.systemPrediction;
  return {
    date: dateStr,
    available: true,
    status: STATUS_WORD[code] || code,
    inTime: fmtIST(e.inTime),
    outTime: fmtIST(e.outTime),
  };
}

/**
 * @param {object} args
 * @param {string} args.query   the free-text mention of the person
 * @param {string} [args.date]  a specific day (YYYY-MM-DD) to report their status
 * @returns {Promise<object>}   { found:false } or the minimal profile bundle
 */
async function buildEmployeeLookup({ query, date } = {}) {
  const emp = await resolveEmployeeByQuery(query);
  if (!emp) {
    const q = String(query || "").slice(0, 80);
    return { found: false, query: q, note: `No employee matching that name/ID was found in HR records — the question may refer to someone not in the system.` };
  }

  // Last 30 days (inclusive) for the attendance tally.
  const to = istDateStr();
  const from = istDateStr(new Date(istNow().getTime() - 29 * 24 * 60 * 60 * 1000));

  const [balance, attendance, onDate, leaveHistory] = await Promise.all([
    leaveBalanceFor(emp),
    emp.biometricId ? attendanceSummary(emp.biometricId, from, to) : Promise.resolve(null),
    date && emp.biometricId ? attendanceOnDate(emp.biometricId, date) : Promise.resolve(null),
    emp.biometricId ? leaveHistoryFor(emp.biometricId) : Promise.resolve([]),
  ]);

  const out = {
    found: true,
    profile: {
      name: fullName(emp),
      employeeId: emp.biometricId || null,
      department: emp.department || null,
      designation: emp.designation || null,
      dateOfJoining: emp.dateOfJoining ? istDateStr(new Date(emp.dateOfJoining)) : null,
      status: emp.isActive === false ? "inactive" : emp.status || "active",
      gender: emp.gender || null,
      reportingManager: emp.primaryManager?.managerName || null,
    },
    leaveBalance: balance,
    // Actual leave applications with dates (taken = hr_approved). Use these for
    // "on which dates did X take leave" -- never guess dates.
    leaveHistory,
    // Plain-English list of the approved leaves so a small model reads the DATES
    // correctly instead of misreading the JSON array (it was inventing dates).
    leaveSummary: leaveSummaryText(fullName(emp), leaveHistory),
    last30DayAttendance: attendance,
  };
  if (onDate) {
    out.statusOnDate = onDate.available
      ? `${fullName(emp)} was ${onDate.status} on ${onDate.date}${onDate.inTime ? ` (in ${onDate.inTime}${onDate.outTime ? `, out ${onDate.outTime}` : ""})` : ""}.`
      : `No attendance record for ${fullName(emp)} on ${onDate.date}.`;
    out.onDate = onDate;
  }
  return out;
}

module.exports = {
  buildEmployeeLookup,
  resolveEmployeeByQuery,
  // shared helpers
  fullName,
  leaveHistoryFor,
  leaveSummaryText,
  istDateStr,
  istNow,
  istYear,
};
