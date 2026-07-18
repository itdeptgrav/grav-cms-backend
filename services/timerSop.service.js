/**
 * backend/services/timerSop.service.js
 *
 * Evaluates an employee's timer work day-by-day and adjusts SOP points when
 * accumulated deficit or overtime thresholds are crossed.
 *
 * Called after every cowork_work_commits write (both the manual commit-modal
 * path and the auto-pause-on-submit-for-review path in tasks/page.js).
 *
 * FIXES vs the previous version:
 *   1. `snap.exists` is a property on Admin SDK snapshots, not a function.
 *      `snap.exists()` throws a TypeError on every call, silently swallowed
 *      by the outer catch — the engine never ran once.
 *   2. Employee lookup used `{ employeeId }`. Employee has no such stored
 *      field — `employeeId` is a read-only virtual mapped to `biometricId`
 *      and is NOT queryable. Every lookup returned null. Fixed to
 *      `{ biometricId: employeeId }`, matching soproute.js's applyBleach.
 *   3. Double-counting: the old code re-summed *today's still-in-progress*
 *      total on every single pause and added the full (partial) deficit to
 *      the accumulator each time — so a day with 4 pauses added that day's
 *      shortfall 4 times over. Fixed by only ever finalizing a day once it
 *      is actually over (a past calendar day, or today once today's office
 *      hours have ended) via a `lastFinalizedDate` watermark. Catches up on
 *      any number of skipped days in one run, each processed independently,
 *      each correctly skipping days the office schedule marks `isOff`.
 *   4. Bleach entries are now filed under the sopPoints year that matches
 *      the day being finalized, not always "the year the code happens to
 *      run in" — matters when a catch-up run crosses a Dec 31 -> Jan 1
 *      boundary.
 *   5. Overtime is CLOCK-BASED: time worked after that day's office
 *      closing hour (cowork_settings/office outTime), plus all worked time
 *      on weekly-off days. Deficit stays vs Daily Minimum. The two rules
 *      are independent — the same day can add to both counters.
 */

const admin = require("firebase-admin");
const db = admin.firestore();
const Employee = require("../models/Employee");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MAX_DAYS_PER_RUN = 60; // safety cap so a very stale watermark can't loop forever

/** IST calendar-date string (YYYY-MM-DD) for a UTC ms timestamp. */
function _istDateStr(utcMs) {
    return new Date(utcMs + IST_OFFSET_MS).toISOString().split("T")[0];
}

/** Add N whole calendar days to a YYYY-MM-DD label. Pure string/date-label
 *  arithmetic, anchored at UTC midnight of the label — never mixed with the
 *  "real IST instant" math above, so it can't inherit an offset bug. */
function _addDaysToLabel(dateStr, n) {
    const anchor = Date.parse(dateStr + "T00:00:00.000Z");
    return new Date(anchor + n * MS_PER_DAY).toISOString().split("T")[0];
}

/** Day-of-week (0=Sun) for a YYYY-MM-DD label. */
function _dowForLabel(dateStr) {
    const anchor = Date.parse(dateStr + "T00:00:00.000Z");
    return new Date(anchor).getUTCDay();
}

/** Has the given IST clock time ("HH:MM") on the given date already passed? */
function _isPastClockTimeIST(dateStr, hhmm) {
    const instant = Date.parse(`${dateStr}T${hhmm}:00+05:30`);
    return Date.now() >= instant;
}

/** Resolve a day's config from the office schedule, with the same fallback
 *  default the rest of the app already uses. */
function _dayCfgFor(dateStr, schedule) {
    const dayKey = DAY_KEYS[_dowForLabel(dateStr)];
    return schedule?.[dayKey] ?? { isOff: dayKey === "sunday", inTime: "09:30", outTime: "18:30" };
}

function _breakOverlapSecs(startMs, endMs, dateStr, breaks) {
    if (!breaks || !breaks.length) return 0;
    let overlapMs = 0;
    for (const b of breaks) {
        const bStart = Date.parse(`${dateStr}T${b.start}:00+05:30`);
        const bEnd = Date.parse(`${dateStr}T${b.end}:00+05:30`);
        if (bEnd <= bStart) continue;
        const ovStart = Math.max(startMs, bStart);
        const ovEnd = Math.min(endMs, bEnd);
        if (ovEnd > ovStart) overlapMs += (ovEnd - ovStart);
    }
    return Math.round(overlapMs / 1000);
}

