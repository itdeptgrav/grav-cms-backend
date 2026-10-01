// services/marketing/channels/googleSearchBundle.js
//
// ONE REQUEST. THE WHOLE STOPPED CAMPAIGN, OR NOTHING.
//
// ── WHY THE SEQUENTIAL PROTOCOL HAD TO GO ──────────────────────────────────
// The first version created nine objects in nine calls. Every gap between two
// of them was a window in which the process could die, and the recovery story
// for each window was different: a budget with no campaign, a campaign with no
// ad group, a campaign fully built but with no location criteria — that last
// one being a campaign that runs EVERYWHERE the moment somebody enables it.
//
// The compensating rollback was the honest best effort, and it could not be
// made safe. Rolling back after a LOST response can delete objects a request
// that actually succeeded had created, and rolling back after a refusal still
// leaves whatever GRAV could not confirm removed.
//
// `GoogleAdsService.Mutate` takes operations across resource types in one
// request and applies them atomically. So there is one call, and exactly three
// outcomes:
//
//   the provider refused  → nothing was created, and nothing needs undoing
//   the provider accepted → the complete bundle exists
//   no response arrived   → unknown, until reconciliation by marker says
//
// There is no fourth state and no compensating delete anywhere in this file.
//
// ── TEMPORARY RESOURCE NAMES ARE WHAT MAKE IT ONE REQUEST ──────────────────
// A campaign needs its budget's resource name, an ad group needs its campaign's.
// Normally that means creating the parent first and reading the id back. Google
// allows a NEGATIVE id in a resource name to stand for "the thing created by an
// earlier operation in this same request" — `customers/123/campaignBudgets/-2`
// — and resolves them server-side.
//
// Two rules, both enforced below rather than trusted: every temporary id is
// unique across the whole request, and every one is DEFINED by an earlier
// operation before any later operation refers to it.
//
// ── THE CLOSED BOUNDARY ────────────────────────────────────────────────────
// One exported write operation, `createPausedAtomic`. It takes a validated GRAV
// command and resolved targeting, and builds everything itself. No caller can
// name a resource type, a URL, an HTTP method or an operation; there is no
// generic mutate; there is no update, activate, enable or publish verb in the
// file at all.
"use strict";

const secrets = require("./channelSecrets");
const http = require("./channelHttp");
const { fail } = require("../../storePurchase/errors");
const {
  NON_DELIVERING_STATUS,
  SEARCH_CHANNEL_TYPE,
} = require("../../../constants/marketingGoogleSearchDeployment");
const { assertMarker } = require("../deployment/deploymentMarker");

const googleApi = require("../../../constants/marketingGoogleAdsApi");
const googleErrors = require("./googleAdsErrors");

const CHANNEL = "google_ads";
/* The version is not chosen here: every URL is built by `versionedBase`, the
   same builder the read client uses, so the two cannot drift apart. */
const API_VERSION = googleApi.SELECTED_VERSION;

/* The one endpoint this file can reach. Not a parameter, not a template a
   caller contributes to — a constant, so "which URL" is not a question anything
   outside this module can influence. */
const MUTATE_PATH = "googleAds:mutate";

const str = (v) => String(v ?? "").trim();

const assertDigits = (value, field) => {
  const v = str(value).replace(/-/g, "");
  if (!/^\d{1,20}$/.test(v)) {
    throw fail("VALIDATION", "That is not an identifier this advertising channel uses.", { field });
  }
  return v;
};

/* ── THE OBJECT GRAPH, IN ORDER, WITH ITS TEMPORARY IDS ─────────────────────
   Declared as data so the ordering is readable, testable and not a property of
   how somebody happened to write a function. Negative, unique, and allocated
   once: the keyword and criterion operations extend past -10 by index.

   The order is dependency order and it is also the order Google applies them
   in, which is why the label is first: a campaign-label relationship cannot
   reference a label that no earlier operation has defined. */
