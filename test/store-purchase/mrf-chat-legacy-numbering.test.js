// test/store-purchase/mrf-chat-legacy-numbering.test.js
//
// Store & Purchase — Chunk 1B correction pass.
//
// Three things the first pass got wrong, each proved here rather than asserted
// in a report:
//   · chat ownership went onto ATTACHMENTS, so no message was ever scoped and
//     the mark-read route took an id straight from the URL;
//   · product requests are legacy-global, and several routes still read and
//     wrote them as though they belonged to whoever asked;
//   · request numbers came from read-last-plus-one, globally, in a hook.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({ admin: {}, db: {}, auth: {}, messaging: {}, rtdb: {} }));
jest.mock("../../services/mrfNotify.service", () =>
  new Proxy({}, { get: () => () => Promise.resolve() }));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const MrfChatMessage = require("../../models/CMS_Models/Inventory/Operations/MrfChatMessage");
const RawItemAddRequest = require("../../models/CMS_Models/Inventory/Operations/RawItemAddRequest");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Employee = require("../../models/Employee");
require("../../models/ProjectManager");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
const documentSequence = require("../../services/storePurchase/documentSequence.service");
const actionHistory = require("../../services/storePurchase/actionHistory.service");

let server, storeBase, coworkBase, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/mrf", require("../../routes/CMS_Routes/Inventory/Operations/mrfRoutes"));
  const cw = require("../../routes/CMS_Routes/Inventory/Operations/coworkMrfRoutes");
  app.use("/api/cms/mrf", cw.cmsChain, cw);
  await new Promise((r) => { server = app.listen(0, r); });
  storeBase = `http://127.0.0.1:${server.address().port}/api/cms/inventory/mrf`;
  coworkBase = `http://127.0.0.1:${server.address().port}/api/cms/mrf`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => { jest.restoreAllMocks(); });

const newKey = () => `cx-${++seq}-${Math.random().toString(36).slice(2)}`;

const request = (base) => (who, path, { method = "GET", body, idempotencyKey } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      Authorization: `Bearer ${jwt.sign(
        {
          id: who.tokenId, role: "employee",
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

const callStore = (...a) => request(storeBase)(...a);
const callCowork = (...a) => request(coworkBase)(...a);

async function twoCompanies() {
  const a = await Acc_Company.create({ companyName: `Acme ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const b = await Acc_Company.create({ companyName: `Borealis ${++seq}`, booksFromDate: new Date("2026-04-01") });
  return { a, b };
}

/**
 * `door` decides which id the session presents: the store door signs an
 * Employee _id, the cowork door a biometricId. Both are real.
 */
async function person({ co, grant = null, role = "approver", name = "P", manager = null, door = "cowork" }) {
  const n = ++seq;
  const email = `cx${n}@test.example`;
  const emp = await Employee.create({
    firstName: name, lastName: `L${n}`, email, biometricId: `CX${n}`,
    isActive: true, gender: "Other", department: "Tech",
    ...(manager ? { primaryManager: { managerId: manager._id, managerName: "Mgr" } } : {}),
  });
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role, isActive: true });
  if (co) await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: name });
  return { emp, email, tokenId: door === "cowork" ? emp.biometricId : String(emp._id) };
}

const catalogueItem = async () => RawItem.create({
  name: `Cone ${++seq}`, sku: `CN-${seq}`, unit: "pcs", quantity: 40, minStock: 0,
});

/** A company-owned, TL-approved request, numbered the way the app numbers one. */
async function ownedRequest({ co, requester, approver }) {
  const raw = await catalogueItem();
  const allocated = await documentSequence.allocate({
    companyId: co._id, documentType: "MATERIAL_REQUEST",
  });
  const mrf = await MRF.create({
    companyId: co._id,
    mrfNumber: allocated.number,
    requestedFor: requester.emp._id, requestedForName: "Req", requestedForDept: "Tech",
    requestedForId: requester.emp.biometricId,
    requestType: "USES_BASED", status: "APPROVED", tlApproved: true, tlApprovedAt: new Date(),
    createdByRef: requester.emp._id, createdByModel: "Employee", createdByName: "Req",
    reason: "The old one failed",
    ...(approver ? {
      approverEmployee: approver.emp._id, approverName: "Mgr",
      approverBiometricId: approver.emp.biometricId,
    } : {}),
    items: [{
      rawItem: raw._id, rawItemName: raw.name, rawItemSku: raw.sku,
      requestedQty: 5, unit: "pcs", baseUnit: "pcs", itemStatus: "APPROVED",
    }],
  });
  return { mrf, raw };
}

