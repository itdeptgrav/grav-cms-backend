// services/marketing/deployment/metaTargetingResolution.service.js
//
// THE PLACES, LANGUAGES AND AGES SOMEBODY TYPED → WHAT META ACTUALLY TARGETS.
//
// ── THE SAME FIVE ANSWERS AS GOOGLE, FOR THE SAME REASON ───────────────────
// `resolved`, `ambiguous`, `not_found`, `unsupported`, `provider_unavailable`.
// The vocabulary is shared deliberately: a marketer reading a Meta preflight
// and a Google one should not have to learn two ways of being told the same
// thing, and the four blocking outcomes block for the same reasons.
//
// What differs is what Meta targets BY. Its `targeting` object takes locations
// by an opaque key — a country is `"IN"`, a city is a string only Meta issues —
// and languages by numeric locale id. Age is different again: `age_min` and
// `age_max` are plain integers inside Meta's own bounds, so they are VALIDATED
// rather than looked up, and saying so here is what stops somebody building a
// pointless lookup for them.
//
// ── AND THE SUGGESTION ENDPOINT IS THE TRAP ────────────────────────────────
// Meta's search is a SUGGESTION service. It answers "Cambridge" with a ranked
// list, and it will answer a misspelling with something plausible. Taking the
// first result would target a place nobody chose, and nobody reviews a location
// key. So matches are compared EXACTLY against the name that was asked for,
// every exact match is returned, and several is `ambiguous` — never "the top
// one".
//
// ── EXCLUSIONS STAY EXCLUSIONS ─────────────────────────────────────────────
// Meta keeps them in a separate field, `excluded_geo_locations`. An exclusion
// that arrives as an inclusion runs the campaign in the one place somebody said
// to avoid, and nothing on any screen shows it as wrong. They are resolved into
// their own list here and never merged.
"use strict";

const crypto = require("crypto");

const metaAds = require("../channels/metaAdsClient");
const { stableJson } = require("../campaignDrafts/campaignAllocation.service");
const {
  TARGETING_OUTCOMES,
  TARGETING_BLOCKING_OUTCOMES,
} = require("../../../constants/marketingGoogleSearchDeployment");
const {
  AGE_BOUNDS,
  AUDIENCE_KIND_SUPPORT,
  META_CODES: M,
} = require("../../../constants/marketingMetaDeployment");

const str = (v) => String(v ?? "").trim();

const OUTCOME_BY_CODE = Object.fromEntries(TARGETING_OUTCOMES.map((o) => [o.code, o]));

/* ── GRAV'S KIND OF PLACE → META'S OWN LOCATION TYPES ───────────────────────
   A closed table. Meta's `location_types` are `country`, `region`, `city`,
   `zip`, `geo_market`, `electoral_district`, `country_group`, `subcity`,
   `subneighborhood`, `neighborhood`. Narrowing the query by these is what turns
   "a city called Cork and a county called Cork" from an ambiguity into a match
   when the author said which they meant.

   `radius` is absent on purpose. Meta's proximity targeting is a latitude, a
   longitude and a distance; GRAV's plan holds none of the three, and mapping it
   to the city at its centre would cover a different area than the one somebody
   drew. */
const GEO_KIND_TO_META_TYPES = Object.freeze({
  country: Object.freeze(["country"]),
  region: Object.freeze(["region"]),
  city: Object.freeze(["city", "subcity"]),
  postal_area: Object.freeze(["zip"]),
});
const UNSUPPORTED_GEO_KINDS = Object.freeze(["radius"]);

const entry = (requested, outcome, extra = {}) => ({
  requested,
  outcome,
  outcomeLabel: OUTCOME_BY_CODE[outcome]?.label || outcome,
  outcomeMeans: OUTCOME_BY_CODE[outcome]?.means || "",
  blocksCreation: TARGETING_BLOCKING_OUTCOMES.includes(outcome),
  /* Meta's own key, never constructed by GRAV. */
  key: null,
  keyType: null,
  canonicalName: null,
  candidates: [],
  ...extra,
});

/* Enough for a person to choose between two places of the same name, and
   nothing more. No URL, no credential name, no provider error, no raw row. */
const candidate = (c) => ({
  key: c.key,
  canonicalName: c.canonicalName || c.name,
  targetType: c.type,
  countryCode: c.countryCode || null,
});

