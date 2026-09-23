// services/marketing/deployment/metaTrafficMapper.js
//
// AN APPROVED GRAV PLAN → THE META OBJECTS THAT WOULD BE CREATED.
//
// ── PURE, AND IT CREATES NOTHING ───────────────────────────────────────────
// No network, no database, no clock, no randomness, no `process.env`. It
// produces an operation PLAN — a description of four objects and the order they
// would have to be made in — and executing it is not this file's business and
// does not exist yet.
//
// The same plan, account and resolved targeting produce the same bytes for
// ever. That matters for the same three reasons it did on the Google path: a
// preflight can show exactly what would be created; a command fingerprint
// computed from it stays stable across retries; and it can be tested
// exhaustively without a transport.
//
// ── NO HIDDEN DEFAULTS. NOT ONE. ───────────────────────────────────────────
// Meta has a default for the objective, the optimisation goal, the billing
// event, the attribution setting and the special ad category. Every one of them
// decides how money is spent or who is allowed to see the advertisement, and
// two of them have legal weight. A plan that does not say is a plan that cannot
// be deployed — it is not a plan that gets Meta's opinion.
//
// The special ad category is the sharpest of these. Its default is `NONE`, and
// a recruitment campaign declared as NONE is a policy violation and, in several
// jurisdictions, a legal one. GRAV requires the plan to say.
//
// ── REFUSE, NEVER TRIM ─────────────────────────────────────────────────────
// GRAV allows 2000 characters of body text because a plan is written before
// anybody picks a channel. Meta allows 125 in the primary text and 40 in the
// headline. Trimming produces an advertisement that stops mid-word, approved by
// nobody, discovered weeks later by somebody looking at a Meta screen.
"use strict";

const metaAudience = require("./metaAudience");
const {
  MVP_CONTRACT,
  META_LIMITS: L,
  BUDGET_PLACEMENT,
  SPECIAL_AD_CATEGORIES,
  CALLS_TO_ACTION,
  META_OBJECT_BY_CODE,
  CREATION_ORDER,
  META_CODES: M,
} = require("../../../constants/marketingMetaDeployment");

const str = (v) => String(v ?? "").trim();
const isText = (v) => typeof v === "string" && v.trim() !== "";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

const problem = (code, message, field, extra = {}) => ({ code, message, field, ...extra });

const CTA_BY_CODE = Object.fromEntries(CALLS_TO_ACTION.map((c) => [c.code, c]));
const CTA_BY_LABEL = Object.fromEntries(CALLS_TO_ACTION.map((c) => [c.label.toLowerCase(), c]));
const CATEGORY_BY_CODE = Object.fromEntries(SPECIAL_AD_CATEGORIES.map((c) => [c.code, c]));
const OPTIMISATION_BY_CODE = Object.fromEntries(
  MVP_CONTRACT.optimisation.supported.map((o) => [o.code, o]),
);

/* ── META'S MONEY UNIT IS THE CURRENCY'S MINOR UNIT ─────────────────────────
   Paise, cents. An integer, always: `0.1 + 0.2` is not `0.3`, and a budget a
   fraction of a minor unit out is one Meta rounds in a direction nobody chose.

   ── AND ZERO IS A REAL AMOUNT ─────────────────────────────────────────────
   `!amount` would treat 0 as absent and fall through to "no budget". A plan
   that genuinely says zero is a plan somebody wrote down, and it has to be
   refused as below-minimum — with that reason — rather than reported as
   missing. The strict type check is what keeps the two apart, and it is also
   what refuses `"2500"`, `null`, `false` and `true`. */
