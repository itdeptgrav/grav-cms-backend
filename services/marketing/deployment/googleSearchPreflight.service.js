// services/marketing/deployment/googleSearchPreflight.service.js
//
// WHAT WOULD BE CREATED, AND WHETHER THE ACCOUNT WOULD ACCEPT IT.
//
//   preflight({ companyId, draftRef })  →  creationReady, activationReady, …
//
// ── IT READS. IT WRITES NOTHING, ANYWHERE ──────────────────────────────────
// Not in the advertising account: every provider call it makes goes through the
// read client, whose transport refuses any verb but GET and any POST that has
// not named itself a read. Not in GRAV either: no deployment record, no attempt
// intent, no change to the plan. A preflight that wrote an attempt would leave
// a row claiming an external call was about to be made every time somebody
// opened a screen, and `hasUnresolvedAttempt` would then block the real one.
//
// ── TWO ANSWERS, AND ONE OF THEM IS ALWAYS NO ──────────────────────────────
// `creationReady` is earned: the account answered, its currency matches, its
// timezone matches, it is not a manager account, the name is free, and the plan
// maps without a single refusal.
//
// `activationReady` is false. Always, in this chunk, by construction — it is a
// frozen constant, not a computed value, so no combination of inputs can make
// it true. GRAV has no way to start a campaign delivering, and a caller reading
// `creationReady: true` on its own would reasonably conclude otherwise.
"use strict";

const { fail } = require("../../storePurchase/errors");
const googleAds = require("../channels/googleAdsClient");
const binding = require("./accountBinding.service");
const mapper = require("./googleSearchMapper");
const targeting = require("./targetingResolution.service");
const {
  PREFLIGHT_CHECKS,
  ACTIVATION_NOT_IN_THIS_CHUNK,
  NON_DELIVERING_STATUS,
} = require("../../../constants/marketingGoogleSearchDeployment");

const str = (v) => String(v ?? "").trim();

const CHECK_BY_CODE = Object.fromEntries(PREFLIGHT_CHECKS.map((c) => [c.code, c]));

/* ── A CHECK'S THREE ANSWERS, AND WHY THERE ARE THREE ───────────────────────
   `passed` and `failed` are facts. `could_not_check` is the one that stops this
   from lying: a provider that did not answer has not told GRAV the account is
   wrong, and reporting that as `failed` would send somebody to fix a binding
   that was correct. It blocks creation exactly as `failed` does — GRAV does not
   create into an account it could not read — but it says something different. */
const result = (code, status, detail = "") => ({
  code,
  label: CHECK_BY_CODE[code]?.label || code,
  means: CHECK_BY_CODE[code]?.means || "",
  status,
  detail,
  blocksCreation: CHECK_BY_CODE[code]?.blocksCreation === true,
});

/**
 * Read the bound account and answer every check that depends on it.
 *
 * A single failure to reach the account answers every account check as
 * `could_not_check` rather than leaving four of them absent — an absent check
 * reads as a check that passed.
 */
