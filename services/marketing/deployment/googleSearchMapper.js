// services/marketing/deployment/googleSearchMapper.js
//
// AN APPROVED GRAV PLAN → THE GOOGLE SEARCH OBJECTS THAT WOULD BE CREATED.
//
// ── PURE, AND THAT IS THE POINT ────────────────────────────────────────────
// No network, no database, no clock, no randomness, no `process.env`. Given the
// same plan and the same account facts it returns the same objects, byte for
// byte, for ever. Three things depend on that:
//
//   A preflight can show somebody exactly what will be created, and the creation
//   that follows creates that and not something slightly different.
//
//   The command fingerprint the attempt record is keyed on can be computed from
//   the mapping. A mapper that reached for `Date.now()` would make every retry a
//   different command, and the idempotency the whole deployment record is built
//   on would silently stop working.
//
//   It can be tested exhaustively without a fake transport, which is where the
//   refusals below actually get proved.
//
// ── REFUSE, NEVER TRIM ─────────────────────────────────────────────────────
// GRAV allows a 120-character headline because a plan is written before anybody
// picks a channel. Google allows 30. There are exactly two ways to resolve that
// and only one of them is honest.
//
// Trimming produces "Summer collection — free delivery o", which is money spent
// on a sentence that stops mid-word, approved by nobody, discovered by a person
// looking at a Google screen weeks later. So every overflow is a refusal that
// names the field, the actual length and the allowance, and the plan goes back
// to its author.
//
// The same rule covers absences. Google has a default bidding strategy, a
// default match type, a default network setting. Every one of them decides how
// money is spent. A plan that does not say is a plan that cannot be deployed,
// not a plan that gets Google's opinion.
"use strict";

const {
  GOOGLE_SEARCH_LIMITS: L,
  NON_DELIVERING_STATUS,
  SEARCH_CHANNEL_TYPE,
  KEYWORD_MATCH_TYPE,
  BIDDING_TO_GOOGLE,
  BUDGET_RELATIONSHIP_TO_GOOGLE,
  EU_POLITICAL_DECLARATION_TO_GOOGLE,
  MAPPING_CODES: M,
} = require("../../../constants/marketingGoogleSearchDeployment");

const str = (v) => String(v ?? "").trim();
const isText = (v) => typeof v === "string" && v.trim() !== "";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/* ── A REFUSAL IS DATA, NOT AN EXCEPTION ────────────────────────────────────
   The mapper collects every problem rather than throwing on the first. An
   author who fixes one headline and is then told about the next one, and the
   next, edits a plan six times. One list is one edit. */
const problem = (code, message, field, extra = {}) => ({ code, message, field, ...extra });

/* Google's money unit. Integers only: `0.1 + 0.2` is not `0.3`, and a budget
   that is a fraction of a micro out is a budget Google rounds in a direction
   nobody chose. */
function toMicros(amount, field, problems) {
  if (!isNum(amount) || amount < 0) {
    problems.push(problem(M.BUDGET_MISSING, "An amount is needed.", field));
    return null;
  }
  const micros = Math.round(amount * L.MICROS_PER_UNIT);
  /* Round-trip check: if the rounding moved the value, the plan carried more
     precision than the currency has, and silently absorbing that is how an
     approved 12.345 becomes a charged 12.35. */
  if (Math.abs(micros / L.MICROS_PER_UNIT - amount) > Number.EPSILON * Math.max(1, Math.abs(amount))) {
    problems.push(problem(M.BUDGET_NOT_WHOLE_MICROS,
      "That amount is more precise than the advertising channel can hold. Round it before approving.", field));
    return null;
  }
  return micros;
}

/* ── THE CAMPAIGN'S NAME ────────────────────────────────────────────────────
   The plan reference leads, because it is the one string that ties a Google
   campaign back to a GRAV plan by eye, and a person reconciling an account is
   reading a list of names. Deterministic: same plan, same name, always. */
const campaignNameFor = (plan) => `${str(plan.draftRef)} ${str(plan.name)}`.trim();

/* ── WHERE A CLICK GOES, WITH THE TRACKING THE PLAN OWNS ────────────────────
   Built here rather than left to Google's own tracking template, because the
   UTM identity is the field the plan enforces uniqueness on and analytics
   attributes by. A campaign deployed without it produces sessions nothing can
   attribute, and nobody notices until a report is wrong.

   Existing query parameters are preserved; a collision with one of the five UTM
   keys is a refusal rather than an overwrite. */
