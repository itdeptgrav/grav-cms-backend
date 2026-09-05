// test/store-purchase/po-receipt.route.test.js
//
// Store & Purchase professionalisation — Chunk 0 harness, updated by Chunk 1.
//
// ── WHAT CHANGED, AND WHY THESE PINS MOVED ──────────────────────────────────
// Chunk 0 wrote this file to pin the operational Purchase Order chain AS IT
// WAS, including behaviour the product plan calls unsafe, so that a refactor
// could not change it by accident. It said: "when a later chunk fixes one of
// those, ITS OWN tests replace the pin here."
//
// Chunk 1 is that chunk for four of them, and each pin below is rewritten to
// assert the fix rather than deleted:
//   · "any authenticated role can create a PO"      → now requires sp.po.create
//   · "every user sees every PO, no company scoping" → now tenant-scoped
//   · "a duplicate receipt is silently accepted"     → now replayed, not repeated
//   · "PO numbers are PO+YYMM+random"                → now atomically allocated
//
// The pins Chunk 1 did NOT fix are still characterisation and still here:
//   (one of them, the vendor return, was since governed by Chunk 1C)
//   · /api/cms/units answers with no token at all      (still true)
//   · Chunk 1C governed the returns router: cancelling still keeps the
//     deduction (deliberate), but the route now needs a key and a capability
//   · Store records supplier payments                  (Chunk 8)
//   · the worksheet PO register moves no stock         (Chunk 6)
//
// The upstream half of the chain (intake → manager → classification → store
// fulfilment → finance approval → commitment → spend-to-PO conversion) is
// already protected by test/requests/*.route.test.js. This file protects the
// downstream half those suites stop short of: the PO document itself and
// what receiving does to stock.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

/* The PO router notifies the CEO and emails vendors on ISSUE. Both reach the
 * network; both are best-effort in the route (errors swallowed). Stubbed so
 * tests exercise the document flow, not Brevo/web-push. */
jest.mock("../../services/VendorEmailService", () => ({
  sendPurchaseOrderEmail: jest.fn(() => Promise.resolve()),
}));
jest.mock("../../services/NotificationService", () => ({
  sendToRole: jest.fn(() => Promise.resolve()),
  sendToUser: jest.fn(() => Promise.resolve()),
}));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

