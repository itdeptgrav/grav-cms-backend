// constants/marketingPerformance.js
//
// WHAT A CAMPAIGN DID, IN GRAV'S OWN WORDS.
//
// ── THE JOB THIS VOCABULARY DOES ───────────────────────────────────────────
// A marketer should be able to open a GRAV campaign plan and see what it
// actually did, without opening Google Ads or Meta Ads Manager. Two channels
// with two different metric vocabularies have to arrive here as one set of
// facts a person can read and an intelligence layer can later consume.
//
// ── AND THE ONE THING IT MUST NEVER DO ─────────────────────────────────────
// Invent a number. Every failure mode of a reporting feature is the same shape:
// a figure that looks real and is not.
//
//   A missing metric rendered as 0 says "this campaign got no clicks" when the
//   truth is "the channel did not tell us". Those look identical on a screen
//   and lead to opposite decisions.
//
//   A partial day summed into a total makes today's spend look like a drop.
//
//   A click-through rate computed from zero impressions is a division by zero
//   dressed up as a percentage.
//
//   Two channels' spend added together in different currencies is a number
//   that is not money.
//
// Every state and rule below exists to keep one of those from happening.
"use strict";

const freeze = Object.freeze;
const pair = (code, label, extra = {}) => freeze({ code, label, ...extra });
const codes = (list) => freeze(list.map((x) => x.code));

/* ── THE METRICS GRAV KEEPS, AND WHAT EACH ONE IS ───────────────────────────
   Deliberately few. Each is a fact a channel reports about a campaign, not an
   interpretation — there is no "performance score" here and no attribution
   model of GRAV's own.

   `supplied` says whether every channel reports it. Where a channel does not,
   the value is NULL, never zero, and the reader is told which. */
const METRICS = [
  pair("impressions", "Times shown", {
    means: "How many times the advertisement appeared.",
    suppliedBy: freeze(["google_ads", "meta_ads"]),
    kind: "count",
  }),
  pair("reach", "People reached", {
    means: "How many distinct people saw it.",
    /* Google Ads does not report reach on a Search campaign. Absent is
       ABSENT — rendering it as zero would say nobody saw a campaign that
       millions of impressions say otherwise about. */
    suppliedBy: freeze(["meta_ads"]),
    kind: "count",
  }),
  pair("clicks", "Clicks", {
    means: "How many times somebody clicked.",
    suppliedBy: freeze(["google_ads", "meta_ads"]),
    kind: "count",
  }),
  pair("landingPageViews", "Page views", {
    means: "How many clicks became a loaded page. Fewer than clicks is normal — people leave before the page finishes.",
    /* Meta reports it only when a pixel is configured; Google does not report
       it at all on a Search campaign. */
    suppliedBy: freeze(["meta_ads"]),
    kind: "count",
  }),
  pair("spend", "Spent", {
    means: "What the channel charged for this campaign on this day.",
    suppliedBy: freeze(["google_ads", "meta_ads"]),
    kind: "money",
  }),
  pair("conversions", "Conversions", {
    means: "Actions the channel counted as an outcome. Each channel decides that differently, and GRAV publishes which kinds it counted.",
    suppliedBy: freeze(["google_ads", "meta_ads"]),
    /* Not an integer. Google reports fractional conversions when a conversion
       action is configured to count a fraction, and rounding them would change
       a reported figure. */
    kind: "decimal",
  }),
  pair("conversionValue", "Value of conversions", {
    means: "What the channel says those conversions were worth. Only meaningful where somebody configured a value.",
    suppliedBy: freeze(["google_ads", "meta_ads"]),
    kind: "money",
  }),
];
const METRIC_CODES = codes(METRICS);
const METRIC_BY_CODE = freeze(Object.fromEntries(METRICS.map((m) => [m.code, m])));
const MONEY_METRICS = freeze(METRICS.filter((m) => m.kind === "money").map((m) => m.code));

/* ── HOW COMPLETE ONE DAY'S ROW IS ──────────────────────────────────────────
   Three states, because two would force a lie. A day GRAV could not read and a
   day that genuinely had no activity are not the same thing, and a day that is
   still being counted is neither.

   `partial` is the one people forget. An advertising channel does not finalise
   a day's figures the moment it ends: spend is reconciled, conversions arrive
   late through attribution windows, and a figure read at noon is a figure that
   will change. Summing today into a month's total makes the month look like it
   dropped. */
