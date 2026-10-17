import process from "node:process";

const api = process.env.OCS_API_URL ?? "http://127.0.0.1:18090/api/v1";
const token = process.env.OCS_API_TOKEN ?? "codex-fabric-meter-2026";
const outDir = "/Users/risheeray/grav-cms-backend/docs/cad";
const finalizeOnly = process.env.OCS_FINALIZE_ONLY === "1";

async function call(path, method = "GET", body) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
  }
  return data;
}

const entities = [];
const line = (x1, y1, x2, y2, layer = "OBJECT", color = 256) =>
  entities.push({ type: "Line", start: [x1, y1], end: [x2, y2], layer, color });
const rect = (x, y, w, h, layer = "OBJECT", color = 256) =>
  entities.push({
    type: "LwPolyline",
    vertices: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
    closed: true,
    layer,
    color,
  });
const circle = (x, y, radius, layer = "OBJECT", color = 256) =>
  entities.push({ type: "Circle", center: [x, y], radius, layer, color });
const label = (value, x, y, height = 55, layer = "TEXT", rotation = 0, color = 256) =>
  entities.push({ type: "Text", value, position: [x, y], height, rotation_deg: rotation, layer, color });
const triangle = (corners, layer = "DIM", color = 2) =>
  entities.push({ type: "LwPolyline", vertices: corners, closed: true, layer, color });

function hdim(x1, x2, yObject, yDimension, value) {
  line(x1, yObject, x1, yDimension, "DIM", 2);
  line(x2, yObject, x2, yDimension, "DIM", 2);
  line(x1, yDimension, x2, yDimension, "DIM", 2);
  triangle([[x1, yDimension], [x1 + 35, yDimension + 16], [x1 + 35, yDimension - 16]]);
  triangle([[x2, yDimension], [x2 - 35, yDimension + 16], [x2 - 35, yDimension - 16]]);
  label(value, (x1 + x2) / 2 - value.length * 12, yDimension + 30, 45, "DIM", 0, 2);
}

function vdim(y1, y2, xObject, xDimension, value) {
  line(xObject, y1, xDimension, y1, "DIM", 2);
  line(xObject, y2, xDimension, y2, "DIM", 2);
  line(xDimension, y1, xDimension, y2, "DIM", 2);
  triangle([[xDimension, y1], [xDimension - 16, y1 + 35], [xDimension + 16, y1 + 35]]);
  triangle([[xDimension, y2], [xDimension - 16, y2 - 35], [xDimension + 16, y2 - 35]]);
  label(value, xDimension + 30, (y1 + y2) / 2 - value.length * 12, 45, "DIM", 90, 2);
}

// A1 landscape border drawn at 10:1 so the model plots at an exact 1:10 scale.
rect(0, 0, 8410, 5940, "SHEET", 7);
rect(100, 100, 8210, 5740, "SHEET", 7);
label("FABRIC ROLL LENGTH METER - GENERAL ARRANGEMENT", 300, 5730, 110, "TITLE", 0, 7);
label("REV B MOTORIZED CONCEPT | PROVISIONAL DIMENSIONS | UNITS: mm | SCALE: 1:10 ON A1", 300, 5600, 55, "TITLE", 0, 7);
line(100, 5520, 8310, 5520, "SHEET", 7);

// Front elevation.
label("FRONT ELEVATION", 350, 5330, 75, "TITLE", 0, 7);
const fx = 450, fy = 4250;
rect(fx, fy, 1750, 40, "FRAME", 3);
rect(fx, fy, 40, 520, "FRAME", 3);
rect(fx + 1710, fy, 40, 520, "FRAME", 3);
rect(fx + 40, fy + 40, 1670, 40, "FRAME", 3);
for (const yy of [fy + 170, fy + 300, fy + 400]) line(fx + 80, yy, fx + 1670, yy, "CENTER", 4);
rect(fx + 100, fy + 360, 1550, 80, "FABRIC", 8);
rect(fx + 100, fy + 260, 1550, 80, "ROLLER", 5);
rect(fx + 100, fy + 130, 1550, 80, "ROLLER", 5);
for (const yy of [fy + 170, fy + 300, fy + 400]) {
  line(fx + 65, yy, fx + 1685, yy, "SHAFT", 1);
  rect(fx + 45, yy - 45, 70, 90, "BEARING", 6);
  rect(fx + 1635, yy - 45, 70, 90, "BEARING", 6);
}
label("SUPPLY ROLL SHAFT", fx + 685, fy + 455, 45);
label("SPRING NIP / MEASURING ROLLER", fx + 520, fy + 315, 42);
label("MOTORIZED TAKE-UP SHAFT", fx + 625, fy + 105, 42);
rect(fx + 1750, fy + 105, 170, 130, "DRIVE", 1);
circle(fx + 1835, fy + 170, 38, "DRIVE", 1);
label("GEARMOTOR", fx + 1750, fy + 255, 38, "TEXT", 0, 1);
hdim(fx, fx + 1750, fy, fy - 170, "1750 OVERALL");
hdim(fx + 140, fx + 1610, fy + 520, fy + 650, "1470 FABRIC CLEAR");
vdim(fy, fy + 520, fx, fx - 170, "520");
label("A", fx + 1765, fy + 500, 55, "DIM", 0, 2);
label("A", fx + 1765, fy - 10, 55, "DIM", 0, 2);