const TEMP = Object.freeze({
  label: -1,
  budget: -2,
  campaign: -3,
  adGroup: -4,
  ad: -5,
  /* The lead form asset, referenced by its campaign link in the same request. */
  leadForm: -6,
  /* Bases for the repeated operations. Spaced far enough apart that a bundle
     would need thousands of keywords to collide, and the collision check below
     is what actually guarantees it rather than the spacing. */
  keyword: -1000,
  locationInclude: -2000,
  locationExclude: -3000,
  language: -4000,
});

const resource = (account, type, tempId) => `customers/${account}/${type}/${tempId}`;

/**
 * Refuse any payload carrying a status that could let an object deliver.
 *
 * Walks the whole structure: Google nests an ad's status beside `ad` and a
 * keyword's beside `keyword`, and a check on the outermost object would miss
 * both. Applied to every operation in the bundle, not to a sample.
 */
function assertNonDelivering(payload, { operation, allowed = NON_DELIVERING_STATUS, path = "" }) {
  if (Array.isArray(payload)) {
    payload.forEach((item, i) => assertNonDelivering(item, { operation, allowed, path: `${path}[${i}]` }));
    return payload;
  }
  if (!payload || typeof payload !== "object") return payload;

  for (const [key, value] of Object.entries(payload)) {
    const here = path ? `${path}.${key}` : key;
    if (key === "status") {
      if (str(value) !== allowed) {
        console.error(`[marketing-channel] ${CHANNEL} ${operation} refused: ${here} was ${str(value) || "(empty)"}`);
        throw fail("CHANNEL_UNSUPPORTED_OPERATION",
          "GRAV cannot start an advertising campaign. Every campaign it creates is created stopped.",
          { operation, field: here });
      }
    }
    assertNonDelivering(value, { operation, allowed, path: here });
  }
  return payload;
}

/**
 * Refuse a location criterion whose inclusion/exclusion flag is not explicit.
 *
 * Google's proto3 JSON omits a false boolean, so a criterion sent without
 * `negative` and one sent with `negative: false` are the same bytes. An
 * exclusion that lost its flag anywhere between the plan and this line becomes
 * an INCLUSION of the one place somebody said to stay out of, and nothing in
 * the response or on any provider screen would show it.
 */
function assertExclusionIntegrity(payload, { operation, expectNegative }) {
  if (!payload?.location) {
    if (expectNegative === true) {
      throw fail("CHANNEL_UNSUPPORTED_OPERATION",
        "The advertising channel has no way to exclude a language, so GRAV will not pretend to.",
        { operation, field: "negative" });
    }
    return payload;
  }
  if (typeof payload.negative !== "boolean") {
    throw fail("CHANNEL_UNSUPPORTED_OPERATION",
      "GRAV will not send a location to an advertising channel without saying whether it is targeted or excluded.",
      { operation, field: "negative" });
  }
  if (typeof expectNegative === "boolean" && payload.negative !== expectNegative) {
    throw fail("CHANNEL_UNSUPPORTED_OPERATION",
      expectNegative
        ? "GRAV was about to send an excluded location as a targeted one."
        : "GRAV was about to send a targeted location as an excluded one.",
      { operation, field: "negative" });
  }
  return payload;
}

/* ── THE ONLY OPERATION KEYS THIS FILE EMITS ────────────────────────────────
   A `MutateOperation` is a union — `campaignOperation`, `labelOperation` and so
   on — and each of those is itself a union of create/update/remove. This table
   says which unions exist here AND that only `create` is ever the inner key.

   It is checked over the built envelope, so a future edit that adds an
   `update` fails the assertion rather than shipping. That is the property worth
   having: "this file cannot change an existing object" becomes something a test
   proves about the bytes rather than something a reviewer has to believe. */
const ALLOWED_OPERATION_KEYS = Object.freeze([
  "labelOperation",
  "campaignBudgetOperation",
  "campaignOperation",
  "campaignLabelOperation",
  "adGroupOperation",
  "adGroupAdOperation",
  "adGroupCriterionOperation",
  "campaignCriterionOperation",
  /* A Google lead form and its link to the campaign — only when the mapping
     carries a lead form. Create only, like everything else here. */
  "assetOperation",
  "campaignAssetOperation",
]);

