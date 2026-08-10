"use strict";
/**
 * services/dailyAttendanceContext.js — context for the Daily Attendance AI tool.
 *
 * The browser sends only SCOPE HINTS (date, department, filters). It never sends
 * attendance records — those are fetched here, server-side, through the very
 * same computation the HR daily page uses (Attendance_section.getDailyAttendance),
 * then narrowed by the same filter predicate the page applies. So the assistant
 * analyses exactly the rows the authorised HR user is looking at, and nothing
 * the client could have tampered with.
 *
 * Only attendance-relevant fields are exposed to the model — the same identity
 * (name + biometric id) already shown on the authorised HR page, department,
 * final status, in/out times, late/early indicators and missed-punch info.
 * Salary, bank, contact, documents, medical and unrelated employee data are
 * never read here.
 *
 * Missing data is kept DISTINCT from absence: a not-yet-synced day, a
 * missed-punch (MP) and a genuine absent (AB) are separate states, surfaced as
 * such so the model can describe them differently.
 */

const {
  getDailyAttendance,
} = require("../routes/HrRoutes/Attendance_section");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const STATUS_FILTERS = {
  present: ["P", "P*", "P~"],
  late: ["P*"],
  halfday: ["HD", "LHD"],
  misspunch: ["MP"],
  absent: ["AB", "LAB", "EAB"],
  weekoff: ["WO", "FH", "NH", "OH", "RH", "PH"],
  leave: ["L-CL", "L-SL", "L-EL", "LWP", "CO", "WFH"],
};

const ALLOWED_STATUS_FILTERS = new Set(["all", ...Object.keys(STATUS_FILTERS)]);
const ALLOWED_TYPE_FILTERS = new Set(["all", "operator", "executive"]);

/** Effective status the same way the page derives it. */
function effStatus(r) {
  return r.effectiveStatus || r.hrFinalStatus || r.systemPrediction || "AB";
}

/**
 * Format a stored punch timestamp to the SAME IST clock string the HR page
 * shows (e.g. "9:28 am"). The model must see what the user sees — a raw UTC ISO
 * value led it to call a present punch "missing / not in IST".
 */
