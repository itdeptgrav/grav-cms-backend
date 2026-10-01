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
const patterns = require("../../../services/rnd/patternRevision.service");
const renders = require("../../../services/rnd/garmentRender.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

const requireCompany = rndCompanyMiddleware({ domainLabel: "R&D" });
const canRead = rndCapability(CAPABILITY.MODEL_READ);
const canPublish = rndCapability(CAPABILITY.MODEL_PUBLISH);
const canAnnotate = rndCapability(CAPABILITY.MODEL_ANNOTATE);
const canSubmit = rndCapability(CAPABILITY.MODEL_SUBMIT);
const canApprove = rndCapability(CAPABILITY.MODEL_APPROVE);
const canPublishPattern = rndCapability(CAPABILITY.PATTERN_PUBLISH);
/* Settling which flat piece is which 3D component is its own act — see the
   capability's own note in `access.service.js`. */
const canMap = rndCapability(CAPABILITY.PATTERN_MAP);

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
  limits: { fileSize: models.LIMITS.SOURCE_BYTES, files: 4, fields: 24 },
}).fields([
  { name: "webModel", maxCount: 1 },
  { name: "source", maxCount: 1 },
  { name: "preview", maxCount: 1 },
  /* The flat pattern, the fourth member of a technical bundle. */
  { name: "patterns", maxCount: 1 },
]);

/** One pattern on its own, for attaching or replacing it on a draft bundle. */
const uploadPattern = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: models.LIMITS.PATTERN_BYTES, files: 1, fields: 12 },
}).single("patterns");

/** And one CLO project, the same way. */
const uploadSource = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: models.LIMITS.SOURCE_BYTES, files: 1, fields: 12 },
}).single("source");

/* ── CLASSIFYING A DROP, WHICH STORES NOTHING ─────────────────────────────
 * Up to four files at once with no field names, because a drag-and-drop does
 * not have any: the person dropped a folder's worth of exports and the whole
 * question is what each one is. Nothing here is kept — see `classifyUploads`.
 */
const uploadForClassification = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: models.LIMITS.SOURCE_BYTES, files: 4, fields: 8 },
}).array("files", 4);

const receiveFiles = (req, res, next) => upload(req, res, (err) => {
  if (!err) return next();
  if (err.code === "LIMIT_FILE_SIZE") {
    return sendError(res, fail("MODEL_FILE_TOO_LARGE",
      `That file is over ${Math.round(models.LIMITS.SOURCE_BYTES / 1024 / 1024)}MB, which is the most this `
      + "workspace accepts in one upload.", { limitBytes: models.LIMITS.SOURCE_BYTES }));
  }
  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    return sendError(res, fail("VALIDATION",
      "A technical bundle carries the web model, the flat pattern, the CLO source and a preview, "
      + "and nothing else.",
      { field: err.field }));
  }
  return sendError(res, err);
});

/** The same translation, for the two single-purpose upload paths. */
const receiveWith = (middleware, limitBytes, what) => (req, res, next) =>
  middleware(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return sendError(res, fail("PATTERN_TOO_LARGE",
        `That file is over ${Math.round(limitBytes / 1024 / 1024)}MB, which is the most this workspace `
        + `accepts for ${what}.`, { limitBytes }));
    }
    if (err.code === "LIMIT_UNEXPECTED_FILE" || err.code === "LIMIT_FILE_COUNT") {
      return sendError(res, fail("VALIDATION",
        `Attach ${what} and nothing else.`, { field: err.field }));
    }
    return sendError(res, err);
  });

/* ═══ WHO AM I HERE ════════════════════════════════════════════════════════
 *
 * Deliberately NOT behind the R&D capability. It is what an access-denied
 * screen reads to say which company it is talking about and what this person
 * may do, and a screen that could only explain a refusal to somebody who had
 * not been refused would help nobody. Session and company only; it names no
 * style, no model and no capability key.
 */
router.get("/garment-models/context", requireCompany, handle(async (req, res) => {
  const out = await models.workspaceContext(ctx(req), { role: await liveRndRole(req) });
  return res.json({ success: true, ...out });
}));

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

/* ═══ MEASUREMENTS ═════════════════════════════════════════════════════════
 *
 * Read with the model, written by whoever may annotate it: a measurement is a
 * fact somebody recorded about this garment, which is the same kind of act as
 * raising a construction note and carries the same permission.
 *
 * `/measurements/:id` is PATCH-only on purpose. The points are immutable in
 * the schema, so there is no route that could move one — changing what was
 * measured is a new measurement beside the old one, never a quiet edit of it.
 */

