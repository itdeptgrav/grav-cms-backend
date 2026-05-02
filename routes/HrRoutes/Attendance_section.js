"use strict";
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const router = express.Router();
const ExcelJS = require("exceljs");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const AttendanceSettings = require("../../models/HR_Models/Attendancesettings");
const Employee = require("../../models/Employee");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");

const mongoose = require("mongoose");
require("../../models/HR_Models/LeaveManagement");
function getCompanyHoliday() {
    return mongoose.model("CompanyHoliday");
}
function getRegularizationRequest() {
    return mongoose.model("RegularizationRequest");
}
function getLeaveApplication() {
    return mongoose.model("LeaveApplication");
}
function getLeaveBalance() {
    return mongoose.model("LeaveBalance");
}
function getLeaveConfig() {
    return mongoose.model("LeaveConfig");
}

let emailService = {};
try {
    emailService = require("../../services/emailService");
} catch (e) {
    console.warn(
        "[ATTENDANCE] emailService not found, email features disabled:",
        e.message,
    );
}

const ETIME_BASE = (
    process.env.TEAMOFFICE_BASE_URL || "https://api.etimeoffice.com/api"
).replace(/\/+$/, "");

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
    if (data?.Error === true)
        throw new Error(data.Msg || "eTimeOffice Error:true");
    const punches = Array.isArray(data?.PunchData) ? data.PunchData : [];
    console.log(`[ETIME] got ${punches.length} punches`);
    return punches;
}

function parsePunchDate(str) {
    if (!str) return null;
    const [datePart, timePart = "00:00:00"] = String(str).trim().split(/\s+/);
    const [d, m, y] = datePart.split("/");
    const [hh, mm, ss = "00"] = timePart.split(":");
    const utcMs = Date.UTC(+y, +m - 1, +d, +hh, +mm, +ss) - 330 * 60 * 1000;
    const dt = new Date(utcMs);
    return isNaN(dt.getTime()) ? null : dt;
}

const dateStrOf = (d) => {
    const ist = new Date(d.getTime() + 330 * 60 * 1000);
    return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
};

const parseTimeOnDateIST = (timeStr, dateStr) => {
    if (!timeStr) return null;
    const [h, m] = String(timeStr).split(":").map(Number);
    const [y, mo, d] = dateStr.split("-").map(Number);
    const utcMs = Date.UTC(y, mo - 1, d, h, m, 0) - 5.5 * 60 * 60 * 1000;
    return new Date(utcMs);
};

const toTitleCase = (s) =>
    String(s || "")
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase());
const numericOf = (s) => {
    const d = String(s || "").replace(/\D/g, "");
    return d ? parseInt(d, 10) : null;
};

const minsOf = (d) => {
    if (!d) return null;
    const dt = new Date(d);
    const utcMins = dt.getUTCHours() * 60 + dt.getUTCMinutes();
    return (utcMins + 330) % 1440;
};
const fmtTimeIST = (d) => {
    if (!d) return "";
    const dt = new Date(d);
    return dt.toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Kolkata",
    });
};
const fmtTimeIST12 = (d) => {
    if (!d) return "—";
    const dt = new Date(d);
    return dt.toLocaleTimeString("en-IN", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "Asia/Kolkata",
    });
};
const hhmmMins = (s) => {
    const [h, m] = String(s || "00:00")
        .split(":")
        .map(Number);
    return (h || 0) * 60 + (m || 0);
};

function normalizeName(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/\b(dr|mr|mrs|ms|miss|shri|smt|prof)\.?\b/g, "")
        .replace(/[^a-z0-9]/g, "");
}
function sortedNameKey(name) {
    const tokens = String(name || "")
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
    return normalizeName(tokens.sort().join(""));
}
function firstLastKey(name) {
    const tokens = String(name || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (tokens.length < 2) return null;
    return normalizeName(tokens[0] + tokens[tokens.length - 1]);
}
function extractName(emp, fallback = "") {
    const candidates = [
        emp?.fullName,
        emp?.name,
        emp?.basicInfo?.fullName,
        emp?.basicInfo?.name,
        emp?.personalInfo?.fullName,
        emp?.personalInfo?.name,
        emp?.profile?.fullName,
        emp?.profile?.name,
        [emp?.firstName, emp?.middleName, emp?.lastName]
            .filter(Boolean)
            .join(" ")
            .trim(),
        [
            emp?.basicInfo?.firstName,
            emp?.basicInfo?.middleName,
            emp?.basicInfo?.lastName,
        ]
            .filter(Boolean)
            .join(" ")
            .trim(),
        [
            emp?.personalInfo?.firstName,
            emp?.personalInfo?.middleName,
            emp?.personalInfo?.lastName,
        ]
            .filter(Boolean)
            .join(" ")
            .trim(),
    ];
    for (const c of candidates)
        if (c && String(c).trim()) return String(c).trim();
    return fallback ? toTitleCase(fallback) : "";
}
const extractIdentity = (e) =>
    e?.empCode ||
    e?.employeeCode ||
    e?.basicInfo?.empCode ||
    e?.workInfo?.empCode ||
    e?.code ||
    e?.identityId ||
    "";
const extractDepartment = (e) =>
    e?.department || e?.workInfo?.department || e?.basicInfo?.department || "—";
const extractDesignation = (e) =>
    e?.designation ||
    e?.workInfo?.designation ||
    e?.basicInfo?.designation ||
    e?.jobTitle ||
    e?.role ||
    "—";
const extractBiometricId = (e) =>
    e?.biometricId || e?.basicInfo?.biometricId || e?.workInfo?.biometricId || "";

function holidayTypeToStatus(type) {
    switch (type) {
        case "national":
            return "NH";
        case "optional":
            return "OH";
        case "company":
            return "FH";
        case "restricted":
            return "RH";
        case "working_sunday":
            return null;
        default:
            return "FH";
    }
}
async function loadHolidayMap(fromStr, toStr) {
    const hols = await getCompanyHoliday()
        .find({ date: { $gte: fromStr, $lte: toStr } })
        .lean();
    const map = new Map();
    for (const h of hols) map.set(h.date, h);
    return map;
}
function resolveRestDayStatus(dateStr, dayOfWeek, holidayMap) {
    const h = holidayMap.get(dateStr);
    if (h) {
        if (h.type === "working_sunday") return null;
        return holidayTypeToStatus(h.type);
    }
    if (dayOfWeek === 0) return "WO";
    return null;
}

function allDaysInRange(from, to) {
    const start = new Date(from + "T00:00:00"),
        end = new Date(to + "T00:00:00");
    const _nowIST = new Date(Date.now() + 330 * 60 * 1000);
    const today = new Date(
        `${_nowIST.getUTCFullYear()}-${String(_nowIST.getUTCMonth() + 1).padStart(2, "0")}-${String(_nowIST.getUTCDate()).padStart(2, "0")}T00:00:00`,
    );
    const dates = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (d > today) continue;
        dates.push(dateStrOf(d));
    }
    return dates;
}
function workingDaysInRange(from, to, weeklyOffDay = 0) {
    const start = new Date(from + "T00:00:00"),
        end = new Date(to + "T00:00:00");
    const _nowIST = new Date(Date.now() + 330 * 60 * 1000);
    const today = new Date(
        `${_nowIST.getUTCFullYear()}-${String(_nowIST.getUTCMonth() + 1).padStart(2, "0")}-${String(_nowIST.getUTCDate()).padStart(2, "0")}T00:00:00`,
    );
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
    return ["P", "P*", "P~"].includes(
        entry.hrFinalStatus || entry.systemPrediction,
    );
}

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
    const opDesigs = settings.operatorDesignations || [],
        execDesigs = settings.executiveDesignations || [];
    const coreDepts = new Set(
        (
            settings.departmentCategories?.core ||
            settings.operatorDepartments ||
            []
        ).map((d) => d.toUpperCase()),
    );
    const genDepts = new Set(
        (settings.departmentCategories?.general || []).map((d) => d.toUpperCase()),
    );
    if (designationMatches(designation, opDesigs)) return "operator";
    if (designationMatches(designation, execDesigs)) return "executive";
    if (coreDepts.has(department)) return "operator";
    if (genDepts.has(department)) return "executive";
    return "executive";
}

function shiftMidpointMins(shift) {
    return Math.round((hhmmMins(shift.start) + hhmmMins(shift.end)) / 2);
}

function assignPunchTypes(punches, employeeType, shift, settings) {
    const expected = employeeType === "operator" ? 6 : 2;
    const sorted = [...punches].sort((a, b) => a.time - b.time);
    if (sorted.length === 0)
        return {
            punches: [],
            expected,
            hasMissPunch: true,
            missingPunchType: null,
        };
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
        return {
            punches: assigned,
            expected,
            hasMissPunch: true,
            missingPunchType: kind === "in" ? "out" : "in",
        };
    }
    assigned[0].punchType = "in";
    assigned[assigned.length - 1].punchType = "out";
    let missingPunchType = null;
    if (employeeType === "operator") {
        const middle = assigned.slice(1, -1);
        if (middle.length >= 4) {
            middle[0].punchType = "lunch_out";
            middle[1].punchType = "lunch_in";
            middle[2].punchType = "tea_out";
            middle[3].punchType = "tea_in";
        } else if (middle.length === 3) {
            const TEA_MAX_MINS = 45;
            const g01 = Math.round((middle[1].time - middle[0].time) / 60000);
            const g12 = Math.round((middle[2].time - middle[1].time) / 60000);
            if (g12 <= TEA_MAX_MINS && g01 > TEA_MAX_MINS) {
                middle[0].punchType = "lunch_out";
                middle[1].punchType = "tea_out";
                middle[2].punchType = "tea_in";
                missingPunchType = "lunch_in";
            } else if (g01 <= TEA_MAX_MINS + 30 && g12 > TEA_MAX_MINS) {
                middle[0].punchType = "lunch_out";
                middle[1].punchType = "lunch_in";
                middle[2].punchType = "tea_out";
                missingPunchType = "tea_in";
            } else {
                middle[0].punchType = "lunch_out";
                middle[1].punchType = "lunch_in";
                middle[2].punchType = "tea_out";
                missingPunchType = "tea_in";
            }
        } else if (middle.length === 2) {
            middle[0].punchType = "lunch_out";
            middle[1].punchType = "lunch_in";
            missingPunchType = "tea_out";
        } else if (middle.length === 1) {
            middle[0].punchType = "lunch_out";
            missingPunchType = "lunch_in";
        }
    }
    assigned.forEach((p, i) => (p.seq = i + 1));
    return {
        punches: assigned,
        expected,
        hasMissPunch: assigned.length < expected,
        missingPunchType,
    };
}

async function buildEmployeeMap() {
    const employees = await Employee.find({
        $or: [
            { status: "active" },
            { status: { $exists: false } },
            { isActive: true },
        ],
    }).lean();
    const byBiometric = new Map(),
        byName = new Map(),
        bySorted = new Map();
    let skippedNoId = 0,
        skippedNoName = 0;
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
        } else skippedNoId++;
        const name = extractName(e);
        if (!name) {
            skippedNoName++;
            continue;
        }
        const k1 = normalizeName(name);
        if (k1 && !byName.has(k1)) byName.set(k1, e);
        const k2 = firstLastKey(name);
        if (k2 && k2 !== k1 && !byName.has(k2)) byName.set(k2, e);
        const k3 = sortedNameKey(name);
        if (k3 && !bySorted.has(k3)) bySorted.set(k3, e);
    }
    console.log(
        `[MAP] ${employees.length} emps → bioKeys=${byBiometric.size} nameKeys=${byName.size} sortedKeys=${bySorted.size} (noId:${skippedNoId}, noName:${skippedNoName})`,
    );
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
    if (empMap.byBiometric.has(keys.padded))
        return {
            employee: empMap.byBiometric.get(keys.padded),
            method: "biometric-exact",
        };
    if (keys.numeric && empMap.byBiometric.has(keys.numeric))
        return {
            employee: empMap.byBiometric.get(keys.numeric),
            method: "biometric-numeric",
        };
    if (empMap.byBiometric.has(keys.raw))
        return {
            employee: empMap.byBiometric.get(keys.raw),
            method: "biometric-raw",
        };
    if (Name) {
        const k1 = normalizeName(Name);
        if (k1 && empMap.byName.has(k1))
            return { employee: empMap.byName.get(k1), method: "name-exact" };
        const k2 = firstLastKey(Name);
        if (k2 && empMap.byName.has(k2))
            return { employee: empMap.byName.get(k2), method: "name-first-last" };
        const k3 = sortedNameKey(Name);
        if (k3 && empMap.bySorted.has(k3))
            return { employee: empMap.bySorted.get(k3), method: "name-sorted" };
    }
    return null;
}

function fmtLateMins(mins) {
    if (!mins || mins <= 0) return "";
    const h = Math.floor(mins / 60),
        m = mins % 60;
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}
function getAttendanceValue(status) {
    if (!status) return 0;
    if (status === "HD") return 0.5;
    if (["AB", "LWP"].includes(status)) return 0;
    return 1;
}

function computeDay(
    punches,
    employeeType,
    shift,
    settings,
    extraGraceMins = 0,
    isToday = false,
) {
    if (!punches.length) {
        return {
            rawPunches: [],
            punchCount: 0,
            systemPrediction: "AB",
            hasMissPunch: false,
            missingPunchType: null,
            isLate: false,
            lateMins: 0,
            lateDisplay: "",
            netWorkMins: 0,
            otMins: 0,
            totalBreakMins: 0,
            lunchBreakMins: 0,
            teaBreakMins: 0,
            totalSpanMins: 0,
            isEarlyDeparture: false,
            earlyDepartureMins: 0,
            hasOT: false,
            inTime: null,
            lunchOut: null,
            lunchIn: null,
            teaOut: null,
            teaIn: null,
            finalOut: null,
            appliedExtraGraceMins: extraGraceMins || 0,
            attendanceValue: 0,
        };
    }
    const {
        punches: assigned,
        hasMissPunch,
        missingPunchType,
    } = assignPunchTypes(punches, employeeType, shift, settings);
    const find = (t) => assigned.find((p) => p.punchType === t)?.time || null;
    const inTime = find("in"),
        lunchOut = find("lunch_out"),
        lunchIn = find("lunch_in");
    const teaOut = find("tea_out"),
        teaIn = find("tea_in"),
        finalOut = find("out");
    const totalSpanMins =
        inTime && finalOut ? Math.round((finalOut - inTime) / 60000) : 0;
    const lunchBreakMins =
        lunchOut && lunchIn
            ? Math.max(0, Math.round((lunchIn - lunchOut) / 60000))
            : 0;
    const teaBreakMins =
        teaOut && teaIn ? Math.max(0, Math.round((teaIn - teaOut) / 60000)) : 0;
    const totalBreakMins = lunchBreakMins + teaBreakMins,
        netWorkMins = Math.max(0, totalSpanMins - totalBreakMins);
    const shiftStart = hhmmMins(shift.start),
        shiftEnd = hhmmMins(shift.end);
    const inMins = minsOf(inTime),
        outMins = minsOf(finalOut);
    const effectiveGrace = (shift.lateGraceMins || 0) + (extraGraceMins || 0);
    const lateMins =
        inMins != null ? Math.max(0, inMins - (shiftStart + effectiveGrace)) : 0;
    const isLate = lateMins > 0,
        lateDisplay = fmtLateMins(lateMins);
    const earlyDepartureMins =
        outMins != null ? Math.max(0, shiftEnd - outMins) : 0;
    const isEarlyDeparture = earlyDepartureMins > 0;
    let otMins = 0;
    if (employeeType === "operator" && outMins != null) {
        const over = outMins - shiftEnd - (shift.otGraceMins || 0);
        if (over > 0) otMins = over;
    }
    const hasInAndOut = !!inTime && !!finalOut;
    let systemPrediction;
    if (!hasInAndOut) {
        systemPrediction = isToday && !!inTime && !finalOut ? "P" : "MP";
    } else if (netWorkMins < (shift.halfDayThresholdMins || 240)) {
        systemPrediction = "HD";
    } else if (isLate) {
        systemPrediction = "P*";
    } else if (isEarlyDeparture) {
        systemPrediction = "P~";
    } else {
        systemPrediction = "P";
    }
    const attendanceValue = getAttendanceValue(systemPrediction);
    return {
        rawPunches: assigned.map((p) => ({
            seq: p.seq,
            time: p.time,
            mcid: p.mcid != null ? Number(p.mcid) : null,
            mFlag: p.mFlag || null,
            punchType: p.punchType,
            source: "device",
        })),
        punchCount: assigned.length,
        inTime,
        lunchOut,
        lunchIn,
        teaOut,
        teaIn,
        finalOut,
        totalSpanMins,
        lunchBreakMins,
        teaBreakMins,
        totalBreakMins,
        netWorkMins,
        otMins,
        isLate,
        lateMins,
        lateDisplay,
        isEarlyDeparture,
        earlyDepartureMins,
        hasOT: otMins > 0,
        hasMissPunch,
        missingPunchType,
        systemPrediction,
        attendanceValue,
        appliedExtraGraceMins: extraGraceMins || 0,
    };
}

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
    for (const e of doc.employees || []) {
        if ((e.otMins || 0) >= (gc.triggerMins || 60))
            map.set(e.biometricId, gc.bonusGraceMins || 15);
    }
    return map;
}
function graceAppliesTo(employeeType, settings) {
    const applyTo = settings.graceCarryForward?.applyTo || "both";
    if (applyTo === "both") return true;
    return applyTo === employeeType;
}

function canSkipDeviceFetch(dateStr, todayStr, existingDoc) {
    if (!existingDoc || dateStr === todayStr) return false;
    if ((existingDoc.syncCount || 0) === 0) return false;
    return existingDoc.employees.every(
        (e) => !e.hasMissPunch || !!e.hrFinalStatus,
    );
}

function mergeEmployeeEntry(fresh, existing, shift, isToday) {
    const existingManual = (existing.rawPunches || []).filter(
        (p) => p.source === "manual" || p.source === "miss_punch",
    );
    const manualTypes = new Set(existingManual.map((p) => p.punchType));
    const freshDevice = (fresh.rawPunches || []).filter(
        (p) => !manualTypes.has(p.punchType),
    );
    const mergedRaw = [...existingManual, ...freshDevice]
        .filter((p) => p.time)
        .sort((a, b) => new Date(a.time) - new Date(b.time))
        .map((p, i) => ({ ...p, seq: i + 1 }));
    const findTime = (pt) =>
        (mergedRaw.find((r) => r.punchType === pt) || {}).time || null;
    const inTime = findTime("in"),
        lunchOut = findTime("lunch_out"),
        lunchIn = findTime("lunch_in");
    const teaOut = findTime("tea_out"),
        teaIn = findTime("tea_in"),
        finalOut = findTime("out");
    const ms = (t) => (t ? new Date(t).getTime() : null);
    const totalSpanMins =
        ms(inTime) && ms(finalOut) && ms(finalOut) > ms(inTime)
            ? Math.round((ms(finalOut) - ms(inTime)) / 60000)
            : 0;
    const lunchBreakMins =
        ms(lunchOut) && ms(lunchIn) && ms(lunchIn) > ms(lunchOut)
            ? Math.round((ms(lunchIn) - ms(lunchOut)) / 60000)
            : 0;
    const teaBreakMins =
        ms(teaOut) && ms(teaIn) && ms(teaIn) > ms(teaOut)
            ? Math.round((ms(teaIn) - ms(teaOut)) / 60000)
            : 0;
    const totalBreakMins = lunchBreakMins + teaBreakMins,
        netWorkMins = Math.max(0, totalSpanMins - totalBreakMins);
    const shiftStart = hhmmMins(shift.start),
        shiftEnd = hhmmMins(shift.end);
    const inClockMins = inTime ? minsOf(new Date(inTime)) : null,
        outClockMins = finalOut ? minsOf(new Date(finalOut)) : null;
    const effectiveGrace =
        (shift.lateGraceMins || 0) + (fresh.appliedExtraGraceMins || 0);
    const lateMins =
        inClockMins != null
            ? Math.max(0, inClockMins - (shiftStart + effectiveGrace))
            : 0;
    const earlyDepartureMins =
        outClockMins != null ? Math.max(0, shiftEnd - outClockMins) : 0;
    let otMins = 0;
    if (fresh.employeeType === "operator" && outClockMins != null) {
        const over = outClockMins - shiftEnd - (shift.otGraceMins || 0);
        if (over > 0) otMins = over;
    }
    const hasMissPunch = !(inTime && finalOut);
    let missingPunchType = null;
    if (hasMissPunch) {
        const presentTypes = new Set(mergedRaw.map((p) => p.punchType));
        const scope =
            fresh.employeeType === "operator"
                ? ["in", "lunch_out", "lunch_in", "tea_out", "tea_in", "out"]
                : ["in", "out"];
        const missing = scope.filter((t) => !presentTypes.has(t));
        if (missing.length === 1) {
            missingPunchType = missing[0];
        } else if (missing.length > 0) {
            if (!presentTypes.has("lunch_in") && presentTypes.has("tea_out"))
                missingPunchType = "lunch_in";
            else if (!presentTypes.has("tea_in") && presentTypes.has("tea_out"))
                missingPunchType = "tea_in";
            else missingPunchType = missing[0];
        }
    }
    let systemPrediction;
    if (!inTime) systemPrediction = "AB";
    else if (!finalOut) systemPrediction = isToday ? "P" : "MP";
    else if (netWorkMins < (shift.halfDayThresholdMins || 240))
        systemPrediction = "HD";
    else if (lateMins > 0) systemPrediction = "P*";
    else if (earlyDepartureMins > 0) systemPrediction = "P~";
    else systemPrediction = "P";
    return {
        employeeDbId: fresh.employeeDbId,
        biometricId: fresh.biometricId,
        numericId: fresh.numericId,
        identityId: fresh.identityId,
        employeeName: fresh.employeeName,
        department: fresh.department,
        designation: fresh.designation,
        employeeType: fresh.employeeType,
        isGhost: fresh.isGhost,
        matchMethod: fresh.matchMethod,
        providerName: fresh.providerName,
        shiftStart: fresh.shiftStart,
        shiftEnd: fresh.shiftEnd,
        appliedExtraGraceMins: fresh.appliedExtraGraceMins || 0,
        rawPunches: mergedRaw,
        punchCount: mergedRaw.length,
        inTime,
        lunchOut,
        lunchIn,
        teaOut,
        teaIn,
        finalOut,
        totalSpanMins,
        lunchBreakMins,
        teaBreakMins,
        totalBreakMins,
        netWorkMins,
        otMins,
        lateMins,
        lateDisplay: fmtLateMins(lateMins),
        isLate: lateMins > 0,
        earlyDepartureMins,
        isEarlyDeparture: earlyDepartureMins > 0,
        hasOT: otMins > 0,
        hasMissPunch,
        missingPunchType,
        systemPrediction,
        attendanceValue: getAttendanceValue(
            existing.hrFinalStatus || systemPrediction,
        ),
        hrFinalStatus: existing.hrFinalStatus || null,
        hrRemarks: existing.hrRemarks || null,
        hrReviewedAt: existing.hrReviewedAt || null,
    };
}

