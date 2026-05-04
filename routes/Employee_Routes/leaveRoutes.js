"use strict";
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const multer = require("multer");
const {
  notifyManagerOnLeaveApply,
  notifySecondaryOnPrimaryApproval,
  notifyEmployeeOnLeaveAction,
} = require("../../services/leaveNotification.service");
const { uploadToGoogleDrive } = require("../../services/mediaUpload.service");

const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const a = [
      "application/pdf",
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
    ];
    if (a.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only PDF, JPG, PNG or WEBP allowed."));
  },
}).single("document");

const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");
const Employee = require("../../models/Employee");
const {
  LeaveConfig,
  LeaveBalance,
  LeaveApplication,
  CompanyHoliday,
} = require("../../models/HR_Models/LeaveManagement");

function countLeaveDays(startStr, endStr) {
  if (!startStr || !endStr) return 0;
  const [sy, sm, sd] = startStr.split("-").map(Number);
  const [ey, em, ed] = endStr.split("-").map(Number);
  const from = new Date(sy, sm - 1, sd),
    to = new Date(ey, em - 1, ed);
  if (from > to) return 0;
  if (from.getTime() === to.getTime() && from.getDay() === 6) return 0;
  return Math.round((to - from) / (24 * 60 * 60 * 1000)) + 1;
}