/* ── EVERY FIELD EACH CREATE MAY CARRY, IN GOOGLE v25's NAMES ──────────────
   Read from the v25 reference messages (Label, CampaignBudget, Campaign,
   CampaignLabel, AdGroup, AdGroupAd, AdGroupCriterion, CampaignCriterion) on
   2026-09-21. Checked over the built envelope, so a field Google does not know
   — `startDate`, which v25 replaced with `startDateTime`, is the one that was
   actually being sent — fails here instead of in Google's answer. */
const ALLOWED_CREATE_FIELDS = Object.freeze({
  labelOperation: ["resourceName", "name", "textLabel"],
  campaignBudgetOperation: ["resourceName", "name", "amountMicros", "totalAmountMicros", "deliveryMethod", "period", "explicitlyShared"],
  campaignOperation: [
    "resourceName", "name", "status", "advertisingChannelType", "startDateTime", "endDateTime",
    "networkSettings", "campaignBudget", "containsEuPoliticalAdvertising",
    "manualCpc", "targetSpend", "targetCpa",
  ],
  campaignLabelOperation: ["campaign", "label"],
  adGroupOperation: ["resourceName", "name", "status", "type", "campaign", "cpcBidMicros"],
  adGroupAdOperation: ["status", "ad", "adGroup"],
  adGroupCriterionOperation: ["status", "keyword", "adGroup"],
  campaignCriterionOperation: ["location", "language", "negative", "campaign"],
  /* v25 Asset / LeadFormAsset / CampaignAsset, read 2026-09-21. */
  assetOperation: ["resourceName", "name", "finalUrls", "leadFormAsset"],
  campaignAssetOperation: ["asset", "campaign", "fieldType", "status"],
});

/* Every field a `leadFormAsset` may carry, in v25's names. */
const LEAD_FORM_ASSET_FIELDS = Object.freeze([
  "businessName", "headline", "description", "callToActionType", "callToActionDescription",
  "privacyPolicyUrl", "fields", "postSubmitHeadline", "postSubmitDescription",
  "postSubmitCallToActionType", "deliveryMethods",
]);

/* The advertiser's declaration Google requires on every new campaign. */
const EU_DECLARATIONS = Object.freeze([
  "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
  "CONTAINS_EU_POLITICAL_ADVERTISING",
]);

/* ── INT64 TRAVELS AS TEXT ──────────────────────────────────────────────────
   Proto3 JSON's canonical form for int64 is a string, and a JavaScript number
   above 2^53 is already a different number. Every `*Micros` field is written
   as its exact digits, from a value that must be a whole, safe integer. */
function int64Text(value, field) {
  if (typeof value === "string" && /^\d{1,19}$/.test(value)) return value;
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  throw fail("INTERNAL", "GRAV was about to send an amount that is not a whole number of micros.", { field });
}
function microsAsText(payload, path = "") {
  if (Array.isArray(payload)) return payload.map((v, i) => microsAsText(v, `${path}[${i}]`));
  if (!payload || typeof payload !== "object") return payload;
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    const here = path ? `${path}.${k}` : k;
    out[k] = /Micros$/.test(k) ? int64Text(v, here) : microsAsText(v, here);
  }
  return out;
}

/**
 * Build the complete mutate envelope for one stopped Google Search campaign.
 *
 * ── PURE ───────────────────────────────────────────────────────────────────
 * No network, no clock, no randomness, no environment. The same command and the
 * same targeting produce the same bytes, which is what lets the validate-only
 * request be THE request rather than an approximation of it, and what lets a
 * test assert the exact operation sequence.
 *
 * @param {object} command                the validated GRAV deployment command
 * @param {string} command.customerId     the bound account
 * @param {string} command.marker         the GRAV deployment marker
 * @param {object} command.mapping        the deterministic mapper's output
 * @param {object} command.resolvedTargeting
 */
