// routes/CMS_Routes/Inventory/Sourcing/sourcingDecisions.js
//
// STORE DECIDES WHICH QUOTATION PRICES A REQUIREMENT.
//
// ── WHY THIS SITS IN THE SOURCING FOLDER ────────────────────────────────────
// Beside the supplier-offer register, under the same tenant guard and the same
// two grants. A quotation and the decision to use it are the same commercial
// act recorded at two moments, and separating them into different apps is what
// put the second one in Central Costing in the first place.
//
// ── THE GRANTS ──────────────────────────────────────────────────────────────
// `sp.read` to see the queue, `sp.sourcing.manage` to decide — the identical
// pair `supplierOffers.js` uses, because the same people who write a quotation
// down are the people who choose between them. Nothing new is invented, and
// platform administration does not silently become commercial authority: the
// capability set is the Store one, granted per company.
//
// ── AND WHAT LEAVES HERE ────────────────────────────────────────────────────
// Rates, suppliers, tiers, minimums and validity — all of it, because this IS
// the Store screen and Store owns those facts. That is the exact opposite of
// what the departmental readiness endpoints may say, and the difference is the
// point: a merchandiser is told a decision is outstanding and who owns it; a
// buyer is told what the company was quoted.
"use strict";

const express = require("express");

const router = express.Router();

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const {
  requireTenant, requireCapability, withIdempotency, CAPABILITIES,
} = require("../../../../Middlewear/storePurchaseTenant");
const { sendError, handle } = require("../../../../services/storePurchase/errors");
const sourcingDecision = require("../../../../services/storePurchase/sourcingDecision.service");

router.use(EmployeeAuthMiddleware);
router.use(requireTenant);

const canRead = requireCapability(CAPABILITIES.READ);
const canDecide = requireCapability(CAPABILITIES.SOURCING_MANAGE);

/**
 * The context the decision service takes.
 *
 * `actorName` comes from the tenant, which resolved it from the employee
 * record — never from the body. A supplier choice with somebody else's name on
 * it is worse than an anonymous one.
 */
const ctxOf = (req) => ({
  companyId: req.tenant.companyId,
  actorId: req.user?.id ? String(req.user.id) : "",
  actorName: req.tenant.actorName || req.user?.name || "",
  reason: "sourcing_decision",
});

/**
 * GET /  — every requirement in the company waiting for a sourcing decision.
 *
 * Readable with `sp.read`: knowing what is outstanding is not the same as
 * deciding it, and a buyer who cannot see the queue cannot prepare for the
 * conversation with the supplier.
 */
router.get("/", canRead, handle(async (req, res) => {
  const queue = await sourcingDecision.openQueue(ctxOf(req), { limit: req.query.limit });
  return res.json({
    success: true,
    ...queue,
    /* So the screen can show the queue to a viewer without offering them a
       control that would be refused. The set the tenant already resolved —
       not a second opinion about who may decide. */
    canDecide: Boolean(req.tenant.capabilitySet?.has(CAPABILITIES.SOURCING_MANAGE)),
  });
}));

/**
 * GET /costing/:costingId — one costing's outstanding and settled decisions.
 *
 * The focused view: what this order still needs sourced, what was already
 * chosen, and — where a decision has gone stale — the one that no longer
 * applies, beside the candidates that do.
 */
router.get("/costing/:costingId", canRead, handle(async (req, res) => {
  const out = await sourcingDecision.openDecisionsForCosting(ctxOf(req), req.params.costingId);
  return res.json({
    success: true,
    costing: {
      id: String(out.costing._id),
      label: out.costing.contextSnapshot?.label || out.costing.context?.externalKey || "",
      status: out.costing.status,
    },
    decisions: out.decisions,
    decided: (out.decided || []).map(serializeDecision),
    ...(out.unavailable ? { unavailable: out.unavailable } : {}),
  });
}));

/**
 * POST /costing/:costingId — record the choice.
 *
 * Idempotent on the caller's key, like every other Store write: a retry of one
 * user action must not produce two decisions with two timestamps and two
 * names on them.
 */
router.post(
  "/costing/:costingId",
  canDecide,
  withIdempotency("SOURCING_DECISION_RECORD"),
  handle(async (req, res) => {
    const decision = await sourcingDecision.record(ctxOf(req), {
      costingId: req.params.costingId,
      lineKey: req.body?.lineKey,
      offerId: req.body?.offerId,
      note: req.body?.note,
    });
    const body = { success: true, decision: serializeDecision(decision.toObject ? decision.toObject() : decision) };
    return req.idempotent ? req.idempotent.succeed(201, body) : res.status(201).json(body);
  }),
);

/**
 * DELETE /costing/:costingId?lineKey=… — take a decision back.
 *
 * The requirement returns to the queue and the costing goes back to reporting
 * it as unresolved. The withdrawn row stays: a supplier choice that was
 * reversed is a thing people ask about later.
 *
 * ── THE LINE KEY IS A QUERY, NOT A PATH SEGMENT ─────────────────────────────
 * These keys contain colons and slashes — `mat:<item>::`, `svc:svc:<id>`,
 * `freight:outbound` — so a path parameter would have to be a wildcard, and a
 * wildcard segment matching an id-shaped string is how one route quietly
 * starts answering for another.
 */
router.delete("/costing/:costingId", canDecide, handle(async (req, res) => {
  const out = await sourcingDecision.withdraw(ctxOf(req), {
    costingId: req.params.costingId,
    lineKey: req.query.lineKey,
  });
  return res.json({ success: true, ...out });
}));

/**
 * What a decision looks like on the wire.
 *
 * The commercial context is included because this is Store's own screen. No
 * rate is here — not because it is secret, but because it is not stored: the
 * quotation is read from its register every time, and a copy kept here would
 * be a second number that could drift from the one the costing uses.
 */
function serializeDecision(d) {
  return {
    id: String(d._id),
    costingId: String(d.costingId),
    lineKey: d.lineKey,
    subject: {
      kind: d.subject?.kind || null,
      label: d.subject?.label || "",
      itemId: d.subject?.itemId ? String(d.subject.itemId) : null,
      variantId: d.subject?.variantId ? String(d.subject.variantId) : null,
      serviceId: d.subject?.serviceId ? String(d.subject.serviceId) : null,
      destinationLabel: d.subject?.destinationLabel || "",
      mode: d.subject?.mode || "",
    },
    offerId: String(d.offerId),
    offerKind: d.offerKind,
    context: {
      supplierName: d.context?.supplierName || "",
      quotationReference: d.context?.quotationReference || "",
      offerRevision: d.context?.offerRevision ?? null,
      currency: d.context?.currency || "",
      judgedQuantity: d.context?.judgedQuantity || "",
      judgedUom: d.context?.judgedUom || "",
      asOf: d.context?.asOf || null,
      candidateCount: d.context?.candidateCount ?? null,
    },
    state: d.state,
    decidedByActorName: d.decidedByActorName || "",
    decidedAt: d.decidedAt || null,
    note: d.note || "",
  };
}

router.use((err, _req, res, _next) => sendError(res, err));

module.exports = router;
