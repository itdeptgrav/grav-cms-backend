// scripts/employeeShiftForm_test.js — what the employee form's Work Shift
// dropdown POSTs, through the real Employee schema, into shiftPolicy.
// Run: node scripts/employeeShiftForm_test.js
// What the new-employee form POSTs -> the real Employee schema -> shiftPolicy.
const path=require('path'); const ROOT=path.join(__dirname,'..');
const Employee = require('../models/Employee');
const P = require('../services/shiftPolicy');
const S = {
  workingDays:[1,2,3,4,5,6],
  shifts:{ executive:{start:"09:30",end:"18:30",lateGraceMins:10,halfDayThresholdMins:450,otGraceMins:60},
           operator:{start:"09:00",end:"18:00",lateGraceMins:10,halfDayThresholdMins:390,otGraceMins:15},
           custom:{lateGraceMins:5,halfDayThresholdMins:270,halfDayBasis:'net',otGraceMins:45} },
  departmentCategories:{ core:['PRODUCTION'], general:['IT'] },
  executiveDesignations:[], operatorDesignations:[],
  nonWorkingDay:{ halfDayThresholdMins:240, basis:'net' },
};

const cases = [
  ['Custom 06:00-14:00', { workShift:{ mode:'custom', start:'06:00', end:'14:00' } }],
  ['Core',               { workShift:{ mode:'core' } }],
  ['General',            { workShift:{ mode:'general' } }],
  // Not a choice on the form any more — the dropdown has exactly three and
  // one must be picked. This is the pre-categories fallback, kept so an
  // employee the backfill has not reached yet is judged the way they were
  // yesterday instead of silently landing on office hours.
  ['pre-backfill (dept)', { department:'PRODUCTION' }],
];

for (const [label, body] of cases) {
  const doc = new Employee({
    firstName:'T', lastName:'U', email:`t${Math.random()}@x.io`, phone:'9999999999',
    department:'HOUSEKEEPING', designation:'Housekeeper', gender:'male', ...body,
  });
  const err = doc.validateSync();
  const saved = doc.toObject();
  const sh = P.resolveShift(saved, S);
  const stored = saved.workShift
    ? JSON.stringify({ mode: saved.workShift.mode, start: saved.workShift.start, end: saved.workShift.end })
    : '(none)';
  console.log(`  ${label.padEnd(20)} validate=${err ? 'FAIL '+err.message : 'ok'}`);
  console.log(`      stored   ${stored}`);
  console.log(`      resolves ${sh.start}-${sh.end}  mode=${sh.mode}  from=${sh.source}  grace=${sh.lateGraceMins}`);
}

// And the one that matters: does an invalid mode get rejected rather than stored?
const bad = new Employee({ firstName:'T', lastName:'U', email:'b@x.io', phone:'9', gender:'male', workShift:{ mode:'nonsense' } });
const berr = bad.validateSync();
console.log(`\n  invalid mode "nonsense" -> ${berr ? 'rejected by schema (good)' : '*** ACCEPTED — enum not enforced ***'}`);
