// test/requests/approval-chain.route.test.js
//
// SOUMYA → PRAMOD → RAKESH → STORE.
//
// ── THE CLAIM ───────────────────────────────────────────────────────────────
// A request walks UP the reporting line and stops at the edge of the
// requester's own department. Rakesh runs IT and reports to a CEO who is not
// in IT, so Rakesh is the top of the chain — and his OWN request has nobody
// above him inside the department and goes straight to Store.
//
// ── WHY THIS EXISTS ALONGSIDE THE UNIT TESTS ────────────────────────────────
// `approvalChain.test.js` proves the RULE — every stop condition, as
// arithmetic, with no database. This proves the WIRING: that the chain is
// frozen onto the request when it is raised, that approving advances it one
// step and not two, that the queue moves with it, and that Store only ever
// sees it after the last approver has agreed. Those are different failures and
// the second kind is silent.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({
  admin: {}, db: {}, auth: {}, messaging: {}, rtdb: {},
}));
jest.mock("../../services/mrfNotify.service", () => {
  const noop = () => Promise.resolve();
  return {
    submitted: noop, autoForwarded: noop, cancelled: noop, chatMessage: noop,
    tlApproved: noop, tlRejected: noop, issued: noop, unfulfilled: noop,
    productRequestChatMessage: noop, productRequestTlApproved: noop,
    productRequestTlRejected: noop,
  };
});
jest.mock("../../services/mrfChat.service", () => ({
  systemMessage: () => Promise.resolve(null),
  postMessage: () => Promise.resolve(null),
  listMessages: () => Promise.resolve([]),
  markRead: () => Promise.resolve({ unread: 0 }),
  describeSubject: () => ({ label: "" }),
}));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { planEveryItem, PLANNED_KEY } = require("./plannedItems.helper");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const IntakeRequest = require("../../models/CMS_Models/Requests/IntakeRequest");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const Employee = require("../../models/Employee");
const AccessDepartment = require("../../models/Access/AccessDepartment");

