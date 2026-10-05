// test/rnd/garment-model.route.test.js
//
// THE 3D GARMENT WORKSPACE'S SERVER CONTRACT.
//
// ── WHAT THIS SUITE IS REALLY ABOUT ─────────────────────────────────────────
// A viewer that draws a garment is easy to demonstrate and hard to trust. The
// things that decide whether it can carry a technical record are all here and
// none of them are visible on screen:
//
//   · a marker names a NODE in the published file and a point in that node's
//     own frame, so it survives a camera, a reload and a second reader — and a
//     marker naming a part the file does not contain is refused outright;
//   · a marker placed on model 1 never appears on model 2, because the surface
//     may have moved between exports and a pin that followed would be a
//     measurement nobody took;
//   · an unreleased garment has no public URL anywhere, and the link that does
//     exist is useless without a live session;
//   · another company's model does not exist;
//   · a save from a stale screen is refused rather than silently winning.
//
// The Drive is replaced with an in-memory store: what is under test is which
// bytes are accepted, who may read them back and what is recorded about them,
// none of which is a fact about Google.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

/* The Drive, in memory. Byte-for-byte, so a hash check is still a real one.
   Named `mock…` because jest hoists the factory above every other statement in
   this file, and only that prefix is allowed to reach out of its scope. */
