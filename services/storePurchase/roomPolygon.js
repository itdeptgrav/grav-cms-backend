"use strict";
// services/storePurchase/roomPolygon.js
//
// THE ROOM'S OUTLINE, CHECKED ON THE SERVER.
//
// ── WHY THIS EXISTS WHEN THE EDITOR ALREADY VALIDATES ───────────────────────
// The 2D plan is where a person shapes the room, and it refuses to let them
// draw a boundary that crosses itself. That is a courtesy to the person
// drawing. It is not the guarantee: the layout save is a PUT that any client
// can send, and a stored polygon is what the 3D room, the collision area, the
// walkthrough's walkable floor, the minimap and the camera framing are all
// generated from. A self-crossing boundary reaching the database would
// generate a building that cannot be walked through and a nav mesh with no
// interior, and nothing downstream would have anywhere to report that from.
//
// So the invariants that protect the DATA are enforced here, and the richer
// rules about what a person should be warned of — a rack left outside, a door
// that came off its wall — stay in the editor where they can be acted on.
//
// ── AND THE RECTANGLE IS DERIVED, NEVER SENT ────────────────────────────────
// `widthCm` and `depthCm` predate the polygon and every existing reader uses
// them. They are recomputed here as the polygon's bounding box on every save,
// so a client cannot store a room whose outline and whose stated size disagree
// — which would be two answers to one question, and the reason the 2D plan and
// the 3D warehouse could drift apart in the first place.
//
// Centimetres, x right, z down. The polygon is stored OPEN: the closing wall
// between the last corner and the first is implied.

const { fail } = require("./errors");

const SHAPES = Object.freeze(["RECTANGLE", "L", "U", "CUSTOM"]);
/* A plan is drawn by hand. Two hundred corners is far past any real building
   and well short of anything that would make the geometry checks slow. */
const MAX_POINTS = 200;

const r2 = (n) => Math.round(n * 100) / 100;
const finite = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Corners, cleaned: numbers only, no repeats, not closed. */
function normalisePoints(points) {
  const out = [];
  for (const p of Array.isArray(points) ? points : []) {
    const x = finite(p?.x), z = finite(p?.z);
    /* A corner with a missing coordinate is malformed, not a corner at the
       origin — `Number(null)` is 0, and taking it would draw a wall through
       the building from data that was merely incomplete. */
    if (x === null || z === null) continue;
    const pt = { x: r2(x), z: r2(z) };
    const last = out[out.length - 1];
    if (last && last.x === pt.x && last.z === pt.z) continue;
    out.push(pt);
  }
  while (out.length > 1 && out[0].x === out[out.length - 1].x && out[0].z === out[out.length - 1].z) out.pop();
  return out;
}

const areaCm2 = (p) => {
  let s = 0;
  for (let i = 0; i < p.length; i += 1) {
    const a = p[i], b = p[(i + 1) % p.length];
    s += a.x * b.z - b.x * a.z;
  }
  return Math.abs(s) / 2;
};

/** Do two walls cross, not counting a shared corner? */
function crosses(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x));
  const same = (p, q) => p.x === q.x && p.z === q.z;
  if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return false;
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  const on = (p, q, r) => o(p, q, r) === 0
    && Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x)
    && Math.min(p.z, q.z) <= r.z && r.z <= Math.max(p.z, q.z);
  return on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}

/* ── ONE WAY ROUND ────────────────────────────────────────────────────────
   A polygon drawn by clicking corners comes out whichever way the person went.
   The shape is the same either way, but the SIGN of everything derived from it
   is not: which side of a wall is inside, which way its normal points, and
   whether a triangulator reads a ring as solid or as a hole. Normalising here
   means a stored room has one answer and no reader has to guess — reversing a
   ring keeps its corners, its perimeter and its area, so it is the same room
   said the other way round. Clockwise as the plan is drawn (x right, z down)
   is what every preset already produces. */
function signedArea2(p) {
  let s = 0;
  for (let i = 0; i < p.length; i += 1) {
    const a = p[i], b = p[(i + 1) % p.length];
    s += a.x * b.z - b.x * a.z;
  }
  return s;
}
function orient(p) {
  if (p.length < 3 || signedArea2(p) > 0) return p;
  return [p[0], ...p.slice(1).reverse()];
}

function boundsOf(p) {
  if (!p.length) return { x: 0, z: 0, w: 0, d: 0 };
  const xs = p.map((q) => q.x), zs = p.map((q) => q.z);
  const x = Math.min(...xs), z = Math.min(...zs);
  return { x: r2(x), z: r2(z), w: r2(Math.max(...xs) - x), d: r2(Math.max(...zs) - z) };
}

/**
 * The room a save may store, or a refusal.
 *
 * Throws a VALIDATION failure naming which invariant broke, so the editor can
 * say what is wrong rather than reporting that the save did not work.
 *
 * @returns `{ room: {shape, points, heightCm}, bounds }`
 */
function validateRoom(raw, { fallbackHeightCm = 300 } = {}) {
  const points = normalisePoints(raw?.points);
  if (points.length > MAX_POINTS) {
    throw fail("VALIDATION", `A room may have at most ${MAX_POINTS} corners.`, { reason: "INVALID_ROOM", field: "room.points" });
  }
  if (points.length < 3) {
    throw fail("VALIDATION", "A room needs at least three corners.", { reason: "INVALID_ROOM", field: "room.points" });
  }
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i], b = points[(i + 1) % points.length];
      const c = points[j], d = points[(j + 1) % points.length];
      if (crosses(a, b, c, d)) {
        throw fail("VALIDATION",
          "The room's walls cross each other, so the outline does not enclose one space.",
          { reason: "INVALID_ROOM", field: "room.points", walls: [i, j] });
      }
    }
  }
  if (areaCm2(points) <= 0) {
    throw fail("VALIDATION", "Those corners enclose no floor area.", { reason: "INVALID_ROOM", field: "room.points" });
  }
  const shape = SHAPES.includes(String(raw?.shape || "").toUpperCase())
    ? String(raw.shape).toUpperCase()
    : "CUSTOM";
  const h = finite(raw?.heightCm);
  const heightCm = h !== null && h > 0 ? r2(h) : r2(finite(fallbackHeightCm) ?? 300);
  const wound = orient(points);
  return { room: { shape, points: wound, heightCm }, bounds: boundsOf(wound) };
}

module.exports = { SHAPES, MAX_POINTS, normalisePoints, boundsOf, areaCm2, validateRoom, orient, signedArea2 };
