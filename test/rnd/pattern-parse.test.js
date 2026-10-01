// test/rnd/pattern-parse.test.js
//
// THE PARSER, THE CLASSIFIER AND THE MAPPING LADDER — AGAINST A REAL CLO FILE.
//
// ── WHY THE APPAREL ASSERTIONS USE A GENUINE EXPORT ─────────────────────────
// A hand-written DXF fixture contains exactly the conventions its author already
// knew about, so a suite built on one proves the parser agrees with whoever
// wrote the fixture. `test/fixtures/rnd/clo-tshirt-aama.dxf` came out of CLO
// 7.1.178, and three defects in this feature exist only because it is real —
// its README lists them.
//
// Synthetic DXFs are still used, and only for the cases a real file cannot
// provide: a generic CAD drawing with no apparel conventions, a graded pattern,
// a file with notches and drill holes, and malformed bytes. Each one is built
// here rather than stored, so what it does and does not contain is visible in
// the assertion that depends on it.
"use strict";

/* ── NO DATABASE, AND SAID BEFORE ANY require ────────────────────────────────
 * Every assertion in this file is about bytes and arithmetic: a parser, a
 * classifier and a matcher, none of which touches a collection. `test/setup.js`
 * reads this flag at the top of its own module body and skips spinning up a
 * replica set, which is ten to twenty seconds of nothing per run.
 *
 * The route-level half of this feature DOES need a database and has its own
 * file, `pattern-bundle.route.test.js`. The split is deliberate: a bug that
 * only appears once mappings come off a real document — `{ ...subdoc }` copying
 * a Mongoose document's internals rather than its fields — was invisible to
 * this file and caught by that one.
 */
process.env.TEST_WITHOUT_MONGO = "1";

const fs = require("node:fs");
const path = require("node:path");

const { inspectDxf, DxfError } = require("../../utils/dxfInspect");
const {
  classifyBundleFile, routeDroppedFiles, BUNDLE_KIND, ClassifyError,
} = require("../../utils/bundleFileTypes");
const mapping = require("../../services/rnd/patternMapping.service");
const bundle = require("../../services/rnd/patternBundle.service");
const { MAPPING_METHOD, MAPPING_STATE } = require("../../models/CMS_Models/RnD/GarmentModel");

const FIXTURE = path.join(__dirname, "..", "fixtures", "rnd", "clo-tshirt-aama.dxf");
const cloDxf = () => fs.readFileSync(FIXTURE);

/* ═══ BUILDING DXFs, AND A GLB ══════════════════════════════════════════════ */

/** Group-code pairs, written the way a DXF is: two lines each. */
const pairs = (list) => list.map(([code, value]) => `${code}\n${value}`).join("\n");

/**
 * A DXF with a closed outline and NONE of the apparel conventions.
 *
 * Deliberately on layer 1 — which is a piece boundary in AAMA and also just
 * "the first layer" in any mechanical drawing. That overlap is the whole reason
 * classification cannot rest on layer 1 alone, and this fixture is what proves
 * it does not.
 */
function genericDxf() {
  const body = [
    ["0", "SECTION"], ["2", "HEADER"], ["9", "$ACADVER"], ["1", "AC1009"], ["0", "ENDSEC"],
    ["0", "SECTION"], ["2", "ENTITIES"],
    ["0", "POLYLINE"], ["8", "1"], ["66", "1"], ["70", "1"],
    ["0", "VERTEX"], ["8", "1"], ["10", "0"], ["20", "0"],
    ["0", "VERTEX"], ["8", "1"], ["10", "100"], ["20", "0"],
    ["0", "VERTEX"], ["8", "1"], ["10", "100"], ["20", "80"],
    ["0", "VERTEX"], ["8", "1"], ["10", "0"], ["20", "80"],
    ["0", "SEQEND"], ["8", "1"],
    ["0", "LINE"], ["8", "1"], ["10", "10"], ["20", "10"], ["11", "90"], ["21", "70"],
    ["0", "ENDSEC"], ["0", "EOF"],
  ];
  return Buffer.from(pairs(body), "latin1");
}

/**
 * An apparel DXF carrying the things the real CLO file does NOT: notches on
 * layer 4, drill holes on layer 13, a mirror line on layer 6, a sew line on
 * layer 14, and two graded sizes.
 */
