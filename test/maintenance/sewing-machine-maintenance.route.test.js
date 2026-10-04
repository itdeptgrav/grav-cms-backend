// test/maintenance/sewing-machine-maintenance.route.test.js
//
// THE MAINTENANCE APP'S SEWING MACHINES — the router mounted as server.js
// mounts it, against an in-memory database. Pinned, rule by rule:
//
//   · only the register's sewing machines are listed, and nothing creates one;
//   · a tag is issued once per machine, is the same on every later ask (also
//     when asked five times at once), and is unique across machines at the
//     database;
//   · a scan is a read: a hundred scans answer one machine and write nothing;
//     an unknown or foreign label is "Sewing Machine Not Found", never a guess;
//   · issuing, scanning and opening a machine write no maintenance order;
//   · the first version's reports stay unchangeable at the model;
//   · with no storage set up, an order is refused and creates no collection,
//     while barcodes still work; a cold start answers "ready" to every caller;
//   (orders themselves: maintenance-orders.route.test.js)
//   · who may: no session 401, another department 403, a viewer reads but
//     cannot write, an editor writes; before any grant, only a Maintenance
//     session is admitted.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const Machine = require("../../models/CMS_Models/Inventory/Configurations/Machine");
const MachineMaintenanceRecord = require("../../models/CMS_Models/Maintenance/MachineMaintenanceRecord");
const MaintenanceOrder = require("../../models/CMS_Models/Maintenance/MaintenanceOrder");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const storage = require("../../services/maintenance/maintenanceStorage");

let http, base, seq = 0;
const ROOT = "/api/cms/maintenance";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms", EmployeeAuthMiddleware, (req, res, next) => next());
  app.use(ROOT, require("../../routes/CMS_Routes/Maintenance/maintenanceRoutes"));
  await new Promise((r) => { http = app.listen(0, r); });
  base = `http://127.0.0.1:${http.address().port}${ROOT}`;
});
afterAll(async () => { await new Promise((r) => http.close(r)); });

beforeEach(async () => {
  storage.resetStorageCache();
  await storage.ensureOrderStorage({ create: true });
});

