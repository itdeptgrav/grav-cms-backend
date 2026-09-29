// routes/CMS_Routes/Marketing/marketingHandovers.js
//   → mounted at /api/cms/marketing
//
// THE MARKETING APPLICATION'S OWN API. It writes no Sales record.
//
//   POST /events                  Mautic's signed webhook. No session — the
//                                 signature is the authentication. Accepts
//                                 Mautic's own grouped envelope and GRAV's
//                                 normalised shape; see
//                                 services/marketing/mauticWebhookContract.js.
//   GET  /health                  Mautic configuration, reachability, auth,
//                                 API and (inferred) database state.
//   POST /handovers/preview       what Sales WOULD be sent, and why. Reads
//                                 only; nothing is submitted.
//   POST /handovers               submit a handover. Idempotent.
//   GET  /handovers               the Marketing-side list.
//   GET  /handovers/:handoverRef  one handover, with its audit trail.
//
// ── WHAT IS DELIBERATELY ABSENT ────────────────────────────────────────────
// There is no route here that accepts, approves, assigns, qualifies or
// converts anything, and no route that writes a Lead. Marketing's whole
// authority over a Prospect ends at "submitted".
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

const eventIntake = require("../../../services/marketing/mauticEventIntake.service");
const webhookContract = require("../../../services/marketing/mauticWebhookContract");
const engagement = require("../../../services/marketing/engagementProcessing.service");
const { MarketingIntentEvent } = require("../../../models/CMS_Models/Marketing/MarketingEvent");
const mauticHealth = require("../../../services/marketing/mauticHealth.service");
const handovers = require("../../../services/marketing/prospectHandover.service");
const delivery = require("../../../services/integration/marketingProspectDelivery.service");
const Handover = require("../../../models/CMS_Models/Marketing/ProspectHandover");
const acquisitionHold = require("../../../services/marketing/acquisitionHold.service");
const readModel = require("../../../services/marketing/handoverReadModel.service");
const { MarketingAuditEvent } = require("../../../models/CMS_Models/Marketing/MarketingEvent");

const str = (v) => String(v ?? "").trim();

/* ── COMPANY SCOPE ──────────────────────────────────────────────────────────
   Resolved from the actor's membership, once per request, and never taken from
   the request body — a company in a payload is a company the caller chose. The
   shared resolver is used rather than a Marketing copy so both applications
   agree on what an actor's company is. */
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

const actorOf = (req) => ({ id: req.user?.id, name: req.user?.name || "", email: req.user?.email || "" });

/* ═══ THE WEBHOOK ══════════════════════════════════════════════════════════ */

/* ── RATE LIMITING ──────────────────────────────────────────────────────────
   A webhook endpoint is reachable by anyone who can find the URL. The
   signature check is what stops a forged event being believed; this is what
   stops an unsigned flood from costing anything to reject. Per-IP, in memory,
   swept on use — the same shape routes/auth/faceSignin.js already uses, and
   for the same reason: one process, no shared store to introduce. */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = Number(process.env.MAUTIC_WEBHOOK_MAX_PER_MINUTE || 300);
const buckets = new Map();

function rateLimit(key, now) {
  for (const [k, b] of buckets) if (now - b.windowStart > WINDOW_MS * 5) buckets.delete(k);
  let b = buckets.get(key);
  if (!b || now - b.windowStart > WINDOW_MS) {
    b = { windowStart: now, count: 0 };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count <= MAX_PER_WINDOW;
}

/* ── THE RAW BODY, WHICHEVER WAY THIS ROUTER IS MOUNTED ─────────────────────
   A signature is over the exact bytes Mautic signed. Re-serialising a parsed
   object produces different bytes and a signature that never matches — which
   is how this check usually ends up "fixed" by being switched off.

   There are two mountings to survive, and only handling one of them is the
   bug this comment exists to prevent:

     · inside server.js, where a global `express.json({ verify })` has ALREADY
       consumed the stream and stashed the bytes on `req.rawBody`. A second
       body parser here is a no-op — body-parser skips a request it has
       already parsed — so `req.body` would be a parsed object and any
       Buffer-shaped code would silently receive "[object Object]";
     · mounted on its own (a test, or a future standalone marketing process),
       where nothing has read the stream and this parser is the only one.

   So the parser runs for the second case and `rawBodyOf` prefers whatever
   actually holds the bytes. `whatsappWebhook.js` reads `req.rawBody` for the
   same reason. */
/* 1 MB. A Mautic open event is ~8 KB of contact-field descriptors and a batch
   is a handful of those, so the cap is generous for anything genuine and small
   enough that an unsigned flood cannot cost memory before it is rejected. A body
   over the cap is refused by body-parser BEFORE any of this runs. */
const rawJson = express.raw({ type: "*/*", limit: "1mb" });

/** The bytes as received, from either mounting. */
function rawBodyOf(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === "string") return Buffer.from(req.rawBody, "utf8");
  return null;
}

