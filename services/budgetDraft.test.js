// services/budgetDraft.test.js
//
// A BUDGET IS NOT SET IN ONE PASS.
//
// Two drafts with a meeting between them. What is under test is not the dates
// for their own sake but three claims about the process:
//
//   1 · the meeting is a state, not a moment — Draft 2 cannot open straight
//       off Draft 1 closing, because a second draft nobody has thought about
//       comes back with the same numbers;
//   2 · a line agreed in Draft 1 is FINISHED, which is both the incentive to
//       submit honestly and a hard requirement of how allocations are keyed;
//   3 · a cycle opened late still gets a usable schedule rather than two
//       windows that closed months ago.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const drafts = require("./budgetDraft.service");

const cycle = (over = {}) => ({
  status: "review",
  submissionStartDate: new Date("2026-02-01"),
  submissionEndDate: new Date("2026-03-01"),
  ...over,
});

/* ══ WHAT A CYCLE'S DRAFTS ARE ══════════════════════════════════════════════ */

test("a cycle from before drafts existed reads as Draft 1", () => {
  // It always was one. Reading it as "no drafts" would make its history
  // nonsense and force a migration to say something already true.
  const all = drafts.draftsOf(cycle({ drafts: undefined }));
  assert.equal(all.length, 1);
  assert.equal(all[0].number, 1);
  assert.equal(all[0].opensOn.toISOString().slice(0, 10), "2026-02-01");
  // Nothing claims a person opened it, because nobody did.
  assert.equal(all[0].openedBy, null);
});

test("a cycle with no deadline is still on its first draft", () => {
  // A window is optional — absent means "submit whenever the status says
  // collecting". But the round still happened and departments still put
  // numbers into it. Reading this as "no drafts" made the next one open as
  // Draft 1 a second time, on top of submissions already there.
  const all = drafts.draftsOf({ submissionStartDate: null, submissionEndDate: null });
  assert.equal(all.length, 1);
  assert.equal(all[0].number, 1);
  assert.equal(all[0].opensOn, null);
  assert.equal(all[0].closesOn, null);
});

test("no cycle at all is the only empty answer", () => {
  assert.deepEqual(drafts.draftsOf(null), []);
  assert.deepEqual(drafts.draftsOf(undefined), []);
});

test("the active draft is the last one opened", () => {
  const b = cycle({
    drafts: [
      { number: 1, opensOn: new Date("2026-02-01"), closesOn: new Date("2026-03-01") },
      { number: 2, opensOn: new Date("2026-03-07"), closesOn: new Date("2026-03-17") },
    ],
  });
  assert.equal(drafts.activeDraft(b).number, 2);
  assert.equal(drafts.draftNumber(b), 2);
});

test("a cycle that has never opened one still reports a number", () => {
  // So a screen never has to render "Draft undefined".
  assert.equal(drafts.draftNumber({ status: "draft" }), 1);
});

/* ══ THE MEETING IS A STATE ═════════════════════════════════════════════════ */

test("Draft 2 opens from review, and only from review", () => {
  const ok = drafts.canOpenNext(cycle({ status: "review" }));
  assert.equal(ok.ok, true);
  assert.equal(ok.next, 2);
});

test("Draft 2 cannot open while Draft 1 is still collecting", () => {
  // The gap between them is the meeting. Without it, departments resubmit
  // exactly what they sent the first time.
  const no = drafts.canOpenNext(cycle({ status: "collecting" }));
  assert.equal(no.ok, false);
  assert.match(no.reason, /Close it first/);
  assert.match(no.reason, /meeting comes between the drafts/);
});

test("a live or closed cycle is not taking drafts", () => {
  for (const status of ["active", "closed", "exceeded", "draft"]) {
    const no = drafts.canOpenNext(cycle({ status }));
    assert.equal(no.ok, false, status);
  }
});

test("there is no Draft 3", () => {
  const b = cycle({
    status: "review",
    drafts: [{ number: 1 }, { number: 2 }],
  });
  const no = drafts.canOpenNext(b);
  assert.equal(no.ok, false);
  // And it says what to do instead of reporting that a limit exists.
  assert.match(no.reason, /decided in review/);
  assert.equal(drafts.MAX_DRAFTS, 2);
});

/* ══ A CLEAN FIRST DRAFT FINISHES YOU ═══════════════════════════════════════ */

test("an agreed line does not carry into the next draft", () => {
  // The incentive: submit honestly and you are done. And the requirement:
  // allocations key on sourceRequestId, so carrying an agreed request forward
  // would write a second allocation line for the same money.
  assert.equal(drafts.carriesForward({ state: "agreed" }), false);
});

test("a line the deadline defaulted does not either", () => {
  // close-collection accepted the envelope on the department's behalf.
  // Reopening it would undo a decision the deadline already made.
  assert.equal(drafts.carriesForward({ state: "defaulted" }), false);
});

test("everything still being argued about does carry", () => {
  for (const state of ["submitted", "countered", "awaiting"]) {
    assert.equal(drafts.carriesForward({ state }), true, state);
  }
});

test("a state nobody has heard of carries rather than vanishing", () => {
  // Losing a department's line because of an unrecognised state is a worse
  // failure than carrying one that did not need to move.
  assert.equal(drafts.carriesForward({ state: "something_new" }), true);
  assert.equal(drafts.carriesForward({}), true);
});

/* ══ EVERY ASK MUST HAVE AN ANSWER ══════════════════════════════════════════ */

const withAsks = (...states) =>
  cycle({
    status: "review",
    budgetRequests: states.map((state, i) => ({
      state, draft: 1, department: "Tech", ledgerName: `Head ${i}`,
    })),
  });

