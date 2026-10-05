"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildLeaveDateMap } = require("./leaveDateMap");

const codes = (app, holidays = null) => Object.fromEntries(buildLeaveDateMap(app, holidays));

/* ── Half days — the bug ──────────────────────────────────────────────────*/

test("an approved half-day sick leave is P/SL, not a whole day of L-SL", () => {
  /* The shape of every one of the twelve live records checked: one date,
     totalDays 0.5, paidDays 0.5. The old loop read 0 < 0.5 and gave it L-SL. */
  assert.deepEqual(
    codes({ leaveType: "SL", fromDate: "2026-09-11", toDate: "2026-09-11",
            isHalfDay: true, totalDays: 0.5, paidDays: 0.5 }),
    { "2026-09-11": "P/SL" },
  );
});

test("half-day CL and PL get their half codes too", () => {
  const half = (leaveType) => codes({ leaveType, fromDate: "2026-09-09", toDate: "2026-09-09",
                                      isHalfDay: true, totalDays: 0.5, paidDays: 0.5 });
  assert.deepEqual(half("CL"), { "2026-09-09": "P/CL" });
  assert.deepEqual(half("PL"), { "2026-09-09": "P/PL" });
});

test("an unpaid half day is P/LWP, not a whole day of LWP", () => {
  /* Approved as a half day with no balance behind it — the 30 Jun 2026 CL on
     the record this was found from: paidDays 0, lwpDays 0.5. */
  assert.deepEqual(
    codes({ leaveType: "CL", fromDate: "2026-06-30", toDate: "2026-06-30",
            isHalfDay: true, totalDays: 0.5, paidDays: 0, lwpDays: 0.5 }),
    { "2026-06-30": "P/LWP" },
  );
});

test("a half day of LOP is P/LWP", () => {
  assert.deepEqual(
    codes({ leaveType: "LOP", fromDate: "2026-09-09", toDate: "2026-09-09",
            isHalfDay: true, totalDays: 0.5, paidDays: 0 }),
    { "2026-09-09": "P/LWP" },
  );
});

test("a half day on a Sunday is still a rest day", () => {
  /* 2026-09-06 is a Sunday. */
  assert.deepEqual(
    codes({ leaveType: "SL", fromDate: "2026-09-06", toDate: "2026-09-06",
            isHalfDay: true, totalDays: 0.5, paidDays: 0.5 }),
    {},
  );
});

test("a half day on a holiday is still a rest day", () => {
  assert.deepEqual(
    codes({ leaveType: "SL", fromDate: "2026-10-02", toDate: "2026-10-02",
            isHalfDay: true, totalDays: 0.5, paidDays: 0.5 },
          new Set(["2026-10-02"])),
    {},
  );
});

/* ── Full days — must be exactly what they were ───────────────────────────*/

test("a one-day full leave is unchanged", () => {
  assert.deepEqual(
    codes({ leaveType: "SL", fromDate: "2026-07-30", toDate: "2026-07-30",
            isHalfDay: false, totalDays: 1, paidDays: 1 }),
    { "2026-07-30": "L-SL" },
  );
});

test("a multi-day leave skips Sunday and spends paid days in order", () => {
  /* 6 Jun 2026 is a Saturday, 7th a Sunday, 8th a Monday. */
  assert.deepEqual(
    codes({ leaveType: "CL", fromDate: "2026-06-06", toDate: "2026-06-08",
            isHalfDay: false, totalDays: 2, paidDays: 2 }),
    { "2026-06-06": "L-CL", "2026-06-08": "L-CL" },
  );
});

test("days beyond the paid ones become LWP, as before", () => {
  assert.deepEqual(
    codes({ leaveType: "CL", fromDate: "2026-09-07", toDate: "2026-09-09",
            isHalfDay: false, totalDays: 3, paidDays: 1 }),
    { "2026-09-07": "L-CL", "2026-09-08": "LWP", "2026-09-09": "LWP" },
  );
});

test("a full LOP is LWP throughout, as before", () => {
  assert.deepEqual(
    codes({ leaveType: "LOP", fromDate: "2026-09-07", toDate: "2026-09-08",
            isHalfDay: false, totalDays: 2, paidDays: 0 }),
    { "2026-09-07": "LWP", "2026-09-08": "LWP" },
  );
});

test("PL is L-EL, as before", () => {
  assert.deepEqual(
    codes({ leaveType: "PL", fromDate: "2026-09-07", toDate: "2026-09-07",
            isHalfDay: false, totalDays: 1, paidDays: 1 }),
    { "2026-09-07": "L-EL" },
  );
});
