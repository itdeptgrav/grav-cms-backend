// verifyAttendanceRules.js
//
// Two attendance rules, checked against the real stored month.
//
// Run:  node -r dotenv/config verifyAttendanceRules.js        (READ-ONLY)
//
// 1. THE LATE LADDER DOES NOT SLIDE.
//    3rd raw late → half day, 4th → nothing, 5th → full absence, then the
//    count restarts. An HR pardon on a late day forgives THAT day's deduction
//    and nothing else: the day still counts, so the penalty cannot migrate to
//    the next late. Before this, a pardoned 3rd late dropped out of the count
//    and the 4th became "the 3rd" — the deduction moved instead of going away.
//
// 2. A NATIONAL HOLIDAY IS NH FOR EVERYONE.
//    Punching on Independence Day was classified from the punches like any
//    working day and stored as HD. NH now wins; punches are kept as evidence
//    (comp-off is HR's manual call); late/early/miss-punch are cleared because
//    no shift applies; HR overrides are never touched.
//
// Nothing is written. Stored rows are read and replayed through the exported
// functions; the resync itself is the existing /sync-period, which reuses the
// same functions.

"use strict";

const mongoose = require("mongoose");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

const POLICY = {
  enabled: true, lateHDOnCount: 3, lateFullDayOnCount: 5,
  earlyOutHDOnCount: 3, earlyOutFullDayOnCount: 5,
};
const TODAY = "2099-01-01"; // nothing in the data is "today"
const late = (over = {}) => ({ isLate: true, systemPrediction: "P*", hrFinalStatus: null, ...over });

/* The OLD behaviour, kept here only to show the slide it produced. */
function oldPromotion(entry, state, policy, dateStr, todayStr) {
  if (!policy?.enabled || entry.hrFinalStatus || dateStr === todayStr)
    return { promotedStatus: null, promoted: false };
  if (entry.isLate && entry.systemPrediction === "P*") {
    state.lateCount++;
    if (state.lateCount >= policy.lateFullDayOnCount) { state.lateCount = 0; return { promotedStatus: "LAB", promoted: true }; }
    if (state.lateCount === policy.lateHDOnCount) return { promotedStatus: "LHD", promoted: true };
  }
  return { promotedStatus: null, promoted: false };
}

