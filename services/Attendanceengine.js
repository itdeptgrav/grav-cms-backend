/**
 * Attendanceengine.js  –  v5  (GRAV Clothing)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FIX FOR "Failed to parse number 'GR001'":
 *   Old code used MongoDB $toInt: "$biometricId" which FAILS if biometricId
 *   contains letters like "GR001". We now use pure JavaScript normalisation
 *   BEFORE the DB query — strip letters in JS, query with the clean numeric
 *   string using $in on biometricId directly.
 *
 * EMPLOYEE TYPE POLICY:
 *   "operator"  → 6 punches (In/LunchOut/LunchIn/TeaOut/TeaIn/Out), OT counted
 *   "executive" → 2 punches (In/Out only), NO OT, no break deduction
 *
 * DEPARTMENT ENRICHMENT:
 *   eTimeOffice does NOT return department. We always look it up from
 *   the Employee record by matching biometricId. If no Employee found,
 *   department shows as "—".
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
//  ID NORMALISATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip any prefix like "GR", "#", leading zeros and return a plain integer.
 *   normalizeId("GR072") → 72
 *   normalizeId("#0001") → 1
 *   normalizeId("0072")  → 72
 *   normalizeId("72")    → 72
 *   normalizeId(72)      → 72
 *   normalizeId(null)    → null
 */
function normalizeId(raw) {
    if (raw === null || raw === undefined || raw === "") return null;
    const numStr = String(raw).replace(/[^0-9]/g, "");
    if (!numStr) return null;
    return parseInt(numStr, 10);
}



/**
 * Given a list of raw biometric ID strings from eTimeOffice (e.g. ["0001","0072"]),
 * build a map: numericInt → Employee document.
 *
 * HOW MATCHING WORKS (pure JS, no $toInt MongoDB):
 *   - eTimeOffice gives us "0072"
 *   - normalizeId("0072") = 72
 *   - Employee.biometricId might be "0072" or "72" or "GR072" — all normalise to 72
 *   - We fetch ALL employees, strip their biometricId in JS, build a map by integer
 *   - This is safe and never causes MongoDB parse errors
 *
 * Returns: { 72: EmployeeDoc, 1: EmployeeDoc, ... }
 */
async function buildEmployeeMap(Employee, rawBiometricIds) {
    // Get all numeric IDs we're looking for
    const targetNums = new Set(
        rawBiometricIds.map(normalizeId).filter((n) => n !== null)
    );
    if (targetNums.size === 0) return {};

    // Fetch all active employees — we filter in JS
    // (GRAV has ~100 employees; this is fine; scales to 10k without issue)
    const employees = await Employee.find(
        { isActive: true },
        "biometricId identityId firstName lastName department designation employeeType jobTitle"
    ).lean();

    const map = {}; // numericId → empDoc
    for (const emp of employees) {
        const n = normalizeId(emp.biometricId);
        if (n !== null && targetNums.has(n)) {
            map[n] = emp;
        }
    }
    return map;
}

/**
 * Look up a single employee by any form of their ID.
 * Returns the Employee doc or null.
 */
async function findEmployeeByRawId(Employee, rawId) {
    const target = normalizeId(rawId);
    if (target === null) return null;
    const employees = await Employee.find(
        { isActive: true },
        "biometricId identityId firstName lastName department designation employeeType"
    ).lean();
    return employees.find((e) => normalizeId(e.biometricId) === target) || null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TIME HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function minsToHHMM(mins) {
    if (!mins || mins <= 0) return "00:00";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function hhmmToMins(str) {
    if (!str || str === "--:--") return 0;
    const [h, m] = String(str).split(":").map(Number);
    return (isNaN(h) ? 0 : h * 60) + (isNaN(m) ? 0 : m);
}

// Date → minutes from midnight, UTC
function dateToMins(d) {
    if (!d) return 0;
    const dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt.getTime())) return 0;
    return dt.getUTCHours() * 60 + dt.getUTCMinutes();
}

