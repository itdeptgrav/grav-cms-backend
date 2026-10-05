// utils/dxfInspect.js
//
// WHAT A FLAT-PATTERN FILE ACTUALLY PUBLISHES, READ FROM ITS OWN BYTES.
//
// ── WHY THE SERVER READS THE PATTERN AT ALL ─────────────────────────────────
// A DXF is the only artifact in an R&D technical bundle that states the
// garment's geometry in real units. The GLB is a draped surface — beautiful,
// and unable to tell you that the front bodice is 24.77 inches across, because
// a mesh has no pattern pieces in it. The pattern file does, and it names them,
// grades them, puts notches on them and says which way the grain runs.
//
// So this is read server-side, once, at publish time, and what it published is
// STORED. Three reasons, and the third is the one that decides it:
//
//   · A browser parsing 67KB of group codes on every open is work nobody needs
//     done twice, and work that would have to be done identically by the IE
//     projection, which has no browser.
//   · Classification has to be a server decision. A file named `.dxf` whose
//     bytes are a renamed JPEG must be refused before a byte is stored, and a
//     client that classified its own upload would be stating its own case.
//   · A number somebody accepted must not change. Re-parsing on every read
//     means a parser improvement silently restates a measured area that is
//     already in an approved technical bundle. Parsed once, frozen with the
//     publication, is the only version of this that is honest.
//
// ── THE CONVENTION THIS IMPLEMENTS, AND HOW IT IS KNOWN ─────────────────────
// Apparel CAD does not use DXF the way a mechanical drawing does. It uses the
// AAMA layer assignment, standardised as ASTM D6673, where the LAYER NUMBER is
// the semantics: geometry on layer 1 is a piece boundary, a point on layer 13
// is a drill hole, a line on layer 7 is the grainline. The drawing carries no
// other statement of what any entity means.
//
//   | Layer | What the entity IS                                            |
//   |-------|---------------------------------------------------------------|
//   |   1   | piece boundary — the cut line, closed                          |
//   |   2   | turn points — the sharp corners ON that boundary               |
//   |   3   | curve points — the smooth points on it                         |
//   |   4   | notches                                                        |
//   |   5   | grade points                                                   |
//   |   6   | mirror / fold line                                             |
//   |   7   | grainline                                                       |
//   |   8   | internal construction lines                                    |
//   |   9   | stripe reference                                                |
//   |  10   | plaid reference                                                 |
//   |  11   | internal cutout                                                 |
//   |  13   | drill holes                                                    |
//   |  14   | sew line — the SEAM line, where layer 1 is the cut line         |
//   |  15   | annotation text                                                |
//
// A file that uses none of this is a generic CAD drawing. It may still be
// shown — lines are lines — but it is NOT a pattern set, and this module says
// so rather than presenting a collection of polylines as cut pieces.
//
// ── WHAT IS NOT GUESSED ─────────────────────────────────────────────────────
// Absent is absent. A piece with no grainline gets `grainline: null`, never a
// vertical default; a file with no size gets `size: ""`, never "M"; a file
// stating no unit gets `unit: ""` and every length it published stays in
// drawing units with nothing converted. Every one of those is a thing a reader
// must be able to see is missing, and a sensible-looking default is precisely
// how a missing seam allowance becomes a garment cut without one.
"use strict";

/* ═══ THE AAMA / ASTM D6673 LAYER ASSIGNMENT ═══════════════════════════════
 * The whole semantic content of an apparel DXF. Named here so every read below
 * says what it means rather than comparing against a bare number.
 */
const LAYER = Object.freeze({
  BOUNDARY: "1",
  TURN_POINT: "2",
  CURVE_POINT: "3",
  NOTCH: "4",
  GRADE_POINT: "5",
  MIRROR: "6",
  GRAINLINE: "7",
  INTERNAL: "8",
  STRIPE: "9",
  PLAID: "10",
  CUTOUT: "11",
  DRILL: "13",
  SEW_LINE: "14",
  ANNOTATION: "15",
});

/** Read back the other way, for reporting which conventions a file used. */
const LAYER_MEANING = Object.freeze({
  1: "piece boundary", 2: "turn points", 3: "curve points", 4: "notches",
  5: "grade points", 6: "mirror line", 7: "grainline", 8: "internal lines",
  9: "stripe reference", 10: "plaid reference", 11: "internal cutout",
  13: "drill holes", 14: "sew line", 15: "annotation",
});

/**
 * The layers whose presence means "somebody exported this from pattern CAD".
 *
 * Boundary alone is not enough — layer 1 is also just "the first layer" in a
 * mechanical drawing, and a drawing can land on it by accident. These cannot:
 * nothing puts a point on layer 13 unless it means a drill hole.
 */
const APPAREL_LAYERS = Object.freeze([
  LAYER.TURN_POINT, LAYER.CURVE_POINT, LAYER.NOTCH, LAYER.GRADE_POINT,
  LAYER.MIRROR, LAYER.GRAINLINE, LAYER.DRILL, LAYER.SEW_LINE,
]);

/* ═══ LIMITS ═══════════════════════════════════════════════════════════════
 * A parser reading an uploaded file is an attack surface, and the attack is
 * not a clever one — it is a 500MB file of group-code pairs, or a polyline
 * declaring four million vertices. Both are refused by counting.
 */
const LIMITS = Object.freeze({
  BYTES: 40 * 1024 * 1024,
  PAIRS: 4_000_000,
  PIECES: 2000,
  VERTICES_PER_ENTITY: 200_000,
  TOTAL_VERTICES: 2_000_000,
});

/** AAMA writes its file-level and piece-level facts as `KEY: value` TEXT. */
const META_LINE = /^([A-Z][A-Z0-9 _/-]{1,40})\s*:\s*(.*)$/;

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

/**
 * A number, or null — and an ABSENT value is null, not zero.
 *
 * ── THE BUG THIS SHAPE EXISTS TO PREVENT ────────────────────────────────────
 * `Number("")` is `0`, and `Number(undefined)` is `NaN` but `Number(String(
 * undefined).trim())` via an empty string is `0` again. An earlier version of
 * this returned that `0`, and the consequence was precise and invisible: the
 * unit reader tests `$MEASUREMENT === 0` for imperial, so EVERY DXF that stated
 * no unit at all reported inches. A pattern drawn in millimetres and silently
 * read as inches is out by a factor of 25.4, and nothing about the shape on
 * screen reveals it.
 * It is the same failure this whole parser is built against — an absent fact
 * becoming a plausible default — and it got in through a two-line helper.
 */
const num = (v) => {
  const text = str(v);
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

class DxfError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DxfError";
    this.code = code;
  }
}

const refuse = (code, message) => { throw new DxfError(code, message); };

/* ═══ READING THE GROUP-CODE STREAM ════════════════════════════════════════ */

/**
 * A DXF is a flat list of (code, value) pairs, two lines each.
 *
 * ── WHY LATIN-1 AND NOT UTF-8 ───────────────────────────────────────────────
 * DXF pre-dates Unicode and apparel CAD still writes the single-byte encoding
 * its headers declare. Decoding as UTF-8 turns a piece name with an accent into
 * a replacement character — and `latin1` cannot fail, so a byte sequence that
 * is not text becomes text that is obviously not a DXF and is refused by the
 * structure check below rather than throwing inside the decoder.
 */
