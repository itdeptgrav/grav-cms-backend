/**
 * attendanceEngine.js  –  v4  (GRAV Clothing)
 * ─────────────────────────────────────────────────────────────────────────────
 * Core business logic for attendance calculation.
 *
 * KEY FIXES vs v3:
 *  1. Uses DownloadInOutPunchData (the "In/Out" API) as PRIMARY source
 *     → gives us INTime, OUTTime, WorkTime, OverTime, Status, Remark, Late_In, Erl_Out
 *  2. Also uses DownloadPunchDataMCID (API2) to get individual punches with mcid
 *     → mcid 1=In, 2=Out, 3=BreakOut, 4=BreakIn  (eTimeOffice spec)
 *  3. Single check-in → status "MP" (miss-punch / pending checkout), NEVER absent
 *  4. 2-punch logic: P1=in, P2=out (full day possible). NOT auto half-day.
 *  5. Half-day only when netWork < halfDayThreshold (default 4.5 hrs = 270 min)
 *  6. OT grace: duty ends 18:30 → OT only starts after 19:00 (grace=30 min)
 *  7. Remark parsing: "MIS-LT" = late, "P/2" = half-day flag from device
 *  8. Break auto-apply: if no explicit break punches but span >= 5h → apply 45min lunch
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

// ── Time helpers ──────────────────────────────────────────────────────────────

/** "HH:MM" → minutes from midnight */
function timeToMins(str) {
    if (!str || str === "--:--") return null;
    const parts = str.split(":");
    if (parts.length < 2) return null;
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
}

/** Date object → minutes from midnight (local time) */
function dateToMins(dt) {
    if (!dt) return null;
    const d = new Date(dt);
    return d.getHours() * 60 + d.getMinutes();
}