// Top view.
label("TOP VIEW", 350, 3730, 75, "TITLE", 0, 7);
const tx = 450, ty = 2850;
rect(tx, ty, 1750, 450, "FRAME", 3);
rect(tx + 40, ty + 40, 1670, 370, "FRAME", 3);
for (const yy of [ty + 95, ty + 225, ty + 355]) {
  rect(tx + 100, yy - 40, 1550, 80, "ROLLER", 5);
  line(tx + 65, yy, tx + 1685, yy, "CENTER", 4);
  rect(tx + 45, yy - 45, 70, 90, "BEARING", 6);
  rect(tx + 1635, yy - 45, 70, 90, "BEARING", 6);
}
label("TAKE-UP", tx + 760, ty + 110, 42);
label("MEASURING / NIP", tx + 675, ty + 240, 42);
label("SUPPLY", tx + 775, ty + 370, 42);
hdim(tx, tx + 1750, ty, ty - 170, "1750 OVERALL");
vdim(ty, ty + 450, tx + 1750, tx + 1920, "450");
hdim(tx + 140, tx + 1610, ty + 450, ty + 585, "1470 WORKING WIDTH");
rect(tx + 1750, ty + 45, 170, 100, "DRIVE", 1);
label("MOTOR", tx + 1765, ty + 165, 34, "TEXT", 0, 1);

// Side section showing the fabric path.
label("SIDE SECTION A-A", 2800, 5330, 75, "TITLE", 0, 7);
const sx = 2850, sy = 4250;
rect(sx, sy, 450, 40, "FRAME", 3);
rect(sx, sy, 40, 520, "FRAME", 3);
rect(sx + 410, sy, 40, 520, "FRAME", 3);
circle(sx + 350, sy + 400, 175, "FABRIC", 8);
circle(sx + 350, sy + 400, 38, "SHAFT", 1);
circle(sx + 225, sy + 300, 50, "ROLLER", 5);
circle(sx + 225, sy + 395, 40, "ROLLER", 5);
circle(sx + 95, sy + 170, 105, "FABRIC", 8);
circle(sx + 95, sy + 170, 38, "SHAFT", 1);
rect(sx - 15, sy + 55, 145, 95, "DRIVE", 1);
label("M", sx + 40, sy + 83, 40, "TEXT", 0, 1);
line(sx + 350, sy + 225, sx + 225, sy + 250, "FABRIC", 8);
line(sx + 225, sy + 250, sx + 225, sy + 350, "FABRIC", 8);
line(sx + 225, sy + 350, sx + 95, sy + 275, "FABRIC", 8);
label("FABRIC PATH", sx + 120, sy + 540, 45);
vdim(sy, sy + 520, sx, sx - 170, "520");
hdim(sx, sx + 450, sy, sy - 170, "450");
label("MAX ROLL OD 350", sx + 135, sy + 590, 42, "DIM", 0, 2);

// Measuring roller detail.
label("MEASURING ROLLER DETAIL", 2800, 3730, 75, "TITLE", 0, 7);
const dx = 2850, dy = 3250;
rect(dx, dy, 1550, 100, "ROLLER", 5);
line(dx - 110, dy + 50, dx + 1660, dy + 50, "CENTER", 4);
rect(dx - 100, dy + 32, 100, 36, "SHAFT", 1);
rect(dx + 1550, dy + 32, 100, 36, "SHAFT", 1);
hdim(dx, dx + 1550, dy + 100, dy + 230, "1550 FACE");
label("100 OD RUBBER-LAGGED ALUMINIUM ROLLER", dx + 250, dy - 100, 45);
label("35 DIA SHAFT ENDS | ENCODER DIRECT-COUPLED", dx + 250, dy - 165, 42);
label("ROLLER RUNOUT <= 0.20 TIR", dx + 445, dy - 230, 42, "DIM", 0, 2);