function readPairs(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
    refuse("DXF_TOO_SMALL", "That file is too small to be a DXF drawing.");
  }
  if (buffer.length > LIMITS.BYTES) {
    refuse("DXF_TOO_LARGE",
      `That pattern file is ${(buffer.length / 1024 / 1024).toFixed(0)}MB and the workspace reads `
      + `${LIMITS.BYTES / 1024 / 1024}MB. Export the sizes you need rather than the whole size range.`);
  }

  /* ── BINARY DXF IS REFUSED, AND IS TOLD WHY ─────────────────────────────
     It is a real format with a real sentinel, and apparel CAD can write it.
     Reading it is a different parser; saying so is better than failing the
     structure check below with "this is not a DXF", which it is. */
  if (buffer.subarray(0, 18).toString("latin1") === "AutoCAD Binary DXF") {
    refuse("DXF_BINARY_UNSUPPORTED",
      "That is a binary DXF. Export the pattern as ASCII DXF — the AAMA/ASTM apparel "
      + "export is ASCII, and binary carries no pattern metadata this workspace can read.");
  }

  const lines = buffer.toString("latin1").split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    /* A group code is always an integer. The first pair of a DXF is `0/SECTION`,
       so a file whose first code is not numeric is not a DXF at all — and that
       is the check that catches a renamed JPEG before anything else runs. */
    if (!/^-?\d+$/.test(code)) {
      if (pairs.length === 0) {
        refuse("DXF_NOT_A_DRAWING",
          "That file is not a readable DXF drawing. Its contents do not begin with DXF group codes, "
          + "whatever it is named.");
      }
      /* Past the start, a malformed pair is a truncated or corrupt file. */
      refuse("DXF_MALFORMED",
        `This DXF becomes unreadable ${pairs.length} values in. The export is incomplete or corrupt.`);
    }
    pairs.push([code, lines[i + 1]]);
    if (pairs.length > LIMITS.PAIRS) {
      refuse("DXF_TOO_LARGE", "This DXF contains more entities than the workspace can read.");
    }
  }
  if (pairs.length < 4) {
    refuse("DXF_NOT_A_DRAWING", "That file contains no readable DXF content.");
  }

  /* ── A COMPLETE DXF ENDS BY SAYING SO ───────────────────────────────────
     The format's last pair is `0/EOF`, and every apparel exporter writes it.
     Without that check a file cut off mid-block parses cleanly into FEWER
     pieces than it has — which is the worst possible failure here, because a
     pattern set missing its last two pieces looks complete, measures
     consistently, and is wrong in a way no reader can see. */
  const last = pairs[pairs.length - 1];
  if (!(last[0] === "0" && str(last[1]).toUpperCase() === "EOF")) {
    refuse("DXF_TRUNCATED",
      "This DXF does not end where a DXF ends, so the upload is incomplete or the file was cut short. "
      + "Some pattern pieces are probably missing — re-export and upload it again.");
  }
  return pairs;
}

/**
 * The pair list, grouped into entities and tagged with the section they are in.
 *
 * Everything downstream reads entities, never pairs — a parser that indexes
 * back into the raw list is one that will eventually read a coordinate out of
 * the wrong entity.
 */
function readEntities(pairs) {
  const out = [];
  let section = "";
  let current = null;
  let sawSection = false;

  for (let i = 0; i < pairs.length; i++) {
    const [code, rawValue] = pairs[i];
    const value = str(rawValue);

    if (code === "0") {
      if (value === "SECTION") {
        /* The section's name is the `2` pair that follows it. */
        section = str(pairs[i + 1]?.[1]);
        sawSection = true;
        current = null;
        continue;
      }
      if (value === "ENDSEC") { section = ""; current = null; continue; }
      if (value === "EOF") { current = null; continue; }
      current = { type: value, section, codes: [] };
      out.push(current);
      continue;
    }
    if (current) current.codes.push([code, value]);
    else if (section === "HEADER") {
      /* HEADER variables are bare pairs with no entity around them. Held as a
         pseudo-entity so the reader below has one shape to work with. */
      out.push({ type: "$HEADER_PAIR", section, codes: [[code, value]] });
    }
  }

  if (!sawSection) {
    refuse("DXF_NOT_A_DRAWING",
      "That file carries DXF group codes but no DXF sections, so there is no drawing in it.");
  }
  return out;
}

/** The first value for a group code on one entity. */
const codeOf = (entity, code) => {
  const found = entity.codes.find((pair) => pair[0] === code);
  return found ? found[1] : undefined;
};

/** Every value for a group code — a LAYER table row, an extended name. */
const codesOf = (entity, code) =>
  entity.codes.filter((pair) => pair[0] === code).map((pair) => pair[1]);

/* ═══ GEOMETRY ═════════════════════════════════════════════════════════════ */

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * The closest point to `p` on the segment `a`–`b`, and how far away it is.
 *
 * ── WHY NEAREST-VERTEX IS NOT GOOD ENOUGH ───────────────────────────────────
 * Two measurements here project a point onto an outline: the seam allowance
 * (how far the sewing line sits inside the cut line) and notch spacing (how far
 * apart two notches are ALONG the edge). An earlier version of both used the
 * nearest outline VERTEX, on the reasoning that an apparel outline is published
 * at a hundred-odd points so a vertex is a fraction of a millimetre of arc.
 * That is true of the CLO exports read here and it is not true in general, and
 * where it fails it fails large: on a four-point rectangle, a sewing line inset
 * by 10 measured 14.14 — the diagonal to the corner — and two notches 80 apart
 * on one edge measured 220, because each snapped to a different corner.
 * Projecting onto the segment is the correct computation at any point density,
 * so there is no outline for which these numbers are quietly wrong.
 */
function projectOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared === 0) return { point: { x: a.x, y: a.y }, distance: dist(p, a), t: 0 };
  let t = (((p.x - a.x) * dx) + ((p.y - a.y) * dy)) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const point = { x: a.x + (t * dx), y: a.y + (t * dy) };
  return { point, distance: dist(p, point), t };
}

/** The shortest distance from `p` to a closed outline, measured to its edges. */
function distanceToOutline(p, outline) {
  let best = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const found = projectOnSegment(p, outline[i], outline[(i + 1) % outline.length]);
    if (found.distance < best) best = found.distance;
  }
  return best;
}

/**
 * The area a closed outline encloses, by the shoelace sum.
 *
 * Absolute, because winding order is the exporter's business and a negative
 * area is never the answer to "how much cloth is this piece".
 */
function polygonArea(points) {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += (a.x * b.y) - (b.x * a.y);
  }
  return Math.abs(sum) / 2;
}

function pathLength(points, closed) {
  let total = 0;
  const last = closed ? points.length : points.length - 1;
  for (let i = 0; i < last; i++) total += dist(points[i], points[(i + 1) % points.length]);
  return total;
}

