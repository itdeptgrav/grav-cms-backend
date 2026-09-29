// services/marketing/deployment/bundleReconciliation.service.js
//
// DID MY REQUEST TAKE EFFECT? ASKING THE ACCOUNT, BY MARKER, READ-ONLY.
//
// ── THE ONE QUESTION THIS ANSWERS ──────────────────────────────────────────
// One atomic bundle was sent. No response arrived. Either the whole campaign
// exists or none of it does, and GRAV cannot tell which. Everything downstream
// is stuck: it must not create again (that would duplicate a real campaign) and
// it must not give up (that would abandon one).
//
// So it walks into the bound account and looks for its own marker.
//
// ── AND THE THREE ANSWERS IT REFUSES TO GIVE ───────────────────────────────
// "A campaign with the right name exists, so we're fine." Names are not unique
// in Google Ads, a removed campaign keeps its name, and anybody with account
// access can type one. A name match is a coincidence dressed as proof.
//
// "Nothing found, so the request failed — create again." A channel's reads can
// lag its writes. An immediate empty answer is an absence of evidence, and
// acting on it is how a second complete campaign gets created minutes after the
// first. `not_found_unconfirmed` is deliberately not a terminal state.
//
// "Two campaigns carry the marker; take the newest." That is a machine picking
// which of somebody's real campaigns to adopt and which to orphan.
//
// ── READ-ONLY, WITHOUT EXCEPTION ───────────────────────────────────────────
// Nothing in this file writes to an advertising account. It has no access to
// the bundle client, cannot create, cannot remove, and cannot repair what it
// finds. It reports, and where it can prove a complete match it settles GRAV's
// OWN record — which is a database write, not a provider one.
"use strict";

const { fail } = require("../../storePurchase/errors");
const googleAds = require("../channels/googleAdsClient");
const attempts = require("../campaignDrafts/deploymentAttempt.service");
const {
  RECONCILIATION_OUTCOMES,
  RECONCILIATION_SETTLING_OUTCOME,
  BUNDLE_REQUIREMENTS,
  NON_DELIVERING_STATUS,
  SEARCH_CHANNEL_TYPE,
} = require("../../../constants/marketingGoogleSearchDeployment");

const str = (v) => String(v ?? "").trim();

const OUTCOME_BY_CODE = Object.fromEntries(RECONCILIATION_OUTCOMES.map((o) => [o.code, o]));

/* The statuses that mean an object is not being shown. `REMOVED` counts:
   something somebody deleted is not delivering, and calling that "still able to
   deliver" would send an operator to pause a thing that no longer exists. */
const NON_DELIVERING = Object.freeze([NON_DELIVERING_STATUS, "REMOVED"]);

const verdict = (outcome, extra = {}) => ({
  outcome,
  outcomeLabel: OUTCOME_BY_CODE[outcome]?.label || outcome,
  outcomeMeans: OUTCOME_BY_CODE[outcome]?.means || "",
  maySettle: OUTCOME_BY_CODE[outcome]?.settles === true,
  needsAdministrator: OUTCOME_BY_CODE[outcome]?.needsAdministrator === true,
  mismatches: [],
  campaign: null,
  ...extra,
});

/**
 * Compare one found campaign against the immutable command it should be.
 *
 * ── EVERY DIFFERENCE IS A MISMATCH, NOT A DETAIL ───────────────────────────
 * This is the function that decides whether an unresolved attempt can be closed
 * as a success. Anything it waves through becomes a deployment GRAV reports as
 * done. So a missing keyword, an ad group that is not stopped, an exclusion
 * stored as an inclusion — all of them are mismatches, and all of them send the
 * attempt to a person instead.
 */
