// test/requests/store-fulfilment.route.test.js
//
// CAN WE GIVE THEM THIS, OR DO WE HAVE TO BUY IT?
//
// ── THE CLAIM ───────────────────────────────────────────────────────────────
// A department's request reaches finance because MONEY HAS TO BE SPENT — not
// because the request exists. Between the TL agreeing the department needs the
// thing and finance agreeing to pay for it, Store looks at the shelf and
// answers one question three ways. Only two of the three cost anything.
//
// ── WHY THIS NEEDS ITS OWN SUITE ────────────────────────────────────────────
// The interesting assertions are all NEGATIVE, and they are about money that
// should not move: a request filled from stock must create no spend request,
// no budget commitment and no finance step; a partial must send only the
// shortfall; and finance must not be able to approve something nobody has
// costed. Every one of those failures is silent — the request goes through and
// a budget report is wrong months later.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

/* The store door reaches Firebase for push and chat; see
   tl-routing.route.test.js for why these are stubbed rather than configured. */
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
const Commitment = require("../../models/Accountant_model/Acc_BudgetCommitment");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Employee = require("../../models/Employee");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  /* The store's own door. `mrfRoutes` applies EmployeeAuth itself. */
  app.use("/api/cms/inventory/mrf", require("../../routes/CMS_Routes/Inventory/Operations/mrfRoutes"));
  app.use(
    "/api/requests/spend",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Requests/spendRequests"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (emp, path, { method = "GET", body, app = "mrf" } = {}) => {
  const url = app === "mrf" ? `${base}/cms/inventory/mrf${path}` : `${base}/requests/spend${path}`;
  return fetch(url, {
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
};

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

/**
 * One approved budget head, one catalogue item with stock, and a TL-approved
 * material request against it — the state Store actually opens.
 *
 * `stockQty` is what the shelf holds; `requestedQty` is what was asked for.
 * Varying the two is how each path here is set up.
 */
async function seed({ stockQty = 50, requestedQty = 10, withHead = true } = {}) {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `Fulfilment Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const group = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const consumables = await Acc_Ledger.create({
    companyId: company._id, name: `Consumables ${n}`,
    groupId: group._id, groupName: group.name, nature: "expense",
  });
  const budget = await Acc_Budget.create({
    name: `Budget FY 2026-27 (${n})`, financialYear: "2026-27", period: "yearly",
    status: "active", startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [{ ledgerId: consumables._id, ledgerName: consumables.name, nature: "expense",
              department: "Tech", allocatedAmount: 100000 }],
  });
  /* Give every head its approved plan — a request now names a
     planned item, not just a head. See plannedItems.helper. */
  await planEveryItem(budget);

  const person = (o) => Employee.create({ isActive: true, gender: "Other", department: "Tech", ...o });
  const tl = await person({ firstName: "Meera", lastName: `L${n}`, email: `tl${n}@demo.example`, biometricId: `TL${n}` });
  const emp = await person({
    firstName: "Rutu", lastName: `T${n}`, email: `tech${n}@demo.example`, biometricId: `TC${n}`,
    primaryManager: { managerId: tl._id },
  });
  const store = await person({
    firstName: "Bikash", lastName: `S${n}`, email: `store${n}@demo.example`,
    biometricId: `ST${n}`, department: "Store",
  });
  const fin = await person({
    firstName: "Soumya", lastName: `F${n}`, email: `fin${n}@demo.example`,
    biometricId: `FN${n}`, department: "Accounts",
  });
  await Acc_User.create({
    organizationId: new mongoose.Types.ObjectId(), email: `fin${n}@demo.example`,
    name: "Finance", role: "approver", isActive: true, passwordHash: "x",
  });

  const raw = await RawItem.create({
    name: `Cutting blade ${n}`, sku: `BLD-${n}`, unit: "pcs",
    quantity: stockQty, minStock: 0,
  });

  /* TL-approved and with the store — exactly what the intake desk spawns for
     a store-issue classification, head and all. */
  const mrf = await MRF.create({
    requestedFor: emp._id, requestedForName: "Rutu", requestedForDept: "Tech",
    requestedForId: emp.biometricId, requestType: "USES_BASED", status: "APPROVED",
    createdByRef: emp._id, createdByModel: "Employee", createdByName: "Rutu",
    reason: "The old ones failed inspection",
    approverEmployee: tl._id, approverName: "Meera", approverBiometricId: tl.biometricId,
    tlApproved: true, tlApprovedBy: tl._id, tlApprovedByName: "Meera", tlApprovedAt: new Date(),
    ...(withHead
      ? {
          budgetLedgerId: consumables._id,
          budgetLedgerName: consumables.name,
          budgetCycleId: budget._id,
          budgetFinancialYear: "2026-27",
          budgetDepartment: "Tech",
        }
      : {}),
    items: [{
      rawItem: raw._id, rawItemName: raw.name, rawItemSku: raw.sku,
      requestedQty, unit: "pcs", baseUnit: "pcs",
      itemStatus: "APPROVED", availability: "UNREVIEWED",
    }],
  });

  return { company, consumables, budget, tl, emp, store, fin, raw, mrf,
           itemId: String(mrf.items[0]._id) };
}

const decide = (s, body) =>
  call(s.store, `/${s.mrf._id}/fulfilment-decision`, { method: "POST", body });

/* ═══ 1 · IT IS ON THE SHELF ═══════════════════════════════════════════════ */

describe("issue from stock", () => {
  test("moves stock and involves finance in nothing", async () => {
    const s = await seed({ stockQty: 50, requestedQty: 10 });

    const r = await decide(s, { decision: "issue_from_stock" });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/finance is not involved/i);

    const mrf = await MRF.findById(s.mrf._id).lean();
    expect(mrf.fulfilmentDecision).toBe("issue_from_stock");
    expect(mrf.items[0].issuedQty).toBe(10);
    expect(mrf.status).toBe("ISSUED");

    /* The whole point: nothing was bought, so nothing reached finance and
       nothing was promised out of a budget. */
    expect(await SpendRequest.countDocuments({})).toBe(0);
    expect(await Commitment.countDocuments({})).toBe(0);
    expect(mrf.spendRequestId).toBeFalsy();
  });

  test("the stock ledger is the only thing that moved", async () => {
    const s = await seed({ stockQty: 50, requestedQty: 10 });
    await decide(s, { decision: "issue_from_stock" });

    const raw = await RawItem.findById(s.raw._id).lean();
    expect(raw.quantity).toBe(40);
    /* And the budget is untouched — issuing what the company already owns
       spends nothing. */
    const budget = await Acc_Budget.findById(s.budget._id).lean();
    expect(budget.items[0].allocatedAmount).toBe(100000);
  });

  test("is refused when the shelf is short, and nothing is written", async () => {
    const s = await seed({ stockQty: 4, requestedQty: 10 });

    const r = await decide(s, { decision: "issue_from_stock" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/short — 4 pcs in stock against 10 pcs owed/);

    const mrf = await MRF.findById(s.mrf._id).lean();
    expect(mrf.items[0].issuedQty).toBe(0);
    expect(mrf.fulfilmentDecision).toBeFalsy();
    const raw = await RawItem.findById(s.raw._id).lean();
    expect(raw.quantity).toBe(4);
  });
});

/* ═══ 2 · NONE OF IT IS ═══════════════════════════════════════════════════ */

describe("buy or arrange a service", () => {
  const commercial = {
    decision: "buy_or_service",
    vendorName: "Sharma Engineering",
    gstin: "21AAAAA0000A1Z5",
    gstPercent: 18,
    expectedDeliveryDate: "2026-09-20",
    note: "Only vendor who stocks this grade",
  };

  test("prices it and sends it to finance", async () => {
    const s = await seed({ stockQty: 0, requestedQty: 10 });

    const r = await decide(s, {
      ...commercial,
      lines: [{ itemId: s.itemId, buyQty: 10, rate: 250 }],
    });
    expect(r.status).toBe(200);
    expect(r.body.spendRequest).toMatchObject({
      status: "pending_finance", totalAmount: 2500, gstPercent: 18,
      taxAmount: 450, grandTotal: 2950,
    });

    const spend = await SpendRequest.findOne({}).lean();
    /* Everything finance has to decide with. */
    expect(spend.vendorName).toBe("Sharma Engineering");
    expect(spend.items[0]).toMatchObject({ quantity: 10, unit: "pcs", rate: 250, amount: 2500 });
    expect(spend.expectedDeliveryDate).toBeTruthy();
    expect(spend.pricedByName).toMatch(/Bikash/);
    expect(spend.pricedAt).toBeTruthy();
    /* The head the requester's manager chose, carried — not one Store picked. */
    expect(String(spend.ledgerId)).toBe(String(s.consumables._id));
    expect(spend.budgetMatchStatus).toBe("matched");
    expect(spend.budgetSnapshot.approved).toBe(100000);
    /* And the trail back to the request it is the balance of. */
    expect(String(spend.sourceMrfId)).toBe(String(s.mrf._id));
    expect(spend.sourceMrfNumber).toBe(s.mrf.mrfNumber);
    /* The requester is still the requester; Store raised it for them. */
    expect(spend.requestedById).toBe(s.emp.biometricId);
  });

  test("no stock moves, and no commitment is made until finance says yes", async () => {
    const s = await seed({ stockQty: 40, requestedQty: 10 });
    await decide(s, { ...commercial, lines: [{ itemId: s.itemId, buyQty: 10, rate: 250 }] });

    const raw = await RawItem.findById(s.raw._id).lean();
    expect(raw.quantity).toBe(40);
    /* A commitment is FINANCE's yes, not Store's pricing. */
    expect(await Commitment.countDocuments({})).toBe(0);
  });

  test("the TL's yes is carried, not asked for again", async () => {
    const s = await seed({ stockQty: 0, requestedQty: 10 });
    await decide(s, { ...commercial, lines: [{ itemId: s.itemId, buyQty: 10, rate: 250 }] });

    const spend = await SpendRequest.findOne({}).lean();
    expect(spend.status).toBe("pending_finance");
    expect(spend.tlApprovedByName).toMatch(/Meera/);
    expect(spend.approverBiometricId).toBe(s.tl.biometricId);
  });

  test("a line with no rate is refused — finance approves a figure", async () => {
    const s = await seed({ stockQty: 0, requestedQty: 10 });
    const r = await decide(s, { ...commercial, lines: [{ itemId: s.itemId, buyQty: 10 }] });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/no rate/);
    expect(await SpendRequest.countDocuments({})).toBe(0);
  });

  test("a request with no budget head cannot become a purchase", async () => {
    /* Store knows the shelf, not the department's envelope. The head is the
       requester's manager's decision and there is nothing to carry. */
    const s = await seed({ stockQty: 0, requestedQty: 10, withHead: false });
    const r = await decide(s, { ...commercial, lines: [{ itemId: s.itemId, buyQty: 10, rate: 250 }] });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/No budget head was set/);
    expect(await SpendRequest.countDocuments({})).toBe(0);
  });
});

/* ═══ 3 · SOME OF IT IS ═══════════════════════════════════════════════════ */

describe("partly issue, buy the balance", () => {
  test("issues what is there and sends only the shortfall on", async () => {
    const s = await seed({ stockQty: 4, requestedQty: 10 });

    const r = await decide(s, {
      decision: "partial_buy_balance",
      vendorName: "Sharma Engineering",
      gstPercent: 18,
      lines: [{ itemId: s.itemId, issueQty: 4, buyQty: 6, rate: 250 }],
    });
    expect(r.status).toBe(200);

    /* The four that were there went out. */
    const raw = await RawItem.findById(s.raw._id).lean();
    expect(raw.quantity).toBe(0);
    const mrf = await MRF.findById(s.mrf._id).lean();
    expect(mrf.items[0].issuedQty).toBe(4);
    expect(mrf.items[0].buyQty).toBe(6);
    expect(mrf.status).toBe("PARTIALLY_ISSUED");
    expect(mrf.fulfilmentDecision).toBe("partial_buy_balance");

    /* And ONLY the six that were not are with finance — the headline claim.
       Sending ten would ask the company to buy what it just handed over. */
    const spend = await SpendRequest.findOne({}).lean();
    expect(spend.items).toHaveLength(1);
    expect(spend.items[0].quantity).toBe(6);
    expect(spend.totalAmount).toBe(1500);
    expect(spend.grandTotal).toBe(1770);
    expect(String(spend.sourceMrfId)).toBe(String(s.mrf._id));
    expect(mrf.spendRequestNumber).toBe(spend.requestNumber);
  });

  test("cannot issue more than the shelf holds", async () => {
    const s = await seed({ stockQty: 4, requestedQty: 10 });
    const r = await decide(s, {
      decision: "partial_buy_balance",
      lines: [{ itemId: s.itemId, issueQty: 9, buyQty: 1, rate: 250 }],
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/only 4 pcs is in stock/);

    const raw = await RawItem.findById(s.raw._id).lean();
    expect(raw.quantity).toBe(4);
    expect(await SpendRequest.countDocuments({})).toBe(0);
  });
});

/* ═══ 4 · WHO MAY DECIDE, AND WHEN ════════════════════════════════════════ */

describe("the gate on the decision itself", () => {
  test("a request the TL has not approved cannot be decided", async () => {
    const s = await seed({ stockQty: 50, requestedQty: 10 });
    await MRF.updateOne({ _id: s.mrf._id }, { $set: { status: "PENDING", tlApproved: false } });

    const r = await decide(s, { decision: "issue_from_stock" });
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/has not been approved yet/);
  });

  test("a cancelled request cannot be decided", async () => {
    const s = await seed({ stockQty: 50, requestedQty: 10 });
    await MRF.updateOne({ _id: s.mrf._id }, { $set: { status: "CANCELLED" } });

    const r = await decide(s, { decision: "issue_from_stock" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/cancelled/);
  });

  test("an unknown decision is refused", async () => {
    const s = await seed({ stockQty: 50, requestedQty: 10 });
    const r = await decide(s, { decision: "maybe_later" });
    expect(r.status).toBe(400);
  });
});

/* ═══ 5 · FINANCE APPROVES MONEY ══════════════════════════════════════════ */

describe("what finance may approve", () => {
  test("a priced request from Store can be approved, and promises the money", async () => {
    const s = await seed({ stockQty: 0, requestedQty: 10 });
    await decide(s, {
      decision: "buy_or_service", vendorName: "Sharma Engineering", gstPercent: 18,
      lines: [{ itemId: s.itemId, buyQty: 10, rate: 250 }],
    });
    const spend = await SpendRequest.findOne({}).lean();

    const ok = await call(s.fin, `/${spend._id}/approve`, { method: "PATCH", app: "spend" });
    expect(ok.status).toBe(200);
    expect(ok.body.request.status).toBe("approved");

    /* NOW the money is promised — finance's yes, not Store's pricing. */
    const commitment = await Commitment.findOne({ spendRequestId: spend._id }).lean();
    expect(commitment).toBeTruthy();
        /* ── THIS FIGURE CHANGED, AND IS NOW THE RIGHT ONE ──────────────────
       The commitment used to reserve `totalAmount` — the SUBTOTAL. This
       fixture carries 18% GST, so a request that will cost ₹2950 reserved only
       ₹2500, and the tax appeared when the voucher posted, putting the head over
       by an amount nobody had promised. It now reserves what will actually
       leave the bank. */
    expect(commitment.amount).toBe(2950);
    expect(commitment.status).toBe("committed");
  });

  test("an unpriced request cannot be approved", async () => {
    /* Written straight into the collection the way a bad import or a future
       endpoint could: lines with no rate and a zero total. Approving it would
       commit the budget to nothing against a purchase that is not nothing. */
    const s = await seed();
    const spend = await SpendRequest.create({
      title: "Unpriced", requestType: "PRODUCT", purpose: "Because",
      requestedBy: s.emp._id, requestedByName: "Rutu", requestedById: s.emp.biometricId,
      department: "Tech", companyId: s.company._id,
      items: [{ name: "Blade", whyNeeded: "Failed inspection", quantity: 10, unit: "pcs", rate: 0, amount: 0 }],
      totalAmount: 0, status: "pending_finance",
    });

    const no = await call(s.fin, `/${spend._id}/approve`, { method: "PATCH", app: "spend" });
    expect(no.status).toBe(400);
    expect(no.body.code).toBe("NOT_PRICED");
    expect(no.body.message).toMatch(/has not been priced yet/);
    expect(await Commitment.countDocuments({})).toBe(0);
  });

  test("but an unpriced request can still be rejected", async () => {
    /* Refusing something nobody has costed is a perfectly good answer, and
       often the right one. Gating the rejection too would strand it. */
    const s = await seed();
    const spend = await SpendRequest.create({
      title: "Unpriced", requestType: "PRODUCT", purpose: "Because",
      requestedBy: s.emp._id, requestedByName: "Rutu", requestedById: s.emp.biometricId,
      department: "Tech", companyId: s.company._id,
      items: [{ name: "Blade", whyNeeded: "Failed inspection", quantity: 10, unit: "pcs", rate: 0, amount: 0 }],
      totalAmount: 0, status: "pending_finance",
    });

    const r = await call(s.fin, `/${spend._id}/reject`, {
      method: "PATCH", app: "spend", body: { note: "Use the existing grade instead" },
    });
    expect(r.status).toBe(200);
    expect(r.body.request.status).toBe("rejected");
  });
});