router.post("/events", rawJson, async (req, res) => {
  const now = Date.now();
  const key = str(req.ip || req.socket?.remoteAddress) || "unknown";
  if (!rateLimit(key, now)) {
    return res.status(429).json({ success: false, message: "Too many webhook requests." });
  }

  const raw = rawBodyOf(req);
  if (!raw) {
    /* No bytes to verify. Refused rather than falling back to the parsed
       object: a signature check that cannot see what was signed is not a
       signature check, and accepting the request anyway would make the
       endpoint open exactly where it looks guarded. */
    console.error("[marketing] webhook received with no raw body available; signature cannot be verified.");
    return res.status(400).json({ success: false, message: "The webhook body could not be read." });
  }

  /* Whichever header carried it. Real Mautic uses `Webhook-Signature` with a
     base64 digest; GRAV's own synthetic sender uses `x-mautic-signature` with
     hex. Both are checked against the same HMAC over the same raw bytes, so
     accepting two spellings widens the format and not the trust. */
  const { value: signature, header: signatureHeader } = webhookContract.signatureFrom({
    get: (name) => req.get(name),
  });
  const check = webhookContract.verifySignature(raw, signature);
  if (!check.ok) {
    /* The reason is logged, not returned. Telling an unauthenticated caller
       whether a secret is configured tells them how to proceed. */
    console.warn(`[marketing] webhook rejected (${signatureHeader || "no signature header"}):`, check.reason);
    return res.status(401).json({ success: false, message: "Signature verification failed." });
  }

  let payload;
  try {
    /* Reuse the global parser's result when there is one — it parsed the same
       bytes this signature was just verified against. */
    payload = (req.body && !Buffer.isBuffer(req.body) && typeof req.body === "object")
      ? req.body
      : JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ success: false, message: "The webhook body was not valid JSON." });
  }

  /* THE COMPANY IS NOT IN THE PAYLOAD. This deployment runs one Mautic
     instance for one GRAV organisation (ADR-004), and the company it belongs
     to is deployment configuration, not something a webhook sender may
     assert. */
  const companyId = str(process.env.MARKETING_COMPANY_ID);
  if (!companyId) {
    console.error("[marketing] MARKETING_COMPANY_ID is not configured; webhook events cannot be recorded.");
    return res.status(503).json({ success: false, message: "Marketing intake is not configured." });
  }

  /* ── TWO BODY SHAPES, TOLD APART BY THE PAYLOAD ITSELF ─────────────────
     Real Mautic posts `{ "mautic.form_on_submit": [ … ], … }` — many events
     per request, grouped by type, with no event id of its own. GRAV's own
     synthetic sender posts the already-normalised shape. A top-level key
     beginning "mautic." is unambiguous, and sniffing it here means one
     endpoint serves both without a second URL to keep in step. */
  const looksLikeMautic = Object.keys(payload || {}).some((k) => k.startsWith("mautic."));

  const results = { recorded: 0, duplicates: 0, rejected: [], ignored: [], needsAttention: [] };
  let incoming;

  if (looksLikeMautic) {
    const translated = webhookContract.translate(payload, {
      campaignId: str(req.query.campaignId),
      campaignName: str(req.query.campaignName),
    });
    incoming = translated.events;
    results.ignored = translated.ignored;
    results.rejected.push(...translated.rejected);
  } else {
    incoming = Array.isArray(payload?.events) ? payload.events : [payload];
  }

  /* ── WHAT A 200 MEANS, AND WHAT IT MUST NOT ────────────────────────────
     Answering 200 tells Mautic the delivery is settled and it stops retrying.
     That is right for a problem retrying cannot fix — content this application
     cannot read, a type it does not model — and it is WRONG for a database that
     was briefly unavailable, because the event is then lost for good.

     This loop originally caught everything into `rejected` and always answered
     200, so a transient Mongo failure permanently discarded a genuine
     unsubscribe. Terminal content problems are still listed and acknowledged;
     anything that is not durably recoverable now sets `infrastructureFailure`
     and the request answers 5xx so Mautic delivers it again. */
  let infrastructureFailure = null;

  for (const event of incoming) {
    if (infrastructureFailure) break;
    try {
      const r = await eventIntake.recordEvent({ companyId, event });
      if (r.duplicate) results.duplicates += 1;
      else results.recorded += 1;

      if (!r.eventId) {
        /* Recorded, supposedly, and nothing to point at. Never acknowledged. */
        infrastructureFailure = "The event could not be confirmed as stored.";
        break;
      }

      /* ── PROCESSING RUNS FOR A DUPLICATE TOO ──────────────────────────
         A replay must RESUME whatever the first delivery did not finish. Only
         re-running the pipeline can do that, and it is safe to: identity
         resolution is a read, suppression is idempotent on a key derived from
         this event, and the Activity is refused a second row by a unique index.
         Skipping duplicates would mean a delivery that crashed halfway is never
         completed, however many times Mautic re-sends it. */
      /* ── THE COMPLETE EXPECTED IDENTITY ───────────────────────────────
         Not `findById`. The id came from this request's own insert, so it is
         almost certainly right — and "almost certainly" is not the standard for
         a lookup that decides which company's observation gets processed,
         suppressed and projected. Every part is asserted. */
      const recorded = await MarketingIntentEvent.findOne({
        _id: r.eventId,
        companyId,
        source: str(event?.source) || "mautic",
        sourceEventId: str(event?.sourceEventId),
      }).lean();
      if (!recorded) {
        infrastructureFailure = "The event could not be read back after being stored.";
        break;
      }

      let receipt;
      try {
        receipt = await engagement.processEvent({ companyId, event: recorded });
      } catch (procErr) {
        /* The ledger row is safe and immutable, so a replay will find it and
           resume. But the receipt did not save, so nothing yet records what is
           owed — which makes this exactly the case that must NOT be
           acknowledged. */
        console.error("[marketing] processing failed after the event was stored:", str(procErr?.message));
        infrastructureFailure = "The event was stored but its processing state could not be saved.";
        break;
      }

      if (receipt.state === "SUPPRESSION_FAILED" || receipt.state === "ACTIVITY_FAILED") {
        /* Durably recorded as owed. 200 is correct: the receipt keeps it visible
           to Data Health and `resumeUnfinished` retries it, and Mautic
           re-delivering would only re-record an event we already have. */
        results.needsAttention.push({ sourceEventId: str(event?.sourceEventId), state: receipt.state });
      }
    } catch (err) {
      /* ── TERMINAL CONTENT, OR INFRASTRUCTURE? ─────────────────────────
         Decided from the error's own stable marking, never from its prose. A
         validation refusal carries `details.terminal`; anything else is treated
         as infrastructure, because guessing "terminal" on an unrecognised error
         is how an event is thrown away. */
      if (err?.details?.terminal) {
        results.rejected.push({
          sourceEventId: str(event?.sourceEventId),
          reason: str(err?.message),
        });
      } else {
        console.error("[marketing] webhook intake failed:", str(err?.message));
        infrastructureFailure = "The event could not be stored.";
        break;
      }
    }
  }

  if (infrastructureFailure) {
    /* 503, and a sentence with no database message, no driver code and no stack
       — an unauthenticated-adjacent endpoint tells a caller what to do, never
       what broke internally. Mautic retries. */
    return res.status(503).json({
      success: false,
      message: "The event could not be processed durably. Please deliver it again.",
      ...results,
    });
  }

  return res.status(200).json({ success: true, ...results });
});

