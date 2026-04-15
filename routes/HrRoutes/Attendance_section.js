"use strict";
const express = require("express");
const axios = require("axios");
const router = express.Router();
const ExcelJS = require("exceljs");

const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const AttendanceSettings = require("../../models/HR_Models/Attendancesettings");
const Employee = require("../../models/Employee");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");
const { CompanyHoliday, RegularizationRequest, LeaveApplication } = require("../../models/HR_Models/LeaveManagement");

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIG & AUTH
// ═══════════════════════════════════════════════════════════════════════════

const ETIME_BASE = (process.env.TEAMOFFICE_BASE_URL || "https://api.etimeoffice.com/api").replace(/\/+$/, "");

function getAuthHeader() {
    const token = process.env.TEAMOFFICE_AUTH_TOKEN;
    if (token) return `Basic ${token}`;
    const corp = process.env.TEAMOFFICE_CORP_ID || "";
    const user = process.env.TEAMOFFICE_USERNAME;
    const pass = process.env.TEAMOFFICE_PASSWORD;
    if (!user || !pass) throw new Error("TeamOffice credentials missing in .env");
    const raw = corp ? `${corp}:${user}:${pass}:true` : `${user}:${pass}:true`;
    return `Basic ${Buffer.from(raw).toString("base64")}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  eTimeOffice API FETCH
// ═══════════════════════════════════════════════════════════════════════════

const toPunchFormat = (dateStr, time = "00:00") => {
    const [y, m, d] = dateStr.split("-");
    return `${d}/${m}/${y}_${time}`;
};

async function fetchPunches(fromDate, toDate, empCode = "ALL") {
    const url = `${ETIME_BASE}/DownloadPunchDataMCID`;
    const params = {
        Empcode: empCode,
        FromDate: toPunchFormat(fromDate, "00:00"),
        ToDate: toPunchFormat(toDate, "23:59"),
    };
    const headers = { Authorization: getAuthHeader() };
    console.log("[ETIME] GET", url, params);
    const { data } = await axios.get(url, { params, headers, timeout: 30000 });
    if (data?.Error === true) throw new Error(data.Msg || "eTimeOffice Error:true");
    const punches = Array.isArray(data?.PunchData) ? data.PunchData : [];
    console.log(`[ETIME] got ${punches.length} punches`);
    return punches;
}

function parsePunchDate(str) {
    if (!str) return null;
    const [datePart, timePart = "00:00:00"] = String(str).trim().split(/\s+/);
    const [d, m, y] = datePart.split("/");
    const [hh, mm, ss = "00"] = timePart.split(":");
    const dt = new Date(+y, +m - 1, +d, +hh, +mm, +ss);
    return isNaN(dt.getTime()) ? null : dt;
}

const dateStrOf = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS (strings / times)
// ═══════════════════════════════════════════════════════════════════════════

const toTitleCase = (s) => String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const numericOf = (s) => { const d = String(s || "").replace(/\D/g, ""); return d ? parseInt(d, 10) : null; };

const minsOf = (d) => {
    if (!d) return null;
    const dt = new Date(d);
    // Force IST: UTC + 5:30 = 330 minutes
    const utcMins = dt.getUTCHours() * 60 + dt.getUTCMinutes();
    return (utcMins + 330) % 1440;
};
// Format a Date as "HH:MM" in IST — used in Excel exports
const fmtTimeIST = (d) => {
    if (!d) return "";
    const dt = new Date(d);
    return dt.toLocaleTimeString("en-IN", {
        hour: "2-digit", minute: "2-digit", hour12: false,
        timeZone: "Asia/Kolkata",
    });
};

// Format a Date as "9:56 am" in IST — used in API responses
const fmtTimeIST12 = (d) => {
    if (!d) return "—";
    const dt = new Date(d);
    return dt.toLocaleTimeString("en-IN", {
        hour: "numeric", minute: "2-digit", hour12: true,
        timeZone: "Asia/Kolkata",
    });
};

const hhmmMins = (s) => { const [h, m] = String(s || "00:00").split(":").map(Number); return (h || 0) * 60 + (m || 0); };

function normalizeName(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/\b(dr|mr|mrs|ms|miss|shri|smt|prof)\.?\b/g, "")
        .replace(/[^a-z0-9]/g, "");
}
function sortedNameKey(name) {
    const tokens = String(name || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    return normalizeName(tokens.sort().join(""));
}
function firstLastKey(name) {
    const tokens = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return null;
    return normalizeName(tokens[0] + tokens[tokens.length - 1]);
}

function extractName(emp, fallback = "") {
    const candidates = [
        emp?.fullName, emp?.name,
        emp?.basicInfo?.fullName, emp?.basicInfo?.name,
        emp?.personalInfo?.fullName, emp?.personalInfo?.name,
        emp?.profile?.fullName, emp?.profile?.name,
        [emp?.firstName, emp?.middleName, emp?.lastName].filter(Boolean).join(" ").trim(),
        [emp?.basicInfo?.firstName, emp?.basicInfo?.middleName, emp?.basicInfo?.lastName].filter(Boolean).join(" ").trim(),
        [emp?.personalInfo?.firstName, emp?.personalInfo?.middleName, emp?.personalInfo?.lastName].filter(Boolean).join(" ").trim(),
    ];
    for (const c of candidates) if (c && String(c).trim()) return String(c).trim();
    return fallback ? toTitleCase(fallback) : "";
}

const extractIdentity = (e) => e?.empCode || e?.employeeCode || e?.basicInfo?.empCode || e?.workInfo?.empCode || e?.code || e?.identityId || "";
const extractDepartment = (e) => e?.department || e?.workInfo?.department || e?.basicInfo?.department || "—";
const extractDesignation = (e) => e?.designation || e?.workInfo?.designation || e?.basicInfo?.designation || e?.jobTitle || e?.role || "—";
const extractBiometricId = (e) => e?.biometricId || e?.basicInfo?.biometricId || e?.workInfo?.biometricId || "";

// ═══════════════════════════════════════════════════════════════════════════
//  HOLIDAY HELPERS (NEW)
// ═══════════════════════════════════════════════════════════════════════════
//  Maps CompanyHoliday.type → attendance status code used in DailyAttendance.
//    national        → NH
//    optional        → OH
//    company         → FH  (festival / company-declared)
//    restricted      → RH
//    working_sunday  → null (means "treat this Sunday as working day")
// ═══════════════════════════════════════════════════════════════════════════

function holidayTypeToStatus(type) {
    switch (type) {
        case "national": return "NH";
        case "optional": return "OH";
        case "company": return "FH";
        case "restricted": return "RH";
        case "working_sunday": return null;
        default: return "FH";
    }
}

/**
 * Load all holidays in a date range as a Map<dateStr, holidayDoc>.
 * working_sunday entries are also included so callers can detect override.
 */
async function loadHolidayMap(fromStr, toStr) {
    const hols = await CompanyHoliday.find({ date: { $gte: fromStr, $lte: toStr } }).lean();
    const map = new Map();
    for (const h of hols) map.set(h.date, h);
    return map;
}

/**
 * Given a dateStr + the day-of-week, figure out what the "rest-day status"
 * should be for an employee who did NOT punch on that date.
 *   - If date has a national/company/optional/restricted holiday → that code
 *   - Else if Sunday (and no working_sunday override) → WO
 *   - Else → null (meaning: not a rest day, so employee is AB)
 */
function resolveRestDayStatus(dateStr, dayOfWeek, holidayMap) {
    const h = holidayMap.get(dateStr);
    if (h) {
        if (h.type === "working_sunday") return null; // Sunday is a working day this week
        return holidayTypeToStatus(h.type);
    }
    if (dayOfWeek === 0) return "WO";
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  DAY-RANGE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function allDaysInRange(from, to) {
    const start = new Date(from + "T00:00:00");
    const end = new Date(to + "T00:00:00");
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dates = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (d > today) continue;
        dates.push(dateStrOf(d));
    }
    return dates;
}

function workingDaysInRange(from, to, weeklyOffDay = 0) {
    const start = new Date(from + "T00:00:00");
    const end = new Date(to + "T00:00:00");
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dates = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (d > today) continue;
        if (d.getDay() === weeklyOffDay) continue;
        dates.push(dateStrOf(d));
    }
    return dates;
}

function isEffectivelyPresent(entry) {
    if (!entry) return false;
    if (entry.inTime && entry.finalOut) return true;
    const status = entry.hrFinalStatus || entry.systemPrediction;
    return ["P", "P*", "P~"].includes(status);
}

// ═══════════════════════════════════════════════════════════════════════════
//  EMPLOYEE TYPE RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

function designationMatches(designation, list) {
    if (!designation || !list?.length) return false;
    const d = String(designation).toUpperCase().trim();
    return list.some((entry) => {
        const e = String(entry).toUpperCase().trim();
        return e && (d === e || d.includes(e));
    });
}

function resolveEmployeeType(emp, settings) {
    if (!settings) return "executive";
    if (emp?.employeeType) {
        const t = String(emp.employeeType).toLowerCase();
        if (t === "operator" || t === "executive") return t;
    }
    const designation = extractDesignation(emp);
    const department = extractDepartment(emp).toUpperCase().trim();

    const opDesigs = settings.operatorDesignations || [];
    const execDesigs = settings.executiveDesignations || [];
    const coreDepts = new Set((settings.departmentCategories?.core || settings.operatorDepartments || []).map((d) => d.toUpperCase()));
    const genDepts = new Set((settings.departmentCategories?.general || []).map((d) => d.toUpperCase()));

    if (designationMatches(designation, opDesigs)) return "operator";
    if (designationMatches(designation, execDesigs)) return "executive";
    if (coreDepts.has(department)) return "operator";
    if (genDepts.has(department)) return "executive";
    return "executive";
}

// ═══════════════════════════════════════════════════════════════════════════
//  PUNCH ASSIGNMENT (with midpoint logic)
// ═══════════════════════════════════════════════════════════════════════════

function shiftMidpointMins(shift) {
    const s = hhmmMins(shift.start);
    const e = hhmmMins(shift.end);
    return Math.round((s + e) / 2);
}

function assignPunchTypes(punches, employeeType, shift, settings) {
    const expected = employeeType === "operator" ? 6 : 2;
    const sorted = [...punches].sort((a, b) => a.time - b.time);

    if (sorted.length === 0) {
        return { punches: [], expected, hasMissPunch: true };
    }

    const assigned = sorted.map((p) => ({ ...p, punchType: "unknown" }));

    if (assigned.length === 1) {
        const mode = settings?.singlePunchHandling?.mode || "midpoint";
        let kind = "in";
        if (mode === "assume-out") {
            kind = "out";
        } else if (mode === "midpoint") {
            const punchMins = minsOf(assigned[0].time);
            const mid = shiftMidpointMins(shift);
            kind = punchMins != null && punchMins >= mid ? "out" : "in";
        }
        assigned[0].punchType = kind;
        assigned[0].seq = 1;
        return { punches: assigned, expected, hasMissPunch: true };
    }

    assigned[0].punchType = "in";
    assigned[assigned.length - 1].punchType = "out";

    if (employeeType === "operator") {
        const middle = assigned.slice(1, -1);
        if (middle.length >= 1) middle[0].punchType = "lunch_out";
        if (middle.length >= 2) middle[1].punchType = "lunch_in";
        if (middle.length >= 3) middle[2].punchType = "tea_out";
        if (middle.length >= 4) middle[3].punchType = "tea_in";
    }

    assigned.forEach((p, i) => (p.seq = i + 1));
    return { punches: assigned, expected, hasMissPunch: assigned.length < expected };
}

// ═══════════════════════════════════════════════════════════════════════════
//  BUILD EMPLOYEE LOOKUP MAP
// ═══════════════════════════════════════════════════════════════════════════

async function buildEmployeeMap() {
    const employees = await Employee.find({
        $or: [{ status: "active" }, { status: { $exists: false } }, { isActive: true }],
    }).lean();

    const byBiometric = new Map();
    const byName = new Map();
    const bySorted = new Map();
    let skippedNoId = 0, skippedNoName = 0;

    for (const e of employees) {
        const bid = extractBiometricId(e);
        if (bid) {
            const k = String(bid).trim().toUpperCase();
            if (!byBiometric.has(k)) byBiometric.set(k, e);
            const num = numericOf(bid);
            if (num != null) {
                const nk = String(num);
                if (!byBiometric.has(nk)) byBiometric.set(nk, e);
            }
        } else {
            skippedNoId++;
        }

        const name = extractName(e);
        if (!name) { skippedNoName++; continue; }

        const k1 = normalizeName(name);
        if (k1 && !byName.has(k1)) byName.set(k1, e);
        const k2 = firstLastKey(name);
        if (k2 && k2 !== k1 && !byName.has(k2)) byName.set(k2, e);
        const k3 = sortedNameKey(name);
        if (k3 && !bySorted.has(k3)) bySorted.set(k3, e);
    }

    console.log(`[MAP] ${employees.length} emps → bioKeys=${byBiometric.size} nameKeys=${byName.size} sortedKeys=${bySorted.size} (noId:${skippedNoId}, noName:${skippedNoName})`);
    return { byBiometric, byName, bySorted, employees };
}

function providerKeys(empcode) {
    const raw = String(empcode || "").trim();
    const padded = raw.padStart(4, "0");
    const num = numericOf(raw);
    return {
        padded: `GR${padded}`.toUpperCase(),
        numeric: num != null ? String(num) : null,
        raw: raw.toUpperCase(),
    };
}

function matchEmployee({ Name, Empcode }, empMap) {
    const keys = providerKeys(Empcode);
    if (empMap.byBiometric.has(keys.padded)) return { employee: empMap.byBiometric.get(keys.padded), method: "biometric-exact" };
    if (keys.numeric && empMap.byBiometric.has(keys.numeric))
        return { employee: empMap.byBiometric.get(keys.numeric), method: "biometric-numeric" };
    if (empMap.byBiometric.has(keys.raw)) return { employee: empMap.byBiometric.get(keys.raw), method: "biometric-raw" };

    if (Name) {
        const k1 = normalizeName(Name);
        if (k1 && empMap.byName.has(k1)) return { employee: empMap.byName.get(k1), method: "name-exact" };
        const k2 = firstLastKey(Name);
        if (k2 && empMap.byName.has(k2)) return { employee: empMap.byName.get(k2), method: "name-first-last" };
        const k3 = sortedNameKey(Name);
        if (k3 && empMap.bySorted.has(k3)) return { employee: empMap.bySorted.get(k3), method: "name-sorted" };
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  PUNCH → DAY COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════
//  extraGraceMins (NEW): bonus grace added to today's late window because the
//  employee worked extra yesterday. Computed upstream in syncDay().
// ═══════════════════════════════════════════════════════════════════════════

function computeDay(punches, employeeType, shift, settings, extraGraceMins = 0) {
    if (!punches.length) {
        return {
            rawPunches: [], punchCount: 0, systemPrediction: "AB",
            hasMissPunch: false, isLate: false, lateMins: 0,
            netWorkMins: 0, otMins: 0, totalBreakMins: 0,
            lunchBreakMins: 0, teaBreakMins: 0, totalSpanMins: 0,
            isEarlyDeparture: false, earlyDepartureMins: 0, hasOT: false,
            inTime: null, lunchOut: null, lunchIn: null, teaOut: null, teaIn: null, finalOut: null,
            appliedExtraGraceMins: extraGraceMins || 0,
        };
    }

    const { punches: assigned, hasMissPunch } = assignPunchTypes(punches, employeeType, shift, settings);
    const find = (t) => assigned.find((p) => p.punchType === t)?.time || null;
    const inTime = find("in"), lunchOut = find("lunch_out"), lunchIn = find("lunch_in");
    const teaOut = find("tea_out"), teaIn = find("tea_in"), finalOut = find("out");

    const totalSpanMins = (inTime && finalOut) ? Math.round((finalOut - inTime) / 60000) : 0;
    const lunchBreakMins = (lunchOut && lunchIn) ? Math.max(0, Math.round((lunchIn - lunchOut) / 60000)) : 0;
    const teaBreakMins = (teaOut && teaIn) ? Math.max(0, Math.round((teaIn - teaOut) / 60000)) : 0;
    const totalBreakMins = lunchBreakMins + teaBreakMins;
    const netWorkMins = Math.max(0, totalSpanMins - totalBreakMins);

    const shiftStart = hhmmMins(shift.start);
    const shiftEnd = hhmmMins(shift.end);
    const inMins = minsOf(inTime);
    const outMins = minsOf(finalOut);

    // Effective late grace = shift's grace + any carry-forward bonus
    const effectiveGrace = (shift.lateGraceMins || 0) + (extraGraceMins || 0);
    const lateMins = (inMins != null) ? Math.max(0, inMins - (shiftStart + effectiveGrace)) : 0;
    const isLate = lateMins > 0;
    const earlyDepartureMins = (outMins != null) ? Math.max(0, shiftEnd - outMins) : 0;
    const isEarlyDeparture = earlyDepartureMins > 0;

    let otMins = 0;
    if (employeeType === "operator" && outMins != null) {
        const over = outMins - shiftEnd - (shift.otGraceMins || 0);
        if (over > 0) otMins = over;
    }

    const hasInAndOut = !!inTime && !!finalOut;

    let systemPrediction;
    if (!hasInAndOut) systemPrediction = "MP";
    else if (netWorkMins < (shift.halfDayThresholdMins || 240)) systemPrediction = "HD";
    else if (isLate) systemPrediction = "P*";
    else if (isEarlyDeparture) systemPrediction = "P~";
    else systemPrediction = "P";

    return {
        rawPunches: assigned.map((p) => ({
            seq: p.seq, time: p.time,
            mcid: p.mcid != null ? Number(p.mcid) : null,
            mFlag: p.mFlag || null, punchType: p.punchType, source: "device",
        })),
        punchCount: assigned.length,
        inTime, lunchOut, lunchIn, teaOut, teaIn, finalOut,
        totalSpanMins, lunchBreakMins, teaBreakMins, totalBreakMins,
        netWorkMins, otMins,
        isLate, lateMins, isEarlyDeparture, earlyDepartureMins,
        hasOT: otMins > 0, hasMissPunch,
        systemPrediction,
        appliedExtraGraceMins: extraGraceMins || 0,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//  GRACE CARRY-FORWARD — lookup yesterday's OT for each employee
// ═══════════════════════════════════════════════════════════════════════════

function getYesterdayStr(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() - 1);
    return dateStrOf(d);
}

async function buildYesterdayOtMap(dateStr, settings) {
    const gc = settings.graceCarryForward;
    if (!gc?.enabled) return new Map();

    const yesterday = getYesterdayStr(dateStr);
    const doc = await DailyAttendance.findOne({ dateStr: yesterday }).lean();
    if (!doc) return new Map();

    const map = new Map();
    for (const e of (doc.employees || [])) {
        if ((e.otMins || 0) >= (gc.triggerMins || 60)) {
            map.set(e.biometricId, gc.bonusGraceMins || 15);
        }
    }
    return map;
}

function graceAppliesTo(employeeType, settings) {
    const applyTo = settings.graceCarryForward?.applyTo || "both";
    if (applyTo === "both") return true;
    return applyTo === employeeType;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SYNC
// ═══════════════════════════════════════════════════════════════════════════

async function syncDay(dateStr, empCode = "ALL") {
    console.log(`[SYNC] Day ${dateStr}`);

    const settings = await AttendanceSettings.getConfig();
    const rawPunches = await fetchPunches(dateStr, dateStr, empCode);
    const empMap = await buildEmployeeMap();
    const holidayMap = await loadHolidayMap(dateStr, dateStr);
    const yesterdayOt = await buildYesterdayOtMap(dateStr, settings);

    const dayOfWeek = new Date(dateStr + "T00:00:00").getDay();
    const restDayStatus = resolveRestDayStatus(dateStr, dayOfWeek, holidayMap);

    const grouped = new Map();
    const ghostInfo = new Map();
    const methodTally = { "biometric-exact": 0, "biometric-numeric": 0, "biometric-raw": 0, "name-exact": 0, "name-first-last": 0, "name-sorted": 0, ghost: 0 };
    const nameMismatches = [];

    for (const p of rawPunches) {
        const time = parsePunchDate(p.PunchDate);
        if (!time || dateStrOf(time) !== dateStr) continue;

        const match = matchEmployee(p, empMap);
        const keys = providerKeys(p.Empcode);

        let groupKey, employee, isGhost, method;
        if (match) {
            employee = match.employee;
            method = match.method;
            groupKey = "E:" + employee._id.toString();
            isGhost = false;
            if (method.startsWith("biometric")) {
                const dbName = extractName(employee);
                const k1 = normalizeName(dbName);
                const k2 = normalizeName(p.Name);
                if (k1 && k2 && k1 !== k2 && !k1.includes(k2) && !k2.includes(k1)) {
                    nameMismatches.push({ biometricId: keys.padded, providerName: p.Name, dbName });
                }
            }
        } else {
            employee = null;
            method = "ghost";
            groupKey = "G:" + keys.padded;
            isGhost = true;
            if (!ghostInfo.has(keys.padded)) ghostInfo.set(keys.padded, { name: p.Name, empcode: p.Empcode });
        }
        methodTally[method]++;

        if (!grouped.has(groupKey)) {
            grouped.set(groupKey, {
                employee, isGhost,
                biometricId: keys.padded,
                providerName: p.Name,
                providerEmpcode: p.Empcode,
                method,
                punches: [],
            });
        }
        grouped.get(groupKey).punches.push({
            time, mcid: p.mcid || null, mFlag: p.M_Flag || null,
        });
    }

    const employees = [];
    const seenBiometricIds = new Set();

    for (const [, g] of grouped) {
        let employeeType, department, designation, employeeName, employeeDbId, identityId, numericId;

        if (g.isGhost) {
            employeeType = "operator";
            department = "PRODUCTION";
            designation = "OPERATOR";
            employeeName = toTitleCase(g.providerName || g.biometricId);
            employeeDbId = null;
            identityId = "";
            numericId = numericOf(g.providerEmpcode);
        } else {
            employeeType = resolveEmployeeType(g.employee, settings);
            department = extractDepartment(g.employee);
            designation = extractDesignation(g.employee);
            employeeName = extractName(g.employee, g.providerName);
            employeeDbId = g.employee._id;
            identityId = extractIdentity(g.employee);
            numericId = numericOf(g.biometricId);
        }

        const shift = settings.shifts[employeeType] || settings.shifts.executive;

        // Grace carry-forward: only apply if settings permit for this type
        const extraGrace = graceAppliesTo(employeeType, settings)
            ? (yesterdayOt.get(g.biometricId) || 0)
            : 0;

        const computed = computeDay(g.punches, employeeType, shift, settings, extraGrace);

        // Holiday override: if today is a holiday (FH/NH/OH/RH) and employee DID punch,
        // keep their P status (they get paid + present). If they didn't punch, they fall
        // into the "no record" branch below and get the holiday code.
        employees.push({
            employeeDbId,
            biometricId: g.biometricId,
            numericId,
            identityId,
            employeeName,
            department,
            designation,
            employeeType,
            isGhost: g.isGhost,
            matchMethod: g.method,
            providerName: g.providerName,
            ...computed,
            shiftStart: shift.start,
            shiftEnd: shift.end,
        });
        seenBiometricIds.add(g.biometricId);
    }

    // ── Inject holiday status for active employees who did NOT punch today ──
    // This gives FH/NH/OH/RH/WO rows in the day doc, so summaries show them
    // correctly and employees don't show as AB on a declared holiday.
    if (restDayStatus) {
        for (const emp of empMap.employees) {
            const bid = extractBiometricId(emp);
            if (!bid) continue;
            const key = String(bid).toUpperCase();
            if (seenBiometricIds.has(key)) continue;  // already has a row from punches

            const empType = resolveEmployeeType(emp, settings);
            const shift = settings.shifts[empType] || settings.shifts.executive;

            employees.push({
                employeeDbId: emp._id,
                biometricId: key,
                numericId: numericOf(key),
                identityId: extractIdentity(emp),
                employeeName: extractName(emp),
                department: extractDepartment(emp),
                designation: extractDesignation(emp),
                employeeType: empType,
                isGhost: false,
                matchMethod: "holiday-injected",
                providerName: null,
                rawPunches: [], punchCount: 0,
                inTime: null, lunchOut: null, lunchIn: null, teaOut: null, teaIn: null, finalOut: null,
                totalSpanMins: 0, lunchBreakMins: 0, teaBreakMins: 0, totalBreakMins: 0,
                netWorkMins: 0, otMins: 0,
                isLate: false, lateMins: 0, isEarlyDeparture: false, earlyDepartureMins: 0,
                hasOT: false, hasMissPunch: false,
                systemPrediction: restDayStatus,   // FH / NH / OH / RH / WO
                appliedExtraGraceMins: 0,
                shiftStart: shift.start,
                shiftEnd: shift.end,
            });
            seenBiometricIds.add(key);
        }
    }

    employees.sort((a, b) => {
        if (a.isGhost !== b.isGhost) return a.isGhost ? 1 : -1;
        return (a.employeeName || "").localeCompare(b.employeeName || "");
    });

    const unmatchedPunches = [...ghostInfo.entries()].map(([bid, info]) => ({
        biometricId: bid, empcode: info.empcode, name: info.name,
    }));

    const summary = buildSummary(employees);
    const date = new Date(dateStr + "T00:00:00");
    const existing = await DailyAttendance.findOne({ dateStr }).select("syncCount").lean();

    // Holiday metadata on the day document itself
    const dayHoliday = holidayMap.get(dateStr) || null;

    await DailyAttendance.updateOne(
        { dateStr },
        {
            $set: {
                dateStr, date,
                yearMonth: dateStr.slice(0, 7),
                dayOfWeek: date.getDay(),
                holiday: dayHoliday ? {
                    name: dayHoliday.name,
                    type: dayHoliday.type,
                    statusCode: holidayTypeToStatus(dayHoliday.type),
                } : null,
                employees, summary, unmatchedPunches,
                syncedAt: new Date(),
                syncSource: "etimeoffice",
                syncCount: (existing?.syncCount || 0) + 1,
            }
        },
        { upsert: true }
    );

    console.log(`[SYNC] ${dateStr}: ${employees.length} rows (real:${employees.filter(e => !e.isGhost).length} ghost:${employees.filter(e => e.isGhost).length}) methods=${JSON.stringify(methodTally)} holiday=${dayHoliday?.type || "none"}`);

    // After sync, replay approved leaves into this day's record (idempotent)
    try { await applyApprovedLeavesForDate(dateStr); }
    catch (e) { console.warn(`[SYNC] leave-sync for ${dateStr} failed:`, e.message); }

    return {
        dateStr,
        fetched: rawPunches.length,
        matched: rawPunches.length,
        employees: employees.length,
        ghostCount: employees.filter(e => e.isGhost).length,
        methodTally,
        nameMismatches,
        unmatchedList: unmatchedPunches,
        holiday: dayHoliday ? { date: dayHoliday.date, name: dayHoliday.name, type: dayHoliday.type } : null,
    };
}

function buildSummary(employees) {
    const s = {
        total: employees.length,
        P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, MP: 0, WO: 0, PH: 0,
        FH: 0, NH: 0, OH: 0, RH: 0,
        presentCount: 0, totalLateMins: 0, totalOtMins: 0, ghostCount: 0,
    };
    for (const e of employees) {
        const st = e.systemPrediction || "AB";
        if (s[st] !== undefined) s[st]++;
        s.totalLateMins += e.lateMins || 0;
        s.totalOtMins += e.otMins || 0;
        if (e.isGhost) s.ghostCount++;
    }
    s.presentCount = s.P + s["P*"] + s["P~"] + s.MP;
    return s;
}

async function syncDateRange(fromDate, toDate, empCode = "ALL") {
    const start = new Date(fromDate + "T00:00:00");
    const end = new Date(toDate + "T00:00:00");
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const results = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (d > today) continue;
        const ds = dateStrOf(d);
        try { results.push(await syncDay(ds, empCode)); }
        catch (e) { console.error(`[SYNC] ${ds} failed:`, e.message, e.stack); results.push({ dateStr: ds, error: e.message }); }
    }
    const agg = results.reduce((a, r) => ({
        fetched: a.fetched + (r.fetched || 0),
        matched: a.matched + (r.matched || 0),
        saved: a.saved + (r.employees || 0),
        ghostCount: a.ghostCount + (r.ghostCount || 0),
        employees: Math.max(a.employees, r.employees || 0),
        unmatchedList: [...a.unmatchedList, ...(r.unmatchedList || [])],
    }), { fetched: 0, matched: 0, saved: 0, ghostCount: 0, employees: 0, unmatchedList: [] });

    const seen = new Set();
    agg.unmatchedList = agg.unmatchedList.filter((u) => {
        if (seen.has(u.biometricId)) return false;
        seen.add(u.biometricId); return true;
    });
    agg.unmatched = agg.unmatchedList.length;
    return agg;
}

// ═══════════════════════════════════════════════════════════════════════════
//  LEAVE → ATTENDANCE SYNC (exported for Leave_section to call)
// ═══════════════════════════════════════════════════════════════════════════
//  Given an approved LeaveApplication, stamp `hrFinalStatus` on each day the
//  leave covers. Mapping:
//    leaveType "CL" → L-CL
//    leaveType "SL" → L-SL
//    leaveType "PL" → L-EL   (DB enum has L-EL, mobile sees "PL" as "Privilege")
//  We skip days where the employee was already marked WO/FH/NH/OH/RH because
//  a holiday on a leave date doesn't consume leave balance — the leave route
//  layer can re-examine this but for display this is correct.
// ═══════════════════════════════════════════════════════════════════════════

const LEAVE_TYPE_TO_STATUS = {
    CL: "L-CL",
    SL: "L-SL",
    PL: "L-EL",
};

async function applyLeaveToAttendance(leaveApp) {
    if (!leaveApp || leaveApp.status !== "hr_approved") return { applied: 0, skipped: 0 };

    const statusCode = LEAVE_TYPE_TO_STATUS[leaveApp.leaveType];
    if (!statusCode) {
        console.warn(`[LEAVE-APPLY] No mapping for leaveType=${leaveApp.leaveType}`);
        return { applied: 0, skipped: 0 };
    }

    const bid = String(leaveApp.biometricId || "").toUpperCase();
    if (!bid) {
        console.warn(`[LEAVE-APPLY] No biometricId on leave ${leaveApp._id}`);
        return { applied: 0, skipped: 0 };
    }

    let applied = 0, skipped = 0, missingDays = 0;
    const start = new Date(leaveApp.fromDate + "T00:00:00");
    const end = new Date(leaveApp.toDate + "T00:00:00");

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const ds = dateStrOf(new Date(d));
        const dayDoc = await DailyAttendance.findOne({ dateStr: ds });

        if (!dayDoc) {
            // Day not synced yet — will be picked up later by applyApprovedLeavesForDate
            // when the day finally syncs. Don't mark as fully applied.
            missingDays++;
            continue;
        }

        const idx = (dayDoc.employees || []).findIndex((e) => e.biometricId === bid);
        if (idx === -1) {
            // Inject a leave row so stats count it
            dayDoc.employees.push({
                employeeDbId: leaveApp.employeeId,
                biometricId: bid,
                employeeName: leaveApp.employeeName || "",
                department: leaveApp.department || "",
                designation: leaveApp.designation || "",
                employeeType: "executive",
                isGhost: false,
                matchMethod: "leave-injected",
                rawPunches: [], punchCount: 0,
                inTime: null, finalOut: null,
                netWorkMins: 0, otMins: 0, lateMins: 0,
                hasMissPunch: false, isLate: false, isEarlyDeparture: false, hasOT: false,
                totalSpanMins: 0, lunchBreakMins: 0, teaBreakMins: 0, totalBreakMins: 0,
                systemPrediction: "AB",
                hrFinalStatus: statusCode,
                hrRemarks: `Leave approved (${leaveApp.leaveType})`,
                hrReviewedAt: new Date(),
            });
            applied++;
        } else {
            const emp = dayDoc.employees[idx];
            // Don't overwrite a holiday/WO status with leave
            if (["WO", "FH", "NH", "OH", "RH", "PH"].includes(emp.systemPrediction)) {
                console.log(`[LEAVE-APPLY] ${bid} on ${ds}: skipped (rest day: ${emp.systemPrediction})`);
                skipped++;
                continue;
            }
            emp.hrFinalStatus = statusCode;
            emp.hrRemarks = `Leave approved (${leaveApp.leaveType})`;
            emp.hrReviewedAt = new Date();
            applied++;
        }

        dayDoc.markModified("employees");
        await dayDoc.save();
    }

    // Only mark fully-applied if no days are pending future sync
    if (missingDays === 0) {
        leaveApp.appliedToAttendance = true;
        leaveApp.appliedAt = new Date();
        if (leaveApp.save) await leaveApp.save();
    }

    console.log(`[LEAVE-APPLY] ${bid} ${leaveApp.fromDate}→${leaveApp.toDate} (${leaveApp.leaveType}): applied=${applied}, skipped=${skipped}, missingDays=${missingDays}`);
    return { applied, skipped, missingDays };
}

/**
 * Replay all approved leaves that overlap a given date.
 * Called from syncDay() so newly-synced days get their leave statuses.
 * Idempotent: writes the same hrFinalStatus repeatedly, no damage.
 */
async function applyApprovedLeavesForDate(dateStr) {
    const apps = await LeaveApplication.find({
        status: "hr_approved",
        fromDate: { $lte: dateStr },
        toDate: { $gte: dateStr },
    }).lean();

    let appliedCount = 0;
    for (const app of apps) {
        const statusCode = LEAVE_TYPE_TO_STATUS[app.leaveType];
        if (!statusCode) continue;
        const bid = String(app.biometricId || "").toUpperCase();
        if (!bid) continue;

        const dayDoc = await DailyAttendance.findOne({ dateStr });
        if (!dayDoc) continue;
        const idx = (dayDoc.employees || []).findIndex((e) => e.biometricId === bid);

        if (idx === -1) {
            // Employee not in day doc (didn't punch) — inject leave row
            dayDoc.employees.push({
                employeeDbId: app.employeeId,
                biometricId: bid,
                employeeName: app.employeeName || "",
                department: app.department || "",
                designation: app.designation || "",
                employeeType: "executive",
                isGhost: false,
                matchMethod: "leave-injected",
                rawPunches: [], punchCount: 0,
                inTime: null, finalOut: null,
                netWorkMins: 0, otMins: 0, lateMins: 0,
                hasMissPunch: false, isLate: false, isEarlyDeparture: false, hasOT: false,
                totalSpanMins: 0, lunchBreakMins: 0, teaBreakMins: 0, totalBreakMins: 0,
                systemPrediction: "AB",
                hrFinalStatus: statusCode,
                hrRemarks: `Leave approved (${app.leaveType})`,
                hrReviewedAt: new Date(),
            });
            appliedCount++;
            dayDoc.markModified("employees");
            await dayDoc.save();
            continue;
        }

        const emp = dayDoc.employees[idx];
        if (["WO", "FH", "NH", "OH", "RH", "PH"].includes(emp.systemPrediction)) continue;
        if (emp.hrFinalStatus === statusCode) continue;

        emp.hrFinalStatus = statusCode;
        emp.hrRemarks = emp.hrRemarks || `Leave approved (${app.leaveType})`;
        emp.hrReviewedAt = new Date();
        dayDoc.markModified("employees");
        await dayDoc.save();
        appliedCount++;
    }

    if (appliedCount > 0) {
        console.log(`[LEAVE-DATE-SYNC] ${dateStr}: applied ${appliedCount} leave(s)`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  LATE → HALF-DAY PROMOTION (daily view)
// ═══════════════════════════════════════════════════════════════════════════

async function applyMonthlyLatePromotion(dayDoc, settings) {
    const policy = settings.lateHalfDayPolicy;
    if (!policy?.enabled) {
        return (dayDoc.employees || []).map((e) => ({
            ...e, cumulativeLateMins: e.lateMins || 0,
            wasPromotedToHalfDay: false,
            effectiveStatus: e.hrFinalStatus || e.systemPrediction,
        }));
    }
    const thresholds = policy.cumulativeLateMinsThreshold || { operator: 30, executive: 40 };

    const allDays = await DailyAttendance.find({
        yearMonth: dayDoc.yearMonth, dateStr: { $lte: dayDoc.dateStr },
    }).select("dateStr employees.employeeDbId employees.biometricId employees.isLate employees.lateMins employees.employeeType")
        .sort({ dateStr: 1 }).lean();

    const running = new Map();
    const todayResult = new Map();

    for (const d of allDays) {
        const isToday = d.dateStr === dayDoc.dateStr;
        for (const e of (d.employees || [])) {
            const key = e.employeeDbId?.toString() || e.biometricId;
            if (!key) continue;
            let cum = running.get(key) || 0;
            let promoted = false;
            if (e.isLate && (e.lateMins || 0) > 0) {
                cum += e.lateMins;
                const threshold = thresholds[e.employeeType] ?? thresholds.operator ?? 30;
                if (cum >= threshold) { promoted = true; cum = 0; }
            }
            running.set(key, cum);
            if (isToday) todayResult.set(key, {
                cumulativeLateMins: cum, wasPromoted: promoted,
                thresholdForType: thresholds[e.employeeType] ?? thresholds.operator ?? 30,
            });
        }
    }

    return (dayDoc.employees || []).map((e) => {
        const key = e.employeeDbId?.toString() || e.biometricId;
        const info = todayResult.get(key) || { cumulativeLateMins: e.lateMins || 0, wasPromoted: false };
        let systemPrediction = e.systemPrediction;
        if (info.wasPromoted) systemPrediction = "HD";
        return {
            ...e,
            cumulativeLateMins: info.cumulativeLateMins,
            lateMinsThreshold: info.thresholdForType,
            wasPromotedToHalfDay: info.wasPromoted,
            systemPrediction,
            effectiveStatus: e.hrFinalStatus || systemPrediction,
        };
    });
}

const recomputeSummary = (emps) => buildSummary(emps.map((e) => ({ ...e, systemPrediction: e.effectiveStatus || e.systemPrediction })));

// ═══════════════════════════════════════════════════════════════════════════
//  DISPLAY LABEL HELPER
// ═══════════════════════════════════════════════════════════════════════════

function getDisplayLabel(rawStatus, settings) {
    const labels = settings?.displayLabels || {};
    return labels[rawStatus] || rawStatus || "";
}

// ═══════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════

router.get("/debug", EmployeeAuthMiddlewear, async (req, res) => {
    const envStatus = {
        TEAMOFFICE_BASE_URL: !!process.env.TEAMOFFICE_BASE_URL,
        TEAMOFFICE_AUTH_TOKEN: !!process.env.TEAMOFFICE_AUTH_TOKEN,
        TEAMOFFICE_USERNAME: !!process.env.TEAMOFFICE_USERNAME,
        TEAMOFFICE_PASSWORD: !!process.env.TEAMOFFICE_PASSWORD,
        TEAMOFFICE_CORP_ID: !!process.env.TEAMOFFICE_CORP_ID,
    };
    let authOk = false, authError = null;
    try { getAuthHeader(); authOk = true; } catch (e) { authError = e.message; }

    const totalEmployees = await Employee.countDocuments().catch(() => -1);
    const totalDays = await DailyAttendance.countDocuments().catch(() => -1);
    const sampleEmp = await Employee.findOne().lean().catch(() => null);
    const settings = await AttendanceSettings.getConfig().catch(() => null);

    let sampleBio = [], sampleNames = [];
    try {
        const empMap = await buildEmployeeMap();
        sampleBio = [...empMap.byBiometric.entries()].slice(0, 30).map(([k, e]) => ({
            key: k, name: extractName(e), dept: extractDepartment(e),
            designation: extractDesignation(e),
            resolvedType: resolveEmployeeType(e, settings),
        }));
        sampleNames = [...empMap.byName.entries()].slice(0, 20).map(([k, e]) => ({ key: k, name: extractName(e), bid: extractBiometricId(e) }));
    } catch (e) { /* noop */ }

    res.json({
        success: true, apiUrl: ETIME_BASE, envStatus, authOk, authError,
        totalEmployees, totalDays,
        settingsLoaded: !!settings,
        departmentCategories: settings?.departmentCategories,
        executiveDesignations: settings?.executiveDesignations,
        singlePunchHandling: settings?.singlePunchHandling,
        graceCarryForward: settings?.graceCarryForward,
        displayLabels: settings?.displayLabels,
        sampleEmployeeFields: sampleEmp ? Object.keys(sampleEmp) : [],
        extractedNameOfSample: sampleEmp ? extractName(sampleEmp) : null,
        extractedBioOfSample: sampleEmp ? extractBiometricId(sampleEmp) : null,
        sampleBiometricKeys: sampleBio,
        sampleNameKeys: sampleNames,
    });
});

router.get("/preview-match", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { name = "", empcode = "" } = req.query;
        const empMap = await buildEmployeeMap();
        const match = matchEmployee({ Name: name, Empcode: empcode }, empMap);
        const settings = await AttendanceSettings.getConfig();
        res.json({
            success: true,
            input: { name, empcode },
            providerKeys: providerKeys(empcode),
            matched: !!match,
            method: match?.method || null,
            employee: match ? {
                _id: match.employee._id,
                name: extractName(match.employee),
                biometricId: extractBiometricId(match.employee),
                empCode: extractIdentity(match.employee),
                department: extractDepartment(match.employee),
                designation: extractDesignation(match.employee),
                resolvedType: resolveEmployeeType(match.employee, settings),
            } : null,
        });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/sync", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { fromDate, toDate, empCode = "ALL" } = req.body;
        if (!fromDate || !toDate) return res.status(400).json({ success: false, message: "fromDate and toDate required" });
        const agg = await syncDateRange(fromDate, toDate, empCode);
        res.json({
            success: true,
            message: `Synced ${agg.saved} employees (${agg.ghostCount} ghost)`,
            ...agg,
        });
    } catch (err) {
        console.error("[SYNC] failed:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get("/daily", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { date, department } = req.query;
        if (!date) return res.status(400).json({ success: false, message: "date required" });

        const dayDoc = await DailyAttendance.findOne({ dateStr: date }).lean();
        if (!dayDoc) {
            syncDay(date).catch((e) => console.warn("[BG-SYNC]", e.message));
            return res.json({
                success: true, data: [], count: 0, summary: null,
                unmatchedPunches: [], synced: false,
                message: "No data yet. Syncing in background — refresh in a moment.",
            });
        }

        const settings = await AttendanceSettings.getConfig();
        let employees = await applyMonthlyLatePromotion(dayDoc, settings);
        if (department && department !== "all") employees = employees.filter((e) => e.department === department);
        const summary = recomputeSummary(employees);

        // attach display labels for UI convenience
        employees = employees.map((e) => ({
            ...e,
            displayStatus: getDisplayLabel(e.effectiveStatus || e.systemPrediction, settings),
        }));

        res.json({
            success: true, data: employees, count: employees.length,
            summary, unmatchedPunches: dayDoc.unmatchedPunches || [],
            holiday: dayDoc.holiday || null,
            syncedAt: dayDoc.syncedAt, synced: true,
        });
    } catch (err) {
        console.error("[DAILY]", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get("/departments", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const [a, b, c] = await Promise.all([
            Employee.distinct("department"),
            Employee.distinct("workInfo.department"),
            Employee.distinct("basicInfo.department"),
        ]);
        const combined = [...new Set([...a, ...b, ...c].filter(Boolean))].sort();
        res.json({ success: true, data: combined });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/employee/:empId", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { empId } = req.params;
        const { yearMonth } = req.query;
        if (!yearMonth) return res.status(400).json({ success: false, message: "yearMonth required" });

        const isObjectId = /^[0-9a-fA-F]{24}$/.test(empId);
        const match = isObjectId
            ? { "employees.employeeDbId": empId }
            : { "employees.biometricId": empId.toUpperCase() };

        const days = await DailyAttendance.find({ yearMonth, ...match }).sort({ dateStr: 1 }).lean();
        const history = days.map((d) => {
            const entry = (d.employees || []).find((e) =>
                isObjectId ? e.employeeDbId?.toString() === empId : e.biometricId === empId.toUpperCase()
            );
            if (!entry) return null;
            return { dateStr: d.dateStr, ...entry, effectiveStatus: entry.hrFinalStatus || entry.systemPrediction };
        }).filter(Boolean);
        res.json({ success: true, yearMonth, data: history, count: history.length });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/settings", EmployeeAuthMiddlewear, async (req, res) => {
    try { res.json({ success: true, data: await AttendanceSettings.getConfig() }); }
    catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.put("/settings", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const {
            shifts, lateHalfDayPolicy, operatorDepartments,
            departmentCategories, executiveDesignations, operatorDesignations,
            singlePunchHandling, graceCarryForward, displayLabels,
        } = req.body;
        const update = {};
        if (shifts) update.shifts = shifts;
        if (lateHalfDayPolicy) update.lateHalfDayPolicy = lateHalfDayPolicy;
        if (operatorDepartments) update.operatorDepartments = operatorDepartments.map((d) => d.toUpperCase());
        if (departmentCategories) update.departmentCategories = {
            core: (departmentCategories.core || []).map((d) => d.toUpperCase()),
            general: (departmentCategories.general || []).map((d) => d.toUpperCase()),
        };
        if (executiveDesignations) update.executiveDesignations = executiveDesignations.map((d) => d.toUpperCase());
        if (operatorDesignations) update.operatorDesignations = operatorDesignations.map((d) => d.toUpperCase());
        if (singlePunchHandling) update.singlePunchHandling = singlePunchHandling;
        if (graceCarryForward) update.graceCarryForward = graceCarryForward;
        if (displayLabels) update.displayLabels = displayLabels;

        await AttendanceSettings.updateOne({ _id: "singleton" }, { $set: update }, { upsert: true });
        res.json({ success: true, data: await AttendanceSettings.getConfig() });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/test-connection", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const today = dateStrOf(new Date());
        const punches = await fetchPunches(today, today);
        res.json({ success: true, apiUrl: ETIME_BASE, todayPunches: punches.length, sample: punches[0] || null });
    } catch (err) { res.status(500).json({ success: false, message: err.message, apiUrl: ETIME_BASE }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PERIOD SUMMARY — now includes holiday counts
// ═══════════════════════════════════════════════════════════════════════════

router.get("/summary", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { from, to, department } = req.query;
        if (!from || !to) return res.status(400).json({ success: false, message: "from and to required" });

        const allActive = await Employee.find({
            $or: [{ status: "active" }, { status: { $exists: false } }, { isActive: true }],
        }).lean();

        const settings = await AttendanceSettings.getConfig();
        const thresholds = settings.lateHalfDayPolicy?.cumulativeLateMinsThreshold || { operator: 30, executive: 40 };

        const filteredActive = (department && department !== "all")
            ? allActive.filter((e) => extractDepartment(e) === department)
            : allActive;

        const days = await DailyAttendance.find({ dateStr: { $gte: from, $lte: to } })
            .sort({ dateStr: 1 }).lean();

        const holidayMap = await loadHolidayMap(from, to);

        const syncedDates = new Set(days.map((d) => d.dateStr));
        const workingDates = workingDaysInRange(from, to);
        const unsyncedWorkingDates = workingDates.filter((d) => !syncedDates.has(d));

        // Holidays in this range (excluding working_sunday overrides)
        const activeHolidays = [...holidayMap.values()]
            .filter(h => h.type !== "working_sunday")
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(h => ({
                date: h.date, name: h.name, type: h.type,
                description: h.description || "",
                statusCode: holidayTypeToStatus(h.type),
            }));

        const perEmp = new Map();
        const running = new Map();
        let lastYM = null;

        const agg = {
            from, to,
            workingDays: workingDates.length,
            syncedDays: days.length,
            unsyncedWorkingDays: unsyncedWorkingDates.length,
            unsyncedDates: unsyncedWorkingDates,
            totalPunches: 0,
            P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, MP: 0, WO: 0, PH: 0,
            FH: 0, NH: 0, OH: 0, RH: 0,
            effectivePresent: 0,
            totalLateMins: 0, totalOtMins: 0, totalNetWorkMins: 0,
            autoPromotedHDs: 0,
            sundayWorkedCount: 0,
            holidayWorkedCount: 0,
            totalAttendance: 0,
            holidayCount: activeHolidays.length,
            holidays: activeHolidays,
        };

        for (const emp of filteredActive) {
            const bid = extractBiometricId(emp);
            if (!bid) continue;
            const key = String(bid).toUpperCase();
            const empType = resolveEmployeeType(emp, settings);
            perEmp.set(key, {
                biometricId: key,
                employeeDbId: emp._id,
                employeeName: extractName(emp),
                department: extractDepartment(emp),
                designation: extractDesignation(emp),
                employeeType: empType,
                isGhost: false,
                recordedDays: 0,
                recordedWorkingDays: 0,
                days: {
                    P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, MP: 0, WO: 0, PH: 0,
                    FH: 0, NH: 0, OH: 0, RH: 0, leaves: 0,
                },
                effectivePresent: 0,
                totalLateMins: 0, totalOtMins: 0, totalNetWorkMins: 0, autoHDs: 0,
                sundayWorked: 0,
                holidayWorked: 0,
                totalAttendance: 0,
            });
        }

        for (const d of days) {
            if (d.yearMonth !== lastYM) { running.clear(); lastYM = d.yearMonth; }
            const dt = new Date(d.dateStr + "T00:00:00");
            const isSunday = dt.getDay() === 0;
            const hol = holidayMap.get(d.dateStr);
            const isDeclaredHoliday = !!hol && hol.type !== "working_sunday";

            for (const e of (d.employees || [])) {
                if (department && department !== "all" && e.department !== department) continue;

                const key = e.biometricId;
                if (!perEmp.has(key)) {
                    perEmp.set(key, {
                        biometricId: e.biometricId,
                        employeeDbId: e.employeeDbId,
                        employeeName: e.employeeName,
                        department: e.department,
                        designation: e.designation,
                        employeeType: e.employeeType,
                        isGhost: true,
                        recordedDays: 0,
                        recordedWorkingDays: 0,
                        days: {
                            P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, MP: 0, WO: 0, PH: 0,
                            FH: 0, NH: 0, OH: 0, RH: 0, leaves: 0,
                        },
                        effectivePresent: 0,
                        totalLateMins: 0, totalOtMins: 0, totalNetWorkMins: 0, autoHDs: 0,
                        sundayWorked: 0, holidayWorked: 0,
                        totalAttendance: 0,
                    });
                }
                const b = perEmp.get(key);
                b.recordedDays++;
                if (!isSunday) b.recordedWorkingDays++;

                // Sunday worked (punched + Sunday, not holiday)
                if (isSunday && !isDeclaredHoliday && (e.punchCount || 0) > 0) {
                    b.sundayWorked++;
                    agg.sundayWorkedCount++;
                }

                // Holiday worked (punched + declared holiday)
                if (isDeclaredHoliday && (e.punchCount || 0) > 0) {
                    b.holidayWorked++;
                    agg.holidayWorkedCount++;
                }
                let cum = running.get(key) || 0;
                let status = e.systemPrediction;
                let promoted = false;
                if (settings.lateHalfDayPolicy?.enabled && e.isLate && (e.lateMins || 0) > 0) {  // ← add the policy guard
                    cum += e.lateMins;
                    const thr = thresholds[e.employeeType] ?? thresholds.operator ?? 30;
                    if (cum >= thr) { status = "HD"; promoted = true; cum = 0; }
                }
                running.set(key, cum);
                const final = e.hrFinalStatus || status;
                if (b.days[final] !== undefined) b.days[final]++;
                if (["L-CL", "L-SL", "L-EL", "LWP", "WFH", "CO"].includes(final)) b.days.leaves++;
                if (agg[final] !== undefined) agg[final]++;

                if (isEffectivelyPresent({ ...e, systemPrediction: final })) {
                    b.effectivePresent++;
                    agg.effectivePresent++;
                }

                // TOTAL ATTENDANCE: anything that counts as a "day worked/paid"
                const paidCodes = ["P", "P*", "P~", "HD", "MP", "WO", "FH", "NH", "OH", "RH", "PH", "L-CL", "L-SL", "L-EL", "WFH", "CO"];
                if (paidCodes.includes(final)) {
                    b.totalAttendance++;
                    agg.totalAttendance++;
                }

                b.totalLateMins += e.lateMins || 0;
                b.totalOtMins += e.otMins || 0;
                b.totalNetWorkMins += e.netWorkMins || 0;
                if (promoted) b.autoHDs++;

                agg.totalLateMins += e.lateMins || 0;
                agg.totalOtMins += e.otMins || 0;
                agg.totalNetWorkMins += e.netWorkMins || 0;
                agg.totalPunches += e.punchCount || 0;
                if (promoted) agg.autoPromotedHDs++;
            }
        }

        const workingSyncedDates = workingDates.filter((d) => syncedDates.has(d));

        for (const [key, b] of perEmp) {
            if (b.isGhost) continue;
            const missing = Math.max(0, workingSyncedDates.length - b.recordedWorkingDays);
            if (missing > 0) {
                b.days.AB += missing;
                agg.AB += missing;
            }
        }

        const employees = [...perEmp.values()].sort((a, b) => (a.employeeName || "").localeCompare(b.employeeName || ""));
        agg.totalEmployees = employees.length;
        agg.activeEmployees = filteredActive.length;
        agg.ghostEmployeeCount = employees.filter((e) => e.isGhost).length;
        agg.presentCount = agg.P + agg["P*"] + agg["P~"];
        agg.displayLabels = settings.displayLabels || {};

        res.json({ success: true, ...agg, employees });
    } catch (err) {
        console.error("[SUMMARY]", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  EMPLOYEE DETAIL (for drawer)
// ═══════════════════════════════════════════════════════════════════════════
router.get("/employee-detail", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { biometricId, from, to } = req.query;
        if (!biometricId || !from || !to) {
            return res.status(400).json({ success: false, message: "biometricId, from, to required" });
        }
        const bid = String(biometricId).toUpperCase();

        const settings = await AttendanceSettings.getConfig();
        const thresholds = settings.lateHalfDayPolicy?.cumulativeLateMinsThreshold || { operator: 30, executive: 40 };

        const days = await DailyAttendance.find({ dateStr: { $gte: from, $lte: to } })
            .sort({ dateStr: 1 }).lean();

        const holidayMap = await loadHolidayMap(from, to);

        const start = new Date(from + "T00:00:00");
        const end = new Date(to + "T00:00:00");
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const calendar = [];
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            if (d > today) continue;
            const ds = dateStrOf(new Date(d));
            const dow = d.getDay();
            const hol = holidayMap.get(ds);
            calendar.push({
                dateStr: ds,
                dayName: new Date(d).toLocaleDateString("en-IN", { weekday: "short" }),
                dayNum: d.getDate(),
                isSunday: dow === 0,
                restStatus: resolveRestDayStatus(ds, dow, holidayMap),
                holiday: hol || null,
                isHoliday: !!hol && hol.type !== "working_sunday",
                holidayName: (hol && hol.type !== "working_sunday") ? hol.name : null,
                holidayType: (hol && hol.type !== "working_sunday") ? hol.type : null,
            });
        }

        const byDate = new Map(days.map((d) => [d.dateStr, d]));
        const running = new Map();
        let lastYM = null;
        let empMeta = null;

        const rows = [];
        const stats = {
            P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, MP: 0, WO: 0, PH: 0,
            FH: 0, NH: 0, OH: 0, RH: 0,
            "L-CL": 0, "L-SL": 0, "L-EL": 0, LWP: 0, WFH: 0, CO: 0,
            leaves: 0,
            unsynced: 0, effectivePresent: 0,
            totalLateMins: 0, totalOtMins: 0, totalNetWorkMins: 0,
            sundayWorked: 0,
            holidayWorked: 0,
            totalAttendance: 0,
        };

        for (const cal of calendar) {
            const dayDoc = byDate.get(cal.dateStr);

            if (!dayDoc) {
                if (cal.restStatus) {
                    rows.push({
                        ...cal,
                        status: cal.restStatus,
                        label: getDisplayLabel(cal.restStatus, settings),
                        synced: false,
                    });
                    if (stats[cal.restStatus] !== undefined) stats[cal.restStatus]++;
                    stats.totalAttendance++;
                } else {
                    rows.push({ ...cal, status: "UNSYNCED", label: "Not synced", synced: false });
                    stats.unsynced++;
                }
                continue;
            }

            const entry = (dayDoc.employees || []).find((e) => e.biometricId === bid);
            if (!entry) {
                const s = cal.restStatus || "AB";
                rows.push({ ...cal, status: s, label: getDisplayLabel(s, settings), synced: true });
                if (stats[s] !== undefined) stats[s]++;
                if (s !== "AB") stats.totalAttendance++;
                continue;
            }

            if (dayDoc.yearMonth !== lastYM) { running.clear(); lastYM = dayDoc.yearMonth; }

            if (!empMeta) empMeta = {
                employeeName: entry.employeeName, department: entry.department,
                designation: entry.designation, employeeType: entry.employeeType,
                identityId: entry.identityId, biometricId: entry.biometricId,
                isGhost: !!entry.isGhost,
            };

            let cum = running.get(bid) || 0;
            let status = entry.systemPrediction;
            let promoted = false;
            if (settings.lateHalfDayPolicy?.enabled && entry.isLate && (entry.lateMins || 0) > 0) {  // ← add the policy guard
                cum += entry.lateMins;
                const thr = thresholds[entry.employeeType] ?? thresholds.operator ?? 30;
                if (cum >= thr) { status = "HD"; promoted = true; cum = 0; }
            }
            running.set(bid, cum);
            const finalStatus = entry.hrFinalStatus || status;

            if (isEffectivelyPresent({ ...entry, systemPrediction: finalStatus })) stats.effectivePresent++;
            if (stats[finalStatus] !== undefined) stats[finalStatus]++;
            if (["L-CL", "L-SL", "L-EL", "LWP", "WFH", "CO"].includes(finalStatus)) stats.leaves++;

            const paidCodes = ["P", "P*", "P~", "HD", "MP", "WO", "FH", "NH", "OH", "RH", "PH", "L-CL", "L-SL", "L-EL", "WFH", "CO"];
            if (paidCodes.includes(finalStatus)) stats.totalAttendance++;

            stats.totalLateMins += entry.lateMins || 0;
            stats.totalOtMins += entry.otMins || 0;
            stats.totalNetWorkMins += entry.netWorkMins || 0;

            const punched = (entry.punchCount || 0) > 0;
            const isSundayWorked = cal.isSunday && !cal.isHoliday && punched;
            const punchedOnHoliday = cal.isHoliday && punched;
            if (isSundayWorked) stats.sundayWorked++;
            if (punchedOnHoliday) stats.holidayWorked++;

            rows.push({
                ...cal,
                status: finalStatus,
                label: getDisplayLabel(finalStatus, settings),
                synced: true,
                isSundayWorked,
                punchedOnHoliday,
                inTime: entry.inTime, lunchOut: entry.lunchOut, lunchIn: entry.lunchIn,
                teaOut: entry.teaOut, teaIn: entry.teaIn, finalOut: entry.finalOut,
                punchCount: entry.punchCount,
                rawPunches: entry.rawPunches || [],
                netWorkMins: entry.netWorkMins || 0,
                totalBreakMins: entry.totalBreakMins || 0,
                lateMins: entry.lateMins || 0,
                otMins: entry.otMins || 0,
                isLate: entry.isLate,
                isEarlyDeparture: entry.isEarlyDeparture,
                hasMissPunch: entry.hasMissPunch,
                hasOT: entry.hasOT,
                earlyDepartureMins: entry.earlyDepartureMins || 0,
                shiftStart: entry.shiftStart,
                shiftEnd: entry.shiftEnd,
                appliedExtraGraceMins: entry.appliedExtraGraceMins || 0,
                wasPromotedToHalfDay: promoted,
                cumulativeLateMins: cum,
                hrFinalStatus: entry.hrFinalStatus || null,
                hrRemarks: entry.hrRemarks || null,
                systemPrediction: entry.systemPrediction,
            });
        }

        res.json({
            success: true,
            from, to,
            biometricId: bid,
            employee: empMeta,
            rows,
            stats,
            displayLabels: settings.displayLabels || {},
        });
    } catch (err) {
        console.error("[EMPLOYEE-DETAIL]", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  SYNC PERIOD
// ═══════════════════════════════════════════════════════════════════════════

router.post("/sync-period", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { from, to, onlyMissing = false } = req.body;
        if (!from || !to) return res.status(400).json({ success: false, message: "from and to required" });

        const todayStr = dateStrOf(new Date());
        const actualTo = to > todayStr ? todayStr : to;

        let datesToSync;
        if (onlyMissing) {
            const existing = await DailyAttendance.find({ dateStr: { $gte: from, $lte: actualTo } })
                .select("dateStr").lean();
            const have = new Set(existing.map((d) => d.dateStr));
            datesToSync = allDaysInRange(from, actualTo).filter((d) => !have.has(d));
        } else {
            datesToSync = allDaysInRange(from, actualTo);
        }

        console.log(`[SYNC-PERIOD] ${from}..${actualTo} → ${datesToSync.length} days (onlyMissing=${onlyMissing})`);

        const results = [];
        for (const dateStr of datesToSync) {
            try { results.push(await syncDay(dateStr)); }
            catch (e) { console.error(`[SYNC-PERIOD] ${dateStr} failed:`, e.message, e.stack); results.push({ dateStr, error: e.message }); }
        }

        const aggregate = results.reduce((a, r) => ({
            daysSynced: a.daysSynced + (r.error ? 0 : 1),
            daysFailed: a.daysFailed + (r.error ? 1 : 0),
            totalFetched: a.totalFetched + (r.fetched || 0),
            totalEmployees: Math.max(a.totalEmployees, r.employees || 0),
            totalGhosts: a.totalGhosts + (r.ghostCount || 0),
        }), { daysSynced: 0, daysFailed: 0, totalFetched: 0, totalEmployees: 0, totalGhosts: 0 });

        res.json({
            success: true,
            message: `Synced ${aggregate.daysSynced}/${datesToSync.length} days`,
            range: { from, to: actualTo },
            ...aggregate,
            details: results,
        });
    } catch (err) {
        console.error("[SYNC-PERIOD]", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  HR OVERRIDE
// ═══════════════════════════════════════════════════════════════════════════

router.put("/day-override", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { dateStr, biometricId, hrFinalStatus, hrRemarks, inTime, finalOut } = req.body;
        if (!dateStr || !biometricId) return res.status(400).json({ success: false, message: "dateStr and biometricId required" });

        const validStatuses = [
            "P", "P*", "P~", "HD", "AB", "WO", "PH", "FH", "NH", "OH", "RH",
            "L-CL", "L-SL", "L-EL", "LWP", "MP", "WFH", "CO", null, "",
        ];
        if (hrFinalStatus !== undefined && !validStatuses.includes(hrFinalStatus)) {
            return res.status(400).json({ success: false, message: `Invalid status. Allowed: ${validStatuses.filter(Boolean).join(", ")}` });
        }

        const bid = biometricId.toUpperCase();
        const dayDoc = await DailyAttendance.findOne({ dateStr, "employees.biometricId": bid });
        if (!dayDoc) return res.status(404).json({ success: false, message: `No record for ${biometricId} on ${dateStr}` });

        const empIdx = dayDoc.employees.findIndex((e) => e.biometricId === bid);
        if (empIdx === -1) return res.status(404).json({ success: false, message: `Employee ${biometricId} not in day doc` });

        const emp = dayDoc.employees[empIdx];

        if (hrFinalStatus !== undefined) emp.hrFinalStatus = hrFinalStatus || null;
        if (hrRemarks !== undefined) emp.hrRemarks = hrRemarks || null;
        emp.hrReviewedAt = new Date();

        const needsTimeUpdate = inTime !== undefined || finalOut !== undefined;
        if (needsTimeUpdate) {
            const parseTimeOnDate = (timeStr) => {
                if (!timeStr) return null;
                const [h, m] = String(timeStr).split(":").map(Number);
                const d = new Date(dateStr + "T00:00:00");
                d.setHours(h || 0, m || 0, 0, 0);
                return d;
            };

            const newIn = inTime !== undefined ? (inTime ? parseTimeOnDate(inTime) : null) : emp.inTime;
            const newOut = finalOut !== undefined ? (finalOut ? parseTimeOnDate(finalOut) : null) : emp.finalOut;

            emp.inTime = newIn;
            emp.finalOut = newOut;

            const settings = await AttendanceSettings.getConfig();
            const shift = settings.shifts[emp.employeeType] || settings.shifts.executive;
            const shiftStart = hhmmMins(shift.start);
            const shiftEnd = hhmmMins(shift.end);
            const inMins = minsOf(newIn);
            const outMins = minsOf(newOut);

            const totalSpanMins = (newIn && newOut) ? Math.round((newOut - newIn) / 60000) : 0;
            const lunchBreakMins = (emp.lunchOut && emp.lunchIn) ? Math.max(0, Math.round((emp.lunchIn - emp.lunchOut) / 60000)) : 0;
            const teaBreakMins = (emp.teaOut && emp.teaIn) ? Math.max(0, Math.round((emp.teaIn - emp.teaOut) / 60000)) : 0;
            const totalBreakMins = lunchBreakMins + teaBreakMins;
            const netWorkMins = Math.max(0, totalSpanMins - totalBreakMins);

            const effectiveGrace = (shift.lateGraceMins || 0) + (emp.appliedExtraGraceMins || 0);
            const lateMins = (inMins != null) ? Math.max(0, inMins - (shiftStart + effectiveGrace)) : 0;
            const earlyDepartureMins = (outMins != null) ? Math.max(0, shiftEnd - outMins) : 0;

            let otMins = 0;
            if (emp.employeeType === "operator" && outMins != null) {
                const over = outMins - shiftEnd - (shift.otGraceMins || 0);
                if (over > 0) otMins = over;
            }

            emp.totalSpanMins = totalSpanMins;
            emp.totalBreakMins = totalBreakMins;
            emp.netWorkMins = netWorkMins;
            emp.lateMins = lateMins;
            emp.isLate = lateMins > 0;
            emp.earlyDepartureMins = earlyDepartureMins;
            emp.isEarlyDeparture = earlyDepartureMins > 0;
            emp.otMins = otMins;
            emp.hasOT = otMins > 0;
            emp.hasMissPunch = !(newIn && newOut);
        }

        dayDoc.markModified("employees");
        await dayDoc.save();

        res.json({ success: true, message: "Override saved", data: dayDoc.employees[empIdx] });
    } catch (err) {
        console.error("[OVERRIDE]", err.message, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
});

router.put("/bulk-day-override", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { dateStr, updates } = req.body;
        if (!dateStr || !Array.isArray(updates) || !updates.length) {
            return res.status(400).json({ success: false, message: "dateStr and updates[] required" });
        }
        let ok = 0, fail = 0;
        for (const u of updates) {
            const set = { "employees.$.hrReviewedAt": new Date() };
            if (u.hrFinalStatus !== undefined) set["employees.$.hrFinalStatus"] = u.hrFinalStatus || null;
            if (u.hrRemarks !== undefined) set["employees.$.hrRemarks"] = u.hrRemarks || null;
            const r = await DailyAttendance.updateOne(
                { dateStr, "employees.biometricId": String(u.biometricId).toUpperCase() },
                { $set: set }
            );
            if (r.matchedCount > 0) ok++; else fail++;
        }
        res.json({ success: true, updated: ok, failed: fail });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  EXCEL EXPORTS — unchanged for now, will be updated in Phase 2 to use
//  displayLabels and show FH/NH/OH/RH properly.
// ═══════════════════════════════════════════════════════════════════════════

router.get("/export-daily", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { date, department } = req.query;
        if (!date) return res.status(400).json({ success: false, message: "date required" });

        // Reuse the daily endpoint logic by calling it internally would be overkill.
        // Just fetch the day doc and build rows here.
        const dayDoc = await DailyAttendance.findOne({ dateStr: date }).lean();
        const settings = await AttendanceSettings.getConfig();
        const labels = settings.displayLabels || {};
        const L = (s) => labels[s] || s;

        const allActive = await Employee.find({
            $or: [{ status: "active" }, { status: { $exists: false } }, { isActive: true }],
        }).lean();
        const filtered = (department && department !== "all")
            ? allActive.filter((e) => extractDepartment(e) === department)
            : allActive;

        const byBio = new Map();
        if (dayDoc) for (const e of (dayDoc.employees || [])) byBio.set(e.biometricId, e);

        // Build rows, sorted by name
        const rows = [];
        for (const emp of filtered) {
            const bid = String(extractBiometricId(emp) || "").toUpperCase();
            if (!bid) continue;
            const entry = byBio.get(bid);
            const status = entry?.hrFinalStatus || entry?.systemPrediction || "AB";
            rows.push({
                name: extractName(emp),
                department: extractDepartment(emp),
                status,
                statusLabel: L(status),
                inTime: entry?.inTime,
                lunchOut: entry?.lunchOut,
                lunchIn: entry?.lunchIn,
                teaOut: entry?.teaOut,
                teaIn: entry?.teaIn,
                outTime: entry?.finalOut,
                netWorkMins: entry?.netWorkMins || 0,
                otMins: entry?.otMins || 0,
                isLate: !!entry?.isLate,
                isEarlyDeparture: !!entry?.isEarlyDeparture,
                lateMins: entry?.lateMins || 0,
                earlyMins: entry?.earlyDepartureMins || 0,
            });
        }
        rows.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

        const wb = new ExcelJS.Workbook();
        wb.creator = "Grav Clothing HRMS";
        const ws = wb.addWorksheet("Daily Attendance", {
            views: [{ state: "frozen", ySplit: 9, showGridLines: false }],
            pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1 },
        });

        const TOTAL_COLS = 12; // EMPLOYEE, DEPT, STATUS, IN, OUT, L.OUT, L.IN, T.OUT, T.IN, FINAL, WORK, OT
        const dateLabel = new Date(date + "T00:00:00").toLocaleDateString("en-IN", {
            weekday: "long", day: "numeric", month: "long", year: "numeric",
            timeZone: "Asia/Kolkata",
        });

        // ── Hero banner ────────────────────────────────────────────────
        ws.mergeCells(1, 1, 1, TOTAL_COLS);
        const hero = ws.getCell(1, 1);
        hero.value = {
            richText: [
                { text: "GRAV CLOTHING\n", font: { size: 9, bold: true, italic: true, color: { argb: "FFE9D5FF" } } },
                { text: `Daily Attendance · ${dateLabel}`, font: { size: 16, bold: true, color: { argb: "FFFFFFFF" } } },
            ]
        };
        hero.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF581C87" } };
        hero.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        ws.getRow(1).height = 40;

        // ── Stats sub-banner ───────────────────────────────────────────
        const stats = { P: 0, "P*": 0, "P~": 0, HD: 0, MP: 0, AB: 0, WO: 0, holiday: 0, leaves: 0 };
        for (const r of rows) {
            if (stats[r.status] !== undefined) stats[r.status]++;
            if (["FH", "NH", "OH", "RH", "PH"].includes(r.status)) stats.holiday++;
            if (["L-CL", "L-SL", "L-EL", "LWP", "WFH", "CO"].includes(r.status)) stats.leaves++;
        }
        ws.mergeCells(2, 1, 2, TOTAL_COLS);
        const sub = ws.getCell(2, 1);
        sub.value = `${rows.length} employees  ·  Present ${stats.P + stats["P*"] + stats["P~"]}  ·  Late ${stats["P*"]}  ·  Half Day ${stats.HD}  ·  Miss Punch ${stats.MP}  ·  Absent ${stats.AB}  ·  Off ${stats.WO}  ·  Holiday ${stats.holiday}  ·  Leave ${stats.leaves}`;
        sub.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
        sub.font = { size: 9, color: { argb: "FFC4B5FD" } };
        sub.alignment = { vertical: "middle", horizontal: "center" };
        ws.getRow(2).height = 22;

        // ── LEGEND ROW 1 — status colors ──────────────────────────────
        ws.mergeCells(3, 1, 3, TOTAL_COLS);
        const legendHdr = ws.getCell(3, 1);
        legendHdr.value = "COLOR LEGEND — STATUS CODES";
        legendHdr.font = { size: 9, bold: true, color: { argb: "FF6B7280" } };
        legendHdr.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
        legendHdr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF9FAFB" } };
        ws.getRow(3).height = 20;

        ws.mergeCells(4, 1, 4, TOTAL_COLS);
        const legendStatus = ws.getCell(4, 1);
        legendStatus.value = {
            richText: [
                { text: "P", font: { size: 10, bold: true, color: { argb: "FF008000" } } },
                { text: " Present  ·  ", font: { size: 9, color: { argb: "FF6B7280" } } },
                { text: "L", font: { size: 10, bold: true, color: { argb: "FFFF8C00" } } },
                { text: " Late  ·  ", font: { size: 9, color: { argb: "FF6B7280" } } },
                { text: "EO", font: { size: 10, bold: true, color: { argb: "FFFF0000" } } },
                { text: " Early Out  ·  ", font: { size: 9, color: { argb: "FF6B7280" } } },
                { text: "HD", font: { size: 10, bold: true, color: { argb: "FFFF0000" } } },
                { text: " Half Day  ·  ", font: { size: 9, color: { argb: "FF6B7280" } } },
                { text: "MP", font: { size: 10, bold: true, color: { argb: "FFDB2777" } } },
                { text: " Miss Punch  ·  ", font: { size: 9, color: { argb: "FF6B7280" } } },
                { text: "A", font: { size: 10, bold: true, color: { argb: "FFDC2626" } } },
                { text: " Absent  ·  ", font: { size: 9, color: { argb: "FF6B7280" } } },
                { text: "WO", font: { size: 10, bold: true, color: { argb: "FF64748B" } } },
                { text: " Weekly Off  ·  ", font: { size: 9, color: { argb: "FF6B7280" } } },
                { text: "FH/NH/OH/RH", font: { size: 10, bold: true, color: { argb: "FF4F46E5" } } },
                { text: " Holidays  ·  ", font: { size: 9, color: { argb: "FF6B7280" } } },
                { text: "CL/SL/EL", font: { size: 10, bold: true, color: { argb: "FF7C3AED" } } },
                { text: " Leaves", font: { size: 9, color: { argb: "FF6B7280" } } },
            ]
        };
        legendStatus.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        legendStatus.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } };
        ws.getRow(4).height = 22;

        // ── LEGEND ROW 2 — time & work colors ─────────────────────────
        ws.mergeCells(5, 1, 5, TOTAL_COLS);
        const legendTimes = ws.getCell(5, 1);
        legendTimes.value = {
            richText: [
                { text: "TIMES → ", font: { size: 9, bold: true, color: { argb: "FF6B7280" } } },
                { text: "09:19", font: { size: 10, bold: true, color: { argb: "FF2563EB" } } },
                { text: " on-time IN/OUT  ·  ", font: { size: 9, color: { argb: "FF6B7280" } } },
                { text: "09:43", font: { size: 10, bold: true, color: { argb: "FFFF8C00" } } },
                { text: " late IN  ·  ", font: { size: 9, color: { argb: "FF6B7280" } } },
                { text: "17:41", font: { size: 10, bold: true, color: { argb: "FFFF8C00" } } },
                { text: " early OUT  ·  ", font: { size: 9, color: { argb: "FF6B7280" } } },
                { text: "WORK → ", font: { size: 9, bold: true, color: { argb: "FF6B7280" } } },
                { text: "8:35", font: { size: 10, bold: true, color: { argb: "FF16A34A" } } },
                { text: " ≥ 8 hours  ·  ", font: { size: 9, color: { argb: "FF6B7280" } } },
                { text: "6:05", font: { size: 10, bold: true, color: { argb: "FFDC2626" } } },
                { text: " < 8 hours  ·  ", font: { size: 9, color: { argb: "FF6B7280" } } },
                { text: "OT → ", font: { size: 9, bold: true, color: { argb: "FF6B7280" } } },
                { text: "0:30", font: { size: 10, bold: true, color: { argb: "FF4338CA" } } },
                { text: " any overtime", font: { size: 9, color: { argb: "FF6B7280" } } },
            ]
        };
        legendTimes.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        legendTimes.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } };
        ws.getRow(5).height = 22;

        // ── Border around the legend block ────────────────────────────
        for (let r = 3; r <= 5; r++) {
            for (let c = 1; c <= TOTAL_COLS; c++) {
                ws.getCell(r, c).border = {
                    top: r === 3 ? { style: "medium", color: { argb: "FF6B7280" } } : { style: "thin", color: { argb: "FFE5E7EB" } },
                    bottom: r === 5 ? { style: "medium", color: { argb: "FF6B7280" } } : { style: "thin", color: { argb: "FFE5E7EB" } },
                    left: c === 1 ? { style: "medium", color: { argb: "FF6B7280" } } : undefined,
                    right: c === TOTAL_COLS ? { style: "medium", color: { argb: "FF6B7280" } } : undefined,
                };
            }
        }

        ws.getRow(6).height = 6; // gap

        // ── Table headers ─────────────────────────────────────────────
        const headers = ["EMPLOYEE", "DEPARTMENT", "STATUS", "IN", "OUT", "L.OUT", "L.IN", "T.OUT", "T.IN", "FINAL", "WORK", "OT"];
        const widths = [28, 18, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
        widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

        const headerRow = ws.getRow(7);
        headers.forEach((h, i) => {
            const cell = headerRow.getCell(i + 1);
            cell.value = h;
            cell.font = { size: 9, bold: true, color: { argb: "FFFFFFFF" } };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
            cell.alignment = { vertical: "middle", horizontal: i === 0 || i === 1 ? "left" : "center", indent: i <= 1 ? 1 : 0 };
            cell.border = {
                top: { style: "medium", color: { argb: "FF0F172A" } },
                bottom: { style: "medium", color: { argb: "FF0F172A" } },
                left: { style: "thin", color: { argb: "FF374151" } },
                right: { style: "thin", color: { argb: "FF374151" } },
            };
        });
        headerRow.height = 24;

        // ── Data rows ─────────────────────────────────────────────────
        const fmt = (d) => fmtTimeIST(d);   // uses Asia/Kolkata
        const fmtMins = (m) => {
            if (!m || m <= 0) return "";
            const h = Math.floor(m / 60), mm = m % 60;
            return `${h}:${String(mm).padStart(2, "0")}`;
        };

        const STATUS_COLOR = {
            P: "FF008000", "P*": "FFFF8C00", "P~": "FFFF0000",
            HD: "FFFF0000", MP: "FFDB2777", AB: "FFDC2626", LWP: "FFDC2626",
            WO: "FF64748B",
            FH: "FF4F46E5", NH: "FF4F46E5", OH: "FF4F46E5", RH: "FF4F46E5", PH: "FF4F46E5",
            "L-CL": "FF7C3AED", "L-SL": "FF7C3AED", "L-EL": "FF7C3AED",
            WFH: "FF0891B2", CO: "FF0D9488",
        };

        rows.forEach((r, idx) => {
            const row = ws.getRow(8 + idx);
            const rowFill = idx % 2 === 0 ? "FFFFFFFF" : "FFF8FAFC";

            // Name
            row.getCell(1).value = r.name;
            row.getCell(1).font = { size: 10, bold: true, color: { argb: "FF1D4ED8" } };
            row.getCell(1).alignment = { vertical: "middle", horizontal: "left", indent: 1 };

            // Department
            row.getCell(2).value = r.department;
            row.getCell(2).font = { size: 9, color: { argb: "FF6B7280" } };
            row.getCell(2).alignment = { vertical: "middle", horizontal: "left", indent: 1 };

            // Status (use display label, color-coded)
            row.getCell(3).value = r.statusLabel;
            row.getCell(3).font = { size: 10, bold: true, color: { argb: STATUS_COLOR[r.status] || "FF111827" } };
            row.getCell(3).alignment = { vertical: "middle", horizontal: "center" };

            // IN — orange bold if late
            row.getCell(4).value = fmt(r.inTime);
            row.getCell(4).font = { size: 9, bold: r.isLate, color: { argb: r.isLate ? "FFFF8C00" : "FF2563EB" } };
            row.getCell(4).alignment = { vertical: "middle", horizontal: "center" };

            // OUT (final exit per shift) — same as FINAL but kept here for visual separation
            row.getCell(5).value = fmt(r.outTime);
            row.getCell(5).font = { size: 9, bold: r.isEarlyDeparture, color: { argb: r.isEarlyDeparture ? "FFFF8C00" : "FF2563EB" } };
            row.getCell(5).alignment = { vertical: "middle", horizontal: "center" };

            // Lunch + Tea breaks
            row.getCell(6).value = fmt(r.lunchOut);
            row.getCell(7).value = fmt(r.lunchIn);
            row.getCell(8).value = fmt(r.teaOut);
            row.getCell(9).value = fmt(r.teaIn);
            for (const c of [6, 7, 8, 9]) {
                row.getCell(c).font = { size: 9, color: { argb: "FF6B7280" } };
                row.getCell(c).alignment = { vertical: "middle", horizontal: "center" };
            }

            // Final out
            row.getCell(10).value = fmt(r.outTime);
            row.getCell(10).font = { size: 9, bold: true, color: { argb: "FF111827" } };
            row.getCell(10).alignment = { vertical: "middle", horizontal: "center" };

            // Work hours — green ≥8h, red <8h
            row.getCell(11).value = fmtMins(r.netWorkMins);
            row.getCell(11).font = {
                size: 10, bold: true,
                color: { argb: r.netWorkMins >= 480 ? "FF16A34A" : r.netWorkMins > 0 ? "FFDC2626" : "FF9CA3AF" }
            };
            row.getCell(11).alignment = { vertical: "middle", horizontal: "center" };

            // OT — indigo
            row.getCell(12).value = fmtMins(r.otMins);
            row.getCell(12).font = {
                size: 10, bold: r.otMins > 0,
                color: { argb: r.otMins > 0 ? "FF4338CA" : "FF9CA3AF" }
            };
            row.getCell(12).alignment = { vertical: "middle", horizontal: "center" };

            // Borders + zebra fill
            for (let c = 1; c <= TOTAL_COLS; c++) {
                const cell = row.getCell(c);
                cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowFill } };
                cell.border = {
                    top: { style: "thin", color: { argb: "FFE5E7EB" } },
                    bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
                    left: { style: "thin", color: { argb: "FFE5E7EB" } },
                    right: { style: "thin", color: { argb: "FFE5E7EB" } },
                };
            }
            row.height = 20;
        });

        // Footer
        const footerRow = ws.getRow(8 + rows.length + 1);
        ws.mergeCells(footerRow.number, 1, footerRow.number, TOTAL_COLS);
        footerRow.getCell(1).value = `${rows.length} record${rows.length === 1 ? "" : "s"}  ·  Generated ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
        footerRow.getCell(1).font = { size: 8, italic: true, color: { argb: "FF6B7280" } };
        footerRow.getCell(1).alignment = { vertical: "middle", horizontal: "right", indent: 1 };
        footerRow.height = 18;

        const buffer = await wb.xlsx.writeBuffer();
        const filename = `attendance_${date}${department && department !== "all" ? `_${department}` : ""}.xlsx`;
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Cache-Control", "no-store");
        res.send(buffer);
    } catch (err) {
        console.error("[EXPORT-DAILY]", err.message, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  MUSTER ROLL — existing code preserved (Phase 2 updates coming)
// ═══════════════════════════════════════════════════════════════════════════

router.get("/muster-roll", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { yearMonth, department } = req.query;
        if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
            return res.status(400).json({ success: false, message: "yearMonth (YYYY-MM) required" });
        }

        const [yr, mo] = yearMonth.split("-").map(Number);
        const from = `${yearMonth}-01`;
        const lastDay = new Date(yr, mo, 0).getDate();
        const to = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;

        const settings = await AttendanceSettings.getConfig();
        const thresholds = settings.lateHalfDayPolicy?.cumulativeLateMinsThreshold || { operator: 30, executive: 40 };

        const holidayMap = await loadHolidayMap(from, to);

        const today = new Date(); today.setHours(0, 0, 0, 0);
        const allDays = [];
        for (let d = 1; d <= lastDay; d++) {
            const dateStr = `${yearMonth}-${String(d).padStart(2, "0")}`;
            const dt = new Date(dateStr + "T00:00:00");
            const dow = dt.getDay();
            const hol = holidayMap.get(dateStr);
            const isDeclaredHoliday = !!hol && hol.type !== "working_sunday";
            const isWorkingSunday = !!hol && hol.type === "working_sunday";
            allDays.push({
                day: d, dateStr,
                dayName: dt.toLocaleDateString("en-IN", { weekday: "short" }),
                isSunday: dow === 0,
                isFuture: dt > today,
                isDeclaredHoliday,
                isWorkingSunday,
                holiday: isDeclaredHoliday ? hol : null,
                holidayStatus: isDeclaredHoliday ? holidayTypeToStatus(hol.type) : null,
                restStatus: resolveRestDayStatus(dateStr, dow, holidayMap),
            });
        }

        const allActive = await Employee.find({
            $or: [{ status: "active" }, { status: { $exists: false } }, { isActive: true }],
        }).lean();
        const filteredActive = (department && department !== "all")
            ? allActive.filter((e) => extractDepartment(e) === department)
            : allActive;

        const dayDocs = await DailyAttendance.find({ yearMonth }).sort({ dateStr: 1 }).lean();
        const byDate = new Map(dayDocs.map((d) => [d.dateStr, d]));

        const employees = [];
        const running = new Map();

        const PAID_CODES = [
            "P", "P*", "P~", "HD", "MP",
            "WO", "FH", "NH", "OH", "RH", "PH",
            "L-CL", "L-SL", "L-EL", "WFH", "CO",
        ];

        for (const emp of filteredActive) {
            const bid = extractBiometricId(emp);
            if (!bid) continue;
            const key = String(bid).toUpperCase();
            const empType = resolveEmployeeType(emp, settings);

            const row = {
                biometricId: key,
                employeeDbId: emp._id,
                employeeName: extractName(emp),
                department: extractDepartment(emp),
                designation: extractDesignation(emp),
                employeeType: empType,
                isGhost: false,
                days: {},
                totals: {
                    P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, MP: 0, WO: 0, PH: 0,
                    FH: 0, NH: 0, OH: 0, RH: 0, leaves: 0,
                    effectivePresent: 0,
                    totalLateMins: 0, totalOtMins: 0, totalNetWorkMins: 0,
                    autoPromotedHDs: 0,
                    sundayWorked: 0,
                    holidayWorked: 0,
                    totalAttendance: 0,
                },
            };

            running.set(key, 0);

            for (const cal of allDays) {
                if (cal.isFuture) {
                    row.days[cal.dateStr] = { status: "—", isSunday: cal.isSunday, isFuture: true };
                    continue;
                }

                const dayDoc = byDate.get(cal.dateStr);
                const entry = dayDoc ? (dayDoc.employees || []).find((e) => e.biometricId === key) : null;

                if (cal.isDeclaredHoliday) {
                    const hs = cal.holidayStatus;
                    const didPunch = !!entry && (entry.punchCount || 0) > 0;

                    row.days[cal.dateStr] = {
                        status: hs,
                        holiday: cal.holiday,
                        punchedOnHoliday: didPunch,
                        netWorkMins: entry?.netWorkMins || 0,
                        otMins: entry?.otMins || 0,
                        punchCount: entry?.punchCount || 0,
                        hrOverride: !!entry?.hrFinalStatus,
                    };
                    row.totals[hs] = (row.totals[hs] || 0) + 1;
                    row.totals.totalAttendance++;
                    if (didPunch) {
                        row.totals.holidayWorked++;
                        row.totals.totalOtMins += entry.otMins || 0;
                        row.totals.totalNetWorkMins += entry.netWorkMins || 0;
                    }
                    continue;
                }

                if (cal.isSunday && !cal.isWorkingSunday) {
                    const didPunch = !!entry && (entry.punchCount || 0) > 0;
                    if (didPunch) {
                        let status = entry.systemPrediction;
                        const finalStatus = entry.hrFinalStatus || status;
                        row.days[cal.dateStr] = {
                            status: finalStatus,
                            netWorkMins: entry.netWorkMins || 0,
                            lateMins: entry.lateMins || 0,
                            otMins: entry.otMins || 0,
                            punchCount: entry.punchCount || 0,
                            isSunday: true,
                            isSundayWorked: true,
                            hrOverride: !!entry.hrFinalStatus,
                        };
                        if (row.totals[finalStatus] !== undefined) row.totals[finalStatus]++;
                        row.totals.sundayWorked++;
                        row.totals.totalAttendance++;
                        row.totals.totalLateMins += entry.lateMins || 0;
                        row.totals.totalOtMins += entry.otMins || 0;
                        row.totals.totalNetWorkMins += entry.netWorkMins || 0;
                    } else {
                        row.days[cal.dateStr] = { status: "WO", isSunday: true };
                        row.totals.WO++;
                        row.totals.totalAttendance++;
                    }
                    continue;
                }

                if (!dayDoc) {
                    row.days[cal.dateStr] = { status: "—", isSunday: cal.isSunday, unsynced: true };
                    continue;
                }

                if (!entry) {
                    row.days[cal.dateStr] = { status: "AB", isSunday: cal.isSunday };
                    row.totals.AB++;
                    continue;
                }

                // FIXED: Changed 'e' to 'entry' in the following block
                let cum = running.get(key) || 0;
                let status = entry.systemPrediction;
                let promoted = false;
                if (settings.lateHalfDayPolicy?.enabled && entry.isLate && (entry.lateMins || 0) > 0) {
                    cum += entry.lateMins;
                    const thr = thresholds[entry.employeeType] ?? thresholds.operator ?? 30;
                    if (cum >= thr) { status = "HD"; promoted = true; cum = 0; }
                }
                running.set(key, cum);

                const finalStatus = entry.hrFinalStatus || status;

                row.days[cal.dateStr] = {
                    status: finalStatus,
                    displayLabel: getDisplayLabel(finalStatus, settings),
                    inTime: entry.inTime,
                    outTime: entry.finalOut,
                    netWorkMins: entry.netWorkMins || 0,
                    lateMins: entry.lateMins || 0,
                    otMins: entry.otMins || 0,
                    punchCount: entry.punchCount || 0,
                    isSunday: cal.isSunday,
                    hrOverride: !!entry.hrFinalStatus,
                    wasPromoted: promoted,
                    hasPunches: (entry.punchCount || 0) > 0,
                };

                if (row.totals[finalStatus] !== undefined) row.totals[finalStatus]++;
                if (["L-CL", "L-SL", "L-EL", "LWP", "WFH", "CO"].includes(finalStatus)) row.totals.leaves++;

                if (PAID_CODES.includes(finalStatus)) row.totals.totalAttendance++;

                if (["P", "P*", "P~"].includes(finalStatus) || (entry.inTime && entry.finalOut)) row.totals.effectivePresent++;
                row.totals.totalLateMins += entry.lateMins || 0;
                row.totals.totalOtMins += entry.otMins || 0;
                row.totals.totalNetWorkMins += entry.netWorkMins || 0;
                if (promoted) row.totals.autoPromotedHDs++;
            }

            employees.push(row);
        }

        employees.sort((a, b) => {
            if (a.department !== b.department) return (a.department || "").localeCompare(b.department || "");
            return (a.employeeName || "").localeCompare(b.employeeName || "");
        });

        const dayTotals = {};
        for (const cal of allDays) {
            const t = { P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, MP: 0, WO: 0, PH: 0, FH: 0, NH: 0, OH: 0, RH: 0, leaves: 0, total: 0 };
            for (const emp of employees) {
                const d = emp.days[cal.dateStr];
                if (!d || !d.status || d.status === "—") continue;
                if (t[d.status] !== undefined) t[d.status]++;
                if (["L-CL", "L-SL", "L-EL", "LWP", "WFH", "CO"].includes(d.status)) t.leaves++;
                t.total++;
            }
            dayTotals[cal.dateStr] = t;
        }

        const grand = {
            totalEmployees: employees.length,
            workingDays: allDays.filter((d) => !d.isSunday && !d.isFuture && !d.isDeclaredHoliday).length,
            sundays: allDays.filter((d) => d.isSunday && !d.isWorkingSunday).length,
            holidayCount: allDays.filter((d) => d.isDeclaredHoliday).length,
            syncedDays: dayDocs.length,
            totalPresent: employees.reduce((a, e) => a + e.totals.P, 0),
            totalAbsent: employees.reduce((a, e) => a + e.totals.AB, 0),
            totalLate: employees.reduce((a, e) => a + e.totals["P*"], 0),
            totalHD: employees.reduce((a, e) => a + e.totals.HD, 0),
            totalMP: employees.reduce((a, e) => a + e.totals.MP, 0),
            totalWO: employees.reduce((a, e) => a + e.totals.WO, 0),
            totalLeaves: employees.reduce((a, e) => a + e.totals.leaves, 0),
            totalHolidays: employees.reduce((a, e) => a + e.totals.FH + e.totals.NH + e.totals.OH + e.totals.RH, 0),
            totalSundayWorked: employees.reduce((a, e) => a + e.totals.sundayWorked, 0),
            totalHolidayWorked: employees.reduce((a, e) => a + e.totals.holidayWorked, 0),
            totalAttendance: employees.reduce((a, e) => a + e.totals.totalAttendance, 0),
            totalLateMins: employees.reduce((a, e) => a + e.totals.totalLateMins, 0),
            totalOtMins: employees.reduce((a, e) => a + e.totals.totalOtMins, 0),
            totalNetWorkMins: employees.reduce((a, e) => a + e.totals.totalNetWorkMins, 0),
        };

        res.json({
            success: true,
            yearMonth, from, to,
            monthLabel: new Date(from + "T00:00:00").toLocaleDateString("en-IN", { month: "long", year: "numeric" }),
            days: allDays,
            holidays: [...holidayMap.values()].filter(h => h.type !== "working_sunday"),
            employees,
            dayTotals,
            grand,
            displayLabels: settings.displayLabels,
        });
    } catch (err) {
        console.error("[MUSTER]", err.message, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Muster Excel export — unchanged; Phase 2 will update for FH/NH/etc
// ═══════════════════════════════════════════════════════════════════════════
router.get("/export-muster-roll", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { yearMonth, department } = req.query;
        if (!yearMonth) return res.status(400).json({ success: false, message: "yearMonth required" });

        const [yr, mo] = yearMonth.split("-").map(Number);
        const lastDay = new Date(yr, mo, 0).getDate();
        const from = `${yearMonth}-01`;
        const to = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;

        const settings = await AttendanceSettings.getConfig();
        const thresholds = settings.lateHalfDayPolicy?.cumulativeLateMinsThreshold || { operator: 30, executive: 40 };
        const labels = settings.displayLabels || {};
        const L = (s) => labels[s] || s;

        const holidayMap = await loadHolidayMap(from, to);

        const today = new Date(); today.setHours(0, 0, 0, 0);
        const allDays = [];
        for (let d = 1; d <= lastDay; d++) {
            const dateStr = `${yearMonth}-${String(d).padStart(2, "0")}`;
            const dt = new Date(dateStr + "T00:00:00");
            const dow = dt.getDay();
            const hol = holidayMap.get(dateStr);
            const isDeclaredHoliday = !!hol && hol.type !== "working_sunday";
            const isWorkingSunday = !!hol && hol.type === "working_sunday";
            allDays.push({
                day: d, dateStr,
                dayName: dt.toLocaleDateString("en-IN", { weekday: "short" }),
                dayLetter: dt.toLocaleDateString("en-IN", { weekday: "short" }).charAt(0),
                isSunday: dow === 0,
                isFuture: dt > today,
                isDeclaredHoliday,
                isWorkingSunday,
                holiday: isDeclaredHoliday ? hol : null,
                holidayStatus: isDeclaredHoliday ? holidayTypeToStatus(hol.type) : null,
            });
        }

        const allActive = await Employee.find({
            $or: [{ status: "active" }, { status: { $exists: false } }, { isActive: true }],
        }).lean();
        const filteredActive = (department && department !== "all")
            ? allActive.filter((e) => extractDepartment(e) === department)
            : allActive;

        const dayDocs = await DailyAttendance.find({ yearMonth }).sort({ dateStr: 1 }).lean();
        const byDate = new Map(dayDocs.map((d) => [d.dateStr, d]));

        const PAID_CODES = [
            "P", "P*", "P~", "HD", "MP",
            "WO", "FH", "NH", "OH", "RH", "PH",
            "L-CL", "L-SL", "L-EL", "WFH", "CO",
        ];

        const employees = [];
        const running = new Map();

        for (const emp of filteredActive) {
            const bid = extractBiometricId(emp);
            if (!bid) continue;
            const key = String(bid).toUpperCase();
            const empType = resolveEmployeeType(emp, settings);

            const row = {
                biometricId: key,
                empCode: extractIdentity(emp) || key.replace(/^GR/, ""),
                employeeName: extractName(emp),
                department: extractDepartment(emp),
                designation: extractDesignation(emp),
                employeeType: empType,
                days: {},
                totals: {
                    P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, MP: 0, WO: 0, PH: 0,
                    FH: 0, NH: 0, OH: 0, RH: 0, leaves: 0,
                    totalLateMins: 0, totalOtMins: 0, totalNetWorkMins: 0,
                    totalAttendance: 0,
                    sundayWorked: 0, holidayWorked: 0,
                },
            };
            running.set(key, 0);

            for (const cal of allDays) {
                if (cal.isFuture) { row.days[cal.dateStr] = { status: "—", isFuture: true }; continue; }

                const dayDoc = byDate.get(cal.dateStr);
                const entry = dayDoc ? (dayDoc.employees || []).find((e) => e.biometricId === key) : null;

                // HOLIDAY → applies to everyone
                if (cal.isDeclaredHoliday) {
                    const hs = cal.holidayStatus;
                    const didPunch = !!entry && (entry.punchCount || 0) > 0;
                    row.days[cal.dateStr] = {
                        status: hs,
                        punchedOnHoliday: didPunch,
                        otMins: entry?.otMins || 0,
                        netWorkMins: entry?.netWorkMins || 0,
                        hrOverride: !!entry?.hrFinalStatus,
                    };
                    row.totals[hs] = (row.totals[hs] || 0) + 1;
                    row.totals.totalAttendance++;
                    if (didPunch) {
                        row.totals.holidayWorked++;
                        row.totals.totalOtMins += entry.otMins || 0;
                        row.totals.totalNetWorkMins += entry.netWorkMins || 0;
                    }
                    continue;
                }

                // SUNDAY
                if (cal.isSunday && !cal.isWorkingSunday) {
                    const didPunch = !!entry && (entry.punchCount || 0) > 0;
                    if (didPunch) {
                        let status = entry.systemPrediction;
                        const finalStatus = entry.hrFinalStatus || status;
                        row.days[cal.dateStr] = {
                            status: finalStatus,
                            netWorkMins: entry.netWorkMins || 0,
                            lateMins: entry.lateMins || 0,
                            otMins: entry.otMins || 0,
                            hrOverride: !!entry.hrFinalStatus,
                            isSundayWorked: true,
                        };
                        if (row.totals[finalStatus] !== undefined) row.totals[finalStatus]++;
                        row.totals.sundayWorked++;
                        row.totals.totalAttendance++;
                        row.totals.totalLateMins += entry.lateMins || 0;
                        row.totals.totalOtMins += entry.otMins || 0;
                        row.totals.totalNetWorkMins += entry.netWorkMins || 0;
                    } else {
                        row.days[cal.dateStr] = { status: "WO" };
                        row.totals.WO++;
                        row.totals.totalAttendance++;
                    }
                    continue;
                }

                // Normal working day
                if (!dayDoc) { row.days[cal.dateStr] = { status: "—" }; continue; }
                if (!entry) { row.days[cal.dateStr] = { status: "AB" }; row.totals.AB++; continue; }

                let cum = running.get(key) || 0;
                let status = entry.systemPrediction;
                let promoted = false;
                if (settings.lateHalfDayPolicy?.enabled && entry.isLate && (entry.lateMins || 0) > 0) {
                    cum += entry.lateMins;
                    const thr = thresholds[entry.employeeType] ?? thresholds.operator ?? 30;
                    if (cum >= thr) { status = "HD"; promoted = true; cum = 0; }
                }
                running.set(key, cum);
                const finalStatus = entry.hrFinalStatus || status;

                row.days[cal.dateStr] = {
                    status: finalStatus,
                    netWorkMins: entry.netWorkMins || 0,
                    lateMins: entry.lateMins || 0,
                    otMins: entry.otMins || 0,
                    hrOverride: !!entry.hrFinalStatus,
                    wasPromoted: promoted,
                };
                if (row.totals[finalStatus] !== undefined) row.totals[finalStatus]++;
                if (["L-CL", "L-SL", "L-EL", "LWP", "WFH", "CO"].includes(finalStatus)) row.totals.leaves++;
                if (PAID_CODES.includes(finalStatus)) row.totals.totalAttendance++;

                row.totals.totalLateMins += entry.lateMins || 0;
                row.totals.totalOtMins += entry.otMins || 0;
                row.totals.totalNetWorkMins += entry.netWorkMins || 0;
            }

            const worked = row.totals.P + row.totals["P*"] + row.totals["P~"] + row.totals.MP;
            const workable = allDays.filter(d => !d.isSunday && !d.isFuture && !d.isDeclaredHoliday).length;
            row.attendanceRate = workable > 0 ? Math.round((worked / workable) * 100) : 0;
            employees.push(row);
        }
        employees.sort((a, b) => {
            if (a.department !== b.department) return (a.department || "").localeCompare(b.department || "");
            return (a.employeeName || "").localeCompare(b.employeeName || "");
        });

        // ─── Build workbook ──────────────────────────────────────────────
        const wb = new ExcelJS.Workbook();
        wb.creator = "Grav Clothing HRMS";
        wb.created = new Date();
        const ws = wb.addWorksheet("Attendance", {
            views: [{ state: "frozen", xSplit: 3, ySplit: 7, showGridLines: false }],
            pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1 },
        });

        const monthLabel = new Date(from + "T00:00:00").toLocaleDateString("en-IN", { month: "long", year: "numeric" });
        // cols: #, Name, Dept, 1..lastDay, Total-Att, P, A, HD, MP, WO, LV, HW, Rate
        const dayStart = 4;
        const totalAttCol = dayStart + lastDay;
        const afterCols = ["P", "A", "HD", "MP", "WO", "LV", "HW", "RATE"];
        const totalCols = 3 + lastDay + 1 + afterCols.length;

        const STATUS = {
            P: { font: "FF16A34A", fill: "FFDCFCE7" },
            "P*": { font: "FF854D0E", fill: "FFFEF9C3" },
            "P~": { font: "FF9A3412", fill: "FFFFEDD5" },
            HD: { font: "FF92400E", fill: "FFFEF3C7" },
            MP: { font: "FF9D174D", fill: "FFFCE7F3" },
            AB: { font: "FF991B1B", fill: "FFFEE2E2" },
            LWP: { font: "FF991B1B", fill: "FFFEE2E2" },
            WO: { font: "FF475569", fill: "FFF1F5F9" },
            PH: { font: "FF1E40AF", fill: "FFDBEAFE" },
            FH: { font: "FF3730A3", fill: "FFE0E7FF" },
            NH: { font: "FF831843", fill: "FFFCE7F3" },
            OH: { font: "FF134E4A", fill: "FFCCFBF1" },
            RH: { font: "FF78350F", fill: "FFFEF3C7" },
            "L-CL": { font: "FF5B21B6", fill: "FFEDE9FE" },
            "L-SL": { font: "FF5B21B6", fill: "FFEDE9FE" },
            "L-EL": { font: "FF5B21B6", fill: "FFEDE9FE" },
            WFH: { font: "FF155E75", fill: "FFCFFAFE" },
            CO: { font: "FF0F766E", fill: "FFCCFBF1" },
            "—": { font: "FFCBD5E1", fill: null },
        };

        const THEME = {
            heroStart: "FF0F172A", heroMid: "FF581C87",
            accent: "FF7C3AED", accentText: "FFE9D5FF",
            bg: "FFFFFFFF", bgAlt: "FFF8FAFC",
            border: "FFE2E8F0",
            textPrimary: "FF0F172A", textSecondary: "FF64748B", textMuted: "FF94A3B8",
            sundayBg: "FFFEE2E2", sundayText: "FF991B1B",
            holidayBg: "FFE0E7FF", holidayText: "FF3730A3",
            totalAttBg: "FFDCFCE7", totalAttText: "FF166534",
        };

        ws.mergeCells(1, 1, 2, totalCols);
        const hero = ws.getCell(1, 1);
        hero.value = {
            richText: [
                { text: "GRAV CLOTHING\n", font: { name: "Calibri", size: 10, bold: true, color: { argb: THEME.accentText }, italic: true } },
                { text: `Muster Roll · ${monthLabel}`, font: { name: "Calibri", size: 22, bold: true, color: { argb: "FFFFFFFF" } } },
            ]
        };
        hero.fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.heroMid } };
        hero.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        hero.border = {
            top: { style: "medium", color: { argb: THEME.heroStart } },
            left: { style: "medium", color: { argb: THEME.heroStart } },
            right: { style: "medium", color: { argb: THEME.heroStart } },
        };
        ws.getRow(1).height = 20;
        ws.getRow(2).height = 30;

        // Stats bar
        const grand = {
            P: employees.reduce((a, e) => a + e.totals.P + e.totals["P*"] + e.totals["P~"], 0),
            A: employees.reduce((a, e) => a + e.totals.AB, 0),
            HD: employees.reduce((a, e) => a + e.totals.HD, 0),
            MP: employees.reduce((a, e) => a + e.totals.MP, 0),
            WO: employees.reduce((a, e) => a + e.totals.WO, 0),
            L: employees.reduce((a, e) => a + e.totals.leaves, 0),
            H: employees.reduce((a, e) => a + e.totals.FH + e.totals.NH + e.totals.OH + e.totals.RH, 0),
            HW: employees.reduce((a, e) => a + e.totals.holidayWorked, 0),
            SW: employees.reduce((a, e) => a + e.totals.sundayWorked, 0),
            OT: employees.reduce((a, e) => a + e.totals.totalOtMins, 0),
            TA: employees.reduce((a, e) => a + e.totals.totalAttendance, 0),
        };
        const hm = (m) => { if (!m || m <= 0) return "—"; const h = Math.floor(m / 60), mm = m % 60; return `${h}h ${String(mm).padStart(2, "0")}m`; };

        const workingDaysInMonth = allDays.filter(d => !d.isSunday && !d.isFuture && !d.isDeclaredHoliday).length;
        const holidayCount = allDays.filter(d => d.isDeclaredHoliday).length;
        const sundayCount = allDays.filter(d => d.isSunday && !d.isWorkingSunday).length;

        ws.mergeCells(3, 1, 3, totalCols);
        const statsBar = ws.getCell(3, 1);
        statsBar.value = `${employees.length} employees  ·  ${workingDaysInMonth} working days  ·  ${sundayCount} Sundays  ·  ${holidayCount} holidays  ·  Total Attendance ${grand.TA}  ·  Present ${grand.P}  ·  Absent ${grand.A}  ·  MP ${grand.MP}  ·  WO ${grand.WO}  ·  Leaves ${grand.L}  ·  Holiday Worked ${grand.HW}  ·  Sunday Worked ${grand.SW}  ·  OT ${hm(grand.OT)}`;
        statsBar.fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.heroStart } };
        statsBar.font = { name: "Calibri", size: 9, color: { argb: THEME.accentText } };
        statsBar.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        statsBar.border = {
            bottom: { style: "medium", color: { argb: THEME.heroStart } },
            left: { style: "medium", color: { argb: THEME.heroStart } },
            right: { style: "medium", color: { argb: THEME.heroStart } },
        };
        ws.getRow(3).height = 28;
        ws.getRow(4).height = 8;

        // Legend
        ws.mergeCells(5, 1, 5, totalCols);
        const legend = ws.getCell(5, 1);
        legend.value = `LEGEND:   ${L("P")} Present  ·  ${L("P*")} Late  ·  ${L("P~")} Early Out  ·  ${L("HD")} Half Day  ·  ${L("MP")} Miss Punch  ·  ${L("AB")} Absent  ·  ${L("WO")} Weekly Off  ·  ${L("FH")} Festival  ·  ${L("NH")} National  ·  ${L("OH")} Optional  ·  ${L("RH")} Restricted  ·  ${L("L-CL")} Casual  ·  ${L("L-SL")} Sick  ·  ${L("L-EL")} Earned  ·  ${L("WFH")} WFH  ·  ${L("CO")} Comp Off  ·  ★ = worked on holiday/Sunday`;
        legend.font = { name: "Calibri", size: 9, color: { argb: THEME.textSecondary }, italic: true };
        legend.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        legend.fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.bgAlt } };
        ws.getRow(5).height = 22;
        ws.getRow(6).height = 4;

        // Day header
        const headerRow = ws.getRow(7);
        headerRow.getCell(1).value = "#";
        headerRow.getCell(2).value = "EMPLOYEE";
        headerRow.getCell(3).value = "DEPARTMENT";
        for (let i = 0; i < lastDay; i++) {
            const cal = allDays[i];
            const cell = headerRow.getCell(dayStart + i);
            cell.value = {
                richText: [
                    { text: `${cal.dayLetter}\n`, font: { name: "Calibri", size: 7, color: { argb: cal.isSunday ? THEME.sundayText : cal.isDeclaredHoliday ? THEME.holidayText : THEME.textMuted } } },
                    { text: `${cal.day}`, font: { name: "Calibri", size: 10, bold: true, color: { argb: cal.isSunday ? THEME.sundayText : cal.isDeclaredHoliday ? THEME.holidayText : "FFFFFFFF" } } },
                ]
            };
        }
        headerRow.getCell(totalAttCol).value = "TOTAL\nATT";
        afterCols.forEach((h, i) => { headerRow.getCell(totalAttCol + 1 + i).value = h; });

        headerRow.eachCell((c, colNum) => {
            const isDay = colNum >= dayStart && colNum < dayStart + lastDay;
            const isSunday = isDay && allDays[colNum - dayStart]?.isSunday;
            const isHoliday = isDay && allDays[colNum - dayStart]?.isDeclaredHoliday;
            const isTotalAtt = colNum === totalAttCol;

            let fill = THEME.heroMid;
            if (isSunday) fill = THEME.sundayBg;
            else if (isHoliday) fill = THEME.holidayBg;
            else if (isTotalAtt) fill = "FF065F46";
            c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
            if (!isDay) c.font = { bold: true, size: 9, color: { argb: "FFFFFFFF" } };
            c.alignment = { horizontal: colNum === 2 ? "left" : "center", vertical: "middle", wrapText: true, indent: colNum === 2 ? 1 : 0 };
            c.border = {
                top: { style: "thin", color: { argb: THEME.heroStart } },
                bottom: { style: "medium", color: { argb: THEME.heroStart } },
                left: { style: "thin", color: { argb: "FF4C1D95" } },
                right: { style: "thin", color: { argb: "FF4C1D95" } },
            };
        });
        headerRow.height = 34;

        ws.getColumn(1).width = 5;
        ws.getColumn(2).width = 28;
        ws.getColumn(3).width = 16;
        for (let i = 0; i < lastDay; i++) ws.getColumn(dayStart + i).width = 4;
        ws.getColumn(totalAttCol).width = 8;
        for (let i = 0; i < afterCols.length - 1; i++) ws.getColumn(totalAttCol + 1 + i).width = 5.5;
        ws.getColumn(totalAttCol + afterCols.length).width = 7; // rate

        // Data rows
        let rowIdx = 8;
        employees.forEach((emp, i) => {
            const r = ws.getRow(rowIdx);
            r.getCell(1).value = i + 1;
            r.getCell(2).value = {
                richText: [
                    { text: `${emp.employeeName}\n`, font: { name: "Calibri", size: 10, bold: true, color: { argb: THEME.textPrimary } } },
                    { text: `${emp.designation} · ${emp.employeeType === "executive" ? "EXE" : "OPR"}`, font: { name: "Calibri", size: 8, color: { argb: THEME.textMuted } } },
                ]
            };
            r.getCell(3).value = emp.department;

            for (let di = 0; di < lastDay; di++) {
                const cal = allDays[di];
                const d = emp.days[cal.dateStr] || { status: "—" };
                const cfg = STATUS[d.status] || STATUS["—"];
                const cell = r.getCell(dayStart + di);

                // Show label + star if worked on holiday or Sunday
                const star = (d.punchedOnHoliday || d.isSundayWorked) ? "★" : "";
                cell.value = star ? `${L(d.status)}${star}` : L(d.status);

                if (cfg.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: cfg.fill } };
                cell.font = { name: "Calibri", size: 8, bold: !!cfg.fill, color: { argb: cfg.font } };
                cell.alignment = { horizontal: "center", vertical: "middle" };

                if (d.hrOverride) {
                    cell.border = {
                        top: { style: "medium", color: { argb: THEME.accent } },
                        bottom: { style: "medium", color: { argb: THEME.accent } },
                        left: { style: "medium", color: { argb: THEME.accent } },
                        right: { style: "medium", color: { argb: THEME.accent } },
                    };
                } else {
                    cell.border = {
                        top: { style: "thin", color: { argb: THEME.border } },
                        bottom: { style: "thin", color: { argb: THEME.border } },
                        left: { style: "thin", color: { argb: THEME.border } },
                        right: { style: "thin", color: { argb: THEME.border } },
                    };
                }
                if ((d.otMins || 0) > 0) {
                    cell.border = { ...cell.border, bottom: { style: "thick", color: { argb: "FF4338CA" } } };
                }
            }

            // Total Attendance
            const taCell = r.getCell(totalAttCol);
            taCell.value = emp.totals.totalAttendance || 0;
            taCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.totalAttBg } };
            taCell.font = { name: "Calibri", size: 11, bold: true, color: { argb: THEME.totalAttText } };
            taCell.alignment = { horizontal: "center", vertical: "middle" };
            taCell.border = {
                top: { style: "thin", color: { argb: THEME.border } },
                bottom: { style: "thin", color: { argb: THEME.border } },
                left: { style: "medium", color: { argb: "FF065F46" } },
                right: { style: "medium", color: { argb: "FF065F46" } },
            };

            // Individual totals: P, A, HD, MP, WO, LV, HW
            const presentCount = emp.totals.P + emp.totals["P*"] + emp.totals["P~"];
            const totalsData = [
                { v: presentCount || "—", fill: presentCount ? "FFDCFCE7" : THEME.bgAlt, font: presentCount ? "FF166534" : THEME.textMuted },
                { v: emp.totals.AB || "—", fill: emp.totals.AB ? "FFFECACA" : THEME.bgAlt, font: emp.totals.AB ? "FF991B1B" : THEME.textMuted },
                { v: emp.totals.HD || "—", fill: emp.totals.HD ? "FFFEF3C7" : THEME.bgAlt, font: emp.totals.HD ? "FF854D0E" : THEME.textMuted },
                { v: emp.totals.MP || "—", fill: emp.totals.MP ? "FFFCE7F3" : THEME.bgAlt, font: emp.totals.MP ? "FF9D174D" : THEME.textMuted },
                { v: emp.totals.WO || "—", fill: emp.totals.WO ? "FFF1F5F9" : THEME.bgAlt, font: emp.totals.WO ? "FF475569" : THEME.textMuted },
                { v: emp.totals.leaves || "—", fill: emp.totals.leaves ? "FFEDE9FE" : THEME.bgAlt, font: emp.totals.leaves ? "FF6B21A8" : THEME.textMuted },
                { v: emp.totals.holidayWorked || "—", fill: emp.totals.holidayWorked ? "FFFEF3C7" : THEME.bgAlt, font: emp.totals.holidayWorked ? "FF854D0E" : THEME.textMuted },
            ];
            totalsData.forEach((t, ti) => {
                const cell = r.getCell(totalAttCol + 1 + ti);
                cell.value = t.v;
                cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: t.fill } };
                cell.font = { name: "Calibri", size: 9, bold: true, color: { argb: t.font } };
                cell.alignment = { horizontal: "center", vertical: "middle" };
                cell.border = {
                    top: { style: "thin", color: { argb: THEME.border } },
                    bottom: { style: "thin", color: { argb: THEME.border } },
                    left: { style: "thin", color: { argb: THEME.border } },
                    right: { style: "thin", color: { argb: THEME.border } },
                };
            });

            const rate = emp.attendanceRate;
            const rateFill = rate >= 95 ? "FF16A34A" : rate >= 85 ? "FFCA8A04" : rate >= 70 ? "FFEA580C" : "FFDC2626";
            const rateCell = r.getCell(totalAttCol + afterCols.length);
            rateCell.value = `${rate}%`;
            rateCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rateFill } };
            rateCell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
            rateCell.alignment = { horizontal: "center", vertical: "middle" };
            rateCell.border = {
                top: { style: "thin", color: { argb: THEME.border } },
                bottom: { style: "thin", color: { argb: THEME.border } },
                left: { style: "thin", color: { argb: THEME.border } },
                right: { style: "thin", color: { argb: THEME.border } },
            };

            [1, 2, 3].forEach((c) => {
                const cell = r.getCell(c);
                cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: i % 2 === 0 ? THEME.bg : THEME.bgAlt } };
                if (c === 1) {
                    cell.font = { name: "Calibri", size: 9, color: { argb: THEME.textMuted } };
                    cell.alignment = { horizontal: "center", vertical: "middle" };
                } else if (c === 3) {
                    cell.font = { name: "Calibri", size: 9, color: { argb: THEME.textSecondary } };
                    cell.alignment = { horizontal: "left", vertical: "middle", indent: 1 };
                } else {
                    cell.alignment = { vertical: "middle", horizontal: "left", indent: 1, wrapText: true };
                }
                cell.border = {
                    top: { style: "thin", color: { argb: THEME.border } },
                    bottom: { style: "thin", color: { argb: THEME.border } },
                    left: { style: "thin", color: { argb: THEME.border } },
                    right: { style: "thin", color: { argb: THEME.border } },
                };
            });
            r.height = 28;
            rowIdx++;
        });

        // Footer
        const footerRow = ws.getRow(rowIdx);
        ws.mergeCells(rowIdx, 1, rowIdx, 3);
        footerRow.getCell(1).value = "COMPANY TOTAL";
        footerRow.getCell(1).font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
        footerRow.getCell(1).alignment = { horizontal: "left", vertical: "middle", indent: 1 };
        footerRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.heroMid } };

        for (let di = 0; di < lastDay; di++) {
            const cal = allDays[di];
            let presentToday = 0;
            for (const e of employees) {
                const d = e.days[cal.dateStr];
                if (d && ["P", "P*", "P~"].includes(d.status)) presentToday++;
            }
            const cell = footerRow.getCell(dayStart + di);
            cell.value = cal.isFuture ? "" : presentToday;
            cell.font = { name: "Calibri", size: 8, bold: true, color: { argb: "FFFFFFFF" } };
            cell.alignment = { horizontal: "center", vertical: "middle" };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: cal.isSunday ? "FF7F1D1D" : cal.isDeclaredHoliday ? "FF3730A3" : THEME.heroStart } };
            cell.border = {
                top: { style: "medium", color: { argb: THEME.heroStart } },
                bottom: { style: "medium", color: { argb: THEME.heroStart } },
                left: { style: "thin", color: { argb: "FF334155" } },
                right: { style: "thin", color: { argb: "FF334155" } },
            };
        }

        const taFooter = footerRow.getCell(totalAttCol);
        taFooter.value = grand.TA;
        taFooter.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
        taFooter.alignment = { horizontal: "center", vertical: "middle" };
        taFooter.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF065F46" } };
        taFooter.border = {
            top: { style: "medium", color: { argb: THEME.heroStart } },
            bottom: { style: "medium", color: { argb: THEME.heroStart } },
            left: { style: "medium", color: { argb: "FF065F46" } },
            right: { style: "medium", color: { argb: "FF065F46" } },
        };

        [grand.P, grand.A, grand.HD, grand.MP, grand.WO, grand.L, grand.HW].forEach((v, ti) => {
            const cell = footerRow.getCell(totalAttCol + 1 + ti);
            cell.value = v;
            cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
            cell.alignment = { horizontal: "center", vertical: "middle" };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.heroMid } };
            cell.border = {
                top: { style: "medium", color: { argb: THEME.heroStart } },
                bottom: { style: "medium", color: { argb: THEME.heroStart } },
                left: { style: "thin", color: { argb: "FF4C1D95" } },
                right: { style: "thin", color: { argb: "FF4C1D95" } },
            };
        });

        const avgRate = employees.length ? Math.round(employees.reduce((a, e) => a + e.attendanceRate, 0) / employees.length) : 0;
        const rateFooter = footerRow.getCell(totalAttCol + afterCols.length);
        rateFooter.value = `${avgRate}%`;
        rateFooter.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
        rateFooter.alignment = { horizontal: "center", vertical: "middle" };
        rateFooter.fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.accent } };
        rateFooter.border = {
            top: { style: "medium", color: { argb: THEME.heroStart } },
            bottom: { style: "medium", color: { argb: THEME.heroStart } },
            left: { style: "thin", color: { argb: "FF4C1D95" } },
            right: { style: "medium", color: { argb: THEME.heroStart } },
        };
        footerRow.height = 28;

        // Holiday listing
        const activeHolidays = [...holidayMap.values()].filter(h => h.type !== "working_sunday").sort((a, b) => a.date.localeCompare(b.date));
        if (activeHolidays.length > 0) {
            const holStartRow = rowIdx + 2;
            ws.mergeCells(holStartRow, 1, holStartRow, totalCols);
            const holHeader = ws.getCell(holStartRow, 1);
            holHeader.value = `HOLIDAYS THIS MONTH  ·  ${activeHolidays.length} total`;
            holHeader.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
            holHeader.alignment = { horizontal: "left", vertical: "middle", indent: 1 };
            holHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.holidayText } };
            ws.getRow(holStartRow).height = 22;

            activeHolidays.forEach((h, idx) => {
                const r = ws.getRow(holStartRow + 1 + idx);
                ws.mergeCells(holStartRow + 1 + idx, 1, holStartRow + 1 + idx, Math.min(3, totalCols));
                ws.mergeCells(holStartRow + 1 + idx, 4, holStartRow + 1 + idx, totalCols);
                const typeMap = { national: "NH · National", company: "FH · Festival", optional: "OH · Optional", restricted: "RH · Restricted" };
                r.getCell(1).value = h.date;
                r.getCell(1).font = { name: "Consolas", size: 10, bold: true, color: { argb: THEME.holidayText } };
                r.getCell(1).alignment = { horizontal: "left", vertical: "middle", indent: 1 };
                r.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.holidayBg } };
                r.getCell(4).value = `${typeMap[h.type] || "PH"}  ·  ${h.name}${h.description ? `  —  ${h.description}` : ""}`;
                r.getCell(4).font = { name: "Calibri", size: 10, color: { argb: THEME.textPrimary } };
                r.getCell(4).alignment = { horizontal: "left", vertical: "middle", indent: 1 };
                r.getCell(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: idx % 2 === 0 ? THEME.bg : THEME.bgAlt } };
                r.height = 20;
            });
        }

        const buffer = await wb.xlsx.writeBuffer();
        const filename = `attendance_${yearMonth}${department && department !== "all" ? `_${department}` : ""}.xlsx`;
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Cache-Control", "no-store");
        res.send(buffer);
    } catch (err) {
        console.error("[EXPORT-MUSTER]", err.message, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════
//  TIMECARD — single employee
// ═══════════════════════════════════════════════════════════════════════════

router.get("/timecard", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { biometricId, from, to } = req.query;
        if (!biometricId || !from || !to) {
            return res.status(400).json({ success: false, message: "biometricId, from, to required" });
        }
        const bid = String(biometricId).toUpperCase();

        const settings = await AttendanceSettings.getConfig();
        const thresholds = settings.lateHalfDayPolicy?.cumulativeLateMinsThreshold || { operator: 30, executive: 40 };

        const empDoc = await Employee.findOne({
            $or: [
                { biometricId: bid },
                { "basicInfo.biometricId": bid },
                { "workInfo.biometricId": bid },
            ]
        }).lean();

        const days = await DailyAttendance.find({ dateStr: { $gte: from, $lte: to } })
            .sort({ dateStr: 1 }).lean();

        const holidayMap = await loadHolidayMap(from, to);

        const start = new Date(from + "T00:00:00");
        const end = new Date(to + "T00:00:00");
        const today = new Date(); today.setHours(0, 0, 0, 0);

        const calendar = [];
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            if (d > today) continue;
            const ds = dateStrOf(new Date(d));
            const dow = d.getDay();
            calendar.push({
                dateStr: ds,
                dayName: new Date(d).toLocaleDateString("en-IN", { weekday: "short" }),
                fullDayName: new Date(d).toLocaleDateString("en-IN", { weekday: "long" }),
                dayNum: d.getDate(),
                monthName: new Date(d).toLocaleDateString("en-IN", { month: "short" }),
                isSunday: dow === 0,
                restStatus: resolveRestDayStatus(ds, dow, holidayMap),
                holiday: holidayMap.get(ds) || null,
            });
        }

        const byDate = new Map(days.map((d) => [d.dateStr, d]));
        const running = new Map();
        let lastYM = null;
        let empMeta = null;

        const rows = [];
        const stats = {
            P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, MP: 0, WO: 0, PH: 0,
            FH: 0, NH: 0, OH: 0, RH: 0,
            leaves: 0, unsynced: 0, effectivePresent: 0, sundayWorked: 0,
            totalLateMins: 0, totalOtMins: 0, totalNetWorkMins: 0, totalBreakMins: 0,
            autoPromotedHDs: 0, hrOverrides: 0, totalAttendance: 0,
        };

        for (const cal of calendar) {
            const dayDoc = byDate.get(cal.dateStr);

            if (!dayDoc) {
                if (cal.restStatus) {
                    rows.push({ ...cal, status: cal.restStatus, label: getDisplayLabel(cal.restStatus, settings), synced: false });
                    if (stats[cal.restStatus] !== undefined) stats[cal.restStatus]++;
                    stats.totalAttendance++;
                } else {
                    rows.push({ ...cal, status: "UNSYNCED", label: "Not synced", synced: false });
                    stats.unsynced++;
                }
                continue;
            }

            const entry = (dayDoc.employees || []).find((e) => e.biometricId === bid);
            if (!entry) {
                const s = cal.restStatus || "AB";
                rows.push({ ...cal, status: s, label: getDisplayLabel(s, settings), synced: true });
                if (stats[s] !== undefined) stats[s]++;
                if (s !== "AB") stats.totalAttendance++;
                continue;
            }

            if (dayDoc.yearMonth !== lastYM) { running.clear(); lastYM = dayDoc.yearMonth; }

            if (!empMeta) empMeta = {
                employeeName: entry.employeeName, department: entry.department,
                designation: entry.designation, employeeType: entry.employeeType,
                identityId: entry.identityId, biometricId: entry.biometricId,
                shiftStart: entry.shiftStart, shiftEnd: entry.shiftEnd,
                isGhost: !!entry.isGhost,
            };

            let cum = running.get(bid) || 0;
            let status = entry.systemPrediction;
            let promoted = false;
            if (settings.lateHalfDayPolicy?.enabled && entry.isLate && (entry.lateMins || 0) > 0) {
                cum += entry.lateMins;
                const thr = thresholds[entry.employeeType] ?? thresholds.operator ?? 30;
                if (cum >= thr) { status = "HD"; promoted = true; cum = 0; }
            }
            running.set(bid, cum);
            const finalStatus = entry.hrFinalStatus || status;

            if (isEffectivelyPresent({ ...entry, systemPrediction: finalStatus })) stats.effectivePresent++;
            if (stats[finalStatus] !== undefined) stats[finalStatus]++;
            if (["L-CL", "L-SL", "L-EL", "LWP", "WFH", "CO"].includes(finalStatus)) stats.leaves++;

            const paidCodes = ["P", "P*", "P~", "HD", "WO", "FH", "NH", "OH", "RH", "PH", "L-CL", "L-SL", "L-EL", "WFH", "CO"];
            if (paidCodes.includes(finalStatus)) stats.totalAttendance++;

            stats.totalLateMins += entry.lateMins || 0;
            stats.totalOtMins += entry.otMins || 0;
            stats.totalNetWorkMins += entry.netWorkMins || 0;
            stats.totalBreakMins += entry.totalBreakMins || 0;
            if (promoted) stats.autoPromotedHDs++;
            if (entry.hrFinalStatus) stats.hrOverrides++;
            if (cal.isSunday && (entry.punchCount || 0) > 0) stats.sundayWorked++;

            rows.push({
                ...cal, status: finalStatus,
                label: getDisplayLabel(finalStatus, settings),
                synced: true,
                isSundayWorked: cal.isSunday && (entry.punchCount || 0) > 0,
                inTime: entry.inTime, lunchOut: entry.lunchOut, lunchIn: entry.lunchIn,
                teaOut: entry.teaOut, teaIn: entry.teaIn, finalOut: entry.finalOut,
                punchCount: entry.punchCount, rawPunches: entry.rawPunches || [],
                netWorkMins: entry.netWorkMins || 0,
                totalBreakMins: entry.totalBreakMins || 0,
                lunchBreakMins: entry.lunchBreakMins || 0,
                teaBreakMins: entry.teaBreakMins || 0,
                totalSpanMins: entry.totalSpanMins || 0,
                lateMins: entry.lateMins || 0, otMins: entry.otMins || 0,
                isLate: entry.isLate, isEarlyDeparture: entry.isEarlyDeparture,
                hasMissPunch: entry.hasMissPunch, hasOT: entry.hasOT,
                earlyDepartureMins: entry.earlyDepartureMins || 0,
                shiftStart: entry.shiftStart, shiftEnd: entry.shiftEnd,
                appliedExtraGraceMins: entry.appliedExtraGraceMins || 0,
                wasPromotedToHalfDay: promoted,
                cumulativeLateMins: cum,
                hrFinalStatus: entry.hrFinalStatus || null,
                hrRemarks: entry.hrRemarks || null,
                systemPrediction: entry.systemPrediction,
            });
        }

        if (!empMeta && empDoc) {
            const empType = resolveEmployeeType(empDoc, settings);
            const shift = settings.shifts[empType] || settings.shifts.executive;
            empMeta = {
                employeeName: extractName(empDoc),
                department: extractDepartment(empDoc),
                designation: extractDesignation(empDoc),
                employeeType: empType,
                identityId: extractIdentity(empDoc),
                biometricId: bid,
                shiftStart: shift.start, shiftEnd: shift.end,
                isGhost: false,
            };
        }

        res.json({ success: true, from, to, biometricId: bid, employee: empMeta, rows, stats });
    } catch (err) {
        console.error("[TIMECARD]", err.message, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get("/employees-list", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const settings = await AttendanceSettings.getConfig();
        const emps = await Employee.find({
            $or: [{ status: "active" }, { status: { $exists: false } }, { isActive: true }],
        }).lean();

        const list = emps
            .filter((e) => extractBiometricId(e))
            .map((e) => ({
                biometricId: String(extractBiometricId(e)).toUpperCase(),
                employeeName: extractName(e),
                department: extractDepartment(e),
                designation: extractDesignation(e),
                employeeType: resolveEmployeeType(e, settings),
                identityId: extractIdentity(e),
            }))
            .sort((a, b) => (a.employeeName || "").localeCompare(b.employeeName || ""));

        res.json({ success: true, data: list, count: list.length });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get("/departments-with-designations", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const emps = await Employee.find({
            $or: [{ status: "active" }, { status: { $exists: false } }, { isActive: true }],
        }).lean();

        const byDepartment = {};
        const allDepartments = new Set();
        const allDesignations = new Set();

        for (const e of emps) {
            const dept = String(extractDepartment(e) || "").toUpperCase().trim();
            const desig = String(extractDesignation(e) || "").toUpperCase().trim();
            const validDept = dept && dept !== "—" && dept !== "N/A";
            const validDesig = desig && desig !== "—" && desig !== "N/A";
            if (validDept) allDepartments.add(dept);
            if (validDesig) allDesignations.add(desig);
            if (validDept && validDesig) {
                if (!byDepartment[dept]) byDepartment[dept] = new Set();
                byDepartment[dept].add(desig);
            }
        }

        const byDepartmentArray = {};
        for (const [dept, designs] of Object.entries(byDepartment)) {
            byDepartmentArray[dept] = [...designs].sort();
        }

        res.json({
            success: true,
            departments: [...allDepartments].sort(),
            designations: [...allDesignations].sort(),
            byDepartment: byDepartmentArray,
        });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  REGULARIZATION REQUESTS — full CRUD
// ═══════════════════════════════════════════════════════════════════════════
//  Flow: Employee (mobile) → Manager → HR → applied to attendance
//  All endpoints below implement backend + web-admin for HR. Manager decision
//  endpoint exists but expects managerId in body (web admin for now, mobile later).
// ═══════════════════════════════════════════════════════════════════════════

// List with filters
router.get("/regularizations", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { status, department, from, to, requestType, employeeId, page = 1, limit = 50 } = req.query;
        const filter = {};
        if (status && status !== "all") filter.status = status;
        if (department && department !== "all") filter.department = department;
        if (requestType && requestType !== "all") filter.requestType = requestType;
        if (employeeId) filter.employeeId = employeeId;
        if (from || to) {
            filter.dateStr = {};
            if (from) filter.dateStr.$gte = from;
            if (to) filter.dateStr.$lte = to;
        }

        const skip = (Number(page) - 1) * Number(limit);
        const total = await RegularizationRequest.countDocuments(filter);
        const list = await RegularizationRequest.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit))
            .lean();

        const all = await RegularizationRequest.find({}).lean();
        const stats = {
            total: all.length,
            pending: all.filter(a => a.status === "pending").length,
            manager_approved: all.filter(a => a.status === "manager_approved").length,
            manager_rejected: all.filter(a => a.status === "manager_rejected").length,
            hr_approved: all.filter(a => a.status === "hr_approved").length,
            hr_rejected: all.filter(a => a.status === "hr_rejected").length,
            cancelled: all.filter(a => a.status === "cancelled").length,
            byType: {
                miss_punch: all.filter(a => a.requestType === "miss_punch").length,
                late_arrival: all.filter(a => a.requestType === "late_arrival").length,
                early_departure: all.filter(a => a.requestType === "early_departure").length,
                wrong_status: all.filter(a => a.requestType === "wrong_status").length,
                other: all.filter(a => a.requestType === "other").length,
            },
        };

        res.json({
            success: true,
            data: list,
            total,
            page: Number(page),
            pages: Math.ceil(total / Number(limit)),
            stats,
        });
    } catch (err) {
        console.error("[REG-LIST]", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Get one
router.get("/regularizations/:id", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const r = await RegularizationRequest.findById(req.params.id).lean();
        if (!r) return res.status(404).json({ success: false, message: "Not found" });
        res.json({ success: true, data: r });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Create (mobile / web)
router.post("/regularizations", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const {
            employeeId, biometricId, employeeName, department, designation,
            requestType, dateStr, reason,
            proposedInTime, proposedOutTime, proposedStatus, proposedRemarks,
            documentUrl, documentFileId, documentFileName,
            managersNotified,
        } = req.body;

        if (!employeeId || !dateStr || !reason) {
            return res.status(400).json({ success: false, message: "employeeId, dateStr and reason are required" });
        }

        // Snapshot current state for audit
        let originalSnapshot = {
            inTime: null, finalOut: null, systemPrediction: null, hrFinalStatus: null,
            netWorkMins: 0, lateMins: 0, otMins: 0, punchCount: 0,
        };
        const dayDoc = await DailyAttendance.findOne({ dateStr }).lean();
        if (dayDoc && biometricId) {
            const entry = (dayDoc.employees || []).find(e => e.biometricId === String(biometricId).toUpperCase());
            if (entry) {
                originalSnapshot = {
                    inTime: entry.inTime || null,
                    finalOut: entry.finalOut || null,
                    systemPrediction: entry.systemPrediction || null,
                    hrFinalStatus: entry.hrFinalStatus || null,
                    netWorkMins: entry.netWorkMins || 0,
                    lateMins: entry.lateMins || 0,
                    otMins: entry.otMins || 0,
                    punchCount: entry.punchCount || 0,
                };
            }
        }

        const doc = await RegularizationRequest.create({
            employeeId,
            biometricId: biometricId ? String(biometricId).toUpperCase() : null,
            employeeName, department, designation,
            requestType: requestType || "miss_punch",
            dateStr, reason,
            proposedInTime: proposedInTime || null,
            proposedOutTime: proposedOutTime || null,
            proposedStatus: proposedStatus || null,
            proposedRemarks: proposedRemarks || null,
            documentUrl: documentUrl || null,
            documentFileId: documentFileId || null,
            documentFileName: documentFileName || null,
            documentUploadedAt: documentUrl ? new Date() : null,
            originalSnapshot,
            managersNotified: Array.isArray(managersNotified) ? managersNotified : [],
            status: "pending",
        });

        res.status(201).json({ success: true, data: doc, message: "Regularization request submitted" });
    } catch (err) {
        console.error("[REG-CREATE]", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Manager decision (structured for mobile app to hit later)
router.patch("/regularizations/:id/manager-decision", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { managerId, managerName, type, decision, remarks } = req.body;
        if (!["approved", "rejected"].includes(decision)) {
            return res.status(400).json({ success: false, message: "decision must be approved or rejected" });
        }
        const r = await RegularizationRequest.findById(req.params.id);
        if (!r) return res.status(404).json({ success: false, message: "Not found" });
        if (!["pending", "manager_approved"].includes(r.status)) {
            return res.status(400).json({ success: false, message: `Cannot record manager decision on status ${r.status}` });
        }

        r.managerDecisions.push({
            managerId, managerName, type: type || "primary",
            decision, remarks: remarks || "",
            decidedAt: new Date(),
        });
        if (decision === "rejected") r.status = "manager_rejected";
        else r.status = "manager_approved";
        await r.save();

        res.json({ success: true, data: r });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// HR approve → apply to attendance
router.patch("/regularizations/:id/hr-approve", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const r = await RegularizationRequest.findById(req.params.id);
        if (!r) return res.status(404).json({ success: false, message: "Not found" });
        if (r.status === "hr_approved") {
            return res.status(400).json({ success: false, message: "Already approved" });
        }

        r.status = "hr_approved";
        r.hrApprovedBy = req.user.id;
        r.hrApprovedAt = new Date();
        r.hrRemarks = (req.body?.remarks) || "";

        // Apply to attendance
        const bid = r.biometricId;
        if (bid) {
            const dayDoc = await DailyAttendance.findOne({ dateStr: r.dateStr });
            if (dayDoc) {
                const idx = (dayDoc.employees || []).findIndex(e => e.biometricId === bid);
                if (idx !== -1) {
                    const emp = dayDoc.employees[idx];

                    // Apply proposed times
                    const parseTimeOnDate = (timeStr) => {
                        if (!timeStr) return null;
                        const [h, m] = String(timeStr).split(":").map(Number);
                        const d = new Date(r.dateStr + "T00:00:00");
                        d.setHours(h || 0, m || 0, 0, 0);
                        return d;
                    };

                    if (r.proposedInTime) emp.inTime = parseTimeOnDate(r.proposedInTime);
                    if (r.proposedOutTime) emp.finalOut = parseTimeOnDate(r.proposedOutTime);

                    // Recompute derived values if we updated times
                    if (r.proposedInTime || r.proposedOutTime) {
                        const settings = await AttendanceSettings.getConfig();
                        const shift = settings.shifts[emp.employeeType] || settings.shifts.executive;
                        const shiftStart = hhmmMins(shift.start);
                        const shiftEnd = hhmmMins(shift.end);
                        const inMins = minsOf(emp.inTime);
                        const outMins = minsOf(emp.finalOut);

                        const totalSpanMins = (emp.inTime && emp.finalOut) ? Math.round((emp.finalOut - emp.inTime) / 60000) : 0;
                        const lunchBreakMins = (emp.lunchOut && emp.lunchIn) ? Math.max(0, Math.round((emp.lunchIn - emp.lunchOut) / 60000)) : 0;
                        const teaBreakMins = (emp.teaOut && emp.teaIn) ? Math.max(0, Math.round((emp.teaIn - emp.teaOut) / 60000)) : 0;
                        const totalBreakMins = lunchBreakMins + teaBreakMins;
                        const netWorkMins = Math.max(0, totalSpanMins - totalBreakMins);

                        const effectiveGrace = (shift.lateGraceMins || 0) + (emp.appliedExtraGraceMins || 0);
                        const lateMins = (inMins != null) ? Math.max(0, inMins - (shiftStart + effectiveGrace)) : 0;
                        const earlyDepartureMins = (outMins != null) ? Math.max(0, shiftEnd - outMins) : 0;

                        let otMins = 0;
                        if (emp.employeeType === "operator" && outMins != null) {
                            const over = outMins - shiftEnd - (shift.otGraceMins || 0);
                            if (over > 0) otMins = over;
                        }

                        emp.totalSpanMins = totalSpanMins;
                        emp.totalBreakMins = totalBreakMins;
                        emp.netWorkMins = netWorkMins;
                        emp.lateMins = lateMins;
                        emp.isLate = lateMins > 0;
                        emp.earlyDepartureMins = earlyDepartureMins;
                        emp.isEarlyDeparture = earlyDepartureMins > 0;
                        emp.otMins = otMins;
                        emp.hasOT = otMins > 0;
                        emp.hasMissPunch = !(emp.inTime && emp.finalOut);
                    }

                    if (r.proposedStatus) emp.hrFinalStatus = r.proposedStatus;
                    emp.hrRemarks = r.proposedRemarks || `Regularized (${r.requestType})`;
                    emp.hrReviewedAt = new Date();

                    dayDoc.markModified("employees");
                    await dayDoc.save();

                    r.appliedToAttendance = true;
                    r.appliedAt = new Date();
                }
            }
        }

        await r.save();
        res.json({ success: true, data: r, message: "Approved and applied to attendance" });
    } catch (err) {
        console.error("[REG-APPROVE]", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// HR reject
router.patch("/regularizations/:id/hr-reject", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const r = await RegularizationRequest.findById(req.params.id);
        if (!r) return res.status(404).json({ success: false, message: "Not found" });
        r.status = "hr_rejected";
        r.rejectedBy = req.user.id;
        r.rejectedAt = new Date();
        r.rejectionReason = (req.body?.rejectionReason) || "";
        await r.save();
        res.json({ success: true, data: r });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Cancel (by employee, from mobile)
router.patch("/regularizations/:id/cancel", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const r = await RegularizationRequest.findById(req.params.id);
        if (!r) return res.status(404).json({ success: false, message: "Not found" });
        if (["hr_approved", "hr_rejected", "cancelled"].includes(r.status)) {
            return res.status(400).json({ success: false, message: `Cannot cancel from status ${r.status}` });
        }
        r.status = "cancelled";
        r.cancelledBy = req.user.id;
        r.cancelledAt = new Date();
        r.cancelReason = (req.body?.cancelReason) || "";
        await r.save();
        res.json({ success: true, data: r });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  HOLIDAYS — expose via attendance namespace too for the settings page
// ═══════════════════════════════════════════════════════════════════════════

router.get("/holidays", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { year } = req.query;
        const filter = year ? { date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } } : {};
        const list = await CompanyHoliday.find(filter).sort({ date: 1 }).lean();
        res.json({ success: true, data: list });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post("/holidays", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { date, name, description, type } = req.body;
        if (!date || !name) return res.status(400).json({ success: false, message: "date and name required" });
        const h = await CompanyHoliday.findOneAndUpdate(
            { date },
            { date, name, description, type: type || "company", createdBy: req.user.id },
            { new: true, upsert: true }
        );

        // Re-sync that day so holiday status gets injected
        try { await syncDay(date); } catch (e) { console.warn("[HOLIDAY] re-sync failed:", e.message); }

        res.status(201).json({ success: true, data: h });
    } catch (err) {
        if (err.code === 11000) return res.status(400).json({ success: false, message: "Holiday already exists" });
        res.status(500).json({ success: false, message: err.message });
    }
});

router.delete("/holidays/:id", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const h = await CompanyHoliday.findByIdAndDelete(req.params.id);
        if (h?.date) {
            try { await syncDay(h.date); } catch (e) { console.warn("[HOLIDAY-DEL] re-sync failed:", e.message); }
        }
        res.json({ success: true, message: "Holiday removed" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  EXPORT HELPERS FOR OTHER ROUTE FILES
// ═══════════════════════════════════════════════════════════════════════════

router.applyLeaveToAttendance = applyLeaveToAttendance;

module.exports = router;
module.exports.applyLeaveToAttendance = applyLeaveToAttendance;
module.exports.applyApprovedLeavesForDate = applyApprovedLeavesForDate;