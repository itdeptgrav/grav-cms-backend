/**
 * Attendance_section.js  –  v4  (GRAV Clothing)
 * ─────────────────────────────────────────────────────────────────────────────
 * Route: mounted at /hr/attendance
 *
 * KEY FIXES:
 *  1. Uses BOTH eTimeOffice APIs:
 *     - DownloadInOutPunchData  → primary (INTime, OUTTime, WorkTime, OT, Status)
 *     - DownloadPunchDataMCID   → secondary (individual punches with mcid for break detail)
 *  2. No node-cron. Every filter change triggers auto-fetch from TeamOffice.
 *  3. Monthly view: auto-fetches the entire month on first request.
 *  4. Present count fix: counts employees, not punch events.
 *  5. 1 check-in → MP (not absent). Only 0 punches = absent.
 *  6. Settings save actually works.
 *  7. Master-roll export: month selector + proper GRAV format.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const express = require("express");
const router = express.Router();
const axios = require("axios");

const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const Employee = require("../../models/Employee");
const { AttendanceSettings, Shift } = require("../../models/HR_Models/Attendancesettings");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");
const {
    minsToHHMM,
    parseInOutResponse,
    parsePunchDataResponse,
    buildAttendanceRecord,
    buildPlaceholderRecord,
} = require("../../services/Attendanceengine");

// ── TeamOffice API helpers ───────────────────────────────────────────────────

function getTeamOfficeConfig() {
    const base = (process.env.TEAMOFFICE_BASE_URL || "https://api.etimeoffice.com/api").replace(/\/+$/, "");
    const authToken = process.env.TEAMOFFICE_AUTH_TOKEN; // pre-encoded base64 string
    const username = process.env.TEAMOFFICE_USERNAME;
    const password = process.env.TEAMOFFICE_PASSWORD;
    const corpId = process.env.TEAMOFFICE_CORP_ID || "";

    let authHeader = "";
    if (authToken) {
        authHeader = `Basic ${authToken}`;
    } else if (username && password) {
        const raw = corpId
            ? `${corpId}:${username}:${password}:true`
            : `${username}:${password}`;
        authHeader = `Basic ${Buffer.from(raw).toString("base64")}`;
    }
    return { base, authHeader };
}

/**
 * Format a "YYYY-MM-DD" date to the eTimeOffice format.
 * DownloadInOutPunchData uses "MM/DD/YYYY"
 * DownloadPunchDataMCID uses "DD/MM/YYYY_HH:mm"
 */
function toEtimeInOutDate(dateStr) {
    const [y, m, d] = dateStr.split("-");
    return `${m}/${d}/${y}`;                     // MM/DD/YYYY
}

function toEtimePunchDate(dateStr, time = "00:00") {
    const [y, m, d] = dateStr.split("-");
    return `${d}/${m}/${y}_${time}`;             // DD/MM/YYYY_HH:mm
}

async function fetchInOutData(fromDate, toDate, empCode = "ALL") {
    const { base, authHeader } = getTeamOfficeConfig();
    const url = `${base}/DownloadInOutPunchData`;
    const params = {
        Empcode: empCode,
        FromDate: toEtimeInOutDate(fromDate),
        ToDate: toEtimeInOutDate(toDate),
    };
    const headers = authHeader ? { Authorization: authHeader } : {};

    // Build the full URL for easy Postman testing
    const queryString = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const fullUrl = `${url}?${queryString}`;

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🔵 [TeamOffice] InOut API Request");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  URL    :", fullUrl);
    console.log("  Method : GET");
    console.log("  Params :", JSON.stringify(params));
    console.log("  Auth   :", authHeader ? `Basic [token set — length ${authHeader.length}]` : "⚠️  NO AUTH HEADER — TEAMOFFICE_AUTH_TOKEN or TEAMOFFICE_USERNAME/PASSWORD not set in .env");
    console.log("  BASE_URL from env:", process.env.TEAMOFFICE_BASE_URL || "(not set, using default)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    try {
        const resp = await axios.get(url, { params, headers, timeout: 30000 });
        console.log("✅ [TeamOffice] InOut API response status:", resp.status);
        if (resp.data?.Error === true) {
            console.warn("⚠️  [TeamOffice] API returned Error=true, Msg:", resp.data.Msg);
            return null;
        }
        const count = resp.data?.InOutPunchData?.length ?? resp.data?.length ?? "unknown";
        console.log(`✅ [TeamOffice] InOut records received: ${count}`);
        return resp.data;
    } catch (err) {
        console.error("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.error("❌ [TeamOffice] InOut API FAILED");
        console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.error("  Status       :", err.response?.status ?? "no response");
        console.error("  Status Text  :", err.response?.statusText ?? "—");
        console.error("  Response Body:", JSON.stringify(err.response?.data ?? null));
        console.error("  Error Msg    :", err.message);
        console.error("  Full URL     :", fullUrl);
        console.error("  POSTMAN TEST : GET", fullUrl);
        console.error("  POSTMAN AUTH : Authorization:", authHeader || "(none)");
        console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
        throw new Error(`TeamOffice InOut fetch failed [${err.response?.status ?? "no-response"}]: ${err.message} | URL: ${fullUrl}`);
    }
}

