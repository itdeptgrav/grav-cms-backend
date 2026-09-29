// routes/CMS_Routes/Marketing/campaignDeployment.js
//   → mounted at /api/cms/marketing
//
// ADVERTISING ACCOUNT BINDING, PREFLIGHT, AND PAUSED CREATION.
//
//   GET    /advertising-accounts/:channel                    the live binding
//   POST   /advertising-accounts/:channel                    bind an account
//   POST   /advertising-accounts/:channel/verify             read it again
//   POST   /advertising-accounts/:channel/revoke             withdraw it
//   GET    /campaign-drafts/:id/deployment/:channel/preflight   what would happen
//   POST   /campaign-drafts/:id/deployment/:channel/create-paused
//   GET    /campaign-drafts/:id/deployment/:channel          what did happen
//   POST   /campaign-drafts/:id/deployment/:channel/reconcile  did it take effect?
//
// ── PROVIDER-NEUTRAL, IN THE PATH AND IN THE BODY ──────────────────────────
// `:channel` is a GRAV channel code. No route names a Google resource, a Google
// field or a Google endpoint, and no request body can carry one: creation takes
// a plan identifier and a request identity, and builds everything else from the
// approved plan. A caller cannot describe a campaign to GRAV — it can only ask
// GRAV to deploy a plan somebody approved.
//
// The Meta path will be these same routes with `meta_ads` in them, one more
// write client and one more mapper. It is refused today by name, in the
// binding service and again in the creation service, rather than silently
// producing a Google campaign.
//
// ── ONE ROUTE CREATES ANYTHING, AND IT CREATES IT ONCE, STOPPED ────────────
// `create-paused` is the only route in GRAV that changes an advertising
// account, and it makes exactly ONE provider write: the whole campaign in one
// atomic request, or none of it. It cannot start delivery — the bundle client
// refuses any payload whose status is not the stopped one and contains no
// update or activate verb at all — and there is no activation route anywhere in
// this file or the services behind it.
//
// `reconcile` is its counterpart and is READ-ONLY at the provider. It answers
// "did my lost request take effect" by looking for GRAV's own marker, and it can
// close an unresolved attempt only when it finds a complete, stopped, correctly
// targeted campaign carrying it. It can never authorise another creation.
//
// ── WHAT NEVER REACHES THE BROWSER ─────────────────────────────────────────
// Tokens, developer tokens, client secrets and the NAMES of the environment
// variables holding them; raw provider error bodies, codes and field paths; and
// the request payloads GRAV sends. Provider OBJECT IDENTIFIERS do travel, on
// purpose: a person reconciling a half-created campaign against Google Ads
// needs them, and they are on every screen and invoice that account has.
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
const binding = require("../../../services/marketing/deployment/accountBinding.service");
const {
  callerFieldsFor, foreignFieldOwner, misplacedFieldMessage,
} = require("../../../constants/marketingGoogleSearchDeployment");
const preflightService = require("../../../services/marketing/deployment/googleSearchPreflight.service");
const metaPreflightService = require("../../../services/marketing/deployment/metaPreflight.service");
const creation = require("../../../services/marketing/deployment/pausedCreation.service");
/* A Search campaign with a lead form: created only into the proof account. */
const leadFormPreflight = require("../../../services/marketing/deployment/googleLeadFormPreflight.service");
const leadFormCreation = require("../../../services/marketing/deployment/leadFormPausedCreation.service");
const metaCreation = require("../../../services/marketing/deployment/metaPausedCreation.service");
const attempts = require("../../../services/marketing/campaignDrafts/deploymentAttempt.service");
const {
  MarketingCampaignDeployment,
} = require("../../../models/CMS_Models/Marketing/MarketingCampaignDeployment");

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

/* ── WHO MAY BIND, AND WHO MAY SPEND ────────────────────────────────────────
   Binding decides which account GRAV can create in. Creating puts a real object
   in it. Both are administrator decisions — the same authority that approves a
   plan — because a marketer who can plan a campaign should not also be the one
   who chooses the account it lands in. */
const isAdministrator = (user) => Boolean(user?.isAdmin) || ["admin", "ceo"].includes(str(user?.role));

