// routes/CMS_Routes/Marketing/campaignDrafts.js
//   → mounted at /api/cms/marketing
//
// GRAV CAMPAIGN PLANS: WRITE, SUBMIT, DECIDE.
//
//   POST   /campaign-drafts                 create a plan, in draft
//   GET    /campaign-drafts                 one page of this company's plans
//   GET    /campaign-drafts/:id             one plan, with its history
//   PATCH  /campaign-drafts/:id             edit a draft or a returned plan
//   POST   /campaign-drafts/:id/submit      freeze it and ask for a decision
//   POST   /campaign-drafts/:id/decision    approve, return or reject
//   POST   /campaign-drafts/:id/cancel      withdraw or stand down
//
// ── NOTHING HERE TOUCHES AN ADVERTISING CHANNEL ────────────────────────────
// These routes write GRAV documents. No provider adapter is imported and none is
// reachable: `approved` records a decision and creates nothing in Google Ads or
// Meta, commits no budget and starts no spending. A test asserts this file and the
// service behind it load no provider client, because the easiest way for an
// approval to start costing money is for somebody to add a convenient import
// during the deployment chunk.
//
// External deployment, activation, pausing and deletion are all absent, and each
// will need its own route rather than a new branch in one of these.
//
// ── THE COMPANY NEVER COMES FROM THE REQUEST ───────────────────────────────
// Resolved from the authenticated actor's membership, under the same memo key the
// other Marketing routers use, so a request touching two of them resolves one
// company and cannot disagree with itself. No `companyId` is read from a query
// string or a body anywhere in this file, and the public plan identifier carries
// a signed company of its own that must match.
//
// ── WHO WRITES AND WHO DECIDES ─────────────────────────────────────────────
// Marketing writes, submits and withdraws. An administrator or the CEO approves,
// returns and rejects. Sales is not a participant: accepting a prospect handover
// is Sales' decision, and committing marketing budget is not the same authority.
// The role rules live in the service, beside the transition table they guard, so
// a second caller cannot reach a transition under a different rule.
"use strict";

const express = require("express");

const router = express.Router();

const marketingAuth = require("../../../Middlewear/MarketingAuthMiddlewear");
const membership = require("../../../services/companyContext/companyMembership.service");
const { fail } = require("../../../services/storePurchase/errors");
const providerPrivacy = require("../../../services/marketing/providerPrivacy");

/* The Marketing-safe error sender. A plan is a GRAV document so most refusals
   here are GRAV's own, but the scrubber stays as the backstop — a content
   reference or a channel name could carry provider text in, and nothing leaves a
   Marketing route without passing it. */
const sendError = (res, err) => providerPrivacy.sendMarketingError(res, err);
const handle = providerPrivacy.handleMarketing({ surface: "marketing" });

const drafts = require("../../../services/marketing/campaignDrafts/campaignDraft.service");

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

/* Bodies are small documents. A description is capped at 4,000 characters and
   fifty content references are a few kilobytes, so 64kb is generous and a
   megabyte of JSON is not a campaign plan. */
router.use(express.json({ limit: "64kb" }));
router.use(marketingAuth);

/**
 * POST /campaign-drafts
 *
 * Creates in `draft`. The payload allowlist is closed: an unknown field is
 * refused by name rather than ignored, because a silently dropped field leaves
 * somebody believing GRAV stored their budget.
 *
 * ── `idempotencyKey` IS REQUIRED ───────────────────────────────────────────
 * A body field, which is the convention the prospect-handover submission already
 * uses in this domain rather than a new one. Creation is the one command with no
 * prior revision to recognise a retry by, so without it a retry after a dropped
 * connection creates a second plan with a second reference and a second campaign
 * identity claim, and the author sees two.
 *
 * The same key with the same payload continues or returns the same plan. The same
 * key with a different payload is refused rather than answered with the earlier
 * plan, which would hide a client bug behind an apparent success.
 *
 * An `Idempotency-Key` header is accepted as a convenience for clients that set
 * one globally, and the body wins when both are present — the body is what the
 * rest of this domain uses, and silently preferring a header would make the
 * effective key depend on something the payload does not show.
 */
router.post("/campaign-drafts", handle(async (req, res) => {
  const companyId = await companyFor(req);

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const headerKey = str(req.get("Idempotency-Key"));
  const payload = Object.prototype.hasOwnProperty.call(body, "idempotencyKey") || !headerKey
    ? body
    : { ...body, idempotencyKey: headerKey };

  const draft = await drafts.create({ companyId, user: req.user, payload });

  /* 201 for a plan this request created, 200 when an earlier attempt under the
     same key already created it. A client that retried deserves to know which. */
  return res.status(draft.duplicate ? 200 : 201).json({
    success: true,
    campaignDraft: draft,
    duplicate: draft.duplicate === true,
    vocabulary: drafts.vocabulary,
  });
}));

