// test/requests/spend-budget-commitment.route.test.js
//
// SPEND REQUESTS AGAINST A BUDGET — matching, and the commitment finance's
// approval creates.
//
// The rule this suite exists to pin: a budget head has three figures, not two.
//
//   approved   the envelope finance agreed
//   committed  approved requests not yet paid   ← the one added here
//   actual     posted vouchers
//
// available = approved − committed − actual.
//
// Before this, four ₹20,000 requests could be approved against a ₹50,000 head
// and every screen still reported ₹50,000 available until the invoices came.
//
// ── WHAT MUST NOT COMMIT ────────────────────────────────────────────────────
// Submitting is not a promise. The TL's yes is not a promise. Only finance's
// is, and only once however many times the button is pressed.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { planEveryItem, PLANNED_KEY } = require("./plannedItems.helper");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const Commitment = require("../../models/Accountant_model/Acc_BudgetCommitment");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const Employee = require("../../models/Employee");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  /* The real EmployeeAuth is a JWT check; the token below is genuinely signed,
     so the router is exercised through its real front door. */
  app.use(
    "/api/requests/spend",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Requests/spendRequests"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/requests/spend`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tokenFor = (emp) =>
  jwt.sign(
    { id: String(emp._id), role: "employee", employeeId: emp.biometricId,
      name: `${emp.firstName} ${emp.lastName}`, email: emp.email },
    process.env.JWT_SECRET || "grav_clothing_secret_key",
    { expiresIn: "10m" },
  );

const call = (emp, path, { method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(emp)}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

/**
 * A company, one expense head, a live budget with a ₹50,000 line for
 * Logistics, and three people: a requester, their TL, and a finance approver.
 */
async function seed({ allocated = 50000, budgetStatus = "active", lineDepartment = "Logistics" } = {}) {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `Spend Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const group = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const ledger = await Acc_Ledger.create({
    companyId: company._id, name: `Repairs ${n}`, groupId: group._id,
    groupName: group.name, nature: "expense",
  });

  const budget = allocated === null ? null : await planEveryItem(await Acc_Budget.create({
    name: `Budget FY 2026-27 (${n})`, financialYear: "2026-27", period: "yearly",
    status: budgetStatus, startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [{ ledgerId: ledger._id, ledgerName: ledger.name, nature: "expense",
              department: lineDepartment, allocatedAmount: allocated }],
    budgetRequests: [],
  }));

  const tl = await Employee.create({
    firstName: "Sakib", lastName: `Tl${n}`, email: `tl${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `TL${n}`, department: "Logistics",
  });
  const emp = await Employee.create({
    firstName: "Rutu", lastName: `Emp${n}`, email: `emp${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `EM${n}`, department: "Logistics",
    primaryManager: { managerId: tl._id },
  });
  const finEmp = await Employee.create({
    firstName: "Soumya", lastName: `Fin${n}`, email: `fin${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `FN${n}`, department: "Accounts",
  });
  await Acc_User.create({
    organizationId: new mongoose.Types.ObjectId(), email: `fin${n}@demo.example`,
    name: "Finance", role: "approver", isActive: true, passwordHash: "x",
  });

  /* Somebody who may act for Store — raising a purchase order is theirs. */
  const storeDept =
    (await AccessDepartment.findOne({ slug: "store" })) ||
    (await AccessDepartment.create({
      key: `store-${n}`, slug: "store", name: "Store & Purchase",
      dashboardPath: "/store/dashboard", isActive: true,
    }));
  const store = await Employee.create({
    firstName: "Bikash", lastName: `S${n}`, email: `store${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `ST${n}`,
    department: "Store", accessDepartmentId: storeDept._id,
  });

  return { company, ledger, budget, emp, tl, finEmp, store };
}

const raise = (emp, ledger, amount, over = {}) =>
  call(emp, "/", {
    method: "POST",
    body: {
      title: "Compressor repair",
      requestType: "SERVICE",
      purpose: "Failed the annual inspection",
      ledgerId: String(ledger._id),
      plannedItemKey: PLANNED_KEY,
      items: [{ name: "Service visit", whyNeeded: "Failed inspection",
                quantity: 1, unit: "visit", rate: amount }],
      ...over,
    },
  });

const liveCommitments = (requestId) =>
  Commitment.countDocuments({ spendRequestId: requestId });

/* ═══ MATCHING ════════════════════════════════════════════════════════════ */

describe("which budget line a request belongs to", () => {
  test("a live line for this department and head is matched, with what is left on it", async () => {
    const { emp, ledger } = await seed({ allocated: 50000 });
    const { status, body } = await raise(emp, ledger, 12000);

    expect(status).toBe(201);
    expect(body.request.budgetMatchStatus).toBe("matched");
    expect(body.request.budgetSnapshot).toMatchObject({
      approved: 50000,
      committedBefore: 0,
      actual: 0,
      availableBefore: 50000,
      requested: 12000,
      availableAfter: 38000,
    });
  });

  test("a ledger the department has no approved budget for is refused outright", async () => {
    /* Since the picker was scoped to approved heads, naming an arbitrary
       ledger in the payload is somebody going around it. The way to spend
       against a head you do not have is to ASK for it — see the unbudgeted
       path below — not to select it. */
    const { emp, ledger } = await seed({ allocated: null });
    const { status, body } = await raise(emp, ledger, 12000);

    expect(status).toBe(400);
    expect(body.code).toBe("HEAD_NOT_APPROVED");
  });

  test("asking for a head the department does not have still goes through", async () => {
    /* A request against an unbudgeted head is a real request. Refusing it
       would move that spending somewhere nobody is measuring. */
    const { emp } = await seed({ allocated: null });
    const { status, body } = await call(emp, "/", {
      method: "POST",
      body: {
        title: "Design tooling", requestType: "SERVICE",
        purpose: "No head covers this yet",
        unbudgetedHead: true,
        requestedHeadName: "Design tooling",
        requestedHeadReason: "None of our approved heads cover design software.",
        items: [{ name: "Licence", whyNeeded: "New need", quantity: 1, unit: "year", rate: 12000 }],
      },
    });

    expect(status).toBe(201);
    expect(body.request.budgetMatchStatus).toBe("no_budget_line");
    expect(body.request.budgetSnapshot).toBeNull();
    expect(body.request.status).toBe("pending_tl");
  });

  test("a line under another department is told apart from no line at all", async () => {
    /* The money exists; it is simply not this department's to spend. Saying
       "no budget" would send them off to raise another line.

       Read through the budget check rather than a submit: the submit refuses
       this ledger outright now, and the distinction still has to be drawn
       somewhere a screen can show it. */
    const { emp, ledger } = await seed({ allocated: 50000, budgetStatus: "collecting",
                                         lineDepartment: "Merchandising" });
    const { body } = await call(emp, `/budget-check?ledgerId=${ledger._id}&amount=12000`);
    expect(body.match.status).toBe("wrong_department");
  });

  test("a line in a cycle that is not in force yet is told apart too", async () => {
    const { emp, ledger } = await seed({ allocated: 50000, budgetStatus: "collecting" });
    const { body } = await call(emp, `/budget-check?ledgerId=${ledger._id}&amount=12000`);
    expect(body.match.status).toBe("inactive_cycle");
  });

  test("a request larger than what is available still goes through, and says so", async () => {
    const { emp, ledger } = await seed({ allocated: 10000 });
    const { status, body } = await raise(emp, ledger, 25000);

    expect(status).toBe(201);
    expect(body.request.budgetMatchStatus).toBe("matched");
    /* Negative headroom is the whole signal — finance has to see it. */
    expect(body.request.budgetSnapshot.availableAfter).toBe(-15000);
  });
});

/* ═══ WHAT DOES AND DOES NOT COMMIT ═══════════════════════════════════════ */

describe("a commitment is finance's yes, and only finance's", () => {
  test("submitting commits nothing", async () => {
    const { emp, ledger } = await seed();
    const { body } = await raise(emp, ledger, 12000);
    await expect(liveCommitments(body.request._id)).resolves.toBe(0);
    expect(body.request.commitmentId).toBeNull();
  });

  test("the TL's approval commits nothing either", async () => {
    /* The TL says the department needs it. Whether the company should spend
       the money is the next question, and it is the one that promises it. */
    const { emp, tl, ledger } = await seed();
    const { body } = await raise(emp, ledger, 12000);
    const id = body.request._id;

    const approved = await call(tl, `/${id}/approve`, { method: "PATCH", body: {} });
    expect(approved.body.request.status).toBe("pending_finance");
    await expect(liveCommitments(id)).resolves.toBe(0);
  });

  test("finance's approval creates exactly one commitment", async () => {
    const { emp, tl, finEmp, ledger, budget } = await seed({ allocated: 50000 });
    const { body } = await raise(emp, ledger, 12000);
    const id = body.request._id;

    await call(tl, `/${id}/approve`, { method: "PATCH", body: {} });
    const decided = await call(finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    expect(decided.status).toBe(200);
    expect(decided.body.request.status).toBe("approved");
    expect(decided.body.request.budgetApprovalKind).toBe("within_budget");
    expect(decided.body.request.commitmentStatus).toBe("committed");
    await expect(liveCommitments(id)).resolves.toBe(1);

    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    expect(c.amount).toBe(12000);
    expect(String(c.budgetId)).toBe(String(budget._id));
    expect(c.status).toBe("committed");
  });

  test("a taxed request reserves the grand total, not the subtotal", async () => {
    /* ── THE SHORTFALL THIS CLOSES ──────────────────────────────────────
       The commitment took `totalAmount`, which is the SUBTOTAL. A ₹1,416
       purchase reserved ₹1,200, and the ₹216 of tax appeared only when the
       voucher posted — at which point the head was over by an amount nobody
       had ever promised, and no report could say where it came from. */
    const { emp, tl, finEmp, ledger } = await seed({ allocated: 50000 });
    const { body } = await raise(emp, ledger, 1200);
    const id = body.request._id;
    await SpendRequest.updateOne(
      { _id: id },
      { $set: { gstPercent: 18, taxAmount: 216, grandTotal: 1416 } },
    );

    await call(tl, `/${id}/approve`, { method: "PATCH", body: {} });
    await call(finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    expect(c.amount).toBe(1416);
  });

  test("an untaxed request still reserves exactly what it always did", async () => {
    /* Every request raised before tax was captured has no `grandTotal`, and
       must commit the same figure it has always committed — a fix that
       restated old commitments would be worse than the bug. */
    const { emp, tl, finEmp, ledger } = await seed({ allocated: 50000 });
    const { body } = await raise(emp, ledger, 900);
    const id = body.request._id;
    await SpendRequest.updateOne({ _id: id }, { $unset: { grandTotal: "" } });

    await call(tl, `/${id}/approve`, { method: "PATCH", body: {} });
    await call(finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    expect(c.amount).toBe(900);
  });

  test("a rejection owes a reason, and promises nothing", async () => {
    /* An approval needs no reason — a forced one produces "ok", which reads
       like a reason and is not. A refusal does: the person who asked reads
       exactly those words, and "rejected" on its own is not an answer. */
    const { emp, tl, finEmp, ledger } = await seed({ allocated: 50000 });
    const { body } = await raise(emp, ledger, 12000);
    const id = body.request._id;
    await call(tl, `/${id}/approve`, { method: "PATCH", body: {} });

    const bare = await call(finEmp, `/${id}/reject`, { method: "PATCH", body: {} });
    expect(bare.status).toBe(400);
    expect(bare.body.message).toMatch(/say why/i);
    /* Refused, so nothing moved — not even a commitment that would have to be
       released again afterwards. */
    await expect(liveCommitments(id)).resolves.toBe(0);

    const withReason = await call(finEmp, `/${id}/reject`, {
      method: "PATCH", body: { note: "Get a second quote first" },
    });
    expect(withReason.status).toBe(200);
    expect(withReason.body.request.status).toBe("rejected");
    expect(withReason.body.request.decisionNote).toBe("Get a second quote first");
    /* A refusal never promises money. */
    await expect(liveCommitments(id)).resolves.toBe(0);
  });

  test("approving twice does not promise the money twice", async () => {
    /* A double click, a retry, a flaky connection. There is no ledger to
       reconcile against that would ever reveal a double-counted ₹12,000. */
    const { emp, tl, finEmp, ledger } = await seed();
    const { body } = await raise(emp, ledger, 12000);
    const id = body.request._id;
    await call(tl, `/${id}/approve`, { method: "PATCH", body: {} });
    await call(finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    const again = await call(finEmp, `/${id}/approve`, { method: "PATCH", body: {} });
    /* Already approved — the chain refuses it, and nothing new is written. */
    expect(again.status).toBe(403);
    await expect(liveCommitments(id)).resolves.toBe(1);
  });

  test("a rejected request commits nothing", async () => {
    const { emp, tl, finEmp, ledger } = await seed();
    const { body } = await raise(emp, ledger, 12000);
    const id = body.request._id;
    await call(tl, `/${id}/approve`, { method: "PATCH", body: {} });

    const no = await call(finEmp, `/${id}/reject`, {
      method: "PATCH", body: { note: "Get a second quote first." },
    });
    expect(no.body.request.status).toBe("rejected");
    await expect(liveCommitments(id)).resolves.toBe(0);
  });

  test("an over-budget approval is recorded as one, not as an ordinary yes", async () => {
    const { emp, tl, finEmp, ledger } = await seed({ allocated: 10000 });
    const { body } = await raise(emp, ledger, 25000);
    const id = body.request._id;
    await call(tl, `/${id}/approve`, { method: "PATCH", body: {} });
    const decided = await call(finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    expect(decided.body.request.budgetApprovalKind).toBe("over_budget");
    /* It still commits — the money IS promised. What changes is the record. */
    await expect(liveCommitments(id)).resolves.toBe(1);
  });

  test("an unbudgeted approval commits too, and is marked unbudgeted", async () => {
    /* It has no line to reduce, which is exactly why finance has to be able to
       total them. */
    const { emp, tl, finEmp } = await seed({ allocated: null });
    const body = (await call(emp, "/", {
      method: "POST",
      body: {
        title: "Design tooling", requestType: "SERVICE", purpose: "No head yet",
        unbudgetedHead: true, requestedHeadName: "Design tooling",
        requestedHeadReason: "Nothing approved covers this.",
        items: [{ name: "Licence", whyNeeded: "New", quantity: 1, unit: "year", rate: 12000 }],
      },
    })).body;
    const id = body.request._id;
    await call(tl, `/${id}/approve`, { method: "PATCH", body: {} });
    const decided = await call(finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    expect(decided.body.request.budgetApprovalKind).toBe("unbudgeted");
    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    expect(c.status).toBe("unbudgeted");
    expect(c.budgetLineId).toBeUndefined();
  });
});

/* ═══ THE THIRD FIGURE ════════════════════════════════════════════════════ */

describe("committed money is no longer available to promise", () => {
  test("a second request sees what the first one already took", async () => {
    const { emp, tl, finEmp, ledger } = await seed({ allocated: 50000 });

    const first = await raise(emp, ledger, 30000);
    await call(tl, `/${first.body.request._id}/approve`, { method: "PATCH", body: {} });
    await call(finEmp, `/${first.body.request._id}/approve`, { method: "PATCH", body: {} });

    const second = await raise(emp, ledger, 12000);
    expect(second.body.request.budgetSnapshot).toMatchObject({
      approved: 50000,
      committedBefore: 30000,
      actual: 0,
      availableBefore: 20000,
      availableAfter: 8000,
    });
  });

  test("and a commitment is never counted as actual spend", async () => {
    /* A promise is not a posting. It reduces what is left to promise next; it
       does not appear in the books. */
    const { emp, tl, finEmp, ledger } = await seed({ allocated: 50000 });
    const r = await raise(emp, ledger, 30000);
    await call(tl, `/${r.body.request._id}/approve`, { method: "PATCH", body: {} });
    await call(finEmp, `/${r.body.request._id}/approve`, { method: "PATCH", body: {} });

    const next = await raise(emp, ledger, 1000);
    expect(next.body.request.budgetSnapshot.actual).toBe(0);
  });
});

/* ═══ MATERIAL FROM STORE IS UNTOUCHED ════════════════════════════════════ */

test("nothing here creates, changes or commits against an MRF", async () => {
  const { emp, tl, finEmp, ledger } = await seed();
  const before = await MRF.countDocuments({});

  const r = await raise(emp, ledger, 12000);
  await call(tl, `/${r.body.request._id}/approve`, { method: "PATCH", body: {} });
  await call(finEmp, `/${r.body.request._id}/approve`, { method: "PATCH", body: {} });

  await expect(MRF.countDocuments({})).resolves.toBe(before);
  /* And no commitment anywhere points at one. */
  await expect(Commitment.countDocuments({ spendRequestId: { $exists: false } })).resolves.toBe(0);
});

/* ═══ WITHDRAWING AFTER THE PROMISE WAS MADE ══════════════════════════════
   Up to finance's yes, a request is just an ask. After it, the company has
   promised the money — a budget line is reduced by it and Store may already be
   raising the order — so taking it back is finance's move, not the
   requester's. */

describe("cancelling an approved request", () => {
  async function approved() {
    const s = await seed({ allocated: 50000 });
    const { body } = await raise(s.emp, s.ledger, 12000);
    const id = body.request._id;
    await call(s.tl, `/${id}/approve`, { method: "PATCH", body: {} });
    await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });
    return { ...s, id };
  }

  test("the requester can no longer withdraw it quietly", async () => {
    const { emp, id } = await approved();
    const { status, body } = await call(emp, `/${id}/cancel`, {
      method: "PATCH", body: { note: "changed my mind" },
    });
    expect(status).toBe(403);
    expect(body.message).toMatch(/Ask finance to withdraw it/);
    /* And the promise is untouched. */
    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    expect(c.status).toBe("committed");
  });

  test("finance withdrawing it releases the promise, with the reason recorded", async () => {
    const { finEmp, id } = await approved();
    const { status, body } = await call(finEmp, `/${id}/cancel`, {
      method: "PATCH", body: { note: "Vendor withdrew the quote." },
    });
    expect(status).toBe(200);
    expect(body.request.status).toBe("cancelled");

    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    expect(c.status).toBe("released");
    expect(c.releaseReason).toBe("request_cancelled");
    /* Released, not deleted — still the record of what was agreed. */
    expect(c.amount).toBe(12000);
  });

  test("and the line is available again", async () => {
    const { finEmp, id, budget } = await approved();
    const line = budget.items[0]._id;
    const svc = require("../../services/budgetCommitment.service");
    await expect(svc.committedByLine([line]).then((m) => m.get(String(line)) || 0)).resolves.toBe(12000);

    await call(finEmp, `/${id}/cancel`, { method: "PATCH", body: { note: "Not needed." } });
    await expect(svc.committedByLine([line]).then((m) => m.get(String(line)) || 0)).resolves.toBe(0);
  });

  test("withdrawing before finance approves still commits nothing to release", async () => {
    const { emp, ledger } = await seed();
    const { body } = await raise(emp, ledger, 12000);
    const done = await call(emp, `/${body.request._id}/cancel`, {
      method: "PATCH", body: { note: "not needed" },
    });
    expect(done.status).toBe(200);
    await expect(liveCommitments(body.request._id)).resolves.toBe(0);
  });
});

/* ═══ THE ACCOUNT HEAD IS NOT OPTIONAL ════════════════════════════════════
   Budget matching is department + account head + amount. A spend request with
   no head has no envelope to be measured against — finance would be approving
   a figure with nothing behind it. Checked on the server, not only in the
   form, because a form is a convenience and this is a rule. */

describe("a spend request must name an account head", () => {
  const body = (over = {}) => ({
    title: "Compressor repair",
    requestType: "SERVICE",
    purpose: "Failed the annual inspection",
    items: [{ name: "Visit", whyNeeded: "Failed", quantity: 1, unit: "visit", rate: 8500 }],
    ...over,
  });

  test("no head at all is refused, and says what to do", async () => {
    const { emp } = await seed();
    const { status, body: out } = await call(emp, "/", { method: "POST", body: body() });
    expect(status).toBe(400);
    expect(out.message).toBe("Choose the account head this spend belongs to.");
  });

  test("an empty head is refused the same way", async () => {
    const { emp } = await seed();
    const { status, body: out } = await call(emp, "/", {
      method: "POST", body: body({ ledgerId: "" }),
    });
    expect(status).toBe(400);
    expect(out.message).toBe("Choose the account head this spend belongs to.");
  });

  test("with more than one set of books, it refuses rather than guessing which", async () => {
    /* The stronger guarantee, and the reason a cross-company head can never be
       charged today: an employee's session says nothing about which books
       their spend belongs to, so with several the route stops instead of
       filing it against whichever company was created first.

       This fires BEFORE the head is even looked at, which is why there is no
       "head from another company" case to test — it is unreachable while the
       company itself is ambiguous. */
    const { emp, ledger } = await seed();
    await seed(); // a second set of books
    const { status, body: out } = await call(emp, "/", {
      method: "POST", body: body({ ledgerId: String(ledger._id) }),
    });
    expect(status).toBe(409);
    expect(out.message).toMatch(/More than one set of books/);
  });

  test("with a head it goes through, and the head is stored on the request", async () => {
    const { emp, ledger } = await seed();
    const { status, body: out } = await call(emp, "/", {
      method: "POST", body: body({ ledgerId: String(ledger._id) }),
    });
    expect(status).toBe(201);
    const saved = await SpendRequest.findById(out.request._id).lean();
    expect(String(saved.ledgerId)).toBe(String(ledger._id));
    expect(saved.ledgerName).toBe(ledger.name);
    /* And it is what the budget was matched on. */
    expect(String(saved.budgetAccountHeadId)).toBe(String(ledger._id));
  });

  test("Material from Store is untouched by any of this", async () => {
    /* An MRF asks the store to issue stock the company already owns. There is
       no spend, so there is no head to charge and nothing here may start
       demanding one. */
    const before = await MRF.countDocuments({});
    const { emp, ledger } = await seed();
    await call(emp, "/", { method: "POST", body: body({ ledgerId: String(ledger._id) }) });
    await expect(MRF.countDocuments({})).resolves.toBe(before);
  });
});


/* ═══ AN APPROVED QUOTE BECOMES A PURCHASE ORDER ═══════════════════════════
 *
 * ── THE JOIN THAT DID NOT EXIST ─────────────────────────────────────────────
 * A purchase order had no link to anything upstream: it was typed by hand, and
 * "was this order approved?" could only be settled by somebody remembering.
 * The rule "no PO before finance approval" had nothing to attach to.
 *
 * It attaches here. This door builds the order FROM the approval — the vendor
 * Store chose, the rate they were quoted, the tax, the figure finance
 * committed — and writes `spendRequestId` onto it. Re-typing all that into a
 * blank PO form is how the document that reaches the vendor stops matching the
 * one that was approved.
 */
describe("converting an approved quote into a purchase order", () => {
  const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");

  /** Raise → TL → finance approve, and return the approved request's id. */
  async function approved(s, amount = 1200, over = {}) {
    const { body } = await raise(s.emp, s.ledger, amount, over);
    const id = body.request._id;
    await call(s.tl, `/${id}/approve`, { method: "PATCH", body: {} });
    await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });
    return id;
  }

  test("the order carries the vendor, the lines and the approved figure", async () => {
    const s = await seed({ allocated: 50000 });
    const id = await approved(s);
    await SpendRequest.updateOne(
      { _id: id },
      {
        $set: {
          gstPercent: 18, taxAmount: 216, grandTotal: 1416,
          "items.0.vendorName": "Fancy Corner",
          "items.0.expectedDeliveryDate": new Date("2026-09-20"),
        },
      },
    );

    const { status, body } = await call(s.store, `/${id}/purchase-order`, {
      method: "POST", body: {},
    });

    expect(status).toBe(201);
    const po = await PurchaseOrder.findOne({ spendRequestId: id }).lean();
    expect(po).toBeTruthy();
    expect(po.vendorName).toBe("Fancy Corner");
    expect(po.items).toHaveLength(1);
    expect(po.items[0].unitPrice).toBe(1200);
    expect(po.subtotal).toBe(1200);
    expect(po.taxAmount).toBe(216);
    expect(po.totalAmount).toBe(1416);
    /* DRAFT, not ISSUED: approving the money is not the same as sending the
       order to the vendor, and that is the PO module's own step. */
    expect(po.status).toBe("DRAFT");
    /* The link that makes "was this approved?" answerable. */
    expect(po.spendRequestNumber).toBe(body.request.requestNumber);

    const doc = await SpendRequest.findById(id).lean();
    expect(doc.status).toBe("ordered");
    expect(doc.purchaseOrderNumber).toBe(po.poNumber);
  });

  test("a quote that has not been approved cannot become an order", async () => {
    /* The rule that previously had nothing to attach to. */
    const s = await seed({ allocated: 50000 });
    const { body } = await raise(s.emp, s.ledger, 1200);
    const id = body.request._id;

    const { status, body: refusal } = await call(s.store, `/${id}/purchase-order`, {
      method: "POST", body: {},
    });
    expect(status).toBe(409);
    expect(refusal.message).toMatch(/can only be raised against an approved one/i);
    expect(await PurchaseOrder.countDocuments({ spendRequestId: id })).toBe(0);
  });

  test("one approval cannot become two orders", async () => {
    const s = await seed({ allocated: 50000 });
    const id = await approved(s);
    await SpendRequest.updateOne({ _id: id }, { $set: { "items.0.vendorName": "Fancy Corner" } });

    expect((await call(s.store, `/${id}/purchase-order`, { method: "POST", body: {} })).status).toBe(201);
    const second = await call(s.store, `/${id}/purchase-order`, { method: "POST", body: {} });
    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/already been raised/i);
    expect(await PurchaseOrder.countDocuments({ spendRequestId: id })).toBe(1);
  });

  test("a quote naming two suppliers is refused rather than ordered from one", async () => {
    /* A purchase order is one document to one vendor. Picking whichever line
       came first would send an order to a supplier who never quoted for it. */
    const s = await seed({ allocated: 50000 });
    const { body } = await raise(s.emp, s.ledger, 1200, {
      items: [
        { name: "Laptop", whyNeeded: "x", quantity: 1, unit: "pcs", rate: 1000 },
        { name: "AMC", whyNeeded: "x", quantity: 1, unit: "yr", rate: 200 },
      ],
    });
    const id = body.request._id;
    await call(s.tl, `/${id}/approve`, { method: "PATCH", body: {} });
    await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });
    await SpendRequest.updateOne(
      { _id: id },
      { $set: { "items.0.vendorName": "Sharma", "items.1.vendorName": "Verma" } },
    );

    const { status, body: refusal } = await call(s.store, `/${id}/purchase-order`, {
      method: "POST", body: {},
    });
    expect(status).toBe(400);
    expect(refusal.message).toMatch(/names 2 suppliers/i);
  });

  test("only Store may raise it", async () => {
    const s = await seed({ allocated: 50000 });
    const id = await approved(s);
    const { status } = await call(s.emp, `/${id}/purchase-order`, { method: "POST", body: {} });
    expect(status).toBe(403);
  });
});