async function smartSaveDay(
    dateStr,
    freshEmployees,
    dayMeta,
    existingDoc,
    settings,
    isToday,
) {
    if (!existingDoc || existingDoc.employees.length === 0) {
        await DailyAttendance.updateOne(
            { dateStr },
            {
                $set: {
                    ...dayMeta,
                    employees: freshEmployees,
                    summary: buildSummary(freshEmployees),
                },
            },
            { upsert: true },
        );
        return;
    }
    const existingMap = new Map(
        existingDoc.employees.map((e) => [e.biometricId, e]),
    );
    const mergedEmployees = freshEmployees.map((fresh) => {
        const old = existingMap.get(fresh.biometricId);
        if (!old) return fresh;
        const hasManualPunches = (old.rawPunches || []).some(
            (p) => p.source === "manual" || p.source === "miss_punch",
        );
        const hasHROverride = !!(old.hrFinalStatus || old.hrRemarks);
        if (!hasManualPunches && !hasHROverride) return fresh;
        const empType = fresh.employeeType || "operator";
        const shift = settings.shifts[empType] || settings.shifts.executive;
        return mergeEmployeeEntry(fresh, old, shift, isToday);
    });
    const freshBids = new Set(freshEmployees.map((e) => e.biometricId));
    for (const old of existingDoc.employees) {
        if (!freshBids.has(old.biometricId))
            mergedEmployees.push(old.toObject ? old.toObject() : { ...old });
    }
    mergedEmployees.sort((a, b) => {
        if (a.isGhost !== b.isGhost) return a.isGhost ? 1 : -1;
        return (a.employeeName || "").localeCompare(b.employeeName || "");
    });
    await DailyAttendance.updateOne(
        { dateStr },
        {
            $set: {
                ...dayMeta,
                employees: mergedEmployees,
                summary: buildSummary(mergedEmployees),
                syncedAt: new Date(),
                syncSource: "etimeoffice",
                syncCount: (existingDoc.syncCount || 0) + 1,
            },
        },
        { upsert: true },
    );
}
async function syncDay(dateStr, empCode = "ALL") {
    console.log(`[SYNC] Day ${dateStr}`);
    const _nowIST = new Date(Date.now() + 330 * 60 * 1000);
    const todayStr = `${_nowIST.getUTCFullYear()}-${String(_nowIST.getUTCMonth() + 1).padStart(2, "0")}-${String(_nowIST.getUTCDate()).padStart(2, "0")}`;
    const isToday = dateStr === todayStr;
    const settings = await AttendanceSettings.getConfig();
    const existingDoc = await DailyAttendance.findOne({ dateStr }).lean();
    if (canSkipDeviceFetch(dateStr, todayStr, existingDoc)) {
        console.log(
            `[SYNC] ${dateStr}: skipping device fetch (all employees have complete/HR-overridden punches)`,
        );
        try {
            await applyApprovedLeavesForDate(dateStr);
        } catch (e) {
            console.warn(`[SYNC] leave-sync for ${dateStr} failed:`, e.message);
        }
        return {
            dateStr,
            fetched: 0,
            matched: 0,
            employees: existingDoc.employees.length,
            ghostCount: existingDoc.employees.filter((e) => e.isGhost).length,
            skipped: true,
            methodTally: {},
            nameMismatches: [],
            unmatchedList: [],
            holiday: existingDoc.holiday || null,
        };
    }
    const rawPunches = await fetchPunches(dateStr, dateStr, empCode);
    const empMap = await buildEmployeeMap();
    const holidayMap = await loadHolidayMap(dateStr, dateStr);
    const yesterdayOt = await buildYesterdayOtMap(dateStr, settings);
    const dayOfWeek = new Date(dateStr + "T00:00:00").getDay();
    const restDayStatus = resolveRestDayStatus(dateStr, dayOfWeek, holidayMap);
    const grouped = new Map(),
        ghostInfo = new Map();
    const methodTally = {
        "biometric-exact": 0,
        "biometric-numeric": 0,
        "biometric-raw": 0,
        "name-exact": 0,
        "name-first-last": 0,
        "name-sorted": 0,
        ghost: 0,
    };
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
                if (k1 && k2 && k1 !== k2 && !k1.includes(k2) && !k2.includes(k1))
                    nameMismatches.push({
                        biometricId: keys.padded,
                        providerName: p.Name,
                        dbName,
                    });
            }
        } else {
            employee = null;
            method = "ghost";
            groupKey = "G:" + keys.padded;
            isGhost = true;
            if (!ghostInfo.has(keys.padded))
                ghostInfo.set(keys.padded, { name: p.Name, empcode: p.Empcode });
        }
        methodTally[method]++;
        if (!grouped.has(groupKey))
            grouped.set(groupKey, {
                employee,
                isGhost,
                biometricId: keys.padded,
                providerName: p.Name,
                providerEmpcode: p.Empcode,
                method,
                punches: [],
            });
        grouped
            .get(groupKey)
            .punches.push({ time, mcid: p.mcid || null, mFlag: p.M_Flag || null });
    }
    const employees = [];
    const seenBiometricIds = new Set();
    for (const [, g] of grouped) {
        let employeeType,
            department,
            designation,
            employeeName,
            employeeDbId,
            identityId,
            numericId;
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
        const extraGrace = graceAppliesTo(employeeType, settings)
            ? yesterdayOt.get(g.biometricId) || 0
            : 0;
        const computed = computeDay(
            g.punches,
            employeeType,
            shift,
            settings,
            extraGrace,
            isToday,
        );
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
            lateDisplay: computed.lateDisplay || "",
            attendanceValue:
                computed.attendanceValue ??
                getAttendanceValue(computed.systemPrediction),
            missingPunchType: computed.missingPunchType || null,
            shiftStart: shift.start,
            shiftEnd: shift.end,
        });
        seenBiometricIds.add(g.biometricId);
    }
    if (restDayStatus) {
        for (const emp of empMap.employees) {
            const bid = extractBiometricId(emp);
            if (!bid) continue;
            const key = String(bid).toUpperCase();
            if (seenBiometricIds.has(key)) continue;
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
                rawPunches: [],
                punchCount: 0,
                inTime: null,
                lunchOut: null,
                lunchIn: null,
                teaOut: null,
                teaIn: null,
                finalOut: null,
                totalSpanMins: 0,
                lunchBreakMins: 0,
                teaBreakMins: 0,
                totalBreakMins: 0,
                netWorkMins: 0,
                otMins: 0,
                isLate: false,
                lateMins: 0,
                isEarlyDeparture: false,
                earlyDepartureMins: 0,
                hasOT: false,
                hasMissPunch: false,
                systemPrediction: restDayStatus,
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
        biometricId: bid,
        empcode: info.empcode,
        name: info.name,
    }));
    const date = new Date(dateStr + "T00:00:00");
    const dayHoliday = holidayMap.get(dateStr) || null;
    const dayMeta = {
        dateStr,
        date,
        yearMonth: dateStr.slice(0, 7),
        dayOfWeek: date.getDay(),
        holiday: dayHoliday
            ? {
                name: dayHoliday.name,
                type: dayHoliday.type,
                statusCode: holidayTypeToStatus(dayHoliday.type),
            }
            : null,
        unmatchedPunches,
        syncSource: "etimeoffice",
    };
    await smartSaveDay(
        dateStr,
        employees,
        dayMeta,
        existingDoc,
        settings,
        isToday,
    );
    console.log(
        `[SYNC] ${dateStr}: ${employees.length} rows (real:${employees.filter((e) => !e.isGhost).length} ghost:${employees.filter((e) => e.isGhost).length}) methods=${JSON.stringify(methodTally)} holiday=${dayHoliday?.type || "none"}`,
    );
    try {
        await applyApprovedLeavesForDate(dateStr);
    } catch (e) {
        console.warn(`[SYNC] leave-sync for ${dateStr} failed:`, e.message);
    }
    return {
        dateStr,
        fetched: rawPunches.length,
        matched: rawPunches.length,
        employees: employees.length,
        ghostCount: employees.filter((e) => e.isGhost).length,
        methodTally,
        nameMismatches,
        unmatchedList: unmatchedPunches,
        holiday: dayHoliday
            ? { date: dayHoliday.date, name: dayHoliday.name, type: dayHoliday.type }
            : null,
    };
}

function buildSummary(employees) {
    const s = {
        total: employees.length,
        P: 0,
        "P*": 0,
        "P~": 0,
        HD: 0,
        AB: 0,
        MP: 0,
        WO: 0,
        PH: 0,
        FH: 0,
        NH: 0,
        OH: 0,
        RH: 0,
        presentCount: 0,
        totalLateMins: 0,
        totalOtMins: 0,
        ghostCount: 0,
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

async function syncDateRange(fromDate, toDate, empCode = "ALL", force = false) {
    const start = new Date(fromDate + "T00:00:00"),
        end = new Date(toDate + "T00:00:00");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const results = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (d > today) continue;
        const ds = dateStrOf(d);
        try {
            results.push(
                force ? await syncDayForce(ds, empCode) : await syncDay(ds, empCode),
            );
        } catch (e) {
            console.error(`[SYNC] ${ds} failed:`, e.message, e.stack);
            results.push({ dateStr: ds, error: e.message });
        }
    }
    const agg = results.reduce(
        (a, r) => ({
            fetched: a.fetched + (r.fetched || 0),
            matched: a.matched + (r.matched || 0),
            saved: a.saved + (r.employees || 0),
            skipped: a.skipped + (r.skipped ? 1 : 0),
            ghostCount: a.ghostCount + (r.ghostCount || 0),
            employees: Math.max(a.employees, r.employees || 0),
            unmatchedList: [...a.unmatchedList, ...(r.unmatchedList || [])],
        }),
        {
            fetched: 0,
            matched: 0,
            saved: 0,
            skipped: 0,
            ghostCount: 0,
            employees: 0,
            unmatchedList: [],
        },
    );
    const seen = new Set();
    agg.unmatchedList = agg.unmatchedList.filter((u) => {
        if (seen.has(u.biometricId)) return false;
        seen.add(u.biometricId);
        return true;
    });
    agg.unmatched = agg.unmatchedList.length;
    return agg;
}

async function syncDayForce(dateStr, empCode = "ALL") {
    const _nowIST = new Date(Date.now() + 330 * 60 * 1000);
    const todayStr = `${_nowIST.getUTCFullYear()}-${String(_nowIST.getUTCMonth() + 1).padStart(2, "0")}-${String(_nowIST.getUTCDate()).padStart(2, "0")}`;
    const isToday = dateStr === todayStr;
    const settings = await AttendanceSettings.getConfig();
    const existingDoc = await DailyAttendance.findOne({ dateStr }).lean();
    const rawPunches = await fetchPunches(dateStr, dateStr, empCode);
    const empMap = await buildEmployeeMap();
    const holidayMap = await loadHolidayMap(dateStr, dateStr);
    const yesterdayOt = await buildYesterdayOtMap(dateStr, settings);
    const dayOfWeek = new Date(dateStr + "T00:00:00").getDay();
    const restDayStatus = resolveRestDayStatus(dateStr, dayOfWeek, holidayMap);
    const grouped = new Map(),
        ghostInfo = new Map();
    const methodTally = {
        "biometric-exact": 0,
        "biometric-numeric": 0,
        "biometric-raw": 0,
        "name-exact": 0,
        "name-first-last": 0,
        "name-sorted": 0,
        ghost: 0,
    };
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
                const k1 = normalizeName(extractName(employee));
                const k2 = normalizeName(p.Name);
                if (k1 && k2 && k1 !== k2 && !k1.includes(k2) && !k2.includes(k1))
                    nameMismatches.push({
                        biometricId: keys.padded,
                        providerName: p.Name,
                        dbName: extractName(employee),
                    });
            }
        } else {
            employee = null;
            method = "ghost";
            groupKey = "G:" + keys.padded;
            isGhost = true;
            if (!ghostInfo.has(keys.padded))
                ghostInfo.set(keys.padded, { name: p.Name, empcode: p.Empcode });
        }
        methodTally[method]++;
        if (!grouped.has(groupKey))
            grouped.set(groupKey, {
                employee,
                isGhost,
                biometricId: keys.padded,
                providerName: p.Name,
                providerEmpcode: p.Empcode,
                method,
                punches: [],
            });
        grouped
            .get(groupKey)
            .punches.push({ time, mcid: p.mcid || null, mFlag: p.M_Flag || null });
    }
    const employees = [];
    const seenBids = new Set();
    for (const [, g] of grouped) {
        let employeeType,
            department,
            designation,
            employeeName,
            employeeDbId,
            identityId,
            numericId;
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
        const extraGrace = graceAppliesTo(employeeType, settings)
            ? yesterdayOt.get(g.biometricId) || 0
            : 0;
        const computed = computeDay(
            g.punches,
            employeeType,
            shift,
            settings,
            extraGrace,
            isToday,
        );
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
            lateDisplay: computed.lateDisplay || "",
            attendanceValue:
                computed.attendanceValue ??
                getAttendanceValue(computed.systemPrediction),
            missingPunchType: computed.missingPunchType || null,
            shiftStart: shift.start,
            shiftEnd: shift.end,
        });
        seenBids.add(g.biometricId);
    }
    if (restDayStatus) {
        for (const emp of empMap.employees) {
            const bid = extractBiometricId(emp);
            if (!bid) continue;
            const key = String(bid).toUpperCase();
            if (seenBids.has(key)) continue;
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
                rawPunches: [],
                punchCount: 0,
                inTime: null,
                lunchOut: null,
                lunchIn: null,
                teaOut: null,
                teaIn: null,
                finalOut: null,
                totalSpanMins: 0,
                lunchBreakMins: 0,
                teaBreakMins: 0,
                totalBreakMins: 0,
                netWorkMins: 0,
                otMins: 0,
                isLate: false,
                lateMins: 0,
                lateDisplay: "",
                isEarlyDeparture: false,
                earlyDepartureMins: 0,
                hasOT: false,
                hasMissPunch: false,
                missingPunchType: null,
                attendanceValue: 0,
                systemPrediction: restDayStatus,
                appliedExtraGraceMins: 0,
                shiftStart: shift.start,
                shiftEnd: shift.end,
            });
            seenBids.add(key);
        }
    }
    employees.sort((a, b) => {
        if (a.isGhost !== b.isGhost) return a.isGhost ? 1 : -1;
        return (a.employeeName || "").localeCompare(b.employeeName || "");
    });
    const unmatchedPunches = [...ghostInfo.entries()].map(([bid, info]) => ({
        biometricId: bid,
        empcode: info.empcode,
        name: info.name,
    }));
    const date = new Date(dateStr + "T00:00:00");
    const dayHoliday = holidayMap.get(dateStr) || null;
    const dayMeta = {
        dateStr,
        date,
        yearMonth: dateStr.slice(0, 7),
        dayOfWeek: date.getDay(),
        holiday: dayHoliday
            ? {
                name: dayHoliday.name,
                type: dayHoliday.type,
                statusCode: holidayTypeToStatus(dayHoliday.type),
            }
            : null,
        unmatchedPunches,
        syncSource: "etimeoffice",
    };
    await smartSaveDay(
        dateStr,
        employees,
        dayMeta,
        existingDoc,
        settings,
        isToday,
    );
    console.log(`[SYNC-FORCE] ${dateStr}: ${employees.length} rows`);
    try {
        await applyApprovedLeavesForDate(dateStr);
    } catch (e) {
        /* noop */
    }
    return {
        dateStr,
        fetched: rawPunches.length,
        matched: rawPunches.length,
        employees: employees.length,
        ghostCount: employees.filter((e) => e.isGhost).length,
        methodTally,
        nameMismatches,
        unmatchedList: unmatchedPunches,
        holiday: dayHoliday
            ? { date: dayHoliday.date, name: dayHoliday.name, type: dayHoliday.type }
            : null,
    };
}

async function syncTodayOnly() {
    const today = dateStrOf(new Date());
    console.log(`[HOURLY-SYNC] Starting sync for ${today}`);
    try {
        const result = await syncDay(today, "ALL");
        console.log(
            `[HOURLY-SYNC] Completed: ${result.employees} employees synced`,
        );
        return result;
    } catch (err) {
        console.error(`[HOURLY-SYNC] Failed for ${today}:`, err.message);
        return null;
    }
}

function startHourlyAttendanceSync() {
    cron.schedule(
        "5 * * * *",
        async () => {
            console.log(
                `[HOURLY-SYNC-CRON] Triggered at ${new Date().toISOString()}`,
            );
            await syncTodayOnly();
        },
        { timezone: "Asia/Kolkata", scheduled: true },
    );
    console.log(
        "[HOURLY-SYNC] ✅ Hourly attendance sync cron scheduled (runs at :05 past every hour IST)",
    );
    setTimeout(() => {
        syncTodayOnly().catch((e) =>
            console.error("[HOURLY-SYNC] Initial sync failed:", e.message),
        );
    }, 5000);
}

const LEAVE_TYPE_TO_STATUS = { CL: "L-CL", SL: "L-SL", PL: "L-EL" };
const LEAVE_STATUS_MAP = { "L-CL": "CL", "L-SL": "SL", "L-EL": "PL" };
function isLeaveStatus(status) {
    return !!LEAVE_STATUS_MAP[status];
}

