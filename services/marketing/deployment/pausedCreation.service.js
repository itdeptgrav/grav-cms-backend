// services/marketing/deployment/pausedCreation.service.js
//
// CREATE ONE GOOGLE SEARCH CAMPAIGN, STOPPED, ONCE.
//
// ── THE ORDER IS THE SAFETY ────────────────────────────────────────────────
// Nine steps, and every one of them is before the next for a reason somebody
// will eventually be glad of:
//
//   1. The plan is approved, and this is the revision that was approved.
//   2. The company has a verified binding — WHICH account, decided by a person.
//   3. Preflight passes, against that account, reading only. Preflight now
//      RESOLVES every location and language, and fails if any of them cannot be.
//   4. The mapping is built from the plan, the account and the RESOLVED
//      targeting, deterministically.
//   5. The deployment record is found or created for (plan, revision, channel).
//   6. An attempt INTENT is written, and it says `mayCallProvider`.
//   7. Only then does anything leave the process, in dependency order.
//   8. The created objects' delivery states and CRITERIA are READ BACK.
//   9. The attempt is settled with what happened, and the deployment rolled up.
//
// Steps 3 and 4 are where the targeting correction lives, and their position
// matters more than their content: they are before step 5. A plan whose
// locations cannot be resolved produces NO deployment record, NO attempt intent
// and NO external object — the refusal happens while GRAV has still written
// nothing anywhere.
//
// Steps 6 and 9 are the two-fact protocol: the intent exists before the request,
// so a process that dies mid-flight leaves a row saying "something may exist in
// that account", and the next caller is told to reconcile instead of being
// allowed to create a second campaign.
//
// ── WHAT THIS DOES WHEN IT LOSES A RESPONSE ────────────────────────────────
// It stops. It does not retry the call, it does not look the object up by name
// and assume, and it does not roll back. A request that timed out may have
// succeeded, and all three of those alternatives can destroy or duplicate a real
// campaign. The attempt stays unresolved, the deployment goes to a state that
// says a person must look, and the next call is refused with the same message
// rather than quietly starting again.
//
// The one thing it does do is report exactly which objects it had confirmed
// before the silence, so the person looking knows what to look for.
"use strict";

const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
const attempts = require("../campaignDrafts/deploymentAttempt.service");
const binding = require("./accountBinding.service");
const mapper = require("./googleSearchMapper");
const preflightService = require("./googleSearchPreflight.service");
const targeting = require("./targetingResolution.service");
const bundleClient = require("../channels/googleSearchBundle");
const reconciler = require("./bundleReconciliation.service");
const { markerFor } = require("./deploymentMarker");
const {
  MarketingCampaignDeployment,
} = require("../../../models/CMS_Models/Marketing/MarketingCampaignDeployment");
const {
  MarketingCampaignDeploymentAttemptIntent,
} = require("../../../models/CMS_Models/Marketing/MarketingCampaignDeploymentAttempt");
const {
  NON_DELIVERING_STATUS,
  GOOGLE_SEARCH_OBJECT_BY_CODE,
} = require("../../../constants/marketingGoogleSearchDeployment");

const str = (v) => String(v ?? "").trim();

/* ── GOOGLE'S NON-DELIVERING STATUSES, READ NOT WRITTEN ─────────────────────
   A created object is confirmed non-delivering when the account reports it as
   one of these. `PAUSED` is what GRAV asked for; `REMOVED` is included because
   an object somebody removed between the create and the read is also not
   delivering, and reporting that as "still able to deliver" would send an
   operator to pause something that no longer exists. */
const NON_DELIVERING_STATUSES = Object.freeze(["PAUSED", "REMOVED"]);

/* ── THE CHANNEL ANSWERED, AND THE ANSWER WAS NO ────────────────────────────
   These are the GRAV codes that mean the request COMPLETED with a refusal. The
   distinction is the whole recovery story: a refusal means the atomic request
   was rejected and created nothing, so the attempt can be settled as a failure
   with no external object claimed and nothing to undo. Anything else means GRAV
   does not know, and the attempt stays open. */
