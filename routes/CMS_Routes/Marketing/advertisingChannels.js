// routes/CMS_Routes/Marketing/advertisingChannels.js
//   → mounted at /api/cms/marketing
//
// ADVERTISING CHANNELS: CONNECTION, CAMPAIGN INVENTORY AND PERFORMANCE.
//
//   GET /channels                               the state of every channel
//   GET /channels/:channel/accounts             which accounts the credential sees (administrator)
//   GET /campaigns?channel=…                    one page of one channel's campaigns
//   GET /campaigns/:campaignId/performance      one campaign, explicit date range
//   GET /analytics/campaign-performance         GA4 rows, explicit range
//
// ── EVERY ROUTE IS A GET, AND THAT IS THE ENTIRE CONTRACT ──────────────────
// This chunk reads. It creates, pauses, activates and deletes nothing, and that
// is enforced in three independent places rather than asserted once:
//
//   1. No POST, PUT, PATCH or DELETE is declared in this file.
//   2. The three adapters export named read operations only. None takes a URL,
//      method, path or query from a caller.
//   3. `channelHttp.assertReadOnly` refuses any verb but GET, and POST only
//      where the provider's own READ endpoint requires one and the adapter says
//      so at the call site.
//
// Campaign mutation arrives in the next chunk, as paused drafts, and will need a
// new route, a new adapter operation and a change to that assertion. Three
// deliberate acts rather than one forgotten one.
//
// ── THE COMPANY NEVER COMES FROM THE REQUEST ───────────────────────────────
// One deployment's advertising credentials belong to one GRAV company, exactly as
// the marketing engine's do. The company is resolved from the authenticated
// actor's membership and compared with the configured Marketing company; a second
// company is refused rather than shown a filtered view of somebody else's
// advertising account, because Google Ads holds no GRAV company on its campaigns
// and there is nothing to filter by. No `companyId` is read from a query string
// or a body anywhere in this file.
//
// ── WHY GOOGLE AND META ARE NAMED HERE AND THE ENGINE IS NOT ───────────────
// A marketer holds those accounts, pays those invoices and reconciles GRAV's
// figures against those dashboards. Hiding the name would make every number
// unverifiable and protect nothing. The engine behind the `email` channel is a
// different case — nobody chose it, nobody signs into it — and nothing in this
// file publishes its name, its variable names or its health detail.
"use strict";

const express = require("express");

const router = express.Router();

const marketingAuth = require("../../../Middlewear/MarketingAuthMiddlewear");
const membership = require("../../../services/companyContext/companyMembership.service");
const { fail } = require("../../../services/storePurchase/errors");
const providerPrivacy = require("../../../services/marketing/providerPrivacy");

/* The Marketing-safe error sender. A provider failure is logged honestly
   server-side and answered with a GRAV-owned code; a GRAV refusal passes through
   with the scrubber as a backstop. Importing the shared `sendError` here would
   put an upstream status and a provider name on the wire. */
const sendError = (res, err) => providerPrivacy.sendMarketingError(res, err);
const handle = providerPrivacy.handleMarketing({ surface: "marketing" });

const directory = require("../../../services/marketing/channels/channelDirectory.service");
const inventory = require("../../../services/marketing/channels/campaignInventory.service");
const performance = require("../../../services/marketing/channels/campaignPerformance.service");

const str = (v) => String(v ?? "").trim();

/* Resolved once per request under the same memo key the other Marketing routers
   use, so a request touching two of them resolves one company and cannot
   disagree with itself. */
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

/* ── WHO MAY SEE A CONNECTION DIAGNOSTIC ─────────────────────────────────────
   An ordinary marketer gets the business wording: connected, not connected,
   temporarily unavailable, access refused. An administrator additionally gets the
   GRAV failure code and the names of the missing environment variables, which is
   what makes a broken connection fixable.

   Neither ever gets a token, a variable's value, a provider URL or an upstream
   body. Those live in the server log, which a technical operator reads. */
const mayDiagnose = (user) => Boolean(user?.isAdmin) || ["admin", "ceo"].includes(str(user?.role));

router.use(express.json({ limit: "16kb" }));
router.use(marketingAuth);

/** Strip the admin-only block for everybody else. */
const publicChannel = (row, admin) => {
  const { diagnostics, account, ...rest } = row;
  if (!admin) return rest;
  return { ...rest, diagnostics, account };
};

/**
 * GET /channels
 *
 * Live by default: a `ready` here means GRAV read from the channel moments ago,
 * not that five environment variables are set. `?probe=false` answers from
 * configuration alone and reports `unknown` rather than claiming a readiness it
 * did not establish — useful for a page that wants to render immediately and
 * check afterwards.
 */
