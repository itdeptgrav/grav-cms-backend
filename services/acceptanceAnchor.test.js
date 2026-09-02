const assert = require("node:assert/strict");
const { test } = require("node:test");

const { acceptanceAnchorMs, addWorkingSecsIST } = require("./officeDeadline.service");

/**
 * Where the clock starts when a budget is accepted.
 *
 * The owner's rule (DEADLINE_START_RULE.md in the Cowork repo): whoever causes
 * the delay bears it. A cross-department grant starts the clock; on a normal
 * task it is the first provable moment the assignee was online at or after the
 * task was given — never the acceptance press, which rewarded sitting on a
 * task with a later deadline.
 */

/* T019's real instants, IST expressed as epoch ms. */
const CREATED = Date.parse("2026-08-14T05:11:54.724Z"); // 10:41:54 IST
const ONLINE = Date.parse("2026-08-14T05:26:20.000Z"); // 10:56:20 IST
const ACCEPTED = Date.parse("2026-08-14T06:31:42.000Z"); // 12:01:42 IST
const GRANTED = Date.parse("2026-08-13T09:00:35.000Z"); // T012's 14:30:35 IST

const DAY = { isOff: false, inTime: "09:30", outTime: "18:30" };
const SCHEDULE = {
  monday: DAY, tuesday: DAY, wednesday: DAY, thursday: DAY,
  friday: DAY, saturday: DAY, sunday: { ...DAY, isOff: true },
};
const istOf = (iso) =>
  new Date(Date.parse(iso) + 5.5 * 3600000).toISOString().slice(0, 19);

/* A grant at a clean instant, with sessions either side of it. */
const GRANT = Date.parse("2026-08-14T07:30:00.000Z"); //         13:00 IST
const BEFORE_GRANT = Date.parse("2026-08-14T07:00:00.000Z"); //  12:30 IST — online first
const AFTER_GRANT = Date.parse("2026-08-14T08:30:00.000Z"); //   14:00 IST — online later
const CONFIRMED = Date.parse("2026-08-14T09:00:00.000Z"); //     14:30 IST

test("granted, and online since before the grant — the clock starts at the grant", () => {
  /* The assignee was already at their desk when the hours landed, so nothing
     waited on them: the grant is the earliest they could have begun. */
  const a = acceptanceAnchorMs({
    tlHoursSetMs: GRANT,
    createdMs: CREATED,
    dutyMode: "online",
    dutySessionStartMs: BEFORE_GRANT,
    nowMs: CONFIRMED,
  });
  assert.deepEqual(a, { anchorMs: GRANT, source: "hours_granted" });
});

test("granted while OFFLINE, comes online later — the clock waits for them", () => {
  /* The reported rule. Hours granted 13:00 while the assignee was offline; they
     come online 14:00. A 3-hour budget is a promise of 3 WORKING hours, and the
     hour they could not be present for was not theirs to work — so the clock
     starts 14:00 (→ due 17:00), not 13:00 (→ 16:00). Mirrors first_online. */
  const a = acceptanceAnchorMs({
    tlHoursSetMs: GRANT,
    createdMs: CREATED,
    dutyMode: "online",
    dutySessionStartMs: AFTER_GRANT,
    nowMs: CONFIRMED,
  });
  assert.deepEqual(a, { anchorMs: AFTER_GRANT, source: "hours_granted" });
});

test("granted while offline and STILL offline at confirm — the grant stands", () => {
  /* Only PROVABLE online time moves it. Not online now → the grant is the
     honest floor, exactly as before this rule existed. */
  const a = acceptanceAnchorMs({
    tlHoursSetMs: GRANT,
    createdMs: CREATED,
    dutyMode: "offline",
    dutySessionStartMs: AFTER_GRANT,
    nowMs: CONFIRMED,
  });
  assert.deepEqual(a, { anchorMs: GRANT, source: "hours_granted" });
});

test("granted, online later, but sitting after coming online buys nothing", () => {
  /* The session start is the anchor, never the confirm press: online 14:00,
     confirms 14:30 → still 14:00. The same guard first_online makes. */
  const a = acceptanceAnchorMs({
    tlHoursSetMs: GRANT,
    createdMs: CREATED,
    dutyMode: "online",
    dutySessionStartMs: AFTER_GRANT,
    nowMs: CONFIRMED, // 14:30, half an hour after coming online
  });
  assert.equal(a.anchorMs, AFTER_GRANT); // 14:00, not 14:30
});