/* ═══ THE MARKETER'S API ═══════════════════════════════════════════════════ */

router.use(express.json());
router.use(marketingAuth);

/** What Sales would be sent, and what the rules say about it. Reads only. */
router.post("/handovers/preview", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const { pkg, permission, threshold, assessment } =
    await handovers.preparePackage({ companyId, input: req.body || {} });
  return res.json({
    success: true,
    package: pkg,
    permission,
    threshold,
    assessment,
    wouldSubmit: permission.allowed && threshold.met,
  });
}));

/* ── HEALTH ─────────────────────────────────────────────────────────────────
   Behind the Marketing session, not public: the report names the configured
   base URL and says which credential was refused, and an unauthenticated
   caller has no business with either.

   It answers 200 whatever it finds. A health check that 503s when the thing it
   monitors is down cannot be told apart from a health check that is itself
   down, and an operator needs those to look different. `healthy` in the body is
   the answer; the status code says only that the check ran. */
router.get("/health", handle(async (req, res) => {
  const health = await mauticHealth.check({});
  let webhook;
  try {
    webhook = await mauticHealth.webhookState({ companyId: await companyFor(req) });
  } catch {
    /* A company that could not be resolved is not a Mautic fault and must not
       be reported as one. */
    webhook = await mauticHealth.webhookState({});
  }
  /* ── THE ENGINE'S HEALTH, WITHOUT NAMING OR LOCATING IT ────────────────
     `mauticHealth.check` returns the provider's base URL and its per-check
     detail strings, both of which say where the marketing platform lives and
     which product it is. A marketer needs one thing from this endpoint: whether
     marketing is working. An operator needs the rest, and reads it in the
     server log. */
  return res.json({
    success: true,
    engine: {
      healthy: health.healthy,
      checkedAt: health.checkedAt,
      /* Per-check STATES only — `ok`, `failed`, `not_configured` — with the
         provider's own detail sentences dropped. */
      checks: Object.fromEntries(
        Object.entries(health.checks || {}).map(([name, c]) => [name, { state: c.state }]),
      ),
      durationMs: health.durationMs,
    },
    webhook: {
      configured: webhook.secretConfigured ?? webhook.configured ?? null,
      lastEventAt: webhook.lastEventAt ?? null,
    },
  });
}));

