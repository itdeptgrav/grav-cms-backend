// THE WHOLE PIPELINE, IN ONE WALK.
//
// The other budget tests each prove one hop. This one is the journey a
// department head and a finance reviewer actually make, in order, against both
// routers and one real database — because the interesting failures live in the
// seams, not in the hops: a request that allocates twice, phasing that survives
// the ask but not the agreement, a line the department can no longer see once
// finance has touched it.
//
// It narrates as it goes. Run it alone to read the pipeline:
//   npx jest test/accountant/budget-end-to-end --silent=false
//
// ── WHY BOTH ROUTERS, MOUNTED SEPARATELY ────────────────────────────────────
// They are two apps in production: the department reaches
// /api/budget-proposals with a CMS department token, finance reaches
// /api/accountant/budgets with an accountant session. Mounting them on one
// server would let a mistake in scoping pass unnoticed, since every request
// would carry both identities.
"use strict";
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { SECRET } = require("../../config/jwt");
const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_BudgetDepartment } = require("../../models/Accountant_model/Acc_BudgetDepartment");

jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
}));

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

/* Finance. A different human from the requester on purpose — the four-eyes
   rule refuses a reviewer who is also the submitter, and a shared identity
   would hide that. */
const FINANCE = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner",
  email: "priya.owner@example.com",
  role: "owner",
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

const HEAD_EMAIL = "logistics.head@demo.example";

let deptSrv, finSrv, deptBase, finBase;

beforeAll(async () => {
  const d = express();
  d.use(express.json());
  d.use("/api/budget-proposals", require("../../routes/Access/budgetProposals"));
  await new Promise((r) => { deptSrv = d.listen(0, r); });
  deptBase = `http://127.0.0.1:${deptSrv.address().port}/api/budget-proposals`;

  const f = express();
  f.use(express.json());
  f.use("/api/accountant/budgets", require("../../routes/Accountant_Routes/Acc_budgets"));
  await new Promise((r) => { finSrv = f.listen(0, r); });
  finBase = `http://127.0.0.1:${finSrv.address().port}/api/accountant/budgets`;
});

afterAll(async () => {
  await new Promise((r) => deptSrv.close(r));
  await new Promise((r) => finSrv.close(r));
});

/* The department head's session. `deptSlug` is the PORTAL they signed into;
   it is not a budget department, and the only thing that turns it into one is
   the `accessSlug` on the registry row seeded below. */
const deptToken = jwt.sign(
  { v: 2, id: new mongoose.Types.ObjectId().toString(), deptSlug: "packaging-dispatch", email: HEAD_EMAIL, name: "Logistics Head" },
  SECRET,
  { expiresIn: "1h" },
);

