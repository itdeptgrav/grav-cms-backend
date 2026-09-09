// test/accountant/item-budget-head.route.test.js
//
// WHICH BUDGET AN ITEM COMES OUT OF — over HTTP, with the gates on.
//
// The pure resolution rules are proven in services/itemBudgetHead.test.js.
// What can only be proven here is that the ROUTES enforce them: that a
// not-budgeted head is refused at the moment it is mapped rather than months
// later on a bill nobody can check, that one company cannot read or rewrite
// another's mappings, and that Finance authority is required to write at all.
//
// ── AND ONE COMPATIBILITY CLAIM ─────────────────────────────────────────────
// `budgetAllocation` is additive and inert in this chunk. A request written
// before it existed must still load, with the field ABSENT rather than
// defaulted — a default would manufacture an "unresolved" decision on
// thousands of historical lines that nobody ever made.
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
jest.mock("../../Middlewear/AccountantOrgAuthMiddleware", () => ({
  orgAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
  requireRole: () => (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next(),
}));

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const ItemCategoryBudget = require("../../models/Accountant_model/Acc_ItemCategoryBudget");

let server, base, seq = 0;

const financeOf = (companyId) => ({
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner",
  role: "owner",
  companyId: String(companyId),
  permissions: { canEdit: true, canApprove: true },
});
/* An editor may enter vouchers. Classifying what a category spends out of is
   a budget decision, and this is the user that must be refused. */
const editorOf = (companyId) => ({
  id: new mongoose.Types.ObjectId().toString(),
  name: "Sam Editor",
  role: "editor",
  companyId: String(companyId),
  permissions: { canEdit: true },
});

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/accountant/chart-of-accounts",
    require("../../routes/Accountant_Routes/Acc_chartOfAccounts"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/chart-of-accounts`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

async function call(path, { method = "GET", body, user } = {}) {
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

/** A company with one budgetable expense head and one head nobody budgets. */
async function seedCompany() {
  seq += 1;
  const company = await Acc_Company.create({
    companyName: `Item Co ${seq}`,
    booksFromDate: new Date("2026-04-01"),
  });
  const expGroup = await Acc_Group.create({
    companyId: company._id, name: `Purchase Accounts ${seq}`, nature: "expense",
  });
  const bankGroup = await Acc_Group.create({
    companyId: company._id, name: `Bank Accounts ${seq}`, nature: "asset",
  });
  const spendHead = await Acc_Ledger.create({
    companyId: company._id, name: `Raw Material Purchase ${seq}`,
    groupId: expGroup._id, groupName: expGroup.name, nature: "expense",
  });
  const otherHead = await Acc_Ledger.create({
    companyId: company._id, name: `Consumables ${seq}`,
    groupId: expGroup._id, groupName: expGroup.name, nature: "expense",
  });
  const bank = await Acc_Ledger.create({
    companyId: company._id, name: `HDFC Current ${seq}`,
    groupId: bankGroup._id, groupName: bankGroup.name, nature: "asset",
  });
  const revGroup = await Acc_Group.create({
    companyId: company._id, name: `Sales Accounts ${seq}`, nature: "revenue",
  });
  const revenueHead = await Acc_Ledger.create({
    companyId: company._id, name: `Domestic Sales ${seq}`,
    groupId: revGroup._id, groupName: revGroup.name, nature: "revenue",
  });
  return { company, spendHead, otherHead, bank, revenueHead, finance: financeOf(company._id) };
}

const mkItem = (category, extra = {}) =>
  RawItem.create({ name: `Item ${++seq}`, sku: `SKU${seq}`, category, unit: "pcs", ...extra });

/* ── THE MAPPING GATE ─────────────────────────────────────────────────────── */

describe("category mapping", () => {
  test("a budgetable head can be mapped, and the category then resolves to it", async () => {
    const { company, spendHead, finance } = await seedCompany();
    const item = await mkItem("Fabric");

    const set = await call(`/item-categories/Fabric`, {
      method: "PUT", user: finance,
      body: { companyId: String(company._id), budgetLedgerId: String(spendHead._id) },
    });
    expect(set.status).toBe(200);

    const { body } = await call(`/item-budget-heads/resolve?companyId=${company._id}`, {
      method: "POST", user: finance, body: { itemIds: [String(item._id)] },
    });
    expect(body.results[0].source).toBe("category_mapping");
    expect(String(body.results[0].budgetLedgerId)).toBe(String(spendHead._id));
  });

  test("a NOT-BUDGETED head is refused at the moment it is mapped", async () => {
    /* Refused here, not months later on a bill that cannot be checked. A
       category pointed at a bank account produces request lines no budget
       could ever match. */
    const { company, bank, finance } = await seedCompany();
    const { status, body } = await call(`/item-categories/Fabric`, {
      method: "PUT", user: finance,
      body: { companyId: String(company._id), budgetLedgerId: String(bank._id) },
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/not a budget head/i);
  });

  test("a ledger id the client invented is refused, not trusted", async () => {
    const { company, finance } = await seedCompany();
    const { status } = await call(`/item-categories/Fabric`, {
      method: "PUT", user: finance,
      body: {
        companyId: String(company._id),
        budgetLedgerId: new mongoose.Types.ObjectId().toString(),
      },
    });
    expect(status).toBe(400);
  });

  test("clearing a mapping leaves the category unresolved, not broken", async () => {
    const { company, spendHead, finance } = await seedCompany();
    const item = await mkItem("Trims");
    await call(`/item-categories/Trims`, {
      method: "PUT", user: finance,
      body: { companyId: String(company._id), budgetLedgerId: String(spendHead._id) },
    });
    await call(`/item-categories/Trims`, {
      method: "PUT", user: finance,
      body: { companyId: String(company._id), budgetLedgerId: null },
    });
    const { body } = await call(`/item-budget-heads/resolve?companyId=${company._id}`, {
      method: "POST", user: finance, body: { itemIds: [String(item._id)] },
    });
    expect(body.results[0].source).toBe("unresolved");
    expect(body.results[0].budgetLedgerId).toBeNull();
  });

  test("an editor may not map a category — it is a budget decision", async () => {
    const { company, spendHead } = await seedCompany();
    const { status } = await call(`/item-categories/Fabric`, {
      method: "PUT", user: editorOf(company._id),
      body: { companyId: String(company._id), budgetLedgerId: String(spendHead._id) },
    });
    expect(status).toBe(403);
  });

  test("an unauthenticated caller gets nothing", async () => {
    const { status } = await call(`/item-categories`, {});
    expect(status).toBe(401);
  });
});

/* ── COMPANY ISOLATION ────────────────────────────────────────────────────── */

describe("company isolation", () => {
  test("company B's mapping does not resolve for company A", async () => {
    const A = await seedCompany();
    const B = await seedCompany();
    const item = await mkItem("Packaging");

    await call(`/item-categories/Packaging`, {
      method: "PUT", user: B.finance,
      body: { companyId: String(B.company._id), budgetLedgerId: String(B.spendHead._id) },
    });

    /* Same item, same category — A has mapped nothing, so A sees nothing.
       The item master is shared; the MAPPING is what is company-scoped. */
    const { body } = await call(`/item-budget-heads/resolve?companyId=${A.company._id}`, {
      method: "POST", user: A.finance, body: { itemIds: [String(item._id)] },
    });
    expect(body.results[0].source).toBe("unresolved");
  });

  test("a caller cannot read another company by supplying its id", async () => {
    const A = await seedCompany();
    const B = await seedCompany();
    const { status, body } = await call(`/item-categories?companyId=${B.company._id}`, {
      user: A.finance,
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/not yours/i);
  });

  test("a caller cannot WRITE a mapping into another company", async () => {
    const A = await seedCompany();
    const B = await seedCompany();
    const { status } = await call(`/item-categories/Fabric`, {
      method: "PUT", user: A.finance,
      body: { companyId: String(B.company._id), budgetLedgerId: String(B.spendHead._id) },
    });
    expect(status).toBe(400);
    expect(await ItemCategoryBudget.countDocuments({ companyId: B.company._id })).toBe(0);
  });
});

/* ── THE ITEM OVERRIDE ────────────────────────────────────────────────────── */

describe("item override", () => {
  test("an override beats the category mapping, and clearing it falls back", async () => {
    const { company, spendHead, otherHead, finance } = await seedCompany();
    const item = await mkItem("Fabric");
    await call(`/item-categories/Fabric`, {
      method: "PUT", user: finance,
      body: { companyId: String(company._id), budgetLedgerId: String(spendHead._id) },
    });

    const resolve = async () =>
      (await call(`/item-budget-heads/resolve?companyId=${company._id}`, {
        method: "POST", user: finance, body: { itemIds: [String(item._id)] },
      })).body.results[0];

    expect((await resolve()).source).toBe("category_mapping");

    await call(`/raw-items/${item._id}/budget-head`, {
      method: "PUT", user: finance, body: { budgetLedgerId: String(otherHead._id) },
    });
    const overridden = await resolve();
    expect(overridden.source).toBe("item_override");
    expect(String(overridden.budgetLedgerId)).toBe(String(otherHead._id));

    /* Cleared, not stranded — the escape hatch is not a one-way door. */
    await call(`/raw-items/${item._id}/budget-head`, {
      method: "PUT", user: finance, body: { budgetLedgerId: null },
    });
    const cleared = await resolve();
    expect(cleared.source).toBe("category_mapping");
    expect(String(cleared.budgetLedgerId)).toBe(String(spendHead._id));
  });

  test("an override to a not-budgeted head is refused", async () => {
    const { company, bank, finance } = await seedCompany();
    const item = await mkItem("Fabric");
    const { status } = await call(`/raw-items/${item._id}/budget-head`, {
      method: "PUT", user: finance, body: { budgetLedgerId: String(bank._id) },
    });
    expect(status).toBe(400);
    expect((await RawItem.findById(item._id)).budgetLedgerId).toBeNull();
  });

  test("an editor may not set an override", async () => {
    const { company, spendHead } = await seedCompany();
    const item = await mkItem("Fabric");
    const { status } = await call(`/raw-items/${item._id}/budget-head`, {
      method: "PUT", user: editorOf(company._id),
      body: { budgetLedgerId: String(spendHead._id) },
    });
    expect(status).toBe(403);
  });
});

/* ══ CHUNK 1.1 — INTEGRITY CORRECTIONS ═══════════════════════════════════════ */

describe("a ledger must belong to the mapping company", () => {
  test("company A cannot map company B's ledger to a category", async () => {
    /* B's head is perfectly budget-eligible. Eligibility was the only thing
       previously checked, so the sole barrier between two companies' charts
       was that nobody had tried pasting an id. */
    const A = await seedCompany();
    const B = await seedCompany();
    const { status, body } = await call(`/item-categories/Fabric`, {
      method: "PUT", user: A.finance,
      body: { companyId: String(A.company._id), budgetLedgerId: String(B.spendHead._id) },
    });
    expect(status).toBe(400);
    /* Worded identically to a missing ledger. Saying "exists, but not yours"
       confirms another company's records. */
    expect(body.message).toMatch(/does not exist/i);
    expect(await ItemCategoryBudget.countDocuments({ companyId: A.company._id })).toBe(0);
  });

  test("company A cannot override an item onto company B's ledger", async () => {
    const A = await seedCompany();
    const B = await seedCompany();
    const item = await mkItem("Fabric");
    const { status } = await call(`/raw-items/${item._id}/budget-head`, {
      method: "PUT", user: A.finance,
      body: { companyId: String(A.company._id), budgetLedgerId: String(B.spendHead._id) },
    });
    expect(status).toBe(400);
    expect((await RawItem.findById(item._id)).budgetLedgerId).toBeNull();
  });

  test("the company's own ledger still maps", async () => {
    /* The check must refuse the other company, not everything. */
    const A = await seedCompany();
    await seedCompany();
    const { status } = await call(`/item-categories/Fabric`, {
      method: "PUT", user: A.finance,
      body: { companyId: String(A.company._id), budgetLedgerId: String(A.spendHead._id) },
    });
    expect(status).toBe(200);
  });
});

describe("only an EXPENSE budget may be mapped", () => {
  test("a revenue target is refused for a category", async () => {
    /* This mapping decides where purchase and service SPEND is charged. A
       revenue target is a figure to hit, not an envelope to spend from. */
    const { company, revenueHead, finance } = await seedCompany();
    const { status, body } = await call(`/item-categories/Fabric`, {
      method: "PUT", user: finance,
      body: { companyId: String(company._id), budgetLedgerId: String(revenueHead._id) },
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/revenue target/i);
  });

  test("a revenue target is refused for an item override", async () => {
    const { company, revenueHead, finance } = await seedCompany();
    const item = await mkItem("Fabric");
    const { status, body } = await call(`/raw-items/${item._id}/budget-head`, {
      method: "PUT", user: finance,
      body: { companyId: String(company._id), budgetLedgerId: String(revenueHead._id) },
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/revenue target/i);
    expect((await RawItem.findById(item._id)).budgetLedgerId).toBeNull();
  });
});

describe("one category, however it is spelled", () => {
  test("case and whitespace variants are one mapping, not three", async () => {
    const { company, spendHead, otherHead, finance } = await seedCompany();
    const set = (category, head) =>
      call(`/item-categories/${encodeURIComponent(category)}`, {
        method: "PUT", user: finance,
        body: { companyId: String(company._id), budgetLedgerId: String(head._id) },
      });

    expect((await set("Fabric", spendHead)).status).toBe(200);
    expect((await set(" fabric ", otherHead)).status).toBe(200);
    expect((await set("FABRIC", spendHead)).status).toBe(200);

    /* One row, not three — so the resolver has nothing to choose between. */
    const rows = await ItemCategoryBudget.find({ companyId: company._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].categoryKey).toBe("fabric");
    expect(String(rows[0].budgetLedgerId)).toBe(String(spendHead._id));
  });

  test("an item spelled differently from the mapping still resolves", async () => {
    /* The failure this prevents: a head that exists, is configured, and does
       nothing, because the item said "fabric" and finance typed "Fabric". */
    const { company, spendHead, finance } = await seedCompany();
    const item = await mkItem("  FABRIC ");
    await call(`/item-categories/Fabric`, {
      method: "PUT", user: finance,
      body: { companyId: String(company._id), budgetLedgerId: String(spendHead._id) },
    });
    const { body } = await call(`/item-budget-heads/resolve?companyId=${company._id}`, {
      method: "POST", user: finance, body: { itemIds: [String(item._id)] },
    });
    expect(body.results[0].source).toBe("category_mapping");
  });

  test("internal double spaces are the same category", async () => {
    const { company, spendHead, finance } = await seedCompany();
    const item = await mkItem("Raw  Material");
    await call(`/item-categories/${encodeURIComponent("Raw Material")}`, {
      method: "PUT", user: finance,
      body: { companyId: String(company._id), budgetLedgerId: String(spendHead._id) },
    });
    const { body } = await call(`/item-budget-heads/resolve?companyId=${company._id}`, {
      method: "POST", user: finance, body: { itemIds: [String(item._id)] },
    });
    expect(body.results[0].source).toBe("category_mapping");
  });

  test("coverage counts spelling variants as ONE row", async () => {
    /* Two rows for one category would report the mapped half as covered and
       the other half as work no mapping could ever close. */
    const { company, spendHead, finance } = await seedCompany();
    await mkItem("Piping"); await mkItem("piping"); await mkItem(" PIPING ");
    await call(`/item-categories/Piping`, {
      method: "PUT", user: finance,
      body: { companyId: String(company._id), budgetLedgerId: String(spendHead._id) },
    });

    const { body } = await call(`/item-categories?companyId=${company._id}`, { user: finance });
    const piping = body.rows.filter((r) => r.categoryKey === "piping");
    expect(piping).toHaveLength(1);
    expect(piping[0].items).toBe(3);
    expect(piping[0].mapped).toBe(true);
    /* And it says which spellings it folded together. */
    expect(piping[0].spellings.length).toBeGreaterThan(1);
  });
});

describe("wording promises nothing that does not exist yet", () => {
  test("clearing a mapping does not claim requesters will be asked", async () => {
    /* Chunk 1 has no item-wise request flow. Saying otherwise describes a
       screen nobody can open. */
    const { company, finance } = await seedCompany();
    const { body } = await call(`/item-categories/Trims`, {
      method: "PUT", user: finance,
      body: { companyId: String(company._id), budgetLedgerId: null },
    });
    expect(body.message).not.toMatch(/requester/i);
    expect(body.message).toMatch(/unresolved/i);
    expect(body.message).toMatch(/when item-wise request allocation is enabled/i);
  });

  test("setting a mapping does not imply budget movement", async () => {
    const { company, spendHead, finance } = await seedCompany();
    const { body } = await call(`/item-categories/Fabric`, {
      method: "PUT", user: finance,
      body: { companyId: String(company._id), budgetLedgerId: String(spendHead._id) },
    });
    expect(body.message).toMatch(/does not move any budget/i);
  });
});

/* ── COVERAGE, COUNTED IN ITEMS ───────────────────────────────────────────── */

describe("coverage", () => {
  test("reports items, not categories, and separates uncategorised from unmapped", async () => {
    /* "13 of 15 categories mapped" reads as nearly finished when the two
       missing ones are half the master. Items are the honest denominator. */
    const { company, spendHead, finance } = await seedCompany();
    await mkItem("Fabric"); await mkItem("Fabric"); await mkItem("Fabric");
    await mkItem("Piping");
    await mkItem("");            // no category at all
    await mkItem("");

    await call(`/item-categories/Fabric`, {
      method: "PUT", user: finance,
      body: { companyId: String(company._id), budgetLedgerId: String(spendHead._id) },
    });

    const { body } = await call(`/item-categories?companyId=${company._id}`, { user: finance });
    const row = (c) => body.rows.find((r) => r.category === c);
    expect(row("Fabric").mapped).toBe(true);
    expect(row("Fabric").items).toBeGreaterThanOrEqual(3);
    expect(row("Piping").mapped).toBe(false);
    expect(body.itemsUncategorised).toBeGreaterThanOrEqual(2);
    /* An uncategorised item is the store's data problem, never counted as
       something finance failed to map. */
    expect(body.rows.find((r) => r.uncategorised).mapped).toBe(false);
  });
});

/* ── COMPATIBILITY ────────────────────────────────────────────────────────── */

describe("existing data is untouched", () => {
  test("a legacy request line loads with NO budgetAllocation at all", async () => {
    /* Absent, not defaulted. A default would write an 'unresolved' decision
       onto every historical line that nobody ever made. */
    const doc = await SpendRequest.create({
      requestNumber: `SPR-LEGACY-${++seq}`,
      title: "Cotton for the June run",
      requestType: "PRODUCT",
      purpose: "Production run",
      requestedBy: new mongoose.Types.ObjectId(),
      department: "Production",
      items: [{
        name: "Cotton", whyNeeded: "Production run",
        quantity: 10, unit: "m", rate: 100, amount: 1000,
      }],
    });
    const fetched = await SpendRequest.findById(doc._id).lean();
    expect(fetched.items).toHaveLength(1);
    expect(fetched.items[0].budgetAllocation).toBeUndefined();
    /* And every field it always had is still there. */
    expect(fetched.items[0].name).toBe("Cotton");
    expect(fetched.items[0].amount).toBe(1000);
  });

  test("a legacy raw item loads with no override and resolves by category", async () => {
    const { company, spendHead, finance } = await seedCompany();
    const legacy = await RawItem.create({ name: `Legacy ${++seq}`, sku: `LEG${seq}`, category: "Fabric", unit: "m" });
    expect(legacy.budgetLedgerId).toBeNull();

    await call(`/item-categories/Fabric`, {
      method: "PUT", user: finance,
      body: { companyId: String(company._id), budgetLedgerId: String(spendHead._id) },
    });
    const { body } = await call(`/item-budget-heads/resolve?companyId=${company._id}`, {
      method: "POST", user: finance, body: { itemIds: [String(legacy._id)] },
    });
    expect(body.results[0].source).toBe("category_mapping");
  });

  test("an id that matches no item is answered, not silently dropped", async () => {
    const { company, finance } = await seedCompany();
    const ghost = new mongoose.Types.ObjectId().toString();
    const { body } = await call(`/item-budget-heads/resolve?companyId=${company._id}`, {
      method: "POST", user: finance, body: { itemIds: [ghost] },
    });
    expect(body.results).toHaveLength(1);
    expect(body.results[0].found).toBe(false);
  });
});
