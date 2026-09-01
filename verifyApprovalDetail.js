// verifyApprovalDetail.js
//
// The approval card says WHAT changed, and the right people are told about it.
//
// Run:  node -r dotenv/config verifyApprovalDetail.js
//
// CREATES AND THEN DELETES its own roles under a throwaway department slug and
// its own throwaway employees. It never touches the real `hr` slug or a real
// person, and it never sends a real push — the FCM transport is stubbed, so
// what is checked is WHO would have been messaged and WITH WHAT.

"use strict";

const mongoose = require("mongoose");

const SLUG = "verify-detail-dept";
const EDITOR = "verify-detail-editor@grav.invalid";
const OWNER = "verify-detail-owner@grav.invalid";
const APPROVER = "verify-detail-approver@grav.invalid";

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
  const DepartmentRole = require("./models/Access/DepartmentRole");
  const ChangeRequest = require("./models/Access/ChangeRequest");
  const Employee = require("./models/Employee");
  const a = await DepartmentRole.deleteMany({ departmentSlug: SLUG });
  const b = await ChangeRequest.deleteMany({ departmentSlug: SLUG });
  const c = await Employee.deleteMany({ email: /@grav\.invalid$/ });
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

  return a.deletedCount + b.deletedCount + c.deletedCount + logs.deletedCount;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const Employee = require("./models/Employee");
  const { setRole } = require("./services/departmentRoles");
  const describeChange = require("./services/changeRequestDescribe");
  const notif = require("./services/departmentApprovalNotifications.service");

  await cleanup();

  /* A real employee to be edited, and the three people in the department. */
  const subject = await Employee.create({
    firstName: "Verify",
    lastName: "Subject",
    email: "verify-subject@grav.invalid",
    biometricId: `VT${Date.now().toString().slice(-6)}`,
    phone: "9000000001",
    designation: "Tailor",
    // Explicit because Employee.gender defaults to "" which its own enum does
    // not allow — a create without it fails validation.
    gender: "Other",
    // The two shapes that turned a one-field edit into twenty-five rows:
    // an ObjectId reference, and salary fields encrypted at rest.
    primaryManager: { managerId: new mongoose.Types.ObjectId(), managerName: "A Manager" },
    salary: require("./utils/salaryEncryption").encryptSalaryFields({
      gross: 19227,
      basic: 9614,
      netSalary: 18000,
    }),
  });
  await Employee.create([
    { firstName: "Verify", lastName: "Owner", email: OWNER, biometricId: `VO${Date.now().toString().slice(-6)}`, fcmToken: "tok-owner", gender: "Other" },
    { firstName: "Verify", lastName: "Approver", email: APPROVER, biometricId: `VA${Date.now().toString().slice(-6)}`, fcmToken: "tok-approver", gender: "Other" },
    { firstName: "Verify", lastName: "Editor", email: EDITOR, biometricId: `VE${Date.now().toString().slice(-6)}`, fcmToken: "tok-editor", gender: "Other" },
  ]);

  await setRole({ departmentSlug: SLUG, email: OWNER, name: "Owner", role: "owner" });
  await setRole({ departmentSlug: SLUG, email: APPROVER, name: "Approver", role: "approver" });
  await setRole({ departmentSlug: SLUG, email: EDITOR, name: "Editor", role: "editor" });

  /* ---------------------------------------------------------------- */
  console.log("what the approver is shown");

  const describe = describeChange("update");
  const req = {
    method: "PUT",
    originalUrl: `/api/employees/${subject._id}`,
    url: `/api/employees/${subject._id}`,
    auditSection: "hr:employees",
    body: { email: "verify-changed@grav.invalid", designation: "Master Tailor" },
  };
  const d = await describe(req);

  check("the record is named, not just its type", /Verify Subject/.test(d.entityLabel), d.entityLabel);
  check("two fields are listed", d.changes.length === 2, `got ${d.changes.length}`);

  const email = d.changes.find((c) => /email/i.test(c.field));
  check("the field is labelled for a human", email?.field === "Email", email?.field);
  check("the OLD value is shown", email?.from === "verify-subject@grav.invalid", String(email?.from));
  check("the NEW value is shown", email?.to === "verify-changed@grav.invalid", String(email?.to));
  check("the machine path is kept for the log", email?.path === "email", String(email?.path));
  check("the summary names the fields", /Changing/.test(d.summary) && /Email/.test(d.summary), d.summary);

  console.log("\nand what it will NOT do");

  // The exact bug this design is written against: a partial body must not
  // report every field it omitted as a deletion.
  const omitted = d.changes.map((c) => c.field);
  check("no field the editor never submitted appears", !omitted.some((f) => /phone|first name|last name/i.test(f)), omitted.join(", "));

  const unchanged = await describe({ ...req, body: { designation: "Tailor" } });
  check("a field resubmitted unchanged is not listed", unchanged.changes.length === 0, JSON.stringify(unchanged.changes));

  const secret = await describe({ ...req, body: { password: "hunter2" } });
  check("a password is redacted, never shown", secret.changes[0]?.to === "[redacted]", String(secret.changes[0]?.to));

  /* ---- the exact blow-up reported on 31 Aug: 25 rows for a 1-field edit ---- */
  console.log("\nand the shapes that used to blow the card up");

  // A form that reloads the record and posts the whole thing back — which is
  // what the HR employee form does, so none of this is hypothetical.
  const wholeRecord = await describe({
    ...req,
    body: {
      email: "verify-changed@grav.invalid",
      primaryManager: { managerName: "A Manager" }, // managerId omitted, as the form omits it
      salary: { gross: 19227, basic: 9614, netSalary: 18000 }, // plaintext, as shown
    },
  });
  const fields = wholeRecord.changes.map((c) => c.field);
  check(
    "an ObjectId is not walked byte by byte",
    !fields.some((f) => /buffer/i.test(f)),
    fields.join(", "),
  );
  check(
    "salary encrypted at rest is compared decrypted, not as ciphertext",
    !wholeRecord.changes.some((c) => /^enc:/.test(String(c.from))),
    JSON.stringify(wholeRecord.changes.filter((c) => /^enc:/.test(String(c.from)))),
  );
  check(
    "a nested field the body omitted is not reported as removed",
    !wholeRecord.changes.some((c) => c.to === undefined),
  );
  check(
    "so a one-field edit is ONE row",
    wholeRecord.changes.length === 1 && wholeRecord.changes[0].field === "Email",
    `${wholeRecord.changes.length} rows: ${fields.join(", ")}`,
  );
  check(
    "and the summary says so",
    wholeRecord.summary === "Changing Email.",
    wholeRecord.summary,
  );

  const unknown = await describe({
    ...req,
    originalUrl: "/api/hr/something-nobody-registered/507f1f77bcf86cd799439011",
    body: { note: "hello" },
  });
  check(
    "an unregistered path still shows the submitted value",
    unknown.changes.length === 1 && unknown.changes[0].to === "hello",
    JSON.stringify(unknown.changes),
  );
  check("with no invented before-value", unknown.changes[0]?.from === undefined);

  /* ---------------------------------------------------------------- */
  console.log("\nwho gets told");

  // The transport is a parameter, so this checks the recipient list and the
  // wording without a Firebase project and without messaging a real device.
  const sent = [];
  const send = async (employee, msg) => {
    sent.push({ to: employee.email, ...msg });
    return true;
  };

  const cr = {
    departmentSlug: SLUG,
    entity: "employee",
    entityLabel: "Verify Subject",
    summary: d.summary,
    requestedBy: { email: EDITOR, name: "Editor" },
    decidedBy: { email: OWNER, name: "Owner" },
    decisionNote: "Not this one.",
  };

  await notif.notifyChangeRequest(cr, "held", { send });
  const held = sent.map((m) => m.to).sort();
  check("the owner is told a change is waiting", held.includes(OWNER));
  check("so is the approver", held.includes(APPROVER));
  check("the editor is NOT told about their own request", !held.includes(EDITOR), held.join(", "));
  check("the message says what changed, not just that something did",
    /Email/.test(sent[0]?.body || ""), sent[0]?.body);

  sent.length = 0;
  await notif.notifyChangeRequest(cr, "approved", { send });
  check("on approval only the editor is told", sent.length === 1 && sent[0].to === EDITOR,
    sent.map((m) => m.to).join(", "));
  check("and the message names the approver", /Owner/.test(sent[0]?.body || ""), sent[0]?.body);

  sent.length = 0;
  await notif.notifyChangeRequest(cr, "rejected", { send });
  check("on rejection the editor is told too", sent.length === 1 && sent[0].to === EDITOR);
  check("and is given the reason", /Not this one\./.test(sent[0]?.body || ""), sent[0]?.body);

  sent.length = 0;
  await notif.notifyChangeRequest({ ...cr, departmentSlug: "verify-empty-dept" }, "held", { send });
  check("a department with no approvers notifies nobody rather than throwing", sent.length === 0);

  console.log("\ncleanup");
  check("every harness row removed", (await cleanup()) >= 6);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error("\nharness crashed:", err.message);
  try {
    console.error(`cleaned up ${await cleanup()} harness row(s).`);
    await mongoose.disconnect();
  } catch {
    console.error(`CLEANUP FAILED — remove departmentSlug "${SLUG}" and any @grav.invalid employees.`);
  }
  process.exit(1);
});
