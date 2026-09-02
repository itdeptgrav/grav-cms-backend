// verifyApprovalPolicy.js
//
// Routine corrections go straight through; money, access and identity wait.
//
// Run:  node verifyApprovalPolicy.js      (no database, no network, no writes)

"use strict";

const { decideApproval, isRoutineField } = require("./services/approvalPolicy");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

const EDIT = "/api/employees/68f0a1b2c3d4e5f60718293a";
const edit = (...paths) => decideApproval({
  path: EDIT, method: "PUT",
  changes: paths.map((p) => ({ field: p, path: p })),
});

console.log("\nan editor fixing ordinary details is not stopped");
for (const f of [
  "firstName", "middleName", "lastName", "nickName", "gender",
  "dateOfBirth", "bloodGroup", "maritalStatus", "spouseName",
  "fatherFirstName", "motherFirstName", "fatherDOB",
  "nationality", "religion", "placeOfBirth", "countryOfOrigin",
  "personalEmail", "phone", "alternatePhone", "workPhone",
  "currentCity", "permanentPincode", "sameAsCurrent",
  "jobTitle", "workLocation",
  "passportNumber", "voterIdNumber", "drivingLicenseNumber",
]) {
  const v = edit(f);
  check(`${f} commits directly`, v.hold === false, v.reason);
}

console.log("\nand several of them at once still go through");
const many = edit("firstName", "lastName", "dateOfBirth", "currentCity", "phone");
check("five routine fields together need no approver", many.hold === false, many.reason);

console.log("\nrecording that somebody has no passport is routine");
check("marking a field not available commits directly",
  edit("fieldsNotAvailable").hold === false, edit("fieldsNotAvailable").reason);
check("and so does uploading another page of a document",
  edit("documents.aadharFile.pages").hold === false);

console.log("\nmoney always waits");
for (const f of [
  "grossSalary", "salary.gross", "salary.basic", "salary.edli",
  "salary.adminCharges", "salary.employerCost", "stipend",
  "bankDetails.accountNumber", "accountNumber", "ifscCode", "bankName",
]) {
  const v = edit(f);
  check(`${f} needs an approver`, v.hold === true, v.reason);
}

console.log("\nand so does access and whether somebody is still employed");
for (const f of ["password", "role", "isAdmin", "permissions", "isActive", "status"]) {
  const v = edit(f);
  check(`${f} needs an approver`, v.hold === true, v.reason);
}

console.log("\neverything else on the employee form now commits directly");
/* The rule is drawn at the encrypted fields. These were all held before and
   are deliberately not any more: a queue holding every correction is a queue
   nobody reads, and the change history answers for them instead. */
for (const f of [
  "email", "biometricId", "identityId",
  "department", "designation", "employmentType",
  "dateOfJoining", "confirmationDate", "probationPeriod",
  "workShiftMode", "workShiftStart", "workShiftEnd", "workShiftPunches",
  "aadharNumber", "panNumber", "uanNumber", "pfNumber", "esicNumber",
  "primaryManager", "secondaryManager", "isDirector",
  "middleName", "bloodGroup",
]) {
  const v = edit(f);
  check(`${f} commits directly`, v.hold === false, v.reason);
}

console.log("\na shift swap is ordinary work");
for (const path of [
  "/api/hr/attendance/shift-swap/12",
  "/api/employee/shift-change-request/8",
  "/api/hr/attendance/swap/3",
]) {
  const v = decideApproval({ path, method: "PUT", changes: [] });
  check(`${path} is not held`, v.hold === false, v.reason);
}
check("but an ordinary attendance write still is",
  decideApproval({ path: "/api/hr/attendance/mark", method: "PUT", changes: [] }).hold === true);

console.log("\none sensitive field among routine ones holds the whole change");
const mixed = edit("firstName", "dateOfBirth", "grossSalary", "phone");
check("a name plus a salary is held", mixed.hold === true);
check("and the reason names the field that caused it",
  /grossSalary/.test(mixed.reason), mixed.reason);
check("without naming the routine ones",
  !/firstName|phone/.test(mixed.reason), mixed.reason);

console.log("\nthe salary object is covered by prefix, not by leaf name");
/* EDLI and admin charges were ADDED to the salary object recently. A list of
   leaf names would have let a future addition through; the prefix cannot. */
check("a salary field nobody has heard of is still held",
  edit("salary.someNewStatutoryThing").hold === true);
check("as is a new salaryCustomFields entry",
  edit("salaryCustomFields.0.value").hold === true);

console.log("\nadministrator-configured extra fields are routine");
for (const f of [
  "personalCustomFields.0.value", "workCustomFields.2.value",
  "documentCustomFields.1.value", "addressCustomFields.0.value",
]) {
  check(`${f} commits directly`, edit(f).hold === false);
}

console.log("\nwhole areas wait regardless of the fields");
for (const [label, path] of [
  ["attendance", "/api/hr/attendance/mark"],
  ["a leave decision", "/api/hr/leaves/123/approve"],
  ["payroll", "/api/hr/payroll/process"],
  ["the salary rules", "/api/employees/config/salary"],
  ["a password reset", "/api/hr/password-management/change-password/hr/9"],
  ["a regularisation", "/api/employee/regularizations/12"],
  ["overtime", "/api/employee/overtime/5"],
]) {
  const v = decideApproval({
    path, method: "PUT",
    changes: [{ field: "firstName", path: "firstName" }],
  });
  check(`${label} is held even when the diff looks routine`, v.hold === true, v.reason);
}

console.log("\nthe default is to ask");
check("a field nobody classified is held", edit("someFieldInventedToday").hold === true);
check("an empty diff is held", decideApproval({ path: EDIT, method: "PUT", changes: [] }).hold === true);
check("a missing diff is held", decideApproval({ path: EDIT, method: "PUT" }).hold === true);
check("creating a record is held",
  decideApproval({ path: "/api/employees", method: "POST", changes: [] }).hold === true);
check("deleting one is held",
  decideApproval({ path: EDIT, method: "DELETE", changes: [] }).hold === true);

console.log("\nthe field classifier itself");
check("a dotted path is judged on its leaf", isRoutineField("address.currentCity") === true);
check("array indices are ignored", isRoutineField("documents.2.name") === true);
check("a sensitive leaf beats a routine-looking parent",
  isRoutineField("profile.grossSalary") === false);
check("an empty path is not routine", isRoutineField("") === false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