function buildBundle({ customerId, marker, mapping, resolvedTargeting, leadDelivery = null }) {
  const account = assertDigits(customerId, "customerId");
  const label = assertMarker(marker, "marker");

  if (!mapping || !mapping.summary || !Array.isArray(mapping.objects)) {
    throw fail("VALIDATION", "A campaign bundle needs a mapped campaign to build from.", { field: "mapping" });
  }
  const targeting = resolvedTargeting || null;
  if (!targeting || targeting.complete !== true) {
    /* The bundle cannot be built from unresolved targeting, and it is not this
       file's job to decide what to do about that — the preflight already
       refused. This is the last line, not the first. */
    throw fail("VALIDATION",
      "A campaign bundle needs every location and language resolved.",
      { field: "resolvedTargeting" });
  }

  /* The mapper's objects, by role. Built from ITS output rather than rebuilt
     here, so there is exactly one place that decides what a GRAV plan becomes. */
  const byRole = (role) => mapping.objects.filter((o) => o.role === role);
  const one = (role) => {
    const found = byRole(role);
    if (found.length !== 1) {
      throw fail("VALIDATION", "The mapped campaign is not a single Google Search campaign.", { field: role });
    }
    return found[0];
  };

  const budget = one("budget");
  const campaign = one("campaign");
  const adGroup = one("audience_group");
  const ad = one("advertisement");
  const keywords = byRole("targeting_term");
  const criteria = byRole("location_target").concat(byRole("language_target"));

  const name = (type, tempId) => resource(account, type, tempId);

  const operations = [];

  /* ── 1. THE MARKER LABEL ────────────────────────────────────────────────
     First, because the campaign-label relationship below refers to it. Its text
     colour and description are GRAV's own and carry no business text: an
     advertising account is visible to agencies and contractors, and a label is
     visible to all of them. */
  operations.push({
    labelOperation: {
      create: {
        resourceName: name("labels", TEMP.label),
        name: label,
        textLabel: {
          backgroundColor: "#2b6cb0",
          description: "GRAV deployment marker. Do not rename or delete.",
        },
      },
    },
  });

  /* ── 2. THE BUDGET ──────────────────────────────────────────────────────── */
  operations.push({
    campaignBudgetOperation: {
      create: { resourceName: name("campaignBudgets", TEMP.budget), ...microsAsText(budget.payload) },
    },
  });

  /* ── 3. THE CAMPAIGN, STOPPED, POINTING AT THE TEMPORARY BUDGET ─────────── */
  operations.push({
    campaignOperation: {
      create: {
        resourceName: name("campaigns", TEMP.campaign),
        ...microsAsText(campaign.payload),
        campaignBudget: name("campaignBudgets", TEMP.budget),
      },
    },
  });

  /* ── 4. THE MARKER, ATTACHED TO THIS CAMPAIGN, IN THIS REQUEST ──────────
     The whole point of the atomic bundle. A campaign carrying this label exists
     if and only if this one request succeeded — so reconciliation after a lost
     response has an answer that a campaign name could never give it. */
  operations.push({
    campaignLabelOperation: {
      create: {
        campaign: name("campaigns", TEMP.campaign),
        label: name("labels", TEMP.label),
      },
    },
  });

  /* ── 5. THE AD GROUP ────────────────────────────────────────────────────── */
  operations.push({
    adGroupOperation: {
      create: {
        resourceName: name("adGroups", TEMP.adGroup),
        ...microsAsText(adGroup.payload),
        campaign: name("campaigns", TEMP.campaign),
      },
    },
  });

  /* ── 6. THE RESPONSIVE SEARCH ADVERTISEMENT ───────────────────────────────
     No resource name. An ad's name in Google is composite
     (`adGroupAds/{ad_group_id}~{ad_id}`), a bare negative id is not a form
     Google documents for it, and nothing later in the request refers to the
     ad — Google's own example omits it for exactly that reason. The same holds
     for keywords and campaign criteria below. */
  operations.push({
    adGroupAdOperation: {
      create: {
        ...ad.payload,
        adGroup: name("adGroups", TEMP.adGroup),
      },
    },
  });

  /* ── 7. THE KEYWORDS ────────────────────────────────────────────────────── */
  keywords.forEach((kw) => {
    operations.push({
      adGroupCriterionOperation: {
        create: {
          ...kw.payload,
          adGroup: name("adGroups", TEMP.adGroup),
        },
      },
    });
  });

  /* ── 8 AND 9. THE TARGETING, INCLUDED AND EXCLUDED ──────────────────────
     Separate temporary-id ranges for inclusions and exclusions, so a test can
     see at a glance which range an operation came from and a misfiled one is
     visible rather than buried in a boolean. */
  for (const criterion of criteria) {
    operations.push({
      campaignCriterionOperation: {
        create: {
          ...criterion.payload,
          campaign: name("campaigns", TEMP.campaign),
        },
      },
    });
  }

  /* ── 10 AND 11. THE LEAD FORM, AND ITS PAUSED LINK ────────────────────────
     Only when the mapping carries one. The delivery — the address Google posts
     each enquiry to and the secret it echoes — is injected here, at the last
     moment, from the command: it is never part of the mapping, so it is never
     fingerprinted, stored, compared or handed to reconciliation. */
  const leadForm = mapping.objects.filter((o) => o.role === "lead_form");
  const leadLink = mapping.objects.filter((o) => o.role === "lead_form_link");
  if (leadForm.length || leadLink.length) {
    if (leadForm.length !== 1 || leadLink.length !== 1) {
      throw fail("VALIDATION", "A lead-form campaign carries exactly one form and one link to it.", { field: "mapping" });
    }
    const url = str(leadDelivery?.url);
    const secret = typeof leadDelivery?.secret === "string" ? leadDelivery.secret : "";
    if (!/^https:\/\//.test(url) || !secret) {
      throw fail("INTERNAL",
        "GRAV was about to create a lead form without a secure delivery address and its secret, so enquiries from it would reach nobody.",
        { field: "leadDelivery" });
    }
    const schemaVersion = Number(leadDelivery?.payloadSchemaVersion);
    operations.push({
      assetOperation: {
        create: {
          resourceName: name("assets", TEMP.leadForm),
          ...leadForm[0].payload,
          leadFormAsset: {
            ...leadForm[0].payload.leadFormAsset,
            /* Google: "Only one method typed as WebhookDelivery can be configured." */
            deliveryMethods: [{
              webhook: {
                advertiserWebhookUrl: url,
                googleSecret: secret,
                /* int64 in v25, so text. */
                payloadSchemaVersion: int64Text(schemaVersion, "payloadSchemaVersion"),
              },
            }],
          },
        },
      },
    });
    operations.push({
      campaignAssetOperation: {
        create: {
          ...leadLink[0].payload,
          asset: name("assets", TEMP.leadForm),
          campaign: name("campaigns", TEMP.campaign),
        },
      },
    });
  }

  return { account, label, operations };
}