const REFUSAL_CODES = Object.freeze([
  "CHANNEL_ACCESS_REFUSED",
  "CHANNEL_MALFORMED_RESPONSE",
  "CHANNEL_UNSUPPORTED_OPERATION",
  "VALIDATION",
  "INTERNAL",
]);

/**
 * Find or create the deployment record for one approved plan revision.
 *
 * The uniqueness on `(company, plan, revision, channel)` is what makes a retry
 * safe: a second call finds this row instead of starting a second deployment.
 */
async function deploymentFor({ companyId, plan, idempotencyKey, authorizedBy, marker, campaignType = "google_search" }) {
  const selector = {
    companyId,
    campaignDraftId: plan._id,
    approvedRevision: plan.revision,
    channel: "google_ads",
  };

  const existing = await MarketingCampaignDeployment.findOne(selector);
  if (existing) {
    /* ── A SECOND IDEMPOTENCY KEY FOR ONE DEPLOYMENT IS A SECOND COMMAND ───
       Which would be a second campaign. Refused here rather than at the
       attempt, so the message names the thing the caller actually has. */
    if (str(existing.idempotencyKey) !== str(idempotencyKey)) {
      throw fail("CONFLICT",
        "This plan revision already has a deployment under a different request identity. Continue that one rather than starting a second, which would create a second campaign.",
        { field: "idempotencyKey" });
    }
    return existing;
  }

  try {
    return await MarketingCampaignDeployment.create({
      ...selector,
      draftRef: plan.draftRef,
      campaignType,
      idempotencyKey: str(idempotencyKey),
      /* Stored at creation, not after the request: a reconciler looking for
         "what may exist for this plan" must not depend on a write that happens
         after the one thing that could have failed. */
      deploymentMarker: str(marker),
      state: "preparing",
      deploymentApprovedBy: authorizedBy,
    });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    /* Two callers raced. The loser reads the winner's row and continues under
       it, which is the whole purpose of the unique index. */
    const won = await MarketingCampaignDeployment.findOne(selector);
    if (!won) throw err;
    if (str(won.idempotencyKey) !== str(idempotencyKey)) {
      throw fail("CONFLICT",
        "This plan revision already has a deployment under a different request identity.",
        { field: "idempotencyKey" });
    }
    return won;
  }
}

/**
 * Create the campaign, paused, in one atomic provider request.
 *
 * @param {object}   args
 * @param {ObjectId} args.companyId
 * @param {object}   args.plan            an APPROVED plan, as stored
 * @param {string}   args.idempotencyKey  supplied by the caller
 * @param {object}   args.requestedBy     `{ id, name, role }`
 * @param {object}   args.authorizedBy    `{ id, name, at }` — the deployment decision
 * @param {object}   [deps]               `{ transport, googleAds }` for tests
 */