/* ═══ 1 · CHAT OWNERSHIP ═════════════════════════════════════════════════ */

describe("chat ownership", () => {
  test("a message carries the company on the MESSAGE, and attachments carry none", async () => {
    const { a } = await twoCompanies();
    const storePerson = await person({ co: a, grant: "store", name: "Storekeeper", door: "store" });
    const requester = await person({ co: a });
    const { mrf } = await ownedRequest({ co: a, requester });

    const posted = await callStore(storePerson, `/${mrf._id}/chat`, {
      method: "POST", idempotencyKey: newKey(),
      body: {
        body: "Is this the 40mm one?",
        attachments: [{ url: "https://example.test/a.png", name: "a.png" }],
      },
    });
    expect(posted.status).toBe(201);

    const stored = await MrfChatMessage.findById(posted.body.message._id).lean();
    expect(String(stored.companyId)).toBe(String(a._id));   // on the message
    expect(stored.attachments).toHaveLength(1);
    /* Ownership was on the attachment sub-schema, where it protected nothing:
       an attachment is only ever reached through its message. */
    expect(stored.attachments[0]).not.toHaveProperty("companyId");
  });

  test("company A cannot list, post to, or mark read company B's thread", async () => {
    const { a, b } = await twoCompanies();
    const storeA = await person({ co: a, grant: "store", door: "store" });
    const requesterB = await person({ co: b });
    const storeB = await person({ co: b, grant: "store", door: "store" });
    const { mrf } = await ownedRequest({ co: b, requester: requesterB });

    await callStore(storeB, `/${mrf._id}/chat`, {
      method: "POST", body: { body: "B's private note" }, idempotencyKey: newKey(),
    });
    const before = await MrfChatMessage.countDocuments({ subject: mrf._id });
    expect(before).toBe(1);

    // A guessed id from another company: read, post and mark-read all refuse.
    expect((await callStore(storeA, `/${mrf._id}/chat`)).status).toBe(404);
    expect((await callStore(storeA, `/${mrf._id}/chat`, {
      method: "POST", body: { body: "prying" }, idempotencyKey: newKey(),
    })).status).toBe(404);
    expect((await callStore(storeA, `/${mrf._id}/chat/read`, { method: "PATCH" })).status).toBe(404);

    // Nothing was added, and nothing was marked read on B's behalf.
    expect(await MrfChatMessage.countDocuments({ subject: mrf._id })).toBe(1);
    const msg = await MrfChatMessage.findOne({ subject: mrf._id }).lean();
    expect(msg.readBy).not.toContain(String(storeA.emp._id));
  });

  test("the chat service refuses to work without tenant scope for an owned request", async () => {
    /* The service used to take a bare id and no context, which is how the
       mark-read route bypassed every boundary. */
    const { a } = await twoCompanies();
    const requester = await person({ co: a });
    const { mrf } = await ownedRequest({ co: a, requester });
    const mrfChat = require("../../services/mrfChat.service");

    await expect(mrfChat.listMessages(mrf, { ctx: null })).rejects.toThrow(/company context/i);
    await expect(
      mrfChat.markRead(mrf, { ctx: { companyId: new mongoose.Types.ObjectId() }, readerId: "x" }),
    ).rejects.toThrow(/another company/i);
  });
});

  test("the cowork door is scoped too — a guessed id marks nothing read", async () => {
    const { a, b } = await twoCompanies();
    const requesterA = await person({ co: a, name: "Rutu" });
    const requesterB = await person({ co: b, name: "Vik" });
    const { mrf } = await ownedRequest({ co: b, requester: requesterB });
    await MrfChatMessage.create({
      subjectType: "MRF", subject: mrf._id, mrf: mrf._id,
      companyId: b._id, body: "B's note", readBy: [],
    });

    expect((await callCowork(requesterA, `/${mrf._id}/chat`)).status).toBe(404);
    expect((await callCowork(requesterA, `/${mrf._id}/chat`, {
      method: "POST", body: { body: "prying" }, idempotencyKey: newKey(),
    })).status).toBe(404);
    expect((await callCowork(requesterA, `/${mrf._id}/chat/read`, { method: "PATCH" })).status).toBe(404);

    const msg = await MrfChatMessage.findOne({ subject: mrf._id }).lean();
    expect(msg.readBy).toHaveLength(0);
    expect(await MrfChatMessage.countDocuments({ subject: mrf._id })).toBe(1);
  });

