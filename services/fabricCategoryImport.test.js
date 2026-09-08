// node --test services/fabricCategoryImport.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normaliseCategory, normaliseImport, specText } = require("./fabricCategoryImport");

test("a category with a shade list: codes are made from the name, the count follows the highest number", () => {
  const doc = normaliseCategory({
    name: " lapiz ",
    type: "Premium",
    hero: "Bottom",
    vendor: "Sparsh-Fab",
    vendorSeries: "Derby",
    composition: "67/33 pv",
    width: "142 cm",
    category: "suiting",
    shades: [
      { no: 2, vendorCode: "02", colour: "Navy" },
      { no: 1, vendorCode: "01", colour: "Ivory" },
    ],
  });
  assert.equal(doc.name, "LAPIZ");
  assert.equal(doc.type, "premium");
  assert.equal(doc.hero, "bottom");
  assert.equal(doc.spec, "67/33 PV 142 CM");
  assert.equal(doc.count, 2);
  assert.deepEqual(doc.shades.map((s) => s.code), ["LAPIZ-001", "LAPIZ-002"]);
  assert.equal(doc.shades[1].colour, "Navy");
});

test("without a shade list the count is required; blanks fall back to standard, right, other", () => {
  const doc = normaliseCategory({ name: "GEMINI", count: "24" });
  assert.deepEqual([doc.type, doc.hero, doc.category, doc.count, doc.shades.length], ["standard", "right", "other", 24, 0]);
  assert.throws(() => normaliseCategory({ name: "GEMINI" }), /how many colours/);
  assert.throws(() => normaliseCategory({ name: "GEMINI", count: 151 }), /over the 150/);
  assert.throws(() => normaliseCategory({ name: "", count: 4 }), /name is missing/);
  assert.throws(() => normaliseCategory({ name: "X", count: 4, type: "gold" }), /leaf type/);
  assert.throws(() => normaliseCategory({ name: "X", count: 4, hero: "left" }), /big box/);
  assert.throws(() => normaliseCategory({ name: "X", count: 4, category: "curtains" }), /category/);
  assert.throws(() => normaliseCategory({ name: "X", shades: [{ no: 1 }, { no: 1 }] }), /appears twice/);
  assert.throws(() => normaliseCategory({ name: "X", shades: [{ no: 0 }] }), /Ray&Co number/);
});

test("an import is all or nothing: every problem is listed, nothing is returned for storing", () => {
  const ok = normaliseImport([{ name: "A", count: 3 }, { name: "B", count: 4 }]);
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.categories.length, 2);
  const bad = normaliseImport([{ name: "A", count: 3 }, { name: "a", count: 5 }, { name: "C" }]);
  assert.deepEqual(bad.errors.map((e) => e.name), ["A", "C"]);
  assert.match(bad.errors[0].message, /appears twice/);
  assert.equal(normaliseImport([]).errors.length, 1);
  assert.equal(specText({ composition: "", width: "" }), "");
});
