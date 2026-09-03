const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");

const {
  acceptanceAnchorMs,
  addWorkingSecsIST,
} = require("./officeDeadline.service");

/**
 * **The first task for a person starts when they take it on.**
 *
 * A normal task anchors at `first_online` — the moment the assignee was online
 * at or after it was created — so that sitting on an acceptance buys no extra
 * deadline. That is right while they have work; it is wrong when they had
 * NOTHING open, since there was no work to sit on and the gap was never work
 * time.
 *
 * The rule is one branch in `acceptanceAnchorMs`, driven by a `hasOpenWork` the
 * caller resolves, which is what makes it testable without a database. The
 * queries and writes around it are asserted on source at the bottom.
 */

/* The owner's worked example, IST expressed as epoch ms. */
const CREATED = Date.parse("2026-09-02T07:30:00.000Z"); // 1:00 PM IST
const ACCEPTED = Date.parse("2026-09-02T08:00:00.000Z"); // 1:30 PM IST
const ONLINE_BEFORE = Date.parse("2026-09-02T04:00:00.000Z"); // 9:30 AM IST
const GRANTED = Date.parse("2026-09-02T06:00:00.000Z"); // 11:30 AM IST

const DAY = { isOff: false, inTime: "09:30", outTime: "18:30" };
const SCHEDULE = {
  monday: DAY,
  tuesday: DAY,
  wednesday: DAY,
  thursday: DAY,
  friday: DAY,
  saturday: DAY,
  sunday: { ...DAY, isOff: true },
};
const istOf = (ms) => new Date(ms + 5.5 * 3600000).toISOString().slice(11, 16);

const free = (over = {}) =>
  acceptanceAnchorMs({
    tlHoursSetMs: null,
    createdMs: CREATED,
    dutyMode: "online",
    dutySessionStartMs: ONLINE_BEFORE,
    nowMs: ACCEPTED,
    hasOpenWork: false,
    ...over,
  });

/* ── The owner's example ───────────────────────────────────────────────────── */

test("created 1:00 PM, accepted 1:30 PM, free → 4h runs to 5:30 PM", () => {
  const { anchorMs, source } = free();
  assert.equal(source, "first_task");
  assert.equal(istOf(anchorMs), "13:30");

  const due = addWorkingSecsIST(anchorMs, 4 * 3600, SCHEDULE, []);
  assert.equal(istOf(Date.parse(due)), "17:30");
});

/* ── Busy people are unaffected — the existing rule stands ─────────────────── */

test("has open work → first_online, exactly as before", () => {
  /* Online since before the task existed, so the clock starts WITH the task —
     the 30 minutes before accepting are not handed back. */
  const { anchorMs, source } = free({ hasOpenWork: true });
  assert.equal(source, "first_online");
  assert.equal(istOf(anchorMs), "13:00");
});

test("an overdue task makes them busy, so nothing changes", () => {
  /* OWNER DECISION: an overdue task is still unfinished work they are meant to
     be doing, so `hasOpenUnsubmittedWork` counts it and it arrives here as
     `true`. The anchor stays exactly where it was. */
  const { anchorMs, source } = free({ hasOpenWork: true });
  assert.equal(source, "first_online");
  assert.equal(istOf(anchorMs), "13:00");
});

/* ── The flag is strictly opt-in ───────────────────────────────────────────── */

test("nobody asked → every existing caller keeps its old answer", () => {
  /* `undefined` is the state of every call site that was not changed. It must
     NOT take the new branch, or the queue rechain would re-derive anchors from
     its own walk clock and deadlines would walk all day. */
  for (const v of [undefined, null, 0, "", "false"]) {
    const { source } = free({ hasOpenWork: v });
    assert.equal(
      source,
      "first_online",
      `hasOpenWork=${JSON.stringify(v)} took the new branch`,
    );
  }
});

/* ── Cross-department is untouched ─────────────────────────────────────────── */

test("a granted task never reaches the rule, even when free", () => {
  /* The cross-department path must not move. The grant branch returns first, so
     `hasOpenWork: false` cannot influence it. */
  const { anchorMs, source } = free({
    tlHoursSetMs: GRANTED,
    dutySessionStartMs: ONLINE_BEFORE,
  });
  assert.equal(source, "hours_granted");
  assert.equal(anchorMs, GRANTED);
});

test("a granted task with a later online session keeps its own rule", () => {
  const laterSession = GRANTED + 45 * 60000;
  const { anchorMs, source } = free({
    tlHoursSetMs: GRANTED,
    dutySessionStartMs: laterSession,
  });
  assert.equal(source, "hours_granted");
  assert.equal(anchorMs, laterSession, "the grant path's own online rule changed");
});

/* ── It only ever moves a deadline LATER ───────────────────────────────────── */

test("the anchor is never earlier than the task existed", () => {
  /* A clock skew putting acceptance before creation must not start the clock
     before the task was raised. */
  const { anchorMs } = free({ nowMs: CREATED - 60 * 60000 });
  assert.equal(anchorMs, CREATED);
});