function boundsOf(points) {
  if (!points.length) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * A bulged polyline segment, turned into the arc it actually is.
 *
 * ── WHY THIS IS NOT OPTIONAL ────────────────────────────────────────────────
 * DXF stores a curved polyline segment as a straight pair of vertices plus a
 * BULGE on the first — the tangent of a quarter of the included angle. Ignore
 * it and every curve becomes its own chord: an armhole measures short, a
 * neckline measures shorter, and the piece area comes out under. The error is
 * small per segment and always in the same direction, so it accumulates into a
 * pattern that looks right and consumes less cloth than it does.
 *
 * Tessellated at roughly two degrees, which is finer than the point spacing of
 * any apparel export seen here and well below the tolerance anybody cuts to.
 */
function tessellateBulge(from, to, bulge) {
  const chord = dist(from, to);
  if (!chord || !Number.isFinite(bulge) || Math.abs(bulge) < 1e-9) return [];

  const included = 4 * Math.atan(Math.abs(bulge));
  const radius = chord / (2 * Math.sin(included / 2));
  if (!Number.isFinite(radius) || radius <= 0) return [];

  /* The centre sits off the chord's midpoint, on the side the bulge's sign says. */
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const apothem = Math.sqrt(Math.max(0, (radius * radius) - ((chord / 2) * (chord / 2))));
  const ux = (to.x - from.x) / chord;
  const uy = (to.y - from.y) / chord;
  const side = bulge > 0 ? 1 : -1;
  const concave = Math.abs(bulge) > 1 ? -1 : 1;
  const cx = midX - (uy * -1 * apothem * side * concave);
  const cy = midY - (ux * apothem * side * concave);

  const startAngle = Math.atan2(from.y - cy, from.x - cx);
  let sweep = included * side;
  if (Math.abs(bulge) > 1) sweep = (2 * Math.PI - included) * side;

  const steps = Math.max(2, Math.min(180, Math.ceil(Math.abs(sweep) / (Math.PI / 90))));
  const points = [];
  for (let i = 1; i < steps; i++) {
    const angle = startAngle + (sweep * (i / steps));
    points.push({ x: cx + (radius * Math.cos(angle)), y: cy + (radius * Math.sin(angle)) });
  }
  return points;
}

/** An ARC entity, as the points along it. */
function arcPoints(cx, cy, radius, startDeg, endDeg) {
  let sweep = endDeg - startDeg;
  while (sweep <= 0) sweep += 360;
  const steps = Math.max(2, Math.min(360, Math.ceil(sweep / 2)));
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const angle = ((startDeg + (sweep * (i / steps))) * Math.PI) / 180;
    points.push({ x: cx + (radius * Math.cos(angle)), y: cy + (radius * Math.sin(angle)) });
  }
  return points;
}

/* ═══ POLYLINES ════════════════════════════════════════════════════════════ */

/**
 * An old-style POLYLINE and the VERTEX entities that follow it until SEQEND.
 *
 * Apparel CAD writes this form rather than LWPOLYLINE, including every CLO
 * export read while building this. Both are supported; this is the one that
 * actually turns up.
 */
function readPolyline(entities, startIndex, budget) {
  const head = entities[startIndex];
  const closed = (num(codeOf(head, "70")) & 1) === 1;
  const layer = str(codeOf(head, "8"));
  const points = [];
  let index = startIndex + 1;
  let pendingBulge = 0;

  for (; index < entities.length; index++) {
    const entity = entities[index];
    if (entity.type === "SEQEND") { index++; break; }
    if (entity.type !== "VERTEX") break;

    const x = num(codeOf(entity, "10"));
    const y = num(codeOf(entity, "20"));
    if (x === null || y === null) continue;

    /* A bulge belongs to the segment LEAVING the vertex that carries it, so
       the arc is emitted when the next vertex arrives, not when this one does. */
    if (pendingBulge && points.length) {
      points.push(...tessellateBulge(points[points.length - 1], { x, y }, pendingBulge));
    }
    points.push({ x, y });
    pendingBulge = num(codeOf(entity, "42")) || 0;

    if (points.length > LIMITS.VERTICES_PER_ENTITY) {
      refuse("DXF_TOO_LARGE", "A single outline in this DXF has more points than the workspace can read.");
    }
  }

  /* The closing segment can be bulged too, and it is the armhole often enough
     to matter. */
  if (closed && pendingBulge && points.length > 1) {
    points.push(...tessellateBulge(points[points.length - 1], points[0], pendingBulge));
  }

  budget.count += points.length;
  return { layer, closed, points, nextIndex: index };
}

/** The compact form. Same output shape, so nothing downstream knows which. */
function readLwPolyline(entity, budget) {
  const closed = (num(codeOf(entity, "70")) & 1) === 1;
  const layer = str(codeOf(entity, "8"));
  const points = [];
  let pending = null;
  let pendingBulge = 0;

  const flush = (x, y) => {
    if (pending) {
      if (pendingBulge) points.push(...tessellateBulge(pending, { x, y }, pendingBulge));
      pendingBulge = 0;
    }
    points.push({ x, y });
    pending = { x, y };
  };

  let x = null;
  for (const [code, value] of entity.codes) {
    if (code === "10") {
      if (x !== null) flush(x, 0);
      x = num(value);
    } else if (code === "20" && x !== null) {
      flush(x, num(value) ?? 0);
      x = null;
    } else if (code === "42") {
      pendingBulge = num(value) || 0;
    }
  }
  if (closed && pendingBulge && points.length > 1) {
    points.push(...tessellateBulge(points[points.length - 1], points[0], pendingBulge));
  }
  budget.count += points.length;
  return { layer, closed, points };
}

/* ═══ WHAT A BLOCK OF ENTITIES SAYS ════════════════════════════════════════ */

/**
 * Collect one pattern piece's geometry, sorted by what the layer means.
 *
 * Takes a window of the entity list — a BLOCK's contents, or the whole
 * ENTITIES section for a file that drew its pieces without blocks.
 */
