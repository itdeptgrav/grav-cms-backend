"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const morning = require("./morningBriefVoice.service");

test("summary prioritises attendance, today's schedule, due work and owned approvals", () => {
  const result = morning.buildSummary({ sections: {
    attendance: { status: "ok", recorded: true, inTime: "09:04", late: false },
    meetings: { status: "ok", items: [{}, {}] },
    interviews: { status: "ok", items: [{}] },
    tasks: { status: "ok", overdue: 2, dueToday: 1, toReview: 1 },
    planner: { status: "ok", overdue: 1, dueToday: 2 },
    leave: { status: "ok", pending: [] },
  } }, { leave_pending: 2, overtime_pending: 1 });
  assert.match(result.text, /checked in at 09:04/i);
  assert.match(result.text, /2 meetings and 1 interview/i);
  assert.match(result.text, /3 overdue items/i);
  assert.match(result.text, /3 approvals are waiting/i);
  assert.equal(result.skipForLeave, false);
});

test("scheduled brief is suppressed when approved leave covers today", () => {
  const result = morning.buildSummary({ sections: {
    attendance: { status: "ok", recorded: false },
    meetings: { status: "ok", items: [] },
    interviews: { status: "ok", items: [] },
    tasks: { status: "ok" },
    planner: { status: "ok" },
    leave: { status: "ok", today: { type: "CL" }, pending: [] },
  } });
  assert.equal(result.skipForLeave, true);
});

test("preference validation refuses unavailable voices and malformed times", () => {
  assert.throws(() => morning.normalizeInput({ time: "25:00", language: "en" }, ["en"]), /valid morning brief time/i);
  assert.throws(() => morning.normalizeInput({ time: "09:15", language: "hi" }, ["en"]), /not installed/i);
  assert.deepEqual(
    morning.normalizeInput({ enabled: true, time: "08:45", weekdays: [5, 1, 1], language: "en" }, ["en"]),
    { enabled: true, time: "08:45", weekdays: [1, 5], language: "en" },
  );
});

test("IST scheduling parts are deterministic", () => {
  assert.deepEqual(morning.istParts(new Date("2026-10-13T03:45:00.000Z")), {
    date: "2026-10-13", time: "09:15", weekday: 2, minute: 555,
  });
});