function _expectedHrsForDay(dateStr, dayCfg, breaks, firstStartMs) {
    const officeStartMs = Date.parse(`${dateStr}T${dayCfg.inTime}:00+05:30`);
    const officeEndMs = Date.parse(`${dateStr}T${dayCfg.outTime}:00+05:30`);
    // Window starts at actual login — never before office start (early login
    // doesn't inflate the target), never past office close. No login at all
    // that day → firstStartMs is undefined → falls back to the FULL office
    // span. Without that fallback, a total no-show would owe nothing.
    const windowStartMs = firstStartMs != null
        ? Math.max(officeStartMs, Math.min(firstStartMs, officeEndMs))
        : officeStartMs;
    const spanHrs = Math.max(0, (officeEndMs - windowStartMs) / 3600000);
    const breakHrs = _breakOverlapSecs(windowStartMs, officeEndMs, dateStr, breaks) / 3600;
    return Math.max(0, spanHrs - breakHrs);
}

/**
 * Main export — call this after every timer pause/stop (i.e. after every
 * cowork_work_commits write). Safe to call redundantly: it only ever acts
 * on days that are actually over, tracked via emp.lastFinalizedDate, so a
 * missed or duplicate call just gets caught up (or no-ops) on the next one.
 *
 * Returns a status object instead of void so callers — specifically the
 * test-finalize route — can see exactly what happened rather than having
 * to separately poll the accum endpoint afterward.
 *
 * @param {string} employeeId  the CoWork employeeId (== Employee.biometricId)
 * @param {string} employeeName
 * @param {object} [opts]
 * @param {boolean} [opts.forceToday] TEST/ADMIN USE ONLY. Skips the "is
 *   today actually over" check and finalizes today regardless of the
 *   clock. Do not call this from the normal pause/commit flow — it exists
 *   so a real day's total can be verified without waiting for real office
 *   hours to pass. Finalizing a day before it's actually over can dock or
 *   credit someone based on a total they were still going to add to.
 */