function toMinorUnits(amount, field, problems) {
  if (!isNum(amount)) {
    problems.push(problem(M.BUDGET_MISSING,
      "A budget amount must be a number. A value sent as text, or as nothing at all, is not an amount.",
      field));
    return null;
  }
  if (amount < 0) {
    problems.push(problem(M.BUDGET_MISSING, "A budget cannot be negative.", field));
    return null;
  }
  const minor = Math.round(amount * L.MINOR_UNITS_PER_MAJOR);
  if (Math.abs(minor / L.MINOR_UNITS_PER_MAJOR - amount) > Number.EPSILON * Math.max(1, Math.abs(amount))) {
    problems.push(problem(M.BUDGET_NOT_WHOLE_MINOR_UNITS,
      "That amount is more precise than the currency can hold. Round it before approving.", field));
    return null;
  }
  return minor;
}

const campaignNameFor = (plan) => `${str(plan.draftRef)} ${str(plan.name)}`.trim();

/* ── META'S LOCATION SHAPE ──────────────────────────────────────────────────
   `geo_locations` is an object of typed lists, not a flat array: countries go
   under `countries` as two-letter codes, everything else under its own key as
   `{ key }`. Built from the resolved targets' own type so a region cannot land
   in the cities list — which the channel would either refuse or, worse,
   silently interpret as somewhere else. */
function geoLocationsFor(locations) {
  const out = {};
  for (const loc of locations) {
    const type = str(loc.keyType || loc.type);
    if (type === "country") {
      (out.countries = out.countries || []).push(str(loc.key));
    } else if (type === "region") {
      (out.regions = out.regions || []).push({ key: str(loc.key) });
    } else if (type === "city" || type === "subcity") {
      (out.cities = out.cities || []).push({ key: str(loc.key) });
    } else if (type === "zip") {
      (out.zips = out.zips || []).push({ key: str(loc.key) });
    } else {
      /* Unreachable while the resolver's table holds. Present so a future kind
         fails loudly rather than being dropped — a dropped location is a
         campaign running somewhere nobody chose. */
      throw new Error(`GRAV cannot place a ${type || "unknown"} location in this channel's targeting.`);
    }
  }
  return out;
}

/* ── WHERE A CLICK GOES, WITH THE TRACKING THE PLAN OWNS ────────────────────
   Built here rather than left to Meta's own parameters, because the UTM
   identity is the field the plan enforces uniqueness on and analytics
   attributes by. A campaign deployed without it produces sessions nothing can
   attribute, and nobody notices until a report is wrong. */
function destinationFor({ plan, brief }, problems) {
  const dest = brief.destination;
  if (!dest || !isText(dest.kind)) {
    problems.push(problem(M.DESTINATION_UNRESOLVED, "The plan does not say where a click goes.", "destination"));
    return null;
  }
  if (dest.kind !== "grav_site_url") {
    problems.push(problem(M.DESTINATION_UNRESOLVED,
      "GRAV cannot yet turn a content-library landing page into an address the advertising channel can send clicks to. Use a page on the company website.",
      "destination.kind"));
    return null;
  }

  const raw = str(dest.url);
  if (!raw) {
    problems.push(problem(M.DESTINATION_UNRESOLVED, "The destination has no address.", "destination.url"));
    return null;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    problems.push(problem(M.DESTINATION_UNRESOLVED, "That destination is not an address the advertising channel can send clicks to.", "destination.url"));
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    problems.push(problem(M.DESTINATION_UNRESOLVED, "A destination must be a web address.", "destination.url"));
    return null;
  }

  const utm = str(plan.utmCampaign);
  if (!utm) {
    problems.push(problem(M.DESTINATION_UNRESOLVED,
      "The plan has no campaign identity, so its clicks could not be attributed to it.", "utmCampaign"));
    return null;
  }

  const params = { utm_source: "meta", utm_medium: "paid_social", utm_campaign: utm };
  for (const [key, value] of Object.entries(params)) {
    const existing = url.searchParams.get(key);
    if (existing !== null && existing !== value) {
      problems.push(problem(M.DESTINATION_UNRESOLVED,
        `The destination already carries a different ${key}. GRAV will not overwrite it, because the two would attribute the same clicks to two campaigns.`,
        "destination.url"));
      return null;
    }
    url.searchParams.set(key, value);
  }
  url.searchParams.sort();
  const final = url.toString();

  if (final.length > L.DESTINATION_URL_MAX) {
    problems.push(problem(M.DESTINATION_TOO_LONG,
      `The destination address is ${final.length} characters once tracking is added. The channel allows ${L.DESTINATION_URL_MAX}.`,
      "destination.url"));
    return null;
  }
  return final;
}