async function fetchPunchDetailData(fromDate, toDate, empCode = "ALL") {
    const { base, authHeader } = getTeamOfficeConfig();
    const url = `${base}/DownloadPunchDataMCID`;
    const params = {
        Empcode: empCode,
        FromDate: toEtimePunchDate(fromDate, "00:00"),
        ToDate: toEtimePunchDate(toDate, "23:59"),
    };
    const headers = authHeader ? { Authorization: authHeader } : {};

    const queryString = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const fullUrl = `${url}?${queryString}`;

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🟣 [TeamOffice] PunchDetail API Request");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  URL    :", fullUrl);
    console.log("  Params :", JSON.stringify(params));
    console.log("  Auth   :", authHeader ? `Basic [set]` : "⚠️  NO AUTH");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    try {
        const resp = await axios.get(url, { params, headers, timeout: 30000 });
        console.log("✅ [TeamOffice] PunchDetail response status:", resp.status);
        if (resp.data?.Error === true) return null;
        return resp.data;
    } catch (err) {
        console.error("\n❌ [TeamOffice] PunchDetail FAILED");
        console.error("  Status  :", err.response?.status ?? "no response");
        console.error("  Body    :", JSON.stringify(err.response?.data ?? null));
        console.error("  POSTMAN : GET", fullUrl);
        console.error("  Auth    :", authHeader || "(none)");
        console.error("  Msg     :", err.message, "\n");
        // Non-critical — we can still work with InOut data alone
        console.warn("TeamOffice PunchDetail API warning:", err.message);
        return null;
    }
}

// ── Core sync function ───────────────────────────────────────────────────────

async function syncDateRange(fromDate, toDate, empCode = "ALL") {
    const settings = await AttendanceSettings.getSingleton();
    const holidays = settings.holidays || [];

    // Fetch from both APIs (punch detail is best-effort)
    const [inOutData, punchDetailData] = await Promise.all([
        fetchInOutData(fromDate, toDate, empCode),
        fetchPunchDetailData(fromDate, toDate, empCode).catch(() => null),
    ]);

    const inOutRecords = parseInOutResponse(inOutData);
    const punchMap = parsePunchDataResponse(punchDetailData); // key: "empCode_dateStr"

    if (!inOutRecords.length && !Object.keys(punchMap).length) {
        return { synced: 0, message: "No data from TeamOffice for this range" };
    }

    // Get all unique empCodes from both sources
    const empCodes = [...new Set([
        ...inOutRecords.map(r => r.biometricId),
        ...Object.values(punchMap).map(r => r.biometricId),
    ])].filter(Boolean);

    const employees = await Employee.find(
        { biometricId: { $in: empCodes } },
        "biometricId firstName lastName department designation"
    ).lean();
    const empMap = {};
    employees.forEach(e => { empMap[e.biometricId] = e; });

    const ops = [];

    // Process InOut records (primary)
    for (const inOutRec of inOutRecords) {
        const punchKey = `${inOutRec.biometricId}_${inOutRec.dateStr}`;
        const punchDetail = punchMap[punchKey] || null;
        const empDoc = empMap[inOutRec.biometricId] || null;
        const record = buildAttendanceRecord(inOutRec, punchDetail, empDoc, settings, holidays);

        ops.push({
            updateOne: {
                filter: { biometricId: record.biometricId, dateStr: record.dateStr },
                update: { $set: record },
                upsert: true,
            },
        });
    }

    // Process any punch-only records (employees who appear only in punch API)
    for (const [key, punchRec] of Object.entries(punchMap)) {
        const inOutExists = inOutRecords.find(
            r => r.biometricId === punchRec.biometricId && r.dateStr === punchRec.dateStr
        );
        if (inOutExists) continue; // already handled above

        // Build a minimal inOutRecord from punch data
        const sorted = punchRec.punches;
        const minInOut = {
            biometricId: punchRec.biometricId,
            dateStr: punchRec.dateStr,
            name: punchRec.name || "",
            inTime: sorted[0]?.time || null,
            finalOut: sorted.length > 1 ? sorted[sorted.length - 1]?.time : null,
            workTime: null,
            overTime: null,
            etimeStatus: "",
            etimeRemark: "",
            etimeLateIn: "00:00",
            etimeErlOut: "00:00",
            punchCount: sorted.length,
        };
        const empDoc = empMap[punchRec.biometricId] || null;
        const record = buildAttendanceRecord(minInOut, punchRec, empDoc, settings, holidays);

        ops.push({
            updateOne: {
                filter: { biometricId: record.biometricId, dateStr: record.dateStr },
                update: { $set: record },
                upsert: true,
            },
        });
    }

    if (ops.length > 0) {
        await DailyAttendance.bulkWrite(ops, { ordered: false });
    }

    // Fill absent/WO/PH for all known employees for missing days
    await fillMissingDays(fromDate, toDate, empMap, settings, holidays);

    return { synced: ops.length, employees: empCodes.length };
}

