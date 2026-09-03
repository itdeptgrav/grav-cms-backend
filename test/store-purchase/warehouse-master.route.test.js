// test/store-purchase/warehouse-master.route.test.js
//
// Store & Purchase — Chunk B3. Warehouses and locations.
//
// ── WHAT THIS PINS ──────────────────────────────────────────────────────────
// The router had authentication and nothing else: no tenant scope, no
// capability, a globally unique code, a destructive DELETE, `/:id` declared
// ahead of the static reference routes so both were captured by it, and a
// summary that summed a stale `itemsCount` and served it as inventory.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SpIdempotencyRecord = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");
const actionHistoryService = require("../../services/storePurchase/actionHistory.service");
const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/warehouses", require("../../routes/CMS_Routes/Inventory/Configurations/warehouses"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/warehouses`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const newKey = () => `wh-${++seq}-${Math.random().toString(36).slice(2)}`;

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

async function person({ co, grant = "store", role = "approver", name = "P" }) {
  const n = ++seq;
  const email = `wh${n}@test.example`;
  const emp = await Employee.create({
    firstName: name, lastName: `L${n}`, email, biometricId: `WH${n}`,
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

/** A warehouse written straight to the collection; `co: null` is legacy. */
const warehouse = async ({ co, code, name, status = "Active", over = {} } = {}) => Warehouse.create({
  ...(co ? { companyId: co._id } : {}),
  name: name || `Warehouse ${++seq}`,
  shortName: code || `WH${seq}`,
  status,
  locations: Warehouse.STANDARD_LOCATIONS.map((l) => ({ ...l, status: "Active" })),
  ...over,
});

const create = (token, co, body, key = newKey()) =>
  call("/", { method: "POST", token, company: co._id, idempotencyKey: key, body });

/* ═══ 1 · AUTHENTICATION AND CAPABILITY ══════════════════════════════════ */

describe("authentication and capability", () => {
  test("no token is refused everywhere", async () => {
    const co = await company("A");
    const w = await warehouse({ co });
    for (const [path, opts] of [
      ["/", {}],
      [`/${w._id}`, {}],
      ["/capacity/units", {}],
      ["/", { method: "POST", body: { name: "X", code: "X1" }, idempotencyKey: newKey() }],
      [`/${w._id}/lifecycle`, { method: "PATCH", body: { action: "archive", reason: "test" }, idempotencyKey: newKey() }],
    ]) {
      const r = await call(path, opts);
      expect(r.status).toBeGreaterThanOrEqual(401);
      expect(r.body?.success).not.toBe(true);
    }
  });

  test("an authenticated employee with no Store grant gets nothing", async () => {
    const co = await company("B");
    const nobody = await person({ co, grant: null });
    expect((await call("/", { token: nobody.token, company: co._id })).status).toBe(403);
  });

  test("reading is not maintaining", async () => {
    const co = await company("C");
    const w = await warehouse({ co });
    /* `viewer` holds sp.read but not sp.master.maintain. */
    const viewer = await person({ co, role: "viewer" });

    expect((await call("/", { token: viewer.token, company: co._id })).status).toBe(200);
    expect((await call(`/${w._id}`, { token: viewer.token, company: co._id })).status).toBe(200);
    expect((await call("/capacity/units", { token: viewer.token, company: co._id })).status).toBe(200);

    const write = await create(viewer.token, co, { name: "Nope", code: "NOPE" });
    expect(write.status).toBe(403);
    const life = await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: viewer.token, company: co._id, idempotencyKey: newKey(),
      body: { action: "deactivate" },
    });
    expect(life.status).toBe(403);
    expect((await Warehouse.findById(w._id)).status).toBe("Active");
  });
});

/* ═══ 2 · TENANT ISOLATION ═══════════════════════════════════════════════ */

describe("tenant isolation", () => {
  test("another company's warehouses never appear and cannot be read or changed", async () => {
    const mine = await company("Mine");
    const theirs = await company("Theirs");
    const theirW = await warehouse({ co: theirs, code: "SECRET", name: "SECRET DEPOT" });
    const me = await person({ co: mine });

    const list = await call("/", { token: me.token, company: mine._id });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain("SECRET DEPOT");
    expect(list.body.warehouses).toHaveLength(0);
    expect(list.body.summary.warehouses).toBe(0);

    expect((await call(`/${theirW._id}`, { token: me.token, company: mine._id })).status).toBe(404);
    expect((await call(`/${theirW._id}/locations`, { token: me.token, company: mine._id })).status).toBe(404);

    const update = await call(`/${theirW._id}`, {
      method: "PUT", token: me.token, company: mine._id, idempotencyKey: newKey(), body: { name: "Taken over" },
    });
    expect(update.status).toBe(404);

    const life = await call(`/${theirW._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: mine._id, idempotencyKey: newKey(),
      body: { action: "archive", reason: "not mine" },
    });
    expect(life.status).toBe(404);
    expect((await Warehouse.findById(theirW._id)).name).toBe("SECRET DEPOT");
  });

  test("a search narrows the tenant scope and treats regex input literally", async () => {
    const mine = await company("M2");
    const theirs = await company("T2");
    await warehouse({ co: theirs, code: "FINDA", name: "Findme Depot" });
    await warehouse({ co: mine, code: "FINDB", name: "Findme Store" });
    const me = await person({ co: mine });

    const r = await call("/?search=Findme", { token: me.token, company: mine._id });
    expect(r.body.warehouses).toHaveLength(1);
    expect(r.body.warehouses[0].code).toBe("FINDB");

    /* `.*` must be matched, not executed. */
    const literal = await call("/?search=.%2A", { token: me.token, company: mine._id });
    expect(literal.status).toBe(200);
    expect(literal.body.warehouses).toHaveLength(0);
  });
});

/* ═══ 3 · COMPANY-SCOPED CODE UNIQUENESS ═════════════════════════════════ */

describe("warehouse codes are unique per company, not globally", () => {
  test("two companies may each use the same code", async () => {
    const a = await company("U1");
    const b = await company("U2");
    const pa = await person({ co: a });
    const pb = await person({ co: b });
    await Warehouse.syncIndexes();

    const first = await create(pa.token, a, { name: "Main", code: "MAIN" });
    expect(first.status).toBe(201);
    /* The old global unique index made this impossible. */
    const second = await create(pb.token, b, { name: "Main", code: "MAIN" });
    expect(second.status).toBe(201);
    expect(second.body.warehouse.code).toBe("MAIN");
  });

  test("the same code twice in one company is refused with a stable reason", async () => {
    const co = await company("U3");
    const me = await person({ co });
    expect((await create(me.token, co, { name: "One", code: "DUP" })).status).toBe(201);

    const clash = await create(me.token, co, { name: "Two", code: "DUP" });
    expect(clash.status).toBeGreaterThanOrEqual(400);
    expect(clash.body.error.details.reason).toBe("DUPLICATE_WAREHOUSE_CODE");
    expect(await Warehouse.countDocuments({ companyId: co._id, shortName: "DUP" })).toBe(1);
  });
});

/* ═══ 4 · OWNERSHIP AND LEGACY ═══════════════════════════════════════════ */

describe("ownership is server-owned and legacy records are read-only", () => {
  test("lifecycle and counters in the body are ignored, and ownership is stamped", async () => {
    const mine = await company("O1");
    const me = await person({ co: mine });

    /* A FOREIGN companyId is refused outright — see the tenant-input tests.
       Fields with no governed route are simply never read. */
    const r = await create(me.token, mine, {
      name: "Stamped", code: "STAMP",
      status: "Archived", itemsCount: 9999,
      createdBy: String(new mongoose.Types.ObjectId()),
      structureVersion: 99,
    });
    expect(r.status).toBe(201);

    const saved = await Warehouse.findById(r.body.warehouse._id).lean();
    expect(String(saved.companyId)).toBe(String(mine._id));
    expect(saved.status).toBe("Active");
    expect(saved.itemsCount).toBe(0);
    expect(saved.structureVersion).toBe(0);
  });

  test("legacy unscoped warehouses are excluded ordinarily and never writable", async () => {
    const co = await company("L1");
    const legacy = await warehouse({ co: null, code: "OLD", name: "Legacy Depot" });
    const owner = await person({ co, role: "owner" });

    const normal = await call("/", { token: owner.token, company: co._id });
    expect(JSON.stringify(normal.body)).not.toContain("Legacy Depot");

    const asLegacy = await call("/?scope=legacy", { token: owner.token, company: co._id });
    expect(asLegacy.status).toBe(200);
    expect(JSON.stringify(asLegacy.body)).toContain("Legacy Depot");
    const row = asLegacy.body.warehouses.find((w) => w.code === "OLD");
    expect(row.legacy).toBe(true);

    for (const [path, opts] of [
      [`/${legacy._id}`, { method: "PUT", body: { name: "Adopted" } }],
      [`/${legacy._id}/lifecycle`, { method: "PATCH", body: { action: "archive", reason: "adopt" }, idempotencyKey: newKey() }],
      [`/${legacy._id}/locations`, { method: "POST", body: { code: "X", name: "X", type: "OTHER" } }],
    ]) {
      const r = await call(`${path}${path.includes("?") ? "&" : "?"}scope=legacy`, {
        ...opts, token: owner.token, company: co._id,
      });
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    const after = await Warehouse.findById(legacy._id).lean();
    expect(after.name).toBe("Legacy Depot");
    expect(after.companyId ?? null).toBeNull();
  });
});

/* ═══ 5 · IDEMPOTENCY ════════════════════════════════════════════════════ */

describe("create and lifecycle are safe to retry", () => {
  test("the same key with the same payload creates one warehouse", async () => {
    const co = await company("I1");
    const me = await person({ co });
    const key = newKey();
    const body = { name: "Once", code: "ONCE" };

    const first = await create(me.token, co, body, key);
    expect(first.status).toBe(201);
    const again = await create(me.token, co, body, key);
    expect(again.status).toBeLessThan(300);
    expect(await Warehouse.countDocuments({ companyId: co._id, shortName: "ONCE" })).toBe(1);
  });

  test("the same key with a different payload conflicts", async () => {
    const co = await company("I2");
    const me = await person({ co });
    const key = newKey();
    await create(me.token, co, { name: "First", code: "K1" }, key);
    const changed = await create(me.token, co, { name: "Different", code: "K2" }, key);
    expect(changed.status).toBeGreaterThanOrEqual(400);
    expect(await Warehouse.countDocuments({ companyId: co._id, shortName: "K2" })).toBe(0);
  });

  test("a repeated lifecycle change applies once", async () => {
    const co = await company("I3");
    const me = await person({ co });
    const w = await warehouse({ co });
    const key = newKey();
    const body = { action: "archive", reason: "Site closed", expectedVersion: 0 };

    const first = await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(first.status).toBe(200);
    expect(first.body.warehouse.status).toBe("Archived");

    const again = await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(again.status).toBe(200);
    expect((await Warehouse.findById(w._id)).status).toBe("Archived");
  });
});

/* ═══ 6 · STANDARD LOCATIONS AND THE HIERARCHY ═══════════════════════════ */

describe("locations", () => {
  const mk = async (label) => {
    const co = await company(label);
    const me = await person({ co });
    const r = await create(me.token, co, { name: "Depot", code: `D${++seq}` });
    expect(r.status).toBe(201);
    return { co, me, id: r.body.warehouse._id, warehouse: r.body.warehouse };
  };

  test("a new warehouse receives the standard operational locations exactly once", async () => {
    const { warehouse: w, id, co, me } = await mk("LOC1");
    const codes = w.locations.map((l) => l.code).sort();
    expect(codes).toEqual(["INSP", "QUAR", "RECV", "RETN", "SCRAP", "STOCK"]);
    expect(w.locations.map((l) => l.type)).toEqual(
      expect.arrayContaining(["RECEIVING", "INSPECTION", "USABLE_STOCK", "QUARANTINE", "RETURNS", "SCRAP"]),
    );
    /* Created with the warehouse, so a re-read shows the same six. */
    const again = await call(`/${id}/locations`, { token: me.token, company: co._id });
    expect(again.body.locations).toHaveLength(6);
  });

  test("a duplicate location code is refused", async () => {
    const { co, me, id } = await mk("LOC2");
    const r = await call(`/${id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { code: "RECV", name: "Second receiving", type: "RECEIVING" },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error.details.reason).toBe("DUPLICATE_LOCATION_CODE");
  });

  test("an invalid, foreign, self or cyclic parent is refused", async () => {
    const { co, me, id, warehouse: w } = await mk("LOC3");
    const stock = w.locations.find((l) => l.code === "STOCK");

    /* A rack inside usable stock is fine. */
    const rack = await call(`/${id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { code: "R1", name: "Rack 1", type: "RACK_BIN", parent: stock._id },
    });
    expect(rack.status).toBe(201);
    expect(rack.body.location.parent).toBe(stock._id);

    /* A bin inside the rack. */
    const bin = await call(`/${id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { code: "B1", name: "Bin 1", type: "RACK_BIN", parent: rack.body.location._id },
    });
    expect(bin.status).toBe(201);

    const unknown = await call(`/${id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { code: "R2", name: "Rack 2", type: "RACK_BIN", parent: String(new mongoose.Types.ObjectId()) },
    });
    expect(unknown.body.error.details.reason).toBe("PARENT_NOT_FOUND");

    /* A location from ANOTHER warehouse reads exactly as a missing one. */
    const other = await mk("LOC3b");
    const foreign = await call(`/${id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { code: "R3", name: "Rack 3", type: "RACK_BIN",
        parent: other.warehouse.locations[0]._id },
    });
    expect(foreign.body.error.details.reason).toBe("PARENT_NOT_FOUND");

    const self = await call(`/${id}/locations/${rack.body.location._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(), body: { parent: rack.body.location._id },
    });
    expect(self.body.error.details.reason).toBe("SELF_PARENT");

    /* Rack under its own bin closes a loop. */
    const cycle = await call(`/${id}/locations/${rack.body.location._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(), body: { parent: bin.body.location._id },
    });
    expect(cycle.body.error.details.reason).toBe("HIERARCHY_CYCLE");
  });

  test("a location with active children cannot be archived, and an archived parent takes none", async () => {
    const { co, me, id, warehouse: w } = await mk("LOC4");
    const stock = w.locations.find((l) => l.code === "STOCK");
    const rack = (await call(`/${id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { code: "R1", name: "Rack 1", type: "RACK_BIN", parent: stock._id },
    })).body.location;

    const blocked = await call(`/${id}/locations/${stock._id}/archive`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(), body: { reason: "Reorganising" },
    });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expect(blocked.body.error.details.reason).toBe("LOCATION_HAS_ACTIVE_DESCENDANTS");
    expect(blocked.body.error.details.descendants).toContain("R1");

    /* Archive the child first, then the parent. */
    expect((await call(`/${id}/locations/${rack._id}/archive`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(), body: { reason: "Rack removed" },
    })).status).toBe(200);
    const now = await call(`/${id}/locations/${stock._id}/archive`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(), body: { reason: "Reorganising" },
    });
    expect(now.status).toBe(200);
    expect(now.body.location.status).toBe("Archived");

    /* Nothing can be placed inside an archived location. */
    const under = await call(`/${id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { code: "R9", name: "Rack 9", type: "RACK_BIN", parent: stock._id },
    });
    expect(under.body.error.details.reason).toBe("PARENT_ARCHIVED");

    /* And an archived location itself accepts no edits. */
    const edit = await call(`/${id}/locations/${rack._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(), body: { name: "Renamed" },
    });
    expect(edit.body.error.details.reason).toBe("LOCATION_ARCHIVED");
  });

  test("an archived warehouse accepts no changes at all", async () => {
    const { co, me, id } = await mk("LOC5");
    expect((await call(`/${id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { action: "archive", reason: "Closed", expectedVersion: 0 },
    })).status).toBe(200);

    const rename = await call(`/${id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(), body: { name: "Renamed" },
    });
    expect(rename.body.error.details.reason).toBe("WAREHOUSE_ARCHIVED");

    const addLoc = await call(`/${id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { code: "NEW", name: "New", type: "OTHER" },
    });
    expect(addLoc.body.error.details.reason).toBe("WAREHOUSE_ARCHIVED");
  });
});

/* ═══ 7 · NOTHING IS DESTROYED ═══════════════════════════════════════════ */

describe("deletion", () => {
  test("DELETE refuses and points at the archive action, destroying nothing", async () => {
    const co = await company("D1");
    const me = await person({ co });
    const w = await warehouse({ co });

    const r = await call(`/${w._id}`, { method: "DELETE", token: me.token, company: co._id });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error.details.reason).toBe("DELETE_NOT_SUPPORTED");
    expect(r.body.error.details.useInstead).toMatch(/archive/);
    expect(await Warehouse.countDocuments({ _id: w._id })).toBe(1);

    const loc = w.locations[0];
    const dl = await call(`/${w._id}/locations/${loc._id}`, {
      method: "DELETE", token: me.token, company: co._id,
    });
    expect(dl.status).toBeGreaterThanOrEqual(400);
    expect((await Warehouse.findById(w._id)).locations).toHaveLength(6);
  });
});