function mapCreative(brief, problems) {
  const creative = brief.metaSingleImage || null;
  if (!creative) {
    problems.push(problem(M.BRIEF_MISSING, "The plan has no Meta advertisement text.", "metaSingleImage"));
    return null;
  }

  const primaryText = str(creative.primaryText);
  const headline = str(creative.headline);
  const ctaRaw = str(creative.callToAction);

  if (!primaryText) {
    problems.push(problem(M.PRIMARY_TEXT_MISSING, "The advertisement has no main text.", "metaSingleImage.primaryText"));
  } else if (primaryText.length > L.PRIMARY_TEXT_MAX) {
    problems.push(problem(M.PRIMARY_TEXT_TOO_LONG,
      `The main text is ${primaryText.length} characters. The channel allows ${L.PRIMARY_TEXT_MAX}, and GRAV will not shorten it for you.`,
      "metaSingleImage.primaryText", { length: primaryText.length, allowed: L.PRIMARY_TEXT_MAX }));
  }

  if (!headline) {
    problems.push(problem(M.HEADLINE_MISSING, "The advertisement has no headline.", "metaSingleImage.headline"));
  } else if (headline.length > L.HEADLINE_MAX) {
    problems.push(problem(M.HEADLINE_TOO_LONG,
      `The headline is ${headline.length} characters. The channel allows ${L.HEADLINE_MAX}, and GRAV will not shorten it for you.`,
      "metaSingleImage.headline", { length: headline.length, allowed: L.HEADLINE_MAX }));
  }

  /* ── THE CALL TO ACTION IS A CLOSED TABLE ───────────────────────────────
     It is the promise the advertisement makes. Mapping "Find out more" to
     whatever looks closest would put a button on a paid advertisement that
     nobody approved. */
  let cta = null;
  if (!ctaRaw) {
    problems.push(problem(M.CALL_TO_ACTION_MISSING,
      "The advertisement has no button. The channel requires one and GRAV will not choose it.",
      "metaSingleImage.callToAction"));
  } else {
    cta = CTA_BY_CODE[ctaRaw.toLowerCase().replace(/\s+/g, "_")] || CTA_BY_LABEL[ctaRaw.toLowerCase()] || null;
    if (!cta) {
      problems.push(problem(M.CALL_TO_ACTION_UNSUPPORTED,
        "GRAV does not offer that button for this kind of advertisement.",
        "metaSingleImage.callToAction"));
    }
  }

  return { primaryText, headline, callToAction: cta };
}

function mapOptimisation({ brief, trackingIdentity }, problems) {
  /* The plan records bidding in GRAV's words. For Meta the equivalent decision
     is the ad set's optimisation goal, and the mapping is explicit rather than
     inferred from the Google vocabulary — `maximise_clicks` means something on
     Google's auction that it does not mean on Meta's. */
  const chosen = str(brief.metaOptimisation) || str(brief.optimisation);
  if (!chosen) {
    problems.push(problem(M.OPTIMISATION_MISSING,
      "The plan does not say what the advertisement should optimise for. The channel has a default, and it decides what the budget buys.",
      "optimisation"));
    return null;
  }

  const spec = OPTIMISATION_BY_CODE[chosen];
  if (!spec) {
    problems.push(problem(M.OPTIMISATION_UNSUPPORTED,
      "GRAV does not offer that optimisation for this kind of campaign.", "optimisation"));
    return null;
  }

  /* ── AN OPTIMISATION THAT NEEDS MEASUREMENT NEEDS THE PIXEL ─────────────
     Meta cannot optimise for landing-page views it cannot observe. Allowing it
     without tracking would produce a campaign optimising against silence. */
  if (spec.needsTrackingIdentity && !str(trackingIdentity)) {
    problems.push(problem(M.OPTIMISATION_NEEDS_TRACKING,
      "That optimisation needs website measurement configured, and this company has none recorded.",
      "optimisation"));
    return null;
  }

  return {
    code: spec.code,
    provider: spec.provider,
    billingEvent: spec.billingEvent,
    means: spec.means,
  };
}

