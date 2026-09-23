// constants/currencyMinorUnits.js
//
// HOW MANY DECIMAL PLACES A CURRENCY'S MINOR UNIT HAS, PER ISO 4217.
//
// ── WHY A TABLE AND NOT AN ASSUMPTION ──────────────────────────────────────
// "Minor units" are paise for INR and cents for USD — 100 to the major unit —
// but not for every currency: JPY and KRW have none (1), KWD, BHD and OMR have
// three (1,000). Dividing every currency by 100 would publish a yen figure a
// hundred times too small and a dinar figure ten times too large, in a field
// whose name says it is correct.
//
// ── WHY NOT Intl ───────────────────────────────────────────────────────────
// `Intl.NumberFormat` answers with CLDR's display digits, which differ from
// ISO 4217's minor unit for some currencies (and change with the runtime's
// ICU data). A money unit must not depend on the server's ICU build.
//
// ── A CURRENCY NOT LISTED IS NOT GUESSED ───────────────────────────────────
// A caller gets `null`, and must withhold the money figure. Adding a currency
// means checking its ISO 4217 exponent and adding one line here.
"use strict";

const freeze = Object.freeze;

const EXPONENT = freeze({
  /* Two decimal places. */
  INR: 2, USD: 2, EUR: 2, GBP: 2, AUD: 2, CAD: 2, NZD: 2, SGD: 2, HKD: 2,
  CHF: 2, SEK: 2, NOK: 2, DKK: 2, CNY: 2, AED: 2, SAR: 2, QAR: 2, ZAR: 2,
  MYR: 2, THB: 2, PHP: 2, IDR: 2, LKR: 2, NPR: 2, BDT: 2, PKR: 2, MXN: 2,
  BRL: 2, TRY: 2, PLN: 2, CZK: 2, HUF: 2, ILS: 2, EGP: 2, NGN: 2, KES: 2,
  /* None. */
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, UGX: 0, PYG: 0, XOF: 0, XAF: 0,
  /* Three. */
  KWD: 3, BHD: 3, OMR: 3, JOD: 3, TND: 3, IQD: 3, LYD: 3,
});

/** The ISO 4217 minor-unit exponent, or null when GRAV does not know it. */
function minorUnitDigits(currency) {
  const code = String(currency ?? "").trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(EXPONENT, code) ? EXPONENT[code] : null;
}

module.exports = freeze({ EXPONENT, minorUnitDigits });