/* ═══ 8 · ROUTE ORDER AND HONEST OUTPUT ══════════════════════════════════ */

describe("reference data and honest output", () => {
  test("the static routes are not captured by /:id", async () => {
    const co = await company("R1");
    const me = await person({ co });

    const units = await call("/capacity/units", { token: me.token, company: co._id });
    expect(units.status).toBe(200);
    expect(Array.isArray(units.body.units)).toBe(true);
    /* Each unit says what IT measures — see the dimension test. */
    expect(units.body.units[0]).toHaveProperty("dimension");
    /* The old ordering answered this as a warehouse lookup. */
    expect(units.body.warehouse).toBeUndefined();

    const types = await call("/types/suggestions", { token: me.token, company: co._id });
    expect(types.status).toBe(200);
    expect(types.body.locationTypes.map((t) => t.value)).toEqual(
      expect.arrayContaining(["RECEIVING", "INSPECTION", "USABLE_STOCK", "QUARANTINE", "RETURNS", "SCRAP"]),
    );
    expect(types.body.warehouse).toBeUndefined();

    const avail = await call("/code-available?code=ANY", { token: me.token, company: co._id });
    expect(avail.status).toBe(200);
    expect(avail.body.available).toBe(true);
  });

  test("capacity is floor space and itemsCount is never served as stock", async () => {
    const co = await company("R2");
    const me = await person({ co });
    const w = await warehouse({ co, over: { itemsCount: 4321, capacityDetail: { value: 10000, unit: "sq ft", dimension: "AREA" } } });

    const detail = await call(`/${w._id}`, { token: me.token, company: co._id });
    /* Only a true area unit is floor area. */
    expect(detail.body.warehouse.capacityDetail.dimension).toBe("AREA");
    expect(detail.body.warehouse.capacityDetail.label).toBe("Floor area");
    expect(detail.body.warehouse.legacyItemsCount).toBe(4321);
    /* Named as legacy, never as a live stock figure. */
    expect(detail.body.warehouse.itemsCount).toBeUndefined();
    expect(detail.body.warehouse.capabilities.locationBalances).toBe(false);
    expect(detail.body.warehouse.capabilities.note).toMatch(/not held per location yet/i);

    const list = await call("/", { token: me.token, company: co._id });
    /* The old summary summed itemsCount across warehouses. */
    expect(list.body.summary.totalItems).toBeUndefined();
    expect(list.body.summary.warehouses).toBe(1);
    expect(list.body.summary.note).toMatch(/No stock or utilisation is implied/i);
  });

  test("paging is bounded and ordering deterministic", async () => {
    const co = await company("R3");
    const me = await person({ co });
    for (let i = 0; i < 3; i += 1) await warehouse({ co, name: "Same Name", code: `ORD${i}` });

    const asked = await call("/?limit=9999", { token: me.token, company: co._id });
    expect(asked.body.pagination.limit).toBeLessThanOrEqual(100);

    const p1 = await call("/?limit=2&page=1", { token: me.token, company: co._id });
    const p2 = await call("/?limit=2&page=2", { token: me.token, company: co._id });
    const ids = [...p1.body.warehouses, ...p2.body.warehouses].map((w) => w._id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* ═══ 9 · LEGACY STRING CAPACITY ═════════════════════════════════════════
 *
 * The ORIGINAL schema stored `capacity` as a String. The B3 schema redefined
 * that same path as an object and claimed the old text lived on in
 * `capacityLegacy` — but existing documents have no such field. Their value is
 * still in `capacity`, and the untouched legacy form still POSTs a string
 * there. Redefining a path in place is not additive compatibility.
 * ═════════════════════════════════════════════════════════════════════════ */

/** A warehouse exactly as the original schema wrote it. */
const legacyCapacityWarehouse = async (co, code = "OLDCAP") => {
  const _id = new mongoose.Types.ObjectId();
  await Warehouse.collection.insertOne({
    _id, ...(co ? { companyId: co._id } : {}),
    name: "Legacy Depot", shortName: code,
    capacity: "10000 sq ft",
    status: "Active", itemsCount: 12,
    locations: [], createdAt: new Date(), updatedAt: new Date(),
  });
  return _id;
};

describe("a legacy string capacity", () => {
  test("loads without a cast failure and stays visible", async () => {
    const co = await company("CAP1");
    const me = await person({ co });
    const id = await legacyCapacityWarehouse(co);

    const r = await call(`/${id}`, { token: me.token, company: co._id });
    expect(r.status).toBe(200);
    const w = r.body.warehouse;
    /* The old text must reach the caller somewhere. Dropping it silently is
       what the object-shaped reader did. */
    expect(JSON.stringify(w)).toContain("10000 sq ft");
    expect(w.capacityLegacy).toBe("10000 sq ft");
    /* And it is never parsed into a structured number. */
    expect(w.capacityDetail?.value ?? null).toBeNull();
  });

  test("survives an unrelated update unchanged", async () => {
    const co = await company("CAP2");
    const me = await person({ co });
    const id = await legacyCapacityWarehouse(co, "OLDCAP2");

    const r = await call(`/${id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { name: "Renamed only", expectedVersion: 0 },
    });
    expect(r.status).toBe(200);

    const raw = await Warehouse.collection.findOne({ _id: id });
    expect(raw.name).toBe("Renamed only");
    /* The original string is untouched by an edit that never mentioned it. */
    expect(raw.capacity).toBe("10000 sq ft");
  });

  test("the legacy form's string capacity payload does not destroy the stored text", async () => {
    const co = await company("CAP3");
    const me = await person({ co });
    const id = await legacyCapacityWarehouse(co, "OLDCAP3");

    /* The untouched legacy form sends capacity as a STRING. */
    const r = await call(`/${id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { name: "Depot", capacity: "20000 sq ft" },
    });
    expect(r.status).toBeLessThan(500);

    const raw = await Warehouse.collection.findOne({ _id: id });
    /* Whatever the route does with it, the stored value must remain a
       readable string — never an object whose `value` is null, which is how
       the old measurement disappeared. */
    expect(typeof raw.capacity).toBe("string");
    expect(raw.capacity.length).toBeGreaterThan(0);
  });

  test("structured capacity is not described as floor space when it is not an area", async () => {
    const co = await company("CAP4");
    const me = await person({ co });
    const created = await create(me.token, co, {
      name: "Racked", code: "RACKED",
      capacityDetail: { value: 120, unit: "pallet positions" },
    });
    expect(created.status).toBe(201);
    const cap = created.body.warehouse.capacityDetail;
    expect(cap.value).toBe(120);
    /* "pallet positions" is not an area. Calling it floor space was wrong. */
    expect(cap.dimension).toBe("POSITIONS");
    expect(JSON.stringify(cap)).not.toMatch(/floor space/i);

    const area = await create(me.token, co, {
      name: "Area", code: "AREAWH", capacityDetail: { value: 900, unit: "sq m" },
    });
    expect(area.body.warehouse.capacityDetail.dimension).toBe("AREA");

    /* The only mention of utilisation is the disclaimer denying it. */
    expect(cap.note).toMatch(/not a stock quantity/i);
    expect(cap.note).toMatch(/no utilisation or occupancy is implied/i);
    expect(cap.label).toBe("Storage positions");
    expect(JSON.stringify({ ...created.body.warehouse, capacityDetail: undefined }))
      .not.toMatch(/utilis|utiliz|occupanc/i);
  });
});

/* ═══ 10 · ONE CODE CONTRACT ═════════════════════════════════════════════ */

describe("the code format is enforced on every path", () => {
  /* Lowercase is normalised to uppercase, which is legitimate — it is not in
     this list. These are genuinely malformed. */
  const BAD = ["has space", "with.dot", "A".repeat(20), "-LEAD", "", "  ", "sl/ash", "semi;colon"];

  test("warehouse create and code update both refuse a malformed code", async () => {
    const co = await company("CODE1");
    const me = await person({ co });
    const ok = await create(me.token, co, { name: "Good", code: "GOOD" });
    expect(ok.status).toBe(201);
    /* Lowercase in, canonical uppercase stored. */
    const lower = await create(me.token, co, { name: "Lower", code: "lower" });
    expect(lower.status).toBe(201);
    expect(lower.body.warehouse.code).toBe("LOWER");
    const id = ok.body.warehouse._id;

    for (const bad of BAD) {
      const c = await create(me.token, co, { name: "X", code: bad });
      expect(c.status).toBeGreaterThanOrEqual(400);

      const u = await call(`/${id}`, {
        method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(), body: { code: bad },
      });
      expect(u.status).toBeGreaterThanOrEqual(400);
    }
    /* The stored record is untouched by every refusal. */
    expect((await Warehouse.findById(id)).shortName).toBe("GOOD");
  });

  test("location create and code update both refuse a malformed code", async () => {
    const co = await company("CODE2");
    const me = await person({ co });
    const w = (await create(me.token, co, { name: "Depot", code: "DEP" })).body.warehouse;
    const loc = w.locations.find((l) => l.code === "STOCK");

    for (const bad of BAD) {
      const c = await call(`/${w._id}/locations`, {
        method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
        body: { code: bad, name: "X", type: "OTHER" },
      });
      expect(c.status).toBeGreaterThanOrEqual(400);

      const u = await call(`/${w._id}/locations/${loc._id}`, {
        method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(), body: { code: bad },
      });
      expect(u.status).toBeGreaterThanOrEqual(400);
    }
    const after = await Warehouse.findById(w._id);
    expect(after.locations).toHaveLength(6);
    expect(after.locations.id(loc._id).code).toBe("STOCK");
  });
});

/* ═══ 11 · TENANT INPUT FAILS CLOSED ═════════════════════════════════════ */

describe("forged tenant input is refused, not quietly ignored", () => {
  test("a foreign companyId in the body is a TENANT_MISMATCH", async () => {
    const mine = await company("TI1");
    const theirs = await company("TI2");
    const me = await person({ co: mine });

    const r = await create(me.token, mine, {
      name: "Forged", code: "FORGED", companyId: String(theirs._id),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error.code).toBe("TENANT_MISMATCH");
    expect(await Warehouse.countDocuments({ shortName: "FORGED" })).toBe(0);
  });

  test("an unconfigured site fails closed rather than being dropped", async () => {
    const co = await company("TI3");
    const me = await person({ co });
    const r = await create(me.token, co, {
      name: "Sited", code: "SITED", siteId: String(new mongoose.Types.ObjectId()),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(String(r.body.error.code)).toMatch(/SITE_/);
    expect(await Warehouse.countDocuments({ shortName: "SITED" })).toBe(0);
  });

  test("a redundant same-company id is accepted and still server-stamped", async () => {
    const co = await company("TI4");
    const me = await person({ co });
    const r = await create(me.token, co, {
      name: "Same", code: "SAMECO", companyId: String(co._id),
    });
    expect(r.status).toBe(201);
    const saved = await Warehouse.findById(r.body.warehouse._id).lean();
    expect(String(saved.companyId)).toBe(String(co._id));
  });
});

/* ═══ 12 · ARCHIVE IS TERMINAL ═══════════════════════════════════════════ */

describe("archive is terminal through the ordinary API", () => {
  test("an archived warehouse cannot be activated", async () => {
    const co = await company("AR1");
    const me = await person({ co });
    const w = (await create(me.token, co, { name: "Closing", code: "CLOSE" })).body.warehouse;

    expect((await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { action: "archive", reason: "Site closed", expectedVersion: 0 },
    })).status).toBe(200);

    const revive = await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      /* The archive moved it to version 1. */
      body: { action: "activate", expectedVersion: 1 },
    });
    expect(revive.status).toBeGreaterThanOrEqual(400);
    expect(revive.body.error.details.reason).toBe("ARCHIVE_IS_TERMINAL");
    expect((await Warehouse.findById(w._id)).status).toBe("Archived");
  });

  test("activate applies to an inactive warehouse", async () => {
    const co = await company("AR2");
    const me = await person({ co });
    const w = (await create(me.token, co, { name: "Paused", code: "PAUSE" })).body.warehouse;

    await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { action: "deactivate", expectedVersion: 0 },
    });
    expect((await Warehouse.findById(w._id)).status).toBe("Inactive");

    const on = await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { action: "activate", expectedVersion: 1 },
    });
    expect(on.status).toBe(200);
    expect((await Warehouse.findById(w._id)).status).toBe("Active");
  });
});