// Supply and take-up shaft detail.
label("SUPPLY / TAKE-UP SHAFT DETAIL", 2800, 2850, 75, "TITLE", 0, 7);
const qx = 2850, qy = 2460;
rect(qx, qy, 1650, 35, "SHAFT", 1);
rect(qx + 80, qy - 35, 100, 105, "BEARING", 6);
rect(qx + 1470, qy - 35, 100, 105, "BEARING", 6);
circle(qx + 825, qy + 17.5, 38, "SHAFT", 1);
hdim(qx, qx + 1650, qy + 70, qy + 190, "1650 SHAFT");
label("35 DIA C45 / EN8 SOLID SHAFT", qx + 445, qy - 85, 45);
label("ADJUSTABLE CORE CONES FOR 76 mm NOMINAL CORE", qx + 255, qy - 150, 42);

// Frame weldment and cut list cue.
label("FRAME / WELDMENT", 2800, 2150, 75, "TITLE", 0, 7);
const wx = 2850, wy = 1580;
rect(wx, wy, 1750, 450, "FRAME", 3);
line(wx, wy, wx + 1750, wy + 450, "FRAME", 3);
line(wx, wy + 450, wx + 1750, wy, "FRAME", 3);
label("40 x 40 x 2 MS SHS", wx + 560, wy + 230, 55);
label("ALL FRAME WELDS: 4 mm FILLET, 40 LONG / 100 PITCH UNLESS NOTED", wx + 80, wy - 85, 42);
hdim(wx, wx + 1750, wy, wy - 180, "1750");
vdim(wy, wy + 450, wx, wx - 170, "450");

// Bill of materials.
label("BILL OF MATERIALS", 5500, 5330, 75, "TITLE", 0, 7);
const bx = 5480, by = 3540, bw = 2700, row = 150;
rect(bx, by, bw, 1650, "SHEET", 7);
const columns = [0, 170, 1450, 1700, 2050, 2700];
for (const x of columns.slice(1, -1)) line(bx + x, by, bx + x, by + 1650, "SHEET", 7);
for (let i = 1; i < 11; i += 1) line(bx, by + i * row, bx + bw, by + i * row, "SHEET", 7);
["ITEM", "DESCRIPTION", "QTY", "MATERIAL", "REMARK"].forEach((value, i) =>
  label(value, bx + columns[i] + 18, by + 1510, 42, "TEXT", 0, 7));
const bom = [
  ["1", "BASE FRAME WELDMENT", "1", "MS SHS", "40x40x2"],
  ["2", "SUPPLY SHAFT", "1", "EN8", "35 DIA x 1650"],
  ["3", "TAKE-UP SHAFT", "1", "EN8", "35 DIA x 1650"],
  ["4", "MEASURING ROLLER", "1", "AL+RUBBER", "100 OD x 1550"],
  ["5", "NIP PRESSURE ROLLER", "1", "AL+RUBBER", "80 OD x 1550"],
  ["6", "PILLOW BLOCK UCP207", "6", "BOUGHT", "35 mm BORE"],
  ["7", "ROTARY ENCODER", "1", "BOUGHT", ">=1024 PPR"],
  ["8", "SPRING ADJUSTER", "2", "MS/SPRING", "25-80 N EACH"],
  ["9", "GEARMOTOR + VFD + CLUTCH", "1 SET", "BOUGHT", "0.55 kW PROV."],
  ["10", "GUARDS / E-STOP / FOOT CTRL", "1 SET", "MIXED", "SAFETY SET"],
];
bom.forEach((values, i) => values.forEach((value, j) =>
  label(value, bx + columns[j] + 18, by + 1360 - i * row, 36, "TEXT", 0, 7)));

// Design and safety notes.
label("DESIGN / FABRICATION NOTES", 5500, 3370, 75, "TITLE", 0, 7);
const notes = [
  "1. BASIS: 1470 WIDTH, 40 kg ROLL, 5000 m / 8 h; OD 350 AND CORE 76 PROVISIONAL.",
  "2. SUPPORT SHAFTS IN UCP207 BEARINGS; ALIGN BEARING CENTRES WITHIN 0.5 mm.",
  "3. MEASURING ROLLER CONTACTS FABRIC THROUGH SPRING NIP; PREVENT FABRIC SLIP.",
  "4. VARIABLE LINE SPEED 0-20 m/min; NORMAL PRODUCTION RANGE 12-15 m/min.",
  "5. TARGET <1% REQUIRES ROLLER OD CALIBRATION AND A MEASURED SLIP TEST.",
  "6. FIT E-STOP, HOLD-TO-RUN FOOT CONTROL, TORQUE LIMITER AND PINCH GUARDS.",
  "7. DEBURR; PRIME AND POWDER COAT FRAME AFTER TRIAL ASSEMBLY.",
  "8. GENERAL TOLERANCE +/-1 mm; MACHINED SHAFT FEATURES +/-0.05 mm.",
  "9. VERIFY ROLL OD, CORE, WEB TENSION AND FLOOR SPACE BEFORE RELEASE.",
  "10. PRELIMINARY REV B: FABRICATOR / ENGINEER MUST VALIDATE LOADS BEFORE BUILD.",
];
notes.forEach((value, i) => label(value, 5500, 3220 - i * 120, 38, "TEXT", 0, i === 9 ? 2 : 7));

