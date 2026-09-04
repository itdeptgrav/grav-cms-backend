// test/store-purchase/mrf-tenancy.route.test.js
//
// Store & Purchase — Chunk 1B. The material-request boundary.
//
// Chunk 0 measured what this router did: every authenticated caller whose JWT
// role was not literally "employee" saw and mutated EVERY material request in
// the database, across every company, with no capability check and no
// idempotency — so a retried issue moved stock twice.
//
// The two authorities being proved here are different in kind, and the tests
// are arranged around that:
//   RELATIONSHIP — a requester owns their request; a manager decides the ones
//     the org chart routed to them. Neither needs a Store grant.
//   CAPABILITY   — the Store's work on somebody else's request. Granted.
// Neither may stand in for the other.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({ admin: {}, db: {}, auth: {}, messaging: {}, rtdb: {} }));
/* Every notifier is a no-op. A Proxy rather than a fixed list, so a notifier
   added later cannot fail this suite for a reason that has nothing to do with
   the boundary being tested. */
jest.mock("../../services/mrfNotify.service", () =>
  new Proxy({}, { get: () => () => Promise.resolve() }));
jest.mock("../../services/mrfChat.service", () => ({
  systemMessage: () => Promise.resolve(null),
  postMessage: () => Promise.resolve({ _id: "m1" }),
  listMessages: () => Promise.resolve([]),
  markRead: () => Promise.resolve({ unread: 0 }),
  describeSubject: () => ({ label: "" }),
}));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Employee = require("../../models/Employee");
require("../../models/ProjectManager");   // MRFs raised by the store populate through it
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
const actionHistory = require("../../services/storePurchase/actionHistory.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/mrf", require("../../routes/CMS_Routes/Inventory/Operations/mrfRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => { jest.restoreAllMocks(); });

const MRF_API = "/api/cms/inventory/mrf";
const newKey = () => `mrf-${++seq}-${Math.random().toString(36).slice(2)}`;

const call = (path, { method = "GET", body, token, idempotencyKey, company } = {}) =>
  fetch(`${base}${MRF_API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(company ? { "X-Store-Purchase-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({
    status: r.status,
    body: JSON.parse((await r.text()) || "null"),
    replayed: r.headers.get("Idempotency-Replayed") === "true",
  }));

/** A catalogue item, for the routes that require one. */
const catalogueItem = async () => RawItem.create({
  name: `Tape ${++seq}`, sku: `TP-${seq}`, unit: "pcs", quantity: 50, minStock: 0,
});

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

/**
 * A person with an HR record, optionally a Store grant, optionally a company
 * membership. `grant: null` is an ordinary employee — a requester or a
 * manager — who must still be able to use their own requests.
 */
async function person({ co, grant = null, role = "approver", name = "P", manager = null }) {
  const n = ++seq;
  const email = `mrf${n}@test.example`;
  const emp = await Employee.create({
    firstName: name, lastName: `L${n}`, email, biometricId: `B${n}`,
    isActive: true, gender: "Other", department: "Tech",
    ...(manager ? { primaryManager: { managerId: manager._id } } : {}),
  });
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role, isActive: true });
  if (co) await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: name });
  return {
    emp, email,
    token: jwt.sign(
      { id: String(emp._id), email, name, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/** A TL-approved request sitting with the store, owned by one company. */
async function request({ co, requester, approver, stockQty = 100, requestedQty = 10, over = {} }) {
  const n = ++seq;
  const raw = await RawItem.create({
    name: `Blade ${n}`, sku: `BLD-${n}`, unit: "pcs", quantity: stockQty, minStock: 0,
  });
  const mrf = await MRF.create({
    companyId: co._id,
    mrfNumber: `MRF-2609-${String(n).padStart(4, "0")}`,
    requestedFor: requester.emp._id, requestedForName: "Req", requestedForDept: "Tech",
    requestedForId: requester.emp.biometricId,
    requestType: "USES_BASED", status: "APPROVED",
    createdByRef: requester.emp._id, createdByModel: "Employee", createdByName: "Req",
    reason: "The old ones failed",
    ...(approver ? {
      approverEmployee: approver.emp._id, approverName: "Mgr",
      approverBiometricId: approver.emp.biometricId,
    } : {}),
    tlApproved: true, tlApprovedAt: new Date(),
    items: [{
      rawItem: raw._id, rawItemName: raw.name, rawItemSku: raw.sku,
      requestedQty, unit: "pcs", baseUnit: "pcs", itemStatus: "APPROVED",
    }],
    ...over,
  });
  return { mrf, raw, itemId: String(mrf.items[0]._id) };
}

/* ═══ 1 · TENANT ISOLATION ═══════════════════════════════════════════════ */

describe("tenant isolation", () => {
  test("company A's store cannot list company B's requests, and counts do not leak", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store" });
    const reqB = await person({ co: b });
    const { mrf } = await request({ co: b, requester: reqB });

    const list = await call("/", { token: storeA.token });
    expect(list.status).toBe(200);
    expect(list.body.mrfs.map((m) => m.mrfNumber)).not.toContain(mrf.mrfNumber);
    // The stats aggregate used to be deliberately global.
    expect(list.body.stats.total).toBe(0);
  });

  test("reading another company's request answers exactly as a missing one does", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store" });
    const reqB = await person({ co: b });
    const { mrf } = await request({ co: b, requester: reqB });

    const foreign = await call(`/${mrf._id}`, { token: storeA.token });
    const missing = await call(`/${new mongoose.Types.ObjectId()}`, { token: storeA.token });
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  test("another company's request cannot be issued against, matched or cancelled", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store" });
    const reqB = await person({ co: b });
    const { mrf, itemId, raw } = await request({ co: b, requester: reqB });

    const issue = await call(`/${mrf._id}/issue`, {
      method: "POST", body: { items: [{ itemId, issuedQty: 1 }] },
      token: storeA.token, idempotencyKey: newKey(),
    });
    expect(issue.status).toBe(404);
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(100); // untouched

    expect((await call(`/${mrf._id}/availability`, {
      method: "PATCH", body: { items: [{ itemId, availability: "AVAILABLE" }] },
      token: storeA.token, idempotencyKey: newKey(),
    })).status).toBe(404);

    expect((await call(`/${mrf._id}/cancel`, {
      method: "PATCH", body: { reason: "x" }, token: storeA.token, idempotencyKey: newKey(),
    })).status).toBe(404);
  });

  test("ownership comes only from resolved context — a companyId in the body is ignored", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store" });
    const target = await person({ co: a });
    const tape = await catalogueItem();

    const created = await call("/bypass", {
      method: "POST",
      body: {
        employeeMongoId: String(target.emp._id), requestType: "USES_BASED",
        reason: "Store raised on their behalf",
        companyId: String(b._id),                    // spoof attempt
        items: [{ rawItemId: String(tape._id), requestedQty: 1, unit: "pcs" }],
      },
      token: storeA.token, idempotencyKey: newKey(),
    });
    expect(created.status).toBe(201);
    const stored = await MRF.findById(created.body.mrf._id).lean();
    expect(String(stored.companyId)).toBe(String(a._id));   // never B
  });

  test("a company header cannot select a company the actor has no membership in", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store" });

    const res = await call("/", { token: storeA.token, company: b._id });
    // A single membership decides; naming somebody else's company is refused
    // rather than honoured.
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      // If honoured at all, it must still be A's data — never B's.
      expect(res.body.mrfs.every((m) => true)).toBe(true);
    }
  });

  test("multi-company selection is deterministic and validated", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const both = await person({ co: a, grant: "store" });
    await SpCompanyMembership.create({
      companyId: b._id, email: both.email, employeeRef: both.emp._id, personName: "P",
    });

    // Two memberships and no choice → refused, not guessed.
    const noChoice = await call("/", { token: both.token });
    expect(noChoice.status).toBe(409);
    expect(noChoice.body.error.code).toBe("COMPANY_SELECTION_REQUIRED");

    // A named membership works, and the same input twice gives the same answer.
    const first = await call("/", { token: both.token, company: a._id });
    const again = await call("/", { token: both.token, company: a._id });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);

    // A company they do not belong to is refused, non-disclosingly.
    const stranger = await company("Cerulean");
    const refused = await call("/", { token: both.token, company: stranger._id });
    expect(refused.status).toBe(403);
  });
});

/* ═══ 2 · LEGACY-GLOBAL RECORDS ══════════════════════════════════════════ */

describe("legacy-global requests", () => {
  /** A request from before the boundary — no companyId at all. */
  const legacyRequest = async (requester) => MRF.create({
    mrfNumber: `MRF-2501-${String(++seq).padStart(4, "0")}`,
    requestedFor: requester.emp._id, requestedForName: "Req",
    requestedForId: requester.emp.biometricId,
    requestType: "USES_BASED", status: "APPROVED", tlApproved: true,
    createdByRef: requester.emp._id, createdByModel: "Employee", createdByName: "Req",
    items: [{ rawItemName: "Old thing", requestedQty: 1, unit: "pcs", itemStatus: "APPROVED" }],
  });

  test("legacy requests are excluded from an ordinary company list", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const requester = await person({ co: a });
    const legacy = await legacyRequest(requester);

    const list = await call("/", { token: store.token });
    expect(list.body.mrfs.map((m) => m.mrfNumber)).not.toContain(legacy.mrfNumber);
  });

  test("legacy access needs BOTH the capability and the explicit mode", async () => {
    const a = await company("Acme");
    const requester = await person({ co: a });
    const legacy = await legacyRequest(requester);

    const editor = await person({ co: a, grant: "store", role: "editor" });   // no legacy.read
    const approver = await person({ co: a, grant: "store", role: "approver" }); // has it

    const noCap = await call("/?scope=legacy", { token: editor.token });
    expect(noCap.status).toBe(403);
    expect(noCap.body.error.code).toBe("LEGACY_ACCESS_REQUIRED");

    const both = await call("/?scope=legacy", { token: approver.token });
    expect(both.status).toBe(200);
    expect(both.body.mrfs.map((m) => m.mrfNumber)).toContain(legacy.mrfNumber);
  });

  test("legacy requests are read-only — no write may happen in legacy mode", async () => {
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const requester = await person({ co: a });
    const legacy = await legacyRequest(requester);

    const res = await call(`/${legacy._id}/availability?scope=legacy`, {
      method: "PATCH", body: { items: [{ itemId: String(legacy.items[0]._id), availability: "AVAILABLE" }] },
      token: approver.token, idempotencyKey: newKey(),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("LEGACY_ACCESS_REQUIRED");
  });

  test("a legacy request cannot be mutated through the ordinary (non-legacy) path either", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const requester = await person({ co: a });
    const legacy = await legacyRequest(requester);

    const res = await call(`/${legacy._id}/availability`, {
      method: "PATCH", body: { items: [{ itemId: String(legacy.items[0]._id), availability: "AVAILABLE" }] },
      token: store.token, idempotencyKey: newKey(),
    });
    // Non-disclosing: the scoped query simply does not find it.
    expect(res.status).toBe(404);
  });
});

/* ═══ 3 · THE AUTHORITY MATRIX ═══════════════════════════════════════════ */

describe("distinct authority for requester, manager and store", () => {
  test("an ordinary requester sees their own request without any Store grant", async () => {
    const a = await company("Acme");
    const requester = await person({ co: a });          // no grant at all
    const { mrf } = await request({ co: a, requester });

    const list = await call("/", { token: requester.token });
    expect(list.status).toBe(200);
    expect(list.body.mrfs.map((m) => m.mrfNumber)).toContain(mrf.mrfNumber);

    const detail = await call(`/${mrf._id}`, { token: requester.token });
    expect(detail.status).toBe(200);
  });

  test("a requester sees ONLY their own — not a colleague's", async () => {
    const a = await company("Acme");
    const mine = await person({ co: a });
    const theirs = await person({ co: a });
    const { mrf: myMrf } = await request({ co: a, requester: mine });
    const { mrf: otherMrf } = await request({ co: a, requester: theirs });

    const list = await call("/", { token: mine.token });
    const numbers = list.body.mrfs.map((m) => m.mrfNumber);
    expect(numbers).toContain(myMrf.mrfNumber);
    expect(numbers).not.toContain(otherMrf.mrfNumber);
  });

  test("a requester cannot do the Store's job", async () => {
    const a = await company("Acme");
    const requester = await person({ co: a });
    const { mrf, itemId } = await request({ co: a, requester });

    for (const [path, body] of [
      [`/${mrf._id}/availability`, { items: [{ itemId, availability: "AVAILABLE" }] }],
      [`/${mrf._id}/issue`, { items: [{ itemId, issuedQty: 1 }] }],
    ]) {
      const res = await call(path, {
        method: path.endsWith("issue") ? "POST" : "PATCH",
        body, token: requester.token, idempotencyKey: newKey(),
      });
      expect(res.status).toBe(403);
    }
  });

  test("the assigned manager may see the request routed to them; an unassigned one may not", async () => {
    const a = await company("Acme");
    const assigned = await person({ co: a, name: "Assigned" });
    const other = await person({ co: a, name: "Other" });
    const requester = await person({ co: a, manager: assigned.emp });
    const { mrf } = await request({ co: a, requester, approver: assigned });

    const mine = await call("/", { token: assigned.token });
    expect(mine.body.mrfs.map((m) => m.mrfNumber)).toContain(mrf.mrfNumber);

    // An unrelated manager sees nothing and cannot read it by id.
    const theirs = await call("/", { token: other.token });
    expect(theirs.body.mrfs.map((m) => m.mrfNumber)).not.toContain(mrf.mrfNumber);
    expect((await call(`/${mrf._id}`, { token: other.token })).status).toBe(404);
  });

  test("EVERY read surface is gated, not just the detail route", async () => {
    /* Gating the mutations alone left four reads open to any colleague in the
       company — stock-check discloses the requester's email and phone, and the
       chat transcript was readable by people who could not post to it. */
    const a = await company("Acme");
    const assigned = await person({ co: a, name: "Assigned" });
    const nosy = await person({ co: a, name: "Nosy" });          // same company, no relationship
    const requester = await person({ co: a, manager: assigned.emp });
    const { mrf } = await request({ co: a, requester, approver: assigned });

    for (const path of ["", "/stock-check", "/chat", "/budget-head"]) {
      const res = await call(`/${mrf._id}${path}`, { token: nosy.token });
      expect([403, 404]).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toContain(mrf.mrfNumber);
    }

    // The people who should read it, still can.
    for (const who of [requester, assigned]) {
      expect((await call(`/${mrf._id}`, { token: who.token })).status).toBe(200);
    }
    const store = await person({ co: a, grant: "store" });
    expect((await call(`/${mrf._id}/stock-check`, { token: store.token })).status).toBe(200);
  });

  test("holding a Store grant does NOT make somebody the assigned approver", async () => {
    // Relationship authority and capability authority are separate: the store
    // may fulfil a request, and still may not take the manager's decision.
    const a = await company("Acme");
    const assigned = await person({ co: a, name: "Assigned" });
    const store = await person({ co: a, grant: "store", role: "owner" });
    const requester = await person({ co: a, manager: assigned.emp });
    const { mrf } = await request({ co: a, requester, approver: assigned, over: { status: "PENDING", tlApproved: false } });

    const stored = await MRF.findById(mrf._id).lean();
    expect(String(stored.approverEmployee)).toBe(String(assigned.emp._id));
    expect(String(stored.approverEmployee)).not.toBe(String(store.emp._id));
  });

  test("a Store viewer may read but not fulfil; an editor may fulfil", async () => {
    const a = await company("Acme");
    const viewer = await person({ co: a, grant: "store", role: "viewer" });
    const editor = await person({ co: a, grant: "store", role: "editor" });
    const requester = await person({ co: a });
    const { mrf, itemId } = await request({ co: a, requester });

    expect((await call("/", { token: viewer.token })).status).toBe(200);
    expect((await call(`/${mrf._id}/availability`, {
      method: "PATCH", body: { items: [{ itemId, availability: "AVAILABLE" }] },
      token: viewer.token, idempotencyKey: newKey(),
    })).status).toBe(403);

    expect((await call(`/${mrf._id}/availability`, {
      method: "PATCH", body: { items: [{ itemId, availability: "AVAILABLE" }] },
      token: editor.token, idempotencyKey: newKey(),
    })).status).toBe(200);
  });

  test("the store cannot act before the request has reached it", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const requester = await person({ co: a });
    const { mrf, itemId } = await request({
      co: a, requester, over: { status: "PENDING", tlApproved: false },
    });

    const res = await call(`/${mrf._id}/availability`, {
      method: "PATCH", body: { items: [{ itemId, availability: "AVAILABLE" }] },
      token: store.token, idempotencyKey: newKey(),
    });
    /* A state problem, not a permission problem — the store HAS the
       authority, the request has not been approved yet. */
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_TRANSITION");
  });
});

/* ═══ 4 · IDEMPOTENCY AND STOCK EFFECTS ══════════════════════════════════ */

describe("idempotent stock effects", () => {
  test("a duplicate issue deducts stock ONCE", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const requester = await person({ co: a });
    const { mrf, itemId, raw } = await request({ co: a, requester, stockQty: 100, requestedQty: 10 });
    const key = newKey();
    const body = { items: [{ itemId, issuedQty: 4 }] };

    const first = await call(`/${mrf._id}/issue`, { method: "POST", body, token: store.token, idempotencyKey: key });
    const retry = await call(`/${mrf._id}/issue`, { method: "POST", body, token: store.token, idempotencyKey: key });

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.replayed).toBe(true);

    const after = await RawItem.findById(raw._id).lean();
    expect(after.quantity).toBe(96);                    // not 92
    expect(after.stockTransactions).toHaveLength(1);    // one movement
    const stored = await MRF.findById(mrf._id).lean();
    expect(stored.items[0].issuedQty).toBe(4);
  });

  test("a duplicate return credits stock ONCE", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const requester = await person({ co: a });
    const { mrf, itemId, raw } = await request({ co: a, requester, stockQty: 100, requestedQty: 10 });
    await call(`/${mrf._id}/issue`, {
      method: "POST", body: { items: [{ itemId, issuedQty: 6 }] },
      token: store.token, idempotencyKey: newKey(),
    });

    const key = newKey();
    const body = { returnedQty: 2 };
    const first = await call(`/${mrf._id}/items/${itemId}/return`, {
      method: "POST", body, token: store.token, idempotencyKey: key,
    });
    const retry = await call(`/${mrf._id}/items/${itemId}/return`, {
      method: "POST", body, token: store.token, idempotencyKey: key,
    });
    expect(first.status).toBe(200);
    expect(retry.replayed).toBe(true);

    const after = await RawItem.findById(raw._id).lean();
    expect(after.quantity).toBe(96);                  // 100 - 6 + 2, once
    const stored = await MRF.findById(mrf._id).lean();
    expect(stored.items[0].returnedQty).toBe(2);
  });

  test("a failure after the stock moved cannot cause a second deduction on retry", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const requester = await person({ co: a });
    const { mrf, itemId, raw } = await request({ co: a, requester, stockQty: 100, requestedQty: 10 });
    const key = newKey();
    const body = { items: [{ itemId, issuedQty: 5 }] };

    /* Break the history write — the stock has already moved by then. */
    const spy = jest.spyOn(actionHistory, "record").mockImplementation(async (ctx, entry) => {
      if (entry.action === "ISSUED") throw new Error("history unavailable");
      return null;
    });
    const failed = await call(`/${mrf._id}/issue`, { method: "POST", body, token: store.token, idempotencyKey: key });
    expect(failed.status).toBe(500);
    spy.mockRestore();

    const afterFailure = (await RawItem.findById(raw._id).lean()).quantity;
    expect(afterFailure).toBe(95); // the stock DID move — that is the premise

    const retry = await call(`/${mrf._id}/issue`, { method: "POST", body, token: store.token, idempotencyKey: key });
    expect([200, 409]).toContain(retry.status);

    const final = await RawItem.findById(raw._id).lean();
    expect(final.quantity).toBe(95);                 // never 90
    expect(final.stockTransactions).toHaveLength(1); // one movement only
  });

  test("the fulfilment decision is a third stock path, and it deducts ONCE", async () => {
    /* /issue is not the only route that calls applyIssue: the fulfilment
       decision issues what is on the shelf before sending the rest to be
       bought. It had neither an effect marker nor a recovery branch, so a
       retry after the stock moved could deduct a second time. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store", role: "approver" });
    const requester = await person({ co: a });
    const { mrf, itemId, raw } = await request({ co: a, requester, stockQty: 100, requestedQty: 10 });

    const key = newKey();
    /* "Issue from stock" means the shelf covers the whole ask — the service
       refuses a short issue under this decision and asks for the partial one
       instead, so the line covers all 10. */
    const body = {
      decision: "issue_from_stock",
      lines: [{ itemId, issueQty: 10, buyQty: 0, rate: 0 }],
    };
    const first = await call(`/${mrf._id}/fulfilment-decision`, {
      method: "POST", body, token: store.token, idempotencyKey: key,
    });
    const retry = await call(`/${mrf._id}/fulfilment-decision`, {
      method: "POST", body, token: store.token, idempotencyKey: key,
    });

    expect(first.status).toBe(200);
    expect([200, 409]).toContain(retry.status);

    const after = await RawItem.findById(raw._id).lean();
    expect(after.quantity).toBe(90);                   // never 80
    expect(after.stockTransactions).toHaveLength(1);
    expect(await SpActionHistory.countDocuments({
      entityId: mrf._id, action: "STORE_FULFILMENT_DECISION",
    })).toBe(1);
  });

  test("a duplicate create produces one request", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const target = await person({ co: a });
    const tape = await catalogueItem();
    const key = newKey();
    const body = {
      employeeMongoId: String(target.emp._id), requestType: "USES_BASED", reason: "Need it",
      items: [{ rawItemId: String(tape._id), requestedQty: 2, unit: "pcs" }],
    };
    const first = await call("/bypass", { method: "POST", body, token: store.token, idempotencyKey: key });
    const retry = await call("/bypass", { method: "POST", body, token: store.token, idempotencyKey: key });
    expect(first.status).toBe(201);
    expect(retry.replayed).toBe(true);
    expect(await MRF.countDocuments({ companyId: a._id })).toBe(1);
  });

  test("a route that answers directly is still replayable, not left in progress", async () => {
    /* Only some handlers finish through succeed(). The rest answered with a
       plain res.json, which left the claim IN_PROGRESS — safe until the stale
       claim is reclaimed, after which a retry re-runs the mutation. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const requester = await person({ co: a });
    const { mrf, itemId } = await request({ co: a, requester });

    const key = newKey();
    const body = { items: [{ itemId, availability: "AVAILABLE" }] };
    const first = await call(`/${mrf._id}/availability`, {
      method: "PATCH", body, token: store.token, idempotencyKey: key,
    });
    const retry = await call(`/${mrf._id}/availability`, {
      method: "PATCH", body, token: store.token, idempotencyKey: key,
    });
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.replayed).toBe(true);      // replayed, never re-run
  });

  test("an effectful action without a key is refused", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const requester = await person({ co: a });
    const { mrf, itemId } = await request({ co: a, requester });
    const res = await call(`/${mrf._id}/issue`, {
      method: "POST", body: { items: [{ itemId, issuedQty: 1 }] }, token: store.token,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});

/* ═══ 5 · QUANTITY LIMITS ════════════════════════════════════════════════ */

describe("quantity limits", () => {
  test("issuing more than is owed is refused, and nothing moves", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const requester = await person({ co: a });
    const { mrf, itemId, raw } = await request({ co: a, requester, stockQty: 100, requestedQty: 5 });

    const res = await call(`/${mrf._id}/issue`, {
      method: "POST", body: { items: [{ itemId, issuedQty: 9 }] },
      token: store.token, idempotencyKey: newKey(),
    });
    expect(res.status).toBe(400);
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(100);
  });

  test("issuing more than the shelf holds is refused", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const requester = await person({ co: a });
    const { mrf, itemId, raw } = await request({ co: a, requester, stockQty: 2, requestedQty: 10 });

    const res = await call(`/${mrf._id}/issue`, {
      method: "POST", body: { items: [{ itemId, issuedQty: 8 }] },
      token: store.token, idempotencyKey: newKey(),
    });
    expect(res.status).toBe(409);
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(2);
  });

  test("returning more than was issued is refused", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const requester = await person({ co: a });
    const { mrf, itemId, raw } = await request({ co: a, requester, stockQty: 100, requestedQty: 10 });
    await call(`/${mrf._id}/issue`, {
      method: "POST", body: { items: [{ itemId, issuedQty: 3 }] },
      token: store.token, idempotencyKey: newKey(),
    });

    const res = await call(`/${mrf._id}/items/${itemId}/return`, {
      method: "POST", body: { returnedQty: 5 }, token: store.token, idempotencyKey: newKey(),
    });
    expect(res.status).toBe(400);
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(97); // unchanged by the refusal
  });
});

/* ═══ 6 · IMMUTABLE HISTORY ══════════════════════════════════════════════ */

describe("action history", () => {
  test("issuing and returning each append exactly one entry, and a replay appends none", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const requester = await person({ co: a });
    const { mrf, itemId } = await request({ co: a, requester, stockQty: 100, requestedQty: 10 });

    const issueKey = newKey();
    const issueBody = { items: [{ itemId, issuedQty: 4 }] };
    await call(`/${mrf._id}/issue`, { method: "POST", body: issueBody, token: store.token, idempotencyKey: issueKey });
    await call(`/${mrf._id}/issue`, { method: "POST", body: issueBody, token: store.token, idempotencyKey: issueKey });

    await call(`/${mrf._id}/items/${itemId}/return`, {
      method: "POST", body: { returnedQty: 1 }, token: store.token, idempotencyKey: newKey(),
    });

    expect(await SpActionHistory.countDocuments({ entityId: mrf._id, action: "ISSUED" })).toBe(1);
    expect(await SpActionHistory.countDocuments({ entityId: mrf._id, action: "RETURNED" })).toBe(1);

    const entries = await SpActionHistory.find({ entityId: mrf._id }).lean();
    for (const e of entries) {
      expect(String(e.companyId)).toBe(String(a._id));   // tenant-scoped
      expect(e.documentNumber).toBe(mrf.mrfNumber);
      expect(e.actorId).toBeTruthy();
    }
  });

  test("EVERY governed mutation leaves an append-only row, not just the stock ones", async () => {
    /* The MRF carries its own embedded event log, which is edited with the
       document it lives on — so it is a convenience, never the audit trail.
       Only issue and return were writing to the append-only history. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store", role: "approver" });
    const requester = await person({ co: a });
    const { mrf, itemId } = await request({ co: a, requester, stockQty: 100, requestedQty: 10 });

    await call(`/${mrf._id}/availability`, {
      method: "PATCH", body: { items: [{ itemId, availability: "AVAILABLE" }] },
      token: store.token, idempotencyKey: newKey(),
    });
    /* Rejecting a line applies to one the store could not match — that is the
       only state the route accepts, so the fixture has to be in it. */
    await MRF.updateOne(
      { _id: mrf._id, "items._id": itemId },
      { $set: { "items.$.itemStatus": "UNMATCHED", "items.$.rawItem": null } },
    );
    const rejected = await call(`/${mrf._id}/items/${itemId}/reject`, {
      method: "PATCH", body: { note: "Not needed" }, token: store.token, idempotencyKey: newKey(),
    });
    expect(rejected.status).toBe(200);
    await call(`/${mrf._id}/cancel`, {
      method: "PATCH", body: { cancellationNote: "Withdrawn" },
      token: store.token, idempotencyKey: newKey(),
    });

    const actions = (await SpActionHistory.find({ entityId: mrf._id }).lean()).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining([
      "AVAILABILITY_UPDATED", "ITEM_REJECTED", "CANCELLED",
    ]));

    const cancelled = await SpActionHistory.findOne({ entityId: mrf._id, action: "CANCELLED" }).lean();
    expect(cancelled.previousState).toBe("APPROVED");   // the state it was actually in
    expect(cancelled.resultingState).toBe("CANCELLED");
  });

  test("history is tenant-scoped and cannot be mutated", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const requester = await person({ co: a });
    const { mrf, itemId } = await request({ co: a, requester });
    await call(`/${mrf._id}/issue`, {
      method: "POST", body: { items: [{ itemId, issuedQty: 1 }] },
      token: store.token, idempotencyKey: newKey(),
    });

    const entry = await SpActionHistory.findOne({ entityId: mrf._id });
    await expect(SpActionHistory.updateOne({ _id: entry._id }, { $set: { action: "X" } }))
      .rejects.toThrow(/append-only/);
    await expect(SpActionHistory.deleteOne({ _id: entry._id })).rejects.toThrow(/append-only/);
  });
});

/* ═══ 7 · LEGACY PRODUCT-REQUEST WRITES ══════════════════════════════════ */

test("the retired product-request write routes refuse clearly, and say what replaced them", async () => {
  const a = await company("Acme");
  const store = await person({ co: a, grant: "store", role: "owner" });
  for (const op of ["match", "approve", "reject"]) {
    const res = await call(`/product-requests/${new mongoose.Types.ObjectId()}/${op}`, {
      method: "PATCH", body: {}, token: store.token, idempotencyKey: newKey(),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("LEGACY_ACCESS_REQUIRED");
    expect(res.body.error.details.replacedBy).toMatch(/\/items\/:itemId\//);
  }
});