/** Submit a handover. Repeating the same submission returns the same record. */
router.post("/handovers", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const result = await handovers.submit({
    companyId,
    input: req.body || {},
    actor: actorOf(req),
    idempotencyKey: str(req.get("idempotency-key") || req.body?.idempotencyKey),
  });

  /* Ask for delivery straight away so the Sales inbox is not waiting on a
     sweep. Never awaited for its success: the handover is recorded either way,
     and a receiver that is temporarily down must not fail this request. */
  let deliveryResult = null;
  if (!result.blocked) {
    deliveryResult = await delivery.deliverPending({
      companyId, correlationId: result.handover.correlationId,
    });
  }

  return res.status(result.duplicate ? 200 : 201).json({
    success: true,
    handover: result.handover,
    blocked: result.blocked,
    reason: result.reason,
    duplicate: result.duplicate,
    delivery: deliveryResult,
  });
}));

/**
 * GET /handovers?state=all&cursor=…&limit=25
 *
 * The operational list behind /marketing/handovers. Every row answers six
 * questions about one handover, and all six are assembled by
 * services/marketing/handoverReadModel.service.js from Marketing-owned records
 * — this handler validates what was asked for and serialises the answer.
 *
 * ── WHAT CHANGED FROM THE FIRST VERSION ───────────────────────────────────
 * It used to return whole `ProspectHandover` documents with `count` set to the
 * length of the page. Two problems. A document is not a contract: a field added
 * to the model appeared on the wire without anybody deciding it should. And a
 * page length presented as a count is a number that says 50 when there are
 * 4,000, which is worse than no number at all. The page now carries an exact
 * company-scoped `summary` and a cursor.
 */
