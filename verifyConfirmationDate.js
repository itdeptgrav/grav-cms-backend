// verifyConfirmationDate.js
//
// Confirmation date = joining date + probation, unless somebody says otherwise.
//
// Run:  node -r dotenv/config verifyConfirmationDate.js
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
// The three fields are one fact written three ways. The HR form now fills the
// third as you type the first two, and the server fills it for every other
// door — the spreadsheet import, a direct API call — because the form was
// never the only way an employee gets created. 84 of the 91 active employees
// in this database have no confirmation date at all, with a joining date
// sitting right beside the empty column.
//
// Two things have to hold, and they pull against each other:
//
//   1. a blank is filled, everywhere an employee can be created;
//   2. a date that IS there is never touched — a confirmation brought forward
//      or pushed back is a decision somebody made, and recomputing over it
//      would erase that decision without saying so.
//
// The month arithmetic gets its own section because `setMonth(+n)` is wrong in
// a way that looks right: 31 January plus one month is 3 March, not 28
// February. Four of the seven cases below differ between the two methods, and
// every one of them is an employee joining at the end of a long month.
//
// PURE. No database, no network, no writes — the counts at the end are read
// only if a connection is available.

"use strict";

const {
  addMonths,
  deriveConfirmationDate,
  fillConfirmationDate,
} = require("./services/confirmationDate.service");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);

(async () => {
  console.log("\nmonths are added the way a calendar does, not the way Date does");
  /* `naive` is what setMonth gives, kept beside each case so the difference is
     visible rather than asserted about. */
  const naive = (s, n) => {
    const d = new Date(s);
    d.setMonth(d.getMonth() + n);
    return d.toISOString().slice(0, 10);
  };
  const cases = [
    ["2026-01-15", 6, "2026-07-15", "ordinary"],
    ["2026-01-31", 1, "2026-02-28", "31 Jan + 1 month"],
    ["2024-01-31", 1, "2024-02-29", "same, in a leap year"],
    ["2026-08-31", 6, "2027-02-28", "crosses a year and overflows"],
    ["2026-11-30", 3, "2027-02-28", "the 30th into February"],
    ["2026-03-10", 0, "2026-03-10", "no probation — same day"],
    ["2026-05-15", 12, "2027-05-15", "a full year"],
  ];
  let differ = 0;
  for (const [start, n, want, label] of cases) {
    const got = iso(addMonths(start, n));
    if (naive(start, n) !== want) differ += 1;
    check(`${start} + ${n}m = ${want}  (${label})`, got === want, got);
  }
  console.log(`        setMonth() would be wrong in ${differ} of these ${cases.length}`);

  console.log("\nwhat cannot be worked out is left blank, not guessed");
  check("no joining date -> null", deriveConfirmationDate(null, 6) === null);
  check("a nonsense probation -> null", deriveConfirmationDate("2026-01-01", "soon") === null);
  check("a negative probation -> null", deriveConfirmationDate("2026-01-01", -3) === null);
  check("no probation is zero months, not unknown",
    iso(deriveConfirmationDate("2026-01-01", undefined)) === "2026-01-01");

  console.log("\nit fills a blank and never overwrites");
  const blank = { dateOfJoining: new Date("2026-01-31"), probationPeriod: 6 };
  check("a blank is filled", fillConfirmationDate(blank) === true);
  check("with the right date", iso(blank.confirmationDate) === "2026-07-31", iso(blank.confirmationDate));

  const decided = {
    dateOfJoining: new Date("2026-01-31"),
    probationPeriod: 6,
    confirmationDate: new Date("2026-04-01"), // brought forward by somebody
  };
  check("a date already set is NOT touched", fillConfirmationDate(decided) === false);
  check("and keeps exactly what it had",
    iso(decided.confirmationDate) === "2026-04-01", iso(decided.confirmationDate));

  const unknowable = { probationPeriod: 6 };
  check("nothing to work from -> nothing written",
    fillConfirmationDate(unknowable) === false && !unknowable.confirmationDate);

  console.log("\nevery door an employee comes through uses it");
  const fs = require("fs");
  const create = fs.readFileSync("routes/HrRoutes/Employee-Section.js", "utf8");
  check("the create route fills it", /fillConfirmationDate\(employeeData\)/.test(create));
  const imp = fs.readFileSync("routes/HrRoutes/employeeImportExport.js", "utf8");
  check("the spreadsheet import derives it when the sheet is silent",
    /deriveConfirmationDate\(row\.dateOfJoining, row\.probationPeriod\)/.test(imp));
  check("and a value in the sheet still wins",
    /row\.confirmationDate \|\|\s*\n?\s*deriveConfirmationDate/.test(imp));

  /* ── how much of the existing data this would explain ─────────────────── */
  try {
    const mongoose = require("mongoose");
    await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
    const E = mongoose.connection.db.collection("employees");
    const active = await E.countDocuments({ isActive: true });
    const blankConf = await E.countDocuments({
      isActive: true,
      $or: [{ confirmationDate: null }, { confirmationDate: { $exists: false } }],
    });
    const derivable = await E.countDocuments({
      isActive: true,
      $or: [{ confirmationDate: null }, { confirmationDate: { $exists: false } }],
      dateOfJoining: { $ne: null },
    });
    console.log(`\n${active} active employees · ${blankConf} with no confirmation date · ${derivable} of those could be derived`);
    console.log("(existing records are NOT touched by this change — new ones and imports are)");
    await mongoose.disconnect();
  } catch {
    console.log("\n(no database available — skipped the count)");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
