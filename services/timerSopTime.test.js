const test = require("node:test");
const assert = require("node:assert");

const { instantMs, istDateStr, addDaysToLabel, dowForLabel } = require("./timerSopTime");

/* A stand-in for the Firestore Timestamp class — the shape a read gives back,
   which is the one `new Date(x)` cannot handle. */
class FakeTimestamp {
    constructor(ms) { this._ms = ms; }
    toMillis() { return this._ms; }
    toDate() { return new Date(this._ms); }
}

test("instantMs reads every shape the field arrives in", () => {
    const ms = Date.UTC(2026, 8, 11, 6, 30, 0); // 2026-09-11T06:30:00Z

    assert.strictEqual(instantMs(new FakeTimestamp(ms)), ms, "Firestore Timestamp");
    assert.strictEqual(instantMs({ seconds: ms / 1000, nanoseconds: 0 }), ms, "serialised Timestamp");
    assert.strictEqual(instantMs({ _seconds: ms / 1000, _nanoseconds: 0 }), ms, "underscore spelling");
    assert.strictEqual(instantMs(new Date(ms)), ms, "Date");
    assert.strictEqual(instantMs(ms), ms, "epoch ms");
    assert.strictEqual(instantMs(new Date(ms).toISOString()), ms, "ISO string");
});

test("instantMs returns null — never NaN, never 0 — when there is no instant", () => {
    /* 0 would read as a real instant in 1970 and NaN would poison every
       comparison downstream, so the absent case has to be its own value. */
    for (const absent of [null, undefined, "", "   ", "not a date", {}, [], NaN, true]) {
        assert.strictEqual(instantMs(absent), null, JSON.stringify(absent));
    }
});

test("istDateStr labels by IST, not by the host's zone", () => {
    /* 18:45 UTC is already the next calendar day in IST (+5:30). */
    assert.strictEqual(istDateStr(Date.UTC(2026, 8, 11, 18, 45, 0)), "2026-09-12");
    /* 18:15 UTC is still the same day. */
    assert.strictEqual(istDateStr(Date.UTC(2026, 8, 11, 18, 15, 0)), "2026-09-11");
    /* Midnight IST is 18:30 UTC the day before — the boundary itself. */
    assert.strictEqual(istDateStr(Date.UTC(2026, 8, 11, 18, 30, 0)), "2026-09-12");
});

test("addDaysToLabel walks month, year and leap-day boundaries", () => {
    assert.strictEqual(addDaysToLabel("2026-09-11", 1), "2026-09-12");
    assert.strictEqual(addDaysToLabel("2026-09-11", -1), "2026-09-10");
    assert.strictEqual(addDaysToLabel("2026-09-30", 1), "2026-10-01");
    assert.strictEqual(addDaysToLabel("2026-12-31", 1), "2027-01-01");
    assert.strictEqual(addDaysToLabel("2027-01-01", -1), "2026-12-31");
    assert.strictEqual(addDaysToLabel("2028-02-28", 1), "2028-02-29", "2028 is a leap year");
    assert.strictEqual(addDaysToLabel("2026-02-28", 1), "2026-03-01", "2026 is not");
    assert.strictEqual(addDaysToLabel("2026-09-11", 0), "2026-09-11");
});

test("dowForLabel is Sunday-based, matching DAY_KEYS", () => {
    assert.strictEqual(dowForLabel("2026-09-13"), 0, "Sunday");
    assert.strictEqual(dowForLabel("2026-09-14"), 1, "Monday");
    assert.strictEqual(dowForLabel("2026-09-11"), 5, "Friday");
    assert.strictEqual(dowForLabel("2026-09-12"), 6, "Saturday");
});

test("a label survives a round trip through the two helpers", () => {
    /* The watermark loop does exactly this: label -> +1 day -> compare. It must
       not drift, which is why addDaysToLabel is label arithmetic and not a
       re-derivation from an instant. */
    let cursor = "2026-01-01";
    for (let i = 0; i < 400; i++) cursor = addDaysToLabel(cursor, 1);
    assert.strictEqual(cursor, "2027-02-05");
    assert.strictEqual(addDaysToLabel(cursor, -400), "2026-01-01");
});
