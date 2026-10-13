// routes/Employee_Routes/Overtimeroutes.js
//
// COMPLETE FIXES:
//   1. Uses pushToken (not expoPushToken).
//   2. Notifications routed through utils/notifyEmployee.js (mobile + web in
//      one call). sendWebPush is NOT used here — it double-notified web users.
//   3. IST date helpers used everywhere.
//   4. Threshold-based stay-over detection.
//   5. Cron runs only 6:30 PM – 11:30 PM IST.
//   6. _otCronStarted guard makes startOvertimeReminders idempotent.
//   7. /check looks back 7 days, hides expired entries.
//   8. /my returns CURRENT MONTH ONLY.
//   9. /submit rejects if past 23:59 IST on the day the overtime was worked.
//  10. PERSISTENT NOTIFICATION DEDUP via OvertimeNotificationLog.
//      In-memory Map removed entirely. The cron tries to INSERT a dedup row
//      before sending — duplicate key error means "already notified", we skip.
//      Survives Render cold starts.
//
"use strict";

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const multer = require("multer");

const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");
const OvertimeNotificationLog = require("../../models/HR_Models/OvertimeNotificationLog");
const Employee = require("../../models/Employee");
const OvertimeReport = require("../../models/HR_Models/OvertimeReport");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const { uploadToGoogleDrive } = require("../../services/mediaUpload.service");
const { cctvProofUpload, storeCctvProof, CCTV_REQUIRED } = require("../../services/approvalProof");
const {
  dateStrIST,
  minsSinceMidnightIST,
} = require("../../utils/sendExpoPush");
// Notifications go through utils/notifyEmployee.js, which already fans out to
// BOTH the Expo native token and the FCM web token in a single call.
//
// The old `sendWebPushSafely` helper that used to live here has been removed:
// paired with sendExpoPush it hit the same fcmToken twice, so every web user
// got each overtime notification two times.
const {
  notifyOvertimeSubmitted,
  notifyOvertimeApproved,
  notifyOvertimeRejected,
  notifyOvertimeReminder,
} = require("../../utils/notifyEmployee");

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

/* AN OVERTIME REPORT HAS A FULL DAY TO BE FILED.
   ------------------------------------------------------------------------
   It closes at 23:59 on the day AFTER the one worked. The two earlier rules
   were both wrong at the ends: noon-the-following-day cut a night shift off
   mid-morning, and 23:59 on the night itself gave somebody who worked until
   22:00 about an hour, on their own time, on their own phone — and anyone
   who simply went home lost the report altogether while they slept.

   One clear day is the rule people can actually keep: work Monday night,
   file any time up to the end of Tuesday.

   APPROVAL IS NOT BOUNDED BY THIS, and never was — the approve and reject
   routes do not consult it. The person filing has a deadline because the
   hours have to be recorded while they can still be checked; the manager
   approving does not, because a report already filed is evidence that keeps.

   23:59:59.999 IST, not 23:59:00 — a report submitted at 23:59:30 is filed at
   11:59 PM by any reading a person would give it, and cutting it off
   thirty seconds earlier would be a rule nobody could see. */
const OT_CUTOFF_UTC_HOUR = 18; // 23:59 IST − 5:30 = 18:29 UTC
const OT_CUTOFF_UTC_MIN = 29;
const OT_CUTOFF_DAYS_AFTER = 1; // the day after the one worked

function isOvertimeExpired(dateStr) {
  if (!dateStr) return false;
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return false;
  /* Date.UTC normalises an overflowing day, so the last day of a month, of
     a year, and 29 February all roll to the right date without a branch. */
  const cutoffUtcMs = Date.UTC(
    y,
    m - 1,
    d + OT_CUTOFF_DAYS_AFTER,
    OT_CUTOFF_UTC_HOUR,
    OT_CUTOFF_UTC_MIN,
    59,
    999,
  );
  return Date.now() > cutoffUtcMs;
}

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
//  Looks back 7 days INCLUDING today. Skips submitted + expired.
// ════════════════════════════════════════════════════════════════════════════
/**
 * Apply an approved report's grace to the NEXT day's attendance (13 Oct 2026:
 * moved out of the manager route — HR's approval is what applies it now).
 * Sets report.graceApplied / graceAppliedAt; the caller saves the report.
 */
