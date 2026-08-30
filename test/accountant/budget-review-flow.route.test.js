// The chunk's own verification, as a test: a department proposal with working
// rows and a custom split, agreed by finance, then countered — checking the
// allocation line each time.
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

/* POST by default — every finance action in this suite is one. `method` is
   accepted so the draft tests can also READ the queue back. */
const fin = (path, body, method = "POST") => fetch(`${finBase}${path}`, {
  method,
  headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(OWNER) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/**
 * Settle on a figure other than the one asked for.
 *
 * Two calls, because they are two decisions. Approving agrees what is on the
 * table unedited; naming a different number is a COUNTER, which puts finance's
 * figure in front of the department before it becomes their budget. Agreeing
 * at a figure nobody had been shown was one click, and left the record unable
 * to tell a department that proposed 3L from one that was cut to it.
 */
async function counterThenAgree(path, query, amount, body = {}) {
  const c = await fin(`${path}/counter${query}`, { counterAmount: amount, ...body });
  expect(c.status).toBe(200);
  return fin(`${path}/agree${query}`, {});
}

async function seed() {
  const company = await Acc_Company.create({ companyName: `Flow ${seq++}`, booksFromDate: new Date("2026-04-01") });
  const g = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const ledger = await Acc_Ledger.create({ companyId: company._id, name: "Software Subscriptions", groupId: g._id, groupName: g.name, nature: "expense" });
  await Acc_BudgetDepartment.create({ companyId: company._id, slug: "logistics", name: "Logistics", accessSlug: "sales" });
  const budget = await Acc_Budget.create({
    name: "FY26-27 Annual", financialYear: "2026-27", period: "yearly", status: "collecting",
    startDate: FY_START, endDate: FY_END, companyId: company._id, items: [], budgetRequests: [],
  });
  return { company, budget, ledger };
}

const SUBS = [
  { label: "Claude Team", quantity: 5, unit: "users", rate: 6000, multiplier: 12, multiplierUnit: "months" },
  { label: "Codex usage", quantity: 1, unit: "account", rate: 20000, multiplier: 12, multiplierUnit: "months" },
];

async function propose(budget, company) {
  const { status, body } = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: company && undefined, requestedAmount: 600000,
    purpose: "Team tooling", workingLines: SUBS,
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2026-09", amount: 200000 }, { month: "2026-10", amount: 400000 }],
  });
  return { status, body };
}

test("propose with working + custom split, finance agrees keeping both", async () => {
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 600000,
    purpose: "Team tooling", workingLines: SUBS,
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2026-09", amount: 200000 }, { month: "2026-10", amount: 400000 }],
  });
  expect(made.status).toBe(201);
  const id = made.body.request._id;

  // the review page sends only an amount + note when "keep theirs" is chosen
  const agreed = await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, {
    agreedAmount: 600000, financeNote: "Approved as proposed.",
  });
  expect(agreed.status).toBe(200);

  const fresh = await Acc_Budget.findById(budget._id).lean();
  const lines = fresh.items.filter((i) => String(i.sourceRequestId) === String(id));
  expect(lines).toHaveLength(1);
  expect(lines[0].allocatedAmount).toBe(600000);
  expect(lines[0].phasingMode).toBe("custom_monthly");
  expect(lines[0].monthlyPhasing.map((m) => [m.month, m.amount])).toEqual([
    ["2026-09", 200000], ["2026-10", 400000],
  ]);
});

test("agreeing twice does not duplicate the allocation", async () => {
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 600000,
    purpose: "Team tooling", workingLines: SUBS,
  });
  const id = made.body.request._id;
  await counterThenAgree(`/${budget._id}/requests/${id}`, `?companyId=${company._id}`, 600000);
  await counterThenAgree(`/${budget._id}/requests/${id}`, `?companyId=${company._id}`, 500000);
  const fresh = await Acc_Budget.findById(budget._id).lean();
  const lines = fresh.items.filter((i) => String(i.sourceRequestId) === String(id));
  expect(lines).toHaveLength(1);
  expect(lines[0].allocatedAmount).toBe(500000);
});