const requireAdministrator = (req, what) => {
  if (!isAdministrator(req.user)) {
    throw fail("FORBIDDEN", `${what} is an administrator's decision.`);
  }
};

const actorFrom = (user) => ({
  id: user?.id,
  name: str(user?.name),
  role: str(user?.role),
  at: new Date(),
});

router.use(express.json({ limit: "16kb" }));
router.use(marketingAuth);

/* ── THE BODY IS AN ALLOW-LIST, ALWAYS ──────────────────────────────────────
   Stated once and used by every POST. An unknown key is refused by name rather
   than ignored, because a caller that sends `refreshToken` and gets a 200 will
   believe it was stored. */
function onlyFields(body, allowed, what) {
  const obj = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw fail("VALIDATION",
      `${what} accepts ${allowed.join(", ")}. ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not part of it.`,
      { unknown });
  }
  return obj;
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. WHICH ACCOUNT
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * GET /advertising-accounts/:channel
 *
 * The live binding, or `null`. Readable by anybody who may use Marketing: a
 * marketer about to ask for a deployment should be able to see which account it
 * would land in.
 */
router.get("/advertising-accounts/:channel", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const current = await binding.current({ companyId, channel: str(req.params.channel) });

  return res.json({
    success: true,
    channel: str(req.params.channel),
    binding: current,
    /* So a client can render "no account chosen yet" rather than an empty card
       that looks like a loading state. */
    bound: Boolean(current),
    mayBind: isAdministrator(req.user),
  });
}));

/**
 * POST /advertising-accounts/:channel
 *
 * Body, per channel — these are NOT the same list:
 *   google_ads: `{ externalAccountId, loginAccountId?, externalAccountName?, note? }`
 *   meta_ads:   `{ externalAccountId, businessId?, externalAccountName?, note? }`
 *
 * ── THE ALLOW-LIST IS THE CHANNEL'S, NOT A UNION ───────────────────────────
 * Derived from the same table the service validates against, so the two cannot
 * drift — which they had: this route allow-listed Google's four fields for
 * every channel, so `businessId` was refused as an unknown field and a Meta
 * binding could never carry the business Meta preflight reads. The service had
 * accepted and stored it the whole time; only the HTTP path was closed.
 *
 * ── NO CREDENTIAL MAY BE SENT HERE, AND SENDING ONE IS AN ERROR ────────────
 * A key that reads like a credential is refused with a message saying where
 * credentials actually live, and a VALUE that looks like one is refused even
 * under an innocent key. Nothing is stored on a refusal.
 */
router.post("/advertising-accounts/:channel", handle(async (req, res) => {
  const companyId = await companyFor(req);
  requireAdministrator(req, "Choosing which advertising account GRAV creates campaigns in");

  const channel = str(req.params.channel);
  /* An unknown channel is the service's refusal to make, not this route's: it
     owns the list of bindable channels and names them in its message. */
  const allowed = callerFieldsFor(channel);

  /* A field that belongs to the OTHER channel is refused with a message saying
     so, before the generic allow-list message. "businessId is not part of it"
     is true and invites the wrong conclusion — that GRAV cannot record a
     business at all — when the real answer is that it is Meta's field and this
     is a Google binding. */
  if (allowed.length) {
    const misplaced = Object.keys(req.body || {}).find((k) => foreignFieldOwner(k, channel));
    if (misplaced) {
      throw fail("VALIDATION", misplacedFieldMessage(misplaced, channel),
        { field: misplaced, belongsTo: foreignFieldOwner(misplaced, channel) });
    }
  }

  const body = allowed.length
    ? onlyFields(req.body, allowed, `A ${channel.replace("_", " ")} account binding`)
    : (req.body || {});

  const out = await binding.bind({
    companyId,
    channel,
    payload: body,
    actor: actorFrom(req.user),
  });

  return res.json({
    success: true,
    binding: out.binding,
    replacedPreviousBinding: out.replaced,
  });
}));

/** POST /advertising-accounts/:channel/verify — read the bound account again. */
router.post("/advertising-accounts/:channel/verify", handle(async (req, res) => {
  const companyId = await companyFor(req);
  requireAdministrator(req, "Verifying an advertising account");
  onlyFields(req.body, [], "Verifying an advertising account");

  const out = await binding.verify({
    companyId, channel: str(req.params.channel), actor: actorFrom(req.user),
  });
  return res.json({ success: true, binding: out.binding });
}));

