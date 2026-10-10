import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { inspectCloCalibration, sourceEdgeMetrics } = require("./cloCalibration.service.js");

function fixtureGlb() {
  const positions = Buffer.alloc(4 * 12);
  const uv = Buffer.alloc(4 * 8);
  const indices = Buffer.alloc(6 * 2);
  const points = [[0, 0], [10, 0], [10, 8], [0, 8]];
  points.forEach(([x, y], i) => {
    positions.writeFloatLE(x / 1000, i * 12);
    positions.writeFloatLE(y / 1000, i * 12 + 4);
    uv.writeFloatLE(x, i * 8);
    uv.writeFloatLE(y, i * 8 + 4);
  });
  [0, 1, 2, 0, 2, 3].forEach((v, i) => indices.writeUInt16LE(v, i * 2));
  const bin = Buffer.concat([positions, uv, indices]);
  const json = { asset: { version: "2.0", generator: "CLO fixture" },
    buffers: [{ byteLength: bin.length }], bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length },
      { buffer: 0, byteOffset: positions.length, byteLength: uv.length },
      { buffer: 0, byteOffset: positions.length + uv.length, byteLength: indices.length },
    ], accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: 4, type: "VEC2" },
      { bufferView: 2, componentType: 5123, count: 6, type: "SCALAR" },
    ], materials: [{ name: "Jersey_FRONT_24" }],
    meshes: [{ name: "Panel", primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 },
      indices: 2, material: 0 }] }] };
  const source = Buffer.from(JSON.stringify(json));
  const jsonBytes = Buffer.concat([source, Buffer.alloc((4 - source.length % 4) % 4, 32)]);
  const binBytes = Buffer.concat([bin, Buffer.alloc((4 - bin.length % 4) % 4)]);
  const header = Buffer.alloc(12);
  header.write("glTF"); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + binBytes.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBytes.length); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(binBytes.length); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonBytes, bh, binBytes]);
}

const pattern = { unitInMm: 1, pieces: [{ name: "Panel", pieceRef: "P-1", outline: [
  { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 },
] }] };
const metadata = `<MetaData><PhysicalPropertyList><PhysicalProperty PhysicalPropertyName="Jersey_0" Density="0.0002" FrictionCoefficient="0.03"/></PhysicalPropertyList><SeamLinePairList><SeamLinePair><SeamLine MeshPointIndexes="1/2/3"/><SeamLine MeshPointIndexes="7/8/9"/></SeamLinePair></SeamLinePairList></MetaData>`;

test("a CLO source audit matches each piece to its material without claiming seam ownership", async () => {
  const glb = fixtureGlb();
  const unchanged = Buffer.from(glb);
  const report = await inspectCloCalibration(glb, pattern, metadata);
  assert.equal(report.kind, "clo-source-calibration-target");
  assert.equal(report.sourcePiecesMatched, true);
  assert.equal(report.seamOwnershipVerified, false);
  assert.equal(report.readyForParameterTuning, false);
  assert.match(report.limitations.join(" "), /MeshList is empty/);
  assert.equal(report.seamPairCount, 1);
  assert.equal(report.pieces[0].physicalProperty, "Jersey_0");
  assert.equal(report.pieces[0].sourceGeometry.edgeCount, 5);
  assert.ok(Math.abs(report.pieces[0].sourceGeometry.medianRatio - 1) < 0.00001);
  assert.deepEqual(glb, unchanged);
});

test("material or physical metadata gaps cannot silently become calibrated fabric", async () => {
  const changed = metadata.replace("Jersey_0", "Other_0");
  const report = await inspectCloCalibration(fixtureGlb(), pattern, changed);
  assert.equal(report.sourcePiecesMatched, false);
  assert.equal(report.readyForParameterTuning, false);
  assert.equal(report.pieces[0].physicalProperty, null);
  await assert.rejects(inspectCloCalibration(fixtureGlb(), pattern,
    metadata.replace('MeshPointIndexes="7/8/9"', 'MeshPointIndexes="broken"')),
  /invalid vertex path/);
});

test("source edge metrics expose deformation rather than assuming a flat reference", () => {
  const metrics = sourceEdgeMetrics({ positionsMm: [0, 0, 0, 5, 0, 0, 5, 8, 0],
    uvMm: [0, 0, 10, 0, 10, 8], triangles: [0, 1, 2] });
  assert.equal(metrics.edgeCount, 3);
  assert.ok(metrics.fifthPercentileRatio < 0.75);
  assert.equal(metrics.belowSeventyFivePercent, 2);
});