/** Resolve one requested location. */
async function resolveLocation({ client, target }) {
  const requested = { name: str(target?.name), kind: str(target?.kind) };

  if (UNSUPPORTED_GEO_KINDS.includes(requested.kind)) {
    return entry(requested, "unsupported", {
      detail: "GRAV does not hold a centre point and a distance, so it cannot express an area drawn on a map as advertising targeting. Name a city, region or country instead.",
    });
  }

  const types = GEO_KIND_TO_META_TYPES[requested.kind];
  if (!types) {
    return entry(requested, "unsupported", {
      detail: "GRAV cannot express that kind of place as advertising targeting in this channel.",
    });
  }

  let rows;
  try {
    rows = await client.searchGeoTargets({ name: requested.name, types: [...types] });
  } catch {
    /* ── AN OUTAGE IS NOT A WRONG NAME ────────────────────────────────────
       Reporting it as `not_found` would send somebody to re-spell a location
       that was correct. The provider's own message stayed in the server log. */
    return entry(requested, "provider_unavailable", {
      detail: "The advertising channel did not answer, so this location could not be looked up.",
    });
  }

  /* ── THE SUGGESTION ENDPOINT IS FILTERED TO EXACT MATCHES HERE ──────────
     Meta ranks and fuzzes. GRAV does not accept a near miss: an author who
     typed "Bengalru" gets `not_found` and fixes it, rather than a campaign
     running in Bengaluru that they never confirmed. */
  const exact = rows.filter((r) => str(r.name).toLowerCase() === requested.name.toLowerCase());

  if (!exact.length) {
    return entry(requested, "not_found", {
      detail: "No location of that kind carries this name in the advertising channel. It may be spelled differently there.",
      /* What Meta DID suggest, offered as candidates so a person can see the
         near misses without GRAV having chosen one. */
      candidates: rows.slice(0, 5).map(candidate),
    });
  }
  if (exact.length > 1) {
    return entry(requested, "ambiguous", {
      detail: `${exact.length} locations carry this name. Somebody has to say which one was meant.`,
      candidates: exact.map(candidate),
    });
  }

  const one = exact[0];
  return entry(requested, "resolved", {
    key: one.key,
    keyType: one.type,
    canonicalName: one.canonicalName || one.name,
    countryCode: one.countryCode || null,
  });
}

