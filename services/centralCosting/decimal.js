// services/centralCosting/decimal.js
//
// Central Costing — Chunk 2. EXACT ARITHMETIC, AND WHERE IT IS ALLOWED TO STOP.
//
// ── TWO KINDS OF NUMBER, TWO DIFFERENT RULES ────────────────────────────────
// Money is an INTEGER count of minor units. It is stored that way, compared
// that way and reported that way — see money.js.
//
// Quantities, consumptions and percentages are NOT integers and never will be:
// 0.42 metres of fabric, 1.8 minutes of SAM, 12.5% overhead. Multiplying an
// integer paise figure by 0.42 in IEEE-754 and rounding the result is how a
// costing drifts — not by much on one line, and by a visible amount across
// forty lines and six thousand pieces.
//
// So the intermediate arithmetic is exact decimal (BigNumber, a direct
// dependency of this repository as of Chunk 2), and rounding happens ONCE per
// scenario, at points the engine names and reports. That is the difference
// between a rounding rule and rounding drift: the first is a decision you can
// read, the second is an accident you cannot find.
//
// ── WHY A WRAPPER AND NOT BigNumber DIRECTLY ────────────────────────────────
// Two reasons, both about refusing rather than coercing. `new BigNumber("")`
// and `new BigNumber(null)` produce NaN quietly, which is exactly the
// missing-becomes-zero failure this domain must not have; and the library's
// global config is process-wide, so it is set here, once, rather than
// wherever somebody happens to require it first.
"use strict";

const BigNumber = require("bignumber.js");

/* 40 significant digits: far beyond any garment costing, and cheap. Exponential
   notation is pushed out of range so a serialised value is always readable. */
const Decimal = BigNumber.clone({
  DECIMAL_PLACES: 40,
  EXPONENTIAL_AT: [-40, 40],
  /* The default rounding for intermediate division only. Every rounding that
     MATTERS is explicit at the call site — see `roundMinor`. */
  ROUNDING_MODE: BigNumber.ROUND_HALF_UP,
});

class DecimalError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DecimalError";
    this.details = details;
  }
}

/**
 * The rounding modes a company may choose for money.
 *
 * `HALF_UP` is the commercial default and what every existing screen in this
 * repository implies. `HALF_EVEN` (banker's) is offered because finance teams
 * that reconcile against a bank sometimes require it. `UP`/`DOWN` are
 * deliberately absent for TOTALS — a company that always rounds its own cost
 * down is understating it — but `UP` is used, unconditionally, for the selling
 * price increment, where rounding down would breach the margin floor.
 */
const ROUNDING_MODES = Object.freeze({
  HALF_UP: BigNumber.ROUND_HALF_UP,
  HALF_EVEN: BigNumber.ROUND_HALF_EVEN,
});

const ROUNDING_MODE_KEYS = Object.freeze(Object.keys(ROUNDING_MODES));

/**
 * A decimal from a caller, or a refusal.
 *
 * Accepts a string (preferred — it survives JSON without a float ever
 * existing) or a finite number. Refuses `null`, `""`, `NaN`, `Infinity` and
 * anything non-numeric: each of those is a caller saying something unclear,
 * and the one thing this must never do is decide they meant zero.
 *
 * `undefined` is the only absence, and it is returned as `undefined` so the
 * caller can tell "not stated" from "stated as nothing".
 */
function dec(value, { field = "value", required = true, allowNegative = true } = {}) {
  if (value === undefined) {
    if (required) throw new DecimalError(`${field} is required.`, { field, reason: "REQUIRED" });
    return undefined;
  }
  if (value === null || value === "") {
    throw new DecimalError(
      `Leave ${field} out entirely when there is no value; do not send an empty one.`,
      { field, reason: "EMPTY_NOT_ZERO" },
    );
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new DecimalError(`${field} must be a number or a decimal string.`, { field, reason: "TYPE" });
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new DecimalError(`${field} must be finite.`, { field, reason: "NOT_FINITE" });
  }
  const n = new Decimal(typeof value === "number" ? String(value) : value.trim());
  if (!n.isFinite()) {
    throw new DecimalError(`${field} is not a number.`, { field, reason: "NOT_A_NUMBER", value: String(value) });
  }
  if (!allowNegative && n.isNegative()) {
    throw new DecimalError(`${field} cannot be negative.`, { field, reason: "NEGATIVE", value: n.toFixed() });
  }
  return n;
}

/** A percentage, bounded. `max` is exclusive where a margin demands it. */
function percent(value, { field = "percent", min = 0, max = 100, maxExclusive = false, required = true } = {}) {
  const n = dec(value, { field, required });
  if (n === undefined) return undefined;
  if (n.isLessThan(min)) {
    throw new DecimalError(`${field} cannot be below ${min}%.`, { field, reason: "BELOW_MIN", value: n.toFixed() });
  }
  if (maxExclusive ? n.isGreaterThanOrEqualTo(max) : n.isGreaterThan(max)) {
    throw new DecimalError(
      maxExclusive ? `${field} must be below ${max}%.` : `${field} cannot exceed ${max}%.`,
      { field, reason: "ABOVE_MAX", value: n.toFixed() },
    );
  }
  return n;
}

/**
 * An exact minor-unit figure → the integer that is actually stored.
 *
 * The ONE place a fraction of a paisa is allowed to disappear, and it is
 * always called deliberately with the company's chosen mode.
 */
function roundMinor(exact, modeKey = "HALF_UP") {
  const mode = ROUNDING_MODES[modeKey];
  if (mode === undefined) {
    throw new DecimalError(`${modeKey} is not a rounding mode this system supports.`, {
      field: "roundingMode", reason: "UNKNOWN_MODE", allowed: ROUNDING_MODE_KEYS,
    });
  }
  const rounded = exact.integerValue(mode);
  const n = rounded.toNumber();
  if (!Number.isSafeInteger(n)) {
    throw new DecimalError("That amount is too large to record exactly.", {
      reason: "AMOUNT_UNSAFE", value: rounded.toFixed(),
    });
  }
  return n;
}

/**
 * Round UP to the next multiple of `increment`.
 *
 * Used only for selling prices, and only upward — a price rounded down to a
 * tidy number is a price below the margin floor the company set, which is the
 * one direction that turns a rounding convenience into a policy breach.
 */
function ceilToIncrement(exact, incrementMinor) {
  if (!incrementMinor || incrementMinor <= 1) return roundMinor(exact.integerValue(BigNumber.ROUND_CEIL), "HALF_UP");
  const inc = new Decimal(incrementMinor);
  return roundMinor(exact.dividedBy(inc).integerValue(BigNumber.ROUND_CEIL).multipliedBy(inc), "HALF_UP");
}

const ZERO = new Decimal(0);
const isZero = (n) => n && n.isZero();

module.exports = {
  Decimal, DecimalError, ROUNDING_MODES, ROUNDING_MODE_KEYS,
  dec, percent, roundMinor, ceilToIncrement, ZERO, isZero,
};
