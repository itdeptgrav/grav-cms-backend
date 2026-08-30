// scripts/settingsRoundTrip_test.js — proves the CMS settings form reaches the
// attendance engine: POST body -> PUT handler -> real schema -> shiftPolicy.
// Run: node scripts/settingsRoundTrip_test.js
// The full chain: what the settings form POSTs -> the PUT route -> what
// getConfig hands back -> what shiftPolicy does with it.
const path = require('path'); const ROOT = path.join(__dirname, '..'); const Module = require('module');
let stored = { _id: 'singleton' };
const AS = require(path.join(ROOT, 'models/HR_Models/Attendancesettings.js'));

// What the CMS settings page sends after HR sets a Custom tab + day-off rule.
const posted = {
  shifts: {
    operator:  { start:"09:00", end:"18:00", lateGraceMins:10, halfDayThresholdMins:390, otGraceMins:15 },
    executive: { start:"09:30", end:"18:30", lateGraceMins:10, halfDayThresholdMins:450, otGraceMins:60 },
    custom:    { lateGraceMins:5,  halfDayThresholdMins:270, halfDayBasis:"span", otGraceMins:45 },
  },
  departmentCategories: { core:["PRODUCTION"], general:["IT"] },
};

// Mirror the PUT /settings handler's update construction.
const update = {};
if (posted.shifts) update.shifts = posted.shifts;
if (posted.departmentCategories) update.departmentCategories = {
  core: posted.departmentCategories.core.map(d=>d.toUpperCase()),
  general: posted.departmentCategories.general.map(d=>d.toUpperCase()),
};

// Validate it against the real schema — this is what catches a field the
// model would silently drop.
const doc = new AS({ _id: 'singleton', ...update });
const err = doc.validateSync();
console.log('schema validation:', err ? 'FAILED — ' + err.message : 'clean');
const saved = doc.toObject();
console.log('stored shifts.custom  :', JSON.stringify(saved.shifts.custom));

const P = require(path.join(ROOT, 'services/shiftPolicy'));
const hk = { department:'HOUSEKEEPING', workShift:{ mode:'custom', start:'06:00', end:'14:00' } };
const sh = P.resolveShift(hk, saved);
console.log('\nresolved for housekeeping:');
console.log('  hours          ', sh.start + '-' + sh.end);
console.log('  late grace     ', sh.lateGraceMins, '(HR set 5)');
console.log('  HD threshold   ', sh.halfDayThresholdMins, 'on', sh.halfDayBasis, '(HR set 270 / span)');
console.log('  OT grace       ', sh.otGraceMins, '(HR set 45)');
const ok1 = sh.lateGraceMins===5 && sh.halfDayThresholdMins===270 && sh.halfDayBasis==='span' && sh.otGraceMins===45;
console.log('  ', ok1 ? 'PASS — the form reaches the engine' : '*** FAIL ***');

// The punch count is NOT on this tab. It is the one thing about a custom
// shift that does not follow from the hours — two people on 06:00-14:00 can
// punch two times or six — so it lives on the employee, and
// scripts/punchPattern_test.js covers it. Asserted here so a settings field
// cannot quietly reappear and start overruling the person.
console.log('\npunch count is not a setting:',
  saved.shifts.custom.punchPattern === undefined ? 'PASS' : '*** FAIL ***');

// A worked Sunday takes the SHIFT's threshold now, not a day-off one of its
// own — that setting is gone. HR set 270 on span for custom shifts above.
const sun = P.classifyDayKind('2026-08-30', saved, {});
const under = P.classifyDay({ inMins:360, outMins:620, netMins:260, spanMins:260, shift:sh, settings:saved, day:sun });
const over  = P.classifyDay({ inMins:360, outMins:640, netMins:280, spanMins:280, shift:sh, settings:saved, day:sun });
console.log('\nSunday, 260 mins ->', under.status, '| 280 mins ->', over.status, '(shift line is 270)');
console.log('  ', under.status==='HD' && over.status!=='HD' ? 'PASS' : '*** FAIL ***');
console.log('day-off settings are gone:',
  saved.nonWorkingDay === undefined ? 'PASS' : '*** FAIL ***');
