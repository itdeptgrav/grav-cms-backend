// test/accountant/budget-money-lifecycle.route.test.js
//
// THE WHOLE MONEY STORY, JOINED UP.
//
// Two suites already cover the ends of it. `budget-end-to-end` proves a
// department can propose and finance can agree, and stops with an allocation
// line. `budget-spend-lifecycle` picks up from a hand-made allocation and
// proves vouchers bring a head down.
//
// Neither knows the Requests app exists — and the Requests app is now where
// spending STARTS. An employee asks for something, a manager agrees the need,
// Store decides how it gets fulfilled, and only then does finance see a spend
// request at all. Finance's yes creates a COMMITMENT, which is a promise
// against a budget line that no voucher has yet made real.
//
// The commitment is the newest object in this system and it sits exactly in
// the seam these two suites leave open: between an allocation and a voucher.
// This walk covers that seam, from a budget nobody has funded to money posted
// against it, through the door people actually use.
//
// It narrates. Run it alone to read the pipeline:
//   npx jest test/accountant/budget-money-lifecycle --silent=false
//
// ── FOUR ROUTERS, TWO AUTHENTICATIONS ───────────────────────────────────────
// They are separate apps in production and are mounted separately here.
// Accountant routes take a mocked header user; the Requests routes take a REAL
// employee JWT, because their identity resolution — who your manager is,
// whether you are in Store, whether the books know you as an approver — is
// half of what is under test and mocking it would test nothing.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    req.user = JSON.parse(req.headers["x-test-user"]);
    next();
  },
}));
jest.mock("../../Middlewear/AccountantOrgAuthMiddleware", () => ({
  orgAuth: (req, res, next) => {
    req.user = JSON.parse(req.headers["x-test-user"]);
    next();
  },
  requireRole: () => (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next(),
}));

const { SECRET } = require("../../config/jwt");
const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { Acc_BudgetDepartment } = require("../../models/Accountant_model/Acc_BudgetDepartment");
const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const Acc_BudgetCommitment = require("../../models/Accountant_model/Acc_BudgetCommitment");
const Employee = require("../../models/Employee");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const IntakeRequest = require("../../models/CMS_Models/Requests/IntakeRequest");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

/* The CEO. `canPostDirectly`, or the voucher route diverts into the approval
   workflow before the budget gate is ever reached. */
const CEO = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner", email: "priya.owner@example.com", role: "owner",
  permissions: { canEdit: true, canApprove: true, canPostDirectly: true },
};
/* Finance. Going past a budget takes two different people — this is the other
   one, and the same person the Requests app knows as a finance approver. */
const FINANCE_EMAIL = "anil.finance@demo.example";
const FINANCE = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Anil Finance", email: FINANCE_EMAIL, role: "approver",
  permissions: { canEdit: true, canApprove: true, canPostDirectly: true },
};

const DEPT_HEAD_EMAIL = "logistics.head@demo.example";

let servers = [];
let deptBase, finBase, vouBase, intakeBase, spendBase, forecastBase, replSet;

beforeAll(async () => {
  /* Posting a voucher opens a transaction, which a standalone in-memory mongod
     cannot do — and the whole point of this suite is that spend reaches the
     budget. The lock timeout is raised because two replica-set suites on one
     machine occasionally miss Mongo's 5ms default; contention in the test
     environment, not in the code under test. */
  const { MongoMemoryReplSet } = require("mongodb-memory-server");
  replSet = await MongoMemoryReplSet.create({
    replSet: {
      count: 1,
      args: ["--setParameter", "maxTransactionLockRequestTimeoutMillis=5000"],
    },
  });
  await mongoose.disconnect();
  await mongoose.connect(replSet.getUri(), { dbName: "budget_money_lifecycle" });

  const mount = async (path, ...handlers) => {
    const app = express();
    app.use(express.json());
    app.use(path, ...handlers);
    const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    servers.push(srv);
    return `http://127.0.0.1:${srv.address().port}${path}`;
  };

  deptBase = await mount("/api/budget-proposals", require("../../routes/Access/budgetProposals"));
  finBase = await mount("/api/accountant/budgets", require("../../routes/Accountant_Routes/Acc_budgets"));
  vouBase = await mount("/api/accountant/vouchers", require("../../routes/Accountant_Routes/Acc_vouchers"));
  /* The forecast, so the walk can prove a commitment made by the Requests flow
     actually reaches the layer that is supposed to show it. Every other test
     of that layer seeds commitments by hand. */
  forecastBase = await mount(
    "/api/accountant/cash-flow-forecast",
    require("../../routes/Accountant_Routes/Acc_cashFlowForecast"),
  );
  /* Real employee auth on both Requests doors — see the header. */
  intakeBase = await mount(
    "/api/requests/intake",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Requests/intakeRequests"),
  );
  spendBase = await mount(
    "/api/requests/spend",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Requests/spendRequests"),
  );
});

