// services/marketing/deployment/targetingResolution.service.js
//
// TURNING THE PLACES AND LANGUAGES SOMEBODY TYPED INTO IDENTIFIERS GOOGLE USES.
//
// ── THE RELEASE BLOCKER THIS EXISTS FOR ────────────────────────────────────
// The first version of the deployment chunk created a campaign with NO location
// and NO language criteria, and reported that honestly as a decision: "the two
// locations in the plan are not applied". In Google, a Search campaign with no
// location criteria targets EVERYWHERE, and one with no language criteria
// targets every language.
//
// It was created stopped, so nothing was spent. But a stopped campaign is one
// button away from a running one, and the person who presses that button in
// Google Ads is looking at a campaign that appears complete. They do not see
// GRAV's disclosure. Within hours it is buying clicks in countries nobody chose.
//
// A disclosure after creation does not contain that risk. Only a refusal before
// creation does, which is what this file makes possible.
//
// ── FIVE ANSWERS, NOT TWO ──────────────────────────────────────────────────
// Every name produces exactly one of: resolved, ambiguous, not_found,
// unsupported, provider_unavailable. Four of those five block creation, and they
// block it for different reasons that a person needs told apart — "you spelled
// it differently from Google" and "Google did not answer" lead to completely
// different actions.
//
// ── AND NOTHING IS CHOSEN AUTOMATICALLY ────────────────────────────────────
// Several matches is `ambiguous`, never "the first one". Google will happily
// answer "Cambridge" with a ranked list, and taking the top would target
// Cambridgeshire when somebody meant Massachusetts. Nobody reviews a criterion
// id, and the campaign would look perfectly correct on every screen.
"use strict";

const crypto = require("crypto");

const googleAds = require("../channels/googleAdsClient");
const { stableJson } = require("../campaignDrafts/campaignAllocation.service");
const {
  TARGETING_OUTCOMES,
  TARGETING_BLOCKING_OUTCOMES,
  GEO_KIND_TO_TARGET_TYPES,
  UNSUPPORTED_GEO_KINDS,
} = require("../../../constants/marketingGoogleSearchDeployment");

const str = (v) => String(v ?? "").trim();

const OUTCOME_BY_CODE = Object.fromEntries(TARGETING_OUTCOMES.map((o) => [o.code, o]));

/* ── WHAT A CALLER IS TOLD ABOUT ONE REQUESTED TARGET ───────────────────────
   The name the author wrote is kept beside whatever GRAV found, always. An
   identifier alone is unreadable, and a resolution somebody cannot check against
   what they asked for is a resolution nobody will check. */
const entry = (requested, outcome, extra = {}) => ({
  requested,
  outcome,
  outcomeLabel: OUTCOME_BY_CODE[outcome]?.label || outcome,
  outcomeMeans: OUTCOME_BY_CODE[outcome]?.means || "",
  blocksCreation: TARGETING_BLOCKING_OUTCOMES.includes(outcome),
  criterionId: null,
  resourceName: null,
  canonicalName: null,
  candidates: [],
  ...extra,
});

/* ── A CANDIDATE, SAFE TO SHOW A PERSON ─────────────────────────────────────
   Enough for somebody to pick the right one later: the identifier, the full
   canonical name Google shows ("Cambridge, Massachusetts, United States"), what
   kind of place it is and which country it is in. No URL, no credential name,
   no provider error, no raw row. */
const candidate = (c) => ({
  criterionId: c.criterionId,
  canonicalName: c.canonicalName || c.name,
  targetType: c.targetType,
  countryCode: c.countryCode || null,
});

/**
 * Resolve one requested location.
 *
 * `kind` narrows the query to Google's own target types for that kind, which is
 * what turns the commonest ambiguity — a city and a county sharing a name — into
 * a single match when the author said which they meant.
 */
async function resolveLocation({ client, bound, target }) {
  const requested = { name: str(target?.name), kind: str(target?.kind) };

  if (UNSUPPORTED_GEO_KINDS.includes(requested.kind)) {
    return entry(requested, "unsupported", {
      detail: "GRAV does not hold a centre point and a distance, so it cannot express an area drawn on a map as advertising targeting. Name a city, region or country instead.",
    });
  }

  const targetTypes = GEO_KIND_TO_TARGET_TYPES[requested.kind];
  if (!targetTypes) {
    return entry(requested, "unsupported", {
      detail: "GRAV cannot express that kind of place as advertising targeting.",
    });
  }

  let found;
  try {
    found = await client.findGeoTargets({
      customerId: bound.externalAccountId,
      loginCustomerId: bound.loginAccountId,
      name: requested.name,
      targetTypes: [...targetTypes],
    });
  } catch {
    /* ── AN OUTAGE IS NOT A WRONG NAME ────────────────────────────────────
       Reporting it as `not_found` would send somebody to re-spell a location
       that was correct. The provider's own message is not carried; it went to
       the server log through `channelHttp`. */
    return entry(requested, "provider_unavailable", {
      detail: "The advertising channel did not answer, so this location could not be looked up.",
    });
  }

  if (!found.length) {
    return entry(requested, "not_found", {
      detail: "No location of that kind carries this name in the advertising channel. It may be spelled differently there.",
    });
  }

  if (found.length > 1) {
    return entry(requested, "ambiguous", {
      detail: `${found.length} locations carry this name. Somebody has to say which one was meant.`,
      candidates: found.map(candidate),
    });
  }

  const one = found[0];
  return entry(requested, "resolved", {
    criterionId: one.criterionId,
    resourceName: one.resourceName,
    canonicalName: one.canonicalName || one.name,
    targetType: one.targetType,
    countryCode: one.countryCode || null,
  });
}

