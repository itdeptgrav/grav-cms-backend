#!/usr/bin/env node
"use strict";

// Read-only join of native CLO local piece IDs to the named GLB meshes.
// It resolves *ownership* through independent geometric anchors; it does not
// prove that every indexed path is a usable cut/sewing edge for our solver.
const fs = require("node:fs");
const { parseStringPromise } = require("xml2js");
const { inspectDxf } = require("../../utils/dxfInspect");
const { inspectReferenceGarment, referenceSurfaces } = require("../../services/rnd/referenceGarment.service");
const { inspectNativeSeamMarkers } = require("./rnd-clo-native-seam-markers");
const { inspectSeamCandidates } = require("./rnd-clo-seam-candidates");

function resolveNativeSeamOwnership(native, geometry) {
  if (native.records.length !== geometry.pairs.length
    || native.records.some((record, i) => record.pair !== geometry.pairs[i].pair
      || record.nativeOwnerIndices.length !== 2)) {
    throw new Error("Native records and geometric seam pairs must align and each have two local owner indices.");
  }
  const ownerByIndex = new Map();
  const evidenceByIndex = new Map();
  const assign = (index, name, evidence) => {
    const prior = ownerByIndex.get(index);
    if (prior && prior !== name) {
      throw new Error(`Native piece index ${index} conflicts: ${prior} versus ${name}.`);
    }
    if (!prior) { ownerByIndex.set(index, name); evidenceByIndex.set(index, evidence); }
  };
  for (let i = 0; i < native.records.length; i += 1) {
    const record = native.records[i], pair = geometry.pairs[i];
    if (pair.status !== "candidate-unique") continue;
    assign(record.nativeOwnerIndices[0], pair.best.left, `unique cut-piece pair ${record.pair}`);
    assign(record.nativeOwnerIndices[1], pair.best.right, `unique cut-piece pair ${record.pair}`);
  }
  // Propagate only a single close alternative consistent with *already*
  // anchored IDs. This resolves mirrored records without picking the first
  // visually close side. Iterate because a newly learned ID can disambiguate
  // another record.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < native.records.length; i += 1) {
      const ids = native.records[i].nativeOwnerIndices;
      const options = geometry.pairs[i].closeCutPieceCandidates.filter(candidate =>
        (!ownerByIndex.has(ids[0]) || ownerByIndex.get(ids[0]) === candidate.left)
        && (!ownerByIndex.has(ids[1]) || ownerByIndex.get(ids[1]) === candidate.right));
      if (options.length !== 1) continue;
      const before = ownerByIndex.size;
      assign(ids[0], options[0].left, `anchored close cut-piece pair ${i + 1}`);
      assign(ids[1], options[0].right, `anchored close cut-piece pair ${i + 1}`);
      if (ownerByIndex.size > before) changed = true;
    }
  }
  // Auxiliary piping is kept separate from the 13 named DXF cut pieces.
  for (let i = 0; i < native.records.length; i += 1) {
    const ids = native.records[i].nativeOwnerIndices;
    const options = geometry.pairs[i].auxiliaryHints.filter(candidate =>
      candidate.meanGapMm < 2
      && (!ownerByIndex.has(ids[0]) || ownerByIndex.get(ids[0]) === candidate.left)
      && (!ownerByIndex.has(ids[1]) || ownerByIndex.get(ids[1]) === candidate.right));
    if (options.length !== 1) continue;
    assign(ids[0], options[0].left, `anchored auxiliary pair ${i + 1}`);
    assign(ids[1], options[0].right, `anchored auxiliary pair ${i + 1}`);
  }
  const pairs = native.records.map((record, i) => {
    const [leftIndex, rightIndex] = record.nativeOwnerIndices;
    const left = ownerByIndex.get(leftIndex) || null;
    const right = ownerByIndex.get(rightIndex) || null;
    const candidate = geometry.pairs[i];
    const cutPath = [candidate.best, ...candidate.closeCutPieceCandidates]
      .find(item => item?.left === left && item?.right === right && item.meanGapMm < 2);
    const auxiliaryPath = candidate.auxiliaryHints.find(item =>
      item.left === left && item.right === right && item.meanGapMm < 2);
    return { pair: record.pair, leftIndex, rightIndex, left, right,
      pathEvidence: !left || !right ? "owner-unresolved"
        : cutPath ? "near-coincident-glb-boundary"
          : auxiliaryPath ? "near-coincident-auxiliary-boundary"
            : left === right ? "same-piece-path-unverified"
              : "owner-known-path-unverified" };
  });
  return { ownerByIndex: [...ownerByIndex].sort((a, b) => a[0] - b[0])
    .map(([index, mesh]) => ({ index, mesh, evidence: evidenceByIndex.get(index) })),
  pairs, resolvedOwnerPairs: pairs.filter(pair => pair.left && pair.right).length,
  nearGlbBoundaryPairs: pairs.filter(pair => pair.pathEvidence === "near-coincident-glb-boundary").length,
  readyForDrape: false,
  note: "Native piece ownership is not proof of structural seam type, sewing-line geometry, orientation, or a complete shirt assembly." };
}

function pointSegmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t = length2 ? Math.max(0, Math.min(1,
    ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function lineLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1]);
  }
  return length;
}

function nearestOutlineVertex(point, outline) {
  return outline.reduce((best, vertex, index) => {
    const distanceMm = Math.hypot(point[0] - vertex[0], point[1] - vertex[1]);
    return distanceMm < best.distanceMm ? { index, distanceMm } : best;
  }, { index: -1, distanceMm: Infinity });
}

function nearestOutlineSegment(point, outline) {
  let best = { segment: -1, t: 0, distanceMm: Infinity };
  for (let i = 0; i < outline.length; i += 1) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const length2 = dx * dx + dy * dy;
    const t = length2 > 0 ? Math.max(0, Math.min(1,
      ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2)) : 0;
    const distanceMm = Math.hypot(point[0] - a[0] - t * dx,
      point[1] - a[1] - t * dy);
    if (distanceMm < best.distanceMm) best = { segment: i, t, distanceMm };
  }
  return best;
}

function outlineArcLengths(outline, start, end) {
  let forward = 0, perimeter = 0;
  for (let i = 0; i < outline.length; i += 1) {
    const next = (i + 1) % outline.length;
    const edge = Math.hypot(outline[next][0] - outline[i][0],
      outline[next][1] - outline[i][1]);
    perimeter += edge;
    if (start < end ? i >= start && i < end : i >= start || i < end) forward += edge;
  }
  return [forward, perimeter - forward];
}

/** Geometry evidence only. A nearest parsed point may be too far away to
 * represent a native CLO seam end in the current discrete-anchor contract. */
function arcEvidence(uvPath, outline) {
  const start = nearestOutlineVertex(uvPath[0], outline);
  const end = nearestOutlineVertex(uvPath[uvPath.length - 1], outline);
  const startSegment = nearestOutlineSegment(uvPath[0], outline);
  const endSegment = nearestOutlineSegment(uvPath[uvPath.length - 1], outline);
  const sourceLengthMm = lineLength(uvPath);
  const candidateArcsMm = outlineArcLengths(outline, start.index, end.index);
  const bestArcMm = Math.min(...candidateArcsMm.map(value => Math.abs(value - sourceLengthMm)));
  return { start, end, startSegment, endSegment, sourceLengthMm, candidateArcsMm,
    closestArcErrorMm: bestArcMm,
    requiresInterpolatedAnchor: Math.max(start.distanceMm, end.distanceMm) > 0.5 };
}

function classifyDxfLocation(pair, sideMetrics, maxOutlineDistanceMm = 3) {
  if (!pair.left || !pair.right) return "owner-unresolved";
  if (pair.left === pair.right) return "same-piece";
  if (sideMetrics.some(metric => metric === null)) return "auxiliary-not-in-dxf";
  return sideMetrics.every(metric => metric.maxMm <= maxOutlineDistanceMm)
    ? "both-on-outer-cut" : "interior-attachment";
}

/** Locate a native indexed path against published DXF internal lines. This is
 * proximity evidence, not permission to sew: DXF lines can be construction
 * marks, button positions, folds, or duplicated segments. */
function internalLineEvidence(uvPath, lines, maxDistanceMm = 1) {
  const candidates = (lines || []).map((line, index) => {
    if (!Array.isArray(line) || line.length < 2) return null;
    const distances = uvPath.map(point => Math.min(...line.slice(1).map((end, i) =>
      pointSegmentDistance(point, line[i], end))));
    const maxMm = Math.max(...distances);
    const meanMm = distances.reduce((sum, value) => sum + value, 0) / distances.length;
    return { index, maxMm, meanMm, lineLengthMm: lineLength(line),
      arc: internalLineArcEvidence(uvPath, line) };
  }).filter(Boolean).sort((a, b) => a.maxMm - b.maxMm || a.meanMm - b.meanMm);
  const best = candidates[0] || null;
  const runnerUp = candidates[1] || null;
  return {
    status: !best || best.maxMm > maxDistanceMm ? "no-close-line"
      : runnerUp && runnerUp.maxMm <= maxDistanceMm ? "ambiguous-close-lines"
        : "single-close-line",
    best,
    runnerUp,
    candidateCount: candidates.filter(candidate => candidate.maxMm <= maxDistanceMm).length,
  };
}

