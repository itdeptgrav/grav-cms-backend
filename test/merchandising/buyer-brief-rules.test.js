// test/merchandising/buyer-brief-rules.test.js
//
// THE BRIEF'S RULES, WITHOUT A DATABASE.
//
// ── WHY THESE ARE NOT ROUTE TESTS ─────────────────────────────────────────
// Carry-forward, validation and the read projection are PURE functions of
// their inputs. Exercising them through an HTTP route and a replica set tested
// the same arithmetic through thirty writes per case, which was both slower
// and worse: a failure told you a request returned 400, not which rule broke.
//
// So the matrix lives here, as values. `buyer-brief.route.test.js` keeps the
// handful of cases that genuinely prove the WIRING — that Sales' door accepts
// it, that it is stored, and that Merchandising's read returns it.
"use strict";

const brief = require("../../services/sales/developmentBriefCarryForward");
const { VOCABULARY, labelFor } = require("../../services/sales/developmentBriefVocabulary");
const { buyerBrief } = require("../../services/merchandising/buyerBrief.projection");
const { fail } = require("../../services/storePurchase/errors");

const shape = (body, previous = null) => brief.validateBrief(
  brief.carryForwardBrief(previous, body), { vocabulary: VOCABULARY, fail },
);

/** A stored version carrying a full brief, as the database holds it. */
const STORED = Object.freeze({
  requestRef: "DRQ-a1", versionNo: 1, state: "ISSUED",
  productName: "Linen resort shirt", styleRef: "RS-2027-14",
  buyerDisplayLabel: "Northstar Retail",
  requirementSummary: "A relaxed linen resort shirt for the UK.",
  requestedCategories: ["FABRIC", "TRIMS"],
  requiredByDate: "2027-01-15",
  targetPriceCeiling: { amount: 850, currency: "INR", basis: "PER_PIECE" },
  requestedBy: { name: "Meera" },
  customerDirection: {
    market: { choice: "UK", note: "" },
    season: { choice: "RESORT", year: 2027, note: "" },
    intendedUse: { choice: "RESORT_HOLIDAY", note: "" },
    targetCustomer: "men 30-45",
  },
  productDirection: {
    fit: { choice: "RELAXED", note: "camp collar" },
    fabric: { values: ["LINEN", "COTTON_WOVEN"], note: "textured" },
    composition: "majority natural",
    weightOrFeel: "soft hand",
    coloursWanted: "warm ivory",
    performance: { values: ["BREATHABLE", "OPAQUE"], note: "" },
    trimsAndBranding: "coconut-look buttons",
    avoid: "avoid excessive transparency",
  },
  developmentNeed: {
    sampleType: { choice: "PROTO", note: "" },
    sampleQuantity: 2,
    sampleSizes: ["M"],
    samplePackaging: "recyclable",
    printing: { state: "NOT_REQUIRED", detail: "" },
    embroidery: { state: "REQUIRED", detail: "chest logo" },
    washFinish: { state: "NOT_CONFIRMED", detail: "" },
    testing: { values: ["SHRINKAGE"], note: "" },
    certification: { values: ["OEKO_TEX"], note: "" },
    sustainability: { values: ["RECYCLABLE_PACKAGING"], note: "" },
  },
  referenceImages: [
    { url: "https://media.test/p.jpg", caption: "front", referenceType: "PRODUCT", storageRef: "cl-p" },
    { url: "https://media.test/t.jpg", caption: "buttons", referenceType: "TRIM", storageRef: "cl-t" },
  ],
});

/* ══ 1 — WHAT A CORRECTION KEEPS ══════════════════════════════════════════ */

