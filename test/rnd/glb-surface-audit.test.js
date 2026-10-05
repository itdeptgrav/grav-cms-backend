// test/rnd/glb-surface-audit.test.js
//
// WHY A GARMENT DRAWS DIFFERENTLY HERE THAN IT DID IN CLO.
//
// ── THE INVESTIGATION THIS PINS ─────────────────────────────────────────────
// A CLO export arrived with large black patches that were not black in CLO.
// Every obvious explanation was wrong: the normals were valid, nothing was
// mirrored, no extension was unsupported and the metalness was zero. The cause
// was that the base-colour texture is an ATLAS whose colour lives inside an
// alpha-masked island, the area outside it is (0,0,0,0), and the material says
// `alphaMode: OPAQUE` — which per the glTF spec means the alpha is DISCARDED.
// So every surface whose UVs fall outside the island samples pure black and is
// shaded as black cloth.
//
// These tests build that situation from arithmetic rather than relying on the
// 20MB file, so the finding survives the file being deleted — and then check
// the real export separately, where it is available.
"use strict";

const { PNG } = require("pngjs");
const { auditSurfaces } = require("../../utils/glbSurfaceAudit");

/* ═══ A GLB, BUILT TO ORDER ════════════════════════════════════════════════ */

/** A 4x4 PNG: `inside` texels opaque colour, the rest (0,0,0,0). */
function atlas({ inside = 0.25, colour = [200, 180, 160] } = {}) {
  const png = new PNG({ width: 16, height: 16 });
  const edge = Math.round(16 * Math.sqrt(inside));
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const i = (y * 16 + x) * 4;
      const within = x < edge && y < edge;
      png.data[i] = within ? colour[0] : 0;
      png.data[i + 1] = within ? colour[1] : 0;
      png.data[i + 2] = within ? colour[2] : 0;
      png.data[i + 3] = within ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

/**
 * A minimal but REAL GLB: two triangles, positions, normals and UVs, with one
 * material pointing at an embedded PNG. Built rather than fixtured so each
 * test can state the exact condition it is about.
 */
function buildGlb({
  uvs, material = {}, png = atlas(), normals = null, nodeScale = null, meshName = "Front panel",
} = {}) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
  const norms = new Float32Array(normals || [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uv = new Float32Array(uvs);
  const indices = new Uint16Array([0, 1, 2, 1, 3, 2]);

  const parts = [positions, norms, uv, indices, png];
  const offsets = [];
  let total = 0;
  for (const p of parts) {
    const bytes = Buffer.isBuffer(p) ? p.length : p.byteLength;
    offsets.push(total);
    total += bytes + ((4 - (bytes % 4)) % 4);
  }
  const bin = Buffer.alloc(total);
  parts.forEach((p, i) => {
    const b = Buffer.isBuffer(p) ? p : Buffer.from(p.buffer, p.byteOffset, p.byteLength);
    b.copy(bin, offsets[i]);
  });

  const json = {
    asset: { version: "2.0", generator: "CLO Standalone OnlineAuth" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: meshName, mesh: 0, ...(nodeScale ? { scale: nodeScale } : {}) }],
    meshes: [{
      name: meshName,
      primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }],
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: 4, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 4, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: 6, type: "SCALAR" },
    ],
    bufferViews: parts.map((p, i) => ({
      buffer: 0,
      byteOffset: offsets[i],
      byteLength: Buffer.isBuffer(p) ? p.length : p.byteLength,
    })),
    buffers: [{ byteLength: total }],
    images: [{ bufferView: 4, mimeType: "image/png" }],
    samplers: [{}],
    textures: [{ source: 0, sampler: 0 }],
    materials: [{
      name: "Knit_Fleece_Terry",
      pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
      alphaMode: "OPAQUE",
      ...material,
    }],
  };
  if (normals === false) delete json.meshes[0].primitives[0].attributes.NORMAL;

  const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPad.length + 8 + bin.length, 8);
  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonPad.length, 0);
  jsonHead.writeUInt32LE(0x4e4f534a, 4);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(bin.length, 0);
  binHead.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHead, jsonPad, binHead, bin]);
}

/* UVs entirely inside the opaque island (the top-left quarter). */
const INSIDE = [0.05, 0.05, 0.2, 0.05, 0.05, 0.2, 0.2, 0.2];
/* UVs entirely in the empty part of the atlas. */
const OUTSIDE = [0.7, 0.7, 0.95, 0.7, 0.7, 0.95, 0.95, 0.95];
/* Half and half. */
const STRADDLING = [0.05, 0.05, 0.9, 0.05, 0.05, 0.9, 0.9, 0.9];

const findingsOf = (buf) => auditSurfaces(buf).findings;
const kinds = (buf) => findingsOf(buf).map((f) => f.kind);

