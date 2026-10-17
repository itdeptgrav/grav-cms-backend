"use strict";

// The production unit's ground floor (drawing A-101 rev A, 15-10-2026), as
// twin rooms. Every size is the drawing's clear inside dimension in feet and
// inches; positions follow its dimension chains with the drawing's assumed
// walls (9" outer, 4½" partitions), which reproduce its overall sizes:
//   top row 10'-10" + 5'-10" + 11'-9" + 4'-9" + 10'-7" + 15'-10½" + 5 × 4½" = 61'-6"
//   61'-6" + 4½" + 26'-10" + 2 × 9" = 90'-2½" overall width
//   3'-11" + 12'-0" + 8'-9" + 26'-7" + 4'-1" + 18'-10" + 5 × 4½" + 2 × 9" = 77'-6½"
// Factory coordinates: x along the 90'-2½" front (left to right on the
// drawing), z down the drawing, origin at the inner face of the top-left
// corner. The drawing was redrawn from a hand sketch "not to scale", so every
// room is APPROXIMATE until checked on site (its note 5).

const FT = 0.3048;
const P = 4.5 / 12; // partition, ft
const ft = (feet, inches = 0) => feet + inches / 12;
const m = (feet) => Math.round(feet * FT * 1000) / 1000;

// [id, name, x, z, width, depth] in feet.
const ROOMS = [
  ["lobby", "Lobby", 0, 0, ft(10, 10), ft(3, 11) + P + 12 + P + ft(8, 9)],
  ["passage-front", "Passage", ft(10, 10) + P, 0, ft(45, 3) - (ft(10, 10) + P), ft(3, 11)],
  ["front", "Front", ft(11, 2.5), ft(4, 3.5), ft(5, 10), 12],
  ["meeting-hall", "Meeting Hall", ft(17, 5), ft(4, 3.5), ft(11, 9), 12],
  ["passage-designer", "Passage", ft(29, 6.5), ft(4, 3.5), ft(4, 9), 12],
  ["waiting-room", "Waiting Room", ft(34, 8), ft(4, 3.5), ft(10, 7), 12],
  ["sirs-office", "Sir's Office", ft(45, 7.5), 0, ft(15, 10.5), ft(16, 3.5)],
  ["toilet", "Toilet", ft(61, 6) - ft(11, 7), 0, ft(11, 7), ft(5, 5)],
  ["account-room", "Account Room", ft(11, 2.5), ft(16, 8), ft(6, 10), ft(8, 9)],
  ["machine-room", "Machine Room", ft(18, 5), ft(16, 8), ft(8, 2), ft(8, 9)],
  ["designer", "Designer", ft(26, 11.5), ft(16, 8), ft(26, 4), ft(8, 9)],
  ["hr-office", "HR Office", ft(53, 8), ft(16, 8), ft(7, 10), ft(8, 9)],
  ["production", "Production Room", 0, ft(25, 9.5), ft(61, 6), ft(26, 7)],
  ["management", "Management", 0, ft(52, 4.5) - 9, ft(5, 10), 9],
  ["passage-road", "Passage (road)", 0, ft(52, 9), ft(35, 0.5), ft(4, 1)],
  ["store", "Store", 0, ft(57, 2.5), ft(29, 10), ft(18, 10)],
  ["tree-space", "Tree Space", ft(30, 2.5), ft(57, 2.5), ft(4, 10), ft(18, 10)],
  ["cutting", "Cutting", ft(35, 5), ft(52, 9), ft(26, 1), ft(23, 3.5)],
  ["finishing-packing", "Finishing & Packing", ft(61, 10.5), 0, ft(26, 10), ft(27, 5)],
  ["finishing-packing-2", "Finishing & Packing", ft(61, 10.5), ft(27, 5), ft(23, 5), ft(52, 4.5) - ft(27, 5)],
  ["fusing", "Fusing", ft(61, 10.5), ft(52, 9), ft(23, 5), ft(23, 3.5)],
  ["room", "Room", ft(61, 10.5), ft(76, 0.5) + 0.75, 9, ft(5, 5)],
];

// Rooms drawn inside another room (their walls are real inner walls).
const NESTED = new Set(["toilet", "management"]);

