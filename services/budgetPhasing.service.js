// services/budgetPhasing.service.js
//
// HOW A BUDGET LINE'S ONE NUMBER DIVIDES ACROSS THE MONTHS IT COVERS.
//
// A budget states one figure for a period. Every "are we on pace" question in
// this module — the plan line on the months chart, `expectedToDate`, the MTD
// and YTD figures — needs that figure spread over months, and until now the
// only spread available was EVEN. That is the wrong shape for most of this
// business: a garment exporter earns its year in March-May, marketing spends
// against a festival, bonus lands in one month, and straight-lining any of
// them makes every month until the spike read as a miss and the spike itself
// read as a breach.
//
// ── PURE, AND DELIBERATELY THE ONLY PLACE THIS IS DECIDED ───────────────────
// No Mongo, no clock, no HTTP. It exists so the chart's plan line and a line's
// `expectedToDate` cannot tell different stories: both call `plannedByMonth`.
// They previously each did their own spreading — `monthWeights` in the route
// and a bucket walk in budgetVariance — and the two only agreed because both
// happened to be even.
//
// ── THREE SHAPES, IN PRECEDENCE ORDER ───────────────────────────────────────
//   1. `custom_monthly` + `monthlyPhasing[{month,amount}]` — absolute rupees
//      per calendar month. What this chunk adds, and what a department
//      actually knows: "we bill 40L in March", not "March is weight 3".
//   2. `phasing: [Number]` — the legacy positional weights, any scale, one per
//      equal bucket of the period. Rows written before this chunk carry it and
//      must keep reading exactly as they did.
//   3. Neither — even spread. The default, and what almost every row uses.
//
// ── WHY ABSOLUTE AMOUNTS AND NOT WEIGHTS ────────────────────────────────────
// Weights cannot be validated against anything. "Is 3,1,1,1 right?" has no
// answer, whereas "do these twelve figures add up to the 1.6Cr that was
// approved?" has exactly one, and it is the question finance asks. Absolute
// amounts also survive an amount revision honestly: change the approved figure
// and the stored split no longer sums, which is a mismatch we can refuse
// rather than silently rescale into a shape nobody agreed.

const IST = "Asia/Kolkata";

/** Two decimals, or null when the value is not a finite number. */
function money(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

/** "2026-04" for a date, in IST. Matches the dashboard's own bucket key —
 *  a UTC key drifts a month at the boundary, and the boundary is 1 April,
 *  which is where every Indian financial year starts. */
function monthKey(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
  }).format(dt);
}

/** Is this a well-formed "YYYY-MM"? Rejects "2026-13" and "2026-4" alike. */
function isMonthKey(v) {
  return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/**
 * Every IST month key a period touches, in order.
 *
 * Stepped in days rather than months so `setMonth` cannot skip February from a
 * 31st, and capped so a corrupt range cannot spin. Same walk the dashboard
 * uses, kept identical on purpose.
 */
function monthsInPeriod(startDate, endDate) {
  if (!startDate || !endDate) return [];
  const start = startDate instanceof Date ? startDate : new Date(startDate);
  const end = endDate instanceof Date ? endDate : new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  if (end < start) return [];

  const out = [];
  const seen = new Set();
  const cursor = new Date(start);
  while (cursor <= end && out.length < 120) {
    const key = monthKey(cursor);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 15);
  }
  const endKey = monthKey(end);
  if (endKey && !seen.has(endKey)) out.push(endKey);
  return out;
}

class PhasingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PhasingError";
    this.code = code;
  }
}

/** A rupee of slack on the sum check. Twelve rounded months cannot be trusted
 *  to add back to the cent, and refusing a split for half a paisa would be a
 *  control nobody can satisfy. */
const SUM_TOLERANCE = 1;

/**
 * Validate and normalise a phasing input.
 *
 * Returns `{ phasingMode, monthlyPhasing }` ready to store. Throws
 * `PhasingError` with a code the route maps to a 400 — every message names the
 * offending month, because "invalid phasing" on a twelve-row form is not a
 * thing anyone can act on.
 *
 * `amount` is the approved allocation or the agreed target. Both natures use
 * this identically: an expense plan and a revenue target are the same
 * arithmetic, and making phasing sales-only would leave every seasonal cost
 * straight-lined.
 */
