// verifyHrProfile.js
//
// /api/hr/profile answers for an EMPLOYEE, not only a legacy HRDepartment
// account — the collection it used to read is empty, so the page showed
// "Failed to load profile data" to everybody.
//
// Run:  node -r dotenv/config verifyHrProfile.js
//
// CREATES AND THEN DELETES its own throwaway employee and role rows. It never
// touches a real person; cleanup runs on crash too.

"use strict";

const mongoose = require("mongoose");

const SLUG = "verify-profile-dept";
const EMAIL = "verify-profile@grav.invalid";
const MOVED = "verify-profile-moved@grav.invalid";
const OTHER = "verify-profile-other@grav.invalid";

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
  const DepartmentRole = require("./models/Access/DepartmentRole");
  const a = await Employee.deleteMany({ email: /@grav\.invalid$/ });
  const b = await DepartmentRole.deleteMany({ departmentSlug: SLUG });
  /* The change_logs these actions cause are part of the mess to clear up.
     Without this the harness left rows in the REAL history reading "by
     Harness" — which is exactly how a verification script turns into a
     support question. Matched narrowly: the harness actor, and the throwaway
     names and addresses only these scripts use. */
  const ChangeLog = require("./models/Access/ChangeLog");
  const logs = await ChangeLog.deleteMany({
    $or: [
      { actorName: "Harness" },
      { entityLabel: /^Verify / },
      { summary: /grav\.invalid/ },
      { entityLabel: /grav\.invalid/ },
    ],
  });

  return a.deletedCount + b.deletedCount + logs.deletedCount;
}

function fakeRes() {
  const r = { statusCode: 200, body: null, done: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.done = true; return r; };
  return r;
}

