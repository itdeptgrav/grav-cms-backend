// test/store-purchase/mrf-item-approval.route.test.js
//
// ITEM-WISE APPROVAL, THROUGH BOTH DOORS.
//
// The manager decides lines one at a time on the requester's door
// (/api/cms/mrf — the same handlers Cowork uses at /api/cowork/mrf). A line
// they approve reaches the Store at once; a line still waiting, or one they
// rejected, must not exist as far as the Store's door (/api/cms/inventory/mrf)
// is concerned — not on its screens and not for issuing or reserving.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({ admin: {}, db: {}, auth: {}, messaging: {}, rtdb: {} }));
jest.mock("../../services/mrfNotify.service", () =>
  new Proxy({}, { get: () => () => Promise.resolve() }));
jest.mock("../../services/mrfChat.service", () => ({
  systemMessage: () => Promise.resolve(null),
  postMessage: () => Promise.resolve({ message: { _id: "m1" }, created: true }),
  listMessages: () => Promise.resolve([]),
  markRead: () => Promise.resolve({ unread: 0 }),
  describeSubject: () => ({ label: "" }),
}));

const express = require("express");
const jwt = require("jsonwebtoken");

const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Employee = require("../../models/Employee");
require("../../models/ProjectManager");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
const SpDocumentSequence = require("../../models/CMS_Models/StorePurchase/SpDocumentSequence");

let server, root, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const cowork = require("../../routes/CMS_Routes/Inventory/Operations/coworkMrfRoutes");
  app.use("/api/cms/mrf", cowork.cmsChain, cowork);
  app.use("/api/cms/inventory/mrf", require("../../routes/CMS_Routes/Inventory/Operations/mrfRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  root = `http://127.0.0.1:${server.address().port}`;
  /* Every collection exists before the first test, as it does on any real
     deployment. On a fresh in-memory database the FIRST transactional write
     creates collections inside the transaction, which can conflict and be
     retried — and a retried mongoose save writes nothing (see decideLines).
     Without this, whichever test runs first was flaky for that reason alone. */
  const mongoose = require("mongoose");
  await Promise.all(Object.values(mongoose.models).map((m) => m.createCollection().catch(() => {})));
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const newKey = () => `ia-${++seq}-${Math.random().toString(36).slice(2)}`;

const tokenFor = (p) => jwt.sign(
  {
    id: String(p.emp._id), email: p.email, name: `${p.emp.firstName} ${p.emp.lastName}`,
    role: "employee", employeeId: p.emp.biometricId,
  },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
);

/** `door`: "mrf" is the requester/manager door, "store" the Store's. */
const call = (who, door, path, { method = "GET", body, idempotencyKey } = {}) =>
  fetch(`${root}${door === "store" ? "/api/cms/inventory/mrf" : "/api/cms/mrf"}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenFor(who)}`,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({
    status: r.status,
    body: JSON.parse((await r.text()) || "null"),
    replayed: r.headers.get("Idempotency-Replayed") === "true",
  }));

async function person({ co, name = "P", manager = null, grant = null }) {
  const n = ++seq;
  const email = `ia${n}@test.example`;
  const emp = await Employee.create({
    firstName: name, lastName: `L${n}`, email, biometricId: `IA${n}`,
    isActive: true, gender: "Other", department: "Tech",
    ...(manager ? { primaryManager: { managerId: manager._id, managerName: "Mgr" } } : {}),
  });
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: name });
  return { emp, email };
}

