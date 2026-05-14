"use strict";
/**
 * routes/Employee_Routes/employeeAttendance.js
 */

const express = require("express");
const router = express.Router();
const Employee = require("../../models/Employee");
const AttendanceRouter = require("../HrRoutes/Attendance_section");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getTodayIST() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function fmtTime(date) {
  if (!date) return null;
  return new Date(date).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function minsToHrsDisplay(mins = 0) {
  if (!mins || mins <= 0) return null;
  const h = Math.floor(mins / 60),
    m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

const STATUS_META = {
  P: { label: "Present", color: "emerald" },
  "P*": { label: "Present (Late)", color: "emerald" },
  "P~": { label: "Present (Early Out)", color: "emerald" },
  AB: { label: "Absent", color: "red" },
  LAB: { label: "Late → Absent", color: "red" },
  EAB: { label: "Early Out → Absent", color: "red" },
  LHD: { label: "Late → Half Day", color: "yellow" },
  WO: { label: "Week Off", color: "slate" },
  PH: { label: "Public Holiday", color: "amber" },
  FH: { label: "Festival Holiday", color: "amber" },
  NH: { label: "National Holiday", color: "amber" },
  OH: { label: "Optional Holiday", color: "amber" },
  RH: { label: "Restricted Holiday", color: "amber" },
  HD: { label: "Half Day", color: "yellow" },
  "L-CL": { label: "Casual Leave", color: "indigo" },
  "L-SL": { label: "Sick Leave", color: "orange" },
  "L-EL": { label: "Privilege Leave", color: "purple" },
  LWP: { label: "Unpaid Leave", color: "red" },
  MP: { label: "Miss Punch", color: "orange" },
  WFH: { label: "Work From Home", color: "blue" },
  CO: { label: "Comp. Off", color: "violet" },
};

// ─── Late-count promotion (mirrors HR logic) ──────────────────────────────────
// Replays applyLateCountPromotion over the full month so effectiveStatus
// includes LAB / LHD / EAB exactly as the HR timecard shows.
//
// policy comes from AttendanceSettings.lateHalfDayPolicy:
//   { enabled, lateHDOnCount (3), lateFullDayOnCount (5),
//     earlyOutHDOnCount (3), earlyOutFullDayOnCount (5) }
//
// state = { lateCount, earlyCount } — mutated in place
// Returns { promotedStatus: "LAB"|"LHD"|"EAB"|"HD"|null }
function applyLateCountPromotion(entry, state, policy, dateStr, todayStr) {
  if (!policy?.enabled || entry.hrFinalStatus || dateStr === todayStr)
    return { promotedStatus: null };

  const lateHDOn = policy.lateHDOnCount ?? 3;
  const lateFullDayOn = policy.lateFullDayOnCount ?? 5;
  const earlyHDOn = policy.earlyOutHDOnCount ?? 3;
  const earlyFullOn = policy.earlyOutFullDayOnCount ?? 5;

  if (entry.isLate && entry.systemPrediction === "P*") {
    state.lateCount++;
    if (state.lateCount >= lateFullDayOn) {
      state.lateCount = 0;
      return { promotedStatus: "LAB" };
    }
    if (state.lateCount === lateHDOn) return { promotedStatus: "LHD" };
  } else if (entry.isEarlyDeparture && entry.systemPrediction === "P~") {
    state.earlyCount++;
    if (state.earlyCount >= earlyFullOn) {
      state.earlyCount = 0;
      return { promotedStatus: "EAB" };
    }
    if (state.earlyCount === earlyHDOn) return { promotedStatus: "HD" };
  }
  return { promotedStatus: null };
}

function enrichEntry(entry, dayDoc, effectiveStatus) {
  const rawStatus =
    effectiveStatus || entry?.hrFinalStatus || entry?.systemPrediction || null;
  const meta = STATUS_META[rawStatus] || {
    label: rawStatus || "—",
    color: "gray",
  };

  return {
    dateStr: dayDoc.dateStr,
    status: rawStatus,
    effectiveStatus: rawStatus,
    systemPrediction: entry?.systemPrediction || null,
    hrFinalStatus: entry?.hrFinalStatus || null,
    label: meta.label,
    color: meta.color,
    isHrEdited: !!entry?.hrFinalStatus,
    inTime: fmtTime(entry?.inTime),
    finalOut: fmtTime(entry?.finalOut),
    netWorkMins: entry?.netWorkMins || 0,
    workDisplay: minsToHrsDisplay(entry?.netWorkMins),
    isLate: entry?.isLate || false,
    lateMins: entry?.lateMins || 0,
    lateDisplay: entry?.lateDisplay || "",
    isEarlyDeparture: entry?.isEarlyDeparture || false,
    earlyDepartureMins: entry?.earlyDepartureMins || 0,
    holiday: dayDoc.holiday || null,
    hasMissPunch: entry?.hasMissPunch || false,
    otMins: entry?.otMins || 0,
    punchCount: entry?.punchCount || 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GET /today
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/today", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const emp = await Employee.findById(req.user.id)
      .select("biometricId")
      .lean();
    if (!emp?.biometricId)
      return res.json({
        success: true,
        data: null,
        message: "No biometric ID assigned",
      });

    const dateStr = getTodayIST();
    const yearMonth = dateStr.slice(0, 7);
    const bid = String(emp.biometricId).toUpperCase();

    const dayDoc = await DailyAttendance.findOne({ dateStr }).lean();
    if (!dayDoc)
      return res.json({
        success: true,
        data: {
          dateStr,
          status: null,
          label: "Not synced yet",
          color: "gray",
          synced: false,
        },
      });

    const entry = (dayDoc.employees || []).find((e) => e.biometricId === bid);

    // Replay promotion for this month up to today
    let effectiveStatus =
      entry?.hrFinalStatus || entry?.systemPrediction || null;
    try {
      const AttendanceSettings = require("../../models/HR_Models/Attendancesettings");
      const settings = await AttendanceSettings.getConfig();
      const policy = settings.lateHalfDayPolicy;
      const todayStr = dateStr;
      if (policy?.enabled && entry && !entry.hrFinalStatus) {
        // Load all days in month up to today in order
        const monthDocs = await DailyAttendance.find({
          yearMonth,
          dateStr: { $lte: dateStr },
        })
          .select(
            "dateStr employees.biometricId employees.isLate employees.isEarlyDeparture employees.systemPrediction employees.hrFinalStatus",
          )
          .sort({ dateStr: 1 })
          .lean();
        const state = { lateCount: 0, earlyCount: 0 };
        for (const d of monthDocs) {
          const e = (d.employees || []).find((x) => x.biometricId === bid);
          if (!e) continue;
          const { promotedStatus } = applyLateCountPromotion(
            e,
            state,
            policy,
            d.dateStr,
            todayStr,
          );
          if (d.dateStr === dateStr && promotedStatus)
            effectiveStatus = promotedStatus;
        }
      }
    } catch (_) {
      /* non-fatal — fall through to raw status */
    }

    res.json({
      success: true,
      data: { ...enrichEntry(entry, dayDoc, effectiveStatus), synced: true },
    });
  } catch (err) {
    console.error("[ATT-TODAY]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  GET /monthly?month=MM&year=YYYY
//  Returns all days with effectiveStatus (LAB / LHD / EAB included)
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/monthly", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const emp = await Employee.findById(req.user.id)
      .select("biometricId")
      .lean();
    if (!emp?.biometricId)
      return res.json({
        success: true,
        data: [],
        summary: {},
        message: "No biometric ID assigned",
      });

    const year = String(req.query.year || new Date().getFullYear());
    const month = String(req.query.month || new Date().getMonth() + 1).padStart(
      2,
      "0",
    );
    const yearMonth = `${year}-${month}`;
    const bid = String(emp.biometricId).toUpperCase();
    const todayStr = getTodayIST();

    const dayDocs = await DailyAttendance.find({ yearMonth })
      .sort({ dateStr: 1 })
      .lean();

    // ── Load promotion policy ────────────────────────────────────────────
    let policy = null;
    try {
      const AttendanceSettings = require("../../models/HR_Models/Attendancesettings");
      const settings = await AttendanceSettings.getConfig();
      policy = settings.lateHalfDayPolicy;
    } catch (_) {
      /* non-fatal */
    }

    // ── Replay promotion in date order ───────────────────────────────────
    const promotionMap = new Map(); // dateStr → promotedStatus
    if (policy?.enabled) {
      const state = { lateCount: 0, earlyCount: 0 };
      for (const d of dayDocs) {
        const entry = (d.employees || []).find((e) => e.biometricId === bid);
        if (!entry) continue;
        const { promotedStatus } = applyLateCountPromotion(
          entry,
          state,
          policy,
          d.dateStr,
          todayStr,
        );
        if (promotedStatus) promotionMap.set(d.dateStr, promotedStatus);
      }
    }

    // ── Build response rows ──────────────────────────────────────────────
    const data = dayDocs.map((day) => {
      const entry = (day.employees || []).find((e) => e.biometricId === bid);
      // Priority: hrFinalStatus > promoted > systemPrediction
      const effectiveStatus =
        entry?.hrFinalStatus ||
        promotionMap.get(day.dateStr) ||
        entry?.systemPrediction ||
        null;
      return enrichEntry(entry, day, effectiveStatus);
    });

    // ── Summary ──────────────────────────────────────────────────────────
    const summary = data.reduce(
      (acc, d) => {
        const s = d.effectiveStatus;
        if (!s) return acc;
        if (["P", "P*", "P~"].includes(s)) acc.present++;
        else if (["AB", "LAB", "EAB"].includes(s)) acc.absent++;
        else if (s === "WO") acc.weekOff++;
        else if (["PH", "FH", "NH", "OH", "RH"].includes(s)) acc.holiday++;
        else if (s === "HD" || s === "LHD") acc.halfDay++;
        else if (["L-CL", "L-SL", "L-EL"].includes(s)) acc.onLeave++;
        else if (s === "LWP") acc.lwp++;
        else if (s === "MP") acc.missPunch++;
        else if (s === "WFH") acc.wfh++;
        if (s === "P*" || s === "LHD") acc.late++;
        acc.total++;
        return acc;
      },
      {
        present: 0,
        absent: 0,
        weekOff: 0,
        holiday: 0,
        halfDay: 0,
        onLeave: 0,
        lwp: 0,
        missPunch: 0,
        wfh: 0,
        late: 0,
        total: 0,
      },
    );

    res.json({ success: true, data, summary, yearMonth });
  } catch (err) {
    console.error("[ATT-MONTHLY]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  POST /sync-today
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/sync-today", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const { syncTodayOnly } = require("../HrRoutes/Attendance_section");
    if (typeof syncTodayOnly === "function") {
      const result = await syncTodayOnly();
      return res.json({
        success: true,
        message: result
          ? `Synced ${result.employees || 0} employees`
          : "Sync completed",
      });
    }
    res.json({ success: true, message: "Sync not available — data refreshed" });
  } catch (err) {
    console.error("[EMPLOYEE-SYNC]", err.message);
    res
      .status(500)
      .json({ success: false, message: "Sync failed. Try again." });
  }
});

module.exports = router;
