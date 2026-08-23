// services/journeyAttention.js
//
// "This journey needs a decision."
//
// The outcome axis gave Sales the words — parked, lost — but no reason to use
// them. Leaving a dead deal marked active was free and parking it cost a click,
// so the rational move was always to do nothing, and the board filled with
// journeys nobody had touched in months but nobody would call dead either.
//
// This inverts that. A journey that has gone quiet stops being quiet: it
// surfaces at the top of the hub and there are exactly three ways to clear it —
// do something, park it with a date, or mark it lost. Silence becomes the noisy
// option, and parking becomes how you make the noise stop, honestly, in five
// seconds.
//
// THREE TRIGGERS, all from data that already exists:
//
//   revisitDue      a parked journey whose revisit date has arrived. The whole
//                   payout of parking: you said November, it is November.
//   outsideOverdue  the mill/lab was due to hand it back and the date passed.
//   stale           no date on it at all and nothing has moved in STALE_DAYS.
//
// DELIBERATELY NOT HERE: email or push (nagging before the threshold is proven
// is how a feature gets turned off), auto-parking (a system that decides a deal
// is dormant will be wrong, and once it is wrong twice nobody trusts the state
// again), and any score out of 100 ("needs a decision or not" is actionable; a
// health percentage is not).

"use strict";

/**
 * How long a journey may sit with no date and no movement before it is asked
 * about. Two weeks: long enough that a normal back-and-forth does not trip it,
 * short enough to catch a deal while it is still warm.
 *
 * One constant on purpose — this is the number to change after watching it for
 * a month, and it should be changed in one place.
 */
const STALE_DAYS = 14;

const DAY = 24 * 60 * 60 * 1000;
const at = (d) => (d ? new Date(d).getTime() : null);

/**
 * @param {object} journey  summary-shaped: outcome, revisitOn, hold, nextAction,
 *                          targetDate, updatedAt
 * @param {Date}   [now]
 * @returns {{needsDecision: boolean, reason: string|null, label: string|null, since: Date|null}}
 */
function journeyAttention(journey = {}, now = new Date()) {
  const t = now.getTime();
  const none = { needsDecision: false, reason: null, label: null, since: null };

  // A lost or closed journey has already had its decision made.
  const outcome = journey.outcome || "active";
  if (outcome === "lost" || outcome === "closed") return none;

  // 1. A parked journey whose date has come round. Checked first: it is the one
  //    trigger the salesperson explicitly asked for.
  const revisit = at(journey.revisitOn);
  if (outcome === "parked") {
    if (revisit !== null && revisit <= t) {
      return {
        needsDecision: true,
        reason: "revisitDue",
        label: "You said to look at this again now",
        since: new Date(revisit),
      };
    }
    // Parked and not yet due is the system working. Nothing to ask.
    return none;
  }

  // 2. Someone outside was due to hand it back and did not.
  const back = at(journey.hold?.expectedBack);
  if (back !== null && back < t) {
    const who = journey.hold?.on;
    return {
      needsDecision: true,
      reason: "outsideOverdue",
      label: who ? `${who} was due back` : "An outside party is overdue",
      since: new Date(back),
    };
  }

  // 3. Nothing scheduled and nothing happening. Only when there is NO date at
  //    all — a journey with a next action that is overdue is already shouting
  //    from the Overdue band, and saying it twice helps nobody.
  const dated = at(journey.nextAction?.dueDate ?? journey.nextAction?.due) ?? at(journey.targetDate?.date);
  if (dated === null) {
    const touched = at(journey.updatedAt);
    if (touched !== null && t - touched >= STALE_DAYS * DAY) {
      const days = Math.floor((t - touched) / DAY);
      return {
        needsDecision: true,
        reason: "stale",
        label: `Nothing has moved in ${days} days`,
        since: new Date(touched),
      };
    }
  }

  return none;
}

module.exports = { journeyAttention, STALE_DAYS };
