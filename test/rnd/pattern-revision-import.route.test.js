// test/rnd/pattern-revision-import.route.test.js
//
// THE DOOR A FLAT PATTERN COMES IN THROUGH, AND THE REPAIR FOR THE ONES THAT
// CAME IN BEFORE IT EXISTED.
//
// ── THE DEFECT THIS SUITE IS WRITTEN AGAINST ────────────────────────────────
// A DXF could only enter this system by being attached to a garment bundle,
// which parsed it, stored it and drew it — and created no pattern revision,
// because nothing connected the two. Pattern & Fit reads revisions. So a style
// could carry a correct five-piece pattern and still report that no pattern had
// ever been imported, which is exactly what `JW-SHIRT-DEMO-01` does in the dev
// database: four publications carrying the parse, all four of them the SAME
// 67,307-byte file uploaded four separate times, and zero revisions.
//
// Three things had to become true, and each has a section below:
//
//   · importing a DXF creates a revision, through one route, as a draft;
//   · importing the same DXF twice does not create two of them;
//   · a style whose pattern is only inside a publication can be repaired
//     without re-uploading the file and without touching anything approved.
//
// The harness is `pattern-bundle.route.test.js`'s, for the reason stated there:
// a mock that does not match its subject is a test that proves the mock.
"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

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
const { GarmentModelPublication, PUBLICATION_STATE } = require("../../models/CMS_Models/RnD/GarmentModel");
const { PatternRevision } = require("../../models/CMS_Models/RnD/PatternRevision");
const { inspectDxf } = require("../../utils/dxfInspect");

let server; let base; let rs; let seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "rnd_pattern_import" });
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

/** A DXF that is a drawing but not a garment: no pieces, no apparel layers. */
const notApparelDxf = () => Buffer.from([
  "0\nSECTION", "2\nHEADER", "9\n$ACADVER", "1\nAC1006", "0\nENDSEC",
  "0\nSECTION", "2\nENTITIES",
  "0\nLINE", "8\n0", "10\n0", "20\n0", "11\n10", "21\n10",
  "0\nENDSEC", "0\nEOF",
].join("\n"));

/** A second, genuinely different apparel DXF — one piece, one grainline. */
function otherApparelDxf() {
  const pairs = (list) => list.map(([c, v]) => `${c}\n${v}`).join("\n");
  return Buffer.from(pairs([
    ["0", "SECTION"], ["2", "HEADER"], ["9", "$ACADVER"], ["1", "AC1006"], ["0", "ENDSEC"],
    ["0", "SECTION"], ["2", "BLOCKS"],
    ["0", "BLOCK"], ["8", "0"], ["2", "FrontBodice_M"], ["70", "64"], ["10", "0"], ["20", "0"],
    ["0", "TEXT"], ["8", "15"], ["10", "0"], ["20", "0"], ["1", "PIECE NAME: Front Bodice"],
    ["0", "TEXT"], ["8", "15"], ["10", "0"], ["20", "0"], ["1", "SIZE: M"],
    ["0", "POLYLINE"], ["8", "1"], ["66", "1"], ["70", "1"],
    ["0", "VERTEX"], ["8", "1"], ["10", "0"], ["20", "0"],
    ["0", "VERTEX"], ["8", "1"], ["10", "220"], ["20", "0"],
    ["0", "VERTEX"], ["8", "1"], ["10", "220"], ["20", "300"],
    ["0", "VERTEX"], ["8", "1"], ["10", "0"], ["20", "300"],
    ["0", "SEQEND"], ["8", "1"],
    ["0", "LINE"], ["8", "7"], ["10", "100"], ["20", "50"], ["11", "100"], ["21", "250"],
    ["0", "ENDBLK"], ["8", "0"],
    ["0", "ENDSEC"],
    ["0", "SECTION"], ["2", "ENTITIES"],
    ["0", "INSERT"], ["8", "1"], ["2", "FrontBodice_M"], ["10", "0"], ["20", "0"],
    ["0", "ENDSEC"], ["0", "EOF"],
  ]), "utf8");
}

/** Not a DXF at all. */
const rubbish = () => Buffer.from("this is not a drawing, it is a sentence", "utf8");

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
      return { status: r.status, body: parsed };
    }
    return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
  });