async function createPaused({
  companyId, plan, idempotencyKey, requestedBy, authorizedBy,
  expectedTargetingFingerprint = null, env = process.env,
}, deps = {}) {
  const bundle = deps.bundleClient || bundleClient;

  /* ── 1. THE PLAN IS APPROVED ────────────────────────────────────────────
     Checked here as well as by the route, because this function spends money
     and a second caller may arrive by a different path. */
  if (str(plan?.state) !== "approved") {
    throw fail("CAMPAIGN_DRAFT_STATE_CONFLICT",
      "Only an approved campaign plan can be created in an advertising account.",
      { field: "state" });
  }
  if (!str(idempotencyKey)) {
    throw fail("VALIDATION",
      "A creation needs a request identity, so a retry continues this creation instead of making a second campaign.",
      { field: "idempotencyKey" });
  }

  /* ── 2. WHICH ACCOUNT, DECIDED BY A PERSON ────────────────────────────── */
  const bound = await binding.forDeployment({ companyId, channel: "google_ads" });

  /* ── 3. PREFLIGHT, READING ONLY — AND IT RESOLVES THE TARGETING ───────── */
  const pre = await preflightService.preflight({ companyId, plan }, deps);
  if (!pre.creationReady) {
    throw fail("CAMPAIGN_DEPLOYMENT_NOT_READY",
      "This campaign is not ready to be created. Nothing was sent to the advertising account.",
      { blockers: pre.creationBlockers, targeting: pre.targeting });
  }

  const resolution = pre.__resolution;
  if (!resolution || resolution.complete !== true) {
    throw fail("CAMPAIGN_DEPLOYMENT_NOT_READY",
      "GRAV could not resolve this campaign's locations and languages, so it will not create it. A campaign created without them is shown everywhere.",
      { blockers: resolution?.blockers || [] });
  }

  const fence = {
    campaignDraftId: String(plan._id),
    draftRef: str(plan.draftRef),
    approvedRevision: Number(plan.revision),
    externalAccountId: str(bound.externalAccountId),
    bindingId: String(bound.bindingId || ""),
    bindingRevision: Number(bound.bindingRevision) || 0,
  };
  if (!targeting.sameFence(resolution.resolvedFor, fence)) {
    throw fail("CAMPAIGN_DEPLOYMENT_NOT_READY",
      "The resolved targeting belongs to a different plan revision or a different advertising account. Run the preflight again before creating anything.",
      { field: "targeting" });
  }
  if (str(expectedTargetingFingerprint)
    && str(expectedTargetingFingerprint) !== str(resolution.fingerprint)) {
    throw fail("CAMPAIGN_DEPLOYMENT_NOT_READY",
      "The plan's targeting has changed since it was checked. Look at the preflight again before creating anything.",
      { field: "targetingFingerprint" });
  }

  /* ── 4. THE MAPPING ───────────────────────────────────────────────────── */
  const mapped = mapper.map({
    plan,
    account: {
      currency: pre.account.currency,
      timeZone: pre.account.timeZone,
      externalAccountId: bound.externalAccountId,
    },
    resolvedTargeting: resolution,
  });
  if (!mapped.mappable) {
    throw fail("CAMPAIGN_DEPLOYMENT_NOT_READY",
      "This campaign plan cannot be turned into a Google Search campaign. Nothing was sent to the advertising account.",
      { blockers: mapped.problems });
  }

  /* ── 5. THE MARKER, BEFORE ANYTHING IS WRITTEN ANYWHERE ─────────────────
     Derived from the command's immutable identity: this company, this binding,
     this account, this plan revision, this request identity. Stable across a
     retry of the same command and different for every other command, which is
     precisely what makes a lost response recoverable rather than permanent. */
  const marker = markerFor({
    companyId: String(companyId),
    bindingId: String(bound.bindingId || ""),
    externalAccountId: bound.externalAccountId,
    campaignDraftId: String(plan._id),
    approvedRevision: plan.revision,
    commandKey: str(idempotencyKey),
    channel: "google_ads",
    campaignType: "google_search",
  }, env);

  /* ── 6. THE DEPLOYMENT RECORD, CARRYING IT ─────────────────────────────── */
  const deployment = await deploymentFor({ companyId, plan, idempotencyKey, authorizedBy, marker });

  const outstanding = await attempts.hasUnresolvedAttempt({ companyId, deploymentId: deployment._id });
  if (outstanding.unresolved) {
    /* ── AT MOST ONE PROVIDER WRITE WHILE THE OUTCOME IS UNKNOWN ─────────
       This is the line that guarantees it. A second bundle would create a
       second complete campaign on top of one that may already exist. */
    throw fail("CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED",
      "An earlier attempt for this campaign was recorded as started and GRAV never learned how it ended. The advertising account has to be reconciled against that attempt before anything else is created.",
      {
        field: "attempt",
        attemptNos: outstanding.attempts.map((a) => a.attemptNo),
        deploymentMarker: marker,
      });
  }
  if (deployment.state === "paused_confirmed" || deployment.externalObjects?.length) {
    throw fail("CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED",
      "This plan revision has already been created in the advertising account.",
      { field: "deployment" });
  }

  /* ── 7. THE INTENT, BEFORE ANYTHING LEAVES THE PROCESS ─────────────────── */
  const begun = await attempts.begin({
    companyId,
    deploymentId: deployment._id,
    commandKey: str(idempotencyKey),
    approvedRevision: plan.revision,
    channel: "google_ads",
    campaignType: "google_search",
    requestedBy,
    authorizedBy,
    deploymentMarker: marker,
    plannedObjects: mapped.mapping.objects.map((o) => ({
      role: o.role,
      ...(o.payload?.location?.geoTargetConstant
        ? { target: o.payload.location.geoTargetConstant, negative: o.negative === true }
        : {}),
      ...(o.payload?.language?.languageConstant
        ? { target: o.payload.language.languageConstant }
        : {}),
    })),
  });

  if (!begun.mayCallProvider) {
    return {
      created: false,
      disposition: begun.disposition,
      attemptNo: begun.intent.attemptNo,
      reason: begun.reason,
      deploymentMarker: marker,
      deployment: publicDeployment(await refresh(deployment._id)),
    };
  }

  const command = {
    customerId: bound.externalAccountId,
    loginCustomerId: bound.loginAccountId,
    marker,
    mapping: mapped.mapping,
    resolvedTargeting: resolution,
    requestId: String(begun.intent._id),
  };

  /* ── 8a. THE SAME ENVELOPE, CHECKED BY THE CHANNEL, CREATING NOTHING ────
     `validateOnly` is a flag on the real request, not a second approximate
     payload — so what the channel validates is byte-for-byte what it would
     create. A refusal here is the cheapest possible one: the attempt settles as
     a provider refusal with no external object claimed, and because nothing was
     created there is nothing to undo.

     Skippable only by a caller that has already validated this exact envelope;
     nothing in GRAV does that today. */
  if (deps.skipValidateOnly !== true) {
    try {
      await bundle.createPausedAtomic({ ...command, validateOnly: true }, deps);
    } catch (err) {
      const code = str(err?.code);
      if (REFUSAL_CODES.includes(code)) {
        return finishRefused({
          companyId, deployment, begun, marker, reasonCode: code,
          operatorNote: "The advertising channel refused this campaign when GRAV asked it to check the request. Nothing was created.",
        });
      }
      /* A validation pass GRAV could not complete tells it nothing about the
         account, and it created nothing either — so the attempt is settled as a
         failure rather than left unresolved. Distinguished from a lost CREATE,
         which is the dangerous one. */
      return finishRefused({
        companyId, deployment, begun, marker, reasonCode: code || "CHANNEL_UNAVAILABLE",
        operatorNote: "GRAV could not reach the advertising channel to check this campaign. Nothing was created.",
      });
    }
  }

  /* ── 8b. THE ONE WRITE ──────────────────────────────────────────────────
     All of it, or none of it. There is no second call and no cleanup path. */
  let results;
  try {
    results = (await bundle.createPausedAtomic(command, deps)).results;
  } catch (err) {
    const code = str(err?.code);

    if (REFUSAL_CODES.includes(code)) {
      /* ── THE CHANNEL SAID NO ──────────────────────────────────────────
         The request was atomic, so nothing exists. No object is claimed and no
         compensating delete is attempted, because there is nothing to delete. */
      return finishRefused({
        companyId, deployment, begun, marker, reasonCode: code,
        operatorNote: "The advertising channel refused this campaign. Because the request was all-or-nothing, nothing was created.",
      });
    }

    /* ── GRAV NEVER LEARNED THE OUTCOME ───────────────────────────────── */
    return finishUnresolved({
      companyId, deployment, begun, marker,
      reasonCode: code === "CHANNEL_RATE_LIMITED" ? "CHANNEL_RATE_LIMITED" : "RESPONSE_LOST",
    });
  }

  /* ── 9. READ IT BACK BEFORE CALLING IT DONE ─────────────────────────────
     A successful mutate response is what GRAV SENT, echoed. It is not evidence
     that the campaign is stopped, that the exclusion is an exclusion, or that
     the marker is attached. Those come from a separate read, by marker, against
     the bound account — which is also what proves the objects are in the right
     account and belong to this approved revision, since the marker is derived
     from both. */
  const readAt = new Date();
  const verdict = await reconciler.inspect({
    bound, marker, mapping: mapped.mapping, resolvedTargeting: resolution,
  }, deps);

  if (verdict.outcome !== "one_complete_bundle") {
    /* ── ACCEPTED, BUT NOT CONFIRMED ──────────────────────────────────────
       The channel said yes and the read-back does not agree — or could not be
       made. Objects exist that GRAV cannot fully vouch for, so this is recorded
       with every identifier the response gave and sent to a person. It is NOT
       settled as success, and it is NOT rolled back on the strength of a read
       that may itself be wrong. */
    return finishUnconfirmed({
      companyId, deployment, begun, marker, results, verdict, readAt,
      resolvedTargeting: resolution,
    });
  }

  const objects = reconciler.evidenceFrom({
    found: verdict.found, resolvedTargeting: resolution, readAt,
  }).map((o) => ({
    ...o,
    /* GRAV watched these appear: it made the request and got the identifiers
       back. A reconciliation after a lost response records `observed`. */
    origin: "created",
  }));

  const settled = await attempts.settle({
    companyId,
    intentId: begun.intent._id,
    outcome: "succeeded",
    reasonCode: "CREATED_AND_CONFIRMED_STOPPED",
    objects,
    now: readAt,
  });

  await rollUp({ deployment, objects, state: "paused_confirmed", confirmedAt: readAt });

  return {
    created: true,
    disposition: begun.disposition,
    attemptNo: begun.intent.attemptNo,
    outcome: "succeeded",
    deploymentMarker: marker,
    providerCampaignId: verdict.campaign?.providerCampaignId || null,
    deliveryObjectsNonDeliveringConfirmed: settled.result.deliveryObjectsNonDeliveringConfirmed,
    targetingConfirmed: true,
    targeting: pre.targeting,
    decisions: mapped.decisions,
    deployment: publicDeployment(await refresh(deployment._id)),
  };
}

