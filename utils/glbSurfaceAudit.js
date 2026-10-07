// utils/glbSurfaceAudit.js
//
// WHY A GARMENT DRAWS DIFFERENTLY HERE THAN IT DID IN CLO.
//
// ── THE REPORT THIS EXISTS TO WRITE ─────────────────────────────────────────
// A CLO export arrived with large black patches on it that were not black in
// CLO. Everything about that is alarming and almost none of the obvious
// explanations were true: the normals were valid, nothing was mirrored, no
// extension was unsupported, and the metalness was zero. The cause was in the
// one place nobody looks — the base-colour texture is an ATLAS whose colour
// lives only inside an alpha-masked island, the area outside the island is
// (0,0,0,0), and the material declares `alphaMode: OPAQUE`, which per the
// glTF spec means the alpha is DISCARDED. So every surface whose UVs fall
// outside its island samples pure black and is shaded as black cloth.
//
// CLO does not show that because CLO composites with its own material model
// and never draws the empty part of the atlas. Any conforming glTF renderer
// does, which is why this is an export fault rather than a viewer fault — and
// why the answer is to NAME it rather than to paint over it.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
// It changes nothing. It does not rewrite the material, does not touch the
// uploaded bytes, and does not drop a mesh that looks wrong. A viewer that
// quietly "fixes" a garment's colour is a viewer nobody can approve a sample
// against: the whole value of the model is that it is what CLO produced.
//
// ── AND WHY IT IS NOT IN glbInspect.js ──────────────────────────────────────
// That module promises, in its own header, to decode no geometry and no
// images: it reads the JSON chunk and nothing else, which is what keeps it
// cheap and small. This one has to decode PNGs and walk UV buffers to answer
// its question. Keeping them apart keeps that promise true, and lets a
// deployment that does not want the cost skip this one entirely.
"use strict";

const { readContainer } = require("./glbInspect");

const CHUNK_BIN = 0x004e4942; /* 'BIN\0' */

/**
 * The binary chunk itself.
 *
 * `readContainer` validates the file and hands back the JSON plus the SIZE of
 * the binary chunk — it has no reason to hold the bytes, because nothing it
 * does reads them. This does, so it walks the (already validated) chunk table
 * once more for the subarray. Deliberately a second pass rather than widening
 * that function's contract: the cheap reader stays cheap.
 */
function binChunkOf(buffer) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) break;
    if (type === CHUNK_BIN) return buffer.subarray(start, end);
    offset = end + ((4 - (length % 4)) % 4);
  }
  return Buffer.alloc(0);
}

/* How many vertices of one material to sample. The question is "roughly what
   share of this surface lands on nothing", and a few thousand well-spread
   samples answer it as well as four hundred thousand would, in a fraction of
   the time a publish can afford. */
const SAMPLE_CAP = 6000;

/** Below this, a texel is black as far as a reader is concerned. */
const NEAR_BLACK = 20;
/** Below this, a texel is carrying no coverage at all. */
const CLEAR_ALPHA = 10;

/* The share of a material's surface that has to land on empty texture before
   it is worth telling somebody about. Below this it is UV padding and seam
   bleed, which every atlas has and nobody can see. */
const REPORTABLE = 0.05;

const COMPONENT = {
  5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2],
  5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4],
};
const ELEMENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** One accessor, as plain numbers. Handles interleaved buffer views. */
function readAccessor(json, bin, index) {
  const a = json.accessors?.[index];
  if (!a || a.bufferView == null) return null;
  const spec = COMPONENT[a.componentType];
  const size = ELEMENTS[a.type];
  if (!spec || !size) return null;
  const [Arr, bytes] = spec;
  const view = json.bufferViews[a.bufferView];
  const start = (view.byteOffset || 0) + (a.byteOffset || 0);
  const stride = view.byteStride || size * bytes;
  const out = new Float64Array(a.count * size);
  for (let i = 0; i < a.count; i += 1) {
    const at = start + i * stride;
    if (at + size * bytes > bin.byteLength) break;
    const slice = new Arr(bin.buffer, bin.byteOffset + at, size);
    for (let k = 0; k < size; k += 1) out[i * size + k] = slice[k];
  }
  return { data: out, size, count: a.count };
}

/**
 * Decode one of the GLB's embedded images.
 *
 * PNG only, and by choice: `pngjs` is already a dependency, it is pure
 * JavaScript, and a CLO export writes PNG. A JPEG texture is reported as
 * unexamined rather than guessed at — saying "I could not look" is a true
 * statement and saying "it is fine" would not be.
 */
function decodeImage(json, bin, imageIndex) {
  const image = json.images?.[imageIndex];
  if (!image || image.bufferView == null) return { skipped: "not embedded" };
  if (image.mimeType && image.mimeType !== "image/png") {
    return { skipped: `${image.mimeType} is not examined` };
  }
  const view = json.bufferViews[image.bufferView];
  const bytes = bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
  try {
    /* Required lazily: a deployment that never publishes a model should not
       pay for the decoder at boot. */
    const { PNG } = require("pngjs");
    const png = PNG.sync.read(Buffer.from(bytes));
    return { width: png.width, height: png.height, data: png.data };
  } catch (err) {
    return { skipped: `could not be decoded (${err.message})` };
  }
}

