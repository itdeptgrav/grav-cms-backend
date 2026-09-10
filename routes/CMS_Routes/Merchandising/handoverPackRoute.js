// routes/CMS_Routes/Merchandising/handoverPackRoute.js
//
// DEPARTMENT STATUS AND THE DOWNSTREAM HANDOVER — MERCHANDISING'S SIDE.
//
// A fourth router on the same mount, for the same reason the third was: a
// pack, a department register and a delivery sweep are not the execution
// file's own record, and `executionRoute.js` is already the widest surface in
// the module.
//
// ── THE ROUTE THAT DOES NOT EXIST ───────────────────────────────────────────
// There is no `POST /files/:id/department-status`, and there is no handler
// anywhere on this router that writes a projection. That absence is the M6
// guarantee: Merchandising can see what every department has said and can
// state nothing on their behalf. A projection is written by exactly one thing,
// `departmentStatusIntake.service.js`, applying an event its owner published.
//
// ── AND THE ROUTES THAT BELONG TO PPC ───────────────────────────────────────
// Accepting a pack and asking for clarification are not here either. They are
// on `routes/CMS_Routes/PPC/inboundPacksRoute.js`, behind PPC's own live
// grant. Putting them here — even gated on a different capability — would mean
// a Merchandising seat could reach them, and PPC's authority would be a
// courtesy rather than a boundary.
//
// ── AUTHORITY ───────────────────────────────────────────────────────────────
// Reading is `file.read`, because a merchandiser who cannot see where their
// own handover stands has no reason to be here. Everything that assembles,
// sends or retries is `handover.submit`, which the access service already
// places at approver. No new capability constant.
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
const departmentStatus = require("../../../services/merchandising/departmentStatus.service");
const pack = require("../../../services/merchandising/executionPack.service");
const delivery = require("../../../services/integration/executionPackDelivery.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "Merchandising" });
const canRead = merchandisingCapability(CAPABILITY.FILE_READ);
const canSubmit = merchandisingCapability(CAPABILITY.HANDOVER_SUBMIT);

const actor = (req) => (req.user?.id
  ? { id: req.user.id, name: req.user.name || "", email: req.user.email || "" }
  : null);

const idempotencyKey = (req) => String(
  req.get("Idempotency-Key") || req.body?.idempotencyKey || "",
).trim();

/* ═══ DEPARTMENT STATUS — READ ONLY, IN EVERY SENSE ════════════════════════ */

/**
 * GET /files/:id/department-status — all eight departments, always.
 *
 * A department that has said nothing still gets a row, carrying the sentence
 * that says so. A missing row would be a gap, and a gap reads as fine.
 */
router.get("/files/:id/department-status", requireCompany, canRead, handle(async (req, res) => {
  const out = await departmentStatus.register(req.merchandising, { fileId: req.params.id });
  return res.json({ success: true, ...out });
}));

/** GET /files/:id/department-status/:department — one department's history. */
router.get("/files/:id/department-status/:department", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await departmentStatus.history(req.merchandising, {
      fileId: req.params.id, department: req.params.department,
      cursor: req.query.cursor, limit: req.query.limit,
    });
    return res.json({ success: true, ...out });
  }));

/* ═══ THE PACK ═════════════════════════════════════════════════════════════ */

router.get("/files/:id/pack", requireCompany, canRead, handle(async (req, res) => {
  const out = await pack.getPack(req.merchandising, { fileId: req.params.id });
  return res.json({ success: true, ...out });
}));

/**
 * GET /files/:id/pack/preview — what a submission would carry, writing nothing.
 *
 * Deliberately a read: somebody must be able to find out what is missing
 * without creating a record to find out.
 */
router.get("/files/:id/pack/preview", requireCompany, canRead, handle(async (req, res) => {
  const out = await pack.previewPack(req.merchandising, { fileId: req.params.id });
  return res.json({ success: true, ...out });
}));

router.get("/files/:id/pack/versions", requireCompany, canRead, handle(async (req, res) => {
  const out = await pack.listPackVersions(req.merchandising, {
    fileId: req.params.id, cursor: req.query.cursor, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

router.get("/files/:id/pack/versions/:packVersionNo", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await pack.getPackVersion(req.merchandising, {
      fileId: req.params.id, packVersionNo: req.params.packVersionNo,
    });
    return res.json({ success: true, ...out });
  }));

/** PPC's decision, read-only. Merchandising has no write path to it. */
router.get("/files/:id/pack/receipt", requireCompany, canRead, handle(async (req, res) => {
  const out = await pack.getReceipt(req.merchandising, { fileId: req.params.id });
  return res.json({ success: true, ...out });
}));

router.post("/files/:id/pack", requireCompany, canSubmit, handle(async (req, res) => {
  const out = await pack.createDraft(req.merchandising, {
    fileId: req.params.id, actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.status(201).json({ success: true, ...out });
}));

router.post("/files/:id/pack/refresh", requireCompany, canSubmit, handle(async (req, res) => {
  const out = await pack.refreshDraft(req.merchandising, {
    fileId: req.params.id, body: req.body || {}, actor: actor(req),
  });
  return res.json({ success: true, ...out });
}));

/**
 * POST /files/:id/pack/submit — gate, freeze, announce, then carry.
 *
 * The carry happens AFTER the transaction commits and never inside it: a
 * commercial act must survive a receiver that is momentarily unable to take
 * it. `deliverPending` never throws, and what it reports is stated in the
 * response rather than assumed.
 */
router.post("/files/:id/pack/submit", requireCompany, canSubmit, handle(async (req, res) => {
  const out = await pack.submitPack(req.merchandising, {
    fileId: req.params.id, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  const carried = await delivery.deliverPending({
    companyId: req.merchandising.companyId, limit: 50,
  });
  return res.json({
    success: true,
    ...out,
    downstream: {
      delivered: carried.delivered,
      pending: carried.pending,
      /* Stated, so a screen showing "PPC has it" shows it because PPC has it. */
      note: carried.pending
        ? "The pack is submitted. Its announcement has not reached PPC yet and will be retried."
        : "The pack is submitted and is in PPC's queue.",
    },
  });
}));

router.post("/files/:id/pack/withdraw", requireCompany, canSubmit, handle(async (req, res) => {
  const out = await pack.withdrawDraft(req.merchandising, {
    fileId: req.params.id, body: req.body || {}, actor: actor(req),
  });
  return res.json({ success: true, ...out });
}));

/* ═══ DELIVERY ═════════════════════════════════════════════════════════════ */

/** What has not reached PPC yet, and why. */
router.get("/downstream/delivery", requireCompany, canRead, handle(async (req, res) => {
  const out = await delivery.pendingSummary({ companyId: req.merchandising.companyId });
  return res.json({ success: true, ...out });
}));

/**
 * POST /downstream/delivery/retry — drain by hand.
 *
 * There is no daemon. A stuck announcement is retried by a person who can see
 * it is stuck, which is why the summary above exists beside this.
 */
router.post("/downstream/delivery/retry", requireCompany, canSubmit, handle(async (req, res) => {
  const out = await delivery.deliverPending({
    companyId: req.merchandising.companyId, limit: req.body?.limit,
  });
  return res.json({ success: true, ...out });
}));

module.exports = router;
