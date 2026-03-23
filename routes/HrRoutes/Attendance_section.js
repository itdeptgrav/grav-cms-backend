/**
 * Attendance_section.js  –  v5  (GRAV Clothing)
 * Route: mounted at /hr/attendance  (unchanged in server.js)
 *
 * BUG FIX: "Failed to parse number 'GR001'"
 *   The previous version used MongoDB $toInt:"$biometricId" which FAILS when
 *   biometricId contains letters. Now we use buildEmployeeMap() which does
 *   the number-stripping in JavaScript before the query.
 *
 * DEPARTMENT FIX:
 *   eTimeOffice API does NOT return department. All department data is
 *   enriched from the Employee record matched by biometricId.
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
    normalizeId,
    buildEmployeeMap,
    minsToHHMM,
    buildAttendanceRecord,
    buildPlaceholderRecord,
    parseInOutResponse,
    parsePunchDataResponse,
    computeMonthSummary,
    enrichRecord,
    computeDay,
} = require("../../services/Attendanceengine");

// ─────────────────────────────────────────────────────────────────────────────
//  ETIMEOFFICE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getTeamOfficeConfig() {
    const base = (process.env.TEAMOFFICE_BASE_URL || "https://api.etimeoffice.com/api").replace(/\/+$/, "");
    const authToken = process.env.TEAMOFFICE_AUTH_TOKEN;
    const username = process.env.TEAMOFFICE_USERNAME;
    const password = process.env.TEAMOFFICE_PASSWORD;
    const corpId = process.env.TEAMOFFICE_CORP_ID || "";
    let authHeader = "";
    if (authToken) {
        authHeader = `Basic ${authToken}`;
    } else if (username && password) {
        const raw = corpId ? `${corpId}:${username}:${password}:true` : `${username}:${password}`;
        authHeader = `Basic ${Buffer.from(raw).toString("base64")}`;
    }
    return { base, authHeader };
}

function toEtimeInOutDate(ds) { const [y, m, d] = ds.split("-"); return `${m}/${d}/${y}`; }
function toEtimePunchDate(ds, t = "00:00") { const [y, m, d] = ds.split("-"); return `${d}/${m}/${y}_${t}`; }

async function fetchInOutData(fromDate, toDate, empCode = "ALL") {
    const { base, authHeader } = getTeamOfficeConfig();
    const url = `${base}/DownloadInOutPunchData`;
    const params = { Empcode: empCode, FromDate: toEtimeInOutDate(fromDate), ToDate: toEtimeInOutDate(toDate) };
    const headers = authHeader ? { Authorization: authHeader } : {};
    try {
        const resp = await axios.get(url, { params, headers, timeout: 30000 });
        if (resp.data?.Error === true) return null;
        return resp.data;
    } catch (err) {
        console.error("❌ [TeamOffice] InOut fetch failed:", err.message);
        throw new Error(`TeamOffice InOut fetch failed: ${err.message}`);
    }
}

async function fetchPunchDetailData(fromDate, toDate, empCode = "ALL") {
    const { base, authHeader } = getTeamOfficeConfig();
    const url = `${base}/DownloadPunchDataMCID`;
    const params = { Empcode: empCode, FromDate: toEtimePunchDate(fromDate, "00:00"), ToDate: toEtimePunchDate(toDate, "23:59") };
    const headers = authHeader ? { Authorization: authHeader } : {};
    try {
        const resp = await axios.get(url, { params, headers, timeout: 30000 });
        if (resp.data?.Error === true) return null;
        return resp.data;
    } catch (err) {
        console.warn("⚠️  [TeamOffice] PunchDetail non-critical fail:", err.message);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CORE SYNC — THE KEY FIX IS IN buildEmployeeMap()
// ─────────────────────────────────────────────────────────────────────────────

async function syncDateRange(fromDate, toDate, empCode = "ALL") {
    const settings = await AttendanceSettings.getSingleton();
    const holidays = settings.holidays || [];

    const [inOutData, punchDetailData] = await Promise.all([
        fetchInOutData(fromDate, toDate, empCode),
        fetchPunchDetailData(fromDate, toDate, empCode).catch(() => null),
    ]);

    const inOutRecords = parseInOutResponse(inOutData);
    const punchMap = parsePunchDataResponse(punchDetailData);

    if (!inOutRecords.length && !Object.keys(punchMap).length) {
        return { synced: 0, message: "No data from TeamOffice for this range" };
    }

    // All raw biometric IDs from eTimeOffice (e.g. "0001", "0072")
    const rawCodes = [...new Set([
        ...inOutRecords.map((r) => r.biometricId),
        ...Object.values(punchMap).map((r) => r.biometricId),
    ])].filter(Boolean);

    // Build employee map using JS-based normalisation (no MongoDB $toInt)
    // rawCode "0072" → normalizeId = 72 → matches Employee.biometricId "GR072" (normalizeId=72)
    const empByNumeric = await buildEmployeeMap(Employee, rawCodes);

    // Helper: get empDoc for a rawCode
    const getEmp = (rawCode) => empByNumeric[normalizeId(rawCode)] || null;

    const ops = [];

    // Process InOut records (primary source)
    for (const inOutRec of inOutRecords) {
        const punchKey = `${inOutRec.biometricId}_${inOutRec.dateStr}`;
        const punchDetail = punchMap[punchKey] || null;
        const empDoc = getEmp(inOutRec.biometricId);
        const record = buildAttendanceRecord(inOutRec, punchDetail, empDoc, settings, holidays);

        ops.push({
            updateOne: {
                filter: { biometricId: record.biometricId, dateStr: record.dateStr },
                update: { $set: record },
                upsert: true,
            },
        });
    }

    // Process punch-only records (in MCID API but not InOut API)
    for (const [, punchRec] of Object.entries(punchMap)) {
        const exists = inOutRecords.find(
            (r) => r.biometricId === punchRec.biometricId && r.dateStr === punchRec.dateStr
        );
        if (exists) continue;

        const sorted = punchRec.punches;
        const minInOut = {
            biometricId: punchRec.biometricId,
            dateStr: punchRec.dateStr,
            name: punchRec.name || "",
            inTime: sorted[0]?.time || null,
            finalOut: sorted.length > 1 ? sorted[sorted.length - 1]?.time : null,
            etimeStatus: "", etimeRemark: "",
        };
        const empDoc = getEmp(punchRec.biometricId);
        const record = buildAttendanceRecord(minInOut, punchRec, empDoc, settings, holidays);

        ops.push({
            updateOne: {
                filter: { biometricId: record.biometricId, dateStr: record.dateStr },
                update: { $set: record },
                upsert: true,
            },
        });
    }

    if (ops.length) await DailyAttendance.bulkWrite(ops, { ordered: false });

    // Ensure all known employees have a record for every day in range
    await fillMissingDays(fromDate, toDate, empByNumeric, settings, holidays);

    return { synced: ops.length, employees: rawCodes.length };
}

async function fillMissingDays(fromDate, toDate, empByNumeric, settings, holidays) {
    if (!Object.keys(empByNumeric).length) return;
    const ops = [];

    for (let d = new Date(fromDate + "T00:00:00Z"); d <= new Date(toDate + "T23:59:59Z"); d.setUTCDate(d.getUTCDate() + 1)) {
        const dateStr = d.toISOString().split("T")[0];
        for (const [, empDoc] of Object.entries(empByNumeric)) {
            if (!empDoc?.biometricId) continue;
            const placeholder = buildPlaceholderRecord(empDoc.biometricId, empDoc, dateStr, settings, holidays);

            // Fields we always want to keep fresh on existing records
            // (these must NOT overlap with $setOnInsert — MongoDB will reject the op)
            const alwaysUpdate = {
                numericId: placeholder.numericId,
                identityId: placeholder.identityId,
                employeeType: placeholder.employeeType,
                department: placeholder.department,
                designation: placeholder.designation,
                employeeName: placeholder.employeeName,
            };

            // Remove alwaysUpdate keys from placeholder so $setOnInsert and $set
            // never touch the same field — MongoDB will throw a conflict otherwise
            const insertOnly = { ...placeholder };
            Object.keys(alwaysUpdate).forEach(k => delete insertOnly[k]);

            ops.push({
                updateOne: {
                    filter: { biometricId: empDoc.biometricId, dateStr },
                    update: {
                        $setOnInsert: insertOnly,   // only on new docs
                        $set: alwaysUpdate, // always refresh employee data
                    },
                    upsert: true,
                },
            });
        }
    }
    if (ops.length) await DailyAttendance.bulkWrite(ops, { ordered: false });
}

// ─────────────────────────────────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/** POST /sync */
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