router.get("/handovers", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const view = await readModel.list({
    companyId,
    /* Validated inside the service, which refuses an unknown filter rather than
       answering it with an empty page. */
    state: str(req.query.state) || "all",
    cursor: str(req.query.cursor) || null,
    limit: req.query.limit,
  });

  return res.json({
    success: true,
    rows: view.rows,
    summary: view.summary,
    nextCursor: view.nextCursor,
    hasMore: view.hasMore,
    measuredAt: view.measuredAt.toISOString(),
    /* Echoed so a client can tell which filter produced this page, and served
       alongside the accepted set so it never has to hard-code them. */
    filter: view.filter,
    filters: readModel.LIST_FILTERS,
    page: { size: view.rows.length, maxSize: readModel.MAX_PAGE },
  });
}));

/**
 * GET /handovers/:handoverRef
 *
 * One handover: the same row the list serves, plus the evidence and the audit
 * trail, which is the whole reason a detail view exists.
 *
 * `row.acquisition` carries the four disclosure facts rather than a paused
 * boolean, and `row.salesRecord` is an identity the frontend turns into its own
 * internal link. Marketing holds no copy of the Sales record and cannot edit it.
 */
router.get("/handovers/:handoverRef", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const view = await readModel.detail({
    companyId, handoverRef: str(req.params.handoverRef),
  });
  return res.json({
    success: true,
    row: view.row,
    evidence: view.evidence,
    permission: view.permission,
    assessmentFactors: view.assessmentFactors,
    history: view.history,
    blockedReason: view.blockedReason,
    measuredAt: view.measuredAt.toISOString(),
  });
}));

/**
 * POST /handovers/acquisition-holds/retry
 *
 * The operator seam for a stop that Mautic refused. Not on the Data Health
 * router, which is GET-only on purpose: inspection that mutates cannot be used
 * by somebody merely trying to understand a problem.
 *
 * ── THIS IS NOT AUTOMATIC RECOVERY, AND NOTHING HERE CLAIMS IT IS ──────────
 * There is no scheduler. A failed pause waits for this endpoint or for a
 * redelivery of the same Sales decision, and every Sales-facing label says
 * "awaiting retry" rather than "will be retried".
 *
 * Four properties, each load-bearing for a route that performs bulk outbound
 * writes against a provider:
 *
 *   PERMISSION-APPROPRIATE  an elevated role, not every marketing user. A
 *                           marketer reading Data Health must not be able to
 *                           drive a hundred Mautic writes by accident.
 *   COMPANY-SCOPED          the company comes from the session, never the body,
 *                           and the sweep carries it into every selector.
 *   BOUNDED                 a hard ceiling regardless of what is asked for, so
 *                           one request cannot become an unbounded provider run.
 *   AUDITABLE               one audit line per command claimed, naming the actor.
 */
router.post("/handovers/acquisition-holds/retry", handle(async (req, res) => {
  const companyId = await companyFor(req);

  /* Plain `marketing` is enough to READ Data Health and to see that a pause
     failed. Driving the repair is an operator act. */
  const elevated = req.user?.isAdmin || ["admin", "ceo"].includes(str(req.user?.role));
  if (!elevated) {
    throw fail("FORBIDDEN",
      "Retrying acquisition holds drives live Mautic writes, so it needs an administrator.");
  }

  const RETRY_CEILING = 50;
  const asked = Number(req.body?.limit) || 25;
  const limit = Math.max(1, Math.min(asked, RETRY_CEILING));

  const summary = await acquisitionHold.resumeUnfinished({
    companyId,
    limit,
    by: str(req.user?.name) || "operator",
    actor: { id: req.user?.id, name: str(req.user?.name), email: str(req.user?.email) },
  });
  return res.json({
    success: true,
    summary,
    /* Said out loud in the response, so a client cannot render this as
       "recovery is running". */
    bounded: { requested: asked, applied: limit, ceiling: RETRY_CEILING },
    automatic: false,
  });
}));

/** Operator seam: drain anything a failed delivery left behind. */
router.post("/handovers/deliver-pending", handle(async (req, res) => {
  const companyId = await companyFor(req);
  return res.json({ success: true, summary: await delivery.deliverPending({ companyId }) });
}));

router.use((err, req, res, _next) => sendError(res, err));

module.exports = router;