/**
 * Prove the envelope is what it claims to be, before it is sent.
 *
 * Six things, every one of which has a failure mode that is silent in
 * production and expensive when it happens.
 */
function assertBundleIntegrity({ operations, account, targeting }) {
  const defined = new Set();

  operations.forEach((op, index) => {
    const keys = Object.keys(op);
    if (keys.length !== 1 || !ALLOWED_OPERATION_KEYS.includes(keys[0])) {
      throw fail("CHANNEL_UNSUPPORTED_OPERATION",
        "GRAV does not perform that operation in an advertising channel.",
        { field: `operations.${index}` });
    }

    const inner = op[keys[0]];
    const innerKeys = Object.keys(inner);
    /* ── CREATE, AND ONLY CREATE ────────────────────────────────────────
       An `update` here would be the one thing that could change an existing
       object — including its status. There is none, and this is what says so
       about the actual bytes rather than about the source. */
    if (innerKeys.length !== 1 || innerKeys[0] !== "create") {
      throw fail("CHANNEL_UNSUPPORTED_OPERATION",
        "GRAV only creates in an advertising channel. It does not change or start anything.",
        { field: `operations.${index}.${innerKeys[0] || "?"}` });
    }

    const payload = inner.create;

    /* ── ONLY FIELDS GOOGLE v25 KNOWS ───────────────────────────────────── */
    const allowed = ALLOWED_CREATE_FIELDS[keys[0]];
    for (const field of Object.keys(payload)) {
      if (!allowed.includes(field)) {
        throw fail("INTERNAL",
          "GRAV was about to send a field the advertising channel does not accept.",
          { field: `operations.${index}.${field}` });
      }
    }
    if (keys[0] === "assetOperation") {
      const lf = payload.leadFormAsset || {};
      for (const f of Object.keys(lf)) {
        if (!LEAD_FORM_ASSET_FIELDS.includes(f)) {
          throw fail("INTERNAL", "GRAV was about to send a lead-form field the advertising channel does not accept.",
            { field: `operations.${index}.leadFormAsset.${f}` });
        }
      }
      const methods = Array.isArray(lf.deliveryMethods) ? lf.deliveryMethods : [];
      if (methods.length !== 1 || !/^https:\/\//.test(str(methods[0]?.webhook?.advertiserWebhookUrl))
        || !str(methods[0]?.webhook?.googleSecret)) {
        throw fail("INTERNAL", "A lead form must deliver to exactly one secure GRAV address.",
          { field: `operations.${index}.leadFormAsset.deliveryMethods` });
      }
    }
    if (keys[0] === "campaignAssetOperation"
      && (payload.fieldType !== "LEAD_FORM" || payload.status !== NON_DELIVERING_STATUS)) {
      throw fail("INTERNAL", "A lead form must be attached as a lead form, and stopped.",
        { field: `operations.${index}` });
    }
    if (keys[0] === "campaignOperation" && !EU_DECLARATIONS.includes(payload.containsEuPoliticalAdvertising)) {
      throw fail("INTERNAL",
        "GRAV was about to create a campaign without the advertiser's EU political-advertising declaration.",
        { field: `operations.${index}.containsEuPoliticalAdvertising` });
    }

    /* ── NOTHING CAN DELIVER ────────────────────────────────────────────── */
    assertNonDelivering(payload, { operation: `operations.${index}` });

    /* ── EVERY REFERENCE RESOLVES TO SOMETHING ALREADY DEFINED ──────────
       A temporary id referenced before the operation that defines it is
       rejected by Google with a field error that names an index, and the
       request creates nothing. Caught here instead, where the message can say
       which object was out of order. */
    for (const [field, value] of Object.entries(payload)) {
      if (field === "resourceName") continue;
      if (typeof value !== "string" || !value.startsWith(`customers/${account}/`)) continue;
      const temp = Number(value.split("/").pop());
      if (!Number.isInteger(temp) || temp >= 0) continue;
      if (!defined.has(value)) {
        throw fail("INTERNAL",
          "GRAV built the advertising objects out of order.",
          { field: `operations.${index}.${field}` });
      }
    }

    /* ── AND ITS OWN TEMPORARY ID IS NEW ────────────────────────────────
       Two operations sharing one temporary id makes the second silently
       overwrite the first's meaning — a keyword that becomes a location, a
       campaign that points at the wrong budget. Google would accept some of
       these. */
    const own = str(payload.resourceName);
    if (own) {
      if (defined.has(own)) {
        throw fail("INTERNAL",
          "GRAV built two advertising objects with the same temporary identifier.",
          { field: `operations.${index}.resourceName` });
      }
      defined.add(own);
    }
  });

  /* ── THE TARGETING INTENT SURVIVED THE BUILD ────────────────────────────
     Counted off the envelope against the resolution, so an inclusion that
     became an exclusion — or a criterion that was simply dropped — is caught
     before the one request that creates anything. */
  const criterionOps = operations
    .filter((op) => op.campaignCriterionOperation)
    .map((op) => op.campaignCriterionOperation.create);

  const sentIncluded = criterionOps.filter((c) => c.location && c.negative === false)
    .map((c) => c.location.geoTargetConstant).sort();
  const sentExcluded = criterionOps.filter((c) => c.location && c.negative === true)
    .map((c) => c.location.geoTargetConstant).sort();
  const sentLanguages = criterionOps.filter((c) => c.language)
    .map((c) => c.language.languageConstant).sort();

  const wantIncluded = (targeting.locations || []).map((l) => l.resourceName).sort();
  const wantExcluded = (targeting.exclusions || []).map((l) => l.resourceName).sort();
  const wantLanguages = (targeting.languages || []).map((l) => l.resourceName).sort();

  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  if (!same(sentIncluded, wantIncluded) || !same(sentExcluded, wantExcluded) || !same(sentLanguages, wantLanguages)) {
    throw fail("INTERNAL",
      "The advertising targeting GRAV was about to send does not match the targeting that was approved and resolved.",
      { field: "operations" });
  }

  for (const c of criterionOps) {
    assertExclusionIntegrity(c, {
      operation: "campaignCriterion",
      expectNegative: c.location ? c.negative === true : false,
    });
  }

  if (!wantIncluded.length) {
    /* Belt and braces over the preflight: an envelope with no location
       inclusion creates a campaign that runs everywhere. */
    throw fail("INTERNAL",
      "GRAV was about to create a campaign with no location targeting.",
      { field: "operations" });
  }

  return operations;
}

