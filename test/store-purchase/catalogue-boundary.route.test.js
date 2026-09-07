// test/store-purchase/catalogue-boundary.route.test.js
//
// Store & Purchase — Chunk 1B. The catalogue and unit boundary.
//
// ── WHAT CHUNK 0 MEASURED, AND WHAT THIS PINS ───────────────────────────────
// `rawItems.js` had authentication and nothing else: any signed-in employee
// could read and rewrite any company's catalogue. Three of its write paths
// moved stock without saying so —
//
//   S7  the ordinary "edit item" PUT set the balance and every variant balance
//       straight from the request body, writing no stock transaction;
//   S12 item creation took opening balances with no opening transaction;
//   S11 DELETE destroyed the item together with its embedded movement history,
//       with no guard against open orders or requests referencing it.
//
// `units.js` had capabilities from Chunk 1A but no tenant scoping at all, and
// silently DROPPED any conversion row whose factor was zero, blank or
// unparseable — leaving a saved unit whose conversion table was quietly
// missing a line.
//
// None of that is the Item Master redesign. It is what has to be true before
// the legacy catalogue can be migrated at all.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Mounted exactly as server.js mounts them.
  app.use("/api/cms/raw-items", require("../../routes/CMS_Routes/Inventory/Products/rawItems"));
  app.use("/api/cms/units", require("../../routes/CMS_Routes/Inventory/Configurations/units"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const newKey = () => `cat-${++seq}-${Math.random().toString(36).slice(2)}`;

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
  }).then(async (r) => ({
    status: r.status,
    body: JSON.parse((await r.text()) || "null"),
  }));

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

/**
 * `grant` is the Store department role. `null` is an authenticated employee
 * with no Store & Purchase grant at all — the case the old router served
 * everything to.
 */
async function person({ co, grant = null, role = "approver", name = "P" }) {
  const n = ++seq;
  const email = `cat${n}@test.example`;
  const emp = await Employee.create({
    firstName: name, lastName: `L${n}`, email, biometricId: `CT${n}`,
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

/** An item, owned by a company unless `co` is null (a legacy-global record). */
const item = async ({ co, sku, quantity = 0, over = {} } = {}) => RawItem.create({
  ...(co ? { companyId: co._id } : {}),
  name: `Cotton ${++seq}`, sku: sku || `RAW-CTN-${seq}`, unit: "m",
  quantity, minStock: 0, maxStock: 100, ...over,
});

const unit = async ({ co, name, over = {} } = {}) => Unit.create({
  ...(co ? { companyId: co._id } : {}),
  name: name || `roll-${++seq}`, ...over,
});

/* ═══ 1 · AUTHENTICATION AND CAPABILITY ══════════════════════════════════ */

describe("authentication and capability", () => {
  test("an unauthenticated caller reads and writes nothing", async () => {
    for (const [method, path] of [
      ["GET", "/raw-items"], ["POST", "/raw-items"], ["GET", "/units"], ["POST", "/units"],
    ]) {
      const res = await call(path, { method, body: method === "GET" ? undefined : {} });
      expect([401, 403]).toContain(res.status);
    }
  });

  test("an authenticated employee with no Store grant is refused", async () => {
    const a = await company("Acme");
    const nobody = await person({ co: a });          // member, no grant
    const it = await item({ co: a });

    for (const [method, path] of [
      ["GET", "/raw-items"], ["GET", `/raw-items/${it._id}`], ["GET", "/units"],
    ]) {
      const res = await call(path, { method, token: nobody.token });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    }
    /* Authentication alone grants nothing — the old router's entire contract. */
    expect((await call("/raw-items", {
      method: "POST", token: nobody.token, body: { name: "X", category: "Fabric", unit: "m", minStock: 0, maxStock: 1 },
    })).status).toBe(403);
  });

  test("a viewer reads the catalogue but maintains nothing", async () => {
    const a = await company("Acme");
    const viewer = await person({ co: a, grant: "store", role: "viewer" });
    const it = await item({ co: a });

    expect((await call("/raw-items", { token: viewer.token })).status).toBe(200);
    expect((await call(`/raw-items/${it._id}`, { token: viewer.token })).status).toBe(200);
    expect((await call("/units", { token: viewer.token })).status).toBe(200);

    const blocked = await call("/raw-items", {
      method: "POST", token: viewer.token,
      body: { name: "New", category: "Fabric", unit: "m", minStock: 0, maxStock: 1 },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.details.required).toContain("sp.master.maintain");
    expect((await call(`/raw-items/${it._id}`, {
      method: "DELETE", token: viewer.token,
    })).status).toBe(403);
  });

  test("supplier aliases need procurement authority, not catalogue authority", async () => {
    /* An alias is what a supplier calls the item and what they charge for it —
       a fact about a commercial relationship. Granting it through the
       catalogue permission would let anyone who may rename an item also
       rewrite its supplier pricing. */
    const { CAPABILITIES: C, GRANTS } = require("../../services/storePurchase/capabilities");
    expect(GRANTS.store.editor).toContain(C.MASTER_MAINTAIN);
    expect(GRANTS.store.editor).toContain(C.SOURCING_MANAGE);

    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "routes", "CMS_Routes", "Inventory", "Products", "rawItems.js"),
      "utf8",
    );
    /* The four alias write routes carry the sourcing gate, not the catalogue one. */
    for (const route of [
      'router.post("/:id/variants/bulk-vendor-nicknames", ...canSource',
      'router.post("/:id/variants/:variantId/vendor-nicknames", ...canSource',
      'router.put("/:id/variants/:variantId/vendor-nicknames/:nicknameId", ...canSource',
      'router.delete("/:id/variants/:variantId/vendor-nicknames/:nicknameId", ...canSource',
    ]) {
      expect(src).toContain(route);
    }
    expect(src).toContain("const canSource = [requireCapability(CAPABILITIES.SOURCING_MANAGE)");
  });

  test("redefining a conversion needs configuration authority, not master maintenance", async () => {
    /* Adding "metre" to the vocabulary is master maintenance. Saying a roll is
       40 metres rather than 25 retroactively revalues every quantity ever
       stored in rolls, across every document that referenced it — that is
       configuration, and the grant table gives it to owners only. */
    const { CAPABILITIES: C, GRANTS } = require("../../services/storePurchase/capabilities");
    expect(GRANTS.store.editor).toContain(C.MASTER_MAINTAIN);
    expect(GRANTS.store.editor).not.toContain(C.CONFIG_MANAGE);
    expect(GRANTS.store.owner).toContain(C.CONFIG_MANAGE);

    const a = await company("Acme");
    const editor = await person({ co: a, grant: "store", role: "editor" });
    const owner = await person({ co: a, grant: "store", role: "owner" });
    const metre = await unit({ co: a, name: "metre" });
    const roll = await unit({ co: a, name: "roll" });

    /* The editor may retire a unit… */
    expect((await call(`/units/${roll._id}`, {
      method: "PUT", token: editor.token, body: { status: "Inactive" },
    })).status).toBe(200);

    /* …and may not redefine what it is worth. */
    const denied = await call(`/units/${roll._id}`, {
      method: "PUT", token: editor.token,
      body: { conversions: [{ toUnit: String(metre._id), quantity: 40 }] },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.required).toContain("sp.config.manage");

    const allowed = await call(`/units/${roll._id}`, {
      method: "PUT", token: owner.token,
      body: { conversions: [{ toUnit: String(metre._id), quantity: 40 }] },
    });
    expect(allowed.status).toBe(200);
  });
});

/* ═══ 2 · TENANT ISOLATION ═══════════════════════════════════════════════ */

describe("tenant isolation", () => {
  test("company A cannot list, read, update or delete company B's items", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store", role: "owner" });
    const itB = await item({ co: b, sku: "RAW-B-0001" });

    const list = await call("/raw-items", { token: storeA.token });
    expect(list.status).toBe(200);
    expect(list.body.rawItems.map((i) => i.sku)).not.toContain("RAW-B-0001");

    /* Another company's id is answered exactly as an invented one is. */
    const foreign = await call(`/raw-items/${itB._id}`, { token: storeA.token });
    const missing = await call(`/raw-items/${new mongoose.Types.ObjectId()}`, { token: storeA.token });
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain("RAW-B-0001");

    expect((await call(`/raw-items/${itB._id}`, {
      method: "PUT", token: storeA.token, body: { name: "Renamed" },
    })).status).toBe(404);
    expect((await call(`/raw-items/${itB._id}`, {
      method: "DELETE", token: storeA.token,
    })).status).toBe(404);

    const stored = await RawItem.findById(itB._id).lean();
    expect(stored.name).not.toBe("Renamed");         // untouched
  });

  test("statistics and counts are company-scoped", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store" });
    await item({ co: b });
    await item({ co: b });

    const list = await call("/raw-items", { token: storeA.token });
    expect(list.body.rawItems).toHaveLength(0);
    /* Whatever aggregate the list carries, it counts A's catalogue only. */
    if (list.body.stats) {
      expect(list.body.stats.total ?? 0).toBe(0);
    }
    expect(list.body.pagination?.total ?? 0).toBe(0);
  });

  test("company A cannot read or mutate company B's units", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store", role: "owner" });
    const unitB = await unit({ co: b, name: "bolt" });

    const list = await call("/units", { token: storeA.token });
    expect(list.body.units.map((u) => u.name)).not.toContain("bolt");
    expect((await call(`/units/${unitB._id}`, { token: storeA.token })).status).toBe(404);
    expect((await call(`/units/${unitB._id}`, {
      method: "PUT", token: storeA.token, body: { status: "Inactive" },
    })).status).toBe(404);
    expect((await call(`/units/${unitB._id}`, {
      method: "DELETE", token: storeA.token,
    })).status).toBe(404);
  });

  test("a search cannot escape the company scope", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store" });
    await item({ co: b, over: { name: "Findme Cotton" } });
    await item({ co: a, over: { name: "Mine Cotton" } });

    const res = await call("/raw-items?search=Cotton", { token: storeA.token });
    expect(res.status).toBe(200);
    expect(res.body.rawItems.map((i) => i.name)).toEqual(["Mine Cotton"]);

    /* A search AND a category must both apply — the category clause used to
       overwrite the search clause outright. */
    const both = await call("/raw-items?search=Mine&category=Fabric", { token: storeA.token });
    expect(both.status).toBe(200);
    for (const row of both.body.rawItems) {
      const owner = await RawItem.findById(row._id).select("companyId").lean();
      expect(String(owner.companyId)).toBe(String(a._id));
    }
  });

  test("a search metacharacter is a character, not a pattern", async () => {
    const a = await company("Acme");
    const storeA = await person({ co: a, grant: "store" });
    await item({ co: a, over: { name: "Cotton (A1)" } });

    expect((await call(`/raw-items?search=${encodeURIComponent("(A1)")}`, { token: storeA.token }))
      .body.rawItems.map((i) => i.name)).toEqual(["Cotton (A1)"]);
    /* Unescaped, `.*` matched the whole catalogue. */
    expect((await call(`/raw-items?search=${encodeURIComponent(".*")}`, { token: storeA.token }))
      .body.rawItems).toHaveLength(0);
  });
});

