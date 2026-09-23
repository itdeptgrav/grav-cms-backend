// test/marketing/advertising-assets.test.js
//
// THE ADVERTISING IMAGE LIBRARY.
//
// ── WHAT THESE PROVE, IN ONE SENTENCE ──────────────────────────────────────
// That nothing a caller SAYS about a file is believed, and that storing bytes
// is not the same as being allowed to publish them.
//
// A filename is a string somebody typed. A multipart `Content-Type` is a string
// a browser guessed. Neither has ever been evidence about the contents of a
// file, and the bytes here end up in a paid advertisement that GRAV pays for
// and a third party publishes.
"use strict";

const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/MarketingAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    const user = JSON.parse(raw);
    if (!["marketing", "admin", "ceo"].includes(user.role) && !user.isAdmin) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }
    req.user = user;
    next();
  };
  mw.withRoles = () => mw;
  mw.ALLOWED_ROLES = ["marketing", "admin", "ceo"];
  return mw;
});

/* ── THE STORAGE TRANSPORT, FAKED AT THE MODULE BOUNDARY ────────────────────
   The service reuses the existing company Drive service rather than building a
   second file system. Here that module is replaced wholesale: these tests are
   about what GRAV decides, not about Google Drive. */
jest.mock("../../services/companyDrive.service", () => {
  const files = new Map();
  let n = 0;
  return {
    __files: files,
    uploadCompanyFile: jest.fn(async (buffer, { fileName, mimeType }) => {
      n += 1;
      const driveFileId = `drive-${n}`;
      files.set(driveFileId, { buffer: Buffer.from(buffer), fileName, mimeType });
      return { driveFileId, mimeType, bytes: buffer.length };
    }),
    streamCompanyFile: jest.fn(async (driveFileId) => {
      const stored = files.get(driveFileId);
      if (!stored) throw new Error("not found");
      const { Readable } = require("stream");
      return { stream: Readable.from([stored.buffer]), meta: { name: stored.fileName, mimeType: stored.mimeType } };
    }),
    deleteCompanyFile: jest.fn(async () => true),
  };
});

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const {
  MarketingAdvertisingAsset,
  MarketingAdvertisingAssetHistory,
} = require("../../models/CMS_Models/Marketing/MarketingAdvertisingAsset");
const assets = require("../../services/marketing/assets/advertisingAsset.service");
const imageBytes = require("../../services/marketing/assets/imageBytes");
const companyDrive = require("../../services/companyDrive.service");

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo", role: "marketing" };
const OTHER_MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Max", role: "marketing" };
const ADMIN = { id: new mongoose.Types.ObjectId().toString(), name: "Ada", role: "admin" };

const ENV_KEYS = ["MARKETING_CHANNEL_ID_SECRET"];
const savedEnv = {};
let app; let server; let base; let A; let B;

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  app = express();
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/advertisingAssets"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  const a = await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") });
  const b = await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") });
  A = a._id;
  B = b._id;
  process.env.MARKETING_CHANNEL_ID_SECRET = "a-deployment-secret-long-enough";
  companyDrive.__files.clear();
  jest.clearAllMocks();
});

/* ═══════════════════════════════════════════════════════════════════════════
   REAL BYTES
   ───────────────────────────────────────────────────────────────────────────
   Built here rather than committed as fixtures, so a test can say exactly what
   it is making — a 1200x628 PNG, a JPEG whose header lies — and a reader can
   see why each one is the shape it is.
   ═══════════════════════════════════════════════════════════════════════════ */

const pngOf = (width, height, padding = 0) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from("IHDR"),
  (() => { const b = Buffer.alloc(8); b.writeUInt32BE(width, 0); b.writeUInt32BE(height, 4); return b; })(),
  Buffer.from([8, 6, 0, 0, 0]),
  Buffer.alloc(padding, 7),
]);

