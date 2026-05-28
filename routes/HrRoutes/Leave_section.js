"use strict";
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const Employee = require("../../models/Employee");
const {
  LeaveConfig,
  LeaveBalance,
  LeaveApplication,
  CompanyHoliday,
} = require("../../models/HR_Models/LeaveManagement");
const multer = require("multer");
const { uploadToGoogleDrive } = require("../../services/mediaUpload.service");
const emailService = require("../../services/emailService");

// Import attendance sync helpers
const Attendance_section = require("./Attendance_section");
const applyLeaveToAttendance = Attendance_section.applyLeaveToAttendance;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseLocalDate(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function countCalendarDays(fromStr, toStr) {
  if (!fromStr || !toStr) return 0;
  const from = parseLocalDate(fromStr);
  const to = parseLocalDate(toStr);
  if (from > to) return 0;
  return Math.round((to - from) / (24 * 60 * 60 * 1000)) + 1;
}

function workingDaysSince(joiningDate) {
  if (!joiningDate) return 0;
  const join = new Date(joiningDate);
  const today = new Date();
  let count = 0;
  const cur = new Date(join.getFullYear(), join.getMonth(), join.getDate());
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
//  BALANCE MUTATION — single safe write path, used by ALL approve / add / edit
//  routes that change `consumed`. Replaces every raw `$inc: { consumed.X: N }`
//  in this file.
//
//  Guard rails:
//    • Math.max(0, …) → consumed can never drop below 0 (e.g. when refunding
//      a leave that was over-applied — never get a negative balance).
//    • Math.min(entitlement, …) → consumed can never exceed entitlement, so
//      approving / adding a leave for someone already at 5/5 CL keeps them
//      at 5/5 instead of 6/5. Any excess silently rolls into LWP — the
//      caller's `lwpDays` field on the LeaveApplication still records it
//      correctly for payroll.
//
//  Returns: { applied: { [type]: { before, after, requested, capped } } }
// ─────────────────────────────────────────────────────────────────────────────
async function applyBalanceDelta({
  employeeId,
  year,
  biometricId,
  deltas,
  config,
}) {
  if (!employeeId || !year || !deltas) return { applied: {} };

  let bal = await LeaveBalance.findOne({ employeeId, year });
  if (!bal) {
    const cfg = config || (await LeaveConfig.getConfig());
    bal = await LeaveBalance.create({
      employeeId,
      biometricId: biometricId || "",
      year,
      entitlement: {
        CL: cfg.clPerYear || 5,
        SL: cfg.slPerYear || 5,
        PL: 0,
      },
      consumed: { CL: 0, SL: 0, PL: 0 },
      plEligible: false,
    });
  }

  const applied = {};
  let anyChange = false;
  for (const [type, deltaRaw] of Object.entries(deltas)) {
    const delta = Number(deltaRaw) || 0;
    if (delta === 0) continue;
    const ent = Number(bal.entitlement?.[type] || 0);
    const before = Number(bal.consumed?.[type] || 0);
    const proposed = before + delta;
    const capped = Math.max(0, Math.min(ent, proposed));
    bal.consumed[type] = capped;
    applied[type] = {
      before,
      after: capped,
      requested: delta,
      entitlement: ent,
      capped: capped !== proposed,
    };
    anyChange = true;
    console.log(
      `[BAL-DELTA] emp=${employeeId} year=${year}: consumed.${type} ` +
        `${before} → ${capped} (delta=${delta}, proposed=${proposed}, ` +
        `entitlement=${ent}${capped !== proposed ? ", CLAMPED" : ""})`,
    );
  }
  if (anyChange) await bal.save();
  return { applied, balance: bal };
}

// ─── Shared: apply leave + increment balance (replaces old finaliseApproval) ──
async function finaliseApproval(app, approverId, remarks = "") {
  app.status = "hr_approved";
  app.hrApprovedBy = approverId;
  app.hrApprovedAt = new Date();
  app.hrRemarks = remarks;
  await app.save();

  const year = parseLocalDate(app.fromDate).getFullYear();
  const config = await LeaveConfig.getConfig();
  const daysToDeduct =
    app.paidDays != null ? Number(app.paidDays) : Number(app.totalDays);

  if (daysToDeduct > 0 && ["CL", "SL", "PL"].includes(app.leaveType)) {
    const { applied } = await applyBalanceDelta({
      employeeId: app.employeeId,
      year,
      biometricId: app.biometricId || "",
      deltas: { [app.leaveType]: daysToDeduct },
      config,
    });
    const info = applied[app.leaveType];
    console.log(
      `[APPROVE] ${app.employeeName}: ${app.leaveType} ${info?.before} → ${info?.after} ` +
        `(requested +${daysToDeduct}${info?.capped ? ", CLAMPED at entitlement" : ""})`,
    );
  }

  // Sync to attendance
  let attendanceResult = { applied: 0, skipped: 0 };
  try {
    if (applyLeaveToAttendance)
      attendanceResult = await applyLeaveToAttendance(app);
  } catch (e) {
    console.warn("[APPROVE] attendance sync failed:", e.message);
  }
  return attendanceResult;
}

const hrUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only PDF, JPG, PNG or WEBP files are allowed."));
  },
}).single("document");