/* ══ APPROVING IS NOT EDITING ═══════════════════════════════════════════════
   Finance could once agree at a different figure, or on a different monthly
   shape, in the same click that said yes. The department found out afterwards.
   Both are now the same act — a COUNTER — which puts the changed figure in
   front of the department before it becomes their budget. `agree` means, and
   only means, "as submitted". */

/* ══ THE THREE WAYS A COUNTER CAN CHANGE THE SPREAD ═════════════════════════
 * The review page used to offer "Keep what they proposed" inside the Counter
 * tab, which is the one thing a counter cannot be — countering is changing
 * something, and an option that changed nothing made the tab a second Approve.
 * Every option there is now an explicit change, and these are the three shapes
 * the server has to accept from it.
 * ═════════════════════════════════════════════════════════════════════════ */

test("counter on their own pattern, scaled to the counter amount", async () => {
  /* The page re-proportions the department's split and sends it explicitly.
     What matters here is that the server stores it and that agreeing puts it
     on the line — a festival quarter stays a festival quarter after a cut. */
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 600000,
    purpose: "Team tooling",
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2026-09", amount: 450000 }, { month: "2026-10", amount: 150000 }],
  });
  const id = made.body.request._id;

  // 3:1, held, at 400000 rather than 600000.
  const countered = await fin(`/${budget._id}/requests/${id}/counter?companyId=${company._id}`, {
    counterAmount: 400000,
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2026-09", amount: 300000 }, { month: "2026-10", amount: 100000 }],
    financeNote: "Same plan, less money.",
  });
  expect(countered.status).toBe(200);

  expect((await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, {})).status).toBe(200);
  const fresh = await Acc_Budget.findById(budget._id).lean();
  const line = fresh.items.find((i) => String(i.sourceRequestId) === String(id));
  expect(line.allocatedAmount).toBe(400000);
  expect(line.phasingMode).toBe("custom_monthly");
  expect(line.monthlyPhasing.map((m) => [m.month, m.amount])).toEqual([
    ["2026-09", 300000], ["2026-10", 100000],
  ]);
});

test("counter that flattens the spread stores an even line", async () => {
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 600000,
    purpose: "Team tooling",
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2026-09", amount: 600000 }],
  });
  const id = made.body.request._id;
  const countered = await fin(`/${budget._id}/requests/${id}/counter?companyId=${company._id}`, {
    counterAmount: 480000, phasingMode: "even", financeNote: "Across the year, not in one month.",
  });
  expect(countered.status).toBe(200);

  expect((await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, {})).status).toBe(200);
  const fresh = await Acc_Budget.findById(budget._id).lean();
  const line = fresh.items.find((i) => String(i.sourceRequestId) === String(id));
  expect(line.allocatedAmount).toBe(480000);
  expect(line.phasingMode).toBe("even");
  expect(line.monthlyPhasing || []).toEqual([]);
});

test("a month-wise counter is validated against the counter amount, not the ask", async () => {
  // The months finance types have to add up to the figure finance is offering.
  // Checked here rather than at approval, so the mistake is caught in the form
  // that made it.
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 600000,
    purpose: "Team tooling",
  });
  const id = made.body.request._id;

  const wrong = await fin(`/${budget._id}/requests/${id}/counter?companyId=${company._id}`, {
    counterAmount: 400000,
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2026-09", amount: 250000 }, { month: "2026-10", amount: 250000 }],
    financeNote: "Half now, half later.",
  });
  expect(wrong.status).toBe(400);
  expect(wrong.body.code).toBe("PHASING_SUM_MISMATCH");

  const right = await fin(`/${budget._id}/requests/${id}/counter?companyId=${company._id}`, {
    counterAmount: 400000,
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2026-09", amount: 250000 }, { month: "2026-10", amount: 150000 }],
    financeNote: "Half now, the rest in October.",
  });
  expect(right.status).toBe(200);
});

test("the server never tells finance to keep what the department proposed", async () => {
  /* Approving is where "as proposed" lives. A refusal from the counter path
     that used those words would send a reviewer looking for an option the tab
     deliberately no longer has. */
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 600000,
    purpose: "Team tooling",
  });
  const id = made.body.request._id;
  const replies = [
    await fin(`/${budget._id}/requests/${id}/counter?companyId=${company._id}`, { counterAmount: -1 }),
    await fin(`/${budget._id}/requests/${id}/counter?companyId=${company._id}`, {
      counterAmount: 400000, phasingMode: "custom_monthly",
      monthlyPhasing: [{ month: "2026-09", amount: 999999 }],
    }),
    await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, { agreedAmount: 123 }),
  ];
  for (const r of replies) {
    expect(String(r.body?.message || "")).not.toMatch(/keep (what )?(they|their)/i);
  }
});

