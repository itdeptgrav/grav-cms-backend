"use strict";
/**
 * services/ai/tools/hrTools.js — HR's authorised data, exposed to the central
 * assistant as permission-gated tools.
 *
 * Requiring this module registers the tools. All are gated by the SHARED HR
 * access resolver (services/access/hrAccess), so a platform admin, a board /
 * Chief Executive, or anyone with an HR department grant can use them — from
 * ANY app — while everyone else is refused. The decision comes from the
 * account's real grants (attached as `user.hrAccess` before tools run), never
 * from the current page.
 *
 * The catalogue includes compact dashboard reads plus complete typed adapters
 * for employee records, attendance and exclusions, leave, recruitment,
 * documents, payroll, performance, organisation structure, policy/settings
 * and audit history. Field-level permissions still decide what any caller sees.
 */

const { registerTool } = require("../toolRegistry");
const { buildHrOverviewContext } = require("../../hrOverviewContext");
const { buildDailyAttendanceContext } = require("../../dailyAttendanceContext");
const { buildLeaveContext } = require("../../hrLeaveContext");
const { buildEmployeeLookup, resolveEmployeeByQuery, istNow, istDateStr } = require("../../hrEmployeeContext");
const {
  buildDirectoryContext,
  buildDepartmentsContext,
  buildOvertimeContext,
  buildHolidaysContext,
  buildPoliciesContext,
  buildPayrollContext,
  buildSalaryContext,
} = require("../../hrExtraContext");
const {
  buildFullEmployeeContext,
  buildAttendanceRecordsContext,
  buildAttendanceExclusionsContext,
  buildLeaveRecordsContext,
  buildRecruitmentContext,
  buildDocumentRecordsContext,
  buildPayrollRecordsContext,
  buildPerformanceContext,
  buildHrAuditContext,
} = require("../../hrComprehensiveContext");
const {
  MONTH: METRIC_MONTH,
  YEAR: METRIC_YEAR,
  HR_CATALOGUE_ID,
  metricForRequest,
  metricFromText,
  metricGlossary,
  metricIds: semanticMetricIds,
  parseMetricComparison,
  renderMetricAnswer,
  renderMetricComparisonAnswer,
  stripMetricTerms,
} = require("../../hrSemanticMetrics");

const semantic = (domains, subjects = []) => ({ catalogue: HR_CATALOGUE_ID, domains, subjects });

// Closed semantic field IDs for fast, exact employee questions. These are data
// contract keys, not trigger phrases: Qwen maps natural language to one key;
// GRAV reads and formats the authorised value without another model pass.
const EMPLOYEE_FIELD_IDS = Object.freeze([
  "primaryManager", "secondaryManager", "department", "designation", "jobTitle",
  "workLocation", "dateOfJoining", "confirmationDate", "probationPeriod",
  "employmentType", "email", "workPhone", "extension", "biometricId", "identityId",
  "phone", "alternatePhone", "personalEmail", "dateOfBirth", "gender", "bloodGroup",
  "maritalStatus", "spouseName", "fatherName", "fatherDateOfBirth", "motherName",
  "nationality", "religion", "placeOfBirth", "countryOfOrigin", "residentialStatus",
  "isDirector", "isInternational", "isPhysicallyChallenged", "fullRecord",
  "attendanceSummary",
]);

const EMPLOYEE_FIELD_LABELS = Object.freeze({
  primaryManager: "primary manager", secondaryManager: "secondary manager",
  department: "department", designation: "designation", jobTitle: "job title",
  workLocation: "work location", dateOfJoining: "date of joining",
  confirmationDate: "confirmation date", probationPeriod: "probation period",
  employmentType: "employment type", email: "work email", workPhone: "work phone",
  extension: "extension", biometricId: "biometric ID", identityId: "identity ID",
  phone: "phone", alternatePhone: "alternate phone", personalEmail: "personal email",
  dateOfBirth: "date of birth", gender: "gender", bloodGroup: "blood group",
  maritalStatus: "marital status", spouseName: "spouse", fatherName: "father",
  fatherDateOfBirth: "father's date of birth", motherName: "mother",
  nationality: "nationality", religion: "religion", placeOfBirth: "place of birth",
  countryOfOrigin: "country of origin", residentialStatus: "residential status",
  isDirector: "director status", isInternational: "international-employee status",
  isPhysicallyChallenged: "physical-challenge status",
});

function compactName(record, prefix) {
  return [record[`${prefix}FirstName`], record[`${prefix}MiddleName`], record[`${prefix}LastName`]]
    .filter(Boolean).join(" ").trim();
}

function employeeFieldValue(record, field) {
  if (!record) return undefined;
  if (field === "fatherName") return compactName(record, "father") || undefined;
  if (field === "motherName") return compactName(record, "mother") || undefined;
  if (field === "primaryManager" || field === "secondaryManager") {
    const manager = record[field];
    return manager && (manager.managerName || manager.name);
  }
  return record[field];
}

function displayEmployeeField(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10);
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.trim();
  return "";
}

function renderEmployeeFieldAnswer({ data, args }) {
  const field = args && args.requestedField;
  if (!field || field === "fullRecord") return null;
  if (field === "attendanceSummary") {
    const employee = data && data.employee;
    if (!employee || !employee.found) return (employee && employee.note) || "No matching employee was found.";
    if (employee.statusOnDate) return employee.statusOnDate;
    const summary = employee.last30DayAttendance;
    if (!summary) return `${employee.profile.name}'s attendance is not recorded or is not available to your account.`;
    return `${employee.profile.name}'s attendance from ${summary.from} to ${summary.to}: ` +
      `${summary.daysRecorded} recorded days — ${summary.present} present, ${summary.absent} absent, ` +
      `${summary.leave} on leave, ${summary.halfDay} half-day, ${summary.late} late, ` +
      `${summary.missedPunch} missed-punch and ${summary.weeklyOff} weekly-off/holiday.`;
  }
  const full = data && data.fullRecord;
  if (!full || !full.found) return (full && full.note) || "No matching employee was found.";
  const label = EMPLOYEE_FIELD_LABELS[field] || field;
  const value = displayEmployeeField(employeeFieldValue(full.record, field));
  if (!value) return `${full.employee}'s ${label} is not recorded or is not available to your account.`;
  return `${full.employee}'s ${label} is ${value}.`;
}