// ═══════════════════════════════════════════════════════════════════════════════
//  NAMED ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/config", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const config = await LeaveConfig.getConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put("/config", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const allowed = [
      "initialWaitingDays",
      "clPerYear",
      "slPerYear",
      "plPerYear",
      "daysRequiredForPL",
      "slDocumentThreshold",
      "maxCLPerMonth",
      "maxLeaveDaysPerMonth",
      "maxLeaveDaysPerMonthOdisha",
    ];
    const updates = { updatedBy: req.user.id };
    for (const key of allowed) {
      if (req.body[key] != null) updates[key] = Number(req.body[key]);
    }
    const config = await LeaveConfig.findOneAndUpdate(
      { singleton: "global" },
      { $set: updates },
      { new: true, upsert: true },
    );
    res.json({ success: true, data: config, message: "Configuration updated" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Stats — uses aggregation, NOT a full collection scan ─────────────────────
router.get("/stats", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const y = Number(req.query.year) || new Date().getFullYear();
    const fromStr = `${y}-01-01`;
    const toStr = `${y}-12-31`;

    const agg = await LeaveApplication.aggregate([
      { $match: { fromDate: { $gte: fromStr }, toDate: { $lte: toStr } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
          manager_approved: {
            $sum: { $cond: [{ $eq: ["$status", "manager_approved"] }, 1, 0] },
          },
          hr_approved: {
            $sum: { $cond: [{ $eq: ["$status", "hr_approved"] }, 1, 0] },
          },
          hr_rejected: {
            $sum: {
              $cond: [
                { $in: ["$status", ["hr_rejected", "manager_rejected"]] },
                1,
                0,
              ],
            },
          },
          CL: { $sum: { $cond: [{ $eq: ["$leaveType", "CL"] }, 1, 0] } },
          SL: { $sum: { $cond: [{ $eq: ["$leaveType", "SL"] }, 1, 0] } },
          PL: { $sum: { $cond: [{ $eq: ["$leaveType", "PL"] }, 1, 0] } },
        },
      },
    ]);

    const raw = agg[0] || {
      total: 0,
      pending: 0,
      manager_approved: 0,
      hr_approved: 0,
      hr_rejected: 0,
      CL: 0,
      SL: 0,
      PL: 0,
    };
    res.json({
      success: true,
      data: { ...raw, byType: { CL: raw.CL, SL: raw.SL, PL: raw.PL } },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/calendar", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { month, year, employeeId } = req.query;
    const y = Number(year) || new Date().getFullYear();
    const m = Number(month) || new Date().getMonth() + 1;
    const mStr = String(m).padStart(2, "0");
    const from = `${y}-${mStr}-01`;
    const to = `${y}-${mStr}-31`;

    const allHolidays = await CompanyHoliday.find({
      date: { $gte: from, $lte: to },
    }).lean();
    const workingSundays = new Set(
      allHolidays.filter((h) => h.type === "working_sunday").map((h) => h.date),
    );
    const holidays = allHolidays.filter((h) => h.type !== "working_sunday");

    const daysInMonth = new Date(y, m, 0).getDate();
    const cal = {};
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${y}-${mStr}-${String(d).padStart(2, "0")}`;
      const dow = new Date(y, m - 1, d).getDay();
      const isSunday = dow === 0;
      const hrHoliday = holidays.find((h) => h.date === ds) || null;
      const isWorkingOverride = isSunday && workingSundays.has(ds);
      cal[ds] = {
        date: ds,
        weekend: false,
        isSunday,
        isWorkingOverride,
        holiday: isWorkingOverride
          ? null
          : isSunday
            ? hrHoliday || { date: ds, name: "Sunday", type: "company" }
            : hrHoliday,
      };
    }
    res.json({
      success: true,
      data: {
        calendar: Object.values(cal),
        holidays,
        workingSundays: [...workingSundays],
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Holiday routes — canonical source of truth ──────────────────────────────
router.get("/holidays", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { year } = req.query;
    const filter = year
      ? { date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } }
      : {};
    const holidays = await CompanyHoliday.find(filter).sort({ date: 1 }).lean();
    res.json({ success: true, data: holidays });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/holidays", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { date, name, description, type } = req.body;
    if (!date || !name)
      return res
        .status(400)
        .json({ success: false, message: "date and name are required" });
    const h = await CompanyHoliday.findOneAndUpdate(
      { date },
      {
        date,
        name,
        description,
        type: type || "company",
        createdBy: req.user.id,
      },
      { new: true, upsert: true },
    );
    try {
      const { syncDayForce } = require("./Attendance_section");
      await syncDayForce?.(date);
    } catch (e) {
      console.warn("[HOLIDAY] re-sync failed:", e.message);
    }
    res.status(201).json({ success: true, data: h, message: "Holiday added" });
  } catch (err) {
    if (err.code === 11000)
      return res.status(400).json({
        success: false,
        message: "Holiday already exists on this date",
      });
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch(
  "/holidays/sunday-override",
  EmployeeAuthMiddleware,
  async (req, res) => {
    try {
      const { date } = req.body;
      if (!date)
        return res
          .status(400)
          .json({ success: false, message: "date required (YYYY-MM-DD)" });
      const [y, m, d] = date.split("-").map(Number);
      if (new Date(y, m - 1, d).getDay() !== 0)
        return res
          .status(400)
          .json({ success: false, message: "Selected date is not a Sunday" });
      const existing = await CompanyHoliday.findOne({
        date,
        type: "working_sunday",
      });
      if (existing) {
        await CompanyHoliday.deleteOne({ _id: existing._id });
        return res.json({
          success: true,
          action: "restored",
          message: "Sunday restored as company holiday",
        });
      } else {
        await CompanyHoliday.create({
          date,
          name: "Working Sunday",
          type: "working_sunday",
          createdBy: req.user?.id,
        });
        return res.json({
          success: true,
          action: "overridden",
          message: "Sunday marked as working day",
        });
      }
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

router.delete("/holidays/:id", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const h = await CompanyHoliday.findByIdAndDelete(req.params.id);
    if (h?.date) {
      try {
        const { syncDayForce } = require("./Attendance_section");
        await syncDayForce?.(h.date);
      } catch (e) {
        console.warn("[HOLIDAY-DEL] re-sync failed:", e.message);
      }
    }
    res.json({ success: true, message: "Holiday removed" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/balance/:employeeId", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const bal = await LeaveBalance.findOne({
      employeeId: req.params.employeeId,
      year,
    }).lean();
    if (!bal) return res.json({ success: true, data: null });
    res.json({
      success: true,
      data: {
        ...bal,
        available: {
          CL: Math.max(0, (bal.entitlement.CL || 0) - (bal.consumed.CL || 0)),
          SL: Math.max(0, (bal.entitlement.SL || 0) - (bal.consumed.SL || 0)),
          PL: Math.max(0, (bal.entitlement.PL || 0) - (bal.consumed.PL || 0)),
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/balance/init-year", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const year = Number(req.body.year) || new Date().getFullYear();
    const config = await LeaveConfig.getConfig();
    const emps = await Employee.find({ isActive: true })
      .select("_id biometricId")
      .lean();
    let created = 0,
      updated = 0;
    for (const emp of emps) {
      const existing = await LeaveBalance.findOne({
        employeeId: emp._id,
        year,
      });
      if (!existing) {
        const prevBal = await LeaveBalance.findOne({
          employeeId: emp._id,
          year: year - 1,
        });
        const plEligible = prevBal?.plEligible || false;
        await LeaveBalance.create({
          employeeId: emp._id,
          biometricId: emp.biometricId,
          year,
          entitlement: {
            CL: config.clPerYear,
            SL: config.slPerYear,
            PL: plEligible ? config.plPerYear : 0,
          },
          plEligible,
        });
        created++;
      } else {
        existing.entitlement.CL = config.clPerYear;
        existing.entitlement.SL = config.slPerYear;
        if (existing.plEligible) existing.entitlement.PL = config.plPerYear;
        existing.consumed = { CL: 0, SL: 0, PL: 0 };
        await existing.save();
        updated++;
      }
    }
    res.json({
      success: true,
      message: `Year ${year} initialized. Created: ${created}, Updated: ${updated}`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/balance/grant-pl", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { employeeId } = req.body;
    const config = await LeaveConfig.getConfig();
    const year = new Date().getFullYear();
    const emp = await Employee.findById(employeeId)
      .select("dateOfJoining biometricId")
      .lean();
    if (!emp)
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });
    const workingDays = workingDaysSince(emp.dateOfJoining);
    if (workingDays < config.daysRequiredForPL)
      return res.status(400).json({
        success: false,
        message: `Employee has ${workingDays}/${config.daysRequiredForPL} days`,
      });
    const bal = await LeaveBalance.findOneAndUpdate(
      { employeeId, year },
      {
        $set: {
          plEligible: true,
          plGrantedDate: new Date(),
          "entitlement.PL": config.plPerYear,
        },
      },
      { new: true, upsert: true },
    );
    res.json({ success: true, data: bal, message: "PL granted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  NEW: POST /sync-pl-eligibility — bulk PL granter
//  Walks every active employee. For each:
//    • Compute workingDaysSince(dateOfJoining)
//    • If >= config.daysRequiredForPL AND plEligible !== true:
//        → set plEligible = true
//        → set entitlement.PL = config.plPerYear (default 18)
//    • Skip if already plEligible — preserves their consumed PL,
//      no renewal logic touches anyone who already has PL.
//
//  Two modes:
//    body.dryRun=true → no mutations, returns the would-be result so HR can
//      preview the count before clicking again to apply.
//    body.dryRun=false / unset → actually applies, returns the same summary.
//
//  Response: { eligible, granted, alreadyEligible, notYetEligible, list }
//   • eligible           — total who qualify on workingDays
//   • granted            — how many had PL granted this run (only if !dryRun)
//   • alreadyEligible    — skipped (already plEligible)
//   • notYetEligible     — under the threshold
//   • list               — array of {name, bid, workingDays, action}
// ═══════════════════════════════════════════════════════════════════════════════
router.post(
  "/sync-pl-eligibility",
  EmployeeAuthMiddleware,
  async (req, res) => {
    try {
      const dryRun = !!req.body?.dryRun;
      const config = await LeaveConfig.getConfig();
      const year = new Date().getFullYear();
      const threshold = config.daysRequiredForPL || 240;
      const plPerYear = config.plPerYear || 18;

      const emps = await Employee.find({ isActive: true })
        .select("_id firstName lastName biometricId dateOfJoining department")
        .lean();

      const existingBalances = await LeaveBalance.find({ year })
        .select("employeeId plEligible entitlement consumed")
        .lean();
      const balByEmpId = new Map(
        existingBalances.map((b) => [String(b.employeeId), b]),
      );

      let granted = 0,
        alreadyEligible = 0,
        notYetEligible = 0,
        eligible = 0;
      const list = [];

      for (const emp of emps) {
        const wd = workingDaysSince(emp.dateOfJoining);
        const name = `${emp.firstName || ""} ${emp.lastName || ""}`.trim();
        const existing = balByEmpId.get(String(emp._id));

        // Already PL eligible → skip silently, no renewal.
        if (existing?.plEligible) {
          alreadyEligible++;
          continue;
        }

        if (wd >= threshold) {
          eligible++;
          if (dryRun) {
            list.push({
              employeeId: String(emp._id),
              name,
              biometricId: emp.biometricId || "",
              department: emp.department || "",
              workingDays: wd,
              action: "would_grant",
            });
          } else {
            // Apply the grant. Upsert in case there's no LeaveBalance row.
            await LeaveBalance.findOneAndUpdate(
              { employeeId: emp._id, year },
              {
                $set: {
                  plEligible: true,
                  plGrantedDate: new Date(),
                  "entitlement.PL": plPerYear,
                  biometricId: emp.biometricId || "",
                },
                $setOnInsert: {
                  employeeId: emp._id,
                  year,
                  "entitlement.CL": config.clPerYear,
                  "entitlement.SL": config.slPerYear,
                  consumed: { CL: 0, SL: 0, PL: 0 },
                },
              },
              { upsert: true, new: true },
            );
            granted++;
            list.push({
              employeeId: String(emp._id),
              name,
              biometricId: emp.biometricId || "",
              department: emp.department || "",
              workingDays: wd,
              action: "granted",
            });
            console.log(
              `[PL-SYNC] Granted ${plPerYear} PL to ${name} (${emp.biometricId}, ${wd} working days)`,
            );
          }
        } else {
          notYetEligible++;
        }
      }

      res.json({
        success: true,
        message: dryRun
          ? `Dry run: ${eligible} employee(s) would be granted PL. ${alreadyEligible} already eligible, ${notYetEligible} below threshold.`
          : `${granted} employee(s) granted ${plPerYear} PL. ${alreadyEligible} already eligible, ${notYetEligible} below threshold.`,
        data: {
          dryRun,
          threshold,
          plPerYear,
          year,
          eligible,
          granted,
          alreadyEligible,
          notYetEligible,
          totalActive: emps.length,
          list,
        },
      });
    } catch (err) {
      console.error("[PL-SYNC]", err);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
//  NEW: GET /all-balances — for the HR "Balances" tab
//  Returns ALL active employees with their CL/SL/PL entitlement, consumed,
//  available, and plEligible flag. Includes employees with no LeaveBalance
//  record yet (zeros across the board) so the tab shows everyone.
//
//  Query params: year, department (optional filter), search (optional)
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/all-balances", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const department = req.query.department || "all";
    const search = (req.query.search || "").trim();

    const empFilter = { isActive: true };
    if (department !== "all") empFilter.department = department;
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      empFilter.$or = [
        { firstName: rx },
        { lastName: rx },
        { biometricId: rx },
        { department: rx },
      ];
    }

    const emps = await Employee.find(empFilter)
      .select(
        "firstName lastName biometricId department designation dateOfJoining profilePhoto",
      )
      .sort({ firstName: 1 })
      .lean();
    const empIds = emps.map((e) => e._id);
    const balances = await LeaveBalance.find({
      employeeId: { $in: empIds },
      year,
    }).lean();
    const balByEmp = new Map(balances.map((b) => [String(b.employeeId), b]));

    const config = await LeaveConfig.getConfig();
    const rows = emps.map((e) => {
      const bal = balByEmp.get(String(e._id));
      const ent = bal?.entitlement || {
        CL: config.clPerYear,
        SL: config.slPerYear,
        PL: 0,
      };
      const con = bal?.consumed || { CL: 0, SL: 0, PL: 0 };
      const name = `${e.firstName || ""} ${e.lastName || ""}`.trim();
      const workingDays = workingDaysSince(e.dateOfJoining);
      return {
        employeeId: String(e._id),
        name,
        biometricId: e.biometricId || "",
        department: e.department || "",
        designation: e.designation || "",
        profilePhoto: e.profilePhoto?.url || null,
        dateOfJoining: e.dateOfJoining,
        workingDays,
        plEligibleByPolicy: workingDays >= (config.daysRequiredForPL || 240),
        plEligible: bal?.plEligible || false,
        entitlement: {
          CL: Number(ent.CL || 0),
          SL: Number(ent.SL || 0),
          PL: Number(ent.PL || 0),
        },
        consumed: {
          CL: Number(con.CL || 0),
          SL: Number(con.SL || 0),
          PL: Number(con.PL || 0),
        },
        available: {
          CL: Math.max(0, Number(ent.CL || 0) - Number(con.CL || 0)),
          SL: Math.max(0, Number(ent.SL || 0) - Number(con.SL || 0)),
          PL: Math.max(0, Number(ent.PL || 0) - Number(con.PL || 0)),
        },
        hasBalanceRecord: !!bal,
      };
    });

    res.json({
      success: true,
      data: {
        year,
        rows,
        total: rows.length,
        config: {
          clPerYear: config.clPerYear,
          slPerYear: config.slPerYear,
          plPerYear: config.plPerYear,
          daysRequiredForPL: config.daysRequiredForPL,
        },
      },
    });
  } catch (err) {
    console.error("[ALL-BALANCES]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Bulk approve ─────────────────────────────────────────────────────────────
router.patch("/bulk-approve", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids?.length)
      return res
        .status(400)
        .json({ success: false, message: "No IDs provided" });

    const apps = await LeaveApplication.find({
      _id: { $in: ids },
      status: { $in: ["pending", "manager_approved"] },
    });
    let attendanceAppliedCount = 0;

    for (const app of apps) {
      const result = await finaliseApproval(
        app,
        req.user.id,
        "Bulk approved by HR",
      );
      if (result.applied > 0) attendanceAppliedCount++;
    }
    res.json({
      success: true,
      message: `${apps.length} leave(s) approved (${attendanceAppliedCount} synced to attendance)`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Backfill attendance for already-approved leaves ─────────────────────────
router.post(
  "/backfill-attendance",
  EmployeeAuthMiddleware,
  async (req, res) => {
    try {
      const { employeeId, year } = req.body;
      const filter = { status: "hr_approved" };
      if (employeeId) filter.employeeId = employeeId;
      if (year) {
        filter.fromDate = { $gte: `${year}-01-01` };
        filter.toDate = { $lte: `${year}-12-31` };
      }
      const apps = await LeaveApplication.find(filter);
      const results = [];
      let totalApplied = 0,
        totalSkipped = 0;
      for (const app of apps) {
        try {
          const r = await applyLeaveToAttendance(app);
          totalApplied += r.applied;
          totalSkipped += r.skipped;
          results.push({
            id: app._id,
            employee: app.employeeName,
            leaveType: app.leaveType,
            range: `${app.fromDate} → ${app.toDate}`,
            applied: r.applied,
            skipped: r.skipped,
          });
        } catch (e) {
          results.push({ id: app._id, error: e.message });
        }
      }
      res.json({
        success: true,
        message: `Processed ${apps.length} approved leave(s). Applied to ${totalApplied} day(s), skipped ${totalSkipped}.`,
        totalLeaves: apps.length,
        totalApplied,
        totalSkipped,
        results,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ─── Debug trace ──────────────────────────────────────────────────────────────
router.get(
  "/debug-attendance/:id",
  EmployeeAuthMiddleware,
  async (req, res) => {
    try {
      const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
      const app = await LeaveApplication.findById(req.params.id).lean();
      if (!app)
        return res.status(404).json({ success: false, message: "Not found" });
      const start = parseLocalDate(app.fromDate);
      const end = parseLocalDate(app.toDate);
      const trace = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const bid = String(app.biometricId || "").toUpperCase();
        const dayDoc = await DailyAttendance.findOne({ dateStr: ds }).lean();
        if (!dayDoc) {
          trace.push({ date: ds, status: "❌ Day not synced yet" });
          continue;
        }
        const entry = (dayDoc.employees || []).find(
          (e) => e.biometricId === bid,
        );
        if (!entry) {
          trace.push({
            date: ds,
            status: "⚠️ Employee not in day doc — would inject leave row",
          });
          continue;
        }
        trace.push({
          date: ds,
          systemPrediction: entry.systemPrediction,
          hrFinalStatus: entry.hrFinalStatus,
          wouldSkip: ["WO", "FH", "NH", "OH", "RH", "PH"].includes(
            entry.systemPrediction,
          ),
          status: entry.hrFinalStatus
            ? `✓ Has hrFinalStatus = ${entry.hrFinalStatus}`
            : ["WO", "FH", "NH", "OH", "RH", "PH"].includes(
                  entry.systemPrediction,
                )
              ? `⚠️ Skipped (${entry.systemPrediction})`
              : "Would set hrFinalStatus",
        });
      }
      res.json({
        success: true,
        leave: {
          id: app._id,
          employee: app.employeeName,
          biometricId: app.biometricId,
          leaveType: app.leaveType,
          fromDate: app.fromDate,
          toDate: app.toDate,
          status: app.status,
          appliedToAttendance: app.appliedToAttendance,
        },
        mappedTo:
          { CL: "L-CL", SL: "L-SL", PL: "L-EL" }[app.leaveType] || "UNKNOWN",
        trace,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ─── GET / — applications list with efficient stats via aggregation ───────────
router.get("/", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const {
      status,
      department,
      leaveType,
      month,
      year,
      search,
      page = 1,
      limit = 50,
    } = req.query;
    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (department && department !== "all") filter.department = department;
    if (leaveType && leaveType !== "all") filter.leaveType = leaveType;
    if (month && year) {
      const mStr = String(month).padStart(2, "0");
      filter.fromDate = { $lte: `${year}-${mStr}-31` };
      filter.toDate = { $gte: `${year}-${mStr}-01` };
    } else if (year) {
      filter.fromDate = { $gte: `${year}-01-01` };
      filter.toDate = { $lte: `${year}-12-31` };
    }
    if (search)
      filter.$or = [
        { employeeName: new RegExp(search, "i") },
        { department: new RegExp(search, "i") },
      ];

    const skip = (Number(page) - 1) * Number(limit);
    const [apps, total, statsAgg] = await Promise.all([
      LeaveApplication.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate("employeeId", "firstName lastName biometricId profilePhoto")
        .lean(),
      LeaveApplication.countDocuments(filter),
      LeaveApplication.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            pending: {
              $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
            },
            manager_approved: {
              $sum: { $cond: [{ $eq: ["$status", "manager_approved"] }, 1, 0] },
            },
            hr_approved: {
              $sum: { $cond: [{ $eq: ["$status", "hr_approved"] }, 1, 0] },
            },
            hr_rejected: {
              $sum: {
                $cond: [
                  { $in: ["$status", ["hr_rejected", "manager_rejected"]] },
                  1,
                  0,
                ],
              },
            },
            cancelled: {
              $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
            },
            CL: { $sum: { $cond: [{ $eq: ["$leaveType", "CL"] }, 1, 0] } },
            SL: { $sum: { $cond: [{ $eq: ["$leaveType", "SL"] }, 1, 0] } },
            PL: { $sum: { $cond: [{ $eq: ["$leaveType", "PL"] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const s = statsAgg[0] || {
      total: 0,
      pending: 0,
      manager_approved: 0,
      hr_approved: 0,
      hr_rejected: 0,
      cancelled: 0,
      CL: 0,
      SL: 0,
      PL: 0,
    };
    const stats = {
      total: s.total,
      pending: s.pending,
      manager_approved: s.manager_approved,
      hr_approved: s.hr_approved,
      hr_rejected: s.hr_rejected,
      cancelled: s.cancelled,
      byType: { CL: s.CL, SL: s.SL, PL: s.PL },
    };

    res.json({
      success: true,
      data: {
        applications: apps,
        total,
        page: Number(page),
        pages: Math.ceil(total / Number(limit)),
        stats,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  EMPLOYEE-BALANCE / ADD-ON-BEHALF / UPLOAD-DOCUMENT / ADJUST
//  (These were defined in the second half of the original file. Preserved
//  here with their original behaviour + clamping added to balance mutations.)
// ═══════════════════════════════════════════════════════════════════════════════
router.get(
  "/employee-balance/:employeeId",
  EmployeeAuthMiddleware,
  async (req, res) => {
    try {
      const year = new Date().getFullYear();
      const bal = await LeaveBalance.findOne({
        employeeId: req.params.employeeId,
        year,
      }).lean();
      if (!bal) return res.json({ success: true, data: null });
      const available = {
        CL: Math.max(0, (bal.entitlement?.CL || 0) - (bal.consumed?.CL || 0)),
        SL: Math.max(0, (bal.entitlement?.SL || 0) - (bal.consumed?.SL || 0)),
        PL: Math.max(0, (bal.entitlement?.PL || 0) - (bal.consumed?.PL || 0)),
        LWP: 999,
        CO: 999,
        WFH: 999,
      };
      res.json({ success: true, data: { ...bal, available } });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

// HR adds leave on behalf — auto-approved, with clamped balance deduction.
router.post("/add-on-behalf", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const {
      employeeId,
      leaveType,
      startDate,
      endDate,
      isHalfDay,
      reason,
      hrRemarks,
    } = req.body;

    if (!employeeId || !leaveType || !startDate || !endDate || !reason)
      return res.status(400).json({
        success: false,
        message:
          "employeeId, leaveType, startDate, endDate, reason are required",
      });

    const emp = await Employee.findById(employeeId);
    if (!emp)
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });

    const days = isHalfDay
      ? 0.5
      : Math.max(
          1,
          Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1,
        );

    const app = await LeaveApplication.create({
      employeeId: emp._id,
      biometricId: emp.biometricId,
      employeeName: `${emp.firstName} ${emp.lastName}`,
      department: emp.department,
      designation: emp.designation,
      leaveType,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      fromDate: startDate,
      toDate: endDate,
      isHalfDay: isHalfDay || false,
      numberOfDays: days,
      totalDays: days,
      reason,
      hrRemarks: hrRemarks || "",
      status: "hr_approved",
      addedByHR: true,
      addedByHRId: req.user.id,
      hrApprovedAt: new Date(),
      hrApprovedBy: req.user.id,
      managersNotified: [],
      applicationDate: new Date(),
    });

    // Clamped deduction — never goes above entitlement.
    if (["CL", "SL", "PL"].includes(leaveType)) {
      const year = new Date(startDate).getFullYear();
      const config = await LeaveConfig.getConfig();
      const { applied } = await applyBalanceDelta({
        employeeId: emp._id,
        year,
        biometricId: emp.biometricId || "",
        deltas: { [leaveType]: days },
        config,
      });
      const info = applied[leaveType];
      console.log(
        `[HR-ON-BEHALF] ${emp.firstName} ${emp.lastName}: ${leaveType} ${info?.before} → ${info?.after}` +
          `${info?.capped ? " (CLAMPED at entitlement)" : ""}`,
      );
    }

    // Reflect on attendance for any days that are today or already past
    try {
      const todayStr = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const startStr = new Date(startDate).toISOString().slice(0, 10);
      const endStr = new Date(endDate).toISOString().slice(0, 10);
      if (startStr <= todayStr) {
        const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
        const statusCode =
          { CL: "L-CL", SL: "L-SL", PL: "L-EL" }[leaveType] || `L-${leaveType}`;
        let cur = new Date(startStr + "T00:00:00Z");
        const todayDate = new Date(todayStr + "T00:00:00Z");
        while (cur <= todayDate && cur.toISOString().slice(0, 10) <= endStr) {
          const ds = cur.toISOString().slice(0, 10);
          await DailyAttendance.findOneAndUpdate(
            { dateStr: ds, "employees.biometricId": emp.biometricId },
            {
              $set: {
                "employees.$.hrFinalStatus": statusCode,
                "employees.$.hrRemarks": `Leave added by HR (${leaveType})`,
                "employees.$.hrReviewedAt": new Date(),
              },
            },
          ).catch(() => {});
          cur.setUTCDate(cur.getUTCDate() + 1);
        }
      }
    } catch (syncErr) {
      console.warn("[HR-ADD-LEAVE] attendance sync failed:", syncErr.message);
    }

    res.json({
      success: true,
      data: app,
      message: `Leave added and approved for ${emp.firstName}`,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post(
  "/:id/upload-document",
  EmployeeAuthMiddleware,
  (req, res, next) => {
    hrUploadMiddleware(req, res, (err) => {
      if (err)
        return res.status(400).json({ success: false, message: err.message });
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file)
        return res
          .status(400)
          .json({ success: false, message: "No file uploaded." });

      const app = await LeaveApplication.findById(req.params.id);
      if (!app)
        return res
          .status(404)
          .json({ success: false, message: "Leave application not found." });

      const ext = req.file.originalname.includes(".")
        ? req.file.originalname.slice(req.file.originalname.lastIndexOf("."))
        : ".pdf";
      const safeName = (app.employeeName || "employee").replace(
        /[^a-zA-Z0-9]/g,
        "_",
      );
      const fileName = `SL_${safeName}_${app.fromDate}_${Date.now()}${ext}`;

      const driveResult = await uploadToGoogleDrive(req.file.buffer, {
        fileName,
        mimeType: req.file.mimetype,
      });

      await LeaveApplication.updateOne(
        { _id: req.params.id },
        {
          $set: {
            documentSubmitted: true,
            documentUrl: driveResult.viewUrl || driveResult.url,
            documentFileId: driveResult.fileId,
            documentFileName: fileName,
            documentUploadedAt: new Date(),
          },
        },
      );

      return res.json({
        success: true,
        message: "Document uploaded to Google Drive.",
        data: {
          documentUrl: driveResult.viewUrl || driveResult.url,
          documentFileName: fileName,
        },
      });
    } catch (err) {
      console.error("[HR-DOC-UPLOAD]", err.message);
      return res
        .status(500)
        .json({ success: false, message: err.message || "Upload failed." });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
//  WILDCARD ROUTES (must come after all named routes above)
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/:id", EmployeeAuthMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid application ID" });

    const app = await LeaveApplication.findById(req.params.id)
      .populate(
        "employeeId",
        "firstName lastName biometricId designation department profilePhoto dateOfJoining primaryManager secondaryManager",
      )
      .lean();
    if (!app)
      return res
        .status(404)
        .json({ success: false, message: "Application not found" });

    const year = new Date().getFullYear();
    const empId = app.employeeId?._id || app.employeeId;
    const rawBal = await LeaveBalance.findOne({
      employeeId: empId,
      year,
    }).lean();
    const employeeBalance = rawBal
      ? {
          entitlement: rawBal.entitlement,
          consumed: rawBal.consumed,
          available: {
            CL: Math.max(
              0,
              (rawBal.entitlement.CL || 0) - (rawBal.consumed.CL || 0),
            ),
            SL: Math.max(
              0,
              (rawBal.entitlement.SL || 0) - (rawBal.consumed.SL || 0),
            ),
            PL: Math.max(
              0,
              (rawBal.entitlement.PL || 0) - (rawBal.consumed.PL || 0),
            ),
          },
        }
      : null;

    res.json({ success: true, data: { ...app, employeeBalance } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── HR Approve — respects manager flow, with clamped balance deduction ───────
router.patch("/:id/approve", EmployeeAuthMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid application ID" });

    const app = await LeaveApplication.findById(req.params.id);
    if (!app)
      return res
        .status(404)
        .json({ success: false, message: "Application not found" });
    if (app.status === "hr_approved")
      return res
        .status(400)
        .json({ success: false, message: "Already approved" });

    const remarks = req.body?.remarks || "";

    // Validate workflow: if a primary manager exists and hasn't approved yet,
    // block HR from front-running. Secondary-only flow is allowed without
    // primary because employee may have no primary set.
    const hasPrimary = app.managersNotified?.some((m) => m.type === "primary");
    const primaryApproved = app.managerDecisions?.some(
      (d) => d.type === "primary" && d.decision === "approved",
    );
    if (hasPrimary && !primaryApproved && app.status === "pending") {
      return res.status(400).json({
        success: false,
        message:
          "Primary manager approval is required before HR can approve this leave.",
      });
    }

    const attendanceResult = await finaliseApproval(app, req.user.id, remarks);

    res.json({
      success: true,
      data: app,
      message: `Leave approved. Attendance updated on ${attendanceResult.applied} day(s).`,
      attendanceSync: attendanceResult,
    });
  } catch (err) {
    console.error("Approve error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch("/:id/reject", EmployeeAuthMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid application ID" });

    const app = await LeaveApplication.findById(req.params.id);
    if (!app)
      return res
        .status(404)
        .json({ success: false, message: "Application not found" });
    if (["hr_approved", "hr_rejected"].includes(app.status))
      return res
        .status(400)
        .json({ success: false, message: `Leave is already ${app.status}` });

    app.status = "hr_rejected";
    app.rejectedBy = req.user.id;
    app.rejectedAt = new Date();
    app.rejectionReason = req.body?.rejectionReason || "";
    await app.save();

    // Notify employee via email (non-fatal)
    try {
      if (emailService.sendLeaveRejectedToEmployee) {
        const emp = await Employee.findById(app.employeeId)
          .select("email firstName lastName")
          .lean();
        if (emp?.email) {
          emailService
            .sendLeaveRejectedToEmployee({
              employeeEmail: emp.email,
              employeeName: app.employeeName,
              leaveType: app.leaveType,
              fromDate: app.fromDate,
              toDate: app.toDate,
              totalDays: app.totalDays,
              reason: app.rejectionReason,
            })
            .catch((e) => console.warn("[REJECT-EMAIL]", e.message));
        }
      }
    } catch (_) {}

    res.json({ success: true, data: app, message: "Leave rejected" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── HR balance adjustment — manual edit with clamping ────────────────────────
router.patch(
  "/balance/:employeeId/adjust",
  EmployeeAuthMiddleware,
  async (req, res) => {
    try {
      const { year, leaveType, field, value, reason } = req.body;
      if (!year || !leaveType || !field || value == null)
        return res.status(400).json({
          success: false,
          message: "year, leaveType, field, value required",
        });
      if (!["consumed", "entitlement"].includes(field))
        return res.status(400).json({
          success: false,
          message: "field must be 'consumed' or 'entitlement'",
        });
      if (!["CL", "SL", "PL"].includes(leaveType))
        return res
          .status(400)
          .json({ success: false, message: "Invalid leave type" });

      // Need both fields visible at once to clamp correctly.
      let bal = await LeaveBalance.findOne({
        employeeId: req.params.employeeId,
        year: Number(year),
      });
      if (!bal) {
        const config = await LeaveConfig.getConfig();
        bal = await LeaveBalance.create({
          employeeId: req.params.employeeId,
          year: Number(year),
          entitlement: { CL: config.clPerYear, SL: config.slPerYear, PL: 0 },
          consumed: { CL: 0, SL: 0, PL: 0 },
        });
      }
      const newVal = Math.max(0, Number(value));
      if (field === "consumed") {
        // Clamp consumed to current entitlement.
        const ent = Number(bal.entitlement?.[leaveType] || 0);
        bal.consumed[leaveType] = Math.min(ent, newVal);
      } else {
        bal.entitlement[leaveType] = newVal;
        // If entitlement dropped below current consumed, push consumed down.
        const con = Number(bal.consumed?.[leaveType] || 0);
        if (con > newVal) bal.consumed[leaveType] = newVal;
      }
      await bal.save();
      console.log(
        `[HR-ADJUST] ${req.params.employeeId}: ${field}.${leaveType} ` +
          `requested=${value} applied=${bal[field][leaveType]} ` +
          `(reason: ${reason || "N/A"})`,
      );
      const available = {
        CL: Math.max(0, (bal.entitlement.CL || 0) - (bal.consumed.CL || 0)),
        SL: Math.max(0, (bal.entitlement.SL || 0) - (bal.consumed.SL || 0)),
        PL: Math.max(0, (bal.entitlement.PL || 0) - (bal.consumed.PL || 0)),
      };
      res.json({
        success: true,
        data: { ...bal.toObject(), available },
        message: `${field}.${leaveType} set to ${bal[field][leaveType]}`,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ─── Email helpers (preserved from original) ──────────────────────────────────
async function _notifyEmployeeApproved(app) {
  try {
    const emp = await Employee.findById(app.employeeId).select("email").lean();
    if (emp?.email) {
      emailService
        .sendLeaveApprovedToEmployee({
          employeeEmail: emp.email,
          employeeName: app.employeeName,
          leaveType: app.leaveType,
          fromDate: app.fromDate,
          toDate: app.toDate,
          totalDays: app.totalDays,
          isHalfDay: app.isHalfDay,
          approvedBy: "HR",
        })
        .catch((e) => console.warn("[HR-APPROVE-EMAIL]", e.message));
    }
  } catch (e) {
    console.warn("[HR-APPROVE-EMAIL]", e.message);
  }
}

async function _notifyEmployeeRejected(app, rejectionReason) {
  try {
    const emp = await Employee.findById(app.employeeId).select("email").lean();
    if (emp?.email) {
      emailService
        .sendLeaveRejectedToEmployee({
          employeeEmail: emp.email,
          employeeName: app.employeeName,
          leaveType: app.leaveType,
          fromDate: app.fromDate,
          toDate: app.toDate,
          totalDays: app.totalDays,
          reason: rejectionReason || app.rejectionReason || "Not approved",
        })
        .catch((e) => console.warn("[HR-REJECT-EMAIL]", e.message));
    }
  } catch (e) {
    console.warn("[HR-REJECT-EMAIL]", e.message);
  }
}

module.exports = router;
