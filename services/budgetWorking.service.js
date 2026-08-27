/**
 * GRAV-CMS-BACKEND/services/budgetWorking.service.js
 *
 * The line-by-line calculation behind a proposed amount.
 *
 * ── WHY A NUMBER NEEDS A DERIVATION ─────────────────────────────────────────
 * "Software subscriptions: ₹6,60,000" is not reviewable. Finance can only
 * agree it, refuse it, or guess. The same ask written as
 *
 *     Claude Team      5 users × ₹6,000 × 12 months = ₹3,60,000
 *     Codex usage      1 × ₹20,000 × 12 months      = ₹2,40,000
 *     Copilot          5 users × ₹1,000 × 12 months = ₹60,000
 *
 * can be argued with a line at a time, and the counter-offer can say WHICH
 * line was too high. That is the whole point: the total is a consequence, not
 * an opinion.
 *
 * ── WHY THE SERVER RECOMPUTES ───────────────────────────────────────────────
 * Every non-manual row's `amount` is recalculated here from quantity × rate ×
 * multiplier, and the client's own figure is discarded. A browser that sends
 * `{quantity: 5, rate: 6000, multiplier: 12, amount: 99}` is either broken or
 * lying, and either way storing 99 would put a budget line in the books whose
 * arithmetic does not hold. The recomputed rows are what get stored, so the
 * document can always be re-derived from its own inputs.
 *
 * A row that genuinely does not fit the quantity × rate × multiplier shape —
 * a negotiated lump sum, a quoted figure — may carry `manualAmount: true` and
 * state its own amount. It is marked, so a reviewer can see which numbers were
 * computed and which were asserted.
 */

/** A refusal a caller can turn into a 400 with a code. */
class WorkingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkingError";
    this.code = code;
  }
}

/** The same ±1 the phasing service allows, and for the same reason: a split
 *  of thirds cannot land exactly on a rupee. */
const SUM_TOLERANCE = 1;

/** At most this many rows. A breakdown longer than this is a spreadsheet, and
 *  storing an unbounded array inside a budget document is how one request
 *  makes the whole cycle slow to load. */
const MAX_LINES = 60;

/** Two decimal places, or null when the value cannot be a number at all. */
function money(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

/** A short trimmed string, or undefined. Length-capped so a pasted essay
 *  cannot bloat every read of the cycle. */
function text(v, max = 160) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  return s.slice(0, max);
}

/**
 * Validate and recompute one breakdown.
 *
 * Returns `{ lines, total }` with every non-manual row's amount re-derived.
 * Throws WorkingError on anything that cannot be stored honestly.
 */
/** `YYYY-MM`, the same month key the line-level phasing uses. */
const isMonthKey = (v) => typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/**
 * One row's month-wise amounts.
 *
 * Returns null when the row carries none — which is the ordinary case and must
 * stay indistinguishable from how rows behaved before this existed. Returns a
 * cleaned list otherwise, dropping zero months so a row states the months it
 * actually uses rather than twelve entries mostly reading nothing.
 */
function normaliseRowMonths(raw, at) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    throw new WorkingError("WORKING_MONTHS_NOT_A_LIST", `${at}'s monthly amounts have to be a list.`);
  }
  if (!raw.length) return null;

  const seen = new Set();
  const rows = [];
  for (const entry of raw) {
    const month = entry?.month;
    if (!isMonthKey(month)) {
      throw new WorkingError(
        "WORKING_MONTH_BAD",
        `${at} has "${month}" where a month like "2026-04" belongs.`,
      );
    }
    if (seen.has(month)) {
      throw new WorkingError("WORKING_MONTH_DUPLICATE", `${at} lists ${month} twice.`);
    }
    seen.add(month);

    const amount = money(entry?.amount) ?? 0;
    if (amount < 0) {
      throw new WorkingError(
        "WORKING_NEGATIVE",
        `${at} has a negative amount in ${month}. A month can be zero, but not less.`,
      );
    }
    if (amount > 0) rows.push({ month, amount });
  }

  /* Every month zero is the same as no months at all — storing twelve zeroes
     would claim a month-wise plan that plans nothing. */
  return rows.length ? rows : null;
}