const jpegOf = (width, height, padding = 0) => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  /* An APP0 segment, so the walk has something to skip before the frame — a
     real JPEG always has one and a parser that assumed the frame came first
     would pass a test built without it. */
  Buffer.from([0xff, 0xe0, 0x00, 0x10]),
  Buffer.from("JFIF\0\0\0\0\0\0", "latin1"),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
  (() => { const b = Buffer.alloc(4); b.writeUInt16BE(height, 0); b.writeUInt16BE(width, 2); return b; })(),
  Buffer.alloc(10),
  Buffer.alloc(padding, 9),
]);

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const uploadFor = (company, user, buffer, payload = {}) => assets.upload({
  companyId: company, user, buffer, payload,
});

const approve = (company, assetId, user = ADMIN, over = {}) => assets.review({
  companyId: company, user, assetId, decision: "approve",
  payload: {
    authorisedToUse: true,
    approvedForAdvertising: true,
    reviewedThisVersion: true,
    ...over,
  },
});

const call = async (p, { user = MARKETER, method = "GET", company = null } = {}) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { "x-test-user": JSON.stringify(user), "x-test-company": String(company || A) },
  });
  const type = res.headers.get("content-type") || "";
  return {
    status: res.status,
    headers: res.headers,
    body: type.includes("json") ? await res.json() : null,
    bytes: type.includes("json") ? null : Buffer.from(await res.arrayBuffer()),
  };
};