/** POST /advertising-accounts/:channel/revoke — withdraw it. */
router.post("/advertising-accounts/:channel/revoke", handle(async (req, res) => {
  const companyId = await companyFor(req);
  requireAdministrator(req, "Withdrawing an advertising account binding");
  const body = onlyFields(req.body, ["reason"], "Withdrawing a binding");

  const out = await binding.revoke({
    companyId, channel: str(req.params.channel), reason: body.reason, actor: actorFrom(req.user),
  });
  return res.json({
    success: true,
    binding: out.binding,
    means: "Nothing new can be created in that advertising account until somebody binds it again. Anything already created there is untouched.",
  });
}));

/* ═══════════════════════════════════════════════════════════════════════════
   2. WHAT WOULD HAPPEN
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * GET /campaign-drafts/:campaignDraftId/deployment/:channel/preflight
 *
 * ── READS ONLY, AND WRITES NOTHING AT EITHER END ───────────────────────────
 * No provider mutation, and no GRAV write: no deployment record, no attempt
 * intent, no change to the plan. Opening this screen twice has the same effect
 * as opening it once, which is none.
 */
router.get("/campaign-drafts/:campaignDraftId/deployment/:channel/preflight", handle(async (req, res) => {
  const companyId = await companyFor(req);
  /* Preparable, not deployable: a Meta preflight is the point of this route for
     that channel, and refusing it because creation is not built would hide the
     very explanation a marketer needs. */
  const channel = assertPreparableChannel(req.params.channel);

  const plan = await drafts.loadForDeployment({
    companyId, campaignDraftId: str(req.params.campaignDraftId),
  });

  if (str(plan.state) !== "approved") {
    throw fail("CAMPAIGN_DRAFT_STATE_CONFLICT",
      "Only an approved campaign plan can be prepared for an advertising account.",
      { field: "state" });
  }

  if (channel === "meta_ads") {
    const meta = await metaPreflightService.preflight({ companyId, plan });
    /* ── BUILT FIELD BY FIELD ──────────────────────────────────────────────
       `preflight` carries `__resolution` internally, and a spread would put it
       on the wire the moment anything else joined it. */
    return res.json({
      success: true,
      channel,
      campaignType: meta.campaignType,
      account: meta.account,
      checks: meta.checks,
      targeting: meta.targeting,
      creative: meta.creative,
      tracking: meta.tracking,
      planProblems: meta.planProblems,
      decisions: meta.decisions,
      proposedObjects: meta.proposedObjects,
      wouldCreate: meta.wouldCreate,
      externalChecksRequired: meta.externalChecksRequired,
      creationReady: meta.creationReady,
      creationBlockers: meta.creationBlockers,
      activationReady: meta.activationReady,
      activationBlocked: meta.activationBlocked,
      deploymentReady: meta.deploymentReady,
      deploymentBlocked: meta.deploymentBlocked,
      nothingHappened: meta.nothingHappened,
      checkedAt: meta.checkedAt,
    });
  }

  if (isLeadFormPlan(plan)) {
    const lead = await leadFormPreflight.preflight({ companyId, plan });
    /* Field by field: `__resolution`, `__mapped` and `__deliveryBase` never
       reach the wire, and neither does any delivery address or secret. */
    return res.json({
      success: true,
      channel,
      campaignType: lead.campaignType,
      account: lead.account,
      checks: lead.checks,
      targeting: lead.targeting,
      planProblems: lead.planProblems,
      decisions: lead.decisions,
      wouldCreate: lead.wouldCreate,
      externalChecksRequired: lead.externalChecksRequired,
      creationReady: lead.creationReady,
      creationBlockers: lead.creationBlockers,
      activationReady: lead.activationReady,
      activationBlocked: lead.activationBlocked,
      ifCreated: lead.ifCreated,
      deploymentReady: false,
      deploymentReadyMeans: "Nothing has been created. Lead forms are created only in the proof account, stopped, until one has been proven end to end.",
      checkedAt: lead.checkedAt,
    });
  }

  const view = await preflightService.preflight({ companyId, plan });

  /* ── BUILT FIELD BY FIELD, NOT SPREAD ──────────────────────────────────
       `preflight` carries `__resolution` for the orchestrator, and a spread would
       put it on the wire the moment it was added. The rule is the same one the
       binding view follows: a response says what it says, and a new internal
       field does not become public because nobody edited this line. */
  return res.json({
    success: true,
    channel,
    campaignType: view.campaignType,
    account: view.account,
    checks: view.checks,
    targeting: view.targeting,
    planProblems: view.planProblems,
    decisions: view.decisions,
    wouldCreate: view.wouldCreate,
    creationReady: view.creationReady,
    creationBlockers: view.creationBlockers,
    activationReady: view.activationReady,
    activationBlocked: view.activationBlocked,
    ifCreated: view.ifCreated,
    /* ── AND IT IS STILL NOT "READY TO DEPLOY" ─────────────────────────────
       `deploymentReady` is the plan-level word, and it stays false until the
       external checks are done and a creation has actually happened. A caller
       reading `creationReady: true` is being told what creation WOULD do. */
    deploymentReady: false,
    deploymentReadyMeans: "Nothing has been created. This says GRAV could create this campaign, stopped, in the bound advertising account right now — not that it has, and not that anything is running.",
    checkedAt: view.checkedAt,
  });
}));

