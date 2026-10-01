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

/** Publish one draft through the real multipart route. */
async function publish(w, { glb = jacketGlb(), source = true, fields = {} } = {}) {
  const form = new FormData();
  form.append("webModel", new Blob([glb], { type: "model/gltf-binary" }), "field-jacket.glb");
  if (source) form.append("source", new Blob([Buffer.from("CLO PROJECT BYTES")], { type: "application/octet-stream" }), "field-jacket.zprj");
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
