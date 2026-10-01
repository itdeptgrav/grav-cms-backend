// services/marketing/deployment/leadFormPausedCreation.service.js
//
// CREATE ONE GOOGLE SEARCH CAMPAIGN WITH A LEAD FORM, STOPPED, ONCE — AND
// ONLY IN THE PROOF ACCOUNT.
//
// ── THE SEARCH PROTOCOL, WITH TWO MORE OBJECTS IN THE SAME REQUEST ─────────
// Everything that makes a Google Search creation safe applies unchanged, and
// the order is the same:
//
//   1. The plan is approved, and the caller names the approved revision.
//   2. The bound account — decided by a person — and preflight, reading only.
//      Preflight includes THE GATE: the bound account must be the one an
//      administrator named for proving lead forms.
//   3. The mapping, from the same resolution the preflight reported.
//   4. The deployment record for (plan, revision, channel), carrying the marker.
//   5. The delivery binding — GRAV's own row, the address Google will post to.
//   6. The attempt INTENT, written before anything leaves the process.
//   7. A validate-only pass of the exact envelope, then ONE atomic mutate:
//      budget, campaign, marker, ad group, ad, keywords, targeting, the form
//      and its link — all of it or none of it, every status PAUSED.
//   8. The read-back: the Search bundle by marker AND the form's link by
//      campaign, both stopped, before success is claimed.
//   9. The attempt settled, the deployment rolled up, and only then the
//      delivery binding told which form it now belongs to.
//
// ── AN UNKNOWN OUTCOME IS NEVER RETRIED ────────────────────────────────────
// Exactly as for Search: a lost response leaves the attempt unresolved, the
// next creation is refused, and recovery is by marker, read-only (`reconcile`).
//
// ── THE SECRET ─────────────────────────────────────────────────────────────
// The webhook key is derived here, placed in the command for the one request
// that needs it, and dropped. It is not stored, logged, returned, fingerprinted
// or recorded on the attempt; the attempt records roles and ids only.
"use strict";

const { fail } = require("../../storePurchase/errors");
const attempts = require("../campaignDrafts/deploymentAttempt.service");
const binding = require("./accountBinding.service");
const leadPreflight = require("./googleLeadFormPreflight.service");
const targeting = require("./targetingResolution.service");
const bundleClient = require("../channels/googleSearchBundle");
const googleAds = require("../channels/googleAdsClient");
const reconciler = require("./bundleReconciliation.service");
const searchCreation = require("./pausedCreation.service");
const leadBindings = require("../leads/leadDeliveryBinding.service");
const webhookKey = require("../leads/leadWebhookKey");
const { markerFor } = require("./deploymentMarker");
const G = require("../../../constants/marketingGoogleLeadForm");
const {
  MarketingCampaignDeployment,
} = require("../../../models/CMS_Models/Marketing/MarketingCampaignDeployment");
const {
  MarketingCampaignDeploymentAttemptIntent,
} = require("../../../models/CMS_Models/Marketing/MarketingCampaignDeploymentAttempt");
const {
  MarketingLeadDeliveryBinding,
} = require("../../../models/CMS_Models/Marketing/MarketingLeadDeliveryBinding");

const { deploymentFor, finishRefused, finishUnresolved, rollUp, refresh, REFUSAL_CODES } = searchCreation.__internals;
const { publicDeployment } = searchCreation;

const str = (v) => String(v ?? "").trim();
const NON_DELIVERING = Object.freeze(["PAUSED", "REMOVED"]);
const CAMPAIGN_TYPE = "google_lead_form";

/* ── THE FORM'S HALF OF THE READ-BACK ───────────────────────────────────────
   One link, typed LEAD_FORM, stopped, to one lead-form asset. Whether the form
   points at GRAV's address is reported separately: Google's read may not echo
   the delivery method, and "stopped" is what success means — the address is
   evidence about delivery, which the first real enquiry proves either way. */
