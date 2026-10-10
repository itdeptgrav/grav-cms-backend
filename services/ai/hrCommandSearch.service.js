"use strict";
/**
 * services/ai/hrCommandSearch.service.js — Cmd/Ctrl K for HR, answered
 * without a model.
 *
 * Same contract as Store's and the books' palettes (`{ state, note, groups }`,
 * the same result kinds, the same cards), so the shared palette renders all
 * three identically. What it answers, for the capabilities HR has already
 * resolved for this person (services/access/hrAuthorization.js):
 *
 *   a person, a record by name       "GR0067", "Ravi Kumar", "Cutting",
 *                                    "Tailor opening", a letter's reference no.
 *   people, filtered                 "employees in cutting", "interns",
 *                                    "inactive employees", "Ravi's team",
 *                                    "who joined this month", "how many employees"
 *   attendance                       "who is absent today", "late yesterday",
 *                                    "was Ravi present on 3 Oct", "attendance today",
 *                                    "attendance of GR0067 this month"
 *   leave                            "pending leave requests", "sick leaves this month",
 *                                    "leave balance of Ravi", "next holiday"
 *   corrections, overtime            "pending attendance corrections", "overtime yesterday"
 *   recruitment                      "open jobs", "candidates in hr interview",
 *                                    "interviews this week"
 *   letters                          "requested letters", "offer letters of Ravi"
 *   payroll runs, policies           "payroll October 2026" (status only), "C4 policies"
 *
 * ── THE RULES IT KEEPS ────────────────────────────────────────────────────
 *   · A family the role cannot read is never read: the answer says so.
 *   · Only directory fields of a person are read (see hrCommandContract.js);
 *     pay, bank, statutory ids, private contact, medical: never.
 *   · A word the person typed is never dropped. "leaves of Nobody" names a
 *     person; if nobody is called that, the answer is nothing — never every
 *     leave.
 *   · A date range on a family with more than one date must say which date
 *     ("joined", "applied", "published"); otherwise it is refused, not guessed.
 *   · HR's data has no company (hrAuthorization.js LEGACY_GLOBAL_HR_SCOPE);
 *     the capability set is the whole scope.
 */

const Employee = require("../../models/Employee");
const Department = require("../../models/HR_Models/Departments");
const JobPosting = require("../../models/HR_Models/JobPosting");
const Candidate = require("../../models/HR_Models/Candidates");
const EmployeeTask = require("../../models/HR_Models/EmployeeTask");
const OvertimeReport = require("../../models/HR_Models/OvertimeReport");
const EmployeeDocument = require("../../models/HR_Models/EmployeeDocument");
const Policy = require("../../models/HR_Models/Policy");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const { Payroll } = require("../../models/HR_Models/Payroll");
const {
  LeaveApplication, LeaveBalance, CompanyHoliday, RegularizationRequest,
} = require("../../models/HR_Models/LeaveManagement");
const { CAPABILITIES: CAP } = require("../access/hrCapabilities");
const { compileIntent } = require("./storeCommandIntent");
const W = require("./commandSearch/words");
const cards = require("./commandSearch/cards");
const { sanitizeAssistantLinks } = require("./assistantLinks");
const C = require("./hrCommandContract");
const { closestMatches, approximateNote } = require("./commandSearch/closest");

const { text, exactRx, escapeRx, longestName, strip } = W;
const { date, number, words } = cards.FORMAT;
const MAX_QUERY = 200;
const MAX_ROWS = 12;
const DEFAULT_LIST = 10;
const MAX_PEOPLE = 5;
const MAX_RANGE_DAYS = 62;
const RESULT_KIND = Object.freeze({ RECORD: "record", FACT: "fact" });
const BIO_RE = /\b([A-Z]{1,3}\d{2,6}|E\d{3,4})\b/i;
const prefixRx = (v) => new RegExp(`^${escapeRx(String(v).trim())}`, "i");
const containsRx = (v) => new RegExp(escapeRx(String(v).trim()), "i");
const cap1 = (s) => String(s || "").replace(/^./, (c) => c.toUpperCase());
const plural = (n, one, many = W.plural(one)) => (n === 1 ? one : many);
const DAY = 86400000;
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;

/* ── READING THE WORDS ─────────────────────────────────────────────────── */