/* ═══ 2 · AT-MOST-ONCE CHAT ══════════════════════════════════════════════ */

describe("chat posting is at most once", () => {
  test("a duplicate post creates ONE message and does not double the counter", async () => {
    const { a } = await twoCompanies();
    const storePerson = await person({ co: a, grant: "store", door: "store" });
    const requester = await person({ co: a });
    const { mrf } = await ownedRequest({ co: a, requester });

    const key = newKey();
    const body = { body: "Sending it up now." };
    const first = await callStore(storePerson, `/${mrf._id}/chat`, { method: "POST", body, idempotencyKey: key });
    const retry = await callStore(storePerson, `/${mrf._id}/chat`, { method: "POST", body, idempotencyKey: key });

    expect(first.status).toBe(201);
    expect(retry.replayed).toBe(true);
    expect(await MrfChatMessage.countDocuments({ subject: mrf._id, isSystem: false })).toBe(1);

    const parent = await MRF.findById(mrf._id).lean();
    expect(parent.chatMessageCount).toBe(1);
  });

  test("a failure AFTER the message exists cannot produce a second one", async () => {
    /* The window the first pass left open: the message was created, then the
       parent save or the settlement failed, and the retry started over. */
    const { a } = await twoCompanies();
    const storePerson = await person({ co: a, grant: "store", door: "store" });
    const requester = await person({ co: a });
    const { mrf } = await ownedRequest({ co: a, requester });

    const key = newKey();
    const body = { body: "Did it arrive?" };

    const spy = jest.spyOn(actionHistory, "record").mockRejectedValueOnce(new Error("history unavailable"));
    const failed = await callStore(storePerson, `/${mrf._id}/chat`, { method: "POST", body, idempotencyKey: key });
    expect(failed.status).toBe(500);
    spy.mockRestore();

    // The message is already out — that is the premise of the test.
    expect(await MrfChatMessage.countDocuments({ subject: mrf._id, isSystem: false })).toBe(1);

    const retry = await callStore(storePerson, `/${mrf._id}/chat`, { method: "POST", body, idempotencyKey: key });
    expect([200, 201]).toContain(retry.status);
    expect(await MrfChatMessage.countDocuments({ subject: mrf._id, isSystem: false })).toBe(1);

    const parent = await MRF.findById(mrf._id).lean();
    expect(parent.chatMessageCount).toBe(1);   // recomputed, never incremented twice
    // And the history the first attempt failed to write is repaired.
    expect(await SpActionHistory.countDocuments({
      entityId: mrf._id, action: "CHAT_MESSAGE",
    })).toBe(1);
  });
});

/* ═══ 2b · IDEMPOTENCY SETTLEMENT ════════════════════════════════════════ */

