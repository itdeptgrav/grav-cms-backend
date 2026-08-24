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

/* ─────────────────────────────────────────────────────────────────────────────
 * Chunk 1A — COMPANY OWNERSHIP ON BY-ID ROUTES
 *
 * The list endpoint was always company-scoped, but detail/update/delete (and
 * the two by-id submission routes) used a bare `findById`, so a budget was
 * invisible in another company's list yet fully readable, editable and
 * deletable by anyone holding its id. These tests pin both halves of the
 * fixed rule: your own company's rows work exactly as before, another
 * company's are 404, and LEGACY rows with no companyId stay reachable —
 * because that is what the list has always shown them as.
 * ────────────────────────────────────────────────────────────────────────── */
describe("company ownership on by-id routes", () => {
  /** Monotonic, so each legacy seed gets its own `budgetId`. */
  let legacySeq = 0;

  /** Two companies, each with a budget, plus one legacy row owned by neither. */
  async function seedTwoCompanies() {
    const a = await seedCompany();
    const b = await seedCompany();

    const madeA = await call("/", {
      method: "POST",
      body: validPayload({
        companyId: a.company._id.toString(),
        revenueLedger: a.revenueLedger,
        expenseLedger: a.expenseLedger,
      }),
    });
    const madeB = await call("/", {
      method: "POST",
      body: {
        ...validPayload({
          companyId: b.company._id.toString(),
          revenueLedger: b.revenueLedger,
          expenseLedger: b.expenseLedger,
        }),
        name: "B's budget",
      },
    });

    // Written straight to the collection so it genuinely carries NO
    // companyId — the shape that predates the field.
    //
    // `budgetId` is supplied explicitly because the schema's own default is
    // `BUD-${Date.now().toString(36)}` with NO random component, so two rows
    // created in the same millisecond collide on its unique index. That is a
    // real latent bug in the model (see the summary's remaining risks), not
    // something these tests should be exposed to.
    const legacy = await Acc_Budget.create({
      budgetId: `BUD-LEGACY-${legacySeq++}`,
      name: "Legacy budget",
      financialYear: "2025-26",
      period: "yearly",
      status: "draft",
      startDate: new Date("2025-04-01"),
      endDate: new Date("2026-03-31"),
      createdBy: OWNER.id,
      items: [],
    });

    return { a, b, budgetA: madeA.body.budget, budgetB: madeB.body.budget, legacy };
  }

  test("sanity: the seeded budgets really do carry the companyIds under test", async () => {
    const { a, b, budgetA, budgetB, legacy } = await seedTwoCompanies();
    expect(String(budgetA.companyId)).toBe(a.company._id.toString());
    expect(String(budgetB.companyId)).toBe(b.company._id.toString());
    const storedLegacy = await Acc_Budget.findById(legacy._id).lean();
    expect(storedLegacy.companyId == null).toBe(true);
  });

  /* ── Same company: everything still works ──────────────────────────────── */

  test("a same-company budget can be READ", async () => {
    const { a, budgetA } = await seedTwoCompanies();
    const { status, body } = await call(`/${budgetA._id}?companyId=${a.company._id}`);
    expect(status).toBe(200);
    expect(body.budget._id).toBe(String(budgetA._id));
  });

  test("a same-company budget can be UPDATED", async () => {
    const { a, budgetA } = await seedTwoCompanies();
    const { status, body } = await call(`/${budgetA._id}?companyId=${a.company._id}`, {
      method: "PUT",
      body: { name: "Renamed by its owner" },
    });
    expect(status).toBe(200);
    expect(body.budget.name).toBe("Renamed by its owner");

    const stored = await Acc_Budget.findById(budgetA._id).lean();
    expect(stored.name).toBe("Renamed by its owner");
  });

  test("a same-company budget can be DELETED", async () => {
    const { a, budgetA } = await seedTwoCompanies();
    const { status } = await call(`/${budgetA._id}?companyId=${a.company._id}`, {
      method: "DELETE",
    });
    expect(status).toBe(200);
    await expect(Acc_Budget.findById(budgetA._id).lean()).resolves.toBeNull();
  });

  /* ── Other company: refused, and nothing is mutated ────────────────────── */

  test("another company's budget cannot be READ — 404, not 403", async () => {
    const { a, budgetB } = await seedTwoCompanies();
    const { status, body } = await call(`/${budgetB._id}?companyId=${a.company._id}`);
    expect(status).toBe(404);
    // 404 rather than 403 on purpose: a 403 would confirm the id exists
    // somewhere, which is exactly what probing ids is meant to learn.
    expect(body.message).toMatch(/not found/i);
  });

  test("another company's budget cannot be UPDATED, and the document is untouched", async () => {
    const { a, budgetB } = await seedTwoCompanies();
    const before = await Acc_Budget.findById(budgetB._id).lean();

    const { status } = await call(`/${budgetB._id}?companyId=${a.company._id}`, {
      method: "PUT",
      body: { name: "Hijacked", status: "active" },
    });
    expect(status).toBe(404);

    const after = await Acc_Budget.findById(budgetB._id).lean();
    expect(after.name).toBe(before.name);
    expect(after.status).toBe(before.status);
  });

  test("another company's budget cannot be DELETED, and it survives", async () => {
    const { a, budgetB } = await seedTwoCompanies();
    const { status } = await call(`/${budgetB._id}?companyId=${a.company._id}`, {
      method: "DELETE",
    });
    expect(status).toBe(404);
    await expect(Acc_Budget.findById(budgetB._id).lean()).resolves.not.toBeNull();
  });

  test("another company's budget cannot receive a SUBMISSION", async () => {
    const { a, budgetB } = await seedTwoCompanies();
    const { status } = await call(`/${budgetB._id}/submissions?companyId=${a.company._id}`, {
      method: "POST",
      body: { department: "Logistics", requestedAmount: 1 },
    });
    expect(status).toBe(404);

    const after = await Acc_Budget.findById(budgetB._id).lean();
    expect(after.submissions || []).toHaveLength(0);
  });

  test("another company's budget cannot have its collection CLOSED", async () => {
    const { a, budgetB } = await seedTwoCompanies();
    const before = await Acc_Budget.findById(budgetB._id).lean();

    const { status } = await call(`/${budgetB._id}/close-collection?companyId=${a.company._id}`, {
      method: "POST",
    });
    expect(status).toBe(404);

    const after = await Acc_Budget.findById(budgetB._id).lean();
    expect(after.status).toBe(before.status); // never moved to "review"
  });

  /* ── Legacy rows: reachable, matching the list ─────────────────────────── */

  test("a LEGACY budget with no companyId is visible in the list — the behaviour being matched", async () => {
    const { a, legacy } = await seedTwoCompanies();
    const { body } = await call(`/?companyId=${a.company._id}`);
    const ids = body.budgets.map((b) => String(b._id));
    expect(ids).toContain(String(legacy._id));
  });

  test("a LEGACY budget can be read, updated and deleted — exactly as the list implies", async () => {
    const { a, legacy } = await seedTwoCompanies();

    const read = await call(`/${legacy._id}?companyId=${a.company._id}`);
    expect(read.status).toBe(200);

    const updated = await call(`/${legacy._id}?companyId=${a.company._id}`, {
      method: "PUT",
      body: { name: "Legacy, adopted" },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.budget.name).toBe("Legacy, adopted");

    const deleted = await call(`/${legacy._id}?companyId=${a.company._id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
  });

  test("a legacy row is reachable by EITHER company — it belongs to no one, as the list already shows", async () => {
    const { b, legacy } = await seedTwoCompanies();
    const { status } = await call(`/${legacy._id}?companyId=${b.company._id}`);
    expect(status).toBe(200);
  });

  /* ── An update cannot re-tenant a budget ───────────────────────────────── */

  test("PUT cannot move a budget into another company", async () => {
    const { a, b, budgetA } = await seedTwoCompanies();
    const { status } = await call(`/${budgetA._id}?companyId=${a.company._id}`, {
      method: "PUT",
      body: { name: "Still A's", companyId: b.company._id.toString() },
    });
    expect(status).toBe(200);

    const stored = await Acc_Budget.findById(budgetA._id).lean();
    expect(String(stored.companyId)).toBe(a.company._id.toString());
    expect(stored.name).toBe("Still A's"); // the rest of the update still applied
  });

  test("PUT cannot claim a legacy row into a company either", async () => {
    const { a, legacy } = await seedTwoCompanies();
    const { status } = await call(`/${legacy._id}?companyId=${a.company._id}`, {
      method: "PUT",
      body: { name: "Claimed", companyId: a.company._id.toString() },
    });
    expect(status).toBe(200);

    const stored = await Acc_Budget.findById(legacy._id).lean();
    expect(stored.companyId == null).toBe(true); // adoption needs its own endpoint
  });

  /* ── A rejected update must not mutate ─────────────────────────────────── */

  test("an invalid same-company update is rejected and mutates nothing", async () => {
    const { a, budgetA } = await seedTwoCompanies();
    const before = await Acc_Budget.findById(budgetA._id).lean();

    const { status } = await call(`/${budgetA._id}?companyId=${a.company._id}`, {
      method: "PUT",
      body: { name: "Should not stick", period: "annual" }, // schema says "yearly"
    });
    expect(status).toBe(400);

    const after = await Acc_Budget.findById(budgetA._id).lean();
    expect(after.name).toBe(before.name);
    expect(after.period).toBe(before.period);
  });

  /* ── No company selected: unchanged, permissive, list-consistent ───────── */

  test("with NO company selected, by-id access is unscoped — matching the list", async () => {
    // Not an oversight: the list applies no filter at all when no company is
    // given, and detail must not disagree with it. Recorded as a known
    // remaining risk rather than tightened here, because changing it changes
    // what the LIST shows.
    const { budgetB } = await seedTwoCompanies();
    const { status } = await call(`/${budgetB._id}`);
    expect(status).toBe(200);

    const list = await call("/");
    expect(list.body.budgets.map((x) => String(x._id))).toContain(String(budgetB._id));
  });

  /* ── Malformed id ──────────────────────────────────────────────────────── */

  test("a malformed id is a clean 404 on every by-id route, not a 500", async () => {
    const { a } = await seedTwoCompanies();
    const q = `?companyId=${a.company._id}`;
    expect((await call(`/not-an-id${q}`)).status).toBe(404);
    expect((await call(`/not-an-id${q}`, { method: "PUT", body: { name: "x" } })).status).toBe(404);
    expect((await call(`/not-an-id${q}`, { method: "DELETE" })).status).toBe(404);
    expect(
      (await call(`/not-an-id/submissions${q}`, {
        method: "POST",
        body: { department: "D", requestedAmount: 1 },
      })).status,
    ).toBe(404);
    expect((await call(`/not-an-id/close-collection${q}`, { method: "POST" })).status).toBe(404);
  });
});
