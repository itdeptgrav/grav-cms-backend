// test/marketing/google-lead-ingestion.test.js
//
// RECEIVING A LEAD FROM GOOGLE.
//
// ── THE PAYLOADS BELOW ARE GOOGLE'S OWN ────────────────────────────────────
// Copied from developers.google.com/google-ads/webhook/docs/samples, with one
// change noted where it is made. Testing against a payload somebody invented
// proves the code agrees with whoever invented it.
//
// ── THE THREE FAILURES THIS FILE IS ABOUT ──────────────────────────────────
//
//   A test lead treated as a real one. Google sends them on demand, from a
//   button in the advertising interface. If one becomes a person, an
//   engagement and a prospect, somebody in Sales eventually rings "John Doe"
//   on +11234567890.
//
//   A replayed body accepted twice. Google's verification is a shared secret
//   inside the payload, not a signature — anybody who has seen one delivery
//   holds a token that opens the door again, and delivery is explicitly
//   at-least-once. Deduplication is the security control here, not a tidiness
//   one.
//
//   A field identified by its label. `column_name` is deprecated and "might
//   not always be populated". A mapping built on it passes every test written
//   against the samples, which all carry one, and starts silently dropping
//   fields in production.
"use strict";

const normalisation = require("../../services/marketing/leads/googleLeadNormalisation");
const verification = require("../../services/marketing/leads/googleLeadVerification");
const W = require("../../constants/marketingGoogleLeadWebhook");

const SECRET = "xfdgdgsgfchgvhgfchg";

/* ── GOOGLE'S OFFICIAL PRODUCTION SAMPLE ────────────────────────────────────
   Verbatim, except the trailing comma after `google_key` — the published
   sample has one, which is not valid JSON and which no parser would accept. */
const OFFICIAL_PRODUCTION = Object.freeze({
  lead_id: "Cj0KCQjwit_8BRCoARIsAIx3Rj7g-AeL6z35IWb6VYiZUygtTfwD3hDlgSGmY-XTTlK3lfV1wcuIwIAaAmMxEALw_wcB",
  campaign_id: 123456,
  gcl_id: "Cj0KCQjwit_8BRCoARIsAIx3Rj7g-AeL6z35IWb6VYiZUygtTfwD3hDlgSGmY-XTTlK3lfV1wcuIwIAaAmMxEALw_wcB",
  user_column_data: [
    { column_name: "Full Name", string_value: "John Doe", column_id: "FULL_NAME" },
    { column_name: "User Phone", string_value: "+11234567890", column_id: "PHONE_NUMBER" },
  ],
  api_version: "1.0",
  form_id: 1234,
  google_key: SECRET,
});

/* ── GOOGLE'S OFFICIAL TEST SAMPLE ──────────────────────────────────────────
   Verbatim — including `Google_key` with a capital G, which is how every test
   sample on that page spells it while the production one spells it lowercase.
   Almost certainly a documentation typo, and reproduced exactly because a
   verifier that refused it would refuse the official sample. */
const OFFICIAL_TEST = Object.freeze({
  lead_id: "Cj0KCQjwit_8BRCoARIsAIx3Rj7g-AeL6z35IWb6VYiZUygtTfwD3hDlgSGmY-XTTlK3lfV1wcuIwIAaAmMxEALw_wcB",
  campaign_id: 123456,
  gcl_id: "Cj0KCQjwit_8BRCoARIsAIx3Rj7g-AeL6z35IWb6VYiZUygtTfwD3hDlgSGmY-XTTlK3lfV1wcuIwIAaAmMxEALw_wcB",
  user_column_data: [
    { column_name: "Full Name", string_value: "John Doe", column_id: "FULL_NAME" },
    { column_name: "User Phone", string_value: "+11234567890", column_id: "PHONE_NUMBER" },
  ],
  api_version: "1.0",
  form_id: 1234,
  Google_key: SECRET,
  is_test: true,
});

const webhook = (payload) => normalisation.normalise({ via: "webhook", payload });