async function inspectLeadForm({ bound, campaignId, deliveryUrl }, deps = {}) {
  const client = deps.googleAds || googleAds;
  let links;
  try {
    links = await client.readLeadFormLink({
      customerId: bound.externalAccountId, loginCustomerId: bound.loginAccountId, campaignId,
    });
  } catch {
    return { complete: false, outcome: "provider_unavailable", detail: "The advertising channel did not answer, so GRAV could not read the lead form back." };
  }
  if (links.length !== 1) {
    return {
      complete: false,
      outcome: links.length ? "multiple_lead_forms" : "lead_form_missing",
      detail: links.length
        ? `${links.length} lead forms are attached to this campaign. GRAV attached one.`
        : "No lead form is attached to the campaign GRAV created. It is not confirmed.",
    };
  }
  const [link] = links;
  const mismatches = [];
  if (link.fieldType !== "LEAD_FORM") mismatches.push("The form is not attached as a lead form.");
  if (link.assetType && link.assetType !== "LEAD_FORM") mismatches.push("The attached asset is not a lead form.");
  if (!NON_DELIVERING.includes(link.linkStatus)) mismatches.push(`The form's link is ${link.linkStatus || "in an unknown state"}, not stopped.`);
  const urlsRead = link.webhookUrls.length > 0;
  if (urlsRead && !link.webhookUrls.includes(deliveryUrl)) {
    mismatches.push("The form delivers somewhere other than the address GRAV prepared.");
  }
  if (mismatches.length) {
    return { complete: false, outcome: "lead_form_mismatched", detail: mismatches.join(" "), link };
  }
  return {
    complete: true,
    link,
    /* True only when Google's read echoed the address and it is GRAV's. */
    deliveryAddressConfirmed: urlsRead,
  };
}

/* The form's evidence, in the attempt's own shape. */
function leadFormEvidence({ campaignId, link, readAt, origin }) {
  return [
    {
      role: "lead_form",
      providerObjectId: link.assetId,
      providerObjectType: "LEAD_FORM",
      origin,
      /* An asset has no status of its own; the link carries it. */
      deliveryStateApplies: false,
    },
    {
      role: "lead_form_link",
      /* Google names a campaign-asset link by its parts. */
      providerObjectId: `${campaignId}~${link.assetId}~LEAD_FORM`,
      providerObjectType: "campaign_asset",
      origin,
      deliveryStateApplies: true,
      nonDeliveringConfirmed: true,
      stateReadAt: readAt,
      observedState: link.linkStatus,
    },
  ];
}

/* The binding row and the values delivery needs. The secret exists only in the
   returned object, for the one request, and is never written anywhere. */
async function prepareDelivery({ companyId, plan, deployment, idempotencyKey, requestedBy, base, env }) {
  const view = await leadBindings.prepare({
    companyId,
    plan,
    deploymentId: deployment._id,
    /* Derived from the creation's own key, so a retry of the creation finds the
       same binding — and therefore the same address and the same secret. */
    idempotencyKey: `${str(idempotencyKey)}:delivery`,
    actor: requestedBy ? { id: requestedBy.id, name: requestedBy.name } : null,
  });
  const row = await MarketingLeadDeliveryBinding.findOne({ companyId, bindingRef: view.__bindingRef });
  const identity = leadBindings.derivationIdentity(row);
  return {
    bindingRef: view.__bindingRef,
    url: leadPreflight.deliveryUrlFor(base, leadBindings.deliveryTokenFor(row, env)),
    secret: webhookKey.deriveWebhookKey({
      companyId: identity.companyId, bindingId: identity.bindingId, version: identity.version, env,
    }),
    payloadSchemaVersion: G.DELIVERY.PAYLOAD_SCHEMA_VERSION,
  };
}

/* Tell the binding which form it now serves. After confirmation only, and
   never allowed to turn a confirmed creation into a failure. */
async function bindDelivery({ companyId, bindingRef, assetId, campaignId }) {
  try {
    await leadBindings.attachProviderIdentity({ companyId, bindingRef, providerFormId: assetId, providerCampaignId: campaignId });
    return true;
  } catch (err) {
    console.error(`[lead-form-creation] delivery binding not updated: ${str(err?.code || "error")}`);
    return false;
  }
}