function finalUrlFor({ plan, brief }, problems) {
  const dest = brief.destination;
  if (!dest || !isText(dest.kind)) {
    problems.push(problem(M.DESTINATION_UNRESOLVED, "The plan does not say where a click goes.", "destination"));
    return null;
  }
  if (dest.kind !== "grav_site_url") {
    /* A content-library landing page has no public URL until the library
       publishes one, and this chunk has no resolver for that. Refused by name
       rather than mapped to a guessed path — a wrong final URL is a campaign
       that sends every click to a 404 and still charges for them. */
    problems.push(problem(M.DESTINATION_UNRESOLVED,
      "GRAV cannot yet turn a content-library landing page into an address Google can send clicks to. Use a page on the company website.",
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
    problems.push(problem(M.DESTINATION_UNRESOLVED, "That destination is not an address Google can send clicks to.", "destination.url"));
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    problems.push(problem(M.DESTINATION_UNRESOLVED, "A destination must be a web address.", "destination.url"));
    return null;
  }

  const utm = str(plan.utmCampaign);
  if (!utm) {
    problems.push(problem(M.UTM_MISSING,
      "The plan has no campaign identity, so its clicks could not be attributed to it.", "utmCampaign"));
    return null;
  }

  const params = {
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: utm,
  };
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

  /* Sorted, so the same plan always produces the same string regardless of the
     order a URL's existing parameters happened to be written in. */
  url.searchParams.sort();
  const final = url.toString();

  if (final.length > L.FINAL_URL_MAX) {
    problems.push(problem(M.DESTINATION_TOO_LONG,
      `The destination address is ${final.length} characters once tracking is added. Google allows ${L.FINAL_URL_MAX}.`,
      "destination.url"));
    return null;
  }
  return final;
}

function mapCreative(brief, problems) {
  const creative = brief.googleSearch || null;
  if (!creative) {
    problems.push(problem(M.BRIEF_MISSING, "The plan has no Google Search ad text.", "googleSearch"));
    return null;
  }

  const headlines = (creative.headlines || []).map(str).filter(Boolean);
  const descriptions = (creative.descriptions || []).map(str).filter(Boolean);
  const keywords = (creative.keywordThemes || []).map(str).filter(Boolean);

  if (headlines.length < L.HEADLINES_MIN || headlines.length > L.HEADLINES_MAX) {
    problems.push(problem(M.HEADLINE_COUNT,
      `A Google Search ad needs between ${L.HEADLINES_MIN} and ${L.HEADLINES_MAX} headlines. This plan has ${headlines.length}.`,
      "googleSearch.headlines"));
  }
  headlines.forEach((h, i) => {
    if (h.length > L.HEADLINE_MAX_CHARS) {
      problems.push(problem(M.HEADLINE_TOO_LONG,
        `Headline ${i + 1} is ${h.length} characters. Google allows ${L.HEADLINE_MAX_CHARS}, and GRAV will not shorten it for you.`,
        `googleSearch.headlines.${i}`, { length: h.length, allowed: L.HEADLINE_MAX_CHARS }));
    }
  });

  if (descriptions.length < L.DESCRIPTIONS_MIN || descriptions.length > L.DESCRIPTIONS_MAX) {
    problems.push(problem(M.DESCRIPTION_COUNT,
      `A Google Search ad needs between ${L.DESCRIPTIONS_MIN} and ${L.DESCRIPTIONS_MAX} descriptions. This plan has ${descriptions.length}.`,
      "googleSearch.descriptions"));
  }
  descriptions.forEach((d, i) => {
    if (d.length > L.DESCRIPTION_MAX_CHARS) {
      problems.push(problem(M.DESCRIPTION_TOO_LONG,
        `Description ${i + 1} is ${d.length} characters. Google allows ${L.DESCRIPTION_MAX_CHARS}, and GRAV will not shorten it for you.`,
        `googleSearch.descriptions.${i}`, { length: d.length, allowed: L.DESCRIPTION_MAX_CHARS }));
    }
  });

  if (keywords.length < L.KEYWORDS_MIN || keywords.length > L.KEYWORDS_MAX) {
    problems.push(problem(M.KEYWORD_COUNT,
      `A Search campaign needs between ${L.KEYWORDS_MIN} and ${L.KEYWORDS_MAX} search terms. This plan has ${keywords.length}.`,
      "googleSearch.keywordThemes"));
  }
  keywords.forEach((k, i) => {
    if (k.length > L.KEYWORD_MAX_CHARS) {
      problems.push(problem(M.KEYWORD_TOO_LONG,
        `Search term ${i + 1} is ${k.length} characters. Google allows ${L.KEYWORD_MAX_CHARS}.`,
        `googleSearch.keywordThemes.${i}`));
    }
    if (k.split(/\s+/).filter(Boolean).length > L.KEYWORD_MAX_WORDS) {
      problems.push(problem(M.KEYWORD_TOO_MANY_WORDS,
        `Search term ${i + 1} has more than ${L.KEYWORD_MAX_WORDS} words, which Google will not accept.`,
        `googleSearch.keywordThemes.${i}`));
    }
  });

  return { headlines, descriptions, keywords };
}

function mapBidding({ brief, accountCurrency }, problems) {
  const bidding = brief.bidding || null;
  if (!bidding || !isText(bidding.strategy)) {
    problems.push(problem(M.BIDDING_UNSUPPORTED,
      "The plan does not say how to bid. GRAV will not let Google's default decide how the money is spent.",
      "bidding.strategy"));
    return null;
  }

  const spec = BIDDING_TO_GOOGLE[bidding.strategy];
  if (!spec) {
    problems.push(problem(M.BIDDING_UNSUPPORTED,
      `GRAV cannot deploy the "${bidding.strategy}" bidding strategy to Google Search.`,
      "bidding.strategy"));
    return null;
  }

  if (!spec.needsTarget) {
    return { strategy: bidding.strategy, field: spec.field, payload: { ...spec.payload }, targetMicros: null, targetLevel: null, needsConversionAction: false, means: spec.means };
  }

  const amount = bidding.target?.amount;
  const currency = str(bidding.target?.currency).toUpperCase();
  if (!isNum(amount) || amount <= 0) {
    problems.push(problem(M.BIDDING_TARGET_MISSING,
      "That bidding strategy aims at an amount, and the plan does not carry one.",
      "bidding.target.amount"));
    return null;
  }
  if (!currency) {
    problems.push(problem(M.BIDDING_TARGET_CURRENCY, "A bidding target needs its currency.", "bidding.target.currency"));
    return null;
  }
  if (accountCurrency && currency !== accountCurrency) {
    problems.push(problem(M.CURRENCY_MISMATCH,
      `The bidding target is in ${currency} and the advertising account bills in ${accountCurrency}. The amount would mean something different once created.`,
      "bidding.target.currency"));
    return null;
  }

  const targetMicros = toMicros(amount, "bidding.target.amount", problems);
  if (targetMicros === null) return null;

  return {
    strategy: bidding.strategy,
    field: spec.field,
    payload: { ...(spec.payload || {}) },
    targetMicros,
    targetField: spec.targetField,
    targetLevel: spec.targetLevel,
    needsConversionAction: spec.needsConversionAction === true,
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
    /* ── THE CHECK THAT STOPS A BUDGET MEANING SOMETHING ELSE ─────────────
       Google does not convert. A budget approved as 500 in an account billing
       in another currency is created as 500 of THAT currency. Nobody reviews
       this, because the number on the screen is the number that was approved. */
    problems.push(problem(M.CURRENCY_MISMATCH,
      `The budget is in ${currency} and the advertising account bills in ${accountCurrency}. Creating it would change what was approved.`,
      "budget.currency"));
    return null;
  }

  const relationship = str(brief.budgetRelationship);
  const spec = BUDGET_RELATIONSHIP_TO_GOOGLE[relationship];
  if (!spec) {
    problems.push(problem(M.BUDGET_RELATIONSHIP_UNSUPPORTED,
      relationship
        ? `GRAV cannot deploy the "${relationship}" budget arrangement to Google Search.`
        : "The plan does not say whether the budget is the campaign's total or its daily amount.",
      "budgetRelationship"));
    return null;
  }

  const micros = toMicros(budget.amount, "budget.amount", problems);
  if (micros === null) return null;

  if (spec.period === "DAILY" && micros < L.MIN_DAILY_BUDGET_MICROS) {
    problems.push(problem(M.BUDGET_BELOW_PROVIDER_MINIMUM,
      "That daily budget is below the smallest amount Google Ads accepts.",
      "budget.amount"));
    return null;
  }

  return {
    amountMicros: micros,
    currency,
    deliveryMethod: spec.deliveryMethod,
    period: spec.period,
    relationship,
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
    problems.push(problem(M.TIMEZONE_MISSING,
      "The plan does not say which timezone its dates are in.", "timezone"));
    return null;
  }

  /* ── THE DATES ARE THE ACCOUNT'S DAYS, NOT THE PLAN'S ───────────────────
     Google interprets a campaign's start and end dates in the ADVERTISING
     ACCOUNT's timezone; it has no field for any other. So a plan whose brief
     says one timezone and an account that keeps another would run on days up to
     a day away from what somebody intended, and converting silently would mean
     the stored plan and the live campaign disagree about when it starts.

     Refused, with both names, so whoever fixes it decides which one was right. */
  if (accountTimeZone && planTz !== accountTimeZone) {
    problems.push(problem(M.TIMEZONE_MISMATCH,
      `The plan's dates are in ${planTz} and the advertising account keeps ${accountTimeZone}. Google runs a campaign on the account's days, so these would not be the days that were approved.`,
      "timezone"));
    return null;
  }

  return {
    /* ── GOOGLE v25's OWN FORMAT ──────────────────────────────────────────
       `start_date`/`end_date` no longer exist. `start_date_time` and
       `end_date_time` are "yyyy-MM-dd HH:mm:ss" in the account's timezone, and
       Google's own guidance for daily granularity is 00:00:00 and 23:59:59. */
    startDateTime: `${start} 00:00:00`,
    endDateTime: `${end} 23:59:59`,
    /* Carried so the mapping can be read without decoding the two above. */
    startCalendarDate: start,
    endCalendarDate: end,
    timezone: planTz,
  };
}

/**
 * Map an approved plan to the Google Search objects that would be created.
 *
 * @param {object}  args
 * @param {object}  args.plan            the approved plan, as stored
 * @param {object}  args.account         `{ currency, timeZone }` read from the
 *                                       bound advertising account — NOT from
 *                                       configuration, and NOT optional once a
 *                                       real creation is at stake
 * @returns {{mappable:boolean, problems:object[], mapping:object|null, decisions:object[]}}
 */
function map({ plan, account = {}, resolvedTargeting = null }) {
  const problems = [];
  const accountCurrency = str(account.currency).toUpperCase() || null;
  const accountTimeZone = str(account.timeZone) || null;
  const accountId = str(account.externalAccountId) || null;

  const brief = (plan?.deploymentBriefs || []).find((b) => b.channel === "google_ads") || null;
  if (!brief) {
    return {
      mappable: false,
      problems: [problem(M.BRIEF_MISSING, "The plan has no Google Ads brief.", "deploymentBriefs")],
      mapping: null,
      decisions: [],
    };
  }
  if (str(brief.campaignType) !== "google_search") {
    return {
      mappable: false,
      problems: [problem(M.CAMPAIGN_TYPE_NOT_GOOGLE_SEARCH,
        "This mapper builds Google Search campaigns only.", "campaignType")],
      mapping: null,
      decisions: [],
    };
  }

  const name = campaignNameFor(plan);
  if (!name) {
    problems.push(problem(M.BRIEF_MISSING, "The plan has no name.", "name"));
  } else if (name.length > L.CAMPAIGN_NAME_MAX) {
    problems.push(problem(M.NAME_TOO_LONG,
      `The campaign name would be ${name.length} characters. Google allows ${L.CAMPAIGN_NAME_MAX}.`, "name"));
  }

  const creative = mapCreative(brief, problems);
  const bidding = mapBidding({ brief, accountCurrency }, problems);
  const budget = mapBudget({ plan, brief, accountCurrency }, problems);
  const schedule = mapSchedule({ plan, brief, accountTimeZone }, problems);
  const finalUrl = finalUrlFor({ plan, brief }, problems);

  /* ── THE ADVERTISER'S DECLARATION, OR NO CAMPAIGN ───────────────────────
     Required by Google on every new campaign, and a claim with legal weight.
     Never defaulted — see EU_POLITICAL_DECLARATION_TO_GOOGLE. */
  const euPolitical = EU_POLITICAL_DECLARATION_TO_GOOGLE[str(brief.euPoliticalAdvertising)] || null;
  if (!euPolitical) {
    problems.push(problem(M.EU_POLITICAL_DECLARATION_MISSING,
      "Google requires every new campaign to declare whether it contains EU political advertising. The plan does not say, and GRAV will not answer on the advertiser's behalf.",
      "euPoliticalAdvertising"));
  }

  /* ── TARGETING COMES IN RESOLVED, OR THIS DOES NOT MAP ──────────────────
     The mapper is given resolved targeting objects — identifiers, with the name
     the author wrote beside each one — and never free text. It cannot look
     anything up: it is pure, and a lookup is a network call.

     So a caller that has not resolved gets a refusal rather than a campaign with
     the targeting quietly missing. That is the whole correction: the earlier
     version carried on and reported `GEO_NOT_APPLIED`, and an untargeted Search
     campaign in Google means EVERYWHERE the moment somebody enables it. */
  const targeting = resolvedTargeting || null;
  if (!targeting) {
    problems.push(problem(M.TARGETING_NOT_RESOLVED,
      "GRAV has not resolved this plan's locations and languages against the advertising account, so it cannot build the campaign's targeting.",
      "targeting"));
  } else {
    /* ── AND THE FENCE IS CHECKED HERE TOO ────────────────────────────────
       The orchestrator checks it as well. This one catches a caller that
       resolved a DIFFERENT plan revision or a different account and passed the
       result in — the mapping would otherwise be built from targeting nobody
       approved for this revision. */
    const expected = {
      campaignDraftId: String(plan?._id || ""),
      draftRef: str(plan?.draftRef),
      approvedRevision: Number(plan?.revision) || 0,
      externalAccountId: str(account.externalAccountId || accountId || ""),
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

    const unresolved = [
      ...(targeting.locations || []),
      ...(targeting.exclusions || []),
      ...(targeting.languages || []),
    ].filter((e) => e.outcome !== "resolved");

    if (unresolved.length) {
      problems.push(problem(M.TARGETING_NOT_RESOLVED,
        `${unresolved.length} location${unresolved.length === 1 ? "" : "s"} or language${unresolved.length === 1 ? "" : "s"} could not be turned into advertising targeting.`,
        "targeting"));
    }
    if (!(targeting.locations || []).length) {
      problems.push(problem(M.GEO_NONE_SELECTED,
        "A campaign created with no location targeting is shown everywhere in the world.",
        "geoTargeting"));
    }
    /* A Search campaign with no language criterion is shown to every language.
       Less dangerous than worldwide, and still not what a plan that named a
       language asked for — so it is refused only when the brief named one and
       none survived, and when the brief named none at all. */
    if (!(targeting.languages || []).length) {
      problems.push(problem(M.LANGUAGE_NONE_SELECTED,
        "The plan names no language. A campaign created with no language targeting is shown to speakers of every language.",
        "languages"));
    }

    const includedIds = new Set((targeting.locations || []).filter((l) => l.criterionId).map((l) => l.criterionId));
    for (const ex of targeting.exclusions || []) {
      if (ex.criterionId && includedIds.has(ex.criterionId)) {
        problems.push(problem(M.GEO_INCLUDED_AND_EXCLUDED,
          `"${ex.canonicalName || ex.requested?.name}" is both targeted and excluded.`,
          "geoExclusions"));
      }
    }
  }

  const decisions = [
    {
      code: "KEYWORD_MATCH_TYPE",
      decision: `Every search term is created as a ${KEYWORD_MATCH_TYPE.toLowerCase()} match.`,
      why: "The plan records search terms in the author's words and holds no match type, because a match type is a Google concept. Broad match would spend on searches nobody wrote; exact match would match almost nothing.",
    },
    {
      code: "EVERYTHING_IS_CREATED_PAUSED",
      decision: `Every object that can deliver is created with status ${NON_DELIVERING_STATUS}.`,
      why: "Nothing GRAV creates can spend money until somebody activates it, and GRAV cannot activate it.",
    },
    {
      code: "TARGETING_IS_APPLIED",
      decision: "Every location, excluded location and language in the plan is created as a campaign criterion.",
      why: "A campaign created without them is shown everywhere, in every language, the moment somebody enables it in the advertising channel — and they would be looking at a campaign that appears complete.",
    },
  ];

  /* ── AUDIENCES STILL ARE NOT APPLIED, AND THAT IS SAID PLAINLY ──────────
     Unlike locations, an absent audience criterion on a Search campaign narrows
     nothing and widens nothing: a Search campaign without audiences is the
     ordinary case, and the terms somebody searched are the targeting. So this is
     a disclosure rather than a refusal — and it is the only one left. */
  if ((brief.audiences || []).length) {
    decisions.push({
      code: "AUDIENCES_NOT_APPLIED",
      decision: "The audiences in the plan are NOT applied to the created campaign.",
      why: "A Search campaign's audiences are account-level lists GRAV does not hold. Unlike a missing location, a missing audience does not widen where the campaign runs — the search terms are the targeting. Add them in the advertising channel before activating.",
      names: (brief.audiences || []).map((a) => str(a?.name)).filter(Boolean),
    });
  }

  if (problems.length) {
    return { mappable: false, problems, mapping: null, decisions };
  }

  /* ── THE OBJECTS, IN CREATION ORDER ─────────────────────────────────────
     Which is also dependency order. The orchestrator walks this list; it does
     not decide the order itself, so the order is testable here. */
  const campaign = {
    name,
    status: NON_DELIVERING_STATUS,
    advertisingChannelType: SEARCH_CHANNEL_TYPE,
    startDateTime: schedule.startDateTime,
    endDateTime: schedule.endDateTime,
    /* The advertiser's own declaration, never a default. See
       EU_POLITICAL_DECLARATION_TO_GOOGLE. */
    containsEuPoliticalAdvertising: euPolitical,
    /* ── SEARCH ONLY, EXPLICITLY ────────────────────────────────────────
       Google's default puts a Search campaign on the Display network and on
       search partners too. That is a different product spending the same
       budget in places nobody approved, so all three are named. */
    networkSettings: {
      targetGoogleSearch: true,
      targetSearchNetwork: false,
      targetContentNetwork: false,
      targetPartnerSearchNetwork: false,
    },
    [bidding.field]: {
      ...bidding.payload,
      ...(bidding.targetLevel === "campaign" && bidding.targetField
        ? { [bidding.targetField]: bidding.targetMicros }
        : {}),
    },
  };

  const objects = [
    {
      role: "budget",
      /* Named for the campaign, so an orphaned budget in an account can be
         traced to the plan that made it. */
      payload: {
        name: `${name} budget`,
        /* ── DAILY OR LIFETIME, NEVER BOTH ───────────────────────────────
           v25: `amount_micros` is the daily amount and is used only with a
           DAILY period; a CUSTOM_PERIOD budget carries `total_amount_micros`
           instead, and the two are mutually exclusive. Sending the daily
           field on a total budget is refused. */
        ...(budget.period === "CUSTOM_PERIOD"
          ? { totalAmountMicros: budget.amountMicros }
          : { amountMicros: budget.amountMicros }),
        deliveryMethod: budget.deliveryMethod,
        period: budget.period,
        /* Never shared. A shared budget is spent by other campaigns, and a
           GRAV campaign would then be capped by somebody else's spending. */
        explicitlyShared: false,
      },
    },
    { role: "campaign", payload: campaign },
    {
      role: "audience_group",
      payload: {
        name: `${name} ad group`,
        status: NON_DELIVERING_STATUS,
        type: "SEARCH_STANDARD",
        /* The bidding table names Google's level, `ad_group`. Compared against
           GRAV's role name, this never matched, and a manual-CPC bid was
           silently left off the ad group. */
        ...(bidding.targetLevel === "ad_group" && bidding.targetField
          ? { [bidding.targetField]: bidding.targetMicros }
          : {}),
      },
    },
    {
      role: "advertisement",
      payload: {
        status: NON_DELIVERING_STATUS,
        ad: {
          finalUrls: [finalUrl],
          responsiveSearchAd: {
            headlines: creative.headlines.map((text) => ({ text })),
            descriptions: creative.descriptions.map((text) => ({ text })),
          },
        },
      },
    },
    ...creative.keywords.map((text) => ({
      role: "targeting_term",
      payload: {
        status: NON_DELIVERING_STATUS,
        keyword: { text, matchType: KEYWORD_MATCH_TYPE },
      },
    })),

    /* ── THE TARGETING, LAST, BECAUSE IT NEEDS THE CAMPAIGN ─────────────────
       A campaign criterion has NO status field. It is not paused or running; it
       is a rule attached to a campaign, and the campaign's own status decides
       whether anything is shown. Giving it an invented status would be the
       budget mistake again — an answer to a question it has not got.

       `negative` is the field that matters, and it is written EXPLICITLY on
       every criterion, including the false case. Google's proto3 JSON omits a
       false boolean, so an inclusion and a dropped exclusion look identical on
       the wire — writing it explicitly is what makes the difference visible in
       a recorded request and in a test. */
    ...(targeting.locations || []).map((loc) => ({
      role: "location_target",
      /* The author's word, carried beside the identifier into GRAV's evidence.
         `2356` means nothing to the person checking this later. */
      displayName: loc.canonicalName || loc.requested?.name || "",
      requestedName: loc.requested?.name || "",
      negative: false,
      payload: {
        location: { geoTargetConstant: loc.resourceName },
        negative: false,
      },
    })),
    ...(targeting.exclusions || []).map((loc) => ({
      role: "location_target",
      displayName: loc.canonicalName || loc.requested?.name || "",
      requestedName: loc.requested?.name || "",
      negative: true,
      payload: {
        location: { geoTargetConstant: loc.resourceName },
        /* ── AN EXCLUSION STAYS AN EXCLUSION ─────────────────────────────
           There is exactly one place in GRAV where this is set, it is set from
           the list the target came out of rather than from a flag somebody
           could forget to copy, and a test reads it back off the created
           criterion. An exclusion silently flipped is a campaign spending money
           in the one place somebody said to stay out of. */
        negative: true,
      },
    })),
    ...(targeting.languages || []).map((lang) => ({
      role: "language_target",
      displayName: lang.canonicalName || lang.requested?.tag || "",
      requestedName: lang.requested?.tag || "",
      /* Google has no negative language criterion. Recorded as false rather than
         omitted so every criterion in the evidence answers the same question. */
      negative: false,
      payload: {
        language: { languageConstant: lang.resourceName },
      },
    })),
  ];

  return {
    mappable: true,
    problems: [],
    decisions,
    mapping: {
      campaignName: name,
      objects,
      /* The human-readable summary a preflight shows. Derived from the same
         values the payloads are built from, so it cannot describe something
         other than what would be created. */
      summary: {
        campaignName: name,
        campaignType: "google_search",
        status: NON_DELIVERING_STATUS,
        budget: {
          amountMicros: budget.amountMicros,
          currency: budget.currency,
          period: budget.period,
          relationship: budget.relationship,
        },
        bidding: {
          strategy: bidding.strategy,
          targetMicros: bidding.targetMicros,
          means: bidding.means,
        },
        schedule: {
          startDate: schedule.startCalendarDate,
          endDate: schedule.endCalendarDate,
          timezone: schedule.timezone,
        },
        finalUrl,
        headlineCount: creative.headlines.length,
        descriptionCount: creative.descriptions.length,
        keywordCount: creative.keywords.length,
        keywordMatchType: KEYWORD_MATCH_TYPE,
        networks: ["Google search results only"],
        /* Shown as names with their identifiers, so a person can check both. */
        locations: (targeting.locations || []).map((l) => ({
          requested: l.requested?.name, resolvedName: l.canonicalName, resolvedId: l.criterionId,
        })),
        excludedLocations: (targeting.exclusions || []).map((l) => ({
          requested: l.requested?.name, resolvedName: l.canonicalName, resolvedId: l.criterionId,
        })),
        languages: (targeting.languages || []).map((l) => ({
          requested: l.requested?.tag, resolvedName: l.canonicalName, resolvedId: l.criterionId,
        })),
        objectCount: objects.length,
      },
      /* Carried for the orchestrator's preflight, which must ask the account
         whether it can measure conversions before a strategy that needs it. */
      requiresConversionAction: bidding.needsConversionAction,
      /* Carried so the orchestrator can re-check the fence against the plan and
         binding it holds, rather than trusting the caller that passed it in. */
      targetingFingerprint: targeting.fingerprint || null,
      targetingResolvedFor: targeting.resolvedFor || null,
    },
  };
}

module.exports = { map, campaignNameFor, toMicros };
