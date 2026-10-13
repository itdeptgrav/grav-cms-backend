const {
  salesCatalogue,
  purchaseCatalogue,
  billHistory,
  garmentSlabRate,
  matchesQuery,
} = require("../../services/accounting/voucherItemCatalogue");

const noBills = billHistory([]);
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

describe("sales items — from the CMS only", () => {
  test("the chosen customer's PI lines come first, with the PI's price, GST, HSN and name", () => {
    const rows = salesCatalogue([product()], noBills, [
      { stockItemId: "p1", itemName: "Front Office Jacket — 30 (Male)", hsnCode: "6203", unitPrice: 1400, gstPercentage: 5, quotationNumber: "QT-9", forCustomer: true },
      { stockItemId: "p1", itemName: "Front Office Jacket — 30 (Male)", hsnCode: "", unitPrice: 999, gstPercentage: 5, quotationNumber: "QT-1", forCustomer: false },
    ]);
    expect(rows[0]).toMatchObject({
      name: "Front Office Jacket — 30 (Male)", standardSellingPrice: 1400, taxRate: 5,
      hsnCode: "6203", priceSource: "pi", piNumber: "QT-9",
    });
    expect(rows.filter((r) => r.source === "pi")).toHaveLength(1);
  });

  test("another customer's PI never sets this customer's price, but its HSN is used", () => {
    const rows = salesCatalogue([product()], noBills, [
      { stockItemId: "p1", itemName: "x", hsnCode: "6203", unitPrice: 999, gstPercentage: 5, forCustomer: false },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ standardSellingPrice: 1111, hsnCode: "6203", hsnSource: "pi" });
  });

  test("HSN and GST from the latest earlier sales bill when the product has none", () => {
    const bills = billHistory([
      { stockItemName: "FRONT OFFICE JACKET", hsnCode: "", taxRate: 12, rate: 1300 },
      { stockItemId: "p1", hsnCode: "6201", taxRate: 5, rate: 1200 },
    ]);
    expect(salesCatalogue([product()], bills)[0]).toMatchObject({ hsnCode: "6201", hsnSource: "bill", taxRate: 5, taxRateSource: "bill" });
  });

  test("inactive and deleted products are left out", () => {
    const rows = salesCatalogue([product({ _id: "a", isActive: false }), product({ _id: "b", deletedAt: new Date() }), product({ _id: "c" })], noBills);
    expect(rows.map((r) => r._id)).toEqual(["c"]);
  });

  test("the men's and women's versions say which they are", () => {
    const rows = salesCatalogue([product({ _id: "m" }), product({ _id: "f", genderCategory: "Female", reference: "PROD-2" })], noBills);
    expect(rows.map((r) => r.detail)).toEqual(["Male · Outerwear · PROD-1", "Female · Outerwear · PROD-2"]);
  });

  test("sizes priced differently are offered one per size, GST by the slab", () => {
    const rows = salesCatalogue([product({ variants: [
      { _id: "v1", salesPrice: 1492, attributes: [{ name: "Size", value: "30" }] },
      { _id: "v2", salesPrice: 2600, attributes: [{ name: "Size", value: "44" }] },
    ] })], noBills);
    expect(rows.map((r) => [r.name, r.standardSellingPrice, r.taxRate])).toEqual([
      ["Front Office Jacket · 30", 1492, 5],
      ["Front Office Jacket · 44", 2600, 18],
    ]);
  });

  test("the slab is the PI's: 5% below 2,499, 18% from it; none without a price", () => {
    expect(garmentSlabRate(2498)).toBe(5);
    expect(garmentSlabRate(2499)).toBe(18);
    expect(salesCatalogue([product({ baseSalesPrice: 0 })], noBills)[0]).toMatchObject({ taxRate: null });
  });
});

describe("purchase items — from the CMS only", () => {
  const raw = (over = {}) => ({
    _id: "r1",
    name: "BOPP Bags",
    unit: "Kg",
    primaryVendor: "vA",
    vendorNicknames: [],
    variants: [{ _id: "x1", combination: ["14*20"], vendorNicknames: [{ vendor: "vA", price: 280 }] }],
    ...over,
  });

  test("the latest purchase-order rate wins", () => {
    const rows = purchaseCatalogue([raw()], noBills, [{ rawItem: "r1", variantId: "x1", unitPrice: 265 }, { rawItem: "r1", variantId: "x1", unitPrice: 240 }]);
    expect(rows[0]).toMatchObject({ standardCost: 265, priceSource: "purchase_order" });
  });

  test("with no order, the supplier's price; with neither, the last bill", () => {
    expect(purchaseCatalogue([raw()], noBills)[0]).toMatchObject({ standardCost: 280, priceSource: "supplier" });
    const bills = billHistory([{ stockItemName: "bopp bags", rate: 300 }]);
    expect(purchaseCatalogue([raw({ variants: [] })], bills)[0]).toMatchObject({ standardCost: 300, priceSource: "bill" });
  });

  test("HSN and GST from the latest purchase bill for it", () => {
    const bills = billHistory([{ stockItemId: "r1", hsnCode: "3923", taxRate: 18 }]);
    expect(purchaseCatalogue([raw()], bills)[0]).toMatchObject({ hsnCode: "3923", taxRate: 18, taxRateSource: "bill" });
  });

  test("a GST rate on a purchase order beats an older bill", () => {
    const bills = billHistory([{ stockItemId: "r1", taxRate: 18 }]);
    expect(purchaseCatalogue([raw()], bills, [{ rawItem: "r1", variantId: "x1", unitPrice: 265, gstRate: 12 }])[0])
      .toMatchObject({ taxRate: 12, taxRateSource: "purchase_order" });
  });

  test("GST unknown is null, never 0 — the form keeps its own rate", () => {
    expect(purchaseCatalogue([raw()], noBills)[0]).toMatchObject({ taxRate: null, hsnCode: "" });
  });

  test("variants priced differently are offered one per variant", () => {
    const r = raw({ variants: [
      { _id: "x1", combination: ["14*20"], vendorNicknames: [{ vendor: "vA", price: 280 }] },
      { _id: "x2", combination: ["20*30"], vendorNicknames: [{ vendor: "vA", price: 310 }] },
    ] });
    expect(purchaseCatalogue([r], noBills).map((x) => [x.name, x.standardCost])).toEqual([
      ["BOPP Bags · 14*20", 280],
      ["BOPP Bags · 20*30", 310],
    ]);
  });
});

test("a bill with no HSN does not hide an older bill that had one", () => {
  const h = billHistory([{ stockItemId: "a", hsnCode: "", rate: 10 }, { stockItemId: "a", hsnCode: "5208", rate: 9 }]);
  expect(h.of("a")).toEqual({ hsnCode: "5208", rate: 10 });
});

test("search matches names, aliases, HSN, SKU and the PI number", () => {
  const row = { name: "BOPP Bags · 14*20", aliases: ["poly bag"], hsnCode: "3923", sku: "RAW-9", piNumber: "QT-77" };
  expect(["bopp", "poly", "3923", "raw-9", "qt-77"].every((q) => matchesQuery(row, q))).toBe(true);
  expect(matchesQuery(row, "jacket")).toBe(false);
});
