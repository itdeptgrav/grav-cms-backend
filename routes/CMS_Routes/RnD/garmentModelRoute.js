// routes/CMS_Routes/RnD/garmentModelRoute.js
//
// THE 3D GARMENT WORKSPACE'S DOOR. R&D'S, ON R&D'S OWN MOUNT.
//
// ── WHY THE MODEL BELONGS TO R&D ────────────────────────────────────────────
// R&D builds the garment, and every fact anchored to its surface is one R&D
// owns: construction, seams and stitch class, measurement points and their
// tolerances, approved-sample evidence, and the clarifications it raises when
// a design is ambiguous. A department that does not own those facts cannot own
// the surface they are pinned to.
//
// ── AND WHAT IE GETS, WHICH IS NOT THIS ─────────────────────────────────────
// Industrial Engineering will read an APPROVED publication and map its
// construction points to manufacturing operations. That mapping is IE's record
// and lives in IE's own collection; it is not written here, and there is no
// route on this file that would let IE edit a marker or replace the model. The
// arrow points one way: IE consumes what R&D accepted, and R&D never learns
// that it did. Nothing in this slice implements that side — what it does is
// leave the boundary where it can be built against rather than argued about.
//
// ── THE ROUTES THAT DO NOT EXIST ────────────────────────────────────────────
// There is no route that returns a provider URL, and none that makes a public
// viewer link. An unreleased garment is a commercial secret, and a storage URL
// is a permanent grant to anybody who ever sees it. Assets are streamed back
// through `/asset/:kind`, which re-reads the session, the company and the row
// on every request.
//
// There is also no route that approves a model for the person who published
// it — see `decide` in the service.
"use strict";

const express = require("express");
const multer = require("multer");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { handle, sendError, fail } = require("../../../services/storePurchase/errors");
const { CAPABILITY, rndCapability, liveRndRole, ROLE_CAPABILITIES } = require("../../../services/rnd/access.service");
const { rndCompanyMiddleware } = require("../../../services/companyContext/rndScope.service");
const models = require("../../../services/rnd/garmentModel.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

const requireCompany = rndCompanyMiddleware({ domainLabel: "R&D" });
const canRead = rndCapability(CAPABILITY.MODEL_READ);
const canPublish = rndCapability(CAPABILITY.MODEL_PUBLISH);
const canAnnotate = rndCapability(CAPABILITY.MODEL_ANNOTATE);
const canSubmit = rndCapability(CAPABILITY.MODEL_SUBMIT);
const canApprove = rndCapability(CAPABILITY.MODEL_APPROVE);

const actor = (req) => (req.user?.id
  ? { id: req.user.id, name: req.user.name || "", email: req.user.email || "" }
  : null);

const ctx = (req) => ({ ...req.rnd, actorEmail: req.user?.email || "" });

/** Answered per request from the live grant, never cached on the session. */
async function maySource(req) {
  const role = await liveRndRole(req);
  return Boolean(role && ROLE_CAPABILITIES[role]?.has(CAPABILITY.MODEL_SOURCE_DOWNLOAD));
}

/* ═══ UPLOAD ═══════════════════════════════════════════════════════════════
 * In memory, because every uploaded byte is hashed and the web model is parsed
 * before any of it is stored — a temp file would be written, read back twice
 * and deleted, and a crash in between would leave a garment on the disk.
 *
 * The ceiling here is the LARGEST any single field may be; the per-kind limits
 * are the service's, so one answer decides them and the screen can be told
 * what they are. Multer's own refusal is translated below, because its default
 * is an unhandled error that reaches the client as a 500.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: models.LIMITS.SOURCE_BYTES, files: 3, fields: 24 },
}).fields([
  { name: "webModel", maxCount: 1 },
  { name: "source", maxCount: 1 },
  { name: "preview", maxCount: 1 },
]);

const receiveFiles = (req, res, next) => upload(req, res, (err) => {
  if (!err) return next();
  if (err.code === "LIMIT_FILE_SIZE") {
    return sendError(res, fail("MODEL_FILE_TOO_LARGE",
      `That file is over ${Math.round(models.LIMITS.SOURCE_BYTES / 1024 / 1024)}MB, which is the most this `
      + "workspace accepts in one upload.", { limitBytes: models.LIMITS.SOURCE_BYTES }));
  }
  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    return sendError(res, fail("VALIDATION",
      "A publication carries the web model, the CLO source and a preview, and nothing else.",
      { field: err.field }));
  }
  return sendError(res, err);
});

/* ═══ THE STYLE'S MODELS ═══════════════════════════════════════════════════ */

router.get("/garment-models/styles/:styleId", requireCompany, canRead, handle(async (req, res) => {
  const out = await models.listPublications(ctx(req), { styleId: req.params.styleId });
  return res.json({ success: true, ...out });
}));

router.post("/garment-models/styles/:styleId", requireCompany, canPublish, receiveFiles,
  handle(async (req, res) => {
    const out = await models.createDraft(ctx(req), {
      styleId: req.params.styleId, files: req.files || {}, body: req.body || {}, actor: actor(req),
    });
    return res.status(201).json({ success: true, ...out });
  }));

/* ═══ ONE MODEL ════════════════════════════════════════════════════════════ */

router.get("/garment-models/:publicationId", requireCompany, canRead, handle(async (req, res) => {
  const out = await models.readPublication(ctx(req), {
    publicationId: req.params.publicationId,
    actor: actor(req),
    mayDownloadSource: await maySource(req),
  });
  return res.json({ success: true, ...out });
}));

/**
 * THE BYTES.
 *
 * Both credentials, every time: the short-lived token proves the link was
 * issued by us for this asset and this reader, and the session plus the
 * company scope decide whether it may be read NOW. Withdrawing somebody's R&D
 * grant takes effect on their next frame rather than when a link expires.
 */
router.get("/garment-models/:publicationId/asset/:kind", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await models.openAsset(ctx(req), {
      publicationId: req.params.publicationId,
      kind: req.params.kind,
      token: req.query.t,
      actor: actor(req),
      mayDownloadSource: await maySource(req),
    });

    res.setHeader("Content-Type", out.mimeType);
    /* Without this a file whose bytes look like markup can be sniffed into
       HTML and executed on this origin, with this session's cookie. */
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition",
      `${out.inline ? "inline" : "attachment"}; filename="${encodeURIComponent(out.name).replace(/"/g, "")}"`);
    /* Private and short-lived: a shared cache must never hold an unreleased
       garment, and the browser may keep it only about as long as the link. */
    res.setHeader("Cache-Control", "private, max-age=300");
    if (out.bytes) res.setHeader("Content-Length", out.bytes);

    out.stream.on("error", (e) => {
      console.error("[rnd/garment-models] asset stream:", e?.message);
      if (!res.headersSent) res.status(502).end(); else res.end();
    });
    return out.stream.pipe(res);
  }));