const call = (path, { token, method = "GET", body } = {}) => fetch(`${base}${path}`, {
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function person({ dept = "maintenance", grant = null, name = "Maint" } = {}) {
  const n = ++seq;
  const email = `mnt${n}-${Date.now()}@grav.test`;
  const emp = await Employee.create({ firstName: name, lastName: `M${n}`, email, biometricId: `MNT${n}${Date.now()}`,
    isActive: true, gender: "Other", department: "Maintenance", designation: "Technician" });
  if (grant) {
    await DepartmentRole.create({ departmentSlug: "maintenance", email, name, role: grant, isActive: true,
      departmentId: new mongoose.Types.ObjectId() });
  }
  return {
    emp, email, fullName: `${name} M${n}`,
    token: jwt.sign({ id: String(emp._id), email, name: `${name} M${n}`, role: dept, deptSlug: dept, employeeId: emp.biometricId },
      process.env.JWT_SECRET, { expiresIn: "10m" }),
  };
}

let machineSeq = 0;
function machine(type, name, extra = {}) {
  machineSeq += 1;
  return Machine.create({
    name, type, model: "DDL-8700", serialNumber: `TST-2026-${String(machineSeq).padStart(3, "0")}`,
    powerConsumption: "750W", location: "Sewing Section A",
    lastMaintenance: new Date("2026-09-01"), nextMaintenance: new Date("2026-12-01"),
    createdBy: new mongoose.Types.ObjectId(), ...extra,
  });
}

const machineCount = () => Machine.countDocuments();
const orderCount = () => mongoose.connection.db.collection("maintenance_orders").countDocuments();
const key = () => `form-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe("the Machine model is undisturbed", () => {
  test("it still builds every index it declares, the register's own included", async () => {
    /* A frozen index-options object once made this throw for every Machine
       consumer — mongoose writes `background` into the options it is given. */
    await Machine.init();
    await expect(Machine.ensureIndexes()).resolves.toBeUndefined();
    await expect(MachineMaintenanceRecord.ensureIndexes()).resolves.toBeUndefined();
    await expect(MaintenanceOrder.ensureIndexes()).resolves.toBeUndefined();
    const names = (await Machine.collection.indexes()).map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(["serialNumber_1", "maintenanceTag_code_unique"]));
  });
});

describe("who may use it", () => {
  test("no session is 401; another department is 403", async () => {
    await person({ grant: "editor" });
    const outsider = await person({ dept: "store", name: "Store" });
    expect((await call("/sewing-machines")).status).toBe(401);
    const r = await call("/sewing-machines", { token: outsider.token });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("NO_DEPARTMENT_ROLE");
  });

  test("a viewer reads and cannot issue a tag or raise an order", async () => {
    await person({ grant: "editor" });
    const viewer = await person({ grant: "viewer", name: "View" });
    const m = await machine("SNLS", "SNLS-01");
    const list = await call("/sewing-machines", { token: viewer.token });
    expect(list.status).toBe(200);
    expect(list.body.access).toEqual({ role: "viewer", canWrite: false, canConfigure: false });
    expect((await call(`/sewing-machines/${m._id}/tag`, { token: viewer.token, method: "POST" })).status).toBe(403);
    expect((await call("/orders", { token: viewer.token, method: "POST", body: { orderType: "service",
      subject: { kind: "machine", id: String(m._id) }, problem: "Thread keeps breaking", idempotencyKey: key() } })).status).toBe(403);
  });

  test("before any grant exists, only a Maintenance session is admitted", async () => {
    expect(await DepartmentRole.countDocuments({ departmentSlug: "maintenance" })).toBe(0);
    const mine = await person();
    const store = await person({ dept: "store", name: "Store" });
    const ok = await call("/sewing-machines", { token: mine.token });
    expect(ok.status).toBe(200);
    expect(ok.body.access).toEqual({ role: "migration", canWrite: true, canConfigure: false });
    expect((await call("/sewing-machines", { token: store.token })).status).toBe(403);
  });
});

describe("the sewing machines", () => {
  test("lists only sewing machines, in natural order, and creates none", async () => {
    const editor = await person({ grant: "editor" });
    await machine("SNLS", "SNLS-10");
    await machine("SNLS", "SNLS-2");
    await machine("KANSAI", "KANSAI-1");
    await machine("EMBROIDERY", "EMB-1");
    await machine("SNAP BUTTON", "SNAP-1");
    await machine("IRONER", "IRON-1");
    await machine("F/M", "FUSING_MACHINE_1");
    await machine("TABLE", "TABLE-1");
    const before = await machineCount();
    const r = await call("/sewing-machines", { token: editor.token });
    expect(r.status).toBe(200);
    expect(r.body.machines.map((m) => m.name)).toEqual(["EMB-1", "KANSAI-1", "SNAP-1", "SNLS-2", "SNLS-10"]);
    expect(r.body.counts).toMatchObject({ sewing: 5, shown: 5, tagged: 0, openOrders: 0 });
    expect(r.body.machines[0]).toMatchObject({ machineId: expect.stringMatching(/^TST-2026-/), tag: null, isSewing: true });
    expect(await machineCount()).toBe(before);
  });

  test("search narrows by name, machine id, type or location", async () => {
    const editor = await person({ grant: "editor" });
    await machine("SNLS", "SNLS-01", { location: "Sewing Section B" });
    await machine("KANSAI", "KANSAI-1");
    expect((await call("/sewing-machines?search=kansai", { token: editor.token })).body.machines).toHaveLength(1);
    expect((await call("/sewing-machines?search=section%20b", { token: editor.token })).body.machines[0].name).toBe("SNLS-01");
  });

  test("a machine that is not a sewing machine, or does not exist, is not found", async () => {
    const editor = await person({ grant: "editor" });
    const iron = await machine("IRONER", "IRON-1");
    for (const id of [iron._id, new mongoose.Types.ObjectId(), "not-an-id"]) {
      const r = await call(`/subjects/machine/${id}`, { token: editor.token });
      expect(r.status).toBe(404);
      expect(r.body.message).toBe("Machine or Product Not Found");
    }
    expect((await call(`/sewing-machines/${iron._id}/tag`, { token: editor.token, method: "POST" })).status).toBe(404);
    expect(await Machine.findById(iron._id).select("+maintenanceTag").lean()).not.toHaveProperty("maintenanceTag");
  });
});

describe("the tag", () => {
  test("is issued once, and every later ask returns the same tag", async () => {
    const editor = await person({ grant: "editor" });
    const m = await machine("SNLS", "SNLS-01");
    const before = await Machine.findById(m._id).lean();
    const count = await machineCount();

    const first = await call(`/sewing-machines/${m._id}/tag`, { token: editor.token, method: "POST" });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    expect(first.body.tag.code).toMatch(/^MCH-[A-HJ-NP-Z2-9]{8}$/);
    expect(first.body.tag.issuedBy).toBe(editor.fullName);

    for (let i = 0; i < 3; i += 1) {
      const again = await call(`/sewing-machines/${m._id}/tag`, { token: editor.token, method: "POST" });
      expect(again.status).toBe(200);
      expect(again.body.created).toBe(false);
      expect(again.body.tag.code).toBe(first.body.tag.code);
    }

    const after = await Machine.findById(m._id).select("+maintenanceTag").lean();
    expect(after.maintenanceTag.code).toBe(first.body.tag.code);
    /* The register's own fields, and its updatedAt, are untouched. */
    for (const f of ["name", "type", "serialNumber", "status", "location", "model"]) expect(after[f]).toEqual(before[f]);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(await machineCount()).toBe(count);
    expect(await orderCount()).toBe(0);
  });

  test("five simultaneous asks issue one tag", async () => {
    const editor = await person({ grant: "editor" });
    const m = await machine("SNLS", "SNLS-01");
    const all = await Promise.all(Array.from({ length: 5 }, () =>
      call(`/sewing-machines/${m._id}/tag`, { token: editor.token, method: "POST" })));
    expect(all.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(all.map((r) => r.body.tag.code)).size).toBe(1);
    expect(all.filter((r) => r.body.created).length).toBe(1);
  });

  test("two machines never share a code — the database refuses it", async () => {
    const editor = await person({ grant: "editor" });
    const a = await machine("SNLS", "SNLS-01");
    const b = await machine("SNLS", "SNLS-02");
    const ta = (await call(`/sewing-machines/${a._id}/tag`, { token: editor.token, method: "POST" })).body.tag.code;
    const tb = (await call(`/sewing-machines/${b._id}/tag`, { token: editor.token, method: "POST" })).body.tag.code;
    expect(ta).not.toBe(tb);
    const idx = (await Machine.collection.indexes()).find((i) => i.name === "maintenanceTag_code_unique");
    expect(idx).toMatchObject({ unique: true });
    /* Even the tag service's own privileged write cannot put a's code on a third machine. */
    const c = await machine("SNLS", "SNLS-03");
    await expect(Machine.updateOne({ _id: c._id }, { $set: { maintenanceTag: { code: ta, issuedAt: new Date(), issuedBy: {} } } },
      { machineMaintenanceTagWrite: true })).rejects.toMatchObject({ code: 11000 });
  });

  test("nothing but the tag service may write or remove a tag; the register's save keeps it", async () => {
    const editor = await person({ grant: "editor" });
    const m = await machine("SNLS", "SNLS-01");
    const code = (await call(`/sewing-machines/${m._id}/tag`, { token: editor.token, method: "POST" })).body.tag.code;
    await expect(Machine.updateOne({ _id: m._id }, { $set: { "maintenanceTag.code": "MCH-AAAAAAAA" } })).rejects.toThrow(/maintenance tag service/);
    await expect(Machine.updateOne({ _id: m._id }, { $unset: { maintenanceTag: 1 } })).rejects.toThrow(/maintenance tag service/);
    await expect(Machine.findByIdAndUpdate(m._id, { maintenanceTag: null })).rejects.toThrow(/maintenance tag service/);
    await expect(Machine.create({ name: "x", type: "SNLS", model: "x", serialNumber: "TST-NEW-1", powerConsumption: "1W",
      location: "x", lastMaintenance: new Date(), nextMaintenance: new Date(Date.now() + 1e9), createdBy: new mongoose.Types.ObjectId(),
      maintenanceTag: { code: "MCH-BBBBBBBB", issuedAt: new Date(), issuedBy: {} } })).rejects.toThrow(/maintenance tag service/);

    /* The Machine register edits a machine with findById → save(). */
    const doc = await Machine.findById(m._id);
    doc.location = "Sewing Section B";
    await doc.save();
    expect((await Machine.findById(m._id).select("+maintenanceTag").lean()).maintenanceTag.code).toBe(code);
  });
});

describe("the scan", () => {
  test("resolves the same machine every time and writes nothing", async () => {
    const editor = await person({ grant: "editor" });
    const m = await machine("SNLS", "SNLS-01");
    await machine("SNLS", "SNLS-02");
    const code = (await call(`/sewing-machines/${m._id}/tag`, { token: editor.token, method: "POST" })).body.tag.code;
    const machinesBefore = await machineCount();
    const snapshot = await Machine.findById(m._id).select("+maintenanceTag").lean();

    const answers = [];
    for (let i = 0; i < 100; i += 1) {
      const raw = i % 2 ? code : `  ${code.toLowerCase()}\r\n`;
      answers.push(await call(`/resolve?code=${encodeURIComponent(raw)}`, { token: editor.token }));
    }
    expect(answers.every((r) => r.status === 200)).toBe(true);
    expect(new Set(answers.map((r) => r.body.machineId))).toEqual(new Set([String(m._id)]));
    expect(await machineCount()).toBe(machinesBefore);
    expect(await orderCount()).toBe(0);
    expect(await Machine.findById(m._id).select("+maintenanceTag").lean()).toEqual(snapshot);
  });

  test("an unknown, malformed or foreign label is Sewing Machine Not Found", async () => {
    const editor = await person({ grant: "editor" });
    const machinesBefore = await machineCount();
    const cases = [
      ["MCH-ZZZZZZZZ", "unknown-tag"],
      ["MCH-123", "unknown"],
      ["itemid=6512ab34cd56ef7890123456", "store-item"],
      ["loc=LOC-ABCD2345", "store-location"],
      ["WO-359e7172-009", "garment-piece"],
      ["", "empty"],
    ];
    for (const [raw, kind] of cases) {
      const r = await call(`/resolve?code=${encodeURIComponent(raw)}`, { token: editor.token });
      expect(r.status).toBe(404);
      expect(r.body.message).toBe("Sewing Machine Not Found");
      expect(r.body.kind).toBe(kind);
      expect(r.body.reason).toEqual(expect.any(String));
    }
    expect(await machineCount()).toBe(machinesBefore);
    expect(await mongoose.connection.db.collection("barcodes").countDocuments()).toBe(0);
  });
});

describe("the first version's reports", () => {
  test("stay readable in the machine's history and cannot be rewritten or deleted", async () => {
    const editor = await person({ grant: "editor" });
    const m = await machine("SNLS", "SNLS-01");
    /* Written as the first version wrote them; nothing writes them now. */
    await mongoose.connection.db.createCollection("machine_maintenance_records").catch(() => {});
    const rec = await MachineMaintenanceRecord.create({ machine: m._id, kind: "breakdown", problem: "Old breakdown",
      reportedAt: new Date("2026-10-02T09:00:00Z"), reportedBy: { name: "Old" }, machineAtReport: { location: "A", status: "Operational" },
      idempotencyKey: key() });

    const page = await call(`/subjects/machine/${m._id}`, { token: editor.token });
    expect(page.status).toBe(200);
    expect(page.body.history).toEqual([expect.objectContaining({ entryType: "report", title: "Breakdown report", problem: "Old breakdown" })]);

    await expect(MachineMaintenanceRecord.updateOne({ _id: rec._id }, { $set: { problem: "Something else" } })).rejects.toThrow(/append-only/);
    await expect(MachineMaintenanceRecord.replaceOne({ _id: rec._id }, { kind: "maintenance" })).rejects.toThrow(/append-only/);
    await expect(MachineMaintenanceRecord.deleteOne({ _id: rec._id })).rejects.toThrow(/append-only/);
    await expect((await MachineMaintenanceRecord.findById(rec._id)).deleteOne()).rejects.toThrow(/append-only/);
    expect(await MachineMaintenanceRecord.countDocuments()).toBe(1);
  });
});

describe("storage readiness on a cold start", () => {
  test("simultaneous first questions all hear 'ready', and the first list and order work", async () => {
    /* Found on the local copy (3 Oct 2026): a second caller used to answer
       "not ready" while the first was still checking. */
    const editor = await person({ grant: "editor" });
    const m = await machine("SNLS", "SNLS-01");
    storage.resetStorageCache();
    expect(await Promise.all(Array.from({ length: 5 }, () => storage.orderStorageReady()))).toEqual([true, true, true, true, true]);

    storage.resetStorageCache();
    const [created, list] = await Promise.all([
      call("/orders", { token: editor.token, method: "POST", body: { orderType: "service",
        subject: { kind: "machine", id: String(m._id) }, problem: "Cold start order", idempotencyKey: key() } }),
      call("/orders?type=service", { token: editor.token }),
    ]);
    expect(created.status).toBe(201);
    expect(list.body.storage.ordersReady).toBe(true);
  });
});

describe("storage not set up", () => {
  test("an order is refused, the attempt creates no collection, and barcodes still work", async () => {
    const editor = await person({ grant: "editor" });
    const m = await machine("SNLS", "SNLS-01");
    await mongoose.connection.db.dropCollection("maintenance_orders");
    storage.resetStorageCache();

    const r = await call("/orders", { token: editor.token, method: "POST", body: { orderType: "service",
      subject: { kind: "machine", id: String(m._id) }, problem: "Thread keeps breaking", idempotencyKey: key() } });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("MAINTENANCE_STORAGE_NOT_READY");
    const page = await call(`/subjects/machine/${m._id}`, { token: editor.token });
    expect(page.status).toBe(200);
    expect(page.body.history).toEqual([]);
    expect(page.body.storage.ordersReady).toBe(false);
    expect(await mongoose.connection.db.listCollections({ name: "maintenance_orders" }).toArray()).toHaveLength(0);
    expect((await call(`/sewing-machines/${m._id}/tag`, { token: editor.token, method: "POST" })).status).toBe(201);
  });
});
