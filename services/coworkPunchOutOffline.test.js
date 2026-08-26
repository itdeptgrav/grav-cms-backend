const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  shouldMarkOffline,
  offlinePatch,
  storedMode,
  istDateStr,
  istDayStartMs,
  onlineRowAtMs,
} = require("./coworkPunchOutOffline.service");

/**
 * Closing out a CoWork session the person left running when they went home.
 *
 * The rule is evidence, not elapsed time: a punch-out on the biometric device
 * is the person telling a different machine that they are leaving, at a
 * recorded instant. Everything here is about what counts as that evidence, and
 * — more importantly — what outranks it.
 *
 * CoWork removed an auto-offline once already, for good reasons recorded in
 * `lib/rules/presence/duty.ts`: a heartbeat-based one marked people away who
 * were sitting at their desks. These tests exist so this one cannot drift into
 * being that.
 */

/* An evening in IST, expressed as epoch ms. */
const PUNCH_OUT = Date.parse("2026-08-26T13:00:00.000Z"); // 18:30 IST
const NINE_PM = Date.parse("2026-08-26T15:30:00.000Z"); // 21:00 IST

const online = (over = {}) => ({ mode: "online", updatedAt: PUNCH_OUT - 3_600_000, ...over });

/* ── The ordinary case ─────────────────────────────────────────────────────── */

test("an online session with a punch-out behind it is closed", () => {
  const v = shouldMarkOffline({
    duty: online(),
    punchOutMs: PUNCH_OUT,
    nowMs: NINE_PM,
  });
  assert.deepEqual(v, { act: true, reason: "punched-out" });
});

test("the old app's isOnline spelling is read as online", () => {
  /* A document written by the old application carries no `mode`. Reading it as
     offline would silently exempt everybody still on that app. */
  const v = shouldMarkOffline({
    duty: { isOnline: true, updatedAt: PUNCH_OUT - 1000 },
    punchOutMs: PUNCH_OUT,
    nowMs: NINE_PM,
  });
  assert.equal(v.act, true);
});

/* ── What outranks the device ──────────────────────────────────────────────── */

test("a decision made after the punch-out wins", () => {
  /* They punched out at 18:30 and came back to the desk at 19:00. The device is
     describing a session that has already ended and been replaced. */
  const v = shouldMarkOffline({
    duty: online({ updatedAt: PUNCH_OUT + 1_800_000 }),
    punchOutMs: PUNCH_OUT,
    nowMs: NINE_PM,
  });
  assert.deepEqual(v, { act: false, reason: "newer-decision" });
});

test("a break is left alone", () => {
  const v = shouldMarkOffline({
    duty: { mode: "break", updatedAt: PUNCH_OUT - 1000 },
    punchOutMs: PUNCH_OUT,
    nowMs: NINE_PM,
  });
  assert.deepEqual(v, { act: false, reason: "mode-break" });
});

test("an emergency is left alone", () => {
  const v = shouldMarkOffline({
    duty: { mode: "emergency", updatedAt: PUNCH_OUT - 1000 },
    punchOutMs: PUNCH_OUT,
    nowMs: NINE_PM,
  });
  assert.deepEqual(v, { act: false, reason: "mode-emergency" });
});

test("somebody already offline is not written over", () => {
  /* Re-running the job must find nothing to do — a restart at 21:00 otherwise
     appends a second history row for one departure. */
  const v = shouldMarkOffline({
    duty: { mode: "offline", updatedAt: PUNCH_OUT },
    punchOutMs: PUNCH_OUT,
    nowMs: NINE_PM,
  });
  assert.deepEqual(v, { act: false, reason: "mode-offline" });
});

/* ── What does not count as evidence ───────────────────────────────────────── */

test("no punch-out is no evidence", () => {
  for (const bad of [null, undefined, NaN, 0, -1]) {
    const v = shouldMarkOffline({ duty: online(), punchOutMs: bad, nowMs: NINE_PM });
    assert.deepEqual(v, { act: false, reason: "no-punch-out" }, String(bad));
  }
});

