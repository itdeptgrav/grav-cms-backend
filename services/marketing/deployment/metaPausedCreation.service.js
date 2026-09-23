// services/marketing/deployment/metaPausedCreation.service.js
//
// CREATE ONE META CAMPAIGN, STOPPED, ONE STEP AT A TIME, EVIDENCE AS IT GOES.
//
// ── WHY THIS IS NOT THE GOOGLE PATH ────────────────────────────────────────
// The Google path is one atomic request because `GoogleAdsService.Mutate`
// applies a cross-resource operation list all-or-nothing. Meta has no
// documented equivalent. `/batch` with `depends_on` is request batching with
// dependency resolution — each operation is evaluated independently, and a
// failure part-way leaves earlier ones applied. Calling that atomic would be
// claiming a guarantee the platform does not give.
//
// So this is a SEQUENCE, and the discipline that makes a sequence survivable is
// the one thing that must never be relaxed: **every confirmed result is written
// to GRAV's durable record before the next call is made.** A process that dies
// between two calls leaves behind an exact list of what exists.
//
// ── FIVE STEPS, IN THIS ORDER, FOR DOCUMENTED REASONS ──────────────────────
//   1. Upload the approved image      — the creative needs the channel's hash
//   2. Create the campaign, stopped   — the ad set needs its id
//   3. Create the ad set, stopped     — the ad needs its id
//   4. Create the creative            — the ad needs its id; it has no status
//   5. Create the advertisement, stopped
//
// The image is first deliberately. It is the only step that is not a campaign
// object: if the bytes are refused, nothing structural has been created and the
// attempt settles with no external object at all.
//
// ── WHAT HAPPENS WHEN IT GOES WRONG ────────────────────────────────────────
// A refusal: stop, record `partially_created` with every confirmed identifier,
// claim no rollback, delete nothing, require reconciliation.
//
// A lost response: stop, record the attempt as UNRESOLVED, require
// reconciliation, and refuse every further creation for this deployment. No
// retry, no next write, no deletion — a request that timed out may have
// succeeded, and everything GRAV created is stopped and therefore inert.
//
// ── AND NOTHING IS EVER DELETED ────────────────────────────────────────────
// Deliberate. Cleanup means issuing more writes into an account GRAV has just
// proved it does not understand, and a delete that itself fails makes the
// evidence worse. Inert and recorded beats tidied-up and uncertain.
"use strict";

const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
const attempts = require("../campaignDrafts/deploymentAttempt.service");
const binding = require("./accountBinding.service");
const mapper = require("./metaTrafficMapper");
const preflightService = require("./metaPreflight.service");
const targeting = require("./metaTargetingResolution.service");
const writeClient = require("../channels/metaAdsWriteClient");
const advertisingAssets = require("../assets/advertisingAsset.service");
const { markerFor } = require("./deploymentMarker");
const {
  MarketingCampaignDeployment,
} = require("../../../models/CMS_Models/Marketing/MarketingCampaignDeployment");
const {
  MarketingCampaignDeploymentAttemptIntent,
} = require("../../../models/CMS_Models/Marketing/MarketingCampaignDeploymentAttempt");
const {
  META_OBJECT_BY_CODE,
  CREATION_ORDER,
} = require("../../../constants/marketingMetaDeployment");

const str = (v) => String(v ?? "").trim();

/* ── THE CHANNEL ANSWERED, AND THE ANSWER WAS NO ────────────────────────────
   These mean the request COMPLETED with a refusal, so GRAV knows that call had
   no effect. Anything else means it does not know, and the attempt stays open —
   which is the difference between `partially_created` and unresolved. */
const REFUSAL_CODES = Object.freeze([
  "CHANNEL_ACCESS_REFUSED",
  "CHANNEL_MALFORMED_RESPONSE",
  "CHANNEL_UNSUPPORTED_OPERATION",
  "VALIDATION",
  "INTERNAL",
]);

