// services/followUps/followUpRules.js
//
// The follow-up rules with no database: the departments, the automatic kinds,
// who may do what, which list a follow-up is in, and when it is overdue.
// followUps.service.js does the reading and writing and asks this file every
// question; followUpRules.test.js pins the answers.
"use strict";

/** The departments that raise and own follow-ups. `slugs` are the Access
 *  Control department slugs whose people belong to it: the production
 *  manager's people still hold the old "project-manager" department as their
 *  primary (2 people on 9 Oct 2026, nobody on "ppc"), so both count. */
const DEPARTMENTS = Object.freeze([
  { key: "ppc", label: "Production Manager", slugs: ["ppc", "project-manager"], portal: "/ppc" },
  { key: "merchandiser", label: "Merchandising", slugs: ["merchandiser"], portal: "/merchandiser" },
  { key: "research-development", label: "Design (R&D)", slugs: ["research-development"], portal: "/research-development" },
  { key: "sales", label: "Sales", slugs: ["sales"], portal: "/sales" },
]);

const DEPT_KEYS = DEPARTMENTS.map((d) => d.key);

function deptByKey(key) {
  return DEPARTMENTS.find((d) => d.key === key) || null;
}

/** The follow-up department a session's Access Control slug belongs to, or "". */
function deptOfSlug(slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (!s) return "";
  const d = DEPARTMENTS.find((x) => x.slugs.includes(s));
  return d ? d.key : "";
}

/** The automatic follow-ups raised at a hand-off. `days` is the default time
 *  allowed when the hand-off itself carries no date. */
const AUTO_KINDS = Object.freeze({
  bom_needed: { label: "Fill the BOM", toDept: "merchandiser", days: 3 },
  bom_approval: { label: "Approve the BOM", toDept: "ppc", days: 2 },
  bom_fix: { label: "BOM rejected — revise it", toDept: "merchandiser", days: 2 },
  tech_sheet: { label: "Tech sheet", toDept: "research-development", days: 5 },
  tech_sheet_changes: { label: "Tech sheet — changes asked", toDept: "research-development", days: 3 },
  sample: { label: "Make the sample", toDept: "research-development", days: 7 },
  sample_rework: { label: "Sample rejected — rework", toDept: "research-development", days: 5 },
  material_returned: { label: "Material sent back by R&D", toDept: "merchandiser", days: 2 },
});

const STATUS = Object.freeze({ OPEN: "open", ANSWERED: "answered", CLOSED: "closed" });

const VIEWS = Object.freeze(["mine", "raised", "department", "overdue", "open", "closed"]);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Two people are the same when their emails match, or failing an email,
 *  their ids. A department login (DeptUser) and an Employee login carry
 *  different ids for one person but the same address. */
function samePerson(a, b) {
  if (!a || !b) return false;
  const ea = String(a.email || "").toLowerCase();
  const eb = String(b.email || "").toLowerCase();
  if (ea && eb) return ea === eb;
  const ia = String(a.id || "");
  const ib = String(b.id || "");
  return Boolean(ia && ib && ia === ib);
}

function isOverdue(fu, now = new Date()) {
  if (!fu || fu.status !== STATUS.OPEN || !fu.dueAt) return false;
  return new Date(fu.dueAt).getTime() < new Date(now).getTime();
}

/** Who the follow-up is waiting on right now: "assignee", "raiser" or "". */
function waitingOn(fu) {
  if (!fu) return "";
  if (fu.status === STATUS.OPEN) return "assignee";
  if (fu.status === STATUS.ANSWERED) return fu.raisedBy?.system ? "" : "raiser";
  return "";
}

/** Is the follow-up in this list for this person? The same rule as
 *  viewQuery below, for tests and for one row in memory. */
function inView(fu, view, me, now = new Date()) {
  const closed = fu.status === STATUS.CLOSED;
  switch (view) {
    case "mine":
      return (fu.status === STATUS.OPEN && (samePerson(fu.assignee, me) || (fu.needsPerson && me.dept && fu.toDept === me.dept)))
        || (fu.status === STATUS.ANSWERED && !fu.raisedBy?.system && samePerson(fu.raisedBy, me));
    case "raised":
      return !closed && !fu.raisedBy?.system && samePerson(fu.raisedBy, me);
    case "department":
      return !closed && Boolean(me.dept) && (fu.toDept === me.dept || fu.fromDept === me.dept);
    case "overdue":
      return isOverdue(fu, now);
    case "open":
      return !closed;
    case "closed":
      return closed;
    default:
      return false;
  }
}

function personMatch(path, me) {
  const or = [];
  if (me.email) or.push({ [`${path}.email`]: String(me.email).toLowerCase() });
  if (me.id) or.push({ [`${path}.id`]: String(me.id) });
  return or.length ? { $or: or } : { _id: null };
}