/* ═══════════════════════════════════════════════════════════════════════════
   1. GOOGLE'S OWN SAMPLES
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the official samples", () => {
  test("1. the production sample normalises, and is production", () => {
    const r = webhook(OFFICIAL_PRODUCTION);

    expect(r.ok).toBe(true);
    expect(r.lead.providerLeadId).toBe(OFFICIAL_PRODUCTION.lead_id);
    expect(r.lead.isTest).toBe(false);
    expect(r.lead.contact).toEqual({ fullName: "John Doe", phone: "+11234567890" });
    expect(r.lead.channel).toBe("google_ads");
    expect(r.lead.receivedVia).toBe("delivery");
    expect(r.lead.clickId).toBe(OFFICIAL_PRODUCTION.gcl_id);
  });

  test("2. the test sample is recognised as a test, including its capitalised key", () => {
    /* ── SOMEBODY IN SALES RINGS JOHN DOE ────────────────────────────────
       Google sends these from a button in the advertising interface. A test
       lead that becomes a person, an engagement and a prospect ends with
       somebody phoning +11234567890. */
    const r = webhook(OFFICIAL_TEST);

    expect(r.ok).toBe(true);
    expect(r.lead.isTest).toBe(true);

    /* And it still verifies — the capital-G spelling is Google's own. */
    expect(verification.verify({ payload: OFFICIAL_TEST, expected: SECRET }).verified).toBe(true);
    expect(verification.suppliedSecret(OFFICIAL_TEST)).toBe(SECRET);
  });

  test("3. a missing is_test flag means production, as Google states", () => {
    /* "If value is false or if field is not present, treat this lead as valid
       production lead." Nothing but an explicit true may make it a test —
       otherwise a malformed delivery would quietly discard a real enquiry. */
    expect(webhook({ ...OFFICIAL_PRODUCTION }).lead.isTest).toBe(false);
    expect(webhook({ ...OFFICIAL_PRODUCTION, is_test: false }).lead.isTest).toBe(false);
    expect(webhook({ ...OFFICIAL_PRODUCTION, is_test: "false" }).lead.isTest).toBe(false);
    expect(webhook({ ...OFFICIAL_PRODUCTION, is_test: null }).lead.isTest).toBe(false);

    expect(webhook({ ...OFFICIAL_PRODUCTION, is_test: true }).lead.isTest).toBe(true);
    expect(webhook({ ...OFFICIAL_PRODUCTION, is_test: "true" }).lead.isTest).toBe(true);
  });

  test("4. an unknown future property is ignored rather than refused", () => {
    /* Google's own instruction: "Don't write code that expects a fixed set of
       fields or that would fail if new, unexpected fields are present." */
    const future = {
      ...OFFICIAL_PRODUCTION,
      lead_quality_score: 0.87,
      consent_signals: { ad_user_data: "GRANTED" },
      some_future_object: { nested: { deeply: true } },
    };

    const r = webhook(future);
    expect(r.ok).toBe(true);
    expect(r.lead.contact).toEqual({ fullName: "John Doe", phone: "+11234567890" });
    /* Ignored, not stored — GRAV keeps what it understands. */
    expect(JSON.stringify(r.lead)).not.toMatch(/lead_quality_score|consent_signals|some_future_object/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. COLUMN MAPPING
   ═══════════════════════════════════════════════════════════════════════════ */

describe("column mapping", () => {
  test("5. identity is column_id — the deprecated label is never consulted", () => {
    /* ── THE TEST THAT MATTERS MOST HERE ─────────────────────────────────
       A label that lies, and a column with no label at all. A mapping built
       on `column_name` gets both wrong, and gets them wrong only in
       production, because every sample on Google's page carries a label. */
    const r = webhook({
      ...OFFICIAL_PRODUCTION,
      user_column_data: [
        { column_name: "Postal Code", string_value: "mo@grav.in", column_id: "EMAIL" },
        { string_value: "+919876543210", column_id: "PHONE_NUMBER" },
        { column_name: "User Email", string_value: "Acme Ltd", column_id: "COMPANY_NAME" },
      ],
    });

    expect(r.lead.contact).toEqual({
      email: "mo@grav.in",
      phone: "+919876543210",
      companyName: "Acme Ltd",
    });
  });

  test("6. an unknown column is kept, flagged, and never guessed at", () => {
    const r = webhook({
      ...OFFICIAL_PRODUCTION,
      user_column_data: [
        { column_id: "EMAIL", string_value: "mo@grav.in" },
        { column_id: "PREFERRED_DEALERSHIP", column_name: "Select your preferred dealership", string_value: "North branch" },
        { column_id: "SOMETHING_GOOGLE_ADDS_IN_2027", string_value: "42" },
      ],
    });

    /* ── KEPT, BECAUSE SOMEBODY TYPED IT ─────────────────────────────────
       Dropping it loses an answer. Guessing its meaning from the label is
       worse: "Select your preferred dealership" would land in a preferred-
       location field and read as an answer to a question nobody asked. */
    expect(r.lead.unmapped).toHaveLength(2);
    expect(r.lead.unmapped.map((u) => u.code).sort())
      .toEqual(["PREFERRED_DEALERSHIP", "SOMETHING_GOOGLE_ADDS_IN_2027"]);

    for (const u of r.lead.unmapped) {
      expect(u.needsReview).toBe(true);
      expect(u.selfReported).toBe(true);
      expect(u.answer).toBeTruthy();
      /* No GRAV field was invented for it. */
      expect(u).not.toHaveProperty("question");
    }
    expect(r.lead.contact).toEqual({ email: "mo@grav.in" });
  });

  test("7. every answer carries its question and stays self-reported", () => {
    const r = webhook({
      ...OFFICIAL_PRODUCTION,
      user_column_data: [
        { column_id: "EMAIL", string_value: "mo@grav.in" },
        { column_id: "JOB_ROLE", string_value: "Procurement Manager" },
        { column_id: "COMPANY_SIZE", string_value: "201-500" },
      ],
    });

    /* ── "201-500" MEANS NOTHING ON ITS OWN ──────────────────────────────── */
    const size = r.lead.answers.find((a) => a.code === "COMPANY_SIZE");
    expect(size.question).toBe("What size is your company?");
    expect(size.answer).toBe("201-500");

    /* ── AND NONE OF IT IS A FACT ABOUT AN EMPLOYER ──────────────────────
       Somebody typed "Procurement Manager" about themselves. Nothing checked
       it. The flag travels with the answer so no read model can lose it. */
    for (const a of r.lead.answers) expect(a.selfReported).toBe(true);
    expect(r.lead.answers.find((a) => a.code === "JOB_ROLE").selfReported).toBe(true);
  });

  test("8. the one thing Google does verify is kept apart from everything it does not", () => {
    /* `PHONE_NUMBER_VERIFIED` says a phone line answers. It says nothing about
       who owns it, where they work or what they do — so it is neither a
       contact field nor a self-reported answer. */
    const r = webhook({
      ...OFFICIAL_PRODUCTION,
      user_column_data: [
        { column_id: "PHONE_NUMBER", string_value: "+11234567890" },
        { column_id: "PHONE_NUMBER_VERIFIED", string_value: "true" },
      ],
    });

    expect(r.lead.phoneVerified).toBe(true);
    expect(r.lead.contact).toEqual({ phone: "+11234567890" });
    expect(r.lead.answers).toEqual([]);
    expect(r.lead.unmapped).toEqual([]);
  });

  test("9. a delivery with no identifier or no data is refused", () => {
    expect(webhook({ ...OFFICIAL_PRODUCTION, lead_id: "" }))
      .toMatchObject({ ok: false, reason: "missing_lead_id" });
    expect(webhook({ ...OFFICIAL_PRODUCTION, user_column_data: [] }))
      .toMatchObject({ ok: false, reason: "no_submitted_data" });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. INT64 IDENTIFIERS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("identifiers Google says are 8-byte integers", () => {
  test("10. a campaign id too large for a JavaScript number keeps its digits", () => {
    /* ── THE SILENT ONE ──────────────────────────────────────────────────
       Google says "Clients need to use 8 bytes integer to process" four
       times. `JSON.parse` turns 22300000000000000001 into a nearby number
       without complaining, and the correlation it was for then matches
       nothing — a lead that belongs to a campaign GRAV cannot find. */
    const big = "22300000000000000001";
    expect(normalisation.int64Text(big)).toBe(big);
    expect(String(Number(big))).not.toBe(big);

    const r = normalisation.normalise({
      via: "webhook",
      payload: OFFICIAL_PRODUCTION,
      rawIds: { campaign_id: big, form_id: "9007199254740993" },
    });

    expect(r.lead.correlation.campaignId).toBe(big);
    expect(r.lead.correlation.formId).toBe("9007199254740993");
  });

  test("11. ordinary ids still work, and a missing one is empty rather than zero", () => {
    const r = webhook(OFFICIAL_PRODUCTION);
    expect(r.lead.correlation.campaignId).toBe("123456");
    expect(r.lead.correlation.formId).toBe("1234");
    /* Absent is absent. A zero would be an id that could match something. */
    expect(r.lead.correlation.adGroupId).toBe("");
    expect(normalisation.int64Text(undefined)).toBe("");
    expect(normalisation.int64Text("not-a-number")).toBe("");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. VERIFICATION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("verification", () => {
  test("12. the right secret passes under either documented spelling", () => {
    expect(verification.verify({ payload: { google_key: SECRET }, expected: SECRET }).verified).toBe(true);
    expect(verification.verify({ payload: { Google_key: SECRET }, expected: SECRET }).verified).toBe(true);
  });

  test("13. a wrong or missing secret is refused, and told never to retry", () => {
    const wrong = verification.verify({ payload: { google_key: "not-the-key" }, expected: SECRET });
    expect(wrong).toMatchObject({ verified: false, reason: "secret_mismatch", retryable: false });

    const missing = verification.verify({ payload: {}, expected: SECRET });
    expect(missing).toMatchObject({ verified: false, reason: "secret_missing", retryable: false });

    /* A wrong key will not become right on a retry, so Google is told to stop
       — that is what a 4XX means in its own Lead handling table. */
    expect(verification.httpOutcome("UNVERIFIED").status).toBe(403);
    expect(verification.httpOutcome("UNVERIFIED").retryable).toBe(false);
  });

  test("14. no configured secret refuses everything — it never compares empty to empty", () => {
    /* ── THE ONE THAT OPENS THE DOOR TO EVERYBODY ────────────────────────
       An unconfigured endpoint comparing "" to "" accepts every delivery from
       anybody. Answered as a server fault and marked retryable, because the
       sender did nothing wrong and somebody may be about to configure it. */
    expect(verification.verify({ payload: { google_key: SECRET }, expected: "" }))
      .toMatchObject({ verified: false, reason: "not_configured", retryable: true });

    expect(verification.verify({ payload: { google_key: "" }, expected: "" }).verified).toBe(false);
    expect(verification.verify({ payload: {}, expected: "" }).verified).toBe(false);
    expect(verification.verify({ payload: {}, expected: null }).verified).toBe(false);
  });

  test("15. a refusal names nothing about the secret", () => {
    const r = verification.verify({ payload: { google_key: "wrong-but-similar" }, expected: SECRET });
    const flat = JSON.stringify(r);

    /* A refusal that echoed the key it rejected would hand a working
       credential to whoever sent the wrong one. */
    expect(flat).not.toContain(SECRET);
    expect(flat).not.toContain("wrong-but-similar");
    expect(flat).not.toMatch(/length|expected|supplied/i);

    const outcome = verification.httpOutcome("UNVERIFIED", "Refused.");
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  test("16. comparison does not reveal how much of the secret was right", () => {
    /* ── A SLOW ATTACK, AND AN ENTIRELY PRACTICAL ONE ────────────────────
       `===` stops at the first differing character, so the time it takes is
       proportional to the matching prefix. Against an endpoint that is
       reachable from the internet by design, an attacker who can measure
       responses learns the secret one character at a time.

       Both sides are hashed first, so the comparison is always over 32 bytes
       whatever arrived. This asserts the property — a near-miss and a
       one-character candidate cost the same — rather than a wall-clock
       number, which would be flaky on a shared machine. */
    const samples = (candidate) => {
      const runs = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const started = process.hrtime.bigint();
        for (let i = 0; i < 4000; i += 1) verification.secretsMatch(candidate, SECRET);
        runs.push(Number(process.hrtime.bigint() - started));
      }
      return Math.min(...runs);
    };

    const nearMiss = samples(`${SECRET.slice(0, -1)}X`);
    const nothingRight = samples("X");
    const ratio = nearMiss / nothingRight;

    /* A prefix leak shows as a near-miss costing markedly more. Generous
       bounds: this is proving there is no LINEAR relationship, on a machine
       that may be running other work. */
    expect({ leaks: ratio > 3 || ratio < 0.33, ratio: Number.isFinite(ratio) })
      .toEqual({ leaks: false, ratio: true });

    /* And an enormous candidate neither throws nor matches. */
    expect(verification.secretsMatch("a".repeat(100000), SECRET)).toBe(false);
    expect(verification.secretsMatch(null, SECRET)).toBe(false);
    expect(verification.secretsMatch(undefined, SECRET)).toBe(false);
  });

  test("17. the secret never reaches a normalised lead", () => {
    /* ── IT IS COMPARED, THEN DROPPED ────────────────────────────────────
       A normalised lead is stored, indexed, read back and rendered. A secret
       riding along inside one would end up in all four. */
    const r = webhook(OFFICIAL_PRODUCTION);
    const flat = JSON.stringify(r.lead);

    expect(flat).not.toContain(SECRET);
    expect(flat).not.toMatch(/google_key|Google_key/i);
    expect(r.lead).not.toHaveProperty("google_key");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. THE TWO DOORS CONVERGE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("webhook and recovery are the same lead", () => {
  /* The recovery sweep reads `lead_form_submission_data`, whose fields are
     `field_type` / `field_value` — the same enum, different key names. */
  const RETRIEVED = Object.freeze({
    id: OFFICIAL_PRODUCTION.lead_id,
    submission_date_time: "2026-09-01 12:30:00+05:30",
    lead_form_submission_fields: [
      { field_type: "FULL_NAME", field_value: "John Doe" },
      { field_type: "PHONE_NUMBER", field_value: "+11234567890" },
    ],
    gclid: OFFICIAL_PRODUCTION.gcl_id,
  });

  test("18. the same submission from either door produces the same lead", () => {
    const pushed = webhook(OFFICIAL_PRODUCTION).lead;
    const pulled = normalisation.normalise({ via: "retrieval", payload: RETRIEVED }).lead;

    /* ── THE SAME IDENTITY, SO DEDUPLICATION CATCHES IT ──────────────────
       If each door had its own normaliser they would drift, and the drift
       would appear as one submission stored twice with slightly different
       contents — the exact thing deduplication exists to stop. */
    expect(pulled.providerLeadId).toBe(pushed.providerLeadId);
    expect(pulled.contact).toEqual(pushed.contact);
    expect(pulled.channel).toBe(pushed.channel);
    expect(pulled.clickId).toBe(pushed.clickId);

    /* Only the provenance differs, and it is recorded rather than lost. */
    expect(pushed.receivedVia).toBe("delivery");
    expect(pulled.receivedVia).toBe("recovery");
  });

  test("19. custom-question answers survive recovery, under Google's real shape", () => {
    /* ── THIS TEST USED TO ASSERT A SHAPE GOOGLE DOES NOT HAVE ────────────
       It gave custom answers a `field_type`, and the normaliser read them the
       same way, so the two agreed and both were wrong. Google's
       `CustomLeadFormSubmissionField` is `{ question_text, field_value }` —
       no field type at all. Read through the old mapping, every custom answer
       had an empty column id and was silently dropped.

       GRAV offers no custom questions, so one appearing means the form was
       built elsewhere. The answer is kept, flagged, and not interpreted. */
    const withCustom = normalisation.normalise({
      via: "retrieval",
      payload: {
        ...RETRIEVED,
        custom_lead_form_submission_fields: [
          { question_text: "Which uniform range are you interested in?", field_value: "Hospitality" },
          { question_text: "Anything else?", field_value: "" },
        ],
      },
    });

    expect(withCustom.lead.unmapped).toEqual([
      expect.objectContaining({ code: "CUSTOM_QUESTION", answer: "Hospitality", needsReview: true, selfReported: true }),
    ]);
    /* An empty answer is not an answer. */
    expect(withCustom.lead.unmapped).toHaveLength(1);
    /* The standard fields still map as before. */
    expect(withCustom.lead.contact).toEqual({ fullName: "John Doe", phone: "+11234567890" });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. THE RECORDED BOUNDARY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("what is not built, recorded rather than worked around", () => {
  test("20. the webhook key is derived, so nothing secret is persisted at all", () => {
    /* ── THE VAULT THAT WAS NOT NEEDED ───────────────────────────────────
       Marketing's binding contract keeps credentials out of the database, and
       an earlier pass stopped here for want of a company-scoped secret store.

       The way past it was not to build one. Google lets the advertiser choose
       the webhook key and only ever hands it back inside a delivery, so GRAV
       never needs to retrieve one — only to recognise it. What it can
       recompute it does not have to keep.

       So the database holds an integer version and a binding identity, and a
       dumped database yields no key for any company. */
    expect(W.SECRET_BOUNDARY.strategy).toBe("derived_per_binding");
    expect(W.SECRET_BOUNDARY.storedInDatabase).toEqual(["secretVersion"]);
    expect(W.SECRET_BOUNDARY.masterVariable).toBe("MARKETING_GOOGLE_LEAD_WEBHOOK_MASTER_SECRET_V1");
    expect(W.SECRET_BOUNDARY.purpose).toMatch(/^grav\.marketing\.google-lead-webhook\.v\d+$/);

    /* ── AND THE COST IS RECORDED, NOT GLOSSED ───────────────────────────
       One master is a single point of compromise for every company's keys.
       Against a database dump it is a complete defence; against a compromised
       deployment environment it is none. A contract that only stated the
       upside would be selling something. */
    expect(W.SECRET_BOUNDARY.blastRadius).toMatch(/single point of compromise/i);
    expect(W.SECRET_BOUNDARY.neverDo).toMatch(/Store the derived key/i);

    /* It reuses no other secret. */
    const keys = require("../../services/marketing/leads/leadWebhookKey");
    expect(keys.FORBIDDEN_SOURCES).toEqual(
      expect.arrayContaining(["SALARY_ENCRYPTION_KEY", "MARKETING_CHANNEL_ID_SECRET", "JWT_SECRET"]),
    );
  });

  test("21. the campaign type is still not deployable, and Meta's never was", () => {
    const caps = require("../../constants/marketingCampaignCapabilities");

    expect(caps.DEPLOYABLE_CAMPAIGN_TYPES).not.toContain("google_lead_form");
    expect(caps.CAMPAIGN_TYPE_BY_CODE.google_lead_form.deployable).toBe(false);

    /* Untouched by any of this work. */
    expect(caps.CAMPAIGN_TYPE_BY_CODE.meta_lead_form.deployable).toBe(false);
    expect(caps.DEPLOYABLE_CAMPAIGN_TYPES).toEqual(["google_search", "meta_traffic_single_image"]);
  });

  test("22. Google's documented HTTP outcomes are the ones GRAV answers", () => {
    /* Straight from the Lead handling table: 200 with `{}`, 4XX not
       retryable, 5XX retryable. A duplicate answers 200 — GRAV has the lead,
       and any other answer asks Google to keep redelivering it. */
    expect(verification.httpOutcome("ACCEPTED")).toEqual({ status: 200, body: {}, retryable: false });
    expect(verification.httpOutcome("DUPLICATE")).toEqual({ status: 200, body: {}, retryable: false });

    const refused = verification.httpOutcome("REFUSED", "That delivery could not be read.");
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(refused.retryable).toBe(false);
    expect(refused.body.message).toBeTruthy();

    const later = verification.httpOutcome("TRY_AGAIN", "Temporarily unavailable.");
    expect(later.status).toBeGreaterThanOrEqual(500);
    expect(later.retryable).toBe(true);
  });
});