test("Draft 2 will not open while an ask is unanswered", () => {
  // A line nobody replied to arrives in Draft 2 looking like a fresh ask. The
  // department cannot tell whether it was too big or simply missed, so they
  // send the same number back and the second draft achieves nothing.
  const no = drafts.canOpenNext(withAsks("agreed", "submitted"));
  assert.equal(no.ok, false);
  assert.equal(no.undecided, 1);
  assert.match(no.reason, /not been answered/);
  // And it names them, so finance does not have to hunt.
  assert.match(no.reason, /Tech · Head 1/);
});

test("an ask nobody has even submitted counts as unanswered too", () => {
  assert.equal(drafts.canOpenNext(withAsks("awaiting")).ok, false);
});

test("agreed, countered and rejected all count as answered", () => {
  // `rejected` is the one that had no way to be expressed before: finance
  // could agree or counter, but not say no. So "answered" and "agreed" were
  // the same word and a refusal had to be faked as a counter at zero.
  const ok = drafts.canOpenNext(withAsks("agreed", "countered", "rejected", "defaulted"));
  assert.equal(ok.ok, true);
  assert.equal(ok.next, 2);
});

test("only the current draft's asks are counted", () => {
  const b = cycle({
    status: "review",
    drafts: [{ number: 1 }],
    budgetRequests: [
      { state: "submitted", draft: 1, supersededByDraft: 2 },
      { state: "agreed", draft: 1 },
    ],
  });
  // The superseded row is history — its live copy is what matters.
  assert.equal(drafts.undecidedIn(b).length, 0);
  assert.equal(drafts.canOpenNext(b).ok, true);
});

test("a cycle with no asks at all can still move on", () => {
  assert.equal(drafts.canOpenNext(cycle({ status: "review", budgetRequests: [] })).ok, true);
});

/* ══ A REFUSAL IS NOT A DELETION ════════════════════════════════════════════ */

test("a rejected ask comes back in the next draft", () => {
  // A budget round has no way to remove somebody else's priority. It can only
  // decline to fund it and say why; the department revises it or drops it.
  assert.equal(drafts.carriesForward({ state: "rejected" }), true);
});

test("but an agreed one does not, which is the whole incentive", () => {
  assert.equal(drafts.carriesForward({ state: "agreed" }), false);
});

/* ══ THE SCHEDULE, DERIVED BACKWARDS ════════════════════════════════════════ */

test("both deadlines are worked back from the day the budget must be live", () => {
  // Choosing Draft 1's deadline first is how a company discovers in mid-March
  // that it has run out of March.
  const s = drafts.scheduleFor(new Date("2026-04-01"), new Date("2026-01-15"));
  const day = (d) => d.toISOString().slice(0, 10);

  assert.equal(s.compressed, false);
  assert.equal(day(s.drafts[0].opensOn), "2026-02-01");
  assert.equal(day(s.drafts[0].closesOn), "2026-03-01");
  assert.equal(day(s.drafts[1].opensOn), "2026-03-07");
  assert.equal(day(s.drafts[1].closesOn), "2026-03-17");
});

test("the gap between the drafts is the meeting, and it is not zero", () => {
  const s = drafts.scheduleFor(new Date("2026-04-01"), new Date("2026-01-15"));
  const gap = (s.drafts[1].opensOn - s.drafts[0].closesOn) / (24 * 60 * 60 * 1000);
  assert.ok(gap >= 5, `only ${gap} days to hold the meeting`);
});

test("and the fortnight after the last deadline is left for review and activation", () => {
  const s = drafts.scheduleFor(new Date("2026-04-01"), new Date("2026-01-15"));
  const tail = (new Date("2026-04-01") - s.drafts[1].closesOn) / (24 * 60 * 60 * 1000);
  assert.ok(tail >= 14, `only ${tail} days to agree and activate`);
});

test("a cycle opened late gets a schedule it can actually use", () => {
  // Opened in August for an April year: the derived windows closed months ago,
  // which is a draft born closed — the same fault windowForNewRound exists to
  // prevent for a single window.
  const s = drafts.scheduleFor(new Date("2026-04-01"), new Date("2026-08-29"));
  assert.equal(s.compressed, true);
  assert.ok(s.drafts[0].closesOn > new Date("2026-08-29"));
  assert.ok(s.drafts[1].opensOn > s.drafts[0].closesOn);
  assert.ok(s.drafts[1].closesOn > s.drafts[1].opensOn);
});

test("a cycle with no live date gets no invented schedule", () => {
  assert.equal(drafts.scheduleFor(null), null);
  assert.equal(drafts.scheduleFor("not a date"), null);
});

/* ══ THE DEADLINE NOTHING ENFORCES ══════════════════════════════════════════ */

test("how long the meeting has been pending is reported", () => {
  // Nobody notices a review that runs three weeks, because there is no
  // deadline on a meeting for it to be late against.
  const b = cycle({
    status: "review",
    drafts: [{ number: 1, closedAt: new Date("2026-03-01") }],
  });
  assert.equal(drafts.daysInReview(b, new Date("2026-03-19")), 18);
});

test("a cycle that is not in review is not waiting on a meeting", () => {
  assert.equal(drafts.daysInReview(cycle({ status: "collecting" })), null);
  assert.equal(drafts.daysInReview(cycle({ status: "active" })), null);
});

test("the day it closed counts as zero, not as a negative", () => {
  const b = cycle({ status: "review", drafts: [{ number: 1, closedAt: new Date("2026-03-01") }] });
  assert.equal(drafts.daysInReview(b, new Date("2026-03-01")), 0);
});
