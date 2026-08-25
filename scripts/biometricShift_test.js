// scripts/biometricShift_test.js — drives the real sync pipeline with the
// models stubbed, so the four rows below are what would be written to Mongo.
// Run: node scripts/biometricShift_test.js
const path = require('path'); const ROOT = path.join(__dirname, '..'); const Module = require('module');
const written = [];
const EMPS = [
  { _id:'h1', biometricId:'GR0900', firstName:'Sita', lastName:'Devi', department:'HOUSEKEEPING',
    designation:'Housekeeper', workShift:{ mode:'custom', start:'06:00', end:'14:00' } },
  { _id:'o1', biometricId:'GR0067', firstName:'Soumya', lastName:'P', department:'IT',
    designation:'IT EXECUTIVE' },
];
const SETTINGS = {
  workingDays:[1,2,3,4,5,6],
  shifts:{ executive:{start:"09:30",end:"18:30",lateGraceMins:10,halfDayThresholdMins:450,otGraceMins:60},
           operator:{start:"09:00",end:"18:00",lateGraceMins:10,halfDayThresholdMins:390,otGraceMins:15},
           custom:{lateGraceMins:10,halfDayThresholdMins:300,halfDayBasis:'net',otGraceMins:30} },
  departmentCategories:{ core:['PRODUCTION'], general:['IT'] },
  executiveDesignations:[], operatorDesignations:[],
  nonWorkingDay:{ halfDayThresholdMins:240, basis:'net' },
};
const HOLIDAYS = [{ date:'2026-08-23', type:'working_sunday', name:'Swap for 17 Aug' }];
const stubs = {
  [path.join(ROOT,'models/Employee.js')]: { find:()=>({ select:()=>({ lean: async()=>EMPS }) }) },
  [path.join(ROOT,'models/HR_Models/Attendancesettings.js')]: { getConfig: async()=>SETTINGS },
  [path.join(ROOT,'models/HR_Models/Attendance.js')]: {
    findOneAndUpdate: async (q,u) => { written.push({ key:`${q.biometricId} ${q.dateString}`, ...u.$set }); return {}; },
  },
};
const realResolve=Module._resolveFilename, realLoad=Module._load;
Module._load=function(req,parent,isMain){ let r; try{r=realResolve.call(Module,req,parent,isMain);}catch{r=null;}
  if(r&&stubs[r]) return stubs[r]; return realLoad.apply(Module,arguments); };
const mongoose = require(path.join(ROOT,'node_modules/mongoose'));
const realModel = mongoose.model.bind(mongoose);
mongoose.model = (n,...a) => (n==='CompanyHoliday' ? { find:()=>({ lean: async()=>HOLIDAYS }) } : realModel(n,...a));

const svc = require(path.join(ROOT,'services/BiometricSyncService.js'));
const punch=(code,name,d,h,m)=>({ Empcode:code, Name:name,
  PunchDate:`${String(d).padStart(2,'0')}/08/2026 ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00` });

const raw = [
  punch('GR0900','Sita',24,5,58), punch('GR0900','Sita',24,14,3),     // Mon, her shift exactly
  punch('GR0067','Soumya',24,9,55), punch('GR0067','Soumya',24,18,40),// Mon, 25 late
  punch('GR0900','Sita',23,6,5),  punch('GR0900','Sita',23,14,0),     // Sun 23 = declared WORKING
  punch('GR0067','Soumya',30,9,0), punch('GR0067','Soumya',30,17,0),  // Sun 30 = a real Sunday
];
(async () => {
  const recs = svc.processPunches(raw);
  await svc.upsertRecords(recs);
  console.log('');
  for (const w of written.sort((a,b)=>a.key.localeCompare(b.key))) {
    const rem = JSON.parse(w.remarks);
    console.log(`  ${w.key}  shift ${w.shiftStart}-${w.shiftEnd} (${rem.shiftMode}/${rem.shiftSource})`);
    console.log(`      status=${w.status.padEnd(16)} late=${w.isLate} (${w.lateByMinutes}m)  EO=${w.isEarlyDeparture} (${w.earlyByMinutes}m)  OT=${w.overtimeMinutes}m`);
    console.log(`      dayKind=${rem.dayKind}${rem.workingDayOverride?' (override)':''}  compOff=${rem.compOffEligible}`);
  }
})();