function differencesFrom({ found, mapping, resolvedTargeting, marker }) {
  const bad = [];
  const note = (code, what) => bad.push({ code, what });

  /* ── THE MARKER RELATIONSHIP ───────────────────────────────────────────
     The campaign came back from a query on the label, so the relationship
     exists. Checked anyway, because the day that query changes, this is what
     stops a campaign being adopted on a weaker piece of evidence. */
  if (!str(found.labelResourceName)) {
    note("MARKER_RELATIONSHIP_MISSING", "The campaign does not carry GRAV's deployment marker.");
  }

  if (found.channelType && found.channelType !== SEARCH_CHANNEL_TYPE) {
    note("NOT_A_SEARCH_CAMPAIGN", "The campaign carrying this marker is not a search campaign.");
  }

  /* ── EVERY OBJECT THE BUNDLE PROMISED ─────────────────────────────────── */
  if (found.budgets.length !== BUNDLE_REQUIREMENTS.budgets) {
    note("BUDGET_COUNT", `Expected ${BUNDLE_REQUIREMENTS.budgets} budget, found ${found.budgets.length}.`);
  }
  if (found.adGroups.length !== BUNDLE_REQUIREMENTS.adGroups) {
    note("AD_GROUP_COUNT", `Expected ${BUNDLE_REQUIREMENTS.adGroups} ad group, found ${found.adGroups.length}.`);
  }
  if (found.ads.length !== BUNDLE_REQUIREMENTS.ads) {
    note("AD_COUNT", `Expected ${BUNDLE_REQUIREMENTS.ads} advertisement, found ${found.ads.length}.`);
  }

  /* ── EVERYTHING THAT CAN DELIVER IS STOPPED ───────────────────────────── */
  if (!NON_DELIVERING.includes(found.status)) {
    note("CAMPAIGN_NOT_STOPPED", `The campaign is ${found.status || "in an unknown state"}, not stopped.`);
  }
  for (const g of found.adGroups) {
    if (!NON_DELIVERING.includes(g.status)) {
      note("AD_GROUP_NOT_STOPPED", "An ad group in this campaign is not stopped.");
    }
  }
  for (const a of found.ads) {
    if (!NON_DELIVERING.includes(a.status)) {
      note("AD_NOT_STOPPED", "An advertisement in this campaign is not stopped.");
    }
  }

  /* ── THE KEYWORDS THE PLAN NAMED, ALL OF THEM, ALL STOPPED ────────────── */
  const wantedKeywords = mapping.objects
    .filter((o) => o.role === "targeting_term")
    .map((o) => str(o.payload?.keyword?.text).toLowerCase())
    .sort();
  const foundKeywords = found.keywords.map((k) => str(k.text).toLowerCase()).sort();
  if (wantedKeywords.length !== foundKeywords.length
    || wantedKeywords.some((k, i) => k !== foundKeywords[i])) {
    note("KEYWORDS_DIFFER",
      `Expected ${wantedKeywords.length} search term(s), found ${foundKeywords.length}.`);
  }
  for (const k of found.keywords) {
    if (!NON_DELIVERING.includes(k.status)) note("KEYWORD_NOT_STOPPED", "A search term in this campaign is not stopped.");
  }

  /* ── THE TARGETING, INCLUSION AND EXCLUSION KEPT APART ─────────────────
     The most consequential comparison here. A campaign whose location
     inclusions are missing runs everywhere; one whose exclusion arrived as an
     inclusion runs in the single place somebody said to avoid. Neither is
     visible on a provider screen as an error. */
  const foundIncluded = found.criteria.filter((c) => c.geoTargetConstant && !c.negative)
    .map((c) => c.geoTargetConstant).sort();
  const foundExcluded = found.criteria.filter((c) => c.geoTargetConstant && c.negative)
    .map((c) => c.geoTargetConstant).sort();
  const foundLanguages = found.criteria.filter((c) => c.languageConstant)
    .map((c) => c.languageConstant).sort();

  const wantIncluded = (resolvedTargeting.locations || []).map((l) => l.resourceName).sort();
  const wantExcluded = (resolvedTargeting.exclusions || []).map((l) => l.resourceName).sort();
  const wantLanguages = (resolvedTargeting.languages || []).map((l) => l.resourceName).sort();

  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  if (!same(foundIncluded, wantIncluded)) {
    note("LOCATIONS_DIFFER",
      `Expected ${wantIncluded.length} targeted location(s), found ${foundIncluded.length}.`);
  }
  if (!same(foundExcluded, wantExcluded)) {
    note("EXCLUSIONS_DIFFER",
      `Expected ${wantExcluded.length} excluded location(s), found ${foundExcluded.length}.`);
  }
  if (!same(foundLanguages, wantLanguages)) {
    note("LANGUAGES_DIFFER",
      `Expected ${wantLanguages.length} language(s), found ${foundLanguages.length}.`);
  }
  /* And the specific reversal, named separately, because "expected 1 excluded,
     found 0" and "the place you excluded is being targeted" read very
     differently to whoever is woken up by this. */
  for (const wanted of wantExcluded) {
    if (foundIncluded.includes(wanted)) {
      note("EXCLUSION_BECAME_INCLUSION",
        "A location the plan excluded is being targeted by this campaign.");
    }
  }

  void marker;
  return bad;
}

