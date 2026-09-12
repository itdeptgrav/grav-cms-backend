// scripts/restoreCanvasLayout.js
//
// Rebuild the factory floor plan after it was deleted.
//
//   node -r dotenv/config scripts/restoreCanvasLayout.js --dry
//   node -r dotenv/config scripts/restoreCanvasLayout.js --apply
//
// ─── What happened ───────────────────────────────────────────────────────────
// The designer's "Reset" does a hard `deleteOne` on the canvaslayouts document.
// It was pressed, and version 31 — 78 machine positions, 25 separators and 6
// chambers, placed by hand — went with it. There is no Atlas backup on this
// tier and no soft-delete, so the document is simply not there any more.
//
// ─── What is genuinely recoverable, and what is not ──────────────────────────
// RECOVERED EXACTLY, from a transcript of an earlier read:
//   · all 25 separators, with their original coordinates
//   · all 6 chambers (FUSING_MACHINE, IRON_DEPARTMENT, LINE NO: 01/02,
//     two TABLE MARKs), with their original x/y/width/height
//   · the 4 walls drawn after the reset, from the save that followed it
//
// NOT RECOVERABLE: the 78 machine x/y positions. Every local copy was checked —
// the browser's network buffer had evicted the bodies, the session transcripts
// contain only the old canvas SOURCE (the 228 "machineId" hits are code, not
// data), and the local MongoDB holds a February copy at version 7 with 12
// positions in a different coordinate space.
//
// So machines are ARRANGED rather than restored: laid out in lines by
// department, anchored on the recovered chambers, which is a working floor a
// supervisor can drag into shape rather than an empty one. Honest naming
// matters here — this script does not pretend to put anything back that it
// could not find.

require("dotenv").config();
const dns = require("dns");
const mongoose = require("mongoose");

// Atlas SRV lookups fail on some local resolvers; the scratch scripts in this
// repo all pin a public resolver for the same reason.
if (process.env.SCRIPT_DNS !== "system") dns.setServers(["8.8.8.8", "1.1.1.1"]);

const CanvasLayout = require("../models/CMS_Models/Manufacturing/Production/CanvasLayout");
const Machine = require("../models/CMS_Models/Inventory/Configurations/Machine");

// ─── Recovered verbatim ───────────────────────────────────────────────────────

const SEPARATOR_XY = [
  [-1128.5339762369792, -1101.3331909179688], [-1128.5338134765625, 77.68910725911462],
  [-1128.533976236979, -512.533223470052], [-1128.5339762369792, -806.9332275390625],
  [-1128.5339762369792, -217.86657714843747], [-1128.5339762369792, 373.3335367838542],
  [-1128.5339762369792, 668.0002034505208], [-1128.5339762369792, 962.6668701171875],
  [-1128.5339762369792, 1257.3335367838542], [-1128.5339762369792, 1552.0002034505208],
  [-1128.5339762369792, 1846.6668701171875], [-1128.5339762369792, 2141.333536783854],
  [830.1327311197917, -1101.3331909179688], [830.1327311197917, -806.9332275390625],
  [830.1327311197917, -512.533223470052], [830.1327311197917, -217.86657714843747],
  [830.1327311197917, 77.68910725911462], [830.1327311197917, 373.3335367838542],
  [830.1327311197917, 668.0002034505208], [830.1327311197917, 962.6668701171875],
  [830.1327311197917, 1257.3335367838542], [830.1327311197917, 1552.0002034505208],
  [830.1327311197917, 1846.6668701171875], [830.1327311197917, 2141.333536783854],
  [830.1327311197917, 2292.0002034505208],
];

const CHAMBERS = [
  { name: "FUSING_MACHINE", x: 1026.3585721529448, y: -1455.9579681810749, width: 493.6410757211538, height: 384.5639272836538, kind: "finishing" },
  { name: "IRON_DEPARTMENT", x: -1164.2255045572913, y: 2510.9900620404405, width: 359.7332356770833, height: 345.288818359375, kind: "finishing" },
  { name: "LINE NO: 01", x: -1121.3021769267104, y: -1104.0382980569157, width: 267.36148671207286, height: 120, kind: "sewing" },
  { name: "TABLE MARK", x: 325.80401252297804, y: 1653.3334799373852, width: 279.9215877757353, height: 216.11766142003677, kind: "inspection" },
  { name: "TABLE MARK", x: -1554.2746869255516, y: 232.39218319163604, width: 302.5096220128676, height: 237.45095645680146, kind: "inspection" },
  { name: "LINE NO: 02", x: 643.2595486111111, y: -589.9260118272567, width: 190.96299913194446, height: 120, kind: "sewing" },
];

// Drawn by hand after the reset; read back off the save that created them.
const WALLS = [
  { id: "wall-mtxapnc7-0", x1: 400, y1: 1950, x2: 1150, y2: 1650 },
  { id: "wall-mtxappvr-1", x1: 1150, y1: 1650, x2: 1200, y2: 1750 },
  { id: "wall-mtxaprnl-2", x1: 1200, y1: 1750, x2: 450, y2: 2050 },
  { id: "wall-mtxapshs-3", x1: 450, y1: 2050, x2: 400, y2: 1950 },
];