async function accountChecks({ bound, plan, mapping }, deps) {
  const client = deps.googleAds || googleAds;
  const checks = [];
  let account = null;

  try {
    account = await client.describeAccount({
      customerId: bound.externalAccountId,
      loginCustomerId: bound.loginAccountId,
    });
    checks.push(result("account_reachable", "passed",
      `GRAV read ${account.accountName || bound.externalAccountId}.`));
  } catch (err) {
    /* The provider's own message is not carried. It goes to the server log
       through `channelHttp`; what travels is GRAV's code. */
    const code = str(err?.code) || "CHANNEL_UNAVAILABLE";
    const unreadable = code === "CHANNEL_ACCESS_REFUSED" ? "failed" : "could_not_check";
    checks.push(result("account_reachable", unreadable,
      unreadable === "failed"
        ? "The advertising connection is not allowed to use this account."
        : "The advertising channel did not answer. This is not a wrong account — nothing could be read."));
    for (const code2 of ["account_currency_matches", "account_timezone_known", "account_not_manager", "account_usable", "name_not_already_used"]) {
      checks.push(result(code2, "could_not_check", "GRAV could not read the account."));
    }
    return { checks, account: null };
  }

  const planCurrency = str(plan.budget?.currency).toUpperCase();
  if (!account.currency) {
    checks.push(result("account_currency_matches", "could_not_check", "The account did not say which currency it bills in."));
  } else if (planCurrency && planCurrency !== account.currency) {
    checks.push(result("account_currency_matches", "failed",
      `The plan's budget is in ${planCurrency} and this account bills in ${account.currency}. Google does not convert, so the amount would mean something different.`));
  } else {
    checks.push(result("account_currency_matches", "passed", `The account bills in ${account.currency}.`));
  }

  checks.push(account.timeZone
    ? result("account_timezone_known", "passed", `The account's days are ${account.timeZone} days.`)
    : result("account_timezone_known", "could_not_check", "The account did not say which timezone it keeps."));

  checks.push(account.isManager
    ? result("account_not_manager", "failed", "This is a manager account. It holds other accounts, not campaigns.")
    : result("account_not_manager", "passed", "The account can hold campaigns."));

  /* Google's own account statuses. `ENABLED` here is the ACCOUNT being open —
     a different thing from a campaign delivering, and it is read, never set. */
  const usable = !account.status || account.status === "ENABLED";
  checks.push(usable
    ? result("account_usable", "passed", "The account is open.")
    : result("account_usable", "failed", "The advertising account is not open, so it accepts nothing."));

  /* ── IS THE NAME ALREADY TAKEN ──────────────────────────────────────────
     The single best defence against creating the same campaign twice, and the
     reason it is a BLOCKING check rather than an advisory one. A name already
     present means either somebody created it by hand or a previous attempt got
     further than its record says; both need a person, not a retry. */
  const wantedName = mapping?.campaignName || mapper.campaignNameFor(plan);
  try {
    const existing = await client.findCampaignsByName({
      customerId: bound.externalAccountId,
      loginCustomerId: bound.loginAccountId,
      name: wantedName,
    });
    /* A REMOVED campaign keeps its name in Google and cannot deliver. Counting
       it would block every re-creation after a rollback for ever. */
    const live = existing.filter((c) => c.status !== "REMOVED");
    checks.push(live.length
      ? result("name_not_already_used", "failed",
        `A campaign called "${wantedName}" already exists in this account. Creating a second one is how a duplicate gets made without anybody noticing.`)
      : result("name_not_already_used", "passed", "No campaign of this name exists in the account."));
  } catch {
    checks.push(result("name_not_already_used", "could_not_check",
      "GRAV could not check the account for an existing campaign of this name."));
  }

  if (mapping?.requiresConversionAction) {
    try {
      const present = await client.hasConversionAction({
        customerId: bound.externalAccountId,
        loginCustomerId: bound.loginAccountId,
      });
      checks.push(present
        ? result("conversion_action_present", "passed", "The account can measure conversions.")
        : result("conversion_action_present", "failed",
          "The chosen bidding strategy aims at a cost per conversion, and this account has nothing set up to measure one."));
    } catch {
      checks.push(result("conversion_action_present", "could_not_check",
        "GRAV could not check whether the account can measure conversions."));
    }
  } else {
    checks.push(result("conversion_action_present", "not_applicable",
      "The chosen bidding strategy does not aim at a cost per conversion."));
  }

  return { checks, account };
}

/**
 * @param {object}   args
 * @param {ObjectId} args.companyId
 * @param {object}   args.plan   the approved plan, as stored
 */