/** A company with a requester, their manager, a Store person and an outsider. */
async function world() {
  const co = await Acc_Company.create({ companyName: `Acme ${++seq}`, booksFromDate: new Date("2026-04-01") });
  /* A second company, so the single-company fallback never resolves tenancy. */
  await Acc_Company.create({ companyName: `Other ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const tl = await person({ co, name: "Rakesh" });
  const requester = await person({ co, name: "Pramod", manager: tl.emp });
  const store = await person({ co, name: "Store", grant: "store" });
  const stranger = await person({ co, name: "Anil" });
  return { co, tl, requester, store, stranger };
}

/** A pending request with `n` catalogue lines of 10 pcs each. */
async function raise(w, n = 5) {
  const raws = [];
  for (let i = 0; i < n; i++) {
    raws.push(await RawItem.create({
      name: `Material ${String.fromCharCode(65 + i)} ${++seq}`, sku: `M-${seq}`, unit: "pcs", quantity: 100, minStock: 0,
    }));
  }
  const res = await call(w.requester, "mrf", "/", {
    method: "POST", idempotencyKey: newKey(),
    body: {
      requestType: "USES_BASED", priority: "NORMAL", reason: "for production",
      items: raws.map((r) => ({ rawItemId: String(r._id), requestedQty: 10, unit: "pcs" })),
    },
  });
  expect(res.status).toBe(201);
  const id = res.body.mrf._id;
  const lines = res.body.mrf.items.map((l) => String(l._id));
  return { id, lines, raws };
}

const decide = (w, id, decisions, key = newKey()) =>
  call(w.tl, "mrf", `/${id}/item-decisions`, { method: "PATCH", body: { decisions }, idempotencyKey: key });

/* ═══ THE HEADLINE CASE ══════════════════════════════════════════════════ */

test("5 items, 3 approved and 2 rejected: only the 3 reach the Store", async () => {
  const w = await world();
  const { id, lines: [a, b, c, d, e] } = await raise(w, 5);

  const res = await decide(w, id, [
    { itemId: a, decision: "APPROVED" },
    { itemId: b, decision: "APPROVED" },
    { itemId: c, decision: "REJECTED", reason: "Not needed for this order" },
    { itemId: d, decision: "APPROVED" },
    { itemId: e, decision: "REJECTED", reason: "Already in the line stock" },
  ]);
  expect(res.status).toBe(200);
  expect(res.body.mrf.approvalStatus).toBe("PARTIALLY_APPROVED");

  /* Stored line by line. */
  const doc = await MRF.findById(id).lean();
  expect(doc.status).toBe("APPROVED");
  expect(doc.tlApproved).toBe(true);
  expect(doc.approvalStatus).toBe("PARTIALLY_APPROVED");
  expect(doc.items.map((l) => l.itemStatus)).toEqual(["APPROVED", "APPROVED", "REJECTED", "APPROVED", "REJECTED"]);
  const rejected = doc.items[2].approval;
  expect(rejected.decision).toBe("REJECTED");
  expect(rejected.reason).toBe("Not needed for this order");
  expect(rejected.rejectedQty).toBe(10);
  expect(String(rejected.decidedBy)).toBe(String(w.tl.emp._id));
  expect(rejected.decidedByName).toMatch(/Rakesh/);
  expect(rejected.decidedAt).toBeTruthy();
  expect(doc.statusHistory.filter((h) => h.action === "ITEM_APPROVED")).toHaveLength(3);
  expect(doc.statusHistory.filter((h) => h.action === "ITEM_REJECTED")).toHaveLength(2);
  expect(await SpActionHistory.countDocuments({ entityId: id, action: "TL_ITEM_DECISIONS" })).toBe(1);

  /* The Store sees three lines, and is told two were rejected — not shown them. */
  const sc = await call(w.store, "store", `/${id}/stock-check`);
  expect(sc.status).toBe(200);
  expect(sc.body.mrf.items.map((l) => String(l._id))).toEqual([a, b, d]);
  expect(sc.body.itemsWithStock.map((l) => String(l._id))).toEqual([a, b, d]);
  expect(sc.body.mrf.heldByManager).toEqual({ awaiting: 0, rejected: 2 });

  const list = await call(w.store, "store", "/?limit=50");
  const row = list.body.mrfs.find((m) => String(m._id) === id);
  expect(row.items).toHaveLength(3);

  /* The requester still sees every line, each with its own outcome. */
  const mine = await call(w.requester, "mrf", "/?limit=50");
  const own = mine.body.mrfs.find((m) => String(m._id) === id);
  expect(own.items.map((l) => l.approval.decision)).toEqual(["APPROVED", "APPROVED", "REJECTED", "APPROVED", "REJECTED"]);
  expect(own.items[4].approval.reason).toBe("Already in the line stock");
  expect(mine.body.stats.partiallyApproved).toBe(1);
  expect(mine.body.stats.pending).toBe(0);

  /* Rejected lines cannot be issued. */
  const issue = await call(w.store, "store", `/${id}/issue`, {
    method: "POST", idempotencyKey: newKey(), body: { items: [{ itemId: c, issuedQty: 1 }] },
  });
  expect(issue.status).toBe(400);
  expect(issue.body.message).toMatch(/rejected/);
});

/* ═══ APPROVED LINES DO NOT WAIT FOR THE REST ════════════════════════════ */

test("approving 2 of 4 hands them over at once; the other 2 stay in the manager's queue", async () => {
  const w = await world();
  const { id, lines: [a, b, c, d] } = await raise(w, 4);

  const first = await decide(w, id, [{ itemId: a, decision: "APPROVED" }, { itemId: b, decision: "APPROVED" }]);
  expect(first.status).toBe(200);
  let doc = await MRF.findById(id).lean();
  expect(doc.status).toBe("APPROVED");
  expect(doc.approvalStatus).toBe("PARTIALLY_PROCESSED");
  expect(doc.items[2].itemStatus).toBe("PENDING");
  expect(doc.items[2].approval.decision).toBe("PENDING");

  /* Still in the manager's Awaiting queue, and counted there. */
  const queue = await call(w.tl, "mrf", "/approvals?status=PENDING&limit=50");
  expect(queue.status).toBe(200);
  expect(queue.body.mrfs.map((m) => String(m._id))).toContain(id);
  expect(queue.body.stats.pending).toBe(1);
  const row = queue.body.mrfs.find((m) => String(m._id) === id);
  expect(row.approvalCounts).toMatchObject({ awaiting: 2, approved: 2 });

  /* The Store has exactly the two approved lines. */
  const sc = await call(w.store, "store", `/${id}/stock-check`);
  expect(sc.body.mrf.items.map((l) => String(l._id))).toEqual([a, b]);
  expect(sc.body.mrf.heldByManager).toEqual({ awaiting: 2, rejected: 0 });

  /* …and cannot touch the other two. */
  const issue = await call(w.store, "store", `/${id}/issue`, {
    method: "POST", idempotencyKey: newKey(), body: { items: [{ itemId: c, issuedQty: 1 }] },
  });
  expect(issue.status).toBe(400);
  expect(issue.body.message).toMatch(/still waiting/);
  const avail = await call(w.store, "store", `/${id}/items/${c}/availability`);
  expect(avail.status).toBe(400);
  expect(avail.body.code).toBe("AWAITING_APPROVAL");

  /* Approved later — they reach the Store too, and the queue empties. */
  const second = await decide(w, id, [{ itemId: c, decision: "APPROVED" }, { itemId: d, decision: "APPROVED" }]);
  expect(second.status).toBe(200);
  doc = await MRF.findById(id).lean();
  expect(doc.approvalStatus).toBe("APPROVED");
  expect((await call(w.store, "store", `/${id}/stock-check`)).body.mrf.items).toHaveLength(4);
  const after = await call(w.tl, "mrf", "/approvals?status=PENDING&limit=50");
  expect(after.body.mrfs.map((m) => String(m._id))).not.toContain(id);
  const approved = await call(w.tl, "mrf", "/approvals?status=APPROVED&limit=50");
  expect(approved.body.mrfs.map((m) => String(m._id))).toContain(id);
});

test("a request with nothing approved yet is not with the Store at all", async () => {
  const w = await world();
  const { id, lines: [a] } = await raise(w, 3);
  await decide(w, id, [{ itemId: a, decision: "REJECTED", reason: "No" }]);
  const doc = await MRF.findById(id).lean();
  expect(doc.status).toBe("PENDING");
  expect(doc.tlApproved).toBe(false);
  expect(doc.approvalStatus).toBe("PARTIALLY_PROCESSED");
  const sc = await call(w.store, "store", `/${id}/stock-check`);
  expect(sc.body.mrf.items).toHaveLength(0);
  expect(sc.body.storeActionable).toBe(false);
});

test("every line rejected closes the request as REJECTED", async () => {
  const w = await world();
  const { id, lines } = await raise(w, 2);
  const res = await decide(w, id, lines.map((itemId) => ({ itemId, decision: "REJECTED", reason: "Over budget" })));
  expect(res.status).toBe(200);
  const doc = await MRF.findById(id).lean();
  expect(doc.status).toBe("REJECTED");
  expect(doc.tlRejected).toBe(true);
  expect(doc.approvalStatus).toBe("REJECTED");
  expect(doc.tlRejectionNote).toBe("Over budget");
  const rej = await call(w.tl, "mrf", "/approvals?status=REJECTED&limit=50");
  expect(rej.body.mrfs.map((m) => String(m._id))).toContain(id);
});

/* ═══ A REDUCED QUANTITY ═════════════════════════════════════════════════ */

test("approving less than asked: the Store owes the approved quantity, the asked one is kept", async () => {
  const w = await world();
  const { id, lines: [a] } = await raise(w, 1);
  const res = await decide(w, id, [{ itemId: a, decision: "APPROVED", approvedQty: 6, reason: "Six covers this week" }]);
  expect(res.status).toBe(200);
  const doc = await MRF.findById(id).lean();
  expect(doc.items[0].requestedQty).toBe(6);
  expect(doc.items[0].approval).toMatchObject({ requestedQty: 10, approvedQty: 6, rejectedQty: 4 });
  expect(doc.approvalStatus).toBe("PARTIALLY_APPROVED");

  const tooMuch = await call(w.store, "store", `/${id}/issue`, {
    method: "POST", idempotencyKey: newKey(), body: { items: [{ itemId: a, issuedQty: 8 }] },
  });
  expect(tooMuch.status).toBe(400);
  expect(tooMuch.body.message).toMatch(/only 6 pcs is still owed/);
});

/* ═══ REFUSALS ═══════════════════════════════════════════════════════════ */

test("a rejection needs a reason, a reduction needs a reason, and quantity is bounded", async () => {
  const w = await world();
  const { id, lines: [a] } = await raise(w, 1);
  for (const d of [
    { itemId: a, decision: "REJECTED" },
    { itemId: a, decision: "APPROVED", approvedQty: 4 },
    { itemId: a, decision: "APPROVED", approvedQty: 11, reason: "x" },
    { itemId: a, decision: "APPROVED", approvedQty: 0, reason: "x" },
  ]) {
    const r = await decide(w, id, [d]);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION");
    expect(r.body.error.details.itemId).toBe(a);
  }
  expect((await MRF.findById(id).lean()).status).toBe("PENDING");
});

test("a decided line cannot be decided again; a replay of the same submission is not a second one", async () => {
  const w = await world();
  const { id, lines: [a, b] } = await raise(w, 2);
  const key = newKey();
  const first = await decide(w, id, [{ itemId: a, decision: "APPROVED" }], key);
  const replay = await decide(w, id, [{ itemId: a, decision: "APPROVED" }], key);
  expect(first.status).toBe(200);
  expect(replay.replayed).toBe(true);

  const again = await decide(w, id, [{ itemId: a, decision: "REJECTED", reason: "changed my mind" }]);
  expect(again.status).toBe(409);
  expect(again.body.message).toMatch(/already approved/);

  const doc = await MRF.findById(id).lean();
  expect(doc.statusHistory.filter((h) => h.action === "ITEM_APPROVED")).toHaveLength(1);
  expect(doc.items[0].approval.decision).toBe("APPROVED");
  expect(doc.items[1].approval.decision).toBe("PENDING");
  expect(b).toBeTruthy();
});

test("only the assigned approver decides — not a colleague, not the requester", async () => {
  const w = await world();
  const { id, lines: [a] } = await raise(w, 1);
  const stranger = await call(w.stranger, "mrf", `/${id}/item-decisions`, {
    method: "PATCH", idempotencyKey: newKey(), body: { decisions: [{ itemId: a, decision: "APPROVED" }] },
  });
  expect([403, 404]).toContain(stranger.status);
  const self = await call(w.requester, "mrf", `/${id}/item-decisions`, {
    method: "PATCH", idempotencyKey: newKey(), body: { decisions: [{ itemId: a, decision: "APPROVED" }] },
  });
  expect(self.status).toBe(403);
  expect((await MRF.findById(id).lean()).items[0].itemStatus).toBe("PENDING");
});

/* ═══ APPROVE ALL / REJECT ALL STILL WORK ════════════════════════════════ */

test("Approve all (an empty body, as the CMS app sends) approves every line", async () => {
  const w = await world();
  const { id } = await raise(w, 3);
  const r = await call(w.tl, "mrf", `/${id}/tl-approve`, { method: "PATCH", body: {}, idempotencyKey: newKey() });
  expect(r.status).toBe(200);
  const doc = await MRF.findById(id).lean();
  expect(doc.status).toBe("APPROVED");
  expect(doc.approvalStatus).toBe("APPROVED");
  expect(doc.items.every((l) => l.approval.decision === "APPROVED")).toBe(true);
  expect(await SpActionHistory.countDocuments({ entityId: id, action: "TL_APPROVED" })).toBe(1);
});

test("Reject all after a partial approval rejects only what was still waiting", async () => {
  const w = await world();
  const { id, lines: [a] } = await raise(w, 3);
  await decide(w, id, [{ itemId: a, decision: "APPROVED" }]);
  const r = await call(w.tl, "mrf", `/${id}/tl-reject`, {
    method: "PATCH", body: { note: "The rest can wait for next month" }, idempotencyKey: newKey(),
  });
  expect(r.status).toBe(200);
  const doc = await MRF.findById(id).lean();
  expect(doc.status).toBe("APPROVED");          // the approved line is still the Store's
  expect(doc.approvalStatus).toBe("PARTIALLY_APPROVED");
  expect(doc.items.map((l) => l.itemStatus)).toEqual(["APPROVED", "REJECTED", "REJECTED"]);
  expect(doc.items[1].approval.reason).toBe("The rest can wait for next month");
  const twice = await call(w.tl, "mrf", `/${id}/tl-reject`, {
    method: "PATCH", body: { note: "again" }, idempotencyKey: newKey(),
  });
  expect(twice.status).toBe(409);
});

/* ═══ THE STORE CANNOT CLOSE WHAT IT WAS NEVER GIVEN ═════════════════════ */

test("marking a request unfulfilled leaves the lines still with the manager open", async () => {
  const w = await world();
  const { id, lines: [a, b] } = await raise(w, 2);
  await decide(w, id, [{ itemId: a, decision: "APPROVED" }]);
  const un = await call(w.store, "store", `/${id}/unfulfilled`, {
    method: "POST", idempotencyKey: newKey(), body: { reason: "Supplier discontinued it" },
  });
  expect(un.status).toBe(200);
  let doc = await MRF.findById(id).lean();
  expect(doc.items[0].itemStatus).toBe("UNFULFILLED");
  expect(doc.items[1].itemStatus).toBe("PENDING");
  expect(doc.status).toBe("APPROVED");      // still open: a line is still with the manager

  await decide(w, id, [{ itemId: b, decision: "REJECTED", reason: "Not needed now" }]);
  doc = await MRF.findById(id).lean();
  expect(doc.status).toBe("UNFULFILLED");
});

test("GET /:id answers the approver with what is still theirs to decide", async () => {
  const w = await world();
  const { id, lines: [a] } = await raise(w, 2);
  await decide(w, id, [{ itemId: a, decision: "APPROVED" }]);
  const r = await call(w.tl, "mrf", `/${id}`);
  expect(r.status).toBe(200);
  expect(r.body.canApprove).toBe(true);
  expect(r.body.mrf.approvalCounts).toMatchObject({ awaiting: 1, approved: 1 });
  const mine = await call(w.requester, "mrf", `/${id}`);
  expect(mine.status).toBe(200);
  expect(mine.body.canApprove).toBe(false);
});

/* ═══ NUMBERING: A COUNTER BEHIND THE REQUESTS REPAIRS ITSELF ═════════════ */

test("a numbering counter that fell behind existing requests does not fail the next request", async () => {
  /* 9 Oct 2026: a copied database had requests up to MRF/…/0010 and a counter
     at 8, so every new request died on "E11000 duplicate key … mrfNumber". */
  const w = await world();
  await raise(w, 1);
  await raise(w, 1);
  const key = { companyId: w.co._id, documentType: "MATERIAL_REQUEST" };
  await SpDocumentSequence.updateOne(key, { $set: { next: 0 } });   // wound back, as the copy had it

  const third = await raise(w, 1);
  const doc = await MRF.findById(third.id).lean();
  expect(doc.mrfNumber).toMatch(/\/0003$/);
  expect((await SpDocumentSequence.findOne(key).lean()).next).toBe(3);
  expect(new Set((await MRF.find({}).lean()).map((m) => m.mrfNumber)).size).toBe(3);
});

test("the Store issues an approved line while its sibling still waits on the manager", async () => {
  /* Confirm Issue answered 500 "req is not defined" on every issue (the stock
     helper read `req` it was never given) — this is the Store's half of
     item-wise approval actually working end to end. */
  const w = await world();
  const { id, lines: [a, b], raws } = await raise(w, 2);
  await decide(w, id, [{ itemId: a, decision: "APPROVED" }]);

  const issue = await call(w.store, "store", `/${id}/issue`, {
    method: "POST", idempotencyKey: newKey(), body: { items: [{ itemId: a, issuedQty: 4 }] },
  });
  expect(issue.status).toBe(200);
  const doc = await MRF.findById(id).lean();
  expect(doc.items[0].issuedQty).toBe(4);
  expect(doc.items[1].itemStatus).toBe("PENDING");
  expect((await RawItem.findById(raws[0]._id).lean()).quantity).toBe(96);
  expect((await RawItem.findById(raws[1]._id).lean()).quantity).toBe(100);
  expect(b).toBeTruthy();
});
