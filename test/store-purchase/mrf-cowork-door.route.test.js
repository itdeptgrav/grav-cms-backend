// test/store-purchase/mrf-cowork-door.route.test.js
//
// Store & Purchase — Chunk 1B. The requester's door.
//
// Two doors reach the same material requests. The CMS door is where the store
// works; this one is where the people who ASK for material live — the
// requester raising it and the manager the org chart routed it to. Chunk 0
// found this door had no company boundary at all, and its approve/reject
// wrote nothing to history, so a decision could not be attributed afterwards.
//
// Nobody here holds a Store capability. That is the point: authority on this
// door is a relationship, and it still has to be exact.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({ admin: {}, db: {}, auth: {}, messaging: {}, rtdb: {} }));
jest.mock("../../services/mrfNotify.service", () =>
  new Proxy({}, { get: () => () => Promise.resolve() }));

const express = require("express");
const jwt = require("jsonwebtoken");

const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Employee = require("../../models/Employee");
require("../../models/ProjectManager");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const mrfRoutes = require("../../routes/CMS_Routes/Inventory/Operations/coworkMrfRoutes");
  app.use("/api/cms/mrf", mrfRoutes.cmsChain, mrfRoutes);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/mrf`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const newKey = () => `cw-${++seq}-${Math.random().toString(36).slice(2)}`;

const call = (who, path, { method = "GET", body, idempotencyKey } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      Authorization: `Bearer ${jwt.sign(
        {
          id: String(who.emp._id), role: "employee",
          employeeId: who.emp.biometricId, email: who.emp.email,
          name: `${who.emp.firstName} ${who.emp.lastName}`,
        },
        process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
      )}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({
    status: r.status,
    body: JSON.parse((await r.text()) || "null"),
    replayed: r.headers.get("Idempotency-Replayed") === "true",
  }));

/**
 * Two companies exist in every test here on purpose. With only one, the
 * single-company fallback resolves the tenant for anybody and the boundary is
 * never actually exercised.
 */
