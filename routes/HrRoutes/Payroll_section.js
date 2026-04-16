"use strict";
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const { Payroll, PayrollItem } = require("../../models/HR_Models/Payroll");
const PayrollSettings = require("../../models/HR_Models/PayrollSettings");
const Employee = require("../../models/Employee");
const SalaryConfig = require("../../models/Salaryconfig");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const { CompanyHoliday, LeaveBalance, LeaveConfig } =
    require("../../models/HR_Models/LeaveManagement");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");

const MONTH_NAMES = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

const PAID_CODES = new Set([
    "P", "P*", "P~", "MP", "WO", "FH", "NH", "OH", "RH", "PH",
    "L-CL", "L-SL", "L-EL", "WFH", "CO",
]);
const LEAVE_CODES_PAID = new Set(["L-CL", "L-SL", "L-EL"]);
const HOLIDAY_CODES = new Set(["FH", "NH", "OH", "RH", "PH"]);

const HOLIDAY_TYPE_TO_CODE = {
    national: "NH", company: "FH", optional: "OH", restricted: "RH",
};

// ═════════════════════════════════════════════════════════════════════════════
//  ENGINE — computes payroll for a single employee for a given month
// ═════════════════════════════════════════════════════════════════════════════

/**
 * @param {Object} employee  — Employee document
 * @param {Object} ctx       — shared context { month, year, settings, salaryCfg, holidayMap, attendanceByDate, leaveBalance }
 * @returns {Object}         — full computed payroll payload for this employee
 */