router.get("/channels", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const probe = str(req.query.probe) !== "false";
  const admin = mayDiagnose(req.user);

  const view = await directory.list({ companyId, probe });

  return res.json({
    success: true,
    channels: view.channels.map((c) => publicChannel(c, admin)),
    checkedAt: view.checkedAt,
    probed: view.probed,
    /* So a client can tell whether it is missing a block because it was not
       sent or because this reader may not see it. */
    diagnosticsVisible: admin,
    vocabulary: directory.vocabulary,
  });
}));

/**
 * GET /channels/:channel/accounts
 *
 * The one operation that returns advertising account identifiers, and it exists
 * for a single reason: an administrator confirming which account a credential
 * actually points at. An ordinary marketer never needs it, so they never get it —
 * an account id is an identifier for somebody else's property, and a list of them
 * is reconnaissance.
 */
router.get("/channels/:channel/accounts", handle(async (req, res) => {
  const companyId = await companyFor(req);
  if (!mayDiagnose(req.user)) {
    throw fail("FORBIDDEN",
      "Connection details are an administrator's to inspect. You can still see whether each channel is connected.");
  }

  const view = await directory.accessibleAccounts({
    companyId, channel: str(req.params.channel),
  });
  return res.json({ success: true, ...view });
}));

/**
 * GET /campaigns?channel=google_ads|meta_ads&status=…&startDate=…&endDate=…&cursor=…&limit=…
 *
 * `channel` is REQUIRED and has no default. Google and Meta page independently
 * with incomparable cursors and no shared ordering, so a merged list would have
 * an order that changes as either provider's data changes — and a paginated list
 * whose order is not stable repeats rows and skips others. The refusal says so.
 *
 * `rows` is `null` unless `readState` is `ok`. An empty array means the channel
 * answered and there is genuinely nothing there.
 */
router.get("/campaigns", handle(async (req, res) => {
  const companyId = await companyFor(req);

  const view = await inventory.list({
    companyId,
    /* Validated in the service, which refuses an unknown channel rather than
       answering it with an empty page. */
    channel: str(req.query.channel),
    status: str(req.query.status) || null,
    cursor: str(req.query.cursor) || null,
    limit: req.query.limit,
    startDate: str(req.query.startDate) || null,
    endDate: str(req.query.endDate) || null,
  });

  return res.json({
    success: true,
    channel: view.channel,
    channelLabel: view.channelLabel,
    /* The first thing a client must read. `rows: null` with a non-ok state is
       "GRAV could not look", which is not "you have no campaigns". */
    readState: view.readState,
    reasonCode: view.reasonCode,
    rows: view.rows,
    nextCursor: view.nextCursor,
    hasMore: view.hasMore,
    campaignCount: view.campaignCount,
    providerTotal: view.providerTotal,
    filteredLocally: view.filteredLocally,
    dateFilter: view.dateFilter,
    measuredAt: view.measuredAt,
    vocabulary: inventory.vocabulary,
  });
}));

/**
 * GET /campaigns/:campaignId/performance?startDate=…&endDate=…
 *
 * The range is REQUIRED. A server-chosen "last 28 days" resolves against the
 * channel's timezone at the moment of the call, so two identical requests minutes
 * apart can cover different days and a figure a marketer wrote down yesterday
 * cannot be reproduced.
 *
 * `campaignId` is the opaque identifier this API issued. A malformed, forged or
 * another company's identifier is refused by local arithmetic, before any
 * provider is contacted.
 */
router.get("/campaigns/:campaignId/performance", handle(async (req, res) => {
  const companyId = await companyFor(req);

  const view = await performance.read({
    companyId,
    campaignId: str(req.params.campaignId),
    startDate: str(req.query.startDate),
    endDate: str(req.query.endDate),
  });

  return res.json({ success: true, ...view, vocabulary: performance.vocabulary });
}));

/**
 * GET /analytics/campaign-performance?startDate=…&endDate=…&limit=…
 *
 * Website analytics, as its own report. Not joined to the advertising channels:
 * GA4 rows key on a campaign NAME a browser reported, two channels can carry the
 * same name, and a join on it would attribute one channel's sessions to the
 * other's campaign while looking correct on every screen.
 */
router.get("/analytics/campaign-performance", handle(async (req, res) => {
  const companyId = await companyFor(req);

  const view = await performance.analyticsReport({
    companyId,
    startDate: str(req.query.startDate),
    endDate: str(req.query.endDate),
    limit: inventory.assertLimit(req.query.limit),
  });

  return res.json({ success: true, ...view, vocabulary: performance.vocabulary });
}));

/* A malformed body is a refusal, not a crash. These are all GETs, but the JSON
   parser still runs and body-parser's errors are not `StorePurchaseError`s. */
const BODY_PARSER_TYPES = new Set([
  "entity.parse.failed", "entity.too.large", "encoding.unsupported", "request.aborted",
]);

router.use((err, req, res, next) => {
  if (BODY_PARSER_TYPES.has(err?.type)) {
    return sendError(res, fail("VALIDATION", "The request body could not be read.", { received: err.type }));
  }
  return sendError(res, err, next);
});

module.exports = router;
