/**
 * GRAV-CMS-BACKEND/services/partyTermsImpact.service.js
 *
 * CHUNK 1-F — which parties are worth giving real credit terms, and what
 * happens to their forecast dates if you do. PURE: no Mongo, no clock, no HTTP.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Chunk 1-B measured it: 100% of the projected open-item dates come from one
 * blanket company default, and a single counterparty carries 60% of projected
 * inflow. The forecast is auditable but distorted — a flat 46 days applied to
 * every bill invents date clusters that no real payment behaviour produced.
 * Fixing that means giving the parties that matter their actual negotiated
 * terms, and this file works out which parties those are and what changes.
 *
 * ── PREVIEW NEVER WRITES ────────────────────────────────────────────────────
 * Nothing in this file mutates anything, and the preview path deliberately
 * shows the change BEFORE it happens. Editing a party's terms must not
 * silently rewrite history: a person should see "these 29 bills move from 15
 * Jul to 20 Aug" and decide, rather than discover it afterwards.
 */

const { resolveDueDate } = require("./creditTerms.service");

/** Nobody negotiates more than a year; matches `creditTerms.MAX_CREDIT_DAYS`. */
const MAX_CREDIT_DAYS = 365;

/**
 * Why a bill cannot be recalculated from new party terms.
 *
 * Each is a REFUSAL to touch something, not a failure. A blocked row is still
 * returned and still shown — the point of the preview is that a person sees
 * everything that would and would not move.
 */
const BLOCKED = Object.freeze({
  MANUAL_SIDECAR: "manual_sidecar",
  MANUAL_EXPECTED_DATE: "manual_expected_date",
  NOT_COMPANY_DEFAULT: "not_company_default_derived",
  NO_BASIS_DATE: "no_basis_date",
  NO_PROPOSED_TERM: "no_proposed_term",
});

const BLOCKED_LABEL = Object.freeze({
  [BLOCKED.MANUAL_SIDECAR]: "Manual bill terms — a person set this date",
  [BLOCKED.MANUAL_EXPECTED_DATE]: "Has a manual expected date",
  [BLOCKED.NOT_COMPANY_DEFAULT]: "Not derived from the company default",
  [BLOCKED.NO_BASIS_DATE]: "No voucher date to derive from",
  [BLOCKED.NO_PROPOSED_TERM]: "No proposed term — 0 means unset",
});

class PartyTermsImpactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PartyTermsImpactError";
    this.code = code;
  }
}

/**
 * A proposed credit-days value: an integer 0..365.
 *
 * 0 is ACCEPTED as input and means "unset" — the same rule the rest of C0
 * runs on — but a proposal of 0 can derive nothing, so every row comes back
 * blocked with `no_proposed_term` rather than the call being refused. Seeing
 * that is more useful than an error: it answers "what if we cleared this?".
 */
function parseProposedDays(value) {
  if (value === null || value === undefined || value === "") {
    throw new PartyTermsImpactError("REQUIRED", "proposedCreditPeriodDays is required.");
  }
  if (typeof value === "boolean" || (typeof value === "object" && value !== null)) {
    throw new PartyTermsImpactError(
      "INVALID_TYPE",
      "proposedCreditPeriodDays must be a number.",
    );
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new PartyTermsImpactError("INVALID_TYPE", "proposedCreditPeriodDays must be a number.");
  }
  if (!Number.isInteger(n)) {
    throw new PartyTermsImpactError(
      "NOT_INTEGER",
      "proposedCreditPeriodDays must be a whole number of days.",
    );
  }
  if (n < 0 || n > MAX_CREDIT_DAYS) {
    throw new PartyTermsImpactError(
      "OUT_OF_RANGE",
      `proposedCreditPeriodDays must be between 0 and ${MAX_CREDIT_DAYS}.`,
    );
  }
  return n;
}

