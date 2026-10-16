// test/accountant/stock-summary.test.js
//
// The accounting Stock Summary's valuation (services/accounting/stockSummary.js),
// pure — no database. 16 Oct 2026, owner: "some stock items' values are not
// coming correctly". Every raw material has variants bought at different
// prices; one blended rate for the item mis-valued the materials whose
// variants cost differently, and a purchase price per box / roll was used as
// if it were per piece / metre.
"use strict";

const { rawItemRow, unitFactor, latestPoPrices, istDay } = require("../../services/accounting/stockSummary");

const T0 = new Date("2026-06-10T06:00:00Z").getTime();
const at = (d) => new Date(T0 + d * 86400000);
const oid = (n) => `6a${String(n).padStart(22, "0")}`;
const from = istDay("2026-06-01", false);
const to = istDay("2026-06-30", true);
const after = new Date("2026-08-01T00:00:00Z"); // "now", after the period: closing comes from history
const today = new Date("2026-06-20T00:00:00Z"); // "now" inside the period: closing is the current quantity

/* a receipt or issue on a variant, carrying both balances as the Store writes them */
const mv = (n, { type = "VARIANT_ADD", q, price = 0, v, day, before, afterQ, vBefore, vAfter }) => ({
  _id: oid(n), type, quantity: q, unitPrice: price, variantId: v, createdAt: at(day),
  previousQuantity: before, newQuantity: afterQ, variantPreviousQuantity: vBefore, variantNewQuantity: vAfter,
});

function fabric() {
  return {
    _id: oid(900), name: "Suiting fabric", unit: "Mtr", quantity: 150,
    variants: [
      { _id: oid(1), combination: ["Navy"], quantity: 100, vendorNicknames: [] },
      { _id: oid(2), combination: ["Grey"], quantity: 50, vendorNicknames: [] },
    ],
    stockTransactions: [
      mv(11, { q: 100, price: 100, v: oid(1), day: 0, before: 0, afterQ: 100, vBefore: 0, vAfter: 100 }),
      mv(12, { q: 100, price: 300, v: oid(2), day: 1, before: 100, afterQ: 200, vBefore: 0, vAfter: 100 }),
      mv(13, { type: "VARIANT_REDUCE", q: 50, v: oid(2), day: 2, before: 200, afterQ: 150, vBefore: 100, vAfter: 50 }),
    ],
  };
}

