// test/marketing/google-lead-form-definition.test.js
//
// THE LOCAL HALF OF GOOGLE LEAD FORMS.
//
// ── THE FAILURE MOST OF THIS FILE IS ABOUT ─────────────────────────────────
// A lead-form campaign can be created perfectly, pass every check Google makes
// at creation, run, spend its whole budget — and never show the form once.
// Google serves a lead form only on a campaign with conversion-focused bidding
// and a lead-form conversion goal. Get either wrong and everything reports
// success while nothing is collected.
//
// That is worse than a refusal, because a refusal is visible on the day. This
// one is visible when somebody eventually asks why there were no enquiries.
//
// ── AND THE SECOND ONE ─────────────────────────────────────────────────────
// Google's field enum contains JOB_ROLE, COMPANY_SIZE, ANNUAL_SALES and
// COMPANY_NAME. They look exactly like the firmographic targeting a B2B
// advertiser wants, and every one of them is typed by the person about
// themselves with nothing checking it. Treating an answer as a fact about
// somebody's employer is how a "verified procurement manager" turns out to be
// a student who picked an option.
"use strict";

const definition = require("../../services/marketing/deployment/googleLeadFormDefinition");
const G = require("../../constants/marketingGoogleLeadForm");
const caps = require("../../constants/marketingCampaignCapabilities");
const readiness = require("../../constants/marketingDeploymentReadiness");

/* A form that is correct in every respect, used as the base for each failure
   so exactly one thing differs at a time. */
const GOOD_FORM = Object.freeze({
  businessName: "GRAV Clothing",
  headline: "Request a uniform quote",
  description: "Tell us what your team needs and we will price it.",
  callToAction: "GET_QUOTE",
  callToActionDescription: "A written quote within two working days.",
  privacyPolicyUrl: "https://grav.in/privacy",
  fields: ["FULL_NAME", "EMAIL", "PHONE_NUMBER", "COMPANY_NAME"],
  qualifyingQuestions: ["JOB_ROLE", "COMPANY_SIZE"],
});

const GOOD_BRIEF = Object.freeze({
  /* GRAV's one conversion-focused strategy, and a code a stored plan can hold. */
  bidding: { strategy: "target_cost_per_action" },
  geoTargeting: [{ kind: "country", countryCode: "IN" }],
});

const GOOD_PLAN = Object.freeze({ conversionGoal: "form_submission" });
const GOOD_BINDING = Object.freeze({ externalAccountId: "1234567890" });

const evaluate = (over = {}) => definition.evaluate({
  form: { ...GOOD_FORM, ...(over.form || {}) },
  brief: { ...GOOD_BRIEF, ...(over.brief || {}) },
  plan: { ...GOOD_PLAN, ...(over.plan || {}) },
  binding: "binding" in over ? over.binding : GOOD_BINDING,
});

const check = (result, code) => result.checks.find((c) => c.code === code);
const blockedOn = (result) => result.blocking.map((b) => b.code);

