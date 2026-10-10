// test/hr-ai/storeVocabulary.test.js
//
// THE WORDS GRAV PEOPLE USE — EACH ONE WORKS, MEANS ONE THING, AND SAYS WHY.
"use strict";

const service = require("../../services/ai/storeCommandSearch.service");
const { VOCABULARY } = require("../../services/ai/storeVocabulary");
const { ENTITY_SPECS } = require("../../services/storePurchaseUniversalContract");
const { seedStore, storeReaderFor } = require("../support/storeCommandFixtures");

let reader;
beforeEach(async () => {
  const store = await seedStore();
  reader = storeReaderFor(store.companyId);
});

const said = async (query) => (await service.search({ user: reader, query })).groups
  .flatMap((g) => g.results.map((r) => `${r.title} ${r.value || ""}`)).join(" || ");

test("every word belongs to a real family, says when and why, and means one thing", () => {
  const seen = new Map();
  for (const [entity, words] of Object.entries(VOCABULARY)) {
    expect(ENTITY_SPECS.some((spec) => spec.id === entity)).toBe(true);
    for (const entry of words) {
      expect(entry.why.length).toBeGreaterThan(10);
      expect(entry.added).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      /* A word that named two families would route by accident. */
      expect(seen.get(entry.word)).toBeUndefined();
      seen.set(entry.word, entity);
      /* And it is not already some OTHER family's own name. */
      const owners = ENTITY_SPECS.filter((spec) => spec.id !== entity
        && [spec.label, ...spec.aliases].some((a) => a.toLowerCase() === entry.word));
      expect(owners.map((spec) => spec.id)).toEqual([]);
    }
  }
});

test("a word people use answers exactly as the catalogue's own name does", async () => {
  expect(await said("pending indents")).toBe(await said("pending material requests"));
  expect(await said("inward")).toBe(await said("goods receipts"));
  expect(await said("godowns")).toBe(await said("warehouses"));
  expect(await said("how many POs")).toBe(await said("how many purchase orders"));
});