function headersFor(creds, token, loginCustomerId) {
  /* No developer token: sunset by Google on 2026-09-09. See the read client. */
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const manager = loginCustomerId || creds.loginCustomerId;
  if (manager) headers["login-customer-id"] = str(manager);
  return headers;
}

const httpAuthorise = async (env) => {
  const creds = secrets.credentials(CHANNEL, env);
  const token = await require("./googleAdsClient").__test.accessTokenFor(creds);
  return { creds, token };
};

/* ── THE TRANSPORT, AND WHY IT NEVER RETRIES ────────────────────────────────
   A create that timed out may have succeeded. A retry inside the transport
   would send the whole bundle a second time with nothing recording the first,
   and Google would create a second complete campaign. Retry is not a transport
   decision; it is a decision made against the attempt record after
   reconciliation, and this chunk does not make it automatically at all. */
const httpTransport = async ({ url, headers, data, operation }) => http.perform({
  channel: CHANNEL,
  operation,
  method: "POST",
  mutationIntent: true,
  url,
  headers,
  data,
  retries: 0,
  classify: googleErrors.classify,
});

/* Google returns one `mutateOperationResponses` entry per operation, in order,
   each carrying the created resource name under its own union key. */
const RESPONSE_KEY_TO_ROLE = Object.freeze({
  labelResult: "marker_label",
  campaignBudgetResult: "budget",
  campaignResult: "campaign",
  campaignLabelResult: "marker_relationship",
  adGroupResult: "audience_group",
  adGroupAdResult: "advertisement",
  adGroupCriterionResult: "targeting_term",
  campaignCriterionResult: "targeting_criterion",
  assetResult: "lead_form",
  campaignAssetResult: "lead_form_link",
});

