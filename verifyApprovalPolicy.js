// verifyApprovalPolicy.js
//
// Only salary asks. Attendance asks only for an overwrite.
//
// Run:  node verifyApprovalPolicy.js      (no database, no network, no writes)
//
// THE OWNER'S RULE, 3 SEP 2026
// An editor changing anything on the employee record other than what somebody
// is PAID commits directly. Shift, bank account, active flag, department —
// routine. Salary INPUTS wait; salary figures the server derives from them do
// not, because a derived figure that moved with no input changed is the
// formula catching up, not a decision. Access (password, role, permissions)
// is the one non-pay thing still held, and it is named as such.
//
// In attendance, only an OVERWRITE of what a day says waits: day override,
// bulk override, punch correction, removing days. Shift assignment, rotation,
// swaps, settings, holidays, sync — ordinary work.

"use strict";

const { decideApproval, isRoutineField, isEmployeeRecord } = require("./services/approvalPolicy");

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
  "currentCity", "permanentPincode", "sameAsCurrent", "address.current.city",
  "jobTitle", "workLocation",
  "passportNumber", "voterIdNumber", "drivingLicenseNumber",
  "email", "biometricId", "identityId",
  "department", "departmentId", "designation", "employmentType",
  "dateOfJoining", "confirmationDate", "probationPeriod",
  "primaryManager", "secondaryManager", "primaryManager.managerId", "isDirector",
  "aadharNumber", "panNumber", "uanNumber", "pfNumber", "esicNumber",
  "documents.aadharNumber", "documents.aadharFile.name", "documents.aadharFile.pages",
  "fieldsNotAvailable", "profilePhoto",
]) {
  const v = edit(f);
  check(`${f} commits directly`, v.hold === false, v.reason);
}

console.log("\nthe owner's rule: the shift, the bank account, the active flag — all routine now");
for (const f of [
  "shift", "workShift", "workShift.mode", "workShift.start", "workShift.punches",
  "workShiftMode", "workShiftStart", "workShiftEnd", "workShiftPunches",
  "bankDetails.bankName", "bankDetails.accountNumber", "bankDetails.ifscCode",
  "bankDetails.accountType", "bankDetails.branchName", "accountNumber",
  "isActive", "status",
  "internship", "internship.startDate",
]) {
  const v = edit(f);
  check(`${f} commits directly`, v.hold === false, v.reason);
}

console.log("\nthe real held request from 2 Sep — a shift change beside recomputed figures");
/* The rows the queue recorded for rakesh.biswal's request, minus the
   gross/basic/hra that DID change on that one. The derived figures moving is
   the formula catching up, and goes through. EPF, EDLI and admin charges are
   the exception, on purpose: HR can OVERRIDE those three from the form, and
   the diff alone cannot tell an override from a recomputation — so they stay
   on the money side. In practice they never reach this policy from a shift
   change any more: a section's Save sends only that section's fields
   (EmployeeForm SECTION_KEYS), so the salary block is not in the request. */
const shiftOnly = edit(
  "shift", "salary.eeesic", "salary.erEsic", "salary.employerCost",
  "salary.totalDeduction", "salary.netSalary",
  "documents.aadharFile.name", "documents.panFile.name",
);
check("a shift change beside recomputed salary figures is NOT held", shiftOnly.hold === false, shiftOnly.reason);
const overridable = edit("shift", "salary.edli", "salary.adminCharges");
check("but the three HR-overridable statutory figures still hold (an override is money)",
  overridable.hold === true && /edli/.test(overridable.reason), overridable.reason);

console.log("\nmoney always waits — the salary INPUTS");
for (const f of [
  "grossSalary", "salary.gross", "salary.basic", "salary.hra", "salary.stipend",
  "salary.foodAllowance", "salary.foodAllowanceFull", "salary.otherDeduction",
  "salary.epf", "salary.edli", "salary.adminCharges",
  "salary.epfOverride", "salary.edliOverride", "salary.adminOverride",
  "stipend", "otherDeduction", "foodAllowance",
]) {
  const v = edit(f);
  check(`${f} needs an approver`, v.hold === true, v.reason);
}

console.log("\nbut the figures the server derives from them do not");
for (const f of [
  "salary.eeesic", "salary.erEsic", "salary.employerCost",
  "salary.totalDeduction", "salary.netSalary", "salary.allowances", "salary.deductions",
]) {
  const v = edit(f);
  check(`${f} commits directly`, v.hold === false, v.reason);
}

console.log("\naccess is the one non-pay thing still held, by name");
for (const f of ["password", "role", "isAdmin", "permissions"]) {
  const v = edit(f);
  check(`${f} needs an approver`, v.hold === true, v.reason);
}

console.log("\none salary input among routine fields holds the whole change");
const mixed = edit("firstName", "shift", "salary.gross", "phone");
check("a shift plus a gross change is held", mixed.hold === true);
check("and the reason names the field that caused it", /salary\.gross/.test(mixed.reason), mixed.reason);
check("without naming the routine ones", !/firstName|shift|phone/.test(mixed.reason), mixed.reason);

