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

const crypto = require("crypto");

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
/**
 * @param {string} operation  stays stable — the record being acted on goes into
 *   the fingerprint, not into a new operation name per record.
 * @param {object} [opts]
 * @param {boolean} [opts.required]
 * @param {(req) => string|null} [opts.target]  the record this key is bound to,
 *   derived on the SERVER from the URL. See the block comment below.
 */
const withIdempotency = (operation, { required = true, target = null } = {}) => async (req, res, next) => {
  const key = req.get("Idempotency-Key") || req.get("idempotency-key");
  if (!key && !required) return next();

  /* ── WHAT A KEY IS BOUND TO ────────────────────────────────────────────
   * The body alone is not the whole intent. `POST /costings/A/versions` and
   * `POST /costings/B/versions` with the same cost lines are byte-identical
   * bodies, so without the target the second replays the first's answer and B
   * is never costed — while the caller is told it was.
   *
   * The target is read from the URL, never from the body: a caller that could
   * name its own target could aim a key at any costing it liked.
   *
   * (Store & Purchase's own routes pass `target` only where they already did;
   * nothing about their fingerprints changes here.) */
  const targetKey = typeof target === "function" ? target(req) : undefined;

  try {
    const claim = await idempotency.begin({
      ctx: req.costing,
      operation,
      key,
      body: req.body,
      ...(targetKey === undefined ? {} : { target: targetKey }),
    });

    if (claim.outcome === "REPLAY") {
      res.set("Idempotency-Replayed", "true");
      return res.status(claim.response.status).json(claim.response.body);
    }

    /* ── A RECOVERED CLAIM IS NOT A SECOND CREATE ────────────────────────
     * The effect already committed on an earlier attempt whose response never
     * landed. The handler is still reached, but it is told so — and its first
     * act is to look the existing record up by the claim id below and return
     * it, rather than writing anything.
     *
     * It is NOT refused outright any more. Refusing was safe but unhelpful:
     * the caller's action HAD succeeded, and telling them to go and find it
     * themselves is worse than handing it back. The recovery is safe because
     * the claim id is on the costing itself and is uniquely indexed — the
     * handler cannot accidentally create a second one even if it tried. */
    const recovering = claim.outcome === "RECOVER";

    let settled = false;

    /* ── THE CLAIM IDENTITY, DERIVED ON THE SERVER ───────────────────────
     * The same four facts the idempotency record is keyed on, hashed into one
     * stable string that the created record carries and a unique index
     * defends. Deterministic on purpose: the SAME key from the same actor, in
     * the same company, on the same operation always yields the same claim —
     * which is what lets a retry find its own earlier record even if the
     * idempotency row itself has since expired or been released.
     *
     * ── AND THE TARGET IS DELIBERATELY *NOT* IN IT ─────────────────────────
     * Folding the target in here would make the same key aimed at costing B a
     * DIFFERENT claim, so once the bookkeeping row had expired the reuse would
     * quietly succeed and cost B under a key that already belongs to A. Left
     * out, the claim collides, and the handler — which knows what the claim
     * was spent on, because the target is stored beside it — answers 409.
     *
     * Nothing a client sends contributes to it except the key it is entitled
     * to choose; company and actor come from the resolved context. */
    const claimId = crypto
      .createHash("sha256")
      .update(JSON.stringify([
        String(req.costing.companyId), String(req.costing.actorId),
        operation, String(key).trim(),
      ]))
      .digest("hex");

    req.idempotent = {
      key,
      claimId,
      /* What this key was spent on, stored with the claim so a later reuse
         against a different record is recognisable after the bookkeeping row
         has gone. */
      claimTarget: targetKey === undefined || targetKey === null ? "" : String(targetKey),
      /* The canonical body fingerprint — TARGET INCLUDED, so "the same request
         again" and "this key, reused for something else" stay distinguishable
         long after the idempotency record's own retention has lapsed. */
      requestHash: idempotency.hashRequest(req.body, targetKey),
      recovering,
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