const COMPLETENESS = [
  pair("complete", "Complete", {
    means: "The channel reported this day and the day is finished. These figures are settled.",
    countsTowardTotals: true,
  }),
  pair("partial", "Still being counted", {
    means: "The channel reported this day and it is not finished, or it is inside the window where late conversions still arrive. These figures will change.",
    /* Kept out of totals on purpose. A total is a claim about a settled period,
       and a reader comparing months must not be comparing a finished month
       against a half-counted one. The partial days are still RETURNED in the
       daily series, labelled — hiding them would be its own lie. */
    countsTowardTotals: false,
  }),
  pair("unavailable", "Not available", {
    means: "GRAV could not read this day. That is not the same as a day with no activity.",
    countsTowardTotals: false,
  }),
];
const COMPLETENESS_CODES = codes(COMPLETENESS);
const COUNTING_COMPLETENESS = freeze(COMPLETENESS.filter((c) => c.countsTowardTotals).map((c) => c.code));

/* ── WHY A DAY IS NOT COMPLETE ──────────────────────────────────────────────
   GRAV's own codes. A provider error message never reaches a caller. */
const INCOMPLETE_REASONS = [
  pair("day_not_finished", "The day is not over in the advertising account's timezone", {
    completeness: "partial",
  }),
  pair("attribution_window_open", "Late conversions can still arrive for this day", {
    completeness: "partial",
  }),
  pair("channel_unavailable", "The advertising channel did not answer", {
    completeness: "unavailable",
  }),
  pair("channel_refused", "The advertising connection is not allowed to read this account", {
    completeness: "unavailable",
  }),
  pair("account_not_bound", "No advertising account is bound to this company", {
    completeness: "unavailable",
  }),
  pair("account_changed", "The bound advertising account is not the one this campaign was created in", {
    completeness: "unavailable",
  }),
  pair("never_read", "GRAV has not read this day yet", {
    completeness: "unavailable",
  }),
];
const INCOMPLETE_REASON_CODES = codes(INCOMPLETE_REASONS);

/* ── HOW LONG AGO GRAV LOOKED ───────────────────────────────────────────────
   Published on every response, because a reader cannot judge a figure without
   knowing when it was true. "Nothing happened yesterday" and "GRAV has not
   looked since Tuesday" produce the same empty chart. */
const FRESHNESS = [
  pair("fresh", "Just read", { withinMinutes: 60 }),
  pair("recent", "Read today", { withinMinutes: 60 * 24 }),
  pair("stale", "Not read recently", { withinMinutes: null }),
  pair("never", "Never read", { withinMinutes: null }),
];
const FRESHNESS_CODES = codes(FRESHNESS);

/* ── THE RATIOS GRAV WILL DERIVE, AND WHEN IT WILL NOT ──────────────────────
   Each names its own numerator and denominator, so the rule "only when both
   inputs are known and the denominator is valid" is enforced from data rather
   than from three hand-written branches that will drift.

   A denominator of zero is not an error and not a zero result: it is a ratio
   that does not exist. A campaign with no impressions has no click-through
   rate — not a rate of 0% — and the difference matters to anybody deciding
   whether the creative is working or the campaign simply did not run. */
const DERIVED_RATIOS = [
  pair("ctr", "Click-through rate", {
    numerator: "clicks",
    denominator: "impressions",
    means: "How often being shown led to a click.",
    format: "ratio",
    undefinedWhenZeroDenominator: "This campaign was not shown, so there is no rate to report.",
  }),
  pair("cpc", "Cost per click", {
    numerator: "spend",
    denominator: "clicks",
    means: "What each click cost.",
    format: "money_per_unit",
    undefinedWhenZeroDenominator: "Nobody clicked, so there is no cost per click.",
  }),
  pair("cpa", "Cost per conversion", {
    numerator: "spend",
    denominator: "conversions",
    means: "What each conversion cost.",
    format: "money_per_unit",
    undefinedWhenZeroDenominator: "Nothing converted, so there is no cost per conversion.",
  }),
];
const DERIVED_RATIO_CODES = codes(DERIVED_RATIOS);

/* ── WHY A COMBINED TOTAL IS WITHHELD ───────────────────────────────────────
   A plan can be deployed to both channels. Adding their figures is sometimes
   right and sometimes produces a number that is not a number.

   Impressions add. Clicks add. Spend adds ONLY in one currency — 500 INR plus
   20 USD is not 520 of anything.

   Reach does NOT add, ever, and that one catches people: two channels reaching
   40,000 people each have reached somewhere between 40,000 and 80,000, and
   nothing in either channel's data says where. Summing it invents an audience.

   Conversions add only if both channels mean the same thing by one, and they
   do not: Google counts configured conversion actions, Meta counts a set of
   pixel and on-platform events. Summed, the figure is comparable to nothing. */
