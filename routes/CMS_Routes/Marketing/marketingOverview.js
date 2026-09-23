// routes/CMS_Routes/Marketing/marketingOverview.js
//   → mounted at /api/cms/marketing
//
// WHAT THIS COMPANY'S MARKETING DID.
//
//   GET /overview?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// One read for the `/marketing` landing page. It contacts nobody, writes
// nothing and changes nothing: the whole response is assembled from records
// GRAV already holds, so opening the page is free and repeatable.
//
// ── A GET THAT IS ACTUALLY A GET ───────────────────────────────────────────
// No refresh, no sync, no retry, no creation, no activation, no model call.
// The router imports one service, and that service imports no provider client,
// no HTTP client, no deployment writer, no AI client and no Mautic client. A
// test in the suite walks those imports rather than trusting this comment.
//
// ── AND IT SPEAKS TO A MARKETER ────────────────────────────────────────────
// Nothing in this response mentions synchronisation, reconciliation, mapping,
// queues, engines, credentials, providers, retries or database rows. Not
// because any of it is secret — because none of it is something the person
// opening this page can do anything about, and each one invites a support
// ticket about a system that is working.
"use strict";

const express = require("express");

const router = express.Router();

const marketingAuth = require("../../../Middlewear/MarketingAuthMiddlewear");
const membership = require("../../../services/companyContext/companyMembership.service");
const { fail } = require("../../../services/storePurchase/errors");
const providerPrivacy = require("../../../services/marketing/providerPrivacy");

const sendError = (res, err) => providerPrivacy.sendMarketingError(res, err);
const handle = providerPrivacy.handleMarketing({ surface: "marketing" });

const overviewService = require("../../../services/marketing/overview/marketingOverview.service");

const str = (v) => String(v ?? "").trim();

/* ── COMPANY SCOPE ──────────────────────────────────────────────────────────
   Resolved from the actor's membership, once per request, and never taken from
   the query or the body — a company a caller names is a company the caller
   chose. */
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

router.use(marketingAuth);

/* The query is an allow-list, like every Marketing body. An unknown parameter
   is refused by name rather than ignored, because a caller who sends
   `?companyId=` and gets a 200 will believe it did something. */
const QUERY_FIELDS = ["from", "to"];

function onlyQuery(query) {
  const unknown = Object.keys(query || {}).filter((k) => !QUERY_FIELDS.includes(k));
  if (unknown.length) {
    throw fail("VALIDATION",
      `The overview accepts ${QUERY_FIELDS.join(" and ")}. ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not part of it.`,
      { unknown });
  }
  return query || {};
}

/**
 * GET /overview
 *
 * Readable by anybody who may use Marketing. There is no elevated role: this
 * spends nothing, contacts nothing and exposes nothing an ordinary Marketing
 * user may not already see on the pages it summarises.
 */
router.get("/overview", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const query = onlyQuery(req.query);

  const data = await overviewService.overview({
    companyId,
    from: str(query.from),
    to: str(query.to),
  });

  return res.json({
    success: true,
    /* Field by field rather than a spread: a spread would publish whatever a
       future internal field turns out to be, the day somebody adds one. */
    range: data.range,
    performance: data.performance,
    dailyTrend: data.dailyTrend,
    campaigns: data.campaigns,
    prospectMovement: data.prospectMovement,
    handoverSummary: data.handoverSummary,
    attention: data.attention,
    availability: data.availability,
    approvedNotDeployed: data.approvedNotDeployed,
    freshness: data.freshness,
    means: data.means,
    /* Stated on every response: reading this page did nothing. */
    readOnly: true,
  });
}));

router.use((err, req, res, _next) => sendError(res, err));

module.exports = router;
