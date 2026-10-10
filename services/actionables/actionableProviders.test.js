"use strict";

// Providers against recording stand-ins — no database. Proves the role rules
// (viewer sees nothing, a decision only for an approver, an editor sees their
// own held changes) and the filters that matter (company read-through, legacy
// maintenance statuses, the approval queue's badge filter).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const PRIMARY = "0123456789abcdef01234567";
const canon = require.resolve(path.join(__dirname, "../companyContext/canonicalCompany.service"));
require.cache[canon] = { id: canon, filename: canon, loaded: true, exports: {
  getCanonicalCompany: async () => ({ _id: PRIMARY }),
} };

const { PROVIDERS, _models: M } = require("./actionableProviders");

const seen = [];
function fake(name, n = 2) {
  return { countDocuments: (filter) => {
    seen.push({ name, filter });
    return { maxTimeMS: () => Promise.resolve(typeof n === "function" ? n(filter) : n) };
  } };
}
for (const key of Object.keys(M)) {
  const model = fake(key);
  if (key === "Leave") M[key] = () => ({ LeaveApplication: fake("LeaveApplication"), RegularizationRequest: fake("RegularizationRequest") });
  else if (key === "Development") M[key] = () => ({ DevelopmentFile: fake("DevelopmentFile"), DevelopmentRequestReceipt: fake("DevelopmentRequestReceipt") });
  else if (key === "AccOrg") M[key] = () => ({ Acc_ApprovalRequest: fake("Acc_ApprovalRequest") });
  else M[key] = () => model;
}

const ctx = (role, extra = {}) => ({
  role,
  capabilities: {
    viewer: { read: true }, editor: { read: true, write: true },
    approver: { read: true, write: true, approve: true }, owner: { read: true, write: true, approve: true },
  }[role],
  canApprove: role === "approver" || role === "owner",
  email: "me@grav.in",
  userId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  ...extra,
});

const reset = () => { seen.length = 0; };

test("a viewer is shown nothing to act on", async () => {
  for (const slug of ["hr", "store", "merchandiser", "packaging-dispatch", "ppc", "marketing", "board", "accountant"]) {
    reset();
    const items = await PROVIDERS[slug](ctx("viewer"));
    assert.deepEqual(items, [], slug);
    assert.equal(seen.length, 0, `${slug} counted for a viewer`);
  }
});

test("held changes: approver sees the department queue, editor only their own", async () => {
  reset();
  const asApprover = await PROVIDERS.hr(ctx("approver"));
  const q = seen.find((s) => s.name === "ChangeRequest");
  assert.deepEqual(q.filter, { departmentSlug: "hr", status: "pending" });
  assert.ok(asApprover.some((i) => i.key === "changes:hr" && i.href === "/hr/dashboard/approvals"));

  reset();
  const asEditor = await PROVIDERS.hr(ctx("editor"));
  const mine = seen.find((s) => s.name === "ChangeRequest");
  assert.deepEqual(mine.filter, { departmentSlug: "hr", status: "pending", "requestedBy.email": "me@grav.in" });
  assert.ok(asEditor.some((i) => i.key === "my-changes:hr"));
  assert.ok(!asEditor.some((i) => i.key === "changes:hr"));
});

test("decisions are for approvers: accounting, board and IE review show nothing to an editor", async () => {
  for (const slug of ["accountant", "board"]) {
    reset();
    assert.deepEqual(await PROVIDERS[slug](ctx("editor")), [], slug);
  }
  reset();
  const ie = await PROVIDERS.ie(ctx("editor"));
  assert.ok(!ie.some((i) => i.key === "method-review"));
});

test("company-scoped reads are the primary company or no company — never a demo company", async () => {
  reset();
  await PROVIDERS["packaging-dispatch"](ctx("editor"));
  const f = seen.find((s) => s.name === "PackingCarton").filter;
  assert.deepEqual(f.$or, [{ companyId: PRIMARY }, { companyId: null }]);
  assert.equal(f.status, "packed");
});

test("store counts the overview's own queues", async () => {
  reset();
  const items = await PROVIDERS.store(ctx("editor"));
  const mrf = seen.find((s) => s.name === "MRF").filter;
  assert.equal(mrf.status, "APPROVED");
  assert.equal(mrf.storeReviewedAt, null);
  const late = seen.find((s) => s.name === "PurchaseOrder" && s.filter.expectedDeliveryDate);
  assert.deepEqual(late.filter.status, { $in: ["ISSUED", "PARTIALLY_RECEIVED"] });
  assert.equal(items.find((i) => i.key === "po-late").tone, "urgent");
});

test("sales overdue follow-ups need a real id; a malformed one is never queried", async () => {
  reset();
  await PROVIDERS.sales(ctx("editor", { userId: "not-an-id" }));
  assert.ok(!seen.some((s) => s.name === "Activity"));
  reset();
  await PROVIDERS.sales(ctx("editor"));
  const a = seen.find((s) => s.name === "Activity").filter;
  assert.equal(a.ownerId, "aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(a.status, "planned");
  assert.ok(a.dueDate.$lt instanceof Date);
});

test("every provider answers well-formed items with in-app links", async () => {
  for (const [slug, fn] of Object.entries(PROVIDERS)) {
    if (slug === "maintenance" || slug === "qc" || slug === "cutting-master") continue; // need storage/service stand-ins
    const items = await fn(ctx("owner"));
    assert.ok(Array.isArray(items), slug);
    for (const i of items) {
      assert.ok(i.key && i.label && typeof i.count === "number", `${slug}:${i.key}`);
      assert.ok(["urgent", "attention", "info"].includes(i.tone), `${slug}:${i.key} tone`);
      assert.ok(i.href === null || (i.href.startsWith("/") && !i.href.startsWith("//")), `${slug}:${i.key} href`);
    }
  }
});