/* ═══ 3 · SERVER-OWNED OWNERSHIP ═════════════════════════════════════════ */

describe("ownership comes from the server", () => {
  test("a new item takes the resolved company, whatever the body says", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store" });

    const res = await call("/raw-items", {
      method: "POST", token: storeA.token,
      body: {
        name: "Spoofed", category: "Fabric", unit: "m", minStock: 0, maxStock: 10,
        companyId: String(b._id),                  // spoof attempt
      },
    });
    expect(res.status).toBe(201);
    const stored = await RawItem.findById(res.body.rawItem._id).lean();
    expect(String(stored.companyId)).toBe(String(a._id));
  });

  test("a new unit takes the resolved company, whatever the body says", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store" });

    const res = await call("/units", {
      method: "POST", token: storeA.token,
      body: { name: "metre", companyId: String(b._id) },
    });
    expect(res.status).toBe(201);
    const stored = await Unit.findById(res.body.unit._id).lean();
    expect(String(stored.companyId)).toBe(String(a._id));
  });

  test("two companies may hold the same item code and the same unit name", async () => {
    /* The whole point of retiring the global unique indexes. */
    const a = await company("Acme");
    const b = await company("Borealis");
    await item({ co: a, sku: "RAW-SHARED-1" });
    await expect(item({ co: b, sku: "RAW-SHARED-1" })).resolves.toBeTruthy();

    await unit({ co: a, name: "roll" });
    await expect(unit({ co: b, name: "roll" })).resolves.toBeTruthy();

    /* Within one company the code is still the item's identity. */
    await expect(item({ co: a, sku: "RAW-SHARED-1" })).rejects.toThrow();
    await expect(unit({ co: a, name: "roll" })).rejects.toThrow();
  });

  test("a code collision inside one company is refused before the index sees it", async () => {
    /* The item code is generated by the server, so a caller cannot submit a
       duplicate — but two items with the same name and category generate the
       same code. Left to the unique index that is a 500 to whoever is filling
       in the form; the route has to recognise it first. The random suffix is
       pinned so the collision is certain rather than one-in-a-thousand. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const rand = jest.spyOn(Math, "random").mockReturnValue(0.424242);
    try {
      const body = { name: "Cotton Twill", category: "Fabric", unit: "m", minStock: 0, maxStock: 10 };
      const first = await call("/raw-items", { method: "POST", token: store.token, body });
      expect(first.status).toBe(201);

      const again = await call("/raw-items", { method: "POST", token: store.token, body });
      expect(again.status).toBe(400);
      expect(again.body.message).toMatch(/SKU already exists/i);
      expect(await RawItem.countDocuments({ companyId: a._id })).toBe(1);

      /* The same collision in another company is not a collision at all. */
      const b = await company("Borealis");
      const other = await person({ co: b, grant: "store" });
      const elsewhere = await call("/raw-items", { method: "POST", token: other.token, body });
      expect(elsewhere.status).toBe(201);
      expect(elsewhere.body.rawItem.sku).toBe(first.body.rawItem.sku);
    } finally {
      rand.mockRestore();
    }
  });

  test("a duplicate unit name in one company is refused through the route", async () => {
    const a = await company("Acme");
    const boss = await person({ co: a, grant: "store", role: "owner" });

    const first = await call("/units", { method: "POST", token: boss.token, body: { name: "Bolt" } });
    expect(first.status).toBe(201);

    const again = await call("/units", { method: "POST", token: boss.token, body: { name: "Bolt" } });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.status).toBeLessThan(500);
    expect(await Unit.countDocuments({ companyId: a._id, name: /^bolt$/i })).toBe(1);
  });
});

/* ═══ 4 · LEGACY-GLOBAL RECORDS ══════════════════════════════════════════ */

describe("legacy-global catalogue records", () => {
  test("a legacy item is excluded from an ordinary company list", async () => {
    const a = await company("Acme");
    const storeA = await person({ co: a, grant: "store", role: "approver" });
    const legacy = await item({ co: null, sku: "RAW-LEGACY-1" });

    const list = await call("/raw-items", { token: storeA.token });
    expect(list.body.rawItems.map((i) => i.sku)).not.toContain("RAW-LEGACY-1");
    expect((await call(`/raw-items/${legacy._id}`, { token: storeA.token })).status).toBe(404);
  });

  test("legacy reading needs BOTH the capability and the explicit mode", async () => {
    const a = await company("Acme");
    const legacy = await item({ co: null, sku: "RAW-LEGACY-2" });
    const editor = await person({ co: a, grant: "store", role: "editor" });    // no legacy.read
    const approver = await person({ co: a, grant: "store", role: "approver" }); // has it

    expect((await call("/raw-items?scope=legacy", { token: editor.token })).status).toBe(403);

    const allowed = await call("/raw-items?scope=legacy", { token: approver.token });
    expect(allowed.status).toBe(200);
    expect(allowed.body.rawItems.map((i) => i.sku)).toContain("RAW-LEGACY-2");
  });

  test("a legacy record never becomes writable, and is never adopted", async () => {
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const legacy = await item({ co: null, sku: "RAW-LEGACY-3" });

    const write = await call(`/raw-items/${legacy._id}?scope=legacy`, {
      method: "PUT", token: approver.token, body: { name: "Adopted" },
    });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe("LEGACY_ACCESS_REQUIRED");

    const stored = await RawItem.findById(legacy._id).lean();
    expect(stored.name).not.toBe("Adopted");
    expect(stored.companyId == null).toBe(true);      // never silently assigned
  });
});

/* ═══ 5 · CATALOGUE EDITS DO NOT MOVE STOCK ══════════════════════════════ */