/* ═══ 13 · LOCATION WRITES ARE RETRY-SAFE ════════════════════════════════ */

describe("location writes are idempotent", () => {
  const setup = async (label) => {
    const co = await company(label);
    const me = await person({ co });
    const w = (await create(me.token, co, { name: "Depot", code: `DP${++seq}` })).body.warehouse;
    return { co, me, w };
  };

  test("the same key creates one location; a different payload conflicts", async () => {
    const { co, me, w } = await setup("LI1");
    const key = newKey();
    const body = { code: "R1", name: "Rack 1", type: "RACK_BIN" };

    const first = await call(`/${w._id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(first.status).toBe(201);

    const again = await call(`/${w._id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(again.status).toBeLessThan(300);
    const after = await Warehouse.findById(w._id);
    expect(after.locations.filter((l) => l.code === "R1")).toHaveLength(1);

    const changed = await call(`/${w._id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key,
      body: { code: "R2", name: "Rack 2", type: "RACK_BIN" },
    });
    expect(changed.status).toBeGreaterThanOrEqual(400);
    expect((await Warehouse.findById(w._id)).locations.some((l) => l.code === "R2")).toBe(false);
  });

  test("a location archive replays under the same key", async () => {
    const { co, me, w } = await setup("LI2");
    const loc = w.locations.find((l) => l.code === "QUAR");
    const key = newKey();
    const body = { reason: "Not used at this site" };

    const first = await call(`/${w._id}/locations/${loc._id}/archive`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(first.status).toBe(200);
    const again = await call(`/${w._id}/locations/${loc._id}/archive`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(again.status).toBe(200);
    const after = await Warehouse.findById(w._id);
    expect(after.locations.id(loc._id).status).toBe("Archived");
  });
});

/* ═══ 14 · CONCURRENCY ═══════════════════════════════════════════════════ */

describe("embedded location edits are concurrency-safe", () => {
  test("two concurrent renames cannot produce a duplicate code", async () => {
    const co = await company("CC1");
    const me = await person({ co });
    const w = (await create(me.token, co, { name: "Depot", code: `CD${++seq}` })).body.warehouse;
    const a = w.locations.find((l) => l.code === "RECV");
    const b = w.locations.find((l) => l.code === "INSP");

    /* Both rename to the SAME free code from the same snapshot. */
    const [r1, r2] = await Promise.all([
      call(`/${w._id}/locations/${a._id}`, {
        method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(), body: { code: "SAME" },
      }),
      call(`/${w._id}/locations/${b._id}`, {
        method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(), body: { code: "SAME" },
      }),
    ]);

    const after = await Warehouse.findById(w._id);
    const sames = after.locations.filter((l) => l.code === "SAME");
    expect(sames).toHaveLength(1);
    const won = [r1, r2].filter((r) => r.status === 200).length;
    expect(won).toBe(1);
    /* The loser is told to retry, not silently ignored. */
    const lost = [r1, r2].find((r) => r.status !== 200);
    expect(lost.status).toBeGreaterThanOrEqual(400);
  });

  test("a stale structural edit is refused rather than violating the hierarchy", async () => {
    const co = await company("CC2");
    const me = await person({ co });
    const w = (await create(me.token, co, { name: "Depot", code: `CS${++seq}` })).body.warehouse;
    const stock = w.locations.find((l) => l.code === "STOCK");

    const rack = (await call(`/${w._id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { code: "R1", name: "Rack 1", type: "RACK_BIN" },
    })).body.location;

    /* Archive STOCK, then try to reparent under it using the older view. */
    await call(`/${w._id}/locations/${stock._id}/archive`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { reason: "Reorganising" },
    });

    const stale = await call(`/${w._id}/locations/${rack._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(), body: { parent: stock._id },
    });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect(stale.body.error.details.reason).toBe("PARENT_ARCHIVED");
    const after = await Warehouse.findById(w._id);
    expect(after.locations.id(rack._id).parent ?? null).toBeNull();
  });
});

/* ═══ 15 · IMMUTABLE HISTORY ═════════════════════════════════════════════ */

describe("warehouse and location changes are recorded", () => {
  test("history is written once per action and is tenant-scoped", async () => {
    const mine = await company("H1");
    const theirs = await company("H2");
    const me = await person({ co: mine });
    const them = await person({ co: theirs });

    const w = (await create(me.token, mine, { name: "Audited", code: "AUD" })).body.warehouse;
    const key = newKey();
    const body = { action: "deactivate", expectedVersion: 0 };
    await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: mine._id, idempotencyKey: key, body,
    });
    /* A replay must not append a second entry. */
    await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: mine._id, idempotencyKey: key, body,
    });

    const hist = await call(`/${w._id}/history`, { token: me.token, company: mine._id });
    expect(hist.status).toBe(200);
    const actions = hist.body.entries.map((e) => e.action);
    expect(actions).toContain("WAREHOUSE_CREATED");
    expect(actions.filter((a) => a === "WAREHOUSE_DEACTIVATED")).toHaveLength(1);

    /* Another company cannot read it. */
    const foreign = await call(`/${w._id}/history`, { token: them.token, company: theirs._id });
    expect(foreign.status).toBe(404);

    /* Contact and address details are not copied into audit metadata. */
    expect(JSON.stringify(hist.body)).not.toMatch(/@|phone|line1/i);
  });

  test("history needs the history capability", async () => {
    const co = await company("H3");
    const me = await person({ co });
    const w = (await create(me.token, co, { name: "X", code: "HX" })).body.warehouse;
    /* Every Store role in the grant map happens to hold sp.history.read, so
       the gate is demonstrated with someone who holds no Store grant at all.
       The route declares HISTORY_READ; a narrower role would be refused by
       the same middleware. */
    const nobody = await person({ co, grant: null });
    const r = await call(`/${w._id}/history`, { token: nobody.token, company: co._id });
    expect(r.status).toBe(403);
  });
});

/* ═══ 16 · THE INDEX MIGRATION ═══════════════════════════════════════════
 *
 * Planning only — no database, no execution. The script never runs without
 * --apply and never assigns a company to a legacy warehouse.
 * ═════════════════════════════════════════════════════════════════════════ */

describe("the warehouse-code index migration plans safely", () => {
  const {
    findCollisions, planMigration, LEGACY_INDEX, SCOPED_INDEX, ROLLBACK_NOTES,
  } = require("../../scripts/migrations/store-purchase-warehouse-code-index");

  const A = new mongoose.Types.ObjectId();
  const B = new mongoose.Types.ObjectId();

  test("a collision is two records sharing a company AND a code", () => {
    const { collisions, legacy } = findCollisions([
      { _id: "1", companyId: A, shortName: "MAIN" },
      { _id: "2", companyId: B, shortName: "MAIN" },   // different company — fine
      { _id: "3", companyId: A, shortName: "main" },   // same company, same code
      { _id: "4", shortName: "OLD" },                  // legacy-global
    ]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].shortName).toBe("MAIN");
    expect(collisions[0].count).toBe(2);
    expect(legacy).toHaveLength(1);
    /* Legacy records are excluded from the constraint, so they never collide. */
    expect(collisions.some((c) => c.shortName === "OLD")).toBe(false);
  });

  test("a clean collection plans a drop and a create", () => {
    const plan = planMigration({
      indexes: [{ name: "_id_" }, { name: LEGACY_INDEX }],
      rows: [{ _id: "1", companyId: A, shortName: "MAIN" }, { _id: "2", companyId: B, shortName: "MAIN" }],
    });
    expect(plan.safe).toBe(true);
    /* The replacement is created and VERIFIED before the old one is dropped.
       Dropping first leaves the collection with no uniqueness at all if the
       create then fails. */
    expect(plan.steps.map((s) => `${s.action} ${s.index}`)).toEqual([
      `CREATE ${SCOPED_INDEX}`, `VERIFY ${SCOPED_INDEX}`, `DROP ${LEGACY_INDEX}`,
    ]);
    const order = plan.steps.map((s) => s.action);
    expect(order.indexOf("DROP")).toBeGreaterThan(order.indexOf("VERIFY"));
    expect(plan.blockers).toHaveLength(0);
  });

  test("collisions block it, and the report comes before any drop", () => {
    const plan = planMigration({
      indexes: [{ name: LEGACY_INDEX }],
      rows: [
        { _id: "1", companyId: A, shortName: "MAIN" },
        { _id: "2", companyId: A, shortName: "MAIN" },
      ],
    });
    expect(plan.safe).toBe(false);
    expect(plan.blockers[0]).toMatch(/duplicated/i);
    expect(plan.collisions).toHaveLength(1);
  });

  test("legacy warehouses are reported and explicitly not assigned a company", () => {
    const plan = planMigration({
      indexes: [{ name: LEGACY_INDEX }],
      rows: [{ _id: "1", shortName: "OLD" }, { _id: "2", shortName: "OLDER" }],
    });
    expect(plan.safe).toBe(true);
    const notes = plan.notes.join(" ");
    expect(notes).toMatch(/2 warehouses have no companyId/);
    expect(notes).toMatch(/does NOT assign them to a company/i);
  });

  test("an already-migrated collection is idempotent to plan", () => {
    const plan = planMigration({
      indexes: [
        { name: "_id_" },
        /* The COMPLETE definition. A stub carrying only the name is what the
           old check accepted, and is now correctly reported as differing. */
        {
          name: SCOPED_INDEX, key: { companyId: 1, shortName: 1 }, unique: true,
          partialFilterExpression: { companyId: { $type: "objectId" } },
        },
      ],
      rows: [{ _id: "1", companyId: A, shortName: "MAIN" }],
    });
    /* Nothing to create and nothing to drop — only the verification. */
    expect(plan.steps.map((s) => s.action)).toEqual(["VERIFY"]);
    expect(plan.notes.join(" ")).toMatch(/not present — nothing to drop/);
    expect(plan.notes.join(" ")).toMatch(/already exists/);
  });

  test("rollback guidance names the risk rather than promising a clean undo", () => {
    const text = ROLLBACK_NOTES.join(" ");
    expect(text).toMatch(/GLOBAL uniqueness/);
    expect(text).toMatch(/fails if two companies have since/);
  });
});

/* ═══ 17 · FINAL INTEGRITY ═══════════════════════════════════════════════ */

describe("capacity reference data does not label every unit floor space", () => {
  test("each unit carries its own dimension", async () => {
    const co = await company("FI1");
    const me = await person({ co });
    const r = await call("/capacity/units", { token: me.token, company: co._id });
    expect(r.status).toBe(200);

    /* A single `measures: "FLOOR_SPACE"` for a list containing cubic metres
       and pallet positions is wrong about most of its own contents. */
    expect(r.body.measures).toBeUndefined();
    const byUnit = Object.fromEntries((r.body.units || []).map((u) => [u.value ?? u, u.dimension]));
    expect(byUnit["sq ft"]).toBe("AREA");
    expect(byUnit["cubic m"]).toBe("VOLUME");
    expect(byUnit["pallet positions"]).toBe("POSITIONS");
    expect(byUnit["racks"]).toBe("POSITIONS");
    expect(JSON.stringify(r.body)).not.toMatch(/FLOOR_SPACE/);
  });
});

describe("every mutation route validates tenant input and honours its keys", () => {
  const mk = async (label) => {
    const co = await company(label);
    const me = await person({ co });
    const w = (await create(me.token, co, { name: "Depot", code: `FI${++seq}` })).body.warehouse;
    return { co, me, w };
  };

  test("a foreign company on lifecycle, location update and location archive is refused", async () => {
    const { co, me, w } = await mk("FI2");
    const other = await company("FI2b");
    const loc = w.locations.find((l) => l.code === "STOCK");

    const cases = [
      [`/${w._id}/lifecycle`, "PATCH", { action: "deactivate", companyId: String(other._id) }],
      [`/${w._id}/locations/${loc._id}`, "PUT", { name: "Renamed", companyId: String(other._id) }],
      [`/${w._id}/locations/${loc._id}/archive`, "PATCH", { reason: "No longer used", companyId: String(other._id) }],
    ];
    for (const [path, method, body] of cases) {
      const r = await call(path, { method, token: me.token, company: co._id, idempotencyKey: newKey(), body });
      expect(r.body?.error?.code).toBe("TENANT_MISMATCH");
    }
    const after = await Warehouse.findById(w._id);
    expect(after.status).toBe("Active");
    expect(after.locations.id(loc._id).name).toBe("Usable stock");
  });

  test("warehouse update and location update are idempotent, not merely key-tolerant", async () => {
    const { co, me, w } = await mk("FI3");
    const loc = w.locations.find((l) => l.code === "RECV");

    /* The frontend sends a key through the governed writer. A route with no
       idempotency middleware accepts it and does the work twice. */
    const wKey = newKey();
    await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: wKey,
      body: { name: "First", expectedVersion: 0 },
    });
    const conflict = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: wKey,
      body: { name: "Second", expectedVersion: 0 },
    });
    expect(conflict.status).toBeGreaterThanOrEqual(400);
    expect((await Warehouse.findById(w._id)).name).toBe("First");

    const lKey = newKey();
    await call(`/${w._id}/locations/${loc._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: lKey, body: { name: "Goods in" },
    });
    const lConflict = await call(`/${w._id}/locations/${loc._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: lKey, body: { name: "Different" },
    });
    expect(lConflict.status).toBeGreaterThanOrEqual(400);
    expect((await Warehouse.findById(w._id)).locations.id(loc._id).name).toBe("Goods in");
  });
});

describe("location activation is its own action", () => {
  test("it has a dedicated route and records an activation, not a generic update", async () => {
    const co = await company("FI4");
    const me = await person({ co, role: "owner" });
    const w = (await create(me.token, co, { name: "Depot", code: `FI${++seq}` })).body.warehouse;
    const loc = w.locations.find((l) => l.code === "QUAR");

    const off = await call(`/${w._id}/locations/${loc._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { action: "deactivate" },
    });
    expect(off.status).toBe(200);
    expect(off.body.location.status).toBe("Inactive");

    const on = await call(`/${w._id}/locations/${loc._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { action: "activate" },
    });
    expect(on.status).toBe(200);
    expect(on.body.location.status).toBe("Active");

    const hist = await call(`/${w._id}/history`, { token: me.token, company: co._id });
    const actions = hist.body.entries.map((e) => e.action);
    expect(actions).toContain("LOCATION_DEACTIVATED");
    expect(actions).toContain("LOCATION_ACTIVATED");
    /* A status change is not an edit of the location's identity. */
    expect(actions).not.toContain("LOCATION_UPDATED");
  });
});

describe("a failed audit write costs an audit entry, never a second change", () => {
  const mk = async (label) => {
    const co = await company(label);
    const me = await person({ co });
    const r = await create(me.token, co, { name: "Depot", code: `D${++seq}` });
    expect(r.status).toBe(201);
    return { co, me, w: await Warehouse.findById(r.body.warehouse._id) };
  };

  test("the same-key retry recovers instead of repeating the mutation", async () => {
    const co = await company("FI5");
    const me = await person({ co });
    const code = `FI${++seq}`;
    const key = newKey();

    /* The mutation commits and the effect marker is written; the history
       write then fails. The request is refused — the caller is not told an
       unrecorded change succeeded. */
    const spy = jest.spyOn(actionHistoryService, "record").mockRejectedValueOnce(new Error("audit down"));
    const first = await call("/", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key,
      body: { name: "Unaudited", code },
    });
    spy.mockRestore();
    expect(first.status).toBeGreaterThanOrEqual(400);
    expect(first.body.success).not.toBe(true);

    /* Exactly one warehouse exists, and no history describes it yet. */
    const made = await Warehouse.find({ companyId: co._id, shortName: code });
    expect(made).toHaveLength(1);
    expect(await SpActionHistory.countDocuments({ entityId: made[0]._id })).toBe(0);

    /* ── THE POINT ────────────────────────────────────────────────────────
       The retry does NOT create a second warehouse. It finds the effect
       marker, loads the warehouse that marker names, and writes the history
       the first attempt never got to. */
    const retry = await call("/", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key,
      body: { name: "Unaudited", code },
    });
    expect(retry.status).toBe(200);
    expect(retry.body.recovered).toBe(true);
    expect(String(retry.body.warehouse._id)).toBe(String(made[0]._id));

    expect(await Warehouse.countDocuments({ companyId: co._id, shortName: code })).toBe(1);
    expect(await SpActionHistory.countDocuments({
      entityId: made[0]._id, action: "WAREHOUSE_CREATED",
    })).toBe(1);
  });

  test("a recovery that is itself repeated does not append a second history entry", async () => {
    const co = await company("FI5R");
    const me = await person({ co });
    const code = `FI${++seq}`;
    const key = newKey();

    const spy = jest.spyOn(actionHistoryService, "record").mockRejectedValueOnce(new Error("audit down"));
    await call("/", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key,
      body: { name: "Twice recovered", code },
    });
    spy.mockRestore();

    const made = await Warehouse.findOne({ companyId: co._id, shortName: code });

    /* The first retry completes the record. The second replays it. Neither
       may append a second WAREHOUSE_CREATED. */
    for (let i = 0; i < 2; i += 1) {
      await call("/", {
        method: "POST", token: me.token, company: co._id, idempotencyKey: key,
        body: { name: "Twice recovered", code },
      });
    }
    expect(await SpActionHistory.countDocuments({
      entityId: made._id, action: "WAREHOUSE_CREATED",
    })).toBe(1);
  });

  test("a lifecycle change whose audit failed is not replayed as somebody else's interference", async () => {
    const { co, me, w } = await mk("FI5L");
    const key = newKey();

    const spy = jest.spyOn(actionHistoryService, "record").mockRejectedValueOnce(new Error("audit down"));
    await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate", expectedVersion: 0 },
    });
    spy.mockRestore();
    expect((await Warehouse.findById(w._id)).status).toBe("Inactive");

    /* Re-running the compare-and-set would find the status already moved and
       report a LIFECYCLE_CONFLICT — blaming a third party for this caller's
       own successful first attempt. */
    const retry = await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate", expectedVersion: 0 },
    });
    expect(retry.status).toBe(200);
    expect(retry.body.recovered).toBe(true);
    expect(await SpActionHistory.countDocuments({
      entityId: w._id, action: "WAREHOUSE_DEACTIVATED",
    })).toBe(1);
  });

  test("an interrupted location create recovers by the id the key produced, not by code", async () => {
    const { co, me, w } = await mk("FI5C");
    const key = newKey();

    const spy = jest.spyOn(actionHistoryService, "record").mockRejectedValueOnce(new Error("audit down"));
    await call(`/${w._id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key,
      body: { code: "BIN1", name: "Bin 1", type: "RACK_BIN" },
    });
    spy.mockRestore();

    const afterFirst = await Warehouse.findById(w._id);
    const made = afterFirst.locations.find((l) => l.code === "BIN1");
    expect(made).toBeTruthy();

    /* ── THE LOOKALIKE ────────────────────────────────────────────────────
       The location this key created is renamed, and a DIFFERENT location is
       given the code it used to hold. A recovery that matched on code would
       now hand back — and attach this action's history to — the wrong one. */
    await Warehouse.updateOne(
      { _id: w._id, "locations._id": made._id },
      { $set: { "locations.$.code": "BIN1X" } },
    );
    await Warehouse.updateOne({ _id: w._id }, {
      $push: { locations: { code: "BIN1", name: "Impostor", type: "RACK_BIN", status: "Active" } },
    });

    const retry = await call(`/${w._id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key,
      body: { code: "BIN1", name: "Bin 1", type: "RACK_BIN" },
    });
    expect(retry.status).toBe(200);
    expect(String(retry.body.location._id)).toBe(String(made._id));
    expect(retry.body.location.code).toBe("BIN1X");
    expect(retry.body.location.name).not.toBe("Impostor");
  });
});

describe("creation recovery identifies the effect, not a lookalike", () => {
  test("a warehouse with the same code created by another action is not claimed as this one", async () => {
    const co = await company("FI6");
    const me = await person({ co });
    const key = newKey();

    /* An interrupted attempt: the key is marked as having applied an effect,
       but no warehouse was written under it. Another action then creates a
       warehouse with the same code. */
    const other = await create(me.token, co, { name: "Someone else's", code: "CLASH" });
    expect(other.status).toBe(201);

    await SpIdempotencyRecord.create({
      companyId: co._id, operation: "WAREHOUSE_CREATE", key, actorId: me.emp._id,
      requestHash: "x", status: "EFFECT_APPLIED", effectAppliedAt: new Date(),
    });

    const r = await create(me.token, co, { name: "Mine", code: "CLASH" }, key);
    /* Refused — here by the key-reuse check, which sees a different payload
       under a key that already applied an effect. Whichever layer answers,
       the guarantee is the same: matching on the code alone would have handed
       back the OTHER warehouse as though this request had created it. */
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.success).toBe(false);
    expect(String(r.body?.warehouse?._id ?? "")).not.toBe(String(other.body.warehouse._id));
    expect(r.body.warehouse).toBeUndefined();
    /* And the other warehouse is untouched. */
    expect((await Warehouse.findById(other.body.warehouse._id)).name).toBe("Someone else's");
  });

  test("recovery resolves the entity the key itself produced", async () => {
    const co = await company("FI6b");
    const me = await person({ co });
    const key = newKey();
    const body = { name: "Interrupted", code: "RECOV" };

    /* A completed create, then the same key and the SAME payload again. */
    const first = await create(me.token, co, body, key);
    expect(first.status).toBe(201);
    const again = await create(me.token, co, body, key);
    expect(again.status).toBeLessThan(300);
    /* The replay names the warehouse this key produced — not merely one that
       happens to share the code. */
    expect(String(again.body.warehouse._id)).toBe(String(first.body.warehouse._id));
    expect(await Warehouse.countDocuments({ companyId: co._id, shortName: "RECOV" })).toBe(1);
  });
});

describe("warehouse lifecycle is compare-and-set protected", () => {
  test("two concurrent lifecycle changes cannot both apply", async () => {
    const co = await company("FI7");
    const me = await person({ co });
    const w = (await create(me.token, co, { name: "Contested", code: `FI${++seq}` })).body.warehouse;

    const [a, b] = await Promise.all([
      call(`/${w._id}/lifecycle`, {
        method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
        body: { action: "deactivate", expectedVersion: 0 },
      }),
      call(`/${w._id}/lifecycle`, {
        method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
        /* Both composed against version 0 — exactly one may win. */
        body: { action: "archive", reason: "Site closed", expectedVersion: 0 },
      }),
    ]);

    const won = [a, b].filter((r) => r.status === 200).length;
    expect(won).toBe(1);
    const after = await Warehouse.findById(w._id);
    expect(["Inactive", "Archived"]).toContain(after.status);
    /* Whichever lost is told the state moved, not silently overwritten. */
    const lost = [a, b].find((r) => r.status !== 200);
    expect(lost.status).toBeGreaterThanOrEqual(400);
  });
});

describe("history is paged", () => {
  test("it reports its own pagination and reaches later pages", async () => {
    const co = await company("FI8");
    const me = await person({ co, role: "owner" });
    const w = (await create(me.token, co, { name: "Busy", code: `FI${++seq}` })).body.warehouse;
    for (let i = 0; i < 4; i += 1) {
      await call(`/${w._id}`, {
        method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
        body: { description: `note ${i}`, expectedVersion: i },
      });
    }

    const p1 = await call(`/${w._id}/history?limit=2`, { token: me.token, company: co._id });
    expect(p1.status).toBe(200);
    expect(p1.body.entries).toHaveLength(2);
    expect(p1.body.paging.hasMore).toBe(true);
    expect(p1.body.paging.nextCursor).toBeTruthy();

    const p2 = await call(
      `/${w._id}/history?limit=2&cursor=${encodeURIComponent(p1.body.paging.nextCursor)}`,
      { token: me.token, company: co._id },
    );
    expect(p2.status).toBe(200);
    const ids = [...p1.body.entries, ...p2.body.entries].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * FINAL INTEGRITY CORRECTION
 * ═════════════════════════════════════════════════════════════════════════ */

describe("an idempotency key is bound to the record it acts on", () => {
  const mk = async (label) => {
    const co = await company(label);
    const me = await person({ co });
    const a = await create(me.token, co, { name: "A", code: `T${++seq}` });
    const b = await create(me.token, co, { name: "B", code: `T${++seq}` });
    return { co, me, a: a.body.warehouse, b: b.body.warehouse };
  };

  test("the same key and body replays on the same warehouse", async () => {
    const { co, me, a } = await mk("TGT1");
    const key = newKey();
    const first = await call(`/${a._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate", expectedVersion: 0 },
    });
    expect(first.status).toBe(200);

    const again = await call(`/${a._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate", expectedVersion: 0 },
    });
    expect(again.status).toBe(200);
    expect(String(again.body.warehouse._id)).toBe(String(a._id));
  });

  test("the same key and body is refused against a DIFFERENT warehouse", async () => {
    const { co, me, a, b } = await mk("TGT2");
    const key = newKey();

    await call(`/${a._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate" },
    });

    /* ── THE DEFECT THIS PINS ────────────────────────────────────────────
       `{action:"deactivate"}` is byte-identical for both warehouses. Bound
       to the body alone, this replayed A's response — telling the caller B
       was deactivated while B was never touched. */
    const wrong = await call(`/${b._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate" },
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.body?.error?.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await Warehouse.findById(b._id)).status).toBe("Active");
  });

  test("the same key and body is refused against a DIFFERENT location", async () => {
    const { co, me, a } = await mk("TGT3");
    const full = await Warehouse.findById(a._id);
    const one = full.locations.find((l) => l.code === "RECV");
    const two = full.locations.find((l) => l.code === "INSP");
    const key = newKey();

    const first = await call(`/${a._id}/locations/${one._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate" },
    });
    expect(first.status).toBe(200);

    const wrong = await call(`/${a._id}/locations/${two._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate" },
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.body?.error?.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await Warehouse.findById(a._id)).locations.id(two._id).status).toBe("Active");
  });
});

describe("two people editing one warehouse", () => {
  const mk = async (label) => {
    const co = await company(label);
    const me = await person({ co });
    const r = await create(me.token, co, { name: "Shared", code: `V${++seq}` });
    return { co, me, w: r.body.warehouse };
  };

  test("the later edit is refused, not silently applied over the earlier one", async () => {
    const { co, me, w } = await mk("VER1");
    expect(w.version).toBe(0);

    const first = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { name: "Renamed by A", expectedVersion: 0 },
    });
    expect(first.status).toBe(200);
    expect(first.body.warehouse.version).toBe(1);

    /* B composed their edit against version 0, before A saved. */
    const stale = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { name: "Renamed by B", expectedVersion: 0 },
    });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect(stale.body.error.details.reason).toBe("STALE_VERSION");
    expect(stale.body.error.details.currentVersion).toBe(1);
    expect((await Warehouse.findById(w._id)).name).toBe("Renamed by A");
  });

  test("a losing write leaves no history entry and no effect marker", async () => {
    const { co, me, w } = await mk("VER2");
    await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { name: "Winner", expectedVersion: 0 },
    });

    const before = await SpActionHistory.countDocuments({ entityId: w._id, action: "WAREHOUSE_UPDATED" });
    const key = newKey();
    await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: key,
      body: { name: "Loser", expectedVersion: 0 },
    });

    /* ── AN ACTION THAT DID NOT HAPPEN LEAVES NO TRACE ─────────────────── */
    expect(await SpActionHistory.countDocuments({ entityId: w._id, action: "WAREHOUSE_UPDATED" }))
      .toBe(before);
    const record = await SpIdempotencyRecord.findOne({ key });
    expect(record?.status).not.toBe("EFFECT_APPLIED");
    expect(record?.effectAppliedAt ?? null).toBeNull();
  });

  test("an edit that declares no version is refused rather than accepted blind", async () => {
    const { co, me, w } = await mk("VER3");
    const r = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { name: "Blind" },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error.details.reason).toBe("VERSION_REQUIRED");
  });
});

describe("a partial form does not erase what it never mentioned", () => {
  const seeded = async (label) => {
    const co = await company(label);
    const me = await person({ co });
    const r = await create(me.token, co, {
      name: "Full", code: `A${++seq}`,
      addressDetail: {
        line1: "Plot 4", line2: "Phase II", city: "Pune",
        state: "MH", postalCode: "411001", country: "India",
      },
      contactPerson: { name: "Asha", phone: "999", email: "a@x.com" },
    });
    expect(r.status).toBe(201);
    return { co, me, w: r.body.warehouse };
  };

  test("editing one address field leaves the others exactly as stored", async () => {
    const { co, me, w } = await seeded("ADDR1");
    const r = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { addressDetail: { city: "Nashik" }, expectedVersion: 0 },
    });
    expect(r.status).toBe(200);

    const after = r.body.warehouse.addressDetail;
    expect(after.city).toBe("Nashik");
    /* ── THE DEFECT THIS PINS ────────────────────────────────────────────
       Every supported key used to be written on any request that carried an
       addressDetail at all, so this form emptied five stored fields. */
    expect(after.line1).toBe("Plot 4");
    expect(after.line2).toBe("Phase II");
    expect(after.state).toBe("MH");
    expect(after.postalCode).toBe("411001");
    expect(after.country).toBe("India");
  });

  test("an explicit empty string clears that field, and only that field", async () => {
    const { co, me, w } = await seeded("ADDR2");
    const r = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { addressDetail: { line2: "" }, expectedVersion: 0 },
    });
    expect(r.status).toBe(200);
    expect(r.body.warehouse.addressDetail.line2).toBe("");
    expect(r.body.warehouse.addressDetail.line1).toBe("Plot 4");
    expect(r.body.warehouse.addressDetail.city).toBe("Pune");
  });

  test("the same rule applies to the contact person", async () => {
    const { co, me, w } = await seeded("ADDR3");
    const r = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { contactPerson: { phone: "1234" }, expectedVersion: 0 },
    });
    expect(r.status).toBe(200);
    expect(r.body.warehouse.contactPerson.phone).toBe("1234");
    expect(r.body.warehouse.contactPerson.name).toBe("Asha");
    expect(r.body.warehouse.contactPerson.email).toBe("a@x.com");
  });
});

describe("a structured capacity means something or is refused", () => {
  const mk = async (label) => {
    const co = await company(label);
    const me = await person({ co });
    return { co, me };
  };

  const bad = [
    ["a value with no unit", { value: 1000 }, "CAPACITY_UNIT_REQUIRED"],
    ["a unit with no value", { unit: "sq ft" }, "CAPACITY_VALUE_REQUIRED"],
    ["an unsupported unit", { value: 10, unit: "square feet" }, "CAPACITY_UNIT_UNSUPPORTED"],
    ["a negative value", { value: -1, unit: "sq ft" }, "CAPACITY_VALUE_NEGATIVE"],
    ["a numeric string", { value: "12abc", unit: "sq ft" }, "CAPACITY_VALUE_INVALID"],
    ["an exponent string", { value: "1e3", unit: "sq ft" }, "CAPACITY_VALUE_INVALID"],
  ];

  test.each(bad)("%s is refused, not half-stored", async (_label, capacityDetail, reason) => {
    const { co, me } = await mk(`CAPX${++seq}`);
    const r = await create(me.token, co, { name: "Bad", code: `C${++seq}`, capacityDetail });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error.details.reason).toBe(reason);
    expect(await Warehouse.countDocuments({ companyId: co._id })).toBe(0);
  });

  test("a supported unit is stored with the dimension the SERVER derives", async () => {
    const { co, me } = await mk("CAPOK");
    const r = await create(me.token, co, {
      name: "Good", code: `C${++seq}`,
      /* A caller-supplied dimension is ignored: what a unit measures is not
         the caller's opinion. */
      capacityDetail: { value: 240, unit: "pallet positions", dimension: "AREA" },
    });
    expect(r.status).toBe(201);
    expect(r.body.warehouse.capacityDetail).toMatchObject({
      value: 240, unit: "pallet positions", dimension: "POSITIONS",
    });
    expect(r.body.warehouse.capacityDetail.label).toBe("Storage positions");
  });

  test("every unit the form is offered is a unit a write accepts", async () => {
    const { co, me } = await mk("CAPUNITS");
    const list = await call("/capacity/units", { token: me.token, company: co._id });
    expect(list.status).toBe(200);
    expect(list.body.units.length).toBeGreaterThan(0);

    for (const u of list.body.units) {
      const r = await create(me.token, co, {
        name: `In ${u.value}`, code: `C${++seq}`,
        capacityDetail: { value: 5, unit: u.value },
      });
      expect(r.status).toBe(201);
      expect(r.body.warehouse.capacityDetail.dimension).toBe(u.dimension);
    }
  });
});

describe("the location hierarchy stays reachable", () => {
  const tree = async (label) => {
    const co = await company(label);
    const me = await person({ co });
    const w = (await create(me.token, co, { name: "Deep", code: `H${++seq}` })).body.warehouse;
    const add = async (code, name, parent) => {
      const r = await call(`/${w._id}/locations`, {
        method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
        body: { code, name, type: "RACK_BIN", ...(parent ? { parent } : {}) },
      });
      expect(r.status).toBe(201);
      return r.body.location;
    };
    const aisle = await add("AISLE", "Aisle");
    const rack = await add("RACK", "Rack", aisle._id);
    const bin = await add("BIN", "Bin", rack._id);
    return { co, me, w, aisle, rack, bin };
  };

  test("a location two levels down blocks deactivating its grandparent", async () => {
    const { co, me, w, aisle } = await tree("HIER1");
    const r = await call(`/${w._id}/locations/${aisle._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { action: "deactivate" },
    });
    /* ── THE DEFECT THIS PINS ────────────────────────────────────────────
       Only the DIRECT children were checked, so a bin two levels down was
       stranded inside a closed aisle and still shown as active. */
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error.details.reason).toBe("LOCATION_HAS_ACTIVE_DESCENDANTS");
    expect(r.body.error.details.descendants).toEqual(expect.arrayContaining(["RACK", "BIN"]));
  });

  test("a location cannot be activated while an ancestor above it is not", async () => {
    const { co, me, w, aisle, rack, bin } = await tree("HIER2");
    const off = async (id) => call(`/${w._id}/locations/${id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { action: "deactivate" },
    });
    expect((await off(bin._id)).status).toBe(200);
    expect((await off(rack._id)).status).toBe(200);
    expect((await off(aisle._id)).status).toBe(200);

    const r = await call(`/${w._id}/locations/${bin._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { action: "activate" },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error.details.reason).toBe("ANCESTOR_NOT_ACTIVE");
    expect((await Warehouse.findById(w._id)).locations.id(bin._id).status).toBe("Inactive");
  });

  test("archiving refuses a whole live subtree, not just direct children", async () => {
    const { co, me, w, aisle } = await tree("HIER3");
    const r = await call(`/${w._id}/locations/${aisle._id}/archive`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { reason: "Rebuilding the aisle" },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error.details.reason).toBe("LOCATION_HAS_ACTIVE_DESCENDANTS");
  });

  test("nothing can be created inside an inactive parent", async () => {
    const { co, me, w, bin } = await tree("HIER4");
    await call(`/${w._id}/locations/${bin._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { action: "deactivate" },
    });
    const r = await call(`/${w._id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { code: "SUB", name: "Sub", type: "RACK_BIN", parent: bin._id },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error.details.reason).toBe("PARENT_NOT_ACTIVE");
  });

  test("a traversal survives a cycle in stored data instead of hanging", async () => {
    const { co, me, w, aisle, bin } = await tree("HIER5");
    /* Written straight to the collection: `assertParent` refuses to create
       this, but a traversal that trusts that assumption hangs the process if
       old data ever carried one. */
    await Warehouse.updateOne(
      { _id: w._id, "locations._id": aisle._id },
      { $set: { "locations.$.parent": bin._id } },
    );
    const r = await call(`/${w._id}/locations/${bin._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { action: "deactivate" },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
  }, 8000);
});

describe("history paging is stable while history is being written", () => {
  const busy = async (label) => {
    const co = await company(label);
    const me = await person({ co, role: "owner" });
    const w = (await create(me.token, co, { name: "Busy", code: `P${++seq}` })).body.warehouse;
    for (let i = 0; i < 4; i += 1) {
      const r = await call(`/${w._id}`, {
        method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
        body: { description: `note ${i}`, expectedVersion: i },
      });
      expect(r.status).toBe(200);
    }
    return { co, me, w };
  };

  test("an entry written between pages does not push another off the list", async () => {
    const { co, me, w } = await busy("HP1");
    const p1 = await call(`/${w._id}/history?limit=2`, { token: me.token, company: co._id });
    expect(p1.body.entries).toHaveLength(2);

    /* Somebody else acts while the reader is on page 1. With an offset, this
       shifts every later entry down by one and page 2 silently skips one. */
    await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { description: "interleaved", expectedVersion: 4 },
    });

    const seen = [...p1.body.entries.map((e) => e.id)];
    let cursor = p1.body.paging.nextCursor;
    while (cursor) {
      const next = await call(`/${w._id}/history?limit=2&cursor=${encodeURIComponent(cursor)}`,
        { token: me.token, company: co._id });
      seen.push(...next.body.entries.map((e) => e.id));
      cursor = next.body.paging.nextCursor;
    }

    /* Nothing repeated, and every entry that existed when paging began was
       reached — the five from before page 1, plus its own create. */
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(5);
  });

  test("a cursor this screen did not issue is refused, not silently reset to the top", async () => {
    const { co, me, w } = await busy("HP2");
    const r = await call(`/${w._id}/history?cursor=not-a-cursor`, { token: me.token, company: co._id });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error.details.reason).toBe("HISTORY_CURSOR_INVALID");
  });

  test("only allowlisted metadata reaches the screen", async () => {
    const co = await company("HP3");
    const me = await person({ co, role: "owner" });
    const w = (await create(me.token, co, { name: "Meta", code: `P${++seq}` })).body.warehouse;

    await SpActionHistory.create({
      companyId: co._id, actorId: me.emp._id, entityType: "WAREHOUSE", entityId: w._id,
      action: "WAREHOUSE_UPDATED", at: new Date(),
      metadata: { code: "SHOWN", internalActorEmail: "leak@x.com", rawQuery: { $where: "1" } },
    });

    const r = await call(`/${w._id}/history`, { token: me.token, company: co._id });
    expect(r.status).toBe(200);
    const entry = r.body.entries.find((e) => e.metadata?.code === "SHOWN");
    expect(entry).toBeTruthy();
    expect(entry.metadata.internalActorEmail).toBeUndefined();
    expect(entry.metadata.rawQuery).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain("leak@x.com");
  });
});

describe("the migration verifies the index it is about to rely on", () => {
  const {
    planMigration: plan, compareScopedIndex, SCOPED_INDEX: SCOPED, LEGACY_INDEX: LEGACY,
  } = require("../../scripts/migrations/store-purchase-warehouse-code-index");

  /* Fake index documents in the shape `collection.indexes()` returns. */
  const good = {
    name: SCOPED, v: 2, key: { companyId: 1, shortName: 1 }, unique: true,
    partialFilterExpression: { companyId: { $type: "objectId" } },
  };
  const legacy = { name: LEGACY, v: 2, key: { shortName: 1 }, unique: true };
  const dropped = (p) => p.steps.filter((s) => s.action === "DROP").map((s) => s.index);

  test("a correct definition is accepted and the global index is dropped", () => {
    const p = plan({ indexes: [legacy, good], rows: [] });
    expect(compareScopedIndex(good).matches).toBe(true);
    expect(p.safe).toBe(true);
    expect(dropped(p)).toEqual([LEGACY]);
  });

  const wrong = [
    ["the fields are in the wrong order",
      { ...good, key: { shortName: 1, companyId: 1 } }, /different order/],
    ["it is not unique",
      { ...good, unique: false }, /not unique/],
    ["the partial filter is missing",
      { name: SCOPED, key: { companyId: 1, shortName: 1 }, unique: true }, /partialFilterExpression/],
    ["the partial filter is a different one",
      { ...good, partialFilterExpression: { companyId: { $exists: true } } }, /partialFilterExpression/],
    ["it only covers the code",
      { ...good, key: { shortName: 1 } }, /key is/],
  ];

  test.each(wrong)("%s: reported, never dropped, and the run is unsafe", (_label, index, pattern) => {
    /* ── THE DEFECT THIS PINS ──────────────────────────────────────────────
       Verification checked a name and a `unique` flag. Every index below
       passes that check and is not the index the application needs — and the
       global one was dropped on the strength of it. */
    const check = compareScopedIndex(index);
    expect(check.present).toBe(true);
    expect(check.matches).toBe(false);
    expect(check.differences.join("; ")).toMatch(pattern);

    const p = plan({ indexes: [legacy, index], rows: [] });
    expect(p.safe).toBe(false);
    expect(p.blockers.join(" ")).toMatch(/DEFINITION|does not match/i);
    expect(p.steps.some((s) => s.action === "DEFINITION_DIFFERS")).toBe(true);

    /* Never dropped, and never silently rebuilt either. */
    expect(dropped(p)).toEqual([]);
    expect(p.steps.some((s) => s.action === "CREATE")).toBe(false);
  });

  test("a collision blocker also prevents the drop being planned", () => {
    const co = new mongoose.Types.ObjectId();
    const p = plan({
      indexes: [legacy, good],
      rows: [
        { _id: new mongoose.Types.ObjectId(), companyId: co, shortName: "MAIN" },
        { _id: new mongoose.Types.ObjectId(), companyId: co, shortName: "MAIN" },
      ],
    });
    expect(p.safe).toBe(false);
    expect(dropped(p)).toEqual([]);
  });

  test("the executor and the planner share one comparison", () => {
    const src = require("fs").readFileSync(
      require.resolve("../../scripts/migrations/store-purchase-warehouse-code-index"), "utf8",
    );
    /* Once in the planner, once in the VERIFY step. A second, divergent copy
       is how a plan says "safe" while the apply step checks another rule. */
    expect(src.match(/compareScopedIndex\(/g).length).toBeGreaterThanOrEqual(3);
  });
});

describe("the response states the guarantee it actually had", () => {
  const unitOfWork = require("../../services/storePurchase/unitOfWork.service");

  test("every write reports the mode that ran, not an assumed one", async () => {
    const co = await company("MODE1");
    const me = await person({ co });
    const created = await create(me.token, co, { name: "Mode", code: `M${++seq}` });
    expect(created.status).toBe(201);

    /* ── WHAT THIS HARNESS ACTUALLY EXERCISES ──────────────────────────────
       in-memory Mongo is a standalone, so `transactionsAvailable()` is false
       and every write here runs in MARKED mode. The transactional path is NOT
       covered by this suite, and the response says which one ran rather than
       claiming atomicity nothing verified. */
    expect(unitOfWork.transactionMode()).toBe("MARKED");
    expect(created.body.atomicity).toEqual({ mode: "MARKED", degraded: true });

    const w = created.body.warehouse;
    const edited = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { name: "Mode edited", expectedVersion: 0 },
    });
    expect(edited.body.atomicity.mode).toBe("MARKED");

    /* And the history entry records the same thing about itself. */
    const entry = await SpActionHistory.findOne({ entityId: w._id, action: "WAREHOUSE_UPDATED" });
    expect(entry.atomicityDegraded).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * B3 CORRECTNESS PASS
 *
 * Once an effect marker exists, the business mutation has ALREADY happened.
 * From that instant there are exactly two acceptable outcomes: finish the
 * unfinished bookkeeping, or refuse and ask a person to reconcile. Running
 * the mutation again is never one of them, whatever is missing.
 * ═════════════════════════════════════════════════════════════════════════ */

describe("an applied effect is never executed a second time", () => {
  const unitOfWork = require("../../services/storePurchase/unitOfWork.service");

  const mk = async (label) => {
    const co = await company(label);
    const me = await person({ co });
    const r = await create(me.token, co, { name: "Depot", code: `X${++seq}` });
    expect(r.status).toBe(201);
    return { co, me, w: await Warehouse.findById(r.body.warehouse._id) };
  };

  /* The single seam every business mutation in this router passes through.
     If it is not called, nothing was written — which is the whole claim. */
  const watchMutations = () => jest.spyOn(unitOfWork, "run");

  /** Put a record into EFFECT_APPLIED exactly as an interrupted write leaves it. */
  const markApplied = async ({ co, me, operation, key, body, target, entityId, receipt }) => {
    const idem = require("../../services/storePurchase/idempotency.service");
    const claim = await idem.begin({
      ctx: { companyId: co._id, actorId: String(me.emp._id) },
      operation, key, body, target,
    });
    await SpIdempotencyRecord.updateOne({ _id: claim.record._id }, {
      $set: {
        status: "EFFECT_APPLIED",
        effectAppliedAt: new Date(),
        resultEntityType: "WAREHOUSE",
        resultEntityId: entityId,
        ...(receipt !== undefined ? { recoveryReceipt: receipt } : {}),
      },
    });
    return claim.record;
  };

  test("a marker whose warehouse no longer exists refuses instead of creating another", async () => {
    const { co, me, w } = await mk("RC1");
    const key = newKey();
    const body = { name: "Ghost", code: `X${++seq}` };

    await markApplied({
      co, me, operation: "WAREHOUSE_CREATE", key, body,
      entityId: w._id,
      receipt: { v: 2, action: "WAREHOUSE_CREATED", entityType: "WAREHOUSE", entityId: w._id, documentNumber: w.shortName, occurredAt: new Date(), resultingState: "Active" },
    });
    /* The record the marker names is gone — deleted, or never durable. */
    await Warehouse.deleteOne({ _id: w._id });

    const spy = watchMutations();
    const r = await call("/", { method: "POST", token: me.token, company: co._id, idempotencyKey: key, body });

    expect(r.status).toBe(409);
    expect(r.body.error.details.reason).toBe("RECONCILIATION_REQUIRED");
    /* ── THE CLAIM ────────────────────────────────────────────────────────
       Not "it returned an error" — that nothing was written at all. */
    expect(spy).not.toHaveBeenCalled();
    expect(await Warehouse.countDocuments({ companyId: co._id, shortName: body.code })).toBe(0);
    spy.mockRestore();
  });

  test("a marker naming a DIFFERENT warehouse than the URL refuses", async () => {
    const { co, me, w } = await mk("RC2");
    const other = await create(me.token, co, { name: "Other", code: `X${++seq}` });
    const key = newKey();
    const body = { action: "deactivate", expectedVersion: 0 };

    /* The marker was produced against `other`, but the URL names `w`. */
    await markApplied({
      co, me, operation: "WAREHOUSE_LIFECYCLE", key, body,
      target: `warehouse:${w._id}`,
      entityId: other.body.warehouse._id,
      receipt: {
        v: 2, action: "WAREHOUSE_DEACTIVATED", entityType: "WAREHOUSE", entityId: other.body.warehouse._id,
        documentNumber: other.body.warehouse.code, occurredAt: new Date(), previousState: "Active", resultingState: "Inactive",
      },
    });

    const spy = watchMutations();
    const r = await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key, body,
    });

    expect(r.status).toBe(409);
    expect(r.body.error.details.reason).toBe("RECONCILIATION_REQUIRED");
    expect(r.body.error.details.cause).toBe("RECOVERY_TARGET_MISMATCH");
    expect(spy).not.toHaveBeenCalled();
    expect((await Warehouse.findById(w._id)).status).toBe("Active");
    spy.mockRestore();
  });

  test("a marker whose embedded location is gone refuses instead of re-adding it", async () => {
    const { co, me, w } = await mk("RC3");
    const key = newKey();
    const body = { code: "BINX", name: "Bin X", type: "RACK_BIN" };
    const vanished = new mongoose.Types.ObjectId();

    await markApplied({
      co, me, operation: "LOCATION_CREATE", key, body,
      target: `warehouse:${w._id}`,
      entityId: w._id,
      receipt: {
        v: 2, action: "LOCATION_CREATED", entityType: "WAREHOUSE", entityId: w._id,
        subjectType: "LOCATION", subjectId: vanished, subjectCode: "BINX",
        documentNumber: w.shortName, occurredAt: new Date(), resultingState: "Active",
      },
    });

    const spy = watchMutations();
    const r = await call(`/${w._id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key, body,
    });

    expect(r.status).toBe(409);
    expect(r.body.error.details.reason).toBe("RECONCILIATION_REQUIRED");
    expect(spy).not.toHaveBeenCalled();
    const after = await Warehouse.findById(w._id);
    expect(after.locations.some((l) => l.code === "BINX")).toBe(false);
    spy.mockRestore();
  });

  test("a legacy marker with no receipt at all refuses rather than inventing history", async () => {
    const { co, me, w } = await mk("RC4");
    const key = newKey();
    const body = { name: "Renamed", expectedVersion: 0 };

    /* Exactly what an EFFECT_APPLIED record written before receipts existed
       looks like: an entity id and nothing describing the event. */
    await markApplied({
      co, me, operation: "WAREHOUSE_UPDATE", key, body,
      target: `warehouse:${w._id}`, entityId: w._id,
    });

    const spy = watchMutations();
    const r = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: key, body,
    });

    expect(r.status).toBe(409);
    expect(r.body.error.details.reason).toBe("RECONCILIATION_REQUIRED");
    expect(r.body.error.details.cause).toBe("RECOVERY_EVIDENCE_MISSING");
    expect(spy).not.toHaveBeenCalled();
    /* And no history was guessed at. */
    expect(await SpActionHistory.countDocuments({ entityId: w._id, action: "WAREHOUSE_UPDATED" })).toBe(0);
    spy.mockRestore();
  });

  test("a receipt from an unrecognised schema version refuses", async () => {
    const { co, me, w } = await mk("RC5");
    const key = newKey();
    const body = { name: "Future", expectedVersion: 0 };

    await markApplied({
      co, me, operation: "WAREHOUSE_UPDATE", key, body,
      target: `warehouse:${w._id}`, entityId: w._id,
      receipt: { v: 99, action: "WAREHOUSE_UPDATED", entityId: w._id },
    });

    const spy = watchMutations();
    const r = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(r.status).toBe(409);
    expect(r.body.error.details.cause).toBe("RECOVERY_EVIDENCE_MISSING");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("a refused reconciliation does NOT release the key for a blind retry", async () => {
    const { co, me, w } = await mk("RC6");
    const key = newKey();
    const body = { name: "Held", expectedVersion: 0 };

    await markApplied({
      co, me, operation: "WAREHOUSE_UPDATE", key, body,
      target: `warehouse:${w._id}`, entityId: w._id,
    });

    await call(`/${w._id}`, { method: "PUT", token: me.token, company: co._id, idempotencyKey: key, body });

    /* ── WHY THIS MATTERS ─────────────────────────────────────────────────
       The ordinary refusal path releases the claim so the caller may try
       again. Doing that here would hand the next attempt a clean slate and
       let it run the mutation the marker says already happened. */
    const record = await SpIdempotencyRecord.findOne({ key });
    expect(record.status).toBe("EFFECT_APPLIED");
    expect(record.effectAppliedAt).toBeTruthy();

    const again = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(again.status).toBe(409);
  });
});

describe("recovery history describes the original event, not the current record", () => {
  const actionHistoryService2 = require("../../services/storePurchase/actionHistory.service");

  const mk = async (label) => {
    const co = await company(label);
    const me = await person({ co });
    const r = await create(me.token, co, { name: "Depot", code: `Y${++seq}` });
    return { co, me, w: await Warehouse.findById(r.body.warehouse._id) };
  };

  test("an interrupted deactivate records Active → Inactive even after a later archive", async () => {
    const { co, me, w } = await mk("RH1");
    const key = newKey();

    /* The deactivate lands; its history write fails. */
    const spy = jest.spyOn(actionHistoryService2, "record").mockRejectedValueOnce(new Error("audit down"));
    await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate", expectedVersion: 0 },
    });
    spy.mockRestore();
    expect((await Warehouse.findById(w._id)).status).toBe("Inactive");

    /* ── A LEGITIMATE LATER WRITE MOVES THE RECORD ON ────────────────────
       By the time the interrupted request is retried, the warehouse is
       Archived. Reconstructing history from CURRENT state would record the
       earlier deactivate as "… → Archived", which never happened. */
    const archived = await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { action: "archive", reason: "Site closed", expectedVersion: 1 },
    });
    expect(archived.status).toBe(200);

    const retry = await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate", expectedVersion: 0 },
    });
    expect(retry.status).toBe(200);
    expect(retry.body.recovered).toBe(true);

    const entry = await SpActionHistory.findOne({ entityId: w._id, action: "WAREHOUSE_DEACTIVATED" });
    expect(entry).toBeTruthy();
    /* The states the operation ACTUALLY moved between. */
    expect(entry.previousState).toBe("Active");
    expect(entry.resultingState).toBe("Inactive");
  });

  test("an interrupted update records the fields it changed, not the fields of the retry", async () => {
    const { co, me, w } = await mk("RH2");
    const key = newKey();

    const spy = jest.spyOn(actionHistoryService2, "record").mockRejectedValueOnce(new Error("audit down"));
    await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: key,
      body: { name: "Renamed", description: "A note", expectedVersion: 0 },
    });
    spy.mockRestore();

    const retry = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: key,
      body: { name: "Renamed", description: "A note", expectedVersion: 0 },
    });
    expect(retry.status).toBe(200);

    const entry = await SpActionHistory.findOne({ entityId: w._id, action: "WAREHOUSE_UPDATED" });
    expect(entry.metadata.fields).toEqual(expect.arrayContaining(["name", "description"]));
  });

  test("an interrupted archive keeps the reason that was actually given", async () => {
    const { co, me, w } = await mk("RH3");
    const key = newKey();

    const spy = jest.spyOn(actionHistoryService2, "record").mockRejectedValueOnce(new Error("audit down"));
    await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "archive", reason: "Lease ended", expectedVersion: 0 },
    });
    spy.mockRestore();

    await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "archive", reason: "Lease ended", expectedVersion: 0 },
    });

    const entry = await SpActionHistory.findOne({ entityId: w._id, action: "WAREHOUSE_ARCHIVED" });
    expect(entry.reason).toBe("Lease ended");
    expect(entry.previousState).toBe("Active");
    expect(entry.resultingState).toBe("Archived");
  });

  test("the receipt stores only allowlisted facts — never the request body", async () => {
    const { co, me } = await mk("RH4");
    const key = newKey();
    const code = `Y${++seq}`;

    await call("/", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key,
      body: {
        name: "Receipted", code,
        addressDetail: { line1: "Plot 4", city: "Pune", postalCode: "411001" },
        contactPerson: { name: "Asha", phone: "999", email: "a@x.com" },
      },
    });

    const record = await SpIdempotencyRecord.findOne({ key }).lean();
    const receipt = record.recoveryReceipt;
    expect(receipt).toBeTruthy();
    expect(receipt.v).toBe(2);
    expect(receipt.action).toBe("WAREHOUSE_CREATED");
    expect(receipt.documentNumber).toBe(code);

    /* ── NOTHING PERSONAL, NOTHING UNRESTRICTED ─────────────────────────── */
    const asText = JSON.stringify(receipt);
    for (const leak of ["Asha", "a@x.com", "999", "Plot 4", "Pune", "411001"]) {
      expect(asText).not.toContain(leak);
    }
    expect(Object.keys(receipt).sort()).toEqual(expect.not.arrayContaining(["addressDetail", "contactPerson", "body"]));
  });
});

