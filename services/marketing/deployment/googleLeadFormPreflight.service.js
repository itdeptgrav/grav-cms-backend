// services/marketing/deployment/googleLeadFormPreflight.service.js
//
// WHAT WOULD BE CREATED FOR A LEAD-FORM PLAN, AND WHETHER IT MAY BE — YET.
//
// ── IT READS. IT WRITES NOTHING, ANYWHERE ──────────────────────────────────
// The Search half is the Search preflight, unchanged: the bound account read,
// its currency, timezone and status, the duplicate-name check, the conversion
// action a cost-per-action bid needs, and the resolution of every place and
// language. Nothing is duplicated, so the two types cannot drift apart on the
// part they share.
//
// On top of it, the checks only a lead form has:
//
//   lead_form_definition        the form, judged against Google's contract
//   lead_form_serving_country   Google does not serve lead forms everywhere
//   lead_form_controlled_account  THE GATE: creation only into the account an
//                               administrator named as the proof account
//   lead_form_delivery_address  a public https address Google can post to
//   lead_form_delivery_key      the webhook secret can be derived
//
// and the ones only Google can answer, reported as external and never passed.
//
// ── NOTHING SECRET IN THE ANSWER ───────────────────────────────────────────
// The delivery address carries a signed token and the key is a secret. The
// answer says whether each is ready — never either value.
"use strict";

const { fail } = require("../../storePurchase/errors");
const binding = require("./accountBinding.service");
const searchPreflight = require("./googleSearchPreflight.service");
const leadFormMapper = require("./googleLeadFormMapper");
const definition = require("./googleLeadFormDefinition");
const webhookKey = require("../leads/leadWebhookKey");
const googleAds = require("../channels/googleAdsClient");
const G = require("../../../constants/marketingGoogleLeadForm");
const {
  ACTIVATION_NOT_IN_THIS_CHUNK,
  NON_DELIVERING_STATUS,
} = require("../../../constants/marketingGoogleSearchDeployment");

const str = (v) => String(v ?? "").trim();
const list = (v) => (Array.isArray(v) ? v : []);

const LABELS = Object.freeze({
  lead_form_definition: ["The lead form is complete", "Everything Google requires on the form, and nothing it refuses."],
  lead_form_serving_country: ["Lead forms serve where the campaign runs", "Google does not show lead forms in some countries."],
  lead_form_controlled_account: ["This is the proof account", "Until a lead form has been proven end to end, GRAV creates one only in the advertising account an administrator named for that proof."],
  lead_form_delivery_address: ["Google can reach GRAV", "Each enquiry is posted to a public https address on GRAV."],
  lead_form_delivery_key: ["The delivery secret can be made", "Google echoes a secret in every enquiry; GRAV derives it and never stores it."],
});

const check = (code, status, detail = "", blocksCreation = true) => ({
  code,
  label: LABELS[code]?.[0] || code,
  means: LABELS[code]?.[1] || "",
  status,
  detail,
  blocksCreation,
});

/* ── THE PROOF ACCOUNT ──────────────────────────────────────────────────────
   Named by an administrator in the environment, digits only. Absent means no
   account is a proof account — which is the safe default, and blocks creation. */
function controlledAccounts(env = process.env) {
  return str(env?.[G.CONTROLLED_ACCOUNT_VAR])
    .split(",").map((v) => v.replace(/-/g, "").trim())
    .filter((v) => /^\d{1,20}$/.test(v));
}

/* ── THE ADDRESS GOOGLE WILL POST TO ────────────────────────────────────────
   `API_PUBLIC_URL`, the variable the backend already uses for public links.
   Required to be set, https and not a local address: Google cannot post to
   localhost, and a campaign created pointing there collects enquiries nobody
   receives. No fallback. */
function deliveryBase(env = process.env) {
  const raw = str(env?.API_PUBLIC_URL).replace(/\/+$/, "");
  let ok = false;
  try {
    const u = new URL(raw);
    ok = u.protocol === "https:" && !/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname);
  } catch { ok = false; }
  return ok ? raw : null;
}

