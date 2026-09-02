// Middlewear/storePurchaseTenant.js
//
// Store & Purchase — Chunk 1. THE ONE PLACE TENANCY AND PERMISSION ARE APPLIED.
//
// Lives in `Middlewear/` (the misspelled directory the repo's auth middlewares
// already use — see CLAUDE.md) so it sits beside EmployeeAuthMiddlewear rather
// than starting a second convention.
//
// It runs AFTER EmployeeAuthMiddlewear and never replaces it: authentication
// stays exactly where it is, and this adds the two questions authentication
// never asked — whose company, and may they do this.
"use strict";

const tenantContext = require("../services/storePurchase/tenantContext.service");
const idempotency = require("../services/storePurchase/idempotency.service");
const { hasAll } = require("../services/storePurchase/capabilities");
const { fail, sendError } = require("../services/storePurchase/errors");

/**
 * Resolve tenant context onto `req.tenant`.
 *
 * Fails closed: a caller whose company cannot be proved gets a 403 and no
 * data, rather than an implicit "all companies" that would be worse than the
 * unscoped behaviour it replaces.
 */
function requireTenant(req, res, next) {
  /* The company a multi-company actor says they are working in. It selects
     WHICH of their memberships to use and is validated against them; it is
     never authority on its own, and a single-membership actor's value is
     ignored entirely. Read from a header so it cannot be confused with a
     record's own companyId in a body. */
  const requestedCompanyId =
    req.get("X-Store-Purchase-Company") || req.query?.actingCompanyId || null;

  tenantContext
    .resolveForActor(req.user, { requestedCompanyId })
    .then((ctx) => {
      /* Legacy mode is BOTH a capability and an explicit request. Either alone
         does nothing — that is the point: an ordinary list must never quietly
         include unowned records, and holding the capability must not change
         what an ordinary list returns. */
      const asked = String(req.query?.scope || "").toLowerCase() === "legacy";
      if (asked) {
        if (!hasAll(ctx.capabilitySet, tenantContext.CAPABILITIES.LEGACY_READ)) {
          return sendError(
            res,
            fail("LEGACY_ACCESS_REQUIRED", "You do not have access to legacy records."),
          );
        }
        ctx.legacyMode = true;
      }

      /* A site may be named per request, but only one the actor holds. */
      try {
        const requested = req.query?.siteId || req.body?.siteId;
        ctx.siteId = tenantContext.resolveSite(ctx, requested);
      } catch (err) {
        return sendError(res, err);
      }

      req.tenant = ctx;
      next();
    })
    .catch((err) => sendError(res, err));
}

/** Require one or more capabilities. Authentication alone grants nothing. */
const requireCapability = (...required) => (req, res, next) => {
  if (!req.tenant) {
    return sendError(res, fail("UNAUTHENTICATED", "Sign in to use Store & Purchase."));
  }
  if (!hasAll(req.tenant.capabilitySet, required)) {
    /* The message never names the internal key — that goes in `details` for
       the client to reason about, not in prose for a person to puzzle over. */
    return sendError(
      res,
      fail("FORBIDDEN", "You do not have permission to do that in Store & Purchase.", {
        required,
      }),
    );
  }
  next();
};

/** A write must never happen in legacy mode. */
function refuseLegacyWrite(req, res, next) {
  if (req.tenant?.legacyMode) {
    return sendError(
      res,
      fail("LEGACY_ACCESS_REQUIRED", "Legacy records are read-only.", { readOnly: true }),
    );
  }
  next();
}

/**
 * Idempotency wrapper for a mutating handler.
 *
 * The handler receives `req.idempotent.succeed(status, body, meta)` and must
 * call it instead of `res.json` for the success path, so the response that is
 * replayed is exactly the one the first caller got.
 */
