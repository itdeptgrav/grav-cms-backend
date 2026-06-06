// routes/Accountant_Routes/Acc_payroll.js
// Accountant's Payroll View Routes (read-only + approval)

const express = require("express");
const router = express.Router();
const AccountantAuthMiddleware = require("../../Middlewear/AccountantAuthMiddleware");
const { Payroll, PayrollItem } = require("../../models/HR_Models/Payroll");
const Employee = require("../../models/Employee");

router.use(AccountantAuthMiddleware.accountantAuth);

// ── GET payroll runs list ──
// The run-level totals stored on the Payroll document (totalGross, etc.) can
// drift from the actual PayrollItem rows (e.g. items edited after the run was
// first saved). The Details view already recomputes live from PayrollItem, so
// the LIST was showing different numbers than Details. To keep them in sync we
// recompute each run's totals from its PayrollItems here and return them under
// the SAME field names the list reads — no frontend change needed.
router.get("/runs", async (req, res) => {
  try {
    const { year, status } = req.query;
    let filter = {};
    if (year) filter.year = parseInt(year);
    if (status) filter.status = status;

    const runs = await Payroll.find(filter)
      .sort({ year: -1, month: -1 })
      .populate("createdBy", "name email")
      .lean();

    if (runs.length) {
      // One aggregate across all listed runs → live totals per run, matching
      // the same reduce the Details endpoint uses on its `summary`.
      const runIds = runs.map((r) => r._id);
      const agg = await PayrollItem.aggregate([
        { $match: { payrollId: { $in: runIds } } },
        {
          $group: {
            _id: "$payrollId",
            totalEmployees: { $sum: 1 },
            totalGross: { $sum: { $ifNull: ["$earnings.grossEarnings", 0] } },
            totalDeductions: {
              $sum: { $ifNull: ["$deductions.totalDeductions", 0] },
            },
            totalNetPay: { $sum: { $ifNull: ["$netPay", 0] } },
            totalPF: { $sum: { $ifNull: ["$deductions.providentFund", 0] } },
            totalESIC: { $sum: { $ifNull: ["$deductions.esic", 0] } },
          },
        },
      ]);
      const liveById = new Map(agg.map((a) => [String(a._id), a]));

      for (const r of runs) {
        const live = liveById.get(String(r._id));
        if (live) {
          r.totalEmployees = live.totalEmployees;
          r.totalGross = live.totalGross;
          r.totalDeductions = live.totalDeductions;
          r.totalNetPay = live.totalNetPay;
          r.totalPF = live.totalPF;
          r.totalESIC = live.totalESIC;
        }
        // Runs with no PayrollItems keep their stored values (live = undefined).
      }
    }

    res.json({ success: true, payrollRuns: runs });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error fetching payroll runs" });
  }
});

// ── GET payroll items for a run ──
router.get("/runs/:runId/items", async (req, res) => {
  try {
    const { department, status, search } = req.query;
    let filter = { payrollId: req.params.runId };
    if (department) filter.department = department;
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { employeeName: { $regex: search, $options: "i" } },
        { biometricId: { $regex: search, $options: "i" } },
      ];
    }

    const items = await PayrollItem.find(filter)
      .sort({ employeeName: 1 })
      .lean();

    const summary = {
      totalEmployees: items.length,
      totalGross: items.reduce(
        (s, i) => s + (i.earnings?.grossEarnings || 0),
        0,
      ),
      totalDeductions: items.reduce(
        (s, i) => s + (i.deductions?.totalDeductions || 0),
        0,
      ),
      totalNetPay: items.reduce((s, i) => s + (i.netPay || 0), 0),
      totalPF: items.reduce(
        (s, i) => s + (i.deductions?.providentFund || 0),
        0,
      ),
      totalESIC: items.reduce((s, i) => s + (i.deductions?.esic || 0), 0),
      statusBreakdown: {
        pending: items.filter((i) => i.status === "pending").length,
        processed: items.filter((i) => i.status === "processed").length,
        paid: items.filter((i) => i.status === "paid").length,
      },
    };

    res.json({ success: true, items, summary });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error fetching payroll items" });
  }
});

// ── GET payroll analytics ──
router.get("/analytics", async (req, res) => {
  try {
    const { year } = req.query;
    const currentYear = parseInt(year) || new Date().getFullYear();

    const runs = await Payroll.find({
      year: { $in: [currentYear, currentYear - 1] },
    })
      .sort({ year: 1, month: 1 })
      .lean();

    // Recompute each run's totals live from PayrollItems (same reason as the
    // /runs list) so the analytics charts match the Details view.
    let liveById = new Map();
    if (runs.length) {
      const runIds = runs.map((r) => r._id);
      const agg = await PayrollItem.aggregate([
        { $match: { payrollId: { $in: runIds } } },
        {
          $group: {
            _id: "$payrollId",
            totalEmployees: { $sum: 1 },
            totalGross: { $sum: { $ifNull: ["$earnings.grossEarnings", 0] } },
            totalDeductions: {
              $sum: { $ifNull: ["$deductions.totalDeductions", 0] },
            },
            totalNetPay: { $sum: { $ifNull: ["$netPay", 0] } },
            totalPF: { $sum: { $ifNull: ["$deductions.providentFund", 0] } },
            totalESIC: { $sum: { $ifNull: ["$deductions.esic", 0] } },
          },
        },
      ]);
      liveById = new Map(agg.map((a) => [String(a._id), a]));
    }

    const monthlyData = runs.map((r) => {
      const live = liveById.get(String(r._id));
      return {
        month: r.payPeriod,
        year: r.year,
        totalGross: live ? live.totalGross : r.totalGross || 0,
        totalDeductions: live ? live.totalDeductions : r.totalDeductions || 0,
        totalNetPay: live ? live.totalNetPay : r.totalNetPay || 0,
        totalPF: live ? live.totalPF : r.totalPF || 0,
        totalESIC: live ? live.totalESIC : r.totalESIC || 0,
        employees: live ? live.totalEmployees : r.totalEmployees || 0,
      };
    });

    // Department-wise breakdown from latest payroll
    const latestRun = runs.filter((r) => r.year === currentYear).pop();
    let departmentBreakdown = [];
    if (latestRun) {
      const items = await PayrollItem.find({ payrollId: latestRun._id })
        .select("department earnings.grossEarnings netPay")
        .lean();

      const deptMap = {};
      items.forEach((i) => {
        const dept = i.department || "Other";
        if (!deptMap[dept])
          deptMap[dept] = {
            department: dept,
            totalGross: 0,
            totalNet: 0,
            count: 0,
          };
        deptMap[dept].totalGross += i.earnings?.grossEarnings || 0;
        deptMap[dept].totalNet += i.netPay || 0;
        deptMap[dept].count++;
      });
      departmentBreakdown = Object.values(deptMap);
    }

    res.json({
      success: true,
      analytics: { monthlyData, departmentBreakdown },
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error fetching payroll analytics" });
  }
});

// ── GET employee salary details ──
router.get("/employee/:employeeId", async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.employeeId)
      .select(
        "firstName lastName email department salary biometricId designation",
      )
      .lean();

    if (!employee)
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });

    const payrollHistory = await PayrollItem.find({
      employeeId: req.params.employeeId,
    })
      .sort({ year: -1, month: -1 })
      .limit(12)
      .lean();

    res.json({ success: true, employee, payrollHistory });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error fetching employee salary" });
  }
});

module.exports = router;