/** Ensure every employee has a record for every day in range (AB/WO/PH) */
async function fillMissingDays(fromDate, toDate, empMap, settings, holidays) {
    const holidayDates = new Set(holidays.map(h => h.date));
    const workingDays = settings.workingDays || [1, 2, 3, 4, 5, 6];
    const empBioCodes = Object.keys(empMap);
    if (!empBioCodes.length) return;

    const ops = [];
    for (let d = new Date(fromDate + "T00:00:00"); d <= new Date(toDate + "T00:00:00"); d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split("T")[0];
        for (const biometricId of empBioCodes) {
            const empDoc = empMap[biometricId];
            const placeholder = buildPlaceholderRecord(biometricId, empDoc, dateStr, settings, holidays);
            ops.push({
                updateOne: {
                    filter: { biometricId, dateStr },
                    update: { $setOnInsert: placeholder },
                    upsert: true,
                },
            });
        }
    }
    if (ops.length) await DailyAttendance.bulkWrite(ops, { ordered: false });
}

// ── Format helpers ───────────────────────────────────────────────────────────

const fmtTime = (dt) => {
    if (!dt) return "--:--";
    const d = new Date(dt);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const enrich = (r) => ({
    ...r,
    inTimeStr: fmtTime(r.inTime),
    lunchOutStr: fmtTime(r.lunchOut),
    lunchInStr: fmtTime(r.lunchIn),
    teaOutStr: fmtTime(r.teaOut),
    teaInStr: fmtTime(r.teaIn),
    finalOutStr: fmtTime(r.finalOut),
    netWorkStr: minsToHHMM(r.netWorkMins),
    otStr: minsToHHMM(r.otMins),
    lateStr: minsToHHMM(r.lateMins),
    earlyStr: minsToHHMM(r.earlyDepartureMins),
    breakStr: minsToHHMM(r.totalBreakMins),
});

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /sync
 * Manual or auto sync for a date range.
 */
router.post("/sync", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { fromDate, toDate, empCode } = req.body;
        if (!fromDate || !toDate) return res.status(400).json({ success: false, message: "fromDate and toDate required" });
        const result = await syncDateRange(fromDate, toDate, empCode || "ALL");
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /daily?date=YYYY-MM-DD&department=xxx
 * Always fetches fresh data from TeamOffice before returning DB results.
 */
router.get("/daily", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { date, department } = req.query;
        if (!date) return res.status(400).json({ success: false, message: "date required" });

        // Auto-sync on every request (no cron needed)
        try {
            await syncDateRange(date, date);
        } catch (e) {
            console.warn("Auto-sync warning:", e.message);
        }

        const query = { dateStr: date };
        if (department && department !== "all") query.department = department;

        const records = await DailyAttendance.find(query).sort({ biometricId: 1 }).lean();

        // Summary
        const summary = { P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, WO: 0, PH: 0, L: 0, MP: 0, WFH: 0 };
        records.forEach(r => { if (summary[r.status] !== undefined) summary[r.status]++; });

        res.json({ success: true, data: records.map(enrich), count: records.length, summary });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /monthly?yearMonth=YYYY-MM&department=xxx&empCode=xxxx
 * Auto-syncs the full month on each request, then returns aggregated data.
 */
router.get("/monthly", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { yearMonth, department, empCode } = req.query;
        if (!yearMonth) return res.status(400).json({ success: false, message: "yearMonth required" });

        const [year, month] = yearMonth.split("-").map(Number);
        const fromDate = `${yearMonth}-01`;
        const toDate = `${yearMonth}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;

        // Always auto-sync the month
        try {
            await syncDateRange(fromDate, toDate, empCode || "ALL");
        } catch (e) {
            console.warn("Monthly auto-sync warning:", e.message);
        }

        const query = { yearMonth };
        if (department && department !== "all") query.department = department;
        if (empCode) query.biometricId = empCode;

        const records = await DailyAttendance.find(query).sort({ biometricId: 1, dateStr: 1 }).lean();

        // Aggregate per employee
        const byEmployee = {};
        records.forEach(r => {
            if (!byEmployee[r.biometricId]) {
                byEmployee[r.biometricId] = {
                    biometricId: r.biometricId,
                    employeeName: r.employeeName,
                    department: r.department,
                    designation: r.designation,
                    shiftName: r.shiftName || "GEN",
                    days: [],
                    summary: { P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, WO: 0, PH: 0, L: 0, MP: 0 },
                    totalNetWorkMins: 0, totalOtMins: 0, totalLateMins: 0,
                    presentDays: 0, absentDays: 0, lateCount: 0, earlyCount: 0, otDays: 0,
                };
            }
            const emp = byEmployee[r.biometricId];
            emp.days.push(enrich(r));
            if (emp.summary[r.status] !== undefined) emp.summary[r.status]++;
            if (["P", "P*", "P~", "MP"].includes(r.status)) emp.presentDays++;
            else if (r.status === "HD") emp.presentDays += 0.5;
            else if (r.status === "AB") emp.absentDays++;
            emp.totalNetWorkMins += r.netWorkMins || 0;
            emp.totalOtMins += r.otMins || 0;
            emp.totalLateMins += r.lateMins || 0;
            if (r.isLate) emp.lateCount++;
            if (r.isEarlyDeparture) emp.earlyCount++;
            if ((r.otMins || 0) > 0) emp.otDays++;
        });

        const result = Object.values(byEmployee).map(e => ({
            ...e,
            totalNetWorkStr: minsToHHMM(e.totalNetWorkMins),
            totalOtStr: minsToHHMM(e.totalOtMins),
        }));

        // Overall summary across all employees for the month
        const overallSummary = result.reduce((acc, e) => {
            acc.present += e.presentDays;
            acc.absent += e.absentDays;
            acc.lateCount += e.lateCount;
            acc.otDays += e.otDays;
            return acc;
        }, { present: 0, absent: 0, lateCount: 0, otDays: 0 });

        res.json({ success: true, yearMonth, fromDate, toDate, data: result, employeeCount: result.length, overallSummary });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /employee/:biometricId?yearMonth=YYYY-MM
 * Single employee monthly detail — always syncs.
 */
router.get("/employee/:biometricId", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { biometricId } = req.params;
        const { yearMonth } = req.query;
        if (!yearMonth) return res.status(400).json({ success: false, message: "yearMonth required" });

        const [y, m] = yearMonth.split("-").map(Number);
        const from = `${yearMonth}-01`;
        const to = `${yearMonth}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
        try { await syncDateRange(from, to, biometricId); } catch (e) { /* ignore */ }

        const records = await DailyAttendance.find({ biometricId, yearMonth }).sort({ dateStr: 1 }).lean();
        res.json({ success: true, data: records.map(enrich) });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /analytics?year=YYYY&quarter=Q1&month=YYYY-MM&department=xxx
 */
router.get("/analytics", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { year, quarter, month, department } = req.query;
        let yearMonths = [];

        if (month) {
            yearMonths = [month];
        } else if (quarter && year) {
            const qMap = { Q1: ["01", "02", "03"], Q2: ["04", "05", "06"], Q3: ["07", "08", "09"], Q4: ["10", "11", "12"] };
            yearMonths = (qMap[quarter] || []).map(m => `${year}-${m}`);
        } else if (year) {
            yearMonths = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
        } else {
            const n = new Date();
            yearMonths = [`${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`];
        }

        const query = { yearMonth: { $in: yearMonths } };
        if (department && department !== "all") query.department = department;

        const records = await DailyAttendance.find(query).lean();

        const totals = { P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, WO: 0, PH: 0, L: 0, MP: 0, totalOtMins: 0, totalLateMins: 0 };
        const byMonth = {}, byDept = {}, byEmployee = {};

        records.forEach(r => {
            totals[r.status] = (totals[r.status] || 0) + 1;
            totals.totalOtMins += r.otMins || 0;
            totals.totalLateMins += r.lateMins || 0;

            if (!byMonth[r.yearMonth]) byMonth[r.yearMonth] = { P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, WO: 0, PH: 0, L: 0, MP: 0, totalOtMins: 0 };
            byMonth[r.yearMonth][r.status] = (byMonth[r.yearMonth][r.status] || 0) + 1;
            byMonth[r.yearMonth].totalOtMins += r.otMins || 0;

            const dept = r.department || "Unknown";
            if (!byDept[dept]) byDept[dept] = { P: 0, AB: 0, HD: 0, late: 0 };
            if (["P", "P*", "P~", "MP"].includes(r.status)) byDept[dept].P++;
            else if (r.status === "AB") byDept[dept].AB++;
            else if (r.status === "HD") byDept[dept].HD++;
            if (r.isLate) byDept[dept].late++;

            if (!byEmployee[r.biometricId]) byEmployee[r.biometricId] = { name: r.employeeName, dept: r.department, present: 0, absent: 0, late: 0, ot: 0, hd: 0 };
            if (["P", "P*", "P~", "MP"].includes(r.status)) byEmployee[r.biometricId].present++;
            else if (r.status === "AB") byEmployee[r.biometricId].absent++;
            else if (r.status === "HD") byEmployee[r.biometricId].hd++;
            if (r.isLate) byEmployee[r.biometricId].late++;
            byEmployee[r.biometricId].ot += r.otMins || 0;
        });

        const topOT = Object.entries(byEmployee)
            .sort((a, b) => b[1].ot - a[1].ot)
            .slice(0, 10)
            .map(([id, v]) => ({ biometricId: id, ...v, otStr: minsToHHMM(v.ot) }));

        const topLate = Object.entries(byEmployee)
            .sort((a, b) => b[1].late - a[1].late)
            .slice(0, 10)
            .map(([id, v]) => ({ biometricId: id, ...v }));

        res.json({ success: true, yearMonths, totals, byMonth, byDepartment: byDept, topOT, topLate });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /muster-roll?yearMonth=YYYY-MM
 * Returns data for Excel export in the GRAV format.
 */
router.get("/muster-roll", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { yearMonth } = req.query;
        if (!yearMonth) return res.status(400).json({ success: false, message: "yearMonth required" });

        const [year, month] = yearMonth.split("-").map(Number);
        const daysInMonth = new Date(year, month, 0).getDate();

        // Auto-sync if needed
        const fromDate = `${yearMonth}-01`;
        const toDate = `${yearMonth}-${String(daysInMonth).padStart(2, "0")}`;
        try { await syncDateRange(fromDate, toDate); } catch (e) { /* ignore */ }

        const records = await DailyAttendance.find({ yearMonth }).sort({ biometricId: 1, dateStr: 1 }).lean();

        const byEmp = {};
        records.forEach(r => {
            if (!byEmp[r.biometricId]) {
                byEmp[r.biometricId] = {
                    empCode: r.biometricId,
                    name: r.employeeName,
                    department: r.department,
                    shift: r.shiftName || "GEN",
                    days: {},
                    summary: {
                        present: 0, absent: 0, wo: 0, ph: 0, hd: 0, leave: 0, mp: 0,
                        totalWorkMins: 0, totalOtMins: 0, totalLateMins: 0,
                        lateCount: 0, earlyCount: 0, otDays: 0,
                    },
                };
            }
            const emp = byEmp[r.biometricId];
            const day = new Date(r.dateStr + "T00:00:00").getDate();

            emp.days[day] = {
                status: r.status,
                inTime: fmtTime(r.inTime),
                outTime: fmtTime(r.finalOut),
                netWork: minsToHHMM(r.netWorkMins),
                breakTime: minsToHHMM(r.totalBreakMins),
                otTime: minsToHHMM(r.otMins),
                lateTime: minsToHHMM(r.lateMins),
                punchCount: r.punchCount,
                hasMissPunch: r.hasMissPunch,
                isWeeklyOff: r.isWeeklyOff,
                isHoliday: r.isHoliday,
                holidayName: r.holidayName,
            };

            const s = emp.summary;
            if (["P", "P*", "P~", "MP"].includes(r.status)) s.present++;
            else if (r.status === "HD") { s.hd++; s.present += 0.5; }
            else if (r.status === "AB") s.absent++;
            else if (r.status === "WO") s.wo++;
            else if (r.status === "PH") s.ph++;
            else if (r.status === "L") s.leave++;

            s.totalWorkMins += r.netWorkMins || 0;
            s.totalOtMins += r.otMins || 0;
            s.totalLateMins += r.lateMins || 0;
            if (r.isLate) s.lateCount++;
            if (r.isEarlyDeparture) s.earlyCount++;
            if ((r.otMins || 0) > 0) s.otDays++;
        });

        // Build daysArray (31 slots)
        const employees = Object.values(byEmp).map(emp => ({
            ...emp,
            summary: {
                ...emp.summary,
                totalWorkStr: minsToHHMM(emp.summary.totalWorkMins),
                totalOtStr: minsToHHMM(emp.summary.totalOtMins),
            },
            daysArray: Array.from({ length: daysInMonth }, (_, i) =>
                emp.days[i + 1] || {
                    status: null, inTime: "--:--", outTime: "--:--",
                    netWork: "00:00", breakTime: "00:00", otTime: "00:00", lateTime: "00:00",
                    punchCount: 0, hasMissPunch: false, isWeeklyOff: false, isHoliday: false,
                }
            ),
        }));

        // Day-of-week header
        const dowLabels = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
        const dayHeaders = Array.from({ length: daysInMonth }, (_, i) => {
            const d = new Date(year, month - 1, i + 1);
            return { day: i + 1, dow: dowLabels[d.getDay()], date: `${yearMonth}-${String(i + 1).padStart(2, "0")}` };
        });

        res.json({ success: true, yearMonth, daysInMonth, dayHeaders, employees });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── Settings ─────────────────────────────────────────────────────────────────

router.get("/settings", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const settings = await AttendanceSettings.getSingleton();
        const shifts = await Shift.find().lean();
        res.json({ success: true, data: settings, shifts });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.put("/settings", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const allowed = [
            "shiftStart", "shiftEnd", "lateThresholdMinutes", "halfDayThresholdMinutes",
            "earlyDepartureThresholdMinutes", "otGracePeriodMins", "workingDays",
            "lunchBreakMins", "teaBreakMins", "overtimeEnabled", "overtimeMinimumMinutes",
            "overtimeMaxPerDay", "overtimeRateMultiplier",
        ];
        const updates = {};
        allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
        if (req.user?.id) updates.updatedBy = req.user.id;

        const settings = await AttendanceSettings.findOneAndUpdate(
            {},
            { $set: updates },
            { new: true, upsert: true, runValidators: true }
        );
        res.json({ success: true, message: "Settings saved successfully", data: settings });
    } catch (err) {
        console.error("Settings save error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── Holidays ─────────────────────────────────────────────────────────────────

router.post("/holidays", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { name, date, type, description, isRecurring } = req.body;
        if (!name || !date) return res.status(400).json({ success: false, message: "name and date required" });

        const settings = await AttendanceSettings.getSingleton();
        settings.holidays.push({ name, date, type: type || "company", description, isRecurring: isRecurring || false });
        await settings.save();

        // Update existing records for this date
        await DailyAttendance.updateMany(
            { dateStr: date, punchCount: 0 },
            { $set: { isHoliday: true, holidayName: name, holidayType: type || "company", status: "PH" } }
        );

        res.json({ success: true, message: "Holiday added", data: settings.holidays });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.put("/holidays/:id", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const settings = await AttendanceSettings.getSingleton();
        const h = settings.holidays.id(req.params.id);
        if (!h) return res.status(404).json({ success: false, message: "Holiday not found" });
        const { name, date, type, description, isRecurring } = req.body;
        if (name) h.name = name;
        if (date) h.date = date;
        if (type) h.type = type;
        if (description !== undefined) h.description = description;
        if (isRecurring !== undefined) h.isRecurring = isRecurring;
        await settings.save();
        res.json({ success: true, message: "Holiday updated", data: settings.holidays });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.delete("/holidays/:id", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const settings = await AttendanceSettings.getSingleton();
        const h = settings.holidays.id(req.params.id);
        if (!h) return res.status(404).json({ success: false, message: "Holiday not found" });
        const dateToRestore = h.date;
        h.remove();
        await settings.save();
        // Restore AB for days with no punches
        await DailyAttendance.updateMany(
            { dateStr: dateToRestore, punchCount: 0, isOnLeave: false },
            { $set: { isHoliday: false, holidayName: null, holidayType: null, status: "AB" } }
        );
        res.json({ success: true, message: "Holiday removed" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── Miss Punch ────────────────────────────────────────────────────────────────

router.post("/miss-punch", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { biometricId, dateStr, punchSlot, requestedTime, reason } = req.body;
        if (!biometricId || !dateStr || !punchSlot || !requestedTime) {
            return res.status(400).json({ success: false, message: "biometricId, dateStr, punchSlot, requestedTime are required" });
        }

        let record = await DailyAttendance.findOne({ biometricId, dateStr });
        if (!record) {
            return res.status(404).json({ success: false, message: "No attendance record found for this employee on this date" });
        }

        record.missPunchRequests.push({
            requestedBy: req.user?.id,
            requestedAt: new Date(),
            punchSlot: parseInt(punchSlot, 10),
            requestedTime: new Date(requestedTime),
            reason,
            status: "pending",
        });
        record.hasMissPunch = true;
        await record.save();

        res.json({ success: true, message: "Miss punch request submitted successfully" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.put("/miss-punch/:attendanceId/:requestId/approve", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { attendanceId, requestId } = req.params;
        const { stage, remarks } = req.body; // stage: "manager" | "hr"

        const record = await DailyAttendance.findById(attendanceId);
        if (!record) return res.status(404).json({ success: false, message: "Record not found" });

        const mpReq = record.missPunchRequests.id(requestId);
        if (!mpReq) return res.status(404).json({ success: false, message: "Miss punch request not found" });

        if (stage === "manager") {
            mpReq.status = "manager_approved";
            mpReq.managerApprovedBy = req.user?.id;
            mpReq.managerApprovedAt = new Date();
        } else if (stage === "hr") {
            if (mpReq.status !== "manager_approved") {
                return res.status(400).json({ success: false, message: "Manager must approve first" });
            }
            mpReq.status = "hr_approved";
            mpReq.hrApprovedBy = req.user?.id;
            mpReq.hrApprovedAt = new Date();

            // Settle the miss punch — apply the punch to the record
            await applySettledMissPunch(record, mpReq);
        }
        await record.save();
        res.json({ success: true, message: `${stage} approval done`, data: record });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.put("/miss-punch/:attendanceId/:requestId/reject", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { attendanceId, requestId } = req.params;
        const { reason } = req.body;
        const record = await DailyAttendance.findById(attendanceId);
        if (!record) return res.status(404).json({ success: false, message: "Record not found" });
        const mpReq = record.missPunchRequests.id(requestId);
        if (!mpReq) return res.status(404).json({ success: false, message: "Request not found" });
        mpReq.status = "rejected";
        mpReq.rejectedBy = req.user?.id;
        mpReq.rejectedAt = new Date();
        mpReq.rejectionReason = reason || "";
        await record.save();
        res.json({ success: true, message: "Request rejected" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** Apply an approved miss punch to the attendance record and recalculate */
async function applySettledMissPunch(record, mpReq) {
    const slotField = {
        1: "inTime", 2: "lunchOut", 3: "lunchIn",
        4: "teaOut", 5: "teaIn", 6: "finalOut",
    };
    const field = slotField[mpReq.punchSlot];
    if (field) {
        record[field] = mpReq.requestedTime;
        record.rawPunches.push({
            seq: mpReq.punchSlot,
            time: mpReq.requestedTime,
            punchType: ["in", "lunch_out", "lunch_in", "tea_out", "tea_in", "out"][mpReq.punchSlot - 1] || "unknown",
            source: "miss_punch",
        });
        record.punchCount = record.rawPunches.length;
        // Recalculate
        const { calculateDayMetrics } = require("../../services/Attendanceengine");
        const settings = await AttendanceSettings.getSingleton();
        const metrics = calculateDayMetrics({
            dateStr: record.dateStr,
            inTime: record.inTime,
            lunchOut: record.lunchOut,
            lunchIn: record.lunchIn,
            teaOut: record.teaOut,
            teaIn: record.teaIn,
            finalOut: record.finalOut,
            punchCount: record.punchCount,
            isWeeklyOff: record.isWeeklyOff,
            isHoliday: record.isHoliday,
            isOnLeave: record.isOnLeave,
            settings,
        });
        Object.assign(record, metrics);
        record.hasMissPunch = record.missPunchRequests.some(r => r.status === "pending" || r.status === "manager_approved");
    }
}

// ── Misc ──────────────────────────────────────────────────────────────────────

router.get("/departments", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const depts = await Employee.distinct("department");
        res.json({ success: true, data: depts.filter(Boolean).sort() });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** GET /today — convenience endpoint for dashboard */
router.get("/today", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const today = new Date().toISOString().split("T")[0];
        try { await syncDateRange(today, today); } catch (e) { /* ignore */ }
        const records = await DailyAttendance.find({ dateStr: today }).lean();
        const summary = { total: records.length, present: 0, absent: 0, late: 0, ot: 0, mp: 0 };
        records.forEach(r => {
            if (["P", "P*", "P~"].includes(r.status)) summary.present++;
            else if (r.status === "AB") summary.absent++;
            else if (r.status === "MP") { summary.present++; summary.mp++; }
            if (r.isLate) summary.late++;
            if (r.hasOT) summary.ot++;
        });
        res.json({ success: true, date: today, summary, data: records.map(enrich) });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /debug-api?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&empCode=ALL
 *
 * Returns the EXACT URLs and headers that will be sent to TeamOffice,
 * plus the raw response (or error). Use this to debug 404s in Postman.
 *
 * Example: GET /hr/attendance/debug-api?fromDate=2026-03-10&toDate=2026-03-12
 */
router.get("/debug-api", EmployeeAuthMiddlewear, async (req, res) => {
    const { fromDate = "2026-03-12", toDate = "2026-03-12", empCode = "ALL" } = req.query;
    const { base, authHeader } = getTeamOfficeConfig();

    const inOutUrl = `${base}/DownloadInOutPunchData`;
    const punchUrl = `${base}/DownloadPunchDataMCID`;
    const inOutParams = { Empcode: empCode, FromDate: toEtimeInOutDate(fromDate), ToDate: toEtimeInOutDate(toDate) };
    const punchParams = { Empcode: empCode, FromDate: toEtimePunchDate(fromDate, "00:00"), ToDate: toEtimePunchDate(toDate, "23:59") };

    const buildFullUrl = (url, params) =>
        `${url}?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;

    const debugInfo = {
        env: {
            TEAMOFFICE_BASE_URL: process.env.TEAMOFFICE_BASE_URL || "(not set → using default)",
            TEAMOFFICE_AUTH_TOKEN: process.env.TEAMOFFICE_AUTH_TOKEN ? `SET (length ${process.env.TEAMOFFICE_AUTH_TOKEN.length})` : "(not set)",
            TEAMOFFICE_USERNAME: process.env.TEAMOFFICE_USERNAME || "(not set)",
            TEAMOFFICE_PASSWORD: process.env.TEAMOFFICE_PASSWORD ? "SET" : "(not set)",
            TEAMOFFICE_CORP_ID: process.env.TEAMOFFICE_CORP_ID || "(not set)",
        },
        resolvedBase: base,
        resolvedAuth: authHeader ? `Basic [token length: ${authHeader.length}] — copy below` : "NONE — missing env vars!",
        authHeaderValue: authHeader || null,

        api1_InOut: {
            description: "Primary: gets INTime, OUTTime, WorkTime, OT, Status, Remark",
            method: "GET",
            fullUrl: buildFullUrl(inOutUrl, inOutParams),
            params: inOutParams,
            headers: { Authorization: authHeader || "(none)" },
            postmanNote: "Paste fullUrl into Postman GET, add Authorization header",
        },
        api2_PunchDetail: {
            description: "Secondary: gets per-punch records with mcid (for break detail)",
            method: "GET",
            fullUrl: buildFullUrl(punchUrl, punchParams),
            params: punchParams,
            headers: { Authorization: authHeader || "(none)" },
        },

        responses: {},
    };

    // Actually try both calls and return raw results
    try {
        const resp = await axios.get(inOutUrl, { params: inOutParams, headers: authHeader ? { Authorization: authHeader } : {}, timeout: 15000 });
        debugInfo.responses.inOut = {
            status: resp.status,
            dataKeys: Object.keys(resp.data || {}),
            recordCount: resp.data?.InOutPunchData?.length ?? "(unknown key — see rawSample)",
            rawSample: JSON.stringify(resp.data).substring(0, 500),
        };
    } catch (err) {
        debugInfo.responses.inOut = {
            status: err.response?.status ?? "NO_RESPONSE",
            statusText: err.response?.statusText,
            errorMessage: err.message,
            responseBody: err.response?.data ?? null,
            fix: err.response?.status === 404
                ? "404 = endpoint not found. Check TEAMOFFICE_BASE_URL. Try removing trailing /api or adding it."
                : err.response?.status === 401
                    ? "401 = bad credentials. Check TEAMOFFICE_AUTH_TOKEN or USERNAME/PASSWORD in .env"
                    : err.response?.status === 400
                        ? "400 = bad params. Check date format. InOut API needs MM/DD/YYYY (not DD/MM/YYYY)."
                        : "Check error message above",
        };
    }

    try {
        const resp2 = await axios.get(punchUrl, { params: punchParams, headers: authHeader ? { Authorization: authHeader } : {}, timeout: 15000 });
        debugInfo.responses.punchDetail = {
            status: resp2.status,
            recordCount: resp2.data?.PunchData?.length ?? "(unknown)",
            rawSample: JSON.stringify(resp2.data).substring(0, 300),
        };
    } catch (err2) {
        debugInfo.responses.punchDetail = {
            status: err2.response?.status ?? "NO_RESPONSE",
            errorMessage: err2.message,
            responseBody: err2.response?.data ?? null,
        };
    }

    res.json(debugInfo);
});

module.exports = router;