// routes/CMS_Routes/Merchandising/developmentRoute.js
//
// PRE-ORDER DEVELOPMENT — MERCHANDISING'S SIDE.
//
// The sixth router on the Merchandising mount, and the first that is about
// work before an order exists.
//
// ── THE ROUTES THAT DO NOT EXIST ────────────────────────────────────────────
// There is no route that CREATES a development request — that is Sales', on
// Sales' own router. And there is no route that RELEASES a file to R&D:
// approving says Merchandising's selection is settled, releasing says the
// buyer relationship justifies spending the development budget, and the second
// is a commercial judgement Merchandising does not make. It arrives through
// Sales' own authorisation event.
//
// ── AUTHORITY, FROM THE EXISTING FOURTEEN ───────────────────────────────────
// No capability constant is added. Reading is `file.read`; answering Sales is
// `brief.review`, the same authority that accepts a handover; selecting is
// `selection.write`; approving is `selection.approve`; assigning is
// `file.assign`; holding and closing are `file.lifecycle`. Pre-order and
// post-order work are the same kinds of decision at different stages, so they
// are the same authorities.
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
const development = require("../../../services/merchandising/development.service");
const adoption = require("../../../services/merchandising/developmentAdoption.service");
const legacy = require("../../../services/merchandising/developmentLegacy.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "Merchandising" });
const canRead = merchandisingCapability(CAPABILITY.FILE_READ);
const canReview = merchandisingCapability(CAPABILITY.BRIEF_REVIEW);
const canSelect = merchandisingCapability(CAPABILITY.SELECTION_WRITE);
const canApprove = merchandisingCapability(CAPABILITY.SELECTION_APPROVE);
const canAssign = merchandisingCapability(CAPABILITY.FILE_ASSIGN);
const canMoveLifecycle = merchandisingCapability(CAPABILITY.FILE_LIFECYCLE);

const actor = (req) => (req.user?.id
  ? { id: req.user.id, name: req.user.name || "", email: req.user.email || "" }
  : null);

const ctx = (req) => ({ ...req.merchandising, actorEmail: req.user?.email || "" });

const idempotencyKey = (req) => String(
  req.get("Idempotency-Key") || req.body?.idempotencyKey || "",
).trim();

/* ═══ THE REGISTER ═════════════════════════════════════════════════════════
   Before the `/:fileId` patterns, so `overview` is never read as a file id. */

router.get("/development/overview", requireCompany, canRead, handle(async (req, res) => {
  const out = await development.developmentOverview(ctx(req));
  return res.json({ success: true, ...out });
}));

router.get("/development", requireCompany, canRead, handle(async (req, res) => {
  const out = await development.listFiles(ctx(req), {
    view: req.query.view, q: req.query.q, assignedTo: req.query.assignedTo,
    includeArchived: req.query.includeArchived === "true",
    /* What the Overview's clarification count opens. Asking Sales a question
       does not move the lifecycle, so this is a filter on the receipt rather
       than a view. */
    awaitingClarification: req.query.awaitingClarification === "true",
    cursor: req.query.cursor, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

/* ═══ ONE DEVELOPMENT FILE ═════════════════════════════════════════════════ */

router.get("/development/:fileId", requireCompany, canRead, handle(async (req, res) => {
  const out = await development.getFile(ctx(req), { fileId: req.params.fileId });
  return res.json({ success: true, ...out });
}));

router.get("/development/:fileId/history", requireCompany, canRead, handle(async (req, res) => {
  const out = await development.fileHistory(ctx(req), {
    fileId: req.params.fileId, cursor: req.query.cursor, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

/** The registered product's approved BOM, as read-only source evidence. */
router.get("/development/:fileId/registered-product-bom", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await development.registeredProductBom(ctx(req), { fileId: req.params.fileId });
    return res.json({ success: true, ...out });
  }));

/* ── ANSWERING SALES ─────────────────────────────────────────────────────
   `brief.review` — the same authority that accepts a Sales handover, because
   it is the same kind of act one stage earlier. */

router.post("/development/:fileId/accept", requireCompany, canReview, handle(async (req, res) => {
  const out = await development.acceptRequest(ctx(req), {
    fileId: req.params.fileId, actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.json({ success: true, ...out });
}));

router.post("/development/:fileId/clarify", requireCompany, canReview, handle(async (req, res) => {
  const out = await development.clarifyRequest(ctx(req), {
    fileId: req.params.fileId, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.json({ success: true, ...out });
}));

router.post("/development/:fileId/assignments", requireCompany, canAssign, handle(async (req, res) => {
  const out = await development.assignFile(ctx(req), {
    fileId: req.params.fileId, body: req.body || {}, actor: actor(req),
  });
  return res.json({ success: true, ...out });
}));

router.post("/development/:fileId/lifecycle/:command", requireCompany, canMoveLifecycle,
  handle(async (req, res) => {
    const out = await development.moveLifecycle(ctx(req), {
      fileId: req.params.fileId, command: req.params.command,
      body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* ═══ THE SELECTION ════════════════════════════════════════════════════════
   Writing and DECIDING are different authorities, as everywhere else in this
   module: `selection.write` composes a draft, `selection.approve` settles it,
   and the approver may not be its author. */

router.post("/development/:fileId/bom", requireCompany, canSelect, handle(async (req, res) => {
  const out = await development.createDraft(ctx(req), {
    fileId: req.params.fileId, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.status(201).json({ success: true, ...out });
}));

/** Bring the registered product's identities across. Approves nothing. */
router.post("/development/:fileId/bom/adopt-product", requireCompany, canSelect,
  handle(async (req, res) => {
    const out = await development.adoptRegisteredProductBom(ctx(req), {
      fileId: req.params.fileId, body: req.body || {},
      actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

router.post("/development/:fileId/bom/rows", requireCompany, canSelect, handle(async (req, res) => {
  const out = await development.addRow(ctx(req), {
    fileId: req.params.fileId, body: req.body || {}, actor: actor(req),
  });
  return res.status(201).json({ success: true, ...out });
}));

router.patch("/development/:fileId/bom/rows/:rowRef", requireCompany, canSelect,
  handle(async (req, res) => {
    const out = await development.updateRow(ctx(req), {
      fileId: req.params.fileId, rowRef: req.params.rowRef,
      body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

router.delete("/development/:fileId/bom/rows/:rowRef", requireCompany, canSelect,
  handle(async (req, res) => {
    const out = await development.removeRow(ctx(req), {
      fileId: req.params.fileId, rowRef: req.params.rowRef,
      body: { ...(req.body || {}), expectedRevision: req.body?.expectedRevision ?? req.query.expectedRevision },
      actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* Submitting sits with the WRITER: advancing your own draft for somebody else
   to read is not an approval, and requiring the approver capability would mean
   an editor could never move their own work at all. The separation the process
   needs is enforced in `approve`. */
router.post("/development/:fileId/bom/submit", requireCompany, canSelect, handle(async (req, res) => {
  const out = await development.submitBom(ctx(req), {
    fileId: req.params.fileId, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.json({ success: true, ...out });
}));

router.post("/development/:fileId/bom/approve", requireCompany, canApprove, handle(async (req, res) => {
  const out = await development.approveBom(ctx(req), {
    fileId: req.params.fileId, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.json({ success: true, ...out });
}));

router.post("/development/:fileId/bom/request-changes", requireCompany, canApprove,
  handle(async (req, res) => {
    const out = await development.requestChanges(ctx(req), {
      fileId: req.params.fileId, body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* ═══ LEGACY MIGRATION ═════════════════════════════════════════════════════
   Preview then adopt, never automatically, and the legacy record is only ever
   read — see the service for why an unreviewed selection must not become an
   approved one by being moved. */

router.get("/development/:fileId/legacy/preview", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await legacy.preview(ctx(req), { fileId: req.params.fileId });
    return res.json({ success: true, ...out });
  }));

router.post("/development/:fileId/legacy/adopt", requireCompany, canSelect,
  handle(async (req, res) => {
    const out = await legacy.adopt(ctx(req), {
      fileId: req.params.fileId, body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* ═══ CONFIRMED-ORDER ADOPTION ═════════════════════════════════════════════
   On the EXECUTION file, because that is the record being adopted into. */

router.get("/files/:id/development-bom-adoption/preview", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await adoption.preview(req.merchandising, { fileId: req.params.id });
    return res.json({ success: true, ...out });
  }));

router.post("/files/:id/development-bom-adoption/adopt", requireCompany, canSelect,
  handle(async (req, res) => {
    const out = await adoption.adopt(req.merchandising, {
      fileId: req.params.id, actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

module.exports = router;
