// routes/CMS_Routes/Marketing/trackingIntegrations.js
//   → mounted at /api/cms/marketing
//
// WEBSITE TRACKING CONFIGURATION, FOR THE COMPANY'S PUBLIC SITE.
//
//   GET  /integrations/tracking          the current configuration
//   PUT  /integrations/tracking          replace it (administrator or CEO)
//   GET  /integrations/tracking/history  who changed it, and to what
//
// ── NOTHING HERE LOADS A TAG ───────────────────────────────────────────────
// GRAV is the internal employee application. No container, measurement tag or
// pixel is ever installed in it, and none of these routes emits a script or a
// snippet. They store identifiers that a separate public website will later be
// told about, and the read serves those identifiers as data.
//
// ── AND NOTHING HERE TALKS TO GOOGLE OR META ───────────────────────────────
// No provider client is imported. A saved identifier is a statement of intent,
// and the verification state says exactly that until a later slice actually
// looks at the website.
//
// ── ITS OWN FILE, ON THE SAME MOUNT ────────────────────────────────────────
// `marketingHandovers.js` is the handover contract and its test asserts that
// router's exact route list, so adding routes there stays a deliberate act.
// This is a different concern with a different permission rule, so it is a
// different router behind the same prefix — the same arrangement `dataHealth.js`
// already uses.
"use strict";

const express = require("express");

const router = express.Router();

const marketingAuth = require("../../../Middlewear/MarketingAuthMiddlewear");
const membership = require("../../../services/companyContext/companyMembership.service");
const { fail } = require("../../../services/storePurchase/errors");
const providerPrivacy = require("../../../services/marketing/providerPrivacy");

/* ── EVERY REFUSAL LEAVES THROUGH THE PRIVACY BOUNDARY ──────────────────────
   `handle` and `sendError` here are the Marketing-safe versions, not the shared
   ones. A provider failure is logged honestly server-side and answered with a
   GRAV-owned code and sentence; a GRAV refusal passes through with the scrubber
   as a backstop. Importing the shared `sendError` into a Marketing route would
   put the engine's name and its upstream status on the wire. */
const sendError = (res, err) => providerPrivacy.sendMarketingError(res, err);
const handle = providerPrivacy.handleMarketing({ surface: "marketing" });
const trackingConfig = require("../../../services/marketing/trackingConfig.service");
const { TRACKING_MODES, TRACKING_VERIFICATION_STATES } = require("../../../constants/marketing");

const str = (v) => String(v ?? "").trim();

/* Resolved from the actor's membership, once per request, under the same key
   the other Marketing routers use so a request touching two of them resolves
   one company and cannot disagree with itself. */
async function companyFor(req) {
  if (req.__marketingCompanyId) return req.__marketingCompanyId;
  const { companyId } = await membership.resolveCompanyForActor(req.user, {
    requestedCompanyId: null,
    domainLabel: "Marketing",
    fail,
  });
  req.__marketingCompanyId = companyId;
  return companyId;
}

const actorOf = (req) => ({
  id: req.user?.id, name: str(req.user?.name), email: str(req.user?.email),
});

/* ── WHO MAY CHANGE COMPANY-WIDE TRACKING ───────────────────────────────────
   Reading is for any Marketing user: knowing whether measurement is configured
   is ordinary operational awareness, and a marketer who cannot see it will ask
   somebody to read it out.

   Changing it is not. These identifiers end up in the page source of the public
   website, so a wrong value silently stops measurement or sends a company's
   traffic to somebody else's property. That is an administrator's decision, and
   the check mirrors the one the acquisition-hold retry endpoint already uses —
   `MarketingAuthMiddlewear.withRoles` only ever WIDENS an allowlist, so a
   narrower gate belongs here rather than in the middleware. */
const mayConfigure = (user) => Boolean(user?.isAdmin) || ["admin", "ceo"].includes(str(user?.role));