async function preflight({ companyId, plan }, deps = {}) {
  if (!plan) throw fail("NOT_FOUND", "That campaign plan could not be found.", { field: "plan" });

  const bound = await binding.forDeployment({ companyId, channel: "google_ads" });

  /* ── MAPPED TWICE, AND THE SECOND ONE IS THE REAL ONE ───────────────────
     Once against no account facts, to learn the campaign name for the
     duplicate check. Then again against the account's actual currency and
     timezone, because a mapping that passed with no account to compare against
     proves nothing about the account GRAV would create in. The second result is
     what is returned. */
  const { checks, account } = await accountChecks(
    { bound, plan, mapping: { campaignName: mapper.campaignNameFor(plan) } },
    deps,
  );

  /* ── EVERY PLACE AND LANGUAGE, TURNED INTO AN IDENTIFIER ────────────────
     Read-only, against the bound account. This is the check that replaced the
     old behaviour of creating a campaign and disclosing that its targeting was
     dropped — a campaign with no location criteria runs EVERYWHERE the moment
     somebody enables it, and they would be looking at one that appears
     complete. */
  const resolution = await targeting.resolve({ plan, bound }, deps);

  checks.push(resolution.complete
    ? result("targeting_resolvable", "passed",
      `${resolution.locations.length} location(s), ${resolution.exclusions.length} exclusion(s) and ${resolution.languages.length} language(s) resolved.`)
    : result("targeting_resolvable",
      /* An outage is not a wrong name. Kept apart so nobody re-spells a location
         that was correct. */
      resolution.blockers.some((b) => b.outcome === "provider_unavailable") ? "could_not_check" : "failed",
      resolution.blockers.map((b) => b.message).join(" ")));

  const mapped = mapper.map({
    plan,
    account: {
      currency: account?.currency || "",
      timeZone: account?.timeZone || "",
      externalAccountId: bound.externalAccountId,
    },
    resolvedTargeting: resolution,
  });

  const blocking = checks.filter((c) => c.blocksCreation && c.status !== "passed" && c.status !== "not_applicable");
  const advisoryFailed = checks.filter((c) => !c.blocksCreation && c.status === "failed");

  const creationReady = blocking.length === 0 && advisoryFailed.length === 0 && mapped.mappable === true;

  return {
    channel: "google_ads",
    campaignType: "google_search",

    account: {
      /* The bound account, echoed so a reader can see WHICH account this
         preflight was about. Never a credential, and never an account the
         caller chose in the request. */
      externalAccountId: bound.externalAccountId,
      externalAccountName: bound.externalAccountName || null,
      currency: account?.currency || bound.currency || null,
      timeZone: account?.timeZone || bound.timeZone || null,
      isTestAccount: account?.isTestAccount ?? null,
    },

    checks,

    /* ── THE TARGETING SECTION, IN GRAV'S OWN WORDS ───────────────────────
       Requested locations, requested exclusions, requested languages, what each
       resolved to, what did not resolve and why, and the one question a caller
       actually has. No Google API path, no credential name, no bearer value, no
       raw provider error: a criterion id and a canonical place name are all that
       travel, and both are printed on every screen of the advertising interface. */
    targeting: targeting.publicTargeting(resolution),

    /* Every reason the plan itself cannot be mapped, field by field, with the
       real length against the allowance where a limit was exceeded. */
    planProblems: mapped.problems,
    /* Choices GRAV made that the plan does not state, surfaced so nobody
       discovers them from a Google screen. */
    decisions: mapped.decisions,

    /* What would be created, in the words a person can check. The raw provider
       payloads are NOT here: they are a request body, they are rebuilt
       deterministically from the plan at creation time, and publishing them
       would make a mapping change look like a data change. */
    wouldCreate: mapped.mapping ? mapped.mapping.summary : null,

    creationReady,
    creationBlockers: [
      ...blocking.map((c) => ({ kind: "account", code: c.code, label: c.label, detail: c.detail, status: c.status })),
      ...advisoryFailed.map((c) => ({ kind: "account", code: c.code, label: c.label, detail: c.detail, status: c.status })),
      ...mapped.problems.map((p) => ({ kind: "plan", code: p.code, label: p.field, detail: p.message, status: "failed" })),
    ],

    /* ── READ FROM A FROZEN CONSTANT, NOT COMPUTED ─────────────────────────
       There is no expression anywhere in this file that could evaluate to true
       for this field. It is the constant's value, and the constant is frozen. */
    activationReady: ACTIVATION_NOT_IN_THIS_CHUNK.activationReady,
    activationBlocked: {
      reasonCode: ACTIVATION_NOT_IN_THIS_CHUNK.reasonCode,
      means: ACTIVATION_NOT_IN_THIS_CHUNK.means,
    },

    /* Stated rather than implied: a caller that sees `creationReady: true` is
       being told what creation would do, not that anything has happened. */
    ifCreated: {
      status: NON_DELIVERING_STATUS,
      createsAnything: creationReady,
      spendsMoney: false,
      delivers: false,
      means: "Creation makes a stopped campaign in the advertising account. It cannot be shown to anybody and it cannot spend, until somebody starts it in Google Ads.",
    },

    checkedAt: new Date(),

    /* ── NOT FOR THE WIRE ─────────────────────────────────────────────────
       The full resolution, including the internal fence, handed to the
       orchestrator so creation maps from the SAME resolution this preflight
       reported rather than resolving a second time and possibly differently.
       Stripped by the route, which builds its response field by field. */
    __resolution: resolution,
  };
}

module.exports = { preflight, PREFLIGHT_CHECKS };
