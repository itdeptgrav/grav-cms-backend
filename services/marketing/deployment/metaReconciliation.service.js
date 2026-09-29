// services/marketing/deployment/metaReconciliation.service.js
//
// DID MY SEQUENCE TAKE EFFECT? ASKING THE ACCOUNT, BY MARKER, READ-ONLY.
//
// ── THE QUESTION A NON-ATOMIC SEQUENCE LEAVES BEHIND ───────────────────────
// Meta gives no all-or-nothing guarantee across these nodes, so a sequence that
// stops part-way leaves a real, partly-built campaign. Everything GRAV created
// is stopped, so it is inert — but "inert" is not "accounted for", and the next
// creation must not build a second campaign beside the first.
//
// So GRAV walks into the bound account and looks for its own marker.
//
// ── WHY THE MARKER IS AN AD LABEL ──────────────────────────────────────────
// Meta's `adlabels` are account-level objects that can be attached to a
// campaign, an ad set and an ad, and read back by name through the same edges.
// That makes them the closest analogue to the Google label marker, and the only
// Meta field GRAV can both write and read back that is not editable-by-accident
// text a person might rename.
//
// **This has not been confirmed against a real account.** Whether a label can be
// created and attached within this operation sequence, and read back by name
// reliably, is on the live-verification list. Until it is confirmed, the
// reconciliation below compares the objects GRAV itself recorded during the
// sequence — which is exactly why every confirmed step is written down before
// the next one starts.
//
// ── AND THE THREE ANSWERS IT REFUSES TO GIVE ───────────────────────────────
// "A campaign with the right name exists, so we are fine." Names are not unique
// and anybody with account access can type one.
//
// "Nothing found, so the sequence failed — create again." Meta's reads can lag
// its writes. An immediate empty answer is an absence of evidence.
//
// "Two campaigns carry the marker; take the newest." That is a machine deciding
// which of somebody's real campaigns to adopt and which to orphan.
//
// ── READ-ONLY, WITHOUT EXCEPTION ───────────────────────────────────────────
// Nothing here writes to an advertising account. It has no access to the write
// client, cannot create, cannot delete and cannot repair what it finds.
"use strict";

const { fail } = require("../../storePurchase/errors");
const metaAds = require("../channels/metaAdsClient");
const attempts = require("../campaignDrafts/deploymentAttempt.service");
const {
  META_OBJECT_BY_CODE,
  CREATION_ORDER,
} = require("../../../constants/marketingMetaDeployment");

const str = (v) => String(v ?? "").trim();

/* ── SIX CLASSIFICATIONS, AND ONLY ONE CAN CLOSE AN ATTEMPT ─────────────────
   The vocabulary deliberately mirrors the Google path's, so a marketer reading
   a Meta reconciliation and a Google one is not learning two ways of being told
   the same thing. */
const OUTCOMES = Object.freeze({
  no_confirmed_match: {
    label: "Nothing confirmed yet",
    means: "GRAV found nothing it can confirm belongs to this deployment. That is not proof the request failed: a channel's reads can lag its writes, so this attempt stays unresolved.",
    settles: false,
    needsAdministrator: false,
  },
  one_complete_hierarchy: {
    label: "Found, complete and stopped",
    means: "One campaign, ad set, creative and advertisement match this deployment, every delivery-capable one is stopped, and the audience, targeting and image are what was approved.",
    settles: true,
    needsAdministrator: false,
  },
  incomplete_hierarchy: {
    label: "Found, but not all of it",
    means: "Part of the campaign exists and part does not. It is stopped, so nothing is being shown — but somebody has to decide what to do with what is there.",
    settles: false,
    needsAdministrator: true,
  },
  mismatched_hierarchy: {
    label: "Found, but not what was approved",
    means: "The campaign exists and does not match what was approved — something is able to deliver, or its audience, targeting or image is not the one that was reviewed.",
    settles: false,
    needsAdministrator: true,
  },
  multiple_matches: {
    label: "More than one match",
    means: "Several campaigns match this deployment. GRAV will not choose between them.",
    settles: false,
    needsAdministrator: true,
  },
  provider_unavailable: {
    label: "Could not be checked",
    means: "The advertising channel did not answer, so nothing could be looked up. This is not an empty account.",
    settles: false,
    needsAdministrator: false,
  },
});

