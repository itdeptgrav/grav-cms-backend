// services/marketing/deployment/metaPreflight.service.js
//
// WHAT WOULD BE CREATED IN META, AND WHY IT CANNOT BE YET.
//
// ── IT READS. IT WRITES NOTHING, ANYWHERE. ─────────────────────────────────
// Not in the advertising account: every provider call goes through read
// operations, and `channelHttp.assertReadOnly` refuses any verb but GET. Not in
// GRAV either: no deployment record, no attempt intent, no change to the plan.
// Opening this twice has the same effect as opening it once, which is none.
//
// There is no Meta creation path in this codebase. Not disabled — absent. No
// write client, no mutation operation, no route.
//
// ── AND THE ANSWER IS ALWAYS "NOT YET" ─────────────────────────────────────
// Even for a perfect plan in a perfectly verified account. GRAV's content
// library holds emails, forms and landing pages; it has nowhere to keep an
// advertising image, and Meta will not create an image advertisement without
// one. That blocker is reported in a marketer's language, with what would fix
// it, rather than as a vague failure.
//
// Three flags say so, and none of them is computed:
//   `creationReady`   false while the image blocker stands
//   `activationReady` false, always, from a frozen constant
//   `deploymentReady` false, always, from a frozen constant
"use strict";

const { fail } = require("../../storePurchase/errors");
const metaAds = require("../channels/metaAdsClient");
const binding = require("./accountBinding.service");
const targeting = require("./metaTargetingResolution.service");
const creativeAsset = require("./metaCreativeAsset");
const metaAudience = require("./metaAudience");
const advertisingAssets = require("../assets/advertisingAsset.service");
const mapper = require("./metaTrafficMapper");
const trackingConfig = require("../trackingConfig.service");
const {
  MVP_CONTRACT,
  UNSUPPORTED_PUBLIC_MESSAGE,
  PREFLIGHT_CHECKS,
  ACTIVATION_NOT_IN_THIS_SLICE,
  DEPLOYMENT_NOT_IN_THIS_SLICE,
  CREATION_ORDER,
  META_OBJECT_BY_CODE,
  META_CODES: M,
} = require("../../../constants/marketingMetaDeployment");

const str = (v) => String(v ?? "").trim();

const CHECK_BY_CODE = Object.fromEntries(PREFLIGHT_CHECKS.map((c) => [c.code, c]));

/* Three answers, not two. `could_not_check` is what stops this lying: a channel
   that did not answer has not told GRAV the account is wrong, and reporting
   that as `failed` would send somebody to fix a binding that was correct. It
   blocks creation exactly as `failed` does — GRAV does not create into an
   account it could not read — but it says something different. */
const result = (code, status, detail = "") => ({
  code,
  label: CHECK_BY_CODE[code]?.label || code,
  means: CHECK_BY_CODE[code]?.means || "",
  status,
  detail,
  blocksCreation: CHECK_BY_CODE[code]?.blocksCreation === true,
});

