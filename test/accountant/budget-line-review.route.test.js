// test/accountant/budget-line-review.route.test.js
//
// THE CHUNK'S OWN VERIFICATION, OVER HTTP.
//
// The service tests prove the arithmetic. What these prove is the thing that
// actually matters to accounting: however finance argues with the working rows,
// the LEDGER still receives one budget line per head, carrying the sum of what
// survived, with a monthly shape that adds up to it.
//
// The worked example throughout is the chunk's own:
//
//     Staff Welfare                                    ₹4,20,000
//       Festival                                       ₹2,00,000   approve
//       Annual day                                     ₹1,50,000   counter → 75,000
//       Team lunch                                       ₹70,000   refuse
//                                                      ─────────
//                                                      ₹2,75,000

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

const OWNER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner", email: "priya.owner@example.com", role: "owner",
  permissions: { canEdit: true, canApprove: true, canPostDirectly: true },
};
const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

let deptSrv, finSrv, deptBase, finBase, seq = 0;
beforeAll(async () => {
  const d = express(); d.use(express.json());
  d.use("/api/budget-proposals", require("../../routes/Access/budgetProposals"));
  await new Promise((r) => { deptSrv = d.listen(0, r); });
  deptBase = `http://127.0.0.1:${deptSrv.address().port}/api/budget-proposals`;
  const f = express(); f.use(express.json());
  f.use("/api/accountant/budgets", require("../../routes/Accountant_Routes/Acc_budgets"));
  await new Promise((r) => { finSrv = f.listen(0, r); });
  finBase = `http://127.0.0.1:${finSrv.address().port}/api/accountant/budgets`;
});
afterAll(async () => {
  await new Promise((r) => deptSrv.close(r));
  await new Promise((r) => finSrv.close(r));
});

const deptToken = jwt.sign(
  { v: 2, id: new mongoose.Types.ObjectId().toString(), deptSlug: "sales", email: "head@demo.example", name: "Dept Head" },
  SECRET, { expiresIn: "1h" });