let server, base, root, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/requests/intake",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Requests/intakeRequests"),
  );
  /* Mounted so "finance sees nothing until the requester confirms" can be
     asserted against the real confirmation door rather than by writing the
     status straight onto the document. */
  app.use(
    "/api/requests/spend",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Requests/spendRequests"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  root = `http://127.0.0.1:${server.address().port}/api/requests`;
  base = `${root}/intake`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (emp, path, { method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt.sign(
        { id: String(emp._id), role: "employee", employeeId: emp.biometricId,
          name: `${emp.firstName} ${emp.lastName}`, email: emp.email },
        process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
      )}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

/**
 * The brief's own example, plus the people who must NOT be in the chain.
 *
 *   Soumya (IT) → Pramod (IT) → Rakesh (IT) → Ceo (Executive)
 *   Anita (IT)  → Rakesh                      — a two-step chain
 *   Bhakti (Sales) → SalesLead (Sales)        — another department entirely
 *
 * IT has one approved head; Sales has its own, so "the picker is the
 * requester's department" has something to be wrong about.
 */
async function seed() {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `Chain Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const group = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const mk = (name) =>
    Acc_Ledger.create({
      companyId: company._id, name: `${name} ${n}`,
      groupId: group._id, groupName: group.name, nature: "expense",
    });
  const software = await mk("Software Subscription");
  const salesHead = await mk("Client Entertainment");

  await planEveryItem(await Acc_Budget.create({
    name: `Budget FY 2026-27 (${n})`, financialYear: "2026-27", period: "yearly",
    status: "active", startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [
      { ledgerId: software._id, ledgerName: software.name, nature: "expense",
        department: "IT", allocatedAmount: 200000 },
      { ledgerId: salesHead._id, ledgerName: salesHead.name, nature: "expense",
        department: "Sales", allocatedAmount: 50000 },
    ],
  }));

  const person = (o) => Employee.create({ isActive: true, gender: "Other", ...o });

  const ceo = await person({
    firstName: "Ceo", lastName: `X${n}`, email: `ceo${n}@demo.example`,
    biometricId: `CEO${n}`, department: "Executive",
  });
  const rakesh = await person({
    firstName: "Rakesh", lastName: `R${n}`, email: `rakesh${n}@demo.example`,
    biometricId: `RK${n}`, department: "IT", designation: "Head of IT",
    primaryManager: { managerId: ceo._id },
  });
  const pramod = await person({
    firstName: "Pramod", lastName: `P${n}`, email: `pramod${n}@demo.example`,
    biometricId: `PR${n}`, department: "IT",
    primaryManager: { managerId: rakesh._id },
  });
  const soumya = await person({
    firstName: "Soumya", lastName: `S${n}`, email: `soumya${n}@demo.example`,
    biometricId: `SO${n}`, department: "IT",
    primaryManager: { managerId: pramod._id },
  });
  const anita = await person({
    firstName: "Anita", lastName: `A${n}`, email: `anita${n}@demo.example`,
    biometricId: `AN${n}`, department: "IT",
    primaryManager: { managerId: rakesh._id },
  });
  const salesLead = await person({
    firstName: "Lead", lastName: `L${n}`, email: `slead${n}@demo.example`,
    biometricId: `SL${n}`, department: "Sales",
  });
  const bhakti = await person({
    firstName: "Bhakti", lastName: `B${n}`, email: `bhakti${n}@demo.example`,
    biometricId: `BH${n}`, department: "Sales",
    primaryManager: { managerId: salesLead._id },
  });

  const storeDept =
    (await AccessDepartment.findOne({ slug: "store" })) ||
    (await AccessDepartment.create({
      key: "store", slug: "store", name: "Store & Purchase",
      dashboardPath: "/store", isActive: true,
    }));
  const store = await person({
    firstName: "Bikash", lastName: `K${n}`, email: `store${n}@demo.example`,
    biometricId: `ST${n}`, department: "Store", accessDepartmentId: storeDept._id,
  });

  const fin = await person({
    firstName: "Finance", lastName: `F${n}`, email: `fin${n}@demo.example`,
    biometricId: `FN${n}`, department: "Accounts",
  });
  await Acc_User.create({
    organizationId: new mongoose.Types.ObjectId(), email: `fin${n}@demo.example`,
    name: "Finance", role: "approver", isActive: true, passwordHash: "x",
  });

  return { company, software, salesHead, ceo, rakesh, pramod, soumya, anita,
           salesLead, bhakti, store, fin };
}

const ask = (s, over = {}) => ({
  title: "Design tool licences",
  purpose: "The team's licences expire at the end of the month",
  ledgerId: String(s.software._id),
  plannedItemKey: PLANNED_KEY,
  items: [{ name: "Licence", quantity: 5, unit: "user", rate: 6000 }],
  ...over,
});

const raise = async (s, who, over = {}) => {
  const r = await call(who, "/", { method: "POST", body: ask(s, over) });
  expect(r.status).toBe(201);
  return r.body.request.id;
};

/* ═══ 1 · THE CHAIN THAT GETS BUILT ═══════════════════════════════════════ */

describe("the chain a request is frozen with", () => {
  test("Soumya's request is Pramod then Rakesh, and never the CEO", async () => {
    const s = await seed();
    const id = await raise(s, s.soumya);

    const doc = await IntakeRequest.findById(id).lean();
    expect(doc.approvalChain.map((c) => c.name)).toEqual([
      expect.stringContaining("Pramod"),
      expect.stringContaining("Rakesh"),
    ]);
    /* The CEO is Rakesh's manager and is not in IT. The chain stops at the
       department's edge — which is the whole rule. */
    expect(doc.chainStop).toBe("top_of_department");
    expect(JSON.stringify(doc.approvalChain)).not.toContain("Ceo");
    expect(doc.status).toBe("pending_tl");
    expect(doc.currentApproverIndex).toBe(0);
    /* Every step starts pending — absent is not a state. */
    expect(doc.approvalChain.every((c) => c.status === "pending")).toBe(true);
  });

  test("the stored approver names whoever it is waiting for right now", async () => {
    /* Which is what lets the queue, the notifications and every legacy reader
       work unchanged against a multi-step request. */
    const s = await seed();
    const id = await raise(s, s.soumya);
    const doc = await IntakeRequest.findById(id).lean();
    expect(doc.approverBiometricId).toBe(s.pramod.biometricId);
    expect(doc.approverName).toMatch(/Pramod/);
  });

  test("a one-step chain is built where there is one senior", async () => {
    const s = await seed();
    const id = await raise(s, s.anita);
    const doc = await IntakeRequest.findById(id).lean();
    expect(doc.approvalChain.map((c) => c.name)).toEqual([expect.stringContaining("Rakesh")]);
  });

  test("the most senior person in a department skips approval entirely", async () => {
    /* Rakesh reports to a CEO outside IT, so nobody in IT is above him. His
       own request goes straight to Store — and says so rather than looking
       like something nobody has looked at. */
    const s = await seed();
    const id = await raise(s, s.rakesh);
    const doc = await IntakeRequest.findById(id).lean();

    expect(doc.approvalChain).toEqual([]);
    expect(doc.status).toBe("needs_classification");
    expect(doc.chainStop).toBe("outside_department");
    expect(doc.approverResolutionNote).toMatch(/most senior person in your department/i);
  });

  test("a manager in another department is never in the chain", async () => {
    const s = await seed();
    const id = await raise(s, s.bhakti, { ledgerId: String(s.salesHead._id) });
    const doc = await IntakeRequest.findById(id).lean();
    expect(doc.approvalChain.map((c) => c.name)).toEqual([expect.stringContaining("Lead")]);
    expect(JSON.stringify(doc.approvalChain)).not.toContain("Rakesh");
  });
});

/* ═══ 2 · THE HEAD IS PART OF THE ASK ═════════════════════════════════════ */

describe("the budget head, chosen by the requester", () => {
  test("the picker offers only their own department's approved heads", async () => {
    const s = await seed();
    const { body } = await call(s.soumya, "/budget-heads");
    expect(body.department).toBe("IT");
    expect(body.heads.map((h) => h.ledgerId)).toEqual([String(s.software._id)]);
  });

  test("and Sales gets Sales' head, not IT's", async () => {
    const s = await seed();
    const { body } = await call(s.bhakti, "/budget-heads");
    expect(body.heads.map((h) => h.ledgerId)).toEqual([String(s.salesHead._id)]);
  });

  test("raising without a head is refused", async () => {
    const s = await seed();
    const no = await call(s.soumya, "/", { method: "POST", body: ask(s, { ledgerId: undefined }) });
    expect(no.status).toBe(400);
    expect(no.body.message).toMatch(/budget head/i);
  });

  test("another department's approved head is refused", async () => {
    /* A real, approved, live head — just not IT's. The commonest thing a
       spoofed payload would carry. */
    const s = await seed();
    const no = await call(s.soumya, "/", {
      method: "POST", body: ask(s, { ledgerId: String(s.salesHead._id) }),
    });
    expect(no.status).toBe(400);
    expect(no.body.message).toMatch(/not in this department's approved budget/i);
  });

  test("an arbitrary id is refused", async () => {
    const s = await seed();
    const no = await call(s.soumya, "/", {
      method: "POST", body: ask(s, { ledgerId: String(new mongoose.Types.ObjectId()) }),
    });
    expect(no.status).toBe(400);
  });
});

/* ═══ 3 · WALKING THE CHAIN ═══════════════════════════════════════════════ */

describe("approving, one step at a time", () => {
  test("Pramod approves and it moves to Rakesh, not to Store", async () => {
    const s = await seed();
    const id = await raise(s, s.soumya);

    const ok = await call(s.pramod, `/${id}/approve`, { method: "PATCH", body: {} });
    expect(ok.status).toBe(200);

    const doc = await IntakeRequest.findById(id).lean();
    expect(doc.approvalChain[0].status).toBe("approved");
    expect(doc.approvalChain[0].approvedAt).toBeTruthy();
    expect(doc.currentApproverIndex).toBe(1);
    /* Still with the department. Store must not see it yet. */
    expect(doc.status).toBe("pending_tl");
    expect(doc.approverBiometricId).toBe(s.rakesh.biometricId);
    expect(doc.tlApprovedAt).toBeFalsy();
  });

  test("Rakesh then approves and it goes to Store", async () => {
    const s = await seed();
    const id = await raise(s, s.soumya);
    await call(s.pramod, `/${id}/approve`, { method: "PATCH", body: {} });

    const ok = await call(s.rakesh, `/${id}/approve`, { method: "PATCH", body: {} });
    expect(ok.status).toBe(200);

    const doc = await IntakeRequest.findById(id).lean();
    expect(doc.approvalChain.every((c) => c.status === "approved")).toBe(true);
    expect(doc.status).toBe("needs_classification");
    /* `tlApproved*` records the LAST department approval — the one that
       released it — which is what MRF and the spend request carry onward. */
    expect(doc.tlApprovedByName).toMatch(/Rakesh/);
  });

  test("Rakesh cannot jump the queue before Pramod has looked", async () => {
    /* Skipping a step the department decided to have would leave the record
       saying Pramod approved nothing while the request sailed past him. */
    const s = await seed();
    const id = await raise(s, s.soumya);

    const no = await call(s.rakesh, `/${id}/approve`, { method: "PATCH", body: {} });
    expect(no.status).toBe(403);
    expect(no.body.message).toMatch(/waiting for .*Pramod/i);

    const doc = await IntakeRequest.findById(id).lean();
    expect(doc.currentApproverIndex).toBe(0);
  });

  test("somebody outside the chain cannot approve", async () => {
    const s = await seed();
    const id = await raise(s, s.soumya);
    expect((await call(s.salesLead, `/${id}/approve`, { method: "PATCH", body: {} })).status).toBe(403);
    expect((await call(s.store, `/${id}/approve`, { method: "PATCH", body: {} })).status).toBe(403);
  });

  test("the requester cannot approve their own, even standing in the chain", async () => {
    const s = await seed();
    /* Pramod raises his own — his chain is just Rakesh, and he is not in it. */
    const id = await raise(s, s.pramod);
    const no = await call(s.pramod, `/${id}/approve`, { method: "PATCH", body: {} });
    expect(no.status).toBe(403);
    expect(no.body.message).toMatch(/your own request/i);
  });

  test("a rejection anywhere stops the chain", async () => {
    /* It goes back to the requester rejected rather than on to whoever is
       next — asking somebody more senior to overturn their own report in the
       same queue is not an escalation path. */
    const s = await seed();
    const id = await raise(s, s.soumya);

    const r = await call(s.pramod, `/${id}/reject`, {
      method: "PATCH", body: { note: "Use the licences we already have" },
    });
    expect(r.status).toBe(200);

    const doc = await IntakeRequest.findById(id).lean();
    expect(doc.status).toBe("rejected");
    expect(doc.approvalChain[0].status).toBe("rejected");
    expect(doc.approvalChain[0].note).toMatch(/already have/);
    /* Rakesh is never asked. */
    expect(doc.approvalChain[1].status).toBe("pending");
    expect((await call(s.rakesh, `/${id}/approve`, { method: "PATCH", body: {} })).status).toBe(403);
  });
});

/* ═══ 4 · THE QUEUE MOVES WITH IT ═════════════════════════════════════════ */

describe("whose queue it sits in", () => {
  test("it starts in Pramod's and not Rakesh's", async () => {
    const s = await seed();
    await raise(s, s.soumya);

    const p = await call(s.pramod, "/approvals");
    expect(p.body.requests).toHaveLength(1);
    expect(p.body.requests[0].approvalStepLabel).toMatch(/Pramod/);

    const r = await call(s.rakesh, "/approvals");
    expect(r.body.requests).toHaveLength(0);
  });

  test("and moves to Rakesh's once Pramod has agreed", async () => {
    const s = await seed();
    const id = await raise(s, s.soumya);
    await call(s.pramod, `/${id}/approve`, { method: "PATCH", body: {} });

    expect((await call(s.pramod, "/approvals")).body.requests).toHaveLength(0);
    const r = await call(s.rakesh, "/approvals");
    expect(r.body.requests).toHaveLength(1);
    /* The last step is named as the last one — an approver should know they
       are the gate that releases it. */
    expect(r.body.requests[0].approvalStepLabel).toMatch(/final approval/);
  });

  test("the rail says who has answered and who has not", async () => {
    const s = await seed();
    const id = await raise(s, s.soumya);
    await call(s.pramod, `/${id}/approve`, { method: "PATCH", body: {} });

    const { body } = await call(s.soumya, "/");
    const row = body.requests.find((r) => r.id === id);
    expect(row.approvalChain.map((c) => [c.name.split(" ")[0], c.status, c.current])).toEqual([
      ["Pramod", "approved", false],
      ["Rakesh", "pending", true],
    ]);
    expect(row.approvalStepCount).toBe(2);
  });
});

/* ═══ 5 · WHAT STORE AND FINANCE SEE ══════════════════════════════════════ */

describe("the handoff", () => {
  test("Store sees nothing until the last approver has agreed", async () => {
    const s = await seed();
    const id = await raise(s, s.soumya);

    const mid = await call(s.store, "/fulfilment");
    expect(mid.body.requests.map((r) => r.id)).not.toContain(id);

    await call(s.pramod, `/${id}/approve`, { method: "PATCH", body: {} });
    const stillMid = await call(s.store, "/fulfilment");
    expect(stillMid.body.requests.map((r) => r.id)).not.toContain(id);

    await call(s.rakesh, `/${id}/approve`, { method: "PATCH", body: {} });
    const after = await call(s.store, "/fulfilment");
    const row = after.body.requests.find((r) => r.id === id);
    expect(row).toBeTruthy();
    /* With the head the requester chose, carried untouched. */
    expect(row.budgetHead.ledgerId).toBe(String(s.software._id));
  });

  test("the most senior person's own request reaches Store immediately", async () => {
    const s = await seed();
    const id = await raise(s, s.rakesh);
    const { body } = await call(s.store, "/fulfilment");
    expect(body.requests.map((r) => r.id)).toContain(id);
  });

  test("finance sees nothing until Store prices it AND the requester confirms it", async () => {
    const s = await seed();
    const id = await raise(s, s.soumya);
    await call(s.pramod, `/${id}/approve`, { method: "PATCH", body: {} });
    await call(s.rakesh, `/${id}/approve`, { method: "PATCH", body: {} });

    /* With Store, and nowhere near finance. */
    expect((await call(s.fin, "/approvals")).body.requests).toHaveLength(0);
    expect(await SpendRequest.countDocuments({})).toBe(0);

    await call(s.store, `/${id}/classify`, { method: "PATCH", body: { kind: "purchase" } });

    /* ── AND STILL NOT FINANCE ─────────────────────────────────────────
       This half is new. Pricing it used to be enough; it is not. Store may
       have sourced the wrong model from the wrong vendor, and finance reads
       a figure against a head — they are not equipped to catch that. So it
       sits with the person who asked until they say it is the right thing. */
    const spend = await SpendRequest.findOne({});
    expect(spend.status).toBe("awaiting_requester_confirmation");
    expect((await call(s.fin, "/approvals")).body.requests
      .filter((r) => r.source === "spend")).toHaveLength(0);

    const confirmed = await fetch(`${root}/spend/${spend._id}/confirm`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt.sign(
          { id: String(s.soumya._id), role: "employee", employeeId: s.soumya.biometricId,
            name: "Soumya", email: s.soumya.email },
          process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
        )}`,
      },
      body: JSON.stringify({
        lines: Object.fromEntries(spend.items.map((l, i) => [i, { confirm: true }])),
      }),
    }).then(async (r) => JSON.parse((await r.text()) || "null"));
    expect(confirmed.success).toBe(true);

    /* Confirmed and within budget — with Store to send on, and STILL not on
       finance's desk until Store does. */
    const afterConfirm = await SpendRequest.findById(spend._id).lean();
    expect(afterConfirm.status).toBe("requester_confirmed");

    const sent = await fetch(`${root}/spend/${spend._id}/send-to-finance`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt.sign(
          { id: String(s.store._id), role: "employee", employeeId: s.store.biometricId,
            name: "Store", email: s.store.email },
          process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
        )}`,
      },
      body: JSON.stringify({}),
    }).then(async (r) => JSON.parse((await r.text()) || "null"));
    expect(sent.success).toBe(true);

    const fin = await call(s.fin, "/approvals");
    expect(fin.body.requests.filter((r) => r.source === "spend")).toHaveLength(1);
  });
});

/* ═══ 6 · ROWS FROM BEFORE THE CHAIN ══════════════════════════════════════ */

describe("requests raised before the chain existed", () => {
  test("a single stored approver still works", async () => {
    /* Written the way the old router wrote them: one approver, no chain.
       Nothing was migrated, so the shape of the row decides which rule reads
       it — see requestIntake.decisionFor. */
    const s = await seed();
    const doc = await IntakeRequest.create({
      title: "Old ask", purpose: "Because", requestType: "PRODUCT",
      requestedBy: s.soumya._id, requestedByName: "Soumya",
      requestedById: s.soumya.biometricId, department: "IT",
      status: "pending_tl",
      approverEmployee: s.pramod._id, approverName: "Pramod",
      approverBiometricId: s.pramod.biometricId, approverAltIds: [s.pramod.biometricId],
      items: [{ name: "Blade", quantity: 2, unit: "pcs" }],
      ledgerId: s.software._id, ledgerName: "Software Subscription",
      plannedItemKey: PLANNED_KEY,
    });

    /* It is in the stored approver's queue... */
    const q = await call(s.pramod, "/approvals");
    expect(q.body.requests.map((r) => r.id)).toContain(String(doc._id));
    /* ...and nobody else's. */
    expect((await call(s.rakesh, "/approvals")).body.requests).toHaveLength(0);

    /* And one approval releases it, because that is the whole chain it has. */
    const ok = await call(s.pramod, `/${doc._id}/approve`, { method: "PATCH", body: {} });
    expect(ok.status).toBe(200);
    expect((await IntakeRequest.findById(doc._id).lean()).status).toBe("needs_classification");
  });

  test("an old row with no head at all is refused at approval", async () => {
    const s = await seed();
    const doc = await IntakeRequest.create({
      title: "Old headless", purpose: "Because", requestType: "PRODUCT",
      requestedBy: s.soumya._id, requestedByName: "Soumya",
      requestedById: s.soumya.biometricId, department: "IT",
      status: "pending_tl",
      approverEmployee: s.pramod._id, approverName: "Pramod",
      approverBiometricId: s.pramod.biometricId, approverAltIds: [s.pramod.biometricId],
      items: [{ name: "Blade", quantity: 2, unit: "pcs" }],
    });
    const no = await call(s.pramod, `/${doc._id}/approve`, { method: "PATCH", body: {} });
    expect(no.status).toBe(400);
    expect(no.body.message).toMatch(/budget head/i);
  });
});