/* ═══════════════════════════════════════════════════════════════════════════
   3. THE ONE ROUTE THAT CHANGES AN ADVERTISING ACCOUNT
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * POST /campaign-drafts/:campaignDraftId/deployment/:channel/create-paused
 *
 * Body: `{ idempotencyKey }` — and nothing else. A caller cannot describe the
 * campaign; GRAV builds it from the approved plan, so what is created is what
 * was approved.
 *
 * ── THE REQUEST IDENTITY IS REQUIRED, AND IT IS THE WHOLE COMMAND ──────────
 * A retry after a dropped connection carries the same key and continues this
 * creation. The same key with a different plan revision is a different command
 * wearing a used name, and is refused rather than treated as a retry.
 *
 * ── AND IT CANNOT START ANYTHING ───────────────────────────────────────────
 * Everything it creates is created stopped. There is no route, anywhere, that
 * starts an advertising campaign, and nothing in the body can ask for one.
 */
router.post("/campaign-drafts/:campaignDraftId/deployment/:channel/create-paused", handle(async (req, res) => {
  const companyId = await companyFor(req);
  requireAdministrator(req, "Creating a campaign in an advertising account");
  const channel = assertDeployableChannel(req.params.channel);

  const body = onlyFields(req.body,
    ["idempotencyKey", "targetingFingerprint", "expectedRevision"], "Creating a paused campaign");
  if (!str(body.idempotencyKey)) {
    throw fail("VALIDATION",
      "A request identity is needed, so that retrying after a dropped connection continues this creation instead of making a second campaign.",
      { field: "idempotencyKey" });
  }

  const plan = await drafts.loadForDeployment({
    companyId, campaignDraftId: str(req.params.campaignDraftId),
  });

  /* ── TWO CHANNELS, TWO PROTOCOLS, AND THE DIFFERENCE IS REAL ────────────
       Google applies the whole campaign in one atomic request. Meta gives no
       such guarantee, so its path is a sequence with durable evidence after
       every step. They are separate services on purpose: a shared one would
       have to pretend the two channels behave the same way, and they do not. */
  if (channel === "meta_ads") {
    const meta = await metaCreation.createPaused({
      companyId,
      plan,
      /* REQUIRED for Meta: a caller that does not name the revision is asking
         GRAV to deploy whatever the plan says now, and "now" may be after an
         edit the approval never covered. */
      expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : null,
      idempotencyKey: str(body.idempotencyKey),
      requestedBy: { id: req.user?.id, name: str(req.user?.name), role: str(req.user?.role) },
      authorizedBy: { id: req.user?.id, name: str(req.user?.name), at: new Date() },
      expectedTargetingFingerprint: str(body.targetingFingerprint) || null,
    });

    return res.json({
      success: true,
      channel,
      ...meta,
      delivering: false,
      activationAvailable: false,
      means: meta.created
        ? "The campaign exists in the advertising account and is stopped. It cannot be shown to anybody and cannot spend until somebody starts it in the advertising channel."
        : "Nothing is delivering and nothing can spend.",
    });
  }

  if (isLeadFormPlan(plan)) {
    const lead = await leadFormCreation.createPaused({
      companyId,
      plan,
      /* REQUIRED: the approved revision the administrator reviewed. */
      expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : null,
      idempotencyKey: str(body.idempotencyKey),
      requestedBy: { id: req.user?.id, name: str(req.user?.name), role: str(req.user?.role) },
      authorizedBy: { id: req.user?.id, name: str(req.user?.name), at: new Date() },
      expectedTargetingFingerprint: str(body.targetingFingerprint) || null,
    });
    return res.json({
      success: true,
      channel,
      ...lead,
      delivering: false,
      activationAvailable: false,
      means: lead.created
        ? "The campaign and its lead form exist in the advertising account and are both stopped. Nobody can see the form and nothing can spend until somebody starts both in Google Ads."
        : "Nothing is delivering and nothing can spend.",
    });
  }

  const out = await creation.createPaused({
    companyId,
    plan,
    idempotencyKey: str(body.idempotencyKey),
    requestedBy: { id: req.user?.id, name: str(req.user?.name), role: str(req.user?.role) },
    /* ── OPTIONAL, AND HONOURED WHEN GIVEN ────────────────────────────────
       The targeting fingerprint from the preflight somebody looked at. Creation
       re-resolves regardless, so this is not what makes it safe — it is what
       makes "the plan changed between the screen and the button" a refusal
       instead of a campaign targeting somewhere nobody reviewed. */
    expectedTargetingFingerprint: str(body.targetingFingerprint) || null,
    /* The deployment decision, distinct from the plan's approval. Recorded with
       the time it was given, because an attempt has to be placeable against
       what the plan said then. */
    authorizedBy: { id: req.user?.id, name: str(req.user?.name), at: new Date() },
  });

  return res.json({
    success: true,
    channel,
    ...out,
    /* Stated on every response, including the failures, because "created" is a
       word a reader will take for "running". */
    delivering: false,
    activationAvailable: false,
    means: out.created
      ? "The campaign exists in the advertising account and is stopped. It cannot be shown to anybody and cannot spend until somebody starts it in the advertising channel."
      : "Nothing is delivering and nothing can spend.",
  });
}));

