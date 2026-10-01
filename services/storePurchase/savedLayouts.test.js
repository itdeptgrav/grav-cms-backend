// services/storePurchase/savedLayouts.test.js — the rules of more than one
// layout per warehouse, without a database.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const L = require("./savedLayouts");

const oid = () => new mongoose.Types.ObjectId();

function warehouse() {
  const r1 = oid(), r2 = oid(), shelf = oid(), gone = oid();
  return {
    ids: { r1, r2, shelf, gone },
    w: {
      _id: oid(),
      structureVersion: 4,
      floorPlan: {
        room: { shape: "L", points: [{ x: 0, z: 0 }, { x: 900, z: 0 }, { x: 900, z: 600 }, { x: 0, z: 600 }], heightCm: 320 },
        widthCm: 900, depthCm: 600, heightCm: 320, gridCm: 20,
        walls: [{ id: "w1", x1: 0, z1: 0, x2: 900, z2: 0 }],
        fixtures: [{ id: "d1", kind: "door", x: 10, z: 0, w: 90, d: 10 }],
        entranceId: "d1", notes: "as built", layoutVersion: 7,
      },
      locations: [
        { _id: r1, code: "R01", kind: "RACK", parent: null, status: "Active", layout: { x: 50, z: 60, w: 240, h: 200, d: 45, rotation: 90, placed: true } },
        { _id: r2, code: "R02", kind: "RACK", parent: null, status: "Active", layout: { x: 400, z: 60, w: 120, h: 200, d: 45, rotation: 0, placed: true } },
        { _id: shelf, code: "R01-L01", kind: "SHELF", parent: r1, status: "Active", layout: { x: 0, y: 40, z: 0, w: 120, h: 40, d: 45, placed: true } },
        { _id: gone, code: "OLD", kind: "RACK", parent: null, status: "Archived", layout: { x: 1, z: 1, placed: true } },
      ],
    },
  };
}
/* Apply a planned $set to a plain copy, the way Mongo would. */
function apply(w, plan) {
  const out = JSON.parse(JSON.stringify(w));
  const filters = new Map((plan.arrayFilters || []).map((f) => { const [k, v] = Object.entries(f)[0]; return [k.split(".")[0], String(v)]; }));
  for (const [path, value] of Object.entries(plan.$set)) {
    const m = /^locations\.\$\[(\w+)\]\.layout$/.exec(path);
    if (m) { out.locations.find((l) => String(l._id) === filters.get(m[1])).layout = JSON.parse(JSON.stringify(value)); continue; }
    if (path === "layouts") { out.layouts = JSON.parse(JSON.stringify(value)); continue; }
    const [head, key] = path.split(".");
    out[head][key] = JSON.parse(JSON.stringify(value));
  }
  return out;
}
const layoutOf = (w, id) => w.locations.find((l) => String(l._id) === String(id)).layout;

test("a warehouse that never had a second layout offers one implicit layout", () => {
  const { w } = warehouse();
  const list = L.listOf(w);
  assert.equal(list.length, 1);
  assert.deepEqual({ id: list[0].id, name: list[0].name, active: list[0].active, saved: list[0].saved, placed: list[0].placed }, { id: "", name: "Original layout", active: true, saved: false, placed: 2 });
});

test("a new layout is a blank room with every root unplaced, and the old one is kept", () => {
  const { w, ids: I } = warehouse();
  const plan = L.planCreate(w, { name: "  Winter   layout ", now: new Date("2026-09-30"), newId: oid });
  assert.equal(plan.name, "Winter layout");
  const after = apply(w, plan);
  /* the live slot is now empty */
  assert.deepEqual(after.floorPlan.room.points, []);
  assert.equal(after.floorPlan.widthCm, 0);
  assert.deepEqual(after.floorPlan.walls, []);
  assert.deepEqual(after.floorPlan.fixtures, []);
  assert.equal(after.floorPlan.entranceId, "");
  assert.equal(after.floorPlan.heightCm, 320, "the building's height is kept");
  assert.equal(after.floorPlan.gridCm, 20, "the builder's grid is kept");
  assert.equal(layoutOf(after, I.r1).placed, false);
  assert.equal(layoutOf(after, I.r1).w, 240, "a root keeps its size so placing it later needs no re-entry");
  assert.equal(layoutOf(after, I.shelf).y, 40, "a shelf's position inside its rack is not an arrangement and is untouched");
  assert.equal(layoutOf(after, I.gone).placed, true, "archived locations are left alone");
  assert.equal(String(after.floorPlan.activeLayoutId), String(plan.layoutId));
  /* the previous arrangement is now a saved layout with its snapshot */
  const list = L.listOf(after);
  assert.deepEqual(list.map((r) => [r.name, r.active]), [["Original layout", false], ["Winter layout", true]]);
  const original = after.layouts[0];
  assert.equal(original.floorPlan.entranceId, "d1");
  assert.equal(original.floorPlan.room.points.length, 4);
  assert.equal(original.positions.length, 2, "roots only, archived excluded");
  assert.equal(list[0].placed, 2);
  assert.equal(list[1].placed, 0);
});

test("the implicit layout can be named as the new one is created", () => {
  const { w } = warehouse();
  const after = apply(w, L.planCreate(w, { name: "B", currentName: "As built", newId: oid }));
  assert.deepEqual(L.listOf(after).map((r) => r.name), ["As built", "B"]);
  assert.throws(() => L.planCreate(w, { name: "Same", currentName: "same", newId: oid }), (e) => e.details?.reason === "LAYOUT_NAME_TAKEN" || /already has/.test(e.message));
});

