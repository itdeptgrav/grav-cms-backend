// test/studio/studioLink.route.test.js
//
// GRAV Studio ↔ CMS, end to end over real HTTP against an in-memory MongoDB:
// an administrator issues a designer a key; the designer's card links a
// Studio file; GRAV Studio (with the key) lists the style, opens it and sends
// a version; the reviewer (until Sales is wired, an administrator) answers; the designer
// sends again; a key of another company sees nothing; a revoked key is refused.
"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const notified = [];
jest.mock("../../services/departmentNotify.service", () => ({
  notifyEvent: async (key, payload) => {
    notified.push({ key, payload });
  },
  APP_URL: "https://cms.test",
}));

// The company an actor is in: named by the test, as membership would resolve it.
jest.mock("../../services/companyContext/salesScope.service", () => ({
  scopeFor: async (req) => {
    const companyId = req.headers["x-test-company"];
    if (!companyId) {
      const e = new Error("Choose a company.");
      e.status = 409;
      throw e;
    }
    return { companyId, clause: { companyId } };
  },
  scopedFilter: async (req, selector) => selector,
}));

// A platform administrator is whoever the test's token says is one — standing
// in for requirePlatformAdmin's database re-read, with the same answers.
jest.mock("../../Middlewear/requirePlatformAdmin", () => (req, res, next) => {
  const t = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  let d = null;
  try {
    d = require("jsonwebtoken").verify(t, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }
  if (!d.isAdmin) return res.status(403).json({ success: false, message: "Administrator access required" });
  req.user = { id: d.id, name: d.name, email: d.email, isAdmin: true };
  next();
});

const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const storage = require("../../services/studio/studioStorage.service");

const files = new Map();
storage.useStorage({
  async put(buffer, { fileName, mimeType, folderPath }) {
    const fileId = `f${files.size + 1}`;
    files.set(fileId, { buffer: Buffer.from(buffer), name: [...folderPath, fileName].join(" / "), mimeType });
    return { fileId, mimeType, size: buffer.length, name: fileName };
  },
  async stream(fileId) {
    const f = files.get(fileId);
    if (!f) throw Object.assign(new Error("gone"), { status: 404 });
    const { Readable } = require("stream");
    return { stream: Readable.from([f.buffer]), meta: { name: f.name, mimeType: f.mimeType, size: f.buffer.length } };
  },
  async remove(fileId) {
    files.delete(fileId);
  },
});

const COMPANY = new mongoose.Types.ObjectId().toString();
const OTHER = new mongoose.Types.ObjectId().toString();

const token = (claims) => jwt.sign({ v: 2, id: new mongoose.Types.ObjectId().toString(), ...claims }, process.env.JWT_SECRET);
const ADMIN = token({ role: "admin", name: "Asha Admin", email: "admin@grav.test", isAdmin: true });
const DESIGNER = token({ role: "research-development", name: "Dev Designer", email: "dev@grav.test" });
const MERCH = token({ role: "merchandiser", name: "Mira Merch", email: "mira@grav.test" });

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/studio-link", require("../../routes/CMS_Routes/Sales/sampleStudio"));
  app.use("/api/studio/v1", require("../../routes/Studio/studioApi"));
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  notified.length = 0;
  files.clear();
  await AccessDepartment.create({ key: "research-development", slug: "research-development", name: "Design (R&D)", dashboardPath: "/research-development" });
  await DepartmentRole.create({ departmentSlug: "research-development", email: "dev@grav.test", name: "Dev Designer", role: "editor" });
});

async function call(path, { method = "GET", bearer, company = COMPANY, body, form } = {}) {
  const headers = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (company) headers["x-test-company"] = company;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, type };
}

const style = (over = {}) =>
  SampleStyle.create({
    sampleStyleId: `SS-${Math.random().toString(36).slice(2, 8)}`,
    styleCode: "BLZ-01",
    productName: "Men's blazer",
    sampleType: "house",
    companyId: COMPANY,
    stage: "rnd",
    status: "active",
    brief: { note: "Two-button notch lapel, half lining.", fit: "Regular", sizeRange: "38–44", gsm: "240", customSpecs: [{ label: "Vents", value: "Two" }] },
    ...over,
  });

const png = (bytes = 64) => new Blob([Buffer.alloc(bytes, 7)], { type: "image/png" });

