#!/usr/bin/env node
"use strict";

// Diagnostic only: recover 2D path coordinates and source references for a
// verified CLO DXF/GLB/PAC/XML set. Never use the finished GLB's 3D positions
// to place or correct a simulated garment.
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { parseStringPromise } = require("xml2js");
const { inspectDxf } = require("../../utils/dxfInspect");
const { inspectReferenceGarment, referenceSurfaces,
  auxiliarySurfaces } = require("../../services/rnd/referenceGarment.service");

function fromReferenceUv(uv, fit) {
  if (!Array.isArray(uv) || uv.length !== 2 || !uv.every(Number.isFinite)
    || !fit || ![fit.sx, fit.sy, ...(fit.shift || [])].every(Number.isFinite)
    || !fit.sx || !fit.sy || fit.shift?.length !== 2) {
    throw new Error("A source path cannot be placed on a verified DXF panel.");
  }
  const a = (uv[0] - fit.shift[0]) / fit.sx;
  const b = (uv[1] - fit.shift[1]) / fit.sy;
  return fit.swap ? [b, a] : [a, b];
}

function sourcePathIds(text, max) {
  const ids = String(text || "").split("/").map(Number);
  if (ids.length < 2 || ids.some(id => !Number.isSafeInteger(id) || id < 1 || id > max)) {
    throw new Error("A native path has invalid or out-of-range mesh-point indices.");
  }
  return ids;
}

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

async function buildConstructionManifest({ dxfBytes, glbBytes, xmlBytes,
  pacBytes, ownership }) {
  const pattern = inspectDxf(dxfBytes);
  const reference = inspectReferenceGarment(glbBytes, pattern);
  if (!reference.compatible) throw new Error(reference.problems.join(" "));
  const xml = await parseStringPromise(xmlBytes.toString("utf8"), { explicitArray: false });
  const rawPairs = xml?.MetaData?.SeamLinePairList?.SeamLinePair;
  if (!Array.isArray(rawPairs) || rawPairs.length !== ownership.pairs?.length) {
    throw new Error("Source pair count does not match verified native ownership.");
  }
  const cutMeshes = new Map(referenceSurfaces(glbBytes, pattern).map(s => [s.name, s]));
  const extraMeshes = new Map(auxiliarySurfaces(glbBytes, pattern).map(s => [s.name, s]));
  const fits = new Map(reference.pieces.map(p => [p.name, p.fit]));
  const unit = pattern.unitInMm;
  const mm = p => [Number(p.x) * unit, Number(p.y) * unit];
  const panels = pattern.pieces.map(p => ({
    name: p.name,
    sourcePieceRef: p.pieceRef || null,
    outerCutMm: p.outline.map(mm),
    internalLines: (p.internalLines || []).map((line, index) => ({
      index, pointsMm: line.points.map(mm), closed: Boolean(line.closed),
    })),
  }));
  const paths = ownership.pairs.map((pair, index) => {
    const native = rawPairs[index];
    if (native.SeamLine?.length !== 2 || pair.pair !== index + 1
      || !pair.left || !pair.right) {
      throw new Error(`Pair ${index + 1} has no two verified named owners.`);
    }
    const sides = [pair.left, pair.right].map((name, side) => {
      const surface = cutMeshes.get(name) || extraMeshes.get(name);
      if (!surface) throw new Error(`Pair ${pair.pair} owner ${name} has no reference UV surface.`);
      const ids = sourcePathIds(native.SeamLine[side].$?.MeshPointIndexes,
        surface.uvMm.length / 2);
      const uv = ids.map(id => [surface.uvMm[2 * (id - 1)],
        surface.uvMm[2 * (id - 1) + 1]]);
      const fit = fits.get(name);
      const sourceEvidence = pair.dxfPathDistance?.[side] || null;
      return {
        owner: name,
        ownerIndex: side ? pair.rightIndex : pair.leftIndex,
        sourceMeshPointIndices: ids,
        coordinateSpace: fit ? "dxf-panel-mm" : "reference-glb-uv-mm-only",
        points: fit ? uv.map(p => fromReferenceUv(p, fit)) : uv,
        outlineArc: fit && pair.dxfLocation === "both-on-outer-cut"
          ? sourceEvidence?.arc || null : null,
        internalLine: fit && pair.dxfLocation === "interior-attachment"
          ? sourceEvidence?.internalLine || null : null,
      };
    });
    return {
      pair: pair.pair,
      location: pair.dxfLocation,
      ownerEvidence: pair.pathEvidence,
      sides,
      operation: "not-yet-confirmed",
      solverConstraintReady: false,
    };
  });
  const counts = Object.fromEntries([...new Set(paths.map(p => p.location))]
    .map(location => [location, paths.filter(p => p.location === location).length]));
  return {
    kind: "grav-shirt-construction-source-manifest",
    version: 1,
    sourceHashes: { dxf: sha256(dxfBytes), glb: sha256(glbBytes),
      xml: sha256(xmlBytes), pac: sha256(pacBytes) },
    unit: "mm",
    panels,
    paths,
    counts,
    usedFinishedGlbPositionsForPlacement: false,
    readyForDrape: false,
    warning: "2D path identity is mapped, but structural operation, cut-versus-sew position, fabric, avatar registration and panel arrangement are not yet confirmed.",
  };
}

if (require.main === module) {
  const [pacPath, glbPath, dxfPath, xmlPath] = process.argv.slice(2);
  if (![pacPath, glbPath, dxfPath, xmlPath].every(Boolean)) {
    process.stderr.write("Usage: node scripts/audits/rnd-shirt-construction-manifest.js <extracted.pac> <CLO.glb> <AAMA.dxf> <CLO-metadata.xml>\n");
    process.exitCode = 2;
  } else {
    (async () => {
      const ownership = JSON.parse(execFileSync(process.execPath,
        [require.resolve("./rnd-clo-seam-ownership"), pacPath, glbPath, dxfPath, xmlPath],
        { maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }));
      const manifest = await buildConstructionManifest({
        pacBytes: fs.readFileSync(pacPath), glbBytes: fs.readFileSync(glbPath),
        dxfBytes: fs.readFileSync(dxfPath), xmlBytes: fs.readFileSync(xmlPath),
        ownership,
      });
      process.stdout.write(`${JSON.stringify(manifest)}\n`);
    })().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  }
}

module.exports = { fromReferenceUv, sourcePathIds, buildConstructionManifest };