/**
 * The channel completed the request and refused it.
 *
 * ── NO OBJECT IS CLAIMED AND NOTHING IS UNDONE ─────────────────────────────
 * Both follow from the request being atomic. A refusal means none of the bundle
 * was applied, so recording an external object would be inventing one, and a
 * compensating delete would be deleting something that does not exist.
 */
async function finishRefused({ companyId, deployment, begun, marker, reasonCode, operatorNote }) {
  await attempts.settle({
    companyId,
    intentId: begun.intent._id,
    outcome: "failed",
    reasonCode,
    operatorNote,
    objects: [],
  });

  await rollUp({ deployment, objects: [], state: "failed", confirmedAt: null });

  return {
    created: false,
    disposition: begun.disposition,
    attemptNo: begun.intent.attemptNo,
    outcome: "failed",
    reasonCode,
    deploymentMarker: marker,
    /* Stated rather than left to inference: there is no rollback here because
       there was nothing to roll back. */
    rollback: {
      attempted: false,
      complete: true,
      means: "The request was all-or-nothing and the advertising channel refused it, so nothing was created and nothing needed removing.",
    },
    deployment: publicDeployment(await refresh(deployment._id)),
  };
}

/**
 * GRAV never learned the outcome.
 *
 * ── NOTHING IS RETRIED, REMOVED OR ASSUMED ─────────────────────────────────
 * The bundle may have been applied in full. Retrying creates a second complete
 * campaign; removing "what GRAV thinks it created" removes objects GRAV cannot
 * name; and treating an immediate absence as proof of failure is the same
 * mistake with an extra step, because a channel's reads can lag its writes.
 *
 * The attempt stays UNRESOLVED — no result row — which is what makes the next
 * creation refuse. Recovery is by marker, read-only, and it is not automatic.
 */