const COMBINATION_RULES = freeze({
  impressions: freeze({ combinable: true }),
  clicks: freeze({ combinable: true }),
  landingPageViews: freeze({ combinable: true }),
  spend: freeze({
    combinable: true,
    requiresSameCurrency: true,
    whyNot: "The deployments bill in different currencies, so their spend cannot be added into one figure.",
  }),
  conversionValue: freeze({
    combinable: true,
    requiresSameCurrency: true,
    whyNot: "The deployments report value in different currencies, so it cannot be added into one figure.",
  }),
  reach: freeze({
    combinable: false,
    whyNot: "Reach counts people, and the same person can be reached on both channels. Adding the two figures would invent an audience nobody can verify.",
  }),
  conversions: freeze({
    combinable: false,
    whyNot: "Each channel decides for itself what counts as a conversion, so the two figures do not measure the same thing and adding them produces a number comparable to nothing.",
  }),
});

/* ── MONEY ──────────────────────────────────────────────────────────────────
   Stored twice, on purpose, and this is worth reading before changing.

   `spendMinorUnits` is what the contract asks for and what a reader wants:
   paise, cents, an integer.

   `spendMicros` is the exact figure the channel reported. Google reports cost
   in micros — a millionth of the currency unit — and `1_234_567` micros is
   `123.4567` minor units. Rounding that on the way in throws away a fraction
   of a paisa per day, and a month of rounding is a real discrepancy against
   the channel's own invoice.

   So the exact value is kept, totals are summed in micros, and the rounding
   happens ONCE at presentation. */
const MONEY = freeze({
  MICROS_PER_MINOR_UNIT: 10000,
  MICROS_PER_MAJOR_UNIT: 1000000,
  MINOR_UNITS_PER_MAJOR: 100,
});

/* ── WHAT IS NOT STORED, AND WHY ────────────────────────────────────────────
   Raw channel responses. The brief allows keeping them only if this repository
   already has an approved ENCRYPTED DIAGNOSTIC pattern, and it does not:
   `utils/salaryEncryption.js` is scoped in its own header to "Employee model
   salary fields only", keyed on `SALARY_ENCRYPTION_KEY`, and reusing that key
   for advertising diagnostics would be exactly the key-reuse mistake every
   other signing purpose in Marketing was careful to avoid.

   A raw advertising response is also not innocuous: it carries account
   identifiers, and Google's error envelopes carry request fragments. Storing
   it unencrypted would put that in every backup.

   So the normalised facts are stored and the raw body is not. A failed read is
   logged server-side with its real status and operation, which is where a
   technical operator looks anyway. */
const RAW_RESPONSE_POLICY = freeze({
  stored: false,
  why: "GRAV has no approved encrypted diagnostic store, and an advertising response carries account identifiers. The normalised facts are kept; the raw body is logged server-side and discarded.",
});

const PERFORMANCE_CODES = freeze({
  DEPLOYMENT_NOT_FOUND: "DEPLOYMENT_NOT_FOUND",
  NO_EXTERNAL_CAMPAIGN: "NO_EXTERNAL_CAMPAIGN",
  ACCOUNT_CHANGED: "ACCOUNT_CHANGED",
  RANGE_INVALID: "RANGE_INVALID",
  RANGE_TOO_LONG: "RANGE_TOO_LONG",
  CHANNEL_UNSUPPORTED: "CHANNEL_UNSUPPORTED",
});

/* A read window somebody can hold in their head, and a bound on how much a
   single request can ask an advertising channel for. */
const RANGE = freeze({ MAX_DAYS: 400, DEFAULT_DAYS: 30 });

module.exports = freeze({
  METRICS,
  METRIC_CODES,
  METRIC_BY_CODE,
  MONEY_METRICS,

  COMPLETENESS,
  COMPLETENESS_CODES,
  COUNTING_COMPLETENESS,
  INCOMPLETE_REASONS,
  INCOMPLETE_REASON_CODES,

  FRESHNESS,
  FRESHNESS_CODES,

  DERIVED_RATIOS,
  DERIVED_RATIO_CODES,
  COMBINATION_RULES,

  MONEY,
  RAW_RESPONSE_POLICY,
  PERFORMANCE_CODES,
  RANGE,
});
