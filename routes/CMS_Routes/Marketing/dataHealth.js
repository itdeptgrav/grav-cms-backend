// routes/CMS_Routes/Marketing/dataHealth.js
//   → mounted at /api/cms/marketing
//
// THE READ-ONLY OPERATOR VIEW OF MARKETING SYNCHRONISATION.
//
//   GET /data-health              summary counts, retry backlog, last success
//   GET /data-health/records      the actionable backlog, paginated
//   GET /data-health/person/:key  one person's delivery state
//
// ── EVERY ROUTE HERE IS A GET, AND THAT IS LOAD-BEARING ────────────────────
// The product plan asks for failures to be "visible and retryable from Data
// health", and it is tempting to put the retry button behind the same router.
// It is not here. Inspection that can mutate cannot be used by somebody merely
// trying to understand a problem: every look changes what is being looked at,
// and two operators investigating in parallel fight each other. Draining the
// backlog is `marketingDelivery.runDueRetries`, asked for by name, and a future
// slice can give it a POST of its own.
//
// ── THE COMPANY COMES FROM THE SESSION, NEVER FROM THE REQUEST ──────────────
// Resolved through the same `resolveCompanyForActor` the handover router uses.
// A `companyId` in a query string would be a company the caller chose, and this
// endpoint reports on every person a company has ever tried to market to —
// exactly the payload a cross-tenant read would want.
//
// ── WHAT IT WILL NOT SHOW ──────────────────────────────────────────────────
// No credentials, no raw provider response (none is stored), no consent
// evidence — capture source and notice version are a compliance record, not an
// operations one — and no Sales or customer data at all. Email addresses are
// masked: an operator needs to tell two rows apart and recognise a domain,
// which a mask gives them; an unmasked report is a contact export.
//
// ── AND NOT A SEPARATE ROUTER BY ACCIDENT ──────────────────────────────────
// This is its own file rather than more routes on `marketingHandovers.js`
// because that router is the handover contract, and its test asserts its exact
// route list so that adding a route there is a deliberate act. Two concerns,
// two files, one mount prefix.
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

const reconciliation = require("../../../services/marketing/marketingReconciliation.service");
const deliveryService = require("../../../services/marketing/marketingDelivery.service");
const MarketingIdentity = require("../../../models/CMS_Models/Marketing/MarketingIdentity");
const MarketingEventReceipt = require("../../../models/CMS_Models/Marketing/MarketingEventReceipt");
const AcquisitionHold = require("../../../models/CMS_Models/Marketing/MarketingAcquisitionHold");
const engagementProcessing = require("../../../services/marketing/engagementProcessing.service");
const acquisitionHold = require("../../../services/marketing/acquisitionHold.service");
const {
  DELIVERY_REASONS, DELIVERY_EFFECTIVE_HEALTH, ACQUISITION_HOLD_STATES,
} = require("../../../constants/marketing");

const str = (v) => String(v ?? "").trim();

/* Resolved from the actor's membership, once per request. Memoised on `req`
   under the same key the handover router uses, so a request that touches both
   resolves one company and cannot disagree with itself. */
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

router.use(express.json());
router.use(marketingAuth);

/**
 * GET /data-health
 *
 * The summary an operator opens first: how many people are in each state, how
 * big the retry backlog is, how much of it is due now, and when anything last
 * synchronised successfully.
 */
