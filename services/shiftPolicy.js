"use strict";
// services/shiftPolicy.js
//
// Which shift an employee is on, and what their day counts as.
//
// This is the one place that answers both questions. Before it existed they
// were answered in two places that disagreed: services/Attendanceengine.js
// read a shift out of a settings object, while services/BiometricSyncService.js
// — the code that actually runs on every sync and writes the status employees
// see — read SHIFT_START and SHIFT_END out of environment variables at module
// load. One shift, for the entire company, decided at boot.
//
// That is the housekeeping bug. Their day ends at 14:00; SHIFT_END said 18:00;
// so every single day they left "early" and the system marked them EO. Nothing
// was wrong with their attendance — the question being asked of it was wrong.
//
// ─────────────────────────────────────────────────────────────────────────────
//  A NAMING TRAP, DOCUMENTED HERE BECAUSE IT WILL BITE OTHERWISE
//
//  The UI labels and the stored field names are INVERTED. Read this table
//  before touching anything that reads departmentCategories:
//
//    UI label              shift profile        department list field
//    ─────────────────     ─────────────────    ────────────────────────────
//    "Core Employees"      shifts.executive     departmentCategories.general
//    (office, 2 punches)
//
//    "General Employees"   shifts.operator      departmentCategories.core
//    (production, 6 punches)
//
//  So departmentCategories.core holds the GENERAL employees' departments, and
//  .general holds the CORE employees'. Confirmed against the settings page,
//  which binds the "Core Employees" tab to genDepts and shifts.executive, and
//  against the shift values themselves: the Core tab shows 09:30–18:30 with a
//  450-minute half-day rule, which is exactly shifts.executive.
//
//  The field names are not renamed here because live documents use them and
//  the settings page reads them. Everything below goes through MODE_TO_PROFILE
//  and MODE_TO_DEPT_FIELD so the inversion is stated once instead of being
//  re-derived — wrongly — at each call site.
// ─────────────────────────────────────────────────────────────────────────────

/** The modes an employee's shift can be set to, as the UI names them. */
const MODES = ["core", "general", "custom"];

/** UI mode → the profile under settings.shifts that holds its rules. */
const MODE_TO_PROFILE = { core: "executive", general: "operator" };

/** UI mode → the departmentCategories field listing its departments. */
const MODE_TO_DEPT_FIELD = { core: "general", general: "core" };

/** Last-resort rules, if settings are empty. Mirrors the model's defaults. */
const FALLBACK = {
  core: {
    start: "09:30",
    end: "18:30",
    lateGraceMins: 15,
    halfDayThresholdMins: 450,
    halfDayBasis: "span",
    otGraceMins: 30,
  },
  general: {
    start: "09:00",
    end: "18:00",
    lateGraceMins: 10,
    halfDayThresholdMins: 390,
    halfDayBasis: "net",
    otGraceMins: 15,
  },
};

/**
 * How a half-day threshold is measured, per profile.
 *
 * Not a stored field, and deliberately so: it is a property of the policy, not
 * a knob. Core is an office shift with no punched breaks, so its 450 minutes
 * is TOTAL SPAN — in at 09:30, out at 17:00 is a half day regardless of how
 * long lunch was. General punches its breaks, so its 390 is NET WORK with the
 * breaks removed. Measuring either one the other way silently changes who gets
 * paid a half day. The settings UI already says so on each tab: "Total span
 * incl. breaks" against Core, "net work excl. breaks" against General.
 */
