"use strict";
const express = require("express");
const router = express.Router();

const Employee = require("../../models/Employee");
const { PayrollItem } = require("../../models/HR_Models/Payroll");

// ★ FIX: Import BOTH middlewares
// AllEmployeeAppMiddleware works with cookie auth (used by mobile app)
// EmployeeAuthMiddlewear works with Authorization header (used by HR dashboard)
const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");
const { sendPayslipPdf } = require("../../services/payslipPdf.service");

// The payload builder is shared with the HR dashboard's payslip route. It used
// to be a second copy of the same function, and the two had drifted: this one
// headed the payslip "Grav Clothing" with a tagline and a logo path that
// resolved to nothing, while HR's said "Grav Clothing ( OPC ) Pvt Ltd".
// Employees were downloading a different document from the one HR saw.
const {
    buildPayslipPayload,
    MONTH_NAMES,
} = require("../../services/payslipPayload.service");

// ═══════════════════════════════════════════════════════════════════════════
//  ★ EMPLOYEE-FACING ROUTES — use AllEmployeeAppMiddleware (cookie auth)
//    This is what makes the mobile app work. The cookie-based middleware
//    accepts the employee_token cookie that the mobile app sends.
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /:employeeId/history — Payslip history ────────────────────────────
router.get("/:employeeId/history", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const { user } = req;
        const { employeeId } = req.params;

        // Authorization: employee can only see their own payslips
        if (user.role !== "hr_manager" && String(user.id) !== String(employeeId)) {
            return res.status(403).json({
                success: false,
                message: "Access denied - you can only view your own payslips"
            });
        }

        const items = await PayrollItem.find({
            employeeId,
            status: "paid"
        })
            .sort({ year: -1, month: -1 })
            .limit(24)
            .select("month year roundedNetPay netPay earnings.grossEarnings deductions.totalDeductions status paymentDate")
            .lean();

        res.json({
            success: true,
            data: items.map((i) => ({
                month: i.month,
                year: i.year,
                label: `${MONTH_NAMES[i.month]} ${i.year}`,
                netPay: i.roundedNetPay || i.netPay,
                gross: i.earnings?.grossEarnings || 0,
                deductions: i.deductions?.totalDeductions || 0,
                status: i.status,
                paymentDate: i.paymentDate,
            })),
        });
    } catch (err) {
        console.error("[PAYSLIP-HISTORY]", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── GET /:employeeId/pdf — the payslip as a downloaded file ───────────────
//
// Registered BEFORE /:employeeId so Express does not match "pdf" as an id.
//
// This exists so the download is a download. The clients used to build the PDF
// themselves: expo-print on Android and iOS, and on the web nothing at all —
// expo-print's web printToFileAsync is `window.print()`, so a browser could
// only ever offer a print dialog the user had to click through. One renderer
// here gives all three the same bytes and a real file.
router.get("/:employeeId/pdf", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const { user } = req;
        const { employeeId } = req.params;
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        // Same gate as the JSON route. Worth restating rather than sharing:
        // this one streams a finished document, so a mistake here hands one
        // employee another's salary rather than a payload they still have to
        // render.
        if (user.role !== "hr_manager" && String(user.id) !== String(employeeId)) {
            return res.status(403).json({ success: false, message: "Access denied" });
        }

        const employee = await Employee.findById(employeeId)
            .select("-password -temporaryPassword -__v")
            .lean();
        if (!employee) {
            return res.status(404).json({ success: false, message: "Employee not found" });
        }

        const item = await PayrollItem.findOne({ employeeId, month, year }).lean();
        if (!item) {
            return res.status(404).json({
                success: false,
                code: "PAYROLL_NOT_RUN",
                message: `Payroll not yet processed for ${MONTH_NAMES[month]} ${year}. Please contact HR.`,
            });
        }

        await sendPayslipPdf(res, buildPayslipPayload(item, employee));
    } catch (err) {
        console.error("[PAYSLIP-PDF]", err);
        if (err.name === "CastError") {
            return res.status(400).json({ success: false, message: "Invalid employee ID" });
        }
        // If the headers are already out the response is half a PDF; there is
        // nothing useful left to say, so just end it.
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

// ── GET /:employeeId — Single payslip with full details ───────────────────
router.get("/:employeeId", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const { user } = req;
        const { employeeId } = req.params;
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        if (user.role !== "hr_manager" && String(user.id) !== String(employeeId)) {
            return res.status(403).json({ success: false, message: "Access denied" });
        }

        const employee = await Employee.findById(employeeId)
            .select("-password -temporaryPassword -__v")
            .lean();

        if (!employee) {
            return res.status(404).json({ success: false, message: "Employee not found" });
        }

        const item = await PayrollItem.findOne({ employeeId, month, year }).lean();

        if (!item) {
            return res.status(404).json({
                success: false,
                code: "PAYROLL_NOT_RUN",
                message: `Payroll not yet processed for ${MONTH_NAMES[month]} ${year}. Please contact HR.`,
                period: { month, year, label: `${MONTH_NAMES[month]} ${year}` },
            });
        }

        res.json({ success: true, data: buildPayslipPayload(item, employee) });
    } catch (err) {
        console.error("[PAYSLIP-GET]", err);
        if (err.name === "CastError") {
            return res.status(400).json({ success: false, message: "Invalid employee ID" });
        }
        res.status(500).json({ success: false, message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  HR-ONLY ROUTE — keeps EmployeeAuthMiddlewear (Authorization header)
//  This is only used by the HR dashboard payslip generator dropdown.
// ═══════════════════════════════════════════════════════════════════════════

router.get("/employees", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { search = "", department = "", limit = 50 } = req.query;

        const filter = {
            $or: [{ status: "active" }, { isActive: true }]
        };

        if (department && department !== "all") {
            filter.department = department;
        }

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
            .sort({ firstName: 1 })
            .limit(Math.min(parseInt(limit), 200))
            .lean();

        const formatted = employees.map((e) => ({
            id: e._id,
            name: [e.firstName, e.lastName].filter(Boolean).join(" ").trim(),
            biometricId: e.biometricId || e.identityId || "",
            department: e.department || "",
            designation: e.designation || e.jobTitle || "",
            email: e.email || "",
            profilePhoto: e.profilePhoto?.url || null,
        }));

        res.json({ success: true, data: formatted, count: formatted.length });
    } catch (err) {
        console.error("[PAYSLIP-EMPLOYEES]", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;