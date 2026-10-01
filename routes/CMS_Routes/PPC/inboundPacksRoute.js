// routes/CMS_Routes/PPC/inboundPacksRoute.js
//
// PPC'S INBOUND HANDOVER QUEUE. THE FIRST PPC SURFACE IN THE REPOSITORY.
//
// ── WHY THIS EXISTS AS ITS OWN ROUTER, UNDER ITS OWN MOUNT ──────────────────
// M6's exit condition is that Merchandising can hand off *while every
// downstream owner retains its authority*. If accepting a pack lived on a
// Merchandising router behind a Merchandising capability, PPC would have no
// authority at all — only a screen — and the boundary would be a naming
// convention rather than a rule.
//
// So the receiving decision lives here, at `/api/cms/ppc`, behind a LIVE PPC
// department grant read on every request. A Merchandising grant of any
// level — viewer, editor, approver, owner — opens nothing on this router.
//
// ── WHAT IS HONESTLY NEW, AND WHAT IS DELIBERATELY NOT ──────────────────────
// There was no PPC application before M6. This adds the smallest surface that
// makes the handover real: a queue, one pack, accept, and ask for
// clarification. It does not invent PPC planning, capacity booking, line
// allocation or release to production — those are PPC's own application to
// build. M6's job is to make sure that when somebody builds it, the receiving
// decision was already theirs rather than something they inherited from
// Merchandising.
//
// ── AND THERE IS NO REJECT ──────────────────────────────────────────────────
// The receipt model has no such state, so there is no route for one. PPC may
// ask for clarification, which sends the file back to Merchandising with a
// category and a reason. Refusing the company's confirmed commercial
// requirement outright is not PPC's call, exactly as declining a Sales
// handover is not Merchandising's.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { handle } = require("../../../services/storePurchase/errors");
const { CAPABILITY, ppcCapability } = require("../../../services/ppc/access.service");
const {
  merchandisingCompanyMiddleware,
} = require("../../../services/companyContext/merchandisingScope.service");
const inbound = require("../../../services/ppc/inboundPack.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

/* The company resolver is shared because it answers a question that has
   nothing to do with department authority: which of the actor's OWN company
   memberships they are acting in. The `domainLabel` is what a refusal names. */
const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "PPC" });

const canRead = ppcCapability(CAPABILITY.INBOUND_READ);
const canDecide = ppcCapability(CAPABILITY.INBOUND_DECIDE);

const actor = (req) => (req.user?.id
  ? { id: req.user.id, name: req.user.name || "", email: req.user.email || "" }
  : null);

const idempotencyKey = (req) => String(
  req.get("Idempotency-Key") || req.body?.idempotencyKey || "",
).trim();

/** The queue: what Merchandising has handed down and PPC has not yet decided. */
router.get("/inbound-packs", requireCompany, canRead, handle(async (req, res) => {
  const out = await inbound.listInbound(req.merchandising, {
    view: req.query.view, cursor: req.query.cursor, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

/** One pack, in full — the references, the gates and the declaration. */
router.get("/inbound-packs/:packId", requireCompany, canRead, handle(async (req, res) => {
  const out = await inbound.getInbound(req.merchandising, { packId: req.params.packId });
  return res.json({ success: true, ...out });
}));

/**
 * ACCEPT — the decision that actually hands the file over.
 *
 * Behind `ppc.inbound.decide`, which sits at approver: seeing what has arrived
 * and committing the department to it are different authorities.
 */
router.post("/inbound-packs/:packId/accept", requireCompany, canDecide, handle(async (req, res) => {
  const out = await inbound.accept(req.merchandising, {
    packId: req.params.packId, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.json({ success: true, ...out });
}));

/** CLARIFY — a category and a reason long enough for a merchandiser to act on. */
router.post("/inbound-packs/:packId/clarify", requireCompany, canDecide, handle(async (req, res) => {
  const out = await inbound.requestClarification(req.merchandising, {
    packId: req.params.packId, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.json({ success: true, ...out });
}));

module.exports = router;
