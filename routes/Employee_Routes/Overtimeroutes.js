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

// ═══════════════════════════════════════════════════════════════════════════════
//  HELPER: Detect if employee stayed late
// ═══════════════════════════════════════════════════════════════════════════════
async function detectStayOver(biometricId, dateStr) {
  const dayDoc = await DailyAttendance.findOne({ dateStr }).lean();
  if (!dayDoc) return null;
  const entry = (dayDoc.employees || []).find(
    (e) => e.biometricId === biometricId,
  );
  if (!entry || !entry.finalOut) return null;

  const outDate = new Date(entry.finalOut);
  // Convert to IST (UTC+5:30) — Render runs in UTC
  const istOffset = 5.5 * 60; // minutes
  const utcMins = outDate.getUTCHours() * 60 + outDate.getUTCMinutes();
  const istMins = utcMins + istOffset;
  const outHour = Math.floor(istMins / 60) % 24;
  const outMin = Math.floor(istMins % 60);
  const outTotalMins = outHour * 60 + outMin;
  const scheduledOutMins = SCHEDULED_OUT_HOUR * 60 + SCHEDULED_OUT_MIN;
  if (outTotalMins < scheduledOutMins + MIN_STAY_OVER_MINS) return null;

  const stayOverMins = outTotalMins - scheduledOutMins;
  const actualOutTime = `${String(outHour).padStart(2, "0")}:${String(outMin).padStart(2, "0")}`;
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

// ═══════════════════════════════════════════════════════════════════════════════
//  GET /overtime/check — Employee checks pending OT reports
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/check", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const emp = await Employee.findById(req.user.id)
      .select("biometricId firstName lastName")
      .lean();
    if (!emp) return res.json({ success: true, data: [] });

    const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const dates = [];
    for (let i = 1; i <= 3; i++) {
      // Check last 3 days
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dates.push(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
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
      if (stayOver)
        pendingReports.push({
          dateStr,
          ...stayOver,
          employeeName: `${emp.firstName} ${emp.lastName}`,
        });
    }
    res.json({ success: true, data: pendingReports });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  GET /overtime/my — Employee's history
// ═══════════════════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════════════
//  POST /overtime/submit — Employee submits OT report
// ═══════════════════════════════════════════════════════════════════════════════
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
      if (!dateStr || !description)
        return res.status(400).json({
          success: false,
          message: "dateStr and description required",
        });

      const emp = await Employee.findById(req.user.id)
        .select(
          "firstName lastName biometricId designation department primaryManager secondaryManager",
        )
        .lean();
      if (!emp)
        return res
          .status(404)
          .json({ success: false, message: "Employee not found" });

      const existing = await OvertimeReport.findOne({
        employeeId: req.user.id,
        dateStr,
      });
      if (existing)
        return res
          .status(400)
          .json({ success: false, message: "Already submitted for this date" });

      const stayOver = await detectStayOver(emp.biometricId, dateStr);
      if (!stayOver)
        return res.status(400).json({
          success: false,
          message:
            "No eligible stay-over found. Must stay 1+ hour past 6:30 PM.",
        });

      let docData = {};
      if (req.file) {
        const fileName = `OT_${emp.firstName}_${dateStr}_${Date.now()}${req.file.originalname.includes(".") ? req.file.originalname.slice(req.file.originalname.lastIndexOf(".")) : ".pdf"}`;
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
      if (emp.primaryManager?.managerId)
        managersNotified.push({
          managerId: emp.primaryManager.managerId,
          managerName: emp.primaryManager.managerName || "",
          type: "primary",
        });
      if (emp.secondaryManager?.managerId)
        managersNotified.push({
          managerId: emp.secondaryManager.managerId,
          managerName: emp.secondaryManager.managerName || "",
          type: "secondary",
        });

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

      // Notify HOD
      try {
        const io = req.app.get("io");
        if (io && managersNotified.length > 0) {
          const primary = managersNotified.find((m) => m.type === "primary");
          if (primary?.managerId) {
            io.to(String(primary.managerId)).emit("overtime_notification", {
              type: "overtime_submitted",
              reportId: report._id.toString(),
              employeeName: report.employeeName,
              dateStr,
              stayOverMins: stayOver.stayOverMins,
              graceMinutes: stayOver.graceMinutes,
              message: `${report.employeeName} submitted overtime report for ${dateStr} (${Math.floor(stayOver.stayOverMins / 60)}h ${stayOver.stayOverMins % 60}m extra)`,
            });
          }
        }
      } catch (_) {}

      // Push to manager — with debug logging
      try {
        const { Expo } = require("expo-server-sdk");
        const expo = new Expo();
        const mgrId = emp.primaryManager?.managerId;
        console.log("[OT-PUSH] Manager ID:", mgrId);
        if (mgrId) {
          const mgr = await Employee.findById(mgrId)
            .select("expoPushToken pushToken firstName lastName")
            .lean();
          const token = mgr?.expoPushToken || mgr?.pushToken;
          console.log(
            "[OT-PUSH] Manager:",
            mgr?.firstName,
            mgr?.lastName,
            "Token:",
            token ? token.substring(0, 20) + "..." : "NO TOKEN",
          );
          if (token && Expo.isExpoPushToken(token)) {
            const result = await expo.sendPushNotificationsAsync([
              {
                to: token,
                title: "Overtime Report Submitted",
                body: `${report.employeeName} stayed late on ${dateStr}. Review and approve for ${stayOver.graceMinutes}min grace.`,
                data: {
                  type: "overtime_report",
                  reportId: report._id.toString(),
                  screen: "Overtime",
                },
                sound: "default",
                priority: "high",
              },
            ]);
            console.log("[OT-PUSH] ✓ Sent to manager:", JSON.stringify(result));
            report.notificationSentToManager = true;
            await report.save();
          } else {
            console.warn(
              "[OT-PUSH] ✗ Manager has no valid push token. They need to open the app first.",
            );
          }
        }
      } catch (e) {
        console.error("[OT-PUSH] ✗ Failed:", e.message);
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

// ═══════════════════════════════════════════════════════════════════════════════
//  GET /overtime/manager/pending
// ═══════════════════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════════════
//  PATCH /overtime/manager/:id/approve — HOD approves → ACTUALLY apply grace
//  FIX: Changes hrFinalStatus from Late → Present, label says "HOD overwrite"
// ═══════════════════════════════════════════════════════════════════════════════
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
      if (!report)
        return res
          .status(404)
          .json({ success: false, message: "Not found or already processed" });

      const mgr = await Employee.findById(req.user.id)
        .select("firstName lastName")
        .lean();
      const mgrName = mgr ? `${mgr.firstName} ${mgr.lastName}`.trim() : "HOD";

      report.status = "manager_approved";
      report.approvedBy = req.user.id;
      report.approvedByName = mgrName;
      report.approvedAt = new Date();
      report.approvalRemarks = req.body.remarks || "";

      // ══════════════════════════════════════════════════════════════════
      //  ACTUALLY APPLY GRACE to next day's attendance
      //  - Find the next day's record
      //  - If employee was late by ≤ graceMinutes → mark Present
      //  - Set hrFinalStatus = "P" (not just systemPrediction)
      //  - Label = "HOD overwrite" (not "HR overwrite")
      // ══════════════════════════════════════════════════════════════════
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

              // Store grace metadata
              entry.overtimeGraceMinutes = report.graceMinutes;
              entry.overtimeGraceFrom = report.dateStr;
              entry.overtimeReportId = report._id;

              // ── KEY FIX: Actually change status from Late to Present ──
              const wasLate =
                entry.isLate ||
                entry.systemPrediction === "LT" ||
                entry.systemPrediction === "L";
              const lateByMins = entry.lateMins || 0;

              if (wasLate && lateByMins <= report.graceMinutes) {
                // Grace covers the late — mark as PRESENT
                entry.isLate = false;
                entry.lateMins = 0;
                entry.lateAdjusted = true;
                entry.systemPrediction = "P";
                // ── KEY FIX: Set hrFinalStatus so it actually shows in HRMS ──
                entry.hrFinalStatus = "P";
                entry.hrReviewedAt = new Date();
                entry.hrRemarks = `HOD overwrite: ${report.graceMinutes}min grace from OT on ${report.dateStr} (approved by ${mgrName})`;

                console.log(
                  `[OT-GRACE] ✓ ${report.employeeName}: Late ${lateByMins}min ≤ grace ${report.graceMinutes}min → marked PRESENT on ${report.nextDateStr}`,
                );
              } else if (wasLate && lateByMins > report.graceMinutes) {
                // Grace partially covers — reduce late minutes
                const adjustedLate = lateByMins - report.graceMinutes;
                entry.lateMins = adjustedLate;
                entry.lateAdjusted = true;
                entry.hrRemarks = `HOD overwrite: ${report.graceMinutes}min grace applied, remaining late: ${adjustedLate}min (OT ${report.dateStr}, approved by ${mgrName})`;
                // Still late but with reduced minutes
                console.log(
                  `[OT-GRACE] ~ ${report.employeeName}: Late ${lateByMins}min > grace ${report.graceMinutes}min → reduced to ${adjustedLate}min late on ${report.nextDateStr}`,
                );
              } else {
                // Not late — just record grace was available
                entry.hrRemarks =
                  (entry.hrRemarks || "") +
                  ` | HOD grace: ${report.graceMinutes}min from OT ${report.dateStr}`;
                console.log(
                  `[OT-GRACE] ○ ${report.employeeName}: Not late on ${report.nextDateStr}, grace recorded`,
                );
              }

              // Mark the document as modified and save
              nextDay.markModified("employees");
              await nextDay.save();

              report.graceApplied = true;
              report.graceAppliedAt = new Date();
            } else {
              console.warn(
                `[OT-GRACE] Employee ${report.biometricId} not found in ${report.nextDateStr} attendance`,
              );
            }
          } else {
            console.warn(
              `[OT-GRACE] Attendance for ${report.nextDateStr} not synced yet — grace will be applied when day syncs`,
            );
          }
        } catch (e) {
          console.error("[OT-GRACE] Apply failed:", e.message);
        }
      }

      await report.save();

      // Notify employee
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
              ? `Overtime approved! ${report.graceMinutes}min grace applied to ${report.nextDateStr}. You're marked Present.`
              : `Overtime report for ${report.dateStr} approved.`,
          });
        }
      } catch (_) {}

      // Push to employee after approval
      try {
        const { Expo } = require("expo-server-sdk");
        const expo = new Expo();
        const empDoc = await Employee.findById(report.employeeId)
          .select("expoPushToken pushToken")
          .lean();
        const token = empDoc?.expoPushToken || empDoc?.pushToken;
        console.log(
          "[OT-PUSH] Employee token:",
          token ? token.substring(0, 20) + "..." : "NO TOKEN",
        );
        if (token && Expo.isExpoPushToken(token)) {
          await expo.sendPushNotificationsAsync([
            {
              to: token,
              title: "Overtime Approved ✓",
              body: report.graceApplied
                ? `${report.graceMinutes}min grace applied for ${report.nextDateStr}. Status: Present.`
                : `Your overtime report for ${report.dateStr} was approved.`,
              data: {
                type: "overtime_approved",
                reportId: report._id.toString(),
                screen: "Overtime",
              },
              sound: "default",
              priority: "high",
            },
          ]);
          console.log("[OT-PUSH] ✓ Sent approval notification to employee");
        }
      } catch (e) {
        console.error("[OT-PUSH] ✗ Approve notification failed:", e.message);
      }

      res.json({
        success: true,
        data: report,
        message: report.graceApplied
          ? `Approved by HOD. ${report.graceMinutes}min grace applied to ${report.nextDateStr} — employee marked Present.`
          : `Approved. Grace will apply when ${report.nextDateStr} attendance syncs.`,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
//  PATCH /overtime/manager/:id/reject
// ═══════════════════════════════════════════════════════════════════════════════
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
      if (!report)
        return res.status(404).json({ success: false, message: "Not found" });
      report.status = "manager_rejected";
      report.rejectedBy = req.user.id;
      report.rejectedAt = new Date();
      report.rejectionReason = req.body.remarks || req.body.reason || "";
      await report.save();
      try {
        const io = req.app.get("io");
        if (io)
          io.to(String(report.employeeId)).emit("overtime_notification", {
            type: "overtime_rejected",
            reportId: report._id.toString(),
            message: `Overtime report for ${report.dateStr} was not approved.`,
          });
      } catch (_) {}
      // Push
      try {
        const { Expo } = require("expo-server-sdk");
        const expo = new Expo();
        const empDoc = await Employee.findById(report.employeeId)
          .select("expoPushToken")
          .lean();
        if (
          empDoc?.expoPushToken &&
          Expo.isExpoPushToken(empDoc.expoPushToken)
        ) {
          await expo.sendPushNotificationsAsync([
            {
              to: empDoc.expoPushToken,
              title: "Overtime Report Rejected",
              body: `Your overtime report for ${report.dateStr} was not approved.${report.rejectionReason ? ` Reason: ${report.rejectionReason}` : ""}`,
              data: { type: "overtime_rejected", screen: "Overtime" },
              sound: "default",
            },
          ]);
        }
      } catch (e) {
        console.warn("[OT-PUSH]", e.message);
      }
      res.json({ success: true, data: report, message: "Rejected" });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPORTED: detectAndNotifyStayOvers — called by attendance cron
//  Sends PERSISTENT reminders at random 5/10/20 min intervals
// ═══════════════════════════════════════════════════════════════════════════════
async function detectAndNotifyStayOvers(dateStr, io) {
  try {
    const dayDoc = await DailyAttendance.findOne({ dateStr }).lean();
    if (!dayDoc || !dayDoc.employees) return { checked: 0, notified: 0 };

    let notified = 0;
    const scheduledOutMins = SCHEDULED_OUT_HOUR * 60 + SCHEDULED_OUT_MIN;

    for (const entry of dayDoc.employees) {
      if (!entry.finalOut || !entry.biometricId) continue;
      const outDate = new Date(entry.finalOut);
      const istOffset = 5.5 * 60;
      const outMins =
        outDate.getUTCHours() * 60 + outDate.getUTCMinutes() + istOffset;
      if (outMins < scheduledOutMins + MIN_STAY_OVER_MINS) continue;

      const emp = await Employee.findOne({ biometricId: entry.biometricId })
        .select("_id firstName lastName expoPushToken")
        .lean();
      if (!emp) continue;

      // Skip if already submitted
      const existing = await OvertimeReport.findOne({
        employeeId: emp._id,
        dateStr,
      });
      if (existing) continue;

      // Send push notification
      try {
        const { Expo } = require("expo-server-sdk");
        const expo = new Expo();
        if (emp.expoPushToken && Expo.isExpoPushToken(emp.expoPushToken)) {
          await expo.sendPushNotificationsAsync([
            {
              to: emp.expoPushToken,
              title: "⚠️ Overtime Report Pending",
              body: `You stayed until ${String(outDate.getHours()).padStart(2, "0")}:${String(outDate.getMinutes()).padStart(2, "0")} on ${dateStr}. Submit your report now to get grace time tomorrow.`,
              data: { type: "overtime_required", dateStr, screen: "Overtime" },
              sound: "default",
              categoryId: "overtime",
              priority: "high",
            },
          ]);
          notified++;
          console.log(
            `[OT-REMIND] Notified ${emp.firstName} ${emp.lastName} for ${dateStr}`,
          );
        }
      } catch (e) {
        console.warn("[OT-REMIND]", e.message);
      }

      // Socket notification
      if (io) {
        io.to(String(emp._id)).emit("overtime_notification", {
          type: "overtime_required",
          dateStr,
          actualOutTime: `${String(outDate.getHours()).padStart(2, "0")}:${String(outDate.getMinutes()).padStart(2, "0")}`,
          message: `Submit overtime report for ${dateStr} to get grace time`,
        });
      }
    }
    return { checked: dayDoc.employees.length, notified };
  } catch (e) {
    console.error("[OT-REMIND]", e);
    return { checked: 0, notified: 0, error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PERSISTENT REMINDER CRON — runs every 5-20 min randomly
//  Call startOvertimeReminders(io) from server.js after server starts
// ═══════════════════════════════════════════════════════════════════════════════
let reminderTimer = null;

function startOvertimeReminders(io) {
  async function remind() {
    try {
      const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000); // IST
      const hour = now.getUTCHours();

      // Only send reminders between 7 PM and 11 PM IST (13:30 - 17:30 UTC)
      if (hour >= 13 && hour <= 17) {
        const todayStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
        const result = await detectAndNotifyStayOvers(todayStr, io);
        if (result.notified > 0)
          console.log(`[OT-CRON] Reminded ${result.notified} employee(s)`);
      }

      // Also check yesterday for anyone who forgot
      const yesterday = new Date(now);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const yesterdayStr = `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, "0")}-${String(yesterday.getUTCDate()).padStart(2, "0")}`;
      if (hour >= 3 && hour <= 10) {
        // Morning IST
        await detectAndNotifyStayOvers(yesterdayStr, io);
      }
    } catch (e) {
      console.warn("[OT-CRON]", e.message);
    }

    // Schedule next check at random interval: 5, 10, 15, or 20 minutes
    const intervals = [5, 10, 15, 20];
    const nextMins = intervals[Math.floor(Math.random() * intervals.length)];
    reminderTimer = setTimeout(remind, nextMins * 60 * 1000);
    console.log(`[OT-CRON] Next reminder in ${nextMins} minutes`);
  }

  // Start first check after 2 minutes
  reminderTimer = setTimeout(remind, 2 * 60 * 1000);
  console.log("[OT-CRON] Overtime reminder cron started");
}

function stopOvertimeReminders() {
  if (reminderTimer) {
    clearTimeout(reminderTimer);
    reminderTimer = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  HOOK: Apply grace when attendance syncs (for late approvals)
//  Call this from Attendance_section after daily sync
// ═══════════════════════════════════════════════════════════════════════════════
async function applyPendingGrace(dateStr) {
  try {
    // Find approved reports whose nextDateStr matches today
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
        console.log(
          `[OT-SYNC] Grace applied for ${report.employeeName} on ${dateStr}`,
        );
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
