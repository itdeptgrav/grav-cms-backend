"use strict";
/**
 * routes/Employee_Routes/regularization.js
 * ───────────────────────────────────────────────────────────────────────────
 * Attendance regularization for the mobile app — employee side AND the
 * manager approval chain.
 *
 * Mount:
 *   const empRegularize = require("./routes/Employee_Routes/regularization");
 *   app.use("/api/employee/regularizations", empRegularize);
 *
 *   GET   /                          — the caller's own requests
 *   POST  /                          — raise one
 *   PATCH /:id/cancel                — withdraw own, while still pending
 *   GET   /manager/pending           — the caller's approval queue
 *   GET   /manager/history           — requests the caller has already decided
 *   PATCH /manager/:id/approve       — primary or secondary
 *   PATCH /manager/:id/reject        — primary or secondary
 *
 * ROUTE ORDER IS LOAD-BEARING: every /manager/* route is declared before any
 * /:id route, or Express matches "manager" as an :id.
 *
 * WHY A SEPARATE ROUTE FROM /hr/attendance/regularizations
 *
 * The HR routes already exist and the RegularizationRequest model is shared —
 * nothing here re-implements the domain. But those routes sit behind
 * EmployeeAuthMiddlewear, which authenticates CMS *department* users, while
 * the app authenticates with AllEmployeeAppMiddleware. An app token does not
 * authenticate against them at all.
 *
 * The authorization shape also differs: HR legitimately reads and files
 * against any employee, whereas an employee may only ever see and create
 * their own, and a manager only what they were notified about. Here the
 * subject comes from the verified token and there is no employeeId parameter
 * to tamper with.
 *
 * THE CHAIN
 *
 *   pending ──primary approves, secondary exists──► manager_approved
 *           ──primary approves, no secondary─────► hr_approved + applied
 *           ──primary rejects───────────────────► manager_rejected
 *           ──employee cancels──────────────────► cancelled
 *   manager_approved ──secondary approves───────► hr_approved + applied
 *                    ──secondary rejects────────► manager_rejected
 *
 * The secondary manager's approval is FINAL — it reaches hr_approved and
 * writes attendance. There is no separate HR step for app-filed requests.
 * This mirrors leave exactly (see leaveRoutes.js PATCH /manager/:id/approve),
 * and the stored status values are byte-identical to LeaveApplication's so the
 * app's one StatusTag map and the CMS filters keep working unchanged.
 *
 * There is no /manager/my-team here on purpose — the app already gates the
 * manager UI on /api/employee/leave-applications/manager/my-team.
 */

const express = require("express");
const router = express.Router();

const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");
const Employee = require("../../models/Employee");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const { RegularizationRequest } = require("../../models/HR_Models/LeaveManagement");
const { notifyEmployee } = require("../../utils/notifyEmployee");

const TYPES = ["miss_punch", "wrong_status", "forgot_punch", "client_visit", "other"];

/** Types where a punch time is the whole point of the request. */
const PUNCH_TYPES = ["miss_punch", "forgot_punch"];

/**
 * What an employee may ask a day to become. Every value is a member of
 * STATUS_ENUM in Dailyattendance.js. Leave codes, absence codes and rest codes
 * are deliberately absent — those move through the leave module or an HR
 * day-override, never through regularization.
 */
const ALLOWED_STATUS = ["P", "P*", "P~", "HD", "WFH", "CO"];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const OPEN_STATUSES = ["pending", "manager_approved"];
const DECIDED_STATUSES = [
  "hr_approved",
  "manager_rejected",
  "hr_rejected",
  "cancelled",
];

/**
 * Attendance_section is required lazily inside handlers, not at module load.
 * server.js mounts both routers and Attendance_section is a large module that
 * pulls in the whole attendance stack; deferring the require keeps the two
 * files from having to agree on boot order. Same pattern leaveRoutes.js uses
 * for applyLeaveToAttendance.
 */
function attendanceHelpers() {
  return require("../HrRoutes/Attendance_section");
}