/* ═══ THE LIFECYCLE ════════════════════════════════════════════════════════ */

router.post("/garment-models/:publicationId/submit", requireCompany, canSubmit,
  handle(async (req, res) => {
    const out = await models.submitForReview(ctx(req), {
      publicationId: req.params.publicationId,
      expectedRevision: req.body?.expectedRevision,
      actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

router.post("/garment-models/:publicationId/approve", requireCompany, canApprove,
  handle(async (req, res) => {
    const out = await models.decide(ctx(req), {
      publicationId: req.params.publicationId, outcome: "approve",
      note: req.body?.note, expectedRevision: req.body?.expectedRevision, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

router.post("/garment-models/:publicationId/return", requireCompany, canApprove,
  handle(async (req, res) => {
    const out = await models.decide(ctx(req), {
      publicationId: req.params.publicationId, outcome: "return",
      note: req.body?.note, expectedRevision: req.body?.expectedRevision, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* ═══ MARKERS ══════════════════════════════════════════════════════════════ */

router.get("/garment-models/:publicationId/annotations", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await models.listAnnotations(ctx(req), { publicationId: req.params.publicationId });
    return res.json({ success: true, ...out });
  }));

router.post("/garment-models/:publicationId/annotations", requireCompany, canAnnotate,
  handle(async (req, res) => {
    const out = await models.createAnnotation(ctx(req), {
      publicationId: req.params.publicationId, body: req.body || {}, actor: actor(req),
    });
    return res.status(201).json({ success: true, ...out });
  }));

router.get("/garment-models/:publicationId/timeline", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await models.timeline(ctx(req), { publicationId: req.params.publicationId });
    return res.json({ success: true, ...out });
  }));

router.patch("/garment-models/annotations/:annotationId", requireCompany, canAnnotate,
  handle(async (req, res) => {
    const out = await models.updateAnnotation(ctx(req), {
      annotationId: req.params.annotationId, body: req.body || {},
      expectedRevision: req.body?.expectedRevision, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

router.post("/garment-models/annotations/:annotationId/replies", requireCompany, canAnnotate,
  handle(async (req, res) => {
    const out = await models.replyToAnnotation(ctx(req), {
      annotationId: req.params.annotationId, body: req.body || {}, actor: actor(req),
    });
    return res.status(201).json({ success: true, ...out });
  }));

module.exports = router;
