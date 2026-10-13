"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  istDateStr, daysUntilNext, peopleMoments, covers, isTodayIst, asDate, displayName,
} = require("./homeDates");

// 28 Dec 2026, 20:00 IST = 14:30 UTC
const DEC28 = new Date("2026-12-28T14:30:00Z");

test("today is India's day, not the server's", () => {
  // 23:00 UTC on 9 Oct is already 10 Oct in India
  assert.equal(istDateStr(new Date("2026-10-09T23:00:00Z")), "2026-10-10");
  assert.equal(istDateStr(new Date("2026-10-09T18:00:00Z")), "2026-10-09");
});

test("the next occurrence wraps the year end, and today is 0", () => {
  assert.equal(daysUntilNext({ m: 0, d: 2 }, DEC28), 5); // 2 Jan
  assert.equal(daysUntilNext({ m: 11, d: 28 }, DEC28), 0);
  assert.equal(daysUntilNext({ m: 11, d: 27 }, DEC28), 364);
});

test("29 Feb is celebrated on 28 Feb in a common year", () => {
  const feb27 = new Date("2027-02-27T06:00:00Z");
  assert.equal(daysUntilNext({ m: 1, d: 29 }, feb27), 1);
});

test("birthdays and anniversaries across the year end; the year of birth is dropped", () => {
  const out = peopleMoments([
    { id: "a", name: "Asha", dateOfBirth: "1990-01-02T00:00:00Z", dateOfJoining: "2020-12-30T00:00:00Z" },
    { id: "b", name: "Bikash", dateOfBirth: "1985-12-28T00:00:00Z", dateOfJoining: "2026-12-20T00:00:00Z" },
    { id: "c", name: "Chitra", dateOfBirth: "1992-06-01T00:00:00Z", dateOfJoining: "2026-12-29T00:00:00Z" },
  ], { now: DEC28 });

  assert.deepEqual(out.birthdays.map((p) => [p.id, p.inDays]), [["b", 0], ["a", 5]]);
  assert.ok(out.birthdays.every((p) => !("dateOfBirth" in p) && !("y" in p)));
  assert.deepEqual(out.anniversaries.map((p) => [p.id, p.years, p.inDays]), [["a", 6, 2]]);
  // joined 8 days ago counts; a future joining date (29 Dec) does not
  assert.deepEqual(out.joiners.map((p) => [p.id, p.joinedDaysAgo]), [["b", 8]]);
});

test("first anniversary only after a full year", () => {
  const out = peopleMoments([{ id: "x", name: "X", dateOfJoining: "2026-01-02T00:00:00Z" }], { now: DEC28 });
  assert.deepEqual(out.anniversaries.map((p) => p.years), [1]);
  const none = peopleMoments([{ id: "y", name: "Y", dateOfJoining: "2026-12-20T00:00:00Z" }], { now: DEC28 });
  assert.equal(none.anniversaries.length, 0);
});

test("a leave covers its days inclusively", () => {
  assert.ok(covers("2026-10-08", "2026-10-10", "2026-10-10"));
  assert.ok(covers("2026-10-10", "", "2026-10-10"));
  assert.ok(!covers("2026-10-11", "2026-10-12", "2026-10-10"));
});

test("meeting times in every stored form", () => {
  const now = new Date("2026-10-10T05:00:00Z");
  assert.ok(isTodayIst("2026-10-10T09:00:00+05:30", now));
  assert.ok(isTodayIst({ _seconds: Date.parse("2026-10-10T10:00:00Z") / 1000 }, now));
  assert.ok(isTodayIst({ toDate: () => new Date("2026-10-10T10:00:00Z") }, now));
  assert.ok(!isTodayIst("2026-10-11T09:00:00+05:30", now));
  assert.equal(asDate("nonsense"), null);
});

test("display names", () => {
  assert.equal(displayName({ firstName: "Rishi ", lastName: "Das" }), "Rishi Das");
  assert.equal(displayName({ name: "QC Desk" }), "QC Desk");
});
