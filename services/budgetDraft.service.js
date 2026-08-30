/**
 * services/budgetDraft.service.js
 *
 * A BUDGET IS NOT SET IN ONE PASS.
 *
 * ── THE PROCESS THIS MODELS ─────────────────────────────────────────────────
 *
 *   Draft 1 opens  →  departments submit  →  deadline  →  THE MEETING
 *                                                              ↓
 *   Draft 2 opens  →  departments revise  →  deadline  →  finance activates
 *
 * The meeting is the point of the whole thing. A second draft that opens the
 * instant the first one closes gives nobody a reason to change a number, and
 * departments resubmit what they sent the first time. So the gap between
 * drafts is a REAL STATE — the cycle's existing `review` — and Draft 2 is
 * opened by a person, deliberately, after somebody has looked at the total.
 *
 * ── WHY TWO ────────────────────────────────────────────────────────────────
 * Draft 1 is always an over-ask, and that is rational rather than dishonest:
 * nobody knows the envelope until the asks are added up. Draft 2, with that
 * total visible, is where prioritisation actually happens.
 *
 * A third would be the remainder of a remainder. Agreed lines leave the
 * process after Draft 1 (see `carriesForward`), so Draft 2 is already only the
 * unsettled part; by Draft 3 it is a couple of lines and a phone call. More
 * rounds also teach everybody to pad the first one, which is the failure mode
 * this design exists to avoid.
 *
 * ── WHAT MAKES A CLEAN FIRST DRAFT WORTH SUBMITTING ────────────────────────
 * A line finance agrees in Draft 1 is FINISHED. It does not carry forward, it
 * is not renegotiated, and a department whose whole submission was agreed has
 * nothing to do in Draft 2 at all.
 *
 * That is the incentive — submit honestly and you are done; pad it and you
 * come back and cut. It is also required rather than merely nice:
 * `syncAllocationFromRequest` keys allocations on `sourceRequestId`, so
 * carrying an agreed request into the next draft would write a SECOND
 * allocation line for the same money.
 *
 * ── WHY THE WINDOW MACHINERY IS UNTOUCHED ──────────────────────────────────
 * `submissionStartDate` / `submissionEndDate` on the cycle remain the ACTIVE
 * draft's window, and every existing reader of them — the department gate in
 * budgetProposals.service, `windowState`, `isOpenForSubmissions` — keeps
 * working without knowing drafts exist. Opening Draft 2 moves those two dates.
 * `drafts[]` is the history and the structure; it is not a second enforcement
 * path that could disagree with the first.
 */

"use strict";

const variance = require("./budgetVariance.service");

/** Two, and the reason is above. */
const MAX_DRAFTS = 2;

/** Where a cycle may be when the next draft is opened. */
const OPENABLE_FROM = ["review"];

/**
 * States a request can be in and still be unsettled.
 *
 * `agreed` is finance saying yes — it becomes an allocation and leaves the
 * process. `defaulted` is close-collection accepting the envelope on a
 * department's behalf when they never submitted; also settled, and reopening
 * it would undo a decision the deadline already made.
 */
const SETTLED_STATES = ["agreed", "defaulted"];

/**
 * States that mean nobody has looked at it yet.
 *
 * Draft 2 cannot open while any of these are outstanding. Not a tidiness rule:
 * a line finance never answered comes back in the next draft as if it were a
 * fresh ask, the department has no idea whether it was too big or simply
 * missed, and the same number is submitted again. The whole value of a second
 * draft is that the first one was ANSWERED.
 */
const UNDECIDED_STATES = ["submitted", "awaiting"];

const asDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const DAY = 24 * 60 * 60 * 1000;
const shift = (date, days) => new Date(asDate(date).getTime() + days * DAY);

/**
 * The drafts a cycle has, including cycles that predate drafts entirely.
 *
 * A budget opened before this existed has one window and no `drafts[]`. It is
 * read as Draft 1 rather than as "no drafts" — which is what it always was,
 * and means nothing has to be migrated for the history to make sense.
 */
function draftsOf(budget) {
  const stored = Array.isArray(budget?.drafts) ? budget.drafts : [];
  if (stored.length) return stored;
  if (!budget) return [];
  /* ── AN UNRESTRICTED CYCLE IS STILL ON ITS FIRST DRAFT ──────────────────
     A window is optional and absent means "submit whenever the status says
     collecting" — but the ROUND still happened, and departments still put
     numbers into it. Reading a dateless cycle as having no drafts made the
     next one open as Draft 1 a second time, silently, on top of submissions
     that were already there. */
  return [
    {
      number: 1,
      opensOn: budget.submissionStartDate || null,
      closesOn: budget.submissionEndDate || null,
      /* Synthesised, so nothing claims a person opened it. */
      openedBy: null,
      openedAt: null,
      closedAt: null,
      note: null,
      carriedForward: 0,
    },
  ];
}

/** The draft in play — the last one opened. */
function activeDraft(budget) {
  const all = draftsOf(budget);
  return all.length ? all[all.length - 1] : null;
}

/** 1 when a cycle has never opened one, so a screen always has a number. */
function draftNumber(budget) {
  return activeDraft(budget)?.number || 1;
}

/**
 * May the next draft be opened, and if not, why not?
 *
 * Three refusals, each naming what the person has to do instead of reporting
 * that a rule exists.
 */