/* ═══════════════════════════════════════════════════════════════════════════
   1. A GOOD FORM, AND THE SHAPE OF THE ANSWER
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a valid lead form", () => {
  test("1. a complete definition is locally ready, and says what is still Google's to decide", () => {
    const r = evaluate();

    expect(r.ready).toBe(true);
    expect(r.blocking).toEqual([]);

    /* ── A LOCAL PASS IS NOT A PROMISE ───────────────────────────────────
       GRAV cannot read an account's policy history or its vertical. Marking
       those locally confirmed would produce a confident pass followed by a
       provider refusal, and somebody plans around a confident pass. */
    expect(r.external.map((e) => e.code).sort())
      .toEqual(["account_vertical_eligible", "responsive_search_ads_only"]);
    for (const e of r.external) {
      expect(e.status).toBe("external");
      expect(e.verifiedBy).toBe("google_ads");
    }
    expect(r.locallyCheckedOnly).toBe(true);
    expect(r.means).toMatch(/Google makes its own decisions/i);
  });

  test("2. it is pure — the same input gives the same answer and nothing is mutated", () => {
    const form = { ...GOOD_FORM };
    const frozenCopy = JSON.stringify(form);

    const a = definition.evaluate({ form, brief: GOOD_BRIEF, plan: GOOD_PLAN, binding: GOOD_BINDING });
    const b = definition.evaluate({ form, brief: GOOD_BRIEF, plan: GOOD_PLAN, binding: GOOD_BINDING });

    expect(b).toEqual(a);
    expect(JSON.stringify(form)).toBe(frozenCopy);
  });

  test("3. every check carries a code, a status and a sentence a marketer can act on", () => {
    const r = evaluate();
    for (const c of r.checks) {
      expect(c.code).toBeTruthy();
      expect(["passed", "failed", "external", "not_applicable"]).toContain(c.status);
      expect(String(c.means).length).toBeGreaterThan(20);
      /* No Google resource names, no API vocabulary. */
      expect(c.means).not.toMatch(/customers\/|resource_name|LeadFormAsset|_enum|v1\d/i);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. WHAT GOOGLE REQUIRES
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Google's own requirements", () => {
  test("4. a missing privacy policy blocks, and a broken one does too", () => {
    const missing = evaluate({ form: { privacyPolicyUrl: "" } });
    expect(missing.ready).toBe(false);
    expect(blockedOn(missing)).toContain("privacy_policy_present");
    expect(check(missing, "privacy_policy_present").means).toMatch(/refuses a form without one/i);

    /* Not a link anybody can open is the same problem wearing a value. */
    for (const bad of ["grav.in/privacy", "http://", "we will add it", "/privacy"]) {
      const r = evaluate({ form: { privacyPolicyUrl: bad } });
      expect({ bad, ready: r.ready }).toEqual({ bad, ready: false });
    }
  });

  test("5. every piece of content Google marks Required is required here too", () => {
    for (const code of G.REQUIRED_FORM_CONTENT) {
      const r = evaluate({ form: { [code]: "" } });
      expect({ code, ready: r.ready }).toEqual({ code, ready: false });
      expect(check(r, "form_content_complete").missing).toContain(code);
    }
  });

  test("6. a field GRAV does not offer is refused by name", () => {
    const r = evaluate({ form: { fields: ["FULL_NAME", "EMAIL", "GOVERNMENT_ISSUED_ID_CPF_BR"] } });

    expect(r.ready).toBe(false);
    expect(blockedOn(r)).toContain("fields_supported");
    expect(check(r, "fields_supported").unsupported).toEqual(["GOVERNMENT_ISSUED_ID_CPF_BR"]);
    /* The refusal names what IS offered, so somebody can fix it. */
    expect(check(r, "fields_supported").offered).toEqual(G.CONTACT_FIELD_CODES);
  });

  test("7. Google's own field-exclusivity rule is enforced before Google has to", () => {
    /* Quoted from the enum: FIRST_NAME and LAST_NAME "can not be set at the
       same time as FULL_NAME". Caught while somebody is still editing, not by
       a failed creation attempt. */
    const r = evaluate({ form: { fields: ["FULL_NAME", "FIRST_NAME", "EMAIL"] } });

    expect(r.ready).toBe(false);
    expect(blockedOn(r)).toContain("fields_compatible");
    expect(check(r, "fields_compatible").means).toMatch(/full-name field alongside separate first and last/i);

    /* Either shape alone is fine. */
    expect(evaluate({ form: { fields: ["FULL_NAME", "EMAIL"] } }).ready).toBe(true);
    expect(evaluate({ form: { fields: ["FIRST_NAME", "LAST_NAME", "EMAIL"] } }).ready).toBe(true);
  });

  test("8. an unsupported qualifying question is refused, and six questions are too many", () => {
    const unsupported = evaluate({ form: { qualifyingQuestions: ["JOB_ROLE", "FAVORITE_COLOUR"] } });
    expect(blockedOn(unsupported)).toContain("questions_supported");
    expect(check(unsupported, "questions_supported").unsupported).toEqual(["FAVORITE_COLOUR"]);

    /* ── GOOGLE ALLOWS FIVE ──────────────────────────────────────────────── */
    const six = evaluate({
      form: {
        qualifyingQuestions: ["JOB_ROLE", "COMPANY_SIZE", "ANNUAL_SALES",
          "JOB_INDUSTRY", "CATEGORY", "OFFER"],
      },
    });
    expect(six.ready).toBe(false);
    expect(blockedOn(six)).toContain("questions_within_limit");
    expect(check(six, "questions_within_limit")).toMatchObject({ asked: 6, allowed: 5 });

    /* Exactly five is fine. */
    expect(evaluate({
      form: {
        qualifyingQuestions: ["JOB_ROLE", "COMPANY_SIZE", "ANNUAL_SALES",
          "JOB_INDUSTRY", "CATEGORY"],
      },
    }).ready).toBe(true);

    /* And the same question twice is a form asking it twice. */
    const dup = evaluate({ form: { qualifyingQuestions: ["JOB_ROLE", "JOB_ROLE"] } });
    expect(blockedOn(dup)).toContain("questions_distinct");
  });

  test("9. no custom questions are offered, and the reason is recorded rather than omitted", () => {
    /* Google supports `custom_question_fields`, and using them switches off
       every pre-defined qualifying question on the same form. GRAV declines
       that trade on purpose — a free-text answer is one nothing can group,
       compare or qualify against. */
    expect(G.QUESTION_LIMITS.customQuestionsOffered).toBe(false);
    expect(G.QUESTION_LIMITS.customQuestionsWhy).toMatch(/turns off every pre-defined/i);

    const r = evaluate({ form: { qualifyingQuestions: ["ANYTHING_I_LIKE"] } });
    expect(r.ready).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. THE RULES THAT DECIDE WHETHER IT SERVES AT ALL
   ═══════════════════════════════════════════════════════════════════════════ */

describe("whether the form would ever appear", () => {
  test("10. click-maximising bidding blocks, because the form would never serve", () => {
    /* ── THE EXPENSIVE FAILURE ───────────────────────────────────────────
       GRAV's default strategy is `maximise_clicks`. A lead-form campaign
       using it is created successfully, runs, spends, and shows no form. */
    const r = evaluate({ brief: { bidding: { strategy: "maximise_clicks" } } });

    expect(r.ready).toBe(false);
    expect(blockedOn(r)).toContain("conversion_bidding");
    expect(check(r, "conversion_bidding").means).toMatch(/run, spend, and collect nothing/i);
    expect(check(r, "conversion_bidding").needsOneOf).toEqual(["target_cost_per_action"]);

    /* Only GRAV's own vocabulary counts. The names an earlier version listed
       (`maximise_conversions`, `target_cpa`, …) are not strategies a plan can
       store, so accepting them only let a test pass that no plan ever could. */
    expect(evaluate({ brief: { bidding: { strategy: "target_cost_per_action" } } }).ready).toBe(true);
    for (const strategy of ["maximise_clicks", "target_cost_per_click", "maximise_conversions", "target_cpa"]) {
      expect({ strategy, ready: evaluate({ brief: { bidding: { strategy } } }).ready })
        .toEqual({ strategy, ready: false });
    }
  });

  test("11. a campaign judged by something a form cannot produce blocks", () => {
    const r = evaluate({ plan: { conversionGoal: "page_view" } });

    expect(r.ready).toBe(false);
    expect(blockedOn(r)).toContain("lead_form_conversion_goal");
    expect(check(r, "lead_form_conversion_goal").means).toMatch(/would never appear/i);

    for (const goal of ["form_submission", "qualified_prospect"]) {
      expect({ goal, ready: evaluate({ plan: { conversionGoal: goal } }).ready })
        .toEqual({ goal, ready: true });
    }
    /* Nothing connects a campaign to an accepted handover yet, so a form
       optimised for one would optimise for a number that does not exist — the
       same rule readiness applies to every campaign type. */
    expect(evaluate({ plan: { conversionGoal: "sales_handover" } }).ready).toBe(false);
  });

  test("12. targeting only countries where lead forms do not serve blocks", () => {
    /* Google publishes a list of countries where lead forms do not appear. A
       campaign aimed only at those runs and collects nothing. */
    const r = evaluate({
      brief: { geoTargeting: [{ kind: "country", countryCode: "AE" }, { kind: "country", countryCode: "SA" }] },
    });
    expect(r.ready).toBe(false);
    expect(blockedOn(r)).toContain("serving_country");
    expect(check(r, "serving_country").nonServing.sort()).toEqual(["AE", "SA"]);

    /* A mix is allowed, and says which will not show. */
    const mixed = evaluate({
      brief: { geoTargeting: [{ kind: "country", countryCode: "IN" }, { kind: "country", countryCode: "AE" }] },
    });
    expect(mixed.ready).toBe(true);
    expect(check(mixed, "serving_country").nonServing).toEqual(["AE"]);

    /* Unknown targeting is unknown, not a pass and not a failure. */
    const none = evaluate({ brief: { geoTargeting: [] } });
    expect(check(none, "serving_country").status).toBe("not_applicable");
  });

  test("13. a form nobody could reply to blocks, even though Google would accept it", () => {
    /* Google will happily take a form collecting only a city. An enquiry with
       no way to reach the person is one nobody can act on, and replying is the
       entire point of this campaign type. */
    const r = evaluate({ form: { fields: ["FULL_NAME", "CITY"] } });

    expect(r.ready).toBe(false);
    expect(blockedOn(r)).toContain("reachable");
    expect(check(r, "reachable").means).toMatch(/nobody could reply/i);

    expect(evaluate({ form: { fields: ["EMAIL"] } }).ready).toBe(true);
    expect(evaluate({ form: { fields: ["PHONE_NUMBER"] } }).ready).toBe(true);
  });

  test("14. no advertising account bound means nowhere to create it", () => {
    const r = evaluate({ binding: null });
    expect(r.ready).toBe(false);
    expect(blockedOn(r)).toContain("account_bound");
    expect(check(r, "account_bound").means).toMatch(/nowhere to create/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. CONSENT
   ═══════════════════════════════════════════════════════════════════════════ */

describe("consent", () => {
  test("15. a form that asks for nothing records no permission, and that is not an error", () => {
    const r = evaluate();
    const c = check(r, "consent_notice");

    /* ── SUBMITTING DETAILS IS NOT PERMISSION ────────────────────────────
       Somebody asking for a quote has asked for a quote. Treating that as
       agreement to be marketed to is the inference this whole boundary
       exists to refuse. */
    expect(c.status).toBe("not_applicable");
    expect(c.means).toMatch(/does not ask for marketing permission/i);
    expect(r.ready).toBe(true);
  });

  test("16. asking for permission without recording the wording blocks", () => {
    const noText = evaluate({ form: { marketingConsent: { requested: true, noticeVersion: "v2" } } });
    expect(noText.ready).toBe(false);
    expect(blockedOn(noText)).toContain("consent_notice");
    expect(check(noText, "consent_notice").means).toMatch(/cannot be evidenced later/i);

    const noVersion = evaluate({ form: { marketingConsent: { requested: true, noticeText: "Email me offers." } } });
    expect(noVersion.ready).toBe(false);

    /* Both present is accepted. */
    const good = evaluate({
      form: { marketingConsent: { requested: true, noticeText: "Email me about offers.", noticeVersion: "v2" } },
    });
    expect(good.ready).toBe(true);
    expect(check(good, "consent_notice").status).toBe("passed");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. WHAT THE ANSWERS ARE, AND ARE NOT
   ═══════════════════════════════════════════════════════════════════════════ */

describe("self-reported answers", () => {
  test("17. no qualifying answer is ever describable as verified", () => {
    expect(G.ANSWER_PROVENANCE.verified).toBe(false);
    expect(G.ANSWER_PROVENANCE.label).toBe("Answered by the person");
    expect(G.ANSWER_PROVENANCE.means).toMatch(/does not check any of it/i);

    /* ── THE SIX THAT LOOK LIKE FIRMOGRAPHICS AND ARE NOT ────────────────
       Every one is typed or picked by the person about themselves. A
       "verified procurement manager" built from one of these is a student who
       chose an option from a list. */
    for (const code of ["JOB_ROLE", "JOB_INDUSTRY", "COMPANY_SIZE", "ANNUAL_SALES",
      "COMPANY_NAME", "JOB_TITLE"]) {
      expect(G.ANSWER_PROVENANCE.neverTreatAsVerified).toContain(code);
    }
  });

  test("18. every question carries the exact wording Google shows", () => {
    /* An answer read without its question is a word with no meaning — "51-200"
       means nothing unless the reader knows it answered "What size is your
       company?". */
    for (const q of G.QUALIFYING_QUESTIONS) {
      expect(q.question).toMatch(/\?$/);
      expect(q.category).toBeTruthy();
    }
    expect(G.QUALIFYING_QUESTIONS.find((q) => q.code === "COMPANY_SIZE").question)
      .toBe("What size is your company?");
    expect(G.QUALIFYING_QUESTIONS.find((q) => q.code === "JOB_ROLE").question)
      .toBe("What is your job role?");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. THE DELIVERY CONTRACT, AND THE BOUNDARY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("delivery, retrieval and deployability", () => {
  test("19. verification is the shared secret Google documents, and no invented signature", () => {
    /* ── CHECKING FOR SOMETHING GOOGLE NEVER SENDS REFUSES EVERY REAL LEAD ──
       Google's `google_secret` is "an anti-spoofing secret set by the
       advertiser as part of the webhook payload" — inside the body. There is
       no HMAC and no signature header in the documented contract. */
    expect(G.DELIVERY.verification).toBe("shared_secret_in_payload");
    expect(G.DELIVERY.signatureAvailable).toBe(false);
    expect(G.DELIVERY.signatureWhy).toMatch(/refuse every genuine lead/i);

    /* Google allows exactly one webhook per form. */
    expect(G.DELIVERY.onlyOneWebhook).toBe(true);
  });

  test("20. the recovery promise ends exactly where Google's retention does", () => {
    expect(G.RETENTION.RETRIEVAL_SUPPORTED).toBe(true);
    expect(G.RETENTION.PROVIDER_RETENTION_DAYS).toBe(60);
    expect(G.RETENTION.RETRIEVAL_WINDOW_DAYS).toBe(60);
    expect(G.RETENTION.retrievalResource).toBe("lead_form_submission_data");

    /* Both sortable and filterable on Google's resource, which is what makes a
       resumable, idempotent sweep possible rather than aspirational. */
    expect(G.RETENTION.cursorFields).toEqual(["id", "submission_date_time"]);
    expect(G.RETENTION.retrievalMeans).toMatch(/after which Google no longer holds it/i);
  });

  test("21. the campaign type stays unavailable while ingestion is unproven", () => {
    /* ── THE GATE ────────────────────────────────────────────────────────
       The local contract is complete and tested. Ingestion is not, and a
       lead-form campaign GRAV cannot receive leads from is one that runs,
       spends, collects enquiries and delivers them nowhere. */
    const d = definition.deployability();
    expect(d.deployable).toBe(false);
    expect(d.blockers.map((b) => b.code)).toContain("lead_ingestion_unproven");
    expect(d.blockers[0].means).toMatch(/reach nobody/i);

    const type = caps.CAMPAIGN_TYPE_BY_CODE.google_lead_form;
    expect(type.deployable).toBe(false);
    expect(caps.DEPLOYABLE_CAMPAIGN_TYPES).not.toContain("google_lead_form");

    /* The local half IS done, and the record says so rather than implying
       nothing exists. */
    expect(type.localContract.complete).toBe(true);
    /* Creation now exists — into the proof account only — so what blocks is
       the proof, named precisely. */
    expect(type.blockedBy).toMatch(/not yet been proven on a real account/i);
    expect(d.blockers.map((b) => b.code)).toEqual(
      ["lead_ingestion_unproven", "controlled_creation_unproven", "real_lead_delivery_unproven"],
    );
    expect(type.needs.length).toBeGreaterThan(0);
  });

  test("22. the matrix and the creation contract still agree", () => {
    /* A declaration that drifts from the contract that actually creates
       campaigns is resolved in whichever direction somebody notices last. */
    expect([...caps.DEPLOYABLE_CAMPAIGN_TYPES].sort())
      .toEqual([...readiness.SUPPORTED_CAMPAIGN_TYPE_CODES].sort());
    expect(readiness.SUPPORTED_CAMPAIGN_TYPE_CODES).not.toContain("google_lead_form");
  });

  test("23. deployability is derived from the verified contract, not hand-set", () => {
    /* ── A BOOLEAN SOMEBODY CAN FLIP IS A BOOLEAN SOMEBODY WILL FLIP ─────
       The matrix computes this from the same unverified-schema flag the
       validator reads, so the two cannot disagree. */
    expect(G.UNVERIFIED.webhookPayloadSchema.verified).toBe(false);
    expect(G.UNVERIFIED.webhookPayloadSchema.blocks).toContain("lead_ingestion");
    expect(caps.CAMPAIGN_TYPE_BY_CODE.google_lead_form.deployable)
      .toBe(G.UNVERIFIED.webhookPayloadSchema.verified === true);
  });

  test("24. the existing website-destination Search type is untouched", () => {
    /* This work added a campaign type. It did not alter the one that already
       worked, and the column that describes it is the same shape it was. */
    const search = caps.CAMPAIGN_TYPE_BY_CODE.google_search;
    expect(search.deployable).toBe(true);
    expect(search.channel).toBe("google_ads");
    expect(caps.capabilityFor("google_search", "native_lead_form").support).toBe("unavailable");
    expect(caps.capabilityFor("google_search", "destination_url").support).toBe("required");
    expect(caps.capabilityFor("google_search", "keyword_themes").support).toBe("required");
  });
});
