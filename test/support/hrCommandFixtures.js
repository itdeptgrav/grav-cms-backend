"use strict";
/**
 * test/support/hrCommandFixtures.js — a small HR, with the traps planted.
 *
 *   · Two people called Ravi, in different departments, so a name that names
 *     one must never answer with the other.
 *   · Somebody who has left, so "employees" (active) never lists them.
 *   · Every private and protected value the policy names — pay, bank account,
 *     Aadhaar, PAN, personal phone and email, address, date of birth, blood
 *     group, a leave's medical reason, a letter's CTC and HR's notes, a
 *     candidate's phone and expected salary, the payroll bill — so a test can
 *     search everything and prove none of them ever leaves the server.
 *
 * "Today" in these tests is 8 Oct 2026 (IST). Written through the raw
 * collections, as the readers read them with lean().
 */

const mongoose = require("mongoose");

const oid = () => new mongoose.Types.ObjectId();
const d = (iso) => new Date(`${iso}T06:00:00.000Z`);
const at = (iso, hhmm) => new Date(`${iso}T${hhmm}:00.000+05:30`);

const SECRETS = Object.freeze({
  phone: "9876501234",
  personalEmail: "ravi.home@example.com",
  account: "999988887777",
  ifsc: "HDFC0001234",
  aadhar: "123412341234",
  pan: "ABCDE1234F",
  address: "14 Secret Lane",
  salary: "enc:planted-salary",
  dob: "1990-02-14",
  blood: "B+ve-planted",
  leaveReason: "fever, doctor note planted",
  ctc: "3,60,000 planted",
  hrNotes: "planted private note",
  candidatePhone: "9000011111",
  candidateEmail: "meena.planted@example.com",
  expectedSalary: "41000 planted",
  netPay: 1234567,
  salaryRangeMax: 77777,
});

