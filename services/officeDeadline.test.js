const assert = require("node:assert/strict");
const { test } = require("node:test");

const { addWorkingSecsIST, readMs } = require("./officeDeadline.service");

/**
 * The deadline a granted window earns.
 *
 * **The rule this file exists for:** a cross-department task's clock starts when
 * the assignee's manager GRANTS the hours, and it counts working time only.
 * Before this, the date came from the sender's create — written before anyone
 * knew who would do the work, sometimes hours or days earlier — and the granted
 * window never moved it at all, because a leftover `fixedDeadline` outranks
 * `dueDate` in the read precedence.
 */

const DAY = { inTime: "09:30", outTime: "18:30", isOff: false };
const SCHEDULE = {
  monday: DAY, tuesday: DAY, wednesday: DAY, thursday: DAY,
  friday: DAY, saturday: DAY,
  sunday: { inTime: "09:30", outTime: "18:30", isOff: true },
};

/** `2026-08-13T14:30:00+05:30` → ms. Thursday. */
const ist = (s) => Date.parse(`${s}+05:30`);
/** Back to a readable IST wall-clock string, for assertions that read as dates. */
const showIst = (iso) =>
  new Date(Date.parse(iso) + 5.5 * 3600000).toISOString().slice(0, 19);

test("two hours granted at 14:30 is due at 16:30", () => {
  /* The whole complaint, in one line: a manager grants two hours at 14:30, so
     the work is due at 16:30 — not at some date the sender wrote at 12:25 when
     the request was raised. */
  const due = addWorkingSecsIST(ist("2026-08-13T14:30:00"), 2 * 3600, SCHEDULE, []);
  assert.equal(showIst(due), "2026-08-13T16:30:00");
});

test("the wait before the grant is never charged to the assignee", () => {
  /* Same window, granted two hours later, is due two hours later. Time the task
     spent sitting in approval is time the assignee could not have worked, so it
     must not come out of their budget. */
  const early = addWorkingSecsIST(ist("2026-08-13T12:30:00"), 2 * 3600, SCHEDULE, []);
  const late = addWorkingSecsIST(ist("2026-08-13T14:30:00"), 2 * 3600, SCHEDULE, []);
  assert.equal(Date.parse(late) - Date.parse(early), 2 * 3600 * 1000);
});

test("a late grant carries into the next working day, not into the night", () => {
  /* Four hours at 17:15 against an 18:30 close: 1h15m today, the rest from
     09:30 tomorrow. Raw addition would say 21:15 tonight, which is a deadline
     nobody can work to. */
  const due = addWorkingSecsIST(ist("2026-08-13T17:15:00"), 4 * 3600, SCHEDULE, []);
  assert.equal(showIst(due), "2026-08-14T12:15:00");
});

test("a day marked off is skipped entirely", () => {
  /* Saturday 17:30 + 2h, with Sunday off: 1h on Saturday, 1h from Monday's
     09:30. A budget must not be consumed on a day nobody works. */
  const due = addWorkingSecsIST(ist("2026-08-15T17:30:00"), 2 * 3600, SCHEDULE, []);
  assert.equal(showIst(due), "2026-08-17T10:30:00");
});

test("breaks are not working time", () => {
  /* 13:00–13:30 is a break, so two hours from 12:30 finishes at 15:00 rather
     than 14:30 — the same half hour the office policy already subtracts from
     everybody's day. */
  const breaks = [{ start: "13:00", end: "13:30" }];
  const due = addWorkingSecsIST(ist("2026-08-13T12:30:00"), 2 * 3600, SCHEDULE, breaks);
  assert.equal(showIst(due), "2026-08-13T15:00:00");
});

test("a grant before opening starts at opening, not at the grant", () => {
  /* Hours set at 07:00 do not begin burning at 07:00; the day starts at 09:30
     and so does the window. */
  const due = addWorkingSecsIST(ist("2026-08-13T07:00:00"), 2 * 3600, SCHEDULE, []);
  assert.equal(showIst(due), "2026-08-13T11:30:00");
});

test("no schedule falls back to the wall clock WITHOUT the +6h probe", () => {
  /**
   * The copy in `taskForward.js:1931` adds six hours on this branch and labels
   * it "BRANDED PROBE" — a marker for spotting the fallback in real data. Six
   * unexplained hours is fine as a diagnostic and not fine on somebody's
   * deadline, so this path is a plain addition and this test pins it there.
   */
  const start = ist("2026-08-13T14:30:00");
  const due = addWorkingSecsIST(start, 2 * 3600, null, []);
  assert.equal(Date.parse(due) - start, 2 * 3600 * 1000);
});

test("the anchor is readable however the document stored it", () => {
  /**
   * `tlHoursSetAt` is written by `serverTimestamp()` and read back as a
   * Firestore Timestamp; `tlHoursSetAtMs` is a plain number written beside it
   * because a sentinel cannot be read within the write that sets it. Older
   * documents have neither. Each shape has to resolve or fall back cleanly —
   * a `NaN` anchor would produce an Invalid Date deadline.
   */
  const ms = ist("2026-08-13T14:30:35");
  assert.equal(readMs(ms), ms);
  assert.equal(readMs(new Date(ms).toISOString()), ms);
  assert.equal(readMs({ toMillis: () => ms }), ms);
  assert.equal(readMs({ _seconds: Math.floor(ms / 1000) }), Math.floor(ms / 1000) * 1000);

  for (const empty of [null, undefined, "", "not a date", NaN, {}]) {
    assert.equal(readMs(empty), null, `${JSON.stringify(empty)} read as an instant`);
  }
});
