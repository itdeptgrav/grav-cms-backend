// services/marketing/deployment/metaAudience.js
//
// THE ONE AUDIENCE GRAV CAN EXPRESS, AND WHY IT IS EXPLICIT ALL THE WAY DOWN.
//
// ── "BROAD" MUST BE A DECISION, NOT AN ABSENCE ─────────────────────────────
// This is the whole file in one sentence. Broad prospecting means somebody
// chose to reach a wide audience within boundaries they named. It must never
// mean GRAV left fields out and the advertising channel filled them in.
//
// Those two produce campaigns that look identical on every screen and cost very
// different amounts. An omitted age range is 13-to-65 in most markets. An
// omitted gender is everybody. An omitted location is wherever the channel
// decides. A marketer reviewing the campaign afterwards cannot tell which of
// the two happened, and neither can an auditor.
//
// So every supported field is required. There is no partial broad prospecting,
// and `all` genders is a value somebody picks rather than a field nobody filled
// in.
//
// ── ONE TRUTH, SHARED ──────────────────────────────────────────────────────
// This module is the single answer to "is this audience deployable". The plan's
// readiness evaluator, the preflight and the mapper all call it, so a plan
// cannot be approvable by one standard and refused by another.
//
// ── PURE ───────────────────────────────────────────────────────────────────
// No network, no database, no clock. It is given a brief and the resolved
// targeting and it answers.
"use strict";

const {
  AUDIENCE_MODES,
  SUPPORTED_AUDIENCE_MODE,
  AUDIENCE_GENDERS,
  REFUSED_AUDIENCE_FEATURES,
  AUDIENCE_UNSUPPORTED_PUBLIC_MESSAGE,
  AUDIENCE_KIND_SUPPORT,
  AGE_BOUNDS,
  META_CODES: M,
} = require("../../../constants/marketingMetaDeployment");

const str = (v) => String(v ?? "").trim();

const MODE_BY_CODE = Object.fromEntries(AUDIENCE_MODES.map((m) => [m.code, m]));
const GENDER_BY_CODE = Object.fromEntries(AUDIENCE_GENDERS.map((g) => [g.code, g]));
const REFUSED_BY_CODE = Object.fromEntries(REFUSED_AUDIENCE_FEATURES.map((f) => [f.code, f]));

const problem = (code, message, field, extra = {}) => ({ code, message, field, ...extra });

/* ── WHICH REFUSED FEATURE A BRIEF'S AUDIENCE ENTRY IS ──────────────────────
   The brief's audience list carries a kind. Each maps to a named refusal so a
   log and a test can be precise about what was asked for; the public message
   names none of them. */
const FEATURE_FOR_KIND = Object.freeze({
  interest: "interest_targeting",
  behaviour: "behavioural_targeting",
  demographic: "interest_targeting",
  custom_list: "custom_audience",
  lookalike: "lookalike",
  search_intent: "interest_targeting",
});

/**
 * Is this plan's audience one GRAV can build?
 *
 * @param {object}  args
 * @param {object}  args.brief              the Meta deployment brief
 * @param {object} [args.resolvedTargeting] locations and languages, already resolved
 * @returns {{complete:boolean, mode:string|null, audience:object|null,
 *            problems:object[], publicMessage:string|null}}
 */
