// routes/CMS_Routes/Marketing/advertisingAssets.js
//   → mounted at /api/cms/marketing
//
// THE ADVERTISING IMAGE LIBRARY.
//
//   POST   /advertising-assets                    upload one image
//   GET    /advertising-assets                    this company's images
//   GET    /advertising-assets/:assetId           one image and its decisions
//   GET    /advertising-assets/:assetId/binary    the picture itself
//   POST   /advertising-assets/:assetId/review    approve, return or revoke
//
// ── BYTES ARRIVE AS BYTES ──────────────────────────────────────────────────
// There is no field on any of these routes that takes a URL, a storage
// identifier, a content reference or an advertising channel's own image hash. A
// pointer is not an asset: GRAV cannot hash it, cannot size it, cannot prove it
// will resolve tomorrow and cannot prove the company may advertise with
// whatever is on the other end.
//
// ── AND NOTHING ABOUT WHERE THEY LIVE REACHES THE BROWSER ──────────────────
// The Drive file id is `select: false` on the model, absent from every view
// built here, and never accepted as input. The public identity is a signed
// token carrying the company, so editing a company out of one produces a token
// that fails verification rather than one that reads another tenant's images.
"use strict";

const express = require("express");
const multer = require("multer");

const router = express.Router();

const marketingAuth = require("../../../Middlewear/MarketingAuthMiddlewear");
const membership = require("../../../services/companyContext/companyMembership.service");
const { fail } = require("../../../services/storePurchase/errors");
const providerPrivacy = require("../../../services/marketing/providerPrivacy");

const assets = require("../../../services/marketing/assets/advertisingAsset.service");
const { ASSET_LIMITS } = require("../../../constants/marketingAdvertisingAssets");

const sendError = (res, err) => providerPrivacy.sendMarketingError(res, err);
const handle = providerPrivacy.handleMarketing({ surface: "marketing" });

const str = (v) => String(v ?? "").trim();

/* ── BOUNDED, IN MEMORY, ONE FILE ───────────────────────────────────────────
   The ceiling is enforced by multer while the bytes are still arriving, so an
   oversized upload is refused mid-flight rather than after it has been buffered
   and measured. In memory because the service hashes and inspects the exact
   bytes before anything is written anywhere — a temp file would mean a rejected
   upload had already touched a disk.

   `files: 1` matters as much as the byte limit: without it a caller can send a
   thousand small files in one request and multer will happily buffer them all. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: ASSET_LIMITS.MAX_BYTES,
    files: 1,
    /* Non-file parts are `fileName` and `note` and nothing else. */
    fields: 4,
    fieldSize: ASSET_LIMITS.NOTE_MAX * 4,
  },
});

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

router.use(marketingAuth);

/**
 * POST /advertising-assets
 *
 * One `multipart/form-data` file part named `image`, plus an optional
 * `fileName` and `note`. Nothing else is accepted, and a field whose name reads
 * like a pointer is refused by name rather than ignored — a dropped field
 * returns 200 and the sender believes it was used.
 *
 * Uploading stores bytes. It does not make them deployable.
 */
router.post("/advertising-assets", upload.single("image"), handle(async (req, res) => {
  const companyId = await companyFor(req);

  const out = await assets.upload({
    companyId,
    user: req.user,
    buffer: req.file?.buffer,
    /* The form fields, exactly as multer parsed them. The service's own
       allow-list is what refuses anything beyond the two permitted. */
    payload: req.body && typeof req.body === "object" ? { ...req.body } : {},
  });

  return res.json({
    success: true,
    asset: out.asset,
    /* So a client can tell "stored" from "you already had this" without
       comparing hashes itself. */
    alreadyHadThisImage: out.deduplicated,
    means: out.means,
  });
}));

/** GET /advertising-assets?state=… — this company's images. */
router.get("/advertising-assets", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const view = await assets.list({
    companyId,
    state: str(req.query.state) || null,
    limit: req.query.limit,
  });
  return res.json({ success: true, ...view });
}));

