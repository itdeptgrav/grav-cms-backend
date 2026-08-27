// test/accountant/recurring-items.route.test.js
//
// HTTP-level tests for C0-E's recurring-items register.
//
// The pure service already proves every validation rule in isolation
// (services/recurringItems.test.js). What THIS file exists to prove is the
// half a pure test cannot reach:
//   - company scoping actually reaches the database — a wrong companyId
//     really does fail to find the row, rather than merely "looking like" it
//     would
//   - a refused write leaves the PERSISTED document untouched
//   - the soft delete genuinely soft-deletes (the row survives, its status
//     changes) rather than vanishing
//   - the scope guard holds against real collections: no `Acc_Voucher` and
//     no `Acc_BillTerms` document is created by anything in this router
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

const Acc_RecurringItem = require("../../models/Accountant_model/Acc_RecurringItem");

const EDITOR = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Editor",
  permissions: { canEdit: true },
};
const VIEWER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Vikram Viewer",
  permissions: { canEdit: false },
};

const COMPANY_A = new mongoose.Types.ObjectId();
const COMPANY_B = new mongoose.Types.ObjectId();

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/accountant/recurring-items",
    require("../../routes/Accountant_Routes/Acc_recurringItems"),
  );
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/recurring-items`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(path, { method = "GET", body, user = EDITOR } = {}) {
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

/** A valid monthly-rent create body for company A. */
function monthlyBody(overrides = {}) {
  return {
    companyId: COMPANY_A.toString(),
    name: "Office rent",
    type: "rent",
    direction: "outflow",
    amount: 85000,
    frequency: "monthly",
    dayOfMonth: 5,
    nextDueDate: "2026-09-05",
    startDate: "2026-01-05",
    ...overrides,
  };
}

/** Insert a row directly, bypassing the route. */
async function seedItem(overrides = {}) {
  return Acc_RecurringItem.create({
    companyId: COMPANY_A,
    name: "Seeded payroll",
    type: "payroll",
    direction: "outflow",
    amount: 800000,
    frequency: "monthly",
    dayOfMonth: 1,
    nextDueDate: new Date("2026-09-01"),
    startDate: new Date("2025-04-01"),
    status: "active",
    source: "manual",
    ...overrides,
  });
}

/* ── Create ──────────────────────────────────────────────────────────────── */

describe("create", () => {
  test("a valid monthly outflow is created and returned", async () => {
    const { status, body } = await call("", { method: "POST", body: monthlyBody() });
    expect(status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.item.name).toBe("Office rent");
    expect(body.item.amount).toBe(85000);
    expect(body.item.dayOfMonth).toBe(5);
    expect(body.item.status).toBe("active");
    expect(body.item.source).toBe("manual");
    expect(body.item.createdByName).toBe("Priya Editor");

    const stored = await Acc_RecurringItem.findById(body.item._id).lean();
    expect(String(stored.companyId)).toBe(COMPANY_A.toString());
    expect(String(stored.createdBy)).toBe(EDITOR.id);
  });

  test("a weekly item stores dayOfWeek and no dayOfMonth", async () => {
    const { status, body } = await call("", {
      method: "POST",
      body: monthlyBody({
        name: "Weekly wages",
        type: "payroll",
        frequency: "weekly",
        dayOfWeek: 5,
        dayOfMonth: undefined,
      }),
    });
    expect(status).toBe(201);
    expect(body.item.dayOfWeek).toBe(5);
    expect(body.item.dayOfMonth).toBeNull();
  });

  test("dayOfWeek 0 (Sunday) survives a real HTTP round trip and a real save", async () => {
    // JSON-encodes as `0`, which a truthiness check anywhere along the path
    // would read as absent. This proves it reaches the database intact.
    const { status, body } = await call("", {
      method: "POST",
      body: monthlyBody({
        name: "Sunday settlement",
        frequency: "weekly",
        dayOfWeek: 0,
        dayOfMonth: undefined,
      }),
    });
    expect(status).toBe(201);
    expect(body.item.dayOfWeek).toBe(0);

    const stored = await Acc_RecurringItem.findById(body.item._id).lean();
    expect(stored.dayOfWeek).toBe(0);
  });

  test("an invalid amount is refused and nothing is persisted", async () => {
    const before = await Acc_RecurringItem.countDocuments({});
    const { status, body } = await call("", {
      method: "POST",
      body: monthlyBody({ amount: -5 }),
    });
    expect(status).toBe(400);
    expect(body.code).toBe("NOT_POSITIVE");
    expect(await Acc_RecurringItem.countDocuments({})).toBe(before);
  });

  test("an unsupported field is refused outright, not silently dropped", async () => {
    const { status, body } = await call("", {
      method: "POST",
      body: monthlyBody({ source: "seeded_from_history" }),
    });
    expect(status).toBe(400);
    expect(body.code).toBe("UNSUPPORTED_FIELD");
  });

  test("a create with no companyId is refused", async () => {
    const b = monthlyBody();
    delete b.companyId;
    const { status, body } = await call("", { method: "POST", body: b });
    expect(status).toBe(400);
    expect(body.error).toMatch(/companyid required/i);
  });

  test("a malformed companyId is refused rather than silently unscoped", async () => {
    const { status, body } = await call("", {
      method: "POST",
      body: monthlyBody({ companyId: "not-an-object-id" }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/companyid required/i);
  });
});

/* ── List, company-scoped ────────────────────────────────────────────────── */

describe("list is company-scoped", () => {
  test("only the asked-for company's items come back", async () => {
    await seedItem({ companyId: COMPANY_A, name: "A-one" });
    await seedItem({ companyId: COMPANY_A, name: "A-two" });
    await seedItem({ companyId: COMPANY_B, name: "B-one" });

    const { status, body } = await call(`?companyId=${COMPANY_A}`);
    expect(status).toBe(200);
    const names = body.items.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(["A-one", "A-two"]));
    expect(names).not.toContain("B-one");
  });

  test("a company with nothing gets an empty list, not everyone else's", async () => {
    await seedItem({ companyId: COMPANY_A, name: "A-only" });
    const ghost = new mongoose.Types.ObjectId();

    const { status, body } = await call(`?companyId=${ghost}`);
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.count).toBe(0);
  });

  test("a missing companyId refuses — it never falls through to an unscoped read", async () => {
    await seedItem({ companyId: COMPANY_A });
    const { status, body } = await call("");
    expect(status).toBe(400);
    expect(body.error).toMatch(/companyid required/i);
    expect(body.items).toBeUndefined();
  });

  test("a malformed companyId refuses rather than listing everything", async () => {
    await seedItem({ companyId: COMPANY_A });
    const { status } = await call("?companyId=nonsense");
    expect(status).toBe(400);
  });

  test("activeCount counts only active rows", async () => {
    await seedItem({ companyId: COMPANY_A, name: "live", status: "active" });
    await seedItem({ companyId: COMPANY_A, name: "held", status: "paused" });
    await seedItem({ companyId: COMPANY_A, name: "done", status: "ended" });

    const { body } = await call(`?companyId=${COMPANY_A}`);
    expect(body.count).toBe(3);
    expect(body.activeCount).toBe(1);
  });

  test("?status= narrows, and an unknown status refuses instead of matching nothing", async () => {
    await seedItem({ companyId: COMPANY_A, name: "live", status: "active" });
    await seedItem({ companyId: COMPANY_A, name: "done", status: "ended" });

    const ok = await call(`?companyId=${COMPANY_A}&status=active`);
    expect(ok.status).toBe(200);
    expect(ok.body.items.map((i) => i.name)).toEqual(["live"]);

    const bad = await call(`?companyId=${COMPANY_A}&status=archived`);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_ENUM");
  });
});

/* ── Update ──────────────────────────────────────────────────────────────── */

describe("update", () => {
  test("a partial patch changes only what it names", async () => {
    const item = await seedItem({ name: "Original", notes: "keep me" });
    const { status, body } = await call(`/${item._id}`, {
      method: "PATCH",
      body: { companyId: COMPANY_A.toString(), amount: 999999 },
    });
    expect(status).toBe(200);
    expect(body.item.amount).toBe(999999);
    expect(body.item.name).toBe("Original");
    expect(body.item.notes).toBe("keep me");

    const stored = await Acc_RecurringItem.findById(item._id).lean();
    expect(stored.amount).toBe(999999);
    expect(String(stored.updatedBy)).toBe(EDITOR.id);
  });

  test("pause and resume are ordinary status updates", async () => {
    const item = await seedItem();

    const paused = await call(`/${item._id}`, {
      method: "PATCH",
      body: { companyId: COMPANY_A.toString(), status: "paused" },
    });
    expect(paused.status).toBe(200);
    expect(paused.body.item.status).toBe("paused");

    const resumed = await call(`/${item._id}`, {
      method: "PATCH",
      body: { companyId: COMPANY_A.toString(), status: "active" },
    });
    expect(resumed.body.item.status).toBe("active");
  });

  test("an invalid patch is refused and the stored row is untouched", async () => {
    const item = await seedItem({ amount: 800000 });
    const { status, body } = await call(`/${item._id}`, {
      method: "PATCH",
      body: { companyId: COMPANY_A.toString(), amount: "abc" },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_TYPE");

    const stored = await Acc_RecurringItem.findById(item._id).lean();
    expect(stored.amount).toBe(800000);
  });

  test("a WRONG companyId cannot update another company's item", async () => {
    const item = await seedItem({ companyId: COMPANY_A, name: "A's item", amount: 100 });

    const { status } = await call(`/${item._id}`, {
      method: "PATCH",
      body: { companyId: COMPANY_B.toString(), amount: 555 },
    });
    expect(status).toBe(404); // simply not found under that company

    const stored = await Acc_RecurringItem.findById(item._id).lean();
    expect(stored.amount).toBe(100);
    expect(stored.name).toBe("A's item");
  });

  test("an update cannot re-tenant a row by naming another company in the body", async () => {
    // `companyId` is stripped as scope and is absent from UPDATE_FIELDS, so
    // there is no path by which a row changes owner.
    const item = await seedItem({ companyId: COMPANY_A });
    const { status } = await call(`/${item._id}`, {
      method: "PATCH",
      body: { companyId: COMPANY_A.toString(), name: "renamed" },
    });
    expect(status).toBe(200);

    const stored = await Acc_RecurringItem.findById(item._id).lean();
    expect(String(stored.companyId)).toBe(COMPANY_A.toString());
  });

  test("a missing companyId on update is refused", async () => {
    const item = await seedItem();
    const { status } = await call(`/${item._id}`, {
      method: "PATCH",
      body: { amount: 1 },
    });
    expect(status).toBe(400);
  });

  test("a malformed item id is refused safely", async () => {
    const { status, body } = await call("/not-an-id", {
      method: "PATCH",
      body: { companyId: COMPANY_A.toString(), amount: 1 },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid item id/i);
  });

  test("switching frequency validates against the merged result", async () => {
    const item = await seedItem({ frequency: "monthly", dayOfMonth: 5, dayOfWeek: null });

    // Monthly → weekly with no dayOfWeek: refused.
    const bad = await call(`/${item._id}`, {
      method: "PATCH",
      body: { companyId: COMPANY_A.toString(), frequency: "weekly" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("REQUIRED");

    // Monthly → weekly WITH one: accepted, and the stale rule is cleared.
    const good = await call(`/${item._id}`, {
      method: "PATCH",
      body: { companyId: COMPANY_A.toString(), frequency: "weekly", dayOfWeek: 2 },
    });
    expect(good.status).toBe(200);
    expect(good.body.item.dayOfWeek).toBe(2);
    expect(good.body.item.dayOfMonth).toBeNull();
  });
});

/* ── Delete (soft) ───────────────────────────────────────────────────────── */

describe("delete is a soft delete", () => {
  test("DELETE sets status to ended and the row survives", async () => {
    const item = await seedItem({ status: "active" });
    const { status, body } = await call(`/${item._id}?companyId=${COMPANY_A}`, {
      method: "DELETE",
    });
    expect(status).toBe(200);
    expect(body.softDeleted).toBe(true);
    expect(body.item.status).toBe("ended");

    const stored = await Acc_RecurringItem.findById(item._id).lean();
    expect(stored).not.toBeNull(); // the whole point: it is NOT gone
    expect(stored.status).toBe("ended");
    expect(stored.amount).toBe(item.amount); // its history is intact
  });

  test("DELETE is company-scoped — another company's item cannot be ended", async () => {
    const item = await seedItem({ companyId: COMPANY_A, status: "active" });
    const { status } = await call(`/${item._id}?companyId=${COMPANY_B}`, {
      method: "DELETE",
    });
    expect(status).toBe(404);

    const stored = await Acc_RecurringItem.findById(item._id).lean();
    expect(stored.status).toBe("active");
  });

  test("DELETE with no companyId is refused", async () => {
    const item = await seedItem({ status: "active" });
    const { status } = await call(`/${item._id}`, { method: "DELETE" });
    expect(status).toBe(400);

    const stored = await Acc_RecurringItem.findById(item._id).lean();
    expect(stored.status).toBe("active");
  });
});

/* ── Permission ──────────────────────────────────────────────────────────── */

describe("read-only roles", () => {
  test("a viewer can list", async () => {
    await seedItem({ companyId: COMPANY_A });
    const { status } = await call(`?companyId=${COMPANY_A}`, { user: VIEWER });
    expect(status).toBe(200);
  });

  test("a viewer cannot create", async () => {
    const before = await Acc_RecurringItem.countDocuments({});
    const { status } = await call("", {
      method: "POST",
      body: monthlyBody(),
      user: VIEWER,
    });
    expect(status).toBe(403);
    expect(await Acc_RecurringItem.countDocuments({})).toBe(before);
  });

  test("a viewer cannot update", async () => {
    const item = await seedItem({ amount: 100 });
    const { status } = await call(`/${item._id}`, {
      method: "PATCH",
      body: { companyId: COMPANY_A.toString(), amount: 999 },
      user: VIEWER,
    });
    expect(status).toBe(403);

    const stored = await Acc_RecurringItem.findById(item._id).lean();
    expect(stored.amount).toBe(100);
  });

  test("a viewer cannot delete", async () => {
    const item = await seedItem({ status: "active" });
    const { status } = await call(`/${item._id}?companyId=${COMPANY_A}`, {
      method: "DELETE",
      user: VIEWER,
    });
    expect(status).toBe(403);

    const stored = await Acc_RecurringItem.findById(item._id).lean();
    expect(stored.status).toBe("active");
  });

  test("no auth at all is refused on every verb", async () => {
    const item = await seedItem();
    const cases = [
      { path: `?companyId=${COMPANY_A}`, method: "GET" },
      { path: "", method: "POST", body: monthlyBody() },
      { path: `/${item._id}`, method: "PATCH", body: { companyId: COMPANY_A.toString(), amount: 1 } },
      { path: `/${item._id}?companyId=${COMPANY_A}`, method: "DELETE" },
    ];
    for (const { path, method, body } of cases) {
      const { status } = await call(path, { method, body, user: null });
      expect(status).toBe(401);
    }
  });
});

/* ── Scope guard: this router writes ONE collection ──────────────────────── */

describe("scope guard", () => {
  test("no Acc_Voucher document is created by any endpoint here", async () => {
    const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
    expect(await Acc_Voucher.countDocuments({})).toBe(0);

    const created = await call("", { method: "POST", body: monthlyBody() });
    await call(`/${created.body.item._id}`, {
      method: "PATCH",
      body: { companyId: COMPANY_A.toString(), amount: 1234 },
    });
    await call(`/${created.body.item._id}?companyId=${COMPANY_A}`, { method: "DELETE" });

    expect(await Acc_Voucher.countDocuments({})).toBe(0);
  });

  test("no Acc_BillTerms document is created by any endpoint here", async () => {
    const Acc_BillTerms = require("../../models/Accountant_model/Acc_BillTerms");
    expect(await Acc_BillTerms.countDocuments({})).toBe(0);

    const created = await call("", { method: "POST", body: monthlyBody() });
    await call(`/${created.body.item._id}`, {
      method: "PATCH",
      body: { companyId: COMPANY_A.toString(), status: "paused" },
    });

    expect(await Acc_BillTerms.countDocuments({})).toBe(0);
  });

  test("the router REQUIRES no voucher, bill-terms or forecast model", async () => {
    // A structural guard, not a behavioural one: the file cannot write what
    // it never imports. Cheaper and more durable than trying to provoke every
    // write path.
    //
    // Deliberately checks the `require` calls rather than the raw text — the
    // file's own header explains at length what it must never write, and a
    // naive text scan flags that prose as a violation. Guarding the imports
    // tests the actual property; guarding the comments only discourages
    // writing them down.
    const fs = require("fs");
    const src = fs.readFileSync(
      require.resolve("../../routes/Accountant_Routes/Acc_recurringItems"),
      "utf8",
    );
    const requires = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);

    expect(requires).not.toEqual(expect.arrayContaining([expect.stringMatching(/VoucherModels/)]));
    expect(requires).not.toEqual(expect.arrayContaining([expect.stringMatching(/BillTerms/)]));
    expect(requires).not.toEqual(expect.arrayContaining([expect.stringMatching(/orecast/)]));

    // The models it may touch, stated positively so a future addition is a
    // deliberate edit to this list rather than a silent widening.
    //
    // `Acc_MasterModels` was added by the C0-E correction pass, READ-ONLY, to
    // verify a supplied `ledgerId` belongs to the requesting company. This
    // list changing is the guard working as intended: it forced that addition
    // to be an explicit decision recorded here.
    const modelRequires = requires.filter((r) => r.includes("models/"));
    expect(modelRequires.sort()).toEqual([
      "../../models/Accountant_model/Acc_MasterModels",
      "../../models/Accountant_model/Acc_RecurringItem",
    ]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * C0-E CORRECTION — the optional ledger link is VERIFIED, not cast
 *
 * The first version did `ledgerId = castId(ledgerId)`, which turned any
 * unparseable value into `null` (a silently swallowed error reported as
 * success) and stored a well-formed FOREIGN id verbatim (a cross-company
 * reference inside a company-scoped collection). Both are closed here.
 * ────────────────────────────────────────────────────────────────────────── */
describe("ledger link is validated by company", () => {
  const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");

  /** A ledger belonging to `companyId`. */
  async function seedLedger(companyId, name = "Freight & Forwarding") {
    const group = await Acc_Group.create({
      companyId,
      name: `Indirect Expenses ${name}`,
      nature: "expense",
    });
    return Acc_Ledger.create({
      companyId,
      name,
      groupId: group._id,
      groupName: group.name,
      nature: "expense",
    });
  }

  test("a valid same-company ledger links, and the name is stored from the ledger", async () => {
    const ledger = await seedLedger(COMPANY_A, "Rent Expense");

    const { status, body } = await call("", {
      method: "POST",
      body: monthlyBody({ ledgerId: ledger._id.toString() }),
    });
    expect(status).toBe(201);
    expect(String(body.item.ledgerId)).toBe(ledger._id.toString());
    expect(body.item.ledgerName).toBe("Rent Expense");

    const stored = await Acc_RecurringItem.findById(body.item._id).lean();
    expect(String(stored.ledgerId)).toBe(ledger._id.toString());
    expect(stored.ledgerName).toBe("Rent Expense");
  });

  test("a malformed ledgerId is REJECTED, not silently nulled", async () => {
    const before = await Acc_RecurringItem.countDocuments({});
    const { status, body } = await call("", {
      method: "POST",
      body: monthlyBody({ ledgerId: "not-an-object-id" }),
    });
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_LEDGER_ID");
    // The old behaviour created the item with ledgerId: null and returned 201.
    expect(await Acc_RecurringItem.countDocuments({})).toBe(before);
  });

  test("a well-formed but non-existent ledgerId is rejected, and nothing is created", async () => {
    const before = await Acc_RecurringItem.countDocuments({});
    const { status, body } = await call("", {
      method: "POST",
      body: monthlyBody({ ledgerId: new mongoose.Types.ObjectId().toString() }),
    });
    expect(status).toBe(400);
    expect(body.code).toBe("LEDGER_NOT_IN_COMPANY");
    expect(await Acc_RecurringItem.countDocuments({})).toBe(before);
  });

  test("a WRONG-COMPANY ledgerId is rejected on create, and the item is not created", async () => {
    const foreign = await seedLedger(COMPANY_B, "B's Freight");
    const before = await Acc_RecurringItem.countDocuments({});

    const { status, body } = await call("", {
      method: "POST",
      body: monthlyBody({ ledgerId: foreign._id.toString() }),
    });
    expect(status).toBe(400);
    expect(body.code).toBe("LEDGER_NOT_IN_COMPANY");
    expect(await Acc_RecurringItem.countDocuments({})).toBe(before);
  });

  test("a WRONG-COMPANY ledgerId is rejected on update, and the item is not modified", async () => {
    const foreign = await seedLedger(COMPANY_B, "B's Freight");
    const item = await seedItem({ ledgerId: null, ledgerName: null });

    const { status, body } = await call(`/${item._id}`, {
      method: "PATCH",
      body: { companyId: COMPANY_A.toString(), ledgerId: foreign._id.toString() },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("LEDGER_NOT_IN_COMPANY");

    const stored = await Acc_RecurringItem.findById(item._id).lean();
    expect(stored.ledgerId == null).toBe(true);
  });

  test("ledgerName in the body cannot spoof the matched ledger when ledgerId is supplied", async () => {
    const ledger = await seedLedger(COMPANY_A, "Freight & Forwarding");

    const { status, body } = await call("", {
      method: "POST",
      body: monthlyBody({
        ledgerId: ledger._id.toString(),
        ledgerName: "Director's Loan Account", // a lie about what is linked
      }),
    });
    expect(status).toBe(201);
    expect(body.item.ledgerName).toBe("Freight & Forwarding");

    const stored = await Acc_RecurringItem.findById(body.item._id).lean();
    expect(stored.ledgerName).toBe("Freight & Forwarding");
  });

  test("a name-only PATCH cannot spoof the label of an item that is already linked", async () => {
    // The subtler half of the same hole: supply no id, only a name, on an
    // item that already HAS a link. The stored link must win.
    const ledger = await seedLedger(COMPANY_A, "Freight & Forwarding");
    const item = await seedItem({ ledgerId: ledger._id, ledgerName: "Freight & Forwarding" });

    const { status, body } = await call(`/${item._id}`, {
      method: "PATCH",
      body: { companyId: COMPANY_A.toString(), ledgerName: "Director's Loan Account" },
    });
    expect(status).toBe(200);
    expect(body.item.ledgerName).toBe("Freight & Forwarding");

    const stored = await Acc_RecurringItem.findById(item._id).lean();
    expect(stored.ledgerName).toBe("Freight & Forwarding");
  });

  test("a free-text ledgerName with NO ledgerId is still allowed — it is a label, not a link", async () => {
    const { status, body } = await call("", {
      method: "POST",
      body: monthlyBody({ ledgerName: "Rent Expense (not yet mapped)" }),
    });
    expect(status).toBe(201);
    expect(body.item.ledgerId).toBeNull();
    expect(body.item.ledgerName).toBe("Rent Expense (not yet mapped)");
  });

  test("an explicit empty ledgerId UNLINKS, and clears the stale name with it", async () => {
    const ledger = await seedLedger(COMPANY_A, "Freight & Forwarding");
    const item = await seedItem({ ledgerId: ledger._id, ledgerName: "Freight & Forwarding" });

    const { status, body } = await call(`/${item._id}`, {
      method: "PATCH",
      body: { companyId: COMPANY_A.toString(), ledgerId: "" },
    });
    expect(status).toBe(200);
    expect(body.item.ledgerId).toBeNull();
    // A name left behind would point at a ledger this item no longer links to.
    expect(body.item.ledgerName).toBeNull();
  });

  test("linking on update stores the ledger's own name", async () => {
    const ledger = await seedLedger(COMPANY_A, "Electricity");
    const item = await seedItem({ ledgerId: null, ledgerName: null });

    const { status, body } = await call(`/${item._id}`, {
      method: "PATCH",
      body: {
        companyId: COMPANY_A.toString(),
        ledgerId: ledger._id.toString(),
        ledgerName: "Something Else Entirely",
      },
    });
    expect(status).toBe(200);
    expect(body.item.ledgerName).toBe("Electricity");
  });
});
