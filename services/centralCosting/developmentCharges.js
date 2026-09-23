"use strict";
/**
 * services/centralCosting/developmentCharges.js
 *
 * THE COMPANY'S OWN CHARGES FOR DEVELOPMENT, PATTERN AND TOOLING WORK — READ,
 * ADAPTED, AND RESOLVED AT A DATE.
 *
 * ── THE TWO DEFECTS THIS FILE EXISTS TO CLOSE ───────────────────────────────
 *
 * 1. THE TABLE COULD NOT HOLD TWO RATES. One row per key, and publishing a new
 *    amount REPLACED the old one. So the September charge stopped existing the
 *    moment October's was published, and a costing dated in September could no
 *    longer be recalculated at the figure it was actually costed at. An
 *    effective-dated table that cannot hold two periods is a table with one
 *    date on it.
 *
 * 2. EVERY CHARGE WAS A FLAT ONE. Pattern development is ₹10,000 for the run.
 *    Screen making is ₹2,000 A SCREEN, and a garment needing four screens is
 *    ₹8,000 — once, for the run, diluted across it. Forcing that into a flat
 *    charge means either Finance publishing a "four screens" charge (a rate
 *    that lies about what it is) or somebody typing ₹8,000 into the costing,
 *    which is the thing this whole family exists to stop.
 *
 * ── PERIODS ARE HALF-OPEN: [from, to) ───────────────────────────────────────
 * A period that ended and one that began on the same date must not both apply
 * to a costing dated that day. Closed intervals make midnight ambiguous and
 * the ambiguity is invisible: two rates match, the first one found wins, and
 * which one that is depends on the order somebody happened to type them in.
 * So a period runs from its start INCLUSIVE to its end EXCLUSIVE, and a
 * boundary date belongs to exactly one period — the one starting on it.
 *
 * ── AND ONE CURRENCY, BECAUSE THERE IS NO FX SOURCE ─────────────────────────
 * Nothing in this system holds an exchange rate on a date. A charge published
 * in another currency could only be converted by guessing, so it is refused at
 * the point it is written rather than silently mixed into a total.
 */

const { Decimal, roundMinor } = require("./decimal");

/** How a charge turns into money. */
const CALCULATIONS = Object.freeze(["FLAT_PER_RUN", "PER_REQUIREMENT_UNIT"]);

/** Why a charge could not be resolved. Each is fixed in a different place. */
const REASON = Object.freeze({
  NO_PERIOD: "NO_EFFECTIVE_PERIOD",
  AMBIGUOUS: "PERIOD_AMBIGUOUS",
  NO_QUANTITY: "REQUIREMENT_QUANTITY_MISSING",
});

const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const date = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * One stored charge definition, in the shape everything downstream reads.
 *
 * ── THE COMPATIBILITY THIS PERFORMS ─────────────────────────────────────────
 * A row written before rate periods existed carries its amount at the top
 * level with a single window around it. That IS a rate period — one of them —
 * so it is adapted into one rather than discarded, and a company that
 * configured its charges last quarter finds them intact.
 *
 * A legacy row with no start date applied from whenever it was published,
 * which is what its absence meant. Adapting it to the epoch says the same
 * thing in the shape the resolver can answer, rather than leaving a period
 * with no start that no date can be compared against.
 */
function adaptCharge(raw = {}) {
  const key = str(raw.key, 60);
  const label = str(raw.label, 200);
  const calculation = CALCULATIONS.includes(raw.calculation) ? raw.calculation : "FLAT_PER_RUN";

  const rates = Array.isArray(raw.rates) && raw.rates.length
    ? raw.rates.map((r) => ({
      amountMinor: r?.amountMinor,
      currency: str(r?.currency, 3).toUpperCase() || "INR",
      effectiveFrom: date(r?.effectiveFrom),
      effectiveTo: date(r?.effectiveTo),
    }))
    /* ── THE FLAT ROW, ADAPTED ──────────────────────────────────────
       Not discarded and not re-dated: the same amount, the same window it
       already had, expressed as the one period it always was. */
    : [{
      amountMinor: raw.amountMinor,
      currency: str(raw.currency, 3).toUpperCase() || "INR",
      effectiveFrom: date(raw.effectiveFrom) || new Date(0),
      effectiveTo: date(raw.effectiveTo),
    }];

  return {
    key,
    label,
    description: str(raw.description, 1000),
    calculation,
    /* Only a per-unit charge has one. A unit on a flat charge would be a
       label for a quantity nobody enters. */
    unit: calculation === "PER_REQUIREMENT_UNIT" ? str(raw.unit, 60) : null,
    active: raw.active !== false,
    rates: rates
      .slice()
      .sort((a, b) => (a.effectiveFrom?.getTime() ?? 0) - (b.effectiveFrom?.getTime() ?? 0)),
  };
}

/** The whole table, adapted. */
const adaptTable = (rows) => (Array.isArray(rows) ? rows : []).map(adaptCharge);

/**
 * The ONE period in force on a date, or why there is none.
 *
 * Half-open, so a boundary date belongs to the period starting on it and to
 * no other. Zero matches and several matches are both refusals: the first is
 * a gap Finance has to close, and the second is a table that contradicts
 * itself, and neither may be resolved by picking one.
 */
function selectPeriod(definition, asOf) {
  const when = date(asOf) || new Date();
  const t = when.getTime();
  const hits = (definition?.rates || []).filter((r) => {
    const from = r.effectiveFrom ? r.effectiveFrom.getTime() : null;
    if (from === null || from > t) return false;
    /* Exclusive end: a period ending today does not apply today. */
    return !r.effectiveTo || r.effectiveTo.getTime() > t;
  });
  if (hits.length === 1) return { period: hits[0], reason: null };
  return { period: null, reason: hits.length ? REASON.AMBIGUOUS : REASON.NO_PERIOD, matches: hits.length };
}

/**
 * What the charge comes to for THIS requirement, once, for the run.
 *
 * ── FIXED IS NOT THE SAME AS FLAT ───────────────────────────────────────────
 * Both totals are fixed relative to the garment quantity — neither is
 * multiplied by the run — but one of them scales with something R&D counted.
 * Four screens is four screens whether the order is 100 pieces or 1,000.
 */
function chargeTotalMinor(definition, period, { quantity = null, roundingMode = "HALF_UP" } = {}) {
  if (definition.calculation !== "PER_REQUIREMENT_UNIT") {
    return { totalMinor: period.amountMinor, quantity: null, reason: null };
  }
  const q = quantity === null || quantity === undefined || quantity === ""
    ? null
    : new Decimal(String(quantity));
  if (!q || !q.isFinite() || q.isLessThanOrEqualTo(0)) {
    /* A blank quantity is not one of something. Costing it as one would put a
       single screen's charge on a garment that needs four. */
    return { totalMinor: null, quantity: null, reason: REASON.NO_QUANTITY };
  }
  return {
    /* Exact decimal throughout, rounded once at the end — the same discipline
       every other money path here follows. */
    totalMinor: roundMinor(q.multipliedBy(new Decimal(String(period.amountMinor))), roundingMode),
    quantity: q.toFixed(),
    reason: null,
  };
}

module.exports = { CALCULATIONS, REASON, adaptCharge, adaptTable, selectPeriod, chargeTotalMinor };