function computeEmployeePayroll(employee, ctx) {
    const { month, year, settings, salaryCfg, holidayMap, attendanceByDate, leaveBalance, leaveConfig } = ctx;
    const daysInMonth = new Date(year, month, 0).getDate();

    // Leave entitlements come from LeaveConfig (HR-tunable). Fall back to
    // schema defaults only when no config exists yet. Support both PL
    // (Privilege Leave — used in the live routes + settings UI) and EL
    // (Earned Leave — legacy schema key).
    const CL_ENT_DEFAULT = leaveConfig?.clPerYear ?? 12;
    const SL_ENT_DEFAULT = leaveConfig?.slPerYear ?? 12;
    const PL_ENT_DEFAULT = leaveConfig?.plPerYear ?? 15;

    const stats = {
        daysInMonth,
        presentDays: 0,       // P + P* + P~ + MP (if treated present)
        halfDays: 0,
        missPunchDays: 0,
        absentDays: 0,
        lwpDays: 0,
        weekOffDays: 0,
        workingSundayDays: 0, // Sundays where employee actually worked (punched)
        holidayDays: 0,       // FH/NH/OH/RH/PH (not worked)
        holidayWorkedDays: 0, // punched on a declared holiday
        paidLeaveDays: 0,     // L-CL + L-SL + L-EL + WFH + CO
        clUsedDays: 0, slUsedDays: 0, plUsedDays: 0,
        autoAdjustedCL: 0,
        sundayOffsetApplied: 0,
        unsyncedDays: 0,
    };

    const dayBreakdown = [];
    let payableDays = 0;
    let lopDays = 0;

    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const dt = new Date(dateStr + "T00:00:00");
        const dow = dt.getDay();
        const hol = holidayMap.get(dateStr);
        const isWorkingSunday = hol && hol.type === "working_sunday";
        const isDeclaredHoliday = hol && hol.type !== "working_sunday";
        const isSundayOff = dow === 0 && !isWorkingSunday;
        const entry = attendanceByDate.get(dateStr);

        let category = null;
        let paid = false;
        let lopWeight = 0; // 0 = full pay, 0.5 = half day, 1 = unpaid
        let note = "";

        if (entry) {
            const rawStatus = entry.hrFinalStatus || entry.systemPrediction || "AB";
            switch (rawStatus) {
                case "P":
                case "P*":
                case "P~":
                    category = rawStatus; paid = true;
                    if (isSundayOff) stats.workingSundayDays++;
                    if (isDeclaredHoliday) stats.holidayWorkedDays++;
                    break;
                case "HD":
                    category = "HD"; paid = true; lopWeight = 0.5;
                    break;
                case "MP":
                    if (settings.mpTreatment === "absent") {
                        category = "AB"; lopWeight = 1; note = "MP treated as absent";
                    } else if (settings.mpTreatment === "half_day") {
                        category = "HD"; paid = true; lopWeight = 0.5; note = "MP treated as HD";
                    } else {
                        category = "MP"; paid = true;
                    }
                    break;
                case "WO": category = "WO"; paid = true; break;
                case "FH": case "NH": case "OH": case "RH": case "PH":
                    category = rawStatus; paid = true; break;
                case "L-CL": category = "L-CL"; paid = true; stats.clUsedDays++; break;
                case "L-SL": category = "L-SL"; paid = true; stats.slUsedDays++; break;
                case "L-EL": category = "L-EL"; paid = true; stats.plUsedDays++; break;
                case "WFH": case "CO": category = rawStatus; paid = true; break;
                case "LWP": category = "LWP"; lopWeight = 1; break;
                case "AB":
                default:
                    category = "AB"; lopWeight = 1; break;
            }
        } else {
            // No attendance entry for this date — infer from calendar
            if (isDeclaredHoliday) {
                category = HOLIDAY_TYPE_TO_CODE[hol.type] || "PH";
                paid = true;
            } else if (isSundayOff) {
                category = "WO"; paid = true;
            } else if (dt > new Date()) {
                // future date — skip
                category = "—"; note = "future";
            } else {
                category = "AB"; lopWeight = 1; note = "no attendance data";
                stats.unsyncedDays++;
            }
        }

        // Count stats
        if (["P", "P*", "P~", "MP"].includes(category)) stats.presentDays++;
        else if (category === "HD") stats.halfDays++;
        else if (category === "AB") stats.absentDays++;
        else if (category === "WO") stats.weekOffDays++;
        else if (category === "LWP") stats.lwpDays++;
        else if (HOLIDAY_CODES.has(category)) stats.holidayDays++;
        else if (LEAVE_CODES_PAID.has(category) || ["WFH", "CO"].includes(category)) {
            stats.paidLeaveDays++;
        }

        if (category && category !== "—") {
            if (paid) payableDays += (1 - lopWeight);
            if (lopWeight > 0) lopDays += lopWeight;
        }

        dayBreakdown.push({
            dateStr, dayOfWeek: dow, category,
            paid, lopWeight, note,
            isDeclaredHoliday, isSundayOff, isWorkingSunday,
            rawStatus: entry?.hrFinalStatus || entry?.systemPrediction || null,
            netWorkMins: entry?.netWorkMins || 0,
            otMins: entry?.otMins || 0,
            lateMins: entry?.lateMins || 0,
            inTime: entry?.inTime || null,
            finalOut: entry?.finalOut || null,
        });
    }

    // ── Sunday Offsets Absence (compensatory off) ──────────────────────────
    // If enabled: each Sunday-worked day cancels out one AB day. Runs BEFORE
    // CL auto-adjust so any remainder can still be rescued by the 1-CL rule.
    // Example: AB=2, Sunday-worked=1 → AB=1, then 1-CL rule absorbs it → AB=0.
    if (
        settings.sundayOffsetsAbsence &&
        stats.workingSundayDays > 0 &&
        stats.absentDays > 0
    ) {
        const offsetCount = Math.min(stats.workingSundayDays, stats.absentDays);
        stats.sundayOffsetApplied = offsetCount;
        stats.absentDays -= offsetCount;
        payableDays += offsetCount;
        lopDays -= offsetCount;

        // Mark offset AB rows in the day breakdown for audit
        let remaining = offsetCount;
        for (const day of dayBreakdown) {
            if (remaining <= 0) break;
            if (day.category === "AB") {
                day.category = "AB-OFFSET";
                day.paid = true;
                day.lopWeight = 0;
                day.note = "Offset by Sunday worked (comp off)";
                day.sundayOffsetApplied = true;
                remaining--;
            }
        }
    }

    // ── CL Auto-Adjustment ──────────────────────────────────────────────────
    // Convert up to `maxCLPerMonth` AB days to L-CL (paid), limited by the
    // employee's remaining annual CL balance. Any AB days beyond this cap stay
    // as LOP. This matches the Indian HR convention where every employee has a
    // monthly CL allowance (typically 2 per month) drawn from their annual
    // entitlement (typically 12 per year).
    //
    // If no LeaveBalance record exists yet for this employee+year, fall back
    // to the schema default (12 CL) so new employees still get the benefit.
    if (settings.clAutoAdjust?.enabled && stats.absentDays > 0) {
        const consumeFromBalance = settings.clAutoAdjust.consumeFromBalance !== false;
        const maxCLPerMonth = settings.clAutoAdjust.maxABForAdjustment ?? 2;

        let clAvailable;
        if (!consumeFromBalance) {
            clAvailable = Infinity; // no balance check
        } else {
            const clEntitlement = leaveBalance
                ? (leaveBalance.entitlement?.CL ?? 0)
                : CL_ENT_DEFAULT;  // ← from LeaveConfig, not hardcoded
            const clConsumed = leaveBalance?.consumed?.CL ?? 0;
            clAvailable = Math.max(0, clEntitlement - clConsumed);
        }

        // Convert as many AB days as possible, bounded by the monthly cap AND
        // the remaining annual balance. Remaining AB stays as LOP.
        const daysToAdjust = Math.min(
            stats.absentDays,
            maxCLPerMonth,
            clAvailable
        );

        if (daysToAdjust > 0) {
            stats.autoAdjustedCL = daysToAdjust;
            stats.paidLeaveDays += daysToAdjust;
            stats.clUsedDays += daysToAdjust;
            stats.absentDays -= daysToAdjust;
            payableDays += daysToAdjust;
            lopDays -= daysToAdjust;

            // Mark adjusted AB rows in breakdown
            let remaining = daysToAdjust;
            for (const day of dayBreakdown) {
                if (remaining <= 0) break;
                if (day.category === "AB") {
                    day.category = "L-CL";
                    day.paid = true;
                    day.lopWeight = 0;
                    day.note = "Auto-adjusted from AB (monthly CL cap)";
                    day.autoAdjusted = true;
                    remaining--;
                }
            }
        }
    }

    // ── Determine divisor for per-day rate ──────────────────────────────────
    const sundaysOff = dayBreakdown.filter(
        (d) => d.dayOfWeek === 0 && !d.isWorkingSunday && !d.isDeclaredHoliday
    ).length;
    const declaredHolidayCount = dayBreakdown.filter((d) => d.isDeclaredHoliday).length;

    let divisor;
    switch (settings.payableDaysBasis) {
        case "calendar":
            divisor = daysInMonth;
            break;
        case "working_days":
            divisor = Math.max(1, daysInMonth - sundaysOff - declaredHolidayCount);
            break;
        case "fixed26":
        default:
            divisor = 26;
            break;
    }

    // ── Earnings calculation ────────────────────────────────────────────────
    // Indian payroll convention: monthly gross already covers Sundays & holidays.
    // Employee earns full gross unless they have LOP days (AB / LWP / half-of-HD).
    //     effectivePayableDays = divisor − lopDays   (+ Sunday bonus if enabled)
    const fullGross = Number(employee.salary?.gross || 0);
    const fullBasic = Number(employee.salary?.basic || 0);
    const fullHra = Number(employee.salary?.hra || 0);
    const perDayRate = fullGross / divisor;

    let sundayExtraPayDays = 0;
    if (settings.sundayWorkExtraPay && stats.workingSundayDays > 0) {
        sundayExtraPayDays = stats.workingSundayDays;
    }
    const effectivePayableDays = Math.max(0, divisor - lopDays + sundayExtraPayDays);

    // Keep the descriptive "payableDays" for the UI (display only, not used in math)
    payableDays = Math.max(0, divisor - lopDays);

    const grossEarned = roundMoney(perDayRate * effectivePayableDays, settings.roundingMode);

    // Proportional basic & hra (per the employee's configured split)
    const basicRatio = fullGross > 0 ? fullBasic / fullGross : 0.5;
    const hraRatio = fullGross > 0 ? fullHra / fullGross : 0.5;
    const basicEarned = roundMoney(grossEarned * basicRatio, settings.roundingMode);
    const hraEarned = roundMoney(grossEarned * hraRatio, settings.roundingMode);
    const specialEarned = Math.max(0, grossEarned - basicEarned - hraEarned);

    // ── Deductions (statutory, computed on EARNED basic) ───────────────────
    const epfCap = salaryCfg?.epfCapAmount ?? 1800;
    const eepfPct = (salaryCfg?.eepfPct ?? 12) / 100;
    const eeEsicPct = (salaryCfg?.eeEsicPct ?? 0.75) / 100;
    const esiLimit = salaryCfg?.esiWageLimit ?? 21000;

    const epf = Math.round(Math.min(basicEarned * eepfPct, epfCap));
    // ESI applicability matches the convention used in EmployeeForm.js →
    // "const esiApplicable = basic <= esiWageLimit".  The configured BASIC
    // (not the earned gross) determines whether the employee is in the ESI
    // bracket; the premium itself is then calculated on the earned basic so
    // partial-month pay scales the deduction correctly.
    const esiApplicable = fullBasic > 0 && fullBasic <= esiLimit;
    const esic = esiApplicable ? Math.ceil(basicEarned * eeEsicPct) : 0;
    // Professional Tax is opt-in — only applied when HR explicitly enables it
    // via settings.ptEnabled (the default PT slabs are sample templates, not
    // something we should be silently deducting).
    const pt = (settings.ptEnabled && settings.ptForBasic) ? settings.ptForBasic(fullBasic) : 0;

    // LOP deduction is informational only — the gross is already reduced proportionally
    const lopDeduction = Math.round(perDayRate * lopDays);

    const totalDeductions = epf + esic + pt;
    const netPay = grossEarned - totalDeductions;
    const roundedNetPay = settings.roundNetPay ? Math.round(netPay) : netPay;

    return {
        employeeId: employee._id,
        employeeName: [employee.firstName, employee.middleName, employee.lastName].filter(Boolean).join(" "),
        biometricId: (employee.biometricId || "").toUpperCase(),
        department: employee.department || "",
        designation: employee.designation || employee.jobTitle || "",
        jobTitle: employee.jobTitle || "",
        employmentType: employee.employmentType || "",

        month, year,
        payPeriod: `${MONTH_NAMES[month]} ${year}`,

        // ── Rate snapshot — the employee's configured monthly salary at time of run.
        // Persisted so the Salary Register / payslip can show "Rate of wages payable"
        // correctly without having to re-query the Employee model later.
        rateBasic: fullBasic,
        rateHra: fullHra,
        rateGross: fullGross,

        // ── Leave balance snapshot at compute time — lets the payroll drawer show
        // remaining CL/SL/PL balance to HR. Pulls defaults from LeaveConfig
        // when no per-employee LeaveBalance record exists. Reads both PL (current
        // live code) and EL (legacy schema) so neither convention breaks.
        leaveBalanceSnapshot: (() => {
            const clEnt = leaveBalance?.entitlement?.CL ?? CL_ENT_DEFAULT;
            const slEnt = leaveBalance?.entitlement?.SL ?? SL_ENT_DEFAULT;
            const plEnt = (leaveBalance?.entitlement?.PL
                ?? leaveBalance?.entitlement?.EL
                ?? PL_ENT_DEFAULT);
            const clCon = leaveBalance?.consumed?.CL ?? 0;
            const slCon = leaveBalance?.consumed?.SL ?? 0;
            const plCon = leaveBalance?.consumed?.PL ?? leaveBalance?.consumed?.EL ?? 0;
            return {
                hasRecord: !!leaveBalance,
                entitlement: { CL: clEnt, SL: slEnt, PL: plEnt },
                consumed: { CL: clCon, SL: slCon, PL: plCon },
                available: {
                    CL: Math.max(0, clEnt - clCon),
                    SL: Math.max(0, slEnt - slCon),
                    PL: Math.max(0, plEnt - plCon),
                },
            };
        })(),

        // ── Attendance counts (for display/audit) ─────────────────
        workingDays: divisor,
        daysInMonth,
        presentDays: stats.presentDays,
        absentDays: stats.absentDays,
        halfDays: stats.halfDays,
        missPunchDays: stats.missPunchDays,
        lopDays,
        paidLeaveDays: stats.paidLeaveDays,
        weekOffDays: stats.weekOffDays,
        holidayDays: stats.holidayDays,
        holidayWorkedDays: stats.holidayWorkedDays,
        sundayWorkedDays: stats.workingSundayDays,
        lwpDays: stats.lwpDays,
        autoAdjustedCL: stats.autoAdjustedCL,
        sundayOffsetApplied: stats.sundayOffsetApplied,
        unsyncedDays: stats.unsyncedDays,
        clUsedDays: stats.clUsedDays,
        slUsedDays: stats.slUsedDays,
        plUsedDays: stats.plUsedDays,

        payableDays: +payableDays.toFixed(2),
        effectivePayableDays: +effectivePayableDays.toFixed(2),
        sundayExtraPayDays,
        perDayRate: +perDayRate.toFixed(2),
        divisorBasis: settings.payableDaysBasis,

        // ── Earnings & Deductions (persisted structure matches PayrollItem schema) ──
        earnings: {
            basicSalary: basicEarned,
            houseRentAllowance: hraEarned,
            travelAllowance: 0,
            medicalAllowance: 0,
            specialAllowance: specialEarned,
            overtime: 0,
            bonus: 0,
            incentives: 0,
            otherEarnings: 0,
            grossEarnings: grossEarned,
        },
        deductions: {
            providentFund: epf,
            employerPF: epf, // same rate; employer contribution recorded but not deducted from employee
            esic: esic,
            employerESIC: esiApplicable ? Math.ceil(basicEarned * (((salaryCfg?.erEsicPct) ?? 3.25) / 100)) : 0,
            professionalTax: pt,
            incomeTax: 0,
            loanDeduction: 0,
            advanceDeduction: 0,
            lateDeduction: 0,
            lopDeduction,
            otherDeductions: 0,
            totalDeductions,
        },
        netPay,
        roundedNetPay,

        bankDetails: {
            bankName: employee.bankDetails?.bankName || "",
            accountNumber: employee.bankDetails?.accountNumber || "",
            ifscCode: employee.bankDetails?.ifscCode || "",
        },

        // ── Audit-only day breakdown (not persisted) ──────────────
        dayBreakdown,
    };
}

