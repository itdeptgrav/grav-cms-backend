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
 * Read-only HR tools:
 *   • hr_overview          — aggregate "how are we doing" HR figures (no scope);
 *   • hr_daily_attendance  — attendance for a day (today, yesterday, or a named
 *                            date), filterable by department;
 *   • hr_leave             — pending leave & regularisation requests, upcoming
 *                            approved leaves, and a named person's leave balance;
 *   • hr_employee          — one employee's profile basics, leave balance and a
 *                            last-30-day attendance tally (never salary/PII).
 */

const { registerTool } = require("../toolRegistry");
const { buildHrOverviewContext } = require("../../hrOverviewContext");
const { buildDailyAttendanceContext } = require("../../dailyAttendanceContext");
const { buildLeaveContext } = require("../../hrLeaveContext");
const { buildEmployeeLookup, istNow, istDateStr } = require("../../hrEmployeeContext");
const {
  buildDirectoryContext,
  buildDepartmentsContext,
  buildOvertimeContext,
  buildHolidaysContext,
  buildPoliciesContext,
  buildPayrollContext,
  buildSalaryContext,
} = require("../../hrExtraContext");

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
const hrAuthorised = (user) => Boolean(user && user.hrAccess && user.hrAccess.allowed === true);

// Deterministic department extraction: "how is the Cutting department doing" →
// "Cutting". Anything not clearly named falls back to all departments.
function extractDepartment(message) {
  const m = String(message || "").match(/\b([A-Za-z][A-Za-z &/-]{1,40}?)\s+department\b/i);
  if (m) return m[1].trim();
  return "all";
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
  description:
    "Aggregate HR overview: headcount, department distribution, today/monthly attendance, pending leave & regularisation counts, upcoming holidays, alerts.",
  permission: hrAuthorised,
  matches: (msg) => HR_OVERVIEW_KEYWORDS.test(msg),
  provideContext: async () => ({ hrOverview: await buildHrOverviewContext() }),
});

registerTool({
  name: "hr_daily_attendance",
  description:
    "The WHOLE day's attendance across all employees (or a department): counts of present/absent/on-leave and who they are, for a given date. Do NOT use this to check ONE specific named person — use hr_employee for that. Read-only.",
  permission: hrAuthorised,
  parameters: { type: "object", properties: { ...P_DATE, ...P_DEPARTMENT } },
  matches: (msg) =>
    DAILY_ATTENDANCE_KEYWORDS.test(msg) ||
    (DAY_HINT.test(msg) && /\b(department|staff|attendance|leave|present|absent|late|off|on leave|half.?day|punch)\b/i.test(msg)),
  provideContext: async ({ message, args }) => {
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
  description:
    "Leave & regularisation for authorised HR: pending leave requests, pending regularisations, upcoming approved leaves, and a named person's CL/SL/PL balance. Read-only.",
  permission: hrAuthorised,
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
  name: "hr_employee",
  description:
    "Everything about ONE specific named person (or employee ID): whether they were present / absent / on leave / late on a given date, their profile (department, designation, joining date, status), current-year leave balance and last-30-day attendance. Use this whenever the question is about a single named individual. No salary. Read-only.",
  permission: hrAuthorised,
  parameters: { type: "object", properties: { ...P_EMPLOYEE, ...P_DATE }, required: ["employeeName"] },
  matches: (msg) =>
    EMPLOYEE_BIO.test(msg) || EMPLOYEE_KEYWORDS.test(msg) || PERSON_ATTENDANCE.test(msg) || PERSON_POSSESSIVE.test(msg),
  provideContext: async ({ message, args }) => {
    // If the question is about a specific day ("...present yesterday"), report
    // that day's status for the person; otherwise just their profile + summary.
    const query = (args && args.employeeName) || message;
    const date = validDate(args && args.date) || (DATE_REFERENCED.test(message) ? parseDateFromMessage(message) : undefined);
    return { employee: await buildEmployeeLookup({ query, date }) };
  },
});

registerTool({
  name: "hr_directory",
  description:
    "Employee directory for authorised HR: total/active headcount, headcount by department, and a department's members. Read-only.",
  permission: hrAuthorised,
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
  description:
    "The organisation's departments for authorised HR: each department's status, live headcount and designations. Read-only.",
  permission: hrAuthorised,
  matches: (msg) =>
    /\b(departments\b|list .*departments?|department list|how many departments|which departments|org structure|organ[a-z]* structure|designations?)\b/i.test(msg),
  provideContext: async () => ({ departments: await buildDepartmentsContext() }),
});

registerTool({
  name: "hr_overtime",
  description:
    "Overtime for authorised HR: recent overtime (hours), pending overtime approvals, filterable by department. Read-only.",
  permission: hrAuthorised,
  parameters: { type: "object", properties: { ...P_DEPARTMENT } },
  matches: (msg) => /\b(over\s?time|\bot\b|extra hours|stay\s?over|worked late|late sitting)\b/i.test(msg),
  provideContext: async ({ message, args }) => {
    const department = (args && args.department) || extractDepartment(message);
    return { overtime: await buildOvertimeContext({ department: department === "all" ? undefined : department }) };
  },
});

registerTool({
  name: "hr_holidays",
  description: "Company holidays for authorised HR: upcoming and this-year holidays with dates and type. Read-only.",
  permission: hrAuthorised,
  matches: (msg) => /\b(holidays?|public holiday|festival holiday|next holiday|day off|leave calendar|holiday list)\b/i.test(msg),
  provideContext: async () => ({ holidays: await buildHolidaysContext() }),
});

registerTool({
  name: "hr_policies",
  description:
    "HR policies & settings for authorised HR: shift timings, late/half-day thresholds, working days, leave entitlements (CL/SL/PL per year), payroll settings and active SOP policies. Read-only.",
  permission: hrAuthorised,
  matches: (msg) =>
    /polic(y|ies)|shift\s*(timing|timings|time|times|start|end|hour|hours)|(office|work(ing)?)\s*(timing|timings|hour|hours|time|times|day|days)|what time does (office|work|the shift)|when does (office|work|the shift)|entitlement|(company|hr|leave|attendance)\s*(rule|rules|policy|policies|setting|settings)|\bsettings\b/i.test(
      msg,
    ),
  provideContext: async () => ({ policies: await buildPoliciesContext() }),
});

registerTool({
  name: "hr_payroll",
  description:
    "COMPANY-LEVEL payroll runs for authorised HR: whole-company monthly totals (total gross, total deductions, total net pay, total PF/ESIC) and run status across all employees. For ONE person's salary use hr_salary instead. Read-only.",
  permission: hrAuthorised,
  matches: (msg) => /\b(payroll (run|total|summary)|total (net pay|payroll|salary bill)|company.*(payroll|salary)|salary (bill|expense|cost))\b/i.test(msg),
  provideContext: async () => ({ payroll: await buildPayrollContext() }),
});

registerTool({
  name: "hr_salary",
  description:
    "SALARY / payslip for authorised HR & CEO. Works for a NAMED employee's monthly pay (basic, gross, allowances, deductions, net pay) AND for the signed-in user's OWN pay when they ask about themselves ('how much did I earn', 'my salary') — leave employeeName EMPTY for a self-question. For a whole-year total ('this year', 'annual'), it returns the year's total across all months. Bank details excluded. Sensitive; read-only.",
  permission: hrAuthorised,
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