/**
 * Create the lead-form campaign, paused, in one atomic request.
 *
 * @param {object}   args
 * @param {ObjectId} args.companyId
 * @param {object}   args.plan              an APPROVED plan, as stored
 * @param {number}   args.expectedRevision  the approved revision the caller reviewed
 * @param {string}   args.idempotencyKey
 * @param {object}   args.requestedBy       `{ id, name, role }`
 * @param {object}   args.authorizedBy      `{ id, name, at }`
 */
async function createPaused({
  companyId, plan, expectedRevision, idempotencyKey, requestedBy, authorizedBy,
  expectedTargetingFingerprint = null, env = process.env,
}, deps = {}) {
  const bundle = deps.bundleClient || bundleClient;

  /* ── 1. APPROVED, AND THE REVISION THE CALLER REVIEWED ───────────────── */
  if (str(plan?.state) !== "approved") {
    throw fail("CAMPAIGN_DRAFT_STATE_CONFLICT",
      "Only an approved campaign plan can be created in an advertising account.", { field: "state" });
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision !== Number(plan.revision)) {
    throw fail("CAMPAIGN_DRAFT_REVISION_CONFLICT",
      "Say which approved revision you are creating, and it must be the one that was approved. Nothing was sent to the advertising account.",
      { field: "expectedRevision", currentRevision: Number(plan.revision) || null });
  }
  if (!str(idempotencyKey)) {
    throw fail("VALIDATION",
      "A creation needs a request identity, so a retry continues this creation instead of making a second campaign.",
      { field: "idempotencyKey" });
  }

  /* ── 2. THE ACCOUNT, AND PREFLIGHT — WHICH HOLDS THE GATE ─────────────── */
  const bound = await binding.forDeployment({ companyId, channel: "google_ads" });
  const pre = await leadPreflight.preflight({ companyId, plan, env }, deps);
  if (!pre.creationReady) {
    throw fail("CAMPAIGN_DEPLOYMENT_NOT_READY",
      "This lead-form campaign is not ready to be created. Nothing was sent to the advertising account.",
      { blockers: pre.creationBlockers });
  }

  const resolution = pre.__resolution;
  const fence = {
    campaignDraftId: String(plan._id),
    draftRef: str(plan.draftRef),
    approvedRevision: Number(plan.revision),
    externalAccountId: str(bound.externalAccountId),
    bindingId: String(bound.bindingId || ""),
    bindingRevision: Number(bound.bindingRevision) || 0,
  };
  if (!resolution || resolution.complete !== true || !targeting.sameFence(resolution.resolvedFor, fence)) {
    throw fail("CAMPAIGN_DEPLOYMENT_NOT_READY",
      "The resolved targeting belongs to a different plan revision or advertising account. Run the preflight again.",
      { field: "targeting" });
  }
  if (str(expectedTargetingFingerprint) && str(expectedTargetingFingerprint) !== str(resolution.fingerprint)) {
    throw fail("CAMPAIGN_DEPLOYMENT_NOT_READY",
      "The plan's targeting has changed since it was checked. Look at the preflight again.",
      { field: "targetingFingerprint" });
  }

  /* ── 3. THE MAPPING, FROM THE SAME RESOLUTION ─────────────────────────── */
  const mapped = pre.__mapped;

  /* ── 4. THE MARKER AND THE DEPLOYMENT RECORD ──────────────────────────── */
  const marker = markerFor({
    companyId: String(companyId),
    bindingId: String(bound.bindingId || ""),
    externalAccountId: bound.externalAccountId,
    campaignDraftId: String(plan._id),
    approvedRevision: plan.revision,
    commandKey: str(idempotencyKey),
    channel: "google_ads",
    campaignType: CAMPAIGN_TYPE,
  }, env);

  const deployment = await deploymentFor({
    companyId, plan, idempotencyKey, authorizedBy, marker, campaignType: CAMPAIGN_TYPE,
  });

  const outstanding = await attempts.hasUnresolvedAttempt({ companyId, deploymentId: deployment._id });
  if (outstanding.unresolved) {
    throw fail("CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED",
      "An earlier attempt for this campaign was recorded as started and GRAV never learned how it ended. Reconcile it before anything else is created.",
      { field: "attempt", attemptNos: outstanding.attempts.map((a) => a.attemptNo), deploymentMarker: marker });
  }
  if (deployment.state === "paused_confirmed" || deployment.externalObjects?.length) {
    throw fail("CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED",
      "This plan revision has already been created in the advertising account.", { field: "deployment" });
  }

  /* ── 5. THE DELIVERY BINDING — GRAV'S OWN ROW, BEFORE ANY EXTERNAL WRITE ─ */
  const delivery = await prepareDelivery({
    companyId, plan, deployment, idempotencyKey, requestedBy, base: pre.__deliveryBase, env,
  });

  /* ── 6. THE INTENT ────────────────────────────────────────────────────── */
  const begun = await attempts.begin({
    companyId,
    deploymentId: deployment._id,
    commandKey: str(idempotencyKey),
    approvedRevision: plan.revision,
    channel: "google_ads",
    campaignType: CAMPAIGN_TYPE,
    requestedBy,
    authorizedBy,
    deploymentMarker: marker,
    plannedObjects: mapped.mapping.objects.map((o) => ({
      role: o.role,
      ...(o.payload?.location?.geoTargetConstant
        ? { target: o.payload.location.geoTargetConstant, negative: o.negative === true }
        : {}),
      ...(o.payload?.language?.languageConstant ? { target: o.payload.language.languageConstant } : {}),
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
    leadDelivery: { url: delivery.url, secret: delivery.secret, payloadSchemaVersion: delivery.payloadSchemaVersion },
  };

  /* ── 7a. VALIDATE-ONLY: THE SAME ENVELOPE, CREATING NOTHING ───────────── */
  try {
    await bundle.createPausedAtomic({ ...command, validateOnly: true }, deps);
  } catch (err) {
    const code = str(err?.code) || "CHANNEL_UNAVAILABLE";
    return finishRefused({
      companyId, deployment, begun, marker, reasonCode: code,
      operatorNote: REFUSAL_CODES.includes(code)
        ? "The advertising channel refused this lead-form campaign when GRAV asked it to check the request. Nothing was created."
        : "GRAV could not reach the advertising channel to check this lead-form campaign. Nothing was created.",
    });
  }

  /* ── 7b. THE ONE WRITE ────────────────────────────────────────────────── */
  let results;
  try {
    results = (await bundle.createPausedAtomic(command, deps)).results;
  } catch (err) {
    const code = str(err?.code);
    if (REFUSAL_CODES.includes(code)) {
      return finishRefused({
        companyId, deployment, begun, marker, reasonCode: code,
        operatorNote: "The advertising channel refused this lead-form campaign. Because the request was all-or-nothing, nothing was created.",
      });
    }
    return finishUnresolved({
      companyId, deployment, begun, marker,
      reasonCode: code === "CHANNEL_RATE_LIMITED" ? "CHANNEL_RATE_LIMITED" : "RESPONSE_LOST",
    });
  }

  /* ── 8. READ IT BACK — BOTH HALVES — BEFORE CALLING IT DONE ───────────── */
  const readAt = new Date();
  const verdict = await reconciler.inspect({ bound, marker, mapping: mapped.mapping, resolvedTargeting: resolution }, deps);
  const campaignId = verdict.campaign?.providerCampaignId || null;
  const form = verdict.outcome === "one_complete_bundle" && campaignId
    ? await inspectLeadForm({ bound, campaignId, deliveryUrl: delivery.url }, deps)
    : { complete: false, outcome: "campaign_unconfirmed", detail: verdict.detail || "" };

  if (verdict.outcome !== "one_complete_bundle" || !form.complete) {
    return finishUnconfirmed({ companyId, deployment, begun, marker, results, verdict, form, readAt });
  }

  const objects = [
    ...reconciler.evidenceFrom({ found: verdict.found, resolvedTargeting: resolution, readAt })
      .map((o) => ({ ...o, origin: "created" })),
    ...leadFormEvidence({ campaignId, link: form.link, readAt, origin: "created" }),
  ];

  const settled = await attempts.settle({
    companyId,
    intentId: begun.intent._id,
    outcome: "succeeded",
    reasonCode: "CREATED_AND_CONFIRMED_STOPPED",
    objects,
    now: readAt,
  });
  await rollUp({ deployment, objects, state: "paused_confirmed", confirmedAt: readAt });

  /* ── 9. ONLY NOW DOES THE DELIVERY ADDRESS BELONG TO A FORM ───────────── */
  const deliveryBound = await bindDelivery({
    companyId, bindingRef: delivery.bindingRef, assetId: form.link.assetId, campaignId,
  });

  return {
    created: true,
    disposition: begun.disposition,
    attemptNo: begun.intent.attemptNo,
    outcome: "succeeded",
    deploymentMarker: marker,
    providerCampaignId: campaignId,
    providerLeadFormId: form.link.assetId,
    deliveryObjectsNonDeliveringConfirmed: settled.result.deliveryObjectsNonDeliveringConfirmed,
    leadFormStopped: true,
    /* Whether Google's read echoed GRAV's delivery address. Unverified until
       the first real enquiry either way — see the decision record. */
    deliveryAddressConfirmed: form.deliveryAddressConfirmed === true,
    deliveryBound,
    targetingConfirmed: true,
    decisions: mapped.decisions,
    deployment: publicDeployment(await refresh(deployment._id)),
  };
}

/**
 * Accepted by the channel, and not confirmed by the read-back — either half.
 * Every identifier the response named is recorded; nothing is settled as
 * success, nothing is rolled back.
 */
async function finishUnconfirmed({ companyId, deployment, begun, marker, results, verdict, form, readAt }) {
  const ROLE_OF = Object.freeze({
    budget: "budget", campaign: "campaign", audience_group: "audience_group",
    advertisement: "advertisement", targeting_term: "targeting_term",
    targeting_criterion: "location_target", lead_form: "lead_form", lead_form_link: "lead_form_link",
  });
  const DELIVERY_APPLIES = new Set(["campaign", "audience_group", "advertisement", "targeting_term", "lead_form_link"]);

  const objects = results
    .map((r) => ({ role: ROLE_OF[r.role], providerObjectId: r.providerObjectId, resourceName: r.resourceName }))
    .filter((r) => r.role)
    .map((r) => {
      const applies = DELIVERY_APPLIES.has(r.role);
      return {
        role: r.role,
        providerObjectId: r.providerObjectId,
        providerObjectType: r.resourceName,
        origin: "created",
        deliveryStateApplies: applies,
        nonDeliveringConfirmed: applies ? false : null,
        stateReadAt: null,
        observedState: "",
      };
    });

  const unavailable = verdict.outcome === "provider_unavailable" || form.outcome === "provider_unavailable";
  await attempts.settle({
    companyId,
    intentId: begun.intent._id,
    outcome: "partially_created",
    reasonCode: unavailable ? "CREATED_BUT_READ_BACK_UNAVAILABLE" : "CREATED_BUT_READ_BACK_DISAGREED",
    operatorNote: [
      "The advertising channel accepted this lead-form campaign and named the objects it created.",
      verdict.outcome !== "one_complete_bundle" ? (verdict.detail || verdict.outcomeMeans) : form.detail,
      "It has NOT been confirmed stopped, so somebody has to look at it in the advertising channel before anything is started.",
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
    leadFormStopped: false,
    deliveryObjectsNonDeliveringConfirmed: false,
    requiresReconciliation: true,
    reconciliation: reconciler.publicVerdict(verdict),
    leadForm: { outcome: form.outcome || "confirmed", detail: form.detail || "" },
    deployment: publicDeployment(await refresh(deployment._id)),
  };
}

/**
 * Reconcile an unresolved lead-form attempt, read-only. It closes only on a
 * complete, stopped bundle carrying this marker AND exactly one stopped lead
 * form attached to it. Everything else leaves it open.
 */
async function reconcile({ companyId, plan, env = process.env }, deps = {}) {
  const bound = await binding.forDeployment({ companyId, channel: "google_ads" });
  const deployment = await MarketingCampaignDeployment.findOne({
    companyId, campaignDraftId: plan._id, channel: "google_ads", campaignType: CAMPAIGN_TYPE,
  }).sort({ approvedRevision: -1 });
  if (!deployment) {
    throw fail("NOT_FOUND", "Nothing has been created for this plan, so there is nothing to reconcile.", { field: "deployment" });
  }

  const outstanding = await attempts.hasUnresolvedAttempt({ companyId, deploymentId: deployment._id });
  if (!outstanding.unresolved) {
    return {
      reconciled: false,
      outcome: "nothing_outstanding",
      means: "Every attempt for this deployment already has a recorded outcome.",
      deployment: publicDeployment(await refresh(deployment._id)),
    };
  }

  const intent = await MarketingCampaignDeploymentAttemptIntent
    .findOne({ companyId, deploymentId: deployment._id, attemptNo: outstanding.attempts[0].attemptNo });
  const marker = str(intent?.deploymentMarker) || str(deployment.deploymentMarker);
  if (!marker) {
    throw fail("CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED",
      "This attempt carries no deployment marker. Somebody has to check the advertising account by hand.",
      { field: "deploymentMarker" });
  }

  /* The command as approved, rebuilt read-only. */
  const pre = await leadPreflight.preflight({ companyId, plan, env }, deps);
  const mapped = pre.__mapped;
  if (!mapped?.mappable) {
    throw fail("CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED",
      "GRAV cannot rebuild what this attempt was supposed to create. Somebody has to check by hand.",
      { field: "plan" });
  }

  /* The address this deployment's form should deliver to: the binding the
     creation prepared, found by the same key — read, never created here. */
  const row = await MarketingLeadDeliveryBinding.findOne({
    companyId, idempotencyKey: `${str(deployment.idempotencyKey)}:delivery`,
  });
  const deliveryUrl = row && pre.__deliveryBase
    ? leadPreflight.deliveryUrlFor(pre.__deliveryBase, leadBindings.deliveryTokenFor(row, env))
    : "";

  const verdict = await reconciler.inspect({ bound, marker, mapping: mapped.mapping, resolvedTargeting: pre.__resolution }, deps);
  const campaignId = verdict.campaign?.providerCampaignId || null;
  const form = verdict.outcome === "one_complete_bundle" && campaignId
    ? await inspectLeadForm({ bound, campaignId, deliveryUrl }, deps)
    : { complete: false, outcome: "campaign_unconfirmed" };

  if (verdict.outcome !== "one_complete_bundle" || !form.complete) {
    return {
      reconciled: false,
      attemptNo: intent.attemptNo,
      deploymentMarker: marker,
      ...reconciler.publicVerdict(verdict),
      leadForm: { outcome: form.outcome || "unconfirmed", detail: form.detail || "" },
      deployment: publicDeployment(await refresh(deployment._id)),
    };
  }

  const now = new Date();
  const objects = [
    ...reconciler.evidenceFrom({ found: verdict.found, resolvedTargeting: pre.__resolution, readAt: now }),
    ...leadFormEvidence({ campaignId, link: form.link, readAt: now, origin: "observed" }),
  ];
  const settled = await attempts.settle({
    companyId,
    intentId: intent._id,
    outcome: "succeeded",
    reasonCode: "RECOVERED_BY_MARKER",
    operatorNote: "GRAV did not receive an answer to this creation. It later found exactly one campaign carrying this deployment's marker with exactly one lead form attached, and read every object back as stopped.",
    objects,
    now,
  });
  await rollUp({ deployment, objects, state: "paused_confirmed", confirmedAt: now });
  const deliveryBound = row
    ? await bindDelivery({ companyId, bindingRef: row.bindingRef, assetId: form.link.assetId, campaignId })
    : false;

  return {
    reconciled: true,
    duplicate: settled.created === false,
    attemptNo: intent.attemptNo,
    deploymentMarker: marker,
    ...reconciler.publicVerdict(verdict),
    leadForm: { outcome: "confirmed", deliveryAddressConfirmed: form.deliveryAddressConfirmed === true },
    deliveryBound,
    deployment: publicDeployment(await refresh(deployment._id)),
  };
}

module.exports = {
  createPaused,
  reconcile,
  publicDeployment,
  __internals: { inspectLeadForm, leadFormEvidence },
};
