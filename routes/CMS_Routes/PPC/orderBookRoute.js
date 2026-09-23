// routes/CMS_Routes/PPC/orderBookRoute.js
//
// THE PPC ORDER BOOK AND ITS PLANNING FILES.
//
// Mounted beside `inboundPacksRoute` and `ieReleasesRoute` under
// `/api/cms/ppc`, built to the same shapes for the same reason: a department
// with three inbound surfaces should not have to learn three kinds of API.
//
//   GET   /order-book/summary
//   GET   /order-book?view=&cursor=&limit=&search=
//   GET   /order-book/:orderLineRef
//   GET   /order-book/:orderLineRef/planning-files
//   POST  /order-book/:orderLineRef/planning-file
//   GET   /planning-files/:planningFileId
//   PATCH /planning-files/:planningFileId
//   POST  /planning-files/:planningFileId/planning-started
//   POST  /planning-files/:planningFileId/planned
//   POST  /planning-files/:planningFileId/hold
//   POST  /planning-files/:planningFileId/hold/remove
//   POST  /planning-files/:planningFileId/successor
//   POST  /planning-files/:planningFileId/cancel
//   GET   /planning-files/:planningFileId/source-health
//   GET   /planning-files/:planningFileId/history
//
// ── WHAT THE REQUEST SETTLES, AND WHAT A BODY MAY NOT ───────────────────────
// The company comes from the actor's own membership, the person from the
// verified session, the record from the path and the idempotency key from the
// header. None of the four is readable from a body, and the service refuses a
// body that tries — including one carrying an upstream pack version, release id
// or receipt id, which are the server's to derive from the published contracts.
//
// ── AND THERE IS NO CAPACITY OR RELEASE VERB ────────────────────────────────
// No route books capacity, allocates a line, promises a start date, releases to
// Production or creates a Work Order. There is no such route and no state one
// could write: the planning file's enum has no such member.
// A test walks this router and asserts the absence by name.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { handle } = require("../../../services/storePurchase/errors");
const { ppcCapability, CAPABILITY } = require("../../../services/ppc/access.service");
const {
  merchandisingCompanyMiddleware,
} = require("../../../services/companyContext/merchandisingScope.service");
const orderBook = require("../../../services/ppc/orderBook.service");
const planning = require("../../../services/ppc/planningFile.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

/* The same shared resolver the other two PPC routers use: it answers which of
   the actor's OWN company memberships they are acting in, which has nothing to
   do with department authority. Never inferred from a body or from a record. */
const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "PPC" });

/** Seeing the order book. PPC `viewer`. */
const canRead = ppcCapability(CAPABILITY.PLANNING_READ);
/** Creating and editing a planning file. PPC `editor` — a planner. */
const canPlan = ppcCapability(CAPABILITY.PLANNING_WRITE);
/** Marking planned, holding, replacing a plan. PPC `approver`. */
const canApprove = ppcCapability(CAPABILITY.PLANNING_APPROVE);

const actor = (req) => (req.user?.id
  ? { id: req.user.id, name: req.user.name || "", email: req.user.email || "" }
  : null);

/* Header only. A body field could be replayed verbatim by a client that
   believed it was retrying, which is the one thing a key must never be. */
const idempotencyKey = (req) => String(req.get("Idempotency-Key") || "").trim();

/* ══ THE ORDER BOOK ═══════════════════════════════════════════════════════ */

/** The KPI strip — one count per view, and what could not be read. */
router.get("/order-book/summary", requireCompany, canRead, handle(async (req, res) => {
  const out = await orderBook.summary(req.merchandising, { search: req.query.search });
  return res.json({ success: true, ...out });
}));

/**
 * The register. Filtered, searched and paginated by the SERVER.
 *
 * Registered before `/order-book/:orderLineRef` so `summary` above is not
 * swallowed as a line reference — Express matches in declaration order.
 */
router.get("/order-book", requireCompany, canRead, handle(async (req, res) => {
  const out = await orderBook.register(req.merchandising, {
    view: req.query.view, cursor: req.query.cursor,
    limit: req.query.limit, search: req.query.search,
  });
  return res.json({ success: true, ...out });
}));

/** One confirmed order line, its inputs, and whichever plan owns it. */
router.get("/order-book/:orderLineRef", requireCompany, canRead, handle(async (req, res) => {
  const out = await orderBook.orderLineDetail(req.merchandising, {
    orderLineRef: req.params.orderLineRef,
  });
  return res.json({ success: true, ...out });
}));

/**
 * Every planning file this line has ever had, oldest generation first —
 * superseded and cancelled ones included, because an earlier plan must stay
 * readable after it stops owning the line.
 */
router.get("/order-book/:orderLineRef/planning-files",
  requireCompany, canRead, handle(async (req, res) => {
    const out = await planning.generations(req.merchandising, {
      orderLineRef: req.params.orderLineRef,
    });
    return res.json({ success: true, ...out });
  }));