router.get("/data-health", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const now = new Date();

  const [report, backlog] = await Promise.all([
    reconciliation.reconcile({ companyId, limit: 500, now }),
    reconciliation.backlog({ companyId, now }),
  ]);

  /* ── ENGAGEMENT PROCESSING, ADDED ALONGSIDE ─────────────────────────────
     A separate top-level key rather than folded into `counts`. Lane B already
     renders `counts`, `retry` and `blocked`, and quietly changing what those
     mean would break a screen that is working; an additive key it does not read
     yet cannot. */
  const engagement = await engagementBacklog(companyId);

  /* ── WHAT SALES HAS BEEN PROMISED AND MAUTIC HAS NOT YET DONE ───────────
     Its own additive key, for the same reason `engagement` is one. `applied`
     counts the people acquisition has actually stopped for; `unfinished` counts
     the promises still outstanding. They are never added together — the whole
     point of this slice is that a request and a confirmation are different
     facts. */
  const acquisition = await acquisitionHold.healthSummary({ companyId, now });

  return res.json({
    success: true,
    generatedAt: now.toISOString(),
    /* Counts by category and by stable reason code. The reason codes are what a
       future screen groups by; the categories are what it lists under. */
    counts: report.counts,
    engagement,
    acquisition: {
      total: acquisition.total,
      applied: acquisition.applied,
      superseded: acquisition.superseded,
      unfinished: acquisition.unfinished,
      dueNow: acquisition.dueNow,
      /* null, never an epoch: "nothing is owed" and "something has been owed
         since the beginning of time" are different answers. */
      oldestUnfinishedAt: acquisition.oldestUnfinishedAt
        ? acquisition.oldestUnfinishedAt.toISOString() : null,
      byState: acquisition.byState,
    },
    /* The same rename applied to the counts, so the keys a client groups by
       match the vocabulary it was served. */
    reasonCounts: Object.fromEntries(
      Object.entries(report.reasonCounts || {})
        .map(([code, n]) => [providerPrivacy.publicReasonCode(code), n]),
    ),
    totals: report.totals,
    retry: {
      scheduled: backlog.scheduled,
      dueNow: backlog.dueNow,
      waiting: backlog.waiting,
      maxAttempts: backlog.maxAttempts,
    },
    blocked: {
      terminal: backlog.blockedTerminal,
      consent: backlog.blockedConsent,
    },
    /* null when nothing has ever synchronised — never an epoch and never a
       zero. "Never" and "a long time ago" are different facts. */
    lastSuccessfulSyncAt: backlog.lastSuccessfulSyncAt
      ? backlog.lastSuccessfulSyncAt.toISOString() : null,
    /* The vocabularies, served alongside the counts so a client never has to
       hard-code them to render a label. */
    vocabulary: {
      categories: providerPrivacy.publicVocabulary(reconciliation.CATEGORIES),
      actionable: reconciliation.ACTIONABLE,
      /* Renamed on the way out: four of these codes carry the provider's name,
         and a screen that learns them is a screen coupled to the provider. */
      reasons: providerPrivacy.publicVocabulary(DELIVERY_REASONS),
      health: providerPrivacy.publicVocabulary(DELIVERY_EFFECTIVE_HEALTH),
      acquisitionHold: providerPrivacy.publicVocabulary(ACQUISITION_HOLD_STATES),
    },
    /* Whether the summary walked everybody. A company with more people than one
       page says so rather than quietly reporting a partial count as the total. */
    complete: !report.page.hasMore,
  });
}));

/**
 * GET /data-health/records?category=RETRY_DUE&limit=50&cursor=…
 *
 * The actionable backlog. Cursor-paginated on the identity `_id`, so a page
 * boundary is stable while rows are changing underneath it — an offset would
 * skip or repeat people as the backlog drains.
 */
router.get("/data-health/records", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const now = new Date();

  const category = str(req.query.category) || null;
  if (category && !reconciliation.CATEGORIES.includes(category)) {
    throw fail("VALIDATION", `"${category}" is not a reconciliation category.`, {
      accepted: reconciliation.CATEGORIES,
    });
  }

  const report = await reconciliation.reconcile({
    companyId,
    category,
    limit: Math.min(Number(req.query.limit) || 50, 200),
    cursor: str(req.query.cursor) || null,
    now,
  });

  return res.json({
    success: true,
    generatedAt: now.toISOString(),
    category: category || "ALL",
    /* ── TRANSLATED ROW BY ROW, NOT TRUSTED FROM THE READ MODEL ───────────
       The reconciliation report is an internal shape and carries the internal
       reason codes and the upstream code the provider returned. Both name the
       product. `lastErrorSourceCode` is dropped rather than passed through when
       it has no GRAV equivalent: an unmapped upstream token is exactly the
       provider detail this boundary exists to keep server-side, and it is
       already in the logs for the operator who needs it. */
    records: (report.people || []).map((p) => ({
      ...p,
      reasonCode: providerPrivacy.publicReasonCode(p.reasonCode),
      lastErrorMessage: providerPrivacy.scrubText(p.lastErrorMessage) || null,
      lastErrorSourceCode: providerPrivacy.publicSourceCode(p.lastErrorSourceCode),
    })),
    page: report.page,
    counts: report.counts,
  });
}));

