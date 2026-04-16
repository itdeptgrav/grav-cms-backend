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

    // Earnings line items — show only non-zero, exclude food allowance per your rule
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
        { label: "ESIC", amount: d.esic || 0 },
        { label: "Professional Tax", amount: d.professionalTax || 0 },
        { label: "Income Tax (TDS)", amount: d.incomeTax || 0 },
        { label: "Loan Deduction", amount: d.loanDeduction || 0 },
        { label: "Advance Deduction", amount: d.advanceDeduction || 0 },
        { label: "Loss of Pay", amount: d.lopDeduction || 0 },
        { label: "Other Deductions", amount: d.otherDeductions || 0 },
    ].filter((r) => r.amount > 0);

    return {
        company: {
            name: "Grav Clothing",
            tagline: "GRAV CLOTHING LIMITED",
        },
        period: {
            month: item.month, year: item.year,
            label: `${MONTH_NAMES[item.month]} ${item.year}`,
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
            location: employee.workLocation || "Grav Clothing",
            department: employee.department || item.department || "",
            designation: employee.designation || employee.jobTitle || item.designation || "",
        },
        summary: {
            netPay: Math.round(item.roundedNetPay ?? item.netPay ?? 0),
            grossEarnings: Math.round(e.grossEarnings || 0),
            totalDeduction: Math.round(d.totalDeductions || 0),
            takeHomePay: Math.round(item.roundedNetPay ?? item.netPay ?? 0),
        },
        earnings: earningsLines,
        deductions: deductionsLines,
        status: item.status,
        paymentDate: item.paymentDate,
        processedAt: item.processedAt,
    };
}

// ── GET /employees  ─────────────────────────────────────────────────────────
router.get("/employees", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { search = "", department = "", limit = 50 } = req.query;
        const filter = { $or: [{ status: "active" }, { isActive: true }] };
        if (department && department !== "all") filter.department = department;
        if (search) {
            filter.$and = [
                {
                    $or: [
                        { firstName: { $regex: search, $options: "i" } },
                        { lastName: { $regex: search, $options: "i" } },
                        { biometricId: { $regex: search, $options: "i" } },
                        { designation: { $regex: search, $options: "i" } },
                    ],
                },
            ];
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

// ── GET /:employeeId  ───────────────────────────────────────────────────────
// Strict mode: requires a processed PayrollItem. Returns 404 otherwise with a
// clear message so the frontend can say "run payroll first".
router.get("/:employeeId", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        const { employeeId } = req.params;
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        const canAccess = user.role === "hr_manager" || user.id === employeeId;
        if (!canAccess) {
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
                message: `Payroll not yet processed for ${MONTH_NAMES[month]} ${year}. Please run payroll first.`,
                period: { month, year, label: `${MONTH_NAMES[month]} ${year}` },
            });
        }

        const payload = buildPayslipPayload(item, employee);
        res.json({ success: true, data: payload });
    } catch (err) {
        console.error("[PAYSLIP-GET]", err);
        if (err.name === "CastError") {
            return res.status(400).json({ success: false, message: "Invalid employee ID" });
        }
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── GET /:employeeId/history  ───────────────────────────────────────────────
router.get("/:employeeId/history", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        const { employeeId } = req.params;
        const canAccess = user.role === "hr_manager" || user.id === employeeId;
        if (!canAccess) return res.status(403).json({ success: false, message: "Access denied" });

        const items = await PayrollItem.find({ employeeId })
            .sort({ year: -1, month: -1 }).limit(24)
            .select("month year roundedNetPay netPay earnings.grossEarnings deductions.totalDeductions status paymentDate")
            .lean();

        const data = items.map((i) => ({
            month: i.month, year: i.year,
            label: `${MONTH_NAMES[i.month]} ${i.year}`,
            netPay: i.roundedNetPay || i.netPay,
            gross: i.earnings?.grossEarnings || 0,
            deductions: i.deductions?.totalDeductions || 0,
            status: i.status,
            paymentDate: i.paymentDate,
        }));

        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;