/* ═══════════════════════════════════════════════════════════════════════════
   4. WHAT DID HAPPEN
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * GET /campaign-drafts/:campaignDraftId/deployment/:channel
 *
 * The deployment record and its attempts. This is the screen somebody reads
 * after a creation that went wrong, so it carries the provider object
 * identifiers and every attempt's outcome — an operator reconciling against the
 * advertising interface needs both.
 */
router.get("/campaign-drafts/:campaignDraftId/deployment/:channel", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const channel = assertDeployableChannel(req.params.channel);

  const plan = await drafts.loadForDeployment({
    companyId, campaignDraftId: str(req.params.campaignDraftId),
  });

  const deployment = await MarketingCampaignDeployment.findOne({
    companyId, campaignDraftId: plan._id, channel,
  }).sort({ approvedRevision: -1 }).lean();

  /* Each channel presents its own record: the fields are the same but the
     protocols behind them are not, and one presenter would have to average
     them. */
  const present = channel === "meta_ads" ? metaCreation.publicDeployment : creation.publicDeployment;

  if (!deployment) {
    return res.json({
      success: true,
      channel,
      deployment: null,
      attempts: [],
      means: "Nothing has been created in the advertising account for this plan.",
    });
  }

  const log = await attempts.attemptsFor({ companyId, deploymentId: deployment._id });
  const outstanding = log.filter((a) => a.resolved === false);

  return res.json({
    success: true,
    channel,
    deployment: present(deployment),
    attempts: log,
    /* ── HOW TO GO AND LOOK ────────────────────────────────────────────────
       The marker is the only thing that can prove whether a lost request took
       effect. Published on this screen because this is the screen somebody
       reads when one did. */
    deploymentMarker: deployment.deploymentMarker || null,
    reconcileHint: outstanding.length
      ? "GRAV does not know how the last attempt ended. Reconcile this deployment before anything else is created for this plan — a campaign carrying GRAV's marker was created by that request, and a campaign with a matching name proves nothing."
      : "",
    /* The honest headline. An unresolved attempt is the case a person must act
       on, and burying it inside a list is how it gets missed. */
    needsReconciliation: log.some((a) => a.resolved === false),
    delivering: false,
    activationAvailable: false,
  });
}));