async function applyOvertimeGrace(report, approverName) {
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
            entry.hrRemarks = `Overtime grace: ${report.graceMinutes}min grace from OT on ${report.dateStr} (approved by ${approverName})`;
            console.log(
              `[OT-GRACE] ✓ ${report.employeeName}: Late ${lateByMins}min ≤ grace ${report.graceMinutes}min → PRESENT on ${report.nextDateStr}`,
            );
          } else if (wasLate && lateByMins > report.graceMinutes) {
            const adjustedLate = lateByMins - report.graceMinutes;
            entry.lateMins = adjustedLate;
            entry.lateAdjusted = true;
            entry.hrRemarks = `Overtime grace: ${report.graceMinutes}min grace, remaining late: ${adjustedLate}min (OT ${report.dateStr}, approved by ${approverName})`;
            console.log(
              `[OT-GRACE] ~ ${report.employeeName}: reduced to ${adjustedLate}min late on ${report.nextDateStr}`,
            );
          } else {
            entry.hrRemarks =
              (entry.hrRemarks || "") +
              ` | Overtime grace: ${report.graceMinutes}min from OT ${report.dateStr}`;
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

}

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

      if (isOvertimeExpired(dateStr)) continue;

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
//  GET /overtime/my — Employee history, CURRENT MONTH ONLY
// ════════════════════════════════════════════════════════════════════════════
router.get("/my", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const y = nowIst.getUTCFullYear();
    const m = String(nowIst.getUTCMonth() + 1).padStart(2, "0");
    const monthPrefix = `${y}-${m}`;

    const reports = await OvertimeReport.find({
      employeeId: req.user.id,
      dateStr: { $regex: `^${monthPrefix}` },
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, data: reports });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  POST /overtime/submit — Employee submits OT report
// ════════════════════════════════════════════════════════════════════════════
// Overtime history. Filed under HR even though every actor here is an employee
// or their manager: an approved overtime report grants grace on the next day's
// attendance, so it changes an HR record, and the person who later asks why a
// late arrival was not marked late works in HR.
const { recordChange } = require("../../services/changeLog");
const auditOvertime = (req, entry) =>
  recordChange(req, {
    departmentSlug: "hr",
    section: "hr:overtime",
    entity: "overtime",
    ...entry,
  });

/** "Ramesh Kumar - 2026-08-14" */
const otLabel = (r) =>
  [r?.employeeName || r?.biometricId, r?.dateStr].filter(Boolean).join(" - ");

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

      if (isOvertimeExpired(dateStr)) {
        return res.status(400).json({
          success: false,
          message:
            "This overtime report has expired — it has to be filed by 11:59 PM on the day after you worked it. Contact HR if you need an exception.",
        });
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

      // Lock the dedup log so even if the cron re-fires before the report
      // index propagates, the employee won't be re-notified.
      try {
        await OvertimeNotificationLog.updateOne(
          { employeeId: req.user.id, dateStr },
          { $setOnInsert: { sentAt: new Date() } },
          { upsert: true },
        );
      } catch (_) {}

      // ── Socket.IO notify managers ─────────────────────────────────────
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

      // ── Push to managers ──────────────────────────────────────────────
      const managerIds = managersNotified
        .map((m) => m.managerId)
        .filter(Boolean);
      if (managerIds.length > 0) {
        // O1 — managers. Fire-and-forget; the response no longer waits on it.
        notifyOvertimeSubmitted(managerIds, {
          employeeName: report.employeeName,
          dateStr,
          stayOverMins: stayOver.stayOverMins,
          graceMinutes: stayOver.graceMinutes,
          reportId: report._id,
        });

        report.notificationSentToManager = true;
        await report.save();
      }

      console.log(
        `[OVERTIME] ${report.employeeName} submitted for ${dateStr}: ${stayOver.stayOverMins}min extra, grace=${stayOver.graceMinutes}min`,
      );
      await auditOvertime(req, {
        entityId: String(report._id),
        entityLabel: otLabel(report),
        action: "create",
        summary:
          `${report.employeeName} reported working late on ${dateStr} — left at ` +
          `${report.actualOutTime} against a scheduled ${report.scheduledOutTime}, ` +
          `${stayOver.stayOverMins} minute(s) over. ` +
          (stayOver.graceMinutes > 0
            ? `If approved they may report by ${stayOver.adjustedReportTime} on ${report.nextDateStr} (${stayOver.graceMinutes}min grace).`
            : "No grace would follow from it.") +
          `${report.documentUrl ? " Proof was attached." : ""}`,
        after: {
          dateStr,
          actualOutTime: report.actualOutTime,
          scheduledOutTime: report.scheduledOutTime,
          stayOverMins: stayOver.stayOverMins,
          graceMinutes: stayOver.graceMinutes,
          nextDateStr: report.nextDateStr,
          adjustedReportTime: stayOver.adjustedReportTime,
          description,
          status: "pending",
        },
      });

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
    /* Every manager on an overtime report decides alone, so whoever approves
       hands it to HR — and must attach the CCTV proof (13 Oct 2026). */
    res.json({ success: true, data: reports.map((r) => ({ ...r, needsCctvProof: true })) });
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
  cctvProofUpload,
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

      /* CCTV proof is required from the approving manager (13 Oct 2026). */
      if (!req.file && !report.cctvProof?.url) return res.status(400).json(CCTV_REQUIRED);
      if (req.file) {
        report.cctvProof = await storeCctvProof(req.file, {
          prefix: "OT",
          who: report.employeeName,
          dateStr: report.dateStr,
          approverId: req.user.id,
          approverName: mgrName,
        });
      }

      /* 13 Oct 2026, owner: "HR should always ask for approval". The
         manager's approval no longer applies the grace — the report waits for
         HR (HR › Attendance › Overtime, routes/HrRoutes/Overtime_HR.js), and
         HR's approval is what applies it to the next day. */
      const beforeStatus = report.status;
      report.status = "awaiting_hr";
      report.approvedBy = req.user.id;
      report.approvedByName = mgrName;
      report.approvedAt = new Date();
      report.approvalRemarks = req.body?.remarks || "";
      await report.save();

      try {
        const io = req.app.get("io");
        if (io) {
          io.to(String(report.employeeId)).emit("overtime_notification", {
            type: "overtime_manager_approved",
            reportId: report._id.toString(),
            dateStr: report.dateStr,
            message: `Your overtime for ${report.dateStr} was approved by ${mgrName}. It now waits for the final approval.`,
          });
        }
      } catch (_) {}

      await auditOvertime(req, {
        entityId: String(report._id),
        entityLabel: otLabel(report),
        action: "approve",
        summary:
          `${mgrName} approved ${report.employeeName}'s overtime for ${report.dateStr} ` +
          `(${report.stayOverMins} minute(s) over) and attached the CCTV proof. It is with HR now — no grace is applied until HR approves.` +
          `${report.approvalRemarks ? ` Remarks: ${report.approvalRemarks}` : ""}`,
        before: { status: beforeStatus },
        after: { status: "awaiting_hr", approvedByName: mgrName, approvalRemarks: report.approvalRemarks || "" },
      });

      notifyOvertimeApproved(report.employeeId, {
        body: `Your overtime for ${report.dateStr} was approved by ${mgrName}. It now waits for the final approval.`,
        reportId: report._id,
      });

      res.json({
        success: true,
        data: report,
        message: "Approved. It now waits for the final approval.",
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

      const beforeStatus = report.status;
      report.status = "manager_rejected";
      report.rejectedBy = req.user.id;
      report.rejectedAt = new Date();
      report.rejectionReason = req.body.remarks || req.body.reason || "";
      await report.save();

      await auditOvertime(req, {
        entityId: String(report._id),
        entityLabel: otLabel(report),
        action: "reject",
        summary:
          `${mgrName} rejected ${report.employeeName}'s overtime for ${report.dateStr}. ` +
          `No grace was applied to ${report.nextDateStr}, so normal reporting time stands.` +
          `${report.rejectionReason ? ` Reason: ${report.rejectionReason}` : " No reason was given."}`,
        before: { status: beforeStatus },
        after: { status: "manager_rejected", rejectionReason: report.rejectionReason },
      });

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

      // O3 — employee. Fire-and-forget.
      notifyOvertimeRejected(report.employeeId, {
        body: `Your overtime report for ${report.dateStr} was not approved by ${mgrName}.${report.rejectionReason ? ` Reason: ${report.rejectionReason}` : ""}`,
        reportId: report._id,
      });

      res.json({ success: true, data: report, message: "Rejected" });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ════════════════════════════════════════════════════════════════════════════
//  detectAndNotifyStayOvers — called by the reminder cron.
//
//  PERSISTENT DEDUP via OvertimeNotificationLog:
//    Before sending each push, we try to INSERT a dedup row for
//    (employeeId, dateStr). The unique index guarantees the insert only
//    succeeds the FIRST time. Any subsequent attempt — same cron tick,
//    next tick, next day, after a server restart, anything — fails with
//    E11000 and we skip the push.
//
//    This is the fix for "the same OT reminder keeps firing" — that was
//    the in-memory Map getting wiped every time Render cold-started the
//    dyno. Now the dedup state is in Mongo and survives forever (well,
//    60 days — the TTL index purges old rows).
// ════════════════════════════════════════════════════════════════════════════
async function detectAndNotifyStayOvers(dateStr, io) {
  try {
    const dayDoc = await DailyAttendance.findOne({ dateStr }).lean();
    if (!dayDoc || !dayDoc.employees) return { checked: 0, notified: 0 };

    let notified = 0;
    let skippedExistingReport = 0;
    let skippedAlreadyNotified = 0;
    let skippedExpired = 0;

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

      const empType = resolveEmployeeType(emp);
      const threshold = PUNCH_THRESHOLDS[empType] ?? PUNCH_THRESHOLDS.executive;
      const punchCount = countPunches(entry);
      if (punchCount < threshold) continue;

      // Skip if a report already exists for this date
      const existing = await OvertimeReport.findOne({
        employeeId: emp._id,
        dateStr,
      })
        .select("_id")
        .lean();
      if (existing) {
        skippedExistingReport++;
        continue;
      }

      // Past the deadline (23:59 the day after) — pinging is pointless
      if (isOvertimeExpired(dateStr)) {
        skippedExpired++;
        continue;
      }

      // ── PERSISTENT DEDUP: claim the notification atomically ──
      // If create succeeds → we are the FIRST to notify for this
      // (employee, dateStr). Proceed with the push.
      // If create throws E11000 → another tick (or a past run) already
      // notified them. Skip silently.
      try {
        await OvertimeNotificationLog.create({
          employeeId: emp._id,
          dateStr,
        });
      } catch (e) {
        if (e.code === 11000) {
          skippedAlreadyNotified++;
          continue;
        }
        console.warn("[OT-DEDUP-LOG]", e.message);
        continue;
      }

      // We hold the lock. Send the push.
      const outTime = `${String(Math.floor(outMins / 60)).padStart(2, "0")}:${String(outMins % 60).padStart(2, "0")}`;
      try {
        // O4 — awaited on purpose: this runs in a cron, outside any request,
        // and the counter below needs the real send result.
        //
        // Two fixes here. The old call passed `categoryId: "overtime"`, which
        // is not a category the app registers, so the notification rendered
        // with no action buttons. And it tested `result.queued`, but the
        // return shape is `{ mobile: { queued } }` — always undefined, so
        // `notified` never incremented and the socket emit below never ran.
        const result = await notifyOvertimeReminder(emp._id, {
          outTime,
          dateStr,
        });

        if (result.mobile.queued > 0 || result.web.sent > 0) {
          notified++;
          if (io) {
            io.to(String(emp._id)).emit("overtime_notification", {
              type: "overtime_required",
              dateStr,
              actualOutTime: outTime,
              message: `Submit overtime report for ${dateStr} to get grace time`,
            });
          }
        }
      } catch (e) {
        // Push failed but dedup row is already in place. Acceptable — the
        // employee will see the pending card next time they open the app.
        console.warn("[OT-PUSH-FAIL]", e.message);
      }
    }

    if (
      notified > 0 ||
      skippedExistingReport > 0 ||
      skippedAlreadyNotified > 0
    ) {
      console.log(
        `[OT-REMIND] ${dateStr}: notified=${notified}, skipped_submitted=${skippedExistingReport}, skipped_already_notified=${skippedAlreadyNotified}, skipped_expired=${skippedExpired}`,
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
      // No more in-memory map to clear — dedup is in Mongo with a TTL index.
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
      /* Approved by HR (13 Oct 2026) or, before that, by a manager. */
      status: { $in: ["hr_approved", "manager_approved"] },
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
module.exports.applyOvertimeGrace = applyOvertimeGrace;
