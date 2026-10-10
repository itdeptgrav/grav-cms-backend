import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { inspectReferenceGarment, proportionalScaleOf, makeReferencePreviewGlb,
  auxiliarySurfaces } = require("./referenceGarment.service.js");
const { readContainer } = require("../../utils/glbInspect.js");

function glbForSurface(name, uv, triangles, auxiliaryName = null) {
  const count = uv.length / 2;
  const position = Buffer.alloc(count * 12);
  const texcoord = Buffer.alloc(count * 8);
  const index = Buffer.alloc(triangles.length * 2);
  for (let i = 0; i < count; i += 1) {
    position.writeFloatLE(uv[i * 2] / 1000, i * 12);
    position.writeFloatLE(0, i * 12 + 4);
    position.writeFloatLE(uv[i * 2 + 1] / 1000, i * 12 + 8);
    texcoord.writeFloatLE(uv[i * 2], i * 8);
    texcoord.writeFloatLE(uv[i * 2 + 1], i * 8 + 4);
  }
  for (let i = 0; i < triangles.length; i += 1) index.writeUInt16LE(triangles[i], i * 2);
  const binary = Buffer.concat([position, texcoord, index]);
  const paddedBinary = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4)]);
  const json = {
    asset: { version: "2.0", generator: "CLO test fixture" },
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: position.length },
      { buffer: 0, byteOffset: position.length, byteLength: texcoord.length },
      { buffer: 0, byteOffset: position.length + texcoord.length, byteLength: index.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count, type: "VEC2" },
      { bufferView: 2, componentType: 5123, count: triangles.length, type: "SCALAR" },
    ],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2 }] },
      ...(auxiliaryName ? [{ name: auxiliaryName,
        primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2 }] }] : [])],
    nodes: [{ name: "Root", children: [1, 3] }, { name: "Cloth", children: [2] },
      { name: `${name}_Node`, mesh: 0 }, { name: "Avatar", translation: [2, 3, 4] }],
    scenes: [{ nodes: [0] }], scene: 0,
  };
  const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const paddedJson = Buffer.concat([jsonBytes, Buffer.alloc((4 - jsonBytes.length % 4) % 4, 32)]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + paddedJson.length + 8 + paddedBinary.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJson.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(paddedBinary.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, paddedJson, binHeader, paddedBinary]);
}

const rectangle = (x0, y0, x1, y1) => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

test("a named GLB panel with the same physical DXF outline is a compatible reference", () => {
  const glb = glbForSurface("Front", [0, 0, 10, 0, 10, 8, 0, 8], [0, 1, 2, 0, 2, 3]);
  const pattern = { unitInMm: 1, pieces: [{ name: "Front", outline: rectangle(20, 30, 30, 38) }] };
  const report = inspectReferenceGarment(glb, pattern, { maxMeanErrorMm: 0.1, maxWorstErrorMm: 0.1 });
  assert.equal(report.compatible, true);
  assert.equal(report.pieces[0].triangles, 2);
  assert.ok(report.pieces[0].fit.meanErrorMm < 1e-6);
});

test("auxiliary CLO meshes stay separate from the verified DXF cut pieces", () => {
  const glb = glbForSurface("Front", [0, 0, 10, 0, 10, 8, 0, 8],
    [0, 1, 2, 0, 2, 3], "PipingPattern_1");
  const pattern = { unitInMm: 1, pieces: [{ name: "Front", outline: rectangle(0, 0, 10, 8) }] };
  const extra = auxiliarySurfaces(glb, pattern);
  assert.deepEqual(extra.map(mesh => mesh.name), ["PipingPattern_1"]);
  assert.equal(extra[0].positionsMm.length / 3, 4);
});

test("a GLB of a different cut width is refused rather than treated as calibration", () => {
  const glb = glbForSurface("Front", [0, 0, 10, 0, 10, 8, 0, 8], [0, 1, 2, 0, 2, 3]);
  const pattern = { unitInMm: 1, pieces: [{ name: "Front", outline: rectangle(20, 30, 35, 38) }] };
  const report = inspectReferenceGarment(glb, pattern, { maxMeanErrorMm: 0.1, maxWorstErrorMm: 0.1 });
  assert.equal(report.compatible, false);
  assert.match(report.problems[0], /cannot calibrate/);
});

test("a folded band is matched against its published centre fold as well as cut edge", () => {
  const uv = [0, 0, 5, 0, 10, 0, 0, 1, 5, 1, 10, 1,
    0, 1, 5, 1, 10, 1, 0, 2, 5, 2, 10, 2];
  const glb = glbForSurface("Band", uv, [0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4,
    6, 7, 10, 6, 10, 9, 7, 8, 11, 7, 11, 10]);
  const band = { name: "Band", outline: rectangle(0, 0, 10, 2),
    internalLines: [{ points: [{ x: 0, y: 1 }, { x: 10, y: 1 }] }] };
  const exact = inspectReferenceGarment(glb, { unitInMm: 1, pieces: [band] },
    { maxMeanErrorMm: 0.1, maxWorstErrorMm: 0.1 });
  assert.equal(exact.compatible, true);
  assert.equal(exact.pieces[0].foldLineRecognised, true);
  const withoutFold = inspectReferenceGarment(glb, { unitInMm: 1, pieces: [
    { ...band, internalLines: [] },
  ] }, { maxMeanErrorMm: 0.1, maxWorstErrorMm: 0.1 });
  assert.equal(withoutFold.compatible, false);
});

