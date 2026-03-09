const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const { Payroll, PayrollItem } = require("../../models/HR_Models/Payroll");
const Employee = require("../../models/Employee");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");

const MONTH_NAMES = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Auto-calculate statutory deductions from basic & gross */
function calculateDeductions(basic, gross) {
    const pf = Math.round(basic * 0.12);           // Employee PF 12%
    const employerPF = Math.round(basic * 0.12);           // Employer PF 12%
    const esic = gross <= 21000 ? Math.round(gross * 0.0075) : 0;  // ESIC 0.75%
    const employerESIC = gross <= 21000 ? Math.round(gross * 0.0325) : 0;  // Employer ESIC 3.25%
    const professionalTax = basic > 15000 ? 200 : 0;           // Standard PT slab
    return { pf, employerPF, esic, employerESIC, professionalTax };
}

/** Build earnings breakdown from employee salary data */
function buildEarnings(employee, overrides = {}) {
    const basic = overrides.basicSalary ?? employee.salary?.basic ?? 0;
    const hra = overrides.hra ?? Math.round(basic * 0.40);
    const ta = overrides.ta ?? Math.round(basic * 0.10);
    const medic = overrides.medical ?? Math.round(basic * 0.05);
    const spec = overrides.special ?? Math.max(0, (employee.salary?.allowances ?? 0) - hra - ta - medic);
    const overtime = overrides.overtime ?? 0;
    const bonus = overrides.bonus ?? 0;
    const incentives = overrides.incentives ?? 0;
    const other = overrides.other ?? 0;

    const grossEarnings = basic + hra + ta + medic + spec + overtime + bonus + incentives + other;
    return {
        basicSalary: basic, houseRentAllowance: hra, travelAllowance: ta,
        medicalAllowance: medic, specialAllowance: spec, overtime, bonus,
        incentives, otherEarnings: other, grossEarnings
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /summary  →  Aggregated stats for dashboard cards
// ─────────────────────────────────────────────────────────────────────────────
router.get("/summary", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { month = new Date().getMonth() + 1, year = new Date().getFullYear() } = req.query;

        // Current month items
        const items = await PayrollItem.find({ month: +month, year: +year }).lean();

        // Previous month for comparison
        const prevMonth = +month === 1 ? 12 : +month - 1;
        const prevYear = +month === 1 ? +year - 1 : +year;
        const prevItems = await PayrollItem.find({ month: prevMonth, year: prevYear }).lean();

        const sum = (arr, field) => arr.reduce((s, i) => s + (i[field] || 0), 0);
        const sumNested = (arr, parent, child) =>
            arr.reduce((s, i) => s + ((i[parent] && i[parent][child]) || 0), 0);

        const currentNet = sumNested(items, "earnings", "grossEarnings") - sumNested(items, "deductions", "totalDeductions");
        const prevNet = sumNested(prevItems, "earnings", "grossEarnings") - sumNested(prevItems, "deductions", "totalDeductions");
        const changeNet = prevNet > 0 ? (((currentNet - prevNet) / prevNet) * 100).toFixed(1) : 0;

        const totalAllowances = items.reduce((s, i) => {
            const e = i.earnings || {};
            return s + (e.houseRentAllowance || 0) + (e.travelAllowance || 0) +
                (e.medicalAllowance || 0) + (e.specialAllowance || 0) + (e.otherEarnings || 0);
        }, 0);

        res.json({
            success: true,
            data: {
                totalNetPayroll: Math.round(currentNet),
                totalGross: Math.round(sumNested(items, "earnings", "grossEarnings")),
                totalAllowances: Math.round(totalAllowances),
                totalDeductions: Math.round(sumNested(items, "deductions", "totalDeductions")),
                totalPF: Math.round(sumNested(items, "deductions", "providentFund")),
                totalESIC: Math.round(sumNested(items, "deductions", "esic")),
                totalBonus: Math.round(sumNested(items, "earnings", "bonus")),
                totalOvertime: Math.round(sumNested(items, "earnings", "overtime")),
                totalIncentives: Math.round(sumNested(items, "earnings", "incentives")),
                employeeCount: items.length,
                processedCount: items.filter((i) => ["processed", "paid"].includes(i.status)).length,
                pendingCount: items.filter((i) => i.status === "pending").length,
                changeFromLastMonth: +changeNet,
                month: +month,
                year: +year,
            },
        });
    } catch (err) {
        console.error("Payroll summary error:", err);
        res.status(500).json({ success: false, message: "Error fetching payroll summary" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /trend  →  12-month trend for line chart
// ─────────────────────────────────────────────────────────────────────────────
router.get("/trend", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { year = new Date().getFullYear() } = req.query;

        const trend = await PayrollItem.aggregate([
            { $match: { year: +year } },
            {
                $group: {
                    _id: "$month",
                    gross: { $sum: "$earnings.grossEarnings" },
                    basic: { $sum: "$earnings.basicSalary" },
                    allowances: {
                        $sum: {
                            $add: [
                                "$earnings.houseRentAllowance",
                                "$earnings.travelAllowance",
                                "$earnings.medicalAllowance",
                                "$earnings.specialAllowance",
                                "$earnings.otherEarnings",
                            ],
                        },
                    },
                    deductions: { $sum: "$deductions.totalDeductions" },
                    overtime: { $sum: "$earnings.overtime" },
                    incentives: { $sum: "$earnings.incentives" },
                    bonus: { $sum: "$earnings.bonus" },
                    count: { $sum: 1 },
                },
            },
            { $sort: { _id: 1 } },
        ]);

        // Fill missing months with 0
        const filled = Array.from({ length: 12 }, (_, i) => {
            const found = trend.find((t) => t._id === i + 1);
            return {
                month: MONTH_NAMES[i + 1],
                monthNum: i + 1,
                gross: found?.gross || 0,
                basic: found?.basic || 0,
                allowances: found?.allowances || 0,
                deductions: found?.deductions || 0,
                overtime: found?.overtime || 0,
                incentives: found?.incentives || 0,
                bonus: found?.bonus || 0,
                count: found?.count || 0,
            };
        });

        res.json({ success: true, data: filled, year: +year });
    } catch (err) {
        console.error("Payroll trend error:", err);
        res.status(500).json({ success: false, message: "Error fetching payroll trend" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /department-breakdown  →  Bar chart data by dept
// ─────────────────────────────────────────────────────────────────────────────
router.get("/department-breakdown", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { month = new Date().getMonth() + 1, year = new Date().getFullYear() } = req.query;

        const data = await PayrollItem.aggregate([
            { $match: { month: +month, year: +year } },
            {
                $group: {
                    _id: "$department",
                    totalNet: { $sum: "$netPay" },
                    totalGross: { $sum: "$earnings.grossEarnings" },
                    totalBasic: { $sum: "$earnings.basicSalary" },
                    totalBonus: { $sum: "$earnings.bonus" },
                    totalPF: { $sum: "$deductions.providentFund" },
                    employeeCount: { $sum: 1 },
                    avgSalary: { $avg: "$netPay" },
                },
            },
            { $sort: { totalNet: -1 } },
        ]);

        res.json({ success: true, data });
    } catch (err) {
        console.error("Dept breakdown error:", err);
        res.status(500).json({ success: false, message: "Error fetching department breakdown" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET /list  →  Paginated payroll items list (main table)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/list", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const {
            month = new Date().getMonth() + 1,
            year = new Date().getFullYear(),
            page = 1,
            limit = 50,
            department,
            status,
            search,
        } = req.query;

        const filter = { month: +month, year: +year };
        if (department && department !== "All") filter.department = department;
        if (status && status !== "All") filter.status = status;
        if (search) {
            filter.$or = [
                { employeeName: { $regex: search, $options: "i" } },
                { biometricId: { $regex: search, $options: "i" } },
                { department: { $regex: search, $options: "i" } },
            ];
        }

        const skip = (+page - 1) * +limit;
        const total = await PayrollItem.countDocuments(filter);
        const items = await PayrollItem.find(filter)
            .populate("employeeId", "profilePhoto")
            .sort({ employeeName: 1 })
            .skip(skip)
            .limit(+limit)
            .lean();

        res.json({
            success: true,
            data: items,
            pagination: {
                total,
                page: +page,
                limit: +limit,
                totalPages: Math.ceil(total / +limit),
            },
        });
    } catch (err) {
        console.error("Payroll list error:", err);
        res.status(500).json({ success: false, message: "Error fetching payroll list" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. POST /generate  →  Auto-generate payroll for a month from Employee data
//    (Idempotent – skips employees already having a PayrollItem for that period)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/generate", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        const { month = new Date().getMonth() + 1, year = new Date().getFullYear() } = req.body;

        if (user.role !== "hr_manager") {
            return res.status(403).json({ success: false, message: "Only HR managers can generate payroll" });
        }

        // Upsert payroll run
        let payrollRun = await Payroll.findOne({ month: +month, year: +year });
        if (!payrollRun) {
            payrollRun = await Payroll.create({
                month: +month,
                year: +year,
                payPeriod: `${MONTH_NAMES[+month]} ${year}`,
                status: "processing",
                createdBy: user.id,
            });
        }

        // Fetch all active employees
        const employees = await Employee.find({ isActive: true, status: "active" })
            .select("firstName lastName biometricId department designation jobTitle employmentType salary bankDetails")
            .lean();

        let created = 0, skipped = 0;

        for (const emp of employees) {
            const exists = await PayrollItem.findOne({ employeeId: emp._id, month: +month, year: +year });
            if (exists) { skipped++; continue; }

            const basic = emp.salary?.basic || 0;
            const earnings = buildEarnings(emp);
            const { pf, employerPF, esic, employerESIC, professionalTax } = calculateDeductions(basic, earnings.grossEarnings);

            await PayrollItem.create({
                employeeId: emp._id,
                employeeName: `${emp.firstName} ${emp.lastName}`,
                biometricId: emp.biometricId,
                department: emp.department,
                designation: emp.designation,
                jobTitle: emp.jobTitle,
                employmentType: emp.employmentType,
                payrollId: payrollRun._id,
                month: +month,
                year: +year,
                payPeriod: `${MONTH_NAMES[+month]} ${year}`,
                earnings,
                deductions: {
                    providentFund: pf,
                    employerPF,
                    esic,
                    employerESIC,
                    professionalTax,
                    incomeTax: 0,
                    loanDeduction: 0,
                    advanceDeduction: 0,
                    lateDeduction: 0,
                    lopDeduction: 0,
                    otherDeductions: 0,
                },
                bankDetails: {
                    bankName: emp.bankDetails?.bankName,
                    accountNumber: emp.bankDetails?.accountNumber,
                    ifscCode: emp.bankDetails?.ifscCode,
                },
                status: "pending",
            });
            created++;
        }

        // Update payroll run summary
        const allItems = await PayrollItem.find({ payrollId: payrollRun._id }).lean();
        await Payroll.findByIdAndUpdate(payrollRun._id, {
            totalEmployees: allItems.length,
            totalGross: allItems.reduce((s, i) => s + (i.earnings?.grossEarnings || 0), 0),
            totalDeductions: allItems.reduce((s, i) => s + (i.deductions?.totalDeductions || 0), 0),
            totalNetPay: allItems.reduce((s, i) => s + (i.netPay || 0), 0),
            totalPF: allItems.reduce((s, i) => s + (i.deductions?.providentFund || 0), 0),
            totalESIC: allItems.reduce((s, i) => s + (i.deductions?.esic || 0), 0),
            status: "processed",
            processedAt: new Date(),
        });

        res.status(201).json({
            success: true,
            message: `Payroll generated: ${created} created, ${skipped} already existed`,
            data: { payrollId: payrollRun._id, created, skipped, total: allItems.length },
        });
    } catch (err) {
        console.error("Generate payroll error:", err);
        res.status(500).json({ success: false, message: "Error generating payroll", error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. PATCH /item/:id/status  →  Mark individual employee payroll as paid/hold
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/item/:id/status", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        const { status, transactionId, paymentDate, remarks } = req.body;

        if (user.role !== "hr_manager") {
            return res.status(403).json({ success: false, message: "Only HR managers can update payroll status" });
        }

        const validStatuses = ["pending", "processed", "paid", "failed", "on_hold"];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid status" });
        }

        const update = { status, remarks };
        if (status === "paid") {
            update.paymentDate = paymentDate || new Date();
            update.transactionId = transactionId;
            update.processedBy = user.id;
            update.processedAt = new Date();
        }

        const item = await PayrollItem.findByIdAndUpdate(req.params.id, update, { new: true });
        if (!item) return res.status(404).json({ success: false, message: "Payroll item not found" });

        res.json({ success: true, message: "Status updated", data: item });
    } catch (err) {
        console.error("Update item status error:", err);
        res.status(500).json({ success: false, message: "Error updating status" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. PATCH /bulk-process  →  Mark all pending as processed in one go
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/bulk-process", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        const { month = new Date().getMonth() + 1, year = new Date().getFullYear(), department } = req.body;

        if (user.role !== "hr_manager") {
            return res.status(403).json({ success: false, message: "Only HR managers can process payroll" });
        }

        const filter = { month: +month, year: +year, status: "pending" };
        if (department && department !== "All") filter.department = department;

        const result = await PayrollItem.updateMany(filter, {
            status: "processed",
            processedBy: user.id,
            processedAt: new Date(),
        });

        res.json({
            success: true,
            message: `${result.modifiedCount} payroll items marked as processed`,
            data: { modified: result.modifiedCount },
        });
    } catch (err) {
        console.error("Bulk process error:", err);
        res.status(500).json({ success: false, message: "Error bulk processing payroll" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. PATCH /bulk-pay  →  Mark all processed as paid (after bank transfer)
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/bulk-pay", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        const { month = new Date().getMonth() + 1, year = new Date().getFullYear() } = req.body;

        if (user.role !== "hr_manager") {
            return res.status(403).json({ success: false, message: "Only HR managers can mark payroll as paid" });
        }

        const result = await PayrollItem.updateMany(
            { month: +month, year: +year, status: "processed" },
            { status: "paid", paymentDate: new Date(), processedBy: user.id, processedAt: new Date() }
        );

        // Update parent payroll run
        const payrollRun = await Payroll.findOne({ month: +month, year: +year });
        if (payrollRun) {
            await payrollRun.updateOne({ status: "paid" });
        }

        res.json({ success: true, message: `${result.modifiedCount} employees marked as paid`, data: { modified: result.modifiedCount } });
    } catch (err) {
        console.error("Bulk pay error:", err);
        res.status(500).json({ success: false, message: "Error marking payroll as paid" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. PUT /item/:id  →  Edit individual payroll item (override earnings/deductions)
// ─────────────────────────────────────────────────────────────────────────────
router.put("/item/:id", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        if (user.role !== "hr_manager") {
            return res.status(403).json({ success: false, message: "Only HR managers can edit payroll" });
        }

        const allowed = ["earnings", "deductions", "workingDays", "presentDays", "absentDays", "lopDays", "remarks"];
        const update = {};
        allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

        const item = await PayrollItem.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
        if (!item) return res.status(404).json({ success: false, message: "Payroll item not found" });

        res.json({ success: true, message: "Payroll item updated", data: item });
    } catch (err) {
        console.error("Update payroll item error:", err);
        res.status(500).json({ success: false, message: "Error updating payroll item" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. GET /payslip/:employeeId  →  Get payslip for specific employee & month
// ─────────────────────────────────────────────────────────────────────────────
router.get("/payslip/:employeeId", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { month = new Date().getMonth() + 1, year = new Date().getFullYear() } = req.query;

        // Allow HR or the employee themselves
        const canAccess =
            req.user.role === "hr_manager" ||
            req.user.id === req.params.employeeId;

        if (!canAccess) {
            return res.status(403).json({ success: false, message: "Access denied" });
        }

        const item = await PayrollItem.findOne({
            employeeId: req.params.employeeId,
            month: +month,
            year: +year,
        })
            .populate("employeeId", "firstName lastName profilePhoto email phone address dateOfJoining employmentType")
            .lean();

        if (!item) {
            return res.status(404).json({
                success: false,
                message: `No payslip found for this employee for ${MONTH_NAMES[+month]} ${year}`,
            });
        }

        res.json({ success: true, data: item });
    } catch (err) {
        console.error("Get payslip error:", err);
        res.status(500).json({ success: false, message: "Error fetching payslip" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. GET /history/:employeeId  →  12-month salary history for an employee
// ─────────────────────────────────────────────────────────────────────────────
router.get("/history/:employeeId", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const canAccess =
            req.user.role === "hr_manager" ||
            req.user.id === req.params.employeeId;

        if (!canAccess) return res.status(403).json({ success: false, message: "Access denied" });

        const items = await PayrollItem.find({ employeeId: req.params.employeeId })
            .sort({ year: -1, month: -1 })
            .limit(12)
            .select("month year netPay earnings deductions status paymentDate payPeriod")
            .lean();

        res.json({ success: true, data: items });
    } catch (err) {
        console.error("Get history error:", err);
        res.status(500).json({ success: false, message: "Error fetching salary history" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. GET /runs  →  All payroll runs (for payroll run history tab)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/runs", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const runs = await Payroll.find()
            .sort({ year: -1, month: -1 })
            .limit(24)
            .populate("createdBy", "name email")
            .lean();

        res.json({ success: true, data: runs });
    } catch (err) {
        console.error("Get runs error:", err);
        res.status(500).json({ success: false, message: "Error fetching payroll runs" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. DELETE /item/:id  →  Remove a payroll item (if still pending)
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/item/:id", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        if (user.role !== "hr_manager") {
            return res.status(403).json({ success: false, message: "Only HR managers can delete payroll items" });
        }

        const item = await PayrollItem.findById(req.params.id);
        if (!item) return res.status(404).json({ success: false, message: "Payroll item not found" });

        if (["paid", "processed"].includes(item.status)) {
            return res.status(400).json({ success: false, message: "Cannot delete a processed/paid payroll item" });
        }

        await item.deleteOne();
        res.json({ success: true, message: "Payroll item deleted" });
    } catch (err) {
        console.error("Delete payroll item error:", err);
        res.status(500).json({ success: false, message: "Error deleting payroll item" });
    }
});

module.exports = router;