const fullName = (emp) =>
  [emp?.firstName, emp?.middleName, emp?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

const firstNameOf = (name) => String(name || "").trim().split(/\s+/)[0] || "";

/**
 * Fire-and-forget: a failed notification must never fail the decision.
 *
 * Thin adapter onto utils/notifyEmployee.js — the one notification fan-out for
 * the whole HR domain. It validates the channel/category/screen against what
 * the app actually registers, dispatches on the next tick so the response is
 * never held up, and swallows every error.
 */
function notify(recipientIds, payload) {
  const { title, body, data = {}, channelId, categoryId } = payload || {};
  notifyEmployee(recipientIds, {
    title,
    body,
    kind: data.kind,
    screen: data.screen,
    id: data.id,
    channelId,
    categoryId,
  });
}

const pushData = (r) => ({
  kind: "regularization",
  screen: "Regularize",
  id: String(r._id),
});

// ═══════════════════════════════════════════════════════════════════════════
//  EMPLOYEE — read
// ═══════════════════════════════════════════════════════════════════════════

/** GET — the caller's own requests, newest first. */
router.get("/", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const employeeId = req.user?.id;
    if (!employeeId) {
      return res.status(401).json({ success: false, message: "Not authorized" });
    }

    const rows = await RegularizationRequest.find({ employeeId })
      .sort({ dateStr: -1, createdAt: -1 })
      .limit(50)
      .lean();

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[employee/regularizations GET]", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not load your requests" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  MANAGER — declared BEFORE /:id so "manager" is never read as an id
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /manager/pending — the caller's queue.
 *
 * Role and stage are paired inside each $or branch, so one endpoint serves
 * both approvers and neither ever sees an item that is not their turn: a
 * primary sees only `pending`, a secondary only `manager_approved`.
 */
router.get("/manager/pending", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const rows = await RegularizationRequest.find({
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
      .sort({ dateStr: -1, createdAt: -1 })
      .lean();

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[employee/regularizations manager/pending]", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not load your approval queue" });
  }
});

/** GET /manager/history — requests this manager was on that are now decided. */
router.get("/manager/history", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const rows = await RegularizationRequest.find({
      "managersNotified.managerId": req.user.id,
      status: { $in: DECIDED_STATUSES },
    })
      .sort({ dateStr: -1, createdAt: -1 })
      .limit(100)
      .lean();

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[employee/regularizations manager/history]", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not load your history" });
  }
});

/**
 * PATCH /manager/:id/approve — primary or secondary.
 *
 * A primary approving with a secondary present hands over. Every other
 * approval is FINAL: it reaches hr_approved and writes attendance through the
 * one shared applier.
 */
// Regularisations raised from the app share a history with the ones HR files
// from the Regularisations page — same section key, so one page shows the whole
// chain: the employee asked, the primary passed it on, the secondary approved,
// and whether it actually reached the attendance record.
const { recordChange } = require("../../services/changeLog");
const auditReg = (req, entry) =>
  recordChange(req, {
    departmentSlug: "hr",
    section: "hr:attendance-regularizations",
    entity: "regularization",
    ...entry,
  });

/** "Ramesh Kumar - 2026-08-14" */
const regLabel = (r) =>
  [r?.employeeName || r?.biometricId, r?.dateStr].filter(Boolean).join(" - ");