/** GET /daily?date=YYYY-MM-DD&department=xxx */
router.get("/daily", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { date, department } = req.query;
        if (!date) return res.status(400).json({ success: false, message: "date required" });
        try { await syncDateRange(date, date); } catch (e) { console.warn("Auto-sync:", e.message); }

        const query = { dateStr: date };
        if (department && department !== "all") query.department = department;

        const records = await DailyAttendance.find(query).sort({ employeeName: 1 }).lean();
        const enriched = records.map(enrichRecord);

        const summary = { P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, WO: 0, PH: 0, MP: 0, total: enriched.length, unreviewed: 0 };
        enriched.forEach((r) => {
            const s = r.effectiveStatus;
            if (summary[s] !== undefined) summary[s]++;
            if (!r.hrReviewed) summary.unreviewed++;
        });
        summary.presentCount = (summary.P || 0) + (summary["P*"] || 0) + (summary["P~"] || 0) + (summary.MP || 0);

        res.json({ success: true, data: enriched, count: enriched.length, summary });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** GET /monthly?yearMonth=YYYY-MM&department=xxx&empCode=xxx */
router.get("/monthly", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { yearMonth, department, empCode } = req.query;
        if (!yearMonth) return res.status(400).json({ success: false, message: "yearMonth required" });

        const [year, month] = yearMonth.split("-").map(Number);
        const fromDate = `${yearMonth}-01`;
        const toDate = `${yearMonth}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
        try { await syncDateRange(fromDate, toDate, empCode || "ALL"); } catch (e) { /* ignore */ }

        const query = { yearMonth };
        if (department && department !== "all") query.department = department;
        if (empCode) query.biometricId = empCode;

        const records = await DailyAttendance.find(query).sort({ employeeName: 1, dateStr: 1 }).lean();

        const byEmployee = {};
        records.forEach((r) => {
            const key = r.biometricId;
            if (!byEmployee[key]) {
                byEmployee[key] = {
                    biometricId: r.biometricId,
                    numericId: r.numericId,
                    identityId: r.identityId,
                    employeeName: r.employeeName,
                    department: r.department,
                    designation: r.designation,
                    employeeType: r.employeeType,
                    days: [],
                    unreviewedDays: 0,
                };
            }
            const enriched = enrichRecord(r);
            byEmployee[key].days.push(enriched);
            if (!enriched.hrReviewed) byEmployee[key].unreviewedDays++;
        });

        const result = Object.values(byEmployee).map((e) => ({
            ...e,
            summary: computeMonthSummary(e.days),
            totalNetWorkStr: minsToHHMM(e.days.reduce((a, d) => a + (d.netWorkMins || 0), 0)),
            totalOtStr: minsToHHMM(e.days.reduce((a, d) => a + (d.otMins || 0), 0)),
        }));

        res.json({ success: true, yearMonth, fromDate, toDate, data: result, employeeCount: result.length });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** GET /employee/:empId?yearMonth=YYYY-MM  (accepts "0072" or "GR072") */
router.get("/employee/:empId", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { empId } = req.params;
        const { yearMonth } = req.query;
        if (!yearMonth) return res.status(400).json({ success: false, message: "yearMonth required" });

        const numericId = normalizeId(empId);
        if (numericId === null) return res.status(400).json({ success: false, message: "Invalid employee ID" });

        const [y, m] = yearMonth.split("-").map(Number);
        const from = `${yearMonth}-01`;
        const to = `${yearMonth}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
        try { await syncDateRange(from, to); } catch (e) { /* ignore */ }

        const records = await DailyAttendance.find({ numericId, yearMonth }).sort({ dateStr: 1 }).lean();
        res.json({ success: true, data: records.map(enrichRecord), summary: computeMonthSummary(records) });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** GET /analytics */
router.get("/analytics", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { year, quarter, month, department } = req.query;
        let yearMonths = [];
        if (month) {
            yearMonths = [month];
        } else if (quarter && year) {
            const qMap = { Q1: ["01", "02", "03"], Q2: ["04", "05", "06"], Q3: ["07", "08", "09"], Q4: ["10", "11", "12"] };
            yearMonths = (qMap[quarter] || []).map((m) => `${year}-${m}`);
        } else if (year) {
            yearMonths = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
        } else {
            const n = new Date();
            yearMonths = [`${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`];
        }

        const query = { yearMonth: { $in: yearMonths } };
        if (department && department !== "all") query.department = department;
        const records = await DailyAttendance.find(query).lean();

        const totals = { P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, WO: 0, PH: 0, MP: 0, totalOtMins: 0 };
        const byMonth = {}, byDept = {}, byEmployee = {};

        records.forEach((r) => {
            const s = r.hrFinalStatus ?? r.systemPrediction ?? r.status ?? "AB";
            totals[s] = (totals[s] || 0) + 1;
            totals.totalOtMins += r.otMins || 0;
            if (!byMonth[r.yearMonth]) byMonth[r.yearMonth] = { P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, MP: 0 };
            byMonth[r.yearMonth][s] = (byMonth[r.yearMonth][s] || 0) + 1;
            const dept = r.department || "Unknown";
            if (!byDept[dept]) byDept[dept] = { present: 0, absent: 0, late: 0, ot: 0 };
            if (["P", "P*", "P~", "MP"].includes(s)) byDept[dept].present++;
            else if (s === "AB") byDept[dept].absent++;
            if (s === "P*") byDept[dept].late++;
            byDept[dept].ot += r.otMins || 0;
            if (!byEmployee[r.biometricId]) {
                byEmployee[r.biometricId] = { name: r.employeeName, dept: r.department, identityId: r.identityId, present: 0, absent: 0, late: 0, ot: 0, hd: 0 };
            }
            if (["P", "P*", "P~", "MP"].includes(s)) byEmployee[r.biometricId].present++;
            else if (s === "AB") byEmployee[r.biometricId].absent++;
            else if (s === "HD") byEmployee[r.biometricId].hd++;
            if (s === "P*") byEmployee[r.biometricId].late++;
            byEmployee[r.biometricId].ot += r.otMins || 0;
        });

        const topOT = Object.entries(byEmployee).sort((a, b) => b[1].ot - a[1].ot).slice(0, 10).map(([id, v]) => ({ biometricId: id, ...v, otStr: minsToHHMM(v.ot) }));
        const topLate = Object.entries(byEmployee).sort((a, b) => b[1].late - a[1].late).slice(0, 10).map(([id, v]) => ({ biometricId: id, ...v }));

        res.json({ success: true, yearMonths, totals, byMonth, byDepartment: byDept, topOT, topLate });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** GET /muster-roll?yearMonth=YYYY-MM */
router.get("/muster-roll", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { yearMonth, department } = req.query;
        if (!yearMonth) return res.status(400).json({ success: false, message: "yearMonth required" });

        const [year, month] = yearMonth.split("-").map(Number);
        const daysInMonth = new Date(year, month, 0).getDate();
        const fromDate = `${yearMonth}-01`;
        const toDate = `${yearMonth}-${String(daysInMonth).padStart(2, "0")}`;
        try { await syncDateRange(fromDate, toDate); } catch (e) { /* ignore */ }

        const query = { yearMonth };
        if (department && department !== "all") query.department = department;
        const records = await DailyAttendance.find(query).sort({ employeeName: 1, dateStr: 1 }).lean();

        const byEmp = {};
        records.forEach((r) => {
            const es = r.hrFinalStatus ?? r.systemPrediction ?? r.status ?? "AB";
            if (!byEmp[r.biometricId]) {
                byEmp[r.biometricId] = {
                    empCode: r.biometricId,
                    identityId: r.identityId || r.biometricId,
                    name: r.employeeName,
                    department: r.department,
                    designation: r.designation,
                    employeeType: r.employeeType,
                    days: {},
                    hasUnreviewed: false,
                    summary: { present: 0, absent: 0, halfDay: 0, late: 0, leave: 0, wo: 0, ph: 0, mp: 0, totalWorkMins: 0, totalOtMins: 0 },
                };
            }
            const emp = byEmp[r.biometricId];
            const dayNum = new Date(r.dateStr + "T00:00:00Z").getUTCDate();
            if (!r.hrFinalStatus) emp.hasUnreviewed = true;

            emp.days[dayNum] = {
                status: es,
                systemStatus: r.systemPrediction,
                hrStatus: r.hrFinalStatus,
                isVerified: r.hrFinalStatus !== null,
                inTime: r.inTime ? `${String(new Date(r.inTime).getUTCHours()).padStart(2, "0")}:${String(new Date(r.inTime).getUTCMinutes()).padStart(2, "0")}` : "--:--",
                outTime: r.finalOut ? `${String(new Date(r.finalOut).getUTCHours()).padStart(2, "0")}:${String(new Date(r.finalOut).getUTCMinutes()).padStart(2, "0")}` : "--:--",
                netWork: minsToHHMM(r.netWorkMins),
                otTime: minsToHHMM(r.otMins),
                lateTime: minsToHHMM(r.lateMins),
                punchCount: r.punchCount,
                hasMissPunch: r.hasMissPunch,
                isWeeklyOff: r.isWeeklyOff,
                isHoliday: r.isHoliday,
                holidayName: r.holidayName,
                hrRemarks: r.hrRemarks,
            };

            const s = emp.summary;
            if (["P", "P*", "P~", "MP"].includes(es)) s.present++;
            else if (es === "HD") { s.halfDay++; }
            else if (es === "AB") s.absent++;
            else if (es === "WO") s.wo++;
            else if (es === "PH") s.ph++;
            else if (["L-CL", "L-SL", "L-EL", "LWP", "CO"].includes(es)) s.leave++;
            if (es === "P*") s.late++;
            if (es === "MP") s.mp++;
            s.totalWorkMins += r.netWorkMins || 0;
            s.totalOtMins += r.otMins || 0;
        });

        const dowLabels = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
        const dayHeaders = Array.from({ length: daysInMonth }, (_, i) => {
            const d = new Date(year, month - 1, i + 1);
            return { day: i + 1, dow: dowLabels[d.getDay()], date: `${yearMonth}-${String(i + 1).padStart(2, "0")}` };
        });

        const employees = Object.values(byEmp).map((emp) => ({
            ...emp,
            summary: { ...emp.summary, totalWorkStr: minsToHHMM(emp.summary.totalWorkMins), totalOtStr: minsToHHMM(emp.summary.totalOtMins) },
            daysArray: Array.from({ length: daysInMonth }, (_, i) => emp.days[i + 1] || {
                status: null, inTime: "--:--", outTime: "--:--",
                netWork: "00:00", otTime: "00:00", lateTime: "00:00",
                punchCount: 0, hasMissPunch: false, isWeeklyOff: false, isHoliday: false, isVerified: false,
            }),
        }));

        res.json({ success: true, yearMonth, daysInMonth, dayHeaders, employees, hasUnreviewed: employees.some(e => e.hasUnreviewed) });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** GET /today */
router.get("/today", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const today = new Date().toISOString().split("T")[0];
        try { await syncDateRange(today, today); } catch (e) { /* ignore */ }
        const records = await DailyAttendance.find({ dateStr: today }).lean();
        const summary = { total: records.length, present: 0, absent: 0, late: 0, mp: 0, unreviewed: 0 };
        records.forEach((r) => {
            const s = r.hrFinalStatus ?? r.systemPrediction ?? r.status ?? "AB";
            if (["P", "P*", "P~", "MP"].includes(s)) summary.present++;
            else if (s === "AB") summary.absent++;
            if (s === "MP") summary.mp++;
            if (s === "P*") summary.late++;
            if (!r.hrFinalStatus) summary.unreviewed++;
        });
        res.json({ success: true, date: today, summary, data: records.map(enrichRecord) });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── HR OVERRIDE ROUTES ────────────────────────────────────────────────────────

/** PUT /day-override  — HR sets hrFinalStatus for one day */
router.put("/day-override", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { biometricId, dateStr, hrFinalStatus, hrRemarks } = req.body;
        if (!dateStr || !hrFinalStatus) return res.status(400).json({ success: false, message: "dateStr and hrFinalStatus required" });

        const numericId = normalizeId(biometricId);
        const record = await DailyAttendance.findOne({ numericId, dateStr });
        if (!record) return res.status(404).json({ success: false, message: "Attendance record not found" });

        record.hrFinalStatus = hrFinalStatus;
        record.hrRemarks = hrRemarks || null;
        record.hrUpdatedBy = req.user?.id || null;
        record.hrUpdatedAt = new Date();
        await record.save();

        res.json({ success: true, message: "HR override saved", data: enrichRecord(record.toObject()) });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** PUT /month-finalise — confirm all unreviewed days with system prediction */
router.put("/month-finalise", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { yearMonth, biometricId } = req.body;
        if (!yearMonth) return res.status(400).json({ success: false, message: "yearMonth required" });

        const query = { yearMonth, hrFinalStatus: null };
        if (biometricId) query.numericId = normalizeId(biometricId);

        const result = await DailyAttendance.updateMany(
            query,
            [{ $set: { hrFinalStatus: "$systemPrediction", hrUpdatedAt: new Date() } }]
        );
        res.json({ success: true, message: `Finalised. ${result.modifiedCount} days confirmed.`, modifiedCount: result.modifiedCount });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** PUT /bulk-day-override */
router.put("/bulk-day-override", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { overrides } = req.body;
        if (!Array.isArray(overrides) || !overrides.length) return res.status(400).json({ success: false, message: "overrides array required" });
        const ops = overrides.map((o) => ({
            updateOne: {
                filter: { numericId: normalizeId(o.biometricId), dateStr: o.dateStr },
                update: { $set: { hrFinalStatus: o.hrFinalStatus, hrRemarks: o.hrRemarks || null, hrUpdatedBy: req.user?.id || null, hrUpdatedAt: new Date() } },
            },
        }));
        const result = await DailyAttendance.bulkWrite(ops, { ordered: false });
        res.json({ success: true, modifiedCount: result.modifiedCount });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────

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
        const allowed = ["shiftStart", "shiftEnd", "lateThresholdMinutes", "halfDayThresholdMinutes",
            "earlyDepartureThresholdMinutes", "otGracePeriodMins", "workingDays",
            "lunchBreakMins", "teaBreakMins", "overtimeEnabled", "overtimeMinimumMinutes",
            "overtimeMaxPerDay", "overtimeRateMultiplier"];
        const updates = {};
        allowed.forEach((k) => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
        if (req.user?.id) updates.updatedBy = req.user.id;
        const settings = await AttendanceSettings.findOneAndUpdate({}, { $set: updates }, { new: true, upsert: true, runValidators: true });
        res.json({ success: true, message: "Settings saved", data: settings });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── HOLIDAYS ──────────────────────────────────────────────────────────────────

router.post("/holidays", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { name, date, type, description, isRecurring } = req.body;
        if (!name || !date) return res.status(400).json({ success: false, message: "name and date required" });
        const settings = await AttendanceSettings.getSingleton();
        settings.holidays.push({ name, date, type: type || "company", description, isRecurring: isRecurring || false });
        await settings.save();
        await DailyAttendance.updateMany({ dateStr: date, punchCount: 0 }, { $set: { isHoliday: true, holidayName: name, holidayType: type || "company", systemPrediction: "PH" } });
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
        if (name) h.name = name; if (date) h.date = date; if (type) h.type = type;
        if (description !== undefined) h.description = description;
        if (isRecurring !== undefined) h.isRecurring = isRecurring;
        await settings.save();
        res.json({ success: true, data: settings.holidays });
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
        await DailyAttendance.updateMany({ dateStr: dateToRestore, punchCount: 0, isOnLeave: false }, { $set: { isHoliday: false, holidayName: null, holidayType: null, systemPrediction: "AB" } });
        res.json({ success: true, message: "Holiday removed" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── MISS PUNCH ────────────────────────────────────────────────────────────────

router.post("/miss-punch", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { biometricId, dateStr, punchSlot, requestedTime, reason } = req.body;
        if (!biometricId || !dateStr || !punchSlot || !requestedTime) return res.status(400).json({ success: false, message: "biometricId, dateStr, punchSlot, requestedTime required" });
        const numericId = normalizeId(biometricId);
        let record = await DailyAttendance.findOne({ numericId, dateStr });
        if (!record) return res.status(404).json({ success: false, message: "No attendance record found" });
        record.missPunchRequests.push({ requestedBy: req.user?.id, requestedAt: new Date(), punchSlot: parseInt(punchSlot, 10), requestedTime: new Date(requestedTime), reason, status: "pending" });
        record.hasMissPunch = true;
        await record.save();
        res.json({ success: true, message: "Miss punch request submitted" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.put("/miss-punch/:attendanceId/:requestId/approve", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { attendanceId, requestId } = req.params;
        const { stage } = req.body;
        const record = await DailyAttendance.findById(attendanceId);
        if (!record) return res.status(404).json({ success: false, message: "Record not found" });
        const mpReq = record.missPunchRequests.id(requestId);
        if (!mpReq) return res.status(404).json({ success: false, message: "Request not found" });

        if (stage === "manager") {
            mpReq.status = "manager_approved"; mpReq.managerApprovedBy = req.user?.id; mpReq.managerApprovedAt = new Date();
        } else if (stage === "hr") {
            if (mpReq.status !== "manager_approved") return res.status(400).json({ success: false, message: "Manager must approve first" });
            mpReq.status = "hr_approved"; mpReq.hrApprovedBy = req.user?.id; mpReq.hrApprovedAt = new Date();
            await applySettledMissPunch(record, mpReq);
        }
        await record.save();
        res.json({ success: true, message: `${stage} approval done`, data: enrichRecord(record.toObject()) });
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
        mpReq.status = "rejected"; mpReq.rejectedBy = req.user?.id; mpReq.rejectedAt = new Date(); mpReq.rejectionReason = reason || "";
        await record.save();
        res.json({ success: true, message: "Request rejected" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

async function applySettledMissPunch(record, mpReq) {
    const slotField = { 1: "inTime", 2: "lunchOut", 3: "lunchIn", 4: "teaOut", 5: "teaIn", 6: "finalOut" };
    const field = slotField[mpReq.punchSlot];
    if (!field) return;
    record[field] = mpReq.requestedTime;
    record.rawPunches.push({ seq: mpReq.punchSlot, time: mpReq.requestedTime, punchType: ["in", "lunch_out", "lunch_in", "tea_out", "tea_in", "out"][mpReq.punchSlot - 1] || "unknown", source: "miss_punch" });
    record.punchCount = record.rawPunches.length;
    const settings = await AttendanceSettings.getSingleton();
    computeDay(record, settings, record.employeeType, settings.holidays || []);
    record.hasMissPunch = record.missPunchRequests.some((r) => r.status === "pending" || r.status === "manager_approved");
}

/** GET /departments — from Employee records (not eTimeOffice) */
router.get("/departments", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const depts = await Employee.distinct("department");
        res.json({ success: true, data: depts.filter(Boolean).sort() });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** GET /debug-api */
router.get("/debug-api", EmployeeAuthMiddlewear, async (req, res) => {
    const { fromDate = new Date().toISOString().split("T")[0], toDate, empCode = "ALL" } = req.query;
    const f = toDate || fromDate;
    const { base, authHeader } = getTeamOfficeConfig();
    res.json({
        env: { TEAMOFFICE_BASE_URL: process.env.TEAMOFFICE_BASE_URL || "(not set)", TEAMOFFICE_AUTH_TOKEN: process.env.TEAMOFFICE_AUTH_TOKEN ? `SET (len ${process.env.TEAMOFFICE_AUTH_TOKEN.length})` : "(not set)" },
        resolvedBase: base, authSet: !!authHeader,
        testUrls: {
            inOut: `${base}/DownloadInOutPunchData?Empcode=${empCode}&FromDate=${toEtimeInOutDate(fromDate)}&ToDate=${toEtimeInOutDate(f)}`,
            punch: `${base}/DownloadPunchDataMCID?Empcode=${empCode}&FromDate=${toEtimePunchDate(fromDate, "00:00")}&ToDate=${toEtimePunchDate(f, "23:59")}`,
        },
    });
});

module.exports = router;