function fmtIST(d) {
  if (!d) return null;
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

/**
 * Validate + normalise the scope hints the browser sent.
 * @returns {{ ok: true, scope } | { ok: false, message }}
 */
function validateScope(raw = {}) {
  const date = typeof raw.date === "string" ? raw.date.slice(0, 10) : "";
  if (!DATE_RE.test(date)) {
    return { ok: false, message: "A valid date (YYYY-MM-DD) is required." };
  }
  const department =
    typeof raw.department === "string" && raw.department.trim()
      ? raw.department.trim().slice(0, 80)
      : "all";
  const statusFilter = ALLOWED_STATUS_FILTERS.has(raw.statusFilter) ? raw.statusFilter : "all";
  const typeFilter = ALLOWED_TYPE_FILTERS.has(raw.typeFilter) ? raw.typeFilter : "all";
  const search =
    typeof raw.search === "string" ? raw.search.trim().slice(0, 80) : "";
  return { ok: true, scope: { date, department, statusFilter, typeFilter, search } };
}

/** The frontend's filteredRecords predicate, applied server-side. */
function matchesFilters(r, scope) {
  const status = effStatus(r);
  if (scope.statusFilter !== "all") {
    const allowed = STATUS_FILTERS[scope.statusFilter] || [];
    if (!allowed.includes(status)) return false;
  }
  if (scope.typeFilter !== "all" && r.employeeType !== scope.typeFilter) return false;
  if (scope.search) {
    const q = scope.search.toLowerCase();
    const hay = [r.employeeName, r.biometricId, r.identityId, r.department]
      .map((v) => (v || "").toString().toLowerCase());
    if (!hay.some((v) => v.includes(q))) return false;
  }
  return true;
}

/** Project one record down to attendance-only fields. */
function projectRecord(r) {
  const status = effStatus(r);
  const hasInPunch = !!r.inTime;
  const hasOutPunch = !!r.finalOut;
  // Which punch is missing — a partial punch (one side present) is the real
  // "missed punch" data gap. Both-missing on an AB row is absence, not a gap.
  let missingPunch = null;
  if (hasInPunch && !hasOutPunch) missingPunch = "out";
  else if (!hasInPunch && hasOutPunch) missingPunch = "in";
  const missedPunch = status === "MP" || r.hasMissPunch === true || missingPunch !== null;
  return {
    name: r.employeeName || "Unknown",
    id: r.biometricId || r.identityId || null,
    department: r.department || "Unknown",
    type: r.employeeType || null,
    status, // raw status code
    statusLabel: r.displayStatus || status,
    // IST clock strings — exactly what the HR page shows.
    inTime: fmtIST(r.inTime),
    outTime: fmtIST(r.finalOut),
    hasInPunch,
    hasOutPunch,
    missingPunch, // "in" | "out" | null — which punch is absent
    isLate: !!r.isLate,
    lateMins: r.lateMins || 0,
    isEarlyDeparture: !!r.isEarlyDeparture,
    earlyDepartureMins: r.earlyDepartureMins || 0,
    missedPunch,
    hasHrOverride: !!r.hrFinalStatus,
    preJoining: !!r.preJoining,
  };
}

/**
 * Build the attendance-only context for the model.
 *
 * @param {object} rawScope scope hints from the browser
 * @param {object} [deps] { getDailyAttendance } override for tests
 * @returns {Promise<{ ok: true, scope, context } | { ok: false, status, message }>}
 */
async function buildDailyAttendanceContext(rawScope, deps = {}) {
  const v = validateScope(rawScope);
  if (!v.ok) return { ok: false, status: 400, message: v.message };
  const { scope } = v;

  const fetchDaily = deps.getDailyAttendance || getDailyAttendance;
  const result = await fetchDaily(scope.date, scope.department);

  if (result && result.success === false) {
    return { ok: false, status: result.status || 500, message: result.message || "Could not load attendance." };
  }

  // Day not synced yet — missing data, explicitly NOT "everyone absent".
  if (result && result.synced === false) {
    return {
      ok: true,
      scope,
      context: {
        date: scope.date,
        scope,
        dataState: "not_synced",
        note: "Attendance for this day has not been synced yet. This is missing data, not absence.",
        holiday: null,
        totals: { inScope: 0 },
        breakdown: {},
        records: [],
      },
    };
  }

  const all = Array.isArray(result.data) ? result.data : [];
  const inScope = all.filter((r) => matchesFilters(r, scope));
  const records = inScope.map(projectRecord);

  // Aggregate breakdown over the in-scope rows (counts only).
  const breakdown = {};
  let missedPunchCount = 0;
  let lateCount = 0;
  let earlyCount = 0;
  for (const r of records) {
    breakdown[r.status] = (breakdown[r.status] || 0) + 1;
    if (r.missedPunch) missedPunchCount += 1;
    if (r.isLate) lateCount += 1;
    if (r.isEarlyDeparture) earlyCount += 1;
  }

  return {
    ok: true,
    scope,
    context: {
      date: scope.date,
      scope,
      dataState: "synced",
      holiday: result.holiday || null,
      totals: {
        inScope: records.length,
        missedPunch: missedPunchCount,
        late: lateCount,
        earlyDeparture: earlyCount,
      },
      breakdown,
      // The model sees the same rows the HR user sees. Capped to keep the prompt
      // bounded; the count above still reflects the true in-scope total.
      records: records.slice(0, 200),
      recordsTruncated: records.length > 200,
      legend: {
        times: "inTime and outTime are already in IST (Asia/Kolkata) clock format, e.g. '9:28 am'. If inTime is present, the person HAS an in-punch — never call it missing.",
        missingPunch: "'out' = out-punch missing (in-punch present); 'in' = in-punch missing (out-punch present). A missed punch is a data gap, NOT confirmed absence.",
        MP: "missed punch — one punch missing (see missingPunch for which); data gap, not absence",
        AB: "absent (no punches, and not a data gap)",
        "P*": "present but late",
        "P~": "present but left early",
        HD: "half day",
        WO: "weekly off",
      },
    },
  };
}

module.exports = {
  buildDailyAttendanceContext,
  validateScope,
  matchesFilters,
  projectRecord,
  _internal: { STATUS_FILTERS },
};