test("finance cannot reshape the phasing while approving", async () => {
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 600000,
    purpose: "Team tooling",
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2026-09", amount: 600000 }],
  });
  const id = made.body.request._id;
  const no = await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, {
    agreedAmount: 600000, phasingMode: "even",
  });
  expect(no.status).toBe(400);
  expect(no.body.code).toBe("AGREE_IS_NOT_AN_EDIT");
  // And it says where to go instead of reporting that a rule exists.
  expect(no.body.message).toMatch(/counter/i);

  // Nothing was allocated on the way out of the refusal.
  const fresh = await Acc_Budget.findById(budget._id).lean();
  expect(fresh.items.find((i) => String(i.sourceRequestId) === String(id))).toBeUndefined();
});

test("finance cannot agree at a figure nobody was shown", async () => {
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 600000,
    purpose: "Team tooling",
  });
  const id = made.body.request._id;
  const no = await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, {
    agreedAmount: 350000,
  });
  expect(no.status).toBe(400);
  expect(no.body.code).toBe("AGREE_IS_NOT_AN_EDIT");
});

test("agreeing the figure that is actually standing is fine", async () => {
  // Sending the same number back is not an edit — a screen that echoes what it
  // is agreeing to should not be punished for saying it out loud.
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 600000,
    purpose: "Team tooling",
  });
  const id = made.body.request._id;
  const ok = await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, {
    agreedAmount: 600000,
  });
  expect(ok.status).toBe(200);
});

test("the standing figure after a counter is the counter, not the original ask", async () => {
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 600000,
    purpose: "Team tooling",
  });
  const id = made.body.request._id;
  await fin(`/${budget._id}/requests/${id}/counter?companyId=${company._id}`, {
    counterAmount: 400000, financeNote: "Half the tooling this year.",
  });
  // The original ask is now history; agreeing at it would be an edit.
  const stale = await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, {
    agreedAmount: 600000,
  });
  expect(stale.status).toBe(400);

  const ok = await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, {});
  expect(ok.status).toBe(200);
  const fresh = await Acc_Budget.findById(budget._id).lean();
  const line = fresh.items.find((i) => String(i.sourceRequestId) === String(id));
  expect(line.allocatedAmount).toBe(400000);
});

test("a reshape goes through counter, and then approving keeps that shape", async () => {
  // The path the refusals point at. Two clicks instead of one, and in between
  // them the department can see the shape finance wants.
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 600000,
    purpose: "Team tooling",
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2026-09", amount: 600000 }],
  });
  const id = made.body.request._id;
  const countered = await fin(`/${budget._id}/requests/${id}/counter?companyId=${company._id}`, {
    counterAmount: 600000, phasingMode: "even",
    financeNote: "Same money, spread across the year.",
  });
  expect(countered.status).toBe(200);
  expect(countered.body.request.state).toBe("countered");

  const agreed = await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, {});
  expect(agreed.status).toBe(200);
  const fresh = await Acc_Budget.findById(budget._id).lean();
  const line = fresh.items.find((i) => String(i.sourceRequestId) === String(id));
  expect(line.phasingMode).toBe("even");
  expect(line.monthlyPhasing || []).toEqual([]);
});

test("counter with an edited shape allocates nothing and reaches the department", async () => {
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 600000,
    purpose: "Team tooling", workingLines: SUBS,
  });
  const id = made.body.request._id;

  const countered = await fin(`/${budget._id}/requests/${id}/counter?companyId=${company._id}`, {
    counterAmount: 450000,
    financeNote: "Drop Codex to six months.",
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2027-01", amount: 450000 }],
  });
  expect(countered.status).toBe(200);

  const fresh = await Acc_Budget.findById(budget._id).lean();
  expect(fresh.items.filter((i) => String(i.sourceRequestId) === String(id))).toHaveLength(0);

  // and the department app sees it
  const mine = await dept(`/my-requests?companyId=${company._id}`);
  const row = mine.body.requests.find((x) => String(x._id) === String(id));
  expect(row.state).toBe("countered");
  expect(row.counterAmount).toBe(450000);
  expect(row.financeNote).toMatch(/six months/);
  expect(row.agreedPhasingMode).toBe("custom_monthly");
  expect(row.agreedMonthlyPhasing.map((m) => m.month)).toEqual(["2027-01"]);
});