const OPERATIONS = Object.freeze({
  count: /\b(how many|number of|count of|count|headcount|head count|total number of|strength)\b/i,
  latest: /\b(latest|newest|most recent|recent|last \d+|last (?:one|two|three|four|five|six|seven|eight|nine|ten))\b/i,
  next: /\b(next|upcoming|coming)\b(?!\s+(?:week|month))/i,
  balance: /\bbalance\b/i,
  joined: /\b(joined|joining|joiners?|joinees?|new joiners?|new joinees?)\b/i,
  applied: /\b(applied|application date)\b/i,
  published: /\b(published|posted)\b/i,
  closing: /\b(closing|closes|last date|apply by|deadline)\b/i,
  issued: /\b(issued|generated|released)\b/i,
  requested: /\b(requested)\b/i,
});
const MANAGER_RX = /\b(?:reports? to|reporting to|team of|reportees of|reportees of|managed by|under)\s+(.+)$/i;
const TEAM_RX = /^(.+?)\s+team$/i;
const FILLER = /\b(show|list|find|open|give|get|me|all|the|any|our|my|what|whats|which|whose|who|whom|is|are|was|were|there|do|does|did|we|have|has|had|of|for|from|by|with|to|in|on|at|during|dated|please|named|called|status|records?|details?|info|about|currently|now|so far|till date|today's|been|be|will|how|much|people|anyone|anybody|someone|everyone|each|per)\b/gi;
/* Families that only QUALIFY another ("employees in Cutting DEPARTMENT",
   "candidates for the tailor JOB"), when another family is named too. */
const QUALIFIERS = new Set(["department", "designation", "job"]);

function familyFrom(lower) {
  const all = C.FAMILIES.map((entry) => longestName(lower, [entry])).filter(Boolean);
  if (!all.length) return null;
  const main = all.filter((m) => !QUALIFIERS.has(m.entry.id));
  const pool = main.length ? main : all;
  return pool.reduce((best, m) => (!best || m.name.length > best.name.length ? m : best), null);
}

/* What may narrow each family — matched on the text, then taken out of it. */
const FILTERS = Object.freeze({
  employee: { status: C.EMPLOYEE_STATUSES, employment: C.EMPLOYMENT_TYPES },
  leave: { status: C.DECISION_STATUSES, leaveType: C.LEAVE_TYPES },
  correction: { status: C.DECISION_STATUSES, correctionType: C.CORRECTION_TYPES },
  overtime: { status: C.OVERTIME_STATUSES },
  job: { status: C.JOB_STATUSES },
  candidate: { stage: C.CANDIDATE_STAGES },
  interview: { status: C.INTERVIEW_STATUSES },
  document: { docStatus: C.DOCUMENT_STATUSES, docType: C.DOCUMENT_TYPES },
  payroll: { status: C.PAYROLL_STATUSES },
  /* "CL balance of Ravi" — every balance is shown; the word is not a name. */
  leave_balance: { leaveType: C.LEAVE_TYPES },
});

function parse(query, now) {
  const raw = text(query, MAX_QUERY);
  /* "Ravi's leaves" → "ravi leaves" */
  let lower = raw.toLowerCase().replace(/[’']s\b/g, "").replace(/[’']/g, "");
  const grammar = compileIntent(raw);

  /* HR's year is the calendar year (leave balances, holidays); the books'
     is the financial year, and the shared reader keeps that meaning. */
  const ist = new Date(now + W.IST);
  const yr = ist.getUTCFullYear();
  let window = null;
  let m = lower.match(/\b(this|current) year\b/);
  if (m) window = { from: `${yr}-01-01`, to: `${yr}-12-31`, source: m[0] };
  else if ((m = lower.match(/\blast year\b/))) window = { from: `${yr - 1}-01-01`, to: `${yr - 1}-12-31`, source: m[0] };
  else window = W.periodFrom(lower, now) || grammar.dateRange || null;
  if (window?.source) lower = lower.replace(window.source.toLowerCase(), " ");

  const ops = Object.fromEntries(Object.entries(OPERATIONS).map(([k, rx]) => [k, rx.test(lower)]));
  let fam = familyFrom(lower);
  let bucket = longestName(lower, C.ATTENDANCE_BUCKETS);
  /* ── WHO WAS ABSENT IS ATTENDANCE ──────────────────────────────────────
       An attendance word with no family, or with "employees", is a question
       about a day's attendance. "on leave" beats the leave REQUESTS it
       contains a word of, and "on holiday" the holidays. */
  const bucketWins = bucket && (!fam
    || ["employee", "attendance"].includes(fam.entry.id)
    || (["leave", "holiday"].includes(fam.entry.id) && bucket.name.includes(fam.name)));
  if (!bucketWins) bucket = null;
  let family = bucketWins ? C.familyById("attendance") : fam?.entry || null;
  /* "balance of Ravi" — in HR, a balance is a leave balance. So is "how much
     leave does Ravi have left": the way a spoken Hindi or Odia question
     ("kitni chhutti bachi hai") comes back from translation. */
  const leftWords = /\b(left|remaining|available|still have)\b/.test(lower);
  if ((ops.balance || (leftWords && family?.id === "leave")) && (!family || family.id === "leave")) {
    family = C.familyById("leave_balance");
  }

  /* Filters for the family, from what was said. */
  const filters = {};
  for (const [key, list] of Object.entries(FILTERS[family?.id] || {})) {
    const hit = longestName(lower, list);
    if (hit) { filters[key] = hit.entry; lower = ` ${strip(` ${lower} `, hit.name)} `; }
  }

  /* What is left names a person, a department, a record. */
  let rest = ` ${lower} `;
  if (bucket) rest = strip(rest, bucket.name);
  if (fam) rest = strip(rest, fam.name);
  /* A qualifier family's own word goes too ("cutting DEPARTMENT"). */
  for (const id of QUALIFIERS) {
    const q = longestName(rest, [C.familyById(id)]);
    if (q && family?.id !== id) rest = strip(rest, q.name);
  }
  if (family?.id === "leave_balance") rest = rest.replace(/\b(leaves?|vacations?|left|remaining|available|still)\b/g, " ");
  for (const rx of Object.values(OPERATIONS)) rest = rest.replace(new RegExp(rx.source, "gi"), " ");
  rest = rest.replace(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty)\b(?=\s|$)/gi, (n) => (grammar.limit ? " " : n));
  rest = rest.replace(/\s+/g, " ").trim();

  /* "team of Ravi", "reports to Ravi", "Ravi team" */
  let manager = null;
  if ((m = rest.match(MANAGER_RX))) { manager = m[1].replace(FILLER, " ").replace(/\s+/g, " ").trim(); rest = rest.slice(0, m.index); }
  else if ((m = rest.match(TEAM_RX)) && (!family || family.id === "employee")) { manager = m[1].replace(FILLER, " ").replace(/\s+/g, " ").trim(); rest = ""; }
  rest = rest.replace(FILLER, " ").replace(/\s+/g, " ").trim();
  if (manager && !family) family = C.familyById("employee");

  return { raw, family, bucket: bucket?.entry || null, filters, window, ops, limit: grammar.limit || null, rest: rest || null, manager: manager || null };
}

/* ── READERS ───────────────────────────────────────────────────────────── */

const ACTIVE = { isActive: { $ne: false }, status: { $ne: "inactive" } };
const INACTIVE = { $or: [{ isActive: false }, { status: "inactive" }] };

/** People a phrase names: an employee code, an identity id, a work email, or every word a name starts with. */
async function peopleNamed(term, { limit = MAX_PEOPLE + 1 } = {}) {
  const t = text(term, 120);
  if (!t) return [];
  const code = (t.match(BIO_RE) || [])[1];
  if (code && t.replace(code, "").trim() === "") {
    const byCode = await Employee.find({ $or: [{ biometricId: exactRx(code) }, { identityId: exactRx(code) }] }).select(C.PROJECTIONS.employee).limit(2).lean();
    if (byCode.length) return byCode;
  }
  if (/@/.test(t)) return Employee.find({ email: exactRx(t) }).select(C.PROJECTIONS.employee).limit(2).lean();
  const tokens = t.toLowerCase().split(/\s+/).filter((w) => w.length >= 2).slice(0, 4);
  if (!tokens.length) return [];
  const and = tokens.map((tok) => ({ $or: ["firstName", "middleName", "lastName", "nickName"].map((f) => ({ [f]: prefixRx(tok) })) }));
  const found = await Employee.find({ $and: and }).select(C.PROJECTIONS.employee).limit(limit * 3).lean();
  /* The active first; somebody who left is still findable by name. */
  return found.sort((a, b) => Number(isInactive(a)) - Number(isInactive(b))).slice(0, limit);
}
const isInactive = (e) => e?.isActive === false || e?.status === "inactive";

async function departmentNamed(term) {
  const t = text(term, 120).replace(/\b(dept|department)\b/gi, " ").trim();
  if (!t) return null;
  return Department.findOne({ name: exactRx(t) }).select(C.PROJECTIONS.department).lean();
}

async function designationNamed(term) {
  const t = text(term, 120);
  if (!t) return null;
  const forms = [t, t.replace(/ies$/i, "y"), t.replace(/e?s$/i, "")].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const form of forms) {
    // eslint-disable-next-line no-await-in-loop
    const one = await Employee.findOne({ ...ACTIVE, designation: exactRx(form) }).select("designation").lean();
    if (one) return one.designation;
  }
  return null;
}

/** The people a question is about — a name, a code, a department, or nobody named. */
async function whoIsMeant(q) {
  if (!q.rest) return { kind: "none" };
  const dept = await departmentNamed(q.rest);
  if (dept) return { kind: "department", department: dept };
  const people = await peopleNamed(q.rest);
  if (!people.length) return { kind: "nobody", term: q.rest };
  if (people.length > MAX_PEOPLE) return { kind: "too_many", term: q.rest };
  return { kind: "people", people };
}

/* ── ROWS — the shared shapes ──────────────────────────────────────────── */

