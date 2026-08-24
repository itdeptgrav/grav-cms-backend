const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ensureOrderLink } = require("./orderBookLink");

/* Minimal stand-ins for the three mongoose models. Each mimics only the calls
   ensureOrderLink actually makes, including the chained .select()/.sort()/.lean(). */
const chain = (value) => {
  const c = { select: () => c, sort: () => c, lean: async () => value };
  return c;
};
const models = ({ enquiry = null, account = null, request = null, onSave } = {}) => ({
  Enquiry: { findOne: async () => (enquiry ? { ...enquiry, save: async function () { onSave?.(this); } } : null) },
  Account: { findById: () => chain(account) },
  CustomerRequest: { findOne: () => chain(request) },
});

const JOURNEY = { _id: "j1", accountId: "a1" };

test("links the enquiry to the account's newest order record", async () => {
  let saved = null;
  const res = await ensureOrderLink(JOURNEY, models({
    enquiry: { customerRequestId: null },
    account: { linkedCustomer: "cust1" },
    request: { _id: "req9", requestId: "REQ-2026-0009" },
    onSave: (doc) => { saved = doc; },
  }));
  assert.equal(res.linked, true);
  assert.equal(res.reason, "linked");
  assert.equal(res.requestId, "REQ-2026-0009");
  assert.equal(saved.customerRequestId, "req9", "the id must actually be written to the enquiry");
});

test("an already-linked enquiry is left alone — no second write", async () => {
  let wrote = false;
  const res = await ensureOrderLink(JOURNEY, models({
    enquiry: { customerRequestId: "existing" },
    account: { linkedCustomer: "cust1" },
    request: { _id: "req9" },
    onSave: () => { wrote = true; },
  }));
  assert.equal(res.reason, "already-linked");
  assert.equal(res.customerRequestId, "existing");
  assert.equal(wrote, false, "must not overwrite a link that already exists");
});

/* The four ways this legitimately cannot resolve. Each must report WHY and must
   not throw — a PO is recorded whether or not the link is made. */
for (const [name, opts, reason] of [
  ["no enquiry on the journey", { enquiry: null }, "no-enquiry-on-journey"],
  ["account not linked to a portal customer", { enquiry: { customerRequestId: null }, account: { linkedCustomer: null } }, "account-not-linked-to-portal-customer"],
  ["customer has no order record yet", { enquiry: { customerRequestId: null }, account: { linkedCustomer: "cust1" }, request: null }, "no-order-record-for-this-customer"],
]) {
  test(`reports "${reason}" when ${name}`, async () => {
    const res = await ensureOrderLink(JOURNEY, models(opts));
    assert.equal(res.linked, false);
    assert.equal(res.reason, reason);
  });
}

test("a journey with no account resolves nothing and does not throw", async () => {
  const res = await ensureOrderLink({ _id: "j1", accountId: null }, models({ enquiry: { customerRequestId: null } }));
  assert.equal(res.linked, false);
  assert.equal(res.reason, "journey-has-no-account");
});

test("a thrown model error is swallowed, never propagated to the PO save", async () => {
  const res = await ensureOrderLink(JOURNEY, {
    Enquiry: { findOne: async () => { throw new Error("mongo is down"); } },
    Account: {}, CustomerRequest: {},
  });
  assert.equal(res.linked, false);
  assert.equal(res.reason, "error");
});

test("it never creates a CustomerRequest", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "orderBookLink.js"), "utf8");
  assert.ok(!/CustomerRequest\.create|new CustomerRequest\(/.test(src),
    "linking only: creating one needs a portal customerId this path cannot honestly supply");
});
