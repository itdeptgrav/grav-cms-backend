"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const c = require("./targetCurve");

test("a ramp is cleaned, not trusted", () => {
  assert.deepEqual(c.normaliseRamp([50, 75]), [50, 75]);
  assert.deepEqual(c.normaliseRamp("gentle"), [50, 75], "the preset's trailing 100 is the full number, not a ramp day");
  assert.deepEqual(c.normaliseRamp([50, 0, -3, 900, 75]), [50, 75], "nonsense percentages are dropped");
  assert.deepEqual(c.normaliseRamp(undefined), []);
  assert.deepEqual(c.normaliseRamp([100, 100]), [], "a ramp of full days is no ramp");
  assert.equal(c.normaliseRamp(new Array(40).fill(50)).length, c.MAX_RAMP_DAYS);
});

test("the ramp shapes the first days and then steps aside", () => {
  const ramp = [50, 75];
  assert.equal(c.expectedOnDay(260, ramp, 0), 130);
  assert.equal(c.expectedOnDay(260, ramp, 1), 195);
  assert.equal(c.expectedOnDay(260, ramp, 2), 260, "day three is the full number");
  assert.equal(c.expectedOnDay(260, [], 0), 260, "no ramp is the number, every day");
});

test("what is promised is what the shape adds up to", () => {
  assert.equal(c.expectedTotal(260, [50, 75], 5), 130 + 195 + 260 + 260 + 260);
  assert.equal(c.expectedTotal(260, [], 5), 1300);
});

test("the hours always add up to the day", () => {
  for (const pieces of [260, 1, 7, 999]) {
    const plan = c.hourPlan({ hoursFrom: "09:30", hoursTo: "18:30" }, pieces);
    assert.equal(plan.reduce((n, h) => n + h.pieces, 0), pieces, `${pieces} spread over nine hours`);
    assert.equal(plan.length, 9);
    assert.equal(plan[0].from, "09:30");
    assert.equal(plan[plan.length - 1].to, "18:30");
  }
});

test("an explicit hour plan is used as typed", () => {
  const plan = c.hourPlan({ hoursFrom: "09:30", hoursTo: "12:30", hours: [
    { from: "09:30", to: "10:30", pieces: 20 }, { from: "10:30", to: "11:30", pieces: 40 }, { from: "11:30", to: "12:30", pieces: 60 },
  ] }, 999);
  assert.deepEqual(plan.map((h) => h.pieces), [20, 40, 60], "the day's number does not overwrite what PPC asked hour by hour");
});

test("what is due part-way through the day comes from the hours", () => {
  const plan = c.hourPlan({ hoursFrom: "09:00", hoursTo: "12:00", hours: [
    { from: "09:00", to: "10:00", pieces: 10 }, { from: "10:00", to: "11:00", pieces: 20 }, { from: "11:00", to: "12:00", pieces: 30 },
  ] }, 60);
  assert.equal(c.dueByMinute(plan, c.toMinutes("08:00")), 0, "nothing is due before the window opens");
  assert.equal(c.dueByMinute(plan, c.toMinutes("10:00")), 10);
  assert.equal(c.dueByMinute(plan, c.toMinutes("10:30")), 20, "10 + half of 20");
  assert.equal(c.dueByMinute(plan, c.toMinutes("12:00")), 60);
  assert.equal(c.dueByMinute(plan, c.toMinutes("23:00")), 60, "after it closes the whole day is due");
});

test("the ramp says itself in words", () => {
  assert.match(c.describeRamp([50, 75]), /50% → 75%/);
  assert.equal(c.describeRamp([]), "");
});
