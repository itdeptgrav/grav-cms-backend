// test/accountant/budget-spend-lifecycle.route.test.js
//
// THE SECOND HALF OF A BUDGET'S LIFE — what happens once the money is live.
//
// budget-end-to-end covers the first half: a department proposes, finance
// counters and agrees, and an allocation line appears. It stops there, with
// the money allocated and nothing spent.
//
// This picks it up at that point and answers the two questions nobody had
// asked of the system as a whole:
//
//   1. Does a budget actually go DOWN when vouchers are posted against it?
//   2. What happens when it runs out — how does over-budget approval work,
//      and how does a department get its head topped up afterwards?
//
// Written as one continuous run rather than isolated cases, because the
// interesting failures are between the steps: an allocation that never
// reaches the control, an actual that counts a draft, an override that posts
// but records nothing.
"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    req.user = JSON.parse(req.headers["x-test-user"]);
    next();
  },
}));

/* The approvals router authenticates org-scoped rather than company-scoped.
   Mocked the same way so the approver's gate is reached over real HTTP. */
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

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

/* `canPostDirectly` matters: without it the voucher route diverts into the
   approval workflow and the create gate never runs. */
const FINANCE = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner", email: "priya.owner@example.com", role: "owner",
  permissions: { canEdit: true, canApprove: true, canPostDirectly: true },
};
/* ── THE SECOND SIGNATURE ────────────────────────────────────────────────────
 * Raising an allocation now takes the same two people as spending past one:
 * finance and the CEO, and they must be different people. The owner above is
 * the CEO; this is finance. */
const APPROVER_USER = {
  id: new (require("mongoose").Types.ObjectId)().toString(),
  name: "Anil Approver", email: "anil.approver@example.com", role: "approver",
  permissions: { canEdit: true, canApprove: true, canPostDirectly: true },
};
/* No `canPostDirectly`. A purchase from this person does not post — it goes
   to an approver, which is the two-person half of over-budget approval. */
const CLERK = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Sam Clerk", email: "sam.clerk@example.com", role: "editor",
  permissions: { canEdit: true },
};

const HEAD_EMAIL = "logistics.head@demo.example";

let deptSrv, finSrv, vouSrv, deptBase, finBase, vouBase, replSet;

beforeAll(async () => {
  /* /vouchers/:id/post opens a MongoDB transaction, which a standalone
     in-memory mongod cannot do. The suite that most needs to prove spend
     reaches the budget is the one that would otherwise silently skip it. */
  const { MongoMemoryReplSet } = require("mongodb-memory-server");
  replSet = await MongoMemoryReplSet.create({
    replSet: {
      count: 1,
      /* ── WHY THE LOCK TIMEOUT IS RAISED ──────────────────────────────────
         Mongo gives a transaction 5ms by default to acquire a write lock and
         then gives up. /vouchers/:id/approve runs inside a transaction, and
         when this suite runs beside the other replica-set suite on one
         machine that 5ms is occasionally missed — the approval came back
         "Unable to acquire IX lock ... within 5ms" perhaps one run in three.

         Contention in the test environment, not in the code being tested. The
         alternative was retrying the call, which would also swallow a real
         refusal. Worth knowing that the route itself does NOT retry a
         transient transaction error, so the same contention in production
         surfaces to the approver as a 400. */
      args: ["--setParameter", "maxTransactionLockRequestTimeoutMillis=5000"],
    },
  });
  await mongoose.disconnect();
  await mongoose.connect(replSet.getUri(), { dbName: "budget_spend_lifecycle" });

  const mount = async (path, router) => {
    const app = express();
    app.use(express.json());
    app.use(path, router);
    const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    return [srv, `http://127.0.0.1:${srv.address().port}${path}`];
  };
  [deptSrv, deptBase] = await mount("/api/budget-proposals", require("../../routes/Access/budgetProposals"));
  [finSrv, finBase] = await mount("/api/accountant/budgets", require("../../routes/Accountant_Routes/Acc_budgets"));
  [vouSrv, vouBase] = await mount("/api/accountant/vouchers", require("../../routes/Accountant_Routes/Acc_vouchers"));
});

