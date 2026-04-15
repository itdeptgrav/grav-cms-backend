/**
 * BiometricSyncService.js
 *
 * Handles ALL communication with eTimeOffice biometric API.
 * Credentials come ONLY from .env — never from frontend, never hardcoded.
 *
 * Required .env keys:
 *   ETIMEOFFICE_URL=https://api.etimeoffice.com/api/DownloadPunchData
 *   ETIMEOFFICE_USERNAME=gsawavec:gr334eav
 *   ETIMEOFFICE_PASSWORD=geewav@202325
 *   BIOMETRIC_SYNC_INTERVAL_MINUTES=30   (default 30)
 *   SHIFT_START=09:00
 *   SHIFT_END=18:00
 *   LATE_THRESHOLD_MINS=15
 *   HALF_DAY_THRESHOLD_MINS=270
 *   EARLY_OUT_THRESHOLD_MINS=30
 *
 * FIX: The unique index on { employeeId, dateString } caused E11000 when
 *      multiple biometric employees aren't linked to any Employee doc (employeeId=null).
 *      Solution: upsert on { biometricId, dateString } — biometricId is always present.
 *      We remove the compound unique index on employeeId+dateString and rely on
 *      biometricId+dateString uniqueness instead (see Attendance model note).
 */

const axios = require("axios");
const cron = require("node-cron");
const Attendance = require("../models/HR_Models/Attendance");
const Employee = require("../models/Employee");

// ── Read all config from env ──────────────────────────────────────────────────
const BIO_URL = process.env.ETIMEOFFICE_URL || "https://api.etimeoffice.com/api/DownloadPunchData";
const BIO_USER = process.env.ETIMEOFFICE_USERNAME || "";
const BIO_PASS = process.env.ETIMEOFFICE_PASSWORD || "";
const SYNC_INTERVAL = parseInt(process.env.BIOMETRIC_SYNC_INTERVAL_MINUTES || "30", 10);
const SHIFT_START = process.env.SHIFT_START || "09:00";
const SHIFT_END = process.env.SHIFT_END || "18:00";
const LATE_THRESH = parseInt(process.env.LATE_THRESHOLD_MINS || "15", 10);
const HALF_THRESH = parseInt(process.env.HALF_DAY_THRESHOLD_MINS || "270", 10);
const EARLY_THRESH = parseInt(process.env.EARLY_OUT_THRESHOLD_MINS || "30", 10);