function versionForm({ note = "First fit", renders = ["front", "back"] } = {}) {
  const f = new FormData();
  f.append("manifest", JSON.stringify({ pieces: 12, stitches: 30 }));
  f.append("note", note);
  f.append("appVersion", "1.1.0");
  f.append("project", new Blob([Buffer.from("GRAV project bytes")], { type: "application/octet-stream" }), "BLZ-01.grav");
  for (const r of renders) f.append("renders", png(), `${r}.png`);
  f.append("flats", new Blob(["<svg/>"], { type: "image/svg+xml" }), "BLZ-01 - front.svg");
  return f;
}

async function issueKey(company = COMPANY) {
  const r = await call("/api/cms/studio-link/keys", { method: "POST", bearer: ADMIN, company, body: { email: "dev@grav.test", name: "Dev Designer", label: "Dev's laptop" } });
  expect(r.status).toBe(201);
  return r.data.key;
}

test("an administrator issues a designer a key; it is shown once and stored only as a hash", async () => {
  const key = await issueKey();
  expect(key).toMatch(/^gsk_[A-Za-z0-9_-]{40,}$/);
  const list = await call("/api/cms/studio-link/keys", { bearer: ADMIN });
  expect(list.data.keys).toHaveLength(1);
  expect(JSON.stringify(list.data)).not.toContain(key);
  expect(list.data.keys[0]).toMatchObject({ holder: { email: "dev@grav.test" }, active: true, label: "Dev's laptop" });
  // Hidden from a plain read of the department.
  const plain = await AccessDepartment.findOne({ slug: "research-development" }).lean();
  expect(plain.studioKeys).toBeUndefined();

  expect((await call("/api/cms/studio-link/keys", { bearer: DESIGNER })).status).toBe(403);
  const noRole = await call("/api/cms/studio-link/keys", { method: "POST", bearer: ADMIN, body: { email: "stranger@grav.test" } });
  expect(noRole.status).toBe(400);
  expect(noRole.data.message).toMatch(/no role in Design/);

  const me = await call("/api/studio/v1/me", { bearer: key, company: null });
  expect(me.data).toMatchObject({ success: true, name: "Dev Designer", email: "dev@grav.test" });
  expect((await call("/api/studio/v1/me", { bearer: "gsk_notarealkeyatallnotarealkey", company: null })).status).toBe(401);
});

test("the designer's card links a Studio file, and only Design can make one", async () => {
  const s = await style();
  const cards = await call("/api/cms/studio-link/styles?view=design", { bearer: DESIGNER });
  expect(cards.status).toBe(200);
  expect(cards.data.styles.map((c) => c.id)).toEqual([String(s._id)]);
  const card = cards.data.styles[0];
  expect(card.studio.status).toBe("none");
  expect(card.specs).toEqual(expect.arrayContaining([{ label: "Fit", value: "Regular" }, { label: "Vents", value: "Two" }]));

  expect((await call(`/api/cms/studio-link/styles/${s._id}/link`, { method: "POST", bearer: MERCH })).status).toBe(403);
  const made = await call(`/api/cms/studio-link/styles/${s._id}/link`, { method: "POST", bearer: DESIGNER });
  expect(made.status).toBe(201);
  expect(made.data.style.studio.status).toBe("linked");
  expect(made.data.style.openUrl).toMatch(new RegExp(`^gravstudio://sample/${s._id}\\?api=`));
  const again = await call(`/api/cms/studio-link/styles/${s._id}/link`, { method: "POST", bearer: DESIGNER });
  expect(again.status).toBe(200);
  expect(again.data.style.studio.fileId).toBe(made.data.style.studio.fileId);

  const notYet = await style({ stage: "materials", styleCode: "TEE-01" });
  expect((await call(`/api/cms/studio-link/styles/${notYet._id}/link`, { method: "POST", bearer: DESIGNER })).status).toBe(409);
});