const BASIS = { core: "span", general: "net" };

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "09:30" → 570. Null for anything that is not a time. */
function hhmmToMins(s) {
  const m = HHMM.exec(String(s || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function norm(s) {
  return String(s || "").trim().toUpperCase();
}

/**
 * Which mode an employee's department and designation imply.
 *
 * This is today's behaviour, kept as the fallback for everyone who has not been
 * given an explicit shift yet — so nothing changes for them the day this ships.
 * Designation is checked first: it is the more specific statement, and it is
 * how a supervisor sitting in a production department gets office hours.
 */
function modeFromDeptAndDesignation(employee, settings) {
  const desig = norm(employee?.designation);
  const dept = norm(employee?.department);

  const execDesigs = (settings?.executiveDesignations || []).map(norm);
  const opDesigs = (settings?.operatorDesignations || []).map(norm);
  if (desig && execDesigs.includes(desig)) return "core";
  if (desig && opDesigs.includes(desig)) return "general";

  const cats = settings?.departmentCategories || {};
  // Read the table at the top of this file before "fixing" these two lines.
  const coreDepts = (cats.general || []).map(norm);
  const generalDepts = (cats.core || settings?.operatorDepartments || []).map(norm);
  if (dept && coreDepts.includes(dept)) return "core";
  if (dept && generalDepts.includes(dept)) return "general";

  return null;
}

/**
 * The shift an employee is actually on.
 *
 * Resolution order, as agreed:
 *   1. employee.workShift — what HR set on the employee form
 *   2. department / designation — today's mapping, so nobody breaks on day one
 *   3. Core
 *
 * @returns {{mode, start, end, startMins, endMins, lateGraceMins,
 *            halfDayThresholdMins, halfDayBasis, otGraceMins, source}}
 */
function resolveShift(employee, settings) {
  const ws = employee?.workShift || {};
  const explicit = MODES.includes(ws.mode) ? ws.mode : null;
  const inferred = explicit ? null : modeFromDeptAndDesignation(employee, settings);
  const mode = explicit || inferred || "core";

  // Custom takes its TIMES from the employee and its RULES from the shared
  // custom profile in settings. That is what was asked for: HR sets one set of
  // grace periods for all custom people, and only the hours differ per person.
  if (mode === "custom") {
    const rules = settings?.shifts?.custom || {};
    const base = FALLBACK.general;
    const start = HHMM.test(String(ws.start || "")) ? ws.start : base.start;
    const end = HHMM.test(String(ws.end || "")) ? ws.end : base.end;
    return finish({
      mode: "custom",
      start,
      end,
      lateGraceMins: num(rules.lateGraceMins, base.lateGraceMins),
      halfDayThresholdMins: num(rules.halfDayThresholdMins, base.halfDayThresholdMins),
      // A custom shift is an arbitrary window, so measure the thing that does
      // not depend on whether this person punches their breaks.
      halfDayBasis: rules.halfDayBasis === "span" ? "span" : "net",
      otGraceMins: num(rules.otGraceMins, base.otGraceMins),
      source: explicit ? "employee" : "fallback",
      timesFromEmployee: HHMM.test(String(ws.start || "")) && HHMM.test(String(ws.end || "")),
    });
  }

  const profile = settings?.shifts?.[MODE_TO_PROFILE[mode]] || {};
  const base = FALLBACK[mode];
  return finish({
    mode,
    start: HHMM.test(String(profile.start || "")) ? profile.start : base.start,
    end: HHMM.test(String(profile.end || "")) ? profile.end : base.end,
    lateGraceMins: num(profile.lateGraceMins, base.lateGraceMins),
    halfDayThresholdMins: num(profile.halfDayThresholdMins, base.halfDayThresholdMins),
    halfDayBasis: BASIS[mode],
    otGraceMins: num(profile.otGraceMins, base.otGraceMins),
    source: explicit ? "employee" : inferred ? "department" : "default",
  });
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function finish(shift) {
  const startMins = hhmmToMins(shift.start);
  let endMins = hhmmToMins(shift.end);
  // A shift that ends before it starts crosses midnight — a night shift. Carry
  // the end into the next day so "left early" and "worked overtime" still mean
  // what they should. Without this a 22:00–06:00 shift reads as sixteen hours
  // of early departure, every night.
  const overnight = endMins != null && startMins != null && endMins <= startMins;
  if (overnight) endMins += 24 * 60;
  return { ...shift, startMins, endMins, overnight };
}

/** What kind of day this is, before anyone's punches are considered. */
const DAY_KIND = {
  WORKING: "working",
  WEEKLY_OFF: "weeklyOff",
  HOLIDAY: "holiday",
};

/**
 * Classify a date: a normal working day, a weekly off, or a company holiday.
 *
 * The calendar has two flags and they pull in opposite directions:
 *
 *   a holiday entry          makes a working day non-working
 *   a "working_sunday" entry makes a non-working day working
 *
 * The second already exists in the CompanyHoliday enum and is already honoured
 * by payroll, reports and leave — but NOT by the attendance engine, which
 * treated every calendar entry as a holiday. So a Sunday declared a working day
 * came out as PH, the exact opposite of what HR asked for.
 *
 * @param {string} dateStr      YYYY-MM-DD
 * @param {object} settings
 * @param {Map|object} holidayByDate  dateStr → { type, name }
 */
function classifyDayKind(dateStr, settings, holidayByDate) {
  const entry =
    holidayByDate instanceof Map
      ? holidayByDate.get(dateStr)
      : (holidayByDate || {})[dateStr];

  if (entry && entry.type === "working_sunday") {
    // An override. This day behaves exactly like any other working day —
    // late, early-out and half-day all apply — because the compensation for
    // it was the weekday the company took off instead. That is also why no
    // comp-off accrues here: the swap IS the comp-off, and granting both
    // would pay for the same day twice.
    return { kind: DAY_KIND.WORKING, override: true, holiday: null };
  }
  if (entry) {
    return { kind: DAY_KIND.HOLIDAY, override: false, holiday: entry };
  }

  const workingDays = Array.isArray(settings?.workingDays) && settings.workingDays.length
    ? settings.workingDays
    : [1, 2, 3, 4, 5, 6]; // Mon–Sat; Sunday off
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return {
    kind: workingDays.includes(dow) ? DAY_KIND.WORKING : DAY_KIND.WEEKLY_OFF,
    override: false,
    holiday: null,
  };
}

/**
 * The half-day threshold to use on a day that is not a working day.
 *
 * Its own setting, because the shift's threshold answers a different question.
 * A Core employee's 450 minutes means "you were in the office for less than
 * your day" — but on a Sunday there is no day to be short of. What HR wants to
 * say is "turn up for at least this long and it counts as a full day", which is
 * a separate number and theirs to choose.
 */
function nonWorkingDayRule(settings) {
  const cfg = settings?.nonWorkingDay || {};
  return {
    halfDayThresholdMins: num(cfg.halfDayThresholdMins, 240),
    basis: cfg.basis === "span" ? "span" : "net",
  };
}

/**
 * Decide what a day counts as.
 *
 * @param {object} a
 * @param {string} a.dateStr
 * @param {number|null} a.inMins    minutes past midnight of the first punch
 * @param {number|null} a.outMins   minutes past midnight of the last punch
 * @param {number} a.netMins        worked minutes, breaks removed
 * @param {number} a.spanMins       in-to-out minutes, breaks included
 * @param {object} a.shift          from resolveShift
 * @param {object} a.settings
 * @param {object} a.day            from classifyDayKind
 * @returns {{status, isLate, lateMins, isEarlyOut, earlyOutMins, otMins,
 *            onNonWorkingDay, compOffEligible}}
 */
function classifyDay({ inMins, outMins, netMins, spanMins, shift, settings, day }) {
  const nothing = {
    isLate: false,
    lateMins: 0,
    isEarlyOut: false,
    earlyOutMins: 0,
    otMins: 0,
    onNonWorkingDay: day.kind !== DAY_KIND.WORKING,
    compOffEligible: false,
  };

  const worked = inMins != null && outMins != null;

  // ── Not a working day ───────────────────────────────────────────────────
  if (day.kind !== DAY_KIND.WORKING) {
    if (!worked) {
      return {
        ...nothing,
        status: day.kind === DAY_KIND.HOLIDAY ? "PH" : "WO",
      };
    }
    // Somebody came in on their day off. Every minute of it is overtime, and
    // NONE of the shift rules apply: there is no start time to be late for and
    // no end time to leave before. Judging this day by a shift is what produced
    // "Late" and "Early out" on a Sunday.
    const rule = nonWorkingDayRule(settings);
    const measured = rule.basis === "span" ? spanMins : netMins;
    return {
      ...nothing,
      status: measured < rule.halfDayThresholdMins ? "HD" : "P",
      otMins: Math.max(0, netMins),
      onNonWorkingDay: true,
      // A holiday or weekly off worked earns comp-off. A working-day override
      // does not reach here at all — classifyDayKind returns WORKING for it —
      // which is the "no comp-off on a swapped day" rule, enforced by the day
      // never being non-working in the first place.
      compOffEligible: true,
    };
  }

  // ── A normal working day, judged against THIS employee's shift ──────────
  if (!worked) return { ...nothing, status: "AB" };

  // An overnight shift's out-time lands after midnight, so it comes back as a
  // small number. Carry it forward the same way the shift end was carried.
  let out = outMins;
  if (shift.overnight && out != null && out < (inMins ?? 0)) out += 24 * 60;

  const lateBy = shift.startMins == null ? 0 : inMins - shift.startMins;
  const isLate = lateBy > shift.lateGraceMins;

  const earlyBy = shift.endMins == null ? 0 : shift.endMins - out;
  // Early-out uses the same grace as late. One knob per shift was the ask, and
  // a separate early grace is a field HR would have to reason about twice.
  const isEarlyOut = earlyBy > shift.lateGraceMins;

  const otStart = shift.endMins == null ? null : shift.endMins + shift.otGraceMins;
  const otMins = otStart == null ? 0 : Math.max(0, out - otStart);

  const measured = shift.halfDayBasis === "span" ? spanMins : netMins;

  let status;
  if (measured < shift.halfDayThresholdMins) status = "HD";
  else if (isEarlyOut) status = "P~";
  else if (isLate) status = "P*";
  else status = "P";

  return {
    status,
    isLate,
    lateMins: isLate ? Math.max(0, lateBy) : 0,
    isEarlyOut,
    earlyOutMins: isEarlyOut ? Math.max(0, earlyBy) : 0,
    otMins,
    onNonWorkingDay: false,
    compOffEligible: false,
  };
}

module.exports = {
  MODES,
  MODE_TO_PROFILE,
  MODE_TO_DEPT_FIELD,
  DAY_KIND,
  hhmmToMins,
  resolveShift,
  classifyDayKind,
  classifyDay,
  nonWorkingDayRule,
};