function collectGeometry(entities, from, to, budget) {
  const geometry = {
    boundaries: [], sewLines: [], internals: [], cutouts: [], mirrors: [],
    grainlines: [], notches: [], drills: [], gradePoints: [], turnPoints: [],
    curvePoints: [], stripes: [], plaids: [], texts: [], other: [],
    layersSeen: new Set(),
  };

  const put = (layer, shape) => {
    switch (layer) {
      case LAYER.BOUNDARY: geometry.boundaries.push(shape); break;
      case LAYER.SEW_LINE: geometry.sewLines.push(shape); break;
      case LAYER.INTERNAL: geometry.internals.push(shape); break;
      case LAYER.CUTOUT: geometry.cutouts.push(shape); break;
      case LAYER.MIRROR: geometry.mirrors.push(shape); break;
      case LAYER.GRAINLINE: geometry.grainlines.push(shape); break;
      case LAYER.NOTCH: geometry.notches.push(shape); break;
      case LAYER.STRIPE: geometry.stripes.push(shape); break;
      case LAYER.PLAID: geometry.plaids.push(shape); break;
      default: geometry.other.push({ ...shape, layer }); break;
    }
  };

  for (let i = from; i < to; i++) {
    const entity = entities[i];
    const layer = str(codeOf(entity, "8"));
    if (layer) geometry.layersSeen.add(layer);
    if (budget.count > LIMITS.TOTAL_VERTICES) {
      refuse("DXF_TOO_LARGE", "This DXF carries more geometry than the workspace can read.");
    }

    switch (entity.type) {
      case "POLYLINE": {
        const read = readPolyline(entities, i, budget);
        i = read.nextIndex - 1;
        if (read.points.length) put(read.layer, { points: read.points, closed: read.closed });
        break;
      }
      case "LWPOLYLINE": {
        const read = readLwPolyline(entity, budget);
        if (read.points.length) put(read.layer, { points: read.points, closed: read.closed });
        break;
      }
      case "LINE": {
        const a = { x: num(codeOf(entity, "10")), y: num(codeOf(entity, "20")) };
        const b = { x: num(codeOf(entity, "11")), y: num(codeOf(entity, "21")) };
        if (a.x !== null && a.y !== null && b.x !== null && b.y !== null) {
          budget.count += 2;
          put(layer, { points: [a, b], closed: false });
        }
        break;
      }
      case "ARC": {
        const cx = num(codeOf(entity, "10"));
        const cy = num(codeOf(entity, "20"));
        const radius = num(codeOf(entity, "40"));
        const start = num(codeOf(entity, "50")) ?? 0;
        const end = num(codeOf(entity, "51")) ?? 360;
        if (cx !== null && cy !== null && radius) {
          const points = arcPoints(cx, cy, radius, start, end);
          budget.count += points.length;
          put(layer, { points, closed: false });
        }
        break;
      }
      case "CIRCLE": {
        const cx = num(codeOf(entity, "10"));
        const cy = num(codeOf(entity, "20"));
        const radius = num(codeOf(entity, "40"));
        if (cx !== null && cy !== null && radius) {
          /* A circle on the drill layer IS a drill hole, drawn at its real
             size rather than as a bare point. Its centre is the hole. */
          if (layer === LAYER.DRILL) {
            geometry.drills.push({ x: cx, y: cy, radius });
          } else {
            const points = arcPoints(cx, cy, radius, 0, 360);
            budget.count += points.length;
            put(layer, { points, closed: true });
          }
        }
        break;
      }
      case "POINT": {
        const x = num(codeOf(entity, "10"));
        const y = num(codeOf(entity, "20"));
        if (x === null || y === null) break;
        budget.count += 1;
        if (layer === LAYER.TURN_POINT) geometry.turnPoints.push({ x, y });
        else if (layer === LAYER.CURVE_POINT) geometry.curvePoints.push({ x, y });
        else if (layer === LAYER.NOTCH) geometry.notches.push({ points: [{ x, y }], closed: false });
        else if (layer === LAYER.DRILL) geometry.drills.push({ x, y, radius: null });
        else if (layer === LAYER.GRADE_POINT) geometry.gradePoints.push({ x, y });
        break;
      }
      case "TEXT":
      case "MTEXT": {
        const body = codesOf(entity, "1").join("").trim();
        if (body) {
          geometry.texts.push({
            text: body,
            layer,
            x: num(codeOf(entity, "10")),
            y: num(codeOf(entity, "20")),
          });
        }
        break;
      }
      case "SPLINE": {
        /* ── A SPLINE IS READ AS ITS CONTROL HULL, AND SAYS SO ────────────
           Evaluating a NURBS curve properly needs its knot vector and the
           basis functions, and getting that subtly wrong produces a curve
           that looks plausible and measures wrong. The control points are the
           honest approximation, the piece carries a warning naming the
           imprecision, and nothing presents a spline-built outline as a
           verified length. No apparel export read here uses them. */
        const points = [];
        let x = null;
        for (const [code, value] of entity.codes) {
          if (code === "10") x = num(value);
          else if (code === "20" && x !== null) { points.push({ x, y: num(value) ?? 0 }); x = null; }
        }
        if (points.length) {
          budget.count += points.length;
          put(layer, { points, closed: false, approximated: "spline-control-hull" });
        }
        break;
      }
      default:
        break;
    }
  }

  return geometry;
}

/** `KEY: value` lines, as an object. AAMA's own metadata format. */
function readMetaTexts(texts) {
  const meta = {};
  const plain = [];
  for (const entry of texts) {
    const match = META_LINE.exec(entry.text);
    if (match) {
      const key = match[1].trim().toUpperCase();
      /* First statement wins: a later duplicate is a second annotation of the
         same fact, and overwriting would let the furthest-down text decide. */
      if (!(key in meta)) meta[key] = match[2].trim();
    } else {
      plain.push(entry.text);
    }
  }
  return { meta, plain };
}

/* ═══ UNITS ════════════════════════════════════════════════════════════════ */

/** `$INSUNITS`, which only some exporters write. */
const INSUNITS = Object.freeze({
  1: "in", 2: "ft", 4: "mm", 5: "cm", 6: "m",
});

const UNIT_IN_MM = Object.freeze({ mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 });

/**
 * What one drawing unit is, and HOW THAT IS KNOWN.
 *
 * ── WHY THE PROVENANCE TRAVELS WITH IT ──────────────────────────────────────
 * Three different things can state the unit and they disagree often enough to
 * matter. AAMA's own `UNITS:` text is the apparel statement and is the most
 * trustworthy in a pattern file. `$INSUNITS` is AutoCAD's and is frequently
 * absent or left at 0. `$MEASUREMENT` distinguishes imperial from metric and
 * says nothing about which metric unit.
 *
 * So the answer carries where it came from, and "nothing said" is one of the
 * answers rather than a reason to assume millimetres. A pattern silently read
 * as millimetres when it was drawn in inches is out by a factor of 25.4, which
 * is not an error anybody notices from a shape on a screen.
 */
function readUnit(headerMeta, fileMeta) {
  const declared = str(fileMeta["UNITS"]).toUpperCase();
  if (declared) {
    /* AAMA says ENGLISH or METRIC. ENGLISH is inches; METRIC is millimetres —
       the standard's own metric unit, not centimetres. */
    if (declared.startsWith("ENGLISH") || declared === "IMPERIAL") {
      return { unit: "in", source: "aama-units-text", declared };
    }
    if (declared.startsWith("METRIC")) {
      return { unit: "mm", source: "aama-units-text", declared };
    }
    for (const unit of ["mm", "cm", "in", "m"]) {
      if (declared.toLowerCase() === unit) return { unit, source: "aama-units-text", declared };
    }
    /* It said something and it is not something we know. Reported, not guessed. */
    return { unit: "", source: "aama-units-unrecognised", declared };
  }

  const insunits = num(headerMeta.$INSUNITS);
  if (insunits && INSUNITS[insunits]) {
    return { unit: INSUNITS[insunits], source: "header-insunits", declared: String(insunits) };
  }
  const measurement = num(headerMeta.$MEASUREMENT);
  if (measurement === 0) return { unit: "in", source: "header-measurement", declared: "0 (imperial)" };
  if (measurement === 1) return { unit: "mm", source: "header-measurement", declared: "1 (metric)" };

  return { unit: "", source: "none", declared: "" };
}

/* ═══ GRAINLINE, NOTCHES, MIRRORS ══════════════════════════════════════════ */

/**
 * The grain, as a direction and an angle.
 *
 * Reported as the angle off vertical, because that is the number a cutting
 * room acts on: 0 is with the warp, 90 is across it, 45 is a true bias, and
 * anything else is a piece somebody has to be told about.
 */
function readGrainline(shapes) {
  if (!shapes.length) return null;
  /* The longest, where an exporter wrote an arrowhead as extra segments. */
  const best = shapes
    .map((shape) => ({ shape, length: pathLength(shape.points, false) }))
    .sort((a, b) => b.length - a.length)[0];
  const points = best.shape.points;
  if (points.length < 2) return null;

  const from = points[0];
  const to = points[points.length - 1];
  const degrees = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  /* Folded into a half-turn: a grainline is an axis, not an arrow, and 270°
     and 90° are the same grain. */
  let axis = degrees % 180;
  if (axis < 0) axis += 180;
  const offVertical = Math.abs(90 - axis);

  let direction = "angled";
  if (offVertical <= 1) direction = "lengthwise";
  else if (offVertical >= 89) direction = "crosswise";
  else if (Math.abs(offVertical - 45) <= 1) direction = "bias";

  return {
    from: { x: from.x, y: from.y },
    to: { x: to.x, y: to.y },
    length: best.length,
    angleDegrees: Number(axis.toFixed(3)),
    offVerticalDegrees: Number(offVertical.toFixed(3)),
    direction,
  };
}