describe("an embedded location's recovery identity survives key re-use", () => {
  test("the same key used by a different actor produces a DIFFERENT location id", async () => {
    const co = await company("LID1");
    const one = await person({ co });
    const two = await person({ co });
    const key = `shared-${++seq}`;

    const a = (await create(one.token, co, { name: "A", code: `Z${++seq}` })).body.warehouse;
    const b = (await create(two.token, co, { name: "B", code: `Z${++seq}` })).body.warehouse;

    const ra = await call(`/${a._id}/locations`, {
      method: "POST", token: one.token, company: co._id, idempotencyKey: key,
      body: { code: "BIN", name: "Bin", type: "RACK_BIN" },
    });
    const rb = await call(`/${b._id}/locations`, {
      method: "POST", token: two.token, company: co._id, idempotencyKey: key,
      body: { code: "BIN", name: "Bin", type: "RACK_BIN" },
    });
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);

    /* ── THE DEFECT THIS PINS ────────────────────────────────────────────
       Hashing the literal key alone made these two locations share an `_id`
       — the same key is legitimately re-usable by another actor. */
    expect(String(ra.body.location._id)).not.toBe(String(rb.body.location._id));
  });

  test("recovery uses the RECORDED location id, not one recomputed from the key", async () => {
    const co = await company("LID2");
    const me = await person({ co });
    const w = (await create(me.token, co, { name: "W", code: `Z${++seq}` })).body.warehouse;
    const key = newKey();
    const ahs = require("../../services/storePurchase/actionHistory.service");

    const spy = jest.spyOn(ahs, "record").mockRejectedValueOnce(new Error("audit down"));
    await call(`/${w._id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key,
      body: { code: "BINR", name: "Bin R", type: "RACK_BIN" },
    });
    spy.mockRestore();

    const made = (await Warehouse.findById(w._id)).locations.find((l) => l.code === "BINR");
    const record = await SpIdempotencyRecord.findOne({ key }).lean();
    expect(String(record.recoveryReceipt.subjectId)).toBe(String(made._id));

    const retry = await call(`/${w._id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key,
      body: { code: "BINR", name: "Bin R", type: "RACK_BIN" },
    });
    expect(retry.status).toBe(200);
    expect(String(retry.body.location._id)).toBe(String(made._id));
  });
});