const link = (href, label) => sanitizeAssistantLinks([{ href, label }])[0]?.href || null;
const fact = (id, sentence, extra = {}) => ({ id, kind: RESULT_KIND.FACT, title: text(sentence), value: null, href: null, metadata: { single: false }, ...extra });
const answered = (label, results, note = null) => ({ state: "answered", note, groups: [{ label, results: results.slice(0, MAX_ROWS) }] });
const nothing = (note) => ({ state: "no_match", groups: [], note });
const unsure = (note) => ({ state: "needs_clarification", groups: [], note });
const refused = (family) => ({ state: "unauthorised", groups: [], note: `Your HR role does not include ${W.plural(family.label)}.` });

function employeeRow(e, { single = true, concept = null, value = null } = {}) {
  const name = C.fullName(e) || e.biometricId || "Employee";
  return {
    id: `record:employee:${e._id}`,
    kind: RESULT_KIND.RECORD,
    title: text(name, 200),
    subtitle: text([e.biometricId, e.department, e.designation || e.jobTitle, isInactive(e) ? "Inactive" : null].filter(Boolean).join(" · "), 200) || null,
    value,
    href: link(C.HR_RECORD_ROUTES.employee(e._id), name),
    entityType: "employee",
    metadata: { single, concept, record: { entity: "employee", recordId: String(e._id) } },
  };
}
function departmentRow(d, { single = true } = {}) {
  return {
    id: `record:department:${d._id}`,
    kind: RESULT_KIND.RECORD,
    title: text(d.name, 200),
    subtitle: text([words(d.status), d.primaryManager?.managerName && `Head: ${d.primaryManager.managerName}`].filter(Boolean).join(" · "), 200) || null,
    href: link(C.HR_RECORD_ROUTES.department(d._id), d.name),
    entityType: "department",
    metadata: { single, record: { entity: "department", recordId: String(d._id) } },
  };
}
function jobRow(j, { single = true } = {}) {
  return {
    id: `record:job:${j._id}`,
    kind: RESULT_KIND.RECORD,
    title: text(j.jobTitle, 200),
    subtitle: text([words(j.status), j.jobLocation, words(j.jobType), j.lastDate && `apply by ${date(j.lastDate)}`].filter(Boolean).join(" · "), 200) || null,
    href: link(C.HR_RECORD_ROUTES.job(j._id), j.jobTitle),
    entityType: "job",
    metadata: { single, record: { entity: "job", recordId: String(j._id) } },
  };
}
function candidateRow(c, { single = true } = {}) {
  return {
    id: `record:candidate:${c._id}`,
    kind: RESULT_KIND.RECORD,
    title: text(c.name, 200),
    subtitle: text([c.jobTitle, words(c.stage), c.appliedDate && `applied ${date(c.appliedDate)}`].filter(Boolean).join(" · "), 200) || null,
    /* A candidate has no page of their own; they live on their opening's. */
    href: c.jobPostingId ? link(C.HR_RECORD_ROUTES.job(c.jobPostingId), c.name) : null,
    entityType: "candidate",
    metadata: { single, record: { entity: "candidate", recordId: String(c._id) } },
  };
}
const listRow = (id, title, subtitle, href, entityType) => ({
  id, kind: RESULT_KIND.RECORD, title: text(title, 200), subtitle: text(subtitle, 200) || null,
  href: link(href, title), entityType, metadata: { single: false },
});
const dayText = (iso) => date(`${iso}T06:00:00Z`) || iso;
const spanText = (from, to) => (from === to ? dayText(from) : `${dayText(from)} – ${dayText(to)}`);
const leaveTypeLabel = (t) => C.LEAVE_TYPES.find((x) => x.type === t)?.label || words(t);
const leaveRow = (l) => listRow(`leave:${l._id}`, `${l.employeeName || l.biometricId} — ${leaveTypeLabel(l.leaveType)}`,
  [spanText(l.fromDate, l.toDate), number(l.totalDays) && `${number(l.totalDays)} ${plural(Number(l.totalDays), "day")}`, words(l.status)].filter(Boolean).join(" · "),
  C.HR_LIST_ROUTES.leave, "leave");
const correctionRow = (r) => listRow(`correction:${r._id}`, `${r.employeeName || r.biometricId} — ${words(r.type) || "correction"}`,
  [dayText(r.dateStr), r.requestedStatus && `asks for ${r.requestedStatus}`, words(r.status)].filter(Boolean).join(" · "),
  C.HR_LIST_ROUTES.correction, "correction");
const overtimeRow = (o) => listRow(`overtime:${o._id}`, `${o.employeeName || o.biometricId} — overtime`,
  [dayText(o.dateStr), o.actualOutTime && `out ${o.actualOutTime}`, number(o.stayOverMins) && `${number(o.stayOverMins)} min over`, words(o.status)].filter(Boolean).join(" · "),
  C.HR_LIST_ROUTES.overtime, "overtime");
const documentRow = (d) => listRow(`document:${d._id}`, `${C.docLabel(d)} — ${d.employeeName || d.biometricId}`,
  [C.docState(d), d.letterMeta?.referenceNo && `Ref ${d.letterMeta.referenceNo}`, date(d.releasedAt || d.generatedAt || d.requestedAt || d.createdAt)].filter(Boolean).join(" · "),
  d.requestStatus === "requested" ? C.HR_LIST_ROUTES.document_request : C.HR_LIST_ROUTES.document, "document");
const holidayRow = (h) => listRow(`holiday:${h._id}`, h.name, [dayText(h.date), words(h.type) && `${words(h.type)} holiday`].filter(Boolean).join(" · "), C.HR_LIST_ROUTES.holiday, "holiday");
const payrollRow = (p) => listRow(`payroll:${p._id}`, `${p.payPeriod || `${p.month}/${p.year}`} payroll`,
  [words(p.status), number(p.totalEmployees) && `${number(p.totalEmployees)} ${plural(Number(p.totalEmployees), "employee")}`].filter(Boolean).join(" · "),
  C.HR_LIST_ROUTES.payroll, "payroll");
const policyRow = (p) => listRow(`policy:${p._id}`, p.name,
  [number(p.points) && `${p.bleachType === "debit" ? "−" : "+"}${number(p.points)} points`, p.scope === "department" ? (p.departmentNames?.join(", ") || p.departmentName) : "everyone", p.isActive === false ? "Inactive" : null].filter(Boolean).join(" · "),
  C.HR_LIST_ROUTES.policy, "policy");
const interviewRow = (t) => listRow(`interview:${t._id}`, t.title || "Interview",
  [date(t.scheduledDate), t.scheduledTime, words(t.interviewStage), words(t.status)].filter(Boolean).join(" · "),
  t.jobPostingId ? C.HR_RECORD_ROUTES.job(t.jobPostingId) : C.HR_LIST_ROUTES.recruitment, "interview");