/** Resolve one requested language tag. */
async function resolveLanguage({ client, bound, tag }) {
  const requested = { tag: str(tag) };

  if (!requested.tag) {
    return entry(requested, "not_found", { detail: "No language was given." });
  }

  let found;
  try {
    found = await client.findLanguages({
      customerId: bound.externalAccountId,
      loginCustomerId: bound.loginAccountId,
      code: requested.tag,
    });
  } catch {
    return entry(requested, "provider_unavailable", {
      detail: "The advertising channel did not answer, so this language could not be looked up.",
    });
  }

  if (!found.length) {
    return entry(requested, "not_found", {
      detail: "The advertising channel does not offer a targetable language with that code.",
    });
  }
  if (found.length > 1) {
    return entry(requested, "ambiguous", {
      detail: `${found.length} languages carry this code.`,
      candidates: found.map((c) => ({ criterionId: c.criterionId, canonicalName: c.name, targetType: "Language", countryCode: null })),
    });
  }

  const one = found[0];
  return entry(requested, "resolved", {
    criterionId: one.criterionId,
    resourceName: one.resourceName,
    canonicalName: one.name,
    code: one.code,
  });
}

/**
 * Resolve every location, exclusion and language on a plan's Google brief.
 *
 * ── FENCED TO ONE PLAN REVISION AND ONE ACCOUNT ────────────────────────────
 * The result carries `resolvedFor`, and its fingerprint is computed over it.
 * Criterion ids are account-independent in Google today, but the ACCOUNT is
 * still part of the fence: a resolution made against an account somebody has
 * since rebound was made against a different advertising surface, and carrying
 * it forward would mean targeting confirmed in one account applied in another.
 * The plan revision is part of it for the obvious reason — a plan edited after
 * being resolved is a different plan.
 */
async function resolve({ plan, bound, brief = null }, deps = {}) {
  const client = deps.googleAds || googleAds;

  const theBrief = brief
    || (plan?.deploymentBriefs || []).find((b) => b.channel === "google_ads")
    || null;

  const resolvedFor = {
    campaignDraftId: String(plan?._id || ""),
    draftRef: str(plan?.draftRef),
    approvedRevision: Number(plan?.revision) || 0,
    externalAccountId: str(bound?.externalAccountId),
    /* Which binding, and which version of it. A rebind to the same account
       number after a verification failure is still a new decision. */
    bindingId: String(bound?.bindingId || ""),
    bindingRevision: Number(bound?.bindingRevision) || 0,
  };

  if (!theBrief) {
    return {
      resolvedFor,
      locations: [],
      exclusions: [],
      languages: [],
      complete: false,
      blockers: [{ code: "BRIEF_MISSING", field: "deploymentBriefs", message: "The plan has no Google Ads brief." }],
      fingerprint: fingerprintOf({ resolvedFor, locations: [], exclusions: [], languages: [] }),
    };
  }

  /* Sequential rather than parallel: these are reads against one account whose
     API is rate-limited per client, and a plan with fifty locations firing fifty
     concurrent requests is how a resolution starts returning
     `provider_unavailable` for reasons that are GRAV's own fault. */
  const locations = [];
  for (const target of theBrief.geoTargeting || []) {
    locations.push(await resolveLocation({ client, bound, target }));
  }

  const exclusions = [];
  for (const target of theBrief.geoExclusions || []) {
    exclusions.push(await resolveLocation({ client, bound, target }));
  }

  const languages = [];
  for (const tag of theBrief.languages || []) {
    languages.push(await resolveLanguage({ client, bound, tag }));
  }

  const blockers = [];
  const blocked = (list, field, label) => list
    .filter((e) => e.blocksCreation)
    .forEach((e, i) => blockers.push({
      code: `${field.toUpperCase()}_${e.outcome.toUpperCase()}`,
      field: `${field}.${i}`,
      message: `${label} "${e.requested.name || e.requested.tag}": ${e.detail || e.outcomeMeans}`,
      outcome: e.outcome,
      candidates: e.candidates,
    }));

  blocked(locations, "geoTargeting", "Location");
  blocked(exclusions, "geoExclusions", "Excluded location");
  blocked(languages, "languages", "Language");

  /* ── NO TARGETING IS NOT THE SAME AS TARGETING NOTHING ──────────────────
     In Google an absent location criterion means EVERYWHERE. A plan that named
     no location cannot be created, because the campaign it would produce is a
     worldwide campaign nobody approved. */
  if (!(theBrief.geoTargeting || []).length) {
    blockers.push({
      code: "GEO_NONE_SELECTED",
      field: "geoTargeting",
      message: "The plan names no location. A campaign created with no location targeting is shown everywhere in the world, so GRAV will not create one.",
      outcome: "not_found",
      candidates: [],
    });
  }

  /* ── A PLACE CANNOT BE BOTH TARGETED AND AVOIDED ────────────────────────
     Google accepts both criteria and resolves the conflict by its own rules.
     Whichever way it resolves, one of the two things somebody asked for is not
     happening, and nothing on any screen says which. Refused instead. */
  const includedIds = new Set(locations.filter((l) => l.criterionId).map((l) => l.criterionId));
  for (const [i, ex] of exclusions.entries()) {
    if (ex.criterionId && includedIds.has(ex.criterionId)) {
      blockers.push({
        code: "GEO_INCLUDED_AND_EXCLUDED",
        field: `geoExclusions.${i}`,
        message: `"${ex.canonicalName || ex.requested.name}" is both targeted and excluded. GRAV will not send the advertising channel two instructions that contradict each other.`,
        outcome: "ambiguous",
        candidates: [],
      });
    }
  }

  const complete = blockers.length === 0;

  const result = { resolvedFor, locations, exclusions, languages };
  return { ...result, complete, blockers, fingerprint: fingerprintOf(result) };
}