function fmtTime(dt) {
    if (!dt) return "--:--";
    const d = new Date(dt);
    if (isNaN(d.getTime())) return "--:--";
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PUNCH ROLE ASSIGNMENT
// ─────────────────────────────────────────────────────────────────────────────

const MCID_ROLE_MAP = {
    1: "in",
    2: "out",
    3: "lunch_out",
    4: "lunch_in",
    5: "tea_out",
    6: "tea_in",
};

const SEQ_OPERATOR = ["in", "lunch_out", "lunch_in", "tea_out", "tea_in", "out"];
const SEQ_EXECUTIVE = ["in", "out"];

/**
 * Sort punches by time, assign punchType roles.
 * Uses mcid if available, else sequential by employeeType.
 */
function assignPunchRoles(rawPunches, employeeType = "operator") {
    if (!rawPunches || rawPunches.length === 0) return [];
    const sorted = [...rawPunches].sort((a, b) => {
        const ta = new Date(a.time || a.punchTime || 0).getTime();
        const tb = new Date(b.time || b.punchTime || 0).getTime();
        return ta - tb;
    });

    const hasMcid = sorted.some((p) => p.mcid != null);
    if (hasMcid) {
        sorted.forEach((p) => { p.punchType = MCID_ROLE_MAP[p.mcid] || "unknown"; });
    } else {
        const seq = employeeType === "executive" ? SEQ_EXECUTIVE : SEQ_OPERATOR;
        sorted.forEach((p, i) => { p.punchType = seq[i] || "unknown"; });
    }
    return sorted;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CORE DAY COMPUTATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fill all computed fields on a record object from its rawPunches.
 * Mutates and returns the record.
 *
 * Sets systemPrediction — never touches hrFinalStatus.
 */
function computeDay(record, settings, employeeType, holidays = []) {
    const type = employeeType || record.employeeType || "operator";
    const holidayDates = new Set((holidays || []).map((h) => h.date));
    const workingDays = settings.workingDays || [1, 2, 3, 4, 5, 6];
    const dateStr = record.dateStr;

    if (!dateStr) return record;

    const dow = new Date(dateStr + "T00:00:00Z").getUTCDay();

    // ── Special flags (short-circuit) ────────────────────────────────────
    if (!workingDays.includes(dow) && !record.isOnLeave) {
        record.isWeeklyOff = true;
        record.systemPrediction = "WO";
        return record;
    }
    if (holidayDates.has(dateStr) && !record.isOnLeave) {
        record.isHoliday = true;
        const h = (holidays || []).find((x) => x.date === dateStr);
        record.holidayName = h?.name || null;
        record.holidayType = h?.type || null;
        record.systemPrediction = "PH";
        return record;
    }
    if (record.isOnLeave) {
        const lt = (record.leaveType || "").toUpperCase();
        record.systemPrediction = ["CL", "SL", "EL", "LWP", "CO"].includes(lt)
            ? `L-${lt}` : "L-CL";
        return record;
    }

    // ── Assign punch roles ───────────────────────────────────────────────
    record.rawPunches = assignPunchRoles(record.rawPunches || [], type);
    record.punchCount = record.rawPunches.length;

    const byType = (t) => record.rawPunches.find((p) => p.punchType === t);
    const getTime = (p) => p?.time || p?.punchTime || null;

    const p_in = byType("in");
    const p_lo = byType("lunch_out");
    const p_li = byType("lunch_in");
    const p_to = byType("tea_out");
    const p_ti = byType("tea_in");
    const p_out = byType("out");

    record.inTime = getTime(p_in) || null;
    record.finalOut = getTime(p_out) || null;

    if (type === "operator") {
        record.lunchOut = getTime(p_lo) || null;
        record.lunchIn = getTime(p_li) || null;
        record.teaOut = getTime(p_to) || null;
        record.teaIn = getTime(p_ti) || null;
    } else {
        record.lunchOut = null; record.lunchIn = null;
        record.teaOut = null; record.teaIn = null;
    }

    if (!record.inTime) { record.systemPrediction = "AB"; return record; }
    if (!record.finalOut) {
        record.hasMissPunch = true;
        record.systemPrediction = "MP";
        return record;
    }

    // ── Breaks (operators only) ──────────────────────────────────────────
    let lunchMins = 0, teaMins = 0;
    if (type === "operator") {
        if (record.lunchOut && record.lunchIn) {
            const diff = Math.round((new Date(record.lunchIn) - new Date(record.lunchOut)) / 60000);
            if (diff > 0) lunchMins = diff;
        }
        if (record.teaOut && record.teaIn) {
            const diff = Math.round((new Date(record.teaIn) - new Date(record.teaOut)) / 60000);
            if (diff > 0) teaMins = diff;
        }
    }
    record.lunchBreakMins = lunchMins;
    record.teaBreakMins = teaMins;
    record.totalBreakMins = lunchMins + teaMins;

    // ── Span & net work ──────────────────────────────────────────────────
    const spanMins = Math.max(
        0,
        Math.round((new Date(record.finalOut) - new Date(record.inTime)) / 60000)
    );
    record.totalSpanMins = spanMins;
    record.netWorkMins = Math.max(0, spanMins - record.totalBreakMins);

    // ── Late ─────────────────────────────────────────────────────────────
    const shiftStartMins = hhmmToMins(settings.shiftStart || "09:00");
    const lateThresh = settings.lateThresholdMinutes ?? 15;
    const inMins = dateToMins(record.inTime);
    const rawLate = inMins - shiftStartMins;
    record.isLate = rawLate > lateThresh;
    record.lateMins = record.isLate ? rawLate : 0;

    // ── Early departure ──────────────────────────────────────────────────
    const shiftEndMins = hhmmToMins(settings.shiftEnd || "18:30");
    const earlyThresh = settings.earlyDepartureThresholdMinutes ?? 30;
    const outMins = dateToMins(record.finalOut);
    const rawEarly = shiftEndMins - outMins;
    record.isEarlyDeparture = rawEarly > earlyThresh;
    record.earlyDepartureMins = record.isEarlyDeparture ? Math.max(0, rawEarly) : 0;

    // ── OT (operators only) ──────────────────────────────────────────────
    if (type === "operator" && settings.overtimeEnabled !== false) {
        const grace = settings.otGracePeriodMins ?? 30;
        const minOT = settings.overtimeMinimumMinutes ?? 0;
        const otStart = shiftEndMins + grace;
        record.otMins = Math.max(0, outMins - otStart);
        record.hasOT = record.otMins > minOT;
    } else {
        record.otMins = 0;
        record.hasOT = false;
    }

    // ── Miss punch check for operators ───────────────────────────────────
    if (type === "operator") {
        const required = new Set(["in", "lunch_out", "lunch_in", "tea_out", "tea_in", "out"]);
        const present = new Set(record.rawPunches.map((p) => p.punchType));
        if ([...required].some((r) => !present.has(r))) {
            record.hasMissPunch = true;
        }
    }

    // ── Derive systemPrediction ──────────────────────────────────────────
    const halfDayThresh = settings.halfDayThresholdMinutes ?? 270;
    if (record.netWorkMins < halfDayThresh) {
        record.systemPrediction = "HD";
    } else if (record.isEarlyDeparture) {
        record.systemPrediction = "P~";
    } else if (record.isLate) {
        record.systemPrediction = "P*";
    } else {
        record.systemPrediction = "P";
    }

    return record;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MONTH SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

function computeMonthSummary(dayRecords) {
    const s = {
        present: 0, late: 0, earlyOut: 0, halfDay: 0,
        absent: 0, weeklyOff: 0, holiday: 0, onLeave: 0,
        missPunch: 0, totalOTMins: 0, totalNetWorkMins: 0, netWorkDays: 0,
    };
    for (const d of dayRecords) {
        const st = d.hrFinalStatus ?? d.systemPrediction ?? d.status;
        switch (st) {
            case "P": s.present++; break;
            case "P*": s.present++; s.late++; break;
            case "P~": s.present++; s.earlyOut++; break;
            case "HD": s.halfDay++; break;
            case "AB": s.absent++; break;
            case "WO": s.weeklyOff++; break;
            case "PH": s.holiday++; break;
            case "L-CL": case "L-SL": case "L-EL":
            case "LWP": case "CO": s.onLeave++; break;
            case "MP": s.missPunch++; s.present++; break;
        }
        s.totalOTMins += d.otMins || 0;
        s.totalNetWorkMins += d.netWorkMins || 0;
    }
    s.netWorkDays = s.present + s.halfDay * 0.5;
    return s;
}

// ─────────────────────────────────────────────────────────────────────────────
//  RECORD BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a full attendance record object ready for DB upsert.
 * empDoc comes from buildEmployeeMap() — may be null for unknown employees.
 * Department is ALWAYS from the Employee record, not from eTimeOffice.
 */
function buildAttendanceRecord(inOutRec, punchDetail, empDoc, settings, holidays) {
    const dateStr = inOutRec.dateStr;
    const yearMonth = dateStr ? dateStr.substring(0, 7) : "";
    const dateObj = new Date(dateStr + "T00:00:00Z");
    const type = empDoc?.employeeType || "operator";
    const numericId = normalizeId(inOutRec.biometricId);
    const identityId = empDoc?.identityId || "";

    // Build employee name from Employee record; fall back to eTimeOffice name
    const empName = empDoc
        ? `${empDoc.firstName || ""} ${empDoc.lastName || ""}`.trim()
        : inOutRec.name || "";

    // Department ALWAYS from Employee record — eTimeOffice doesn't supply it
    const department = empDoc?.department || "—";
    const designation = empDoc?.designation || empDoc?.jobTitle || "—";

    // Build rawPunches — prefer MCID detail API, fallback to InOut summary
    let rawPunches = [];
    if (punchDetail?.punches?.length) {
        rawPunches = punchDetail.punches.map((p, i) => ({
            seq: i + 1,
            time: p.time || p.punchTime,
            mcid: p.mcid ?? null,
            mFlag: p.mFlag || null,
            punchType: "unknown",
            source: "device",
        }));
    } else {
        if (inOutRec.inTime) rawPunches.push({ seq: 1, time: inOutRec.inTime, mcid: 1, punchType: "in", source: "device" });
        if (inOutRec.finalOut) rawPunches.push({ seq: 2, time: inOutRec.finalOut, mcid: 2, punchType: "out", source: "device" });
    }

    const record = {
        biometricId: inOutRec.biometricId,
        numericId,
        identityId,
        employeeDbId: empDoc?._id || null,
        employeeName: empName,
        department,
        designation,
        employeeType: type,
        date: dateObj,
        dateStr,
        yearMonth,
        shiftName: settings.shiftName || "GEN",
        shiftStart: settings.shiftStart || "09:00",
        shiftEnd: settings.shiftEnd || "18:30",
        rawPunches,
        punchCount: rawPunches.length,
        // initialise all computed fields
        lunchBreakMins: 0, teaBreakMins: 0, totalBreakMins: 0,
        totalSpanMins: 0, netWorkMins: 0, otMins: 0,
        isLate: false, lateMins: 0,
        isEarlyDeparture: false, earlyDepartureMins: 0,
        hasOT: false, hasMissPunch: false,
        isWeeklyOff: false, isHoliday: false,
        holidayName: null, holidayType: null,
        isOnLeave: false, leaveType: null,
        systemPrediction: "AB",
        hrFinalStatus: null,   // HR has not reviewed yet
        etimeRemark: inOutRec.etimeRemark || "",
        etimeStatus: inOutRec.etimeStatus || "",
        syncedAt: new Date(),
        syncSource: "api",
    };

    computeDay(record, settings, type, holidays);
    return record;
}

/**
 * Build a placeholder record (AB / WO / PH) for days with no punch from device.
 */
function buildPlaceholderRecord(biometricId, empDoc, dateStr, settings, holidays) {
    const numericId = normalizeId(biometricId);
    const yearMonth = dateStr ? dateStr.substring(0, 7) : "";
    const type = empDoc?.employeeType || "operator";
    const identityId = empDoc?.identityId || "";
    const empName = empDoc ? `${empDoc.firstName || ""} ${empDoc.lastName || ""}`.trim() : "";

    const record = {
        biometricId,
        numericId,
        identityId,
        employeeDbId: empDoc?._id || null,
        employeeName: empName,
        department: empDoc?.department || "—",
        designation: empDoc?.designation || "—",
        employeeType: type,
        date: new Date(dateStr + "T00:00:00Z"),
        dateStr,
        yearMonth,
        shiftStart: settings.shiftStart || "09:00",
        shiftEnd: settings.shiftEnd || "18:30",
        rawPunches: [],
        punchCount: 0,
        isWeeklyOff: false, isHoliday: false,
        holidayName: null, holidayType: null,
        isOnLeave: false,
        systemPrediction: "AB",
        hrFinalStatus: null,
        syncedAt: new Date(),
        syncSource: "api",
    };

    computeDay(record, settings, type, holidays);
    return record;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ETIMEOFFICE RESPONSE PARSERS
// ─────────────────────────────────────────────────────────────────────────────

function parseInOutResponse(raw) {
    if (!raw) return [];
    const arr = raw.InOutPunchData || raw.Data || (Array.isArray(raw) ? raw : []);
    if (!Array.isArray(arr) || !arr.length) return [];

    return arr.map((item) => {
        const biometricId = String(
            item.Empcode || item.EmpCode || item.empCode || ""
        ).trim();
        const dateRaw = item.AttDate || item.Date || item.date || "";
        let dateStr = "";

        if (dateRaw.includes("/")) {
            const parts = dateRaw.split("/");
            if (parts.length === 3) {
                if (parts[0].length === 4) {
                    // YYYY/MM/DD
                    dateStr = `${parts[0]}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}`;
                } else {
                    // MM/DD/YYYY
                    dateStr = `${parts[2]}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
                }
            }
        } else if (dateRaw.includes("-")) {
            dateStr = dateRaw.split("T")[0];
        }

        const parseTime = (ts) => {
            if (!ts || ts === "--:--" || ts === "00:00") return null;
            try {
                const clean = String(ts).trim().padStart(5, "0");
                return new Date(`${dateStr}T${clean}:00Z`);
            } catch { return null; }
        };

        return {
            biometricId,
            name: item.Name || item.name || "",
            dateStr,
            inTime: parseTime(item.INTime || item.InTime || item.inTime),
            finalOut: parseTime(item.OUTTime || item.OutTime || item.outTime),
            etimeStatus: String(item.Status || item.status || ""),
            etimeRemark: String(item.Remark || item.remark || ""),
            department: "", // intentionally blank — we get this from Employee record
        };
    }).filter((r) => r.biometricId && r.dateStr);
}

function parsePunchDataResponse(raw) {
    if (!raw) return {};
    const arr = raw.PunchData || raw.Data || (Array.isArray(raw) ? raw : []);
    if (!Array.isArray(arr) || !arr.length) return {};

    const map = {};
    for (const item of arr) {
        const biometricId = String(
            item.Empcode || item.EmpCode || item.empCode || ""
        ).trim();
        if (!biometricId) continue;

        const rawDt = item.PunchDate || item.AttDate || item.Date || "";
        let dateStr = "";
        const cleaned = String(rawDt).split("T")[0].split("_")[0];
        if (cleaned.includes("/")) {
            const parts = cleaned.split("/");
            if (parts.length === 3) {
                if (parts[0].length === 4) {
                    dateStr = `${parts[0]}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}`;
                } else {
                    dateStr = `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
                }
            }
        } else if (cleaned.includes("-")) {
            dateStr = cleaned;
        }
        if (!dateStr) continue;

        const punchTimeRaw = String(item.PunchTime || item.AttTime || item.Time || "").trim();
        let punchDate = null;
        try {
            // Handle formats: "HH:MM" or "HH:MM:SS" or "DD/MM/YYYY_HH:MM"
            let timePart = punchTimeRaw;
            if (timePart.includes("_")) timePart = timePart.split("_")[1];
            if (timePart) {
                punchDate = new Date(`${dateStr}T${timePart.length <= 5 ? timePart + ":00" : timePart}Z`);
                if (isNaN(punchDate.getTime())) punchDate = null;
            }
        } catch { punchDate = null; }

        const key = `${biometricId}_${dateStr}`;
        if (!map[key]) map[key] = { biometricId, dateStr, name: item.Name || "", punches: [] };
        map[key].punches.push({
            time: punchDate,
            mcid: item.MCID != null ? parseInt(item.MCID, 10) : null,
            mFlag: item.MFlag || item.M_Flag || null,
            source: "device",
        });
    }

    for (const k of Object.keys(map)) {
        map[k].punches.sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));
    }
    return map;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENRICH RECORD (add formatted string fields for frontend)
// ─────────────────────────────────────────────────────────────────────────────

function enrichRecord(r) {
    const effectiveStatus = r.hrFinalStatus ?? r.systemPrediction ?? r.status ?? "AB";
    return {
        ...r,
        effectiveStatus,
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
        hrReviewed: r.hrFinalStatus !== null && r.hrFinalStatus !== undefined,
        statusMismatch: r.hrFinalStatus !== null && r.hrFinalStatus !== r.systemPrediction,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
    normalizeId,
    buildEmployeeMap,
    findEmployeeByRawId,
    minsToHHMM,
    hhmmToMins,
    assignPunchRoles,
    computeDay,
    computeMonthSummary,
    buildAttendanceRecord,
    buildPlaceholderRecord,
    parseInOutResponse,
    parsePunchDataResponse,
    enrichRecord,
};