/** Drive one handler off the router's stack, skipping its auth middleware. */
function call(router, method, path, { userId, body = {} } = {}) {
  return new Promise((resolve) => {
    const layer = router.stack.find(
      (l) => l.route?.path === path && l.route.methods[method.toLowerCase()],
    );
    if (!layer) return resolve({ statusCode: 0, body: { message: "no such route" } });
    const req = {
      method: method.toUpperCase(),
      url: path,
      originalUrl: `/api/hr${path}`,
      headers: {},
      body,
      params: {},
      user: { id: String(userId), email: "", name: "Harness" },
    };
    const res = fakeRes();
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    Promise.resolve(handler(req, res, () => {})).then(() => {
      const settle = setInterval(() => {
        if (res.done) { clearInterval(settle); resolve(res); }
      }, 5);
      setTimeout(() => { clearInterval(settle); resolve(res); }, 3000);
    });
  });
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const Employee = require("./models/Employee");
  const HRDepartment = require("./models/HRDepartment");
  const { setRole, getRole } = require("./services/departmentRoles");
  const router = require("./routes/HrRoutes/HrProfile-Section");

  await cleanup();

  const emp = await Employee.create({
    firstName: "Verify",
    lastName: "Person",
    email: EMAIL,
    biometricId: `VP${Date.now().toString().slice(-6)}`,
    phone: "9000000002",
    designation: "HR Executive",
    department: "Human resources",
    gender: "Other",
    password: "originalPassw0rd",
  });
  await Employee.create({
    firstName: "Someone", lastName: "Else", email: OTHER, gender: "Other",
    biometricId: `VX${Date.now().toString().slice(-6)}`,
  });
  await setRole({ departmentSlug: SLUG, email: EMAIL, name: "Verify Person", role: "editor" });

  /* The state that broke it: the legacy collection has nobody in it. */
  console.log("the collection the route used to read");
  check("HRDepartment is empty, so reading only it answers nobody",
    (await HRDepartment.countDocuments({})) === 0);

  console.log("\nreading a profile");
  const got = await call(router, "GET", "/profile", { userId: emp._id });
  check("an employee gets their profile, not a 404", got.statusCode === 200,
    `${got.statusCode} ${got.body?.message || ""}`);
  check("with a name composed from first + last", got.body?.data?.name === "Verify Person",
    got.body?.data?.name);
  check("their email", got.body?.data?.email === EMAIL, got.body?.data?.email);
  check("and their employee id", Boolean(got.body?.data?.employeeId));

  const missing = await call(router, "GET", "/profile", { userId: new mongoose.Types.ObjectId() });
  check("a session for a deleted account is told to sign in again",
    missing.statusCode === 404 && /sign in again/i.test(missing.body?.message || ""),
    missing.body?.message);

  console.log("\nediting it");
  const bad = await call(router, "PUT", "/profile", {
    userId: emp._id, body: { name: "Verify Person", phone: "9000000002", email: OTHER },
  });
  check("an email another account already holds is refused",
    bad.statusCode === 400 && /already in use/i.test(bad.body?.message || ""), bad.body?.message);

  const put = await call(router, "PUT", "/profile", {
    userId: emp._id, body: { name: "Verify Renamed Person", phone: "9111111111", email: MOVED },
  });
  check("a valid edit saves", put.statusCode === 200, `${put.statusCode} ${put.body?.message || ""}`);

  const after = await Employee.findById(emp._id).lean();
  check("the display name is split back into first and last",
    after.firstName === "Verify Renamed" && after.lastName === "Person",
    `${after.firstName} / ${after.lastName}`);
  check("the phone changed", after.phone === "9111111111");
  check("the email changed", after.email === MOVED);
  check("and their ROLE followed the email rather than being orphaned",
    (await getRole(SLUG, MOVED)) === "editor", String(await getRole(SLUG, MOVED)));
  check("with nothing left at the old address", (await getRole(SLUG, EMAIL)) === null);

  console.log("\nchanging the password");
  const wrong = await call(router, "PUT", "/change-password", {
    userId: emp._id,
    body: { currentPassword: "notThePassword", newPassword: "brandNewPass1", confirmPassword: "brandNewPass1" },
  });
  check("a wrong current password is refused",
    wrong.statusCode === 400 && /incorrect/i.test(wrong.body?.message || ""), wrong.body?.message);

  const mismatch = await call(router, "PUT", "/change-password", {
    userId: emp._id,
    body: { currentPassword: "originalPassw0rd", newPassword: "brandNewPass1", confirmPassword: "different" },
  });
  check("a mistyped confirmation is refused", mismatch.statusCode === 400);

  const short = await call(router, "PUT", "/change-password", {
    userId: emp._id,
    body: { currentPassword: "originalPassw0rd", newPassword: "short", confirmPassword: "short" },
  });
  check("a short password is refused", short.statusCode === 400);

  const ok = await call(router, "PUT", "/change-password", {
    userId: emp._id,
    body: { currentPassword: "originalPassw0rd", newPassword: "brandNewPass1", confirmPassword: "brandNewPass1" },
  });
  check("the right current password is accepted", ok.statusCode === 200,
    `${ok.statusCode} ${ok.body?.message || ""}`);

  const bcrypt = require("bcryptjs");
  const saved = await Employee.findById(emp._id).select("password").lean();
  check("the new password is stored HASHED, never in the clear",
    saved.password !== "brandNewPass1" && (await bcrypt.compare("brandNewPass1", saved.password)));

  const noPw = await Employee.findOne({ email: OTHER });
  const none = await call(router, "PUT", "/change-password", {
    userId: noPw._id,
    body: { currentPassword: "anything", newPassword: "brandNewPass1", confirmPassword: "brandNewPass1" },
  });
  check("an account with NO password says so rather than throwing a 500",
    none.statusCode === 400 && /no password set/i.test(none.body?.message || ""),
    `${none.statusCode} ${none.body?.message || ""}`);

  console.log("\ncleanup");
  check("every harness row removed", (await cleanup()) >= 2);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error("\nharness crashed:", err.message);
  try {
    console.error(`cleaned up ${await cleanup()} harness row(s).`);
    await mongoose.disconnect();
  } catch {
    console.error(`CLEANUP FAILED — remove @grav.invalid employees and slug "${SLUG}".`);
  }
  process.exit(1);
});