async function evaluateTimerSop(employeeId, employeeName, opts = {}) {
    const { forceToday = false } = opts;
    try {
        // ── 1. Load SOP config ──────────────────────────────────────────────
        const sopSnap = await db.collection("cowork_sop_settings").doc("task_events").get();
        if (!sopSnap.exists) return { ok: false, reason: "sop_config_missing" };
        const sopCfg = sopSnap.data();

        // ── Admin kill-switch — checked first, before anything else runs.
        // Every trigger path (timer pause, task auto-stop, the daily cron,
        // the CEO test tool) goes through this one function, so this one
        // check is enough to pause point cutting/adding for everyone.
        if (sopCfg.timerSopEnabled === false) return { ok: false, reason: "disabled" };

        const dailyMinHrs = parseFloat(sopCfg.timerMinDailyHrs) || 0;
        const dailyMinPct = parseFloat(sopCfg.timerMinDailyPct) || 0;
        const deficitThresholdHrs = parseFloat(sopCfg.timerDeficitThresholdHrs) || 0;
        const deficitPoints = parseFloat(sopCfg.timerDeficitPoints) || 0;
        const overtimeThresholdHrs = parseFloat(sopCfg.timerOvertimeThresholdHrs) || 0;
        const overtimePoints = parseFloat(sopCfg.timerOvertimePoints) || 0;

        if (!dailyMinHrs && !dailyMinPct && !deficitThresholdHrs && !overtimeThresholdHrs) return { ok: false, reason: "not_configured" }; // not configured

        // ── 2. Load office schedule + breaks once (same doc, same read) ─────
        const officeSnap = await db.collection("cowork_settings").doc("office").get();
        const schedule = officeSnap.exists ? officeSnap.data().schedule : null;
        const breaks = officeSnap.exists ? (officeSnap.data().breaks || []) : [];

        // ── 3. Load employee — biometricId, NOT the virtual employeeId ─────
        const emp = await Employee.findOne({ biometricId: employeeId });
        if (!emp) return { ok: false, reason: "employee_not_found" };

        const todayIST = _istDateStr(Date.now());

        // ── 4. Work out which days are actually finalizable ────────────────
        // A day is only ever evaluated once it's over: a past calendar day,
        // or today itself once today's office hours have already ended.
        // First-ever run starts the watermark at today — it never reaches
        // back before the feature existed.
        let cursor = emp.lastFinalizedDate ? _addDaysToLabel(emp.lastFinalizedDate, 1) : todayIST;
        const daysToFinalize = [];
        let guard = 0;
        while (cursor <= todayIST && guard++ < MAX_DAYS_PER_RUN) {
            if (cursor === todayIST && !forceToday) {
                const todayCfg = _dayCfgFor(todayIST, schedule);
                const todayIsOver = todayCfg.isOff || _isPastClockTimeIST(todayIST, todayCfg.outTime);
                if (!todayIsOver) break; // today isn't over yet — stop here, try again later
            }
            daysToFinalize.push(cursor);
            cursor = _addDaysToLabel(cursor, 1);
        }
        if (daysToFinalize.length === 0) {
            return {
                ok: true,
                reason: "nothing_to_finalize_yet",
                lastFinalizedDate: emp.lastFinalizedDate || null,
                todayIST,
                hint: forceToday
                    ? "Unexpected with forceToday set — lastFinalizedDate is already >= today."
                    : "Today isn't over yet (per cowork_settings/office schedule) and there's no earlier unfinalized day. This is expected mid-day, not a bug.",
            };
        }

        // ── 5. Pull every work-commit log once, bucket seconds by IST date ──
        const logsSnap = await db
            .collection("cowork_work_commits")
            .doc(employeeId)
            .collection("logs")
            .get();

        const parsed = [];
        logsSnap.docs.forEach(d => {
            const data = d.data();
            // Firestore Timestamp shape varies (toMillis() on real Timestamp
            // instances, _seconds internally, .seconds on some serializations,
            // or a raw string/date from older writes). Handle all of them,
            // and never let one weird value produce NaN -> RangeError that
            // kills the entire run.
            const stoppedMs = (() => {
                const v = data.stoppedAt;
                if (!v) return null;
                if (typeof v.toMillis === "function") return v.toMillis();
                if (typeof v._seconds === "number") return v._seconds * 1000;
                if (typeof v.seconds === "number") return v.seconds * 1000;
                const t = new Date(v).getTime();
                return Number.isNaN(t) ? null : t;
            })();
            if (!stoppedMs) return;
            const cumulativeSecs = Number(data.secondsWorked) || 0;
            if (cumulativeSecs <= 0) return;
            parsed.push({ taskId: data.taskId || "_no_task", stoppedMs, cumulativeSecs });
        });

        const byTask = new Map();
        parsed.forEach(p => {
            if (!byTask.has(p.taskId)) byTask.set(p.taskId, []);
            byTask.get(p.taskId).push(p);
        });

        const realEntries = [];
        byTask.forEach(entries => {
            entries.sort((a, b) => a.stoppedMs - b.stoppedMs);
            let prevCumulative = 0;
            entries.forEach(e => {
                let realSecs;
                if (e.cumulativeSecs > prevCumulative) realSecs = e.cumulativeSecs - prevCumulative;
                else if (e.cumulativeSecs < prevCumulative) realSecs = e.cumulativeSecs;
                else realSecs = 0;
                if (realSecs > 0) realEntries.push({ stoppedMs: e.stoppedMs, realSecs });
                prevCumulative = e.cumulativeSecs;
            });
        });

        const secsByDate = {};
        const afterSecsByDate = {};
        realEntries.forEach(({ stoppedMs, realSecs }) => {
            const dateStr = _istDateStr(stoppedMs);
            const dayCfg = _dayCfgFor(dateStr, schedule);
            const startMs = stoppedMs - realSecs * 1000;
            const breakSecs = _breakOverlapSecs(startMs, stoppedMs, dateStr, breaks);
            const netSecs = Math.max(0, realSecs - breakSecs);
            if (netSecs <= 0) return;

            secsByDate[dateStr] = (secsByDate[dateStr] || 0) + netSecs;

            if (dayCfg.isOff) {
                afterSecsByDate[dateStr] = (afterSecsByDate[dateStr] || 0) + netSecs;
            } else {
                const officeStartMs = Date.parse(`${dateStr}T${dayCfg.inTime}:00+05:30`);
                const officeEndMs = Date.parse(`${dateStr}T${dayCfg.outTime}:00+05:30`);
                const netStartMs = stoppedMs - netSecs * 1000;
                const insideMs = Math.max(0, Math.min(stoppedMs, officeEndMs) - Math.max(netStartMs, officeStartMs));
                const outsideMs = (stoppedMs - netStartMs) - insideMs;
                if (outsideMs > 0) {
                    afterSecsByDate[dateStr] = (afterSecsByDate[dateStr] || 0) + Math.round(outsideMs / 1000);
                }
            }
        });

        // Only the earliest "start" per IST day is needed now — it's the
        // opening moment of _expectedHrsForDay's personalized window.
        const eventsSnap = await db.collection("cowork_timer_events").doc(employeeId).collection("logs").get();
        const firstStartMsByDate = {};
        eventsSnap.docs.forEach(d => {
            const data = d.data();
            if (data.type !== "start") return;
            const atMs = (() => {
                const v = data.at;
                if (!v) return null;
                if (typeof v.toMillis === "function") return v.toMillis();
                if (typeof v._seconds === "number") return v._seconds * 1000;
                if (typeof v.seconds === "number") return v.seconds * 1000;
                const t = new Date(v).getTime();
                return Number.isNaN(t) ? null : t;
            })();
            if (!atMs) return;
            const dateStr = _istDateStr(atMs);
            if (firstStartMsByDate[dateStr] == null || atMs < firstStartMsByDate[dateStr]) {
                firstStartMsByDate[dateStr] = atMs;
            }
        });

        // ── 6. Walk each finalizable day independently ──────────────────────
        let deficitAccum = parseFloat(emp.timerDeficitAccumHrs) || 0;
        let overtimeAccum = parseFloat(emp.timerOvertimeAccumHrs) || 0;
        const deficitAccumBefore = deficitAccum;
        const overtimeAccumBefore = overtimeAccum;
        const bleachesToAdd = []; // each carries its own `date` for correct year filing

        for (const dateStr of daysToFinalize) {
            const dayCfg = _dayCfgFor(dateStr, schedule);

            const workedHrs = (secsByDate[dateStr] || 0) / 3600;
            const afterHrs = (afterSecsByDate[dateStr] || 0) / 3600;

            const effectiveMinHrs = dailyMinPct > 0
                ? (dailyMinPct / 100) * _expectedHrsForDay(dateStr, dayCfg, breaks, firstStartMsByDate[dateStr])
                : dailyMinHrs;

            const rawShortfallHrs = Math.max(0, effectiveMinHrs - workedHrs);
            if (!dayCfg.isOff && effectiveMinHrs > 0 && deficitThresholdHrs > 0 && deficitPoints > 0 && rawShortfallHrs > 0) {
                deficitAccum += rawShortfallHrs;
                while (deficitAccum >= deficitThresholdHrs) {
                    bleachesToAdd.push({
                        type: "C3",
                        sopName: "Idle Pool Deduction",
                        folderName: "Time Tracking",
                        points: deficitPoints,
                        bleachType: "credit", // penalty — increases totalDeducted
                        description: `Idle/deficit pool reached ${deficitThresholdHrs}h threshold as of ${dateStr}. Worked ${Math.round(workedHrs * 60)}min / required ${Math.round(effectiveMinHrs * 60)}min that day.`,
                        date: dateStr,
                        cutBy: "system",
                        cutByName: "System (Timer Engine)",
                        cutByRole: "system",
                    });
                    deficitAccum -= deficitThresholdHrs; // keep remainder, per spec
                }
            }

            // Overtime — CLOCK-BASED: time worked after that day's office
            // closing hour (all worked time on weekly-off days). Independent
            // of the deficit rule — the same day can add to both counters
            // (e.g. worked only 2h, but 1h of it after office close: 5h
            // deficit AND 1h overtime).
            if (overtimeThresholdHrs > 0 && overtimePoints > 0 && afterHrs > 0) {
                overtimeAccum += afterHrs;
                while (overtimeAccum >= overtimeThresholdHrs) {
                    bleachesToAdd.push({
                        type: "C4",
                        sopName: "Overtime Reward",
                        folderName: "Time Tracking",
                        points: overtimePoints,
                        bleachType: "debit", // reward — decreases totalDeducted
                        description: `Accumulated overtime reached ${overtimeThresholdHrs}h threshold as of ${dateStr}. Worked ${Math.round(afterHrs * 60)}min outside office hours that day.`,
                        date: dateStr,
                        cutBy: "system",
                        cutByName: "System (Timer Engine)",
                        cutByRole: "system",
                    });
                    overtimeAccum -= overtimeThresholdHrs;
                }
            }
        }

        // ── 7. File each bleach under the sopPoints year IT actually belongs to ──
        if (bleachesToAdd.length > 0) {
            emp.sopPoints = emp.sopPoints || [];
            for (const b of bleachesToAdd) {
                const year = Number(b.date.slice(0, 4));
                let yearEntry = emp.sopPoints.find(y => y.year === year);
                if (!yearEntry) {
                    emp.sopPoints.push({ year, totalDeducted: 0, bleaches: [] });
                    yearEntry = emp.sopPoints[emp.sopPoints.length - 1];
                }
                yearEntry.bleaches.push(b);
                const delta = b.bleachType === "credit" ? b.points : -b.points;
                yearEntry.totalDeducted = +((yearEntry.totalDeducted || 0) + delta).toFixed(2);
            }
            emp.markModified("sopPoints");
        }

        // ── 8. Persist accumulators + watermark ─────────────────────────────
        emp.timerDeficitAccumHrs = +deficitAccum.toFixed(4);
        emp.timerOvertimeAccumHrs = +overtimeAccum.toFixed(4);
        emp.lastFinalizedDate = daysToFinalize[daysToFinalize.length - 1];
        await emp.save();

        if (bleachesToAdd.length > 0) {
            console.log(`[timerSop] ${employeeId}: ${bleachesToAdd.map(b => `${b.bleachType}=${b.points}pts (${b.sopName}, ${b.date})`).join(", ")}`);
        }

        return {
            ok: true,
            finalizedDates: daysToFinalize,
            bleachesApplied: bleachesToAdd,
            deficitAccum: { before: +deficitAccumBefore.toFixed(4), after: emp.timerDeficitAccumHrs },
            overtimeAccum: { before: +overtimeAccumBefore.toFixed(4), after: emp.timerOvertimeAccumHrs },
            lastFinalizedDate: emp.lastFinalizedDate,
        };

    } catch (e) {
        console.error("[timerSop] evaluateTimerSop error:", e.message);
        // Non-fatal for the normal pause/commit flow — but the test route
        // awaits this, so it still needs a real answer, not silence.
        return { ok: false, reason: "error", message: e.message };
    }
}