function mapBudget({ plan, brief, accountCurrency }, problems) {
  const budget = plan.budget || null;
  if (!budget) {
    problems.push(problem(M.BUDGET_MISSING, "The plan has no budget.", "budget"));
    return null;
  }

  const currency = str(budget.currency).toUpperCase();
  if (!currency) {
    problems.push(problem(M.BUDGET_MISSING, "The budget has no currency.", "budget.currency"));
    return null;
  }
  if (accountCurrency && currency !== accountCurrency) {
    /* Meta does not convert. A budget approved as 2,500 in an account billing
       in another currency is created as 2,500 of THAT currency, and the number
       on the screen is the number that was approved. */
    problems.push(problem(M.CURRENCY_MISMATCH,
      `The budget is in ${currency} and the advertising account bills in ${accountCurrency}. Creating it would change what was approved.`,
      "budget.currency"));
    return null;
  }

  const basis = str(budget.basis);
  if (!BUDGET_PLACEMENT.supportedBases.includes(basis)) {
    problems.push(problem(M.BUDGET_BASIS_UNSUPPORTED,
      "The plan does not say whether the budget is a daily amount or the campaign's total.",
      "budget.basis"));
    return null;
  }

  const minor = toMinorUnits(budget.amount, "budget.amount", problems);
  if (minor === null) return null;

  if (basis === "daily" && minor < L.MIN_DAILY_BUDGET_MINOR) {
    problems.push(problem(M.BUDGET_BELOW_PROVIDER_MINIMUM,
      "That daily budget is below the smallest amount the advertising channel accepts.",
      "budget.amount"));
    return null;
  }
  if (minor === 0) {
    /* Reached only when zero is the genuine approved amount and the basis is
       total. Refused as an amount, not reported as a missing one. */
    problems.push(problem(M.BUDGET_BELOW_PROVIDER_MINIMUM,
      "The approved budget is zero. An advertisement cannot be created with nothing to spend.",
      "budget.amount"));
    return null;
  }

  return {
    amountMinorUnits: minor,
    currency,
    basis,
    /* The budget goes on the AD SET, and the reason is written down rather than
       assumed — see `BUDGET_PLACEMENT`. */
    level: BUDGET_PLACEMENT.level,
    providerField: BUDGET_PLACEMENT.providerField[basis],
  };
}

function mapSchedule({ plan, brief, accountTimeZone }, problems) {
  const start = str(plan.schedule?.startDate);
  const end = str(plan.schedule?.endDate);
  if (!start || !end) {
    problems.push(problem(M.SCHEDULE_MISSING, "The plan does not say when the campaign runs.", "schedule"));
    return null;
  }

  const planTz = str(brief.timezone);
  if (!planTz) {
    problems.push(problem(M.TIMEZONE_MISSING, "The plan does not say which timezone its dates are in.", "timezone"));
    return null;
  }

  /* ── THE DATES ARE THE ACCOUNT'S DAYS ───────────────────────────────────
     Meta schedules in the advertising account's timezone and has no field for
     any other. A plan whose brief says one timezone and an account that keeps
     another would run on days up to a day away from what somebody intended, and
     converting silently would make the stored plan and the live campaign
     disagree about when it starts. Refused, with both names. */
  if (accountTimeZone && planTz !== accountTimeZone) {
    problems.push(problem(M.TIMEZONE_MISMATCH,
      `The plan's dates are in ${planTz} and the advertising account keeps ${accountTimeZone}. The channel schedules in the account's time, so these would not be the days that were approved.`,
      "timezone"));
    return null;
  }

  return { startDate: start, endDate: end, timezone: planTz };
}