/**
 * Notches, as positions on the piece.
 *
 * A notch is drawn three ways by three vendors — a bare point, a short slit of
 * two points, or a V of three. All three are reduced to the position that
 * matters plus what was actually drawn, because "where is the notch" is the
 * question every consumer asks and the shape is the exporter's styling.
 */
function readNotches(shapes) {
  return shapes.map((shape) => {
    const points = shape.points || [];
    if (!points.length) return null;
    const sumX = points.reduce((acc, p) => acc + p.x, 0);
    const sumY = points.reduce((acc, p) => acc + p.y, 0);
    return {
      at: { x: sumX / points.length, y: sumY / points.length },
      form: points.length === 1 ? "point" : (points.length === 2 ? "slit" : "v"),
      points: points.map((p) => ({ x: p.x, y: p.y })),
      depth: points.length > 1 ? pathLength(points, false) : null,
    };
  }).filter(Boolean);
}

/* ═══ ONE PATTERN PIECE ════════════════════════════════════════════════════ */

/**
 * Turn a block of geometry into the piece it describes.
 *
 * ── THE RULE THIS FUNCTION EXISTS TO ENFORCE ────────────────────────────────
 * Every field is either read from the file or is `null`/`""`. There is no
 * branch in here that supplies a plausible value for something the file did
 * not say, and the places that would most tempt one — quantity, seam
 * allowance, material, size — are exactly the places where a default would be
 * acted on as though somebody had stated it.
 */
function buildPiece(geometry, { blockName, index, insert }) {
  const { meta, plain } = readMetaTexts(geometry.texts);

  /* The outline is the largest closed boundary: an exporter that wrote the
     piece and an annotation frame on the same layer wrote the piece bigger. */
  const closedBoundaries = geometry.boundaries.filter((b) => b.points.length >= 3);
  const ranked = closedBoundaries
    .map((b) => ({ shape: b, area: polygonArea(b.points) }))
    .sort((a, b) => b.area - a.area);
  const outlineShape = ranked[0]?.shape || null;
  const outline = outlineShape ? outlineShape.points : [];

  const bounds = boundsOf(outline);
  const area = outline.length >= 3 ? polygonArea(outline) : null;
  const perimeter = outline.length >= 2 ? pathLength(outline, true) : null;

  /* ── THE SEAM LINE, AND WHY ITS ABSENCE IS NOT A ZERO ──────────────────
     Layer 14 is the sew line where layer 1 is the cut line, and the gap
     between them IS the seam allowance. A file with only layer 1 has
     published ONE line and has not said whether it is the cut line or the
     sewing line — so the allowance is unpublished, and `0` would state that
     the piece is cut on the seam. */
  const sewLine = geometry.sewLines.filter((s) => s.points.length >= 3)
    .map((s) => ({ shape: s, area: polygonArea(s.points) }))
    .sort((a, b) => b.area - a.area)[0]?.shape || null;

  let seamAllowance = null;
  if (sewLine && outline.length >= 3) {
    /* The mean distance from each sewing-line point to the cut line. Mean
       rather than one sample, because an allowance is often not uniform and a
       single probe would report whichever edge it happened to land on. */
    const gaps = sewLine.points
      .map((p) => distanceToOutline(p, outline))
      .filter((d) => Number.isFinite(d));
    if (gaps.length) {
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const spread = Math.max(...gaps) - Math.min(...gaps);
      seamAllowance = {
        value: Number(mean.toFixed(4)),
        uniform: spread < Math.max(0.02, mean * 0.1),
        minimum: Number(Math.min(...gaps).toFixed(4)),
        maximum: Number(Math.max(...gaps).toFixed(4)),
        source: "measured-between-cut-and-sew-lines",
      };
    }
  } else if (meta["SEAM ALLOWANCE"]) {
    const stated = num(meta["SEAM ALLOWANCE"]);
    if (stated !== null) {
      seamAllowance = { value: stated, uniform: true, minimum: stated, maximum: stated, source: "stated-in-file" };
    }
  }

  /* ── THE PIECE'S NAME, AND WHETHER ANYBODY CHOSE IT ────────────────────
     `Pattern_636968` is an identifier CLO counted out, not a name a patternmaker
     wrote, and the difference decides whether this piece can be matched to a
     3D component by name at all. So the fact is recorded rather than the
     distinction being lost in a string. */
  const statedName = str(meta["PIECE NAME"] || meta["NAME"] || meta["PIECE"]);
  const nameFromBlock = str(blockName);
  const name = statedName || nameFromBlock;
  const generatedName = !name || /^(pattern|piece|block|part|untitled|unnamed)[\s._-]*\d*$/i.test(name);

  const size = str(meta["SIZE"]);
  const quantityRaw = meta["QUANTITY"] ?? meta["QTY"] ?? meta["PIECE QUANTITY"];
  const quantity = quantityRaw === undefined ? null : num(quantityRaw);

  const grainline = readGrainline(geometry.grainlines);
  const notches = readNotches(geometry.notches);

  /* ── MIRROR AND CUT-ON-FOLD ARE DIFFERENT CLAIMS ───────────────────────
     A mirror line on layer 6 says this piece is drawn as half and cut as a
     whole on the fold. A `MIRROR:`/`PAIR:` text says it is cut twice, mirrored
     — a left and a right. Both are published facts and neither implies the
     other, so they are kept apart and both default to unpublished. */
  const mirrorLine = geometry.mirrors.find((m) => m.points.length >= 2) || null;
  const foldText = str(meta["FOLD"] || meta["CUT ON FOLD"] || meta["ON FOLD"]).toUpperCase();
  const pairText = str(meta["MIRROR"] || meta["PAIR"] || meta["PAIRED"]).toUpperCase();
  const truthy = (v) => ["YES", "Y", "TRUE", "1", "ON"].includes(v);

  const cutOnFold = mirrorLine ? true : (foldText ? truthy(foldText) : null);
  const mirrored = pairText ? truthy(pairText) : null;

  return {
    /* ── IDENTITY ──────────────────────────────────────────────────────── */
    /* The file's own stable handle for this piece, where it published one.
       This is the first rung of the 2D→3D mapping ladder and the only rung
       that is not a guess, so it is read from every key a vendor might use
       and is empty rather than invented when none is present. */
    publishedId: str(meta["PIECE ID"] || meta["ID"] || meta["PATTERN ID"] || meta["PIECE CODE"]),
    blockName: nameFromBlock,
    name,
    generatedName,
    index,

    /* ── WHAT IT IS ────────────────────────────────────────────────────── */
    size,
    quantity,
    /* Material and the shell/lining question are NOT inferred from a name.
       "Pattern_636968" is not a shell piece because it is big, and a wrong
       material classification propagates into a consumption figure. */
    material: str(meta["MATERIAL"] || meta["FABRIC"] || meta["FABRIC TYPE"] || meta["FABRIC CATEGORY"]),
    componentClass: readComponentClass(meta),
    description: str(meta["DESCRIPTION"] || meta["COMMENT"]),
    annotations: plain.slice(0, 20),

    /* ── GEOMETRY ──────────────────────────────────────────────────────── */
    outline: outline.map((p) => ({ x: p.x, y: p.y })),
    outlineClosed: Boolean(outlineShape?.closed),
    /* Extra closed boundaries past the first. Kept, because a piece with two
       is a file worth asking about rather than one to silently trim. */
    extraBoundaries: ranked.slice(1).map((entry) => entry.shape.points.map((p) => ({ x: p.x, y: p.y }))),
    sewLine: sewLine ? sewLine.points.map((p) => ({ x: p.x, y: p.y })) : null,
    internalLines: geometry.internals.map((line) => ({
      points: line.points.map((p) => ({ x: p.x, y: p.y })),
      closed: Boolean(line.closed),
      length: Number(pathLength(line.points, Boolean(line.closed)).toFixed(4)),
    })),
    cutouts: geometry.cutouts.map((c) => c.points.map((p) => ({ x: p.x, y: p.y }))),
    grainline,
    notches,
    drillPoints: geometry.drills.map((d) => ({ x: d.x, y: d.y, radius: d.radius })),
    turnPoints: geometry.turnPoints.map((p) => ({ x: p.x, y: p.y })),
    curvePoints: geometry.curvePoints.map((p) => ({ x: p.x, y: p.y })),
    gradePoints: geometry.gradePoints.map((p) => ({ x: p.x, y: p.y })),
    mirrorLine: mirrorLine ? mirrorLine.points.map((p) => ({ x: p.x, y: p.y })) : null,
    stripeReference: geometry.stripes.map((s) => s.points.map((p) => ({ x: p.x, y: p.y }))),
    plaidReference: geometry.plaids.map((s) => s.points.map((p) => ({ x: p.x, y: p.y }))),

    /* ── CONSTRUCTION FACTS ────────────────────────────────────────────── */
    seamAllowance,
    cutOnFold,
    mirrored,
    rotation: num(meta["ROTATION"]),

    /* ── MEASURED, IN DRAWING UNITS ────────────────────────────────────── */
    /* Converted to a real unit by the caller, which is the only place that
       knows whether the file stated one. A piece never carries millimetres
       it was not given. */
    width: bounds ? Number(bounds.width.toFixed(4)) : null,
    height: bounds ? Number(bounds.height.toFixed(4)) : null,
    area: area === null ? null : Number(area.toFixed(4)),
    perimeter: perimeter === null ? null : Number(perimeter.toFixed(4)),
    bounds: bounds ? {
      minX: Number(bounds.minX.toFixed(4)), minY: Number(bounds.minY.toFixed(4)),
      maxX: Number(bounds.maxX.toFixed(4)), maxY: Number(bounds.maxY.toFixed(4)),
    } : null,
    /* Where the drawing placed it, so a 2D view can lay the pieces out as the
       file did rather than stacking them all at the origin. */
    insert: insert || null,

    layersUsed: [...geometry.layersSeen].sort((a, b) => (num(a) ?? 0) - (num(b) ?? 0)),
    approximated: outlineShape?.approximated || null,
  };
}