/**
 * GET /campaign-drafts?state=…&limit=…&page=…
 *
 * This company's plans only. The selector carries the company; there is no
 * parameter that could widen it.
 *
 * ── THE RESPONSE SHAPE ─────────────────────────────────────────────────────
 *
 *   {
 *     "success": true,
 *     "campaignDrafts": [            // confirmed plan documents ONLY
 *       { …the plan…, "repairPending": false }
 *     ],
 *     "page": {                      // describes confirmed matching plans only
 *       "number": 1, "size": 25, "total": 63, "pages": 3
 *     },
 *     "pendingCreations": {          // recorded, not yet a plan document
 *       "items": [
 *         {
 *           "campaignDraftId": "<signed identifier>",
 *           "reference": "MCP-2026-0007",
 *           "name": "Winter uniforms 2026",
 *           "state": "draft",
 *           "createdAt": "2026-09-11T08:14:02.551Z",
 *           "readable": true
 *         }
 *       ],
 *       "total": 2, "limit": 50, "capped": false
 *     },
 *     "vocabulary": { … }
 *   }
 *
 * `campaignDrafts` never contains a synthetic row built from history. It is
 * filtered by the requested state and paginated against confirmed plans alone, so
 * a page never exceeds the requested size and `page.total` always agrees with the
 * rows a client can actually walk through.
 *
 * `pendingCreations` is NOT part of pagination. Its scope is the whole company, it
 * is returned identically on every ordinary page, and it is capped at 50 items with
 * `total` giving the true count and `capped` saying whether the list was trimmed.
 * It respects the same state filter. A pending item carries only the six safe
 * fields above — no repair stage, no revision, no database id, and nothing about a
 * collection or a driver. `readable` says whether opening that identifier will
 * work; why it would not is an operator's question and stays in the server log.
 *
 * A plan that EXISTS but is behind its own history is not a pending creation. It
 * stays in `campaignDrafts` and carries `repairPending: true` when it appears on
 * the requested page. Existence is determined across the whole company, not from
 * the ids on the current page.
 */
router.get("/campaign-drafts", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const view = await drafts.list({
    companyId,
    state: str(req.query.state) || null,
    limit: req.query.limit,
    page: req.query.page,
  });

  return res.json({
    success: true,
    campaignDrafts: view.rows,
    page: view.page,
    pendingCreations: view.pendingCreations,
    vocabulary: drafts.vocabulary,
  });
}));

/**
 * GET /campaign-drafts/:campaignDraftId
 *
 * The plan and its full append-only history. A malformed, forged or another
 * company's identifier is refused by local signature arithmetic, with no
 * database read for a row that was never this caller's.
 */
router.get("/campaign-drafts/:campaignDraftId", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const view = await drafts.detail({
    companyId, campaignDraftId: str(req.params.campaignDraftId), user: req.user,
  });

  return res.json({
    success: true,
    campaignDraft: view.draft,
    /* What THIS signed-in viewer may do, and why not, in booleans and words.
       Never an id. The commands re-check everything; this only saves a screen
       from offering a button the server will refuse. */
    viewerActions: view.viewerActions,
    history: view.history,
    vocabulary: drafts.vocabulary,
  });
}));

/**
 * GET /campaign-drafts/:campaignDraftId/deployment-readiness
 *
 * Whether this plan holds what GRAV needs in order to prepare an advertising
 * campaign, and what is missing.
 *
 * ── THIS ROUTE CONTACTS NOBODY AND WRITES NOTHING ──────────────────────────
 * No provider request is made. No database write happens — no readiness result is
 * stored and no deployment record is created. A readiness answer is a judgement
 * about a document at a moment, and persisting one would immediately be read as
 * current truth by something that should have re-evaluated.
 *
 * Marketing and administrators may read it. Sales is refused by the same middleware
 * that refuses them everywhere else in this router: a campaign is not theirs to
 * plan, approve or prepare.
 *
 * ── THE RESPONSE SHAPE ─────────────────────────────────────────────────────
 *
 *   {
 *     "success": true,
 *     "campaignDraftId": "<signed identifier>",
 *     "reference": "MCP-2026-0007",
 *     "evaluatedRevision": 4,          // WHICH version this verdict is about
 *     "planState": "approved",
 *     "evaluatorVersion": "readiness-1.0.0",
 *     "evaluatedAt": "2026-09-11T09:31:04.882Z",
 *
 *     "planReady": true,               // the GRAV document holds what GRAV needs
 *     "approvalReady": false,          // already decided, so nothing to approve
 *     "deploymentReady": false,        // ALWAYS false in this release
 *     "deploymentBlockedBecause": [ "…" ],
 *
 *     "sections": {
 *       "locallyConfirmed":       [ … ],   // facts about the DOCUMENT
 *       "missingFromPlan":        [ … ],
 *       "unsupportedByGrav":      [ … ],
 *       "contradictions":         [ … ],
 *       "externalChecksRequired": [ … ]    // nobody has asked these yet
 *     },
 *
 *     "channels": [ { "channel": "google_ads", "planReady": true, … } ],
 *     "counts":   { "blocking": 0, "advisory": 1, "externalOutstanding": 6 },
 *     "approvalMeaning": { "createdAnything": false, … },
 *     "vocabulary": { … }
 *   }
 *
 * Every finding carries a stable GRAV code, a plain-language title, an explanation,
 * the affected channel and field, a severity of blocking or advisory, and a
 * suggested corrective action. No provider error text appears anywhere.
 *
 * `evaluatedRevision` and `evaluatorVersion` are what stop a held result being
 * mistaken for a current one: a client comparing either against the plan it is
 * looking at can tell the answer is stale.
 */