describe("a recovered response is honest about what it is", () => {
  test("it reports MARKED and degraded, and does not claim to be a stored replay", async () => {
    const co = await company("RA1");
    const me = await person({ co });
    const w = (await create(me.token, co, { name: "W", code: `R${++seq}` })).body.warehouse;
    const key = newKey();
    const ahs = require("../../services/storePurchase/actionHistory.service");

    const spy = jest.spyOn(ahs, "record").mockRejectedValueOnce(new Error("audit down"));
    await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate", expectedVersion: 0 },
    });
    spy.mockRestore();

    const retry = await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate", expectedVersion: 0 },
    });
    expect(retry.status).toBe(200);
    expect(retry.body.atomicity).toEqual({ mode: "MARKED", degraded: true });
    expect(retry.body.recovered).toBe(true);
    /* The original HTTP response was never stored, so it is not called one. */
    expect(retry.body.replayed).toBeUndefined();
  });

  test("a COMPLETED request still replays its stored response unchanged", async () => {
    const co = await company("RA2");
    const me = await person({ co });
    const w = (await create(me.token, co, { name: "W", code: `R${++seq}` })).body.warehouse;
    const key = newKey();

    const first = await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate", expectedVersion: 0 },
    });
    const second = await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate", expectedVersion: 0 },
    });
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(second.body.recovered).toBeUndefined();
  });
});