test("Studio opens the file, sends versions; the reviewer sees the renders and answers", async () => {
  const s = await style();
  const key = await issueKey();
  await call(`/api/cms/studio-link/styles/${s._id}/link`, { method: "POST", bearer: DESIGNER });

  const list = await call("/api/studio/v1/samples", { bearer: key, company: null });
  expect(list.data.samples.map((x) => x.styleCode)).toEqual(["BLZ-01"]);
  const opened = await call(`/api/studio/v1/samples/${s._id}/open`, { method: "POST", bearer: key, company: null });
  expect(opened.data.sample.studio).toMatchObject({ status: "in_progress", designer: "Dev Designer" });

  const sent = await call(`/api/studio/v1/samples/${s._id}/versions`, { method: "POST", bearer: key, company: null, form: versionForm() });
  expect(sent.status).toBe(201);
  expect(sent.data.version).toBe(1);
  // Nobody is emailed that a version waits until Sales' side is built.
  expect(notified.map((n) => n.key)).not.toContain("studio_review_requested");
  expect([...files.values()].map((f) => f.name)).toContain("GRAV Studio / BLZ-01 / v1 / front.png");

  // The review list and one version's renders.
  const reviews = await call("/api/cms/studio-link/styles?view=review", { bearer: ADMIN });
  expect(reviews.data.styles).toHaveLength(1);
  const latest = reviews.data.styles[0].studio.latest;
  expect(latest).toMatchObject({ version: 1, outcome: "pending", note: "First fit", sentBy: "Dev Designer" });
  expect(latest.renders.map((r) => r.kind)).toEqual(["front", "back"]);
  expect(latest.flats[0]).toMatchObject({ kind: "front", mimeType: "image/svg+xml" });
  const pic = await call(`/api/cms/studio-link/styles/${s._id}/files/${latest.renders[0].fileId}`, { bearer: ADMIN });
  expect(pic.status).toBe(200);
  expect(pic.type).toBe("image/png");
  expect(pic.data.length).toBe(64);
  expect((await call(`/api/cms/studio-link/styles/${s._id}/files/nope`, { bearer: ADMIN })).status).toBe(404);

  // Changes need a note; Design cannot answer its own version, nor can Merchandising.
  expect((await call(`/api/cms/studio-link/styles/${s._id}/versions/1/decide`, { method: "POST", bearer: MERCH, body: { outcome: "approved" } })).status).toBe(403);
  expect((await call(`/api/cms/studio-link/styles/${s._id}/versions/1/decide`, { method: "POST", bearer: ADMIN, body: { outcome: "changes" } })).status).toBe(400);
  expect((await call(`/api/cms/studio-link/styles/${s._id}/versions/1/decide`, { method: "POST", bearer: DESIGNER, body: { outcome: "approved" } })).status).toBe(403);
  const asked = await call(`/api/cms/studio-link/styles/${s._id}/versions/1/decide`, { method: "POST", bearer: ADMIN, body: { outcome: "changes", feedback: "Shorten the sleeve 1 cm." } });
  expect(asked.status).toBe(200);
  expect(asked.data.studio.status).toBe("changes");
  expect(notified.map((n) => n.key)).toContain("studio_review_decided");

  // Studio sees the answer, sends version 2; version 1 keeps its answer.
  const back = await call(`/api/studio/v1/samples/${s._id}`, { bearer: key, company: null });
  expect(back.data.sample.studio.latest).toMatchObject({ version: 1, outcome: "changes", feedback: "Shorten the sleeve 1 cm." });
  const v2 = await call(`/api/studio/v1/samples/${s._id}/versions`, { method: "POST", bearer: key, company: null, form: versionForm({ note: "Sleeve shortened" }) });
  expect(v2.data.version).toBe(2);
  expect((await call(`/api/cms/studio-link/styles/${s._id}/versions/1/decide`, { method: "POST", bearer: ADMIN, body: { outcome: "approved" } })).status).toBe(409);
  const ok = await call(`/api/cms/studio-link/styles/${s._id}/versions/2/decide`, { method: "POST", bearer: ADMIN, body: { outcome: "approved" } });
  expect(ok.data.studio.status).toBe("approved");
  const stored = await SampleStyle.findById(s._id).lean();
  expect(stored.studio.versions.map((v) => [v.version, v.outcome])).toEqual([[1, "changes"], [2, "approved"]]);
  expect(stored.history.map((h) => h.kind)).toEqual(["studio_linked", "studio_opened", "studio_sent", "studio_changes", "studio_sent", "studio_approved"]);
});

