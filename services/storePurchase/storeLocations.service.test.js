const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const S = require("./storeLocations.service");

const id = () => new mongoose.Types.ObjectId();

test("parseScan tells a location label from an item sticker, in every shape", () => {
  assert.deepEqual(S.parseScan("LOC-ABCDEFGH"), { type: "location", token: "LOC-ABCDEFGH" });
  assert.deepEqual(S.parseScan("loc=LOC-ABCDEFGH"), { type: "location", token: "LOC-ABCDEFGH" });
  assert.deepEqual(S.parseScan("http://localhost:3001/store/dashboard/locations/scan?loc=LOC-ABCDEFGH"), { type: "location", token: "LOC-ABCDEFGH" });
  const hex = "6a79a4d1da39e282a6b160a3";
  assert.deepEqual(S.parseScan(hex), { type: "item", barcodeId: hex });
  assert.deepEqual(S.parseScan(`itemid=${hex}`), { type: "item", barcodeId: hex });
  assert.deepEqual(S.parseScan(`RawItem=${hex}`), { type: "item", barcodeId: hex });
  assert.deepEqual(S.parseScan(`https://cms.grav.in/store/dashboard/item-info?itemid=${hex}`), { type: "item", barcodeId: hex });
  assert.equal(S.parseScan("WO-a6b16a8f-012").type, "piece");
  assert.equal(S.parseScan("hello").type, "unknown");
  assert.equal(S.parseScan("LOC-1O").type, "invalid");
  assert.equal(S.parseScan("").type, "empty");
});

test("mintQrToken is LOC- plus eight unambiguous characters", () => {
  const t = S.mintQrToken();
  assert.match(t, S.TOKEN_RE);
  assert.ok(!/[01IO]/.test(t.slice(4)));
  assert.equal(S.locationQrPayload(t, "http://x.local/"), `http://x.local/store/dashboard/locations/scan?loc=${t}`);
  assert.equal(S.locationQrPayload(t), `loc=${t}`);
});

test("rackPlan expands a rack into levels, bays and positions with codes under 16 characters", () => {
  const p = S.rackPlan({ code: "R04", name: "Rack 4", levels: 3, bays: 2, positionsPerBay: 2, storageKind: "BIN", width: 140, height: 210, depth: 50 });
  assert.equal(p.specs[0].kind, "RACK");
  assert.equal(p.positionsCreated, 3 * 2 + 3 * 2 * 2);
  const codes = p.specs.map((s) => s.code);
  assert.ok(codes.includes("R04-L01-B01"));
  assert.ok(codes.includes("R04-L03-B02-P02"));
  assert.ok(codes.every((c) => c.length <= 16));
  const shelf = p.specs.find((s) => s.code === "R04-L02-B02");
  assert.equal(shelf.kind, "SHELF");
  assert.deepEqual([shelf.layout.x, shelf.layout.y, shelf.layout.w, shelf.layout.h], [70, 70, 70, 70]);
  const bin = p.specs.find((s) => s.code === "R04-L02-B02-P02");
  assert.equal(bin.kind, "BIN"); assert.equal(bin.parentRef, shelf.ref); assert.equal(bin.layout.x, 35);
  /* a single-bay rack of drawers: R02-L01 … with no bay segment */
  const d = S.rackPlan({ code: "R02", levels: 3, bays: 1, storageKind: "DRAWER" });
  assert.deepEqual(d.specs.slice(1).map((s) => [s.code, s.kind]), [["R02-L01", "DRAWER"], ["R02-L02", "DRAWER"], ["R02-L03", "DRAWER"]]);
  assert.throws(() => S.rackPlan({ code: "VERYLONGRACKCODE1", levels: 1, bays: 1 }), /16 characters/);
  assert.throws(() => S.rackPlan({ code: "R9", levels: 2, bays: 12, positionsPerBay: 12, levelCodePrefix: "LEVEL", bayCodePrefix: "BAY" }), /longer than 16/);
});