async function seedHr() {
  const db = mongoose.connection;
  const ids = {
    cutting: oid(), stitching: oid(),
    ravi: oid(), raviS: oid(), asha: oid(), priya: oid(), old: oid(),
    tailorJob: oid(), accountantJob: oid(), meena: oid(), kiran: oid(),
    offer: oid(), warning: oid(),
  };

  await db.collection("departments").insertMany([
    { _id: ids.cutting, name: "Cutting", status: "active", description: "Fabric cutting floor",
      designations: [{ name: "Tailor", isActive: true }, { name: "Cutter", isActive: true }],
      primaryManager: { managerId: ids.asha, managerName: "Asha Mehta", designation: "Floor head" } },
    { _id: ids.stitching, name: "Stitching", status: "active", designations: [{ name: "Operator", isActive: true }] },
  ]);

  const person = (o) => ({
    title: "", middleName: "", nickName: "", isActive: true, status: "active", employmentType: "full_time",
    workLocation: "GRAV Clothing", createdAt: d("2025-01-01"), updatedAt: d("2025-01-01"), ...o,
  });
  await db.collection("employees").insertMany([
    person({
      _id: ids.ravi, firstName: "Ravi", lastName: "Kumar", biometricId: "GR0067", identityId: "ID-0067",
      email: "ravi.kumar@grav.in", workPhone: "0261-400067", department: "Cutting", departmentId: ids.cutting,
      designation: "Tailor", dateOfJoining: d("2026-10-02"),
      primaryManager: { managerId: ids.asha, managerName: "Asha Mehta" },
      /* Everything below must never be shown. */
      phone: SECRETS.phone, personalEmail: SECRETS.personalEmail,
      bankDetails: { accountNumber: SECRETS.account, ifscCode: SECRETS.ifsc },
      documents: { aadharNumber: SECRETS.aadhar, panNumber: SECRETS.pan },
      address: { current: { line1: SECRETS.address } }, dateOfBirth: d(SECRETS.dob), bloodGroup: SECRETS.blood,
      salary: { gross: SECRETS.salary, netSalary: SECRETS.salary },
      password: "$2b$10$plantedhash", temporaryPassword: "Temp-planted-1",
    }),
    person({ _id: ids.raviS, firstName: "Ravi", lastName: "Sharma", biometricId: "GR0068", email: "ravi.sharma@grav.in",
      department: "Stitching", departmentId: ids.stitching, designation: "Operator", dateOfJoining: d("2024-04-01") }),
    person({ _id: ids.asha, firstName: "Asha", lastName: "Mehta", biometricId: "GR0010", email: "asha@grav.in",
      department: "Cutting", departmentId: ids.cutting, designation: "Floor head", dateOfJoining: d("2020-06-15") }),
    person({ _id: ids.priya, firstName: "Priya", lastName: "Nair", biometricId: "GR0099", department: "Stitching",
      departmentId: ids.stitching, designation: "Operator", employmentType: "intern", dateOfJoining: d("2026-09-01"),
      primaryManager: { managerId: ids.raviS, managerName: "Ravi Sharma" } }),
    person({ _id: ids.old, firstName: "Old", lastName: "Timer", biometricId: "GR0005", department: "Cutting",
      departmentId: ids.cutting, designation: "Tailor", isActive: false, status: "inactive", dateOfJoining: d("2015-01-01"),
      primaryManager: { managerId: ids.asha, managerName: "Asha Mehta" } }),
  ]);

  const row = (id, bio, name, dept, code, extra = {}) => ({
    employeeDbId: id, biometricId: bio, employeeName: name, department: dept, designation: "—",
    employeeType: "operator", systemPrediction: code, hrFinalStatus: null, ...extra,
  });
  await db.collection("dailyattendances").insertMany([
    { dateStr: "2026-10-08", yearMonth: "2026-10", employees: [
      row(ids.ravi, "GR0067", "Ravi Kumar", "Cutting", "AB"),
      row(ids.raviS, "GR0068", "Ravi Sharma", "Stitching", "P*", { inTime: at("2026-10-08", "09:41") }),
      row(ids.asha, "GR0010", "Asha Mehta", "Cutting", "AB", { hrFinalStatus: "P" }),
      row(ids.priya, "GR0099", "Priya Nair", "Stitching", "L-SL"),
    ] },
    { dateStr: "2026-10-03", yearMonth: "2026-10", employees: [
      row(ids.ravi, "GR0067", "Ravi Kumar", "Cutting", "P", { inTime: at("2026-10-03", "09:28"), finalOut: at("2026-10-03", "18:35") }),
      row(ids.raviS, "GR0068", "Ravi Sharma", "Stitching", "AB"),
    ] },
    { dateStr: "2026-10-05", yearMonth: "2026-10", employees: [row(ids.ravi, "GR0067", "Ravi Kumar", "Cutting", "L-SL")] },
  ]);

  await db.collection("leaveapplications").insertMany([
    { _id: oid(), employeeId: ids.ravi, biometricId: "GR0067", employeeName: "Ravi Kumar", leaveType: "SL",
      fromDate: "2026-10-05", toDate: "2026-10-06", totalDays: 2, status: "pending", reason: SECRETS.leaveReason, applicationDate: "2026-10-04" },
    { _id: oid(), employeeId: ids.raviS, biometricId: "GR0068", employeeName: "Ravi Sharma", leaveType: "PL",
      fromDate: "2026-10-20", toDate: "2026-10-22", totalDays: 3, status: "manager_approved", reason: "family function", applicationDate: "2026-10-01" },
    { _id: oid(), employeeId: ids.asha, biometricId: "GR0010", employeeName: "Asha Mehta", leaveType: "CL",
      fromDate: "2026-09-10", toDate: "2026-09-10", totalDays: 1, status: "hr_approved", reason: "errand", applicationDate: "2026-09-08" },
  ]);
  await db.collection("leavebalances").insertOne({
    employeeId: ids.ravi, biometricId: "GR0067", year: 2026,
    entitlement: { CL: 7, SL: 7, PL: 15 }, consumed: { CL: 4, SL: 2, PL: 5 },
  });
  await db.collection("companyholidays").insertMany([
    { name: "Republic Day", date: "2026-01-26", type: "national" },
    { name: "Dussehra", date: "2026-10-20", type: "company" },
    { name: "Diwali", date: "2026-11-08", type: "national" },
  ]);
  await db.collection("regularizationrequests").insertMany([
    { employeeId: ids.ravi, biometricId: "GR0067", employeeName: "Ravi Kumar", dateStr: "2026-10-07", type: "miss_punch", requestedStatus: "P", status: "pending" },
    { employeeId: ids.asha, biometricId: "GR0010", employeeName: "Asha Mehta", dateStr: "2026-09-02", type: "client_visit", status: "hr_approved" },
  ]);
  await db.collection("overtimereports").insertMany([
    { employeeId: ids.asha, biometricId: "GR0010", employeeName: "Asha Mehta", department: "Cutting", dateStr: "2026-10-07",
      actualOutTime: "21:45", stayOverMins: 195, status: "hr_approved", description: "cutting backlog" },
    { employeeId: ids.raviS, biometricId: "GR0068", employeeName: "Ravi Sharma", department: "Stitching", dateStr: "2026-09-29",
      actualOutTime: "20:10", stayOverMins: 100, status: "pending", description: "rework" },
  ]);

  await db.collection("jobpostings").insertMany([
    { _id: ids.tailorJob, jobTitle: "Senior Tailor", jobLocation: "Surat", jobType: "full_time", jobMode: "onsite", status: "published",
      lastDate: d("2026-10-31"), publishedAt: d("2026-10-01"), salaryRange: { min: 20000, max: SECRETS.salaryRangeMax }, createdAt: d("2026-10-01") },
    { _id: ids.accountantJob, jobTitle: "Accountant", jobLocation: "Surat", jobType: "full_time", jobMode: "onsite", status: "closed",
      lastDate: d("2026-08-31"), publishedAt: d("2026-08-01"), closedAt: d("2026-09-01"), createdAt: d("2026-08-01") },
  ]);
  await db.collection("candidates").insertMany([
    { _id: ids.meena, name: "Meena Das", email: SECRETS.candidateEmail, phone: SECRETS.candidatePhone, expectedSalary: SECRETS.expectedSalary,
      jobPostingId: ids.tailorJob, jobTitle: "Senior Tailor", stage: "hr_interview", status: "active", appliedDate: d("2026-10-03") },
    { _id: ids.kiran, name: "Kiran Patel", email: "kiran@example.com", phone: "9000022222",
      jobPostingId: ids.tailorJob, jobTitle: "Senior Tailor", stage: "hired", status: "active", appliedDate: d("2026-09-20") },
  ]);
  await db.collection("employeetasks").insertMany([
    { title: "HR interview — Meena Das", type: "interview", status: "scheduled", scheduledDate: d("2026-10-09"), scheduledTime: "11:00",
      interviewStage: "hr_interview", interviewType: "in_person", candidateId: ids.meena, jobPostingId: ids.tailorJob },
    { title: "Screening — Kiran Patel", type: "interview", status: "completed", scheduledDate: d("2026-09-22"), scheduledTime: "15:00",
      interviewStage: "screening", candidateId: ids.kiran, jobPostingId: ids.tailorJob },
  ]);
  await db.collection("employee_documents").insertMany([
    { _id: ids.offer, employeeId: ids.ravi, biometricId: "GR0067", employeeName: "Ravi Kumar", type: "offer", title: "Offer letter",
      requestStatus: "none", generated: true, generatedAt: d("2026-09-25"), released: true, releasedAt: d("2026-09-26"), revokedAt: null,
      letterMeta: { referenceNo: "GRAV/HR/2026/014", annualCTC: SECRETS.ctc }, hrNotes: SECRETS.hrNotes, createdAt: d("2026-09-25") },
    { _id: ids.warning, employeeId: ids.raviS, biometricId: "GR0068", employeeName: "Ravi Sharma", type: "experience", title: "",
      requestStatus: "requested", requestedAt: d("2026-10-06"), generated: false, released: false, revokedAt: null, createdAt: d("2026-10-06") },
  ]);
  await db.collection("payrolls").insertMany([
    { month: 9, year: 2026, payPeriod: "September 2026", status: "approved", totalEmployees: 4, totalNetPay: SECRETS.netPay, totalGross: SECRETS.netPay },
    { month: 10, year: 2026, payPeriod: "October 2026", status: "draft", totalEmployees: 4, totalNetPay: 0 },
  ]);
  await db.collection("policies").insertMany([
    { name: "Late arrival", category: "C4", points: 2, bleachType: "debit", scope: "global", triggerKey: "late_arrival", isActive: true },
    { name: "On-time week", category: "C4", points: 1, bleachType: "credit", scope: "global", triggerKey: "present_on_time", isActive: true },
  ]);
  return ids;
}

module.exports = { seedHr, SECRETS, NOW: Date.UTC(2026, 9, 8, 6) };
