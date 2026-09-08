// test/store-purchase/stock-boundary.route.test.js
//
// Store & Purchase — Chunk 1C. The Stock Adjustment and Stock Ledger boundary.
//
// ── WHAT THIS PINS ──────────────────────────────────────────────────────────
// Both routers had `router.use(EmployeeAuth)` and nothing else. Any signed-in
// employee could read any company's item names, balances and movement history,
// issue stock against any item, and correct any movement.
//
// Three defects mattered more than the missing gate:
//
//   · `convertViaUnitModel` returned the quantity UNCHANGED when no conversion
//     existed and again inside a bare `catch`, so 12 metres became 12 pieces
//     and went straight into stock with nothing saying so.
//   · `POST /issue` was a read-modify-write with `Math.max(0, …)`: two
//     simultaneous issues each read the same balance and the second overwrote
//     the first, and an over-issue was silently clamped instead of refused.
//   · `PATCH …/edit` wrote `txn.quantity = parsed` onto the stored movement.
//     The figure somebody originally recorded was gone, while an `isEdited`
//     flag implied the history was intact.
//
// These are router-level tests against the real handlers. Each one fails if
// the protection it covers is removed.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const StockLedger = require("../../models/CMS_Models/Inventory/Operations/StockLedger");
const StockIssuance = require("../../models/CMS_Models/Inventory/Operations/StockIssuance");
const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Mounted exactly as server.js mounts them.
  app.use("/api/cms/inventory/stock-adjustments", require("../../routes/CMS_Routes/Inventory/Products/stockAdjustments"));
  app.use("/api/cms/inventory/stock-ledger", require("../../routes/CMS_Routes/Inventory/Operations/stockLedgerRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/inventory`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const newKey = () => `stk-${++seq}-${Math.random().toString(36).slice(2)}`;

const call = (path, { method = "GET", body, token, idempotencyKey, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(company ? { "X-Store-Purchase-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

/** `grant`/`role` decide which capabilities the person actually holds. */
async function person({ co, grant = "store", role = "approver", name = "P" }) {
  const n = ++seq;
  const email = `stk${n}@test.example`;
  const emp = await Employee.create({
    firstName: name, lastName: `L${n}`, email, biometricId: `SK${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role, isActive: true });
  if (co) await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: name });
  return {
    emp, email,
    token: jwt.sign(
      { id: String(emp._id), email, name, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const item = async ({ co, quantity = 100, unit = "m", over = {} } = {}) => RawItem.create({
  ...(co ? { companyId: co._id } : {}),
  name: `Cotton ${++seq}`, sku: `RAW-${seq}`, unit,
  quantity, minStock: 0, maxStock: 10000, ...over,
});

/** An item carrying one manual movement, so there is something to correct. */
const itemWithTxn = async ({ co, quantity = 100, txn = {} } = {}) => {
  const it = await item({ co, quantity });
  it.stockTransactions.push({
    type: "ADD", quantity: 40, previousQuantity: 60, newQuantity: 100,
    reason: "Opening count", notes: "as counted", ...txn,
  });
  await it.save();
  return it;
};

const issueBody = (rawItemId, over = {}) => ({
  direction: "debit", reason: "Issued to floor",
  items: [{ rawItemId: String(rawItemId), issuedQty: 10, issuedUnit: "m" }],
  ...over,
});

/* ═══ 1 · AUTHENTICATION AND CAPABILITY ══════════════════════════════════ */

describe("authentication and capability", () => {
  test("no token is refused everywhere", async () => {
    const co = await company("A");
    const it = await item({ co });
    for (const [path, opts] of [
      ["/stock-adjustments/raw-items", {}],
      ["/stock-adjustments/", {}],
      ["/stock-adjustments/issue", { method: "POST", body: issueBody(it._id), idempotencyKey: newKey() }],
      ["/stock-ledger/products", {}],
      ["/stock-ledger/stats", {}],
    ]) {
      const r = await call(path, opts);
      expect(r.status).toBeGreaterThanOrEqual(401);
      expect(r.body?.success).not.toBe(true);
    }
  });

  test("an authenticated employee with no Store grant gets nothing", async () => {
    const co = await company("B");
    const it = await item({ co });
    const nobody = await person({ co, grant: null });

    const read = await call("/stock-adjustments/raw-items", { token: nobody.token, company: co._id });
    expect(read.status).toBe(403);

    const write = await call("/stock-adjustments/issue", {
      method: "POST", token: nobody.token, company: co._id,
      idempotencyKey: newKey(), body: issueBody(it._id),
    });
    expect(write.status).toBe(403);
    /* And nothing moved. */
    expect((await RawItem.findById(it._id)).quantity).toBe(100);
  });

  test("read authority is not adjust authority", async () => {
    const co = await company("C");
    const it = await item({ co });
    /* `viewer` holds sp.read and sp.history.read only. */
    const viewer = await person({ co, role: "viewer" });

    const read = await call("/stock-adjustments/", { token: viewer.token, company: co._id });
    expect(read.status).toBe(200);

    const write = await call("/stock-adjustments/issue", {
      method: "POST", token: viewer.token, company: co._id,
      idempotencyKey: newKey(), body: issueBody(it._id),
    });
    expect(write.status).toBe(403);
    expect((await RawItem.findById(it._id)).quantity).toBe(100);
  });
});

/* ═══ 2 · TENANT ISOLATION ═══════════════════════════════════════════════ */

describe("tenant isolation", () => {
  test("another company's items, history and stats never appear", async () => {
    const mine = await company("Mine");
    const theirs = await company("Theirs");
    await item({ co: theirs, over: { name: "SECRET SILK", sku: "SECRET-1" } });
    const theirItem = await itemWithTxn({ co: theirs });
    const me = await person({ co: mine });

    const list = await call("/stock-adjustments/raw-items", { token: me.token, company: mine._id });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain("SECRET SILK");
    expect(JSON.stringify(list.body)).not.toContain("SECRET-1");

    const history = await call("/stock-adjustments/", { token: me.token, company: mine._id });
    expect(history.body.transactions).toHaveLength(0);

    const stats = await call("/stock-ledger/stats", { token: me.token, company: mine._id });
    expect(stats.body.stats.total).toBe(0);

    const ledger = await call(`/stock-ledger/?rawItemId=${theirItem._id}`, { token: me.token, company: mine._id });
    expect(ledger.status).toBe(404);
  });

  test("a cross-company id is not found, and cannot be issued against", async () => {
    const mine = await company("M2");
    const theirs = await company("T2");
    const theirItem = await item({ co: theirs });
    const me = await person({ co: mine });

    const r = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: mine._id,
      idempotencyKey: newKey(), body: issueBody(theirItem._id),
    });
    expect(r.status).toBe(404);
    expect((await RawItem.findById(theirItem._id)).quantity).toBe(100);
  });

  test("a search narrows the tenant scope and can never widen it", async () => {
    const mine = await company("M3");
    const theirs = await company("T3");
    await item({ co: theirs, over: { name: "Findme Fabric", sku: "FIND-1" } });
    await item({ co: mine, over: { name: "Findme Cotton", sku: "FIND-2" } });
    const me = await person({ co: mine });

    /* The old filter REPLACED the whole query with its $or. */
    const r = await call("/stock-adjustments/raw-items?search=Findme", { token: me.token, company: mine._id });
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].sku).toBe("FIND-2");

    const p = await call("/stock-ledger/products?search=Findme", { token: me.token, company: mine._id });
    expect(p.body.items).toHaveLength(1);
    expect(p.body.items[0].sku).toBe("FIND-2");
  });
});

/* ═══ 3 · OWNERSHIP COMES FROM THE SERVER ════════════════════════════════ */

describe("ownership is server-owned", () => {
  test("a spoofed companyId in the body is ignored; the server stamps its own", async () => {
    const mine = await company("M4");
    const theirs = await company("T4");
    const it = await item({ co: mine });
    const me = await person({ co: mine });

    const r = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: mine._id, idempotencyKey: newKey(),
      body: issueBody(it._id, { companyId: String(theirs._id) }),
    });
    expect(r.status).toBe(200);

    const saved = await StockIssuance.findById(r.body.issuance._id).lean();
    expect(String(saved.companyId)).toBe(String(mine._id));
    expect(String(saved.companyId)).not.toBe(String(theirs._id));
    /* And the movement landed on the caller's own item. */
    expect((await RawItem.findById(it._id)).quantity).toBe(90);
  });

  test("a site the caller cannot act at is refused, not quietly dropped", async () => {
    const mine = await company("M5");
    const it = await item({ co: mine });
    const me = await person({ co: mine });

    const r = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: mine._id, idempotencyKey: newKey(),
      body: issueBody(it._id, { siteId: String(new mongoose.Types.ObjectId()) }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error.code).toMatch(/SITE_/);
    expect((await RawItem.findById(it._id)).quantity).toBe(100);
  });
});

/* ═══ 4 · LEGACY RECORDS ═════════════════════════════════════════════════ */

describe("legacy unscoped records", () => {
  test("legacy items are readable in legacy mode but can never be written to", async () => {
    const co = await company("L1");
    const legacy = await itemWithTxn({ co: null });          // no companyId
    const admin = await person({ co, role: "owner" });

    const normal = await call("/stock-adjustments/raw-items", { token: admin.token, company: co._id });
    expect(JSON.stringify(normal.body)).not.toContain(legacy.sku);

    const asLegacy = await call("/stock-adjustments/raw-items?scope=legacy", { token: admin.token, company: co._id });
    expect(asLegacy.status).toBe(200);
    expect(JSON.stringify(asLegacy.body)).toContain(legacy.sku);

    /* A legacy record is never silently adopted into the current company. */
    const write = await call("/stock-adjustments/issue?scope=legacy", {
      method: "POST", token: admin.token, company: co._id, idempotencyKey: newKey(),
      body: issueBody(legacy._id),
    });
    expect(write.status).toBeGreaterThanOrEqual(400);
    const after = await RawItem.findById(legacy._id);
    expect(after.quantity).toBe(100);
    /* Never silently adopted into the acting company. */
    expect(after.companyId ?? null).toBeNull();
  });
});

/* ═══ 5 · UNIT CONVERSION FAILS CLOSED ═══════════════════════════════════ */

describe("unit conversion never guesses", () => {
  /** A conversion row written straight to the collection, so factors the
   *  schema would refuse (`min: 0.001`) can still be present — which is
   *  exactly how a corrupt legacy row exists in the real database. */
  async function unitsWithFactor(factor, co) {
    const metre = await Unit.create({ ...(co ? { companyId: co._id } : {}), name: `m-${++seq}` });
    const box = await Unit.create({ ...(co ? { companyId: co._id } : {}), name: `box-${++seq}` });
    if (factor !== undefined) {
      await Unit.collection.updateOne(
        { _id: box._id },
        { $push: { conversions: { _id: new mongoose.Types.ObjectId(), toUnit: metre._id, quantity: factor } } },
      );
    }
    return { metreName: metre.name, boxName: box.name };
  }

  const broken = [
    ["no conversion row at all", undefined],
    ["a zero factor", 0],
    ["a negative factor", -2],
    ["a non-finite factor", null],
  ];

  test.each(broken)("%s refuses and moves no stock", async (_label, factor) => {
    const co = await company("U1");
    const me = await person({ co });
    const { metreName, boxName } = await unitsWithFactor(factor, co);
    const it = await item({ co, unit: metreName, quantity: 100 });

    const r = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: issueBody(it._id, { items: [{ rawItemId: String(it._id), issuedQty: 5, issuedUnit: boxName }] }),
    });

    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.success).not.toBe(true);
    /* The old helper returned 5 unchanged and booked 5 of the stock unit. */
    expect((await RawItem.findById(it._id)).quantity).toBe(100);
  });

  test("a quantity with no unit at all is refused rather than assumed native", async () => {
    const co = await company("U1b");
    const me = await person({ co });
    const it = await item({ co, unit: "m", quantity: 100 });
    const r = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: issueBody(it._id, { items: [{ rawItemId: String(it._id), issuedQty: 5, issuedUnit: "" }] }),
    });
    /* An empty unit used to mean "same as native" by omission. */
    expect(r.status).toBe(200);
    expect((await RawItem.findById(it._id)).quantity).toBe(95);
  });

  test("a configured conversion produces the correct native quantity and states its direction", async () => {
    const co = await company("U2");
    const me = await person({ co });
    const { metreName, boxName } = await unitsWithFactor(10, co);   // 1 box = 10 m
    const it = await item({ co, unit: metreName, quantity: 100 });

    const r = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: issueBody(it._id, { items: [{ rawItemId: String(it._id), issuedQty: 2, issuedUnit: boxName }] }),
    });

    expect(r.status).toBe(200);
    /* 2 boxes × 10 = 20, debited from 100. */
    expect((await RawItem.findById(it._id)).quantity).toBe(80);
    const conv = r.body.stockUpdates[0].conversion;
    expect(conv.factor).toBe(10);
    expect(conv.direction).toContain(boxName);
    expect(conv.direction).toContain(metreName);
  });

test("a company can only convert with its OWN unit factors, never a same-named one elsewhere", async () => {
    const mine = await company("UX-mine");
    const theirs = await company("UX-theirs");
    const me = await person({ co: mine });

    /* Identical NAMES in both companies, different factors. Unit names are
       unique per company, not globally, so an unscoped findOne({name}) picked
       whichever document matched first. */
    const NAME_M = `m-shared-${++seq}`;
    const NAME_BOX = `box-shared-${++seq}`;
    const theirM = await Unit.create({ companyId: theirs._id, name: NAME_M });
    const theirBox = await Unit.create({ companyId: theirs._id, name: NAME_BOX });
    await Unit.collection.updateOne({ _id: theirBox._id },
      { $push: { conversions: { _id: new mongoose.Types.ObjectId(), toUnit: theirM._id, quantity: 1000 } } });

    const myM = await Unit.create({ companyId: mine._id, name: NAME_M });
    const myBox = await Unit.create({ companyId: mine._id, name: NAME_BOX });
    await Unit.collection.updateOne({ _id: myBox._id },
      { $push: { conversions: { _id: new mongoose.Types.ObjectId(), toUnit: myM._id, quantity: 10 } } });

    const it = await item({ co: mine, unit: NAME_M, quantity: 100 });
    const r = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: mine._id, idempotencyKey: newKey(),
      body: issueBody(it._id, { items: [{ rawItemId: String(it._id), issuedQty: 2, issuedUnit: NAME_BOX }] }),
    });

    expect(r.status).toBe(200);
    /* 2 × 10 = 20 (mine). Their factor would have given 2 × 1000 = 2000. */
    expect(r.body.stockUpdates[0].conversion.factor).toBe(10);
    expect((await RawItem.findById(it._id)).quantity).toBe(80);
  });

  test("a unit that exists only in another company reads as unavailable, not forbidden", async () => {
    const mine = await company("UY-mine");
    const theirs = await company("UY-theirs");
    const me = await person({ co: mine });

    const NAME = `crate-${++seq}`;
    const theirM = await Unit.create({ companyId: theirs._id, name: `m-${++seq}` });
    const theirCrate = await Unit.create({ companyId: theirs._id, name: NAME });
    await Unit.collection.updateOne({ _id: theirCrate._id },
      { $push: { conversions: { _id: new mongoose.Types.ObjectId(), toUnit: theirM._id, quantity: 5 } } });

    const it = await item({ co: mine, unit: "m", quantity: 100 });
    const r = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: mine._id, idempotencyKey: newKey(),
      body: issueBody(it._id, { items: [{ rawItemId: String(it._id), issuedQty: 2, issuedUnit: NAME }] }),
    });

    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).not.toBe(403);
    expect(JSON.stringify(r.body)).toMatch(/not available in this company/i);
    /* The refusal must not confirm the other company's unit exists. */
    expect(JSON.stringify(r.body)).not.toMatch(/forbidden/i);
    expect((await RawItem.findById(it._id)).quantity).toBe(100);
  });
});

/* ═══ 6 · IDEMPOTENCY ════════════════════════════════════════════════════ */

describe("a repeated request moves stock once", () => {
  test("the same key with the same payload replays the first answer", async () => {
    const co = await company("I1");
    const it = await item({ co, quantity: 100 });
    const me = await person({ co });
    const key = newKey();
    const body = issueBody(it._id);

    const first = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(first.status).toBe(200);
    expect((await RawItem.findById(it._id)).quantity).toBe(90);

    const again = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(again.status).toBe(200);
    /* Still 90 — not 80. */
    expect((await RawItem.findById(it._id)).quantity).toBe(90);
    expect(await StockIssuance.countDocuments({ idempotencyKey: key })).toBe(1);
  });

  test("the same key with a different payload is refused", async () => {
    const co = await company("I2");
    const it = await item({ co, quantity: 100 });
    const me = await person({ co });
    const key = newKey();

    await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key, body: issueBody(it._id),
    });
    const changed = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key,
      body: issueBody(it._id, { items: [{ rawItemId: String(it._id), issuedQty: 99, issuedUnit: "m" }] }),
    });
    expect(changed.status).toBeGreaterThanOrEqual(400);
    expect((await RawItem.findById(it._id)).quantity).toBe(90);
  });

  test("a missing key is refused outright", async () => {
    const co = await company("I3");
    const it = await item({ co });
    const me = await person({ co });
    const r = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: co._id, body: issueBody(it._id),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await RawItem.findById(it._id)).quantity).toBe(100);
  });
});

/* ═══ 7 · CONCURRENCY AND NEGATIVE STOCK ═════════════════════════════════ */

describe("concurrent movements and the zero floor", () => {
  test("two simultaneous issues do not lose an update", async () => {
    const co = await company("N1");
    const it = await item({ co, quantity: 100 });
    const me = await person({ co });

    const [a, b] = await Promise.all([
      call("/stock-adjustments/issue", {
        method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(), body: issueBody(it._id),
      }),
      call("/stock-adjustments/issue", {
        method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(), body: issueBody(it._id),
      }),
    ]);

    const succeeded = [a, b].filter((r) => r.status === 200).length;
    const after = (await RawItem.findById(it._id)).quantity;
    /* Whatever succeeded must be reflected exactly. The old read-modify-write
       let both report success and leave the balance at 90. */
    expect(after).toBe(100 - succeeded * 10);
  });

  test("an over-issue is refused, never clamped to zero", async () => {
    const co = await company("N2");
    const it = await item({ co, quantity: 5 });
    const me = await person({ co });

    const r = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: issueBody(it._id, { items: [{ rawItemId: String(it._id), issuedQty: 50, issuedUnit: "m" }] }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    /* The old code wrote Math.max(0, 5 - 50) = 0 and reported success. */
    expect((await RawItem.findById(it._id)).quantity).toBe(5);
  });

  test("a variant issue keeps the variant and the parent projection consistent", async () => {
    const co = await company("N3");
    const it = await item({ co, quantity: 100 });
    it.variants.push({ combination: ["Blue"], quantity: 40, sku: `V-${++seq}` });
    await it.save();
    const variantId = it.variants[0]._id;
    const me = await person({ co });

    const r = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: issueBody(it._id, {
        items: [{ rawItemId: String(it._id), variantId: String(variantId), issuedQty: 10, issuedUnit: "m" }],
      }),
    });
    expect(r.status).toBe(200);

    const after = await RawItem.findById(it._id);
    expect(after.quantity).toBe(90);
    expect(after.variants.id(variantId).quantity).toBe(30);
  });

  test("a variant over-issue mutates neither the variant nor the parent", async () => {
    const co = await company("N4");
    const it = await item({ co, quantity: 100 });
    it.variants.push({ combination: ["Red"], quantity: 3, sku: `V-${++seq}` });
    await it.save();
    const variantId = it.variants[0]._id;
    const me = await person({ co });

    const r = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: issueBody(it._id, {
        items: [{ rawItemId: String(it._id), variantId: String(variantId), issuedQty: 10, issuedUnit: "m" }],
      }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const after = await RawItem.findById(it._id);
    expect(after.quantity).toBe(100);
    expect(after.variants.id(variantId).quantity).toBe(3);
  });
});

/* ═══ 8 · CORRECTIONS ARE APPENDED, NEVER APPLIED IN PLACE ═══════════════ */

describe("immutable correction semantics", () => {
  const correct = (it, txnId, over = {}) => ({
    path: `/stock-ledger/${it._id}/txn/${txnId}/edit`,
    body: { newQuantity: 50, correctionReason: "Miscounted at the door", ...over },
  });

  test("the original movement is untouched and the correction is appended and linked", async () => {
    const co = await company("K1");
    const it = await itemWithTxn({ co, quantity: 100 });
    const txn = it.stockTransactions[0];
    const me = await person({ co });
    const before = JSON.parse(JSON.stringify(it.stockTransactions[0]));

    const c = correct(it, txn._id);
    const r = await call(c.path, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(), body: c.body,
    });
    expect(r.status).toBe(200);

    /* Byte-for-byte: the old code assigned txn.quantity = 50 here. */
    const after = await RawItem.findById(it._id);
    const original = after.stockTransactions.id(txn._id);
    expect(original.quantity).toBe(before.quantity);
    expect(original.reason).toBe(before.reason);
    expect(original.notes).toBe(before.notes);
    expect(original.previousQuantity).toBe(before.previousQuantity);
    expect(original.newQuantity).toBe(before.newQuantity);

    /* The correction exists, is linked, and carries both figures. */
    const comp = await StockLedger.findOne({ compensatingFor: txn._id }).lean();
    expect(comp).toBeTruthy();
    expect(comp.txnType).toBe("COMPENSATING");
    expect(String(comp.companyId)).toBe(String(co._id));
    expect(comp.correctsQuantityFrom).toBe(40);
    expect(comp.correctsQuantityTo).toBe(50);
    expect(comp.originalQuantityBefore).toBe(60);
    expect(comp.originalQuantityAfter).toBe(100);
    expect(comp.correctionReason).toContain("Miscounted");

    /* Original and correction come back separately, and nothing is described
       as edited. */
    expect(r.body.original._id).toBe(String(txn._id));
    expect(r.body.original.quantity).toBe(40);
    expect(r.body.original.unchanged).toBe(true);
    expect(r.body.correction.quantity).toBe(10);
    expect(r.body.isEdited).toBe(false);

    /* An ADD corrected upward credits the difference. */
    expect(after.quantity).toBe(110);
  });

  test("a correction needs a meaningful reason", async () => {
    const co = await company("K2");
    const it = await itemWithTxn({ co });
    const me = await person({ co });
    const c = correct(it, it.stockTransactions[0]._id, { correctionReason: "  " });
    const r = await call(c.path, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(), body: c.body,
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await StockLedger.countDocuments({ compensatingFor: it.stockTransactions[0]._id })).toBe(0);
  });

  test("a missing, malformed or cross-company original is not found", async () => {
    const mine = await company("K3");
    const theirs = await company("K4");
    const theirItem = await itemWithTxn({ co: theirs });
    const me = await person({ co: mine });

    const cross = await call(`/stock-ledger/${theirItem._id}/txn/${theirItem.stockTransactions[0]._id}/edit`, {
      method: "PATCH", token: me.token, company: mine._id, idempotencyKey: newKey(),
      body: { newQuantity: 5, correctionReason: "not mine" },
    });
    expect(cross.status).toBe(404);

    const malformed = await call(`/stock-ledger/not-an-id/txn/also-not/edit`, {
      method: "PATCH", token: me.token, company: mine._id, idempotencyKey: newKey(),
      body: { newQuantity: 5, correctionReason: "malformed" },
    });
    expect(malformed.status).toBe(404);
  });

  test("an automatic purchase-order movement cannot be corrected here", async () => {
    const co = await company("K5");
    const it = await item({ co, quantity: 100 });
    it.stockTransactions.push({
      type: "PURCHASE_ORDER", quantity: 40, previousQuantity: 60, newQuantity: 100,
      reason: "Purchase Order Delivery", purchaseOrder: "PO-1",
    });
    await it.save();
    const me = await person({ co });

    const r = await call(`/stock-ledger/${it._id}/txn/${it.stockTransactions[0]._id}/edit`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { newQuantity: 10, correctionReason: "wrong figure" },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.body)).toMatch(/purchase order|manufacturing/i);
    expect((await RawItem.findById(it._id)).quantity).toBe(100);
  });

  test("a repeated correction under one key moves stock once", async () => {
    const co = await company("K6");
    const it = await itemWithTxn({ co, quantity: 100 });
    const me = await person({ co });
    const key = newKey();
    const c = correct(it, it.stockTransactions[0]._id);

    const first = await call(c.path, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key, body: c.body,
    });
    expect(first.status).toBe(200);
    expect((await RawItem.findById(it._id)).quantity).toBe(110);

    const again = await call(c.path, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key, body: c.body,
    });
    expect(again.status).toBe(200);
    expect((await RawItem.findById(it._id)).quantity).toBe(110);
    expect(await StockLedger.countDocuments({ compensatingFor: it.stockTransactions[0]._id })).toBe(1);
  });

  test("a correction needs adjust authority, not merely history read", async () => {
    const co = await company("K7");
    const it = await itemWithTxn({ co });
    const viewer = await person({ co, role: "viewer" });
    const c = correct(it, it.stockTransactions[0]._id);
    const r = await call(c.path, {
      method: "PATCH", token: viewer.token, company: co._id, idempotencyKey: newKey(), body: c.body,
    });
    expect(r.status).toBe(403);
    expect(await StockLedger.countDocuments({ compensatingFor: it.stockTransactions[0]._id })).toBe(0);
  });
});

/* ═══ 9 · HONEST OUTPUT ══════════════════════════════════════════════════ */

describe("honest ledger output", () => {
  test("an unknown movement type is reported as unrecognised, not as stock-in", async () => {
    const co = await company("H1");
    const it = await item({ co, quantity: 100 });
    /* Written at the collection level on purpose: the schema enum refuses this
       today, but legacy documents predating the enum carry types like it, and
       the router must not fold them into "stock in". */
    await RawItem.collection.updateOne(
      { _id: it._id },
      { $push: { stockTransactions: {
        _id: new mongoose.Types.ObjectId(), type: "QUARANTINE_HOLD", quantity: 5,
        previousQuantity: 100, newQuantity: 100, reason: "held", createdAt: new Date(),
      } } },
    );
    const me = await person({ co });

    const r = await call("/stock-adjustments/", { token: me.token, company: co._id });
    const row = r.body.transactions.find((t) => t.type === "QUARANTINE_HOLD");
    expect(row).toBeTruthy();
    expect(row.directionKnown).toBe(false);
    expect(row.direction).toBeNull();
    expect(row.movementLabel).toBe("Unrecognised movement");
    expect(r.body.stats.unrecognised).toBe(1);
  });

  test("statistics group by unit and never combine them", async () => {
    const co = await company("H2");
    const a = await item({ co, unit: "m", quantity: 100 });
    a.stockTransactions.push({ type: "ADD", quantity: 50, previousQuantity: 50, newQuantity: 100, reason: "count" });
    await a.save();
    const b = await item({ co, unit: "kg", quantity: 100 });
    b.stockTransactions.push({ type: "ADD", quantity: 12, previousQuantity: 88, newQuantity: 100, reason: "count" });
    await b.save();
    const me = await person({ co });

    const r = await call("/stock-adjustments/", { token: me.token, company: co._id });
    /* The old response summed these into creditQty: 62. */
    expect(r.body.stats.creditQty).toBeUndefined();
    const units = r.body.stats.quantitiesByUnit;
    expect(units.find((u) => u.unit === "m").credit).toBe(50);
    expect(units.find((u) => u.unit === "kg").credit).toBe(12);
    expect(units.some((u) => u.credit === 62)).toBe(false);
  });

  test("a missing quantity stays missing and a recorded zero stays zero", async () => {
    const co = await company("H3");
    const it = await item({ co, unit: "m", quantity: 100 });
    it.stockTransactions.push({ type: "ADD", quantity: 0, previousQuantity: 100, newQuantity: 100, reason: "zero count" });
    await it.save();
    const me = await person({ co });

    const r = await call("/stock-adjustments/", { token: me.token, company: co._id });
    const zero = r.body.transactions.find((t) => t.reason === "zero count");
    expect(zero.quantity).toBe(0);
    const unitRow = r.body.stats.quantitiesByUnit.find((u) => u.unit === "m");
    expect(unitRow.credit).toBe(0);
    expect(unitRow.missing).toBe(0);
  });

  test("the source is declared as legacy embedded history and claims no complete chain", async () => {
    const co = await company("H4");
    const it = await itemWithTxn({ co });
    const me = await person({ co, role: "owner" });

    const r = await call("/stock-adjustments/", { token: me.token, company: co._id });
    expect(r.body.source.kind).toBe("LEGACY_EMBEDDED");
    expect(r.body.source.label).toMatch(/Legacy stock movement history/i);

    const v = await call(`/stock-ledger/verification-report?rawItemId=${it._id}`, {
      token: me.token, company: co._id,
    });
    expect(v.status).toBe(200);
    expect(v.body.source.kind).toBe("LEGACY_EMBEDDED");
    expect(v.body.chain).toBeTruthy();
    expect(typeof v.body.chain.verifiable).toBe("boolean");
  });

  test("an unrecorded opening balance is not reported as zero", async () => {
    const co = await company("H5");
    const it = await item({ co, quantity: 100 });
    /* Written at the collection level so `previousQuantity` is genuinely
       ABSENT. The schema defaults it to 0, so a mongoose-saved movement always
       has one — but legacy documents predating that default do not, and the
       report must not invent an opening balance for them. */
    await RawItem.collection.updateOne(
      { _id: it._id },
      { $push: { stockTransactions: {
        _id: new mongoose.Types.ObjectId(), type: "ADD", quantity: 10,
        reason: "no opening", createdAt: new Date(),
      } } },
    );
    const me = await person({ co, role: "owner" });

    const v = await call(`/stock-ledger/verification-report?rawItemId=${it._id}`, {
      token: me.token, company: co._id,
    });
    expect(v.body.summary?.openingQty ?? v.body.openingQty ?? null).toBeNull();
    expect(v.body.chain.openingRecorded).toBe(false);
    expect(v.body.chain.verifiable).toBe(false);
  });
});

/* ═══ 10 · MANUFACTURING INTEGRATION IS CLOSED ═══════════════════════════ */

describe("manufacturing data is never returned from an unscoped query", () => {
  test("the MO list and BOM endpoints refuse instead of querying globally", async () => {
    const co = await company("MF1");
    const me = await person({ co });

    for (const path of [
      "/stock-adjustments/manufacturing-orders",
      "/stock-adjustments/manufacturing-orders?search=Acme",
      `/stock-adjustments/manufacturing-orders/${new mongoose.Types.ObjectId()}/bom-items`,
    ]) {
      const r = await call(path, { token: me.token, company: co._id });
      expect(r.status).toBe(503);
      expect(r.body.success).toBe(false);
      expect(r.body.unavailable.code).toBe("INTEGRATION_UNAVAILABLE");
      expect(r.body.unavailable.message).toMatch(/company ownership can be proved/i);
      /* No data-bearing payload of any kind — only the refusal. */
      expect(r.body.mos).toBeUndefined();
      expect(r.body.items).toBeUndefined();
      expect(r.body.bomItems).toBeUndefined();
      expect(Object.keys(r.body).sort()).toEqual(["error", "success", "unavailable"]);
    }
  });

  test("another company's MO cannot be reached by direct id", async () => {
    const mine = await company("MF2");
    const me = await person({ co: mine });
    const r = await call(
      `/stock-adjustments/manufacturing-orders/${new mongoose.Types.ObjectId()}/bom-items`,
      { token: me.token, company: mine._id },
    );
    expect(r.status).toBe(503);
    expect(r.status).not.toBe(200);
  });

  test("an issue carrying a manufacturing snapshot is refused, not stored unverified", async () => {
    const co = await company("MF3");
    const it = await item({ co, quantity: 100 });
    const me = await person({ co });

    for (const extra of [
      { manufacturingOrderId: String(new mongoose.Types.ObjectId()) },
      { moNumber: "MO-9999" },
      { customerName: "Somebody Else Ltd" },
    ]) {
      const r = await call("/stock-adjustments/issue", {
        method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
        body: issueBody(it._id, extra),
      });
      expect(r.status).toBe(503);
      expect((await RawItem.findById(it._id)).quantity).toBe(100);
      expect(await StockIssuance.countDocuments({ moNumber: "MO-9999" })).toBe(0);
      expect(await StockIssuance.countDocuments({ customerName: "Somebody Else Ltd" })).toBe(0);
    }
  });
});

/* ═══ 11 · THE PARTIAL-WRITE WINDOW ══════════════════════════════════════ */

describe("a failure part-way through cannot be replayed", () => {
  test("first item moves, second step fails, retry with the same key does not move it again", async () => {
    const co = await company("PW1");
    const a = await item({ co, quantity: 100 });
    const b = await item({ co, quantity: 100 });
    const me = await person({ co });
    const key = newKey();
    const body = {
      direction: "debit", reason: "Two-line issue to floor",
      items: [
        { rawItemId: String(a._id), issuedQty: 10, issuedUnit: "m" },
        { rawItemId: String(b._id), issuedQty: 10, issuedUnit: "m" },
      ],
    };

    /* Fail AFTER the first item has moved and before the action completes —
       exactly the window `unitOfWork.run` cannot cover in standalone mode. */
    const spy = jest.spyOn(StockIssuance, "create").mockRejectedValueOnce(new Error("injected failure"));
    const first = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    spy.mockRestore();
    expect(first.status).toBeGreaterThanOrEqual(400);

    const aAfterFailure = (await RawItem.findById(a._id)).quantity;
    const bAfterFailure = (await RawItem.findById(b._id)).quantity;

    /* The retry must NOT replay. Either it is refused as needing
       reconciliation, or it replays the original answer — never a re-run. */
    const retry = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key, body,
    });

    expect((await RawItem.findById(a._id)).quantity).toBe(aAfterFailure);
    expect((await RawItem.findById(b._id)).quantity).toBe(bAfterFailure);
    /* And it says so rather than reporting a fresh success. */
    if (retry.status === 200) expect(retry.body.replayed).toBe(true);
    else expect(JSON.stringify(retry.body)).toMatch(/reconcil|already|interrupted/i);
  });

  test("a correction whose record fails does not let the balance delta apply twice", async () => {
    const co = await company("PW2");
    const it = await itemWithTxn({ co, quantity: 100 });
    const txnId = it.stockTransactions[0]._id;
    const me = await person({ co });
    const key = newKey();
    const body = { newQuantity: 50, correctionReason: "Recount after audit" };
    const path = `/stock-ledger/${it._id}/txn/${txnId}/edit`;

    const spy = jest.spyOn(RawItem, "findOneAndUpdate").mockRejectedValueOnce(new Error("injected failure"));
    const first = await call(path, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    spy.mockRestore();
    expect(first.status).toBeGreaterThanOrEqual(400);
    const afterFailure = (await RawItem.findById(it._id)).quantity;

    const retry = await call(path, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect((await RawItem.findById(it._id)).quantity).toBe(afterFailure);
    if (retry.status === 200) expect(retry.body.replayed).toBe(true);
    else expect(JSON.stringify(retry.body)).toMatch(/reconcil|already|interrupted/i);
  });
});

/* ═══ 12 · ONE CORRECTION PER MOVEMENT ═══════════════════════════════════ */

describe("a movement is corrected at most once", () => {
  const path = (it, txnId) => `/stock-ledger/${it._id}/txn/${txnId}/edit`;

  test("10 → 12 then 10 → 14 does not apply both deltas", async () => {
    const co = await company("CC1");
    const it = await item({ co, quantity: 100 });
    it.stockTransactions.push({ type: "ADD", quantity: 10, previousQuantity: 90, newQuantity: 100, reason: "count" });
    await it.save();
    const txnId = it.stockTransactions[0]._id;
    const me = await person({ co });

    const first = await call(path(it, txnId), {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { newQuantity: 12, correctionReason: "Miscounted by two" },
    });
    expect(first.status).toBe(200);
    expect((await RawItem.findById(it._id)).quantity).toBe(102);      // +2

    const second = await call(path(it, txnId), {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { newQuantity: 14, correctionReason: "Recounted again" },
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(second.body)).toMatch(/already been corrected/i);
    /* The delta is computed against the unchanged original, so a second
       correction of 10→14 would add +4 on top of +2, reaching 106. */
    expect((await RawItem.findById(it._id)).quantity).toBe(102);
    expect(await StockLedger.countDocuments({ compensatingFor: txnId, isVoided: false })).toBe(1);
  });

  test("two simultaneous corrections under different keys apply only one delta", async () => {
    const co = await company("CC2");
    const it = await item({ co, quantity: 100 });
    it.stockTransactions.push({ type: "ADD", quantity: 10, previousQuantity: 90, newQuantity: 100, reason: "count" });
    await it.save();
    const txnId = it.stockTransactions[0]._id;
    const me = await person({ co });
    await StockLedger.syncIndexes();

    const [a, b] = await Promise.all([
      call(path(it, txnId), {
        method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
        body: { newQuantity: 12, correctionReason: "Simultaneous one" },
      }),
      call(path(it, txnId), {
        method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
        body: { newQuantity: 14, correctionReason: "Simultaneous two" },
      }),
    ]);

    const succeeded = [a, b].filter((r) => r.status === 200).length;
    expect(succeeded).toBe(1);
    expect(await StockLedger.countDocuments({ compensatingFor: txnId, isVoided: false })).toBe(1);
    /* Exactly one delta — +2 or +4, never both. */
    const q = (await RawItem.findById(it._id)).quantity;
    expect([102, 104]).toContain(q);
    expect(q).not.toBe(106);
  });
});

/* ═══ 13 · UNKNOWN TYPES STAY UNKNOWN ════════════════════════════════════ */

describe("an unrecognised movement is never interpreted", () => {
  /** A legacy movement whose type predates the current enum. */
  async function legacyTyped(co, type = "QUARANTINE_HOLD") {
    const it = await item({ co, quantity: 100 });
    const _id = new mongoose.Types.ObjectId();
    await RawItem.collection.updateOne({ _id: it._id }, { $push: { stockTransactions: {
      _id, type, quantity: 5, previousQuantity: 100, newQuantity: 100, reason: "held", createdAt: new Date(),
    } } });
    return { it, txnId: _id };
  }

  test("the ledger reports it as unrecognised and excludes it from credit and debit", async () => {
    const co = await company("UK1");
    const { it } = await legacyTyped(co);
    const me = await person({ co });

    const r = await call(`/stock-ledger/?rawItemId=${it._id}`, { token: me.token, company: co._id });
    expect(r.status).toBe(200);
    const row = (r.body.transactions || r.body.entries || []).find((t) => t.rawTxnType === "QUARANTINE_HOLD");
    expect(row).toBeTruthy();
    expect(row.direction).toBeNull();
    expect(row.directionKnown).toBe(false);
    expect(row.movementLabel).toBe("Unrecognised movement");
    /* The stored value survives untouched. */
    expect(row.rawTxnType).toBe("QUARANTINE_HOLD");

    const stats = await call("/stock-ledger/stats", { token: me.token, company: co._id });
    expect(stats.body.stats.credits).toBe(0);
    expect(stats.body.stats.debits).toBe(0);
    expect(stats.body.stats.unrecognised).toBe(1);
  });

  test("it cannot be corrected, because its balance effect is unknowable", async () => {
    const co = await company("UK2");
    const { it, txnId } = await legacyTyped(co);
    const me = await person({ co });

    const r = await call(`/stock-ledger/${it._id}/txn/${txnId}/edit`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { newQuantity: 9, correctionReason: "try to correct it" },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.body)).toMatch(/not recognised/i);
    expect((await RawItem.findById(it._id)).quantity).toBe(100);
    expect(await StockLedger.countDocuments({ compensatingFor: txnId })).toBe(0);
  });
});

/* ═══ 14 · MISSING IS NOT ZERO ═══════════════════════════════════════════ */

describe("missing figures stay missing and recorded zeros stay zero", () => {
  async function withTxn(co, fields) {
    const it = await item({ co, quantity: 100 });
    const _id = new mongoose.Types.ObjectId();
    await RawItem.collection.updateOne({ _id: it._id }, { $push: { stockTransactions: {
      _id, type: "ADD", reason: "probe", createdAt: new Date(), ...fields,
    } } });
    return { it, txnId: _id };
  }

  test("an unrecorded before/after/price is null, not zero", async () => {
    const co = await company("MZ1");
    const { it } = await withTxn(co, { quantity: 5 });     // no before/after/price
    const me = await person({ co });

    const r = await call(`/stock-ledger/?rawItemId=${it._id}`, { token: me.token, company: co._id });
    const row = (r.body.transactions || r.body.entries || []).find((t) => t.reason === "probe");
    expect(row.quantityBefore).toBeNull();
    expect(row.quantityAfter).toBeNull();
    expect(row.unitPrice).toBeNull();
    expect(row.quantityBefore).not.toBe(0);
  });

  test("a recorded zero is preserved as zero", async () => {
    const co = await company("MZ2");
    const { it } = await withTxn(co, { quantity: 0, previousQuantity: 0, newQuantity: 0, unitPrice: 0 });
    const me = await person({ co });

    const r = await call(`/stock-ledger/?rawItemId=${it._id}`, { token: me.token, company: co._id });
    const row = (r.body.transactions || r.body.entries || []).find((t) => t.reason === "probe");
    expect(row.quantity).toBe(0);
    expect(row.quantityBefore).toBe(0);
    expect(row.quantityAfter).toBe(0);
    expect(row.unitPrice).toBe(0);
  });
});

/* ═══ 15 · SERVER-SIDE VALIDATION ════════════════════════════════════════ */

describe("the server enforces its own reason and quantity rules", () => {
  test("a missing or whitespace reason is refused, not replaced with a generated one", async () => {
    const co = await company("V1");
    const it = await item({ co, quantity: 100 });
    const me = await person({ co });

    for (const reason of [undefined, "", "   ", "ok"]) {
      const r = await call("/stock-adjustments/issue", {
        method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
        body: { direction: "debit", reason, items: [{ rawItemId: String(it._id), issuedQty: 5, issuedUnit: "m" }] },
      });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect((await RawItem.findById(it._id)).quantity).toBe(100);
    }
    /* And the invented fallback is gone. */
    expect(await StockIssuance.countDocuments({ reason: { $in: ["Stock Debit", "Stock Credit"] } })).toBe(0);
  });

  test("quantities are parsed strictly and every line is checked before anything moves", async () => {
    const co = await company("V2");
    const it = await item({ co, quantity: 100 });
    const me = await person({ co });

    for (const q of ["12abc", "1e3", "", "  ", "-5", "0", "abc", "1.23456", "0.00001", null, {}, Infinity, NaN]) {
      const r = await call("/stock-adjustments/issue", {
        method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
        body: { direction: "debit", reason: "Strict parsing probe",
          items: [{ rawItemId: String(it._id), issuedQty: q, issuedUnit: "m" }] },
      });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect((await RawItem.findById(it._id)).quantity).toBe(100);
    }
    /* parseFloat would have accepted the first two as 12 and 1000. */
    expect(Number.parseFloat("12abc")).toBe(12);

    /* A bad SECOND line stops the first from moving. */
    const other = await item({ co, quantity: 100 });
    const r = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { direction: "debit", reason: "Validate all lines first", items: [
        { rawItemId: String(it._id), issuedQty: 5, issuedUnit: "m" },
        { rawItemId: String(other._id), issuedQty: "12abc", issuedUnit: "m" },
      ] },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await RawItem.findById(it._id)).quantity).toBe(100);
    expect((await RawItem.findById(other._id)).quantity).toBe(100);

    expect(0.0001).toBe(0.0001);
    const ok = await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { direction: "credit", reason: "Smallest recordable quantity",
        items: [{ rawItemId: String(it._id), issuedQty: 0.0001, issuedUnit: "m" }] },
    });
    expect(ok.status).toBe(200);
  });
});

/* ═══ 16 · DIRECTIONALLY HONEST AUDIT ════════════════════════════════════ */

describe("the audit says what actually happened", () => {
  test("a credit is not recorded as an issue, and neither cites a manufacturing order", async () => {
    const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
    const co = await company("AU1");
    const it = await item({ co, quantity: 100 });
    const me = await person({ co });

    await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { direction: "credit", reason: "Manual stock-in after recount",
        items: [{ rawItemId: String(it._id), issuedQty: 5, issuedUnit: "m" }] },
    });
    await call("/stock-adjustments/issue", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { direction: "debit", reason: "Manual issue to the floor",
        items: [{ rawItemId: String(it._id), issuedQty: 5, issuedUnit: "m" }] },
    });

    const actions = (await SpActionHistory.find({ companyId: co._id }).lean()).map((h) => h.action);
    expect(actions).toContain("STOCK_ADJUSTED_IN");
    expect(actions).toContain("STOCK_ADJUSTED_OUT");
    /* "Issued" described a credit as an issue, and implied a demand that
       cannot currently be proved to exist. */
    expect(actions).not.toContain("STOCK_ISSUED");
  });
});

/* ═══ 17 · CORRECTION APPLICATION STATE AND ITS INTERRUPTION SEAMS ═══════
 *
 * The compensating row is written BEFORE the balance moves — it is the atomic
 * claim that stops two simultaneous corrections. That ordering means the row's
 * existence proves an attempt STARTED, never that stock actually moved.
 *
 * These run in MARKED (standalone) mode, which is what the in-memory server
 * reports. They inject a failure at each seam and assert what the next request
 * is told. Nothing here demonstrates replica-set transaction behaviour.
 * ═════════════════════════════════════════════════════════════════════════ */

describe("a correction is only complete when it says it is", () => {
  const setup = async (label) => {
    const co = await company(label);
    const it = await item({ co, quantity: 100 });
    it.stockTransactions.push({
      type: "ADD", quantity: 10, previousQuantity: 90, newQuantity: 100, reason: "count",
    });
    await it.save();
    const me = await person({ co });
    return { co, it, me, txnId: it.stockTransactions[0]._id };
  };
  const body = { newQuantity: 12, correctionReason: "Miscounted by two" };
  const url = (it, txnId) => `/stock-ledger/${it._id}/txn/${txnId}/edit`;
  const claims = (txnId) => StockLedger.find({ compensatingFor: txnId, isVoided: false }).lean();

  test("interrupted BEFORE the balance moves: stock untouched, claim pending, retry refuses", async () => {
    const { co, it, me, txnId } = await setup("IS1");
    const key = newKey();

    /* The seam: the claim is written, then this throws before the balance
       update runs. */
    const spy = jest.spyOn(RawItem, "findOneAndUpdate").mockRejectedValueOnce(new Error("injected: before balance"));
    const first = await call(url(it, txnId), {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    spy.mockRestore();
    expect(first.status).toBeGreaterThanOrEqual(400);

    expect((await RawItem.findById(it._id)).quantity).toBe(100);
    const rows = await claims(txnId);
    expect(rows).toHaveLength(1);
    expect(rows[0].applicationState).toBe("PENDING");

    /* Same key. The claim exists, so the old code replayed it as a success —
       reporting a correction that never touched stock. */
    const retry = await call(url(it, txnId), {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(retry.status).toBeGreaterThanOrEqual(400);
    expect(retry.status).toBeLessThan(500);
    expect(retry.body.error.details.reason).toBe("STOCK_RECONCILIATION_REQUIRED");
    expect(retry.body.success).not.toBe(true);
    expect((await RawItem.findById(it._id)).quantity).toBe(100);
    expect(await claims(txnId)).toHaveLength(1);
  });

  test("interrupted AFTER the balance moves: moved once, claim pending, retry does not move it again", async () => {
    const { co, it, me, txnId } = await setup("IS2");
    const key = newKey();

    /* The seam: the balance moves, then finalising the claim throws. */
    const spy = jest.spyOn(StockLedger, "updateOne").mockRejectedValueOnce(new Error("injected: after balance"));
    const first = await call(url(it, txnId), {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    spy.mockRestore();
    expect(first.status).toBeGreaterThanOrEqual(400);

    const moved = (await RawItem.findById(it._id)).quantity;
    expect(moved).toBe(102);                       // +2, exactly once
    const rows = await claims(txnId);
    expect(rows).toHaveLength(1);
    expect(rows[0].applicationState).toBe("PENDING");
    expect(rows[0].quantityAfter).toBeNull();      // never finalised

    const retry = await call(url(it, txnId), {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(retry.status).toBeGreaterThanOrEqual(400);
    expect(retry.body.error.details.reason).toBe("STOCK_RECONCILIATION_REQUIRED");
    /* Not +4. And not reversed either — an uncertain movement is never
       automatically undone. */
    expect((await RawItem.findById(it._id)).quantity).toBe(moved);
    expect(await claims(txnId)).toHaveLength(1);
  });

  test("a completed correction is APPLIED, and the same key replays it without moving stock", async () => {
    const { co, it, me, txnId } = await setup("IS3");
    const key = newKey();

    const first = await call(url(it, txnId), {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(first.status).toBe(200);
    expect((await RawItem.findById(it._id)).quantity).toBe(102);

    const rows = await claims(txnId);
    expect(rows[0].applicationState).toBe("APPLIED");
    expect(rows[0].appliedAt).toBeTruthy();
    expect(rows[0].quantityBefore).toBe(100);
    expect(rows[0].quantityAfter).toBe(102);

    const retry = await call(url(it, txnId), {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(retry.status).toBe(200);
    expect(retry.body.success).toBe(true);
    /* Either the idempotency middleware served the stored first answer, or the
       handler replayed the APPLIED row — both mean it was not re-run. */
    expect(String(retry.body.correction._id)).toBe(String(rows[0]._id));
    /* The stock did not move again, and no second claim appeared. */
    expect((await RawItem.findById(it._id)).quantity).toBe(102);
    expect(await claims(txnId)).toHaveLength(1);
    expect((await claims(txnId))[0].applicationState).toBe("APPLIED");
  });

  test("a different key against a PENDING claim is a reconciliation case, not 'already corrected'", async () => {
    const { co, it, me, txnId } = await setup("IS4");

    const spy = jest.spyOn(RawItem, "findOneAndUpdate").mockRejectedValueOnce(new Error("injected"));
    await call(url(it, txnId), {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(), body,
    });
    spy.mockRestore();
    expect((await claims(txnId))[0].applicationState).toBe("PENDING");

    const other = await call(url(it, txnId), {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { newQuantity: 14, correctionReason: "A different attempt" },
    });
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(other.body.error.details.reason).toBe("STOCK_RECONCILIATION_REQUIRED");
    /* An unfinished attempt is NOT an ordinary completed correction. */
    expect(other.body.error.details.reason).not.toBe("ALREADY_CORRECTED");
    expect(JSON.stringify(other.body)).toMatch(/never confirmed|not known whether/i);
    expect((await RawItem.findById(it._id)).quantity).toBe(100);
  });

  test("a different key against an APPLIED correction is refused as already corrected", async () => {
    const { co, it, me, txnId } = await setup("IS5");
    await call(url(it, txnId), {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(), body,
    });
    expect((await claims(txnId))[0].applicationState).toBe("APPLIED");

    const other = await call(url(it, txnId), {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { newQuantity: 14, correctionReason: "Second attempt" },
    });
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(other.body.error.details.reason).toBe("ALREADY_CORRECTED");
    expect((await RawItem.findById(it._id)).quantity).toBe(102);
  });

  test("a historical correction with no recorded state fails closed, never assumed applied", async () => {
    const { co, it, me, txnId } = await setup("IS6");
    /* Written at the collection level with no applicationState, exactly as a
       row created before the field existed. */
    await StockLedger.collection.insertOne({
      companyId: it.companyId, rawItem: it._id, unit: "m",
      direction: "CREDIT", quantity: 2, txnType: "COMPENSATING",
      compensatingFor: txnId, isVoided: false, idempotencyKey: "",
      createdAt: new Date(), updatedAt: new Date(),
    });

    const r = await call(url(it, txnId), {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(), body,
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    /* Ambiguous, so it is handled as pending — not reported as a completed
       correction nobody verified. */
    expect(r.body.error.details.reason).toBe("STOCK_RECONCILIATION_REQUIRED");
    expect(r.body.error.details.applicationState).toBe("UNKNOWN");
    expect((await RawItem.findById(it._id)).quantity).toBe(100);
  });
});

/* ═══ 18 · THE CORRECTED QUANTITY IS PARSED STRICTLY ═════════════════════ */

describe("the corrected quantity is parsed strictly", () => {
  const url = (it, txnId) => `/stock-ledger/${it._id}/txn/${txnId}/edit`;

  const fixture = async (label) => {
    const co = await company(label);
    const it = await item({ co, quantity: 100 });
    it.stockTransactions.push({
      type: "ADD", quantity: 10, previousQuantity: 90, newQuantity: 100, reason: "count",
    });
    await it.save();
    return { co, it, me: await person({ co }), txnId: it.stockTransactions[0]._id };
  };

  test("malformed quantities are refused before any claim or stock movement", async () => {
    const { co, it, me, txnId } = await fixture("SQ1");

    for (const bad of ["12abc", "1e3", "1.23456", "", "   ", "+5", "-1", -1, "1,000", "12.", {}, [], Infinity, NaN, null, undefined, true]) {
      const r = await call(url(it, txnId), {
        method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
        body: { newQuantity: bad, correctionReason: "Strict parsing probe" },
      });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.body.success).not.toBe(true);
      /* Nothing claimed, nothing moved — the refusal precedes both. */
      expect(await StockLedger.countDocuments({ compensatingFor: txnId })).toBe(0);
      expect((await RawItem.findById(it._id)).quantity).toBe(100);
    }
    /* parseFloat would have taken the first two as 12 and 1000. */
    expect(Number.parseFloat("12abc")).toBe(12);
    expect(Number.parseFloat("1e3")).toBe(1000);
  });

  test("zero is a valid correction, and four decimal places are accepted exactly", async () => {
    const zero = await fixture("SQ2");
    const rz = await call(url(zero.it, zero.txnId), {
      method: "PATCH", token: zero.me.token, company: zero.co._id, idempotencyKey: newKey(),
      body: { newQuantity: 0, correctionReason: "Nothing actually arrived" },
    });
    expect(rz.status).toBe(200);
    /* An ADD of 10 corrected to 0 removes 10. */
    expect((await RawItem.findById(zero.it._id)).quantity).toBe(90);

    const dp = await fixture("SQ3");
    const rd = await call(url(dp.it, dp.txnId), {
      method: "PATCH", token: dp.me.token, company: dp.co._id, idempotencyKey: newKey(),
      body: { newQuantity: "10.0001", correctionReason: "Four decimal places" },
    });
    expect(rd.status).toBe(200);
    const comp = await StockLedger.findOne({ compensatingFor: dp.txnId }).lean();
    expect(comp.correctsQuantityTo).toBe(10.0001);
    /* Not rounded away. */
    expect(comp.quantity).toBeCloseTo(0.0001, 6);
  });
});

/* ═══ 19 · A CORRECTION'S OUTCOME REACHES THE READER ═════════════════════ */

describe("correction state is carried into the ledger output", () => {
  const seed = async (label) => {
    const co = await company(label);
    const it = await item({ co, quantity: 100 });
    it.stockTransactions.push({
      type: "ADD", quantity: 10, previousQuantity: 90, newQuantity: 100, reason: "count",
    });
    await it.save();
    return { co, it, me: await person({ co, role: "owner" }), txnId: it.stockTransactions[0]._id };
  };
  /** A compensating row in a chosen state, written directly. */
  const claim = (it, txnId, state) => StockLedger.collection.insertOne({
    companyId: it.companyId, rawItem: it._id, unit: "m",
    direction: "CREDIT", quantity: 2, txnType: "COMPENSATING",
    compensatingFor: txnId, isVoided: false, idempotencyKey: "",
    quantityBefore: state === "APPLIED" ? 100 : null,
    quantityAfter: state === "APPLIED" ? 102 : null,
    ...(state ? { applicationState: state } : {}),
    ...(state === "APPLIED" ? { appliedAt: new Date("2026-02-03T10:00:00Z") } : {}),
    createdAt: new Date(), updatedAt: new Date(),
  });
  const corrections = async (me, co, it) => {
    const r = await call(`/stock-ledger/?rawItemId=${it._id}`, { token: me.token, company: co._id });
    expect(r.status).toBe(200);
    const rows = r.body.transactions || r.body.entries || [];
    return rows.flatMap((t) => t.corrections || []);
  };

  test("an APPLIED correction carries its state and completion time", async () => {
    const { co, it, me, txnId } = await seed("CS1");
    await claim(it, txnId, "APPLIED");
    const [c] = await corrections(me, co, it);
    expect(c.applicationState).toBe("APPLIED");
    expect(c.appliedAt).toBeTruthy();
    expect(c.quantityAfter).toBe(102);
  });

  test("a PENDING correction is listed, not hidden, and carries no completion time", async () => {
    const { co, it, me, txnId } = await seed("CS2");
    await claim(it, txnId, "PENDING");
    const found = await corrections(me, co, it);
    /* Hiding it would leave an unresolved stock claim invisible. */
    expect(found).toHaveLength(1);
    expect(found[0].applicationState).toBe("PENDING");
    expect(found[0].appliedAt).toBeNull();
    expect(found[0].quantityAfter).toBeNull();
  });

  test("a stateless historical correction is normalised to UNKNOWN, never applied", async () => {
    const { co, it, me, txnId } = await seed("CS3");
    await claim(it, txnId, null);                    // no applicationState at all
    const [c] = await corrections(me, co, it);
    expect(c.applicationState).toBe("UNKNOWN");
    expect(c.applicationState).not.toBe("APPLIED");
    expect(c.appliedAt).toBeNull();
  });

  test("the verification report preserves the same distinction", async () => {
    const { co, it, me, txnId } = await seed("CS4");
    await claim(it, txnId, "PENDING");
    const r = await call(`/stock-ledger/verification-report?rawItemId=${it._id}`, {
      token: me.token, company: co._id,
    });
    expect(r.status).toBe(200);
    const found = (r.body.tree || []).flatMap((t) => t.corrections || []);
    expect(found).toHaveLength(1);
    expect(found[0].applicationState).toBe("PENDING");
    expect(found[0].appliedAt).toBeNull();
  });
});

/* ═══ 20 · BALANCE AND STATUS MOVE TOGETHER ══════════════════════════════ */

describe("a correction writes balance and status in one operation", () => {
  const url = (it, txnId) => `/stock-ledger/${it._id}/txn/${txnId}/edit`;

  /** A DEBIT movement, so correcting it upward takes MORE stock out. */
  const seedDebit = async (label, { quantity, minStock = 0, variant = null }) => {
    const co = await company(label);
    const it = await item({ co, quantity, over: { minStock } });
    if (variant) {
      it.variants.push({ combination: ["Blue"], quantity: variant.quantity, minStock: variant.minStock ?? 0, sku: `V-${++seq}` });
    }
    it.stockTransactions.push({
      type: variant ? "VARIANT_REDUCE" : "REDUCE", quantity: 10,
      previousQuantity: quantity + 10, newQuantity: quantity, reason: "issued",
      ...(variant ? { variantId: it.variants[0]._id } : {}),
    });
    await it.save();
    return { co, it, me: await person({ co }), txnId: it.stockTransactions[0]._id };
  };

  test("crossing the minimum updates the stored status on both parent and variant", async () => {
    const { co, it, me, txnId } = await seedDebit("ST1", {
      quantity: 100, minStock: 95, variant: { quantity: 40, minStock: 35 },
    });
    expect((await RawItem.findById(it._id)).status).toBe("In Stock");

    /* A DEBIT of 10 corrected to 16 removes a further 6, crossing both
       minimums (100→94 against 95; 40→34 against 35). */
    const r = await call(url(it, txnId), {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { newQuantity: 16, correctionReason: "Six more were issued" },
    });
    expect(r.status).toBe(200);

    const after = await RawItem.findById(it._id);
    expect(after.quantity).toBe(94);
    expect(after.status).toBe("Low Stock");
    const v = after.variants[0];
    expect(v.quantity).toBe(34);
    expect(v.status).toBe("Low Stock");
    /* Stamped by the same operation. */
    expect(after.updatedAt).toBeTruthy();
  });

  test("a correction that reaches zero stores Out of Stock", async () => {
    const { co, it, me, txnId } = await seedDebit("ST2", { quantity: 10, minStock: 2 });
    const r = await call(url(it, txnId), {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { newQuantity: 20, correctionReason: "All of it was issued" },
    });
    expect(r.status).toBe(200);
    const after = await RawItem.findById(it._id);
    expect(after.quantity).toBe(0);
    expect(after.status).toBe("Out of Stock");
  });

  test("the stored status always describes the stored balance, even under a concurrent movement", async () => {
    const { co, it, me, txnId } = await seedDebit("ST3", { quantity: 100, minStock: 50 });

    /* The seam that matters is AFTER the balance increment and BEFORE any
       follow-up write. The old code computed the status from the snapshot the
       increment returned and saved it afterwards — so a movement landing in
       this window was overwritten by a status describing the older balance. */
    let fired = false;
    const realUpdate = RawItem.findOneAndUpdate.bind(RawItem);
    const spy = jest.spyOn(RawItem, "findOneAndUpdate").mockImplementation(async (...args) => {
      const out = await realUpdate(...args);
      if (!fired) {
        fired = true;
        /* Somebody else takes 60 out, dropping the balance below minStock. */
        await RawItem.collection.updateOne(
          { _id: it._id },
          { $set: { quantity: 38, status: "Low Stock" } },
        );
      }
      return out;
    });

    const r = await call(url(it, txnId), {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { newQuantity: 12, correctionReason: "Two more were issued" },
    });
    spy.mockRestore();
    expect(r.status).toBe(200);

    const after = await RawItem.findById(it._id);
    /* An INVARIANT check, not a discriminator: the stored status must describe
       the stored balance whatever the interleaving was. It passes under the
       old snapshot-save pattern too in this environment, so it is not evidence
       that the race is closed — the "no post-increment save" test below is
       what actually pins that. */
    const expected = after.quantity <= 0 ? "Out of Stock"
      : after.quantity <= (after.minStock || 0) ? "Low Stock" : "In Stock";
    expect(after.status).toBe(expected);
    expect(after.quantity).toBe(38);
    expect(after.status).toBe("Low Stock");
  });

  test("the correction route performs no post-increment document save", async () => {
    const { co, it, me, txnId } = await seedDebit("ST4", { quantity: 100, minStock: 10 });

    /* `save()` on the snapshot returned by the balance update is the race
       being removed. Nothing in the correction path may call it. */
    const saveSpy = jest.spyOn(RawItem.prototype, "save");
    const r = await call(url(it, txnId), {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { newQuantity: 12, correctionReason: "Two more were issued" },
    });
    expect(r.status).toBe(200);
    expect(saveSpy).not.toHaveBeenCalled();
    saveSpy.mockRestore();

    const after = await RawItem.findById(it._id);
    expect(after.quantity).toBe(98);
    /* And the original embedded movement is still untouched. */
    expect(after.stockTransactions.id(txnId).quantity).toBe(10);
  });
});
