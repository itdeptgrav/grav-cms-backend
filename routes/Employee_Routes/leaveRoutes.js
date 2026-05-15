"use strict";
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const multer = require("multer");
const {
  notifyManagerOnLeaveApply,
  notifySecondaryOnPrimaryApproval,
  notifyEmployeeOnLeaveAction,
  notifyManagerOnWithdrawRequest,
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
  // ✅ FIX 1: Removed Saturday blocking — Saturday is a valid leave day
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

async function countMonthlyUsage(
  employeeId,
  fromDate,
  leaveTypeFilter,
  excludeId,
) {
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
  if (excludeId) filter._id = { $ne: excludeId };
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
        (a) =>
          a.fromDate <= ds &&
          a.toDate >= ds &&
          ["hr_approved", "withdraw_pending"].includes(a.status),
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

// ═══════════════════════════════════════════════════════════════════════════════
//  MANAGER WITHDRAW APPROVE/REJECT
//  When employee requests withdrawal of an hr_approved leave
// ═══════════════════════════════════════════════════════════════════════════════
router.patch(
  "/manager/:id/approve-withdraw",
  AllEmployeeAppMiddleware,
  async (req, res) => {
    try {
      const myId = req.user.id;
      const a = await LeaveApplication.findOne({
        _id: req.params.id,
        status: "withdraw_pending",
        "managersNotified.managerId": myId,
      });
      if (!a)
        return res.status(404).json({
          success: false,
          message: "Not found or not a withdrawal request",
        });

      // Refund the paidDays back to balance
      if (a.leaveType !== "LOP") {
        const refundDays = a.paidDays != null ? a.paidDays : a.totalDays;
        if (refundDays > 0) {
          const year = new Date(a.fromDate).getFullYear();
          const config = await LeaveConfig.getConfig();
          await LeaveBalance.findOneAndUpdate(
            { employeeId: a.employeeId, year },
            {
              $setOnInsert: {
                employeeId: a.employeeId,
                biometricId: a.biometricId || "",
                year,
                entitlement: {
                  CL: config.clPerYear,
                  SL: config.slPerYear,
                  PL: 0,
                },
                consumed: { CL: 0, SL: 0, PL: 0 },
              },
            },
            { upsert: true },
          );
          const bal = await LeaveBalance.findOne({
            employeeId: a.employeeId,
            year,
          });
          if (bal) {
            bal.consumed[a.leaveType] = Math.max(
              0,
              (bal.consumed[a.leaveType] || 0) - refundDays,
            );
            await bal.save();
            console.log(
              `[WITHDRAW-APPROVE] Refunded ${refundDays} ${a.leaveType} for ${a.employeeName}`,
            );
          }
        }
      }

      a.status = "cancelled";
      a.cancelledBy = myId;
      a.cancelledAt = new Date();
      a.hrRemarks = `Withdrawal approved by manager`;
      await a.save();
      notifyEmployeeOnLeaveAction(
        String(a.employeeId),
        a,
        "withdrawn",
        "Manager approved your withdrawal; balance restored.",
      ).catch((e) => console.warn("[PUSH-WITHDRAW-APPROVE]", e.message));

      // Notify employee
      try {
        const io = req.app.get("io");
        if (io)
          io.to(String(a.employeeId)).emit("leave_notification", {
            type: "withdraw_approved",
            leaveId: a._id.toString(),
            leaveType: a.leaveType,
            message: `Your ${a.leaveType} withdrawal (${a.fromDate}–${a.toDate}) has been approved. Balance restored.`,
            timestamp: new Date().toISOString(),
          });
      } catch (_) {}

      res.json({
        success: true,
        data: a,
        message: "Withdrawal approved. Leave balance restored.",
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

router.patch(
  "/manager/:id/reject-withdraw",
  AllEmployeeAppMiddleware,
  async (req, res) => {
    try {
      const myId = req.user.id;
      const a = await LeaveApplication.findOne({
        _id: req.params.id,
        status: "withdraw_pending",
        "managersNotified.managerId": myId,
      });
      if (!a)
        return res.status(404).json({ success: false, message: "Not found" });

      // Revert to hr_approved
      a.status = "hr_approved";
      a.hrRemarks = `Withdrawal rejected by manager: ${req.body.remarks || ""}`;
      await a.save();

      notifyEmployeeOnLeaveAction(
        String(a.employeeId),
        a,
        "rejected",
        req.body.remarks ||
          "Manager rejected withdrawal — leave remains active",
      ).catch((e) => console.warn("[PUSH-WITHDRAW-REJECT]", e.message));

      try {
        const io = req.app.get("io");
        if (io)
          io.to(String(a.employeeId)).emit("leave_notification", {
            type: "withdraw_rejected",
            leaveId: a._id.toString(),
            leaveType: a.leaveType,
            message: `Your ${a.leaveType} withdrawal request was not approved.`,
            timestamp: new Date().toISOString(),
          });
      } catch (_) {}

      res.json({
        success: true,
        data: a,
        message: "Withdrawal request rejected. Leave remains active.",
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

router.get(
  "/manager/withdraw-pending",
  AllEmployeeAppMiddleware,
  async (req, res) => {
    try {
      const res2 = await LeaveApplication.find({
        status: "withdraw_pending",
        "managersNotified.managerId": req.user.id,
      })
        .sort({ updatedAt: -1 })
        .lean();
      res.json({ success: true, data: res2 });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

router.get("/manager/history", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const myId = req.user.id;

    // Query directly via managersNotified — avoids ObjectId/string type mismatch
    // on Employee.primaryManager.managerId vs req.user.id
    const history = await LeaveApplication.find({
      "managersNotified.managerId": myId,
      status: { $in: ["hr_approved", "manager_approved"] },
    })
      .sort({ updatedAt: -1, fromDate: -1 })
      .limit(100)
      .lean();

    res.json({ success: true, data: history });
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
      // ✅ FIX 2: Added LOP as valid leave type
      if (!["CL", "SL", "PL", "LOP"].includes(leaveType))
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
        return res.status(400).json({
          success: false,
          message: `Waiting period not complete (${wd}/${config.initialWaitingDays})`,
          code: "WAITING_PERIOD",
        });
      if (leaveType === "PL" && wd < config.daysRequiredForPL)
        return res.status(400).json({
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
        return res.status(400).json({
          success: false,
          message: `Already has leave ${oc.fromDate}–${oc.toDate}`,
          code: "OVERLAP",
        });

      // ✅ FIX 3: LOP — all days are LWP, no balance deduction
      let paidDays, lwpDays;
      if (leaveType === "LOP") {
        paidDays = 0;
        lwpDays = totalDays;
      } else {
        const bal = await ensureBalance(
          employeeId,
          year,
          te.biometricId,
          config,
        );
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
        paidDays = Math.min(totalDays, av);
        lwpDays = Math.max(0, totalDays - paidDays);
      }

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
        paidDays,
        lwpDays,
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
      if (st === "hr_approved" && paidDays > 0) {
        try {
          const eb = await LeaveBalance.findOne({ employeeId, year });
          if (eb) {
            eb.consumed[leaveType] = (eb.consumed[leaveType] || 0) + paidDays;
            await eb.save();
          } else {
            const ic = { CL: 0, SL: 0, PL: 0 };
            ic[leaveType] = paidDays;
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
      res.status(201).json({
        success: true,
        data: app,
        message:
          st === "hr_approved"
            ? `Leave approved for ${te.firstName}. ${lwpDays > 0 ? `(${paidDays} paid + ${lwpDays} LWP)` : ""}`
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
//  APPLY FOR LEAVE
//  ✅ FIX 4: Removed Saturday block entirely
//  ✅ FIX 5: Added SL as proper leave type (separate flow, no split needed)
//  ✅ FIX 6: Added LOP — all days are Loss of Pay, no balance deduction
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
      paidDays: clientPaidDays, // for LOP: client sends paidDays:0
    } = req.body;

    if (!leaveType || !applicationDate || !fromDate || !toDate || !reason)
      return res
        .status(400)
        .json({ success: false, message: "All fields required" });

    // ✅ FIX 5+6: Accept CL, SL, PL, LOP
    if (!["CL", "SL", "PL", "LOP"].includes(leaveType))
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

    // Waiting period (hard block — can't apply at all)
    const wd = workingDaysSinceJoining(emp.dateOfJoining);
    if (wd < config.initialWaitingDays)
      return res.status(400).json({
        success: false,
        message: `Complete ${config.initialWaitingDays} working days first. You have ${wd}.`,
        code: "WAITING_PERIOD",
      });
    if (leaveType === "PL" && wd < config.daysRequiredForPL)
      return res.status(400).json({
        success: false,
        message: `PL available after ${config.daysRequiredForPL} days. You have ${wd}.`,
        code: "PL_NOT_ELIGIBLE",
      });

    // ✅ FIX 4: No Saturday block — just calculate days normally
    const totalDays = isHalfDay ? 0.5 : countLeaveDays(fromDate, toDate);
    if (totalDays <= 0)
      return res
        .status(400)
        .json({ success: false, message: "No valid leave days" });

    // Overlap check (hard block)
    const oc = await LeaveApplication.findOne({
      employeeId: req.user.id,
      status: { $nin: ["hr_rejected", "manager_rejected", "cancelled"] },
      fromDate: { $lte: toDate },
      toDate: { $gte: fromDate },
    });
    if (oc)
      return res.status(400).json({
        success: false,
        message: `Already have leave ${oc.fromDate}–${oc.toDate}.`,
        code: "OVERLAP",
      });

    // ══════════════════════════════════════════════════════════════════
    //  LOP — no balance calculation, all days are unpaid
    // ══════════════════════════════════════════════════════════════════
    if (leaveType === "LOP") {
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
        leaveType: "LOP",
        applicationDate,
        fromDate,
        toDate,
        totalDays,
        paidDays: 0,
        lwpDays: totalDays,
        reason,
        isHalfDay: !!isHalfDay,
        halfDaySlot: isHalfDay ? halfDaySlot || "first_half" : null,
        requiresDocument: false,
        managersNotified: mn,
        status: "pending",
      });

      notifyManagerOnLeaveApply(emp, app).catch((e) =>
        console.warn("[PUSH]", e.message),
      );

      return res.status(201).json({
        success: true,
        data: app,
        message: `LOP application submitted: ${totalDays} day${totalDays !== 1 ? "s" : ""} (all unpaid).`,
        breakdown: {
          totalDays,
          paidDays: 0,
          lwpDays: totalDays,
          leaveType: "LOP",
          availableBalance: 0,
          effectiveAvailable: 0,
        },
      });
    }

    // ══════════════════════════════════════════════════════════════════
    //  SL — direct submission, uses SL balance, excess becomes LWP
    // ══════════════════════════════════════════════════════════════════
    if (leaveType === "SL") {
      const bal = await ensureBalance(
        req.user.id,
        year,
        emp.biometricId,
        config,
      );
      const availableSL = Math.max(0, config.slPerYear - bal.consumed.SL);
      const paidDays = Math.min(totalDays, availableSL);
      const lwpDays = Math.max(0, totalDays - paidDays);
      const rd = totalDays > config.slDocumentThreshold;

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
        leaveType: "SL",
        applicationDate,
        fromDate,
        toDate,
        totalDays,
        paidDays,
        lwpDays,
        reason,
        isHalfDay: !!isHalfDay,
        halfDaySlot: isHalfDay ? halfDaySlot || "first_half" : null,
        requiresDocument: rd,
        managersNotified: mn,
        status: "pending",
      });

      notifyManagerOnLeaveApply(emp, app).catch((e) =>
        console.warn("[PUSH]", e.message),
      );

      let msg = "Sick Leave application submitted.";
      if (lwpDays > 0)
        msg = `SL submitted: ${paidDays} day${paidDays !== 1 ? "s" : ""} paid + ${lwpDays} day${lwpDays !== 1 ? "s" : ""} LWP.`;
      if (rd) msg += " Please submit a medical certificate.";

      return res.status(201).json({
        success: true,
        data: app,
        message: msg,
        requiresDocument: rd,
        breakdown: {
          totalDays,
          paidDays,
          lwpDays,
          leaveType: "SL",
          availableBalance: availableSL,
          effectiveAvailable: availableSL,
        },
      });
    }

    // ══════════════════════════════════════════════════════════════════
    //  CL / PL — with LWP breakdown (paid vs unpaid split)
    // ══════════════════════════════════════════════════════════════════
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
    const availableBalance = Math.max(
      0,
      le[leaveType] - bal.consumed[leaveType],
    );

    // CL monthly limit check
    let effectiveAvailable = availableBalance;
    if (leaveType === "CL") {
      const maxCLMonth = config.maxCLPerMonth || 3;
      const { used: clUsed } = await countMonthlyUsage(
        req.user.id,
        fromDate,
        "CL",
      );
      const clRemainingThisMonth = Math.max(0, maxCLMonth - clUsed);
      effectiveAvailable = Math.min(availableBalance, clRemainingThisMonth);
      console.log(
        `[LEAVE-LWP] CL: balance=${availableBalance}, monthUsed=${clUsed}, monthMax=${maxCLMonth}, effectiveAvail=${effectiveAvailable}`,
      );
    }

    // Monthly total cap — state-based (Odisha)
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
    const { used: totalMonthUsed } = await countMonthlyUsage(
      req.user.id,
      fromDate,
      null,
    );
    const monthlyRemaining = Math.max(0, monthlyCap - totalMonthUsed);
    effectiveAvailable = Math.min(effectiveAvailable, monthlyRemaining);
    console.log(
      `[LEAVE-LWP] Monthly: used=${totalMonthUsed}, cap=${monthlyCap}, remaining=${monthlyRemaining}, effectiveAvail=${effectiveAvailable}`,
    );

    const paidDays = Math.min(totalDays, effectiveAvailable);
    const lwpDays = Math.max(0, totalDays - paidDays);
    console.log(
      `[LEAVE-LWP] BREAKDOWN: total=${totalDays}, paid=${paidDays} (${leaveType}), lwp=${lwpDays}, employee=${emp.firstName} ${emp.lastName}`,
    );

    const rd = false; // CL/PL don't require documents
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
      paidDays,
      lwpDays,
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
          paidDays,
          lwpDays,
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
            paidDays,
            lwpDays,
            message: `${app.employeeName} applied for ${leaveType} (${fromDate}–${toDate}) [${paidDays} paid + ${lwpDays} LWP]`,
            timestamp: new Date().toISOString(),
          });
      }
    } catch (_) {}
    notifyManagerOnLeaveApply(emp, app).catch((e) =>
      console.warn("[PUSH]", e.message),
    );

    let msg = "Leave application submitted successfully";
    if (lwpDays > 0)
      msg = `Leave submitted: ${paidDays} day${paidDays !== 1 ? "s" : ""} ${leaveType} (paid) + ${lwpDays} day${lwpDays !== 1 ? "s" : ""} LWP (unpaid)`;

    res.status(201).json({
      success: true,
      data: app,
      message: msg,
      breakdown: {
        totalDays,
        paidDays,
        lwpDays,
        leaveType,
        availableBalance,
        effectiveAvailable,
      },
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

    // Block only truly terminal statuses
    if (["hr_rejected", "manager_rejected", "cancelled"].includes(a.status))
      return res.status(400).json({
        success: false,
        message: `Cannot withdraw — leave is already ${a.status}`,
      });

    const wasApproved = a.status === "hr_approved";

    if (wasApproved) {
      // ✅ For approved leaves: set to withdraw_pending — requires manager approval
      a.status = "withdraw_pending";
      a.cancelReason = req.body.cancelReason || "Employee withdrawal request";
      await a.save();
      notifyManagerOnWithdrawRequest(a).catch((e) =>
        console.warn("[PUSH-WITHDRAW-REQ]", e.message),
      );

      // Notify both managers via socket + push
      try {
        const io = req.app.get("io");
        if (io && a.managersNotified?.length > 0) {
          for (const mgr of a.managersNotified) {
            if (mgr?.managerId)
              io.to(String(mgr.managerId)).emit("leave_notification", {
                type: "leave_withdraw_requested",
                leaveId: a._id.toString(),
                employeeName: a.employeeName,
                leaveType: a.leaveType,
                fromDate: a.fromDate,
                toDate: a.toDate,
                message: `${a.employeeName} requested withdrawal of ${a.leaveType} (${a.fromDate}–${a.toDate}). Please review.`,
                timestamp: new Date().toISOString(),
              });
          }
        }
      } catch (_) {}

      return res.json({
        success: true,
        data: a,
        message: "Withdrawal request sent to your manager for approval.",
      });
    }

    // For pending/manager_approved: direct cancel, no manager needed
    a.status = "cancelled";
    a.cancelledBy = req.user.id;
    a.cancelledAt = new Date();
    a.cancelReason = req.body.cancelReason || "Employee withdrawal request";
    await a.save();

    res.json({
      success: true,
      data: a,
      message: "Leave application withdrawn.",
    });
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
    // ✅ FIX 4: Removed Saturday block from employee self-edit too
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
      return res.status(400).json({
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
//  MANAGER EDIT
// ═══════════════════════════════════════════════════════════════════════════════
router.put("/manager/:id/edit", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const myId = req.user.id;
    const a = await LeaveApplication.findOne({
      _id: req.params.id,
      "managersNotified.managerId": myId,
    });
    if (!a)
      return res.status(404).json({ success: false, message: "Not found" });
    if (!["pending", "manager_approved"].includes(a.status))
      return res
        .status(400)
        .json({ success: false, message: `Cannot edit — ${a.status}` });

    const { fromDate, toDate, leaveType, reason, isHalfDay, halfDaySlot } =
      req.body;
    const nF = fromDate || a.fromDate;
    const nT =
      isHalfDay || (isHalfDay === undefined && a.isHalfDay)
        ? nF
        : toDate || a.toDate;
    const nType = leaveType || a.leaveType;

    // ✅ FIX 6: Accept LOP as valid type in manager edit too
    if (!["CL", "SL", "PL", "LOP"].includes(nType))
      return res
        .status(400)
        .json({ success: false, message: "Invalid leave type" });

    const totalDays = (isHalfDay !== undefined ? isHalfDay : a.isHalfDay)
      ? 0.5
      : countLeaveDays(nF, nT);
    if (totalDays <= 0)
      return res.status(400).json({ success: false, message: "No valid days" });

    const oc = await LeaveApplication.findOne({
      _id: { $ne: req.params.id },
      employeeId: a.employeeId,
      status: { $nin: ["hr_rejected", "manager_rejected", "cancelled"] },
      fromDate: { $lte: nT },
      toDate: { $gte: nF },
    });
    if (oc)
      return res.status(400).json({
        success: false,
        message: `Conflicts with ${oc.fromDate}–${oc.toDate}`,
        code: "OVERLAP",
      });

    let paidDays, lwpDays;

    if (nType === "LOP") {
      paidDays = 0;
      lwpDays = totalDays;
    } else {
      const config = await LeaveConfig.getConfig();
      const year = new Date(nF).getFullYear();
      const bal = await ensureBalance(
        a.employeeId,
        year,
        a.biometricId,
        config,
      );
      const le = {
        CL: config.clPerYear,
        SL: config.slPerYear,
        PL: bal.plEligible ? config.plPerYear : 0,
      };
      let effectiveAvailable = Math.max(0, le[nType] - bal.consumed[nType]);

      if (nType === "CL") {
        const maxCLMonth = config.maxCLPerMonth || 3;
        const { used: clUsed } = await countMonthlyUsage(
          a.employeeId,
          nF,
          "CL",
          a._id,
        );
        effectiveAvailable = Math.min(
          effectiveAvailable,
          Math.max(0, maxCLMonth - clUsed),
        );
      }

      const emp = await Employee.findById(a.employeeId)
        .select("address")
        .lean();
      const empState = (
        emp?.address?.current?.state ||
        emp?.address?.permanent?.state ||
        ""
      )
        .toLowerCase()
        .trim();
      const isOdisha = ["odisha", "orissa"].includes(empState);
      const monthlyCap = isOdisha
        ? config.maxLeaveDaysPerMonthOdisha || 7
        : config.maxLeaveDaysPerMonth || 10;
      const { used: totalMonthUsed } = await countMonthlyUsage(
        a.employeeId,
        nF,
        null,
        a._id,
      );
      effectiveAvailable = Math.min(
        effectiveAvailable,
        Math.max(0, monthlyCap - totalMonthUsed),
      );

      if (req.body.paidDays !== undefined && req.body.paidDays !== null) {
        paidDays = Math.max(
          0,
          Math.min(Number(req.body.paidDays), effectiveAvailable, totalDays),
        );
      } else {
        paidDays = Math.min(totalDays, effectiveAvailable);
      }
      lwpDays = Math.max(0, totalDays - paidDays);
    }

    a.fromDate = nF;
    a.toDate = nT;
    a.leaveType = nType;
    a.totalDays = totalDays;
    a.paidDays = paidDays;
    a.lwpDays = lwpDays;
    if (reason !== undefined) a.reason = reason;
    if (isHalfDay !== undefined) {
      a.isHalfDay = isHalfDay;
      a.halfDaySlot = isHalfDay ? halfDaySlot || "first_half" : null;
    }
    a.requiresDocument =
      nType === "SL" &&
      totalDays > (await LeaveConfig.getConfig()).slDocumentThreshold;

    const mgr = await Employee.findById(myId)
      .select("firstName lastName")
      .lean();
    const mgrName = mgr ? `${mgr.firstName} ${mgr.lastName}`.trim() : "Manager";
    a.hrRemarks = `Edited by ${mgrName}: ${paidDays} ${nType} paid, ${lwpDays} LOP`;

    await a.save();

    notifyEmployeeOnLeaveAction(
      String(a.employeeId),
      a,
      "edited",
      mgrName,
    ).catch((e) => console.warn("[PUSH-EDIT]", e.message));

    console.log(
      `[MGR-EDIT] ${mgrName} edited leave ${a._id}: ${nType} ${nF}→${nT}, paid=${paidDays}, lwp=${lwpDays}`,
    );

    res.json({
      success: true,
      data: a,
      message: `Updated: ${paidDays} ${nType} (paid) + ${lwpDays} LOP`,
    });
  } catch (e) {
    console.error("[MGR-EDIT]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  MANAGER APPROVAL/REJECT
//  ✅ FIX 7: LOP approvals don't deduct any balance (paidDays is 0)
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
                paidDays: a.paidDays,
                lwpDays: a.lwpDays,
                message: `${a.employeeName}'s ${a.leaveType} needs approval [${a.paidDays || a.totalDays} paid${a.lwpDays ? ` + ${a.lwpDays} LWP` : ""}]`,
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

      // Final approval
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

      // ✅ FIX 7: Only deduct if paidDays > 0 (LOP will have paidDays=0)
      const deductDays = a.paidDays != null ? a.paidDays : a.totalDays;
      if (deductDays > 0 && a.leaveType !== "LOP") {
        const fy = new Date(a.fromDate).getFullYear();
        const fc = await LC.getConfig();
        await LB.findOneAndUpdate(
          { employeeId: a.employeeId, year: fy },
          {
            $setOnInsert: {
              employeeId: a.employeeId,
              biometricId: a.biometricId || "",
              year: fy,
              entitlement: { CL: fc.clPerYear, SL: fc.slPerYear, PL: 0 },
              consumed: { CL: 0, SL: 0, PL: 0 },
            },
          },
          { upsert: true },
        );
        await LB.findOneAndUpdate(
          { employeeId: a.employeeId, year: fy },
          { $inc: { [`consumed.${a.leaveType}`]: deductDays } },
        );
        console.log(
          `[APPROVE] Deducted ${deductDays} ${a.leaveType} for ${a.employeeName} (${a.lwpDays || 0} LWP not deducted)`,
        );
      } else if (a.leaveType === "LOP") {
        console.log(
          `[APPROVE] LOP approved for ${a.employeeName}: ${a.totalDays} days all unpaid — no balance deducted`,
        );
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
            paidDays: a.paidDays,
            lwpDays: a.lwpDays,
            message: `Your ${a.leaveType} (${a.fromDate}–${a.toDate}) approved`,
            timestamp: new Date().toISOString(),
          });
      } catch (_) {}
      notifyEmployeeOnLeaveAction(
        String(a.employeeId),
        a,
        "approved",
        `Approved by ${mgr?.managerName || "Manager"}`,
      ).catch((e) => console.warn("[PUSH-APPROVE]", e.message));
      res.json({
        success: true,
        data: a,
        message:
          a.leaveType === "LOP"
            ? `LOP approved: ${a.totalDays} day(s) — all unpaid. Attendance: ${ar.applied} day(s).`
            : `Approved. ${deductDays} ${a.leaveType} deducted${a.lwpDays ? `, ${a.lwpDays} LWP` : ""}. Attendance: ${ar.applied} day(s).`,
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
        String(a.employeeId),
        a,
        "rejected",
        remarks || `Rejected by ${mgr?.managerName || "Manager"}`,
      ).catch((e) => console.warn("[PUSH-REJECT]", e.message));

      res.json({ success: true, data: a, message: "Rejected" });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

module.exports = router;
