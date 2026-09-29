// routes/CMS_Routes/Marketing/campaignPerformance.js
//   → mounted at /api/cms/marketing
//
// WHAT A CAMPAIGN PLAN ACTUALLY DID.
//
//   GET  /campaign-drafts/:id/performance          the figures GRAV already has
//   POST /campaign-drafts/:id/performance/refresh  go and read the channels again
//
// ── READING A REPORT CONTACTS NOBODY ───────────────────────────────────────
// The GET assembles observations already stored, so opening a screen is free,
// repeatable, and unaffected by whether an advertising channel happens to be
// answering. Refreshing is a separate, deliberate act with its own route and
// its own authorisation — which is also what stops a dashboard on a five-second
// poll from hammering a rate-limited API.
//
// ── AND REFRESHING READS OUTWARD, WRITES INWARD ────────────────────────────
// The refresh route updates GRAV's own reporting records and changes nothing in
// any advertising account. It cannot: the sync service imports only the read
// clients, and every call it makes goes through the gate that refuses any verb
// but GET.
//
// ── WHAT NEVER REACHES THE BROWSER ─────────────────────────────────────────
// Credentials, advertising account identifiers, external campaign identifiers,
// database ids, provider error text, and the internal stages of a
// reconciliation. A reader is told which CHANNEL, what the figures are, how
// settled they are and how fresh — which is everything needed to render and
// nothing that names somebody's advertising account.
"use strict";

const express = require("express");

const router = express.Router();

const marketingAuth = require("../../../Middlewear/MarketingAuthMiddlewear");
const membership = require("../../../services/companyContext/companyMembership.service");
const { fail } = require("../../../services/storePurchase/errors");
const providerPrivacy = require("../../../services/marketing/providerPrivacy");

const sendError = (res, err) => providerPrivacy.sendMarketingError(res, err);
const handle = providerPrivacy.handleMarketing({ surface: "marketing" });

const drafts = require("../../../services/marketing/campaignDrafts/campaignDraft.service");
const reportService = require("../../../services/marketing/performance/campaignReport.service");
const pacingService = require("../../../services/marketing/performance/budgetPacing.service");
const syncService = require("../../../services/marketing/performance/observationSync.service");
const { RANGE } = require("../../../constants/marketingPerformance");

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

/* ── WHO MAY ASK A CHANNEL FOR FRESH FIGURES ────────────────────────────────
   Reading a stored report is ordinary Marketing work. Refreshing makes real
   requests against a rate-limited advertising API on the company's credentials,
   so it follows the same authority as the other operational Marketing actions:
   an administrator or the CEO.

   Not because the data is sensitive — a marketer may read all of it — but
   because the ACTION has a cost and a rate limit, and an unauthenticated
   refresh button on a dashboard is how an account gets throttled. */
const isAdministrator = (user) => Boolean(user?.isAdmin) || ["admin", "ceo"].includes(str(user?.role));

router.use(express.json({ limit: "16kb" }));
router.use(marketingAuth);

/* The plan, resolved through the same reconciled, company-scoped loader every
   other Marketing route uses. The signed public identifier carries a company
   that must match; the selector carries it too. */
const planFor = (companyId, campaignDraftId) => drafts.loadForDeployment({
  companyId, campaignDraftId: str(campaignDraftId),
});

/**
 * GET /campaign-drafts/:campaignDraftId/performance?startDate=…&endDate=…
 *
 * ── THE RANGE IS THE CALLER'S, AND BOUNDED ─────────────────────────────────
 * Defaults to the last 30 days ending today. A caller may ask for any window up
 * to the documented maximum; beyond that it is refused rather than silently
 * truncated, because a report labelled with a range it does not cover is worse
 * than no report.
 */
router.get("/campaign-drafts/:campaignDraftId/performance", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const plan = await planFor(companyId, req.params.campaignDraftId);

  const view = await reportService.report({
    companyId,
    campaignDraftId: plan._id,
    draftRef: plan.draftRef,
    startDate: str(req.query.startDate) || null,
    endDate: str(req.query.endDate) || null,
  });

  return res.json({
    success: true,
    /* Built field by field. A spread would publish whatever a future internal
       field turns out to be the day somebody adds one. */
    campaignPlan: view.campaignPlan,
    range: view.range,
    deployments: view.deployments,
    combined: view.combined,
    freshness: view.freshness,
    vocabulary: view.vocabulary,
    means: view.means,
    /* Stated, because somebody will eventually ask where the raw responses are:
       GRAV has no approved encrypted diagnostic store, so it does not keep
       them. */
    rawResponsesStored: view.rawResponsesStored,
    /* Neither is possible from this slice, and saying so stops a reader
       inferring a capability from a reporting screen. */
    canChangeCampaign: false,
    canActivateCampaign: false,
  });
}));

