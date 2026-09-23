// test/marketing/creative-media.route.test.js
//
// THE CREATIVE MEDIA LIBRARY, AND THE PLANNER'S USE OF IT, OVER REAL ROUTES.
//
// ── WHAT THIS PINS ─────────────────────────────────────────────────────────
//   Images are verified from their bytes, stored once per company, versioned
//   immutably and shown only through an authenticated preview that re-hashes
//   what it returns. Video, GIF, SVG, WebP and renamed files are refused
//   before anything is stored, and so is an upload that did not arrive whole.
//   References are random and company-bound: another company's reference and
//   a forged one both find nothing.
//   A creative names exact versions. A newer version is never swapped in; a
//   withdrawn or vanished file stays identifiable, is not shown, and makes an
//   approval that included it no longer valid.
//   Nothing here approves for advertising, publishes or schedules.
"use strict";

jest.mock("../../Middlewear/MarketingAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    const user = JSON.parse(raw);
    if (!["marketing", "admin", "ceo"].includes(user.role) && !user.isAdmin) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }
    req.user = user;
    return next();
  };
  mw.ALLOWED_ROLES = ["marketing", "admin", "ceo"];
  return mw;
});

const crypto = require("crypto");
const http = require("http");
const { Readable } = require("stream");
const express = require("express");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const {
  MarketingCreativeMedia, MarketingCreativeMediaEvent,
} = require("../../models/CMS_Models/Marketing/MarketingCreativeMedia");
const { MarketingAdvertisingAsset } = require("../../models/CMS_Models/Marketing/MarketingAdvertisingAsset");
const M = require("../../constants/marketingCreativeMedia");

const oid = () => new mongoose.Types.ObjectId().toString();
const MARKETER = { id: oid(), name: "Mo", role: "marketing", email: "mo@grav.in" };
const MARKETER_2 = { id: oid(), name: "Meera", role: "marketing", email: "meera@grav.in" };
const ADMIN = { id: oid(), name: "Ada", role: "admin", email: "ada@grav.in" };
const SALES = { id: oid(), name: "Sal", role: "sales", email: "sal@grav.in" };

/* ── A PRIVATE STORE THAT CAN FAIL, BE TAMPERED WITH AND BE WATCHED ─────── */
const DRIVE_PREFIX = "drv-secret-";
const drive = {
  files: new Map(),
  uploads: 0,
  deletes: [],
  failUpload: false,
  failStream: false,
  async uploadCompanyFile(buffer) {
    this.uploads += 1;
    if (this.failUpload) throw new Error("storage quota exceeded for drv-internal");
    const id = `${DRIVE_PREFIX}${crypto.randomBytes(6).toString("hex")}`;
    this.files.set(id, Buffer.from(buffer));
    return { driveFileId: id, mimeType: "image/png", bytes: buffer.length };
  },
  async streamCompanyFile(id) {
    if (this.failStream) throw new Error("drive unreachable");
    const buf = this.files.get(id);
    if (!buf) throw new Error("not found");
    return { stream: Readable.from([buf]), meta: {} };
  },
  async deleteCompanyFile(id) {
    this.deletes.push(id);
    return this.files.delete(id);
  },
};

let A; let B;
let server; let base; let port;
let seq = 0;
const fresh = (p) => `${p}-${Date.now()}-${(seq += 1)}`;
const ENV_KEYS = ["MARKETING_CHANNEL_ID_SECRET", "MARKETING_COMPANY_ID"];
const saved = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const app = express();
  app.locals.marketingCreativeMediaDrive = drive;
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/creativeMedia"));
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/contentPlan"));
  await new Promise((r) => { server = app.listen(0, r); });
  port = server.address().port;
  base = `http://127.0.0.1:${port}/api/cms/marketing`;
});
afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  A = (await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") }))._id;
  B = (await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") }))._id;
  process.env.MARKETING_CHANNEL_ID_SECRET = "a-deployment-secret-long-enough";
  process.env.MARKETING_COMPANY_ID = String(A);
  drive.files.clear();
  drive.uploads = 0;
  drive.deletes = [];
  drive.failUpload = false;
  drive.failStream = false;
  await SpCompanyMembership.create([
    { companyId: A, email: MARKETER.email, personName: "Mo Khan", employeeRef: oid() },
    { companyId: A, email: ADMIN.email, personName: "Ada Rao", employeeRef: oid() },
  ]);
});

/* ═══ FILES ═══════════════════════════════════════════════════════════════ */

let pixelSeq = 0;
/* A PNG header the inspector reads for real, plus unique trailing bytes so
   every call is a different file. */