const mockDrive = new Map();
jest.mock("../../services/companyDrive.service", () => ({
  uploadCompanyFile: jest.fn(async (buffer, { fileName, mimeType } = {}) => {
    const id = `drv-${mockDrive.size + 1}-${Date.now()}`;
    mockDrive.set(id, { buffer: Buffer.from(buffer), fileName, mimeType });
    /* ── THE SHAPE THE REAL SERVICE RETURNS, EXACTLY ──────────────────────
       `services/companyDrive.service.js` answers `{ driveFileId, mimeType,
       bytes }`. This mock used to answer `{ id, name }`, and the difference
       cost a production defect: the caller guessed at `id`, fell through to
       stringifying the object, and stored "[object Object]" as every file
       handle, so every asset request answered 500. The suite passed
       throughout, because the suite was the only place that shape existed.
       A mock that does not match its subject is a test that proves the mock. */
    return { driveFileId: id, mimeType, bytes: buffer.length };
  }),
  streamCompanyFile: jest.fn(async (id) => {
    const held = mockDrive.get(id);
    if (!held) throw new Error("not found");
    return { stream: require("stream").Readable.from(held.buffer), meta: { mimeType: held.mimeType, size: held.buffer.length } };
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
const { GarmentModelAnnotation } = require("../../models/CMS_Models/RnD/GarmentModel");

let server, base, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "rnd_garment_model" });

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

/* ═══ A REAL GLB, BUILT IN MEMORY ══════════════════════════════════════════
 * The container a browser's loader would accept, so the server's refusals are
 * exercised against the same bytes a CLO export produces rather than against a
 * stub that could never fail the way a real file does.
 */
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

const jacketGlb = ({ triangles = 300, named = true, avatar = false } = {}) => buildGlb({
  asset: { version: "2.0", generator: "CLO Virtual Fashion CLO 7.3.154" },
  scene: 0,
  scenes: [{ nodes: avatar ? [0, 4] : [0] }],
  nodes: [
    { name: "Field Jacket", children: [1, 2, 3] },
    { name: named ? "Left Front Panel" : "Object_11", mesh: 0 },
    { name: named ? "Under Collar" : "Object_12", mesh: 1 },
    { name: named ? "Centre Front Zip" : "Object_13", mesh: 2 },
    ...(avatar ? [{ name: "Avatar", mesh: 0 }] : []),
  ],
  meshes: [
    { name: "Left Front Panel", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
    { name: "Under Collar", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
    { name: "Centre Front Zip", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 1 }] },
  ],
  materials: [{ name: "Waxed canvas" }, { name: "Brass" }],
  accessors: [{ count: triangles }, { count: triangles * 3 }],
});

const call = (path, { token, company, method = "GET", body, form } = {}) =>
  fetch(`${base}${path}`, {
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
  const email = `gm-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "G", lastName: `M${n}`, email, biometricId: `GM${n}`,
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
    companyName: `Halberd ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-GM-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-GM-${n}`, styleCode: `SC-GM-${n}`, productName: "Field Jacket",
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

/**
 * A CLO project file, as far as one can be faked.
 *
 * ── WHY THIS IS NOT THE STRING "CLO PROJECT BYTES" ANY MORE ─────────────────
 * It used to be, and that was a fixture asserting something the product does
 * not promise. The source slot is the one artifact in a bundle kept as evidence
 * and able to reproduce the garment, and it is now validated from its CONTENTS —
 * a GLB, a DXF, a PDF or somebody's notes renamed `.zprj` is refused, and plain
 * text is refused, because a CLO project is not text. A fixture that was plain
 * ASCII could never have been a real `.zprj`, so it tested a path that had to
 * stop existing.
 *
 * A ZIP signature is used because `.zpac` genuinely is a ZIP and a zipped
 * `.zprj` is accepted on its signature. The trailing bytes are opaque on
 * purpose: nothing in the product parses inside a CLO project, and a fixture
 * that pretended to have a readable structure would be claiming a capability
 * that does not exist.
 */
const cloProject = () => Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x14, 0x00, 0x00, 0x00, 0x08, 0x00]),
  crypto.randomBytes(256),
]);

/** Publish one draft through the real multipart route. */
async function publish(w, { glb = jacketGlb(), source = true, fields = {} } = {}) {
  const form = new FormData();
  form.append("webModel", new Blob([glb], { type: "model/gltf-binary" }), "field-jacket.glb");
  if (source) form.append("source", new Blob([cloProject()], { type: "application/octet-stream" }), "field-jacket.zprj");
  form.append("cloVersion", fields.cloVersion ?? "CLO 7.3.154");
  form.append("unit", fields.unit ?? "cm");
  form.append("upAxis", fields.upAxis ?? "Y");
  form.append("handedness", fields.handedness ?? "right");
  form.append("exportedAt", fields.exportedAt ?? "2026-09-28T09:00:00.000Z");
  if (fields.title) form.append("title", fields.title);
  return call(w.styleUrl, { ...w.as, method: "POST", form });
}

/* ═══ 1 · PUBLISHING ═══════════════════════════════════════════════════════ */

describe("publishing a garment model", () => {
  test("the server reads the file, and the manifest is half read and half stated", async () => {
    const w = await world();
    const r = await publish(w);
    expect(r.status).toBe(201);

    const p = r.body.publication;
    /* The business name, never the uploaded filename. */
    expect(p.modelName).toBe("3D model 1");
    expect(p.publicationRef).toMatch(/^GM-[0-9A-F]{10}$/);
    expect(p.state).toBe("DRAFT");

    /* Read out of the bytes. */
    expect(p.manifest.generator).toMatch(/CLO Virtual Fashion/);
    expect(p.manifest.gltfVersion).toBe("2.0");
    expect(p.stats.meshes).toBe(3);
    expect(p.stats.triangles).toBe(900);
    /* Stated by the publisher, because the file cannot know it. */
    expect(p.manifest.unit).toBe("cm");
    expect(p.manifest.upAxis).toBe("Y");
    expect(p.manifest.cloVersion).toBe("CLO 7.3.154");

    /* The pattern pieces, exactly as the export named them. */
    expect(p.structure.filter((n) => n.kind === "mesh").map((n) => n.name).sort())
      .toEqual(["Centre Front Zip", "Left Front Panel", "Under Collar"]);
    expect(p.anchorable).toBe(true);
    expect(p.stats.namedPieces).toBe(3);

    /* Both files are recorded with their content hash. */
    expect(p.files.webModel.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.files.source.name).toBe("field-jacket.zprj");
  });

  test("an export that published no pattern names is accepted and SAYS so", async () => {
    const w = await world();
    const r = await publish(w, { glb: jacketGlb({ named: false }) });
    expect(r.status).toBe(201);
    expect(r.body.publication.anchorable).toBe(false);
    expect(r.body.warnings.map((x) => x.code)).toContain("NO_NAMED_PIECES");
    /* Not a refusal: the model is still worth looking at. What it cannot do
       is carry a construction record, and the publisher is told now. */
    expect(r.body.publication.structure.every((n) => n.kind !== "mesh" || n.generatedName)).toBe(true);
  });

  test("a publication with no CLO source says it cannot be reproduced", async () => {
    const w = await world();
    const r = await publish(w, { source: false });
    expect(r.status).toBe(201);
    expect(r.body.warnings.map((x) => x.code)).toContain("NO_CLO_SOURCE");
    expect(r.body.publication.files.source).toBeNull();
  });

  test("an avatar control is offered only when the file separately contains one", async () => {
    const plain = await world();
    expect((await publish(plain)).body.publication.hasAvatar).toBe(false);

    const dressed = await world();
    const r = await publish(dressed, { glb: jacketGlb({ avatar: true }) });
    expect(r.body.publication.hasAvatar).toBe(true);
    expect(r.body.publication.avatarNodeRefs.length).toBe(1);
  });

  test("model numbers count up per style, and are not storage ids", async () => {
    const w = await world();
    expect((await publish(w)).body.publication.modelNumber).toBe(1);
    expect((await publish(w)).body.publication.modelNumber).toBe(2);
    const list = await call(w.styleUrl, w.asReader);
    expect(list.body.publications.map((p) => p.modelName)).toEqual(["3D model 2", "3D model 1"]);
  });
});

/* ═══ 1b · A REAL EXPORT THAT IS NOT A CLO ONE ════════════════════════════ */

describe("an export from the wild", () => {
  /* Shaped on a real file: one merged mesh called `Object_2`, a Sketchfab
     generator string, and `KHR_materials_pbrSpecularGlossiness` listed as
     REQUIRED — an extension three.js removed, so the garment draws in a
     finish it was not authored in. None of that is a reason to refuse it, and
     all of it changes what the model can be trusted for. */
  const sketchfabGlb = () => buildGlb({
    asset: { version: "2.0", generator: "Sketchfab-16.75.0" },
    extensionsUsed: ["KHR_materials_pbrSpecularGlossiness"],
    extensionsRequired: ["KHR_materials_pbrSpecularGlossiness"],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "Sketchfab_model", children: [1] },
      { name: "Sweater.obj.cleaner.materialmerger.gles", children: [2] },
      { name: "Object_2", mesh: 0 },
    ],
    meshes: [{ name: "Object_2", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ name: "Large_Long_Sleeve_Shirt" }],
    accessors: [{ count: 7424 }, { count: 22272 }],
  });

  test("it is accepted, and every way it falls short is named", async () => {
    const w = await world();
    const r = await publish(w, { glb: sketchfabGlb(), source: false });
    expect(r.status).toBe(201);

    const codes = r.body.warnings.map((x) => x.code);
    /* One merged unlabelled mesh is the more specific complaint, so it is the
       one raised — saying both would be saying the same thing twice. */
    expect(codes).toContain("SINGLE_MESH");
    expect(codes).not.toContain("NO_NAMED_PIECES");
    expect(codes).toContain("MATERIALS_NOT_AS_EXPORTED");
    expect(codes).toContain("NO_CLO_SOURCE");

    const pieces = r.body.warnings.find((x) => x.code === "SINGLE_MESH");
    expect(pieces.message).toMatch(/one unlabelled mesh/i);
    expect(pieces.message).toMatch(/markers will stay in position/i);

    const finish = r.body.warnings.find((x) => x.code === "MATERIALS_NOT_AS_EXPORTED");
    expect(finish.extensions).toEqual(["KHR_materials_pbrSpecularGlossiness"]);
    /* The sentence has to send somebody to a source they can trust instead. */
    expect(finish.message).toMatch(/use the technical pack or approved sample when judging colour/i);

    const p = r.body.publication;
    expect(p.anchorable).toBe(false);
    expect(p.stats.meshes).toBe(1);
    expect(p.stats.namedPieces).toBe(0);
    expect(p.manifest.generator).toBe("Sketchfab-16.75.0");
    expect(p.manifest.extensionsRequired).toEqual(["KHR_materials_pbrSpecularGlossiness"]);
  });

  test("a marker on it still anchors, and still cannot name the piece", async () => {
    const w = await world();
    const created = await publish(w, { glb: sketchfabGlb(), source: false });
    const id = created.body.publication.id;
    const only = created.body.publication.structure.find((n) => n.kind === "mesh");

    const r = await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
      ...w.as, method: "POST", body: marker(only.nodeRef),
    });
    expect(r.status).toBe(201);
    /* The anchor is as stable as any other — a node index does not depend on
       anybody having named it. */
    expect(r.body.annotation.anchor.nodeRef).toBe(only.nodeRef);
    expect(r.body.annotation.anchor.local).toEqual({ x: 0.12, y: 1.43, z: -0.05 });
    /* What is missing is the WORD, and the record says so by carrying the
       exporter's own name rather than inventing a garment one. */
    expect(r.body.annotation.anchor.nodeName).toBe("Object_2");
  });

  test("the warnings survive the upload, for whoever opens it next month", async () => {
    const w = await world();
    const created = await publish(w, { glb: sketchfabGlb(), source: false });
    const read = await call(`/api/cms/rnd/garment-models/${created.body.publication.id}`, w.asReader);
    expect(read.body.publication.warnings.map((x) => x.code)).toContain("MATERIALS_NOT_AS_EXPORTED");
  });
});

/* ═══ 2 · WHAT IS REFUSED, AND WHETHER IT SAYS WHY ═════════════════════════ */

describe("a model that cannot be shown is refused with a reason", () => {
  test("something that is not a GLB at all", async () => {
    const w = await world();
    const r = await publish(w, { glb: Buffer.from("PK\u0003\u0004 this is a zip, not a model") });
    expect(r.status).toBe(415);
    expect(r.body.error.code).toBe("MODEL_UNREADABLE");
    expect(r.body.message).toMatch(/Export the web model from CLO as GLB/);
  });

  test("a truncated upload, which a loader would answer with a blank viewport", async () => {
    const w = await world();
    const whole = jacketGlb();
    const r = await publish(w, { glb: whole.subarray(0, whole.length - 40) });
    expect(r.status).toBe(415);
    expect(r.body.error.details.reason).toBe("GLB_TRUNCATED");
  });

  test("a model too heavy for the machines the sampling room uses", async () => {
    const w = await world();
    const r = await publish(w, { glb: jacketGlb({ triangles: 900000 }) });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("MODEL_TOO_COMPLEX");
    expect(r.body.error.details.triangles).toBe(2700000);
    expect(r.body.message).toMatch(/Decimate it in CLO/);
  });

  test("a source file CLO did not write", async () => {
    const w = await world();
    const form = new FormData();
    form.append("webModel", new Blob([jacketGlb()], { type: "model/gltf-binary" }), "m.glb");
    form.append("source", new Blob([Buffer.from("x")]), "not-a-project.pdf");
    const r = await call(w.styleUrl, { ...w.as, method: "POST", form });
    expect(r.status).toBe(415);
    expect(r.body.error.code).toBe("MODEL_SOURCE_UNSUPPORTED");
  });

  test("a publication with no web model at all", async () => {
    const w = await world();
    const form = new FormData();
    form.append("source", new Blob([Buffer.from("x")]), "p.zprj");
    const r = await call(w.styleUrl, { ...w.as, method: "POST", form });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("MODEL_WEB_FILE_REQUIRED");
  });
});

/* ═══ 3 · NO PUBLIC URL, EVER ══════════════════════════════════════════════ */

describe("an unreleased garment has no public address", () => {
  test("nothing in the response is a storage URL", async () => {
    const w = await world();
    const created = await publish(w);
    const read = await call(`/api/cms/rnd/garment-models/${created.body.publication.id}`, w.as);
    expect(read.status).toBe(200);

    const asText = JSON.stringify(read.body);
    expect(asText).not.toMatch(/drive\.google|googleusercontent|googleapis|cloudinary|https?:\/\//);
    /* The drive object's own id never leaves the server. */
    expect(asText).not.toMatch(/drv-\d/);
    /* What IS returned is a path back into this service, carrying a token. */
    expect(read.body.publication.assetUrls.webModel.url)
      .toMatch(/^\/api\/cms\/rnd\/garment-models\/[0-9a-f]{24}\/asset\/web_model\?t=/);
  });

  test("the link is worthless without a live session", async () => {
    const w = await world();
    const created = await publish(w);
    const read = await call(`/api/cms/rnd/garment-models/${created.body.publication.id}`, w.as);
    const url = read.body.publication.assetUrls.webModel.url;

    /* The token alone is not a bearer grant. */
    expect((await call(url, { company: w.co._id })).status).toBe(401);
    /* And a session alone cannot read an asset by guessing its id. */
    const noToken = url.split("?")[0];
    expect((await call(noToken, w.as)).status).toBe(404);
  });

  test("with both, the real bytes come back as a model a loader will accept", async () => {
    const w = await world();
    const glb = jacketGlb();
    const created = await publish(w, { glb });
    const read = await call(`/api/cms/rnd/garment-models/${created.body.publication.id}`, w.as);

    const r = await call(read.body.publication.assetUrls.webModel.url, w.as);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("model/gltf-binary");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    /* Private: a shared cache must never hold an unreleased garment. */
    expect(r.headers.get("cache-control")).toMatch(/private/);
    expect(Buffer.compare(r.bytes, glb)).toBe(0);
  });

  test("the CLO source needs its own permission, which reading the model is not", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;

    /* An editor may publish it and may not take it away. */
    const asEditor = await call(`/api/cms/rnd/garment-models/${id}`, w.as);
    expect(asEditor.body.publication.assetUrls.source).toBeNull();

    /* An approver answers for the style, and may. */
    const asApprover = await call(`/api/cms/rnd/garment-models/${id}`, w.asApprover);
    expect(asApprover.body.publication.assetUrls.source).toBeTruthy();

    /* And the editor cannot simply replay the approver's link. */
    const stolen = await call(asApprover.body.publication.assetUrls.source.url, w.as);
    expect(stolen.status).toBe(403);
  });
});

/* ═══ 4 · TENANCY ══════════════════════════════════════════════════════════ */

describe("another company's model does not exist", () => {
  test("every route answers 'not found', and nothing is written", async () => {
    const mine = await world();
    const theirs = await world();
    const created = await publish(theirs);
    const id = created.body.publication.id;

    for (const [method, path, body] of [
      ["GET", `/api/cms/rnd/garment-models/${id}`, undefined],
      ["GET", `/api/cms/rnd/garment-models/${id}/annotations`, undefined],
      ["GET", `/api/cms/rnd/garment-models/${id}/timeline`, undefined],
      ["POST", `/api/cms/rnd/garment-models/${id}/submit`, {}],
      ["POST", `/api/cms/rnd/garment-models/${id}/annotations`, { category: "construction", title: "x" }],
    ]) {
      const r = await call(path, { ...mine.as, method, body });
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("NOT_FOUND");
    }
    /* Their style's list is theirs alone. */
    expect((await call(theirs.styleUrl, mine.as)).status).toBe(404);
  });

  test("a Sales grant opens nothing on the R&D mount", async () => {
    const w = await world();
    expect((await call(w.styleUrl, w.asOutsider)).status).toBe(403);
  });

  test("a viewer reads and does not write", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    expect((await call(`/api/cms/rnd/garment-models/${id}`, w.asReader)).status).toBe(200);
    expect((await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
      ...w.asReader, method: "POST", body: { category: "construction", title: "x" },
    })).status).toBe(403);
    expect((await publish({ ...w, as: w.asReader })).status).toBe(403);
  });
});

/* ═══ 4b · THE GRANT IS THE ANSWER, AND IT IS RE-ASKED EVERY TIME ══════════
 *
 * The workspace was unreachable for its first reader, and the reason was not a
 * bug in the viewer: the account had an R&D job title in its sign-in token, an
 * active company, and no R&D grant. Everything on screen looked like it should
 * work. These tests pin the three things that failure taught, so a later
 * convenience cannot quietly undo them:
 *
 *   · a job title is not authority — only the grant is;
 *   · a grant that was taken away is gone on the NEXT request, not in five
 *     minutes, because the role is re-read rather than cached;
 *   · the screen can ask what it may do without being able to do it, so a
 *     refusal is a sentence rather than an empty black canvas.
 */

describe("the grant, and only the grant", () => {
  test("a job title in the sign-in token opens nothing", async () => {
    const w = await world();
    /* Same shape of token as everyone else here — it carries `role: "rnd"` —
       but no row in department_roles. */
    const titled = await person(w.co, {});
    const as = { token: titled.token, company: w.co._id };

    expect((await call(w.styleUrl, as)).status).toBe(403);
    expect((await publish({ ...w, as })).status).toBe(403);
  });

  test("revoking a grant closes the door on the very next request", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    /* Reading works while the grant stands. */
    expect((await call(`/api/cms/rnd/garment-models/${id}`, w.as)).status).toBe(200);

    await DepartmentRole.updateOne(
      { departmentSlug: "research-development", email: w.engineer.email },
      { $set: { isActive: false } },
    );

    /* No sign-out, no token change, no waiting for a cache to expire. */
    expect((await call(`/api/cms/rnd/garment-models/${id}`, w.as)).status).toBe(403);
    expect((await call(w.styleUrl, w.as)).status).toBe(403);
    expect((await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
      ...w.as, method: "POST", body: { category: "construction", title: "x" },
    })).status).toBe(403);
  });

  test("an ungranted reader cannot tell a real style from one that never existed", async () => {
    const w = await world();
    const stranger = { token: (await person(w.co, {})).token, company: w.co._id };
    const real = await call(w.styleUrl, stranger);
    const invented = await call(
      `/api/cms/rnd/garment-models/styles/${new mongoose.Types.ObjectId()}`, stranger);

    /* Byte for byte the same answer. A difference here — a 404 for one and a
       403 for the other — would be a way to enumerate the style book without
       ever being allowed to read it. */
    expect(real.status).toBe(invented.status);
    expect(JSON.stringify(real.body)).toBe(JSON.stringify(invented.body));
  });
});

describe("the workspace asks what it may do before it draws anything", () => {
  const CTX = "/api/cms/rnd/garment-models/context";

  test("an editor is told it may open and annotate, and may not approve", async () => {
    const w = await world();
    const r = await call(CTX, w.as);
    expect(r.status).toBe(200);
    expect(r.body.access).toMatchObject({
      canOpen: true, canAnnotate: true, canPublish: true, canApprove: false,
    });
    /* The company is NAMED, because the refusal screen has to be able to say
       which company it is refusing in — a person who belongs to two reads an
       otherwise identical panel twice. */
    expect(r.body.company.name).toBe(w.co.companyName);
  });

  test("an approver is told it may approve", async () => {
    const w = await world();
    expect((await call(CTX, w.asApprover)).body.access.canApprove).toBe(true);
  });

  test("a viewer is told it may open and change nothing", async () => {
    const w = await world();
    expect((await call(CTX, w.asReader)).body.access).toMatchObject({
      canOpen: true, canAnnotate: false, canPublish: false, canApprove: false,
    });
  });

  test("someone with no grant still gets an answer, so the screen can explain itself", async () => {
    const w = await world();
    const stranger = { token: (await person(w.co, {})).token, company: w.co._id };
    const r = await call(CTX, stranger);
    /* Deliberately NOT behind the R&D capability: a 403 here would leave the
       browser with nothing to render but a black canvas, which is the defect
       this task began with. */
    expect(r.status).toBe(200);
    expect(r.body.access.canOpen).toBe(false);
    expect(r.body.company.name).toBe(w.co.companyName);
  });

  test("nothing in the answer is an internal name", async () => {
    const w = await world();
    const text = JSON.stringify((await call(CTX, w.as)).body);
    /* No capability strings, no middleware vocabulary, no error codes. What
       leaves the server is yes/no and a company name. */
    expect(text).not.toMatch(/rnd\.model\./);
    expect(text).not.toMatch(/capability|minimumRole|FORBIDDEN/i);
  });
});

/* ═══ 5 · MARKERS STAY WHERE THEY WERE PUT ═════════════════════════════════ */

const marker = (nodeRef, extra = {}) => ({
  category: "construction",
  title: "Under-collar seam",
  note: "Topstitch 6mm from the edge, both sides.",
  anchor: {
    nodeRef,
    local: { x: 0.12, y: 1.43, z: -0.05 },
    normal: { x: 0, y: 0, z: 1 },
    triangleIndex: 412,
    primitiveIndex: 0,
  },
  camera: { position: { x: 0, y: 1.5, z: 3 }, target: { x: 0, y: 1.2, z: 0 } },
  construction: { seam: "Under collar to stand", stitchClass: "301", spi: 12, seamAllowanceMm: 6, qualityCritical: true },
  ...extra,
});

describe("a marker is anchored to the garment, not to the screen", () => {
  test("it names a published node and a point in that node's own frame", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    const panel = created.body.publication.structure.find((n) => n.name === "Under Collar");

    const r = await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
      ...w.as, method: "POST", body: marker(panel.nodeRef),
    });
    expect(r.status).toBe(201);
    const a = r.body.annotation;
    expect(a.markerRef).toMatch(/^MK-[0-9A-F]{10}$/);
    expect(a.seq).toBe(1);
    /* The node, by reference AND by the name the file published. */
    expect(a.anchor.nodeRef).toBe(panel.nodeRef);
    expect(a.anchor.nodeName).toBe("Under Collar");
    expect(a.anchor.meshName).toBe("Under Collar");
    expect(a.anchor.triangleIndex).toBe(412);
    /* Nothing about the viewport: no screen x/y anywhere in the record. */
    expect(JSON.stringify(a.anchor)).not.toMatch(/screen|clientX|px/);
    /* The viewpoint, so opening the marker restores what the author saw. */
    expect(a.camera.position).toEqual({ x: 0, y: 1.5, z: 3 });
    /* The structured half, as fields rather than as a sentence. */
    expect(a.construction).toMatchObject({ stitchClass: "301", spi: 12, seamAllowanceMm: 6, qualityCritical: true });
  });

  test("it carries a priority and who else needs to see it, both optional", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    const node = created.body.publication.structure[1].nodeRef;

    /* Most markers are neither urgent nor anybody else's, and say so by
       saying nothing — an empty priority is a real answer. */
    const plain = await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
      ...w.as, method: "POST", body: marker(node),
    });
    expect(plain.body.annotation.priority).toBe("");
    expect(plain.body.annotation.departmentRelevance).toEqual([]);

    const urgent = await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
      ...w.as, method: "POST",
      body: marker(node, {
        title: "Collar rib blocks the first sample",
        category: "stitch_seam",
        priority: "blocker",
        departmentRelevance: ["Industrial-Engineering", "merchandiser", "", "x".repeat(80)],
      }),
    });
    expect(urgent.body.annotation.priority).toBe("blocker");
    expect(urgent.body.annotation.category).toBe("stitch_seam");
    /* Normalised and capped: a slug list is not free text. */
    expect(urgent.body.annotation.departmentRelevance)
      .toEqual(["industrial-engineering", "merchandiser", "x".repeat(40)]);

    /* An invented priority is dropped rather than stored. */
    const nonsense = await call(`/api/cms/rnd/garment-models/annotations/${urgent.body.annotation.id}`, {
      ...w.as, method: "PATCH", body: { priority: "extremely", expectedRevision: 0 },
    });
    expect(nonsense.body.annotation.priority).toBe("");
  });

  test("every category the sampling room uses is accepted", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    const node = created.body.publication.structure[1].nodeRef;

    const categories = ["construction", "measurement", "stitch_seam", "material",
      "print_embroidery", "trim", "fit", "quality", "ie_consideration", "general"];
    for (const category of categories) {
      const r = await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
        ...w.as, method: "POST", body: marker(node, { category, title: `A ${category} note` }),
      });
      expect(r.status).toBe(201);
      expect(r.body.annotation.category).toBe(category);
    }

    const refused = await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
      ...w.as, method: "POST", body: marker(node, { category: "vibes" }),
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details.accepted).toEqual(categories);
  });

  test("a marker naming a part this model does not contain is refused", async () => {
    const w = await world();
    const created = await publish(w);
    const r = await call(`/api/cms/rnd/garment-models/${created.body.publication.id}/annotations`, {
      ...w.as, method: "POST", body: marker("n999"),
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("MODEL_ANCHOR_UNKNOWN");
    expect(await GarmentModelAnnotation.countDocuments({})).toBe(0);
  });

  test("a marker with no position on the garment is refused", async () => {
    const w = await world();
    const created = await publish(w);
    const node = created.body.publication.structure[1].nodeRef;
    const r = await call(`/api/cms/rnd/garment-models/${created.body.publication.id}/annotations`, {
      ...w.as, method: "POST",
      body: { ...marker(node), anchor: { nodeRef: node } },
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("MODEL_ANCHOR_INVALID");
  });

  test("control characters never reach the stored note", async () => {
    const w = await world();
    const created = await publish(w);
    const node = created.body.publication.structure[1].nodeRef;
    const r = await call(`/api/cms/rnd/garment-models/${created.body.publication.id}/annotations`, {
      ...w.as, method: "POST",
      body: marker(node, { title: "Seam\u0000\u001b[31m hidden", note: "line\u0007one" }),
    });
    expect(r.status).toBe(201);
    expect(r.body.annotation.title).not.toMatch(/[\u0000\u0007\u001b]/);
    expect(r.body.annotation.note).toBe("lineone");
  });
});

/* ═══ 5b · WHAT A SAVE AND A RELOAD HAVE TO PRESERVE ══════════════════════ */

describe("a marker survives being saved and read back", () => {
  test("every field comes back byte for byte, on a fresh read", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    const node = created.body.publication.structure.find((n) => n.kind === "mesh").nodeRef;

    const sent = marker(node, {
      title: "Neck rib 2x2, 30 mm finished",
      category: "stitch_seam",
      priority: "high",
      departmentRelevance: ["industrial-engineering"],
      note: "Set the rib with a 4-thread overlock, then coverstitch.",
    });
    const made = await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
      ...w.as, method: "POST", body: sent,
    });
    expect(made.status).toBe(201);

    /* Read back through the list route, which is what a reloaded page uses —
       not the create response it already had. */
    const reloaded = (await call(`/api/cms/rnd/garment-models/${id}/annotations`, w.asReader))
      .body.annotations.find((a) => a.markerRef === made.body.annotation.markerRef);

    expect(reloaded.title).toBe(sent.title);
    expect(reloaded.category).toBe("stitch_seam");
    expect(reloaded.priority).toBe("high");
    expect(reloaded.departmentRelevance).toEqual(["industrial-engineering"]);
    expect(reloaded.note).toBe(sent.note);
    expect(reloaded.construction).toMatchObject({ stitchClass: "301", spi: 12, seamAllowanceMm: 6 });
  });

  test("the anchor is the same node and the same point, to the last decimal", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    const node = created.body.publication.structure.find((n) => n.kind === "mesh").nodeRef;

    /* Deliberately awkward numbers: a float that survives a round trip by
       luck is not a float that survived a round trip. */
    const local = { x: -0.4995239973068237, y: -0.03162400051951408, z: 1.0819839984178543 };
    const normal = { x: 0.6524544959385841, y: -0.6087834127366952, z: 0.4513157288486529 };
    const made = await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
      ...w.as, method: "POST",
      body: { ...marker(node), anchor: { nodeRef: node, local, normal, triangleIndex: 5170, primitiveIndex: 0 } },
    });

    const back = (await call(`/api/cms/rnd/garment-models/${id}/annotations`, w.asReader))
      .body.annotations.find((a) => a.markerRef === made.body.annotation.markerRef);

    expect(back.anchor.nodeRef).toBe(node);
    expect(back.anchor.local).toEqual(local);
    expect(back.anchor.normal).toEqual(normal);
    expect(back.anchor.triangleIndex).toBe(5170);
    /* And the saved viewpoint, which is what makes "open the marker" work. */
    expect(back.camera.position).toEqual({ x: 0, y: 1.5, z: 3 });
    expect(back.camera.target).toEqual({ x: 0, y: 1.2, z: 0 });
  });

  test("an edit is recorded without losing what was there before it", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    const node = created.body.publication.structure.find((n) => n.kind === "mesh").nodeRef;
    const made = await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
      ...w.as, method: "POST", body: marker(node),
    });
    const annotationId = made.body.annotation.id;

    await call(`/api/cms/rnd/garment-models/annotations/${annotationId}`, {
      ...w.as, method: "PATCH",
      body: { expectedRevision: 0, note: "Re-measured on 1 Oct: still 72 mm." },
    });
    const edited = (await call(`/api/cms/rnd/garment-models/${id}/annotations`, w.asReader))
      .body.annotations[0];

    expect(edited.note).toBe("Re-measured on 1 Oct: still 72 mm.");
    /* The anchor is not something an edit may move. */
    expect(edited.anchor.local).toEqual(made.body.annotation.anchor.local);
    /* And the history says both things happened. */
    expect(edited.events.map((e) => e.kind)).toEqual(["created", "edited"]);
  });

  test("resolving keeps the note, its author and everything that happened to it", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    const node = created.body.publication.structure.find((n) => n.kind === "mesh").nodeRef;
    const made = await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
      ...w.as, method: "POST", body: marker(node),
    });
    await call(`/api/cms/rnd/garment-models/annotations/${made.body.annotation.id}/replies`, {
      ...w.as, method: "POST", body: { body: "Agreed on the sample." },
    });
    await call(`/api/cms/rnd/garment-models/annotations/${made.body.annotation.id}`, {
      ...w.as, method: "PATCH", body: { status: "resolved", statusNote: "Settled at the fit session." },
    });

    const after = (await call(`/api/cms/rnd/garment-models/${id}/annotations`, w.asReader))
      .body.annotations[0];
    expect(after.status).toBe("resolved");
    /* Resolving is not deleting: the note, the reply and the record of both
       are all still there, which is what makes it an audit trail. */
    expect(after.title).toBe(made.body.annotation.title);
    expect(after.note).toBe(made.body.annotation.note);
    expect(after.replies).toHaveLength(1);
    expect(after.events.map((e) => e.kind)).toEqual(["created", "replied", "status:resolved"]);
    expect(after.events.find((e) => e.kind === "status:resolved").note)
      .toBe("Settled at the fit session.");
  });
});

/* ═══ 5c · WHAT A VIEWER MAY NOT DO ═══════════════════════════════════════ */

describe("a viewer reads and changes nothing", () => {
  test("create, edit, resolve and reply are all refused", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    const node = created.body.publication.structure.find((n) => n.kind === "mesh").nodeRef;
    const made = await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
      ...w.as, method: "POST", body: marker(node),
    });
    const annotationId = made.body.annotation.id;

    const refusals = {
      create: await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
        ...w.asReader, method: "POST", body: marker(node, { title: "not mine to add" }),
      }),
      edit: await call(`/api/cms/rnd/garment-models/annotations/${annotationId}`, {
        ...w.asReader, method: "PATCH", body: { note: "not mine to change" },
      }),
      resolve: await call(`/api/cms/rnd/garment-models/annotations/${annotationId}`, {
        ...w.asReader, method: "PATCH", body: { status: "resolved" },
      }),
      reply: await call(`/api/cms/rnd/garment-models/annotations/${annotationId}/replies`, {
        ...w.asReader, method: "POST", body: { body: "not mine to say" },
      }),
      submit: await call(`/api/cms/rnd/garment-models/${id}/submit`, {
        ...w.asReader, method: "POST", body: {},
      }),
      publish: await publish({ ...w, as: w.asReader }),
    };
    for (const [what, r] of Object.entries(refusals)) {
      expect([what, r.status]).toEqual([what, 403]);
    }

    /* There is no delete route at all — a marker is a record. */
    const deleted = await call(`/api/cms/rnd/garment-models/annotations/${annotationId}`, {
      ...w.as, method: "DELETE",
    });
    expect(deleted.status).toBe(404);

    /* And nothing moved. */
    const after = await call(`/api/cms/rnd/garment-models/${id}/annotations`, w.asReader);
    expect(after.body.annotations).toHaveLength(1);
    expect(after.body.annotations[0].note).toBe(made.body.annotation.note);
    expect(after.body.annotations[0].status).toBe("open");
    expect(after.body.annotations[0].replies).toHaveLength(0);
  });
});

/* ═══ 6 · A MARKER BELONGS TO ONE MODEL ════════════════════════════════════ */

describe("markers do not follow the garment to a new export", () => {
  test("a marker on model 1 is not shown on model 2", async () => {
    const w = await world();
    const first = await publish(w);
    const firstId = first.body.publication.id;
    const node = first.body.publication.structure.find((n) => n.name === "Under Collar").nodeRef;
    await call(`/api/cms/rnd/garment-models/${firstId}/annotations`, {
      ...w.as, method: "POST", body: marker(node),
    });

    const second = await publish(w);
    const secondId = second.body.publication.id;
    expect(second.body.publication.modelNumber).toBe(2);

    const onSecond = await call(`/api/cms/rnd/garment-models/${secondId}/annotations`, w.asReader);
    expect(onSecond.body.annotations).toHaveLength(0);

    const onFirst = await call(`/api/cms/rnd/garment-models/${firstId}/annotations`, w.asReader);
    expect(onFirst.body.annotations).toHaveLength(1);
    expect(onFirst.body.annotations[0].modelNumber).toBe(1);

    /* And the list says which model each marker count belongs to. */
    const list = await call(w.styleUrl, w.asReader);
    const byNumber = Object.fromEntries(list.body.publications.map((p) => [p.modelNumber, p.markers.total]));
    expect(byNumber).toEqual({ 1: 1, 2: 0 });
  });
});

/* ═══ 7 · A STALE SCREEN DOES NOT WIN ══════════════════════════════════════ */

describe("stale responses are inert", () => {
  test("a save carrying an old revision is refused rather than overwriting", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    const node = created.body.publication.structure[1].nodeRef;
    const made = await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
      ...w.as, method: "POST", body: marker(node),
    });
    const annotationId = made.body.annotation.id;

    const first = await call(`/api/cms/rnd/garment-models/annotations/${annotationId}`, {
      ...w.as, method: "PATCH", body: { expectedRevision: 0, note: "Winner." },
    });
    expect(first.status).toBe(200);
    expect(first.body.annotation.revision).toBe(1);

    /* A second screen, still holding revision 0. */
    const stale = await call(`/api/cms/rnd/garment-models/annotations/${annotationId}`, {
      ...w.as, method: "PATCH", body: { expectedRevision: 0, note: "Loser." },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("REVISION_CONFLICT");

    const after = await call(`/api/cms/rnd/garment-models/${id}/annotations`, w.asReader);
    expect(after.body.annotations[0].note).toBe("Winner.");
  });

  test("the same rule guards the publication's own lifecycle", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    expect((await call(`/api/cms/rnd/garment-models/${id}/submit`, {
      ...w.as, method: "POST", body: { expectedRevision: 7 },
    })).status).toBe(409);
  });
});

/* ═══ 8 · THE LIFECYCLE, AND WHO DECIDES ═══════════════════════════════════ */

describe("review and acceptance", () => {
  test("the publisher cannot accept their own model", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.as, method: "POST", body: {} });

    /* An editor has no approve capability at all… */
    expect((await call(`/api/cms/rnd/garment-models/${id}/approve`, {
      ...w.as, method: "POST", body: {},
    })).status).toBe(403);

    /* …and an approver who published it is refused by name. */
    const selfPublished = await world();
    const own = await call(selfPublished.styleUrl, {
      ...selfPublished.asApprover, method: "POST",
      form: (() => {
        const f = new FormData();
        f.append("webModel", new Blob([jacketGlb()], { type: "model/gltf-binary" }), "m.glb");
        return f;
      })(),
    });
    await call(`/api/cms/rnd/garment-models/${own.body.publication.id}/submit`,
      { ...selfPublished.asApprover, method: "POST", body: {} });
    const selfApproval = await call(`/api/cms/rnd/garment-models/${own.body.publication.id}/approve`,
      { ...selfPublished.asApprover, method: "POST", body: {} });
    expect(selfApproval.status).toBe(409);
    expect(selfApproval.body.error.code).toBe("MODEL_SELF_APPROVAL");
  });

  test("a second person accepts it, and the previous approved model is superseded", async () => {
    const w = await world();
    const one = await publish(w);
    await call(`/api/cms/rnd/garment-models/${one.body.publication.id}/submit`, { ...w.as, method: "POST", body: {} });
    const approvedOne = await call(`/api/cms/rnd/garment-models/${one.body.publication.id}/approve`,
      { ...w.asApprover, method: "POST", body: { note: "Accepted for sampling." } });
    expect(approvedOne.status).toBe(200);
    expect(approvedOne.body.publication.state).toBe("APPROVED");

    const two = await publish(w);
    await call(`/api/cms/rnd/garment-models/${two.body.publication.id}/submit`, { ...w.as, method: "POST", body: {} });
    await call(`/api/cms/rnd/garment-models/${two.body.publication.id}/approve`,
      { ...w.asApprover, method: "POST", body: {} });

    const list = await call(w.styleUrl, w.asReader);
    const states = Object.fromEntries(list.body.publications.map((p) => [p.modelNumber, p.state]));
    expect(states).toEqual({ 1: "SUPERSEDED", 2: "APPROVED" });
    /* "The current approved model" has exactly one answer. */
    expect(list.body.currentApprovedRef).toBe(two.body.publication.publicationRef);
  });

  test("an accepted model stops being a workspace", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    const node = created.body.publication.structure[1].nodeRef;
    await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.as, method: "POST", body: {} });
    await call(`/api/cms/rnd/garment-models/${id}/approve`, { ...w.asApprover, method: "POST", body: {} });

    const late = await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
      ...w.as, method: "POST", body: marker(node),
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("MODEL_STATE_CONFLICT");
    expect(late.body.message).toMatch(/Publish a new model/);
  });

  test("returning it reopens the draft without losing the markers", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    const node = created.body.publication.structure[1].nodeRef;
    await call(`/api/cms/rnd/garment-models/${id}/annotations`, { ...w.as, method: "POST", body: marker(node) });
    await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.as, method: "POST", body: {} });

    const returned = await call(`/api/cms/rnd/garment-models/${id}/return`,
      { ...w.asApprover, method: "POST", body: { note: "Collar seam is ambiguous." } });
    expect(returned.status).toBe(200);
    expect(returned.body.publication.state).toBe("RETURNED");
    expect(returned.body.publication.decisionNote).toBe("Collar seam is ambiguous.");

    expect((await call(`/api/cms/rnd/garment-models/${id}/annotations`, w.asReader))
      .body.annotations).toHaveLength(1);
    /* And R&D can work on it again. */
    expect((await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.as, method: "POST", body: {} })).status).toBe(200);
  });
});

/* ═══ 9 · THE TIMELINE ═════════════════════════════════════════════════════ */

describe("the development timeline", () => {
  test("model events and marker events are one sequence, each able to restore a view", async () => {
    const w = await world();
    const created = await publish(w, { fields: { title: "Field jacket, AW26" } });
    const id = created.body.publication.id;
    const node = created.body.publication.structure.find((n) => n.name === "Under Collar").nodeRef;

    const made = await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
      ...w.as, method: "POST", body: marker(node),
    });
    await call(`/api/cms/rnd/garment-models/annotations/${made.body.annotation.id}/replies`, {
      ...w.as, method: "POST", body: { body: "Agreed, 6mm." },
    });
    await call(`/api/cms/rnd/garment-models/annotations/${made.body.annotation.id}`, {
      ...w.as, method: "PATCH", body: { status: "resolved", statusNote: "Settled on the sample." },
    });
    await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.as, method: "POST", body: {} });

    const t = await call(`/api/cms/rnd/garment-models/${id}/timeline`, w.asReader);
    expect(t.status).toBe(200);
    expect(t.body.events.map((e) => e.kind)).toEqual([
      "model:published", "marker:created", "marker:replied", "marker:status:resolved", "model:submitted",
    ]);
    /* A marker row carries the handle the viewer needs to go back to it. */
    const markerRow = t.body.events.find((e) => e.kind === "marker:created");
    expect(markerRow.annotationId).toBe(made.body.annotation.id);
    expect(markerRow.markerRef).toBe(made.body.annotation.markerRef);
    /* Chronological, so the lower panel reads as the work actually went. */
    const times = t.body.events.map((e) => new Date(e.at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  test("a marker joins the approved pack only once the model is accepted", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    const node = created.body.publication.structure[1].nodeRef;
    const made = await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
      ...w.as, method: "POST", body: marker(node),
    });

    const tooEarly = await call(`/api/cms/rnd/garment-models/annotations/${made.body.annotation.id}`, {
      ...w.as, method: "PATCH", body: { status: "in_approved_pack" },
    });
    expect(tooEarly.status).toBe(409);

    await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.as, method: "POST", body: {} });
    await call(`/api/cms/rnd/garment-models/${id}/approve`, { ...w.asApprover, method: "POST", body: {} });

    const now = await call(`/api/cms/rnd/garment-models/annotations/${made.body.annotation.id}`, {
      ...w.as, method: "PATCH", body: { status: "in_approved_pack" },
    });
    expect(now.status).toBe(200);
    expect(now.body.annotation.status).toBe("in_approved_pack");
  });
});

/* ═══ 10 · MEASUREMENTS ════════════════════════════════════════════════════
 *
 * The whole risk in a 3D measuring tool is that it always produces a number.
 * Three.js will tell you the distance between any two points to fifteen
 * decimal places whether or not the file is drawn at any particular scale, and
 * whether or not the line between them goes straight through the garment. So
 * these tests are mostly about what the server REFUSES to call a centimetre,
 * and what it refuses to call a surface measurement.
 */

/** A point on the published jacket. */
const at = (x, y, z, nodeRef = "n1") => ({
  nodeRef, local: { x, y, z }, world: { x, y, z },
});

const measureUrl = (id) => `/api/cms/rnd/garment-models/${id}/measurements`;
const oneUrl = (id) => `/api/cms/rnd/garment-models/measurements/${id}`;

/**
 * A quarter-circle of radius 1 in the xz plane, as a route of `n` points.
 *
 * Its length is π/2 ≈ 1.5708 and the straight line between its two ends is
 * √2 ≈ 1.4142. Every surface test below is the difference between those two
 * numbers, because that difference IS the feature.
 */
const arcRoute = (n = 24) => Array.from({ length: n + 1 }, (_, i) => {
  const a = (i / n) * (Math.PI / 2);
  return at(Math.cos(a), 0, Math.sin(a));
});
const ARC_LENGTH = Math.PI / 2;
const ARC_CHORD = Math.SQRT2;

async function measured(w, body, who = w.as) {
  const created = await publish(w);
  const id = created.body.publication.id;
  const r = await call(measureUrl(id), { ...who, method: "POST", body });
  return { id, r };
}

describe("a measurement is taken from points, and the server does the arithmetic", () => {
  test("a straight distance is the line between two points", async () => {
    const w = await world();
    const { r } = await measured(w, {
      kind: "distance", name: "Chest width, flat",
      points: [at(0, 0, 0), at(3, 4, 0)],
    });
    expect(r.status).toBe(201);
    /* 3-4-5. Computed here, not sent: the request carried no value at all. */
    expect(r.body.measurement.rawValue).toBeCloseTo(5, 10);
    expect(r.body.measurement.kind).toBe("distance");
    expect(r.body.measurement.followsSurface).toBe(false);
    expect(r.body.measurement.status).toBe("draft");
  });

  test("a value in the request is ignored — the points are the measurement", async () => {
    const w = await world();
    const { r } = await measured(w, {
      kind: "distance", name: "Placket length", rawValue: 999, displayValue: 999,
      points: [at(0, 0, 0), at(0, 0, 2)],
    });
    expect(r.body.measurement.rawValue).toBeCloseTo(2, 10);
  });

  test("an angle is the angle at the middle point, in degrees", async () => {
    const w = await world();
    const { r } = await measured(w, {
      kind: "angle", name: "Collar break angle",
      points: [at(1, 0, 0), at(0, 0, 0), at(0, 1, 0)],
    });
    expect(r.status).toBe(201);
    expect(r.body.measurement.rawValue).toBeCloseTo(90, 9);
    expect(r.body.measurement.displayUnit).toBe("°");
  });

  test("each kind refuses the wrong number of points, and says what it needs", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    for (const [kind, points] of [
      ["distance", [at(0, 0, 0)]],
      ["distance", [at(0, 0, 0), at(1, 0, 0), at(2, 0, 0)]],
      ["surface", [at(0, 0, 0)]],
      ["angle", [at(0, 0, 0), at(1, 0, 0)]],
      ["path", [at(0, 0, 0)]],
    ]) {
      const r = await call(measureUrl(id), {
        ...w.as, method: "POST", body: { kind, name: "x", points },
      });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe("MODEL_MEASUREMENT_INVALID");
    }
  });

  test("a point on a part this model does not contain is refused", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    const r = await call(measureUrl(id), {
      ...w.as, method: "POST",
      body: { kind: "distance", name: "x", points: [at(0, 0, 0), at(1, 0, 0, "n99")] },
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("MODEL_ANCHOR_UNKNOWN");
  });

  test("two points in the same place are refused rather than answered zero", async () => {
    const w = await world();
    const { r } = await measured(w, {
      kind: "distance", name: "x", points: [at(1, 1, 1), at(1, 1, 1)],
    });
    expect(r.status).toBe(422);
  });
});

/* ═══ 10a · THE MEASUREMENT THAT FOLLOWS THE CLOTH ════════════════════════
 *
 * The defect this whole mode exists to prevent: a neckline measured as a line
 * through space is a chord across the neck hole. It reads SHORT, and short is
 * the dangerous direction, because a pattern cut to it does not fit.
 */

describe("a surface measurement is its route, not the line between its ends", () => {
  test("it reads the route's length, not the distance between the two points", async () => {
    const w = await world();
    const route = arcRoute();
    const { r } = await measured(w, {
      kind: "surface", name: "Front neckline curve",
      points: [route[0], route[route.length - 1]],
      surfacePath: route,
    });
    expect(r.status).toBe(201);
    const m = r.body.measurement;

    expect(m.rawValue).toBeCloseTo(ARC_LENGTH, 2);
    /* The number that would have been wrong. */
    expect(m.rawValue).toBeGreaterThan(ARC_CHORD * 1.08);
    expect(m.followsSurface).toBe(true);
  });

  test("the route is stored, so a reader draws the same line next month", async () => {
    const w = await world();
    const route = arcRoute(12);
    const { id, r } = await measured(w, {
      kind: "surface", name: "Armhole front half",
      points: [route[0], route[route.length - 1]],
      surfacePath: route,
    });
    expect(r.body.measurement.surfacePath).toHaveLength(13);

    /* And it comes back on a fresh read, point for point. */
    const list = await call(measureUrl(id), w.as);
    const stored = list.body.measurements[0];
    expect(stored.surfacePath).toHaveLength(13);
    expect(stored.surfacePath[6].local.x).toBeCloseTo(route[6].local.x, 12);
    expect(stored.rawValue).toBe(r.body.measurement.rawValue);
  });

  test("a surface measurement with no route is refused, never quietly straightened", async () => {
    /* The one failure mode that would make the feature a lie: accepting the
       two endpoints and returning the chord under a surface measurement's
       name. It is refused instead. */
    const w = await world();
    const { r } = await measured(w, {
      kind: "surface", name: "Neckline", points: [at(1, 0, 0), at(0, 0, 1)],
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("MODEL_MEASUREMENT_INVALID");
    expect(r.body.error.message).toMatch(/no route across the garment/i);
  });

  test("a route naming a part the model does not contain is refused", async () => {
    const w = await world();
    const route = arcRoute(6);
    route[3] = at(0.7, 0, 0.7, "n99");
    const { r } = await measured(w, {
      kind: "surface", name: "Neckline",
      points: [route[0], route[route.length - 1]], surfacePath: route,
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("MODEL_ANCHOR_UNKNOWN");
  });

  test("a guided path sums the surface length of every leg", async () => {
    const w = await world();
    const route = arcRoute(24);
    const { r } = await measured(w, {
      kind: "path", name: "Collar attachment edge",
      /* Three points the person placed, and the route the viewer walked
         between them. */
      points: [route[0], route[12], route[24]],
      surfacePath: route,
    });
    expect(r.status).toBe(201);
    expect(r.body.measurement.rawValue).toBeCloseTo(ARC_LENGTH, 2);
    expect(r.body.measurement.followsSurface).toBe(true);
    /* It is never described as a seam unless somebody classified it as one. */
    expect(r.body.measurement.category).toBe("general");
  });

  test("a straight distance stores no route — its points are its line", async () => {
    const w = await world();
    const { r } = await measured(w, {
      kind: "distance", name: "Across the opening",
      points: [at(0, 0, 0), at(0, 0, 2)],
      surfacePath: arcRoute(6),
    });
    expect(r.body.measurement.surfacePath).toEqual([]);
    expect(r.body.measurement.rawValue).toBeCloseTo(2, 10);
  });
});

/* ═══ 10b · A NAME SOMEBODY CHOSE ════════════════════════════════════════ */

describe("a measurement is named before it is kept", () => {
  test("it cannot be saved without a name", async () => {
    const w = await world();
    const { r } = await measured(w, { kind: "distance", points: [at(0, 0, 0), at(0, 0, 2)] });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/name/i);
  });

  test("the suggested default is refused rather than accepted silently", async () => {
    /* "Measurement 1" in a rail of nine tells a reader nothing. The default
       exists to be replaced, so saving it unchanged is the one case worth
       catching. */
    const w = await world();
    const { r } = await measured(w, {
      kind: "distance", name: "Measurement 1", points: [at(0, 0, 0), at(0, 0, 2)],
    });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/Replace the suggested name/i);
  });

  test("everything a point of measure needs is kept beside it", async () => {
    const w = await world();
    const { r } = await measured(w, {
      kind: "distance", name: "Chest 1cm below armhole",
      category: "point_of_measure",
      points: [at(0, 0, 0), at(0, 0, 2)],
      note: "Measured flat, across.",
      linkedTechnicalItem: { kind: "pom", ref: "POM-014", label: "Chest width" },
      intendedSize: "M",
      toleranceMm: 5,
    });
    const m = r.body.measurement;
    expect(m.name).toBe("Chest 1cm below armhole");
    expect(m.category).toBe("point_of_measure");
    expect(m.linkedTechnicalItem.ref).toBe("POM-014");
    expect(m.intendedSize).toBe("M");
    expect(m.toleranceMm).toBe(5);
    /* Absent is an absent tolerance, never a zero one. */
    const plain = await measured(w, {
      kind: "distance", name: "Hem width", points: [at(0, 0, 0), at(0, 0, 3)],
    });
    expect(plain.r.body.measurement.toleranceMm).toBeNull();
  });

  test("it can be renamed while it is still a draft", async () => {
    const w = await world();
    const { r } = await measured(w, {
      kind: "distance", name: "Neck drop", points: [at(0, 0, 0), at(0, 0, 2)],
    });
    const m = r.body.measurement;
    const patched = await call(oneUrl(m.id), {
      ...w.as, method: "PATCH", body: { name: "Front neck drop", expectedRevision: m.revision },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.measurement.name).toBe("Front neck drop");
  });
});

/* ═══ 10c · WHAT IT WILL AND WILL NOT CALL A CENTIMETRE ══════════════════ */

describe("scale honesty", () => {
  test("an export that declared a unit is labelled as the exporter's claim", async () => {
    const w = await world();
    const { r } = await measured(w, {
      kind: "distance", name: "Shoulder to shoulder", points: [at(0, 0, 0), at(2, 0, 0)],
    });
    const m = r.body.measurement;
    /* `publish` states unit "cm", so the file says so and nobody has checked. */
    expect(m.scale.state).toBe("declared");
    expect(m.displayValue).toBeCloseTo(2, 10);
    expect(m.displayUnit).toBe("cm");
  });

  test("an export that declared nothing yields a raw figure and NO unit", async () => {
    const w = await world();
    const created = await publish(w, { fields: { unit: "" } });
    const id = created.body.publication.id;
    const r = await call(measureUrl(id), {
      ...w.as, method: "POST",
      body: { kind: "distance", name: "Sleeve length", points: [at(0, 0, 0), at(2, 0, 0)] },
    });
    const m = r.body.measurement;
    expect(m.scale.state).toBe("unverified");
    expect(m.rawValue).toBeCloseTo(2, 10);
    expect(m.rawUnit).toBe("model units");
    expect(m.displayValue).toBeNull();
    expect(m.displayUnit).toBe("");
  });

  test("an unverified scale does not stop a SURFACE measurement being taken", async () => {
    /* Placement and visual comparison stay available; only the claim to a
       centimetre is withheld. */
    const w = await world();
    const created = await publish(w, { fields: { unit: "" } });
    const id = created.body.publication.id;
    const route = arcRoute();
    const r = await call(measureUrl(id), {
      ...w.as, method: "POST",
      body: {
        kind: "surface", name: "Neckline curve",
        points: [route[0], route[route.length - 1]], surfacePath: route,
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.measurement.rawValue).toBeCloseTo(ARC_LENGTH, 2);
    expect(r.body.measurement.displayValue).toBeNull();
  });

  test("an angle carries no scale warning, because an angle has no units", async () => {
    const w = await world();
    const created = await publish(w, { fields: { unit: "" } });
    const id = created.body.publication.id;
    const r = await call(measureUrl(id), {
      ...w.as, method: "POST",
      body: { kind: "angle", name: "Vent angle", points: [at(1, 0, 0), at(0, 0, 0), at(0, 1, 0)] },
    });
    const m = r.body.measurement;
    expect(m.scaleIndependent).toBe(true);
    expect(m.displayValue).toBeCloseTo(90, 9);
    expect(m.displayUnit).toBe("°");
  });
});

/* ═══ 10d · CALIBRATION ══════════════════════════════════════════════════ */

const calUrl = (id) => `/api/cms/rnd/garment-models/${id}/scale-calibration`;

describe("calibration is what lets this claim a millimetre", () => {
  test("two known points give a factor, and later measurements are verified", async () => {
    const w = await world();
    const created = await publish(w, { fields: { unit: "" } });
    const id = created.body.publication.id;

    const cal = await call(calUrl(id), {
      ...w.as, method: "PUT",
      body: { points: [at(0, 0, 0), at(10, 0, 0)], knownValue: 25, unit: "cm" },
    });
    expect(cal.status).toBe(200);
    expect(cal.body.calibration.factor).toBeCloseTo(2.5, 10);
    expect(cal.body.scale.state).toBe("verified");
    expect(cal.body.calibration.by).toBe(w.engineer.name);

    const r = await call(measureUrl(id), {
      ...w.as, method: "POST",
      body: { kind: "distance", name: "Cuff opening", points: [at(0, 0, 0), at(4, 0, 0)] },
    });
    const m = r.body.measurement;
    expect(m.scale.state).toBe("verified");
    expect(m.scale.calibratedBy).toBe(w.engineer.name);
    expect(m.displayValue).toBeCloseTo(10, 10);
    expect(m.displayUnit).toBe("cm");
  });

  test("a calibrated surface measurement converts its ROUTE, not its chord", async () => {
    const w = await world();
    const created = await publish(w, { fields: { unit: "" } });
    const id = created.body.publication.id;
    await call(calUrl(id), {
      ...w.as, method: "PUT",
      body: { points: [at(0, 0, 0), at(10, 0, 0)], knownValue: 25, unit: "cm" },
    });
    const route = arcRoute();
    const r = await call(measureUrl(id), {
      ...w.as, method: "POST",
      body: {
        kind: "surface", name: "Neckline curve",
        points: [route[0], route[route.length - 1]], surfacePath: route,
      },
    });
    const m = r.body.measurement;
    expect(m.displayValue).toBeCloseTo(ARC_LENGTH * 2.5, 2);
    expect(m.displayValue).toBeGreaterThan(ARC_CHORD * 2.5 * 1.08);
  });

  test("calibrating afterwards does not relabel a number already written down", async () => {
    const w = await world();
    const created = await publish(w, { fields: { unit: "" } });
    const id = created.body.publication.id;

    const before = (await call(measureUrl(id), {
      ...w.as, method: "POST",
      body: { kind: "distance", name: "Back length", points: [at(0, 0, 0), at(4, 0, 0)] },
    })).body.measurement;
    expect(before.scale.state).toBe("unverified");

    await call(calUrl(id), {
      ...w.as, method: "PUT",
      body: { points: [at(0, 0, 0), at(10, 0, 0)], knownValue: 25, unit: "cm" },
    });

    const list = await call(measureUrl(id), w.as);
    const kept = list.body.measurements.find((x) => x.id === before.id);
    expect(kept.scale.state).toBe("unverified");
    expect(kept.displayValue).toBeNull();
    expect(list.body.scale.state).toBe("verified");
  });

  test("calibration never follows the garment to the next export", async () => {
    const w = await world();
    const first = await publish(w, { fields: { unit: "" } });
    const firstId = first.body.publication.id;
    await call(calUrl(firstId), {
      ...w.as, method: "PUT",
      body: { points: [at(0, 0, 0), at(10, 0, 0)], knownValue: 25, unit: "cm" },
    });
    expect((await call(measureUrl(firstId), w.as)).body.scale.state).toBe("verified");

    const second = await publish(w, { fields: { unit: "" } });
    const list = await call(measureUrl(second.body.publication.id), w.as);
    expect(list.body.calibration).toBeNull();
    expect(list.body.scale.state).toBe("unverified");
  });

  test("it refuses a calibration that says nothing usable", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    for (const body of [
      { points: [at(0, 0, 0), at(10, 0, 0)], knownValue: 25 },
      { points: [at(0, 0, 0), at(10, 0, 0)], knownValue: 0, unit: "cm" },
      { points: [at(0, 0, 0)], knownValue: 25, unit: "cm" },
      { points: [at(0, 0, 0), at(0, 0, 0)], knownValue: 25, unit: "cm" },
    ]) {
      expect((await call(calUrl(id), { ...w.as, method: "PUT", body })).status).toBe(422);
    }
  });

  test("clearing it puts every later measurement back to unverified", async () => {
    const w = await world();
    const created = await publish(w, { fields: { unit: "" } });
    const id = created.body.publication.id;
    await call(calUrl(id), {
      ...w.as, method: "PUT",
      body: { points: [at(0, 0, 0), at(10, 0, 0)], knownValue: 25, unit: "cm" },
    });
    const cleared = await call(calUrl(id), { ...w.as, method: "DELETE" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.scale.state).toBe("unverified");
  });
});

/* ═══ 10e · DRAFT, REVIEWED, ACCEPTED, WITHDRAWN ═════════════════════════ */

const straight = (name) => ({ kind: "distance", name, points: [at(0, 0, 0), at(0, 0, 2)] });

describe("a measurement earns its way to being a fact", () => {
  test("it starts as a draft, which is R&D's own working figure", async () => {
    const w = await world();
    const { r } = await measured(w, straight("Hem circumference"));
    expect(r.body.measurement.status).toBe("draft");
    expect(r.body.measurement.reviewedBy).toBe("");
  });

  test("nobody reviews or accepts their own", async () => {
    const w = await world();
    const { r } = await measured(w, straight("Sleeve opening"));
    const m = r.body.measurement;
    const own = await call(oneUrl(m.id), {
      ...w.as, method: "PATCH", body: { status: "reviewed", expectedRevision: m.revision },
    });
    expect(own.status).toBe(409);
    expect(own.body.error.code).toBe("MODEL_SELF_APPROVAL");
  });

  test("a second person reviews it, then accepts it, and both are attributable", async () => {
    const w = await world();
    const { r } = await measured(w, straight("Shoulder slope"));
    let m = r.body.measurement;

    const reviewed = await call(oneUrl(m.id), {
      ...w.asApprover, method: "PATCH", body: { status: "reviewed", expectedRevision: m.revision },
    });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.measurement.status).toBe("reviewed");
    expect(reviewed.body.measurement.reviewedBy).toBe(w.approver.name);
    m = reviewed.body.measurement;

    const accepted = await call(oneUrl(m.id), {
      ...w.asApprover, method: "PATCH", body: { status: "accepted", expectedRevision: m.revision },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.measurement.status).toBe("accepted");
  });

  test("it cannot jump from draft straight to accepted", async () => {
    const w = await world();
    const { r } = await measured(w, straight("Cuff height"));
    const m = r.body.measurement;
    const jump = await call(oneUrl(m.id), {
      ...w.asApprover, method: "PATCH", body: { status: "accepted", expectedRevision: m.revision },
    });
    expect(jump.status).toBe(409);
    expect(jump.body.error.code).toBe("INVALID_TRANSITION");
  });

  test("a draft's points may be corrected; a reviewed one's may not", async () => {
    const w = await world();
    const { r } = await measured(w, straight("Pocket placement"));
    let m = r.body.measurement;

    /* Dragging a point onto the seam you meant is part of taking a
       measurement, not a rewrite of one. */
    const moved = await call(oneUrl(m.id), {
      ...w.as, method: "PATCH",
      body: { points: [at(0, 0, 0), at(0, 0, 6)], expectedRevision: m.revision },
    });
    expect(moved.status).toBe(200);
    expect(moved.body.measurement.rawValue).toBeCloseTo(6, 10);
    m = moved.body.measurement;

    const reviewed = await call(oneUrl(m.id), {
      ...w.asApprover, method: "PATCH", body: { status: "reviewed", expectedRevision: m.revision },
    });
    m = reviewed.body.measurement;

    /* And now it is evidence. */
    const frozen = await call(oneUrl(m.id), {
      ...w.as, method: "PATCH",
      body: { points: [at(0, 0, 0), at(0, 0, 9)], expectedRevision: m.revision },
    });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error.code).toBe("MODEL_STATE_CONFLICT");

    const renamed = await call(oneUrl(m.id), {
      ...w.as, method: "PATCH", body: { name: "Something else", expectedRevision: m.revision },
    });
    expect(renamed.status).toBe(409);
  });

  test("withdrawing keeps it as evidence rather than deleting it", async () => {
    const w = await world();
    const { id, r } = await measured(w, straight("Abandoned check"));
    const m = r.body.measurement;
    const gone = await call(oneUrl(m.id), {
      ...w.as, method: "PATCH",
      body: { status: "withdrawn", statusNote: "Measured on the wrong panel.", expectedRevision: m.revision },
    });
    expect(gone.status).toBe(200);
    expect(gone.body.measurement.status).toBe("withdrawn");

    const list = await call(measureUrl(id), w.as);
    expect(list.body.measurements).toHaveLength(1);
    expect(list.body.measurements[0].events.map((e) => e.kind))
      .toContain("status:withdrawn");
  });

  test("a duplicate copies what was measured and none of the review", async () => {
    const w = await world();
    const { r } = await measured(w, {
      ...straight("Button 1 placement"), category: "trim_placement", intendedSize: "M",
    });
    let m = r.body.measurement;
    m = (await call(oneUrl(m.id), {
      ...w.asApprover, method: "PATCH", body: { status: "reviewed", expectedRevision: m.revision },
    })).body.measurement;

    const copy = await call(`${oneUrl(m.id)}/duplicate`, {
      ...w.as, method: "POST", body: { name: "Button 2 placement" },
    });
    expect(copy.status).toBe(201);
    const c = copy.body.measurement;
    expect(c.name).toBe("Button 2 placement");
    expect(c.rawValue).toBe(m.rawValue);
    expect(c.category).toBe("trim_placement");
    expect(c.intendedSize).toBe("M");
    /* Nobody has looked at the copy. */
    expect(c.status).toBe("draft");
    expect(c.reviewedBy).toBe("");
    expect(c.duplicatedFromRef).toBe(m.measurementRef);
  });

  test("the history records every step, by name", async () => {
    const w = await world();
    const { r } = await measured(w, straight("Front rise"));
    let m = r.body.measurement;
    m = (await call(oneUrl(m.id), {
      ...w.as, method: "PATCH", body: { note: "Taken flat.", expectedRevision: m.revision },
    })).body.measurement;
    m = (await call(oneUrl(m.id), {
      ...w.asApprover, method: "PATCH", body: { status: "reviewed", expectedRevision: m.revision },
    })).body.measurement;

    expect(m.events.map((e) => e.kind)).toEqual(["created", "edited", "status:reviewed"]);
    expect(m.events[2].by).toBe(w.approver.name);
    expect(typeof m.events[0].by).toBe("string");
  });
});

/* ═══ 10f · WHO MAY, AND WHAT SURVIVES ═══════════════════════════════════ */

describe("measurements live by the same rules as everything else here", () => {
  test("a viewer reads them and records none", async () => {
    const w = await world();
    const { id } = await measured(w, straight("Readable"));

    expect((await call(measureUrl(id), w.asReader)).status).toBe(200);
    expect((await call(measureUrl(id), {
      ...w.asReader, method: "POST", body: straight("Nope"),
    })).status).toBe(403);
    expect((await call(calUrl(id), {
      ...w.asReader, method: "PUT",
      body: { points: [at(0, 0, 0), at(10, 0, 0)], knownValue: 25, unit: "cm" },
    })).status).toBe(403);
  });

  test("another company's measurements do not exist", async () => {
    const mine = await world();
    const theirs = await world();
    const { id } = await measured(theirs, straight("Theirs"));
    expect((await call(measureUrl(id), mine.as)).status).toBe(404);
    expect((await call(measureUrl(id), {
      ...mine.as, method: "POST", body: straight("Mine"),
    })).status).toBe(404);
  });

  test("an accepted model takes no further measurements", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.as, method: "POST", body: {} });
    await call(`/api/cms/rnd/garment-models/${id}/approve`, { ...w.asApprover, method: "POST", body: {} });

    const r = await call(measureUrl(id), { ...w.as, method: "POST", body: straight("Too late") });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("MODEL_STATE_CONFLICT");
    expect((await call(calUrl(id), {
      ...w.as, method: "PUT",
      body: { points: [at(0, 0, 0), at(10, 0, 0)], knownValue: 25, unit: "cm" },
    })).status).toBe(409);
    /* It stays readable evidence. */
    expect((await call(measureUrl(id), w.as)).status).toBe(200);
  });

  test("a save from a stale screen is refused rather than overwriting", async () => {
    const w = await world();
    const { r } = await measured(w, straight("Contested"));
    const m = r.body.measurement;
    await call(oneUrl(m.id), { ...w.as, method: "PATCH", body: { name: "First", expectedRevision: m.revision } });
    const stale = await call(oneUrl(m.id), {
      ...w.as, method: "PATCH", body: { name: "Second", expectedRevision: m.revision },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("REVISION_CONFLICT");
  });

  test("it survives a reload, point for point and digit for digit", async () => {
    const w = await world();
    const route = arcRoute(16);
    const { id, r } = await measured(w, {
      kind: "path", name: "Armhole seam", category: "seam_path",
      note: "Flat, not on the form.",
      points: [route[0], route[8], route[16]],
      surfacePath: route,
    });
    const before = r.body.measurement;

    const list = await call(measureUrl(id), w.as);
    const after = list.body.measurements.find((x) => x.id === before.id);

    expect(after.rawValue).toBe(before.rawValue);
    expect(after.points).toEqual(before.points);
    expect(after.surfacePath).toEqual(before.surfacePath);
    expect(after.name).toBe("Armhole seam");
    expect(after.category).toBe("seam_path");
    expect(after.note).toBe("Flat, not on the form.");
    expect(after.kind).toBe("path");
  });
});

/* ═══ 10g · WHAT INDUSTRIAL ENGINEERING IS HANDED ════════════════════════
 *
 * A read-only projection, and the three rules about what appears in it are
 * the whole contract: drafts stay in R&D, withdrawn is not current, and a new
 * model version inherits nothing.
 */

const handoverUrl = (styleId) =>
  `/api/cms/rnd/garment-models/styles/${styleId}/measurement-handover`;

/** Publish, measure, review, accept, and approve the model. */
async function handedOver(w, bodies) {
  const created = await publish(w);
  const id = created.body.publication.id;
  const made = [];
  for (const body of bodies) {
    const r = await call(measureUrl(id), { ...w.as, method: "POST", body: body.measurement });
    let m = r.body.measurement;
    for (const status of body.states || []) {
      m = (await call(oneUrl(m.id), {
        ...w.asApprover, method: "PATCH", body: { status, expectedRevision: m.revision },
      })).body.measurement;
    }
    made.push(m);
  }
  await call(`/api/cms/rnd/garment-models/${id}/submit`, { ...w.as, method: "POST", body: {} });
  await call(`/api/cms/rnd/garment-models/${id}/approve`, { ...w.asApprover, method: "POST", body: {} });
  return { id, made };
}

describe("the handover to Industrial Engineering", () => {
  test("accepted measurements are handed over, with everything needed to use them", async () => {
    const w = await world();
    const route = arcRoute(12);
    await handedOver(w, [{
      measurement: {
        kind: "surface", name: "Front neckline curve", category: "seam_path",
        points: [route[0], route[12]], surfacePath: route,
        intendedSize: "M", toleranceMm: 3,
        linkedTechnicalItem: { kind: "pom", ref: "POM-002", label: "Neck opening" },
        note: "Measured along the finished edge.",
      },
      states: ["reviewed", "accepted"],
    }]);

    const r = await call(handoverUrl(w.style._id), w.as);
    expect(r.status).toBe(200);
    expect(r.body.readOnly).toBe(true);
    expect(r.body.authority).toMatch(/manufacturing authority/i);
    expect(r.body.approvedModel.modelName).toMatch(/^3D model \d+$/);

    expect(r.body.measurements).toHaveLength(1);
    const m = r.body.measurements[0];
    expect(m.name).toBe("Front neckline curve");
    expect(m.kind).toBe("surface");
    expect(m.followsSurface).toBe(true);
    expect(m.rawValue).toBeCloseTo(ARC_LENGTH, 2);
    expect(m.value).toBeCloseTo(ARC_LENGTH, 2);
    expect(m.unit).toBe("cm");
    expect(m.scale.state).toBe("declared");
    expect(m.intendedSize).toBe("M");
    expect(m.toleranceMm).toBe(3);
    expect(m.linkedTechnicalItem.ref).toBe("POM-002");
    expect(m.reviewedBy).toBe(w.approver.name);
    expect(m.reviewedAt).toBeTruthy();
    expect(m.modelPublicationRef).toBe(r.body.approvedModel.publicationRef);
    /* Enough to draw it read-only. */
    expect(m.surfacePath).toHaveLength(13);
    expect(m.points).toHaveLength(2);
  });

  test("a reviewed-but-not-accepted measurement is handed over too", async () => {
    const w = await world();
    await handedOver(w, [
      { measurement: straight("Reviewed only"), states: ["reviewed"] },
    ]);
    const r = await call(handoverUrl(w.style._id), w.as);
    expect(r.body.measurements.map((m) => m.name)).toEqual(["Reviewed only"]);
  });

  test("drafts stay inside R&D", async () => {
    /* A number somebody is still taking is not a fact anybody downstream
       should plan against — and a draft that reached IE would be planned
       against, because that is what a handover is for. */
    const w = await world();
    await handedOver(w, [
      { measurement: straight("Still working on it"), states: [] },
      { measurement: straight("Signed off"), states: ["reviewed", "accepted"] },
    ]);
    const r = await call(handoverUrl(w.style._id), w.as);
    expect(r.body.measurements.map((m) => m.name)).toEqual(["Signed off"]);
  });

  test("a withdrawn measurement is not a current fact", async () => {
    const w = await world();
    await handedOver(w, [
      { measurement: straight("Taken back"), states: ["reviewed", "withdrawn"] },
      { measurement: straight("Stands"), states: ["reviewed", "accepted"] },
    ]);
    const r = await call(handoverUrl(w.style._id), w.as);
    expect(r.body.measurements.map((m) => m.name)).toEqual(["Stands"]);
  });

  test("a new model version inherits nothing, and says where the old ones came from", async () => {
    const w = await world();
    await handedOver(w, [{ measurement: straight("Measured on model 1"), states: ["reviewed", "accepted"] }]);

    /* A second export, approved. It was never measured. */
    const second = await publish(w);
    const secondId = second.body.publication.id;
    await call(`/api/cms/rnd/garment-models/${secondId}/submit`, { ...w.as, method: "POST", body: {} });
    await call(`/api/cms/rnd/garment-models/${secondId}/approve`, { ...w.asApprover, method: "POST", body: {} });

    const r = await call(handoverUrl(w.style._id), w.as);
    expect(r.body.approvedModel.publicationRef).toBe(second.body.publication.publicationRef);
    /* Nothing carried forward onto a model nobody measured. */
    expect(r.body.measurements).toEqual([]);
    /* But the earlier work is reported as what it is. */
    expect(r.body.previousVersionMeasurements.map((m) => m.name)).toEqual(["Measured on model 1"]);
    expect(r.body.previousVersionMeasurements[0].modelPublicationRef)
      .not.toBe(r.body.approvedModel.publicationRef);
  });

  test("with no approved model there is nothing to hand over", async () => {
    const w = await world();
    await publish(w);
    const r = await call(handoverUrl(w.style._id), w.as);
    expect(r.status).toBe(200);
    expect(r.body.approvedModel).toBeNull();
    expect(r.body.measurements).toEqual([]);
  });

  test("it is read-only — there is no route that writes through it", async () => {
    const w = await world();
    await handedOver(w, [{ measurement: straight("Fixed"), states: ["reviewed", "accepted"] }]);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const r = await call(handoverUrl(w.style._id), { ...w.as, method, body: { name: "x" } });
      expect(r.status).toBe(404);
    }
  });

  test("another company cannot read it, and cannot tell whether it exists", async () => {
    const mine = await world();
    const theirs = await world();
    await handedOver(theirs, [{ measurement: straight("Theirs"), states: ["reviewed", "accepted"] }]);

    const real = await call(handoverUrl(theirs.style._id), mine.as);
    const invented = await call(handoverUrl(new mongoose.Types.ObjectId()), mine.as);
    expect(real.status).toBe(404);
    expect(JSON.stringify(real.body)).toBe(JSON.stringify(invented.body));
  });

  test("a viewer may read the handover; it needs no extra permission", async () => {
    const w = await world();
    await handedOver(w, [{ measurement: straight("Shared"), states: ["reviewed", "accepted"] }]);
    const r = await call(handoverUrl(w.style._id), w.asReader);
    expect(r.status).toBe(200);
    expect(r.body.measurements).toHaveLength(1);
  });
});

describe("a history says who, and nothing else about them", () => {
  test("an event carries a name, never the author's account record", async () => {
    const w = await world();
    const created = await publish(w);
    const id = created.body.publication.id;
    const made = await call(`/api/cms/rnd/garment-models/${id}/annotations`, {
      ...w.as, method: "POST", body: marker("n1", { title: "Collar stand" }),
    });
    expect(made.status).toBe(201);
    const events = made.body.annotation.events;
    expect(events).toHaveLength(1);
    /* A string, because that is what a list of "who did this" needs — and
       because a screen handed `{ id, name, email }` where it expected a person
       does not show a wrong name, it stops rendering. */
    expect(typeof events[0].by).toBe("string");
    expect(events[0].by).toBe(w.engineer.name);
    /* And the address is not along for the ride. */
    expect(JSON.stringify(events)).not.toContain("@");
  });
});