function richApparelDxf({ sizes = ["S", "M"] } = {}) {
  const body = [
    ["0", "SECTION"], ["2", "HEADER"], ["9", "$ACADVER"], ["1", "AC1006"],
    ["9", "$INSUNITS"], ["70", "4"], ["0", "ENDSEC"],
    ["0", "SECTION"], ["2", "BLOCKS"],
  ];
  const widthFor = { S: 200, M: 220, L: 240 };
  for (const size of sizes) {
    const w = widthFor[size] || 220;
    const h = 300;
    body.push(
      ["0", "BLOCK"], ["8", "0"], ["2", `FrontBodice_${size}`], ["70", "64"], ["10", "0"], ["20", "0"],
      ["0", "TEXT"], ["8", "15"], ["10", "0"], ["20", "0"], ["1", "PIECE NAME: Front Bodice"],
      ["0", "TEXT"], ["8", "15"], ["10", "0"], ["20", "0"], ["1", `SIZE: ${size}`],
      ["0", "TEXT"], ["8", "15"], ["10", "0"], ["20", "0"], ["1", "QUANTITY: 2"],
      ["0", "TEXT"], ["8", "15"], ["10", "0"], ["20", "0"], ["1", "PIECE ID: FB-001"],
      ["0", "TEXT"], ["8", "15"], ["10", "0"], ["20", "0"], ["1", "MATERIAL: Shell cotton twill"],
      ["0", "TEXT"], ["8", "15"], ["10", "0"], ["20", "0"], ["1", "COMPONENT: Shell"],
      /* the cut line */
      ["0", "POLYLINE"], ["8", "1"], ["66", "1"], ["70", "1"],
      ["0", "VERTEX"], ["8", "1"], ["10", "0"], ["20", "0"],
      ["0", "VERTEX"], ["8", "1"], ["10", String(w)], ["20", "0"],
      ["0", "VERTEX"], ["8", "1"], ["10", String(w)], ["20", String(h)],
      ["0", "VERTEX"], ["8", "1"], ["10", "0"], ["20", String(h)],
      ["0", "SEQEND"], ["8", "1"],
      /* the sew line, inset by 10 — which IS the seam allowance */
      ["0", "POLYLINE"], ["8", "14"], ["66", "1"], ["70", "1"],
      ["0", "VERTEX"], ["8", "14"], ["10", "10"], ["20", "10"],
      ["0", "VERTEX"], ["8", "14"], ["10", String(w - 10)], ["20", "10"],
      ["0", "VERTEX"], ["8", "14"], ["10", String(w - 10)], ["20", String(h - 10)],
      ["0", "VERTEX"], ["8", "14"], ["10", "10"], ["20", String(h - 10)],
      ["0", "SEQEND"], ["8", "14"],
      /* grainline, vertical */
      ["0", "LINE"], ["8", "7"], ["10", "100"], ["20", "50"], ["11", "100"], ["21", "250"],
      /* two notches: one a bare point, one a two-point slit */
      ["0", "POINT"], ["8", "4"], ["10", "60"], ["20", "0"],
      ["0", "POLYLINE"], ["8", "4"], ["66", "1"], ["70", "0"],
      ["0", "VERTEX"], ["8", "4"], ["10", "140"], ["20", "0"],
      ["0", "VERTEX"], ["8", "4"], ["10", "140"], ["20", "6"],
      ["0", "SEQEND"], ["8", "4"],
      /* a drill point and a drill circle */
      ["0", "POINT"], ["8", "13"], ["10", "80"], ["20", "120"],
      ["0", "CIRCLE"], ["8", "13"], ["10", "120"], ["20", "120"], ["40", "2"],
      /* a mirror line — this piece is cut on the fold */
      ["0", "LINE"], ["8", "6"], ["10", "0"], ["20", "0"], ["11", "0"], ["21", String(h)],
      /* grade points */
      ["0", "POINT"], ["8", "5"], ["10", "0"], ["20", "0"],
      ["0", "POINT"], ["8", "5"], ["10", String(w)], ["20", "0"],
      /* an internal construction line */
      ["0", "POLYLINE"], ["8", "8"], ["66", "1"], ["70", "0"],
      ["0", "VERTEX"], ["8", "8"], ["10", "20"], ["20", "200"],
      ["0", "VERTEX"], ["8", "8"], ["10", String(w - 20)], ["20", "200"],
      ["0", "SEQEND"], ["8", "8"],
      ["0", "ENDBLK"], ["8", "0"],
    );
  }
  body.push(["0", "ENDSEC"], ["0", "SECTION"], ["2", "ENTITIES"]);
  for (const size of sizes) {
    body.push(["0", "INSERT"], ["8", "1"], ["2", `FrontBodice_${size}`], ["10", "0"], ["20", "0"]);
  }
  body.push(
    ["0", "TEXT"], ["8", "15"], ["10", "0"], ["20", "0"], ["1", "STYLE NAME: Test Shirt"],
    ["0", "TEXT"], ["8", "15"], ["10", "0"], ["20", "0"], ["1", "AUTHOR: Test Suite"],
    ["0", "TEXT"], ["8", "15"], ["10", "0"], ["20", "0"], ["1", "UNITS: METRIC"],
    ["0", "TEXT"], ["8", "15"], ["10", "0"], ["20", "0"], ["1", `SAMPLE SIZE: ${sizes[0]}`],
    ["0", "ENDSEC"], ["0", "EOF"],
  );
  return Buffer.from(pairs(body), "latin1");
}

function buildGlb(gltf) {
  const json = Buffer.from(JSON.stringify(gltf), "utf8");
  const pad = (4 - (json.length % 4)) % 4;
  const chunk = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + chunk.length, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(chunk.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4);
  return Buffer.concat([header, chunkHeader, chunk]);
}

const namedGlb = () => buildGlb({
  asset: { version: "2.0", generator: "CLO Virtual Fashion CLO 7.3.154" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [
    { name: "Shirt", children: [1, 2, 3, 4] },
    { name: "FB-001", mesh: 0 },
    { name: "front bodice left", mesh: 1 },
    { name: "front bodice right", mesh: 2 },
    { name: "BindedTrim_57204", mesh: 3 },
  ],
  meshes: [
    { name: "FB-001", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
    { name: "front bodice left", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
    { name: "front bodice right", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
    { name: "BindedTrim_57204", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 1 }] },
  ],
  materials: [{ name: "Shell cotton twill" }, { name: "Thread" }],
  accessors: [{ count: 300 }, { count: 900 }],
});

/** The merged export the brief names by name. One mesh, called `Object_2`. */
const mergedGlb = () => buildGlb({
  asset: { version: "2.0", generator: "Sketchfab-16.75.0" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [
    { name: "Sketchfab_model", children: [1] },
    { name: "Object_2", mesh: 0 },
  ],
  meshes: [{ name: "Object_2", primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  accessors: [{ count: 2000 }, { count: 6000 }],
});

const cloProject = () => Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x14, 0x00, 0x00, 0x00, 0x08, 0x00]),
  Buffer.alloc(512, 0x5a),
]);

const refusal = (fn) => {
  try { fn(); } catch (err) { return err; }
  return null;
};

/* ═══ 1 · CLASSIFICATION, FROM THE BYTES ═══════════════════════════════════ */

test("a GLB is classified as a 3D garment model from its magic, not its name", () => {
  const read = classifyBundleFile(namedGlb(), "shirt.glb", BUNDLE_KIND.WEB_MODEL);
  expect(read.classification).toBe("GLB_MODEL");
  expect(read.kind).toBe(BUNDLE_KIND.WEB_MODEL);
  expect(read.label).toBe("3D garment model");
  expect(read.read.stats.meshes).toBe(4);
  expect(read.read.anchorable).toBe(true);
});

test("a renamed non-GLB is refused, and the refusal names what the file really is", () => {
  const err = refusal(() => classifyBundleFile(cloDxf(), "garment.glb", BUNDLE_KIND.WEB_MODEL));
  expect(err instanceof ClassifyError).toBeTruthy();
  expect(err.code).toBe("BUNDLE_FILE_MISMATCH");
  expect(err.message).toMatch(/named \.glb and was uploaded as the 3D garment model/);
  expect(err.message).toMatch(/apparel flat pattern set/);
  /* And it says which card it belongs on, rather than only that it is wrong. */
  expect(err.message).toMatch(/Put it on the flat pattern set card/);
});

test("a PNG renamed .glb is refused as a PNG", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const err = refusal(() => classifyBundleFile(png, "model.glb", BUNDLE_KIND.WEB_MODEL));
  expect(err.code).toBe("MODEL_UNREADABLE");
  expect(err.message).toMatch(/a PNG image/);
  expect(err.message).toMatch(/Export the web model from CLO as GLB/);
});

