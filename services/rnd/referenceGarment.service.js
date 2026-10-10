// A CLO GLB may be a reference for a particular DXF revision, never a substitute
// for that revision. This module reads the front surface of each named garment
// panel and proves that its 2D coordinates describe the imported cut outline.
// It does not claim to simulate cloth or make a drape from an unrelated DXF.
"use strict";

const { readContainer } = require("../../utils/glbInspect");

const COMPONENT_BYTES = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3 };
const MAX_GLTF_VERTICES = 300_000;
const MAX_OUTLINE_POINTS = 5000;
const MAX_BOUNDARY_VERTICES = 5000;

function fail(message) {
  const error = new Error(message);
  error.code = "REFERENCE_MISMATCH";
  return error;
}

function binaryChunk(buffer) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > buffer.length) throw fail("The GLB binary chunk is truncated.");
    if (type === 0x004e4942) return buffer.subarray(start, start + length);
    offset = start + length;
  }
  throw fail("The GLB has no binary mesh data.");
}

function accessor(json, bin, index, expectedType) {
  const a = json.accessors?.[index];
  if (!a || a.type !== expectedType || a.bufferView == null || a.sparse || a.count > MAX_GLTF_VERTICES) {
    throw fail(`The reference has an unsupported ${expectedType} accessor.`);
  }
  const view = json.bufferViews?.[a.bufferView];
  const components = COMPONENTS[a.type];
  const bytes = COMPONENT_BYTES[a.componentType];
  if (!view || !bytes || a.count < 1) throw fail("The reference mesh accessor is invalid.");
  const stride = view.byteStride || components * bytes;
  const start = (view.byteOffset || 0) + (a.byteOffset || 0);
  if (stride < components * bytes || start + (a.count - 1) * stride + components * bytes > bin.length) {
    throw fail("The reference mesh accessor extends past its binary data.");
  }
  const values = new Float64Array(a.count * components);
  for (let i = 0; i < a.count; i += 1) {
    for (let d = 0; d < components; d += 1) {
      const at = start + i * stride + d * bytes;
      const value = a.componentType === 5121 ? bin.readUInt8(at)
        : a.componentType === 5123 ? bin.readUInt16LE(at)
          : a.componentType === 5125 ? bin.readUInt32LE(at) : bin.readFloatLE(at);
      if (!Number.isFinite(value)) throw fail("The reference mesh contains a non-finite coordinate.");
      values[i * components + d] = value;
    }
  }
  return values;
}

function surfaceOf(json, bin, mesh) {
  // CLO's first primitive is the outer cloth face; the second is the inner
  // face and the third closes the 2 mm thickness. Combining them makes UV
  // hits ambiguous and invents compressed edges at the doubled surface.
  const primitive = mesh.primitives?.[0];
  if (!primitive || (primitive.mode !== undefined && primitive.mode !== 4)) {
    throw fail(`"${mesh.name}" has no triangular outer surface.`);
  }
  if (json.accessors?.[primitive.attributes?.POSITION]?.componentType !== 5126
    || json.accessors?.[primitive.attributes?.TEXCOORD_0]?.componentType !== 5126
    || ![5121, 5123, 5125].includes(json.accessors?.[primitive.indices]?.componentType)) {
    throw fail(`"${mesh.name}" has unsupported position, UV or index data.`);
  }
  const positionsM = accessor(json, bin, primitive.attributes?.POSITION, "VEC3");
  const uvMm = accessor(json, bin, primitive.attributes?.TEXCOORD_0, "VEC2");
  const indices = accessor(json, bin, primitive.indices, "SCALAR");
  if (positionsM.length / 3 !== uvMm.length / 2 || indices.length % 3) {
    throw fail(`"${mesh.name}" has inconsistent surface data.`);
  }
  const triangles = Uint32Array.from(indices);
  for (const i of triangles) if (i >= positionsM.length / 3) {
    throw fail(`"${mesh.name}" has a triangle outside its vertex buffer.`);
  }
  const positionsMm = Float64Array.from(positionsM, v => v * 1000);
  return { positionsMm, uvMm, triangles };
}

