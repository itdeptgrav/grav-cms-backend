"use strict";
const express = require("express");
const router = express.Router();

const Employee = require("../../models/Employee");
const { PayrollItem } = require("../../models/HR_Models/Payroll");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");
const { sendPayslipPdf } = require("../../services/payslipPdf.service");

// The payload builder is shared with the employee app's payslip route — see
// services/payslipPayload.service.js for why it stopped being local to each.
const {
    buildPayslipPayload,
    MONTH_NAMES,
} = require("../../services/payslipPayload.service");

router.get("/employees", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { search = "", department = "", limit = 50 } = req.query;
        const filter = { $or: [{ status: "active" }, { isActive: true }] };
        if (department && department !== "all") filter.department = department;
        if (search) {
            filter.$and = [{
                $or: [
                    { firstName: { $regex: search, $options: "i" } },
                    { lastName: { $regex: search, $options: "i" } },
                    { biometricId: { $regex: search, $options: "i" } },
                    { designation: { $regex: search, $options: "i" } },
                ],
            }];
        }
        const employees = await Employee.find(filter)
            .select("firstName middleName lastName biometricId identityId department designation jobTitle profilePhoto email")
            .sort({ firstName: 1 }).limit(Math.min(parseInt(limit), 200)).lean();
        const formatted = employees.map((e) => ({
            id: e._id, name: [e.firstName, e.lastName].filter(Boolean).join(" ").trim(),
            biometricId: e.biometricId || e.identityId || "", department: e.department || "",
            designation: e.designation || e.jobTitle || "", email: e.email || "",
            profilePhoto: e.profilePhoto?.url || null,
        }));
        res.json({ success: true, data: formatted, count: formatted.length });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /:employeeId/pdf — the payslip as a downloaded file ───────────────
//
// Before /:employeeId, or Express matches "pdf" as an employee id.
//
// Same renderer the employee app uses, so a payslip HR downloads and one the
// employee downloads are the same bytes rather than two documents that merely
// look alike. It also replaces the dashboard's "Download PDF" button, which
// called window.print() and downloaded nothing.
router.get("/:employeeId/pdf", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        const { employeeId } = req.params;
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();
        if (user.role !== "hr_manager" && user.id !== employeeId)
            return res.status(403).json({ success: false, message: "Access denied" });
        const employee = await Employee.findById(employeeId).select("-password -temporaryPassword -__v").lean();
        if (!employee) return res.status(404).json({ success: false, message: "Employee not found" });
        const item = await PayrollItem.findOne({ employeeId, month, year }).lean();
        if (!item) return res.status(404).json({
            success: false, code: "PAYROLL_NOT_RUN",
            message: `Payroll not yet processed for ${MONTH_NAMES[month]} ${year}. Please run payroll first.`,
        });
        await sendPayslipPdf(res, buildPayslipPayload(item, employee));
    } catch (err) {
        console.error("[HR-PAYSLIP-PDF]", err);
        if (err.name === "CastError") return res.status(400).json({ success: false, message: "Invalid employee ID" });
        /* THE RENDERER IS NOT AVAILABLE ON THIS SERVER.
           Chromium could not start — missing from the image, missing a shared
           library, or out of memory. That is not this request's fault and not
           something the caller can fix, but it IS something they can work
           around: every client carries the same payslip template and can
           render it locally.

           So it answers 503 with a code the clients look for, rather than the
           bare 500 that told them only that something had gone wrong. A 500 is
           reserved for a failure that a local render would hit too. */
        if (err?.rendererUnavailable) {
            return res.status(503).json({
                success: false,
                code: "PDF_RENDERER_UNAVAILABLE",
                message:
                    "The server could not render the PDF. Your device will produce it instead.",
            });
        }
        if (res.headersSent) return res.end();
        res.status(500).json({ success: false, message: "Could not build the payslip PDF" });
    }
});

router.get("/:employeeId", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        const { employeeId } = req.params;
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();
        if (user.role !== "hr_manager" && user.id !== employeeId)
            return res.status(403).json({ success: false, message: "Access denied" });
        const employee = await Employee.findById(employeeId).select("-password -temporaryPassword -__v").lean();
        if (!employee) return res.status(404).json({ success: false, message: "Employee not found" });
        const item = await PayrollItem.findOne({ employeeId, month, year }).lean();
        if (!item) return res.status(404).json({
            success: false, code: "PAYROLL_NOT_RUN",
            message: `Payroll not yet processed for ${MONTH_NAMES[month]} ${year}. Please run payroll first.`,
            period: { month, year, label: `${MONTH_NAMES[month]} ${year}` },
        });
        res.json({ success: true, data: buildPayslipPayload(item, employee) });
    } catch (err) {
        if (err.name === "CastError") return res.status(400).json({ success: false, message: "Invalid employee ID" });
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get("/:employeeId/history", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        const { employeeId } = req.params;
        if (user.role !== "hr_manager" && user.id !== employeeId)
            return res.status(403).json({ success: false, message: "Access denied" });
        const items = await PayrollItem.find({ employeeId })
            .sort({ year: -1, month: -1 }).limit(24)
            .select("month year roundedNetPay netPay earnings.grossEarnings deductions.totalDeductions status paymentDate").lean();
        res.json({
            success: true, data: items.map((i) => ({
                month: i.month, year: i.year, label: `${MONTH_NAMES[i.month]} ${i.year}`,
                netPay: i.roundedNetPay || i.netPay, gross: i.earnings?.grossEarnings || 0,
                deductions: i.deductions?.totalDeductions || 0, status: i.status, paymentDate: i.paymentDate,
            })),
        });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;