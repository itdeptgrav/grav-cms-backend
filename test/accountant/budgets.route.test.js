// test/accountant/budgets.route.test.js
//
// HTTP-level tests for /api/accountant/budgets — Chunk 1 (Budget Core
// Cleanup). Mirrors test/accountant/parties-credit-terms.route.test.js: the
// router is mounted on a bare Express app against an in-memory MongoDB, and
// AccountantAuthMiddleware is mocked so identity is assertable per request.
//
// What this file exists to prove that the two pure-function test files
// (services/budgetActuals.test.js, services/budgetVariance.test.js) cannot:
//   - period/status validation actually rejects a bad HTTP request with a
//     clean 400, rather than the generic 500 a Mongoose ValidationError used
//     to produce — and leaves the PERSISTED document untouched.
//   - the exact mismatch this chunk was scoped to close (`"annual"` where the
//     schema has always said `"yearly"`, an `"expired"` status the schema has
//     never had) is actually rejected over a real HTTP round trip, not just
//     "would be rejected" in isolation.
//   - a line's ledger/nature/department/owner/notes fields survive a real
//     create → read round trip.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
}));

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");

const OWNER = { id: new mongoose.Types.ObjectId().toString(), name: "Priya Owner", permissions: { canEdit: true } };

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/accountant/budgets", require("../../routes/Accountant_Routes/Acc_budgets"));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/budgets`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(path, { method = "GET", body, user = OWNER } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** One company with a revenue head and an expense head to budget against. */
async function seedCompany() {
  const company = await Acc_Company.create({ companyName: "Company A", booksFromDate: new Date("2026-04-01") });
  const revGroup = await Acc_Group.create({ companyId: company._id, name: "Direct Income", nature: "revenue" });
  const expGroup = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const revenueLedger = await Acc_Ledger.create({
    companyId: company._id,
    name: "Export Sales",
    groupId: revGroup._id,
    groupName: revGroup.name,
    nature: "revenue",
  });
  const expenseLedger = await Acc_Ledger.create({
    companyId: company._id,
    name: "Freight & Forwarding",
    groupId: expGroup._id,
    groupName: expGroup.name,
    nature: "expense",
  });
  return { company, revenueLedger, expenseLedger };
}

function validPayload({ companyId, revenueLedger, expenseLedger }) {
  return {
    name: "FY26-27 Company Budget",
    financialYear: "2026-27",
    period: "yearly",
    status: "draft",
    startDate: "2026-04-01",
    endDate: "2027-03-31",
    companyId,
    items: [
      {
        ledgerId: expenseLedger._id.toString(),
        nature: "expense",
        department: "Logistics",
        allocatedAmount: 500000,
        ownerEmail: "logistics.head@example.com",
        notes: "Covers export freight for the full year.",
      },
      {
        ledgerId: revenueLedger._id.toString(),
        nature: "revenue",
        department: "Sales",
        allocatedAmount: 4000000,
      },
    ],
  };
}

/* ── period / status validation ──────────────────────────────────────────── */

describe("period and status validation", () => {
  test("a valid period and status create cleanly", async () => {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    const { status, body } = await call("/", {
      method: "POST",
      body: validPayload({ companyId: company._id.toString(), revenueLedger, expenseLedger }),
    });
    expect(status).toBe(201);
    expect(body.budget.period).toBe("yearly");
    expect(body.budget.status).toBe("draft");
  });

  test("the exact mismatch this chunk closes: `annual` is rejected, not silently accepted", async () => {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    const payload = validPayload({ companyId: company._id.toString(), revenueLedger, expenseLedger });
    payload.period = "annual";
    const { status, body } = await call("/", { method: "POST", body: payload });
    expect(status).toBe(400);
    expect(body.message).toMatch(/period must be one of/i);
    expect(body.message).toMatch(/yearly/);
    await expect(Acc_Budget.countDocuments({})).resolves.toBe(0);
  });

  test("`expired` is rejected — the schema has never had this status", async () => {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    const payload = validPayload({ companyId: company._id.toString(), revenueLedger, expenseLedger });
    payload.status = "expired";
    const { status, body } = await call("/", { method: "POST", body: payload });
    expect(status).toBe(400);
    expect(body.message).toMatch(/status must be one of/i);
    await expect(Acc_Budget.countDocuments({})).resolves.toBe(0);
  });

  test("every real lifecycle status is accepted", async () => {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    for (const s of ["draft", "collecting", "review", "active", "closed", "exceeded"]) {
      const payload = validPayload({ companyId: company._id.toString(), revenueLedger, expenseLedger });
      payload.status = s;
      payload.name = `Budget — ${s}`;
      const { status } = await call("/", { method: "POST", body: payload });
      expect(status).toBe(201);
    }
  });

  test("every real period is accepted", async () => {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    for (const p of ["monthly", "quarterly", "half_yearly", "yearly"]) {
      const payload = validPayload({ companyId: company._id.toString(), revenueLedger, expenseLedger });
      payload.period = p;
      payload.name = `Budget — ${p}`;
      const { status } = await call("/", { method: "POST", body: payload });
      expect(status).toBe(201);
    }
  });

  test("an invalid status on UPDATE is rejected and the stored document is untouched", async () => {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    const created = await call("/", {
      method: "POST",
      body: validPayload({ companyId: company._id.toString(), revenueLedger, expenseLedger }),
    });
    const id = created.body.budget._id;

    const { status, body } = await call(`/${id}`, { method: "PUT", body: { status: "expired" } });
    expect(status).toBe(400);
    expect(body.message).toMatch(/status must be one of/i);

    const stored = await Acc_Budget.findById(id).lean();
    expect(stored.status).toBe("draft");
  });

  test("a legitimate partial update (no period/status touched) still succeeds", async () => {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    const created = await call("/", {
      method: "POST",
      body: validPayload({ companyId: company._id.toString(), revenueLedger, expenseLedger }),
    });
    const id = created.body.budget._id;

    const { status, body } = await call(`/${id}`, {
      method: "PUT",
      body: { name: "Renamed Budget" },
    });
    expect(status).toBe(200);
    expect(body.budget.name).toBe("Renamed Budget");
    expect(body.budget.period).toBe("yearly");
  });
});

