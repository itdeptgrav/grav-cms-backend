// constants/marketingPacing.js
//
// BUDGET PACING: IS A CAMPAIGN SPENDING ITS APPROVED BUDGET AT THE RATE ITS
// SCHEDULE IMPLIES — AND, WHEN GRAV CANNOT HONESTLY SAY, WHY NOT.
//
// ── THE CALCULATION, STATED ONCE ───────────────────────────────────────────
// For one deployment (one campaign GRAV created in one advertising channel for
// the plan's approved revision):
//
//   scheduleDays  = days from the plan's start date to its end date, inclusive
//   asOf          = the last day of the unbroken run of SETTLED days that begins
//                   on the start date (never later than the end date or
//                   yesterday in the advertising account's time zone)
//   elapsedDays   = days from the start date to asOf, inclusive
//   spentToDate   = the sum of the channel's reported spend on those days,
//                   added in micros and rounded once
//
//   daily budget  expected = dailyAmount × elapsedDays
//                 budget for the whole schedule = dailyAmount × scheduleDays
//   total budget  expected = totalAmount × elapsedDays ÷ scheduleDays
//                 (an even spread — the only spread the plan records)
//
//   paceRatio     = spentToDate ÷ expected
//
// The verdict comes from paceRatio and the thresholds below. Every input must
// exist and agree, or there is no verdict — only `unavailable` and a reason.
//
// ── WHAT IS NEVER DONE ─────────────────────────────────────────────────────
// A day GRAV has not read is not a day of zero spend. Two currencies are never
// added. A plan's single budget is never divided between channels: each
// channel's campaign was created with the plan's full amount, and GRAV holds
// no record of any split, so channels are paced separately and never
// combined. Nothing here contacts an advertising channel or changes anything.
"use strict";

const freeze = Object.freeze;
const pair = (code, label, extra = {}) => freeze({ code, label, ...extra });
const codes = (list) => freeze(list.map((x) => x.code));

/* ── THE THRESHOLDS ─────────────────────────────────────────────────────────
   A pace inside ±10–20 % of even is on track: channels spend unevenly day to
   day (Google may spend up to twice a daily budget on one day and less on
   another), so a tighter band would call ordinary delivery a problem. */
const THRESHOLDS = freeze({
  UNDER_BELOW: 0.8,
  OVER_ABOVE: 1.1,
});

/* Unsettled days allowed after `asOf` before the verdict is too old to show.
   Matches the reporting contract's settling window (observationSync's
   SETTLING_DAYS): the most recent days are still being counted, and a verdict
   "as of" the last settled day is honest. More unsettled days than that means
   GRAV has fallen behind, and the verdict would describe a stale moment. */
const MAX_UNSETTLED_DAYS = 3;

const VERDICTS = [
  pair("under_pace", "Spending below plan", {
    means: "Spend so far is less than 80% of what the approved budget and schedule imply by this date.",
  }),
  pair("on_pace", "On pace", {
    means: "Spend so far is within the expected range for the approved budget and schedule.",
  }),
  pair("over_pace", "Spending ahead of plan", {
    means: "Spend so far is more than 110% of what the approved budget and schedule imply by this date.",
  }),
  pair("over_budget", "Over the approved budget", {
    means: "Spend so far is more than the entire approved budget for the schedule.",
  }),
];
const VERDICT_CODES = codes(VERDICTS);

/* ── WHY THERE IS NO VERDICT ────────────────────────────────────────────────
   Each is a specific sentence a person can act on. */