// The PO routes populate createdBy/approvedBy/receivedBy against the
// ProjectManager model; requiring it registers the schema mongoose's
// populate needs (a MissingSchemaError otherwise 500s every read).
require("../../models/ProjectManager");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const StorePurchaseOrder = require("../../models/CMS_Models/Store/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
const SpApprovalPolicy = require("../../models/CMS_Models/StorePurchase/SpApprovalPolicy");
const SpIdempotencyRecord = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Mounted exactly as server.js mounts them.
  app.use(
    "/api/cms/inventory/operations/purchase-orders",
    require("../../routes/CMS_Routes/Inventory/Operations/purchaseOrders"),
  );
  app.use(
    "/api/cms/inventory/operations/purchase-orders/:poId/returns",
    require("../../routes/CMS_Routes/Inventory/Operations/returnRequests"),
  );
  app.use(
    "/api/cms/store/purchase-orders",
    require("../../routes/CMS_Routes/Store/purchaseOrderRoutes"),
  );
  // server.js mounts the units router with NO auth middleware, and the router
  // itself applies none. Mounted the same way so that fact stays pinned.
  app.use("/api/cms/units", require("../../routes/CMS_Routes/Inventory/Configurations/units"));
  app.use("/api/cms/store-purchase", require("../../routes/CMS_Routes/StorePurchase/context"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

/* EmployeeAuthMiddlewear verifies the JWT and nothing else — it never loads
 * the user, checks a role, or scopes a company. The token below is exactly
 * what routes/login.js signs. */
const tokenFor = (over = {}) =>
  jwt.sign(
    {
      id: String(new mongoose.Types.ObjectId()),
      role: "store_manager",
      employeeId: `ST${seq}`,
      name: "Test Store",
      email: "store@test.example",
      ...over,
    },
    process.env.JWT_SECRET || "grav_clothing_secret_key",
    { expiresIn: "10m" },
  );

const call = (path, { method = "GET", body, token = tokenFor(), auth = true, idempotencyKey } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({
    status: r.status,
    body: JSON.parse((await r.text()) || "null"),
    replayed: r.headers.get("Idempotency-Replayed") === "true",
  }));

/**
 * An actor with a proven company and a real department grant.
 *
 * Chunk 1 made both necessary: a token alone no longer reaches any of these
 * routes. `role` here is the DEPARTMENT-GRANT role (viewer/editor/approver/
 * owner) from models/Access/DepartmentRole.js — not the legacy JWT role,
 * which now decides nothing.
 */
async function actor({ company, grant = "store", role = "approver", name = "Tester" } = {}) {
  const n = ++seq;
  const email = `sp${n}@test.example`;
  const employeeRef = new mongoose.Types.ObjectId();
  if (grant) {
    await DepartmentRole.create({ departmentSlug: grant, email, role, name, isActive: true });
  }
  if (company) {
    await SpCompanyMembership.create({ companyId: company._id, email, employeeRef, personName: name });
  }
  return {
    email,
    employeeRef,
    token: tokenFor({ id: String(employeeRef), email, name }),
  };
}

/**
 * An approval policy for a company.
 *
 * Issuance now FAILS CLOSED without one: an unconfigured company cannot
 * commit money. Every test that issues an order therefore configures the
 * company first, exactly as a real deployment must.
 */
const givePolicy = (companyId, over = {}) =>
  SpApprovalPolicy.create({
    companyId, documentType: "PURCHASE_ORDER", minAmount: 0, maxAmount: null,
    levels: [{ level: 1, requiredCapability: "sp.po.issue" }], ...over,
  });

/** Two distinct companies, so tenancy is exercised rather than assumed. */
async function companies({ withPolicy = true } = {}) {
  const a = await Acc_Company.create({ companyName: `Acme ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const b = await Acc_Company.create({ companyName: `Borealis ${++seq}`, booksFromDate: new Date("2026-04-01") });
  if (withPolicy) { await givePolicy(a._id); await givePolicy(b._id); }
  return { a, b };
}

/** One key per user action, as a browser would generate it. */
const newKey = () => `test-key-${++seq}-${Math.random().toString(36).slice(2)}`;

async function seed({ stockQty = 0 } = {}) {
  const n = ++seq;
  const vendor = await Vendor.create({
    companyName: `Vendor ${n}`, contactPerson: "V", phone: "9", status: "Active",
  });
  const raw = await RawItem.create({
    name: `Canvas ${n}`, sku: `CNV-${n}`, unit: "pcs", quantity: stockQty, minStock: 0,
  });
  return { vendor, raw };
}

const poBody = ({ vendor, raw }, over = {}) => ({
  vendor: String(vendor._id),
  vendorName: vendor.companyName,
  items: [{ rawItem: String(raw._id), itemName: raw.name, quantity: 100, unitPrice: 5, unit: "pcs" }],
  ...over,
});

const OPS = "/api/cms/inventory/operations/purchase-orders";

/* ═══ 1 · AUTHENTICATION IS NO LONGER THE ONLY GATE ══════════════════════ */

describe("authentication and authorisation", () => {
  test("no token, no purchase orders — read and write both refuse", async () => {
    expect((await call(OPS, { auth: false })).status).toBe(401);
    expect((await call(OPS, { method: "POST", body: {}, auth: false })).status).toBe(401);
  });

  test("FIXED IN CHUNK 1: an authenticated user with no grant can no longer create a PO", async () => {
    // Chunk 0 pinned the opposite — "any authenticated role can create a PO,
    // there is no server-side authorisation" — and it was true: a sales login
    // could raise a purchase order. Authentication is not authorisation.
    const { a } = await companies();
    const outsider = await actor({ company: a, grant: null });
    const s = await seed();
    const res = await call(OPS, {
      method: "POST", body: poBody(s), token: outsider.token, idempotencyKey: newKey(),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    // The refusal names no internal capability key in its prose.
    expect(res.body.message).not.toMatch(/sp\./);
  });

  test("FIXED IN CHUNK 1: creation cannot mint an ISSUED order", async () => {
    /* Chunk 0 pinned that POST accepted `status: "ISSUED"` — and even
       "COMPLETED" — so a holder of sp.po.create alone could issue an order
       with no issue capability, no approval policy and no approvedBy, while
       the supplier was emailed on the way past. */
    const { a } = await companies();
    const creator = await actor({ company: a, role: "editor" }); // create, NOT issue
    const s = await seed();

    const issued = await call(OPS, {
      method: "POST", body: poBody(s, { status: "ISSUED" }),
      token: creator.token, idempotencyKey: newKey(),
    });
    expect(issued.status).toBe(400);
    expect(issued.body.error.details.field).toBe("status");
    expect(await PurchaseOrder.countDocuments({ companyId: a._id })).toBe(0);

    const completed = await call(OPS, {
      method: "POST", body: poBody(s, { status: "COMPLETED" }),
      token: creator.token, idempotencyKey: newKey(),
    });
    expect(completed.status).toBe(400);

    // An explicit DRAFT, and no status at all, both work.
    expect((await call(OPS, {
      method: "POST", body: poBody(s, { status: "DRAFT" }), token: creator.token, idempotencyKey: newKey(),
    })).status).toBe(201);
    const plain = await call(OPS, {
      method: "POST", body: poBody(s), token: creator.token, idempotencyKey: newKey(),
    });
    expect(plain.body.purchaseOrder.status).toBe("DRAFT");
    expect(plain.body.purchaseOrder.approvedBy).toBeUndefined();
  });

  test("a viewer may read but not create; an approver may do both", async () => {
    const { a } = await companies();
    const viewer = await actor({ company: a, role: "viewer" });
    const approver = await actor({ company: a, role: "approver" });
    const s = await seed();

    expect((await call(OPS, { token: viewer.token })).status).toBe(200);
    expect((await call(OPS, {
      method: "POST", body: poBody(s), token: viewer.token, idempotencyKey: newKey(),
    })).status).toBe(403);
    expect((await call(OPS, {
      method: "POST", body: poBody(s), token: approver.token, idempotencyKey: newKey(),
    })).status).toBe(201);
  });

  test("an editor may create and receive, but may not issue or cancel", async () => {
    const { a } = await companies();
    const editor = await actor({ company: a, role: "editor" });
    const s = await seed();
    const created = await call(OPS, {
      method: "POST", body: poBody(s), token: editor.token, idempotencyKey: newKey(),
    });
    expect(created.status).toBe(201);

    const issue = await call(`${OPS}/${created.body.purchaseOrder._id}/status`, {
      method: "PATCH", body: { status: "ISSUED" }, token: editor.token, idempotencyKey: newKey(),
    });
    expect(issue.status).toBe(403);
    expect(issue.body.error.details.required).toContain("sp.po.issue");
  });

  test("FIXED IN CHUNK 1: the units master no longer answers without a token", async () => {
    /* Chunk 0 pinned that `/api/cms/units` answered every request, signed in
       or not — including writes. The unit master is what every stock
       conversion trusts, so an anonymous writer could quietly change what a
       receipt puts on the shelf. */
    const anonymous = await fetch(`${base}/api/cms/units`);
    expect(anonymous.status).toBe(401);

    const anonymousWrite = await fetch(`${base}/api/cms/units`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Anonymous Unit" }),
    });
    expect(anonymousWrite.status).toBe(401);
  });

  test("reading units needs a Store/Purchase reader; writing needs master maintenance", async () => {
    const { a } = await companies();
    const viewer = await actor({ company: a, role: "viewer" });   // read only
    const editor = await actor({ company: a, role: "editor" });   // may maintain masters
    const outsider = await actor({ company: a, grant: null });

    expect((await call("/api/cms/units", { token: viewer.token })).status).toBe(200);
    expect((await call("/api/cms/units", { token: outsider.token })).status).toBe(403);

    expect((await call("/api/cms/units", {
      method: "POST", body: { name: `Unit ${Date.now()}` }, token: viewer.token,
    })).status).toBe(403);
    expect([200, 201]).toContain((await call("/api/cms/units", {
      method: "POST", body: { name: `Unit ${Date.now()}` }, token: editor.token,
    })).status);
  });
});

/* ═══ 2 · TENANT ISOLATION ═══════════════════════════════════════════════ */

describe("tenant isolation", () => {
  test("FIXED IN CHUNK 1: a caller from one company cannot list another company's POs", async () => {
    const { a, b } = await companies();
    const forA = await actor({ company: a });
    const forB = await actor({ company: b });
    const s = await seed();

    const made = await call(OPS, {
      method: "POST", body: poBody(s), token: forA.token, idempotencyKey: newKey(),
    });
    expect(made.status).toBe(201);
    const number = made.body.purchaseOrder.poNumber;

    const asB = await call(OPS, { token: forB.token });
    expect(asB.status).toBe(200);
    expect(asB.body.purchaseOrders.map((p) => p.poNumber)).not.toContain(number);
    // Even the counts are scoped — an unscoped total leaks volume.
    expect(asB.body.stats.total).toBe(0);
  });

  test("reading another company's PO by id answers exactly as a missing one does", async () => {
    const { a, b } = await companies();
    const forA = await actor({ company: a });
    const forB = await actor({ company: b });
    const s = await seed();
    const made = await call(OPS, {
      method: "POST", body: poBody(s), token: forA.token, idempotencyKey: newKey(),
    });
    const id = made.body.purchaseOrder._id;

    const foreign = await call(`${OPS}/${id}`, { token: forB.token });
    const missing = await call(`${OPS}/${new mongoose.Types.ObjectId()}`, { token: forB.token });
    // Non-disclosing: a 403 here would confirm the id exists.
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  test("another company's PO cannot be transitioned, received against or deleted", async () => {
    const { a, b } = await companies();
    const forA = await actor({ company: a });
    const forB = await actor({ company: b });
    const s = await seed();
    const made = await call(OPS, {
      method: "POST", body: poBody(s), token: forA.token, idempotencyKey: newKey(),
    });
    const id = made.body.purchaseOrder._id;
    const itemId = made.body.purchaseOrder.items[0]._id;

    expect((await call(`${OPS}/${id}/status`, {
      method: "PATCH", body: { status: "ISSUED" }, token: forB.token, idempotencyKey: newKey(),
    })).status).toBe(404);
    expect((await call(`${OPS}/${id}/receive`, {
      method: "POST", body: { items: [{ itemId, quantity: 1 }] },
      token: forB.token, idempotencyKey: newKey(),
    })).status).toBe(404);
  });

  test("a companyId in the request body cannot switch ownership", async () => {
    const { a, b } = await companies();
    const forA = await actor({ company: a });
    const s = await seed();

    const res = await call(OPS, {
      method: "POST",
      body: { ...poBody(s), companyId: String(b._id) },
      token: forA.token,
      idempotencyKey: newKey(),
    });
    // Refused loudly rather than silently substituted — a silent fix would
    // teach the client that the field works.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TENANT_MISMATCH");

    const ok = await call(OPS, {
      method: "POST", body: { ...poBody(s), companyId: String(a._id) },
      token: forA.token, idempotencyKey: newKey(),
    });
    expect(ok.status).toBe(201);
    const stored = await PurchaseOrder.findById(ok.body.purchaseOrder._id).lean();
    expect(String(stored.companyId)).toBe(String(a._id));
  });

  test("membership fails closed: two companies and no membership record means no access", async () => {
    await companies(); // two companies exist, so the single-company rule cannot apply
    const stranger = await actor({ company: null, role: "approver" });
    const res = await call(OPS, { token: stranger.token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("TENANT_MEMBERSHIP_UNPROVEN");
  });

  test("a single-company deployment still works without membership records", async () => {
    // The live system today. Recorded as a deployment fact, not inferred from
    // the request — and it stops applying the moment a second company exists.
    const only = await Acc_Company.create({
      companyName: "Only Co", booksFromDate: new Date("2026-04-01"),
    });
    await givePolicy(only._id);
    const person = await actor({ company: null, role: "approver" });
    const ctx = await call("/api/cms/store-purchase/context", { token: person.token });
    expect(ctx.body.context.membershipSource).toBe("SINGLE_COMPANY_DEPLOYMENT");
    expect(String(ctx.body.context.companyId)).toBe(String(only._id));
    expect((await call(OPS, { token: person.token })).status).toBe(200);
  });
});

/* ═══ 3 · LEGACY-GLOBAL RECORDS ══════════════════════════════════════════ */

describe("legacy-global records", () => {
  /** A PO from before company ownership existed — no companyId at all. */
  async function legacyPo() {
    const s = await seed();
    return PurchaseOrder.create({
      poNumber: `PO2508${++seq}`, status: "ISSUED", createdBy: new mongoose.Types.ObjectId(),
      vendor: s.vendor._id, vendorName: s.vendor.companyName,
      items: [{ rawItem: s.raw._id, itemName: s.raw.name, quantity: 10, unitPrice: 1, pendingQuantity: 10 }],
      totalPending: 10,
    });
  }

  test("legacy records do not appear in an ordinary company-scoped list", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const legacy = await legacyPo();
    const list = await call(OPS, { token: person.token });
    expect(list.body.purchaseOrders.map((p) => p.poNumber)).not.toContain(legacy.poNumber);
  });

  test("legacy access needs BOTH the capability and the explicit mode", async () => {
    const { a } = await companies();
    const legacy = await legacyPo();

    // Capability but no mode → ordinary scoped list, no legacy rows.
    const approver = await actor({ company: a, role: "approver" }); // holds sp.legacy.read
    const noMode = await call(OPS, { token: approver.token });
    expect(noMode.body.purchaseOrders.map((p) => p.poNumber)).not.toContain(legacy.poNumber);

    // Mode but no capability → refused.
    const editor = await actor({ company: a, role: "editor" }); // no sp.legacy.read
    const noCap = await call(`${OPS}?scope=legacy`, { token: editor.token });
    expect(noCap.status).toBe(403);
    expect(noCap.body.error.code).toBe("LEGACY_ACCESS_REQUIRED");

    // Both → the legacy rows, and only those.
    const both = await call(`${OPS}?scope=legacy`, { token: approver.token });
    expect(both.status).toBe(200);
    expect(both.body.purchaseOrders.map((p) => p.poNumber)).toContain(legacy.poNumber);
  });

  test("legacy mode is read-only — no write may happen in it", async () => {
    const { a } = await companies();
    const approver = await actor({ company: a, role: "approver" });
    const s = await seed();
    const res = await call(`${OPS}?scope=legacy`, {
      method: "POST", body: poBody(s), token: approver.token, idempotencyKey: newKey(),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("LEGACY_ACCESS_REQUIRED");
    expect(res.body.error.details.readOnly).toBe(true);
  });
});

/* ═══ 4 · DOCUMENT NUMBERING ═════════════════════════════════════════════ */

describe("document numbering", () => {
  test("FIXED IN CHUNK 1: a PO number is allocated, not randomised", async () => {
    // Chunk 0 pinned `PO\d{8}` — PO + yymm + four random digits, checked for
    // existence in a retry loop that gives up with a 500.
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const res = await call(OPS, {
      method: "POST", body: poBody(s), token: person.token, idempotencyKey: newKey(),
    });
    expect(res.body.purchaseOrder.poNumber).toMatch(/^PO\/\d{4}-\d{2}\/\d{4}$/);
  });

  test("numbers are sequential within a company and independent across companies", async () => {
    const { a, b } = await companies();
    const forA = await actor({ company: a });
    const forB = await actor({ company: b });
    const s = await seed();

    const a1 = await call(OPS, { method: "POST", body: poBody(s), token: forA.token, idempotencyKey: newKey() });
    const a2 = await call(OPS, { method: "POST", body: poBody(s), token: forA.token, idempotencyKey: newKey() });
    const b1 = await call(OPS, { method: "POST", body: poBody(s), token: forB.token, idempotencyKey: newKey() });

    expect(a1.body.purchaseOrder.poNumber).toMatch(/\/0001$/);
    expect(a2.body.purchaseOrder.poNumber).toMatch(/\/0002$/);
    // B starts its own sequence at 1 — counters do not leak across tenants.
    expect(b1.body.purchaseOrder.poNumber).toMatch(/\/0001$/);
  });

  test("a number supplied by the browser is ignored", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const res = await call(OPS, {
      method: "POST",
      body: { ...poBody(s), poNumber: "PO/1999-00/9999" },
      token: person.token,
      idempotencyKey: newKey(),
    });
    expect(res.status).toBe(201);
    expect(res.body.purchaseOrder.poNumber).not.toBe("PO/1999-00/9999");
  });
});

/* ═══ 5 · IDEMPOTENCY ════════════════════════════════════════════════════ */

describe("idempotency", () => {
  test("a mutating call without a key is refused", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const res = await call(OPS, { method: "POST", body: poBody(s), token: person.token });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  test("the identical retry replays the original order instead of creating a second", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const key = newKey();
    const body = poBody(s);

    const first = await call(OPS, { method: "POST", body, token: person.token, idempotencyKey: key });
    const retry = await call(OPS, { method: "POST", body, token: person.token, idempotencyKey: key });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.replayed).toBe(true);
    expect(retry.body.purchaseOrder._id).toBe(first.body.purchaseOrder._id);
    expect(await PurchaseOrder.countDocuments({ companyId: a._id })).toBe(1);
  });

  test("the same key with a different payload is a conflict, not a replay", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const key = newKey();
    await call(OPS, { method: "POST", body: poBody(s), token: person.token, idempotencyKey: key });
    const changed = await call(OPS, {
      method: "POST", body: poBody(s, { notes: "different" }), token: person.token, idempotencyKey: key,
    });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("key order in the payload does not make an identical retry a conflict", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const key = newKey();
    const base = poBody(s);
    const reordered = { items: base.items, vendorName: base.vendorName, vendor: base.vendor };

    const first = await call(OPS, { method: "POST", body: base, token: person.token, idempotencyKey: key });
    const retry = await call(OPS, { method: "POST", body: reordered, token: person.token, idempotencyKey: key });
    expect(retry.status).toBe(201);
    expect(retry.body.purchaseOrder._id).toBe(first.body.purchaseOrder._id);
  });

  test("concurrent duplicate submissions produce exactly one order", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const key = newKey();
    const body = poBody(s);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        call(OPS, { method: "POST", body, token: person.token, idempotencyKey: key })),
    );
    // One creation; the rest either replay it or are told it is in progress.
    expect(await PurchaseOrder.countDocuments({ companyId: a._id })).toBe(1);
    const created = results.filter((r) => r.status === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    for (const r of results) expect([201, 409]).toContain(r.status);
  });

  test("two companies may use the same key without colliding", async () => {
    const { a, b } = await companies();
    const forA = await actor({ company: a });
    const forB = await actor({ company: b });
    const s = await seed();
    const key = "shared-key";

    const ra = await call(OPS, { method: "POST", body: poBody(s), token: forA.token, idempotencyKey: key });
    const rb = await call(OPS, { method: "POST", body: poBody(s), token: forB.token, idempotencyKey: key });
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    expect(ra.body.purchaseOrder._id).not.toBe(rb.body.purchaseOrder._id);
  });

  test("a refused request does not lock its key, and never becomes a replayable success", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const key = newKey();
    const invalid = poBody(s, { items: [] });

    const bad = await call(OPS, { method: "POST", body: invalid, token: person.token, idempotencyKey: key });
    expect(bad.status).toBe(400);

    /* The identical retry must reach the handler again and be refused on its
       merits — NOT answered 409 IN_PROGRESS (the key would be stuck), and not
       replayed as a success (a validation error must never become one). */
    const retry = await call(OPS, { method: "POST", body: invalid, token: person.token, idempotencyKey: key });
    expect(retry.status).toBe(400);
    expect(retry.replayed).toBe(false);
    expect(await PurchaseOrder.countDocuments({ companyId: a._id })).toBe(0);
  });

  test("a key reused with a DIFFERENT payload conflicts even when the first attempt failed", async () => {
    // The contract is about the key, not about the outcome: one key means one
    // request. A client that fixes its payload must start a new action, or a
    // retry could silently become a different order under the same key.
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const key = newKey();

    expect((await call(OPS, {
      method: "POST", body: poBody(s, { items: [] }), token: person.token, idempotencyKey: key,
    })).status).toBe(400);

    const different = await call(OPS, {
      method: "POST", body: poBody(s), token: person.token, idempotencyKey: key,
    });
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

/* ═══ 6 · RECEIVING ══════════════════════════════════════════════════════ */

async function issuedPo(person, s, over = {}) {
  const created = await call(OPS, {
    method: "POST", body: poBody(s, over), token: person.token, idempotencyKey: newKey(),
  });
  expect(created.status).toBe(201);
  const id = created.body.purchaseOrder._id;
  const issued = await call(`${OPS}/${id}/status`, {
    method: "PATCH", body: { status: "ISSUED" }, token: person.token, idempotencyKey: newKey(),
  });
  expect(issued.status).toBe(200);
  return (await call(`${OPS}/${id}`, { token: person.token })).body.purchaseOrder;
}

describe("receiving against a PO", () => {
  test("a DRAFT PO cannot be received against", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const created = await call(OPS, {
      method: "POST", body: poBody(s), token: person.token, idempotencyKey: newKey(),
    });
    const res = await call(`${OPS}/${created.body.purchaseOrder._id}/receive`, {
      method: "POST",
      body: { items: [{ itemId: created.body.purchaseOrder.items[0]._id, quantity: 10 }] },
      token: person.token, idempotencyKey: newKey(),
    });
    expect(res.status).toBe(400);
  });

  test("a partial receipt moves stock and writes the embedded movement", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed({ stockQty: 7 });
    const po = await issuedPo(person, s);

    const res = await call(`${OPS}/${po._id}/receive`, {
      method: "POST",
      body: { items: [{ itemId: po.items[0]._id, quantity: 40 }], invoiceNumber: "INV-1" },
      token: person.token, idempotencyKey: newKey(),
    });
    expect(res.status).toBe(200);
    expect(res.body.purchaseOrder.status).toBe("PARTIALLY_RECEIVED");

    const raw = await RawItem.findById(s.raw._id).lean();
    expect(raw.quantity).toBe(47);
    expect(raw.stockTransactions).toHaveLength(1);
  });

  test("FIXED IN CHUNK 1: a re-posted receipt is replayed, and stock moves ONCE", async () => {
    // Chunk 0's pin: the repeat was accepted and the whole delivery was
    // silently added to stock a second time as "surplus" — 100 ordered, 200
    // in stock, and the PO's own accounting hiding it.
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const po = await issuedPo(person, s);
    const key = newKey();
    const body = { items: [{ itemId: po.items[0]._id, quantity: 100 }], invoiceNumber: "INV-DUP" };

    const first = await call(`${OPS}/${po._id}/receive`, {
      method: "POST", body, token: person.token, idempotencyKey: key,
    });
    const second = await call(`${OPS}/${po._id}/receive`, {
      method: "POST", body, token: person.token, idempotencyKey: key,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.replayed).toBe(true);

    const raw = await RawItem.findById(s.raw._id).lean();
    expect(raw.quantity).toBe(100);            // not 200
    expect(raw.stockTransactions).toHaveLength(1); // one movement, not two
  });

  test("a receipt requires the receipt capability", async () => {
    const { a } = await companies();
    const approver = await actor({ company: a, role: "approver" });
    const viewer = await actor({ company: a, role: "viewer" });
    const s = await seed();
    const po = await issuedPo(approver, s);

    const res = await call(`${OPS}/${po._id}/receive`, {
      method: "POST", body: { items: [{ itemId: po.items[0]._id, quantity: 1 }] },
      token: viewer.token, idempotencyKey: newKey(),
    });
    expect(res.status).toBe(403);
  });
});

/* ═══ 7 · LIFECYCLE ══════════════════════════════════════════════════════ */

describe("cancellation", () => {
  test("cancelling requires the capability and a reason", async () => {
    const { a } = await companies();
    const approver = await actor({ company: a, role: "approver" });
    const editor = await actor({ company: a, role: "editor" });
    const s = await seed();
    const created = await call(OPS, {
      method: "POST", body: poBody(s), token: approver.token, idempotencyKey: newKey(),
    });
    const id = created.body.purchaseOrder._id;

    // No capability.
    expect((await call(`${OPS}/${id}/status`, {
      method: "PATCH", body: { status: "CANCELLED", reason: "duplicate" }, token: editor.token, idempotencyKey: newKey(),
    })).status).toBe(403);

    // Capability, no reason.
    const noReason = await call(`${OPS}/${id}/status`, {
      method: "PATCH", body: { status: "CANCELLED" }, token: approver.token, idempotencyKey: newKey(),
    });
    expect(noReason.status).toBe(400);

    // Both.
    const ok = await call(`${OPS}/${id}/status`, {
      method: "PATCH", body: { status: "CANCELLED", reason: "Raised in error" }, token: approver.token, idempotencyKey: newKey(),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.purchaseOrder.status).toBe("CANCELLED");
  });

  test("a received PO cannot be cancelled", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const po = await issuedPo(person, s);
    await call(`${OPS}/${po._id}/receive`, {
      method: "POST", body: { items: [{ itemId: po.items[0]._id, quantity: 10 }] },
      token: person.token, idempotencyKey: newKey(),
    });
    const res = await call(`${OPS}/${po._id}/status`, {
      method: "PATCH", body: { status: "CANCELLED", reason: "changed our mind" }, token: person.token, idempotencyKey: newKey(),
    });
    /* A structured refusal, not a bare 400: the client needs to tell a
       lifecycle conflict apart from a validation error. */
    expect(res.status).toBe(409);
    expect(["INVALID_TRANSITION", "LIFECYCLE_BLOCKED"]).toContain(res.body.error.code);
  });

  test("a same-state request succeeds without appending a second history entry", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const po = await issuedPo(person, s);

    const again = await call(`${OPS}/${po._id}/status`, {
      method: "PATCH", body: { status: "ISSUED" }, token: person.token, idempotencyKey: newKey(),
    });
    expect(again.status).toBe(200);
    // Re-issuing an issued order is not a second issuance.
    expect(await SpActionHistory.countDocuments({ entityId: po._id, action: "ISSUED" })).toBe(1);
  });

  test("no transition returns a commercial document to DRAFT, and receipt states cannot be asserted", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const po = await issuedPo(person, s);

    for (const status of ["DRAFT", "PARTIALLY_RECEIVED", "COMPLETED"]) {
      const res = await call(`${OPS}/${po._id}/status`, {
        method: "PATCH", body: { status }, token: person.token, idempotencyKey: newKey(),
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION");
    }
  });
});

/* ═══ 7b · EDITING ═══════════════════════════════════════════════════════ */

describe("editing a purchase order", () => {
  test("the edit route cannot change status", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const created = await call(OPS, {
      method: "POST", body: poBody(s), token: person.token, idempotencyKey: newKey(),
    });
    const res = await call(`${OPS}/${created.body.purchaseOrder._id}`, {
      method: "PUT", body: { ...poBody(s), status: "ISSUED" }, token: person.token,
    });
    // Editing is not a transition — this was a second, unguarded way to issue.
    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe("status");
    const stored = await PurchaseOrder.findById(created.body.purchaseOrder._id).lean();
    expect(stored.status).toBe("DRAFT");
  });

  test("only a DRAFT may be edited — every other state refuses", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();

    // DRAFT edits fine.
    const draft = await call(OPS, {
      method: "POST", body: poBody(s), token: person.token, idempotencyKey: newKey(),
    });
    expect((await call(`${OPS}/${draft.body.purchaseOrder._id}`, {
      method: "PUT", body: poBody(s, { notes: "edited" }), token: person.token,
    })).status).toBe(200);

    // ISSUED refuses — a commitment already sent to a supplier is immutable.
    const issued = await issuedPo(person, s);
    const onIssued = await call(`${OPS}/${issued._id}`, {
      method: "PUT", body: poBody(s, { notes: "sneaky" }), token: person.token,
    });
    expect(onIssued.status).toBe(409);
    expect(onIssued.body.error.code).toBe("INVALID_TRANSITION");

    // CANCELLED refuses too.
    const toCancel = await call(OPS, {
      method: "POST", body: poBody(s), token: person.token, idempotencyKey: newKey(),
    });
    await call(`${OPS}/${toCancel.body.purchaseOrder._id}/status`, {
      method: "PATCH", body: { status: "CANCELLED", reason: "not needed" },
      token: person.token, idempotencyKey: newKey(),
    });
    expect((await call(`${OPS}/${toCancel.body.purchaseOrder._id}`, {
      method: "PUT", body: poBody(s), token: person.token,
    })).status).toBe(409);
  });

  test("a draft edit records what changed", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const created = await call(OPS, {
      method: "POST", body: poBody(s), token: person.token, idempotencyKey: newKey(),
    });
    await call(`${OPS}/${created.body.purchaseOrder._id}`, {
      method: "PUT",
      body: poBody(s, { items: [{ rawItem: String(s.raw._id), itemName: s.raw.name, quantity: 5, unitPrice: 5, unit: "pcs" }] }),
      token: person.token,
    });
    const [entry] = await SpActionHistory.find({
      entityId: created.body.purchaseOrder._id, action: "EDITED",
    }).lean();
    expect(entry).toBeTruthy();
    expect(entry.changes.map((c) => c.field)).toEqual(expect.arrayContaining(["totalAmount"]));
  });
});

/* ═══ 7c · APPROVAL POLICY ═══════════════════════════════════════════════ */

describe("approval policy is a separate gate from capability", () => {
  test("an unconfigured company cannot issue, even with the issue capability", async () => {
    const { a } = await companies({ withPolicy: false });
    const person = await actor({ company: a, role: "approver" }); // holds sp.po.issue
    const s = await seed();
    const created = await call(OPS, {
      method: "POST", body: poBody(s), token: person.token, idempotencyKey: newKey(),
    });
    const res = await call(`${OPS}/${created.body.purchaseOrder._id}/status`, {
      method: "PATCH", body: { status: "ISSUED" }, token: person.token, idempotencyKey: newKey(),
    });
    /* Capability and policy are two gates and both must pass. Holding the
       capability is authority to operate the endpoint, not the company's
       authority to commit the money. */
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("POLICY_NOT_CONFIGURED");
    const stored = await PurchaseOrder.findById(created.body.purchaseOrder._id).lean();
    expect(stored.status).toBe("DRAFT");
  });

  test("an emergency order needs its own emergency policy; an ordinary one does not authorise it", async () => {
    const { a } = await companies(); // ordinary policy only
    const person = await actor({ company: a, role: "approver" });
    const s = await seed();
    const created = await call(OPS, {
      method: "POST", body: poBody(s, { isEmergencyOrder: true }), token: person.token, idempotencyKey: newKey(),
    });
    const refused = await call(`${OPS}/${created.body.purchaseOrder._id}/status`, {
      method: "PATCH", body: { status: "ISSUED" }, token: person.token, idempotencyKey: newKey(),
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("POLICY_NOT_CONFIGURED");

    // With an emergency rule configured, it goes through.
    await givePolicy(a._id, { isEmergencyPolicy: true });
    const ok = await call(`${OPS}/${created.body.purchaseOrder._id}/status`, {
      method: "PATCH", body: { status: "ISSUED" }, token: person.token, idempotencyKey: newKey(),
    });
    expect(ok.status).toBe(200);
  });

  test("an expired policy does not authorise issuance", async () => {
    const { a } = await companies({ withPolicy: false });
    await givePolicy(a._id, { effectiveTo: new Date("2020-01-01"), effectiveFrom: new Date("2019-01-01") });
    const person = await actor({ company: a, role: "approver" });
    const s = await seed();
    const created = await call(OPS, {
      method: "POST", body: poBody(s), token: person.token, idempotencyKey: newKey(),
    });
    const res = await call(`${OPS}/${created.body.purchaseOrder._id}/status`, {
      method: "PATCH", body: { status: "ISSUED" }, token: person.token, idempotencyKey: newKey(),
    });
    expect(res.body.error.code).toBe("POLICY_NOT_CONFIGURED");
  });
});

/* ═══ 8 · ACTION HISTORY ═════════════════════════════════════════════════ */

describe("action history", () => {
  test("creating, issuing and receiving each append an entry", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const po = await issuedPo(person, s);
    await call(`${OPS}/${po._id}/receive`, {
      method: "POST", body: { items: [{ itemId: po.items[0]._id, quantity: 10 }] },
      token: person.token, idempotencyKey: newKey(),
    });

    const res = await call(
      `/api/cms/store-purchase/history?entityType=PURCHASE_ORDER&entityId=${po._id}`,
      { token: person.token },
    );
    expect(res.status).toBe(200);
    const actions = res.body.entries.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["CREATED", "ISSUED", "RECEIVED"]));
    // Every entry carries who did it and which document it was about.
    for (const e of res.body.entries) {
      expect(e.documentNumber).toBe(po.poNumber);
      expect(e.actorName).toBeTruthy();
    }
  });

  test("history is tenant-scoped", async () => {
    const { a, b } = await companies();
    const forA = await actor({ company: a });
    const forB = await actor({ company: b });
    const s = await seed();
    await issuedPo(forA, s);

    const asB = await call("/api/cms/store-purchase/history", { token: forB.token });
    expect(asB.status).toBe(200);
    expect(asB.body.entries).toEqual([]);
  });

  test("reading history requires the history capability", async () => {
    const { a } = await companies();
    const outsider = await actor({ company: a, grant: null });
    expect((await call("/api/cms/store-purchase/history", { token: outsider.token })).status).toBe(403);
  });

  test("an idempotent replay does NOT append a second history entry", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const key = newKey();
    const body = poBody(s);
    const first = await call(OPS, { method: "POST", body, token: person.token, idempotencyKey: key });
    await call(OPS, { method: "POST", body, token: person.token, idempotencyKey: key });

    const entries = await SpActionHistory.find({
      entityId: first.body.purchaseOrder._id, action: "CREATED",
    }).lean();
    expect(entries).toHaveLength(1);
  });

  test("history cannot be mutated or deleted through the model", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    await issuedPo(person, s);
    const entry = await SpActionHistory.findOne({ companyId: a._id });

    await expect(SpActionHistory.updateOne({ _id: entry._id }, { $set: { action: "TAMPERED" } }))
      .rejects.toThrow(/append-only/);
    await expect(SpActionHistory.deleteOne({ _id: entry._id })).rejects.toThrow(/append-only/);
    await expect(SpActionHistory.findOneAndUpdate({ _id: entry._id }, { $set: { reason: "x" } }))
      .rejects.toThrow(/append-only/);
    entry.action = "TAMPERED";
    await expect(entry.save()).rejects.toThrow(/append-only/);
  });
});

/* ═══ 9 · STILL CHARACTERISATION — NOT FIXED BY CHUNK 1 ══════════════════ */

describe("behaviour Chunk 1 deliberately did not change", () => {
  test("cancelling a vendor return still keeps the stock deduction — now governed (Chunk 1C)", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const po = await issuedPo(person, s);
    await call(`${OPS}/${po._id}/receive`, {
      method: "POST", body: { items: [{ itemId: po.items[0]._id, quantity: 100 }] },
      token: person.token, idempotencyKey: newKey(),
    });

    /* Chunk 1C governs this router: both calls now need a key and a
       capability. The BEHAVIOUR this pin was written for is unchanged and
       deliberate — cancelling says "we have stopped chasing the vendor", not
       "the goods were never damaged", so the deduction stands. */
    const ret = await call(`${OPS}/${po._id}/returns`, {
      method: "POST", body: { poItemId: po.items[0]._id, damagedQuantity: 10, reason: "torn" },
      token: person.token, idempotencyKey: newKey(),
    });
    expect(ret.status).toBe(201);
    expect((await RawItem.findById(s.raw._id).lean()).quantity).toBe(90);

    const returnId = (await PurchaseOrder.findById(po._id).lean()).returnRequests[0]._id;
    const cancelled = await call(`${OPS}/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: person.token, idempotencyKey: newKey(), body: {},
    });
    expect(cancelled.status).toBe(200);
    expect((await RawItem.findById(s.raw._id).lean()).quantity).toBe(90);
  });

  test("CHARACTERISATION: Store still records supplier payments (Chunk 8), now scoped and permissioned", async () => {
    const { a } = await companies();
    const person = await actor({ company: a });
    const s = await seed();
    const po = await issuedPo(person, s);
    const res = await call(`${OPS}/${po._id}/payment`, {
      method: "POST", body: { amount: 200, paymentMethod: "BANK_TRANSFER" },
      token: person.token, idempotencyKey: newKey(),
    });
    expect(res.status).toBe(200);
    // What Chunk 1 DID change: a double-click no longer records it twice.
    const key = newKey();
    const body = { amount: 100, paymentMethod: "CASH" };
    await call(`${OPS}/${po._id}/payment`, { method: "POST", body, token: person.token, idempotencyKey: key });
    await call(`${OPS}/${po._id}/payment`, { method: "POST", body, token: person.token, idempotencyKey: key });
    const after = await PurchaseOrder.findById(po._id).lean();
    expect(after.payments).toHaveLength(2); // the ₹200 and ONE ₹100
  });

  test("CHARACTERISATION: the worksheet PO register is untouched and moves no stock (Chunk 6)", async () => {
    const s = await seed({ stockQty: 5 });
    const created = await call("/api/cms/store/purchase-orders", {
      method: "POST",
      body: { vendorName: "V", items: [{ itemName: s.raw.name, quantity: 10, unitPrice: 1, gstPercentage: 0 }] },
    });
    expect(created.status).toBe(201);
    expect(created.body.purchaseOrder.status).toBe("Draft");
    const raw = await RawItem.findById(s.raw._id).lean();
    expect(raw.quantity).toBe(5);
    expect(raw.stockTransactions).toHaveLength(0);
  });
});