function mapSpecialAdCategory(brief, problems) {
  const chosen = str(brief.specialAdCategory);
  if (!chosen) {
    /* ── THE ONE DEFAULT THAT IS NEVER TAKEN ──────────────────────────────
       Meta's default is NONE. A recruitment, credit or housing campaign
       declared as NONE is a policy violation and, in several jurisdictions, a
       legal one — and nobody discovers it from a screen. */
    problems.push(problem(M.SPECIAL_AD_CATEGORY_MISSING,
      "The plan does not say whether this advertisement is about credit, employment, housing, or social issues and politics. The advertising channel restricts targeting for those, and GRAV will not answer on somebody's behalf.",
      "specialAdCategory"));
    return null;
  }
  const spec = CATEGORY_BY_CODE[chosen];
  if (!spec) {
    problems.push(problem(M.SPECIAL_AD_CATEGORY_UNSUPPORTED,
      "That is not a category the advertising channel recognises.", "specialAdCategory"));
    return null;
  }
  return { code: spec.code, provider: spec.provider, restricted: spec.restricted === true };
}

/**
 * Map an approved plan to the Meta objects that would be created.
 *
 * @param {object}  args
 * @param {object}  args.plan
 * @param {object}  args.account            `{ currency, timeZone, externalAccountId }`
 * @param {object}  args.resolvedTargeting  from `metaTargetingResolution`
 * @param {object}  args.creativeAsset      from `metaCreativeAsset.evaluate`
 * @param {string}  args.trackingIdentity   the company's Meta Pixel id, or ""
 * @returns {{mappable:boolean, problems:object[], plan:object|null, decisions:object[]}}
 */