async function cardFor({ entity, recordId }, capabilities) {
  const id = String(recordId || "");
  if (!/^[a-f\d]{24}$/i.test(id)) return null;
  if (entity === "employee" && capabilities.has(CAP.PEOPLE_READ_DIRECTORY)) {
    const e = await Employee.findById(id).select(C.PROJECTIONS.employee).lean();
    return e ? cards.buildCard(C.CARDS.employee, e) : null;
  }
  if (entity === "department" && capabilities.has(CAP.PEOPLE_READ_DIRECTORY)) {
    const d = await Department.findById(id).select(C.PROJECTIONS.department).lean();
    if (!d) return null;
    const employees = await Employee.countDocuments({ ...ACTIVE, $or: [{ departmentId: d._id }, { department: exactRx(d.name) }] });
    return cards.buildCard(C.CARDS.department, d, { employees });
  }
  if (entity === "job" && capabilities.has(CAP.RECRUITMENT_READ)) {
    const j = await JobPosting.findById(id).select(C.PROJECTIONS.job).lean();
    if (!j) return null;
    const candidates = await Candidate.countDocuments({ jobPostingId: j._id });
    return cards.buildCard(C.CARDS.job, j, { candidates });
  }
  if (entity === "candidate" && capabilities.has(CAP.RECRUITMENT_READ)) {
    const c = await Candidate.findById(id).select(C.PROJECTIONS.candidate).lean();
    return c ? cards.buildCard(C.CARDS.candidate, c) : null;
  }
  return null;
}

/* ── THE QUESTIONS ─────────────────────────────────────────────────────── */

/** "N things[ qualifier]" + the rows, or the count alone. */
function listAnswer(label, { total, rows, noun, qualifier = "", op, limit }) {
  const what = `${plural(total, noun)}${qualifier ? ` ${qualifier}` : ""}`;
  if (op === "count") return answered(label, [fact(`count:${noun}`, `There ${total === 1 ? "is" : "are"} ${number(total)} ${what}.`)]);
  if (!total) return nothing(`There are no ${W.plural(noun)}${qualifier ? ` ${qualifier}` : ""}.`);
  const shown = rows.slice(0, limit);
  const head = total > shown.length
    ? `${number(total)} ${what} — the first ${shown.length} below.`
    : `${number(total)} ${what}.`;
  return answered(label, [fact(`head:${noun}`, head), ...shown.map((r, i) => (shown.length === 1 && i === 0 ? { ...r, metadata: { ...r.metadata, single: true } } : r))]);
}
const listLimit = (q) => Math.min(MAX_ROWS - 1, q.limit || (q.ops.latest ? 5 : DEFAULT_LIST));
const statusIn = (entry) => (entry ? { status: { $in: entry.status } } : {});
const strRange = (field, w) => (w ? { [field]: { $gte: w.from, $lte: w.to } } : {});
const dateRange = (field, w) => (w ? { [field]: { $gte: W.dayStart(w.from), $lte: W.dayEnd(w.to) } } : {});
function windowWords(w) {
  if (!w) return "";
  const src = String(w.source || "").toLowerCase();
  if (/^(today|yesterday|tomorrow|this |last |next |current )/.test(src)) return src;
  return w.from === w.to ? `on ${dayText(w.from)}` : `in ${w.source || spanText(w.from, w.to)}`;
}

/** Narrow by the people named — or say nobody is called that. Never drops the words. */
async function peopleScope(q, field = "employeeId") {
  const who = await whoIsMeant(q);
  if (who.kind === "nobody") return { stop: nothing(`No employee is called "${text(who.term, 60)}".`) };
  if (who.kind === "too_many") return { stop: unsure(`More than ${MAX_PEOPLE} people match "${text(who.term, 60)}" — add the surname or the employee ID.`) };
  if (who.kind === "department") {
    const ids = await Employee.find({ $or: [{ departmentId: who.department._id }, { department: exactRx(who.department.name) }] }).distinct("_id");
    return { filter: { [field]: { $in: ids } }, words: `in ${who.department.name}` };
  }
  if (who.kind === "people") {
    return {
      filter: { [field]: { $in: who.people.map((p) => p._id) } },
      words: `of ${who.people.map((p) => C.fullName(p)).join(" / ")}`,
      people: who.people,
    };
  }
  return { filter: {}, words: "" };
}

async function employees(q) {
  /* A date range on people must say which date. Joining is the only one. */
  if (q.window && !q.ops.joined) return unsure(`Say which date — for example "employees who joined ${q.window.source || "this month"}".`);
  const filter = {};
  const parts = [];
  if (q.filters.status) Object.assign(filter, q.filters.status.status === "inactive" ? INACTIVE : ACTIVE);
  else Object.assign(filter, ACTIVE);
  const statusWord = q.filters.status?.label || "active";
  if (q.filters.employment) filter.employmentType = q.filters.employment.type;
  if (q.window) { Object.assign(filter, dateRange("dateOfJoining", q.window)); parts.push(`who joined ${windowWords(q.window)}`); }
  if (q.manager) {
    const bosses = await peopleNamed(q.manager);
    if (!bosses.length) return nothing(`No employee is called "${text(q.manager, 60)}".`);
    if (bosses.length > MAX_PEOPLE) return unsure(`More than ${MAX_PEOPLE} people match "${text(q.manager, 60)}" — add the surname or the employee ID.`);
    filter["primaryManager.managerId"] = { $in: bosses.map((b) => b._id) };
    parts.push(`reporting to ${bosses.map((b) => C.fullName(b)).join(" / ")}`);
  }
  if (q.rest) {
    const dept = await departmentNamed(q.rest);
    const designation = dept ? null : await designationNamed(q.rest);
    if (dept) { filter.$and = [{ $or: [{ departmentId: dept._id }, { department: exactRx(dept.name) }] }]; parts.unshift(`in ${dept.name}`); }
    else if (designation) { filter.designation = exactRx(designation); parts.unshift(`who are ${designation}`); }
    else {
      /* The words name people: the employees called that, within the filters. */
      const people = await peopleNamed(q.rest, { limit: MAX_ROWS });
      if (!people.length) return nothing(`No employee, department or designation is called "${text(q.rest, 60)}".`);
      filter._id = { $in: people.map((p) => p._id) };
      parts.push(`called "${text(q.rest, 40)}"`);
    }
  }
  const kind = q.filters.employment ? (q.filters.employment.type === "intern" ? "intern" : `${q.filters.employment.label} employee`) : "employee";
  const noun = `${statusWord} ${kind}`;
  const [total, rows] = await Promise.all([
    Employee.countDocuments(filter),
    q.ops.count ? [] : Employee.find(filter).select(C.PROJECTIONS.employee)
      .sort(q.window || q.ops.latest ? { dateOfJoining: -1 } : { firstName: 1, lastName: 1 }).limit(listLimit(q)).lean(),
  ]);
  return listAnswer("People", { total, rows: rows.map((e) => employeeRow(e, { single: false })), noun, qualifier: parts.join(" "), op: q.ops.count ? "count" : null, limit: listLimit(q) });
}

async function departments(q) {
  if (q.window) return unsure("Departments have no date to filter by.");
  if (q.rest) {
    const exact = await departmentNamed(q.rest);
    const found = exact ? [exact] : await Department.find({ name: containsRx(q.rest) }).select(C.PROJECTIONS.department).limit(6).lean();
    if (found.length) return answered("Departments", found.map((d) => departmentRow(d, { single: found.length === 1 })));
    /* "Ravi's department" — the person's own record says it. */
    const people = await peopleNamed(q.rest);
    if (people.length && people.length <= MAX_PEOPLE) return answered("People", people.map((e) => employeeRow(e, { single: people.length === 1, concept: "department" })));
    return nothing(`No department is called "${text(q.rest, 60)}".`);
  }
  const filter = { status: { $ne: "inactive" } };
  const [total, rows] = await Promise.all([Department.countDocuments(filter), Department.find(filter).select(C.PROJECTIONS.department).sort({ name: 1 }).limit(listLimit(q)).lean()]);
  return listAnswer("Departments", { total, rows: rows.map((d) => departmentRow(d, { single: false })), noun: "department", op: q.ops.count ? "count" : null, limit: listLimit(q) });
}