function roundMoney(n, mode = "round") {
    if (!isFinite(n)) return 0;
    if (mode === "ceil") return Math.ceil(n);
    if (mode === "floor") return Math.floor(n);
    return Math.round(n);
}

// ═════════════════════════════════════════════════════════════════════════════
//  DATA LOADERS
// ═════════════════════════════════════════════════════════════════════════════

async function loadMonthContext(month, year) {
    const yearMonth = `${year}-${String(month).padStart(2, "0")}`;
    // Fetch LeaveConfig if the model is available. It may not be in every
    // deployment — fall back to nulls so the engine uses built-in defaults.
    const leaveConfigP = (LeaveConfig && typeof LeaveConfig.getConfig === "function")
        ? LeaveConfig.getConfig().catch(() => null)
        : Promise.resolve(null);

    const [settings, salaryCfg, dayDocs, holidays, leaveConfig] = await Promise.all([
        PayrollSettings.getConfig(),
        SalaryConfig.getSingleton(),
        DailyAttendance.find({ yearMonth }).lean(),
        CompanyHoliday.find({
            date: {
                $gte: `${yearMonth}-01`,
                $lte: `${yearMonth}-${new Date(year, month, 0).getDate()}`,
            },
        }).lean(),
        leaveConfigP,
    ]);

    const holidayMap = new Map(holidays.map((h) => [h.date, h]));
    const attendanceByEmp = new Map();
    for (const doc of dayDocs) {
        for (const emp of doc.employees || []) {
            const bid = String(emp.biometricId || "").toUpperCase();
            if (!bid) continue;
            if (!attendanceByEmp.has(bid)) attendanceByEmp.set(bid, new Map());
            attendanceByEmp.get(bid).set(doc.dateStr, emp);
        }
    }

    return { settings, salaryCfg, holidayMap, attendanceByEmp, leaveConfig };
}