router.patch(
  "/manager/:id/approve",
  AllEmployeeAppMiddleware,
  async (req, res) => {
    try {
      const { remarks } = req.body || {};
      const myId = req.user.id;

      const r = await RegularizationRequest.findOne({
        _id: req.params.id,
        "managersNotified.managerId": myId,
      });
      if (!r)
        return res.status(404).json({ success: false, message: "Not found" });

      const mgr = r.managersNotified.find(
        (m) => String(m.managerId) === String(myId),
      );
      const mt = mgr?.type || "primary";

      // Stage-vs-role gate. A primary may not act on manager_approved; a
      // secondary may not jump ahead of the primary.
      /* A RETRY. An already-approved request whose apply never landed may be
         approved again: the decision has been made, the day is still wrong, and
         the applier is idempotent so a second attempt cannot double-punch it.
         Without this the only states were "worked" and "stuck forever". */
      const isRetry = r.status === "hr_approved" && !r.appliedToAttendance;

      if (!isRetry && mt === "primary" && r.status !== "pending")
        return res.status(400).json({
          success: false,
          code: "INVALID_TRANSITION",
          message: `Cannot approve — ${r.status}`,
        });
      if (!isRetry && mt === "secondary" && r.status !== "manager_approved")
        return res.status(400).json({
          success: false,
          code: "INVALID_TRANSITION",
          message: "Primary must approve first",
        });

      // Idempotent decision record — a double-tap must not stack two entries.
      if (!r.managerDecisions.find((d) => String(d.managerId) === String(myId)))
        r.managerDecisions.push({
          managerId: myId,
          managerName: mgr?.managerName || "",
          type: mt,
          decision: "approved",
          remarks: remarks || "",
          decidedAt: new Date(),
        });

      const hasSecondary = r.managersNotified.some(
        (m) => m.type === "secondary",
      );

      // ── Primary hands over to secondary ──────────────────────────────
      /* A retry goes straight to the apply — the approvals already happened
         and re-running them would re-notify everybody about a decision nobody
         took twice. */
      if (!isRetry && mt === "primary" && hasSecondary && r.status === "pending") {
        r.status = "manager_approved";
        await r.save();

        const secondary = r.managersNotified.find(
          (m) => m.type === "secondary",
        );
        notify(secondary?.managerId, {
          title: "Correction needs your approval",
          body: `${firstNameOf(mgr?.managerName)} approved ${firstNameOf(
            r.employeeName,
          )}'s correction for ${r.dateStr}. It's waiting on you.`,
          data: pushData(r),
          channelId: "general",
          categoryId: "general",
        });

        await auditReg(req, {
          entityId: String(r._id),
          entityLabel: regLabel(r),
          action: "approve",
          summary:
            `${mgr?.managerName || "The primary manager"} approved ${r.employeeName}'s ` +
            `correction for ${r.dateStr} and passed it to the secondary manager. ` +
            `Nothing has been applied to attendance yet.`,
          before: { status: "pending" },
          after: { status: "manager_approved" },
        });

        return res.json({
          success: true,
          data: r,
          message: "Primary approved. Awaiting secondary.",
        });
      }

      // ── FINAL APPROVAL ───────────────────────────────────────────────
      // hrApprovedBy is a ref to HRDepartment — a manager's Employee _id must
      // never go in it, which is what finalApprovedBy exists for.
      const beforeStatus = r.status;
      r.status = "hr_approved";
      r.finalApprovedBy = myId;
      r.finalApprovedByName = mgr?.managerName || "";
      r.hrApprovedAt = new Date();
      r.hrRemarks = remarks || "";

      const { applyRegularizationToAttendance } = attendanceHelpers();
      let applyRes = { applied: false, skipped: "applier_unavailable" };
      try {
        applyRes = await applyRegularizationToAttendance(r, {
          id: myId,
          name: mgr?.managerName || "Manager",
        });
      } catch (e) {
        // The decision stands even if the attendance write fails; leaving the
        // request half-approved would be worse than a day HR can re-apply.
        console.error("[REG-APPROVE-APPLY]", e.message);
        /* The MESSAGE, not just the word "apply_failed". Without it the history
           said a correction had failed and gave nobody a way to find out why,
           so the only remaining move was to guess. */
        applyRes = { applied: false, skipped: "apply_failed", error: e.message };
      }
      /* Recorded on the request itself, which is what makes a retry possible:
         "approved" alone cannot distinguish a correction that landed from one
         that did not. */
      r.appliedToAttendance = Boolean(applyRes.applied);
      if (applyRes.applied) r.appliedAt = new Date();
      r.applyError = applyRes.applied ? "" : (applyRes.error || applyRes.skipped || "");
      await r.save();

      // Approved and applied are two different facts. A request can be approved
      // and reach nothing — and the employee is then told their day was
      // corrected when it was not.
      await auditReg(req, {
        entityId: String(r._id),
        entityLabel: regLabel(r),
        /* `approve` only when it LANDED. Filing a failed apply as an approval
           is what put a green "Approved" badge above a sentence saying nothing
           had been applied — the badge and the text contradicting each other on
           the one screen people read to find out what happened. */
        action: applyRes.applied ? "approve" : "fail",
        critical: !applyRes.applied,
        summary: applyRes.applied
          ? `${mgr?.managerName || "A manager"} gave final approval to ${r.employeeName}'s ` +
            `correction for ${r.dateStr}` +
            `${r.requestedStatus ? ` (requested ${r.requestedStatus})` : ""}. ` +
            `Applied to the attendance record.` +
            `${r.hrRemarks ? ` Remarks: ${r.hrRemarks}` : ""}`
          : /* Leads with the outcome. "Approved, but nothing was applied" reads
               as a success with a caveat, and next to a green badge people took
               it for one. */
            `NOT applied — ${r.employeeName}'s correction for ${r.dateStr}` +
            `${r.requestedStatus ? ` (requested ${r.requestedStatus})` : ""} was ` +
            `approved by ${mgr?.managerName || "a manager"} but the attendance ` +
            `record was not changed: ${applyRes.error || applyRes.skipped}. ` +
            `The day is unchanged — approve it again to retry.` +
            `${r.hrRemarks ? ` Remarks: ${r.hrRemarks}` : ""}`,
        before: { status: beforeStatus },
        after: {
          status: "hr_approved",
          finalApprovedByName: r.finalApprovedByName,
          appliedToAttendance: Boolean(applyRes.applied),
          hrRemarks: r.hrRemarks || "",
        },
      });

      notify(r.employeeId, {
        title: applyRes.applied ? "Request approved" : "Approved — not applied yet",
        /* An employee told their day was corrected stops checking. If the write
           did not land, they need to know it is still wrong. */
        body: applyRes.applied
          ? `Your attendance for ${r.dateStr} has been corrected.`
          : `Your correction for ${r.dateStr} was approved but has not reached ` +
            `the attendance record yet. HR has been notified.`,
        data: pushData(r),
        channelId: "general",
        categoryId: "general",
      });

      return res.json({
        success: true,
        data: r,
        applied: applyRes.applied,
        skipped: applyRes.skipped,
        // The apply is the point of approving. A caller that only checks
        // `success` must not report this as done.
        applied: applyRes.applied,
        error: applyRes.error || "",
        message: applyRes.applied
          ? "Approved and applied to attendance"
          : `Approved, but the attendance record was NOT changed: ` +
            `${applyRes.error || applyRes.skipped}. Approve again to retry.`,
      });
    } catch (err) {
      console.error("[employee/regularizations manager approve]", err);
      return res
        .status(500)
        .json({ success: false, message: "Could not approve the request" });
    }
  },
);

