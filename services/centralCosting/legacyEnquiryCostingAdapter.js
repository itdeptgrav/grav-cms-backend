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

const crypto = require("crypto");

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

/* ══════════════════════════════════════════════════════════════════════════
 * CHUNK 2 — THE MAPPING ITSELF
 *
 * Pure: sheets in, canonical cost lines out. No database, no request, no
 * enquiry lookup — the caller has already proved the enquiry is theirs (see
 * contextResolver.service.js), and this only interprets what it is handed.
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * A legacy text number → a canonical decimal string, or nothing.
 *
 * ── WHY THIS IS SEPARATE FROM `toMinorUnits` ────────────────────────────────
 * Consumption and SAM are QUANTITIES, not money: 0.42 metres, 18 minutes.
 * They keep their decimals and are parsed exactly, while the money beside them
 * becomes integer minor units. Running both through one converter is how a
 * quantity ends up rounded to two places for no reason.
 */
function toQuantityString(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const digits = String(raw).replace(/[^0-9.-]/g, "");
  if (!/[0-9]/.test(digits)) return undefined;
  const n = Number(digits);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return String(digits).trim();
}

const clean = (v) => String(v ?? "").trim();

/**
 * Convert one enquiry's costing sheets for one product into canonical inputs.
 *
 * ── WHAT IT REFUSES TO GUESS ────────────────────────────────────────────────
 * A legacy row whose unit cost or consumption cannot be read is NOT imported
 * as a zero. It is reported in `unmapped`, by row, with the reason — because a
 * fabric line with no price is not free fabric, and a costing that quietly
 * treats it as free is worse than one that says it is incomplete.
 *
 * Ambiguities that CAN be imported but that a person should look at — a
 * pre-split `combined` sheet sitting alongside a `raw` one, a consumption with
 * a separate allowance percentage, a vendor with no item-master link — are
 * imported and reported in `ambiguities`, never silently smoothed over.
 *
 * @param {object[]} sheets  `enquiry.costingSheets` entries for ONE product
 * @param {string} currency  the company's base currency
 * @returns {{lines, unmapped, ambiguities}}
 */