function boundaryOf(triangles) {
  const edges = new Map();
  for (let t = 0; t < triangles.length; t += 3) {
    const ids = [triangles[t], triangles[t + 1], triangles[t + 2]];
    for (let k = 0; k < 3; k += 1) {
      const a = ids[k], b = ids[(k + 1) % 3];
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      const entry = edges.get(key);
      if (entry) entry.count += 1;
      else edges.set(key, { a, b, count: 1 });
    }
  }
  const vertices = new Set();
  const boundaryEdges = [];
  for (const edge of edges.values()) if (edge.count === 1) {
    vertices.add(edge.a); vertices.add(edge.b);
    boundaryEdges.push([edge.a, edge.b]);
  }
  // A buttonhole or other internal opening creates another boundary loop.
  // It is real mesh geometry, but it must not be scored against the DXF's
  // *outer* cut outline. Keep the components separate rather than mistaking
  // their interior vertices for a different pattern revision.
  const neighbours = new Map();
  for (const [a, b] of boundaryEdges) {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    if (!neighbours.has(b)) neighbours.set(b, new Set());
    neighbours.get(a).add(b); neighbours.get(b).add(a);
  }
  const visited = new Set();
  const components = [];
  for (const start of vertices) {
    if (visited.has(start)) continue;
    const stack = [start], componentVertices = new Set();
    while (stack.length) {
      const v = stack.pop();
      if (visited.has(v)) continue;
      visited.add(v); componentVertices.add(v);
      for (const next of neighbours.get(v) || []) if (!visited.has(next)) stack.push(next);
    }
    components.push({ vertices: [...componentVertices],
      edges: boundaryEdges.filter(([a, b]) => componentVertices.has(a) && componentVertices.has(b)) });
  }
  return { vertices: [...vertices], edges: boundaryEdges, components };
}

function bounds(points) {
  const x = points.map(p => p[0]), y = points.map(p => p[1]);
  return { minX: Math.min(...x), maxX: Math.max(...x),
    minY: Math.min(...y), maxY: Math.max(...y) };
}

function pointSegmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t = length2 ? Math.max(0, Math.min(1,
    ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function outlineFit(outlineMm, uvMm, boundary, foldLineMm = null) {
  if (outlineMm.length > MAX_OUTLINE_POINTS || boundary.vertices.length > MAX_BOUNDARY_VERTICES) {
    throw fail("The reference outline is too dense to verify safely.");
  }
  const source = boundary.vertices.map(i => [uvMm[i * 2], uvMm[i * 2 + 1]]);
  const sourceEdges = boundary.edges.map(([a, b]) => [
    [uvMm[a * 2], uvMm[a * 2 + 1]], [uvMm[b * 2], uvMm[b * 2 + 1]],
  ]);
  if (source.length < 3 || outlineMm.length < 3) throw fail("A panel has no closed reference outline.");
  const targetBounds = bounds(source);
  let best = null;
  for (const swap of [false, true]) for (const sx of [1, -1]) for (const sy of [1, -1]) {
    const oriented = outlineMm.map(p => [sx * p[swap ? 1 : 0], sy * p[swap ? 0 : 1]]);
    const box = bounds(oriented);
    const shift = [
      (targetBounds.minX + targetBounds.maxX - box.minX - box.maxX) / 2,
      (targetBounds.minY + targetBounds.maxY - box.minY - box.maxY) / 2,
    ];
    const adjusted = oriented.map(p => [p[0] + shift[0], p[1] + shift[1]]);
    const fold = foldLineMm?.map(p => [
      sx * p[swap ? 1 : 0] + shift[0], sy * p[swap ? 0 : 1] + shift[1],
    ]) || null;
    const widthError = Math.abs(box.maxX - box.minX - targetBounds.maxX + targetBounds.minX);
    const heightError = Math.abs(box.maxY - box.minY - targetBounds.maxY + targetBounds.minY);
    // Sample all boundary vertices, and score their distance to the actual
    // DXF cut polyline. A bounding-box-only test would accept the wrong shirt.
    const errors = source.map(p => Math.min(
      ...adjusted.map((a, i) => pointSegmentDistance(p, a, adjusted[(i + 1) % adjusted.length])),
      ...(fold ? [pointSegmentDistance(p, fold[0], fold[1])] : []),
    ));
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    const worst = Math.max(...errors);
    const reverseErrors = adjusted.map(p => Math.min(...sourceEdges.map(([a, b]) =>
      pointSegmentDistance(p, a, b))));
    const reverseMean = reverseErrors.reduce((a, b) => a + b, 0) / reverseErrors.length;
    const reverseWorst = Math.max(...reverseErrors);
    const score = mean + reverseMean + 0.2 * Math.max(worst, reverseWorst)
      + 0.25 * (widthError + heightError);
    if (!best || score < best.score) best = {
      swap, sx, sy, shift, meanErrorMm: mean, worstErrorMm: worst,
      reverseMeanErrorMm: reverseMean, reverseWorstErrorMm: reverseWorst,
      widthErrorMm: widthError, heightErrorMm: heightError, score,
    };
  }
  return best;
}

function centralBandFold(piece, outlineMm, unitInMm) {
  const box = bounds(outlineMm);
  const width = box.maxX - box.minX, height = box.maxY - box.minY;
  if (!(width >= 5 * height)) return null;
  const lines = (piece.internalLines || []).filter(line => line.points?.length === 2);
  for (const line of lines) {
    const points = line.points.map(p => [Number(p.x) * unitInMm, Number(p.y) * unitInMm]);
    if (points.some(p => !p.every(Number.isFinite))) continue;
    const midY = (points[0][1] + points[1][1]) / 2;
    if (Math.abs(points[0][1] - points[1][1]) < height * 0.05
      && Math.abs(midY - (box.minY + box.maxY) / 2) < height * 0.05
      && Math.abs(points[0][0] - points[1][0]) > width * 0.9) return points;
  }
  return null;
}

function inspectReferenceGarment(glbBuffer, patternSet, { maxMeanErrorMm = 3,
  maxWorstErrorMm = 16 } = {}) {
  if (!Buffer.isBuffer(glbBuffer)) throw fail("A GLB file is required.");
  const { json } = readContainer(glbBuffer);
  if (!/\bCLO\b/i.test(String(json.asset?.generator || ""))) {
    throw fail("This reference mode has only been verified for a CLO-exported GLB.");
  }
  const bin = binaryChunk(glbBuffer);
  const unitInMm = Number(patternSet?.unitInMm);
  if (!Number.isFinite(unitInMm) || unitInMm <= 0) {
    throw fail("The DXF scale must be verified before it can be paired with a 3D reference.");
  }
  const meshes = new Map();
  for (const mesh of json.meshes || []) {
    if (meshes.has(mesh.name)) throw fail(`The GLB repeats the mesh name "${mesh.name}".`);
    meshes.set(mesh.name, mesh);
  }
  const pieces = [];
  for (const piece of patternSet.pieces || []) {
    const mesh = meshes.get(piece.name);
    if (!mesh) throw fail(`The GLB has no mesh named "${piece.name}" for this DXF panel.`);
    const surface = surfaceOf(json, bin, mesh);
    const outlineMm = (piece.outline || []).map(p => [Number(p.x) * unitInMm, Number(p.y) * unitInMm]);
    if (outlineMm.some(p => !p.every(Number.isFinite))) throw fail(`"${piece.name}" has an invalid DXF outline.`);
    const fold = centralBandFold(piece, outlineMm, unitInMm);
    const boundaries = boundaryOf(surface.triangles);
    // A folded neckband has two disconnected raw-edge surfaces; both together
    // describe the strip and its published centre fold. Unlike a buttonhole,
    // neither component alone is the whole flat piece.
    const candidates = fold ? [boundaries] : boundaries.components;
    const fits = candidates.map(component => ({ component,
      fit: outlineFit(outlineMm, surface.uvMm, component, fold) }));
    const selected = fits.sort((a, b) => a.fit.score - b.fit.score)[0];
    if (!selected) throw fail(`"${piece.name}" has no reference boundary.`);
    const fit = selected.fit;
    pieces.push({ name: piece.name, pieceRef: piece.pieceRef || "",
      vertices: surface.positionsMm.length / 3, triangles: surface.triangles.length / 3,
      foldLineRecognised: Boolean(fold), internalBoundaryCount: fold ? 0 : Math.max(0, fits.length - 1), fit });
  }
  const unmatched = pieces.filter(p => p.fit.meanErrorMm > maxMeanErrorMm
    || p.fit.worstErrorMm > maxWorstErrorMm
    || p.fit.reverseMeanErrorMm > maxMeanErrorMm
    || p.fit.reverseWorstErrorMm > maxWorstErrorMm);
  return { compatible: unmatched.length === 0, pieces,
    problems: unmatched.map(p => `"${p.name}" differs from its CLO 2D surface by `
      + `${Math.max(p.fit.meanErrorMm, p.fit.reverseMeanErrorMm).toFixed(1)} mm mean / `
      + `${Math.max(p.fit.worstErrorMm, p.fit.reverseWorstErrorMm).toFixed(1)} mm worst. `
      + "This GLB cannot calibrate that DXF revision without review."),
  };
}

/** Read-only source surfaces for calibration. These are CLO's solved positions
 * and flat UV coordinates, not a generated drape or a replacement for the DXF. */
function referenceSurfaces(glbBuffer, patternSet) {
  const match = inspectReferenceGarment(glbBuffer, patternSet);
  if (!match.compatible) throw fail(match.problems.join(" "));
  const { json } = readContainer(glbBuffer);
  const bin = binaryChunk(glbBuffer);
  const meshes = new Map((json.meshes || []).map(mesh => [mesh.name, mesh]));
  return (patternSet.pieces || []).map(piece => {
    const mesh = meshes.get(piece.name);
    const surface = surfaceOf(json, bin, mesh);
    const materialIndex = mesh.primitives[0].material;
    return { name: piece.name, pieceRef: piece.pieceRef || "",
      material: json.materials?.[materialIndex]?.name || null, ...surface };
  });
}

/** Additional CLO-exported meshes are diagnostic evidence only. They may be
 * trim, piping or stitch render geometry and are never substituted for the
 * named DXF cut pieces when checking reference compatibility. */
function auxiliarySurfaces(glbBuffer, patternSet) {
  const match = inspectReferenceGarment(glbBuffer, patternSet);
  if (!match.compatible) throw fail(match.problems.join(" "));
  const { json } = readContainer(glbBuffer);
  const bin = binaryChunk(glbBuffer);
  const cutNames = new Set((patternSet.pieces || []).map(piece => piece.name));
  return (json.meshes || []).filter(mesh => !cutNames.has(mesh.name)).map(mesh => ({
    name: mesh.name, ...surfaceOf(json, bin, mesh),
  }));
}

/**
 * The only 2D edit a rigid reference can represent without re-simulation is a
 * common similarity scale of every cut piece. Translation/rotation of pieces
 * on the drafting table do not change the garment. A reshaped armhole or a
 * separately graded sleeve does, and must go to a real draper instead.
 */
function proportionalScaleOf(sourcePattern, editedPattern, { toleranceMm = 0.25 } = {}) {
  const unit0 = Number(sourcePattern?.unitInMm);
  const unit1 = Number(editedPattern?.unitInMm);
  if (!(unit0 > 0) || !(unit1 > 0)) throw fail("Both pattern revisions need verified physical units.");
  const sourcePieces = sourcePattern.pieces || [];
  const editedPieces = new Map((editedPattern.pieces || []).map(p => [p.pieceRef || p.name, p]));
  if (editedPieces.size !== sourcePieces.length) throw fail("The edited pattern changed its piece set.");
  const scales = [];
  for (const source of sourcePieces) {
    const name = source.pieceRef || source.name;
    const edited = editedPieces.get(name);
    const before = source.outline || [], after = edited?.outline || [];
    if (!edited || before.length !== after.length || before.length < 3) {
      throw fail(`"${name}" changed topology; the CLO reference cannot safely rerender it.`);
    }
    const points0 = before.map(p => [Number(p.x) * unit0, Number(p.y) * unit0]);
    const points1 = after.map(p => [Number(p.x) * unit1, Number(p.y) * unit1]);
    if ([...points0, ...points1].some(p => !p.every(Number.isFinite))) {
      throw fail(`"${name}" has a non-finite outline point.`);
    }
    const center = points => points.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0])
      .map(v => v / points.length);
    const c0 = center(points0), c1 = center(points1);
    let dot = 0, cross = 0, length2 = 0;
    for (let i = 0; i < points0.length; i += 1) {
      const x = points0[i][0] - c0[0], y = points0[i][1] - c0[1];
      const u = points1[i][0] - c1[0], v = points1[i][1] - c1[1];
      dot += x * u + y * v; cross += x * v - y * u;
      length2 += x * x + y * y;
    }
    if (length2 < 1) throw fail(`"${name}" has no measurable cut area.`);
    const scale = Math.hypot(dot, cross) / length2;
    const angle = Math.atan2(cross, dot);
    const cos = Math.cos(angle), sin = Math.sin(angle);
    let worst = 0;
    for (let i = 0; i < points0.length; i += 1) {
      const x = points0[i][0] - c0[0], y = points0[i][1] - c0[1];
      worst = Math.max(worst, Math.hypot(
        c1[0] + scale * (cos * x - sin * y) - points1[i][0],
        c1[1] + scale * (sin * x + cos * y) - points1[i][1],
      ));
    }
    if (worst > toleranceMm) throw fail(`"${name}" was reshaped by ${worst.toFixed(1)} mm; `
      + "a scaled CLO reference would misrepresent that 2D change.");
    scales.push({ name, scale, worstPointErrorMm: worst });
  }
  const scale = scales.reduce((a, p) => a + p.scale, 0) / scales.length;
  if (!(scale >= 0.8 && scale <= 1.2)) {
    throw fail("This reference preview only supports a proportional size change within 20%.");
  }
  if (scales.some(p => Math.abs(p.scale - scale) > 0.001)) {
    throw fail("The pieces were graded by different amounts; a common 3D scale would open seams.");
  }
  return { scale, pieces: scales, previewOnly: true,
    warning: "Reference-guided size preview, not a newly simulated fit. Verify on a measured avatar before approval.",
  };
}