const withIdempotency = (operation, { required = true } = {}) => async (req, res, next) => {
  const key = req.get("Idempotency-Key") || req.get("idempotency-key");

  if (!key && !required) return next();

  try {
    const claim = await idempotency.begin({
      ctx: req.tenant,
      operation,
      key,
      body: req.body,
    });

    if (claim.outcome === "REPLAY") {
      res.set("Idempotency-Replayed", "true");
      return res.status(claim.response.status).json(claim.response.body);
    }

    /* The domain mutation already landed on an earlier attempt that then
       failed. The handler must NOT re-run it — it finishes what is left and
       returns the existing effect. */
    const recovering = claim.outcome === "RECOVER" ? claim.effect : null;

    /* Whether the record has already been settled — completed by succeed(),
       or abandoned on a refusal. The response wrapper below settles anything
       the handler left open, so it must not settle it twice. */
    let settled = false;

    req.idempotent = {
      key,
      record: claim.record,
      recovering,
      succeed: async (status, body, meta = {}) => {
        /* ── COMPLETION FAILURE IS SURFACED, NOT SWALLOWED ──────────────────
         * If the record cannot be completed, the caller must not be told the
         * action is finished and replayable — it is neither. The failure is
         * logged with the operation and key, and then re-thrown so the route's
         * own error path answers.
         *
         * That is safe precisely because the mutation is already protected:
         * its effect marker was written inside the unit of work, so the retry
         * this provokes takes the recovery path and finishes the bookkeeping
         * instead of repeating the work. Swallowing it here would trade a
         * visible, self-healing failure for an invisible permanent one. */
        try {
          await idempotency.complete({ record: claim.record, status, body, ...meta });
        } catch (err) {
          console.error(
            `[storePurchase idempotency] complete failed for ${operation} key=${key}:`,
            err?.message || err,
          );
          throw err;
        }
        settled = true;
        if (recovering) res.set("Idempotency-Recovered", "true");
        return res.status(status).json(body);
      },
    };

    /* ── Releasing the claim on failure, BEFORE the client can retry ───────
     * A refused request must never become a replayable success, so the claim
     * has to be released. Doing that on the `finish` event is too late: the
     * response is already on the wire, and a client that retries immediately
     * races the release and is told the original is still IN_PROGRESS — which
     * is exactly what happened, and what the "a refused request does not
     * become a replayable success" test caught.
     *
     * So `res.json` is wrapped instead: on an error status the claim is
     * released and only then is the response written. By the time the caller
     * can act on the refusal, the key is already free.
     *
     * ── WHY SETTLEMENT FAILURE IS NOT SWALLOWED ────────────────────────────
     * Both calls below used to end in `.catch(() => {})`. That made a
     * settlement failure invisible: the caller got a clean answer while the
     * record stayed IN_PROGRESS, and nothing anywhere said so. Neither
     * failure is fatal to the response — it has already been decided — but
     * both are operationally significant, so they are logged with the
     * operation and key, and announced on the response so a client and a
     * proxy log can both see that the key did not settle. */
    const settlementFailed = (phase, err) => {
      console.error(
        `[storePurchase idempotency] ${phase} failed for ${operation} key=${key}:`,
        err?.message || err,
      );
      /* Headers may already be sent on some paths; never let reporting a
         problem become a second problem. */
      try { res.set("Idempotency-Settlement", `${phase}-failed`); } catch { /* headers sent */ }
    };

    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      if (settled) return originalJson(payload);
      settled = true;

      if (res.statusCode >= 400) {
        return idempotency
          .abandon({ record: claim.record, reason: `HTTP ${res.statusCode}` })
          .catch((err) => settlementFailed("abandon", err))
          .then(() => originalJson(payload));
      }

      /* ── A SUCCESS THE HANDLER NEVER CLAIMED ───────────────────────────────
       * A governed mutation settles its own record through `succeed()`, inside
       * the unit of work that also wrote the history — that is the only place
       * that knows the business effect is durable and what the replayable
       * answer should be.
       *
       * Reaching here means a success was written without that. The middleware
       * cannot tell from an arbitrary `res.json` whether an effect landed, so
       * it must not mark the record COMPLETED and promise future callers a
       * replay it cannot honour. It abandons instead: a retry then either
       * re-runs work that never happened, or — if an effect marker WAS
       * written — takes the recovery path, which never repeats it. Safe in
       * both directions, and loud, because it means a route is missing its
       * unit of work. */
      console.error(
        `[storePurchase idempotency] ${operation} answered ${res.statusCode} without ` +
        `completing its idempotency record. The action is not replayable; ` +
        `route it through unitOfWork/succeed().`,
      );
      return idempotency
        .abandon({ record: claim.record, reason: `UNCLAIMED_SUCCESS ${res.statusCode}` })
        .catch((err) => settlementFailed("abandon", err))
        .then(() => originalJson(payload));
    };

    next();
  } catch (err) {
    sendError(res, err);
  }
};

/**
 * Tenant context for a caller who arrived through the Cowork/Firebase door.
 *
 * That door knows a person by biometricId and nothing else — no ObjectId, no
 * email — so the employee is resolved from HR first and the context is built
 * from that authoritative record. The Firebase token proves who is calling;
 * the employee record says who they are here. Neither is asked which company
 * they belong to.
 *
 * @param {function} loadEmployee  async (req) => lean Employee | null
 */
const requireTenantForEmployee = (loadEmployee) => async (req, res, next) => {
  try {
    const employee = await loadEmployee(req);
    if (!employee) {
      return sendError(res, fail(
        "UNAUTHENTICATED",
        "Your staff record could not be found, so material requests cannot be routed.",
      ));
    }
    const requestedCompanyId =
      req.get("X-Store-Purchase-Company") || req.query?.actingCompanyId || null;

    const ctx = await tenantContext.resolveForEmployee(employee, { requestedCompanyId });
    /* Carried so the authority service can recognise this person on a request
       that only records badge numbers. */
    ctx.actorEmployeeId = employee.biometricId || employee.identityId || "";
    ctx.employee = employee;

    const asked = String(req.query?.scope || "").toLowerCase() === "legacy";
    if (asked) {
      if (!hasAll(ctx.capabilitySet, tenantContext.CAPABILITIES.LEGACY_READ)) {
        return sendError(res, fail("LEGACY_ACCESS_REQUIRED", "You do not have access to legacy records."));
      }
      ctx.legacyMode = true;
    }

    req.tenant = ctx;
    next();
  } catch (err) {
    sendError(res, err);
  }
};

module.exports = {
  requireTenant,
  requireTenantForEmployee,
  requireCapability,
  refuseLegacyWrite,
  withIdempotency,
  CAPABILITIES: tenantContext.CAPABILITIES,
};