test("an approver cannot agree their own request", async () => {
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 100000, purpose: "x",
  });
  const id = made.body.request._id;
  const doc = await Acc_Budget.findById(budget._id);
  doc.budgetRequests.id(id).submittedBy = "manager@example.com";
  await doc.save();

  const res = await fetch(`${finBase}/${budget._id}/requests/${id}/agree?companyId=${company._id}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user": JSON.stringify({
        id: new mongoose.Types.ObjectId().toString(), name: "Manager", email: "manager@example.com",
        role: "manager", permissions: { canEdit: true, canApprove: true },
      }),
    },
    body: JSON.stringify({ agreedAmount: 100000 }),
  });
  expect(res.status).toBe(403);
});

/* ═══ TWO DRAFTS, WITH A MEETING BETWEEN THEM ══════════════════════════════
 *
 * A budget is not set in one pass. Draft 1 is submitted, the deadline closes
 * it, somebody looks at the total, and Draft 2 reopens whatever is still being
 * argued about.
 *
 * The claim under test is not that dates work. It is that a clean first draft
 * FINISHES a department — an agreed line never comes back — which is both the
 * incentive to submit honestly and a hard requirement of how allocations are
 * keyed.
 */
describe("drafts", () => {
  const drafts = require("../../services/budgetDraft.service");

  /** Draft 1 with two asks: one finance will agree, one it will not. */
  async function twoAsks() {
    const s = await seed();
    /* Two different heads. One department asking twice for the SAME head is
       refused by the duplicate guard, which is correct and not what this is
       testing. */
    const g = await Acc_Group.findOne({ companyId: s.company._id });
    const second = await Acc_Ledger.create({
      companyId: s.company._id, name: "Plant & Machinery",
      groupId: g._id, groupName: g.name, nature: "expense",
    });
    const mk = (ledger, amount, purpose) =>
      dept(`/${s.budget._id}/requests?companyId=${s.company._id}`, {
        department: "Logistics", ledgerId: ledger._id.toString(),
        requestedAmount: amount, purpose,
      });
    const a = await mk(s.ledger, 400000, "Freight, peak season");
    const b = await mk(second, 900000, "New forklift");
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    return { ...s, a: a.body.request, b: b.body.request };
  }

  const q = (s) => `?companyId=${s.company._id}`;

  /**
   * Answer every outstanding ask, the way the meeting does.
   *
   * Draft 2 will not open otherwise — a line nobody replied to arrives looking
   * like a fresh ask, and the department sends the same number back.
   */
  async function answerAll(s, draft = 1) {
    const list = await fin(`/${s.budget._id}/requests${q(s)}`, undefined, "GET");
    for (const r of list.body.requests) {
      if ((r.draft || 1) !== draft) continue;
      if (["agreed", "countered", "rejected", "defaulted"].includes(r.state)) continue;
      const done = await fin(`/${s.budget._id}/requests/${r._id}/reject${q(s)}`, {
        financeNote: "Bring it back smaller in the next draft.",
      });
      expect(done.status).toBe(200);
    }
  }

  test("Draft 2 cannot open while Draft 1 is still collecting", async () => {
    /* The gap between them is the meeting. Without it a department resubmits
       exactly what it sent the first time. */
    const s = await twoAsks();
    const no = await fin(`/${s.budget._id}/drafts${q(s)}`, { closesOn: "2026-03-17" });
    expect(no.status).toBe(409);
    expect(no.body.message).toMatch(/Close it first/);
  });

  test("a draft without a deadline is refused", async () => {
    const s = await twoAsks();
    await answerAll(s);
    await fin(`/${s.budget._id}/close-collection${q(s)}`, {});
    const no = await fin(`/${s.budget._id}/drafts${q(s)}`, {});
    expect(no.status).toBe(400);
    expect(no.body.message).toMatch(/deadline/i);
  });

  test("what was agreed in Draft 1 does not come back", async () => {
    const s = await twoAsks();

    /* The meeting: freight agreed, the forklift refused with a reason — which
       is not the same as killed. It comes back in Draft 2. */
    const agreed = await counterThenAgree(`/${s.budget._id}/requests/${s.a._id}`, q(s), 350000);
    expect(agreed.status).toBe(200);
    const refused = await fin(`/${s.budget._id}/requests/${s.b._id}/reject${q(s)}`, {
      financeNote: "Not this year — the existing one has two seasons left in it.",
    });
    expect(refused.status).toBe(200);
    expect(refused.body.request.state).toBe("rejected");
    await fin(`/${s.budget._id}/close-collection${q(s)}`, {});

    const opened = await fin(`/${s.budget._id}/drafts${q(s)}`, { closesOn: "2027-03-17", note: "Asks are 40% over the revenue plan." });
    expect(opened.status).toBe(201);
    expect(opened.body.draft).toBe(2);
    /* Only the forklift. The freight line is an allocation now and is done. */
    expect(opened.body.carriedForward).toBe(1);
    expect(opened.body.status).toBe("collecting");

    const live = await fin(`/${s.budget._id}/requests?companyId=${s.company._id}`, undefined, "GET");
    /* The agreed line, and the forklift's Draft 2 copy. The Draft 1 forklift
       is superseded and out of the queue rather than sitting beside its own
       revision making the total twice what was asked. */
    expect(live.body.requests).toHaveLength(2);
    const d2 = live.body.requests.find((r) => r.draft === 2);
    expect(d2).toBeTruthy();
    expect(d2.requestedAmount).toBe(900000);
    expect(String(d2.revisionOf)).toBe(String(s.b._id));
    expect(d2.state).toBe("submitted");

    /* And exactly one allocation for the freight — the thing that would break
       if an agreed request were carried forward. */
    const doc = await Acc_Budget.findById(s.budget._id).lean();
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0].allocatedAmount).toBe(350000);
  });

  test("Draft 1 is kept exactly as it was submitted", async () => {
    /* What a department FIRST asked for, against what they came back with, is
       the number the second meeting is about. An edit in place destroys it. */
    const s = await twoAsks();
    await answerAll(s);
    await fin(`/${s.budget._id}/close-collection${q(s)}`, {});
    await fin(`/${s.budget._id}/drafts${q(s)}`, { closesOn: "2027-03-17" });

    const all = await fin(`/${s.budget._id}/requests?drafts=all&companyId=${s.company._id}`, undefined, "GET");
    const originals = all.body.requests.filter((r) => r.supersededByDraft);
    expect(originals.length).toBeGreaterThan(0);
    expect(originals.every((r) => r.supersededByDraft === 2)).toBe(true);
    expect(originals.find((r) => String(r._id) === String(s.b._id)).requestedAmount).toBe(900000);
  });

  test("the superseded copy cannot be decided", async () => {
    const s = await twoAsks();
    await answerAll(s);
    await fin(`/${s.budget._id}/close-collection${q(s)}`, {});
    await fin(`/${s.budget._id}/drafts${q(s)}`, { closesOn: "2027-03-17" });

    const no = await fin(`/${s.budget._id}/requests/${s.b._id}/agree${q(s)}`, {});
    expect(no.status).toBe(409);
    expect(no.body.message).toMatch(/carried into Draft 2/);
  });

  test("the window moves to the new draft, which is what the gate reads", async () => {
    const s = await twoAsks();
    await answerAll(s);
    await fin(`/${s.budget._id}/close-collection${q(s)}`, {});
    await fin(`/${s.budget._id}/drafts${q(s)}`, { opensOn: "2027-03-07", closesOn: "2027-03-17" });

    const doc = await Acc_Budget.findById(s.budget._id).lean();
    expect(doc.submissionStartDate.toISOString().slice(0, 10)).toBe("2027-03-07");
    expect(doc.submissionEndDate.toISOString().slice(0, 10)).toBe("2027-03-17");
    /* Two drafts on the record, the first one stamped closed. */
    expect(doc.drafts).toHaveLength(2);
    expect(doc.drafts[0].number).toBe(1);
    expect(doc.drafts[0].closedAt).toBeTruthy();
    expect(doc.drafts[1].number).toBe(2);
    expect(doc.drafts[1].carriedForward).toBe(2);
  });

  test("Draft 2 will not open with an ask nobody answered", async () => {
    /* The point of a second draft is that the first was ANSWERED. A line that
       passes through unanswered arrives looking like a fresh ask. */
    const s = await twoAsks();
    await counterThenAgree(`/${s.budget._id}/requests/${s.a._id}`, q(s), 350000);
    await fin(`/${s.budget._id}/close-collection${q(s)}`, {});

    const no = await fin(`/${s.budget._id}/drafts${q(s)}`, { closesOn: "2027-03-17" });
    expect(no.status).toBe(409);
    expect(no.body.message).toMatch(/not been answered/);
    /* Named, so finance is not left hunting for which one. */
    expect(no.body.message).toMatch(/New forklift|Plant & Machinery/);
  });

  test("a refusal needs a reason, and is not a deletion", async () => {
    const s = await twoAsks();

    const bare = await fin(`/${s.budget._id}/requests/${s.b._id}/reject${q(s)}`, {});
    expect(bare.status).toBe(400);
    expect(bare.body.message).toMatch(/Say why/);

    const done = await fin(`/${s.budget._id}/requests/${s.b._id}/reject${q(s)}`, {
      financeNote: "Not this year — the existing one has two seasons left in it.",
    });
    expect(done.status).toBe(200);
    expect(done.body.request.state).toBe("rejected");
    expect(done.body.request.financeNote).toMatch(/two seasons/);
    expect(done.body.request.decidedAt).toBeTruthy();
    /* The word does not mean what it usually means here, so the answer says so. */
    expect(done.body.message).toMatch(/goes back to the department/);
  });

  test("a refused ask comes back in Draft 2, carrying the reason", async () => {
    const s = await twoAsks();
    await counterThenAgree(`/${s.budget._id}/requests/${s.a._id}`, q(s), 350000);
    await fin(`/${s.budget._id}/requests/${s.b._id}/reject${q(s)}`, {
      financeNote: "Too big. Halve it or defer.",
    });
    await fin(`/${s.budget._id}/close-collection${q(s)}`, {});

    const opened = await fin(`/${s.budget._id}/drafts${q(s)}`, { closesOn: "2027-03-17" });
    expect(opened.status).toBe(201);
    /* A budget round cannot delete somebody else's priority. It declines to
       fund it and says why; the department revises or drops it. */
    expect(opened.body.carriedForward).toBe(1);

    const live = await fin(`/${s.budget._id}/requests${q(s)}`, undefined, "GET");
    const d2 = live.body.requests.find((r) => r.draft === 2);
    expect(d2.state).toBe("submitted");
    /* The reason travels, or the department is revising blind. */
    expect(d2.financeNote).toMatch(/Halve it or defer/);
  });

  test("an agreed ask cannot be refused out from under its allocation", async () => {
    const s = await twoAsks();
    await counterThenAgree(`/${s.budget._id}/requests/${s.a._id}`, q(s), 350000);

    const no = await fin(`/${s.budget._id}/requests/${s.a._id}/reject${q(s)}`, {
      financeNote: "Changed our minds about this one entirely.",
    });
    expect(no.status).toBe(409);
    expect(no.body.message).toMatch(/Reopen it first/);

    /* And the allocation is untouched. */
    const doc = await Acc_Budget.findById(s.budget._id).lean();
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0].allocatedAmount).toBe(350000);
  });

  test("there is no Draft 3", async () => {
    const s = await twoAsks();
    await answerAll(s);
    await fin(`/${s.budget._id}/close-collection${q(s)}`, {});
    await fin(`/${s.budget._id}/drafts${q(s)}`, { closesOn: "2027-03-17" });
    await fin(`/${s.budget._id}/close-collection${q(s)}`, {});

    const no = await fin(`/${s.budget._id}/drafts${q(s)}`, { closesOn: "2027-03-25" });
    expect(no.status).toBe(409);
    expect(no.body.message).toMatch(/decided in review/);
    expect(drafts.MAX_DRAFTS).toBe(2);
  });
});