// ═══════════════════════════════════════════════════════════════════════════
//  FIX 1: syncLeaveForOverride — null-safety guard + safe balance decrement
// ═══════════════════════════════════════════════════════════════════════════
async function syncLeaveForOverride({
    dateStr,
    biometricId,
    oldStatus,
    newStatus,
    hrRemarks,
    employeeDoc,
}) {
    const oldIsLeave = isLeaveStatus(oldStatus);
    const newIsLeave = isLeaveStatus(newStatus);
    if (!oldIsLeave && !newIsLeave) return;
    if (oldIsLeave && newIsLeave && oldStatus === newStatus) return;

    // ── FIX 1a: null-safety — cannot sync leave without a valid employee ──
    // Without this guard, empId=undefined causes LeaveBalance query to match nothing silently
    if (!employeeDoc || !employeeDoc._id) {
        console.error(
            `[LEAVE-SYNC] Cannot sync leave for ${biometricId} on ${dateStr}: employeeDoc not found in DB. Leave balance NOT updated.`,
        );
        return;
    }

    const year = parseInt(dateStr.split("-")[0], 10);
    const empId = employeeDoc._id;
    const bid = biometricId.toUpperCase();
    const empName =
        [employeeDoc?.firstName, employeeDoc?.middleName, employeeDoc?.lastName]
            .filter(Boolean)
            .join(" ")
            .trim() ||
        employeeDoc?.fullName ||
        employeeDoc?.name ||
        employeeDoc?.basicInfo?.fullName ||
        "Unknown";
    const dept =
        employeeDoc?.department ||
        employeeDoc?.workInfo?.department ||
        employeeDoc?.basicInfo?.department ||
        "—";
    const desig =
        employeeDoc?.designation ||
        employeeDoc?.workInfo?.designation ||
        employeeDoc?.basicInfo?.designation ||
        "—";

    let config;
    try {
        config = await getLeaveConfig().getConfig();
    } catch (_) {
        config = { clPerYear: 5, slPerYear: 5, plPerYear: 18 };
    }

    async function cancelAutoLeave(statusCode) {
        const leaveType = LEAVE_STATUS_MAP[statusCode];
        if (!leaveType) return;
        const existing = await getLeaveApplication().findOne({
            biometricId: bid,
            fromDate: dateStr,
            toDate: dateStr,
            leaveType,
            source: "hr_override",
            status: { $ne: "cancelled" },
        });
        if (existing) {
            existing.status = "cancelled";
            existing.hrRemarks = "Cancelled: HR changed status";
            existing.cancelledAt = new Date();
            await existing.save();
            // FIX 1b: Use save() instead of $inc to prevent going below zero
            const bal = await getLeaveBalance().findOne({ employeeId: empId, year });
            if (bal) {
                bal.consumed[leaveType] = Math.max(
                    0,
                    (bal.consumed[leaveType] || 0) - existing.totalDays,
                );
                await bal.save();
            }
            console.log(
                `[LEAVE-SYNC] Cancelled ${leaveType} for ${bid} on ${dateStr}, year=${year}`,
            );
        }
    }

    async function createAutoLeave(statusCode) {
        const leaveType = LEAVE_STATUS_MAP[statusCode];
        if (!leaveType) return;
        const already = await getLeaveApplication().findOne({
            biometricId: bid,
            fromDate: dateStr,
            toDate: dateStr,
            leaveType,
            source: "hr_override",
            status: { $ne: "cancelled" },
        });
        if (already) {
            console.log(
                `[LEAVE-SYNC] Already exists for ${bid} on ${dateStr} (${leaveType}), skipping`,
            );
            return;
        }
        await getLeaveApplication().create({
            employeeId: empId,
            biometricId: bid,
            employeeName: empName,
            designation: desig,
            department: dept,
            leaveType,
            applicationDate: dateStr,
            fromDate: dateStr,
            toDate: dateStr,
            totalDays: 1,
            reason: hrRemarks || `HR override: marked as ${statusCode}`,
            isHalfDay: false,
            status: "hr_approved",
            source: "hr_override",
            hrApprovedAt: new Date(),
            hrRemarks: hrRemarks || "Auto-created from attendance override",
            appliedToAttendance: true,
            appliedAt: new Date(),
        });
        // ── FIX: $setOnInsert+$inc on overlapping paths ('consumed' vs 'consumed.CL')
        // causes MongoDB to silently drop the $inc. Two-step instead:
        let bal = await getLeaveBalance().findOne({ employeeId: empId, year });
        if (!bal) {
            bal = await getLeaveBalance().create({
                employeeId: empId,
                biometricId: bid,
                year,
                entitlement: {
                    CL: config.clPerYear || 5,
                    SL: config.slPerYear || 5,
                    PL: config.plPerYear || 18,
                },
                consumed: { CL: 0, SL: 0, PL: 0 },
            });
        }
        bal.consumed[leaveType] = (bal.consumed[leaveType] || 0) + 1;
        await bal.save();
        console.log(
            `[LEAVE-SYNC] Created ${leaveType} for ${bid} on ${dateStr}, consumed.${leaveType}=${bal.consumed[leaveType]}, year=${year}`,
        );
    }

    if (oldIsLeave && !newIsLeave) await cancelAutoLeave(oldStatus);
    else if (oldIsLeave && newIsLeave) {
        await cancelAutoLeave(oldStatus);
        await createAutoLeave(newStatus);
    } else if (!oldIsLeave && newIsLeave) await createAutoLeave(newStatus);
}
async function applyLeaveToAttendance(leaveApp) {
    if (!leaveApp || leaveApp.status !== "hr_approved")
        return { applied: 0, skipped: 0 };
    const statusCode = LEAVE_TYPE_TO_STATUS[leaveApp.leaveType];
    if (!statusCode) {
        console.warn(
            `[LEAVE-APPLY] No mapping for leaveType=${leaveApp.leaveType}`,
        );
        return { applied: 0, skipped: 0 };
    }
    const bid = String(leaveApp.biometricId || "").toUpperCase();
    if (!bid) {
        console.warn(`[LEAVE-APPLY] No biometricId on leave ${leaveApp._id}`);
        return { applied: 0, skipped: 0 };
    }
    let applied = 0,
        skipped = 0,
        missingDays = 0;
    const start = new Date(leaveApp.fromDate + "T00:00:00"),
        end = new Date(leaveApp.toDate + "T00:00:00");
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const ds = dateStrOf(new Date(d));
        const dayDoc = await DailyAttendance.findOne({ dateStr: ds });
        if (!dayDoc) {
            missingDays++;
            continue;
        }
        const idx = (dayDoc.employees || []).findIndex(
            (e) => e.biometricId === bid,
        );
        if (idx === -1) {
            dayDoc.employees.push({
                employeeDbId: leaveApp.employeeId,
                biometricId: bid,
                employeeName: leaveApp.employeeName || "",
                department: leaveApp.department || "",
                designation: leaveApp.designation || "",
                employeeType: "executive",
                isGhost: false,
                matchMethod: "leave-injected",
                rawPunches: [],
                punchCount: 0,
                inTime: null,
                finalOut: null,
                netWorkMins: 0,
                otMins: 0,
                lateMins: 0,
                hasMissPunch: false,
                isLate: false,
                isEarlyDeparture: false,
                hasOT: false,
                totalSpanMins: 0,
                lunchBreakMins: 0,
                teaBreakMins: 0,
                totalBreakMins: 0,
                systemPrediction: "AB",
                hrFinalStatus: statusCode,
                hrRemarks: `Leave approved (${leaveApp.leaveType})`,
                hrReviewedAt: new Date(),
            });
            applied++;
        } else {
            const emp = dayDoc.employees[idx];
            if (["WO", "FH", "NH", "OH", "RH", "PH"].includes(emp.systemPrediction)) {
                console.log(
                    `[LEAVE-APPLY] ${bid} on ${ds}: skipped (rest day: ${emp.systemPrediction})`,
                );
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
    if (missingDays === 0) {
        leaveApp.appliedToAttendance = true;
        leaveApp.appliedAt = new Date();
        if (leaveApp.save) await leaveApp.save();
    }
    console.log(
        `[LEAVE-APPLY] ${bid} ${leaveApp.fromDate}→${leaveApp.toDate} (${leaveApp.leaveType}): applied=${applied}, skipped=${skipped}, missingDays=${missingDays}`,
    );
    return { applied, skipped, missingDays };
}

async function applyApprovedLeavesForDate(dateStr) {
    const apps = await getLeaveApplication()
        .find({
            status: "hr_approved",
            fromDate: { $lte: dateStr },
            toDate: { $gte: dateStr },
        })
        .lean();
    let appliedCount = 0;
    for (const app of apps) {
        const statusCode = LEAVE_TYPE_TO_STATUS[app.leaveType];
        if (!statusCode) continue;
        const bid = String(app.biometricId || "").toUpperCase();
        if (!bid) continue;
        const dayDoc = await DailyAttendance.findOne({ dateStr });
        if (!dayDoc) continue;
        const idx = (dayDoc.employees || []).findIndex(
            (e) => e.biometricId === bid,
        );
        if (idx === -1) {
            dayDoc.employees.push({
                employeeDbId: app.employeeId,
                biometricId: bid,
                employeeName: app.employeeName || "",
                department: app.department || "",
                designation: app.designation || "",
                employeeType: "executive",
                isGhost: false,
                matchMethod: "leave-injected",
                rawPunches: [],
                punchCount: 0,
                inTime: null,
                finalOut: null,
                netWorkMins: 0,
                otMins: 0,
                lateMins: 0,
                hasMissPunch: false,
                isLate: false,
                isEarlyDeparture: false,
                hasOT: false,
                totalSpanMins: 0,
                lunchBreakMins: 0,
                teaBreakMins: 0,
                totalBreakMins: 0,
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
        if (["WO", "FH", "NH", "OH", "RH", "PH"].includes(emp.systemPrediction))
            continue;
        if (emp.hrFinalStatus === statusCode) continue;
        emp.hrFinalStatus = statusCode;
        emp.hrRemarks = emp.hrRemarks || `Leave approved (${app.leaveType})`;
        emp.hrReviewedAt = new Date();
        dayDoc.markModified("employees");
        await dayDoc.save();
        appliedCount++;
    }
    if (appliedCount > 0)
        console.log(
            `[LEAVE-DATE-SYNC] ${dateStr}: applied ${appliedCount} leave(s)`,
        );
}

async function applyMonthlyLatePromotion(dayDoc, settings) {
    const policy = settings.lateHalfDayPolicy;
    if (!policy?.enabled) {
        return (dayDoc.employees || []).map((e) => ({
            ...e,
            cumulativeLateMins: e.lateMins || 0,
            wasPromotedToHalfDay: false,
            effectiveStatus: e.hrFinalStatus || e.systemPrediction,
        }));
    }
    const thresholds = policy.cumulativeLateMinsThreshold || {
        operator: 30,
        executive: 40,
    };
    const allDays = await DailyAttendance.find({
        yearMonth: dayDoc.yearMonth,
        dateStr: { $lte: dayDoc.dateStr },
    })
        .select(
            "dateStr employees.employeeDbId employees.biometricId employees.isLate employees.lateMins employees.employeeType",
        )
        .sort({ dateStr: 1 })
        .lean();
    const running = new Map(),
        todayResult = new Map();
    for (const d of allDays) {
        const isToday = d.dateStr === dayDoc.dateStr;
        for (const e of d.employees || []) {
            const key = e.employeeDbId?.toString() || e.biometricId;
            if (!key) continue;
            let cum = running.get(key) || 0,
                promoted = false;
            if (e.isLate && (e.lateMins || 0) > 0) {
                cum += e.lateMins;
                const threshold =
                    thresholds[e.employeeType] ?? thresholds.operator ?? 30;
                if (cum >= threshold) {
                    promoted = true;
                    cum = 0;
                }
            }
            running.set(key, cum);
            if (isToday)
                todayResult.set(key, {
                    cumulativeLateMins: cum,
                    wasPromoted: promoted,
                    thresholdForType:
                        thresholds[e.employeeType] ?? thresholds.operator ?? 30,
                });
        }
    }
    return (dayDoc.employees || []).map((e) => {
        const key = e.employeeDbId?.toString() || e.biometricId;
        const info = todayResult.get(key) || {
            cumulativeLateMins: e.lateMins || 0,
            wasPromoted: false,
        };
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

const recomputeSummary = (emps) =>
    buildSummary(
        emps.map((e) => ({
            ...e,
            systemPrediction: e.effectiveStatus || e.systemPrediction,
        })),
    );
function getDisplayLabel(rawStatus, settings) {
    return (settings?.displayLabels || {})[rawStatus] || rawStatus || "";
}

router.get("/debug", EmployeeAuthMiddlewear, async (req, res) => {
    const envStatus = {
        TEAMOFFICE_BASE_URL: !!process.env.TEAMOFFICE_BASE_URL,
        TEAMOFFICE_AUTH_TOKEN: !!process.env.TEAMOFFICE_AUTH_TOKEN,
        TEAMOFFICE_USERNAME: !!process.env.TEAMOFFICE_USERNAME,
        TEAMOFFICE_PASSWORD: !!process.env.TEAMOFFICE_PASSWORD,
        TEAMOFFICE_CORP_ID: !!process.env.TEAMOFFICE_CORP_ID,
    };
    let authOk = false,
        authError = null;
    try {
        getAuthHeader();
        authOk = true;
    } catch (e) {
        authError = e.message;
    }
    const totalEmployees = await Employee.countDocuments().catch(() => -1);
    const totalDays = await DailyAttendance.countDocuments().catch(() => -1);
    const sampleEmp = await Employee.findOne()
        .lean()
        .catch(() => null);
    const settings = await AttendanceSettings.getConfig().catch(() => null);
    let sampleBio = [],
        sampleNames = [];
    try {
        const empMap = await buildEmployeeMap();
        sampleBio = [...empMap.byBiometric.entries()]
            .slice(0, 30)
            .map(([k, e]) => ({
                key: k,
                name: extractName(e),
                dept: extractDepartment(e),
                designation: extractDesignation(e),
                resolvedType: resolveEmployeeType(e, settings),
            }));
        sampleNames = [...empMap.byName.entries()]
            .slice(0, 20)
            .map(([k, e]) => ({
                key: k,
                name: extractName(e),
                bid: extractBiometricId(e),
            }));
    } catch (e) {
        /* noop */
    }
    res.json({
        success: true,
        apiUrl: ETIME_BASE,
        envStatus,
        authOk,
        authError,
        totalEmployees,
        totalDays,
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
            employee: match
                ? {
                    _id: match.employee._id,
                    name: extractName(match.employee),
                    biometricId: extractBiometricId(match.employee),
                    empCode: extractIdentity(match.employee),
                    department: extractDepartment(match.employee),
                    designation: extractDesignation(match.employee),
                    resolvedType: resolveEmployeeType(match.employee, settings),
                }
                : null,
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post("/sync", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { fromDate, toDate, empCode = "ALL", force = false } = req.body;
        if (!fromDate || !toDate)
            return res
                .status(400)
                .json({ success: false, message: "fromDate and toDate required" });
        const agg = await syncDateRange(fromDate, toDate, empCode, force);
        res.json({
            success: true,
            message: `Synced ${agg.saved} employees (${agg.ghostCount} ghost, ${agg.skipped || 0} days skipped as complete)`,
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
        if (!date)
            return res.status(400).json({ success: false, message: "date required" });
        const dayDoc = await DailyAttendance.findOne({ dateStr: date }).lean();
        if (!dayDoc) {
            syncDay(date).catch((e) => console.warn("[BG-SYNC]", e.message));
            return res.json({
                success: true,
                data: [],
                count: 0,
                summary: null,
                unmatchedPunches: [],
                synced: false,
                message: "No data yet. Syncing in background — refresh in a moment.",
            });
        }
        const settings = await AttendanceSettings.getConfig();
        let employees = await applyMonthlyLatePromotion(dayDoc, settings);
        if (department && department !== "all")
            employees = employees.filter((e) => e.department === department);
        const summary = recomputeSummary(employees);
        employees = employees.map((e) => ({
            ...e,
            displayStatus: getDisplayLabel(
                e.effectiveStatus || e.systemPrediction,
                settings,
            ),
        }));
        res.json({
            success: true,
            data: employees,
            count: employees.length,
            summary,
            unmatchedPunches: dayDoc.unmatchedPunches || [],
            holiday: dayDoc.holiday || null,
            syncedAt: dayDoc.syncedAt,
            synced: true,
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
        res.json({
            success: true,
            data: [...new Set([...a, ...b, ...c].filter(Boolean))].sort(),
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get("/employee/:empId", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { empId } = req.params;
        const { yearMonth } = req.query;
        if (!yearMonth)
            return res
                .status(400)
                .json({ success: false, message: "yearMonth required" });
        const isObjectId = /^[0-9a-fA-F]{24}$/.test(empId);
        const match = isObjectId
            ? { "employees.employeeDbId": empId }
            : { "employees.biometricId": empId.toUpperCase() };
        const days = await DailyAttendance.find({ yearMonth, ...match })
            .sort({ dateStr: 1 })
            .lean();
        const history = days
            .map((d) => {
                const entry = (d.employees || []).find((e) =>
                    isObjectId
                        ? e.employeeDbId?.toString() === empId
                        : e.biometricId === empId.toUpperCase(),
                );
                if (!entry) return null;
                return {
                    dateStr: d.dateStr,
                    ...entry,
                    effectiveStatus: entry.hrFinalStatus || entry.systemPrediction,
                };
            })
            .filter(Boolean);
        res.json({
            success: true,
            yearMonth,
            data: history,
            count: history.length,
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get("/settings", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        res.json({ success: true, data: await AttendanceSettings.getConfig() });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

function buildSettingsChanges(oldCfg, body) {
    const changes = [];
    const diff = (label, oldVal, newVal) => {
        const o = String(oldVal ?? "—"),
            n = String(newVal ?? "—");
        if (o !== n) changes.push({ label, before: o, after: n });
    };
    const os = body.shifts?.operator;
    if (os) {
        const oo = oldCfg.shifts?.operator || {};
        diff("Operator shift start", oo.start, os.start);
        diff("Operator shift end", oo.end, os.end);
        diff("Operator late grace (mins)", oo.lateGraceMins, os.lateGraceMins);
        diff(
            "Operator half-day threshold (mins)",
            oo.halfDayThresholdMins,
            os.halfDayThresholdMins,
        );
        diff("Operator OT grace (mins)", oo.otGraceMins, os.otGraceMins);
    }
    const es = body.shifts?.executive;
    if (es) {
        const oe = oldCfg.shifts?.executive || {};
        diff("Executive shift start", oe.start, es.start);
        diff("Executive shift end", oe.end, es.end);
        diff("Executive late grace (mins)", oe.lateGraceMins, es.lateGraceMins);
        diff(
            "Executive half-day threshold (mins)",
            oe.halfDayThresholdMins,
            es.halfDayThresholdMins,
        );
        diff("Executive OT grace (mins)", oe.otGraceMins, es.otGraceMins);
    }
    const lhp = body.lateHalfDayPolicy;
    if (lhp) {
        const ol = oldCfg.lateHalfDayPolicy || {};
        if (lhp.enabled !== undefined && lhp.enabled !== ol.enabled)
            changes.push({
                label: "Auto late→HD policy",
                before: ol.enabled ? "Enabled" : "Disabled",
                after: lhp.enabled ? "Enabled" : "Disabled",
            });
        const thr = lhp.cumulativeLateMinsThreshold || {},
            oThr = ol.cumulativeLateMinsThreshold || {};
        if (thr.operator !== undefined)
            diff(
                "Operator cumulative late threshold (mins)",
                oThr.operator,
                thr.operator,
            );
        if (thr.executive !== undefined)
            diff(
                "Executive cumulative late threshold (mins)",
                oThr.executive,
                thr.executive,
            );
    }
    if (
        body.singlePunchHandling?.mode &&
        body.singlePunchHandling.mode !== oldCfg.singlePunchHandling?.mode
    )
        diff(
            "Single punch mode",
            oldCfg.singlePunchHandling?.mode,
            body.singlePunchHandling.mode,
        );
    const gcf = body.graceCarryForward;
    if (gcf) {
        const og = oldCfg.graceCarryForward || {};
        if (gcf.enabled !== undefined && gcf.enabled !== og.enabled)
            changes.push({
                label: "Grace carry-forward",
                before: og.enabled ? "Enabled" : "Disabled",
                after: gcf.enabled ? "Enabled" : "Disabled",
            });
        if (gcf.triggerMins !== undefined)
            diff(
                "Grace carry-forward trigger OT (mins)",
                og.triggerMins,
                gcf.triggerMins,
            );
        if (gcf.bonusGraceMins !== undefined)
            diff("Bonus grace minutes", og.bonusGraceMins, gcf.bonusGraceMins);
        if (gcf.applyTo !== undefined && gcf.applyTo !== og.applyTo)
            diff("Grace apply to", og.applyTo, gcf.applyTo);
    }
    if (body.departmentCategories) {
        const oldCore = (
            oldCfg.departmentCategories?.core ||
            oldCfg.operatorDepartments ||
            []
        ).length,
            newCore = (body.departmentCategories.core || []).length;
        if (newCore !== oldCore)
            diff("Operator departments count", oldCore, newCore);
        const oldGen = (oldCfg.departmentCategories?.general || []).length,
            newGen = (body.departmentCategories.general || []).length;
        if (newGen !== oldGen) diff("Executive departments count", oldGen, newGen);
    }
    if (body.operatorDesignations) {
        const olen = (oldCfg.operatorDesignations || []).length,
            nlen = body.operatorDesignations.length;
        if (nlen !== olen) diff("Operator designations count", olen, nlen);
    }
    if (body.executiveDesignations) {
        const olen = (oldCfg.executiveDesignations || []).length,
            nlen = body.executiveDesignations.length;
        if (nlen !== olen) diff("Executive designations count", olen, nlen);
    }
    if (body.displayLabels) {
        const ol = oldCfg.displayLabels || {};
        for (const [code, newLabel] of Object.entries(body.displayLabels)) {
            if (String(newLabel) !== String(ol[code] ?? ""))
                changes.push({
                    label: `Display label: ${code}`,
                    before: ol[code] || code,
                    after: newLabel || code,
                });
        }
    }
    return changes;
}

router.put("/settings", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const oldCfg = await AttendanceSettings.getConfig();
        const {
            shifts,
            lateHalfDayPolicy,
            operatorDepartments,
            departmentCategories,
            executiveDesignations,
            operatorDesignations,
            singlePunchHandling,
            graceCarryForward,
            displayLabels,
        } = req.body;
        const update = {};
        if (shifts) update.shifts = shifts;
        if (lateHalfDayPolicy) update.lateHalfDayPolicy = lateHalfDayPolicy;
        if (operatorDepartments)
            update.operatorDepartments = operatorDepartments.map((d) =>
                d.toUpperCase(),
            );
        if (departmentCategories)
            update.departmentCategories = {
                core: (departmentCategories.core || []).map((d) => d.toUpperCase()),
                general: (departmentCategories.general || []).map((d) =>
                    d.toUpperCase(),
                ),
            };
        if (executiveDesignations)
            update.executiveDesignations = executiveDesignations.map((d) =>
                d.toUpperCase(),
            );
        if (operatorDesignations)
            update.operatorDesignations = operatorDesignations.map((d) =>
                d.toUpperCase(),
            );
        if (singlePunchHandling) update.singlePunchHandling = singlePunchHandling;
        if (graceCarryForward) update.graceCarryForward = graceCarryForward;
        if (displayLabels) update.displayLabels = displayLabels;
        await AttendanceSettings.updateOne(
            { _id: "singleton" },
            { $set: update },
            { upsert: true },
        );
        const newCfg = await AttendanceSettings.getConfig();
        const changes = buildSettingsChanges(oldCfg, req.body);
        if (changes.length > 0) {
            const changedBy = req.user?.name || req.user?.email || "HR";
            emailService
                .sendAttendanceSettingsChangeToCEO(changedBy, changes)
                .catch((e) => console.warn("[SETTINGS-EMAIL]", e.message));
        }
        res.json({ success: true, data: newCfg });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get("/test-connection", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const today = dateStrOf(new Date());
        const punches = await fetchPunches(today, today);
        res.json({
            success: true,
            apiUrl: ETIME_BASE,
            todayPunches: punches.length,
            sample: punches[0] || null,
        });
    } catch (err) {
        res
            .status(500)
            .json({ success: false, message: err.message, apiUrl: ETIME_BASE });
    }
});

router.get("/summary", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { from, to, department } = req.query;
        if (!from || !to)
            return res
                .status(400)
                .json({ success: false, message: "from and to required" });
        const allActive = await Employee.find({
            $or: [
                { status: "active" },
                { status: { $exists: false } },
                { isActive: true },
            ],
        }).lean();
        const settings = await AttendanceSettings.getConfig();
        const thresholds = settings.lateHalfDayPolicy
            ?.cumulativeLateMinsThreshold || { operator: 30, executive: 40 };
        const filteredActive =
            department && department !== "all"
                ? allActive.filter((e) => extractDepartment(e) === department)
                : allActive;
        const days = await DailyAttendance.find({
            dateStr: { $gte: from, $lte: to },
        })
            .sort({ dateStr: 1 })
            .lean();
        const holidayMap = await loadHolidayMap(from, to);
        const syncedDates = new Set(days.map((d) => d.dateStr));
        const workingDates = workingDaysInRange(from, to);
        const unsyncedWorkingDates = workingDates.filter(
            (d) => !syncedDates.has(d),
        );
        const activeHolidays = [...holidayMap.values()]
            .filter((h) => h.type !== "working_sunday")
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((h) => ({
                date: h.date,
                name: h.name,
                type: h.type,
                description: h.description || "",
                statusCode: holidayTypeToStatus(h.type),
            }));
        const perEmp = new Map(),
            running = new Map();
        let lastYM = null;
        const agg = {
            from,
            to,
            workingDays: workingDates.length,
            syncedDays: days.length,
            unsyncedWorkingDays: unsyncedWorkingDates.length,
            unsyncedDates: unsyncedWorkingDates,
            totalPunches: 0,
            P: 0,
            "P*": 0,
            "P~": 0,
            HD: 0,
            AB: 0,
            MP: 0,
            WO: 0,
            PH: 0,
            FH: 0,
            NH: 0,
            OH: 0,
            RH: 0,
            effectivePresent: 0,
            totalLateMins: 0,
            totalOtMins: 0,
            totalNetWorkMins: 0,
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
                    P: 0,
                    "P*": 0,
                    "P~": 0,
                    HD: 0,
                    AB: 0,
                    MP: 0,
                    WO: 0,
                    PH: 0,
                    FH: 0,
                    NH: 0,
                    OH: 0,
                    RH: 0,
                    leaves: 0,
                },
                effectivePresent: 0,
                totalLateMins: 0,
                totalOtMins: 0,
                totalNetWorkMins: 0,
                autoHDs: 0,
                sundayWorked: 0,
                holidayWorked: 0,
                totalAttendance: 0,
            });
        }
        for (const d of days) {
            if (d.yearMonth !== lastYM) {
                running.clear();
                lastYM = d.yearMonth;
            }
            const dt = new Date(d.dateStr + "T00:00:00"),
                isSunday = dt.getDay() === 0;
            const hol = holidayMap.get(d.dateStr),
                isDeclaredHoliday = !!hol && hol.type !== "working_sunday";
            for (const e of d.employees || []) {
                if (department && department !== "all" && e.department !== department)
                    continue;
                const key = e.biometricId;
                if (!perEmp.has(key))
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
                            P: 0,
                            "P*": 0,
                            "P~": 0,
                            HD: 0,
                            AB: 0,
                            MP: 0,
                            WO: 0,
                            PH: 0,
                            FH: 0,
                            NH: 0,
                            OH: 0,
                            RH: 0,
                            leaves: 0,
                        },
                        effectivePresent: 0,
                        totalLateMins: 0,
                        totalOtMins: 0,
                        totalNetWorkMins: 0,
                        autoHDs: 0,
                        sundayWorked: 0,
                        holidayWorked: 0,
                        totalAttendance: 0,
                    });
                const b = perEmp.get(key);
                b.recordedDays++;
                if (!isSunday) b.recordedWorkingDays++;
                if (isSunday && !isDeclaredHoliday && (e.punchCount || 0) > 0) {
                    b.sundayWorked++;
                    agg.sundayWorkedCount++;
                }
                if (isDeclaredHoliday && (e.punchCount || 0) > 0) {
                    b.holidayWorked++;
                    agg.holidayWorkedCount++;
                }
                let cum = running.get(key) || 0,
                    status = e.systemPrediction,
                    promoted = false;
                if (
                    settings.lateHalfDayPolicy?.enabled &&
                    e.isLate &&
                    (e.lateMins || 0) > 0
                ) {
                    cum += e.lateMins;
                    const thr = thresholds[e.employeeType] ?? thresholds.operator ?? 30;
                    if (cum >= thr) {
                        status = "HD";
                        promoted = true;
                        cum = 0;
                    }
                }
                running.set(key, cum);
                const final = e.hrFinalStatus || status;
                if (b.days[final] !== undefined) b.days[final]++;
                if (["L-CL", "L-SL", "L-EL", "LWP", "WFH", "CO"].includes(final))
                    b.days.leaves++;
                if (agg[final] !== undefined) agg[final]++;
                if (isEffectivelyPresent({ ...e, systemPrediction: final })) {
                    b.effectivePresent++;
                    agg.effectivePresent++;
                }
                const paidCodes = [
                    "P",
                    "P*",
                    "P~",
                    "HD",
                    "MP",
                    "WO",
                    "FH",
                    "NH",
                    "OH",
                    "RH",
                    "PH",
                    "L-CL",
                    "L-SL",
                    "L-EL",
                    "WFH",
                    "CO",
                ];
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
            const missing = Math.max(
                0,
                workingSyncedDates.length - b.recordedWorkingDays,
            );
            if (missing > 0) {
                b.days.AB += missing;
                agg.AB += missing;
            }
        }
        const employees = [...perEmp.values()].sort((a, b) =>
            (a.employeeName || "").localeCompare(b.employeeName || ""),
        );
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

router.get("/employee-detail", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { biometricId, from, to } = req.query;
        if (!biometricId || !from || !to)
            return res
                .status(400)
                .json({ success: false, message: "biometricId, from, to required" });
        const bid = String(biometricId).toUpperCase();
        const settings = await AttendanceSettings.getConfig();
        const thresholds = settings.lateHalfDayPolicy
            ?.cumulativeLateMinsThreshold || { operator: 30, executive: 40 };
        const days = await DailyAttendance.find({
            dateStr: { $gte: from, $lte: to },
        })
            .sort({ dateStr: 1 })
            .lean();
        const holidayMap = await loadHolidayMap(from, to);
        const start = new Date(from + "T00:00:00"),
            end = new Date(to + "T00:00:00");
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const calendar = [];
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            if (d > today) continue;
            const ds = dateStrOf(new Date(d)),
                dow = d.getDay(),
                hol = holidayMap.get(ds);
            calendar.push({
                dateStr: ds,
                dayName: new Date(d).toLocaleDateString("en-IN", { weekday: "short" }),
                dayNum: d.getDate(),
                isSunday: dow === 0,
                restStatus: resolveRestDayStatus(ds, dow, holidayMap),
                holiday: hol || null,
                isHoliday: !!hol && hol.type !== "working_sunday",
                holidayName: hol && hol.type !== "working_sunday" ? hol.name : null,
                holidayType: hol && hol.type !== "working_sunday" ? hol.type : null,
            });
        }
        const byDate = new Map(days.map((d) => [d.dateStr, d]));
        const running = new Map();
        let lastYM = null,
            empMeta = null;
        const rows = [],
            stats = {
                P: 0,
                "P*": 0,
                "P~": 0,
                HD: 0,
                AB: 0,
                MP: 0,
                WO: 0,
                PH: 0,
                FH: 0,
                NH: 0,
                OH: 0,
                RH: 0,
                "L-CL": 0,
                "L-SL": 0,
                "L-EL": 0,
                LWP: 0,
                WFH: 0,
                CO: 0,
                leaves: 0,
                unsynced: 0,
                effectivePresent: 0,
                totalLateMins: 0,
                totalOtMins: 0,
                totalNetWorkMins: 0,
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
                    rows.push({
                        ...cal,
                        status: "UNSYNCED",
                        label: "Not synced",
                        synced: false,
                    });
                    stats.unsynced++;
                }
                continue;
            }
            const entry = (dayDoc.employees || []).find((e) => e.biometricId === bid);
            if (!entry) {
                const s = cal.restStatus || "AB";
                rows.push({
                    ...cal,
                    status: s,
                    label: getDisplayLabel(s, settings),
                    synced: true,
                });
                if (stats[s] !== undefined) stats[s]++;
                if (s !== "AB") stats.totalAttendance++;
                continue;
            }
            if (dayDoc.yearMonth !== lastYM) {
                running.clear();
                lastYM = dayDoc.yearMonth;
            }
            if (!empMeta)
                empMeta = {
                    employeeName: entry.employeeName,
                    department: entry.department,
                    designation: entry.designation,
                    employeeType: entry.employeeType,
                    identityId: entry.identityId,
                    biometricId: entry.biometricId,
                    isGhost: !!entry.isGhost,
                };
            let cum = running.get(bid) || 0,
                status = entry.systemPrediction,
                promoted = false;
            if (
                settings.lateHalfDayPolicy?.enabled &&
                entry.isLate &&
                (entry.lateMins || 0) > 0
            ) {
                cum += entry.lateMins;
                const thr = thresholds[entry.employeeType] ?? thresholds.operator ?? 30;
                if (cum >= thr) {
                    status = "HD";
                    promoted = true;
                    cum = 0;
                }
            }
            running.set(bid, cum);
            const finalStatus = entry.hrFinalStatus || status;
            if (isEffectivelyPresent({ ...entry, systemPrediction: finalStatus }))
                stats.effectivePresent++;
            if (stats[finalStatus] !== undefined) stats[finalStatus]++;
            if (["L-CL", "L-SL", "L-EL", "LWP", "WFH", "CO"].includes(finalStatus))
                stats.leaves++;
            const paidCodes = [
                "P",
                "P*",
                "P~",
                "HD",
                "MP",
                "WO",
                "FH",
                "NH",
                "OH",
                "RH",
                "PH",
                "L-CL",
                "L-SL",
                "L-EL",
                "WFH",
                "CO",
            ];
            if (paidCodes.includes(finalStatus)) stats.totalAttendance++;
            stats.totalLateMins += entry.lateMins || 0;
            stats.totalOtMins += entry.otMins || 0;
            stats.totalNetWorkMins += entry.netWorkMins || 0;
            const punched = (entry.punchCount || 0) > 0,
                isSundayWorked = cal.isSunday && !cal.isHoliday && punched,
                punchedOnHoliday = cal.isHoliday && punched;
            if (isSundayWorked) stats.sundayWorked++;
            if (punchedOnHoliday) stats.holidayWorked++;
            rows.push({
                ...cal,
                status: finalStatus,
                label: getDisplayLabel(finalStatus, settings),
                synced: true,
                isSundayWorked,
                punchedOnHoliday,
                inTime: entry.inTime,
                lunchOut: entry.lunchOut,
                lunchIn: entry.lunchIn,
                teaOut: entry.teaOut,
                teaIn: entry.teaIn,
                finalOut: entry.finalOut,
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
            from,
            to,
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

router.post("/sync-period", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { from, to, onlyMissing = false, force = false } = req.body;
        if (!from || !to)
            return res
                .status(400)
                .json({ success: false, message: "from and to required" });
        const todayStr = dateStrOf(new Date());
        const actualTo = to > todayStr ? todayStr : to;
        let datesToSync;
        if (onlyMissing) {
            const existing = await DailyAttendance.find({
                dateStr: { $gte: from, $lte: actualTo },
            })
                .select("dateStr")
                .lean();
            const have = new Set(existing.map((d) => d.dateStr));
            datesToSync = allDaysInRange(from, actualTo).filter((d) => !have.has(d));
        } else {
            datesToSync = allDaysInRange(from, actualTo);
        }
        console.log(
            `[SYNC-PERIOD] ${from}..${actualTo} → ${datesToSync.length} days (onlyMissing=${onlyMissing} force=${force})`,
        );
        const results = [];
        for (const dateStr of datesToSync) {
            try {
                results.push(
                    force ? await syncDayForce(dateStr) : await syncDay(dateStr),
                );
            } catch (e) {
                console.error(`[SYNC-PERIOD] ${dateStr} failed:`, e.message, e.stack);
                results.push({ dateStr, error: e.message });
            }
        }
        const aggregate = results.reduce(
            (a, r) => ({
                daysSynced: a.daysSynced + (r.error ? 0 : 1),
                daysFailed: a.daysFailed + (r.error ? 1 : 0),
                daysSkipped: a.daysSkipped + (r.skipped ? 1 : 0),
                totalFetched: a.totalFetched + (r.fetched || 0),
                totalEmployees: Math.max(a.totalEmployees, r.employees || 0),
                totalGhosts: a.totalGhosts + (r.ghostCount || 0),
            }),
            {
                daysSynced: 0,
                daysFailed: 0,
                daysSkipped: 0,
                totalFetched: 0,
                totalEmployees: 0,
                totalGhosts: 0,
            },
        );
        res.json({
            success: true,
            message: `Synced ${aggregate.daysSynced}/${datesToSync.length} days (${aggregate.daysSkipped} skipped as complete)`,
            range: { from, to: actualTo },
            ...aggregate,
            details: results,
        });
    } catch (err) {
        console.error("[SYNC-PERIOD]", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

router.put("/day-override", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const {
            dateStr,
            biometricId,
            hrFinalStatus,
            hrRemarks,
            inTime,
            finalOut,
            lunchOut,
            lunchIn,
            teaOut,
            teaIn,
        } = req.body;
        if (!dateStr || !biometricId)
            return res
                .status(400)
                .json({ success: false, message: "dateStr and biometricId required" });
        const validStatuses = [
            "P",
            "P*",
            "P~",
            "HD",
            "AB",
            "WO",
            "PH",
            "FH",
            "NH",
            "OH",
            "RH",
            "L-CL",
            "L-SL",
            "L-EL",
            "LWP",
            "MP",
            "WFH",
            "CO",
            null,
            "",
        ];
        if (hrFinalStatus !== undefined && !validStatuses.includes(hrFinalStatus))
            return res
                .status(400)
                .json({
                    success: false,
                    message: `Invalid status. Allowed: ${validStatuses.filter(Boolean).join(", ")}`,
                });
        const bid = biometricId.toUpperCase();
        let dayDoc = await DailyAttendance.findOne({
            dateStr,
            "employees.biometricId": bid,
        });
        if (!dayDoc) {
            const existingDay = await DailyAttendance.findOne({ dateStr });
            const empRecord = await Employee.findOne({
                $or: [
                    { biometricId: bid },
                    { "basicInfo.biometricId": bid },
                    { "workInfo.biometricId": bid },
                ],
            }).lean();
            const settings2 = await AttendanceSettings.getConfig();
            const empType2 = resolveEmployeeType(empRecord, settings2);
            const shift2 = settings2.shifts?.[empType2] ||
                settings2.shifts?.executive || { start: "09:30", end: "18:30" };
            const newEntry = {
                biometricId: bid,
                employeeDbId: empRecord?._id || null,
                identityId: extractIdentity(empRecord) || "",
                employeeName: extractName(empRecord, bid),
                department: extractDepartment(empRecord),
                designation: extractDesignation(empRecord),
                employeeType: empType2,
                shiftStart: shift2.start || "09:30",
                shiftEnd: shift2.end || "18:30",
                systemPrediction: "AB",
                hrFinalStatus: null,
                rawPunches: [],
                punchCount: 0,
                netWorkMins: 0,
                totalBreakMins: 0,
                totalSpanMins: 0,
                otMins: 0,
                lateMins: 0,
                lateDisplay: "",
                isLate: false,
                isEarlyDeparture: false,
                hasOT: false,
                hasMissPunch: false,
                attendanceValue: 0,
            };
            if (existingDay) {
                existingDay.employees.push(newEntry);
                await existingDay.save();
                dayDoc = await DailyAttendance.findOne({
                    dateStr,
                    "employees.biometricId": bid,
                });
            } else {
                const [y2, m2, d2] = dateStr.split("-").map(Number);
                await DailyAttendance.create({
                    dateStr,
                    date: new Date(Date.UTC(y2, m2 - 1, d2)),
                    yearMonth: dateStr.slice(0, 7),
                    employees: [newEntry],
                });
                dayDoc = await DailyAttendance.findOne({
                    dateStr,
                    "employees.biometricId": bid,
                });
            }
        }
        const empIdx = dayDoc.employees.findIndex((e) => e.biometricId === bid);
        if (empIdx === -1)
            return res
                .status(500)
                .json({
                    success: false,
                    message: "Failed to locate employee entry after upsert",
                });
        const emp = dayDoc.employees[empIdx];
        const oldStatus = emp.hrFinalStatus || emp.systemPrediction;
        if (hrFinalStatus !== undefined) emp.hrFinalStatus = hrFinalStatus || null;
        if (hrRemarks !== undefined) emp.hrRemarks = hrRemarks || null;
        emp.hrReviewedAt = new Date();
        const punchFields = { inTime, finalOut, lunchOut, lunchIn, teaOut, teaIn };
        const punchChanges = [];
        let anyTimeUpdated = false;
        for (const [field, value] of Object.entries(punchFields)) {
            if (value === undefined) continue;
            anyTimeUpdated = true;
            const oldVal = emp[field] ? fmtTimeIST12(emp[field]) : "—";
            const newDate = value ? parseTimeOnDateIST(value, dateStr) : null;
            emp[field] = newDate;
            punchChanges.push({
                punchType: field,
                action:
                    !emp[field] && value
                        ? "add"
                        : emp[field] && !value
                            ? "remove"
                            : "modify",
                oldTime: oldVal,
                newTime: newDate ? fmtTimeIST12(newDate) : "removed",
            });
            const punchTypeMap = {
                inTime: "in",
                finalOut: "out",
                lunchOut: "lunch_out",
                lunchIn: "lunch_in",
                teaOut: "tea_out",
                teaIn: "tea_in",
            };
            const pt = punchTypeMap[field];
            if (pt) {
                const existingIdx = (emp.rawPunches || []).findIndex(
                    (p) => p.punchType === pt,
                );
                if (newDate) {
                    const manualPunch = {
                        time: newDate,
                        punchType: pt,
                        source: "manual",
                        addedBy: req.user?.name || req.user?.id || "HR",
                        addedAt: new Date(),
                    };
                    if (existingIdx >= 0)
                        emp.rawPunches[existingIdx] = {
                            ...emp.rawPunches[existingIdx],
                            ...manualPunch,
                        };
                    else emp.rawPunches = [...(emp.rawPunches || []), manualPunch];
                } else if (existingIdx >= 0) {
                    emp.rawPunches.splice(existingIdx, 1);
                }
                emp.punchCount = (emp.rawPunches || []).length;
            }
        }
        if (anyTimeUpdated) {
            const settings = await AttendanceSettings.getConfig();
            const shift =
                settings.shifts[emp.employeeType] || settings.shifts.executive;
            const shiftStart = hhmmMins(shift.start),
                shiftEnd = hhmmMins(shift.end);
            const inMins = minsOf(emp.inTime),
                outMins = minsOf(emp.finalOut);
            const totalSpanMins =
                emp.inTime && emp.finalOut
                    ? Math.round((emp.finalOut - emp.inTime) / 60000)
                    : 0;
            const lunchBreakMins =
                emp.lunchOut && emp.lunchIn
                    ? Math.max(0, Math.round((emp.lunchIn - emp.lunchOut) / 60000))
                    : 0;
            const teaBreakMins =
                emp.teaOut && emp.teaIn
                    ? Math.max(0, Math.round((emp.teaIn - emp.teaOut) / 60000))
                    : 0;
            const totalBreakMins = lunchBreakMins + teaBreakMins,
                netWorkMins = Math.max(0, totalSpanMins - totalBreakMins);
            const effectiveGrace =
                (shift.lateGraceMins || 0) + (emp.appliedExtraGraceMins || 0);
            const lateMins =
                inMins != null
                    ? Math.max(0, inMins - (shiftStart + effectiveGrace))
                    : 0;
            const earlyDepartureMins =
                outMins != null ? Math.max(0, shiftEnd - outMins) : 0;
            let otMins = 0;
            if (emp.employeeType === "operator" && outMins != null) {
                const over = outMins - shiftEnd - (shift.otGraceMins || 0);
                if (over > 0) otMins = over;
            }
            emp.totalSpanMins = totalSpanMins;
            emp.lunchBreakMins = lunchBreakMins;
            emp.teaBreakMins = teaBreakMins;
            emp.totalBreakMins = totalBreakMins;
            emp.netWorkMins = netWorkMins;
            emp.lateMins = lateMins;
            emp.lateDisplay = fmtLateMins(lateMins);
            emp.isLate = lateMins > 0;
            emp.earlyDepartureMins = earlyDepartureMins;
            emp.isEarlyDeparture = earlyDepartureMins > 0;
            emp.otMins = otMins;
            emp.hasOT = otMins > 0;
            emp.hasMissPunch = !(emp.inTime && emp.finalOut);
            if (!emp.hrFinalStatus) {
                if (!emp.inTime) emp.systemPrediction = "AB";
                else if (!emp.finalOut) emp.systemPrediction = "MP";
                else if (netWorkMins < (shift.halfDayThresholdMins || 240))
                    emp.systemPrediction = "HD";
                else if (lateMins > 0) emp.systemPrediction = "P*";
                else if (earlyDepartureMins > 0) emp.systemPrediction = "P~";
                else emp.systemPrediction = "P";
            }
            const effectiveStatus = emp.hrFinalStatus || emp.systemPrediction;
            emp.attendanceValue = getAttendanceValue(effectiveStatus);
        }
        dayDoc.markModified("employees");
        await dayDoc.save();
        const newEffective = emp.hrFinalStatus || emp.systemPrediction;
        try {
            const employeeDoc = await Employee.findOne({
                $or: [
                    { biometricId: bid },
                    { "basicInfo.biometricId": bid },
                    { "workInfo.biometricId": bid },
                ],
            }).lean();
            await syncLeaveForOverride({
                dateStr,
                biometricId: bid,
                oldStatus: oldStatus,
                newStatus: newEffective,
                hrRemarks: hrRemarks || "",
                employeeDoc,
            });
        } catch (leaveErr) {
            console.error("[DAY-OVERRIDE] Leave sync error:", leaveErr.message);
        }
        res.json({
            success: true,
            message: "Override saved",
            data: dayDoc.employees[empIdx],
        });
    } catch (err) {
        console.error("[OVERRIDE]", err.message, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post("/punch-correction", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { dateStr, biometricId, punchType, action, punchTime, hrRemarks } =
            req.body;
        if (!dateStr || !biometricId || !punchType || !action)
            return res
                .status(400)
                .json({
                    success: false,
                    message: "dateStr, biometricId, punchType and action are required",
                });
        const VALID_PUNCH_TYPES = [
            "in",
            "lunch_out",
            "lunch_in",
            "tea_out",
            "tea_in",
            "out",
        ];
        const VALID_ACTIONS = ["add", "remove", "modify"];
        if (!VALID_PUNCH_TYPES.includes(punchType))
            return res
                .status(400)
                .json({
                    success: false,
                    message: `punchType must be one of: ${VALID_PUNCH_TYPES.join(", ")}`,
                });
        if (!VALID_ACTIONS.includes(action))
            return res
                .status(400)
                .json({
                    success: false,
                    message: `action must be one of: ${VALID_ACTIONS.join(", ")}`,
                });
        if ((action === "add" || action === "modify") && !punchTime)
            return res
                .status(400)
                .json({
                    success: false,
                    message: "punchTime (HH:MM) is required for add/modify",
                });
        const bid = biometricId.toUpperCase();
        const dayDoc = await DailyAttendance.findOne({
            dateStr,
            "employees.biometricId": bid,
        });
        if (!dayDoc)
            return res
                .status(404)
                .json({
                    success: false,
                    message: `No record for ${biometricId} on ${dateStr}`,
                });
        const empIdx = dayDoc.employees.findIndex((e) => e.biometricId === bid);
        if (empIdx === -1)
            return res
                .status(404)
                .json({
                    success: false,
                    message: `Employee ${biometricId} not in day doc`,
                });
        const emp = dayDoc.employees[empIdx];
        const oldStatus = emp.hrFinalStatus || emp.systemPrediction;
        const punchFieldMap = {
            in: "inTime",
            lunch_out: "lunchOut",
            lunch_in: "lunchIn",
            tea_out: "teaOut",
            tea_in: "teaIn",
            out: "finalOut",
        };
        const fieldName = punchFieldMap[punchType];
        const oldTime = emp[fieldName] ? fmtTimeIST12(emp[fieldName]) : null;
        if (action === "remove") {
            emp[fieldName] = null;
            emp.rawPunches = (emp.rawPunches || []).filter(
                (p) => p.punchType !== punchType,
            );
        } else {
            const newDate = parseTimeOnDateIST(punchTime, dateStr);
            emp[fieldName] = newDate;
            const existingIdx = (emp.rawPunches || []).findIndex(
                (p) => p.punchType === punchType,
            );
            const punchEntry = {
                time: newDate,
                punchType,
                source: "manual",
                addedBy: req.user?.name || req.user?.id || "HR",
                addedAt: new Date(),
            };
            if (existingIdx >= 0)
                emp.rawPunches[existingIdx] = {
                    ...emp.rawPunches[existingIdx],
                    ...punchEntry,
                };
            else emp.rawPunches = [...(emp.rawPunches || []), punchEntry];
        }
        emp.punchCount = (emp.rawPunches || []).length;
        emp.rawPunches = (emp.rawPunches || [])
            .filter((p) => p.time)
            .sort((a, b) => new Date(a.time) - new Date(b.time))
            .map((p, i) => ({ ...p, seq: i + 1 }));
        const settings = await AttendanceSettings.getConfig();
        const shift =
            settings.shifts[emp.employeeType] || settings.shifts.executive;
        const shiftStart = hhmmMins(shift.start),
            shiftEnd = hhmmMins(shift.end);
        const inMins = minsOf(emp.inTime),
            outMins = minsOf(emp.finalOut);
        const totalSpanMins =
            emp.inTime && emp.finalOut
                ? Math.round((emp.finalOut - emp.inTime) / 60000)
                : 0;
        const lunchBreakMins =
            emp.lunchOut && emp.lunchIn
                ? Math.max(0, Math.round((emp.lunchIn - emp.lunchOut) / 60000))
                : 0;
        const teaBreakMins =
            emp.teaOut && emp.teaIn
                ? Math.max(0, Math.round((emp.teaIn - emp.teaOut) / 60000))
                : 0;
        const totalBreakMins = lunchBreakMins + teaBreakMins,
            netWorkMins = Math.max(0, totalSpanMins - totalBreakMins);
        const effectiveGrace =
            (shift.lateGraceMins || 0) + (emp.appliedExtraGraceMins || 0);
        const lateMins =
            inMins != null ? Math.max(0, inMins - (shiftStart + effectiveGrace)) : 0;
        const earlyDepartureMins =
            outMins != null ? Math.max(0, shiftEnd - outMins) : 0;
        let otMins = 0;
        if (emp.employeeType === "operator" && outMins != null) {
            const over = outMins - shiftEnd - (shift.otGraceMins || 0);
            if (over > 0) otMins = over;
        }
        emp.totalSpanMins = totalSpanMins;
        emp.lunchBreakMins = lunchBreakMins;
        emp.teaBreakMins = teaBreakMins;
        emp.totalBreakMins = totalBreakMins;
        emp.netWorkMins = netWorkMins;
        emp.lateMins = lateMins;
        emp.lateDisplay = fmtLateMins(lateMins);
        emp.isLate = lateMins > 0;
        emp.earlyDepartureMins = earlyDepartureMins;
        emp.isEarlyDeparture = earlyDepartureMins > 0;
        emp.otMins = otMins;
        emp.hasOT = otMins > 0;
        emp.hasMissPunch = !(emp.inTime && emp.finalOut);
        if (!emp.hrFinalStatus) {
            if (!emp.inTime) emp.systemPrediction = "AB";
            else if (!emp.finalOut) emp.systemPrediction = "MP";
            else if (netWorkMins < (shift.halfDayThresholdMins || 240))
                emp.systemPrediction = "HD";
            else if (lateMins > 0) emp.systemPrediction = "P*";
            else if (earlyDepartureMins > 0) emp.systemPrediction = "P~";
            else emp.systemPrediction = "P";
        }
        emp.attendanceValue = getAttendanceValue(
            emp.hrFinalStatus || emp.systemPrediction,
        );
        if (hrRemarks) {
            emp.hrRemarks = hrRemarks;
        }
        emp.hrReviewedAt = new Date();
        dayDoc.markModified("employees");
        await dayDoc.save();
        res.json({
            success: true,
            message: `Punch ${action} applied for ${punchType}`,
            data: dayDoc.employees[empIdx],
        });
    } catch (err) {
        console.error("[PUNCH-CORRECTION]", err.message, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
});

router.put("/bulk-day-override", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { dateStr, updates } = req.body;
        if (!dateStr || !Array.isArray(updates) || !updates.length)
            return res
                .status(400)
                .json({ success: false, message: "dateStr and updates[] required" });
        let ok = 0,
            fail = 0;
        for (const u of updates) {
            const set = { "employees.$.hrReviewedAt": new Date() };
            if (u.hrFinalStatus !== undefined)
                set["employees.$.hrFinalStatus"] = u.hrFinalStatus || null;
            if (u.hrRemarks !== undefined)
                set["employees.$.hrRemarks"] = u.hrRemarks || null;
            const r = await DailyAttendance.updateOne(
                {
                    dateStr,
                    "employees.biometricId": String(u.biometricId).toUpperCase(),
                },
                { $set: set },
            );
            if (r.matchedCount > 0) ok++;
            else fail++;
        }
        res.json({ success: true, updated: ok, failed: fail });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.delete(
    "/remove-from-month",
    EmployeeAuthMiddlewear,
    async (req, res) => {
        try {
            const { biometricId, yearMonth } = req.query;
            if (!biometricId || !yearMonth)
                return res
                    .status(400)
                    .json({
                        success: false,
                        message: "biometricId and yearMonth required",
                    });
            if (!/^\d{4}-\d{2}$/.test(yearMonth))
                return res
                    .status(400)
                    .json({ success: false, message: "yearMonth must be YYYY-MM" });
            const bid = String(biometricId).toUpperCase();
            const result = await DailyAttendance.updateMany(
                { yearMonth, "employees.biometricId": bid },
                { $pull: { employees: { biometricId: bid } } },
            );
            res.json({
                success: true,
                message: `Removed ${bid} from ${result.modifiedCount} day(s) in ${yearMonth}`,
                daysModified: result.modifiedCount,
            });
        } catch (err) {
            console.error("[REMOVE-FROM-MONTH]", err.message);
            res.status(500).json({ success: false, message: err.message });
        }
    },
);

router.get("/muster-roll", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { yearMonth, department } = req.query;
        if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth))
            return res
                .status(400)
                .json({ success: false, message: "yearMonth (YYYY-MM) required" });
        const [yr, mo] = yearMonth.split("-").map(Number);
        const from = `${yearMonth}-01`,
            lastDay = new Date(yr, mo, 0).getDate(),
            to = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;
        const settings = await AttendanceSettings.getConfig();
        const thresholds = settings.lateHalfDayPolicy
            ?.cumulativeLateMinsThreshold || { operator: 30, executive: 40 };
        const holidayMap = await loadHolidayMap(from, to);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const allDays = [];
        for (let d = 1; d <= lastDay; d++) {
            const dateStr = `${yearMonth}-${String(d).padStart(2, "0")}`,
                dt = new Date(dateStr + "T00:00:00"),
                dow = dt.getDay();
            const hol = holidayMap.get(dateStr),
                isDeclaredHoliday = !!hol && hol.type !== "working_sunday",
                isWorkingSunday = !!hol && hol.type === "working_sunday";
            allDays.push({
                day: d,
                dateStr,
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
            $or: [
                { status: "active" },
                { status: { $exists: false } },
                { isActive: true },
            ],
        }).lean();
        const filteredActive =
            department && department !== "all"
                ? allActive.filter((e) => extractDepartment(e) === department)
                : allActive;
        const dayDocs = await DailyAttendance.find({ yearMonth })
            .sort({ dateStr: 1 })
            .lean();
        const byDate = new Map(dayDocs.map((d) => [d.dateStr, d]));
        const employees = [],
            running = new Map();
        const PAID_CODES = [
            "P",
            "P*",
            "P~",
            "HD",
            "MP",
            "WO",
            "FH",
            "NH",
            "OH",
            "RH",
            "PH",
            "L-CL",
            "L-SL",
            "L-EL",
            "WFH",
            "CO",
        ];
        for (const emp of filteredActive) {
            const bid = extractBiometricId(emp);
            if (!bid) continue;
            const key = String(bid).toUpperCase(),
                empType = resolveEmployeeType(emp, settings);
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
                    P: 0,
                    "P*": 0,
                    "P~": 0,
                    HD: 0,
                    AB: 0,
                    MP: 0,
                    WO: 0,
                    PH: 0,
                    FH: 0,
                    NH: 0,
                    OH: 0,
                    RH: 0,
                    leaves: 0,
                    effectivePresent: 0,
                    totalLateMins: 0,
                    totalOtMins: 0,
                    totalNetWorkMins: 0,
                    autoPromotedHDs: 0,
                    sundayWorked: 0,
                    holidayWorked: 0,
                    totalAttendance: 0,
                },
            };
            running.set(key, 0);
            for (const cal of allDays) {
                if (cal.isFuture) {
                    row.days[cal.dateStr] = {
                        status: "—",
                        isSunday: cal.isSunday,
                        isFuture: true,
                    };
                    continue;
                }
                const dayDoc = byDate.get(cal.dateStr),
                    entry = dayDoc
                        ? (dayDoc.employees || []).find((e) => e.biometricId === key)
                        : null;
                if (cal.isDeclaredHoliday) {
                    const hs = cal.holidayStatus,
                        didPunch = !!entry && (entry.punchCount || 0) > 0;
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
                        if (row.totals[finalStatus] !== undefined)
                            row.totals[finalStatus]++;
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
                    row.days[cal.dateStr] = {
                        status: "—",
                        isSunday: cal.isSunday,
                        unsynced: true,
                    };
                    continue;
                }
                if (!entry) {
                    row.days[cal.dateStr] = { status: "AB", isSunday: cal.isSunday };
                    row.totals.AB++;
                    continue;
                }
                let cum = running.get(key) || 0,
                    status = entry.systemPrediction,
                    promoted = false;
                if (
                    settings.lateHalfDayPolicy?.enabled &&
                    entry.isLate &&
                    (entry.lateMins || 0) > 0
                ) {
                    cum += entry.lateMins;
                    const thr =
                        thresholds[entry.employeeType] ?? thresholds.operator ?? 30;
                    if (cum >= thr) {
                        status = "HD";
                        promoted = true;
                        cum = 0;
                    }
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
                if (["L-CL", "L-SL", "L-EL", "LWP", "WFH", "CO"].includes(finalStatus))
                    row.totals.leaves++;
                if (PAID_CODES.includes(finalStatus)) row.totals.totalAttendance++;
                if (
                    ["P", "P*", "P~"].includes(finalStatus) ||
                    (entry.inTime && entry.finalOut)
                )
                    row.totals.effectivePresent++;
                row.totals.totalLateMins += entry.lateMins || 0;
                row.totals.totalOtMins += entry.otMins || 0;
                row.totals.totalNetWorkMins += entry.netWorkMins || 0;
                if (promoted) row.totals.autoPromotedHDs++;
            }
            employees.push(row);
        }
        employees.sort((a, b) => {
            if (a.department !== b.department)
                return (a.department || "").localeCompare(b.department || "");
            return (a.employeeName || "").localeCompare(b.employeeName || "");
        });
        const dayTotals = {};
        for (const cal of allDays) {
            const t = {
                P: 0,
                "P*": 0,
                "P~": 0,
                HD: 0,
                AB: 0,
                MP: 0,
                WO: 0,
                PH: 0,
                FH: 0,
                NH: 0,
                OH: 0,
                RH: 0,
                leaves: 0,
                total: 0,
            };
            for (const emp of employees) {
                const d = emp.days[cal.dateStr];
                if (!d || !d.status || d.status === "—") continue;
                if (t[d.status] !== undefined) t[d.status]++;
                if (["L-CL", "L-SL", "L-EL", "LWP", "WFH", "CO"].includes(d.status))
                    t.leaves++;
                t.total++;
            }
            dayTotals[cal.dateStr] = t;
        }
        const grand = {
            totalEmployees: employees.length,
            workingDays: allDays.filter(
                (d) => !d.isSunday && !d.isFuture && !d.isDeclaredHoliday,
            ).length,
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
            totalHolidays: employees.reduce(
                (a, e) => a + e.totals.FH + e.totals.NH + e.totals.OH + e.totals.RH,
                0,
            ),
            totalSundayWorked: employees.reduce(
                (a, e) => a + e.totals.sundayWorked,
                0,
            ),
            totalHolidayWorked: employees.reduce(
                (a, e) => a + e.totals.holidayWorked,
                0,
            ),
            totalAttendance: employees.reduce(
                (a, e) => a + e.totals.totalAttendance,
                0,
            ),
            totalLateMins: employees.reduce((a, e) => a + e.totals.totalLateMins, 0),
            totalOtMins: employees.reduce((a, e) => a + e.totals.totalOtMins, 0),
            totalNetWorkMins: employees.reduce(
                (a, e) => a + e.totals.totalNetWorkMins,
                0,
            ),
        };
        res.json({
            success: true,
            yearMonth,
            from,
            to,
            monthLabel: new Date(from + "T00:00:00").toLocaleDateString("en-IN", {
                month: "long",
                year: "numeric",
            }),
            days: allDays,
            holidays: [...holidayMap.values()].filter(
                (h) => h.type !== "working_sunday",
            ),
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

router.get("/export-daily", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { date, department } = req.query;
        if (!date)
            return res.status(400).json({ success: false, message: "date required" });
        const dayDoc = await DailyAttendance.findOne({ dateStr: date }).lean();
        const settings = await AttendanceSettings.getConfig();
        const labels = settings.displayLabels || {};
        const L = (s) => labels[s] || s;
        const allActive = await Employee.find({
            $or: [
                { status: "active" },
                { status: { $exists: false } },
                { isActive: true },
            ],
        }).lean();
        const filteredActive =
            department && department !== "all"
                ? allActive.filter((e) => extractDepartment(e) === department)
                : allActive;
        const byBio = new Map();
        if (dayDoc)
            for (const e of dayDoc.employees || []) byBio.set(e.biometricId, e);
        const rows = [];
        for (const emp of filteredActive) {
            const bid = String(extractBiometricId(emp) || "").toUpperCase();
            if (!bid) continue;
            const entry = byBio.get(bid);
            const status = entry?.hrFinalStatus || entry?.systemPrediction || "AB";
            const empType = resolveEmployeeType(emp, settings);
            rows.push({
                name: extractName(emp),
                empId: bid,
                department: extractDepartment(emp) || "—",
                designation: extractDesignation(emp) || "—",
                empType,
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
                lateMins: entry?.lateMins || 0,
                lateDisplay: entry?.lateDisplay || "",
                isLate: !!entry?.isLate,
                isEarlyDeparture: !!entry?.isEarlyDeparture,
            });
        }
        rows.sort((a, b) => {
            const d = (a.department || "").localeCompare(b.department || "");
            if (d !== 0) return d;
            const g = (a.designation || "").localeCompare(b.designation || "");
            if (g !== 0) return g;
            return (a.name || "").localeCompare(b.name || "");
        });
        const PRESENT_CODES = ["P", "P*", "P~"],
            LEAVE_CODES = ["L-CL", "L-SL", "L-EL", "LWP", "WFH", "CO"],
            OFF_CODES = ["WO", "FH", "NH", "OH", "RH", "PH"];
        const counterTemplate = () => ({
            total: 0,
            present: 0,
            late: 0,
            halfDay: 0,
            missPunch: 0,
            absent: 0,
            leave: 0,
            off: 0,
        });
        const incCounters = (c, status) => {
            c.total++;
            if (PRESENT_CODES.includes(status)) c.present++;
            if (status === "P*") c.late++;
            if (status === "HD") c.halfDay++;
            if (status === "MP") c.missPunch++;
            if (status === "AB") c.absent++;
            if (LEAVE_CODES.includes(status)) c.leave++;
            if (OFF_CODES.includes(status)) c.off++;
        };
        const deptMap = new Map();
        for (const r of rows) {
            const dep = r.department,
                des = r.designation;
            if (!deptMap.has(dep))
                deptMap.set(dep, { ...counterTemplate(), designations: new Map() });
            const d = deptMap.get(dep);
            incCounters(d, r.status);
            if (!d.designations.has(des)) d.designations.set(des, counterTemplate());
            incCounters(d.designations.get(des), r.status);
        }
        const grand = counterTemplate();
        for (const [, d] of deptMap) {
            grand.total += d.total;
            grand.present += d.present;
            grand.late += d.late;
            grand.halfDay += d.halfDay;
            grand.missPunch += d.missPunch;
            grand.absent += d.absent;
            grand.leave += d.leave;
            grand.off += d.off;
        }
        const attndPct = (c) => {
            const expected = c.total - c.off - c.leave,
                showed = expected - c.absent;
            return expected > 0 ? Math.round((showed / expected) * 100) : 100;
        };
        const wb = new ExcelJS.Workbook();
        wb.creator = "Grav Clothing HRMS";
        const ws = wb.addWorksheet("Daily Manpower", {
            views: [{ state: "frozen", ySplit: 5, showGridLines: false }],
            pageSetup: {
                paperSize: 9,
                orientation: "landscape",
                fitToPage: true,
                fitToWidth: 1,
                margins: {
                    left: 0.3,
                    right: 0.3,
                    top: 0.4,
                    bottom: 0.4,
                    header: 0.2,
                    footer: 0.2,
                },
            },
        });
        const COLS = 16;
        const widths = [5, 26, 10, 16, 19, 7, 14, 9, 9, 9, 9, 9, 9, 9, 9, 10];
        widths.forEach((w, i) => {
            ws.getColumn(i + 1).width = w;
        });
        const dateLabel = new Date(date + "T00:00:00").toLocaleDateString("en-IN", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
            timeZone: "Asia/Kolkata",
        });
        const fmt = (d) => fmtTimeIST(d);
        const fmtMins = (m) => {
            if (!m || m <= 0) return "";
            const h = Math.floor(m / 60),
                mm = m % 60;
            return h
                ? `${h}:${String(mm).padStart(2, "0")}`
                : `0:${String(mm).padStart(2, "0")}`;
        };
        const STATUS_COLOR = {
            P: "FF008000",
            "P*": "FFFF8C00",
            "P~": "FFFF0000",
            HD: "FFCA8A04",
            MP: "FFDB2777",
            AB: "FFDC2626",
            LWP: "FFDC2626",
            WO: "FF64748B",
            FH: "FF4F46E5",
            NH: "FF4F46E5",
            OH: "FF4F46E5",
            RH: "FF4F46E5",
            PH: "FF4F46E5",
            "L-CL": "FF7C3AED",
            "L-SL": "FF7C3AED",
            "L-EL": "FF7C3AED",
            WFH: "FF0891B2",
            CO: "FF0D9488",
        };
        let row = 1;
        ws.mergeCells(row, 1, row, COLS);
        const hero = ws.getCell(row, 1);
        hero.value = {
            richText: [
                {
                    text: "GRAV CLOTHING\n",
                    font: {
                        size: 11,
                        bold: true,
                        italic: true,
                        color: { argb: "FFE9D5FF" },
                    },
                },
                {
                    text: `Daily Manpower Report  ·  ${dateLabel}`,
                    font: { size: 22, bold: true, color: { argb: "FFFFFFFF" } },
                },
            ],
        };
        hero.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF581C87" },
        };
        hero.alignment = {
            vertical: "middle",
            horizontal: "center",
            wrapText: true,
        };
        ws.getRow(row).height = 56;
        row++;
        ws.mergeCells(row, 1, row, COLS);
        const sub = ws.getCell(row, 1);
        const overallPct = attndPct(grand);
        sub.value = `${grand.total} TOTAL  ·  ${grand.present} PRESENT (${overallPct}%)  ·  ${grand.late} LATE  ·  ${grand.halfDay} HALF-DAY  ·  ${grand.missPunch} MISS PUNCH  ·  ${grand.absent} ABSENT  ·  ${grand.leave} ON LEAVE  ·  ${grand.off} OFF/HOLIDAY${department && department !== "all" ? `  ·  Filtered: ${department}` : ""}`;
        sub.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF0F172A" },
        };
        sub.font = { size: 11, color: { argb: "FFC4B5FD" }, bold: true };
        sub.alignment = { vertical: "middle", horizontal: "center" };
        ws.getRow(row).height = 30;
        row++;
        ws.mergeCells(row, 1, row, COLS);
        const lg = ws.getCell(row, 1);
        lg.value = {
            richText: [
                {
                    text: "P",
                    font: { size: 10, bold: true, color: { argb: "FF008000" } },
                },
                {
                    text: " Present  ·  ",
                    font: { size: 9, color: { argb: "FF6B7280" } },
                },
                {
                    text: "P*",
                    font: { size: 10, bold: true, color: { argb: "FFFF8C00" } },
                },
                { text: " Late  ·  ", font: { size: 9, color: { argb: "FF6B7280" } } },
                {
                    text: "P~",
                    font: { size: 10, bold: true, color: { argb: "FFFF0000" } },
                },
                {
                    text: " Early Out  ·  ",
                    font: { size: 9, color: { argb: "FF6B7280" } },
                },
                {
                    text: "HD",
                    font: { size: 10, bold: true, color: { argb: "FFCA8A04" } },
                },
                {
                    text: " Half Day  ·  ",
                    font: { size: 9, color: { argb: "FF6B7280" } },
                },
                {
                    text: "MP",
                    font: { size: 10, bold: true, color: { argb: "FFDB2777" } },
                },
                {
                    text: " Miss Punch  ·  ",
                    font: { size: 9, color: { argb: "FF6B7280" } },
                },
                {
                    text: "AB",
                    font: { size: 10, bold: true, color: { argb: "FFDC2626" } },
                },
                {
                    text: " Absent  ·  ",
                    font: { size: 9, color: { argb: "FF6B7280" } },
                },
                {
                    text: "WO",
                    font: { size: 10, bold: true, color: { argb: "FF64748B" } },
                },
                {
                    text: " Weekly Off  ·  ",
                    font: { size: 9, color: { argb: "FF6B7280" } },
                },
                {
                    text: "FH/NH/OH/RH",
                    font: { size: 10, bold: true, color: { argb: "FF4F46E5" } },
                },
                {
                    text: " Holiday  ·  ",
                    font: { size: 9, color: { argb: "FF6B7280" } },
                },
                {
                    text: "CL/SL/EL/WFH/CO",
                    font: { size: 10, bold: true, color: { argb: "FF7C3AED" } },
                },
                { text: " Leave", font: { size: 9, color: { argb: "FF6B7280" } } },
            ],
        };
        lg.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        lg.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFF9FAFB" },
        };
        ws.getRow(row).height = 22;
        for (let c = 1; c <= COLS; c++)
            ws.getCell(row, c).border = {
                top: { style: "thin", color: { argb: "FFE5E7EB" } },
                bottom: { style: "medium", color: { argb: "FF6B7280" } },
            };
        row++;
        ws.mergeCells(row, 1, row, COLS);
        const rh = ws.getCell(row, 1);
        rh.value = `EMPLOYEE ROSTER  ·  ${rows.length} employee${rows.length === 1 ? "" : "s"}`;
        rh.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF1F2937" },
        };
        rh.font = { size: 11, bold: true, color: { argb: "FFFFFFFF" } };
        rh.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
        ws.getRow(row).height = 24;
        row++;
        const colHeaders = [
            "#",
            "EMPLOYEE",
            "EMP ID",
            "DEPARTMENT",
            "DESIGNATION",
            "TYPE",
            "STATUS",
            "IN",
            "L.OUT",
            "L.IN",
            "T.OUT",
            "T.IN",
            "OUT",
            "WORK",
            "OT",
            "LATE",
        ];
        const headerRow = ws.getRow(row);
        colHeaders.forEach((h, i) => {
            const cell = headerRow.getCell(i + 1);
            cell.value = h;
            cell.font = { size: 9, bold: true, color: { argb: "FFFFFFFF" } };
            cell.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: "FF374151" },
            };
            cell.alignment = {
                vertical: "middle",
                horizontal: i === 1 || i === 3 || i === 4 ? "left" : "center",
                indent: i === 1 || i === 3 || i === 4 ? 1 : 0,
            };
            cell.border = {
                top: { style: "medium", color: { argb: "FF0F172A" } },
                bottom: { style: "medium", color: { argb: "FF0F172A" } },
                left: { style: "thin", color: { argb: "FF4B5563" } },
                right: { style: "thin", color: { argb: "FF4B5563" } },
            };
        });
        headerRow.height = 28;
        row++;
        let lastDept = null,
            counter = 0;
        for (const r of rows) {
            if (r.department !== lastDept) {
                if (lastDept !== null) {
                    ws.getRow(row).height = 4;
                    for (let c = 1; c <= COLS; c++)
                        ws.getCell(row, c).fill = {
                            type: "pattern",
                            pattern: "solid",
                            fgColor: { argb: "FFEDE9FE" },
                        };
                    row++;
                }
                lastDept = r.department;
            }
            counter++;
            const dr = ws.getRow(row);
            const fillColor = counter % 2 === 0 ? "FFF8FAFC" : "FFFFFFFF";
            dr.getCell(1).value = counter;
            dr.getCell(1).font = { size: 9, color: { argb: "FF9CA3AF" } };
            dr.getCell(1).alignment = { vertical: "middle", horizontal: "center" };
            dr.getCell(2).value = r.name;
            dr.getCell(2).font = {
                size: 10,
                bold: true,
                color: { argb: "FF1D4ED8" },
            };
            dr.getCell(2).alignment = {
                vertical: "middle",
                horizontal: "left",
                indent: 1,
            };
            dr.getCell(3).value = r.empId;
            dr.getCell(3).font = {
                name: "Consolas",
                size: 9,
                color: { argb: "FF6B7280" },
            };
            dr.getCell(3).alignment = { vertical: "middle", horizontal: "center" };
            dr.getCell(4).value = r.department;
            dr.getCell(4).font = { size: 9, color: { argb: "FF374151" } };
            dr.getCell(4).alignment = {
                vertical: "middle",
                horizontal: "left",
                indent: 1,
            };
            dr.getCell(5).value = r.designation;
            dr.getCell(5).font = { size: 9, color: { argb: "FF374151" } };
            dr.getCell(5).alignment = {
                vertical: "middle",
                horizontal: "left",
                indent: 1,
            };
            dr.getCell(6).value = r.empType === "executive" ? "EXE" : "OPR";
            dr.getCell(6).font = {
                size: 8,
                bold: true,
                color: { argb: r.empType === "executive" ? "FF4F46E5" : "FF2563EB" },
            };
            dr.getCell(6).alignment = { vertical: "middle", horizontal: "center" };
            dr.getCell(7).value = r.statusLabel;
            dr.getCell(7).font = {
                size: 10,
                bold: true,
                color: { argb: STATUS_COLOR[r.status] || "FF111827" },
            };
            dr.getCell(7).alignment = { vertical: "middle", horizontal: "center" };
            dr.getCell(8).value = fmt(r.inTime);
            dr.getCell(8).font = {
                name: "Consolas",
                size: 9,
                bold: r.isLate,
                color: { argb: r.isLate ? "FFFF8C00" : "FF2563EB" },
            };
            dr.getCell(8).alignment = { vertical: "middle", horizontal: "center" };
            dr.getCell(9).value = fmt(r.lunchOut);
            dr.getCell(10).value = fmt(r.lunchIn);
            dr.getCell(11).value = fmt(r.teaOut);
            dr.getCell(12).value = fmt(r.teaIn);
            for (const c of [9, 10, 11, 12]) {
                dr.getCell(c).font = {
                    name: "Consolas",
                    size: 8,
                    color: { argb: "FF6B7280" },
                };
                dr.getCell(c).alignment = { vertical: "middle", horizontal: "center" };
            }
            dr.getCell(13).value = fmt(r.outTime);
            dr.getCell(13).font = {
                name: "Consolas",
                size: 9,
                bold: true,
                color: { argb: r.isEarlyDeparture ? "FFFF8C00" : "FF111827" },
            };
            dr.getCell(13).alignment = { vertical: "middle", horizontal: "center" };
            dr.getCell(14).value = fmtMins(r.netWorkMins);
            dr.getCell(14).font = {
                name: "Consolas",
                size: 10,
                bold: true,
                color: {
                    argb:
                        r.netWorkMins >= 480
                            ? "FF16A34A"
                            : r.netWorkMins > 0
                                ? "FFDC2626"
                                : "FF9CA3AF",
                },
            };
            dr.getCell(14).alignment = { vertical: "middle", horizontal: "center" };
            dr.getCell(15).value = fmtMins(r.otMins);
            dr.getCell(15).font = {
                name: "Consolas",
                size: 9,
                bold: r.otMins > 0,
                color: { argb: r.otMins > 0 ? "FF4338CA" : "FF9CA3AF" },
            };
            dr.getCell(15).alignment = { vertical: "middle", horizontal: "center" };
            dr.getCell(16).value =
                r.lateDisplay || (r.lateMins > 0 ? fmtMins(r.lateMins) : "");
            dr.getCell(16).font = {
                size: 9,
                bold: r.lateMins > 0,
                color: { argb: r.lateMins > 0 ? "FFFF8C00" : "FF9CA3AF" },
            };
            dr.getCell(16).alignment = { vertical: "middle", horizontal: "center" };
            for (let c = 1; c <= COLS; c++) {
                const cell = dr.getCell(c);
                cell.fill = {
                    type: "pattern",
                    pattern: "solid",
                    fgColor: { argb: fillColor },
                };
                cell.border = {
                    top: { style: "thin", color: { argb: "FFE5E7EB" } },
                    bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
                    left: { style: "thin", color: { argb: "FFF3F4F6" } },
                    right: { style: "thin", color: { argb: "FFF3F4F6" } },
                };
            }
            dr.height = 22;
            row++;
        }
        ws.getRow(row).height = 16;
        row++;
        ws.mergeCells(row, 1, row, COLS);
        const mh = ws.getCell(row, 1);
        mh.value = "MANPOWER BREAKDOWN  ·  By Department & Designation";
        mh.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF1F2937" },
        };
        mh.font = { size: 11, bold: true, color: { argb: "FFFFFFFF" } };
        mh.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
        ws.getRow(row).height = 24;
        row++;
        const bkHeaders = [
            "DEPARTMENT / DESIGNATION",
            "TOTAL",
            "PRESENT",
            "LATE",
            "HD",
            "MP",
            "ABSENT",
            "LEAVE",
            "OFF/HOL",
            "ATTND %",
        ];
        const bkRow = ws.getRow(row);
        bkHeaders.forEach((h, i) => {
            const cell = bkRow.getCell(i + 1);
            cell.value = h;
            cell.font = { size: 9, bold: true, color: { argb: "FFFFFFFF" } };
            cell.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: "FF374151" },
            };
            cell.alignment = {
                vertical: "middle",
                horizontal: i === 0 ? "left" : "center",
                indent: i === 0 ? 1 : 0,
            };
            cell.border = {
                top: { style: "medium", color: { argb: "FF0F172A" } },
                bottom: { style: "medium", color: { argb: "FF0F172A" } },
                left: { style: "thin", color: { argb: "FF4B5563" } },
                right: { style: "thin", color: { argb: "FF4B5563" } },
            };
        });
        ws.mergeCells(row, 11, row, COLS);
        const bkPad = ws.getCell(row, 11);
        bkPad.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF374151" },
        };
        bkPad.border = {
            top: { style: "medium", color: { argb: "FF0F172A" } },
            bottom: { style: "medium", color: { argb: "FF0F172A" } },
        };
        bkRow.height = 26;
        row++;
        const sortedDepts = [...deptMap.entries()].sort(
            (a, b) => b[1].total - a[1].total,
        );
        for (const [depName, depCounts] of sortedDepts) {
            ws.mergeCells(row, 1, row, 10);
            const dh = ws.getCell(row, 1);
            const depPct = attndPct(depCounts);
            dh.value = `▼ ${depName}  ·  ${depCounts.total} employee${depCounts.total === 1 ? "" : "s"}  ·  ${depCounts.present} present  ·  ${depPct}% attendance`;
            dh.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: "FF581C87" },
            };
            dh.font = { size: 10, bold: true, color: { argb: "FFFFFFFF" } };
            dh.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
            ws.mergeCells(row, 11, row, COLS);
            ws.getCell(row, 11).fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: "FF581C87" },
            };
            ws.getRow(row).height = 22;
            row++;
            const sortedDesigs = [...depCounts.designations.entries()].sort(
                (a, b) => b[1].total - a[1].total,
            );
            for (const [desigName, c] of sortedDesigs) {
                const dr = ws.getRow(row);
                const pct = attndPct(c);
                dr.getCell(1).value = `    ${desigName}`;
                dr.getCell(1).font = { size: 9, color: { argb: "FF374151" } };
                dr.getCell(1).alignment = {
                    vertical: "middle",
                    horizontal: "left",
                    indent: 2,
                };
                const cells = [
                    { v: c.total, color: "FF111827", bold: true },
                    {
                        v: c.present || "—",
                        color: c.present ? "FF16A34A" : "FF9CA3AF",
                        bold: true,
                    },
                    { v: c.late || "—", color: c.late ? "FFFF8C00" : "FF9CA3AF" },
                    { v: c.halfDay || "—", color: c.halfDay ? "FFCA8A04" : "FF9CA3AF" },
                    {
                        v: c.missPunch || "—",
                        color: c.missPunch ? "FFDB2777" : "FF9CA3AF",
                    },
                    {
                        v: c.absent || "—",
                        color: c.absent ? "FFDC2626" : "FF9CA3AF",
                        bold: !!c.absent,
                    },
                    { v: c.leave || "—", color: c.leave ? "FF7C3AED" : "FF9CA3AF" },
                    { v: c.off || "—", color: c.off ? "FF4F46E5" : "FF9CA3AF" },
                    {
                        v: `${pct}%`,
                        color: pct >= 90 ? "FF16A34A" : pct >= 75 ? "FFCA8A04" : "FFDC2626",
                        bold: true,
                    },
                ];
                cells.forEach((vc, i) => {
                    const cell = dr.getCell(i + 2);
                    cell.value = vc.v;
                    cell.font = { size: 9, bold: vc.bold, color: { argb: vc.color } };
                    cell.alignment = { vertical: "middle", horizontal: "center" };
                });
                for (let c2 = 1; c2 <= 10; c2++) {
                    dr.getCell(c2).fill = {
                        type: "pattern",
                        pattern: "solid",
                        fgColor: { argb: "FFFFFFFF" },
                    };
                    dr.getCell(c2).border = {
                        top: { style: "thin", color: { argb: "FFF3F4F6" } },
                        bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
                        left: { style: "thin", color: { argb: "FFF3F4F6" } },
                        right: { style: "thin", color: { argb: "FFF3F4F6" } },
                    };
                }
                ws.mergeCells(row, 11, row, COLS);
                ws.getCell(row, 11).fill = {
                    type: "pattern",
                    pattern: "solid",
                    fgColor: { argb: "FFFFFFFF" },
                };
                dr.height = 20;
                row++;
            }
            const stRow = ws.getRow(row);
            const stPct = attndPct(depCounts);
            stRow.getCell(1).value = `  ▶ ${depName} TOTAL`;
            stRow.getCell(1).font = {
                size: 10,
                bold: true,
                color: { argb: "FF581C87" },
            };
            stRow.getCell(1).alignment = {
                vertical: "middle",
                horizontal: "left",
                indent: 1,
            };
            const stCells = [
                { v: depCounts.total, color: "FF581C87" },
                { v: depCounts.present, color: "FF16A34A" },
                { v: depCounts.late, color: "FFFF8C00" },
                { v: depCounts.halfDay, color: "FFCA8A04" },
                { v: depCounts.missPunch, color: "FFDB2777" },
                { v: depCounts.absent, color: "FFDC2626" },
                { v: depCounts.leave, color: "FF7C3AED" },
                { v: depCounts.off, color: "FF4F46E5" },
                {
                    v: `${stPct}%`,
                    color: "FFFFFFFF",
                    fill:
                        stPct >= 90 ? "FF16A34A" : stPct >= 75 ? "FFCA8A04" : "FFDC2626",
                },
            ];
            stCells.forEach((vc, i) => {
                const cell = stRow.getCell(i + 2);
                cell.value = vc.v;
                cell.font = { size: 10, bold: true, color: { argb: vc.color } };
                cell.alignment = { vertical: "middle", horizontal: "center" };
                if (vc.fill)
                    cell.fill = {
                        type: "pattern",
                        pattern: "solid",
                        fgColor: { argb: vc.fill },
                    };
            });
            for (let c2 = 1; c2 <= 10; c2++) {
                if (!stRow.getCell(c2).fill)
                    stRow.getCell(c2).fill = {
                        type: "pattern",
                        pattern: "solid",
                        fgColor: { argb: "FFEDE9FE" },
                    };
                stRow.getCell(c2).border = {
                    top: { style: "medium", color: { argb: "FF7C3AED" } },
                    bottom: { style: "medium", color: { argb: "FF7C3AED" } },
                };
            }
            ws.mergeCells(row, 11, row, COLS);
            ws.getCell(row, 11).fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: "FFEDE9FE" },
            };
            stRow.height = 22;
            row++;
            ws.getRow(row).height = 4;
            row++;
        }
        const gtRow = ws.getRow(row);
        const gtPct = attndPct(grand);
        gtRow.getCell(1).value = "GRAND TOTAL";
        gtRow.getCell(1).font = {
            size: 12,
            bold: true,
            color: { argb: "FFFFFFFF" },
        };
        gtRow.getCell(1).alignment = {
            vertical: "middle",
            horizontal: "left",
            indent: 1,
        };
        const gtVals = [
            grand.total,
            grand.present,
            grand.late,
            grand.halfDay,
            grand.missPunch,
            grand.absent,
            grand.leave,
            grand.off,
            `${gtPct}%`,
        ];
        gtVals.forEach((v, i) => {
            const cell = gtRow.getCell(i + 2);
            cell.value = v;
            cell.font = { size: 12, bold: true, color: { argb: "FFFFFFFF" } };
            cell.alignment = { vertical: "middle", horizontal: "center" };
        });
        for (let c2 = 1; c2 <= 10; c2++) {
            gtRow.getCell(c2).fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: "FF0F172A" },
            };
            gtRow.getCell(c2).border = {
                top: { style: "double", color: { argb: "FF0F172A" } },
                bottom: { style: "double", color: { argb: "FF0F172A" } },
            };
        }
        ws.mergeCells(row, 11, row, COLS);
        ws.getCell(row, 11).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF0F172A" },
        };
        gtRow.height = 30;
        row++;
        ws.getRow(row).height = 8;
        row++;
        ws.mergeCells(row, 1, row, COLS);
        const ft = ws.getCell(row, 1);
        ft.value = `Generated ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}  ·  Grav Clothing HRMS  ·  Daily Manpower Report`;
        ft.font = { size: 8, italic: true, color: { argb: "FF6B7280" } };
        ft.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
        ws.getRow(row).height = 18;
        const buffer = await wb.xlsx.writeBuffer();
        const filename = `manpower_${date}${department && department !== "all" ? `_${department}` : ""}.xlsx`;
        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Cache-Control", "no-store");
        res.send(buffer);
    } catch (err) {
        console.error("[EXPORT-DAILY]", err.message, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get("/export-muster-roll", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { yearMonth, department } = req.query;
        if (!yearMonth)
            return res
                .status(400)
                .json({ success: false, message: "yearMonth required" });
        const [yr, mo] = yearMonth.split("-").map(Number);
        const lastDay = new Date(yr, mo, 0).getDate(),
            from = `${yearMonth}-01`,
            to = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;
        const monthLabel = new Date(from + "T00:00:00")
            .toLocaleDateString("en-IN", { month: "long", year: "numeric" })
            .toUpperCase();
        const settings = await AttendanceSettings.getConfig();
        const holidayMap = await loadHolidayMap(from, to);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const allDays = [];
        for (let d = 1; d <= lastDay; d++) {
            const dateStr = `${yearMonth}-${String(d).padStart(2, "0")}`,
                dt = new Date(dateStr + "T00:00:00"),
                dow = dt.getDay();
            const hol = holidayMap.get(dateStr),
                isDeclaredHoliday = !!hol && hol.type !== "working_sunday",
                isWorkingSunday = !!hol && hol.type === "working_sunday";
            allDays.push({
                day: d,
                dateStr,
                dayAbbr: dt
                    .toLocaleDateString("en-IN", { weekday: "short" })
                    .substring(0, 3)
                    .toUpperCase(),
                isSunday: dow === 0,
                isFuture: dt > today,
                isDeclaredHoliday,
                isWorkingSunday,
                holiday: isDeclaredHoliday ? hol : null,
                holidayStatus: isDeclaredHoliday ? holidayTypeToStatus(hol.type) : null,
                holidayName: isDeclaredHoliday ? hol.name : null,
            });
        }
        function toSheetCode(status) {
            const map = {
                P: "P",
                "P*": "P",
                "P~": "P",
                MP: "P",
                WFH: "P",
                AB: "A",
                LWP: "A",
                HD: "HD",
                WO: "WO",
                OH: "WO",
                RH: "WO",
                CO: "CO",
                "L-CL": "CL",
                "L-SL": "SL",
                "L-EL": "PL",
                FH: "FH",
                NH: "NH",
                PH: "FH",
            };
            return map[status] || "";
        }
        const allActive = await Employee.find({
            $or: [
                { status: "active" },
                { status: { $exists: false } },
                { isActive: true },
            ],
        }).lean();
        const filteredActive =
            department && department !== "all"
                ? allActive.filter((e) => extractDepartment(e) === department)
                : allActive;
        const dayDocs = await DailyAttendance.find({ yearMonth })
            .sort({ dateStr: 1 })
            .lean();
        const byDate = new Map(dayDocs.map((d) => [d.dateStr, d]));
        const employees = [];
        function buildEmpRow(key, empName, empDept, empDesig, empType) {
            const row = {
                biometricId: key,
                employeeName: empName,
                department: empDept,
                designation: empDesig,
                employeeType: empType,
                dayCodes: {},
                hrOverrides: new Set(),
                totals: {
                    P: 0,
                    A: 0,
                    HD: 0,
                    WO: 0,
                    CO: 0,
                    CL: 0,
                    SL: 0,
                    PL: 0,
                    NHFH: 0,
                    Total: 0,
                },
            };
            for (const cal of allDays) {
                if (cal.isFuture) {
                    row.dayCodes[cal.dateStr] = "";
                    continue;
                }
                const dayDoc = byDate.get(cal.dateStr),
                    entry = dayDoc
                        ? (dayDoc.employees || []).find((e) => e.biometricId === key)
                        : null;
                let sheetCode = "";
                if (cal.isDeclaredHoliday) {
                    const hs = cal.holidayStatus,
                        didPunch = !!entry && (entry.punchCount || 0) > 0;
                    sheetCode = didPunch ? "P" : toSheetCode(hs);
                    if (["FH", "NH", "OH", "RH", "PH"].includes(hs) && !didPunch)
                        row.totals.NHFH++;
                    else if (didPunch) row.totals.P++;
                    if (
                        didPunch &&
                        (entry?.hrFinalStatus ||
                            (entry?.rawPunches || []).some((p) => p.source === "manual"))
                    )
                        row.hrOverrides.add(cal.dateStr);
                } else if (cal.isSunday && !cal.isWorkingSunday) {
                    const didPunch = !!entry && (entry.punchCount || 0) > 0;
                    if (didPunch) {
                        const finalStatus = entry.hrFinalStatus || entry.systemPrediction;
                        sheetCode = toSheetCode(finalStatus) || "P";
                        row.totals.P++;
                        if (
                            entry.hrFinalStatus ||
                            (entry.rawPunches || []).some(
                                (p) => p.source === "manual" || p.source === "miss_punch",
                            )
                        )
                            row.hrOverrides.add(cal.dateStr);
                    } else {
                        sheetCode = "WO";
                        row.totals.WO++;
                    }
                } else if (!dayDoc || !entry) {
                    sheetCode = dayDoc ? "A" : "";
                    if (dayDoc) row.totals.A++;
                } else {
                    const finalStatus = entry.hrFinalStatus || entry.systemPrediction;
                    sheetCode = toSheetCode(finalStatus);
                    const hasManualPunch = (entry.rawPunches || []).some(
                        (p) => p.source === "manual" || p.source === "miss_punch",
                    );
                    if (entry.hrFinalStatus || hasManualPunch)
                        row.hrOverrides.add(cal.dateStr);
                    if (["P", "P*", "P~", "MP", "WFH"].includes(finalStatus))
                        row.totals.P++;
                    else if (finalStatus === "AB" || finalStatus === "LWP")
                        row.totals.A++;
                    else if (finalStatus === "HD") row.totals.HD++;
                    else if (finalStatus === "WO") row.totals.WO++;
                    else if (finalStatus === "CO") row.totals.CO++;
                    else if (finalStatus === "L-CL") row.totals.CL++;
                    else if (finalStatus === "L-SL") row.totals.SL++;
                    else if (finalStatus === "L-EL") row.totals.PL++;
                    else if (["FH", "NH", "OH", "RH", "PH"].includes(finalStatus))
                        row.totals.NHFH++;
                }
                row.dayCodes[cal.dateStr] = sheetCode;
            }
            row.totals.Total = lastDay - row.totals.A;
            return row;
        }
        const processedBids = new Set();
        for (const emp of filteredActive) {
            const bid = extractBiometricId(emp);
            if (!bid) continue;
            const key = String(bid).toUpperCase();
            if (processedBids.has(key)) continue;
            processedBids.add(key);
            const empType = resolveEmployeeType(emp, settings);
            employees.push(
                buildEmpRow(
                    key,
                    extractName(emp),
                    extractDepartment(emp),
                    extractDesignation(emp),
                    empType,
                ),
            );
        }
        for (const dayDoc of dayDocs) {
            for (const entry of dayDoc.employees || []) {
                const key = String(entry.biometricId || "").toUpperCase();
                if (!key || processedBids.has(key)) continue;
                if (
                    department &&
                    department !== "all" &&
                    entry.department !== department
                )
                    continue;
                processedBids.add(key);
                employees.push(
                    buildEmpRow(
                        key,
                        entry.employeeName || key,
                        entry.department || "—",
                        entry.designation || "—",
                        entry.employeeType || "operator",
                    ),
                );
            }
        }
        employees.sort((a, b) => {
            if (a.department !== b.department)
                return (a.department || "").localeCompare(b.department || "");
            return (a.employeeName || "").localeCompare(b.employeeName || "");
        });
        const wb = new ExcelJS.Workbook();
        wb.creator = "Grav Clothing HRMS";
        wb.created = new Date();
        const ws = wb.addWorksheet("Attendance", {
            views: [{ state: "frozen", xSplit: 4, ySplit: 4, showGridLines: true }],
            pageSetup: {
                paperSize: 9,
                orientation: "landscape",
                fitToPage: true,
                fitToWidth: 1,
            },
        });
        ws.getColumn(1).width = 6;
        ws.getColumn(2).width = 24;
        ws.getColumn(3).width = 14;
        ws.getColumn(4).width = 20;
        for (let d = 1; d <= lastDay; d++) ws.getColumn(4 + d).width = 4;
        const sumStart = 4 + lastDay + 1;
        const sumCols = [
            "P",
            "A",
            "HD",
            "WO",
            "CO",
            "CL",
            "SL",
            "PL",
            "NH/FH",
            "Total Days",
        ];
        sumCols.forEach((_, i) => {
            ws.getColumn(sumStart + i).width = 7;
        });
        const totalCols = 4 + lastDay + sumCols.length;
        ws.mergeCells(1, 1, 1, totalCols);
        const titleCell = ws.getCell("A1");
        titleCell.value = `MONTHLY ATTENDANCE SHEET \u2014 ${monthLabel}`;
        titleCell.font = { name: "Arial", size: 14, bold: true };
        titleCell.alignment = { horizontal: "center", vertical: "middle" };
        titleCell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFD9E1F2" },
        };
        titleCell.border = {
            top: { style: "medium" },
            left: { style: "medium" },
            right: { style: "medium" },
            bottom: { style: "thin" },
        };
        ws.getRow(1).height = 22;
        ws.mergeCells(2, 1, 2, Math.min(totalCols - 3, 30));
        const legendCell = ws.getCell(2, 1);
        legendCell.value =
            "P = Present\t\tA= Absent\t\tHD = Half Day\t\tWO = Week Off\t\tCL = Casual Leave\t\tSL = Sick Leave\t\tPL = Privilege Leave\t\t[ Purple border = HR Override ]";
        legendCell.font = { name: "Arial", size: 8 };
        legendCell.alignment = { vertical: "middle" };
        ws.getRow(2).height = 14;
        const holidays = [...holidayMap.values()]
            .filter((h) => h.type !== "working_sunday")
            .sort((a, b) => a.date.localeCompare(b.date));
        if (holidays.length > 0) {
            const h = holidays[0];
            const [y2, m2, d2] = h.date.split("-").map(Number);
            const ordinals = [
                "",
                "1st",
                "2nd",
                "3rd",
                "4th",
                "5th",
                "6th",
                "7th",
                "8th",
                "9th",
                "10th",
                "11th",
                "12th",
                "13th",
                "14th",
                "15th",
                "16th",
                "17th",
                "18th",
                "19th",
                "20th",
                "21st",
                "22nd",
                "23rd",
                "24th",
                "25th",
                "26th",
                "27th",
                "28th",
                "29th",
                "30th",
                "31st",
            ];
            const mn = new Date(h.date + "T00:00:00").toLocaleDateString("en-IN", {
                month: "long",
            });
            const noteCol = Math.max(
                Math.min(totalCols - sumCols.length + 1, totalCols - 2),
                1,
            );
            ws.mergeCells(2, noteCol, 2, totalCols);
            const noteCell = ws.getCell(2, noteCol);
            noteCell.value = `${ordinals[d2]} ${mn} ${y2}\t\t${h.name}`;
            noteCell.font = { name: "Arial", size: 8, italic: true };
            noteCell.alignment = { horizontal: "right", vertical: "middle" };
        }
        ws.getRow(3).height = 16;
        const hdr = ws.getRow(3);
        hdr.getCell(1).value = "Sr.  No.";
        hdr.getCell(2).value = "Employee Name";
        hdr.getCell(3).value = "Department";
        hdr.getCell(4).value = "Designation";
        for (let d = 1; d <= lastDay; d++) hdr.getCell(4 + d).value = d;
        sumCols.forEach((h, i) => {
            hdr.getCell(sumStart + i).value = h;
        });
        hdr.eachCell((cell, col) => {
            const isSumCol = col >= sumStart,
                isTitleCol = col <= 4;
            cell.font = { name: "Arial", size: 9, bold: true };
            cell.alignment = {
                horizontal: "center",
                vertical: "middle",
                wrapText: true,
            };
            if (isTitleCol)
                cell.fill = {
                    type: "pattern",
                    pattern: "solid",
                    fgColor: { argb: "FF8EA9C1" },
                };
            else if (isSumCol)
                cell.fill = {
                    type: "pattern",
                    pattern: "solid",
                    fgColor: { argb: "FFF4B942" },
                };
            else {
                const dayIdx = col - 5,
                    cal = allDays[dayIdx];
                if (cal?.isSunday)
                    cell.fill = {
                        type: "pattern",
                        pattern: "solid",
                        fgColor: { argb: "FFFFC7CE" },
                    };
                else if (cal?.isDeclaredHoliday)
                    cell.fill = {
                        type: "pattern",
                        pattern: "solid",
                        fgColor: { argb: "FFB4C6E7" },
                    };
                else
                    cell.fill = {
                        type: "pattern",
                        pattern: "solid",
                        fgColor: { argb: "FF8EA9C1" },
                    };
            }
            cell.border = {
                top: { style: "thin" },
                left: { style: "thin" },
                right: { style: "thin" },
                bottom: { style: "thin" },
            };
        });
        ws.getRow(4).height = 14;
        const dowRow = ws.getRow(4);
        for (let d = 1; d <= lastDay; d++) {
            const cal = allDays[d - 1];
            const cell = dowRow.getCell(4 + d);
            cell.value = cal.dayAbbr;
            cell.font = { name: "Arial", size: 7 };
            cell.alignment = { horizontal: "center", vertical: "middle" };
            if (cal.isSunday)
                cell.fill = {
                    type: "pattern",
                    pattern: "solid",
                    fgColor: { argb: "FFFFC7CE" },
                };
            else if (cal.isDeclaredHoliday)
                cell.fill = {
                    type: "pattern",
                    pattern: "solid",
                    fgColor: { argb: "FFB4C6E7" },
                };
            cell.border = {
                top: { style: "thin" },
                left: { style: "thin" },
                right: { style: "thin" },
                bottom: { style: "thin" },
            };
        }
        const STATUS_STYLE = {
            P: { font: "FF000000", fill: null },
            A: { font: "FF9C0006", fill: "FFFFC7CE" },
            HD: { font: "FF7D4701", fill: "FFFFEB9C" },
            WO: { font: "FF375623", fill: "FFC6EFCE" },
            CO: { font: "FF0D4A8C", fill: "FFBDD7EE" },
            CL: { font: "FF5C2B9C", fill: "FFEDDBFF" },
            SL: { font: "FF5C2B9C", fill: "FFEDDBFF" },
            PL: { font: "FF5C2B9C", fill: "FFEDDBFF" },
            FH: { font: "FF1F4E79", fill: "FFDCE6F1" },
            NH: { font: "FF7B1E46", fill: "FFFCE4EC" },
            "": { font: "FFAAAAAA", fill: null },
        };
        const colTotals = new Array(totalCols + 1).fill(0);
        employees.forEach((emp, i) => {
            const rowNum = 5 + i,
                r = ws.getRow(rowNum);
            r.height = 15;
            r.getCell(1).value = i + 1;
            r.getCell(2).value = emp.employeeName;
            r.getCell(3).value = emp.department;
            r.getCell(4).value = emp.designation;
            [1, 2, 3, 4].forEach((col) => {
                const cell = r.getCell(col);
                const altBg = i % 2 === 0 ? "FFFFFFFF" : "FFF8F9FA";
                cell.fill = {
                    type: "pattern",
                    pattern: "solid",
                    fgColor: { argb: altBg },
                };
                cell.font = { name: "Arial", size: 9 };
                cell.border = {
                    top: { style: "thin" },
                    left: { style: "thin" },
                    right: { style: "thin" },
                    bottom: { style: "thin" },
                };
                cell.alignment =
                    col === 1
                        ? { horizontal: "center", vertical: "middle" }
                        : { horizontal: "left", vertical: "middle" };
            });
            allDays.forEach((cal, di) => {
                const cell = r.getCell(5 + di);
                const code = emp.dayCodes[cal.dateStr] || "",
                    isHrOverride = emp.hrOverrides.has(cal.dateStr);
                cell.value = code;
                const st = STATUS_STYLE[code] || STATUS_STYLE[""];
                cell.font = {
                    name: "Arial",
                    size: 8,
                    bold: !!code,
                    color: { argb: st.font },
                };
                cell.alignment = { horizontal: "center", vertical: "middle" };
                if (st.fill)
                    cell.fill = {
                        type: "pattern",
                        pattern: "solid",
                        fgColor: { argb: st.fill },
                    };
                else {
                    const altBg = i % 2 === 0 ? "FFFFFFFF" : "FFF8F9FA";
                    cell.fill = {
                        type: "pattern",
                        pattern: "solid",
                        fgColor: { argb: cal.isSunday ? "FFFFF0F0" : altBg },
                    };
                }
                if (isHrOverride) {
                    cell.border = {
                        top: { style: "medium", color: { argb: "FF7C3AED" } },
                        left: { style: "medium", color: { argb: "FF7C3AED" } },
                        right: { style: "medium", color: { argb: "FF7C3AED" } },
                        bottom: { style: "medium", color: { argb: "FF7C3AED" } },
                    };
                    cell.note = {
                        texts: [
                            {
                                font: { bold: true, size: 9, color: { argb: "FF7C3AED" } },
                                text: "HR Override",
                            },
                        ],
                    };
                } else
                    cell.border = {
                        top: { style: "thin" },
                        left: { style: "thin" },
                        right: { style: "thin" },
                        bottom: { style: "thin" },
                    };
            });
            const vals = [
                emp.totals.P,
                emp.totals.A,
                emp.totals.HD,
                emp.totals.WO,
                emp.totals.CO,
                emp.totals.CL,
                emp.totals.SL,
                emp.totals.PL,
                emp.totals.NHFH,
                emp.totals.Total,
            ];
            vals.forEach((v, si) => {
                const cell = r.getCell(sumStart + si);
                cell.value = v;
                cell.font = { name: "Arial", size: 9, bold: si === sumCols.length - 1 };
                cell.alignment = { horizontal: "center", vertical: "middle" };
                const altBg = i % 2 === 0 ? "FFFFFFFF" : "FFF8F9FA";
                cell.fill = {
                    type: "pattern",
                    pattern: "solid",
                    fgColor: { argb: si === sumCols.length - 1 ? "FFF4B942" : altBg },
                };
                cell.border = {
                    top: { style: "thin" },
                    left: { style: "thin" },
                    right: { style: "thin" },
                    bottom: { style: "thin" },
                };
                colTotals[sumStart + si] = (colTotals[sumStart + si] || 0) + v;
            });
        });
        const totRow = ws.getRow(5 + employees.length);
        totRow.height = 16;
        ws.mergeCells(5 + employees.length, 1, 5 + employees.length, 4);
        const totLabel = totRow.getCell(1);
        totLabel.value = "TOTALS";
        totLabel.font = { name: "Arial", size: 10, bold: true };
        totLabel.alignment = { horizontal: "center", vertical: "middle" };
        totLabel.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF8EA9C1" },
        };
        totLabel.border = {
            top: { style: "medium" },
            left: { style: "medium" },
            right: { style: "thin" },
            bottom: { style: "medium" },
        };
        allDays.forEach((cal, di) => {
            const cell = totRow.getCell(5 + di);
            if (!cal.isFuture) {
                const cnt = employees.filter(
                    (e) => e.dayCodes[cal.dateStr] === "P",
                ).length;
                cell.value = cnt || 0;
            } else {
                cell.value = 0;
            }
            cell.font = { name: "Arial", size: 9, bold: true };
            cell.alignment = { horizontal: "center", vertical: "middle" };
            cell.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: {
                    argb: cal.isSunday
                        ? "FFFFC7CE"
                        : cal.isDeclaredHoliday
                            ? "FFB4C6E7"
                            : "FF8EA9C1",
                },
            };
            cell.border = {
                top: { style: "medium" },
                left: { style: "thin" },
                right: { style: "thin" },
                bottom: { style: "medium" },
            };
        });
        sumCols.forEach((_, si) => {
            const cell = totRow.getCell(sumStart + si);
            cell.value = colTotals[sumStart + si] || 0;
            cell.font = { name: "Arial", size: 10, bold: true };
            cell.alignment = { horizontal: "center", vertical: "middle" };
            cell.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: "FFF4B942" },
            };
            cell.border = {
                top: { style: "medium" },
                left: { style: "thin" },
                right:
                    si === sumCols.length - 1 ? { style: "medium" } : { style: "thin" },
                bottom: { style: "medium" },
            };
        });
        const buffer = await wb.xlsx.writeBuffer();
        const filename = `attendance_${yearMonth}${department && department !== "all" ? `_${department}` : ""}.xlsx`;
        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Cache-Control", "no-store");
        res.send(buffer);
    } catch (err) {
        console.error("[EXPORT-MUSTER]", err.message, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get("/timecard", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { biometricId, from, to } = req.query;
        if (!biometricId || !from || !to) {
            return res
                .status(400)
                .json({ success: false, message: "biometricId, from, to required" });
        }
        const bid = String(biometricId).toUpperCase();
        const settings = await AttendanceSettings.getConfig();
        const thresholds = settings.lateHalfDayPolicy
            ?.cumulativeLateMinsThreshold || { operator: 30, executive: 40 };
        const empDoc = await Employee.findOne({
            $or: [
                { biometricId: bid },
                { "basicInfo.biometricId": bid },
                { "workInfo.biometricId": bid },
            ],
        }).lean();
        const days = await DailyAttendance.find({
            dateStr: { $gte: from, $lte: to },
        })
            .sort({ dateStr: 1 })
            .lean();
        const holidayMap = await loadHolidayMap(from, to);
        const leaveAppsQuery = { fromDate: { $lte: to }, toDate: { $gte: from } };
        if (empDoc) {
            leaveAppsQuery.$or = [{ biometricId: bid }, { employeeId: empDoc._id }];
        } else {
            leaveAppsQuery.biometricId = bid;
        }
        const allLeaveApps = await getLeaveApplication()
            .find(leaveAppsQuery)
            .sort({ applicationDate: -1 })
            .lean();
        const approvedLeaveByDate = new Map();
        for (const lv of allLeaveApps) {
            if (lv.status !== "hr_approved") continue;
            const s = new Date(lv.fromDate + "T00:00:00"),
                e = new Date(lv.toDate + "T00:00:00");
            for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
                const ds = dateStrOf(new Date(d));
                if (!approvedLeaveByDate.has(ds))
                    approvedLeaveByDate.set(
                        ds,
                        LEAVE_TYPE_TO_STATUS[lv.leaveType] || "L-CL",
                    );
            }
        }
        const start = new Date(from + "T00:00:00"),
            end = new Date(to + "T00:00:00");
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const calendar = [];
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            const ds = dateStrOf(new Date(d)),
                dow = d.getDay();
            calendar.push({
                dateStr: ds,
                dayName: new Date(d).toLocaleDateString("en-IN", { weekday: "short" }),
                fullDayName: new Date(d).toLocaleDateString("en-IN", {
                    weekday: "long",
                }),
                dayNum: d.getDate(),
                monthName: new Date(d).toLocaleDateString("en-IN", { month: "short" }),
                isSunday: dow === 0,
                isFuture: d > today,
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
            P: 0,
            "P*": 0,
            "P~": 0,
            HD: 0,
            AB: 0,
            MP: 0,
            WO: 0,
            PH: 0,
            FH: 0,
            NH: 0,
            OH: 0,
            RH: 0,
            leaves: 0,
            unsynced: 0,
            effectivePresent: 0,
            sundayWorked: 0,
            totalLateMins: 0,
            totalOtMins: 0,
            totalNetWorkMins: 0,
            totalBreakMins: 0,
            autoPromotedHDs: 0,
            hrOverrides: 0,
            totalAttendance: 0,
        };
        for (const cal of calendar) {
            if (cal.isFuture) {
                const leaveCode = approvedLeaveByDate.get(cal.dateStr);
                if (leaveCode) {
                    rows.push({
                        ...cal,
                        status: leaveCode,
                        label: getDisplayLabel(leaveCode, settings),
                        synced: false,
                    });
                    if (stats[leaveCode] !== undefined) stats[leaveCode]++;
                    stats.leaves++;
                    stats.totalAttendance++;
                } else if (cal.restStatus) {
                    rows.push({
                        ...cal,
                        status: cal.restStatus,
                        label: getDisplayLabel(cal.restStatus, settings),
                        synced: false,
                    });
                } else {
                    rows.push({ ...cal, status: "FUTURE", label: "—", synced: false });
                }
                continue;
            }
            const dayDoc = byDate.get(cal.dateStr);
            if (!dayDoc) {
                const leaveCode = approvedLeaveByDate.get(cal.dateStr);
                if (leaveCode) {
                    rows.push({
                        ...cal,
                        status: leaveCode,
                        label: getDisplayLabel(leaveCode, settings),
                        synced: false,
                    });
                    if (stats[leaveCode] !== undefined) stats[leaveCode]++;
                    stats.leaves++;
                    stats.totalAttendance++;
                } else if (cal.restStatus) {
                    rows.push({
                        ...cal,
                        status: cal.restStatus,
                        label: getDisplayLabel(cal.restStatus, settings),
                        synced: false,
                    });
                    if (stats[cal.restStatus] !== undefined) stats[cal.restStatus]++;
                    stats.totalAttendance++;
                } else {
                    rows.push({
                        ...cal,
                        status: "UNSYNCED",
                        label: "Not synced",
                        synced: false,
                    });
                    stats.unsynced++;
                }
                continue;
            }
            const entry =
                (dayDoc.employees || []).find((e) => e.biometricId === bid) ||
                (empDoc
                    ? (dayDoc.employees || []).find(
                        (e) => e.employeeDbId?.toString() === empDoc._id.toString(),
                    )
                    : null);
            if (!entry) {
                const s = cal.restStatus || "AB";
                rows.push({
                    ...cal,
                    status: s,
                    label: getDisplayLabel(s, settings),
                    synced: true,
                });
                if (stats[s] !== undefined) stats[s]++;
                if (s !== "AB") stats.totalAttendance++;
                continue;
            }
            if (dayDoc.yearMonth !== lastYM) {
                running.clear();
                lastYM = dayDoc.yearMonth;
            }
            if (!empMeta)
                empMeta = {
                    employeeName: entry.employeeName,
                    department: entry.department,
                    designation: entry.designation,
                    employeeType: entry.employeeType,
                    identityId: entry.identityId,
                    biometricId: entry.biometricId,
                    shiftStart: entry.shiftStart,
                    shiftEnd: entry.shiftEnd,
                    isGhost: !!entry.isGhost,
                };
            let cum = running.get(bid) || 0,
                status = entry.systemPrediction,
                promoted = false;
            if (
                settings.lateHalfDayPolicy?.enabled &&
                entry.isLate &&
                (entry.lateMins || 0) > 0
            ) {
                cum += entry.lateMins;
                const thr = thresholds[entry.employeeType] ?? thresholds.operator ?? 30;
                if (cum >= thr) {
                    status = "HD";
                    promoted = true;
                    cum = 0;
                }
            }
            running.set(bid, cum);
            const finalStatus = entry.hrFinalStatus || status;
            if (isEffectivelyPresent({ ...entry, systemPrediction: finalStatus }))
                stats.effectivePresent++;
            if (stats[finalStatus] !== undefined) stats[finalStatus]++;
            if (["L-CL", "L-SL", "L-EL", "LWP", "WFH", "CO"].includes(finalStatus))
                stats.leaves++;
            const paidCodes = [
                "P",
                "P*",
                "P~",
                "HD",
                "WO",
                "FH",
                "NH",
                "OH",
                "RH",
                "PH",
                "L-CL",
                "L-SL",
                "L-EL",
                "WFH",
                "CO",
            ];
            if (paidCodes.includes(finalStatus)) stats.totalAttendance++;
            stats.totalLateMins += entry.lateMins || 0;
            stats.totalOtMins += entry.otMins || 0;
            stats.totalNetWorkMins += entry.netWorkMins || 0;
            stats.totalBreakMins += entry.totalBreakMins || 0;
            if (promoted) stats.autoPromotedHDs++;
            if (entry.hrFinalStatus) stats.hrOverrides++;
            if (cal.isSunday && (entry.punchCount || 0) > 0) stats.sundayWorked++;
            rows.push({
                ...cal,
                status: finalStatus,
                label: getDisplayLabel(finalStatus, settings),
                synced: true,
                isSundayWorked: cal.isSunday && (entry.punchCount || 0) > 0,
                inTime: entry.inTime,
                lunchOut: entry.lunchOut,
                lunchIn: entry.lunchIn,
                teaOut: entry.teaOut,
                teaIn: entry.teaIn,
                finalOut: entry.finalOut,
                punchCount: entry.punchCount,
                rawPunches: entry.rawPunches || [],
                netWorkMins: entry.netWorkMins || 0,
                totalBreakMins: entry.totalBreakMins || 0,
                lunchBreakMins: entry.lunchBreakMins || 0,
                teaBreakMins: entry.teaBreakMins || 0,
                totalSpanMins: entry.totalSpanMins || 0,
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
                shiftStart: shift.start,
                shiftEnd: shift.end,
                isGhost: false,
            };
        }
        const leaveApplications = allLeaveApps.map((lv) => ({
            _id: lv._id,
            leaveType: lv.leaveType,
            status: lv.status,
            fromDate: lv.fromDate,
            toDate: lv.toDate,
            totalDays: lv.totalDays,
            reason: lv.reason,
            applicationDate: lv.applicationDate,
            isHalfDay: lv.isHalfDay || false,
            halfDaySlot: lv.halfDaySlot || null,
            rejectionReason: lv.rejectionReason || null,
            hrRemarks: lv.hrRemarks || null,
            managerDecisions: lv.managerDecisions || [],
        }));
        res.json({
            success: true,
            from,
            to,
            biometricId: bid,
            employee: empMeta,
            rows,
            stats,
            leaveApplications,
            displayLabels: settings.displayLabels || {},
        });
    } catch (err) {
        console.error("[TIMECARD]", err.message, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get("/employees-list", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const settings = await AttendanceSettings.getConfig();
        const emps = await Employee.find({
            $or: [
                { status: "active" },
                { status: { $exists: false } },
                { isActive: true },
            ],
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
            .sort((a, b) =>
                (a.employeeName || "").localeCompare(b.employeeName || ""),
            );
        res.json({ success: true, data: list, count: list.length });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get(
    "/departments-with-designations",
    EmployeeAuthMiddlewear,
    async (req, res) => {
        try {
            const emps = await Employee.find({
                $or: [
                    { status: "active" },
                    { status: { $exists: false } },
                    { isActive: true },
                ],
            }).lean();
            const byDepartment = {},
                allDepartments = new Set(),
                allDesignations = new Set();
            for (const e of emps) {
                const dept = String(extractDepartment(e) || "")
                    .toUpperCase()
                    .trim(),
                    desig = String(extractDesignation(e) || "")
                        .toUpperCase()
                        .trim();
                const validDept = dept && dept !== "—" && dept !== "N/A",
                    validDesig = desig && desig !== "—" && desig !== "N/A";
                if (validDept) allDepartments.add(dept);
                if (validDesig) allDesignations.add(desig);
                if (validDept && validDesig) {
                    if (!byDepartment[dept]) byDepartment[dept] = new Set();
                    byDepartment[dept].add(desig);
                }
            }
            const byDepartmentArray = {};
            for (const [dept, designs] of Object.entries(byDepartment))
                byDepartmentArray[dept] = [...designs].sort();
            res.json({
                success: true,
                departments: [...allDepartments].sort(),
                designations: [...allDesignations].sort(),
                byDepartment: byDepartmentArray,
            });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    },
);

// ═══════════════════════════════════════════════════════════════════════════
//  REGULARIZATION REQUESTS — full CRUD
// ═══════════════════════════════════════════════════════════════════════════

router.get("/regularizations", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const {
            status,
            department,
            from,
            to,
            requestType,
            employeeId,
            page = 1,
            limit = 50,
        } = req.query;
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
        const total = await getRegularizationRequest().countDocuments(filter);
        const list = await getRegularizationRequest()
            .find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit))
            .lean();
        const all = await getRegularizationRequest().find({}).lean();
        const stats = {
            total: all.length,
            pending: all.filter((a) => a.status === "pending").length,
            manager_approved: all.filter((a) => a.status === "manager_approved")
                .length,
            manager_rejected: all.filter((a) => a.status === "manager_rejected")
                .length,
            hr_approved: all.filter((a) => a.status === "hr_approved").length,
            hr_rejected: all.filter((a) => a.status === "hr_rejected").length,
            cancelled: all.filter((a) => a.status === "cancelled").length,
            byType: {
                miss_punch: all.filter((a) => a.requestType === "miss_punch").length,
                late_arrival: all.filter((a) => a.requestType === "late_arrival")
                    .length,
                early_departure: all.filter((a) => a.requestType === "early_departure")
                    .length,
                wrong_status: all.filter((a) => a.requestType === "wrong_status")
                    .length,
                other: all.filter((a) => a.requestType === "other").length,
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

router.get("/regularizations/:id", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const r = await getRegularizationRequest().findById(req.params.id).lean();
        if (!r)
            return res.status(404).json({ success: false, message: "Not found" });
        res.json({ success: true, data: r });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post("/regularizations", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const {
            employeeId,
            biometricId,
            employeeName,
            department,
            designation,
            requestType,
            dateStr,
            reason,
            proposedInTime,
            proposedOutTime,
            proposedStatus,
            proposedRemarks,
            documentUrl,
            documentFileId,
            documentFileName,
            managersNotified,
        } = req.body;
        if (!employeeId || !dateStr || !reason)
            return res
                .status(400)
                .json({
                    success: false,
                    message: "employeeId, dateStr and reason are required",
                });
        let originalSnapshot = {
            inTime: null,
            finalOut: null,
            systemPrediction: null,
            hrFinalStatus: null,
            netWorkMins: 0,
            lateMins: 0,
            otMins: 0,
            punchCount: 0,
            rawPunches: [],
        };
        const dayDoc = await DailyAttendance.findOne({ dateStr }).lean();
        if (dayDoc && biometricId) {
            const entry = (dayDoc.employees || []).find(
                (e) => e.biometricId === String(biometricId).toUpperCase(),
            );
            if (entry)
                originalSnapshot = {
                    inTime: entry.inTime || null,
                    finalOut: entry.finalOut || null,
                    systemPrediction: entry.systemPrediction || null,
                    hrFinalStatus: entry.hrFinalStatus || null,
                    netWorkMins: entry.netWorkMins || 0,
                    lateMins: entry.lateMins || 0,
                    otMins: entry.otMins || 0,
                    punchCount: entry.punchCount || 0,
                    rawPunches: entry.rawPunches || [],
                };
        }
        const doc = await getRegularizationRequest().create({
            employeeId,
            biometricId: biometricId ? String(biometricId).toUpperCase() : null,
            employeeName,
            department,
            designation,
            requestType: requestType || "miss_punch",
            dateStr,
            reason,
            proposedInTime: proposedInTime || null,
            proposedOutTime: proposedOutTime || null,
            proposedStatus: proposedStatus || null,
            proposedRemarks: proposedRemarks || null,
            proposedPunchType: req.body.proposedPunchType || null,
            proposedPunchTime: req.body.proposedPunchTime || null,
            proposedPunchAction: req.body.proposedPunchAction || null,
            proposedPunches: Array.isArray(req.body.proposedPunches)
                ? req.body.proposedPunches
                : [],
            documentUrl: documentUrl || null,
            documentFileId: documentFileId || null,
            documentFileName: documentFileName || null,
            documentUploadedAt: documentUrl ? new Date() : null,
            originalSnapshot,
            managersNotified: Array.isArray(managersNotified) ? managersNotified : [],
            status: "pending",
        });
        res
            .status(201)
            .json({
                success: true,
                data: doc,
                message: "Regularization request submitted",
            });
    } catch (err) {
        console.error("[REG-CREATE]", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

router.patch(
    "/regularizations/:id/manager-decision",
    EmployeeAuthMiddlewear,
    async (req, res) => {
        try {
            const { managerId, managerName, type, decision, remarks } = req.body;
            if (!["approved", "rejected"].includes(decision))
                return res
                    .status(400)
                    .json({
                        success: false,
                        message: "decision must be approved or rejected",
                    });
            const r = await getRegularizationRequest().findById(req.params.id);
            if (!r)
                return res.status(404).json({ success: false, message: "Not found" });
            if (!["pending", "manager_approved"].includes(r.status))
                return res
                    .status(400)
                    .json({
                        success: false,
                        message: `Cannot record manager decision on status ${r.status}`,
                    });
            r.managerDecisions.push({
                managerId,
                managerName,
                type: type || "primary",
                decision,
                remarks: remarks || "",
                decidedAt: new Date(),
            });
            if (decision === "rejected") r.status = "manager_rejected";
            else r.status = "manager_approved";
            await r.save();
            res.json({ success: true, data: r });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    },
);

router.patch(
    "/regularizations/:id/hr-approve",
    EmployeeAuthMiddlewear,
    async (req, res) => {
        try {
            const r = await getRegularizationRequest().findById(req.params.id);
            if (!r)
                return res.status(404).json({ success: false, message: "Not found" });
            if (r.status === "hr_approved")
                return res
                    .status(400)
                    .json({ success: false, message: "Already approved" });
            r.status = "hr_approved";
            r.hrApprovedBy = req.user.id;
            r.hrApprovedAt = new Date();
            r.hrRemarks = req.body?.remarks || "";
            const punchChanges = [];
            const bid = r.biometricId;
            if (bid) {
                const dayDoc = await DailyAttendance.findOne({ dateStr: r.dateStr });
                if (dayDoc) {
                    const idx = (dayDoc.employees || []).findIndex(
                        (e) => e.biometricId === bid,
                    );
                    if (idx !== -1) {
                        const emp = dayDoc.employees[idx];
                        const punchFieldMap = {
                            in: "inTime",
                            lunch_out: "lunchOut",
                            lunch_in: "lunchIn",
                            tea_out: "teaOut",
                            tea_in: "teaIn",
                            out: "finalOut",
                        };
                        if (r.proposedInTime) {
                            const oldT = emp.inTime ? fmtTimeIST12(emp.inTime) : "—";
                            emp.inTime = parseTimeOnDateIST(r.proposedInTime, r.dateStr);
                            punchChanges.push({
                                punchType: "in",
                                action: "modify",
                                oldTime: oldT,
                                newTime: fmtTimeIST12(emp.inTime),
                            });
                        }
                        if (r.proposedOutTime) {
                            const oldT = emp.finalOut ? fmtTimeIST12(emp.finalOut) : "—";
                            emp.finalOut = parseTimeOnDateIST(r.proposedOutTime, r.dateStr);
                            punchChanges.push({
                                punchType: "out",
                                action: "modify",
                                oldTime: oldT,
                                newTime: fmtTimeIST12(emp.finalOut),
                            });
                        }
                        if (r.proposedPunchType && r.proposedPunchAction) {
                            const fieldName = punchFieldMap[r.proposedPunchType];
                            if (fieldName) {
                                const oldT = emp[fieldName]
                                    ? fmtTimeIST12(emp[fieldName])
                                    : "—";
                                if (r.proposedPunchAction === "remove") {
                                    emp[fieldName] = null;
                                    emp.rawPunches = (emp.rawPunches || []).filter(
                                        (p) => p.punchType !== r.proposedPunchType,
                                    );
                                    punchChanges.push({
                                        punchType: r.proposedPunchType,
                                        action: "remove",
                                        oldTime: oldT,
                                        newTime: "removed",
                                    });
                                } else if (r.proposedPunchTime) {
                                    const newDate = parseTimeOnDateIST(
                                        r.proposedPunchTime,
                                        r.dateStr,
                                    );
                                    emp[fieldName] = newDate;
                                    const existingIdx = (emp.rawPunches || []).findIndex(
                                        (p) => p.punchType === r.proposedPunchType,
                                    );
                                    const entry = {
                                        time: newDate,
                                        punchType: r.proposedPunchType,
                                        source: "miss_punch",
                                        addedBy: req.user?.id,
                                        addedAt: new Date(),
                                    };
                                    if (existingIdx >= 0)
                                        emp.rawPunches[existingIdx] = {
                                            ...emp.rawPunches[existingIdx],
                                            ...entry,
                                        };
                                    else emp.rawPunches = [...(emp.rawPunches || []), entry];
                                    punchChanges.push({
                                        punchType: r.proposedPunchType,
                                        action: r.proposedPunchAction,
                                        oldTime: oldT,
                                        newTime: fmtTimeIST12(newDate),
                                    });
                                }
                            }
                        }
                        for (const pc of r.proposedPunches || []) {
                            const fieldName = punchFieldMap[pc.punchType];
                            if (!fieldName) continue;
                            const oldT = emp[fieldName] ? fmtTimeIST12(emp[fieldName]) : "—";
                            if (pc.action === "remove") {
                                emp[fieldName] = null;
                                emp.rawPunches = (emp.rawPunches || []).filter(
                                    (p) => p.punchType !== pc.punchType,
                                );
                                punchChanges.push({
                                    punchType: pc.punchType,
                                    action: "remove",
                                    oldTime: oldT,
                                    newTime: "removed",
                                });
                            } else if (pc.punchTime) {
                                const newDate = parseTimeOnDateIST(pc.punchTime, r.dateStr);
                                emp[fieldName] = newDate;
                                const existingIdx = (emp.rawPunches || []).findIndex(
                                    (p) => p.punchType === pc.punchType,
                                );
                                const entry = {
                                    time: newDate,
                                    punchType: pc.punchType,
                                    source: "miss_punch",
                                    addedBy: req.user?.id,
                                    addedAt: new Date(),
                                };
                                if (existingIdx >= 0)
                                    emp.rawPunches[existingIdx] = {
                                        ...emp.rawPunches[existingIdx],
                                        ...entry,
                                    };
                                else emp.rawPunches = [...(emp.rawPunches || []), entry];
                                punchChanges.push({
                                    punchType: pc.punchType,
                                    action: pc.action,
                                    oldTime: oldT,
                                    newTime: fmtTimeIST12(newDate),
                                });
                            }
                        }
                        emp.rawPunches = (emp.rawPunches || [])
                            .filter((p) => p.time)
                            .sort((a, b) => new Date(a.time) - new Date(b.time))
                            .map((p, i) => ({ ...p, seq: i + 1 }));
                        emp.punchCount = emp.rawPunches.length;
                        if (
                            r.proposedInTime ||
                            r.proposedOutTime ||
                            r.proposedPunchType ||
                            (r.proposedPunches || []).length > 0
                        ) {
                            const settings = await AttendanceSettings.getConfig();
                            const shift =
                                settings.shifts[emp.employeeType] || settings.shifts.executive;
                            const shiftStart = hhmmMins(shift.start),
                                shiftEnd = hhmmMins(shift.end),
                                inMins = minsOf(emp.inTime),
                                outMins = minsOf(emp.finalOut);
                            const totalSpanMins =
                                emp.inTime && emp.finalOut
                                    ? Math.round((emp.finalOut - emp.inTime) / 60000)
                                    : 0;
                            const lunchBreakMins =
                                emp.lunchOut && emp.lunchIn
                                    ? Math.max(
                                        0,
                                        Math.round((emp.lunchIn - emp.lunchOut) / 60000),
                                    )
                                    : 0;
                            const teaBreakMins =
                                emp.teaOut && emp.teaIn
                                    ? Math.max(0, Math.round((emp.teaIn - emp.teaOut) / 60000))
                                    : 0;
                            const totalBreakMins = lunchBreakMins + teaBreakMins,
                                netWorkMins = Math.max(0, totalSpanMins - totalBreakMins);
                            const effectiveGrace =
                                (shift.lateGraceMins || 0) + (emp.appliedExtraGraceMins || 0);
                            const lateMins =
                                inMins != null
                                    ? Math.max(0, inMins - (shiftStart + effectiveGrace))
                                    : 0;
                            const earlyDepartureMins =
                                outMins != null ? Math.max(0, shiftEnd - outMins) : 0;
                            let otMins = 0;
                            if (emp.employeeType === "operator" && outMins != null) {
                                const over = outMins - shiftEnd - (shift.otGraceMins || 0);
                                if (over > 0) otMins = over;
                            }
                            emp.totalSpanMins = totalSpanMins;
                            emp.lunchBreakMins = lunchBreakMins;
                            emp.teaBreakMins = teaBreakMins;
                            emp.totalBreakMins = totalBreakMins;
                            emp.netWorkMins = netWorkMins;
                            emp.lateMins = lateMins;
                            emp.lateDisplay = fmtLateMins(lateMins);
                            emp.isLate = lateMins > 0;
                            emp.earlyDepartureMins = earlyDepartureMins;
                            emp.isEarlyDeparture = earlyDepartureMins > 0;
                            emp.otMins = otMins;
                            emp.hasOT = otMins > 0;
                            emp.hasMissPunch = !(emp.inTime && emp.finalOut);
                            if (!emp.inTime) emp.systemPrediction = "AB";
                            else if (!emp.finalOut) emp.systemPrediction = "MP";
                            else if (netWorkMins < (shift.halfDayThresholdMins || 240))
                                emp.systemPrediction = "HD";
                            else if (lateMins > 0) emp.systemPrediction = "P*";
                            else if (earlyDepartureMins > 0) emp.systemPrediction = "P~";
                            else emp.systemPrediction = "P";
                        }
                        if (r.proposedStatus) emp.hrFinalStatus = r.proposedStatus;
                        emp.hrRemarks = r.hrRemarks || `Regularized (${r.requestType})`;
                        emp.hrReviewedAt = new Date();
                        emp.attendanceValue = getAttendanceValue(
                            emp.hrFinalStatus || emp.systemPrediction,
                        );
                        dayDoc.markModified("employees");
                        await dayDoc.save();
                        r.appliedToAttendance = true;
                        r.appliedAt = new Date();
                    }
                }
            }
            await r.save();
            res.json({
                success: true,
                data: r,
                message: "Approved and applied to attendance",
            });
        } catch (err) {
            console.error("[REG-APPROVE]", err.message);
            res.status(500).json({ success: false, message: err.message });
        }
    },
);

router.patch(
    "/regularizations/:id/hr-reject",
    EmployeeAuthMiddlewear,
    async (req, res) => {
        try {
            const r = await getRegularizationRequest().findById(req.params.id);
            if (!r)
                return res.status(404).json({ success: false, message: "Not found" });
            r.status = "hr_rejected";
            r.rejectedBy = req.user.id;
            r.rejectedAt = new Date();
            r.rejectionReason = req.body?.rejectionReason || "";
            await r.save();
            res.json({ success: true, data: r });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    },
);

router.patch(
    "/regularizations/:id/cancel",
    EmployeeAuthMiddlewear,
    async (req, res) => {
        try {
            const r = await getRegularizationRequest().findById(req.params.id);
            if (!r)
                return res.status(404).json({ success: false, message: "Not found" });
            if (["hr_approved", "hr_rejected", "cancelled"].includes(r.status))
                return res
                    .status(400)
                    .json({
                        success: false,
                        message: `Cannot cancel from status ${r.status}`,
                    });
            r.status = "cancelled";
            r.cancelledBy = req.user.id;
            r.cancelledAt = new Date();
            r.cancelReason = req.body?.cancelReason || "";
            await r.save();
            res.json({ success: true, data: r });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    },
);

// ═══════════════════════════════════════════════════════════════════════════
//  HOLIDAYS
// ═══════════════════════════════════════════════════════════════════════════

router.get("/holidays", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { year } = req.query;
        const filter = year
            ? { date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } }
            : {};
        const list = await getCompanyHoliday()
            .find(filter)
            .sort({ date: 1 })
            .lean();
        res.json({ success: true, data: list });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post("/holidays", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { date, name, description, type } = req.body;
        if (!date || !name)
            return res
                .status(400)
                .json({ success: false, message: "date and name required" });
        const h = await getCompanyHoliday().findOneAndUpdate(
            { date },
            {
                date,
                name,
                description,
                type: type || "company",
                createdBy: req.user.id,
            },
            { new: true, upsert: true },
        );
        try {
            await syncDay(date);
        } catch (e) {
            console.warn("[HOLIDAY] re-sync failed:", e.message);
        }
        res.status(201).json({ success: true, data: h });
    } catch (err) {
        if (err.code === 11000)
            return res
                .status(400)
                .json({ success: false, message: "Holiday already exists" });
        res.status(500).json({ success: false, message: err.message });
    }
});

router.delete("/holidays/:id", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const h = await getCompanyHoliday().findByIdAndDelete(req.params.id);
        if (h?.date) {
            try {
                await syncDay(h.date);
            } catch (e) {
                console.warn("[HOLIDAY-DEL] re-sync failed:", e.message);
            }
        }
        res.json({ success: true, message: "Holiday removed" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ATTENDANCE PUNCH NOTIFICATIONS + SETTINGS
// ═══════════════════════════════════════════════════════════════════════════

const HRNotifSettingsSchema = new mongoose.Schema(
    {
        singleton: { type: String, default: "global", unique: true },
        checkin_missing: { type: Boolean, default: true },
        lunch_missing: { type: Boolean, default: true },
        checkout_missing: { type: Boolean, default: true },
        yesterday_digest: { type: Boolean, default: true },
    },
    { _id: false },
);
const HRNotifSettings =
    mongoose.models.HRNotificationSettings ||
    mongoose.model("HRNotificationSettings", HRNotifSettingsSchema);

function istDateStr(offsetDays = 0) {
    const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000 + offsetDays * 86400000);
    return d.toISOString().slice(0, 10);
}

async function getNotifSettings() {
    try {
        return (
            (await HRNotifSettings.findOne({ singleton: "global" }).lean()) || {
                checkin_missing: true,
                lunch_missing: true,
                checkout_missing: true,
                yesterday_digest: true,
            }
        );
    } catch (_) {
        return {
            checkin_missing: true,
            lunch_missing: true,
            checkout_missing: true,
            yesterday_digest: true,
        };
    }
}

async function getLeaveEmployeeIds(dateStr) {
    const apps = await getLeaveApplication()
        .find({
            startDate: { $lte: new Date(dateStr + "T23:59:59Z") },
            endDate: { $gte: new Date(dateStr + "T00:00:00Z") },
            status: { $in: ["hr_approved", "manager_approved", "pending"] },
        })
        .select("employeeId")
        .lean();
    return new Set(apps.map((a) => String(a.employeeId)));
}

async function notifyHR(title, body, issues, dateStr) {
    let pushOk = false;
    try {
        const { messaging } = require("../../config/firebaseAdmin");
        const HRDept = require("../../models/HR_Models/HRDepartment");
        const hrList = await HRDept.find({ isActive: { $ne: false } })
            .select("fcmTokens")
            .lean();
        const tokens = hrList.flatMap((h) => h.fcmTokens || []).filter(Boolean);
        if (tokens.length) {
            let sent = 0;
            for (const token of tokens) {
                try {
                    await messaging.send({
                        token,
                        notification: { title, body },
                        webpush: {
                            notification: { title, body, icon: "/logo.png" },
                            fcmOptions: { link: "/hr/dashboard/attendance" },
                        },
                    });
                    sent++;
                } catch (_) { }
            }
            pushOk = sent > 0;
        }
    } catch (_) { }
    if (!pushOk && issues?.length && emailService?._send) {
        try {
            const HRDept = require("../../models/HR_Models/HRDepartment");
            const hrList = await HRDept.find({ isActive: { $ne: false } })
                .select("email name")
                .lean();
            const toList = hrList
                .filter((h) => h.email)
                .map((h) => ({ email: h.email, name: h.name }));
            if (!toList.length) return;
            const rows = issues
                .map(
                    (i) =>
                        `<tr><td style="padding:9px 12px;font-size:13px;font-weight:600">${i.name}</td><td style="padding:9px 12px;font-size:13px;color:#555">${i.empId}</td><td style="padding:9px 12px;font-size:13px;color:#555">${i.dept}</td><td style="padding:9px 12px"><span style="background:${i.bg};color:${i.color};padding:3px 8px;border-radius:99px;font-size:11px;font-weight:700">${i.issue}</span></td></tr>`,
                )
                .join("");
            const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto"><div style="background:#1a1a2e;padding:20px 28px;border-radius:10px 10px 0 0"><h2 style="color:#fff;margin:0;font-size:17px">${title}</h2><p style="color:#aaa;margin:4px 0 0;font-size:12px">Date: ${dateStr} · Push notification could not be delivered</p></div><div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;padding:20px 28px"><table style="width:100%;border-collapse:collapse"><thead><tr style="background:#f7fafc"><th style="padding:9px 12px;text-align:left;font-size:12px">Name</th><th style="padding:9px 12px;text-align:left;font-size:12px">ID</th><th style="padding:9px 12px;text-align:left;font-size:12px">Dept</th><th style="padding:9px 12px;text-align:left;font-size:12px">Issue</th></tr></thead><tbody>${rows}</tbody></table><p style="font-size:12px;color:#888;margin-top:16px">Grav HR System · Automated alert</p></div></div>`;
            for (const hr of toList) {
                await emailService
                    ._send({
                        to: [hr],
                        subject: `${title} [${dateStr}]`,
                        htmlContent: html,
                        textContent:
                            body +
                            "\n\n" +
                            issues
                                .map((i) => `${i.name} (${i.empId}) — ${i.issue}`)
                                .join("\n"),
                    })
                    .catch(() => { });
            }
        } catch (_) { }
    }
}

async function runCheckinAlert() {
    try {
        const s = await getNotifSettings();
        if (!s.checkin_missing) return;
        const today = istDateStr();
        const onLeave = await getLeaveEmployeeIds(today);
        const doc = await DailyAttendance.findOne({ dateStr: today }).lean();
        if (!doc?.employees?.length) return;
        const bioIds = doc.employees.map((e) => e.biometricId).filter(Boolean);
        const empDocs = await Employee.find({ biometricId: { $in: bioIds } })
            .select("firstName lastName biometricId department _id")
            .lean();
        const empMap = Object.fromEntries(empDocs.map((e) => [e.biometricId, e]));
        const missing = [];
        for (const emp of doc.employees) {
            if (emp.inTime) continue;
            const st = emp.hrFinalStatus || emp.systemPrediction;
            if (["WO", "PH", "on_leave", "FH", "NH", "OH", "RH"].includes(st))
                continue;
            const ed = empMap[emp.biometricId];
            if (ed && onLeave.has(String(ed._id))) continue;
            missing.push({
                name: ed
                    ? `${ed.firstName} ${ed.lastName}`
                    : emp.employeeName || emp.biometricId,
                empId: emp.biometricId || "—",
                dept: ed?.department || "—",
                issue: "No Check-In",
                bg: "#fee2e2",
                color: "#b91c1c",
            });
        }
        if (!missing.length) return;
        const names =
            missing
                .slice(0, 3)
                .map((m) => m.name)
                .join(", ") +
            (missing.length > 3 ? ` +${missing.length - 3} more` : "");
        await notifyHR(
            `⚠️ ${missing.length} employee(s) haven't checked in`,
            `${names} — no punch & no approved leave as of 10:15 AM.`,
            missing,
            today,
        );
        console.log(`[PunchNotif] 10:15 check-in: ${missing.length} missing`);
    } catch (e) {
        console.error("[PunchNotif] checkin:", e.message);
    }
}

async function runLunchAlert(type) {
    try {
        const s = await getNotifSettings();
        if (!s.lunch_missing) return;
        const today = istDateStr();
        const doc = await DailyAttendance.findOne({ dateStr: today }).lean();
        if (!doc?.employees?.length) return;
        const bioIds = doc.employees.map((e) => e.biometricId).filter(Boolean);
        const empDocs = await Employee.find({ biometricId: { $in: bioIds } })
            .select("firstName lastName biometricId department")
            .lean();
        const empMap = Object.fromEntries(empDocs.map((e) => [e.biometricId, e]));
        const missing = [];
        for (const emp of doc.employees) {
            if (!emp.inTime) continue;
            const st = emp.hrFinalStatus || emp.systemPrediction;
            if (["AB", "WO", "PH", "on_leave", "FH", "NH", "OH", "RH"].includes(st))
                continue;
            if (emp.employeeType !== "operator") continue;
            if (type === "lunch_in" && !emp.lunchIn) {
                /* missing */
            } else if (type === "lunch_out" && emp.lunchIn && !emp.lunchOut) {
                /* missing */
            } else continue;
            const ed = empMap[emp.biometricId];
            missing.push({
                name: ed
                    ? `${ed.firstName} ${ed.lastName}`
                    : emp.employeeName || emp.biometricId,
                empId: emp.biometricId || "—",
                dept: ed?.department || "—",
                issue: type === "lunch_in" ? "No Lunch-In" : "No Lunch-Out",
                bg: "#fef3c7",
                color: "#92400e",
            });
        }
        if (!missing.length) return;
        const label = type === "lunch_in" ? "lunch-in" : "lunch-out";
        await notifyHR(
            `🍽️ ${missing.length} employee(s) missing ${label} punch`,
            `${missing.length} operator(s) haven't recorded ${label}.`,
            missing,
            today,
        );
        console.log(`[PunchNotif] ${label}: ${missing.length} missing`);
    } catch (e) {
        console.error("[PunchNotif] lunch:", e.message);
    }
}

async function runCheckoutAlert() {
    try {
        const s = await getNotifSettings();
        if (!s.checkout_missing) return;
        const today = istDateStr();
        const doc = await DailyAttendance.findOne({ dateStr: today }).lean();
        if (!doc?.employees?.length) return;
        const bioIds = doc.employees.map((e) => e.biometricId).filter(Boolean);
        const empDocs = await Employee.find({ biometricId: { $in: bioIds } })
            .select("firstName lastName biometricId department")
            .lean();
        const empMap = Object.fromEntries(empDocs.map((e) => [e.biometricId, e]));
        const missing = [];
        for (const emp of doc.employees) {
            if (!emp.inTime || emp.finalOut) continue;
            const st = emp.hrFinalStatus || emp.systemPrediction;
            if (["AB", "WO", "PH", "on_leave", "FH", "NH", "OH", "RH"].includes(st))
                continue;
            const ed = empMap[emp.biometricId];
            missing.push({
                name: ed
                    ? `${ed.firstName} ${ed.lastName}`
                    : emp.employeeName || emp.biometricId,
                empId: emp.biometricId || "—",
                dept: ed?.department || "—",
                issue: "No Check-Out",
                bg: "#ffedd5",
                color: "#9a3412",
            });
        }
        if (!missing.length) return;
        await notifyHR(
            `🚪 ${missing.length} employee(s) missing check-out`,
            `${missing.length} employee(s) punched in but haven't checked out.`,
            missing,
            today,
        );
        console.log(`[PunchNotif] 18:00 checkout: ${missing.length} missing`);
    } catch (e) {
        console.error("[PunchNotif] checkout:", e.message);
    }
}

async function runYesterdayDigest() {
    try {
        const s = await getNotifSettings();
        if (!s.yesterday_digest) return;
        const yesterday = istDateStr(-1);
        const onLeave = await getLeaveEmployeeIds(yesterday);
        const doc = await DailyAttendance.findOne({ dateStr: yesterday }).lean();
        if (!doc?.employees?.length) return;
        const bioIds = doc.employees.map((e) => e.biometricId).filter(Boolean);
        const empDocs = await Employee.find({ biometricId: { $in: bioIds } })
            .select("firstName lastName biometricId department _id")
            .lean();
        const empMap = Object.fromEntries(empDocs.map((e) => [e.biometricId, e]));
        const issues = [];
        for (const emp of doc.employees) {
            const st = emp.hrFinalStatus || emp.systemPrediction;
            if (["WO", "PH", "on_leave", "FH", "NH", "OH", "RH"].includes(st))
                continue;
            const ed = empMap[emp.biometricId];
            if (ed && onLeave.has(String(ed._id))) continue;
            const name = ed
                ? `${ed.firstName} ${ed.lastName}`
                : emp.employeeName || emp.biometricId;
            const dept = ed?.department || "—";
            const empId = emp.biometricId || "—";
            if (!emp.inTime && !emp.hrFinalStatus)
                issues.push({
                    name,
                    empId,
                    dept,
                    issue: "Absent / No Record",
                    bg: "#fee2e2",
                    color: "#b91c1c",
                });
            else if (emp.inTime && !emp.finalOut && !emp.isMissPunchSettled)
                issues.push({
                    name,
                    empId,
                    dept,
                    issue: "Missing Check-Out",
                    bg: "#ffedd5",
                    color: "#9a3412",
                });
            else if (
                emp.inTime &&
                !emp.lunchIn &&
                emp.employeeType === "operator" &&
                !emp.isMissPunchSettled
            )
                issues.push({
                    name,
                    empId,
                    dept,
                    issue: "No Lunch-In",
                    bg: "#fef3c7",
                    color: "#92400e",
                });
        }
        if (!issues.length) return;
        await notifyHR(
            `📋 Yesterday's unresolved punch issues [${yesterday}]`,
            `${issues.length} unresolved attendance issue(s) from yesterday need fixing.`,
            issues,
            yesterday,
        );
        if (emailService?._send) {
            try {
                const HRDept = require("../../models/HR_Models/HRDepartment");
                const hrList = await HRDept.find({ isActive: { $ne: false } })
                    .select("email name")
                    .lean();
                const toList = hrList
                    .filter((h) => h.email)
                    .map((h) => ({ email: h.email, name: h.name }));
                const rows = issues
                    .map(
                        (i) =>
                            `<tr><td style="padding:8px 12px;font-size:13px">${i.name}</td><td style="padding:8px 12px;font-size:13px;color:#555">${i.empId}</td><td style="padding:8px 12px;font-size:13px;color:#555">${i.dept}</td><td style="padding:8px 12px"><span style="background:${i.bg};color:${i.color};padding:2px 8px;border-radius:99px;font-size:11px;font-weight:700">${i.issue}</span></td></tr>`,
                    )
                    .join("");
                const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto"><div style="background:#1a1a2e;padding:20px 28px;border-radius:10px 10px 0 0"><h2 style="color:#fff;margin:0;font-size:17px">📋 Yesterday's Attendance Digest</h2><p style="color:#aaa;margin:4px 0 0;font-size:12px">${yesterday} · ${issues.length} unresolved issue(s)</p></div><div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;padding:20px 28px"><table style="width:100%;border-collapse:collapse"><thead><tr style="background:#f7fafc"><th style="padding:9px 12px;text-align:left;font-size:12px">Name</th><th style="padding:9px 12px;text-align:left;font-size:12px">ID</th><th style="padding:9px 12px;text-align:left;font-size:12px">Dept</th><th style="padding:9px 12px;text-align:left;font-size:12px">Issue</th></tr></thead><tbody>${rows}</tbody></table><p style="font-size:11px;color:#888;margin-top:16px">Grav HR System · Please log in and resolve before payroll.</p></div></div>`;
                for (const hr of toList) {
                    await emailService
                        ._send({
                            to: [hr],
                            subject: `📋 Attendance Digest [${yesterday}] — ${issues.length} issues`,
                            htmlContent: html,
                            textContent:
                                `Yesterday digest for ${yesterday}:\n\n` +
                                issues
                                    .map((i) => `${i.name} (${i.empId}) — ${i.issue}`)
                                    .join("\n"),
                        })
                        .catch(() => { });
                }
            } catch (_) { }
        }
        console.log(`[PunchNotif] Yesterday digest: ${issues.length} issues`);
    } catch (e) {
        console.error("[PunchNotif] digest:", e.message);
    }
}

function startPunchNotificationCrons() {
    const tz = { timezone: "Asia/Kolkata", scheduled: true };
    cron.schedule("15 10 * * 1-6", runCheckinAlert, tz);
    cron.schedule("30 13 * * 1-6", () => runLunchAlert("lunch_in"), tz);
    cron.schedule("30 14 * * 1-6", () => runLunchAlert("lunch_out"), tz);
    cron.schedule("0 18  * * 1-6", runCheckoutAlert, tz);
    cron.schedule("0 9   * * *", runYesterdayDigest, tz);
    console.log("[PunchNotif] ✅ 5 punch notification crons scheduled (IST)");
}

router.get(
    "/notification-settings",
    EmployeeAuthMiddlewear,
    async (req, res) => {
        try {
            let s = await HRNotifSettings.findOne({ singleton: "global" }).lean();
            if (!s) s = await HRNotifSettings.create({ singleton: "global" });
            res.json({ success: true, data: s });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    },
);

router.put(
    "/notification-settings",
    EmployeeAuthMiddlewear,
    async (req, res) => {
        try {
            const allowed = [
                "checkin_missing",
                "lunch_missing",
                "checkout_missing",
                "yesterday_digest",
            ];
            const update = {};
            allowed.forEach((k) => {
                if (req.body[k] !== undefined) update[k] = req.body[k];
            });
            const s = await HRNotifSettings.findOneAndUpdate(
                { singleton: "global" },
                { $set: update },
                { new: true, upsert: true },
            );
            res.json({ success: true, data: s });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    },
);

router.post(
    "/notification-subscribe",
    EmployeeAuthMiddlewear,
    async (req, res) => {
        try {
            const { fcmToken } = req.body;
            if (!fcmToken)
                return res
                    .status(400)
                    .json({ success: false, message: "fcmToken required" });
            try {
                const HRDept = require("../../models/HR_Models/HRDepartment");
                const hr = await HRDept.findById(req.user.id);
                if (hr) {
                    if (!hr.fcmTokens) hr.fcmTokens = [];
                    if (!hr.fcmTokens.includes(fcmToken)) {
                        hr.fcmTokens = [...hr.fcmTokens.slice(-4), fcmToken];
                        await hr.save();
                    }
                }
            } catch (_) { }
            res.json({ success: true, message: "Token saved" });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    },
);

router.post("/notification-test", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { messaging } = require("../../config/firebaseAdmin");
        const HRDept = require("../../models/HR_Models/HRDepartment");
        const hr = await HRDept.findById(req.user.id).select("fcmTokens").lean();
        const tokens = hr?.fcmTokens || [];
        if (!tokens.length)
            return res.json({
                success: false,
                message: "No push tokens registered. Enable notifications first.",
            });
        let sent = 0;
        for (const token of tokens) {
            try {
                await messaging.send({
                    token,
                    notification: {
                        title: "✅ HRMS Alerts Active",
                        body: "Punch notifications are working!",
                    },
                    webpush: {
                        notification: {
                            title: "✅ HRMS Alerts Active",
                            body: "Punch notifications are working!",
                            icon: "/logo.png",
                        },
                    },
                });
                sent++;
            } catch (_) { }
        }
        res.json({ success: true, message: `Test sent to ${sent} device(s)` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get("/missed-punches", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const dateStr = req.query.date || istDateStr();
        const onLeave = await getLeaveEmployeeIds(dateStr);
        const doc = await DailyAttendance.findOne({ dateStr }).lean();
        if (!doc?.employees?.length)
            return res.json({ success: true, data: [], count: 0 });
        const bioIds = doc.employees.map((e) => e.biometricId).filter(Boolean);
        const empDocs = await Employee.find({ biometricId: { $in: bioIds } })
            .select("firstName lastName biometricId department designation _id")
            .lean();
        const empMap = Object.fromEntries(empDocs.map((e) => [e.biometricId, e]));
        const issues = [];
        for (const emp of doc.employees) {
            const st = emp.hrFinalStatus || emp.systemPrediction;
            const ed = empMap[emp.biometricId];
            if (["WO", "PH", "on_leave", "FH", "NH", "OH", "RH"].includes(st))
                continue;
            if (ed && onLeave.has(String(ed._id))) continue;
            const base = {
                biometricId: emp.biometricId,
                name: ed
                    ? `${ed.firstName} ${ed.lastName}`
                    : emp.employeeName || emp.biometricId,
                department: ed?.department || "—",
                inTime: emp.inTime,
                finalOut: emp.finalOut,
                lunchIn: emp.lunchIn,
            };
            if (!emp.inTime && !emp.hrFinalStatus)
                issues.push({ ...base, issueType: "no_checkin", severity: "high" });
            else if (emp.inTime && !emp.finalOut)
                issues.push({ ...base, issueType: "no_checkout", severity: "medium" });
            else if (emp.inTime && !emp.lunchIn && emp.employeeType === "operator")
                issues.push({ ...base, issueType: "no_lunch_in", severity: "low" });
            else if (emp.lunchIn && !emp.lunchOut)
                issues.push({ ...base, issueType: "no_lunch_out", severity: "low" });
        }
        res.json({
            success: true,
            data: issues,
            count: issues.length,
            date: dateStr,
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get("/calendar", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { biometricId, employeeId, yearMonth } = req.query;
        if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth))
            return res
                .status(400)
                .json({ success: false, message: "yearMonth required (YYYY-MM)" });
        let bid = biometricId;
        if (!bid && employeeId) {
            const emp = await Employee.findById(employeeId)
                .select("biometricId")
                .lean();
            bid = emp?.biometricId;
        }
        if (!bid)
            return res
                .status(400)
                .json({
                    success: false,
                    message: "biometricId or employeeId required",
                });
        bid = String(bid).toUpperCase();
        const [y, m] = yearMonth.split("-").map(Number);
        const from = `${yearMonth}-01`,
            last = new Date(y, m, 0).getDate(),
            to = `${yearMonth}-${String(last).padStart(2, "0")}`;
        const docs = await DailyAttendance.find({
            dateStr: { $gte: from, $lte: to },
        }).lean();
        const summary = {
            present: 0,
            absent: 0,
            onLeave: 0,
            halfDay: 0,
            weeklyOff: 0,
            late: 0,
        };
        const data = [];
        for (const doc of docs) {
            const emp = (doc.employees || []).find((e) => e.biometricId === bid);
            if (!emp) continue;
            const st = emp.hrFinalStatus || emp.systemPrediction;
            if (["P", "P*", "P~", "MP"].includes(st)) summary.present++;
            else if (st === "AB") summary.absent++;
            else if (st?.startsWith("L-") || st === "LWP" || st === "CO")
                summary.onLeave++;
            else if (st === "HD") summary.halfDay++;
            else if (["WO", "FH", "NH", "OH", "RH"].includes(st)) summary.weeklyOff++;
            if (emp.isLate) summary.late++;
            data.push({ date: doc.dateStr, ...emp });
        }
        res.json({ success: true, data, summary });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  MIGRATION: Backfill leave applications + reconcile balances
//
//  WHY THIS EXISTS:
//    Old createAutoLeave had a MongoDB path conflict bug ($setOnInsert on
//    'consumed' object + $inc on 'consumed.CL' in one op) that silently
//    crashed the balance update. Applications were created but consumed
//    was never incremented for those employees.
//
//  TWO-PHASE APPROACH:
//
//  Phase 1 — scan DailyAttendance for L-CL/L-SL/L-EL hrFinalStatus and
//             create missing LeaveApplications. Employees who already have
//             an application for that date are skipped (no duplicates).
//
//  Phase 2 — count leave days DIRECTLY from DailyAttendance (the ground
//             truth) grouped by (employeeId, year, leaveType). Then set
//             LeaveBalance.consumed to max(current, attendance-derived count)
//             for each type so balances reflect reality without losing any
//             legitimate manual HR adjustments.
//
//             NOTE: Phase 2 reads from DailyAttendance, NOT from
//             LeaveApplications, because the LeaveApplication schema may not
//             have a `source` field — Mongoose strict mode drops it on save,
//             making source-based queries unreliable.
//
//  SAFE to run multiple times — fully idempotent.
//  POST /api/hr/attendance/backfill-hr-leaves
// ═══════════════════════════════════════════════════════════════════════════
router.post("/backfill-hr-leaves", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const LEAVE_STATUSES = ["L-CL", "L-SL", "L-EL"];
        let config;
        try {
            config = await getLeaveConfig().getConfig();
        } catch (_) {
            config = { clPerYear: 5, slPerYear: 5, plPerYear: 18 };
        }

        // ── Load all attendance days that have any leave status ────────────
        const dayDocs = await DailyAttendance.find({
            "employees.hrFinalStatus": { $in: LEAVE_STATUSES },
        }).lean();

        console.log(
            `[BACKFILL] Found ${dayDocs.length} day docs with leave status`,
        );

        // ── Build employee lookup cache (bid → empDoc) ─────────────────────
        const empCache = new Map();
        async function getEmpDoc(bid) {
            if (empCache.has(bid)) return empCache.get(bid);
            const doc = await Employee.findOne({
                $or: [
                    { biometricId: bid },
                    { "basicInfo.biometricId": bid },
                    { "workInfo.biometricId": bid },
                ],
            }).lean();
            empCache.set(bid, doc || null);
            return doc;
        }

        // ══════════════════════════════════════════════════════════════════
        //  PHASE 1 — create missing LeaveApplications
        // ══════════════════════════════════════════════════════════════════
        let appsCreated = 0,
            appsExisted = 0,
            appsSkipped = 0,
            appsErrors = 0;
        const details = [];

        for (const dayDoc of dayDocs) {
            for (const emp of dayDoc.employees) {
                if (!LEAVE_STATUSES.includes(emp.hrFinalStatus)) continue;
                const leaveType = LEAVE_STATUS_MAP[emp.hrFinalStatus];
                const bid = String(emp.biometricId || "").toUpperCase();
                const ds = dayDoc.dateStr;
                if (!bid || !leaveType) continue;

                // Check for an existing application on this specific date
                // (no source filter — source may not be saved by Mongoose strict mode)
                const existing = await getLeaveApplication().findOne({
                    biometricId: bid,
                    fromDate: ds,
                    toDate: ds,
                    leaveType,
                    status: {
                        $nin: ["cancelled", "rejected", "hr_rejected", "manager_rejected"],
                    },
                });
                if (existing) {
                    appsExisted++;
                    continue; // Phase 2 will still fix the balance
                }

                const empDoc = await getEmpDoc(bid);
                if (!empDoc) {
                    // Ghost employee — no Employee record, can't create application
                    appsSkipped++;
                    details.push({ bid, ds, leaveType, action: "skipped_ghost" });
                    continue;
                }

                try {
                    const empName =
                        [empDoc.firstName, empDoc.middleName, empDoc.lastName]
                            .filter(Boolean)
                            .join(" ")
                            .trim() ||
                        empDoc.fullName ||
                        empDoc.name ||
                        empDoc.basicInfo?.fullName ||
                        "Unknown";
                    await getLeaveApplication().create({
                        employeeId: empDoc._id,
                        biometricId: bid,
                        employeeName: empName,
                        designation:
                            empDoc.designation || empDoc.workInfo?.designation || "—",
                        department: empDoc.department || empDoc.workInfo?.department || "—",
                        leaveType,
                        applicationDate: ds,
                        fromDate: ds,
                        toDate: ds,
                        totalDays: 1,
                        reason: emp.hrRemarks || `HR override: ${emp.hrFinalStatus}`,
                        isHalfDay: false,
                        status: "hr_approved",
                        hrApprovedAt: emp.hrReviewedAt || new Date(),
                        hrRemarks: emp.hrRemarks || "Backfilled from attendance record",
                        appliedToAttendance: true,
                        appliedAt: emp.hrReviewedAt || new Date(),
                    });
                    appsCreated++;
                    details.push({ bid, ds, leaveType, action: "app_created" });
                } catch (e) {
                    appsErrors++;
                    details.push({ bid, ds, leaveType, error: e.message });
                }
            }
        }

        // ══════════════════════════════════════════════════════════════════
        //  PHASE 2 — reconcile LeaveBalance.consumed from DailyAttendance
        //
        //  Count leave days per (employeeDbId, year, leaveType) directly from
        //  attendance records. This is the authoritative source regardless of
        //  whether LeaveApplications were created correctly or not.
        // ══════════════════════════════════════════════════════════════════

        // Map: `${empDbId}_${year}` → { empId, biometricId, year, CL: N, SL: N, PL: N }
        const attendanceCounts = new Map();

        for (const dayDoc of dayDocs) {
            const year = parseInt(dayDoc.dateStr.split("-")[0], 10);
            for (const emp of dayDoc.employees) {
                const leaveType = LEAVE_STATUS_MAP[emp.hrFinalStatus];
                if (!leaveType) continue;

                // Need a real DB employeeId — ghost employees have no _id
                let empDbId = emp.employeeDbId ? String(emp.employeeDbId) : null;
                if (!empDbId) {
                    // Try to resolve from Employee collection
                    const bid = String(emp.biometricId || "").toUpperCase();
                    const empDoc = await getEmpDoc(bid);
                    if (!empDoc) continue; // Ghost — can't update balance
                    empDbId = String(empDoc._id);
                }

                const bid = String(emp.biometricId || "").toUpperCase();
                const key = `${empDbId}_${year}`;
                if (!attendanceCounts.has(key)) {
                    attendanceCounts.set(key, {
                        empId: empDbId,
                        biometricId: bid,
                        year,
                        CL: 0,
                        SL: 0,
                        PL: 0,
                    });
                }
                attendanceCounts.get(key)[leaveType]++;
            }
        }

        console.log(
            `[BACKFILL] Phase 2: ${attendanceCounts.size} unique (employee, year) pairs to reconcile`,
        );

        let balFixed = 0,
            balCreated = 0,
            balOk = 0,
            balErrors = 0;

        for (const [, expected] of attendanceCounts) {
            try {
                let bal = await getLeaveBalance().findOne({
                    employeeId: expected.empId,
                    year: expected.year,
                });

                if (!bal) {
                    // No balance doc at all — create with the attendance-derived counts
                    await getLeaveBalance().create({
                        employeeId: expected.empId,
                        biometricId: expected.biometricId,
                        year: expected.year,
                        entitlement: {
                            CL: config.clPerYear || 5,
                            SL: config.slPerYear || 5,
                            PL: config.plPerYear || 18,
                        },
                        consumed: { CL: expected.CL, SL: expected.SL, PL: expected.PL },
                    });
                    balCreated++;
                    continue;
                }

                // Balance doc exists — set consumed = max(current, attendance-derived)
                // per type. Never reduce an existing value (could be from regular leaves).
                let changed = false;
                for (const type of ["CL", "SL", "PL"]) {
                    const curr = bal.consumed[type] || 0;
                    const exp = expected[type] || 0;
                    if (curr < exp) {
                        bal.consumed[type] = exp;
                        changed = true;
                    }
                }

                if (changed) {
                    bal.markModified("consumed");
                    await bal.save();
                    balFixed++;
                } else {
                    balOk++;
                }
            } catch (e) {
                balErrors++;
                console.error(
                    "[BACKFILL-P2]",
                    expected.empId,
                    expected.year,
                    e.message,
                );
            }
        }

        res.json({
            success: true,
            message: [
                `Backfill complete.`,
                `Phase 1 (applications): ${appsCreated} created, ${appsExisted} already existed, ${appsSkipped} ghost-skipped, ${appsErrors} errors.`,
                `Phase 2 (balances): ${balFixed} fixed, ${balCreated} created fresh, ${balOk} already correct, ${balErrors} errors.`,
            ].join(" "),
            summary: {
                phase1_apps: {
                    created: appsCreated,
                    alreadyExisted: appsExisted,
                    ghostSkipped: appsSkipped,
                    errors: appsErrors,
                },
                phase2_balances: {
                    fixed: balFixed,
                    createdFresh: balCreated,
                    alreadyCorrect: balOk,
                    errors: balErrors,
                },
            },
            details,
        });
    } catch (err) {
        console.error("[BACKFILL-HR-LEAVES]", err);
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
module.exports.startPunchNotificationCrons = startPunchNotificationCrons;
module.exports.startHourlyAttendanceSync = startHourlyAttendanceSync;
module.exports.syncTodayOnly = syncTodayOnly;