function workingDaysSinceJoining(joiningDate) {
  if (!joiningDate) return 0;
  const join = new Date(joiningDate),
    today = new Date();
  let count = 0;
  const cur = new Date(join.getFullYear(), join.getMonth(), join.getDate()),
    end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  while (cur <= end) {
    if (cur.getDay() !== 0) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

async function ensureBalance(employeeId, year, biometricId, config) {
  let bal = await LeaveBalance.findOne({ employeeId, year });
  if (!bal) {
    bal = await LeaveBalance.create({
      employeeId,
      biometricId: biometricId || "",
      year,
      entitlement: { CL: config.clPerYear, SL: config.slPerYear, PL: 0 },
      consumed: { CL: 0, SL: 0, PL: 0 },
      plEligible: false,
    });
  } else {
    let d = false;
    if (bal.entitlement.CL !== config.clPerYear) {
      bal.entitlement.CL = config.clPerYear;
      d = true;
    }
    if (bal.entitlement.SL !== config.slPerYear) {
      bal.entitlement.SL = config.slPerYear;
      d = true;
    }
    if (bal.plEligible && bal.entitlement.PL !== config.plPerYear) {
      bal.entitlement.PL = config.plPerYear;
      d = true;
    }
    if (d) await bal.save();
  }
  return bal;
}

// Helper: count days of existing leaves in a given month
async function countMonthlyUsage(employeeId, fromDate, leaveTypeFilter) {
  const month = new Date(fromDate).getMonth() + 1;
  const year = new Date(fromDate).getFullYear();
  const mStr = String(month).padStart(2, "0");
  const monthStart = `${year}-${mStr}-01`;
  const monthEnd = `${year}-${mStr}-${new Date(year, month, 0).getDate()}`;

  const filter = {
    employeeId,
    status: { $nin: ["hr_rejected", "manager_rejected", "cancelled"] },
    fromDate: { $lte: monthEnd },
    toDate: { $gte: monthStart },
  };
  if (leaveTypeFilter) filter.leaveType = leaveTypeFilter;

  const existing = await LeaveApplication.find(filter).lean();
  let used = 0;
  for (const a of existing) {
    const aFrom = a.fromDate > monthStart ? a.fromDate : monthStart;
    const aTo = a.toDate < monthEnd ? a.toDate : monthEnd;
    used += a.isHalfDay ? 0.5 : countLeaveDays(aFrom, aTo);
  }
  return { used, monthStart, monthEnd };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/config", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    res.json({ success: true, data: await LeaveConfig.getConfig() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
router.get("/holidays", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const y = req.query.year || new Date().getFullYear();
    res.json({
      success: true,
      data: await CompanyHoliday.find({
        date: { $gte: `${y}-01-01`, $lte: `${y}-12-31` },
      })
        .sort({ date: 1 })
        .lean(),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
router.get("/balance", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const id = req.user.id,
      year = Number(req.query.year) || new Date().getFullYear();
    const config = await LeaveConfig.getConfig();
    const emp = await Employee.findById(id)
      .select("biometricId dateOfJoining")
      .lean();
    const bal = await ensureBalance(id, year, emp?.biometricId, config);
    const wd = workingDaysSinceJoining(emp?.dateOfJoining);
    const wc = wd >= config.initialWaitingDays;
    const pc = wd >= config.daysRequiredForPL;
    if (pc && !bal.plEligible) {
      bal.plEligible = true;
      bal.plGrantedDate = new Date();
      bal.entitlement.PL = config.plPerYear;
      await bal.save();
    }
    const le = {
      CL: config.clPerYear,
      SL: config.slPerYear,
      PL: bal.plEligible ? config.plPerYear : 0,
    };
    const av = {
      CL: Math.max(0, le.CL - bal.consumed.CL),
      SL: Math.max(0, le.SL - bal.consumed.SL),
      PL: Math.max(0, le.PL - bal.consumed.PL),
    };
    res.json({
      success: true,
      data: {
        balance: bal,
        available: av,
        entitlement: bal.entitlement,
        consumed: bal.consumed,
        config: {
          initialWaitingDays: config.initialWaitingDays,
          clPerYear: config.clPerYear,
          slPerYear: config.slPerYear,
          plPerYear: config.plPerYear,
          daysRequiredForPL: config.daysRequiredForPL,
          slDocumentThreshold: config.slDocumentThreshold,
          maxCLPerMonth: config.maxCLPerMonth,
          maxLeaveDaysPerMonth: config.maxLeaveDaysPerMonth,
          maxLeaveDaysPerMonthOdisha: config.maxLeaveDaysPerMonthOdisha,
        },
        eligibility: {
          waitingComplete: wc,
          plComplete: pc,
          workingDays: wd,
          canApplyCL: wc,
          canApplySL: wc,
          canApplyPL: pc,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
router.get("/", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const { status, leaveType, year } = req.query;
    const f = { employeeId: req.user.id };
    if (status && status !== "all") f.status = status;
    if (leaveType && leaveType !== "all") f.leaveType = leaveType;
    if (year) {
      f.fromDate = { $gte: `${year}-01-01` };
      f.toDate = { $lte: `${year}-12-31` };
    }
    res.json({
      success: true,
      data: await LeaveApplication.find(f).sort({ createdAt: -1 }).lean(),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
router.get("/calendar", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const y = Number(req.query.year) || new Date().getFullYear(),
      m = Number(req.query.month) || new Date().getMonth() + 1,
      ms = String(m).padStart(2, "0"),
      from = `${y}-${ms}-01`,
      to = `${y}-${ms}-31`;
    const [ml, hol] = await Promise.all([
      LeaveApplication.find({
        employeeId: req.user.id,
        fromDate: { $lte: to },
        toDate: { $gte: from },
      }).lean(),
      CompanyHoliday.find({ date: { $gte: from, $lte: to } }).lean(),
    ]);
    const dim = new Date(y, m, 0).getDate(),
      cal = [];
    for (let d = 1; d <= dim; d++) {
      const ds = `${y}-${ms}-${String(d).padStart(2, "0")}`;
      const [py, pm, pd] = ds.split("-").map(Number);
      const dow = new Date(py, pm - 1, pd).getDay();
      const isSun = dow === 0;
      const hh = hol.find((h) => h.date === ds) || null;
      const ho = isSun
        ? hh || { date: ds, name: "Sunday", type: "company" }
        : hh;
      const lv = ml.find(
        (a) => a.fromDate <= ds && a.toDate >= ds && a.status === "hr_approved",
      );
      cal.push({
        date: ds,
        dayOfWeek: dow,
        weekend: false,
        holiday: ho,
        leave: lv ? { leaveType: lv.leaveType, status: lv.status } : null,
        status: ho ? "holiday" : lv ? lv.leaveType : "workday",
      });
    }
    res.json({
      success: true,
      data: { calendar: cal, holidays: hol, leaves: ml },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  MANAGER ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/manager/my-team", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    res.json({
      success: true,
      data: await Employee.find({
        isActive: true,
        $or: [
          { "primaryManager.managerId": req.user.id },
          { "secondaryManager.managerId": req.user.id },
        ],
      })
        .select(
          "firstName lastName biometricId department designation primaryManager secondaryManager",
        )
        .lean(),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});
router.get("/manager/pending", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    res.json({
      success: true,
      data: await LeaveApplication.find({
        $or: [
          {
            managersNotified: {
              $elemMatch: { managerId: req.user.id, type: "primary" },
            },
            status: "pending",
          },
          {
            managersNotified: {
              $elemMatch: { managerId: req.user.id, type: "secondary" },
            },
            status: "manager_approved",
          },
        ],
      })
        .sort({ createdAt: -1 })
        .lean(),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post(
  "/manager/add-on-behalf",
  AllEmployeeAppMiddleware,
  async (req, res) => {
    try {
      const {
        employeeId,
        leaveType,
        fromDate,
        toDate,
        reason,
        isHalfDay,
        halfDaySlot,
        managerRemarks,
      } = req.body;
      if (!employeeId || !leaveType || !fromDate || !toDate || !reason)
        return res
          .status(400)
          .json({ success: false, message: "All fields required" });
      if (!["CL", "SL", "PL"].includes(leaveType))
        return res
          .status(400)
          .json({ success: false, message: "Invalid leave type" });
      const myId = req.user.id;
      const te = await Employee.findById(employeeId)
        .select(
          "firstName lastName biometricId designation department dateOfJoining primaryManager secondaryManager email address",
        )
        .lean();
      if (!te)
        return res
          .status(404)
          .json({ success: false, message: "Employee not found" });
      const isP = String(te.primaryManager?.managerId) === String(myId),
        isS = String(te.secondaryManager?.managerId) === String(myId);
      if (!isP && !isS)
        return res
          .status(403)
          .json({ success: false, message: "Not a manager of this employee" });
      const config = await LeaveConfig.getConfig();
      const year = new Date(fromDate).getFullYear();
      const wd = workingDaysSinceJoining(te.dateOfJoining);
      if (wd < config.initialWaitingDays)
        return res
          .status(400)
          .json({
            success: false,
            message: `Waiting period not complete (${wd}/${config.initialWaitingDays})`,
            code: "WAITING_PERIOD",
          });
      if (leaveType === "PL" && wd < config.daysRequiredForPL)
        return res
          .status(400)
          .json({
            success: false,
            message: `Not eligible for PL (${wd}/${config.daysRequiredForPL})`,
            code: "PL_NOT_ELIGIBLE",
          });
      const totalDays = isHalfDay ? 0.5 : countLeaveDays(fromDate, toDate);
      if (totalDays <= 0)
        return res
          .status(400)
          .json({ success: false, message: "No valid days" });
      const oc = await LeaveApplication.findOne({
        employeeId,
        status: { $nin: ["hr_rejected", "manager_rejected", "cancelled"] },
        fromDate: { $lte: toDate },
        toDate: { $gte: fromDate },
      });
      if (oc)
        return res
          .status(400)
          .json({
            success: false,
            message: `Already has leave ${oc.fromDate}–${oc.toDate}`,
            code: "OVERLAP",
          });
      const bal = await ensureBalance(employeeId, year, te.biometricId, config);
      if (leaveType === "PL" && !bal.plEligible) {
        bal.plEligible = true;
        bal.plGrantedDate = new Date();
        bal.entitlement.PL = config.plPerYear;
        await bal.save();
      }
      const le = {
        CL: config.clPerYear,
        SL: config.slPerYear,
        PL: bal.plEligible ? config.plPerYear : 0,
      };
      const av = Math.max(0, le[leaveType] - bal.consumed[leaveType]);
      if (totalDays > av)
        return res
          .status(400)
          .json({
            success: false,
            message: `Insufficient ${leaveType}. Available: ${av}`,
            code: "INSUFFICIENT_BALANCE",
          });
      const rd = leaveType === "SL" && totalDays > config.slDocumentThreshold;
      const mn = [];
      if (te.primaryManager?.managerId)
        mn.push({
          managerId: te.primaryManager.managerId,
          managerName: te.primaryManager.managerName || "",
          type: "primary",
        });
      if (te.secondaryManager?.managerId)
        mn.push({
          managerId: te.secondaryManager.managerId,
          managerName: te.secondaryManager.managerName || "",
          type: "secondary",
        });
      const me = await Employee.findById(myId)
        .select("firstName lastName")
        .lean();
      const mName = me
        ? `${me.firstName || ""} ${me.lastName || ""}`.trim()
        : "Manager";
      const md = [
        {
          managerId: myId,
          managerName: mName,
          type: isP ? "primary" : "secondary",
          decision: "approved",
          remarks: managerRemarks || "On behalf",
          decidedAt: new Date(),
        },
      ];
      const hasSec = !!te.secondaryManager?.managerId;
      const st = isP && hasSec ? "manager_approved" : "hr_approved";
      const app = await LeaveApplication.create({
        employeeId,
        biometricId: te.biometricId,
        employeeName: `${te.firstName} ${te.lastName}`.trim(),
        designation: te.designation,
        department: te.department,
        leaveType,
        applicationDate: new Date().toISOString().split("T")[0],
        fromDate,
        toDate,
        totalDays,
        reason,
        isHalfDay: !!isHalfDay,
        halfDaySlot: isHalfDay ? halfDaySlot || "first_half" : null,
        requiresDocument: rd,
        managersNotified: mn,
        managerDecisions: md,
        status: st,
        hrRemarks: st === "hr_approved" ? `Approved by ${mName}` : undefined,
        hrApprovedAt: st === "hr_approved" ? new Date() : undefined,
      });
      if (st === "hr_approved") {
        try {
          const eb = await LeaveBalance.findOne({ employeeId, year });
          if (eb) {
            eb.consumed[leaveType] = (eb.consumed[leaveType] || 0) + totalDays;
            await eb.save();
          } else {
            const ic = { CL: 0, SL: 0, PL: 0 };
            ic[leaveType] = totalDays;
            await LeaveBalance.create({
              employeeId,
              biometricId: te.biometricId || "",
              year,
              entitlement: {
                CL: config.clPerYear,
                SL: config.slPerYear,
                PL: 0,
              },
              consumed: ic,
            });
          }
        } catch (e) {
          console.warn("[MGR]", e.message);
        }
        try {
          const {
            applyLeaveToAttendance,
          } = require("../HrRoutes/Attendance_section");
          if (applyLeaveToAttendance) await applyLeaveToAttendance(app);
        } catch (e) {
          console.warn("[MGR]", e.message);
        }
      }
      res
        .status(201)
        .json({
          success: true,
          data: app,
          message:
            st === "hr_approved"
              ? `Leave approved for ${te.firstName}.`
              : "Routed to secondary manager.",
        });
    } catch (err) {
      console.error("[MGR]", err);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

router.get("/:id", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).json({ success: false, message: "Invalid ID" });
    const a = await LeaveApplication.findOne({
      _id: req.params.id,
      employeeId: req.user.id,
    }).lean();
    if (!a)
      return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, data: a });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  APPLY FOR LEAVE — with monthly CL cap + monthly total cap (state-based)
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const {
      leaveType,
      applicationDate,
      fromDate,
      toDate,
      reason,
      isHalfDay,
      halfDaySlot,
    } = req.body;
    if (!leaveType || !applicationDate || !fromDate || !toDate || !reason)
      return res
        .status(400)
        .json({ success: false, message: "All fields required" });
    if (!["CL", "SL", "PL"].includes(leaveType))
      return res
        .status(400)
        .json({ success: false, message: "Invalid leave type" });
    if (new Date(toDate) < new Date(fromDate))
      return res
        .status(400)
        .json({ success: false, message: "To date before from date" });

    const emp = await Employee.findById(req.user.id)
      .select(
        "firstName lastName biometricId designation department dateOfJoining primaryManager secondaryManager address",
      )
      .lean();
    if (!emp)
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });
    const config = await LeaveConfig.getConfig();
    const year = new Date(fromDate).getFullYear();

    // Waiting period
    const wd = workingDaysSinceJoining(emp.dateOfJoining);
    if (wd < config.initialWaitingDays)
      return res
        .status(400)
        .json({
          success: false,
          message: `Complete ${config.initialWaitingDays} working days first. You have ${wd}.`,
          code: "WAITING_PERIOD",
        });
    if (leaveType === "PL" && wd < config.daysRequiredForPL)
      return res
        .status(400)
        .json({
          success: false,
          message: `PL available after ${config.daysRequiredForPL} days. You have ${wd}.`,
          code: "PL_NOT_ELIGIBLE",
        });

    // Calculate days
    const [fsy, fsm, fsd] = fromDate.split("-").map(Number);
    const [tsy, tsm, tsd] = toDate.split("-").map(Number);
    if (
      new Date(fsy, fsm - 1, fsd).getTime() ===
        new Date(tsy, tsm - 1, tsd).getTime() &&
      new Date(fsy, fsm - 1, fsd).getDay() === 6
    )
      return res
        .status(400)
        .json({
          success: false,
          message: "Saturday is not a valid leave day.",
          code: "SATURDAY_BLOCKED",
        });
    const totalDays = isHalfDay ? 0.5 : countLeaveDays(fromDate, toDate);
    if (totalDays <= 0)
      return res
        .status(400)
        .json({ success: false, message: "No valid leave days" });

    // ══════════════════════════════════════════════════════════════════
    //  MONTHLY CL LIMIT — max CL days in one calendar month
    // ══════════════════════════════════════════════════════════════════
    if (leaveType === "CL") {
      const maxCLMonth = config.maxCLPerMonth || 3;
      const { used: clUsed } = await countMonthlyUsage(
        req.user.id,
        fromDate,
        "CL",
      );

      // Count how many CL days this new application adds to the month
      const month = new Date(fromDate).getMonth() + 1;
      const yr = new Date(fromDate).getFullYear();
      const ms = String(month).padStart(2, "0");
      const mStart = `${yr}-${ms}-01`,
        mEnd = `${yr}-${ms}-${new Date(yr, month, 0).getDate()}`;
      const nFrom = fromDate > mStart ? fromDate : mStart;
      const nTo = toDate < mEnd ? toDate : mEnd;
      const newCLInMonth = isHalfDay ? 0.5 : countLeaveDays(nFrom, nTo);
      console.log(
        `[LEAVE-CL] CL used this month: ${clUsed}, new CL: ${newCLInMonth}, maxCLMonth: ${maxCLMonth}, total: ${clUsed + newCLInMonth}`,
      );

      if (clUsed + newCLInMonth > maxCLMonth) {
        const remaining = Math.max(0, maxCLMonth - clUsed);
        const plBal = await ensureBalance(
          req.user.id,
          year,
          emp.biometricId,
          config,
        );
        const plAvailable = plBal.plEligible
          ? Math.max(0, config.plPerYear - plBal.consumed.PL)
          : 0;
        const suggestion =
          plAvailable > 0
            ? ` You have ${plAvailable} PL days available. Use PL for additional days.`
            : " Reduce CL days or contact HR.";
        return res.status(400).json({
          success: false,
          message: `Maximum ${maxCLMonth} CL days allowed per month. You've already used ${clUsed} CL this month. Remaining: ${remaining}.${suggestion}`,
          code: "CL_MONTHLY_EXCEEDED",
          maxCLMonth,
          clUsed,
          remaining,
          plAvailable,
        });
      }
    }

    // ══════════════════════════════════════════════════════════════════
    //  MONTHLY TOTAL CAP — all types combined, state-based (Odisha)
    // ══════════════════════════════════════════════════════════════════
    {
      const empState = (
        emp.address?.current?.state ||
        emp.address?.permanent?.state ||
        ""
      )
        .toLowerCase()
        .trim();
      const isOdisha = ["odisha", "orissa"].includes(empState);
      const monthlyCap = isOdisha
        ? config.maxLeaveDaysPerMonthOdisha || 7
        : config.maxLeaveDaysPerMonth || 10;
      console.log(
        `[LEAVE-CAP] Employee: ${emp.firstName} ${emp.lastName}, State: "${empState}", isOdisha: ${isOdisha}, monthlyCap: ${monthlyCap}, config.maxLeaveDaysPerMonthOdisha: ${config.maxLeaveDaysPerMonthOdisha}, config.maxLeaveDaysPerMonth: ${config.maxLeaveDaysPerMonth}`,
      );

      const {
        used: totalUsed,
        monthStart,
        monthEnd,
      } = await countMonthlyUsage(req.user.id, fromDate, null); // null = all types
      const nFrom = fromDate > monthStart ? fromDate : monthStart;
      const nTo = toDate < monthEnd ? toDate : monthEnd;
      const newDaysInMonth = isHalfDay ? 0.5 : countLeaveDays(nFrom, nTo);
      console.log(
        `[LEAVE-CAP] Total used this month: ${totalUsed}, new: ${newDaysInMonth}, total: ${totalUsed + newDaysInMonth}, cap: ${monthlyCap}`,
      );

      if (totalUsed + newDaysInMonth > monthlyCap) {
        console.log(
          `[LEAVE-CAP] BLOCKED: totalUsed=${totalUsed} + new=${newDaysInMonth} = ${totalUsed + newDaysInMonth} > cap=${monthlyCap}`,
        );
        const remaining = Math.max(0, monthlyCap - totalUsed);
        return res.status(400).json({
          success: false,
          message: `Maximum ${monthlyCap} days of leave allowed per month. You've already used ${totalUsed} days this month. Remaining: ${remaining} days.`,
          code: "MONTHLY_CAP_EXCEEDED",
          monthlyCap,
          totalUsed,
          remaining,
        });
      }
    }

    // Overlap
    const oc = await LeaveApplication.findOne({
      employeeId: req.user.id,
      status: { $nin: ["hr_rejected", "manager_rejected", "cancelled"] },
      fromDate: { $lte: toDate },
      toDate: { $gte: fromDate },
    });
    if (oc)
      return res
        .status(400)
        .json({
          success: false,
          message: `Already have leave ${oc.fromDate}–${oc.toDate}.`,
          code: "OVERLAP",
        });

    // Balance
    const bal = await ensureBalance(req.user.id, year, emp.biometricId, config);
    if (leaveType === "PL" && !bal.plEligible) {
      bal.plEligible = true;
      bal.plGrantedDate = new Date();
      bal.entitlement.PL = config.plPerYear;
      await bal.save();
    }
    const le = {
      CL: config.clPerYear,
      SL: config.slPerYear,
      PL: bal.plEligible ? config.plPerYear : 0,
    };
    const av = Math.max(0, le[leaveType] - bal.consumed[leaveType]);
    if (totalDays > av)
      return res
        .status(400)
        .json({
          success: false,
          message: `Insufficient ${leaveType}. Available: ${av}, Requested: ${totalDays}.`,
          code: "INSUFFICIENT_BALANCE",
        });

    const rd = leaveType === "SL" && totalDays > config.slDocumentThreshold;
    const mn = [];
    if (emp.primaryManager?.managerId)
      mn.push({
        managerId: emp.primaryManager.managerId,
        managerName: emp.primaryManager.managerName || "",
        type: "primary",
      });
    if (emp.secondaryManager?.managerId)
      mn.push({
        managerId: emp.secondaryManager.managerId,
        managerName: emp.secondaryManager.managerName || "",
        type: "secondary",
      });

    const app = await LeaveApplication.create({
      employeeId: req.user.id,
      biometricId: emp.biometricId,
      employeeName: `${emp.firstName} ${emp.lastName}`.trim(),
      designation: emp.designation,
      department: emp.department,
      leaveType,
      applicationDate,
      fromDate,
      toDate,
      totalDays,
      reason,
      isHalfDay: !!isHalfDay,
      halfDaySlot: isHalfDay ? halfDaySlot || "first_half" : null,
      requiresDocument: rd,
      managersNotified: mn,
      status: "pending",
    });

    try {
      const es = require("../../services/emailService");
      if (es.sendLeaveAppliedToHR)
        es.sendLeaveAppliedToHR({
          employeeName: app.employeeName,
          department: app.department,
          designation: app.designation,
          leaveType,
          fromDate,
          toDate,
          totalDays,
          reason,
          isHalfDay: app.isHalfDay,
          requiresDocument: rd,
          applicationId: app._id.toString(),
        }).catch((e) => console.warn("[EMAIL]", e.message));
    } catch (_) {}
    try {
      const io = req.app.get("io");
      if (io && mn.length > 0) {
        const p = mn.find((m) => m.type === "primary");
        if (p?.managerId)
          io.to(String(p.managerId)).emit("leave_notification", {
            type: "leave_applied",
            leaveId: app._id.toString(),
            employeeName: app.employeeName,
            leaveType,
            fromDate,
            toDate,
            totalDays,
            message: `${app.employeeName} applied for ${leaveType} (${fromDate}–${toDate})`,
            timestamp: new Date().toISOString(),
          });
      }
    } catch (_) {}
    notifyManagerOnLeaveApply(emp, app).catch((e) =>
      console.warn("[PUSH]", e.message),
    );

    res
      .status(201)
      .json({
        success: true,
        data: app,
        message: rd
          ? `Leave submitted. Submit supporting docs for ${totalDays} days SL.`
          : "Leave application submitted successfully",
        requiresDocument: rd,
      });
  } catch (err) {
    console.error("Apply leave:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch("/:id/cancel", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const a = await LeaveApplication.findOne({
      _id: req.params.id,
      employeeId: req.user.id,
    });
    if (!a)
      return res.status(404).json({ success: false, message: "Not found" });
    if (!["pending", "manager_approved"].includes(a.status))
      return res.status(400).json({ success: false, message: "Cannot cancel" });
    a.status = "cancelled";
    a.cancelledBy = req.user.id;
    a.cancelledAt = new Date();
    a.cancelReason = req.body.cancelReason || "";
    await a.save();
    res.json({ success: true, data: a, message: "Cancelled" });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});
router.put("/:id", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).json({ success: false, message: "Invalid ID" });
    const a = await LeaveApplication.findOne({
      _id: req.params.id,
      employeeId: req.user.id,
    });
    if (!a)
      return res.status(404).json({ success: false, message: "Not found" });
    if (a.status !== "pending")
      return res
        .status(400)
        .json({ success: false, message: `Cannot edit — ${a.status}` });
    const { fromDate, toDate, reason, isHalfDay, halfDaySlot } = req.body;
    const nF = fromDate || a.fromDate,
      nT = isHalfDay ? nF : toDate || a.toDate;
    const [fy, fm, fd] = nF.split("-").map(Number);
    const [ty, tm, td] = nT.split("-").map(Number);
    if (
      new Date(fy, fm - 1, fd).getTime() ===
        new Date(ty, tm - 1, td).getTime() &&
      new Date(fy, fm - 1, fd).getDay() === 6
    )
      return res
        .status(400)
        .json({ success: false, message: "Saturday invalid" });
    const nt = (isHalfDay !== undefined ? isHalfDay : a.isHalfDay)
      ? 0.5
      : countLeaveDays(nF, nT);
    if (nt <= 0)
      return res.status(400).json({ success: false, message: "No valid days" });
    const c = await LeaveApplication.findOne({
      _id: { $ne: req.params.id },
      employeeId: req.user.id,
      status: { $nin: ["hr_rejected", "manager_rejected", "cancelled"] },
      fromDate: { $lte: nT },
      toDate: { $gte: nF },
    });
    if (c)
      return res
        .status(400)
        .json({
          success: false,
          message: `Conflicts with ${c.fromDate}–${c.toDate}`,
          code: "OVERLAP",
        });
    a.fromDate = nF;
    a.toDate = nT;
    a.totalDays = nt;
    if (reason !== undefined) a.reason = reason;
    if (isHalfDay !== undefined) {
      a.isHalfDay = isHalfDay;
      a.halfDaySlot = isHalfDay ? halfDaySlot || "first_half" : null;
    }
    await a.save();
    res.json({ success: true, data: a, message: "Updated" });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});
router.delete("/:id", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).json({ success: false, message: "Invalid ID" });
    const a = await LeaveApplication.findOne({
      _id: req.params.id,
      employeeId: req.user.id,
    });
    if (!a)
      return res.status(404).json({ success: false, message: "Not found" });
    if (a.status !== "pending")
      return res
        .status(400)
        .json({ success: false, message: `Cannot delete — ${a.status}` });
    await LeaveApplication.deleteOne({ _id: req.params.id });
    res.json({ success: true, message: "Deleted" });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post(
  "/:id/upload-document",
  AllEmployeeAppMiddleware,
  (req, res, next) => {
    uploadMiddleware(req, res, (err) => {
      if (err)
        return res.status(400).json({ success: false, message: err.message });
      next();
    });
  },
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id))
        return res.status(400).json({ success: false, message: "Invalid ID" });
      if (!req.file)
        return res.status(400).json({ success: false, message: "No file" });
      const a = await LeaveApplication.findOne({
        _id: req.params.id,
        employeeId: req.user.id,
      });
      if (!a)
        return res.status(404).json({ success: false, message: "Not found" });
      if (!a.requiresDocument)
        return res
          .status(400)
          .json({ success: false, message: "No doc needed" });
      const fn = `SL_${a.employeeName}_${a.fromDate}_${Date.now()}${req.file.originalname.includes(".") ? req.file.originalname.slice(req.file.originalname.lastIndexOf(".")) : ".pdf"}`;
      const dr = await uploadToGoogleDrive(req.file.buffer, {
        fileName: fn,
        mimeType: req.file.mimetype,
      });
      a.documentSubmitted = true;
      a.documentUrl = dr.viewUrl;
      a.documentFileId = dr.fileId;
      a.documentFileName = fn;
      a.documentUploadedAt = new Date();
      await a.save();
      res.json({
        success: true,
        message: "Uploaded",
        data: { documentUrl: dr.viewUrl, documentFileName: fn },
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
//  MANAGER APPROVAL/REJECT
// ═══════════════════════════════════════════════════════════════════════════════
router.patch(
  "/manager/:id/approve",
  AllEmployeeAppMiddleware,
  async (req, res) => {
    try {
      const { remarks } = req.body;
      const myId = req.user.id;
      const a = await LeaveApplication.findOne({
        _id: req.params.id,
        "managersNotified.managerId": myId,
      });
      if (!a)
        return res.status(404).json({ success: false, message: "Not found" });
      const mgr = a.managersNotified.find(
        (m) => String(m.managerId) === String(myId),
      );
      const mt = mgr?.type || "primary";
      if (mt === "primary" && a.status !== "pending")
        return res
          .status(400)
          .json({ success: false, message: `Cannot approve — ${a.status}` });
      if (mt === "secondary" && a.status !== "manager_approved")
        return res
          .status(400)
          .json({ success: false, message: "Primary must approve first" });
      if (!a.managerDecisions.find((d) => String(d.managerId) === String(myId)))
        a.managerDecisions.push({
          managerId: myId,
          managerName: mgr?.managerName || "",
          type: mt,
          decision: "approved",
          remarks: remarks || "",
          decidedAt: new Date(),
        });
      const hs = a.managersNotified.some((m) => m.type === "secondary");
      if (mt === "primary" && hs) {
        a.status = "manager_approved";
        await a.save();
        try {
          const io = req.app.get("io");
          if (io) {
            const s = a.managersNotified.find((m) => m.type === "secondary");
            if (s?.managerId)
              io.to(String(s.managerId)).emit("leave_notification", {
                type: "leave_pending_approval",
                leaveId: a._id.toString(),
                employeeName: a.employeeName,
                leaveType: a.leaveType,
                fromDate: a.fromDate,
                toDate: a.toDate,
                totalDays: a.totalDays,
                message: `${a.employeeName}'s ${a.leaveType} needs approval`,
                timestamp: new Date().toISOString(),
              });
          }
        } catch (_) {}
        notifySecondaryOnPrimaryApproval(a).catch(() => {});
        return res.json({
          success: true,
          data: a,
          message: "Primary approved. Awaiting secondary.",
        });
      }
      const {
        LeaveConfig: LC,
        LeaveBalance: LB,
      } = require("../../models/HR_Models/LeaveManagement");
      const {
        applyLeaveToAttendance,
      } = require("../HrRoutes/Attendance_section");
      a.status = "hr_approved";
      a.hrApprovedAt = new Date();
      a.hrRemarks = remarks || `Approved by ${mt} manager`;
      await a.save();
      const fy = new Date(a.fromDate).getFullYear();
      const fc = await LC.getConfig();
      const eb = await LB.findOne({ employeeId: a.employeeId, year: fy });
      if (eb) {
        eb.consumed[a.leaveType] =
          (eb.consumed[a.leaveType] || 0) + a.totalDays;
        await eb.save();
      } else {
        const nc = { CL: 0, SL: 0, PL: 0 };
        nc[a.leaveType] = a.totalDays;
        await LB.create({
          employeeId: a.employeeId,
          biometricId: a.biometricId || "",
          year: fy,
          entitlement: { CL: fc.clPerYear, SL: fc.slPerYear, PL: 0 },
          consumed: nc,
        });
      }
      let ar = { applied: 0 };
      try {
        if (applyLeaveToAttendance) ar = await applyLeaveToAttendance(a);
      } catch (e) {
        console.warn("[APPROVE]", e.message);
      }
      try {
        const io = req.app.get("io");
        if (io)
          io.to(String(a.employeeId)).emit("leave_notification", {
            type: "leave_approved",
            leaveId: a._id.toString(),
            leaveType: a.leaveType,
            fromDate: a.fromDate,
            toDate: a.toDate,
            totalDays: a.totalDays,
            message: `Your ${a.leaveType} (${a.fromDate}–${a.toDate}) approved`,
            timestamp: new Date().toISOString(),
          });
      } catch (_) {}
      notifyEmployeeOnLeaveAction(
        a,
        "approved",
        mgr?.managerName || "Manager",
      ).catch(() => {});
      res.json({
        success: true,
        data: a,
        message: `Approved. Attendance: ${ar.applied} day(s).`,
        attendanceSync: ar,
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

router.patch(
  "/manager/:id/reject",
  AllEmployeeAppMiddleware,
  async (req, res) => {
    try {
      const { remarks } = req.body;
      const a = await LeaveApplication.findOne({
        _id: req.params.id,
        "managersNotified.managerId": req.user.id,
      });
      if (!a)
        return res.status(404).json({ success: false, message: "Not found" });
      const mgr = a.managersNotified.find(
        (m) => String(m.managerId) === req.user.id,
      );
      a.managerDecisions.push({
        managerId: req.user.id,
        managerName: mgr?.managerName || "",
        type: mgr?.type || "primary",
        decision: "rejected",
        remarks: remarks || "",
        decidedAt: new Date(),
      });
      a.status = "manager_rejected";
      a.rejectedBy = req.user.id;
      a.rejectedAt = new Date();
      a.rejectionReason = remarks || "";
      await a.save();
      try {
        const io = req.app.get("io");
        if (io)
          io.to(String(a.employeeId)).emit("leave_notification", {
            type: "leave_rejected",
            leaveId: a._id.toString(),
            leaveType: a.leaveType,
            fromDate: a.fromDate,
            toDate: a.toDate,
            rejectionReason: remarks || "",
            message: `Your ${a.leaveType} (${a.fromDate}–${a.toDate}) not approved`,
            timestamp: new Date().toISOString(),
          });
      } catch (_) {}
      notifyEmployeeOnLeaveAction(
        a,
        "rejected",
        mgr?.managerName || "Manager",
      ).catch(() => {});
      res.json({ success: true, data: a, message: "Rejected" });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

module.exports = router;