function canOpenNext(budget) {
  const all = draftsOf(budget);
  const status = String(budget?.status || "");

  if (all.length >= MAX_DRAFTS) {
    return {
      ok: false,
      reason:
        `This cycle has had both drafts. What is still unsettled is decided in review — ` +
        `agree it, counter it, or leave it out of the year.`,
    };
  }

  if (!OPENABLE_FROM.includes(status)) {
    return {
      ok: false,
      reason:
        status === "collecting"
          ? "Draft 1 is still collecting. Close it first — the meeting comes between the drafts."
          : `A cycle that is ${status} is not taking drafts.`,
    };
  }

  /* ── EVERY ASK MUST HAVE AN ANSWER ────────────────────────────────────
     Agreed, countered or refused with a reason — but answered. A line that
     goes into Draft 2 unanswered arrives looking like a fresh ask: the
     department cannot tell whether it was too big or simply missed, so they
     submit the same number again and the second draft achieves nothing. */
  const open = undecidedIn(budget);
  if (open.length) {
    const names = open
      .slice(0, 3)
      .map((r) => `${r.department || "a department"} · ${r.ledgerName || "unnamed head"}`);
    return {
      ok: false,
      undecided: open.length,
      reason:
        `${open.length} ask${open.length === 1 ? " has" : "s have"} not been answered yet — ` +
        `${names.join(", ")}${open.length > names.length ? ", and others" : ""}. ` +
        `Agree, counter or reject each one first; a department cannot revise an ask nobody replied to.`,
    };
  }

  return { ok: true, reason: null, next: all.length + 1 };
}

/**
 * Does this request go into the next draft?
 *
 * Settled lines do not — see the header on why that is both the incentive and
 * a hard requirement of how allocations are keyed.
 */
function carriesForward(request) {
  return !SETTLED_STATES.includes(String(request?.state || ""));
}

/**
 * The asks in this draft that finance has not answered.
 *
 * `rejected` counts as answered. A refusal here does not kill a line — it
 * sends it back with a reason, and the department revises or drops it in the
 * next draft. What must not happen is a line passing into Draft 2 having been
 * neither agreed nor argued with.
 */
function undecidedIn(budget, draft = null) {
  const number = draft || draftNumber(budget);
  return (budget?.budgetRequests || []).filter(
    (r) =>
      !r.supersededByDraft &&
      (r.draft || 1) === number &&
      UNDECIDED_STATES.includes(String(r.state || "")),
  );
}

/**
 * The two windows, derived backwards from the day the budget must be live.
 *
 * ── WHY BACKWARDS ───────────────────────────────────────────────────────────
 * The date that actually matters is the one nobody sets: the year starts on 1
 * April whether or not a budget exists. Choosing Draft 1's deadline first is
 * how a company discovers in mid-March that it has run out of March. Working
 * back from the live date gives the whole schedule and leaves the fortnight at
 * the end that review and activation actually need.
 *
 * ── AND WHY A LATE CYCLE STILL GETS A USABLE ONE ────────────────────────────
 * A cycle opened in August for an April year would derive two windows that
 * closed months ago — a draft born closed, which is the same fault
 * `windowForNewRound` exists to prevent for the single-window case. When the
 * derived schedule is already in the past it is compressed forward from today
 * instead, keeping the same shape.
 */
function scheduleFor(liveDate, now = new Date()) {
  const live = asDate(liveDate);
  const today = asDate(now) || new Date();
  if (!live) return null;

  /* Offsets in days before the budget goes live. The gap between D1 closing
     and D2 opening is the meeting; the fortnight after D2 closes is review
     and activation. */
  const planned = {
    d1Opens: shift(live, -59),
    d1Closes: shift(live, -31),
    d2Opens: shift(live, -25),
    d2Closes: shift(live, -15),
  };

  const late = planned.d1Closes.getTime() < today.getTime();
  const from = late ? today : planned.d1Opens;

  const windows = late
    ? {
        d1Opens: from,
        d1Closes: shift(from, 14),
        d2Opens: shift(from, 19),
        d2Closes: shift(from, 26),
      }
    : planned;

  return {
    /* Said plainly, because a compressed schedule is a different promise from
       the one the offsets describe and the screen should not imply otherwise. */
    compressed: late,
    drafts: [
      { number: 1, opensOn: windows.d1Opens, closesOn: windows.d1Closes },
      { number: 2, opensOn: windows.d2Opens, closesOn: windows.d2Closes },
    ],
  };
}

/**
 * How long a cycle has been sitting between drafts.
 *
 * The one date nothing enforces. A review that quietly runs three weeks is
 * what kills these processes, and nobody notices because there is no deadline
 * on a meeting — so the number is reported rather than left to be felt.
 */
function daysInReview(budget, now = new Date()) {
  if (String(budget?.status || "") !== "review") return null;
  const active = activeDraft(budget);
  const since = asDate(active?.closedAt) || asDate(active?.closesOn) || asDate(budget?.updatedAt);
  if (!since) return null;
  const days = Math.floor(((asDate(now) || new Date()).getTime() - since.getTime()) / DAY);
  return days > 0 ? days : 0;
}

/** What a draft is called on screen. */
const draftLabel = (n) => `Draft ${variance.money(n) ?? n}`;

module.exports = {
  MAX_DRAFTS,
  OPENABLE_FROM,
  SETTLED_STATES,
  UNDECIDED_STATES,
  undecidedIn,
  draftsOf,
  activeDraft,
  draftNumber,
  canOpenNext,
  carriesForward,
  scheduleFor,
  daysInReview,
  draftLabel,
};
