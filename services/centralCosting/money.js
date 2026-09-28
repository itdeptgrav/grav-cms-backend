// services/centralCosting/money.js
//
// Central Costing — Chunk 1. MONEY, AND THE DIFFERENCE BETWEEN NOTHING AND ZERO.
//
// ── WHY NOT A NUMBER ────────────────────────────────────────────────────────
// The legacy Sales costing stores rupees as floats and sums them with
// `+(a + b).toFixed(2)` (services/costingTotals.js). That is fine for a screen
// and wrong for a ledger: 0.1 + 0.2 is not 0.3, and a costing that will later
// be compared against posted supplier invoices cannot afford the drift. The
// roadmap's invariant is explicit — "no floating-point money arithmetic;
// calculate in integer minor units".
//
// So canonical money is `{ amountMinor, currency }` where `amountMinor` is an
// INTEGER count of the currency's smallest unit (paise for INR, cents for
// USD). There is no `amount` in major units anywhere in the stored shape; a
// display value is derived at the edge, never stored.
//
// ── MISSING IS NOT ZERO ─────────────────────────────────────────────────────
// `{ amountMinor: 0 }` means "this costs nothing" — a free sample, a waived
// charge. Absent means "nobody has said what this costs". Reporting the second
// as the first is how a costing quietly under-states itself, so the parser
// below returns `undefined` for absent input and refuses `null`, `""` and
// `NaN` rather than coercing any of them to 0.
"use strict";

/** ISO-4217 alphabetic codes are exactly three uppercase letters. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Currencies this deployment will accept today.
 *
 * A deliberate allowlist rather than "any three letters": the pattern alone
 * accepts `XXX` and `ABC`, and a costing stamped with a currency nothing can
 * convert is worse than a rejected one. It is a data question, not a code
 * question — extend it when the business trades in another currency.
 */
const SUPPORTED_CURRENCIES = Object.freeze(["INR", "USD", "EUR", "GBP", "AED"]);

/** The company default until Chunk 2's costing policy names one per company. */
const DEFAULT_CURRENCY = "INR";

/** Minor units per major unit, for display only. All of the above are 2. */
const MINOR_UNITS = Object.freeze({ INR: 2, USD: 2, EUR: 2, GBP: 2, AED: 2 });

class MoneyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "MoneyError";
    this.details = details;
  }
}

/**
 * Validate a currency code.
 *
 * @param {*} value
 * @param {object} [opts]
 * @param {boolean} [opts.required]  when false, absent input yields undefined
 * @returns {string|undefined} the normalised uppercase code
 * @throws {MoneyError}
 */
function parseCurrency(value, { required = true, field = "currency" } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new MoneyError("A currency is required.", { field, reason: "CURRENCY_REQUIRED" });
    return undefined;
  }
  if (typeof value !== "string") {
    throw new MoneyError("A currency must be a three-letter code.", { field, reason: "CURRENCY_TYPE" });
  }
  const code = value.trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(code)) {
    throw new MoneyError(
      "A currency must be a three-letter ISO code, such as INR.",
      { field, reason: "CURRENCY_FORMAT", value: code },
    );
  }
  if (!SUPPORTED_CURRENCIES.includes(code)) {
    throw new MoneyError(
      `${code} is not a currency this system is set up to cost in.`,
      { field, reason: "CURRENCY_UNSUPPORTED", value: code, supported: SUPPORTED_CURRENCIES },
    );
  }
  return code;
}

/**
 * Validate a money value in minor units.
 *
 * Refuses, rather than coerces:
 *   · a float          — 1250.5 paise is not a quantity of paise
 *   · a numeric string — "1250" is a display value that has not been parsed
 *   · NaN / Infinity   — the shapes `Number("12abc")` and `1/0` produce
 *   · `null` / `""`    — a caller saying "empty" where it means "absent"
 *
 * Negative IS allowed: a credit, a rebate and a correction are all real, and
 * refusing them here would push somebody into storing a sign elsewhere.
 *
 * @returns {{amountMinor:number, currency:string}|undefined}
 */
function parseMoney(value, { required = false, field = "amount", currencyRequired = true } = {}) {
  if (value === undefined) {
    if (required) throw new MoneyError("An amount is required.", { field, reason: "AMOUNT_REQUIRED" });
    return undefined;
  }
  /* `null` is not "absent" from a client — it is a client saying something,
     and what it is saying is ambiguous. Refuse it and let them omit the key. */
  if (value === null) {
    throw new MoneyError(
      "Leave the amount out entirely when there is no amount; do not send null.",
      { field, reason: "AMOUNT_NULL" },
    );
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new MoneyError(
      "An amount must be an object of the form { amountMinor, currency }.",
      { field, reason: "AMOUNT_SHAPE" },
    );
  }

  const raw = value.amountMinor;
  if (raw === undefined || raw === null || raw === "") {
    throw new MoneyError(
      "An amount must state amountMinor, in the currency's smallest unit.",
      { field, reason: "AMOUNT_MINOR_REQUIRED" },
    );
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new MoneyError(
      "amountMinor must be a whole number of the currency's smallest unit — paise, not rupees, and not text.",
      { field, reason: "AMOUNT_MINOR_TYPE" },
    );
  }
  if (!Number.isInteger(raw)) {
    throw new MoneyError(
      "amountMinor must be a whole number: express fractions of a rupee as paise.",
      { field, reason: "AMOUNT_MINOR_NOT_INTEGER", value: raw },
    );
  }
  if (!Number.isSafeInteger(raw)) {
    throw new MoneyError(
      "That amount is too large to record exactly.",
      { field, reason: "AMOUNT_MINOR_UNSAFE", value: raw },
    );
  }

  const currency = parseCurrency(value.currency, { required: currencyRequired, field: `${field}.currency` });
  return currency === undefined ? { amountMinor: raw } : { amountMinor: raw, currency };
}

/** Display only, at the edge. Never stored, never summed. */
function formatMinor({ amountMinor, currency } = {}) {
  if (!Number.isInteger(amountMinor)) return "";
  const places = MINOR_UNITS[currency] ?? 2;
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor).toString().padStart(places + 1, "0");
  const major = abs.slice(0, abs.length - places);
  const minor = places ? `.${abs.slice(abs.length - places)}` : "";
  return `${sign}${major}${minor}${currency ? ` ${currency}` : ""}`;
}

module.exports = {
  CURRENCY_PATTERN, SUPPORTED_CURRENCIES, DEFAULT_CURRENCY, MINOR_UNITS,
  MoneyError, parseCurrency, parseMoney, formatMinor,
};