// ── Internal state ────────────────────────────────────────────────────────────
let lastSyncTime = null;
let lastSyncResult = null;
let isSyncing = false;
let cronJob = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function toDateString(d) {
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function formatTime(date) {
    if (!date) return null;
    return new Date(date).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}

function parseHHMM(str) {
    const [h, m] = (str || "09:00").split(":").map(Number);
    return h * 60 + (m || 0);
}

/** eTimeOffice date format: DD/MM/YYYY_HH:MM */
function fmtBioDate(date, endOfDay = false) {
    const d = new Date(date);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}/${d.getFullYear()}_${endOfDay ? "23:59" : "00:00"}`;
}

/** Parse "10/03/2026 21:17:00" → Date */
function parseBioDate(str) {
    const [dp, tp] = str.trim().split(" ");
    const [d, m, y] = dp.split("/");
    return new Date(`${y}-${m}-${d}T${tp}`);
}

// ── Step 1: Fetch raw punches from eTimeOffice ────────────────────────────────
async function fetchRawPunches(fromDate, toDate) {
    if (!BIO_USER || !BIO_PASS) throw new Error("Biometric credentials not set in .env (ETIMEOFFICE_USERNAME / ETIMEOFFICE_PASSWORD)");

    const url = `${BIO_URL}?Empcode=ALL&FromDate=${fmtBioDate(fromDate)}&ToDate=${fmtBioDate(toDate, true)}`;
    console.log("[Biometric] Fetching:", url);

    const resp = await axios.get(url, {
        auth: { username: BIO_USER, password: BIO_PASS },
        timeout: 30000,
    });

    const data = resp.data;
    if (!data.PunchData) throw new Error(`eTimeOffice returned: ${JSON.stringify(data).slice(0, 200)}`);
    return data.PunchData;
}

// ── Step 2: Process raw punches into structured daily records ─────────────────
/**
 * Logic (from device documentation):
 *   - Sort all punches for an employee on a day chronologically
 *   - First punch  = check-in
 *   - Last punch   = check-out
 *   - Middle pairs = break-out / break-in (tea breaks, lunch, etc.)
 */
function processPunches(rawPunches) {
    const groups = {};

    for (const p of rawPunches) {
        const dt = parseBioDate(p.PunchDate);
        const key = `${p.Empcode}_${toDateString(dt)}`;
        if (!groups[key]) groups[key] = { name: p.Name, empcode: p.Empcode, date: toDateString(dt), punches: [] };
        groups[key].punches.push(dt);
    }

    const results = [];

    for (const g of Object.values(groups)) {
        const sorted = g.punches.slice().sort((a, b) => a - b);
        const checkIn = sorted[0];
        const checkOut = sorted.length > 1 ? sorted[sorted.length - 1] : null;

        const workingMins = checkOut ? Math.round((checkOut - checkIn) / 60000) : 0;

        // Detect breaks from middle punch pairs
        const middle = sorted.slice(1, sorted.length - 1);
        const breaks = [];
        for (let i = 0; i + 1 < middle.length; i += 2) {
            const breakOut = middle[i];
            const breakIn = middle[i + 1];
            const dur = Math.round((breakIn - breakOut) / 60000);
            if (dur > 0 && dur < 180) {
                breaks.push({
                    out: breakOut,
                    in: breakIn,
                    durationMins: dur,
                    type: dur <= 20 ? "tea_break" : dur <= 45 ? "lunch_break" : "extended_break",
                });
            }
        }

        const breakMins = breaks.reduce((s, b) => s + b.durationMins, 0);
        const effectiveMins = Math.max(0, workingMins - breakMins);

        const shiftStartMins = parseHHMM(SHIFT_START);
        const shiftEndMins = parseHHMM(SHIFT_END);
        const ciMins = checkIn.getHours() * 60 + checkIn.getMinutes();
        const coMins = checkOut ? checkOut.getHours() * 60 + checkOut.getMinutes() : 0;

        const lateBy = Math.max(0, ciMins - shiftStartMins);
        const isLate = lateBy > LATE_THRESH;
        const isEarlyOut = checkOut ? coMins < shiftEndMins - EARLY_THRESH : false;
        const overtimeMins = checkOut ? Math.max(0, coMins - shiftEndMins) : 0;

        let status = "present";
        if (effectiveMins <= 0) status = "absent";
        else if (effectiveMins < HALF_THRESH) status = "half_day";
        else if (isLate && !isEarlyOut) status = "late";
        else if (isEarlyOut) status = "early_departure";

        results.push({
            name: g.name,
            empcode: g.empcode,
            date: g.date,
            checkIn,
            checkOut,
            checkInTime: formatTime(checkIn),
            checkOutTime: checkOut ? formatTime(checkOut) : null,
            workingMinutes: workingMins,
            breakMinutes: breakMins,
            effectiveMinutes: effectiveMins,
            overtimeMinutes: overtimeMins,
            hasOvertime: overtimeMins > 0,
            lateByMinutes: lateBy,
            isLate,
            isEarlyOut,
            status,
            allPunches: sorted.map(p => p.toISOString()),
            breaks: breaks.map(b => ({
                out: b.out.toISOString(),
                in: b.in.toISOString(),
                durationMins: b.durationMins,
                type: b.type,
            })),
            totalPunches: sorted.length,
        });
    }

    return results;
}

// ── Step 3: Upsert records into MongoDB ──────────────────────────────────────
/**
 * KEY FIX: We now upsert on { biometricId, dateString } instead of
 * { employeeId, dateString }. This avoids E11000 duplicate key errors when
 * multiple employees are NOT yet linked to an Employee document (employeeId=null).
 *
 * IMPORTANT: Also drop the old unique index on employeeId+dateString in MongoDB:
 *   db.attendances.dropIndex("employeeId_1_dateString_1")
 *   db.attendances.createIndex({ biometricId: 1, dateString: 1 }, { unique: true })
 */
async function upsertRecords(records) {
    let upserted = 0, failed = 0;

    // Pre-fetch all employees with biometricIds in one query for performance
    const allEmpcodes = [...new Set(records.map(r => r.empcode))];
    const employees = await Employee.find({ biometricId: { $in: allEmpcodes } })
        .select("_id department designation gender biometricId firstName lastName")
        .lean();

    const empMap = {};
    for (const e of employees) {
        empMap[e.biometricId] = e;
    }

    for (const r of records) {
        try {
            const emp = empMap[r.empcode] || null;

            const doc = {
                // Link employee if found
                ...(emp ? { employeeId: emp._id } : {}),
                employeeName: emp
                    ? `${emp.firstName || ""} ${emp.lastName || ""}`.trim() || r.name
                    : r.name,
                biometricId: r.empcode,
                department: emp?.department || null,
                designation: emp?.designation || null,
                date: new Date(r.date),
                dateString: r.date,
                checkIn: r.checkIn,
                checkOut: r.checkOut,
                checkInTime: r.checkInTime,
                checkOutTime: r.checkOutTime,
                workingMinutes: r.workingMinutes,
                breakMinutes: r.breakMinutes,
                effectiveMinutes: r.effectiveMinutes,
                overtimeMinutes: r.overtimeMinutes,
                hasOvertime: r.hasOvertime,
                isLate: r.isLate,
                isEarlyCheckout: r.isEarlyOut,
                status: r.status,
                shiftStart: SHIFT_START,
                shiftEnd: SHIFT_END,
                // Store full punch detail for timeline view
                remarks: JSON.stringify({
                    allPunches: r.allPunches,
                    breaks: r.breaks,
                    totalPunches: r.totalPunches,
                    lateByMinutes: r.lateByMinutes,
                }),
            };

            // ── THE FIX: upsert on biometricId + dateString ──
            await Attendance.findOneAndUpdate(
                { biometricId: r.empcode, dateString: r.date },
                { $set: doc },
                { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: false }
            );
            upserted++;
        } catch (err) {
            console.error(`[Biometric] Failed ${r.empcode} ${r.date}:`, err.message);
            failed++;
        }
    }
    return { upserted, failed };
}

// ── Main sync function ────────────────────────────────────────────────────────
async function syncBiometricData(fromDate, toDate) {
    if (isSyncing) { console.log("[Biometric] Already syncing, skipping"); return { skipped: true }; }

    isSyncing = true;
    const from = fromDate ? new Date(fromDate) : new Date();
    const to = toDate ? new Date(toDate) : new Date();

    console.log(`[Biometric] Sync start: ${toDateString(from)} → ${toDateString(to)}`);
    try {
        const raw = await fetchRawPunches(from, to);
        const processed = processPunches(raw);
        const result = await upsertRecords(processed);

        lastSyncTime = new Date().toISOString();
        lastSyncResult = {
            success: true,
            rawPunches: raw.length,
            records: processed.length,
            ...result,
        };
        console.log("[Biometric] Sync done:", lastSyncResult);
        return lastSyncResult;
    } catch (err) {
        lastSyncResult = { success: false, error: err.message };
        console.error("[Biometric] Sync failed:", err.message);
        return lastSyncResult;
    } finally {
        isSyncing = false;
    }
}

// ── Auto-sync: runs on startup + every N minutes ──────────────────────────────
function startAutoSync() {
    if (!BIO_USER || !BIO_PASS) {
        console.warn("[Biometric] No credentials in .env — auto-sync disabled");
        return;
    }

    const runNow = async () => {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        await syncBiometricData(yesterday, today);
    };

    runNow().catch(console.error);
    cronJob = cron.schedule(`*/${SYNC_INTERVAL} * * * *`, runNow, { timezone: "Asia/Kolkata" });
    console.log(`[Biometric] Auto-sync scheduled every ${SYNC_INTERVAL}min`);
}

function stopAutoSync() {
    if (cronJob) { cronJob.destroy(); cronJob = null; }
}

function getSyncStatus() {
    return {
        lastSyncTime,
        lastSyncResult,
        isSyncing,
        syncIntervalMinutes: SYNC_INTERVAL,
        credentialsConfigured: !!(BIO_USER && BIO_PASS),
        shiftConfig: { SHIFT_START, SHIFT_END, LATE_THRESH, HALF_THRESH, EARLY_THRESH },
    };
}

module.exports = { syncBiometricData, startAutoSync, stopAutoSync, getSyncStatus };