async function person(co, grants) {
  const n = ++seq;
  const email = `pri-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "P", lastName: `R${n}`, email, biometricId: `PRI${n}`,
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
    companyName: `Pattern Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-PRI-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-PRI-${n}`, styleCode: `SC-PRI-${n}`, productName: "Jersey Tee",
    journeyId: journey._id, accountId: account._id, stage: "rnd", techSheet: { status: "pending" },
  });
  const engineer = await person(co, { "research-development": "editor" });
  const reader = await person(co, { "research-development": "viewer" });
  const outsider = await person(co, { sales: "approver" });
  return {
    n, co, style,
    as: { token: engineer.token, company: co._id },
    asReader: { token: reader.token, company: co._id },
    asOutsider: { token: outsider.token, company: co._id },
    importUrl: `/api/cms/rnd/patterns/styles/${style._id}/revisions/import`,
    reconcileUrl: `/api/cms/rnd/patterns/styles/${style._id}/revisions/reconcile`,
    listUrl: `/api/cms/rnd/patterns/styles/${style._id}/revisions`,
  };
}

/** Send a DXF to the import route. */
const importDxf = (w, who = w.as, { bytes = cloDxf(), name = "tshirt-pattern.dxf" } = {}) => {
  const form = new FormData();
  form.append("patterns", new Blob([bytes], { type: "application/dxf" }), name);
  return call(w.importUrl, { ...who, method: "POST", form });
};

/* ═══ 1 · IMPORTING A DXF CREATES THE REVISION ═════════════════════════════ */

describe("importing a CLO AAMA DXF", () => {
  test("creates revision 1, as a draft, carrying the file it was made from", async () => {
    const w = await world();
    const r = await importDxf(w);
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(true);

    const rev = r.body.revision;
    expect(rev.revisionNumber).toBe(1);
    /* A draft. There is no argument to this route that approves anything. */
    expect(rev.state).toBe("draft");
    expect(rev.origin.kind).toBe("dxf-import");
    expect(rev.sourceDxf.name).toBe("tshirt-pattern.dxf");
    expect(rev.sourceDxf.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rev.sourceDxf.bytes).toBe(cloDxf().length);
    /* The view says the file is HELD and never says where: a storage id in a
       response is a storage id in somebody's browser history. */
    expect(rev.sourceDxf.held).toBe(true);
    expect(rev.sourceDxf.driveFileId).toBeUndefined();
    const stored = await PatternRevision.findById(rev.id).lean();
    expect(stored.sourceDxf.driveFileId).toBeTruthy();
  });

  test("the geometry in the revision is the geometry in the file", async () => {
    const w = await world();
    const parsed = inspectDxf(cloDxf());
    const r = await importDxf(w);
    const read = await call(`/api/cms/rnd/patterns/revisions/${r.body.revision.id}`, w.as);
    const set = read.body.revision.patternSet;

    expect(set.pieces).toHaveLength(parsed.pieces.length);
    /* INCHES. Reading this as millimetres is a 25.4x error no shape reveals. */
    expect(set.unit).toBe(parsed.unit);
    expect(set.unitInMm).toBeCloseTo(parsed.unitInMm, 6);
    const points = (list) => list.reduce((n, p) => n + (p.outline || []).length, 0);
    expect(points(set.pieces)).toBe(points(parsed.pieces));
    expect(set.pieces.filter((p) => p.grainline).length)
      .toBe(parsed.pieces.filter((p) => p.grainline).length);
    /* Every piece carries a ref the seam map can name it by. */
    for (const piece of set.pieces) expect(piece.pieceRef).toMatch(/^PP-/);
  });

  test("it appears in the style's revision list immediately", async () => {
    const w = await world();
    const before = await call(w.listUrl, w.as);
    expect(before.body.revisions).toHaveLength(0);

    const r = await importDxf(w);
    const after = await call(w.listUrl, w.as);
    expect(after.body.revisions).toHaveLength(1);
    expect(after.body.revisions[0].id).toBe(r.body.revision.id);
    expect(after.body.revisions[0].revisionNumber).toBe(1);
  });

  test("a second, different pattern becomes revision 2 rather than replacing it", async () => {
    const w = await world();
    await importDxf(w);
    /* A different apparel DXF, not the same bytes: the hash is the only thing
       that decides whether two imports are one import. */
    const second = await importDxf(w, w.as, { bytes: otherApparelDxf(), name: "bodice.dxf" });
    expect(second.status).toBe(201);
    expect(second.body.revision.revisionNumber).toBe(2);
    const list = await call(w.listUrl, w.as);
    expect(list.body.revisions).toHaveLength(2);
  });
});

/* ═══ 2 · THE SAME FILE TWICE IS ONE IMPORT ════════════════════════════════ */

describe("importing the same DXF again", () => {
  test("returns the revision that already exists and creates nothing", async () => {
    const w = await world();
    const first = await importDxf(w);
    const again = await importDxf(w);

    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.revision.id).toBe(first.body.revision.id);
    expect(again.body.revision.revisionNumber).toBe(1);

    const list = await call(w.listUrl, w.as);
    expect(list.body.revisions).toHaveLength(1);
    expect(await PatternRevision.countDocuments({ styleId: w.style._id })).toBe(1);
  });

  test("and does not store a second copy of the file", async () => {
    const w = await world();
    const before = mockDrive.size;
    await importDxf(w);
    const afterFirst = mockDrive.size;
    await importDxf(w);
    expect(mockDrive.size).toBe(afterFirst);
    expect(afterFirst).toBe(before + 1);
  });

  test("the same file against ANOTHER style is a different pattern", async () => {
    /* One block sent to two styles is two patterns, and folding them together
       because the bytes match would be the idempotency rule overreaching. */
    const a = await world();
    const b = await world();
    const first = await importDxf(a);
    const second = await importDxf(b);
    expect(second.status).toBe(201);
    expect(second.body.revision.id).not.toBe(first.body.revision.id);
  });
});

/* ═══ 3 · WHO MAY, AND WHOSE STYLE ═════════════════════════════════════════ */

describe("the import is company-scoped and capability-gated", () => {
  test("a viewer may not import a pattern", async () => {
    const w = await world();
    const r = await importDxf(w, w.asReader);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await PatternRevision.countDocuments({ styleId: w.style._id })).toBe(0);
  });

  test("somebody with no R&D grant at all may not", async () => {
    const w = await world();
    const r = await importDxf(w, w.asOutsider);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await PatternRevision.countDocuments({ styleId: w.style._id })).toBe(0);
  });

  test("another company's style does not exist to this one", async () => {
    const mine = await world();
    const theirs = await world();
    const r = await call(theirs.importUrl, {
      ...mine.as,
      method: "POST",
      form: (() => {
        const f = new FormData();
        f.append("patterns", new Blob([cloDxf()], { type: "application/dxf" }), "x.dxf");
        return f;
      })(),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await PatternRevision.countDocuments({ styleId: theirs.style._id })).toBe(0);
  });

  test("an unauthenticated request is refused", async () => {
    const w = await world();
    const form = new FormData();
    form.append("patterns", new Blob([cloDxf()], { type: "application/dxf" }), "x.dxf");
    const r = await call(w.importUrl, { company: w.co._id, method: "POST", form });
    expect(r.status).toBeGreaterThanOrEqual(401);
  });
});

/* ═══ 4 · WHAT IS REFUSED, AND WHETHER IT SAYS WHY ═════════════════════════ */

describe("a file that is not an apparel pattern is refused with a reason", () => {
  test("a DXF with no pattern pieces in it", async () => {
    const w = await world();
    const r = await importDxf(w, w.as, { bytes: notApparelDxf(), name: "floorplan.dxf" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    /* A code a screen can branch on and a sentence a person can act on. */
    expect(r.body.error?.code || r.body.code).toBeTruthy();
    expect(String(r.body.error?.message || r.body.message).length).toBeGreaterThan(20);
    expect(await PatternRevision.countDocuments({ styleId: w.style._id })).toBe(0);
  });

  test("a file that is not a DXF at all", async () => {
    const w = await world();
    const r = await importDxf(w, w.as, { bytes: rubbish(), name: "notes.dxf" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(String(r.body.error?.message || r.body.message)).toMatch(/\w{4,}/);
    expect(await PatternRevision.countDocuments({ styleId: w.style._id })).toBe(0);
  });

  test("no file at all", async () => {
    const w = await world();
    const r = await call(w.importUrl, { ...w.as, method: "POST", form: new FormData() });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

/* ═══ 5 · RECOVERING A PATTERN THAT IS ONLY INSIDE A PUBLICATION ═══════════ */

/**
 * The situation on `JW-SHIRT-DEMO-01`, built here: publications carrying a
 * parsed pattern and an uploaded DXF, and no revision anywhere.
 */
async function publicationWithPattern(w, state = PUBLICATION_STATE.DRAFT) {
  const parsed = inspectDxf(cloDxf());
  const mapping = require("../../services/rnd/patternMapping.service");
  const n = ++seq;
  const driveFileId = `drv-pre-${n}`;
  mockDrive.set(driveFileId, { buffer: cloDxf(), fileName: "tshirt-pattern.dxf" });
  const sha = require("crypto").createHash("sha256").update(cloDxf()).digest("hex");
  return GarmentModelPublication.create({
    companyId: w.co._id,
    styleId: w.style._id,
    publicationRef: `GM-PRE-${n}`,
    modelNumber: n,
    modelName: `3D model ${n}`,
    state,
    assets: [{
      kind: "pattern", driveFileId, name: "tshirt-pattern.dxf",
      mimeType: "application/dxf", bytes: cloDxf().length, sha256: sha, uploadedAt: new Date(),
    }],
    patternSet: {
      patternSetRef: `PS-PRE-${n}`,
      classification: "apparel_pattern_set",
      manifest: { styleName: "Jersey Tee" },
      unit: parsed.unit,
      unitSource: parsed.unitSource,
      unitInMm: parsed.unitInMm,
      pieces: parsed.pieces.map((p, i) => ({ ...p, pieceRef: mapping.mintPieceRef(p, i) })),
      sha256: sha,
      fileName: "tshirt-pattern.dxf",
      parseRevision: 1,
    },
    createdBy: { id: "x", name: "Importer", email: "x@grav.test" },
  });
}

describe("reconciling a style whose pattern is only inside a publication", () => {
  test("creates revision 1 from the saved parse, naming where it came from", async () => {
    const w = await world();
    const pub = await publicationWithPattern(w);
    expect(await PatternRevision.countDocuments({ styleId: w.style._id })).toBe(0);

    const r = await call(w.reconcileUrl, { ...w.as, method: "POST" });
    expect(r.status).toBe(200);
    expect(r.body.revisions).toHaveLength(1);

    const rev = r.body.revisions[0];
    expect(rev.revisionNumber).toBe(1);
    expect(rev.state).toBe("draft");
    expect(r.body.reconciled[0].created).toBe(true);
    expect(r.body.reconciled[0].publicationRef).toBe(pub.publicationRef);

    const stored = await PatternRevision.findOne({ styleId: w.style._id }).lean();
    expect(stored.origin.reconciledFromPublicationRef).toBe(pub.publicationRef);
    expect(stored.origin.reconciledAt).toBeTruthy();
    /* The geometry is the publication's, lifted whole. */
    expect(stored.patternSet.pieces).toHaveLength(inspectDxf(cloDxf()).pieces.length);
  });

  test("it reuses the stored file rather than uploading a second copy", async () => {
    const w = await world();
    const pub = await publicationWithPattern(w);
    const before = mockDrive.size;
    await call(w.reconcileUrl, { ...w.as, method: "POST" });
    expect(mockDrive.size).toBe(before);

    const stored = await PatternRevision.findOne({ styleId: w.style._id }).lean();
    const asset = pub.assets.find((a) => a.kind === "pattern");
    expect(stored.sourceDxf.driveFileId).toBe(asset.driveFileId);
    expect(stored.sourceDxf.sha256).toBe(asset.sha256);
  });

  test("running it again changes nothing", async () => {
    const w = await world();
    await publicationWithPattern(w);
    const first = await call(w.reconcileUrl, { ...w.as, method: "POST" });
    const again = await call(w.reconcileUrl, { ...w.as, method: "POST" });

    expect(again.body.revisions).toHaveLength(1);
    expect(again.body.revisions[0].id).toBe(first.body.revisions[0].id);
    expect(again.body.reconciled[0].created).toBe(false);
    expect(await PatternRevision.countDocuments({ styleId: w.style._id })).toBe(1);
  });

  test("several publications carrying the SAME file fold onto one revision", async () => {
    /* This is the demo style: four publications, one DXF, four uploads. */
    const w = await world();
    await publicationWithPattern(w);
    await publicationWithPattern(w);
    await publicationWithPattern(w, PUBLICATION_STATE.IN_REVIEW);

    const r = await call(w.reconcileUrl, { ...w.as, method: "POST" });
    expect(r.body.revisions).toHaveLength(1);
    expect(r.body.reconciled).toHaveLength(3);
    expect(r.body.reconciled.filter((x) => x.created)).toHaveLength(1);
    expect(await PatternRevision.countDocuments({ styleId: w.style._id })).toBe(1);
  });

  test("an APPROVED publication is read and never written", async () => {
    const w = await world();
    const approved = await publicationWithPattern(w, PUBLICATION_STATE.APPROVED);
    const before = await GarmentModelPublication.findById(approved._id).lean();

    const r = await call(w.reconcileUrl, { ...w.as, method: "POST" });
    expect(r.body.revisions).toHaveLength(1);

    const after = await GarmentModelPublication.findById(approved._id).lean();
    expect(after.state).toBe(PUBLICATION_STATE.APPROVED);
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    /* Not even a pointer: a signed-off record is not written to. The link runs
       the other way, on the revision. */
    expect(after.patternRevisionRef || "").toBe("");
    const stored = await PatternRevision.findOne({ styleId: w.style._id }).lean();
    expect(stored.origin.reconciledFromPublicationRef).toBe(approved.publicationRef);
  });

  test("an editable publication is pointed at the revision, so they cannot drift", async () => {
    const w = await world();
    const draft = await publicationWithPattern(w, PUBLICATION_STATE.DRAFT);
    const r = await call(w.reconcileUrl, { ...w.as, method: "POST" });
    const after = await GarmentModelPublication.findById(draft._id).lean();
    expect(after.patternRevisionRef).toBe(r.body.revisions[0].revisionRef);
  });

  test("a style with nothing to recover says so rather than inventing a revision", async () => {
    const w = await world();
    const r = await call(w.reconcileUrl, { ...w.as, method: "POST" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error?.code || r.body.code).toBe("NO_PATTERN_TO_RECOVER");
    expect(await PatternRevision.countDocuments({ styleId: w.style._id })).toBe(0);
  });

  test("a viewer may not reconcile", async () => {
    const w = await world();
    await publicationWithPattern(w);
    const r = await call(w.reconcileUrl, { ...w.asReader, method: "POST" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await PatternRevision.countDocuments({ styleId: w.style._id })).toBe(0);
  });
});

/* ═══ 6 · AND THE OTHER DOOR STAYS IN STEP ════════════════════════════════ */

describe("attaching a pattern to a bundle", () => {
  test("creates the same authoritative revision and points the bundle at it", async () => {
    const w = await world();
    const pub = await GarmentModelPublication.create({
      companyId: w.co._id, styleId: w.style._id, publicationRef: `GM-AT-${++seq}`,
      modelNumber: 1, modelName: "3D model 1", state: PUBLICATION_STATE.DRAFT,
      createdBy: { id: "x", name: "Importer", email: "x@grav.test" },
    });
    const form = new FormData();
    form.append("patterns", new Blob([cloDxf()], { type: "application/dxf" }), "tee.dxf");
    form.append("expectedRevision", String(pub.revision ?? 0));
    const r = await call(`/api/cms/rnd/garment-models/${pub._id}/pattern`, {
      ...w.as, method: "PUT", form,
    });
    expect(r.status).toBe(200);
    expect(r.body.patternRevision.revisionNumber).toBe(1);
    expect(r.body.patternRevisionCreated).toBe(true);

    /* The pattern is now where Pattern & Fit reads it. This is the connection
       that did not exist: the attach parsed, stored and drew the DXF, and left
       the revision list empty. */
    const list = await call(w.listUrl, w.as);
    expect(list.body.revisions).toHaveLength(1);

    const after = await GarmentModelPublication.findById(pub._id).lean();
    expect(after.patternRevisionRef).toBe(r.body.patternRevision.revisionRef);
  });
});
