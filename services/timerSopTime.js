/**
 * Date/label helpers for the Timer-SOP engine.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `timerSop.service.js` opens a Firestore handle at require time
 * (`admin.firestore()`), so nothing in it can be exercised without Firebase
 * credentials in the room. These four functions are pure arithmetic over
 * timestamps and YYYY-MM-DD labels, so they live here and can be tested on
 * their own — see `timerSopTime.test.js`.
 *
 * ── WHY THE SERVER WAS DOWN ─────────────────────────────────────────────────
 * The refactor that introduced this module (29a227b, "Refactor date handling
 * in timerSop service") changed `timerSop.service.js` to require it but never
 * committed the file itself — the commit touched exactly one path. Every boot
 * therefore died at require time with MODULE_NOT_FOUND, which takes the whole
 * backend with it because `server.js` mounts `timerSop.routes.js` at the top
 * level. Recovered 12 Sep 2026 from the pre-refactor implementations in
 * 29a227b^ so the behaviour is what it was, not a fresh guess.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Milliseconds for whatever shape a stored instant arrives in, or `null`.
 *
 * ── WHY THIS IS NOT `new Date(x).getTime()` ─────────────────────────────────
 * The same field is written and read through three different stacks, so one
 * setting can come back as any of four shapes:
 *
 *   · a Firestore `Timestamp`  — what a read of a `Date` gives back
 *   · a JS `Date`              — what the toggle writes
 *   · an ISO string            — what older rows hold
 *   · a number                 — epoch ms, from anything hand-written
 *
 * `new Date(timestamp)` on a Firestore Timestamp is `Invalid Date`, and the
 * IST label built from it threw RangeError for every employee on every run.
 * That is why the SOP engine had never moved a single point.
 *
 * Returns `null` — never `NaN`, never 0 — when the value cannot be resolved,
 * so "no instant recorded" stays distinguishable from "the epoch". Callers
 * test `!== null`; a 0 would read as a real instant in 1970 and a NaN would
 * quietly poison every comparison downstream.
 *
 * @param {*} value
 * @returns {number|null} epoch milliseconds
 */
function instantMs(value) {
    if (value === null || value === undefined) return null;

    /* Firestore Timestamp. `toMillis` is the documented accessor; `toDate` is
       checked too because the emulator and older admin SDKs expose one and not
       always the other. */
    if (typeof value === "object") {
        if (typeof value.toMillis === "function") {
            const ms = value.toMillis();
            return Number.isFinite(ms) ? ms : null;
        }
        if (typeof value.toDate === "function") {
            const ms = value.toDate()?.getTime();
            return Number.isFinite(ms) ? ms : null;
        }
        /* A Timestamp that has been through JSON — the class is gone but the
           fields survive, under either spelling depending on who serialised it. */
        const secs = typeof value.seconds === "number" ? value.seconds
            : typeof value._seconds === "number" ? value._seconds
                : null;
        if (secs !== null) {
            const nanos = typeof value.nanoseconds === "number" ? value.nanoseconds
                : typeof value._nanoseconds === "number" ? value._nanoseconds
                    : 0;
            return secs * 1000 + Math.floor(nanos / 1e6);
        }
        if (value instanceof Date) {
            const ms = value.getTime();
            return Number.isNaN(ms) ? null : ms;
        }
        return null;
    }

    if (typeof value === "number") return Number.isFinite(value) ? value : null;

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return null;
        const ms = Date.parse(trimmed);
        return Number.isNaN(ms) ? null : ms;
    }

    return null;
}

/**
 * IST calendar-date label (YYYY-MM-DD) for a UTC millisecond timestamp.
 *
 * Shifting by the offset and then reading the UTC date is deliberate: it keeps
 * the answer independent of the server's own timezone, which is not IST on
 * every host this runs on.
 *
 * @param {number} utcMs
 * @returns {string} YYYY-MM-DD
 */
function istDateStr(utcMs) {
    return new Date(utcMs + IST_OFFSET_MS).toISOString().split("T")[0];
}

/**
 * Add N whole calendar days (N may be negative) to a YYYY-MM-DD label.
 *
 * Anchored at UTC midnight of the label, so this is pure label arithmetic and
 * never mixes with the "real IST instant" maths in `istDateStr` — it cannot
 * inherit an offset bug from it, and it cannot drift across a DST boundary in
 * whatever zone the host happens to be in.
 *
 * @param {string} dateStr YYYY-MM-DD
 * @param {number} n
 * @returns {string} YYYY-MM-DD
 */
function addDaysToLabel(dateStr, n) {
    const anchor = Date.parse(dateStr + "T00:00:00.000Z");
    return new Date(anchor + n * MS_PER_DAY).toISOString().split("T")[0];
}

/**
 * Day of week for a YYYY-MM-DD label, 0 = Sunday.
 *
 * Indexes DAY_KEYS in the service, which is why it is Sunday-based.
 *
 * @param {string} dateStr YYYY-MM-DD
 * @returns {number} 0-6
 */
function dowForLabel(dateStr) {
    const anchor = Date.parse(dateStr + "T00:00:00.000Z");
    return new Date(anchor).getUTCDay();
}

module.exports = { instantMs, istDateStr, addDaysToLabel, dowForLabel, IST_OFFSET_MS, MS_PER_DAY };