// Month number from a message ("...for June" -> 6) for the regex fallback path;
// the tool-calling path gets the month from the model directly.
function monthFromMessage(message) {
  const s = String(message || "").toLowerCase();
  for (const [name, n] of Object.entries(MONTHS)) {
    if (new RegExp(`\\b${name}[a-z]*\\b`).test(s)) return n;
  }
  return undefined;
}

// "how much did I earn", "my salary", "what's my pay" — a question about the
// SIGNED-IN user's own pay. Matched narrowly so "how much did Ian earn" (a name)
// does not count.
function isSelfQuery(message) {
  const s = String(message || "");
  return /\b(my|mine|myself)\b/i.test(s) || /\bdid i\b|\bi (earn|earned|make|made|get|got)\b|\bam i paid\b|\bdo i (earn|make|get)\b/i.test(s);
}

// "this year" / "annual" / a year with no month -> whole-year total, not one month.
function isAnnualQuery(message) {
  return /\b(this year|the year|per year|annual|annually|yearly| y-?t-?d|year[- ]to[- ]date|whole year|entire year|full year|this financial year|for \d{4}|in \d{4})\b/i.test(
    String(message || ""),
  );
}
function yearFromMessage(message) {
  const s = String(message || "");
  const m = s.match(/\b(20\d{2})\b/);
  if (m) return Number(m[1]);
  const curYear = istNow().getUTCFullYear();
  if (/\blast year\b/i.test(s)) return curYear - 1;
  if (/\b(this year|the year|annual|yearly|ytd|year to date)\b/i.test(s)) return curYear;
  return undefined;
}

// The account is authorised for HR tools when the shared resolver said so.
/* ── The tools answer to the SAME contract as the routes ─────────────────────
 *
 * `hrAuthorised` was the whole gate: any account that could open HR could ask
 * the assistant anything HR knows, including one person's salary. That made the
 * assistant a way around the endpoint permissions rather than a view onto them
 * — a CEO refused compensation at /api/hr/payslip could simply ask for it here.
 *
 * Each tool now names the capability its DATA needs, and the check is the same
 * capability set services/access/hrAuthorization.js hands the mounted routes.
 * `user.hrActor` is attached by gravAssistant.ensureAccess before any tool is
 * offered or run; an unresolved actor holds nothing, so this fails closed.
 */
const { CAPABILITIES } = require("../../access/hrCapabilities");

const heldBy = (user) => (user && user.hrActor && user.hrActor.capabilities) || new Set();

/** Application access alone — the floor every HR tool sits on. */
const hrAuthorised = (user) =>
  Boolean(user && user.hrActor && user.hrActor.hasHrApplicationAccess === true);

/** Application access AND every capability the tool's data needs. */
const hrCan = (...capabilities) => (user) => {
  if (!hrAuthorised(user)) return false;
  const held = heldBy(user);
  return capabilities.every((cap) => held.has(cap));
};

// Deterministic department extraction: "how is the Cutting department doing" →
// "Cutting". Anything not clearly named falls back to all departments.
function extractDepartment(message) {
  const m = String(message || "").match(/\b([A-Za-z][A-Za-z &/-]{1,40}?)\s+department\b/i);
  if (m) return m[1].trim();
  return "all";
}

function extractOrganisationDepartment(message) {
  const text = String(message || "");
  const scoped = text.match(/\b(?:inside|in|of|for)\s+(?:the\s+)?([A-Za-z][A-Za-z &/-]{0,40}?)\s+department\b/i);
  if (scoped) return scoped[1].trim();
  const direct = text.match(/\b([A-Za-z][A-Za-z &/-]{0,40}?)\s+department\b/i);
  return direct ? direct[1].trim() : null;
}

// Parse a date from the message: an explicit YYYY-MM-DD, "today"/"yesterday"/
// "day before yesterday", or "5 aug" / "august 5" / "5th august". Defaults to
// today (IST). A day-month with no year is assumed to be the most recent such
// date (this year, or last year if that would be in the future).
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Spelled-out day ordinals -> number ("the fifth of August" -> 5). Two-word ones
// ("twenty first") are listed first so they're replaced before "first".
const ORDINAL_WORDS = [
  ["twenty first", 21], ["twenty second", 22], ["twenty third", 23], ["twenty fourth", 24],
  ["twenty fifth", 25], ["twenty sixth", 26], ["twenty seventh", 27], ["twenty eighth", 28],
  ["twenty ninth", 29], ["thirty first", 31],
  ["thirtieth", 30], ["twentieth", 20], ["nineteenth", 19], ["eighteenth", 18], ["seventeenth", 17],
  ["sixteenth", 16], ["fifteenth", 15], ["fourteenth", 14], ["thirteenth", 13], ["twelfth", 12],
  ["eleventh", 11], ["tenth", 10], ["ninth", 9], ["eighth", 8], ["seventh", 7], ["sixth", 6],
  ["fifth", 5], ["fourth", 4], ["third", 3], ["second", 2], ["first", 1],
];
function normalizeOrdinals(s) {
  let out = s;
  for (const [word, n] of ORDINAL_WORDS) out = out.replace(new RegExp(`\\b${word.replace(/ /g, "[ -]")}\\b`, "g"), ` ${n} `);
  return out.replace(/\s+/g, " ");
}
function parseDateFromMessage(message) {
  // Turn "the fifth of August" into "the 5 of August", then drop the connective
  // "of"/"the" so the day-month regexes below see "5 August".
  const s = normalizeOrdinals(String(message || "").toLowerCase()).replace(/\b(the|of)\b/g, " ");
  const base = istNow();
  const today = istDateStr(base);
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  if (/\bday before yesterday\b/.test(s)) return istDateStr(new Date(base.getTime() - 2 * 864e5));
  if (/\byesterday\b/.test(s)) return istDateStr(new Date(base.getTime() - 864e5));
  if (/\b(today|now|right now|this morning)\b/.test(s)) return today;

  const dm = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\b/);
  const md = s.match(/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  let day, mon;
  if (dm && MONTHS[dm[2].slice(0, 3)]) {
    day = Number(dm[1]);
    mon = MONTHS[dm[2].slice(0, 3)];
  } else if (md && MONTHS[md[1].slice(0, 3)]) {
    mon = MONTHS[md[1].slice(0, 3)];
    day = Number(md[2]);
  }
  if (day && mon && day >= 1 && day <= 31) {
    const y = base.getUTCFullYear();
    const cand = `${y}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (cand > today) return `${y - 1}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return cand;
  }
  return today;
}