/**
 * POST /campaign-drafts/:campaignDraftId/deployment/:channel/reconcile
 *
 * ── THE RECOVERY ROUTE, AND IT WRITES NOTHING EXTERNALLY ───────────────────
 * GRAV sent one atomic request and never learned the outcome. Either the whole
 * campaign exists or none of it does. This looks for GRAV's own marker in the
 * bound account and says which — and it is the only way an unresolved attempt
 * ever closes.
 *
 * It creates nothing, changes nothing and removes nothing in the advertising
 * account. It cannot: the service behind it has no access to the bundle client.
 * A clean result settles GRAV's own attempt record, which is a database write.
 *
 * Idempotent. Running it twice on a settled attempt finds the result already
 * there rather than writing a second account of one attempt.
 */
router.post("/campaign-drafts/:campaignDraftId/deployment/:channel/reconcile", handle(async (req, res) => {
  const companyId = await companyFor(req);
  requireAdministrator(req, "Reconciling a campaign against an advertising account");
  const channel = assertDeployableChannel(req.params.channel);
  onlyFields(req.body, [], "Reconciling a deployment");

  const plan = await drafts.loadForDeployment({
    companyId, campaignDraftId: str(req.params.campaignDraftId),
  });

  const out = channel === "meta_ads"
    ? await metaCreation.reconcile({ companyId, plan })
    : isLeadFormPlan(plan)
      ? await leadFormCreation.reconcile({ companyId, plan })
      : await creation.reconcile({ companyId, plan });

  return res.json({
    success: true,
    channel,
    ...out,
    /* On every response, including the clean one: reconciliation reports, it
       does not authorise. A caller that reads `reconciled: true` is being told
       the earlier attempt is now accounted for — not that it may create again. */
    delivering: false,
    activationAvailable: false,
  });
}));

/* ── WHICH GOOGLE PROTOCOL A PLAN USES ──────────────────────────────────────
   Read from the plan's own brief, never from the request. */
const isLeadFormPlan = (plan) => (plan?.deploymentBriefs || [])
  .some((b) => b.channel === "google_ads" && b.campaignType === "google_lead_form");

/* ── TWO DIFFERENT CAPABILITIES, AND THEY ARE NOT THE SAME LIST ─────────────
   GRAV can PREPARE a campaign in either channel: bind an account, resolve
   targeting, check the plan and say exactly what would be made. It can CREATE
   one only in Google Ads.

   Kept as two lists because collapsing them is how a Meta plan would reach a
   Google mapper and produce a Search campaign for a brief describing an image
   advertisement. */
const PREPARABLE = Object.freeze(["google_ads", "meta_ads"]);
const DEPLOYABLE = Object.freeze(["google_ads", "meta_ads"]);

function assertPreparableChannel(value) {
  const code = str(value);
  if (!PREPARABLE.includes(code)) {
    throw fail("CAMPAIGN_DEPLOYMENT_NOT_BUILT",
      "GRAV cannot prepare campaigns in that channel yet.",
      { field: "channel" });
  }
  return code;
}

function assertDeployableChannel(value) {
  const code = assertPreparableChannel(value);
  if (!DEPLOYABLE.includes(code)) {
    throw fail("CAMPAIGN_DEPLOYMENT_NOT_BUILT",
      "GRAV can check and explain a campaign for that channel, but it cannot create one there yet.",
      { field: "channel" });
  }
  return code;
}

/* Same body-parser guard the other Marketing routers use: a malformed JSON body
   is a GRAV refusal with a GRAV message, not an express stack trace. */
const BODY_PARSER_TYPES = new Set(["entity.parse.failed", "entity.too.large"]);

router.use((err, req, res, next) => {
  if (!err || !BODY_PARSER_TYPES.has(err.type)) return next(err);
  return sendError(res, fail("VALIDATION",
    err.type === "entity.too.large"
      ? "That request was too large."
      : "That request body could not be read as JSON."));
});

module.exports = router;
