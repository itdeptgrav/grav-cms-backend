// routes/CMS_Routes/Marketing/contentPlan.js
//   → mounted at /api/cms/marketing
//
// THE MARKETING CONTENT PLANNER — A PLANNING TOOL, NOT A PUBLISHER.
//
//   GET   /content-plan/calendar                  planned items in a date range, by day
//   GET   /content-plan/items                      every item, dated or not, paged
//   GET   /content-plan/items/:itemRef             one item, with brief, notes and history
//   POST  /content-plan/items                      create an idea
//   PATCH /content-plan/items/:itemRef             edit (expectedRevision required)
//   POST  /content-plan/items/:itemRef/actions     start | submit | withdraw | approve |
//                                                  return | reopen | cancel | cancel_approved
//   GET   /content-plan/owners                     who an item can be assigned to
//
// ── NOTHING HERE REACHES THE OUTSIDE WORLD ─────────────────────────────────
// No route creates, schedules, sends or publishes content, and none touches an
// advertising account. The Content library router is untouched and still has
// no write route; the planner only READS it to confirm a linked asset exists.
//
// ── WHO ────────────────────────────────────────────────────────────────────
// Marketing, administrators and the CEO use the planner. Approving, returning
// and cancelling an approved item are for administrators and the CEO, and
// nobody approves their own submission. Sales is refused by the guard.
"use strict";

const express = require("express");

const router = express.Router();

const marketingAuth = require("../../../Middlewear/MarketingAuthMiddlewear");
const membership = require("../../../services/companyContext/companyMembership.service");
const { fail } = require("../../../services/storePurchase/errors");
const providerPrivacy = require("../../../services/marketing/providerPrivacy");
const planner = require("../../../services/marketing/contentPlan/contentPlan.service");

const handle = providerPrivacy.handleMarketing({ surface: "marketing" });
const sendError = (res, err) => providerPrivacy.sendMarketingError(res, err);
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

/* A content-library client can be supplied by the host (tests use this); by
   default the inventory builds its own read-only one. */
const contentClientOf = (req) => req.app?.locals?.marketingContentClient || null;

function noQuery(req) {
  const named = Object.keys(req.query || {});
  if (named.length) throw fail("VALIDATION", "This request takes no query parameters.", { unknown: named });
}

router.use(express.json({ limit: "32kb" }));
router.use(marketingAuth);

router.get("/content-plan/calendar", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const view = await planner.calendar({
    companyId, user: req.user, query: req.query || {}, contentClient: contentClientOf(req),
  });
  return res.json({ success: true, ...view, vocabulary: planner.vocabulary });
}));

router.get("/content-plan/items", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const view = await planner.list({
    companyId, user: req.user, query: req.query || {}, contentClient: contentClientOf(req),
  });
  return res.json({ success: true, ...view, vocabulary: planner.vocabulary });
}));

router.get("/content-plan/owners", handle(async (req, res) => {
  noQuery(req);
  const companyId = await companyFor(req);
  const view = await planner.owners({ companyId, user: req.user });
  return res.json({ success: true, ...view });
}));

router.get("/content-plan/items/:itemRef", handle(async (req, res) => {
  noQuery(req);
  const companyId = await companyFor(req);
  const view = await planner.detail({
    companyId, user: req.user, itemRef: str(req.params.itemRef), contentClient: contentClientOf(req),
  });
  return res.json({ success: true, ...view, vocabulary: planner.vocabulary });
}));

/* Every write answers with the item as a fresh read would show it. */
async function answer(req, res, companyId, itemRef, status, flags) {
  const view = await planner.detail({ companyId, user: req.user, itemRef, contentClient: contentClientOf(req) });
  return res.status(status).json({ success: true, ...flags, ...view, vocabulary: planner.vocabulary });
}

router.post("/content-plan/items", handle(async (req, res) => {
  noQuery(req);
  const companyId = await companyFor(req);
  const out = await planner.create({
    companyId, user: req.user, payload: req.body || {}, contentClient: contentClientOf(req),
  });
  return answer(req, res, companyId, out.item.itemRef, out.duplicate ? 200 : 201, { duplicate: out.duplicate });
}));

router.patch("/content-plan/items/:itemRef", handle(async (req, res) => {
  noQuery(req);
  const companyId = await companyFor(req);
  const out = await planner.update({
    companyId, user: req.user, itemRef: str(req.params.itemRef), payload: req.body || {},
    contentClient: contentClientOf(req),
  });
  return answer(req, res, companyId, out.item.itemRef, 200, { unchanged: out.unchanged });
}));

router.post("/content-plan/items/:itemRef/actions", handle(async (req, res) => {
  noQuery(req);
  const companyId = await companyFor(req);
  const out = await planner.act({
    companyId, user: req.user, itemRef: str(req.params.itemRef), payload: req.body || {},
  });
  return answer(req, res, companyId, out.item.itemRef, 200, { duplicate: out.duplicate });
}));

/* A malformed body is a refusal, not a crash. */
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