test("switching restores a layout exactly and keeps the one that was live", () => {
  const { w, ids: I } = warehouse();
  let s = apply(w, L.planCreate(w, { name: "B", newId: oid }));
  /* arrange B: place R02 somewhere else and draw a small room */
  s.locations.find((l) => String(l._id) === String(I.r2)).layout = { x: 10, z: 10, w: 120, h: 200, d: 45, rotation: 180, placed: true };
  s.floorPlan.room = { shape: "RECTANGLE", points: [{ x: 0, z: 0 }, { x: 300, z: 0 }, { x: 300, z: 300 }, { x: 0, z: 300 }], heightCm: 320 };
  s.floorPlan.widthCm = 300; s.floorPlan.depthCm = 300;
  const originalId = L.listOf(s).find((r) => r.name === "Original layout").id;
  const bId = L.listOf(s).find((r) => r.name === "B").id;

  const back = apply(s, L.planActivate(s, originalId, { newId: oid }));
  assert.deepEqual(layoutOf(back, I.r1), { x: 50, z: 60, w: 240, h: 200, d: 45, rotation: 90, placed: true });
  assert.equal(layoutOf(back, I.r2).x, 400);
  assert.equal(back.floorPlan.entranceId, "d1");
  assert.equal(back.floorPlan.widthCm, 900);
  assert.equal(String(back.floorPlan.activeLayoutId), originalId);
  assert.equal(back.layouts.find((x) => String(x._id) === originalId).floorPlan, null, "the live layout keeps no stale copy");

  const again = apply(back, L.planActivate(back, bId, { newId: oid }));
  assert.deepEqual(layoutOf(again, I.r2), { x: 10, z: 10, w: 120, h: 200, d: 45, rotation: 180, placed: true });
  assert.equal(layoutOf(again, I.r1).placed, false, "R01 was never placed on B");
  assert.equal(again.floorPlan.widthCm, 300);
  assert.equal(again.floorPlan.entranceId, "");
});

test("a rack created while another layout was live is not on the older layout", () => {
  const { w } = warehouse();
  let s = apply(w, L.planCreate(w, { name: "B", newId: oid }));
  const fresh = oid();
  s.locations.push({ _id: String(fresh), code: "R09", kind: "RACK", parent: null, status: "Active", layout: { x: 5, z: 5, w: 100, h: 180, d: 40, placed: true } });
  const originalId = L.listOf(s).find((r) => r.name === "Original layout").id;
  const back = apply(s, L.planActivate(s, originalId, { newId: oid }));
  assert.equal(layoutOf(back, fresh).placed, false);
  assert.equal(layoutOf(back, fresh).w, 100);
});

test("switching to the live layout is a no-op; an unknown one is refused", () => {
  const { w } = warehouse();
  const s = apply(w, L.planCreate(w, { name: "B", newId: oid }));
  const bId = L.listOf(s).find((r) => r.active).id;
  assert.equal(L.planActivate(s, bId).noop, true);
  assert.throws(() => L.planActivate(s, String(oid())), /not in this warehouse/);
  assert.throws(() => L.planActivate(w, ""), /not in this warehouse/);
});

test("names: required, one line, 60 characters, unique regardless of case", () => {
  assert.throws(() => L.validateName("   "), /Give the layout a name/);
  assert.throws(() => L.validateName("x".repeat(61)), /at most 60/);
  assert.throws(() => L.validateName("Main", [{ name: "main" }]), /already has/);
  assert.equal(L.validateName("Main\n floor"), "Main floor");
});

test("renaming: the implicit layout becomes an entry; a saved one keeps its snapshot", () => {
  const { w } = warehouse();
  const r = L.planRename(w, "", "As built", { newId: oid });
  const named = apply(w, { $set: r.$set });
  assert.deepEqual(L.listOf(named).map((x) => [x.name, x.active]), [["As built", true]]);
  assert.equal(named.locations[0].layout.placed, true, "a rename moves nothing");

  const s = apply(w, L.planCreate(w, { name: "B", newId: oid }));
  const originalId = L.listOf(s).find((x) => x.name === "Original layout").id;
  const renamed = apply(s, { $set: L.planRename(s, originalId, "Summer").$set });
  const entry = renamed.layouts.find((x) => String(x._id) === originalId);
  assert.equal(entry.name, "Summer");
  assert.equal(entry.positions.length, 2);
  assert.throws(() => L.planRename(s, originalId, "b"), /already has/);
  assert.throws(() => L.planRename(s, "", "C"), /not in this warehouse/, "once layouts are saved there is no implicit one");
});

test("a warehouse holds at most 20 layouts", () => {
  const { w } = warehouse();
  const s = { ...w, layouts: Array.from({ length: 20 }, (_, i) => ({ _id: oid(), name: `L${i}` })) };
  s.floorPlan = { ...w.floorPlan, activeLayoutId: s.layouts[0]._id };
  assert.throws(() => L.planCreate(s, { name: "One more" }), /at most 20/);
});

test("a root older than the `placed` flag comes back on its layout after a round trip", () => {
  const { w, ids: I } = warehouse();
  delete w.locations[1].layout.placed; /* R02, written before the flag existed — the map draws it */
  const s = apply(w, L.planCreate(w, { name: "B", newId: oid }));
  assert.equal(layoutOf(s, I.r2).placed, false, "off the blank layout");
  const originalId = L.listOf(s).find((r) => r.name === "Original layout").id;
  assert.equal(L.listOf(s).find((r) => r.name === "Original layout").placed, 2);
  const back = apply(s, L.planActivate(s, originalId, { newId: oid }));
  assert.equal(layoutOf(back, I.r2).placed, true, "and back on the layout it was drawn on");
  assert.equal(layoutOf(back, I.r2).x, 400);
});
