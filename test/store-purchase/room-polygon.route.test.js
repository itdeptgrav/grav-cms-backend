// test/store-purchase/room-polygon.route.test.js
//
// THE ROOM'S OUTLINE, AT THE WIRE.
//
// The 2D plan is the one editable copy of the building's shape, and this save
// is what the 3D room, the collision area, the walkthrough's walkable floor,
// the minimap and the camera framing are all generated from. So what is pinned
// here is that a stored outline is always one a building could have, and that
// the rectangle every older reader depends on is derived from it rather than
// sent alongside it — because two answers to one question is how the 2D plan
// and the 3D warehouse drift apart.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
require("../../models/ProjectManager");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const roomPolygon = require("../../services/storePurchase/roomPolygon");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/store-locations", require("../../routes/CMS_Routes/Inventory/Operations/storeLocationRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/inventory/store-locations`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, token, idempotencyKey } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const t = await r.text();
    let b = null;
    try { b = JSON.parse(t || "null"); } catch { b = t; }
    return { status: r.status, body: b };
  });

const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function actor(co, { role = "approver" } = {}) {
  const n = ++seq;
  const email = `rp${n}@x.example`;
  const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role, name: "RP", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef, personName: "RP" });
  return jwt.sign(
    { id: String(employeeRef), role: "store_manager", employeeId: `ST${n}`, name: "RP", email },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
  );
}

const warehouse = (co, floorPlan = {}) => Warehouse.create({
  companyId: co._id, name: `WH ${++seq}`, shortName: `W${seq}`, status: "Active",
  floorPlan: { widthCm: 900, depthCm: 700, heightCm: 300, gridCm: 25, ...floorPlan },
  locations: [],
});

const key = () => `rp-${++seq}-${Math.random().toString(36).slice(2)}`;
const saveUrl = (w) => `/warehouses/${w._id}/layout`;
const P = (...pairs) => pairs.map(([x, z]) => ({ x, z }));

/* An L-shaped room: 900 × 700 with a 300 × 233 bite out of the bottom right. */
const L_ROOM = P([0, 0], [900, 0], [900, 467], [600, 467], [600, 700], [0, 700]);

test("1 · an L-shaped room is stored, and the rectangle is derived from it", async () => {
  const co = await company();
  const token = await actor(co);
  const w = await warehouse(co);

  const r = await call(saveUrl(w), {
    method: "PUT", token, idempotencyKey: key(),
    body: {
      layoutVersion: 0,
      /* The client sends a width and depth that do NOT match, as a careless or
         stale client would. The server derives them from the outline anyway. */
      floorPlan: { widthCm: 1, depthCm: 1, room: { shape: "L", points: L_ROOM, heightCm: 340 } },
    },
  });
  expect(r.status).toBe(200);

  const saved = (await Warehouse.findById(w._id).lean()).floorPlan;
  expect(saved.room.shape).toBe("L");
  expect(saved.room.points).toHaveLength(6);
  expect(saved.room.points[2]).toMatchObject({ x: 900, z: 467 });
  expect(saved.room.heightCm).toBe(340);
  /* Derived, not taken. */
  expect(saved.widthCm).toBe(900);
  expect(saved.depthCm).toBe(700);
  expect(saved.heightCm).toBe(340);
  expect(saved.layoutVersion).toBe(1);
});

test("2 · a self-crossing outline is refused, and nothing is written", async () => {
  const co = await company();
  const token = await actor(co);
  const w = await warehouse(co);

  const bow = P([0, 0], [900, 0], [0, 700], [900, 700]);
  const r = await call(saveUrl(w), {
    method: "PUT", token, idempotencyKey: key(),
    body: { layoutVersion: 0, floorPlan: { room: { shape: "CUSTOM", points: bow } } },
  });
  expect(r.status).toBe(400);
  expect(r.body.error.details.reason).toBe("INVALID_ROOM");
  expect(r.body.error.details.walls).toHaveLength(2);
  expect(r.body.message).toMatch(/do(es)? not enclose one space/);

  const after = (await Warehouse.findById(w._id).lean()).floorPlan;
  expect(after.room?.points || []).toHaveLength(0);
  expect(after.layoutVersion).toBe(0);
  expect(after.widthCm).toBe(900);
});

test("3 · fewer than three corners, no area, and too many corners are each refused", async () => {
  const co = await company();
  const token = await actor(co);
  const w = await warehouse(co);
  const save = (points) => call(saveUrl(w), {
    method: "PUT", token, idempotencyKey: key(),
    body: { layoutVersion: 0, floorPlan: { room: { points } } },
  });

  expect((await save(P([0, 0], [900, 0]))).body.message).toMatch(/at least three corners/);
  expect((await save(P([0, 0], [450, 0], [900, 0]))).status).toBe(400);
  const many = Array.from({ length: 201 }, (_, i) => ({ x: i * 10, z: i % 2 ? 5 : 0 }));
  expect((await save(many)).body.message).toMatch(/at most 200 corners/);
  expect((await Warehouse.findById(w._id).lean()).floorPlan.layoutVersion).toBe(0);
});

test("4 · a corner with a missing coordinate is dropped, never placed at the origin", () => {
  /* Number(null) is 0. Taking it would draw a wall through the building from
     data that was merely incomplete. */
  expect(roomPolygon.normalisePoints([{ x: 0, z: 0 }, { x: null, z: 700 }, { x: 900, z: 0 }, { x: 900, z: 700 }]))
    .toEqual([{ x: 0, z: 0 }, { x: 900, z: 0 }, { x: 900, z: 700 }]);
  /* A polygon sent closed is stored open — the closing wall is implied. */
  expect(roomPolygon.normalisePoints(P([0, 0], [900, 0], [900, 700], [0, 0]))).toHaveLength(3);
  /* And a corner clicked twice is one corner. */
  expect(roomPolygon.normalisePoints(P([0, 0], [0, 0], [900, 0], [900, 700]))).toHaveLength(3);
});

test("5 · a plan with no outline is untouched, and keeps the rectangle it always had", async () => {
  const co = await company();
  const token = await actor(co);
  const w = await warehouse(co);

  /* A save that says nothing about the room — every save this screen made
     before the room existed. */
  const r = await call(saveUrl(w), {
    method: "PUT", token, idempotencyKey: key(),
    body: { layoutVersion: 0, floorPlan: { gridCm: 50, notes: "Bay 3 is blocked" } },
  });
  expect(r.status).toBe(200);
  const saved = (await Warehouse.findById(w._id).lean()).floorPlan;
  expect(saved.gridCm).toBe(50);
  expect(saved.widthCm).toBe(900);
  expect(saved.depthCm).toBe(700);
  expect(saved.room?.points || []).toHaveLength(0);
});

test("6 · the outline is shaped by the plan owner, and a viewer cannot save one", async () => {
  const co = await company();
  const viewer = await actor(co, { role: "viewer" });
  const w = await warehouse(co);
  const r = await call(saveUrl(w), {
    method: "PUT", token: viewer, idempotencyKey: key(),
    body: { layoutVersion: 0, floorPlan: { room: { shape: "L", points: L_ROOM } } },
  });
  expect(r.status).toBe(403);
  expect((await Warehouse.findById(w._id).lean()).floorPlan.room?.points || []).toHaveLength(0);
});

test("7 · one company's outline cannot be shaped by another", async () => {
  const [a, b] = [await company(), await company()];
  const tokenB = await actor(b);
  const w = await warehouse(a);
  const r = await call(saveUrl(w), {
    method: "PUT", token: tokenB, idempotencyKey: key(),
    body: { layoutVersion: 0, floorPlan: { room: { shape: "L", points: L_ROOM } } },
  });
  expect([403, 404]).toContain(r.status);
  expect((await Warehouse.findById(w._id).lean()).floorPlan.room?.points || []).toHaveLength(0);
});

test("8 · a stale save is refused, so two people reshaping one room cannot overwrite each other", async () => {
  const co = await company();
  const token = await actor(co);
  const w = await warehouse(co);

  const first = await call(saveUrl(w), {
    method: "PUT", token, idempotencyKey: key(),
    body: { layoutVersion: 0, floorPlan: { room: { shape: "L", points: L_ROOM } } },
  });
  expect(first.status).toBe(200);

  /* Somebody else's builder, opened before that save. */
  const stale = await call(saveUrl(w), {
    method: "PUT", token, idempotencyKey: key(),
    body: { layoutVersion: 0, floorPlan: { room: { shape: "RECTANGLE", points: P([0, 0], [500, 0], [500, 500], [0, 500]) } } },
  });
  expect(stale.status).toBe(409);
  expect(stale.body.error.details.reason).toBe("STALE_VERSION");
  /* The L survives. */
  expect((await Warehouse.findById(w._id).lean()).floorPlan.room.points).toHaveLength(6);
});

test("9 · the room and the interior walls are separate things", async () => {
  const co = await company();
  const token = await actor(co);
  const w = await warehouse(co);

  const r = await call(saveUrl(w), {
    method: "PUT", token, idempotencyKey: key(),
    body: {
      layoutVersion: 0,
      floorPlan: {
        room: { shape: "L", points: L_ROOM },
        /* An internal partition. It is not part of the exterior boundary and
           must not be folded into it. */
        walls: [{ id: "w1", x1: 300, z1: 0, x2: 300, z2: 400, thickness: 12 }],
      },
    },
  });
  expect(r.status).toBe(200);
  const saved = (await Warehouse.findById(w._id).lean()).floorPlan;
  expect(saved.room.points).toHaveLength(6);
  expect(saved.walls).toHaveLength(1);
  expect(saved.walls[0].x1).toBe(300);
});

test("10 · a room drawn anticlockwise is stored the same way round as one drawn clockwise", async () => {
  /* The shape is identical either way; what must not vary is the SIGN of
     everything derived from it downstream — which side of a wall is inside,
     which way its normal points, and whether a triangulator reads the ring as
     solid or as a hole. */
  const co = await company();
  const token = await actor(co);
  const [a, b] = [await warehouse(co), await warehouse(co)];
  const reversed = [L_ROOM[0], ...L_ROOM.slice(1).reverse()];
  expect(Math.sign(roomPolygon.signedArea2(L_ROOM))).not.toBe(Math.sign(roomPolygon.signedArea2(reversed)));

  for (const [w, points] of [[a, L_ROOM], [b, reversed]]) {
    const r = await call(saveUrl(w), {
      method: "PUT", token, idempotencyKey: key(),
      body: { layoutVersion: 0, floorPlan: { room: { shape: "L", points } } },
    });
    expect(r.status).toBe(200);
  }
  const pa = (await Warehouse.findById(a._id).lean()).floorPlan.room.points.map((p) => ({ x: p.x, z: p.z }));
  const pb = (await Warehouse.findById(b._id).lean()).floorPlan.room.points.map((p) => ({ x: p.x, z: p.z }));
  expect(pb).toEqual(pa);
  expect(roomPolygon.signedArea2(pa)).toBeGreaterThan(0);
  /* And it is still the same room, not a re-ordered one. */
  expect(roomPolygon.areaCm2(pa)).toBe(roomPolygon.areaCm2(L_ROOM));
});

test("11 · a corner repeated at the end, and one clicked twice, are each one corner", () => {
  expect(roomPolygon.normalisePoints([...L_ROOM, L_ROOM[0]])).toHaveLength(6);
  expect(roomPolygon.normalisePoints([L_ROOM[0], L_ROOM[0], ...L_ROOM.slice(1)])).toHaveLength(6);
});