/** PATCH /manager/:id/reject — primary or secondary. Never touches attendance. */
router.patch(
  "/manager/:id/reject",
  AllEmployeeAppMiddleware,
  async (req, res) => {
    try {
      const { rejectionReason } = req.body || {};
      const myId = req.user.id;

      const r = await RegularizationRequest.findOne({
        _id: req.params.id,
        "managersNotified.managerId": myId,
      });
      if (!r)
        return res.status(404).json({ success: false, message: "Not found" });

      if (!OPEN_STATUSES.includes(r.status))
        return res.status(400).json({
          success: false,
          code: "INVALID_TRANSITION",
          message: `Cannot reject — ${r.status}`,
        });

      const mgr = r.managersNotified.find(
        (m) => String(m.managerId) === String(myId),
      );
      const mt = mgr?.type || "primary";

      if (!r.managerDecisions.find((d) => String(d.managerId) === String(myId)))
        r.managerDecisions.push({
          managerId: myId,
          managerName: mgr?.managerName || "",
          type: mt,
          decision: "rejected",
          remarks: rejectionReason || "",
          decidedAt: new Date(),
        });

      const beforeRejectStatus = r.status;
      r.status = "manager_rejected";
      r.rejectedBy = myId;
      r.rejectedAt = new Date();
      r.rejectionReason = rejectionReason || "";
      await r.save();

      notify(r.employeeId, {
        title: "Request not approved",
        body: `Your correction request for ${r.dateStr} wasn't approved.${
          rejectionReason ? ` ${rejectionReason}` : ""
        }`,
        data: pushData(r),
        channelId: "general",
        categoryId: "general",
      });

      await auditReg(req, {
        entityId: String(r._id),
        entityLabel: regLabel(r),
        action: "reject",
        summary:
          `${mgr?.managerName || "A manager"} rejected ${r.employeeName}'s correction ` +
          `for ${r.dateStr}. The attendance record is unchanged.` +
          `${rejectionReason ? ` Reason: ${rejectionReason}` : " No reason was given."}`,
        before: { status: beforeRejectStatus },
        after: { status: "manager_rejected", rejectionReason: r.rejectionReason },
      });

      return res.json({ success: true, data: r, message: "Request rejected" });
    } catch (err) {
      console.error("[employee/regularizations manager reject]", err);
      return res
        .status(500)
        .json({ success: false, message: "Could not reject the request" });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
//  EMPLOYEE — write
// ═══════════════════════════════════════════════════════════════════════════

/** POST — raise a request for one date. */
router.post("/", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const employeeId = req.user?.id;
    if (!employeeId) {
      return res.status(401).json({ success: false, message: "Not authorized" });
    }

    const { dateStr, type, reason, inTime, outTime, requestedStatus } =
      req.body || {};

    // Validate before touching the database, and name the specific problem —
    // "Invalid request" tells the employee nothing about how to fix it.
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) {
      return res
        .status(400)
        .json({ success: false, message: "Pick a date to regularize." });
    }
    if (!TYPES.includes(type)) {
      return res
        .status(400)
        .json({ success: false, message: "Choose what went wrong with the punch." });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({
        success: false,
        message: "Add a short reason so your manager can approve it.",
      });
    }

    // A future date cannot have an attendance problem yet.
    const todayIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
    if (dateStr > todayIst) {
      return res
        .status(400)
        .json({ success: false, message: "That date hasn't happened yet." });
    }

    // ── Type-specific payload ────────────────────────────────────────────
    if (PUNCH_TYPES.includes(type) && !inTime && !outTime) {
      return res.status(400).json({
        success: false,
        code: "TIME_REQUIRED",
        message: "Add the IN time, the OUT time, or both.",
      });
    }
    if (inTime && !HHMM.test(String(inTime))) {
      return res.status(400).json({
        success: false,
        code: "BAD_TIME",
        message: "IN time must look like 09:30.",
      });
    }
    if (outTime && !HHMM.test(String(outTime))) {
      return res.status(400).json({
        success: false,
        code: "BAD_TIME",
        message: "OUT time must look like 18:00.",
      });
    }
    // Lexical compare is exact for zero-padded HH:mm.
    if (inTime && outTime && String(inTime) >= String(outTime)) {
      return res.status(400).json({
        success: false,
        code: "BAD_RANGE",
        message: "OUT time has to be after IN time.",
      });
    }
    if (type === "wrong_status") {
      if (!requestedStatus) {
        return res.status(400).json({
          success: false,
          code: "STATUS_REQUIRED",
          message: "Pick what the day should have been.",
        });
      }
      if (!ALLOWED_STATUS.includes(requestedStatus)) {
        return res.status(400).json({
          success: false,
          code: "BAD_STATUS",
          message: "That status can't be requested here.",
        });
      }
    } else if (requestedStatus && !ALLOWED_STATUS.includes(requestedStatus)) {
      return res.status(400).json({
        success: false,
        code: "BAD_STATUS",
        message: "That status can't be requested here.",
      });
    }

    const emp = await Employee.findById(employeeId)
      .select(
        "firstName middleName lastName biometricId department designation primaryManager secondaryManager",
      )
      .lean();
    if (!emp) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    // Without managersNotified nobody can ever see the request — every manager
    // queue in this codebase keys off managersNotified.managerId.
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
    if (mn.length === 0)
      return res.status(400).json({
        success: false,
        code: "NO_MANAGER",
        message: "No manager is assigned to you yet. Ask HR to set one.",
      });

    // One open request per date. Without this an employee can file the same
    // day repeatedly and flood their manager's queue.
    const existing = await RegularizationRequest.findOne({
      employeeId,
      dateStr,
      status: { $in: OPEN_STATUSES },
    }).lean();
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "You already have a request open for that date.",
      });
    }

    const bid = String(emp.biometricId || "").toUpperCase();

    // Freeze what the day looked like before the correction, so the CMS can
    // show a before/after and an audit can tell what actually changed. A
    // missing day doc is not a reason to block the submit.
    const snap = {
      inTime: null,
      finalOut: null,
      systemPrediction: null,
      hrFinalStatus: null,
      netWorkMins: 0,
      lateMins: 0,
      otMins: 0,
      punchCount: 0,
      rawPunches: [],
    };
    try {
      const dayDoc = await DailyAttendance.findOne({ dateStr }).lean();
      const entry = (dayDoc?.employees || []).find(
        (e) => e.biometricId === bid,
      );
      if (entry) {
        snap.inTime = entry.inTime || null;
        snap.finalOut = entry.finalOut || null;
        snap.systemPrediction = entry.systemPrediction || null;
        snap.hrFinalStatus = entry.hrFinalStatus || null;
        snap.netWorkMins = entry.netWorkMins || 0;
        snap.lateMins = entry.lateMins || 0;
        snap.otMins = entry.otMins || 0;
        snap.punchCount = entry.punchCount || 0;
        snap.rawPunches = entry.rawPunches || [];
      }
    } catch (e) {
      console.warn("[REG-SNAPSHOT]", e.message);
    }

    // "HH:mm" is materialised onto the day in IST here, once, so nothing
    // downstream has to guess what a bare time string meant.
    const { parseTimeOnDateIST } = attendanceHelpers();

    const doc = await RegularizationRequest.create({
      employeeId,
      biometricId: bid,
      employeeName: fullName(emp),
      designation: emp.designation,
      department: emp.department,
      dateStr,
      type,
      reason: String(reason).trim(),
      requestedStatus:
        type === "wrong_status" ? requestedStatus : requestedStatus || null,
      proposedInTime: inTime ? parseTimeOnDateIST(inTime, dateStr) : null,
      proposedOutTime: outTime ? parseTimeOnDateIST(outTime, dateStr) : null,
      // The singular-punch form is superseded by proposedInTime/proposedOutTime
      // on this path. The applier still honours it for legacy and HR-filed rows.
      proposedPunchType: null,
      proposedPunchTime: null,
      proposedPunchAction: null,
      managersNotified: mn,
      originalSnapshot: snap,
      status: "pending",
    });

    const primary = mn.find((m) => m.type === "primary");
    notify(primary?.managerId, {
      title: "Attendance correction request",
      body: `${firstNameOf(doc.employeeName)} asked to correct ${dateStr}. Reason: ${String(
        reason,
      ).trim()}`,
      data: pushData(doc),
      channelId: "general",
      categoryId: "general",
    });

    await auditReg(req, {
      entityId: String(doc._id),
      entityLabel: regLabel(doc),
      action: "create",
      summary:
        `${doc.employeeName} asked to correct their attendance for ${dateStr} ` +
        `(${type}${doc.requestedStatus ? `, requesting ${doc.requestedStatus}` : ""}). ` +
        (inTime || outTime
          ? `Proposed ${[inTime && `in ${inTime}`, outTime && `out ${outTime}`].filter(Boolean).join(", ")}. `
          : "") +
        `Reason: ${String(reason).trim()}. Waiting on ${primary?.managerName || "their manager"}.`,
      after: {
        dateStr,
        type,
        requestedStatus: doc.requestedStatus || null,
        proposedInTime: inTime || null,
        proposedOutTime: outTime || null,
        reason: String(reason).trim(),
        status: "pending",
      },
    });

    return res.status(201).json({ success: true, data: doc });
  } catch (err) {
    console.error("[employee/regularizations POST]", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not submit your request" });
  }
});