function assertMayConfigure(req) {
  if (!mayConfigure(req.user)) {
    throw fail("FORBIDDEN",
      "Website tracking is a company-wide setting, so changing it needs an administrator. You can still view it.");
  }
}

router.use(express.json({ limit: "64kb" }));
router.use(marketingAuth);

/**
 * GET /integrations/tracking
 *
 * Public identifiers, the mode, whether it is enabled, the revision to send
 * back on a write, and what is actually known about installation.
 *
 * Deliberately never the word "connected". A non-empty identifier means somebody
 * typed one, and this slice has no way to know whether the website carries it —
 * `verification.state` is `saved_unverified` and the message says so in words.
 */
router.get("/integrations/tracking", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const config = await trackingConfig.get({ companyId });

  return res.json({
    success: true,
    config,
    /* Whether THIS caller may change it, so a client can render a read-only
       view rather than offering a save that will be refused. */
    canConfigure: mayConfigure(req.user),
    /* The vocabularies, served with the value so a client never hard-codes
       them. */
    vocabulary: { modes: TRACKING_MODES, verificationStates: TRACKING_VERIFICATION_STATES },
  });
}));

/**
 * PUT /integrations/tracking
 *
 * Replace the configuration. Administrator or CEO only, company from the
 * session, and `expectedRevision` required so two administrators cannot
 * silently overwrite each other.
 *
 * Unknown fields, secret-like fields and anything that would store executable
 * content are refused by name rather than dropped — see the service.
 */
router.put("/integrations/tracking", handle(async (req, res) => {
  const companyId = await companyFor(req);
  assertMayConfigure(req);

  const result = await trackingConfig.save({
    companyId,
    payload: req.body || {},
    actor: actorOf(req),
  });

  return res.json({
    success: true,
    config: result.config,
    revision: result.revision,
    previousRevision: result.previousRevision,
    /* False when the submitted configuration matched the stored one. No
       revision was consumed and no history row was appended — a re-submitted
       form is not a decision. */
    changed: result.changed,
    noop: Boolean(result.noop),
    /* True when the current-record write failed and the automatic repair
       finished the job. Disclosed rather than hidden: the write took a path
       worth knowing about. */
    recovered: Boolean(result.recovered),
    canConfigure: true,
  });
}));

/**
 * GET /integrations/tracking/history
 *
 * Append-only, company-scoped, bounded and cursor-paginated. Every row shows the
 * safe configuration before and after, and who made the change.
 */
router.get("/integrations/tracking/history", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const view = await trackingConfig.history({
    companyId,
    cursor: str(req.query.cursor) || null,
    limit: req.query.limit,
  });

  return res.json({
    success: true,
    rows: view.rows,
    nextCursor: view.nextCursor,
    hasMore: view.hasMore,
    page: view.page,
  });
}));

/* ── A MALFORMED BODY IS A REFUSAL, NOT A CRASH ─────────────────────────────
   `express.json()` runs in strict mode, so a body that is not an object or an
   array never reaches a handler: body-parser raises before the route does. Those
   errors are not `StorePurchaseError`s, so the shared handler would have called
   them internal and answered 500 with "Nothing was changed" — a status that
   invites a retry of a request that can never succeed, and a sentence that is
   only accidentally true.

   Translated here into the 400 they are. `err.type` is body-parser's own
   classification; the raw message is not carried outward. */
const BODY_PARSER_TYPES = new Set([
  "entity.parse.failed", "entity.too.large", "encoding.unsupported", "request.aborted",
]);

router.use((err, req, res, next) => {
  if (BODY_PARSER_TYPES.has(err?.type)) {
    return sendError(res, fail("VALIDATION",
      err.type === "entity.too.large"
        ? "That request body is too large for a tracking configuration."
        : "The request body must be a JSON object describing a tracking configuration.",
      { received: err.type }));
  }
  return sendError(res, err, next);
});

module.exports = router;
module.exports.mayConfigure = mayConfigure;