async function designations(q) {
  if (q.window) return unsure("Designations have no date to filter by.");
  const filter = { status: { $ne: "inactive" } };
  let where = "";
  if (q.rest) {
    const dept = await departmentNamed(q.rest);
    if (!dept) {
      const people = await peopleNamed(q.rest);
      if (people.length && people.length <= MAX_PEOPLE) return answered("People", people.map((e) => employeeRow(e, { single: people.length === 1, concept: "designation" })));
      return nothing(`No department is called "${text(q.rest, 60)}".`);
    }
    filter._id = dept._id;
    where = `in ${dept.name}`;
  }
  const depts = await Department.find(filter).select("_id name designations.name designations.isActive").sort({ name: 1 }).lean();
  const rows = depts.flatMap((d) => (d.designations || []).filter((x) => x.isActive !== false && x.name)
    .map((x) => listRow(`designation:${d._id}:${x.name}`, x.name, d.name, C.HR_RECORD_ROUTES.department(d._id), "designation")));
  return listAnswer("Designations", { total: rows.length, rows, noun: "designation", qualifier: where, op: q.ops.count ? "count" : null, limit: MAX_ROWS - 1 });
}

/** One person's day, or their days over a range. */
async function personAttendance(q, people) {
  const w = q.window || { from: W.todayIso(q.now), to: W.todayIso(q.now), source: "today" };
  if (w.from > W.todayIso(q.now)) return nothing(`${spanText(w.from, w.to)} has not happened yet.`);
  if (daysBetween(w.from, w.to) > MAX_RANGE_DAYS) return unsure(`Ask about ${MAX_RANGE_DAYS} days or fewer — for example "this month".`);
  const ids = people.map((p) => p._id);
  const rows = await DailyAttendance.aggregate([
    { $match: { dateStr: { $gte: w.from, $lte: w.to } } },
    { $unwind: "$employees" },
    { $match: { "employees.employeeDbId": { $in: ids } } },
    { $project: { _id: 0, dateStr: 1, id: "$employees.employeeDbId", hrFinalStatus: "$employees.hrFinalStatus", systemPrediction: "$employees.systemPrediction", inTime: "$employees.inTime", finalOut: "$employees.finalOut" } },
  ]);
  const single = people.length === 1;
  const results = people.map((p) => {
    const mine = rows.filter((r) => String(r.id) === String(p._id));
    const name = C.fullName(p);
    if (!mine.length) return { ...employeeRow(p, { concept: "attendance", single }), title: text(`No attendance is recorded for ${name} ${windowWords(w)}.`), empty: true };
    if (w.from === w.to) {
      const r = mine[0];
      const code = C.dayStatus(r);
      const times = [r.inTime && `in ${clock(r.inTime)}`, r.finalOut && `out ${clock(r.finalOut)}`].filter(Boolean).join(", ");
      return { ...employeeRow(p, { concept: "attendance", single }), title: text(`${name} was ${C.STATUS_WORD[code] || code || "not marked"} ${windowWords(w)}${times ? ` (${times})` : ""}.`) };
    }
    const tally = {};
    for (const r of mine) {
      const code = C.dayStatus(r);
      const bucket = C.ATTENDANCE_BUCKETS.find((b) => b.id !== "late" && b.codes.includes(code));
      const key = bucket ? bucket.id : "other";
      tally[key] = (tally[key] || 0) + 1;
    }
    const late = mine.filter((r) => C.dayStatus(r) === "P*").length;
    const parts = C.ATTENDANCE_BUCKETS.filter((b) => b.id !== "late" && tally[b.id])
      .map((b) => `${tally[b.id]} ${b.id === "present" ? "present" : b.label}${b.id === "present" && late ? ` (${late} late)` : ""}`);
    if (tally.other) parts.push(`${tally.other} other`);
    return { ...employeeRow(p, { concept: "attendance", single }), title: text(`${name}, ${w.source || spanText(w.from, w.to)}: ${parts.join(", ")} — ${mine.length} ${plural(mine.length, "day")} recorded.`) };
  });
  if (results.every((r) => r.empty)) return nothing(`No attendance is recorded for ${people.map(C.fullName).join(" / ")} ${windowWords(w)}.`);
  return answered("Attendance", results.map(({ empty, ...r }) => r));
}
const clock = (d) => new Date(d).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });

async function attendance(q) {
  const who = q.rest || q.manager ? await whoIsMeant({ rest: q.rest || q.manager }) : { kind: "none" };
  if (who.kind === "nobody") return nothing(`No employee or department is called "${text(who.term, 60)}".`);
  if (who.kind === "too_many") return unsure(`More than ${MAX_PEOPLE} people match "${text(who.term, 60)}" — add the surname or the employee ID.`);
  if (who.kind === "people") return personAttendance(q, who.people);

  const w = q.window || { from: W.todayIso(q.now), to: W.todayIso(q.now), source: "today" };
  if (w.from !== w.to) return unsure(`Pick one day — for example "${q.bucket ? q.bucket.label : "attendance"} yesterday" or "on 3 Oct".`);
  if (w.from > W.todayIso(q.now)) return nothing(`${dayText(w.from)} has not happened yet.`);
  const doc = await DailyAttendance.findOne({ dateStr: w.from })
    .select("dateStr employees.employeeDbId employees.biometricId employees.employeeName employees.department employees.designation employees.hrFinalStatus employees.systemPrediction").lean();
  if (!doc) return nothing(`No attendance has been recorded for ${dayText(w.from)} yet.`);
  let staff = doc.employees || [];
  let where = "";
  if (who.kind === "department") {
    staff = staff.filter((e) => String(e.department || "").toLowerCase() === who.department.name.toLowerCase());
    where = ` in ${who.department.name}`;
  }
  if (!q.bucket) {
    /* The day at a glance, in the page's own buckets. */
    const count = (b) => staff.filter((e) => b.codes.includes(C.dayStatus(e))).length;
    const parts = C.ATTENDANCE_BUCKETS.map((b) => [b, count(b)]).filter(([, n]) => n)
      .map(([b, n]) => `${number(n)} ${b.label}`);
    return answered("Attendance", [{ ...fact(`attendance:${w.from}`, `${dayText(w.from)}${where}: ${parts.join(", ") || "nobody marked"} — of ${number(staff.length)} on the roll.`), href: link(C.HR_LIST_ROUTES.attendance, "Daily attendance") }]);
  }
  const hits = staff.filter((e) => q.bucket.codes.includes(C.dayStatus(e)));
  const verb = w.from === W.todayIso(q.now) ? "are" : "were";
  const head = `${number(hits.length)} ${plural(hits.length, "person", "people")}${where} ${hits.length === 1 ? (verb === "are" ? "is" : "was") : verb} ${q.bucket.label} on ${dayText(w.from)}.`;
  if (q.ops.count || !hits.length) return answered("Attendance", [fact(`attendance:${q.bucket.id}`, head)]);
  const rows = hits.slice(0, MAX_ROWS - 1).map((e) => listRow(`attendance:${w.from}:${e.biometricId}`, e.employeeName || e.biometricId,
    [e.biometricId, e.department !== "—" && e.department, C.STATUS_WORD[C.dayStatus(e)]].filter(Boolean).join(" · "),
    e.employeeDbId ? C.HR_RECORD_ROUTES.employee(e.employeeDbId) : C.HR_LIST_ROUTES.attendance, "employee"));
  return answered("Attendance", [fact(`attendance:${q.bucket.id}`, hits.length > rows.length ? `${head} The first ${rows.length} below.` : head), ...rows]);
}