afterAll(async () => {
  for (const s of [deptSrv, finSrv, vouSrv]) await new Promise((r) => s.close(r));
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

const deptToken = jwt.sign(
  { v: 2, id: new mongoose.Types.ObjectId().toString(), deptSlug: "packaging-dispatch",
    email: HEAD_EMAIL, name: "Logistics Head" },
  SECRET, { expiresIn: "1h" },
);

const json = async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") });
const dept = (path, body, method) =>
  fetch(`${deptBase}${path}`, {
    method: method || (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${deptToken}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(json);
const fin = (path, body, method, user = FINANCE) =>
  fetch(`${finBase}${path}`, {
    method: method || (body !== undefined ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(user) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(json);
const vou = (path, body, method, user = FINANCE) =>
  fetch(`${vouBase}${path}`, {
    method: method || (body !== undefined ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(user) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(json);

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

jest.setTimeout(120000);

test("a budget is opened, funded, spent down, blown, overridden and topped up", async () => {
  /* ═══ SETUP ═══════════════════════════════════════════════════════════════ */
  const company = await Acc_Company.create({
    companyName: "Spend Co", booksFromDate: new Date("2026-04-01"),
  });
  const expGroup = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const revGroup = await Acc_Group.create({
    companyId: company._id, name: "Direct Income", nature: "revenue",
  });
  const bankGroup = await Acc_Group.create({
    companyId: company._id, name: "Bank Accounts", nature: "asset",
  });
  const freight = await Acc_Ledger.create({
    companyId: company._id, name: "Freight & Forwarding", groupId: expGroup._id,
    groupName: expGroup.name, nature: "expense",
  });
  const exports_ = await Acc_Ledger.create({
    companyId: company._id, name: "Export Sales", groupId: revGroup._id,
    groupName: revGroup.name, nature: "revenue",
  });
  const bank = await Acc_Ledger.create({
    companyId: company._id, name: "HDFC Current", groupId: bankGroup._id,
    groupName: bankGroup.name, nature: "asset",
  });
  await Acc_BudgetDepartment.create({
    companyId: company._id, slug: "logistics", name: "Logistics", accessSlug: "packaging-dispatch",
  });
  const q = `?companyId=${company._id}`;

  /* ═══ 1 · FINANCE OPENS THE ROUND ═════════════════════════════════════════ */
  step(1, "finance opens a round for FY 2026-27");
  /* No window named. FY 2026-27 started in April and it is now August, so the
     window derived from the period start (1–31 March 2026) is already over —
     the round would be born closed. windowForNewRound is what stops that, and
     this asks for nothing so that it is exercised. */
  const opened = await fin(q, {
    companyId: String(company._id),
    financialYear: "2026-27",
    scope: "company",
    status: "collecting",
  });
  expect(opened.status).toBe(201);
  const budget = opened.body.budget || opened.body;
  say(`round "${budget.name}" · ${budget.status} · ${budget.financialYear}`);
  expect(budget.name).toBe("Budget FY 2026-27");
  expect(budget.status).toBe("collecting");
  say(`submissions ${budget.submissionStartDate?.slice(0, 10)} → ${budget.submissionEndDate?.slice(0, 10)} (nobody asked for these)`);
  /* The round finance just opened has to be one a department can submit into
     today. It was not, before windowForNewRound. */
  const win = { submissionStartDate: budget.submissionStartDate, submissionEndDate: budget.submissionEndDate };
  expect(require("../../services/budgetSubmissionWindow.service").isOpenForSubmissions(win)).toBe(true);

  /* ═══ 2 · THE DEPARTMENT PROPOSES ═════════════════════════════════════════ */
  step(2, "Logistics proposes freight, with its working");
  const proposed = await dept(`/${budget._id}/requests${q}`, {
    department: "Logistics",
    ledgerId: String(freight._id),
    requestedAmount: 500000,
    purpose: "Outbound freight for the export season",
    phasingMode: "even",
    workingLines: [
      { label: "Container freight", description: "Peak-season sailings",
        quantity: 25, unit: "containers", rate: 20000 },
    ],
  });
  if (proposed.status !== 201) say("REFUSED:", proposed.status, JSON.stringify(proposed.body));
  expect(proposed.status).toBe(201);
  const request = proposed.body.request;
  say(`asked ${inr(request.requestedAmount)} · ${request.workingLines.length} working row · state ${request.state}`);
  expect(request.requestedAmount).toBe(500000);
  expect(request.workingLines[0].amount).toBe(500000);

  /* ═══ 3 · FINANCE AGREES A SMALLER NUMBER ═════════════════════════════════ */
  step(3, "finance agrees Rs 4,00,000 of the Rs 5,00,000 asked");
  const agreed = await fin(`/${budget._id}/requests/${request._id}/agree${q}`, { agreedAmount: 400000 });
  expect(agreed.status).toBe(200);

  let doc = await Acc_Budget.findById(budget._id).lean();
  expect(doc.items).toHaveLength(1);
  const line = doc.items[0];
  say(`allocation line created · ${line.ledgerName} · ${inr(line.allocatedAmount)} · from request ${line.sourceRequestId}`);
  expect(line.allocatedAmount).toBe(400000);
  expect(String(line.ledgerId)).toBe(String(freight._id));

  /* A revenue target too, so the last step can prove a target is never a cap. */
  const revReq = await dept(`/${budget._id}/requests${q}`, {
    department: "Logistics", ledgerId: String(exports_._id), requestedAmount: 2000000,
    purpose: "Export revenue target", phasingMode: "even",
    workingLines: [{ label: "Confirmed orders", description: "Distributor commitments",
      quantity: 20, unit: "orders", rate: 100000 }],
  });
  expect(revReq.status).toBe(201);
  await fin(`/${budget._id}/requests/${revReq.body.request._id}/agree${q}`, { agreedAmount: 2000000 });

  /* ═══ 4 · THE ROUND GOES LIVE ═════════════════════════════════════════════ */
  step(4, "finance closes collection and activates the round");
  expect((await fin(`/${budget._id}/close-collection${q}`, {})).status).toBe(200);
  expect((await fin(`/${budget._id}`, { status: "active" }, "PUT")).status).toBe(200);
  say("status → active · the control is now in force");

  /* ═══ 5 · NOTHING SPENT YET ═══════════════════════════════════════════════ */
  step(5, "before any voucher");
  const before = await fin("/check-availability", {
    companyId: String(company._id), voucherDate: "2026-08-10",
    ledgerEntries: [{ ledgerId: String(freight._id), type: "Dr", amount: 0 }],
  });
  const r0 = before.body.results[0];
  say(`allocated ${inr(r0.allocated)} · spent ${inr(r0.actual)} · remaining ${inr(r0.remainingAfter)}`);
  expect(r0.allocated).toBe(400000);
  expect(r0.actual).toBe(0);
  expect(r0.remainingAfter).toBe(400000);

  /* ═══ 6 · SPEND, AND WATCH IT COME DOWN ═══════════════════════════════════ */
  step(6, "post three vouchers and watch the head come down");
  const spendSoFar = [];
  for (const amount of [150000, 100000, 60000]) {
    const posted = await vou("", purchase({ companyId: company._id, head: freight, bank, amount,
      extra: { autoPost: true } }));
    expect(posted.status).toBe(201);
    expect(posted.body.status).toBe("posted");

    const now = await fin("/check-availability", {
      companyId: String(company._id), voucherDate: "2026-08-10",
      ledgerEntries: [{ ledgerId: String(freight._id), type: "Dr", amount: 0 }],
    });
    const r = now.body.results[0];
    spendSoFar.push(r.actual);
    say(`posted ${inr(amount)} → spent ${inr(r.actual)} · remaining ${inr(r.remainingAfter)} · ${now.body.overallStatus}`);
  }
  /* THE QUESTION THIS SUITE EXISTS FOR. */
  expect(spendSoFar).toEqual([150000, 250000, 310000]);
  say("→ the budget decreases with every posted voucher");

  /* A DRAFT must not. Money that has not been committed is not spend. */
  const draft = await vou("", purchase({ companyId: company._id, head: freight, bank, amount: 50000 }));
  expect(draft.status).toBe(201);
  expect(draft.body.status).not.toBe("posted");
  const afterDraft = await fin("/check-availability", {
    companyId: String(company._id), voucherDate: "2026-08-10",
    ledgerEntries: [{ ledgerId: String(freight._id), type: "Dr", amount: 0 }],
  });
  say(`a Rs 50,000 DRAFT sits on the head → spent still ${inr(afterDraft.body.results[0].actual)}`);
  expect(afterDraft.body.results[0].actual).toBe(310000);

  /* ═══ 7 · THE 90% WARNING ═════════════════════════════════════════════════ */
  step(7, "the next voucher crosses 90% of the head");
  const warn = await fin("/check-availability", {
    companyId: String(company._id), voucherDate: "2026-08-10",
    ledgerEntries: [{ ledgerId: String(freight._id), type: "Dr", amount: 55000 }],
  });
  say(`Rs 55,000 → projected ${inr(warn.body.results[0].projectedActual)} of ${inr(400000)} · ${warn.body.overallStatus}`);
  expect(warn.body.overallStatus).toBe("warning_near_limit");
  expect(warn.body.requiredOverride).toBe(false);
  say("→ a warning, and it does NOT ask anybody for permission");

  /* ═══ 8 · OVER BUDGET, WITHOUT A REASON ═══════════════════════════════════ */
  step(8, "a voucher that would blow the head, with no reason given");
  const blown = await vou("", purchase({ companyId: company._id, head: freight, bank,
    amount: 120000, extra: { autoPost: true } }));
  say(`HTTP ${blown.status} · ${blown.body.code} · ${blown.body.budgetCheck.message}`);
  expect(blown.status).toBe(409);
  expect(blown.body.code).toBe("BUDGET_OVERRIDE_REQUIRED");
  expect(blown.body.budgetCheck.overallStatus).toBe("over_budget");
  expect(blown.body.budgetCheck.results[0].overBy).toBe(30000);

  /* Refused BEFORE the first save — nothing half-written left behind. */
  const postedCount = await Acc_Voucher.countDocuments({ companyId: company._id, status: "posted" });
  expect(postedCount).toBe(3);
  say("→ refused before anything was written; still 3 posted vouchers");

  /* ═══ 9 · OVER BUDGET, WITH A REASON — WHICH IS NOT AN APPROVAL ══════════
     A typed sentence used to be enough, and that was the hole: posting is the
     accounts job and everyone who does it may post directly, so the person
     spending past the budget was always also the person clearing it. Now it
     takes two people and one of them is the CEO. */
  step(9, "the accountant raises it with a reason — it is RAISED, not posted");
  /* The accountant enters the voucher. That is their job, and it is the whole
     of their authority here: they cannot decide a budget may be broken. */
  const forced = await vou("", purchase({ companyId: company._id, head: freight, bank, amount: 120000,
    extra: { autoPost: true, budgetOverrideReason: "Peak-season surcharge; final sailing." } }),
    undefined, CLERK);
  expect(forced.status).toBe(201);
  const forcedId = forced.body._id;
  say(`status "${forced.body.status}" · raised by ${forced.body.submittedByName}`);
  expect(forced.body.status).toBe("pending_approval");

  const notYet = await fin("/check-availability", {
    companyId: String(company._id), voucherDate: "2026-08-10",
    ledgerEntries: [{ ledgerId: String(freight._id), type: "Dr", amount: 0 }],
  });
  say(`the budget has not moved · spent ${inr(notYet.body.results[0].actual)}`);
  expect(notYet.body.results[0].actual).toBe(310000);
  say("→ a reason is a case, not a decision");

  step(10, "finance signs it");
  const signedByFinance = await vou(`/${forcedId}/approve`, {
    budgetOverrideReason: "Checked the contract — the surcharge is real.",
  }, undefined, APPROVER_USER);
  expect(signedByFinance.status).toBe(202);
  say(`${signedByFinance.body.escalation.message}`);
  await expect(Acc_Voucher.findById(forcedId).then((d) => d.status)).resolves.toBe("pending_approval");
  say("→ one signature is not two");

  step(11, "the CEO signs it");
  const released = await vou(`/${forcedId}/approve`, {});
  expect(released.status).toBe(200);

  const saved = await Acc_Voucher.findById(forcedId).lean();
  say(`posted · signed by ${saved.budgetOverride.signatures.map((x) => `${x.name} (${x.slot})`).join(" and ")}`);
  say(`case kept: "${saved.budgetOverride.reason}"`);
  say(`snapshot: allocated ${inr(saved.budgetOverride.results[0].allocated)} · projected ${inr(saved.budgetOverride.results[0].projectedActual)} · left ${inr(saved.budgetOverride.results[0].remainingAfter)}`);
  expect(saved.status).toBe("posted");
  expect(saved.budgetOverride.required).toBe(true);
  expect(saved.budgetOverride.signatures.map((x) => x.slot)).toEqual(["finance", "ceo"]);
  expect(saved.budgetOverride.overriddenByName).toBe("Priya Owner");
  expect(saved.budgetOverride.results[0].remainingAfter).toBe(-30000);
  say("→ two names on one overspend, against the numbers they actually saw");

  /* ═══ 10 · THE HEAD IS NOW OVERSPENT ══════════════════════════════════════ */
  step(12, "where the head stands now");
  const over = await fin("/check-availability", {
    companyId: String(company._id), voucherDate: "2026-08-10",
    ledgerEntries: [{ ledgerId: String(freight._id), type: "Dr", amount: 0 }],
  });
  say(`allocated ${inr(over.body.results[0].allocated)} · spent ${inr(over.body.results[0].actual)} · remaining ${inr(over.body.results[0].remainingAfter)}`);
  expect(over.body.results[0].actual).toBe(430000);
  expect(over.body.results[0].remainingAfter).toBe(-30000);

  const tracker = await dept(`/tracker${q}`);
  const freightHead = tracker.body.heads.find((h) => String(h.ledgerId) === String(freight._id));
  say(`the department's own tracker: approved ${inr(freightHead.approved)} · actual ${inr(freightHead.actual)} · remaining ${inr(freightHead.remaining)} · ${freightHead.utilizationPct}% used`);
  expect(freightHead.approved).toBe(400000);
  expect(freightHead.actual).toBe(430000);
  expect(freightHead.remaining).toBe(-30000);

  /* ═══ 11 · A REVENUE TARGET IS NEVER A CAP ════════════════════════════════ */
  step(13, "the same treatment on a revenue head");
  const sale = await fin("/check-availability", {
    companyId: String(company._id), voucherDate: "2026-08-10",
    ledgerEntries: [{ ledgerId: String(exports_._id), type: "Cr", amount: 9000000 }],
  });
  say(`Rs 90,00,000 booked against a Rs 20,00,000 target → ${sale.body.overallStatus} · override ${sale.body.requiredOverride}`);
  expect(sale.body.requiredOverride).toBe(false);
  say("→ beating a target is the point; it never blocks anybody");

  /* ═══ 12 · THE DEPARTMENT ASKS FOR MORE ═══════════════════════════════════ */
  step(14, "Logistics raises an adjustment to cover the overspend");
  const adj = await dept("/adjustments", {
    companyId: String(company._id),
    budgetId: String(budget._id),
    lineId: String(line._id),
    type: "supplementary",
    requestedDeltaAmount: 100000,
    reason: "Peak-season surcharge ran over the agreed freight budget.",
  });
  if (adj.status !== 201) say("REFUSED:", adj.status, JSON.stringify(adj.body));
  expect(adj.status).toBe(201);
  say(`adjustment raised · +${inr(100000)} · state ${adj.body.adjustment.state}`);

  doc = await Acc_Budget.findById(budget._id).lean();
  expect(doc.items.find((i) => String(i._id) === String(line._id)).allocatedAmount).toBe(400000);
  say("→ nothing moves until finance approves");

  /* ═══ 13 · FINANCE APPROVES THE TOP-UP ════════════════════════════════════ */
  step(15, "finance approves it — and so does the CEO");
  /* A top-up takes the same two people as an overspend, or the CEO gate is
     one hop from useless: raise a supplementary instead of overspending, have
     finance approve it alone, and the money goes out with nobody escalating. */
  const adjUrl = `/${budget._id}/adjustments/${adj.body.adjustment._id}/approve${q}`;
  const bySigner = await fin(adjUrl, {}, undefined, APPROVER_USER);
  expect(bySigner.status).toBe(202);
  say(`finance signed · waiting on ${bySigner.body.escalation.waitingOn}`);
  doc = await Acc_Budget.findById(budget._id).lean();
  expect(doc.items.find((i) => String(i._id) === String(line._id)).allocatedAmount).toBe(400000);
  say("allocation on one signature: unchanged");

  const okAdj = await fin(adjUrl, {});
  expect(okAdj.status).toBe(200);

  doc = await Acc_Budget.findById(budget._id).lean();
  const grown = doc.items.find((i) => String(i._id) === String(line._id));
  say(`allocation ${inr(400000)} → ${inr(grown.allocatedAmount)}`);
  expect(grown.allocatedAmount).toBe(500000);

  const healed = await fin("/check-availability", {
    companyId: String(company._id), voucherDate: "2026-08-10",
    ledgerEntries: [{ ledgerId: String(freight._id), type: "Dr", amount: 0 }],
  });
  say(`allocated ${inr(healed.body.results[0].allocated)} · spent ${inr(healed.body.results[0].actual)} · remaining ${inr(healed.body.results[0].remainingAfter)} · ${healed.body.overallStatus}`);
  expect(healed.body.results[0].remainingAfter).toBe(70000);
  expect(healed.body.overallStatus).toBe("ok");
  say("→ the head is back inside its budget, and the next voucher posts without an override");

  /* And it really does. */
  const after = await vou("", purchase({ companyId: company._id, head: freight, bank, amount: 40000,
    extra: { autoPost: true } }));
  expect(after.status).toBe(201);
  const afterDoc = await Acc_Voucher.findById(after.body._id).lean();
  expect(afterDoc.budgetOverride?.required).toBeFalsy();
  say(`posted ${inr(40000)} with no override · spent now ${inr(470000)} of ${inr(500000)}`);

  /* ═══ 14 · WHAT THE ROUNDS LIST SAYS ══════════════════════════════════════
     The health of the round, which its STATUS never tells you: `exceeded` is
     in the enum and nothing writes it, and nothing should — actuals move
     whenever a voucher is edited or cancelled, so a saved verdict goes stale
     unwatched. Counted on read instead, per head and never netted. */
  step(16, "how the round reads on the list");
  const list = await fin(`${q}&withTotals=true`, undefined, "GET");
  const listed = list.body.budgets.find((x) => String(x._id) === String(budget._id));
  say(`status "${listed.status}" · ${listed.totals.overrun.heads} head(s) over · ${inr(listed.totals.overrun.amount)}`);
  /* Freight is inside its number again after the top-up; Stationery never got
     one and the ₹5,000 attempt below has not been made yet. */
  expect(listed.status).toBe("active");
  expect(listed.totals.overrun).toEqual({ heads: 0, amount: 0 });

  /* Spend one head past its allocation — through the two signatures, since
     that is now the only way past one — and the list says so. The status does
     not move, because it is not the status's job. */
  const last = await vou("", purchase({ companyId: company._id, head: freight, bank, amount: 60000,
    extra: { autoPost: true, budgetOverrideReason: "Final sailing of the season." } }),
    undefined, CLERK);
  await vou(`/${last.body._id}/approve`, { budgetOverrideReason: "Agreed." }, undefined, APPROVER_USER);
  await vou(`/${last.body._id}/approve`, {});
  const after2 = await fin(`${q}&withTotals=true`, undefined, "GET");
  const blownRow = after2.body.budgets.find((x) => String(x._id) === String(budget._id));
  say(`after one more override → status "${blownRow.status}" · ${blownRow.totals.overrun.heads} head over · ${inr(blownRow.totals.overrun.amount)}`);
  expect(blownRow.status).toBe("active");
  expect(blownRow.totals.overrun).toEqual({ heads: 1, amount: 30000 });
  say("→ the list shows it; the status stays the lifecycle");

  /* And the round's own totals still net out, which is exactly why the count
     is per head rather than taken from them. */
  say(`(the round's expense totals: allocated ${inr(blownRow.totals.expense.allocated)} · actual ${inr(blownRow.totals.expense.actual)})`);

  /* Steps 9–11 above already walked the two-person path in full — the
     accountant raises, finance signs, the CEO releases — so it is not
     repeated here. */

  /* ═══ 15 · AN UNBUDGETED HEAD ═════════════════════════════════════════════ */
  step(17, "spending on a head nobody budgeted");
  const stationery = await Acc_Ledger.create({
    companyId: company._id, name: "Stationery", groupId: expGroup._id,
    groupName: expGroup.name, nature: "expense",
  });
  const unbudgeted = await vou("", purchase({ companyId: company._id, head: stationery, bank,
    amount: 5000, extra: { autoPost: true } }));
  say(`HTTP ${unbudgeted.status} · ${unbudgeted.body.code || "posted"} · ${unbudgeted.body.budgetCheck?.overallStatus || ""}`);
  expect(unbudgeted.status).toBe(409);
  expect(unbudgeted.body.budgetCheck.overallStatus).toBe("missing_budget");
  say("→ an unbudgeted head is also an override, not a silent post");

  console.log("");
});