test("addressOf, pathOf, descendantsOf and holdsStockError walk the tree", () => {
  const w = { _id: id(), shortName: "MS", name: "Main Store", locations: [] };
  const zone = { _id: id(), code: "A", name: "A", kind: "ZONE", type: "USABLE_STOCK", status: "Active", parent: null };
  const rack = { _id: id(), code: "R04", name: "R04", kind: "RACK", type: "USABLE_STOCK", status: "Active", parent: zone._id, layout: { x: 100, z: 200, rotation: 90, w: 140, h: 210, d: 50 } };
  const shelf = { _id: id(), code: "R04-L02", name: "Level 2", kind: "SHELF", type: "USABLE_STOCK", status: "Active", parent: rack._id, sequence: 2, layout: { x: 0, y: 70, z: 0, w: 140, h: 70, d: 50 } };
  const shelf1 = { _id: id(), code: "R04-L01", name: "Level 1", kind: "SHELF", type: "USABLE_STOCK", status: "Active", parent: rack._id, sequence: 1, layout: {} };
  const recv = { _id: id(), code: "RECV", name: "Receiving", kind: "AREA", type: "RECEIVING", status: "Active", parent: null };
  w.locations = [zone, rack, shelf, shelf1, recv];
  const a = S.addressOf(w, shelf);
  assert.equal(a.code, "MS-A-R04-R04-L02");
  assert.equal(a.display, "Main Store › Zone A › Rack R04 › Shelf Level 2");
  assert.equal(a.short, "A / R04 / R04-L02");
  assert.equal(a.depth, 3);
  assert.deepEqual(S.pathOf(w, shelf).map((l) => l.code), ["A", "R04", "R04-L02"]);
  assert.deepEqual(S.descendantsOf(w, zone).map((l) => l.code).sort(), ["R04", "R04-L01", "R04-L02"]);
  assert.equal(S.holdsStockError(w, shelf), null);
  assert.match(S.holdsStockError(w, rack), /put the stock on one of its 2 positions/);
  assert.match(S.holdsStockError(w, recv), /receiving area/);
  /* the world box folds the rack's offset and rotation into the shelf */
  const box = S.worldBoxOf(w, shelf);
  assert.equal(box.rotation, 90);
  assert.equal(Math.round(box.x), 100); assert.equal(Math.round(box.z), 200); assert.equal(box.y, 70);
  /* the tree orders siblings by sequence and aggregates leaf totals */
  const totals = new Map([[String(shelf._id), { lines: 2, onHand: 30, items: 2 }]]);
  const tree = S.treeOf(w, totals);
  const z = tree.find((n) => n.code === "A");
  assert.deepEqual(z.children[0].children.map((c) => c.code), ["R04-L01", "R04-L02"]);
  assert.equal(z.totals.onHand, 30); assert.equal(z.totals.positions, 2); assert.equal(z.totals.occupied, 1);
});

test("physical fields are validated, and an update only sets what was sent", () => {
  assert.deepEqual(S.physicalFieldsFromBody({}), { kind: "AREA", sequence: 0, layout: {}, capacity: {} });
  const f = S.physicalFieldsFromBody({ kind: "bin", sequence: "3", layout: { x: "10.26", w: 40, h: 30, d: 20, rotation: -90 }, capacity: { value: 50, unit: "PCS" } });
  assert.equal(f.kind, "BIN"); assert.equal(f.sequence, 3); assert.equal(f.layout.x, 10.3); assert.equal(f.layout.rotation, 270); assert.equal(f.layout.placed, true); assert.equal(f.capacity.value, 50);
  assert.deepEqual(S.physicalSetFromBody({ layout: { x: 5 } }, "locations.$[l]."), { "locations.$[l].layout.x": 5 });
  assert.throws(() => S.physicalFieldsFromBody({ kind: "CUPBOARD" }), /supported location kinds/);
  assert.throws(() => S.physicalFieldsFromBody({ layout: { w: -1 } }), /cannot be negative/);
  assert.throws(() => S.physicalFieldsFromBody({ capacity: { warnAtPct: 150 } }), /between 1 and 100/);
});
