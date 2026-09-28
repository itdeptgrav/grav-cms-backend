// Middlewear/centralCostingContext.js
//
// Central Costing — Chunk 1. THE ONE PLACE COMPANY AND PERMISSION ARE APPLIED.
//
// Lives in `Middlewear/` (the misspelled directory the repo's auth middlewares
// already use) beside EmployeeAuthMiddlewear rather than starting a second
// convention.
//
// It runs AFTER EmployeeAuthMiddlewear and never replaces it: authentication
// stays where it is, and this adds the two questions authentication never
// asked — whose company, and may they see this. Authentication alone grants
// nothing here; a valid token with no costing grant reaches no endpoint.
"use strict";

const companyContext = require("../services/centralCosting/companyContext.service");
const { hasAll, hasAny } = require("../services/centralCosting/capabilities");
const idempotency = require("../services/storePurchase/idempotency.service");
const { fail, sendError } = require("../services/storePurchase/errors");

/**
 * Resolve the costing context onto `req.costing`.
 *
 * Fails closed: a caller whose company cannot be proved gets a refusal and no
 * data, never an implicit "all companies".
 */
function requireCostingContext(req, res, next) {
  /* The company a multi-company actor says they are working in. It SELECTS
     which of their own memberships to use and is validated against them; it is
     never authority on its own, and a single-membership actor's value is
     ignored entirely. Read from a header/query so it can never be confused
     with a `companyId` in a record's body — which is refused outright. */
  const requestedCompanyId =
    req.get("X-Costing-Company") || req.query?.actingCompanyId || null;

  companyContext
    .resolveForActor(req.user, { requestedCompanyId })
    .then((ctx) => {
      req.costing = ctx;
      next();
    })
    .catch((err) => sendError(res, err));
}

/** Require every one of these capabilities. */
const requireCapability = (...required) => (req, res, next) => {
  if (!req.costing) {
    return sendError(res, fail("UNAUTHENTICATED", "Sign in to use Central Costing."));
  }
  if (!hasAll(req.costing.capabilitySet, required)) {
    /* The message never names the internal key — that goes in `details` for
       the client to reason about, not in prose for a person to puzzle over. */
    return sendError(res, fail("FORBIDDEN", "You do not have permission to do that in costing.", {
      required,
    }));
  }
  next();
};

/**
 * Require at least one of these capabilities.
 *
 * Used by the read routes: several different capabilities are a legitimate
 * reason to open a costing, and WHICH parts of it the holder then receives is
 * decided by the visibility layer, not here. Gate and redaction stay separate
 * so neither has to reproduce the other's rules.
 */
const requireAnyCapability = (...any) => (req, res, next) => {
  if (!req.costing) {
    return sendError(res, fail("UNAUTHENTICATED", "Sign in to use Central Costing."));
  }
  if (!hasAny(req.costing.capabilitySet, any)) {
    return sendError(res, fail("FORBIDDEN", "You do not have permission to view costings.", {
      requiredAnyOf: any,
    }));
  }
  next();
};

/**
 * Idempotency for a mutating handler.
 *
 * ── WHY IT REUSES STORE'S SERVICE ───────────────────────────────────────────
 * `services/storePurchase/idempotency.service.js` and its record are
 * domain-neutral by construction: they key on `{companyId, actorId, operation,
 * key}` and hash a canonical body. Nothing in them is about stock or purchase
 * orders. A second idempotency system would be a second set of retry
 * semantics for clients to learn and for this repository to keep in step.
 * The move to a neutral path is a mechanical rename recorded in the decision
 * record.
 *
 * The handler receives `req.idempotent.succeed(status, body)` and must call it
 * instead of `res.json` on the success path, so the replayed response is
 * exactly the one the first caller got.
 */
const withIdempotency = (operation, { required = true } = {}) => async (req, res, next) => {
  const key = req.get("Idempotency-Key") || req.get("idempotency-key");
  if (!key && !required) return next();

  try {
    const claim = await idempotency.begin({
      ctx: req.costing,
      operation,
      key,
      body: req.body,
    });

    if (claim.outcome === "REPLAY") {
      res.set("Idempotency-Replayed", "true");
      return res.status(claim.response.status).json(claim.response.body);
    }

    /* ── A RECOVERED CLAIM IS NOT A SECOND CREATE ────────────────────────
     * The effect already committed on an earlier attempt whose response never
     * landed. Re-running the create would produce a second costing for one
     * user action, which is the failure idempotency exists to prevent — so the
     * handler is never reached. The record names what it produced, and the
     * caller is pointed at it.
     *
     * There is no "finish the bookkeeping" branch here because, unlike Store's
     * receipts, a costing create writes no separate history entry to be left
     * behind: the version's own provenance IS the record, and it committed
     * with the version. */
    if (claim.outcome === "RECOVER") {
      const id = claim.effect?.entityId ? String(claim.effect.entityId) : null;
      res.set("Idempotency-Recovered", "true");
      return sendError(res, fail(
        "CONFLICT",
        "This request was interrupted after the costing had already been created. Open it rather than sending again.",
        { reason: "RECONCILIATION_REQUIRED", costingId: id },
      ));
    }

    let settled = false;

    req.idempotent = {
      key,
      record: claim.record,
      /* ── THE DURABLE MARKER ────────────────────────────────────────────
       * Written the instant the domain write commits and before anything that
       * could still fail. From here a retry can never re-run the create: it
       * takes the RECOVER branch above instead. Without it, a `complete()`
       * that failed would leave the record IN_PROGRESS, and a retry after the
       * stale-claim window would create a SECOND costing for one action. */
      markEffect: (entityType, entityId, session = null) =>
        idempotency.markEffectApplied({ record: claim.record, entityType, entityId, session }),
      succeed: async (status, body, meta = {}) => {
        /* Surfaced, not swallowed: if the record cannot be completed the
           caller must not be told the action is finished and replayable — it
           is neither. Safe to re-throw, because the retry it provokes hits the
           RECOVER branch above rather than creating a second costing. */
        await idempotency.complete({ record: claim.record, status, body, ...meta });
        settled = true;
        return res.status(status).json(body);
      },
    };

    /* A refused request must never become a replayable success, and the claim
       has to be released BEFORE the client can retry — so `res.json` is
       wrapped rather than the `finish` event listened for. */
    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      if (settled) return originalJson(payload);
      settled = true;
      const reason = res.statusCode >= 400
        ? `HTTP ${res.statusCode}`
        : `UNCLAIMED_SUCCESS ${res.statusCode}`;
      if (res.statusCode < 400) {
        console.error(
          `[centralCosting idempotency] ${operation} answered ${res.statusCode} without completing ` +
          "its idempotency record. The action is not replayable; route it through succeed().",
        );
      }
      return idempotency
        .abandon({ record: claim.record, reason })
        .catch((err) => {
          console.error(
            `[centralCosting idempotency] abandon failed for ${operation} key=${key}:`,
            err?.message || err,
          );
          try { res.set("Idempotency-Settlement", "abandon-failed"); } catch { /* headers sent */ }
        })
        .then(() => originalJson(payload));
    };

    next();
  } catch (err) {
    sendError(res, err);
  }
};

module.exports = {
  requireCostingContext, requireCapability, requireAnyCapability, withIdempotency,
  CAPABILITIES: companyContext.CAPABILITIES,
};