async function finishUnresolved({ companyId, deployment, begun, marker, reasonCode }) {
  await MarketingCampaignDeployment.updateOne(
    { _id: deployment._id, companyId: deployment.companyId },
    { $set: { state: "partially_created", deploymentMarker: marker } },
  );

  return {
    created: false,
    disposition: begun.disposition,
    attemptNo: begun.intent.attemptNo,
    outcome: "unknown",
    reasonCode,
    unresolved: true,
    deploymentMarker: marker,
    rollback: {
      attempted: false,
      complete: false,
      means: "Nothing was removed. The request was all-or-nothing and GRAV did not get an answer to it, so the campaign may exist in full.",
    },
    reason: "GRAV did not learn how this creation ended. The whole campaign may exist in the advertising account, or none of it may. Nothing else can be created for this plan until somebody reconciles the account against this attempt.",
    requiresReconciliation: true,
    reconcileBy: {
      /* The string that answers the question, handed to whoever has to ask it. */
      deploymentMarker: marker,
      means: "Look for this marker as a label in the advertising account. A campaign carrying it was created by this exact request; a campaign with a matching NAME proves nothing.",
    },
    deployment: publicDeployment(await refresh(deployment._id)),
  };
}

/**
 * The channel accepted it, and the read-back does not confirm it.
 *
 * Objects exist — the response named them — but GRAV cannot vouch for their
 * state, their targeting or the marker. Every identifier is recorded so a person
 * can find them, and nothing is settled as success.
 */
