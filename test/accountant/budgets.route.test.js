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

/* A real owner, as AccountantAuthMiddleware would issue one: owner role,
 * canEdit AND canApprove. The fixture used to carry canEdit alone, which
 * meant every finance action in this file was being exercised by a user who
 * — once the authorization guards landed — is not allowed to perform one. */
const OWNER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner",
  email: "priya.owner@example.com",
  role: "owner",
  permissions: { canEdit: true, canApprove: true, canPostDirectly: true },
};

/* The two roles the guards actually separate. An editor may raise anything and
 * approve nothing; a viewer may not even raise. */
const EDITOR = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Sam Editor",
  email: "sam.editor@example.com",
  role: "editor",
  permissions: { canEdit: true },
};
const VIEWER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Vik Viewer",
  email: "vik.viewer@example.com",
  role: "viewer",
  permissions: { canView: true },
};
/* An approver who is NOT the owner — the only role the four-eyes rule can
 * actually bite, since the owner is exempt by design. */
const APPROVER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Anu Approver",
  email: "anu.approver@example.com",
  role: "approver",
  permissions: { canEdit: true, canApprove: true },
};

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

/* ─────────────────────────────────────────────────────────────────────────────
 * CHUNK 4 — DASHBOARD / VARIANCE VIEW
 *
 * The dashboard is a read across MANY budgets, which is exactly where the
 * guarantees the by-id routes already prove can quietly stop holding: company
 * scoping has to survive a fan-out, legacy budgets have to keep falling back
 * to the caller's company, and actuals still have to come from posted vouchers
 * rather than the cached figures on the documents.
 * ────────────────────────────────────────────────────────────────────────── */