describe("editing an item never moves stock", () => {
  test("a quantity on the edit form is refused, not ignored", async () => {
    /* S7: this used to set the balance straight from the body and write no
       stock transaction. Ignoring the field instead would leave the operator
       believing the shelf had changed. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const it = await item({ co: a, quantity: 40 });

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: store.token, body: { name: "Renamed", quantity: 999 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("QUANTITY_NOT_EDITABLE_HERE");
    expect(res.body.error.details.fields).toContain("quantity");

    const stored = await RawItem.findById(it._id).lean();
    expect(stored.quantity).toBe(40);                // untouched
    expect(stored.name).not.toBe("Renamed");         // the whole edit refused
  });

  test("a variant quantity on the edit form is refused too", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const it = await item({
      co: a, quantity: 10,
      over: { variants: [{ combination: ["Red"], sku: "V-1", quantity: 10 }] },
    });

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: store.token,
      body: { variants: [{ combination: ["Red"], sku: "V-1", quantity: 500 }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields).toContain("variants[].quantity");
    expect(res.body.error.details.variantRows).toEqual([1]);

    const stored = await RawItem.findById(it._id).lean();
    expect(stored.variants[0].quantity).toBe(10);
  });

  test("an ordinary edit with no quantity still works", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const it = await item({ co: a, quantity: 40 });

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: store.token, body: { name: "Renamed", notes: "Fixed a typo" },
    });
    expect(res.status).toBe(200);
    const stored = await RawItem.findById(it._id).lean();
    expect(stored.name).toBe("Renamed");
    expect(stored.quantity).toBe(40);                // the balance is untouched
  });

  test("an item is created empty, and an opening balance is refused", async () => {
    /* S12: opening balances used to be saved with no opening transaction. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });

    const refused = await call("/raw-items", {
      method: "POST", token: store.token,
      body: {
        name: "Opening", category: "Fabric", unit: "m", minStock: 0, maxStock: 10,
        variants: [{ combination: ["Red"], quantity: 25 }],
      },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details.reason).toBe("OPENING_QUANTITY_NOT_ACCEPTED");
    expect(await RawItem.countDocuments({ companyId: a._id })).toBe(0);

    const created = await call("/raw-items", {
      method: "POST", token: store.token,
      body: { name: "Empty", category: "Fabric", unit: "m", minStock: 0, maxStock: 10 },
    });
    expect(created.status).toBe(201);
    const stored = await RawItem.findById(created.body.rawItem._id).lean();
    expect(stored.quantity).toBe(0);
  });

  test("the stock routes need stock authority and an idempotency key", async () => {
    const a = await company("Acme");
    /* An editor may maintain the catalogue and may NOT adjust stock. */
    const editor = await person({ co: a, grant: "store", role: "editor" });
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const it = await item({
      co: a, quantity: 10,
      over: { variants: [{ combination: ["Red"], sku: "V-1", quantity: 10 }] },
    });
    const variantId = String((await RawItem.findById(it._id).lean()).variants[0]._id);
    const path = `/raw-items/${it._id}/variants/${variantId}/add-stock`;

    const denied = await call(path, {
      method: "POST", token: editor.token, idempotencyKey: newKey(), body: { quantity: 5 },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.required).toContain("sp.stock.adjust");

    const noKey = await call(path, { method: "POST", token: approver.token, body: { quantity: 5 } });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  test("the same stock movement sent twice moves the stock once", async () => {
    /* A retry after a timeout is the ordinary case, not the exotic one: the
       browser has no way to know whether the first request landed. */
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const it = await item({
      co: a, quantity: 10,
      over: { variants: [{ combination: ["Red"], sku: "V-1", quantity: 10 }] },
    });
    const variantId = String((await RawItem.findById(it._id).lean()).variants[0]._id);
    const path = `/raw-items/${it._id}/variants/${variantId}/add-stock`;
    const key = newKey();

    const first = await call(path, {
      method: "POST", token: approver.token, idempotencyKey: key,
      body: { quantity: 5, supplier: "Mill Co", unitPrice: 10, invoiceNumber: "INV-1",
              reason: "Received against invoice INV-1" },
    });
    expect(first.status).toBeLessThan(400);

    const retry = await call(path, {
      method: "POST", token: approver.token, idempotencyKey: key,
      body: { quantity: 5, supplier: "Mill Co", unitPrice: 10, invoiceNumber: "INV-1",
              reason: "Received against invoice INV-1" },
    });
    expect(retry.status).toBeLessThan(400);

    const stored = await RawItem.findById(it._id).lean();
    expect(stored.variants[0].quantity).toBe(15);        // not 20
    expect(stored.quantity).toBe(15);
    /* And one movement recorded, not two — the history has to agree with the
       balance or neither can be trusted. */
    const added = (stored.stockTransactions || [])
      .filter((t) => String(t.type).includes("ADD"));
    expect(added).toHaveLength(1);
  });

  test("a supplier or note beginning with $ is stored as typed", async () => {
    /* The movement is written by an aggregation pipeline, where a leading "$"
       means "the value of this field". A supplier named "$name" must be
       recorded as "$name", not as the item's name. */
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const it = await item({
      co: a, quantity: 0,
      over: { variants: [{ combination: ["Red"], sku: "V-1", quantity: 0 }] },
    });
    const variantId = String((await RawItem.findById(it._id).lean()).variants[0]._id);

    const res = await call(`/raw-items/${it._id}/variants/${variantId}/add-stock`, {
      method: "POST", token: approver.token, idempotencyKey: newKey(),
      body: { quantity: 5, supplier: "$name", unitPrice: 10, reason: "Received short",
             notes: "$500 short on the last load" },
    });
    expect(res.status).toBeLessThan(400);

    const tx = (await RawItem.findById(it._id).lean()).stockTransactions[0];
    expect(tx.supplier).toBe("$name");
    expect(tx.notes).toBe("$500 short on the last load");
  });

  test("simultaneous movements under distinct keys all land", async () => {
    /* Four separate additions are four separate facts, and each has its own
       key. Read-modify-`save()` made them read the same balance and overwrite
       one another, so three of the four vanished with nothing to show it. */
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const it = await item({
      co: a, quantity: 0,
      over: { variants: [{ combination: ["Red"], sku: "V-1", quantity: 0 }] },
    });
    const variantId = String((await RawItem.findById(it._id).lean()).variants[0]._id);
    const path = `/raw-items/${it._id}/variants/${variantId}/add-stock`;

    const results = await Promise.all([1, 2, 3, 4].map(() => call(path, {
      method: "POST", token: approver.token, idempotencyKey: newKey(),
      body: { quantity: 5, supplier: "Mill Co", unitPrice: 10, reason: "Received" },
    })));
    results.forEach((r) => expect(r.status).toBeLessThan(400));

    const stored = await RawItem.findById(it._id).lean();
    expect(stored.variants[0].quantity).toBe(20);      // 4 × 5, none lost
    expect(stored.quantity).toBe(20);
    expect((stored.stockTransactions || []).filter((t) => t.type === "VARIANT_ADD")).toHaveLength(4);

    /* Every movement's own before/after reading is consistent with the next,
       so the history reads as one sequence rather than four that all claim to
       have started from zero. */
    const chain = (stored.stockTransactions || [])
      .filter((t) => t.type === "VARIANT_ADD")
      .map((t) => [t.previousQuantity, t.newQuantity])
      .sort((x, y) => x[0] - y[0]);
    expect(chain).toEqual([[0, 5], [5, 10], [10, 15], [15, 20]]);
  });

  test("a reduction cannot take a balance below zero, even in a race", async () => {
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const it = await item({
      co: a, quantity: 10,
      over: { variants: [{ combination: ["Red"], sku: "V-1", quantity: 10 }] },
    });
    const variantId = String((await RawItem.findById(it._id).lean()).variants[0]._id);
    const path = `/raw-items/${it._id}/variants/${variantId}/reduce-stock`;

    /* Three simultaneous requests for 4 each, against 10 on the shelf. Two
       can be honoured; the third has nothing to take. */
    const results = await Promise.all([1, 2, 3].map(() => call(path, {
      method: "POST", token: approver.token, idempotencyKey: newKey(),
      body: { quantity: 4, reason: "Issued" },
    })));

    const stored = await RawItem.findById(it._id).lean();
    expect(stored.variants[0].quantity).toBeGreaterThanOrEqual(0);
    const ok = results.filter((r) => r.status < 400).length;
    expect(stored.variants[0].quantity).toBe(10 - ok * 4);
    expect(ok).toBeLessThanOrEqual(2);
  });
});

/* ═══ 6 · UNIT CONVERSION INTEGRITY ══════════════════════════════════════ */

describe("unit conversions", () => {
  const owner = async (co) => person({ co, grant: "store", role: "owner" });

  test("a zero, blank or unparseable factor is refused, never dropped", async () => {
    /* `!conv.quantity` skipped these with `continue`, so the unit saved and
       the conversion row silently vanished. */
    const a = await company("Acme");
    const boss = await owner(a);
    const metre = await unit({ co: a, name: "metre" });
    const roll = await unit({ co: a, name: "roll" });

    for (const bad of [0, "", "abc", "-5", "1e3", null, Infinity]) {
      const res = await call(`/units/${roll._id}`, {
        method: "PUT", token: boss.token,
        body: { conversions: [{ toUnit: String(metre._id), quantity: bad }] },
      });
      expect(res.status).toBe(400);
      const stored = await Unit.findById(roll._id).lean();
      expect(stored.conversions).toHaveLength(0);   // nothing half-saved
    }
  });

  test("a unit cannot convert to itself", async () => {
    const a = await company("Acme");
    const boss = await owner(a);
    const roll = await unit({ co: a, name: "roll" });

    const res = await call(`/units/${roll._id}`, {
      method: "PUT", token: boss.token,
      body: { conversions: [{ toUnit: String(roll._id), quantity: 2 }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.details.reason).toBe("SELF_CONVERSION");
  });

  test("two rows for one target are contradictory and refused", async () => {
    const a = await company("Acme");
    const boss = await owner(a);
    const metre = await unit({ co: a, name: "metre" });
    const roll = await unit({ co: a, name: "roll" });

    const res = await call(`/units/${roll._id}`, {
      method: "PUT", token: boss.token,
      body: {
        conversions: [
          { toUnit: String(metre._id), quantity: 40 },
          { toUnit: String(metre._id), quantity: 25 },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.details.reason).toBe("DUPLICATE_TARGET");
  });

  test("a cross-company target unit is missing, not forbidden", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const boss = await owner(a);
    const roll = await unit({ co: a, name: "roll" });
    const foreign = await unit({ co: b, name: "their-metre" });

    const res = await call(`/units/${roll._id}`, {
      method: "PUT", token: boss.token,
      body: { conversions: [{ toUnit: String(foreign._id), quantity: 40 }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.details.reason).toBe("TARGET_NOT_FOUND");
    expect(JSON.stringify(res.body)).not.toContain("their-metre");
  });

  test("a valid conversion is stored exactly as stated", async () => {
    const a = await company("Acme");
    const boss = await owner(a);
    const metre = await unit({ co: a, name: "metre" });
    const roll = await unit({ co: a, name: "roll" });

    const res = await call(`/units/${roll._id}`, {
      method: "PUT", token: boss.token,
      body: { conversions: [{ toUnit: String(metre._id), quantity: 40 }] },
    });
    expect(res.status).toBe(200);
    const stored = await Unit.findById(roll._id).lean();
    expect(stored.conversions).toHaveLength(1);
    expect(stored.conversions[0].quantity).toBe(40);
  });
});

/* ═══ 7 · DELETION SAFETY ════════════════════════════════════════════════ */

describe("deletion is refused while anything references the record", () => {
  test("a unit in use by an item cannot be deleted", async () => {
    const a = await company("Acme");
    const boss = await person({ co: a, grant: "store", role: "owner" });
    const metre = await unit({ co: a, name: "metre" });
    await item({ co: a, over: { unit: "metre" } });

    const res = await call(`/units/${metre._id}`, { method: "DELETE", token: boss.token });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("UNIT_IN_USE");
    expect(res.body.blockedBy.some((b) => b.kind === "items")).toBe(true);
    expect(await Unit.countDocuments({ _id: metre._id })).toBe(1);
  });

  test("a unit another unit converts to cannot be deleted", async () => {
    const a = await company("Acme");
    const boss = await person({ co: a, grant: "store", role: "owner" });
    const metre = await unit({ co: a, name: "metre" });
    await unit({ co: a, name: "roll", over: { conversions: [{ toUnit: metre._id, quantity: 40 }] } });

    const res = await call(`/units/${metre._id}`, { method: "DELETE", token: boss.token });
    expect(res.status).toBe(409);
    expect(res.body.blockedBy.some((b) => b.kind === "conversions")).toBe(true);
    /* And the referring unit's conversion table is intact — the old delete
       pulled it out of every other unit as it went. */
    const roll = await Unit.findOne({ name: "roll" }).lean();
    expect(roll.conversions).toHaveLength(1);
  });

  test("an unreferenced unit deletes cleanly", async () => {
    const a = await company("Acme");
    const boss = await person({ co: a, grant: "store", role: "owner" });
    const spare = await unit({ co: a, name: "spare" });
    expect((await call(`/units/${spare._id}`, { method: "DELETE", token: boss.token })).status).toBe(200);
    expect(await Unit.countDocuments({ _id: spare._id })).toBe(0);
  });

  test("an item on a purchase order cannot be deleted", async () => {
    /* S11 destroyed the item and its embedded movement history together, with
       no check that a live order referenced it. */
    const a = await company("Acme");
    const boss = await person({ co: a, grant: "store", role: "owner" });
    const it = await item({ co: a });
    await PurchaseOrder.create({
      companyId: a._id, createdBy: new mongoose.Types.ObjectId(),
      poNumber: `PO/2026-27/${String(++seq).padStart(4, "0")}`,
      vendorName: "V", status: "ISSUED", totalAmount: 10,
      items: [{ rawItem: it._id, itemName: it.name, unit: "m", quantity: 1, unitPrice: 10, totalPrice: 10 }],
    });

    const res = await call(`/raw-items/${it._id}`, { method: "DELETE", token: boss.token });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ITEM_IN_USE");
    expect(res.body.blockedBy.some((b) => b.kind === "purchaseOrders")).toBe(true);
    expect(await RawItem.countDocuments({ _id: it._id })).toBe(1);
  });

  test("an item with stock or movement history cannot be deleted", async () => {
    const a = await company("Acme");
    const boss = await person({ co: a, grant: "store", role: "owner" });
    const withStock = await item({ co: a, quantity: 5 });
    const withHistory = await item({
      co: a, quantity: 0,
      over: { stockTransactions: [{ type: "ADD", quantity: 5, previousQuantity: 0, newQuantity: 5 }] },
    });

    const stockRes = await call(`/raw-items/${withStock._id}`, { method: "DELETE", token: boss.token });
    expect(stockRes.status).toBe(409);
    expect(stockRes.body.blockedBy.some((b) => b.kind === "stockOnHand")).toBe(true);

    const histRes = await call(`/raw-items/${withHistory._id}`, { method: "DELETE", token: boss.token });
    expect(histRes.status).toBe(409);
    /* The movements are the only record of what happened; deleting the item
       would have destroyed them. */
    expect(histRes.body.blockedBy.some((b) => b.kind === "stockHistory")).toBe(true);
    expect(await RawItem.countDocuments({ _id: withHistory._id })).toBe(1);
  });

  test("an unreferenced, empty item deletes cleanly", async () => {
    const a = await company("Acme");
    const boss = await person({ co: a, grant: "store", role: "owner" });
    const spare = await item({ co: a, quantity: 0 });
    expect((await call(`/raw-items/${spare._id}`, { method: "DELETE", token: boss.token })).status).toBe(200);
    expect(await RawItem.countDocuments({ _id: spare._id })).toBe(0);
  });
});

/* ═══ 8 · EMBEDDED PROCUREMENT AND CONFIGURATION ═════════════════════════ */

describe("embedded supplier and conversion data need their own authority", () => {
  test("an approver cannot set conversion factors through the item payload", async () => {
    /* The dedicated conversion endpoints require sp.config.manage, but the
       same factors ride along inside variants[].unitConversions on an ordinary
       item edit, which only ever checked sp.master.maintain. An approver
       maintains the catalogue and is deliberately NOT a configuration owner. */
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const it = await item({ co: a, over: { variants: [{ combination: ["Red"], sku: "V-1" }] } });

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: approver.token,
      body: {
        variants: [{
          _id: String((await RawItem.findById(it._id).lean()).variants[0]._id),
          combination: ["Red"], sku: "V-1",
          unitConversions: [{ toUnit: "roll", quantity: 50 }],
        }],
      },
    });

    expect(res.status).toBe(403);
    expect(res.body.error.details.required).toContain("sp.config.manage");
    expect(res.body.error.details.fields).toContain("variants[0].unitConversions");

    const stored = await RawItem.findById(it._id).lean();
    /* Refused, not quietly stripped — and nothing else in the edit landed. */
    expect(stored.variants[0].unitConversions || []).toHaveLength(0);
  });

  test("the legacy top-level unitConversion field is checked the same way", async () => {
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const it = await item({ co: a });

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: approver.token,
      body: { unitConversion: { toUnit: "roll", quantity: 50 } },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.details.fields).toContain("unitConversion");
  });

  test("an owner may set the same conversion, against a unit of its own company", async () => {
    const a = await company("Acme");
    const boss = await person({ co: a, grant: "store", role: "owner" });
    await unit({ co: a, name: "roll" });
    const it = await item({ co: a });

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: boss.token,
      body: { unitConversion: { toUnit: "roll", quantity: 50 } },
    });
    expect(res.status).toBe(200);
  });

  test("a conversion cannot point at another company's unit, or use a zero factor", async () => {
    const a = await company("Acme");
    const b = await company("Beta");
    const boss = await person({ co: a, grant: "store", role: "owner" });
    await unit({ co: b, name: "crate" });                 // Beta's unit only
    const it = await item({ co: a });

    const foreign = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: boss.token,
      body: { unitConversion: { toUnit: "crate", quantity: 12 } },
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.details.reason).toBe("TARGET_NOT_FOUND");

    await unit({ co: a, name: "crate" });
    const zero = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: boss.token,
      body: { unitConversion: { toUnit: "crate", quantity: 0 } },
    });
    expect(zero.status).toBe(400);
    expect(zero.body.error.details.reason).toBe("INVALID_FACTOR");
  });

  test("an unknown supplier id is now genuinely answerable as not found", async () => {
    /* Through two contracts: it was VENDOR_NOT_FOUND when existence was all
       that could be checked (a claim the system could not support), then
       SUPPLIER_TENANCY_UNAVAILABLE while nothing could be checked at all.
       Now suppliers have owners, so "not in this company" is a fact. */
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" }); // has sourcing
    const it = await item({ co: a });

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: approver.token,
      body: {
        variants: [{
          combination: ["Red"], sku: "V-1",
          vendorNicknames: [{ vendor: new mongoose.Types.ObjectId(), nickname: "Ghost", price: 10 }],
        }],
      },
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("SUPPLIER_NOT_FOUND");
  });

  test("the supplier half of the check is wired, though no grant separates it today", () => {
    /* Every store role holding sp.master.maintain also holds sp.sourcing.manage,
       so this branch has no end-to-end actor to exercise. It is asserted at the
       route so a future grant that separates them is covered rather than
       silently bypassed. */
    const { GRANTS, CAPABILITIES: C } = require("../../services/storePurchase/capabilities");
    for (const role of ["editor", "approver"]) {
      expect(GRANTS.store[role]).toContain(C.MASTER_MAINTAIN);
      expect(GRANTS.store[role]).toContain(C.SOURCING_MANAGE);   // why: not separable yet
      expect(GRANTS.store[role]).not.toContain(C.CONFIG_MANAGE);
    }
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "routes", "CMS_Routes", "Inventory", "Products", "rawItems.js"),
      "utf8");
    expect(src).toContain("vendorNicknames");
    expect(src).toMatch(/router\.post\("\/", \.\.\.canMaintain, payloadAuthority/);
    expect(src).toMatch(/router\.put\("\/:id", \.\.\.canMaintain, payloadAuthority/);
  });
});

/* ═══ 9 · A VARIANT MISSING FROM THE PAYLOAD IS NOT A DELETED VARIANT ════ */

describe("item editing cannot remove a variant or its stock", () => {
  const twoStocked = async (co) => item({
    co, quantity: 30,
    over: { variants: [
      { combination: ["Red"], sku: "V-R", quantity: 10 },
      { combination: ["Blue"], sku: "V-B", quantity: 20 },
    ] },
  });

  test("a payload listing only one of two variants is refused, and nothing moves", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const it = await twoStocked(a);
    const before = await RawItem.findById(it._id).lean();

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: store.token,
      body: { variants: [{ _id: String(before.variants[0]._id), combination: ["Red"], sku: "V-R" }] },
    });

    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("VARIANT_REMOVAL_NOT_SUPPORTED");
    expect(res.body.error.details.missingVariants).toEqual([
      expect.objectContaining({ sku: "V-B", quantity: 20 }),
    ]);

    const after = await RawItem.findById(it._id).lean();
    expect(after.variants).toHaveLength(2);
    expect(after.variants.map((v) => v.quantity).sort()).toEqual([10, 20]);
    expect(after.quantity).toBe(30);                 // never recomputed from a subset
    expect(after.variants.map((v) => String(v._id)))
      .toEqual(before.variants.map((v) => String(v._id)));   // ids preserved
  });

  test("an invalid variants value cannot clear the array", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const it = await twoStocked(a);

    for (const bad of [null, "", 0, { combination: ["Red"] }]) {
      const res = await call(`/raw-items/${it._id}`, {
        method: "PUT", token: store.token, body: { name: "Edited", variants: bad },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details.reason).toBe("VARIANTS_MALFORMED");
    }
    const after = await RawItem.findById(it._id).lean();
    expect(after.variants).toHaveLength(2);
    expect(after.quantity).toBe(30);
  });

  test("listing every existing variant is accepted, and a new one starts empty", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const it = await twoStocked(a);
    const before = await RawItem.findById(it._id).lean();

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: store.token,
      body: { variants: [
        { _id: String(before.variants[0]._id), combination: ["Red"], sku: "V-R" },
        { _id: String(before.variants[1]._id), combination: ["Blue"], sku: "V-B" },
        { combination: ["Green"], sku: "V-G" },
      ] },
    });
    expect(res.status).toBe(200);

    const after = await RawItem.findById(it._id).lean();
    expect(after.variants).toHaveLength(3);
    expect(after.variants.find((v) => v.sku === "V-R").quantity).toBe(10);
    expect(after.variants.find((v) => v.sku === "V-B").quantity).toBe(20);
    expect(after.variants.find((v) => v.sku === "V-G").quantity).toBe(0);  // new: empty
  });

  test("a repeated variant is refused rather than collapsed", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const it = await twoStocked(a);
    const before = await RawItem.findById(it._id).lean();
    const ids = before.variants.map((v) => String(v._id));

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: store.token,
      body: { variants: [
        { _id: ids[0], combination: ["Red"], sku: "V-R" },
        { _id: ids[0], combination: ["Red"], sku: "V-R" },
        { _id: ids[1], combination: ["Blue"], sku: "V-B" },
      ] },
    });
    expect(res.status).toBe(400);
    expect(["DUPLICATE_VARIANT_ID", "DUPLICATE_VARIANT_COMBINATION"])
      .toContain(res.body.error.details.reason);

    const after = await RawItem.findById(it._id).lean();
    expect(after.variants).toHaveLength(2);
  });
});

