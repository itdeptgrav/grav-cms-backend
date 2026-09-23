// services/marketing/deployment/googleLeadFormDefinition.js
//
// IS THIS LEAD FORM ONE GOOGLE WOULD ACCEPT, AND ONE GRAV COULD USE?
//
// ── PURE. NO I/O, NO CLOCK, NO PROVIDER ────────────────────────────────────
// The same function answers the readiness route, the submission gate and the
// approval gate, so those three can never disagree about whether a form is
// ready. Everything it needs arrives as arguments.
//
// ── TWO KINDS OF PROBLEM, AND THEY ARE NOT MIXED ───────────────────────────
// A LOCAL problem is one GRAV can see from the plan: a missing privacy policy,
// six qualifying questions where Google allows five, a full-name field beside a
// first-name field. Those block, and they block here rather than by Google
// refusing a creation attempt.
//
// An EXTERNAL check is one only the advertising account can answer: whether the
// vertical is eligible, whether the account's policy history is good. Those are
// reported as external and are never marked locally confirmed — a confident
// local pass followed by a provider refusal is worse than an honest unknown,
// because somebody plans around it.
//
// ── THE FAILURE THIS FILE IS MOSTLY ABOUT ──────────────────────────────────
// Google's eligibility rules mean a lead-form campaign can be created
// perfectly, run, spend, and never show the form at all: click-maximising
// bidding, or no lead-form conversion goal, and it serves nothing. That is the
// worst shape of failure available, because every screen says it worked. Three
// of the checks below exist only to catch it before the money does.
"use strict";

const G = require("../../../constants/marketingGoogleLeadForm");
const { GOAL_COMPATIBILITY } = require("../../../constants/marketingDeploymentReadiness");

/* ── GRAV'S OWN WORDS FOR "BIDS TOWARDS CONVERSIONS" ─────────────────────────
   An earlier version listed `maximise_conversions`, `target_cpa`,
   `maximise_conversion_value` and `target_roas` — none of which is a strategy a
   GRAV plan can store (the plan accepts only its own BIDDING_STRATEGIES). So no
   real plan could ever pass. `target_cost_per_action` is GRAV's one
   conversion-focused strategy, and it maps to Google's TargetCpa. */
const CONVERSION_FOCUSED = Object.freeze(["target_cost_per_action"]);
/* The goals a lead form can honestly pursue: the same table readiness uses. */
const LEAD_FORM_GOALS = GOAL_COMPATIBILITY.google_lead_form;

const str = (v) => String(v ?? "").trim();
const list = (v) => (Array.isArray(v) ? v : []);

/* GRAV's own result vocabulary, matching the readiness contract's shape: a
   check either passed, failed, could not be checked here, or does not apply. */
const result = (code, status, means, extra = {}) =>
  ({ code, status, means, ...extra });

const PASSED = "passed";
const FAILED = "failed";
const EXTERNAL = "external";
const NOT_APPLICABLE = "not_applicable";

/**
 * Evaluate a lead-form definition against Google's documented contract.
 *
 * @param {object} args
 * @param {object} args.form       the lead-form definition from the plan
 * @param {object} args.brief      the deployment brief (targeting, bidding)
 * @param {object} args.plan       the campaign plan (conversion goal)
 * @param {object} [args.binding]  the advertising account binding, if any
 * @param {"plan"|"deployment"} [args.scope]  "plan" judges only what the plan
 *   itself holds — readiness, submission, approval — and leaves the account
 *   question to preflight, where the bound account is actually known.
 * @returns {{ready: boolean, checks: object[], blocking: object[], external: object[]}}
 */
