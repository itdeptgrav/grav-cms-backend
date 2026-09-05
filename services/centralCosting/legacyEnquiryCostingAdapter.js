// services/centralCosting/legacyEnquiryCostingAdapter.js
//
// Central Costing — Chunk 1. THE SEAM CHUNK 2 IMPORTS THROUGH. NOTHING RUNS
// THROUGH IT YET.
//
// ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
// The Sales enquiry already holds costings: `Enquiry.costingSheets`, filled by
// merchandisers and industrial engineers, totalled by
// `services/costingTotals.js`, and read through
// `services/crmCostVisibility.js`. Chunk 2 adopts that data into canonical
// frozen `CostingVersion`s.
//
// ── AND WHAT IT DELIBERATELY IS NOT ─────────────────────────────────────────
// It is NOT wired in. Nothing in this chunk reads an Enquiry, writes one, or
// dual-writes a costing sheet into a canonical version. The existing Sales
// costing routes, their data and their behaviour are untouched, which is the
// preservation requirement this chunk was given.
//
// What it IS: the two pure mappings Chunk 2 needs, written down now so the
// canonical shapes were designed against real legacy data rather than against
// a guess about it — and so the import is a call to a tested function rather
// than a fresh interpretation of a five-year-old schema.
//
// ── THE THREE FACTS THAT SHAPED THE MODELS ──────────────────────────────────
// 1. A costing sheet is keyed by product NAME within an enquiry, not by a
//    product id — see the `costingSheets` schema comment on Enquiry.js and the
//    rename-handling in routes/CMS_Routes/Sales/enquiries.js. That is why the
//    canonical context type `ENQUIRY_STYLE` carries an `externalKey` and not a
//    second ObjectId.
// 2. Legacy rows store money as FLOATS in major units (rupees), summed with
//    `toFixed(2)`. Canonical money is integer minor units, so every imported
//    amount must be converted explicitly — `toMinorUnits` below — and never
//    copied across.
// 3. Legacy rows are a current, mutable snapshot with no provenance. They are
//    therefore imported as `confidence: "PROVISIONAL"` and
//    `origin: "LEGACY_IMPORT"`, which is what the roadmap requires of
//    provisional inputs: labelled honestly, snapshotted, never a live
//    reference.
"use strict";

const { DEFAULT_CURRENCY } = require("./money");

/** The source type every legacy row is imported under. */
const LEGACY_SOURCE_TYPE = "ENQUIRY_COSTING_SHEET";
const LEGACY_ORIGIN = "LEGACY_IMPORT";

/**
 * Rupees (or any major-unit float) → integer minor units.
 *
 * ── WHY THIS ROUNDS, AND SAYS SO ────────────────────────────────────────────
 * A legacy value of 12.005 cannot be represented in paise. Truncating would
 * lose money silently; rounding loses half a paisa and is the conventional
 * choice. Either way the import must be able to REPORT that it happened, so
 * this returns the rounding delta alongside the value rather than swallowing
 * it. Chunk 2 decides whether a non-zero delta is worth surfacing per row or
 * in an import summary.
 *
 * `null`/`undefined`/`""` return `undefined` — missing stays missing, and is
 * never converted into a zero amount.
 *
 * @returns {{amountMinor:number, currency:string, roundedBy:number}|undefined}
 */
function toMinorUnits(major, currency = DEFAULT_CURRENCY, minorPlaces = 2) {
  if (major === undefined || major === null || major === "") return undefined;
  let n;
  if (typeof major === "number") {
    n = major;
  } else {
    /* Stripping non-numeric characters can empty the string entirely — and
       `Number("")` is 0, which would turn "n/a" into a free item. An input
       with no digits left in it is absent, not zero. */
    const digits = String(major).replace(/[^0-9.-]/g, "");
    if (!/[0-9]/.test(digits)) return undefined;
    n = Number(digits);
  }
  if (!Number.isFinite(n)) return undefined;
  const factor = 10 ** minorPlaces;
  const exact = n * factor;
  const amountMinor = Math.round(exact);
  return { amountMinor, currency, roundedBy: +(exact - amountMinor).toFixed(6) };
}

/**
 * The canonical context reference for one legacy costing sheet.
 *
 * @param {string|object} enquiryId  the Enquiry document's `_id`
 * @param {string} productName       the sheet's `productName` — the key
 */
function contextForEnquiryProduct(enquiryId, productName) {
  return {
    type: "ENQUIRY_STYLE",
    primaryId: enquiryId,
    externalKey: String(productName ?? "").trim(),
  };
}

/**
 * The canonical source reference for one legacy costing sheet part.
 *
 * Records WHERE the numbers came from and WHAT they said, without asserting
 * they were ever verified. `part` is the sheet's own split — raw materials,
 * operations, or a combined sheet.
 */
function sourceReferenceForSheet({ enquiryId, productName, part, capturedAt } = {}) {
  return {
    sourceType: LEGACY_SOURCE_TYPE,
    sourceId: enquiryId,
    sourceKey: [String(productName ?? "").trim(), part || "combined"].filter(Boolean).join("::"),
    label: `Enquiry costing sheet — ${productName || "(unnamed product)"} (${part || "combined"})`,
    /* Not a judgement about the merchandiser's work: a legacy row carries no
       quotation reference, no validity and no effective date, so nothing in it
       can be verified from the record itself. */
    confidence: "PROVISIONAL",
    capturedAt: capturedAt || new Date(),
    snapshot: [],
  };
}

module.exports = {
  LEGACY_SOURCE_TYPE, LEGACY_ORIGIN,
  toMinorUnits, contextForEnquiryProduct, sourceReferenceForSheet,
};
