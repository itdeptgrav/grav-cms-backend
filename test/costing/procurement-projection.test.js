// test/costing/procurement-projection.test.js
//
// WHAT AN APPROVED COSTING IMPLIES SOMEBODY WILL HAVE TO BUY — AND WHAT IT
// DOES NOT.
//
// The dangerous mistakes here are all the same shape: turning an estimate into
// something that reads like a decision. Projecting the finished garment as a
// purchase. Adding metres to kilograms. Merging two variants. Putting an
// unmapped amount in a default budget head. Quietly repricing from today's
// quotation because the frozen one expired. Each would produce a plausible
// total that describes nothing.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const P = require("../../services/centralCosting/procurementProjection.service");

const { KIND, ISSUE, SOURCE_STATUS } = P;

/* One frozen provenance entry, as the version stores it. */
const prov = (over = {}) => ({
  lineKey: "fabric",
  state: "SUPPLIER_QUOTATION",
  supplierId: "sup1", supplierName: "Arvind Mills",
  itemId: "item1", variantId: "var1",
  itemName: "Oxford cotton", itemSku: "FAB-OX", variantLabel: "Blue", variantSku: "FAB-OX-BL",
  quotationReference: "Q-14", offerRevision: 2,
  quotationDate: new Date("2026-06-01"), validUntil: new Date("2026-12-31"),
  currency: "INR", netRateMinor: 41250, priceBasis: "PER_METRE",
  purchaseUom: "m", consumptionUom: "m", conversionFactor: "1", conversionPath: "m → m",
  quantityPerUnit: "1.4", appliedPurchaseQuantity: "1400",
  moq: 500, orderMultiple: 50,
  scenarios: [{
    scenarioKey: "q1000", outputQuantity: "1000",
    purchaseQuantity: "1400", purchaseUom: "m",
    netRateMinor: 41250, tierMinQuantity: 1000, tierMaxQuantity: null,
    priceSource: "TIER", conversionFactor: "1",
    gstAmountMinor: 1039500, taxTreatment: "RECOVERABLE",
  }],
  ...over,
});

const line = (over = {}) => ({ lineKey: "fabric", category: "MATERIAL", label: "Oxford cotton", quantityUom: "m", quantityPerUnit: "1.4", ...over });
const result = (over = {}) => ({ lineKey: "fabric", category: "MATERIAL", totalMinor: 5775000, perUnitMinor: 5775, taxMinor: 0, ...over });
const scenario = (over = {}) => ({ key: "q1000", quantity: "1000", quantityUom: "pcs", isPrimary: true, lines: [result()], ...over });
const version = { _id: "v3", versionNumber: 3 };
const costing = { _id: "c1" };
const ASOF = new Date("2026-09-06");

const build = (o = {}) => P.requirementFrom({
  costing, version,
  scenario: o.scenario || scenario(),
  line: o.line || line(),
  result: o.result === null ? null : (o.result || result()),
  prov: o.prov === null ? null : (o.prov || prov()),
  kind: o.kind || KIND.PHYSICAL,
  asOfDate: o.asOfDate || ASOF,
});

/* ── 2, 3 · THE EXACT SCENARIO, AND THE VARIANT ──────────────────────────── */

describe("what a requirement says", () => {
  test("the quantity projected is the one frozen for THIS scenario", () => {
    const r = build();
    expect(r.outputQuantity).toBe("1000");
    expect(r.quantity.purchaseQuantity).toBe("1400");
    expect(r.quantity.purchaseUom).toBe("m");
    expect(r.quantity.consumptionPerUnit).toBe("1.4");
    expect(r.quantity.consumptionUom).toBe("m");
    /* The engine's figure, not one this module multiplied. */
    expect(r.quantity.available).toBe(true);
  });

  test("a scenario the version froze separately is used, not the line default", () => {
    const p = prov({
      appliedPurchaseQuantity: "1400",
      scenarios: [
        { scenarioKey: "q1000", purchaseQuantity: "1400", purchaseUom: "m", outputQuantity: "1000" },
        { scenarioKey: "q5000", purchaseQuantity: "7000", purchaseUom: "m", outputQuantity: "5000", netRateMinor: 39000 },
      ],
    });
    const big = build({ prov: p, scenario: scenario({ key: "q5000", quantity: "5000" }) });
    expect(big.quantity.purchaseQuantity).toBe("7000");
    expect(big.outputQuantity).toBe("5000");
  });

  test("the variant survives as its own identity, never folded into the item", () => {
    const r = build();
    expect(r.reference.itemId).toBe("item1");
    expect(r.reference.variantId).toBe("var1");
    expect(r.identity.variantLabel).toBe("Blue");
    expect(r.identity.variantSku).toBe("FAB-OX-BL");
  });

  test("supplier MOQ and order multiple are carried as frozen, and never invented", () => {
    expect(build().quantity.moq).toBe(500);
    expect(build().quantity.orderMultiple).toBe(50);
    /* Null is "not recorded". A 1 would read as a recorded absence of any
       constraint, which is a different claim. */
    const bare = build({ prov: prov({ moq: null, orderMultiple: null }) });
    expect(bare.quantity.moq).toBeNull();
    expect(bare.quantity.orderMultiple).toBeNull();
    /* The order quantity is the engine's APPLIED one — already rounded to the
       supplier's terms. Rounding it again here would round twice. */
    expect(build().quantity.orderQuantity).toBe("1400");
  });
});

