// routes/CMS_Routes/Marketing/leadSources.js
//   → mounted at /api/cms/marketing
//
// INDIAMART AS A LEAD SOURCE: IS IT CONNECTED, HOW FAR HAS GRAV READ, AND AN
// ADMINISTRATOR'S "CHECK NOW".
//
//   GET  /lead-sources/indiamart            any Marketing user; never calls IndiaMART
//   POST /lead-sources/indiamart/check      administrator or CEO; one bounded
//                                           call, then the routing pass
//   GET  /lead-sources/indiamart/routing    any Marketing user; where each
//                                           enquiry went and what Sales did
//   POST /lead-sources/indiamart/enquiries/:submissionRef/release   Editor and
//   POST /lead-sources/indiamart/enquiries/:submissionRef/dismiss   above; a
//                                           held enquiry only
//
// ── THE SCHEDULE IS THE NORMAL PATH ────────────────────────────────────────
// services/integration/indiamartScheduler.js pulls and routes every few
// minutes. Check now is an administrator's extra check.
//
// ── NOTHING MAY BE NAMED ───────────────────────────────────────────────────
// Neither route takes a parameter or a body field: not a company, a key, a
// time range or a record. The company is the caller's; the key is the
// server's; the window is computed from what GRAV already holds.
//
// ── WHAT NEVER LEAVES ──────────────────────────────────────────────────────
// The key, the request URL, IndiaMART's ids and messages, and any contact
// detail. Enquiries themselves are read through GET /enquiries.
"use strict";

const express = require("express");

const router = express.Router();

const marketingAuth = require("../../../Middlewear/MarketingAuthMiddlewear");
const membership = require("../../../services/companyContext/companyMembership.service");
const { fail } = require("../../../services/storePurchase/errors");
const providerPrivacy = require("../../../services/marketing/providerPrivacy");
const sync = require("../../../services/marketing/leads/indiamartSync.service");
const routingRead = require("../../../services/marketing/leads/indiamartRouting.read");
/* The integration layer: the one place allowed to reach Sales, through the
   existing Marketing handover. */
const scheduler = require("../../../services/integration/indiamartScheduler");
const routing = require("../../../services/integration/indiamartSalesRouting.service");

const handle = providerPrivacy.handleMarketing({ surface: "marketing" });
const str = (v) => String(v ?? "").trim();

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

/* The same gate every Marketing administrator action uses; the Marketing
   guard's ADMINISTER table enforces it first. */
const isAdministrator = (user) => Boolean(user?.isAdmin) || ["admin", "ceo"].includes(str(user?.role));

function refuseInputs(req) {
  const q = Object.keys(req.query || {});
  const b = req.body && typeof req.body === "object" ? Object.keys(req.body) : [];
  const named = [...q, ...b];
  if (named.length) {
    throw fail("VALIDATION",
      "IndiaMART lead-source routes take no parameters. The company, the key and the time range are GRAV's to decide.",
      { unknown: named });
  }
}

const vocab = () => ({ ...sync.vocabulary, ...routingRead.vocabulary });

/* Test seams: a transport so no test reaches IndiaMART, and a clock. */
const depsOf = (req) => ({
  transport: req.app?.locals?.marketingIndiamartTransport,
  now: req.app?.locals?.marketingIndiamartClock || Date.now,
});

router.use(express.json({ limit: "1kb" }));
router.use(marketingAuth);

/**
 * GET /lead-sources/indiamart
 *
 * Connection status, last check, coverage, the last error with what to do,
 * counts by kind, and whether Check now is available. Reads GRAV's own
 * records only.
 */
router.get("/lead-sources/indiamart", handle(async (req, res) => {
  refuseInputs(req);
  const companyId = await companyFor(req);
  const { now } = depsOf(req);
  const indiamart = await sync.status({ companyId, now, canAdminister: isAdministrator(req.user) });
  const salesRouting = await routingRead.summary({ companyId });
  return res.json({ success: true, indiamart, salesRouting, vocabulary: vocab() });
}));

/**
 * GET /lead-sources/indiamart/routing?state=&reason=&page=&limit=
 *
 * One page of routing rows, newest first: state, reason, handover reference,
 * delivery to Sales and Sales' decision. No contact detail.
 */
router.get("/lead-sources/indiamart/routing", handle(async (req, res) => {
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length) refuseInputs(req);
  const companyId = await companyFor(req);
  const view = await routingRead.list({ companyId, query: req.query || {} });
  return res.json({ success: true, ...view, vocabulary: vocab() });
}));

/* The body a review action may carry; the service checks it against the
   hold's own reason. */
const reviewBody = (req) => {
  const named = Object.keys(req.query || {});
  if (named.length) throw fail("VALIDATION", "Review actions take no query parameters.", { unknown: named });
  return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
};

router.post("/lead-sources/indiamart/enquiries/:submissionRef/release", handle(async (req, res) => {
  const body = reviewBody(req);
  const companyId = await companyFor(req);
  const { now } = depsOf(req);
  await routing.releaseHeld({ companyId, submissionRef: str(req.params.submissionRef), user: req.user, body, now });
  const row = await routingRead.forEnquiry({ companyId, submissionRef: str(req.params.submissionRef) });
  return res.json({ success: true, routing: row, vocabulary: vocab() });
}));

router.post("/lead-sources/indiamart/enquiries/:submissionRef/dismiss", handle(async (req, res) => {
  const body = reviewBody(req);
  const companyId = await companyFor(req);
  const { now } = depsOf(req);
  await routing.dismissHeld({ companyId, submissionRef: str(req.params.submissionRef), user: req.user, body, now });
  const row = await routingRead.forEnquiry({ companyId, submissionRef: str(req.params.submissionRef) });
  return res.json({ success: true, routing: row, vocabulary: vocab() });
}));

/**
 * POST /lead-sources/indiamart/check
 *
 * One call to IndiaMART for the next window. 200 with `check.outcome`
 * "completed" (success: true) or "failed" (success: false, `check.error`
 * says what to do); refusals are 409 not configured / already running and
 * 429 too soon.
 */
router.post("/lead-sources/indiamart/check", handle(async (req, res) => {
  if (!isAdministrator(req.user)) {
    throw fail("FORBIDDEN",
      "Checking IndiaMART is an administrator action. You can still see the connection status.");
  }
  refuseInputs(req);
  const companyId = await companyFor(req);
  const { transport, now } = depsOf(req);
  const { pull, routed } = await scheduler.cycleFor({
    companyId, now, startedBy: "manual", ...(transport ? { transport } : {}),
  });
  const check = pull.check;
  const indiamart = await sync.status({ companyId, now, canAdminister: true });
  const salesRouting = await routingRead.summary({ companyId });
  return res.json({
    success: check.outcome === "completed",
    check,
    routed,
    indiamart,
    salesRouting,
    vocabulary: vocab(),
  });
}));

module.exports = router;
module.exports.isAdministrator = isAdministrator;
