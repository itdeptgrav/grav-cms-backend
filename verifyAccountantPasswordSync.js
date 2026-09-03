// verifyAccountantPasswordSync.js
//
// One person, one password — across both sign-in doors.
//
// Run:  node -r dotenv/config verifyAccountantPasswordSync.js
//
// CREATES AND THEN DELETES its own throwaway Employee and Acc_User, both with
// the email below. It touches no existing record: every query is pinned to that
// address, and the cleanup runs on failure and on crash too. Nothing else in
// the database is read or written.
//
// WHAT IT IS PINNING
//   /api/auth/login            checks Employee.password
//   /api/accountant/auth/login checks Acc_User.password
// so a person who is both has two credentials, and a reset that writes one and
// not the other leaves a door open on the old password.

"use strict";

const mongoose = require("mongoose");

const EMAIL = "verify-sync-harness@grav.invalid";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

async function cleanup() {
  const Employee = require("./models/Employee");
  const { Acc_User } = require("./models/Accountant_model/Acc_OrgModels");
  const a = await Acc_User.deleteMany({ email: EMAIL });
  const e = await Employee.deleteMany({ email: EMAIL });
  return a.deletedCount + e.deletedCount;
}

(async () => {
  await mongoose.connect(
    process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing",
  );
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const Employee = require("./models/Employee");
  const {
    Acc_User,
    Acc_Organization,
  } = require("./models/Accountant_model/Acc_OrgModels");
  const {
    setAccountantPassword,
    getAccountantNavPrefs,
    setAccountantNavPrefs,
  } = require("./services/accountantAccess");
  const bcrypt = require("bcryptjs");

  await cleanup(); // in case a previous run died mid-way

  const org = await Acc_Organization.findOne({}).sort({ createdAt: 1 });
  if (!org) {
    console.log("  no accounting organisation in this database — nothing to test against\n");
    await mongoose.disconnect();
    process.exit(0);
  }

  /* ---- an employee who is also on the accounting team ---------------- */
  const employee = await Employee.create({
    firstName: "Verify",
    lastName: "Harness",
    email: EMAIL,
    phone: "9000000000",
    password: "OldPassword1",
    // Required-with-enum fields the Employee schema validates. Set to real
    // values rather than disabling validation, so the harness exercises the
    // same save path the application does.
    gender: "Male",
  });
  const accUser = new Acc_User({
    organizationId: org._id,
    name: "Verify Harness",
    email: EMAIL,
    role: "editor",
  });
  await accUser.setPassword("OldPassword1");
  await accUser.save();

  console.log("before the reset");
  check(
    "both doors open with the old password",
    (await bcrypt.compare("OldPassword1", (await Employee.findById(employee._id)).password)) &&
      (await (await Acc_User.findById(accUser._id)).checkPassword("OldPassword1")),
  );

  /* ---- the reset ----------------------------------------------------- */
  const result = await setAccountantPassword(EMAIL, "BrandNewPass9");

  console.log("\nafter resetting from the accounting side");
  check("it reports that it also updated the employee", result.employeeUpdated === true);

  const empAfter = await Employee.findById(employee._id);
  const accAfter = await Acc_User.findById(accUser._id);

  check(
    "the books' door takes the new password",
    await accAfter.checkPassword("BrandNewPass9"),
  );
  check(
    "the CMS door takes the new password — this is the bug",
    await bcrypt.compare("BrandNewPass9", empAfter.password),
  );
  check(
    "the old password no longer opens the books",
    !(await accAfter.checkPassword("OldPassword1")),
  );
  check(
    "the old password no longer opens the CMS",
    !(await bcrypt.compare("OldPassword1", empAfter.password)),
  );
  check(
    "the employee's password is stored hashed, never in plain",
    empAfter.password !== "BrandNewPass9" && empAfter.password.startsWith("$2"),
  );
  check(
    "their open accounting sessions were ended",
    (accAfter.tokenVersion || 0) > (accUser.tokenVersion || 0),
  );

  /* ---- an accounting-only user still works --------------------------- */
  console.log("\nsomebody who exists only in the books");
  await Employee.deleteOne({ _id: employee._id });
  const onlyBooks = await setAccountantPassword(EMAIL, "ThirdPassword7");
  check("the reset succeeds", Boolean(onlyBooks.user));
  check("and reports that there was no employee to update", onlyBooks.employeeUpdated === false);

  /* ---- sidebar access, shared by both screens ------------------------ */
  console.log("\nsidebar access");
  await setAccountantNavPrefs(EMAIL, ["/accountant/reports/gst", "/accountant/budgets"]);
  const prefs = await getAccountantNavPrefs(EMAIL);
  check("what was hidden is what comes back", prefs.hiddenNavItems.length === 2);
  check(
    "it actually persisted — the field is on the schema now",
    (await Acc_User.findOne({ email: EMAIL }).lean()).hiddenNavItems?.length === 2,
  );
  await setAccountantNavPrefs(EMAIL, ["/accountant", "/accountant/invoices"]);
  const guarded = await getAccountantNavPrefs(EMAIL);
  check(
    "the dashboard can never be hidden — they would land nowhere",
    !guarded.hiddenNavItems.includes("/accountant"),
  );
  check("but a real item still is", guarded.hiddenNavItems.includes("/accountant/invoices"));

  console.log("\ncleanup");
  check("every harness row removed", (await cleanup()) >= 1);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error("\nharness crashed:", err.message);
  try {
    console.error(`cleaned up ${await cleanup()} harness row(s).`);
    await mongoose.disconnect();
  } catch {
    console.error(`CLEANUP FAILED — delete rows with email ${EMAIL} by hand.`);
  }
  process.exit(1);
});