async function twoCompanies() {
  const a = await Acc_Company.create({ companyName: `Acme ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const b = await Acc_Company.create({ companyName: `Borealis ${++seq}`, booksFromDate: new Date("2026-04-01") });
  return { a, b };
}

async function person({ co, name = "P", manager = null }) {
  const n = ++seq;
  const email = `cw${n}@test.example`;
  const emp = await Employee.create({
    firstName: name, lastName: `L${n}`, email, biometricId: `CB${n}`,
    isActive: true, gender: "Other", department: "Tech",
    ...(manager ? { primaryManager: { managerId: manager._id, managerName: "Mgr" } } : {}),
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: name });
  return { emp, email };
}

const catalogueItem = async () => RawItem.create({
  name: `Cone ${++seq}`, sku: `CN-${seq}`, unit: "pcs", quantity: 40, minStock: 0,
});

const askBody = (raw) => ({
  requestType: "USES_BASED", priority: "NORMAL", reason: "The old one failed inspection",
  items: [{ rawItemId: String(raw._id), rawItemName: raw.name, requestedQty: 3, unit: "pcs" }],
});

/* ═══ OWNERSHIP AND ISOLATION ════════════════════════════════════════════ */

test("a request raised here is owned by the requester's own company, whatever the body says", async () => {
  const { a, b } = await twoCompanies();
  const tl = await person({ co: a, name: "Meera" });
  const emp = await person({ co: a, name: "Rutu", manager: tl.emp });
  const raw = await catalogueItem();

  const res = await call(emp, "/", {
    method: "POST", idempotencyKey: newKey(),
    body: { ...askBody(raw), companyId: String(b._id) },   // spoof attempt
  });
  expect(res.status).toBe(201);

  const stored = await MRF.findById(res.body.mrf._id).lean();
  expect(String(stored.companyId)).toBe(String(a._id));
});

test("a requester cannot see another company's requests", async () => {
  const { a, b } = await twoCompanies();
  const mine = await person({ co: a, name: "Rutu" });
  const theirs = await person({ co: b, name: "Vik" });
  const raw = await catalogueItem();

  const created = await call(theirs, "/", { method: "POST", body: askBody(raw), idempotencyKey: newKey() });
  expect(created.status).toBe(201);
  const foreignId = created.body.mrf._id;

  const list = await call(mine, "/?limit=50");
  expect(list.status).toBe(200);
  expect((list.body.mrfs || []).map((m) => String(m._id))).not.toContain(String(foreignId));

  const detail = await call(mine, `/${foreignId}`);
  expect(detail.status).toBe(404);          // scoped away, not merely forbidden

  const chat = await call(mine, `/${foreignId}/chat`);
  expect(chat.status).toBe(404);
});

test("a manager's approval queue holds only their own company's requests", async () => {
  const { a, b } = await twoCompanies();
  const tlA = await person({ co: a, name: "Meera" });
  const empA = await person({ co: a, name: "Rutu", manager: tlA.emp });
  const empB = await person({ co: b, name: "Vik" });
  const raw = await catalogueItem();

  await call(empA, "/", { method: "POST", body: askBody(raw), idempotencyKey: newKey() });
  await call(empB, "/", { method: "POST", body: askBody(raw), idempotencyKey: newKey() });

  const queue = await call(tlA, "/approvals?status=PENDING&limit=50");
  expect(queue.status).toBe(200);
  const rows = queue.body.mrfs || queue.body.requests || [];
  for (const row of rows) {
    const doc = await MRF.findById(row._id).lean();
    expect(String(doc.companyId)).toBe(String(a._id));
  }
});

/* ═══ DUPLICATE PROTECTION ═══════════════════════════════════════════════ */

test("a duplicate submit raises ONE request", async () => {
  const { a } = await twoCompanies();
  const tl = await person({ co: a, name: "Meera" });
  const emp = await person({ co: a, name: "Rutu", manager: tl.emp });
  const raw = await catalogueItem();
  const key = newKey();
  const body = askBody(raw);

  const first = await call(emp, "/", { method: "POST", body, idempotencyKey: key });
  const retry = await call(emp, "/", { method: "POST", body, idempotencyKey: key });

  expect(first.status).toBe(201);
  expect(retry.replayed).toBe(true);
  expect(await MRF.countDocuments({})).toBe(1);
});

test("a duplicate approval records ONE decision and ONE history entry", async () => {
  const { a } = await twoCompanies();
  const tl = await person({ co: a, name: "Meera" });
  const emp = await person({ co: a, name: "Rutu", manager: tl.emp });
  const raw = await catalogueItem();
  const created = await call(emp, "/", { method: "POST", body: askBody(raw), idempotencyKey: newKey() });
  const id = created.body.mrf._id;

  const key = newKey();
  const first = await call(tl, `/${id}/tl-approve`, { method: "PATCH", body: {}, idempotencyKey: key });
  const retry = await call(tl, `/${id}/tl-approve`, { method: "PATCH", body: {}, idempotencyKey: key });

  expect(first.status).toBe(200);
  expect(retry.replayed).toBe(true);
  expect(await SpActionHistory.countDocuments({ entityId: id, action: "TL_APPROVED" })).toBe(1);
});

/* ═══ AUTHORITY ══════════════════════════════════════════════════════════ */

test("an unassigned manager in the same company cannot approve", async () => {
  const { a } = await twoCompanies();
  const tl = await person({ co: a, name: "Meera" });
  const stranger = await person({ co: a, name: "Anil" });
  const emp = await person({ co: a, name: "Rutu", manager: tl.emp });
  const raw = await catalogueItem();
  const created = await call(emp, "/", { method: "POST", body: askBody(raw), idempotencyKey: newKey() });

  const res = await call(stranger, `/${created.body.mrf._id}/tl-approve`, {
    method: "PATCH", body: {}, idempotencyKey: newKey(),
  });
  expect([403, 404]).toContain(res.status);

  const doc = await MRF.findById(created.body.mrf._id).lean();
  expect(doc.tlApproved).toBeFalsy();
  expect(doc.status).toBe("PENDING");
});

test("cancelling records the state the request was actually in", async () => {
  /* The history entry read mrf.status AFTER the save, so every cancellation
     claimed the request had already been CANCELLED before it was cancelled. */
  const { a } = await twoCompanies();
  const tl = await person({ co: a, name: "Meera" });
  const emp = await person({ co: a, name: "Rutu", manager: tl.emp });
  const raw = await catalogueItem();
  const created = await call(emp, "/", { method: "POST", body: askBody(raw), idempotencyKey: newKey() });
  const id = created.body.mrf._id;

  const res = await call(emp, `/${id}/cancel`, {
    method: "PATCH", body: { note: "Not needed after all" }, idempotencyKey: newKey(),
  });
  expect(res.status).toBe(200);

  const entry = await SpActionHistory.findOne({ entityId: id, action: "CANCELLED" }).lean();
  expect(entry).toBeTruthy();
  expect(entry.previousState).toBe("PENDING");     // never "CANCELLED"
  expect(String(entry.companyId)).toBe(String(a._id));
});
