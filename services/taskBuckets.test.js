// services/taskBuckets.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { bucketTasks, bucketOf, taskSubject } = require("./taskBuckets");

// Bucketing is done in the SERVER'S LOCAL DAY, which is what a salesperson
// means by "today". These fixtures are therefore built in local time — writing
// them as ...Z would make the suite pass or fail depending on the machine's
// offset, which is how you end up "fixing" correct code.
const NOW = new Date(2026, 7, 22, 10, 0, 0);          // 22 Aug 2026, 10:00 local
const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo, d, h, mi, 0);
const at = (s) => ({ subject: s, dueDate: null });
const due = (s, date, priority) => ({ subject: s, dueDate: date, priority });

test("buckets split by the local DAY, not by 24-hour windows", () => {
  // 09:00 today is in the past but still today — it must not read as overdue.
  assert.equal(bucketOf(due("x", local(2026, 7, 22, 9, 0)), NOW), "today");
  assert.equal(bucketOf(due("x", local(2026, 7, 22, 23, 59)), NOW), "today");
  assert.equal(bucketOf(due("x", local(2026, 7, 21, 23, 59)), NOW), "overdue");
});

test("this week runs to seven days out, then later", () => {
  assert.equal(bucketOf(due("x", local(2026, 7, 28)), NOW), "week");
  assert.equal(bucketOf(due("x", local(2026, 7, 29)), NOW), "later");
});

test("a task with no date is undated, not dropped", () => {
  const r = bucketTasks([at("Ask about sizing")], NOW);
  assert.equal(r.counts.undated, 1);
  assert.equal(r.total, 1);
});

test("undated sorts LAST so it cannot drown work that is actually due", () => {
  assert.equal(bucketTasks([], NOW).order.at(-1), "undated");
});

test("an unparseable date is undated rather than throwing", () => {
  assert.equal(bucketOf({ subject: "x", dueDate: "not-a-date" }, NOW), "undated");
});

test("within a bucket: soonest first, then priority, then subject", () => {
  const r = bucketTasks([
    due("Zebra", local(2026, 7, 22, 15, 0), "normal"),
    due("Apple", local(2026, 7, 22, 15, 0), "urgent"),
    due("Chase PO", local(2026, 7, 22, 9, 0), "low"),
  ], NOW);
  assert.deepEqual(r.buckets.today.map((t) => t.subject), ["Chase PO", "Apple", "Zebra"]);
});

test("ties break on subject, so the order is stable between reloads", () => {
  const r = bucketTasks([
    due("Beta", local(2026, 7, 26), "normal"),
    due("Alpha", local(2026, 7, 26), "normal"),
  ], NOW);
  assert.deepEqual(r.buckets.week.map((t) => t.subject), ["Alpha", "Beta"]);
});

/* ── what a task is ON ────────────────────────────────────────────────────── */

test("the MOST SPECIFIC record wins — that is where the work happens", () => {
  const s = taskSubject({
    journeyRef: "SJ-2026-0008",
    leadId: { _id: "l1", company: "Northwind" },
    accountId: { _id: "a1", companyName: "Northwind Hospitality" },
  });
  assert.equal(s.kind, "journey", "a journey task belongs on its stage page, not on an account with forty journeys");
  assert.equal(s.href, "/sales/dashboard/journeys/SJ-2026-0008");
});

test("a lead task names the company and links to the lead", () => {
  const s = taskSubject({ leadId: { _id: "l1", leadId: "LEAD-2026-0024", company: "Northwind" } });
  assert.equal(s.kind, "lead");
  assert.equal(s.label, "Northwind");
  assert.equal(s.href, "/sales/dashboard/leads/l1");
});

test("a lead with no company falls back to the person, then the ref", () => {
  assert.equal(taskSubject({ leadId: { _id: "l1", firstName: "Anita", lastName: "Deshpande" } }).label, "Anita Deshpande");
  assert.equal(taskSubject({ leadId: { _id: "l1", leadId: "LEAD-9" } }).label, "LEAD-9");
});

test("an unpopulated id still produces a working link", () => {
  assert.equal(taskSubject({ accountId: "a1" }).href, "/sales/dashboard/accounts/a1");
});

test("a task attached to nothing is still shown — somebody wrote it down", () => {
  const s = taskSubject({});
  assert.equal(s.kind, "none");
  assert.equal(s.href, null);
});
