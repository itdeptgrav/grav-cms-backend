// scripts/cowork/sync-hr-inactive.js
//
// ONE PASS: BRING EVERY COWORK ACCOUNT INTO LINE WITH HR  (12 Oct 2026)
//
// From now on HR's Active/Inactive switches CoWork access as it changes
// (services/coworkHrAccess.service.js). People HR made Inactive BEFORE that
// are already refused by the token check and already shown as inactive in the
// directory — but their Firebase login is still on until they next try, and
// their CoWork record is not yet marked. This pass does that for all of them
// at once. It deletes nothing.
//
//   node -r dotenv/config scripts/cowork/sync-hr-inactive.js           # dry run: lists, writes nothing
//   node -r dotenv/config scripts/cowork/sync-hr-inactive.js --apply   # marks records, switches logins off
//
// Reactivation is reported too: an account HR switched off whose HR record is
// active again is switched back on by --apply.
"use strict";

const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error("MONGODB_URI is not set.");
  await mongoose.connect(uri);
  const { db, auth } = require("../../config/firebaseAdmin");
  const Employee = require("../../models/Employee");
  const A = require("../../services/coworkHrAccess.service");

  const snap = await db.collection("cowork_employees").get();
  const accounts = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  const hr = await Employee.find({}).select("firstName middleName lastName biometricId email personalEmail coworkEmployeeId isActive status").lean();
  const index = A.buildHrIndex(hr);

  const toOff = [], toOn = [], noHr = [];
  for (const a of accounts) {
    const standing = A.hrStanding(A.linkedHrFor(index, a.id, a.data));
    if (standing === "none") noHr.push(a);
    else if (standing === "inactive" && !(a.data.hrInactive && A.flaggedInactive(a.data))) toOff.push(a);
    else if (standing === "active" && a.data.hrInactive) toOn.push(a);
  }

  const line = (a) => `  ${a.id.padEnd(10)} ${String(a.data.name || "").padEnd(32)} ${a.data.email || ""}`;
  console.log(`${accounts.length} CoWork accounts · ${hr.length} HR records · ${noHr.length} accounts with no HR record (left alone)`);
  console.log(`\nInactive in HR, access still on — ${toOff.length}:`);
  toOff.forEach((a) => console.log(line(a)));
  console.log(`\nActive in HR again, access switched off by HR — ${toOn.length}:`);
  toOn.forEach((a) => console.log(line(a)));

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply to switch these.");
  } else {
    const svc = A.createCoworkHrAccess({ db, auth, Employee });
    for (const a of toOff) {
      const r = await svc.deactivate(a, { by: "sync-hr-inactive script" });
      console.log(`  off  ${a.id}${r.loginDisabled ? " (login disabled)" : ""}`);
    }
    for (const a of toOn) {
      const r = await svc.reactivate(a, { by: "sync-hr-inactive script" });
      console.log(`  on   ${a.id}${r.loginEnabled ? " (login enabled)" : ""}`);
    }
    console.log(`\nDone: ${toOff.length} switched off, ${toOn.length} switched back on. Nothing deleted.`);
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