test("the real CLO export is classified as an apparel flat pattern set", () => {
  const read = classifyBundleFile(cloDxf(), "tshirtgr.dxf", BUNDLE_KIND.PATTERN);
  expect(read.classification).toBe("APPAREL_PATTERN");
  expect(read.kind).toBe(BUNDLE_KIND.PATTERN);
  expect(read.label).toBe("Apparel flat pattern set");
  expect(read.pattern.apparel).toBe(true);
});

test("a generic CAD DXF is classified as limited pattern data, not as a pattern set", () => {
  const read = classifyBundleFile(genericDxf(), "bracket.dxf", BUNDLE_KIND.PATTERN);
  expect(read.classification).toBe("GENERIC_DXF");
  expect(read.label).toBe("Generic 2D DXF — limited pattern data");
  expect(read.pattern.apparel).toBe(false);
  /* It has a closed outline on layer 1 and is STILL not a pattern — which is
     the distinction the whole classification exists to make. */
  expect(read.pattern.stats.piecesWithOutline).toBe(1);
  expect(read.pattern.warnings.some((w) => w.code === "PATTERN_GENERIC_DXF")).toBeTruthy();
  const warning = read.pattern.warnings.find((w) => w.code === "PATTERN_GENERIC_DXF");
  expect(warning.message).toMatch(/is not a pattern set/);
});

test("a malformed DXF is refused with the brief's own sentence", () => {
  const err = refusal(() => classifyBundleFile(
    Buffer.from("this is not a dxf at all, just prose"), "pattern.dxf", BUNDLE_KIND.PATTERN,
  ));
  expect(err.code).toBe("PATTERN_UNREADABLE");
  expect(err.message).toMatch(
    /This file is named \.dxf, but its contents are not a readable DXF pattern file/,
  );
});

test("a truncated DXF is refused rather than parsed into fewer pieces", () => {
  /* The dangerous failure: a cut-off file parses cleanly and is simply missing
     pieces, which no reader can see. */
  const whole = cloDxf();
  expect(inspectDxf(whole).stats.pieces).toBe(5);
  const err = refusal(() => inspectDxf(whole.subarray(0, 40000)));
  expect(err instanceof DxfError).toBeTruthy();
  expect(err.code).toBe("DXF_TRUNCATED");
  expect(err.message).toMatch(/Some pattern pieces are probably missing/);
});

test("a binary DXF is refused by name rather than failing as 'not a DXF'", () => {
  const binary = Buffer.concat([
    Buffer.from("AutoCAD Binary DXF\r\n\x1a\0", "latin1"), Buffer.alloc(64),
  ]);
  const err = refusal(() => inspectDxf(binary));
  expect(err.code).toBe("DXF_BINARY_UNSUPPORTED");
  expect(err.message).toMatch(/Export the pattern as ASCII DXF/);
});

test("a CLO source is classified, and its signature check does not overclaim", () => {
  const read = classifyBundleFile(cloProject(), "shirt.zprj", BUNDLE_KIND.SOURCE);
  expect(read.classification).toBe("CLO_SOURCE");
  expect(read.kind).toBe(BUNDLE_KIND.SOURCE);
  expect(read.source.container).toBe("zip");
  expect(read.source.signatureVerified).toBe(true);
  /* A `.zprj` that is not a zip is accepted by exclusion, and SAYS it was. */
  const proprietary = classifyBundleFile(
    Buffer.concat([Buffer.from([0x43, 0x4c, 0x4f, 0x00, 0x01]), Buffer.alloc(300, 0xab)]),
    "shirt.zprj", BUNDLE_KIND.SOURCE,
  );
  expect(proprietary.classification).toBe("CLO_SOURCE");
  expect(proprietary.source.signatureVerified).toBe(false);
});

test("plain text and other formats are refused as a CLO source", () => {
  const text = refusal(() => classifyBundleFile(
    Buffer.from("CLO PROJECT BYTES"), "shirt.zprj", BUNDLE_KIND.SOURCE,
  ));
  expect(text.code).toBe("MODEL_SOURCE_UNSUPPORTED");
  expect(text.message).toMatch(/plain text rather than a CLO project/);

  /* A GLB named `.zprj` is identified positively, so the refusal names the
     card it belongs on rather than only saying the source is wrong. That is a
     different and more useful code than the text case above. */
  const asGlb = refusal(() => classifyBundleFile(namedGlb(), "shirt.zprj", BUNDLE_KIND.SOURCE));
  expect(asGlb.code).toBe("BUNDLE_FILE_MISMATCH");
  expect(asGlb.message).toMatch(/uploaded as the CLO source/);
  expect(asGlb.message).toMatch(/Put it on the 3D garment model card/);

  /* A DXF named `.zprj`, the same way. */
  const asDxf = refusal(() => classifyBundleFile(cloDxf(), "shirt.zprj", BUNDLE_KIND.SOURCE));
  expect(asDxf.code).toBe("BUNDLE_FILE_MISMATCH");
  expect(asDxf.message).toMatch(/Put it on the flat pattern set card/);
});

