"use strict";

const crypto = require("node:crypto");
const { parseStringPromise } = require("xml2js");
const { referenceSurfaces } = require("./referenceGarment.service");

function calibrationError(message) {
  const error = new Error(message);
  error.code = "CLO_CALIBRATION_SOURCE_INVALID";
  return error;
}

function asList(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function finiteNumber(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw calibrationError(`${label} is not a finite number.`);
  return result;
}
function quantile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const lo = Math.floor(index), hi = Math.ceil(index);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}
function sourceEdgeMetrics({ positionsMm, uvMm, triangles }, { minEdgeMm = 0.5,
  maxEdgeMm = 40 } = {}) {
  const seen = new Set();
  const ratios = [];
  for (let t = 0; t < triangles.length; t += 3) {
    const ids = [triangles[t], triangles[t + 1], triangles[t + 2]];
    for (let k = 0; k < 3; k += 1) {
      const a = ids[k], b = ids[(k + 1) % 3];
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const flat = Math.hypot(uvMm[a * 2] - uvMm[b * 2], uvMm[a * 2 + 1] - uvMm[b * 2 + 1]);
      if (flat < minEdgeMm || flat > maxEdgeMm) continue;
      const draped = Math.hypot(positionsMm[a * 3] - positionsMm[b * 3],
        positionsMm[a * 3 + 1] - positionsMm[b * 3 + 1],
        positionsMm[a * 3 + 2] - positionsMm[b * 3 + 2]);
      if (Number.isFinite(draped)) ratios.push(draped / flat);
    }
  }
  ratios.sort((a, b) => a - b);
  return { edgeCount: ratios.length, medianRatio: quantile(ratios, 0.5),
    fifthPercentileRatio: quantile(ratios, 0.05),
    ninetyFifthPercentileRatio: quantile(ratios, 0.95),
    meanAbsoluteDeformationPercent: ratios.length
      ? 100 * ratios.reduce((sum, ratio) => sum + Math.abs(ratio - 1), 0) / ratios.length : null,
    belowSeventyFivePercent: ratios.filter(ratio => ratio < 0.75).length,
    aboveOneHundredTwentyFivePercent: ratios.filter(ratio => ratio > 1.25).length };
}

function materialKey(name) {
  return String(name || "").replace(/_(FRONT|BACK)_\d+$/i, "").replace(/_\d+$/, "");
}

/**
 * A reproducible target report from an exact CLO DXF + GLB + metadata triplet.
 * It measures the source, but does not tune a solver or license any new pattern
 * as fit-accurate. Preserve all three input files byte-for-byte.
 */
async function inspectCloCalibration(glbBuffer, patternSet, metadataXml,
  { garmentType = "unspecified" } = {}) {
  if (typeof metadataXml !== "string" || metadataXml.length > 1_000_000) {
    throw calibrationError("A CLO metadata XML document below 1 MB is required.");
  }
  let parsed;
  try {
    parsed = await parseStringPromise(metadataXml, { explicitArray: false, trim: true });
  } catch {
    throw calibrationError("The CLO metadata XML could not be parsed.");
  }
  const root = parsed?.MetaData;
  if (!root || !root.PhysicalPropertyList || !root.SeamLinePairList) {
    throw calibrationError("The XML does not contain CLO physical properties and sewing pairs.");
  }
  const properties = asList(root.PhysicalPropertyList.PhysicalProperty).map(item => {
    const attr = item?.$ || {};
    if (!attr.PhysicalPropertyName) throw calibrationError("A fabric property has no name.");
    const values = {};
    for (const [key, value] of Object.entries(attr)) {
      if (key !== "PhysicalPropertyName") values[key] = finiteNumber(value, `Fabric ${attr.PhysicalPropertyName}: ${key}`);
    }
    return { name: attr.PhysicalPropertyName, values };
  });
  const byMaterial = new Map();
  for (const property of properties) {
    const key = materialKey(property.name);
    if (byMaterial.has(key)) throw calibrationError(`Fabric key ${key} is ambiguous.`);
    byMaterial.set(key, property.name);
  }
  const seams = asList(root.SeamLinePairList.SeamLinePair).map((pair, index) => {
    const paths = asList(pair.SeamLine).map(line => {
      const raw = line?.$?.MeshPointIndexes;
      if (typeof raw !== "string") throw calibrationError(`Seam pair ${index + 1} has no vertex path.`);
      const indices = raw.split("/").map(value => Number(value));
      if (indices.length < 2 || indices.some(value => !Number.isInteger(value) || value < 0)) {
        throw calibrationError(`Seam pair ${index + 1} has an invalid vertex path.`);
      }
      return { pointCount: indices.length, start: indices[0], end: indices.at(-1) };
    });
    if (paths.length !== 2) throw calibrationError(`Seam pair ${index + 1} must have two paths.`);
    return { pair: index + 1, paths };
  });
  const surfaces = referenceSurfaces(glbBuffer, patternSet);
  const pieces = surfaces.map(surface => ({ name: surface.name, pieceRef: surface.pieceRef,
    glbMaterial: surface.material,
    physicalProperty: byMaterial.get(materialKey(surface.material)) || null,
    sourceGeometry: sourceEdgeMetrics(surface) }));
  const unmatchedMaterials = pieces.filter(piece => !piece.physicalProperty).map(piece => piece.name);
  // CLO's metadata can include stitch index paths while omitting the mesh
  // ownership table. A seam count alone cannot establish which DXF edges are
  // sewn together, so it is evidence to investigate, not a tuning-ready gate.
  const hasSeamOwnership = asList(root.MeshList?.Mesh).length > 0;
  return {
    kind: "clo-source-calibration-target", version: 1,
    sourceSha256: { glb: crypto.createHash("sha256").update(glbBuffer).digest("hex"),
      metadata: crypto.createHash("sha256").update(metadataXml).digest("hex") },
    garmentType: String(garmentType), sourcePieceCount: pieces.length,
    seamPairCount: seams.length, seams, properties, pieces,
    sourcePiecesMatched: unmatchedMaterials.length === 0,
    seamOwnershipVerified: false,
    readyForParameterTuning: false,
    limitations: [
      "GLB and metadata describe one solved CLO example; this report does not generate a new drape.",
      "CLO stiffness and friction values cannot be copied directly into the app solver without a measured conversion.",
      "No unseen garment pattern has been validated by this source audit.",
      hasSeamOwnership
        ? "The metadata lists meshes, but stitch-path ownership and direction have not been verified against the DXF."
        : "The metadata MeshList is empty; stitch-path ownership and direction are unknown despite the seam-pair count.",
      ...(unmatchedMaterials.length ? [`No unambiguous fabric property for: ${unmatchedMaterials.join(", ")}.`] : []),
    ],
  };
}

module.exports = { inspectCloCalibration, sourceEdgeMetrics };