/* ═══ 10 · THE STOCK UNIT IS NOT AN EDITABLE LABEL ═══════════════════════ */

describe("changing the stock unit cannot reinterpret what is recorded", () => {
  test("an item holding stock refuses the change and says what it would reread", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const it = await item({ co: a, quantity: 40 });     // 40 metres

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: store.token, body: { unit: "pcs" },
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("UNIT_CHANGE_BLOCKED");
    expect(res.body.blockedBy.map((b) => b.kind)).toContain("stockOnHand");
    /* No conversion was performed and no balance was rewritten. */
    const after = await RawItem.findById(it._id).lean();
    expect(after.unit).toBe("m");
    expect(after.quantity).toBe(40);
  });

  test("variant stock and recorded movements block it just as on-hand stock does", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const it = await item({
      co: a, quantity: 0,
      over: {
        variants: [{ combination: ["Red"], sku: "V-R", quantity: 5 }],
        stockTransactions: [{ type: "ADD", quantity: 5, date: new Date() }],
      },
    });

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: store.token, body: { unit: "pcs" },
    });
    expect(res.status).toBe(409);
    const kinds = res.body.blockedBy.map((b) => b.kind);
    expect(kinds).toContain("variantStock");
    expect(kinds).toContain("stockHistory");
    expect((await RawItem.findById(it._id).lean()).unit).toBe("m");
  });

  test("an item on a purchase order is blocked even with no stock on hand", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const it = await item({ co: a, quantity: 0 });
    await PurchaseOrder.create({
      companyId: a._id, createdBy: new mongoose.Types.ObjectId(),
      poNumber: `PO/2026-27/${String(++seq).padStart(4, "0")}`,
      vendorName: "V", status: "ISSUED", totalAmount: 100,
      items: [{ rawItem: it._id, itemName: it.name, unit: "m", quantity: 10, unitPrice: 10, totalPrice: 100 }],
    });

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: store.token, body: { unit: "pcs" },
    });
    expect(res.status).toBe(409);
    expect(res.body.blockedBy.map((b) => b.kind)).toContain("purchaseOrders");
    expect((await RawItem.findById(it._id).lean()).unit).toBe("m");
  });

  test("a genuinely unused empty item may still have a mistyped unit corrected", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const it = await item({ co: a, quantity: 0 });

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: store.token, body: { unit: "pcs" },
    });
    expect(res.status).toBe(200);
    expect((await RawItem.findById(it._id).lean()).unit).toBe("pcs");
  });

  test("re-sending the same unit is not a change, so a stocked item still edits", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const it = await item({ co: a, quantity: 40 });

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: store.token, body: { unit: "m", name: "Renamed" },
    });
    expect(res.status).toBe(200);
    const after = await RawItem.findById(it._id).lean();
    expect(after.name).toBe("Renamed");
    expect(after.quantity).toBe(40);
  });
});