console.log("\na salary leaf nobody has classified is still held");
check("salary.someNewStatutoryThing is held", edit("salary.someNewStatutoryThing").hold === true);
check("as is a new salaryCustomFields entry", edit("salaryCustomFields.0.value").hold === true);

console.log("\nadministrator-configured extra fields are routine");
for (const f of [
  "personalCustomFields.0.value", "workCustomFields.2.value",
  "documentCustomFields.1.value", "addressCustomFields.0.value",
]) {
  check(`${f} commits directly`, edit(f).hold === false);
}

console.log("\nattendance: only an overwrite asks");
for (const [label, path, method] of [
  ["a day override", "/hr/attendance/day-override", "PUT"],
  ["a bulk day override", "/hr/attendance/bulk-day-override", "PUT"],
  ["a punch correction", "/hr/attendance/punch-correction", "POST"],
  ["removing days from a month", "/hr/attendance/remove-from-month", "DELETE"],
  ["an HR regularisation approval (it overwrites the day)", "/hr/attendance/regularizations/12/hr-approve", "PATCH"],
]) {
  const v = decideApproval({ path, method, changes: [{ field: "x", path: "x" }] });
  check(`${label} is held`, v.hold === true, v.reason);
}
for (const [label, path, method] of [
  ["assigning a shift", "/api/hr/attendance/shifts", "POST"],
  ["editing / rotating a shift", "/api/hr/attendance/shifts/66f0a1b2c3d4e5f60718293a", "PUT"],
  ["a shift swap", "/hr/shift-swaps/exchange", "POST"],
  ["a shift change request", "/api/employee/shift-change-request/8", "PUT"],
  ["the attendance settings (shift rules, late policy)", "/hr/attendance/settings", "PUT"],
  ["adding a holiday", "/hr/attendance/holidays", "POST"],
  ["removing a holiday", "/hr/attendance/holidays/66f0a1b2c3d4e5f60718293a", "DELETE"],
  ["syncing the device", "/hr/attendance/sync-period", "POST"],
  ["a shift on the employee record", EDIT, "PUT"],
]) {
  const v = decideApproval({ path, method, changes: [{ field: "shift", path: "shift" }] });
  check(`${label} is NOT held`, v.hold === false, v.reason);
}

console.log("\nwhole areas that still wait regardless of the fields");
for (const [label, path] of [
  ["a leave decision", "/api/hr/leaves/123/approve"],
  ["payroll", "/api/hr/payroll/process"],
  ["the salary rules", "/api/employees/config/salary"],
  ["a password reset for somebody else", "/api/hr/password-management/change-password/hr/9"],
  ["a regularisation", "/api/employee/regularizations/12"],
  ["overtime", "/api/employee/overtime/5"],
]) {
  const v = decideApproval({ path, method: "PUT", changes: [{ field: "firstName", path: "firstName" }] });
  check(`${label} is held even when the diff looks routine`, v.hold === true, v.reason);
}

console.log("\ncreate and delete: the employee record, and nothing else");
check("creating an employee is held", decideApproval({ path: "/api/employees", method: "POST", changes: [] }).hold === true);
check("deleting one is held", decideApproval({ path: EDIT, method: "DELETE", changes: [] }).hold === true);
check("deleting by employee code is held", decideApproval({ path: "/api/employees/GR0045", method: "DELETE" }).hold === true);
check("creating a department is not", decideApproval({ path: "/api/hr/departments", method: "POST" }).hold === false);
check("a sub-action POST on an employee is judged on its fields, not as a create",
  decideApproval({ path: `${EDIT}/profile-photo`, method: "POST", changes: [{ field: "profilePhoto", path: "profilePhoto" }] }).hold === false);
check("isEmployeeRecord recognises the record and only the record",
  isEmployeeRecord("/api/employees") && isEmployeeRecord(EDIT.toLowerCase()) && !isEmployeeRecord(`${EDIT}/profile-photo`.toLowerCase()));

console.log("\nthe two defaults");
check("a field nobody classified is ROUTINE now", edit("someFieldInventedToday").hold === false);
check("an empty diff — nothing changed — is not held", decideApproval({ path: EDIT, method: "PUT", changes: [] }).hold === false);
check("a MISSING diff (describe failed) is still held", decideApproval({ path: EDIT, method: "PUT" }).hold === true);

console.log("\nthe field classifier itself");
check("a dotted path is judged on its leaf", isRoutineField("address.currentCity") === true);
check("array indices are ignored", isRoutineField("documents.2.name") === true);
check("a sensitive leaf beats a routine-looking parent", isRoutineField("profile.grossSalary") === false);
check("a derived salary leaf is routine only INSIDE the salary object", isRoutineField("salary.netSalary") === true);
check("an empty path is not routine", isRoutineField("") === false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