test("a .gltf needing files beside it is refused, because it would render as nothing", () => {
  const external = Buffer.from(JSON.stringify({
    asset: { version: "2.0" },
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ count: 3 }],
    buffers: [{ uri: "shirt.bin", byteLength: 1024 }],
  }), "utf8");
  const err = refusal(() => classifyBundleFile(external, "shirt.gltf", BUNDLE_KIND.WEB_MODEL));
  expect(err.code).toBe("MODEL_ASSETS_MISSING");
  expect(err.message).toMatch(/shirt\.bin/);
  expect(err.message).toMatch(/Export as GLB/);
});

test("a self-contained .gltf is accepted and reads the same as a GLB", () => {
  const packaged = Buffer.from(JSON.stringify({
    asset: { version: "2.0", generator: "CLO" },
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: "Front Bodice", mesh: 0 }],
    meshes: [{ name: "Front Bodice", primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [{ count: 300 }, { count: 900 }],
    buffers: [{ uri: "data:application/octet-stream;base64,AAAA", byteLength: 3 }],
  }), "utf8");
  const read = classifyBundleFile(packaged, "shirt.gltf", BUNDLE_KIND.WEB_MODEL);
  expect(read.classification).toBe("GLTF_MODEL");
  expect(read.kind).toBe(BUNDLE_KIND.WEB_MODEL);
  expect(read.read.structure[0].name).toBe("Front Bodice");
  expect(read.read.anchorable).toBe(true);
});

/* ═══ 2 · A MIXED DROP ═════════════════════════════════════════════════════ */

test("a mixed drop routes each file to its own card with no declared kind", () => {
  const dropped = [
    { originalname: "garment.glb", buffer: namedGlb() },
    { originalname: "pattern.dxf", buffer: cloDxf() },
    { originalname: "project.zprj", buffer: cloProject() },
    { originalname: "notes.txt", buffer: Buffer.from("remember to re-grade the sleeve") },
  ];
  const routed = routeDroppedFiles(dropped);

  const byKind = Object.fromEntries(routed.routed.map((r) => [r.kind, r.fileName]));
  expect(byKind[BUNDLE_KIND.WEB_MODEL]).toBe("garment.glb");
  expect(byKind[BUNDLE_KIND.PATTERN]).toBe("pattern.dxf");
  expect(byKind[BUNDLE_KIND.SOURCE]).toBe("project.zprj");

  /* The unidentifiable one is reported, not silently dropped and not filed as
     a source just because nothing else matched. */
  expect(routed.rejected.length).toBe(1);
  expect(routed.rejected[0].fileName).toBe("notes.txt");
  expect(routed.conflicts.length).toBe(0);

  /* ── FILE-TYPE CONFIRMATION IS A SERVER RULE, NOT A SCREEN'S CHOICE ──── */
  expect(routed.confirmationRequired).toBe(true);
});

test("two files of one kind in a drop is a conflict the person resolves", () => {
  const routed = routeDroppedFiles([
    { originalname: "a.dxf", buffer: cloDxf() },
    { originalname: "b.dxf", buffer: richApparelDxf() },
    { originalname: "g.glb", buffer: namedGlb() },
  ]);
  expect(routed.conflicts.length).toBe(1);
  expect(routed.conflicts[0].kind).toBe(BUNDLE_KIND.PATTERN);
  expect(routed.conflicts[0].fileNames.sort()).toEqual(["a.dxf", "b.dxf"]);
  expect(routed.conflicts[0].message).toMatch(/choose which to publish/);
});

test("a file routes on its contents even when its extension lies", () => {
  const routed = routeDroppedFiles([
    /* A GLB someone named `.dxf`. It is a model, and it is routed as one. */
    { originalname: "mystery.dxf", buffer: namedGlb() },
  ]);
  expect(routed.routed.length).toBe(1);
  expect(routed.routed[0].kind).toBe(BUNDLE_KIND.WEB_MODEL);
  expect(routed.rejected.length).toBe(0);
});

/* ═══ 3 · WHAT THE REAL CLO FILE PUBLISHES ═════════════════════════════════ */

test("the unit comes from AAMA's own text, and says where it came from", () => {
  const read = inspectDxf(cloDxf());
  expect(read.unit).toBe("in");
  /* `$INSUNITS` is absent in this file, so the apparel statement is the source
     — and the provenance travels with the answer. */
  expect(read.unitSource).toBe("aama-units-text");
  expect(read.unitDeclared).toBe("ENGLISH");
  expect(read.unitInMm).toBe(25.4);
});

test("$INSUNITS is read when AAMA's text is absent, and nothing is assumed when both are", () => {
  const metric = inspectDxf(richApparelDxf());
  expect(metric.unit).toBe("mm");
  expect(metric.unitSource).toBe("aama-units-text");

  const silent = inspectDxf(genericDxf());
  expect(silent.unit).toBe("");
  expect(silent.unitSource).toBe("none");
  expect(silent.unitInMm).toBe(null);
});

test("pattern pieces are extracted with the facts the file states", () => {
  const read = inspectDxf(cloDxf());
  expect(read.stats.pieces).toBe(5);
  const names = read.pieces.map((p) => p.name);
  expect(names).toEqual([
    "Pattern_636968", "Pattern_636969", "Pattern_1621764", "Pattern_1621765", "Pattern_2091816",
  ]);
  for (const piece of read.pieces) {
    expect(piece.size).toBe("M");
    expect(piece.quantity).toBe(1);
    /* ── AND THAT EVERY NAME IS THE EXPORTER'S, NOT A PERSON'S ────────────
       The distinction decides whether name-based mapping is possible at all. */
    expect(piece.generatedName).toBe(true);
  }
});

