// routes/Employee_Routes/Overtimeroutes.js
//
// FIXES applied:
//   1. Uses `pushToken` (the real field), not `expoPushToken` (which never existed)
//   2. All notification logic goes through utils/sendExpoPush.js — the proven path
//   3. IST date helper used everywhere (no more "after midnight" bug)
//   4. Threshold-based detection per your spec:
//        - Operators (>=5 punches): notify if last punch after 6:30 PM
//        - Executives (>=2 punches): notify if last punch after 6:30 PM
//   5. Cron triggers between 6:30 PM and 11:30 PM IST only — no more random midnight spam
//   6. Logs are quieter — only when something actually happens
//
// ── PATCHES (May 2026) ──────────────────────────────────────────────────────
//   7. _otCronStarted guard — startOvertimeReminders() is now idempotent.
//      Even if Overtimeroutes.js gets require()d twice anywhere in the
//      project, the cron timer is only ever scheduled ONCE.
//
//   8. Web push alongside Expo push — added a small sendWebPushSafely()
//      helper that pings utils/sendWebPush.js (FCM Admin SDK). Mobile +
//      web users both receive notifications.
//
//   9. /check endpoint looks back 7 days (including today) so the "Submit
//      Report" card shows up whenever the cron has been firing notifications.
//
//  10. After submitting an OT report, the cron will NOT keep notifying.
//      The detectAndNotifyStayOvers loop already checks for an existing
//      OvertimeReport and skips. Added a console log so you can verify.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const multer = require("multer");

const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");
const Employee = require("../../models/Employee");
const OvertimeReport = require("../../models/HR_Models/OvertimeReport");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const { uploadToGoogleDrive } = require("../../services/mediaUpload.service");
const {
  sendExpoPush,
  dateStrIST,
  minsSinceMidnightIST,
} = require("../../utils/sendExpoPush");

// ── Web push helper (best-effort, never throws) ────────────────────────────
async function sendWebPushSafely(
  employeeIds,
  { title, body, type, url, extra },
) {
  try {
    const { sendWebPushToMany } = require("../../utils/sendWebPush");
    const ids = Array.isArray(employeeIds) ? employeeIds : [employeeIds];
    await sendWebPushToMany({
      employeeIds: ids.map((id) => String(id)).filter(Boolean),
      title,
      body,
      type,
      url,
      extra,
    });
  } catch (e) {
    console.warn("[OT-WEBPUSH]", e.message);
  }
}

const uploadMiddleware = multer({
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
    else cb(new Error("Only PDF, JPG, PNG or WEBP allowed."));
  },
}).single("document");

const SCHEDULED_OUT_HOUR = 18;
const SCHEDULED_OUT_MIN = 30;
const MIN_STAY_OVER_MINS = 60;
const SCHEDULED_OUT_TOTAL_MINS = SCHEDULED_OUT_HOUR * 60 + SCHEDULED_OUT_MIN;

const PUNCH_THRESHOLDS = {
  operator: 5,
  executive: 2,
};

