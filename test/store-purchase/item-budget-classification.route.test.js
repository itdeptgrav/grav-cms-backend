// test/store-purchase/item-budget-classification.route.test.js
//
// THE STORE MAY SEE WHICH BUDGET AN ITEM COMES OUT OF. IT MAY NOT SET IT.
//
// ── WHY A READ HAD TO BE ADDED AT ALL ───────────────────────────────────────
// The resolver, the category mappings, the item overrides and the whole
// commitment lifecycle have existed for several chunks, and every route that
// could answer "which head does this item use?" sits behind `accountantAuth`
// AND `financeOnly` — owner, approver, admin or accountant. A storekeeper
// holds none of those and should not. So they could not see the classification
// their own category choice decided, and found out at Finance approval.
//
// ── AND WHY IT IS NARROW ────────────────────────────────────────────────────
// It answers for the caller's OWN items, with four facts: head id, head name,
// source, message. No ledger balances. No budget figures. No chart of
// accounts — a Store caller cannot enumerate heads through it, only see the
// one their item resolves to. No setter identity: who made a classification
// decision is Finance's record. And it writes nothing, ever.
//
// ── THE WRITE BOUNDARY THIS ALSO PINS ───────────────────────────────────────
// The ordinary item save must not be able to set, clear or re-stamp a budget
// mapping. Not "does not today" — pinned, because both handlers build their
// updates from a destructured whitelist and a whitelist is one careless spread
// away from not being one.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Employee = require("../../models/Employee");
const {
  Acc_Company, Acc_Group, Acc_Ledger,
} = require("../../models/Accountant_model/Acc_MasterModels");
const CategoryBudget = require("../../models/Accountant_model/Acc_ItemCategoryBudget");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/raw-items", require("../../routes/CMS_Routes/Inventory/Products/rawItems"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, token, cookie } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function person({ co, grant = "store", role = "approver" }) {
  const n = ++seq;
  const email = `ibc${n}@test.example`;
  const emp = await Employee.create({
    firstName: "P", lastName: `L${n}`, email, biometricId: `IBC${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role, isActive: true });
  if (co) await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "P" });
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "P", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/** An expense head this company may legitimately budget against.
 *  The group is per COMPANY, not per head — `companyId + name` is unique, and
 *  a company with two heads needs one group, not two identical ones. */
async function head(co, name) {
  const group = await Acc_Group.findOneAndUpdate(
    { companyId: co._id, name: "Indirect Expenses" },
    { $setOnInsert: { companyId: co._id, name: "Indirect Expenses", nature: "expense" } },
    { new: true, upsert: true },
  );
  return Acc_Ledger.create({
    companyId: co._id, name: `${name} ${++seq}`, groupId: group._id,
    groupName: group.name, nature: "expense",
  });
}

const map = (co, category, ledger) => CategoryBudget.create({
  companyId: co._id, category, categoryKey: category.trim().toLowerCase(),
  budgetLedgerId: ledger._id, budgetLedgerName: ledger.name,
});

const item = ({ co, category = "Fabric", over = {} }) => RawItem.create({
  companyId: co._id, name: `Cotton ${++seq}`, sku: `RAW-CTN-${seq}`,
  unit: "m", category, quantity: 0, minStock: 0, maxStock: 100, ...over,
});

const READ = "/raw-items/data/budget-classification";

/* ═══ 1 · THE READ ═══════════════════════════════════════════════════════ */

describe("what a Store caller may read", () => {
  test("an unauthenticated caller reads nothing", async () => {
    expect([401, 403]).toContain((await call(READ)).status);
  });

  test("an authenticated employee with no Store grant is refused", async () => {
    const co = await company("Acme");
    const nobody = await person({ co, grant: null });
    expect((await call(READ, { token: nobody.token })).status).toBe(403);
  });

  test("a category resolves to the head Finance mapped it to", async () => {
    const co = await company("Acme");
    const who = await person({ co });
    const raw = await head(co, "Raw Material Purchase");
    await map(co, "Fabric", raw);

    const res = await call(`${READ}?category=Fabric`, { token: who.token });
    expect(res.status).toBe(200);
    expect(res.body.categoryDefault.budgetLedgerId).toBe(String(raw._id));
    expect(res.body.categoryDefault.source).toBe("category_mapping");
    /* This is the PREVIEW behind the Add-item form: no item exists yet, so
       there is no override to find and none is invented. */
    expect(res.body.items).toEqual([]);
  });

  test("an unmapped category answers honestly, and is not an error", async () => {
    const co = await company("Acme");
    const who = await person({ co });
    const res = await call(`${READ}?category=Trims`, { token: who.token });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.categoryDefault.budgetLedgerId).toBeNull();
    expect(res.body.categoryDefault.source).toBe("unresolved");
    /* Unresolved is an ANSWER. A 404 or a 500 here would make the form show
       "could not be read", which says nothing about whether it is mapped. */
    expect(res.body.categoryDefault.message).toMatch(/no budget head mapped/i);
  });

  test("an item override wins over its category, and says which it was", async () => {
    const co = await company("Acme");
    const who = await person({ co });
    const raw = await head(co, "Raw Material Purchase");
    const sampling = await head(co, "Sampling Materials");
    await map(co, "Fabric", raw);
    const it = await item({
      co, category: "Fabric",
      over: { budgetLedgerId: sampling._id, budgetLedgerName: sampling.name },
    });

    const res = await call(`${READ}?itemIds=${it._id}`, { token: who.token });
    expect(res.status).toBe(200);
    const row = res.body.items[0];
    expect(row.budgetLedgerId).toBe(String(sampling._id));
    expect(row.source).toBe("item_override");
    /* And not the category's head, even though the category maps to one. */
    expect(row.budgetLedgerId).not.toBe(String(raw._id));
  });

  test("an item with no override falls through to its category", async () => {
    const co = await company("Acme");
    const who = await person({ co });
    const raw = await head(co, "Raw Material Purchase");
    await map(co, "Fabric", raw);
    const it = await item({ co, category: "Fabric" });

    const row = (await call(`${READ}?itemIds=${it._id}`, { token: who.token })).body.items[0];
    expect(row.budgetLedgerId).toBe(String(raw._id));
    expect(row.source).toBe("category_mapping");
  });

  test("every requested id gets a row, including one that matches nothing", async () => {
    const co = await company("Acme");
    const who = await person({ co });
    const it = await item({ co });
    const ghost = new mongoose.Types.ObjectId();

    const res = await call(`${READ}?itemIds=${it._id},${ghost},not-an-id`, { token: who.token });
    expect(res.body.items).toHaveLength(3);
    /* A caller who asked about three and received one would read the answer
       as complete. */
    expect(res.body.items.map((r) => r.found)).toEqual([true, false, false]);
  });
});

/* ═══ 2 · COMPANY SCOPE ══════════════════════════════════════════════════ */

describe("company scope", () => {
  test("another company's item is not readable through an id", async () => {
    const a = await company("Acme");
    const b = await company("Beta");
    const mine = await person({ co: a });
    const theirs = await item({ co: b, category: "Fabric" });
    const rawB = await head(b, "Raw Material Purchase");
    await map(b, "Fabric", rawB);

    const row = (await call(`${READ}?itemIds=${theirs._id}`, { token: mine.token })).body.items[0];
    /* Worded EXACTLY like an id that does not exist. Saying "not yours"
       would confirm that another company holds that record. */
    expect(row.found).toBe(false);
    expect(row.budgetLedgerId).toBeNull();
    expect(row.message).toBe("No item with this id.");
    expect(row.itemName).toBeUndefined();
  });

  test("a category resolves against the caller's own mappings only", async () => {
    const a = await company("Acme");
    const b = await company("Beta");
    const mine = await person({ co: a });
    /* Only B has mapped Fabric. A must not inherit it. */
    await map(b, "Fabric", await head(b, "Raw Material Purchase"));

    const res = await call(`${READ}?category=Fabric`, { token: mine.token });
    expect(res.body.categoryDefault.budgetLedgerId).toBeNull();
    expect(res.body.categoryDefault.source).toBe("unresolved");
  });
});

/* ═══ 3 · WHAT IT REFUSES TO CARRY ═══════════════════════════════════════ */

describe("the response stays narrow", () => {
  test("no balance, no budget figure and no setter identity comes back", async () => {
    const co = await company("Acme");
    const who = await person({ co });
    const raw = await head(co, "Raw Material Purchase");
    await map(co, "Fabric", raw);
    const it = await item({
      co, category: "Fabric",
      over: {
        budgetLedgerId: raw._id, budgetLedgerName: raw.name,
        budgetLedgerSetByName: "Someone In Finance", budgetLedgerSetAt: new Date(),
      },
    });

    const res = await call(`${READ}?itemIds=${it._id}&category=Fabric`, { token: who.token });
    const text = JSON.stringify(res.body);
    for (const leak of [
      "closingBalance", "openingBalance", "allocatedAmount", "consumed",
      "remainingAmount", "budgetLedgerSetBy", "setByName", "setAt",
      "Someone In Finance",
    ]) {
      expect(text).not.toContain(leak);
    }
    /* And the four facts it DOES carry. */
    expect(Object.keys(res.body.items[0]).sort()).toEqual(
      ["budgetLedgerId", "budgetLedgerName", "category", "found", "itemId", "message", "source"],
    );
  });

  test("it is not a chart of accounts — an empty ask returns no heads", async () => {
    const co = await company("Acme");
    const who = await person({ co });
    await map(co, "Fabric", await head(co, "Raw Material Purchase"));
    await map(co, "Trims", await head(co, "Consumables"));

    const res = await call(READ, { token: who.token });
    expect(res.status).toBe(200);
    /* Asked nothing, told nothing. A Store caller cannot enumerate the
       company's heads through this route. */
    expect(res.body.items).toEqual([]);
    expect(res.body.categoryDefault).toBeNull();
  });

  test("the Manage in Finance link is offered only to a Finance session", async () => {
    const co = await company("Acme");
    const who = await person({ co });

    /* A Store session alone: no accountant token, so no link. */
    const plain = await call(`${READ}?category=Fabric`, { token: who.token });
    expect(plain.body.financeSurface.reachable).toBe(false);

    /* The same person carrying a Finance session too. */
    const financeToken = jwt.sign(
      { id: String(new mongoose.Types.ObjectId()), email: who.email, role: "owner" },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    );
    const withFinance = await call(`${READ}?category=Fabric`, {
      token: who.token, cookie: `accountant_token=${financeToken}`,
    });
    expect(withFinance.body.financeSurface.reachable).toBe(true);

    /* A Finance session whose role cannot map — `financeOnly` refuses
       `viewer`, so offering the link would be a link that 403s on click. */
    const viewerToken = jwt.sign(
      { id: String(new mongoose.Types.ObjectId()), email: who.email, role: "viewer" },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    );
    const asViewer = await call(`${READ}?category=Fabric`, {
      token: who.token, cookie: `accountant_token=${viewerToken}`,
    });
    expect(asViewer.body.financeSurface.reachable).toBe(false);

    /* And a cookie that is not a token at all is "not reachable", not a 500. */
    const junk = await call(`${READ}?category=Fabric`, {
      token: who.token, cookie: "accountant_token=not-a-jwt",
    });
    expect(junk.status).toBe(200);
    expect(junk.body.financeSurface.reachable).toBe(false);
  });
});

/* ═══ 4 · FINANCE REMAINS THE ONLY WRITE AUTHORITY ═══════════════════════ */

describe("the Store save cannot change a mapping", () => {
  test("creating an item ignores a budget head in the payload", async () => {
    const co = await company("Acme");
    const who = await person({ co });
    const raw = await head(co, "Raw Material Purchase");

    const res = await call("/raw-items", {
      method: "POST", token: who.token,
      body: {
        name: "Smuggled", category: "Fabric", unit: "m", minStock: 0, maxStock: 10,
        budgetLedgerId: String(raw._id),
        budgetLedgerName: raw.name,
        budgetLedgerSetByName: "Store User",
        budgetLedgerSetAt: new Date().toISOString(),
      },
    });
    expect(res.status).toBe(201);

    const stored = await RawItem.findOne({ name: "Smuggled" }).lean();
    expect(stored.budgetLedgerId).toBeNull();
    expect(stored.budgetLedgerName || "").toBe("");
    expect(stored.budgetLedgerSetByName || "").toBe("");
    expect(stored.budgetLedgerSetAt).toBeNull();
  });

  test("editing an item cannot set, change or clear an existing override", async () => {
    const co = await company("Acme");
    const who = await person({ co });
    const kept = await head(co, "Sampling Materials");
    const wanted = await head(co, "Raw Material Purchase");
    const setAt = new Date("2026-06-01T00:00:00.000Z");
    const it = await item({
      co, category: "Fabric",
      over: {
        budgetLedgerId: kept._id, budgetLedgerName: kept.name,
        budgetLedgerSetByName: "Finance Owner", budgetLedgerSetAt: setAt,
      },
    });

    /* Try to point it somewhere else… */
    const moved = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: who.token,
      body: {
        name: "Renamed", budgetLedgerId: String(wanted._id), budgetLedgerName: wanted.name,
        budgetLedgerSetByName: "Store User", budgetLedgerSetAt: new Date().toISOString(),
      },
    });
    expect(moved.status).toBe(200);

    /* …and to clear it. */
    await call(`/raw-items/${it._id}`, {
      method: "PUT", token: who.token,
      body: { budgetLedgerId: null, budgetLedgerName: "" },
    });

    const after = await RawItem.findById(it._id).lean();
    expect(String(after.budgetLedgerId)).toBe(String(kept._id));
    expect(after.budgetLedgerName).toBe(kept.name);
    /* The audit trail is Finance's record, and an edit did not re-stamp it. */
    expect(after.budgetLedgerSetByName).toBe("Finance Owner");
    expect(new Date(after.budgetLedgerSetAt).toISOString()).toBe(setAt.toISOString());
    /* The ordinary edit still worked — this is a boundary, not a refusal. */
    expect(after.name).toBe("Renamed");
  });

  test("the read route writes nothing at all", async () => {
    const co = await company("Acme");
    const who = await person({ co });
    const it = await item({ co, category: "Fabric" });
    const before = await RawItem.findById(it._id).lean();

    await call(`${READ}?itemIds=${it._id}&category=Fabric`, { token: who.token });

    const after = await RawItem.findById(it._id).lean();
    expect(new Date(after.updatedAt).toISOString())
      .toBe(new Date(before.updatedAt).toISOString());
    expect(await CategoryBudget.countDocuments({ companyId: co._id })).toBe(0);
  });
});

/* ═══ 5 · A CATEGORY SOMEBODY TYPED IS STILL A CATEGORY ══════════════════ */
//
// The form stores a picked category in `category` and a typed one in
// `customCategory`, with `category` set to "". The resolver read only
// `category`, so the Add-item form previewed a typed value as a confidently
// mapped head and the saved item then resolved to "no category at all".
// Same item, two answers, and nothing on screen explaining the change.

describe("custom categories resolve like any other", () => {
  const CUSTOM = "Specialty Weave";

  test("a mapped custom category previews and resolves to the same head", async () => {
    const co = await company("Acme");
    const who = await person({ co });
    const raw = await head(co, "Raw Material Purchase");
    await map(co, CUSTOM, raw);

    /* What the Add-item form asks before saving. */
    const preview = await call(`${READ}?category=${encodeURIComponent(CUSTOM)}`, { token: who.token });
    expect(preview.body.categoryDefault.budgetLedgerId).toBe(String(raw._id));
    expect(preview.body.categoryDefault.source).toBe("category_mapping");

    /* The same item, saved through the real Store route the way the form
       submits a custom category. */
    const created = await call("/raw-items", {
      method: "POST", token: who.token,
      body: {
        name: "Handloom", category: "", customCategory: CUSTOM,
        unit: "m", minStock: 0, maxStock: 10,
      },
    });
    expect(created.status).toBe(201);
    const stored = await RawItem.findOne({ name: "Handloom" }).lean();
    expect(stored.category).toBe("");
    expect(stored.customCategory).toBe(CUSTOM);

    const after = await call(`${READ}?itemIds=${stored._id}`, { token: who.token });
    const row = after.body.items[0];
    /* The whole correction, in one assertion: the answer did not change when
       the item was saved. */
    expect(row.budgetLedgerId).toBe(preview.body.categoryDefault.budgetLedgerId);
    expect(row.source).toBe(preview.body.categoryDefault.source);
    expect(row.category).toBe(CUSTOM);
  });

  test("an unmapped custom category stays unresolved before and after saving", async () => {
    const co = await company("Acme");
    const who = await person({ co });

    const preview = await call(`${READ}?category=${encodeURIComponent("Handloom Silk")}`, { token: who.token });
    expect(preview.body.categoryDefault.budgetLedgerId).toBeNull();
    expect(preview.body.categoryDefault.source).toBe("unresolved");

    const it = await item({ co, category: "", over: { customCategory: "Handloom Silk" } });
    const row = (await call(`${READ}?itemIds=${it._id}`, { token: who.token })).body.items[0];
    expect(row.budgetLedgerId).toBeNull();
    expect(row.source).toBe("unresolved");
    /* It names the category rather than claiming the item has none — a
       different problem, pointing at a different desk. */
    expect(row.message).toMatch(/No budget head mapped for category "Handloom Silk"/);
  });

  test("an item override beats a mapped custom category", async () => {
    const co = await company("Acme");
    const who = await person({ co });
    const raw = await head(co, "Raw Material Purchase");
    const sampling = await head(co, "Sampling Materials");
    await map(co, CUSTOM, raw);
    const it = await item({
      co, category: "",
      over: {
        customCategory: CUSTOM,
        budgetLedgerId: sampling._id, budgetLedgerName: sampling.name,
      },
    });

    const row = (await call(`${READ}?itemIds=${it._id}`, { token: who.token })).body.items[0];
    expect(row.budgetLedgerId).toBe(String(sampling._id));
    expect(row.source).toBe("item_override");
    expect(row.budgetLedgerId).not.toBe(String(raw._id));
  });

  test("a standard category is unchanged, and a blank custom field never shadows it", async () => {
    const co = await company("Acme");
    const who = await person({ co });
    const raw = await head(co, "Raw Material Purchase");
    await map(co, "Fabric", raw);

    for (const over of [{}, { customCategory: "" }]) {
      const it = await item({ co, category: "Fabric", over });
      const row = (await call(`${READ}?itemIds=${it._id}`, { token: who.token })).body.items[0];
      expect(row.budgetLedgerId).toBe(String(raw._id));
      expect(row.source).toBe("category_mapping");
      expect(row.category).toBe("Fabric");
    }
  });

  test("seeing a custom category's head grants no authority to set one", async () => {
    const co = await company("Acme");
    const who = await person({ co });
    const raw = await head(co, "Raw Material Purchase");
    await map(co, CUSTOM, raw);

    /* The Store may now resolve a typed category. It still may not write a
       mapping through the item save. */
    await call("/raw-items", {
      method: "POST", token: who.token,
      body: {
        name: "Still Refused", category: "", customCategory: CUSTOM,
        unit: "m", minStock: 0, maxStock: 10,
        budgetLedgerId: String(raw._id), budgetLedgerName: raw.name,
      },
    });
    const stored = await RawItem.findOne({ name: "Still Refused" }).lean();
    expect(stored.budgetLedgerId).toBeNull();
    /* And it resolves through the CATEGORY, not through a stored override. */
    const row = (await call(`${READ}?itemIds=${stored._id}`, { token: who.token })).body.items[0];
    expect(row.source).toBe("category_mapping");
  });
});