test("first_task is never earlier than first_online would have been", () => {
  const busy = free({ hasOpenWork: true });
  const first = free();
  assert.ok(
    first.anchorMs >= busy.anchorMs,
    "the new rule produced an EARLIER deadline than the old one",
  );
});

/* ── Accepting on a later day ──────────────────────────────────────────────── */

test("accepted days later → the acceptance moment, not the office opening", () => {
  /* OWNER DECISION, chosen over an opening-time fallback. */
  const thursday = Date.parse("2026-09-03T04:45:00.000Z"); // 10:15 AM IST
  const { anchorMs, source } = free({ nowMs: thursday });
  assert.equal(source, "first_task");
  assert.equal(istOf(anchorMs), "10:15");

  /* Working hours still apply to the arithmetic. */
  const due = addWorkingSecsIST(anchorMs, 4 * 3600, SCHEDULE, []);
  assert.equal(istOf(Date.parse(due)), "14:15");
});

test("a window that overruns the office day carries to the next", () => {
  const late = Date.parse("2026-09-02T12:30:00.000Z"); // 6:00 PM IST
  const { anchorMs } = free({ nowMs: late });
  const due = addWorkingSecsIST(anchorMs, 2 * 3600, SCHEDULE, []);
  const iso = new Date(Date.parse(due) + 5.5 * 3600000).toISOString();
  assert.equal(iso.slice(11, 16), "11:00", "did not resume at the next opening");
});

/* ── Robustness ────────────────────────────────────────────────────────────── */

test("a missing creation time still yields the acceptance moment", () => {
  const { anchorMs, source } = free({ createdMs: null });
  assert.equal(source, "first_task");
  assert.equal(anchorMs, ACCEPTED);
});

test("an unusable acceptance instant falls through rather than throwing", () => {
  for (const bad of [NaN, undefined, null]) {
    const { source } = free({ nowMs: bad });
    assert.notEqual(source, "first_task", `nowMs=${bad} produced an anchor`);
  }
});

test("offline and free still anchors at the moment they took it on", () => {
  /* Nothing provable about presence; the press is the honest floor, and it is
     the same instant the rule wants anyway. */
  const { anchorMs, source } = free({
    dutyMode: "offline",
    dutySessionStartMs: null,
  });
  assert.equal(source, "first_task");
  assert.equal(istOf(anchorMs), "13:30");
});

/* ── The rule is actually wired to the two acceptance surfaces ─────────────── */

const OFFICE = readFileSync("services/officeDeadline.service.js", "utf8");
const CONFIRM = readFileSync("services/taskForward.service.js", "utf8");
const ROUTES = readFileSync("routes/task_routes/taskForward.js", "utf8");

test("the free check counts overdue work and ignores submitted work", () => {
  const at = OFFICE.indexOf("async function hasOpenUnsubmittedWork");
  assert.ok(at > 0, "the free check does not exist");
  const fn = OFFICE.slice(at, at + 1600);
  assert.match(fn, /TERMINAL_STATUSES\.includes/, "finished work is not excluded");
  assert.match(fn, /isAwaitingReview\(t\)/, "submitted work is not excluded");
  assert.match(
    fn,
    /catch \(e\)[\s\S]*?return true;/,
    "a failed read must fail closed (treated as busy)",
  );
});

test("only the acceptance surfaces opt in", () => {
  /* If the queue rechain ever opts in, anchors creep to the walk clock. */
  assert.match(
    OFFICE,
    /opts\.considerFirstTask === true && !Number\.isFinite\(tlHoursSetMs\)/,
  );
  const rechain = OFFICE.slice(OFFICE.indexOf("async function rechainQueueFor"));
  assert.doesNotMatch(rechain, /considerFirstTask/, "the queue rechain opted in");
});

test("confirming an assignment re-anchors, and refuses granted or fixed-date tasks", () => {
  const at = CONFIRM.indexOf("Their FIRST task");
  assert.ok(at > 0, "the confirm path was not wired");
  const block = CONFIRM.slice(at, at + 3000);
  assert.match(block, /considerFirstTask: true/);
  assert.match(
    block,
    /clockStartsAtSource === "hours_granted"/,
    "cross-department is not excluded",
  );
  assert.match(block, /task\.fixedDeadline/, "a typed deadline is not protected");
  assert.match(block, /resolved\.anchorMs > stored/, "the write is not one-directional");
});

test("approving a self-assigned task re-anchors at the approval", () => {
  const at = ROUTES.indexOf("A self-assigned first task starts when it is APPROVED");
  assert.ok(at > 0, "the self-assign approval path was not wired");
  const block = ROUTES.slice(at, at + 3000);
  assert.match(block, /considerFirstTask: true/);
  assert.match(block, /clockStartsAtSource: "self_approved"/);
  assert.match(block, /task\.fixedDeadline/, "a typed deadline is not protected");
  assert.match(block, /resolved\.anchorMs > stored/, "the write is not one-directional");
});