describe("a corrected version keeps what the correction did not mention", () => {
  test("a field omitted entirely carries forward", () => {
    /* ── THE DEFECT ────────────────────────────────────────────────────
       Version 2 was built from the posted body alone, so a correction about
       the date issued a version with no target price, no market and no fit —
       and the previous version was already superseded. */
    const out = shape({}, STORED);
    expect(out.customerDirection.market.choice).toBe("UK");
    expect(out.productDirection.fit.choice).toBe("RELAXED");
    expect(out.developmentNeed.sampleSizes).toEqual(["M"]);
    expect(out.developmentNeed.embroidery).toEqual({ state: "REQUIRED", detail: "chest logo" });
  });

  test("the target price carries forward, which is the one that mattered", () => {
    const carried = brief.carryForwardFlat(STORED, {}, { only: ["targetPriceCeiling"] });
    expect(carried.targetPriceCeiling).toEqual({
      amount: 850, currency: "INR", basis: "PER_PIECE",
    });
  });

  test("a nested change keeps every sibling", () => {
    const out = shape({ productDirection: { fit: { note: "and not boxy" } } }, STORED);
    expect(out.productDirection.fit).toEqual({ choice: "RELAXED", note: "and not boxy" });
    expect(out.productDirection.coloursWanted).toBe("warm ivory");
    expect(out.productDirection.fabric.values).toEqual(["LINEN", "COTTON_WOVEN"]);
  });

  test("a changed field takes the new value", () => {
    const out = shape({ customerDirection: { market: { choice: "EUROPE" } } }, STORED);
    expect(out.customerDirection.market.choice).toBe("EUROPE");
    expect(out.customerDirection.season.year).toBe(2027);
  });

  test("an array is REPLACED, never merged", () => {
    /* A buyer who sends three requirements instead of four has removed one,
       and a union would make removal impossible. */
    const out = shape({ productDirection: { performance: { values: ["STRETCH"] } } }, STORED);
    expect(out.productDirection.performance.values).toEqual(["STRETCH"]);
    const sizes = shape({ developmentNeed: { sampleSizes: ["S", "L"] } }, STORED);
    expect(sizes.developmentNeed.sampleSizes).toEqual(["S", "L"]);
  });

  test("null clears a leaf, and is the only thing that does", () => {
    const out = shape({ productDirection: { avoid: null, fit: null } }, STORED);
    expect(out.productDirection.avoid).toBe("");
    expect(out.productDirection.fit).toEqual({ choice: "", note: "" });
    /* Untouched siblings survive the clear. */
    expect(out.productDirection.coloursWanted).toBe("warm ivory");
  });

  test("null clears a whole group, and leaves the others alone", () => {
    const out = shape({ customerDirection: null }, STORED);
    expect(out.customerDirection).toEqual(brief.EMPTY_BRIEF.customerDirection);
    expect(out.productDirection.fit.choice).toBe("RELAXED");
  });

  test("null clears an array to empty, not to absent", () => {
    const out = shape({ developmentNeed: { testing: null } }, STORED);
    expect(out.developmentNeed.testing).toEqual({ values: [], note: "" });
  });

  test("a first version has nothing to carry and starts empty", () => {
    const out = shape({ productDirection: { fit: { choice: "SLIM" } } }, null);
    expect(out.productDirection.fit.choice).toBe("SLIM");
    expect(out.customerDirection.market.choice).toBe("");
    expect(out.developmentNeed.sampleQuantity).toBeNull();
  });

  test("a version stored BEFORE these fields existed is correctable", () => {
    /* Every request issued before this work is this case: the groups are
       simply absent on the document. */
    const legacy = { requirementSummary: "old", requestedCategories: ["FABRIC"] };
    const out = shape({ customerDirection: { market: { choice: "UK" } } }, legacy);
    expect(out.customerDirection.market.choice).toBe("UK");
    expect(out.productDirection.fit.choice).toBe("");
  });
});

/* ══ 2 — WHAT SALES MAY NOT SAY ═══════════════════════════════════════════ */

describe("the controlled choices are the company's own", () => {
  test.each([
    ["productDirection", { fit: { choice: "SKINNY_TAPERED" } }, /choices for fit/],
    ["customerDirection", { market: { choice: "ANTARCTICA" } }, /choices for market/],
    ["developmentNeed", { testing: { values: ["VIBE_CHECK"] } }, /choices for testing/],
    ["developmentNeed", { sampleType: { choice: "MAGIC" } }, /choices for sample type/],
  ])("%s refuses an invented choice, and names the field", (group, patch, pattern) => {
    expect(() => shape({ [group]: patch })).toThrow(pattern);
  });

  test("a refusal offers the words to choose from, not the keys", () => {
    try {
      shape({ productDirection: { fit: { choice: "SKINNY" } } });
      throw new Error("not refused");
    } catch (e) {
      expect(e.message).toMatch(/Relaxed/);
      expect(e.message).not.toMatch(/RELAXED/);
    }
  });

  test("a choice is accepted in any case and stored as the key", () => {
    const out = shape({ customerDirection: { market: { choice: "uk" } } });
    expect(out.customerDirection.market.choice).toBe("UK");
  });

  test("the same requirement twice is one requirement", () => {
    const out = shape({
      productDirection: { performance: { values: ["BREATHABLE", "breathable", "OPAQUE"] } },
    });
    expect(out.productDirection.performance.values).toEqual(["BREATHABLE", "OPAQUE"]);
  });

  test("a detail against an answer that is not Required is refused, not dropped", () => {
    /* Discarding it silently loses somebody describing work they believe is
       happening. */
    expect(() => shape({
      developmentNeed: { printing: { state: "NOT_REQUIRED", detail: "two colour" } },
    })).toThrow(/not marked Required/);
    expect(() => shape({
      developmentNeed: { washFinish: { state: "NOT_CONFIRMED", detail: "enzyme" } },
    })).toThrow(/Wash or finish has details/);
  });

  test("a detail IS kept when the answer is Required", () => {
    const out = shape({
      developmentNeed: { embroidery: { state: "REQUIRED", detail: "chest logo" } },
    });
    expect(out.developmentNeed.embroidery.detail).toBe("chest logo");
  });

  test.each([
    [{ customerDirection: { season: { year: 1980 } } }, /whole year between 2000 and 2100/],
    [{ customerDirection: { season: { year: "soon" } } }, /whole year between 2000 and 2100/],
    [{ developmentNeed: { sampleQuantity: -1 } }, /whole number of pieces/],
    [{ developmentNeed: { sampleQuantity: 2.5 } }, /whole number of pieces/],
  ])("a nonsense number is refused", (patch, pattern) => {
    expect(() => shape(patch)).toThrow(pattern);
  });

  test("more than twenty sample sizes is refused", () => {
    const many = Array.from({ length: 21 }, (_, i) => `S${i}`);
    expect(() => shape({ developmentNeed: { sampleSizes: many } }))
      .toThrow(/more than twenty/);
  });
});

