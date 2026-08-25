// services/taskBuckets.js
//
// A salesperson's own worklist, split by when it is due.
//
// WHY THIS EXISTS. The CRM could always store many tasks per lead, account and
// journey — Activity has owner, due date, status and priority — but the only
// place any of them surfaced was the ONE `currentNextActionId` shown on a
// pipeline row. So there was no way to answer "what do I have to do today"
// without opening every journey in turn, and the predictable result was that
// nobody created tasks at all: the activities collection was empty, and the
// hub's Overdue / Today / This week bands had nothing to sort.
//
// The board keeps showing one task per row — five tasks on a row stops it being
// scannable. This is the other half: everything I own, in one place.
//
// Pure and DB-free so the bucketing is testable without a database, and so the
// route stays a query plus a shape.

"use strict";

const DAY = 24 * 60 * 60 * 1000;

/**
 * UNDATED IS ITS OWN BUCKET, and it is listed last rather than dropped.
 *
 * A task with no date is a real intention someone recorded; hiding it would
 * teach people the list is unreliable. Putting it above dated work would let
 * it drown the things that are actually due. Last, and counted.
 */
const BUCKETS = ["overdue", "today", "week", "later", "undated"];

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
};

/** Which bucket one task falls in. Exported for the row-level label. */
function bucketOf(task, now = new Date()) {
  const due = task?.dueDate ? new Date(task.dueDate).getTime() : null;
  if (due === null || Number.isNaN(due)) return "undated";
  const today = startOfDay(now);
  if (due < today) return "overdue";
  if (due < today + DAY) return "today";
  if (due < today + 7 * DAY) return "week";
  return "later";
}

/**
 * Group a flat list of planned tasks.
 *
 * @param {Array} tasks  lean Activity docs
 * @param {Date}  [now]
 * @returns {{buckets: Record<string, Array>, counts: Record<string, number>, total: number, order: string[]}}
 */
function bucketTasks(tasks = [], now = new Date()) {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, []]));
  for (const t of tasks) buckets[bucketOf(t, now)].push(t);

  // Within a bucket: soonest first, then by priority, then by subject — so the
  // order is stable between reloads rather than following the database.
  const rank = { urgent: 0, high: 1, normal: 2, low: 3 };
  for (const b of BUCKETS) {
    buckets[b].sort((x, y) => {
      const dx = x.dueDate ? new Date(x.dueDate).getTime() : Infinity;
      const dy = y.dueDate ? new Date(y.dueDate).getTime() : Infinity;
      return dx - dy
        || (rank[x.priority] ?? 2) - (rank[y.priority] ?? 2)
        || String(x.subject || "").localeCompare(String(y.subject || ""));
    });
  }

  const counts = Object.fromEntries(BUCKETS.map((b) => [b, buckets[b].length]));
  return { buckets, counts, total: tasks.length, order: BUCKETS };
}

/**
 * What a task is ON, so the row can name it and link to it.
 *
 * A task can carry a journey ref, a lead and an account at once — it is the
 * same customer seen from three angles. The most SPECIFIC wins, because that is
 * where the work actually happens: a task on a journey belongs on that stage
 * page, not on the account that owns forty journeys.
 */
function taskSubject(task = {}) {
  if (task.journeyRef) {
    return { kind: "journey", ref: task.journeyRef, label: task.journeyRef, href: `/sales/dashboard/journeys/${task.journeyRef}` };
  }
  if (task.leadId) {
    const lead = typeof task.leadId === "object" ? task.leadId : null;
    const id = lead ? String(lead._id) : String(task.leadId);
    return {
      kind: "lead",
      ref: lead?.leadId || null,
      label: lead ? (lead.company || [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.leadId) : "Lead",
      href: `/sales/dashboard/leads/${id}`,
    };
  }
  if (task.accountId) {
    const acc = typeof task.accountId === "object" ? task.accountId : null;
    const id = acc ? String(acc._id) : String(task.accountId);
    return {
      kind: "account",
      ref: acc?.accountId || null,
      label: acc?.companyName || acc?.displayName || "Account",
      href: `/sales/dashboard/accounts/${id}`,
    };
  }
  // Orphan: a task with nothing attached. Shown rather than hidden — it is
  // still something a person wrote down for themselves.
  return { kind: "none", ref: null, label: "No record attached", href: null };
}

module.exports = { bucketTasks, bucketOf, taskSubject, BUCKETS };