// A model-supplied date is trusted only if it's already YYYY-MM-DD.
const validDate = (d) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);

// Reusable JSON-Schema fragments for function-calling parameters.
const P_DATE = {
  date: {
    type: "string",
    description: "The date as YYYY-MM-DD. Resolve relative or spelled dates (today, yesterday, 'the fifth of August') using today's date from the system prompt. Omit for today.",
  },
};
const P_DEPARTMENT = {
  department: { type: "string", description: "Department name to filter by, if the user named one. Omit for all departments." },
};
const P_EMPLOYEE = {
  employeeName: { type: "string", description: "The employee's name or ID exactly as the user referred to them." },
};

// Cap per-employee rows attached to the prompt: enough to answer, small and fast.
// Kept modest so the answer round's prompt-eval stays quick on local inference.
const MAX_ROWS = 40;

// Map the terse status codes to clear buckets so the model gets labelled counts
// (present/absent/on-leave/…) instead of having to interpret codes and hand-count
// possibly-truncated rows — that was making it answer "0 present" on a day off.
const STATUS_CATEGORY = {
  P: "present", "P*": "present", "P~": "present",
  HD: "halfDay", LHD: "halfDay",
  MP: "missedPunch",
  AB: "absent", LAB: "absent", EAB: "absent",
  WO: "weeklyOff", FH: "weeklyOff", NH: "weeklyOff", OH: "weeklyOff", RH: "weeklyOff", PH: "weeklyOff",
  "L-CL": "onLeave", "L-SL": "onLeave", "L-EL": "onLeave", LWP: "onLeave", CO: "onLeave", WFH: "onLeave",
};
// Statuses people actually ask about — kept first when rows are capped.
const NOTABLE_STATUS = new Set(["AB", "LAB", "EAB", "P*", "MP", "HD", "LHD", "L-CL", "L-SL", "L-EL", "LWP", "CO", "WFH"]);
// The routine "day off" crowd — dropped LAST when rows are capped, so on a
// holiday/Sunday the handful of people who actually worked are never truncated
// out (that hid the one present person and the model invented a name).
const DAYOFF_STATUS = new Set(["WO", "FH", "NH", "OH", "RH", "PH"]);
// Lower rank = kept first: notable → present/working → routine day-off.
const rowRank = (s) => (NOTABLE_STATUS.has(s) ? 0 : DAYOFF_STATUS.has(s) ? 2 : 1);

// Human labels so the model can filter "who was late / absent / on leave / present"
// without knowing that "P*" means late or "L-CL" means casual leave.
const STATUS_LABEL = {
  P: "present", "P~": "present", "P*": "present (arrived late)",
  AB: "absent", LAB: "absent", EAB: "absent",
  HD: "half-day", LHD: "half-day",
  MP: "present (missed a punch)",
  WO: "weekly off", FH: "holiday", NH: "holiday", OH: "holiday", RH: "holiday", PH: "holiday",
  "L-CL": "on leave (casual)", "L-SL": "on leave (sick)", "L-EL": "on leave (earned)",
  LWP: "on leave (unpaid)", CO: "comp-off", WFH: "work from home",
};

// Clear counts from the FULL breakdown (every employee, never truncated).
function summarizeBreakdown(breakdown = {}) {
  const s = { total: 0, present: 0, absent: 0, onLeave: 0, halfDay: 0, weeklyOffOrHoliday: 0, missedPunch: 0, late: 0, other: 0 };
  for (const [code, n] of Object.entries(breakdown)) {
    s.total += n;
    if (code === "P*") s.late += n;
    const cat = STATUS_CATEGORY[code];
    if (cat === "weeklyOff") s.weeklyOffOrHoliday += n;
    else if (cat) s[cat] += n;
    else s.other += n;
  }
  return s;
}

const HR_OVERVIEW_KEYWORDS =
  /\b(attendance|present|absent|late|leave|leaves|headcount|head count|employees?|staff|department|departments|holiday|holidays|regularis|regulariz|on ?leave|hr\b|human resources|absence|roster|workforce|team size)\b/i;

const DAILY_ATTENDANCE_KEYWORDS =
  /\b(attendance|present|absent|late|arrival|arrivals|missed[- ]?punch|checked? (in|out)|clock(ed)? (in|out)|who is (in|out|here|present|absent))\b/i;
const DAY_HINT = /\b(today|now|this morning|right now|yesterday|day before yesterday)\b/i;