/**
 * Ask the bound account what, if anything, carries this deployment's marker.
 *
 * @param {object} args
 * @param {object} args.bound              the account binding, from `forDeployment`
 * @param {string} args.marker             the GRAV deployment marker
 * @param {object} args.mapping            the deterministic mapper's output
 * @param {object} args.resolvedTargeting
 */
async function inspect({ bound, marker, mapping, resolvedTargeting }, deps = {}) {
  const client = deps.googleAds || googleAds;

  let found;
  try {
    found = await client.readBundleByMarker({
      customerId: bound.externalAccountId,
      loginCustomerId: bound.loginAccountId,
      marker,
    });
  } catch (err) {
    /* ── AN OUTAGE IS NOT AN EMPTY ACCOUNT ──────────────────────────────── */
    void err;
    return verdict("provider_unavailable", {
      detail: "The advertising channel did not answer, so GRAV could not check whether anything was created.",
    });
  }

  const campaigns = found.campaigns || [];

  if (!campaigns.length) {
    return verdict("not_found_unconfirmed", {
      /* ── WHY THIS IS NOT "IT FAILED, TRY AGAIN" ──────────────────────────
         A channel's reads can lag its writes by minutes. Treating an immediate
         empty answer as proof of failure is how a second complete campaign gets
         created on top of a first that was already live. */
      detail: "Nothing in the advertising account carries this deployment's marker yet. That is not proof the request failed — a channel's reads can lag its writes, so this attempt stays unresolved.",
      labelFound: (found.labels || []).length > 0,
    });
  }

  if (campaigns.length > 1) {
    return verdict("multiple_matches", {
      detail: `${campaigns.length} campaigns in the advertising account carry this deployment's marker. GRAV will not choose between them.`,
      campaigns: campaigns.map((c) => ({ providerCampaignId: c.campaignId, status: c.status })),
    });
  }

  const [campaign] = campaigns;
  const mismatches = differencesFrom({ found: campaign, mapping, resolvedTargeting, marker });

  if (mismatches.length) {
    return verdict("one_incomplete_or_mismatched_bundle", {
      detail: "One campaign carries this deployment's marker and it is not what was approved.",
      campaign: { providerCampaignId: campaign.campaignId, status: campaign.status },
      mismatches,
    });
  }

  return verdict(RECONCILIATION_SETTLING_OUTCOME, {
    detail: "One campaign carries this deployment's marker, and every object, stopped state and targeting matches what was approved.",
    campaign: { providerCampaignId: campaign.campaignId, status: campaign.status },
    found: campaign,
  });
}

/* ── THE EVIDENCE A RECOVERED SUCCESS IS SETTLED WITH ───────────────────────
   Built from what the account SAID, with `origin: "observed"` on every object.
   Not `created`: GRAV did not watch these appear, it found them. Collapsing the
   two would make a recovery indistinguishable from a deployment in the record,
   and the difference is exactly what somebody auditing this later needs. */
