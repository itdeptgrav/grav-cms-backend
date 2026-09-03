// verifyPayrollLadder.js
//
// The late ladder reaches pay, and a national holiday is paid in full.
//
// Run:  node -r dotenv/config verifyPayrollLadder.js        (READ-ONLY)
//
// THE GAP THIS PINS
// LHD / LAB are derived at read time and never stored, and payroll read the
// stored systemPrediction. So the timecard showed a 3rd late docked to a half
// day while the payslip paid it as a full present day. Payroll now replays the
// same ladder, with the same policy, in the same order.
//
// Nothing is written: it builds the real August context and computes payroll
// in memory for two employees the attendance harness already named.

"use strict";

const mongoose = require("mongoose");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const P = require("./routes/HrRoutes/Payroll_section");
  const A = require("./routes/HrRoutes/Attendance_section");
  const Employee = require("./models/Employee");
  const { decryptEmployeeDoc } = require("./utils/salaryEncryption");

  const ctx0 = await P.loadMonthContext(8, 2026);
  check("the month context now carries the late policy", Boolean(ctx0.latePolicy), JSON.stringify(ctx0.latePolicy));
  check("and the policy is enabled with the 3/5 ladder",
    ctx0.latePolicy?.enabled === true && ctx0.latePolicy.lateHDOnCount === 3 && ctx0.latePolicy.lateFullDayOnCount === 5,
    JSON.stringify(ctx0.latePolicy));

  const runFor = async (bid, mutate) => {
    const raw = await Employee.findOne({ biometricId: bid }).lean();
    if (!raw) return null;
    const emp = decryptEmployeeDoc(raw);
    let byDate = ctx0.attendanceByEmp.get(bid) || new Map();
    if (mutate) byDate = mutate(new Map(byDate));
    const ctx = { month: 8, year: 2026, settings: ctx0.settings, salaryCfg: ctx0.salaryCfg,
      holidayMap: ctx0.holidayMap, leaveConfig: ctx0.leaveConfig, attendanceByDate: byDate,
      leaveBalance: null, latePolicy: ctx0.latePolicy };
    const item = P.computeEmployeePayroll(emp, ctx);
    const day = (d) => (item.dayBreakdown || []).find((x) => x.dateStr === `2026-08-${d}`);
    return { emp, item, day };
  };

  console.log("RAKESH BISWAL (GR0045) — pardoned 7th/11th/12th, so the 31st is the next 3rd");
  const rk = await runFor("GR0045");
  check("employee found", Boolean(rk));
  if (rk) {
    const d18 = rk.day("18"), d31 = rk.day("31");
    check("18 Aug is NOT docked (it used to be treated as the 3rd late)",
      d18 && d18.lopWeight === 0 && d18.paid === true, d18 && `${d18.rawStatus}/${d18.category}/lop=${d18.lopWeight}`);
    check("31 Aug is the 3rd late → half day in PAY, not just on screen",
      d31 && d31.rawStatus === "LHD" && d31.category === "HD" && d31.lopWeight === 0.5,
      d31 && `${d31.rawStatus}/${d31.category}/lop=${d31.lopWeight}`);
    const d7 = rk.day("07");
    check("the HR-pardoned 7th stays exactly as HR set it", d7 && d7.rawStatus === "P" && d7.lopWeight === 0, d7 && d7.rawStatus);
  }

  console.log("\nRANI TUDU (GR0054) — six pardons, the 10th raw late is the next 5th");
  const rt = await runFor("GR0054");
  if (rt) {
    const d24 = rt.day("24"), d25 = rt.day("25"), d26 = rt.day("26");
    check("24 Aug is not docked", d24 && d24.lopWeight === 0, d24 && `${d24.rawStatus}/lop=${d24.lopWeight}`);
    check("25 Aug is the 5th → full absence in pay", d25 && d25.rawStatus === "LAB" && d25.category === "AB" && d25.lopWeight === 1,
      d25 && `${d25.rawStatus}/${d25.category}/lop=${d25.lopWeight}`);
    check("26 Aug restarts the count (not docked)", d26 && d26.lopWeight === 0, d26 && `${d26.rawStatus}/lop=${d26.lopWeight}`);
  } else check("RANI TUDU found", false);

  console.log("\nIndependence Day — as stored today, and after the resync rule");
  /* Somebody who actually PUNCHED that day and is stored as HD — the 41 people
     the bug hit. RAKESH did not punch, so he was already NH via the
     holiday-injected row and would have made this a no-op check. */
  const punchedBid = [...ctx0.attendanceByEmp.entries()]
    .find(([, m]) => { const r = m.get("2026-08-15"); return r && (r.punchCount || 0) > 0 && r.systemPrediction === "HD"; })?.[0];
  check("found an employee stored as HD for punching on Independence Day", Boolean(punchedBid), punchedBid);
  const before = await runFor(punchedBid || "GR0045");
  const b15 = before?.day("15");
  console.log(`  ${punchedBid}: as stored now: ${b15?.rawStatus}/${b15?.category} paid=${b15?.paid} lop=${b15?.lopWeight}  (this is what the resync will correct)`);
  check("before the resync, payroll docks that day as a half day", b15 && b15.category === "HD" && b15.lopWeight === 0.5,
    b15 && `${b15.rawStatus}/${b15.category}/lop=${b15.lopWeight}`);
  const after = await runFor(punchedBid || "GR0045", (m) => {
    const row = m.get("2026-08-15");
    if (row) m.set("2026-08-15", A.applyNationalHolidayRule(row, "NH"));
    return m;
  });
  const a15 = after?.day("15");
  check("after the rule, the day is NH", a15 && a15.rawStatus === "NH" && a15.category === "NH", a15 && `${a15.rawStatus}/${a15.category}`);
  check("and it is paid in full with no deduction", a15 && a15.paid === true && a15.lopWeight === 0);
  check("the worked minutes survive onto the payslip breakdown", a15 && a15.netWorkMins === (b15?.netWorkMins || 0));
  check("net pay is not lower than before for that day",
    after && before && after.item.netPay >= before.item.netPay,
    after && before && `${before.item.netPay} → ${after.item.netPay}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("\nharness crashed:", e.message, (e.stack || "").split("\n")[1] || "");
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