// Open joins between rooms: [roomId, side, fromFt, toFt] along that wall
// (north/south from the room's left, east/west from its top).
const OPENINGS = [
  ["lobby", "east", 0, ft(3, 11)],
  ["passage-front", "west", 0, ft(3, 11)],
  ["passage-front", "south", ft(29, 6.5) - (ft(10, 10) + P), ft(34, 3.5) - (ft(10, 10) + P)],
  ["passage-designer", "north", 0, ft(4, 9)],
  ["passage-designer", "south", 0, ft(4, 9)],
  ["passage-designer", "east", 0, 12],
  ["waiting-room", "west", 0, 12],
  ["designer", "north", ft(29, 6.5) - ft(26, 11.5), ft(34, 3.5) - ft(26, 11.5)],
  ["finishing-packing", "south", 0, ft(23, 5)],
  ["finishing-packing-2", "north", 0, ft(23, 5)],
  ["tree-space", "north", 0, ft(4, 10)],
  ["passage-road", "south", ft(30, 2.5), ft(35, 0.5)],
];

// Doors: [roomId, side, centreFt along that wall, widthFt, label]. One item
// per doorway, in the room listed; widths as the drawing's note 4.
const DOORS = [
  ["lobby", "north", 6.9, 4, "Entry"],
  ["passage-front", "north", 30.4, 3, "Door"],
  ["finishing-packing", "north", 17.0, 4, "Door"],
  ["front", "north", 2.0, 3, "Door"],
  ["meeting-hall", "north", 10.0, 3, "Door"],
  ["sirs-office", "west", 9.6, 3, "Door"],
  ["toilet", "west", 2.1, 2.5, "Door"],
  ["account-room", "north", 5.3, 3, "Door"],
  ["machine-room", "north", 6.6, 3, "Door"],
  ["hr-office", "north", 1.5, 3, "Door"],
  ["production", "north", 5.2, 4, "Door to lobby"],
  ["production", "west", 12.6, 4, "Side door"],
  ["management", "north", 2.6, 2.5, "Door"],
  ["production", "east", 19.3, 4, "Door to finishing"],
  ["cutting", "north", 1.6, 3, "Door to production"],
  ["store", "north", 25.5, 3, "Door"],
  ["cutting", "east", 1.6, 3, "Door to fusing"],
  ["fusing", "north", 16.6, 6, "Double door"],
  ["fusing", "south", 2.6, 3, "Door to room"],
];

/**
 * The ground floor as twin rooms, offset by `originM` ({ x, z } metres) so it
 * can sit beside rooms that are not on this drawing.
 */
function groundFloorRooms({ originM = { x: 0, z: 0 }, heightM = 2.75 } = {}) {
  const byId = new Map();
  for (const [id, name, x, z, w, d] of ROOMS) {
    byId.set(id, {
      id, name,
      originM: { x: m(x) + (originM.x || 0), y: 0, z: m(z) + (originM.z || 0) },
      widthM: m(w), depthM: m(d), heightM,
      source: "FLOOR_PLAN_A101_REV_A",
      assumptions: ["Redrawn from a hand sketch that is not to scale; verify sizes on site."],
      ...(NESTED.has(id) ? { nested: true } : {}),
      openings: [],
      furniture: [],
    });
  }
  for (const [id, side, from, to] of OPENINGS) byId.get(id).openings.push({ side, fromM: m(from), toM: m(to) });
  DOORS.forEach(([id, side, at, width, label], index) => {
    const room = byId.get(id);
    const along = m(at);
    const onX = side === "north" || side === "south";
    room.furniture.push({
      id: `door-${index + 1}`, type: "DOOR", label,
      xM: onX ? along : side === "west" ? 0 : room.widthM,
      zM: onX ? (side === "north" ? 0 : room.depthM) : along,
      rotationDeg: onX ? 0 : 90,
      widthM: m(width), depthM: 0.12, heightM: 2.1,
      provenance: "APPROXIMATE",
    });
  });
  return [...byId.values()];
}

module.exports = { groundFloorRooms, ROOMS, OPENINGS, DOORS, FT };