/* ── THE FENCE, AS ONE VALUE ────────────────────────────────────────────────
   Over the plan revision, the account, and every requested name with the
   identifier it resolved to. Changing any location, exclusion, language, the
   account binding or the approved revision produces a different fingerprint,
   which is what makes a stale preflight detectable rather than merely unlikely.

   Candidate lists and human labels are deliberately excluded: they are what
   Google happened to return, and a wording change there is not a change to the
   targeting anybody approved. */
function fingerprintOf({ resolvedFor, locations, exclusions, languages }) {
  const basis = {
    resolvedFor,
    locations: locations.map((l) => ({ name: l.requested.name, kind: l.requested.kind, outcome: l.outcome, criterionId: l.criterionId })),
    exclusions: exclusions.map((l) => ({ name: l.requested.name, kind: l.requested.kind, outcome: l.outcome, criterionId: l.criterionId })),
    languages: languages.map((l) => ({ tag: l.requested.tag, outcome: l.outcome, criterionId: l.criterionId })),
  };
  return crypto.createHash("sha256").update(stableJson(basis)).digest("hex").slice(0, 32);
}

/**
 * The provider-neutral targeting section a preflight publishes.
 *
 * No Google API path, no credential name, no bearer value, no raw error. A
 * criterion id IS published — it is the number the advertising interface shows
 * beside every location, and somebody checking GRAV against Google Ads needs it.
 */
function publicTargeting(resolution) {
  const view = (e) => ({
    requested: e.requested,
    outcome: e.outcome,
    outcomeLabel: e.outcomeLabel,
    outcomeMeans: e.outcomeMeans,
    blocksCreation: e.blocksCreation,
    resolvedId: e.criterionId,
    resolvedName: e.canonicalName,
    /* Only ever populated for `ambiguous`, and only with what a person needs to
       choose between them. */
    candidates: e.candidates,
    detail: e.detail || "",
  });

  const unresolved = [...resolution.locations, ...resolution.exclusions, ...resolution.languages]
    .filter((e) => e.blocksCreation);

  return {
    requestedLocations: resolution.locations.map(view),
    requestedExclusions: resolution.exclusions.map(view),
    requestedLanguages: resolution.languages.map(view),
    /* The flat list a screen leads with. */
    unresolved: unresolved.map(view),
    /* The single question the caller actually has. */
    allApprovedTargetingCanBeApplied: resolution.complete === true,
    blockers: resolution.blockers,
    /* The fence, published so a creation can be checked against the preflight
       somebody actually looked at. */
    fingerprint: resolution.fingerprint,
    resolvedFor: resolution.resolvedFor,
  };
}

/** Do two resolutions describe the same plan revision and the same account? */
const sameFence = (a, b) => stableJson(a || {}) === stableJson(b || {});

module.exports = {
  resolve,
  publicTargeting,
  fingerprintOf,
  sameFence,
  /* Exported for the suites that prove one name's behaviour without a plan. */
  resolveLocation,
  resolveLanguage,
};