describe("dashboard", () => {
  let seq = 0;

  async function postVoucher({ companyId, ledger, amount, type = "Dr", date = "2026-06-15" }) {
    return Acc_Voucher.create({
      companyId,
      voucherType: type === "Cr" ? "sales" : "purchase",
      voucherNumber: `DB/${seq++}/${Date.now()}`,
      voucherDate: new Date(date),
      status: "posted",
      grandTotal: amount,
      ledgerEntries: [{ ledgerId: ledger._id, ledgerName: ledger.name, type, amount }],
    });
  }

  /** A budget with whatever lines the caller wants, for a full FY. */
  async function makeBudget({ companyId, name, items, status = "active" }) {
    return Acc_Budget.create({
      name,
      financialYear: "2026-27",
      period: "yearly",
      status,
      startDate: new Date("2026-04-01"),
      endDate: new Date("2027-03-31"),
      ...(companyId ? { companyId } : {}),
      items,
    });
  }

  const dash = (companyId, extra = "") =>
    call(`/dashboard?companyId=${companyId}${extra}`);

  /* ── totals ───────────────────────────────────────────────────────────── */

  test("totals cover expense and revenue, recomputed from posted vouchers", async () => {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    await makeBudget({
      companyId: company._id,
      name: "FY26-27",
      items: [
        { ledgerId: expenseLedger._id, nature: "expense", department: "Logistics", allocatedAmount: 500000 },
        { ledgerId: revenueLedger._id, nature: "revenue", department: "Sales", allocatedAmount: 4000000 },
      ],
    });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 120000 });
    await postVoucher({ companyId: company._id, ledger: revenueLedger, amount: 1000000, type: "Cr" });

    const { status, body } = await dash(company._id, "&asOf=2027-03-31");
    expect(status).toBe(200);

    expect(body.totals.expense.allocated).toBe(500000);
    expect(body.totals.expense.actual).toBe(120000);
    expect(body.totals.expenseRemaining).toBe(380000);

    expect(body.totals.revenue.allocated).toBe(4000000);
    expect(body.totals.revenue.actual).toBe(1000000);
    expect(body.totals.revenueToGo).toBe(3000000);

    expect(body.totals.budgetedNet).toBe(3500000);
    expect(body.totals.actualNet).toBe(880000);
    expect(body.totals.netVariance).toBe(880000 - 3500000);
    expect(body.totals.budgetCount).toBe(1);
    expect(body.totals.lineCount).toBe(2);
  });

  test("totals add up across several budgets, not just one", async () => {
    const { company, expenseLedger } = await seedCompany();
    await makeBudget({
      companyId: company._id, name: "A",
      items: [{ ledgerId: expenseLedger._id, nature: "expense", department: "Logistics", allocatedAmount: 200000 }],
    });
    await makeBudget({
      companyId: company._id, name: "B",
      items: [{ ledgerId: expenseLedger._id, nature: "expense", department: "Admin", allocatedAmount: 300000 }],
    });

    const { body } = await dash(company._id, "&asOf=2027-03-31");
    expect(body.totals.expense.allocated).toBe(500000);
    expect(body.totals.budgetCount).toBe(2);
    expect(body.budgets).toHaveLength(2);
  });

  test("an empty dashboard is zeroes and empty lists, not a crash", async () => {
    const { company } = await seedCompany();
    const { status, body } = await dash(company._id);
    expect(status).toBe(200);
    expect(body.totals.expense.allocated).toBe(0);
    expect(body.totals.revenue.allocated).toBe(0);
    expect(body.totals.budgetCount).toBe(0);
    expect(body.byDepartment).toEqual([]);
    expect(body.byHead).toEqual([]);
    expect(body.budgets).toEqual([]);
    expect(body.attention.count).toBe(0);
    expect(body.truncated).toBeNull();
  });

  /* ── grouping ─────────────────────────────────────────────────────────── */

  test("department grouping splits allocation, actual and remaining per department", async () => {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    await makeBudget({
      companyId: company._id, name: "FY26-27",
      items: [
        { ledgerId: expenseLedger._id, nature: "expense", department: "Logistics", allocatedAmount: 500000 },
        { ledgerId: revenueLedger._id, nature: "revenue", department: "Sales", allocatedAmount: 4000000 },
      ],
    });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 120000 });

    const { body } = await dash(company._id, "&asOf=2027-03-31");
    const logistics = body.byDepartment.find((d) => d.department === "Logistics");
    const sales = body.byDepartment.find((d) => d.department === "Sales");

    expect(logistics.expense.allocated).toBe(500000);
    expect(logistics.expense.actual).toBe(120000);
    expect(logistics.expenseRemaining).toBe(380000);
    expect(sales.revenue.allocated).toBe(4000000);
    expect(sales.revenueToGo).toBe(4000000);
  });

  test("a line with no department groups under Unassigned rather than vanishing", async () => {
    const { company, expenseLedger } = await seedCompany();
    await makeBudget({
      companyId: company._id, name: "FY26-27",
      items: [{ ledgerId: expenseLedger._id, nature: "expense", allocatedAmount: 100000 }],
    });
    const { body } = await dash(company._id, "&asOf=2027-03-31");
    expect(body.byDepartment.map((d) => d.department)).toContain("Unassigned");
    expect(body.totals.expense.allocated).toBe(100000);
  });

  test("head grouping merges the same ledger across budgets and names both", async () => {
    const { company, expenseLedger } = await seedCompany();
    await makeBudget({
      companyId: company._id, name: "A",
      items: [{ ledgerId: expenseLedger._id, nature: "expense", department: "Logistics", allocatedAmount: 200000 }],
    });
    await makeBudget({
      companyId: company._id, name: "B",
      items: [{ ledgerId: expenseLedger._id, nature: "expense", department: "Admin", allocatedAmount: 300000 }],
    });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 50000 });

    const { body } = await dash(company._id, "&asOf=2027-03-31");
    const head = body.byHead.find((h) => h.ledgerName === "Freight & Forwarding");

    expect(head.lineCount).toBe(2);
    expect(head.allocated).toBe(500000);
    expect(head.groupName).toBe("Indirect Expenses");
    expect(head.budgets.map((b) => b.name).sort()).toEqual(["A", "B"]);
    // Two budgets naming different departments for one head says so.
    expect(head.department).toBe("Multiple");
    expect(head.utilizationPct).toBeCloseTo((head.actual / 500000) * 100, 6);
  });

  test("head rows carry the full variance vocabulary the detail view uses", async () => {
    const { company, expenseLedger } = await seedCompany();
    await makeBudget({
      companyId: company._id, name: "FY26-27",
      items: [{ ledgerId: expenseLedger._id, nature: "expense", department: "Logistics", allocatedAmount: 400000 }],
    });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 100000 });

    const { body } = await dash(company._id, "&asOf=2027-03-31");
    const head = body.byHead[0];
    for (const field of [
      "ledgerId", "ledgerName", "groupName", "department", "nature",
      "allocated", "actual", "expectedToDate", "remaining", "toGo",
      "variance", "utilizationPct", "pace", "severity",
    ]) {
      expect(head).toHaveProperty(field);
    }
    expect(head.remaining).toBe(300000);
    expect(head.toGo).toBeNull(); // expense has no "to go"
  });

  /* ── company scoping ──────────────────────────────────────────────────── */

  test("another company's budgets never appear, and never move the totals", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    await makeBudget({
      companyId: a.company._id, name: "A's budget",
      items: [{ ledgerId: a.expenseLedger._id, nature: "expense", department: "Logistics", allocatedAmount: 100000 }],
    });
    await makeBudget({
      companyId: b.company._id, name: "B's budget",
      items: [{ ledgerId: b.expenseLedger._id, nature: "expense", department: "Logistics", allocatedAmount: 999999 }],
    });

    const { body } = await dash(a.company._id, "&asOf=2027-03-31");
    expect(body.budgets.map((x) => x.name)).toEqual(["A's budget"]);
    expect(body.totals.expense.allocated).toBe(100000);
  });

  test("a legacy budget with no companyId reads ONLY the selected company's postings", async () => {
    const a = await seedCompany();
    const b = await seedCompany();

    // Both companies post against the SAME head id. Without company scoping on
    // the actuals, B's spend lands in A's dashboard.
    await postVoucher({ companyId: a.company._id, ledger: a.expenseLedger, amount: 100000 });
    await postVoucher({ companyId: b.company._id, ledger: a.expenseLedger, amount: 777777 });

    await makeBudget({
      companyId: null, name: "Legacy — no companyId",
      items: [{ ledgerId: a.expenseLedger._id, nature: "expense", department: "Logistics", allocatedAmount: 500000 }],
    });

    const { body } = await dash(a.company._id, "&asOf=2027-03-31");
    expect(body.budgets.map((x) => x.name)).toEqual(["Legacy — no companyId"]);
    expect(body.totals.expense.actual).toBe(100000);
    expect(body.totals.expense.actual).not.toBe(877777);
  });

  /* ── filters ──────────────────────────────────────────────────────────── */

  test("financialYear, status and period filters all narrow the dashboard", async () => {
    const { company, expenseLedger } = await seedCompany();
    const line = [{ ledgerId: expenseLedger._id, nature: "expense", department: "Logistics", allocatedAmount: 100000 }];
    await makeBudget({ companyId: company._id, name: "Active", items: line, status: "active" });
    await makeBudget({ companyId: company._id, name: "Draft", items: line, status: "draft" });

    const active = await dash(company._id, "&status=active&asOf=2027-03-31");
    expect(active.body.budgets.map((b) => b.name)).toEqual(["Active"]);
    expect(active.body.totals.expense.allocated).toBe(100000);

    const fy = await dash(company._id, "&financialYear=2026-27&asOf=2027-03-31");
    expect(fy.body.budgets).toHaveLength(2);

    const otherFy = await dash(company._id, "&financialYear=2099-00&asOf=2027-03-31");
    expect(otherFy.body.budgets).toHaveLength(0);

    const yearly = await dash(company._id, "&period=yearly&asOf=2027-03-31");
    expect(yearly.body.budgets).toHaveLength(2);
  });

  test("a bad period or status is a clean 400, not a 500", async () => {
    const { company } = await seedCompany();
    const bad = await dash(company._id, "&period=annual");
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/period must be one of/i);

    const badStatus = await dash(company._id, "&status=expired");
    expect(badStatus.status).toBe(400);

    const badDate = await dash(company._id, "&asOf=not-a-date");
    expect(badDate.status).toBe(400);
  });

  test("the department filter narrows the LINES, not just the budgets", async () => {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    await makeBudget({
      companyId: company._id, name: "FY26-27",
      items: [
        { ledgerId: expenseLedger._id, nature: "expense", department: "Logistics", allocatedAmount: 500000 },
        { ledgerId: revenueLedger._id, nature: "revenue", department: "Sales", allocatedAmount: 4000000 },
      ],
    });

    const { body } = await dash(company._id, "&department=Logistics&asOf=2027-03-31");
    expect(body.budgets).toHaveLength(1);
    // Without line-level filtering this would still report Sales' 40L target.
    expect(body.totals.revenue.allocated).toBe(0);
    expect(body.totals.expense.allocated).toBe(500000);
    expect(body.byDepartment.map((d) => d.department)).toEqual(["Logistics"]);
  });

  /* ── attention lists ──────────────────────────────────────────────────── */

  test("an over-budget expense line lands in the overBudget list", async () => {
    const { company, expenseLedger } = await seedCompany();
    await makeBudget({
      companyId: company._id, name: "FY26-27",
      items: [{ ledgerId: expenseLedger._id, nature: "expense", department: "Logistics", allocatedAmount: 100000 }],
    });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 150000 });

    const { body } = await dash(company._id, "&asOf=2027-03-31");
    expect(body.attention.overBudget).toHaveLength(1);

    const hit = body.attention.overBudget[0];
    expect(hit.ledgerName).toBe("Freight & Forwarding");
    expect(hit.budgetName).toBe("FY26-27");
    expect(hit.actual).toBe(150000);
    expect(hit.variance).toBe(-50000);
    expect(hit.pace).toBe("over_budget");
    expect(hit.severity).toBe("critical");

    // Reported once, in the louder list — not also under high utilisation.
    expect(body.attention.highUtilization).toHaveLength(0);
  });

  test("a revenue line behind pace lands in the revenueBehind list", async () => {
    const { company, revenueLedger } = await seedCompany();
    await makeBudget({
      companyId: company._id, name: "FY26-27",
      items: [{ ledgerId: revenueLedger._id, nature: "revenue", department: "Sales", allocatedAmount: 4000000 }],
    });
    // Half the year gone, a tenth of the target earned.
    await postVoucher({ companyId: company._id, ledger: revenueLedger, amount: 400000, type: "Cr" });

    const { body } = await dash(company._id, "&asOf=2026-10-01");
    expect(body.attention.revenueBehind).toHaveLength(1);

    const hit = body.attention.revenueBehind[0];
    expect(hit.nature).toBe("revenue");
    expect(hit.pace).toBe("behind");
    expect(hit.actual).toBe(400000);
    expect(hit.toGo).toBe(3600000);
    expect(hit.severity).toBe("critical");
    expect(body.attention.overBudget).toHaveLength(0);
  });

  test("a revenue line that has earned NOTHING is behind, not invisible", async () => {
    const { company, revenueLedger } = await seedCompany();
    await makeBudget({
      companyId: company._id, name: "FY26-27",
      items: [{ ledgerId: revenueLedger._id, nature: "revenue", department: "Sales", allocatedAmount: 4000000 }],
    });
    // No revenue voucher at all, half the period gone. paceState calls this
    // "not_started" rather than "behind" — matching only "behind" hid the
    // worst case there is.
    const { body } = await dash(company._id, "&asOf=2026-10-01");
    expect(body.attention.revenueBehind).toHaveLength(1);
    expect(body.attention.revenueBehind[0].pace).toBe("not_started");
    expect(body.attention.revenueBehind[0].actual).toBe(0);
  });

  test("a high-utilisation expense line that is NOT yet over budget is flagged separately", async () => {
    const { company, expenseLedger } = await seedCompany();
    await makeBudget({
      companyId: company._id, name: "FY26-27",
      items: [{ ledgerId: expenseLedger._id, nature: "expense", department: "Logistics", allocatedAmount: 100000 }],
    });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 95000 });

    const { body } = await dash(company._id, "&asOf=2027-03-31");
    expect(body.attention.overBudget).toHaveLength(0);
    expect(body.attention.highUtilization).toHaveLength(1);
    expect(body.attention.highUtilization[0].utilizationPct).toBe(95);
  });

  test("an unbound legacy line appears in the unbound list and reads zero actual", async () => {
    const { company } = await seedCompany();
    await makeBudget({
      companyId: company._id, name: "Marketing — legacy",
      items: [{ nature: "expense", category: "marketing", allocatedAmount: 200000 }],
    });

    const { body } = await dash(company._id, "&asOf=2027-03-31");
    expect(body.attention.unbound).toHaveLength(1);
    expect(body.attention.unbound[0].ledgerId).toBeNull();
    expect(body.attention.unbound[0].actual).toBe(0);
    // It still counts toward what was allocated — it is real money planned.
    expect(body.totals.expense.allocated).toBe(200000);
  });

  test("a budget with no approved allocations is flagged, with its request count", async () => {
    const { company, expenseLedger } = await seedCompany();
    const empty = await makeBudget({ companyId: company._id, name: "Nothing approved yet", items: [], status: "collecting" });
    await Acc_Budget.updateOne(
      { _id: empty._id },
      {
        $push: {
          budgetRequests: {
            department: "Logistics",
            ledgerId: expenseLedger._id,
            ledgerName: expenseLedger.name,
            nature: "expense",
            requestedAmount: 320000,
            state: "submitted",
          },
        },
      },
    );

    const { body } = await dash(company._id, "&asOf=2027-03-31");
    expect(body.attention.noAllocations).toHaveLength(1);

    const hit = body.attention.noAllocations[0];
    expect(hit.name).toBe("Nothing approved yet");
    expect(hit.requestCount).toBe(1);
    expect(hit.pendingRequestCount).toBe(1);
  });

  test("agreeing a request removes the budget from the no-allocations list", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id, name: "Collecting", items: [], status: "collecting" });
    const q = `?companyId=${company._id}`;

    const created = await call(`/${budget._id}/requests${q}`, {
      method: "POST",
      body: {
        department: "Logistics",
        ledgerId: expenseLedger._id.toString(),
        requestedAmount: 320000,
        purpose: "Export freight for the Diwali shipping peak",
      },
    });
    expect(created.status).toBe(201);

    const before = await dash(company._id, "&asOf=2027-03-31");
    expect(before.body.attention.noAllocations).toHaveLength(1);

    const agreed = await call(
      `/${budget._id}/requests/${created.body.request._id}/agree${q}`,
      { method: "POST", body: { agreedAmount: 300000 } },
    );
    expect(agreed.status).toBe(200);

    const after = await dash(company._id, "&asOf=2027-03-31");
    expect(after.body.attention.noAllocations).toHaveLength(0);
    expect(after.body.totals.expense.allocated).toBe(300000);
    expect(after.body.byDepartment.find((d) => d.department === "Logistics").expense.allocated).toBe(300000);
  });

  test("the attention count is the sum of every list", async () => {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    await makeBudget({
      companyId: company._id, name: "FY26-27",
      items: [
        { ledgerId: expenseLedger._id, nature: "expense", department: "Logistics", allocatedAmount: 100000 },
        { ledgerId: revenueLedger._id, nature: "revenue", department: "Sales", allocatedAmount: 4000000 },
        { nature: "expense", category: "marketing", department: "Marketing", allocatedAmount: 50000 },
      ],
    });
    await makeBudget({ companyId: company._id, name: "Empty", items: [] });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 150000 });

    const { body } = await dash(company._id, "&asOf=2026-10-01");
    const a = body.attention;
    expect(a.count).toBe(
      a.overBudget.length + a.revenueBehind.length + a.highUtilization.length +
      a.unbound.length + a.noAllocations.length,
    );
    expect(a.overBudget).toHaveLength(1);
    expect(a.revenueBehind).toHaveLength(1);
    expect(a.unbound).toHaveLength(1);
    expect(a.noAllocations).toHaveLength(1);
  });

  /* ── budget list summary ──────────────────────────────────────────────── */

  test("each budget summary carries its own totals and worst severity", async () => {
    const { company, expenseLedger } = await seedCompany();
    await makeBudget({
      companyId: company._id, name: "Healthy",
      items: [{ ledgerId: expenseLedger._id, nature: "expense", department: "Admin", allocatedAmount: 1000000 }],
    });
    const sick = await makeBudget({
      companyId: company._id, name: "Blown",
      items: [{ ledgerId: expenseLedger._id, nature: "expense", department: "Logistics", allocatedAmount: 10000 }],
    });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 50000 });

    const { body } = await dash(company._id, "&asOf=2027-03-31");
    const blown = body.budgets.find((b) => b.name === "Blown");

    expect(String(blown._id)).toBe(String(sick._id));
    expect(blown.status).toBe("active");
    expect(blown.period).toBe("yearly");
    expect(blown.financialYear).toBe("2026-27");
    expect(blown.startDate).toBeTruthy();
    expect(blown.endDate).toBeTruthy();
    expect(blown.totals.expense.allocated).toBe(10000);
    expect(blown.severity).toBe("critical");
    expect(blown.lineCount).toBe(1);
  });

  test("dashboard figures agree with the same budget's detail view", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({
      companyId: company._id, name: "FY26-27",
      items: [{ ledgerId: expenseLedger._id, nature: "expense", department: "Logistics", allocatedAmount: 400000 }],
    });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 250000 });

    const detail = await call(`/${budget._id}?companyId=${company._id}&asOf=2027-03-31`);
    const { body } = await dash(company._id, "&asOf=2027-03-31");

    expect(body.totals.expense.actual).toBe(detail.body.budget.totals.expense.actual);
    expect(body.totals.expense.allocated).toBe(detail.body.budget.totals.expense.allocated);
    expect(body.byHead[0].severity).toBe(detail.body.budget.items[0].severity);
    expect(body.byHead[0].pace).toBe(detail.body.budget.items[0].pace);
  });

  /* ── auth ─────────────────────────────────────────────────────────────── */

  test("the dashboard requires authentication like every other budget route", async () => {
    const { company } = await seedCompany();
    const { status } = await call(`/dashboard?companyId=${company._id}`, { user: null });
    expect(status).toBe(401);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * CHUNK 5 — VOUCHER DRILLDOWN
 *
 * The property that matters is not "the endpoint returns vouchers" — it is
 * that the vouchers it returns ADD UP to the number the budget already showed.
 * A drilldown that disagrees with the figure above it is worse than none: it
 * teaches people the budget is wrong. Most of what follows is that one
 * assertion, approached from the angles where the two reads could drift apart.
 * ────────────────────────────────────────────────────────────────────────── */
describe("budget line voucher drilldown", () => {
  let seq = 0;

  async function postVoucher({
    companyId, ledger, amount, type = "Dr",
    date = "2026-06-15", status = "posted", isOptional = false,
    party = "Northline Facilities Management", narration = "Export freight",
  }) {
    return Acc_Voucher.create({
      companyId,
      voucherType: type === "Cr" ? "sales" : "purchase",
      voucherNumber: `DD/${seq++}/${Date.now()}`,
      voucherDate: new Date(date),
      status,
      isOptional,
      partyLedgerName: party,
      narration,
      grandTotal: amount,
      ledgerEntries: [{ ledgerId: ledger._id, ledgerName: ledger.name, type, amount }],
    });
  }

  async function makeBudget({ companyId, ledger, allocated = 500000, nature = "expense" }) {
    return Acc_Budget.create({
      name: "FY26-27",
      financialYear: "2026-27",
      period: "yearly",
      status: "active",
      startDate: new Date("2026-04-01"),
      endDate: new Date("2027-03-31"),
      ...(companyId ? { companyId } : {}),
      items: [
        ...(ledger
          ? [{ ledgerId: ledger._id, nature, department: "Logistics", allocatedAmount: allocated }]
          : [{ nature, category: "marketing", department: "Marketing", allocatedAmount: allocated }]),
      ],
    });
  }

  const drill = (budget, itemId, companyId, extra = "") =>
    call(`/${budget._id}/items/${itemId}/vouchers?companyId=${companyId}${extra}`);

  /* ── the one property ─────────────────────────────────────────────────── */

  test("the drilldown total matches the budget line's evaluated actual", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id, ledger: expenseLedger });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 120000 });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 90000, date: "2026-08-02" });

    const detail = await call(`/${budget._id}?companyId=${company._id}&asOf=2027-03-31`);
    const line = detail.body.budget.items[0];

    const { status, body } = await drill(budget, line._id, company._id);
    expect(status).toBe(200);
    expect(body.totals.actual).toBe(line.actual);
    expect(body.totals.actual).toBe(210000);
    expect(body.totals.voucherCount).toBe(2);
    expect(body.vouchers).toHaveLength(2);
    // And the rows themselves add up to the total they sit under.
    expect(body.vouchers.reduce((s, v) => s + v.actualContribution, 0)).toBe(body.totals.actual);
  });

  test("a voucher touching the same head twice is ONE row and ONE count", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id, ledger: expenseLedger });
    // A split allocation across the same head — movementByLedger counts the
    // voucher once via $addToSet, so the drilldown must too.
    await Acc_Voucher.create({
      companyId: company._id,
      voucherType: "purchase",
      voucherNumber: `DD/SPLIT/${Date.now()}`,
      voucherDate: new Date("2026-06-15"),
      status: "posted",
      grandTotal: 50000,
      ledgerEntries: [
        { ledgerId: expenseLedger._id, ledgerName: expenseLedger.name, type: "Dr", amount: 30000 },
        { ledgerId: expenseLedger._id, ledgerName: expenseLedger.name, type: "Dr", amount: 20000 },
      ],
    });

    const detail = await call(`/${budget._id}?companyId=${company._id}&asOf=2027-03-31`);
    const line = detail.body.budget.items[0];
    const { body } = await drill(budget, line._id, company._id);

    expect(body.vouchers).toHaveLength(1);
    expect(body.vouchers[0].debit).toBe(50000);
    expect(body.totals.voucherCount).toBe(line.voucherCount);
    expect(body.totals.actual).toBe(line.actual);
  });

  /* ── what must not be counted ─────────────────────────────────────────── */

  test("another company's voucher on the same head id is excluded", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const budget = await makeBudget({ companyId: a.company._id, ledger: a.expenseLedger });

    await postVoucher({ companyId: a.company._id, ledger: a.expenseLedger, amount: 100000 });
    // B posts to the SAME head id. Sharing the head is what makes this
    // meaningful — with separate heads the ledger filter would hide the leak.
    await postVoucher({ companyId: b.company._id, ledger: a.expenseLedger, amount: 777777 });

    const { body } = await drill(budget, budget.items[0]._id, a.company._id);
    expect(body.totals.actual).toBe(100000);
    expect(body.vouchers).toHaveLength(1);
  });

  test("a legacy budget with no companyId scopes to the requesting company", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const budget = await makeBudget({ companyId: null, ledger: a.expenseLedger });

    await postVoucher({ companyId: a.company._id, ledger: a.expenseLedger, amount: 100000 });
    await postVoucher({ companyId: b.company._id, ledger: a.expenseLedger, amount: 777777 });

    const { body } = await drill(budget, budget.items[0]._id, a.company._id);
    expect(body.totals.actual).toBe(100000);
    expect(body.totals.actual).not.toBe(877777);

    // And it agrees with what the detail read reports for the same budget.
    const detail = await call(`/${budget._id}?companyId=${a.company._id}&asOf=2027-03-31`);
    expect(body.totals.actual).toBe(detail.body.budget.items[0].actual);
  });

  test("optional, draft and pending vouchers are all excluded", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id, ledger: expenseLedger });

    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 100000 });
    // Tally's planning entry — not posted to the ledger. Counting it would let
    // the budget report its own forecast as achievement.
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 500000, isOptional: true });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 400000, status: "draft" });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 300000, status: "pending_approval" });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 200000, status: "cancelled" });

    const { body } = await drill(budget, budget.items[0]._id, company._id);
    expect(body.totals.actual).toBe(100000);
    expect(body.vouchers).toHaveLength(1);
    expect(body.vouchers[0].status).toBe("posted");
  });

  test("spend outside the budget's own period is excluded", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id, ledger: expenseLedger });

    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 100000, date: "2026-06-15" });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 999999, date: "2025-06-15" });

    const { body } = await drill(budget, budget.items[0]._id, company._id);
    expect(body.totals.actual).toBe(100000);
  });

  /* ── sign ─────────────────────────────────────────────────────────────── */

  test("revenue contribution is credit-positive, not debit-positive", async () => {
    const { company, revenueLedger } = await seedCompany();
    const budget = await makeBudget({
      companyId: company._id, ledger: revenueLedger, nature: "revenue", allocated: 4000000,
    });
    await postVoucher({ companyId: company._id, ledger: revenueLedger, amount: 250000, type: "Cr" });

    const { body } = await drill(budget, budget.items[0]._id, company._id);
    const v = body.vouchers[0];
    expect(v.credit).toBe(250000);
    expect(v.debit).toBe(0);
    expect(v.signed).toBe(-250000);       // raw Dr-Cr
    expect(v.actualContribution).toBe(250000); // nature-corrected
    expect(body.totals.actual).toBe(250000);
    expect(body.line.nature).toBe("revenue");
  });

  test("a credit against an expense head reduces the actual", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id, ledger: expenseLedger });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 100000 });
    // A purchase return against the same head.
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 30000, type: "Cr", date: "2026-07-01" });

    const detail = await call(`/${budget._id}?companyId=${company._id}&asOf=2027-03-31`);
    const { body } = await drill(budget, budget.items[0]._id, company._id);

    expect(body.totals.actual).toBe(70000);
    expect(body.totals.actual).toBe(detail.body.budget.items[0].actual);
    expect(body.vouchers.find((v) => v.credit > 0).actualContribution).toBe(-30000);
  });

  /* ── unbound ──────────────────────────────────────────────────────────── */

  test("an unbound legacy line says so rather than returning a bare empty list", async () => {
    const { company } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id, ledger: null });

    const { status, body } = await drill(budget, budget.items[0]._id, company._id);
    expect(status).toBe(200);
    expect(body.unbound).toBe(true);
    expect(body.vouchers).toEqual([]);
    expect(body.totals.actual).toBe(0);
    expect(body.line.ledgerId).toBeNull();
    expect(body.line.allocatedAmount).toBe(500000);
  });

  /* ── shape ────────────────────────────────────────────────────────────── */

  test("rows carry the fields a drilldown table needs, from the real model", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id, ledger: expenseLedger });
    await postVoucher({
      companyId: company._id, ledger: expenseLedger, amount: 25804.8,
      party: "Mayfair Hotels & Resorts Private Limited (Bhubaneswar)",
      narration: "Supply of uniforms — housekeeping and F&B, as per PO 44192",
    });

    const { body } = await drill(budget, budget.items[0]._id, company._id);
    const v = body.vouchers[0];
    for (const f of [
      "voucherId", "voucherNumber", "voucherType", "voucherDate",
      "partyLedgerName", "narration", "debit", "credit", "signed",
      "actualContribution", "status",
    ]) {
      expect(v).toHaveProperty(f);
    }
    expect(v.voucherType).toBe("purchase");
    expect(v.partyLedgerName).toMatch(/Mayfair/);
    expect(v.debit).toBe(25804.8);
    expect(body.line.ledgerName).toBe("Freight & Forwarding");
    expect(body.line.groupName).toBe("Indirect Expenses");
  });

  /* ── pagination ───────────────────────────────────────────────────────── */

  test("pagination pages the rows but never the totals", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id, ledger: expenseLedger });
    for (let i = 0; i < 7; i++) {
      await postVoucher({
        companyId: company._id, ledger: expenseLedger, amount: 10000,
        date: `2026-06-${String(i + 1).padStart(2, "0")}`,
      });
    }

    const p1 = await drill(budget, budget.items[0]._id, company._id, "&page=1&limit=3");
    expect(p1.body.vouchers).toHaveLength(3);
    expect(p1.body.pageCount).toBe(3);
    // The total is the WHOLE window — a page-local total answers no question.
    expect(p1.body.totals.actual).toBe(70000);
    expect(p1.body.totals.voucherCount).toBe(7);

    const p3 = await drill(budget, budget.items[0]._id, company._id, "&page=3&limit=3");
    expect(p3.body.vouchers).toHaveLength(1);
    expect(p3.body.totals.actual).toBe(70000);

    const beyond = await drill(budget, budget.items[0]._id, company._id, "&page=9&limit=3");
    expect(beyond.body.vouchers).toEqual([]);
    expect(beyond.body.totals.actual).toBe(70000);

    // Pages do not overlap and cover everything.
    const p2 = await drill(budget, budget.items[0]._id, company._id, "&page=2&limit=3");
    const ids = [...p1.body.vouchers, ...p2.body.vouchers, ...p3.body.vouchers].map((v) => String(v.voucherId));
    expect(new Set(ids).size).toBe(7);
  });

  /* ── guards ───────────────────────────────────────────────────────────── */

  test("another company cannot drill into this budget", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const budget = await makeBudget({ companyId: a.company._id, ledger: a.expenseLedger });

    const { status } = await drill(budget, budget.items[0]._id, b.company._id);
    expect(status).toBe(404);
  });

  test("an unknown or malformed budget or item id is a clean 404", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id, ledger: expenseLedger });

    const badItem = await drill(budget, new mongoose.Types.ObjectId().toString(), company._id);
    expect(badItem.status).toBe(404);
    expect(badItem.body.message).toMatch(/line not found/i);

    const junkItem = await drill(budget, "not-an-id", company._id);
    expect(junkItem.status).toBe(404);

    const badBudget = await call(
      `/${new mongoose.Types.ObjectId()}/items/${budget.items[0]._id}/vouchers?companyId=${company._id}`,
    );
    expect(badBudget.status).toBe(404);

    const junkBudget = await call(`/not-an-id/items/x/vouchers?companyId=${company._id}`);
    expect(junkBudget.status).toBe(404);
  });

  test("a narrowing from/to is honoured; a widening one cannot escape the budget period", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id, ledger: expenseLedger });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 100000, date: "2026-06-15" });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 50000, date: "2026-11-20" });
    await postVoucher({ companyId: company._id, ledger: expenseLedger, amount: 999999, date: "2025-01-01" });

    const narrow = await drill(budget, budget.items[0]._id, company._id, "&from=2026-10-01&to=2027-03-31");
    expect(narrow.body.totals.actual).toBe(50000);

    // Asking for 2020 onwards must not pull in spend the budget never covered.
    const wide = await drill(budget, budget.items[0]._id, company._id, "&from=2020-01-01&to=2030-01-01");
    expect(wide.body.totals.actual).toBe(150000);

    const bad = await drill(budget, budget.items[0]._id, company._id, "&from=not-a-date");
    expect(bad.status).toBe(400);
  });

  test("the drilldown requires authentication", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await makeBudget({ companyId: company._id, ledger: expenseLedger });
    const { status } = await call(
      `/${budget._id}/items/${budget.items[0]._id}/vouchers?companyId=${company._id}`,
      { user: null },
    );
    expect(status).toBe(401);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * CHUNK 7 — SUPPLEMENTARY BUDGETS AND REVISIONS
 *
 * The legitimate way to change an allocation once the budget is live. Chunk 6
 * made over-budget spend require a written override; this is the path that
 * fixes the NUMBER instead of excusing the breach.
 *
 * Two properties carry most of the weight here:
 *   - submitting must move nothing (or review is theatre)
 *   - approving must move it exactly ONCE (there is no ledger to reconcile
 *     against that would ever reveal a double-applied ₹5L)
 * ────────────────────────────────────────────────────────────────────────── */
describe("adjustments — supplementary and revision", () => {
  let seq = 0;

  async function setup({ status = "active", allocated = 2500000 } = {}) {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    const budget = await Acc_Budget.create({
      name: "FY26-27",
      financialYear: "2026-27",
      period: "yearly",
      status,
      startDate: new Date("2026-04-01"),
      endDate: new Date("2027-03-31"),
      companyId: company._id,
      items: [
        {
          ledgerId: expenseLedger._id, ledgerName: expenseLedger.name,
          groupName: expenseLedger.groupName, nature: "expense",
          department: "Production", allocatedAmount: allocated,
        },
        {
          ledgerId: revenueLedger._id, ledgerName: revenueLedger.name,
          groupName: revenueLedger.groupName, nature: "revenue",
          department: "Sales", allocatedAmount: 4000000,
        },
      ],
    });
    const q = `?companyId=${company._id}`;
    return { company, budget, q, expenseLedger, revenueLedger, item: budget.items[0] };
  }

  const submit = (budget, q, body) =>
    call(`/${budget._id}/adjustments${q}`, { method: "POST", body });

  const supplementary = (item, amount, extra = {}) => ({
    type: "supplementary",
    targetItemId: String(item._id),
    requestedDeltaAmount: amount,
    reason: "Fabric prices moved after the budget was set.",
    ...extra,
  });

  const revision = (item, amount, extra = {}) => ({
    type: "revision",
    targetItemId: String(item._id),
    requestedNewAmount: amount,
    reason: "CEO approved a larger exhibition presence.",
    ...extra,
  });

  const allocationOf = async (budgetId, itemId) => {
    const b = await Acc_Budget.findById(budgetId).lean();
    return b.items.find((i) => String(i._id) === String(itemId)).allocatedAmount;
  };

  /* ── submitting ───────────────────────────────────────────────────────── */

  test("a supplementary states a delta and derives what the line would become", async () => {
    const { budget, q, item } = await setup({ allocated: 2500000 });
    const { status, body } = await submit(budget, q, supplementary(item, 500000));

    expect(status).toBe(201);
    expect(body.adjustment.type).toBe("supplementary");
    expect(body.adjustment.currentAllocatedAmount).toBe(2500000);
    expect(body.adjustment.requestedDeltaAmount).toBe(500000);
    // Derived, so a reader never has to know the type to answer
    // "what does this become?".
    expect(body.adjustment.requestedNewAmount).toBe(3000000);
    expect(body.adjustment.state).toBe("submitted");
    // Denormalised from the TARGET LINE, not from the request body.
    expect(body.adjustment.ledgerName).toBe("Freight & Forwarding");
    expect(body.adjustment.department).toBe("Production");
    expect(body.adjustment.nature).toBe("expense");
  });

  test("a revision states a destination and derives the delta, including a reduction", async () => {
    const { budget, q, item } = await setup({ allocated: 500000 });

    const up = await submit(budget, q, revision(item, 700000));
    expect(up.status).toBe(201);
    expect(up.body.adjustment.requestedNewAmount).toBe(700000);
    expect(up.body.adjustment.requestedDeltaAmount).toBe(200000);

    // Revision is the only shape that can go DOWN.
    const down = await submit(budget, q, revision(item, 300000));
    expect(down.status).toBe(201);
    expect(down.body.adjustment.requestedDeltaAmount).toBe(-200000);
  });

  test("SUBMITTING MOVES NOTHING", async () => {
    const { budget, q, item } = await setup({ allocated: 2500000 });
    const before = await Acc_Budget.findById(budget._id).lean();

    await submit(budget, q, supplementary(item, 500000));
    await submit(budget, q, revision(item, 9000000));

    expect(await allocationOf(budget._id, item._id)).toBe(2500000);
    const after = await Acc_Budget.findById(budget._id).lean();
    expect(after.totalAllocated).toBe(before.totalAllocated);
    expect(after.adjustments).toHaveLength(2);
  });

  /* ── validation ───────────────────────────────────────────────────────── */

  test("a supplementary must be positive — a reduction is a revision", async () => {
    const { budget, q, item } = await setup();

    for (const bad of [0, -500000]) {
      const { status, body } = await submit(budget, q, supplementary(item, bad));
      expect(status).toBe(400);
      expect(body.message).toMatch(/greater than 0/);
      expect(body.message).toMatch(/revision instead/);
    }

    const nan = await submit(budget, q, supplementary(item, "not-a-number"));
    expect(nan.status).toBe(400);
  });

  test("a revision may be zero but never negative", async () => {
    const { budget, q, item } = await setup();

    const zero = await submit(budget, q, revision(item, 0));
    expect(zero.status).toBe(201);

    const negative = await submit(budget, q, revision(item, -1));
    expect(negative.status).toBe(400);
    expect(negative.body.message).toMatch(/≥ 0/);
  });

  test("type, target, reason and priority are all validated", async () => {
    const { budget, q, item } = await setup();

    const badType = await submit(budget, q, { ...supplementary(item, 1000), type: "transfer" });
    expect(badType.status).toBe(400);
    expect(badType.body.message).toMatch(/supplementary.*revision/);

    const missingTarget = await submit(budget, q, {
      type: "supplementary", targetItemId: new mongoose.Types.ObjectId().toString(),
      requestedDeltaAmount: 1000, reason: "x",
    });
    expect(missingTarget.status).toBe(404);
    expect(missingTarget.body.message).toMatch(/line not found/i);

    const junkTarget = await submit(budget, q, { ...supplementary(item, 1000), targetItemId: "nope" });
    expect(junkTarget.status).toBe(404);

    const noReason = await submit(budget, q, {
      type: "supplementary", targetItemId: String(item._id), requestedDeltaAmount: 1000,
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.message).toMatch(/reason or justification/);

    const badPriority = await submit(budget, q, supplementary(item, 1000, { priority: "urgent" }));
    expect(badPriority.status).toBe(400);
    expect(badPriority.body.message).toMatch(/priority must be one of/);
  });

  test("a closed budget can no longer be adjusted; a live or blown one can", async () => {
    for (const status of ["draft", "collecting", "closed"]) {
      const { budget, q, item } = await setup({ status });
      const { status: code, body } = await submit(budget, q, supplementary(item, 1000));
      expect(code).toBe(409);
      expect(body.message).toMatch(/no longer be adjusted/);
    }

    // An exceeded budget is the single most likely thing anyone needs to
    // adjust — refusing there would force the override path this replaces.
    for (const status of ["review", "active", "exceeded"]) {
      const { budget, q, item } = await setup({ status });
      const { status: code } = await submit(budget, q, supplementary(item, 1000));
      expect(code).toBe(201);
    }
  });

  test("a requester cannot smuggle approved fields through the create body", async () => {
    const { budget, q, item } = await setup({ allocated: 2500000 });
    const { status, body } = await submit(budget, q, {
      ...supplementary(item, 500000),
      // Everything a self-approving request would need.
      state: "approved",
      approvedDeltaAmount: 9999999,
      approvedNewAmount: 9999999,
      appliedAt: new Date().toISOString(),
      reviewedBy: "someone.else@example.com",
      requestedBy: "not.me@example.com",
      financeNote: "Approved by me, obviously.",
      currentAllocatedAmount: 1,
      department: "Not Production",
      ledgerName: "Something Else",
    });

    expect(status).toBe(201);
    const a = body.adjustment;
    expect(a.state).toBe("submitted");
    expect(a.approvedDeltaAmount).toBeUndefined();
    expect(a.approvedNewAmount).toBeUndefined();
    expect(a.appliedAt).toBeUndefined();
    expect(a.reviewedBy).toBeUndefined();
    expect(a.financeNote).toBeUndefined();
    // Derived from the target line, not accepted from the caller.
    expect(a.currentAllocatedAmount).toBe(2500000);
    expect(a.department).toBe("Production");
    expect(a.ledgerName).toBe("Freight & Forwarding");
    // And nothing moved.
    expect(await allocationOf(budget._id, item._id)).toBe(2500000);
  });

  /* ── approving ────────────────────────────────────────────────────────── */

  test("approving a supplementary raises the allocation by the delta, once", async () => {
    const { budget, q, item } = await setup({ allocated: 2500000 });
    const created = await submit(budget, q, supplementary(item, 500000));

    const { status, body } = await call(
      `/${budget._id}/adjustments/${created.body.adjustment._id}/approve${q}`,
      { method: "POST" },
    );

    expect(status).toBe(200);
    expect(body.adjustment.state).toBe("approved");
    expect(body.adjustment.approvedDeltaAmount).toBe(500000);
    expect(body.adjustment.approvedNewAmount).toBe(3000000);
    expect(body.adjustment.appliedAt).toBeTruthy();
    expect(body.adjustment.reviewedBy).toBe(OWNER.email);
    expect(await allocationOf(budget._id, item._id)).toBe(3000000);
  });

  test("approving a revision SETS the allocation, it does not add to it", async () => {
    const { budget, q, item } = await setup({ allocated: 500000 });
    const created = await submit(budget, q, revision(item, 700000));

    await call(`/${budget._id}/adjustments/${created.body.adjustment._id}/approve${q}`, { method: "POST" });
    // 700000, not 1200000.
    expect(await allocationOf(budget._id, item._id)).toBe(700000);
  });

  test("APPROVING TWICE APPLIES ONCE", async () => {
    const { budget, q, item } = await setup({ allocated: 2500000 });
    const created = await submit(budget, q, supplementary(item, 500000));
    const url = `/${budget._id}/adjustments/${created.body.adjustment._id}/approve${q}`;

    const first = await call(url, { method: "POST" });
    expect(first.status).toBe(200);
    expect(await allocationOf(budget._id, item._id)).toBe(3000000);

    // A double-click, a retry, a flaky connection. There is no ledger to
    // reconcile against that would ever reveal a double-applied ₹5L.
    const second = await call(url, { method: "POST" });
    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/already been applied/);
    expect(await allocationOf(budget._id, item._id)).toBe(3000000);

    // And three concurrent retries still land once.
    await Promise.all([call(url, { method: "POST" }), call(url, { method: "POST" })]);
    expect(await allocationOf(budget._id, item._id)).toBe(3000000);
  });

  test("finance may grant a different amount from the one requested", async () => {
    const { budget, q, item } = await setup({ allocated: 2500000 });
    const created = await submit(budget, q, supplementary(item, 500000));

    const { body } = await call(
      `/${budget._id}/adjustments/${created.body.adjustment._id}/approve${q}`,
      { method: "POST", body: { approvedDeltaAmount: 300000, financeNote: "Half now, revisit in Q3." } },
    );

    expect(body.adjustment.approvedDeltaAmount).toBe(300000);
    expect(body.adjustment.approvedNewAmount).toBe(2800000);
    expect(body.adjustment.financeNote).toMatch(/Half now/);
    // The REQUEST is preserved beside the decision.
    expect(body.adjustment.requestedDeltaAmount).toBe(500000);
    expect(await allocationOf(budget._id, item._id)).toBe(2800000);
  });

  test("a second supplementary applies on top of the first, not against a stale base", async () => {
    const { budget, q, item } = await setup({ allocated: 2500000 });

    // Both raised BEFORE either is approved, so both snapshot 25L.
    const a = await submit(budget, q, supplementary(item, 500000));
    const b = await submit(budget, q, supplementary(item, 300000));
    expect(a.body.adjustment.currentAllocatedAmount).toBe(2500000);
    expect(b.body.adjustment.currentAllocatedAmount).toBe(2500000);

    await call(`/${budget._id}/adjustments/${a.body.adjustment._id}/approve${q}`, { method: "POST" });
    expect(await allocationOf(budget._id, item._id)).toBe(3000000);

    // "₹3L more" must mean more than whatever it is NOW — 33L, not 28L.
    const second = await call(`/${budget._id}/adjustments/${b.body.adjustment._id}/approve${q}`, { method: "POST" });
    expect(second.body.adjustment.currentAllocatedAmount).toBe(3000000);
    expect(await allocationOf(budget._id, item._id)).toBe(3300000);
  });

  test("totals recalculate after approval", async () => {
    const { budget, q, item } = await setup({ allocated: 2500000 });
    /* `setup` builds the budget through the model directly, which skips the
       create route's cacheTotals — so the cached figures start unset. That is
       the interesting case: approving must recompute them from `items[]`
       rather than incrementing whatever was cached. */
    const before = await Acc_Budget.findById(budget._id).lean();
    expect(before.totalExpenseAllocated || 0).toBe(0);

    const created = await submit(budget, q, supplementary(item, 500000));
    const { body } = await call(
      `/${budget._id}/adjustments/${created.body.adjustment._id}/approve${q}`, { method: "POST" },
    );

    expect(body.totals.totalExpenseAllocated).toBe(3000000);
    expect(body.totals.totalRevenueAllocated).toBe(4000000);
    expect(body.totals.totalAllocated).toBe(7000000);

    const saved = await Acc_Budget.findById(budget._id).lean();
    expect(saved.totalAllocated).toBe(7000000);
  });

  test("evaluated variance reflects the revised allocation immediately", async () => {
    const { company, budget, q, item, expenseLedger } = await setup({ allocated: 100000 });
    await Acc_Voucher.create({
      companyId: company._id, voucherType: "purchase",
      voucherNumber: `ADJ/${seq++}/${Date.now()}`,
      voucherDate: new Date("2026-06-15"), status: "posted", grandTotal: 150000,
      ledgerEntries: [{ ledgerId: expenseLedger._id, ledgerName: expenseLedger.name, type: "Dr", amount: 150000 }],
    });

    // Over budget before the revision.
    const before = await call(`/${budget._id}${q}&asOf=2027-03-31`);
    const lineBefore = before.body.budget.items.find((i) => String(i._id) === String(item._id));
    expect(lineBefore.variance).toBe(-50000);
    expect(lineBefore.pace).toBe("over_budget");

    const created = await submit(budget, q, revision(item, 200000));
    await call(`/${budget._id}/adjustments/${created.body.adjustment._id}/approve${q}`, { method: "POST" });

    // Within budget after it — same spend, revised number.
    const after = await call(`/${budget._id}${q}&asOf=2027-03-31`);
    const lineAfter = after.body.budget.items.find((i) => String(i._id) === String(item._id));
    expect(lineAfter.allocated).toBe(200000);
    expect(lineAfter.variance).toBe(50000);
    expect(lineAfter.pace).not.toBe("over_budget");
  });

  /* ── refusing ─────────────────────────────────────────────────────────── */

  test("rejecting answers the request without touching a rupee", async () => {
    const { budget, q, item } = await setup({ allocated: 2500000 });
    const created = await submit(budget, q, supplementary(item, 500000));

    const { status, body } = await call(
      `/${budget._id}/adjustments/${created.body.adjustment._id}/reject${q}`,
      { method: "POST", body: { financeNote: "Re-plan within the existing envelope." } },
    );

    expect(status).toBe(200);
    expect(body.adjustment.state).toBe("rejected");
    expect(body.adjustment.financeNote).toMatch(/Re-plan/);
    expect(body.adjustment.appliedAt).toBeUndefined();
    expect(await allocationOf(budget._id, item._id)).toBe(2500000);
  });

  test("an applied adjustment can no longer be rejected or cancelled", async () => {
    const { budget, q, item } = await setup();
    const created = await submit(budget, q, supplementary(item, 500000));
    const id = created.body.adjustment._id;
    await call(`/${budget._id}/adjustments/${id}/approve${q}`, { method: "POST" });

    const rejected = await call(`/${budget._id}/adjustments/${id}/reject${q}`, { method: "POST" });
    expect(rejected.status).toBe(409);

    const cancelled = await call(`/${budget._id}/adjustments/${id}/cancel${q}`, { method: "POST" });
    expect(cancelled.status).toBe(409);
  });

  test("a rejected adjustment cannot then be approved", async () => {
    const { budget, q, item } = await setup({ allocated: 2500000 });
    const created = await submit(budget, q, supplementary(item, 500000));
    const id = created.body.adjustment._id;

    await call(`/${budget._id}/adjustments/${id}/reject${q}`, { method: "POST" });
    const { status, body } = await call(`/${budget._id}/adjustments/${id}/approve${q}`, { method: "POST" });
    expect(status).toBe(409);
    expect(body.message).toMatch(/rejected/);
    expect(await allocationOf(budget._id, item._id)).toBe(2500000);
  });

  test("the requester can withdraw their own submitted ask, but not once decided", async () => {
    const { budget, q, item } = await setup();
    const created = await submit(budget, q, supplementary(item, 500000));
    const id = created.body.adjustment._id;

    const { status, body } = await call(`/${budget._id}/adjustments/${id}/cancel${q}`, { method: "POST" });
    expect(status).toBe(200);
    // Distinct from `rejected`, which is finance's answer — collapsing the two
    // would lose who decided.
    expect(body.adjustment.state).toBe("cancelled");

    const again = await call(`/${budget._id}/adjustments/${id}/cancel${q}`, { method: "POST" });
    expect(again.status).toBe(409);
  });

  /* ── reading and scoping ──────────────────────────────────────────────── */

  test("the list returns every adjustment with whether the budget can still take one", async () => {
    const { budget, q, item } = await setup();
    await submit(budget, q, supplementary(item, 500000));
    await submit(budget, q, revision(item, 900000));

    const { status, body } = await call(`/${budget._id}/adjustments${q}`);
    expect(status).toBe(200);
    expect(body.adjustments).toHaveLength(2);
    expect(body.adjustable).toBe(true);
    expect(body.budgetStatus).toBe("active");

    await Acc_Budget.updateOne({ _id: budget._id }, { $set: { status: "closed" } });
    const closed = await call(`/${budget._id}/adjustments${q}`);
    // Still readable — history does not disappear when a budget closes.
    expect(closed.status).toBe(200);
    expect(closed.body.adjustments).toHaveLength(2);
    expect(closed.body.adjustable).toBe(false);
  });

  test("another company can neither see nor adjust this budget", async () => {
    const { budget, item } = await setup();
    const other = await seedCompany();
    const oq = `?companyId=${other.company._id}`;

    expect((await call(`/${budget._id}/adjustments${oq}`)).status).toBe(404);
    expect((await submit(budget, oq, supplementary(item, 500000))).status).toBe(404);

    const mine = await submit(budget, `?companyId=${budget.companyId}`, supplementary(item, 500000));
    expect(mine.status).toBe(201);
    const id = mine.body.adjustment._id;

    expect((await call(`/${budget._id}/adjustments/${id}/approve${oq}`, { method: "POST" })).status).toBe(404);
    expect((await call(`/${budget._id}/adjustments/${id}/reject${oq}`, { method: "POST" })).status).toBe(404);
  });

  test("an unknown or malformed budget or adjustment id is a clean 404", async () => {
    const { budget, q } = await setup();

    expect((await call(`/${new mongoose.Types.ObjectId()}/adjustments${q}`)).status).toBe(404);
    expect((await call(`/not-an-id/adjustments${q}`)).status).toBe(404);
    expect(
      (await call(`/${budget._id}/adjustments/${new mongoose.Types.ObjectId()}/approve${q}`, { method: "POST" })).status,
    ).toBe(404);
    expect(
      (await call(`/${budget._id}/adjustments/nope/approve${q}`, { method: "POST" })).status,
    ).toBe(404);
  });

  test("a revenue target can be revised too — this is not a spend-only path", async () => {
    const { budget, q } = await setup();
    const revenueItem = budget.items[1];

    const created = await submit(budget, q, revision(revenueItem, 5000000));
    expect(created.status).toBe(201);
    expect(created.body.adjustment.nature).toBe("revenue");

    const { body } = await call(
      `/${budget._id}/adjustments/${created.body.adjustment._id}/approve${q}`, { method: "POST" },
    );
    expect(body.totals.totalRevenueAllocated).toBe(5000000);
    expect(await allocationOf(budget._id, revenueItem._id)).toBe(5000000);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * CHUNK 8 — TRANSFERS
 *
 * Moving approved amount between lines. Not extra money: the company's total
 * commitment is unchanged and only who may spend it moves.
 *
 * The invariant everything here defends: YOU CANNOT MOVE MONEY THAT HAS
 * ALREADY BEEN SPENT. `allocated` is not availability. A line with ₹1L
 * allocated and ₹90k consumed has ₹10k to give, and transferring against the
 * allocation would leave the source instantly over budget having done nothing.
 * ────────────────────────────────────────────────────────────────────────── */
describe("transfers", () => {
  let seq = 0;

  async function setup({ status = "active", admin = 100000, production = 50000 } = {}) {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    /* A SECOND expense head, so the two sides of a transfer are genuinely
       different lines on different ledgers — a transfer between two lines
       sharing a head would hide any ledger mix-up. */
    const expGroup = await Acc_Group.findOne({ companyId: company._id, nature: "expense" });
    const repairsLedger = await Acc_Ledger.create({
      companyId: company._id, name: "Repairs & Maintenance",
      groupId: expGroup._id, groupName: expGroup.name, nature: "expense",
    });

    const budget = await Acc_Budget.create({
      name: "FY26-27", financialYear: "2026-27", period: "yearly", status,
      startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"),
      companyId: company._id,
      items: [
        {
          ledgerId: repairsLedger._id, ledgerName: repairsLedger.name,
          groupName: repairsLedger.groupName, nature: "expense",
          department: "Admin", allocatedAmount: admin,
        },
        {
          ledgerId: expenseLedger._id, ledgerName: expenseLedger.name,
          groupName: expenseLedger.groupName, nature: "expense",
          department: "Production", allocatedAmount: production,
        },
        {
          ledgerId: revenueLedger._id, ledgerName: revenueLedger.name,
          groupName: revenueLedger.groupName, nature: "revenue",
          department: "Sales", allocatedAmount: 4000000,
        },
      ],
    });
    return {
      company, budget, repairsLedger, expenseLedger, revenueLedger,
      q: `?companyId=${company._id}`,
      source: budget.items[0],       // Admin · Repairs
      destination: budget.items[1],  // Production · Freight
      revenueItem: budget.items[2],
    };
  }

  async function spend({ company, ledger, amount, date = "2026-06-15" }) {
    return Acc_Voucher.create({
      companyId: company._id, voucherType: "purchase",
      voucherNumber: `TR/${seq++}/${Date.now()}`,
      voucherDate: new Date(date), status: "posted", grandTotal: amount,
      ledgerEntries: [{ ledgerId: ledger._id, ledgerName: ledger.name, type: "Dr", amount }],
    });
  }

  const submit = (budget, q, body) =>
    call(`/${budget._id}/transfers${q}`, { method: "POST", body });

  const move = (source, destination, amount, extra = {}) => ({
    fromItemId: String(source._id),
    toItemId: String(destination._id),
    amount,
    reason: "Admin repairs underspent; Production maintenance is short.",
    ...extra,
  });

  const allocations = async (budgetId) => {
    const b = await Acc_Budget.findById(budgetId).lean();
    return Object.fromEntries(b.items.map((i) => [i.department, i.allocatedAmount]));
  };

  /* ── submitting ───────────────────────────────────────────────────────── */

  test("a transfer records both sides as they stood, including what was already spent", async () => {
    const { company, budget, q, source, destination, repairsLedger } = await setup({ admin: 100000, production: 50000 });
    await spend({ company, ledger: repairsLedger, amount: 25000 });

    const { status, body } = await submit(budget, q, move(source, destination, 60000));
    expect(status).toBe(201);

    const t = body.transfer;
    expect(t.state).toBe("submitted");
    expect(t.amount).toBe(60000);
    expect(t.fromSnapshot.department).toBe("Admin");
    expect(t.fromSnapshot.ledgerName).toBe("Repairs & Maintenance");
    expect(t.fromSnapshot.allocatedAmount).toBe(100000);
    // The evidence for the case being made: ₹25k already gone, ₹75k to give.
    expect(t.fromSnapshot.actual).toBe(25000);
    expect(t.fromSnapshot.remaining).toBe(75000);
    expect(t.toSnapshot.department).toBe("Production");
    expect(t.toSnapshot.allocatedAmount).toBe(50000);
  });

  test("SUBMITTING MOVES NOTHING", async () => {
    const { budget, q, source, destination } = await setup();
    const before = await allocations(budget._id);

    await submit(budget, q, move(source, destination, 60000));
    await submit(budget, q, move(source, destination, 10000));

    expect(await allocations(budget._id)).toEqual(before);
    const saved = await Acc_Budget.findById(budget._id).lean();
    expect(saved.transfers).toHaveLength(2);
  });

  /* ── validation ───────────────────────────────────────────────────────── */

  test("the amount must be positive", async () => {
    const { budget, q, source, destination } = await setup();
    for (const bad of [0, -60000, "abc"]) {
      const { status, body } = await submit(budget, q, move(source, destination, bad));
      expect(status).toBe(400);
      expect(body.message).toMatch(/greater than 0/);
    }
  });

  test("both lines must exist, and they must be different lines", async () => {
    const { budget, q, source, destination } = await setup();

    const same = await submit(budget, q, move(source, source, 1000));
    expect(same.status).toBe(400);
    expect(same.body.message).toMatch(/two different lines/);

    const missing = await submit(budget, q, {
      ...move(source, destination, 1000),
      toItemId: new mongoose.Types.ObjectId().toString(),
    });
    expect(missing.status).toBe(404);

    const junk = await submit(budget, q, { ...move(source, destination, 1000), fromItemId: "nope" });
    expect(junk.status).toBe(404);
  });

  test("a reason is required — a transfer with none is unreviewable", async () => {
    const { budget, q, source, destination } = await setup();
    const { status, body } = await submit(budget, q, {
      fromItemId: String(source._id), toItemId: String(destination._id), amount: 1000,
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/reason is required/);
  });

  test("expense and revenue lines cannot be transferred between", async () => {
    const { budget, q, source, revenueItem } = await setup();
    const { status, body } = await submit(budget, q, move(source, revenueItem, 1000));
    expect(status).toBe(400);
    expect(body.message).toMatch(/different kinds of number/);
  });

  test("a closed budget can no longer have money moved; a live or blown one can", async () => {
    for (const status of ["draft", "collecting", "closed"]) {
      const { budget, q, source, destination } = await setup({ status });
      const res = await submit(budget, q, move(source, destination, 1000));
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/no longer be moved/);
    }
    for (const status of ["review", "active", "exceeded"]) {
      const { budget, q, source, destination } = await setup({ status });
      expect((await submit(budget, q, move(source, destination, 1000))).status).toBe(201);
    }
  });

  /* ── the invariant ────────────────────────────────────────────────────── */

  test("SPENT MONEY CANNOT BE MOVED — availability is allocated minus actual", async () => {
    const { company, budget, q, source, destination, repairsLedger } = await setup({ admin: 100000 });
    // ₹90k of the ₹1L is already gone. Only ₹10k can move.
    await spend({ company, ledger: repairsLedger, amount: 90000 });

    const tooMuch = await submit(budget, q, move(source, destination, 60000));
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.message).toMatch(/only ₹10,000 left to give/);
    expect(tooMuch.body.message).toMatch(/₹90,000 of its ₹1,00,000 is already spent/);
    expect(tooMuch.body.available.remaining).toBe(10000);

    // Exactly the available amount is fine.
    expect((await submit(budget, q, move(source, destination, 10000))).status).toBe(201);
  });

  test("a line already over budget has nothing to give, not a negative amount", async () => {
    const { company, budget, q, source, destination, repairsLedger } = await setup({ admin: 100000 });
    await spend({ company, ledger: repairsLedger, amount: 150000 });

    const { status, body } = await submit(budget, q, move(source, destination, 1));
    expect(status).toBe(400);
    expect(body.available.remaining).toBe(0);
  });

  test("availability is re-checked at approval, because spend arrives in between", async () => {
    const { company, budget, q, source, destination, repairsLedger } = await setup({ admin: 100000 });

    // ₹60k is available when the case is made.
    const created = await submit(budget, q, move(source, destination, 60000));
    expect(created.status).toBe(201);
    expect(created.body.transfer.fromSnapshot.remaining).toBe(100000);

    // Admin then spends ₹80k while finance is thinking about it.
    await spend({ company, ledger: repairsLedger, amount: 80000 });

    const { status, body } = await call(
      `/${budget._id}/transfers/${created.body.transfer._id}/approve${q}`, { method: "POST" },
    );
    expect(status).toBe(409);
    expect(body.message).toMatch(/no longer has/);
    // Nothing moved.
    expect(await allocations(budget._id)).toEqual({ Admin: 100000, Production: 50000, Sales: 4000000 });
  });

  /* ── approving ────────────────────────────────────────────────────────── */

  test("approving subtracts from the source and adds to the destination", async () => {
    const { budget, q, source, destination } = await setup({ admin: 100000, production: 50000 });
    const created = await submit(budget, q, move(source, destination, 60000));

    const { status, body } = await call(
      `/${budget._id}/transfers/${created.body.transfer._id}/approve${q}`,
      { method: "POST", body: { financeNote: "Agreed — Admin has no repairs planned." } },
    );

    expect(status).toBe(200);
    expect(body.transfer.state).toBe("approved");
    expect(body.transfer.appliedAt).toBeTruthy();
    expect(body.transfer.reviewedBy).toBe(OWNER.email);
    expect(body.transfer.financeNote).toMatch(/no repairs planned/);
    expect(await allocations(budget._id)).toEqual({ Admin: 40000, Production: 110000, Sales: 4000000 });
  });

  test("the company's total commitment is unchanged — this is not extra money", async () => {
    const { budget, q, source, destination } = await setup({ admin: 100000, production: 50000 });
    const created = await submit(budget, q, move(source, destination, 60000));

    const { body } = await call(
      `/${budget._id}/transfers/${created.body.transfer._id}/approve${q}`, { method: "POST" },
    );

    // 100000 + 50000 = 150000, before and after.
    expect(body.totals.totalExpenseAllocated).toBe(150000);
    expect(body.totals.totalRevenueAllocated).toBe(4000000);
    expect(body.totals.totalAllocated).toBe(4150000);

    const saved = await Acc_Budget.findById(budget._id).lean();
    expect(saved.totalExpenseAllocated).toBe(150000);
  });

  test("APPROVING TWICE APPLIES ONCE", async () => {
    const { budget, q, source, destination } = await setup({ admin: 100000, production: 50000 });
    const created = await submit(budget, q, move(source, destination, 60000));
    const url = `/${budget._id}/transfers/${created.body.transfer._id}/approve${q}`;

    expect((await call(url, { method: "POST" })).status).toBe(200);
    expect(await allocations(budget._id)).toEqual({ Admin: 40000, Production: 110000, Sales: 4000000 });

    const second = await call(url, { method: "POST" });
    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/already been applied/);
    expect(await allocations(budget._id)).toEqual({ Admin: 40000, Production: 110000, Sales: 4000000 });

    await Promise.all([call(url, { method: "POST" }), call(url, { method: "POST" })]);
    expect(await allocations(budget._id)).toEqual({ Admin: 40000, Production: 110000, Sales: 4000000 });
  });

  test("a source line may be emptied to zero but never taken below it", async () => {
    const { budget, q, source, destination } = await setup({ admin: 100000, production: 50000 });
    const created = await submit(budget, q, move(source, destination, 100000));

    const { status } = await call(
      `/${budget._id}/transfers/${created.body.transfer._id}/approve${q}`, { method: "POST" },
    );
    expect(status).toBe(200);
    expect(await allocations(budget._id)).toEqual({ Admin: 0, Production: 150000, Sales: 4000000 });
  });

  test("evaluated variance reflects both sides immediately after approval", async () => {
    const { company, budget, q, source, destination, expenseLedger } = await setup({ admin: 100000, production: 50000 });
    // Production has overspent its ₹50k.
    await spend({ company, ledger: expenseLedger, amount: 90000 });

    const before = await call(`/${budget._id}${q}&asOf=2027-03-31`);
    const prodBefore = before.body.budget.items.find((i) => i.department === "Production");
    expect(prodBefore.variance).toBe(-40000);
    expect(prodBefore.pace).toBe("over_budget");

    const created = await submit(budget, q, move(source, destination, 60000));
    await call(`/${budget._id}/transfers/${created.body.transfer._id}/approve${q}`, { method: "POST" });

    const after = await call(`/${budget._id}${q}&asOf=2027-03-31`);
    const prodAfter = after.body.budget.items.find((i) => i.department === "Production");
    const adminAfter = after.body.budget.items.find((i) => i.department === "Admin");
    expect(prodAfter.allocated).toBe(110000);
    expect(prodAfter.variance).toBe(20000);
    expect(prodAfter.pace).not.toBe("over_budget");
    expect(adminAfter.allocated).toBe(40000);
  });

  /* ── refusing ─────────────────────────────────────────────────────────── */

  test("rejecting answers without moving a rupee", async () => {
    const { budget, q, source, destination } = await setup();
    const created = await submit(budget, q, move(source, destination, 60000));

    const { status, body } = await call(
      `/${budget._id}/transfers/${created.body.transfer._id}/reject${q}`,
      { method: "POST", body: { financeNote: "Admin will need this in Q4." } },
    );
    expect(status).toBe(200);
    expect(body.transfer.state).toBe("rejected");
    expect(body.transfer.appliedAt).toBeUndefined();
    expect(await allocations(budget._id)).toEqual({ Admin: 100000, Production: 50000, Sales: 4000000 });
  });

  test("a rejected transfer cannot then be approved, and an applied one cannot be undone here", async () => {
    const { budget, q, source, destination } = await setup();

    const a = await submit(budget, q, move(source, destination, 10000));
    await call(`/${budget._id}/transfers/${a.body.transfer._id}/reject${q}`, { method: "POST" });
    const revived = await call(`/${budget._id}/transfers/${a.body.transfer._id}/approve${q}`, { method: "POST" });
    expect(revived.status).toBe(409);

    const b = await submit(budget, q, move(source, destination, 10000));
    await call(`/${budget._id}/transfers/${b.body.transfer._id}/approve${q}`, { method: "POST" });
    expect((await call(`/${budget._id}/transfers/${b.body.transfer._id}/reject${q}`, { method: "POST" })).status).toBe(409);
    expect((await call(`/${budget._id}/transfers/${b.body.transfer._id}/cancel${q}`, { method: "POST" })).status).toBe(409);
  });

  test("the requester can withdraw a submitted transfer", async () => {
    const { budget, q, source, destination } = await setup();
    const created = await submit(budget, q, move(source, destination, 10000));
    const id = created.body.transfer._id;

    const { status, body } = await call(`/${budget._id}/transfers/${id}/cancel${q}`, { method: "POST" });
    expect(status).toBe(200);
    expect(body.transfer.state).toBe("cancelled");
    expect((await call(`/${budget._id}/transfers/${id}/cancel${q}`, { method: "POST" })).status).toBe(409);
  });

  /* ── smuggling and scoping ────────────────────────────────────────────── */

  test("a requester cannot smuggle approved or applied fields through the body", async () => {
    const { budget, q, source, destination } = await setup({ admin: 100000, production: 50000 });
    const { status, body } = await submit(budget, q, {
      ...move(source, destination, 60000),
      state: "approved",
      appliedAt: new Date().toISOString(),
      reviewedBy: "someone.else@example.com",
      requestedBy: "not.me@example.com",
      financeNote: "Approved by me, obviously.",
      fromSnapshot: { allocatedAmount: 99999999, remaining: 99999999 },
      toSnapshot: { allocatedAmount: 1 },
    });

    expect(status).toBe(201);
    const t = body.transfer;
    expect(t.state).toBe("submitted");
    expect(t.appliedAt).toBeUndefined();
    expect(t.reviewedBy).toBeUndefined();
    expect(t.financeNote).toBeUndefined();
    // Snapshots are computed from the real lines, never accepted.
    expect(t.fromSnapshot.allocatedAmount).toBe(100000);
    expect(t.toSnapshot.allocatedAmount).toBe(50000);
    expect(await allocations(budget._id)).toEqual({ Admin: 100000, Production: 50000, Sales: 4000000 });
  });

  test("another company can neither see nor move this budget's money", async () => {
    const { budget, q, source, destination } = await setup();
    const other = await seedCompany();
    const oq = `?companyId=${other.company._id}`;

    expect((await call(`/${budget._id}/transfers${oq}`)).status).toBe(404);
    expect((await call(`/${budget._id}/transfers/available${oq}`)).status).toBe(404);
    expect((await submit(budget, oq, move(source, destination, 1000))).status).toBe(404);

    const mine = await submit(budget, q, move(source, destination, 1000));
    const id = mine.body.transfer._id;
    expect((await call(`/${budget._id}/transfers/${id}/approve${oq}`, { method: "POST" })).status).toBe(404);
    expect((await call(`/${budget._id}/transfers/${id}/reject${oq}`, { method: "POST" })).status).toBe(404);
  });

  test("another company's spend does not change what a line has to give", async () => {
    const a = await setup({ admin: 100000 });
    const b = await seedCompany();
    // B posts against A's head id — must not reduce A's availability.
    await Acc_Voucher.create({
      companyId: b.company._id, voucherType: "purchase",
      voucherNumber: `TRX/${seq++}/${Date.now()}`,
      voucherDate: new Date("2026-06-15"), status: "posted", grandTotal: 95000,
      ledgerEntries: [{ ledgerId: a.repairsLedger._id, ledgerName: a.repairsLedger.name, type: "Dr", amount: 95000 }],
    });

    const { body } = await call(`/${a.budget._id}/transfers/available${a.q}`);
    const admin = body.lines.find((l) => l.department === "Admin");
    expect(admin.actual).toBe(0);
    expect(admin.remaining).toBe(100000);
  });

  /* ── reading ──────────────────────────────────────────────────────────── */

  test("the availability read shows what every line could give, spend included", async () => {
    const { company, budget, q, repairsLedger } = await setup({ admin: 100000, production: 50000 });
    await spend({ company, ledger: repairsLedger, amount: 30000 });

    const { status, body } = await call(`/${budget._id}/transfers/available${q}`);
    expect(status).toBe(200);

    const admin = body.lines.find((l) => l.department === "Admin");
    expect(admin.allocated).toBe(100000);
    expect(admin.actual).toBe(30000);
    expect(admin.remaining).toBe(70000);

    const production = body.lines.find((l) => l.department === "Production");
    expect(production.remaining).toBe(50000);
  });

  test("the list stays readable after the budget closes, but no longer accepts one", async () => {
    const { budget, q, source, destination } = await setup();
    await submit(budget, q, move(source, destination, 10000));

    const open = await call(`/${budget._id}/transfers${q}`);
    expect(open.body.transfers).toHaveLength(1);
    expect(open.body.transferable).toBe(true);

    await Acc_Budget.updateOne({ _id: budget._id }, { $set: { status: "closed" } });
    const closed = await call(`/${budget._id}/transfers${q}`);
    expect(closed.status).toBe(200);
    expect(closed.body.transfers).toHaveLength(1);
    expect(closed.body.transferable).toBe(false);
  });

  test("an unknown or malformed budget or transfer id is a clean 404", async () => {
    const { budget, q } = await setup();
    expect((await call(`/${new mongoose.Types.ObjectId()}/transfers${q}`)).status).toBe(404);
    expect((await call(`/not-an-id/transfers${q}`)).status).toBe(404);
    expect(
      (await call(`/${budget._id}/transfers/${new mongoose.Types.ObjectId()}/approve${q}`, { method: "POST" })).status,
    ).toBe(404);
    expect((await call(`/${budget._id}/transfers/nope/approve${q}`, { method: "POST" })).status).toBe(404);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * HARDENING — AUTHORIZATION
 *
 * Until this pass, every authenticated accountant could do everything on this
 * router: raise a request AND agree it, ask for extra budget AND approve it.
 * The review steps were procedure, not control.
 *
 * `permissions` is role-derived and reliable, so "who may spend" and "who may
 * sign off" separate properly. DEPARTMENT is not on the token, so
 * "Logistics may only raise Logistics requests" is a documented gap rather
 * than a check built on data nobody maintains.
 * ────────────────────────────────────────────────────────────────────────── */
describe("authorization", () => {
  /* `status` matters: requests may only be raised while a budget is still
     collecting, adjustments and transfers only once it is live. No single
     status covers both, so each test picks the one its subject needs. */
  async function liveBudgetWith(items, status = "active") {
    const { company, revenueLedger, expenseLedger } = await seedCompany();
    const budget = await Acc_Budget.create({
      name: "FY26-27", financialYear: "2026-27", period: "yearly", status,
      startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"),
      companyId: company._id,
      items: items({ revenueLedger, expenseLedger }),
    });
    return { company, budget, expenseLedger, revenueLedger, q: `?companyId=${company._id}` };
  }

  const twoLines = ({ expenseLedger, revenueLedger }) => [
    { ledgerId: expenseLedger._id, ledgerName: "Freight & Forwarding", nature: "expense", department: "Logistics", allocatedAmount: 500000 },
    { ledgerId: revenueLedger._id, ledgerName: "Export Sales", nature: "revenue", department: "Sales", allocatedAmount: 4000000 },
  ];

  /* ── viewers cannot write ─────────────────────────────────────────────── */

  test("a viewer can read a budget but cannot change anything", async () => {
    const { budget, q, expenseLedger } = await liveBudgetWith(twoLines);

    // Reading is fine — that is what the role is for.
    expect((await call(`/${budget._id}${q}`, { user: VIEWER })).status).toBe(200);
    expect((await call(`/${budget._id}/adjustments${q}`, { user: VIEWER })).status).toBe(200);
    expect((await call(`/${budget._id}/transfers${q}`, { user: VIEWER })).status).toBe(200);

    const writes = [
      [`/${budget._id}/requests${q}`, { department: "Logistics", ledgerId: String(expenseLedger._id), requestedAmount: 1000, purpose: "x" }],
      [`/${budget._id}/adjustments${q}`, { type: "supplementary", targetItemId: String(budget.items[0]._id), requestedDeltaAmount: 1000, reason: "x" }],
      [`/${budget._id}/transfers${q}`, { fromItemId: String(budget.items[0]._id), toItemId: String(budget.items[1]._id), amount: 1000, reason: "x" }],
    ];
    for (const [path, body] of writes) {
      const { status, body: res } = await call(path, { method: "POST", body, user: VIEWER });
      expect(status).toBe(403);
      expect(res.message).toMatch(/read-only/);
    }

    expect((await call(`/${budget._id}${q}`, { method: "DELETE", user: VIEWER })).status).toBe(403);
  });

  /* ── editors may ask, never decide ────────────────────────────────────── */

  test("an editor may raise every kind of ask and approve none of them", async () => {
    const { budget, q, expenseLedger } = await liveBudgetWith(twoLines);

    // Requests live on a still-collecting budget, so they get their own.
    const coll = await liveBudgetWith(twoLines, "collecting");
    const request = await call(`/${coll.budget._id}/requests${coll.q}`, {
      method: "POST", user: EDITOR,
      body: { department: "Logistics", ledgerId: String(coll.expenseLedger._id), requestedAmount: 100000, purpose: "Peak freight" },
    });
    expect(request.status).toBe(201);

    const adjustment = await call(`/${budget._id}/adjustments${q}`, {
      method: "POST", user: EDITOR,
      body: { type: "supplementary", targetItemId: String(budget.items[0]._id), requestedDeltaAmount: 50000, reason: "Prices moved" },
    });
    expect(adjustment.status).toBe(201);

    const transfer = await call(`/${budget._id}/transfers${q}`, {
      method: "POST", user: EDITOR,
      body: { fromItemId: String(budget.items[0]._id), toItemId: String(budget.items[1]._id), amount: 1000, reason: "x" },
    });
    // Refused for a different reason — expense→revenue — which is fine; what
    // matters is that it was not refused for LACK OF PERMISSION.
    expect(transfer.status).toBe(400);

    // But none of the decisions.
    const decisions = [
      `/${coll.budget._id}/requests/${request.body.request._id}/agree${coll.q}`,
      `/${coll.budget._id}/requests/${request.body.request._id}/counter${coll.q}`,
      `/${coll.budget._id}/requests/${request.body.request._id}/reopen${coll.q}`,
      `/${budget._id}/adjustments/${adjustment.body.adjustment._id}/approve${q}`,
      `/${budget._id}/adjustments/${adjustment.body.adjustment._id}/reject${q}`,
      `/${coll.budget._id}/close-collection${coll.q}`,
    ];
    for (const path of decisions) {
      const { status, body } = await call(path, { method: "POST", body: { counterAmount: 1, approvedDeltaAmount: 1 }, user: EDITOR });
      expect(status).toBe(403);
      expect(body.message).toMatch(/Only finance can approve/);
    }

    // And nothing moved.
    const saved = await Acc_Budget.findById(budget._id).lean();
    expect(saved.items[0].allocatedAmount).toBe(500000);
    expect(saved.adjustments[0].state).toBe("submitted");
    const savedColl = await Acc_Budget.findById(coll.budget._id).lean();
    expect(savedColl.budgetRequests[0].state).toBe("submitted");
  });

  /* ── four eyes ────────────────────────────────────────────────────────── */

  test("an approver cannot sign off their own ask", async () => {
    const { budget, q, expenseLedger } = await liveBudgetWith(twoLines);

    const mine = await call(`/${budget._id}/adjustments${q}`, {
      method: "POST", user: APPROVER,
      body: { type: "supplementary", targetItemId: String(budget.items[0]._id), requestedDeltaAmount: 50000, reason: "Prices moved" },
    });
    expect(mine.status).toBe(201);

    const self = await call(`/${budget._id}/adjustments/${mine.body.adjustment._id}/approve${q}`, {
      method: "POST", user: APPROVER,
    });
    expect(self.status).toBe(403);
    expect(self.body.message).toMatch(/cannot approve your own/);

    // Another approver can. That is the point of the rule, not a blanket block.
    const other = await call(`/${budget._id}/adjustments/${mine.body.adjustment._id}/approve${q}`, {
      method: "POST", user: OWNER,
    });
    expect(other.status).toBe(200);
  });

  test("the owner is exempt — one owner per org, so four eyes would deadlock", async () => {
    const { budget, q } = await liveBudgetWith(twoLines);
    const mine = await call(`/${budget._id}/adjustments${q}`, {
      method: "POST", user: OWNER,
      body: { type: "supplementary", targetItemId: String(budget.items[0]._id), requestedDeltaAmount: 50000, reason: "x" },
    });
    const { status } = await call(`/${budget._id}/adjustments/${mine.body.adjustment._id}/approve${q}`, {
      method: "POST", user: OWNER,
    });
    expect(status).toBe(200);
  });

  test("four eyes applies to requests and transfers too, not just adjustments", async () => {
    const { budget, q, expenseLedger } = await liveBudgetWith(twoLines, "collecting");

    const request = await call(`/${budget._id}/requests${q}`, {
      method: "POST", user: APPROVER,
      body: { department: "Logistics", ledgerId: String(expenseLedger._id), requestedAmount: 1000, purpose: "Peak freight" },
    });
    expect(request.status).toBe(201);
    const agree = await call(`/${budget._id}/requests/${request.body.request._id}/agree${q}`, {
      method: "POST", user: APPROVER,
    });
    expect(agree.status).toBe(403);
    expect(agree.body.message).toMatch(/cannot approve your own/);

    // Two same-nature expense lines for a real transfer.
    const withTwo = await liveBudgetWith(({ expenseLedger: e }) => [
      { ledgerId: e._id, ledgerName: "A", nature: "expense", department: "Admin", allocatedAmount: 100000 },
      { ledgerId: e._id, ledgerName: "B", nature: "expense", department: "Production", allocatedAmount: 50000 },
    ]);
    const transfer = await call(`/${withTwo.budget._id}/transfers${withTwo.q}`, {
      method: "POST", user: APPROVER,
      body: {
        fromItemId: String(withTwo.budget.items[0]._id),
        toItemId: String(withTwo.budget.items[1]._id),
        amount: 10000, reason: "Admin underspent",
      },
    });
    expect(transfer.status).toBe(201);
    const selfApprove = await call(
      `/${withTwo.budget._id}/transfers/${transfer.body.transfer._id}/approve${withTwo.q}`,
      { method: "POST", user: APPROVER },
    );
    expect(selfApprove.status).toBe(403);
  });

  test("a legacy accountant/admin token still has full access", async () => {
    /* The middleware maps legacy roles to canEdit + canApprove. Existing
       admins must not have been locked out by any of this. */
    const LEGACY = {
      id: new mongoose.Types.ObjectId().toString(),
      name: "Legacy Admin", email: "legacy@example.com", role: "admin",
      permissions: { canEdit: true, canApprove: true, canPostDirectly: true },
    };
    const { budget, q } = await liveBudgetWith(twoLines);

    const created = await call(`/${budget._id}/adjustments${q}`, {
      method: "POST", user: EDITOR,
      body: { type: "supplementary", targetItemId: String(budget.items[0]._id), requestedDeltaAmount: 50000, reason: "x" },
    });
    const { status } = await call(`/${budget._id}/adjustments/${created.body.adjustment._id}/approve${q}`, {
      method: "POST", user: LEGACY,
    });
    expect(status).toBe(200);
  });

  test("a requester may still WITHDRAW their own ask — cancelling is not approving", async () => {
    const { budget, q } = await liveBudgetWith(twoLines);
    const mine = await call(`/${budget._id}/adjustments${q}`, {
      method: "POST", user: EDITOR,
      body: { type: "supplementary", targetItemId: String(budget.items[0]._id), requestedDeltaAmount: 50000, reason: "x" },
    });
    const { status, body } = await call(`/${budget._id}/adjustments/${mine.body.adjustment._id}/cancel${q}`, {
      method: "POST", user: EDITOR,
    });
    expect(status).toBe(200);
    expect(body.adjustment.state).toBe("cancelled");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * HARDENING — DUPLICATES AND CONCURRENCY
 * ────────────────────────────────────────────────────────────────────────── */
describe("duplicate request guard", () => {
  async function collecting() {
    const { company, expenseLedger, revenueLedger } = await seedCompany();
    const budget = await Acc_Budget.create({
      name: "FY26-27", financialYear: "2026-27", period: "yearly", status: "collecting",
      startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"),
      companyId: company._id, items: [],
    });
    return { company, budget, expenseLedger, revenueLedger, q: `?companyId=${company._id}` };
  }

  const ask = (budget, q, ledger, body) =>
    call(`/${budget._id}/requests${q}`, {
      method: "POST",
      body: { department: "Logistics", ledgerId: String(ledger._id), requestedAmount: 100000, ...body },
    });

  test("the same department asking for the same head for the same reason twice is refused", async () => {
    const { budget, q, expenseLedger } = await collecting();

    const first = await ask(budget, q, expenseLedger, { purpose: "Peak freight for Diwali" });
    expect(first.status).toBe(201);

    const second = await ask(budget, q, expenseLedger, { purpose: "Peak freight for Diwali" });
    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/already requested this head for the same reason/);
    // Named, so the caller can go look at it rather than guess.
    expect(String(second.body.duplicateOf._id)).toBe(String(first.body.request._id));
    expect(second.body.duplicateOf.state).toBe("submitted");

    const saved = await Acc_Budget.findById(budget._id).lean();
    expect(saved.budgetRequests).toHaveLength(1);
  });

  test("casing and stray whitespace do not get past it", async () => {
    const { budget, q, expenseLedger } = await collecting();
    await ask(budget, q, expenseLedger, { purpose: "Peak freight for Diwali" });

    for (const purpose of ["  peak freight for diwali ", "Peak  freight   for Diwali", "PEAK FREIGHT FOR DIWALI"]) {
      const { status } = await ask(budget, q, expenseLedger, { purpose });
      expect(status).toBe(409);
    }
  });

  test("the SAME head with a DIFFERENT reason is legitimate and allowed", async () => {
    const { budget, q, expenseLedger } = await collecting();
    expect((await ask(budget, q, expenseLedger, { purpose: "Peak freight for Diwali" })).status).toBe(201);
    // One department raising several asks against one head for different
    // reasons is how careful teams plan. Collapsing those would break the
    // module for exactly the people using it properly.
    expect((await ask(budget, q, expenseLedger, { purpose: "Air freight for sample shipments" })).status).toBe(201);

    const saved = await Acc_Budget.findById(budget._id).lean();
    expect(saved.budgetRequests).toHaveLength(2);
  });

  test("a different department may raise the same reason on the same head", async () => {
    const { budget, q, expenseLedger } = await collecting();
    await ask(budget, q, expenseLedger, { purpose: "Peak freight for Diwali" });
    const other = await ask(budget, q, expenseLedger, { department: "Admin", purpose: "Peak freight for Diwali" });
    expect(other.status).toBe(201);
  });

  test("a different head with the same reason is allowed", async () => {
    const { budget, q, expenseLedger, revenueLedger } = await collecting();
    await ask(budget, q, expenseLedger, { purpose: "Peak freight for Diwali" });
    expect((await ask(budget, q, revenueLedger, { purpose: "Peak freight for Diwali" })).status).toBe(201);
  });

  test("once finance has said no, asking again is a new conversation", async () => {
    const { budget, q, expenseLedger } = await collecting();
    const first = await ask(budget, q, expenseLedger, { purpose: "Peak freight for Diwali" });

    // Withdrawn by the department.
    await call(`/${budget._id}/requests/${first.body.request._id}${q}`, { method: "DELETE" });
    const again = await ask(budget, q, expenseLedger, { purpose: "Peak freight for Diwali" });
    expect(again.status).toBe(201);
  });

  test("justification counts as the reason when no purpose was given", async () => {
    const { budget, q, expenseLedger } = await collecting();
    expect((await ask(budget, q, expenseLedger, { justification: "Two new EU buyers confirmed" })).status).toBe(201);
    expect((await ask(budget, q, expenseLedger, { justification: "two new EU buyers confirmed" })).status).toBe(409);
  });
});

describe("concurrency", () => {
  async function liveBudget() {
    const { company, expenseLedger } = await seedCompany();
    const budget = await Acc_Budget.create({
      name: "FY26-27", financialYear: "2026-27", period: "yearly", status: "active",
      startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"),
      companyId: company._id,
      items: [
        { ledgerId: expenseLedger._id, ledgerName: "A", nature: "expense", department: "Admin", allocatedAmount: 100000 },
        { ledgerId: expenseLedger._id, ledgerName: "B", nature: "expense", department: "Production", allocatedAmount: 100000 },
      ],
    });
    return { company, budget, expenseLedger, q: `?companyId=${company._id}` };
  }

  const raiseAdjustment = (budget, q, item, amount) =>
    call(`/${budget._id}/adjustments${q}`, {
      method: "POST", user: EDITOR,
      body: { type: "supplementary", targetItemId: String(item._id), requestedDeltaAmount: amount, reason: "More needed" },
    });

  test("TWO DIFFERENT ADJUSTMENTS APPROVED AT ONCE CANNOT SILENTLY LOSE ONE", async () => {
    const { budget, q } = await liveBudget();
    const a = await raiseAdjustment(budget, q, budget.items[0], 10000);
    const b = await raiseAdjustment(budget, q, budget.items[1], 20000);

    /* Both approvals read the SAME document version and then both save. Before
       optimistic concurrency, the second save overwrote the first wholesale
       and one department's ₹10k vanished while both callers were told it
       worked. Now one of them is refused outright. */
    const [r1, r2] = await Promise.all([
      call(`/${budget._id}/adjustments/${a.body.adjustment._id}/approve${q}`, { method: "POST" }),
      call(`/${budget._id}/adjustments/${b.body.adjustment._id}/approve${q}`, { method: "POST" }),
    ]);

    const codes = [r1.status, r2.status].sort();
    const saved = await Acc_Budget.findById(budget._id).lean();
    const admin = saved.items.find((i) => i.department === "Admin").allocatedAmount;
    const production = saved.items.find((i) => i.department === "Production").allocatedAmount;

    if (codes[0] === 200 && codes[1] === 200) {
      // Both landed — then BOTH must be reflected. This is the outcome that
      // must never be "both said 200 but only one applied".
      expect(admin).toBe(110000);
      expect(production).toBe(120000);
    } else {
      // One was refused, and it was told so honestly.
      expect(codes).toEqual([200, 409]);
      const loser = [r1, r2].find((r) => r.status === 409);
      expect(loser.body.code).toBe("BUDGET_CHANGED");
      // Exactly one applied — never a lost update dressed up as success.
      const applied = (admin === 110000 ? 1 : 0) + (production === 120000 ? 1 : 0);
      expect(applied).toBe(1);
      // And the refused one is still pending, so it can simply be retried.
      const states = saved.adjustments.map((x) => x.state).sort();
      expect(states).toEqual(["approved", "submitted"]);
    }
  });

  test("approving the same adjustment twice is still idempotent, not a version error", async () => {
    const { budget, q } = await liveBudget();
    const a = await raiseAdjustment(budget, q, budget.items[0], 10000);
    const url = `/${budget._id}/adjustments/${a.body.adjustment._id}/approve${q}`;

    expect((await call(url, { method: "POST" })).status).toBe(200);
    const second = await call(url, { method: "POST" });
    expect(second.status).toBe(409);
    // The appliedAt guard answers first, with the message that actually
    // explains what happened — a version error here would be misleading.
    expect(second.body.message).toMatch(/already been applied/);

    const saved = await Acc_Budget.findById(budget._id).lean();
    expect(saved.items.find((i) => i.department === "Admin").allocatedAmount).toBe(110000);
  });

  test("a stale writer is refused rather than overwriting a newer save", async () => {
    const { budget, q } = await liveBudget();

    /* Two handles on the same version. The first save wins; the second is
       working from a document that no longer exists at that version. */
    const stale = await Acc_Budget.findById(budget._id);
    const fresh = await Acc_Budget.findById(budget._id);

    fresh.notes = "Saved first";
    await fresh.save();

    stale.notes = "Saved second, from a stale read";
    await expect(stale.save()).rejects.toThrow(/version|No matching document/i);

    const saved = await Acc_Budget.findById(budget._id).lean();
    expect(saved.notes).toBe("Saved first");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * HARDENING — PENDING WORK ON THE DASHBOARD
 *
 * Until now a budget with three unanswered supplementaries looked exactly like
 * one with none unless somebody opened it. Everything else in `attention` is a
 * problem with the numbers; this is a queue with a person waiting at the end.
 * ────────────────────────────────────────────────────────────────────────── */
describe("dashboard pending counts", () => {
  async function budgetWithWork() {
    const { company, expenseLedger, revenueLedger } = await seedCompany();
    const budget = await Acc_Budget.create({
      name: "FY26-27", financialYear: "2026-27", period: "yearly", status: "active",
      startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"),
      companyId: company._id,
      items: [
        { ledgerId: expenseLedger._id, ledgerName: "A", nature: "expense", department: "Admin", allocatedAmount: 100000 },
        { ledgerId: expenseLedger._id, ledgerName: "B", nature: "expense", department: "Production", allocatedAmount: 100000 },
      ],
    });
    const q = `?companyId=${company._id}`;

    await call(`/${budget._id}/adjustments${q}`, {
      method: "POST", user: EDITOR,
      body: { type: "supplementary", targetItemId: String(budget.items[0]._id), requestedDeltaAmount: 10000, reason: "More" },
    });
    await call(`/${budget._id}/adjustments${q}`, {
      method: "POST", user: EDITOR,
      body: { type: "revision", targetItemId: String(budget.items[1]._id), requestedNewAmount: 150000, reason: "Reset" },
    });
    await call(`/${budget._id}/transfers${q}`, {
      method: "POST", user: EDITOR,
      body: { fromItemId: String(budget.items[0]._id), toItemId: String(budget.items[1]._id), amount: 5000, reason: "Move" },
    });

    return { company, budget, q, expenseLedger };
  }

  test("pending adjustments and transfers are counted per budget and overall", async () => {
    const { company, budget } = await budgetWithWork();
    const { body } = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);

    const row = body.budgets.find((b) => String(b._id) === String(budget._id));
    expect(row.pending).toEqual({ requests: 0, adjustments: 2, transfers: 1, total: 3 });
    expect(body.totals.pending).toEqual({ requests: 0, adjustments: 2, transfers: 1, total: 3 });
  });

  test("a budget with work waiting appears in attention, with its counts", async () => {
    const { company, budget } = await budgetWithWork();
    const { body } = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);

    expect(body.attention.pendingChanges).toHaveLength(1);
    const hit = body.attention.pendingChanges[0];
    expect(String(hit._id)).toBe(String(budget._id));
    expect(hit.name).toBe("FY26-27");
    expect(hit.total).toBe(3);
    expect(hit.adjustments).toBe(2);
    expect(hit.transfers).toBe(1);
    // And it is part of the headline count, so the strip says there is work.
    expect(body.attention.count).toBeGreaterThanOrEqual(1);
  });

  test("ANSWERED work stops counting — otherwise the number only ever grows", async () => {
    const { company, budget, q } = await budgetWithWork();

    const before = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);
    expect(before.body.totals.pending.total).toBe(3);

    const saved = await Acc_Budget.findById(budget._id).lean();
    await call(`/${budget._id}/adjustments/${saved.adjustments[0]._id}/approve${q}`, { method: "POST" });
    await call(`/${budget._id}/adjustments/${saved.adjustments[1]._id}/reject${q}`, { method: "POST" });
    await call(`/${budget._id}/transfers/${saved.transfers[0]._id}/reject${q}`, { method: "POST" });

    const after = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);
    // Approved, rejected and rejected — all ANSWERED, none pending.
    expect(after.body.totals.pending.total).toBe(0);
    expect(after.body.attention.pendingChanges).toHaveLength(0);
  });

  test("pending requests count too, and a budget with nothing waiting is absent", async () => {
    const { company, expenseLedger } = await seedCompany();
    const quiet = await Acc_Budget.create({
      name: "Quiet", financialYear: "2026-27", period: "yearly", status: "active",
      startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"),
      companyId: company._id,
      items: [{ ledgerId: expenseLedger._id, ledgerName: "A", nature: "expense", department: "Admin", allocatedAmount: 100000 }],
    });
    const busy = await Acc_Budget.create({
      name: "Busy", financialYear: "2026-27", period: "yearly", status: "collecting",
      startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"),
      companyId: company._id, items: [],
    });
    await call(`/${busy._id}/requests?companyId=${company._id}`, {
      method: "POST", user: EDITOR,
      body: { department: "Logistics", ledgerId: String(expenseLedger._id), requestedAmount: 1000, purpose: "Peak freight" },
    });

    const { body } = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);
    expect(body.totals.pending.requests).toBe(1);
    expect(body.attention.pendingChanges.map((p) => p.name)).toEqual(["Busy"]);
    expect(body.budgets.find((b) => b.name === "Quiet").pending.total).toBe(0);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * DASHBOARD MONTHLY SERIES — the data behind the page's one large graphic
 * ────────────────────────────────────────────────────────────────────────── */
describe("dashboard monthly series", () => {
  let seq = 0;

  async function setup() {
    const { company, expenseLedger, revenueLedger } = await seedCompany();
    const budget = await Acc_Budget.create({
      name: "FY26-27", financialYear: "2026-27", period: "yearly", status: "active",
      startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"),
      companyId: company._id,
      items: [
        { ledgerId: expenseLedger._id, ledgerName: "A", nature: "expense", department: "Logistics", allocatedAmount: 500000 },
        { ledgerId: revenueLedger._id, ledgerName: "B", nature: "revenue", department: "Sales", allocatedAmount: 4000000 },
      ],
    });
    return { company, budget, expenseLedger, revenueLedger };
  }

  const post = ({ company, ledger, amount, type, date }) =>
    Acc_Voucher.create({
      companyId: company._id, voucherType: type === "Cr" ? "sales" : "purchase",
      voucherNumber: `MS/${seq++}/${Date.now()}`,
      voucherDate: new Date(date), status: "posted", grandTotal: amount,
      ledgerEntries: [{ ledgerId: ledger._id, ledgerName: ledger.name, type, amount }],
    });

  test("spend and revenue land in the months they happened, nature-corrected", async () => {
    const { company, expenseLedger, revenueLedger } = await setup();
    await post({ company, ledger: expenseLedger, amount: 120000, type: "Dr", date: "2026-06-15" });
    await post({ company, ledger: expenseLedger, amount: 80000, type: "Dr", date: "2026-09-02" });
    await post({ company, ledger: revenueLedger, amount: 900000, type: "Cr", date: "2026-06-20" });

    const { body } = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);
    const byKey = Object.fromEntries(body.monthly.map((m) => [m.key, m]));

    expect(byKey["2026-06"]).toMatchObject({ key: "2026-06", revenue: 900000, expense: 120000 });
    expect(byKey["2026-09"].expense).toBe(80000);
    expect(byKey["2026-09"].revenue).toBe(0);
  });

  test("quiet months are kept; only months carrying neither spend NOR plan are trimmed", async () => {
    const { company, expenseLedger } = await setup();
    await post({ company, ledger: expenseLedger, amount: 1000, type: "Dr", date: "2026-06-15" });
    await post({ company, ledger: expenseLedger, amount: 2000, type: "Dr", date: "2026-09-15" });

    const { body } = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);

    // The budget allocates across all twelve months, so all twelve carry a
    // plan and none is empty. A month with no spend still has a line to be
    // read against, which is the whole point of drawing the plan.
    expect(body.monthly).toHaveLength(12);
    expect(body.monthly[0].key).toBe("2026-04");
    // Quiet months are genuinely quiet on the actuals.
    const jul = body.monthly.find((m) => m.key === "2026-07");
    expect(jul.expense).toBe(0);
    expect(jul.plannedExpense).toBeGreaterThan(0);
  });

  test("a period with neither spend nor allocation yields an empty series", async () => {
    const { company } = await seedCompany();
    await Acc_Budget.create({
      name: "Empty", financialYear: "2026-27", period: "yearly", status: "active",
      startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"),
      companyId: company._id, items: [],
    });
    const { body } = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);
    // Nothing allocated and nothing spent — there is genuinely nothing to draw.
    expect(body.monthly).toEqual([]);
  });

  test("the series agrees with the totals when budgets do not overlap", async () => {
    const { company, expenseLedger, revenueLedger } = await setup();
    await post({ company, ledger: expenseLedger, amount: 120000, type: "Dr", date: "2026-06-15" });
    await post({ company, ledger: expenseLedger, amount: 80000, type: "Dr", date: "2026-09-02" });
    await post({ company, ledger: revenueLedger, amount: 900000, type: "Cr", date: "2026-06-20" });

    const { body } = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);
    const sum = (k) => body.monthly.reduce((s, m) => s + m[k], 0);

    // A chart that disagreed with the figures above it is worse than no chart.
    // This holds while one head belongs to one budget — see the next test for
    // where it stops holding, and why that is the totals' problem not the
    // chart's.
    expect(sum("expense")).toBe(body.totals.expense.actual);
    expect(sum("revenue")).toBe(body.totals.revenue.actual);
  });

  test("KNOWN: overlapping budgets double-count actuals in the totals, not in the series", async () => {
    const { company, budget, expenseLedger } = await setup();
    await post({ company, ledger: expenseLedger, amount: 100000, type: "Dr", date: "2026-08-15" });

    /* A quarterly budget on the SAME head, inside the yearly one's period —
     * an ordinary thing to do, and how most companies run a tight quarter. */
    await Acc_Budget.create({
      name: "Q2 top-up", financialYear: "2026-27", period: "quarterly", quarter: 2, status: "active",
      startDate: new Date("2026-07-01"), endDate: new Date("2026-09-30"), companyId: company._id,
      items: [{ ledgerId: expenseLedger._id, ledgerName: "A", nature: "expense", department: "Logistics", allocatedAmount: 200000 }],
    });

    const { body } = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);
    const sum = body.monthly.reduce((s, m) => s + m.expense, 0);

    /* The voucher is ONE ₹1L payment. The series counts it once, which is
     * right. `totals` rolls up each budget's own evaluated lines, so the same
     * payment lands in both budgets and the headline reads ₹2L.
     *
     * This predates the chart — it is how the Chunk 4 roll-up has always
     * worked — and it is pinned here rather than quietly worked around,
     * because the honest fix changes a figure four surfaces read and deserves
     * its own change. The chart is the deduplicated truth of the two. */
    expect(sum).toBe(100000);
    expect(body.totals.expense.actual).toBe(200000);
  });

  test("a voucher on an IST month boundary buckets by IST, not UTC", async () => {
    const { company, expenseLedger } = await setup();
    /* 30-Jun 18:30 UTC IS 1-Jul 00:00 IST. Bucketed on the UTC month this
       lands in June and every month boundary in the year is off by one
       evening's trading. */
    await post({ company, ledger: expenseLedger, amount: 50000, type: "Dr", date: "2026-06-30T18:30:00Z" });

    const { body } = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);
    // Bucketed on the UTC month this would land in June instead.
    expect(body.monthly.find((m) => m.key === "2026-07").expense).toBe(50000);
    expect(body.monthly.find((m) => m.key === "2026-06").expense).toBe(0);
  });

  test("the window itself is the budget's, so spend just outside it is excluded", async () => {
    const { company, expenseLedger } = await setup();
    /* 31-Mar 18:30 UTC is 1-Apr 00:00 IST — the first moment of the financial
     * year in local terms, but BEFORE a startDate stored as 2026-04-01T00:00Z.
     *
     * It is excluded, and that is deliberate here rather than fixed: the same
     * UTC bounds govern hydrateLines, the drilldown and budget control. The
     * chart matching them is the property that matters — a chart disagreeing
     * with the totals beside it would be worse than one that clips an evening.
     * Shifting the window to IST is a module-wide change, not a chart change. */
    await post({ company, ledger: expenseLedger, amount: 50000, type: "Dr", date: "2026-03-31T18:30:00Z" });

    const { body } = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);
    // The plan still draws, but not one rupee of that voucher reaches it.
    const sum = body.monthly.reduce((s, m) => s + m.expense, 0);
    expect(sum).toBe(0);
    // And the series still agrees with the totals, which is the real contract.
    expect(sum).toBe(body.totals.expense.actual);
  });

  test("another company's postings never reach the series", async () => {
    const { company, expenseLedger } = await setup();
    const other = await seedCompany();
    await post({ company, ledger: expenseLedger, amount: 10000, type: "Dr", date: "2026-06-15" });
    await Acc_Voucher.create({
      companyId: other.company._id, voucherType: "purchase",
      voucherNumber: `MSX/${seq++}/${Date.now()}`,
      voucherDate: new Date("2026-06-15"), status: "posted", grandTotal: 999999,
      ledgerEntries: [{ ledgerId: expenseLedger._id, ledgerName: "A", type: "Dr", amount: 999999 }],
    });

    const { body } = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);
    expect(body.monthly.find((m) => m.key === "2026-06").expense).toBe(10000);
  });

  test("draft and optional vouchers are not in the series either", async () => {
    const { company, expenseLedger } = await setup();
    await post({ company, ledger: expenseLedger, amount: 10000, type: "Dr", date: "2026-06-15" });
    await Acc_Voucher.create({
      companyId: company._id, voucherType: "purchase",
      voucherNumber: `MSD/${seq++}/${Date.now()}`,
      voucherDate: new Date("2026-06-15"), status: "draft", grandTotal: 500000,
      ledgerEntries: [{ ledgerId: expenseLedger._id, ledgerName: "A", type: "Dr", amount: 500000 }],
    });

    const { body } = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);
    expect(body.monthly.find((m) => m.key === "2026-06").expense).toBe(10000);
  });

  test("no budgets in scope means an empty series, not a flat line of zeroes", async () => {
    const { company } = await seedCompany();
    const { body } = await call(`/dashboard?companyId=${company._id}`);
    // A series of zeroes draws along the axis and reads as "we spent nothing",
    // which is a different and wrong claim from "there is nothing here".
    expect(body.monthly).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * THE PLANNED PACE — what the curve is read against
 * ────────────────────────────────────────────────────────────────────────── */
describe("dashboard planned series", () => {
  let seq = 0;

  async function yearly({ expense = 1200000, revenue = 0 } = {}) {
    const { company, expenseLedger, revenueLedger } = await seedCompany();
    const items = [
      { ledgerId: expenseLedger._id, ledgerName: "A", nature: "expense", department: "Logistics", allocatedAmount: expense },
    ];
    if (revenue) {
      items.push({ ledgerId: revenueLedger._id, ledgerName: "B", nature: "revenue", department: "Sales", allocatedAmount: revenue });
    }
    const budget = await Acc_Budget.create({
      name: "FY26-27", financialYear: "2026-27", period: "yearly", status: "active",
      startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"),
      companyId: company._id, items,
    });
    return { company, budget, expenseLedger, revenueLedger };
  }

  const post = ({ company, ledger, amount, type = "Dr", date }) =>
    Acc_Voucher.create({
      companyId: company._id, voucherType: type === "Cr" ? "sales" : "purchase",
      voucherNumber: `PL/${seq++}/${Date.now()}`,
      voucherDate: new Date(date), status: "posted", grandTotal: amount,
      ledgerEntries: [{ ledgerId: ledger._id, ledgerName: ledger.name, type, amount }],
    });

  test("a yearly allocation spreads evenly across the twelve months it covers", async () => {
    const { company, expenseLedger } = await yearly({ expense: 1200000 });
    await post({ company, ledger: expenseLedger, amount: 1, date: "2026-04-05" });

    const { body } = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);
    expect(body.monthly).toHaveLength(12);
    // ₹12L over twelve months is ₹1L a month.
    body.monthly.forEach((m) => expect(Math.round(m.plannedExpense)).toBe(100000));
    // And the whole plan adds back up to the allocation.
    const planned = body.monthly.reduce((s, m) => s + m.plannedExpense, 0);
    expect(Math.round(planned)).toBe(1200000);
  });

  test("the plan sums to what was allocated, and revenue plans separately", async () => {
    const { company, expenseLedger } = await yearly({ expense: 1200000, revenue: 6000000 });
    await post({ company, ledger: expenseLedger, amount: 1, date: "2026-04-05" });

    const { body } = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);
    const sum = (k) => Math.round(body.monthly.reduce((s, m) => s + m[k], 0));

    expect(sum("plannedExpense")).toBe(body.totals.expense.allocated);
    expect(sum("plannedRevenue")).toBe(body.totals.revenue.allocated);
    // Never netted together — they are different kinds of claim.
    expect(sum("plannedRevenue")).toBe(6000000);
  });

  test("a quarterly budget plans only across its own three months", async () => {
    const { company, expenseLedger } = await seedCompany();
    await Acc_Budget.create({
      name: "Q2", financialYear: "2026-27", period: "quarterly", quarter: 2, status: "active",
      startDate: new Date("2026-07-01"), endDate: new Date("2026-09-30"), companyId: company._id,
      items: [{ ledgerId: expenseLedger._id, ledgerName: "A", nature: "expense", department: "Logistics", allocatedAmount: 300000 }],
    });

    const { body } = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);
    const planned = Object.fromEntries(body.monthly.map((m) => [m.key, Math.round(m.plannedExpense)]));
    expect(planned).toEqual({ "2026-07": 100000, "2026-08": 100000, "2026-09": 100000 });
  });

  test("a budget with a plan but no spend still draws — the plan is the point", async () => {
    const { company } = await yearly({ expense: 1200000 });
    // Nothing posted at all.
    const { body } = await call(`/dashboard?companyId=${company._id}&asOf=2027-03-31`);
    // Previously the series trimmed to empty because it only looked at actuals,
    // and a brand-new budget showed no chart at all.
    expect(body.monthly).toHaveLength(12);
    expect(body.monthly.every((m) => m.expense === 0)).toBe(true);
    expect(Math.round(body.monthly[0].plannedExpense)).toBe(100000);
  });

  test("the department filter narrows the plan as well as the spend", async () => {
    const { company, expenseLedger, revenueLedger } = await seedCompany();
    await Acc_Budget.create({
      name: "FY26-27", financialYear: "2026-27", period: "yearly", status: "active",
      startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"), companyId: company._id,
      items: [
        { ledgerId: expenseLedger._id, ledgerName: "A", nature: "expense", department: "Logistics", allocatedAmount: 1200000 },
        { ledgerId: revenueLedger._id, ledgerName: "B", nature: "revenue", department: "Sales", allocatedAmount: 6000000 },
      ],
    });

    const { body } = await call(`/dashboard?companyId=${company._id}&department=Logistics&asOf=2027-03-31`);
    const sum = (k) => Math.round(body.monthly.reduce((s, m) => s + m[k], 0));
    expect(sum("plannedExpense")).toBe(1200000);
    // Sales is filtered out, so its target must not appear in the plan either.
    expect(sum("plannedRevenue")).toBe(0);
  });
});