/** Find or create the deployment record for one approved plan revision. */
async function deploymentFor({ companyId, plan, idempotencyKey, authorizedBy, marker }) {
  const selector = {
    companyId,
    campaignDraftId: plan._id,
    approvedRevision: plan.revision,
    channel: "meta_ads",
  };

  const existing = await MarketingCampaignDeployment.findOne(selector);
  if (existing) {
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
      campaignType: "meta_traffic_single_image",
      idempotencyKey: str(idempotencyKey),
      deploymentMarker: str(marker),
      state: "preparing",
      deploymentApprovedBy: authorizedBy,
    });
  } catch (err) {
    if (err?.code !== 11000) throw err;
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

/* ── EVIDENCE, APPENDED AS IT IS CONFIRMED ──────────────────────────────────
   Called after EVERY confirmed operation and before the next one starts. This
   is the entire recovery story for a non-atomic sequence: whatever happens
   next, GRAV's record already names what exists.

   It writes the rollup rather than the attempt result, because the attempt is
   settled once at the end — the rollup is the running tally. */
async function recordConfirmed({ deployment, confirmed, marker }) {
  await MarketingCampaignDeployment.updateOne(
    { _id: deployment._id, companyId: deployment.companyId },
    {
      $set: {
        state: "partially_created",
        deploymentMarker: str(marker),
        externalObjects: confirmed.map((c) => ({
          role: c.role,
          providerObjectId: c.providerObjectId,
          providerObjectType: c.providerNode || "",
          deliveryStateApplies: META_OBJECT_BY_CODE[c.role]?.deliveryStateApplies === true,
          /* Sent stopped, NOT yet read back. Confirmed only by the read-back
             at the end of the sequence. */
          nonDeliveringConfirmed: META_OBJECT_BY_CODE[c.role]?.deliveryStateApplies === true ? false : null,
          stateReadAt: null,
          observedState: "",
          displayName: c.displayName || "",
          requestedName: "",
          negative: null,
          negativeConfirmed: null,
          createdAt: new Date(),
        })),
      },
    },
  );
}

const refresh = (id) => MarketingCampaignDeployment.findById(id).lean();

/**
 * Create the campaign, stopped.
 *
 * @param {object}   args
 * @param {ObjectId} args.companyId
 * @param {object}   args.plan               an APPROVED plan, as stored
 * @param {number}   args.expectedRevision   the exact approved revision
 * @param {string}   args.idempotencyKey
 * @param {object}   args.requestedBy
 * @param {object}   args.authorizedBy
 */
async function createPaused({
  companyId, plan, expectedRevision, idempotencyKey, requestedBy, authorizedBy,
  expectedTargetingFingerprint = null, env = process.env,
}, deps = {}) {
  const writer = deps.metaWriteClient || writeClient;

  /* ── 1. THE PLAN, AND THE EXACT REVISION SOMEBODY APPROVED ──────────────
     The revision is REQUIRED, not inferred. A caller that does not name it is
     asking GRAV to deploy whatever the plan says now, and "now" may be after an
     edit that the approval never covered. */
  if (str(plan?.state) !== "approved") {
    throw fail("CAMPAIGN_DRAFT_STATE_CONFLICT",
      "Only an approved campaign plan can be created in an advertising account.",
      { field: "state" });
  }
  if (!Number.isInteger(expectedRevision)) {
    throw fail("VALIDATION",
      "A creation names the exact approved plan revision it is of.",
      { field: "expectedRevision" });
  }
  if (Number(plan.revision) !== expectedRevision) {
    throw fail("CAMPAIGN_DRAFT_REVISION_CONFLICT",
      "The plan has changed since that revision was approved. Look at it again before creating anything.",
      { field: "expectedRevision" });
  }
  if (!str(idempotencyKey)) {
    throw fail("VALIDATION",
      "A creation needs a request identity, so a retry continues this creation instead of making a second campaign.",
      { field: "idempotencyKey" });
  }

  /* ── 2. WHICH ACCOUNT, DECIDED BY A PERSON ────────────────────────────── */
  const bound = await binding.forDeployment({ companyId, channel: "meta_ads" });

  /* ── 3. PREFLIGHT: ACCOUNT, TARGETING, AUDIENCE, IMAGE, EVERYTHING ────── */
  const pre = await preflightService.preflight({ companyId, plan }, deps);
  if (!pre.creationReady) {
    throw fail("CAMPAIGN_DEPLOYMENT_NOT_READY",
      "This campaign is not ready to be created. Nothing was sent to the advertising account.",
      { blockers: pre.creationBlockers });
  }

  const resolution = pre.__resolution;
  const audience = pre.__audience;
  const asset = pre.__asset;

  if (!resolution?.complete || !audience?.complete || !asset?.ready) {
    /* Unreachable while `creationReady` accounts for all three. Present because
       the consequence of it becoming reachable is a live campaign with no
       audience, no targeting or no image. */
    throw fail("CAMPAIGN_DEPLOYMENT_NOT_READY",
      "GRAV could not confirm this campaign's targeting, audience and image, so it will not create it.",
      { field: "preflight" });
  }

  /* ── THE FENCE ──────────────────────────────────────────────────────────
     The resolution belongs to this plan revision and this binding revision. A
     rebind — even to the same account, after a failed verification — is a new
     decision, and targeting confirmed under the old one belongs to the old one. */
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
      "The plan's audience or targeting has changed since it was checked. Look at the preflight again before creating anything.",
      { field: "targetingFingerprint" });
  }

  /* ── 4. THE IMAGE, BY ITS EXACT APPROVED VERSION ────────────────────────
     `forDeployment` refuses anything that is not an approved, current version
     of this company's. The bytes are read separately and re-hashed against the
     approved version every time. */
  const brief = (plan.deploymentBriefs || []).find((b) => b.channel === "meta_ads");
  const approvedAsset = await advertisingAssets.forDeployment({
    companyId, assetId: str(brief.advertisingAssetId), env,
  });

  /* ── 5. THE MAPPING ─────────────────────────────────────────────────────── */
  const mapped = mapper.map({
    plan,
    account: {
      currency: pre.account.currency,
      timeZone: pre.account.timeZone,
      externalAccountId: bound.externalAccountId,
    },
    resolvedTargeting: resolution,
    creativeAsset: asset,
    trackingIdentity: pre.tracking.identity || "",
    audience,
  });
  if (!mapped.mappable) {
    throw fail("CAMPAIGN_DEPLOYMENT_NOT_READY",
      "This campaign plan cannot be turned into a Meta campaign. Nothing was sent to the advertising account.",
      { blockers: mapped.problems });
  }

  /* ── 6. THE MARKER, BEFORE ANYTHING IS WRITTEN ANYWHERE ─────────────────
     Derived from the command's immutable identity. Stable across a retry of the
     same command, different for every other command. */
  const marker = markerFor({
    companyId: String(companyId),
    bindingId: String(bound.bindingId || ""),
    externalAccountId: bound.externalAccountId,
    campaignDraftId: String(plan._id),
    approvedRevision: plan.revision,
    commandKey: str(idempotencyKey),
    channel: "meta_ads",
    campaignType: "meta_traffic_single_image",
  }, env);

  /* ── 7. THE DEPLOYMENT RECORD ───────────────────────────────────────────── */
  const deployment = await deploymentFor({ companyId, plan, idempotencyKey, authorizedBy, marker });

  const outstanding = await attempts.hasUnresolvedAttempt({ companyId, deploymentId: deployment._id });
  if (outstanding.unresolved) {
    /* ── AT MOST ONE SEQUENCE WHILE THE OUTCOME IS UNKNOWN ────────────────
       Objects may exist that GRAV cannot name. Starting again would build a
       second campaign on top of a first that may be half-built. */
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

  /* ── 8. THE INTENT, BEFORE ANYTHING LEAVES THE PROCESS ──────────────────
     The command fingerprint covers the plan revision, the binding, the resolved
     targeting AND the exact image version — so the same key with a different
     image, a different audience or a different account is a different command
     rather than a retry. */
  const begun = await attempts.begin({
    companyId,
    deploymentId: deployment._id,
    commandKey: str(idempotencyKey),
    approvedRevision: plan.revision,
    channel: "meta_ads",
    campaignType: "meta_traffic_single_image",
    requestedBy,
    authorizedBy,
    deploymentMarker: marker,
    plannedObjects: [
      /* The image is part of the command's identity: swapping the picture is a
         different advertisement, however identical everything else is. */
      { role: "creative", target: `asset:${approvedAsset.sha256}` },
      ...mapped.plan.objects.map((o) => ({
        role: o.role,
        ...(o.role === "audience_group"
          ? {
            target: [
              ...o.describes.targeting.includedLocationKeys,
              ...o.describes.targeting.excludedLocationKeys.map((k) => `-${k}`),
              ...o.describes.targeting.localeKeys,
              `age:${o.describes.targeting.ageMin}-${o.describes.targeting.ageMax}`,
              `gender:${o.describes.targeting.genders}`,
            ].join(","),
          }
          : {}),
      })),
      { role: "campaign", target: `fence:${resolution.fingerprint}:${bound.bindingRevision}` },
    ],
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

  /* ── 9. THE SEQUENCE ────────────────────────────────────────────────────
     Each step confirmed and recorded before the next begins. */
  const confirmed = [];
  const ids = {};
  let providerImageHash = null;

  const stop = async (step, err) => {
    const code = str(err?.code);
    const known = REFUSAL_CODES.includes(code);
    if (known) {
      return finishRefused({
        companyId, deployment, begun, marker, confirmed,
        reasonCode: code, failedStep: step,
      });
    }
    return finishUnresolved({
      companyId, deployment, begun, marker, confirmed,
      reasonCode: code === "CHANNEL_RATE_LIMITED" ? "CHANNEL_RATE_LIMITED" : "RESPONSE_LOST",
      failedStep: step,
    });
  };

  /* ── STEP 1: THE EXACT APPROVED BYTES ────────────────────────────────────
     Read from the library, which re-hashes them against the approved version.
     GRAV never sends a channel image hash and never accepts one from a caller:
     the hash comes back from this upload and nowhere else. */
  try {
    const bytes = await advertisingAssets.readBytes({ companyId, assetId: str(brief.advertisingAssetId), env }, deps);
    const uploaded = await writer.uploadImage({
      accountId: bound.externalAccountId,
      buffer: bytes.buffer,
      fileName: bytes.fileName,
      sha256: bytes.sha256,
    }, deps);
    providerImageHash = uploaded.providerImageHash;

    confirmed.push({
      role: "creative_image",
      providerObjectId: providerImageHash,
      providerNode: "adimage",
      displayName: bytes.fileName,
      approvedSha256: bytes.sha256,
    });
    await recordConfirmed({ deployment, confirmed, marker });
  } catch (err) {
    return stop("image", err);
  }

  /* ── STEPS 2 TO 5: THE FOUR OBJECTS, IN ORDER ──────────────────────────── */
  for (const role of CREATION_ORDER) {
    const object = mapped.plan.objects.find((o) => o.role === role);
    const payload = { ...object.payload };

    /* Each step's link to the previous one, named in GRAV's vocabulary here and
       translated to the channel's field by the write client's table. */
    if (role === "audience_group") payload.campaign_id = ids.campaign;
    if (role === "creative") {
      /* ── THE HASH THE CHANNEL GAVE BACK, NOT ONE GRAV MADE UP ──────────── */
      payload.object_story_spec = {
        ...payload.object_story_spec,
        link_data: { ...payload.object_story_spec.link_data, image_hash: providerImageHash },
      };
    }
    if (role === "advertisement") {
      payload.adset_id = ids.audience_group;
      payload.creative = { creative_id: ids.creative };
    }

    try {
      const out = await writer.create({
        role,
        accountId: bound.externalAccountId,
        payload,
      }, deps);

      ids[role] = out.providerObjectId;
      confirmed.push({
        role,
        providerObjectId: out.providerObjectId,
        providerNode: META_OBJECT_BY_CODE[role]?.providerNode || "",
        displayName: object.describes?.name || "",
      });
      /* ── DURABLE BEFORE THE NEXT CALL ──────────────────────────────────── */
      await recordConfirmed({ deployment, confirmed, marker });
    } catch (err) {
      return stop(role, err);
    }
  }

  /* ── 10. READ IT ALL BACK BEFORE CALLING IT DONE ───────────────────────── */
  const reconciler = require("./metaReconciliation.service");
  const readAt = new Date();
  const verdict = await reconciler.inspect({
    bound, marker, mapped, audience, resolution, approvedAsset, confirmed,
  }, deps);

  if (verdict.outcome !== "one_complete_hierarchy") {
    return finishUnconfirmed({
      companyId, deployment, begun, marker, confirmed, verdict, readAt,
    });
  }

  const objects = reconciler.evidenceFrom({ found: verdict.found, confirmed, readAt, origin: "created" });

  const settled = await attempts.settle({
    companyId,
    intentId: begun.intent._id,
    outcome: "succeeded",
    reasonCode: "CREATED_AND_CONFIRMED_STOPPED",
    objects,
    now: readAt,
  });

  await MarketingCampaignDeployment.updateOne(
    { _id: deployment._id, companyId },
    {
      $set: {
        state: "paused_confirmed",
        externalObjects: objects.map(toRollup),
        deliveryObjectsNonDeliveringConfirmedAt: readAt,
      },
    },
  );

  return {
    created: true,
    disposition: begun.disposition,
    attemptNo: begun.intent.attemptNo,
    outcome: "succeeded",
    deploymentMarker: marker,
    providerCampaignId: ids.campaign,
    deliveryObjectsNonDeliveringConfirmed: settled.result.deliveryObjectsNonDeliveringConfirmed,
    targetingConfirmed: true,
    audience: pre.audience,
    decisions: mapped.decisions,
    deployment: publicDeployment(await refresh(deployment._id)),
  };
}

const toRollup = (o) => ({
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
});

/* ── THE OBJECTS GRAV IS SURE OF, AS ATTEMPT EVIDENCE ───────────────────────
   Built from the confirmed list — the channel named each of these — with
   nothing claimed about their state, because the read that would establish it
   is the one that did not happen or did not agree. */
const evidenceFromConfirmed = (confirmed) => confirmed
  .filter((c) => META_OBJECT_BY_CODE[c.role])
  .map((c) => {
    const applies = META_OBJECT_BY_CODE[c.role].deliveryStateApplies === true;
    return {
      role: c.role,
      providerObjectId: c.providerObjectId,
      providerObjectType: c.providerNode || "",
      origin: "created",
      deliveryStateApplies: applies,
      nonDeliveringConfirmed: applies ? false : null,
      stateReadAt: null,
      observedState: "",
      displayName: c.displayName || "",
    };
  });

/**
 * The channel completed a request and refused it.
 *
 * ── EVERYTHING ALREADY CREATED IS KEPT, AND NOTHING IS DELETED ─────────────
 * No rollback is attempted and none is claimed. Deleting means issuing more
 * writes into an account GRAV has just proved it does not understand, and a
 * delete that itself fails makes the evidence worse. Everything created is
 * stopped, so what remains is inert: it spends nothing and shows nothing.
 */
async function finishRefused({ companyId, deployment, begun, marker, confirmed, reasonCode, failedStep }) {
  const objects = evidenceFromConfirmed(confirmed);

  await attempts.settle({
    companyId,
    intentId: begun.intent._id,
    outcome: objects.length ? "partially_created" : "failed",
    reasonCode,
    operatorNote: [
      `The advertising channel refused this campaign at the ${failedStep.replace("_", " ")} step.`,
      objects.length
        ? `${objects.length} object(s) created before that point still exist in the account. They are stopped, so nothing is being shown and nothing can be spent.`
        : "Nothing had been created at that point.",
      "GRAV has not deleted anything: removing objects means more writes into an account it has just failed in, and a failed deletion would make this record less trustworthy than it is now.",
      "Somebody has to reconcile the account against this attempt.",
    ].join(" "),
    objects,
  });

  await MarketingCampaignDeployment.updateOne(
    { _id: deployment._id, companyId },
    {
      $set: {
        state: objects.length ? "partially_created" : "failed",
        externalObjects: objects.map(toRollup),
      },
    },
  );

  return {
    created: false,
    disposition: begun.disposition,
    attemptNo: begun.intent.attemptNo,
    outcome: objects.length ? "partially_created" : "failed",
    reasonCode,
    failedStep,
    deploymentMarker: marker,
    /* Stated rather than left to inference. */
    rollback: {
      attempted: false,
      complete: false,
      means: objects.length
        ? "Nothing was deleted. Everything GRAV created is stopped, so it shows nothing and spends nothing — and deleting would mean more writes into an account GRAV has just failed in."
        : "Nothing had been created, so there was nothing to remove.",
    },
    requiresReconciliation: objects.length > 0,
    objectsGravConfirmed: confirmed.map((c) => ({ role: c.role, providerObjectId: c.providerObjectId })),
    deployment: publicDeployment(await refresh(deployment._id)),
  };
}

/**
 * GRAV never learned the outcome of one step.
 *
 * ── STOP. NO NEXT WRITE, NO RETRY, NO DELETION. ────────────────────────────
 * The step may have succeeded. Continuing would build on an object GRAV cannot
 * name; retrying would create a second one; deleting would remove something
 * that may not exist or may be the only record of what happened.
 *
 * The attempt stays UNRESOLVED — no result row — which is what makes the next
 * creation refuse.
 */
async function finishUnresolved({ companyId, deployment, begun, marker, confirmed, reasonCode, failedStep }) {
  await MarketingCampaignDeployment.updateOne(
    { _id: deployment._id, companyId },
    {
      $set: {
        state: "partially_created",
        deploymentMarker: str(marker),
        externalObjects: evidenceFromConfirmed(confirmed).map(toRollup),
      },
    },
  );

  return {
    created: false,
    disposition: begun.disposition,
    attemptNo: begun.intent.attemptNo,
    outcome: "unknown",
    reasonCode,
    failedStep,
    unresolved: true,
    deploymentMarker: marker,
    rollback: {
      attempted: false,
      complete: false,
      means: "Nothing was deleted. GRAV did not get an answer to one step, so it does not know whether that object exists — and removing what it thinks it created could remove the wrong thing.",
    },
    reason: `GRAV did not learn how the ${failedStep.replace("_", " ")} step ended. Everything it had confirmed before that point is recorded below and is stopped. Nothing else can be created for this plan until somebody reconciles the account against this attempt.`,
    requiresReconciliation: true,
    objectsGravConfirmed: confirmed.map((c) => ({
      role: c.role,
      providerObjectId: c.providerObjectId,
      displayName: c.displayName || null,
    })),
    reconcileBy: {
      deploymentMarker: marker,
      means: "Look for this marker in the advertising account. A campaign carrying it was created by this exact request; a campaign with a matching NAME proves nothing.",
    },
    deployment: publicDeployment(await refresh(deployment._id)),
  };
}

/**
 * Every step succeeded and the read-back does not confirm it.
 *
 * Objects exist — the channel named them — but GRAV cannot vouch for their
 * state, their targeting, their audience or their image. Not settled as
 * success, and nothing is deleted on the strength of a read that may itself be
 * the thing that is wrong.
 */
async function finishUnconfirmed({ companyId, deployment, begun, marker, confirmed, verdict, readAt }) {
  const objects = evidenceFromConfirmed(confirmed);

  await attempts.settle({
    companyId,
    intentId: begun.intent._id,
    outcome: "partially_created",
    reasonCode: verdict.outcome === "provider_unavailable"
      ? "CREATED_BUT_READ_BACK_UNAVAILABLE"
      : "CREATED_BUT_READ_BACK_DISAGREED",
    operatorNote: [
      "The advertising channel accepted every step and named the objects it created.",
      verdict.detail || verdict.outcomeMeans,
      "It has NOT been confirmed stopped or correctly targeted, so somebody has to look at it in the advertising channel before it is started.",
    ].filter(Boolean).join(" "),
    objects,
    now: readAt,
  });

  await MarketingCampaignDeployment.updateOne(
    { _id: deployment._id, companyId },
    { $set: { state: "partially_created", externalObjects: objects.map(toRollup) } },
  );

  return {
    created: true,
    disposition: begun.disposition,
    attemptNo: begun.intent.attemptNo,
    outcome: "partially_created",
    deploymentMarker: marker,
    targetingConfirmed: false,
    deliveryObjectsNonDeliveringConfirmed: false,
    requiresReconciliation: true,
    reconciliation: require("./metaReconciliation.service").publicVerdict(verdict),
    deployment: publicDeployment(await refresh(deployment._id)),
  };
}

/**
 * Reconcile an unresolved attempt against the account, read-only.
 *
 * The only way an unresolved Meta attempt ever closes, and it closes exactly
 * one way: a complete, stopped, correctly targeted hierarchy carrying this
 * deployment's marker.
 */
async function reconcile({ companyId, plan }, deps = {}) {
  const reconciler = require("./metaReconciliation.service");
  const bound = await binding.forDeployment({ companyId, channel: "meta_ads" });

  const deployment = await MarketingCampaignDeployment.findOne({
    companyId, campaignDraftId: plan._id, channel: "meta_ads",
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

  const pre = await preflightService.preflight({ companyId, plan }, deps);
  const brief = (plan.deploymentBriefs || []).find((b) => b.channel === "meta_ads");
  const approvedAsset = str(brief?.advertisingAssetId)
    ? await advertisingAssets.forDeployment({ companyId, assetId: str(brief.advertisingAssetId) }).catch(() => null)
    : null;

  const mapped = mapper.map({
    plan,
    account: {
      currency: pre.account.currency,
      timeZone: pre.account.timeZone,
      externalAccountId: bound.externalAccountId,
    },
    resolvedTargeting: pre.__resolution,
    creativeAsset: pre.__asset,
    trackingIdentity: pre.tracking.identity || "",
    audience: pre.__audience,
  });

  if (!mapped.mappable) {
    throw fail("CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED",
      "GRAV cannot rebuild what this attempt was supposed to create, so it cannot prove whether the advertising account matches it. Somebody has to check by hand.",
      { field: "plan" });
  }

  /* What GRAV had confirmed before it stopped — the rollup it wrote after each
     step, which is the whole point of writing it there. */
  const confirmed = (deployment.externalObjects || []).map((o) => ({
    role: o.role, providerObjectId: o.providerObjectId, displayName: o.displayName,
  }));

  const verdict = await reconciler.inspect({
    bound, marker, mapped, audience: pre.__audience, resolution: pre.__resolution,
    approvedAsset, confirmed,
  }, deps);

  const outcome = await reconciler.settleIfComplete({ companyId, intent, verdict, confirmed });

  if (outcome.settled) {
    await MarketingCampaignDeployment.updateOne(
      { _id: deployment._id, companyId },
      {
        $set: {
          state: "paused_confirmed",
          externalObjects: outcome.objects.map(toRollup),
          deliveryObjectsNonDeliveringConfirmedAt: new Date(),
        },
      },
    );
  }

  return {
    reconciled: outcome.settled === true,
    duplicate: outcome.duplicate === true,
    attemptNo: intent.attemptNo,
    deploymentMarker: marker,
    ...reconciler.publicVerdict(verdict),
    deployment: publicDeployment(await refresh(deployment._id)),
  };
}

/* ── THE PUBLIC VIEW ────────────────────────────────────────────────────────
   Field by field. Provider object ids DO travel — a person reconciling against
   the advertising interface needs them and they are on every screen there — but
   no request payload, no channel error, no token and no storage identifier. */
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
      displayName: o.displayName || null,
    })),
    deliveryObjectsNonDeliveringConfirmedAt: doc.deliveryObjectsNonDeliveringConfirmedAt || null,
    deploymentMarker: doc.deploymentMarker || null,
    /* Always null in this slice, and present so a reader can see it is. */
    activatedAt: doc.activatedAt || null,
    createdStatus: META_OBJECT_BY_CODE.campaign.stoppedStatus,
  };
}

module.exports = {
  createPaused,
  reconcile,
  publicDeployment,
  evidenceFromConfirmed,
};
