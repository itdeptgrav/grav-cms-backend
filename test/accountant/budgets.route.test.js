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
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");

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
    // `budgetId` is still supplied explicitly so each legacy seed is
    // identifiable in a failure message. The collision that originally forced
    // this — the schema's old `BUD-${Date.now().toString(36)}` default had no
    // random component, so same-millisecond inserts threw on the unique index
    // — is fixed in Acc_OperationalModels.js as of Chunk 1B.
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


/* ─────────────────────────────────────────────────────────────────────────────
 * Chunk 1B — ACTUALS ARE SCOPED TO A COMPANY
 *
 * Every test above this point creates budgets but no POSTED VOUCHERS, so all
 * actuals were zero and a cross-company leak in the aggregation was invisible
 * to the whole suite. These tests post real vouchers in two companies, which
 * is the only way the bug shows up.
 *
 * The bug: evaluate() passed `budget.companyId` straight into hydrateLines.
 * For a legacy row that is undefined, and movementByLedger only filters
 * `if (cid)` — so the aggregation ran unscoped across every company's books.
 * ────────────────────────────────────────────────────────────────────────── */
describe("actuals are scoped to a company", () => {
  let seq = 0;

  /** A posted voucher hitting `ledger` for `amount`, owned by `companyId`. */
  async function postVoucher({ companyId, ledger, amount, type = "Dr" }) {
    return Acc_Voucher.create({
      companyId,
      voucherType: "purchase",
      voucherNumber: `PU/${seq++}/${Date.now()}`,
      voucherDate: new Date("2026-06-15"),
      status: "posted",
      grandTotal: amount,
      ledgerEntries: [
        { ledgerId: ledger._id, ledgerName: ledger.name, type, amount },
      ],
    });
  }

  /**
   * Two companies that share a ledger HEAD id.
   *
   * Sharing the head is what makes the test meaningful: the aggregation
   * matches on ledgerId, so if it fails to filter by company it will happily
   * sum B's voucher into A's budget. With separate heads the leak would be
   * hidden by the ledger filter rather than by the fix.
   */
  async function seedTwoCompaniesWithPostings() {
    const a = await seedCompany();
    const b = await seedCompany();

    // A spends 100000 on its own expense head.
    await postVoucher({ companyId: a.company._id, ledger: a.expenseLedger, amount: 100000 });
    // B spends 777777 on the SAME head id. Must never reach A's budget.
    await postVoucher({ companyId: b.company._id, ledger: a.expenseLedger, amount: 777777 });

    return { a, b };
  }

  /** A budget for `companyId` (or none at all, for the legacy case). */
  async function makeBudget({ companyId, expenseLedger, name }) {
    return Acc_Budget.create({
      budgetId: `BUD-1B-${seq++}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      financialYear: "2026-27",
      period: "yearly",
      status: "draft",
      startDate: new Date("2026-04-01"),
      endDate: new Date("2027-03-31"),
      createdBy: OWNER.id,
      ...(companyId ? { companyId } : {}),
      items: [
        {
          ledgerId: expenseLedger._id,
          ledgerName: expenseLedger.name,
          nature: "expense",
          department: "Logistics",
          allocatedAmount: 1000000,
        },
      ],
    });
  }

  test("sanity: both companies really did post against the same ledger head", async () => {
    const { a, b } = await seedTwoCompaniesWithPostings();
    const all = await Acc_Voucher.find({ "ledgerEntries.ledgerId": a.expenseLedger._id }).lean();
    expect(all).toHaveLength(2);
    expect(all.map((v) => String(v.companyId)).sort()).toEqual(
      [String(a.company._id), String(b.company._id)].sort(),
    );
  });

  /* ── A normal, company-owned budget ────────────────────────────────────── */

  test("a company-owned budget counts ONLY its own company's postings", async () => {
    const { a } = await seedTwoCompaniesWithPostings();
    const budget = await makeBudget({
      companyId: a.company._id,
      expenseLedger: a.expenseLedger,
      name: "A's budget",
    });

    const { status, body } = await call(`/${budget._id}?companyId=${a.company._id}`);
    expect(status).toBe(200);
    // 100000 (A's own), NOT 877777 (both) and NOT 777777 (B's).
    expect(body.budget.items[0].actual).toBe(100000);
    expect(body.budget.totals.expense.actual).toBe(100000);
  });

  /* ── The legacy row: the actual bug ────────────────────────────────────── */

  test("a LEGACY budget is scoped to the REQUEST company, not to every company", async () => {
    const { a } = await seedTwoCompaniesWithPostings();
    const legacy = await makeBudget({
      companyId: null,
      expenseLedger: a.expenseLedger,
      name: "Legacy budget",
    });

    const { status, body } = await call(`/${legacy._id}?companyId=${a.company._id}`);
    expect(status).toBe(200);
    // Before the fix this read 877777 — A's 100000 plus B's 777777.
    expect(body.budget.items[0].actual).toBe(100000);
    expect(body.budget.totals.expense.actual).toBe(100000);
  });

  test("the SAME legacy row read as company B shows B's postings, not A's", async () => {
    const { a, b } = await seedTwoCompaniesWithPostings();
    const legacy = await makeBudget({
      companyId: null,
      expenseLedger: a.expenseLedger,
      name: "Legacy budget",
    });

    const { status, body } = await call(`/${legacy._id}?companyId=${b.company._id}`);
    expect(status).toBe(200);
    // The row is shared by the compatibility rule, but the FIGURES follow
    // whoever is asking — which is the whole product decision here.
    expect(body.budget.items[0].actual).toBe(777777);
  });

  test("reading a legacy budget does not write a companyId onto it", async () => {
    const { a } = await seedTwoCompaniesWithPostings();
    const legacy = await makeBudget({
      companyId: null,
      expenseLedger: a.expenseLedger,
      name: "Legacy budget",
    });

    await call(`/${legacy._id}?companyId=${a.company._id}`);

    const stored = await Acc_Budget.findById(legacy._id).lean();
    expect(stored.companyId == null).toBe(true);
  });

  /* ── The list, which hydrates too ──────────────────────────────────────── */

  test("list totals are company-scoped for both normal and legacy rows", async () => {
    const { a } = await seedTwoCompaniesWithPostings();
    await makeBudget({ companyId: a.company._id, expenseLedger: a.expenseLedger, name: "A's budget" });
    await makeBudget({ companyId: null, expenseLedger: a.expenseLedger, name: "Legacy budget" });

    const { status, body } = await call(`/?companyId=${a.company._id}&withTotals=true`);
    expect(status).toBe(200);
    expect(body.budgets).toHaveLength(2);
    // Neither row may carry B's 777777 — the list hydrates through the same
    // evaluate(), so it had the identical leak.
    for (const b of body.budgets) {
      expect(b.totals.expense.actual).toBe(100000);
    }
  });

  /* ── Arithmetic is untouched ───────────────────────────────────────────── */

  test("nature-aware variance still holds once actuals are real, not zero", async () => {
    const a = await seedCompany();
    // Revenue EARNED is a credit; expense SPENT is a debit.
    await postVoucher({ companyId: a.company._id, ledger: a.revenueLedger, amount: 250000, type: "Cr" });
    await postVoucher({ companyId: a.company._id, ledger: a.expenseLedger, amount: 300000, type: "Dr" });

    const budget = await Acc_Budget.create({
      budgetId: `BUD-1B-VAR-${seq++}`,
      name: "Mixed", financialYear: "2026-27", period: "yearly", status: "draft",
      startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"),
      companyId: a.company._id, createdBy: OWNER.id,
      items: [
        { ledgerId: a.revenueLedger._id, ledgerName: a.revenueLedger.name, nature: "revenue", allocatedAmount: 1000000 },
        { ledgerId: a.expenseLedger._id, ledgerName: a.expenseLedger.name, nature: "expense", allocatedAmount: 1000000 },
      ],
    });

    const { body } = await call(`/${budget._id}?companyId=${a.company._id}&asOf=2027-03-31`);
    const revenue = body.budget.items.find((i) => i.nature === "revenue");
    const expense = body.budget.items.find((i) => i.nature === "expense");

    expect(revenue.actual).toBe(250000);
    expect(expense.actual).toBe(300000);
    // Revenue 750k SHORT of target is adverse; expense 700k UNDER is
    // favourable. Same numbers, opposite verdicts — unchanged by this chunk.
    expect(revenue.variance).toBe(-750000);
    expect(revenue.favourable).toBe(false);
    expect(expense.variance).toBe(700000);
    expect(expense.favourable).toBe(true);
  });
});


/* ─────────────────────────────────────────────────────────────────────────────
 * Chunk 2 — DEPARTMENT BUDGET REQUESTS
 *
 * A department asking for an amount against a head. An INPUT to finance
 * review, not an allocation — the tests below pin that nothing here writes to
 * `items[]`, because a department that could allocate its own budget by
 * asking for it is the failure this whole workflow exists to prevent.
 * ────────────────────────────────────────────────────────────────────────── */
describe("department budget requests", () => {
  let seq = 0;

  async function makeBudget({ companyId, status = "collecting", name = "Requestable" }) {
    return Acc_Budget.create({
      budgetId: `BUD-C2-${seq++}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      financialYear: "2026-27",
      period: "yearly",
      status,
      startDate: new Date("2026-04-01"),
      endDate: new Date("2027-03-31"),
      createdBy: OWNER.id,
      ...(companyId ? { companyId } : {}),
      items: [],
    });
  }

  function validRequest(expenseLedger, over = {}) {
    return {
      department: "Logistics",
      ledgerId: expenseLedger._id.toString(),
      requestedAmount: 250000,
      priority: "high",
      purpose: "Export freight for the Diwali shipping peak",
      ...over,
    };
  }

  /* ── Create ────────────────────────────────────────────────────────────── */

  test("a valid request is created, with the head resolved server-side", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id });

    const { status, body } = await call(`/${budget._id}/requests?companyId=${company._id}`, {
      method: "POST",
      body: validRequest(expenseLedger),
    });

    expect(status).toBe(201);
    expect(body.request.department).toBe("Logistics");
    expect(body.request.requestedAmount).toBe(250000);
    expect(body.request.priority).toBe("high");
    // Name/group/nature are derived from the ledger tree, not trusted from
    // the client — a caller cannot label a freight head "revenue".
    expect(body.request.ledgerName).toBe("Freight & Forwarding");
    expect(body.request.groupName).toBe("Indirect Expenses");
    expect(body.request.nature).toBe("expense");
    expect(body.request.state).toBe("submitted");
    expect(body.request.submittedAt).toBeTruthy();
  });

  test("submittedBy is server-derived and cannot be spoofed by the caller", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id });

    const { body } = await call(`/${budget._id}/requests?companyId=${company._id}`, {
      method: "POST",
      body: validRequest(expenseLedger, { submittedBy: "someone.else@example.com" }),
    });
    expect(body.request.submittedBy).not.toBe("someone.else@example.com");
  });

  test("a request never becomes a budget line — allocation is a separate step", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id });

    await call(`/${budget._id}/requests?companyId=${company._id}`, {
      method: "POST",
      body: validRequest(expenseLedger),
    });

    const stored = await Acc_Budget.findById(budget._id).lean();
    expect(stored.budgetRequests).toHaveLength(1);
    expect(stored.items).toHaveLength(0); // the whole point of Chunk 2 vs 3
    expect(stored.totalAllocated).toBe(0);
  });

  test("the existing submissions array is untouched by a request", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id });

    await call(`/${budget._id}/requests?companyId=${company._id}`, {
      method: "POST",
      body: validRequest(expenseLedger),
    });

    const stored = await Acc_Budget.findById(budget._id).lean();
    expect(stored.submissions || []).toHaveLength(0);
  });

  test("one department can request against several heads — the cardinality submissions cannot hold", async () => {
    const { company, expenseLedger, revenueLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id });
    const q = `?companyId=${company._id}`;

    await call(`/${budget._id}/requests${q}`, { method: "POST", body: validRequest(expenseLedger) });
    await call(`/${budget._id}/requests${q}`, {
      method: "POST",
      body: validRequest(revenueLedger, { purpose: "Export sales target", requestedAmount: 900000 }),
    });

    const { body } = await call(`/${budget._id}/requests${q}`);
    expect(body.requests).toHaveLength(2);
    expect(body.requests.map((r) => r.department)).toEqual(["Logistics", "Logistics"]);
    expect(body.requests.map((r) => r.nature).sort()).toEqual(["expense", "revenue"]);
  });

  /* ── Required fields ───────────────────────────────────────────────────── */

  test.each([
    ["department", { department: "" }],
    ["ledgerId", { ledgerId: "" }],
    ["requestedAmount", { requestedAmount: undefined }],
  ])("a request missing %s is rejected", async (_label, override) => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id });

    const { status } = await call(`/${budget._id}/requests?companyId=${company._id}`, {
      method: "POST",
      body: validRequest(expenseLedger, override),
    });
    expect(status).toBe(400);

    const stored = await Acc_Budget.findById(budget._id).lean();
    expect(stored.budgetRequests || []).toHaveLength(0);
  });

  test("a request with neither purpose nor justification is rejected", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id });

    const { status, body } = await call(`/${budget._id}/requests?companyId=${company._id}`, {
      method: "POST",
      body: validRequest(expenseLedger, { purpose: undefined, justification: undefined }),
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/purpose or justification/i);
  });

  test("justification alone is enough — the two are alternatives", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id });

    const { status } = await call(`/${budget._id}/requests?companyId=${company._id}`, {
      method: "POST",
      body: validRequest(expenseLedger, {
        purpose: undefined,
        justification: "Rates confirmed with the forwarder for Q3.",
      }),
    });
    expect(status).toBe(201);
  });

  /* ── Amount ────────────────────────────────────────────────────────────── */

  test.each([
    ["a negative amount", -1],
    ["a non-numeric amount", "plenty"],
  ])("%s is rejected", async (_label, amount) => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id });

    const { status } = await call(`/${budget._id}/requests?companyId=${company._id}`, {
      method: "POST",
      body: validRequest(expenseLedger, { requestedAmount: amount }),
    });
    expect(status).toBe(400);
  });

  test("zero is a legitimate request — a department asking for nothing on a head", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id });

    const { status } = await call(`/${budget._id}/requests?companyId=${company._id}`, {
      method: "POST",
      body: validRequest(expenseLedger, { requestedAmount: 0 }),
    });
    expect(status).toBe(201);
  });

  test("an invalid priority is rejected rather than silently defaulted", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id });

    const { status } = await call(`/${budget._id}/requests?companyId=${company._id}`, {
      method: "POST",
      body: validRequest(expenseLedger, { priority: "URGENT!!" }),
    });
    expect(status).toBe(400);
  });

  /* ── Budget state ──────────────────────────────────────────────────────── */

  test.each(["draft", "collecting"])(
    "a %s budget accepts requests",
    async (budgetStatus) => {
      const { company, expenseLedger } = await seedCompany();
      const budget = await makeBudget({ companyId: company._id, status: budgetStatus });
      const { status } = await call(`/${budget._id}/requests?companyId=${company._id}`, {
        method: "POST",
        body: validRequest(expenseLedger),
      });
      expect(status).toBe(201);
    },
  );

  test.each(["review", "active", "closed", "exceeded"])(
    "a %s budget refuses new requests with 409",
    async (budgetStatus) => {
      const { company, expenseLedger } = await seedCompany();
      const budget = await makeBudget({ companyId: company._id, status: budgetStatus });

      const { status, body } = await call(`/${budget._id}/requests?companyId=${company._id}`, {
        method: "POST",
        body: validRequest(expenseLedger),
      });
      expect(status).toBe(409);
      expect(body.message).toMatch(new RegExp(budgetStatus, "i"));

      const stored = await Acc_Budget.findById(budget._id).lean();
      expect(stored.budgetRequests || []).toHaveLength(0);
    },
  );

  test("requests stay READABLE on an active budget — only writing is closed", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id, status: "collecting" });
    await call(`/${budget._id}/requests?companyId=${company._id}`, {
      method: "POST",
      body: validRequest(expenseLedger),
    });

    await Acc_Budget.findByIdAndUpdate(budget._id, { status: "active" });

    const { status, body } = await call(`/${budget._id}/requests?companyId=${company._id}`);
    expect(status).toBe(200);
    expect(body.requests).toHaveLength(1);
  });

  /* ── Company scope ─────────────────────────────────────────────────────── */

  test("another company's budget cannot receive a request", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const budgetB = await makeBudget({ companyId: b.company._id });

    const { status } = await call(`/${budgetB._id}/requests?companyId=${a.company._id}`, {
      method: "POST",
      body: validRequest(b.expenseLedger),
    });
    expect(status).toBe(404);

    const stored = await Acc_Budget.findById(budgetB._id).lean();
    expect(stored.budgetRequests || []).toHaveLength(0);
  });

  test("another company's LEDGER cannot be requested against", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const budgetA = await makeBudget({ companyId: a.company._id });

    const { status, body } = await call(`/${budgetA._id}/requests?companyId=${a.company._id}`, {
      method: "POST",
      body: validRequest(b.expenseLedger), // B's head, A's budget
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/not found for this company/i);

    const stored = await Acc_Budget.findById(budgetA._id).lean();
    expect(stored.budgetRequests || []).toHaveLength(0);
  });

  test("another company's budget requests cannot be LISTED", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const budgetB = await makeBudget({ companyId: b.company._id });

    const { status } = await call(`/${budgetB._id}/requests?companyId=${a.company._id}`);
    expect(status).toBe(404);
  });

  /* ── Ledger nature ─────────────────────────────────────────────────────── */

  test("a balance-sheet head is refused — you do not budget Sundry Debtors", async () => {
    const { company } = await seedCompany();
    const assetGroup = await Acc_Group.create({
      companyId: company._id,
      name: "Sundry Debtors",
      nature: "asset",
    });
    const assetLedger = await Acc_Ledger.create({
      companyId: company._id,
      name: "A Buyer Pvt Ltd",
      groupId: assetGroup._id,
      groupName: assetGroup.name,
      nature: "asset",
    });
    const budget = await makeBudget({ companyId: company._id });

    const { status, body } = await call(`/${budget._id}/requests?companyId=${company._id}`, {
      method: "POST",
      body: validRequest(assetLedger),
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/revenue or expense/i);
  });

  /* ── The list is per-budget ────────────────────────────────────────────── */

  test("listing returns only THAT budget's requests", async () => {
    const { company, expenseLedger } = await seedCompany();
    const one = await makeBudget({ companyId: company._id, name: "One" });
    const two = await makeBudget({ companyId: company._id, name: "Two" });
    const q = `?companyId=${company._id}`;

    await call(`/${one._id}/requests${q}`, {
      method: "POST",
      body: validRequest(expenseLedger, { purpose: "For budget one" }),
    });
    await call(`/${two._id}/requests${q}`, {
      method: "POST",
      body: validRequest(expenseLedger, { purpose: "For budget two" }),
    });

    const first = await call(`/${one._id}/requests${q}`);
    expect(first.body.requests).toHaveLength(1);
    expect(first.body.requests[0].purpose).toBe("For budget one");

    const second = await call(`/${two._id}/requests${q}`);
    expect(second.body.requests).toHaveLength(1);
    expect(second.body.requests[0].purpose).toBe("For budget two");
  });

  /* ── Update ────────────────────────────────────────────────────────────── */

  async function seedOneRequest(status = "collecting") {
    const seeded = await seedCompany();
    const budget = await makeBudget({ companyId: seeded.company._id, status });
    const created = await call(`/${budget._id}/requests?companyId=${seeded.company._id}`, {
      method: "POST",
      body: validRequest(seeded.expenseLedger),
    });
    return { ...seeded, budget, request: created.body.request };
  }

  test("a request can be updated while the budget still collects", async () => {
    const { company, budget, request } = await seedOneRequest();
    const { status, body } = await call(
      `/${budget._id}/requests/${request._id}?companyId=${company._id}`,
      { method: "PUT", body: { requestedAmount: 310000, priority: "critical" } },
    );
    expect(status).toBe(200);
    expect(body.request.requestedAmount).toBe(310000);
    expect(body.request.priority).toBe("critical");
    expect(body.request.updatedAt).toBeTruthy();
    // The untouched fields survive a partial update.
    expect(body.request.purpose).toMatch(/Diwali/);
  });

  test.each(["review", "active", "closed"])(
    "a request cannot be updated once the budget is %s",
    async (budgetStatus) => {
      const { company, budget, request } = await seedOneRequest();
      await Acc_Budget.findByIdAndUpdate(budget._id, { status: budgetStatus });

      const { status } = await call(
        `/${budget._id}/requests/${request._id}?companyId=${company._id}`,
        { method: "PUT", body: { requestedAmount: 999999 } },
      );
      expect(status).toBe(409);

      const stored = await Acc_Budget.findById(budget._id).lean();
      expect(stored.budgetRequests[0].requestedAmount).toBe(250000);
    },
  );

  test("an invalid update is rejected and the stored request is untouched", async () => {
    const { company, budget, request } = await seedOneRequest();
    const { status } = await call(
      `/${budget._id}/requests/${request._id}?companyId=${company._id}`,
      { method: "PUT", body: { requestedAmount: -5 } },
    );
    expect(status).toBe(400);

    const stored = await Acc_Budget.findById(budget._id).lean();
    expect(stored.budgetRequests[0].requestedAmount).toBe(250000);
  });

  test("an update cannot move the request onto another company's head", async () => {
    const { company, budget, request } = await seedOneRequest();
    const other = await seedCompany();

    const { status } = await call(
      `/${budget._id}/requests/${request._id}?companyId=${company._id}`,
      { method: "PUT", body: { ledgerId: other.expenseLedger._id.toString() } },
    );
    expect(status).toBe(400);
  });

  test("a request on another company's budget cannot be updated", async () => {
    const { budget, request } = await seedOneRequest();
    const other = await seedCompany();

    const { status } = await call(
      `/${budget._id}/requests/${request._id}?companyId=${other.company._id}`,
      { method: "PUT", body: { requestedAmount: 1 } },
    );
    expect(status).toBe(404);
  });

  test("an unknown requestId is a clean 404, and a malformed one too", async () => {
    const { company, budget } = await seedOneRequest();
    const q = `?companyId=${company._id}`;
    const ghost = new mongoose.Types.ObjectId().toString();

    expect(
      (await call(`/${budget._id}/requests/${ghost}${q}`, { method: "PUT", body: { note: "x" } }))
        .status,
    ).toBe(404);
    expect(
      (await call(`/${budget._id}/requests/not-an-id${q}`, { method: "PUT", body: { note: "x" } }))
        .status,
    ).toBe(404);
  });

  /* ── Delete ────────────────────────────────────────────────────────────── */

  test("an un-negotiated request can be withdrawn", async () => {
    const { company, budget, request } = await seedOneRequest();
    const { status } = await call(
      `/${budget._id}/requests/${request._id}?companyId=${company._id}`,
      { method: "DELETE" },
    );
    expect(status).toBe(200);

    const stored = await Acc_Budget.findById(budget._id).lean();
    expect(stored.budgetRequests).toHaveLength(0);
  });

  test.each([
    ["countered", "counter", { counterAmount: 100000 }],
    ["agreed", "agree", {}],
  ])(
    "a %s request cannot be withdrawn — that would erase finance's side",
    async (_state, action, body) => {
      const { company, budget, request } = await seedOneRequest();
      // Reached through the real finance action. This test used to set `state`
      // via PUT, which Chunk 3 refuses outright — the setup was exploiting the
      // very hole that chunk closed.
      const review = await call(
        `/${budget._id}/requests/${request._id}/${action}?companyId=${company._id}`,
        { method: "POST", body },
      );
      expect(review.status).toBe(200);

      const { status } = await call(
        `/${budget._id}/requests/${request._id}?companyId=${company._id}`,
        { method: "DELETE" },
      );
      expect(status).toBe(409);

      const stored = await Acc_Budget.findById(budget._id).lean();
      expect(stored.budgetRequests).toHaveLength(1);
    },
  );
});