// ─── Arrangement ──────────────────────────────────────────────────────────────
//
// The recovered geometry says what the floor looked like: two vertical rails at
// x ≈ −1129 and x ≈ +830 running from y ≈ −1100 down to y ≈ +2290, with the
// "LINE NO: 01" label at the top of the left rail and "LINE NO: 02" near the
// right. So the lines ran VERTICALLY between those rails, and machines are put
// back the same way.

const PITCH_Y = 150; // cm between machines down a line — a 120cm table plus reach
const COL_GAP = 260; // cm between columns — enough for a trolley to pass

/** Which department each machine type belongs to, for grouping into lines. */
function departmentOf(type) {
  const t = String(type || "").toUpperCase().replace(/[\s\-_.*/]/g, "");
  if (/^IRON|IRONER|IRONTABLE|FUSING/.test(t)) return "finishing";
  if (/EMBROIDERY|EMBROIDARY/.test(t)) return "embroidery";
  if (/CUTTING/.test(t)) return "cutting";
  if (/TABLE|CHECKER|CHECKING/.test(t)) return "inspection";
  if (/HELPER|INDIRECT/.test(t)) return "support";
  return "sewing";
}

/**
 * Where each department's block starts, anchored on the recovered chambers so
 * the ironing machines land in IRON_DEPARTMENT and the fusing press in
 * FUSING_MACHINE rather than somewhere arbitrary.
 */
const ANCHORS = {
  sewing: { x: -1000, y: -950, columns: 4 },
  finishing: { x: 1060, y: -1400, columns: 2 },
  embroidery: { x: 1060, y: -700, columns: 1 },
  cutting: { x: -1500, y: -1300, columns: 1 },
  inspection: { x: 360, y: 1690, columns: 2 },
  support: { x: -1520, y: 280, columns: 1 },
};

function arrange(machines) {
  const byDept = new Map();
  for (const m of machines) {
    const d = departmentOf(m.type);
    if (!byDept.has(d)) byDept.set(d, []);
    byDept.get(d).push(m);
  }

  const out = [];
  for (const [dept, list] of byDept) {
    const anchor = ANCHORS[dept] || ANCHORS.sewing;
    // Same type together, then by name, so a line reads as a line.
    list.sort(
      (a, b) =>
        String(a.type).localeCompare(String(b.type)) ||
        String(a.name).localeCompare(String(b.name))
    );
    const perColumn = Math.ceil(list.length / anchor.columns);
    list.forEach((m, i) => {
      const col = Math.floor(i / perColumn);
      const row = i % perColumn;
      out.push({
        machineId: m._id,
        machineName: "",
        x: Math.round(anchor.x + col * COL_GAP),
        y: Math.round(anchor.y + row * PITCH_Y),
        templateId: "main",
        hidden: false,
        rotation: 0,
        assetType: "",
        label: "",
        zoneId: "",
      });
    });
  }
  return out;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const apply = process.argv.includes("--apply");

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 20000,
    autoIndex: false,
  });

  const machines = await Machine.find({}, { name: 1, type: 1 }).lean();
  const existing = await CanvasLayout.findOne({ organizationId: "default" }).lean();

  const positions = arrange(machines);

  const doc = {
    organizationId: "default",
    machinePositions: positions,
    separators: SEPARATOR_XY.map(([x, y], i) => ({
      id: `sep-restored-${i}`,
      x,
      y,
      templateId: "main",
      orientation: "vertical",
      length: null,
    })),
    chamberTemplates: CHAMBERS.map((c, i) => ({
      id: `zone-restored-${i}`,
      name: c.name,
      x: c.x,
      y: c.y,
      width: c.width,
      height: c.height,
      color: "#EFF6FF",
      borderColor: "#3B82F6",
      kind: c.kind,
      rotation: 0,
    })),
    walls: WALLS.map((w) => ({ ...w, thickness: 20, height: 300 })),
    aisles: [],
    fixtures: [],
    floor: {
      gridCm: 50,
      showGrid: true,
      showRulers: true,
      wallHeightCm: 300,
      floorColor: "#e7e5e4",
    },
    canvasState: { zoom: 0.85, panX: -14.22222900390625, panY: 613.3333129882812 },
    lastUpdatedBy: "layout-restore-script",
  };

  const byDept = {};
  for (const m of machines) {
    const d = departmentOf(m.type);
    byDept[d] = (byDept[d] || 0) + 1;
  }

  console.log("─── Restore plan ───────────────────────────────────────────");
  console.log("  machines registered :", machines.length);
  console.log("  arranged by department:", JSON.stringify(byDept));
  console.log("  separators (recovered):", doc.separators.length);
  console.log("  chambers   (recovered):", doc.chamberTemplates.length);
  console.log("  walls      (recovered):", doc.walls.length);
  console.log(
    "  existing document      :",
    existing
      ? `version ${existing.version}, ${existing.machinePositions.length} positions — WILL BE REPLACED`
      : "none — a new one will be created"
  );

  if (!apply) {
    console.log("\nDRY RUN. Nothing written. Re-run with --apply to write it.");
    await mongoose.disconnect();
    return;
  }

  if (existing) {
    await CanvasLayout.updateOne(
      { organizationId: "default" },
      { $set: { ...doc, version: (existing.version || 0) + 1 } }
    );
    console.log(`\nWRITTEN — replaced, now version ${(existing.version || 0) + 1}.`);
  } else {
    await CanvasLayout.create({ ...doc, version: 1 });
    console.log("\nWRITTEN — created at version 1.");
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