/**
 * GET /data-health/engagement?state=SUPPRESSION_FAILED&limit=50
 *
 * The inbound side of the backlog: observations whose processing did not
 * finish. Read-only like everything else here, and it exposes no payload —
 * the event kind, its time, what is owed and why.
 */
router.get("/data-health/engagement", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const state = str(req.query.state) || null;
  if (state && !MarketingEventReceipt.UNFINISHED_STATES.includes(state)) {
    throw fail("VALIDATION", `"${state}" is not an unfinished processing state.`, {
      accepted: MarketingEventReceipt.UNFINISHED_STATES,
    });
  }

  const rows = await MarketingEventReceipt.find({
    companyId,
    state: state ? state : { $in: MarketingEventReceipt.UNFINISHED_STATES },
  }).sort({ occurredAt: 1 }).limit(Math.min(Number(req.query.limit) || 50, 200)).lean();

  return res.json({
    success: true,
    generatedAt: new Date().toISOString(),
    state: state || "ALL_UNFINISHED",
    records: rows.map((r) => ({
      sourceEventId: r.sourceEventId,
      kind: r.kind,
      occurredAt: r.occurredAt,
      state: r.state,
      /* Present when resolved; empty when not. No address, masked or otherwise:
         an unresolved observation has no canonical person to mask. */
      gravPersonKey: r.gravPersonKey || null,
      resolvedBy: r.resolvedBy || null,
      suppression: {
        state: r.suppression?.state || "", attempts: r.suppression?.attempts || 0,
        error: r.suppression?.error ? providerPrivacy.scrubText(r.suppression.error) : null,
      },
      activity: {
        state: r.activity?.state || "", attempts: r.activity?.attempts || 0,
        error: r.activity?.error ? providerPrivacy.scrubText(r.activity.error) : null,
      },
    })),
    count: rows.length,
  });
}));

/**
 * GET /data-health/person/:gravPersonKey
 *
 * One person, for an operator who has a key from a report and wants the detail.
 * Company-scoped: a key from another company resolves to nothing, and says so
 * with the same answer a key that does not exist gets.
 */