router.get("/campaign-drafts/:campaignDraftId/deployment-readiness", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const view = await drafts.deploymentReadiness({
    companyId, campaignDraftId: str(req.params.campaignDraftId),
  });

  return res.json({ success: true, ...view });
}));

/**
 * PATCH /campaign-drafts/:campaignDraftId
 *
 * `expectedRevision` is REQUIRED. Two marketers editing one plan is the ordinary
 * case, and without it one of them loses a budget change in silence.
 *
 * A submitted plan is frozen and the refusal says what would unfreeze it.
 */
router.patch("/campaign-drafts/:campaignDraftId", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const out = await drafts.update({
    companyId, user: req.user,
    campaignDraftId: str(req.params.campaignDraftId),
    payload: req.body,
  });

  return res.json({
    success: true,
    campaignDraft: out,
    /* Truthful about whether anything moved. A payload identical to the stored
       document is a success that created no revision, and saying so stops a
       client from reporting a save that did not happen. */
    changed: out.changed,
    changedFields: out.changedFields,
    vocabulary: drafts.vocabulary,
  });
}));

/**
 * POST /campaign-drafts/:campaignDraftId/submit
 *
 * Body: `{ expectedRevision: <the revision the submitter reviewed> }` — REQUIRED.
 *
 * Freezes exactly that revision. If the plan changed since, the submit is a
 * `CAMPAIGN_DRAFT_REVISION_CONFLICT` (409) and nothing moves. A repeat of the
 * submission that was accepted — a double-click, or two people submitting the
 * same revision at once — returns the same answer with `duplicate: true` rather
 * than writing a second revision and a second history row.
 */
router.post("/campaign-drafts/:campaignDraftId/submit", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter((k) => k !== "expectedRevision");
  if (unknown.length) {
    throw fail("VALIDATION", `Submit accepts expectedRevision only. ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not part of it.`, { unknown });
  }
  if (!Object.prototype.hasOwnProperty.call(body, "expectedRevision")) {
    throw fail("VALIDATION",
      "Say which version you are submitting, so GRAV can refuse a submission built on a version somebody has already changed.",
      { field: "expectedRevision" });
  }
  const out = await drafts.submit({
    companyId, user: req.user, campaignDraftId: str(req.params.campaignDraftId),
    expectedRevision: body.expectedRevision,
  });

  return res.json({
    success: true,
    campaignDraft: out,
    duplicate: out.duplicate === true,
    vocabulary: drafts.vocabulary,
  });
}));

/**
 * POST /campaign-drafts/:campaignDraftId/decision
 *
 * Body: `{ decision: "approve" | "return" | "reject", reason?: string }`
 *
 * ── APPROVAL IS NOT ACTIVATION ─────────────────────────────────────────────
 * This writes a state and an audit row. Nothing is created in an advertising
 * channel, no budget is committed and no money can be spent as a result. The
 * response carries `deploymentMeans` saying so, because `approved` is the word a
 * reader will take for "live".
 *
 * Idempotent on a matching decision. A DIFFERENT decision on an already-decided
 * plan is a state conflict, not an overwrite: changing an approval into a
 * rejection is a new decision somebody must make from a state that allows it.
 */
router.post("/campaign-drafts/:campaignDraftId/decision", handle(async (req, res) => {
  const companyId = await companyFor(req);

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter((k) => !["decision", "reason"].includes(k));
  if (unknown.length) {
    throw fail("VALIDATION",
      `A decision accepts decision and reason. ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not part of it.`,
      { unknown });
  }

  const out = await drafts.decide({
    companyId, user: req.user,
    campaignDraftId: str(req.params.campaignDraftId),
    decision: body.decision,
    reason: body.reason,
  });

  return res.json({
    success: true,
    campaignDraft: out,
    duplicate: out.duplicate === true,
    vocabulary: drafts.vocabulary,
  });
}));

/**
 * POST /campaign-drafts/:campaignDraftId/cancel
 *
 * Marketing may withdraw a plan before a decision. Standing down an APPROVED plan
 * is the approver's call, because the approval was theirs.
 */
router.post("/campaign-drafts/:campaignDraftId/cancel", handle(async (req, res) => {
  const companyId = await companyFor(req);

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter((k) => k !== "reason");
  if (unknown.length) {
    throw fail("VALIDATION", `Cancelling accepts a reason. ${unknown.join(", ")} is not part of it.`, { unknown });
  }

  const out = await drafts.cancel({
    companyId, user: req.user,
    campaignDraftId: str(req.params.campaignDraftId),
    reason: body.reason,
  });

  return res.json({
    success: true,
    campaignDraft: out,
    duplicate: out.duplicate === true,
    vocabulary: drafts.vocabulary,
  });
}));

/* A malformed body is a refusal, not a crash: body-parser's errors are not
   `StorePurchaseError`s and would otherwise surface as a 500. */
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