const verdict = (outcome, extra = {}) => ({
  outcome,
  outcomeLabel: OUTCOMES[outcome].label,
  outcomeMeans: OUTCOMES[outcome].means,
  maySettle: OUTCOMES[outcome].settles === true,
  needsAdministrator: OUTCOMES[outcome].needsAdministrator === true,
  mismatches: [],
  found: null,
  ...extra,
});

/* Statuses that mean an object is not being shown. `DELETED` and `ARCHIVED`
   count: something somebody removed is not delivering, and calling that "still
   able to deliver" would send an operator to pause a thing that is gone. */
const NON_DELIVERING = Object.freeze(["PAUSED", "DELETED", "ARCHIVED"]);

/**
 * Compare what the account holds against the command it should be.
 *
 * ── EVERY DIFFERENCE IS A MISMATCH, NOT A DETAIL ───────────────────────────
 * This decides whether an unresolved attempt can close as a success. Anything
 * waved through becomes a deployment GRAV reports as done.
 */
function differencesFrom({ found, mapped, audience, approvedAsset }) {
  const bad = [];
  const note = (code, what) => bad.push({ code, what });

  /* ── EVERYTHING THAT CAN DELIVER IS STOPPED ───────────────────────────── */
  for (const role of CREATION_ORDER) {
    const spec = META_OBJECT_BY_CODE[role];
    const object = found.objects.find((o) => o.role === role);
    if (!object) {
      note("OBJECT_MISSING", `The ${spec.label.toLowerCase()} is not there.`);
      continue;
    }
    if (!spec.deliveryStateApplies) continue;
    if (!NON_DELIVERING.includes(str(object.status))) {
      note(`${role.toUpperCase()}_NOT_STOPPED`,
        `The ${spec.label.toLowerCase()} is ${str(object.status) || "in an unknown state"}, not stopped.`);
    }
  }

  /* ── THE RELATIONSHIPS ──────────────────────────────────────────────────
     An ad set pointing at a different campaign, or an ad carrying a different
     creative, is a campaign GRAV did not build. */
  const byRole = Object.fromEntries(found.objects.map((o) => [o.role, o]));
  if (byRole.audience_group && byRole.campaign
    && str(byRole.audience_group.parentId) !== str(byRole.campaign.providerObjectId)) {
    note("AD_SET_WRONG_CAMPAIGN", "The ad set does not belong to this campaign.");
  }
  if (byRole.advertisement && byRole.audience_group
    && str(byRole.advertisement.parentId) !== str(byRole.audience_group.providerObjectId)) {
    note("AD_WRONG_AD_SET", "The advertisement does not belong to this ad set.");
  }
  if (byRole.advertisement && byRole.creative
    && str(byRole.advertisement.creativeId) !== str(byRole.creative.providerObjectId)) {
    note("AD_WRONG_CREATIVE", "The advertisement does not carry this creative.");
  }

  /* ── THE AUDIENCE, BOUNDARY BY BOUNDARY ─────────────────────────────────
     The most consequential comparison. An ad set whose age range or exclusions
     differ is reaching people the approval did not cover, and nothing on a
     provider screen shows that as wrong. */
  const t = byRole.audience_group?.targeting || null;
  if (!t) {
    if (byRole.audience_group) note("TARGETING_UNREADABLE", "GRAV could not read the ad set's audience.");
  } else {
    const same = (a, b) => {
      const x = [...(a || [])].map(str).sort();
      const y = [...(b || [])].map(str).sort();
      return x.length === y.length && x.every((v, i) => v === y[i]);
    };
    if (!same(t.includedLocationKeys, audience.audience.includedLocations.map((l) => l.key))) {
      note("LOCATIONS_DIFFER", "The locations are not the ones that were approved.");
    }
    if (!same(t.excludedLocationKeys, audience.audience.excludedLocations.map((l) => l.key))) {
      note("EXCLUSIONS_DIFFER", "The excluded locations are not the ones that were approved.");
    }
    if (!same(t.localeKeys, audience.audience.languages.map((l) => l.key))) {
      note("LANGUAGES_DIFFER", "The languages are not the ones that were approved.");
    }
    if (Number(t.ageMin) !== Number(audience.audience.ageMin)
      || Number(t.ageMax) !== Number(audience.audience.ageMax)) {
      note("AGES_DIFFER", "The age range is not the one that was approved.");
    }
    const wantGenders = audience.audience.gendersProvider;
    if (!same(t.genders || [], wantGenders || [])) {
      note("GENDERS_DIFFER", "The gender choice is not the one that was approved.");
    }
    /* ── AND THE CHANNEL HAS NOT BEEN LET LOOSE ON IT ───────────────────── */
    if (t.audienceExpansion === true) {
      note("AUDIENCE_EXPANSION_ON",
        "The advertising channel is allowed to show this advertisement outside the approved audience.");
    }
  }

  /* ── THE IMAGE IS THE ONE THAT WAS APPROVED ─────────────────────────────
     Compared by the channel's own hash for the bytes GRAV uploaded. A creative
     carrying a different picture is a different advertisement. */
  if (approvedAsset && byRole.creative) {
    const expected = str(found.uploadedImageHash);
    const actual = str(byRole.creative.imageHash);
    if (expected && actual && expected !== actual) {
      note("IMAGE_DIFFERS", "The advertisement is not showing the image that was approved.");
    }
    if (!actual) {
      note("IMAGE_UNREADABLE", "GRAV could not confirm which image the advertisement shows.");
    }
  }

  void mapped;
  return bad;
}