const UNAVAILABLE = [
  pair("plan_not_approved", "The plan is not approved", {
    means: "Pacing compares spend with an approved budget. This plan has no approved budget in force.",
  }),
  pair("budget_missing", "The plan has no budget", {
    means: "The approved plan does not record a budget amount, currency and basis.",
  }),
  pair("budget_zero", "The approved budget is zero", {
    means: "An approved budget of zero has no pace to compare spend against.",
  }),
  pair("schedule_missing", "The plan has no complete schedule", {
    means: "Pacing needs the approved start and end dates.",
  }),
  pair("budget_basis_conflict", "The budget basis and the channel arrangement disagree", {
    means: "The plan's budget is recorded as one basis (daily or total) and this channel's campaign as the other, so GRAV cannot tell which figure governs.",
  }),
  pair("budget_per_audience", "The budget is per audience", {
    means: "This channel's budget is a daily amount for each audience, so the campaign's total depends on how many audiences it has. GRAV does not pace it.",
  }),
  pair("not_deployed", "No campaign has been created", {
    means: "GRAV has not created a campaign for this plan's approved revision in any channel, so there is no spend to compare.",
  }),
  pair("campaign_not_created", "This channel's campaign was not created", {
    means: "GRAV did not finish creating this channel's campaign, so there is no spend to compare.",
  }),
  pair("campaign_stopped", "Campaign is stopped; spending pace does not apply", {
    means: "GRAV created this campaign stopped and holds no confirmed record of it running, so there is no spending pace to judge. Any spend the channel reported is in the campaign's performance report.",
  }),
  pair("running_state_unconfirmed", "GRAV has not confirmed the campaign is running", {
    means: "The campaign is recorded as started, but GRAV has not read back from the channel that it is running. Pacing waits for that confirmation rather than assuming it.",
  }),
  pair("revision_changed", "The campaign belongs to an earlier version of the plan", {
    means: "This campaign was created for an earlier approved version of the plan. Its spend is not compared with the current approved budget.",
  }),
  pair("time_zone_unknown", "The advertising account's time zone is unknown", {
    means: "GRAV cannot tell which days have elapsed without the account's time zone.",
  }),
  pair("not_started", "The schedule has not started", {
    means: "No day of the approved schedule has finished yet in the advertising account's time zone.",
  }),
  pair("no_settled_days", "No settled day yet", {
    means: "The channel's figures for the first day of the schedule are not settled yet. They settle a few days after each day ends.",
  }),
  pair("missing_days", "Some days have not been read", {
    means: "GRAV has no settled figures for some elapsed days. A day that was not read is not a day of zero spend, so GRAV will not guess the pace.",
  }),
  pair("settled_data_behind", "Settled figures are too far behind", {
    means: "The most recent settled day is too long ago for a pace to describe the campaign now. Refresh the results.",
  }),
  pair("spend_not_reported", "The channel did not report spend", {
    means: "The channel reported some settled days without a spend figure, so GRAV cannot total the spend.",
  }),
  pair("currency_precision_unsupported", "GRAV does not know this currency's minor unit", {
    means: "GRAV cannot state amounts in this currency's smallest unit correctly, so it shows no money figures rather than figures in the wrong unit.",
  }),
  pair("currency_mismatch", "The currencies do not match", {
    means: "The channel reported spend in a different currency from the approved budget. GRAV does not convert currencies.",
  }),
  pair("several_campaigns", "The plan runs in more than one channel", {
    means: "The plan's budget was given to each channel's campaign in full, and GRAV records no split between them. Each channel is paced on its own; they are not added together.",
  }),
];
const UNAVAILABLE_CODES = codes(UNAVAILABLE);

/* ── WHAT COUNTS AS EVIDENCE THAT A CAMPAIGN IS RUNNING ─────────────────────
   Both, never either:
     · GRAV's own record says it was started — deployment state `activated`;
     · the campaign object was READ BACK from the channel as delivering:
       `nonDeliveringConfirmed: false`, a read time, and the channel's own
       running word below.
   Running is never inferred from the schedule having begun or from spend
   appearing: a stopped campaign's schedule starts on its own date, and spend
   says money moved, not that the campaign GRAV recorded is the one moving it.
   `paused_confirmed` — created stopped and read back stopped — is not paced. */
const RUNNING_DEPLOYMENT_STATE = "activated";
const STOPPED_DEPLOYMENT_STATE = "paused_confirmed";
const DELIVERING_OBSERVED_STATES = freeze({
  google_ads: freeze(["ENABLED"]),
  meta_ads: freeze(["ACTIVE"]),
});

const CALCULATION = freeze({
  daily: "Expected spend so far = the daily budget × the number of elapsed, settled days.",
  total: "Expected spend so far = the total budget × elapsed, settled days ÷ days in the schedule — an even spread, because the plan records no other.",
  settled: "Only settled days count: the channel's figures for a day settle a few days after it ends. Days after the last settled day are still being counted and are not included.",
  ratio: "Pace = spend so far ÷ expected spend so far. Below 80% is under pace, above 110% is ahead of plan, and spend beyond the whole approved budget is over budget.",
  channels: "Each channel is paced separately against the plan's approved budget, which is what that channel's campaign was created with. Channels are never added together, and currencies are never converted.",
  running: "Only a campaign GRAV has confirmed is running is paced: recorded as started and read back from the channel as delivering. A stopped campaign has no spending pace, whatever it reports.",
  units: "Money is in the currency's minor unit as ISO 4217 defines it (paise, cents; none for yen; thousandths for dinar), and `minorUnitDigits` says how many decimal places that is.",
});

module.exports = freeze({
  THRESHOLDS,
  MAX_UNSETTLED_DAYS,
  VERDICTS,
  VERDICT_CODES,
  UNAVAILABLE,
  UNAVAILABLE_CODES,
  RUNNING_DEPLOYMENT_STATE,
  STOPPED_DEPLOYMENT_STATE,
  DELIVERING_OBSERVED_STATES,
  CALCULATION,
});