function evaluate({ form, brief, plan, binding, scope = "deployment" } = {}) {
  const checks = [];
  const f = form && typeof form === "object" ? form : {};

  /* ── 1. THE CONTENT GOOGLE REQUIRES ──────────────────────────────────── */
  const missingContent = G.REQUIRED_FORM_CONTENT.filter((code) => !str(f[code]));
  checks.push(missingContent.length
    ? result("form_content_complete", FAILED,
      `Google requires every one of these on a lead form: ${missingContent
        .map((c) => G.FORM_CONTENT.find((x) => x.code === c).label.toLowerCase()).join(", ")}.`,
      { missing: missingContent })
    : result("form_content_complete", PASSED, "The form has everything Google requires on it."));

  /* ── 1b. GOOGLE'S OWN BUTTON WORDS ───────────────────────────────────────
     The call to action is an enum on Google's side, not free text. A value
     outside it is refused here, while somebody is still editing, rather than by
     Google at creation. */
  const cta = str(f.callToAction);
  const postCta = str(f.postSubmitCallToAction);
  const badCta = [
    cta && !G.CALL_TO_ACTION_TYPES.includes(cta) ? "callToAction" : null,
    postCta && !G.POST_SUBMIT_CALL_TO_ACTION_TYPES.includes(postCta) ? "postSubmitCallToAction" : null,
  ].filter(Boolean);
  checks.push(badCta.length
    ? result("call_to_action_supported", FAILED,
      "That is not one of the button labels Google offers on a lead form.",
      { fields: badCta, offered: G.CALL_TO_ACTION_TYPES, offeredAfterSubmit: G.POST_SUBMIT_CALL_TO_ACTION_TYPES })
    : result("call_to_action_supported", PASSED, "The button labels are ones Google offers."));

  /* ── 2. THE PRIVACY POLICY, SEPARATELY ───────────────────────────────────
     It is one of the required fields above and it gets its own check, because
     it is the one a marketer is most likely to leave until later and the one
     Google refuses a form outright for. A named check can be pointed at. */
  const privacy = str(f.privacyPolicyUrl);
  checks.push(!privacy
    ? result("privacy_policy_present", FAILED,
      "A lead form must link to a privacy policy. Google refuses a form without one.")
    : !/^https:\/\/[^\s]+\.[^\s]+/i.test(privacy)
      ? result("privacy_policy_present", FAILED,
        "That is not a usable privacy-policy address. It must be a full https link to a page anybody can open.")
      : result("privacy_policy_present", PASSED, "The form links to a privacy policy."));

  /* ── 3. FIELDS GRAV ACTUALLY OFFERS ──────────────────────────────────── */
  const fields = list(f.fields).map(str).filter(Boolean);
  const unknownFields = fields.filter((c) => !G.CONTACT_FIELD_CODES.includes(c));
  checks.push(unknownFields.length
    ? result("fields_supported", FAILED,
      `GRAV does not offer ${unknownFields.join(", ")} on a lead form.`,
      { unsupported: unknownFields, offered: G.CONTACT_FIELD_CODES })
    : result("fields_supported", PASSED, "Every requested detail is one GRAV offers."));

  /* ── 4. GOOGLE'S OWN EXCLUSIVITY RULE ────────────────────────────────────
     Refused here rather than by Google at creation, so somebody finds out
     while they are still editing the form. */
  const conflicts = G.FIELD_EXCLUSIONS
    .filter((rule) => rule.group.some((g) => fields.includes(g))
      && rule.excludes.some((e) => fields.includes(e)))
    .map((rule) => rule.why);
  checks.push(conflicts.length
    ? result("fields_compatible", FAILED, conflicts[0], { conflicts })
    : result("fields_compatible", PASSED, "The requested details can appear on one form together."));

  /* ── 5. SOMETHING GRAV CAN REPLY TO ──────────────────────────────────────
     Not a Google rule — a GRAV one, and worth stating as such. Google will
     happily accept a form collecting only a city. An enquiry with no way to
     reach the person is an enquiry nobody can act on, and the whole point of
     this campaign type is that somebody gets back to them. */
  const contactable = fields.filter((c) => G.CONTACTABLE_FIELDS.includes(c));
  checks.push(contactable.length
    ? result("reachable", PASSED, "The form asks for a way to contact the person.")
    : result("reachable", FAILED,
      "The form does not ask for an email address or a phone number, so nobody could reply to an enquiry from it."));

  /* ── 6. QUALIFYING QUESTIONS, WITHIN GOOGLE'S LIMITS ─────────────────── */
  const questions = list(f.qualifyingQuestions).map(str).filter(Boolean);
  const unknownQuestions = questions.filter((c) => !G.QUALIFYING_QUESTION_CODES.includes(c));
  checks.push(unknownQuestions.length
    ? result("questions_supported", FAILED,
      `GRAV does not offer ${unknownQuestions.join(", ")} as a qualifying question.`,
      { unsupported: unknownQuestions, offered: G.QUALIFYING_QUESTION_CODES })
    : result("questions_supported", PASSED, "Every qualifying question is one Google publishes."));

  checks.push(questions.length > G.QUESTION_LIMITS.MAX_QUALIFYING_QUESTIONS
    ? result("questions_within_limit", FAILED,
      `Google allows ${G.QUESTION_LIMITS.MAX_QUALIFYING_QUESTIONS} qualifying questions on a form. This one asks ${questions.length}.`,
      { asked: questions.length, allowed: G.QUESTION_LIMITS.MAX_QUALIFYING_QUESTIONS })
    : result("questions_within_limit", PASSED,
      `Within Google's limit of ${G.QUESTION_LIMITS.MAX_QUALIFYING_QUESTIONS} qualifying questions.`));

  /* Duplicates would pass every check above and produce a form asking the same
     thing twice. */
  const duplicated = questions.filter((q, i) => questions.indexOf(q) !== i);
  checks.push(duplicated.length
    ? result("questions_distinct", FAILED,
      "The same qualifying question is asked more than once.", { duplicated: [...new Set(duplicated)] })
    : result("questions_distinct", PASSED, "No question is asked twice."));

  /* ── 7. CONSENT ──────────────────────────────────────────────────────────
     A lead form collects contact details. That is not permission to market to
     somebody, and the two are separate on purpose: if the form ASKS for
     marketing permission, the notice it showed has to be recorded, because
     consent whose wording nobody kept is consent nobody can evidence later. */
  const asksConsent = f.marketingConsent?.requested === true;
  const noticeText = str(f.marketingConsent?.noticeText);
  const noticeVersion = str(f.marketingConsent?.noticeVersion);

  if (!asksConsent) {
    checks.push(result("consent_notice", NOT_APPLICABLE,
      "This form does not ask for marketing permission, so none will be recorded from it. The enquiry is still a person GRAV may reply to about what they asked for."));
  } else if (!noticeText || !noticeVersion) {
    checks.push(result("consent_notice", FAILED,
      "This form asks for marketing permission but does not record the exact wording shown and its version. Permission whose wording nobody kept cannot be evidenced later, so GRAV will not collect it this way.",
      { missing: [!noticeText && "noticeText", !noticeVersion && "noticeVersion"].filter(Boolean) }));
  } else {
    checks.push(result("consent_notice", PASSED,
      "The form asks for marketing permission and records the exact wording and version shown."));
  }

  /* ── 8. THE THREE RULES THAT DECIDE WHETHER IT SERVES AT ALL ──────────── */
  const goal = str(plan?.conversionGoal);
  checks.push(LEAD_FORM_GOALS.includes(goal)
    ? result("lead_form_conversion_goal", PASSED,
      "The campaign is judged by an outcome a lead form produces.")
    : result("lead_form_conversion_goal", FAILED,
      "Google only serves a lead form on a campaign optimised towards a lead-form conversion goal. This campaign is judged by something else, so the form would never appear.",
      { goal: goal || null, needsOneOf: LEAD_FORM_GOALS }));

  const strategy = str(brief?.bidding?.strategy);
  checks.push(CONVERSION_FOCUSED.includes(strategy)
    ? result("conversion_bidding", PASSED, "The campaign bids towards conversions, which is what a lead form needs.")
    : result("conversion_bidding", FAILED,
      "Google only serves a lead form on a campaign using conversion-focused bidding. This campaign bids for clicks, so the form would never appear — the campaign would run, spend, and collect nothing.",
      { strategy: strategy || null, needsOneOf: CONVERSION_FOCUSED }));

  /* ── 9. A COUNTRY WHERE IT WOULD ACTUALLY SHOW ───────────────────────────
     Google does not serve lead forms everywhere. A campaign targeting only
     countries on that list is created successfully and collects nothing. */
  const targetCountries = list(brief?.geoTargeting)
    .filter((t) => str(t.kind) === "country")
    .map((t) => str(t.countryCode || t.code || "").toUpperCase())
    .filter(Boolean);

  if (!targetCountries.length) {
    checks.push(result("serving_country", NOT_APPLICABLE,
      "GRAV cannot tell which countries this campaign targets, so it cannot check whether lead forms serve there."));
  } else {
    const nonServing = targetCountries.filter((c) => G.NON_SERVING_COUNTRIES.includes(c));
    checks.push(nonServing.length === targetCountries.length
      ? result("serving_country", FAILED,
        "Google does not show lead forms in any of the countries this campaign targets, so it would run and collect nothing.",
        { nonServing })
      : nonServing.length
        ? result("serving_country", PASSED,
          "Lead forms serve in some of the countries targeted. They will not appear in the rest.",
          { nonServing })
        : result("serving_country", PASSED, "Lead forms serve in the countries this campaign targets."));
  }

  /* ── 10. AN ADVERTISING ACCOUNT TO CREATE IT IN ────────────────────────
     A deployment question. Judging a plan, the account is not yet known —
     preflight answers this against the bound account. */
  if (scope !== "plan") checks.push(binding && str(binding.externalAccountId)
    ? result("account_bound", PASSED, "A Google advertising account is chosen for this company.")
    : result("account_bound", FAILED,
      "No Google advertising account is chosen for this company, so there is nowhere to create this campaign."));

  /* ── 11. WHAT ONLY GOOGLE CAN ANSWER ─────────────────────────────────────
     Reported as external, never as locally confirmed. GRAV cannot read an
     account's policy history or its vertical, and guessing would produce a
     confident pass followed by a provider refusal. */
  checks.push(result("account_vertical_eligible", EXTERNAL,
    "Google requires a good policy history and an eligible kind of business for lead forms. GRAV cannot check either from a plan; Google decides when the form is created.",
    { verifiedBy: "google_ads" }));

  checks.push(result("responsive_search_ads_only", EXTERNAL,
    "Google serves lead forms on responsive search advertisements only. GRAV creates that kind, and Google confirms it when the advertisement is created.",
    { verifiedBy: "google_ads" }));

  const blocking = checks.filter((c) => c.status === FAILED);
  const external = checks.filter((c) => c.status === EXTERNAL);

  return {
    ready: blocking.length === 0,
    checks,
    blocking,
    external,
    /* Stated on every result: a local pass is not a promise Google will accept
       it, and nothing here has contacted anybody. */
    means: blocking.length === 0
      ? "Everything GRAV can check about this form is in order. Google makes its own decisions when the campaign is created."
      : "This form cannot be created yet. Each problem below is one GRAV can see without asking Google.",
    locallyCheckedOnly: true,
  };
}

