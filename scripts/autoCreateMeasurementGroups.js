/**
 * BUILD THE MEASUREMENT GROUPS ON EVERY UPLOADED SIZE
 * ===================================================
 * A size with no measurement groups cannot be graded to anybody: the cutting
 * master picks that size for an employee, finds nothing to drive, and shows the
 * pattern unchanged. On the Guwahati shirt only one size out of nine had any
 * groups at all, and the two it had were leftovers.
 *
 * Making them by hand is nine times the work for one garment, which is the
 * tedium this replaces.
 *
 * HOW A PANEL IS READ
 * -------------------
 * Nothing here guesses anatomy from a shape. It uses two things the pattern
 * already states:
 *
 *   1. THE DESIGNER'S DECLARED SIZE CHART (`baseMeasurements`), which gives the
 *      garment's length and chest at this size.
 *   2. THE DESIGNER'S OWN DRAFTING. Each body panel carries node pairs sitting
 *      at the SAME HEIGHT on its two edges - those pairs are the measurement
 *      levels, put there by whoever drew it.
 *
 * Panels are identified by height against the declared length, so a sleeve or a
 * collar is never mistaken for a body. Of the body panels the WIDER and SHORTER
 * one is the front (it carries the button placket and a shorter shirttail) and
 * the other is the back - two independent signals that agree, and both are
 * checked before anything is written.
 *
 * Levels are then taken IN ORDER from the bottom: hem, stomach, chest. Matching
 * them by value instead would misread the front, whose placket puts every level
 * about 2.8" above the declared chest.
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 * A size whose upload does not contain two body panels is REPORTED AND SKIPPED,
 * never guessed at. Groups drive a cutting line; a plausible-looking wrong one
 * is worse than none.
 *
 *   node scripts/autoCreateMeasurementGroups.js --stock <stockItemId> --dry
 *   node scripts/autoCreateMeasurementGroups.js --stock <stockItemId> --apply
 *   node scripts/autoCreateMeasurementGroups.js --stock <stockItemId> --apply --replace
 */

require("dotenv").config();
const mongoose = require("mongoose");

const UPI = 25.4;
const AUTO_TAG = "auto-from-geometry";
const DEFAULT_STOCK = "69bbcb3d1c32e4f8d5b30a46"; // Executive to Managers Shirt