async function leaveBalance(q) {
  if (!q.rest) return unsure("Say whose leave balance — a name or an employee ID.");
  const who = await whoIsMeant(q);
  if (who.kind === "nobody") return nothing(`No employee is called "${text(who.term, 60)}".`);
  if (who.kind === "too_many") return unsure(`More than ${MAX_PEOPLE} people match "${text(who.term, 60)}" — add the surname or the employee ID.`);
  if (who.kind !== "people") return unsure("Say whose leave balance — one person, by name or employee ID.");
  const year = q.window && q.window.from.slice(0, 4) === q.window.to.slice(0, 4) ? Number(q.window.from.slice(0, 4)) : new Date(q.now + W.IST).getUTCFullYear();
  const balances = await LeaveBalance.find({ employeeId: { $in: who.people.map((p) => p._id) }, year }).select(C.PROJECTIONS.leave_balance).lean();
  const rows = who.people.map((p) => {
    const b = balances.find((x) => String(x.employeeId) === String(p._id));
    const name = C.fullName(p);
    if (!b) return { ...employeeRow(p, { concept: "leave_balance", single: who.people.length === 1 }), title: `No leave balance is recorded for ${name} in ${year}.` };
    const left = (k) => Math.max(0, Number(b.entitlement?.[k] || 0) - Number(b.consumed?.[k] || 0));
    const parts = ["CL", "SL", "PL"].map((k) => `${k} ${number(left(k))} of ${number(b.entitlement?.[k] || 0)} left`);
    return { ...employeeRow(p, { concept: "leave_balance", single: who.people.length === 1 }), title: text(`${name}, ${year}: ${parts.join(", ")}.`) };
  });
  return answered("Leave balance", rows);
}

/** Leave requests, corrections, overtime — the decision families. */
async function decisions(q, { Model, noun, label, dateField, rangeKind, typeKey, typeField, typeNoun, row, sort }) {
  const scope = await peopleScope(q);
  if (scope.stop) return scope.stop;
  const filter = { ...scope.filter, ...statusIn(q.filters.status) };
  if (q.filters[typeKey]) filter[typeField] = q.filters[typeKey].type;
  if (q.window) {
    if (rangeKind === "overlap") Object.assign(filter, { fromDate: { $lte: q.window.to }, toDate: { $gte: q.window.from } });
    else Object.assign(filter, strRange(dateField, q.window));
  }
  const what = q.filters[typeKey] ? typeNoun(q.filters[typeKey]) : noun;
  const qualifier = [scope.words, windowWords(q.window)].filter(Boolean).join(" ");
  const [total, rows] = await Promise.all([
    Model.countDocuments(filter),
    q.ops.count ? [] : Model.find(filter).select(C.PROJECTIONS[label]).sort(sort).limit(listLimit(q)).lean(),
  ]);
  return listAnswer(cap1(W.plural(noun)), { total, rows: rows.map(row), noun: `${q.filters.status ? `${q.filters.status.label} ` : ""}${what}`, qualifier, op: q.ops.count ? "count" : null, limit: listLimit(q) });
}

async function holidays(q) {
  const today = W.todayIso(q.now);
  const filter = {};
  if (q.rest) filter.name = containsRx(q.rest);
  let qualifier = q.rest ? `called "${text(q.rest, 40)}"` : "";
  if (q.window) { Object.assign(filter, strRange("date", q.window)); qualifier = [qualifier, windowWords(q.window)].filter(Boolean).join(" "); }
  else if (!q.rest || q.ops.next) { filter.date = { $gte: today }; qualifier = [qualifier, "coming up"].filter(Boolean).join(" "); }
  const limit = q.ops.next && !q.limit ? 1 : listLimit(q);
  const [total, rows] = await Promise.all([
    CompanyHoliday.countDocuments(filter),
    CompanyHoliday.find(filter).select(C.PROJECTIONS.holiday).sort({ date: 1 }).limit(limit).lean(),
  ]);
  if (q.ops.next && !q.ops.count && rows.length) {
    const h = rows[0];
    return answered("Holidays", [{ ...holidayRow(h), title: text(`The next holiday is ${h.name}, on ${dayText(h.date)}.`) }]);
  }
  return listAnswer("Holidays", { total, rows: rows.map(holidayRow), noun: "holiday", qualifier, op: q.ops.count ? "count" : null, limit });
}

async function jobs(q) {
  const filter = { ...statusIn(q.filters.status) };
  let when = "";
  if (q.window) {
    if (q.ops.published) { Object.assign(filter, dateRange("publishedAt", q.window)); when = `published ${windowWords(q.window)}`; }
    else if (q.ops.closing) { Object.assign(filter, dateRange("lastDate", q.window)); when = `closing ${windowWords(q.window)}`; }
    else return unsure(`Say which date — "jobs published ${q.window.source || "this month"}" or "jobs closing ${q.window.source || "this month"}".`);
  }
  if (q.rest) filter.jobTitle = containsRx(q.rest);
  const noun = `${q.filters.status ? `${q.filters.status.label} ` : ""}job opening`;
  const qualifier = [q.rest && `for "${text(q.rest, 40)}"`, when].filter(Boolean).join(" ");
  const [total, rows] = await Promise.all([
    JobPosting.countDocuments(filter),
    q.ops.count ? [] : JobPosting.find(filter).select(C.PROJECTIONS.job).sort({ publishedAt: -1, createdAt: -1 }).limit(listLimit(q)).lean(),
  ]);
  return listAnswer("Recruitment", { total, rows: rows.map((j) => jobRow(j, { single: false })), noun, qualifier, op: q.ops.count ? "count" : null, limit: listLimit(q) });
}

