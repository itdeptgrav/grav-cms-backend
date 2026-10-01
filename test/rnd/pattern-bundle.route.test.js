// test/rnd/pattern-bundle.route.test.js
//
// THE FLAT PATTERN THROUGH THE REAL ROUTES: CLASSIFICATION, MAPPING, THE
// LIFECYCLE, AND WHAT INDUSTRIAL ENGINEERING IS AND IS NOT GIVEN.
//
// ── WHAT THIS SUITE IS FOR, AS DISTINCT FROM pattern-parse.test.js ──────────
// That one asserts what the parser reads. This one asserts what the PRODUCT
// does with it: whether an approved bundle is really immutable, whether a
// viewer is really refused, whether another company's bundle is really
// unreachable, whether a DXF is really private, and whether a draft is really
// absent from the IE projection. None of those is a parsing question and none
// of them can be proved without the routes, the auth and the lifecycle.
//
// It runs against an in-memory replica set with the Drive mocked at the shape
// the real service returns — the same harness as `garment-model.route.test.js`,
// and for the reason stated there: a mock that does not match its subject is a
// test that proves the mock.
//
// The pattern fixture is a genuine CLO export. See `test/fixtures/rnd/README.md`
// for the three defects that only a real file exposed.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

/* Set before any model is required: `models/Employee` encrypts salary fields on
   save and refuses to load a key that is not there, and the signer and the
   verifier have to agree on one secret. Both match the sibling suite's. */
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

const mockDrive = new Map();
jest.mock("../../services/companyDrive.service", () => ({
  uploadCompanyFile: jest.fn(async (buffer, { fileName, mimeType } = {}) => {
    const id = `drv-${mockDrive.size + 1}-${Date.now()}-${Math.random()}`;
    mockDrive.set(id, { buffer: Buffer.from(buffer), fileName, mimeType });
    return { driveFileId: id, mimeType, bytes: buffer.length };
  }),
  streamCompanyFile: jest.fn(async (id) => {
    const held = mockDrive.get(id);
    if (!held) throw new Error("not found");
    return {
      stream: require("stream").Readable.from(held.buffer),
      meta: { mimeType: held.mimeType, size: held.buffer.length },
    };
  }),
  deleteCompanyFile: jest.fn(async () => true),
}));

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const { GarmentModelPublication } = require("../../models/CMS_Models/RnD/GarmentModel");

let server; let base; let rs; let seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "rnd_pattern_bundle" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/rnd", require("../../routes/CMS_Routes/RnD/garmentModelRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
}, 240000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

/* ═══ FIXTURES ═════════════════════════════════════════════════════════════ */

const FIXTURE = path.join(__dirname, "..", "fixtures", "rnd", "clo-tshirt-aama.dxf");
const cloDxf = () => fs.readFileSync(FIXTURE);

const cloProject = () => Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x14, 0x00, 0x00, 0x00, 0x08, 0x00]),
  crypto.randomBytes(256),
]);

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

