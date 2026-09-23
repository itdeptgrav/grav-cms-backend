// test/marketing/google-lead-processing.test.js
//
// FROM AN ENQUIRY TO A PERSON, AN ENGAGEMENT AND A DECISION.
//
// ── THE THREE WAYS THIS GOES WRONG, IN ORDER OF COST ───────────────────────
//
//   Consent recorded that nobody gave. A legal claim GRAV cannot support,
//   invisible until somebody complains about an email they never agreed to.
//   Almost everything about the consent half of this file is that one failure.
//
//   Two humans merged into one record. An email matching one person and a
//   phone matching another is not a puzzle to solve automatically — every
//   automatic answer is a guess, and the destructive one cannot be undone.
//
//   A replay doubling the effects. Google's delivery is at-least-once and its
//   verification is a replayable shared secret, so a second copy of a lead is
//   ordinary. Two identities, two engagements or two consent rows from one
//   submission would all look like ordinary data.
"use strict";

const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { MarketingAdvertisingLead } = require("../../models/CMS_Models/Marketing/MarketingAdvertisingLead");
const {
  MarketingLeadProcessingReceipt,
} = require("../../models/CMS_Models/Marketing/MarketingLeadProcessingReceipt");
const {
  MarketingLeadDeliveryBinding,
} = require("../../models/CMS_Models/Marketing/MarketingLeadDeliveryBinding");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const { MarketingIntentEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const { MarketingConsent } = require("../../models/CMS_Models/Marketing/MarketingConsent");
const ProspectHandover = require("../../models/CMS_Models/Marketing/ProspectHandover");

const processing = require("../../services/marketing/leads/leadProcessing.service");
const P = require("../../constants/marketingLeadProcessing");

let A; let B;
let seq = 0;
const fresh = (p) => `${p}-${Date.now()}-${(seq += 1)}`;

beforeEach(async () => {
  A = (await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") }))._id;
  B = (await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") }))._id;
});

/* A binding, optionally asking for marketing permission. */
async function makeBinding(companyId, notice = null) {
  return MarketingLeadDeliveryBinding.create({
    companyId,
    bindingRef: fresh("gld"),
    campaignDraftId: new mongoose.Types.ObjectId(),
    draftRef: fresh("MCP"),
    approvedRevision: 3,
    channel: "google_ads",
    campaignType: "google_lead_form",
    secretVersion: 1,
    state: "bound",
    idempotencyKey: fresh("idem"),
    commandFingerprint: fresh("fp"),
    consentNotice: notice || {
      requested: false, noticeId: "", noticeVersion: "", columnId: "",
      purpose: "marketing", channel: "email",
    },
  });
}

/* One recorded submission, as Chunk 3A would have written it. */
async function makeLead(companyId, binding, over = {}) {
  const ref = fresh("MLS");
  await MarketingAdvertisingLead.create({
    companyId,
    submissionRef: ref,
    channel: "google_ads",
    campaignDraftId: binding.campaignDraftId,
    draftRef: binding.draftRef,
    approvedRevision: binding.approvedRevision,
    bindingId: binding._id,
    providerSubmissionId: fresh("Cj0KCQ"),
    submittedAt: new Date("2026-09-01T10:30:00Z"),
    receivedAt: new Date("2026-09-05T08:00:00Z"),
    contact: { fullName: "R Sharma", email: "r.sharma@acme.in", phone: "+91 98765 43210", ...(over.contact || {}) },
    answers: over.answers || [],
    unmapped: over.unmapped || [],
    ingestionOrigin: "delivery",
    classification: "production",
    ...(over.top || {}),
  });
  return ref;
}

const run = (companyId, submissionRef) => processing.process({ companyId, submissionRef });

const receiptFor = (companyId, submissionRef) =>
  MarketingLeadProcessingReceipt.findOne({ companyId, submissionRef });

/* ═══════════════════════════════════════════════════════════════════════════
   1. WHO WAS IT
   ═══════════════════════════════════════════════════════════════════════════ */

describe("identity", () => {
  test("1. an existing person is matched by email, by phone, or by both", async () => {
    const binding = await makeBinding(A);

    /* Somebody GRAV already knows, reachable both ways. */
    await MarketingIdentity.create({
      companyId: A, gravPersonKey: "known-person",
      email: "r.sharma@acme.in", normalizedPhone: "9876543210",
    });

    for (const contact of [
      { email: "r.sharma@acme.in", phone: "" },
      { email: "", phone: "+91 98765 43210" },
      { email: "r.sharma@acme.in", phone: "+91 98765 43210" },
    ]) {
      const ref = await makeLead(A, binding, { contact });
      const out = await run(A, ref);

      expect(out.stage).toBe("completed");
      const receipt = await receiptFor(A, ref);
      expect(receipt.gravPersonKey).toBe("known-person");
      expect(receipt.identityCreated).toBe(false);
    }

    /* No new person was invented for any of the three. */
    expect(await MarketingIdentity.countDocuments({ companyId: A })).toBe(1);
  });

  test("2. a person GRAV has not seen is created exactly once", async () => {
    const binding = await makeBinding(A);

    const byEmail = await makeLead(A, binding, { contact: { email: "new@acme.in", phone: "" } });
    await run(A, byEmail);

    const byPhone = await makeLead(A, binding, { contact: { email: "", phone: "+91 90000 11111" } });
    await run(A, byPhone);

    expect(await MarketingIdentity.countDocuments({ companyId: A })).toBe(2);

    const first = await receiptFor(A, byEmail);
    expect(first.identityCreated).toBe(true);
    expect(first.gravPersonKey).toBeTruthy();

    /* ── AND RUNNING AGAIN CREATES NOBODY ───────────────────────────────── */
    await run(A, byEmail);
    await run(A, byPhone);
    expect(await MarketingIdentity.countDocuments({ companyId: A })).toBe(2);
  });

  test("3. an email and a phone matching different people waits for a human", async () => {
    const binding = await makeBinding(A);
    await MarketingIdentity.create({ companyId: A, gravPersonKey: "person-one", email: "one@acme.in" });
    await MarketingIdentity.create({ companyId: A, gravPersonKey: "person-two", normalizedPhone: "9876543210" });

    const ref = await makeLead(A, binding, {
      contact: { email: "one@acme.in", phone: "+91 98765 43210" },
    });
    const out = await run(A, ref);

    /* ── EVERY AUTOMATIC ANSWER IS A GUESS ───────────────────────────────
       Choosing one attaches the enquiry to possibly the wrong human. Merging
       destroys two records that may be two real people, and cannot be undone.
       Creating a third makes the problem permanent. */
    expect(out.stage).toBe("needs_human_review");
    expect(out.reason).toBe("identity_conflict");

    expect(await MarketingIdentity.countDocuments({ companyId: A })).toBe(2);
    const one = await MarketingIdentity.findOne({ gravPersonKey: "person-one" }).lean();
    expect(one.normalizedPhone).toBe("");

    /* ── AND NOTHING ELSE HAPPENS UNTIL IT IS ANSWERED ───────────────────
       An engagement would have to belong to somebody, and GRAV does not know
       who. Consent even more so. */
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(0);
    expect(await MarketingConsent.countDocuments({ companyId: A })).toBe(0);

    const receipt = await receiptFor(A, ref);
    expect(receipt.engagementRecordedAt).toBeNull();
    expect(receipt.consentEvaluatedAt).toBeNull();
  });

  test("4. an enquiry nobody can be recognised from waits for a human", async () => {
    const binding = await makeBinding(A);

    for (const contact of [
      { email: "", phone: "" },
      { email: "not-an-email", phone: "" },
      { email: "", phone: "12" },
      { email: "@@@", phone: "abc" },
    ]) {
      const ref = await makeLead(A, binding, {
        contact: { fullName: "R Sharma", companyName: "Acme", jobTitle: "Buyer", ...contact },
      });
      const out = await run(A, ref);

      /* ── A NAME AND A COMPANY ARE NOT AN IDENTITY ────────────────────────
         Two people called "R Sharma" at "Acme" are two people. Matching on
         them would merge humans on a coincidence, and every one of those
         fields is self-reported and unverified anyway. */
      expect(out.stage).toBe("needs_human_review");
      expect(out.reason).toBe("no_usable_identifier");
    }

    expect(await MarketingIdentity.countDocuments({ companyId: A })).toBe(0);
    /* The submission itself is untouched and kept. */
    expect(await MarketingAdvertisingLead.countDocuments({ companyId: A })).toBe(4);
  });

  test("5. a valid identifier beside an invalid one still works", async () => {
    const binding = await makeBinding(A);

    const emailOnly = await makeLead(A, binding, { contact: { email: "ok@acme.in", phone: "nonsense" } });
    expect((await run(A, emailOnly)).stage).toBe("completed");

    const phoneOnly = await makeLead(A, binding, { contact: { email: "@broken", phone: "+91 91234 56789" } });
    expect((await run(A, phoneOnly)).stage).toBe("completed");

    expect(await MarketingIdentity.countDocuments({ companyId: A })).toBe(2);
  });

  test("6. email case and whitespace do not make a second person", async () => {
    const binding = await makeBinding(A);

    const first = await makeLead(A, binding, { contact: { email: "R.Sharma@Acme.IN", phone: "" } });
    await run(A, first);

    const second = await makeLead(A, binding, { contact: { email: "  r.sharma@acme.in  ", phone: "" } });
    await run(A, second);

    expect(await MarketingIdentity.countDocuments({ companyId: A })).toBe(1);
  });

  test("7. the same person's details in two companies are two people", async () => {
    const bindingA = await makeBinding(A);
    const bindingB = await makeBinding(B);

    const refA = await makeLead(A, bindingA, { contact: { email: "shared@acme.in", phone: "" } });
    const refB = await makeLead(B, bindingB, { contact: { email: "shared@acme.in", phone: "" } });

    await run(A, refA);
    await run(B, refB);

    expect(await MarketingIdentity.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingIdentity.countDocuments({ companyId: B })).toBe(1);

    const a = await MarketingIdentity.findOne({ companyId: A }).lean();
    const b = await MarketingIdentity.findOne({ companyId: B }).lean();
    /* One company's records are not the other's, however alike they look. */
    expect(a.gravPersonKey).not.toBe(b.gravPersonKey);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. WHAT THEY DID
   ═══════════════════════════════════════════════════════════════════════════ */

describe("engagement", () => {
  test("8. exactly one engagement, however many times processing runs", async () => {
    const binding = await makeBinding(A);
    const ref = await makeLead(A, binding);

    for (let i = 0; i < 5; i += 1) await run(A, ref);

    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(1);

    const event = await MarketingIntentEvent.findOne({ companyId: A }).lean();
    expect(event.kind).toBe("form_submitted");
    expect(event.source).toBe("google_ads");
  });

  test("9. the engagement carries the submission time, not the arrival time", async () => {
    const binding = await makeBinding(A);
    const ref = await makeLead(A, binding);
    await run(A, ref);

    const event = await MarketingIntentEvent.findOne({ companyId: A }).lean();

    /* ── A RECOVERY CAN DELIVER A WEEK-OLD SUBMISSION ────────────────────
       Ordering a person's history by when GRAV happened to hear about
       something would put their story in the wrong order. */
    expect(event.occurredAt.toISOString()).toBe("2026-09-01T10:30:00.000Z");
    expect(event.occurredAt.getTime()).toBeLessThan(new Date("2026-09-05T08:00:00Z").getTime());
  });

  test("10. the engagement names GRAV's plan, never a provider identifier", async () => {
    const binding = await makeBinding(A);
    const ref = await makeLead(A, binding);
    await run(A, ref);

    const event = await MarketingIntentEvent.findOne({ companyId: A }).lean();
    expect(event.campaignName).toBe(binding.draftRef);

    const flat = JSON.stringify(event);
    expect(flat).not.toMatch(/Cj0KCQ/);       // the provider submission id
    expect(flat).not.toContain("1234567890"); // an account number
    expect(event.campaignId).toBe("");
  });

  test("11. it belongs to the person identity resolution found", async () => {
    const binding = await makeBinding(A);
    await MarketingIdentity.create({
      companyId: A, gravPersonKey: "known-person", email: "r.sharma@acme.in",
    });

    const ref = await makeLead(A, binding);
    await run(A, ref);

    const event = await MarketingIntentEvent.findOne({ companyId: A }).lean();
    expect(event.gravPersonKey).toBe("known-person");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. DID THEY AGREE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("consent", () => {
  const NOTICE = Object.freeze({
    requested: true,
    noticeId: "marketing-optin",
    noticeVersion: "2026-01",
    columnId: "CATEGORY",
    purpose: "marketing",
    channel: "email",
  });

  test("12. a form that does not ask records no permission, and that is not a refusal", async () => {
    const binding = await makeBinding(A);
    const ref = await makeLead(A, binding);

    const out = await run(A, ref);
    expect(out.stage).toBe("completed");
    expect(out.reason).toBe("consent_not_requested");

    /* ── SUBMITTING IS NOT AGREEING ──────────────────────────────────────
       Somebody who asked for a quote asked for a quote. */
    expect(await MarketingConsent.countDocuments({ companyId: A })).toBe(0);

    /* ── AND IT IS NOT A SUPPRESSION EITHER ──────────────────────────────
       They never declined anything. Recording an opt-out would take a
       decision on their behalf that they did not make. */
    const receipt = await receiptFor(A, ref);
    expect(receipt.consentRecorded).toBe(false);
    expect(receipt.stage).toBe("completed");

    /* Everything else about them survives. */
    expect(await MarketingIdentity.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(1);
  });

  test("13. explicit agreement to the exact recorded wording is recorded", async () => {
    const binding = await makeBinding(A, NOTICE);
    const ref = await makeLead(A, binding, {
      answers: [{ code: "CATEGORY", question: "Which category are you interested in?", answer: "Yes", selfReported: true }],
    });

    const out = await run(A, ref);
    expect(out.stage).toBe("completed");
    expect(out.reason).toBe("consent_recorded");

    const rows = await MarketingConsent.find({ companyId: A }).lean();
    expect(rows.length).toBeGreaterThan(0);

    const receipt = await receiptFor(A, ref);
    expect(receipt.consentRecorded).toBe(true);
  });

  test("14. an ambiguous, negative or missing answer records nothing", async () => {
    const binding = await makeBinding(A, NOTICE);

    const answers = [
      ["ambiguous", "maybe"],
      ["positive-sounding but not agreement", "very interested"],
      ["a qualification answer", "Uniforms"],
      ["explicitly no", "No"],
      ["empty", ""],
    ];

    for (const [label, answer] of answers) {
      const ref = await makeLead(A, binding, {
        answers: answer
          ? [{ code: "CATEGORY", question: "Which category are you interested in?", answer, selfReported: true }]
          : [],
      });
      const out = await run(A, ref);

      /* ── NOTHING FUZZY ───────────────────────────────────────────────────
         "Very interested" is a person saying they want the product. It is not
         them agreeing to be marketed to, and a heuristic that treated it as
         agreement would record permission nobody gave. */
      expect({ label, recorded: (await receiptFor(A, ref)).consentRecorded })
        .toEqual({ label, recorded: false });
      expect(out.stage).toBe("completed");
    }

    expect(await MarketingConsent.countDocuments({ companyId: A })).toBe(0);
    /* Every one of those people is still known, and still engaged. */
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(answers.length);
  });

  test("15. an answer under a column the form did not nominate is not consent", async () => {
    const binding = await makeBinding(A, NOTICE);
    const ref = await makeLead(A, binding, {
      /* "Yes" — but to a different question entirely. */
      answers: [{ code: "JOB_ROLE", question: "What is your job role?", answer: "Yes", selfReported: true }],
    });

    await run(A, ref);
    expect((await receiptFor(A, ref)).consentRecorded).toBe(false);
    expect(await MarketingConsent.countDocuments({ companyId: A })).toBe(0);
  });

  test("16. a notice with no version or no identifier proves nothing", async () => {
    for (const broken of [
      { ...NOTICE, noticeVersion: "" },
      { ...NOTICE, noticeId: "" },
      { ...NOTICE, columnId: "" },
    ]) {
      const binding = await makeBinding(A, broken);
      const ref = await makeLead(A, binding, {
        answers: [{ code: "CATEGORY", question: "Which category are you interested in?", answer: "Yes", selfReported: true }],
      });

      const out = await run(A, ref);

      /* ── UNEVIDENCED CONSENT IS WORSE THAN NONE ──────────────────────────
         Permission whose exact wording nobody kept cannot be evidenced later,
         and it will be relied on precisely because it is recorded. */
      expect(out.reason).toBe("consent_notice_unproven");
      expect((await receiptFor(A, ref)).consentRecorded).toBe(false);
    }
    expect(await MarketingConsent.countDocuments({ companyId: A })).toBe(0);
  });

  test("17. a notice version supplied by the delivery is never trusted", async () => {
    /* A binding that asks nothing, plus a payload claiming it all. */
    const binding = await makeBinding(A);
    const ref = await makeLead(A, binding, {
      answers: [
        { code: "CATEGORY", question: "Which category are you interested in?", answer: "Yes", selfReported: true },
      ],
      unmapped: [
        { code: "CONSENT_NOTICE_VERSION", answer: "2026-01", selfReported: true, needsReview: true },
        { code: "MARKETING_CONSENT", answer: "true", selfReported: true, needsReview: true },
      ],
    });

    const out = await run(A, ref);

    /* ── CONSENT ASSEMBLED FROM THE SENDER'S OWN CLAIMS EVIDENCES NOTHING ──
       A notice version arriving in a delivery is a value the sender chose. */
    expect(out.reason).toBe("consent_not_requested");
    expect(await MarketingConsent.countDocuments({ companyId: A })).toBe(0);
  });

  test("18. a privacy-policy link alone is not permission", async () => {
    /* The link is mandatory on every Google lead form. If its presence meant
       consent, every lead form would produce it. */
    const binding = await makeBinding(A);
    expect(binding.consentNotice.requested).toBe(false);

    const ref = await makeLead(A, binding);
    await run(A, ref);
    expect(await MarketingConsent.countDocuments({ companyId: A })).toBe(0);

    /* And the list of things that are never consent says so explicitly. */
    const codes = P.NEVER_CONSENT.map((n) => n.code);
    expect(codes).toEqual(expect.arrayContaining([
      "privacy_policy_url", "form_submitted", "email_supplied",
      "notice_displayed", "provider_disclaimer", "preselected_answer",
      "positive_qualification", "missing_answer", "unknown_field",
    ]));
  });

  test("19. replaying does not write a second consent row", async () => {
    const binding = await makeBinding(A, NOTICE);
    const ref = await makeLead(A, binding, {
      answers: [{ code: "CATEGORY", question: "Which category are you interested in?", answer: "yes", selfReported: true }],
    });

    await run(A, ref);
    const after = await MarketingConsent.countDocuments({ companyId: A });

    for (let i = 0; i < 4; i += 1) await run(A, ref);
    expect(await MarketingConsent.countDocuments({ companyId: A })).toBe(after);
  });

  test("20. the notice cannot be changed once leads have arrived under it", async () => {
    const binding = await makeBinding(A, NOTICE);
    binding.noticeSettledAt = new Date();
    await binding.save();

    binding.consentNotice.noticeVersion = "2027-06";
    /* ── CHANGING IT RE-DESCRIBES PERMISSION ALREADY GIVEN ───────────────
       Retrospectively, to evidence somebody may have relied on. */
    await expect(binding.save()).rejects.toThrow(/already received leads/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. CRASHES AND REPLAYS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("resuming", () => {
  const NOTICE = Object.freeze({
    requested: true, noticeId: "marketing-optin", noticeVersion: "2026-01",
    columnId: "CATEGORY", purpose: "marketing", channel: "email",
  });

  test("21. a crash after identity resumes at engagement", async () => {
    const binding = await makeBinding(A);
    const ref = await makeLead(A, binding);

    /* Fail the engagement write once, leaving a receipt that knows who but
       not what. */
    const spy = jest.spyOn(MarketingIntentEvent, "create")
      .mockRejectedValueOnce(new Error("connection lost"));

    const first = await run(A, ref);
    expect(first.stage).toBe("retryable_failure");

    const mid = await receiptFor(A, ref);
    expect(mid.gravPersonKey).toBeTruthy();
    expect(mid.engagementRecordedAt).toBeNull();
    spy.mockRestore();

    /* ── THE RESUME REPEATS NOTHING FINISHED ─────────────────────────────── */
    const second = await run(A, ref);
    expect(second.stage).toBe("completed");

    expect(await MarketingIdentity.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(1);

    const done = await receiptFor(A, ref);
    /* The person found on the first attempt is the person it finished with. */
    expect(done.gravPersonKey).toBe(mid.gravPersonKey);
  });

  test("22. a crash after engagement resumes at consent", async () => {
    const binding = await makeBinding(A, NOTICE);
    const ref = await makeLead(A, binding, {
      answers: [{ code: "CATEGORY", question: "Which category are you interested in?", answer: "yes", selfReported: true }],
    });

    const consentService = require("../../services/marketing/marketingConsent.service");
    const spy = jest.spyOn(consentService, "record")
      .mockRejectedValueOnce(new Error("connection lost"));

    expect((await run(A, ref)).stage).toBe("retryable_failure");

    const mid = await receiptFor(A, ref);
    expect(mid.engagementRecordedAt).toBeTruthy();
    expect(mid.consentEvaluatedAt).toBeNull();
    spy.mockRestore();

    expect((await run(A, ref)).stage).toBe("completed");

    /* The engagement from the first attempt was not repeated. */
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(1);
    expect((await receiptFor(A, ref)).consentRecorded).toBe(true);
  });

  test("23. a finished receipt is recognised as finished", async () => {
    const binding = await makeBinding(A);
    const ref = await makeLead(A, binding);

    expect((await run(A, ref)).stage).toBe("completed");

    const again = await run(A, ref);
    expect(again).toMatchObject({ stage: "completed", alreadyDone: true });

    expect(await MarketingIdentity.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(1);
  });

  test("24. completion is confirmed for THIS submission, not merely that records exist", async () => {
    const binding = await makeBinding(A);

    /* Two submissions from the same person. The second must be processed on
       its own merits — "an identity exists" says nothing about whether THIS
       enquiry has been handled. */
    const first = await makeLead(A, binding);
    await run(A, first);

    const second = await makeLead(A, binding);
    const out = await run(A, second);

    expect(out.stage).toBe("completed");
    expect(await MarketingLeadProcessingReceipt.countDocuments({ companyId: A })).toBe(2);
    /* One person, two engagements — two things they did. */
    expect(await MarketingIdentity.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(2);
  });

  test("25. a missing submission settles rather than retrying for ever", async () => {
    const out = await run(A, "MLS-does-not-exist");
    expect(out).toMatchObject({ stage: "refused", reason: "submission_missing" });
  });

  test("26. another company's work is never touched", async () => {
    const bindingA = await makeBinding(A);
    const bindingB = await makeBinding(B);

    const refA = await makeLead(A, bindingA, { contact: { email: "shared@acme.in", phone: "" } });
    const refB = await makeLead(B, bindingB, { contact: { email: "shared@acme.in", phone: "" } });

    await run(A, refA);
    await run(B, refB);

    /* A's submission cannot be processed under B's company. */
    const crossed = await run(B, refA);
    expect(crossed.stage).toBe("refused");

    for (const company of [A, B]) {
      expect(await MarketingIdentity.countDocuments({ companyId: company })).toBe(1);
      expect(await MarketingIntentEvent.countDocuments({ companyId: company })).toBe(1);
      expect(await MarketingLeadProcessingReceipt.countDocuments({ companyId: company })).toBe(1);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. THE RECEIPT, AND WHERE THIS CHUNK STOPS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the receipt and the boundary", () => {
  test("27. a receipt carries references and codes, never contents", async () => {
    const binding = await makeBinding(A);
    const ref = await makeLead(A, binding);
    await run(A, ref);

    const receipt = await receiptFor(A, ref);
    const flat = JSON.stringify(receipt.toObject());

    /* ── A RECEIPT IS READ BY OPERATORS AND EXPORTED INTO MONITORING ─────
       Every one of those is a place a person's email address should not be. */
    expect(flat).not.toContain("r.sharma@acme.in");
    expect(flat).not.toContain("9876543210");
    expect(flat).not.toContain("R Sharma");
    expect(flat).not.toMatch(/Cj0KCQ/);
    expect(receipt).not.toHaveProperty("contact");
    expect(receipt).not.toHaveProperty("answers");

    /* What it does carry: GRAV's own opaque person key and a stable code. */
    expect(receipt.gravPersonKey).toBeTruthy();
    expect(receipt.gravPersonKey).not.toContain("@");
    expect(P.REASON_CODES).toContain(receipt.reason);
  });

  test("28. the public view says what happened, not how GRAV works", async () => {
    const binding = await makeBinding(A);
    const ref = await makeLead(A, binding);
    await run(A, ref);

    const view = (await receiptFor(A, ref)).publicView();

    expect(view.submissionRef).toBe(ref);
    expect(view.states).toEqual(expect.arrayContaining([
      "new_person_created", "engagement_recorded", "no_marketing_permission_recorded",
    ]));
    for (const state of view.states) expect(P.PUBLIC_STATE_CODES).toContain(state);

    /* No stage names, no attempt counts, no reason codes, no identifiers. */
    const flat = JSON.stringify(view);
    expect(flat).not.toMatch(/pending_identity|consent_evaluated|retryable/);
    expect(flat).not.toMatch(/attempts|gravPersonKey|_id|leadId/);
    expect(flat).not.toContain("r.sharma@acme.in");

    /* And the wording for no permission does not read as a refusal. */
    const wording = P.PUBLIC_STATES.find((s) => s.code === "no_marketing_permission_recorded").means;
    expect(wording).toMatch(/not the same as them saying no/i);
  });

  test("29. processing never reaches Sales, and never calls Google", async () => {
    const fs = require("fs");
    const path = require("path");
    const Lead = require("../../models/CMS_Models/Sales/Lead");
    const Activity = require("../../models/CMS_Models/Sales/Activity");

    const before = await Promise.all([
      ProspectHandover.countDocuments({}), Lead.countDocuments({}), Activity.countDocuments({}),
    ]);

    const binding = await makeBinding(A);
    const ref = await makeLead(A, binding);
    await run(A, ref);

    expect(await Promise.all([
      ProspectHandover.countDocuments({}), Lead.countDocuments({}), Activity.countDocuments({}),
    ])).toEqual(before);

    /* ── STRUCTURAL, NOT DISCIPLINARY ────────────────────────────────────
       A verified enquiry becomes a person who did something. Whether they
       should go to Sales is the existing qualification contract's decision,
       and this file cannot make it. */
    const src = fs.readFileSync(
      path.join(__dirname, "../../services/marketing/leads/leadProcessing.service.js"), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    expect(src).not.toMatch(/prospectHandover|handoverReadModel|salesOutcomeIntake/);
    expect(src).not.toMatch(/require\(["'].*(Sales\/|\/Lead|\/Enquiry|\/Activity)/);
    expect(src).not.toMatch(/googleAdsClient|AdsWriteClient|axios|fetch\(/);
  });

  test("30. the immutable submission is unchanged by any of this", async () => {
    const binding = await makeBinding(A);
    const ref = await makeLead(A, binding);

    const before = await MarketingAdvertisingLead.findOne({ companyId: A, submissionRef: ref }).lean();
    await run(A, ref);
    await run(A, ref);
    const after = await MarketingAdvertisingLead.findOne({ companyId: A, submissionRef: ref }).lean();

    /* Not one field, not a timestamp. The evidence and the decisions about it
       live in different rows precisely so this stays true. */
    expect(after).toEqual(before);
  });

  test("31. google_lead_form is still not deployable", () => {
    const caps = require("../../constants/marketingCampaignCapabilities");
    expect(caps.CAMPAIGN_TYPE_BY_CODE.google_lead_form.deployable).toBe(false);
    expect(caps.CAMPAIGN_TYPE_BY_CODE.meta_lead_form.deployable).toBe(false);
    expect(caps.DEPLOYABLE_CAMPAIGN_TYPES).toEqual(["google_search", "meta_traffic_single_image"]);
  });
});