/**
 * Ask the bound account what belongs to this deployment.
 *
 * `confirmed` is what GRAV recorded during the sequence — written after every
 * step, before the next began. That list is what makes a partial outcome
 * inspectable at all, and it is why the marker's unverified status is tolerable
 * for now: GRAV is not relying solely on a label it has never read back.
 */
async function inspect({ bound, marker, mapped, audience, resolution, approvedAsset, confirmed }, deps = {}) {
  const client = deps.metaAds || metaAds;

  let found;
  try {
    found = await client.readDeploymentByMarker({
      accountId: bound.externalAccountId,
      marker,
      /* The identifiers GRAV recorded as it went, so a read can confirm the
         exact objects rather than searching an account for something that looks
         right. */
      knownObjectIds: (confirmed || []).map((c) => ({ role: c.role, providerObjectId: c.providerObjectId })),
    });
  } catch {
    return verdict("provider_unavailable", {
      detail: "The advertising channel did not answer, so GRAV could not check what exists.",
    });
  }

  const campaigns = found.campaigns || [];

  if (!campaigns.length) {
    return verdict("no_confirmed_match", {
      detail: "Nothing in the advertising account could be confirmed as belonging to this deployment yet. That is not proof the request failed — a channel's reads can lag its writes, so this attempt stays unresolved.",
    });
  }
  if (campaigns.length > 1) {
    return verdict("multiple_matches", {
      detail: `${campaigns.length} campaigns match this deployment. GRAV will not choose between them.`,
      campaigns: campaigns.map((c) => ({ providerCampaignId: c.providerObjectId, status: c.status })),
    });
  }

  const one = found;
  const present = CREATION_ORDER.filter((role) => one.objects.some((o) => o.role === role));
  if (present.length !== CREATION_ORDER.length) {
    return verdict("incomplete_hierarchy", {
      detail: `${present.length} of the ${CREATION_ORDER.length} objects this campaign needs are there. What exists is stopped, so nothing is being shown.`,
      found: one,
      mismatches: CREATION_ORDER.filter((r) => !present.includes(r))
        .map((r) => ({ code: "OBJECT_MISSING", what: `The ${META_OBJECT_BY_CODE[r].label.toLowerCase()} is not there.` })),
    });
  }

  const mismatches = differencesFrom({ found: one, mapped, audience, approvedAsset });
  if (mismatches.length) {
    return verdict("mismatched_hierarchy", {
      detail: "The campaign exists and does not match what was approved.",
      found: one,
      mismatches,
    });
  }

  return verdict("one_complete_hierarchy", {
    detail: "Every object is there, every one that can deliver is stopped, and the audience, targeting and image are what was approved.",
    found: one,
  });
}

