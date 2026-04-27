"use strict";
const express = require("express");
const router = express.Router();

const Employee = require("../../models/Employee");
const { PayrollItem } = require("../../models/HR_Models/Payroll");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");

const MONTH_NAMES = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

function fmtDate(d) {
    if (!d) return "";
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return "";
    return `${String(dt.getDate()).padStart(2, "0")}.${String(dt.getMonth() + 1).padStart(2, "0")}.${dt.getFullYear()}`;
}

function buildPayslipPayload(item, employee) {
    const fullName = [employee.firstName, employee.middleName, employee.lastName]
        .filter(Boolean).join(" ").trim();

    const e = item.earnings || {};
    const d = item.deductions || {};

    const earningsLines = [
        { label: "Basic Salary", amount: e.basicSalary || 0 },
        { label: "House Rent Allowance", amount: e.houseRentAllowance || 0 },
        { label: "Travel Allowance", amount: e.travelAllowance || 0 },
        { label: "Medical Allowance", amount: e.medicalAllowance || 0 },
        { label: "Special Allowance", amount: e.specialAllowance || 0 },
        { label: "Overtime", amount: e.overtime || 0 },
        { label: "Bonus", amount: e.bonus || 0 },
        { label: "Incentives", amount: e.incentives || 0 },
        { label: "Other Earnings", amount: e.otherEarnings || 0 },
    ].filter((r) => r.amount > 0);

    const deductionsLines = [
        { label: "Provident Fund", amount: d.providentFund || 0 },
        { label: "ESIC (Employee)", amount: d.esic || 0 },
        { label: "Income Tax (TDS)", amount: d.incomeTax || 0 },
        { label: "Loan Deduction", amount: d.loanDeduction || 0 },
        { label: "Advance Deduction", amount: d.advanceDeduction || 0 },
        { label: "Loss of Pay", amount: d.lopDeduction || 0 },
        { label: "Other Deductions", amount: d.otherDeductions || 0 },
    ].filter((r) => r.amount > 0);

    const payableDays = item.payableDays ?? item.presentDays ?? 0;
    const workingDays = item.workingDays ?? 31;
    const daysInMonth = item.daysInMonth ?? new Date(item.year, item.month, 0).getDate();

    return {
        company: {
            name: "Grav Clothing",
            tagline: "GRAV CLOTHING LIMITED",
            logoUrl: "../../grav-logo.png"
        },
        period: {
            month: item.month,
            year: item.year,
            label: `${MONTH_NAMES[item.month]} ${item.year}`
        },
        employee: {
            id: employee._id,
            name: fullName,
            empNo: employee.biometricId || employee.identityId || "",
            payPeriod: `${MONTH_NAMES[item.month]} ${item.year}`,
            doj: fmtDate(employee.dateOfJoining),
            dob: fmtDate(employee.dateOfBirth),
            bankName: employee.bankDetails?.bankName || item.bankDetails?.bankName || "",
            bankAccountNo: employee.bankDetails?.accountNumber || item.bankDetails?.accountNumber || "",
            panNo: employee.documents?.panNumber || "",
            pfNo: employee.documents?.pfNumber || "",
            uanNo: employee.documents?.uanNumber || "",
            esiNo: employee.documents?.esicNumber || "",
            department: employee.department || item.department || "",
            designation: employee.designation || employee.jobTitle || item.designation || "",
        },
        attendance: {
            payableDays,
            workingDays,
            daysInMonth,
            presentDays: item.presentDays || 0,
            absentDays: item.absentDays || 0,
            lopDays: item.lopDays || 0,
            paidLeaveDays: item.paidLeaveDays || 0,
        },
        summary: {
            grossEarnings: Math.round(e.grossEarnings || 0),
            totalDeduction: Math.round(d.totalDeductions || 0),
            netPay: Math.round(item.roundedNetPay ?? item.netPay ?? 0),
            takeHomePay: Math.round(item.roundedNetPay ?? item.netPay ?? 0),
        },
        employerContributions: {
            epf: d.employerPF || d.providentFund || 0,
            esic: d.employerESIC || 0,
        },
        earnings: earningsLines,
        deductions: deductionsLines,
        status: item.status,
        paymentDate: item.paymentDate,
        processedAt: item.processedAt,
    };
}

// ── GET /history - Get payslip history for employee ────────────────────────
router.get("/:employeeId/history", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        const { employeeId } = req.params;

        // Authorization check - only allow access to own payslips or HR
        if (user.role !== "hr_manager" && String(user.id) !== String(employeeId)) {
            return res.status(403).json({
                success: false,
                message: "Access denied - you can only view your own payslips"
            });
        }

        // ONLY show paid payslips to employees (not processed)
        const items = await PayrollItem.find({
            employeeId,
            status: "paid"  // Only paid payslips are visible
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

// ── GET /:employeeId - Get single payslip ──────────────────────────────────
router.get("/:employeeId", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        const { employeeId } = req.params;
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        // Authorization check
        if (user.role !== "hr_manager" && String(user.id) !== String(employeeId)) {
            return res.status(403).json({ success: false, message: "Access denied" });
        }

        const employee = await Employee.findById(employeeId)
            .select("-password -temporaryPassword -__v")
            .lean();

        if (!employee) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
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
            return res.status(400).json({
                success: false,
                message: "Invalid employee ID"
            });
        }
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── GET /employees - List employees (for HR dropdown in payslip generator) ──
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