/* ── basic read / create / update, and line shape ──────────────────────────── */

describe("basic budget read, create and update", () => {
  test("a created budget's lines round-trip ledger, nature, department, owner and notes", async () => {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    const created = await call("/", {
      method: "POST",
      body: validPayload({ companyId: company._id.toString(), revenueLedger, expenseLedger }),
    });
    expect(created.status).toBe(201);

    const { status, body } = await call(`/${created.body.budget._id}`);
    expect(status).toBe(200);
    const expenseLine = body.budget.items.find((i) => i.nature === "expense");
    const revenueLine = body.budget.items.find((i) => i.nature === "revenue");

    expect(expenseLine.department).toBe("Logistics");
    expect(expenseLine.ownerEmail).toBe("logistics.head@example.com");
    expect(expenseLine.notes).toMatch(/export freight/i);
    expect(String(expenseLine.ledgerId)).toBe(String(expenseLedger._id));

    expect(revenueLine.department).toBe("Sales");
    // Optional fields genuinely absent — not defaulted to empty strings that
    // would then read as "someone answered but left it blank".
    expect(revenueLine.ownerEmail == null).toBe(true);
  });

  test("detail read is nature-aware: revenue and expense are never summed together", async () => {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    const created = await call("/", {
      method: "POST",
      body: validPayload({ companyId: company._id.toString(), revenueLedger, expenseLedger }),
    });

    const { body } = await call(`/${created.body.budget._id}?asOf=2026-10-01`);
    const totals = body.budget.totals;
    expect(totals.revenue.allocated).toBe(4000000);
    expect(totals.expense.allocated).toBe(500000);
    // With zero posted vouchers, actual spend/earn is zero either side.
    expect(totals.revenue.actual).toBe(0);
    expect(totals.expense.actual).toBe(0);
    // A revenue line that has earned nothing against a live target is NOT
    // favourable; an expense line that has spent nothing IS — the whole
    // point of nature-aware variance (services/budgetVariance.service.js).
    const revenueLine = body.budget.items.find((i) => i.nature === "revenue");
    const expenseLine = body.budget.items.find((i) => i.nature === "expense");
    expect(revenueLine.favourable).toBe(false);
    expect(expenseLine.favourable).toBe(true);
  });

  test("list respects the status filter", async () => {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    const draft = validPayload({ companyId: company._id.toString(), revenueLedger, expenseLedger });
    const active = { ...draft, name: "Active one", status: "active" };
    await call("/", { method: "POST", body: draft });
    await call("/", { method: "POST", body: active });

    const { body } = await call(`/?status=active&companyId=${company._id}`);
    expect(body.budgets).toHaveLength(1);
    expect(body.budgets[0].name).toBe("Active one");
  });

  test("delete removes the budget", async () => {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    const created = await call("/", {
      method: "POST",
      body: validPayload({ companyId: company._id.toString(), revenueLedger, expenseLedger }),
    });
    const { status } = await call(`/${created.body.budget._id}`, { method: "DELETE" });
    expect(status).toBe(200);
    await expect(Acc_Budget.findById(created.body.budget._id).lean()).resolves.toBeNull();
  });
});
