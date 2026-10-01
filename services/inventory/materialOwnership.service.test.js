// services/inventory/materialOwnership.service.test.js
//
// The default-ownership rule: which words are accepted, what an absent field
// means on a create and on an edit, and that the result is one catalogue
// field and nothing that could move stock.
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("./materialOwnership.service");

test("the vocabulary is the two words the issuances already use", () => {
  assert.deepEqual(Object.values(S.DEFAULT_OWNERSHIP).sort(), ["COMPANY_OWNED", "CUSTOMER_OWNED"]);
  assert.equal(S.OWNERSHIP_WORDS.COMPANY_OWNED, "Company owned");
  assert.equal(S.OWNERSHIP_WORDS.CUSTOMER_OWNED, "Customer property");
});

test("a create that says nothing is company owned; an edit that says nothing keeps what is stored", () => {
  assert.deepEqual(S.normaliseOwnershipInput({}), { present: false, defaultOwnership: undefined });
  assert.deepEqual(S.resolveOwnership({ stored: null, payload: { name: "Poplin" } }), { changed: false, defaultOwnership: "COMPANY_OWNED" });
  assert.deepEqual(S.resolveOwnership({ stored: { defaultOwnership: "CUSTOMER_OWNED" }, payload: { name: "Renamed" } }), { changed: false, defaultOwnership: "CUSTOMER_OWNED" });
});

test("only the two supported words are accepted, in any case; an empty word is refused, not guessed", () => {
  assert.equal(S.normaliseOwnershipInput({ defaultOwnership: "customer_owned" }).defaultOwnership, "CUSTOMER_OWNED");
  assert.throws(() => S.normaliseOwnershipInput({ defaultOwnership: "LEASED" }), /COMPANY_OWNED or CUSTOMER_OWNED/);
  assert.throws(() => S.normaliseOwnershipInput({ defaultOwnership: "" }), /COMPANY_OWNED or CUSTOMER_OWNED/);
  assert.throws(() => S.normaliseOwnershipInput({ defaultOwnership: null }), /COMPANY_OWNED or CUSTOMER_OWNED/);
});

test("the result is exactly the one catalogue field — nothing here can move stock", () => {
  const on = S.resolveOwnership({ stored: { defaultOwnership: "COMPANY_OWNED", quantity: 30 }, payload: { defaultOwnership: "CUSTOMER_OWNED" } });
  assert.deepEqual(on, { changed: true, defaultOwnership: "CUSTOMER_OWNED" });
  assert.deepEqual(Object.keys(on).sort(), ["changed", "defaultOwnership"]);
  const off = S.resolveOwnership({ stored: { defaultOwnership: "CUSTOMER_OWNED" }, payload: { defaultOwnership: "COMPANY_OWNED" } });
  assert.deepEqual(off, { changed: true, defaultOwnership: "COMPANY_OWNED" });
  assert.equal(S.resolveOwnership({ stored: { defaultOwnership: "CUSTOMER_OWNED" }, payload: { defaultOwnership: "customer_owned" } }).changed, false);
});

test("ownershipView reads an item written before the field existed as company owned", () => {
  assert.deepEqual(S.ownershipView({}), { defaultOwnership: "COMPANY_OWNED", label: "Company owned" });
  assert.deepEqual(S.ownershipView({ defaultOwnership: "CUSTOMER_OWNED" }), { defaultOwnership: "CUSTOMER_OWNED", label: "Customer property" });
  assert.deepEqual(S.ownershipView({ defaultOwnership: "junk" }), { defaultOwnership: "COMPANY_OWNED", label: "Company owned" });
});