/** Whole days between two dates, positive when `b` is later. */
function daysBetween(a, b) {
  if (!a || !b) return null;
  const d1 = new Date(a);
  const d2 = new Date(b);
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
  return Math.round(
    (Date.UTC(d2.getUTCFullYear(), d2.getUTCMonth(), d2.getUTCDate()) -
      Date.UTC(d1.getUTCFullYear(), d1.getUTCMonth(), d1.getUTCDate())) /
      86400000,
  );
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Rank parties by how much of the forecast their blanket-default dates
 * distort.
 *
 * ── WHY THIS ORDER ──────────────────────────────────────────────────────────
 * Company-default-derived AMOUNT first, total projected amount second. The
 * question this list answers is "where would real terms change the forecast
 * most", and that is money currently sitting on an invented date — not simply
 * the biggest customer. A party whose bills already carry explicit due dates
 * needs no attention however large it is.
 */
function rankParties(parties = []) {
  return (parties || [])
    .slice()
    .sort(
      (a, b) =>
        (b.companyDefaultDerivedAmount || 0) - (a.companyDefaultDerivedAmount || 0) ||
        (b.projectedAmount || 0) - (a.projectedAmount || 0) ||
        String(a.ledgerName || "").localeCompare(String(b.ledgerName || "")),
    );
}

/**
 * A short, factual reason this party is worth looking at.
 *
 * Descriptive, never prescriptive: it states what is true of the party's
 * bills, not what the terms "should" be. Suggesting a number would be
 * inventing a negotiated term, which is exactly what this chunk exists to
 * stop the company default from doing.
 */
function suggestedPriorityReason(p) {
  const bits = [];
  if (p.companyDefaultDerivedCount > 0) {
    bits.push(
      `${p.companyDefaultDerivedCount} bill${p.companyDefaultDerivedCount === 1 ? "" : "s"} dated from the company default`,
    );
  }
  const top = (p.topDates || [])[0];
  if (top && top.count > 1) {
    bits.push(`${top.count} land on ${String(top.date).slice(0, 10)}`);
  }
  if (p.overdueCount > 0) {
    bits.push(`${p.overdueCount} already overdue`);
  }
  if (p.manualExpectedDateCount > 0) {
    bits.push(`${p.manualExpectedDateCount} with a manual expected date`);
  }
  return bits.join(" · ") || "No company-default-derived bills";
}

/**
 * What changing one party's credit terms would do to its open bills.
 *
 * @param {object} input
 * @param {Array} input.bills — open bills for this party, each
 *   `{ billName, amount, basisDate, currentDueDate, source, isManualSidecar,
 *      hasManualExpectedDate }`
 * @param {number} input.proposedDays — already validated
 * @returns {{rows: Array, totals: object}}
 */
function buildPreview({ bills = [], proposedDays = 0 } = {}) {
  const rows = (bills || []).map((b) => {
    const amount = Math.abs(Number(b.amount) || 0);

    // Derived through `creditTerms.resolveDueDate`, the same function C0-F's
    // planner uses, so a previewed date and the date an apply would actually
    // write can never come from two different arithmetics.
    const proposedDueDate =
      proposedDays > 0 && b.basisDate
        ? resolveDueDate({
            voucherDate: b.basisDate,
            partyLedger: { creditPeriodDays: proposedDays },
          })
        : null;

    // ── What may be recalculated, and what is refused ───────────────────────
    // Order matters: the strongest protection is checked first, so a manual
    // row reports that it is manual rather than some incidental reason.
    let blockedReason = null;
    if (b.isManualSidecar) {
      blockedReason = BLOCKED.MANUAL_SIDECAR;
    } else if (b.hasManualExpectedDate) {
      // A deliberate refusal, not an oversight. The expected date was
      // recorded about a bill someone judged OVERDUE; moving its due date
      // underneath changes its age and can stop it being overdue at all, at
      // which point Chunk 1-C ignores the expectation entirely. That is a
      // real semantic change and belongs in front of a person, not inside a
      // bulk recalculation. Surfaced, never silently applied.
      blockedReason = BLOCKED.MANUAL_EXPECTED_DATE;
    } else if (b.source !== "company_default") {
      // An explicit or voucher-header date is a STATED fact and outranks any
      // derivation; a party_terms row is already what this chunk is trying to
      // produce. Neither is the blanket default this workflow targets.
      blockedReason = BLOCKED.NOT_COMPANY_DEFAULT;
    } else if (!b.basisDate) {
      blockedReason = BLOCKED.NO_BASIS_DATE;
    } else if (proposedDays <= 0) {
      blockedReason = BLOCKED.NO_PROPOSED_TERM;
    }

    return {
      billName: b.billName || null,
      amount: round2(amount),
      basisDate: b.basisDate || null,
      currentDueDate: b.currentDueDate || null,
      proposedDueDate,
      deltaDays: daysBetween(b.currentDueDate, proposedDueDate),
      source: b.source || null,
      canRecalculate: blockedReason === null,
      blockedReason,
      blockedLabel: blockedReason ? BLOCKED_LABEL[blockedReason] : null,
    };
  });

  const recalculable = rows.filter((r) => r.canRecalculate);
  const blocked = rows.filter((r) => !r.canRecalculate);

  const recalculableAmount = recalculable.reduce((s, r) => s + r.amount, 0);

  // Weighted by amount, not a plain average: a ₹30L bill moving 40 days
  // matters far more to the cash line than a ₹300 one moving 40 days, and an
  // unweighted mean would report them as the same shift.
  const weightedShift =
    recalculableAmount > 0
      ? recalculable.reduce((s, r) => s + r.amount * (r.deltaDays || 0), 0) / recalculableAmount
      : 0;

  return {
    rows,
    totals: {
      recalculableCount: recalculable.length,
      recalculableAmount: round2(recalculableAmount),
      blockedCount: blocked.length,
      blockedAmount: round2(blocked.reduce((s, r) => s + r.amount, 0)),
      netDateShiftDaysWeighted: Math.round(weightedShift * 10) / 10,
    },
  };
}

module.exports = {
  MAX_CREDIT_DAYS,
  BLOCKED,
  BLOCKED_LABEL,
  PartyTermsImpactError,
  parseProposedDays,
  daysBetween,
  rankParties,
  suggestedPriorityReason,
  buildPreview,
};
