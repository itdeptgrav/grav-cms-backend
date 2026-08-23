// services/commercialLadder.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildCommercialLadder } = require("./commercialLadder");

const byKey = (r) => Object.fromEntries(r.rungs.map((x) => [x.key, x]));

test("an enquiry with no lead behind it still returns four rungs, the first unreached", () => {
  const r = buildCommercialLadder({ enquiry: { products: [{ quantity: 100 }], estimatedPriceMin: 500, estimatedPriceMax: 500 } });
  assert.equal(r.rungs.length, 4);
  assert.equal(byKey(r).lead.reached, false, "no Lead means no first rung");
  assert.match(byKey(r).lead.note, /did not come from a Lead/);
  assert.equal(byKey(r).enquiry.reached, true);
});

test("the whole ladder is returned even when nothing is reached — it is a sequence, not a list", () => {
  const r = buildCommercialLadder({});
  assert.deepEqual(r.rungs.map((x) => x.key), ["lead", "enquiry", "quote", "order"]);
  assert.equal(r.rungs.filter((x) => x.reached).length, 0);
  assert.equal(r.drift, null, "one rung or fewer cannot drift");
});

test("the Lead rung keeps confidence and stated source — the point of carrying it", () => {
  const r = buildCommercialLadder({
    enquiry: { leadEstimate: { annualRevenue: 3600000, annualRevenueConfidence: "document_confirmed", annualRevenueSource: "Tender document" } },
  });
  const lead = byKey(r).lead;
  assert.equal(lead.value, 3600000);
  assert.equal(lead.confidence, "document_confirmed");
  assert.equal(lead.confidenceLabel, "Confirmed by a document");
  assert.equal(lead.basis, "Tender document");
});

test("confidence falls back to the unit price's when revenue has none", () => {
  const r = buildCommercialLadder({ enquiry: { leadEstimate: { annualRevenue: 100, unitPriceConfidence: "assumed" } } });
  assert.equal(byKey(r).lead.confidenceLabel, "Assumed");
});

test("the enquiry rung derives value from product quantity x the mid of the price range", () => {
  const r = buildCommercialLadder({ enquiry: { products: [{ quantity: 2600 }, { quantity: 1200 }], estimatedPriceMin: 700, estimatedPriceMax: 780 } });
  const e = byKey(r).enquiry;
  assert.equal(e.quantity, 3800);
  assert.equal(e.unitPrice, 740);
  assert.equal(e.value, 3800 * 740);
  assert.deepEqual(e.unitPriceRange, { min: 700, max: 780 });
});

test("a stored opportunitySize wins over the derivation — it is what the deal says it is", () => {
  const r = buildCommercialLadder({ enquiry: { opportunitySize: 9999, products: [{ quantity: 10 }], estimatedPriceMin: 1, estimatedPriceMax: 1 } });
  assert.equal(byKey(r).enquiry.value, 9999);
});

test("one end of the price range is enough", () => {
  const r = buildCommercialLadder({ enquiry: { products: [{ quantity: 50 }], estimatedPriceMin: 200 } });
  assert.equal(byKey(r).enquiry.unitPrice, 200);
  assert.equal(byKey(r).enquiry.value, 10000);
});

test("products with no quantity do not count as zero", () => {
  const r = buildCommercialLadder({ enquiry: { products: [{ quantity: 100 }, { product: "Cap" }], estimatedPriceMin: 10, estimatedPriceMax: 10 } });
  assert.equal(byKey(r).enquiry.quantity, 100, "the quantity-less row is skipped, not counted as 0");
});

test("no products at all leaves quantity null rather than 0", () => {
  const r = buildCommercialLadder({ enquiry: { products: [], estimatedPriceMin: 10 } });
  assert.equal(byKey(r).enquiry.quantity, null);
  assert.equal(byKey(r).enquiry.value, null, "no quantity means no derivable value");
});

test("drift runs from the FIRST reached rung to the LAST, not first-to-second", () => {
  const r = buildCommercialLadder({
    enquiry: { leadEstimate: { annualRevenue: 1000 }, products: [{ quantity: 1 }], estimatedPriceMin: 800, estimatedPriceMax: 800 },
    quotedTotal: 900,
    order: { grandTotal: 500 },
  });
  assert.equal(r.drift.fromKey, "lead");
  assert.equal(r.drift.toKey, "order");
  assert.equal(r.drift.delta, -500);
  assert.equal(r.drift.percent, -50);
});

test("drift skips unreached rungs in the middle", () => {
  const r = buildCommercialLadder({ enquiry: { leadEstimate: { annualRevenue: 200 } }, order: { grandTotal: 300 } });
  assert.equal(r.drift.fromKey, "lead");
  assert.equal(r.drift.toKey, "order");
  assert.equal(r.drift.percent, 50);
});

test("a zero baseline reports no percentage rather than Infinity", () => {
  const r = buildCommercialLadder({ enquiry: { leadEstimate: { annualRevenue: 0 } }, order: { grandTotal: 400 } });
  // 0 is a real captured value, so the rung is reached and the delta is real…
  assert.equal(r.drift.delta, 400);
  assert.equal(r.drift.percent, null, "…but the percentage is not reportable");
});

test("a later rung never rewrites an earlier one", () => {
  const r = buildCommercialLadder({
    enquiry: { leadEstimate: { annualRevenue: 3600000, annualQuantity: 4800 }, products: [{ quantity: 3800 }], estimatedPriceMin: 740, estimatedPriceMax: 740 },
    order: { grandTotal: 2870000 },
  });
  assert.equal(byKey(r).lead.value, 3600000, "the Lead's figure is the record of what was believed");
  assert.equal(byKey(r).lead.quantity, 4800);
  assert.equal(byKey(r).enquiry.quantity, 3800, "and the enquiry's is its own");
});

test("the order rung says whether money has actually arrived", () => {
  const paid = buildCommercialLadder({ order: { grandTotal: 100, totalPaidAmount: 40, requestId: "REQ-1" } });
  assert.match(byKey(paid).order.note, /40 received/);
  assert.equal(byKey(paid).order.basis, "Order REQ-1");
  const unpaid = buildCommercialLadder({ order: { grandTotal: 100, totalPaidAmount: 0 } });
  assert.match(byKey(unpaid).order.note, /Nothing received/);
});

test("currency follows the enquiry and falls back to INR", () => {
  assert.equal(buildCommercialLadder({ enquiry: { pricingCurrency: "USD" } }).currency, "USD");
  assert.equal(buildCommercialLadder({}).currency, "INR");
});