const LEAVE_KEYWORDS =
  /\b(leave|leaves|on leave|time off|vacation|day off|days off|pending (leave|request|requests|approval|approvals)|regularis|regulariz|leave balance|casual leave|sick leave|privilege leave|upcoming leave|who is off|who's off)\b/i;

const EMPLOYEE_BIO = /\b([A-Z]{2,3}\d{2,6}|E\d{3,4})\b/i;
const EMPLOYEE_KEYWORDS =
  /\b(join(ed|ing)?|date of joining|designation|profile of|details? (of|about|for)|which department is|reporting manager|leave balance|how many leaves|leaves? (left|remaining|balance)|leaves? does|leaves? has)\b/i;
// "was Umang present yesterday", "did Priya come today", "is Ravi in" — a named
// person (1-3 words) between an auxiliary verb and an attendance word. This is
// how we answer about ONE person without listing everyone.
const PERSON_ATTENDANCE =
  /\b(was|were|is|are|did|has|have)\s+[a-z][a-z.]*(?:\s+[a-z][a-z.]*){0,2}\s+(present|absent|late|here|in|out|off|come|came|attend|attending|working|on leave)\b/i;
const PERSON_POSSESSIVE = /\b[a-z]+(?:'s|s)\s+(attendance|status|timing|punch)\b/i;
const ORDINAL_WORD_RE =
  "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|(?:twenty|thirty)[ -](?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)";
const DATE_REFERENCED = new RegExp(
  `\\b(today|yesterday|day before yesterday|now|this morning|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}(?:st|nd|rd|th)?\\s+[a-z]{3,9}|[a-z]{3,9}\\s+\\d{1,2}|(?:${ORDINAL_WORD_RE})\\s+(?:of\\s+)?[a-z]{3,9}|[a-z]{3,9}\\s+(?:the\\s+)?(?:${ORDINAL_WORD_RE}))\\b`,
  "i",
);
// Does the message name a specific person we should resolve for a balance?
const NAMES_A_PERSON = (msg) =>
  EMPLOYEE_BIO.test(msg) || /\b(does|of|for|balance)\b/i.test(msg);

registerTool({
  name: "hr_overview",
  semantic: semantic(["people", "organisation", "attendance", "leave"]),
  description:
    "Aggregate HR overview: headcount, department distribution, today/monthly attendance, pending leave & regularisation counts, upcoming holidays, alerts.",
  permission: hrCan(CAPABILITIES.ANALYTICS_WORKFORCE),
  matches: (msg) => HR_OVERVIEW_KEYWORDS.test(msg),
  provideContext: async () => ({ hrOverview: await buildHrOverviewContext() }),
});

registerTool({
  name: "hr_daily_attendance",
  semantic: semantic(["attendance"], ["department"]),
  description:
    "The WHOLE day's attendance across all employees (or a department): counts of present/absent/on-leave and who they are, for a given date. Do NOT use this to check ONE specific named person — use hr_employee for that. Read-only.",
  permission: hrCan(CAPABILITIES.ATTENDANCE_READ),
  parameters: { type: "object", properties: { ...P_DATE, ...P_DEPARTMENT } },
  matches: (msg) =>
    DAILY_ATTENDANCE_KEYWORDS.test(msg) ||
    (DAY_HINT.test(msg) && /\b(department|staff|attendance|leave|present|absent|late|off|on leave|half.?day|punch)\b/i.test(msg)),
  provideContext: async ({ user, message, args }) => {
    const date = validDate(args && args.date) || parseDateFromMessage(message);
    const department = (args && args.department) || extractDepartment(message);
    const built = await buildDailyAttendanceContext({
      date,
      department,
      statusFilter: "all",
      typeFilter: "all",
      search: "",
    });
    if (!built.ok) {
      return { dailyAttendance: { date, department, error: built.message } };
    }
    const c = built.context;
    const all = c.records || [];
    const summary = summarizeBreakdown(c.breakdown);
    const deptClause = c.scope.department && c.scope.department !== "all" ? ` in the ${c.scope.department} department` : "";
    // A plain-English line the model can quote directly. A small, thinking-off
    // model reads this far more reliably than a big JSON blob — dumping all 60+
    // rows drowned it out and it answered "0 present / no one absent" even when
    // the counts were right. So: the sentence + counts, and ONLY the notable
    // rows (absent/late/leave/half-day/missed-punch) people actually ask about.
    const readable =
      `On ${c.date}${deptClause}, out of ${summary.total} employees: ` +
      `${summary.present} present, ${summary.absent} absent, ${summary.onLeave} on leave, ` +
      `${summary.halfDay} on half-day, ${summary.weeklyOffOrHoliday} on weekly-off/holiday, ` +
      `${summary.late} arrived late, ${summary.missedPunch} with a missed punch.`;
    // EVERY employee's row (not just exceptions), labelled and sorted so the
    // notable statuses come first — so "who is present / absent / on leave" is
    // answered from real names and the model never has to invent one. Counts
    // still come from `summary`; this list is the "who".
    const records = [...all]
      .sort((a, b) => rowRank(a.status) - rowRank(b.status))
      .slice(0, MAX_ROWS)
      .map((r) => ({
        name: r.name,
        id: r.id,
        department: r.department,
        status: STATUS_LABEL[r.status] || r.statusLabel || r.status,
        inTime: r.inTime,
        outTime: r.outTime,
      }));
    return {
      dailyAttendance: {
        date: c.date,
        department: c.scope.department,
        dataState: c.dataState,
        holiday: c.holiday || null,
        // Answer COUNTS from this sentence / summary — do not count the list.
        readable,
        summary,
        // The actual people and their status. Use ONLY these names — never
        // invent one. If the person asked about isn't here, say so.
        records,
        recordsTruncated: all.length > records.length,
      },
    };
  },
});

registerTool({
  name: "hr_leave",
  semantic: semantic(["leave"], ["employee", "department"]),
  description:
    "Leave & regularisation for authorised HR: pending leave requests, pending regularisations, upcoming approved leaves, and a named person's CL/SL/PL balance. Read-only.",
  permission: hrCan(CAPABILITIES.LEAVE_READ),
  parameters: { type: "object", properties: { ...P_DEPARTMENT, ...P_EMPLOYEE } },
  matches: (msg) => LEAVE_KEYWORDS.test(msg),
  provideContext: async ({ message, args }) => {
    const department = (args && args.department) || extractDepartment(message);
    const employeeQuery = (args && args.employeeName) || (NAMES_A_PERSON(message) ? message : undefined);
    return {
      leave: await buildLeaveContext({
        department: department === "all" ? undefined : department,
        employeeQuery,
      }),
    };
  },
});

registerTool({
  name: "hr_person_metric",
  semantic: semantic(["people", "payroll"], ["employee"]),
  description:
    `Canonical ONE-VALUE lookup for a named employee. Each metric has one source of truth: employee.* is a current employee-master field; compensation.configured_* is the current configured monthly salary master and needs no payroll run; payroll.* is a posted payroll result and requires an explicit month/year (or year for annual totals). ${metricGlossary()} Prefer this over broad employee, salary or payroll-summary tools whenever the user asks for one exact field or figure. Read-only.`,
  permission: hrCan(CAPABILITIES.PEOPLE_READ_DIRECTORY),
  // Every scalar field is now resolved from catalogue aliases. Keeping this
  // tool out of model selection makes a schema-valid but semantically wrong
  // enum impossible; Qwen cannot choose one profile field for another.
  modelSelectable: false,
  parameters: {
    type: "object",
    properties: {
      ...P_EMPLOYEE,
      metric: {
        type: "string",
        enum: semanticMetricIds(),
        description:
          "Canonical metric id. A current figure with no period uses compensation.configured_*. If the request names any month/year or asks what was paid/calculated, use the matching payroll.* metric; specifically a period gross is payroll.gross_earnings, never compensation.configured_gross_monthly.",
      },
      month: { type: "integer", minimum: 1, maximum: 12, description: "Required only for month_required payroll metrics." },
      year: { type: "integer", minimum: 2000, maximum: 2100, description: "Required for payroll metrics." },
    },
    required: ["employeeName", "metric"],
  },
  matches: () => false,
  claim: async ({ message }) => {
    const definition = metricFromText(message);
    if (!definition) return null;
    const comparison = parseMetricComparison(message, definition);
    const employeeName = comparison ? comparison.employeeName : stripMetricTerms(message, definition);
    if (!employeeName) return null;
    // Metric words can also describe a non-person entity (for example
    // "designations inside Accounts department"). A scalar person tool may
    // claim the request only when the remaining subject resolves to a real HR
    // employee. This is authoritative entity typing, not a phrase heuristic.
    if (!(await resolveEmployeeByQuery(employeeName))) return null;
    const month = monthFromMessage(message);
    const year = yearFromMessage(message);
    const periodDefinition = metricForRequest(definition.id, { month, year });
    const needsPeriodArgs = periodDefinition && periodDefinition.id !== definition.id;
    return {
      employeeName,
      metric: definition.id,
      ...(comparison ? { expectedValue: comparison.expectedValue } : {}),
      ...(needsPeriodArgs && month ? { month } : {}),
      ...(needsPeriodArgs && year ? { year } : {}),
    };
  },
  provideContext: async ({ user, message, args }) => {
    const definition = metricForRequest(args && args.metric, args || {});
    if (!definition) return { found: false, note: "That HR metric is not registered." };

    const held = heldBy(user);
    if (definition.id.startsWith("compensation.") &&
        (!held.has(CAPABILITIES.PEOPLE_READ_PRIVATE) || !held.has(CAPABILITIES.COMPENSATION_READ))) {
      return { found: false, denied: true, note: "That compensation metric is not available to your account." };
    }
    if (definition.id.startsWith("payroll.") &&
        (!held.has(CAPABILITIES.PAYROLL_READ) || !held.has(CAPABILITIES.COMPENSATION_READ))) {
      return { found: false, denied: true, note: "That payroll metric is not available to your account." };
    }

    if (definition.temporal === METRIC_MONTH && !(Number(args.month) >= 1 && Number(args.month) <= 12 && Number(args.year) >= 2000)) {
      return { found: false, needsPeriod: "month", note: "Which payroll month and year should I use?" };
    }
    if (definition.temporal === METRIC_YEAR && !(Number(args.year) >= 2000)) {
      return { found: false, needsPeriod: "year", note: "Which payroll year should I use?" };
    }
    if (definition.temporal !== METRIC_MONTH && definition.temporal !== METRIC_YEAR &&
        (args.month !== undefined || args.year !== undefined)) {
      return {
        found: false,
        semanticMismatch: true,
        note: "A current configured metric cannot be combined with a payroll period. Please specify whether you want the current configured value or the posted payroll result for that period.",
      };
    }

    const employeeQuery = stripMetricTerms(args.employeeName, definition) || args.employeeName;
    if (definition.source === "employee_master") {
      const employeeRecord = await buildFullEmployeeContext({ query: employeeQuery, user });
      return { found: employeeRecord.found, definition, employeeRecord, note: employeeRecord.note };
    }

    const payroll = await buildSalaryContext({
      query: employeeQuery,
      month: args.month,
      year: args.year,
      user,
      annual: definition.temporal === METRIC_YEAR,
    });
    return { found: payroll.found, definition, payroll, note: payroll.note };
  },
  renderAnswer: ({ data, args }) => {
    if (!data || !data.definition) return (data && data.note) || "That HR metric could not be read safely.";
    if (!data.found) return data.note || "That HR metric is not available.";
    if (data.definition.source === "employee_master") {
      const renderer = args && args.expectedValue !== undefined ? renderMetricComparisonAnswer : renderMetricAnswer;
      return renderer({
        definition: data.definition,
        employee: data.employeeRecord.employee,
        source: data.employeeRecord.record,
        expectedValue: args && args.expectedValue,
      });
    }
    const renderer = args && args.expectedValue !== undefined ? renderMetricComparisonAnswer : renderMetricAnswer;
    return renderer({
      definition: data.definition,
      employee: data.payroll.employee && data.payroll.employee.name,
      source: data.payroll,
      expectedValue: args && args.expectedValue,
    });
  },
});

registerTool({
  name: "hr_employee",
  semantic: semantic(["people", "attendance", "leave", "documents"], ["employee"]),
  description:
    "Complete authorised MULTI-FIELD HR record for one named employee, including custom fields, documents, family details, leave and attendance. Use hr_person_metric instead when the request asks for one standard field or one compensation/payroll value. Read-only.",
  permission: hrCan(CAPABILITIES.PEOPLE_READ_DIRECTORY),
  parameters: {
    type: "object",
    properties: {
      ...P_EMPLOYEE,
      requestedField: {
        type: "string",
        enum: ["fullRecord", "attendanceSummary"],
        description: "Use attendanceSummary for a named person's attendance; otherwise use fullRecord. Exact scalar fields are handled by the deterministic semantic catalogue and are not model-selectable.",
      },
      ...P_DATE,
    },
    required: ["employeeName", "requestedField"],
  },
  matches: (msg) =>
    EMPLOYEE_BIO.test(msg) || EMPLOYEE_KEYWORDS.test(msg) || PERSON_ATTENDANCE.test(msg) || PERSON_POSSESSIVE.test(msg),
  claim: async ({ message }) => {
    const text = String(message || "");
    const namedAttendance = PERSON_POSSESSIVE.test(text) ||
      (PERSON_ATTENDANCE.test(text) && !/\b(everyone|anyone|employees?|staff|team|department|workforce|who)\b/i.test(text));
    if (!namedAttendance) return null;
    if (!(await resolveEmployeeByQuery(text))) return null;
    const date = DATE_REFERENCED.test(text) ? parseDateFromMessage(text) : undefined;
    return {
      employeeName: text,
      requestedField: "attendanceSummary",
      ...(date ? { date } : {}),
    };
  },
  provideContext: async ({ user, message, args }) => {
    // If the question is about a specific day ("...present yesterday"), report
    // that day's status for the person; otherwise just their profile + summary.
    const query = (args && args.employeeName) || message;
    const date = validDate(args && args.date) || (DATE_REFERENCED.test(message) ? parseDateFromMessage(message) : undefined);
    const [summary, fullRecord] = await Promise.all([
      buildEmployeeLookup({ query, date }),
      buildFullEmployeeContext({ query, user }),
    ]);
    return { employee: summary, fullRecord };
  },
  renderAnswer: renderEmployeeFieldAnswer,
});

// Test seams for the typed field contract and deterministic formatter.
module.exports._employeeFieldIds = EMPLOYEE_FIELD_IDS;
module.exports._renderEmployeeFieldAnswer = renderEmployeeFieldAnswer;

registerTool({
  name: "hr_directory",
  semantic: semantic(["people", "organisation"], ["department"]),
  description:
    "Employee directory for authorised HR: total/active headcount, headcount by department, and a department's members. Read-only.",
  permission: hrCan(CAPABILITIES.PEOPLE_READ_DIRECTORY),
  parameters: { type: "object", properties: { ...P_DEPARTMENT } },
  matches: (msg) =>
    /\b(directory|how many (employees|people|staff|workers)|total (employees|staff|headcount)|head\s?count|number of (employees|staff)|list .*(employees|staff)|employees? in|team size|workforce|staff strength|who works (in|at))\b/i.test(msg),
  provideContext: async ({ message, args }) => {
    const department = (args && args.department) || extractDepartment(message);
    return { directory: await buildDirectoryContext({ department: department === "all" ? undefined : department }) };
  },
});

registerTool({
  name: "hr_departments",
  semantic: semantic(["organisation"], ["department"]),
  description:
    "The organisation's departments for authorised HR: each department's status, live headcount and designations. Read-only.",
  permission: hrCan(CAPABILITIES.PEOPLE_READ_DIRECTORY),
  parameters: { type: "object", properties: { ...P_DEPARTMENT } },
  matches: (msg) =>
    /\b(departments\b|list .*departments?|department list|how many departments|which departments|org structure|organ[a-z]* structure|designations?)\b/i.test(msg),
  claim: async ({ message }) => {
    if (!/\bdesignations?\b/i.test(String(message || ""))) return null;
    const requested = extractOrganisationDepartment(message);
    if (!requested) return null;
    const context = await buildDepartmentsContext();
    const match = (context.departments || []).find((department) =>
      String(department.name || "").localeCompare(requested, undefined, { sensitivity: "base" }) === 0);
    return match ? { department: match.name } : null;
  },
  provideContext: async () => ({ departments: await buildDepartmentsContext() }),
  renderAnswer: ({ data, args }) => {
    const requested = args && args.department;
    if (!requested) return null;
    const context = data && data.departments;
    const department = context && (context.departments || []).find((item) =>
      String(item.name || "").localeCompare(requested, undefined, { sensitivity: "base" }) === 0);
    if (!department) return `No department matching ${requested} was found.`;
    const designations = (department.designations || []).filter((item) => item.active !== false).map((item) => item.name);
    return designations.length
      ? `The ${department.name} department has these designations: ${designations.join(", ")}.`
      : `The ${department.name} department has no active designations recorded.`;
  },
});

registerTool({
  name: "hr_overtime",
  semantic: semantic(["attendance"], ["employee", "department"]),
  description:
    "Overtime for authorised HR: recent overtime (hours), pending overtime approvals, filterable by department. Read-only.",
  permission: hrCan(CAPABILITIES.ATTENDANCE_READ),
  parameters: { type: "object", properties: { ...P_DEPARTMENT } },
  matches: (msg) => /\b(over\s?time|\bot\b|extra hours|stay\s?over|worked late|late sitting)\b/i.test(msg),
  provideContext: async ({ message, args }) => {
    const department = (args && args.department) || extractDepartment(message);
    return { overtime: await buildOvertimeContext({ department: department === "all" ? undefined : department }) };
  },
});

registerTool({
  name: "hr_holidays",
  semantic: semantic(["leave", "policy"]),
  description: "Company holidays for authorised HR: upcoming and this-year holidays with dates and type. Read-only.",
  permission: hrCan(CAPABILITIES.LEAVE_READ),
  matches: (msg) => /\b(holidays?|public holiday|festival holiday|next holiday|day off|leave calendar|holiday list)\b/i.test(msg),
  provideContext: async () => ({ holidays: await buildHolidaysContext() }),
});

registerTool({
  name: "hr_policies",
  semantic: semantic(["policy"]),
  description:
    "HR policies & settings for authorised HR: shift timings, late/half-day thresholds, working days, leave entitlements (CL/SL/PL per year), payroll settings and active SOP policies. Read-only.",
  permission: hrCan(CAPABILITIES.COMPLIANCE_READ),
  matches: (msg) =>
    /polic(y|ies)|shift\s*(timing|timings|time|times|start|end|hour|hours)|(office|work(ing)?)\s*(timing|timings|hour|hours|time|times|day|days)|what time does (office|work|the shift)|when does (office|work|the shift)|entitlement|(company|hr|leave|attendance)\s*(rule|rules|policy|policies|setting|settings)|\bsettings\b/i.test(
      msg,
    ),
  provideContext: async () => ({ policies: await buildPoliciesContext() }),
});

registerTool({
  name: "hr_payroll",
  semantic: semantic(["payroll"], ["payroll_run"]),
  description:
    "COMPANY-LEVEL payroll runs for authorised HR: whole-company monthly totals (total gross, total deductions, total net pay, total PF/ESIC) and run status across all employees. For ONE person's salary use hr_salary instead. Read-only.",
  permission: hrCan(CAPABILITIES.PAYROLL_READ, CAPABILITIES.COMPENSATION_READ),
  matches: (msg) => /\b(payroll (run|total|summary)|total (net pay|payroll|salary bill)|company.*(payroll|salary)|salary (bill|expense|cost))\b/i.test(msg),
  provideContext: async () => ({ payroll: await buildPayrollContext() }),
});

registerTool({
  name: "hr_salary",
  semantic: semantic(["payroll"], ["employee"]),
  description:
    "FULL POSTED PAYSLIP/PAYROLL BREAKDOWN for a processed month or year: earnings components, deductions, net pay, days and status together. This is calculated payroll history, not the employee's configured salary master. Never use this full-summary capability for one requested figure; use hr_person_metric for every single configured or payroll metric. Bank details excluded. Sensitive; read-only.",
  permission: hrCan(CAPABILITIES.COMPENSATION_READ),
  parameters: {
    type: "object",
    properties: {
      employeeName: {
        type: "string",
        description:
          "The employee's name or ID. LEAVE EMPTY when the user asks about their OWN pay ('how much did I earn', 'my salary') — the signed-in identity is used instead of a name.",
      },
      month: { type: "integer", description: "Month number 1-12 (e.g. June = 6). Omit for the latest processed month, or for a whole-year total." },
      year: { type: "integer", description: "Year, e.g. 2026. Omit for the current/latest." },
    },
  },
  matches: (msg) =>
    /\b(salary|salaries|payslip|pay slip|pay-slip|take[- ]?home|net pay|gross pay|ctc|earnings|wage|wages|how much (is|does|was|did).*(paid|earn|salary)|did i earn|my (pay|salary|earnings))\b/i.test(msg),
  provideContext: async ({ user, message, args }) => {
    const monthArg = (args && args.month) || monthFromMessage(message);
    // A first-person question is about the signed-in user — even if the model
    // also guessed a name, the pronoun wins so "I" can't become someone else.
    const self = isSelfQuery(message);
    const annual = isAnnualQuery(message) && !monthArg; // a year total, unless a month is named
    return {
      salary: await buildSalaryContext({
        user,
        self,
        annual,
        query: (args && args.employeeName) || message,
        month: monthArg,
        year: (args && args.year) || yearFromMessage(message),
      }),
    };
  },
});

// ── Complete typed read catalogue ───────────────────────────────────────────
// These adapters cover the underlying HR record domains rather than only the
// dashboard summaries above. They deliberately remain separate capabilities:
// a directory reader must not gain payroll, recruitment, documents or audit
// merely because all of those records happen to live in the HR application.

const P_RANGE = {
  from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Inclusive start date YYYY-MM-DD." },
  to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Inclusive end date YYYY-MM-DD." },
  limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum result rows; default 20, maximum 50." },
};

registerTool({
  name: "hr_attendance_records",
  semantic: semantic(["attendance"], ["employee", "department"]),
  description:
    "Detailed HR attendance/timecard records over a date range: each employee's final/system status, raw punch timeline, every work/break/overtime/late/early/missed-punch metric, shift, attendance value, holiday state and HR review evidence. Use for histories, hours, punches, ranges and any monthly attendance report; use hr_daily_attendance for one-day workforce counts.",
  permission: hrCan(CAPABILITIES.ATTENDANCE_READ),
  parameters: { type: "object", properties: { ...P_EMPLOYEE, ...P_DEPARTMENT, ...P_RANGE } },
  matches: (msg) => /timecard|attendance history|attendance records?|working hours|work hours|punches?|break minutes|late minutes|early departure|date range/i.test(msg),
  provideContext: async ({ args }) => ({ attendanceRecords: await buildAttendanceRecordsContext(args || {}) }),
});

registerTool({
  name: "hr_attendance_exclusions",
  semantic: semantic(["attendance"], ["employee"]),
  description:
    "Attendance-register exclusions: employees deliberately removed from a specific month, who removed them, when, why and how many existing days were removed. Use for off-roll/month-removal and restore-history questions.",
  permission: hrCan(CAPABILITIES.ATTENDANCE_READ),
  parameters: {
    type: "object",
    properties: {
      ...P_EMPLOYEE,
      yearMonth: { type: "string", pattern: "^\\d{4}-\\d{2}$", description: "Attendance month YYYY-MM." },
      limit: P_RANGE.limit,
    },
  },
  matches: (msg) => /attendance (exclusion|register removal)|removed from (the )?month|off[- ]roll|restore.*attendance/i.test(msg),
  provideContext: async ({ args }) => ({ attendanceExclusions: await buildAttendanceExclusionsContext(args || {}) }),
});

registerTool({
  name: "hr_leave_records",
  semantic: semantic(["leave"], ["employee", "department"]),
  description:
    "Detailed leave-domain records: leave applications with dates/days/reasons/approval chain, regularisation requests with requested corrections and outcomes, or yearly leave balances with entitlement and consumption. Use for record-level or historical leave questions; use hr_leave for a quick dashboard summary.",
  permission: hrCan(CAPABILITIES.LEAVE_READ),
  parameters: {
    type: "object",
    properties: {
      recordType: { type: "string", enum: ["leave", "regularization", "balance"], description: "Which HR record family answers the question." },
      ...P_EMPLOYEE,
      ...P_DEPARTMENT,
      status: { type: "string", description: "Exact workflow status when the user named one." },
      year: { type: "integer", minimum: 2000, maximum: 2100 },
      ...P_RANGE,
    },
    required: ["recordType"],
  },
  matches: (msg) => /leave history|leave applications?|regulari[sz]ation|leave entitlement|leave consumed|leave reason|approval chain/i.test(msg),
  provideContext: async ({ args }) => ({ leaveRecords: await buildLeaveRecordsContext(args || {}) }),
});

registerTool({
  name: "hr_recruitment",
  semantic: semantic(["recruitment"], ["candidate", "department"]),
  description:
    "Complete authorised recruitment data: job postings/openings, skills, locations, salary ranges and hiring managers; candidates, contact/application/stage/experience/rating/interview notes; or recruitment interview/meeting/follow-up tasks and outcomes. A partial role, job title, candidate name or skill is a search query for this tool and does not require clarification.",
  permission: hrCan(CAPABILITIES.RECRUITMENT_READ),
  parameters: {
    type: "object",
    properties: {
      recordType: { type: "string", enum: ["jobs", "candidates", "tasks"] },
      query: { type: "string", maxLength: 120, description: "Named job, candidate, skill or task text to find." },
      status: { type: "string", maxLength: 60 },
      stage: { type: "string", maxLength: 60 },
      ...P_DEPARTMENT,
      ...P_RANGE,
    },
    required: ["recordType"],
  },
  matches: (msg) => /recruit|candidate|applicant|job posting|job opening|vacanc|interview|hiring|notice period/i.test(msg),
  provideContext: async ({ args }) => ({ recruitment: await buildRecruitmentContext(args || {}) }),
});

registerTool({
  name: "hr_documents",
  semantic: semantic(["documents"], ["document", "employee", "department"]),
  description:
    "Complete authorised employee-document register: appointment/offer/warning/experience/relieving/salary-certificate/other letters, requests, generation/release/revocation/decline state, dates, reasons, letter metadata and history. File storage secrets are never exposed.",
  permission: hrCan(CAPABILITIES.DOCUMENTS_READ),
  parameters: {
    type: "object",
    properties: {
      ...P_EMPLOYEE,
      ...P_DEPARTMENT,
      type: { type: "string", enum: ["appointment", "offer", "warning", "experience", "relieving", "salary_certificate", "other"] },
      state: { type: "string", enum: ["all", "awaiting_generation", "generated_unreleased", "released", "revoked"] },
      limit: P_RANGE.limit,
    },
  },
  matches: (msg) => /employee document|appointment letter|offer letter|warning letter|experience letter|relieving letter|salary certificate|document request|released document|revoked document/i.test(msg),
  provideContext: async ({ user, args }) => ({ documents: await buildDocumentRecordsContext({ ...(args || {}), user }) }),
});

registerTool({
  name: "hr_payroll_records",
  semantic: semantic(["payroll"], ["employee", "department"]),
  description:
    "Detailed EMPLOYEE payroll items. Use this instead of hr_salary whenever the user asks how one or more employees' pay was calculated, payable/attendance days, a salary register, contributions, adjustments, or day-by-day evidence. Items include employee/pay period, rates, every earnings and deduction component, employer contributions, adjustments, CTC-related food allowance, override/status/payment metadata. Set includeDayBreakdown=true for a named employee plus month/year when day-by-day calculation is requested. Bank account details are always excluded.",
  permission: hrCan(CAPABILITIES.PAYROLL_READ, CAPABILITIES.COMPENSATION_READ),
  parameters: {
    type: "object",
    properties: {
      ...P_EMPLOYEE,
      ...P_DEPARTMENT,
      status: { type: "string", maxLength: 60 },
      month: { type: "integer", minimum: 1, maximum: 12 },
      year: { type: "integer", minimum: 2000, maximum: 2100 },
      includeDayBreakdown: { type: "boolean", description: "Include the stored per-day payroll audit trail. Only valid when one employee, month and year are all supplied." },
      limit: P_RANGE.limit,
    },
  },
  matches: (msg) => /payroll item|salary register|payable days|employer pf|employer esic|edli|admin charges|loan deduction|advance deduction|incentive|other earnings|payroll status/i.test(msg),
  provideContext: async ({ message, args }) => ({
    payrollRecords: await buildPayrollRecordsContext({
      ...(args || {}),
      recordType: "items",
      employeeName: (args && args.employeeName) || message,
      month: (args && args.month) || monthFromMessage(message),
      year: (args && args.year) || yearFromMessage(message),
    }),
  }),
});

registerTool({
  name: "hr_payroll_runs",
  semantic: semantic(["payroll"], ["payroll_run"]),
  description:
    "Complete COMPANY payroll-run records and stored totals/approval metadata. Use for payroll run status, run-level totals and approval history, not an individual employee's pay or day-by-day calculation.",
  permission: hrCan(CAPABILITIES.PAYROLL_READ, CAPABILITIES.COMPENSATION_READ),
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", maxLength: 60 },
      month: { type: "integer", minimum: 1, maximum: 12 },
      year: { type: "integer", minimum: 2000, maximum: 2100 },
      limit: P_RANGE.limit,
    },
  },
  matches: (msg) => /payroll run|payroll approval|payroll processing status|run-level payroll/i.test(msg),
  provideContext: async ({ args }) => ({ payrollRuns: await buildPayrollRecordsContext({ ...(args || {}), recordType: "runs" }) }),
});

