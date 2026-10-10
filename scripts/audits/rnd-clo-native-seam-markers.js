#!/usr/bin/env node
"use strict";

// Read-only probe of a CLO .pac extracted from a .zprj/.zpac. This does not
// decode construction ownership or claim that marker names license a drape.
const fs = require("node:fs");
const { parseStringPromise } = require("xml2js");

function offsetsOf(buffer, text) {
  const needle = Buffer.from(text);
  const offsets = [];
  for (let at = 0; (at = buffer.indexOf(needle, at)) >= 0; at += needle.length) offsets.push(at);
  return offsets;
}

async function inspectNativeSeamMarkers(pac, metadataXml) {
  if (!Buffer.isBuffer(pac)) throw new Error("A CLO .pac buffer is required.");
  const xml = await parseStringPromise(metadataXml, { explicitArray: false });
  const rawPairs = xml?.MetaData?.SeamLinePairList?.SeamLinePair;
  const pairs = rawPairs ? (Array.isArray(rawPairs) ? rawPairs : [rawPairs]) : [];
  if (!pairs.length) throw new Error("CLO sewing-pair XML is required.");
  const offsets = offsetsOf(pac, "mapSeamLinePairList");
  if (offsets.length < pairs.length) {
    throw new Error("The .pac contains fewer seam records than the XML.");
  }
  const records = pairs.map((pair, i) => {
    const record = pac.subarray(offsets[i], offsets[i + 1]);
    const markers = offsetsOf(record, "arrMeshPointIndex");
    if (markers.length < 2 || !Array.isArray(pair.SeamLine) || pair.SeamLine.length !== 2) {
      throw new Error(`Native seam record ${i + 1} does not contain two paths.`);
    }
    const nativePaths = markers.slice(0, 2).map(position => {
      const at = position + Buffer.byteLength("arrMeshPointIndex");
      if (at + 5 > record.length) throw new Error(`Native seam ${i + 1} is truncated.`);
      const count = record.readUInt32LE(at);
      const type = record.readUInt8(at + 4);
      if (type !== 5 || count < 2 || count > 1000 || at + 5 + count * 4 > record.length) {
        throw new Error(`Native seam ${i + 1} has unsupported index data.`);
      }
      return Array.from({ length: count }, (_, k) => record.readUInt32LE(at + 5 + k * 4));
    });
    const xmlPaths = pair.SeamLine.map(line =>
      String(line?.$?.MeshPointIndexes || "").split("/").map(Number).map(n => n - 1));
    if (JSON.stringify(nativePaths) !== JSON.stringify(xmlPaths)) {
      throw new Error(`Native seam ${i + 1} does not match XML pair ${i + 1}; record order cannot be assumed.`);
    }
    const recordText = record.toString("latin1");
    const topstitchNameMarkers = [...new Set(recordText.match(/qsNameTopstitch_\d+/g) || [])];
    const sewingNameMarkers = [...new Set(recordText.match(/qsNameSewing_\d+/g) || [])];
    // Each source path is preceded by its own uiSelfIndex in mapSeamLine0/1.
    // Later copies of the field exist in the record and must not be mistaken
    // for these owners. These are local piece IDs, not GLB vertex indices.
    const ownerMarkers = markers.slice(0, 2).map((pathAt, pathIndex) => {
      const position = record.lastIndexOf("uiSelfIndex", pathAt);
      return position > (markers[pathIndex - 1] ?? -1) ? position : null;
    });
    const nativeOwnerIndices = ownerMarkers.filter(position => position !== null).map(position => {
      const at = position + Buffer.byteLength("uiSelfIndex");
      if (at + 4 > record.length) throw new Error(`Native seam ${i + 1} has a truncated piece index.`);
      return record.readUInt32LE(at);
    });
    return { pair: i + 1,
      sewingNameMarker: sewingNameMarkers.length > 0,
      topstitchNameMarkers,
      sewingNameMarkers,
      nativeOwnerIndices,
      pointCounts: nativePaths.map(path => path.length) };
  });
  return { verifiedPairCount: records.length,
    sewingMarkerCount: records.filter(record => record.sewingNameMarker).length,
    noSewingMarkerCount: records.filter(record => !record.sewingNameMarker).length,
    note: "Topstitch and Sewing names are native-project references, not a decoded structural-seam classification or edge owner. A record may contain both.",
    records };
}

if (require.main === module) {
  const [pacPath, xmlPath] = process.argv.slice(2);
  if (!pacPath || !xmlPath) {
    process.stderr.write("Usage: node scripts/audits/rnd-clo-native-seam-markers.js <extracted-design02.pac> <CLO-metadata.xml>\n");
    process.exitCode = 2;
  } else {
    inspectNativeSeamMarkers(fs.readFileSync(pacPath), fs.readFileSync(xmlPath, "utf8"))
      .then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
      .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  }
}

module.exports = { inspectNativeSeamMarkers };