function normalisePhasing({ phasingMode, monthlyPhasing, amount, startDate, endDate } = {}) {
  const mode = phasingMode === "custom_monthly" ? "custom_monthly" : "even";

  if (mode === "even") {
    // An even line stores no split. Keeping a stale one around would leave a
    // shape that silently reactivates if the mode is ever flipped back.
    return { phasingMode: "even", monthlyPhasing: [] };
  }

  if (!Array.isArray(monthlyPhasing) || monthlyPhasing.length === 0) {
    throw new PhasingError(
      "PHASING_EMPTY",
      "A custom monthly split needs at least one month. Choose an even spread instead if the plan is flat.",
    );
  }

  const allowed = monthsInPeriod(startDate, endDate);
  if (allowed.length === 0) {
    throw new PhasingError(
      "PHASING_NO_PERIOD",
      "This line has no usable period, so a monthly split cannot be checked against it.",
    );
  }
  const allowedSet = new Set(allowed);

  const seen = new Set();
  const rows = [];
  for (const raw of monthlyPhasing) {
    const month = raw?.month;
    if (!isMonthKey(month)) {
      throw new PhasingError(
        "PHASING_BAD_MONTH",
        `"${month}" is not a month. Use the YYYY-MM form, like "${allowed[0]}".`,
      );
    }
    if (!allowedSet.has(month)) {
      throw new PhasingError(
        "PHASING_OUTSIDE_PERIOD",
        `${month} is outside this line's period (${allowed[0]} to ${allowed[allowed.length - 1]}).`,
      );
    }
    if (seen.has(month)) {
      throw new PhasingError("PHASING_DUPLICATE_MONTH", `${month} appears twice in the split.`);
    }
    seen.add(month);

    const value = money(raw?.amount);
    if (value === null) {
      throw new PhasingError("PHASING_BAD_AMOUNT", `${month} has no usable amount.`);
    }
    if (value < 0) {
      throw new PhasingError(
        "PHASING_NEGATIVE",
        `${month} is negative. A month can be zero, but a plan cannot un-spend.`,
      );
    }
    rows.push({ month, amount: value });
  }

  const total = money(amount);
  if (total === null) {
    throw new PhasingError(
      "PHASING_NO_AMOUNT",
      "A monthly split needs an approved amount to be checked against.",
    );
  }

  const sum = money(rows.reduce((s, r) => s + r.amount, 0)) ?? 0;
  if (Math.abs(sum - total) > SUM_TOLERANCE) {
    throw new PhasingError(
      "PHASING_SUM_MISMATCH",
      `The monthly split adds up to ${sum}, but the approved amount is ${total}. They have to match.`,
    );
  }

  // Stored in period order rather than the order the form sent them, so a
  // stored document reads down the year.
  rows.sort((a, b) => allowed.indexOf(a.month) - allowed.indexOf(b.month));
  return { phasingMode: "custom_monthly", monthlyPhasing: rows };
}

/**
 * How one line's amount divides across the months it covers.
 *
 * THE single spreading rule for this module. Returns a Map of "YYYY-MM" →
 * rupees, covering every month of the period — including the ones a custom
 * split left out, which are zero rather than absent, so a caller can iterate
 * the period without checking for holes.
 */
function plannedByMonth({
  amount,
  startDate,
  endDate,
  phasingMode,
  monthlyPhasing,
  phasing,
} = {}) {
  const months = monthsInPeriod(startDate, endDate);
  const out = new Map(months.map((m) => [m, 0]));
  const total = money(amount) ?? 0;
  if (!months.length || total === 0) return out;

  /* 1. A stored custom split is used as-is. It is absolute rupees that someone
        agreed, so it is NOT rescaled to the amount — if the two disagree the
        write path should have refused it, and quietly stretching the numbers
        here would hide that. Months outside the split stay at zero. */
  if (phasingMode === "custom_monthly" && Array.isArray(monthlyPhasing) && monthlyPhasing.length) {
    for (const row of monthlyPhasing) {
      const value = money(row?.amount);
      if (value === null || value < 0) continue;
      if (out.has(row.month)) out.set(row.month, value);
    }
    return out;
  }

  /* 2. Legacy positional weights: equal buckets over the period, each month
        mapped onto the bucket it sits in. Preserved exactly so rows written
        before this chunk keep their shape. */
  const weights = Array.isArray(phasing)
    ? phasing.map((w) => money(w)).filter((w) => w !== null && w >= 0)
    : [];
  const weightTotal = weights.reduce((s, w) => s + w, 0);
  if (weights.length && weightTotal > 0) {
    months.forEach((m, i) => {
      const idx = Math.min(weights.length - 1, Math.floor((i / months.length) * weights.length));
      const share = weights[idx] / weightTotal / (months.length / weights.length);
      out.set(m, total * share);
    });
    return out;
  }

  /* 3. Even. The default and the overwhelming majority of rows. */
  const share = total / months.length;
  for (const m of months) out.set(m, share);
  return out;
}