describe("each variant is valued at its own rate", () => {
  test("two variants bought at different prices are not blended", () => {
    const r = rawItemRow(fabric(), { from, to, now: today });
    // 100 m Navy × 100 + 50 m Grey × 300 = 25,000 — a blended 200 would say 30,000
    expect(r.value).toBe(25000);
    expect(r.closing).toBe(150);
    expect(r.rate).toBeCloseTo(166.67, 2);
    expect(r.rateSource).toBe("weighted_receipts");
    expect(r.variants.map((v) => [v.name, v.closing, v.rate, v.value])).toEqual([
      ["Navy", 100, 100, 10000],
      ["Grey", 50, 300, 15000],
    ]);
  });

  test("the quantity statement still reads opening + in − out + adjustment = closing", () => {
    const r = rawItemRow(fabric(), { from, to, now: today });
    expect(r.opening + r.inward - r.outward + r.adjustment).toBeCloseTo(r.closing, 6);
    expect([r.opening, r.inward, r.outward]).toEqual([0, 200, 50]);
  });

  test("a past period takes each variant's quantity from its own recorded balances", () => {
    const it = fabric();
    // later, outside the period: Grey is issued down to 10
    it.stockTransactions.push(mv(14, { type: "VARIANT_REDUCE", q: 40, v: oid(2), day: 40, before: 150, afterQ: 110, vBefore: 50, vAfter: 10 }));
    it.quantity = 110;
    it.variants[1].quantity = 10;
    const r = rawItemRow(it, { from, to, now: after });
    expect(r.closing).toBe(150); // at 30 June
    expect(r.variants.find((v) => v.name === "Grey").closing).toBe(50);
    expect(r.value).toBe(25000);
  });

  test("the supplier fallback uses each variant's own price, not the first variant's", () => {
    const r = rawItemRow({
      _id: oid(901), name: "Button", unit: "Pcs", quantity: 300, stockTransactions: [],
      variants: [
        { _id: oid(3), combination: ["24L"], quantity: 100, vendorNicknames: [{ price: 0.5 }] },
        { _id: oid(4), combination: ["32L"], quantity: 200, vendorNicknames: [{ price: 1.5 }] },
      ],
    }, { from, to, now: today });
    expect(r.value).toBe(350); // 50 + 300, not 300 × 0.5
    expect(r.rateSource).toBe("supplier");
  });

  test("a variant with no price of its own takes the item's rate, and says so", () => {
    const it = fabric();
    it.variants.push({ _id: oid(5), combination: ["Black"], quantity: 20, vendorNicknames: [] });
    it.quantity = 170;
    const r = rawItemRow(it, { from, to, now: today });
    const black = r.variants.find((v) => v.name === "Black");
    expect(black.rateSource).toBe("item_rate");
    expect(black.rate).toBe(200); // the item's receipts: (100×100 + 100×300) ÷ 200
    expect(r.rateSource).toBe("per_variant");
    expect(r.value).toBe(25000 + 20 * 200);
  });

  test("quantity no variant holds is valued at the item's rate", () => {
    const it = fabric();
    it.quantity = 160; // 10 more than the variants hold
    const r = rawItemRow(it, { from, to, now: today });
    expect(r.value).toBe(25000 + 10 * 200);
  });

  test("a material with no price anywhere has no value — never zero", () => {
    const r = rawItemRow({
      _id: oid(902), name: "Needle", unit: "Pcs", quantity: 36, stockTransactions: [],
      variants: [{ _id: oid(6), combination: ["Default"], quantity: 36, vendorNicknames: [] }],
    }, { from, to, now: today });
    expect(r.value).toBeNull();
    expect(r.rate).toBeNull();
    expect(r.unvaluedQty).toBe(36);
  });

  test("an item-level purchase-order price stays a fallback for older callers", () => {
    const r = rawItemRow({
      _id: oid(903), name: "Tape", unit: "Pcs", quantity: 10, stockTransactions: [],
      variants: [{ _id: oid(7), combination: ["Default"], quantity: 10, vendorNicknames: [] }],
    }, { from, to, now: today, lastPoPrice: 4 });
    expect(r.value).toBe(40);
    expect(r.variants[0].rateSource).toBe("item_rate");
  });
});

describe("prices are per stock unit", () => {
  test("a goods receipt's price per box is divided by the box's pieces", () => {
    const it = {
      _id: oid(904), name: "Thread", unit: "Pcs", quantity: 24,
      variants: [{ _id: oid(8), combination: ["White"], quantity: 24, vendorNicknames: [] }],
      // 2 boxes of 12 received: the movement moved 24 pieces at ₹120 a box
      stockTransactions: [mv(21, { q: 24, price: 120, v: oid(8), day: 0, before: 0, afterQ: 24, vBefore: 0, vAfter: 24 })],
    };
    const r = rawItemRow(it, { from, to, now: today, factorByMovement: new Map([[oid(21), 12]]) });
    expect(r.rate).toBe(10);
    expect(r.value).toBe(240);
  });

  test("the unit master converts directly or in reverse; unknown pairs are refused", () => {
    const units = [
      { name: "Box", conversions: [{ toUnit: { name: "Pcs" }, quantity: 12 }] },
      { name: "Kilogram", conversions: [{ toUnit: { name: "Gram" }, quantity: 1000 }] },
    ];
    expect(unitFactor(units, "Box", "Pcs")).toBe(12);
    expect(unitFactor(units, "gram", "KILOGRAM")).toBe(0.001);
    expect(unitFactor(units, "Pcs", "pcs")).toBe(1);
    expect(unitFactor(units, "Pkt", "Meter")).toBeNull();
  });

  test("the latest purchase-order price is found per variant and converted, never mixed across units", () => {
    const units = [{ name: "Box", conversions: [{ toUnit: { name: "Pcs" }, quantity: 12 }] }];
    const orders = [
      { items: [{ rawItem: "A", variantId: "v1", unit: "Box", unitPrice: 120 }, { rawItem: "B", unit: "Pkt", unitPrice: 300 }] },
      { items: [{ rawItem: "A", variantId: "v2", unit: "Pcs", unitPrice: 15 }, { rawItem: "B", unit: "Meter", unitPrice: 8.5 }] },
    ];
    const price = latestPoPrices(orders, (id) => (id === "A" ? "Pcs" : "Meter"), units);
    expect(price("A", "v1")).toBe(10);
    expect(price("A", "v2")).toBe(15);
    expect(price("A", null)).toBe(10); // newest line for the item
    expect(price("B", null)).toBe(8.5); // the packet price could not be converted to metres
    expect(price("A", "v3")).toBeNull();
  });
});