/**
 * GET /campaign-drafts/:campaignDraftId/pacing
 *
 * Whether each of the plan's campaigns is spending its approved budget at the
 * rate the approved schedule implies — or the specific reason GRAV will not
 * say. Read-only: it reads GRAV's stored results, contacts no advertising
 * channel, and changes no campaign or budget. Takes no parameters; the window
 * is the plan's own schedule.
 */
router.get("/campaign-drafts/:campaignDraftId/pacing", handle(async (req, res) => {
  const named = Object.keys(req.query || {});
  if (named.length) {
    throw fail("VALIDATION", "Pacing takes no parameters: it always covers the plan's approved schedule.", { unknown: named });
  }
  const companyId = await companyFor(req);
  const plan = await planFor(companyId, req.params.campaignDraftId);
  const view = await pacingService.pacing({ companyId, plan });

  return res.json({
    success: true,
    /* Built field by field, as the report is. */
    campaignPlan: view.campaignPlan,
    budget: view.budget,
    schedule: view.schedule,
    pacing: view.pacing,
    deployments: view.deployments,
    calculation: view.calculation,
    vocabulary: view.vocabulary,
    means: view.means,
    readsAdvertisingChannels: view.readsAdvertisingChannels,
    canChangeBudget: view.canChangeBudget,
    canChangeCampaign: view.canChangeCampaign,
  });
}));

/**
 * POST /campaign-drafts/:campaignDraftId/performance/refresh
 *
 * Body: `{ startDate?, endDate? }` — nothing else.
 *
 * ── READS OUTWARD. WRITES ONLY GRAV. ───────────────────────────────────────
 * It asks each of this plan's deployments' advertising accounts what happened,
 * and writes the answers into GRAV's own observation records. It creates,
 * changes, pauses and starts nothing in any advertising channel.
 *
 * One channel failing does not stop the other being read, and a failed read
 * never overwrites a figure that was true — the day keeps the figures it had
 * and the response says the read failed.
 */
router.post("/campaign-drafts/:campaignDraftId/performance/refresh", handle(async (req, res) => {
  const companyId = await companyFor(req);

  if (!isAdministrator(req.user)) {
    throw fail("FORBIDDEN",
      "Asking an advertising channel for fresh figures is an administrator's action. You can still read the figures GRAV already has.");
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter((k) => !["startDate", "endDate"].includes(k));
  if (unknown.length) {
    throw fail("VALIDATION",
      `A refresh accepts startDate and endDate. ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not part of it.`,
      { unknown });
  }

  const plan = await planFor(companyId, req.params.campaignDraftId);

  /* ── THE DEFAULT WINDOW IS SHORT ON PURPOSE ────────────────────────────
     A refresh re-reads a window from a rate-limited API. The recent days are
     the ones that change — a channel reconciles spend and late conversions
     arrive — and a month-long refresh on every button press is how an account
     gets throttled. A caller wanting more says so. */
  const today = new Date().toISOString().slice(0, 10);
  const endDate = str(body.endDate) || today;
  const startDate = str(body.startDate)
    || new Date(Date.parse(`${endDate}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);

  const out = await syncService.syncPlan({
    companyId, campaignDraftId: plan._id, startDate, endDate,
  });

  return res.json({
    success: true,
    range: { startDate, endDate },
    /* Per deployment, in GRAV's own vocabulary. No account identifier, no
       external campaign id, no provider message — `read` is GRAV's own code for
       what happened. */
    refreshed: (out.synced || []).map((s) => ({
      channel: s.channel,
      read: s.read,
      daysWritten: s.daysWritten ?? 0,
      daysChanged: s.daysChanged ?? 0,
      observedAt: s.observedAt || null,
    })),
    means: out.means
      || "GRAV asked each advertising channel what happened and wrote the answers down. It changed nothing in any advertising account.",
    changedAnythingExternally: false,
    maximumRangeDays: RANGE.MAX_DAYS,
  });
}));

const BODY_PARSER_TYPES = new Set(["entity.parse.failed", "entity.too.large"]);

router.use((err, req, res, next) => {
  if (!err || !BODY_PARSER_TYPES.has(err.type)) return next(err);
  return sendError(res, fail("VALIDATION",
    err.type === "entity.too.large"
      ? "That request was too large."
      : "That request body could not be read as JSON."));
});

module.exports = router;