function evaluate({ brief, resolvedTargeting = null }) {
  const problems = [];

  if (!brief) {
    return {
      complete: false, mode: null, audience: null,
      problems: [problem(M.BRIEF_MISSING, "The plan has no Meta Ads brief.", "deploymentBriefs")],
      publicMessage: null,
    };
  }

  /* ── ANYTHING GRAV CANNOT BUILD IS REFUSED BEFORE ANYTHING ELSE ─────────
     A plan asking for a lookalike audience is not a broad-prospecting plan with
     a problem; it is a different kind of campaign, and telling somebody their
     age range is missing would send them to fix the wrong thing. */
  const refused = [];
  for (const [i, entry] of (brief.audiences || []).entries()) {
    const kind = str(entry?.kind);
    const feature = FEATURE_FOR_KIND[kind] || null;
    const spec = feature ? REFUSED_BY_CODE[feature] : null;
    refused.push(problem(
      M.AUDIENCE_UNSUPPORTED,
      spec ? `${spec.label} is not something GRAV can build for this channel. ${spec.why}`
        : AUDIENCE_KIND_SUPPORT[kind]?.why || "GRAV cannot express that kind of audience in this channel.",
      `audiences.${i}`,
      { feature, requested: str(entry?.name) },
    ));
  }

  /* ── AND SO IS ASKING THE CHANNEL TO WIDEN IT ──────────────────────────
     Audience expansion lets the channel show the advertisement to people
     outside the audience that was approved. A plan whose boundaries were
     reviewed would quietly stop having boundaries. */
  if (brief.audienceExpansionRequested === true) {
    refused.push(problem(
      M.AUDIENCE_EXPANSION_REFUSED,
      `${REFUSED_BY_CODE.advantage_audience_expansion.label} is not something GRAV will enable. ${REFUSED_BY_CODE.advantage_audience_expansion.why}`,
      "audienceExpansionRequested",
      { feature: "advantage_audience_expansion" },
    ));
  }

  if (refused.length) {
    return {
      complete: false, mode: null, audience: null,
      problems: refused,
      publicMessage: AUDIENCE_UNSUPPORTED_PUBLIC_MESSAGE,
    };
  }

  /* ── THE MODE ITSELF ───────────────────────────────────────────────────── */
  const mode = str(brief.audienceMode);
  if (!mode) {
    return {
      complete: false, mode: null, audience: null,
      problems: [problem(M.AUDIENCE_MODE_MISSING,
        "The plan does not say what kind of audience this advertisement is for. GRAV will not let the advertising channel decide who sees it.",
        "audienceMode")],
      publicMessage: null,
    };
  }
  if (mode !== SUPPORTED_AUDIENCE_MODE || !MODE_BY_CODE[mode]?.supported) {
    return {
      complete: false, mode, audience: null,
      problems: [problem(M.AUDIENCE_MODE_UNSUPPORTED,
        "GRAV supports one kind of audience for this channel: broad prospecting.", "audienceMode")],
      publicMessage: AUDIENCE_UNSUPPORTED_PUBLIC_MESSAGE,
    };
  }

  /* ── EVERY BOUNDARY, EXPLICITLY ─────────────────────────────────────────── */

  /* Locations come from the resolution, because a name is not a location the
     channel can target. Their absence is reported by the resolver; what is
     checked here is that the resolved set is actually usable. */
  const included = (resolvedTargeting?.locations || []).filter((l) => l.outcome === "resolved");
  const excluded = (resolvedTargeting?.exclusions || []).filter((l) => l.outcome === "resolved");
  const locales = (resolvedTargeting?.locales || []).filter((l) => l.outcome === "resolved");

  if (!(brief.geoTargeting || []).length) {
    problems.push(problem(M.GEO_NONE_SELECTED,
      "Broad prospecting still needs somewhere to run. The plan names no location.",
      "geoTargeting"));
  } else if (!included.length) {
    problems.push(problem(M.TARGETING_NOT_RESOLVED,
      "None of the plan's locations could be turned into advertising targeting.",
      "geoTargeting"));
  }

  /* ── EXCLUSIONS ARE PART OF THE AUDIENCE, NOT AN AFTERTHOUGHT ───────────
     A plan that names an excluded location and loses it in resolution is a
     campaign running in the one place somebody said to avoid. */
  if ((brief.geoExclusions || []).length !== excluded.length) {
    problems.push(problem(M.TARGETING_NOT_RESOLVED,
      "An excluded location could not be turned into advertising targeting, so the advertisement would run there.",
      "geoExclusions"));
  }

  /* ── AGES ───────────────────────────────────────────────────────────────
     Required, both of them. Omitting one is the channel's own range, which is
     the exact thing `broad_prospecting` must not silently become. */
  const ageMin = brief.audienceAgeMin;
  const ageMax = brief.audienceAgeMax;

  for (const [field, value] of [["audienceAgeMin", ageMin], ["audienceAgeMax", ageMax]]) {
    if (value === null || value === undefined) {
      problems.push(problem(M.AUDIENCE_FIELD_MISSING,
        "Broad prospecting needs both an age floor and an age ceiling. Leaving one out would use the advertising channel's own range rather than one somebody chose.",
        field));
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value)) {
      problems.push(problem(M.AGE_OUT_OF_BOUNDS, "An age boundary must be a whole number.", field));
      continue;
    }
    if (value < AGE_BOUNDS.MIN || value > AGE_BOUNDS.MAX) {
      problems.push(problem(M.AGE_OUT_OF_BOUNDS,
        `An age boundary must be between ${AGE_BOUNDS.MIN} and ${AGE_BOUNDS.MAX}.`, field));
    }
  }

  const agesUsable = typeof ageMin === "number" && typeof ageMax === "number"
    && Number.isInteger(ageMin) && Number.isInteger(ageMax);
  if (agesUsable && ageMin > ageMax) {
    problems.push(problem(M.AGE_REVERSED,
      "The age floor is above the age ceiling.", "audienceAgeMin"));
  }

  /* ── GENDER, WITH `all` AS A CHOICE ─────────────────────────────────────
     The channel's own default is everyone. If this field could be omitted, a
     plan that never considered gender and a plan that deliberately chose
     everyone would be stored identically. */
  const genderCode = str(brief.audienceGenders);
  let gender = null;
  if (!genderCode) {
    problems.push(problem(M.GENDER_MISSING,
      "Broad prospecting needs a gender choice. Choose everyone if that is what you mean — GRAV records that as a decision, not as a blank.",
      "audienceGenders"));
  } else {
    gender = GENDER_BY_CODE[genderCode] || null;
    if (!gender) {
      problems.push(problem(M.GENDER_UNSUPPORTED,
        "That is not a gender choice this channel offers.", "audienceGenders"));
    }
  }

  /* ── LANGUAGES ──────────────────────────────────────────────────────────
     Required to be stated. An empty language list on this channel means every
     language, which is a legitimate choice — but it has to be the plan's
     choice, and the plan expresses it by naming the languages it wants. */
  if (!(brief.languages || []).length) {
    problems.push(problem(M.AUDIENCE_FIELD_MISSING,
      "Broad prospecting needs at least one language. Leaving it out would show the advertisement to speakers of every language rather than ones somebody chose.",
      "languages"));
  } else if (locales.length !== (brief.languages || []).length) {
    problems.push(problem(M.TARGETING_NOT_RESOLVED,
      "A language could not be turned into advertising targeting.", "languages"));
  }

  if (problems.length) {
    return { complete: false, mode, audience: null, problems, publicMessage: null };
  }

  return {
    complete: true,
    mode,
    problems: [],
    publicMessage: null,
    /* ── THE AUDIENCE, PROVIDER-NEUTRAL ─────────────────────────────────────
       GRAV's words and the resolved identifiers. The mapper turns this into the
       channel's own field names; nothing else needs to know them. */
    audience: {
      mode,
      modeLabel: MODE_BY_CODE[mode].label,
      modeMeans: MODE_BY_CODE[mode].means,
      /* `keyType` travels with the key: the channel's targeting object is
         typed, and a region placed in the cities list is either refused or
         silently read as somewhere else. */
      includedLocations: included.map((l) => ({ key: l.key, keyType: l.keyType, name: l.canonicalName, requested: l.requested.name })),
      excludedLocations: excluded.map((l) => ({ key: l.key, keyType: l.keyType, name: l.canonicalName, requested: l.requested.name })),
      languages: locales.map((l) => ({ key: l.key, name: l.canonicalName, requested: l.requested.tag })),
      ageMin,
      ageMax,
      genders: gender.code,
      gendersLabel: gender.label,
      /* Null for `all`, which is how the channel expresses everyone — and the
         reason `all` had to be an explicit choice rather than an absent field. */
      gendersProvider: gender.provider,
      /* Always false, always written. Omitting it is how the channel's own
         default wins. */
      audienceExpansion: false,
    },
  };
}