/** For one closed DXF mark, place the source path's two ends on its measured
 * perimeter. The shorter/longer choice comes from the source path length,
 * never from visual orientation in the finished GLB. */
function internalLineArcEvidence(uvPath, line) {
  if (!Array.isArray(uvPath) || uvPath.length < 2 || line.length < 4
    || Math.hypot(line[0][0] - line.at(-1)[0], line[0][1] - line.at(-1)[1]) > 0.01) {
    return null;
  }
  const total = lineLength(line);
  if (!(total > 0)) return null;
  const nearest = point => {
    let best = { distanceMm: Infinity };
    let prefix = 0;
    for (let i = 0; i + 1 < line.length; i += 1) {
      const a = line[i], b = line[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      const t = length > 0 ? Math.max(0, Math.min(1,
        ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (length * length))) : 0;
      const distanceMm = Math.hypot(point[0] - a[0] - t * dx,
        point[1] - a[1] - t * dy);
      if (distanceMm < best.distanceMm) best = { segment: i, t,
        arcMm: prefix + t * length, distanceMm };
      prefix += length;
    }
    return best;
  };
  const start = nearest(uvPath[0]);
  const end = nearest(uvPath.at(-1));
  const sourceLengthMm = lineLength(uvPath);
  const forwardMm = (end.arcMm - start.arcMm + total) % total;
  const backwardMm = total - forwardMm;
  const forwardErrorMm = Math.abs(forwardMm - sourceLengthMm);
  const backwardErrorMm = Math.abs(backwardMm - sourceLengthMm);
  return { start, end, sourceLengthMm, forwardMm, backwardMm,
    direction: Math.abs(forwardErrorMm - backwardErrorMm) < 0.1 ? "ambiguous"
      : forwardErrorMm < backwardErrorMm ? "forward" : "backward",
    lengthErrorMm: Math.min(forwardErrorMm, backwardErrorMm) };
}

/** A GLB can have internal holes whose edges are not on the DXF outer cut.
 * Project every indexed path point, not only its ends, back to the DXF outline.
 * This is source classification, never an instruction to stitch the path. */
async function projectOwnersToDxf(ownership, glbBuffer, patternSet, metadataXml,
  { maxOutlineDistanceMm = 3 } = {}) {
  const xml = await parseStringPromise(metadataXml, { explicitArray: false });
  const rawPairs = xml?.MetaData?.SeamLinePairList?.SeamLinePair;
  if (!Array.isArray(rawPairs) || rawPairs.length !== ownership.pairs.length) {
    throw new Error("CLO XML pair count does not match native owner records.");
  }
  const fits = new Map(inspectReferenceGarment(glbBuffer, patternSet).pieces
    .map(piece => [piece.name, piece.fit]));
  const surfaces = new Map(referenceSurfaces(glbBuffer, patternSet)
    .map(surface => [surface.name, surface]));
  const pieces = new Map((patternSet.pieces || []).map(piece => [piece.name, piece]));
  const paths = ownership.pairs.map((pair, i) => {
    const names = [pair.left, pair.right];
    const sideMetrics = names.map((name, side) => {
      const piece = pieces.get(name), surface = surfaces.get(name), fit = fits.get(name);
      if (!piece || !surface || !fit) return null; // auxiliary, not a DXF cut piece
      const outline = (piece.outline || []).map(point => {
        const p = [Number(point.x) * patternSet.unitInMm,
          Number(point.y) * patternSet.unitInMm];
        return [fit.sx * p[fit.swap ? 1 : 0] + fit.shift[0],
          fit.sy * p[fit.swap ? 0 : 1] + fit.shift[1]];
      });
      if (outline.length < 3) throw new Error(`DXF piece ${name} has no outer cut outline.`);
      const ids = String(rawPairs[i].SeamLine?.[side]?.$?.MeshPointIndexes || "")
        .split("/").map(Number);
      if (ids.length < 2 || ids.some(id => !Number.isInteger(id)
        || id < 1 || id > surface.uvMm.length / 2)) {
        throw new Error(`Seam pair ${pair.pair} has an invalid ${name} path.`);
      }
      const uvPath = ids.map(id =>
        [surface.uvMm[(id - 1) * 2], surface.uvMm[(id - 1) * 2 + 1]]);
      const distances = uvPath.map(p => {
        return Math.min(...outline.map((a, k) =>
          pointSegmentDistance(p, a, outline[(k + 1) % outline.length])));
      });
      const toUv = point => {
        const p = [Number(point.x) * patternSet.unitInMm,
          Number(point.y) * patternSet.unitInMm];
        return [fit.sx * p[fit.swap ? 1 : 0] + fit.shift[0],
          fit.sy * p[fit.swap ? 0 : 1] + fit.shift[1]];
      };
      const internalLines = (piece.internalLines || []).map(line =>
        (line.points || []).map(toUv));
      return { mesh: name, maxMm: Math.max(...distances),
        meanMm: distances.reduce((sum, value) => sum + value, 0) / distances.length,
        arc: arcEvidence(uvPath, outline),
        internalLine: internalLineEvidence(uvPath, internalLines),
        endpoints3d: [ids[0], ids[ids.length - 1]].map(id =>
          [surface.positionsMm[(id - 1) * 3], surface.positionsMm[(id - 1) * 3 + 1],
            surface.positionsMm[(id - 1) * 3 + 2]]) };
    });
    const dxfLocation = classifyDxfLocation(pair, sideMetrics, maxOutlineDistanceMm);
    const gap = (a, b) => Math.hypot(...a.map((v, k) => v - b[k]));
    const endpointPairing = sideMetrics.every(Boolean) ? {
      directMeanGapMm: (gap(sideMetrics[0].endpoints3d[0], sideMetrics[1].endpoints3d[0])
        + gap(sideMetrics[0].endpoints3d[1], sideMetrics[1].endpoints3d[1])) / 2,
      reversedMeanGapMm: (gap(sideMetrics[0].endpoints3d[0], sideMetrics[1].endpoints3d[1])
        + gap(sideMetrics[0].endpoints3d[1], sideMetrics[1].endpoints3d[0])) / 2,
    } : null;
    return { ...pair, dxfLocation,
      dxfPathDistance: sideMetrics.map(metric => metric && {
        mesh: metric.mesh, maxMm: metric.maxMm, meanMm: metric.meanMm,
        arc: metric.arc,
        internalLine: metric.internalLine,
      }), endpointPairing };
  });
  return { ...ownership, pairs: paths,
    outerCutPairCount: paths.filter(pair => pair.dxfLocation === "both-on-outer-cut").length,
    interiorAttachmentPairCount: paths.filter(pair => pair.dxfLocation === "interior-attachment").length,
    auxiliaryTrimPairCount: paths.filter(pair => pair.dxfLocation === "auxiliary-not-in-dxf").length,
    samePiecePairCount: paths.filter(pair => pair.dxfLocation === "same-piece").length,
    interpolatedAnchorPairs: paths.filter(pair => pair.dxfLocation === "both-on-outer-cut"
      && pair.dxfPathDistance.some(side => side.arc.requiresInterpolatedAnchor)).map(pair => pair.pair),
    readyForDrape: false };
}

if (require.main === module) {
  const [pacPath, glbPath, dxfPath, xmlPath] = process.argv.slice(2);
  if (!pacPath || !glbPath || !dxfPath || !xmlPath) {
    process.stderr.write("Usage: node scripts/audits/rnd-clo-seam-ownership.js <extracted.pac> <CLO.glb> <AAMA.dxf> <CLO-metadata.xml>\n");
    process.exitCode = 2;
  } else {
    const xml = fs.readFileSync(xmlPath, "utf8");
    const glb = fs.readFileSync(glbPath);
    const pattern = inspectDxf(fs.readFileSync(dxfPath));
    Promise.all([
      inspectNativeSeamMarkers(fs.readFileSync(pacPath), xml),
      inspectSeamCandidates(glb, pattern, xml),
    ]).then(([native, geometry]) => resolveNativeSeamOwnership(native, geometry))
      .then(report => projectOwnersToDxf(report, glb, pattern, xml))
      .then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
      .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  }
}

module.exports = { resolveNativeSeamOwnership, projectOwnersToDxf,
  classifyDxfLocation, arcEvidence, internalLineEvidence, internalLineArcEvidence };
