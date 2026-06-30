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

// Email service — used to notify HR when a leave reaches final manager approval.
// Wrapped in try/catch so missing env vars / disabled emails never crash the route.
let emailService = {};
try {
  emailService = require("../../services/emailService");
} catch (e) {
  console.warn(
    "[LEAVE-ROUTES] emailService not found, email features disabled:",
    e.message,
  );
}

// sendExpoPush — used to push notify the primary manager when a quick-apply
// leave gets classified by the secondary manager. Wrapped so it can't crash.
let sendExpoPush = async () => {};
try {
  sendExpoPush =
    require("../../utils/sendExpoPush").sendExpoPush || sendExpoPush;
} catch (_) {}

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
  return Math.round((to - from) / (24 * 60 * 60 * 1000)) + 1;
}

// Calendar days since joining — Sundays INCLUDED.
function workingDaysSinceJoining(joiningDate) {
  if (!joiningDate) return 0;
  const join = new Date(joiningDate),
    today = new Date();
  let count = 0;
  const cur = new Date(join.getFullYear(), join.getMonth(), join.getDate()),
    end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  while (cur <= end) {
    count++;
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

async function resolveLeaveOverlap({
  employeeId,
  fromDate,
  toDate,
  leaveType,
  isHalfDay,
  excludeId,
}) {
  const q = {
    employeeId,
    status: { $nin: ["hr_rejected", "manager_rejected", "cancelled"] },
    fromDate: { $lte: toDate },
    toDate: { $gte: fromDate },
  };
  if (excludeId) q._id = { $ne: excludeId };
  const existing = await LeaveApplication.findOne(q);
  if (!existing) return { action: "none" };
  const sameType = String(existing.leaveType) === String(leaveType);
  const sameRange =
    existing.fromDate === fromDate && existing.toDate === toDate;
  const sameHalf = !!existing.isHalfDay === !!isHalfDay;
  if (sameType && sameRange && sameHalf) return { action: "replace", existing };
  return { action: "block", existing };
}

function overlapBlockResponse(res, existing) {
  return res.status(409).json({
    success: false,
    code: "OVERLAP_WITHDRAW_FIRST",
    message: `You already have a ${existing.leaveType} leave from ${existing.fromDate} to ${existing.toDate}. Please withdraw that leave first, then apply again for these dates.`,
    existing: {
      id: existing._id,
      leaveType: existing.leaveType,
      fromDate: existing.fromDate,
      toDate: existing.toDate,
      status: existing.status,
    },
  });
}

// IST "today" string for quick-apply
function todayIST() {
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return `${istNow.getUTCFullYear()}-${String(istNow.getUTCMonth() + 1).padStart(2, "0")}-${String(istNow.getUTCDate()).padStart(2, "0")}`;
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

// ─────────────────────────────────────────────────────────────────────────────
//  GET /manager/pending — covers BOTH regular and quick-apply flows
//
//  Regular flow:  primary acts on pending, then secondary acts on manager_approved.
//  Quick flow:    primary classifies pending (via /quick-apply/:id/resolve),
//                 then secondary approves manager_approved.
//                 (Same primary→secondary order as the regular flow — consistent.)
//
//  Four buckets:
//    (a) primary  + pending           + isQuickApply !== true   ← regular start
//    (b) secondary+ manager_approved  + isQuickApply !== true   ← regular finish
//    (c) primary  + pending           + isQuickApply === true   ← quick start
//    (d) secondary+ manager_approved  + isQuickApply === true   ← quick finish
//
//  Bucket (a) and (c) merge naturally — primary sees ALL pending leaves
//  where they're the primary. Bucket (b) and (d) merge — secondary sees ALL
//  manager_approved leaves where they're the secondary. So this collapses to
//  the same simple query the codebase had BEFORE quick-apply was added.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/manager/pending", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    res.json({
      success: true,
      data: await LeaveApplication.find({
        $or: [
          // Primary acts on pending — regular and quick-apply both
          {
            managersNotified: {
              $elemMatch: { managerId: req.user.id, type: "primary" },
            },
            status: "pending",
          },
          // Secondary acts on manager_approved — regular and quick-apply both
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
// ═══════════════════════════════════════════════════════════════════════════════

// Decides whether this manager owns the withdrawal action for this leave.
// Rule: SECONDARY manager owns withdrawals (they gave the final approval, so
// they own the un-approval). PRIMARY only sees them as a fallback when the
// leave was approved without a secondary in the chain.
function isMyTurnForWithdraw(leave, myId) {
  const myIdStr = String(myId);
  const mine = (leave.managersNotified || []).find(
    (m) => String(m.managerId || "") === myIdStr,
  );
  if (!mine) return false;
  if (mine.type === "secondary") return true;
  // Only count a "real" secondary — one with a populated managerId. A stale
  // {type:"secondary"} entry with no managerId would otherwise block the
  // primary from acting, and nobody would be able to approve the withdrawal.
  const hasRealSecondary = (leave.managersNotified || []).some(
    (m) => m.type === "secondary" && m.managerId,
  );
  return mine.type === "primary" && !hasRealSecondary;
}

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

      // Only the SECONDARY manager handles withdrawals — they gave the
      // original final approval, so they own the un-approval too. If a
      // leave has no secondary, the primary handles it as a fallback.
      if (!isMyTurnForWithdraw(a, myId)) {
        return res.status(403).json({
          success: false,
          code: "WITHDRAW_NOT_AUTHORIZED",
          message:
            "Only the secondary manager can act on this withdrawal request.",
        });
      }

      if (a.leaveType !== "LOP" && a.leaveType !== "QUICK") {
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

      // Secondary-only gate (with primary fallback when no secondary exists).
      if (!isMyTurnForWithdraw(a, myId)) {
        return res.status(403).json({
          success: false,
          code: "WITHDRAW_NOT_AUTHORIZED",
          message:
            "Only the secondary manager can act on this withdrawal request.",
        });
      }

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
      const myId = req.user.id;
      const all = await LeaveApplication.find({
        status: "withdraw_pending",
        "managersNotified.managerId": myId,
      })
        .sort({ updatedAt: -1 })
        .lean();
      const filtered = all.filter((leave) => isMyTurnForWithdraw(leave, myId));
      // Diagnostic — also pull ALL withdraw_pending leaves (no manager filter)
      // so we can see whether any exist in the system at all. If the global
      // count > 0 but matched=0 for this manager, it means the leave's
      // managersNotified snapshot doesn't include this manager — usually
      // because the employee's manager was changed AFTER the leave was created.
      const globalCount = await LeaveApplication.countDocuments({
        status: "withdraw_pending",
      });
      const globalSamples = await LeaveApplication.find({
        status: "withdraw_pending",
      })
        .select("_id employeeId employeeName managersNotified")
        .limit(3)
        .lean();
      console.log(
        `[WITHDRAW-PENDING] mgr=${myId} matched=${all.length} afterFilter=${filtered.length} globalWithdrawPending=${globalCount}`,
      );
      if (globalCount > 0 && all.length === 0) {
        console.log(
          `[WITHDRAW-PENDING-DIAG] global rows exist but mgr=${myId} is not in any managersNotified. Sample rows:`,
        );
        for (const g of globalSamples) {
          console.log(
            `  leave=${g._id} emp=${g.employeeName} managers=${JSON.stringify(
              (g.managersNotified || []).map((m) => ({
                id: String(m.managerId || "(none)"),
                type: m.type,
              })),
            )}`,
          );
        }
      }
      res.json({ success: true, data: filtered });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

router.get("/manager/history", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const myId = req.user.id;
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
      const overlap = await resolveLeaveOverlap({
        employeeId,
        fromDate,
        toDate,
        leaveType,
        isHalfDay,
      });
      if (overlap.action === "block")
        return overlapBlockResponse(res, overlap.existing);
      if (overlap.action === "replace")
        return res.status(200).json({
          success: true,
          data: overlap.existing,
          replaced: true,
          message: `This employee already has a ${overlap.existing.leaveType} leave for ${overlap.existing.fromDate}–${overlap.existing.toDate}. No duplicate was created.`,
        });

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

      if (st === "hr_approved") {
        try {
          if (emailService?.sendLeaveManagerApprovedToHR) {
            emailService
              .sendLeaveManagerApprovedToHR({
                employeeName: app.employeeName,
                department: app.department,
                designation: app.designation,
                leaveType: app.leaveType,
                fromDate: app.fromDate,
                toDate: app.toDate,
                totalDays: app.totalDays,
                paidDays: app.paidDays,
                lwpDays: app.lwpDays,
                reason: app.reason,
                approvalChain: app.managerDecisions || [],
                applicationId: app._id.toString(),
              })
              .catch((e) => console.warn("[LEAVE-HR-EMAIL]", e.message));
          }
        } catch (_) {}
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

// ═══════════════════════════════════════════════════════════════════════════════
//  QUICK-APPLY — shortcut buttons "Full-day today" / "Half-day today"
//
//  Flow:
//    1. Employee taps a button → POST /quick-apply with isHalfDay + reason.
//       Application is created with leaveType: "QUICK", isQuickApply: true,
//       status: "pending". Secondary manager is notified.
//
//    2. Secondary manager → PATCH /quick-apply/:id/resolve with resolvedType.
//       Validates CL/SL balance + monthly CL cap. Rewrites leaveType from
//       "QUICK" to the chosen value, sets paidDays/lwpDays, records the
//       secondary's decision, status → "manager_approved". Primary is pinged.
//
//    3. Primary manager → PATCH /manager/:id/approve (existing endpoint).
//       Sees isQuickApply: true, routes through quick-apply branch:
//       deducts balance, syncs attendance, emails HR, status → "hr_approved".
// ═══════════════════════════════════════════════════════════════════════════════

// 1) Employee creates the quick-apply
router.post("/quick-apply", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const {
      isHalfDay = false,
      halfDaySlot,
      reason,
      targetDate = "today", // "today" | "tomorrow"
    } = req.body || {};

    if (!reason || !String(reason).trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Reason is required" });
    }
    if (isHalfDay && !["first_half", "second_half"].includes(halfDaySlot)) {
      return res.status(400).json({
        success: false,
        message: "halfDaySlot must be 'first_half' or 'second_half'",
      });
    }
    if (!["today", "tomorrow"].includes(targetDate)) {
      return res.status(400).json({
        success: false,
        message: "targetDate must be 'today' or 'tomorrow'",
      });
    }

    const emp = await Employee.findById(req.user.id)
      .select(
        "firstName lastName biometricId designation department dateOfJoining primaryManager secondaryManager",
      )
      .lean();
    if (!emp) {
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });
    }

    // Waiting-period check still applies
    const config = await LeaveConfig.getConfig();
    const wd = workingDaysSinceJoining(emp.dateOfJoining);
    if (wd < config.initialWaitingDays) {
      return res.status(400).json({
        success: false,
        message: `Complete ${config.initialWaitingDays} days at the company before applying leave. You have ${wd}.`,
        code: "WAITING_PERIOD",
      });
    }

    // FLOW: primary classifies first, then secondary approves. So we need a
    // primary manager assigned. (Secondary is optional — if missing, primary's
    // classification finalises directly to hr_approved.)
    if (!emp.primaryManager?.managerId) {
      return res.status(400).json({
        success: false,
        message:
          "Quick-apply needs a primary manager assigned to classify your leave. Please contact HR.",
      });
    }

    // Compute target date in IST
    const istBase = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    if (targetDate === "tomorrow") istBase.setUTCDate(istBase.getUTCDate() + 1);
    const targetDateStr = `${istBase.getUTCFullYear()}-${String(
      istBase.getUTCMonth() + 1,
    ).padStart(2, "0")}-${String(istBase.getUTCDate()).padStart(2, "0")}`;

    // Block duplicate on the same day
    const dupe = await LeaveApplication.findOne({
      employeeId: req.user.id,
      fromDate: targetDateStr,
      toDate: targetDateStr,
      status: { $nin: ["manager_rejected", "hr_rejected", "cancelled"] },
    });
    if (dupe) {
      return res.status(400).json({
        success: false,
        message:
          targetDate === "tomorrow"
            ? "You already have a leave application for tomorrow"
            : "You already have a leave application for today",
        code: "DUPLICATE_DATE",
      });
    }

    const managersNotified = [
      {
        managerId: emp.primaryManager.managerId,
        managerName: emp.primaryManager.managerName || "",
        type: "primary",
      },
    ];
    if (emp.secondaryManager?.managerId) {
      managersNotified.push({
        managerId: emp.secondaryManager.managerId,
        managerName: emp.secondaryManager.managerName || "",
        type: "secondary",
      });
    }

    const totalDays = isHalfDay ? 0.5 : 1;

    const app = await LeaveApplication.create({
      employeeId: req.user.id,
      biometricId: emp.biometricId,
      employeeName: `${emp.firstName} ${emp.lastName}`.trim(),
      designation: emp.designation,
      department: emp.department,
      leaveType: "QUICK",
      applicationDate: targetDateStr,
      fromDate: targetDateStr,
      toDate: targetDateStr,
      totalDays,
      paidDays: null,
      lwpDays: 0,
      reason: String(reason).trim(),
      isHalfDay: !!isHalfDay,
      halfDaySlot: isHalfDay ? halfDaySlot : null,
      requiresDocument: false,
      managersNotified,
      status: "pending",
      isQuickApply: true,
      quickApply: {
        resolvedType: null,
        resolvedBy: null,
        resolvedByName: null,
        resolvedAt: null,
        forcedLOPReason: null,
      },
    });

    // Notify managers — same hook as regular apply
    notifyManagerOnLeaveApply(emp, app).catch((e) =>
      console.warn("[QUICK-APPLY-PUSH]", e.message),
    );

    // Socket event tagged so the primary manager's UI can highlight it
    try {
      const io = req.app.get("io");
      if (io) {
        io.to(String(emp.primaryManager.managerId)).emit("leave_notification", {
          type: "quick_apply_pending",
          leaveId: app._id.toString(),
          employeeName: app.employeeName,
          fromDate: targetDateStr,
          totalDays,
          isHalfDay,
          targetDate,
          message: `${app.employeeName} requested ${isHalfDay ? "half-day" : "full-day"} leave ${targetDate}. Please classify.`,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (_) {}

    const dayLabel = targetDate === "tomorrow" ? "tomorrow" : "today";
    return res.status(201).json({
      success: true,
      data: app,
      message: isHalfDay
        ? `Half-day leave requested for ${dayLabel} (${halfDaySlot.replace("_", " ")}). Your manager will pick the type.`
        : `Full-day leave requested for ${dayLabel}. Your manager will pick the type.`,
    });
  } catch (err) {
    console.error("[QUICK-APPLY]", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 2) Primary manager classifies the quick-apply
router.patch(
  "/quick-apply/:id/resolve",
  AllEmployeeAppMiddleware,
  async (req, res) => {
    try {
      const { resolvedType, remarks, forceLOPReason } = req.body || {};
      if (!["CL", "SL", "LOP"].includes(resolvedType)) {
        return res.status(400).json({
          success: false,
          message: "resolvedType must be CL, SL or LOP",
        });
      }

      const app = await LeaveApplication.findOne({
        _id: req.params.id,
        isQuickApply: true,
        leaveType: "QUICK",
        status: "pending",
      });
      if (!app) {
        return res.status(404).json({
          success: false,
          message: "Application not found or already classified",
        });
      }

      // Only the PRIMARY manager on the application may classify
      const pri = (app.managersNotified || []).find(
        (m) => m.type === "primary",
      );
      if (!pri || String(pri.managerId) !== String(req.user.id)) {
        return res.status(403).json({
          success: false,
          message: "Only the primary manager can classify quick-apply leaves",
        });
      }

      const config = await LeaveConfig.getConfig();
      const year = new Date(app.fromDate).getFullYear();
      const balance = await LeaveBalance.getOrCreate(
        app.employeeId,
        year,
        app.biometricId,
      );
      const availableCL = Math.max(
        0,
        (config.clPerYear || 0) - (balance.consumed.CL || 0),
      );
      const availableSL = Math.max(
        0,
        (config.slPerYear || 0) - (balance.consumed.SL || 0),
      );

      let paidDays = 0;
      let lwpDays = 0;
      let forcedLOPReason = null;

      if (resolvedType === "CL") {
        if (availableCL < app.totalDays) {
          return res.status(400).json({
            success: false,
            code: "CL_NOT_ELIGIBLE",
            message: `Employee has only ${availableCL} CL day(s) left this year. Please pick LOP instead.`,
            availableCL,
            availableSL,
          });
        }
        const { used: clMonthUsed } = await countMonthlyUsage(
          app.employeeId,
          app.fromDate,
          "CL",
          app._id,
        );
        const maxCLMonth = config.maxCLPerMonth || 3;
        if (clMonthUsed + app.totalDays > maxCLMonth) {
          return res.status(400).json({
            success: false,
            code: "CL_MONTHLY_CAP",
            message: `Employee already used ${clMonthUsed}/${maxCLMonth} CL this month. Please pick LOP instead.`,
            clMonthUsed,
            maxCLMonth,
          });
        }
        paidDays = app.totalDays;
        lwpDays = 0;
      } else if (resolvedType === "SL") {
        if (availableSL >= app.totalDays) {
          paidDays = app.totalDays;
          lwpDays = 0;
        } else {
          paidDays = availableSL;
          lwpDays = app.totalDays - availableSL;
        }
      } else {
        paidDays = 0;
        lwpDays = app.totalDays;
        const hasPaidOption =
          availableCL >= app.totalDays || availableSL >= app.totalDays;
        if (hasPaidOption) {
          if (!forceLOPReason || !String(forceLOPReason).trim()) {
            return res.status(400).json({
              success: false,
              code: "LOP_REASON_REQUIRED",
              message:
                "Employee has CL/SL balance available. Provide a forceLOPReason to override.",
              availableCL,
              availableSL,
            });
          }
          forcedLOPReason = String(forceLOPReason).trim();
        } else {
          forcedLOPReason = "Insufficient CL/SL balance";
        }
      }

      const mgr = await Employee.findById(req.user.id)
        .select("firstName lastName")
        .lean();
      const mgrName = mgr
        ? `${mgr.firstName || ""} ${mgr.lastName || ""}`.trim() || "Manager"
        : "Manager";

      // Rewrite the leave with the classified type
      app.leaveType = resolvedType;
      app.paidDays = paidDays;
      app.lwpDays = lwpDays;
      app.requiresDocument =
        resolvedType === "SL" && app.totalDays > config.slDocumentThreshold;
      app.quickApply = {
        resolvedType,
        resolvedBy: req.user.id,
        resolvedByName: mgrName,
        resolvedAt: new Date(),
        forcedLOPReason,
      };
      app.managerDecisions = app.managerDecisions || [];
      app.managerDecisions.push({
        managerId: req.user.id,
        managerName: mgrName,
        type: "primary",
        decision: "approved",
        remarks: remarks || `Classified as ${resolvedType}`,
        decidedAt: new Date(),
      });

      // ── Does this employee have a secondary manager assigned? ──
      // YES → status moves to manager_approved, secondary will give final approval
      // NO  → primary's classification IS the final approval; we finalise here
      //       (deduct balance, sync attendance, email HR)
      const hasSecondary = (app.managersNotified || []).some(
        (m) => m.type === "secondary" && m.managerId,
      );

      if (hasSecondary) {
        app.status = "manager_approved";
        await app.save();

        // Push secondary so they know they can give final approval
        try {
          const sec = (app.managersNotified || []).find(
            (m) => m.type === "secondary",
          );
          if (sec?.managerId) {
            await sendExpoPush(sec.managerId, {
              title: `Leave classified as ${resolvedType}`,
              body: `${app.employeeName} — ${app.totalDays} day(s) on ${app.fromDate}. Awaiting your approval.`,
              data: {
                type: "leave_ready_for_secondary",
                applicationId: app._id.toString(),
                screen: "Leave",
              },
              channelId: "general",
            });
            const io = req.app.get("io");
            if (io) {
              io.to(String(sec.managerId)).emit("leave_notification", {
                type: "quick_apply_classified",
                leaveId: app._id.toString(),
                employeeName: app.employeeName,
                leaveType: resolvedType,
                fromDate: app.fromDate,
                totalDays: app.totalDays,
                classifiedBy: mgrName,
                message: `${mgrName} classified ${app.employeeName}'s leave as ${resolvedType}. Awaiting your approval.`,
                timestamp: new Date().toISOString(),
              });
            }
          }
        } catch (e) {
          console.warn("[QUICK-RESOLVE-PUSH]", e.message);
        }

        return res.json({
          success: true,
          data: app,
          message: `Classified as ${resolvedType}. Awaiting secondary manager's approval.`,
        });
      }

      // ── No secondary — primary's classification finalises ──
      app.status = "hr_approved";
      app.hrApprovedAt = new Date();
      app.hrRemarks = `Classified and approved by primary manager ${mgrName}`;
      await app.save();

      // Deduct balance for paid days (CL/SL only; LOP doesn't touch balance)
      if (paidDays > 0 && resolvedType !== "LOP") {
        try {
          await LeaveBalance.findOneAndUpdate(
            { employeeId: app.employeeId, year },
            {
              $setOnInsert: {
                employeeId: app.employeeId,
                biometricId: app.biometricId || "",
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
          await LeaveBalance.findOneAndUpdate(
            { employeeId: app.employeeId, year },
            { $inc: { [`consumed.${resolvedType}`]: paidDays } },
          );
        } catch (e) {
          console.warn("[QUICK-RESOLVE-BALANCE]", e.message);
        }
      }

      // Sync to attendance (best-effort)
      try {
        const {
          applyLeaveToAttendance,
        } = require("../HrRoutes/Attendance_section");
        if (applyLeaveToAttendance) await applyLeaveToAttendance(app);
      } catch (e) {
        console.warn("[QUICK-RESOLVE-ATTENDANCE]", e.message);
      }

      // Email HR
      try {
        if (emailService?.sendLeaveManagerApprovedToHR) {
          emailService
            .sendLeaveManagerApprovedToHR({
              employeeName: app.employeeName,
              department: app.department,
              designation: app.designation,
              leaveType: app.leaveType,
              fromDate: app.fromDate,
              toDate: app.toDate,
              totalDays: app.totalDays,
              paidDays: app.paidDays,
              lwpDays: app.lwpDays,
              reason: app.reason,
              approvalChain: app.managerDecisions || [],
              applicationId: app._id.toString(),
              isQuickApply: true,
              quickApply: app.quickApply,
            })
            .catch((e) => console.warn("[LEAVE-HR-EMAIL]", e.message));
        }
      } catch (_) {}

      // Notify employee
      notifyEmployeeOnLeaveAction(
        String(app.employeeId),
        app,
        "approved",
        `Approved by ${mgrName}`,
      ).catch(() => {});

      return res.json({
        success: true,
        data: app,
        message: `Classified as ${resolvedType} and approved (no secondary manager assigned).`,
      });
    } catch (err) {
      console.error("[QUICK-RESOLVE]", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /:id — fetch employee's own application
// ─────────────────────────────────────────────────────────────────────────────
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
//  POST / — Regular apply for leave (CL / SL / PL / LOP)
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

    const totalDays = isHalfDay ? 0.5 : countLeaveDays(fromDate, toDate);
    if (totalDays <= 0)
      return res
        .status(400)
        .json({ success: false, message: "No valid leave days" });

    const overlap = await resolveLeaveOverlap({
      employeeId: req.user.id,
      fromDate,
      toDate,
      leaveType,
      isHalfDay,
    });
    if (overlap.action === "block")
      return overlapBlockResponse(res, overlap.existing);
    if (overlap.action === "replace") {
      const ex = overlap.existing;
      if (ex.status === "pending" && reason !== undefined) {
        ex.reason = reason;
        await ex.save();
      }
      return res.status(200).json({
        success: true,
        data: ex,
        replaced: true,
        message: `You already have this ${ex.leaveType} leave for ${ex.fromDate}–${ex.toDate}. No duplicate was created.`,
      });
    }

    // ── LOP ──
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

    // ── SL ──
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

    // ── CL / PL ──
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
    }

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

    const paidDays = Math.min(totalDays, effectiveAvailable);
    const lwpDays = Math.max(0, totalDays - paidDays);

    const rd = false;
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

// ═══════════════════════════════════════════════════════════════════════════════
//  Employee cancel / edit / delete / upload-doc
// ═══════════════════════════════════════════════════════════════════════════════
router.patch("/:id/cancel", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const a = await LeaveApplication.findOne({
      _id: req.params.id,
      employeeId: req.user.id,
    });
    if (!a)
      return res.status(404).json({ success: false, message: "Not found" });

    if (["hr_rejected", "manager_rejected", "cancelled"].includes(a.status))
      return res.status(400).json({
        success: false,
        message: `Cannot withdraw — leave is already ${a.status}`,
      });

    const wasApproved = a.status === "hr_approved";

    if (wasApproved) {
      // Backfill managersNotified if the leave doesn't have one. Older
      // leaves (HR-added, pre-quick-apply era, or with stale snapshots)
      // sometimes have an empty array. Without managers in here, the
      // withdraw-pending query has nothing to match against and the
      // withdrawal disappears into the void. Look up the employee's
      // current managers live and write them in before saving.
      const validManagers = (a.managersNotified || []).filter(
        (m) => m && m.managerId,
      );
      if (validManagers.length === 0) {
        const emp = await Employee.findById(a.employeeId)
          .select("primaryManager secondaryManager")
          .lean();
        const rebuilt = [];
        if (emp?.primaryManager?.managerId) {
          rebuilt.push({
            managerId: emp.primaryManager.managerId,
            managerName: emp.primaryManager.managerName || "",
            type: "primary",
          });
        }
        if (emp?.secondaryManager?.managerId) {
          rebuilt.push({
            managerId: emp.secondaryManager.managerId,
            managerName: emp.secondaryManager.managerName || "",
            type: "secondary",
          });
        }
        if (rebuilt.length === 0) {
          return res.status(400).json({
            success: false,
            code: "NO_MANAGERS_ASSIGNED",
            message:
              "Cannot send withdrawal request — no managers are assigned to you in HR. Please contact HR.",
          });
        }
        a.managersNotified = rebuilt;
        console.log(
          `[CANCEL→WITHDRAW-BACKFILL] leave=${a._id} populated ${rebuilt.length} manager(s) from live employee record`,
        );
      }

      a.status = "withdraw_pending";
      a.cancelReason = req.body.cancelReason || "Employee withdrawal request";
      await a.save();
      console.log(
        `[CANCEL→WITHDRAW] leave=${a._id} emp=${a.employeeId} status=${a.status} ` +
          `managersNotified=${JSON.stringify(
            (a.managersNotified || []).map((m) => ({
              id: String(m.managerId || "(none)"),
              type: m.type,
              name: m.managerName,
            })),
          )}`,
      );
      notifyManagerOnWithdrawRequest(a).catch((e) =>
        console.warn("[PUSH-WITHDRAW-REQ]", e.message),
      );

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

// Employee cancels their own withdrawal request (changed their mind).
// Only valid while status === "withdraw_pending". Flips the leave back to
// hr_approved with no balance change (balance was never restored — the
// secondary manager hadn't acted yet).
router.patch(
  "/:id/cancel-withdraw",
  AllEmployeeAppMiddleware,
  async (req, res) => {
    try {
      const a = await LeaveApplication.findOne({
        _id: req.params.id,
        employeeId: req.user.id,
      });
      if (!a)
        return res.status(404).json({ success: false, message: "Not found" });
      if (a.status !== "withdraw_pending")
        return res.status(400).json({
          success: false,
          code: "NOT_WITHDRAW_PENDING",
          message: `Cannot cancel withdrawal — leave is currently ${a.status}, not a pending withdrawal.`,
        });

      a.status = "hr_approved";
      a.cancelReason = "";
      await a.save();

      // Notify the manager(s) who were waiting on this — clears it from
      // their queue. Same notification fan-out pattern as the original
      // withdraw request, just reversed.
      try {
        const io = req.app.get("io");
        if (io && a.managersNotified?.length > 0) {
          for (const mgr of a.managersNotified) {
            if (mgr?.managerId)
              io.to(String(mgr.managerId)).emit("leave_notification", {
                type: "withdraw_request_cancelled",
                leaveId: a._id.toString(),
                employeeName: a.employeeName,
                leaveType: a.leaveType,
                message: `${a.employeeName} cancelled their withdrawal request for ${a.leaveType} (${a.fromDate}–${a.toDate}).`,
                timestamp: new Date().toISOString(),
              });
          }
        }
      } catch (_) {}

      res.json({
        success: true,
        data: a,
        message: "Withdrawal request cancelled. Your leave is active again.",
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

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
    if (a.isQuickApply)
      return res.status(400).json({
        success: false,
        message:
          "Quick-apply leaves can't be edited. Withdraw and apply again if needed.",
      });
    const { fromDate, toDate, reason, isHalfDay, halfDaySlot } = req.body;
    const nF = fromDate || a.fromDate,
      nT = isHalfDay ? nF : toDate || a.toDate;
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
//  MANAGER EDIT — dates/duration only, never type, no LOP split
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
    if (a.leaveType === "QUICK")
      return res.status(400).json({
        success: false,
        message: "Classify the quick-apply first using the resolve endpoint.",
      });

    const { fromDate, toDate, reason, isHalfDay, halfDaySlot } = req.body;
    const nType = a.leaveType;
    const nF = fromDate || a.fromDate;
    const nT =
      isHalfDay || (isHalfDay === undefined && a.isHalfDay)
        ? nF
        : toDate || a.toDate;

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
      paidDays = totalDays;
      lwpDays = 0;
    }

    const config = await LeaveConfig.getConfig();

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
      nType === "SL" && totalDays > config.slDocumentThreshold;

    const mgr = await Employee.findById(myId)
      .select("firstName lastName")
      .lean();
    const mgrName = mgr ? `${mgr.firstName} ${mgr.lastName}`.trim() : "Manager";
    a.hrRemarks = `Dates adjusted by ${mgrName}: ${nType} ${nF}→${nT} (${totalDays} day${totalDays !== 1 ? "s" : ""})`;

    await a.save();

    notifyEmployeeOnLeaveAction(
      String(a.employeeId),
      a,
      "edited",
      mgrName,
    ).catch((e) => console.warn("[PUSH-EDIT]", e.message));

    res.json({
      success: true,
      data: a,
      message: `Updated: ${nType} ${nF} → ${nT} (${totalDays} day${totalDays !== 1 ? "s" : ""})`,
    });
  } catch (e) {
    console.error("[MGR-EDIT]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  MANAGER APPROVE
//
//  Handles BOTH regular and quick-apply flows.
//
//  Regular flow:
//    pending           → primary acts here, status → manager_approved
//    manager_approved  → secondary acts here, status → hr_approved (final)
//
//  Quick-apply flow (isQuickApply=true):
//    pending           → BLOCKED here — secondary must use /quick-apply/:id/resolve
//    manager_approved  → primary acts here, status → hr_approved (final)
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

      const isQuick = !!a.isQuickApply;

      // ── Stage-vs-role gate ──────────────────────────────────────────
      // Quick-apply uses the SAME order as regular: primary first, secondary
      // second. The only difference is primary must CLASSIFY (via the
      // /quick-apply/:id/resolve endpoint) instead of just approving.
      if (isQuick && mt === "primary" && a.status === "pending") {
        return res.status(400).json({
          success: false,
          message:
            "Quick-apply leaves need to be classified, not just approved. Use the Classify button.",
        });
      }
      if (mt === "primary" && a.status !== "pending")
        return res.status(400).json({
          success: false,
          message: `Cannot approve — ${a.status}`,
        });
      if (mt === "secondary" && a.status !== "manager_approved")
        return res
          .status(400)
          .json({ success: false, message: "Primary must approve first" });

      // Record this manager's decision (idempotent)
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

      // ── Regular flow: primary first → wait for secondary ────────────
      // (Quick-apply with secondary: primary classifies via /resolve which
      //  already set status to manager_approved, so primary won't reach
      //  this branch. We deliberately leave this generic.)
      if (mt === "primary" && hs && a.status === "pending") {
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

      // ── FINAL APPROVAL — reach hr_approved ──────────────────────────
      const {
        LeaveConfig: LC,
        LeaveBalance: LB,
      } = require("../../models/HR_Models/LeaveManagement");
      const {
        applyLeaveToAttendance,
      } = require("../HrRoutes/Attendance_section");

      const deductDays = a.paidDays != null ? a.paidDays : a.totalDays;

      // ── LIVE RE-CHECK at approval time ──────────────────────────────
      // Conditions could have changed since the application was created /
      // classified (other leaves approved in between, HR added a leave on
      // behalf, etc.). Hard-block the approval if the employee no longer
      // has the balance OR if approving would push past the monthly CL cap.
      // The approver must either reject this leave or get it re-classified
      // as LOP before they can move forward.
      if (deductDays > 0 && ["CL", "SL", "PL"].includes(a.leaveType)) {
        const fy = new Date(a.fromDate).getFullYear();
        const fc = await LC.getConfig();
        const liveBal = await LB.findOne({
          employeeId: a.employeeId,
          year: fy,
        }).lean();
        const consumedNow = liveBal?.consumed?.[a.leaveType] || 0;
        let entitlement;
        if (a.leaveType === "PL") {
          entitlement = liveBal?.entitlement?.PL || 0;
        } else if (a.leaveType === "CL") {
          entitlement = fc.clPerYear || 0;
        } else {
          entitlement = fc.slPerYear || 0;
        }
        const liveAvailable = Math.max(0, entitlement - consumedNow);

        // (1) Yearly balance check
        if (liveAvailable < deductDays) {
          return res.status(400).json({
            success: false,
            code: "INSUFFICIENT_BALANCE_AT_APPROVAL",
            message: `Cannot approve — ${a.employeeName} now has only ${liveAvailable} ${a.leaveType} day(s) remaining (needs ${deductDays}). Reject this leave, or have it re-classified as LOP.`,
            leaveType: a.leaveType,
            liveAvailable,
            needed: deductDays,
          });
        }

        // (2) Monthly CL cap check
        if (a.leaveType === "CL") {
          const maxCLMonth = fc.maxCLPerMonth || 3;
          const { used: clMonthUsed } = await countMonthlyUsage(
            a.employeeId,
            a.fromDate,
            "CL",
            a._id, // exclude this application from the count
          );
          if (clMonthUsed + deductDays > maxCLMonth) {
            return res.status(400).json({
              success: false,
              code: "CL_MONTHLY_CAP_AT_APPROVAL",
              message: `Cannot approve — ${a.employeeName} has already used ${clMonthUsed}/${maxCLMonth} CL this month. Approving would push them past the monthly limit. Reject this leave, or have it re-classified as LOP.`,
              leaveType: "CL",
              clMonthUsed,
              maxCLMonth,
              needed: deductDays,
            });
          }
        }
      }

      // All checks pass — commit the approval
      a.status = "hr_approved";
      a.hrApprovedAt = new Date();
      a.hrRemarks = remarks || `Approved by ${mt} manager`;
      await a.save();

      if (deductDays > 0 && a.leaveType !== "LOP" && a.leaveType !== "QUICK") {
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
        if (emailService?.sendLeaveManagerApprovedToHR) {
          emailService
            .sendLeaveManagerApprovedToHR({
              employeeName: a.employeeName,
              department: a.department,
              designation: a.designation,
              leaveType: a.leaveType,
              fromDate: a.fromDate,
              toDate: a.toDate,
              totalDays: a.totalDays,
              paidDays: a.paidDays,
              lwpDays: a.lwpDays,
              reason: a.reason,
              approvalChain: a.managerDecisions || [],
              applicationId: a._id.toString(),
              isQuickApply: a.isQuickApply,
              quickApply: a.quickApply,
            })
            .catch((e) => console.warn("[LEAVE-HR-EMAIL]", e.message));
        }
      } catch (_) {}

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
