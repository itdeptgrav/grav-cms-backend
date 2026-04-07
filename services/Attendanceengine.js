/**
 * AttendanceEngine.js — v7 (GRAV Clothing) — FULLY FIXED
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * BUGS FIXED FROM v6:
 *  1. "out" time window now starts at 18:00 (not 17:30) — the 5th operator
 *     punch at ~17:19 is TEA break, NOT final out. Fi  nal out is 18:30+.
 *  2. parsePunchDataResponse now correctly handles the actual eTimeOffice API
 *     response format: { PunchData: [{ Name, Empcode, PunchDate, M_Flag }] }
 *  3. IST→UTC conversion fixed: times stored as UTC, displayed as IST
 *  4. Deduplication threshold lowered to 1 min (GRAV employees sometimes
 *     double-tap the biometric within seconds)
 *  5. computeDay always runs — no more 00:00 work hours when punches exist
 *  6. "tea_out" and "tea_in" windows calibrated to actual GRAV patterns
 *     (17:00–17:45 and 17:15–17:50 respectively)
 *
 * Time windows calibrated from actual GRAV March/April 2026 data:
 *   IN:        07:00 – 11:00   (420–660 mins)
 *   LUNCH_OUT: 12:00 – 13:30   (720–810 mins)
 *   LUNCH_IN:  12:30 – 14:30   (750–870 mins)
 *   TEA_OUT:   17:00 – 17:45   (1020–1065 mins)
 *   TEA_IN:    17:15 – 17:50   (1035–1070 mins)
 *   FINAL_OUT: 18:00 – 23:59   (1080–1439 mins)  ← KEY FIX
 */

"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
//  UTILITY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Strip all non-digits, return integer or null. "GR072" → 72, "0072" → 72 */
function normalizeId(raw) {
    if (raw === null || raw === undefined) return null;
    const digits = String(raw).replace(/\D/g, "");
    if (!digits) return null;
    return parseInt(digits, 10);
}

/** Convert "HH:MM" string to minutes-since-midnight */
function hhmmToMins(str) {
    if (!str) return 0;
    const [h, m] = str.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
}

/** Convert minutes to "HH:MM" display string */
function minsToHHMM(mins) {
    if (!mins || mins <= 0) return "00:00";
    const h = Math.floor(Math.abs(mins) / 60);
    const m = Math.abs(mins) % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Extract IST minutes-since-midnight from a UTC Date object */
function dateToMinsIST(d) {
    if (!d) return null;
    const dt = new Date(d);
    const utcMins = dt.getUTCHours() * 60 + dt.getUTCMinutes();
    return (utcMins + 330) % 1440;  // +5:30 IST offset
}

/** Format a UTC Date to "HH:MM" in IST */
function dateToTimeStrIST(d) {
    if (!d) return "--:--";
    const mins = dateToMinsIST(d);
    if (mins === null) return "--:--";
    return minsToHHMM(mins);
}

/** Difference in minutes between two Dates */
function diffMins(a, b) {
    if (!a || !b) return 0;
    return Math.round((new Date(b) - new Date(a)) / 60000);
}

/** Check if a dateStr falls on a weekly off day */
function isWeeklyOff(dateStr, workingDays) {
    const d = new Date(dateStr + "T00:00:00Z");
    const dow = d.getUTCDay();
    return !workingDays.includes(dow);
}

/** Find holiday matching a dateStr */
function findHoliday(dateStr, holidays) {
    if (!holidays || !holidays.length) return null;
    return holidays.find(h => h.date === dateStr) || null;
}

/** Deduplicate punches within threshold (minutes). Keep first of each cluster. */
function deduplicatePunches(punches, thresholdMins = 1) {
    if (!punches || punches.length <= 1) return punches;
    const sorted = [...punches].sort((a, b) => new Date(a.time) - new Date(b.time));
    const result = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        const gap = diffMins(sorted[i - 1].time, sorted[i].time);
        if (gap >= thresholdMins) {
            result.push(sorted[i]);
        }
    }
    return result;
}


// ═══════════════════════════════════════════════════════════════════════════════
//  EMPLOYEE MAP BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build employee lookup map using MULTIPLE matching strategies.
 * 
 * THE CRITICAL FIX: At GRAV, the HR system uses identity codes like "GR005"
 * while the biometric device uses completely different Empcodes like "0006".
 * normalizeId("GR005")=5 ≠ normalizeId("0006")=6, so numeric matching FAILS.
 *
 * Strategy (in priority order):
 *  1. Match by deviceEmpcode field (if previously stored from a successful match)
 *  2. Match by numeric ID (works only if biometricId IS the device code)
 *  3. Match by NAME (fuzzy fallback — normalizes and compares employee names)
 *
 * When a name-match succeeds, we auto-save the deviceEmpcode on the employee
 * record so future syncs use fast ID matching.
 *
 * @param {Model} EmployeeModel
 * @param {string[]} rawCodes - Empcodes from eTimeOffice (e.g., ["0006","0017"])
 * @param {Object} punchNameMap - Optional: { empcode: name } from the API response
 * @returns {Object} { deviceEmpcode(numeric): empDoc, ... }
 */
