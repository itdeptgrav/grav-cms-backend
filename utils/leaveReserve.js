"use strict";
const { LeaveApplication } = require("../models/HR_Models/LeaveManagement");

const RESERVING_STATUSES = ["pending", "manager_approved"];

/**
 * Days committed by not-yet-approved applications, per bucket.
 * NOT persisted. Derived on every read.
 *
 * Three rules, each load-bearing:
 *  - `withdraw_pending` is EXCLUDED: those days are already inside `consumed`
 *    (they reached hr_approved), so counting them double-counts.
 *  - `leaveType: "QUICK"` and `"LOP"` are EXCLUDED: QUICK has paidDays:null
 *    until classified and belongs to no bucket yet; LOP never deducts.
 *  - `paidDays ?? totalDays` is the codebase-wide convention
 *    (leaveRoutes.js:2286, 1525, 474). Older rows have paidDays:null.
 *
 * @param {ObjectId|string} employeeId
 * @param {number} year
 * @returns {Promise<{CL:number, SL:number, PL:number}>}
 */
async function computeReserved(employeeId, year) {
  const rows = await LeaveApplication.find({
    employeeId,
    status: { $in: RESERVING_STATUSES },
    leaveType: { $in: ["CL", "SL", "PL"] },
    fromDate: { $gte: `${year}-01-01`, $lte: `${year}-12-31` },
  })
    .select("leaveType paidDays totalDays")
    .lean();

  const r = { CL: 0, SL: 0, PL: 0 };
  for (const a of rows) {
    const d = a.paidDays != null ? a.paidDays : a.totalDays || 0;
    if (d > 0 && r[a.leaveType] !== undefined) r[a.leaveType] += d;
  }
  return r;
}

module.exports = { computeReserved, RESERVING_STATUSES };