const dept = (path, body) => fetch(`${deptBase}${path}`, {
  method: body ? "POST" : "GET",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${deptToken}` },
  ...(body ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const fin = (path, body, method = "POST") => fetch(`${finBase}${path}`, {
  method,
  headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(OWNER) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function seed() {
  const company = await Acc_Company.create({ companyName: `Rows ${seq++}`, booksFromDate: new Date("2026-04-01") });
  const g = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const ledger = await Acc_Ledger.create({ companyId: company._id, name: "Staff Welfare", groupId: g._id, groupName: g.name, nature: "expense" });
  await Acc_BudgetDepartment.create({ companyId: company._id, slug: "logistics", name: "Logistics", accessSlug: "sales" });
  const budget = await Acc_Budget.create({
    name: "FY26-27 Annual", financialYear: "2026-27", period: "yearly", status: "collecting",
    startDate: FY_START, endDate: FY_END, companyId: company._id, items: [], budgetRequests: [],
  });
  return { company, budget, ledger };
}

/** The chunk's three rows, as a department would send them. */
const THREE_ROWS = [
  { label: "Festival", description: "Diwali", quantity: 1, unit: "event", rate: 200000 },
  { label: "Annual day", description: "Venue and catering", quantity: 1, unit: "event", rate: 150000 },
  { label: "Team lunch", description: "Monthly", quantity: 12, unit: "months", rate: 5000 },
];

async function propose(rows = THREE_ROWS, over = {}) {
  const s = await seed();
  const asked = rows.reduce((t, r) => t + r.quantity * r.rate, 0);
  const made = await dept(`/${s.budget._id}/requests?companyId=${s.company._id}`, {
    department: "Logistics",
    ledgerId: s.ledger._id.toString(),
    requestedAmount: Math.round(asked * 100) / 100,
    purpose: "Staff welfare for the year",
    workingLines: rows,
    ...over,
  });
  expect(made.status).toBe(201);
  return { ...s, q: `?companyId=${s.company._id}`, request: made.body.request, id: made.body.request._id };
}

const decide = (s, rowId, body) =>
  fin(`/${s.budget._id}/requests/${s.id}/lines/${rowId}/decide${s.q}`, body);
const respond = (s, rowId, body) =>
  fin(`/${s.budget._id}/requests/${s.id}/lines/${rowId}/respond${s.q}`, body);
const agree = (s, body = {}) => fin(`/${s.budget._id}/requests/${s.id}/agree${s.q}`, body);

const rowsOf = async (s) => {
  const fresh = await Acc_Budget.findById(s.budget._id).lean();
  const r = fresh.budgetRequests.find((x) => String(x._id) === String(s.id));
  return { doc: fresh, request: r, rows: r.workingLines || [] };
};
const lineOf = async (s) => {
  const fresh = await Acc_Budget.findById(s.budget._id).lean();
  return fresh.items.find((i) => String(i.sourceRequestId) === String(s.id));
};

/* ══ ROWS ARRIVE WITH AN IDENTITY ══════════════════════════════════════════ */

test("every working row can be addressed, which it could not be before", () => {
  /* `workingLines` was declared `_id: false`, so a row could only be pointed at
     by position — and position is not identity once a department reorders. */
  return propose().then(async (s) => {
    const { rows } = await rowsOf(s);
    // Ids are minted on the first decision, not on submission: nothing about a
    // proposal changed.
    expect(rows).toHaveLength(3);
    const first = await decide(s, "r1", { decision: "approved" });
    expect(first.status).toBe(200);
    const after = await rowsOf(s);
    expect(after.rows.map((r) => r.rowId)).toEqual(["r1", "r2", "r3"]);
    expect(new Set(after.rows.map((r) => r.rowId)).size).toBe(3);
  });
});

/* ══ THE CHUNK'S THREE-ROW CASE ════════════════════════════════════════════ */

test("approve one, counter one, refuse one — the head becomes their sum", async () => {
  const s = await propose();
  expect(s.request.requestedAmount).toBe(410000);

  expect((await decide(s, "r1", { decision: "approved" })).status).toBe(200);
  expect((await decide(s, "r2", {
    decision: "countered", amount: 75000, financeNote: "Half — hall only, no catering.",
  })).status).toBe(200);
  const refused = await decide(s, "r3", {
    decision: "refused", financeNote: "Not a budget line this year.",
  });
  expect(refused.status).toBe(200);

  expect(refused.body.rollUp.financeAmount).toBe(275000);
  expect(refused.body.rollUp.asked).toBe(410000);
  // A countered row is unanswered, so the head is waiting on the department.
  expect(refused.body.headStatus).toBe("needs_department_response");
});

test("the head cannot become an allocation while a countered row is unanswered", async () => {
  // The rule that protects the ledger: approving here would write finance's own
  // figure into the budget and call it agreement.
  const s = await propose();
  await decide(s, "r1", { decision: "approved" });
  await decide(s, "r2", { decision: "countered", amount: 75000, financeNote: "Half." });

  const no = await agree(s);
  expect(no.status).toBe(409);
  expect(no.body.code).toBe("ROWS_AWAITING_DEPARTMENT");
  expect(no.body.message).toMatch(/Annual day/);
  expect(await lineOf(s)).toBeUndefined();
});

test("once the department accepts, the allocation is the sum of what survived", async () => {
  const s = await propose();
  await decide(s, "r1", { decision: "approved" });
  await decide(s, "r2", { decision: "countered", amount: 75000, financeNote: "Half." });
  await decide(s, "r3", { decision: "refused", financeNote: "No." });

  const answered = await respond(s, "r2", { accepted: true });
  expect(answered.status).toBe(200);
  expect(answered.body.headStatus).toBe("partially_approved");

  const done = await agree(s);
  expect(done.status).toBe(200);

  /* ── THE POINT OF THE WHOLE CHUNK ──────────────────────────────────────
     Three row decisions, ONE accounting line, at the figure they add up to. */
  const fresh = await Acc_Budget.findById(s.budget._id).lean();
  const lines = fresh.items.filter((i) => String(i.sourceRequestId) === String(s.id));
  expect(lines).toHaveLength(1);
  expect(lines[0].allocatedAmount).toBe(275000);
  expect(lines[0].ledgerName).toBe("Staff Welfare");
});

test("a refused row contributes nothing to the allocation", async () => {
  const s = await propose();
  await decide(s, "r1", { decision: "approved" });
  await decide(s, "r2", { decision: "approved" });
  await decide(s, "r3", { decision: "refused", financeNote: "Not this year." });
  expect((await agree(s)).status).toBe(200);
  expect((await lineOf(s)).allocatedAmount).toBe(350000);
});

/* ══ HEAD-LEVEL ACTIONS REACH THE ROWS ═════════════════════════════════════ */

test("approving the head approves every row still unanswered", async () => {
  const s = await propose();
  expect((await agree(s)).status).toBe(200);
  const { rows } = await rowsOf(s);
  expect(rows.every((r) => r.decision === "approved")).toBe(true);
  expect((await lineOf(s)).allocatedAmount).toBe(410000);
});

test("approving the head does NOT discard the row argument already had", async () => {
  // Otherwise the head button is a silent way to undo every decision on screen.
  const s = await propose();
  await decide(s, "r3", { decision: "refused", financeNote: "No lunches." });
  expect((await agree(s)).status).toBe(200);

  const { rows } = await rowsOf(s);
  expect(rows.find((r) => r.rowId === "r3").decision).toBe("refused");
  expect((await lineOf(s)).allocatedAmount).toBe(350000);
});

test("refusing the head refuses every row under it", async () => {
  // A row reading "approved" beneath a refused head is a promise nobody made.
  const s = await propose();
  await decide(s, "r1", { decision: "approved" });
  const no = await fin(`/${s.budget._id}/requests/${s.id}/reject${s.q}`, {
    financeNote: "Not funding staff welfare separately this year.",
  });
  expect(no.status).toBe(200);

  const { rows, request } = await rowsOf(s);
  expect(rows.every((r) => r.decision === "refused")).toBe(true);
  expect(rows.every((r) => r.approvedAmount === 0)).toBe(true);
  expect(request.state).toBe("rejected");
  // The refusal now records who made it — `actorOf` returns a string, and
  // reaching for `.email` on it was always undefined.
  expect(request.decidedBy).toBe(OWNER.email);
  expect(await lineOf(s)).toBeUndefined();
});

test("countering the head restarts the row argument rather than sitting beside it", async () => {
  /* Two standing figures cannot both be the one the department answers, and
     "the head equals the sum of its rows" is what the phasing and the
     allocation both rely on. */
  const s = await propose();
  await decide(s, "r1", { decision: "approved" });
  await decide(s, "r3", { decision: "refused", financeNote: "No." });

  const countered = await fin(`/${s.budget._id}/requests/${s.id}/counter${s.q}`, {
    counterAmount: 300000, financeNote: "Take the whole head at 3L and re-plan it.",
  });
  expect(countered.status).toBe(200);
  expect(countered.body.rowDecisionsCleared).toBe(true);

  const { rows } = await rowsOf(s);
  expect(rows.every((r) => !r.decision)).toBe(true);

  // And approving now takes the head's figure, not the stale row sum.
  expect((await agree(s)).status).toBe(200);
  expect((await lineOf(s)).allocatedAmount).toBe(300000);
});

/* ══ VALIDATION ════════════════════════════════════════════════════════════ */

test("countering or refusing a row demands a reason", async () => {
  const s = await propose();
  const cut = await decide(s, "r1", { decision: "countered", amount: 100000 });
  expect(cut.status).toBe(400);
  expect(cut.body.code).toBe("ROW_NOTE_REQUIRED");

  const no = await decide(s, "r1", { decision: "refused" });
  expect(no.status).toBe(400);
  expect(no.body.code).toBe("ROW_NOTE_REQUIRED");

  // Approving needs none — the row already says what was agreed.
  expect((await decide(s, "r1", { decision: "approved" })).status).toBe(200);
});

test("a counter at the amount asked is refused as not being a counter", async () => {
  const s = await propose();
  const same = await decide(s, "r1", { decision: "countered", amount: 200000, financeNote: "Fine." });
  expect(same.status).toBe(400);
  expect(same.body.code).toBe("ROW_COUNTER_UNCHANGED");
});

test("a negative row amount is refused", async () => {
  const s = await propose();
  const bad = await decide(s, "r1", { decision: "countered", amount: -5, financeNote: "x" });
  expect(bad.status).toBe(400);
  expect(bad.body.code).toBe("ROW_AMOUNT_INVALID");
});

test("a row that is not on this request is a 404, not a silent no-op", async () => {
  const s = await propose();
  const gone = await decide(s, "r99", { decision: "approved" });
  expect(gone.status).toBe(404);
  expect(gone.body.code).toBe("ROW_NOT_FOUND");
});

test("an agreed head cannot have its rows re-decided underneath it", async () => {
  // The head is already an allocation somebody may be spending against.
  const s = await propose();
  await agree(s);
  const late = await decide(s, "r1", { decision: "refused", financeNote: "Changed my mind." });
  expect(late.status).toBe(409);
  expect(late.body.code).toBe("REQUEST_ALREADY_AGREED");
});

test("answering a row finance never countered is refused", async () => {
  const s = await propose();
  await decide(s, "r1", { decision: "approved" });
  const nothing = await respond(s, "r1", { accepted: true });
  expect(nothing.status).toBe(400);
  expect(nothing.body.code).toBe("ROW_NOT_COUNTERED");
});

test("re-countering a row clears the acceptance of the previous counter", async () => {
  // Otherwise an acceptance of the OLD figure makes the new one look answered
  // and the head walks straight into an allocation.
  const s = await propose();
  await decide(s, "r2", { decision: "countered", amount: 75000, financeNote: "Half." });
  await respond(s, "r2", { accepted: true });
  await decide(s, "r2", { decision: "countered", amount: 40000, financeNote: "Less again." });

  const no = await agree(s);
  expect(no.status).toBe(409);
  expect(no.body.code).toBe("ROWS_AWAITING_DEPARTMENT");
});

/* ══ A HEAD WITH NO BREAKDOWN IS UNTOUCHED ═════════════════════════════════ */

test("a head with no working rows still approves exactly as it always did", async () => {
  const s0 = await seed();
  const made = await dept(`/${s0.budget._id}/requests?companyId=${s0.company._id}`, {
    department: "Logistics", ledgerId: s0.ledger._id.toString(),
    requestedAmount: 90000, purpose: "Sundries, no breakdown",
  });
  expect(made.status).toBe(201);
  const s = { ...s0, q: `?companyId=${s0.company._id}`, id: made.body.request._id };

  expect((await agree(s)).status).toBe(200);
  expect((await lineOf(s)).allocatedAmount).toBe(90000);
});

test("row endpoints say so plainly when there is nothing to decide", async () => {
  const s0 = await seed();
  const made = await dept(`/${s0.budget._id}/requests?companyId=${s0.company._id}`, {
    department: "Logistics", ledgerId: s0.ledger._id.toString(),
    requestedAmount: 90000, purpose: "Sundries",
  });
  const s = { ...s0, q: `?companyId=${s0.company._id}`, id: made.body.request._id };
  const none = await decide(s, "r1", { decision: "approved" });
  expect(none.status).toBe(400);
  expect(none.body.code).toBe("NO_WORKING_ROWS");
});

/* ══ ONE ROW, WHICH IS THE DEGENERATE CASE ═════════════════════════════════ */

test("one head, one row — the row decision is the head decision", async () => {
  const s = await propose([{ label: "Annual offsite", quantity: 1, unit: "event", rate: 250000 }]);
  const cut = await decide(s, "r1", { decision: "countered", amount: 150000, financeNote: "Domestic venue." });
  expect(cut.status).toBe(200);
  expect(cut.body.rollUp.financeAmount).toBe(150000);

  await respond(s, "r1", { accepted: true });
  expect((await agree(s)).status).toBe(200);
  expect((await lineOf(s)).allocatedAmount).toBe(150000);
});

/* ══ THE SHAPE ALWAYS MATCHES THE MONEY ════════════════════════════════════ */

test("a head split is scaled to the final amount, keeping the shape the department meant", async () => {
  /* Straight-lining a cut head would move money into months the department had
     explicitly kept empty. */
  const s = await propose(THREE_ROWS, {
    phasingMode: "custom_monthly",
    monthlyPhasing: [
      { month: "2026-10", amount: 307500 },
      { month: "2027-01", amount: 102500 },
    ],
  });
  await decide(s, "r1", { decision: "approved" });
  await decide(s, "r2", { decision: "approved" });
  await decide(s, "r3", { decision: "refused", financeNote: "No lunches." });
  expect((await agree(s)).status).toBe(200);

  const line = await lineOf(s);
  expect(line.allocatedAmount).toBe(350000);
  expect(line.phasingMode).toBe("custom_monthly");
  // 3:1, held — and summing to the line, not to the original ask.
  const sum = line.monthlyPhasing.reduce((t, m) => t + m.amount, 0);
  expect(Math.abs(sum - 350000)).toBeLessThan(1);
  expect(line.monthlyPhasing.map((m) => m.month)).toEqual(["2026-10", "2027-01"]);
  expect(line.monthlyPhasing[0].amount).toBe(262500);
});

test("the months never disagree with the total, whatever the rows did", async () => {
  const s = await propose(THREE_ROWS, {
    phasingMode: "custom_monthly",
    monthlyPhasing: [
      { month: "2026-10", amount: 150000 },
      { month: "2026-11", amount: 150000 },
      { month: "2026-12", amount: 110000 },
    ],
  });
  await decide(s, "r1", { decision: "approved" });
  await decide(s, "r2", { decision: "countered", amount: 75000, financeNote: "Half." });
  await decide(s, "r3", { decision: "refused", financeNote: "No." });
  await respond(s, "r2", { accepted: true });
  expect((await agree(s)).status).toBe(200);

  const line = await lineOf(s);
  expect(line.allocatedAmount).toBe(275000);
  const sum = line.monthlyPhasing.reduce((t, m) => t + m.amount, 0);
  expect(Math.abs(sum - 275000)).toBeLessThan(1);
});

test("an untouched head keeps the department's own split exactly", async () => {
  // Nothing about the existing path changes when no row is decided.
  const s = await propose(THREE_ROWS, {
    phasingMode: "custom_monthly",
    monthlyPhasing: [
      { month: "2026-10", amount: 307500 },
      { month: "2027-01", amount: 102500 },
    ],
  });
  expect((await agree(s)).status).toBe(200);
  const line = await lineOf(s);
  expect(line.allocatedAmount).toBe(410000);
  expect(line.monthlyPhasing.map((m) => [m.month, m.amount])).toEqual([
    ["2026-10", 307500], ["2027-01", 102500],
  ]);
});
