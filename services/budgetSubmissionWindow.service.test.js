"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  defaultWindowFor,
  validateWindow,
  windowState,
  isOpenForSubmissions,
  displayStage,
  windowForNewRound,
} = require("./budgetSubmissionWindow.service");

/* ── THE DEFAULT WINDOW ──────────────────────────────────────────────────── */

test("an annual round asks in the March before the year starts", () => {
  /* The brief's own example, and the reason the rule is "1st of the previous
     month to the day before": departments budget for a year before it runs. */
  assert.deepEqual(defaultWindowFor("2026-04-01"), {
    submissionStartDate: "2026-03-01",
    submissionEndDate: "2026-03-31",
  });
});

test("the same rule gives a quarter its own month", () => {
  assert.deepEqual(defaultWindowFor("2026-07-01"), {
    submissionStartDate: "2026-06-01",
    submissionEndDate: "2026-06-30",
  });
  assert.deepEqual(defaultWindowFor("2026-10-01"), {
    submissionStartDate: "2026-09-01",
    submissionEndDate: "2026-09-30",
  });
});

test("a January period asks in December of the previous year", () => {
  /* The month arithmetic has to cross a year boundary, which is exactly where
     a naive `month - 1` produces month -1. */
  assert.deepEqual(defaultWindowFor("2027-01-01"), {
    submissionStartDate: "2026-12-01",
    submissionEndDate: "2026-12-31",
  });
});

test("a February window ends on the real last day of January", () => {
  assert.deepEqual(defaultWindowFor("2027-02-01"), {
    submissionStartDate: "2027-01-01",
    submissionEndDate: "2027-01-31",
  });
});

test("no readable period start means no window, rather than a guessed one", () => {
  assert.deepEqual(defaultWindowFor(null), {
    submissionStartDate: null,
    submissionEndDate: null,
  });
  assert.deepEqual(defaultWindowFor("not a date"), {
    submissionStartDate: null,
    submissionEndDate: null,
  });
});

/* ── VALIDATION ──────────────────────────────────────────────────────────── */

test("a window that closes before it opens is refused", () => {
  const { error, code } = validateWindow({
    submissionStartDate: "2026-03-31",
    submissionEndDate: "2026-03-01",
  });
  assert.match(error, /cannot close before/i);
  assert.equal(code, "SUBMISSION_WINDOW_BACKWARDS");
});

test("a window entirely before the budget period is fine — that is the normal case", () => {
  assert.equal(
    validateWindow({ submissionStartDate: "2026-03-01", submissionEndDate: "2026-03-31" }).error,
    null,
  );
});

test("one-day and absent windows are both allowed", () => {
  assert.equal(
    validateWindow({ submissionStartDate: "2026-03-01", submissionEndDate: "2026-03-01" }).error,
    null,
  );
  assert.equal(validateWindow({}).error, null);
  assert.equal(validateWindow().error, null);
});

/* ── WHERE TODAY SITS ────────────────────────────────────────────────────── */

const WINDOW = { submissionStartDate: "2026-03-01", submissionEndDate: "2026-03-31" };

test("before, inside and after are told apart", () => {
  assert.equal(windowState(WINDOW, new Date("2026-02-28T12:00:00Z")), "before");
  assert.equal(windowState(WINDOW, new Date("2026-03-15T12:00:00Z")), "open");
  assert.equal(windowState(WINDOW, new Date("2026-04-01T12:00:00Z")), "after");
});

test("the closing day is open all day", () => {
  /* A date-only value parses as UTC midnight. Without treating the end as
     inclusive to the whole day, anybody submitting on the afternoon of the
     last day would be told the window had closed. */
  assert.equal(windowState(WINDOW, new Date("2026-03-31T00:00:00Z")), "open");
  assert.equal(windowState(WINDOW, new Date("2026-03-31T23:59:59Z")), "open");
  assert.equal(windowState(WINDOW, new Date("2026-04-01T00:00:01Z")), "after");
});

test("the opening day is open from its first moment", () => {
  assert.equal(windowState(WINDOW, new Date("2026-03-01T00:00:00Z")), "open");
});

test("a round with no window is unrestricted, so old rounds keep working", () => {
  assert.equal(windowState({}, new Date("2030-01-01T00:00:00Z")), "unrestricted");
  assert.equal(isOpenForSubmissions({}, new Date("2030-01-01T00:00:00Z")), true);
});

