"use strict";

/**
 * /api/hr/overtime — HR's decision on overtime reports (13 Oct 2026, owner:
 * "when overtime is approved by the manager, HR should always be asked").
 *
 * The chain is now   pending ──manager approves──► awaiting_hr
 *                    awaiting_hr ──HR approves──► hr_approved + grace applied
 *                                ──HR rejects───► hr_rejected
 * The manager's approval applies nothing; HR's approval applies the grace to
 * the next day's attendance (applyOvertimeGrace, in the employee overtime
 * routes, so the rule lives in one place).
 *
 *   GET   /                 ?status=awaiting_hr|pending|hr_approved|…|all
 *                           &q=name/biometric id &page &limit — with counts
 *   PATCH /:id/hr-approve   { remarks }
 *   PATCH /:id/hr-reject    { rejectionReason }
 *
 * Declared in services/access/hrRouteContract.js; an editor's decision is
 * held for an approver like every other attendance overwrite ("/overtime" is
 * a sensitive path in services/approvalPolicy.js).
 */

const express = require("express");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");
const OvertimeReport = require("../../models/HR_Models/OvertimeReport");
const { recordChange } = require("../../services/changeLog");
const { notifyOvertimeApproved, notifyOvertimeRejected } = require("../../utils/notifyEmployee");

const router = express.Router();
const STATUSES = ["pending", "awaiting_hr", "manager_approved", "manager_rejected", "hr_approved", "hr_rejected", "expired"];
const HR_DECIDABLE = ["awaiting_hr", "pending", "manager_approved"];
const actor = (req) => req.user?.name || req.user?.email || "HR";
const label = (r) => [r?.employeeName || r?.biometricId, r?.dateStr].filter(Boolean).join(" - ");

router.get("/", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const status = STATUSES.includes(req.query.status) || req.query.status === "all" ? req.query.status : "awaiting_hr";
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const filter = {};
    if (status !== "all") filter.status = status;
    const q = String(req.query.q || "").trim();
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ employeeName: rx }, { biometricId: rx }, { department: rx }];
    }
    const [rows, total, counts] = await Promise.all([
      OvertimeReport.find(filter).sort({ dateStr: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      OvertimeReport.countDocuments(filter),
      OvertimeReport.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    const stats = { total: 0 };
    for (const c of counts) {
      stats[c._id] = c.n;
      stats.total += c.n;
    }
    res.json({ success: true, data: rows, total, page, limit, stats });
  } catch (e) {
    console.error("[hr/overtime]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.patch("/:id/hr-approve", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const report = await OvertimeReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: "Not found" });
    if (!HR_DECIDABLE.includes(report.status))
      return res.status(400).json({ success: false, code: "INVALID_TRANSITION", message: `Cannot approve — ${report.status}` });

    const before = report.status;
    report.status = "hr_approved";
    report.hrApprovedBy = req.user?.id;
    report.hrApprovedByName = actor(req);
    report.hrApprovedAt = new Date();
    report.hrRemarks = req.body?.remarks || "";
    const { applyOvertimeGrace } = require("../Employee_Routes/Overtimeroutes");
    await applyOvertimeGrace(report, actor(req));
    await report.save();

    recordChange(req, {
      departmentSlug: "hr",
      section: "hr:overtime",
      entity: "overtime",
      entityId: String(report._id),
      entityLabel: label(report),
      action: "approve",
      summary:
        `${actor(req)} gave HR approval to ${report.employeeName}'s overtime for ${report.dateStr}` +
        `${report.approvedByName ? ` (approved by ${report.approvedByName})` : ""}. ` +
        (report.graceApplied
          ? `${report.graceMinutes}min grace applied to ${report.nextDateStr}.`
          : report.graceMinutes > 0
            ? `The ${report.graceMinutes}min grace will apply when ${report.nextDateStr} is synced.`
            : "No grace was due.") +
        `${report.hrRemarks ? ` Remarks: ${report.hrRemarks}` : ""}`,
      before: { status: before },
      after: { status: "hr_approved", graceApplied: Boolean(report.graceApplied) },
    });
    notifyOvertimeApproved(report.employeeId, {
      body: report.graceApplied
        ? `Your overtime for ${report.dateStr} is approved. ${report.graceMinutes}min grace applied for ${report.nextDateStr}.`
        : `Your overtime for ${report.dateStr} is approved.`,
      reportId: report._id,
    });
    res.json({
      success: true,
      data: report,
      message: report.graceApplied
        ? `Approved. ${report.graceMinutes}min grace applied to ${report.nextDateStr}.`
        : report.graceMinutes > 0
          ? `Approved. The grace applies when ${report.nextDateStr} attendance syncs.`
          : "Approved.",
    });
  } catch (e) {
    console.error("[hr/overtime/approve]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.patch("/:id/hr-reject", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const report = await OvertimeReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: "Not found" });
    if (!HR_DECIDABLE.includes(report.status))
      return res.status(400).json({ success: false, code: "INVALID_TRANSITION", message: `Cannot reject — ${report.status}` });
    const reason = String(req.body?.rejectionReason || "").trim();
    if (!reason) return res.status(400).json({ success: false, message: "Give a reason for rejecting." });

    const before = report.status;
    report.status = "hr_rejected";
    report.rejectedBy = req.user?.id;
    report.rejectedByName = actor(req);
    report.rejectedAt = new Date();
    report.rejectionReason = reason;
    await report.save();

    recordChange(req, {
      departmentSlug: "hr",
      section: "hr:overtime",
      entity: "overtime",
      entityId: String(report._id),
      entityLabel: label(report),
      action: "reject",
      summary: `${actor(req)} rejected ${report.employeeName}'s overtime for ${report.dateStr}: ${reason}`,
      before: { status: before },
      after: { status: "hr_rejected", rejectionReason: reason },
    });
    notifyOvertimeRejected(report.employeeId, {
      body: `Your overtime for ${report.dateStr} was not approved: ${reason}`,
      reportId: report._id,
    });
    res.json({ success: true, data: report, message: "Rejected." });
  } catch (e) {
    console.error("[hr/overtime/reject]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
