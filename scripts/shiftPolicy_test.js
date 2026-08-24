// scripts/shiftPolicy_test.js — the nine cases services/shiftPolicy.js exists for.
// Run: node scripts/shiftPolicy_test.js   (pure functions, no DB)
const P = require("../services/shiftPolicy");
const S = {
  workingDays: [1,2,3,4,5,6],
  shifts: {
    executive: { start:"09:30", end:"18:30", lateGraceMins:10, halfDayThresholdMins:450, otGraceMins:60 },
    operator:  { start:"09:00", end:"18:00", lateGraceMins:10, halfDayThresholdMins:390, otGraceMins:15 },
    custom:    { lateGraceMins:10, halfDayThresholdMins:300, otGraceMins:30 },
  },
  departmentCategories: { core: ["PRODUCTION"], general: ["IT","ACCOUNTS"] },
  executiveDesignations: [], operatorDesignations: [],
  nonWorkingDay: { halfDayThresholdMins: 240, basis: "net" },
};
const m = (h,mi=0)=>h*60+mi;
const row=(l,v)=>console.log('   ',l.padEnd(34), v);

console.log('\n=== 1. Housekeeping: 06:00–14:00 custom shift, works exactly that ===');
const hk = { department:'HOUSEKEEPING', workShift:{ mode:'custom', start:'06:00', end:'14:00' } };
let sh = P.resolveShift(hk, S);
row('resolved shift', `${sh.start}–${sh.end} (${sh.mode}, from ${sh.source})`);
let day = P.classifyDayKind('2026-08-24', S, {});   // a Monday
let r = P.classifyDay({ inMins:m(5,58), outMins:m(14,3), netMins:445, spanMins:485, shift:sh, settings:S, day });
row('status', r.status);  row('late / early-out', `${r.isLate} / ${r.isEarlyOut}`);
console.log(r.status==='P' && !r.isLate && !r.isEarlyOut ? '    PASS — no longer EO every day' : '    *** FAIL ***');

console.log('\n=== 2. Same person under the OLD company-wide 09:00–18:00 ===');
const old = P.resolveShift({ department:'PRODUCTION' }, S);
let ro = P.classifyDay({ inMins:m(5,58), outMins:m(14,3), netMins:445, spanMins:485, shift:old, settings:S, day });
row('status', ro.status); row('early-out mins', ro.earlyOutMins);
console.log(ro.isEarlyOut ? '    (this is the bug being fixed — EO by ' + ro.earlyOutMins + ' mins)' : '    ?');

// A worked Sunday USED to be exempt from the shift: no late, no early-out,
// its own half-day threshold. HR asked for that to go — a day worked is a day
// worked, measured like every other day, with the timings shown rather than
// suppressed. Two things survive, because neither is a measurement: comp-off
// is earned, and the whole attendance is overtime rather than only the part
// past the shift end.
console.log('\n=== 3. Sunday worked — judged against the shift, like any day ===');
const sun = P.classifyDayKind('2026-08-23', S, {});   // Sunday
row('day kind', sun.kind);
// Shift is 06:00–14:00. In at 07:10 is 70 mins late; out at 15:30 is not early.
let rs = P.classifyDay({ inMins:m(7,10), outMins:m(15,30), netMins:500, spanMins:500, shift:sh, settings:S, day:sun });
row('status', rs.status); row('late / early-out', `${rs.isLate} / ${rs.isEarlyOut}`);
row('late mins', rs.lateMins);
row('overtime mins', rs.otMins); row('comp-off eligible', rs.compOffEligible);
console.log(rs.status==='P*' && rs.isLate && rs.lateMins===70 && !rs.isEarlyOut
  && rs.otMins===500 && rs.compOffEligible
  ? '    PASS — late is shown, whole day is OT, comp-off still earned'
  : '    *** FAIL ***');

console.log('\n=== 3b. Sunday, left early — that shows too ===');
let rs1b = P.classifyDay({ inMins:m(6,0), outMins:m(12,0), netMins:360, spanMins:360, shift:sh, settings:S, day:sun });
row('status', rs1b.status); row('early-out mins', rs1b.earlyOutMins);
console.log(rs1b.status==='P~' && rs1b.earlyOutMins===120 ? '    PASS' : '    *** FAIL ***');

console.log('\n=== 4. Sunday half day — by the SHIFT threshold, not its own ===');
// The shift's threshold is what decides it now; there is no separate day-off
// number to fall below.
let rs2 = P.classifyDay({ inMins:m(9), outMins:m(12), netMins:180, spanMins:180, shift:sh, settings:S, day:sun });
row('shift threshold', sh.halfDayThresholdMins);
row('status', rs2.status);
console.log(rs2.status==='HD' ? '    PASS — half day on the shift threshold' : '    *** FAIL ***');

console.log('\n=== 5. Sunday nobody came ===');
let rs3 = P.classifyDay({ inMins:null, outMins:null, netMins:0, spanMins:0, shift:sh, settings:S, day:sun });
row('status', rs3.status); console.log(rs3.status==='WO' ? '    PASS' : '    *** FAIL ***');

console.log('\n=== 6. Swapped Sunday: HR declared it a working day ===');
const cal = { '2026-08-23': { type:'working_sunday', name:'Swap for 17 Aug' } };
const swp = P.classifyDayKind('2026-08-23', S, cal);
row('day kind', `${swp.kind} (override=${swp.override})`);
let rw = P.classifyDay({ inMins:m(6,40), outMins:m(14,0), netMins:440, spanMins:440, shift:sh, settings:S, day:swp });
row('status', rw.status); row('comp-off eligible', rw.compOffEligible);
console.log(swp.kind==='working' && rw.compOffEligible===false ? '    PASS — normal day, no double comp-off' : '    *** FAIL ***');

console.log('\n=== 7. Company holiday, nobody in / somebody in ===');
const hol = { '2026-08-25': { type:'company', name:'Festival' } };
const hk2 = P.classifyDayKind('2026-08-25', S, hol);
row('day kind', hk2.kind);
row('empty ->', P.classifyDay({ inMins:null,outMins:null,netMins:0,spanMins:0,shift:sh,settings:S,day:hk2 }).status);
const rh = P.classifyDay({ inMins:m(9),outMins:m(18),netMins:480,spanMins:540,shift:sh,settings:S,day:hk2 });
row('worked ->', `${rh.status}, OT ${rh.otMins}, comp-off ${rh.compOffEligible}`);

console.log('\n=== 8. Core office employee, late by 25 mins on a Tuesday ===');
const off = P.resolveShift({ department:'IT' }, S);
row('resolved', `${off.start}–${off.end} (${off.mode}, from ${off.source})`);
const rt = P.classifyDay({ inMins:m(9,55), outMins:m(18,40), netMins:525, spanMins:525, shift:off, settings:S, day });
row('status / lateMins', `${rt.status} / ${rt.lateMins}`);
console.log(rt.status==='P*' && rt.lateMins===25 ? '    PASS' : '    *** FAIL ***');

console.log('\n=== 9. Night shift 22:00–06:00 ===');
const nite = P.resolveShift({ workShift:{mode:'custom',start:'22:00',end:'06:00'} }, S);
row('overnight detected', nite.overnight);
const rn = P.classifyDay({ inMins:m(21,55), outMins:m(6,5), netMins:490, spanMins:490, shift:nite, settings:S, day });
row('status', rn.status); row('late / early-out', `${rn.isLate} / ${rn.isEarlyOut}`);
console.log(!rn.isLate && !rn.isEarlyOut ? '    PASS — not 16h of early departure' : '    *** FAIL ***');