async function candidates(q) {
  const filter = {};
  if (q.filters.stage) filter.stage = q.filters.stage.stage;
  const parts = [];
  if (q.window) {
    if (!q.ops.applied) return unsure(`Say which date — for example "candidates who applied ${q.window.source || "this month"}".`);
    Object.assign(filter, dateRange("appliedDate", q.window));
    parts.push(`who applied ${windowWords(q.window)}`);
  }
  if (q.rest) {
    /* "candidates for tailor" names the opening; otherwise the candidate. */
    const jobsFor = await JobPosting.find({ jobTitle: containsRx(q.rest) }).select("_id jobTitle").limit(20).lean();
    if (jobsFor.length) { filter.jobPostingId = { $in: jobsFor.map((j) => j._id) }; parts.unshift(`for ${jobsFor.length === 1 ? jobsFor[0].jobTitle : `"${text(q.rest, 40)}"`}`); }
    else {
      filter.$and = q.rest.split(/\s+/).filter((w) => w.length >= 2).map((tok) => ({ name: new RegExp(`(^|\\s)${escapeRx(tok)}`, "i") }));
      if (!filter.$and.length) delete filter.$and;
      parts.push(`called "${text(q.rest, 40)}"`);
    }
  }
  const noun = `${q.filters.stage ? `${q.filters.stage.label.replace(/^in (the )?/, "")} ` : ""}candidate`;
  const [total, rows] = await Promise.all([
    Candidate.countDocuments(filter),
    q.ops.count ? [] : Candidate.find(filter).select(C.PROJECTIONS.candidate).sort({ appliedDate: -1 }).limit(listLimit(q)).lean(),
  ]);
  return listAnswer("Candidates", { total, rows: rows.map((c) => candidateRow(c, { single: false })), noun, qualifier: parts.join(" "), op: q.ops.count ? "count" : null, limit: listLimit(q) });
}

async function interviews(q) {
  const filter = { type: "interview", ...statusIn(q.filters.status) };
  let qualifier = "";
  if (q.window) { Object.assign(filter, dateRange("scheduledDate", q.window)); qualifier = windowWords(q.window); }
  else if (!q.filters.status || q.ops.next) { filter.scheduledDate = { $gte: W.dayStart(W.todayIso(q.now)) }; qualifier = "coming up"; }
  if (q.rest) { filter.title = containsRx(q.rest); qualifier = [`for "${text(q.rest, 40)}"`, qualifier].filter(Boolean).join(" "); }
  const [total, rows] = await Promise.all([
    EmployeeTask.countDocuments(filter),
    q.ops.count ? [] : EmployeeTask.find(filter).select(C.PROJECTIONS.interview).sort({ scheduledDate: 1 }).limit(listLimit(q)).lean(),
  ]);
  return listAnswer("Interviews", { total, rows: rows.map(interviewRow), noun: `${q.filters.status ? `${q.filters.status.label} ` : ""}interview`, qualifier, op: q.ops.count ? "count" : null, limit: listLimit(q) });
}

async function documents(q) {
  const scope = await peopleScope(q);
  if (scope.stop) return scope.stop;
  const filter = { ...scope.filter, ...(q.filters.docStatus?.filter || {}) };
  if (q.filters.docType) filter.type = q.filters.docType.type;
  let when = "";
  if (q.window) {
    if (q.ops.requested) { Object.assign(filter, dateRange("requestedAt", q.window)); when = `requested ${windowWords(q.window)}`; }
    else if (q.ops.issued) { Object.assign(filter, dateRange("generatedAt", q.window)); when = `issued ${windowWords(q.window)}`; }
    else return unsure(`Say which date — "letters issued ${q.window.source || "this month"}" or "letters requested ${q.window.source || "this month"}".`);
  }
  const noun = `${q.filters.docStatus ? `${q.filters.docStatus.label.split(",")[0]} ` : ""}${q.filters.docType ? q.filters.docType.label : "letter"}`;
  const [total, rows] = await Promise.all([
    EmployeeDocument.countDocuments(filter),
    q.ops.count ? [] : EmployeeDocument.find(filter).select(C.PROJECTIONS.document).sort({ createdAt: -1 }).limit(listLimit(q)).lean(),
  ]);
  return listAnswer("Letters", { total, rows: rows.map(documentRow), noun, qualifier: [scope.words, when].filter(Boolean).join(" "), op: q.ops.count ? "count" : null, limit: listLimit(q) });
}

async function payrollRuns(q) {
  if (q.rest) return nothing(`Payroll runs are named by month — "${text(q.rest, 40)}" is not one.`);
  const filter = { ...statusIn(q.filters.status) };
  if (q.window) {
    const months = [];
    for (let y = Number(q.window.from.slice(0, 4)), mo = Number(q.window.from.slice(5, 7));
      `${y}-${String(mo).padStart(2, "0")}` <= q.window.to.slice(0, 7) && months.length < 36; mo === 12 ? (mo = 1, y += 1) : (mo += 1)) months.push({ year: y, month: mo });
    filter.$or = months;
  }
  const [total, rows] = await Promise.all([
    Payroll.countDocuments(filter),
    q.ops.count ? [] : Payroll.find(filter).select(C.PROJECTIONS.payroll).sort({ year: -1, month: -1 }).limit(listLimit(q)).lean(),
  ]);
  return listAnswer("Payroll", { total, rows: rows.map(payrollRow), noun: `${q.filters.status ? `${q.filters.status.label} ` : ""}payroll run`, qualifier: windowWords(q.window), op: q.ops.count ? "count" : null, limit: listLimit(q) });
}

async function policies(q) {
  if (q.window) return unsure("Policies have no date to filter by.");
  const filter = { isActive: { $ne: false } };
  if (q.rest) filter.name = containsRx(q.rest);
  const [total, rows] = await Promise.all([
    Policy.countDocuments(filter),
    q.ops.count ? [] : Policy.find(filter).select(C.PROJECTIONS.policy).sort({ name: 1 }).limit(listLimit(q)).lean(),
  ]);
  return listAnswer("Policies", { total, rows: rows.map(policyRow), noun: "active policy", qualifier: q.rest ? `called "${text(q.rest, 40)}"` : "", op: q.ops.count ? "count" : null, limit: listLimit(q) });
}

