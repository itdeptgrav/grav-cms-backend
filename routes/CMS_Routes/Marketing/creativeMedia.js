// routes/CMS_Routes/Marketing/creativeMedia.js
//   → mounted at /api/cms/marketing
//
// THE CREATIVE MEDIA LIBRARY — FILES FOR PLANNED SOCIAL CONTENT.
//
//   POST /creative-media                               upload a new image (version 1)
//   POST /creative-media/:groupRef/versions            upload the next version of it
//   GET  /creative-media                               this company's files, latest version each
//   GET  /creative-media/:groupRef                     every version, and what happened to it
//   GET  /creative-media/versions/:mediaRef/preview    the exact bytes, authenticated
//   POST /creative-media/versions/:mediaRef/withdraw   withdraw one version (reason required)
//
// ── NOTHING HERE IS PUBLISHED, SCHEDULED OR APPROVED ───────────────────────
// No route posts to a network, schedules anything or approves anything. There
// is no public URL: the only way to see a file is the preview route, which
// re-checks the session, the company and the file's hash on every request.
// The advertising image library and the Campaign Builder are untouched.
//
// ── IMAGES ONLY, FOR NOW ───────────────────────────────────────────────────
// A video is recognised and refused with the reasons GRAV's storage cannot
// hold one yet (`vocabulary.video.blockers`).
"use strict";

const express = require("express");
const multer = require("multer");

const router = express.Router();

const marketingAuth = require("../../../Middlewear/MarketingAuthMiddlewear");
const membership = require("../../../services/companyContext/companyMembership.service");
const { fail } = require("../../../services/storePurchase/errors");
const providerPrivacy = require("../../../services/marketing/providerPrivacy");
const media = require("../../../services/marketing/creativeMedia/creativeMedia.service");
const M = require("../../../constants/marketingCreativeMedia");

const handle = providerPrivacy.handleMarketing({ surface: "marketing" });
const sendError = (res, err) => providerPrivacy.sendMarketingError(res, err);
const str = (v) => String(v ?? "").trim();

async function companyFor(req) {
  if (req.__marketingCompanyId) return req.__marketingCompanyId;
  const { companyId } = await membership.resolveCompanyForActor(req.user, {
    requestedCompanyId: null,
    domainLabel: "Marketing",
    fail,
  });
  req.__marketingCompanyId = companyId;
  return companyId;
}

/* Storage can be supplied by the host (tests use this); by default the
   service uses the private company Drive. */
const depsOf = (req) => (req.app?.locals?.marketingCreativeMediaDrive ? { drive: req.app.locals.marketingCreativeMediaDrive } : {});

/* ── BOUNDED WHILE IT ARRIVES ───────────────────────────────────────────────
   One file, in memory, refused mid-flight past the ceiling. Nothing touches
   this server's disk, so an interrupted upload leaves nothing to clean up. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: M.LIMITS.IMAGE_MAX_BYTES, files: 1, fields: 4, fieldSize: 2048, parts: 6 },
}).single("file");

/* Every way an upload can fail before the service sees it, as a GRAV answer. */
function uploadError(err) {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return fail("CREATIVE_MEDIA_TOO_LARGE",
        `That file is larger than ${M.LIMITS.IMAGE_MAX_BYTES / (1024 * 1024)}MB, the most GRAV stores for one image. Nothing was saved.`,
        { field: "file", maxBytes: M.LIMITS.IMAGE_MAX_BYTES });
    }
    if (err.code === "LIMIT_UNEXPECTED_FILE" || err.code === "LIMIT_FILE_COUNT") {
      return fail("VALIDATION", "Send exactly one file, in a part named \"file\". Nothing was saved.", { field: "file" });
    }
    return fail("VALIDATION", "The upload had more parts than GRAV accepts. Nothing was saved.", { field: "file" });
  }
  const message = str(err?.message);
  /* Busboy's words for a body that stopped before it finished: the browser
     closed, the connection dropped, or the form was cut short. */
  if (/unexpected end of form|request aborted|aborted|boundary not found|malformed part header|unexpected end/i.test(message)
    || err?.code === "ECONNRESET") {
    return fail("CREATIVE_MEDIA_UPLOAD_INCOMPLETE", "The upload did not arrive complete. Nothing was saved; try again.", { field: "file" });
  }
  return fail("VALIDATION", "The upload could not be read. Send it as multipart/form-data with one part named \"file\". Nothing was saved.", { field: "file" });
}