/**
 * A deliberately narrow preview. The CLO export remains byte-for-byte intact;
 * only the Cloth scene node in a newly encoded GLB is scaled. The avatar and
 * source project, when present as siblings, are left alone. This is not a
 * physically simulated fit, and must never be represented as one.
 */
function makeReferencePreviewGlb(glbBuffer, sourcePattern, editedPattern) {
  const pairing = inspectReferenceGarment(glbBuffer, sourcePattern);
  if (!pairing.compatible) throw fail(pairing.problems.join(" "));
  const change = proportionalScaleOf(sourcePattern, editedPattern);
  const { json } = readContainer(glbBuffer);
  if (json.buffers?.length !== 1 || json.buffers[0].uri) {
    throw fail("The CLO reference must have one embedded GLB buffer.");
  }
  const clothNodes = (json.nodes || []).map((node, index) => ({ node, index }))
    .filter(({ node }) => node.name === "Cloth");
  if (clothNodes.length !== 1) throw fail("The CLO reference has no unique Cloth group to scale.");
  const { node: cloth, index: clothIndex } = clothNodes[0];
  if (cloth.matrix || cloth.scale || cloth.translation || cloth.rotation) {
    throw fail("The Cloth group already has a transform; this preview cannot safely compose it.");
  }
  const descendants = new Set();
  const walk = index => {
    if (descendants.has(index)) throw fail("The GLB Cloth scene graph contains a cycle.");
    descendants.add(index);
    for (const child of json.nodes?.[index]?.children || []) {
      if (!Number.isInteger(child) || !json.nodes?.[child]) throw fail("The GLB Cloth scene graph is invalid.");
      walk(child);
    }
  };
  walk(clothIndex);
  const matchedMeshNames = new Set(pairing.pieces.map(piece => piece.name));
  for (const name of matchedMeshNames) {
    const found = [...descendants].some(index => json.meshes?.[json.nodes[index].mesh]?.name === name);
    if (!found) throw fail(`The matched panel "${name}" is outside the Cloth group.`);
  }
  // Center the scale on the actual garment, not the GLB origin. A global
  // origin scale would shift a shirt vertically relative to an unscaled body.
  const bin = binaryChunk(glbBuffer);
  const centerMin = [Infinity, Infinity, Infinity];
  const centerMax = [-Infinity, -Infinity, -Infinity];
  for (const mesh of json.meshes || []) {
    if (!matchedMeshNames.has(mesh.name)) continue;
    const surface = surfaceOf(json, bin, mesh);
    for (let i = 0; i < surface.positionsMm.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const metres = surface.positionsMm[i + axis] / 1000;
        centerMin[axis] = Math.min(centerMin[axis], metres);
        centerMax[axis] = Math.max(centerMax[axis], metres);
      }
    }
  }
  if (centerMin.some(v => !Number.isFinite(v))) throw fail("The CLO panels have no measurable 3D bounds.");
  const centerM = centerMin.map((min, axis) => (min + centerMax[axis]) / 2);
  const copy = structuredClone(json);
  copy.nodes[clothIndex].scale = [change.scale, change.scale, change.scale];
  copy.nodes[clothIndex].translation = centerM.map(v => (1 - change.scale) * v);
  copy.nodes[clothIndex].extras = { ...copy.nodes[clothIndex].extras,
    gravReferencePreview: { kind: "proportional-size-preview", scale: change.scale,
      sourceDxfOnly: false, fitVerified: false },
  };
  const jsonBytes = Buffer.from(JSON.stringify(copy), "utf8");
  const paddedJson = Buffer.concat([jsonBytes, Buffer.alloc((4 - jsonBytes.length % 4) % 4, 0x20)]);
  const chunks = [];
  let offset = 12;
  let jsonReplaced = false;
  while (offset + 8 <= glbBuffer.length) {
    const length = glbBuffer.readUInt32LE(offset);
    const type = glbBuffer.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > glbBuffer.length) throw fail("The GLB chunk table is truncated.");
    if (type === 0x4e4f534a && !jsonReplaced) {
      const header = Buffer.alloc(8);
      header.writeUInt32LE(paddedJson.length, 0);
      header.writeUInt32LE(type, 4);
      chunks.push(header, paddedJson);
      jsonReplaced = true;
    } else {
      chunks.push(glbBuffer.subarray(offset, end + ((4 - length % 4) % 4)));
    }
    offset = end + ((4 - length % 4) % 4);
  }
  if (!jsonReplaced || offset !== glbBuffer.length) throw fail("The GLB chunk table is invalid.");
  const header = Buffer.from(glbBuffer.subarray(0, 12));
  header.writeUInt32LE(12 + chunks.reduce((n, chunk) => n + chunk.length, 0), 8);
  return { glb: Buffer.concat([header, ...chunks]), scale: change.scale,
    centerM, previewOnly: true, warning: change.warning, pairing };
}