function readResults(data, { operation, expected }) {
  http.requireObject(data, { channel: CHANNEL, operation, what: "the response" });
  http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });

  const responses = http.requireArray(data, "mutateOperationResponses",
    { channel: CHANNEL, operation, absentMeansEmpty: false });

  /* ── ONE RESULT PER OPERATION, OR GRAV DOES NOT KNOW WHAT IT MADE ───────
       A short response after an atomic request should be impossible. If it
       happens, treating it as a partial success would record a campaign whose
       objects GRAV cannot name. */
  if (responses.length !== expected) {
    console.error(`[marketing-channel] ${CHANNEL} ${operation}: ${responses.length} results for ${expected} operations`);
    throw fail("CHANNEL_MALFORMED_RESPONSE",
      "The advertising channel's answer did not account for everything GRAV asked it to create.",
      { channel: CHANNEL, operation });
  }

  return responses.map((row, index) => {
    const key = Object.keys(row || {})[0];
    const role = RESPONSE_KEY_TO_ROLE[key];
    const resourceName = str(row?.[key]?.resourceName);
    if (!role || !resourceName) {
      throw fail("CHANNEL_MALFORMED_RESPONSE",
        "The advertising channel accepted the request without saying what it created.",
        { channel: CHANNEL, operation });
    }
    return { index, role, resourceName, providerObjectId: resourceName.split("/").pop() };
  });
}