/**
 * Shell, lining, interlining or rib — only when the file says so.
 *
 * Read from an explicit statement and never from the piece's name or size. A
 * piece called "front" is not shell because of the word, and a classification
 * nobody published is a question for a patternmaker rather than a gap for this
 * parser to fill.
 */
function readComponentClass(meta) {
  const stated = str(
    meta["COMPONENT"] || meta["PIECE TYPE"] || meta["CLASS"]
    || meta["COMPONENT CLASS"] || meta["FABRIC TYPE"] || meta["LAYER TYPE"],
  ).toLowerCase();
  if (!stated) return "";
  if (/\binterlining|\bfusing|\bfusible/.test(stated)) return "interlining";
  if (/\blining\b/.test(stated)) return "lining";
  if (/\brib\b|\bribbing\b/.test(stated)) return "rib";
  if (/\bshell\b|\bself\b|\bmain\b|\bouter\b/.test(stated)) return "shell";
  if (/\btrim\b/.test(stated)) return "trim";
  if (/\bpocket\s*bag|\bpocketing\b/.test(stated)) return "pocketing";
  /* It said something this parser does not recognise. Kept verbatim rather
     than discarded, and never mapped to a class it might not be. */
  return "";
}

/* ═══ GRADING ══════════════════════════════════════════════════════════════ */

/**
 * The size range, and the increments between sizes — WHERE THE FILE HAS THEM.
 *
 * ── WHAT COUNTS AS GRADING AND WHAT DOES NOT ────────────────────────────────
 * A graded DXF publishes the same piece at several sizes, so a piece name
 * appearing at S, M and L is a graded piece and the differences between its
 * measurements are its increments. A single-size export is not graded, and
 * reporting one size as "grading with one step" would make a sample-size file
 * look like a production-ready range. So a file with one size says so.
 *
 * Grade POINTS on layer 5 are a different fact — the points a grader moves —
 * and they are published per piece whether or not more than one size is in the
 * file. Both are reported, separately, because a file can have either without
 * the other.
 */