/* ═══ 11 · CONVERSION AUTHORITY ON EVERY PATH THAT REACHES A FACTOR ══════ */

describe("unit conversions cannot be set or erased without configuration authority", () => {
  const twoUnits = async (co) => ({
    gram: await unit({ co, name: `gram-${++seq}` }),
    kilo: await unit({ co, name: `kilo-${++seq}` }),
  });

  test("an editor cannot create a unit carrying conversions", async () => {
    /* PUT was guarded and POST was not, so the identical factor an editor
       could not add to an existing unit could simply be created with one. */
    const a = await company("Acme");
    const editor = await person({ co: a, grant: "store", role: "editor" });
    const { gram } = await twoUnits(a);

    const res = await call("/units", {
      method: "POST", token: editor.token,
      body: { name: "Sack", conversions: [{ toUnit: String(gram._id), quantity: 50 }] },
    });

    expect(res.status).toBe(403);
    expect(res.body.error.details.required).toContain("sp.config.manage");
    /* Refused, not stripped: no unit exists with the name either way. */
    expect(await Unit.countDocuments({ companyId: a._id, name: /^sack$/i })).toBe(0);
  });

  test("an editor may still create an ordinary unit with no conversions", async () => {
    const a = await company("Acme");
    const editor = await person({ co: a, grant: "store", role: "editor" });
    const res = await call("/units", { method: "POST", token: editor.token, body: { name: "Sack" } });
    expect(res.status).toBe(201);
  });

  test("a status-only edit by an editor leaves the conversion table untouched", async () => {
    /* PUT always assigned `unit.conversions = checked.conversions`, and an
       omitted `conversions` validates to an EMPTY array — so retiring a unit
       silently erased an owner's conversion table. */
    const a = await company("Acme");
    const boss = await person({ co: a, grant: "store", role: "owner" });
    const editor = await person({ co: a, grant: "store", role: "editor" });
    const { gram, kilo } = await twoUnits(a);

    const created = await call("/units", {
      method: "POST", token: boss.token,
      body: { name: "Bale", conversions: [
        { toUnit: String(gram._id), quantity: 500 },
        { toUnit: String(kilo._id), quantity: 0.5 },
      ] },
    });
    expect(created.status).toBe(201);
    const id = created.body.unit._id;
    const before = await Unit.findById(id).lean();
    expect(before.conversions).toHaveLength(2);

    const statusOnly = await call(`/units/${id}`, {
      method: "PUT", token: editor.token, body: { status: "Inactive" },
    });
    expect(statusOnly.status).toBe(200);

    const after = await Unit.findById(id).lean();
    expect(after.status).toBe("Inactive");
    /* Byte for byte — same targets, same factors, same row ids. */
    expect(after.conversions.map((c) => ({
      toUnit: String(c.toUnit), quantity: c.quantity, _id: String(c._id),
    }))).toEqual(before.conversions.map((c) => ({
      toUnit: String(c.toUnit), quantity: c.quantity, _id: String(c._id),
    })));
  });

  test("an editor cannot clear conversions by sending an empty list", async () => {
    const a = await company("Acme");
    const boss = await person({ co: a, grant: "store", role: "owner" });
    const editor = await person({ co: a, grant: "store", role: "editor" });
    const { gram } = await twoUnits(a);

    const created = await call("/units", {
      method: "POST", token: boss.token,
      body: { name: "Crate", conversions: [{ toUnit: String(gram._id), quantity: 12 }] },
    });
    const id = created.body.unit._id;

    const cleared = await call(`/units/${id}`, {
      method: "PUT", token: editor.token, body: { conversions: [] },
    });
    expect(cleared.status).toBe(403);
    expect((await Unit.findById(id).lean()).conversions).toHaveLength(1);
  });

  test("an owner may explicitly clear or replace them", async () => {
    const a = await company("Acme");
    const boss = await person({ co: a, grant: "store", role: "owner" });
    const { gram, kilo } = await twoUnits(a);

    const created = await call("/units", {
      method: "POST", token: boss.token,
      body: { name: "Drum", conversions: [{ toUnit: String(gram._id), quantity: 200 }] },
    });
    const id = created.body.unit._id;

    const replaced = await call(`/units/${id}`, {
      method: "PUT", token: boss.token,
      body: { conversions: [{ toUnit: String(kilo._id), quantity: 0.2 }] },
    });
    expect(replaced.status).toBe(200);
    let stored = await Unit.findById(id).lean();
    expect(stored.conversions).toHaveLength(1);
    expect(String(stored.conversions[0].toUnit)).toBe(String(kilo._id));

    const emptied = await call(`/units/${id}`, {
      method: "PUT", token: boss.token, body: { conversions: [] },
    });
    expect(emptied.status).toBe(200);
    stored = await Unit.findById(id).lean();
    expect(stored.conversions).toHaveLength(0);
  });

  test("a unit name is text, not a pattern, when checking for duplicates", async () => {
    /* `new RegExp("^" + name + "$")` made "m.s" match "mXs", so a legitimate
       new unit was refused as a duplicate of one it merely pattern-matched. */
    const a = await company("Acme");
    const boss = await person({ co: a, grant: "store", role: "owner" });

    /* Order matters: the LITERAL name is created first, so the pattern-y one
       is the request whose regex would match it. The other way round the
       defect hides. */
    const first = await call("/units", { method: "POST", token: boss.token, body: { name: "mXs" } });
    expect(first.status).toBe(201);

    const second = await call("/units", { method: "POST", token: boss.token, body: { name: "m.s" } });
    expect(second.status).toBe(201);

    /* And the genuine duplicate is still refused. */
    const dup = await call("/units", { method: "POST", token: boss.token, body: { name: "M.S" } });
    expect(dup.status).toBe(400);
  });
});