/**
 * What fraction of `key`'s month has elapsed at `asOf`, in IST.
 *
 * 0 before the month, 1 after it, and the day proportion inside it — so a
 * pace figure read on the 10th of a 30-day month expects a third of that
 * month's plan rather than all of it or none of it. Without this, every
 * mid-month reading of a phased line reports a miss on the day the month
 * turns over.
 */
function monthElapsedFraction(key, asOf) {
  if (!isMonthKey(key)) return 0;
  const now = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(now.getTime())) return 0;

  const nowKey = monthKey(now);
  if (!nowKey) return 0;
  if (nowKey > key) return 1;
  if (nowKey < key) return 0;

  /* Inside the month. Day-of-month and day-count are both read in IST so the
     fraction cannot jump at 18:30 UTC, which is IST midnight. */
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const day = Number(parts.slice(8, 10));
  const [y, m] = key.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (!Number.isFinite(day) || !daysInMonth) return 0;
  return Math.max(0, Math.min(1, day / daysInMonth));
}

/**
 * What this line is expected to have reached by `asOf`, from its phasing.
 *
 * Whole months that have passed count in full; the month we are inside counts
 * by day proportion; months still ahead count nothing. This is the MTD/YTD
 * primitive — `expectedToDate` for the year, and `plannedByMonth.get(thisMonth)`
 * for the month.
 */
function expectedToDate({
  amount,
  startDate,
  endDate,
  asOf,
  phasingMode,
  monthlyPhasing,
  phasing,
} = {}) {
  const total = money(amount);
  if (total === null) return null;
  const byMonth = plannedByMonth({
    amount: total,
    startDate,
    endDate,
    phasingMode,
    monthlyPhasing,
    phasing,
  });
  if (byMonth.size === 0) return null;

  let cum = 0;
  for (const [key, value] of byMonth) cum += value * monthElapsedFraction(key, asOf);
  return money(cum);
}

/**
 * The month-to-date and year-to-date pair a screen actually prints.
 *
 * `actualToDate` is passed in rather than computed — actuals matching is not
 * this file's business and did not change.
 */
function paceToDate({
  amount,
  startDate,
  endDate,
  asOf,
  phasingMode,
  monthlyPhasing,
  phasing,
  actualToDate = null,
  actualThisMonth = null,
} = {}) {
  const byMonth = plannedByMonth({ amount, startDate, endDate, phasingMode, monthlyPhasing, phasing });
  const nowKey = monthKey(asOf instanceof Date ? asOf : new Date(asOf));

  const plannedThisMonth = nowKey && byMonth.has(nowKey) ? byMonth.get(nowKey) : null;
  const expected = expectedToDate({
    amount,
    startDate,
    endDate,
    asOf,
    phasingMode,
    monthlyPhasing,
    phasing,
  });

  return {
    month: nowKey,
    plannedThisMonth: plannedThisMonth === null ? null : money(plannedThisMonth),
    expectedToDate: expected,
    actualThisMonth: money(actualThisMonth),
    actualToDate: money(actualToDate),
    /* Signed so POSITIVE MEANS AHEAD OF PLAN for revenue and UNDER PLAN for
       expense is decided by the caller that knows the nature — this file
       reports the gap, not the verdict. */
    gapToDate:
      expected === null || money(actualToDate) === null ? null : money(money(actualToDate) - expected),
  };
}

/** An even split as an explicit month list — what the phasing editor opens
 *  with, so a department edits real numbers rather than an empty grid. */
function evenSplit({ amount, startDate, endDate } = {}) {
  const byMonth = plannedByMonth({ amount, startDate, endDate });
  return [...byMonth.entries()].map(([month, value]) => ({ month, amount: money(value) ?? 0 }));
}

module.exports = {
  PhasingError,
  SUM_TOLERANCE,
  monthKey,
  isMonthKey,
  monthsInPeriod,
  normalisePhasing,
  plannedByMonth,
  monthElapsedFraction,
  expectedToDate,
  paceToDate,
  evenSplit,
};