/* ═══ 1 · THE BLACK PATCH ══════════════════════════════════════════════════ */

describe("a surface that samples texture which is not there", () => {
  test("UVs inside the painted island raise nothing", () => {
    expect(kinds(buildGlb({ uvs: INSIDE }))).not.toContain("BASE_COLOUR_EMPTY");
  });

  test("UVs on the empty part of the atlas are reported, with the share", () => {
    const found = findingsOf(buildGlb({ uvs: OUTSIDE }))
      .find((f) => f.kind === "BASE_COLOUR_EMPTY");
    expect(found).toBeTruthy();
    expect(found.share).toBeGreaterThan(90);
    /* Named, because "materials look wrong" tells an exporter nothing. */
    expect(found.material).toBe("Knit_Fleece_Terry");
    expect(found.meshes).toEqual(["Front panel"]);
  });

  test("it says what the renderer is doing and why it is entitled to", () => {
    const found = findingsOf(buildGlb({ uvs: OUTSIDE }))[0];
    expect(found.detail).toMatch(/fully transparent and black/i);
    expect(found.detail).toMatch(/declared OPAQUE/i);
    /* And what to change, in CLO's terms rather than glTF's. */
    expect(found.exportFix).toMatch(/CLO/);
    expect(found.exportFix).toMatch(/MASK or BLEND/);
  });

  test("a part-empty material is still reported — half a black panel is a defect", () => {
    const found = findingsOf(buildGlb({ uvs: STRADDLING }))
      .find((f) => f.kind === "BASE_COLOUR_EMPTY");
    expect(found).toBeTruthy();
    expect(found.share).toBeGreaterThan(5);
    expect(found.share).toBeLessThan(100);
  });

  test("the same texture under MASK or BLEND is not a fault", () => {
    /* Declared transparency is a cut-out somebody meant. The defect is
       transparency the material told the renderer to ignore. */
    for (const alphaMode of ["MASK", "BLEND"]) {
      expect(kinds(buildGlb({ uvs: OUTSIDE, material: { alphaMode } })))
        .not.toContain("BASE_COLOUR_EMPTY");
    }
  });

  test("a material with no colour texture at all raises nothing about one", () => {
    const buf = buildGlb({
      uvs: OUTSIDE,
      material: { pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0 } },
    });
    expect(kinds(buf)).not.toContain("BASE_COLOUR_EMPTY");
  });
});

/* ═══ 2 · THE OTHER WAYS A GARMENT GOES BLACK ═════════════════════════════ */