/* ── 4, 5, 6 · WHAT IS AND IS NOT A PURCHASE ─────────────────────────────── */

describe("what counts as procurement", () => {
  test("a service stays a service and never becomes an inventory item", () => {
    const sProv = prov({
      lineKey: "wash", itemId: undefined, variantId: undefined,
      serviceId: "svc1", serviceCode: "WASH", serviceName: "Enzyme wash",
      billingUnit: "piece", sacCode: "9988", minimumChargeMinor: 500000,
      appliedServiceQuantity: "1000",
      scenarios: [{ scenarioKey: "q1000", serviceQuantity: "1000", billingUnit: "piece", lineNetMinor: 1200000 }],
    });
    const r = build({
      kind: KIND.SERVICE, prov: sProv,
      line: line({ lineKey: "wash", category: "SERVICE", label: "Enzyme wash" }),
      result: result({ lineKey: "wash", category: "SERVICE", totalMinor: 1200000 }),
      scenario: scenario({ lines: [result({ lineKey: "wash", category: "SERVICE", totalMinor: 1200000 })] }),
    });
    expect(r.kind).toBe(KIND.SERVICE);
    expect(r.reference.serviceId).toBe("svc1");
    /* No item identity is fabricated for it. */
    expect(r.reference.itemId).toBeNull();
    expect(r.reference.variantId).toBeNull();
    expect(r.quantity.billingUnit).toBe("piece");
    /* And it has no purchase UoM or conversion — a service has neither. */
    expect(r.quantity.purchaseUom).toBeUndefined();
    expect(r.quantity.conversionFactor).toBeUndefined();
  });

  test("internal families are never procurement, whatever sits beside them", () => {
    for (const category of ["OPERATION", "OVERHEAD", "FINANCING", "WASTAGE", "DUTY", "NON_RECOVERABLE_TAX"]) {
      /* Even handed a full supplier provenance, which is the strongest case
         against: nobody buys internal labour or an overhead allocation. */
      expect(P.kindOf(line({ category }), prov())).toBeNull();
    }
  });

  test("a policy charge with no supplier is not procurement; an externally bought one is", () => {
    const noSupplier = prov({ supplierId: undefined, itemId: "item1" });
    expect(P.kindOf(line({ category: "FIXED_SETUP" }), noSupplier)).toBeNull();
    expect(P.kindOf(line({ category: "FIXED_SETUP" }), prov())).toBe(KIND.PHYSICAL);
    /* And a line with no frozen evidence at all is never a purchase. */
    expect(P.kindOf(line({ category: "MATERIAL" }), null)).toBeNull();
  });

  test("materials, packaging, outside services and supplier freight are procurement", () => {
    expect(P.kindOf(line({ category: "MATERIAL" }), prov())).toBe(KIND.PHYSICAL);
    expect(P.kindOf(line({ category: "PACKAGING" }), prov())).toBe(KIND.PHYSICAL);
    expect(P.kindOf(line({ category: "SERVICE" }), prov())).toBe(KIND.SERVICE);
    expect(P.kindOf(line({ category: "FREIGHT" }), prov())).toBe(KIND.FREIGHT);
  });

  test("the finished garment is never a requirement, and the excluded families say why", () => {
    const sc = scenario({
      lines: [
        result(),
        result({ lineKey: "stitch", category: "OPERATION", totalMinor: 2000000 }),
        result({ lineKey: "oh", category: "OVERHEAD", totalMinor: 500000 }),
      ],
    });
    /* Only the material was procured; the rest is explained rather than
       silently dropped, so the gap between product cost and expected
       procurement value is answerable. */
    const excluded = P.notProcurementFrom(sc, new Set(["fabric"]));
    const byCategory = Object.fromEntries(excluded.map((e) => [e.category, e]));
    expect(byCategory.OPERATION.totalMinor).toBe(2000000);
    expect(byCategory.OPERATION.reason).toMatch(/own people, not bought/i);
    expect(byCategory.OVERHEAD.reason).toMatch(/internal allocation/i);
    /* Nothing anywhere projects the output quantity itself as a purchase. */
    expect(excluded.some((e) => /finished|garment|output/i.test(e.category))).toBe(false);
  });
});