function linesFromCostingSheets(sheets = [], currency = DEFAULT_CURRENCY) {
  const lines = [];
  const unmapped = [];
  const ambiguities = [];

  const parts = sheets.map((s) => s?.part || "combined");
  if (parts.includes("combined") && (parts.includes("raw") || parts.includes("operations"))) {
    /* A `combined` sheet holds both halves. One sitting beside a split sheet
       may be the same rows twice — and only a person who knows the enquiry can
       say. Importing both and saying so beats picking one and not saying. */
    ambiguities.push({
      code: "COMBINED_AND_SPLIT_SHEETS",
      message: "This product has both a pre-split combined sheet and a separate raw or operations sheet. Rows may be counted twice; check the imported lines.",
    });
  }

  sheets.forEach((sheet, sheetIndex) => {
    const part = sheet?.part || "combined";
    const at = (kind, rowIndex) => `${part}:${kind}:${sheetIndex}:${rowIndex}`;

    (sheet?.materials || []).forEach((row, i) => {
      const label = clean(row?.item) || "(unnamed material)";
      const rate = toMinorUnits(row?.unitCost, currency);
      const consumption = toQuantityString(row?.consumption);
      if (!rate || consumption === undefined) {
        unmapped.push({
          rowKey: at("material", i), label,
          reason: !rate ? "UNIT_COST_UNREADABLE" : "CONSUMPTION_UNREADABLE",
          original: { unitCost: clean(row?.unitCost), consumption: clean(row?.consumption) },
        });
        return;
      }
      if (rate.roundedBy !== 0) {
        ambiguities.push({
          code: "MONEY_ROUNDED_ON_IMPORT", rowKey: at("material", i), label,
          message: `The legacy rate ${clean(row.unitCost)} was rounded to the nearest minor unit.`,
        });
      }
      if (clean(row?.allowancePercent)) {
        /* Documented on the Enquiry schema as already baked into consumption.
           Carried as a note so the imported figure is readable, not re-applied
           — applying it again would inflate the costing by the allowance. */
        ambiguities.push({
          code: "ALLOWANCE_ALREADY_IN_CONSUMPTION", rowKey: at("material", i), label,
          message: `Consumption already includes the ${clean(row.allowancePercent)}% allowance recorded by R&D; it was not applied a second time.`,
        });
      }
      if (clean(row?.vendor) && !row?.rawItemId) {
        ambiguities.push({
          code: "VENDOR_NOT_LINKED_TO_MASTER", rowKey: at("material", i), label,
          message: `"${clean(row.vendor)}" is free text on the legacy sheet, not a linked supplier record.`,
        });
      }
      lines.push({
        lineKey: at("material", i),
        category: "MATERIAL",
        behaviour: "PER_UNIT",
        label,
        unitRate: { amountMinor: rate.amountMinor, currency },
        quantityPerUnit: consumption,
        quantityUom: clean(row?.unit),
        confidence: "PROVISIONAL",
        sourceRefKey: at("material", i),
        note: [clean(row?.category), clean(row?.vendor)].filter(Boolean).join(" · ").slice(0, 500),
      });
    });

    (sheet?.operations || []).forEach((row, i) => {
      const label = clean(row?.detail) || "(unnamed operation)";
      /* The legacy model is SAM (minutes) × rate (cost per minute) — see
         `services/costingTotals.js`. That maps exactly onto a per-unit line
         whose "consumption" is minutes. */
      const rate = toMinorUnits(row?.rate, currency);
      const sam = toQuantityString(row?.sam);
      if (!rate || sam === undefined) {
        unmapped.push({
          rowKey: at("operation", i), label,
          reason: !rate ? "RATE_UNREADABLE" : "SAM_UNREADABLE",
          original: { rate: clean(row?.rate), sam: clean(row?.sam) },
        });
        return;
      }
      lines.push({
        lineKey: at("operation", i),
        category: "OPERATION",
        behaviour: "PER_UNIT",
        label,
        unitRate: { amountMinor: rate.amountMinor, currency },
        quantityPerUnit: sam,
        quantityUom: "min",
        confidence: "PROVISIONAL",
        sourceRefKey: at("operation", i),
        note: "Legacy SAM × cost per minute.",
      });
    });

    (sheet?.miscellaneous || []).forEach((row, i) => {
      const label = clean(row?.name) || "(unnamed cost)";
      const price = toMinorUnits(row?.price, currency);
      if (!price) {
        unmapped.push({
          rowKey: at("misc", i), label, reason: "PRICE_UNREADABLE",
          original: { price: clean(row?.price) },
        });
        return;
      }
      lines.push({
        lineKey: at("misc", i),
        category: "MISC",
        behaviour: "PER_UNIT",
        label,
        unitRate: { amountMinor: price.amountMinor, currency },
        /* Explicit, not defaulted: a legacy miscellaneous row is one charge
           per piece, and writing "1" says so where an omission would not. */
        quantityPerUnit: "1",
        quantityUom: "piece",
        confidence: "PROVISIONAL",
        sourceRefKey: at("misc", i),
        note: "Legacy miscellaneous cost line.",
      });
    });
  });

  return { lines, unmapped, ambiguities };
}

/**
 * A stable fingerprint of WHAT WAS IMPORTED.
 *
 * ── WHY CONTENT AND NOT JUST THE SOURCE ID ──────────────────────────────────
 * "Importing the same legacy source twice must not create duplicate versions"
 * — but a legacy sheet is mutable, and re-importing it AFTER somebody changed
 * it should absolutely produce a new version, because the numbers are
 * different. Keying on the enquiry and product alone would block that; keying
 * on the content gets both: an unchanged sheet has the same key and is
 * recovered, a changed one has a new key and is a new version.
 */
function legacyImportKey({ enquiryId, productName, lines, unmapped }) {
  const canonical = JSON.stringify({
    enquiryId: String(enquiryId),
    productName: clean(productName),
    lines: (lines || []).map((l) => [
      l.lineKey, l.category, l.behaviour, l.label,
      l.unitRate?.amountMinor, l.unitRate?.currency, l.quantityPerUnit, l.quantityUom,
    ]),
    unmapped: (unmapped || []).map((u) => [u.rowKey, u.reason]),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

module.exports = {
  LEGACY_SOURCE_TYPE, LEGACY_ORIGIN,
  toMinorUnits, toQuantityString, contextForEnquiryProduct, sourceReferenceForSheet,
  linesFromCostingSheets, legacyImportKey,
};
