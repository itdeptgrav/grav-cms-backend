// verifyLeaveEditSplit.js
//
// Editing a leave application does not quietly change what it pays, and the
// split editor shows the leave that was actually applied for.
//
// Run:  node verifyLeaveEditSplit.js     (no database, no network, no writes)
//
// WHAT WAS WRONG
// Reported as a UI bug — "they applied for PL, the edit screen shows CL" —
// and it was, three times over. Underneath it the data was worse:
//
//   · PUT /manager/:id/edit destructured only dates/reason/half-day and then
//     set `paidDays = totalDays, lwpDays = 0`. The split the manager had just
//     dragged was thrown away, AND any edit at all — a typo in the reason —
//     turned a 3-paid + 2-LWP application into 5 paid. Payroll reads paidDays.
//
//   · PUT /:id (the employee editing their own) set totalDays and never
//     touched paidDays, so shortening a 5-day leave to 2 left 3 paid days on a
//     2-day row.
//
//   · The app bounded the editor with the MANAGER's balance and monthly CL
//     cap, which is nobody's entitlement but the manager's.

"use strict";

const fs = require("fs");
const path = require("path");

let pass = 0;
let fail = 0;
const check = (n, ok, d = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${n}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`);
  }
};
const head = (t) => console.log(`\n${t}`);

const ROUTE_PATH = path.join(
  __dirname, "routes", "Employee_Routes", "leaveRoutes.js",
);
/* Normalised: this checkout has CRLF endings, and a needle written with a
   bare newline never matches one preceded by a carriage return. Every
   search below is line-based, so the endings are taken out first. */
const ROUTE = fs.readFileSync(ROUTE_PATH, "utf8").split("\r\n").join("\n");

/* Lift the two split blocks out of the routes and run them, so this checks the
   arithmetic that ships rather than a restatement of it. */
function liftManagerSplit() {
  /* Anchored on the newline: the apply route has the same declaration one
     indent level deeper, and a 4-space needle matches inside 6 spaces. */
  const start = ROUTE.indexOf("\n    let paidDays, lwpDays;");
  const tail = ROUTE.indexOf("lwpDays = Math.round((totalDays - paidDays)", start);
  const end = ROUTE.indexOf("\n    }\n", tail);
  if (start === -1 || tail === -1 || end === -1) return null;
  const body = ROUTE.slice(start, end + "\n    }\n".length);
  return Function(
    "nType", "totalDays", "paidIn", "a", "res",
    `${body}; return { paidDays, lwpDays };`,
  );
}

const mgrSplit = liftManagerSplit();
head("the manager edit honours the split it is given");
check("the manager split block was found in the route", !!mgrSplit);

if (mgrSplit) {
  // `res` only matters on the invalid-input path; a throwing stub proves the
  // valid cases never reach it.
  const res = { status: () => ({ json: () => { throw new Error("rejected"); } }) };
  const run = (type, total, paidIn, row = {}) =>
    mgrSplit(type, total, paidIn, row, res);

  check(
    "an explicit 3-of-5 split is kept",
    JSON.stringify(run("CL", 5, 3)) === JSON.stringify({ paidDays: 3, lwpDays: 2 }),
    JSON.stringify(run("CL", 5, 3)),
  );
  check(
    "a split of zero paid days is kept, not read as 'unset'",
    JSON.stringify(run("PL", 4, 0)) === JSON.stringify({ paidDays: 0, lwpDays: 4 }),
    JSON.stringify(run("PL", 4, 0)),
  );
  check(
    "no split sent keeps what the row already had",
    JSON.stringify(run("CL", 5, undefined, { paidDays: 3 })) ===
      JSON.stringify({ paidDays: 3, lwpDays: 2 }),
    "this is the typo-in-the-reason case that used to reset it to 5 paid",
  );
  check(
    "a row with no split at all defaults to fully paid",
    JSON.stringify(run("CL", 5, undefined, {})) ===
      JSON.stringify({ paidDays: 5, lwpDays: 0 }),
  );
  check(
    "a split larger than the leave is clamped to it",
    JSON.stringify(run("CL", 2, 5)) === JSON.stringify({ paidDays: 2, lwpDays: 0 }),
    JSON.stringify(run("CL", 2, 5)),
  );
  check(
    "shortening the dates clamps a split that no longer fits",
    JSON.stringify(run("CL", 2, undefined, { paidDays: 5 })) ===
      JSON.stringify({ paidDays: 2, lwpDays: 0 }),
  );
  check(
    "half days survive",
    JSON.stringify(run("CL", 0.5, 0.5)) ===
      JSON.stringify({ paidDays: 0.5, lwpDays: 0 }),
    JSON.stringify(run("CL", 0.5, 0.5)),
  );
  check(
    "LOP is wholly unpaid whatever is sent",
    JSON.stringify(run("LOP", 3, 3)) === JSON.stringify({ paidDays: 0, lwpDays: 3 }),
  );
  let rejected = false;
  try { run("CL", 5, -1); } catch (_) { rejected = true; }
  check("a negative split is refused rather than stored", rejected);
  rejected = false;
  try { run("CL", 5, "abc"); } catch (_) { rejected = true; }
  check("so is a non-number", rejected);
}

// ── the employee's own edit ─────────────────────────────────────────────────
head("the employee's own edit keeps the split consistent with the dates");
check(
  "shortening clamps paidDays to the new length",
  /a\.paidDays = Math\.min\(Math\.max\(0, wasPaid\), nt\);/.test(ROUTE),
  "totalDays used to move while paidDays stayed put",
);
check(
  "and LWP takes the remainder",
  /a\.lwpDays = Math\.round\(\(nt - a\.paidDays\) \* 2\) \/ 2;/.test(ROUTE),
);
check(
  "LOP stays wholly unpaid there too",
  /if \(a\.leaveType === "LOP"\) \{\s*\n\s*a\.paidDays = 0;\s*\n\s*a\.lwpDays = nt;/.test(ROUTE),
);

// ── the applicant's balance reaches the manager ─────────────────────────────
head("the manager is shown the applicant's balance, not their own");
check(
  "pending approvals carry applicantBalance",
  /async function applicantBalances\(rows\)/.test(ROUTE) &&
    /\.then\(applicantBalances\)/.test(ROUTE),
);
check(
  "days this application already holds are added back",
  /heldByThisApplication: mine/.test(ROUTE),
  "otherwise a manager could not leave the split where the employee put it",
);
check(
  "a balance that cannot be read does not hide the approval",
  /catch \(_\) \{[\s\S]{0,200}return r;/.test(ROUTE),
);

// ── the screen ──────────────────────────────────────────────────────────────
head("the split editor shows the leave that was applied for");
const SCREEN_PATH = path.join(
  __dirname, "..", "App", "src", "screens", "LeaveScreen.js",
);
if (!fs.existsSync(SCREEN_PATH)) {
  check("the leave screen is where this expects it", false, SCREEN_PATH);
} else {
  const S = fs.readFileSync(SCREEN_PATH, "utf8").split("\r\n").join("\n");

  check(
    "the CL row renders only for a CL application",
    /\{editType === "CL" && \(\s*\n\s*<SplitRow/.test(S),
    "it used to render unconditionally, which is the reported bug",
  );
  check(
    "the PL row renders for a PL application",
    /\{editType === "PL" && \(\s*\n\s*<SplitRow/.test(S),
  );
  check(
    "the split is no longer hidden from primary managers",
    !/editDays > 0 && isSecondaryMgr/.test(S) &&
      /editDays > 0 && \(editType === "CL" \|\| editType === "PL"\)/.test(S),
    "a primary manager acts on `pending`, which is when it most needs adjusting",
  );
  check(
    "the days open in the bucket the leave was applied under",
    /if \(editType === "PL"\) \{\s*\n\s*setEditSplit\(\{ CL: 0, PL:/.test(S),
    "the reset effect used to fill CL first whatever the type",
  );
  check(
    "the bounds come from the applicant's balance",
    /const editApplicantBal = editTarget\?\.applicantBalance \|\| null;/.test(S) &&
      /editApplicantBal\.maxCLPerMonth \?\? maxCLPerMonth/.test(S),
  );
  check(
    "with the application's own length as the fallback, not the manager's balance",
    !/Math\.min\(avail\.PL \|\| 0, editOriginalPaid\)/.test(S),
  );
  check(
    "the split is sent by whichever manager is editing",
    /editType === "CL" \|\| editType === "PL"\s*\n?\s*\? \{ paidDays: editSplit\.CL \+ editSplit\.PL \}/.test(S),
  );
  check(
    "a derived leaveType is no longer sent",
    !/leaveType: isSecondaryMgr \? editPrimaryType/.test(S),
    "an all-LOP PL application was being sent as CL",
  );
  check(
    "and the bindings that only served the old behaviour are gone",
    !/isSecondaryMgr/.test(S) && !/const editPrimaryType/.test(S),
  );
}

// ── the same bug on the apply side ───────────────────────────────
head("applying files the type the employee picked");
if (fs.existsSync(SCREEN_PATH)) {
  const S = fs.readFileSync(SCREEN_PATH, "utf8").split("\r\n").join("\n");
  check(
    "the apply payload sends form.leaveType",
    /leaveType: form\.leaveType,/.test(S),
  );
  check(
    "the split-derived primaryType is gone",
    !/const primaryType = split\.CL >= split\.PL/.test(S),
    "an empty split made 0 >= 0 true, so PL was filed as CL",
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