/* ══ CREATING A PLANNING FILE ═════════════════════════════════════════════ */

/**
 * The line is named in the PATH, by its permanent reference.
 *
 * Not in the body, and never by buyer, style, product name or position: a
 * planning file created against a name would silently own the wrong line, and
 * the wrong row looks perfectly ordinary.
 */
router.post("/order-book/:orderLineRef/planning-file",
  requireCompany, canPlan, handle(async (req, res) => {
    const out = await planning.create(req.merchandising, {
      orderLineRef: req.params.orderLineRef,
      body: req.body || {},
      actor: actor(req),
      idempotencyKey: idempotencyKey(req),
    });
    return res.status(out.created ? 201 : 200).json({ success: true, ...out });
  }));

/* ══ ONE PLANNING FILE ════════════════════════════════════════════════════ */

router.get("/planning-files/:planningFileId", requireCompany, canRead, handle(async (req, res) => {
  const out = await planning.get(req.merchandising, { planningFileId: req.params.planningFileId });
  return res.json({ success: true, ...out });
}));

/** PPC's own planning fields. Optimistically concurrent on `expectedRevision`. */
router.patch("/planning-files/:planningFileId", requireCompany, canPlan, handle(async (req, res) => {
  const { expectedRevision, ...body } = req.body || {};
  const out = await planning.updateFields(req.merchandising, {
    planningFileId: req.params.planningFileId,
    expectedRevision, body, actor: actor(req),
  });
  return res.json({ success: true, ...out });
}));

router.get("/planning-files/:planningFileId/source-health",
  requireCompany, canRead, handle(async (req, res) => {
    const out = await planning.sourceHealth(req.merchandising, {
      planningFileId: req.params.planningFileId,
    });
    return res.json({ success: true, ...out });
  }));

router.get("/planning-files/:planningFileId/history",
  requireCompany, canRead, handle(async (req, res) => {
    const out = await planning.history(req.merchandising,
      { planningFileId: req.params.planningFileId }, { limit: req.query.limit });
    return res.json({ success: true, ...out });
  }));

/* ══ THE LIFECYCLE COMMANDS ═══════════════════════════════════════════════ */

/** OPEN → PLANNING. A planner picking the line up — a planner's own act. */
router.post("/planning-files/:planningFileId/planning-started",
  requireCompany, canPlan, handle(async (req, res) => {
    const out = await planning.markPlanningStarted(req.merchandising, {
      planningFileId: req.params.planningFileId,
      expectedRevision: req.body?.expectedRevision,
      actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

/**
 * PLANNING → PLANNED. An approver's, because other departments read it.
 *
 * And it books nothing: the reply carries `booksCapacity: false`,
 * `allocatesLine: false` and `releasesProduction: false` on its face.
 */
router.post("/planning-files/:planningFileId/planned",
  requireCompany, canApprove, handle(async (req, res) => {
    const out = await planning.markPlanned(req.merchandising, {
      planningFileId: req.params.planningFileId,
      expectedRevision: req.body?.expectedRevision,
      actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

router.post("/planning-files/:planningFileId/hold",
  requireCompany, canApprove, handle(async (req, res) => {
    const { expectedRevision, ...body } = req.body || {};
    const out = await planning.placeHold(req.merchandising, {
      planningFileId: req.params.planningFileId,
      expectedRevision, body, actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

router.post("/planning-files/:planningFileId/hold/remove",
  requireCompany, canApprove, handle(async (req, res) => {
    const { expectedRevision, ...body } = req.body || {};
    const out = await planning.removeHold(req.merchandising, {
      planningFileId: req.params.planningFileId,
      expectedRevision, body, actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

/**
 * An explicit successor after an authoritative input moved, or because an
 * approved plan has to change. Preserves the old. `expectedRevision` is the
 * predecessor's revision as the caller read it; without it nothing happens.
 */
router.post("/planning-files/:planningFileId/successor",
  requireCompany, canApprove, handle(async (req, res) => {
    const { expectedRevision, ...body } = req.body || {};
    const out = await planning.createSuccessor(req.merchandising, {
      planningFileId: req.params.planningFileId,
      expectedRevision, body,
      actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.status(out.created ? 201 : 200).json({ success: true, ...out });
  }));

/**
 * Cancel PPC's plan. Approver only, reasoned, terminal. Creates no successor,
 * deletes no history and writes nothing upstream.
 */
router.post("/planning-files/:planningFileId/cancel",
  requireCompany, canApprove, handle(async (req, res) => {
    const { expectedRevision, ...body } = req.body || {};
    const out = await planning.cancel(req.merchandising, {
      planningFileId: req.params.planningFileId,
      expectedRevision, body, actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

module.exports = router;