/** Read a private CLO publication and a pattern revision from the same style. */
async function referencePreviewForRevision(ctx, { publicationId, revisionId } = {}) {
  const mongoose = require("mongoose");
  const { GarmentModelPublication, ASSET_KIND } = require("../../models/CMS_Models/RnD/GarmentModel");
  const { PatternRevision } = require("../../models/CMS_Models/RnD/PatternRevision");
  const drive = require("../companyDrive.service");
  const appFail = require("../storePurchase/errors").fail;
  if (!ctx?.companyId || !mongoose.Types.ObjectId.isValid(publicationId)
    || !mongoose.Types.ObjectId.isValid(revisionId)) {
    throw appFail("NOT_FOUND", "The reference model or pattern revision was not found.");
  }
  const [publication, revision] = await Promise.all([
    GarmentModelPublication.findOne({ _id: publicationId, companyId: ctx.companyId }).lean(),
    PatternRevision.findOne({ _id: revisionId, companyId: ctx.companyId }).lean(),
  ]);
  if (!publication || !revision || String(publication.styleId) !== String(revision.styleId)) {
    throw appFail("NOT_FOUND", "The reference model and pattern revision do not belong to the same style.");
  }
  if (!publication.patternSet || !revision.patternSet) {
    throw appFail("VALIDATION", "Both the CLO reference and revision need a parsed 2D pattern.");
  }
  const asset = (publication.assets || []).find(a => a.kind === ASSET_KIND.WEB_MODEL);
  if (!asset?.driveFileId || !/\.glb$/i.test(asset.name || "")) {
    throw appFail("VALIDATION", "This publication has no original CLO GLB to use as a reference.");
  }
  const maxBytes = 60 * 1024 * 1024;
  if (asset.bytes > maxBytes) throw appFail("VALIDATION", "The reference GLB exceeds the 60 MB preview limit.");
  const { stream, meta } = await drive.streamCompanyFile(asset.driveFileId);
  if (meta?.size > maxBytes) {
    stream.destroy();
    throw appFail("VALIDATION", "The reference GLB exceeds the 60 MB preview limit.");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      stream.destroy();
      throw appFail("VALIDATION", "The reference GLB exceeds the 60 MB preview limit.");
    }
    chunks.push(chunk);
  }
  try {
    return makeReferencePreviewGlb(Buffer.concat(chunks), publication.patternSet, revision.patternSet);
  } catch (error) {
    if (error.code === "REFERENCE_MISMATCH") {
      throw appFail("VALIDATION", error.message);
    }
    throw error;
  }
}

module.exports = { inspectReferenceGarment, proportionalScaleOf,
  makeReferencePreviewGlb, referencePreviewForRevision, referenceSurfaces, auxiliarySurfaces };