/**
 * Create the complete stopped Google Search campaign, atomically.
 *
 * @param {object}  command
 * @param {string}  command.customerId        the BOUND account. Never defaulted.
 * @param {string?} command.loginCustomerId   the bound manager account
 * @param {string}  command.marker            the GRAV deployment marker
 * @param {object}  command.mapping           the deterministic mapper's output
 * @param {object}  command.resolvedTargeting
 * @param {string}  command.requestId
 * @param {boolean} [command.validateOnly]    build and send the SAME envelope,
 *                                            asking the channel to check it and
 *                                            create nothing
 */
async function createPausedAtomic(command, { transport, authorise, env = process.env } = {}) {
  const { account, operations } = buildBundle(command);
  if (command.leadDelivery) {
    /* Proven on the bytes: the address sent is the address the binding owns. */
    const sent = operations.find((op) => op.assetOperation);
    if (!sent || str(sent.assetOperation.create.leadFormAsset.deliveryMethods[0].webhook.advertiserWebhookUrl) !== str(command.leadDelivery.url)) {
      throw fail("INTERNAL", "The lead form's delivery address is not the one GRAV prepared for it.", { field: "leadDelivery" });
    }
  }

  assertBundleIntegrity({ operations, account, targeting: command.resolvedTargeting });

  const validateOnly = command.validateOnly === true;
  const operation = validateOnly ? "googleSearchBundle.validateOnly" : "googleSearchBundle.createPausedAtomic";

  const manager = command.loginCustomerId ? assertDigits(command.loginCustomerId, "loginCustomerId") : null;
  const send = transport || httpTransport;
  const { creds, token } = await (authorise || httpAuthorise)(env);

  const { data } = await send({
    operation,
    url: `${googleErrors.versionedBase(env)}/customers/${account}/${MUTATE_PATH}`,
    headers: headersFor(creds, token, manager),
    data: {
      mutateOperations: operations,
      /* ── ALL OR NOTHING, STATED ────────────────────────────────────────
         Google's default is already false. It is written anyway, because the
         entire recovery story depends on it: `true` would let the budget and
         campaign be created while the location criteria failed, and report
         success — a campaign that runs everywhere, recorded as fine. */
      partialFailure: false,
      /* Build the request, have the channel check every operation in it, and
         create nothing. The SAME envelope, not an approximation of it. */
      ...(validateOnly ? { validateOnly: true } : {}),
      /* No `requestId`: v25's MutateGoogleAdsRequest has no such field
         (customer_id, mutate_operations, partial_failure, validate_only and
         response_content_type only), so sending one would fail the whole
         request. Idempotency is the attempt record's job and always was. */
    },
  });

  if (validateOnly) {
    /* A validate-only request returns no results. Reaching here at all is the
       answer: the channel accepted every operation. */
    http.requireObject(data, { channel: CHANNEL, operation, what: "the response" });
    http.assertNoErrorEnvelope(data, { channel: CHANNEL, operation });
    return { validated: true, operationCount: operations.length, results: [] };
  }

  return {
    validated: false,
    operationCount: operations.length,
    results: readResults(data, { operation, expected: operations.length }),
  };
}

module.exports = {
  CHANNEL,
  API_VERSION,
  createPausedAtomic,
  /* Pure, exported for the suites that assert the exact envelope without a
     transport. Neither can send anything. */
  buildBundle,
  assertBundleIntegrity,
  assertNonDelivering,
  assertExclusionIntegrity,
  TEMP,
  ALLOWED_OPERATION_KEYS,
  ALLOWED_CREATE_FIELDS,
  EU_DECLARATIONS,
  LEAD_FORM_ASSET_FIELDS,
};