/** The Mongo filter for a list. */
function viewQuery(view, me, now = new Date()) {
  switch (view) {
    case "mine": {
      const assigned = [personMatch("assignee", me)];
      if (me.dept) assigned.push({ needsPerson: true, toDept: me.dept });
      return {
        $or: [
          { status: STATUS.OPEN, $or: assigned },
          { $and: [{ status: STATUS.ANSWERED, "raisedBy.system": { $ne: true } }, personMatch("raisedBy", me)] },
        ],
      };
    }
    case "raised":
      return { $and: [{ status: { $ne: STATUS.CLOSED }, "raisedBy.system": { $ne: true } }, personMatch("raisedBy", me)] };
    case "department":
      return me.dept
        ? { status: { $ne: STATUS.CLOSED }, $or: [{ toDept: me.dept }, { fromDept: me.dept }] }
        : { _id: null };
    case "overdue":
      return { status: STATUS.OPEN, dueAt: { $ne: null, $lt: new Date(now) } };
    case "closed":
      return { status: STATUS.CLOSED };
    case "open":
    default:
      return { status: { $ne: STATUS.CLOSED } };
  }
}

/**
 * What this person may do to this follow-up. `me` = { id, email, dept, isAdmin }.
 * Admins may do anything. Otherwise:
 *  - answer: the assignee (or, while nobody is named, anyone in the owning
 *    department), while it is open;
 *  - close: whoever raised it; for one the system raised, the assignee too
 *    ("done" — there is nobody else to accept the answer);
 *  - reopen: whoever raised it, once answered or closed;
 *  - reassign: the raiser, the assignee, or anyone in the owning department,
 *    while it is not closed;
 *  - change the due date: the raiser or the assignee, while it is not closed;
 *  - comment: anyone in either department, the raiser or the assignee.
 */
function allowed(fu, me) {
  const admin = Boolean(me?.isAdmin);
  const isAssignee = samePerson(fu.assignee, me);
  const isRaiser = !fu.raisedBy?.system && samePerson(fu.raisedBy, me);
  const inOwning = Boolean(me?.dept) && me.dept === fu.toDept;
  const inRaising = Boolean(me?.dept) && me.dept === fu.fromDept;
  const closed = fu.status === STATUS.CLOSED;
  const open = fu.status === STATUS.OPEN;
  const ownsWork = isAssignee || (fu.needsPerson && inOwning);
  return {
    answer: open && (admin || ownsWork),
    close: !closed && (admin || isRaiser || (Boolean(fu.raisedBy?.system) && ownsWork)),
    reopen: fu.status !== STATUS.OPEN && (admin || isRaiser || (Boolean(fu.raisedBy?.system) && inOwning)),
    reassign: !closed && (admin || isRaiser || isAssignee || inOwning),
    due: !closed && (admin || isRaiser || isAssignee),
    comment: admin || isAssignee || isRaiser || inOwning || inRaising,
  };
}

/** A due date for an automatic follow-up: the hand-off's own date when it has
 *  one in the future, otherwise `days` working-ish days from now (Sundays are
 *  skipped, the factory's day off). */
function autoDueAt(kind, given, now = new Date()) {
  if (given) {
    const d = new Date(given);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const days = AUTO_KINDS[kind]?.days ?? 3;
  const d = new Date(now);
  let left = days;
  while (left > 0) {
    d.setTime(d.getTime() + DAY_MS);
    if (d.getUTCDay() !== 0) left -= 1;
  }
  return d;
}

/** Validate a manual follow-up's input. Returns { errors, value }. */
function validateNew(body, { now = new Date() } = {}) {
  const errors = [];
  const title = String(body?.title || "").trim();
  const detail = String(body?.detail || "").trim();
  const toDept = String(body?.toDept || "").trim();
  const subjectType = ["style", "order"].includes(body?.subject?.type) ? body.subject.type : "none";
  const subjectId = String(body?.subject?.id || "").trim();
  if (!title) errors.push("Say what you are waiting for.");
  if (title.length > 200) errors.push("Keep the title under 200 characters.");
  if (detail.length > 4000) errors.push("Keep the detail under 4000 characters.");
  if (!DEPT_KEYS.includes(toDept)) errors.push("Choose the department it is for.");
  if (!body?.assignee || (!body.assignee.email && !body.assignee.id)) errors.push("Choose the person it is for.");
  if (subjectType !== "none" && !subjectId) errors.push("Choose the style or order it is about.");
  let dueAt = null;
  if (!body?.dueAt) errors.push("Set the date it is needed by.");
  else {
    dueAt = new Date(body.dueAt);
    if (Number.isNaN(dueAt.getTime())) errors.push("That due date is not a date.");
    else if (dueAt.getTime() < new Date(now).getTime() - DAY_MS) errors.push("The due date is in the past.");
  }
  return {
    errors,
    value: {
      title, detail, toDept, dueAt,
      priority: body?.priority === "urgent" ? "urgent" : "normal",
      subject: { type: subjectType, id: subjectType === "none" ? "" : subjectId },
    },
  };
}

/** The follow-up number shown everywhere: FU-0007. */
function numberOf(seq) {
  return `FU-${String(seq).padStart(4, "0")}`;
}

/** The IST calendar day of a date, YYYY-MM-DD. */
function istDay(date = new Date()) {
  const d = new Date(new Date(date).getTime() + 330 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  DEPARTMENTS, DEPT_KEYS, deptByKey, deptOfSlug,
  AUTO_KINDS, STATUS, VIEWS,
  samePerson, isOverdue, waitingOn, inView, viewQuery, allowed,
  autoDueAt, validateNew, numberOf, istDay,
};