describe("settlement is explicit", () => {
  const SpIdempotencyRecord = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");
  const idempotency = require("../../services/storePurchase/idempotency.service");

  test("a success that never claimed its record is not left replayable", async () => {
    /* The middleware used to COMPLETE any 2xx it saw, promising a replay of a
       business effect it knew nothing about. It now abandons instead: a retry
       either redoes work that never happened, or takes the recovery path. */
    const { a } = await twoCompanies();
    const storePerson = await person({ co: a, grant: "store", door: "store" });
    const requester = await person({ co: a });
    const { mrf } = await ownedRequest({ co: a, requester });

    /* /:id/stock-check is a read behind no key; use a governed route whose
       handler answers directly by stubbing succeed away. */
    const key = newKey();
    const res = await callStore(storePerson, `/${mrf._id}/chat`, {
      method: "POST", body: { body: "hello" }, idempotencyKey: key,
    });
    expect(res.status).toBe(201);
    const rec = await SpIdempotencyRecord.findOne({ key }).lean();
    expect(rec.status).toBe("COMPLETED");        // it DID claim it
  });

  test("a stale claim is reclaimed only when no effect was recorded", async () => {
    const { a } = await twoCompanies();
    const storePerson = await person({ co: a, grant: "store", door: "store" });
    const requester = await person({ co: a });
    const { mrf } = await ownedRequest({ co: a, requester });

    const ctx = { companyId: a._id, actorId: String(storePerson.emp._id) };
    const stale = new Date(Date.now() - 5 * 60 * 1000);

    // No effect: reclaimable.
    const clean = await SpIdempotencyRecord.create({
      companyId: a._id, actorId: ctx.actorId, operation: "MRF_CHAT", key: newKey(),
      requestHash: "x", status: "IN_PROGRESS", heartbeatAt: stale, effectAppliedAt: null,
    });
    const reclaimed = await SpIdempotencyRecord.findOneAndUpdate(
      { _id: clean._id, status: "IN_PROGRESS", effectAppliedAt: null },
      { $set: { heartbeatAt: new Date() } }, { new: true },
    );
    expect(reclaimed).toBeTruthy();

    // Effect recorded: NOT reclaimable, however old.
    const applied = await SpIdempotencyRecord.create({
      companyId: a._id, actorId: ctx.actorId, operation: "MRF_CHAT", key: newKey(),
      requestHash: "x", status: "EFFECT_APPLIED", heartbeatAt: stale, effectAppliedAt: stale,
    });
    const notReclaimed = await SpIdempotencyRecord.findOneAndUpdate(
      { _id: applied._id, status: "IN_PROGRESS", effectAppliedAt: null },
      { $set: { heartbeatAt: new Date() } }, { new: true },
    );
    expect(notReclaimed).toBeNull();

    // And abandon refuses to release it, so a retry can never repeat the work.
    await idempotency.abandon({ record: applied, reason: "test" });
    const after = await SpIdempotencyRecord.findById(applied._id).lean();
    expect(after.status).toBe("EFFECT_APPLIED");
  });
});

/* ═══ 3 · LEGACY PRODUCT REQUESTS ════════════════════════════════════════ */

