// test/accountant/budget-proposals.route.test.js
//
// The department-facing budget surface, and the boundary around it.
//
// Most of this file is about what a department user must NOT be able to reach.
// The survey that preceded it found two guards in this codebase that FAIL OPEN
// when a department has no roles assigned — right for a migration, wrong for
// money — so every refusal here is asserted rather than assumed.
"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { SECRET } = require("../../config/jwt");
const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_BudgetDepartment } = require("../../models/Accountant_model/Acc_BudgetDepartment");

let server;
let base;
let seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/budget-proposals", require("../../routes/Access/budgetProposals"));
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}/api/budget-proposals`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

/** A real signed CMS department token, exactly as deptAuth mints one. */
const tokenFor = ({ deptSlug, email = "head@demo.example", isAdmin = false } = {}) =>
  jwt.sign(
    { v: 2, id: new mongoose.Types.ObjectId().toString(), deptSlug, email, name: "Dept Head", isAdmin },
    SECRET,
    { expiresIn: "1h" },
  );

async function call(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function seedCompany() {
  const company = await Acc_Company.create({
    companyName: `Proposals Co ${seq++}`,
    booksFromDate: new Date("2026-04-01"),
  });
  const g = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const ledger = await Acc_Ledger.create({
    companyId: company._id, name: "Freight & Forwarding",
    groupId: g._id, groupName: g.name, nature: "expense",
  });
  return { company, ledger };
}

/** Link a portal slug to a budget department in one company. */
const link = (company, { name, accessSlug }) =>
  Acc_BudgetDepartment.create({
    companyId: company._id,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name,
    accessSlug,
  });

const cycle = (company, status = "collecting", extra = {}) =>
  Acc_Budget.create({
    name: `FY26-27 ${status}`, financialYear: "2026-27", period: "yearly", status,
    startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"),
    companyId: company._id, items: [], ...extra,
  });

const submit = (budget, company, token, over = {}) =>
  call(`/${budget._id}/requests?companyId=${company._id}`, {
    method: "POST", token,
    body: {
      department: "Logistics", ledgerId: null, requestedAmount: 500000,
      purpose: "Peak season freight", ...over,
    },
  });

/* ═══════════════════════════════════════════════════════════════════════════
 * AUTHENTICATION
 * ══════════════════════════════════════════════════════════════════════════ */

describe("authentication", () => {
  test("no token is refused", async () => {
    const { company } = await seedCompany();
    expect((await call(`/open-cycles?companyId=${company._id}`)).status).toBe(401);
  });

  test("a token signed with the wrong key is refused", async () => {
    const { company } = await seedCompany();
    const forged = jwt.sign({ deptSlug: "sales", email: "x@y.z" }, "not-the-secret");
    const { status } = await call(`/open-cycles?companyId=${company._id}`, { token: forged });
    expect(status).toBe(401);
  });

  test("a valid token with NO deptSlug maps to nothing", async () => {
    const { company } = await seedCompany();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    await cycle(company);

    /* An accountant-module token has no deptSlug. It must not become a
       wildcard just because it is validly signed. */
    const { status, body } = await call(`/open-cycles?companyId=${company._id}`, {
      token: tokenFor({ deptSlug: "" }),
    });
    expect(status).toBe(200);
    expect(body.cycles).toEqual([]);
    expect(body.departments).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE HEADS A DEPARTMENT MAY ASK AGAINST
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the offered heads are classified by the chart of accounts", () => {
  /** A company with one head under each of the four natures that matter. */
  async function seedChart() {
    const company = await Acc_Company.create({
      companyName: `Chart Co ${seq++}`,
      booksFromDate: new Date("2026-04-01"),
    });
    const mk = async (name, nature, ledgerName, rowNature = nature) => {
      const g = await Acc_Group.create({ companyId: company._id, name, nature });
      const l = await Acc_Ledger.create({
        companyId: company._id, name: ledgerName, groupId: g._id, groupName: g.name,
        nature: rowNature,
      });
      return l;
    };
    await mk("Indirect Expenses", "expense", "Freight & Forwarding");
    /* The row says expense, the group says revenue. Tally allows that
       override; the budget module does not honour it — natureByLedger reads
       the group, so every figure downstream calls this a target. The picker
       has to agree with the figures. */
    await mk("Sales Accounts", "revenue", "Domestic Sales", "expense");
    await mk("Bank Accounts", "asset", "HDFC Current A/c");
    await mk("Current Liabilities", "liability", "Sundry Creditors");
    await link(company, { name: "Logistics", accessSlug: "sales" });
    return company;
  }

  test("a head is classified by its group, not by the copy on the ledger row", async () => {
    const company = await seedChart();
    const { status, body } = await call(`/heads?companyId=${company._id}`, {
      token: tokenFor({ deptSlug: "sales" }),
    });
    expect(status).toBe(200);
    const byName = Object.fromEntries(body.heads.map((h) => [h.ledgerName, h.nature]));
    expect(byName["Freight & Forwarding"]).toBe("expense");
    expect(byName["Domestic Sales"]).toBe("revenue");
  });

  test("an asset or liability head is not offered as a budget head at all", async () => {
    const company = await seedChart();
    const { body } = await call(`/heads?companyId=${company._id}`, {
      token: tokenFor({ deptSlug: "sales" }),
    });
    const names = body.heads.map((h) => h.ledgerName);
    expect(names).not.toContain("HDFC Current A/c");
    expect(names).not.toContain("Sundry Creditors");
    expect(names).toHaveLength(2);
  });

  test("a department mapped to nothing is offered no heads", async () => {
    const company = await seedChart();
    const { status, body } = await call(`/heads?companyId=${company._id}`, {
      token: tokenFor({ deptSlug: "production" }),
    });
    expect(status).toBe(200);
    expect(body.heads).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE MAPPING — AND ITS FAIL-CLOSED DEFAULT
 * ══════════════════════════════════════════════════════════════════════════ */

describe("portal to budget department mapping", () => {
  test("an UNMAPPED portal sees nothing and can submit nothing", async () => {
    const { company, ledger } = await seedCompany();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    const c = await cycle(company);

    const hr = tokenFor({ deptSlug: "hr" });
    const cycles = await call(`/open-cycles?companyId=${company._id}`, { token: hr });
    expect(cycles.body.cycles).toEqual([]);

    /* The load-bearing assertion of the whole file: no mapping means no
       write, not an unguarded one. */
    const posted = await submit(c, company, hr, { ledgerId: String(ledger._id) });
    expect(posted.status).toBe(403);

    const mine = await call(`/my-requests?companyId=${company._id}`, { token: hr });
    expect(mine.body.requests).toEqual([]);
  });

  test("a mapped portal sees the open cycles and its own department", async () => {
    const { company } = await seedCompany();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    await cycle(company);

    const { body } = await call(`/open-cycles?companyId=${company._id}`, {
      token: tokenFor({ deptSlug: "sales" }),
    });
    expect(body.cycles).toHaveLength(1);
    expect(body.departments.map((d) => d.name)).toEqual(["Logistics"]);
  });

  test("a mapping in ANOTHER company does not carry over", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    await link(a.company, { name: "Logistics", accessSlug: "sales" });
    await cycle(b.company);

    const { body } = await call(`/open-cycles?companyId=${b.company._id}`, {
      token: tokenFor({ deptSlug: "sales" }),
    });
    expect(body.cycles).toEqual([]);
  });

  test("context lists only companies this portal is mapped in", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    await link(a.company, { name: "Logistics", accessSlug: "sales" });
    await link(b.company, { name: "Production", accessSlug: "production-supervisor" });

    const { body } = await call("/context", { token: tokenFor({ deptSlug: "sales" }) });
    const names = body.companies.map((c) => String(c._id));
    expect(names).toContain(String(a.company._id));
    expect(names).not.toContain(String(b.company._id));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * SUBMITTING
 * ══════════════════════════════════════════════════════════════════════════ */

describe("submitting a proposal", () => {
  async function setup(status = "collecting") {
    const { company, ledger } = await seedCompany();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    const c = await cycle(company, status);
    return { company, ledger, c, token: tokenFor({ deptSlug: "sales" }) };
  }

  test("into a collecting cycle works, and the server names the submitter", async () => {
    const { company, ledger, c, token } = await setup();
    const { status, body } = await submit(c, company, token, {
      ledgerId: String(ledger._id),
      submittedBy: "someone.else@example.com",
      state: "agreed",
      agreedAmount: 9999999,
    });

    expect(status).toBe(201);
    expect(body.request.state).toBe("submitted");
    /* A department cannot file as another person, nor agree its own ask. */
    expect(body.request.submittedBy).toBe("head@demo.example");
    expect(body.request.agreedAmount).toBeNull();
  });

  test("a draft cycle also accepts requests", async () => {
    const { company, ledger, c, token } = await setup("draft");
    expect((await submit(c, company, token, { ledgerId: String(ledger._id) })).status).toBe(201);
  });

  test("an active or closed cycle does not", async () => {
    for (const state of ["active", "closed", "review"]) {
      const { company, ledger, c, token } = await setup(state);
      const { status, body } = await submit(c, company, token, { ledgerId: String(ledger._id) });
      expect(status).toBe(409);
      expect(body.message).toMatch(/no longer collecting/);
    }
  });

  test("submitting for ANOTHER department is refused", async () => {
    const { company, ledger, c, token } = await setup();
    await link(company, { name: "Production", accessSlug: "production-supervisor" });

    const { status, body } = await submit(c, company, token, {
      department: "Production",
      ledgerId: String(ledger._id),
    });
    expect(status).toBe(403);
    /* The refusal must not name the departments they COULD use — that turns a
       403 into a directory of the company. */
    expect(body.message).not.toMatch(/Logistics/);
  });

  test("a head from another company is refused", async () => {
    const { company, c, token } = await setup();
    const other = await seedCompany();
    const { status } = await submit(c, company, token, { ledgerId: String(other.ledger._id) });
    expect(status).toBe(400);
  });

  test("a request needs a reason and a sane amount", async () => {
    const { company, ledger, c, token } = await setup();
    const noReason = await submit(c, company, token, {
      ledgerId: String(ledger._id), purpose: "", justification: "",
    });
    expect(noReason.status).toBe(400);

    const badAmount = await submit(c, company, token, {
      ledgerId: String(ledger._id), requestedAmount: -5,
    });
    expect(badAmount.status).toBe(400);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * SEEING ONLY YOUR OWN
 * ══════════════════════════════════════════════════════════════════════════ */

describe("a department sees only its own requests", () => {
  test("Sales cannot see Production's rows", async () => {
    const { company, ledger } = await seedCompany();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    await link(company, { name: "Production", accessSlug: "production-supervisor" });
    const c = await cycle(company);

    await submit(c, company, tokenFor({ deptSlug: "sales" }), { ledgerId: String(ledger._id) });
    await submit(c, company, tokenFor({ deptSlug: "production-supervisor" }), {
      department: "Production", ledgerId: String(ledger._id), requestedAmount: 800000,
    });

    const sales = await call(`/my-requests?companyId=${company._id}`, {
      token: tokenFor({ deptSlug: "sales" }),
    });
    expect(sales.body.requests).toHaveLength(1);
    expect(sales.body.requests[0].department).toBe("Logistics");
    expect(JSON.stringify(sales.body)).not.toMatch(/Production/);
  });

  test("the summary counts only the caller's own rows", async () => {
    const { company, ledger } = await seedCompany();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    await link(company, { name: "Production", accessSlug: "production-supervisor" });
    const c = await cycle(company);

    await submit(c, company, tokenFor({ deptSlug: "sales" }), {
      ledgerId: String(ledger._id), requestedAmount: 500000,
    });
    await submit(c, company, tokenFor({ deptSlug: "production-supervisor" }), {
      department: "Production", ledgerId: String(ledger._id), requestedAmount: 800000,
    });

    const { body } = await call(`/my-requests?companyId=${company._id}`, {
      token: tokenFor({ deptSlug: "sales" }),
    });
    expect(body.summary.requested).toBe(500000);
  });

  test("finance's answer on the department's OWN row is visible", async () => {
    const { company, ledger } = await seedCompany();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    const c = await cycle(company);
    const token = tokenFor({ deptSlug: "sales" });
    await submit(c, company, token, { ledgerId: String(ledger._id) });

    /* Finance counters, as the accounting module would. */
    const fresh = await Acc_Budget.findById(c._id);
    fresh.budgetRequests[0].state = "countered";
    fresh.budgetRequests[0].counterAmount = 300000;
    fresh.budgetRequests[0].financeNote = "Take the smaller number this quarter.";
    fresh.budgetRequests[0].updatedBy = "finance@demo.example";
    await fresh.save();

    const { body } = await call(`/my-requests?companyId=${company._id}`, { token });
    const r = body.requests[0];
    /* A counter nobody can see is a conversation with one side. */
    expect(r.counterAmount).toBe(300000);
    expect(r.financeNote).toMatch(/smaller number/);
    /* But not WHO in finance touched it. */
    expect(r.updatedBy).toBeUndefined();
    expect(r.editable).toBe(true);
  });

  test("no company-wide figure leaks through any read", async () => {
    const { company, ledger } = await seedCompany();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    const c = await cycle(company, "collecting", {
      items: [
        { ledgerId: ledger._id, ledgerName: "Freight", nature: "expense",
          department: "Production", allocatedAmount: 9900000 },
      ],
    });
    const token = tokenFor({ deptSlug: "sales" });

    const cycles = await call(`/open-cycles?companyId=${company._id}`, { token });
    const mine = await call(`/my-requests?companyId=${company._id}`, { token });

    /* The cycle exists and is offered — but nothing about the company's
       allocations, its other departments, or its totals comes with it. */
    const all = JSON.stringify(cycles.body) + JSON.stringify(mine.body);
    expect(all).not.toMatch(/9900000/);
    expect(all).not.toMatch(/allocatedAmount|totals|byDepartment|items/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * REVISING
 * ══════════════════════════════════════════════════════════════════════════ */

describe("revising a request", () => {
  async function submitted() {
    const { company, ledger } = await seedCompany();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    const c = await cycle(company);
    const token = tokenFor({ deptSlug: "sales" });
    const { body } = await submit(c, company, token, { ledgerId: String(ledger._id) });
    return { company, c, token, requestId: body.request._id };
  }

  test("the owner may change their own open ask", async () => {
    const { company, c, token, requestId } = await submitted();
    const { status, body } = await call(
      `/${c._id}/requests/${requestId}?companyId=${company._id}`,
      { method: "PUT", token, body: { requestedAmount: 650000, purpose: "Revised for Q3" } },
    );
    expect(status).toBe(200);
    expect(body.request.requestedAmount).toBe(650000);
  });

  test("answering a counter puts it back to finance", async () => {
    const { company, c, token, requestId } = await submitted();
    const fresh = await Acc_Budget.findById(c._id);
    fresh.budgetRequests[0].state = "countered";
    fresh.budgetRequests[0].counterAmount = 300000;
    await fresh.save();

    const { body } = await call(`/${c._id}/requests/${requestId}?companyId=${company._id}`, {
      method: "PUT", token, body: { requestedAmount: 300000 },
    });
    expect(body.request.state).toBe("submitted");
  });

  test("an AGREED request can no longer be changed", async () => {
    const { company, c, token, requestId } = await submitted();
    const fresh = await Acc_Budget.findById(c._id);
    fresh.budgetRequests[0].state = "agreed";
    fresh.budgetRequests[0].agreedAmount = 500000;
    await fresh.save();

    /* It is an allocation line on the company budget now — editing the
       request behind it would disagree with money already committed. */
    const { status, body } = await call(
      `/${c._id}/requests/${requestId}?companyId=${company._id}`,
      { method: "PUT", token, body: { requestedAmount: 900000 } },
    );
    expect(status).toBe(409);
    expect(body.message).toMatch(/agreed/);
  });

  test("another department's request is not found, not forbidden", async () => {
    const { company, c, requestId } = await submitted();
    await link(company, { name: "Production", accessSlug: "production-supervisor" });

    /* 404 rather than 403 on purpose: a 403 would confirm the id exists and
       let someone enumerate another department's requests. */
    const { status } = await call(`/${c._id}/requests/${requestId}?companyId=${company._id}`, {
      method: "PUT",
      token: tokenFor({ deptSlug: "production-supervisor" }),
      body: { requestedAmount: 1 },
    });
    expect(status).toBe(404);
  });

  test("a department cannot approve its own request through the update route", async () => {
    const { company, c, token, requestId } = await submitted();
    await call(`/${c._id}/requests/${requestId}?companyId=${company._id}`, {
      method: "PUT", token,
      body: { state: "agreed", agreedAmount: 5000000, financeNote: "approved by me" },
    });

    const stored = (await Acc_Budget.findById(c._id)).budgetRequests[0];
    expect(stored.state).toBe("submitted");
    expect(stored.agreedAmount).toBeUndefined();
    expect(stored.financeNote).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * FINANCE IS UNAFFECTED
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the finance module still sees everything", () => {
  test("a proposal submitted here is an ordinary request on the budget", async () => {
    const { company, ledger } = await seedCompany();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    const c = await cycle(company);
    await submit(c, company, tokenFor({ deptSlug: "sales" }), { ledgerId: String(ledger._id) });

    /* Nothing about this surface is a parallel store — finance reviews it
       with the same endpoints and the same agree/counter flow. */
    const stored = await Acc_Budget.findById(c._id).lean();
    expect(stored.budgetRequests).toHaveLength(1);
    expect(stored.budgetRequests[0]).toMatchObject({
      department: "Logistics",
      state: "submitted",
      requestedAmount: 500000,
    });
  });
});