registerTool({
  name: "hr_performance",
  semantic: semantic(["performance", "attendance", "leave"], ["employee", "department"]),
  description:
    "Employee or workforce performance for a year: tenure, attendance rate and present/absent/late/half-day/leave/LOP metrics, leave entitlement/consumption/balance and SOP/C4 points with dated entries. Filter by named employee or department.",
  permission: hrCan(CAPABILITIES.SKILLS_READ, CAPABILITIES.ANALYTICS_WORKFORCE),
  parameters: {
    type: "object",
    properties: { ...P_EMPLOYEE, ...P_DEPARTMENT, year: { type: "integer", minimum: 2000, maximum: 2100 }, limit: P_RANGE.limit },
  },
  matches: (msg) => /performance|attendance rate|attendance percentage|sop points|c4 points|penalty points|performance score|tenure/i.test(msg),
  provideContext: async ({ args }) => ({ performance: await buildPerformanceContext(args || {}) }),
});

registerTool({
  name: "hr_audit",
  semantic: semantic(["audit"], ["employee"]),
  description:
    "HR change history and audit evidence: what changed, section/entity/action, changed fields, actor, approval, origin, critical flag and timestamp. Stored secrets are redacted. Use for 'who changed what/when' questions.",
  permission: hrCan(CAPABILITIES.AUDIT_READ),
  parameters: {
    type: "object",
    properties: {
      ...P_EMPLOYEE,
      section: { type: "string", maxLength: 100 },
      action: { type: "string", enum: ["create", "update", "delete", "approve", "reject", "fail", "import", "export", "other"] },
      critical: { type: "boolean" },
      ...P_RANGE,
    },
  },
  matches: (msg) => /audit|change history|who changed|who edited|what changed|history of changes|recent changes/i.test(msg),
  provideContext: async ({ args }) => ({ audit: await buildHrAuditContext(args || {}) }),
});