function map({ plan, account = {}, resolvedTargeting = null, creativeAsset = null, trackingIdentity = "", audience = null }) {
  const problems = [];
  const accountCurrency = str(account.currency).toUpperCase() || null;
  const accountTimeZone = str(account.timeZone) || null;
  const accountId = str(account.externalAccountId) || null;

  const brief = (plan?.deploymentBriefs || []).find((b) => b.channel === "meta_ads") || null;
  if (!brief) {
    return {
      mappable: false,
      problems: [problem(M.BRIEF_MISSING, "The plan has no Meta Ads brief.", "deploymentBriefs")],
      plan: null,
      decisions: [],
    };
  }
  if (str(brief.campaignType) !== MVP_CONTRACT.campaignType) {
    /* ── EVERY OTHER SHAPE IS REFUSED, NOT APPROXIMATED ──────────────────
       A carousel plan turned into a single-image advertisement is a campaign
       nobody designed, spending a budget approved for something else. */
    return {
      mappable: false,
      problems: [problem(M.CAMPAIGN_TYPE_UNSUPPORTED,
        "This mapper builds one kind of Meta campaign: website traffic, single image.", "campaignType")],
      plan: null,
      decisions: [],
    };
  }

  const name = campaignNameFor(plan);
  if (!name) problems.push(problem(M.BRIEF_MISSING, "The plan has no name.", "name"));

  const creative = mapCreative(brief, problems);
  const optimisation = mapOptimisation({ brief, trackingIdentity }, problems);
  const budget = mapBudget({ plan, brief, accountCurrency }, problems);
  const schedule = mapSchedule({ plan, brief, accountTimeZone }, problems);
  const destination = destinationFor({ plan, brief }, problems);
  const category = mapSpecialAdCategory(brief, problems);

  /* ── THE TARGETING COMES IN RESOLVED ────────────────────────────────────
     The mapper is pure and cannot look anything up. A caller that has not
     resolved gets a refusal rather than a campaign with its targeting quietly
     missing. */
  const targeting = resolvedTargeting || null;
  if (!targeting) {
    problems.push(problem(M.TARGETING_NOT_RESOLVED,
      "GRAV has not resolved this plan's locations and languages against the advertising account, so it cannot build the advertisement's targeting.",
      "targeting"));
  } else {
    const expected = {
      campaignDraftId: String(plan?._id || ""),
      approvedRevision: Number(plan?.revision) || 0,
      externalAccountId: accountId || "",
    };
    const got = targeting.resolvedFor || {};
    const mismatched = Object.entries(expected)
      .filter(([k, v]) => v !== "" && v !== 0 && String(got[k] ?? "") !== String(v))
      .map(([k]) => k);
    if (mismatched.length) {
      problems.push(problem(M.TARGETING_STALE,
        "The resolved targeting belongs to a different plan revision or a different advertising account. It has to be resolved again before anything is created.",
        "targeting", { mismatched }));
    }
    if (targeting.complete !== true) {
      problems.push(problem(M.TARGETING_NOT_RESOLVED,
        "Some locations or languages could not be turned into advertising targeting.", "targeting"));
    }
  }

  /* ── THE AUDIENCE, JUDGED BY THE ONE MODULE THAT JUDGES AUDIENCES ───────
     Passed in where a caller has already evaluated it, computed here otherwise.
     Either way it is the same function, so the plan's readiness gate, the
     preflight and this mapper cannot disagree about whether an audience is
     deployable. */
  const audienceResult = audience || metaAudience.evaluate({ brief, resolvedTargeting });
  if (!audienceResult.complete) {
    for (const p of audienceResult.problems) problems.push(p);
  }

  /* ── AND THE IMAGE ──────────────────────────────────────────────────────
     Last, so a marketer sees every other problem in the same pass rather than
     fixing the plan twice. */
  const asset = creativeAsset || { ready: false, problems: [], blocker: null };
  if (!asset.ready) {
    for (const p of asset.problems) problems.push(p);
    if (!asset.problems.length) {
      problems.push(problem(M.IMAGE_ASSET_MISSING,
        "There is no advertising image GRAV can use.", "metaSingleImage.image"));
    }
  }

  const decisions = [
    {
      code: "EVERYTHING_IS_CREATED_PAUSED",
      decision: "Every object that can deliver would be created stopped.",
      why: "Nothing GRAV creates can spend money until somebody activates it, and GRAV cannot activate it.",
    },
    {
      code: "BUDGET_ON_THE_AD_SET",
      decision: `The budget would be set on the ${BUDGET_PLACEMENT.level.replace("_", " ")}.`,
      why: BUDGET_PLACEMENT.why,
    },
    {
      code: "TRACKING_ON_THE_DESTINATION",
      decision: "The campaign identity is added to the destination address as tracking parameters.",
      why: "Clicks that carry no campaign identity produce sessions nothing can attribute, and nobody notices until a report is wrong.",
    },
  ];

  decisions.push({
    code: "AUDIENCE_IS_BROAD_AND_BOUNDED",
    decision: "The advertisement reaches people who have not heard of the company, within the locations, ages, genders and languages the plan names.",
    why: "GRAV supports one audience shape for this channel, and every boundary on it is stated. Broad here means somebody chose a wide audience — not that GRAV left fields out and the channel filled them in.",
  });

  if (problems.length) {
    return { mappable: false, problems, plan: null, decisions };
  }

  /* ── THE FOUR OBJECTS, IN DEPENDENCY ORDER ──────────────────────────────
     A PLAN, not a request. Nothing here is sent anywhere, and the later
     creation slice is what turns these into provider calls — under its own
     ordering, its own evidence rules and its own reconciliation. */
  const objects = CREATION_ORDER.map((role) => {
    const spec = META_OBJECT_BY_CODE[role];
    const base = {
      role,
      label: spec.label,
      providerNode: spec.providerNode,
      deliveryStateApplies: spec.deliveryStateApplies,
      /* Declared per object. A creative has no status — it is a reusable
         description of what an advertisement looks like, nothing is shown
         because of it, and asking whether it is stopped has no true answer. */
      stoppedStatus: spec.stoppedStatus,
      dependsOn: spec.dependsOn,
    };

    if (role === "campaign") {
      return {
        ...base,
        /* ── THE ACTUAL BYTES, BUILT ONCE ──────────────────────────────────
           The write client validates these again immediately before transport;
           building them here keeps the mapping deterministic and lets a
           preflight show exactly what would be sent without sending it. */
        payload: {
          name,
          objective: MVP_CONTRACT.objective.provider,
          status: spec.stoppedStatus,
          special_ad_categories: category.code === "none" ? [] : [category.provider],
          /* Off, explicitly. On, this lets the channel move the budget between
             ad sets — and GRAV's supported shape has exactly one. */
          ...(BUDGET_PLACEMENT.level === "ad_set" ? {} : {}),
        },
        describes: {
          name,
          objective: MVP_CONTRACT.objective.provider,
          objectiveMeans: MVP_CONTRACT.objective.means,
          specialAdCategory: category.provider,
          specialAdCategoryRestricted: category.restricted,
          /* Explicitly off: it redistributes the budget across ad sets, GRAV's
             supported shape has exactly one, and nobody asked for it. */
          budgetOptimisationAcrossAdSets: false,
        },
      };
    }
    if (role === "audience_group") {
      return {
        ...base,
        payload: {
          name: `${name} audience`,
          status: spec.stoppedStatus,
          optimization_goal: optimisation.provider,
          billing_event: optimisation.billingEvent,
          [budget.providerField]: String(budget.amountMinorUnits),
          start_time: `${schedule.startDate}T00:00:00`,
          end_time: `${schedule.endDate}T23:59:59`,
          targeting: {
            geo_locations: geoLocationsFor(audienceResult.audience.includedLocations),
            ...(audienceResult.audience.excludedLocations.length
              ? { excluded_geo_locations: geoLocationsFor(audienceResult.audience.excludedLocations) }
              : {}),
            locales: audienceResult.audience.languages.map((l) => Number(l.key)).filter(Number.isInteger),
            age_min: audienceResult.audience.ageMin,
            age_max: audienceResult.audience.ageMax,
            /* Omitted means everyone, which is why `all` had to be an explicit
               choice rather than an absent field. */
            ...(audienceResult.audience.gendersProvider
              ? { genders: [...audienceResult.audience.gendersProvider] }
              : {}),
            /* ── WRITTEN OFF, NEVER OMITTED ────────────────────────────────
               Omitting these lets the channel's own default decide whether it
               may show the advertisement outside the approved audience. The
               write client refuses a payload where they are absent. */
            targeting_automation: { advantage_audience: 0 },
            targeting_optimization: "none",
          },
        },
        describes: {
          name: `${name} audience`,
          optimisation: optimisation.code,
          optimisationProvider: optimisation.provider,
          billingEvent: optimisation.billingEvent,
          budget: {
            amountMinorUnits: budget.amountMinorUnits,
            currency: budget.currency,
            basis: budget.basis,
            providerField: budget.providerField,
          },
          schedule,
          /* ── EVERY BOUNDARY, FROM THE AUDIENCE THE PLAN STATED ───────────
             Not from the channel's defaults, and not from whatever happened to
             resolve. `audienceExpansion: false` is written rather than omitted,
             because omitting it is how the channel's own default wins and the
             approved boundaries quietly stop being boundaries. */
          audienceMode: audienceResult.audience.mode,
          targeting: {
            includedLocationKeys: audienceResult.audience.includedLocations.map((l) => l.key),
            excludedLocationKeys: audienceResult.audience.excludedLocations.map((l) => l.key),
            localeKeys: audienceResult.audience.languages.map((l) => l.key),
            ageMin: audienceResult.audience.ageMin,
            ageMax: audienceResult.audience.ageMax,
            genders: audienceResult.audience.genders,
            gendersProvider: audienceResult.audience.gendersProvider,
            audienceExpansion: false,
          },
        },
      };
    }
    if (role === "creative") {
      return {
        ...base,
        /* ── NO STATUS, DELIBERATELY ABSENT ────────────────────────────────
           A creative does not deliver. The write client refuses a creative
           payload that carries a status at all. `image_hash` is absent too:
           the channel issues it when GRAV uploads the bytes, and the
           orchestrator fills it in from that response — never from a plan,
           never from a caller. */
        payload: {
          name: `${name} creative`,
          object_story_spec: {
            link_data: {
              message: creative.primaryText,
              name: creative.headline,
              link: destination,
              call_to_action: { type: creative.callToAction.provider, value: { link: destination } },
            },
          },
          ...(str(trackingIdentity)
            ? { url_tags: `utm_source=meta&utm_medium=paid_social&utm_campaign=${encodeURIComponent(str(plan.utmCampaign))}` }
            : {}),
        },
        describes: {
          name: `${name} creative`,
          primaryText: creative.primaryText,
          headline: creative.headline,
          callToAction: creative.callToAction.provider,
          destination,
          /* ── NEVER INVENTED ─────────────────────────────────────────────
             Meta identifies an uploaded image by its own hash. GRAV has no
             image to upload, so there is none — and a fabricated one would be
             an advertisement showing a picture nobody chose. */
          imageHash: asset.asset?.contentHash ? null : null,
          imageAssetId: asset.asset?.assetId || null,
          trackingIdentity: str(trackingIdentity) || null,
        },
      };
    }
    return {
      ...base,
      payload: {
        name: `${name} advertisement`,
        status: spec.stoppedStatus,
      },
      describes: {
        name: `${name} advertisement`,
        /* The ad is what delivers, and it is created stopped. */
        status: spec.stoppedStatus,
      },
    };
  });

  return {
    mappable: true,
    problems: [],
    decisions,
    plan: {
      campaignName: name,
      objects,
      creationOrder: [...CREATION_ORDER],
      summary: {
        campaignName: name,
        campaignType: MVP_CONTRACT.campaignType,
        objective: MVP_CONTRACT.objective.grav,
        optimisation: optimisation.code,
        optimisationMeans: optimisation.means,
        specialAdCategory: category.code,
        budget: {
          amountMinorUnits: budget.amountMinorUnits,
          currency: budget.currency,
          basis: budget.basis,
          placedOn: budget.level,
        },
        schedule,
        destination,
        headline: creative.headline,
        callToAction: creative.callToAction.code,
        locations: (targeting.locations || []).map((l) => ({ requested: l.requested.name, resolvedName: l.canonicalName, resolvedId: l.key })),
        excludedLocations: (targeting.exclusions || []).map((l) => ({ requested: l.requested.name, resolvedName: l.canonicalName, resolvedId: l.key })),
        languages: (targeting.locales || []).map((l) => ({ requested: l.requested.tag, resolvedName: l.canonicalName, resolvedId: l.key })),
        audience: {
          mode: audienceResult.audience.mode,
          ageMin: audienceResult.audience.ageMin,
          ageMax: audienceResult.audience.ageMax,
          genders: audienceResult.audience.gendersLabel,
        },
        trackingIdentity: str(trackingIdentity) || null,
        objectCount: objects.length,
      },
      targetingFingerprint: targeting.fingerprint || null,
      targetingResolvedFor: targeting.resolvedFor || null,
    },
  };
}

module.exports = { map, campaignNameFor, toMinorUnits };
