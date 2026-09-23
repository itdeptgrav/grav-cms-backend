// routes/CMS_Routes/Merchandising/ppmRoute.js
//
// THE PRE-PRODUCTION MEETING'S DOORS.
//
// PPM is Pre-Production MEETING and this is a Merchandising router, mounted on
// the Merchandising namespace, behind the live `merchandiser` grant. PPC —
// Production Planning and Control — is a different application with its own
// mount, its own grant and its own decisions; it reads what these doors record
// and decides afterwards whether the order can be planned.
//
// ── WHICH RUNG EACH ACT SITS ON, AND WHY IT IS NOT A NEW ONE ────────────────
// Reusing the existing capability ladder, because a fourth approval system
// inside one application is how an authorisation model stops meaning anything:
//
//   read, versions, printable      FILE_READ         everyone in Merchandising
//   draft, update, conduct         CHANGE_COORDINATE the coordination rung
//   issue, cancel, successor       FILE_LIFECYCLE    the approver's rung
//
// Issuing being an approver act is what makes maker/checker possible at all:
// the service then refuses an issuer who conducted the meeting themselves.
//
// ── AND WHAT NO DOOR HERE DOES ──────────────────────────────────────────────
// There is no verb below that books capacity, allocates a line, releases
// production, or writes a status for Store, IE, Quality, PPC or Production.
// Every one of those facts is READ from its owner and recorded as theirs.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { handle } = require("../../../services/storePurchase/errors");
const {
  CAPABILITY, merchandisingCapability,
} = require("../../../services/merchandising/access.service");
const {
  merchandisingCompanyMiddleware,
} = require("../../../services/companyContext/merchandisingScope.service");
const ppm = require("../../../services/merchandising/preProductionMeeting.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "Merchandising" });
const canRead = merchandisingCapability(CAPABILITY.FILE_READ);
const canCoordinate = merchandisingCapability(CAPABILITY.CHANGE_COORDINATE);
const canDecide = merchandisingCapability(CAPABILITY.FILE_LIFECYCLE);

const ctx = (req) => req.merchandising;
const actor = (req) => (req.user?.id
  ? { id: req.user.id, name: req.user.name || "", email: req.user.email || "" }
  : null);
const idempotencyKey = (req) => String(
  req.get("Idempotency-Key") || req.body?.idempotencyKey || "",
).trim();

/* ═══ READS ════════════════════════════════════════════════════════════════ */

/** Where this file's meeting has got to, plus the read-only order band. */
router.get("/files/:id/ppm", requireCompany, canRead, handle(async (req, res) => {
  const out = await ppm.getCurrent(ctx(req), { fileId: req.params.id });
  return res.json({ success: true, ...out });
}));

router.get("/files/:id/ppm/versions", requireCompany, canRead, handle(async (req, res) => {
  const out = await ppm.listVersions(ctx(req), { fileId: req.params.id });
  return res.json({ success: true, ...out });
}));

router.get("/files/:id/ppm/versions/:versionNo", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await ppm.getVersion(ctx(req), {
      fileId: req.params.id, versionNo: req.params.versionNo,
    });
    return res.json({ success: true, ...out });
  }));

/**
 * GET /files/:id/ppm/source-health — how the sources stand NOW against what a
 * version recorded.
 *
 * A comparison and never a repair. An issued minute is not rewritten because
 * the world moved; this is what tells somebody a successor is needed, and
 * which topics it has to look at again.
 */
router.get("/files/:id/ppm/source-health", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await ppm.sourceHealth(ctx(req), {
      fileId: req.params.id, versionNo: req.query.versionNo,
    });
    return res.json({ success: true, ...out });
  }));

/** The issued minutes as a document. `FILE_READ`: minutes are for reading. */
router.get("/files/:id/ppm/printable", requireCompany, canRead, handle(async (req, res) => {
  const out = await ppm.printable(ctx(req), {
    fileId: req.params.id, versionNo: req.query.versionNo,
  });
  return res.json({ success: true, ...out });
}));

/* ═══ THE DRAFT ════════════════════════════════════════════════════════════ */

router.post("/files/:id/ppm", requireCompany, canCoordinate, handle(async (req, res) => {
  const out = await ppm.createDraft(ctx(req), {
    fileId: req.params.id, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.status(201).json({ success: true, ...out });
}));

router.patch("/files/:id/ppm", requireCompany, canCoordinate, handle(async (req, res) => {
  const out = await ppm.updateDraft(ctx(req), {
    fileId: req.params.id, body: req.body || {}, actor: actor(req),
  });
  return res.json({ success: true, ...out });
}));

/** The meeting happened. This is where the source snapshot is frozen. */
router.post("/files/:id/ppm/conduct", requireCompany, canCoordinate,
  handle(async (req, res) => {
    const out = await ppm.conduct(ctx(req), {
      fileId: req.params.id, body: req.body || {},
      actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

/* ═══ THE DECISIONS ════════════════════════════════════════════════════════ */

/**
 * POST /files/:id/ppm/issue — the minutes become permanent evidence.
 *
 * The approver rung, so the service can hold the person who conducted the
 * meeting to somebody else's signature.
 */
router.post("/files/:id/ppm/issue", requireCompany, canDecide, handle(async (req, res) => {
  const out = await ppm.issue(ctx(req), {
    fileId: req.params.id, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.json({ success: true, ...out });
}));

router.post("/files/:id/ppm/cancel", requireCompany, canDecide, handle(async (req, res) => {
  const out = await ppm.cancelDraft(ctx(req), {
    fileId: req.params.id, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.json({ success: true, ...out });
}));

/**
 * POST /files/:id/ppm/successor — a later meeting, with the earlier one kept.
 *
 * The approver rung because it SUPERSEDES an issued record. The predecessor
 * keeps every field it had; nothing about it is edited.
 */
router.post("/files/:id/ppm/successor", requireCompany, canDecide, handle(async (req, res) => {
  const out = await ppm.createSuccessor(ctx(req), {
    fileId: req.params.id, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.status(201).json({ success: true, ...out });
}));

module.exports = router;