test("a punch stamped in the future is a device clock, not a departure", () => {
  const v = shouldMarkOffline({
    duty: online(),
    punchOutMs: NINE_PM + 3_600_000,
    nowMs: NINE_PM,
  });
  assert.deepEqual(v, { act: false, reason: "punch-in-future" });
});

test("yesterday's punch cannot close today's session", () => {
  const v = shouldMarkOffline({
    duty: online({ updatedAt: NINE_PM - 7_200_000 }),
    punchOutMs: PUNCH_OUT - 24 * 3_600_000,
    nowMs: NINE_PM,
  });
  assert.deepEqual(v, { act: false, reason: "punch-not-today" });
});

test("a missing duty document is nothing to close", () => {
  const v = shouldMarkOffline({ duty: null, punchOutMs: PUNCH_OUT, nowMs: NINE_PM });
  assert.deepEqual(v, { act: false, reason: "no-duty-document" });
});

/* ── The patch that gets written ───────────────────────────────────────────── */

test("the patch carries both spellings of the mode", () => {
  /* The old application reads `isOnline` when `mode` is absent; a document
     written with one and not the other reads differently in each app. */
  const p = offlinePatch("GR0045", PUNCH_OUT);
  assert.equal(p.mode, "offline");
  assert.equal(p.isOnline, false);
});

test("the claim is released", () => {
  /* A left-behind heartbeat and connection id would let a closed session still
     look like the owner of the presence claim. */
  const p = offlinePatch("GR0045", PUNCH_OUT);
  assert.equal(p.heartbeatAt, null);
  assert.equal(p.presenceConnectionId, null);
});

test("the session is dated when they left, not when the job ran", () => {
  /* `updatedAt` is what the roster shows as "offline since". The honest answer
     is the punch-out, not 21:00. */
  const p = offlinePatch("GR0045", PUNCH_OUT);
  assert.equal(p.updatedAt, PUNCH_OUT);
});

test("no deadline credit is created", () => {
  /**
   * The one that matters most. Returning from an offline span shifts every
   * active task deadline by the office-hours part of it. A person deciding to
   * go offline earns that; a nightly job noticing they forgot must not. With
   * `offlineStartedAtMs` null the span measures zero on their next sign-in, so
   * deadlines land exactly where they do today.
   */
  const p = offlinePatch("GR0045", PUNCH_OUT);
  assert.equal(p.offlineStartedAtMs, null);
});

test("the write is marked as a system action", () => {
  const p = offlinePatch("GR0045", PUNCH_OUT);
  assert.equal(p.offlineSource, "etime-punch-out");
  assert.equal(p.offlineSourceAtMs, PUNCH_OUT);
});

/* ── The day boundary ──────────────────────────────────────────────────────── */

test("the IST day is read in IST, not UTC", () => {
  /* 21:00 IST is the previous day in UTC. Reading the day in UTC would make
     every evening run look for the wrong date's punches. */
  assert.equal(istDateStr(NINE_PM), "2026-08-26");
  assert.equal(istDateStr(Date.parse("2026-08-26T18:45:00.000Z")), "2026-08-27");
});

/* ── The opening row ───────────────────────────────────────────────────────── */

const DAY_START = istDayStartMs(NINE_PM); // midnight IST, 26 Aug

const PUNCH_IN = DAY_START + 9.5 * 3_600_000; // 09:30 IST
const open = (over = {}) =>
  onlineRowAtMs({
    sessionStartMs: null,
    punchInMs: null,
    dayStartMs: DAY_START,
    punchOutMs: PUNCH_OUT,
    ...over,
  });

test("CoWork's own session start wins when it is today's", () => {
  /* The duty document is CoWork's record of when this person arrived. An
     inference does not beat a record. */
  const began = DAY_START + 10 * 3_600_000;
  assert.equal(open({ sessionStartMs: began, punchInMs: PUNCH_IN }), began);
});