test("T019: online since 10:56, accepted 12:01 — the clock starts 10:56", () => {
  /* The reported case, end to end. Sitting on the task for 1h05m while online
     no longer buys a later deadline: 10:56:20 + 2h = 12:56:20, not 14:01:42. */
  const a = acceptanceAnchorMs({
    tlHoursSetMs: null,
    createdMs: CREATED,
    dutyMode: "online",
    dutySessionStartMs: ONLINE,
    nowMs: ACCEPTED,
  });
  assert.equal(a.source, "first_online");
  assert.equal(a.anchorMs, ONLINE);
  const due = addWorkingSecsIST(a.anchorMs, 2 * 3600, SCHEDULE, []);
  assert.equal(istOf(due), "2026-08-14T12:56:20");
});

test("online since before the task existed — the clock starts with the task", () => {
  const a = acceptanceAnchorMs({
    tlHoursSetMs: null,
    createdMs: CREATED,
    dutyMode: "online",
    dutySessionStartMs: CREATED - 3600_000,
    nowMs: ACCEPTED,
  });
  assert.deepEqual(a, { anchorMs: CREATED, source: "first_online" });
});

test("not online: the press is the first provable presence", () => {
  for (const dutyMode of ["offline", "break", "emergency", null]) {
    const a = acceptanceAnchorMs({
      tlHoursSetMs: null,
      createdMs: CREATED,
      dutyMode,
      dutySessionStartMs: ONLINE,
      nowMs: ACCEPTED,
    });
    assert.deepEqual(a, { anchorMs: ACCEPTED, source: "acceptance" }, String(dutyMode));
  }
});

test("a session that began after the moment asked about proves nothing", () => {
  /* T017 replayed: accepted 10:01:29, but the assignee's current session only
     began 10:56:20. Passing the PAST acceptance as `nowMs` makes the guard
     `sessionStart <= nowMs` double as "the session spanned that acceptance" —
     which is what lets the backfill reuse this exact function. */
  const a = acceptanceAnchorMs({
    tlHoursSetMs: null,
    createdMs: Date.parse("2026-08-14T04:25:16.000Z"), // 09:55:16 IST
    dutyMode: "online",
    dutySessionStartMs: ONLINE, // 10:56:20 — after the acceptance below
    nowMs: Date.parse("2026-08-14T04:31:29.000Z"), // 10:01:29 IST
  });
  assert.equal(a.source, "acceptance");
  assert.equal(istOf(addWorkingSecsIST(a.anchorMs, 3600, SCHEDULE, [])), "2026-08-14T11:01:29");
});

test("malformed inputs never produce a broken anchor", () => {
  for (const bad of [NaN, 0, -5, undefined]) {
    const a = acceptanceAnchorMs({
      tlHoursSetMs: null,
      createdMs: CREATED,
      dutyMode: "online",
      dutySessionStartMs: bad,
      nowMs: ACCEPTED,
    });
    assert.equal(a.anchorMs, ACCEPTED, `sessionStart=${bad}`);
  }
  /* A missing creation time cannot anchor a first-online claim. */
  const a = acceptanceAnchorMs({
    tlHoursSetMs: null,
    createdMs: null,
    dutyMode: "online",
    dutySessionStartMs: ONLINE,
    nowMs: ACCEPTED,
  });
  assert.equal(a.source, "acceptance");
});

test("the anchor may put the deadline in the past — never clamped", () => {
  /* Owner decision: online at 10:56, budget 30m, accepted 13:00 → due 11:26,
     already gone, task Overdue on arrival. The rule working, not failing. */
  const late = Date.parse("2026-08-14T07:30:00.000Z"); // 13:00 IST
  const a = acceptanceAnchorMs({
    tlHoursSetMs: null,
    createdMs: CREATED,
    dutyMode: "online",
    dutySessionStartMs: ONLINE,
    nowMs: late,
  });
  const due = addWorkingSecsIST(a.anchorMs, 30 * 60, SCHEDULE, []);
  assert.equal(istOf(due), "2026-08-14T11:26:20");
  assert.ok(Date.parse(due) < late, "the past result was clamped forward");
});