/* ── WHAT A CALLER IS TOLD ──────────────────────────────────────────────────
   The complete audience where there is one, and where there is not, the
   problems in GRAV's own words. No channel taxonomy ids, no field names from
   the provider's API. */
function publicAudience(result) {
  if (result.complete) {
    return {
      mode: result.audience.mode,
      modeLabel: result.audience.modeLabel,
      modeMeans: result.audience.modeMeans,
      includedLocations: result.audience.includedLocations.map((l) => ({ name: l.name, requested: l.requested })),
      excludedLocations: result.audience.excludedLocations.map((l) => ({ name: l.name, requested: l.requested })),
      languages: result.audience.languages.map((l) => ({ name: l.name, requested: l.requested })),
      ageMin: result.audience.ageMin,
      ageMax: result.audience.ageMax,
      genders: result.audience.genders,
      gendersLabel: result.audience.gendersLabel,
      audienceExpansion: false,
      audienceExpansionMeans: "GRAV never lets the advertising channel widen an approved audience.",
      complete: true,
    };
  }
  return {
    mode: result.mode,
    complete: false,
    problems: result.problems.map((p) => ({ code: p.code, field: p.field, message: p.message })),
    /* One sentence where the whole shape is unsupported; otherwise null, and
       the problems above say what is missing. */
    means: result.publicMessage,
  };
}

module.exports = {
  evaluate,
  publicAudience,
  SUPPORTED_AUDIENCE_MODE,
  FEATURE_FOR_KIND,
};