/* ══ 3 — WHAT MERCHANDISING READS ═════════════════════════════════════════ */

describe("the brief Merchandising receives", () => {
  const b = buyerBrief(STORED);

  test("every controlled key arrives as the words a person reads", () => {
    expect(b.customerDirection.market.value).toBe("United Kingdom");
    expect(b.customerDirection.season.value).toBe("Resort / Cruise 2027");
    expect(b.productDirection.fit.value).toBe("Relaxed");
    expect(b.productDirection.fabric.values.map((v) => v.label))
      .toEqual(["Linen and linen blends", "Cotton woven"]);
    /* And the labels are the server's single list. */
    expect(b.productDirection.fit.value).toBe(labelFor("fit", "RELAXED"));
  });

  test("the money is formatted once, on the server", () => {
    expect(b.commercial.targetPrice).toMatchObject({
      amount: 850, currency: "INR", basis: "per piece", display: "₹850 per piece",
    });
  });

  test("the three process answers stay apart, and the fourth is absence", () => {
    const by = Object.fromEntries(b.specialProcesses.map((p) => [p.label, p]));
    expect(by.Printing).toMatchObject({ state: "NOT_REQUIRED", required: false, detail: null });
    expect(by.Embroidery).toMatchObject({ required: true, detail: "chest logo" });
    expect(by["Wash or finish"].state).toBe("NOT_CONFIRMED");

    const none = buyerBrief({ ...STORED, developmentNeed: {} });
    for (const p of none.specialProcesses) {
      expect(p.state).toBeNull();
      expect(p.absent).toMatch(/requirement stated/);
    }
  });

  test("an image keeps its type, caption, storage reference and provenance", () => {
    const trim = b.references.all.find((i) => i.referenceType === "TRIM");
    expect(trim).toMatchObject({
      url: "https://media.test/t.jpg",
      caption: "buttons",
      storageRef: "cl-t",
      typeLabel: "Material or trim reference",
      sourceRequestRef: "DRQ-a1",
      sourceVersionNo: 1,
    });
    /* The product shot leads. */
    expect(b.references.primary.referenceType).toBe("PRODUCT");
  });

  test("an absence is a sentence, never a zero and never a default", () => {
    const bare = buyerBrief({
      requestRef: "DRQ-b", versionNo: 1, state: "ISSUED", productName: "Shirt",
    });
    expect(bare.commercial.targetPrice).toMatchObject({
      value: null, amount: null, absent: "Sales has not provided a target price",
    });
    expect(bare.customerDirection.market.absent).toBe("Market not stated");
    expect(bare.productDirection.fit.absent).toBe("No fit preference stated");
    expect(bare.compliance.testing.absent).toBe("No testing requirement stated");
    /* A quantity nobody stated is null — 0 would mean "no samples wanted". */
    expect(bare.developmentNeed.sampleQuantity).toBeNull();
    expect(bare.references.all).toEqual([]);
  });

  test("the holes are counted, so a screen can offer to ask about them", () => {
    const bare = buyerBrief({ requestRef: "DRQ-b", versionNo: 1, productName: "Shirt" });
    const labels = bare.missing.map((m) => m.label);
    expect(labels).toContain("Target price");
    expect(labels).toContain("Market");
    expect(labels).toContain("Fit");
    /* A complete brief is missing only what it is missing. */
    expect(b.missing.map((m) => m.label)).not.toContain("Target price");
  });

  test("the attribution names the exact version", () => {
    expect(b.source).toMatchObject({ requestRef: "DRQ-a1", versionNo: 1 });
    expect(b.source.sentence)
      .toBe("Recorded by Sales · Read-only in Merchandising · Request v1");
  });

  test("nothing Sales owns privately can cross, even if it is on the document", () => {
    /* The projection reads a FIXED list of paths, so a field added to the
       Sales record later cannot leak by accident — it simply will not appear
       until somebody adds it here on purpose. */
    const polluted = buyerBrief({
      ...STORED,
      opportunityValue: 1250000,
      margin: 0.42,
      internalNote: "they always beat us down",
      buyerContact: "arun@northstar.test",
      messages: [{ body: "can you do 700?" }],
      quotation: { total: 700 },
    });
    const printed = JSON.stringify(polluted);
    for (const leak of [
      "1250000", "0.42", "beat us down", "arun@northstar.test", "can you do 700", "quotation",
    ]) {
      expect(printed).not.toContain(leak);
    }
  });

  test("a file with no Sales request projects null, not a fabricated brief", () => {
    expect(buyerBrief(null)).toBeNull();
  });
});