test("a named piece is recorded as named, so the two cases are distinguishable", () => {
  const read = inspectDxf(richApparelDxf({ sizes: ["M"] }));
  expect(read.pieces.length).toBe(1);
  expect(read.pieces[0].name).toBe("Front Bodice");
  expect(read.pieces[0].generatedName).toBe(false);
  expect(read.pieces[0].publishedId).toBe("FB-001");
  expect(read.pieces[0].quantity).toBe(2);
  expect(read.pieces[0].material).toBe("Shell cotton twill");
  expect(read.pieces[0].componentClass).toBe("shell");
});

test("geometry is measured from the outline, and matches an independent calculation", () => {
  const read = inspectDxf(cloDxf());
  const front = read.pieces[0];
  /* Computed by hand from the vertex list before the parser existed. */
  expect(front.width).toBe(24.7664);
  expect(front.height).toBe(28.406);
  expect(front.area).toBe(615.5578);
  expect(front.perimeter).toBe(103.4718);
  expect(front.outlineClosed).toBe(true);
  expect(front.outline.length).toBe(125);
});

test("grainlines are read as an axis and an angle off vertical", () => {
  const read = inspectDxf(cloDxf());
  expect(read.stats.grainlines).toBe(5);
  for (const piece of read.pieces) {
    expect(piece.grainline).toBeTruthy(); /* ${piece.name} has a grainline */
    expect(piece.grainline.direction).toBe("lengthwise");
    expect(Math.abs(piece.grainline.offVerticalDegrees) < 1).toBeTruthy();
  }
});

test("notches and drill points are extracted in each form a vendor draws them", () => {
  const read = inspectDxf(richApparelDxf({ sizes: ["M"] }));
  const piece = read.pieces[0];

  expect(piece.notches.length).toBe(2);
  const forms = piece.notches.map((n) => n.form).sort();
  expect(forms).toEqual(["point", "slit"]);
  const point = piece.notches.find((n) => n.form === "point");
  expect(point.at).toEqual({ x: 60, y: 0 });
  const slit = piece.notches.find((n) => n.form === "slit");
  expect(slit.depth).toBe(6);

  /* A bare POINT and a CIRCLE on layer 13 are both drill holes; the circle
     keeps its radius, because it was drawn at a real size. */
  expect(piece.drillPoints.length).toBe(2);
  expect(piece.drillPoints.map((d) => d.radius).sort()).toEqual([2, null]);
});

test("the seam allowance is measured between the cut line and the sew line", () => {
  const read = inspectDxf(richApparelDxf({ sizes: ["M"] }));
  const allowance = read.pieces[0].seamAllowance;
  expect(allowance).toBeTruthy(); /* an allowance is published when both lines are present */
  expect(allowance.value).toBe(10);
  expect(allowance.uniform).toBe(true);
  expect(allowance.source).toBe("measured-between-cut-and-sew-lines");
});

test("a mirror line on layer 6 states cut-on-fold", () => {
  const read = inspectDxf(richApparelDxf({ sizes: ["M"] }));
  expect(read.pieces[0].cutOnFold).toBe(true);
  expect(read.pieces[0].mirrorLine).toBeTruthy();
});

test("grading is extracted across sizes, with the increments between them", () => {
  const read = inspectDxf(richApparelDxf({ sizes: ["S", "M", "L"] }));
  expect(read.grading.graded).toBe(true);
  expect(read.grading.sizes).toEqual(["S", "M", "L"]);
  expect(read.grading.sizeCount).toBe(3);
  expect(read.grading.gradePointsPublished).toBe(true);

  const graded = read.grading.pieces[0];
  expect(graded.sizes).toEqual(["S", "M", "L"]);
  /* 200 → 220 → 240 wide, so every step is +20. */
  expect(graded.increments.map((i) => i.width)).toEqual([20, 20]);
  expect(graded.increments.map((i) => i.height)).toEqual([0, 0]);
});

/* ═══ 4 · ABSENT IS ABSENT ═════════════════════════════════════════════════
 *
 * The single most important group in this file. Every assertion here is that a
 * fact the file did not publish is `null` or `""` — never `0`, never `false`,
 * never a plausible default somebody could cut cloth against.
 */

test("metadata the real CLO file does not publish is unknown, not zero or false", () => {
  const read = inspectDxf(cloDxf());
  for (const piece of read.pieces) {
    expect(piece.seamAllowance).toBe(null); /* no sew line means an UNPUBLISHED allowance, not zero */
    expect(piece.notches).toEqual([]); /* no notch layer means no notches */
    expect(piece.drillPoints).toEqual([]);
    expect(piece.gradePoints).toEqual([]);
    expect(piece.material).toBe(""); /* the file states no material */
    expect(piece.componentClass).toBe(""); /* shell/lining is not guessed from a name or a size */
    expect(piece.cutOnFold).toBe(null); /* no mirror line and no text means UNSTATED, not false */
    expect(piece.mirrored).toBe(null);
    expect(piece.publishedId).toBe(""); /* CLO published no stable piece id */
  }
  /* And the file-level facts the same way. */
  expect(read.grading.graded).toBe(false); /* one size is not a grading with one step */
  expect(read.grading.sizes).toEqual(["M"]);
  expect(read.grading.gradePointsPublished).toBe(false);
  expect(read.stats.notches).toBe(0);
});