test("a session carried in from an earlier day opens at the punch-IN", () => {
  /**
   * The case this exists for, and the one that has now been wrong twice.
   *
   * Somebody who left CoWork online overnight has a session start dated
   * yesterday. Writing THAT stamps a row outside the day window the panel
   * queries, so it is never returned and the pairing fails — the day reads
   * "Not on duty today · 0m", which is how eight people lost 26 Aug.
   *
   * The first fix used midnight, and produced "12:00 AM → 7:29 PM · 19h 29m".
   * The day was no longer erased, it was inflated. The device knows when they
   * actually arrived; the same record that closes the day opens it.
   */
  assert.equal(
    open({ sessionStartMs: DAY_START - 5 * 3_600_000, punchInMs: PUNCH_IN }),
    PUNCH_IN,
  );
});

test("no session start at all falls back to the punch-IN", () => {
  assert.equal(open({ sessionStartMs: null, punchInMs: PUNCH_IN }), PUNCH_IN);
  assert.equal(open({ sessionStartMs: NaN, punchInMs: PUNCH_IN }), PUNCH_IN);
});

test("yesterday's punch-IN is refused, not used", () => {
  /* Outside the window, exactly like the session start it was meant to
     replace. Midnight is the only thing left. */
  assert.equal(
    open({ sessionStartMs: null, punchInMs: DAY_START - 3_600_000 }),
    DAY_START,
  );
});

test("midnight only when neither a session start nor a punch-IN exists", () => {
  /* Overstating a day is bad; erasing one is worse. This is the floor. */
  for (const bad of [null, undefined, NaN]) {
    assert.equal(open({ sessionStartMs: bad, punchInMs: bad }), DAY_START, String(bad));
  }
});

test("no opening row when it would not precede the punch-out", () => {
  /* A stretch of zero or negative length is discarded by the panel anyway;
     writing it would add a row that renders as nothing. */
  assert.equal(open({ sessionStartMs: PUNCH_OUT }), null);
  assert.equal(open({ sessionStartMs: PUNCH_OUT + 60_000 }), null);
  assert.equal(open({ punchInMs: PUNCH_OUT }), null);
  assert.equal(open({ punchInMs: PUNCH_OUT + 60_000 }), null);
});

test("no opening row without a punch-out to close against", () => {
  assert.equal(open({ punchOutMs: NaN }), null);
});

test("the opening row always precedes the closing row", () => {
  /* The invariant the panel depends on: pair an open with a later close. */
  const starts = [DAY_START - 86_400_000, DAY_START, DAY_START + 3_600_000, null, NaN];
  for (const sessionStartMs of starts) {
    for (const punchInMs of starts) {
      const at = open({ sessionStartMs, punchInMs });
      if (at !== null) assert.ok(at < PUNCH_OUT, `opened ${at} vs punch ${PUNCH_OUT}`);
    }
  }
});

test("the opening row is never before the day it belongs to", () => {
  /* A row outside the window is a row the panel never reads — the whole
     failure this rule exists to avoid. */
  const starts = [DAY_START - 86_400_000, DAY_START - 1, null, NaN];
  for (const sessionStartMs of starts) {
    for (const punchInMs of starts) {
      const at = open({ sessionStartMs, punchInMs });
      if (at !== null) assert.ok(at >= DAY_START, `opened ${at} before ${DAY_START}`);
    }
  }
});

test("midnight IST is midnight IST, not midnight UTC", () => {
  assert.equal(istDateStr(DAY_START), "2026-08-26");
  assert.equal(istDateStr(DAY_START - 1), "2026-08-25");
  assert.equal(DAY_START, Date.parse("2026-08-25T18:30:00.000Z"));
});

test("stored mode falls back to offline for anything unrecognised", () => {
  assert.equal(storedMode(null), "offline");
  assert.equal(storedMode({}), "offline");
  assert.equal(storedMode({ mode: "nonsense" }), "offline");
  assert.equal(storedMode({ isOnline: false }), "offline");
});
