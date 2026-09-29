"use strict";
/**
 * services/ai/openJev/mongoPorts.js — the read-only data ports behind
 * attendanceToday.js, backed by the application's own Mongoose models.
 *
 * GRAV performs these reads; no model ever sees a connection, a collection name
 * or a query. Each read selects the minimum fields:
 *
 *   directory   Employee: name parts + biometric ID, active employees only.
 *   attendance  DailyAttendance: ONE day, ONE employee's entry ($elemMatch),
 *               plus the day's syncedAt and holiday name.
 *
 * COMPANY SCOPE: the Employee and DailyAttendance collections carry no company
 * field today (docs/decisions/hr-organisation-scope.md — company scope is not
 * provable for HR records yet). The directory is therefore the whole
 * single-company deployment, exactly as the existing hr_employee tool sees it.
 * Cross-company isolation is exercised only in the offline fixtures until HR
 * records are stamped with a company.
 */

const Employee = require("../../../models/Employee");
const DailyAttendance = require("../../../models/HR_Models/Dailyattendance");
const { employeeIsActive } = require("../../access/hrAuthorization");

function mongoPorts() {
  return {
    directory: {
      async listVisible() {
        const rows = await Employee.find({ isActive: { $ne: false } })
          .select("firstName middleName lastName biometricId isActive status")
          .lean();
        return rows.filter(employeeIsActive).map((e) => ({
          employeeRef: String(e._id),
          employeeId: e.biometricId || null,
          firstName: e.firstName || "",
          middleName: e.middleName || "",
          lastName: e.lastName || "",
        }));
      },
    },
    attendance: {
      async readEmployeeDay({ dateStr, employeeId }) {
        const day = await DailyAttendance.findOne(
          { dateStr },
          { dateStr: 1, syncedAt: 1, "holiday.name": 1, employees: { $elemMatch: { biometricId: employeeId } } },
        ).lean();
        if (!day) return null;
        const e = Array.isArray(day.employees) && day.employees[0] ? day.employees[0] : null;
        return {
          syncedAt: day.syncedAt || null,
          holiday: day.holiday && day.holiday.name ? { name: day.holiday.name } : null,
          entry: e
            ? {
                inTime: e.inTime || null,
                outTime: e.finalOut || null,
                hrFinalStatus: e.hrFinalStatus || null,
                systemPrediction: e.systemPrediction || null,
              }
            : null,
        };
      },
    },
  };
}

module.exports = { mongoPorts };