async function evaluateTimerSopForAllEmployees() {
    const employees = await Employee.find({
        isActive: true,
        biometricId: { $exists: true, $nin: [null, ""] },
    }).select("biometricId firstName lastName").lean();
    const results = [];
    for (const emp of employees) {
        const name = [emp.firstName, emp.lastName].filter(Boolean).join(" ") || emp.biometricId;
        try {
            const result = await evaluateTimerSop(emp.biometricId, name);
            results.push({ employeeId: emp.biometricId, ...result });
        } catch (e) {
            console.error(`[timerSop] daily run failed for ${emp.biometricId}:`, e.message);
            results.push({ employeeId: emp.biometricId, ok: false, reason: "error", message: e.message });
        }
    }
    const totalBleaches = results.reduce((s, r) => s + (r.bleachesApplied?.length || 0), 0);
    console.log(`[timerSop] daily run complete: ${employees.length} employees checked, ${totalBleaches} bleach entries applied.`);
    return { employeeCount: employees.length, totalBleaches, results };
}

async function calculateLateStayHours(employeeId, startDateStr, endDateStr, opts = {}) {
    const lateStayThresholdHrs = opts.lateStayThresholdHrs ?? 9;

    const officeSnap = await db.collection("cowork_settings").doc("office").get();
    const schedule = officeSnap.exists ? officeSnap.data().schedule : null;
    const breaks = officeSnap.exists ? (officeSnap.data().breaks || []) : [];

    const logsSnap = await db.collection("cowork_work_commits").doc(employeeId).collection("logs").get();
    const parsed = [];
    logsSnap.docs.forEach(d => {
        const data = d.data();
        const stoppedMs = (() => {
            const v = data.stoppedAt;
            if (!v) return null;
            if (typeof v.toMillis === "function") return v.toMillis();
            if (typeof v._seconds === "number") return v._seconds * 1000;
            if (typeof v.seconds === "number") return v.seconds * 1000;
            const t = new Date(v).getTime();
            return Number.isNaN(t) ? null : t;
        })();
        if (!stoppedMs) return;
        const cumulativeSecs = Number(data.secondsWorked) || 0;
        if (cumulativeSecs <= 0) return;
        parsed.push({ taskId: data.taskId || "_no_task", stoppedMs, cumulativeSecs });
    });

    const byTask = new Map();
    parsed.forEach(p => {
        if (!byTask.has(p.taskId)) byTask.set(p.taskId, []);
        byTask.get(p.taskId).push(p);
    });

    const secsByDate = {};
    byTask.forEach(entries => {
        entries.sort((a, b) => a.stoppedMs - b.stoppedMs);
        let prevCumulative = 0;
        entries.forEach(e => {
            let realSecs;
            if (e.cumulativeSecs > prevCumulative) realSecs = e.cumulativeSecs - prevCumulative;
            else if (e.cumulativeSecs < prevCumulative) realSecs = e.cumulativeSecs;
            else realSecs = 0;
            prevCumulative = e.cumulativeSecs;
            if (realSecs <= 0) return;

            const dateStr = _istDateStr(e.stoppedMs);
            if (dateStr < startDateStr || dateStr > endDateStr) return;

            const startMs = e.stoppedMs - realSecs * 1000;
            const breakSecs = _breakOverlapSecs(startMs, e.stoppedMs, dateStr, breaks);
            const netSecs = Math.max(0, realSecs - breakSecs);
            secsByDate[dateStr] = (secsByDate[dateStr] || 0) + netSecs;
        });
    });

    let lateStayHrs = 0;
    for (const dateStr of Object.keys(secsByDate)) {
        const dayCfg = _dayCfgFor(dateStr, schedule);
        if (dayCfg.isOff) continue;
        const workedHrs = secsByDate[dateStr] / 3600;
        if (workedHrs > lateStayThresholdHrs) lateStayHrs += (workedHrs - lateStayThresholdHrs);
    }
    return +lateStayHrs.toFixed(4);
}