/* ── 7, 8 · TAX ──────────────────────────────────────────────────────────── */

describe("tax", () => {
  test("recoverable GST is reported apart and never inside the expected value", () => {
    const r = build();
    /* The engine's own net for this line. */
    expect(r.money.expectedNetMinor).toBe(5775000);
    expect(r.money.recoverableTaxMinor).toBe(1039500);
    /* The cost figure does not contain it — the company gets it back. */
    expect(r.money.expectedNetMinor).not.toBe(5775000 + 1039500);
    /* But the cash that must be funded can still be stated. */
    expect(r.money.grossCashMinor).toBe(5775000 + 1039500);
  });

  test("non-recoverable GST is part of the cost, as the engine already included it", () => {
    const r = build({ result: result({ taxMinor: 288750 }) });
    expect(r.money.nonRecoverableTaxMinor).toBe(288750);
    /* Not added again here: `totalMinor` is the engine's figure and already
       accounts for it. */
    expect(r.money.expectedNetMinor).toBe(5775000);
  });

  test("an unrecorded recoverable amount leaves gross cash unstated rather than equal to net", () => {
    const p = prov({ scenarios: [{ scenarioKey: "q1000", purchaseQuantity: "1400", purchaseUom: "m", taxTreatment: "RECOVERABLE" }] });
    const r = build({ prov: p });
    expect(r.money.recoverableTaxMinor).toBeNull();
    /* "No recoverable tax" and "nobody wrote it down" are different answers. */
    expect(r.money.grossCashMinor).toBeNull();
  });
});

/* ── 10 · A MISSING CONVERSION REFUSES BOTH QUANTITY AND MONEY ───────────── */

describe("unit conversion", () => {
  test("no frozen conversion between unlike units refuses the quantity AND the value", () => {
    const p = prov({
      purchaseUom: "kg", consumptionUom: "m", conversionFactor: null,
      scenarios: [{ scenarioKey: "q1000", purchaseQuantity: "1400", purchaseUom: "kg", conversionFactor: null }],
    });
    const r = build({ prov: p });
    expect(r.quantity.available).toBe(false);
    expect(r.quantity.purchaseQuantity).toBeNull();
    expect(r.issues).toContain(ISSUE.NO_CONVERSION);
    /* THE POINT: an amount computed across an unfrozen conversion is metres
       charged as kilograms. It refuses rather than multiplying. */
    expect(r.money.available).toBe(false);
    expect(r.money.expectedNetMinor).toBeNull();
    expect(P.ISSUE_TEXT.NO_CONVERSION.message).toMatch(/unit conversion was not frozen/i);
  });

  test("identical units need no conversion and are not reported as broken", () => {
    const p = prov({ purchaseUom: "m", consumptionUom: "m", conversionFactor: null });
    const r = build({ prov: p });
    expect(r.quantity.available).toBe(true);
    expect(r.issues).not.toContain(ISSUE.NO_CONVERSION);
  });
});

/* ── 11, 12, 13 · WHAT MAY NEVER BE ADDED TOGETHER ───────────────────────── */

