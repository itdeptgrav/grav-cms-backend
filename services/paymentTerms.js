// services/paymentTerms.js
//
// Which payment terms apply to one journey, and whether they let it into
// production.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The advance % used to be typed by hand on every PO. That made it a number
// somebody remembered rather than a term the customer had agreed to, so two
// journeys for the same buyer could gate on different figures and neither was
// wrong. The standing agreement now lives on the ACCOUNT; a journey inherits
// it, and may override it for one deal — an override being a real thing that
// happens (a first order taken at 100% advance, a trusted repeat buyer let
// through at 0) and worth recording as a deviation rather than silently
// allowing.
//
// Pure and dependency-free: callers pass the account, the PO and the money
// already read from the database. That keeps the rule testable without a
// connection, and keeps "what are the terms" separate from "have we been paid",
// which are two questions that used to be tangled in one route.

/**
 * A percent that can actually be used. 0 is valid and means "no advance".
 *
 * The null/""/undefined check is not redundant: `Number(null)` and `Number("")`
 * are both 0, so an UNSET field would otherwise read as a deliberate "0% agreed"
 * — the gate behaves the same either way, but the UI would claim the customer
 * had agreed to something nobody recorded.
 */
const usablePercent = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};

/**
 * The terms in force for this journey.
 *
 * @param {object} account   CRMAccount (or null) — the standing agreement.
 * @param {object} po        journey.po — may carry a per-deal override.
 * @returns {{
 *   advancePercent: number|null,  // null = no advance agreed anywhere
 *   balanceTerms: string|null,
 *   source: "journey"|"account"|"none",
 *   accountPercent: number|null,
 *   overridden: boolean,          // journey deliberately differs from account
 * }}
 */
function resolvePaymentTerms(account, po) {
  const accountPercent = usablePercent(account?.advancePercent);
  const journeyPercent = usablePercent(po?.paymentTerms?.advancePercent);

  // The balance side stays free text. The account's own wording wins as the
  // default; `paymentTermsCode` ("NET30") is the fallback because it is what
  // most accounts actually have filled in.
  const accountBalance =
    (account?.negotiatedTerms || "").trim() ||
    [(account?.paymentTermsCode || "").trim(), account?.creditDays ? `${account.creditDays} days` : ""]
      .filter(Boolean)
      .join(" · ") ||
    null;
  const journeyBalance = (po?.paymentTerms?.balanceTerms || "").trim() || null;

  const hasJourney = journeyPercent !== null;
  const source = hasJourney ? "journey" : accountPercent !== null ? "account" : "none";

  return {
    advancePercent: hasJourney ? journeyPercent : accountPercent,
    balanceTerms: journeyBalance || accountBalance,
    source,
    accountPercent,
    // Only a DIFFERENT number is an override. Re-typing the account's own
    // figure on the PO is agreement, not deviation, and must not be flagged as
    // one — otherwise every PO that confirms the standing terms reads as an
    // exception and the flag stops meaning anything.
    overridden: hasJourney && accountPercent !== null && journeyPercent !== accountPercent,
  };
}

/**
 * Whether the advance clears. Money comes from the caller — this only decides.
 *
 * @param {object} terms       from resolvePaymentTerms
 * @param {object} money       { orderValue, received, currency }
 * @returns {{
 *   required: boolean,   // is there an advance to satisfy at all
 *   cleared: boolean,    // may production start
 *   percent, amountRequired, amountReceived, shortfall, currency,
 *   reason: string|null, // why it cannot be judged, when it cannot
 * }}
 */
function advanceGate(terms, money = {}) {
  const currency = money.currency || "INR";
  const percent = terms?.advancePercent;
  const base = Number(money.orderValue);
  const received = Number(money.received) || 0;

  const open = (extra) => ({
    required: false, cleared: true, percent: percent ?? null,
    amountRequired: 0, amountReceived: received, shortfall: 0, currency, reason: null, ...extra,
  });

  // No term agreed, or agreed at zero — nothing to hold the order for.
  if (percent === null || percent === undefined || percent === 0) return open();

  // A percentage of an unknown number is not a gate. Refusing to release on a
  // value nobody has set would block the journey on a missing quotation rather
  // than on an unpaid advance, and the message would name the wrong problem.
  if (!Number.isFinite(base) || base <= 0) {
    return open({ reason: "the order has no value yet, so the advance cannot be worked out" });
  }

  const amountRequired = (base * percent) / 100;
  const shortfall = Math.max(0, amountRequired - received);
  return {
    required: true,
    // Rounded to the rupee before comparing: a float remainder of 0.0001 on a
    // fully-paid advance is not an unpaid advance, and would be impossible for
    // anyone to clear.
    cleared: Math.round(shortfall) <= 0,
    percent,
    amountRequired,
    amountReceived: received,
    shortfall,
    currency,
    reason: null,
  };
}

module.exports = { resolvePaymentTerms, advanceGate };
