"use strict";
/**
 * services/ai/hrCommandExclusions.js — every HR collection, searched by
 * Cmd/Ctrl K or left out with a reason and what answers instead.
 *
 * Ownership is the model's directory (services/ai/storeCollectionOwnership.js
 * gives models/HR_Models/, Employee.js and Salaryconfig.js to HR), so a model
 * added there tomorrow fails test/hr-ai/hrCollectionCoverage.test.js until
 * somebody decides it here.
 */

const HR_SEARCHED = Object.freeze({
  employees: "employee — by code, name, work email; filtered by department, designation, manager, type, status, joining date",
  departments: "department and designation — by name; employees counted on the card",
  dailyattendances: "a day's attendance — who was absent/late/on leave, one person's day or month",
  leaveapplications: "leave requests — by person, department, type, status, dates",
  leavebalances: "a person's CL/SL/PL balance for a year",
  companyholidays: "holidays — upcoming, by name, by period",
  regularizationrequests: "attendance corrections — by person, type, status, day",
  overtimereports: "overtime reports — by person, status, day",
  jobpostings: "job openings — by title, status, published/closing date",
  candidates: "candidates — by name, opening, stage, applied date",
  employeetasks: "interviews — by date, status, title",
  employee_documents: "HR letters — by reference number, type, person, request status",
  payrolls: "payroll runs — by month and status, never by amount",
  policies: "C4 conduct policies — by name",
});

const HR_NOT_SEARCHED = Object.freeze({
  payrollitems: {
    why: "Per-person pay — every figure on a payslip, with bank details in plain text.",
    instead: "Payroll Processing and Payslips pages, behind compensation.read.",
  },
  salary_config: {
    why: "One row of statutory percentages and ceilings, not records anyone looks up.",
    instead: "Salary Structure page.",
  },
  payrollsettings: {
    why: "A single settings row.",
    instead: "Payroll Rules page.",
  },
  attendancesettings: {
    why: "A single settings row (shifts, thresholds, designations by category).",
    instead: "Attendance Rules and Shift Management pages.",
  },
  leaveconfigs: {
    why: "A single settings row of leave entitlements.",
    instead: "Leave Management page.",
  },
  c4configs: {
    why: "A single settings row for the C4 scoring.",
    instead: "HR Policy Library page.",
  },
  attendances: {
    why: "The older per-person-per-day store written by the biometric sync; the HR screens read daily attendance, which is searched.",
    instead: "Daily Attendance and Timecards pages.",
  },
  attendanceexclusions: {
    why: "Monthly roster adjustments (who is left off a month's muster), with free-text reasons.",
    instead: "Muster Roll page.",
  },
  face_photos: {
    why: "Face images and their biometric embeddings.",
    instead: "The employee's own record, Biometric tab.",
  },
  face_enroll_invites: {
    why: "One-time enrolment links: token hashes, IP addresses, user agents.",
    instead: "The employee's own record, Biometric tab.",
  },
  overtimenotificationlogs: {
    why: "A 60-day log of reminders already sent, so none is sent twice.",
    instead: "Overtime reports are searched.",
  },
});

module.exports = { HR_SEARCHED, HR_NOT_SEARCHED };
