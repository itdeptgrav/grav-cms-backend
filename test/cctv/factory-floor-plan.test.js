"use strict";
process.env.TEST_WITHOUT_MONGO = "1";

const { groundFloorRooms, FT } = require("../../services/cctv/factoryFloorPlan");
const { normalizedFurniture } = require("../../services/cctv/factoryTwinConfig.service");

const rooms = groundFloorRooms();
const byId = new Map(rooms.map((r) => [r.id, r]));
const ftOf = (metres) => metres / FT;
const near = (a, b, tolFt = 0.02) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tolFt);

test("the drawing's overall sizes come out of its room chain", () => {
  const fp = byId.get("finishing-packing");
  near(ftOf(fp.originM.x + fp.widthM) + 2 * 0.75, 90 + 2.5 / 12);            // 90'-2½" outside
  const store = byId.get("store");
  near(ftOf(store.originM.z + store.depthM) + 2 * 0.75, 77 + 6.5 / 12);      // 77'-6½" outside
  const hr = byId.get("hr-office");
  near(ftOf(hr.originM.x + hr.widthM), 61.5);                                // 61'-6" to the F&P wall
  near(ftOf(byId.get("production").widthM), 61.5);
  near(ftOf(byId.get("finishing-packing-2").originM.z + byId.get("finishing-packing-2").depthM), 52 + 4.5 / 12);
});

test("no two rooms overlap, except the two drawn inside another", () => {
  const solid = rooms.filter((r) => !r.nested);
  for (let i = 0; i < solid.length; i += 1) for (let j = i + 1; j < solid.length; j += 1) {
    const a = solid[i]; const b = solid[j];
    const ox = Math.min(a.originM.x + a.widthM, b.originM.x + b.widthM) - Math.max(a.originM.x, b.originM.x);
    const oz = Math.min(a.originM.z + a.depthM, b.originM.z + b.depthM) - Math.max(a.originM.z, b.originM.z);
    expect({ pair: `${a.id}/${b.id}`, overlap: ox > 0.005 && oz > 0.005 }).toEqual({ pair: `${a.id}/${b.id}`, overlap: false });
  }
  const inside = (inner, outer) => inner.originM.x >= outer.originM.x - 1e-6 && inner.originM.z >= outer.originM.z - 1e-6
    && inner.originM.x + inner.widthM <= outer.originM.x + outer.widthM + 1e-6 && inner.originM.z + inner.depthM <= outer.originM.z + outer.depthM + 1e-6;
  expect(inside(byId.get("toilet"), byId.get("sirs-office"))).toBe(true);
  expect(inside(byId.get("management"), byId.get("production"))).toBe(true);
});

test("every door sits on its room's wall and passes the layout validation", () => {
  for (const room of rooms) {
    for (const door of room.furniture) {
      const onWall = door.xM === 0 || door.zM === 0 || Math.abs(door.xM - room.widthM) < 1e-9 || Math.abs(door.zM - room.depthM) < 1e-9;
      expect({ room: room.id, door: door.id, onWall }).toEqual({ room: room.id, door: door.id, onWall: true });
      const along = door.rotationDeg === 0 ? door.xM : door.zM;
      const length = door.rotationDeg === 0 ? room.widthM : room.depthM;
      expect(along - door.widthM / 2).toBeGreaterThanOrEqual(-1e-6);
      expect(along + door.widthM / 2).toBeLessThanOrEqual(length + 1e-6);
    }
    expect(() => normalizedFurniture(room.furniture, room)).not.toThrow();
  }
  expect(rooms.reduce((n, r) => n + r.furniture.length, 0)).toBe(19);
});

test("openings lie within their walls", () => {
  for (const room of rooms) for (const o of room.openings) {
    const length = o.side === "north" || o.side === "south" ? room.widthM : room.depthM;
    expect(o.fromM).toBeGreaterThanOrEqual(0);
    expect(o.toM).toBeLessThanOrEqual(length + 1e-6);
    expect(o.toM).toBeGreaterThan(o.fromM);
  }
});

test("an origin offset moves the whole floor", () => {
  const moved = groundFloorRooms({ originM: { x: 6, z: 1 } });
  expect(moved[0].originM).toEqual({ x: rooms[0].originM.x + 6, y: 0, z: rooms[0].originM.z + 1 });
});
