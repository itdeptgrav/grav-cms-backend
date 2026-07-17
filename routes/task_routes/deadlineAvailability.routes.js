const express = require("express");
const router = express.Router();
const Employee = require("../../models/Employee");
const { LeaveApplication, CompanyHoliday } = require("../../models/HR_Models/LeaveManagement");

function toDateStr(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/**
 * GET /cowork/deadline-availability/blocked-dates?employeeId=E001&fromDate=2026-07-16&days=30
 * Returns every date in the window that should be SKIPPED when computing a
 * due date for this employee: company holidays (everyone) + this specific
 * employee's HR-approved leave days.
 */
router.get("/deadline-availability/blocked-dates", async (req, res) => {
  try {
    const { employeeId, fromDate, days } = req.query;
    if (!employeeId || !fromDate) {
      return res.status(400).json({ success: false, message: "employeeId and fromDate are required." });
    }
    const windowDays = Math.min(Number(days) || 30, 90);
    const start = new Date(fromDate);
    const end = new Date(start);
    end.setDate(end.getDate() + windowDays);
    const startStr = toDateStr(start);
    const endStr = toDateStr(end);

    const holidays = await CompanyHoliday.find({
      date: { $gte: startStr, $lte: endStr },
    }).lean();

    // CoWork's employeeId IS the HR biometricId — bridge to Mongo's ObjectId here.
    const employee = await Employee.findOne({ biometricId: employeeId }).select("_id").lean();

    let leaves = [];
    if (employee) {
      leaves = await LeaveApplication.find({
        employeeId: employee._id,
        status: { $in: ["hr_approved", "withdraw_pending"] },
        fromDate: { $lte: endStr },
        toDate: { $gte: startStr },
      }).select("fromDate toDate leaveType").lean();
    }

    const leaveDateSet = new Set();
    for (const lv of leaves) {
      const d = new Date(Math.max(new Date(lv.fromDate), start));
      const lastDay = new Date(Math.min(new Date(lv.toDate), end));
      while (d <= lastDay) {
        leaveDateSet.add(toDateStr(d));
        d.setDate(d.getDate() + 1);
      }
    }

    const blocked = [
      ...holidays.map(h => ({ date: h.date, reason: "holiday", name: h.name })),
      ...[...leaveDateSet].map(date => ({ date, reason: "leave", name: "Approved leave" })),
    ].sort((a, b) => a.date.localeCompare(b.date));

    res.json({ success: true, blocked });
  } catch (e) {
    console.error("[deadline-availability]", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;