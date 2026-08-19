const test = require("node:test");
const assert = require("node:assert/strict");
const { addWorkingSecsIST } = require("./officeDeadline.service");

/**
 * The rework window, against the engine's own office-hours walk.
 *
 * `reworkTask` cannot be imported here — it reaches Firestore at require time —
 * so this pins the ARITHMETIC and the on-time gate it applies, and
 * `taskForward.service.js` is read as source to prove it still applies them.
 *
 * Owner's rule, 16 Aug 2026: a task sent back for rework gets a fresh working
 * hour from the send-back, and only when the submission beat its deadline.
 */

const REWORK_WINDOW_SECS = 3600;
const IST_OFFSET = "+05:30";
const at = (day, hhmm) =>
  Date.parse(`2026-08-${day}T${hhmm.length === 5 ? hhmm + ":00" : hhmm}.000${IST_OFFSET}`);

/* Mon–Fri 09:00–18:00, weekend off. */
const SCHEDULE = {
  monday: { inTime: "09:00", outTime: "18:00" },
  tuesday: { inTime: "09:00", outTime: "18:00" },
  wednesday: { inTime: "09:00", outTime: "18:00" },
  thursday: { inTime: "09:00", outTime: "18:00" },
  friday: { inTime: "09:00", outTime: "18:00" },
  saturday: { isOff: true },
  sunday: { isOff: true },
};

test("a fresh hour inside the working day is exactly an hour later", () => {
  /* 17 Aug 2026 is a Monday. Sent back 2:00 PM, due 3:00 PM. */
  const due = addWorkingSecsIST(at("17", "14:00"), REWORK_WINDOW_SECS, SCHEDULE, []);
  assert.equal(Date.parse(due), at("17", "15:00"));
});

test("an hour that meets closing time finishes the next working morning", () => {
  /**
   * The owner's correction when asked: with the office closing at 6:00 PM, a
   * 5:45 PM rework is fifteen minutes today and forty-five tomorrow — NOT
   * 6:45 PM, when nobody is at a desk to do the work.
   */
  const due = addWorkingSecsIST(at("17", "17:45"), REWORK_WINDOW_SECS, SCHEDULE, []);
  assert.equal(Date.parse(due), at("18", "09:45"));
});

test("a Friday evening rework lands on Monday, not Saturday", () => {
  /* 21 Aug 2026 is a Friday. */
  const due = addWorkingSecsIST(at("21", "17:45"), REWORK_WINDOW_SECS, SCHEDULE, []);
  assert.equal(Date.parse(due), at("24", "09:45"));
});

/* ── The gate, as the service applies it ──────────────────────────────────── */

function onTime(submittedAtMs, deadlineMs) {
  return (
    deadlineMs !== null && submittedAtMs !== null && submittedAtMs <= deadlineMs
  );
}

test("submitted before the deadline earns the reset", () => {
  assert.equal(onTime(at("17", "17:00"), at("17", "18:00")), true);
});

test("submitted after the deadline does not", () => {
  /* It keeps its date, stays overdue, and stays timer-blocked until somebody
     grants more time. Deliberate: that is the cost of having been late. */
  assert.equal(onTime(at("17", "19:00"), at("17", "18:00")), false);
});

test("exactly on the deadline counts as on time", () => {
  assert.equal(onTime(at("17", "18:00"), at("17", "18:00")), true);
});

test("a missing figure is never read as on time", () => {
  assert.equal(onTime(null, at("17", "18:00")), false);
  assert.equal(onTime(at("17", "17:00"), null), false);
});

/* ── The service still does what this file describes ──────────────────────── */