async function buildEmployeeMap(EmployeeModel, rawCodes = [], punchNameMap = {}) {
    // Fetch ALL active employees (not just those with biometricId)
    const employees = await EmployeeModel.find({
        $or: [
            { "workInfo.biometricId": { $exists: true, $ne: null } },
            { "workInfo.deviceEmpcode": { $exists: true, $ne: null } },
            { biometricId: { $exists: true, $ne: null } },
            { status: "active" },
        ]
    }).lean();

    // Build helper function for employee type detection
    function getEmployeeType(emp) {
        const dept = (emp.department || emp.workInfo?.department || "").toLowerCase();
        const prodDepts = ["production", "manufacturing", "factory", "cutting", "sewing", "finishing", "packing"];
        const explicitType = (emp.workInfo?.employeeType || emp.employeeType || "").toLowerCase();
        if (explicitType === "operator" || explicitType === "executive") return explicitType;
        return prodDepts.some(d => dept.includes(d)) ? "operator" : "executive";
    }

    // Build employee doc helper
    function makeEmpDoc(emp, deviceCode) {
        const bioId = emp.workInfo?.biometricId || emp.biometricId || deviceCode;
        return {
            _id: emp._id,
            name: `${emp.firstName || ""} ${emp.lastName || ""}`.trim() || emp.name || "Unknown",
            biometricId: deviceCode,  // USE the device code as the record key
            numericId: normalizeId(deviceCode),
            identityId: emp.workInfo?.identityId || emp.identityId || bioId,
            department: emp.department || emp.workInfo?.department || "—",
            designation: emp.workInfo?.jobTitle || emp.designation || "—",
            employeeType: getEmployeeType(emp),
            shiftCode: emp.workInfo?.shiftCode || null,
            hrBiometricId: bioId,  // Keep the original HR code for reference
        };
    }

    const map = {};  // keyed by normalizeId(deviceEmpcode)

    // ── PASS 1: Match by deviceEmpcode (fast path for previously matched employees) ──
    const byDeviceCode = {};  // deviceEmpcode → employee
    const byNumericId = {};   // normalizeId(biometricId) → employee
    const byName = {};        // normalized name → employee
    const unmatchedCodes = new Set(rawCodes);

    for (const emp of employees) {
        // If deviceEmpcode was previously saved, use it directly
        const devCode = emp.workInfo?.deviceEmpcode || emp.deviceEmpcode;
        if (devCode) {
            const nid = normalizeId(devCode);
            if (nid !== null) {
                byDeviceCode[nid] = emp;
            }
        }

        // Also index by biometricId (in case it IS the device code)
        const bioId = emp.workInfo?.biometricId || emp.biometricId || "";
        if (bioId) {
            const nid = normalizeId(bioId);
            if (nid !== null) byNumericId[nid] = emp;
        }

        // Index by normalized name for fuzzy matching
        const fullName = `${emp.firstName || ""} ${emp.lastName || ""}`.trim() || emp.name || "";
        if (fullName) {
            const normalized = fullName.toUpperCase().replace(/\s+/g, " ").trim();
            byName[normalized] = emp;
        }
    }

    // Match each raw code from the API
    const autoMappedCodes = [];  // Track new mappings to save later

    for (const rawCode of rawCodes) {
        const nid = normalizeId(rawCode);
        if (nid === null) continue;

        let emp = null;
        let matchMethod = null;

        // Strategy 1: Match by deviceEmpcode
        if (byDeviceCode[nid]) {
            emp = byDeviceCode[nid];
            matchMethod = "deviceEmpcode";
        }

        // Strategy 2: Match by biometricId numeric
        if (!emp && byNumericId[nid]) {
            emp = byNumericId[nid];
            matchMethod = "biometricId";
        }

        // Strategy 3: Match by NAME from the API response
        if (!emp && punchNameMap[rawCode]) {
            const apiName = punchNameMap[rawCode].toUpperCase().replace(/\s+/g, " ").trim();

            // Try exact match first
            if (byName[apiName]) {
                emp = byName[apiName];
                matchMethod = "name_exact";
            } else {
                // Try partial match (first word + last word)
                const apiParts = apiName.split(" ");
                for (const [dbName, dbEmp] of Object.entries(byName)) {
                    const dbParts = dbName.split(" ");
                    // Match if first name matches AND (last name matches OR it's a single name)
                    if (apiParts[0] === dbParts[0] && (
                        apiParts.length === 1 || dbParts.length === 1 ||
                        apiParts[apiParts.length - 1] === dbParts[dbParts.length - 1]
                    )) {
                        emp = dbEmp;
                        matchMethod = "name_partial";
                        break;
                    }
                }
            }

            // If matched by name, save the device code for future fast matching
            if (emp && matchMethod?.startsWith("name")) {
                autoMappedCodes.push({ employeeId: emp._id, deviceEmpcode: rawCode });
            }
        }

        if (emp) {
            map[nid] = makeEmpDoc(emp, rawCode);
            unmatchedCodes.delete(rawCode);
        }
    }

    // ── Auto-save deviceEmpcode for name-matched employees (for future syncs) ──
    if (autoMappedCodes.length > 0) {
        try {
            const bulkOps = autoMappedCodes.map(({ employeeId, deviceEmpcode }) => ({
                updateOne: {
                    filter: { _id: employeeId },
                    update: { $set: { "workInfo.deviceEmpcode": deviceEmpcode } },
                }
            }));
            await EmployeeModel.bulkWrite(bulkOps, { ordered: false });
            console.log(`✅ [EmployeeMap] Auto-saved ${autoMappedCodes.length} device codes: ${autoMappedCodes.map(m => m.deviceEmpcode).join(", ")}`);
        } catch (err) {
            console.warn("⚠️  [EmployeeMap] Failed to auto-save device codes:", err.message);
        }
    }

    if (unmatchedCodes.size > 0) {
        console.warn(`⚠️  [EmployeeMap] ${unmatchedCodes.size} unmatched device codes: ${[...unmatchedCodes].join(", ")}`);
    }

    return map;
}