/** Read the bound account and answer every check that depends on it. */
async function accountChecks({ bound, plan, pixelId }, deps) {
  const client = deps.metaAds || metaAds;
  const checks = [];
  let account = null;

  try {
    account = await client.describeAccount({
      accountId: bound.externalAccountId,
      businessId: bound.businessId,
    });
    checks.push(result("account_reachable", "passed",
      `GRAV read ${account.accountName || bound.externalAccountId}.`));
  } catch (err) {
    /* The provider's own message is not carried. It went to the server log
       through `channelHttp`; what travels is GRAV's code. */
    const code = str(err?.code) || "CHANNEL_UNAVAILABLE";
    const how = code === "CHANNEL_ACCESS_REFUSED" ? "failed" : "could_not_check";
    checks.push(result("account_reachable", how,
      how === "failed"
        ? "The advertising connection is not allowed to use this account."
        : "The advertising channel did not answer. This is not a wrong account — nothing could be read."));
    /* Every dependent check is ANSWERED rather than omitted: an absent check
       reads as a check that passed. */
    for (const dependent of [
      "account_identity_confirmed", "account_currency_matches", "account_timezone_known",
      "account_usable", "business_context_confirmed", "campaign_reads_available",
      "insights_available", "tracking_identity_readable", "destination_usable",
    ]) {
      checks.push(result(dependent, "could_not_check", "GRAV could not read the account."));
    }
    return { checks, account: null };
  }

  /* ── IT IS THE ACCOUNT THAT WAS BOUND ───────────────────────────────────
     Not whichever account the credential happens to prefer. The binding service
     enforces this too; it is checked again here because a binding verified in
     March is not evidence about today. */
  const answered = str(account.accountId).replace(/^act_/, "");
  const expected = str(bound.externalAccountId).replace(/^act_/, "");
  checks.push(answered === expected
    ? result("account_identity_confirmed", "passed", "The account GRAV read is the one that was bound.")
    : result("account_identity_confirmed", "failed",
      "The advertising connection answered about a different account than the one bound to this company."));

  const planCurrency = str(plan.budget?.currency).toUpperCase();
  if (!account.currency) {
    checks.push(result("account_currency_matches", "could_not_check", "The account did not say which currency it bills in."));
  } else if (planCurrency && planCurrency !== account.currency) {
    checks.push(result("account_currency_matches", "failed",
      `The plan's budget is in ${planCurrency} and this account bills in ${account.currency}. The channel does not convert, so the amount would mean something different.`));
  } else {
    checks.push(result("account_currency_matches", "passed", `The account bills in ${account.currency}.`));
  }

  checks.push(account.timeZone
    ? result("account_timezone_known", "passed", `The account's schedule runs on ${account.timeZone} time.`)
    : result("account_timezone_known", "could_not_check", "The account did not say which timezone it keeps."));

  checks.push(account.status === "ACTIVE"
    ? result("account_usable", "passed", "The account is active.")
    : result("account_usable", "failed",
      "The advertising account is not active, so it would accept nothing."));

  /* ── THE BUSINESS, WHERE THE CHANNEL EXPOSES IT ─────────────────────────
     Advisory. Not every account belongs to a business — a personal account
     legitimately does not — so an absent business is `not_applicable` rather
     than a failure. What IS a failure is a business that disagrees with the
     one somebody bound. */
  if (!bound.businessId) {
    checks.push(result("business_context_confirmed", "not_applicable",
      "No business was recorded on this binding, so there is nothing to compare."));
  } else if (!account.businessId) {
    checks.push(result("business_context_confirmed", "could_not_check",
      "The advertising channel did not say which business this account belongs to."));
  } else {
    checks.push(account.businessId === str(bound.businessId)
      ? result("business_context_confirmed", "passed", "The account sits in the business that was recorded.")
      : result("business_context_confirmed", "failed",
        "The account belongs to a different business than the one recorded on this binding."));
  }

  /* ── CAN GRAV READ BACK WHAT IT WOULD CREATE? ───────────────────────────
     Checked BEFORE anything is created, not after. A connection that can write
     but not read would let a campaign be made and never confirmed stopped,
     which is the state the whole design exists to avoid. */
  let reads = null;
  try {
    reads = await client.verifyDeploymentReads({ accountId: bound.externalAccountId });
    const all = ["campaigns", "adSets", "creatives", "ads"];
    const refused = all.filter((k) => reads[k] === false);
    const unknown = all.filter((k) => reads[k] === null);
    if (refused.length) {
      checks.push(result("campaign_reads_available", "failed",
        "The advertising connection cannot read back everything GRAV would create, so nothing it created could be confirmed stopped."));
    } else if (unknown.length) {
      checks.push(result("campaign_reads_available", "could_not_check",
        "GRAV could not confirm it can read back everything it would create."));
    } else {
      checks.push(result("campaign_reads_available", "passed",
        "GRAV can read campaigns, ad sets, creatives and advertisements in this account."));
    }
  } catch {
    checks.push(result("campaign_reads_available", "could_not_check",
      "GRAV could not confirm it can read back everything it would create."));
  }

  try {
    const insights = await client.verifyInsightsRead({ accountId: bound.externalAccountId });
    checks.push(insights === true
      ? result("insights_available", "passed", "GRAV can read delivery figures for this account.")
      : insights === false
        ? result("insights_available", "failed", "The advertising connection cannot read delivery figures, so GRAV could not report on this campaign afterwards.")
        : result("insights_available", "could_not_check", "GRAV could not confirm it can read delivery figures."));
  } catch {
    checks.push(result("insights_available", "could_not_check", "GRAV could not confirm it can read delivery figures."));
  }

  /* ── THE PIXEL THE COMPANY CONFIGURED ───────────────────────────────────
     A pixel id that parses is not a pixel this account can see. One belonging
     to somebody else measures nothing. */
  if (!str(pixelId)) {
    checks.push(result("tracking_identity_readable", "not_applicable",
      "No website measurement identifier is configured for this company."));
  } else {
    try {
      const pixel = await client.readPixel({ accountId: bound.externalAccountId, pixelId });
      checks.push(pixel.found
        ? result("tracking_identity_readable", "passed", "The configured measurement identifier belongs to this account.")
        : result("tracking_identity_readable", "failed",
          "The measurement identifier configured for this company is not one this advertising account can see."));
    } catch {
      checks.push(result("tracking_identity_readable", "could_not_check",
        "GRAV could not check the configured measurement identifier."));
    }
  }

  /* ── THE DESTINATION DOMAIN ─────────────────────────────────────────────
     Advisory on purpose. The channel requires domain verification for some
     placements and objectives and not others, the rules change, and refusing
     every unverified domain would block correct campaigns. Reported; a person
     decides. */
  const destUrl = str((plan.deploymentBriefs || []).find((b) => b.channel === "meta_ads")?.destination?.url);
  if (!destUrl || !bound.businessId) {
    checks.push(result("destination_usable", "not_applicable",
      "GRAV cannot check domain verification without both a destination and a recorded business."));
  } else {
    try {
      const domains = await client.readVerifiedDomains({ businessId: bound.businessId });
      const host = new URL(destUrl).hostname.replace(/^www\./, "");
      checks.push(domains.some((d) => str(d).replace(/^www\./, "") === host)
        ? result("destination_usable", "passed", "The destination's domain is verified for this business.")
        : result("destination_usable", "failed",
          "The destination's domain is not verified for this business. Some placements refuse an unverified domain."));
    } catch {
      checks.push(result("destination_usable", "could_not_check",
        "GRAV could not check whether the destination's domain is verified."));
    }
  }

  return { checks, account, reads };
}