async function finishUnconfirmed({ companyId, deployment, begun, marker, results, verdict, readAt, resolvedTargeting }) {
  void resolvedTargeting;

  /* Built from the RESPONSE, which is the only thing GRAV is sure of here: the
     channel named these resource identifiers. Nothing is claimed about their
     state, because the read that would have established it is the one that
     failed or disagreed. */
  const ROLE_OF = Object.freeze({
    marker_label: null,
    marker_relationship: null,
    budget: "budget",
    campaign: "campaign",
    audience_group: "audience_group",
    advertisement: "advertisement",
    targeting_term: "targeting_term",
    targeting_criterion: "location_target",
  });

  const objects = results
    .map((r) => ({ role: ROLE_OF[r.role], providerObjectId: r.providerObjectId, resourceName: r.resourceName }))
    .filter((r) => r.role)
    .map((r) => {
      const applies = GOOGLE_SEARCH_OBJECT_BY_CODE[r.role]?.deliveryStateApplies === true;
      const isCriterion = r.role === "location_target" || r.role === "language_target";
      return {
        role: r.role,
        providerObjectId: r.providerObjectId,
        providerObjectType: r.resourceName,
        origin: "created",
        deliveryStateApplies: applies,
        /* Nothing was confirmed. False, not true — and not null for the ones
           that DO have a delivery state, because GRAV did ask and did not get
           an answer it could use. */
        nonDeliveringConfirmed: applies ? false : null,
        stateReadAt: null,
        observedState: "",
        negative: isCriterion ? null : null,
        negativeConfirmed: null,
      };
    });

  await attempts.settle({
    companyId,
    intentId: begun.intent._id,
    outcome: "partially_created",
    reasonCode: verdict.outcome === "provider_unavailable"
      ? "CREATED_BUT_READ_BACK_UNAVAILABLE"
      : "CREATED_BUT_READ_BACK_DISAGREED",
    operatorNote: [
      "The advertising channel accepted this campaign and named the objects it created.",
      verdict.detail || verdict.outcomeMeans,
      "It has NOT been confirmed stopped or correctly targeted, so somebody has to look at it in the advertising channel before it is started.",
    ].filter(Boolean).join(" "),
    objects,
    now: readAt,
  });

  await rollUp({ deployment, objects, state: "partially_created", confirmedAt: null });

  return {
    created: true,
    disposition: begun.disposition,
    attemptNo: begun.intent.attemptNo,
    outcome: "partially_created",
    deploymentMarker: marker,
    targetingConfirmed: false,
    deliveryObjectsNonDeliveringConfirmed: false,
    requiresReconciliation: true,
    reconciliation: reconciler.publicVerdict(verdict),
    deployment: publicDeployment(await refresh(deployment._id)),
  };
}