test("the new rule never lands LATER than the old acceptance anchor", () => {
  /* Every branch answers <= nowMs (a grant precedes acceptance by definition),
     so this strictly removes phantom slack and can never add any. */
  for (const s of [CREATED - 9e6, CREATED, ONLINE, ACCEPTED]) {
    const a = acceptanceAnchorMs({
      tlHoursSetMs: null,
      createdMs: CREATED,
      dutyMode: "online",
      dutySessionStartMs: s,
      nowMs: ACCEPTED,
    });
    assert.ok(a.anchorMs <= ACCEPTED);
  }
});

/* ── Drift guards: an accepted budget can never again lack its deadline ────── */

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const src = (p) => readFileSync(join(__dirname, p), "utf8");

test("every accept surface writes the deadline WITH the budget", () => {
  /**
   * **T017 is why this exists.** `acceptBudgetProposal` once stored only
   * `senderTimerWindowSecs` — the budget without a date — so a 1h task was
   * worked 1h10m and approved clean, because there was no deadline to be late
   * against. Five tasks were found in that state. An accepted budget with no
   * deadline is not a smaller write; it is an unmeasurable task.
   */
  const svc = src("budgetNegotiation.service.js");
  const accept = svc.slice(svc.indexOf("async function acceptBudgetProposal"));
  for (const field of [
    "dueDate,",
    "deadlineWindowSecs: secs",
    "originalWindowSecs:",
    "etcHours: secs / 3600",
    "clockStartsAtMs: anchorMs",
    "clockStartsAtSource: anchorSource",
  ]) {
    assert.ok(accept.includes(field), `accept no longer writes ${field}`);
  }

  for (const route of [
    "../routes/task_routes/taskTree.routes.js",
    "../routes/task_routes/taskForward.js",
  ]) {
    const r = src(route);
    /* The ROUTE, not the first mention — taskForward.js also names this flow
       in a comment 700 lines earlier, and slicing from there missed the
       handler entirely. */
    const at = r.indexOf('"/task/:taskId/approve-sender-timer"');
    assert.ok(at > 0, route + " route anchor drifted");
    const block = r.slice(at, at + 3500);
    assert.ok(block.includes("resolveAcceptanceAnchor"), route + " lost the anchor rule");
    assert.ok(block.includes("clockStartsAtMs"), route + " no longer stamps the anchor");
    assert.equal(
      /dueDate = _addWorkingSecsIST\(Date\.now\(\)/.test(block),
      false,
      route + " anchors at the press again — that rewards sitting on a task",
    );
  }
});

/* ── The trigger: a granted task re-anchors when the assignee confirms ─────── */

/* Reuses the `src` helper declared above — it resolves against __dirname. */
const CONFIRM_SRC = src("taskForward.service.js");

test("confirmTaskReceipt re-resolves the anchor for a granted task", () => {
  /* The rule above is pure, but a granted task's deadline is stamped at the
     GRANT while the assignee may be offline — so something has to re-run it once
     they are online. Confirming is that moment. This guards the wiring: the
     pure rule cannot fire on its own. */
  const at = CONFIRM_SRC.indexOf("async function confirmTaskReceipt");
  const fn = CONFIRM_SRC.slice(at, at + 3600);
  assert.match(fn, /resolveAcceptanceAnchor\(task, Date\.now\(\), taskId\)/);
});

test("it fires only for a granted task, and only ever moves the deadline later", () => {
  const at = CONFIRM_SRC.indexOf("async function confirmTaskReceipt");
  const fn = CONFIRM_SRC.slice(at, at + 3600);
  /* Guarded on the stored grant anchor, so a normal task is untouched. */
  assert.match(fn, /clockStartsAtSource === "hours_granted"/);
  /* Written only when the resolved anchor is LATER than what is stored. */
  assert.match(fn, /resolved\.anchorMs > stored/);
  /* And it can never cost the confirmation itself. */
  assert.match(fn, /catch \(e\)/);
});

test("the re-anchor recomputes the working deadline from the new anchor", () => {
  const at = CONFIRM_SRC.indexOf("async function confirmTaskReceipt");
  const fn = CONFIRM_SRC.slice(at, at + 3600);
  assert.match(fn, /computeWorkingDeadline\(\{\s*startMs: resolved\.anchorMs/);
  assert.match(fn, /dueDate,/);
});