/** Nothing named a family: the words are a record — find it by what identifies it. */
const ABOUT_A_PERSON = /\b(manager|boss|profile|contact|work email|email|joining date|reporting manager|reporting)\b/gi;
async function lookup(q, has) {
  /* What is left of the words, so "who is Ravi's manager" looks up Ravi. */
  const term = text((q.rest || q.raw).replace(ABOUT_A_PERSON, " "), 120) || text(q.raw, 120);
  const t = term.toLowerCase();
  const reads = [];
  if (has(CAP.PEOPLE_READ_DIRECTORY)) {
    reads.push(peopleNamed(term, { limit: 6 }).then((r) => ["people", r]));
    reads.push(Department.find({ name: exactRx(term) }).select(C.PROJECTIONS.department).limit(3).lean()
      .then((r) => (r.length || t.length < 3 ? r : Department.find({ name: containsRx(term) }).select(C.PROJECTIONS.department).limit(3).lean())).then((r) => ["departments", r]));
    /* "tailors" — a designation names the people who hold it. */
    reads.push(designationNamed(term).then((name) => (name
      ? Employee.find({ ...ACTIVE, designation: exactRx(name) }).select(C.PROJECTIONS.employee).sort({ firstName: 1 }).limit(MAX_ROWS - 1).lean()
      : [])).then((r) => ["holders", r]));
  }
  if (has(CAP.RECRUITMENT_READ)) {
    reads.push(JobPosting.find({ jobTitle: t.length < 3 ? exactRx(term) : containsRx(term) }).select(C.PROJECTIONS.job).sort({ publishedAt: -1 }).limit(3).lean().then((r) => ["jobs", r]));
    const toks = t.split(/\s+/).filter((w) => w.length >= 2);
    if (toks.length) reads.push(Candidate.find({ $and: toks.map((tok) => ({ name: new RegExp(`(^|\\s)${escapeRx(tok)}`, "i") })) }).select(C.PROJECTIONS.candidate).sort({ appliedDate: -1 }).limit(3).lean().then((r) => ["candidates", r]));
  }
  if (has(CAP.DOCUMENTS_READ)) reads.push(EmployeeDocument.find({ "letterMeta.referenceNo": exactRx(term) }).select(C.PROJECTIONS.document).limit(3).lean().then((r) => ["documents", r]));
  if (has(CAP.LEAVE_READ) && t.length >= 3) reads.push(CompanyHoliday.find({ name: containsRx(term) }).select(C.PROJECTIONS.holiday).sort({ date: 1 }).limit(3).lean().then((r) => ["holidays", r]));
  if (has(CAP.COMPLIANCE_READ) && t.length >= 3) reads.push(Policy.find({ name: containsRx(term) }).select(C.PROJECTIONS.policy).limit(3).lean().then((r) => ["policies", r]));
  const found = Object.fromEntries(await Promise.all(reads));
  const seen = new Set((found.people || []).map((e) => String(e._id)));
  const rows = [
    ...(found.people || []).map((e) => employeeRow(e)),
    ...(found.holders || []).filter((e) => !seen.has(String(e._id))).map((e) => employeeRow(e, { single: false })),
    ...(found.departments || []).map((d) => departmentRow(d)),
    ...(found.jobs || []).map((j) => jobRow(j)),
    ...(found.candidates || []).map((c) => candidateRow(c)),
    ...(found.documents || []).map(documentRow),
    ...(found.holidays || []).map(holidayRow),
    ...(found.policies || []).map(policyRow),
  ];
  if (!rows.length) return closestInHr(term, has, q.raw);
  /* One record found: it is the answer, with its card. */
  const out = rows.length === 1 ? [{ ...rows[0], metadata: { ...rows[0].metadata, single: true } }] : rows;
  return answered("Records", out);
}

/* ── NOTHING EXACT: THE CLOSEST, WITH A WARNING ────────────────────────────
   Owner's call, 9 Oct 2026 (services/ai/commandSearch/closest.js): a name
   that matched nothing — "Ravee Kumaar", "cuting" — is compared word by word
   with the names this role may see, and the closest are offered under a note
   that they are not exact. Only from the families the capabilities cover. */
async function closestInHr(term, has, said = term) {
  const candidates = [];
  const reads = [];
  if (has(CAP.PEOPLE_READ_DIRECTORY)) {
    reads.push(Employee.find({}).select(C.PROJECTIONS.employee).limit(5000).lean()
      .then((list) => list.forEach((e) => candidates.push({ label: C.fullName(e) || e.biometricId || "", words: `${e.biometricId || ""} ${e.nickName || ""}`, row: () => employeeRow(e, { single: false }) }))));
    reads.push(Department.find({}).select(C.PROJECTIONS.department).limit(500).lean()
      .then((list) => list.forEach((d) => candidates.push({ label: d.name, row: () => departmentRow(d, { single: false }) }))));
  }
  if (has(CAP.RECRUITMENT_READ)) {
    reads.push(JobPosting.find({}).select(C.PROJECTIONS.job).limit(1000).lean()
      .then((list) => list.forEach((j) => candidates.push({ label: j.jobTitle, row: () => jobRow(j, { single: false }) }))));
  }
  if (has(CAP.COMPLIANCE_READ)) {
    reads.push(Policy.find({}).select(C.PROJECTIONS.policy).limit(500).lean()
      .then((list) => list.forEach((p) => candidates.push({ label: p.name, row: () => policyRow(p) }))));
  }
  if (has(CAP.LEAVE_READ)) {
    reads.push(CompanyHoliday.find({}).select(C.PROJECTIONS.holiday).limit(500).lean()
      .then((list) => list.forEach((h) => candidates.push({ label: h.name, row: () => holidayRow(h) }))));
  }
  await Promise.all(reads);
  const near = closestMatches(term, candidates.filter((c) => c.label), { limit: 5 });
  if (!near.length) return nothing("Nothing in HR is called that.");
  const rows = near.map(({ candidate }, i) => {
    const row = candidate.row();
    return { ...row, metadata: { ...row.metadata, single: i === 0, approximate: true } };
  });
  return { ...answered("Closest matches", rows), note: approximateNote(said) };
}

const DECISION_SPECS = {
  leave: { Model: LeaveApplication, noun: "leave request", label: "leave", rangeKind: "overlap", typeKey: "leaveType", typeField: "leaveType", typeNoun: (t) => `${t.label} request`, row: leaveRow, sort: { fromDate: -1 } },
  correction: { Model: RegularizationRequest, noun: "attendance correction", label: "correction", dateField: "dateStr", typeKey: "correctionType", typeField: "type", typeNoun: (t) => `${t.label} correction`, row: correctionRow, sort: { dateStr: -1 } },
  overtime: { Model: OvertimeReport, noun: "overtime report", label: "overtime", dateField: "dateStr", row: overtimeRow, sort: { dateStr: -1 } },
};

/**
 * THE ENTRY POINT.
 *
 * @param {object}      args
 * @param {Set<string>} args.capabilities  the HR actor's, as resolved by hrAuthorization
 * @param {string}      args.query
 * @param {number}      [args.now]         the clock, for the periods
 */
async function search({ capabilities, query, now = Date.now() } = {}) {
  const held = capabilities instanceof Set ? capabilities : new Set(capabilities || []);
  const has = (cap) => held.has(cap);
  if (!has(CAP.HR_ACCESS)) return { state: "unauthorised", groups: [] };
  const raw = text(query, MAX_QUERY);
  if (!raw) return { state: "unsupported", groups: [] };
  const q = { ...parse(raw, now), now };

  let out;
  const family = q.family;
  if (family && !has(family.capability)) return refused(family);
  if (!family) out = await lookup(q, has);
  else if (family.id === "employee") out = await employees(q);
  else if (family.id === "department") out = await departments(q);
  else if (family.id === "designation") out = await designations(q);
  else if (family.id === "attendance") out = await attendance(q);
  else if (family.id === "leave_balance") out = await leaveBalance(q);
  else if (DECISION_SPECS[family.id]) out = await decisions(q, DECISION_SPECS[family.id]);
  else if (family.id === "holiday") out = await holidays(q);
  else if (family.id === "job") out = await jobs(q);
  else if (family.id === "candidate") out = await candidates(q);
  else if (family.id === "interview") out = await interviews(q);
  else if (family.id === "document") out = await documents(q);
  else if (family.id === "payroll") out = await payrollRuns(q);
  else if (family.id === "policy") out = await policies(q);
  else out = nothing("Nothing in HR is called that.");

  if (out.state === "answered") {
    out.groups = await Promise.all(out.groups.map(async (group) => ({
      ...group,
      results: await cards.withCards(group.results, { cardFor: (record) => cardFor(record, held) }),
    })));
  }
  return out;
}

module.exports = { search, parse, cardFor, MAX_QUERY, MAX_PEOPLE };
