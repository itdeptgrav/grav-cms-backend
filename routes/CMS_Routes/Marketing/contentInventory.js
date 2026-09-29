// routes/CMS_Routes/Marketing/contentInventory.js
//   → mounted at /api/cms/marketing
//
// THE READ-ONLY CONTENT LIBRARY INVENTORY.
//
//   GET /content/summary                     how much of each kind exists
//   GET /content?kind=…&cursor=…&limit=…      one page of one kind
//
// ── EVERY ROUTE IS A GET, AND THAT IS THE WHOLE CONTRACT ───────────────────
// Mautic owns content storage, editing, publishing and sending (ADR-004). GRAV
// owns a read-only inventory of it and, later, the intelligence built on top.
// There is no POST, PUT, PATCH or DELETE here, and the client methods these
// routes reach are GET-only against a closed table of three endpoints — so this
// router could not send an email even if somebody asked it to.
//
// ── THE COMPANY NEVER COMES FROM THE REQUEST ───────────────────────────────
// One Mautic instance serves one GRAV organisation. The company is resolved
// from the authenticated actor's membership and compared with the configured
// Marketing company; a second company is refused rather than shown a filtered
// view of somebody else's estate, because Mautic holds no GRAV company on its
// assets and there is nothing to filter by. No `companyId` is read from a query
// string or a body anywhere in this file.
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
const contentInventory = require("../../../services/marketing/contentInventory.service");

const str = (v) => String(v ?? "").trim();

/* Resolved from the actor's membership, once per request, under the same memo
   key the other Marketing routers use so a request touching two of them
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

router.use(express.json({ limit: "16kb" }));
router.use(marketingAuth);

/**
 * GET /content/summary
 *
 * Each kind counted independently, with its own state. A kind that could not be
 * read reports `count: null` and says why — it never becomes zero, because a
 * zero looks like information and like good news, and is indistinguishable from
 * a genuinely empty estate somebody might act on.
 */
router.get("/content/summary", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const view = await contentInventory.summary({ companyId });

  return res.json({
    success: true,
    kinds: view.kinds,
    /* True when any kind failed. A client must not add these counts up and call
       the result an estate size. */
    partial: view.partial,
    unreadableKinds: view.unreadableKinds,
    totalAcrossKinds: view.totalAcrossKinds,
    measuredAt: view.measuredAt,
    vocabulary: contentInventory.vocabulary,
  });
}));

/**
 * GET /content?kind=email|form|landing_page&cursor=…&limit=…
 *
 * `kind` is REQUIRED and has no default. The three are independently paginated
 * Mautic collections with no shared ordering, so a merged list would be a page
 * whose order changes as content is edited — and a paginated list whose order
 * is not stable repeats and skips rows. Asking for one at a time is the honest
 * shape, and the refusal says so.
 */
router.get("/content", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const view = await contentInventory.list({
    companyId,
    /* Validated in the service, which refuses an unknown kind rather than
       answering it with an empty page. */
    kind: str(req.query.kind),
    cursor: str(req.query.cursor) || null,
    limit: req.query.limit,
  });

  return res.json({
    success: true,
    kind: view.kind,
    rows: view.rows,
    page: view.page,
    nextCursor: view.nextCursor,
    hasMore: view.hasMore,
    /* The engine's count of the whole library, or null. Never the length of
       this page. */
    libraryTotal: view.libraryTotal,
    libraryTotalAvailable: view.libraryTotalAvailable,
    measuredAt: view.measuredAt,
    vocabulary: contentInventory.vocabulary,
  });
}));

/* A malformed body is a refusal, not a crash — these are GETs, but the JSON
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