/** A model whose components can be named — so mapping is possible at all. */
const namedGlb = () => buildGlb({
  asset: { version: "2.0", generator: "CLO Virtual Fashion CLO 7.3.154" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [
    { name: "T-shirt", children: [1, 2, 3] },
    { name: "Front Bodice", mesh: 0 },
    { name: "Back Bodice", mesh: 1 },
    { name: "Sleeve", mesh: 2 },
  ],
  meshes: [
    { name: "Front Bodice", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
    { name: "Back Bodice", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
    { name: "Sleeve", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
  ],
  materials: [{ name: "Jersey" }],
  accessors: [{ count: 300 }, { count: 900 }],
});

/** The merged export the brief names. One mesh, called `Object_2`. */
const mergedGlb = () => buildGlb({
  asset: { version: "2.0", generator: "Sketchfab-16.75.0" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: "Sketchfab_model", children: [1] }, { name: "Object_2", mesh: 0 }],
  meshes: [{ name: "Object_2", primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  accessors: [{ count: 2000 }, { count: 6000 }],
});

const call = (p, { token, company, method = "GET", body, form } = {}) =>
  fetch(`${base}${p}`, {
    method,
    headers: {
      ...(form ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(form ? { body: form } : (body !== undefined ? { body: JSON.stringify(body) } : {})),
  }).then(async (r) => {
    const type = r.headers.get("content-type") || "";
    if (type.includes("application/json")) {
      const text = await r.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      return { status: r.status, body: parsed, headers: r.headers };
    }
    return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()), headers: r.headers };
  });

async function person(co, grants) {
  const n = ++seq;
  const email = `pb-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "P", lastName: `B${n}`, email, biometricId: `PB${n}`,
    isActive: true, gender: "Other", department: "R&D",
  });
  await DeptUser.create({
    name: `User ${n}`, email, passwordHash: "x", isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({
    companyId: co._id, email, employeeRef: emp._id, personName: `User ${n}`,
  });
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: `User ${n}`, role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email, name: `User ${n}`, id: String(emp._id),
    token: jwt.sign(
      { id: String(emp._id), email, name: `User ${n}`, employeeId: emp.biometricId, role: "rnd" },
      process.env.JWT_SECRET, { expiresIn: "30m" },
    ),
  };
}

async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `Loom ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-PB-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-PB-${n}`, styleCode: `SC-PB-${n}`, productName: "Jersey Tee",
    journeyId: journey._id, accountId: account._id, stage: "rnd", techSheet: { status: "pending" },
  });
  const engineer = await person(co, { "research-development": "editor" });
  const approver = await person(co, { "research-development": "approver" });
  const reader = await person(co, { "research-development": "viewer" });
  const outsider = await person(co, { sales: "approver" });
  return {
    n, co, style, engineer, approver, reader, outsider,
    as: { token: engineer.token, company: co._id },
    asApprover: { token: approver.token, company: co._id },
    asReader: { token: reader.token, company: co._id },
    asOutsider: { token: outsider.token, company: co._id },
    styleUrl: `/api/cms/rnd/garment-models/styles/${style._id}`,
  };
}

/** Publish a bundle. `pattern: true` sends the DXF in the same multipart post. */
async function publish(w, {
  glb = namedGlb(), source = true, pattern = false, fields = {},
} = {}) {
  const form = new FormData();
  form.append("webModel", new Blob([glb], { type: "model/gltf-binary" }), "tee.glb");
  if (source) {
    form.append("source", new Blob([cloProject()], { type: "application/octet-stream" }), "tee.zprj");
  }
  if (pattern) {
    form.append("patterns", new Blob([cloDxf()], { type: "application/dxf" }), "tee.dxf");
  }
  form.append("unit", fields.unit ?? "in");
  form.append("modelSize", fields.modelSize ?? "M");
  if (fields.declaredModelRevision) form.append("declaredModelRevision", fields.declaredModelRevision);
  if (fields.declaredPatternRevision) form.append("declaredPatternRevision", fields.declaredPatternRevision);
  if (fields.colourway) form.append("colourway", fields.colourway);
  const r = await call(w.styleUrl, { ...w.as, method: "POST", form });
  return r;
}

const patternUrl = (id) => `/api/cms/rnd/garment-models/${id}/pattern`;

/** Attach the DXF to an existing draft. */
async function attachPattern(w, id, { body = {} } = {}) {
  const form = new FormData();
  form.append("patterns", new Blob([cloDxf()], { type: "application/dxf" }), "tee.dxf");
  for (const [k, v] of Object.entries(body)) form.append(k, String(v));
  return call(patternUrl(id), { ...w.as, method: "PUT", form });
}

/* ═══ 1 · PUBLISHING A BUNDLE WITH A PATTERN ═══════════════════════════════ */

describe("a technical bundle carries the model and the pattern together", () => {
  test("the pattern publishes with the model and is classified on the way in", async () => {
    const w = await world();
    const r = await publish(w, { pattern: true });
    expect(r.status).toBe(201);

    expect(r.body.classification).toBe("apparel_pattern_set");
    const p = r.body.publication;
    expect(p.bundle.hasPattern).toBe(true);
    expect(p.bundle.patternPieces).toBe(5);
    expect(p.bundle.patternUnit).toBe("in");
    expect(p.bundle.patternSizes).toEqual(["M"]);
    expect(p.bundle.patternSetRef).toMatch(/^PS-[0-9A-F]{10}$/);
    expect(p.files.pattern.name).toBe("tee.dxf");
    expect(p.files.pattern.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a bundle with no pattern is an ordinary state, not a refusal", async () => {
    const w = await world();
    const r = await publish(w, { pattern: false });
    expect(r.status).toBe(201);
    expect(r.body.publication.bundle.hasPattern).toBe(false);

    const read = await call(patternUrl(r.body.publication.id), w.as);
    expect(read.status).toBe(200);
    expect(read.body.patternSet).toBe(null);
    expect(read.body.reason).toMatch(/no flat pattern attached/);
  });

  test("a pattern can be attached to a draft later, which is the real order of work", async () => {
    const w = await world();
    const created = await publish(w, { pattern: false });
    const id = created.body.publication.id;

    const attached = await attachPattern(w, id);
    expect(attached.status).toBe(200);
    expect(attached.body.replaced).toBe(false);
    expect(attached.body.classification).toBe("apparel_pattern_set");
    expect(attached.body.publication.bundle.patternPieces).toBe(5);
  });

  test("replacing a pattern bumps the parse revision rather than appending a second", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const id = created.body.publication.id;

    const replaced = await attachPattern(w, id);
    expect(replaced.status).toBe(200);
    expect(replaced.body.replaced).toBe(true);
    expect(replaced.body.patternSet.parseRevision).toBe(2);

    /* One pattern asset, not two. */
    const row = await GarmentModelPublication.findById(id).lean();
    expect(row.assets.filter((a) => a.kind === "pattern")).toHaveLength(1);
  });

  test("a file on the wrong card is refused, naming both the claim and the contents", async () => {
    const w = await world();
    const form = new FormData();
    /* The DXF sent as the web model. */
    form.append("webModel", new Blob([cloDxf()], { type: "model/gltf-binary" }), "tee.glb");
    const r = await call(w.styleUrl, { ...w.as, method: "POST", form });
    expect(r.status).toBe(415);
    /* The DXF is identified positively, so the refusal can name the card it
       belongs on rather than only saying the model is unreadable. */
    expect(r.body.error.code).toBe("BUNDLE_FILE_MISMATCH");
    expect(r.body.message).toMatch(/uploaded as the 3D garment model/);
    expect(r.body.message).toMatch(/Put it on the flat pattern set card/);
  });

  test("a GLB sent as the pattern is refused by name", async () => {
    const w = await world();
    const created = await publish(w);
    const form = new FormData();
    form.append("patterns", new Blob([namedGlb()], { type: "application/dxf" }), "tee.dxf");
    const r = await call(patternUrl(created.body.publication.id), { ...w.as, method: "PUT", form });
    expect(r.status).toBe(415);
    expect(r.body.error.code).toBe("BUNDLE_FILE_MISMATCH");
    expect(r.body.message).toMatch(/3D garment model card/);
  });
});

/* ═══ 2 · CLASSIFICATION BEFORE PUBLISHING ═════════════════════════════════ */

describe("classification is visible before anything is published", () => {
  test("a mixed drop is classified and stored nowhere", async () => {
    const w = await world();
    const form = new FormData();
    form.append("files", new Blob([namedGlb()], { type: "model/gltf-binary" }), "tee.glb");
    form.append("files", new Blob([cloDxf()], { type: "application/dxf" }), "tee.dxf");
    form.append("files", new Blob([cloProject()], { type: "application/octet-stream" }), "tee.zprj");

    const r = await call("/api/cms/rnd/garment-models/classify", { ...w.as, method: "POST", form });
    expect(r.status).toBe(200);
    expect(r.body.confirmationRequired).toBe(true);

    const byKind = Object.fromEntries(r.body.files.map((f) => [f.kind, f]));
    expect(byKind.web_model.classification).toBe("GLB_MODEL");
    expect(byKind.pattern.classification).toBe("APPAREL_PATTERN");
    expect(byKind.source.classification).toBe("CLO_SOURCE");

    /* The facts a person checks before publishing. */
    expect(byKind.pattern.summary.pieces).toBe(5);
    expect(byKind.pattern.summary.unit).toBe("in");
    expect(byKind.pattern.summary.unitSource).toBe("aama-units-text");
    expect(byKind.pattern.summary.graded).toBe(false);
    expect(byKind.pattern.summary.author).toBe("CLO Virtual Fashion Inc.");
    expect(byKind.pattern.summary.pieceNames).toHaveLength(5);

    /* ── AND NOTHING WAS CREATED ───────────────────────────────────────── */
    const rows = await GarmentModelPublication.countDocuments({ companyId: w.co._id });
    expect(rows).toBe(0);
  });

  test("an unreadable file in a drop is reported, not silently dropped", async () => {
    const w = await world();
    const form = new FormData();
    form.append("files", new Blob([namedGlb()], { type: "model/gltf-binary" }), "tee.glb");
    form.append("files", new Blob([Buffer.from("just some notes")]), "notes.txt");
    const r = await call("/api/cms/rnd/garment-models/classify", { ...w.as, method: "POST", form });
    expect(r.status).toBe(200);
    expect(r.body.files).toHaveLength(1);
    expect(r.body.rejected).toHaveLength(1);
    expect(r.body.rejected[0].fileName).toBe("notes.txt");
  });

  test("a viewer may not classify, because classifying is part of publishing", async () => {
    const w = await world();
    const form = new FormData();
    form.append("files", new Blob([namedGlb()], { type: "model/gltf-binary" }), "tee.glb");
    const r = await call("/api/cms/rnd/garment-models/classify", { ...w.asReader, method: "POST", form });
    expect(r.status).toBe(403);
  });
});

/* ═══ 3 · THE PARSED PATTERN AS THE VIEWER READS IT ════════════════════════ */

describe("the 2D viewer is given geometry, metadata and honesty about both", () => {
  test("every piece arrives with its outline and its derived measurements", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const r = await call(patternUrl(created.body.publication.id), w.as);
    expect(r.status).toBe(200);

    const set = r.body.patternSet;
    expect(set.isApparelPattern).toBe(true);
    expect(set.pieces).toHaveLength(5);
    expect(set.scaleVerified).toBe(true);
    expect(set.unit).toBe("in");

    const front = set.pieces[0];
    expect(front.outline.length).toBe(125);
    expect(front.outlineClosed).toBe(true);
    expect(front.area).toBeCloseTo(615.5578, 3);
    expect(front.grainline.direction).toBe("lengthwise");
    expect(front.pieceRef).toMatch(/^PP-[0-9A-F]{10}$/);

    /* ── AND THE ABSENT FACTS ARE ABSENT ──────────────────────────────── */
    expect(front.seamAllowance).toBe(null);
    expect(front.cutOnFold).toBe(null);
    expect(front.material).toBe("");
    expect(front.generatedName).toBe(true);
  });

  test("the measurements carry their own disclaimer about consumption", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const r = await call(patternUrl(created.body.publication.id), w.as);

    const m = r.body.measurements;
    expect(m.totalNetArea).toBeCloseTo(1538.4152, 3);
    expect(m.netAreaIsNotConsumption).toMatch(/not fabric consumption/);
    expect(m).not.toHaveProperty("fabricConsumption");
  });

  test("the derived checks are separated into blocking, review and informational", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const r = await call(patternUrl(created.body.publication.id), w.as);

    const checks = r.body.checks;
    expect(checks.counts.blocking).toBe(0);
    expect(checks.approvable).toBe(true);
    const review = checks.needsReview.map((f) => f.code);
    expect(review).toContain("PIECES_UNNAMED");
    expect(review).toContain("SEAM_ALLOWANCE_UNPUBLISHED");
  });

  test("the AAMA conventions the file used are reported", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const r = await call(patternUrl(created.body.publication.id), w.as);
    const layers = r.body.patternSet.conventions.map((c) => c.layer);
    expect(layers).toEqual(["1", "2", "3", "7", "8"]);
    /* The layers that would have carried the absent facts are simply absent. */
    expect(layers).not.toContain("4");
    expect(layers).not.toContain("14");
  });
});

/* ═══ 4 · MAPPING ══════════════════════════════════════════════════════════ */

describe("a mapping is a claim with an author, not a lookup", () => {
  test("generated piece names against named components leaves every piece needing mapping", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const r = await call(patternUrl(created.body.publication.id), w.as);

    const mapping = r.body.mapping;
    expect(mapping.mappings).toHaveLength(0);
    expect(mapping.unmapped).toHaveLength(5);
    expect(mapping.unmapped[0].reason).toBe("piece_unnamed");
    expect(mapping.confirmed).toBe(0);
  });

  test("a merged model reports its limitation in the brief's own words", async () => {
    const w = await world();
    const created = await publish(w, { glb: mergedGlb(), pattern: true });
    const r = await call(patternUrl(created.body.publication.id), w.as);

    expect(r.body.mapping.availability.mergedGarmentMesh).toBe(true);
    expect(r.body.mapping.availability.identifiable).toBe(false);
    expect(r.body.mapping.availability.limitation).toBe(
      "This 3D export contains one merged garment mesh, so individual pattern pieces "
      + "cannot be highlighted in 3D.",
    );
    for (const entry of r.body.mapping.unmapped) expect(entry.reason).toBe("merged_model");
  });

  test("a mapping set by hand is recorded as manual, with who and when", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const id = created.body.publication.id;
    const before = await call(patternUrl(id), w.as);
    const pieceRef = before.body.patternSet.pieces[0].pieceRef;

    const r = await call(`${patternUrl(id)}/mappings`, {
      ...w.as, method: "POST",
      body: { pieceRef, nodeRef: "n1", action: "confirm" },
    });
    expect(r.status).toBe(200);

    const mapped = r.body.mapping.mappings.find((m) => m.pieceRef === pieceRef);
    expect(mapped.method).toBe("manual");
    expect(mapped.state).toBe("confirmed");
    expect(mapped.nodeName).toBe("Front Bodice");
    expect(mapped.confirmedBy).toBe(w.engineer.name);
    expect(mapped.confirmedAt).toBeTruthy();
    expect(mapped.usable).toBe(true);
    expect(r.body.mapping.confirmed).toBe(1);
  });

  test("a mapping naming a component the model does not contain is refused", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const id = created.body.publication.id;
    const before = await call(patternUrl(id), w.as);

    const r = await call(`${patternUrl(id)}/mappings`, {
      ...w.as, method: "POST",
      body: { pieceRef: before.body.patternSet.pieces[0].pieceRef, nodeRef: "n999" },
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("MODEL_ANCHOR_UNKNOWN");
  });

  test("one piece may map to a repeated left/right component only when said explicitly", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const id = created.body.publication.id;
    const before = await call(patternUrl(id), w.as);
    const pieceRef = before.body.patternSet.pieces[2].pieceRef;

    const r = await call(`${patternUrl(id)}/mappings`, {
      ...w.as, method: "POST",
      body: { pieceRef, nodeRef: "n3", repeatedComponent: true, note: "Cut twice, mirrored" },
    });
    expect(r.status).toBe(200);
    const mapped = r.body.mapping.mappings.find((m) => m.pieceRef === pieceRef);
    expect(mapped.repeatedComponent).toBe(true);
    expect(mapped.note).toBe("Cut twice, mirrored");
  });

  test("a rejected mapping is remembered, so the matcher stops proposing it", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const id = created.body.publication.id;
    const before = await call(patternUrl(id), w.as);
    const pieceRef = before.body.patternSet.pieces[0].pieceRef;

    await call(`${patternUrl(id)}/mappings`, {
      ...w.as, method: "POST", body: { pieceRef, nodeRef: "n1", action: "reject" },
    });
    const after = await call(patternUrl(id), w.as);
    const rejected = after.body.mapping.mappings.find((m) => m.pieceRef === pieceRef);
    expect(rejected.state).toBe("rejected");
    expect(rejected.usable).toBe(false);
  });

  test("a confirmed mapping survives a re-match", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const id = created.body.publication.id;
    const before = await call(patternUrl(id), w.as);
    const pieceRef = before.body.patternSet.pieces[0].pieceRef;

    await call(`${patternUrl(id)}/mappings`, {
      ...w.as, method: "POST", body: { pieceRef, nodeRef: "n1" },
    });
    const rematched = await call(`${patternUrl(id)}/rematch`, { ...w.as, method: "POST", body: {} });
    expect(rematched.status).toBe(200);
    const still = rematched.body.mapping.mappings.find((m) => m.pieceRef === pieceRef);
    expect(still.state).toBe("confirmed");
    expect(still.confirmedBy).toBe(w.engineer.name);
  });

  test("a viewer may read a mapping and may not change one", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const id = created.body.publication.id;
    const before = await call(patternUrl(id), w.as);

    const read = await call(patternUrl(id), w.asReader);
    expect(read.status).toBe(200);
    expect(read.body.mapping).toBeTruthy();

    const write = await call(`${patternUrl(id)}/mappings`, {
      ...w.asReader, method: "POST",
      body: { pieceRef: before.body.patternSet.pieces[0].pieceRef, nodeRef: "n1" },
    });
    expect(write.status).toBe(403);
  });
});

/* ═══ 5 · THE BUNDLE'S FILES MUST AGREE ════════════════════════════════════ */

describe("files describing different garments are not silently combined", () => {
  test("a revision mismatch is reported as blocking and refuses approval", async () => {
    const w = await world();
    const created = await publish(w, {
      pattern: true,
      fields: { declaredModelRevision: "2", declaredPatternRevision: "3" },
    });
    const id = created.body.publication.id;

    const warnings = created.body.bundleWarnings.map((x) => x.code);
    expect(warnings).toContain("BUNDLE_REVISION_MISMATCH");
    expect(created.body.publication.blockingCount).toBe(1);

    await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.as, method: "POST", body: {} });
    const decided = await call(`/api/cms/rnd/garment-models/${id}/approve`, {
      ...w.asApprover, method: "POST", body: {},
    });
    expect(decided.status).toBe(409);
    expect(decided.body.error.code).toBe("BUNDLE_NOT_APPROVABLE");
    expect(decided.body.message).toMatch(/two different garments/);
  });

  test("a unit mismatch between the model and the pattern is blocking", async () => {
    const w = await world();
    /* The pattern publishes inches; the publisher declares the model in mm. */
    const created = await publish(w, { pattern: true, fields: { unit: "mm" } });
    const codes = created.body.bundleWarnings.map((x) => x.code);
    expect(codes).toContain("BUNDLE_UNIT_MISMATCH");
    expect(created.body.publication.blockingCount).toBeGreaterThan(0);
  });

  test("resolving a mismatch clears it, so a stale warning never blocks", async () => {
    const w = await world();
    const created = await publish(w, {
      pattern: true, fields: { declaredModelRevision: "2", declaredPatternRevision: "3" },
    });
    const id = created.body.publication.id;

    /* Re-attach the pattern, correcting its stated revision to match. */
    const fixed = await attachPattern(w, id, { body: { declaredPatternRevision: "2" } });
    expect(fixed.body.bundleWarnings.map((x) => x.code)).not.toContain("BUNDLE_REVISION_MISMATCH");
    expect(fixed.body.publication.blockingCount).toBe(0);

    await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.as, method: "POST", body: {} });
    const decided = await call(`/api/cms/rnd/garment-models/${id}/approve`, {
      ...w.asApprover, method: "POST", body: {},
    });
    expect(decided.status).toBe(200);
  });

  test("absent optional metadata does not refuse approval", async () => {
    const w = await world();
    /* The real CLO file: no notches, no seam allowance, no grading, no chosen
       piece names. Four findings, none blocking. */
    const created = await publish(w, { pattern: true });
    const id = created.body.publication.id;
    await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.as, method: "POST", body: {} });
    const decided = await call(`/api/cms/rnd/garment-models/${id}/approve`, {
      ...w.asApprover, method: "POST", body: {},
    });
    expect(decided.status).toBe(200);
    expect(decided.body.publication.state).toBe("APPROVED");
  });
});

/* ═══ 6 · AN APPROVED BUNDLE IS A RECORD ═══════════════════════════════════ */

describe("approved means immutable, and no self-approval", () => {
  async function approved(w, options = {}) {
    const created = await publish(w, { pattern: true, ...options });
    const id = created.body.publication.id;
    await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.as, method: "POST", body: {} });
    const decided = await call(`/api/cms/rnd/garment-models/${id}/approve`, {
      ...w.asApprover, method: "POST", body: {},
    });
    expect(decided.status).toBe(200);
    return id;
  }

  test("the pattern cannot be replaced on an approved bundle", async () => {
    const w = await world();
    const id = await approved(w);
    const r = await attachPattern(w, id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("MODEL_STATE_CONFLICT");
    expect(r.body.message).toMatch(/Publish a new bundle/);
  });

  test("a mapping cannot be changed on an approved bundle", async () => {
    const w = await world();
    const id = await approved(w);
    const read = await call(patternUrl(id), w.as);
    expect(read.body.editable).toBe(false);

    const r = await call(`${patternUrl(id)}/mappings`, {
      ...w.as, method: "POST",
      body: { pieceRef: read.body.patternSet.pieces[0].pieceRef, nodeRef: "n1" },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("MODEL_STATE_CONFLICT");
  });

  test("a re-match is refused on an approved bundle", async () => {
    const w = await world();
    const id = await approved(w);
    const r = await call(`${patternUrl(id)}/rematch`, { ...w.as, method: "POST", body: {} });
    expect(r.status).toBe(409);
  });

  test("the publisher may not approve their own bundle", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const id = created.body.publication.id;
    await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.as, method: "POST", body: {} });

    /* The engineer who published it holds no approve capability at all, so the
       stronger proof is an APPROVER publishing and then approving. */
    const own = await call(`/api/cms/rnd/garment-models/${id}/approve`, {
      ...w.as, method: "POST", body: {},
    });
    expect(own.status).toBe(403);
  });

  test("an approver who published the bundle is still refused their own approval", async () => {
    const w = await world();
    const form = new FormData();
    form.append("webModel", new Blob([namedGlb()], { type: "model/gltf-binary" }), "tee.glb");
    form.append("patterns", new Blob([cloDxf()], { type: "application/dxf" }), "tee.dxf");
    form.append("unit", "in");
    const created = await call(w.styleUrl, { ...w.asApprover, method: "POST", form });
    expect(created.status).toBe(201);
    const id = created.body.publication.id;

    await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.asApprover, method: "POST", body: {} });
    const r = await call(`/api/cms/rnd/garment-models/${id}/approve`, {
      ...w.asApprover, method: "POST", body: {},
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("MODEL_SELF_APPROVAL");
  });
});

/* ═══ 7 · THE PATTERN IS PRIVATE ═══════════════════════════════════════════ */

describe("a DXF is the garment's geometry, and is kept as private as the source", () => {
  test("no response anywhere carries a storage identifier or a provider URL", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const id = created.body.publication.id;
    const read = await call(patternUrl(id), w.as);

    const serialised = JSON.stringify([created.body, read.body]);
    expect(serialised).not.toMatch(/drv-/);
    expect(serialised).not.toMatch(/googleapis|drive\.google|googleusercontent|cloudinary/);
  });

  test("downloading the pattern needs the stronger grant, not merely read", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const id = created.body.publication.id;

    /* An editor may read the workspace and may NOT take the pattern away. */
    const asEditor = await call(`/api/cms/rnd/garment-models/${id}`, w.as);
    expect(asEditor.body.publication.assetUrls.pattern).toBe(null);

    /* An approver may. */
    const asApprover = await call(`/api/cms/rnd/garment-models/${id}`, w.asApprover);
    const url = asApprover.body.publication.assetUrls.pattern.url;
    expect(url).toMatch(/\/asset\/pattern\?t=/);

    const bytes = await call(url, w.asApprover);
    expect(bytes.status).toBe(200);
    expect(bytes.bytes.length).toBe(cloDxf().length);
    expect(bytes.headers.get("x-content-type-options")).toBe("nosniff");
    /* Never inline: a DXF served as its own type is sniffable into markup. */
    expect(bytes.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  test("an editor holding a valid link is still refused the bytes", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const id = created.body.publication.id;
    const asApprover = await call(`/api/cms/rnd/garment-models/${id}`, w.asApprover);
    const url = asApprover.body.publication.assetUrls.pattern.url;

    /* The token proves the link was issued; it is not the authorisation. */
    const r = await call(url, w.as);
    expect(r.status).toBe(403);
  });

  test("another company cannot reach the bundle, and missing and foreign are one answer", async () => {
    const w = await world();
    const other = await world();
    const created = await publish(w, { pattern: true });
    const id = created.body.publication.id;

    const foreign = await call(patternUrl(id), other.as);
    expect(foreign.status).toBe(404);
    const absent = await call(patternUrl(new mongoose.Types.ObjectId()), other.as);
    expect(absent.status).toBe(404);
    expect(foreign.body.error.code).toBe(absent.body.error.code);
    expect(foreign.body.message).toBe(absent.body.message);
  });

  test("somebody with no R&D grant is refused the pattern entirely", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const r = await call(patternUrl(created.body.publication.id), w.asOutsider);
    expect(r.status).toBe(403);
  });
});

/* ═══ 8 · THE HANDOVER TO INDUSTRIAL ENGINEERING ═══════════════════════════ */

describe("IE receives a read-only projection of an approved bundle", () => {
  const handoverUrl = (styleId) =>
    `/api/cms/rnd/garment-models/styles/${styleId}/technical-bundle`;

  test("a draft bundle is absent, and says so as a fact rather than as emptiness", async () => {
    const w = await world();
    await publish(w, { pattern: true });
    const r = await call(handoverUrl(w.style._id), w.as);
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(false);
    expect(r.body.bundle).toBe(null);
    expect(r.body.pieces).toEqual([]);
    expect(r.body.reason).toMatch(/none has been accepted yet/);
  });

  test("an approved bundle projects its three identities, pieces and warnings", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true, fields: { colourway: "Ecru" } });
    const id = created.body.publication.id;
    await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.as, method: "POST", body: {} });
    await call(`/api/cms/rnd/garment-models/${id}/approve`, {
      ...w.asApprover, method: "POST", body: {},
    });

    const r = await call(handoverUrl(w.style._id), w.as);
    expect(r.body.available).toBe(true);
    expect(r.body.readOnly).toBe(true);

    const b = r.body.bundle;
    expect(b.bundleRevision).toBe(1);
    expect(b.colourway).toBe("Ecru");
    expect(b.model.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.pattern.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.pattern.isApparelPattern).toBe(true);
    expect(b.pattern.scaleVerified).toBe(true);
    expect(b.pattern.sizes).toEqual(["M"]);
    expect(b.approvedBy).toBe(w.approver.name);

    expect(r.body.pieces).toHaveLength(5);
    const piece = r.body.pieces[0];
    expect(piece.widthMm).toBeCloseTo(24.7664 * 25.4, 2);
    expect(piece.grainDirection).toBe("lengthwise");
    /* Absent facts stay absent across the boundary. */
    expect(piece.seamAllowance).toBe(null);
    expect(piece.material).toBe("");

    /* Every unresolved finding travels. */
    expect(r.body.unresolvedWarnings.needsReview.map((f) => f.code))
      .toContain("SEAM_ALLOWANCE_UNPUBLISHED");
  });

  test("only CONFIRMED mappings become component names", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const id = created.body.publication.id;
    const read = await call(patternUrl(id), w.as);
    const first = read.body.patternSet.pieces[0].pieceRef;

    await call(`${patternUrl(id)}/mappings`, {
      ...w.as, method: "POST", body: { pieceRef: first, nodeRef: "n1" },
    });
    await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.as, method: "POST", body: {} });
    await call(`/api/cms/rnd/garment-models/${id}/approve`, {
      ...w.asApprover, method: "POST", body: {},
    });

    const r = await call(handoverUrl(w.style._id), w.as);
    const mapped = r.body.pieces.find((p) => p.pieceRef === first);
    expect(mapped.mappedComponent.nodeName).toBe("Front Bodice");
    expect(mapped.mappedComponent.confirmedBy).toBe(w.engineer.name);

    /* And the four nobody confirmed carry no component at all. */
    const others = r.body.pieces.filter((p) => p.pieceRef !== first);
    for (const piece of others) {
      expect(piece.mappedComponent).toBe(null);
      expect(piece.mappingState).toBe("unmapped");
    }
  });

  test("the projection states what it does not derive, and offers no source download", async () => {
    const w = await world();
    const created = await publish(w, { pattern: true });
    const id = created.body.publication.id;
    await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.as, method: "POST", body: {} });
    await call(`/api/cms/rnd/garment-models/${id}/approve`, {
      ...w.asApprover, method: "POST", body: {},
    });

    const r = await call(handoverUrl(w.style._id), w.as);
    expect(r.body.notDerivedHere).toMatch(/Operations, machine allocation, SAM/);
    expect(r.body.notDerivedHere).toMatch(/marker nesting/);
    expect(r.body.patternMeasurements.netAreaIsNotConsumption).toMatch(/not fabric consumption/);

    /* The CLO source is on record and is not reachable from here. */
    expect(r.body.bundle.cloSourceOnRecord).toBe(true);
    expect(r.body.bundle.cloSourceAvailableHere).toBe(false);
    expect(JSON.stringify(r.body)).not.toMatch(/drv-/);
  });

  test("there is no write route on the projection", async () => {
    const w = await world();
    const url = handoverUrl(w.style._id);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const r = await call(url, { ...w.as, method, body: {} });
      expect(r.status).toBe(404);
    }
  });

  test("another company's approved bundle is unreachable", async () => {
    const w = await world();
    const other = await world();
    const created = await publish(w, { pattern: true });
    const id = created.body.publication.id;
    await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.as, method: "POST", body: {} });
    await call(`/api/cms/rnd/garment-models/${id}/approve`, {
      ...w.asApprover, method: "POST", body: {},
    });

    const r = await call(handoverUrl(w.style._id), other.as);
    expect(r.status).toBe(404);
  });
});