const deliveryUrlFor = (base, deliveryToken) => `${base}/api/cms/marketing/google-leads/${encodeURIComponent(deliveryToken)}`;

/**
 * @param {object}   args
 * @param {ObjectId} args.companyId
 * @param {object}   args.plan   the approved plan, as stored
 */
async function preflight({ companyId, plan, env = process.env }, deps = {}) {
  if (!plan) throw fail("NOT_FOUND", "That campaign plan could not be found.", { field: "plan" });
  const brief = list(plan.deploymentBriefs).find((b) => b.channel === "google_ads") || null;
  if (str(brief?.campaignType) !== "google_lead_form") {
    throw fail("VALIDATION", "This plan is not a Search campaign with a lead form.", { field: "campaignType" });
  }

  const bound = await binding.forDeployment({ companyId, channel: "google_ads" });

  /* ── THE SEARCH HALF, UNCHANGED ─────────────────────────────────────────── */
  const search = await searchPreflight.preflight({ companyId, plan: leadFormMapper.asSearchPlan(plan) }, deps);
  const resolution = search.__resolution;
  const checks = search.checks.slice();

  /* ── THE CONVERSION ACTION, ACTUALLY READ ───────────────────────────────
     A lead form needs cost-per-action bidding, and that needs something in the
     account to measure a conversion. The Search preflight decides whether to
     ask from a first-pass mapping that never carries the answer, so for a
     lead form the question is asked here, directly, and replaces its row. */
  const conversionAt = checks.findIndex((c) => c.code === "conversion_action_present");
  let conversion;
  try {
    const present = await (deps.googleAds || googleAds).hasConversionAction({
      customerId: bound.externalAccountId, loginCustomerId: bound.loginAccountId,
    });
    conversion = present
      ? { status: "passed", detail: "The account can measure conversions." }
      : { status: "failed", detail: "A lead form bids towards conversions, and this account has nothing set up to measure one." };
  } catch {
    conversion = { status: "could_not_check", detail: "GRAV could not check whether the account can measure conversions." };
  }
  const conversionRow = {
    ...(conversionAt >= 0 ? checks[conversionAt] : { code: "conversion_action_present", label: "The account can measure conversions", means: "" }),
    ...conversion,
    blocksCreation: true,
  };
  if (conversionAt >= 0) checks[conversionAt] = conversionRow;
  else checks.push(conversionRow);

  /* ── THE FORM ───────────────────────────────────────────────────────────── */
  const verdict = definition.evaluate({ form: brief.googleLeadForm, brief, plan, binding: bound, scope: "deployment" });
  checks.push(verdict.blocking.length
    ? check("lead_form_definition", "failed", verdict.blocking.map((c) => c.means).join(" "))
    : check("lead_form_definition", "passed", "The form has everything Google requires, and nothing GRAV refuses."));

  /* ── WHERE IT WOULD SERVE ───────────────────────────────────────────────
     Judged from the RESOLVED locations, which carry Google's own country code;
     the plan's names do not. */
  const countries = list(resolution?.locations).map((l) => str(l.countryCode).toUpperCase()).filter(Boolean);
  if (!resolution?.complete) {
    checks.push(check("lead_form_serving_country", "could_not_check", "The locations could not be resolved, so the countries are not known."));
  } else if (!countries.length) {
    checks.push(check("lead_form_serving_country", "could_not_check", "The resolved locations did not say which country they are in."));
  } else {
    const nonServing = countries.filter((c) => G.NON_SERVING_COUNTRIES.includes(c));
    checks.push(nonServing.length === countries.length
      ? check("lead_form_serving_country", "failed", "Google does not show lead forms in any country this campaign targets, so it would collect nothing.")
      : check("lead_form_serving_country", "passed", nonServing.length
        ? "Lead forms serve in some of the countries targeted, and will not appear in the rest."
        : "Lead forms serve in the countries this campaign targets."));
  }

  /* ── THE GATE ───────────────────────────────────────────────────────────── */
  const proof = controlledAccounts(env);
  checks.push(proof.includes(str(bound.externalAccountId))
    ? check("lead_form_controlled_account", "passed", "The bound account is the one named for proving lead forms.")
    : check("lead_form_controlled_account", "failed", proof.length
      ? "The bound advertising account is not the one named for proving lead forms. Until the proof is complete, GRAV creates lead forms nowhere else."
      : `No advertising account is named for proving lead forms. An administrator sets ${G.CONTROLLED_ACCOUNT_VAR} to the proof account.`));

  /* ── DELIVERY ───────────────────────────────────────────────────────────── */
  const base = deliveryBase(env);
  checks.push(base
    ? check("lead_form_delivery_address", "passed", "GRAV has a public https address for Google to post enquiries to.")
    : check("lead_form_delivery_address", "failed", "API_PUBLIC_URL is not set to a public https address, so Google would have nowhere to send an enquiry."));
  const key = webhookKey.availability({ env });
  checks.push(key.available
    ? check("lead_form_delivery_key", "passed", "The delivery secret can be derived.")
    : check("lead_form_delivery_key", "failed", `The delivery secret cannot be derived: ${key.variable || "the key ring"} is not configured.`));

  /* ── THE MAPPING, FROM THE SAME RESOLUTION ──────────────────────────────── */
  const mapped = leadFormMapper.map({
    plan,
    account: {
      currency: search.account.currency || "",
      timeZone: search.account.timeZone || "",
      externalAccountId: bound.externalAccountId,
    },
    resolvedTargeting: resolution,
  });

  const blocking = checks.filter((c) => c.blocksCreation && c.status !== "passed" && c.status !== "not_applicable");
  const creationReady = blocking.length === 0 && mapped.mappable === true;

  return {
    channel: "google_ads",
    campaignType: "google_lead_form",
    account: search.account,
    checks,
    targeting: search.targeting,
    planProblems: mapped.problems,
    decisions: mapped.decisions,
    wouldCreate: mapped.mapping ? mapped.mapping.summary : null,
    /* ── WHAT ONLY GOOGLE CAN ANSWER, SAID AND NEVER PASSED ──────────────── */
    externalChecksRequired: [
      { code: "lead_form_conversion_goal", means: "Google serves a lead form only on a campaign optimised towards a lead-form conversion goal. GRAV does not set or read that goal; it has to be confirmed in the account before anybody starts the campaign." },
      { code: "account_vertical_eligible", means: "Google requires a good policy history and an eligible kind of business for lead forms. Google decides when the form is created." },
      { code: "real_lead_delivery", means: "No enquiry from a GRAV-created lead form has yet reached GRAV. The first one is the proof the type needs before it is offered." },
    ],
    creationReady,
    creationBlockers: [
      ...blocking.map((c) => ({ kind: "account", code: c.code, label: c.label, detail: c.detail, status: c.status })),
      ...mapped.problems.map((p) => ({ kind: "plan", code: p.code, label: p.field, detail: p.message, status: "failed" })),
    ],
    activationReady: ACTIVATION_NOT_IN_THIS_CHUNK.activationReady,
    activationBlocked: {
      reasonCode: ACTIVATION_NOT_IN_THIS_CHUNK.reasonCode,
      means: ACTIVATION_NOT_IN_THIS_CHUNK.means,
    },
    ifCreated: {
      status: NON_DELIVERING_STATUS,
      formStatus: NON_DELIVERING_STATUS,
      createsAnything: creationReady,
      spendsMoney: false,
      delivers: false,
      means: "Creation makes a stopped Search campaign with its lead form attached, also stopped. Nobody can see the form and nothing can spend until somebody starts both in Google Ads.",
    },
    checkedAt: new Date(),
    /* Not for the wire: the orchestrator's inputs. */
    __resolution: resolution,
    __mapped: mapped,
    __deliveryBase: base,
  };
}

module.exports = { preflight, controlledAccounts, deliveryBase, deliveryUrlFor };