describe("a warehouse lifecycle action declares the version it was composed against", () => {
  const mk = async (label) => {
    const co = await company(label);
    const me = await person({ co });
    const r = await create(me.token, co, { name: "L", code: `L${++seq}` });
    return { co, me, w: r.body.warehouse };
  };

  test("a stale lifecycle action is refused with the established conflict shape", async () => {
    const { co, me, w } = await mk("LV1");

    /* Somebody edits the warehouse, moving it to version 1. */
    const edit = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { name: "Edited", expectedVersion: 0 },
    });
    expect(edit.status).toBe(200);

    const key = newKey();
    const stale = await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate", expectedVersion: 0 },
    });

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("CONFLICT");
    expect(stale.body.error.details.reason).toBe("STALE_VERSION");
    expect(stale.body.error.details.currentVersion).toBe(1);

    /* No mutation, no marker, no history. */
    expect((await Warehouse.findById(w._id)).status).toBe("Active");
    const record = await SpIdempotencyRecord.findOne({ key });
    expect(record?.status).not.toBe("EFFECT_APPLIED");
    expect(await SpActionHistory.countDocuments({
      entityId: w._id, action: "WAREHOUSE_DEACTIVATED",
    })).toBe(0);
  });

  test("a lifecycle action that declares no version is refused", async () => {
    const { co, me, w } = await mk("LV2");
    const r = await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { action: "deactivate" },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error.details.reason).toBe("VERSION_REQUIRED");
  });

  test("warehouse-field concurrency stays independent of location structure", async () => {
    const { co, me, w } = await mk("LV3");

    /* Adding a location moves structureVersion, NOT recordVersion — an edit
       composed before it is still valid. */
    const added = await call(`/${w._id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { code: "NEW", name: "New", type: "RACK_BIN" },
    });
    expect(added.status).toBe(201);
    expect(added.body.warehouse.structureVersion).toBeGreaterThan(w.structureVersion);
    expect(added.body.warehouse.version).toBe(w.version);

    const edit = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { name: "Still valid", expectedVersion: w.version },
    });
    expect(edit.status).toBe(200);
  });
});

describe("history keeps a location distinguishable without exposing internals", () => {
  test("the stable location id is published; unrestricted metadata is not", async () => {
    const co = await company("HL1");
    const me = await person({ co, role: "owner" });
    const w = (await create(me.token, co, { name: "H", code: `H${++seq}` })).body.warehouse;

    const made = await call(`/${w._id}/locations`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { code: "AISLE", name: "Aisle", type: "RACK_BIN" },
    });
    expect(made.status).toBe(201);
    const locationId = String(made.body.location._id);

    /* The code is renamed and handed to a different location — only the id
       still tells the two apart in the trail. */
    await call(`/${w._id}/locations/${locationId}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { code: "AISLE1" },
    });

    const hist = await call(`/${w._id}/history`, { token: me.token, company: co._id });
    const created = hist.body.entries.find((e) => e.action === "LOCATION_CREATED");
    expect(created.metadata.locationId).toBe(locationId);

    /* And nothing unrestricted rides along. */
    expect(created.metadata.recoveryReceipt).toBeUndefined();
    expect(created.metadata.parent).toBeUndefined();
  });
});