router.get("/garment-models/:publicationId/measurements", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await models.listMeasurements(ctx(req), { publicationId: req.params.publicationId });
    return res.json({ success: true, ...out });
  }));

router.post("/garment-models/:publicationId/measurements", requireCompany, canAnnotate,
  handle(async (req, res) => {
    const out = await models.createMeasurement(ctx(req), {
      publicationId: req.params.publicationId, body: req.body || {}, actor: actor(req),
    });
    return res.status(201).json({ success: true, ...out });
  }));

router.patch("/garment-models/measurements/:measurementId", requireCompany, canAnnotate,
  handle(async (req, res) => {
    const out = await models.updateMeasurement(ctx(req), {
      measurementId: req.params.measurementId, body: req.body || {},
      expectedRevision: req.body?.expectedRevision, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

router.post("/garment-models/measurements/:measurementId/duplicate", requireCompany, canAnnotate,
  handle(async (req, res) => {
    const out = await models.duplicateMeasurement(ctx(req), {
      measurementId: req.params.measurementId, name: req.body?.name, actor: actor(req),
    });
    return res.status(201).json({ success: true, ...out });
  }));

/* ── THE HANDOVER TO INDUSTRIAL ENGINEERING ───────────────────────────────
 *
 * GET only, and that is the contract. There is no companion POST, PATCH or
 * DELETE anywhere on this mount that would let a consumer change an R&D
 * measurement — IE reads what R&D accepted and keeps its own engineering
 * observations in its own records.
 *
 * It is mounted HERE rather than under /api/cms/ie because the thing being
 * published is R&D's, and the department that owns a fact owns the route that
 * serves it. Reading it needs the ordinary model-read capability, so an IE
 * engineer is granted R&D read access deliberately rather than by a second
 * permission system nobody can see.
 */
router.get("/garment-models/styles/:styleId/measurement-handover", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await models.measurementHandover(ctx(req), { styleId: req.params.styleId });
    return res.json({ success: true, ...out });
  }));

/* ── SCALE CALIBRATION ─────────────────────────────────────────────────────
 * Stating what one model unit is really worth changes how every number on
 * this publication reads, so it needs the same permission as recording one —
 * and it is refused on an accepted model, which is a record rather than a
 * workspace. There is no route that copies a calibration to another
 * publication, deliberately: a later export may be drawn at a different scale.
 */

router.put("/garment-models/:publicationId/scale-calibration", requireCompany, canAnnotate,
  handle(async (req, res) => {
    const out = await models.calibrateScale(ctx(req), {
      publicationId: req.params.publicationId, body: req.body || {},
      expectedRevision: req.body?.expectedRevision, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

router.delete("/garment-models/:publicationId/scale-calibration", requireCompany, canAnnotate,
  handle(async (req, res) => {
    const out = await models.clearCalibration(ctx(req), {
      publicationId: req.params.publicationId,
      expectedRevision: req.body?.expectedRevision ?? req.query?.expectedRevision,
    });
    return res.json({ success: true, ...out });
  }));

/* ═══ THE FLAT PATTERN ═════════════════════════════════════════════════════
 *
 * ── WHY CLASSIFICATION IS A ROUTE AND NOT PART OF THE PUBLISH ───────────────
 * The brief's rule is that nothing is published until each file's
 * classification is visible. A server that classified during the publish cannot
 * satisfy it — by then the decision is made and the bytes are stored. So the
 * screen asks what these files are, shows the answers, and publishes second.
 *
 * It stores nothing, mints no reference and touches no publication, which is
 * also why it needs only the publish capability rather than a write one: asking
 * "what is this file" is not a change to anything.
 */
router.post("/garment-models/classify", requireCompany, canPublishPattern,
  receiveWith(uploadForClassification, models.LIMITS.SOURCE_BYTES, "up to four bundle files"),
  handle(async (req, res) => {
    const out = await models.classifyUploads(ctx(req), {
      files: req.files || [],
      actor: actor(req),
      /* ── TWO OPTIONAL ANSWERS, ASKED FOR RATHER THAN ASSUMED ───────────
         `styleId` lets the reply say "this exact file is already 3D model 3",
         which needs the style to scope the question. `geometry` returns the
         outlines a confirmation preview draws. Both cost something, and a
         drag-and-drop that only wants to know what the files ARE should not
         pay for either. */
      styleId: req.body?.styleId || req.query?.styleId || "",
      geometry: req.body?.geometry === "1" || req.query?.geometry === "1",
    });
    return res.json({ success: true, ...out });
  }));

/**
 * ATTACH OR REPLACE THE PATTERN ON A DRAFT BUNDLE.
 *
 * PUT rather than POST, because there is at most one pattern on a bundle and
 * sending a second one replaces the first. A POST would imply a collection and
 * the first question would be how to address the second member of it.
 */
router.put("/garment-models/:publicationId/pattern", requireCompany, canPublishPattern,
  receiveWith(uploadPattern, models.LIMITS.PATTERN_BYTES, "one DXF pattern export"),
  handle(async (req, res) => {
    const out = await models.attachPatternSet(ctx(req), {
      publicationId: req.params.publicationId,
      file: req.file,
      body: req.body || {},
      expectedRevision: req.body?.expectedRevision,
      actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/**
 * ATTACH OR REPLACE THE CLO SOURCE ON A DRAFT BUNDLE.
 *
 * PUT for the same reason the pattern's route is: a bundle carries at most one
 * source and sending a second replaces the first. Nothing here parses the file
 * — see `attachSource` — and there is deliberately no route anywhere on this
 * mount that claims to read inside a `.zprj`.
 */
router.put("/garment-models/:publicationId/source", requireCompany, canPublishPattern,
  receiveWith(uploadSource, models.LIMITS.SOURCE_BYTES, "one CLO project file"),
  handle(async (req, res) => {
    const out = await models.attachSource(ctx(req), {
      publicationId: req.params.publicationId,
      file: req.file,
      body: req.body || {},
      expectedRevision: req.body?.expectedRevision,
      actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/**
 * THE PARSED PATTERN, ITS MAPPING AND EVERYTHING DERIVED FROM BOTH.
 *
 * One call rather than three. The 2D viewer cannot draw a piece list without
 * knowing the unit it is in, and it cannot label a piece "needs mapping"
 * without the mapping — splitting them would let the screen render a measured
 * area beside a scale caveat that had not arrived yet.
 */
router.get("/garment-models/:publicationId/pattern", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await models.readPatternSet(ctx(req), {
      publicationId: req.params.publicationId, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* ── MAPPING ───────────────────────────────────────────────────────────────
 * One endpoint for confirm, reject, set-by-hand and clear, because they are one
 * decision with four outcomes and a reader of this file should see them
 * together. The author is taken from the session on every one of them: there is
 * no body shape here that confirms a mapping anonymously.
 */
router.post("/garment-models/:publicationId/pattern/mappings", requireCompany, canMap,
  handle(async (req, res) => {
    const out = await models.setPieceMapping(ctx(req), {
      publicationId: req.params.publicationId,
      body: req.body || {},
      expectedRevision: req.body?.expectedRevision,
      actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/** Re-run the matcher. Keeps what a person confirmed — see `proposeMappings`. */
router.post("/garment-models/:publicationId/pattern/rematch", requireCompany, canMap,
  handle(async (req, res) => {
    const out = await models.rematchMappings(ctx(req), {
      publicationId: req.params.publicationId,
      expectedRevision: req.body?.expectedRevision,
      actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* ── THE TECHNICAL-BUNDLE HANDOVER TO INDUSTRIAL ENGINEERING ───────────────
 *
 * GET only, and that is the contract — the same one the measurement handover
 * already states. There is no companion POST, PATCH or DELETE on this mount
 * that would let a consumer change an R&D piece, a mapping or a file, and there
 * is nothing here that derives an operation, a machine, a SAM or a line plan
 * from pattern geometry. Those are Industrial Engineering's to author, from
 * this as evidence.
 *
 * Only an APPROVED bundle is projected. A draft is R&D's working surface, and
 * the service answers "nothing is accepted yet" as a fact rather than as an
 * empty piece list that looks like a parse failure.
 */
router.get("/garment-models/styles/:styleId/technical-bundle", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await models.technicalBundleHandover(ctx(req), { styleId: req.params.styleId });
    return res.json({ success: true, ...out });
  }));

/* ═══ THE 2D PATTERN, WHICH IS THE DESIGN ══════════════════════════════════
 *
 * ── WHY THESE SIT ON THE MODEL MOUNT ────────────────────────────────────────
 * Because a reader of this file needs to see, in one place, that the pattern
 * routes WRITE and the preview routes do not. Splitting them across two
 * mounts would make the one-way arrow — pattern → preview — something you have
 * to go and check rather than something you can read.
 *
 * Note what is absent: there is no route that edits a pattern from a model id,
 * and no route by which a marker, a measurement or an approval on a 3D
 * publication reaches a revision.
 */

router.get("/patterns/styles/:styleId/revisions", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await patterns.listRevisions(ctx(req), { styleId: req.params.styleId });
    return res.json({ success: true, ...out });
  }));

router.get("/patterns/revisions/:revisionId", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await patterns.readRevision(ctx(req), { revisionId: req.params.revisionId });
    return res.json({ success: true, ...out });
  }));

/* Every edit mints the next revision — see the service. There is deliberately
   no PUT or PATCH on a revision's geometry: a route that could overwrite one
   is a route that could overwrite an approved one. */
router.post("/patterns/revisions/:revisionId/edits", requireCompany, canAnnotate,
  handle(async (req, res) => {
    const out = await patterns.editRevision(ctx(req), {
      revisionId: req.params.revisionId,
      operations: req.body?.operations,
      name: req.body?.name,
      expectedRevision: req.body?.expectedRevision,
      actor: actor(req),
    });
    return res.status(201).json({ success: true, ...out });
  }));

router.put("/patterns/revisions/:revisionId/simulation-inputs", requireCompany, canAnnotate,
  handle(async (req, res) => {
    const out = await patterns.setSimulationInputs(ctx(req), {
      revisionId: req.params.revisionId,
      inputs: req.body?.inputs || {},
      expectedRevision: req.body?.expectedRevision,
      actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

router.post("/patterns/revisions/:revisionId/approve", requireCompany, canApprove,
  handle(async (req, res) => {
    const out = await patterns.approveRevision(ctx(req), {
      revisionId: req.params.revisionId,
      note: req.body?.note,
      expectedRevision: req.body?.expectedRevision,
      actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* ═══ THE 3D PREVIEW, WHICH IS DERIVED ═════════════════════════════════════
 *
 * Two verbs and no more: ask for one, and record what the engine said. There
 * is no route that edits a preview, because there is nothing about a preview
 * that is worth editing — it is a picture, and the thing it is a picture of
 * has its own routes above.
 */

router.get("/patterns/styles/:styleId/renders", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await renders.listRenders(ctx(req), { styleId: req.params.styleId });
    return res.json({ success: true, ...out });
  }));

router.post("/patterns/revisions/:revisionId/render", requireCompany, canAnnotate,
  handle(async (req, res) => {
    const out = await renders.requestRender(ctx(req), {
      revisionId: req.params.revisionId, actor: actor(req),
    });
    return res.status(202).json({ success: true, ...out });
  }));

/* What the simulation engine reports back. Needs the publish capability
   because completing a render creates a publication. */
router.post("/patterns/renders/:jobRef/outcome", requireCompany, canPublish,
  handle(async (req, res) => {
    const out = await renders.recordRenderOutcome(ctx(req), {
      jobRef: req.params.jobRef,
      status: req.body?.status,
      publicationId: req.body?.publicationId,
      publicationRef: req.body?.publicationRef,
      failure: req.body?.failure,
      actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* ── WHAT THE IN-APP SOLVER REPORTS BACK ──────────────────────────────────
   Separate from `/outcome` above, and on a lower capability on purpose.

   `/outcome` can complete a render by naming a MODEL PUBLICATION, which is a
   file a sample gets approved against — that is `canPublish`, and it stays
   `canPublish`. A drape is this system's own derived, read-only reading of a 2D
   pattern; it creates no publication and nothing can be approved against it. The
   privilege to report one is the same privilege as asking for it in the first
   place, which is `canAnnotate`. Requiring `canPublish` here would instead mean
   that only a publisher could use the in-app solver at all — a restriction on
   the wrong act, and one that would push people towards publishing.

   The browser also reports a FAILURE here, for the same reason: a drape that
   could not finish is the ordinary outcome of the same act. */
router.post("/patterns/renders/:jobRef/drape", requireCompany, canAnnotate,
  handle(async (req, res) => {
    const out = await renders.recordRenderOutcome(ctx(req), {
      jobRef: req.params.jobRef,
      status: req.body?.status,
      drape: req.body?.drape || null,
      failure: req.body?.failure,
      actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* The drape's geometry, on its own, because a job list must not carry 100KB of
   positions per row. */
router.get("/patterns/renders/:jobRef/drape", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await renders.readDrape(ctx(req), { jobRef: req.params.jobRef });
    return res.json({ success: true, drape: out });
  }));

module.exports = router;