/* ═══════════════════════════════════════════════════════════════════════════
   1–6. WHAT THE BYTES ARE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("reading a file GRAV was given", () => {
  test("1. a real JPEG and a real PNG are accepted, and their size is read from the bytes", async () => {
    const png = pngOf(1200, 628);
    const out = await uploadFor(A, MARKETER, png, { fileName: "winter.png" });

    expect(out.asset.format).toBe("PNG");
    /* ── DIMENSIONS FROM THE HEADER, NOT FROM A FIELD ────────────────────
       There is no field to supply them in. They are parsed out of the file's
       own IHDR chunk. */
    expect(out.asset.width).toBe(1200);
    expect(out.asset.height).toBe(628);
    expect(out.asset.byteSize).toBe(png.length);
    /* ── AND THE HASH IS OVER EXACTLY WHAT ARRIVED ───────────────────────
       Not a re-encoded or normalised copy. This is what makes a stored version
       immutable in fact rather than by convention. */
    expect(out.asset.contentHash).toBe(sha(png));

    const jpg = jpegOf(1080, 1080);
    const out2 = await uploadFor(A, MARKETER, jpg, { fileName: "square.jpg" });
    expect(out2.asset.format).toBe("JPEG");
    expect(out2.asset.width).toBe(1080);
    expect(out2.asset.height).toBe(1080);
    expect(out2.asset.contentHash).toBe(sha(jpg));

    /* Both uploaded, both awaiting review — storing is not approving. */
    expect(out.asset.state).toBe("awaiting_review");
    expect(out.asset.usableInAdvertising).toBe(false);
  });

  test("2. the filename and the MIME type are not believed", async () => {
    /* ── A PNG CALLED .jpg IS A USABLE PNG ────────────────────────────────
       The bytes decide the format, so the disagreement is RECORDED rather than
       refused: it is usually somebody's export settings. */
    const png = pngOf(1200, 1200);
    const out = await uploadFor(A, MARKETER, png, { fileName: "actually-a-png.jpg" });
    expect(out.asset.format).toBe("PNG");
    expect(out.asset.extensionAgreedWithBytes).toBe(false);

    const honest = await uploadFor(A, MARKETER, jpegOf(900, 900), { fileName: "real.jpg" });
    expect(honest.asset.extensionAgreedWithBytes).toBe(true);

    /* And a file with nothing but a plausible name is refused outright. */
    await expect(uploadFor(A, MARKETER, Buffer.from("this is just text"), { fileName: "photo.jpg" }))
      .rejects.toMatchObject({ code: "VALIDATION" });
  });

  test("3. a forged image signature is refused", async () => {
    /* ── THE SIGNATURE IS NOT THE FILE ────────────────────────────────────
       Two bytes of JPEG magic in front of anything makes a file that passes a
       naive magic-number check. GRAV parses the header far enough to read the
       dimensions, so a forgery that carries no frame is caught. */
    const forged = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from("not really a jpeg at all")]);
    const err = await uploadFor(A, MARKETER, forged, { fileName: "forged.jpg" }).catch((e) => e);
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toMatch(/could not read this file as a JPEG or a PNG/i);
    expect(err.details.code).toBe("SIGNATURE_MISMATCH");

    /* A PNG signature with a corrupt IHDR is the same class of forgery. */
    const badPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]), Buffer.from("XXXX"), Buffer.alloc(16),
    ]);
    await expect(uploadFor(A, MARKETER, badPng, { fileName: "bad.png" }))
      .rejects.toMatchObject({ code: "VALIDATION" });

    /* Nothing reached storage. */
    expect(companyDrive.uploadCompanyFile).not.toHaveBeenCalled();
    expect(await MarketingAdvertisingAsset.countDocuments({})).toBe(0);
  });

  test("4. an SVG is refused, and so is every other format that is not a picture", async () => {
    const cases = [
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), /document that can carry scripts/i],
      [Buffer.from('<?xml version="1.0"?><svg><rect/></svg>'), /document that can carry scripts/i],
      [Buffer.from("<!DOCTYPE html><html><body>hi</body></html>"), /not an image/i],
      [Buffer.from("%PDF-1.7\nstuff"), /document/i],
      [Buffer.from("GIF89a  "), /may be animated/i],
      [Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]), /without a decoder/i],
      [Buffer.concat([Buffer.alloc(4), Buffer.from("ftypmp42"), Buffer.alloc(8)]), /single image/i],
    ];

    for (const [buffer, why] of cases) {
      const err = await uploadFor(A, MARKETER, buffer, { fileName: "thing.jpg" }).catch((e) => e);
      expect(err.code).toBe("VALIDATION");
      /* ── EACH REFUSED FOR ITS OWN REASON ──────────────────────────────
         "Unsupported format" tells somebody nothing about why the file they
         are certain is fine has been rejected. */
      expect(err.message).toMatch(why);
    }

    expect(companyDrive.uploadCompanyFile).not.toHaveBeenCalled();
    expect(await MarketingAdvertisingAsset.countDocuments({})).toBe(0);
  });

  test("5. an image too small for advertising is refused, and an oversized one never reaches storage", async () => {
    const small = await uploadFor(A, MARKETER, pngOf(200, 200), { fileName: "tiny.png" }).catch((e) => e);
    expect(small.details.code).toBe("TOO_SMALL");
    expect(small.message).toMatch(/200 by 200 pixels/);

    /* ── THE CEILING IS ENFORCED BEFORE THE STORAGE WRITE ─────────────────
       A rejected upload must leave nothing behind. The route enforces it again
       while the bytes are still arriving; this is the service's own guard. */
    const huge = pngOf(1200, 1200, 9 * 1024 * 1024);
    const err = await uploadFor(A, MARKETER, huge, { fileName: "huge.png" }).catch((e) => e);
    expect(err.details.code).toBe("TOO_LARGE");

    expect(companyDrive.uploadCompanyFile).not.toHaveBeenCalled();
    expect(await MarketingAdvertisingAsset.countDocuments({})).toBe(0);
  });

  test("6. a pointer is not an asset, whatever it is called", async () => {
    /* ── EACH OF THESE IS SOMEBODY OFFERING A REFERENCE ───────────────────
       GRAV cannot hash a pointer, cannot size it, cannot prove it will resolve
       tomorrow and cannot prove the company may advertise with whatever is on
       the other end. */
    const png = pngOf(1200, 1200);
    const pointers = [
      ["imageUrl", /web address/i],
      ["sourceUrl", /web address/i],
      ["driveFileId", /storage identifier/i],
      ["storageRef", /storage identifier/i],
      ["imageHash", /channel's own image identifier/i],
      ["attachmentId", /email attachment|address the marketing engine/i],
      ["contentId", /email attachment|address the marketing engine/i],
    ];

    for (const [field, why] of pointers) {
      const err = await uploadFor(A, MARKETER, png, { fileName: "x.png", [field]: "anything" }).catch((e) => e);
      expect(err.code).toBe("VALIDATION");
      expect(err.message).toMatch(why);
      expect(err.details.code).toBe("POINTER_NOT_BYTES");
    }

    /* And a field that is simply not part of an upload is refused by name
       rather than dropped — a dropped field returns 200 and the sender believes
       it was used. */
    await expect(uploadFor(A, MARKETER, png, { fileName: "x.png", width: 9999 }))
      .rejects.toMatchObject({ code: "VALIDATION" });

    expect(await MarketingAdvertisingAsset.countDocuments({})).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   7–12. STORING IS NOT APPROVING
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the decision about an image", () => {
  test("7. the uploader cannot approve their own upload", async () => {
    const out = await uploadFor(A, MARKETER, pngOf(1200, 628), { fileName: "hero.png" });

    /* ── ONE PERSON WHO CAN DO BOTH IS ONE MISTAKE FROM A LIVE AD ──────────
       The same separation the campaign plan enforces on approval. */
    const asMarketer = await assets.review({
      companyId: A, user: MARKETER, assetId: out.asset.assetId, decision: "approve",
      payload: { authorisedToUse: true, approvedForAdvertising: true, reviewedThisVersion: true },
    }).catch((e) => e);
    expect(asMarketer.code).toBe("CAMPAIGN_DRAFT_DECISION_FORBIDDEN");

    /* Nor may a second marketer — deciding the company may pay to publish is an
       administrator's call, whoever uploaded it. */
    const asOther = await assets.review({
      companyId: A, user: OTHER_MARKETER, assetId: out.asset.assetId, decision: "approve",
      payload: { authorisedToUse: true, approvedForAdvertising: true, reviewedThisVersion: true },
    }).catch((e) => e);
    expect(asOther.code).toBe("CAMPAIGN_DRAFT_DECISION_FORBIDDEN");

    const approved = await approve(A, out.asset.assetId);
    expect(approved.asset.state).toBe("approved");
    expect(approved.asset.usableInAdvertising).toBe(true);
    expect(approved.asset.approvedBy.name).toBe("Ada");
  });

  test("8. an approval confirms three things, and a missing one refuses it", async () => {
    const out = await uploadFor(A, MARKETER, pngOf(1200, 628), { fileName: "hero.png" });

    /* ── A SINGLE BUTTON LETS SOMEBODY APPROVE WITHOUT DECIDING ───────────
       Each assertion is a separate statement, and all three are stored so an
       audit shows what was claimed. */
    for (const missing of ["authorisedToUse", "approvedForAdvertising", "reviewedThisVersion"]) {
      const err = await approve(A, out.asset.assetId, ADMIN, { [missing]: false }).catch((e) => e);
      expect(err.details.code).toBe("ASSERTIONS_INCOMPLETE");
      expect(err.details.missing).toContain(missing);
    }

    /* ── AND THE REVIEWER SAW THESE BYTES ─────────────────────────────────
       An approval quoting a different hash is an approval of something else. */
    const wrongVersion = await approve(A, out.asset.assetId, ADMIN, { expectedSha256: sha(Buffer.from("other")) })
      .catch((e) => e);
    expect(wrongVersion.details.code).toBe("VERSION_MISMATCH");

    const good = await approve(A, out.asset.assetId, ADMIN, { expectedSha256: out.asset.contentHash });
    expect(good.asset.state).toBe("approved");

    const { history } = await assets.detail({ companyId: A, assetId: out.asset.assetId });
    const decision = history.find((h) => h.action === "approve");
    expect(decision.assertions).toEqual({
      authorisedToUse: true, approvedForAdvertising: true, reviewedThisVersion: true,
    });
    expect(decision.contentHash).toBe(out.asset.contentHash);
  });

  test("9. an approved version's bytes cannot move", async () => {
    const png = pngOf(1200, 628);
    const out = await uploadFor(A, MARKETER, png, { fileName: "hero.png" });
    await approve(A, out.asset.assetId);

    const doc = await MarketingAdvertisingAsset.findOne({}).select("+storageRef");

    /* ── AN APPROVAL THAT CAN BE REDIRECTED IS NOT AN APPROVAL ─────────────
       If the bytes behind an approved row could change, every approval in the
       collection would become a claim about something nobody looked at — and
       the running campaign would show a picture swapped after review. */
    doc.sha256 = sha(Buffer.from("different"));
    await expect(doc.save()).rejects.toThrow(/immutable/i);

    /* And not through a query path either: a save hook alone leaves
       `updateOne`, `findOneAndUpdate` and the rest wide open. */
    await expect(MarketingAdvertisingAsset.updateOne({ _id: doc._id }, { $set: { storageRef: "drive-999" } }))
      .rejects.toThrow(/immutable/i);
    await expect(MarketingAdvertisingAsset.findOneAndUpdate({ _id: doc._id }, { $set: { width: 50 } }))
      .rejects.toThrow(/immutable/i);
    await expect(MarketingAdvertisingAsset.updateMany({}, { $set: { mimeType: "image/png" } }))
      .rejects.toThrow(/immutable/i);

    /* The review trail is append-only for the same reason. */
    const h = await MarketingAdvertisingAssetHistory.findOne({});
    await expect(MarketingAdvertisingAssetHistory.updateOne({ _id: h._id }, { $set: { action: "x" } }))
      .rejects.toThrow(/append-only/i);
    await expect(MarketingAdvertisingAssetHistory.deleteOne({ _id: h._id }))
      .rejects.toThrow(/append-only/i);
  });

  test("10. identical bytes are one asset within a company, and never across companies", async () => {
    const png = pngOf(1200, 628);

    const first = await uploadFor(A, MARKETER, png, { fileName: "hero.png" });
    await approve(A, first.asset.assetId);

    /* ── UPLOADING THE SAME PICTURE TWICE FINDS THE FIRST ─────────────────
       Rather than making a second row with a second review. And crucially the
       existing review state is UNCHANGED — a re-upload must not re-open or
       re-approve anything. */
    const again = await uploadFor(A, MARKETER, png, { fileName: "hero-copy.png" });
    expect(again.deduplicated).toBe(true);
    expect(again.asset.assetId).toBe(first.asset.assetId);
    expect(again.asset.state).toBe("approved");
    expect(await MarketingAdvertisingAsset.countDocuments({ companyId: A })).toBe(1);

    /* ── AND THE DEDUPLICATION STOPS AT THE COMPANY BOUNDARY ──────────────
       Two companies uploading the same stock photograph is ordinary. A global
       hash index would collide the second with a row it cannot see, cannot
       read and never approved — and would leak that somebody else has it. */
    const other = await uploadFor(B, MARKETER, png, { fileName: "hero.png" });
    expect(other.deduplicated).toBe(false);
    expect(other.asset.assetId).not.toBe(first.asset.assetId);
    /* B's copy is its own, and unapproved. */
    expect(other.asset.state).toBe("awaiting_review");
    expect(await MarketingAdvertisingAsset.countDocuments({})).toBe(2);
  });

  test("11. another company cannot see, read or use this company's image", async () => {
    const out = await uploadFor(A, MARKETER, pngOf(1200, 628), { fileName: "hero.png" });
    await approve(A, out.asset.assetId);

    /* The public identifier carries a signed company. Editing it out produces a
       token that fails verification rather than one that reads another tenant. */
    for (const fn of ["detail", "forDeployment"]) {
      await expect(assets[fn]({ companyId: B, assetId: out.asset.assetId }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(assets.readBytes({ companyId: B, assetId: out.asset.assetId }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    /* Deliberately the same message and status as a token that does not exist:
       distinguishing them would confirm an image exists in another company. */
    const err = await assets.detail({ companyId: B, assetId: out.asset.assetId }).catch((e) => e);
    expect(err.message).toMatch(/could not be found/i);

    const list = await assets.list({ companyId: B });
    expect(list.assets).toEqual([]);
  });

  test("12. a revoked image cannot be used in anything new, and says what that does not mean", async () => {
    const out = await uploadFor(A, MARKETER, pngOf(1200, 628), { fileName: "hero.png" });
    await approve(A, out.asset.assetId);

    const usable = await assets.forDeployment({ companyId: A, assetId: out.asset.assetId });
    expect(usable.sha256).toBe(out.asset.contentHash);

    const revoked = await assets.review({
      companyId: A, user: ADMIN, assetId: out.asset.assetId,
      decision: "revoke", payload: { note: "Licence expired" },
    });
    expect(revoked.asset.state).toBe("revoked");
    expect(revoked.asset.usableInAdvertising).toBe(false);
    /* ── AND IT DOES NOT CLAIM TO UNDO WHAT IS ALREADY PUBLISHED ──────────
       GRAV cannot reach into an advertising channel and remove a picture it has
       already uploaded, so it does not say it has. */
    expect(revoked.means).toMatch(/already sent to an advertising channel is unaffected/i);

    const err = await assets.forDeployment({ companyId: A, assetId: out.asset.assetId }).catch((e) => e);
    expect(err.details.code).toBe("NOT_DEPLOYABLE");
    expect(err.message).toMatch(/withdrawn/i);

    /* Revocation is terminal: there is no path back. */
    await expect(approve(A, out.asset.assetId)).rejects.toMatchObject({ details: { code: "STATE_CONFLICT" } });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   13–16. THE WIRE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("what reaches the browser", () => {
  test("13. no storage identifier, ever", async () => {
    const out = await uploadFor(A, MARKETER, pngOf(1200, 628), { fileName: "hero.png" });
    await approve(A, out.asset.assetId);

    const detail = await assets.detail({ companyId: A, assetId: out.asset.assetId });
    const list = await assets.list({ companyId: A });

    for (const blob of [JSON.stringify(out), JSON.stringify(detail), JSON.stringify(list)]) {
      /* The Drive id is `select: false` on the model, absent from every view
         built by hand, and never accepted as input. */
      expect(blob).not.toMatch(/drive-\d+|storageRef|driveFileId/i);
      /* Nor the internal database id: it is a key into GRAV's own collection. */
      expect(blob).not.toMatch(new RegExp(String(A)));
    }

    const res = await call(`/advertising-assets`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/drive-\d+|storageRef|_id/i);
  });

  test("14. the picture comes back through GRAV's own route, re-verified", async () => {
    const png = pngOf(1200, 628);
    const out = await uploadFor(A, MARKETER, png, { fileName: "hero.png" });
    await approve(A, out.asset.assetId);

    const res = await call(`/advertising-assets/${out.asset.assetId}/binary`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    /* Not a storage link: a Drive URL would either need the object made public
       or a signed URL that outlives the session that issued it. */
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toMatch(/private/);
    expect(res.bytes.equals(png)).toBe(true);

    /* ── AND THE BYTES ARE RE-HASHED EVERY TIME ───────────────────────────
       Storage is a shared company Drive people can open. A file replaced there
       would otherwise be published as the approved image. */
    const [storedKey] = [...companyDrive.__files.keys()];
    companyDrive.__files.get(storedKey).buffer = pngOf(1200, 628, 4);
    const err = await assets.readBytes({ companyId: A, assetId: out.asset.assetId }).catch((e) => e);
    expect(err.code).toBe("CAMPAIGN_DEPLOYMENT_NOT_READY");
    expect(err.message).toMatch(/no longer matches what was approved/i);
  });

  test("15. the route refuses an oversized upload while it is still arriving", async () => {
    /* multer's own limit fires before the service ever sees a buffer, so the
       bytes stop mid-flight rather than being buffered and then measured. */
    const form = new FormData();
    form.append("image", new Blob([pngOf(1200, 1200, 9 * 1024 * 1024)], { type: "image/png" }), "huge.png");

    const res = await fetch(`${base}/advertising-assets`, {
      method: "POST",
      headers: { "x-test-user": JSON.stringify(MARKETER), "x-test-company": String(A) },
      body: form,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/larger than 8MB/i);

    expect(companyDrive.uploadCompanyFile).not.toHaveBeenCalled();
    expect(await MarketingAdvertisingAsset.countDocuments({})).toBe(0);
  });

  test("16. a real upload through the route stores bytes and nothing more", async () => {
    const png = pngOf(1200, 628);
    const form = new FormData();
    form.append("image", new Blob([png], { type: "image/png" }), "hero.png");
    form.append("fileName", "hero.png");
    form.append("note", "Winter campaign hero");

    const res = await fetch(`${base}/advertising-assets`, {
      method: "POST",
      headers: { "x-test-user": JSON.stringify(MARKETER), "x-test-company": String(A) },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.asset.contentHash).toBe(sha(png));
    expect(body.asset.width).toBe(1200);
    expect(body.asset.state).toBe("awaiting_review");
    expect(body.asset.usableInAdvertising).toBe(false);
    expect(body.means).toMatch(/somebody other than the uploader/i);

    /* And a pointer field sent alongside the file is still refused. */
    const form2 = new FormData();
    form2.append("image", new Blob([jpegOf(900, 900)], { type: "image/jpeg" }), "x.jpg");
    form2.append("imageUrl", "https://cdn.example.com/hero.jpg");
    const res2 = await fetch(`${base}/advertising-assets`, {
      method: "POST",
      headers: { "x-test-user": JSON.stringify(MARKETER), "x-test-company": String(A) },
      body: form2,
    });
    expect(res2.status).toBe(400);
    expect((await res2.json()).message).toMatch(/web address/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   17. THE PURE READER
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the byte reader itself", () => {
  test("17. it parses real headers and refuses malformed ones without a decoder", async () => {
    /* ── NO IMAGE LIBRARY, DELIBERATELY ───────────────────────────────────
       A decoder is an attack surface pointed at untrusted bytes, which is the
       one thing this reader exists to avoid trusting. PNG and JPEG both state
       their dimensions in a documented header that can be read without
       decoding a pixel. */
    expect(imageBytes.inspect(pngOf(1920, 1080))).toMatchObject({ width: 1920, height: 1080 });
    expect(imageBytes.inspect(jpegOf(640, 480))).toMatchObject({ width: 640, height: 480 });

    /* ── THE JPEG FRAME MARKERS ARE A SET, NOT A RANGE ────────────────────
       0xC4 is a Huffman table and sits inside the C0-CF block. Treating the
       block as a range reads two bytes of a Huffman table as an image height. */
    const huffmanFirst = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      /* A DHT segment whose payload would parse as 0x1234 x 0x5678. */
      Buffer.from([0xff, 0xc4, 0x00, 0x0b, 0x00, 0x12, 0x34, 0x56, 0x78, 0, 0, 0, 0]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
      (() => { const b = Buffer.alloc(4); b.writeUInt16BE(800, 0); b.writeUInt16BE(600, 2); return b; })(),
      Buffer.alloc(10),
    ]);
    expect(imageBytes.inspect(huffmanFirst)).toMatchObject({ width: 600, height: 800 });

    /* ── AND THE WALK IS BOUNDED ──────────────────────────────────────────
       A malformed file can describe a segment pointing backwards or nowhere. A
       length below two cannot include its own two bytes. */
    const backwards = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe0, 0x00, 0x00]),
      Buffer.alloc(32),
    ]);
    expect(imageBytes.inspect(backwards).ok).toBe(false);

    const truncated = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xc0, 0x00, 0x04])]);
    expect(imageBytes.inspect(truncated).ok).toBe(false);

    /* A zero dimension is a corrupt file, and downstream everything divides by
       it. */
    const zero = Buffer.concat([
      Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
      Buffer.alloc(4), Buffer.alloc(10),
    ]);
    expect(imageBytes.inspect(zero).ok).toBe(false);

    expect(imageBytes.inspect(Buffer.alloc(0)).ok).toBe(false);
  });
});