test("coloured flats and the artwork pictures are kept apart from the line flats, for Colorways and Artwork", async () => {
  const s = await style();
  const key = await issueKey();
  await call(`/api/cms/studio-link/styles/${s._id}/link`, { method: "POST", bearer: DESIGNER });
  const print = "a".repeat(64);
  const logo = "b".repeat(64);
  const f = new FormData();
  f.append(
    "manifest",
    JSON.stringify({
      pieces: 5,
      colours: [{ hex: "#1f3a5f", panels: ["Right sleeve", "Left sleeve"] }],
      prints: [{ image: print, name: "plaid.png", repeatMm: [120, 120], rotationDeg: 0, dye: null, panels: ["Front"] }],
      artwork: [{ logoId: "LG-1", image: logo, name: "logo.png", panel: "Front", widthMm: 110, heightMm: 55, rotationDeg: 0, gapsMm: { left: 200, right: 206, top: 46, bottom: 663 } }],
      flatMarks: { pngPxPerMm: 2.5, front: [{ logoId: "LG-1", label: "logo", minMm: [180, 90], maxMm: [290, 140] }], back: [] },
    }),
  );
  f.append("project", new Blob([Buffer.from("GRAV")]), "TEE.grav");
  f.append("renders", png(), "front.png");
  for (const view of ["front", "back"]) {
    f.append("flats", new Blob(["<svg/>"], { type: "image/svg+xml" }), `TEE - ${view}.svg`);
    f.append("flats", png(), `TEE - ${view}.png`);
    f.append("flats", new Blob(["<svg/>"], { type: "image/svg+xml" }), `TEE - ${view} colour.svg`);
    f.append("flats", png(), `TEE - ${view} colour.png`);
  }
  f.append("artwork", png(), `${print}.png`);
  f.append("artwork", new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), `${logo}.jpg`);
  const sent = await call(`/api/studio/v1/samples/${s._id}/versions`, { method: "POST", bearer: key, company: null, form: f });
  expect(sent.status).toBe(201);

  const stored = (await SampleStyle.findById(s._id).lean()).studio.versions[0];
  const kinds = stored.flats.map((x) => `${x.kind} ${x.mimeType}`).sort();
  expect(kinds).toEqual([
    "back image/png", "back image/svg+xml", "backColour image/png", "backColour image/svg+xml",
    "front image/png", "front image/svg+xml", "frontColour image/png", "frontColour image/svg+xml",
  ]);
  expect(stored.artwork.map((x) => [x.kind, x.mimeType])).toEqual([["artwork", "image/png"], ["artwork", "image/jpeg"]]);
  // The artwork pictures are served like any other file of the style.
  const pic = await call(`/api/cms/studio-link/styles/${s._id}/files/${stored.artwork[0].fileId}`, { bearer: ADMIN });
  expect(pic.status).toBe(200);

  // The tech pack reads them into their own slots.
  const { buildTechPack } = require("../../services/techpack/techPack.service");
  const pack = buildTechPack({ style: await SampleStyle.findById(s._id).lean() });
  const line = stored.flats.find((x) => x.kind === "front" && x.mimeType === "image/svg+xml").fileId;
  const colour = stored.flats.find((x) => x.kind === "frontColour" && x.mimeType === "image/svg+xml").fileId;
  expect(pack.sketch.front.svg).toBe(line);
  expect(pack.sketch.colour.front.svg).toBe(colour);
  expect(pack.sketch.colour.back.png).toBeTruthy();
  expect(pack.artwork.colours).toEqual([{ hex: "#1f3a5f", panels: ["Right sleeve", "Left sleeve"] }]);
  expect(pack.artwork.prints[0]).toMatchObject({ name: "plaid.png", fileId: stored.artwork[0].fileId, repeatMm: [120, 120], panels: ["Front"] });
  expect(pack.artwork.logos[0]).toMatchObject({ name: "logo.png", fileId: stored.artwork[1].fileId, panel: "Front", widthMm: 110, gapsMm: { top: 46 } });
  expect(pack.artwork.flatMarks.front[0].logoId).toBe("LG-1");
});

