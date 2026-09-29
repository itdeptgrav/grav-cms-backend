// services/inventory/materialOwnership.service.test.js
//
// The default-ownership rule, held without a database: the lookups are
// injected, so what is pinned here is the DECISION — which words are
// accepted, when a customer is required, when a stale one is cleared, and
// that the result is two catalogue fields and nothing that could move stock.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const S = require("./materialOwnership.service");

const id = () => new mongoose.Types.ObjectId();
const customer = (over = {}) => ({
  _id: id(), name: "Northwind Apparel", customerId: "CUST-0007", isActive: true,
  profile: { companyName: "Northwind Ltd" }, ...over,
});
/* A multi-company deployment where `linked` is the one customer this company
   holds a record for. */
const deps = ({ found = null, linked = new Set(), sole = false } = {}) => ({
  findCustomer: async (cid) => (found && String(found._id) === String(cid) ? found : null),
  reach: async () => ({ companyId: id(), allowUnowned: sole, clause: {} }),
  resolveLink: async ({ customerId }) => ({ state: linked.has(String(customerId)) ? "LINKED" : "ABSENT" }),
});
const tenant = { companyId: id() };

test("the vocabulary is the two words the issuances already use", () => {
  assert.deepEqual(Object.values(S.DEFAULT_OWNERSHIP).sort(), ["COMPANY_OWNED", "CUSTOMER_OWNED"]);
  assert.equal(S.OWNERSHIP_WORDS.COMPANY_OWNED, "Company owned");
  assert.equal(S.OWNERSHIP_WORDS.CUSTOMER_OWNED, "Customer property");
});

test("a payload that says nothing is not a change; the default is company owned", () => {
  assert.deepEqual(S.normaliseOwnershipInput({}), { present: false, defaultOwnership: undefined, owningCustomerId: undefined });
  const d = S.decideOwnership({ stored: null, payload: { name: "Poplin" } });
  assert.equal(d.changed, false);
  assert.equal(d.defaultOwnership, "COMPANY_OWNED");
  assert.equal(d.owningCustomerId, null);
});

test("only the two supported words are accepted, in any case", () => {
  assert.equal(S.normaliseOwnershipInput({ defaultOwnership: "customer_owned" }).defaultOwnership, "CUSTOMER_OWNED");
  assert.throws(() => S.normaliseOwnershipInput({ defaultOwnership: "LEASED" }), /COMPANY_OWNED or CUSTOMER_OWNED/);
  assert.throws(() => S.normaliseOwnershipInput({ defaultOwnership: "" }), /COMPANY_OWNED or CUSTOMER_OWNED/);
  assert.throws(() => S.normaliseOwnershipInput({ owningCustomerId: "not-an-id" }), /customer reference/);
});

test("company owned never keeps a customer — a stale id is cleared, not stored", () => {
  const stale = String(id());
  const d = S.decideOwnership({
    stored: { defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: stale },
    payload: { defaultOwnership: "COMPANY_OWNED", owningCustomerId: stale },
  });
  assert.deepEqual(d, { changed: true, defaultOwnership: "COMPANY_OWNED", owningCustomerId: null, customerToProve: null });
});

test("customer owned without a customer is refused before anything is looked up", () => {
  assert.throws(
    () => S.decideOwnership({ stored: null, payload: { defaultOwnership: "CUSTOMER_OWNED" } }),
    (e) => e.details?.reason === "OWNING_CUSTOMER_REQUIRED",
  );
  assert.throws(
    () => S.decideOwnership({ stored: null, payload: { defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: "" } }),
    (e) => e.details?.reason === "OWNING_CUSTOMER_REQUIRED",
  );
});

test("an edit that names only the ownership keeps the stored customer, and proves it again", () => {
  const kept = String(id());
  const d = S.decideOwnership({
    stored: { defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: kept },
    payload: { defaultOwnership: "CUSTOMER_OWNED" },
  });
  assert.equal(d.owningCustomerId, kept);
  assert.equal(d.customerToProve, kept);
});