function readGrading(pieces) {
  const byName = new Map();
  for (const piece of pieces) {
    /* Grouped by the name WITHOUT the size, which is what identifies "the same
       piece at another size". The block name carries the suffix in every
       apparel export seen here. */
    const key = (piece.name || piece.blockName || `#${piece.index}`)
      .replace(new RegExp(`[_\\s-]*${escapeRegExp(piece.size)}$`, "i"), "")
      .trim()
      .toLowerCase() || `#${piece.index}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(piece);
  }

  const sizes = [...new Set(pieces.map((p) => p.size).filter(Boolean))];
  const graded = [];

  for (const [key, group] of byName) {
    const sized = group.filter((p) => p.size);
    if (sized.length < 2) continue;
    const steps = sized
      .slice()
      .sort((a, b) => (a.index - b.index))
      .map((p) => ({
        size: p.size,
        width: p.width, height: p.height, area: p.area, perimeter: p.perimeter,
      }));
    const increments = [];
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1];
      const next = steps[i];
      increments.push({
        fromSize: prev.size,
        toSize: next.size,
        width: numericDelta(prev.width, next.width),
        height: numericDelta(prev.height, next.height),
        area: numericDelta(prev.area, next.area),
        perimeter: numericDelta(prev.perimeter, next.perimeter),
        /* A grade rule name, only where the file published one. */
        rule: "",
      });
    }
    graded.push({ piece: key, sizes: steps.map((s) => s.size), steps, increments });
  }

  return {
    /* `false` is a statement about this file, not about the pattern. */
    graded: graded.length > 0,
    sizes,
    sizeCount: sizes.length,
    pieces: graded,
    gradePointsPublished: pieces.some((p) => p.gradePoints.length > 0),
  };
}

const numericDelta = (a, b) =>
  (a === null || b === null || a === undefined || b === undefined)
    ? null
    : Number((b - a).toFixed(4));

const escapeRegExp = (v) => str(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ═══ THE READ ═════════════════════════════════════════════════════════════ */

/**
 * READ A FLAT-PATTERN DXF.
 *
 * @param   {Buffer} buffer the uploaded file, whole
 * @returns {object} what the file published, and what it did not
 * @throws  {DxfError} when the bytes are not a readable DXF at all
 */
function inspectDxf(buffer) {
  const pairs = readPairs(buffer);
  const entities = readEntities(pairs);
  const budget = { count: 0 };
  const warnings = [];

  /* ── THE HEADER ────────────────────────────────────────────────────────
     Variables come as a `9/$NAME` pair followed by the value's own pair, so
     the name and the value are two entries apart in a flat list. */
  const headerMeta = {};
  const headerPairs = entities.filter((e) => e.section === "HEADER").flatMap((e) => e.codes);
  for (let i = 0; i < headerPairs.length; i++) {
    if (headerPairs[i][0] === "9") {
      const name = str(headerPairs[i][1]).toUpperCase();
      const value = headerPairs[i + 1]?.[1];
      if (name && value !== undefined && !(name in headerMeta)) headerMeta[name] = str(value);
    }
  }

  /* ── THE LAYER TABLE ──────────────────────────────────────────────────
     Names only. The semantics are the NUMBER, per the AAMA assignment, and a
     layer the table describes as "Boundary" is not treated as one because of
     the word. */
  const layerNames = entities
    .filter((e) => e.section === "TABLES" && e.type === "LAYER")
    .map((e) => str(codeOf(e, "2")))
    .filter(Boolean);

  /* ── WHERE EACH BLOCK STARTS AND STOPS ────────────────────────────────── */
  const blocks = [];
  for (let i = 0; i < entities.length; i++) {
    if (entities[i].section !== "BLOCKS" || entities[i].type !== "BLOCK") continue;
    const name = str(codeOf(entities[i], "2"));
    let end = i + 1;
    while (end < entities.length && entities[end].type !== "ENDBLK") end++;
    blocks.push({ name, from: i + 1, to: end });
    i = end;
  }

  /* ── WHERE THE DRAWING PLACED EACH BLOCK ──────────────────────────────
     An INSERT is the pieces' layout on the plotting sheet. Read so a 2D view
     can show the pattern the way the file arranged it; absent, a piece keeps
     its own coordinates, which is also what the file said. */
  const inserts = new Map();
  for (const entity of entities) {
    if (entity.section !== "ENTITIES" || entity.type !== "INSERT") continue;
    const name = str(codeOf(entity, "2"));
    if (!name) continue;
    const list = inserts.get(name) || [];
    list.push({
      x: num(codeOf(entity, "10")) ?? 0,
      y: num(codeOf(entity, "20")) ?? 0,
      rotation: num(codeOf(entity, "50")) ?? 0,
      scaleX: num(codeOf(entity, "41")) ?? 1,
      scaleY: num(codeOf(entity, "42")) ?? 1,
    });
    inserts.set(name, list);
  }

  /* ── FILE-LEVEL METADATA ──────────────────────────────────────────────
     AAMA writes it as loose TEXT in ENTITIES, beside the INSERTs. */
  const rootStart = entities.findIndex((e) => e.section === "ENTITIES");
  const rootGeometry = rootStart >= 0
    ? collectGeometry(entities, rootStart, entities.length, budget)
    : collectGeometry(entities, 0, 0, budget);
  const { meta: fileMeta } = readMetaTexts(rootGeometry.texts);

  /* ── THE PIECES ───────────────────────────────────────────────────────── */
  const pieces = [];
  const layersSeen = new Set([...rootGeometry.layersSeen]);

  for (const block of blocks) {
    if (pieces.length >= LIMITS.PIECES) {
      warnings.push({
        code: "PATTERN_PIECES_TRUNCATED",
        message: `This DXF contains more than ${LIMITS.PIECES} blocks and only the first ${LIMITS.PIECES} `
          + "were read. Export one size at a time.",
      });
      break;
    }
    /* A block with no geometry at all is a definition the drawing never used.
       Skipped rather than published as a piece with no outline. */
    const geometry = collectGeometry(entities, block.from, block.to, budget);
    for (const layer of geometry.layersSeen) layersSeen.add(layer);
    const hasGeometry = geometry.boundaries.length || geometry.internals.length
      || geometry.sewLines.length || geometry.grainlines.length;
    if (!hasGeometry) continue;

    const placement = inserts.get(block.name) || [];
    pieces.push(buildPiece(geometry, {
      blockName: block.name,
      index: pieces.length,
      insert: placement[0] || null,
    }));
    /* ── THE SAME BLOCK INSERTED TWICE IS TWO CUT PIECES ────────────────
       And it is the file's own statement that this piece is cut more than
       once, which is a different and better fact than a QUANTITY text. */
    if (placement.length > 1) {
      pieces[pieces.length - 1].insertCount = placement.length;
    }
  }

  /* ── AND THE PIECES DRAWN WITHOUT BLOCKS ──────────────────────────────
     Some exporters put every piece straight into ENTITIES. Then there is one
     geometric group and no way to split it into pieces, so it is published as
     exactly that: one body of geometry, explicitly not a piece list. */
  let unblockedGeometry = null;
  if (!pieces.length && rootGeometry.boundaries.length) {
    unblockedGeometry = rootGeometry;
    const grouped = rootGeometry.boundaries
      .filter((b) => b.closed && b.points.length >= 3)
      .sort((a, b) => polygonArea(b.points) - polygonArea(a.points));
    if (grouped.length) {
      /* Each closed boundary becomes a piece, carrying only what can honestly
         be attributed to it: its own geometry. Nothing is attributed from the
         file's shared annotation layer, because there is no way to know which
         text belongs to which outline. */
      for (let i = 0; i < grouped.length && i < LIMITS.PIECES; i++) {
        pieces.push(buildPiece({
          ...emptyGeometry(),
          boundaries: [grouped[i]],
          layersSeen: new Set([LAYER.BOUNDARY]),
        }, { blockName: "", index: i, insert: null }));
      }
      warnings.push({
        code: "PATTERN_PIECES_NOT_BLOCKED",
        message: `This DXF draws its outlines directly rather than as named pattern blocks, so each `
          + "closed outline is shown as a piece with no name, size or quantity. An AAMA/ASTM apparel "
          + "export writes one block per piece and carries all three.",
      });
    }
  }

  /* ── IS THIS A PATTERN SET, OR A DRAWING? ─────────────────────────────── */
  const apparelLayers = [...layersSeen].filter((l) => APPAREL_LAYERS.includes(l));
  const namedPieces = pieces.filter((p) => p.name && !p.generatedName).length;
  const piecesWithOutline = pieces.filter((p) => p.outline.length >= 3).length;
  const sawAamaText = Boolean(
    fileMeta["AUTHOR"] || fileMeta["PRODUCT"] || fileMeta["SAMPLE SIZE"]
    || fileMeta["UNITS"] || fileMeta["STYLE NAME"]
    || pieces.some((p) => p.size || p.quantity !== null),
  );

  /* Two independent signals, and one of them has to be present. The layer
     vocabulary is the strong one; AAMA's own metadata text is the other. A
     file with neither is a CAD drawing whatever its extension says. */
  const apparel = piecesWithOutline > 0 && (apparelLayers.length > 0 || sawAamaText);

  const unitRead = readUnit(headerMeta, fileMeta);

  /* ── WHAT THE HEADER CLAIMS ABOUT EXTENT, AND WHETHER IT IS TRUE ──────
     Checked rather than trusted. The CLO export this was built against writes
     `$EXTMAX 1000,1000` as a placeholder while its geometry lives between -35
     and 79, so a viewer that framed on the header would show a pattern in one
     corner of an empty sheet — and a scale check against it would be wrong by
     more than an order of magnitude. */
  const geometryBounds = boundsOf(pieces.flatMap((p) => p.outline));
  const headerExtents = (headerMeta.$EXTMIN && headerMeta.$EXTMAX) ? {
    declared: true,
  } : { declared: false };
  if (geometryBounds && headerMeta.$EXTMAX) {
    const claimed = num(headerMeta.$EXTMAX);
    if (claimed !== null && geometryBounds.maxX && claimed > geometryBounds.maxX * 4) {
      warnings.push({
        code: "PATTERN_EXTENTS_PLACEHOLDER",
        message: "This DXF's declared drawing extents are much larger than the geometry in it, so they "
          + "are a placeholder rather than a measurement. The pattern is framed on its own outlines "
          + "instead, which is what the pieces actually occupy.",
      });
    }
  }

  const grading = readGrading(pieces);

  /* ── WARNINGS THAT ARE ABOUT THE FILE, NOT ABOUT THE PATTERN ──────────── */
  if (!apparel && piecesWithOutline > 0) {
    warnings.push({
      code: "PATTERN_GENERIC_DXF",
      message: "This DXF contains closed outlines but none of the apparel conventions — no grainline, "
        + "no notches, no turn or grade points, and no piece metadata. It can be shown as geometry, "
        + "and it is not a pattern set: piece names, sizes, quantities and cut instructions are all "
        + "absent. Export from pattern CAD as AAMA/ASTM DXF to carry them.",
    });
  }
  if (apparel && !unitRead.unit) {
    warnings.push({
      code: "PATTERN_UNIT_UNPUBLISHED",
      message: "This pattern states no unit, so every length in it is in drawing units and nothing has "
        + "been converted. Measurements stay unscaled until somebody states what one unit is.",
    });
  }
  if (apparel && namedPieces === 0 && pieces.length > 0) {
    warnings.push({
      code: "PATTERN_PIECES_UNNAMED",
      message: `None of the ${pieces.length} pieces carries a name a patternmaker chose — they are `
        + "exporter-generated identifiers. The pieces are complete and measurable; what cannot be done "
        + "is matching them to garment components by name. Name the pieces in CAD and re-export.",
    });
  }
  if (apparel && !pieces.some((p) => p.grainline)) {
    warnings.push({
      code: "PATTERN_NO_GRAINLINE",
      message: "No piece in this pattern publishes a grainline, so there is no cut direction on record.",
    });
  }
  if (apparel && !pieces.some((p) => p.notches.length)) {
    warnings.push({
      code: "PATTERN_NO_NOTCHES",
      message: "This pattern publishes no notches. Pieces can still be cut and measured; what is absent "
        + "is the registration between them that a sewing operator aligns to.",
    });
  }
  if (apparel && !pieces.some((p) => p.seamAllowance)) {
    warnings.push({
      code: "PATTERN_NO_SEAM_ALLOWANCE",
      message: "This pattern publishes one outline per piece and no separate sewing line, so the seam "
        + "allowance is unpublished — it is not zero, and it cannot be read from this file. Export the "
        + "sew line (AAMA layer 14) alongside the cut line to carry it.",
    });
  }
  if (pieces.some((p) => p.approximated === "spline-control-hull")) {
    warnings.push({
      code: "PATTERN_SPLINE_APPROXIMATED",
      message: "Some outlines in this DXF are splines, read as their control points rather than as the "
        + "exact curve. Lengths and areas for those pieces are approximate and are not a verified "
        + "measurement.",
    });
  }

  const totalArea = pieces.reduce((sum, p) => sum + (p.area || 0), 0);

  return {
    /* ── THE CLASSIFICATION ─────────────────────────────────────────────── */
    apparel,
    classification: apparel ? "apparel_pattern_set" : "generic_dxf",

    /* ── WHAT THE FILE SAYS ABOUT ITSELF ────────────────────────────────── */
    manifest: {
      dxfVersion: str(headerMeta.$ACADVER),
      styleName: str(fileMeta["STYLE NAME"] || fileMeta["STYLE"]),
      author: str(fileMeta["AUTHOR"]),
      product: str(fileMeta["PRODUCT"]),
      formatVersion: str(fileMeta["VERSION"]),
      sampleSize: str(fileMeta["SAMPLE SIZE"]),
      createdOn: str(fileMeta["CREATION DATE"]),
      createdAt: str(fileMeta["CREATION TIME"]),
      /* The whole key/value set, so a fact this parser does not model is still
         visible to a person rather than discarded. */
      declared: fileMeta,
    },

    unit: unitRead.unit,
    unitSource: unitRead.source,
    unitDeclared: unitRead.declared,
    unitInMm: unitRead.unit ? (UNIT_IN_MM[unitRead.unit] ?? null) : null,

    pieces,
    grading,

    stats: {
      pieces: pieces.length,
      namedPieces,
      piecesWithOutline,
      sizes: grading.sizes.length,
      notches: pieces.reduce((n, p) => n + p.notches.length, 0),
      drillPoints: pieces.reduce((n, p) => n + p.drillPoints.length, 0),
      internalLines: pieces.reduce((n, p) => n + p.internalLines.length, 0),
      gradePoints: pieces.reduce((n, p) => n + p.gradePoints.length, 0),
      grainlines: pieces.filter((p) => p.grainline).length,
      vertices: budget.count,
      /* In drawing units squared. Named so, and never called consumption. */
      totalOutlineArea: Number(totalArea.toFixed(4)),
      bytes: buffer.length,
    },

    bounds: geometryBounds ? {
      minX: Number(geometryBounds.minX.toFixed(4)), minY: Number(geometryBounds.minY.toFixed(4)),
      maxX: Number(geometryBounds.maxX.toFixed(4)), maxY: Number(geometryBounds.maxY.toFixed(4)),
      width: Number(geometryBounds.width.toFixed(4)), height: Number(geometryBounds.height.toFixed(4)),
    } : null,
    headerExtentsDeclared: headerExtents.declared,

    /* Which AAMA conventions this file actually used, by name. Reported so a
       reader can see that "no notches" is the file's silence rather than this
       parser's blind spot. */
    conventions: [...layersSeen]
      .map((layer) => ({ layer, meaning: LAYER_MEANING[Number(layer)] || "" }))
      .filter((entry) => entry.meaning)
      .sort((a, b) => Number(a.layer) - Number(b.layer)),
    layersSeen: [...layersSeen].sort((a, b) => (num(a) ?? 0) - (num(b) ?? 0)),
    layerNames,
    unblockedGeometry: Boolean(unblockedGeometry),

    warnings,
  };
}

function emptyGeometry() {
  return {
    boundaries: [], sewLines: [], internals: [], cutouts: [], mirrors: [],
    grainlines: [], notches: [], drills: [], gradePoints: [], turnPoints: [],
    curvePoints: [], stripes: [], plaids: [], texts: [], other: [],
    layersSeen: new Set(),
  };
}

module.exports = {
  inspectDxf, DxfError,
  LAYER, LAYER_MEANING, APPAREL_LAYERS, LIMITS, UNIT_IN_MM,
  /* Exported for the tests, which assert the geometry rather than trusting it. */
  polygonArea, pathLength, boundsOf, tessellateBulge, readGrainline, readUnit,
  projectOnSegment, distanceToOutline,
};