router.get("/data-health/person/:gravPersonKey", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const gravPersonKey = str(req.params.gravPersonKey);

  /* The identity is checked first and within the company, so the endpoint
     cannot be used to probe whether a key exists elsewhere. */
  const identity = await MarketingIdentity
    .findOne({ companyId, gravPersonKey }).select("gravPersonKey email externals").lean();
  if (!identity) {
    throw fail("NOT_FOUND", "No marketing identity for that person in this company.");
  }

  const state = await deliveryService.stateFor({ companyId, gravPersonKey });

  /* Every acquisition hold raised for this person, newest first. Identity and
     state only — the handover reference is what an operator follows to the
     decision, and no Sales or customer detail crosses into this report. */
  const holds = await AcquisitionHold
    .find({ companyId, gravPersonKey }).sort({ requestedAt: -1 }).limit(20).lean();

  return res.json({
    success: true,
    person: {
      gravPersonKey,
      emailMasked: reconciliation.maskEmail(identity.email),
      /* The engine's own contact references, published under a GRAV name.
         Kept because an operator tracing a projection needs them; NOT labelled
         with the product, so no client learns which one it is. */
      engineContactRefs: (identity.externals || [])
        .filter((e) => e.system === "mautic").map((e) => str(e.externalId)),
    },
    delivery: {
      health: state.health,
      effectiveHealth: state.effectiveHealth,
      reasonCode: providerPrivacy.publicReasonCode(state.reasonCode),
      attempts: state.attempts,
      retryCount: state.retryCount || 0,
      engineContactRef: state.mauticContactId || null,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessfulSyncAt: state.lastSuccessfulSyncAt,
      nextAttemptAt: state.nextAttemptAt,
      inFlightSince: state.inFlightSince || null,
      /* Scrubbed: an active error's message came from whatever refused the
         write, and `sourceCode` is the provider's own vocabulary. */
      lastErrorMessage: state.row?.activeError?.message
        ? providerPrivacy.scrubText(state.row.activeError.message) : null,
    },
    /* `pausedAt` is present on exactly the holds Mautic confirmed. An operator
       reading this list can tell a promise from a fact without knowing the
       state vocabulary. */
    acquisitionHolds: holds.map((h) => {
      const effective = acquisitionHold.effectiveState(h);
      return {
        handoverRef: h.handoverRef,
        reason: h.reason,
        state: effective,
        storedState: h.state,
        label: acquisitionHold.SALES_FACING_LABEL[effective] || "",
        requestedAt: h.requestedAt,
        pausedAt: h.state === "APPLIED" ? h.confirmedAt : null,
        attempts: h.attempts || 0,
        lastAttemptAt: h.lastAttemptAt || null,
        nextAttemptAt: h.nextAttemptAt || null,
        failureReasonCode: providerPrivacy.publicReasonCode(h.activeError?.reasonCode),
        failureMessage: h.activeError?.message
          ? providerPrivacy.scrubText(h.activeError.message) : null,
        segmentsRemoved: h.evidence?.segmentsRemoved || [],
        campaignsRemoved: h.evidence?.campaignsRemoved || [],
        segmentsLeftAlone: h.evidence?.segmentsLeftAlone ?? null,
        campaignsLeftAlone: h.evidence?.campaignsLeftAlone ?? null,
        /* The scope as it was when the command ran, not as configuration reads
           today. */
        scopeUsed: {
          segments: (h.evidence?.scope?.segments || []).map((x) => x.id),
          campaigns: (h.evidence?.scope?.campaigns || []).map((x) => x.id),
          resolvedAt: h.evidence?.scope?.resolvedAt || null,
        },
        ...acquisitionHold.disclosure(h),
      };
    }),
  });
}));

/**
 * What inbound engagement processing still owes, as counts.
 *
 * Every unfinished state, by name. `null` is never used here because these are
 * counts of rows this company owns and a failed count would throw rather than
 * silently read zero.
 */
async function engagementBacklog(companyId) {
  const states = MarketingEventReceipt.UNFINISHED_STATES;
  const rows = await MarketingEventReceipt.aggregate([
    { $match: { companyId, state: { $in: states } } },
    { $group: { _id: "$state", n: { $sum: 1 } } },
  ]);
  const byState = Object.fromEntries(states.map((s) => [s, 0]));
  for (const r of rows) byState[r._id] = r.n;

  const [total, lastEvent, missingReceipts] = await Promise.all([
    MarketingEventReceipt.countDocuments({ companyId }),
    MarketingEventReceipt.findOne({ companyId }).sort({ occurredAt: -1 }).select("occurredAt").lean(),
    /* Observations nothing is tracking — recorded before their receipt could be
       written. Invisible to a receipt scan by definition, which is why it is
       counted from the ledger side. */
    engagementProcessing.countEventsMissingReceipts({ companyId }),
  ]);

  return {
    eventsProcessed: total,
    unfinished: byState,
    unfinishedTotal: states.reduce((n, s) => n + byState[s], 0),
    /* A bounded scan, and it says so. `missingReceiptsCapped: true` means "at
       least this many" — the previous bare number could not tell an operator
       whether 500 was the answer or the ceiling. */
    missingReceipts: missingReceipts.count,
    missingReceiptsCapped: missingReceipts.capped,
    /* Ordered by when the event HAPPENED, never by when it arrived. */
    lastEventOccurredAt: lastEvent?.occurredAt ? lastEvent.occurredAt.toISOString() : null,
  };
}

router.use((err, req, res, _next) => sendError(res, err));

module.exports = router;
