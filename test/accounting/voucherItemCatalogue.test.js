const {
  salesCatalogue,
  purchaseCatalogue,
  garmentSlabRate,
  matchesQuery,
} = require("../../services/accounting/voucherItemCatalogue");

const product = (over = {}) => ({
  _id: "p1",
  name: "Front Office Jacket",
  additionalNames: [],
  hsnCode: "",
  unit: "Pcs",
  baseSalesPrice: 1111,
  salesTax: null,
  genderCategory: "Male",
  category: "Outerwear",
  reference: "PROD-1",
  variants: [],
  ...over,
});

describe("sales items", () => {
  test("a Tally copy spelled differently is folded into the CMS item, not listed again", () => {
    const rows = salesCatalogue(
      [product({ hsnCode: "" })],
      [{ _id: "t1", name: "FRONT-OFFICE  JACKET", hsnCode: "6203", taxRate: 12 }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hsnCode: "6203", hsnSource: "tally", taxRate: 12, taxRateSource: "tally" });
  });

  test("a Tally item matching nothing is still offered, marked accounts-only", () => {
    const rows = salesCatalogue([], [{ _id: "t9", name: "Stitching charges", taxRate: 5 }]);
    expect(rows).toEqual([expect.objectContaining({ name: "Stitching charges", source: "tally", detail: "Accounts only" })]);
  });

  test("inactive and deleted products are left out", () => {
    const rows = salesCatalogue(
      [product({ _id: "a", isActive: false }), product({ _id: "b", deletedAt: new Date() }), product({ _id: "c" })],
      [],
    );
    expect(rows.map((r) => r._id)).toEqual(["c"]);
  });

  test("the men's and women's versions say which they are", () => {
    const rows = salesCatalogue([product({ _id: "m" }), product({ _id: "f", genderCategory: "Female", reference: "PROD-2" })], []);
    expect(rows.map((r) => r.detail)).toEqual(["Male · Outerwear · PROD-1", "Female · Outerwear · PROD-2"]);
  });

  test("the size's price wins over the base price, as on the proforma", () => {
    const rows = salesCatalogue(
      [product({ variants: [{ _id: "v1", salesPrice: 1492, attributes: [{ name: "Size", value: "30" }] }] })],
      [],
    );
    expect(rows[0]).toMatchObject({ standardSellingPrice: 1492, priceSource: "variant" });
  });

  test("sizes priced differently are offered one per size", () => {
    const rows = salesCatalogue(
      [product({ variants: [
        { _id: "v1", salesPrice: 1492, attributes: [{ name: "Size", value: "30" }] },
        { _id: "v2", salesPrice: 2600, attributes: [{ name: "Size", value: "44" }] },
      ] })],
      [],
    );
    expect(rows.map((r) => [r.name, r.standardSellingPrice, r.taxRate])).toEqual([
      ["Front Office Jacket · 30", 1492, 5],
      ["Front Office Jacket · 44", 2600, 18],
    ]);
    expect(rows.every((r) => r._id === "p1")).toBe(true);
  });

  test("GST: the product's own rate, else the 5% / 18% rule; never invented without a price", () => {
    expect(salesCatalogue([product({ salesTax: "GST 12%" })], [])[0]).toMatchObject({ taxRate: 12, taxRateSource: "product" });
    expect(salesCatalogue([product({ baseSalesPrice: 0 })], [])[0]).toMatchObject({ taxRate: null, taxRateSource: null });
    expect(garmentSlabRate(2498)).toBe(5);
    expect(garmentSlabRate(2499)).toBe(18);
  });
});

describe("purchase items", () => {
  const raw = (over = {}) => ({
    _id: "r1",
    name: "BOPP Bags",
    unit: "Kg",
    primaryVendor: "vA",
    vendorNicknames: [],
    variants: [{ _id: "x1", combination: ["Fancy Corner", "14*20"], vendorNicknames: [{ vendor: "vA", nickname: "bags", price: 280 }] }],
    ...over,
  });

  test("the latest purchase-order rate wins over the supplier's listed price", () => {
    const rows = purchaseCatalogue([raw()], [], [{ rawItem: "r1", variantId: "x1", unitPrice: 265 }, { rawItem: "r1", variantId: "x1", unitPrice: 240 }]);
    expect(rows[0]).toMatchObject({ standardCost: 265, priceSource: "purchase_order" });
  });

  test("with no order, the primary supplier's price on the variant", () => {
    expect(purchaseCatalogue([raw()], [], [])[0]).toMatchObject({ standardCost: 280, priceSource: "supplier" });
  });

  test("GST unknown is null, never 0 — so the form keeps its own rate", () => {
    expect(purchaseCatalogue([raw()], [], [])[0]).toMatchObject({ taxRate: null, hsnCode: "" });
  });

  test("HSN and GST come from the Tally twin, which is not listed again", () => {
    const rows = purchaseCatalogue([raw()], [{ _id: "t", name: "bopp-bags", hsnCode: "3923", taxRate: 18 }], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hsnCode: "3923", taxRate: 18, taxRateSource: "tally" });
  });

  test("a GST rate recorded on a purchase order is used when Tally has none", () => {
    const rows = purchaseCatalogue([raw()], [], [{ rawItem: "r1", variantId: "x1", unitPrice: 265, gstRate: 12 }]);
    expect(rows[0]).toMatchObject({ taxRate: 12, taxRateSource: "purchase_order" });
  });

  test("variants priced differently are offered one per variant", () => {
    const r = raw({ variants: [
      { _id: "x1", combination: ["14*20"], vendorNicknames: [{ vendor: "vA", price: 280 }] },
      { _id: "x2", combination: ["20*30"], vendorNicknames: [{ vendor: "vA", price: 310 }] },
    ] });
    expect(purchaseCatalogue([r], [], []).map((x) => [x.name, x.standardCost])).toEqual([
      ["BOPP Bags · 14*20", 280],
      ["BOPP Bags · 20*30", 310],
    ]);
  });
});

test("search matches names, aliases, HSN and SKU", () => {
  const row = { name: "BOPP Bags · 14*20", aliases: ["poly bag"], hsnCode: "3923", sku: "RAW-9" };
  expect(["bopp", "poly", "3923", "raw-9"].every((q) => matchesQuery(row, q))).toBe(true);
  expect(matchesQuery(row, "jacket")).toBe(false);
});