test("the conventions a file used are reported, so silence is distinguishable from blindness", () => {
  const read = inspectDxf(cloDxf());
  const layers = read.conventions.map((c) => `${c.layer}=${c.meaning}`);
  expect(layers).toEqual([
    "1=piece boundary", "2=turn points", "3=curve points", "7=grainline", "8=internal lines",
  ]);
  /* The layers that would have carried the absent facts are simply not there. */
  expect(!read.layersSeen.includes("4")).toBeTruthy(); /* no notch layer */
  expect(!read.layersSeen.includes("13")).toBeTruthy(); /* no drill layer */
  expect(!read.layersSeen.includes("14")).toBeTruthy(); /* no sew line */
});

test("the header's placeholder extents are detected rather than trusted", () => {
  const read = inspectDxf(cloDxf());
  /* CLO writes $EXTMAX 1000,1000 while the geometry lives between -35 and 79. */
  expect(read.warnings.some((w) => w.code === "PATTERN_EXTENTS_PLACEHOLDER")).toBeTruthy();
  expect(read.bounds.maxX < 100).toBeTruthy(); /* framed on the geometry, not the header */
  expect(read.bounds.minX < 0).toBeTruthy();
});

/* ═══ 5 · THE MAPPING LADDER ═══════════════════════════════════════════════ */

const setFrom = (buffer) => {
  const read = inspectDxf(buffer);
  return bundle.ingestPatternSet(read, {
    file: { originalname: "p.dxf", buffer }, parseRevision: 1,
  });
};

const structureOf = (glb) => require("../../utils/glbInspect").inspectGlb(glb).structure;

test("a stable id both files publish is accepted without a person", () => {
  const set = setFrom(richApparelDxf({ sizes: ["M"] }));
  const result = mapping.proposeMappings(set, structureOf(namedGlb()), [], 1);

  const mapped = result.mappings.find((m) => m.pieceName === "Front Bodice");
  expect(mapped).toBeTruthy(); /* the piece is mapped */
  expect(mapped.method).toBe(MAPPING_METHOD.PUBLISHED_ID);
  expect(mapped.confidence).toBe(1);
  expect(mapped.nodeName).toBe("FB-001");
  /* The one automatic confirmation, and it is not an inference — both exports
     named the same thing. */
  expect(mapped.state).toBe(MAPPING_STATE.CONFIRMED);
  expect(mapped.basis).toMatch(/both publish the identifier "FB-001"/);
});

test("an exact name match is proposed and REQUIRES confirmation", () => {
  const set = {
    pieces: [{ pieceRef: "PP-A", name: "Front Bodice Left", generatedName: false, area: 300, material: "" }],
  };
  const result = mapping.proposeMappings(set, structureOf(namedGlb()), [], 1);

  expect(result.mappings.length).toBe(1);
  const mapped = result.mappings[0];
  expect(mapped.nodeName).toBe("front bodice left");
  /* Case is not a difference, so this is the exact-name rung. It is still an
     inference — two exports can legitimately contain different objects with the
     same name — so it waits for a person. */
  expect(mapped.method).toBe(MAPPING_METHOD.EXACT_NAME);
  expect(mapped.confidence < 1).toBeTruthy();
  expect(mapped.state).toBe(MAPPING_STATE.UNCONFIRMED); /* a name match is never self-evident */
  expect(result.awaitingConfirmation).toBe(1);
});

test("a normalised name match is proposed, and also requires confirmation", () => {
  /* Separators and an exporter's counter differ, so only the normalised rung
     can connect these — which is exactly where a wrong answer looks right. */
  const set = {
    pieces: [{
      pieceRef: "PP-B", name: "Front_Bodice_Left_Panel_01", generatedName: false,
      area: 300, material: "",
    }],
  };
  const result = mapping.proposeMappings(set, structureOf(namedGlb()), [], 1);

  expect(result.mappings.length).toBe(1);
  const mapped = result.mappings[0];
  expect(mapped.nodeName).toBe("front bodice left");
  expect(mapped.method).toBe(MAPPING_METHOD.NORMALISED_NAME);
  expect(mapped.state).toBe(MAPPING_STATE.UNCONFIRMED);
  expect(mapped.basis).toMatch(/words in common/);
});

test("a left piece is never matched to a right component, however alike the names", () => {
  const set = {
    pieces: [{ pieceRef: "PP-L", name: "Front Bodice Left", generatedName: false, area: 300, material: "" }],
  };
  /* Only the RIGHT component exists. The names are otherwise identical, which
     is exactly why a similarity scorer would rank it first. */
  const rightOnly = structureOf(namedGlb()).filter((n) => n.name !== "front bodice left");
  const result = mapping.proposeMappings(set, rightOnly, [], 1);

  expect(result.mappings.length).toBe(0);
  expect(result.unmapped.length).toBe(1);
  expect(result.unmapped[0].reason).toBe("no_match");
});

test("an uncertain match is not silently accepted — the piece says needs mapping", () => {
  /* Generated piece names on one side, real component names on the other. No
     rung of the ladder can honestly connect them. */
  const set = setFrom(cloDxf());
  const result = mapping.proposeMappings(set, structureOf(namedGlb()), [], 1);

  expect(result.mappings.length).toBe(0); /* nothing is mapped on a guess */
  expect(result.unmapped.length).toBe(5);
  for (const entry of result.unmapped) {
    expect(entry.reason).toBe("piece_unnamed");
    /* Suggestions exist to shorten a manual search and are labelled so they
       cannot be read as matches. */
    for (const suggestion of entry.suggestions) {
      expect(suggestion.kind).toBe("suggestion");
      expect(suggestion.basis).toMatch(/this is not a mapping/);
    }
  }
});

test("the merged Object_2 model reports its limitation in the brief's own words", () => {
  const set = setFrom(cloDxf());
  const result = mapping.proposeMappings(set, structureOf(mergedGlb()), [], 1);

  expect(result.availability.mergedGarmentMesh).toBe(true);
  expect(result.availability.identifiable).toBe(false);
  expect(result.availability.limitation).toBe(
    "This 3D export contains one merged garment mesh, so individual pattern pieces "
    + "cannot be highlighted in 3D.",
  );
  /* And no piece claims a collar, a sleeve or a cuff. */
  expect(result.mappings.length).toBe(0);
  for (const entry of result.unmapped) expect(entry.reason).toBe("merged_model");
});

