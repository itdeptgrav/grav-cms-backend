"use strict";
// scripts/punchPattern_test.js
//
// A day is measured on two axes, and only one of them is the shift.
//
//   hours       when you are due in and out    -> the shift category
//   punches     how many times you touch the   -> set PER PERSON
//               reader in a day
//
// Both used to be read off the employee's DEPARTMENT. The hours moved onto
// the person first; the punch count follows here, and for the same reason:
// two people can both be on 06:00-14:00 and one of them punches out for lunch
// while the other does not. A housekeeper and a night guard are the pair that
// started this. Nothing about their hours says which is which, so nobody but
// HR can answer it, and they answer it on the person's own record.
//
// It matters because `hasMissPunch` is `punches < expected`. Expect six from
// somebody who makes two and EVERY one of their days is flagged for HR to
// clear by hand — which is why an unanswered custom shift falls back to 2.
//
// The count also decides how the day is measured: punch out for lunch and you
// have a break to exclude, so net time is the meaningful figure; touch the
// reader twice and there is nothing to exclude and the whole span is.
//
//   node scripts/punchPattern_test.js       (no DB, no network)

const {
  resolveEmployeeType,
  resolvePunchCount,
} = require("../routes/HrRoutes/Attendance_section");

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(52)} ${JSON.stringify(got)}` +
      (ok ? "" : `  (expected ${JSON.stringify(want)})`),
  );
}

// Departments deliberately point the OPPOSITE way from each employee's own
// category, so a test that passes can only be reading the person.
const settings = {
  shifts: { custom: {} },
  departmentCategories: { core: ["HOUSEKEEPING", "HR"], general: ["PRODUCTION"] },
  operatorDesignations: [],
  executiveDesignations: [],
};

console.log("\n=== the category answers it for Core and General ===");
check(
  "Core -> 2, even sitting in production",
  resolvePunchCount({ workShift: { mode: "core" }, department: "PRODUCTION" }, settings),
  2,
);
check(
  "General -> 6, even sitting in an office",
  resolvePunchCount({ workShift: { mode: "general" }, department: "HR" }, settings),
  6,
);

console.log("\n=== Custom is asked, per person ===");
const hk = (punches) => ({
  workShift: { mode: "custom", start: "06:00", end: "14:00", punches },
  department: "HOUSEKEEPING",
});
check("housekeeper set to 2", resolvePunchCount(hk(2), settings), 2);
check("night guard on the SAME hours set to 6", resolvePunchCount(hk(6), settings), 6);
check("somebody set to 4", resolvePunchCount(hk(4), settings), 4);
check("an odd number is honoured", resolvePunchCount(hk(3), settings), 3);
check("unanswered falls back to 2, not 6", resolvePunchCount(hk(undefined), settings), 2);
check("a nonsense value falls back too", resolvePunchCount(hk(0), settings), 2);

console.log("\n=== the count decides how the day is measured ===");
// >2 punches means a break is punched, so net-of-breaks is the real figure.
check("2 punches -> whole span", resolveEmployeeType(hk(2), settings), "executive");
check("4 punches -> net of breaks", resolveEmployeeType(hk(4), settings), "operator");
check("6 punches -> net of breaks", resolveEmployeeType(hk(6), settings), "operator");

console.log("\n=== an employee the backfill has not reached yet ===");
// No shift at all. Falls back to the department classification they were
// being measured by before any of this — not to a silent 2.
check(
  "no shift, HOUSEKEEPING is in the core list",
  resolvePunchCount({ department: "HOUSEKEEPING" }, settings),
  6,
);
check(
  "no shift, unlisted department",
  resolvePunchCount({ department: "NOWHERE" }, settings),
  2,
);

console.log("\n=== interns are people too ===");
// An intern is an Employee with a different pay arrangement. Nothing about
// the shift machinery treats them differently, and this proves it rather
// than assuming it.
check(
  "an intern on a custom 6-punch shift",
  resolvePunchCount(
    { employmentType: "intern", workShift: { mode: "custom", punches: 6 } },
    settings,
  ),
  6,
);
check(
  "an intern on Core",
  resolvePunchCount({ employmentType: "intern", workShift: { mode: "core" } }, settings),
  2,
);

console.log("\n=== and it reaches the day, not just the resolver ===");
// The count rides on the shift object into computeDay. Resolving it correctly
// and then failing to thread it through would look identical above and be
// worth nothing, so this drives the real classifier.
const { computeDay } = require("../routes/HrRoutes/Attendance_section");
const dayShift = { start: "06:00", end: "14:00", lateGraceMins: 10, halfDayThresholdMins: 240, otGraceMins: 30 };
const at = (h, m) => new Date(2026, 0, 5, h, m);
const twoPunches = [{ time: at(6, 0) }, { time: at(14, 0) }];

const asTwo = computeDay(twoPunches, "executive", { ...dayShift, expectedPunches: 2 }, {});
check("2 punches against a 2-punch day: complete", asTwo.hasMissPunch, false);

const asSix = computeDay(twoPunches, "operator", { ...dayShift, expectedPunches: 6 }, {});
check("the same 2 against a 6-punch day: flagged", asSix.hasMissPunch, true);

// The bug this guards: a 4-punch day where all four were made used to be told
// a tea punch was missing, because the middle-pair branch assumed 6.
const fourPunches = [
  { time: at(6, 0) }, { time: at(10, 0) }, { time: at(10, 30) }, { time: at(14, 0) },
];
const asFour = computeDay(fourPunches, "operator", { ...dayShift, expectedPunches: 4 }, {});
check("4 punches against a 4-punch day: complete", asFour.hasMissPunch, false);
check("  and nothing reported missing", asFour.missingPunchType, null);
check("  lunch break deducted", asFour.lunchBreakMins, 30);

const fourOfSix = computeDay(fourPunches, "operator", { ...dayShift, expectedPunches: 6 }, {});
check("the same 4 against a 6-punch day: flagged", fourOfSix.hasMissPunch, true);
check("  missing the tea pair", fourOfSix.missingPunchType, "tea_out");

console.log(
  failures === 0 ? "\nall checks passed.\n" : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
