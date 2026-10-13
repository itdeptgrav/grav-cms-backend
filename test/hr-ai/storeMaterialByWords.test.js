// test/hr-ai/storeMaterialByWords.test.js
//
// A MATERIAL IS THE ONE EVERY WORD BELONGS TO — NOT THE SHORT NAME INSIDE.
//
// Found by voice on 9 Oct 2026: "stock of feed of the arm folder" answered
// about an item called just "Folder" (its whole name sits inside the words),
// while "Feed of the Arm folder 1/4" — which every word said belongs to — lost
// for want of the "1/4" nobody says aloud.
"use strict";

const mongoose = require("mongoose");
const service = require("../../services/ai/storeCommandSearch.service");
const { seedStore, storeReaderFor } = require("../support/storeCommandFixtures");

let reader;
beforeEach(async () => {
  const store = await seedStore();
  reader = storeReaderFor(store.companyId);
  const item = (name, sku, quantity) => ({
    _id: new mongoose.Types.ObjectId(), companyId: store.companyId, name, sku, quantity, unit: "Pcs",
    variants: [], deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
  });
  await mongoose.connection.collection("rawitems").insertMany([
    item("Folder", "RAW-MAC-FOL-692", 0),
    item("Feed of the Arm folder 1/4", "RAW-MAC-FEEOFTHEARMFOL1/4-907", 2),
    item("Placket Folder 3/8", "RAW-MAC-PLAFOL3/8-111", 1),
  ]);
});

const ask = (query) => service.search({ user: reader, query });
const said = (out) => JSON.stringify(out.groups || []);

test("every word said belongs to one item: that item, not the short name inside", async () => {
  const out = await ask("stock of feed of the arm folder");
  expect(said(out)).toMatch(/Feed of the Arm folder 1\/4/);
  expect(said(out)).not.toMatch(/RAW-MAC-FOL-692/);
});

test("the short name alone still finds the short-named item", async () => {
  expect(said(await ask("stock of folder"))).toMatch(/RAW-MAC-FOL-692/);
});

test("words that fit a longer name find it, never the short name inside", async () => {
  const out = await ask("stock of placket folder");
  expect(said(out)).toMatch(/Placket Folder 3\/8/);
  expect(said(out)).not.toMatch(/RAW-MAC-FOL-692/);
});

describe("nothing exact: the closest, with a warning — never for a narrower question", () => {
  test("a name said loosely finds its record, marked as a near match", async () => {
    const out = await ask("Feed Off Arm");
    expect(out.state).toBe("answered");
    expect(out.note).toBe('No exact match for "Feed Off Arm" — closest matches.');
    const [first] = out.groups[0].results;
    expect(first.title).toBe("Feed of the Arm folder 1/4");
    expect(first.metadata.approximate).toBe(true);
    expect(said(await ask("plaket foldr"))).toMatch(/Placket Folder 3\/8/);
  });

  test("a document number, a filter or nonsense still finds nothing", async () => {
    expect((await ask("PO/2026-27/9999")).state).toBe("no_match");
    expect((await ask("zzz qqq")).state).toMatch(/no_match|unsupported/);
    /* A filtered question keeps its own answer ("No matching purchase orders
       were found") — and is never padded with near matches. */
    const filtered = await ask("pending purchase orders from Nobody Traders");
    expect((filtered.groups || []).flatMap((g) => g.results).some((r) => r.metadata?.approximate)).toBe(false);
  });
});