/** GET /advertising-assets/:assetId — one image, with every decision made about it. */
router.get("/advertising-assets/:assetId", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const view = await assets.detail({ companyId, assetId: str(req.params.assetId) });
  return res.json({ success: true, ...view });
}));

/**
 * GET /advertising-assets/:assetId/binary
 *
 * ── THE PICTURE, THROUGH GRAV'S OWN AUTHENTICATED ROUTE ────────────────────
 * Not a storage link. A Drive URL would either need the object made public —
 * putting a company's advertising images on the open web — or a signed URL that
 * outlives the session that issued it. This reads the bytes with GRAV's
 * credentials, checks they still hash to what was approved, and streams them to
 * a caller this request has already authenticated.
 */
router.get("/advertising-assets/:assetId/binary", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const out = await assets.readBytes({ companyId, assetId: str(req.params.assetId) });

  res.setHeader("Content-Type", out.mimeType);
  res.setHeader("Content-Length", out.byteSize);
  /* Inline, and never executed: a browser must render these as pictures. The
     format is already restricted to JPEG and PNG by signature, and these two
     headers are what stop a content-type surprise becoming a script. */
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", "inline");
  /* Private: an advertising image belongs to one company and must not be cached
     by anything shared. */
  res.setHeader("Cache-Control", "private, max-age=0, no-store");
  return res.end(out.buffer);
}));

/**
 * POST /advertising-assets/:assetId/review
 *
 * Body: `{ decision, authorisedToUse, approvedForAdvertising, reviewedThisVersion, note?, expectedSha256? }`
 *
 * ── THREE SEPARATE CONFIRMATIONS, NOT A BUTTON ─────────────────────────────
 * A single "approve" lets somebody approve without having decided anything.
 * Each assertion is a statement a person makes, and all three are stored on the
 * history row so an audit shows what was claimed rather than that a button was
 * pressed.
 *
 * The uploader may not approve their own upload. Deciding that a company may
 * pay to publish a picture is somebody else's call.
 */
router.post("/advertising-assets/:assetId/review", express.json({ limit: "16kb" }), handle(async (req, res) => {
  const companyId = await companyFor(req);

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const { decision, ...rest } = body;

  const out = await assets.review({
    companyId,
    user: req.user,
    assetId: str(req.params.assetId),
    decision: str(decision),
    payload: rest,
  });

  return res.json({ success: true, asset: out.asset, means: out.means });
}));

/* ── MULTER'S OWN REFUSALS, IN GRAV'S WORDS ─────────────────────────────────
   A limit breach arrives as a `MulterError` with a code, not as a GRAV failure.
   Left alone it would surface as a 500 and a stack trace. */
const MULTER_MESSAGES = Object.freeze({
  LIMIT_FILE_SIZE: `That image is larger than ${Math.round(ASSET_LIMITS.MAX_BYTES / (1024 * 1024))}MB. Export a smaller version — an advertising image is recompressed by the channel anyway.`,
  LIMIT_FILE_COUNT: "Upload one image at a time.",
  LIMIT_UNEXPECTED_FILE: "The image must be sent as the `image` file field.",
  LIMIT_FIELD_COUNT: "That upload carried more fields than an advertising image takes.",
  LIMIT_FIELD_VALUE: "One of those fields was too long.",
});

const BODY_PARSER_TYPES = new Set(["entity.parse.failed", "entity.too.large"]);

router.use((err, req, res, next) => {
  if (err && err.name === "MulterError") {
    return sendError(res, fail("VALIDATION",
      MULTER_MESSAGES[err.code] || "That upload could not be read.",
      { field: "image" }));
  }
  if (err && BODY_PARSER_TYPES.has(err.type)) {
    return sendError(res, fail("VALIDATION",
      err.type === "entity.too.large" ? "That request was too large." : "That request body could not be read as JSON."));
  }
  return next(err);
});

module.exports = router;