async function calculateLateStayBoost(employeeId, employeeName, startDateStr, endDateStr, baseScorePct) {
    const sopSnap = await db.collection("cowork_sop_settings").doc("task_events").get();
    const rate = sopSnap.exists ? (parseFloat(sopSnap.data().timerOvertimePoints) || 0) : 0;
    const lateStayHrs = await calculateLateStayHours(employeeId, startDateStr, endDateStr);
    const boost = +(lateStayHrs * rate * (baseScorePct / 100)).toFixed(4);
    const finalScore = +(baseScorePct + boost).toFixed(4);

    const emp = await Employee.findOne({ biometricId: employeeId });
    if (!emp) return { ok: false, reason: "employee_not_found" };

    const bleach = {
        type: "C4",
        sopName: "Late Stay Boost",
        folderName: "Time Tracking",
        points: boost,
        bleachType: "debit", // reward — decreases totalDeducted, same polarity as Overtime Reward
        description: `Late Stay Boost for ${startDateStr} to ${endDateStr}: ${lateStayHrs}h late-stay × ${rate} × (${baseScorePct}% base ÷ 100) = +${boost} pts. Final score ${finalScore}%.`,
        date: endDateStr,
        cutBy: "system",
        cutByName: "System (Timer Engine)",
        cutByRole: "system",
    };

    emp.sopPoints = emp.sopPoints || [];
    const year = Number(endDateStr.slice(0, 4));
    let yearEntry = emp.sopPoints.find(y => y.year === year);
    if (!yearEntry) {
        emp.sopPoints.push({ year, totalDeducted: 0, bleaches: [] });
        yearEntry = emp.sopPoints[emp.sopPoints.length - 1];
    }
    yearEntry.bleaches.push(bleach);
    yearEntry.totalDeducted = +((yearEntry.totalDeducted || 0) - boost).toFixed(2);
    emp.markModified("sopPoints");
    await emp.save();

    return { ok: true, lateStayHrs, rate, boost, finalScore, bleach };
}

module.exports = { evaluateTimerSop, evaluateTimerSopForAllEmployees, calculateLateStayHours, calculateLateStayBoost };