test("trim meshes are not offered as pattern pieces", () => {
  /* `BindedTrim_57204` — the name whose `_` defeated a `\b` and put nineteen
     trims into the candidate list on a real CLO export. */
  const components = mapping.garmentComponents(structureOf(namedGlb()));
  expect(!components.some((c) => /BindedTrim/.test(c.name))).toBeTruthy();
  expect(components.length).toBe(3);
});

test("a confirmed mapping survives a re-match, and a rejected one is not re-proposed", () => {
  const set = setFrom(richApparelDxf({ sizes: ["M"] }));
  const first = mapping.proposeMappings(set, structureOf(namedGlb()), [], 1);
  const confirmed = first.mappings.map((m) => ({
    ...m, state: MAPPING_STATE.CONFIRMED, nodeRef: m.nodeRef, nodeName: m.nodeName,
  }));

  const second = mapping.proposeMappings(set, structureOf(namedGlb()), confirmed, 2);
  expect(second.mappings.length).toBe(confirmed.length);
  expect(second.mappings[0].state).toBe(MAPPING_STATE.CONFIRMED);
  expect(second.mappings[0].mappingRevision).toBe(2); /* the revision records which parse it was for */

  const rejected = [{ ...first.mappings[0], state: MAPPING_STATE.REJECTED }];
  const third = mapping.proposeMappings(set, structureOf(namedGlb()), rejected, 3);
  expect(third.mappings[0].state).toBe(MAPPING_STATE.REJECTED);
  expect(third.unmapped.some((u) => u.reason === "rejected")).toBeTruthy();
});

/* ═══ 6 · DERIVED CHECKS AND BUNDLE COHERENCE ══════════════════════════════ */

const rowWith = (set, extra = {}) => ({
  patternSet: set,
  structure: structureOf(namedGlb()),
  assets: [
    { kind: "web_model", uploadedAt: new Date("2026-10-01T09:00:00Z") },
    { kind: "pattern", uploadedAt: new Date("2026-10-01T09:01:00Z") },
  ],
  manifest: { unit: "in" },
  modelSize: "M",
  pieceMappings: [],
  ...extra,
});

test("two files naming different revisions is BLOCKING, and says so", () => {
  const row = rowWith(setFrom(cloDxf()), {
    declaredModelRevision: "2", declaredPatternRevision: "3",
  });
  const warnings = bundle.bundleCoherence(row);
  const found = warnings.find((w) => w.code === "BUNDLE_REVISION_MISMATCH");
  expect(found).toBeTruthy(); /* the mismatch is detected */
  expect(found.severity).toBe("blocking");
  expect(found.message).toMatch(/describes two different garments/);

  const checks = bundle.derivedChecks(row, null, warnings);
  expect(checks.approvable).toBe(false);
});

test("units that disagree are blocking; sizes that differ are only needs-review", () => {
  const mismatchedUnit = bundle.bundleCoherence(rowWith(setFrom(cloDxf()), { manifest: { unit: "mm" } }));
  const unit = mismatchedUnit.find((w) => w.code === "BUNDLE_UNIT_MISMATCH");
  expect(unit.severity).toBe("blocking");

  /* A model draped at M beside a pattern graded S–XL is ordinary. A model
     draped at a size the pattern does not contain is worth a look, and is not
     a reason to refuse the bundle. */
  const mismatchedSize = bundle.bundleCoherence(rowWith(setFrom(cloDxf()), { modelSize: "XL" }));
  const size = mismatchedSize.find((w) => w.code === "BUNDLE_SIZE_MISMATCH");
  expect(size.severity).toBe("needs_review");
});

test("one file replaced long after the others is reported", () => {
  const row = rowWith(setFrom(cloDxf()), {
    assets: [
      { kind: "web_model", uploadedAt: new Date("2026-09-20T09:00:00Z") },
      { kind: "pattern", uploadedAt: new Date("2026-10-01T09:00:00Z") },
    ],
  });
  const found = bundle.bundleCoherence(row).find((w) => w.code === "BUNDLE_FILES_OUT_OF_STEP");
  expect(found).toBeTruthy();
  expect(found.severity).toBe("needs_review");
  expect(found.message).toMatch(/may not come from the same export/);
});

test("absent optional metadata never blocks a publication", () => {
  /* The real CLO file has no notches, no seam allowance, no grading and no
     chosen piece names. All four are findings; none of them is blocking. */
  const row = rowWith(setFrom(cloDxf()));
  const state = mapping.proposeMappings(row.patternSet, row.structure, [], 1);
  const checks = bundle.derivedChecks(row, state);

  expect(checks.counts.blocking).toBe(0);
  expect(checks.approvable).toBe(true);
  const codes = checks.needsReview.map((f) => f.code);
  expect(codes.includes("PIECES_UNNAMED")).toBeTruthy();
  expect(codes.includes("PIECES_NO_NOTCHES")).toBeTruthy();
  expect(codes.includes("SEAM_ALLOWANCE_UNPUBLISHED")).toBeTruthy();
  expect(checks.informational.some((f) => f.code === "PATTERN_NOT_GRADED")).toBeTruthy();
});

test("a drafting convention is not reported as artwork on the wrong piece", () => {
  /* CLO extends internal lines 20mm past the hem and publishes the hem
     allowance just outside the cut line. Neither is a mark off its panel. */
  const row = rowWith(setFrom(cloDxf()));
  const checks = bundle.derivedChecks(row, null);
  expect(!checks.needsReview.some((f) => f.code === "MARKS_OUTSIDE_PIECE")).toBeTruthy(); /* the real export raises no stray-mark finding */
});