/**
 * @param {object}   args
 * @param {ObjectId} args.companyId
 * @param {object}   args.plan   the approved plan, as stored
 */
async function preflight({ companyId, plan }, deps = {}) {
  if (!plan) throw fail("NOT_FOUND", "That campaign plan could not be found.", { field: "plan" });

  const bound = await binding.forDeployment({ companyId, channel: "meta_ads" });

  const brief = (plan.deploymentBriefs || []).find((b) => b.channel === "meta_ads") || null;

  /* ── EVERY OTHER SHAPE IS REFUSED HERE, BEFORE ANY PROVIDER READ ────────
     A caller asking GRAV to prepare a carousel gets one sentence and no
     account traffic. The internal vocabulary names the shape; the public
     message does not, because naming channel features GRAV cannot do publishes
     a roadmap nobody wrote. */
  if (!brief || str(brief.campaignType) !== MVP_CONTRACT.campaignType) {
    throw fail("CAMPAIGN_DEPLOYMENT_NOT_BUILT", UNSUPPORTED_PUBLIC_MESSAGE, {
      field: "campaignType",
      supported: MVP_CONTRACT.campaignType,
    });
  }

  /* The company's own Meta Pixel identifier, from the tracking configuration.
     A public identifier, never a credential. */
  let pixelId = "";
  try {
    const config = await trackingConfig.get({ companyId });
    pixelId = str(config?.config?.metaPixelId || config?.metaPixelId);
  } catch {
    pixelId = "";
  }

  const { checks, account } = await accountChecks({ bound, plan, pixelId }, deps);

  const resolution = await targeting.resolve({ plan, bound, brief }, deps);

  /* ── ONE AUDIENCE TRUTH ────────────────────────────────────────────────
     The same function the plan's readiness gate and the mapper call, so a plan
     cannot be approvable by one standard and refused by another. */
  const audience = metaAudience.evaluate({ brief, resolvedTargeting: resolution });

  /* ── THE IMAGE, WHICH IS THE BLOCKER ────────────────────────────────────
     No asset library exists, so no asset is ever passed in. The evaluation
     still runs the full contract so that the day one does, this is the gate it
     passes through. */
  /* ── THE IMAGE, FROM THE LIBRARY ────────────────────────────────────────
     A plan names an approved advertising image by its opaque public identifier.
     `forDeployment` is the only door: it refuses anything that is not an
     approved, current version of THIS company's, so a revoked image or one from
     another company cannot reach a campaign. */
  let assetRecord = deps.creativeAssetRecord || null;
  let assetProblem = null;
  const namedAssetId = str(brief.advertisingAssetId);
  if (!assetRecord && namedAssetId) {
    try {
      const approved = await advertisingAssets.forDeployment({ companyId, assetId: namedAssetId });
      assetRecord = {
        assetId: approved.publicAssetId,
        companyId: String(approved.companyId),
        mimeType: approved.mimeType,
        width: approved.width,
        height: approved.height,
        byteSize: approved.byteSize,
        contentHash: approved.sha256,
        storageOrigin: "company_drive",
        readMechanism: "grav_authenticated_route",
        rightsState: "approved_for_paid_advertising",
        approvedPlanRevision: plan.revision,
        usable: true,
        providerUpload: "not_yet_uploaded",
      };
    } catch (err) {
      /* GRAV's own sentence, carried into the creative section rather than
         thrown: a preflight's job is to explain, not to stop. */
      assetProblem = { code: str(err?.code), message: str(err?.message) };
    }
  }

  const asset = creativeAsset.evaluate({ brief, asset: assetRecord });
  if (assetProblem) {
    asset.ready = false;
    asset.problems = [{ code: "IMAGE_ASSET_MISSING", field: "advertisingAssetId", message: assetProblem.message }];
  }

  checks.push(asset.ready
    ? result("advertising_image_available", "passed", "An approved advertising image is available.")
    : result("advertising_image_available", "failed", creativeAsset.publicBlocker().means));

  const mapped = mapper.map({
    plan,
    account: {
      currency: account?.currency || "",
      timeZone: account?.timeZone || "",
      externalAccountId: bound.externalAccountId,
    },
    resolvedTargeting: resolution,
    creativeAsset: asset,
    trackingIdentity: pixelId,
    audience,
  });

  const blocking = checks.filter((c) => c.blocksCreation && c.status !== "passed" && c.status !== "not_applicable");
  const advisoryFailed = checks.filter((c) => !c.blocksCreation && c.status === "failed");

  /* ── ALWAYS FALSE TODAY, AND FOR A NAMED REASON ─────────────────────────
     `advertising_image_available` is a blocking check and it cannot pass, so
     this cannot be true. It is still computed rather than hard-coded, because
     the day the asset library exists this is the line that starts telling the
     truth on its own. */
  const creationReady = blocking.length === 0 && mapped.mappable === true;

  return {
    channel: "meta_ads",
    campaignType: MVP_CONTRACT.campaignType,

    account: {
      externalAccountId: bound.externalAccountId,
      externalAccountName: bound.externalAccountName || null,
      businessId: bound.businessId || null,
      currency: account?.currency || bound.currency || null,
      timeZone: account?.timeZone || bound.timeZone || null,
      status: account?.status || null,
      /* The version of the binding decision this preflight was made under. A
         rebind changes it, and anything resolved under the old one is stale. */
      bindingRevision: bound.bindingRevision,
      verifiedAt: bound.verifiedAt,
    },

    checks,

    targeting: targeting.publicTargeting(resolution),

    /* The one audience GRAV can build, or exactly what is missing from it. */
    audience: metaAudience.publicAudience(audience),

    creative: {
      ready: asset.ready,
      blocker: asset.ready ? null : creativeAsset.publicBlocker(),
      problems: asset.problems,
    },

    tracking: {
      /* Stated honestly whichever way it is. A missing pixel is not an error —
         plenty of traffic campaigns run without one — but an optimisation aimed
         at page views needs it, and a caller should not have to infer that. */
      identityConfigured: Boolean(pixelId),
      identity: pixelId || null,
      means: pixelId
        ? "Website measurement is configured for this company, so the advertisement can be optimised for visits that actually load the page."
        : "No website measurement is configured for this company. The advertisement can still be created, but it can only be optimised for clicks, and GRAV will not be able to report what happened after the click.",
    },

    planProblems: mapped.problems,
    decisions: mapped.decisions,

    /* What WOULD be created. Roles and a human summary — no provider payload,
       because there is no request, and publishing a shape would make it look
       like one. */
    proposedObjects: CREATION_ORDER.map((role) => {
      const spec = META_OBJECT_BY_CODE[role];
      const planned = mapped.plan?.objects.find((o) => o.role === role) || null;
      return {
        role,
        label: spec.label,
        deliveryStateApplies: spec.deliveryStateApplies,
        wouldBeCreatedStopped: spec.deliveryStateApplies,
        dependsOn: spec.dependsOn,
        describes: planned?.describes || null,
      };
    }),
    wouldCreate: mapped.plan ? mapped.plan.summary : null,

    /* Every external question still outstanding, named. */
    externalChecksRequired: checks
      .filter((c) => c.status === "could_not_check")
      .map((c) => ({ code: c.code, label: c.label, detail: c.detail })),

    creationReady,
    creationBlockers: [
      ...blocking.map((c) => ({ kind: "account", code: c.code, label: c.label, detail: c.detail, status: c.status })),
      ...advisoryFailed.map((c) => ({ kind: "advisory", code: c.code, label: c.label, detail: c.detail, status: c.status })),
      ...mapped.problems.map((p) => ({ kind: "plan", code: p.code, label: p.field, detail: p.message, status: "failed" })),
    ],

    activationReady: ACTIVATION_NOT_IN_THIS_SLICE.activationReady,
    activationBlocked: {
      reasonCode: ACTIVATION_NOT_IN_THIS_SLICE.reasonCode,
      means: ACTIVATION_NOT_IN_THIS_SLICE.means,
    },

    deploymentReady: DEPLOYMENT_NOT_IN_THIS_SLICE.deploymentReady,
    deploymentBlocked: {
      reasonCode: DEPLOYMENT_NOT_IN_THIS_SLICE.reasonCode,
      means: DEPLOYMENT_NOT_IN_THIS_SLICE.means,
    },

    /* ── STATED, BECAUSE "PREFLIGHT" SOUNDS LIKE A DEPARTURE ──────────────
       A reader who sees checks passing could reasonably think something
       happened. Nothing did. */
    nothingHappened: {
      createdAnything: false,
      publishedAnything: false,
      activatedDelivery: false,
      spentMoney: false,
      contactedAnybody: false,
      means: "This read the advertising account and the plan. It created nothing, published nothing, started nothing and spent nothing — and GRAV has no way to create a Meta campaign at all yet.",
    },

    checkedAt: new Date(),

    /* Not for the wire. The route builds its response field by field. */
    __resolution: resolution,
    __audience: audience,
    __asset: asset,
  };
}

module.exports = { preflight, PREFLIGHT_CHECKS, UNSUPPORTED_PUBLIC_MESSAGE };