/** minutes → "HH:MM" */
function minsToHHMM(mins) {
    if (mins === null || mins === undefined || isNaN(mins)) return "00:00";
    const abs = Math.abs(Math.round(mins));
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" + "HH:MM" → Date */
function combineDateTime(dateStr, timeStr) {
    if (!dateStr || !timeStr || timeStr === "--:--") return null;
    const t = timeStr.length === 5 ? timeStr : timeStr.substring(0, 5);
    return new Date(`${dateStr}T${t}:00`);
}

/** Parse date string from eTimeOffice (DD/MM/YYYY HH:MM:SS or MM/DD/YYYY) → "YYYY-MM-DD" */
function parseEtimeDateStr(raw) {
    if (!raw) return null;
    // Try ISO first
    if (raw.includes("T") || raw.match(/^\d{4}-\d{2}-\d{2}/)) {
        return raw.split("T")[0];
    }
    // DD/MM/YYYY HH:MM:SS  (eTimeOffice format)
    const parts = raw.split(" ")[0].split("/");
    if (parts.length === 3) {
        if (parts[2].length === 4) {
            // Could be DD/MM/YYYY or MM/DD/YYYY
            // eTimeOffice typically uses DD/MM/YYYY in PunchDate field
            // but the FromDate/ToDate params and DateString field use MM/DD/YYYY
            // We detect: if parts[0] > 12 → it's DD
            const a = parseInt(parts[0], 10);
            const b = parseInt(parts[1], 10);
            const y = parts[2];
            if (a > 12) {
                return `${y}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")}`;
            }
            // Assume MM/DD/YYYY (DateString field)
            return `${y}-${String(a).padStart(2, "0")}-${String(b).padStart(2, "0")}`;
        }
    }
    return null;
}

// ── Punch categorisation using mcid ──────────────────────────────────────────

/**
 * eTimeOffice mcid values:
 *   1 = In (shift start)
 *   2 = Out (final out)
 *   3 = Break Out (lunch out)
 *   4 = Break In  (lunch in)
 *   null/other → sequential fallback
 */
function categorizePunchesByMcid(sortedPunches) {
    const result = {
        inTime: null, lunchOut: null, lunchIn: null,
        teaOut: null, teaIn: null, finalOut: null,
    };

    if (!sortedPunches || sortedPunches.length === 0) return result;

    const hasMcid = sortedPunches.some(p => p.mcid !== null && p.mcid !== undefined);

    if (hasMcid) {
        // Group by mcid — if multiple punches with same mcid, take earliest for "in" types, latest for "out" types
        const byMcid = {};
        for (const p of sortedPunches) {
            if (!byMcid[p.mcid]) byMcid[p.mcid] = [];
            byMcid[p.mcid].push(p.time);
        }
        result.inTime = byMcid[1]?.[0] || null;                        // first in
        result.finalOut = byMcid[2]?.[byMcid[2]?.length - 1] || null;    // last out
        result.lunchOut = byMcid[3]?.[0] || null;
        result.lunchIn = byMcid[4]?.[byMcid[4]?.length - 1] || null;
    } else {
        // Sequential: 1=in, 2=lunchOut, 3=lunchIn, 4=teaOut, 5=teaIn, 6=finalOut
        const times = sortedPunches.map(p => p.time || p);
        if (times.length === 1) {
            result.inTime = times[0];
        } else if (times.length === 2) {
            result.inTime = times[0];
            result.finalOut = times[1];
        } else {
            result.inTime = times[0];
            result.lunchOut = times[1] || null;
            result.lunchIn = times[2] || null;
            result.teaOut = times[3] || null;
            result.teaIn = times[4] || null;
            result.finalOut = times[5] || null;
        }
    }
    return result;
}

// ── Main day-metrics calculator ───────────────────────────────────────────────

/**
 * Calculate all attendance metrics for one employee-day.
 * @param {object} params
 */
function calculateDayMetrics(params) {
    const {
        dateStr,
        inTime,         // Date | null
        lunchOut,       // Date | null
        lunchIn,        // Date | null
        teaOut,         // Date | null
        teaIn,          // Date | null
        finalOut,       // Date | null
        punchCount = 0,
        isWeeklyOff = false,
        isHoliday = false,
        isOnLeave = false,
        etimeWorkTime,  // "HH:MM" from API — use as truth if available
        etimeOT,        // "HH:MM" from API
        etimeRemark,    // "MIS-LT", "P/2", etc.
        etimeStatus,    // "P", "A", "P/2", etc.
        settings = {},
    } = params;

    const shiftStartMins = timeToMins(settings.shiftStart || "09:00");
    const shiftEndMins = timeToMins(settings.shiftEnd || "18:30");
    const lateThreshold = settings.lateThresholdMinutes ?? 15;
    const halfDayThreshold = settings.halfDayThresholdMinutes ?? 270; // 4.5h
    const earlyDeptThresh = settings.earlyDepartureThresholdMinutes ?? 30;
    const otGrace = settings.otGracePeriodMins ?? 30;
    const stdLunchBreak = settings.lunchBreakMins ?? 45;
    const stdTeaBreak = settings.teaBreakMins ?? 15;

    const zero = {
        status: "AB", totalSpanMins: 0, lunchBreakMins: 0, teaBreakMins: 0,
        totalBreakMins: 0, netWorkMins: 0, otMins: 0, lateMins: 0,
        earlyDepartureMins: 0, isLate: false, isEarlyDeparture: false,
        hasOT: false, hasMissPunch: false,
    };

    if (isHoliday) return { ...zero, status: "PH" };
    if (isOnLeave) return { ...zero, status: "L" };
    if (isWeeklyOff && punchCount === 0) return { ...zero, status: "WO" };

    if (punchCount === 0) return zero; // AB

    // ── At least 1 punch ────────────────────────────────────────────────────────
    const hasMissPunch = !finalOut; // no final out = incomplete

    // ── Break calculation ───────────────────────────────────────────────────────
    let lunchBreakMins = 0;
    let teaBreakMins = 0;

    if (lunchOut && lunchIn) {
        lunchBreakMins = Math.max(0, Math.round((new Date(lunchIn) - new Date(lunchOut)) / 60000));
    }
    if (teaOut && teaIn) {
        teaBreakMins = Math.max(0, Math.round((new Date(teaIn) - new Date(teaOut)) / 60000));
    }

    // If no explicit breaks but we have in+out, apply standard breaks based on span
    if (inTime && finalOut && lunchBreakMins === 0) {
        const span = Math.round((new Date(finalOut) - new Date(inTime)) / 60000);
        if (span >= 300) lunchBreakMins = stdLunchBreak; // >= 5h → apply lunch
        if (span >= 360 && teaBreakMins === 0) teaBreakMins = stdTeaBreak; // >= 6h → apply tea
    }

    const totalBreakMins = lunchBreakMins + teaBreakMins;

    // ── Work time ───────────────────────────────────────────────────────────────
    let totalSpanMins = 0;
    let netWorkMins = 0;
    let otMins = 0;

    if (inTime && finalOut) {
        totalSpanMins = Math.round((new Date(finalOut) - new Date(inTime)) / 60000);
        netWorkMins = Math.max(0, totalSpanMins - totalBreakMins);

        // If API provided work time, use it as authoritative (more accurate)
        if (etimeWorkTime && etimeWorkTime !== "00:00" && etimeWorkTime !== "--:--") {
            const apiWorkMins = timeToMins(etimeWorkTime);
            if (apiWorkMins && apiWorkMins > 0) netWorkMins = apiWorkMins;
        }

        // OT: after shiftEnd + grace
        const outMins = dateToMins(finalOut);
        const otStartAt = shiftEndMins + otGrace;
        if (outMins > otStartAt) {
            otMins = outMins - otStartAt;
        }

        // If API provided OT, prefer it
        if (etimeOT && etimeOT !== "00:00" && etimeOT !== "--:--") {
            const apiOtMins = timeToMins(etimeOT);
            if (apiOtMins !== null) otMins = apiOtMins;
        }
    }

    // ── Late / Early ────────────────────────────────────────────────────────────
    const inMins = inTime ? dateToMins(inTime) : null;
    const outMins2 = finalOut ? dateToMins(finalOut) : null;

    let lateMins = 0;
    let earlyDepartureMins = 0;
    let isLate = false;
    let isEarlyDeparture = false;

    // Use API Late_In if available
    if (params.etimeLateIn && params.etimeLateIn !== "00:00") {
        lateMins = timeToMins(params.etimeLateIn) || 0;
        isLate = lateMins > 0;
    } else if (inMins !== null) {
        const rawLate = inMins - shiftStartMins;
        if (rawLate > lateThreshold) { lateMins = rawLate; isLate = true; }
    }

    if (outMins2 !== null && finalOut) {
        const rawEarly = shiftEndMins - outMins2;
        if (rawEarly > earlyDeptThresh) { earlyDepartureMins = rawEarly; isEarlyDeparture = true; }
    }

    // Use API Erl_Out if available
    if (params.etimeErlOut && params.etimeErlOut !== "00:00") {
        const apiEarly = timeToMins(params.etimeErlOut) || 0;
        if (apiEarly > 0) { earlyDepartureMins = apiEarly; isEarlyDeparture = true; }
    }

    const hasOT = otMins > 0;

    // ── Status derivation ───────────────────────────────────────────────────────
    let status;

    if (isWeeklyOff) {
        // Came in on weekly off (overtime scenario)
        status = inTime ? "WO" : "WO";
    } else if (!inTime) {
        status = "AB";
    } else if (!finalOut) {
        // Has in but no out — mark as MP (miss punch), not absent
        status = "MP";
    } else {
        // Use eTimeOffice status hint
        const etStat = (etimeStatus || "").toUpperCase().trim();
        const etRem = (etimeRemark || "").toUpperCase().trim();

        // P/2 from device = half day
        if (etStat === "P/2" || etRem.includes("P/2")) {
            status = "HD";
        } else if (netWorkMins < halfDayThreshold && netWorkMins > 0) {
            status = "HD";
        } else if (netWorkMins >= halfDayThreshold) {
            if (isLate && isEarlyDeparture) status = "P*"; // late takes precedence
            else if (isLate) status = "P*";
            else if (isEarlyDeparture) status = "P~";
            else status = "P";
        } else {
            status = "AB";
        }
    }

    return {
        status,
        totalSpanMins,
        lunchBreakMins,
        teaBreakMins,
        totalBreakMins,
        netWorkMins,
        otMins,
        lateMins,
        earlyDepartureMins,
        isLate,
        isEarlyDeparture,
        hasOT,
        hasMissPunch,
    };
}

// ── Parse DownloadInOutPunchData response (API 3 — primary) ──────────────────

/**
 * Parse the InOut API response → array of normalized records.
 * Response shape: { InOutPunchData: [{Empcode, INTime, OUTTime, WorkTime, OverTime, Status, DateString, Remark, Erl_Out, Late_In, Name}] }
 */
function parseInOutResponse(apiData) {
    if (!apiData) return [];
    const items = apiData.InOutPunchData || apiData.inOutPunchData || (Array.isArray(apiData) ? apiData : []);
    const result = [];

    for (const rec of items) {
        const empCode = String(rec.Empcode || rec.empcode || rec.EmpCode || "").padStart(4, "0");
        if (!empCode || empCode === "0000") continue;

        const dateStr = parseEtimeDateStr(rec.DateString || rec.dateString || rec.AttDate);
        if (!dateStr) continue;

        const inTimeStr = (rec.INTime || rec.InTime || "").trim();
        const outTimeStr = (rec.OUTTime || rec.OutTime || "").trim();

        const inTime = (inTimeStr && inTimeStr !== "--:--") ? combineDateTime(dateStr, inTimeStr) : null;
        const finalOut = (outTimeStr && outTimeStr !== "--:--") ? combineDateTime(dateStr, outTimeStr) : null;

        result.push({
            biometricId: empCode,
            dateStr,
            name: rec.Name || rec.name || "",
            inTime,
            finalOut,
            workTime: rec.WorkTime || rec.workTime || "00:00",
            overTime: rec.OverTime || rec.overTime || "00:00",
            etimeStatus: rec.Status || rec.status || "",
            etimeRemark: rec.Remark || rec.remark || "",
            etimeLateIn: rec.Late_In || rec.late_in || "00:00",
            etimeErlOut: rec.Erl_Out || rec.erl_out || "00:00",
            punchCount: (inTime ? 1 : 0) + (finalOut ? 1 : 0),
            rawPunches: [],
        });
    }
    return result;
}

/**
 * Parse DownloadPunchData / DownloadPunchDataMCID (API 1 / API 2) response.
 * Merges individual punches into per-employee-per-day records.
 * Response: { PunchData: [{Name, Empcode, PunchDate, M_Flag, mcid, ID}] }
 */
function parsePunchDataResponse(apiData) {
    if (!apiData) return {};
    const items = apiData.PunchData || apiData.punchData || (Array.isArray(apiData) ? apiData : []);
    const grouped = {}; // key: "empCode_dateStr"

    for (const rec of items) {
        const empCode = String(rec.Empcode || rec.empcode || rec.EmpCode || "").padStart(4, "0");
        if (!empCode || empCode === "0000") continue;

        const rawDate = rec.PunchDate || rec.punchDate || rec.AttDate;
        const dateStr = parseEtimeDateStr(rawDate);
        if (!dateStr) continue;

        const key = `${empCode}_${dateStr}`;
        if (!grouped[key]) {
            grouped[key] = { biometricId: empCode, dateStr, name: rec.Name || "", punches: [] };
        }

        // Parse the punch time
        let punchTime = null;
        if (rawDate && rawDate.includes(" ")) {
            punchTime = new Date(rawDate.replace(/(\d{2})\/(\d{2})\/(\d{4}) /, "$3-$2-$1T"));
            if (isNaN(punchTime)) {
                // Try MM/DD/YYYY format
                punchTime = new Date(rawDate);
            }
        } else if (rawDate && rawDate.includes("T")) {
            punchTime = new Date(rawDate);
        }

        if (punchTime && !isNaN(punchTime)) {
            grouped[key].punches.push({
                time: punchTime,
                mcid: rec.mcid !== undefined ? parseInt(rec.mcid, 10) : null,
                mFlag: rec.M_Flag || rec.m_flag || null,
                id: rec.ID || rec.id || null,
            });
        }
    }

    // Sort each employee's punches by time
    for (const key of Object.keys(grouped)) {
        grouped[key].punches.sort((a, b) => a.time - b.time);
    }
    return grouped;
}

// ── Build final DailyAttendance record ───────────────────────────────────────

/**
 * Build a complete DailyAttendance document from parsed API data.
 * Prefers InOut API data, enriches with individual punch data when available.
 */
function buildAttendanceRecord(inOutRecord, punchData, employeeDoc, settings, holidays = []) {
    const { dateStr } = inOutRecord;

    const holiday = holidays.find(h => h.date === dateStr);
    const isHoliday = !!holiday;

    const dow = new Date(dateStr + "T00:00:00").getDay();
    const workingDays = settings.workingDays || [1, 2, 3, 4, 5, 6];
    const isWeeklyOff = !workingDays.includes(dow);

    // Try to get detailed punches from punch API (API2)
    let inTime = inOutRecord.inTime;
    let finalOut = inOutRecord.finalOut;
    let lunchOut = null, lunchIn = null, teaOut = null, teaIn = null;
    let punchCount = inOutRecord.punchCount;
    let rawPunches = [];

    if (punchData && punchData.punches && punchData.punches.length > 0) {
        const punches = punchData.punches;
        punchCount = punches.length;
        const cats = categorizePunchesByMcid(punches);
        inTime = cats.inTime || inTime;
        lunchOut = cats.lunchOut;
        lunchIn = cats.lunchIn;
        teaOut = cats.teaOut;
        teaIn = cats.teaIn;
        finalOut = cats.finalOut || finalOut;

        rawPunches = punches.map((p, i) => ({
            seq: i + 1,
            time: p.time,
            mcid: p.mcid,
            mFlag: p.mFlag,
            punchType: mcidToPunchType(p.mcid, i, punches.length),
            source: "device",
        }));
    } else if (inTime || finalOut) {
        // Only InOut data available
        if (inTime) rawPunches.push({ seq: 1, time: inTime, punchType: "in", source: "device" });
        if (finalOut) rawPunches.push({ seq: 2, time: finalOut, punchType: "out", source: "device" });
    }

    const metrics = calculateDayMetrics({
        dateStr,
        inTime,
        lunchOut,
        lunchIn,
        teaOut,
        teaIn,
        finalOut,
        punchCount,
        isWeeklyOff,
        isHoliday,
        isOnLeave: false,
        etimeWorkTime: inOutRecord.workTime,
        etimeOT: inOutRecord.overTime,
        etimeRemark: inOutRecord.etimeRemark,
        etimeStatus: inOutRecord.etimeStatus,
        etimeLateIn: inOutRecord.etimeLateIn,
        etimeErlOut: inOutRecord.etimeErlOut,
        settings,
    });

    const name = employeeDoc
        ? `${employeeDoc.firstName || ""} ${employeeDoc.lastName || ""}`.trim()
        : (inOutRecord.name || punchData?.name || "");

    return {
        biometricId: inOutRecord.biometricId,
        employeeDbId: employeeDoc?._id || null,
        employeeName: name,
        department: employeeDoc?.department || "—",
        designation: employeeDoc?.designation || "—",
        date: new Date(dateStr + "T00:00:00"),
        dateStr,
        yearMonth: dateStr.substring(0, 7),
        shiftName: "GEN",
        shiftStart: settings.shiftStart || "09:00",
        shiftEnd: settings.shiftEnd || "18:30",
        punchCount,
        rawPunches,
        inTime,
        lunchOut,
        lunchIn,
        teaOut,
        teaIn,
        finalOut,
        ...metrics,
        isWeeklyOff,
        isHoliday,
        holidayName: holiday?.name || null,
        holidayType: holiday?.type || null,
        isOnLeave: false,
        leaveType: null,
        etimeRemark: inOutRecord.etimeRemark || "",
        etimeStatus: inOutRecord.etimeStatus || "",
        syncedAt: new Date(),
        syncSource: "api",
    };
}

function mcidToPunchType(mcid, idx, total) {
    const mcidMap = { 1: "in", 2: "out", 3: "lunch_out", 4: "lunch_in", 5: "tea_out", 6: "tea_in" };
    if (mcid && mcidMap[mcid]) return mcidMap[mcid];
    const seqMap = ["in", "lunch_out", "lunch_in", "tea_out", "tea_in", "out"];
    if (total === 2) return idx === 0 ? "in" : "out";
    return seqMap[idx] || "unknown";
}

// ── Build absent/WO/PH placeholder records ───────────────────────────────────

function buildPlaceholderRecord(biometricId, employeeDoc, dateStr, settings, holidays) {
    const holiday = holidays.find(h => h.date === dateStr);
    const isHoliday = !!holiday;
    const dow = new Date(dateStr + "T00:00:00").getDay();
    const workingDays = settings.workingDays || [1, 2, 3, 4, 5, 6];
    const isWeeklyOff = !workingDays.includes(dow);
    const status = isHoliday ? "PH" : isWeeklyOff ? "WO" : "AB";
    const name = employeeDoc
        ? `${employeeDoc.firstName || ""} ${employeeDoc.lastName || ""}`.trim()
        : "";

    return {
        biometricId,
        employeeDbId: employeeDoc?._id || null,
        employeeName: name,
        department: employeeDoc?.department || "—",
        designation: employeeDoc?.designation || "—",
        date: new Date(dateStr + "T00:00:00"),
        dateStr,
        yearMonth: dateStr.substring(0, 7),
        shiftName: "GEN",
        shiftStart: settings.shiftStart || "09:00",
        shiftEnd: settings.shiftEnd || "18:30",
        punchCount: 0,
        rawPunches: [],
        inTime: null,
        lunchOut: null,
        lunchIn: null,
        teaOut: null,
        teaIn: null,
        finalOut: null,
        status,
        isWeeklyOff,
        isHoliday,
        holidayName: holiday?.name || null,
        holidayType: holiday?.type || null,
        isOnLeave: false,
        leaveType: null,
        netWorkMins: 0, totalSpanMins: 0, lunchBreakMins: 0, teaBreakMins: 0,
        totalBreakMins: 0, otMins: 0, lateMins: 0, earlyDepartureMins: 0,
        isLate: false, isEarlyDeparture: false, hasOT: false, hasMissPunch: false,
        syncedAt: new Date(),
        syncSource: "api",
    };
}

module.exports = {
    timeToMins,
    minsToHHMM,
    dateToMins,
    combineDateTime,
    parseEtimeDateStr,
    categorizePunchesByMcid,
    calculateDayMetrics,
    parseInOutResponse,
    parsePunchDataResponse,
    buildAttendanceRecord,
    buildPlaceholderRecord,
};