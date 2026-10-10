import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { inspectNativeSeamMarkers } = require("./rnd-clo-native-seam-markers.js");

function path(indices) {
  const header = Buffer.alloc(5);
  header.writeUInt32LE(indices.length);
  header.writeUInt8(5, 4);
  const values = Buffer.alloc(indices.length * 4);
  indices.forEach((value, i) => values.writeUInt32LE(value, i * 4));
  return Buffer.concat([Buffer.from("arrMeshPointIndex"), header, values]);
}
function owner(index) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(index);
  return Buffer.concat([Buffer.from("uiSelfIndex"), bytes]);
}
const xml = `<MetaData><SeamLinePairList><SeamLinePair><SeamLine MeshPointIndexes="1/2"/><SeamLine MeshPointIndexes="4/5"/></SeamLinePair></SeamLinePairList></MetaData>`;

test("native path bytes must match XML exactly before a sewing marker is reported", async () => {
  const pac = Buffer.concat([Buffer.from("mapSeamLinePairList"), owner(3), path([0, 1]),
    owner(4), path([3, 4]), Buffer.from("qsNameTopstitch_22qsNameTopstitch_23qsNameSewing_123")]);
  const report = await inspectNativeSeamMarkers(pac, xml);
  assert.equal(report.verifiedPairCount, 1);
  assert.equal(report.sewingMarkerCount, 1);
  assert.equal(report.records[0].pair, 1);
  assert.deepEqual(report.records[0].topstitchNameMarkers,
    ["qsNameTopstitch_22", "qsNameTopstitch_23"]);
  assert.deepEqual(report.records[0].sewingNameMarkers, ["qsNameSewing_123"]);
  assert.deepEqual(report.records[0].nativeOwnerIndices, [3, 4]);
  await assert.rejects(inspectNativeSeamMarkers(pac, xml.replace("4/5", "4/6")),
    /does not match XML/);
});

test("a record without a sewing name is reported, not silently called structural", async () => {
  const pac = Buffer.concat([Buffer.from("mapSeamLinePairList"), path([0, 1]), path([3, 4])]);
  const report = await inspectNativeSeamMarkers(pac, xml);
  assert.equal(report.noSewingMarkerCount, 1);
  assert.equal(report.records[0].sewingNameMarker, false);
  assert.deepEqual(report.records[0].topstitchNameMarkers, []);
});
