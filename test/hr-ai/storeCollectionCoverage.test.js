// test/hr-ai/storeCollectionCoverage.test.js
//
// NO STORE COLLECTION IS UNREAD WITHOUT A REASON.
//
// The concept audit counts what the catalogue says; this counts what the
// models WRITE. Every collection a model in this repository writes is
// classified — read by the catalogue, read by the legacy `store` family,
// excluded with a reason, or owned by another application — and a Store
// model nobody reads and nobody explained fails here, in CI, before anybody
// has to discover the gap by asking for it.
//
// The live database adds collections no model writes; those are classified
// by `node scripts/audits/store-collection-coverage.js --live`, which needs
// the database and so is not run here.
"use strict";

const { audit } = require("../../scripts/audits/store-collection-coverage");
const own = require("../../services/ai/storeCollectionOwnership");
const { EXCLUDED_COLLECTIONS } = require("../../services/ai/storeCommandExclusions");

let result;
beforeAll(() => {
  result = audit();
});

describe("every collection a model writes is classified", () => {
  test("every model file loads", () => {
    expect(result.failures).toEqual([]);
    expect(result.files).toBeGreaterThan(250);
  });

  test("none is unclassified", () => {
    const unclassified = result.rows.filter((row) => row.category === own.CATEGORY.UNCLASSIFIED)
      .map((row) => `${row.name}: ${row.detail}`);
    expect(unclassified).toEqual([]);
  });

  test("and no declaration describes something that is not there", () => {
    expect(result.stale).toEqual([]);
  });

  test("every Store-owned collection is read by Store search, or excluded with a reason", () => {
    const store = result.rows.filter((row) => row.modelFiles.some((file) => own.ownerOfFile(file) === own.STORE));
    expect(store.length).toBeGreaterThan(50);
    for (const row of store) {
      expect([own.CATEGORY.CATALOGUED, own.CATEGORY.LEGACY, own.CATEGORY.EXCLUDED]).toContain(row.category);
    }
  });

  test("the stock collections the plan was unsure of are served by the legacy family", () => {
    const byName = new Map(result.rows.map((row) => [row.name, row]));
    for (const name of ["stockitems", "stockissuances", "storepurchaseorders", "purchaseordersettings"]) {
      expect(byName.get(name)?.category).toBe(own.CATEGORY.LEGACY);
    }
  });
});

describe("the gate fails when it should", () => {
  test("a Store model nothing reads is unclassified", () => {
    const out = own.classifyCollection({
      name: "a_new_store_thing",
      modelFiles: ["models/CMS_Models/StorePurchase/ANewStoreThing.js"],
    });
    expect(out.category).toBe(own.CATEGORY.UNCLASSIFIED);
  });

  test("a model put somewhere no owner is declared for is unclassified", () => {
    const out = own.classifyCollection({ name: "x", modelFiles: ["models/Somewhere/New.js"] });
    expect(out.category).toBe(own.CATEGORY.UNCLASSIFIED);
  });

  test("a model-less collection running code still names, with no owner declared, is unclassified", () => {
    const out = own.classifyCollection({ name: "never_declared", modelFiles: [], namedByCode: true });
    expect(out.category).toBe(own.CATEGORY.UNCLASSIFIED);
  });

  test("another application's model is not Store's to explain", () => {
    const out = own.classifyCollection({ name: "x", modelFiles: ["models/HR_Models/Leave.js"] });
    expect(out.category).toBe(own.CATEGORY.OTHER);
    expect(out.application).toBe("HR");
  });
});

describe("every exclusion says why and what answers instead", () => {
  test.each(Object.entries(EXCLUDED_COLLECTIONS))("%s", (name, entry) => {
    expect(entry.reason.length).toBeGreaterThan(60);
    expect(entry.instead.length).toBeGreaterThan(15);
  });
});