test("marked flats and the points of measurement, callouts and construction letters reach their pages", async () => {
  const s = await style();
  const key = await issueKey();
  await call(`/api/cms/studio-link/styles/${s._id}/link`, { method: "POST", bearer: DESIGNER });
  const f = new FormData();
  f.append(
    "manifest",
    JSON.stringify({
      pom: [
        { letter: "A", code: "BD-LEN-HPS", name: "Body length from HPS", how: "HPS to hem", method: "VERT", valueMm: 720, toleranceMm: 13, critical: false, view: "front" },
        { letter: "B", code: "BD-CHEST", name: "Chest width, 1\" below armhole", how: "Side seam to side seam", method: "½", valueMm: 580, toleranceMm: 13, critical: true, view: "front" },
      ],
      callouts: [{ number: 1, text: "Collar stand, 4.0 cm at centre back", views: ["back"] }, { number: 2, text: "7 buttons down the centre front", views: ["front", "side"] }],
      pointers: [{ letter: "A", text: "Side seams: 516 safety stitch" }],
    }),
  );
  f.append("project", new Blob([Buffer.from("GRAV")]), "SHT.grav");
  f.append("renders", png(), "front.png");
  for (const view of ["front", "back"]) {
    for (const layer of ["", " pom", " callouts", " construction"]) {
      // a style whose own name says "Back", "Pom" and "Construction": the
      // kind is read from the name's ending only
      f.append("flats", new Blob(["<svg/>"], { type: "image/svg+xml" }), `Back Pom Construction - ${view}${layer}.svg`);
      f.append("flats", png(), `Back Pom Construction - ${view}${layer}.png`);
    }
  }
  const sent = await call(`/api/studio/v1/samples/${s._id}/versions`, { method: "POST", bearer: key, company: null, form: f });
  expect(sent.status).toBe(201);
  const stored = (await SampleStyle.findById(s._id).lean()).studio.versions[0];
  const kinds = [...new Set(stored.flats.map((x) => x.kind))].sort();
  expect(kinds).toEqual(["back", "backCallouts", "backConstruction", "backPom", "front", "frontCallouts", "frontConstruction", "frontPom"]);

  const { buildTechPack } = require("../../services/techpack/techPack.service");
  const pack = buildTechPack({ style: await SampleStyle.findById(s._id).lean() });
  const id = (kind) => stored.flats.find((x) => x.kind === kind && x.mimeType === "image/svg+xml").fileId;
  expect(pack.sketch.front.svg).toBe(id("front"));
  expect(pack.sketch.marked.pom.front.svg).toBe(id("frontPom"));
  expect(pack.sketch.marked.callouts.back.svg).toBe(id("backCallouts"));
  expect(pack.sketch.marked.construction.front.svg).toBe(id("frontConstruction"));
  expect(pack.markings.pom.map((p) => [p.letter, p.code, p.valueMm, p.critical])).toEqual([["A", "BD-LEN-HPS", 720, false], ["B", "BD-CHEST", 580, true]]);
  expect(pack.markings.callouts[1]).toMatchObject({ number: 2, text: "7 buttons down the centre front", views: ["front"] });
  expect(pack.markings.callouts[0].views).toEqual(["back"]);
  expect(pack.markings.pointers[0]).toMatchObject({ letter: "A" });
  expect(pack.marks.measurement).toBeUndefined();
});

test("a send without renders or project is refused, and nothing it uploaded stays behind", async () => {
  const s = await style();
  const key = await issueKey();
  const f = new FormData();
  f.append("project", new Blob(["x"]), "a.grav");
  const r = await call(`/api/studio/v1/samples/${s._id}/versions`, { method: "POST", bearer: key, company: null, form: f });
  expect(r.status).toBe(400);
  expect(r.data.error).toMatch(/render/);
  expect(files.size).toBe(0);
  const bad = versionForm();
  bad.append("renders", new Blob(["not a picture"], { type: "text/plain" }), "notes.txt");
  expect((await call(`/api/studio/v1/samples/${s._id}/versions`, { method: "POST", bearer: key, company: null, form: bad })).status).toBe(400);
  expect(files.size).toBe(0);
});

test("a key works only in its own company, and stops the moment it is revoked or the role goes", async () => {
  const mine = await style();
  const theirs = await style({ companyId: OTHER, styleCode: "OTHER-01" });
  const key = await issueKey();
  const list = await call("/api/studio/v1/samples", { bearer: key, company: null });
  expect(list.data.samples.map((x) => x.id)).toEqual([String(mine._id)]);
  expect((await call(`/api/studio/v1/samples/${theirs._id}`, { bearer: key, company: null })).status).toBe(404);

  const keyId = (await call("/api/cms/studio-link/keys", { bearer: ADMIN })).data.keys[0].keyId;
  await DepartmentRole.updateOne({ email: "dev@grav.test" }, { isActive: false });
  await DepartmentRole.create({ departmentSlug: "research-development", email: "other@grav.test", role: "editor" });
  expect((await call("/api/studio/v1/me", { bearer: key, company: null })).status).toBe(403);
  await DepartmentRole.updateOne({ email: "dev@grav.test" }, { isActive: true });
  expect((await call("/api/studio/v1/me", { bearer: key, company: null })).status).toBe(200);
  await call(`/api/cms/studio-link/keys/${keyId}/revoke`, { method: "POST", bearer: ADMIN });
  const refused = await call("/api/studio/v1/me", { bearer: key, company: null });
  expect(refused.status).toBe(401);
  expect(refused.data.error).toMatch(/revoked/);
});
