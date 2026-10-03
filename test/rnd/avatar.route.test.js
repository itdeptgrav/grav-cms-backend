// test/rnd/avatar.route.test.js
//
// GENERATED AVATARS: SAVED AS IMMUTABLE REVISIONS, CHECKED ON THE WAY IN, AND
// POINTED AT BY THE PATTERN SETUP THAT A DRAPE FREEZES.
//
// The records are real ones the frontend generated on the pinned OxiHuman
// engine (`fixtures/avatarContracts.json`), so the server is tested against
// exactly what the browser sends. Harness: `pattern-revision-import.route.test.js`.
"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

jest.mock("../../services/companyDrive.service", () => ({
  uploadCompanyFile: jest.fn(async () => ({ driveFileId: "x" })),
  streamCompanyFile: jest.fn(async () => { throw new Error("not used"); }),
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
const { PatternRevision, RenderJob } = require("../../models/CMS_Models/RnD/PatternRevision");
const { sha256Json } = require("../../services/rnd/avatarContract");
const fixtures = require("./fixtures/avatarContracts.json");

let server; let base; let rs; let seq = 0;
const clone = (x) => JSON.parse(JSON.stringify(x));

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "rnd_avatars" });
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/cms/rnd", require("../../routes/CMS_Routes/RnD/garmentModelRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
}, 240000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const call = (p, { token, company, method = "GET", body } = {}) => fetch(`${base}${p}`, {
  method,
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(company ? { "X-Costing-Company": String(company) } : {}),
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function person(co, grants) {
  const n = ++seq;
  const email = `av-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "A", lastName: `V${n}`, email, biometricId: `AV${n}`,
    isActive: true, gender: "Other", department: "R&D",
  });
  await DeptUser.create({
    name: `User ${n}`, email, passwordHash: "x", isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: `User ${n}` });
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: `User ${n}`, role, isActive: true, departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    token: jwt.sign({ id: String(emp._id), email, name: `User ${n}`, employeeId: emp.biometricId, role: "rnd" },
      process.env.JWT_SECRET, { expiresIn: "30m" }),
    company: co._id,
  };
}

async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `Avatar Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const account = await Account.create({ companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-AV-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-AV-${n}`, styleCode: `SC-AV-${n}`, productName: "Jersey Tee",
    journeyId: journey._id, accountId: account._id, stage: "rnd", techSheet: { status: "pending" },
  });
  return {
    co, style,
    as: await person(co, { "research-development": "editor" }),
    asReader: await person(co, { "research-development": "viewer" }),
    asOutsider: await person(co, { sales: "approver" }),
    url: `/api/cms/rnd/styles/${style._id}/avatars`,
  };
}

const save = (w, body, who = w.as) => call(w.url, { ...who, method: "POST", body });

describe("saving an avatar", () => {
  test("creates revision 1 with the server's own verdict, author and timestamps", async () => {
    const w = await world();
    const r = await save(w, { name: "Female M — Regular", contract: fixtures.femaleM });
    expect(r.status).toBe(201);
    const a = r.body.avatar;
    expect(a.avatarId).toMatch(/^AV-[0-9A-F]{10}$/);
    expect(a.revision).toBe(1);
    expect(a.verdict).toBe("fit-verified");
    expect(a.engine).toMatchObject({ name: "oxihuman", version: "0.2.1",
      packSha256: fixtures.femaleM.content.engine.packSha256 });
    expect(a.requestedMm).toEqual(fixtures.femaleM.content.request.measurements);
    expect(a.tolerance).toEqual({ passMm: 5, reviewMm: 10 });
    expect(a.author.email).toMatch(/@grav\.test$/);
    expect(new Date(a.createdAt).getTime()).toBeGreaterThan(Date.now() - 60000);
    expect(a.contract.contentSha256).toBe(fixtures.femaleM.contentSha256);
  });

  test("reads back the same revision, measurements and geometry references", async () => {
    const w = await world();
    const { body } = await save(w, { contract: fixtures.femaleM });
    const read = await call(`${w.url}/${body.avatar.avatarId}/revisions/1`, w.asReader);
    expect(read.status).toBe(200);
    expect(read.body.avatar.contract).toEqual(fixtures.femaleM);
    expect(sha256Json(read.body.avatar.contract.content)).toBe(fixtures.femaleM.contentSha256);
    expect(read.body.avatar.renderMesh.restPositionsSha256)
      .toBe(fixtures.femaleM.content.renderMesh.restPositionsSha256);
    expect(read.body.avatar.collisionBody.sha256).toBe(fixtures.femaleM.content.collisionBody.sha256);
    const list = await call(w.url, w.asReader);
    expect(list.body.avatars).toHaveLength(1);
    expect(list.body.avatars[0].latest.revision).toBe(1);
    /* the list carries no contract content */
    expect(list.body.avatars[0].latest.contract).toBeUndefined();
  });

  test("an unchanged body creates nothing; a changed one is revision 2 and revision 1 is untouched", async () => {
    const w = await world();
    const first = (await save(w, { contract: fixtures.femaleM })).body.avatar;
    const same = await save(w, { avatarId: first.avatarId, expectedRevision: 1, contract: fixtures.femaleM });
    expect(same.status).toBe(200);
    expect(same.body.created).toBe(false);
    const second = await save(w, { avatarId: first.avatarId, expectedRevision: 1, contract: fixtures.femaleMWiderHip });
    expect(second.status).toBe(201);
    expect(second.body.avatar.revision).toBe(2);
    const r1 = await call(`${w.url}/${first.avatarId}/revisions/1`, w.as);
    expect(r1.body.avatar.contract).toEqual(fixtures.femaleM);
    expect(r1.body.avatar.requestedMm.hipMm).toBe(990);
    const list = await call(w.url, w.as);
    expect(list.body.avatars[0].revisions.map((x) => x.revision)).toEqual([2, 1]);
  });

  test("a save from a stale screen is refused, and two racing saves make one revision", async () => {
    const w = await world();
    const first = (await save(w, { contract: fixtures.femaleM })).body.avatar;
    await save(w, { avatarId: first.avatarId, expectedRevision: 1, contract: fixtures.femaleMWiderHip });
    const stale = await save(w, { avatarId: first.avatarId, expectedRevision: 1, contract: fixtures.femaleM });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("REVISION_CONFLICT");

    const w2 = await world();
    const base1 = (await save(w2, { contract: fixtures.femaleM })).body.avatar;
    const [a, b] = await Promise.all([
      save(w2, { avatarId: base1.avatarId, contract: fixtures.femaleMWiderHip }),
      save(w2, { avatarId: base1.avatarId, contract: fixtures.femaleMWiderHip }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const row = await SampleStyle.findById(w2.style._id).select("+rndAvatars").lean();
    expect(row.rndAvatars.filter((x) => x.revision === 2)).toHaveLength(1);
  });

  test("a revision cannot be edited through the model either", async () => {
    const w = await world();
    await save(w, { contract: fixtures.femaleM });
    const doc = await SampleStyle.findById(w.style._id).select("+rndAvatars");
    doc.rndAvatars[0].name = "renamed";
    doc.rndAvatars[0].contentSha256 = "f".repeat(64);
    await doc.save();
    const row = await SampleStyle.findById(w.style._id).select("+rndAvatars").lean();
    expect(row.rndAvatars[0].contentSha256).toBe(fixtures.femaleM.contentSha256);
    expect(row.rndAvatars[0].name).not.toBe("renamed");
  });

  test("a record whose numbers do not support its claims is refused with the reason", async () => {
    const w = await world();
    const bad = clone(fixtures.femaleM);
    bad.content.measurements.verified.find((r) => r.key === "hip").generatedMm += 12;
    bad.content.measurements.verified.find((r) => r.key === "hip").differenceMm += 12;
    bad.contentSha256 = sha256Json(bad.content);
    const r = await save(w, { contract: bad });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("VERIFICATION_MISMATCH");
    const tampered = clone(fixtures.femaleM);
    tampered.content.engineParams.weight = 0.9;
    expect((await save(w, { contract: tampered })).body.error.code).toBe("CONTENT_HASH_MISMATCH");
  });

  test("a viewer may read but not save; another department may do neither", async () => {
    const w = await world();
    expect((await save(w, { contract: fixtures.femaleM }, w.asReader)).status).toBe(403);
    expect((await call(w.url, w.asReader)).status).toBe(200);
    expect((await call(w.url, w.asOutsider)).status).toBe(403);
  });

  test("ordinary reads of the style never carry the avatars", async () => {
    const w = await world();
    await save(w, { contract: fixtures.femaleM });
    const plain = await SampleStyle.findById(w.style._id).lean();
    expect(plain.rndAvatars).toBeUndefined();
    const listed = await SampleStyle.find({ _id: w.style._id }).lean();
    expect(listed[0].rndAvatars).toBeUndefined();
  });
});

describe("pointing a pattern setup at an avatar revision", () => {
  async function revisionFor(w) {
    return PatternRevision.create({
      companyId: w.co._id, styleId: w.style._id, revisionRef: `PR-AV-${++seq}`, revisionNumber: 1,
      origin: { kind: "dxf-import" },
    });
  }
  const put = (w, rev, avatar) => call(`/api/cms/rnd/patterns/revisions/${rev._id}/simulation-inputs`,
    { ...w.as, method: "PUT", body: { inputs: { avatar } } });

  test("stores the server's own reference — revision, hash, engine and verdict", async () => {
    const w = await world();
    const a = (await save(w, { contract: fixtures.femaleM })).body.avatar;
    const rev = await revisionFor(w);
    const r = await put(w, rev, {
      name: "Female M — Regular",
      measurements: { heightMm: 1680, chestMm: 920.1, waistMm: 749.9, hipMm: 990 },
      avatarRef: { avatarId: a.avatarId, revision: 1, verdict: "anything the client says" },
    });
    expect(r.status).toBe(200);
    const stored = await PatternRevision.findById(rev._id).lean();
    expect(stored.simulationInputs.avatar.avatarRef).toEqual({
      avatarId: a.avatarId, revision: 1, contentSha256: fixtures.femaleM.contentSha256,
      engine: "oxihuman", engineVersion: "0.2.1", verdict: "fit-verified",
    });
  });

  test("a reference to a revision that does not exist, or to a different body, is refused", async () => {
    const w = await world();
    const a = (await save(w, { contract: fixtures.femaleM })).body.avatar;
    const rev = await revisionFor(w);
    const missing = await put(w, rev, { avatarRef: { avatarId: a.avatarId, revision: 7 } });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("AVATAR_NOT_FOUND");
    const wrong = await put(w, rev, { avatarRef: { avatarId: a.avatarId, revision: 1, contentSha256: "0".repeat(64) } });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe("AVATAR_HASH_MISMATCH");
    /* another style's avatar is not this style's */
    const other = await world();
    const theirs = (await save(other, { contract: fixtures.femaleM })).body.avatar;
    const foreign = await put(w, rev, { avatarRef: { avatarId: theirs.avatarId, revision: 1 } });
    expect(foreign.body.error.code).toBe("AVATAR_NOT_FOUND");
  });

  test("a new avatar revision does not move a setup that points at the old one", async () => {
    const w = await world();
    const a = (await save(w, { contract: fixtures.femaleM })).body.avatar;
    const rev = await revisionFor(w);
    await put(w, rev, { avatarRef: { avatarId: a.avatarId, revision: 1 } });
    await save(w, { avatarId: a.avatarId, expectedRevision: 1, contract: fixtures.femaleMWiderHip });
    const stored = await PatternRevision.findById(rev._id).lean();
    expect(stored.simulationInputs.avatar.avatarRef.revision).toBe(1);
    expect(stored.simulationInputs.avatar.avatarRef.contentSha256).toBe(fixtures.femaleM.contentSha256);
  });

  test("a render job's frozen inputs keep the avatar reference", () => {
    /* RenderJob.inputs is the same simulation-inputs schema, frozen per job;
       the reference must be a declared path there or Mongoose would strip it. */
    for (const k of ["avatarId", "revision", "contentSha256", "engineVersion", "verdict"]) {
      expect(RenderJob.schema.path("inputs").schema.path("avatar").schema.path("avatarRef").schema.path(k)).toBeTruthy();
    }
  });
});