// ═══════════════════════════════════════════════════════════════════════════════
//  PUNCH CLASSIFICATION — CALIBRATED TO ACTUAL GRAV DATA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Time windows calibrated from real GRAV March/April 2026 punch patterns.
 * KEY: "out" starts at 18:00, NOT 17:30. The 17:15-17:45 punches are TEA break.
 */
const PUNCH_WINDOWS = {
    inStart: 420, inEnd: 660,     // 07:00 – 11:00
    lunchOutStart: 720, lunchOutEnd: 810,   // 12:00 – 13:30
    lunchInStart: 750, lunchInEnd: 870,    // 12:30 – 14:30
    teaOutStart: 1020, teaOutEnd: 1065,    // 17:00 – 17:45
    teaInStart: 1035, teaInEnd: 1070,     // 17:15 – 17:50
    outStart: 1080, outEnd: 1439,       // 18:00 – 23:59 ← THE KEY FIX
};

/**
 * Classify raw punches into named slots.
 * 
 * @param {Array} rawPunches - [{ time: Date, mcid, mFlag, ... }]
 * @param {string} employeeType - "operator" | "executive"
 * @param {Object} settings - attendance settings
 * @returns {Object} { classified, inTime, lunchOut, lunchIn, teaOut, teaIn, finalOut, punchCount }
 */
function classifyPunches(rawPunches, employeeType = "operator", settings = {}) {
    if (!rawPunches || !rawPunches.length) {
        return { classified: [], inTime: null, lunchOut: null, lunchIn: null, teaOut: null, teaIn: null, finalOut: null, punchCount: 0 };
    }

    // Step 1: Deduplicate (within 1 min)
    const sorted = deduplicatePunches(rawPunches, 1);

    // Step 2: Check for mcid data
    const hasMcid = sorted.some(p => p.mcid !== null && p.mcid !== undefined && p.mcid > 0);

    let classified;
    if (hasMcid) {
        classified = classifyByMcid(sorted);
    } else if (employeeType === "executive") {
        classified = classifyExecutive(sorted);
    } else {
        classified = classifyOperator(sorted);
    }

    // Step 3: Extract named times
    const getTime = (type) => {
        const p = classified.find(p => p.punchType === type);
        return p ? new Date(p.time) : null;
    };

    return {
        classified,
        inTime: getTime("in"),
        lunchOut: getTime("lunch_out"),
        lunchIn: getTime("lunch_in"),
        teaOut: getTime("tea_out"),
        teaIn: getTime("tea_in"),
        finalOut: getTime("out"),
        punchCount: classified.length,
    };
}

/** Classify using eTimeOffice mcid codes */
function classifyByMcid(sorted) {
    const mcidMap = { 1: "in", 2: "out", 3: "lunch_out", 4: "lunch_in", 5: "tea_out", 6: "tea_in" };
    return sorted.map((p, i) => ({ ...p, seq: i + 1, punchType: mcidMap[p.mcid] || "unknown" }));
}

/** Executive: 2-punch model. First = in, last = out */
function classifyExecutive(sorted) {
    if (sorted.length === 1) return [{ ...sorted[0], seq: 1, punchType: "in" }];
    return sorted.map((p, i) => ({
        ...p, seq: i + 1,
        punchType: i === 0 ? "in" : i === sorted.length - 1 ? "out" : "unknown",
    }));
}