function replay(fn, entries) {
  const state = { lateCount: 0, earlyCount: 0 };
  return entries.map((e, i) => {
    const r = fn(e, state, POLICY, e.dateStr || `2026-08-${String(i + 1).padStart(2, "0")}`, TODAY);
    return { ...e, outcome: e.hrFinalStatus ? `HR:${e.hrFinalStatus}` : (r.promotedStatus || "-"), count: state.lateCount };
  });
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);
  const db = mongoose.connection.db;
  const A = require("./routes/HrRoutes/Attendance_section");
  const { applyLateCountPromotion, applyNationalHolidayRule } = A;
  check("both rules are exported", typeof applyLateCountPromotion === "function" && typeof applyNationalHolidayRule === "function");

  /* ── 1a. the ladder, synthetically ─────────────────────────────────── */
  console.log("\nthe ladder: 3rd half day, 4th nothing, 5th absent, then restart");
  const six = replay(applyLateCountPromotion, [late(), late(), late(), late(), late(), late()]);
  check("1st and 2nd late: no deduction", six[0].outcome === "-" && six[1].outcome === "-");
  check("3rd late → LHD", six[2].outcome === "LHD", six[2].outcome);
  check("4th late → nothing", six[3].outcome === "-", six[3].outcome);
  check("5th late → LAB", six[4].outcome === "LAB", six[4].outcome);
  check("count restarts after the 5th", six[4].count === 0 && six[5].count === 1);

  console.log("\na pardon forgives the day, not the count");
  const pardoned = replay(applyLateCountPromotion, [late(), late(), late({ hrFinalStatus: "P" }), late(), late()]);
  check("the pardoned 3rd is left to HR", pardoned[2].outcome === "HR:P");
  check("the 4th is NOT docked (it used to become 'the 3rd')", pardoned[3].outcome === "-", pardoned[3].outcome);
  check("the 5th is still the 5th → LAB", pardoned[4].outcome === "LAB", pardoned[4].outcome);
  const slid = replay(oldPromotion, [late(), late(), late({ hrFinalStatus: "P" }), late(), late()]);
  check("(the old code did dock the 4th — this is the bug)", slid[3].outcome === "LHD", slid[3].outcome);

  console.log("\nedges");
  const todayRun = replay(applyLateCountPromotion, [late(), late(), late({ dateStr: TODAY })]);
  check("today's late is counted but never promoted", todayRun[2].outcome === "-" && todayRun[2].count === 3);
  const nh = replay(applyLateCountPromotion, [late(), late(), late({ systemPrediction: "NH", isLate: false })]);
  check("an NH day does not advance the count", nh[2].count === 2);
  const early = replay(applyLateCountPromotion, Array.from({ length: 5 }, () => ({ isEarlyDeparture: true, systemPrediction: "P~", hrFinalStatus: null })));
  check("early-out mirrors the ladder (3rd HD, 5th EAB)", early[2].outcome === "HD" && early[4].outcome === "EAB");

  /* ── 1b. the ladder, on the real month ─────────────────────────────── */
  console.log("\nAugust 2026, real stored days, before vs after");
  const days = await db.collection("dailyattendances").find({ yearMonth: "2026-08" }).sort({ dateStr: 1 })
    .project({ dateStr: 1, "employees.biometricId": 1, "employees.employeeName": 1, "employees.isLate": 1, "employees.isEarlyDeparture": 1, "employees.systemPrediction": 1, "employees.hrFinalStatus": 1 }).toArray();
  const per = new Map();
  for (const d of days) for (const e of d.employees || []) {
    if (!per.has(e.biometricId)) per.set(e.biometricId, { name: e.employeeName, seq: [] });
    per.get(e.biometricId).seq.push({ ...e, dateStr: d.dateStr });
  }
  let migrated = 0, samples = 0;
  for (const [bid, v] of per) {
    const before = replay(oldPromotion, v.seq), after = replay(applyLateCountPromotion, v.seq);
    const lates = after.filter((x) => x.isLate && ["P*", "LHD", "LAB"].includes(x.systemPrediction));
    if (lates.length < 3 || !lates.some((x) => x.hrFinalStatus)) continue;
    /* The slide: a day docked by the old code that sits right after a pardoned
       raw late, and is not docked by the new one. */
    const docked = (r) => r.filter((x) => x.outcome === "LHD" || x.outcome === "LAB").map((x) => x.dateStr);
    const b = docked(before), a = docked(after);
    if (b.join() !== a.join()) migrated += 1;
    if (samples < 3) {
      samples += 1;
      const fmt = (r) => r.filter((x) => x.isLate && ["P*", "LHD", "LAB"].includes(x.systemPrediction)).map((x, i) => `${i + 1}@${x.dateStr.slice(8)}${x.outcome !== "-" ? `[${x.outcome}]` : ""}`).join(" ");
      console.log(`  ${bid} ${v.name}\n     before: ${fmt(before)}\n     after : ${fmt(after)}`);
    }
  }
  check(`the pardon-slide affected real employees this month (${migrated} change under the fix)`, migrated > 0);

  /* ── 2. the national holiday, on the real day ──────────────────────── */
  console.log("\nIndependence Day 2026-08-15, as stored, replayed through the rule");
  const day = await db.collection("dailyattendances").findOne({ dateStr: "2026-08-15" });
  check("the day exists", Boolean(day));
  const rows = day?.employees || [];
  const punched = rows.filter((e) => (e.punchCount || 0) > 0);
  const wrongNow = punched.filter((e) => e.systemPrediction !== "NH");
  console.log(`  ${rows.length} rows, ${punched.length} punched, ${wrongNow.length} currently stored as something other than NH`);
  const fixed = punched.map((e) => applyNationalHolidayRule(e, "NH"));
  check("every punched row becomes NH", fixed.every((e) => e.systemPrediction === "NH"));
  check("and is paid in full", fixed.every((e) => e.attendanceValue === 1));
  check("punches are kept, not discarded", fixed.every((e, i) => e.punchCount === punched[i].punchCount && (e.rawPunches || []).length === (punched[i].rawPunches || []).length));
  check("worked minutes are kept for the comp-off decision", fixed.every((e, i) => e.netWorkMins === punched[i].netWorkMins && e.otMins === punched[i].otMins));
  check("late / early / miss-punch are cleared (no shift applies)", fixed.every((e) => !e.isLate && e.lateMins === 0 && !e.isEarlyDeparture && !e.hasMissPunch));
  check("punchedOnHoliday is set on every one", fixed.every((e) => e.punchedOnHoliday === true));
  const overrides = punched.filter((e) => e.hrFinalStatus).length;
  console.log(`  HR overrides among the punched: ${overrides} (none will be touched)`);
  const withHr = applyNationalHolidayRule({ ...punched[0], hrFinalStatus: "CO" }, "NH");
  check("an HR override on the day survives the rule and decides the pay weight", withHr.hrFinalStatus === "CO" && withHr.systemPrediction === "NH");
  const other = applyNationalHolidayRule({ ...punched[0] }, "FH");
  check("a COMPANY holiday is left alone — only national is forced", other.systemPrediction === punched[0].systemPrediction && other.punchedOnHoliday === undefined);
  const wo = applyNationalHolidayRule({ ...punched[0] }, "WO");
  check("a weekly off is left alone too", wo.systemPrediction === punched[0].systemPrediction);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("\nharness crashed:", e.message, (e.stack || "").split("\n")[1] || "");
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