/** Every primitive that wears a given material, with its mesh's name. */
function primitivesByMaterial(json) {
  const out = new Map();
  for (const [mi, mesh] of (json.meshes || []).entries()) {
    for (const [pi, prim] of (mesh.primitives || []).entries()) {
      if (prim.material == null) continue;
      const list = out.get(prim.material) || [];
      list.push({ mesh: mi, prim: pi, name: mesh.name || `mesh ${mi}`, primitive: prim });
      out.set(prim.material, list);
    }
  }
  return out;
}

/**
 * What share of a material's surface samples texture that is not there.
 *
 * Both halves are counted because together they are the diagnosis and apart
 * they are not: a black texel might be a black garment, and a transparent one
 * might be a correctly-declared cut-out. A texel that is black AND
 * transparent, under a material that says OPAQUE, is empty atlas being shaded
 * as cloth.
 */
function sampleCoverage(json, bin, material, primitives) {
  const texture = material.pbrMetallicRoughness?.baseColorTexture;
  if (!texture) return null;
  const source = json.textures?.[texture.index]?.source;
  if (source == null) return null;
  const image = decodeImage(json, bin, source);
  if (image.skipped) return { skipped: image.skipped };

  const uvSet = texture.texCoord ? `TEXCOORD_${texture.texCoord}` : "TEXCOORD_0";
  let sampled = 0; let empty = 0; let black = 0; let clear = 0;

  const total = primitives.reduce(
    (n, p) => n + (json.accessors?.[p.primitive.attributes?.[uvSet]]?.count || 0), 0,
  );
  const step = Math.max(1, Math.ceil(total / SAMPLE_CAP));

  for (const p of primitives) {
    const uv = readAccessor(json, bin, p.primitive.attributes?.[uvSet]);
    if (!uv) continue;
    for (let i = 0; i < uv.count; i += step) {
      /* Wrapped, because that is what a REPEAT sampler does; a UV of 1.2 is
         not off the texture, it is 0.2 across it. */
      const u = uv.data[i * uv.size] - Math.floor(uv.data[i * uv.size]);
      const v = uv.data[i * uv.size + 1] - Math.floor(uv.data[i * uv.size + 1]);
      const x = Math.min(image.width - 1, Math.max(0, Math.round(u * (image.width - 1))));
      /* glTF UV origin is top-left, which is how the rows are stored. */
      const y = Math.min(image.height - 1, Math.max(0, Math.round(v * (image.height - 1))));
      const at = (y * image.width + x) * 4;
      const isBlack = image.data[at] < NEAR_BLACK
        && image.data[at + 1] < NEAR_BLACK && image.data[at + 2] < NEAR_BLACK;
      const isClear = image.data[at + 3] < CLEAR_ALPHA;
      sampled += 1;
      if (isBlack) black += 1;
      if (isClear) clear += 1;
      if (isBlack && isClear) empty += 1;
    }
  }
  if (!sampled) return null;
  return {
    sampled,
    emptyShare: empty / sampled,
    blackShare: black / sampled,
    clearShare: clear / sampled,
    size: `${image.width}×${image.height}`,
  };
}

/**
 * THE AUDIT.
 *
 * Every cause of an unexpectedly dark surface that can be decided from the
 * file, each reported separately, because the fix for each is different and a
 * single "materials look wrong" would tell an exporter nothing.
 *
 * @returns {{ findings: Array, materials: Array, checked: boolean }}
 */