/* ═══ 12 · ITEM MASTER EDITING CHANGES NO BALANCE, EVER ═════════════════ */

describe("editing item details never rewrites the parent balance", () => {
  /* An item whose parent balance disagrees with its variants — a legacy
     record, or one mid-reconciliation. Catalogue editing must not quietly
     "repair" it: that is a stock movement nobody recorded or approved. */
  const inconsistent = async (co) => item({
    co, quantity: 35,
    over: { variants: [
      { combination: ["Red"], sku: "V-R", quantity: 10 },
      { combination: ["Blue"], sku: "V-B", quantity: 20 },
    ] },
  });

  test("a rename leaves an inconsistent parent balance exactly as it was", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const it = await inconsistent(a);
    const before = await RawItem.findById(it._id).lean();
    expect(before.quantity).toBe(35);            // variants total 30

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: store.token, body: { name: "Renamed", notes: "typo" },
    });
    expect(res.status).toBe(200);

    const after = await RawItem.findById(it._id).lean();
    expect(after.name).toBe("Renamed");
    expect(after.quantity).toBe(35);             // NOT recomputed to 30
    expect(after.variants.map((v) => v.quantity)).toEqual([10, 20]);
    expect(after.stockTransactions || []).toHaveLength(before.stockTransactions?.length || 0);
  });

  test("a full variant edit does not recompute the parent either", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const it = await inconsistent(a);
    const before = await RawItem.findById(it._id).lean();

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: store.token,
      body: { variants: [
        { _id: String(before.variants[0]._id), combination: ["Red"], sku: "V-R2" },
        { _id: String(before.variants[1]._id), combination: ["Blue"], sku: "V-B2" },
      ] },
    });
    expect(res.status).toBe(200);

    const after = await RawItem.findById(it._id).lean();
    expect(after.variants.map((v) => v.sku)).toEqual(["V-R2", "V-B2"]);
    expect(after.quantity).toBe(35);
    expect(after.variants.map((v) => v.quantity)).toEqual([10, 20]);
  });

  test("adding a zero-stock variant does not recalculate the parent", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const it = await inconsistent(a);
    const before = await RawItem.findById(it._id).lean();

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: store.token,
      body: { variants: [
        { _id: String(before.variants[0]._id), combination: ["Red"], sku: "V-R" },
        { _id: String(before.variants[1]._id), combination: ["Blue"], sku: "V-B" },
        { combination: ["Green"], sku: "V-G" },
      ] },
    });
    expect(res.status).toBe(200);

    const after = await RawItem.findById(it._id).lean();
    expect(after.variants).toHaveLength(3);
    expect(after.variants.find((v) => v.sku === "V-G").quantity).toBe(0);
    expect(after.quantity).toBe(35);
    expect(after.stockTransactions || []).toHaveLength(before.stockTransactions?.length || 0);
  });
});

/* ═══ 13 · A MOVED BALANCE CARRIES ITS STATUS WITH IT ═══════════════════ */

describe("stored statuses follow the balance the movement produced", () => {
  const GOOD = { supplier: "Mill Co", unitPrice: 10, reason: "Received against invoice 42" };

  /** An item with one variant, at a stated balance and minimum. */
  const stocked = async (co, { quantity, minStock = 5 }) => {
    const it = await item({
      co, quantity,
      /* `minStock` belongs in `over`: the fixture hardcodes 0 otherwise, and a
         parent minimum of 0 can never read Low Stock. */
      over: { minStock, variants: [{ combination: ["Red"], sku: "V-1", quantity, minStock }] },
    });
    const fresh = await RawItem.findById(it._id).lean();
    return { it, variantId: String(fresh.variants[0]._id) };
  };

  const move = (token, itemId, variantId, verb, body) =>
    call(`/raw-items/${itemId}/variants/${variantId}/${verb}`, {
      method: "POST", token, idempotencyKey: newKey(), body,
    });

  test("zero to positive: both statuses become In Stock", async () => {
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const { it, variantId } = await stocked(a, { quantity: 0, minStock: 5 });
    expect((await RawItem.findById(it._id).lean()).status).toBe("Out of Stock");

    const res = await move(approver.token, it._id, variantId, "add-stock", { ...GOOD, quantity: 20 });
    expect(res.status).toBeLessThan(400);

    const after = await RawItem.findById(it._id).lean();
    expect(after.variants[0].quantity).toBe(20);
    expect(after.variants[0].status).toBe("In Stock");
    expect(after.status).toBe("In Stock");
  });

  test("into the minimum: both statuses become Low Stock", async () => {
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const { it, variantId } = await stocked(a, { quantity: 0, minStock: 5 });

    const res = await move(approver.token, it._id, variantId, "add-stock", { ...GOOD, quantity: 5 });
    expect(res.status).toBeLessThan(400);

    const after = await RawItem.findById(it._id).lean();
    expect(after.variants[0].quantity).toBe(5);
    expect(after.variants[0].status).toBe("Low Stock");   // 5 <= minStock 5
    expect(after.status).toBe("Low Stock");
  });

  test("down to zero: both statuses become Out of Stock", async () => {
    /* The damaging case: a shelf reading zero while the catalogue still says
       In Stock, because the pipeline moved the number and not the label. */
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const { it, variantId } = await stocked(a, { quantity: 12, minStock: 5 });
    expect((await RawItem.findById(it._id).lean()).status).toBe("In Stock");

    const res = await move(approver.token, it._id, variantId, "reduce-stock",
      { quantity: 12, reason: "Issued to cutting" });
    expect(res.status).toBeLessThan(400);

    const after = await RawItem.findById(it._id).lean();
    expect(after.variants[0].quantity).toBe(0);
    expect(after.variants[0].status).toBe("Out of Stock");
    expect(after.status).toBe("Out of Stock");
  });

  test("down into the minimum: Low Stock, not still In Stock", async () => {
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const { it, variantId } = await stocked(a, { quantity: 12, minStock: 5 });

    const res = await move(approver.token, it._id, variantId, "reduce-stock",
      { quantity: 8, reason: "Issued to cutting" });
    expect(res.status).toBeLessThan(400);

    const after = await RawItem.findById(it._id).lean();
    expect(after.variants[0].quantity).toBe(4);
    expect(after.variants[0].status).toBe("Low Stock");
    expect(after.status).toBe("Low Stock");
  });

  test("a movement stamps updatedAt", async () => {
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const { it, variantId } = await stocked(a, { quantity: 0, minStock: 5 });
    const before = await RawItem.findById(it._id).lean();

    await move(approver.token, it._id, variantId, "add-stock", { ...GOOD, quantity: 7 });

    const after = await RawItem.findById(it._id).lean();
    expect(new Date(after.updatedAt).getTime())
      .toBeGreaterThanOrEqual(new Date(before.updatedAt).getTime());
  });

  test("concurrent movements leave the status agreeing with the final balance", async () => {
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const { it, variantId } = await stocked(a, { quantity: 20, minStock: 5 });

    /* Four issues of 4 against 20: the shelf ends at 4, which is Low Stock.
       A per-request status computed from a stale read would land anywhere. */
    const results = await Promise.all([1, 2, 3, 4].map(() =>
      move(approver.token, it._id, variantId, "reduce-stock", { quantity: 4, reason: "Issued to cutting" })));
    results.forEach((r) => expect(r.status).toBeLessThan(400));

    const after = await RawItem.findById(it._id).lean();
    expect(after.variants[0].quantity).toBe(4);
    expect(after.variants[0].status).toBe("Low Stock");
    expect(after.status).toBe("Low Stock");
  });
});