describe("the purchase voucher and the Stock Summary read ONE price rule", () => {
  const { purchaseCatalogue, billHistory } = require("../../services/accounting/voucherItemCatalogue");
  const { latestPoPrices } = require("../../services/accounting/materialPrices");
  const units = [{ name: "Box", conversions: [{ toUnit: { name: "Pcs" }, quantity: 12 }] }];
  const item = {
    _id: "r1", name: "Thread", unit: "Pcs", quantity: 300, primaryVendor: "vA", stockTransactions: [],
    variants: [
      { _id: "v1", combination: ["White"], quantity: 100, vendorNicknames: [{ vendor: "vB", price: 9 }, { vendor: "vA", price: 7 }] },
      { _id: "v2", combination: ["Navy"], quantity: 100, vendorNicknames: [{ vendor: "vA", price: 0.04 }] },
      { _id: "v3", combination: ["Olive"], quantity: 100, vendorNicknames: [] },
    ],
  };
  // only Olive was ordered, in boxes of 12 at ₹0.324 a box → ₹0.027 a piece
  const poLines = [{ rawItem: "r1", variantId: "v3", unit: "Box", unitPrice: 0.324 }];
  const poPrice = latestPoPrices([{ items: poLines }], () => "Pcs", units);
  const summary = rawItemRow(item, { from, to, now: today, poPrice: (v) => poPrice("r1", v) });
  const form = purchaseCatalogue([item], billHistory([]), poLines, { units });
  const formPrice = (vid) => form.find((r) => String(r.variantId) === vid).standardCost;
  const summaryRate = (vid) => summary.variants.find((v) => v._id === vid).rate;

  test("a variant's own supplier price wins over a sibling's purchase order, on both sides", () => {
    expect(formPrice("v2")).toBe(0.04);
    expect(summaryRate("v2")).toBe(0.04);
  });
  test("the primary supplier's price is taken first, on both sides", () => {
    expect(formPrice("v1")).toBe(7);
    expect(summaryRate("v1")).toBe(7);
  });
  test("a purchase-order price per box is per piece on both sides", () => {
    expect(formPrice("v3")).toBeCloseTo(0.027, 6);
    expect(summaryRate("v3")).toBeCloseTo(0.03, 2); // the summary shows rates to the paisa
  });
  test("the voucher row carries the Stock Summary's rate beside its price", () => {
    const rows = purchaseCatalogue([item], billHistory([]), poLines, {
      units,
      stockRate: (raw, vid) => ({ rate: summaryRate(vid), source: "supplier" }),
    });
    expect(rows.find((r) => String(r.variantId) === "v2")).toMatchObject({ standardCost: 0.04, stockRate: 0.04 });
  });
});