/**
 * Operator: 6-punch model. Uses time-window heuristics calibrated to GRAV data.
 * 
 * The CRITICAL insight: punches at 17:15-17:45 are TEA break, NOT final out.
 * Final out is always 18:00+ for operators.
 * 
 * Strategy:
 *  1. Greedily assign each punch to the FIRST matching window (in order)
 *  2. Each slot can only be assigned once
 *  3. If a punch matches multiple windows, pick the best one based on ordering
 *  4. Fallback: first punch = in, last punch = out (only if after 18:00)
 */
function classifyOperator(sorted) {
    const result = sorted.map((p, i) => ({ ...p, seq: i + 1, punchType: "unknown" }));

    if (result.length === 1) {
        result[0].punchType = "in";
        return result;
    }

    if (result.length === 2) {
        result[0].punchType = "in";
        const lastMins = dateToMinsIST(result[1].time);
        // Only mark as "out" if after 18:00; otherwise it might be lunch
        result[1].punchType = lastMins >= PUNCH_WINDOWS.outStart ? "out" : "unknown";
        return result;
    }

    // 3+ punches: greedy window-based assignment
    const assigned = {};      // slot → index
    const usedIndices = new Set();

    // Define assignment order: we try to assign slots in sequence
    const slotDefs = [
        { slot: "in", start: PUNCH_WINDOWS.inStart, end: PUNCH_WINDOWS.inEnd },
        { slot: "lunch_out", start: PUNCH_WINDOWS.lunchOutStart, end: PUNCH_WINDOWS.lunchOutEnd },
        { slot: "lunch_in", start: PUNCH_WINDOWS.lunchInStart, end: PUNCH_WINDOWS.lunchInEnd },
        { slot: "tea_out", start: PUNCH_WINDOWS.teaOutStart, end: PUNCH_WINDOWS.teaOutEnd },
        { slot: "tea_in", start: PUNCH_WINDOWS.teaInStart, end: PUNCH_WINDOWS.teaInEnd },
        { slot: "out", start: PUNCH_WINDOWS.outStart, end: PUNCH_WINDOWS.outEnd },
    ];

    // For each slot definition, find the FIRST unassigned punch that fits the window
    for (const { slot, start, end } of slotDefs) {
        for (let i = 0; i < result.length; i++) {
            if (usedIndices.has(i)) continue;
            const mins = dateToMinsIST(result[i].time);
            if (mins === null) continue;
            if (mins >= start && mins <= end) {
                assigned[slot] = i;
                usedIndices.add(i);
                result[i].punchType = slot;
                break;  // move to next slot
            }
        }
    }

    // Fallback: if no "in" was assigned, use first punch
    if (!("in" in assigned) && result.length > 0 && !usedIndices.has(0)) {
        assigned["in"] = 0;
        usedIndices.add(0);
        result[0].punchType = "in";
    }

    // Fallback: if no "out" was assigned, check if last punch is after 18:00
    if (!("out" in assigned)) {
        const lastIdx = result.length - 1;
        const lastMins = dateToMinsIST(result[lastIdx].time);
        if (lastMins >= PUNCH_WINDOWS.outStart && !usedIndices.has(lastIdx)) {
            assigned["out"] = lastIdx;
            usedIndices.add(lastIdx);
            result[lastIdx].punchType = "out";
        }
    }

    return result;
}


// ═══════════════════════════════════════════════════════════════════════════════
//  DAY COMPUTATION — STATUS, OT, LATE, BREAKS
// ═══════════════════════════════════════════════════════════════════════════════