describe("a nested text field refuses a value that is not text", () => {
  const mk = async (label) => {
    const co = await company(label);
    const me = await person({ co });
    const r = await create(me.token, co, {
      name: "N", code: `N${++seq}`,
      addressDetail: { line1: "Plot 4", city: "Pune" },
    });
    return { co, me, w: r.body.warehouse };
  };

  const bad = [
    ["an array", { addressDetail: { city: ["Pune"] } }],
    ["an object", { addressDetail: { city: { name: "Pune" } } }],
    ["a boolean", { addressDetail: { city: true } }],
    ["a number", { addressDetail: { city: 411001 } }],
  ];

  test.each(bad)("%s is refused, not silently stored as empty", async (_label, patch) => {
    const { co, me, w } = await mk(`NS${++seq}`);
    const r = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { ...patch, expectedVersion: 0 },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error.details.reason).toBe("NESTED_FIELD_TYPE");
    /* ── THE DEFECT THIS PINS ──────────────────────────────────────────────
       `text()` turned each of these into "", so a malformed payload silently
       ERASED a stored city and reported success. */
    expect((await Warehouse.findById(w._id)).addressDetail.city).toBe("Pune");
  });

  test("the documented clearing contract still works", async () => {
    const { co, me, w } = await mk("NS-CLEAR");
    const r = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { addressDetail: { city: "" }, expectedVersion: 0 },
    });
    expect(r.status).toBe(200);
    expect(r.body.warehouse.addressDetail.city).toBe("");
    expect(r.body.warehouse.addressDetail.line1).toBe("Plot 4");
  });

  test("null clears too, and says so in the same contract", async () => {
    const { co, me, w } = await mk("NS-NULL");
    const r = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { addressDetail: { city: null }, expectedVersion: 0 },
    });
    expect(r.status).toBe(200);
    expect(r.body.warehouse.addressDetail.city).toBe("");
  });
});

