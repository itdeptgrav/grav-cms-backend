// test/store-purchase/variant-precedence.test.js
//
// A QUOTATION FOR THIS COLOUR BEATS ONE FOR THE FABRIC.
//
// ── WHAT THE WALKTHROUGH SHOWED ─────────────────────────────────────────────
// The Soumya Tshirt BOM names a variant — `variantId` plus a
// `variantCombination` of ["Debidutt Mangilall", "Black"], which is what the
// screen renders as "SuitingFabric 63/37PC Plain — Debidutt Mangilall /
// Black". The quotation form offered only "Whole item", because the item
// picker never carried the item's variants into the selector: the list it
// rendered was always empty.
//
// So a BOM row naming a real variant could not be quoted for, and every
// quotation silently became a whole-item one. Two things follow, and both are
// identity-based: the picker must offer the variant's own `_id`, and where a
// variant-specific quotation and a whole-item one both apply, the specific one
// wins — with the rule that chose it frozen on the costing.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const { resolveApplicableOffers, EXCLUSIONS } = require("../../services/storePurchase/offerApplicability");

const ITEM = new mongoose.Types.ObjectId();
const BLACK = new mongoose.Types.ObjectId();
const WHITE = new mongoose.Types.ObjectId();

const offer = (over = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  companyId: null,
  itemId: ITEM,
  supplierName: over.supplierName || "Mill",
  quotationReference: over.quotationReference || "Q-1",
  purchaseUom: "Metre",
  currency: "INR",
  unitPriceMinor: 41250,
  priceBasis: "TAX_EXCLUSIVE",
  gstRatePercent: 12,
  status: "ACTIVE",
  effectiveFrom: new Date("2026-01-01"),
  ...over,
});

const facts = { supplierActive: () => true, itemActive: null, conversionFor: () => ({ configured: true, sameUnit: true, factor: "1", from: "Metre", to: "Metre" }) };
const resolve = (offers, variantId) => resolveApplicableOffers({
  offers,
  criteria: { itemId: ITEM, variantId, quantity: "500", requestedUom: "Metre", asOf: new Date("2026-06-01") },
  facts,
});

/* ═══ 1 · THE SPECIFIC RATE WINS ══════════════════════════════════════════ */

describe("a variant-specific quotation beside a whole-item one", () => {
  test("the specific one is used, and the general one says why it was not", () => {
    const whole = offer({ supplierName: "General Mill", quotationReference: "Q-WHOLE" });
    const black = offer({ variantId: BLACK, supplierName: "Colour Mill", quotationReference: "Q-BLACK", unitPriceMinor: 44000 });

    const { applicable, excluded } = resolve([whole, black], BLACK);

    /* One answer, not a tie somebody has to break. */
    expect(applicable).toHaveLength(1);
    expect(applicable[0].quotationReference).toBe("Q-BLACK");
    /* ── AND NOT BECAUSE IT IS CHEAPER ────────────────────────────────
       It is dearer. Specificity decided it, not price. */
    expect(applicable[0].appliedUnitPriceMinor).toBeGreaterThan(whole.unitPriceMinor);
    expect(applicable[0].selectionRule).toBe("VARIANT_SPECIFIC_PREFERRED");

    /* The whole-item rate is excluded WITH a reason, not dropped — a buyer
       looking at the lane deserves to see it was considered. */
    const superseded = excluded.find((e) => e.quotationReference === "Q-WHOLE");
    expect(superseded.code).toBe(EXCLUSIONS.SUPERSEDED_BY_VARIANT);
    expect(superseded.message).toMatch(/whole-item rate was not used/);
  });

  test("a whole-item quotation still prices a variant when nothing more specific exists", () => {
    /* The documented rule, and the reason a whole-item quotation is useful
       at all: it covers every variant until one is quoted for by name. */
    const whole = offer({ quotationReference: "Q-WHOLE" });
    const { applicable } = resolve([whole], BLACK);
    expect(applicable).toHaveLength(1);
    expect(applicable[0].selectionRule).toBe("WHOLE_ITEM");
  });

  test("a quotation for another variant is refused, not preferred", () => {
    const white = offer({ variantId: WHITE, quotationReference: "Q-WHITE" });
    const { applicable, excluded } = resolve([white], BLACK);
    expect(applicable).toHaveLength(0);
    expect(excluded[0].code).toBe(EXCLUSIONS.WRONG_VARIANT);
  });

  test("two specific quotations remain a genuine decision", () => {
    /* This rule breaks ONE tie — specific over general — and invents no
       others. Which of two suppliers to buy black from is a commercial
       decision with a person's name on it. */
    const a = offer({ variantId: BLACK, supplierName: "Mill A", quotationReference: "Q-A" });
    const b = offer({ variantId: BLACK, supplierName: "Mill B", quotationReference: "Q-B", unitPriceMinor: 39000 });
    const { applicable } = resolve([a, b], BLACK);
    expect(applicable).toHaveLength(2);
    /* Ordered by supplier name, never by price. */
    expect(applicable.map((x) => x.supplierName)).toEqual(["Mill A", "Mill B"]);
    expect(applicable.every((x) => x.selectionRule === "VARIANT_SPECIFIC")).toBe(true);
  });

  test("two whole-item quotations remain a decision too", () => {
    const a = offer({ supplierName: "Mill A", quotationReference: "Q-A" });
    const b = offer({ supplierName: "Mill B", quotationReference: "Q-B" });
    const { applicable } = resolve([a, b], BLACK);
    expect(applicable).toHaveLength(2);
    expect(applicable.every((x) => x.selectionRule === "WHOLE_ITEM")).toBe(true);
  });

  test("a line with no variant is unaffected by a variant-specific quotation", () => {
    /* A whole-item consumption row is not "the black one by default". */
    const whole = offer({ quotationReference: "Q-WHOLE" });
    const black = offer({ variantId: BLACK, quotationReference: "Q-BLACK" });
    const { applicable } = resolve([whole, black], null);
    expect(applicable.map((x) => x.quotationReference)).toEqual(["Q-WHOLE"]);
    expect(applicable[0].selectionRule).toBe("WHOLE_ITEM");
  });
});

/* ═══ 2 · AND NO IDENTITY IS EVER MANUFACTURED FROM A NAME ════════════════ */

test("specificity is read from the stored id, never from a label", () => {
  const fs = require("fs");
  const src = fs.readFileSync(
    require.resolve("../../services/storePurchase/offerApplicability"), "utf8",
  );
  /* `variantSpecific` is the presence of an id and nothing else — a rule
     that matched on a combination string would bind a quotation to a colour
     by spelling. */
  expect(src).toMatch(/variantSpecific: present\(offer\.variantId\)/);
  expect(src).not.toMatch(/variantCombination/);
  expect(src).not.toMatch(/variantLabel\s*===/);
});