// Counter wiring and calibration block.
label("COUNTER / CALIBRATION", 5500, 1900, 75, "TITLE", 0, 7);
rect(5480, 950, 2700, 800, "SHEET", 7);
label("ENCODER: INCREMENTAL A/B, >=1024 PPR, 5-24 V", 5550, 1600, 45);
label("DISPLAY: 6-DIGIT TOTALISER, RESET + DIRECTION", 5550, 1500, 42);
label("DRIVE: 0.55 kW GEARMOTOR + VFD, 0-20 m/min PROVISIONAL", 5550, 1400, 42);
label("CONTROL: E-STOP + HOLD-TO-RUN FOOT PEDAL + SPEED KNOB", 5550, 1300, 42);
label("CALIBRATE K AFTER 10 m TEST; VERIFY 3 x 20 m AT <1% ERROR", 5550, 1200, 42);
label("ENC", 7450, 1050, 36);
circle(7530, 1150, 70, "OBJECT", 5);
rect(7700, 1070, 300, 160, "DRIVE", 1);
label("VFD", 7790, 1125, 42, "TEXT", 0, 1);
line(7600, 1150, 7700, 1150, "OBJECT", 5);

// Title block.
rect(5480, 150, 2830, 650, "SHEET", 7);
line(5480, 430, 8310, 430, "SHEET", 7);
line(7000, 150, 7000, 800, "SHEET", 7);
line(7700, 150, 7700, 800, "SHEET", 7);
label("FABRIC ROLL LENGTH METER", 5530, 650, 55, "TITLE", 0, 7);
label("GENERAL ARRANGEMENT & FABRICATION", 5530, 535, 48, "TITLE", 0, 7);
label("DRAWING: FRM-1470-GA-001", 5530, 330, 40);
label("STATUS: PRELIMINARY / NOT FOR PRODUCTION", 5530, 230, 38, "TEXT", 0, 2);
label("REV B", 7080, 650, 65, "TITLE", 0, 7);
label("UNITS mm", 7080, 535, 40);
label("SCALE 1:10", 7080, 330, 40);
label("A1", 7900, 650, 70, "TITLE", 0, 7);
label("2026-10-16", 7790, 535, 38);
label("OPEN CAD STUDIO", 7750, 330, 38);

// Chunked requests keep transport messages small while remaining native OCS edits.
if (!finalizeOnly) {
  await call("/documents", "POST", {});
  const chunkSize = 45;
  for (let offset = 0; offset < entities.length; offset += chunkSize) {
    const chunk = entities.slice(offset, offset + chunkSize);
    await call("/entities", "POST", { entities: chunk });
  }

  // A named A1 paper-space layout is stored in the DWG; the plotted issue uses
  // the exact 1:10 model-space window to keep the drawing deterministic.
  await call("/layouts", "POST", { name: "GA-A1" });
  await call("/layouts/GA-A1/page-setup", "PUT", {
    paper: "ISO_A1_(841.00_x_594.00_MM)",
    orientation: "landscape",
    fit: true,
    center: true,
  });
}

const audit = await call("/audit", "POST", { target_format: "dwg", target_version: "2018" });
const state = await call("/state");
await call("/save_verified", "POST", {
  protocol: 1,
  request_id: `frm-ga-save-verified-rev-b-${state.document_id}`,
  document_id: state.document_id,
  revision: state.revision,
  path: `${outDir}/Fabric_Roll_Meter_Engineering_RevB.dwg`,
  target_format: "dwg",
  target_version: "2018",
  overwrite: true,
});
await call("/plot", "POST", {
  path: `${outDir}/Fabric_Roll_Meter_Engineering_Sheet_RevB_OCS.pdf`,
  layout: "Model",
  area: "window",
  window: [0, 0, 8410, 5940],
  paper: "ISO_A1_(841.00_x_594.00_MM)",
  orientation: "landscape",
  scale: "1:10",
  center: true,
  lineweights: true,
  merge_lines: true,
});

console.log(JSON.stringify({
  ok: true,
  entities: entities.length,
  drawing: `${outDir}/Fabric_Roll_Meter_Engineering_RevB.dwg`,
  plotted_sheet: `${outDir}/Fabric_Roll_Meter_Engineering_Sheet_RevB_OCS.pdf`,
  audit: audit.result ?? audit,
}, null, 2));