/**
 * Reconcile an unresolved attempt against the advertising account, read-only.
 *
 * ── THE ONLY WAY AN UNRESOLVED ATTEMPT EVER CLOSES ─────────────────────────
 * And it closes exactly one way: a complete, stopped, correctly targeted bundle
 * carrying this deployment's marker. Everything else leaves it open — an empty
 * answer (the channel's reads may lag its writes), an outage, a bundle that does
 * not match, or several campaigns wearing the same marker.
 *
 * It performs no provider write. `bundleReconciliation` has no access to the
 * bundle client, and this function passes it none.
 */
async function reconcile({ companyId, plan }, deps = {}) {
  const bound = await binding.forDeployment({ companyId, channel: "google_ads" });

  const deployment = await MarketingCampaignDeployment.findOne({
    companyId, campaignDraftId: plan._id, channel: "google_ads",
  }).sort({ approvedRevision: -1 });

  if (!deployment) {
    throw fail("NOT_FOUND",
      "Nothing has been created in the advertising account for this plan, so there is nothing to reconcile.",
      { field: "deployment" });
  }

  const outstanding = await attempts.hasUnresolvedAttempt({ companyId, deploymentId: deployment._id });
  if (!outstanding.unresolved) {
    return {
      reconciled: false,
      outcome: "nothing_outstanding",
      means: "Every attempt for this deployment already has a recorded outcome. There is nothing waiting to be reconciled.",
      deployment: publicDeployment(await refresh(deployment._id)),
    };
  }

  const intent = await MarketingCampaignDeploymentAttemptIntent
    .findOne({ companyId, deploymentId: deployment._id, attemptNo: outstanding.attempts[0].attemptNo });

  const marker = str(intent?.deploymentMarker) || str(deployment.deploymentMarker);
  if (!marker) {
    throw fail("CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED",
      "This attempt carries no deployment marker, so GRAV cannot prove which campaign, if any, it created. Somebody has to check the advertising account by hand.",
      { field: "deploymentMarker" });
  }

  /* The plan and its resolved targeting as they were APPROVED, so the
     comparison is against the command rather than against whatever the plan
     says today. The fence in `resolve` refuses a mismatch. */
  const pre = await preflightService.preflight({ companyId, plan }, deps);
  const resolution = pre.__resolution;
  const mapped = mapper.map({
    plan,
    account: {
      currency: pre.account.currency,
      timeZone: pre.account.timeZone,
      externalAccountId: bound.externalAccountId,
    },
    resolvedTargeting: resolution,
  });

  if (!mapped.mappable) {
    throw fail("CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED",
      "GRAV cannot rebuild what this attempt was supposed to create, so it cannot prove whether the advertising account matches it. Somebody has to check by hand.",
      { field: "plan" });
  }

  const verdict = await reconciler.inspect({
    bound, marker, mapping: mapped.mapping, resolvedTargeting: resolution,
  }, deps);

  const outcome = await reconciler.settleIfComplete({
    companyId, intent, verdict, resolvedTargeting: resolution,
  });

  if (outcome.settled) {
    await rollUp({
      deployment,
      objects: outcome.objects,
      state: "paused_confirmed",
      confirmedAt: new Date(),
    });
  }

  return {
    reconciled: outcome.settled === true,
    /* Idempotent: a second reconciliation of a settled attempt finds the result
       already there rather than writing a second account of one attempt. */
    duplicate: outcome.duplicate === true,
    attemptNo: intent.attemptNo,
    deploymentMarker: marker,
    ...reconciler.publicVerdict(verdict),
    deployment: publicDeployment(await refresh(deployment._id)),
  };
}