const receive = (req, res) => new Promise((resolve, reject) => {
  if (!/^multipart\/form-data/i.test(str(req.headers["content-type"]))) {
    reject(fail("VALIDATION", "Send the file as multipart/form-data with one part named \"file\".", { field: "file" }));
    return;
  }
  upload(req, res, (err) => (err ? reject(uploadError(err)) : resolve()));
});

/* The form fields, plus the file part's own name when no fileName field was
   sent. The service's allow-list refuses anything else. */
function payloadOf(req) {
  const fields = req.body && typeof req.body === "object" ? { ...req.body } : {};
  if (fields.fileName === undefined && req.file?.originalname) fields.fileName = req.file.originalname;
  return fields;
}

router.use(marketingAuth);

router.post("/creative-media", handle(async (req, res) => {
  if (Object.keys(req.query || {}).length) throw fail("VALIDATION", "An upload takes no query parameters.");
  const companyId = await companyFor(req);
  await receive(req, res);
  const out = await media.upload({
    companyId, user: req.user, buffer: req.file?.buffer,
    payload: payloadOf(req),
  }, depsOf(req));
  return res.status(out.deduplicated ? 200 : 201).json({ success: true, ...out, vocabulary: media.vocabulary });
}));

router.post("/creative-media/:groupRef/versions", handle(async (req, res) => {
  if (Object.keys(req.query || {}).length) throw fail("VALIDATION", "An upload takes no query parameters.");
  const companyId = await companyFor(req);
  await receive(req, res);
  const out = await media.upload({
    companyId, user: req.user, buffer: req.file?.buffer, groupRef: str(req.params.groupRef),
    payload: payloadOf(req),
  }, depsOf(req));
  return res.status(out.deduplicated ? 200 : 201).json({ success: true, ...out, vocabulary: media.vocabulary });
}));

router.get("/creative-media", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const view = await media.list({ companyId, query: req.query || {}, user: req.user });
  return res.json({ success: true, ...view, vocabulary: media.vocabulary });
}));

router.get("/creative-media/versions/:mediaRef/preview", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const out = await media.preview({ companyId, mediaRef: str(req.params.mediaRef) }, depsOf(req));
  res.setHeader("Content-Type", out.mimeType);
  res.setHeader("Content-Length", out.byteSize);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "private, no-store");
  /* The hash of exactly these bytes, so a client can confirm it is showing the
     version the creative names. */
  res.setHeader("X-Content-Hash", out.sha256);
  /* ── READABLE BY THE AUTHENTICATED FRONTEND ─────────────────────────────
     A cross-origin script sees only CORS-safelisted response headers unless
     one is exposed. This exposes exactly one, on exactly this response, and
     only to origins the app's CORS check already admitted — it grants no
     access, since the bytes themselves already required the session. The
     browser still hashes the bytes itself; the header is a second witness,
     not a replacement. */
  res.setHeader("Access-Control-Expose-Headers", "X-Content-Hash");
  return res.end(out.buffer);
}));

router.post("/creative-media/versions/:mediaRef/withdraw", express.json({ limit: "4kb" }), handle(async (req, res) => {
  const companyId = await companyFor(req);
  const out = await media.withdraw({ companyId, user: req.user, mediaRef: str(req.params.mediaRef), payload: req.body || {} });
  return res.json({ success: true, ...out, vocabulary: media.vocabulary });
}));

router.get("/creative-media/:groupRef", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const view = await media.detail({ companyId, groupRef: str(req.params.groupRef), user: req.user });
  return res.json({ success: true, ...view, vocabulary: media.vocabulary });
}));

router.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large") {
    return sendError(res, fail("VALIDATION", "The request body could not be read.", { received: err.type }));
  }
  return sendError(res, err, next);
});

module.exports = router;