function evidenceFrom({ found, resolvedTargeting, readAt }) {
  const objects = [];
  const push = (o) => objects.push({ origin: "observed", ...o });

  for (const b of found.budgets) {
    push({
      role: "budget",
      providerObjectId: b.budgetId,
      /* A budget has no delivery state, so it is asked nothing. */
      deliveryStateApplies: false,
      displayName: b.name || "",
    });
  }

  push({
    role: "campaign",
    providerObjectId: found.campaignId,
    deliveryStateApplies: true,
    nonDeliveringConfirmed: true,
    stateReadAt: readAt,
    observedState: found.status,
    displayName: found.name || "",
  });

  for (const g of found.adGroups) {
    push({
      role: "audience_group",
      providerObjectId: g.adGroupId,
      deliveryStateApplies: true,
      nonDeliveringConfirmed: true,
      stateReadAt: readAt,
      observedState: g.status,
      displayName: g.name || "",
    });
  }
  for (const a of found.ads) {
    push({
      role: "advertisement",
      providerObjectId: a.adId,
      deliveryStateApplies: true,
      nonDeliveringConfirmed: true,
      stateReadAt: readAt,
      observedState: a.status,
    });
  }
  for (const k of found.keywords) {
    push({
      role: "targeting_term",
      providerObjectId: k.criterionId,
      deliveryStateApplies: true,
      nonDeliveringConfirmed: true,
      stateReadAt: readAt,
      observedState: k.status,
      displayName: k.text || "",
    });
  }

  const nameFor = (resourceName) => {
    const all = [
      ...(resolvedTargeting.locations || []),
      ...(resolvedTargeting.exclusions || []),
      ...(resolvedTargeting.languages || []),
    ];
    const hit = all.find((t) => t.resourceName === resourceName);
    return { display: hit?.canonicalName || "", requested: hit?.requested?.name || hit?.requested?.tag || "" };
  };

  for (const c of found.criteria) {
    if (!c.geoTargetConstant && !c.languageConstant) continue;
    const names = nameFor(c.geoTargetConstant || c.languageConstant);
    push({
      role: c.geoTargetConstant ? "location_target" : "language_target",
      providerObjectId: c.criterionId,
      /* A criterion is a rule, not an object that delivers. */
      deliveryStateApplies: false,
      negative: c.negative === true,
      /* Confirmed BY THIS READ — which is the only way it is ever set. */
      negativeConfirmed: true,
      displayName: names.display,
      requestedName: names.requested,
    });
  }

  return objects;
}

/**
 * Settle an unresolved attempt as a recovered success — and only that.
 *
 * ── IDEMPOTENT, AND THE ONLY WAY OUT OF `unresolved` ───────────────────────
 * `attempts.settle` refuses a second result for one intent, so calling this
 * twice cannot produce two conflicting accounts of one attempt. Anything other
 * than a complete match returns without settling: an incomplete bundle, several
 * markers, an empty answer or an outage all leave the attempt exactly where it
 * was, which is what keeps the next creation refused.
 *
 * It calls no provider WRITE operation. There is no path from here to the
 * bundle client.
 */
async function settleIfComplete({ companyId, intent, verdict: v, resolvedTargeting, now = new Date() }) {
  if (!v.maySettle) {
    return { settled: false, outcome: v.outcome, reason: v.detail || v.outcomeMeans };
  }
  if (!v.found) {
    throw fail("INTERNAL", "A complete reconciliation arrived without the campaign it found.", { field: "found" });
  }

  const objects = evidenceFrom({ found: v.found, resolvedTargeting, readAt: now });

  const settled = await attempts.settle({
    companyId,
    intentId: intent._id,
    outcome: "succeeded",
    reasonCode: "RECOVERED_BY_MARKER",
    operatorNote: "GRAV did not receive an answer to this creation. It later found exactly one campaign carrying this deployment's marker, read back every object, every stopped state and every location and language, and they match what was approved.",
    objects,
    now,
  });

  return {
    settled: true,
    /* `created: false` was already returned to whoever made the original call,
       and `settle` is idempotent — a second reconciliation of the same attempt
       finds the result already there rather than writing a second one. */
    duplicate: settled.created === false,
    outcome: v.outcome,
    result: settled.result,
    objects,
  };
}

/* ── WHAT A CALLER IS TOLD ──────────────────────────────────────────────────
   GRAV's own words throughout. No GAQL, no provider URL, no raw error, no
   credential, no internal resource path. Provider OBJECT IDS do travel, because
   a person reconciling by hand needs them and they are on every screen of the
   advertising interface. */
const publicVerdict = (v) => ({
  outcome: v.outcome,
  outcomeLabel: v.outcomeLabel,
  outcomeMeans: v.outcomeMeans,
  detail: v.detail || "",
  needsAdministrator: v.needsAdministrator,
  /* The one field a caller must read before doing anything else. */
  mayCreateAgain: false,
  mayCreateAgainMeans: "Nothing may be created for this deployment while its first attempt is unresolved, and a reconciliation never authorises one by itself.",
  campaign: v.campaign || null,
  campaigns: v.campaigns || [],
  mismatches: (v.mismatches || []).map((m) => ({ code: m.code, what: m.what })),
});

module.exports = { inspect, settleIfComplete, publicVerdict, evidenceFrom, differencesFrom };
