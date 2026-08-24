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
  nonWorkingDay: { halfDayThresholdMins: 210, basis: "span" },
  departmentCategories: { core:["PRODUCTION"], general:["IT"] },
};

// Mirror the PUT /settings handler's update construction.
const update = {};
if (posted.shifts) update.shifts = posted.shifts;
if (posted.nonWorkingDay) update.nonWorkingDay = posted.nonWorkingDay;
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
console.log('stored nonWorkingDay  :', JSON.stringify(saved.nonWorkingDay));

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

// And the day-off threshold HR set.
const sun = P.classifyDayKind('2026-08-30', saved, {});
const r200 = P.classifyDay({ inMins:540, outMins:740, netMins:200, spanMins:200, shift:sh, settings:saved, day:sun });
const r220 = P.classifyDay({ inMins:540, outMins:760, netMins:220, spanMins:220, shift:sh, settings:saved, day:sun });
console.log('\nSunday, 200 mins ->', r200.status, '| 220 mins ->', r220.status, '(HR set the line at 210)');
console.log('  ', r200.status==='HD' && r220.status==='P' ? 'PASS' : '*** FAIL ***');