/** PATCH /:id/cancel — the employee withdraws their own, while still pending. */
router.patch("/:id/cancel", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const r = await RegularizationRequest.findOne({
      _id: req.params.id,
      employeeId: req.user.id,
    });
    if (!r)
      return res.status(404).json({ success: false, message: "Not found" });

    // Once a manager has acted the request is theirs to decide, not the
    // employee's to pull.
    if (r.status !== "pending")
      return res.status(400).json({
        success: false,
        code: "INVALID_TRANSITION",
        message: `Cannot cancel — ${r.status}`,
      });

    r.status = "cancelled";
    r.cancelledBy = req.user.id;
    r.cancelledAt = new Date();
    r.cancelReason = req.body?.reason || "";
    await r.save();

    await auditReg(req, {
      entityId: String(r._id),
      entityLabel: regLabel(r),
      action: "update",
      summary:
        `${r.employeeName} withdrew their own correction request for ${r.dateStr} ` +
        `before any manager decided it.` +
        `${r.cancelReason ? ` Reason: ${r.cancelReason}` : ""}`,
      before: { status: "pending" },
      after: { status: "cancelled", cancelReason: r.cancelReason },
    });

    return res.json({ success: true, data: r, message: "Request cancelled" });
  } catch (err) {
    console.error("[employee/regularizations cancel]", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not cancel your request" });
  }
});

module.exports = router;