test("an internal front opening is not mistaken for a different outer cut outline", () => {
  const uv = [0, 0, 10, 0, 10, 8, 0, 8, 4, 3, 6, 3, 6, 5, 4, 5];
  const ring = [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  const glb = glbForSurface("Front", uv, ring);
  const report = inspectReferenceGarment(glb, { unitInMm: 1, pieces: [
    { name: "Front", outline: rectangle(0, 0, 10, 8) },
  ] }, { maxMeanErrorMm: 0.1, maxWorstErrorMm: 0.1 });
  assert.equal(report.compatible, true);
  assert.equal(report.pieces[0].internalBoundaryCount, 1);
  assert.ok(report.pieces[0].fit.worstErrorMm < 0.00001);
});

test("a reference is not accepted when DXF scale or a named panel is missing", () => {
  const glb = glbForSurface("Front", [0, 0, 10, 0, 10, 8, 0, 8], [0, 1, 2, 0, 2, 3]);
  assert.throws(() => inspectReferenceGarment(glb, { pieces: [{ name: "Front" }] }),
    /scale must be verified/);
  assert.throws(() => inspectReferenceGarment(glb, { unitInMm: 1,
    pieces: [{ name: "Back", outline: rectangle(0, 0, 10, 8) }] }), /no mesh named/);
});

test("an unchanged or uniformly scaled pattern gets a labelled reference preview", () => {
  const source = { unitInMm: 1, pieces: [
    { name: "Front", outline: rectangle(20, 30, 120, 180) },
    { name: "Sleeve", outline: rectangle(220, 30, 300, 100) },
  ] };
  assert.equal(proportionalScaleOf(source, source).scale, 1);
  const edited = { unitInMm: 1, pieces: source.pieces.map(piece => ({ ...piece,
    outline: piece.outline.map(p => ({ x: 30 + 1.05 * p.x, y: -40 + 1.05 * p.y })),
  })) };
  const result = proportionalScaleOf(source, edited);
  assert.ok(Math.abs(result.scale - 1.05) < 1e-12);
  assert.equal(result.previewOnly, true);
  assert.match(result.warning, /not a newly simulated fit/);
});

test("a separately graded sleeve is refused because a global 3D scale would open seams", () => {
  const source = { unitInMm: 1, pieces: [
    { name: "Front", outline: rectangle(0, 0, 100, 150) },
    { name: "Sleeve", outline: rectangle(0, 0, 80, 70) },
  ] };
  const edited = { unitInMm: 1, pieces: [source.pieces[0],
    { name: "Sleeve", outline: rectangle(0, 0, 84, 73.5) }] };
  assert.throws(() => proportionalScaleOf(source, edited), /graded by different amounts/);
});

test("a reshaped panel or changed piece set is refused", () => {
  const source = { unitInMm: 1, pieces: [{ name: "Front", outline: rectangle(0, 0, 100, 150) }] };
  const reshaped = { unitInMm: 1, pieces: [{ name: "Front", outline: [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 95, y: 150 }, { x: 0, y: 150 },
  ] }] };
  assert.throws(() => proportionalScaleOf(source, reshaped), /reshaped/);
  assert.throws(() => proportionalScaleOf(source, { unitInMm: 1, pieces: [] }), /piece set/);
});

test("derived GLB scales Cloth around its center but preserves the original and avatar", () => {
  const glb = glbForSurface("Front", [0, 0, 10, 0, 10, 8, 0, 8], [0, 1, 2, 0, 2, 3]);
  const originalBytes = Buffer.from(glb);
  const source = { unitInMm: 1, pieces: [{ name: "Front", outline: rectangle(0, 0, 10, 8) }] };
  const edited = { unitInMm: 1, pieces: [{ name: "Front", outline: rectangle(0, 0, 10.5, 8.4) }] };
  const preview = makeReferencePreviewGlb(glb, source, edited);
  assert.equal(preview.previewOnly, true);
  assert.ok(Math.abs(preview.scale - 1.05) < 1e-12);
  const result = readContainer(preview.glb);
  assert.ok(result.json.nodes[1].scale.every(value => Math.abs(value - 1.05) < 1e-12));
  assert.deepEqual(result.json.nodes[3].translation, [2, 3, 4]);
  assert.deepEqual(glb, originalBytes);
  assert.deepEqual(readContainer(glb).json.nodes[1], { name: "Cloth", children: [2] });
  assert.equal(result.binBytes, readContainer(glb).binBytes);
  assert.match(preview.warning, /not a newly simulated fit/);
});

test("derived GLB refuses a source mesh outside the Cloth group", () => {
  const glb = glbForSurface("Front", [0, 0, 10, 0, 10, 8, 0, 8], [0, 1, 2, 0, 2, 3]);
  const malformed = Buffer.from(glb);
  const jsonStart = 20;
  const jsonLength = malformed.readUInt32LE(12);
  const originalJson = malformed.subarray(jsonStart, jsonStart + jsonLength).toString("utf8");
  const modifiedJson = originalJson.replace('"Cloth","children":[2]', '"Cloth","children":[3]');
  assert.notEqual(modifiedJson, originalJson);
  malformed.write(modifiedJson, jsonStart, "utf8");
  const source = { unitInMm: 1, pieces: [{ name: "Front", outline: rectangle(0, 0, 10, 8) }] };
  assert.throws(() => makeReferencePreviewGlb(malformed, source, source), /outside the Cloth group/);
});