describe("the causes it rules in and out", () => {
  test("cloth exported as metal is reported, because metal has nothing to reflect", () => {
    /* glTF defaults metallicFactor to 1. A fully metallic surface under lamps
       and no environment map renders near-black. */
    const buf = buildGlb({
      uvs: INSIDE,
      material: { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
    });
    const found = findingsOf(buf).find((f) => f.kind === "FULLY_METALLIC");
    expect(found).toBeTruthy();
    expect(found.detail).toMatch(/defaults to 1/i);
    expect(found.exportFix).toMatch(/Cloth is not metal/i);
  });

  test("a stated metallic factor of zero is not reported", () => {
    const buf = buildGlb({
      uvs: INSIDE,
      material: { pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } },
    });
    expect(kinds(buf)).not.toContain("FULLY_METALLIC");
  });

  test("missing normals are reported, and named by mesh", () => {
    const buf = buildGlb({ uvs: INSIDE, normals: false, meshName: "Under collar" });
    const found = findingsOf(buf).find((f) => f.kind === "NO_NORMALS");
    expect(found).toBeTruthy();
    expect(found.meshes).toEqual(["Under collar"]);
  });

  test("zero-length normals are reported — a face that cannot be lit is black", () => {
    const buf = buildGlb({ uvs: INSIDE, normals: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    const found = findingsOf(buf).find((f) => f.kind === "DEGENERATE_NORMALS");
    expect(found).toBeTruthy();
    expect(found.detail).toMatch(/render black/i);
  });

  test("valid normals are reported as nothing at all", () => {
    expect(kinds(buildGlb({ uvs: INSIDE }))).not.toContain("DEGENERATE_NORMALS");
    expect(kinds(buildGlb({ uvs: INSIDE }))).not.toContain("NO_NORMALS");
  });

  test("a mirrored node is reported, because culling turns it into a hole", () => {
    const buf = buildGlb({ uvs: INSIDE, nodeScale: [-1, 1, 1] });
    const found = findingsOf(buf).find((f) => f.kind === "MIRRORED_NODES");
    expect(found).toBeTruthy();
    expect(found.exportFix).toMatch(/double-sided|negative scale/i);
  });

  test("an unmirrored node is not", () => {
    expect(kinds(buildGlb({ uvs: INSIDE, nodeScale: [1, 1, 1] }))).not.toContain("MIRRORED_NODES");
  });
});

/* ═══ 3 · WHAT IT WILL NOT DO ═════════════════════════════════════════════ */

describe("the audit changes nothing", () => {
  test("the bytes it was handed are the bytes it gives back", () => {
    /* The value of a published model is that it is what CLO produced. An
       audit that quietly corrected a material would make every approval
       against this model worthless. */
    const buf = buildGlb({ uvs: OUTSIDE });
    const before = Buffer.from(buf);
    auditSurfaces(buf);
    expect(buf.equals(before)).toBe(true);
  });

  test("it reports rather than repairs — there is no fixed model in the result", () => {
    const out = auditSurfaces(buildGlb({ uvs: OUTSIDE }));
    expect(Object.keys(out).sort()).toEqual(["checked", "findings", "materials"]);
    expect(out.findings.every((f) => typeof f.exportFix === "string")).toBe(true);
  });

  test("every material is listed, whether or not it is at fault", () => {
    const out = auditSurfaces(buildGlb({ uvs: INSIDE }));
    expect(out.materials).toHaveLength(1);
    expect(out.materials[0]).toMatchObject({
      name: "Knit_Fleece_Terry", alphaMode: "OPAQUE", meshes: ["Front panel"],
    });
  });

  test("a file it cannot read is reported as unchecked, not as clean", () => {
    const out = auditSurfaces(Buffer.from("not a glb at all"));
    expect(out.checked).toBe(false);
    expect(out.findings).toEqual([]);
  });

  test("a texture it cannot decode is recorded as unexamined", () => {
    /* Saying "I could not look" is true; saying "it is fine" would not be. */
    const buf = buildGlb({ uvs: OUTSIDE });
    const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString("utf8")
      .replace(/ +$/, ""));
    expect(json.images[0].mimeType).toBe("image/png");
    /* The JPEG path is the one that cannot be decoded here. */
    const asJpeg = Buffer.from(buf);
    const text = asJpeg.toString("latin1").replace("image/png", "image/jpg");
    const swapped = Buffer.from(text, "latin1");
    const out = auditSurfaces(swapped);
    expect(out.materials[0].textureSkipped).toMatch(/not examined/);
    expect(out.findings.map((f) => f.kind)).not.toContain("BASE_COLOUR_EMPTY");
  });
});

/* ═══ 4 · THE REAL EXPORT ═════════════════════════════════════════════════ */

describe("the CLO export this was written for", () => {
  const fs = require("fs");
  const FILE = "/Users/risheeray/Downloads/tshirt12.glb";
  const have = fs.existsSync(FILE);
  const maybe = have ? test : test.skip;

  maybe("names the three materials that render black, and the meshes wearing them", () => {
    const out = auditSurfaces(fs.readFileSync(FILE));
    const empty = out.findings.filter((f) => f.kind === "BASE_COLOUR_EMPTY");
    expect(empty.map((f) => f.material).sort())
      .toEqual(["Knit_Fleece_Terry_FRONT_2770", "Material2958", "Material3088"]);

    /* The trims are almost entirely black; the body panel is patchy. */
    const byName = Object.fromEntries(empty.map((f) => [f.material, f]));
    expect(byName.Material3088.share).toBeGreaterThan(80);
    expect(byName.Knit_Fleece_Terry_FRONT_2770.share).toBeGreaterThan(15);
    expect(byName.Knit_Fleece_Terry_FRONT_2770.share).toBeLessThan(40);
    expect(byName.Material3088.meshes.some((m) => /BindedTrim/.test(m))).toBe(true);
  });

  maybe("rules out the explanations that are not true of it", () => {
    const out = auditSurfaces(fs.readFileSync(FILE));
    const k = out.findings.map((f) => f.kind);
    /* All of these were plausible and none of them is the cause. Pinning
       their ABSENCE is what stops the next reader re-investigating them. */
    expect(k).not.toContain("DEGENERATE_NORMALS");
    expect(k).not.toContain("NO_NORMALS");
    expect(k).not.toContain("MIRRORED_NODES");
    expect(k).not.toContain("FULLY_METALLIC");
  });

  maybe("one material in the export is clean, so this is not a blanket complaint", () => {
    const out = auditSurfaces(fs.readFileSync(FILE));
    const rib = out.materials.find((m) => m.name === "Rib_1X1_319gsm_FRONT_2759");
    expect(rib.coverage.emptyShare).toBe(0);
    expect(out.findings.some((f) => f.material === rib.name)).toBe(false);
  });
});