test("reworkTask hands back the leftover, through the office calendar, behind the gate", () => {
  /**
   * The window is `deadline − submittedAt` again, which is where it started —
   * but with two things the original did not have: the on-time gate, and an
   * office-calendar walk instead of raw milliseconds on a snapped start.
   */
  const src = require("node:fs")
    .readFileSync(require.resolve("./taskForward.service.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const at0 = src.indexOf("async function reworkTask(");
  assert.ok(at0 > 0, "reworkTask is gone");
  const fn = src.slice(at0, at0 + 4000);

  assert.match(fn, /currentDeadlineMs - submittedAtMs/);
  assert.match(fn, /windowSecs: leftoverSecs/);
  /* Office time, not the original's raw-millisecond addition. */
  assert.match(fn, /computeWorkingDeadline\(\{/);
  assert.equal(
    /_snapToNextWorkingMoment\(new Date\(\)\)[\s\S]{0,200}leftover/.test(fn),
    false,
    "the original raw-millisecond arithmetic is back",
  );
  /* The gate, which is what keeps the subtraction non-negative. */
  assert.match(fn, /submittedAtMs <= currentDeadlineMs/);
  assert.match(fn, /"submitted_late"/);
});

test("the reported case: four minutes left gives four minutes back", () => {
  /* T044 — deadline 12:21, submitted 12:17, sent back 12:19 → 12:23. This is
     the case that separated the leftover from a flat hour (13:19) and from the
     task's budget (12:29). */
  const due = addWorkingSecsIST(at("17", "12:19:00"), 4 * 60, SCHEDULE, []);
  assert.equal(Date.parse(due), at("17", "12:23:00"));
});

test("the reason a deadline did not move is recorded, not just the fact", () => {
  /* "It stayed the same" and "you were late, so it stayed the same" are the
     same pixels and very different facts. */
  const src = require("node:fs").readFileSync(
    require.resolve("./taskForward.service.js"),
    "utf8",
  );
  assert.match(src, /deadlineHeldReason/);
  assert.match(src, /"submitted_late"/);
});

/* ── Project requirements are selectable for rework ───────────────────────── */

test("the rework whitelist includes the PARENT requirements a subtask claims", () => {
  /**
   * OWNER DECISION, 16 Aug 2026. A subtask exists to answer its parent's
   * requirements, so "you have not satisfied 44" is legitimate rework feedback.
   * The whitelist held only the task's own criteria, so such a tick was
   * silently dropped — and ticking ONLY project requirements produced "select
   * at least one" over a screen where two were plainly selected.
   */
  const src = require("node:fs")
    .readFileSync(require.resolve("./taskForward.service.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  assert.match(src, /async function claimedParentRequirementTexts\(/);
  assert.match(src, /function validateReworkRequirements\(task, selected, alsoAvailable = \[\]\)/);
  assert.match(src, /const available = \[\s*\.\.\.own,/);
  /* Every call site passes them, or the widening reaches only one flow. */
  const calls = src.match(/validateReworkRequirements\(task, reworkRequirements, await claimedParentRequirementTexts\(task\)\)/g) || [];
  assert.ok(calls.length >= 3, `only ${calls.length} call sites pass the parent texts`);
});

test("it stays a whitelist — texts come from the PARENT doc, never the request", () => {
  /**
   * The property the original code protects: a caller cannot write arbitrary
   * text into a task's history under the reviewer's name. Resolving from the
   * parent document by the ids the subtask stores keeps that intact.
   */
  const src = require("node:fs").readFileSync(
    require.resolve("./taskForward.service.js"),
    "utf8",
  );
  const at = src.indexOf("async function claimedParentRequirementTexts(");
  const fn = src.slice(at, at + 1600);
  assert.match(fn, /db\.collection\("cowork_tasks"\)\.doc\(parentId\)/);
  assert.match(fn, /task\.satisfiesRequirementIds/);
  /* Positional ids, and a blank never enters the whitelist — an empty string
     there would let a caller send "" and have it accepted. */
  /* The source contains the literal characters `#req-(\d+)$`, so the backslash
     is matched as a backslash rather than as a digit class. */
  assert.match(fn, /#req-\(\\d\+\)\$/);
  assert.match(fn, /text\.trim\(\) \? text\.trim\(\) : null/);
  assert.match(fn, /\.filter\(Boolean\)/);
});

test("an ordinary task's rework behaviour is unchanged", () => {
  /* No parent means no extra texts, so `available` is exactly what it was and
     the original escape for a task with no criteria still applies. */
  const src = require("node:fs")
    .readFileSync(require.resolve("./taskForward.service.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const at = src.indexOf("async function claimedParentRequirementTexts(");
  assert.match(src.slice(at, at + 700), /if \(!parentId \|\| ids\.length === 0\) return \[\];/);
  assert.match(src, /if \(available\.length === 0\) return \[\];/);
});