/* ═══ 14 · WHAT THE OPERATOR TYPED IS WHAT MOVES ════════════════════════ */

describe("stock movements parse strictly and refuse before moving anything", () => {
  const setup = async () => {
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const it = await item({
      co: a, quantity: 10, minStock: 2,
      over: { variants: [{ combination: ["Red"], sku: "V-1", quantity: 10, minStock: 2 }] },
    });
    const fresh = await RawItem.findById(it._id).lean();
    return { a, approver, it, variantId: String(fresh.variants[0]._id), before: fresh };
  };

  const post = (token, itemId, variantId, verb, body) =>
    call(`/raw-items/${itemId}/variants/${variantId}/${verb}`, {
      method: "POST", token, idempotencyKey: newKey(), body,
    });

  const unchanged = async (itemId, before) => {
    const after = await RawItem.findById(itemId).lean();
    expect(after.quantity).toBe(before.quantity);
    expect(after.variants[0].quantity).toBe(before.variants[0].quantity);
    expect(after.variants[0].status).toBe(before.variants[0].status);
    expect(after.status).toBe(before.status);
    expect(after.stockTransactions || []).toHaveLength(before.stockTransactions?.length || 0);
  };

  test("exponent notation is refused, not silently read as its first digit", async () => {
    /* `isNaN("1e3")` is false so it passed validation, and `parseFloat("1e3")`
       is 1000 — but the same shape reaches other parsers as 1. Either way the
       movement recorded is not the one the operator typed, so it is refused. */
    const { approver, it, variantId, before } = await setup();
    const res = await post(approver.token, it._id, variantId, "add-stock",
      { quantity: "1e3", supplier: "Mill Co", unitPrice: 10, reason: "Received" });
    expect(res.status).toBe(400);
    await unchanged(it._id, before);
  });

  test("only plain decimals to four places are accepted", async () => {
    const { approver, it, variantId, before } = await setup();
    for (const bad of ["2.00001", " 5", "5 ", "+5", "-5", "0", "", "  ", "abc",
                       "5 rolls", ".", null, undefined, {}, [], true, Infinity, NaN]) {
      const res = await post(approver.token, it._id, variantId, "add-stock",
        { quantity: bad, supplier: "Mill Co", unitPrice: 10, reason: "Received" });
      expect(res.status).toBe(400);
    }
    await unchanged(it._id, before);

    /* A JSON number is unambiguous and accepted; one so large it can only be
       written in exponent form is not, which is a bound this system can state
       rather than a value it would have to guess at. */
    for (const bad of ["1.", ".5", 1e21]) {
      const res = await post(approver.token, it._id, variantId, "add-stock",
        { quantity: bad, supplier: "Mill Co", unitPrice: 10, reason: "Received" });
      expect(res.status).toBe(400);
    }
    await unchanged(it._id, before);

    /* And a legitimate four-place value still works. */
    const ok = await post(approver.token, it._id, variantId, "add-stock",
      { quantity: "0.2500", supplier: "Mill Co", unitPrice: 10, reason: "Received" });
    expect(ok.status).toBeLessThan(400);
    expect((await RawItem.findById(it._id).lean()).variants[0].quantity).toBe(10.25);
  });

  test("the unit price is parsed just as strictly", async () => {
    const { approver, it, variantId, before } = await setup();
    for (const bad of ["1e2", "10.000001", "-1", "0", "", "ten", {}]) {
      const res = await post(approver.token, it._id, variantId, "add-stock",
        { quantity: "5", supplier: "Mill Co", unitPrice: bad, reason: "Received" });
      expect(res.status).toBe(400);
    }
    await unchanged(it._id, before);
  });

  test("a malformed supplier id is refused before the stock moves", async () => {
    /* The pipeline bypasses Mongoose casting, so a string reaching an ObjectId
       field is stored as a string and every later populate on it fails. */
    const { approver, it, variantId, before } = await setup();
    const res = await post(approver.token, it._id, variantId, "add-stock",
      { quantity: "5", supplier: "Mill Co", unitPrice: 10, reason: "Received", supplierId: "not-an-id" });
    expect(res.status).toBe(400);
    await unchanged(it._id, before);
  });

  test("a valid supplier id is stored as an ObjectId, not a string", async () => {
    const { approver, it, variantId } = await setup();
    const supplierId = new mongoose.Types.ObjectId();
    const res = await post(approver.token, it._id, variantId, "add-stock",
      { quantity: "5", supplier: "Mill Co", unitPrice: 10, reason: "Received", supplierId: String(supplierId) });
    expect(res.status).toBeLessThan(400);

    const tx = (await RawItem.findById(it._id).lean()).stockTransactions[0];
    expect(tx.supplierId).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(tx.supplierId)).toBe(String(supplierId));
  });

  test("a manual movement cannot dress itself as a purchase-order receipt", async () => {
    /* These endpoints do not run the governed receipt lifecycle, so a movement
       they record must not claim to be one. */
    const { approver, it, variantId, before } = await setup();

    const named = await post(approver.token, it._id, variantId, "add-stock",
      { quantity: "5", supplier: "Mill Co", unitPrice: 10, reason: "Received", purchaseOrder: "PO/2026-27/0001" });
    expect(named.status).toBe(400);

    const linked = await post(approver.token, it._id, variantId, "add-stock",
      { quantity: "5", supplier: "Mill Co", unitPrice: 10, reason: "Received",
        purchaseOrderId: String(new mongoose.Types.ObjectId()) });
    expect(linked.status).toBe(400);

    await unchanged(it._id, before);
  });

  test("an empty order field is an unfilled box, not a claim", async () => {
    /* Refusing "" would reject a form for the shape of its payload while
       protecting nothing: no provenance is asserted, and none is recorded. */
    const { approver, it, variantId } = await setup();
    const res = await post(approver.token, it._id, variantId, "add-stock", {
      quantity: "5", supplier: "Mill Co", unitPrice: 10, reason: "Received",
      purchaseOrder: "", purchaseOrderId: null,
    });
    expect(res.status).toBeLessThan(400);

    const tx = (await RawItem.findById(it._id).lean()).stockTransactions[0];
    expect(tx.purchaseOrder || "").toBe("");
    expect(tx.purchaseOrderId ?? null).toBeNull();
  });

  test("a manual movement states its own reason", async () => {
    /* Defaulting to "Stock Consumption" writes an audit line nobody chose. */
    const { approver, it, variantId, before } = await setup();
    for (const bad of [undefined, "", "   ", 5, {}]) {
      const res = await post(approver.token, it._id, variantId, "reduce-stock",
        { quantity: "2", ...(bad === undefined ? {} : { reason: bad }) });
      expect(res.status).toBe(400);
    }
    await unchanged(it._id, before);

    const ok = await post(approver.token, it._id, variantId, "reduce-stock",
      { quantity: "2", reason: "  Issued to cutting  " });
    expect(ok.status).toBeLessThan(400);
    const tx = (await RawItem.findById(it._id).lean()).stockTransactions[0];
    expect(tx.reason).toBe("Issued to cutting");        // trimmed, as stated
  });
});

/* ═══ 15 · THE UNIT MASTER IS READ THROUGH THE COMPANY BOUNDARY ═════════ */

describe("catalogue unit reads never cross a company", () => {
  /** A unit named the same in both companies, with different arithmetic. */
  const namedUnit = async (co, name, target, factor) => {
    const to = await unit({ co, name: target });
    return Unit.create({
      ...(co ? { companyId: co._id } : {}),
      name, status: "Active",
      conversions: [{ toUnit: to._id, quantity: factor }],
    });
  };

  test("the /raw-items/units alias lists only this company's units", async () => {
    /* `/units` was scoped in the previous chunk; this alias inside the
       catalogue router was not, so the same information leaked through a
       different door. */
    const a = await company("Acme");
    const b = await company("Borealis");
    const store = await person({ co: a, grant: "store" });

    await unit({ co: a, name: "acme-only-roll" });
    await unit({ co: b, name: "borealis-only-crate" });

    const res = await call("/raw-items/units", { token: store.token });
    expect(res.status).toBe(200);
    expect(res.body.units).toContain("acme-only-roll");
    expect(res.body.units).not.toContain("borealis-only-crate");
  });

  test("a legacy-global unit is not offered to an ordinary company", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    await unit({ co: null, name: "legacy-global-bolt" });

    const res = await call("/raw-items/units", { token: store.token });
    expect(res.status).toBe(200);
    expect(res.body.units).not.toContain("legacy-global-bolt");
  });

  test("conversion enrichment uses this company's factor, not another's", async () => {
    /* Both companies call it "roll". Acme's roll is 25 metres; Borealis's is
       1000. The map was built from every Active unit in the database, so
       whichever loaded last decided what Acme's rolls were worth. */
    const a = await company("Acme");
    const b = await company("Borealis");
    const store = await person({ co: a, grant: "store" });

    await namedUnit(a, "roll", "metre-a", 25);
    await namedUnit(b, "roll", "metre-b", 1000);

    await item({ co: a, over: { unit: "roll", category: "Fabric" } });

    const res = await call("/raw-items", { token: store.token });
    expect(res.status).toBe(200);
    const row = res.body.rawItems.find((r) => (r.customUnit || r.unit) === "roll");
    expect(row).toBeTruthy();

    const factors = (row.unitConversions || []).map((c) => c.factor);
    expect(factors).toContain(25);
    expect(factors).not.toContain(1000);
    /* And the other company's target unit is not even named. */
    expect((row.unitConversions || []).map((c) => c.toUnit)).not.toContain("metre-b");
  });

  test("an item whose unit only exists in another company gets no conversions", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const store = await person({ co: a, grant: "store" });

    await namedUnit(b, "crate", "metre-b", 12);
    await item({ co: a, over: { unit: "crate", category: "Fabric" } });

    const res = await call("/raw-items", { token: store.token });
    const row = res.body.rawItems.find((r) => (r.customUnit || r.unit) === "crate");
    expect(row.unitConversions || []).toHaveLength(0);
  });
});