/* ── THE ROLLUP ─────────────────────────────────────────────────────────────
   The deployment's current view of what exists externally, written from the
   same evidence the attempt was settled with. */
async function rollUp({ deployment, objects, state, confirmedAt }) {
  await MarketingCampaignDeployment.updateOne(
    { _id: deployment._id, companyId: deployment.companyId },
    {
      $set: {
        state,
        externalObjects: objects.map((o) => ({
          role: o.role,
          providerObjectId: o.providerObjectId,
          providerObjectType: o.providerObjectType || "",
          deliveryStateApplies: o.deliveryStateApplies,
          nonDeliveringConfirmed: o.nonDeliveringConfirmed ?? null,
          stateReadAt: o.stateReadAt || null,
          observedState: o.observedState || "",
          displayName: o.displayName || "",
          requestedName: o.requestedName || "",
          negative: o.negative ?? null,
          negativeConfirmed: o.negativeConfirmed ?? null,
          createdAt: new Date(),
        })),
        deliveryObjectsNonDeliveringConfirmedAt: confirmedAt,
      },
    },
  );
}

const refresh = (id) => MarketingCampaignDeployment.findById(id).lean();

/* ── THE PUBLIC VIEW ────────────────────────────────────────────────────────
   Field by field. Provider ids ARE included — an operator reconciling against
   Google Ads needs them, and they are shown on every Google screen — but no
   request payload, no provider error and no account credential is. */
function publicDeployment(doc) {
  if (!doc) return null;
  return {
    draftRef: doc.draftRef,
    approvedRevision: doc.approvedRevision,
    channel: doc.channel,
    campaignType: doc.campaignType,
    state: doc.state,
    externalObjects: (doc.externalObjects || []).map((o) => ({
      role: o.role,
      providerObjectId: o.providerObjectId,
      deliveryStateApplies: o.deliveryStateApplies,
      nonDeliveringConfirmed: o.nonDeliveringConfirmed ?? null,
      stateReadAt: o.stateReadAt || null,
      observedState: o.observedState || "",
      /* The author's word beside the channel's number, and whether the place was
         targeted or avoided. Both are what a person reconciles with. */
      displayName: o.displayName || null,
      requestedName: o.requestedName || null,
      negative: o.negative ?? null,
      negativeConfirmed: o.negativeConfirmed ?? null,
    })),
    deliveryObjectsNonDeliveringConfirmedAt: doc.deliveryObjectsNonDeliveringConfirmedAt || null,
    /* The string a person reconciles with. Not a secret — it is a label on a
       campaign in an account they can already open — and useless without that
       account. */
    deploymentMarker: doc.deploymentMarker || null,
    /* Always null in this chunk, and present so a reader can see it is. */
    activatedAt: doc.activatedAt || null,
    createdStatus: NON_DELIVERING_STATUS,
  };
}

module.exports = {
  /* The record-keeping steps, shared with the lead-form orchestrator so there
     is one account of how a deployment record and its rollup are written. */
  __internals: {
    deploymentFor, finishRefused, finishUnresolved, rollUp, refresh, REFUSAL_CODES,
  },
  createPaused,
  /* Read-only recovery for an attempt GRAV never learned the outcome of. */
  reconcile,
  publicDeployment,
  NON_DELIVERING_STATUSES,
};