test("only one end set still restricts that end", () => {
  assert.equal(
    windowState({ submissionStartDate: "2026-03-01" }, new Date("2026-02-01T00:00:00Z")),
    "before",
  );
  assert.equal(
    windowState({ submissionEndDate: "2026-03-31" }, new Date("2026-05-01T00:00:00Z")),
    "after",
  );
});

test("isOpenForSubmissions is false on both sides of the window", () => {
  assert.equal(isOpenForSubmissions(WINDOW, new Date("2026-02-01T00:00:00Z")), false);
  assert.equal(isOpenForSubmissions(WINDOW, new Date("2026-03-10T00:00:00Z")), true);
  assert.equal(isOpenForSubmissions(WINDOW, new Date("2026-05-01T00:00:00Z")), false);
});

/* ── WHAT FINANCE IS SHOWN ───────────────────────────────────────────────── */

test("a collecting round reads by its window, not by its stored word", () => {
  const round = { status: "collecting", ...WINDOW };
  assert.equal(displayStage(round, new Date("2026-02-01T00:00:00Z")), "scheduled");
  assert.equal(displayStage(round, new Date("2026-03-10T00:00:00Z")), "open");
  /* Closed window, still stored as collecting: it is waiting on finance, and
     saying "collecting" there is how a round sits forgotten. */
  assert.equal(displayStage(round, new Date("2026-04-10T00:00:00Z")), "review");
});

test("a live budget says so whatever its window did", () => {
  assert.equal(displayStage({ status: "active", ...WINDOW }, new Date("2026-02-01Z")), "active");
  assert.equal(displayStage({ status: "exceeded", ...WINDOW }, new Date("2026-02-01Z")), "active");
  assert.equal(displayStage({ status: "closed", ...WINDOW }, new Date("2026-03-10Z")), "closed");
  assert.equal(displayStage({ status: "review", ...WINDOW }, new Date("2026-03-10Z")), "review");
  assert.equal(displayStage({ status: "draft", ...WINDOW }, new Date("2026-03-10Z")), "draft");
});

test("a collecting round with no window is simply open", () => {
  assert.equal(displayStage({ status: "collecting" }, new Date("2030-01-01Z")), "open");
});

/* ── THE ROUND THAT WAS BORN CLOSED ──────────────────────────────────────────
   The window a round gets at CREATION time, which is not always the one
   derived from its period. Found by walking the whole lifecycle: finance
   opened FY 2026-27 in August 2026 and the department was told "Submissions
   closed on 31 Mar 2026" for a round created a minute earlier. */

test("a round opened before its year still gets the derived window", () => {
  /* The normal case, unchanged: budgeting happens ahead of the year. */
  assert.deepEqual(windowForNewRound("2026-04-01", new Date("2026-01-15T00:00:00Z")), {
    submissionStartDate: "2026-03-01",
    submissionEndDate: "2026-03-31",
  });
});

test("and one opened while the window is open keeps it", () => {
  assert.deepEqual(windowForNewRound("2026-04-01", new Date("2026-03-10T00:00:00Z")), {
    submissionStartDate: "2026-03-01",
    submissionEndDate: "2026-03-31",
  });
});

test("the last day of the derived window still counts as open", () => {
  assert.deepEqual(windowForNewRound("2026-04-01", new Date("2026-03-31T18:00:00Z")), {
    submissionStartDate: "2026-03-01",
    submissionEndDate: "2026-03-31",
  });
});

test("a round opened after its window would have closed opens today instead", () => {
  /* The bug: a year already four months old, which is exactly when somebody
     sets the module up for the first time. */
  assert.deepEqual(windowForNewRound("2026-04-01", new Date("2026-08-27T09:00:00Z")), {
    submissionStartDate: "2026-08-27",
    submissionEndDate: "2026-09-26",
  });
});

test("the replacement window is genuinely open on the day it is made", () => {
  const now = new Date("2026-08-27T09:00:00Z");
  const w = windowForNewRound("2026-04-01", now);
  assert.equal(windowState(w, now), "open");
  assert.equal(isOpenForSubmissions(w, now), true);
  /* And it does close, rather than staying open for ever. */
  assert.equal(windowState(w, new Date("2026-10-01T00:00:00Z")), "after");
});

test("no readable period start still means no window, not a guessed one", () => {
  assert.deepEqual(windowForNewRound(null, new Date("2026-08-27T09:00:00Z")), {
    submissionStartDate: null,
    submissionEndDate: null,
  });
});