test("a reachable, active customer is resolved to its id and a display snapshot", async () => {
  const c = customer();
  const r = await S.resolveOwnership(tenant, {
    payload: { defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: String(c._id) },
    deps: deps({ found: c, linked: new Set([String(c._id)]) }),
  });
  assert.equal(r.changed, true);
  assert.equal(r.defaultOwnership, "CUSTOMER_OWNED");
  assert.equal(String(r.owningCustomerId), String(c._id));
  assert.deepEqual(r.owningCustomer, { customerCode: "CUST-0007", customerLabel: "Northwind Ltd", customerName: "Northwind Apparel" });
  /* The shape is exactly the catalogue fields: nothing here can move stock. */
  assert.deepEqual(Object.keys(r).sort(), ["changed", "defaultOwnership", "owningCustomer", "owningCustomerId"]);
});

test("a customer this company cannot reach, a missing one and an inactive one share one refusal", async () => {
  const foreign = customer();
  const inactive = customer({ isActive: false });
  for (const [label, found, linked] of [
    ["foreign", foreign, new Set()],
    ["missing", null, new Set()],
    ["inactive", inactive, new Set([String(inactive._id)])],
  ]) {
    const target = found || customer();
    await assert.rejects(
      () => S.resolveOwnership(tenant, {
        payload: { defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: String(target._id) },
        deps: deps({ found, linked }),
      }),
      (e) => e.details?.reason === "OWNING_CUSTOMER_NOT_FOUND" && e.message === S.CUSTOMER_NOT_AVAILABLE,
      label,
    );
  }
});

test("in a sole-company deployment every active customer is within reach", async () => {
  const c = customer();
  const r = await S.resolveOwnership(tenant, {
    payload: { defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: String(c._id) },
    deps: deps({ found: c, sole: true }),
  });
  assert.equal(String(r.owningCustomerId), String(c._id));
});

test("switching back to company owned returns the empty snapshot, whatever was stored", async () => {
  const r = await S.resolveOwnership(tenant, {
    stored: { defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: id(), owningCustomer: { customerLabel: "Old" } },
    payload: { defaultOwnership: "COMPANY_OWNED" },
    deps: deps(),
  });
  assert.deepEqual(r, {
    changed: true, defaultOwnership: "COMPANY_OWNED", owningCustomerId: null,
    owningCustomer: { customerCode: "", customerLabel: "", customerName: "" },
  });
});

test("ownershipView reads an item written before the field existed as company owned", () => {
  assert.deepEqual(S.ownershipView({}), { defaultOwnership: "COMPANY_OWNED", label: "Company owned", customer: null });
  const cid = id();
  assert.deepEqual(
    S.ownershipView({ defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: cid, owningCustomer: { customerLabel: "Northwind Ltd", customerName: "Northwind Apparel", customerCode: "CUST-0007" } }),
    { defaultOwnership: "CUSTOMER_OWNED", label: "Customer property", customer: { id: String(cid), label: "Northwind Ltd", name: "Northwind Apparel", code: "CUST-0007" } },
  );
  /* A customer-owned word with no id is shown as customer property with no
     customer — never invented one. */
  assert.equal(S.ownershipView({ defaultOwnership: "CUSTOMER_OWNED" }).customer, null);
});

test("the search offers only customers the save would accept", async () => {
  const a = customer({ name: "Alpha" });
  const b = customer({ name: "Beta", customerId: "CUST-0008" });
  const rows = await S.searchCustomers(tenant, { q: "a" }, {
    deps: {
      findCustomers: async () => [a, b],
      reach: async () => ({ companyId: id(), allowUnowned: false, clause: {} }),
      resolveLink: async ({ customerId }) => ({ state: String(customerId) === String(a._id) ? "REPAIRABLE" : "ABSENT" }),
    },
  });
  assert.deepEqual(rows, [{ id: String(a._id), label: "Northwind Ltd", name: "Alpha", code: "CUST-0007" }]);
});
