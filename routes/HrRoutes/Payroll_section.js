"use strict";
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const { Payroll, PayrollItem } = require("../../models/HR_Models/Payroll");
const PayrollSettings = require("../../models/HR_Models/Payrollsettings");
const Employee = require("../../models/Employee");
const SalaryConfig = require("../../models/Salaryconfig");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const { Expo } = require("expo-server-sdk");
const expo = new Expo();
const { CompanyHoliday, LeaveBalance, LeaveConfig } =
    require("../../models/HR_Models/LeaveManagement");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");
const {
    decryptSalaryFields,
    decryptEmployeeDoc,
} = require("../../utils/salaryEncryption");

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

// ─── DOJ HELPERS ─────────────────────────────────────────────────────────────

function parseDOJ(val) {
    if (!val) return null;
    const d = val instanceof Date ? val : new Date(val);
    if (isNaN(d.getTime())) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function firstActiveDayOfMonth(dateOfJoining, month, year, daysInMonth) {
    const doj = parseDOJ(dateOfJoining);
    if (!doj) return 1;

    const dojYear = doj.getFullYear();
    const dojMonth = doj.getMonth() + 1;
    const dojDay = doj.getDate();

    if (dojYear < year || (dojYear === year && dojMonth < month)) return 1;
    if (dojYear > year || (dojYear === year && dojMonth > month)) return daysInMonth + 1;
    return dojDay;
}

function calendarDaysSinceDOJ(dateOfJoining, month, year) {
    const doj = parseDOJ(dateOfJoining);
    if (!doj) return Infinity;
    const endOfMonth = new Date(year, month, 0);
    if (doj > endOfMonth) return 0;
    const msPerDay = 86400000;
    return Math.floor((endOfMonth - doj) / msPerDay) + 1;
}

// ═════════════════════════════════════════════════════════════════════════════
//  ENGINE
// ═════════════════════════════════════════════════════════════════════════════

function computeEmployeePayroll(employee, ctx) {
    const { month, year, settings, salaryCfg, holidayMap, attendanceByDate, leaveBalance, leaveConfig } = ctx;
    const daysInMonth = new Date(year, month, 0).getDate();

    const firstActiveDay = firstActiveDayOfMonth(employee.dateOfJoining, month, year, daysInMonth);
    const preJoiningDays = Math.max(0, firstActiveDay - 1);
    const activeDaysInMonth = daysInMonth - preJoiningDays;

    const daysSinceDOJ = calendarDaysSinceDOJ(employee.dateOfJoining, month, year);
    const clEligible = daysSinceDOJ >= 24;

    const CL_ENT_DEFAULT = leaveConfig?.clPerYear ?? 12;
    const SL_ENT_DEFAULT = leaveConfig?.slPerYear ?? 12;
    const PL_ENT_DEFAULT = leaveConfig?.plPerYear ?? 15;

    const stats = {
        daysInMonth,
        presentDays: 0,
        halfDays: 0,
        missPunchDays: 0,
        absentDays: 0,
        lwpDays: 0,
        weekOffDays: 0,
        workingSundayDays: 0,
        holidayDays: 0,
        holidayWorkedDays: 0,
        paidLeaveDays: 0,
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

        if (d < firstActiveDay) {
            dayBreakdown.push({
                dateStr, dayOfWeek: dow,
                category: "PRE-JOINING",
                paid: false, lopWeight: 0,
                note: "Before date of joining — excluded",
                isDeclaredHoliday: false, isSundayOff: false, isWorkingSunday: false,
                rawStatus: null, netWorkMins: 0, otMins: 0, lateMins: 0,
                inTime: null, finalOut: null,
                preJoining: true,
            });
            continue;
        }

        const hol = holidayMap.get(dateStr);
        const isWorkingSunday = hol && hol.type === "working_sunday";
        const isDeclaredHoliday = hol && hol.type !== "working_sunday";
        const isSundayOff = dow === 0 && !isWorkingSunday;
        const entry = attendanceByDate.get(dateStr);

        let category = null;
        let paid = false;
        let lopWeight = 0;
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
            if (isDeclaredHoliday) {
                category = HOLIDAY_TYPE_TO_CODE[hol.type] || "PH";
                paid = true;
            } else if (isSundayOff) {
                category = "WO"; paid = true;
            } else if (dt > new Date()) {
                category = "—"; note = "future";
            } else {
                category = "AB"; lopWeight = 1; note = "no attendance data";
                stats.unsyncedDays++;
            }
        }

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

    // ── Sunday Offsets ────────────────────────────────────────────────────────
    if (settings.sundayOffsetsAbsence && stats.workingSundayDays > 0 && stats.absentDays > 0) {
        const offsetCount = Math.min(stats.workingSundayDays, stats.absentDays);
        stats.sundayOffsetApplied = offsetCount;
        stats.absentDays -= offsetCount;
        payableDays += offsetCount;
        lopDays -= offsetCount;

        let remaining = offsetCount;
        for (const day of dayBreakdown) {
            if (remaining <= 0) break;
            if (day.category === "AB" && !day.preJoining) {
                day.category = "AB-OFFSET";
                day.paid = true;
                day.lopWeight = 0;
                day.note = "Offset by Sunday worked (comp off)";
                day.sundayOffsetApplied = true;
                remaining--;
            }
        }
    }

    // ── CL Auto-Adjustment ────────────────────────────────────────────────────
    if (clEligible && settings.clAutoAdjust?.enabled && stats.absentDays > 0) {
        const consumeFromBalance = settings.clAutoAdjust.consumeFromBalance !== false;
        const maxCLPerMonth = settings.clAutoAdjust.maxABForAdjustment ?? 2;

        let clAvailable;
        if (!consumeFromBalance) {
            clAvailable = Infinity;
        } else {
            const clEntitlement = leaveBalance
                ? (leaveBalance.entitlement?.CL ?? 0)
                : CL_ENT_DEFAULT;
            const clConsumed = leaveBalance?.consumed?.CL ?? 0;
            clAvailable = Math.max(0, clEntitlement - clConsumed);
        }

        const daysToAdjust = Math.min(stats.absentDays, maxCLPerMonth, clAvailable);

        if (daysToAdjust > 0) {
            stats.autoAdjustedCL = daysToAdjust;
            stats.paidLeaveDays += daysToAdjust;
            stats.clUsedDays += daysToAdjust;
            stats.absentDays -= daysToAdjust;
            payableDays += daysToAdjust;
            lopDays -= daysToAdjust;

            let remaining = daysToAdjust;
            for (const day of dayBreakdown) {
                if (remaining <= 0) break;
                if (day.category === "AB" && !day.preJoining) {
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

    const divisor = daysInMonth;

    const fullGross = Number(employee.salary?.gross || 0);
    const fullBasic = Number(employee.salary?.basic || 0);
    const fullHra = Number(employee.salary?.hra || 0);

    const perDayRate = fullGross / Math.max(1, divisor);

    let sundayExtraPayDays = 0;
    if (settings.sundayWorkExtraPay && stats.workingSundayDays > 0) {
        sundayExtraPayDays = stats.workingSundayDays;
    }

    const effectivePayableDays = payableDays + sundayExtraPayDays;

    const grossEarned = roundMoney(perDayRate * effectivePayableDays, settings.roundingMode);

    const basicRatio = fullGross > 0 ? fullBasic / fullGross : 0.5;
    const hraRatio = fullGross > 0 ? fullHra / fullGross : 0.5;

    const basicEarned = roundMoney(grossEarned * basicRatio, settings.roundingMode);
    const hraEarned = grossEarned - basicEarned;
    const specialEarned = 0;

    const epfCap = salaryCfg?.epfCapAmount ?? 1800;
    const eepfPct = (salaryCfg?.eepfPct ?? 12) / 100;
    const eeEsicPct = (salaryCfg?.eeEsicPct ?? 0.75) / 100;
    const esiLimit = salaryCfg?.esiWageLimit ?? 21000;

    const epf = Math.round(Math.min(basicEarned * eepfPct, epfCap));
    const esiApplicable = basicEarned > 0 && basicEarned <= esiLimit;
    const esic = esiApplicable ? Math.ceil(basicEarned * eeEsicPct) : 0;
    const pt = (settings.ptEnabled && settings.ptForBasic) ? settings.ptForBasic(basicEarned) : 0;

    const totalDeductions = epf + esic + pt;
    const netPay = grossEarned - totalDeductions;
    const roundedNetPay = settings.roundNetPay ? Math.round(netPay) : netPay;

    const leaveBalanceSnapshot = (() => {
        const clEnt = clEligible ? (leaveBalance?.entitlement?.CL ?? CL_ENT_DEFAULT) : 0;
        const slEnt = leaveBalance?.entitlement?.SL ?? SL_ENT_DEFAULT;
        const plEnt = (leaveBalance?.entitlement?.PL ?? leaveBalance?.entitlement?.EL ?? PL_ENT_DEFAULT);
        const clCon = leaveBalance?.consumed?.CL ?? 0;
        const slCon = leaveBalance?.consumed?.SL ?? 0;
        const plCon = leaveBalance?.consumed?.PL ?? leaveBalance?.consumed?.EL ?? 0;
        return {
            hasRecord: !!leaveBalance,
            clEligible,
            daysSinceDOJ: daysSinceDOJ === Infinity ? null : daysSinceDOJ,
            entitlement: { CL: clEnt, SL: slEnt, PL: plEnt },
            consumed: { CL: clCon, SL: slCon, PL: plCon },
            available: {
                CL: Math.max(0, clEnt - clCon),
                SL: Math.max(0, slEnt - slCon),
                PL: Math.max(0, plEnt - plCon),
            },
        };
    })();

    return {
        employeeId: employee._id,
        employeeName: [employee.firstName, employee.middleName, employee.lastName].filter(Boolean).join(" "),
        biometricId: (employee.biometricId || "").toUpperCase(),
        department: employee.department || "",
        designation: employee.designation || employee.jobTitle || "",
        jobTitle: employee.jobTitle || "",
        employmentType: employee.employmentType || "",
        dateOfJoining: employee.dateOfJoining || null,

        month, year,
        payPeriod: `${MONTH_NAMES[month]} ${year}`,

        rateBasic: fullBasic,
        rateHra: fullHra,
        rateGross: fullGross,

        preJoiningDays,
        firstActiveDayInMonth: firstActiveDay,
        activeDaysInMonth,
        clEligible,
        daysSinceDOJ: daysSinceDOJ === Infinity ? null : daysSinceDOJ,

        leaveBalanceSnapshot,

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
            employerPF: epf,
            esic: esic,
            employerESIC: esiApplicable ? Math.ceil(basicEarned * (((salaryCfg?.erEsicPct) ?? 3.25) / 100)) : 0,
            professionalTax: pt,
            incomeTax: 0,
            loanDeduction: 0,
            advanceDeduction: 0,
            lateDeduction: 0,
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

// ═══════════════════════════════════════════════════════════════════════════
//  HELPER: Send push notifications for payroll events
//  *** EXTRACTED & FIXED — single source of truth for push logic ***
// ═══════════════════════════════════════════════════════════════════════════

async function sendPayrollPushNotifications(month, year, type = "generated", employeeIdFilter = null) {
    const result = { sent: 0, failed: 0, details: [] };

    try {
        // *** FIXED: Query excludes both null AND empty string ***
        const tokenQuery = {
            pushToken: { $exists: true, $nin: [null, ""] },
            $or: [{ status: "active" }, { isActive: true }],
        };

        // If filtering by specific employees (e.g., mark-paid only for paid items)
        if (employeeIdFilter && employeeIdFilter.length > 0) {
            tokenQuery._id = { $in: employeeIdFilter };
        }

        console.log(`[PAYROLL-PUSH-${type.toUpperCase()}] ── Querying employees...`);
        console.log(`[PAYROLL-PUSH-${type.toUpperCase()}] Query:`, JSON.stringify(tokenQuery));

        const empWithTokens = await Employee.find(tokenQuery)
            .select("pushToken firstName lastName profilePhoto")
            .lean();

        console.log(`[PAYROLL-PUSH-${type.toUpperCase()}] Found ${empWithTokens.length} employee(s) with push tokens`);

        if (empWithTokens.length === 0) {
            console.warn(`[PAYROLL-PUSH-${type.toUpperCase()}] ❌ No employees with valid push tokens found!`);
            console.warn(`[PAYROLL-PUSH-${type.toUpperCase()}]    Run this MongoDB query to check:`);
            console.warn(`[PAYROLL-PUSH-${type.toUpperCase()}]    db.employees.find({pushToken:{$nin:[null,""]}, $or:[{status:"active"},{isActive:true}]}, {firstName:1, pushToken:1})`);
            return result;
        }

        const messages = [];
        const skippedInvalid = [];

        for (const emp of empWithTokens) {
            if (!Expo.isExpoPushToken(emp.pushToken)) {
                console.warn(`[PAYROLL-PUSH-${type.toUpperCase()}] ⚠ Invalid token for ${emp.firstName}: "${emp.pushToken}" — cleaning up`);
                skippedInvalid.push(emp._id);
                continue;
            }

            const title = type === "paid"
                ? "Salary Credited"
                : "Payslip Generated";
            const body = type === "paid"
                ? `Hi ${emp.firstName}, your salary for ${MONTH_NAMES[month]} ${year} has been credited to your account. Tap to view your payslip.`
                : `Hi ${emp.firstName}, your payslip for ${MONTH_NAMES[month]} ${year} has been processed. Open the app to view details.`;

            messages.push({
                to: emp.pushToken,
                sound: "default",
                title,
                body,
                data: {
                    type: "payroll",
                    month,
                    year,
                    screen: "Salary",
                    profilePhoto: emp.profilePhoto?.url || null,
                },
                categoryId: "payroll",
                channelId: "payroll",
                priority: "high",
                badge: 1,
            });
            console.log(`[PAYROLL-PUSH-${type.toUpperCase()}]   → ${emp.firstName} ${emp.lastName || ""} | ${emp.pushToken.substring(0, 35)}...`);
        }

        // Clean up invalid tokens
        if (skippedInvalid.length > 0) {
            await Employee.updateMany(
                { _id: { $in: skippedInvalid } },
                { $set: { pushToken: null } }
            ).catch(e => console.warn("[PAYROLL-PUSH] Cleanup error:", e.message));
            console.log(`[PAYROLL-PUSH-${type.toUpperCase()}] Cleaned ${skippedInvalid.length} invalid token(s)`);
        }

        if (messages.length === 0) {
            console.warn(`[PAYROLL-PUSH-${type.toUpperCase()}] No valid messages to send after filtering`);
            return result;
        }

        console.log(`[PAYROLL-PUSH-${type.toUpperCase()}] Sending ${messages.length} notification(s) via Expo...`);

        const chunks = expo.chunkPushNotifications(messages);
        const staleTokenIds = [];

        for (const chunk of chunks) {
            try {
                const receipts = await expo.sendPushNotificationsAsync(chunk);
                console.log(`[PAYROLL-PUSH-${type.toUpperCase()}] Receipts:`, JSON.stringify(receipts));

                for (let i = 0; i < receipts.length; i++) {
                    const receipt = receipts[i];
                    if (receipt.status === "ok") {
                        result.sent++;
                        console.log(`[PAYROLL-PUSH-${type.toUpperCase()}] ✓ OK → ${chunk[i].to.substring(0, 35)}...`);
                    } else {
                        result.failed++;
                        console.warn(`[PAYROLL-PUSH-${type.toUpperCase()}] ✗ FAIL → ${chunk[i].to}: ${receipt.message || JSON.stringify(receipt.details)}`);

                        // Mark stale device tokens for cleanup
                        if (receipt.details?.error === "DeviceNotRegistered") {
                            const staleEmp = empWithTokens.find(e => e.pushToken === chunk[i].to);
                            if (staleEmp) staleTokenIds.push(staleEmp._id);
                        }
                    }
                }
            } catch (chunkErr) {
                console.error(`[PAYROLL-PUSH-${type.toUpperCase()}] CHUNK ERROR:`, chunkErr.message);
                result.failed += chunk.length;
            }
        }

        // Clean up DeviceNotRegistered tokens
        if (staleTokenIds.length > 0) {
            await Employee.updateMany(
                { _id: { $in: staleTokenIds } },
                { $set: { pushToken: null } }
            ).catch(e => console.warn("[PAYROLL-PUSH] Stale cleanup error:", e.message));
            console.log(`[PAYROLL-PUSH-${type.toUpperCase()}] Cleaned ${staleTokenIds.length} stale (DeviceNotRegistered) token(s)`);
        }

        console.log(`[PAYROLL-PUSH-${type.toUpperCase()}] ══ DONE: ${result.sent} sent, ${result.failed} failed ══`);
    } catch (pushErr) {
        console.error(`[PAYROLL-PUSH-${type.toUpperCase()}] ❌ CRITICAL ERROR:`, pushErr.message);
        console.error(`[PAYROLL-PUSH-${type.toUpperCase()}] Stack:`, pushErr.stack);
        result.error = pushErr.message;
    }

    return result;
}

// ═════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /preview ──────────────────────────────────────────────────────────────
router.get("/preview", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        if (month < 1 || month > 12) {
            return res.status(400).json({ success: false, message: "Invalid month" });
        }

        const { settings, salaryCfg, holidayMap, attendanceByEmp, leaveConfig } = await loadMonthContext(month, year);

        const employees = await Employee.find({
            $or: [{ status: "active" }, { isActive: true }],
        })
            .select("-password -temporaryPassword -__v")
            .lean();

        const decryptedEmployees = employees.map(decryptEmployeeDoc);

        const leaveBalances = await LeaveBalance.find({
            employeeId: { $in: employees.map((e) => e._id) },
            year,
        }).lean();
        const balanceByEmpId = new Map(leaveBalances.map((b) => [String(b.employeeId), b]));

        const items = decryptedEmployees.map((emp) => {
            const bid = (emp.biometricId || "").toUpperCase();
            const ctx = {
                month, year, settings, salaryCfg, holidayMap, leaveConfig,
                attendanceByDate: attendanceByEmp.get(bid) || new Map(),
                leaveBalance: balanceByEmpId.get(String(emp._id)) || null,
            };
            return computeEmployeePayroll(emp, ctx);
        });

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

// ── POST /run ─────────────────────────────────────────────────────────────────
router.post("/run", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        if (user.role !== "hr_manager") {
            return res.status(403).json({ success: false, message: "Only HR managers can run payroll" });
        }

        const month = parseInt(req.body.month) || new Date().getMonth() + 1;
        const year = parseInt(req.body.year) || new Date().getFullYear();

        const existing = await Payroll.findOne({ month, year });
        if (existing && ["paid", "approved"].includes(existing.status)) {
            return res.status(400).json({
                success: false,
                message: `Payroll for ${MONTH_NAMES[month]} ${year} is already ${existing.status} and cannot be re-run`,
            });
        }

        const { settings, salaryCfg, holidayMap, attendanceByEmp, leaveConfig } = await loadMonthContext(month, year);

        const employees = await Employee.find({
            $or: [{ status: "active" }, { isActive: true }],
        })
            .select("-password -temporaryPassword -__v")
            .lean();

        const decryptedEmployees = employees.map(decryptEmployeeDoc);

        const leaveBalances = await LeaveBalance.find({
            employeeId: { $in: employees.map((e) => e._id) }, year,
        });
        const balanceByEmpId = new Map(leaveBalances.map((b) => [String(b.employeeId), b]));

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

        let totalGross = 0, totalDed = 0, totalNet = 0, totalPF = 0, totalESIC = 0, totalBonus = 0;
        const clBalanceUpdates = [];

        for (const emp of decryptedEmployees) {
            const bid = (emp.biometricId || "").toUpperCase();
            const balance = balanceByEmpId.get(String(emp._id)) || null;
            const ctx = {
                month, year, settings, salaryCfg, holidayMap, leaveConfig,
                attendanceByDate: attendanceByEmp.get(bid) || new Map(),
                leaveBalance: balance,
            };
            const computed = computeEmployeePayroll(emp, ctx);

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
                    dateOfJoining: computed.dateOfJoining,
                    payrollId: payrollRun._id,
                    month, year,
                    payPeriod: computed.payPeriod,

                    rateBasic: computed.rateBasic,
                    rateHra: computed.rateHra,
                    rateGross: computed.rateGross,

                    preJoiningDays: computed.preJoiningDays,
                    firstActiveDayInMonth: computed.firstActiveDayInMonth,
                    activeDaysInMonth: computed.activeDaysInMonth,
                    clEligible: computed.clEligible,
                    daysSinceDOJ: computed.daysSinceDOJ,

                    workingDays: computed.workingDays,
                    daysInMonth: computed.daysInMonth,
                    presentDays: computed.presentDays,
                    absentDays: computed.absentDays,
                    halfDays: computed.halfDays,
                    missPunchDays: computed.missPunchDays,
                    lopDays: computed.lopDays,
                    paidLeaveDays: computed.paidLeaveDays,
                    weekOffDays: computed.weekOffDays,
                    holidayDays: computed.holidayDays,
                    holidayWorkedDays: computed.holidayWorkedDays,
                    sundayWorkedDays: computed.sundayWorkedDays,
                    lwpDays: computed.lwpDays,
                    clUsedDays: computed.clUsedDays,
                    slUsedDays: computed.slUsedDays,
                    plUsedDays: computed.plUsedDays,

                    payableDays: computed.payableDays,
                    effectivePayableDays: computed.effectivePayableDays,
                    perDayRate: computed.perDayRate,
                    divisorBasis: computed.divisorBasis,
                    sundayExtraPayDays: computed.sundayExtraPayDays,

                    autoAdjustedCL: computed.autoAdjustedCL,
                    sundayOffsetApplied: computed.sundayOffsetApplied,
                    unsyncedDays: computed.unsyncedDays,

                    leaveBalanceSnapshot: computed.leaveBalanceSnapshot,

                    earnings: computed.earnings,
                    deductions: computed.deductions,
                    netPay: computed.netPay,
                    roundedNetPay: computed.roundedNetPay,
                    bankDetails: computed.bankDetails,
                    dayBreakdown: computed.dayBreakdown,

                    status: "processed",
                    processedBy: user.id,
                    processedAt: new Date(),
                    isManuallyOverridden: false,
                    overriddenPayableDays: null,
                    remarks: computed.autoAdjustedCL > 0
                        ? `Auto-adjusted ${computed.autoAdjustedCL} day(s) from AB to CL`
                        : (computed.sundayOffsetApplied > 0
                            ? `${computed.sundayOffsetApplied} AB offset by Sunday worked`
                            : computed.preJoiningDays > 0
                                ? `Mid-month joiner — ${computed.preJoiningDays} pre-joining day(s) excluded`
                                : null),
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

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

        for (const u of clBalanceUpdates) {
            await LeaveBalance.updateOne(
                { _id: u.balanceId },
                { $inc: { "consumed.CL": u.days } }
            );
        }

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

        // *** FIXED: Use the extracted helper with corrected query ***
        // No push notification on /run — only sent when marked as paid

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

// ── GET /items ────────────────────────────────────────────────────────────────
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
            const clEligible = it.clEligible !== false;
            const clEnt = clEligible ? (b?.entitlement?.CL ?? clDef) : 0;
            const slEnt = b?.entitlement?.SL ?? slDef;
            const plEnt = b?.entitlement?.PL ?? b?.entitlement?.EL ?? plDef;
            const clCon = b?.consumed?.CL ?? 0;
            const slCon = b?.consumed?.SL ?? 0;
            const plCon = b?.consumed?.PL ?? b?.consumed?.EL ?? 0;
            it.leaveBalanceSnapshot = {
                hasRecord: !!b,
                clEligible,
                daysSinceDOJ: it.daysSinceDOJ ?? null,
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

// ── GET /item/:id ─────────────────────────────────────────────────────────────
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

// ── PUT /item/:id ─────────────────────────────────────────────────────────────
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
        await item.save();
        res.json({ success: true, data: item.toObject() });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── PATCH /item/:id/override ──────────────────────────────────────────────────
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
        const empSalary = decryptSalaryFields(employee.salary || {});
        const salaryCfg = await SalaryConfig.getSingleton();

        const {
            payableDays,
            lopDays,
            clUsedDays,
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

        const divisor = item.workingDays || new Date(item.year, item.month, 0).getDate() || 31;
        const activeCap = (item.preJoiningDays > 0 && item.activeDaysInMonth != null)
            ? item.activeDaysInMonth
            : divisor;

        const fullGross = Number(item.rateGross || empSalary.gross || 0);
        const fullBasic = Number(item.rateBasic || empSalary.basic || 0);
        const fullHra = Number(item.rateHra || empSalary.hra || 0);

        if (fullGross <= 0) {
            return res.status(400).json({ success: false, message: "Employee has no gross salary set" });
        }

        let newPayableDays;
        let newLopDays;
        if (payableDays !== undefined) {
            newPayableDays = Math.max(0, Math.min(Number(payableDays), activeCap));
        } else {
            newPayableDays = item.payableDays ?? ((item.presentDays || 0) + (item.paidLeaveDays || 0));
        }
        if (lopDays !== undefined) {
            newLopDays = Math.max(0, Math.min(Number(lopDays), activeCap));
        } else {
            newLopDays = item.lopDays ?? 0;
        }

        const perDay = fullGross / Math.max(1, divisor);
        const basicRatio = fullBasic / Math.max(1, fullGross);

        const grossEarnedBase = Math.round(perDay * newPayableDays);
        const basicEarned = Math.round(grossEarnedBase * basicRatio);
        const hraEarned = grossEarnedBase - basicEarned;
        const specialEarned = 0;

        const ot = overtime !== undefined ? Number(overtime) : (item.earnings?.overtime || 0);
        const bn = bonus !== undefined ? Number(bonus) : (item.earnings?.bonus || 0);
        const inc = incentives !== undefined ? Number(incentives) : (item.earnings?.incentives || 0);
        const oth = otherEarnings !== undefined ? Number(otherEarnings) : (item.earnings?.otherEarnings || 0);

        const grossTotal = grossEarnedBase + ot + bn + inc + oth;

        const epfCap = salaryCfg?.epfCapAmount ?? 1800;
        const eepfPct = (salaryCfg?.eepfPct ?? 12) / 100;
        const eeEsicPct = (salaryCfg?.eeEsicPct ?? 0.75) / 100;
        const erEsicPct = (salaryCfg?.erEsicPct ?? 3.25) / 100;
        const esiLimit = salaryCfg?.esiWageLimit ?? 21000;

        const epf = Math.round(Math.min(basicEarned * eepfPct, epfCap));
        const esiApplicable = basicEarned > 0 && basicEarned <= esiLimit;
        const esic = esiApplicable ? Math.ceil(basicEarned * eeEsicPct) : 0;
        const erEsic = esiApplicable ? Math.ceil(basicEarned * erEsicPct) : 0;
        const pt = (settings.ptEnabled && settings.ptForBasic) ? settings.ptForBasic(basicEarned) : 0;

        const loan = loanDeduction !== undefined ? Number(loanDeduction) : (item.deductions?.loanDeduction || 0);
        const advance = advanceDeduction !== undefined ? Number(advanceDeduction) : (item.deductions?.advanceDeduction || 0);
        const otherD = otherDeductions !== undefined ? Number(otherDeductions) : (item.deductions?.otherDeductions || 0);

        const totalDeductions = epf + esic + pt + loan + advance + otherD;
        const netPay = grossTotal - totalDeductions;

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

        item.payableDays = newPayableDays;
        item.lopDays = newLopDays;
        if (clUsedDays !== undefined) item.clUsedDays = Math.max(0, Number(clUsedDays));
        if (slUsedDays !== undefined) item.slUsedDays = Math.max(0, Number(slUsedDays));
        if (plUsedDays !== undefined) item.plUsedDays = Math.max(0, Number(plUsedDays));

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
            data: item.toObject(),
        });
    } catch (err) {
        console.error("[PAYROLL-OVERRIDE]", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── PATCH /mark-paid ──────────────────────────────────────────────────────────
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

        // *** FIXED: Use the extracted helper with corrected query ***
        let pushResult = { sent: 0, failed: 0 };
        if (result.modifiedCount > 0) {
            // Get employee IDs from paid items to target notifications
            const paidItems = await PayrollItem.find({ month, year, status: "paid" })
                .select("employeeId")
                .lean();
            const employeeIds = paidItems.map(i => i.employeeId);

            pushResult = await sendPayrollPushNotifications(month, year, "paid", employeeIds);
        } else {
            console.log(`[PAYROLL-MARK-PAID] No items were modified (already paid or no processed items)`);
        }

        res.json({
            success: true,
            message: `${result.modifiedCount} items marked as paid`,
            pushNotifications: pushResult,
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── GET /runs ─────────────────────────────────────────────────────────────────
router.get("/runs", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const runs = await Payroll.find().sort({ year: -1, month: -1 }).limit(24).lean();
        res.json({ success: true, data: runs });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── GET /settings ─────────────────────────────────────────────────────────────
router.get("/settings", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const cfg = await PayrollSettings.getConfig();
        res.json({ success: true, data: cfg });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── PUT /settings ─────────────────────────────────────────────────────────────
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

        const before = await PayrollSettings.findById("singleton").lean();

        const cfg = await PayrollSettings.findByIdAndUpdate(
            "singleton", { $set: update },
            { new: true, upsert: true, runValidators: true }
        );

        try {
            const changes = diffPayrollSettings(before, cfg, req.body);
            if (changes.length > 0) {
                let EmailService;
                try { EmailService = require("../../service/emailService"); } catch (e) {
                    console.warn("[PAYROLL-SETTINGS] emailService not found, skipping CEO notification");
                }
                if (EmailService?.sendPayrollSettingsChangeEmail) {
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

function diffPayrollSettings(oldCfg, newCfg, requestBody) {
    if (!oldCfg) oldCfg = {};
    const changes = [];
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

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

// ═════════════════════════════════════════════════════════════════════════════
//  GET /export
// ═════════════════════════════════════════════════════════════════════════════
router.get("/export", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const ExcelJS = require("exceljs");
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        const items = await PayrollItem.find({ month, year })
            .sort({ department: 1, employeeName: 1 })
            .lean();

        if (items.length === 0) {
            return res.status(404).json({
                success: false,
                message: `No payroll items for ${MONTH_NAMES[month]} ${year}. Process payroll first.`,
            });
        }

        const employees = await Employee.find({
            _id: { $in: items.map((i) => i.employeeId) },
        })
            .select("firstName middleName lastName biometricId designation jobTitle department salary bankDetails dateOfJoining")
            .lean();

        const empById = new Map(
            employees.map((e) => [String(e._id), decryptEmployeeDoc(e)])
        );

        const wb = new ExcelJS.Workbook();
        wb.creator = "Grav Clothing HRMS";

        const ws = wb.addWorksheet("SalarySheetTab", {
            views: [{ state: "frozen", ySplit: 4 }],
            pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1 },
        });

        const COL_WIDTHS = [
            3, 12, 30, 20, 22, 13, 11, 11, 14, 10, 10, 13, 11, 11, 13, 11, 11, 11, 11, 11, 14, 13,
        ];
        COL_WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

        const HDR = {
            identity: "FF1E293B", rate: "FF1D4ED8", days: "FF0E7490",
            earned: "FF166534", ded: "FF9F1239", net: "FF065F46",
        };
        const TINT = {
            identity: "FFFFFFFF", rate: "FFEFF6FF", days: "FFF0FDFA",
            earned: "FFF0FDF4", ded: "FFFFF1F2", net: "FFD1FAE5",
        };
        const STRIPE = "FFF1F5F9";

        function hdrFill(colNum) {
            if (colNum >= 2 && colNum <= 5) return HDR.identity;
            if (colNum >= 6 && colNum <= 9) return HDR.rate;
            if (colNum >= 10 && colNum <= 11) return HDR.days;
            if (colNum >= 12 && colNum <= 15) return HDR.earned;
            if (colNum >= 16 && colNum <= 21) return HDR.ded;
            if (colNum === 22) return HDR.net;
            return HDR.identity;
        }

        function cellFill(colNum, isEvenRow) {
            if (colNum === 22) return TINT.net;
            const base =
                colNum >= 2 && colNum <= 5 ? TINT.identity :
                    colNum >= 6 && colNum <= 9 ? TINT.rate :
                        colNum >= 10 && colNum <= 11 ? TINT.days :
                            colNum >= 12 && colNum <= 15 ? TINT.earned :
                                colNum >= 16 && colNum <= 21 ? TINT.ded : "FFFFFFFF";
            if (isEvenRow && colNum !== 22 && !(colNum >= 6 && colNum <= 9)) {
                return STRIPE;
            }
            return base;
        }

        const solid = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
        const border = (t = "thin", argb = "FFD1D5DB") => ({
            top: { style: t, color: { argb } }, bottom: { style: t, color: { argb } },
            left: { style: t, color: { argb } }, right: { style: t, color: { argb } },
        });

        ws.mergeCells(1, 1, 1, 22);
        const r1 = ws.getCell(1, 1);
        r1.value = `GRAV CLOTHING  ·  Salary Sheet  ·  ${MONTH_NAMES[month]} ${year}`;
        r1.font = { name: "Arial", size: 13, bold: true, color: { argb: "FFFFFFFF" } };
        r1.fill = solid("FF5B21B6");
        r1.alignment = { horizontal: "center", vertical: "middle" };
        ws.getRow(1).height = 30;

        ws.mergeCells(2, 1, 2, 22);
        const r2 = ws.getCell(2, 1);
        r2.value = `Selection :- ${MONTH_NAMES[month].slice(0, 3).toUpperCase()}-${year}`;
        r2.font = { name: "Arial", size: 10, bold: true, color: { argb: "FF4C1D95" } };
        r2.fill = solid("FFEDE9FE");
        r2.alignment = { horizontal: "left", vertical: "middle", indent: 1 };
        ws.getRow(2).height = 18;

        const SECTIONS = [
            { start: 2, end: 5, label: "Employee Details", bg: "FF1E293B" },
            { start: 6, end: 9, label: "Monthly CTC", bg: "FF1D4ED8" },
            { start: 10, end: 11, label: "Attendance", bg: "FF0E7490" },
            { start: 12, end: 15, label: "Earned This Month", bg: "FF166534" },
            { start: 16, end: 21, label: "Deductions", bg: "FF9F1239" },
            { start: 22, end: 22, label: "Net Salary", bg: "FF065F46" },
        ];
        SECTIONS.forEach(({ start, end, label, bg }) => {
            if (start !== end) ws.mergeCells(3, start, 3, end);
            const cell = ws.getCell(3, start);
            cell.value = label;
            cell.font = { name: "Arial", size: 7.5, bold: true, color: { argb: "FFFFFFFF" }, italic: true };
            cell.fill = solid(bg);
            cell.alignment = { horizontal: "center", vertical: "middle" };
            cell.border = border("thin", "FF000000");
        });
        ws.getRow(3).height = 13;

        const HEADERS = [
            "", "Emp Code", "Name", "Department", "Designation",
            "Gross Salary", "Basic", "HRA", "Food\nAllowance",
            "No. of Days\nof the Month", "Actual Days\nWork Done",
            "Gross Salary", "BAS", "HRA", "Tot Earnings",
            "ESIEMPLYE", "ESIEMPR", "LN/ADV", "PFEMPCONT", "PFEMPR",
            "Tot Deductions", "Net Salary",
        ];

        const hRow = ws.getRow(4);
        HEADERS.forEach((label, i) => {
            const colNum = i + 1;
            const cell = hRow.getCell(colNum);
            cell.value = label;
            if (!label) return;
            cell.font = { name: "Arial", size: 9, bold: true, color: { argb: "FFFFFFFF" } };
            cell.fill = solid(hdrFill(colNum));
            cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
            cell.border = border("thin", "FF00000033");
        });
        hRow.height = 38;

        const DATA_START = 5;
        const daysInMonth = new Date(year, month, 0).getDate();
        const moneyFmt = "#,##0";
        const daysFmt = "0.##";

        items.forEach((it, idx) => {
            const emp = empById.get(String(it.employeeId)) || {};
            const e = it.earnings || {};
            const d = it.deductions || {};
            const foodAllow = Number(emp.salary?.foodAllowance || 0);
            const lnAdv = (d.loanDeduction || 0) + (d.advanceDeduction || 0);
            const grossEarned = e.grossEarnings || 0;
            const isEvenRow = idx % 2 === 1;

            const values = [
                "", it.biometricId || "", it.employeeName || "", it.department || "", it.designation || "",
                it.rateGross || 0, it.rateBasic || 0, it.rateHra || 0, foodAllow,
                daysInMonth, it.payableDays ?? 0,
                grossEarned, e.basicSalary || 0, e.houseRentAllowance || 0, grossEarned,
                d.esic || 0, d.employerESIC || 0, lnAdv, d.providentFund || 0, d.employerPF || d.providentFund || 0,
                d.totalDeductions || 0, it.roundedNetPay ?? it.netPay ?? 0,
            ];

            const row = ws.getRow(DATA_START + idx);
            values.forEach((v, i) => { row.getCell(i + 1).value = v; });

            row.eachCell({ includeEmpty: true }, (cell, colNum) => {
                if (colNum === 1) return;
                cell.font = { name: "Arial", size: 9 };
                cell.fill = solid(cellFill(colNum, isEvenRow));
                cell.alignment = {
                    vertical: "middle",
                    horizontal: colNum <= 5 ? "left" : "right",
                    indent: colNum >= 2 && colNum <= 5 ? 1 : 0,
                };
                if (colNum >= 6 && colNum !== 10) {
                    cell.numFmt = colNum === 11 ? daysFmt : moneyFmt;
                }
                cell.border = border("thin");
                if (colNum === 22) {
                    cell.font = { name: "Arial", size: 9, bold: true, color: { argb: "FF065F46" } };
                }
                if (colNum === 21) {
                    cell.font = { name: "Arial", size: 9, bold: true, color: { argb: "FF9F1239" } };
                }
            });
            row.height = 19;
        });

        const sumRow = ws.getRow(DATA_START + items.length);
        sumRow.getCell(2).value = "Summary";
        sumRow.getCell(3).value = `Count - ${items.length}`;

        const totals = {
            6: items.reduce((a, i) => a + (i.rateGross || 0), 0),
            7: items.reduce((a, i) => a + (i.rateBasic || 0), 0),
            8: items.reduce((a, i) => a + (i.rateHra || 0), 0),
            9: items.reduce((a, i) => a + Number(empById.get(String(i.employeeId))?.salary?.foodAllowance || 0), 0),
            10: daysInMonth,
            11: items.reduce((a, i) => a + (i.payableDays || 0), 0),
            12: items.reduce((a, i) => a + (i.earnings?.grossEarnings || 0), 0),
            13: items.reduce((a, i) => a + (i.earnings?.basicSalary || 0), 0),
            14: items.reduce((a, i) => a + (i.earnings?.houseRentAllowance || 0), 0),
            15: items.reduce((a, i) => a + (i.earnings?.grossEarnings || 0), 0),
            16: items.reduce((a, i) => a + (i.deductions?.esic || 0), 0),
            17: items.reduce((a, i) => a + (i.deductions?.employerESIC || 0), 0),
            18: items.reduce((a, i) => a + ((i.deductions?.loanDeduction || 0) + (i.deductions?.advanceDeduction || 0)), 0),
            19: items.reduce((a, i) => a + (i.deductions?.providentFund || 0), 0),
            20: items.reduce((a, i) => a + (i.deductions?.employerPF || i.deductions?.providentFund || 0), 0),
            21: items.reduce((a, i) => a + (i.deductions?.totalDeductions || 0), 0),
            22: items.reduce((a, i) => a + (i.roundedNetPay ?? i.netPay ?? 0), 0),
        };

        Object.entries(totals).forEach(([col, val]) => {
            sumRow.getCell(parseInt(col)).value = val;
        });

        sumRow.eachCell({ includeEmpty: false }, (cell, colNum) => {
            if (colNum === 1) return;
            const sumFill =
                colNum >= 2 && colNum <= 5 ? "FFFBFAFF" :
                    colNum >= 6 && colNum <= 9 ? "FFDBEAFE" :
                        colNum >= 10 && colNum <= 11 ? "FFCFFAFE" :
                            colNum >= 12 && colNum <= 15 ? "FFDCFCE7" :
                                colNum >= 16 && colNum <= 21 ? "FFFFE4E6" :
                                    colNum === 22 ? "FFA7F3D0" : "FFFEFCE8";

            cell.font = {
                name: "Arial", size: 9, bold: true,
                color: { argb: colNum === 22 ? "FF065F46" : colNum === 21 ? "FF9F1239" : "FF111827" },
            };
            cell.fill = solid(sumFill);
            cell.alignment = {
                vertical: "middle",
                horizontal: colNum <= 5 ? "left" : "right",
                indent: colNum >= 2 && colNum <= 5 ? 1 : 0,
            };
            if (colNum >= 6 && colNum !== 10) {
                cell.numFmt = colNum === 11 ? daysFmt : moneyFmt;
            }
            cell.border = {
                top: { style: "medium", color: { argb: "FF000000" } },
                bottom: { style: "medium", color: { argb: "FF000000" } },
                left: { style: "thin", color: { argb: "FFD1D5DB" } },
                right: { style: "thin", color: { argb: "FFD1D5DB" } },
            };
        });
        sumRow.height = 22;

        const buffer = await wb.xlsx.writeBuffer();
        const filename = `salary_sheet_${year}-${String(month).padStart(2, "0")}.xlsx`;
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(buffer);
    } catch (err) {
        console.error("[PAYROLL-EXPORT]", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── DELETE /run ───────────────────────────────────────────────────────────────
router.delete("/run", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        if (user.role !== "hr_manager") {
            return res.status(403).json({ success: false, message: "Only HR managers can delete a payroll run" });
        }

        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        const run = await Payroll.findOne({ month, year });
        if (!run) {
            return res.status(404).json({ success: false, message: "No payroll run found for this period" });
        }
        if (["paid", "approved"].includes(run.status)) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete a payroll run that is already ${run.status}`,
            });
        }

        await PayrollItem.deleteMany({ month, year });
        await Payroll.deleteOne({ _id: run._id });

        res.json({ success: true, message: `Payroll run for ${MONTH_NAMES[month]} ${year} deleted` });
    } catch (err) {
        console.error("[PAYROLL-DELETE-RUN]", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
module.exports.computeEmployeePayroll = computeEmployeePayroll;
module.exports.loadMonthContext = loadMonthContext;