describe("safe aggregation", () => {
  const withKey = (o) => P.aggregationKey(build(o));

  test("unlike units never aggregate", () => {
    const metres = withKey({});
    const kilos = withKey({ prov: prov({ purchaseUom: "kg", consumptionUom: "kg", scenarios: [{ scenarioKey: "q1000", purchaseQuantity: "40", purchaseUom: "kg" }] }) });
    expect(metres).not.toBe(kilos);
  });

  test("different variants never aggregate", () => {
    const blue = withKey({});
    const red = withKey({ prov: prov({ variantId: "var2", variantLabel: "Red" }) });
    expect(blue).not.toBe(red);
    expect(P.separationReason(build(), build({ prov: prov({ variantId: "var2" }) })))
      .toMatch(/Different variants/);
  });

  test("different suppliers and different validity windows stay separate", () => {
    const a = build();
    const b = build({ prov: prov({ supplierId: "sup2", supplierName: "Other Mills" }) });
    expect(P.aggregationKey(a)).not.toBe(P.aggregationKey(b));
    expect(P.separationReason(a, b)).toMatch(/different suppliers/i);

    /* An expired quotation and a current one describe different commercial
       periods; one total across both is a price nobody quoted. */
    const expired = build({ prov: prov({ validUntil: new Date("2026-01-01") }) });
    expect(expired.supplier.status).toBe(SOURCE_STATUS.EXPIRED);
    expect(P.aggregationKey(a)).not.toBe(P.aggregationKey(expired));
    expect(P.separationReason(a, expired)).toMatch(/validity/i);
  });

  test("a physical item and a service never aggregate", () => {
    const item = build();
    const svc = build({ kind: KIND.SERVICE, prov: prov({ itemId: undefined, variantId: undefined, serviceId: "svc1" }) });
    expect(P.aggregationKey(item)).not.toBe(P.aggregationKey(svc));
    expect(P.separationReason(item, svc)).toMatch(/service and a physical item/i);
  });

  test("the same item, variant, supplier and unit DOES aggregate", () => {
    expect(withKey({ line: line({ lineKey: "fabric-2" }) })).toBe(withKey({}));
  });
});

/* ── 21 · A SOURCE THAT HAS MOVED DOES NOT REWRITE THE PROJECTION ────────── */

describe("source standing", () => {
  test("an expired quotation is flagged, and every frozen figure is untouched", () => {
    const current = build();
    const expired = build({ prov: prov({ validUntil: new Date("2026-01-01") }) });

    expect(current.supplier.status).toBe(SOURCE_STATUS.CURRENT);
    expect(expired.supplier.status).toBe(SOURCE_STATUS.EXPIRED);
    expect(expired.issues).toContain(ISSUE.SOURCE_EXPIRED);

    /* The warning is a second fact beside the first, never a replacement:
       the quantity, the rate, the revision and the amount all read exactly as
       they were approved. */
    expect(expired.quantity.purchaseQuantity).toBe(current.quantity.purchaseQuantity);
    expect(expired.supplier.quotedRateMinor).toBe(current.supplier.quotedRateMinor);
    expect(expired.supplier.quotationRevision).toBe(2);
    expect(expired.money.expectedNetMinor).toBe(current.money.expectedNetMinor);
  });

  test("a quotation with no recorded validity is UNCHECKED, not assumed current", () => {
    const r = build({ prov: prov({ validUntil: null }) });
    expect(r.supplier.status).toBe(SOURCE_STATUS.UNCHECKED);
    expect(r.issues).toContain(ISSUE.SOURCE_UNCHECKED);
  });

  test("the frozen quotation evidence is carried in full", () => {
    const s = build().supplier;
    expect(s.supplierName).toBe("Arvind Mills");
    expect(s.quotationReference).toBe("Q-14");
    expect(s.quotationRevision).toBe(2);
    expect(s.quotedRateMinor).toBe(41250);
    expect(s.priceBasis).toBe("PER_METRE");
    expect(s.tier.minQuantity).toBe(1000);
    expect(s.tier.priceSource).toBe("TIER");
  });
});

/* ── 24 · THE HANDOFF IDENTITY CHUNK 7B WILL NEED ────────────────────────── */

describe("stable references", () => {
  test("every requirement carries the ids a future request would be raised from", () => {
    const r = build();
    expect(r.reference).toEqual({
      costingId: "c1", costingVersionId: "v3", versionNumber: 3,
      scenarioKey: "q1000", lineKey: "fabric", kind: KIND.PHYSICAL,
      itemId: "item1", variantId: "var1", serviceId: null,
    });
  });

  test("a service requirement carries a service id and no item identity", () => {
    const r = build({ kind: KIND.SERVICE, prov: prov({ itemId: undefined, variantId: undefined, serviceId: "svc1" }) });
    expect(r.reference.serviceId).toBe("svc1");
    expect(r.reference.itemId).toBeNull();
    expect(r.reference.kind).toBe(KIND.SERVICE);
  });
});