function computeDay(record, settings, employeeType, holidays) {
    const workingDays = settings.workingDays || [1, 2, 3, 4, 5, 6];

    // ── 1. Weekly off check ──────────────────────────────────────────────
    if (isWeeklyOff(record.dateStr, workingDays)) {
        record.isWeeklyOff = true;
        if (!record.inTime) {
            record.systemPrediction = "WO";
            record.netWorkMins = 0;
            record.otMins = 0;
            return;
        }
    }

    // ── 2. Holiday check ─────────────────────────────────────────────────
    const holiday = findHoliday(record.dateStr, holidays);
    if (holiday) {
        record.isHoliday = true;
        record.holidayName = holiday.name;
        record.holidayType = holiday.type;
        if (!record.inTime) {
            record.systemPrediction = "PH";
            record.netWorkMins = 0;
            record.otMins = 0;
            return;
        }
    }

    // ── 3. Leave check ───────────────────────────────────────────────────
    if (record.isOnLeave && record.leaveType) {
        const leaveMap = { CL: "L-CL", SL: "L-SL", EL: "L-EL", LWP: "LWP", CO: "CO" };
        record.systemPrediction = leaveMap[record.leaveType] || "L-CL";
        return;
    }

    // ── 4. No punches = Absent ───────────────────────────────────────────
    if (!record.inTime) {
        record.systemPrediction = "AB";
        record.netWorkMins = 0;
        record.otMins = 0;
        record.totalSpanMins = 0;
        record.totalBreakMins = 0;
        return;
    }

    // ── 5. Has inTime but no finalOut = Missing Punch ────────────────────
    if (record.inTime && !record.finalOut) {
        record.hasMissPunch = true;
        record.systemPrediction = "MP";
        // Still calculate partial data
        record.totalSpanMins = 0;
        record.netWorkMins = 0;
        record.otMins = 0;
        // Calculate late even for miss punch (they did come in)
        const shiftStartMins = hhmmToMins(settings.shiftStart || "09:00");
        const lateThreshold = employeeType === "executive"
            ? (settings.executiveLateThresholdMinutes || 45)
            : (settings.lateThresholdMinutes || 15);
        const inMins = dateToMinsIST(record.inTime);
        const lateMins = inMins - shiftStartMins;
        record.isLate = lateMins > lateThreshold;
        record.lateMins = Math.max(0, lateMins);
        return;
    }

    // ── 6. Has both in and out — full computation ────────────────────────
    const shiftStartMins = hhmmToMins(settings.shiftStart || "09:00");
    const shiftEndMins = hhmmToMins(settings.shiftEnd || "18:30");

    // Total span
    const totalSpanMins = diffMins(record.inTime, record.finalOut);
    record.totalSpanMins = Math.max(0, totalSpanMins);

    // Break calculation
    let lunchBreakMins = 0;
    let teaBreakMins = 0;

    if (employeeType === "operator") {
        // Actual measured breaks from punches
        if (record.lunchOut && record.lunchIn) {
            lunchBreakMins = diffMins(record.lunchOut, record.lunchIn);
        }
        if (record.teaOut && record.teaIn) {
            teaBreakMins = diffMins(record.teaOut, record.teaIn);
        }
        // If no break punches, use standard defaults
        if (lunchBreakMins <= 0) lunchBreakMins = settings.lunchBreakMins || 45;
        if (teaBreakMins <= 0) teaBreakMins = settings.teaBreakMins || 15;
    } else {
        // Executives: standard break deduction
        lunchBreakMins = settings.lunchBreakMins || 45;
        teaBreakMins = 0;
    }

    record.lunchBreakMins = Math.max(0, lunchBreakMins);
    record.teaBreakMins = Math.max(0, teaBreakMins);
    record.totalBreakMins = record.lunchBreakMins + record.teaBreakMins;

    // Net work
    record.netWorkMins = Math.max(0, totalSpanMins - record.totalBreakMins);

    // ── 7. Late detection ────────────────────────────────────────────────
    const lateThreshold = employeeType === "executive"
        ? (settings.executiveLateThresholdMinutes || 45)
        : (settings.lateThresholdMinutes || 15);
    const inMins = dateToMinsIST(record.inTime);
    const lateMins = inMins - shiftStartMins;
    record.isLate = lateMins > lateThreshold;
    record.lateMins = Math.max(0, lateMins);

    // ── 8. Early departure ───────────────────────────────────────────────
    const earlyThreshold = settings.earlyDepartureThresholdMinutes || 30;
    const outMins = dateToMinsIST(record.finalOut);
    const earlyBy = shiftEndMins - outMins;
    record.isEarlyDeparture = earlyBy > earlyThreshold;
    record.earlyDepartureMins = Math.max(0, earlyBy);

    // ── 9. Overtime (operators only) ─────────────────────────────────────
    if (employeeType === "operator" && settings.overtimeEnabled !== false) {
        const otGrace = settings.otGracePeriodMins || 30;
        const otStartsAt = shiftEndMins + otGrace;
        let otMins = Math.max(0, outMins - otStartsAt);
        const otMinimum = settings.overtimeMinimumMinutes || 30;
        if (otMins < otMinimum) otMins = 0;
        otMins = Math.min(otMins, settings.overtimeMaxPerDay || 240);
        record.otMins = otMins;
        record.hasOT = otMins > 0;
    } else {
        record.otMins = 0;
        record.hasOT = false;
    }

    // ── 10. Status determination ─────────────────────────────────────────
    const halfDayThreshold = settings.halfDayThresholdMinutes || 270;
    if (record.netWorkMins <= 0) {
        record.systemPrediction = "AB";
    } else if (record.netWorkMins < halfDayThreshold) {
        record.systemPrediction = "HD";
    } else if (record.isEarlyDeparture) {
        record.systemPrediction = "P~";
    } else if (record.isLate) {
        record.systemPrediction = "P*";
    } else {
        record.systemPrediction = "P";
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
//  ETIMEOFFICE RESPONSE PARSERS — FIXED FOR ACTUAL API FORMAT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse "DD/MM/YYYY HH:mm:ss" IST string → { dateStr, utcDate, istMins }
 * The eTimeOffice API returns times in IST as naive timestamps.
 * We store as UTC by subtracting 5:30.
 */
function parsePunchDateTimeIST(str) {
    if (!str) return null;
    try {
        const parts = str.trim().split(" ");
        const dp = parts[0].split("/");
        const tp = parts[1] ? parts[1].split(":") : ["00", "00", "00"];

        if (dp.length !== 3) return null;

        const day = parseInt(dp[0], 10);
        const month = parseInt(dp[1], 10);
        const year = parseInt(dp[2], 10);
        const h = parseInt(tp[0] || "0", 10);
        const m = parseInt(tp[1] || "0", 10);
        const s = parseInt(tp[2] || "0", 10);

        // YYYY-MM-DD string (for grouping by date)
        const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

        // IST minutes since midnight (for time window classification)
        const istMins = h * 60 + m;

        // Store as UTC: subtract IST offset (5h 30m)
        const utcDate = new Date(Date.UTC(year, month - 1, day, h, m, s));
        utcDate.setUTCMinutes(utcDate.getUTCMinutes() - 330);

        return { dateStr, utcDate, istMins, timeStr: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` };
    } catch {
        return null;
    }
}

/**
 * Parse the DownloadInOutPunchData response.
 * Format: { InOutPunchData: [{ Empcode, DateString, InTime, OutTime, Status, ... }] }
 */
function parseInOutResponse(data) {
    if (!data) return [];
    const rows = data.InOutPunchData || data.PunchData || [];
    if (!Array.isArray(rows)) return [];

    const byKey = {};
    for (const row of rows) {
        const empCode = row.Empcode || row.EmpCode || "";
        if (!empCode) continue;
        const dateStr = row.DateString || "";
        if (!dateStr) continue;
        const key = `${empCode}_${dateStr}`;
        if (!byKey[key]) {
            byKey[key] = {
                biometricId: empCode, dateStr,
                name: row.Name || row.EmpName || "",
                inTime: row.InTime || null,
                finalOut: row.OutTime || null,
                etimeStatus: row.Status || "", etimeRemark: row.Remark || "",
            };
        }
    }
    return Object.values(byKey);
}

/**
 * Parse the DownloadPunchData response (raw punches).
 * THIS IS THE PRIMARY DATA SOURCE — the actual API format is:
 *   { PunchData: [{ Name, Empcode, PunchDate: "DD/MM/YYYY HH:mm:ss", M_Flag }] }
 * 
 * Returns: { "empCode_dateStr": { biometricId, dateStr, name, punches: [{ time, mcid, mFlag }] } }
 */
function parsePunchDataResponse(data) {
    if (!data) return {};

    // Handle both array and object-with-PunchData formats
    let rows;
    if (Array.isArray(data)) {
        rows = data;
    } else if (data.PunchData && Array.isArray(data.PunchData)) {
        rows = data.PunchData;
    } else {
        return {};
    }

    const map = {};

    for (const row of rows) {
        const empCode = row.Empcode || row.EmpCode || "";
        if (!empCode) continue;

        const punchDateStr = row.PunchDate || "";
        if (!punchDateStr) continue;

        const parsed = parsePunchDateTimeIST(punchDateStr);
        if (!parsed) continue;

        const key = `${empCode}_${parsed.dateStr}`;
        if (!map[key]) {
            map[key] = {
                biometricId: empCode,
                dateStr: parsed.dateStr,
                name: row.Name || "",
                punches: [],
            };
        }

        map[key].punches.push({
            time: parsed.utcDate,
            mcid: row.MCID || row.mcid || null,
            mFlag: row.M_Flag || row.MFlag || null,
        });
    }

    // Sort punches chronologically within each day
    for (const rec of Object.values(map)) {
        rec.punches.sort((a, b) => new Date(a.time) - new Date(b.time));
    }

    return map;
}


// ═══════════════════════════════════════════════════════════════════════════════
//  RECORD FACTORIES
// ═══════════════════════════════════════════════════════════════════════════════

function buildAttendanceRecord(inOutRec, punchDetail, empDoc, settings, holidays) {
    const employeeType = empDoc?.employeeType || "operator";
    const dateStr = inOutRec.dateStr;
    const yearMonth = dateStr.substring(0, 7);
    const biometricId = inOutRec.biometricId;

    // Build raw punches from punch detail data (preferred) or inOut data
    let rawPunches = [];
    if (punchDetail?.punches?.length) {
        rawPunches = punchDetail.punches.map((p, i) => ({
            seq: i + 1, time: p.time, mcid: p.mcid || null,
            mFlag: p.mFlag || null, punchType: "unknown", source: "device",
        }));
    } else {
        // Fallback: create from inOut summary
        if (inOutRec.inTime) {
            const parsed = typeof inOutRec.inTime === "string" ? parsePunchDateTimeIST(inOutRec.inTime)?.utcDate : inOutRec.inTime;
            if (parsed) rawPunches.push({ seq: 1, time: parsed, mcid: null, mFlag: null, punchType: "in", source: "device" });
        }
        if (inOutRec.finalOut) {
            const parsed = typeof inOutRec.finalOut === "string" ? parsePunchDateTimeIST(inOutRec.finalOut)?.utcDate : inOutRec.finalOut;
            if (parsed) rawPunches.push({ seq: 2, time: parsed, mcid: null, mFlag: null, punchType: "out", source: "device" });
        }
    }

    // Classify punches using the corrected time windows
    const { classified, inTime, lunchOut, lunchIn, teaOut, teaIn, finalOut, punchCount } =
        classifyPunches(rawPunches, employeeType, settings);

    // Build record
    const record = {
        biometricId,
        numericId: normalizeId(biometricId),
        identityId: empDoc?.identityId || biometricId,
        employeeDbId: empDoc?._id || null,
        employeeName: empDoc?.name || inOutRec.name || "",
        department: empDoc?.department || "—",
        designation: empDoc?.designation || "—",
        employeeType,
        date: new Date(dateStr + "T00:00:00Z"),
        dateStr, yearMonth,
        shiftName: empDoc?.shiftCode || "GEN",
        shiftStart: settings.shiftStart || "09:00",
        shiftEnd: settings.shiftEnd || "18:30",
        rawPunches: classified,
        punchCount,
        inTime,
        lunchOut: employeeType === "operator" ? lunchOut : null,
        lunchIn: employeeType === "operator" ? lunchIn : null,
        teaOut: employeeType === "operator" ? teaOut : null,
        teaIn: employeeType === "operator" ? teaIn : null,
        finalOut,
        totalSpanMins: 0, lunchBreakMins: 0, teaBreakMins: 0, totalBreakMins: 0,
        netWorkMins: 0, otMins: 0, lateMins: 0, earlyDepartureMins: 0,
        isLate: false, isEarlyDeparture: false, hasOT: false, hasMissPunch: false,
        systemPrediction: "AB",
        isWeeklyOff: false, isHoliday: false, holidayName: null, holidayType: null,
        isOnLeave: false, leaveType: null,
        etimeRemark: inOutRec.etimeRemark || "", etimeStatus: inOutRec.etimeStatus || "",
        syncedAt: new Date(), syncSource: "api",
    };

    // Run the computation engine — THIS IS THE KEY STEP that was failing before
    computeDay(record, settings, employeeType, holidays);

    return record;
}

function buildPlaceholderRecord(biometricId, empDoc, dateStr, settings, holidays) {
    const employeeType = empDoc?.employeeType || "operator";
    const yearMonth = dateStr.substring(0, 7);
    const workingDays = settings.workingDays || [1, 2, 3, 4, 5, 6];

    let systemPrediction = "AB";
    let _isWeeklyOff = false, _isHoliday = false, _holidayName = null, _holidayType = null;

    if (isWeeklyOff(dateStr, workingDays)) { systemPrediction = "WO"; _isWeeklyOff = true; }
    const h = findHoliday(dateStr, holidays);
    if (h) { systemPrediction = "PH"; _isHoliday = true; _holidayName = h.name; _holidayType = h.type; }

    return {
        biometricId, numericId: normalizeId(biometricId),
        identityId: empDoc?.identityId || biometricId,
        employeeDbId: empDoc?._id || null,
        employeeName: empDoc?.name || "", department: empDoc?.department || "—",
        designation: empDoc?.designation || "—", employeeType,
        date: new Date(dateStr + "T00:00:00Z"), dateStr, yearMonth,
        shiftName: "GEN", shiftStart: settings.shiftStart || "09:00", shiftEnd: settings.shiftEnd || "18:30",
        rawPunches: [], punchCount: 0,
        inTime: null, lunchOut: null, lunchIn: null, teaOut: null, teaIn: null, finalOut: null,
        totalSpanMins: 0, lunchBreakMins: 0, teaBreakMins: 0, totalBreakMins: 0,
        netWorkMins: 0, otMins: 0, lateMins: 0, earlyDepartureMins: 0,
        isLate: false, isEarlyDeparture: false, hasOT: false, hasMissPunch: false,
        systemPrediction, hrFinalStatus: null, hrRemarks: null,
        isWeeklyOff: _isWeeklyOff, isHoliday: _isHoliday, holidayName: _holidayName, holidayType: _holidayType,
        isOnLeave: false, leaveType: null,
        etimeRemark: "", etimeStatus: "", syncedAt: new Date(), syncSource: "placeholder",
    };
}


// ═══════════════════════════════════════════════════════════════════════════════
//  MONTHLY SUMMARY & ENRICHMENT
// ═══════════════════════════════════════════════════════════════════════════════

function computeMonthSummary(days) {
    const s = {
        present: 0, presentLate: 0, presentEarlyOut: 0, halfDay: 0, absent: 0,
        weeklyOff: 0, publicHoliday: 0, leave: 0, leaveCL: 0, leaveSL: 0, leaveEL: 0,
        lwp: 0, missPunch: 0, wfh: 0, compOff: 0,
        totalWorkMins: 0, totalOtMins: 0, lateDays: 0,
        lateDeductionHalfDays: 0, effectivePresentDays: 0, totalDays: days.length,
    };

    for (const d of days) {
        const st = d.hrFinalStatus ?? d.systemPrediction ?? d.effectiveStatus ?? "AB";
        switch (st) {
            case "P": s.present++; break;
            case "P*": s.present++; s.presentLate++; s.lateDays++; break;
            case "P~": s.present++; s.presentEarlyOut++; break;
            case "HD": s.halfDay++; break;
            case "AB": s.absent++; break;
            case "WO": s.weeklyOff++; break;
            case "PH": s.publicHoliday++; break;
            case "L-CL": s.leave++; s.leaveCL++; break;
            case "L-SL": s.leave++; s.leaveSL++; break;
            case "L-EL": s.leave++; s.leaveEL++; break;
            case "LWP": s.lwp++; break;
            case "MP": s.missPunch++; break;
            case "WFH": s.wfh++; break;
            case "CO": s.compOff++; break;
        }
        s.totalWorkMins += d.netWorkMins || 0;
        s.totalOtMins += d.otMins || 0;
    }

    s.lateDeductionHalfDays = Math.floor(s.lateDays / 4);
    s.effectivePresentDays = s.present + (s.halfDay * 0.5) + (s.missPunch * 0.5) + s.wfh - (s.lateDeductionHalfDays * 0.5);
    s.totalWorkStr = minsToHHMM(s.totalWorkMins);
    s.totalOtStr = minsToHHMM(s.totalOtMins);
    return s;
}

function enrichRecord(r) {
    if (!r) return r;
    const effectiveStatus = r.hrFinalStatus ?? r.systemPrediction ?? "AB";
    return {
        ...r,
        effectiveStatus,
        hrReviewed: r.hrFinalStatus !== null && r.hrFinalStatus !== undefined,
        inTimeStr: r.inTime ? dateToTimeStrIST(r.inTime) : "--:--",
        finalOutStr: r.finalOut ? dateToTimeStrIST(r.finalOut) : "--:--",
        lunchOutStr: r.lunchOut ? dateToTimeStrIST(r.lunchOut) : "--:--",
        lunchInStr: r.lunchIn ? dateToTimeStrIST(r.lunchIn) : "--:--",
        teaOutStr: r.teaOut ? dateToTimeStrIST(r.teaOut) : "--:--",
        teaInStr: r.teaIn ? dateToTimeStrIST(r.teaIn) : "--:--",
        netWorkStr: minsToHHMM(r.netWorkMins),
        totalBreakStr: minsToHHMM(r.totalBreakMins),
        otStr: minsToHHMM(r.otMins),
        lateStr: r.lateMins > 0 ? `+${minsToHHMM(r.lateMins)}` : "--:--",
        earlyDepartureStr: minsToHHMM(r.earlyDepartureMins),
        totalSpanStr: minsToHHMM(r.totalSpanMins),
        statusLabel: getStatusLabel(effectiveStatus),
        statusColor: getStatusColor(effectiveStatus),
    };
}

function getStatusLabel(code) {
    const labels = {
        P: "Present", "P*": "Late", "P~": "Early Out", HD: "Half Day", AB: "Absent",
        WO: "Weekly Off", PH: "Holiday", "L-CL": "Casual Leave", "L-SL": "Sick Leave",
        "L-EL": "Earned Leave", LWP: "Leave Without Pay", MP: "Missing Punch",
        WFH: "Work From Home", CO: "Comp Off",
    };
    return labels[code] || code;
}

function getStatusColor(code) {
    const colors = {
        P: "green", "P*": "orange", "P~": "yellow", HD: "amber", AB: "red",
        WO: "gray", PH: "blue", "L-CL": "purple", "L-SL": "purple", "L-EL": "purple",
        LWP: "red", MP: "pink", WFH: "teal", CO: "indigo",
    };
    return colors[code] || "gray";
}


/**
 * Extract a name map from raw eTimeOffice PunchData response.
 * Returns { empcode: name } for use in name-based employee matching.
 */
function extractNameMap(data) {
    const nameMap = {};
    let rows;
    if (Array.isArray(data)) rows = data;
    else if (data?.PunchData && Array.isArray(data.PunchData)) rows = data.PunchData;
    else return nameMap;

    for (const row of rows) {
        const code = row.Empcode || row.EmpCode || "";
        const name = row.Name || "";
        if (code && name && !nameMap[code]) nameMap[code] = name;
    }
    return nameMap;
}


// ═══════════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
    normalizeId, hhmmToMins, minsToHHMM, dateToMinsIST, dateToTimeStrIST,
    diffMins, isWeeklyOff, findHoliday, deduplicatePunches,
    buildEmployeeMap,
    classifyPunches, PUNCH_WINDOWS,
    computeDay,
    buildAttendanceRecord, buildPlaceholderRecord,
    parseInOutResponse, parsePunchDataResponse, parsePunchDateTimeIST,
    extractNameMap,
    computeMonthSummary,
    enrichRecord, getStatusLabel, getStatusColor,
};