/* ── WHY THIS CAMPAIGN TYPE IS NOT DEPLOYABLE YET ───────────────────────────
   The local contract above is complete and tested. Ingestion is not: Google's
   webhook payload schema has not been read, so nothing can safely receive a
   submitted lead.

   Creating a lead-form campaign that GRAV cannot receive leads from would be
   the exact failure this whole design exists to prevent — a campaign that runs,
   collects enquiries, and delivers them nowhere. So the capability matrix keeps
   publishing `google_lead_form` as unavailable until ingestion is proven too,
   and this function is what the matrix consults rather than a hand-maintained
   boolean somebody could flip by mistake. */
function deployability() {
  /* Every unverified item is a blocker, and each names the event that would
     clear it. The webhook blocker keeps its original code. */
  const CODE_FOR = {
    webhookPayloadSchema: "lead_ingestion_unproven",
    controlledAccountCreation: "controlled_creation_unproven",
    realLeadDelivery: "real_lead_delivery_unproven",
  };
  const MEANS_FOR = {
    webhookPayloadSchema: "GRAV cannot yet receive a submitted lead with confidence, because the shape of what Google sends has not been confirmed by a real delivery. Creating this campaign generally would collect enquiries that could reach nobody.",
    controlledAccountCreation: "No lead-form campaign has yet been created in the proof account and read back as stopped with its form attached.",
    realLeadDelivery: "No real enquiry from a GRAV-created lead form has yet reached GRAV.",
  };
  const blockers = Object.entries(G.UNVERIFIED)
    .filter(([, u]) => u.verified !== true)
    .map(([key, u]) => ({ code: CODE_FOR[key] || key, means: MEANS_FOR[key] || u.why, why: u.why }));
  /* The webhook blocker first, as it always was. */
  blockers.sort((a, b) => (a.code === "lead_ingestion_unproven" ? -1 : b.code === "lead_ingestion_unproven" ? 1 : 0));
  return { deployable: blockers.length === 0, blockers };
}

module.exports = {
  evaluate,
  deployability,
  STATUSES: { PASSED, FAILED, EXTERNAL, NOT_APPLICABLE },
};
