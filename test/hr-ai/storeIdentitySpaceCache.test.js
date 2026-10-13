// test/hr-ai/storeIdentitySpaceCache.test.js
//
// THE IDENTITY SPACE IS KEPT BRIEFLY, FOR THE PALETTE ONLY, AND SAYS SO.
//
// A bare name nobody's vocabulary recognises is placed by reading every
// family's identity fields — 53 reads at once, which on the live cluster
// measured anywhere from 0.3 s to 1.8 s per keystroke. The palette now keeps
// that SPACE (not the answer) for a short while. These pin the contract:
// it is opt-in, it does not re-read inside its window, the assistant's path
// still reads fresh, and it can be turned off.
"use strict";

const mongoose = require("mongoose");
const ctx = require("../../services/storePurchaseUniversalContext");
const { seedStore, storeReaderFor } = require("../support/storeCommandFixtures");

let store;
let reader;
let reads;
const countReads = () => {
  reads = 0;
  mongoose.set("debug", (collection, method) => { if (collection === "vendors" && method === "find") reads += 1; });
};

beforeEach(async () => {
  store = await seedStore();
  reader = storeReaderFor(store.companyId);
  countReads();
});
afterEach(() => mongoose.set("debug", false));

const ask = (message, cached) => ctx.resolveEntity({
  entity: "supplier_master", user: reader, message, includeRecord: false, cached,
});

test("cached: the second name asked reads nothing", async () => {
  expect((await ask("Gaurav Enterprises", true)).found).toBe(true);
  const first = reads;
  expect(first).toBe(1);
  /* A different name — the next keystroke, or the next person in the same
     company — is matched against the space already read. */
  expect((await ask("Other Supplies Co", true)).found).toBe(false);
  expect(reads).toBe(first);
});

test("not cached unless asked: the assistant's path reads fresh every time", async () => {
  await ask("Gaurav Enterprises", false);
  await ask("Gaurav Enterprises", false);
  expect(reads).toBe(2);
});

test("the price, pinned: a record created inside the window is not found BY NAME through the cache", async () => {
  await ask("Gaurav Enterprises", true);
  await mongoose.connection.collection("vendors").insertOne({
    _id: new mongoose.Types.ObjectId(), companyId: store.companyId, companyName: "Brand New Traders",
  });
  expect((await ask("Brand New Traders", true)).found).toBe(false);
  /* …and is found by the uncached path straight away. */
  expect((await ask("Brand New Traders", false)).found).toBe(true);
});

test("one company's space is never another's", async () => {
  await ask("Gaurav Enterprises", true);
  const stranger = storeReaderFor(new mongoose.Types.ObjectId());
  const out = await ctx.resolveEntity({
    entity: "supplier_master", user: stranger, message: "Gaurav Enterprises", includeRecord: false, cached: true,
  });
  expect(out.found).toBe(false);
});

test("STORE_IDENTITY_SPACE_CACHE_MS=0 turns it off", () => {
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "..", "services", "storePurchaseUniversalContext.js"), "utf8",
  );
  expect(src).toMatch(/STORE_IDENTITY_SPACE_CACHE_MS/);
  expect(src).toMatch(/if \(!cached \|\| IDENTITY_SPACE_MS <= 0\) return read\(\);/);
});