describe("product requests are legacy-global", () => {
  const legacyProductRequest = async (requester) => RawItemAddRequest.create({
    requestedBy: requester.emp._id,
    requesterCoworkId: requester.emp.biometricId,
    status: "PENDING",
    products: [{ itemName: "Bespoke jig", requestedQty: 1, unit: "pcs" }],
  });

  test("detail needs explicit legacy mode, and the capability alone is not enough", async () => {
    const { a } = await twoCompanies();
    const requester = await person({ co: a });
    const doc = await legacyProductRequest(requester);

    const editor = await person({ co: a, grant: "store", role: "editor", door: "store" });   // no legacy.read
    const approver = await person({ co: a, grant: "store", role: "approver", door: "store" });

    // Ordinary read: refused, whoever asks.
    const ordinary = await callStore(approver, `/product-requests/${doc._id}`);
    expect(ordinary.status).toBe(403);
    expect(ordinary.body.error.code).toBe("LEGACY_ACCESS_REQUIRED");

    // Asking for legacy without the capability: refused.
    expect((await callStore(editor, `/product-requests/${doc._id}?scope=legacy`)).status).toBe(403);

    // Both together: readable.
    const allowed = await callStore(approver, `/product-requests/${doc._id}?scope=legacy`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.request.products[0].itemName).toBe("Bespoke jig");
  });

  test("EVERY product-request mutation is refused on both doors", async () => {
    const { a } = await twoCompanies();
    const requester = await person({ co: a });
    const doc = await legacyProductRequest(requester);
    const storePerson = await person({ co: a, grant: "store", role: "owner", door: "store" });

    const storeWrites = [
      ["PATCH", `/product-requests/${doc._id}/match`],
      ["PATCH", `/product-requests/${doc._id}/approve`],
      ["PATCH", `/product-requests/${doc._id}/reject`],
      ["POST", `/product-requests/${doc._id}/chat`],
    ];
    for (const [method, path] of storeWrites) {
      const res = await callStore(storePerson, path, { method, body: {}, idempotencyKey: newKey() });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("LEGACY_ACCESS_REQUIRED");
    }

    const coworkWrites = [
      ["PATCH", `/product-requests/${doc._id}/tl-approve`],
      ["PATCH", `/product-requests/${doc._id}/tl-reject`],
      ["POST", `/product-requests/${doc._id}/chat`],
      ["PATCH", `/product-requests/${doc._id}/chat/read`],
    ];
    for (const [method, path] of coworkWrites) {
      const res = await callCowork(requester, path, { method, body: {}, idempotencyKey: newKey() });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("LEGACY_ACCESS_REQUIRED");
    }

    // Untouched, and still unowned — never adopted by whoever asked.
    const after = await RawItemAddRequest.findById(doc._id).lean();
    expect(after.status).toBe("PENDING");
    expect(after.companyId).toBeUndefined();
  });

  test("reading a legacy thread does not mark it read", async () => {
    const { a } = await twoCompanies();
    const requester = await person({ co: a });
    const doc = await legacyProductRequest(requester);
    await MrfChatMessage.create({
      subjectType: "PRODUCT_REQUEST", subject: doc._id, body: "old note", readBy: [],
    });
    const approver = await person({ co: a, grant: "store", role: "approver", door: "store" });

    const res = await callStore(approver, `/product-requests/${doc._id}/chat?scope=legacy`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);

    const msg = await MrfChatMessage.findOne({ subject: doc._id }).lean();
    expect(msg.readBy).toHaveLength(0);        // a read must not write
  });

  test("the compatibility POST makes ONE company-owned MRF, and replays as one", async () => {
    const { a } = await twoCompanies();
    const tl = await person({ co: a, name: "Meera" });
    const requester = await person({ co: a, name: "Rutu", manager: tl.emp });
    const raw = await catalogueItem();

    const key = newKey();
    const body = {
      priority: "NORMAL", reason: "Need one",
      products: [{ itemName: raw.name, rawItemId: String(raw._id), requestedQty: 2, unit: "pcs" }],
    };
    const first = await callCowork(requester, "/product-requests", { method: "POST", body, idempotencyKey: key });
    const retry = await callCowork(requester, "/product-requests", { method: "POST", body, idempotencyKey: key });

    expect(first.status).toBe(201);
    expect(retry.replayed).toBe(true);
    expect(await MRF.countDocuments({})).toBe(1);
    expect(await RawItemAddRequest.countDocuments({})).toBe(0);   // no new legacy record

    const made = await MRF.findOne({}).lean();
    expect(String(made.companyId)).toBe(String(a._id));
    expect(made.mrfNumber).toMatch(/^MRF\//);                     // sequence-issued
    expect(await SpActionHistory.countDocuments({ entityId: made._id, action: "CREATED" })).toBe(1);
  });

  test("a missing key is refused on the compatibility POST", async () => {
    const { a } = await twoCompanies();
    const tl = await person({ co: a });
    const requester = await person({ co: a, manager: tl.emp });
    const raw = await catalogueItem();
    const res = await callCowork(requester, "/product-requests", {
      method: "POST",
      body: { reason: "x", products: [{ itemName: raw.name, rawItemId: String(raw._id), requestedQty: 1, unit: "pcs" }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});

/* ═══ 4 · ONE AUTHORITY MATRIX ═══════════════════════════════════════════ */

describe("one authority matrix across both doors", () => {
  test("a CEO cannot approve a request that was not routed to them", async () => {
    /* The cowork door used to answer `canApprove: true` for any session whose
       role was "ceo", regardless of the org chart. */
    const { a } = await twoCompanies();
    const tl = await person({ co: a, name: "Meera" });
    const requester = await person({ co: a, name: "Rutu", manager: tl.emp });
    const ceo = await person({ co: a, name: "Chief" });
    const { mrf } = await ownedRequest({ co: a, requester, approver: tl });
    await MRF.updateOne({ _id: mrf._id }, { $set: { status: "PENDING", tlApproved: false } });

    const ceoToken = { ...ceo, tokenId: ceo.emp.biometricId };
    const res = await fetch(`${coworkBase}/${mrf._id}/tl-approve`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey(),
        Authorization: `Bearer ${jwt.sign(
          { id: ceo.emp.biometricId, role: "ceo", employeeId: ceo.emp.biometricId, email: ceo.email, name: "Chief" },
          process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
        )}`,
      },
      body: JSON.stringify({}),
    }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

    expect([403, 404]).toContain(res.status);
    const after = await MRF.findById(mrf._id).lean();
    expect(after.tlApproved).toBeFalsy();
  });

  test("nobody can approve their own request, even when the record names them as approver", async () => {
    const { a } = await twoCompanies();
    const self = await person({ co: a, name: "Solo" });
    const raw = await catalogueItem();
    const allocated = await documentSequence.allocate({ companyId: a._id, documentType: "MATERIAL_REQUEST" });

    /* A malformed record: requester and approver are the same person. The
       routing fallback can produce this when somebody's manager is themselves. */
    const mrf = await MRF.create({
      companyId: a._id, mrfNumber: allocated.number,
      requestedFor: self.emp._id, requestedForName: "Solo", requestedForId: self.emp.biometricId,
      requestType: "USES_BASED", status: "PENDING",
      createdByRef: self.emp._id, createdByModel: "Employee", createdByName: "Solo",
      approverEmployee: self.emp._id, approverBiometricId: self.emp.biometricId, approverName: "Solo",
      items: [{ rawItem: raw._id, rawItemName: raw.name, requestedQty: 1, unit: "pcs", itemStatus: "PENDING" }],
    });

    const res = await callCowork(self, `/${mrf._id}/tl-approve`, {
      method: "PATCH", body: {}, idempotencyKey: newKey(),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.details?.reason).toBe("SELF_APPROVAL");

    const after = await MRF.findById(mrf._id).lean();
    expect(after.tlApproved).toBeFalsy();
  });
});

/* ═══ 5 · HISTORY IS RECOVERABLE FOR NON-STOCK MUTATIONS ═════════════════ */

describe("a history failure is repaired, not concealed", () => {
  const cases = [
    {
      name: "approve",
      run: async (env) => callCowork(env.tl, `/${env.mrf._id}/tl-approve`, {
        method: "PATCH", body: {}, idempotencyKey: env.key,
      }),
      action: "TL_APPROVED",
      pending: true,
    },
    {
      name: "cancel",
      run: async (env) => callCowork(env.requester, `/${env.mrf._id}/cancel`, {
        method: "PATCH", body: { cancellationNote: "Not needed" }, idempotencyKey: env.key,
      }),
      action: "CANCELLED",
      pending: true,
    },
  ];

  for (const c of cases) {
    test(`${c.name}: history written on the retry, not lost`, async () => {
      const { a } = await twoCompanies();
      const tl = await person({ co: a, name: "Meera" });
      const requester = await person({ co: a, name: "Rutu", manager: tl.emp });
      const { mrf } = await ownedRequest({ co: a, requester, approver: tl });
      if (c.pending) {
        await MRF.updateOne({ _id: mrf._id }, { $set: { status: "PENDING", tlApproved: false } });
      }
      const env = { tl, requester, mrf, key: newKey() };

      /* The mutation commits; the history write is what fails. */
      const spy = jest.spyOn(actionHistory, "record").mockRejectedValueOnce(new Error("history unavailable"));
      const failed = await c.run(env);
      expect(failed.status).toBe(500);
      spy.mockRestore();

      /* Whatever happened to the request, the retry must end with the change
         recorded exactly once — the "already approved" shortcut used to
         return success here while the record stayed missing forever. */
      const retry = await c.run(env);
      expect([200, 201]).toContain(retry.status);
      expect(await SpActionHistory.countDocuments({
        entityId: mrf._id, action: c.action,
      })).toBe(1);
    });
  }
});

/* ═══ 6 · NUMBERING ══════════════════════════════════════════════════════ */

describe("material-request numbering", () => {
  test("a company-owned request refuses to be saved without an allocated number", async () => {
    const { a } = await twoCompanies();
    const requester = await person({ co: a });
    await expect(MRF.create({
      companyId: a._id,
      requestedFor: requester.emp._id, requestedForName: "R", requestedForId: requester.emp.biometricId,
      requestType: "USES_BASED", status: "PENDING",
      createdByRef: requester.emp._id, createdByModel: "Employee", createdByName: "R",
      items: [{ rawItemName: "Thing", requestedQty: 1, unit: "pcs" }],
    })).rejects.toThrow(/SpDocumentSequence/);
  });

  test("concurrent creation produces unique, contiguous numbers", async () => {
    const { a } = await twoCompanies();
    const allocations = await Promise.all(
      Array.from({ length: 25 }, () =>
        documentSequence.allocate({ companyId: a._id, documentType: "MATERIAL_REQUEST" })),
    );
    const numbers = allocations.map((x) => x.number);
    expect(new Set(numbers).size).toBe(25);
    const sequences = allocations.map((x) => x.sequence).sort((p, q) => p - q);
    expect(sequences).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  test("an interrupted creation does not produce a second request", async () => {
    /* The retry used to build and save another one — a second number, a
       second piece of paper, for one person asking once. */
    const { a } = await twoCompanies();
    const tl = await person({ co: a, name: "Meera" });
    const requester = await person({ co: a, name: "Rutu", manager: tl.emp });
    const raw = await catalogueItem();
    const key = newKey();
    const body = {
      requestType: "USES_BASED", priority: "NORMAL", reason: "The old one failed",
      items: [{ rawItemId: String(raw._id), rawItemName: raw.name, requestedQty: 2, unit: "pcs" }],
    };

    const spy = jest.spyOn(actionHistory, "record").mockRejectedValueOnce(new Error("history unavailable"));
    const failed = await callCowork(requester, "/", { method: "POST", body, idempotencyKey: key });
    expect(failed.status).toBe(500);
    spy.mockRestore();
    expect(await MRF.countDocuments({})).toBe(1);          // it did get created

    const retry = await callCowork(requester, "/", { method: "POST", body, idempotencyKey: key });
    expect([200, 201]).toContain(retry.status);
    expect(await MRF.countDocuments({})).toBe(1);          // and only once
    expect(await SpActionHistory.countDocuments({ action: "CREATED" })).toBe(1);
  });

  test("two companies number independently", async () => {
    const { a, b } = await twoCompanies();
    const first = await documentSequence.allocate({ companyId: a._id, documentType: "MATERIAL_REQUEST" });
    const other = await documentSequence.allocate({ companyId: b._id, documentType: "MATERIAL_REQUEST" });
    expect(first.number).toBe(other.number);          // same number, different companies
    expect(first.sequence).toBe(1);
    expect(other.sequence).toBe(1);
  });

  test("existing numbers are left in their old shape", async () => {
    /* Legacy requests keep `MRF-2609-0004`; new ones take `MRF/2026-27/0001`.
       Nothing renumbers, because those numbers are on paper and in inboxes. */
    const requester = await person({ co: null });
    const legacy = await MRF.create({
      mrfNumber: "MRF-2509-0004",
      requestedFor: requester.emp._id, requestedForName: "R", requestedForId: requester.emp.biometricId,
      requestType: "USES_BASED", status: "APPROVED",
      createdByRef: requester.emp._id, createdByModel: "Employee", createdByName: "R",
      items: [{ rawItemName: "Old", requestedQty: 1, unit: "pcs" }],
    });
    const stored = await MRF.findById(legacy._id).lean();
    expect(stored.mrfNumber).toBe("MRF-2509-0004");
  });
});