/** Resolve one requested language tag. */
async function resolveLocale({ client, tag }) {
  const requested = { tag: str(tag) };
  if (!requested.tag) {
    return entry(requested, "not_found", { detail: "No language was given." });
  }

  let rows;
  try {
    rows = await client.searchLocales({ query: requested.tag });
  } catch {
    return entry(requested, "provider_unavailable", {
      detail: "The advertising channel did not answer, so this language could not be looked up.",
    });
  }

  /* Meta's locale search matches on the language NAME rather than on a BCP-47
     tag, so a plan carrying "en" has to be matched against what Meta calls it.
     Both forms are accepted and an exact match on either is required — a prefix
     match would make "en" resolve to "Английский" on a bad day. */
  const wanted = requested.tag.toLowerCase();
  const exact = rows.filter((r) => {
    const name = str(r.name).toLowerCase();
    return name === wanted || name.split(/[\s(]/)[0] === wanted;
  });

  if (!exact.length) {
    return entry(requested, "not_found", {
      detail: "The advertising channel does not offer a language matching that code.",
      candidates: rows.slice(0, 5).map((r) => ({ key: r.key, canonicalName: r.name, targetType: "Language", countryCode: null })),
    });
  }
  if (exact.length > 1) {
    return entry(requested, "ambiguous", {
      detail: `${exact.length} languages match that code.`,
      candidates: exact.map((r) => ({ key: r.key, canonicalName: r.name, targetType: "Language", countryCode: null })),
    });
  }

  const one = exact[0];
  return entry(requested, "resolved", { key: one.key, keyType: "locale", canonicalName: one.name });
}

/* ── AGE IS VALIDATED, NOT RESOLVED ─────────────────────────────────────────
   Plain integers in Meta's own bounds. Out of bounds is refused rather than
   clamped: a campaign silently widened to 18+ reaches people the plan excluded,
   and a campaign silently narrowed misses people it was approved to reach. */
function evaluateAge(brief) {
  const min = brief?.ageMin;
  const max = brief?.ageMax;
  const problems = [];

  const supplied = (v) => v !== undefined && v !== null;
  if (!supplied(min) && !supplied(max)) {
    /* Not a blocker: Meta's own default range is its documented behaviour and
       GRAV's plan does not currently require a choice. Reported so a preflight
       can say the campaign will use the channel's full adult range. */
    return { applies: false, min: null, max: null, problems, means: "The plan sets no age limits, so the advertisement will use the advertising channel's own full range." };
  }

  for (const [field, value] of [["ageMin", min], ["ageMax", max]]) {
    if (!supplied(value)) continue;
    /* Strict: `"25"`, `null`, `false` and `25.5` are not ages. A string that
       coerces is the bug this contract exists to refuse. */
    if (typeof value !== "number" || !Number.isInteger(value)) {
      problems.push({ code: M.AGE_OUT_OF_BOUNDS, field, message: "An age limit must be a whole number." });
      continue;
    }
    if (value < AGE_BOUNDS.MIN || value > AGE_BOUNDS.MAX) {
      problems.push({
        code: M.AGE_OUT_OF_BOUNDS, field,
        message: `An age limit must be between ${AGE_BOUNDS.MIN} and ${AGE_BOUNDS.MAX}.`,
      });
    }
  }

  if (!problems.length && supplied(min) && supplied(max) && min > max) {
    problems.push({ code: M.AGE_REVERSED, field: "ageMin", message: "The lower age limit is above the upper one." });
  }

  return {
    applies: true,
    min: supplied(min) ? min : null,
    max: supplied(max) ? max : null,
    problems,
    means: AGE_BOUNDS.MAX_MEANS_AND_OVER && max === AGE_BOUNDS.MAX
      ? `${min ?? AGE_BOUNDS.MIN} and over.`
      : "",
  };
}

/* ── AUDIENCES ARE JUDGED IN ONE PLACE, AND IT IS NOT HERE ──────────────────
   `metaAudience.evaluate` is the single answer to "is this audience
   deployable", shared by the plan's readiness evaluator, the preflight and the
   mapper. This function exists only to present the brief's audience ENTRIES in
   the same five-outcome shape as locations and languages, so one screen can
   show them together.

   It forms no opinion the audience module has not already formed. */
function evaluateAudiences(brief) {
  return (brief?.audiences || []).map((a) => {
    const kind = str(a?.kind);
    const support = AUDIENCE_KIND_SUPPORT[kind];
    return entry({ name: str(a?.name), kind }, "unsupported", {
      detail: support?.why || "GRAV cannot express that kind of audience in this channel.",
    });
  });
}

/**
 * Resolve everything on a plan's Meta brief that needs a provider identifier.
 *
 * ── FENCED TO ONE PLAN REVISION AND ONE BINDING ────────────────────────────
 * `resolvedFor` carries the plan, the approved revision, the account AND the
 * binding revision. The last of those is what makes a rebind invalidate an
 * earlier preflight: rebinding — even to the same account number, after a
 * failed verification — is a new decision, and targeting confirmed under the
 * old one belongs to the old one.
 */
async function resolve({ plan, bound, brief = null }, deps = {}) {
  const client = deps.metaAds || metaAds;

  const theBrief = brief
    || (plan?.deploymentBriefs || []).find((b) => b.channel === "meta_ads")
    || null;

  const resolvedFor = {
    campaignDraftId: String(plan?._id || ""),
    draftRef: str(plan?.draftRef),
    approvedRevision: Number(plan?.revision) || 0,
    externalAccountId: str(bound?.externalAccountId),
    bindingId: String(bound?.bindingId || ""),
    bindingRevision: Number(bound?.bindingRevision) || 0,
  };

  const empty = {
    resolvedFor, locations: [], exclusions: [], locales: [], audiences: [],
    age: { applies: false, min: null, max: null, problems: [], means: "" },
    audienceChoices: null,
  };

  if (!theBrief) {
    return {
      ...empty,
      complete: false,
      blockers: [{ code: M.BRIEF_MISSING, field: "deploymentBriefs", message: "The plan has no Meta Ads brief." }],
      fingerprint: fingerprintOf(empty),
    };
  }

  /* Sequential: these are reads against one rate-limited connection, and a plan
     with fifty locations firing fifty concurrent requests is how a resolution
     starts returning `provider_unavailable` for reasons that are GRAV's own
     fault. */
  const locations = [];
  for (const target of theBrief.geoTargeting || []) {
    locations.push(await resolveLocation({ client, target }));
  }

  const exclusions = [];
  for (const target of theBrief.geoExclusions || []) {
    exclusions.push(await resolveLocation({ client, target }));
  }

  const locales = [];
  for (const tag of theBrief.languages || []) {
    locales.push(await resolveLocale({ client, tag }));
  }

  const age = evaluateAge(theBrief);
  const audiences = evaluateAudiences(theBrief);

  /* The plan's own audience choices, carried into the fence so a change to any
     of them invalidates this resolution. */
  const audienceChoices = {
    mode: str(theBrief.audienceMode),
    ageMin: theBrief.audienceAgeMin ?? null,
    ageMax: theBrief.audienceAgeMax ?? null,
    genders: str(theBrief.audienceGenders),
    expansionRequested: theBrief.audienceExpansionRequested === true,
  };

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
  blocked(locales, "languages", "Language");
  /* Audience entries are NOT blocked here. `metaAudience.evaluate` refuses them
     with a named feature and one public sentence; blocking them twice would
     produce two different messages for one problem. */

  for (const p of age.problems) {
    blockers.push({ code: p.code, field: p.field, message: p.message, outcome: "unsupported", candidates: [] });
  }

  /* ── NO LOCATION IS NOT "NO TARGETING", IT IS EVERYWHERE ────────────────
     Meta requires at least one location and would refuse the create — but a
     plan that names none is refused HERE, so the reason is GRAV's sentence and
     arrives before anything else happens. */
  if (!(theBrief.geoTargeting || []).length) {
    blockers.push({
      code: M.GEO_NONE_SELECTED,
      field: "geoTargeting",
      message: "The plan names no location. An advertisement with no location targeting has no audience the advertising channel will accept, and one created without it would be shown wherever the channel chose.",
      outcome: "not_found",
      candidates: [],
    });
  }

  /* ── A PLACE CANNOT BE BOTH TARGETED AND AVOIDED ────────────────────────
     Meta resolves the conflict by its own rules. Whichever way it resolves, one
     of the two things somebody asked for is not happening, and nothing on any
     screen says which. */
  const includedKeys = new Set(locations.filter((l) => l.key).map((l) => l.key));
  for (const [i, ex] of exclusions.entries()) {
    if (ex.key && includedKeys.has(ex.key)) {
      blockers.push({
        code: M.GEO_INCLUDED_AND_EXCLUDED,
        field: `geoExclusions.${i}`,
        message: `"${ex.canonicalName || ex.requested.name}" is both targeted and excluded. GRAV will not send the advertising channel two instructions that contradict each other.`,
        outcome: "ambiguous",
        candidates: [],
      });
    }
  }

  const result = { resolvedFor, locations, exclusions, locales, audiences, age, audienceChoices };
  return {
    ...result,
    complete: blockers.length === 0,
    blockers,
    fingerprint: fingerprintOf(result),
  };
}

/* ── THE FENCE, AS ONE VALUE ────────────────────────────────────────────────
   Over the plan revision, the account, the BINDING REVISION, and every
   requested name with the key it resolved to. Changing any location, exclusion,
   language, age, the account binding or the approved revision produces a
   different fingerprint — which is what makes a stale preflight detectable
   rather than merely unlikely. */
function fingerprintOf({ resolvedFor, locations, exclusions, locales, age, audienceChoices }) {
  const basis = {
    resolvedFor,
    locations: (locations || []).map((l) => ({ name: l.requested.name, kind: l.requested.kind, outcome: l.outcome, key: l.key })),
    exclusions: (exclusions || []).map((l) => ({ name: l.requested.name, kind: l.requested.kind, outcome: l.outcome, key: l.key })),
    locales: (locales || []).map((l) => ({ tag: l.requested.tag, outcome: l.outcome, key: l.key })),
    age: { min: age?.min ?? null, max: age?.max ?? null },
    /* ── THE AUDIENCE IS PART OF THE FENCE ────────────────────────────────
       Changing the mode, either age boundary or the gender choice changes who
       the advertisement reaches. A preflight that resolved before the change
       is evidence about a different campaign, and a creation quoting its
       fingerprint has to be refused. */
    audience: audienceChoices || null,
  };
  return crypto.createHash("sha256").update(stableJson(basis)).digest("hex").slice(0, 32);
}

const sameFence = (a, b) => stableJson(a || {}) === stableJson(b || {});

/** The provider-neutral targeting section a preflight publishes. */
function publicTargeting(resolution) {
  const view = (e) => ({
    requested: e.requested,
    outcome: e.outcome,
    outcomeLabel: e.outcomeLabel,
    outcomeMeans: e.outcomeMeans,
    blocksCreation: e.blocksCreation,
    /* Meta's own key. Not a secret — it is shown beside every location in the
       advertising interface — and useless without access to that account. */
    resolvedId: e.key,
    resolvedName: e.canonicalName,
    candidates: e.candidates,
    detail: e.detail || "",
  });

  const unresolved = [
    ...resolution.locations, ...resolution.exclusions,
    ...resolution.locales, ...resolution.audiences,
  ].filter((e) => e.blocksCreation);

  return {
    requestedLocations: resolution.locations.map(view),
    requestedExclusions: resolution.exclusions.map(view),
    requestedLanguages: resolution.locales.map(view),
    requestedAudiences: resolution.audiences.map(view),
    age: {
      applies: resolution.age.applies,
      min: resolution.age.min,
      max: resolution.age.max,
      means: resolution.age.means,
      problems: resolution.age.problems,
    },
    unresolved: unresolved.map(view),
    allApprovedTargetingCanBeApplied: resolution.complete === true,
    blockers: resolution.blockers,
    fingerprint: resolution.fingerprint,
    resolvedFor: resolution.resolvedFor,
  };
}

module.exports = {
  resolve,
  publicTargeting,
  fingerprintOf,
  sameFence,
  evaluateAge,
  resolveLocation,
  resolveLocale,
  GEO_KIND_TO_META_TYPES,
};
