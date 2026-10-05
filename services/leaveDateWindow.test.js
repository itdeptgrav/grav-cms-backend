"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { checkLeaveStartsAfterJoining } = require("./leaveDateWindow");

/* The real record this was written for: ASHA NAIK joined 4 May 2026 and a
   half-day sick leave was filed against 5 Sept 2025. */
const ASHA = { dateOfJoining: "2026-05-04T00:00:00.000Z" };

test("the application that started this is refused", () => {
  const r = checkLeaveStartsAfterJoining(ASHA, "2025-09-05");
  assert.equal(r.ok, false);
  assert.equal(r.code, "BEFORE_DATE_OF_JOINING");
});

test("the refusal names both dates, so the wrong YEAR is visible", () => {
  const { message } = checkLeaveStartsAfterJoining(ASHA, "2025-09-05");
  assert.match(message, /5 Sept 2025/);
  assert.match(message, /4 May 2026/);
  assert.match(message, /year/i);
});

test("the day they actually meant is allowed", () => {
  assert.equal(checkLeaveStartsAfterJoining(ASHA, "2026-09-05").ok, true);
});

test("backdating still works — a leave filed the morning after is normal", () => {
  assert.equal(checkLeaveStartsAfterJoining(ASHA, "2026-06-01").ok, true);
});

test("the joining day itself is allowed, not off by one", () => {
  assert.equal(checkLeaveStartsAfterJoining(ASHA, "2026-05-04").ok, true);
});

test("the day before joining is refused", () => {
  assert.equal(checkLeaveStartsAfterJoining(ASHA, "2026-05-03").ok, false);
});

test("a time component does not shift the day", () => {
  /* Dates here are calendar dates wearing a timestamp. Whatever hour rides
     along, the day compared is the UTC calendar day. */
  const emp = { dateOfJoining: new Date("2026-05-04T18:30:00.000Z") };
  assert.equal(checkLeaveStartsAfterJoining(emp, "2026-05-04").ok, true);
  assert.equal(checkLeaveStartsAfterJoining(emp, "2026-05-03").ok, false);
});

test("the verdict does not depend on the server's timezone", () => {
  /* 00:00:00Z read with LOCAL getters is the previous day on any host west of
     UTC, which would refuse a leave on somebody's own joining day depending
     on where the process runs. */
  const emp = { dateOfJoining: new Date("2026-05-04T00:00:00.000Z") };
  assert.equal(checkLeaveStartsAfterJoining(emp, "2026-05-04").ok, true);
});

test("no joining date recorded is not the employee's fault, and is allowed", () => {
  assert.equal(checkLeaveStartsAfterJoining({}, "2025-01-01").ok, true);
  assert.equal(checkLeaveStartsAfterJoining({ dateOfJoining: null }, "2025-01-01").ok, true);
  assert.equal(checkLeaveStartsAfterJoining(null, "2025-01-01").ok, true);
});

test("an unreadable date is left to the caller's own validation", () => {
  assert.equal(checkLeaveStartsAfterJoining(ASHA, "").ok, true);
  assert.equal(checkLeaveStartsAfterJoining(ASHA, "not a date").ok, true);
  assert.equal(checkLeaveStartsAfterJoining(ASHA, undefined).ok, true);
});

test("a Date object works as well as a string", () => {
  assert.equal(checkLeaveStartsAfterJoining(ASHA, new Date(2025, 8, 5)).ok, false);
  assert.equal(checkLeaveStartsAfterJoining(ASHA, new Date(2026, 8, 5)).ok, true);
});