// ════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════════════
function punchMinsIST(date) {
  const istMs = new Date(date).getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function punchTimeStrIST(date) {
  const istMs = new Date(date).getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  return `${String(ist.getUTCHours()).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")}`;
}

function countPunches(entry) {
  if (!entry) return 0;
  const candidates = [
    entry.inTime,
    entry.firstIn,
    entry.checkIn,
    entry.lunchOut,
    entry.lunchIn,
    entry.teaOut,
    entry.teaIn,
    entry.teaBreakOut,
    entry.teaBreakIn,
    entry.finalOut,
    entry.lastOut,
    entry.checkOut,
  ];
  return candidates.filter(Boolean).length;
}

function resolveEmployeeType(emp) {
  return emp?.employeeType || "executive";
}

async function detectStayOver(biometricId, dateStr) {
  const dayDoc = await DailyAttendance.findOne({ dateStr }).lean();
  if (!dayDoc) return null;
  const entry = (dayDoc.employees || []).find(
    (e) => e.biometricId === biometricId,
  );
  if (!entry || !entry.finalOut) return null;

  const outDate = new Date(entry.finalOut);
  const outTotalMins = punchMinsIST(outDate);

  if (outTotalMins < SCHEDULED_OUT_TOTAL_MINS + MIN_STAY_OVER_MINS) return null;

  const stayOverMins = outTotalMins - SCHEDULED_OUT_TOTAL_MINS;
  const actualOutTime = punchTimeStrIST(outDate);
  const { graceMinutes, adjustedReportTime } =
    OvertimeReport.calculateGrace(actualOutTime);
  const nextDateStr = OvertimeReport.getNextWorkingDay(dateStr);

  return {
    dateStr,
    nextDateStr,
    scheduledOutTime: `${String(SCHEDULED_OUT_HOUR).padStart(2, "0")}:${String(SCHEDULED_OUT_MIN).padStart(2, "0")}`,
    actualOutTime,
    actualOutDate: outDate,
    stayOverMins,
    graceMinutes,
    adjustedReportTime,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  GET /overtime/check — Employee checks pending OT reports
//  Looks back 7 days INCLUDING today so the submit card appears whenever
//  the cron has fired a notification.
// ════════════════════════════════════════════════════════════════════════════
router.get("/check", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const emp = await Employee.findById(req.user.id)
      .select("biometricId firstName lastName")
      .lean();
    if (!emp) return res.json({ success: true, data: [] });

    const dates = [];
    const baseDate = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    for (let i = 0; i <= 7; i++) {
      const d = new Date(baseDate);
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
      );
    }

    const pendingReports = [];
    for (const dateStr of dates) {
      const existing = await OvertimeReport.findOne({
        employeeId: req.user.id,
        dateStr,
      }).lean();
      if (existing) continue;
      const stayOver = await detectStayOver(emp.biometricId, dateStr);
      if (stayOver) {
        pendingReports.push({
          dateStr,
          ...stayOver,
          employeeName: `${emp.firstName} ${emp.lastName}`,
        });
      }
    }
    res.json({ success: true, data: pendingReports });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  GET /overtime/my — Employee's history
// ════════════════════════════════════════════════════════════════════════════
router.get("/my", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const reports = await OvertimeReport.find({ employeeId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    res.json({ success: true, data: reports });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  POST /overtime/submit — Employee submits OT report
// ════════════════════════════════════════════════════════════════════════════
router.post(
  "/submit",
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
      const { dateStr, description } = req.body;
      if (!dateStr || !description) {
        return res.status(400).json({
          success: false,
          message: "dateStr and description required",
        });
      }

      const emp = await Employee.findById(req.user.id)
        .select(
          "firstName lastName biometricId designation department primaryManager secondaryManager",
        )
        .lean();
      if (!emp) {
        return res
          .status(404)
          .json({ success: false, message: "Employee not found" });
      }

      const existing = await OvertimeReport.findOne({
        employeeId: req.user.id,
        dateStr,
      });
      if (existing) {
        return res
          .status(400)
          .json({ success: false, message: "Already submitted for this date" });
      }

      const stayOver = await detectStayOver(emp.biometricId, dateStr);
      if (!stayOver) {
        return res.status(400).json({
          success: false,
          message:
            "No eligible stay-over found. Must stay 1+ hour past 6:30 PM.",
        });
      }

      let docData = {};
      if (req.file) {
        const ext = req.file.originalname.includes(".")
          ? req.file.originalname.slice(req.file.originalname.lastIndexOf("."))
          : ".pdf";
        const fileName = `OT_${emp.firstName}_${dateStr}_${Date.now()}${ext}`;
        const driveResult = await uploadToGoogleDrive(req.file.buffer, {
          fileName,
          mimeType: req.file.mimetype,
        });
        docData = {
          documentUrl: driveResult.viewUrl || driveResult.url,
          documentFileId: driveResult.fileId,
          documentFileName: fileName,
          documentUploadedAt: new Date(),
        };
      }

      const managersNotified = [];
      if (emp.primaryManager?.managerId) {
        managersNotified.push({
          managerId: emp.primaryManager.managerId,
          managerName: emp.primaryManager.managerName || "",
          type: "primary",
        });
      }
      if (emp.secondaryManager?.managerId) {
        managersNotified.push({
          managerId: emp.secondaryManager.managerId,
          managerName: emp.secondaryManager.managerName || "",
          type: "secondary",
        });
      }

      const report = await OvertimeReport.create({
        employeeId: req.user.id,
        biometricId: emp.biometricId,
        employeeName: `${emp.firstName} ${emp.lastName}`.trim(),
        designation: emp.designation,
        department: emp.department,
        ...stayOver,
        description,
        ...docData,
        managersNotified,
        notificationSentToEmployee: true,
        status: "pending",
      });

      // Mark the employee as already notified for this date so the cron
      // does not nag them again in this process. Once the report exists,
      // the existing-report check at the top of the cron loop will also
      // skip them on next backend restart.
      notifiedToday.set(String(req.user.id), dateStr);

      // ── Socket.IO notify ──────────────────────────────────────────────
      try {
        const io = req.app.get("io");
        if (io && managersNotified.length > 0) {
          for (const m of managersNotified) {
            if (m.managerId) {
              io.to(String(m.managerId)).emit("overtime_notification", {
                type: "overtime_submitted",
                reportId: report._id.toString(),
                employeeName: report.employeeName,
                dateStr,
                stayOverMins: stayOver.stayOverMins,
                graceMinutes: stayOver.graceMinutes,
                message: `${report.employeeName} submitted overtime report for ${dateStr}`,
              });
            }
          }
        }
      } catch (_) {}

      // ── Push to managers via shared helpers ───────────────────────────
      const managerIds = managersNotified
        .map((m) => m.managerId)
        .filter(Boolean);
      if (managerIds.length > 0) {
        const hours = Math.floor(stayOver.stayOverMins / 60);
        const mins = stayOver.stayOverMins % 60;
        await sendExpoPush(managerIds, {
          title: "Overtime Report Submitted",
          body: `${report.employeeName} stayed late on ${dateStr} (${hours}h ${mins}m extra). Review and approve for ${stayOver.graceMinutes}min grace.`,
          data: {
            type: "overtime_report",
            reportId: report._id.toString(),
            screen: "Overtime",
          },
          channelId: "general",
        });
        await sendWebPushSafely(managerIds, {
          title: "Overtime Report Submitted",
          body: `${report.employeeName} stayed late on ${dateStr} (${hours}h ${mins}m extra). Review and approve for ${stayOver.graceMinutes}min grace.`,
          type: "overtime_required",
          url: "/overtime",
          extra: { reportId: String(report._id) },
        });

        report.notificationSentToManager = true;
        await report.save();
      }

      console.log(
        `[OVERTIME] ${report.employeeName} submitted for ${dateStr}: ${stayOver.stayOverMins}min extra, grace=${stayOver.graceMinutes}min`,
      );
      res.status(201).json({
        success: true,
        data: report,
        message: `Report submitted. ${stayOver.graceMinutes > 0 ? `If approved, ${stayOver.graceMinutes}min grace tomorrow (report by ${stayOver.adjustedReportTime}).` : ""}`,
      });
    } catch (err) {
      console.error("[OVERTIME]", err);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ════════════════════════════════════════════════════════════════════════════
//  GET /overtime/manager/pending
// ════════════════════════════════════════════════════════════════════════════
router.get("/manager/pending", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const reports = await OvertimeReport.find({
      "managersNotified.managerId": req.user.id,
      status: "pending",
    })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, data: reports });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  PATCH /overtime/manager/:id/approve — HOD approves → apply grace
// ════════════════════════════════════════════════════════════════════════════
router.patch(
  "/manager/:id/approve",
  AllEmployeeAppMiddleware,
  async (req, res) => {
    try {
      const report = await OvertimeReport.findOne({
        _id: req.params.id,
        "managersNotified.managerId": req.user.id,
        status: "pending",
      });
      if (!report) {
        return res
          .status(404)
          .json({ success: false, message: "Not found or already processed" });
      }

      const mgr = await Employee.findById(req.user.id)
        .select("firstName lastName")
        .lean();
      const mgrName = mgr ? `${mgr.firstName} ${mgr.lastName}`.trim() : "HOD";

      report.status = "manager_approved";
      report.approvedBy = req.user.id;
      report.approvedByName = mgrName;
      report.approvedAt = new Date();
      report.approvalRemarks = req.body.remarks || "";

      if (report.graceMinutes > 0 && report.nextDateStr) {
        try {
          const nextDay = await DailyAttendance.findOne({
            dateStr: report.nextDateStr,
          });
          if (nextDay) {
            const idx = (nextDay.employees || []).findIndex(
              (e) => e.biometricId === report.biometricId,
            );
            if (idx !== -1) {
              const entry = nextDay.employees[idx];
              entry.overtimeGraceMinutes = report.graceMinutes;
              entry.overtimeGraceFrom = report.dateStr;
              entry.overtimeReportId = report._id;

              const wasLate =
                entry.isLate ||
                entry.systemPrediction === "LT" ||
                entry.systemPrediction === "L";
              const lateByMins = entry.lateMins || 0;

              if (wasLate && lateByMins <= report.graceMinutes) {
                entry.isLate = false;
                entry.lateMins = 0;
                entry.lateAdjusted = true;
                entry.systemPrediction = "P";
                entry.hrFinalStatus = "P";
                entry.hrReviewedAt = new Date();
                entry.hrRemarks = `HOD overwrite: ${report.graceMinutes}min grace from OT on ${report.dateStr} (approved by ${mgrName})`;
                console.log(
                  `[OT-GRACE] ✓ ${report.employeeName}: Late ${lateByMins}min ≤ grace ${report.graceMinutes}min → PRESENT on ${report.nextDateStr}`,
                );
              } else if (wasLate && lateByMins > report.graceMinutes) {
                const adjustedLate = lateByMins - report.graceMinutes;
                entry.lateMins = adjustedLate;
                entry.lateAdjusted = true;
                entry.hrRemarks = `HOD overwrite: ${report.graceMinutes}min grace, remaining late: ${adjustedLate}min (OT ${report.dateStr}, approved by ${mgrName})`;
                console.log(
                  `[OT-GRACE] ~ ${report.employeeName}: reduced to ${adjustedLate}min late on ${report.nextDateStr}`,
                );
              } else {
                entry.hrRemarks =
                  (entry.hrRemarks || "") +
                  ` | HOD grace: ${report.graceMinutes}min from OT ${report.dateStr}`;
              }

              nextDay.markModified("employees");
              await nextDay.save();
              report.graceApplied = true;
              report.graceAppliedAt = new Date();
            }
          }
        } catch (e) {
          console.error("[OT-GRACE] Apply failed:", e.message);
        }
      }

      await report.save();

      try {
        const io = req.app.get("io");
        if (io) {
          io.to(String(report.employeeId)).emit("overtime_notification", {
            type: "overtime_approved",
            reportId: report._id.toString(),
            dateStr: report.dateStr,
            graceMinutes: report.graceMinutes,
            graceApplied: report.graceApplied,
            message: report.graceApplied
              ? `Overtime approved! ${report.graceMinutes}min grace applied to ${report.nextDateStr}.`
              : `Overtime report for ${report.dateStr} approved.`,
          });
        }
      } catch (_) {}

      await sendExpoPush(report.employeeId, {
        title: "Overtime Approved ✓",
        body: report.graceApplied
          ? `${report.graceMinutes}min grace applied for ${report.nextDateStr}. You're marked Present.`
          : `Your overtime report for ${report.dateStr} was approved by ${mgrName}.`,
        data: {
          type: "overtime_approved",
          reportId: report._id.toString(),
          screen: "Overtime",
        },
        channelId: "general",
      });
      await sendWebPushSafely(report.employeeId, {
        title: "Overtime Approved ✓",
        body: report.graceApplied
          ? `${report.graceMinutes}min grace applied for ${report.nextDateStr}. You're marked Present.`
          : `Your overtime report for ${report.dateStr} was approved by ${mgrName}.`,
        type: "overtime_approved",
        url: "/overtime",
        extra: { reportId: String(report._id) },
      });

      res.json({
        success: true,
        data: report,
        message: report.graceApplied
          ? `Approved by HOD. ${report.graceMinutes}min grace applied to ${report.nextDateStr}.`
          : `Approved. Grace will apply when ${report.nextDateStr} attendance syncs.`,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ════════════════════════════════════════════════════════════════════════════
//  PATCH /overtime/manager/:id/reject
// ════════════════════════════════════════════════════════════════════════════
router.patch(
  "/manager/:id/reject",
  AllEmployeeAppMiddleware,
  async (req, res) => {
    try {
      const report = await OvertimeReport.findOne({
        _id: req.params.id,
        "managersNotified.managerId": req.user.id,
        status: "pending",
      });
      if (!report) {
        return res.status(404).json({ success: false, message: "Not found" });
      }

      const mgr = await Employee.findById(req.user.id)
        .select("firstName lastName")
        .lean();
      const mgrName = mgr ? `${mgr.firstName} ${mgr.lastName}`.trim() : "HOD";

      report.status = "manager_rejected";
      report.rejectedBy = req.user.id;
      report.rejectedAt = new Date();
      report.rejectionReason = req.body.remarks || req.body.reason || "";
      await report.save();

      try {
        const io = req.app.get("io");
        if (io) {
          io.to(String(report.employeeId)).emit("overtime_notification", {
            type: "overtime_rejected",
            reportId: report._id.toString(),
            message: `Overtime report for ${report.dateStr} was not approved.`,
          });
        }
      } catch (_) {}

      await sendExpoPush(report.employeeId, {
        title: "Overtime Report Rejected",
        body: `Your overtime report for ${report.dateStr} was rejected by ${mgrName}.${report.rejectionReason ? ` Reason: ${report.rejectionReason}` : ""}`,
        data: {
          type: "overtime_rejected",
          reportId: report._id.toString(),
          screen: "Overtime",
        },
        channelId: "general",
      });
      await sendWebPushSafely(report.employeeId, {
        title: "Overtime Report Rejected",
        body: `Your overtime report for ${report.dateStr} was rejected by ${mgrName}.${report.rejectionReason ? ` Reason: ${report.rejectionReason}` : ""}`,
        type: "overtime_rejected",
        url: "/overtime",
        extra: { reportId: String(report._id) },
      });

      res.json({ success: true, data: report, message: "Rejected" });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ════════════════════════════════════════════════════════════════════════════
//  detectAndNotifyStayOvers — called by the reminder cron.
// ════════════════════════════════════════════════════════════════════════════
const notifiedToday = new Map(); // empId → dateStr

async function detectAndNotifyStayOvers(dateStr, io) {
  try {
    const dayDoc = await DailyAttendance.findOne({ dateStr }).lean();
    if (!dayDoc || !dayDoc.employees) return { checked: 0, notified: 0 };

    let notified = 0;
    let skippedDueToExistingReport = 0;
    const candidates = [];

    for (const entry of dayDoc.employees) {
      if (!entry.finalOut || !entry.biometricId) continue;

      const outMins = punchMinsIST(entry.finalOut);
      if (outMins < SCHEDULED_OUT_TOTAL_MINS + MIN_STAY_OVER_MINS) continue;

      const emp = await Employee.findOne({ biometricId: entry.biometricId })
        .select(
          "_id firstName lastName pushToken status isActive department designation",
        )
        .lean();
      if (!emp) continue;
      if (emp.status !== "active" && emp.isActive === false) continue;

      if (notifiedToday.get(emp._id.toString()) === dateStr) continue;

      const empType = resolveEmployeeType(emp);
      const threshold = PUNCH_THRESHOLDS[empType] ?? PUNCH_THRESHOLDS.executive;
      const punchCount = countPunches(entry);
      if (punchCount < threshold) continue;

      // ── Skip if an OT report already exists for this employee+date ──
      // This is the key check that prevents re-notifying after submission.
      const existing = await OvertimeReport.findOne({
        employeeId: emp._id,
        dateStr,
      });
      if (existing) {
        skippedDueToExistingReport++;
        // Also remember it so we don't re-query Mongo for them this session
        notifiedToday.set(emp._id.toString(), dateStr);
        continue;
      }

      candidates.push({ emp, outMins });
    }

    if (candidates.length === 0) {
      if (skippedDueToExistingReport > 0) {
        console.log(
          `[OT-REMIND] ${dateStr}: ${skippedDueToExistingReport} employee(s) already submitted — no notifications sent`,
        );
      }
      return { checked: dayDoc.employees.length, notified: 0 };
    }

    for (const { emp, outMins } of candidates) {
      const outTime = `${String(Math.floor(outMins / 60)).padStart(2, "0")}:${String(outMins % 60).padStart(2, "0")}`;
      const result = await sendExpoPush(emp._id, {
        title: "⚠️ Overtime Report Pending",
        body: `You stayed until ${outTime} on ${dateStr}. Submit your OT report to get grace time tomorrow.`,
        data: {
          type: "overtime_required",
          dateStr,
          screen: "Overtime",
        },
        channelId: "general",
        categoryId: "overtime",
      });
      await sendWebPushSafely(emp._id, {
        title: "⚠️ Overtime Report Pending",
        body: `You stayed until ${outTime} on ${dateStr}. Submit your OT report to get grace time tomorrow.`,
        type: "overtime_required",
        url: "/overtime",
        extra: { dateStr },
      });

      if (result.queued > 0) {
        notified++;
        notifiedToday.set(emp._id.toString(), dateStr);
        if (io) {
          io.to(String(emp._id)).emit("overtime_notification", {
            type: "overtime_required",
            dateStr,
            actualOutTime: outTime,
            message: `Submit overtime report for ${dateStr} to get grace time`,
          });
        }
      } else {
        notifiedToday.set(emp._id.toString(), dateStr);
      }
    }

    if (notified > 0) {
      console.log(
        `[OT-REMIND] Notified ${notified} employee(s) for ${dateStr}` +
          (skippedDueToExistingReport > 0
            ? ` (skipped ${skippedDueToExistingReport} with existing reports)`
            : ""),
      );
    }
    return { checked: dayDoc.employees.length, notified };
  } catch (e) {
    console.error("[OT-REMIND]", e);
    return { checked: 0, notified: 0, error: e.message };
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  REMINDER LOOP — runs every 10 minutes between 6:30 PM and 11:30 PM IST
// ════════════════════════════════════════════════════════════════════════════
let reminderTimer = null;
let _otCronStarted = false;
const REMINDER_INTERVAL_MS = 10 * 60 * 1000;
const REMINDER_WINDOW_START = 18 * 60 + 30; // 6:30 PM IST
const REMINDER_WINDOW_END = 23 * 60 + 30; // 11:30 PM IST

function startOvertimeReminders(io) {
  if (_otCronStarted) {
    console.log(
      "[OT-CRON] ⚠ Already started — skipping duplicate registration",
    );
    return;
  }
  _otCronStarted = true;

  async function tick() {
    try {
      const istMins = minsSinceMidnightIST();
      if (istMins >= REMINDER_WINDOW_START && istMins <= REMINDER_WINDOW_END) {
        const todayStr = dateStrIST();
        await detectAndNotifyStayOvers(todayStr, io);
      }
      if (istMins >= 0 && istMins <= 30) {
        notifiedToday.clear();
      }
    } catch (e) {
      console.warn("[OT-CRON] tick error:", e.message);
    }
    reminderTimer = setTimeout(tick, REMINDER_INTERVAL_MS);
  }

  reminderTimer = setTimeout(tick, 60 * 1000);
  console.log(
    "[OT-CRON] ✅ Overtime reminder loop started (6:30 PM – 11:30 PM IST, every 10 min)",
  );
}

function stopOvertimeReminders() {
  if (reminderTimer) {
    clearTimeout(reminderTimer);
    reminderTimer = null;
  }
  _otCronStarted = false;
}

// ════════════════════════════════════════════════════════════════════════════
//  applyPendingGrace
// ════════════════════════════════════════════════════════════════════════════
async function applyPendingGrace(dateStr) {
  try {
    const reports = await OvertimeReport.find({
      nextDateStr: dateStr,
      status: "manager_approved",
      graceApplied: false,
    });
    if (reports.length === 0) return { applied: 0 };

    let applied = 0;
    const dayDoc = await DailyAttendance.findOne({ dateStr });
    if (!dayDoc) return { applied: 0 };

    for (const report of reports) {
      const idx = (dayDoc.employees || []).findIndex(
        (e) => e.biometricId === report.biometricId,
      );
      if (idx === -1) continue;

      const entry = dayDoc.employees[idx];
      const wasLate =
        entry.isLate ||
        entry.systemPrediction === "LT" ||
        entry.systemPrediction === "L";
      const lateByMins = entry.lateMins || 0;

      if (wasLate && lateByMins <= report.graceMinutes) {
        entry.isLate = false;
        entry.lateMins = 0;
        entry.lateAdjusted = true;
        entry.systemPrediction = "P";
        entry.hrFinalStatus = "P";
        entry.hrReviewedAt = new Date();
        entry.hrRemarks = `HOD overwrite: ${report.graceMinutes}min grace from OT on ${report.dateStr} (approved by ${report.approvedByName})`;
        report.graceApplied = true;
        report.graceAppliedAt = new Date();
        await report.save();
        applied++;
      } else if (wasLate && lateByMins > report.graceMinutes) {
        entry.lateMins = lateByMins - report.graceMinutes;
        entry.lateAdjusted = true;
        entry.hrRemarks = `HOD overwrite: ${report.graceMinutes}min grace, remaining late: ${entry.lateMins}min`;
        report.graceApplied = true;
        report.graceAppliedAt = new Date();
        await report.save();
        applied++;
      }
    }

    if (applied > 0) {
      dayDoc.markModified("employees");
      await dayDoc.save();
      console.log(
        `[OT-SYNC] Applied ${applied} pending grace(s) for ${dateStr}`,
      );
    }
    return { applied };
  } catch (e) {
    console.error("[OT-SYNC]", e.message);
    return { applied: 0, error: e.message };
  }
}

router.detectAndNotifyStayOvers = detectAndNotifyStayOvers;
router.startOvertimeReminders = startOvertimeReminders;
router.stopOvertimeReminders = stopOvertimeReminders;
router.applyPendingGrace = applyPendingGrace;

module.exports = router;
