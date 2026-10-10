#!/usr/bin/env node
"use strict";

// Read-only investigation aid. A near-coincident CLO seam is a candidate,
// never an automatically approved sewing instruction for a new drape. These
// edges include GLB internal-opening loops, not just the DXF outer cut.
const fs = require("node:fs");
const { parseStringPromise } = require("xml2js");
const { inspectDxf } = require("../../utils/dxfInspect");
const { referenceSurfaces, auxiliarySurfaces } = require("../../services/rnd/referenceGarment.service");

function edgeKey(a, b) { return `${Math.min(a, b)}:${Math.max(a, b)}`; }
function boundaryEdges(mesh) {
  const counts = new Map();
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    for (let k = 0; k < 3; k += 1) {
      const key = edgeKey(mesh.triangles[t + k], mesh.triangles[t + (k + 1) % 3]);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return new Set([...counts].filter(([, count]) => count === 1).map(([key]) => key));
}
function pathsFor(raw, surfaces) {
  const ids = String(raw || "").split("/").map(Number);
  if (ids.length < 2 || ids.some(id => !Number.isInteger(id) || id < 1)) return [];
  return surfaces.flatMap(({ mesh, edges }) => {
    if (Math.max(...ids) > mesh.uvMm.length / 2
      || !ids.slice(1).every((id, i) => edges.has(edgeKey(ids[i] - 1, id - 1)))) return [];
    let lengthMm = 0;
    for (let i = 1; i < ids.length; i += 1) {
      const a = (ids[i - 1] - 1) * 2, b = (ids[i] - 1) * 2;
      lengthMm += Math.hypot(mesh.uvMm[a] - mesh.uvMm[b],
        mesh.uvMm[a + 1] - mesh.uvMm[b + 1]);
    }
    return [{ mesh, ids, lengthMm }];
  });
}
function meanGapMm(a, b) {
  return a.ids.reduce((sum, id, i) => {
    const ai = (id - 1) * 3, bi = (b.ids[i] - 1) * 3;
    return sum + Math.hypot(a.mesh.positionsMm[ai] - b.mesh.positionsMm[bi],
      a.mesh.positionsMm[ai + 1] - b.mesh.positionsMm[bi + 1],
      a.mesh.positionsMm[ai + 2] - b.mesh.positionsMm[bi + 2]);
  }, 0) / a.ids.length;
}

async function inspectSeamCandidates(glbBuffer, pattern, xmlText) {
  const xml = await parseStringPromise(xmlText, { explicitArray: false });
  const pairList = xml?.MetaData?.SeamLinePairList?.SeamLinePair;
  if (!Array.isArray(pairList)) throw new Error("CLO metadata must contain seam pairs.");
  const surfaces = referenceSurfaces(glbBuffer, pattern)
    .map(mesh => ({ mesh, edges: boundaryEdges(mesh) }));
  const auxiliary = auxiliarySurfaces(glbBuffer, pattern)
    .map(mesh => ({ mesh, edges: boundaryEdges(mesh) }));
  const auxiliaryNames = new Set(auxiliary.map(item => item.mesh.name));
  const allSurfaces = surfaces.concat(auxiliary);
  const signatureGroups = new Map();
  const pairs = pairList.map((pair, index) => {
    if (!Array.isArray(pair.SeamLine) || pair.SeamLine.length !== 2) {
      throw new Error(`Seam pair ${index + 1} does not contain two paths.`);
    }
    const signature = pair.SeamLine.map(line => line.$?.MeshPointIndexes).join("|");
    signatureGroups.set(signature, [...(signatureGroups.get(signature) || []), index + 1]);
    const [left, right] = pair.SeamLine.map(line => pathsFor(line.$?.MeshPointIndexes, surfaces));
    const candidates = left.flatMap(a => right.filter(b => b.ids.length === a.ids.length
      && b.mesh.name !== a.mesh.name).map(b => {
      const ratio = Math.max(a.lengthMm, b.lengthMm)
        / Math.max(0.01, Math.min(a.lengthMm, b.lengthMm));
      return { left: a.mesh.name, right: b.mesh.name, pointCount: a.ids.length,
        leftLengthMm: a.lengthMm, rightLengthMm: b.lengthMm,
        lengthRatio: ratio, meanGapMm: meanGapMm(a, b) };
    })).sort((a, b) => a.meanGapMm - b.meanGapMm);
    const best = candidates[0];
    const unique = best && best.meanGapMm < 2 && best.lengthRatio < 1.1
      && (!candidates[1] || candidates[1].meanGapMm - best.meanGapMm > 5);
    const rawPaths = pair.SeamLine.map(line => line.$?.MeshPointIndexes);
    const auxiliaryLeft = unique ? [] : pathsFor(rawPaths[0], allSurfaces);
    const auxiliaryRight = unique ? [] : pathsFor(rawPaths[1], allSurfaces);
    const auxiliaryHints = auxiliaryLeft
      .flatMap(a => auxiliaryRight
        .filter(b => b.ids.length === a.ids.length && b.mesh.name !== a.mesh.name
          && (auxiliaryNames.has(a.mesh.name) || auxiliaryNames.has(b.mesh.name)))
        .map(b => ({ left: a.mesh.name, right: b.mesh.name,
          meanGapMm: meanGapMm(a, b) })))
      .sort((a, b) => a.meanGapMm - b.meanGapMm).slice(0, 3);
    return { pair: index + 1, status: unique ? "candidate-unique" : "unresolved",
      best: best || null, runnerUp: candidates[1] || null,
      closeCutPieceCandidates: unique ? [] : candidates
        .filter(candidate => candidate.meanGapMm < 2 && candidate.lengthRatio < 1.1)
        .slice(0, 12),
      auxiliaryHints };
  });
  return { pairCount: pairs.length, auxiliaryMeshCount: auxiliary.length,
    uniqueCandidates: pairs.filter(pair => pair.status === "candidate-unique").length,
    unresolved: pairs.filter(pair => pair.status === "unresolved").length,
    repeatedPathGroups: [...signatureGroups.values()].filter(ids => ids.length > 1),
    note: "Source GLB proximity is not proof of sewing-line identity. Inspect unresolved pairs and verify direction before simulation.",
    pairs };
}

if (require.main === module) {
  const [glbPath, dxfPath, xmlPath] = process.argv.slice(2);
  if (!glbPath || !dxfPath || !xmlPath) {
    process.stderr.write("Usage: node scripts/audits/rnd-clo-seam-candidates.js <CLO.glb> <AAMA.dxf> <CLO-metadata.xml>\n");
    process.exitCode = 2;
  } else {
    inspectSeamCandidates(fs.readFileSync(glbPath), inspectDxf(fs.readFileSync(dxfPath)),
      fs.readFileSync(xmlPath, "utf8"))
      .then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
      .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  }
}

module.exports = { inspectSeamCandidates };
