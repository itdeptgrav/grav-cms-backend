// routes/CMS_Routes/StorePurchase/context.js
//
// Store & Purchase — Chunk 1. WHAT THE BROWSER IS ALLOWED TO KNOW ABOUT ITSELF.
//
// Mount: /api/cms/store-purchase
//
// The frontend needs capabilities to decide what to show. It must get them
// from the server rather than deriving them from a role string, because the
// existing RoleGate defaults to OPEN and therefore shows every control to a
// user with no department role at all. This endpoint is the authoritative
// answer, and hiding a button on the strength of it is still only usability —
// every write re-checks server-side.
"use strict";

const express = require("express");
const router = express.Router();

const EmployeeAuth = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { requireTenant, requireCapability } = require("../../../Middlewear/storePurchaseTenant");
const { CAPABILITIES } = require("../../../services/storePurchase/capabilities");
const actionHistory = require("../../../services/storePurchase/actionHistory.service");
const { handle } = require("../../../services/storePurchase/errors");

router.use(EmployeeAuth);

/**
 * GET /context — who am I, in this domain?
 *
 * Deliberately available to any authenticated user, INCLUDING one with no
 * capabilities: the browser needs "you have none" to render the forbidden
 * state, and refusing the question would leave it guessing. It carries no
 * business data.
 */
router.get(
  "/context",
  handle(async (req, res) => {
    /* Resolved by hand rather than through requireTenant, because a user
       whose membership cannot be proved must still receive a usable answer
       here — "you are signed in, and Store & Purchase is not available to
       you" — instead of a bare 403 the shell cannot render. */
    const tenantContext = require("../../../services/storePurchase/tenantContext.service");
    let ctx = null;
    let unavailable = null;
    try {
      ctx = await tenantContext.resolveForActor(req.user);
    } catch (err) {
      unavailable = { code: err.code, message: err.message };
    }

    return res.json({
      success: true,
      context: ctx
        ? {
            actorId: ctx.actorId,
            actorName: ctx.actorName,
            companyId: String(ctx.companyId),
            permittedSiteIds: ctx.permittedSiteIds,
            capabilities: ctx.capabilities,
            membershipSource: ctx.membershipSource,
            isAdmin: ctx.isAdmin,
          }
        : null,
      unavailable,
      /* The full vocabulary, so the client can reason about capabilities it
         does not hold without hard-coding the list. */
      knownCapabilities: Object.values(CAPABILITIES),
    });
  }),
);

/**
 * GET /history — the immutable record, tenant-scoped.
 *
 * Read-only by construction: there is no POST, PUT or DELETE here, and the
 * model refuses mutation even if one were added.
 */
router.get(
  "/history",
  requireTenant,
  requireCapability(CAPABILITIES.HISTORY_READ),
  handle(async (req, res) => {
    const { entityType, entityId, limit } = req.query;
    const entries = await actionHistory.listFor(req.tenant, { entityType, entityId, limit });
    return res.json({
      success: true,
      entries: entries.map((e) => ({
        id: String(e._id),
        at: e.at,
        action: e.action,
        actorName: e.actorName,
        documentNumber: e.documentNumber,
        entityType: e.entityType,
        entityId: String(e.entityId),
        previousState: e.previousState,
        resultingState: e.resultingState,
        reason: e.reason,
        changes: e.changes || [],
        metadata: e.metadata || {},
      })),
    });
  }),
);

module.exports = router;