/* ─────────────────────────────────────────────────────────────────────────────
 * Chunk 3 — FINANCE REVIEW & APPROVED ALLOCATIONS
 *
 * Agreeing is the moment an ask becomes money: it writes a real line into
 * items[], which totals, actuals and variance all read. These tests pin both
 * that it happens and that nothing SHORT of it does.
 * ────────────────────────────────────────────────────────────────────────── */
describe("finance review", () => {
  let seq = 0;

  async function setup({ budgetStatus = "collecting" } = {}) {
    const seeded = await seedCompany();
    const budget = await Acc_Budget.create({
      budgetId: `BUD-C3-${seq++}-${Math.random().toString(36).slice(2, 8)}`,
      name: "Reviewable",
      financialYear: "2026-27",
      period: "yearly",
      status: budgetStatus,
      startDate: new Date("2026-04-01"),
      endDate: new Date("2027-03-31"),
      companyId: seeded.company._id,
      createdBy: OWNER.id,
      items: [],
    });
    const q = `?companyId=${seeded.company._id}`;
    const made = await call(`/${budget._id}/requests${q}`, {
      method: "POST",
      body: {
        department: "Logistics",
        ledgerId: seeded.expenseLedger._id.toString(),
        requestedAmount: 300000,
        priority: "high",
        purpose: "Export freight for the Diwali peak",
      },
    });
    return { ...seeded, budget, q, request: made.body.request };
  }

  /* ── The Chunk 2 hole, closed ──────────────────────────────────────────── */

  test.each(["state", "agreedAmount", "counterAmount", "financeNote"])(
    "ordinary PUT cannot set %s",
    async (field) => {
      const { budget, q, request } = await setup();
      const value = field === "state" ? "agreed" : field === "financeNote" ? "ok by me" : 999999;

      const { status, body } = await call(`/${budget._id}/requests/${request._id}${q}`, {
        method: "PUT",
        body: { [field]: value },
      });
      expect(status).toBe(403);
      expect(body.message).toMatch(/finance review/i);

      const stored = await Acc_Budget.findById(budget._id).lean();
      const row = stored.budgetRequests[0];
      expect(row.state).toBe("submitted");
      expect(row[field] == null || row[field] === "submitted").toBe(true);
      // And critically: no allocation was conjured.
      expect(stored.items).toHaveLength(0);
      expect(stored.totalAllocated).toBe(0);
    },
  );

  test("a requester still cannot self-agree even alongside legitimate edits", async () => {
    const { budget, q, request } = await setup();
    const { status } = await call(`/${budget._id}/requests/${request._id}${q}`, {
      method: "PUT",
      body: { purpose: "Updated purpose", state: "agreed", agreedAmount: 500000 },
    });
    expect(status).toBe(403);

    const stored = await Acc_Budget.findById(budget._id).lean();
    // The legitimate half must not sneak through either — the whole write is
    // refused, not partially applied.
    expect(stored.budgetRequests[0].purpose).toMatch(/Diwali/);
    expect(stored.items).toHaveLength(0);
  });

  test("ordinary edits still work — the lockdown is targeted, not a freeze", async () => {
    const { budget, q, request } = await setup();
    const { status, body } = await call(`/${budget._id}/requests/${request._id}${q}`, {
      method: "PUT",
      body: { requestedAmount: 350000, priority: "critical" },
    });
    expect(status).toBe(200);
    expect(body.request.requestedAmount).toBe(350000);
    expect(body.request.priority).toBe("critical");
  });

  /* ── Agree ─────────────────────────────────────────────────────────────── */

  test("agreeing creates an approved allocation carrying the request's head", async () => {
    const { budget, q, request, expenseLedger } = await setup();
    const { status, body } = await call(`/${budget._id}/requests/${request._id}/agree${q}`, {
      method: "POST",
      body: { agreedAmount: 275000, financeNote: "Trimmed to last year's actual." },
    });
    expect(status).toBe(200);
    expect(body.created).toBe(true);

    const stored = await Acc_Budget.findById(budget._id).lean();
    expect(stored.budgetRequests[0].state).toBe("agreed");
    expect(stored.budgetRequests[0].agreedAmount).toBe(275000);
    expect(stored.budgetRequests[0].financeNote).toMatch(/Trimmed/);

    expect(stored.items).toHaveLength(1);
    const item = stored.items[0];
    expect(item.allocatedAmount).toBe(275000);
    expect(String(item.ledgerId)).toBe(String(expenseLedger._id));
    expect(item.ledgerName).toBe("Freight & Forwarding");
    expect(item.groupName).toBe("Indirect Expenses");
    expect(item.nature).toBe("expense");
    expect(item.department).toBe("Logistics");
    expect(String(item.sourceRequestId)).toBe(String(request._id));
    // The reason travels with the line — it explains the number later.
    expect(item.notes).toMatch(/Diwali/);
  });

  test("agreeing without an amount agrees what was requested", async () => {
    const { budget, q, request } = await setup();
    const { status } = await call(`/${budget._id}/requests/${request._id}/agree${q}`, {
      method: "POST",
      body: {},
    });
    expect(status).toBe(200);

    const stored = await Acc_Budget.findById(budget._id).lean();
    expect(stored.budgetRequests[0].agreedAmount).toBe(300000);
    expect(stored.items[0].allocatedAmount).toBe(300000);
  });

  test("totals update when an allocation is approved", async () => {
    const { budget, q, request } = await setup();
    const before = await Acc_Budget.findById(budget._id).lean();
    expect(before.totalAllocated).toBe(0);

    await call(`/${budget._id}/requests/${request._id}/agree${q}`, {
      method: "POST",
      body: { agreedAmount: 275000 },
    });

    const after = await Acc_Budget.findById(budget._id).lean();
    expect(after.totalAllocated).toBe(275000);
    expect(after.totalExpenseAllocated).toBe(275000);
    expect(after.totalRevenueAllocated).toBe(0);
  });

  test("a revenue request allocates to the revenue side of the totals", async () => {
    const seeded = await seedCompany();
    const budget = await Acc_Budget.create({
      budgetId: `BUD-C3-REV-${seq++}`,
      name: "Rev", financialYear: "2026-27", period: "yearly", status: "collecting",
      startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"),
      companyId: seeded.company._id, createdBy: OWNER.id, items: [],
    });
    const q = `?companyId=${seeded.company._id}`;
    const made = await call(`/${budget._id}/requests${q}`, {
      method: "POST",
      body: {
        department: "Sales",
        ledgerId: seeded.revenueLedger._id.toString(),
        requestedAmount: 4000000,
        purpose: "Export target",
      },
    });
    await call(`/${budget._id}/requests/${made.body.request._id}/agree${q}`, {
      method: "POST", body: {},
    });

    const stored = await Acc_Budget.findById(budget._id).lean();
    expect(stored.totalRevenueAllocated).toBe(4000000);
    expect(stored.totalExpenseAllocated).toBe(0);
    expect(stored.items[0].nature).toBe("revenue");
  });

  test("agreeing the SAME request twice updates one line, never duplicates", async () => {
    const { budget, q, request } = await setup();

    await call(`/${budget._id}/requests/${request._id}/agree${q}`, {
      method: "POST", body: { agreedAmount: 300000 },
    });
    const second = await call(`/${budget._id}/requests/${request._id}/agree${q}`, {
      method: "POST", body: { agreedAmount: 400000 },
    });
    expect(second.body.created).toBe(false);

    const stored = await Acc_Budget.findById(budget._id).lean();
    expect(stored.items).toHaveLength(1); // not 2 — and not 700000 allocated
    expect(stored.items[0].allocatedAmount).toBe(400000);
    expect(stored.totalAllocated).toBe(400000);
  });

  test("two SEPARATE requests on the same head stay separate lines", async () => {
    const { budget, q, expenseLedger } = await setup();
    const second = await call(`/${budget._id}/requests${q}`, {
      method: "POST",
      body: {
        department: "Logistics",
        ledgerId: expenseLedger._id.toString(),
        requestedAmount: 50000,
        purpose: "Courier, a different ask entirely",
      },
    });

    const stored0 = await Acc_Budget.findById(budget._id).lean();
    for (const r of stored0.budgetRequests) {
      await call(`/${budget._id}/requests/${r._id}/agree${q}`, { method: "POST", body: {} });
    }

    const stored = await Acc_Budget.findById(budget._id).lean();
    // Same department, same head, two purposes — merging them would erase the
    // distinction the two requests exist to make.
    expect(stored.items).toHaveLength(2);
    expect(stored.totalAllocated).toBe(350000);
    expect(second.status).toBe(201);
  });

  test("an agreed request cannot be ordinary-edited", async () => {
    const { budget, q, request } = await setup();
    await call(`/${budget._id}/requests/${request._id}/agree${q}`, { method: "POST", body: {} });

    const { status, body } = await call(`/${budget._id}/requests/${request._id}${q}`, {
      method: "PUT",
      body: { requestedAmount: 999999 },
    });
    expect(status).toBe(409);
    expect(body.message).toMatch(/reopen/i);

    const stored = await Acc_Budget.findById(budget._id).lean();
    expect(stored.budgetRequests[0].requestedAmount).toBe(300000);
    expect(stored.items[0].allocatedAmount).toBe(300000);
  });

  test("a negative agreed amount is refused and allocates nothing", async () => {
    const { budget, q, request } = await setup();
    const { status } = await call(`/${budget._id}/requests/${request._id}/agree${q}`, {
      method: "POST", body: { agreedAmount: -1 },
    });
    expect(status).toBe(400);

    const stored = await Acc_Budget.findById(budget._id).lean();
    expect(stored.items).toHaveLength(0);
    expect(stored.budgetRequests[0].state).toBe("submitted");
  });

  /* ── Counter ───────────────────────────────────────────────────────────── */

  test("countering records the offer and allocates NOTHING", async () => {
    const { budget, q, request } = await setup();
    const { status, body } = await call(`/${budget._id}/requests/${request._id}/counter${q}`, {
      method: "POST",
      body: { counterAmount: 180000, financeNote: "Can fund 1.8L this cycle." },
    });
    expect(status).toBe(200);
    expect(body.request.state).toBe("countered");
    expect(body.request.counterAmount).toBe(180000);

    const stored = await Acc_Budget.findById(budget._id).lean();
    // A counter is an open question. Money must not move on one side of a
    // conversation.
    expect(stored.items).toHaveLength(0);
    expect(stored.totalAllocated).toBe(0);
    expect(stored.budgetRequests[0].financeNote).toMatch(/1.8L/);
  });

  test("a counter without an amount is refused", async () => {
    const { budget, q, request } = await setup();
    const { status } = await call(`/${budget._id}/requests/${request._id}/counter${q}`, {
      method: "POST", body: { financeNote: "too much" },
    });
    expect(status).toBe(400);
  });

  test("a countered request can then be agreed, and only then allocates", async () => {
    const { budget, q, request } = await setup();
    await call(`/${budget._id}/requests/${request._id}/counter${q}`, {
      method: "POST", body: { counterAmount: 180000 },
    });
    await call(`/${budget._id}/requests/${request._id}/agree${q}`, {
      method: "POST", body: { agreedAmount: 180000 },
    });

    const stored = await Acc_Budget.findById(budget._id).lean();
    expect(stored.budgetRequests[0].state).toBe("agreed");
    expect(stored.items).toHaveLength(1);
    expect(stored.totalAllocated).toBe(180000);
  });

  /* ── Reopen ────────────────────────────────────────────────────────────── */

  test("reopening WITHDRAWS the allocation — money never approved must not linger", async () => {
    const { budget, q, request } = await setup();
    await call(`/${budget._id}/requests/${request._id}/agree${q}`, {
      method: "POST", body: { agreedAmount: 275000 },
    });

    const { status, body } = await call(`/${budget._id}/requests/${request._id}/reopen${q}`, {
      method: "POST", body: {},
    });
    expect(status).toBe(200);
    expect(body.withdrewAllocations).toBe(1);

    const stored = await Acc_Budget.findById(budget._id).lean();
    expect(stored.budgetRequests[0].state).toBe("submitted");
    expect(stored.budgetRequests[0].agreedAmount == null).toBe(true);
    expect(stored.items).toHaveLength(0);
    expect(stored.totalAllocated).toBe(0);
  });

  test("reopening frees the request for ordinary editing again", async () => {
    const { budget, q, request } = await setup();
    await call(`/${budget._id}/requests/${request._id}/agree${q}`, { method: "POST", body: {} });
    await call(`/${budget._id}/requests/${request._id}/reopen${q}`, { method: "POST", body: {} });

    const { status } = await call(`/${budget._id}/requests/${request._id}${q}`, {
      method: "PUT", body: { requestedAmount: 120000 },
    });
    expect(status).toBe(200);
  });

  test("reopening leaves hand-written lines alone — only the linked one goes", async () => {
    const { budget, q, request, expenseLedger } = await setup();
    // A line nobody requested, added by finance directly.
    await Acc_Budget.findByIdAndUpdate(budget._id, {
      $push: {
        items: {
          ledgerId: expenseLedger._id,
          ledgerName: expenseLedger.name,
          nature: "expense",
          department: "Admin",
          allocatedAmount: 90000,
        },
      },
    });

    await call(`/${budget._id}/requests/${request._id}/agree${q}`, { method: "POST", body: {} });
    await call(`/${budget._id}/requests/${request._id}/reopen${q}`, { method: "POST", body: {} });

    const stored = await Acc_Budget.findById(budget._id).lean();
    expect(stored.items).toHaveLength(1);
    expect(stored.items[0].department).toBe("Admin");
    expect(stored.totalAllocated).toBe(90000);
  });

  /* ── Budget state gates ────────────────────────────────────────────────── */

  test("finance CAN review while the budget is in `review` — unlike departments", async () => {
    const { budget, q, request } = await setup({ budgetStatus: "collecting" });
    await Acc_Budget.findByIdAndUpdate(budget._id, { status: "review" });

    // A department may no longer add requests…
    const deptAttempt = await call(`/${budget._id}/requests${q}`, {
      method: "POST",
      body: { department: "X", ledgerId: request.ledgerId, requestedAmount: 1, purpose: "p" },
    });
    expect(deptAttempt.status).toBe(409);

    // …but finance must still be able to act on the ones already in.
    const { status } = await call(`/${budget._id}/requests/${request._id}/agree${q}`, {
      method: "POST", body: {},
    });
    expect(status).toBe(200);
  });

  test.each(["active", "closed", "exceeded"])(
    "finance review is refused once the budget is %s",
    async (budgetStatus) => {
      const { budget, q, request } = await setup();
      await Acc_Budget.findByIdAndUpdate(budget._id, { status: budgetStatus });

      for (const action of ["agree", "counter", "reopen"]) {
        const { status } = await call(
          `/${budget._id}/requests/${request._id}/${action}${q}`,
          { method: "POST", body: { counterAmount: 1 } },
        );
        expect(status).toBe(409);
      }

      const stored = await Acc_Budget.findById(budget._id).lean();
      expect(stored.items).toHaveLength(0);
    },
  );

  /* ── Company scope ─────────────────────────────────────────────────────── */

  test.each(["agree", "counter", "reopen"])(
    "another company cannot %s a request",
    async (action) => {
      const { budget, request } = await setup();
      const other = await seedCompany();

      const { status } = await call(
        `/${budget._id}/requests/${request._id}/${action}?companyId=${other.company._id}`,
        { method: "POST", body: { counterAmount: 1 } },
      );
      expect(status).toBe(404);

      const stored = await Acc_Budget.findById(budget._id).lean();
      expect(stored.items).toHaveLength(0);
      expect(stored.budgetRequests[0].state).toBe("submitted");
    },
  );

  test("an unknown or malformed requestId is a clean 404 on every review action", async () => {
    const { budget, q } = await setup();
    const ghost = new mongoose.Types.ObjectId().toString();
    for (const action of ["agree", "counter", "reopen"]) {
      expect(
        (await call(`/${budget._id}/requests/${ghost}/${action}${q}`, { method: "POST", body: { counterAmount: 1 } })).status,
      ).toBe(404);
      expect(
        (await call(`/${budget._id}/requests/not-an-id/${action}${q}`, { method: "POST", body: { counterAmount: 1 } })).status,
      ).toBe(404);
    }
  });

  /* ── Arithmetic is still arithmetic ────────────────────────────────────── */

  test("an approved allocation behaves like any other line for actuals and variance", async () => {
    const { company, budget, q, request, expenseLedger } = await setup();
    await call(`/${budget._id}/requests/${request._id}/agree${q}`, {
      method: "POST", body: { agreedAmount: 300000 },
    });

    // Real spend against that head, in this company.
    await Acc_Voucher.create({
      companyId: company._id,
      voucherType: "purchase",
      voucherNumber: `PU/C3/${seq++}`,
      voucherDate: new Date("2026-06-15"),
      status: "posted",
      grandTotal: 120000,
      ledgerEntries: [
        { ledgerId: expenseLedger._id, ledgerName: expenseLedger.name, type: "Dr", amount: 120000 },
      ],
    });

    const { body } = await call(`/${budget._id}${q}&asOf=2027-03-31`);
    const line = body.budget.items[0];
    expect(line.allocated).toBe(300000);
    expect(line.actual).toBe(120000); // recomputed from the voucher, not stored
    // Expense under budget is favourable — unchanged by where the line came from.
    expect(line.variance).toBe(180000);
    expect(line.favourable).toBe(true);
  });
});