const png = (w = 1080, h = 1080) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"),
  (() => { const b = Buffer.alloc(8); b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); return b; })(),
  Buffer.from([8, 6, 0, 0, 0, 0, 0, 0, 0]),
  Buffer.from(`unique-${(pixelSeq += 1)}-${crypto.randomBytes(8).toString("hex")}`),
]);
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(64, 1)]);
const gif = () => Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64, 2)]);
const svg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const webp = () => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(64, 3)]);

/* ═══ HTTP ════════════════════════════════════════════════════════════════ */

function headers(user, company) {
  const h = { "x-test-company": String(company) };
  if (user) h["x-test-user"] = JSON.stringify(user);
  return h;
}

async function send(method, path, { user = MARKETER, company = A, body, form } = {}) {
  const h = headers(user, company);
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { h["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${base}${path}`, { method, headers: h, body: payload });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString("utf8")); } catch (_) { json = null; }
  return { status: res.status, body: json, text: buf.toString("utf8"), bytes: buf, headers: res.headers };
}

function formWith(bytes, { name = "hero.png", fields = {}, extraFile = null } = {}) {
  const form = new FormData();
  if (bytes) form.append("file", new Blob([bytes]), name);
  if (extraFile) form.append("file", new Blob([extraFile]), "second.png");
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}

const uploadNew = (bytes, opts = {}) => send("POST", "/creative-media", { ...opts, form: formWith(bytes, opts) });
const uploadVersion = (groupRef, bytes, opts = {}) => send("POST", `/creative-media/${groupRef}/versions`, { ...opts, form: formWith(bytes, opts) });
const previewOf = (mediaRef, opts) => send("GET", `/creative-media/versions/${mediaRef}/preview`, opts);

async function stored(bytes = png(), opts = {}) {
  const res = await uploadNew(bytes, opts);
  if (res.status !== 201) throw new Error(`upload failed ${res.status} ${res.text}`);
  return { ...res.body.media, bytes };
}

const nothingStored = async () => {
  expect(await MarketingCreativeMedia.countDocuments({})).toBe(0);
  expect(drive.uploads).toBe(0);
};

/* ═══ 1. UPLOAD, LIST, DETAIL, PREVIEW ════════════════════════════════════ */

describe("the library", () => {
  test("1. an image is verified, stored once, and described without any storage detail", async () => {
    const bytes = png(1200, 1500);
    const res = await uploadNew(bytes, { name: "winter hero.png", fields: { note: "Lobby shot" } });
    expect(res.status).toBe(201);
    const m = res.body.media;
    expect(m.mediaRef).toMatch(/^cmv_[0-9a-f]{32}$/);
    expect(m.groupRef).toMatch(/^cmg_[0-9a-f]{32}$/);
    expect(m).toEqual(expect.objectContaining({
      version: 1, isLatestVersion: true, kind: { code: "image", label: "Image" }, format: "PNG",
      byteSize: bytes.length, width: 1200, height: 1500,
      contentHash: crypto.createHash("sha256").update(bytes).digest("hex"),
      fileName: "winter hero.png", note: "Lobby shot", previewable: true, withdrawn: null,
    }));
    expect(m.state.code).toBe("available");
    expect(res.body.means).toMatch(/not approved for anything/);

    const row = await MarketingCreativeMedia.findOne({ mediaRef: m.mediaRef }).select("+storageRef").lean();
    expect(drive.files.get(row.storageRef).equals(bytes)).toBe(true);
    for (const text of [res.text, (await send("GET", "/creative-media")).text, (await send("GET", `/creative-media/${m.groupRef}`)).text]) {
      for (const f of [DRIVE_PREFIX, String(row._id), String(A), "storageRef", "\"_id\"", "companyId", "http://", "https://"]) {
        expect([f, text.includes(f)]).toEqual([f, false]);
      }
    }
    /* Not the advertising library, and no advertising approval. */
    expect(await MarketingAdvertisingAsset.countDocuments({})).toBe(0);
    expect(M.STATE_CODES).toEqual(["available", "withdrawn"]);
    expect(res.body.vocabulary.approvalMeans).toMatch(/does not carry over/);
  });

  test("2. the preview returns the exact bytes, privately, to this company only", async () => {
    const m = await stored();
    const ok = await previewOf(m.mediaRef);
    expect(ok.status).toBe(200);
    expect(ok.bytes.equals(m.bytes)).toBe(true);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(ok.headers.get("x-content-hash")).toBe(m.contentHash);

    expect((await previewOf(m.mediaRef, { user: null })).status).toBe(401);
    expect((await previewOf(m.mediaRef, { user: SALES })).status).toBe(403);

    const foreign = await previewOf(m.mediaRef, { company: B });
    const forged = await previewOf(`cmv_${crypto.randomBytes(16).toString("hex")}`);
    const malformed = await previewOf("../../etc/passwd");
    for (const r of [foreign, forged]) {
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("CREATIVE_MEDIA_NOT_FOUND");
    }
    expect(foreign.text).toBe(forged.text);
    expect(malformed.status).toBe(404);
    expect((await send("GET", `/creative-media/${m.groupRef}`, { company: B })).status).toBe(404);
    expect((await send("GET", "/creative-media", { company: B })).body.media).toEqual([]);
  });

  test("3. a new version is a new, immutable row; the old one is unchanged and still shown", async () => {
    const v1 = await stored();
    const v2bytes = png(1080, 1350);
    const res = await uploadVersion(v1.groupRef, v2bytes, { name: "hero-v2.png" });
    expect(res.status).toBe(201);
    const v2 = res.body.media;
    expect([v2.groupRef, v2.version, v2.isLatestVersion]).toEqual([v1.groupRef, 2, true]);
    expect(v2.mediaRef).not.toBe(v1.mediaRef);

    expect((await previewOf(v1.mediaRef)).bytes.equals(v1.bytes)).toBe(true);
    expect((await previewOf(v2.mediaRef)).bytes.equals(v2bytes)).toBe(true);

    const detail = (await send("GET", `/creative-media/${v1.groupRef}`)).body;
    expect(detail.versions.map((v) => [v.version, v.isLatestVersion])).toEqual([[2, true], [1, false]]);
    expect(detail.history.map((h) => h.action)).toEqual(["uploaded", "version_added"]);
    const list = (await send("GET", "/creative-media")).body;
    expect(list.media).toHaveLength(1);
    expect([list.media[0].version, list.media[0].versionCount]).toEqual([2, 2]);

    /* A version can never be edited or deleted, even directly. */
    await expect(MarketingCreativeMedia.updateOne({ mediaRef: v1.mediaRef }, { $set: { sha256: "0".repeat(64) } })).rejects.toThrow(/immutable/);
    await expect(MarketingCreativeMedia.deleteOne({ mediaRef: v1.mediaRef })).rejects.toThrow(/immutable/);

    /* A version for another company's file, or a forged one, finds nothing. */
    expect((await uploadVersion(v1.groupRef, png(), { company: B })).status).toBe(404);
    expect((await uploadVersion(`cmg_${crypto.randomBytes(16).toString("hex")}`, png())).status).toBe(404);
  });

  test("4. the same bytes are one version per company", async () => {
    const bytes = png();
    const first = await uploadNew(bytes);
    const again = await uploadNew(bytes);
    expect(again.status).toBe(200);
    expect(again.body.deduplicated).toBe(true);
    expect(again.body.media.mediaRef).toBe(first.body.media.mediaRef);
    expect(drive.uploads).toBe(1);

    const other = await uploadNew(bytes, { company: B });
    expect(other.status).toBe(201);
    expect(other.body.media.mediaRef).not.toBe(first.body.media.mediaRef);
  });
});

/* ═══ 2. WHAT IS REFUSED, AND THAT NOTHING IS STORED ══════════════════════ */

describe("refusals", () => {
  test("5. video, GIF, SVG, WebP and renamed files are refused by their contents", async () => {
    const video = await uploadNew(mp4(), { name: "reel.mp4" });
    expect(video.status).toBe(415);
    expect(video.body.error.details.code).toBe("video_not_supported");
    expect(video.body.error.details.blockers).toEqual(M.VIDEO_BLOCKERS.map((b) => b.code));
    expect(video.body.error.message).toMatch(/Video cannot be uploaded yet/);

    for (const [bytes, name, code] of [
      [gif(), "anim.gif", "gif_not_supported"],
      [svg(), "logo.svg", "svg_not_supported"],
      [webp(), "photo.webp", "webp_not_supported"],
      [Buffer.from("definitely not an image"), "photo.png", "not_an_image"],
      [mp4(), "disguised.png", "video_not_supported"],
    ]) {
      const res = await uploadNew(bytes, { name });
      expect([name, res.status, res.body.error.details.code]).toEqual([name, 415, code]);
    }
    await nothingStored();
  });

  test("6. size, dimensions, extra fields, missing or extra files are refused before storage", async () => {
    const tooBig = Buffer.concat([png(), Buffer.alloc(M.LIMITS.IMAGE_MAX_BYTES + 1)]);
    const big = await uploadNew(tooBig);
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("CREATIVE_MEDIA_TOO_LARGE");

    expect((await uploadNew(png(200, 200))).body.error.details.code).toBe("too_small");
    expect((await uploadNew(png(9000, 1000))).body.error.details.code).toBe("too_many_pixels");
    expect((await uploadNew(png(), { fields: { url: "https://cdn.example/x.png" } })).status).toBe(400);
    expect((await uploadNew(null, { fields: { note: "x" } })).status).toBe(400);
    expect((await uploadNew(png(), { extraFile: png() })).status).toBe(400);
    expect((await send("POST", "/creative-media", { body: { file: "iVBORw0KGgo=" } })).status).toBe(400);
    expect((await uploadNew(png(), { user: SALES })).status).toBe(403);
    await nothingStored();
  });

  test("7. an upload that is cut short stores nothing", async () => {
    /* A body that ends before its closing boundary. */
    const boundary = "----gravtest";
    const partial = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n`),
      png().subarray(0, 30),
    ]);
    const truncated = await fetch(`${base}/creative-media`, {
      method: "POST",
      headers: { ...headers(MARKETER, A), "content-type": `multipart/form-data; boundary=${boundary}` },
      body: partial,
    });
    expect(truncated.status).toBe(400);
    expect((await truncated.json()).error.code).toBe("CREATIVE_MEDIA_UPLOAD_INCOMPLETE");

    /* A connection that drops mid-file. */
    await new Promise((resolve) => {
      const req = http.request({
        host: "127.0.0.1", port, method: "POST", path: "/api/cms/marketing/creative-media",
        headers: {
          ...headers(MARKETER, A),
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": 500000,
        },
      });
      req.on("error", () => resolve());
      req.write(partial);
      setTimeout(() => { req.destroy(); setTimeout(resolve, 300); }, 100);
    });
    await nothingStored();
  });

  test("8. storage failures leave no record, and no orphaned file", async () => {
    drive.failUpload = true;
    const down = await uploadNew(png());
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("CREATIVE_MEDIA_STORAGE_UNAVAILABLE");
    expect(down.text).not.toContain("drv-internal");
    expect(await MarketingCreativeMedia.countDocuments({})).toBe(0);
    drive.failUpload = false;

    const spy = jest.spyOn(MarketingCreativeMedia, "create").mockRejectedValueOnce(new Error("write concern failed"));
    const unrecorded = await uploadNew(png());
    spy.mockRestore();
    expect(unrecorded.status).toBe(503);
    expect(drive.deletes).toHaveLength(1);
    expect(drive.files.size).toBe(0);
    expect(await MarketingCreativeMedia.countDocuments({})).toBe(0);

    const m = await stored();
    drive.failStream = true;
    const unreadable = await previewOf(m.mediaRef);
    expect(unreadable.status).toBe(503);
  });

  test("9. bytes changed in storage are never shown", async () => {
    const m = await stored();
    const row = await MarketingCreativeMedia.findOne({ mediaRef: m.mediaRef }).select("+storageRef").lean();
    drive.files.set(row.storageRef, png());
    const res = await previewOf(m.mediaRef);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CREATIVE_MEDIA_INTEGRITY_FAILED");
  });
});

/* ═══ 3. WITHDRAWAL ═══════════════════════════════════════════════════════ */

describe("withdrawal", () => {
  test("10. only the uploader or an approver withdraws, with a reason; then it is never shown", async () => {
    const m = await stored();
    const path = `/creative-media/versions/${m.mediaRef}/withdraw`;
    expect((await send("POST", path, { body: {} })).status).toBe(400);
    const other = await send("POST", path, { user: MARKETER_2, body: { reason: "Wrong shot" } });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe("CREATIVE_MEDIA_FORBIDDEN");
    expect((await send("POST", path, { company: B, user: ADMIN, body: { reason: "x" } })).status).toBe(404);

    const ok = await send("POST", path, { body: { reason: "Model release expired" } });
    expect(ok.status).toBe(200);
    expect(ok.body.media.state.code).toBe("withdrawn");
    expect(ok.body.media.previewable).toBe(false);
    expect(ok.body.media.withdrawn).toEqual(expect.objectContaining({ by: "Mo", reason: "Model release expired" }));

    const hidden = await previewOf(m.mediaRef);
    expect(hidden.status).toBe(409);
    expect(hidden.body.error.code).toBe("CREATIVE_MEDIA_WITHDRAWN");

    /* Uploading the same file again does not quietly bring it back. */
    const again = await uploadNew(m.bytes);
    expect(again.body.deduplicated).toBe(true);
    expect(again.body.media.state.code).toBe("withdrawn");
    expect(await MarketingCreativeMediaEvent.countDocuments({ mediaRef: m.mediaRef, action: "withdrawn" })).toBe(1);

    const byAdmin = await stored();
    expect((await send("POST", `/creative-media/versions/${byAdmin.mediaRef}/withdraw`, { user: ADMIN, body: { reason: "Off brand" } })).status).toBe(200);
  });
});

/* ═══ 4. IN A CREATIVE DRAFT ══════════════════════════════════════════════ */

const POST_ITEM = Object.freeze({
  title: "Winter teaser", contentType: "social_post", channel: "social",
  brief: "Tease the range.", ownerRef: "self",
  planned: { date: "2026-10-20", time: "11:00", timeZone: "Asia/Kolkata" },
});
const creativeUsing = (mediaRef) => ({
  concept: "Staff in the winter range.",
  variants: [{
    platform: "instagram", format: "single_image", caption: "Winter, tailored.",
    references: [{ kind: "media", mediaRef }],
  }],
});
async function createPost(creative, opts = {}) {
  const res = await send("POST", "/content-plan/items", { ...opts, body: { idempotencyKey: fresh("key-cm"), ...POST_ITEM, creative } });
  if (res.status !== 201) throw new Error(`create failed ${res.status} ${res.text}`);
  return res.body.item;
}
const act = (item, action, { user = MARKETER, reason, fingerprint } = {}) => send("POST", `/content-plan/items/${item.itemRef}/actions`, {
  user,
  body: { expectedRevision: item.revision, action, ...(reason ? { reason } : {}), ...(fingerprint ? { creativeFingerprint: fingerprint } : {}) },
});
const itemOf = async (item) => (await send("GET", `/content-plan/items/${item.itemRef}`)).body.item;
const refOf = (item) => item.creative.variants[0].references[0];

describe("in the Content Planner", () => {
  test("11. a creative names one exact version, and a different version is a different creative", async () => {
    const v1 = await stored();
    const v2 = (await uploadVersion(v1.groupRef, png())).body.media;
    const item = await createPost(creativeUsing(v1.mediaRef));
    expect(refOf(item)).toEqual({
      kind: { code: "media", label: "File from the creative media library" },
      mediaRef: v1.mediaRef, groupRef: v1.groupRef, version: 1,
      fileName: "hero.png", format: "PNG", width: 1080, height: 1080, contentHash: v1.contentHash,
      status: { code: "available", label: "In the creative media library" },
      previewable: true,
      newerVersionAvailable: true,
    });

    const switched = await send("PATCH", `/content-plan/items/${item.itemRef}`, {
      body: { expectedRevision: item.revision, creative: { ...creativeUsing(v2.mediaRef), variants: [{ ...creativeUsing(v2.mediaRef).variants[0], variantRef: item.creative.variants[0].variantRef }] } },
    });
    expect(switched.status).toBe(200);
    expect(switched.body.unchanged).toBe(false);
    expect(switched.body.item.creative.fingerprint).not.toBe(item.creative.fingerprint);
    expect(refOf(switched.body.item).newerVersionAvailable).toBe(false);
  });

  test("12. foreign, forged and withdrawn files cannot be put into a creative", async () => {
    const theirs = await stored(png(), { company: B });
    const withdrawn = await stored();
    await send("POST", `/creative-media/versions/${withdrawn.mediaRef}/withdraw`, { body: { reason: "Old" } });
    for (const [why, ref] of [
      ["foreign", theirs.mediaRef],
      ["forged", `cmv_${crypto.randomBytes(16).toString("hex")}`],
      ["garbage", "../x"],
      ["withdrawn", withdrawn.mediaRef],
    ]) {
      const res = await send("POST", "/content-plan/items", { body: { idempotencyKey: fresh("key-x"), ...POST_ITEM, creative: creativeUsing(ref) } });
      expect([why, res.status, res.body.error.code]).toEqual([why, 422, "CONTENT_PLAN_LINK_NOT_FOUND"]);
      expect(res.body.error.details.field).toBe("creative.variants[0].references[0].mediaRef");
    }
    const mixed = creativeUsing(withdrawn.mediaRef);
    mixed.variants[0].references[0].assetId = "x";
    expect((await send("POST", "/content-plan/items", { body: { idempotencyKey: fresh("key-y"), ...POST_ITEM, creative: mixed } })).status).toBe(400);
  });

  test("13. an approval stands while its files do; a withdrawn file invalidates it and is not replaced", async () => {
    const v1 = await stored();
    const item = await createPost(creativeUsing(v1.mediaRef));
    const submitted = (await act(item, "submit")).body.item;
    const approved = (await act(submitted, "approve", { user: ADMIN, fingerprint: submitted.creative.fingerprint })).body.item;
    expect(approved.approval).toEqual(expect.objectContaining({ valid: true, mediaIntact: true, invalidBecause: [] }));

    /* A newer version of the file does not touch what was approved. */
    await uploadVersion(v1.groupRef, png());
    let now = await itemOf(item);
    expect(now.approval.valid).toBe(true);
    expect(refOf(now).mediaRef).toBe(v1.mediaRef);
    expect(refOf(now).newerVersionAvailable).toBe(true);

    /* Withdrawing the approved version does. */
    await send("POST", `/creative-media/versions/${v1.mediaRef}/withdraw`, { user: ADMIN, body: { reason: "Model release expired" } });
    now = await itemOf(item);
    expect(now.approval).toEqual(expect.objectContaining({
      matchesCurrentCreative: true, mediaIntact: false, valid: false, invalidBecause: ["media_withdrawn"],
    }));
    expect(refOf(now)).toEqual(expect.objectContaining({
      mediaRef: v1.mediaRef, version: 1, contentHash: v1.contentHash, fileName: "hero.png",
      status: { code: "withdrawn", label: "Withdrawn from the creative media library" }, previewable: false,
    }));
    expect(now.unavailableMedia).toEqual([expect.objectContaining({ reference: v1.mediaRef, status: "withdrawn" })]);
    /* Planned date and actual publication are untouched by any of this. */
    expect(now.planned.date).toBe("2026-10-20");
    expect(now.actual).toEqual({ scheduledAt: null, publishedAt: null, source: null, checkedAt: null });
  });

  test("14. a creative whose file is withdrawn or gone cannot be submitted or approved", async () => {
    const gone = await stored();
    const item = await createPost(creativeUsing(gone.mediaRef));
    const submitted = (await act(item, "submit")).body.item;

    await MarketingCreativeMedia.collection.deleteOne({ mediaRef: gone.mediaRef });
    const view = await itemOf(item);
    expect(refOf(view).status.code).toBe("missing");
    expect(refOf(view).previewable).toBe(false);
    expect(view.viewerActions.approve.reason).toBe("approver_only");
    expect((await send("GET", `/content-plan/items/${item.itemRef}`, { user: ADMIN })).body.item.viewerActions.approve.reason).toBe("media_unavailable");

    const refused = await act(submitted, "approve", { user: ADMIN });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.unavailableMedia).toEqual([expect.objectContaining({ status: "missing", reference: gone.mediaRef })]);

    const w = await stored();
    const draft = await createPost(creativeUsing(w.mediaRef));
    await send("POST", `/creative-media/versions/${w.mediaRef}/withdraw`, { body: { reason: "Wrong" } });
    const notSubmitted = await act(draft, "submit");
    expect(notSubmitted.status).toBe(409);
    expect(notSubmitted.body.error.details.unavailableMedia[0].status).toBe("withdrawn");
  });

  test("15. the planner and the library add no publishing, scheduling or advertising route", () => {
    const routesOf = (r) => r.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).map((m) => `${m} ${l.route.path}`)).sort();
    expect(routesOf(require("../../routes/CMS_Routes/Marketing/creativeMedia"))).toEqual([
      "get /creative-media", "get /creative-media/:groupRef", "get /creative-media/versions/:mediaRef/preview",
      "post /creative-media", "post /creative-media/:groupRef/versions", "post /creative-media/versions/:mediaRef/withdraw",
    ]);
  });
});

/* ═══ 5. CORRECTIONS: ONE APPROVAL DECISION, WITHDRAW ACTIONS, HEADER ═════ */

describe("approval status on every read", () => {
  /* Row, calendar entry and detail for one item. */
  async function threeViews(item, user = MARKETER) {
    const list = await send("GET", "/content-plan/items", { user });
    const cal = await send("GET", "/content-plan/calendar?from=2026-10-01&to=2026-10-31&timeZone=Asia/Kolkata", { user });
    const detail = await send("GET", `/content-plan/items/${item.itemRef}`, { user });
    return {
      row: list.body.items.find((i) => i.itemRef === item.itemRef),
      entry: cal.body.items.find((i) => i.itemRef === item.itemRef),
      detail: detail.body.item,
      rowText: JSON.stringify(list.body.items.find((i) => i.itemRef === item.itemRef)),
      entryText: JSON.stringify(cal.body.items.find((i) => i.itemRef === item.itemRef)),
    };
  }

  async function approvedWith(m) {
    const item = await createPost(creativeUsing(m.mediaRef));
    const submitted = (await act(item, "submit")).body.item;
    return (await act(submitted, "approve", { user: ADMIN, fingerprint: submitted.creative.fingerprint })).body.item;
  }

  const expectAgreement = (v, code, reasons) => {
    for (const view of [v.row, v.entry, v.detail]) {
      expect(view.state.code).toBe("approved");
      expect(view.approvalStatus.code).toBe(code);
      expect(view.approvalStatus.invalidBecause.map((r) => r.code)).toEqual(reasons);
      expect(view.unavailableMediaCount).toBe(reasons.length ? 1 : 0);
    }
    expect(v.detail.approval.valid).toBe(code === "valid");
    expect(v.detail.approval.invalidBecause).toEqual(reasons);
  };

  test("16. while its file stands, every read says the approval stands", async () => {
    const m = await stored();
    const item = await approvedWith(m);
    const v = await threeViews(item);
    expectAgreement(v, "valid", []);
    expect(v.row.approvalStatus).toEqual({
      code: "valid", label: "Approval stands", means: expect.any(String), invalidBecause: [],
    });
  });

  test("17. after withdrawal, list, calendar and detail all say the approval no longer stands", async () => {
    const m = await stored();
    const item = await approvedWith(m);
    await send("POST", `/creative-media/versions/${m.mediaRef}/withdraw`, { user: ADMIN, body: { reason: "Model release expired" } });

    const v = await threeViews(item);
    expectAgreement(v, "invalid", ["media_withdrawn"]);
    expect(v.row.approvalStatus.label).toBe("Approval no longer stands");
    expect(v.row.approvalStatus.invalidBecause).toEqual([{ code: "media_withdrawn", label: "A file in it was withdrawn" }]);
    /* The rows carry the decision, not the file. */
    for (const text of [v.rowText, v.entryText]) {
      for (const leak of [m.mediaRef, m.groupRef, m.contentHash, "hero.png", DRIVE_PREFIX]) {
        expect([leak, text.includes(leak)]).toEqual([leak, false]);
      }
    }
    /* Only the detail names the file, in the creative media library's words. */
    expect(refOf(v.detail).status).toEqual({ code: "withdrawn", label: "Withdrawn from the creative media library" });
  });

  test("18. a missing file gives the same answer everywhere", async () => {
    const m = await stored();
    const item = await approvedWith(m);
    await MarketingCreativeMedia.collection.deleteOne({ mediaRef: m.mediaRef });
    const v = await threeViews(item);
    expectAgreement(v, "invalid", ["media_missing"]);
    expect(refOf(v.detail).status).toEqual({ code: "missing", label: "No longer in the creative media library" });
  });

  test("19. a stored copy found changed invalidates the approval everywhere, and recovers if restored", async () => {
    const m = await stored();
    const item = await approvedWith(m);
    const row = await MarketingCreativeMedia.findOne({ mediaRef: m.mediaRef }).select("+storageRef").lean();
    drive.files.set(row.storageRef, png());
    expect((await previewOf(m.mediaRef)).status).toBe(409);

    let v = await threeViews(item);
    expectAgreement(v, "invalid", ["media_changed"]);
    expect(refOf(v.detail).status).toEqual({ code: "changed", label: "Stored copy changed" });
    expect(refOf(v.detail).previewable).toBe(false);
    const lib = (await send("GET", `/creative-media/${m.groupRef}`)).body.versions[0];
    expect([lib.previewable, lib.storedCopyChanged]).toEqual([false, true]);

    /* The exact bytes are put back: the next preview confirms them. */
    drive.files.set(row.storageRef, m.bytes);
    expect((await previewOf(m.mediaRef)).status).toBe(200);
    v = await threeViews(item);
    expectAgreement(v, "valid", []);
  });

  test("20. an item never approved says so, whatever its files", async () => {
    const m = await stored();
    const item = await createPost(creativeUsing(m.mediaRef));
    await send("POST", `/creative-media/versions/${m.mediaRef}/withdraw`, { body: { reason: "x" } });
    const v = await threeViews(item);
    for (const view of [v.row, v.entry, v.detail]) {
      expect(view.approvalStatus.code).toBe("not_approved");
      expect(view.unavailableMediaCount).toBe(1);
      expect(view.viewerActions.submit.reason).toBe("media_unavailable");
    }
    expect(v.detail.approval).toBeNull();
  });
});

describe("withdraw actions on the library", () => {
  const withdrawOf = (view) => view.viewerActions.withdraw;

  test("21. list and detail offer withdraw exactly as the server allows it", async () => {
    const m = await stored();
    const listFor = async (user) => (await send("GET", "/creative-media", { user })).body.media[0];
    const detailFor = async (user) => (await send("GET", `/creative-media/${m.groupRef}`, { user })).body.versions[0];

    for (const view of [await listFor(MARKETER), await detailFor(MARKETER)]) {
      expect(withdrawOf(view)).toEqual({ allowed: true, reason: null, reasonLabel: null, reasonRequired: true });
    }
    for (const view of [await listFor(MARKETER_2), await detailFor(MARKETER_2)]) {
      expect(withdrawOf(view)).toEqual({
        allowed: false, reason: "not_uploader",
        reasonLabel: "Only the person who uploaded this version, an administrator or the CEO can withdraw it.",
        reasonRequired: true,
      });
    }
    const CEO = { id: oid(), name: "Chandra", role: "ceo", email: "ceo@grav.in" };
    for (const user of [ADMIN, CEO]) expect(withdrawOf(await detailFor(user)).allowed).toBe(true);

    /* The server enforces it regardless of what a screen offers. */
    const refused = await send("POST", `/creative-media/versions/${m.mediaRef}/withdraw`, { user: MARKETER_2, body: { reason: "x" } });
    expect(refused.status).toBe(403);

    const done = await send("POST", `/creative-media/versions/${m.mediaRef}/withdraw`, { user: ADMIN, body: { reason: "Off brand" } });
    expect(withdrawOf(done.body.media)).toEqual(expect.objectContaining({ allowed: false, reason: "already_withdrawn" }));
    for (const user of [MARKETER, MARKETER_2, ADMIN]) {
      expect(withdrawOf(await detailFor(user)).reason).toBe(user === MARKETER_2 ? "not_uploader" : "already_withdrawn");
    }
    const vocab = (await send("GET", "/creative-media")).body.vocabulary.withdrawRefusals.map((r) => r.code);
    expect(vocab).toEqual(["marketing_only", "not_uploader", "already_withdrawn"]);
  });

  test("22. another company's administrator sees nothing to withdraw and cannot withdraw it", async () => {
    const m = await stored();
    const B_ADMIN = { id: oid(), name: "Bea", role: "admin", email: "bea@other.co" };
    expect((await send("GET", "/creative-media", { user: B_ADMIN, company: B })).body.media).toEqual([]);
    expect((await send("GET", `/creative-media/${m.groupRef}`, { user: B_ADMIN, company: B })).status).toBe(404);
    const refused = await send("POST", `/creative-media/versions/${m.mediaRef}/withdraw`, { user: B_ADMIN, company: B, body: { reason: "x" } });
    expect(refused.status).toBe(404);
    expect((await MarketingCreativeMedia.findOne({ mediaRef: m.mediaRef }).lean()).state).toBe("available");

    /* Their own upload is theirs to withdraw, in their company only. */
    const theirs = await stored(png(), { user: B_ADMIN, company: B });
    expect((await send("GET", `/creative-media/${theirs.groupRef}`, { user: B_ADMIN, company: B })).body.versions[0].viewerActions.withdraw.allowed).toBe(true);
    expect((await send("GET", `/creative-media/${theirs.groupRef}`)).status).toBe(404);
  });
});

describe("the preview's hash header under CORS", () => {
  test("23. an admitted origin can read X-Content-Hash on the preview, and only there", async () => {
    const cors = require("cors");
    const app = express();
    app.locals.marketingCreativeMediaDrive = drive;
    app.use(cors({ origin: ["https://cms.grav.in"], credentials: true }));
    app.use((req, res, next) => { req.__marketingCompanyId = new mongoose.Types.ObjectId(String(A)); next(); });
    app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/creativeMedia"));
    const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const at = `http://127.0.0.1:${srv.address().port}/api/cms/marketing`;
    try {
      const m = await stored();
      const h = { ...headers(MARKETER, A), Origin: "https://cms.grav.in" };
      const ok = await fetch(`${at}/creative-media/versions/${m.mediaRef}/preview`, { headers: h });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBe("https://cms.grav.in");
      expect(ok.headers.get("access-control-expose-headers")).toBe("X-Content-Hash");
      expect(ok.headers.get("x-content-hash")).toBe(m.contentHash);
      /* The header is a witness: the bytes still hash to it. */
      const bytes = Buffer.from(await ok.arrayBuffer());
      expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(m.contentHash);

      /* Nothing else is exposed, and a stranger origin is admitted to nothing. */
      const list = await fetch(`${at}/creative-media`, { headers: h });
      expect(list.headers.get("access-control-expose-headers")).toBeNull();
      const stranger = await fetch(`${at}/creative-media/versions/${m.mediaRef}/preview`, {
        headers: { ...headers(MARKETER, A), Origin: "https://evil.example" },
      });
      expect(stranger.headers.get("access-control-allow-origin")).toBeNull();
      /* A refused preview exposes nothing either. */
      await send("POST", `/creative-media/versions/${m.mediaRef}/withdraw`, { body: { reason: "x" } });
      const gone = await fetch(`${at}/creative-media/versions/${m.mediaRef}/preview`, { headers: h });
      expect(gone.status).toBe(409);
      expect(gone.headers.get("x-content-hash")).toBeNull();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe("wording", () => {
  test("24. creative-media and advertising-library references are each named for their own library", () => {
    const C = require("../../constants/marketingContentPlan");
    const words = JSON.stringify(C.REFERENCE_STATUS_BY_KIND.media);
    expect(words).toMatch(/creative media library/);
    expect(words).not.toMatch(/advertising/);
    expect(JSON.stringify(C.REFERENCE_STATUS_BY_KIND.image)).toMatch(/advertising image library/);
    /* No generic "image library" wording is left for a media reference. */
    expect(JSON.stringify(C.REFERENCE_STATUS)).not.toMatch(/image library/);
    expect(C.REFERENCE_KINDS.find((k) => k.code === "image").label).toBe("Image from the advertising image library");
  });
});
