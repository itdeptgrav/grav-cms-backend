const test = require("node:test");
const assert = require("node:assert");
const { monthSegments, roomFromMonths } = require("./leaveMonths");

test("a leave inside one month is one segment", () => {
  assert.deepStrictEqual(monthSegments("2026-10-20", "2026-10-28").map((s) => [s.key, s.days]), [["2026-10", 9]]);
});

test("a leave across two months is split at the month end, and across the year end", () => {
  assert.deepStrictEqual(monthSegments("2026-10-28", "2026-11-05").map((s) => [s.key, s.days]), [["2026-10", 4], ["2026-11", 5]]);
  assert.deepStrictEqual(monthSegments("2026-12-30", "2027-01-02").map((s) => [s.key, s.days]), [["2026-12", 2], ["2027-01", 2]]);
  assert.deepStrictEqual(monthSegments("2028-02-27", "2028-03-01").map((s) => [s.key, s.days]), [["2028-02", 3], ["2028-03", 1]]);
});

test("a half day is half a day", () => {
  assert.deepStrictEqual(monthSegments("2026-10-10", "2026-10-10", true).map((s) => s.days), [0.5]);
});

test("each month gives its own room under the cap", () => {
  /* the owner's case: 7 a month, 1.5 already away in October, a leave next month is not held to October's 5.5 */
  const nov = monthSegments("2026-11-02", "2026-11-08");
  assert.strictEqual(roomFromMonths(nov, [0], 7).room, 7);
  const oct = monthSegments("2026-10-20", "2026-10-28");
  assert.strictEqual(roomFromMonths(oct, [1.5], 7).room, 5.5);
  /* 9 days across Oct/Nov with nothing used: 4 + 5, all within the cap of each month */
  const across = monthSegments("2026-10-28", "2026-11-05");
  assert.strictEqual(roomFromMonths(across, [0, 0], 7).room, 9);
  /* October already has 5 away: only 2 of its 4 days are room, November's 5 all are */
  assert.strictEqual(roomFromMonths(across, [5, 0], 7).room, 7);
  /* non-Odisha cap of 10 */
  assert.strictEqual(roomFromMonths(oct, [0], 10).room, 9);
});

test("a CL is held to both caps inside each month", () => {
  const across = monthSegments("2026-09-28", "2026-10-06");
  /* September is full on days away (7 of 7): no CL there, whatever CL is left; October gives 3 CL */
  assert.strictEqual(roomFromMonths(across, [7, 0], 7, [{ cap: 3, used: [0, 0] }]).room, 3);
  /* 2 CL already in October: 1 more there */
  assert.strictEqual(roomFromMonths(across, [0, 2], 7, [{ cap: 3, used: [0, 2] }]).room, 4);
});