function normaliseWorkingLines(workingLines) {
  if (workingLines === undefined || workingLines === null) return { lines: [], total: null };
  if (!Array.isArray(workingLines)) {
    throw new WorkingError("WORKING_NOT_A_LIST", "The working breakdown has to be a list of rows.");
  }
  if (workingLines.length === 0) return { lines: [], total: null };
  if (workingLines.length > MAX_LINES) {
    throw new WorkingError(
      "WORKING_TOO_MANY_LINES",
      `A breakdown can have at most ${MAX_LINES} rows. Group the smaller items together.`,
    );
  }

  const lines = [];
  for (const [i, raw] of workingLines.entries()) {
    const at = `Row ${i + 1}`;
    const label = text(raw?.label);
    if (!label) {
      throw new WorkingError("WORKING_NO_LABEL", `${at} has no name. Say what the line is for.`);
    }

    const manual = raw?.manualAmount === true;

    /* ── A ROW THAT IS ITSELF MONTH-WISE ────────────────────────────────────
     * A month-wise line does not describe "5 seats at ₹10,000 for 12 months";
     * it describes what each item costs in each month, which is a different
     * and often more honest shape — a campaign is not the same number every
     * month, and flattening it to a quantity and a rate throws that away.
     *
     * The row's amount is then the sum of its own months, exactly as a
     * quantity row's amount is the product of its own inputs. The client's
     * `amount` is ignored here for the same reason it is ignored there: a
     * stored total that disagrees with its own inputs is not a derivation.
     *
     * Additive and optional. A row without `monthly` behaves precisely as it
     * always has, so every existing proposal reads unchanged. */
    const monthly = normaliseRowMonths(raw?.monthly, at);

    /* A number the row did not send is 1 for the multipliers and 0 for money,
       so a row that only fills in a rate still computes something sensible
       rather than collapsing to NaN. */
    const quantity = manual ? money(raw?.quantity) ?? 0 : money(raw?.quantity) ?? 1;
    const rate = manual ? money(raw?.rate) ?? 0 : money(raw?.rate) ?? 0;
    const multiplier = manual ? money(raw?.multiplier) ?? 0 : money(raw?.multiplier) ?? 1;

    for (const [name, value] of [
      ["quantity", quantity],
      ["rate", rate],
      ["multiplier", multiplier],
    ]) {
      if (value < 0) {
        throw new WorkingError(
          "WORKING_NEGATIVE",
          `${at} has a negative ${name}. A line can be zero, but not less.`,
        );
      }
    }

    let amount;
    if (monthly) {
      amount = money(monthly.reduce((sum, m) => sum + m.amount, 0)) ?? 0;
    } else if (manual) {
      amount = money(raw?.amount);
      if (amount === null) {
        throw new WorkingError(
          "WORKING_NO_MANUAL_AMOUNT",
          `${at} is set to a manual amount but has no amount on it.`,
        );
      }
      if (amount < 0) {
        throw new WorkingError("WORKING_NEGATIVE", `${at} has a negative amount.`);
      }
    } else {
      /* The client's `amount` is deliberately not read here. See the header. */
      amount = money(quantity * rate * multiplier) ?? 0;
    }

    lines.push({
      label,
      description: text(raw?.description, 300),
      quantity,
      unit: text(raw?.unit, 32),
      rate,
      multiplier,
      multiplierUnit: text(raw?.multiplierUnit, 32),
      amount,
      manualAmount: manual,
      ...(monthly ? { monthly } : {}),
    });
  }

  const total = money(lines.reduce((s, l) => s + l.amount, 0)) ?? 0;
  return { lines, total };
}

/**
 * Reconcile the asked-for amount against what the breakdown adds up to.
 *
 * A breakdown that does not sum to the ask is the single most damaging thing
 * this feature could store: it looks like a derivation, reads like a
 * derivation, and is not one. So it is refused — unless the person says
 * explicitly that the total is deliberate and why, which is a different and
 * defensible claim ("the quote covers the first year; I am asking for the
 * whole contract").
 */
function reconcileAmount({
  total,
  requestedAmount,
  manualAmountOverride = false,
  manualOverrideReason,
}) {
  // No breakdown, nothing to reconcile here.
  //
  // A department PROPOSAL should show its working — "30 containers at ₹12,000"
  // is a case, "₹4,50,000" is a number, and finance reviews the first. That
  // rule lives in the proposal FORM rather than here, deliberately: this same
  // function serves adjustments and transfers, and a request for a head the
  // chart of accounts does not have yet legitimately arrives as a figure with
  // an explanation rather than a row-by-row derivation. Enforcing it here
  // refused all of those too.
  if (total === null) {
    // Nothing to reconcile. The amount stands on its own.
    return { manualAmountOverride: false, manualOverrideReason: undefined };
  }

  const asked = money(requestedAmount);
  if (asked === null) {
    throw new WorkingError(
      "WORKING_NO_AMOUNT",
      "A breakdown needs a requested amount to be checked against.",
    );
  }

  if (Math.abs(asked - total) <= SUM_TOLERANCE) {
    /* It matches, so an override would be a claim about a disagreement that
       does not exist. Dropped rather than stored — a stale "manual override"
       flag on a line that reconciles perfectly is a lie about its own history. */
    return { manualAmountOverride: false, manualOverrideReason: undefined };
  }

  if (!manualAmountOverride) {
    throw new WorkingError(
      "WORKING_SUM_MISMATCH",
      `The breakdown adds up to ${total}, but the amount asked for is ${asked}. Either fix the rows, use the breakdown total, or say why the two differ.`,
    );
  }

  const reason = text(manualOverrideReason, 500);
  if (!reason) {
    throw new WorkingError(
      "WORKING_OVERRIDE_NO_REASON",
      "An amount that differs from its own breakdown needs a reason finance can read.",
    );
  }

  return { manualAmountOverride: true, manualOverrideReason: reason };
}

/**
 * One line of prose describing a breakdown, for a budget line's notes.
 * Deliberately short: the request stays the audit source for the detail.
 */
function summarise({ purpose, lines = [], total = null }) {
  const parts = [];
  const why = text(purpose, 200);
  if (why) parts.push(why);
  if (lines.length) {
    const named = lines
      .slice(0, 3)
      .map((l) => l.label)
      .join(", ");
    const more = lines.length > 3 ? ` +${lines.length - 3} more` : "";
    parts.push(`Built from ${lines.length} line${lines.length === 1 ? "" : "s"}: ${named}${more}.`);
  }
  if (total !== null && lines.length) parts.push(`Breakdown total ${total}.`);
  return parts.join(" ") || undefined;
}

module.exports = {
  normaliseRowMonths,
  WorkingError,
  SUM_TOLERANCE,
  MAX_LINES,
  money,
  normaliseWorkingLines,
  reconcileAmount,
  summarise,
};