function parseArgs(argv) {
  const args = { stock: DEFAULT_STOCK, apply: false, replace: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--dry") args.apply = false;
    else if (a === "--replace") args.replace = true;
    else if (a === "--stock") args.stock = argv[++i];
  }
  return args;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A declared measurement, however the designer happened to capitalise it. */
function declared(baseMeasurements, name) {
  const bm = baseMeasurements || {};
  return num(
    bm[name]
    ?? bm[name.toLowerCase()]
    ?? bm[name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()],
  );
}

/* ------------------------------------------------------------------ *
 * Reading a piece
 * ------------------------------------------------------------------ */

function measurablePaths(sizePattern) {
  const out = [];
  (sizePattern.basePaths || []).forEach((p, pathIdx) => {
    if (!p || p.isConnector || !p.isClosed) return;
    /*
     * A closing "Z" carries whatever coordinates it was written with, which on
     * several of these uploads is not a point on the outline at all. Including
     * them pushed a sleeve's bounding box out to 50" wide and got four sizes
     * rejected as unreadable.
     */
    const pts = (p.segs || [])
      .map((q, segIdx) => ({ x: q.x, y: q.y, t: q.t, segIdx }))
      .filter((q) => q.t !== "Z" && Number.isFinite(q.x) && Number.isFinite(q.y));
    if (pts.length < 6) return;
    const xs = pts.map((q) => q.x);
    const ys = pts.map((q) => q.y);
    out.push({
      pathIdx,
      pts,
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
      width: (Math.max(...xs) - Math.min(...xs)) / UPI,
      height: (Math.max(...ys) - Math.min(...ys)) / UPI,
    });
  });
  return out;
}

/**
 * The front and back body panels, or a reason there are none.
 *
 * A body panel is as tall as the garment is long. A sleeve laid flat is not,
 * and neither is a collar, so neither can be mistaken for one.
 */
function findBodyPanels(panels, declaredLength) {
  if (!declaredLength) return { ok: false, reason: "this size declares no length" };
  const bodies = panels.filter((p) => {
    const ratio = p.height / declaredLength;
    return ratio >= 0.9 && ratio <= 1.25 && p.width < p.height;
  });
  if (bodies.length < 2) {
    return {
      ok: false,
      reason:
        `found ${bodies.length} body panel${bodies.length === 1 ? "" : "s"} `
        + `(need 2). Closed shapes on this size measure `
        + `${panels.map((p) => `${p.width.toFixed(1)}x${p.height.toFixed(1)}"`).join(", ")} `
        + `against a declared length of ${declaredLength}"`,
    };
  }
  const sorted = [...bodies].sort((a, b) => b.width - a.width);
  const front = sorted[0];
  const back = sorted[sorted.length - 1];
  /*
   * THE TWO SIGNALS MUST AGREE. The front is the wider panel because of the
   * button placket, and the shorter one because the shirttail is longer at the
   * back. If those disagree this is not the garment shape assumed here.
   */
  if (!(front.height < back.height)) {
    return {
      ok: false,
      reason:
        `the wider panel (${front.width.toFixed(1)}") is not the shorter one, so `
        + `front and back cannot be told apart`,
    };
  }
  return { ok: true, front, back };
}

/**
 * The heights at which the designer drew a node on both edges.
 *
 * Those pairs ARE the measurement levels. Where a level carries more than one
 * node on a side - a hem corner as well as the side seam - the widest pair is
 * the one that spans the panel.
 */
function levelsOf(panel, tolInches = 0.15) {
  const mid = (panel.minX + panel.maxX) / 2;
  const left = panel.pts.filter((q) => q.x < mid);
  const right = panel.pts.filter((q) => q.x >= mid);

  const found = [];
  for (const r of right) {
    for (const l of left) {
      if (Math.abs(l.y - r.y) / UPI > tolInches) continue;
      found.push({
        y: (l.y + r.y) / 2,
        left: l,
        right: r,
        span: Math.abs(r.x - l.x) / UPI,
      });
    }
  }
  found.sort((a, b) => a.y - b.y);

  /* One level per height: the pair that actually spans the panel. */
  const levels = [];
  for (const f of found) {
    const prev = levels[levels.length - 1];
    if (prev && Math.abs(f.y - prev.y) / UPI < tolInches) {
      if (f.span > prev.span) levels[levels.length - 1] = f;
      continue;
    }
    levels.push(f);
  }
  return levels;
}

/**
 * Name the levels from the bottom up: hem, stomach, chest.
 *
 * By POSITION, not by value. The front panel's placket puts every one of its
 * levels about 2.8" above the declared chest, so matching on value would call
 * the stomach the chest on every front panel in the run.
 */
function nameLevels(levels) {
  const ordered = [...levels].sort((a, b) => b.y - a.y);
  return {
    "Bottom hem": ordered[0] || null,
    Stomach: ordered[1] || null,
    Chest: ordered[2] || null,
  };
}

/* ------------------------------------------------------------------ *
 * Groups
 * ------------------------------------------------------------------ */

const COLOURS = {
  Chest: "#2563eb",
  Stomach: "#d97706",
  "Bottom hem": "#7c3aed",
  Length: "#16a34a",
};

function makeGroup({ sizeName, panelName, partKey, level, panel, declaredValue, multiplier }) {
  const baseFullInches = Number((level.span * multiplier).toFixed(4));
  /*
   * THE OFFSET IS THE DESIGNER'S EASE, AND IT HAS TO SURVIVE THE GRADE.
   *
   * The cutting master sends the employee's own chest. This panel does not
   * measure the employee's chest - the front carries a placket - so the offset
   * carries that difference through: target = employee + (drawn - declared).
   * Without it, a front panel would be graded down to the body measurement and
   * the placket would be cut away.
   */
  const measurementOffset = declaredValue === null
    ? 0
    : Number((baseFullInches - declaredValue).toFixed(4));

  const clientId = `auto-${sizeName}-${panelName}-${partKey}`
    .toLowerCase().replace(/[^a-z0-9]+/g, "-");

  return {
    clientId,
    groupId: clientId,
    name: `${partKey} (${panelName})`,
    groupName: `${partKey} (${panelName})`,
    partKey,
    assignedSize: sizeName,
    multiplier,
    ref1: { pathIdx: panel.pathIdx, segIdx: level.left.segIdx },
    ref2: { pathIdx: panel.pathIdx, segIdx: level.right.segIdx },
    color: COLOURS[partKey] || "#2563eb",
    baseFullInches,
    targetFullInches: baseFullInches,
    measurementOffset,
    /* Graded from the pattern. Nothing to record, at any size. */
    gradingMode: "parametric",
    measureMode: "straight",
    nestedConditions: [],
    keyframes: [],
    autoTag: AUTO_TAG,
  };
}

/** The garment length, down the back panel from its highest node to its lowest. */
function makeLengthGroup({ sizeName, panel, declaredValue }) {
  let top = panel.pts[0];
  let bottom = panel.pts[0];
  for (const q of panel.pts) {
    if (q.y < top.y) top = q;
    if (q.y > bottom.y) bottom = q;
  }
  const span = Math.abs(bottom.y - top.y) / UPI;
  const clientId = `auto-${sizeName}-back-length`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const baseFullInches = Number(span.toFixed(4));
  return {
    clientId,
    groupId: clientId,
    name: "Length (Back)",
    groupName: "Length (Back)",
    partKey: "Length",
    assignedSize: sizeName,
    multiplier: 1,
    ref1: { pathIdx: panel.pathIdx, segIdx: top.segIdx },
    ref2: { pathIdx: panel.pathIdx, segIdx: bottom.segIdx },
    color: COLOURS.Length,
    baseFullInches,
    targetFullInches: baseFullInches,
    measurementOffset: declaredValue === null
      ? 0 : Number((baseFullInches - declaredValue).toFixed(4)),
    gradingMode: "parametric",
    measureMode: "straight",
    nestedConditions: [],
    keyframes: [],
    autoTag: AUTO_TAG,
  };
}

/** Every group this size should carry, or why it cannot have any. */
function buildGroupsForSize(sizePattern) {
  const sizeName = sizePattern.sizeName;
  const bm = sizePattern.baseMeasurements || {};
  const declaredLength = declared(bm, "length");
  const panels = measurablePaths(sizePattern);
  const body = findBodyPanels(panels, declaredLength);
  if (!body.ok) return { sizeName, ok: false, reason: body.reason, groups: [] };

  const groups = [];
  const notes = [];
  for (const [panelName, panel] of [["Front", body.front], ["Back", body.back]]) {
    const named = nameLevels(levelsOf(panel));
    for (const partKey of ["Chest", "Stomach", "Bottom hem"]) {
      const level = named[partKey];
      if (!level) {
        notes.push(`${panelName}: no node pair for ${partKey}`);
        continue;
      }
      groups.push(makeGroup({
        sizeName, panelName, partKey, level, panel,
        declaredValue: declared(bm, partKey),
        multiplier: 4,
      }));
    }
  }
  /*
   * NO LENGTH GROUP. DELIBERATELY.
   *
   * A back panel's top-to-bottom distance is not the garment length: it takes in
   * the shoulder slope and the shirttail curve, and on these uploads it sits
   * anywhere from 2.3" to 4.7" above the declared length with no consistent
   * relationship between sizes. Graded from one size to another it came out up
   * to 2.3" from the length the designer actually drew.
   *
   * So length is NOT graded here. It comes from the uploaded size the employee
   * was matched to, which the size chart already ties to their chest. That is a
   * fraction of an inch out rather than two inches, and it is honest about what
   * the pattern actually states. Grading it properly needs a length reference
   * the designer places once - a centre-back neck-to-hem line - which no upload
   * currently carries.
   */

  return { sizeName, ok: true, groups, notes, front: body.front, back: body.back };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function main() {
  const args = parseArgs(process.argv);
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const stockItemId = new mongoose.Types.ObjectId(args.stock);
  const stockItem = await db.collection("stockitems").findOne({ _id: stockItemId });
  const config = await db.collection("patterngradingconfigs")
    .findOne({ stockItemId, isActive: true }, { sort: { updatedAt: -1 } });
  if (!config) throw new Error(`No active pattern config for stock item ${args.stock}`);

  console.log(`Product : ${stockItem?.name} (${stockItem?.reference})`);
  console.log(`Config  : ${config._id}`);
  console.log(`Mode    : ${args.apply ? "APPLY" : "dry run — nothing will be written"}`
    + `${args.replace ? ", replacing existing groups" : ", keeping existing groups"}\n`);

  const results = [];
  for (const sp of config.sizePatterns || []) {
    results.push({ sp, ...buildGroupsForSize(sp) });
  }

  for (const r of results) {
    const existing = (r.sp.keyframeGroups || []).length;
    if (!r.ok) {
      console.log(`${r.sizeName.padEnd(4)} SKIPPED — ${r.reason}`);
      continue;
    }
    console.log(
      `${r.sizeName.padEnd(4)} front p${r.front.pathIdx} `
      + `(${r.front.width.toFixed(2)}x${r.front.height.toFixed(2)}")  `
      + `back p${r.back.pathIdx} (${r.back.width.toFixed(2)}x${r.back.height.toFixed(2)}")  `
      + `${existing} existing -> ${r.groups.length} groups`,
    );
    for (const g of r.groups) {
      const off = g.measurementOffset;
      console.log(
        `       ${g.groupName.padEnd(22)} x${g.multiplier}  `
        + `drawn ${g.baseFullInches.toFixed(3).padStart(8)}"  `
        + `declared ${(g.baseFullInches - off).toFixed(3).padStart(7)}"  `
        + `ease ${(off >= 0 ? "+" : "") + off.toFixed(3)}"`,
      );
    }
    for (const n of r.notes || []) console.log(`       note: ${n}`);
  }

  if (!args.apply) {
    console.log("\nDry run. Re-run with --apply to write these.");
    await mongoose.disconnect();
    return;
  }

  let written = 0;
  for (const r of results) {
    if (!r.ok) continue;
    const previous = r.sp.keyframeGroups || [];
    const kept = args.replace
      ? previous.filter((g) => false)
      : previous.filter((g) => g.autoTag !== AUTO_TAG);
    const next = [...kept, ...r.groups];
    await db.collection("patterngradingconfigs").updateOne(
      { _id: config._id, "sizePatterns.sizeName": r.sizeName },
      {
        $set: {
          "sizePatterns.$.keyframeGroups": next,
          "sizePatterns.$.groupsSetupCompleted": true,
        },
      },
    );
    written += 1;
  }
  console.log(`\nWrote groups onto ${written} size${written === 1 ? "" : "s"}.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