const dept = (path, body, method) =>
  fetch(`${deptBase}${path}`, {
    method: method || (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${deptToken}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const fin = (path, body, userOrMethod, method) => {
  /* Third argument doubles as "who" — a second signatory is needed now that
     raising an allocation takes two people. */
  const user = typeof userOrMethod === "object" && userOrMethod ? userOrMethod : FINANCE;
  const verb = typeof userOrMethod === "string" ? userOrMethod : method;
  return fetch(`${finBase}${path}`, {
    method: verb || "POST",
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(user) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));
};

const inr = (n) => "Rs " + Number(n || 0).toLocaleString("en-IN");
const step = (n, what) => console.log(`\n── ${n} ─ ${what}`);
const say = (...a) => console.log("   ", ...a);

test("department proposes, finance decides, department sees it — end to end", async () => {
  /* ═══ SETUP ═══════════════════════════════════════════════════════════════
     A company, two expense heads, and — the load-bearing row — a budget
     department wired to the portal the head above signed into. */
  const company = await Acc_Company.create({ companyName: "E2E Co", booksFromDate: new Date("2026-04-01") });
  const group = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const freight = await Acc_Ledger.create({ companyId: company._id, name: "Freight & Forwarding", groupId: group._id, groupName: group.name, nature: "expense" });
  const repairs = await Acc_Ledger.create({ companyId: company._id, name: "Repairs & Maintenance", groupId: group._id, groupName: group.name, nature: "expense" });
  await Acc_BudgetDepartment.create({
    companyId: company._id, slug: "logistics", name: "Logistics", accessSlug: "packaging-dispatch",
  });
  const budget = await Acc_Budget.create({
    name: "FY26-27 Annual", financialYear: "2026-27", period: "yearly", status: "collecting",
    startDate: FY_START, endDate: FY_END, companyId: company._id, items: [], budgetRequests: [],
  });
  const q = `?companyId=${company._id}`;

  /* ═══ 1 · THE DEPARTMENT CAN SEE ITS APP ══════════════════════════════════ */
  step(1, "department opens the Budget app");
  const ctx = await dept("/context");
  expect(ctx.status).toBe(200);
  expect(ctx.body.companies).toHaveLength(1);
  say(`portal "${ctx.body.portal}" resolves to`, ctx.body.companies[0].departments.map((d) => d.name).join(", "),
      `· viewAs: ${ctx.body.viewAs}`);

  const cycles = await dept(`/open-cycles${q}`);
  expect(cycles.body.cycles).toHaveLength(1);
  say("open cycle:", cycles.body.cycles[0].name, `(${cycles.body.cycles[0].status})`);

  /* ═══ 2 · PROPOSING ═══════════════════════════════════════════════════════
     Two lines in one call: one against a real head, one asking for a head the
     chart of accounts does not have. The bulk endpoint validates both before
     writing either. */
  step(2, "department proposes two lines");
  const proposed = await dept(`/${budget._id}/requests/bulk${q}`, {
    companyId: company._id.toString(),
    lines: [
      {
        department: "Logistics", ledgerId: freight._id.toString(), requestedAmount: 450000,
        purpose: "Diwali peak carrier surcharge", priority: "high",
        phasingMode: "custom_monthly",
        monthlyPhasing: [
          { month: "2026-09", amount: 60000 }, { month: "2026-10", amount: 150000 },
          { month: "2026-11", amount: 150000 }, { month: "2026-12", amount: 90000 },
        ],
        workingLines: [
          { label: "Peak container surcharge", quantity: 30, unit: "container", rate: 12000, multiplier: 1 },
          { label: "Expedited last-mile", quantity: 900, unit: "shipment", rate: 100, multiplier: 1 },
        ],
      },
      {
        department: "Logistics", requestedAmount: 640000, purpose: "Round-the-clock site guarding",
        requestedHead: { name: "Site Security", nature: "expense", reason: "Nothing existing fits." },
      },
    ],
  });
  expect(proposed.status).toBe(201);
  const [freightReq, headReq] = proposed.body.requests;
  say("line 1:", freightReq.ledgerName, inr(freightReq.requestedAmount),
      `· split over ${freightReq.monthlyPhasing.length} months · ${freightReq.workingLines.length} working rows`);
  say("line 2: asks for a head —", `"${headReq.requestedHead.name}"`, inr(headReq.requestedAmount),
      `· ledgerId: ${headReq.ledgerId || "none"}`);

  /* The server recomputes every working row rather than trusting the client's
     arithmetic: 30 x 12000 + 900 x 100. */
  expect(freightReq.workingLines.map((l) => l.amount)).toEqual([360000, 90000]);
  expect(headReq.ledgerId).toBeFalsy();

  /* ═══ 3 · THE SAME DOCUMENT, SEEN FROM FINANCE ════════════════════════════ */
  step(3, "finance opens the review queue");
  const queue = await fin(`/${budget._id}/requests${q}`, undefined, "GET");
  expect(queue.status).toBe(200);
  expect(queue.body.requests).toHaveLength(2);
  say("queue holds", queue.body.requests.length, "lines from",
      [...new Set(queue.body.requests.map((r) => r.department))].join(", "));

  /* ═══ 4 · A LINE WITH NO LEDGER CANNOT BE FUNDED ══════════════════════════ */
  step(4, "finance tries to agree the head request as-is");
  const premature = await fin(`/${budget._id}/requests/${headReq._id}/agree${q}`, { agreedAmount: 640000 });
  expect(premature.status).toBe(409);
  expect(premature.body.code).toBe("HEAD_UNRESOLVED");
  say("refused:", premature.body.code, "—", premature.body.message);

  step(5, "finance maps the requested head to a real ledger");
  const mapped = await fin(`/${budget._id}/requests/${headReq._id}/resolve-head${q}`, {
    action: "map", ledgerId: repairs._id.toString(), financeNote: "Guarding belongs under Repairs.",
  });
  expect(mapped.status).toBe(200);
  say("mapped to", repairs.name, "— the request now carries a real ledgerId");

  /* ═══ 6 · A COUNTER MOVES NO MONEY ════════════════════════════════════════ */
  step(6, "finance counters the freight line");
  const countered = await fin(`/${budget._id}/requests/${freightReq._id}/counter${q}`, {
    counterAmount: 300000, financeNote: "Half now; revisit after the Q3 review.",
  });
  expect(countered.status).toBe(200);
  let doc = await Acc_Budget.findById(budget._id).lean();
  expect(doc.items).toHaveLength(0);
  say("countered at", inr(300000), "· allocation lines created:", doc.items.length);

  /* ═══ 7 · IT REACHES THE DEPARTMENT AS SOMETHING TO DO ════════════════════ */
  step(7, "department's action centre");
  const ac = await dept(`/action-centre${q}`);
  expect(ac.status).toBe(200);
  expect(ac.body.counts.needsYourAnswer).toBeGreaterThan(0);
  for (const a of ac.body.needsYourAnswer) say("needs your answer:", a.title, "—", a.description);

  /* ═══ 8 · THE DEPARTMENT ANSWERS ══════════════════════════════════════════ */
  step(8, "department accepts the counter by revising its own line");
  /* The derivation has to come down with the amount. Sending 3L against rows
     that still total 4.5L is refused — the stored breakdown would no longer
     derive the number standing next to it. Same rule as the split. */
  const revised = await dept(`/${budget._id}/requests/${freightReq._id}${q}`, {
    requestedAmount: 300000, purpose: "Diwali peak carrier surcharge (trimmed)",
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2026-10", amount: 150000 }, { month: "2026-11", amount: 150000 }],
    workingLines: [
      { label: "Peak container surcharge", quantity: 25, unit: "container", rate: 12000, multiplier: 1 },
    ],
  }, "PUT");
  if (revised.status !== 200) say("REFUSED:", revised.body?.code, revised.body?.message);
  expect(revised.status).toBe(200);
  expect(revised.body.request.state).toBe("submitted");
  say("back to", revised.body.request.state, "at", inr(revised.body.request.requestedAmount));

  /* ═══ 9 · AGREEING IS THE ONLY THING THAT ALLOCATES ═══════════════════════ */
  step(9, "finance agrees both lines");
  const a1 = await fin(`/${budget._id}/requests/${freightReq._id}/agree${q}`, { agreedAmount: 300000 });
  const a2 = await fin(`/${budget._id}/requests/${headReq._id}/agree${q}`, { agreedAmount: 640000 });
  expect(a1.status).toBe(200);
  expect(a2.status).toBe(200);

  doc = await Acc_Budget.findById(budget._id).lean();
  expect(doc.items).toHaveLength(2);
  for (const i of doc.items) {
    say("allocated:", i.ledgerName, inr(i.allocatedAmount),
        `· phasing ${i.phasingMode}`, `· traced to request ${String(i.sourceRequestId).slice(-6)}`);
    expect(i.sourceRequestId).toBeTruthy();
  }
  /* The department's split survived the agreement rather than being flattened. */
  const freightLine = doc.items.find((i) => String(i.ledgerId) === String(freight._id));
  expect(freightLine.phasingMode).toBe("custom_monthly");
  expect(freightLine.monthlyPhasing.reduce((s, m) => s + m.amount, 0)).toBe(300000);

  /* ═══ 10 · AGREED IS NOT YET IN FORCE ═════════════════════════════════════
     The lines exist on the document, but the cycle is still `collecting`. The
     department tracker reads only budgets that are in force — active, closed
     or exceeded — so its approved figure is still nothing.

     This is the seam worth knowing about: finance can agree and allocate
     during collection, and until the cycle is put into force the department's
     "approved budget" stays empty while its proposal record already says
     "Approved". Both are true; they answer different questions. */
  step(10, "department's tracker, cycle still collecting");
  const early = await dept(`/tracker${q}`);
  expect(early.status).toBe(200);
  expect(early.body.totals).toBeNull();
  say("allocation lines on the document:", doc.items.length, "· tracker totals:", early.body.totals);

  /* The contract the department screen uses to EXPLAIN that gap rather than
     render an empty panel: every request row carries the state of the round
     it sits in, so "approved, but not live yet" is derivable client-side with
     no extra endpoint. If this field ever stops being sent, the department
     silently goes back to seeing an approval it cannot find. */
  const mineNow = await dept(`/my-requests${q}`);
  const agreedRows = mineNow.body.requests.filter((r) => r.state === "agreed");
  expect(agreedRows).toHaveLength(2);
  for (const r of agreedRows) expect(r.budgetStatus).toBe("collecting");
  say("agreed rows carry budgetStatus:", [...new Set(agreedRows.map((r) => r.budgetStatus))].join(", "),
      "— so the screen can say \"approved, starts when finance activates\"");

  step(11, "finance closes collection and puts the cycle in force");
  const closed = await fin(`/${budget._id}/close-collection${q}`, {});
  expect(closed.status).toBe(200);
  say("status now:", closed.body.status);
  const live = await fin(`/${budget._id}`, { status: "active" }, "PUT");
  expect(live.status).toBe(200);
  say("status now: active");

  step(12, "department's tracker, cycle in force");
  const tracker = await dept(`/tracker${q}`);
  expect(tracker.status).toBe(200);
  expect(tracker.body.totals.expense.approved).toBe(940000);
  say("approved expense budget:", inr(tracker.body.totals.expense.approved),
      "across", tracker.body.totals.expense.count, "heads");

  /* ═══ 11 · A SECOND LINE ON THE SAME HEAD IS REFUSED ══════════════════════ */
  step(13, "department tries to propose the same head twice");
  const dupe = await dept(`/${budget._id}/requests${q}`, {
    department: "Logistics", ledgerId: freight._id.toString(), requestedAmount: 100000, purpose: "again",
  });
  expect(dupe.status).toBe(409);
  say("refused:", dupe.body.code, "—", dupe.body.message);

  /* ═══ 12 · ASKING FOR MORE ON AN APPROVED LINE ═══════════════════════════ */
  step(14, "department asks for a supplementary");
  const adj = await dept("/adjustments", {
    companyId: company._id.toString(), budgetId: budget._id.toString(),
    lineId: String(freightLine._id), type: "supplementary",
    requestedDeltaAmount: 50000, reason: "Carrier raised the surcharge again.",
  });
  expect(adj.status).toBe(201);
  say("asked for", inr(50000), "more ·", inr(adj.body.adjustment.currentAllocatedAmount),
      "->", inr(adj.body.adjustment.requestedNewAmount), `· state ${adj.body.adjustment.state}`);

  doc = await Acc_Budget.findById(budget._id).lean();
  expect(doc.items.find((i) => String(i._id) === String(freightLine._id)).allocatedAmount).toBe(300000);
  say("allocation while it waits:", inr(300000), "— unchanged");

  step(15, "finance approves the supplementary — and so does the CEO");
  /* Raising an allocation takes the same two people as spending past one.
     Otherwise the CEO gate on overspending is one hop from useless: raise a
     supplementary instead, have finance approve it alone, and the same money
     goes out inside budget with nobody escalating anything. */
  const url = `/${budget._id}/adjustments/${adj.body.adjustment._id}/approve${q}`;
  const byFinance = await fin(url, {}, APPROVER_USER);
  expect(byFinance.status).toBe(202);
  say("finance signed · waiting on", byFinance.body.escalation.waitingOn);
  doc = await Acc_Budget.findById(budget._id).lean();
  expect(doc.items.find((i) => String(i._id) === String(freightLine._id)).allocatedAmount).toBe(300000);
  say("allocation on one signature:", inr(300000), "— still unchanged");

  const approved = await fin(url, {});
  expect(approved.status).toBe(200);
  doc = await Acc_Budget.findById(budget._id).lean();
  const grown = doc.items.find((i) => String(i._id) === String(freightLine._id));
  expect(grown.allocatedAmount).toBe(350000);
  say("allocation now:", inr(grown.allocatedAmount));

  /* ═══ 14 · MOVING BUDGET BETWEEN TWO OWN LINES ═══════════════════════════ */
  step(16, "department asks to move budget between its own lines");
  const securityLine = doc.items.find((i) => String(i.ledgerId) === String(repairs._id));
  const totalBefore = doc.items.reduce((s, i) => s + i.allocatedAmount, 0);
  const trf = await dept("/transfers", {
    companyId: company._id.toString(), budgetId: budget._id.toString(),
    fromLineId: String(securityLine._id), toLineId: String(grown._id),
    amount: 40000, reason: "Guarding starts a month late.",
  });
  expect(trf.status).toBe(201);
  say("asked to move", inr(40000), securityLine.ledgerName, "->", grown.ledgerName,
      `· state ${trf.body.transfer.state}`);

  step(17, "finance approves the transfer");
  const moved = await fin(`/${budget._id}/transfers/${trf.body.transfer._id}/approve${q}`, {});
  expect(moved.status).toBe(200);
  doc = await Acc_Budget.findById(budget._id).lean();
  const totalAfter = doc.items.reduce((s, i) => s + i.allocatedAmount, 0);
  for (const i of doc.items) say("after:", i.ledgerName, inr(i.allocatedAmount));
  /* The whole point of a transfer: the sides move, the envelope does not. */
  expect(totalAfter).toBe(totalBefore);
  say("total allocated:", inr(totalBefore), "->", inr(totalAfter), "— unchanged");

  /* ═══ 16 · AND IT ALL READS BACK ON THE DEPARTMENT SIDE ═══════════════════ */
  step(18, "department's final view");
  const finalTracker = await dept(`/tracker${q}`);
  expect(finalTracker.body.totals.expense.approved).toBe(990000);
  const mine = await dept(`/my-requests${q}`);
  for (const r of mine.body.requests) {
    say("request:", (r.ledgerName || r.requestedHead?.name), "·", r.state, "·", inr(r.agreedAmount ?? r.requestedAmount));
  }
  say("approved expense budget:", inr(finalTracker.body.totals.expense.approved));
});