/**
 * The evidence a confirmed hierarchy is settled with.
 *
 * `origin` distinguishes the two cases that must never be collapsed: `created`
 * when GRAV watched the objects appear during its own sequence, `observed` when
 * a reconciliation went and found them afterwards.
 */
function evidenceFrom({ found, confirmed, readAt, origin = "observed" }) {
  const displayFor = (role) => (confirmed || []).find((c) => c.role === role)?.displayName || "";

  return found.objects
    .filter((o) => META_OBJECT_BY_CODE[o.role])
    .map((o) => {
      const applies = META_OBJECT_BY_CODE[o.role].deliveryStateApplies === true;
      return {
        role: o.role,
        providerObjectId: o.providerObjectId,
        providerObjectType: META_OBJECT_BY_CODE[o.role].providerNode,
        origin,
        deliveryStateApplies: applies,
        /* Confirmed by THIS read, which is the only way it is ever set. */
        nonDeliveringConfirmed: applies ? true : null,
        stateReadAt: applies ? readAt : null,
        observedState: applies ? str(o.status) : "",
        displayName: displayFor(o.role),
      };
    });
}

/**
 * Settle an unresolved attempt as a recovered success — and only that.
 *
 * `attempts.settle` refuses a second result for one intent, so calling this
 * twice cannot produce two conflicting accounts. Anything other than a complete
 * match returns without settling, leaving the attempt exactly where it was —
 * which is what keeps the next creation refused.
 *
 * It calls no provider write operation. There is no path from here to the write
 * client.
 */
async function settleIfComplete({ companyId, intent, verdict: v, confirmed, now = new Date() }) {
  if (!v.maySettle) {
    return { settled: false, outcome: v.outcome, reason: v.detail || v.outcomeMeans };
  }
  if (!v.found) {
    throw fail("INTERNAL", "A complete reconciliation arrived without the campaign it found.", { field: "found" });
  }

  const objects = evidenceFrom({ found: v.found, confirmed, readAt: now, origin: "observed" });

  const settled = await attempts.settle({
    companyId,
    intentId: intent._id,
    outcome: "succeeded",
    reasonCode: "RECOVERED_BY_MARKER",
    operatorNote: "GRAV did not receive an answer to one step of this creation. It later found the complete campaign, read back every object, every stopped state and the audience, targeting and image, and they match what was approved.",
    objects,
    now,
  });

  return {
    settled: true,
    duplicate: settled.created === false,
    outcome: v.outcome,
    result: settled.result,
    objects,
  };
}

/* ── WHAT A CALLER IS TOLD ──────────────────────────────────────────────────
   GRAV's own words. No Graph URL, no raw error, no token, no internal path.
   Provider object ids DO travel: a person reconciling by hand needs them and
   they are on every screen of the advertising interface. */
const publicVerdict = (v) => ({
  outcome: v.outcome,
  outcomeLabel: v.outcomeLabel,
  outcomeMeans: v.outcomeMeans,
  detail: v.detail || "",
  needsAdministrator: v.needsAdministrator,
  mayCreateAgain: false,
  mayCreateAgainMeans: "Nothing may be created for this deployment while its first attempt is unresolved, and a reconciliation never authorises one by itself.",
  campaign: v.found
    ? { providerCampaignId: v.found.objects.find((o) => o.role === "campaign")?.providerObjectId || null }
    : null,
  campaigns: v.campaigns || [],
  mismatches: (v.mismatches || []).map((m) => ({ code: m.code, what: m.what })),
});

module.exports = { inspect, settleIfComplete, publicVerdict, evidenceFrom, differencesFrom, OUTCOMES };