function auditSurfaces(buffer) {
  let json;
  try { ({ json } = readContainer(buffer)); } catch {
    /* An unreadable container is already refused, loudly, at upload. There is
       nothing for an appearance audit to add to that. */
    return { checked: false, findings: [], materials: [] };
  }
  const bin = binChunkOf(buffer);
  const byMaterial = primitivesByMaterial(json);
  const findings = [];
  const materials = [];

  for (const [index, material] of (json.materials || []).entries()) {
    const primitives = byMaterial.get(index) || [];
    if (!primitives.length) continue;
    const name = material.name || `material ${index}`;
    const meshes = [...new Set(primitives.map((p) => p.name))];
    const pbr = material.pbrMetallicRoughness || {};
    const alphaMode = material.alphaMode || "OPAQUE";

    const coverage = sampleCoverage(json, bin, material, primitives);
    const record = {
      index, name, meshes, alphaMode,
      doubleSided: material.doubleSided === true,
      hasBaseColorTexture: Boolean(pbr.baseColorTexture),
      /* The glTF DEFAULT is 1.0 for both, which is the thing people miss. */
      metallicFactor: pbr.metallicFactor ?? 1,
      roughnessFactor: pbr.roughnessFactor ?? 1,
      hasMetallicRoughnessTexture: Boolean(pbr.metallicRoughnessTexture),
      extensions: Object.keys(material.extensions || {}),
      coverage: coverage && !coverage.skipped ? {
        emptyShare: Number(coverage.emptyShare.toFixed(4)),
        size: coverage.size,
        sampled: coverage.sampled,
      } : null,
      textureSkipped: coverage?.skipped || "",
    };
    materials.push(record);

    /* ── 1 · EMPTY ATLAS SHADED AS CLOTH ────────────────────────────────
       The one that produced the black patches. */
    if (coverage && !coverage.skipped && coverage.emptyShare >= REPORTABLE && alphaMode === "OPAQUE") {
      findings.push({
        kind: "BASE_COLOUR_EMPTY",
        material: name,
        materialIndex: index,
        meshes,
        share: Number((coverage.emptyShare * 100).toFixed(1)),
        detail: `${(coverage.emptyShare * 100).toFixed(0)}% of this material's surface samples a part of `
          + `its ${coverage.size} colour texture that is fully transparent and black. The material is `
          + "declared OPAQUE, so a conforming viewer discards the transparency and shades those areas "
          + "black.",
        exportFix: "In CLO, re-export with the fabric colour baked into the texture (or set the material's "
          + "base colour factor), or export the texture without an alpha-masked atlas. If the transparency "
          + "is intentional, the material must be exported with alpha mode MASK or BLEND.",
      });
    }

    /* ── 2 · METAL WITH NOTHING TO REFLECT ──────────────────────────────
       A different black, from the same photograph: glTF defaults
       metallicFactor to 1, and a fully metallic surface lit only by lamps
       and no environment map has almost no diffuse to show. */
    if ((pbr.metallicFactor ?? 1) > 0.5 && !pbr.metallicRoughnessTexture) {
      findings.push({
        kind: "FULLY_METALLIC",
        material: name,
        materialIndex: index,
        meshes,
        detail: `This material is ${(pbr.metallicFactor ?? 1) === 1 && pbr.metallicFactor === undefined
          ? "missing a metallic factor, which glTF defaults to 1" : `set to metallic ${pbr.metallicFactor}`}`
          + ", and carries no metallic-roughness texture. A metal reflects its surroundings rather than "
          + "showing a colour of its own, so under studio lamps and no environment it renders near-black.",
        exportFix: "Export fabric with a metallic factor of 0. Cloth is not metal.",
      });
    }
  }

  /* ── 3 · GEOMETRY FAULTS THAT ALSO READ AS BLACK ──────────────────── */
  let normals = 0; let degenerate = 0; let missing = 0;
  const unnormalled = new Set();
  for (const [mi, mesh] of (json.meshes || []).entries()) {
    for (const prim of mesh.primitives || []) {
      if (prim.attributes?.NORMAL == null) {
        missing += 1;
        unnormalled.add(mesh.name || `mesh ${mi}`);
        continue;
      }
      const n = readAccessor(json, bin, prim.attributes.NORMAL);
      if (!n) continue;
      const step = Math.max(1, Math.ceil(n.count / 2000));
      for (let i = 0; i < n.count; i += step) {
        const length = Math.hypot(n.data[i * 3], n.data[i * 3 + 1], n.data[i * 3 + 2]);
        normals += 1;
        if (!Number.isFinite(length) || length < 0.5) degenerate += 1;
      }
    }
  }
  if (missing) {
    findings.push({
      kind: "NO_NORMALS",
      meshes: [...unnormalled],
      detail: `${missing} primitive(s) carry no normals, so the viewer has to infer them. Flat or `
        + "inverted shading follows.",
      exportFix: "Re-export from CLO with normals included.",
    });
  }
  if (degenerate) {
    findings.push({
      kind: "DEGENERATE_NORMALS",
      detail: `${degenerate} of ${normals} sampled normals are zero-length or not a number. Those faces `
        + "cannot be lit and render black.",
      exportFix: "Re-export from CLO; if it persists, the garment has degenerate geometry that CLO's "
        + "own mesh check will find.",
    });
  }

  /* A mirrored transform reverses winding. With back-face culling on — which
     `doubleSided: false` asks for — those faces disappear instead of being
     lit, and a hole in a garment reads as a black patch. */
  let mirrored = 0;
  for (const node of json.nodes || []) {
    if (node.scale && node.scale[0] * node.scale[1] * node.scale[2] < 0) mirrored += 1;
    else if (node.matrix) {
      const m = node.matrix;
      const det = m[0] * (m[5] * m[10] - m[6] * m[9])
        - m[4] * (m[1] * m[10] - m[2] * m[9])
        + m[8] * (m[1] * m[6] - m[2] * m[5]);
      if (det < 0) mirrored += 1;
    }
  }
  if (mirrored) {
    findings.push({
      kind: "MIRRORED_NODES",
      detail: `${mirrored} node(s) carry a mirrored transform, which reverses which way their faces `
        + "point. With single-sided materials those faces are culled and leave a gap.",
      exportFix: "Export the mirrored pieces with real geometry rather than a negative scale, or mark "
        + "those materials double-sided.",
    });
  }

  return { checked: true, findings, materials };
}

module.exports = {
  auditSurfaces,
  SAMPLE_CAP, NEAR_BLACK, CLEAR_ALPHA, REPORTABLE,
};