/* ═══ 16 · SUPPLIER INTEGRATION, ON A BOUNDARY THAT NOW EXISTS ══════════ */

describe("item supplier aliases bind only to this company's suppliers", () => {
  const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");

  const someSupplier = ({ co, name = "Mill", status = "Active", code } = {}) =>
    Vendor.create({
      ...(co ? { companyId: co._id } : {}),
      companyName: `${name} ${++seq}`, status,
      /* A company-owned supplier needs a code to be selectable at all — see
         "a supplier with no code is visible but not selectable". Legacy
         records (no company) keep none. */
      supplierCode: code !== undefined ? code : (co ? `SUP-CAT-${seq}` : ""),
    });

  test("Supplier Master now carries ownership — this is what reopened the integration", () => {
    /* The previous chunk closed every supplier path because this was false.
       If it ever becomes false again, the closure has to come back with it. */
    expect("companyId" in Vendor.schema.paths).toBe(true);
    expect("siteId" in Vendor.schema.paths).toBe(true);
    expect(Vendor.schema.paths.status.enumValues).toContain("Archived");
  });

  test("the supplier list offers this company's Active suppliers and nothing else", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const store = await person({ co: a, grant: "store" });

    const usable = await someSupplier({ co: a, name: "Usable Mills" });
    await someSupplier({ co: a, name: "Dormant Mills", status: "Inactive" });
    await someSupplier({ co: a, name: "Barred Mills", status: "Blacklisted" });
    await someSupplier({ co: a, name: "Closed Mills", status: "Archived" });
    await someSupplier({ co: b, name: "Neighbour Mills" });
    await someSupplier({ co: null, name: "Legacy Mills" });

    const res = await call("/raw-items/suppliers", { token: store.token });
    expect(res.status).toBe(200);
    const ids = res.body.suppliers.map((s) => String(s.id));
    expect(ids).toEqual([String(usable._id)]);

    const names = JSON.stringify(res.body);
    for (const hidden of ["Neighbour", "Legacy", "Dormant", "Barred", "Closed"]) {
      expect(names).not.toMatch(new RegExp(hidden));
    }
  });

  test("an alias to this company's Active supplier is accepted", async () => {
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const mill = await someSupplier({ co: a });
    const it = await item({ co: a, over: { variants: [{ combination: ["Red"], sku: "V-1" }] } });
    const variantId = String((await RawItem.findById(it._id).lean()).variants[0]._id);

    const res = await call(`/raw-items/${it._id}/variants/${variantId}/vendor-nicknames`, {
      method: "POST", token: approver.token,
      body: { vendor: String(mill._id), nickname: "MILL-CODE-1", price: 12 },
    });
    expect(res.status).toBe(201);

    const stored = await RawItem.findById(it._id).lean();
    expect(stored.variants[0].vendorNicknames).toHaveLength(1);
    expect(stored.variants[0].vendorNicknames[0].nickname).toBe("MILL-CODE-1");
  });

  test("another company's supplier is not found, and nothing is written", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const theirs = await someSupplier({ co: b, name: "Neighbour Mills" });
    const it = await item({ co: a, over: { variants: [{ combination: ["Red"], sku: "V-1" }] } });
    const variantId = String((await RawItem.findById(it._id).lean()).variants[0]._id);

    const res = await call(`/raw-items/${it._id}/variants/${variantId}/vendor-nicknames`, {
      method: "POST", token: approver.token,
      body: { vendor: String(theirs._id), nickname: "SNEAKY" },
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("SUPPLIER_NOT_FOUND");
    /* Says nothing about the supplier existing elsewhere. */
    expect(JSON.stringify(res.body)).not.toMatch(/Neighbour/);
    expect((await RawItem.findById(it._id).lean()).variants[0].vendorNicknames || []).toHaveLength(0);
  });

  test("a supplier that is not Active cannot be newly assigned", async () => {
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const it = await item({ co: a, over: { variants: [{ combination: ["Red"], sku: "V-1" }] } });
    const variantId = String((await RawItem.findById(it._id).lean()).variants[0]._id);

    for (const status of ["Inactive", "Blacklisted", "Archived"]) {
      const mill = await someSupplier({ co: a, name: status, status });
      const res = await call(`/raw-items/${it._id}/variants/${variantId}/vendor-nicknames`, {
        method: "POST", token: approver.token,
        body: { vendor: String(mill._id), nickname: `CODE-${status}` },
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("SUPPLIER_NOT_SELECTABLE");
      expect(res.body.message).toMatch(new RegExp(status, "i"));
    }
    expect((await RawItem.findById(it._id).lean()).variants[0].vendorNicknames || []).toHaveLength(0);
  });

  test("a legacy supplier cannot be newly assigned either", async () => {
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const legacy = await someSupplier({ co: null, name: "Legacy Mills" });
    const it = await item({ co: a, over: { variants: [{ combination: ["Red"], sku: "V-1" }] } });
    const variantId = String((await RawItem.findById(it._id).lean()).variants[0]._id);

    const res = await call(`/raw-items/${it._id}/variants/${variantId}/vendor-nicknames`, {
      method: "POST", token: approver.token,
      body: { vendor: String(legacy._id), nickname: "LEG-1" },
    });
    expect(res.status).toBe(404);
    expect((await RawItem.findById(it._id).lean()).variants[0].vendorNicknames || []).toHaveLength(0);
  });

  test("the same refusals apply through the item payload", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const theirs = await someSupplier({ co: b });
    const it = await item({ co: a, over: { variants: [{ combination: ["Red"], sku: "V-1" }] } });
    const before = await RawItem.findById(it._id).lean();

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: approver.token,
      body: { variants: [{
        _id: String(before.variants[0]._id), combination: ["Red"], sku: "V-1",
        vendorNicknames: [{ vendor: String(theirs._id), nickname: "SNEAKY", price: 10 }],
      }] },
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("SUPPLIER_NOT_FOUND");
    expect((await RawItem.findById(it._id).lean()).variants[0].vendorNicknames || []).toHaveLength(0);
  });

  test("an alias recorded before ownership stays, and answers for itself", async () => {
    /* Two aliases: one to this company's supplier, one to a legacy record. The
       second is history that cannot be verified — it is kept and labelled,
       never deleted and never presented as current. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const mine = await someSupplier({ co: a, name: "Known Mills" });
    const legacy = await someSupplier({ co: null, name: "Legacy Mills" });

    const it = await item({
      co: a,
      over: { variants: [{
        combination: ["Red"], sku: "V-1",
        vendorNicknames: [
          { vendor: mine._id, nickname: "KNOWN-1" },
          { vendor: legacy._id, nickname: "OLD-1" },
        ],
      }] },
    });
    const variantId = String((await RawItem.findById(it._id).lean()).variants[0]._id);

    const res = await call(`/raw-items/${it._id}/variants/${variantId}/vendor-nicknames`, {
      token: store.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.vendorNicknames).toHaveLength(2);

    const known = res.body.vendorNicknames.find((r) => r.nickname === "KNOWN-1");
    expect(known.identity).toBe("VERIFIED");
    expect(known.supplier.name).toMatch(/Known Mills/);

    const old = res.body.vendorNicknames.find((r) => r.nickname === "OLD-1");
    expect(old.identity).toBe("UNVERIFIED");
    expect(old.supplier).toBeNull();
    expect(res.body.unverifiedCount).toBe(1);

    /* Nothing was rewritten to make the boundary tidy. */
    const stored = await RawItem.findById(it._id).lean();
    expect(stored.variants[0].vendorNicknames).toHaveLength(2);
  });

  test("no supplier identity is ever resolved by an unrestricted populate", async () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "routes", "CMS_Routes", "Inventory", "Products", "rawItems.js"),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(code).not.toMatch(/populate\([^)]*primaryVendor/);
    expect(code).not.toMatch(/populate\([^)]*alternateVendors/);
    expect(code).not.toMatch(/vendorNicknames\.vendor/);
    expect(code).not.toMatch(/populate\("stockTransactions\.supplierId"/);

    /* Every supplier read goes through the two scoped resolvers. */
    /* Every supplier read goes through a scope helper — never a bare
       `findById`, which follows an id wherever it points. */
    expect(code).not.toMatch(/Vendor\.findById\(/);
    const vendorQueries = code.match(/Vendor\.(find|findOne|countDocuments)\([^)]*/g) || [];
    expect(vendorQueries.length).toBeGreaterThan(0);
    vendorQueries.forEach((q) => {
      expect(q).toMatch(/supplierScope\(req|tenantContext\.tenantFilter/);
    });
  });

  test("ordinary item editing is unaffected", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const it = await item({ co: a, quantity: 12 });

    const res = await call(`/raw-items/${it._id}`, {
      method: "PUT", token: store.token, body: { name: "Renamed", notes: "still works" },
    });
    expect(res.status).toBe(200);
    const after = await RawItem.findById(it._id).lean();
    expect(after.name).toBe("Renamed");
    expect(after.quantity).toBe(12);
  });
});