describe("no recovery branch can fall through to a mutation", () => {
  const fs = require("fs");
  const SRC = fs.readFileSync(
    require.resolve("../../routes/CMS_Routes/Inventory/Configurations/warehouses"), "utf8",
  );

  test("every EFFECT_APPLIED branch ends in recovery or refusal, with no other path", () => {
    const opener = "if (req.idempotent?.recovering) {";
    const branches = [];
    let at = SRC.indexOf(opener);
    while (at !== -1) {
      /* Take the block by brace balance, so a nested object cannot fool it. */
      let depth = 0, i = SRC.indexOf("{", at), end = i;
      do {
        if (SRC[end] === "{") depth += 1;
        else if (SRC[end] === "}") depth -= 1;
        end += 1;
      } while (depth > 0 && end < SRC.length);
      branches.push(SRC.slice(i + 1, end - 1));
      at = SRC.indexOf(opener, end);
    }

    /* Seven writes, seven branches. */
    expect(branches).toHaveLength(7);

    for (const body of branches) {
      /* Block comments removed whole — a line-by-line filter leaves the
         continuation lines of a multi-line comment behind. */
      const code = body
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .split("\n").filter((l) => l.trim() !== "").join("\n").trim();
      /* ── THE STRUCTURAL CLAIM ─────────────────────────────────────────
         The branch is exactly one unconditional `return`. There is no
         `if (done)`, no fall-through, and nothing after it — so no marker
         can be followed by ordinary execution. */
      expect(code.startsWith("return await recoverOrRefuse(req, {")).toBe(true);
      expect(code.endsWith("});")).toBe(true);
      expect(code).not.toMatch(/\bif\b/);
      expect(code).not.toMatch(/return\s+null/);
    }
  });

  test("the evidence check has no path that returns a carry-on value", () => {
    const start = SRC.indexOf("async function requireRecoveryEvidence(");
    const end = SRC.indexOf("\n}\n", start);
    const body = SRC.slice(start, end);
    /* Its only non-throwing exit hands back the three resolved records. */
    const returns = body.match(/^\s*return .*/gm) || [];
    expect(returns).toHaveLength(1);
    expect(returns[0]).toMatch(/return \{ receipt, warehouse, location \};/);
    /* And every refusal goes through the one structured shape. */
    expect((body.match(/throw reconcile\(/g) || []).length).toBeGreaterThanOrEqual(7);
  });

  test("the superseded fall-through helpers are gone, not merely unused", () => {
    for (const dead of ["recoverExact", "recoverLocationExact", "locationIdForKey", "recoverWrite"]) {
      expect(SRC).not.toContain(dead);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * FINAL RECOVERY-CONTRACT CORRECTION (defects 3, 4, 6, 7)
 * ═════════════════════════════════════════════════════════════════════════ */

describe("recovery preserves the original event, not the moment of repair", () => {
  const actionHistory2 = require("../../services/storePurchase/actionHistory.service");

  const mk = async (label) => {
    const co = await company(label);
    const me = await person({ co });
    const r = await create(me.token, co, { name: "Depot", code: `TT${++seq}` });
    return { co, me, w: await Warehouse.findById(r.body.warehouse._id) };
  };

  test("recovery long after the event keeps the mutation's own time, not now (defect 3)", async () => {
    const { co, me, w } = await mk("TS1");
    const key = newKey();

    const spy = jest.spyOn(actionHistory2, "record").mockRejectedValueOnce(new Error("audit down"));
    await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate", expectedVersion: 0 },
    });
    spy.mockRestore();

    /* Backdate the stored receipt to simulate a recovery that happens much
       later. If recovery stamps `new Date()`, the entry will read "now"; if it
       honours the receipt, it reads the backdated time. */
    const past = new Date("2020-01-02T03:04:05.000Z");
    await SpIdempotencyRecord.updateOne({ key }, { $set: { "recoveryReceipt.occurredAt": past } });

    const retry = await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate", expectedVersion: 0 },
    });
    expect(retry.status).toBe(200);
    expect(retry.body.recovered).toBe(true);

    const entry = await SpActionHistory.findOne({ entityId: w._id, action: "WAREHOUSE_DEACTIVATED" });
    expect(new Date(entry.at).toISOString()).toBe(past.toISOString());
  });

  test("the original and recovered entries share one event time (defect 3)", async () => {
    const { co, me, w } = await mk("TS2");
    const key = newKey();

    /* A clean run writes both the marker (with occurredAt) and history. */
    await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate", expectedVersion: 0 },
    });
    const rec = await SpIdempotencyRecord.findOne({ key }).lean();
    const original = await SpActionHistory.findOne({ entityId: w._id, action: "WAREHOUSE_DEACTIVATED" });
    expect(new Date(original.at).toISOString()).toBe(new Date(rec.recoveryReceipt.occurredAt).toISOString());
  });

  test("a receipt without a valid event time fails reconciliation, never inventing one (defect 3)", async () => {
    const { co, me, w } = await mk("TS3");
    const key = newKey();
    const idem = require("../../services/storePurchase/idempotency.service");
    const putBody = { name: "X", expectedVersion: 0 };
    const claim = await idem.begin({
      ctx: { companyId: co._id, actorId: String(me.emp._id) },
      operation: "WAREHOUSE_UPDATE", key, body: putBody, target: `warehouse:${w._id}`,
    });
    /* A marker with a receipt that has every field but the time. */
    await SpIdempotencyRecord.updateOne({ _id: claim.record._id }, {
      $set: {
        status: "EFFECT_APPLIED", effectAppliedAt: new Date(),
        resultEntityType: "WAREHOUSE", resultEntityId: w._id,
        recoveryReceipt: {
          v: 2, action: "WAREHOUSE_UPDATED", entityType: "WAREHOUSE",
          entityId: w._id, documentNumber: w.shortName,
          /* occurredAt deliberately absent */
        },
      },
    });

    const unitOfWork = require("../../services/storePurchase/unitOfWork.service");
    const spy = jest.spyOn(unitOfWork, "run");
    const r = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: key, body: putBody,
    });
    expect(r.status).toBe(409);
    expect(r.body.error.details.reason).toBe("RECONCILIATION_REQUIRED");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("a reason recorded in original history survives recovery, not only for archive (defect 4)", async () => {
    const { co, me, w } = await mk("RS1");
    const key = newKey();

    const spy = jest.spyOn(actionHistory2, "record").mockRejectedValueOnce(new Error("audit down"));
    await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      /* A deactivate WITH a reason. The original history entry records it. */
      body: { action: "deactivate", reason: "Seasonal closure", expectedVersion: 0 },
    });
    spy.mockRestore();

    const retry = await call(`/${w._id}/lifecycle`, {
      method: "PATCH", token: me.token, company: co._id, idempotencyKey: key,
      body: { action: "deactivate", reason: "Seasonal closure", expectedVersion: 0 },
    });
    expect(retry.status).toBe(200);

    const entry = await SpActionHistory.findOne({ entityId: w._id, action: "WAREHOUSE_DEACTIVATED" });
    /* ── THE DEFECT THIS PINS ──────────────────────────────────────────────
       The receipt kept `reason` only for archive, so a recovered deactivate
       lost a reason the first attempt had already written. */
    expect(entry.reason).toBe("Seasonal closure");
  });
});

describe("recovery proves marker identity completely (defect 6)", () => {
  const unitOfWork = require("../../services/storePurchase/unitOfWork.service");
  const idem = require("../../services/storePurchase/idempotency.service");

  const mk = async (label) => {
    const co = await company(label);
    const me = await person({ co });
    const r = await create(me.token, co, { name: "Depot", code: `MI${++seq}` });
    return { co, me, w: await Warehouse.findById(r.body.warehouse._id) };
  };

  const markApplied = async ({ co, me, operation, key, target, resultEntityType, receipt, body = {} }) => {
    const claim = await idem.begin({
      ctx: { companyId: co._id, actorId: String(me.emp._id) },
      operation, key, body, target,
    });
    await SpIdempotencyRecord.updateOne({ _id: claim.record._id }, {
      $set: {
        status: "EFFECT_APPLIED", effectAppliedAt: new Date(),
        resultEntityType, resultEntityId: receipt.entityId,
        recoveryReceipt: receipt,
      },
    });
  };

  const okReceipt = (w, over = {}) => ({
    v: 2, action: "WAREHOUSE_UPDATED", entityType: "WAREHOUSE",
    entityId: w._id, documentNumber: w.shortName, occurredAt: new Date(),
    resultingState: "Active", ...over,
  });

  test("a marker whose recorded entity TYPE disagrees with the receipt refuses", async () => {
    const { co, me, w } = await mk("MI1");
    const key = newKey();
    const body = { name: "X", expectedVersion: 0 };
    await markApplied({
      co, me, operation: "WAREHOUSE_UPDATE", key, target: `warehouse:${w._id}`, body,
      resultEntityType: "SUPPLIER", // marker says SUPPLIER
      receipt: okReceipt(w),        // receipt says WAREHOUSE
    });
    const spy = jest.spyOn(unitOfWork, "run");
    const r = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(r.status).toBe(409);
    expect(r.body.error.details.reason).toBe("RECONCILIATION_REQUIRED");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("a receipt whose entity TYPE is not this route's refuses", async () => {
    const { co, me, w } = await mk("MI2");
    const key = newKey();
    const body = { name: "X", expectedVersion: 0 };
    await markApplied({
      co, me, operation: "WAREHOUSE_UPDATE", key, target: `warehouse:${w._id}`, body,
      resultEntityType: "SUPPLIER",
      receipt: okReceipt(w, { entityType: "SUPPLIER" }), // both agree, but wrong domain
    });
    const spy = jest.spyOn(unitOfWork, "run");
    const r = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(r.status).toBe(409);
    expect(r.body.error.details.cause).toBe("RECOVERY_ENTITY_TYPE_MISMATCH");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("a subject-id that disagrees with the URL location refuses", async () => {
    const { co, me, w } = await mk("MI3");
    const loc = w.locations.find((l) => l.code === "RECV");
    const other = w.locations.find((l) => l.code === "INSP");
    const key = newKey();
    const body = { name: "X" };
    await markApplied({
      co, me, operation: "LOCATION_UPDATE", key,
      target: `warehouse:${w._id}/location:${loc._id}`, body,
      resultEntityType: "WAREHOUSE",
      receipt: okReceipt(w, {
        action: "LOCATION_UPDATED", subjectType: "LOCATION",
        subjectId: other._id, subjectCode: other.code,
      }),
    });
    const spy = jest.spyOn(unitOfWork, "run");
    const r = await call(`/${w._id}/locations/${loc._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(r.status).toBe(409);
    expect(r.body.error.details.reason).toBe("RECONCILIATION_REQUIRED");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("action-mismatch guidance is consistent (defect 7)", () => {
  const idem = require("../../services/storePurchase/idempotency.service");

  test("it does not say 'start the action again' while also warning not to resend", async () => {
    const co = await company("AM1");
    const me = await person({ co });
    const w = (await create(me.token, co, { name: "W", code: `AM${++seq}` })).body.warehouse;
    const key = newKey();
    const body = { name: "X", expectedVersion: 0 };
    const claim = await idem.begin({
      ctx: { companyId: co._id, actorId: String(me.emp._id) },
      operation: "WAREHOUSE_UPDATE", key, body, target: `warehouse:${w._id}`,
    });
    await SpIdempotencyRecord.updateOne({ _id: claim.record._id }, {
      $set: {
        status: "EFFECT_APPLIED", effectAppliedAt: new Date(),
        resultEntityType: "WAREHOUSE", resultEntityId: w._id,
        recoveryReceipt: {
          v: 2, action: "WAREHOUSE_ARCHIVED", entityType: "WAREHOUSE",
          entityId: w._id, documentNumber: w.shortName, occurredAt: new Date(),
          previousState: "Active", resultingState: "Archived",
        },
      },
    });

    const r = await call(`/${w._id}`, {
      method: "PUT", token: me.token, company: co._id, idempotencyKey: key, body,
    });
    expect(r.status).toBe(409);
    expect(r.body.error.details.cause).toBe("RECOVERY_ACTION_MISMATCH");
    const said = JSON.stringify(r.body.error);
    expect(said).not.toMatch(/start the action again/i);
    expect(said).toMatch(/inspect|reconcile|resolve/i);
  });
});
