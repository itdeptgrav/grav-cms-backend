const fs = require('fs');
const path = require('path');

const outDir = __dirname;
const objPath = path.join(outDir, 'fabric_roll_meter_40kg.obj');
const mtlPath = path.join(outDir, 'fabric_roll_meter_40kg.mtl');

const verts = [];
const faces = [];
const groups = [];

function addVertex(x, y, z) {
  verts.push([x, y, z]);
  return verts.length;
}

function addBox(name, x, y, z, dx, dy, dz, material) {
  const start = faces.length;
  const v = [
    addVertex(x, y, z), addVertex(x + dx, y, z),
    addVertex(x + dx, y + dy, z), addVertex(x, y + dy, z),
    addVertex(x, y, z + dz), addVertex(x + dx, y, z + dz),
    addVertex(x + dx, y + dy, z + dz), addVertex(x, y + dy, z + dz),
  ];
  faces.push([v[0], v[3], v[2], v[1]], [v[4], v[5], v[6], v[7]]);
  faces.push([v[0], v[1], v[5], v[4]], [v[1], v[2], v[6], v[5]]);
  faces.push([v[2], v[3], v[7], v[6]], [v[3], v[0], v[4], v[7]]);
  groups.push({ name, material, start, end: faces.length });
}

function addCylinderX(name, x0, x1, y, z, radius, material, segments = 32) {
  const start = faces.length;
  const left = [];
  const right = [];
  for (let i = 0; i < segments; i++) {
    const a = 2 * Math.PI * i / segments;
    const yy = y + radius * Math.cos(a);
    const zz = z + radius * Math.sin(a);
    left.push(addVertex(x0, yy, zz));
    right.push(addVertex(x1, yy, zz));
  }
  const c0 = addVertex(x0, y, z);
  const c1 = addVertex(x1, y, z);
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    faces.push([left[i], left[j], right[j], right[i]]);
    faces.push([c0, left[i], left[j]]);
    faces.push([c1, right[j], right[i]]);
  }
  groups.push({ name, material, start, end: faces.length });
}

function addPanel(name, points, material) {
  const start = faces.length;
  const ids = points.map(([x, y, z]) => addVertex(x, y, z));
  faces.push(ids);
  groups.push({ name, material, start, end: faces.length });
}

// Overall envelope: 1750 W x 450 D x 520 H mm; usable fabric width: 1470 mm.
// Frame: 40 x 40 mm mild-steel square tube, sized for a 40 kg roll with margin.
addBox('base_front', 0, 0, 0, 1650, 40, 40, 'frame_blue');
addBox('base_rear', 0, 410, 0, 1650, 40, 40, 'frame_blue');
addBox('base_left', 0, 40, 0, 40, 370, 40, 'frame_blue');
addBox('base_right', 1610, 40, 0, 40, 370, 40, 'frame_blue');

for (const x of [0, 1610]) {
  addBox(`front_post_${x}`, x, 0, 40, 40, 40, 390, 'frame_blue');
  addBox(`rear_post_${x}`, x, 410, 40, 40, 40, 390, 'frame_blue');
}

// 35 mm steel shafts and supported working rollers.
addCylinderX('supply_shaft', 10, 1640, 390, 355, 17.5, 'steel');
addCylinderX('supply_roll', 70, 1580, 390, 355, 125, 'fabric');
addCylinderX('takeup_shaft', 10, 1640, 65, 135, 17.5, 'steel');
addCylinderX('takeup_core', 70, 1580, 65, 135, 42, 'cardboard');
addCylinderX('measuring_roller', 55, 1595, 205, 235, 38, 'rubber');
addCylinderX('pressure_roller', 55, 1595, 260, 315, 42, 'rubber');

// Fabric path, shown as two wide guide surfaces rather than a load-bearing part.
addPanel('fabric_feed', [[85, 300, 365], [1565, 300, 365], [1565, 218, 282], [85, 218, 282]], 'fabric_sheet');
addPanel('fabric_takeup', [[85, 192, 205], [1565, 192, 205], [1565, 90, 178], [85, 90, 178]], 'fabric_sheet');

// Bearing housings at each shaft end.
for (const x of [10, 1595]) {
  addBox(`bearing_supply_${x}`, x, 365, 320, 45, 50, 70, 'bearing');
  addBox(`bearing_takeup_${x}`, x, 40, 100, 45, 50, 70, 'bearing');
  addBox(`bearing_measure_${x}`, x, 180, 200, 45, 50, 70, 'bearing');
}

// Spring pressure arms, encoder enclosure, counter and hand crank.
addBox('pressure_arm_left', 20, 230, 260, 28, 40, 120, 'frame_blue');
addBox('pressure_arm_right', 1602, 230, 260, 28, 40, 120, 'frame_blue');
addBox('encoder_mount', 1600, 175, 185, 75, 60, 95, 'printed_black');
addBox('counter_display', 1585, 270, 330, 130, 45, 95, 'printed_black');
addBox('crank_arm', 1640, 55, 120, 95, 20, 20, 'steel');
addBox('crank_handle', 1715, 55, 75, 20, 20, 65, 'printed_black');

let obj = '# Compact hand-crank fabric meter for 1470 mm fabric / 40 kg roll\n';
obj += 'mtllib fabric_roll_meter_40kg.mtl\n';
for (const [x, y, z] of verts) obj += `v ${x} ${y} ${z}\n`;
for (const group of groups) {
  obj += `g ${group.name}\nusemtl ${group.material}\n`;
  for (let i = group.start; i < group.end; i++) obj += `f ${faces[i].join(' ')}\n`;
}

const mtl = `newmtl frame_blue\nKd 0.04 0.26 0.72\nKs 0.35 0.35 0.35\nNs 80\n\nnewmtl steel\nKd 0.58 0.61 0.65\nKs 0.7 0.7 0.7\nNs 120\n\nnewmtl bearing\nKd 0.10 0.13 0.18\nKs 0.45 0.45 0.45\nNs 80\n\nnewmtl rubber\nKd 0.10 0.11 0.12\nKs 0.15 0.15 0.15\nNs 20\n\nnewmtl fabric\nKd 0.92 0.91 0.83\nKs 0.08 0.08 0.08\nNs 10\n\nnewmtl fabric_sheet\nKd 0.96 0.95 0.88\nKs 0.05 0.05 0.05\nNs 5\n\nnewmtl cardboard\nKd 0.58 0.38 0.18\nKs 0.05 0.05 0.05\nNs 5\n\nnewmtl printed_black\nKd 0.03 0.04 0.05\nKs 0.25 0.25 0.25\nNs 45\n`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(objPath, obj);
fs.writeFileSync(mtlPath, mtl);
console.log(objPath);