afterAll(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

const json = async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") });

const deptToken = jwt.sign(
  { v: 2, id: new mongoose.Types.ObjectId().toString(), deptSlug: "packaging-dispatch",
    email: DEPT_HEAD_EMAIL, name: "Logistics Head" },
  SECRET, { expiresIn: "1h" },
);

/** The Requests app's own identity. Signed the way EmployeeAuth verifies. */
const empToken = (e) =>
  jwt.sign(
    { id: String(e._id), role: "employee", employeeId: e.biometricId,
      name: `${e.firstName} ${e.lastName}`, email: e.email },
    process.env.JWT_SECRET || "grav_clothing_secret_key",
    { expiresIn: "1h" },
  );

const dept = (path, body, method) =>
  fetch(`${deptBase}${path}`, {
    method: method || (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${deptToken}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(json);

const accountant = (base) => (path, body, method, user = CEO) =>
  fetch(`${base}${path}`, {
    method: method || (body !== undefined ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(user) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(json);

const employee = (base) => (emp, path, body, method) =>
  fetch(`${base}${path}`, {
    method: method || (body !== undefined ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${empToken(emp)}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(json);

let fin, vou, intake, spend, forecast;

const inr = (n) => "Rs " + Number(n || 0).toLocaleString("en-IN");
const step = (n, what) => console.log(`\n── ${n} ─ ${what}`);
const say = (...a) => console.log("   ", ...a);

let seq = 0;
const purchase = ({ companyId, head, bank, amount, extra = {} }) => ({
  companyId: String(companyId),
  voucherType: "purchase",
  voucherNumber: `PU/${seq++}/${Date.now()}`,
  voucherDate: "2026-08-10",
  grandTotal: amount,
  ledgerEntries: [
    { ledgerId: String(head._id), ledgerName: head.name, type: "Dr", amount },
    { ledgerId: String(bank._id), ledgerName: bank.name, type: "Cr", amount },
  ],
  ...extra,
});

jest.setTimeout(180000);

test("a budget is funded, asked against through the Requests app, committed, spent and blown", async () => {
  fin = accountant(finBase);
  vou = accountant(vouBase);
  intake = employee(intakeBase);
  spend = employee(spendBase);
  forecast = accountant(forecastBase);

  /* ═══ SETUP · the company, its books, and four people ════════════════════ */
  const company = await Acc_Company.create({
    companyName: "Lifecycle Co", booksFromDate: new Date("2026-04-01"),
  });
  const expGroup = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const bankGroup = await Acc_Group.create({
    companyId: company._id, name: "Bank Accounts", nature: "asset",
  });
  const repairs = await Acc_Ledger.create({
    companyId: company._id, name: "Repairs & Maintenance", groupId: expGroup._id,
    groupName: expGroup.name, nature: "expense",
  });
  const bank = await Acc_Ledger.create({
    companyId: company._id, name: "HDFC Current", groupId: bankGroup._id,
    groupName: bankGroup.name, nature: "asset",
  });
  await Acc_BudgetDepartment.create({
    companyId: company._id, slug: "logistics", name: "Logistics", accessSlug: "packaging-dispatch",
  });

  const storeDept =
    (await AccessDepartment.findOne({ slug: "store" })) ||
    (await AccessDepartment.create({
      key: "store", slug: "store", name: "Store & Purchase",
      dashboardPath: "/store", isActive: true,
    }));

  const tl = await Employee.create({
    firstName: "Meera", lastName: "Lead", email: "meera.lead@demo.example",
    isActive: true, gender: "Other", biometricId: "TL-1", department: "Logistics",
  });
  const emp = await Employee.create({
    firstName: "Rutu", lastName: "Staff", email: "rutu.staff@demo.example",
    isActive: true, gender: "Other", biometricId: "EM-1", department: "Logistics",
    primaryManager: { managerId: tl._id },
  });
  const storeman = await Employee.create({
    firstName: "Bikash", lastName: "Store", email: "bikash.store@demo.example",
    isActive: true, gender: "Other", biometricId: "ST-1", department: "Store",
    accessDepartmentId: storeDept._id,
  });
  const financeEmp = await Employee.create({
    firstName: "Anil", lastName: "Finance", email: FINANCE_EMAIL,
    isActive: true, gender: "Other", biometricId: "FN-1", department: "Accounts",
  });
  /* The books' own record of the same person — this is what makes them a
     finance approver inside the Requests app. */
  await Acc_User.create({
    organizationId: new mongoose.Types.ObjectId(), email: FINANCE_EMAIL,
    name: "Anil Finance", role: "approver", isActive: true, passwordHash: "x",
  });

  const q = `?companyId=${company._id}`;
  const availability = async () => {
    const r = await fin("/check-availability", {
      companyId: String(company._id), voucherDate: "2026-08-10",
      ledgerEntries: [{ ledgerId: String(repairs._id), type: "Dr", amount: 0 }],
    });
    return r.body.results[0];
  };

  /* ═══ 1 · FINANCE OPENS THE ROUND ════════════════════════════════════════ */
  step(1, "finance opens a round for FY 2026-27");
  const opened = await fin(q, {
    companyId: String(company._id), financialYear: "2026-27",
    scope: "company", status: "collecting",
  });
  expect(opened.status).toBe(201);
  const budget = opened.body.budget || opened.body;
  say(`round "${budget.name}" · ${budget.status}`);

  /* ═══ 2 · THE DEPARTMENT PROPOSES, FINANCE AGREES ════════════════════════ */
  step(2, "Logistics proposes Repairs; finance agrees Rs 1,00,000");
  const proposed = await dept(`/${budget._id}/requests${q}`, {
    department: "Logistics",
    ledgerId: String(repairs._id),
    requestedAmount: 120000,
    purpose: "Plant repairs for the year",
    phasingMode: "even",
    workingLines: [
      { label: "Compressor AMC", description: "Annual contract",
        quantity: 12, unit: "months", rate: 10000 },
    ],
  });
  if (proposed.status !== 201) say("REFUSED:", proposed.status, JSON.stringify(proposed.body));
  expect(proposed.status).toBe(201);

  /* Finance settling at a figure below the ask is a COUNTER and then an
     approval — two acts, because the department has to see the number before
     it becomes their budget. `agree` alone means "as submitted". */
  const countered = await fin(
    `/${budget._id}/requests/${proposed.body.request._id}/counter${q}`,
    { counterAmount: 100000, financeNote: "Funded at the AMC figure." },
  );
  expect(countered.status).toBe(200);

  const agreed = await fin(
    `/${budget._id}/requests/${proposed.body.request._id}/agree${q}`,
    {},
  );
  expect(agreed.status).toBe(200);

  let doc = await Acc_Budget.findById(budget._id).lean();
  expect(doc.items).toHaveLength(1);
  say(`allocation line · ${doc.items[0].ledgerName} · ${inr(doc.items[0].allocatedAmount)}`);
  expect(doc.items[0].allocatedAmount).toBe(100000);

  /* ═══ 3 · THE ROUND GOES LIVE ═══════════════════════════════════════════ */
  step(3, "collection closes and the round activates");
  expect((await fin(`/${budget._id}/close-collection${q}`, {})).status).toBe(200);
  expect((await fin(`/${budget._id}`, { status: "active" }, "PUT")).status).toBe(200);

  const start = await availability();
  say(`allocated ${inr(start.allocated)} · spent ${inr(start.actual)} · remaining ${inr(start.remainingAfter)}`);
  expect(start.allocated).toBe(100000);
  expect(start.actual).toBe(0);

  /* ═══ 4 · AN EMPLOYEE ASKS FOR SOMETHING ════════════════════════════════ */
  step(4, "an employee raises a service request — head chosen, no price");
  const raised = await intake(emp, "/", {
    requestType: "SERVICE",
    purpose: "The compressor on line 2 has started making a noise",
    /* The requester names the envelope out of their own department's approved
       heads. What they are still never asked for is the commercial half — no
       vendor, no rate, no tax. That is Store's, later. */
    ledgerId: String(repairs._id),
    items: [{ name: "Compressor service", quantity: 1, unit: "job" }],
  });
  if (raised.status !== 201) say("REFUSED:", raised.status, JSON.stringify(raised.body));
  expect(raised.status).toBe(201);
  const reqId = raised.body.request.id;
  say(`${raised.body.request.number} · ${raised.body.request.stageLabel}`);
  expect(raised.body.request.stageLabel).toBe("Waiting for department approval");

  /* Nothing about money has happened. This is the claim the whole intake
     redesign rests on: asking costs nothing and commits nothing. */
  expect(await SpendRequest.countDocuments({})).toBe(0);
  expect(await Acc_BudgetCommitment.countDocuments({})).toBe(0);

  /* ═══ 5 · THE MANAGER AGREES THE NEED ═══════════════════════════════════ */
  step(5, "the manager approves the need AND chooses the budget head");
  /* The head list is the manager's now — Store sees it read-only at the next
     step. Refused without one, because a headless request in front of finance
     is a request nobody can price against a budget. */
  const tlHeads = await intake(tl, `/${reqId}/budget-heads`);
  expect(tlHeads.status).toBe(200);
  say(`manager is offered ${tlHeads.body.department}'s heads: ${tlHeads.body.heads.map((h) => h.ledgerName).join(", ")}`);

  /* Approving with nothing posted leaves the requester's own choice standing —
     the head is part of the ask now, so this step is one click again. Posting
     one REPLACES it, checked against the same approved list. */
  const plain = await intake(tl, `/${reqId}/approve`, {}, "PATCH");
  say(`approving with nothing posted → ${plain.status}, head stands`);
  expect(plain.status).toBe(200);
  expect(plain.body.request.budgetHead.ledgerName).toMatch(/Repairs/);

  const tlOk = { status: 200, body: plain.body };
  expect(tlOk.status).toBe(200);
  say(`→ ${tlOk.body.request.stageLabel} · head ${tlOk.body.request.budgetHead.ledgerName}`);
  expect(tlOk.body.request.stageLabel).toBe("With Store for fulfilment");
  expect(tlOk.body.request.budgetHead.ledgerName).toMatch(/Repairs/);
  expect(tlOk.body.request.budgetHead.snapshot.available).toBe(100000);
  expect(await SpendRequest.countDocuments({})).toBe(0);
  expect((await availability()).actual).toBe(0);

  /* ═══ 6 · STORE SAYS IT HAS TO BE BOUGHT ════════════════════════════════ */
  step(6, "Store decides HOW it gets fulfilled — the head is already set");
  /* The head list is offered to the requester's department, whoever asks for
     it. Every head is NAMED: the first run of this walk printed "undefined:
     approved Rs 1,00,000" because the route read `ledgerName` off a service
     that calls the field `name`. A blank dropdown is not a small bug. */
  expect(tlHeads.body.department).toBe("Logistics");
  expect(tlHeads.body.heads.every((h) => !!h.ledgerName)).toBe(true);
  expect(tlHeads.body.financialYear).toBe("2026-27");

  /* Store posting a head of its own is ignored — it is fulfilling a decision,
     not making one. */
  const classified = await intake(storeman, `/${reqId}/classify`, {
    kind: "service", rates: { 0: 40000 },
  }, "PATCH");
  if (classified.status !== 200) say("REFUSED:", classified.status, JSON.stringify(classified.body));
  expect(classified.status).toBe(200);
  say(classified.body.message);

  const intakeDoc = await IntakeRequest.findById(reqId).lean();
  const spendDoc = await SpendRequest.findById(intakeDoc.spendRequestId).lean();
  say(`became ${spendDoc.requestNumber} · ${spendDoc.status} · ${inr(spendDoc.totalAmount)}`);
  expect(spendDoc.status).toBe("pending_finance");
  /* The manager's yes was carried, not re-asked. */
  expect(spendDoc.tlApprovedByName).toMatch(/Meera/);
  expect(spendDoc.requestedById).toBe(emp.biometricId);
  expect(spendDoc.budgetMatchStatus).toBe("matched");
  /* Raised on the head the MANAGER chose, and as the kind the requester
     declared — two different people, two different decisions, both carried. */
  expect(String(spendDoc.ledgerId)).toBe(String(repairs._id));
  expect(spendDoc.requestType).toBe("SERVICE");

  /* Still nothing committed: Store deciding how a thing is bought is not
     finance agreeing to pay for it. */
  expect(await Acc_BudgetCommitment.countDocuments({})).toBe(0);
  expect((await availability()).actual).toBe(0);

  /* ═══ 7 · FINANCE SAYS YES — THE COMMITMENT APPEARS ═════════════════════ */
  step(7, "finance approves; the money is promised though nothing is posted");
  const financeOk = await spend(financeEmp, `/${spendDoc._id}/approve`, {
    note: "Fine, raise the work order",
    expectedPaymentDate: "2026-09-15",
  }, "PATCH");
  if (financeOk.status !== 200) say("REFUSED:", financeOk.status, JSON.stringify(financeOk.body));
  expect(financeOk.status).toBe(200);

  const commitment = await Acc_BudgetCommitment.findOne({ spendRequestId: spendDoc._id }).lean();
  expect(commitment).toBeTruthy();
  say(`commitment ${inr(commitment.amount)} · ${commitment.status} · expected ${String(commitment.expectedPaymentDate).slice(0, 10)}`);
  expect(commitment.status).toBe("committed");
  expect(commitment.amount).toBe(40000);

  /* ── THE SEAM ────────────────────────────────────────────────────────────
     A promise is not a payment. The head's AVAILABLE must fall while its
     ACTUAL stays at zero — anything else means the two figures have been
     conflated, which is how a budget report starts double-counting. */
  const heads2 = await intake(storeman, `/${reqId}/budget-heads`);
  const afterCommit = heads2.body.heads.find((h) => String(h.ledgerId) === String(repairs._id));
  say(`head now: approved ${inr(afterCommit.approved)} · committed ${inr(afterCommit.committed)} · actual ${inr(afterCommit.actual)} · available ${inr(afterCommit.available)}`);
  expect(afterCommit.committed).toBe(40000);
  expect(afterCommit.actual).toBe(0);
  expect(afterCommit.available).toBe(60000);

  /* ── AND WHAT THE POSTING GATE THINKS ────────────────────────────────────
     Deliberately asserted, because the answer is the interesting one. The
     gate reads allocated against actual and does NOT subtract commitments —
     so a head can be promised to its limit and still clear a voucher. See the
     report; this is a finding, not a passing grade. */
  const gateAfterCommit = await availability();
  say(`posting gate sees: allocated ${inr(gateAfterCommit.allocated)} · actual ${inr(gateAfterCommit.actual)} · remaining ${inr(gateAfterCommit.remainingAfter)}`);
  expect(gateAfterCommit.remainingAfter).toBe(100000);

  /* ── AND WHAT THE FORECAST MAKES OF IT ───────────────────────────────────
     The layer that exists to show money finance has agreed to but nobody has
     invoiced. Every other test of it seeds commitments by hand; this is the
     first that asks whether one made by the actual flow arrives. */
  const look = async (layer) => {
    const r = await forecast(`/?companyId=${company._id}&horizon=90&layer=${layer}`);
    expect(r.status).toBe(200);
    return r.body;
  };

  const confirmedBefore = await look("confirmed");
  const withCommitBefore = await look("with_commitments");
  say(`confirmed layer: ${confirmedBefore.inclusion.includedCommitments || 0} commitments · committed total ${inr(confirmedBefore.totals.committed)}`);
  say(`with_commitments: ${withCommitBefore.inclusion.includedCommitments} commitment(s) · committed total ${inr(withCommitBefore.totals.committed)}`);

  /* Confirmed means documents. A promise is not one, and the layer that says
     "confirmed" must not quietly contain intentions. */
  expect(confirmedBefore.totals.committed).toBe(0);
  expect(confirmedBefore.inclusion.includedCommitments || 0).toBe(0);

  /* The promise, on the layer built to carry it — negative because it leaves. */
  expect(withCommitBefore.inclusion.includedCommitments).toBe(1);
  expect(withCommitBefore.totals.committed).toBe(-40000);

  /* ═══ 8 · THE VOUCHER POSTS — THE PROMISE IS RELEASED ═══════════════════ */
  step(8, "Store raises the order and the bill is posted");
  const ordered = await spend(storeman, `/${spendDoc._id}/ordered`, { reference: "WO-2026-014" }, "PATCH");
  expect(ordered.status).toBe(200);
  say(`order ${ordered.body.request.orderReference} · ${ordered.body.request.statusLabel}`);

  const posted = await vou("", purchase({
    companyId: company._id, head: repairs, bank, amount: 40000,
    extra: { autoPost: true, spendRequestId: String(spendDoc._id) },
  }));
  if (posted.status >= 400) say("REFUSED:", posted.status, JSON.stringify(posted.body));
  expect(posted.status).toBeLessThan(400);

  const releasedCommitment = await Acc_BudgetCommitment.findById(commitment._id).lean();
  say(`commitment → ${releasedCommitment.status}`);
  /* Released, never deleted: the commitment remains the record of what finance
     agreed and when. */
  expect(releasedCommitment.status).toBe("released");

  const heads3 = await intake(storeman, `/${reqId}/budget-heads`);
  const afterPost = heads3.body.heads.find((h) => String(h.ledgerId) === String(repairs._id));
  say(`head now: committed ${inr(afterPost.committed)} · actual ${inr(afterPost.actual)} · available ${inr(afterPost.available)}`);
  /* ── THE ARITHMETIC THAT MUST NOT DOUBLE-COUNT ───────────────────────────
     The money moved from committed to actual. Available is the SAME figure it
     was before the voucher — if it dipped, the head was charged twice. */
  expect(afterPost.committed).toBe(0);
  expect(afterPost.actual).toBe(40000);
  expect(afterPost.available).toBe(60000);

  /* ── AND THE FORECAST STOPS COUNTING IT ─────────────────────────────────
     The other half of "no double counting". Once a bill exists the promise it
     replaced must leave the projection, or the same ₹40,000 is forecast twice
     — once as a commitment and once as the document that discharged it. */
  const withCommitAfter = await look("with_commitments");
  say(`with_commitments after posting: ${withCommitAfter.inclusion.includedCommitments} commitment(s) · released and excluded ${withCommitAfter.inclusion.releasedCommitmentsExcluded}`);
  expect(withCommitAfter.inclusion.includedCommitments).toBe(0);
  expect(withCommitAfter.totals.committed).toBe(0);
  expect(withCommitAfter.inclusion.releasedCommitmentsExcluded).toBeGreaterThanOrEqual(1);

  /* ═══ 9 · A SECOND ASK BLOWS THE HEAD ═══════════════════════════════════ */
  step(9, "a second request pushes the head past its allocation");
  const raised2 = await intake(emp, "/", {
    requestType: "SERVICE",
    purpose: "The motor has failed and has to be rewound",
    ledgerId: String(repairs._id),
    items: [{ name: "Motor rewind", quantity: 1, unit: "job" }],
  });
  expect(raised2.status).toBe(201);
  const req2 = raised2.body.request.id;
  await intake(tl, `/${req2}/approve`, { ledgerId: String(repairs._id) }, "PATCH");
  const classified2 = await intake(storeman, `/${req2}/classify`, {
    kind: "service", rates: { 0: 90000 },
  }, "PATCH");
  expect(classified2.status).toBe(200);

  const intake2 = await IntakeRequest.findById(req2).lean();
  const spend2 = await SpendRequest.findById(intake2.spendRequestId).lean();
  say(`${spend2.requestNumber} asks ${inr(spend2.totalAmount)} against ${inr(60000)} available`);
  /* The snapshot recorded what the approver would actually be looking at. */
  expect(spend2.budgetSnapshot.availableAfter).toBeLessThan(0);
  say(`snapshot says available after: ${inr(spend2.budgetSnapshot.availableAfter)}`);

  const financeOk2 = await spend(financeEmp, `/${spend2._id}/approve`, { note: "Unavoidable" }, "PATCH");
  expect(financeOk2.status).toBe(200);
  const spend2After = await SpendRequest.findById(spend2._id).lean();
  say(`finance approved, on the record as: ${spend2After.budgetApprovalKind}`);
  /* Finance may always agree. What changes is what it is recorded AS. */
  expect(spend2After.budgetApprovalKind).toBe("over_budget");

  /* ═══ 10 · POSTING IT TAKES TWO SIGNATURES ══════════════════════════════ */
  step(10, "the bill for it cannot post on one person's say-so");
  const blocked = await vou("", purchase({
    companyId: company._id, head: repairs, bank, amount: 90000,
    extra: { autoPost: true },
  }));
  say(`→ ${blocked.status} ${blocked.body?.code || ""} ${blocked.body?.message || ""}`);
  expect(blocked.status).toBeGreaterThanOrEqual(400);

  /* ═══ 11 · A STORE ISSUE SKIPS ALL OF IT ═══════════════════════════════ */
  step(11, "and something the store already holds never reaches finance");
  const raised3 = await intake(emp, "/", {
    purpose: "Running out of cleaning cloth on the line",
    ledgerId: String(repairs._id),
    items: [{ name: "Cotton waste", quantity: 20, unit: "kg" }],
  });
  expect(raised3.status).toBe(201);
  const req3 = raised3.body.request.id;
  await intake(tl, `/${req3}/approve`, { ledgerId: String(repairs._id) }, "PATCH");

  const spendCountBefore = await SpendRequest.countDocuments({});
  const stock = await intake(storeman, `/${req3}/classify`, { kind: "store_issue" }, "PATCH");
  expect(stock.status).toBe(200);
  say(stock.body.message);

  const intake3 = await IntakeRequest.findById(req3).lean();
  const mrf = await MRF.findById(intake3.mrfId).lean();
  say(`became ${mrf.mrfNumber} · ${mrf.status} · with the store, no finance step`);
  expect(mrf.status).toBe("APPROVED");
  /* No spend request, no commitment, and the budget is untouched — issuing
     stock the company already owns spends nothing. */
  expect(await SpendRequest.countDocuments({})).toBe(spendCountBefore);
  expect((await availability()).actual).toBe(40000);

  /* ═══ 12 · WHAT THE DESK SHOWS AT THE END ══════════════════════════════ */
  step(12, "the finance desk, reading the same head from its own code path");
  const desk = await fin(`/${budget._id}/requests?context=1&companyId=${company._id}`);
  expect(desk.status).toBe(200);
  say(`${desk.body.requests.length} budget request(s) · summary waiting ${desk.body.summary.waiting}`);
  /* The proposal was agreed in step 2, so the queue is empty — and the desk
     says so with a zero rather than by omitting the figure. */
  expect(desk.body.summary.waiting).toBe(0);

  const finalDoc = await Acc_Budget.findById(budget._id).lean();
  say(`\n   FINAL · allocated ${inr(finalDoc.items[0].allocatedAmount)} · posted ${inr(40000)} · promised-and-unposted ${inr(90000)}`);
  const openCommitments = await Acc_BudgetCommitment.find({ status: "committed" }).lean();
  say(`   open commitments: ${openCommitments.length} · ${inr(openCommitments.reduce((n, c) => n + c.amount, 0))}`);
});