// ═════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /preview  ────────────────────────────────────────────────────────────
// Compute payroll in-memory for the whole company for (month, year), WITHOUT
// saving. Returns the list HR reviews before hitting "Process".
router.get("/preview", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        if (month < 1 || month > 12) {
            return res.status(400).json({ success: false, message: "Invalid month" });
        }

        const { settings, salaryCfg, holidayMap, attendanceByEmp } = await loadMonthContext(month, year);

        const employees = await Employee.find({
            $or: [{ status: "active" }, { isActive: true }],
        })
            .select("-password -temporaryPassword -__v")
            .lean();

        const leaveBalances = await LeaveBalance.find({
            employeeId: { $in: employees.map((e) => e._id) },
            year,
        }).lean();
        const balanceByEmpId = new Map(leaveBalances.map((b) => [String(b.employeeId), b]));

        const items = employees.map((emp) => {
            const bid = (emp.biometricId || "").toUpperCase();
            const ctx = {
                month, year, settings, salaryCfg, holidayMap,
                attendanceByDate: attendanceByEmp.get(bid) || new Map(),
                leaveBalance: balanceByEmpId.get(String(emp._id)) || null,
            };
            return computeEmployeePayroll(emp, ctx);
        });

        // Aggregate summary for the UI banner
        const summary = items.reduce(
            (acc, i) => ({
                totalEmployees: acc.totalEmployees + 1,
                totalGross: acc.totalGross + i.earnings.grossEarnings,
                totalDeductions: acc.totalDeductions + i.deductions.totalDeductions,
                totalNetPay: acc.totalNetPay + i.roundedNetPay,
                totalPF: acc.totalPF + i.deductions.providentFund,
                totalESIC: acc.totalESIC + i.deductions.esic,
                totalLOPDays: acc.totalLOPDays + i.lopDays,
                autoAdjustedCount: acc.autoAdjustedCount + (i.autoAdjustedCL > 0 ? 1 : 0),
                unsyncedCount: acc.unsyncedCount + (i.unsyncedDays > 0 ? 1 : 0),
            }),
            {
                totalEmployees: 0, totalGross: 0, totalDeductions: 0, totalNetPay: 0,
                totalPF: 0, totalESIC: 0, totalLOPDays: 0,
                autoAdjustedCount: 0, unsyncedCount: 0,
            }
        );

        const existingRun = await Payroll.findOne({ month, year }).lean();

        res.json({
            success: true,
            data: {
                month, year,
                payPeriod: `${MONTH_NAMES[month]} ${year}`,
                settings: {
                    payableDaysBasis: settings.payableDaysBasis,
                    clAutoAdjust: settings.clAutoAdjust,
                    mpTreatment: settings.mpTreatment,
                    sundayWorkExtraPay: settings.sundayWorkExtraPay,
                },
                summary,
                items,
                existingRun: existingRun
                    ? { id: existingRun._id, status: existingRun.status, processedAt: existingRun.processedAt }
                    : null,
            },
        });
    } catch (err) {
        console.error("[PAYROLL-PREVIEW]", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── POST /run  ──────────────────────────────────────────────────────────────
// Persists the preview as PayrollItem docs + the parent Payroll run doc.
// Idempotent: if a run already exists in draft, it's updated in place.
router.post("/run", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        if (user.role !== "hr_manager") {
            return res.status(403).json({ success: false, message: "Only HR managers can run payroll" });
        }

        const month = parseInt(req.body.month) || new Date().getMonth() + 1;
        const year = parseInt(req.body.year) || new Date().getFullYear();

        // Block re-run if already paid / approved
        const existing = await Payroll.findOne({ month, year });
        if (existing && ["paid", "approved"].includes(existing.status)) {
            return res.status(400).json({
                success: false,
                message: `Payroll for ${MONTH_NAMES[month]} ${year} is already ${existing.status} and cannot be re-run`,
            });
        }

        const { settings, salaryCfg, holidayMap, attendanceByEmp } = await loadMonthContext(month, year);

        const employees = await Employee.find({
            $or: [{ status: "active" }, { isActive: true }],
        })
            .select("-password -temporaryPassword -__v")
            .lean();

        const leaveBalances = await LeaveBalance.find({
            employeeId: { $in: employees.map((e) => e._id) }, year,
        });
        const balanceByEmpId = new Map(leaveBalances.map((b) => [String(b.employeeId), b]));

        // Create-or-update parent run
        let payrollRun = existing;
        if (!payrollRun) {
            payrollRun = await Payroll.create({
                month, year,
                payPeriod: `${MONTH_NAMES[month]} ${year}`,
                status: "processing",
                createdBy: user.id,
            });
        } else {
            payrollRun.status = "processing";
            await payrollRun.save();
        }

        // Compute + upsert items
        let totalGross = 0, totalDed = 0, totalNet = 0, totalPF = 0, totalESIC = 0, totalBonus = 0;
        const clBalanceUpdates = []; // { balanceDoc, daysToDeduct }

        for (const emp of employees) {
            const bid = (emp.biometricId || "").toUpperCase();
            const balance = balanceByEmpId.get(String(emp._id)) || null;
            const ctx = {
                month, year, settings, salaryCfg, holidayMap,
                attendanceByDate: attendanceByEmp.get(bid) || new Map(),
                leaveBalance: balance,
            };
            const computed = computeEmployeePayroll(emp, ctx);

            // Upsert PayrollItem  (unique on employeeId + month + year)
            await PayrollItem.findOneAndUpdate(
                { employeeId: emp._id, month, year },
                {
                    employeeId: emp._id,
                    employeeName: computed.employeeName,
                    biometricId: computed.biometricId,
                    department: computed.department,
                    designation: computed.designation,
                    jobTitle: computed.jobTitle,
                    employmentType: computed.employmentType,
                    payrollId: payrollRun._id,
                    month, year,
                    payPeriod: computed.payPeriod,
                    workingDays: computed.workingDays,
                    presentDays: computed.presentDays,
                    absentDays: computed.absentDays,
                    lopDays: computed.lopDays,
                    paidLeaveDays: computed.paidLeaveDays,
                    earnings: computed.earnings,
                    deductions: computed.deductions,
                    netPay: computed.netPay,
                    roundedNetPay: computed.roundedNetPay,
                    bankDetails: computed.bankDetails,
                    status: "processed",
                    processedBy: user.id,
                    processedAt: new Date(),
                    // Store audit-extras in remarks-ish area (keeping existing schema)
                    remarks: computed.autoAdjustedCL > 0
                        ? `Auto-adjusted ${computed.autoAdjustedCL} day(s) from AB to CL`
                        : null,
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            // Queue CL-balance consumption
            if (
                settings.clAutoAdjust?.enabled &&
                settings.clAutoAdjust?.consumeFromBalance &&
                computed.autoAdjustedCL > 0 &&
                balance
            ) {
                clBalanceUpdates.push({ balanceId: balance._id, days: computed.autoAdjustedCL });
            }

            totalGross += computed.earnings.grossEarnings;
            totalDed += computed.deductions.totalDeductions;
            totalNet += computed.roundedNetPay;
            totalPF += computed.deductions.providentFund;
            totalESIC += computed.deductions.esic;
            totalBonus += computed.earnings.bonus || 0;
        }

        // Apply CL balance consumption
        for (const u of clBalanceUpdates) {
            await LeaveBalance.updateOne(
                { _id: u.balanceId },
                { $inc: { "consumed.CL": u.days } }
            );
        }

        // Update parent run summary
        payrollRun.totalEmployees = employees.length;
        payrollRun.totalGross = totalGross;
        payrollRun.totalDeductions = totalDed;
        payrollRun.totalNetPay = totalNet;
        payrollRun.totalPF = totalPF;
        payrollRun.totalESIC = totalESIC;
        payrollRun.totalBonus = totalBonus;
        payrollRun.status = "processed";
        payrollRun.processedAt = new Date();
        await payrollRun.save();

        res.json({
            success: true,
            message: `Payroll processed for ${employees.length} employees`,
            data: {
                runId: payrollRun._id,
                summary: {
                    totalEmployees: employees.length,
                    totalGross, totalDeductions: totalDed, totalNetPay: totalNet,
                    totalPF, totalESIC,
                    clAdjustmentsApplied: clBalanceUpdates.length,
                },
            },
        });
    } catch (err) {
        console.error("[PAYROLL-RUN]", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── GET /items  ─────────────────────────────────────────────────────────────
// List processed payroll items for a month (what feeds the payroll list page)
router.get("/items", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();
        const { department, status, search } = req.query;

        const filter = { month, year };
        if (department && department !== "all") filter.department = department;
        if (status && status !== "all") filter.status = status;
        if (search) {
            filter.$or = [
                { employeeName: { $regex: search, $options: "i" } },
                { biometricId: { $regex: search, $options: "i" } },
            ];
        }

        const items = await PayrollItem.find(filter)
            .sort({ employeeName: 1 })
            .lean();

        // Attach current leave balance to each item so the drawer can show
        // "CL remaining" without a second round-trip per employee.
        // Pull defaults from LeaveConfig (HR-tunable: clPerYear/slPerYear/plPerYear).
        const empIds = items.map((i) => i.employeeId);
        const [balances, leaveCfg] = await Promise.all([
            LeaveBalance.find({ employeeId: { $in: empIds }, year }).lean(),
            (LeaveConfig && LeaveConfig.getConfig)
                ? LeaveConfig.getConfig().catch(() => null)
                : Promise.resolve(null),
        ]);
        const byEmp = new Map(balances.map((b) => [String(b.employeeId), b]));
        const clDef = leaveCfg?.clPerYear ?? 12;
        const slDef = leaveCfg?.slPerYear ?? 12;
        const plDef = leaveCfg?.plPerYear ?? 15;

        items.forEach((it) => {
            const b = byEmp.get(String(it.employeeId));
            const clEnt = b?.entitlement?.CL ?? clDef;
            const slEnt = b?.entitlement?.SL ?? slDef;
            // Support both PL (live routes) and EL (legacy schema)
            const plEnt = b?.entitlement?.PL ?? b?.entitlement?.EL ?? plDef;
            const clCon = b?.consumed?.CL ?? 0;
            const slCon = b?.consumed?.SL ?? 0;
            const plCon = b?.consumed?.PL ?? b?.consumed?.EL ?? 0;
            it.leaveBalanceSnapshot = {
                hasRecord: !!b,
                entitlement: { CL: clEnt, SL: slEnt, PL: plEnt },
                consumed: { CL: clCon, SL: slCon, PL: plCon },
                available: {
                    CL: Math.max(0, clEnt - clCon),
                    SL: Math.max(0, slEnt - slCon),
                    PL: Math.max(0, plEnt - plCon),
                },
            };
        });

        const run = await Payroll.findOne({ month, year }).lean();

        res.json({ success: true, data: { items, run, count: items.length } });
    } catch (err) {
        console.error("[PAYROLL-ITEMS]", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── GET /item/:id  ──────────────────────────────────────────────────────────
router.get("/item/:id", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const item = await PayrollItem.findById(req.params.id)
            .populate("employeeId", "firstName lastName profilePhoto email phone dateOfJoining")
            .lean();
        if (!item) return res.status(404).json({ success: false, message: "Payroll item not found" });
        res.json({ success: true, data: item });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── PUT /item/:id  ──────────────────────────────────────────────────────────
// HR can tweak individual earnings / deductions before approving
router.put("/item/:id", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        if (user.role !== "hr_manager") {
            return res.status(403).json({ success: false, message: "Only HR managers can edit" });
        }

        const item = await PayrollItem.findById(req.params.id);
        if (!item) return res.status(404).json({ success: false, message: "Not found" });
        if (item.status === "paid") {
            return res.status(400).json({ success: false, message: "Paid payroll cannot be edited" });
        }

        const allowed = ["earnings", "deductions", "remarks"];
        allowed.forEach((k) => { if (req.body[k] !== undefined) item[k] = req.body[k]; });
        await item.save(); // pre-save recalculates gross & net
        res.json({ success: true, data: item });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── PATCH /item/:id/override  ───────────────────────────────────────────────
// HR-friendly override: accept new payableDays + supplementary amounts,
// re-derive basic/HRA/gross/EPF/ESIC/PT, update net pay. This is what HR
// uses when the auto-computed payroll is wrong for a specific employee.
router.patch("/item/:id/override", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        if (user.role !== "hr_manager") {
            return res.status(403).json({ success: false, message: "Only HR managers can edit" });
        }

        const item = await PayrollItem.findById(req.params.id);
        if (!item) return res.status(404).json({ success: false, message: "Not found" });

        const settings = await PayrollSettings.getConfig();
        if (item.status === "paid" && settings.lockAfterPaid) {
            return res.status(400).json({ success: false, message: "Paid payroll is locked. Unlock it first." });
        }

        const employee = await Employee.findById(item.employeeId).lean();
        if (!employee) return res.status(404).json({ success: false, message: "Employee not found" });
        const salaryCfg = await SalaryConfig.getSingleton();

        const {
            payableDays,
            lopDays,                    // NEW — if provided, payableDays = workingDays - lopDays
            clUsedDays,                 // NEW — informational leave counts
            slUsedDays,
            plUsedDays,
            overtime,
            bonus,
            incentives,
            otherEarnings,
            loanDeduction,
            advanceDeduction,
            otherDeductions,
            remarks,
        } = req.body;

        // Prefer the rate snapshot captured when payroll was run — this keeps
        // historical items stable if the employee's configured salary later changes.
        // Fall back to current employee salary for items that predate the snapshot.
        const divisor = item.workingDays || 26;
        const fullGross = Number(item.rateGross || employee.salary?.gross || 0);
        const fullBasic = Number(item.rateBasic || employee.salary?.basic || 0);
        const fullHra = Number(item.rateHra || employee.salary?.hra || 0);

        if (fullGross <= 0) {
            return res.status(400).json({ success: false, message: "Employee has no gross salary set" });
        }

        // Resolve payable days. HR can provide either payableDays OR lopDays
        // (or neither, in which case we keep the existing value).
        //   lopDays wins if both provided — it's the more explicit input.
        let newPayableDays;
        let newLopDays;
        if (lopDays !== undefined) {
            newLopDays = Math.max(0, Math.min(Number(lopDays), divisor));
            newPayableDays = Math.max(0, divisor - newLopDays);
        } else if (payableDays !== undefined) {
            newPayableDays = Math.max(0, Math.min(Number(payableDays), divisor));
            newLopDays = Math.max(0, divisor - newPayableDays);
        } else {
            newPayableDays = item.payableDays ?? ((item.presentDays || 0) + (item.paidLeaveDays || 0));
            newLopDays = item.lopDays ?? 0;
        }

        const perDay = fullGross / divisor;
        const basicRatio = fullBasic / fullGross;
        const hraRatio = fullHra / fullGross;

        const grossEarnedBase = Math.round(perDay * newPayableDays);
        const basicEarned = Math.round(grossEarnedBase * basicRatio);
        const hraEarned = Math.round(grossEarnedBase * hraRatio);
        const specialEarned = Math.max(0, grossEarnedBase - basicEarned - hraEarned);

        // Supplementary earnings (default to existing values if not provided)
        const ot = overtime !== undefined ? Number(overtime) : (item.earnings?.overtime || 0);
        const bn = bonus !== undefined ? Number(bonus) : (item.earnings?.bonus || 0);
        const inc = incentives !== undefined ? Number(incentives) : (item.earnings?.incentives || 0);
        const oth = otherEarnings !== undefined ? Number(otherEarnings) : (item.earnings?.otherEarnings || 0);

        const grossTotal = grossEarnedBase + ot + bn + inc + oth;

        // Deductions: re-derive EPF/ESIC/PT on the new earned basic + honour supplied values
        const epfCap = salaryCfg?.epfCapAmount ?? 1800;
        const eepfPct = (salaryCfg?.eepfPct ?? 12) / 100;
        const eeEsicPct = (salaryCfg?.eeEsicPct ?? 0.75) / 100;
        const erEsicPct = (salaryCfg?.erEsicPct ?? 3.25) / 100;
        const esiLimit = salaryCfg?.esiWageLimit ?? 21000;

        const epf = Math.round(Math.min(basicEarned * eepfPct, epfCap));
        // ESI applicability based on configured BASIC (matches EmployeeForm.js)
        const esiApplicable = fullBasic > 0 && fullBasic <= esiLimit;
        const esic = esiApplicable ? Math.ceil(basicEarned * eeEsicPct) : 0;
        const erEsic = esiApplicable ? Math.ceil(basicEarned * erEsicPct) : 0;
        // PT only applied when HR explicitly enables it
        const pt = (settings.ptEnabled && settings.ptForBasic) ? settings.ptForBasic(fullBasic) : 0;

        const loan = loanDeduction !== undefined ? Number(loanDeduction) : (item.deductions?.loanDeduction || 0);
        const advance = advanceDeduction !== undefined ? Number(advanceDeduction) : (item.deductions?.advanceDeduction || 0);
        const otherD = otherDeductions !== undefined ? Number(otherDeductions) : (item.deductions?.otherDeductions || 0);

        const totalDeductions = epf + esic + pt + loan + advance + otherD;
        const netPay = grossTotal - totalDeductions;

        // Update the item
        item.earnings = {
            ...(item.earnings || {}),
            basicSalary: basicEarned,
            houseRentAllowance: hraEarned,
            specialAllowance: specialEarned,
            overtime: ot, bonus: bn, incentives: inc, otherEarnings: oth,
            grossEarnings: grossTotal,
        };
        item.deductions = {
            ...(item.deductions || {}),
            providentFund: epf,
            employerPF: epf,
            esic: esic,
            employerESIC: erEsic,
            professionalTax: pt,
            loanDeduction: loan,
            advanceDeduction: advance,
            otherDeductions: otherD,
            totalDeductions,
        };
        item.netPay = netPay;
        item.roundedNetPay = settings.roundNetPay ? Math.round(netPay) : netPay;
        if (remarks !== undefined) item.remarks = remarks;

        // Persist the new day counts (affects payable-days math + leave tracking).
        item.payableDays = newPayableDays;
        item.lopDays = newLopDays;
        if (clUsedDays !== undefined) item.clUsedDays = Math.max(0, Number(clUsedDays));
        if (slUsedDays !== undefined) item.slUsedDays = Math.max(0, Number(slUsedDays));
        if (plUsedDays !== undefined) item.plUsedDays = Math.max(0, Number(plUsedDays));

        // Any of these changing = manual override
        const dayEdit = payableDays !== undefined || lopDays !== undefined
            || clUsedDays !== undefined || slUsedDays !== undefined || plUsedDays !== undefined;
        if (dayEdit) {
            item.overriddenPayableDays = newPayableDays;
            item.isManuallyOverridden = true;
        }
        item.lastEditedBy = user.id;
        item.lastEditedAt = new Date();
        item.markModified("earnings");
        item.markModified("deductions");
        await item.save();

        res.json({
            success: true,
            message: "Override applied and net pay recomputed",
            data: item,
        });
    } catch (err) {
        console.error("[PAYROLL-OVERRIDE]", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── PATCH /mark-paid  ───────────────────────────────────────────────────────
router.patch("/mark-paid", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        if (user.role !== "hr_manager") {
            return res.status(403).json({ success: false, message: "Only HR managers can mark as paid" });
        }
        const month = parseInt(req.body.month) || new Date().getMonth() + 1;
        const year = parseInt(req.body.year) || new Date().getFullYear();

        const result = await PayrollItem.updateMany(
            { month, year, status: "processed" },
            { $set: { status: "paid", paymentDate: new Date() } }
        );

        await Payroll.updateOne({ month, year }, { $set: { status: "paid" } });
        res.json({ success: true, message: `${result.modifiedCount} items marked as paid` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── GET /runs  ──────────────────────────────────────────────────────────────
router.get("/runs", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const runs = await Payroll.find().sort({ year: -1, month: -1 }).limit(24).lean();
        res.json({ success: true, data: runs });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── GET /settings  ──────────────────────────────────────────────────────────
router.get("/settings", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const cfg = await PayrollSettings.getConfig();
        res.json({ success: true, data: cfg });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── PUT /settings  ──────────────────────────────────────────────────────────
// Also notifies the CEO by email whenever settings actually change.
router.put("/settings", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        const allowed = [
            "payableDaysBasis", "clAutoAdjust", "mpTreatment",
            "foodAllowanceInGross", "sundayWorkExtraPay", "sundayOffsetsAbsence",
            "roundingMode", "roundNetPay", "ptEnabled", "ptSlabs", "lockAfterPaid",
        ];
        const update = { updatedBy: user.id, updatedAt: new Date() };
        allowed.forEach((k) => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

        // Load the existing config so we can diff old vs new for the CEO email
        const before = await PayrollSettings.findById("singleton").lean();

        const cfg = await PayrollSettings.findByIdAndUpdate(
            "singleton", { $set: update },
            { new: true, upsert: true, runValidators: true }
        );

        // Best-effort CEO notification. Never block the HR save if email fails.
        try {
            const changes = diffPayrollSettings(before, cfg, req.body);
            if (changes.length > 0) {
                // Lazy require so a missing service file doesn't crash route loading
                let EmailService;
                try { EmailService = require("../../services/emailService"); }
                catch (e) {
                    console.warn("[PAYROLL-SETTINGS] emailService not found, skipping CEO notification");
                }
                if (EmailService?.sendPayrollSettingsChangeEmail) {
                    // Resolve the HR user's name — fall back to their id / "HR"
                    const changedBy = req.user?.name || req.user?.email || req.user?.id || "HR";
                    EmailService
                        .sendPayrollSettingsChangeEmail({ changedBy, changes })
                        .catch((e) => console.warn("[PAYROLL-SETTINGS] CEO email failed:", e.message));
                }
            }
        } catch (e) {
            console.warn("[PAYROLL-SETTINGS] diff/email step failed:", e.message);
        }

        res.json({ success: true, data: cfg });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─── Helper: produce a human-readable diff of payroll settings ──────────────
//   Returns [{ label, before, after }, ...] for fields that actually changed.
function diffPayrollSettings(oldCfg, newCfg, requestBody) {
    if (!oldCfg) oldCfg = {};
    const changes = [];
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

    // Scalar fields — only report if the client actually touched them
    const scalars = [
        { key: "payableDaysBasis", label: "Payable Days Basis" },
        { key: "mpTreatment", label: "Miss-Punch Treatment" },
        { key: "foodAllowanceInGross", label: "Food Allowance In Gross" },
        { key: "sundayOffsetsAbsence", label: "Sunday Offsets Absence" },
        { key: "sundayWorkExtraPay", label: "Sunday Work Extra Pay" },
        { key: "roundingMode", label: "Rounding Mode" },
        { key: "roundNetPay", label: "Round Net Pay" },
        { key: "ptEnabled", label: "Professional Tax Enabled" },
        { key: "lockAfterPaid", label: "Lock After Paid" },
    ];
    for (const { key, label } of scalars) {
        if (requestBody[key] === undefined) continue;
        if (!same(oldCfg[key], newCfg[key])) {
            changes.push({ label, before: formatVal(oldCfg[key]), after: formatVal(newCfg[key]) });
        }
    }

    // CL Auto-Adjust nested object — break into 3 labelled rows when any field changed
    if (requestBody.clAutoAdjust !== undefined) {
        const o = oldCfg.clAutoAdjust || {};
        const n = newCfg.clAutoAdjust || {};
        if (!same(o.enabled, n.enabled)) {
            changes.push({ label: "CL Auto-Adjust — Enabled", before: formatVal(o.enabled), after: formatVal(n.enabled) });
        }
        if (!same(o.maxABForAdjustment, n.maxABForAdjustment)) {
            changes.push({ label: "CL Auto-Adjust — Max Per Month", before: formatVal(o.maxABForAdjustment), after: formatVal(n.maxABForAdjustment) });
        }
        if (!same(o.consumeFromBalance, n.consumeFromBalance)) {
            changes.push({ label: "CL Auto-Adjust — Consume Balance", before: formatVal(o.consumeFromBalance), after: formatVal(n.consumeFromBalance) });
        }
    }

    // PT Slabs — just say "updated" if changed (too noisy to show full table)
    if (requestBody.ptSlabs !== undefined && !same(oldCfg.ptSlabs, newCfg.ptSlabs)) {
        const summarise = (slabs) => (slabs || [])
            .map((s) => `${s.minBasic}–${s.maxBasic}: ₹${s.amount}`)
            .join(" · ") || "—";
        changes.push({
            label: "PT Slabs",
            before: summarise(oldCfg.ptSlabs),
            after: summarise(newCfg.ptSlabs),
        });
    }

    return changes;
}

function formatVal(v) {
    if (v === true) return "Yes";
    if (v === false) return "No";
    if (v === null || v === undefined || v === "") return "—";
    return String(v);
}

// ── GET /export  ────────────────────────────────────────────────────────────
// Excel export matching your salary-register template: Sl, Name, Designation,
// Rate of wages payable (Basic/HRA/Total), Days in month, Attendance, Wages
// paid (Basic/HRA), OT, Gross, PF, ESI, Advance, Other, Total Ded, Net.
router.get("/export", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const ExcelJS = require("exceljs");
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        const items = await PayrollItem.find({ month, year })
            .sort({ department: 1, employeeName: 1 }).lean();

        if (items.length === 0) {
            return res.status(404).json({
                success: false,
                message: `No payroll items for ${MONTH_NAMES[month]} ${year}. Process payroll first.`,
            });
        }

        const employees = await Employee.find({
            _id: { $in: items.map((i) => i.employeeId) },
        }).select("firstName middleName lastName biometricId designation jobTitle department salary bankDetails").lean();
        const empById = new Map(employees.map((e) => [String(e._id), e]));

        const wb = new ExcelJS.Workbook();
        wb.creator = "Grav Clothing HRMS";
        const ws = wb.addWorksheet("Salary Register", {
            views: [{ state: "frozen", ySplit: 4 }],
            pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1 },
        });

        // Title
        ws.mergeCells(1, 1, 1, 20);
        const title = ws.getCell(1, 1);
        title.value = `GRAV CLOTHING — SALARY REGISTER for ${MONTH_NAMES[month]} ${year}`;
        title.font = { size: 14, bold: true, color: { argb: "FFFFFFFF" } };
        title.alignment = { vertical: "middle", horizontal: "center" };
        title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF581C87" } };
        ws.getRow(1).height = 28;

        // Header row 1 (grouped: Rate of wages payable / Wages actually paid / others)
        const h1 = [
            "Sl. No", "Name of the Employee", "Designation",
            "Rate of wages payable", null, null,  // span Basic / HRA / Total
            "Total No. of Days of the Month",
            "Total attendance units of work done",
            "Wages actually paid", null,           // span Basic / HRA
            "Overtime worked", "Gross Wages Payable",
            "Employee's contribution to P.F", "E.S.I", "Salary Advance", "Other Deduct.",
            "Total Dedc.", "Net Wages Paid",
            "Date of Payment",
            "Payment made by Bank Transfer / Signature or thumb impression of the Emp.",
        ];
        // Header row 2 (sub-labels for the grouped columns)
        const h2 = [
            "", "", "",
            "Basic", "HRA", "Total Salary",
            "", "",
            "Basic", "HRA",
            "", "", "", "", "", "", "", "", "", "",
        ];

        const r2 = ws.getRow(2);
        const r3 = ws.getRow(3);
        h1.forEach((v, i) => { if (v !== null) r2.getCell(i + 1).value = v; });
        h2.forEach((v, i) => { r3.getCell(i + 1).value = v; });

        // Merge grouped header cells vertically (cols 1,2,3,7,8,11..20) and horizontally (4-6, 9-10)
        [1, 2, 3, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].forEach((c) => ws.mergeCells(2, c, 3, c));
        ws.mergeCells(2, 4, 2, 6);   // Rate of wages payable
        ws.mergeCells(2, 9, 2, 10);  // Wages actually paid

        [r2, r3].forEach((r) => {
            r.eachCell((cell) => {
                cell.font = { size: 10, bold: true, color: { argb: "FFFFFFFF" } };
                cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
                cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
                cell.border = {
                    top: { style: "thin", color: { argb: "FF000000" } },
                    bottom: { style: "thin", color: { argb: "FF000000" } },
                    left: { style: "thin", color: { argb: "FF000000" } },
                    right: { style: "thin", color: { argb: "FF000000" } },
                };
            });
        });
        r2.height = 24; r3.height = 20;

        // Column widths — roughly matches the Excel user uploaded
        const widths = [6, 28, 18, 8, 8, 10, 8, 10, 8, 8, 8, 12, 10, 8, 10, 10, 10, 12, 12, 20];
        widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

        // Data rows
        items.forEach((it, idx) => {
            const row = ws.getRow(4 + idx);
            const emp = empById.get(String(it.employeeId)) || {};
            const fullBasic = emp.salary?.basic || 0;
            const fullHra = emp.salary?.hra || 0;
            const fullGross = emp.salary?.gross || 0;
            const e = it.earnings || {};
            const d = it.deductions || {};

            row.getCell(1).value = idx + 1;
            row.getCell(2).value = it.employeeName || "";
            row.getCell(3).value = it.designation || emp.designation || emp.jobTitle || "";
            row.getCell(4).value = fullBasic;
            row.getCell(5).value = fullHra;
            row.getCell(6).value = fullGross;
            row.getCell(7).value = new Date(year, month, 0).getDate();       // days in month
            row.getCell(8).value = Math.round((it.presentDays || 0) + (it.paidLeaveDays || 0)); // attendance units
            row.getCell(9).value = e.basicSalary || 0;
            row.getCell(10).value = e.houseRentAllowance || 0;
            row.getCell(11).value = e.overtime || 0;
            row.getCell(12).value = e.grossEarnings || 0;
            row.getCell(13).value = d.providentFund || 0;
            row.getCell(14).value = d.esic || 0;
            row.getCell(15).value = d.advanceDeduction || 0;
            row.getCell(16).value = d.otherDeductions || 0;
            row.getCell(17).value = d.totalDeductions || 0;
            row.getCell(18).value = it.roundedNetPay ?? it.netPay ?? 0;
            row.getCell(19).value = it.paymentDate ? new Date(it.paymentDate).toLocaleDateString("en-IN") : "";
            row.getCell(20).value = emp.bankDetails?.accountNumber ? `A/C: ${emp.bankDetails.accountNumber}` : "";

            row.eachCell((cell, col) => {
                cell.font = { size: 10 };
                cell.alignment = {
                    vertical: "middle",
                    horizontal: col <= 3 ? "left" : "right",
                    indent: col <= 3 ? 1 : 0,
                };
                if (col >= 4 && col !== 19 && col !== 20) cell.numFmt = "#,##0";
                cell.border = {
                    top: { style: "thin", color: { argb: "FFD1D5DB" } },
                    bottom: { style: "thin", color: { argb: "FFD1D5DB" } },
                    left: { style: "thin", color: { argb: "FFD1D5DB" } },
                    right: { style: "thin", color: { argb: "FFD1D5DB" } },
                };
            });
            row.height = 22;
        });

        // Totals footer
        const tr = ws.getRow(4 + items.length);
        tr.getCell(1).value = "";
        tr.getCell(2).value = "TOTAL";
        const sum = (key) => items.reduce((a, i) => a + (i[key] || 0), 0);
        const sumE = (k) => items.reduce((a, i) => a + (i.earnings?.[k] || 0), 0);
        const sumD = (k) => items.reduce((a, i) => a + (i.deductions?.[k] || 0), 0);
        tr.getCell(9).value = sumE("basicSalary");
        tr.getCell(10).value = sumE("houseRentAllowance");
        tr.getCell(11).value = sumE("overtime");
        tr.getCell(12).value = sumE("grossEarnings");
        tr.getCell(13).value = sumD("providentFund");
        tr.getCell(14).value = sumD("esic");
        tr.getCell(15).value = sumD("advanceDeduction");
        tr.getCell(16).value = sumD("otherDeductions");
        tr.getCell(17).value = sumD("totalDeductions");
        tr.getCell(18).value = items.reduce((a, i) => a + (i.roundedNetPay ?? i.netPay ?? 0), 0);

        tr.eachCell((cell, col) => {
            cell.font = { size: 10, bold: true };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } };
            cell.alignment = { vertical: "middle", horizontal: col <= 3 ? "left" : "right", indent: col <= 3 ? 1 : 0 };
            if (col >= 4) cell.numFmt = "#,##0";
            cell.border = {
                top: { style: "medium", color: { argb: "FF000000" } },
                bottom: { style: "medium", color: { argb: "FF000000" } },
                left: { style: "thin", color: { argb: "FFD1D5DB" } },
                right: { style: "thin", color: { argb: "FFD1D5DB" } },
            };
        });
        tr.height = 26;

        const buffer = await wb.xlsx.writeBuffer();
        const filename = `salary_register_${year}-${String(month).padStart(2, "0")}.xlsx`;
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(buffer);
    } catch (err) {
        console.error("[PAYROLL-EXPORT]", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
module.exports.computeEmployeePayroll = computeEmployeePayroll;
module.exports.loadMonthContext = loadMonthContext;