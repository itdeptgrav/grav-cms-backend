// test/store-purchase/store-layout-entrance.route.test.js
//
// THE WALKTHROUGH'S DOORWAY (29 Sep 2026).
//
// The store map's walkthrough starts at a doorway, so the plan has to say
// which doorway that is and which way it faces into the room. Doors were
// already fixtures; what the model gained is `floorPlan.entranceId` and a
// per-fixture `facingDeg`. Both are whitelisted on the layout save — the route
// rebuilds every fixture from named fields, so an un-whitelisted one is
// silently dropped, which is exactly how this could have shipped looking
// right and persisting nothing.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/store-locations", require("../../routes/CMS_Routes/Inventory/Operations/storeLocationRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tokenFor = (over = {}) =>
  jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "store_manager", employeeId: `ST${seq}`, name: "St", email: "s@x.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });

const call = (path, { method = "GET", body, token, key } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(key ? { "Idempotency-Key": key } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const newKey = () => `k-${++seq}-${Math.random().toString(36).slice(2)}`;
const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function actor(comp, role = "approver") {
  const n = ++seq;
  const email = `ent${n}@x.example`;
  const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role, name: "Ent", isActive: true });
  await SpCompanyMembership.create({ companyId: comp._id, email, employeeRef, personName: "Ent" });
  return tokenFor({ id: String(employeeRef), email });
}

const warehouse = (companyId) => Warehouse.create({
  companyId, name: `WH ${++seq}`, shortName: `W${seq}`, status: "Active",
  floorPlan: { widthCm: 900, depthCm: 700, heightCm: 320, gridCm: 25, layoutVersion: 0 },
  locations: [],
});

const DOORS = [
  { id: "door-north", kind: "door", x: 300, z: 0, w: 90, d: 12, h: 210, rotation: 0, label: "Main door" },
  { id: "door-east", kind: "door", x: 900, z: 300, w: 90, d: 12, h: 210, rotation: 90, label: "Dispatch door" },
];
const save = (token, wh, floorPlan, layoutVersion) =>
  call(`/api/cms/inventory/store-locations/warehouses/${wh._id}/layout`, { method: "PUT", token, key: newKey(), body: { layoutVersion, items: [], floorPlan } });

test("the primary entrance and a door's inward facing are stored, returned and editable", async () => {
  const comp = await company();
  const token = await actor(comp);
  const wh = await warehouse(comp._id);

  const first = await save(token, wh, { fixtures: [{ ...DOORS[0], facingDeg: 90 }, DOORS[1]], entranceId: "door-north" }, 0);
  expect(first.status).toBe(200);
  expect(first.body.floorPlan.entranceId).toBe("door-north");
  const doors = first.body.floorPlan.fixtures;
  expect(doors.find((f) => f.id === "door-north").facingDeg).toBe(90);
  /* A door with no recorded facing keeps null — the map derives it from the
     wall it sits on, so existing plans need no migration. */
  expect(doors.find((f) => f.id === "door-east").facingDeg).toBeNull();

  /* And the read the map opens with carries them. */
  const tree = await call(`/api/cms/inventory/store-locations/tree?warehouseId=${wh._id}`, { token });
  expect(tree.status).toBe(200);
  expect(tree.body.warehouse.floorPlan.entranceId).toBe("door-north");
  expect(tree.body.warehouse.floorPlan.fixtures.find((f) => f.id === "door-north").facingDeg).toBe(90);

  /* Moving the entrance to the other door, and a facing out of range folded. */
  const moved = await save(token, wh, { fixtures: [DOORS[0], { ...DOORS[1], facingDeg: -90 }], entranceId: "door-east" }, first.body.layoutVersion);
  expect(moved.status).toBe(200);
  expect(moved.body.floorPlan.entranceId).toBe("door-east");
  expect(moved.body.floorPlan.fixtures.find((f) => f.id === "door-east").facingDeg).toBe(270);

  /* And clearing it, which returns the map to the fitted overview. */
  const cleared = await save(token, wh, { fixtures: DOORS, entranceId: "" }, moved.body.layoutVersion);
  expect(cleared.status).toBe(200);
  expect(cleared.body.floorPlan.entranceId).toBe("");
});

test("an entrance that names no doorway on the plan is refused, and the layout is left alone", async () => {
  const comp = await company();
  const token = await actor(comp);
  const wh = await warehouse(comp._id);

  const bad = await save(token, wh, { fixtures: DOORS, entranceId: "door-that-was-deleted" }, 0);
  expect(bad.status).toBe(400);
  expect(bad.body.error.code).toBe("VALIDATION");
  expect(bad.body.error.details.field).toBe("entranceId");

  const after = await Warehouse.findById(wh._id).lean();
  expect(after.floorPlan.entranceId || "").toBe("");
  expect(after.floorPlan.layoutVersion).toBe(0);
});

test("recording an entrance needs master maintenance, not merely a reader", async () => {
  const comp = await company();
  const viewer = await actor(comp, "viewer");
  const wh = await warehouse(comp._id);
  const res = await save(viewer, wh, { fixtures: DOORS, entranceId: "door-north" }, 0);
  expect(res.status).toBe(403);
  expect((await Warehouse.findById(wh._id).lean()).floorPlan.entranceId || "").toBe("");
});
