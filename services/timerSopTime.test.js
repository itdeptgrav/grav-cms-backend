"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { instantMs, istDateStr, addDaysToLabel, dowForLabel } = require("./timerSopTime");

/**
 * The value that stopped the engine dead.
 *
 * `cowork_sop_settings/task_events.timerSopEnabledAt` is written by the admin
 * toggle as a Date and read back from Firestore as a Timestamp. Read with
 * `new Date(timestamp)` it was Invalid Date, and `istDateStr` threw
 * `RangeError: Invalid time value` — for every employee, on every nightly run
 * and on every Score-page load — so no day was ever finalised and no point
 * ever moved. Pinned here with the exact stored shape.
 */
const STORED_ENABLED_AT = { _seconds: 1788873746, _nanoseconds: 347000000 };

test("a Firestore Timestamp instance is read through toMillis", () => {
  const ts = { toMillis: () => 1788873746347, seconds: 1788873746, nanoseconds: 347000000 };
  assert.equal(instantMs(ts), 1788873746347);
});

test("the serialised { _seconds, _nanoseconds } shape is read", () => {
  assert.equal(instantMs(STORED_ENABLED_AT), 1788873746347);
  /* The exact line that used to throw now yields the switch-on day. */
  assert.equal(istDateStr(instantMs(STORED_ENABLED_AT)), "2026-09-08");
});

test("the { seconds, nanoseconds } shape, ISO strings, Dates and numbers are read", () => {
  assert.equal(instantMs({ seconds: 1700000000, nanoseconds: 0 }), 1700000000000);
  assert.equal(instantMs("2026-09-08T13:22:26.347Z"), 1788873746347);
  assert.equal(instantMs(new Date(1788873746347)), 1788873746347);
  assert.equal(instantMs(1788873746347), 1788873746347);
});

test("an unreadable instant is null, never NaN", () => {
  for (const bad of [null, undefined, "", "not a date", {}, { foo: 1 }, new Date("garbage"), NaN, Infinity]) {
    assert.equal(instantMs(bad), null, `expected null for ${String(bad)}`);
  }
});

test("istDateStr refuses a non-finite instant instead of producing an Invalid Date label", () => {
  assert.throws(() => istDateStr(NaN), RangeError);
  assert.throws(() => istDateStr(undefined), RangeError);
});

test("the IST day boundary is respected", () => {
  /* 2026-09-08 18:45:04Z is 00:15:04 IST on 9 September — the nightly run. */
  assert.equal(istDateStr(Date.parse("2026-09-08T18:45:04.590Z")), "2026-09-09");
  assert.equal(istDateStr(Date.parse("2026-09-08T18:29:59.000Z")), "2026-09-08");
});

test("label arithmetic goes both ways and knows the weekday", () => {
  assert.equal(addDaysToLabel("2026-09-10", -1), "2026-09-09");
  assert.equal(addDaysToLabel("2026-09-30", 1), "2026-10-01");
  assert.equal(addDaysToLabel("2026-03-01", -1), "2026-02-28");
  assert.equal(dowForLabel("2026-09-09"), 3, "9 September 2026 is a Wednesday");
  assert.equal(dowForLabel("2026-09-13"), 0, "13 September 2026 is a Sunday");
});