test("a mark genuinely on another piece IS reported", () => {
  const set = setFrom(cloDxf());
  set.pieces[0].drillPoints.push({ x: 9000, y: 9000, radius: null });
  const checks = bundle.derivedChecks(rowWith(set), null);
  const found = checks.needsReview.find((f) => f.code === "MARKS_OUTSIDE_PIECE");
  expect(found).toBeTruthy();
  expect(found.message).toMatch(/lie entirely outside the piece outline/);
});

test("duplicate piece identifiers are blocking, because a reference becomes ambiguous", () => {
  const set = setFrom(richApparelDxf({ sizes: ["S", "M"] }));
  /* Both sizes publish PIECE ID: FB-001, which is what the real file would do
     wrongly if a grader duplicated an id rather than a rule. */
  const checks = bundle.derivedChecks(rowWith(set), null);
  const found = checks.blocking.find((f) => f.code === "PIECE_IDS_DUPLICATED");
  expect(found).toBeTruthy();
  expect(checks.approvable).toBe(false);
});

test("an implausible scale is blocking, because every derived number is wrong with it", () => {
  const set = setFrom(cloDxf());
  /* The same geometry relabelled as millimetres: a 24.77mm front bodice. */
  set.unit = "mm";
  set.unitInMm = 1;
  const checks = bundle.derivedChecks(rowWith(set, { manifest: { unit: "mm" } }), null);
  const found = checks.blocking.find((f) => f.code === "PATTERN_SCALE_IMPLAUSIBLE");
  expect(found).toBeTruthy();
  expect(found.message).toMatch(/No garment piece is that small/);
});

/* ═══ 7 · MEASUREMENTS, AND WHAT THEY MUST NOT BE CALLED ═══════════════════ */

test("net pattern area is never presented as fabric consumption", () => {
  const measurements = bundle.patternMeasurements(setFrom(cloDxf()));
  expect(measurements.scaleVerified).toBe(true);
  expect(measurements.unit).toBe("in");
  expect(measurements.totalNetArea).toBe(1538.4152);
  /* The figure exists, it is named for what it is, and the payload itself
     carries the reason it is not consumption. */
  expect(measurements.netAreaIsNotConsumption).toMatch(/It is not fabric consumption/);
  expect(measurements.netAreaIsNotConsumption).toMatch(/marker arrangement/);
  expect(measurements.netAreaIsNotConsumption).toMatch(/end loss/);
  expect("fabricConsumption" in measurements).toBe(false);
});

test("an unscaled pattern reports drawing units and converts nothing", () => {
  const measurements = bundle.patternMeasurements(setFrom(genericDxf()));
  expect(measurements.scaleVerified).toBe(false);
  expect(measurements.unit).toBe("drawing units");
  expect(measurements.totalNetAreaMm2).toBe(null);
  for (const piece of measurements.pieces) {
    expect(piece.areaMm2).toBe(null);
    expect(piece.widthMm).toBe(null);
  }
});

test("a quantity-weighted total exists only when every piece published a quantity", () => {
  const withQuantities = bundle.patternMeasurements(setFrom(cloDxf()));
  expect(withQuantities.quantityPublishedForEveryPiece).toBe(true);
  expect(withQuantities.totalNetAreaByQuantity !== null).toBeTruthy();

  const set = setFrom(cloDxf());
  set.pieces[0].quantity = null;
  const partial = bundle.patternMeasurements(set);
  expect(partial.quantityPublishedForEveryPiece).toBe(false);
  expect(partial.totalNetAreaByQuantity).toBe(null); /* an assumed 1 is never substituted */
});

test("notch spacing is measured along the outline, not across the gap", () => {
  const set = setFrom(richApparelDxf({ sizes: ["M"] }));
  const measured = bundle.patternMeasurements(set).pieces[0];
  expect(measured.notchSpacing.length).toBe(1);
  /* The two notches sit at x=60 and x=140 on the bottom edge, so along the
     outline they are 80 apart. */
  expect(measured.notchSpacing[0].along).toBe(80);
});

test("a set too large to store is refused rather than silently trimmed", () => {
  /* The ceiling exists because the parsed set is embedded on the publication
     and has to fit inside MongoDB's document limit. Dropping geometry instead
     would produce a pattern that renders, measures and is wrong. */
  const read = inspectDxf(cloDxf());
  const tooManyPoints = { ...read, stats: { ...read.stats, vertices: 999_999 } };
  const byVertices = refusal(() => bundle.ingestPatternSet(tooManyPoints, {
    file: { originalname: "p.dxf", buffer: cloDxf() },
  }));
  expect(byVertices).toBeTruthy(); /* the ingest refuses */
  expect(byVertices.code).toBe("PATTERN_TOO_LARGE");
  expect(byVertices.message).toMatch(/kept whole rather than simplified/);

  const tooManyPieces = { ...read, stats: { ...read.stats, pieces: 5000 } };
  const byPieces = refusal(() => bundle.ingestPatternSet(tooManyPieces, {
    file: { originalname: "p.dxf", buffer: cloDxf() },
  }));
  expect(byPieces.code).toBe("PATTERN_TOO_LARGE");
  expect(byPieces.message).toMatch(/Export one size range at a time/);
});

/* ═══ 8 · PIECE REFS ═══════════════════════════════════════════════════════ */

test("a piece ref is stable across re-parses, so confirmed mappings are not orphaned", () => {
  const first = setFrom(cloDxf());
  const second = setFrom(cloDxf());
  expect(first.pieces.map((p) => p.pieceRef)).toEqual(second.pieces.map((p) => p.pieceRef));
});

test("two identical pieces — a left and a right sleeve — still get different refs", () => {
  const set = setFrom(cloDxf());
  /* Pattern_1621764 and Pattern_1621765 are geometrically identical. */
  const sleeves = set.pieces.filter((p) => p.area === 138.4915);
  expect(sleeves.length).toBe(2);
  expect(sleeves[0].pieceRef).not.toBe(sleeves[1].pieceRef);
});
