// test/marketing/marketing-consent.test.js
//
// CANONICAL MARKETING CONSENT, AND THE ENFORCEMENT THAT RESTS ON IT.
//
// The question this suite exists to answer is not "does the resolver return the
// right string" — it is "can anything obtain Mautic enrolment without a
// recorded grant". So the negative cases outnumber the positive one, and each
// one checks that Mautic was never touched at all rather than touched and
// rolled back.
//
// No HTTP, no Mautic: the resolver is pure GRAV. The contact-sync tests that
// exercise the gate against the Mautic contract double live in
// mautic-contract.test.js.
"use strict";

const mongoose = require("mongoose");

const consentService = require("../../services/marketing/marketingConsent.service");
const sync = require("../../services/marketing/mauticContactSync.service");
const { MauticClient } = require("../../services/marketing/mauticClient");
const { createMauticDouble } = require("../../services/marketing/mauticTestDouble");
const {
  MarketingConsent, MarketingConsentHistory, APPEND_ONLY_MESSAGE,
} = require("../../models/CMS_Models/Marketing/MarketingConsent");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../models/CMS_Models/Sales/Account");
const Contact = require("../../models/CMS_Models/Sales/Contact");

const COMPANY = new mongoose.Types.ObjectId();
const OTHER_COMPANY = new mongoose.Types.ObjectId();
const PERSON = "grav-person-aaaa1111";
const OTHER_PERSON = "grav-person-bbbb2222";
const EMAIL = { channel: "email", purpose: "marketing" };

const ACTOR = { id: new mongoose.Types.ObjectId(), name: "Nikhil Bose", email: "nikhil@grav.in" };

const grant = (overrides = {}) => consentService.record({
  companyId: COMPANY,
  gravPersonKey: PERSON,
  ...EMAIL,
  state: "opted_in",
  capturedSource: "landing page form",
  capturedAt: new Date("2026-09-01T10:00:00Z"),
  noticeVersion: "v3",
  evidenceRef: "form-submission-77",
  actor: ACTOR,
  ...overrides,
});

const resolve = (overrides = {}) => consentService.resolveEffective({
  companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL, ...overrides,
});

/* ═══════════════════════════════════════════════════════════════════════════
   1. THE ONE WAY TO BE ELIGIBLE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("A canonically opted-in person is eligible", () => {
  test("an opt-in with its evidence resolves eligible", async () => {
    const written = await grant();
    expect(written.applied).toBe(true);
    expect(written.record.state).toBe("opted_in");
    expect(written.record.revision).toBe(1);

    const v = await resolve();
    expect(v).toMatchObject({ state: "opted_in", eligible: true, reasonCode: "", reason: "" });
    expect(v.record.capturedSource).toBe("landing page form");
    expect(v.record.noticeVersion).toBe("v3");
    expect(v.record.evidenceRef).toBe("form-submission-77");
    expect(v.record.recordedBy).toMatchObject({ name: "Nikhil Bose", kind: "user" });
  });

  test("the gate lets it through and returns what permitted it", async () => {
    await grant();
    const v = await consentService.assertMarketingEmailEligible({ companyId: COMPANY, gravPersonKey: PERSON });
    expect(v.eligible).toBe(true);
    expect(v.state).toBe("opted_in");
  });

  test("an opt-in with no capture source is refused — 'they agreed' needs a where", async () => {
    await expect(grant({ capturedSource: "" })).rejects.toMatchObject({
      status: 400, code: "MARKETING_CONSENT_INVALID", details: { field: "capturedSource" },
    });
    expect(await MarketingConsent.countDocuments({})).toBe(0);
    expect(await MarketingConsentHistory.countDocuments({})).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. EVERY WAY OF NOT KNOWING IS INELIGIBLE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Consent resolves conservatively", () => {
  test("missing consent is ineligible", async () => {
    const v = await resolve();
    expect(v).toMatchObject({ state: "unknown", eligible: false, reasonCode: "CONSENT_MISSING" });
    expect(v.record).toBeNull();
  });

  test("unknown consent is ineligible", async () => {
    await consentService.record({
      companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL, state: "unknown", actor: ACTOR,
    });
    expect(await resolve()).toMatchObject({ state: "unknown", eligible: false, reasonCode: "CONSENT_UNKNOWN" });
  });

  test("opted-out consent is ineligible", async () => {
    await consentService.withdraw({
      companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL, reason: "asked to stop", actor: ACTOR,
    });
    const v = await resolve();
    expect(v).toMatchObject({ state: "opted_out", eligible: false, reasonCode: "CONSENT_WITHDRAWN" });
  });

  test("suppressed consent is ineligible", async () => {
    await consentService.suppress({
      companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL, reason: "hard bounce", actor: null,
    });
    expect(await resolve()).toMatchObject({ state: "suppressed", eligible: false, reasonCode: "CONSENT_SUPPRESSED" });
  });

  test("suppression on one purpose suppresses the whole channel", async () => {
    /* "Conflicts resolve toward suppression until reviewed." A hard bounce is a
       fact about the ADDRESS: an opt-in recorded for marketing must not outrank
       a suppression recorded under another purpose on the same channel. */
    await grant();
    await consentService.suppress({
      companyId: COMPANY, gravPersonKey: PERSON,
      channel: "email", purpose: "transactional",
      reason: "mailbox does not exist", actor: null,
    });

    const v = await resolve();
    expect(v).toMatchObject({ state: "suppressed", eligible: false, reasonCode: "CONSENT_SUPPRESSED" });
    expect(v.suppressedBy.purpose).toBe("transactional");
    expect(v.reason).toContain("no purpose may use it");
  });

  test("the unique index makes a second current row impossible", async () => {
    await grant();
    await MarketingConsent.syncIndexes();
    await expect(MarketingConsent.collection.insertOne({
      companyId: COMPANY, gravPersonKey: PERSON, channel: "email", purpose: "marketing",
      state: "opted_in", recordedAt: new Date(), revision: 1,
    })).rejects.toMatchObject({ code: 11000 });
  });

  test("if that index were ever lost, conflicting rows refuse rather than pick one", async () => {
    /* The branch above makes this state unreachable in production, and the
       resolver reports it anyway — a guarantee and a belief are different
       things. Reaching the branch at all means dropping the index, which is the
       only honest way to test a defence against its own absence. A silent
       "first row wins" here would mean an opt-out being overruled by a stale
       opt-in, and nobody would see it happen. */
    const INDEX = "companyId_1_gravPersonKey_1_channel_1_purpose_1";
    await MarketingConsent.syncIndexes();
    await MarketingConsent.collection.dropIndex(INDEX);
    try {
      const base = {
        companyId: COMPANY, gravPersonKey: PERSON, channel: "email", purpose: "marketing",
        recordedAt: new Date(), revision: 1,
      };
      await MarketingConsent.collection.insertMany([
        { ...base, state: "opted_in" },
        { ...base, state: "opted_out" },
      ]);

      const v = await resolve();
      expect(v).toMatchObject({ eligible: false, reasonCode: "CONSENT_AMBIGUOUS" });
      expect(v.reason).toContain("A person must review them");
      expect(v.record).toBeNull();
    } finally {
      /* Restored whatever the assertions did, so the next test does not inherit
         a collection with no uniqueness. */
      await MarketingConsent.collection.deleteMany({});
      await MarketingConsent.syncIndexes();
    }
  });

  test("an unmodelled channel or purpose is refused, never coerced", async () => {
    await expect(resolve({ channel: "carrier_pigeon" }))
      .rejects.toMatchObject({ status: 400, code: "MARKETING_CONSENT_INVALID", details: { field: "channel" } });
    await expect(resolve({ purpose: "anything_goes" }))
      .rejects.toMatchObject({ status: 400, details: { field: "purpose" } });
  });

  test("a missing person identity is refused with its own reason", async () => {
    await expect(resolve({ gravPersonKey: "" })).rejects.toMatchObject({
      status: 400, details: { reasonCode: "CONSENT_IDENTITY_MISSING" },
    });
  });

  test("no company is a tenant refusal, not a consent answer", async () => {
    await expect(resolve({ companyId: null }))
      .rejects.toMatchObject({ status: 403, code: "TENANT_MEMBERSHIP_UNPROVEN" });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. TENANT AND IDENTITY ISOLATION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Consent does not leak across companies or people", () => {
  test("another company's opt-in is ineligible here", async () => {
    await consentService.record({
      companyId: OTHER_COMPANY, gravPersonKey: PERSON, ...EMAIL,
      state: "opted_in", capturedSource: "their form", actor: ACTOR,
    });

    /* Not "found and rejected" — not found at all. The selector is
       company-scoped, so isolation is a property of the query. */
    const v = await resolve();
    expect(v).toMatchObject({ eligible: false, reasonCode: "CONSENT_MISSING" });

    /* And it really is eligible in its own company, so the test is not passing
       because the write silently failed. */
    const theirs = await consentService.resolveEffective({
      companyId: OTHER_COMPANY, gravPersonKey: PERSON, ...EMAIL,
    });
    expect(theirs.eligible).toBe(true);
  });

  test("another person's opt-in is ineligible for this person", async () => {
    await consentService.record({
      companyId: COMPANY, gravPersonKey: OTHER_PERSON, ...EMAIL,
      state: "opted_in", capturedSource: "their form", actor: ACTOR,
    });
    expect(await resolve()).toMatchObject({ eligible: false, reasonCode: "CONSENT_MISSING" });
    expect(await resolve({ gravPersonKey: OTHER_PERSON })).toMatchObject({ eligible: true });
  });

  test("transactional consent does not permit marketing enrolment", async () => {
    await consentService.record({
      companyId: COMPANY, gravPersonKey: PERSON,
      channel: "email", purpose: "transactional",
      state: "opted_in", capturedSource: "order confirmation preference", actor: ACTOR,
    });

    /* THE SPLIT THAT MATTERS. An order-confirmation address is not a marketing
       audience, and a lookup keyed on purpose cannot accidentally treat it as
       one. */
    expect(await resolve()).toMatchObject({ eligible: false, reasonCode: "CONSENT_MISSING" });
    expect(await resolve({ purpose: "transactional" })).toMatchObject({ eligible: true });
  });

  test("marketing consent does not grant another channel", async () => {
    await grant();
    expect(await resolve({ channel: "sms" })).toMatchObject({ eligible: false, reasonCode: "CONSENT_MISSING" });
  });

  test("the identity lookup resolves through MarketingIdentity and mints nothing", async () => {
    expect(await consentService.personKeyForEmail({ companyId: COMPANY, email: "nobody@example.in" })).toBeNull();
    await MarketingIdentity.create({ companyId: COMPANY, gravPersonKey: PERSON, email: "meera@aurorahotels.in" });
    expect(await consentService.personKeyForEmail({ companyId: COMPANY, email: "MEERA@aurorahotels.in" })).toBe(PERSON);
    /* Company-scoped, like everything else. */
    expect(await consentService.personKeyForEmail({ companyId: OTHER_COMPANY, email: "meera@aurorahotels.in" })).toBeNull();
    expect(await MarketingIdentity.countDocuments({})).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. APPEND-ONLY HISTORY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Every transition appends an immutable history entry", () => {
  test("each state change appends one entry, with from, to and revision", async () => {
    await grant();
    await consentService.withdraw({
      companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL, reason: "replied asking us to stop", actor: ACTOR,
    });
    await grant({ capturedSource: "came back via the website", capturedAt: new Date("2026-09-05T09:00:00Z") });

    const history = await consentService.historyFor({ companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL });
    expect(history).toHaveLength(3);
    expect(history.map((h) => [h.fromState, h.toState, h.revision])).toEqual([
      [null, "opted_in", 1],
      ["opted_in", "opted_out", 2],
      ["opted_out", "opted_in", 3],
    ]);

    const current = await MarketingConsent.findOne({ companyId: COMPANY, gravPersonKey: PERSON }).lean();
    expect(current.state).toBe("opted_in");
    /* The revision on the current row matches the history depth, so a silently
       rewritten row is detectable by arithmetic. */
    expect(current.revision).toBe(history.length);
  });

  test("history entries cannot be updated or deleted, through any mongoose door", async () => {
    await grant();
    const entry = await MarketingConsentHistory.findOne({});

    const filter = { _id: entry._id };
    await expect(MarketingConsentHistory.updateOne(filter, { $set: { toState: "opted_in" } }))
      .rejects.toThrow(APPEND_ONLY_MESSAGE);
    await expect(MarketingConsentHistory.updateMany({}, { $set: { toState: "opted_in" } }))
      .rejects.toThrow(APPEND_ONLY_MESSAGE);
    await expect(MarketingConsentHistory.findOneAndUpdate(filter, { $set: { reason: "x" } }))
      .rejects.toThrow(APPEND_ONLY_MESSAGE);
    await expect(MarketingConsentHistory.replaceOne(filter, { toState: "opted_in" }))
      .rejects.toThrow(APPEND_ONLY_MESSAGE);
    await expect(MarketingConsentHistory.deleteOne(filter)).rejects.toThrow(APPEND_ONLY_MESSAGE);
    await expect(MarketingConsentHistory.deleteMany({})).rejects.toThrow(APPEND_ONLY_MESSAGE);
    await expect(MarketingConsentHistory.findOneAndDelete(filter)).rejects.toThrow(APPEND_ONLY_MESSAGE);

    /* And re-saving a loaded document is an edit too. */
    entry.reason = "tampered";
    await expect(entry.save()).rejects.toThrow(APPEND_ONLY_MESSAGE);

    const after = await MarketingConsentHistory.findById(entry._id).lean();
    expect(after.toState).toBe("opted_in");
    expect(after.reason).toBe("");
  });

  test("a withdrawal records its timestamp, reason and actor", async () => {
    await grant();
    const before = new Date();
    await consentService.withdraw({
      companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL,
      reason: "unsubscribed from the September campaign", actor: ACTOR,
    });

    const row = await MarketingConsent.findOne({ companyId: COMPANY, gravPersonKey: PERSON }).lean();
    expect(row.state).toBe("opted_out");
    expect(row.withdrawnAt).toBeInstanceOf(Date);
    expect(row.withdrawnAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(row.withdrawalReason).toBe("unsubscribed from the September campaign");
    expect(row.recordedBy).toMatchObject({ name: "Nikhil Bose", kind: "user" });

    const entry = (await consentService.historyFor({ companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL })).pop();
    expect(entry).toMatchObject({ fromState: "opted_in", toState: "opted_out", reason: "unsubscribed from the September campaign" });
    expect(entry.recordedBy.name).toBe("Nikhil Bose");
  });

  test("a withdrawal with no reason is refused — a later review reads it", async () => {
    await grant();
    await expect(consentService.withdraw({
      companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL, actor: ACTOR,
    })).rejects.toMatchObject({ status: 400, details: { field: "reason" } });
    expect((await MarketingConsent.findOne({}).lean()).state).toBe("opted_in");
  });

  test("an opt-in after a withdrawal keeps the withdrawal on record", async () => {
    await grant();
    await consentService.withdraw({
      companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL, reason: "stop", actor: ACTOR,
    });
    await grant({ capturedSource: "re-subscribed on the website" });

    const row = await MarketingConsent.findOne({}).lean();
    expect(row.state).toBe("opted_in");
    /* NOT cleared. "They withdrew in March and returned in June" is the true
       story; blanking the first half tells a different one. */
    expect(row.withdrawnAt).toBeInstanceOf(Date);
    expect(row.withdrawalReason).toBe("stop");
  });

  test("a system act is attributed to the system, not to an invented person", async () => {
    await consentService.suppress({
      companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL,
      reason: "hard bounce from the mail provider", actor: null,
    });
    const row = await MarketingConsent.findOne({}).lean();
    expect(row.recordedBy).toMatchObject({ kind: "system", id: null, name: "" });
  });

  test("an actor cannot label an automatic act as somebody's decision", async () => {
    /* `kind` is derived from whether a person is named, never taken from the
       caller, so `kind: "user"` with nobody named cannot be asserted. */
    await consentService.suppress({
      companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL,
      reason: "complaint", actor: { kind: "user" },
    });
    expect((await MarketingConsent.findOne({}).lean()).recordedBy.kind).toBe("system");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. IDEMPOTENCY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Repeating a command does not duplicate history", () => {
  test("the same commandKey applies once", async () => {
    const key = "mautic-unsubscribe:evt-4411";
    const first = await consentService.withdraw({
      companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL,
      reason: "unsubscribed", actor: null, commandKey: key,
    });
    const second = await consentService.withdraw({
      companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL,
      reason: "unsubscribed", actor: null, commandKey: key,
    });

    expect(first).toMatchObject({ applied: true, duplicate: false });
    expect(second).toMatchObject({ applied: false, duplicate: true });
    expect(await MarketingConsentHistory.countDocuments({})).toBe(1);
    expect((await MarketingConsent.findOne({}).lean()).revision).toBe(1);
  });

  test("concurrent deliveries of one command settle to a single entry", async () => {
    const key = "mautic-unsubscribe:evt-race";
    const cmd = () => consentService.suppress({
      companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL,
      reason: "hard bounce", actor: null, commandKey: key,
    });
    const [a, b, c] = await Promise.all([cmd(), cmd(), cmd()]);

    /* Exactly one applied; the losers report the duplicate they lost to rather
       than a failure a retry sweep would repeat. */
    expect([a, b, c].filter((r) => r.applied)).toHaveLength(1);
    expect(await MarketingConsentHistory.countDocuments({})).toBe(1);
  });

  test("different commands on the same tuple each append", async () => {
    await grant({ commandKey: "cmd-1" });
    await consentService.withdraw({
      companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL,
      reason: "stop", actor: ACTOR, commandKey: "cmd-2",
    });
    expect(await MarketingConsentHistory.countDocuments({})).toBe(2);
  });

  test("a keyless no-op change appends nothing", async () => {
    await grant();
    const again = await grant();
    expect(again).toMatchObject({ applied: false, duplicate: false });
    expect(await MarketingConsentHistory.countDocuments({})).toBe(1);
  });

  test("the same key on a different person is a different command", async () => {
    await grant({ commandKey: "shared-key" });
    await consentService.record({
      companyId: COMPANY, gravPersonKey: OTHER_PERSON, ...EMAIL,
      state: "opted_in", capturedSource: "form", actor: ACTOR, commandKey: "shared-key",
    });
    expect(await MarketingConsentHistory.countDocuments({})).toBe(2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. THE GATE, AND WHAT IT PROTECTS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Nothing reaches Mautic without a recorded grant", () => {
  const ENV = {
    MAUTIC_BASE_URL: "http://localhost:8088",
    MAUTIC_AUTH_MODE: "basic",
    MAUTIC_BASIC_USERNAME: "u",
    MAUTIC_BASIC_PASSWORD: "p",
  };
  const clientWith = () => {
    const double = createMauticDouble();
    return { client: new MauticClient({ env: ENV, transport: { request: double.request } }), double };
  };
  const person = {
    firstName: "Meera", lastName: "Sharma", jobTitle: "Head of Procurement",
    workEmail: "meera@aurorahotels.in", companyName: "Aurora Hotels Pvt Ltd",
  };

  test("a recorded opt-in is projected, and the result says what permitted it", async () => {
    await grant();
    const { client, double } = clientWith();
    const out = await sync.syncContact({ client, companyId: COMPANY, gravPersonKey: PERSON, person });

    expect(out.created).toBe(true);
    expect(out.consent).toMatchObject({ state: "opted_in", revision: 1, noticeVersion: "v3" });
    /* The summary carries no capture evidence — a caller has no reason to hold
       it, and returning it would spread personal data for convenience. */
    expect(out.consent.capturedSource).toBeUndefined();
    expect(out.consent.evidenceRef).toBeUndefined();
    expect(double.state.contacts.size).toBe(1);
  });

  test("the gate refuses before Mautic is touched, for every ineligible state", async () => {
    const cases = [
      [null, "CONSENT_MISSING"],
      [{ state: "unknown" }, "CONSENT_UNKNOWN"],
      [{ state: "opted_out", reason: "stop" }, "CONSENT_WITHDRAWN"],
      [{ state: "suppressed", reason: "bounce" }, "CONSENT_SUPPRESSED"],
    ];
    for (const [write, reasonCode] of cases) {
      await MarketingConsent.deleteMany({});
      if (write) {
        await consentService.record({
          companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL,
          capturedSource: "test", actor: ACTOR, ...write,
        });
      }
      const { client, double } = clientWith();
      await expect(sync.syncContact({ client, companyId: COMPANY, gravPersonKey: PERSON, person }))
        .rejects.toMatchObject({
          status: 403, code: "MARKETING_CONSENT_INELIGIBLE",
          details: expect.objectContaining({ reasonCode }),
        });
      /* Never created and rolled back: never called. */
      expect(double.state.calls).toHaveLength(0);
      expect(double.state.contacts.size).toBe(0);
    }
  });

  test("a forged caller-supplied consent object cannot bypass the resolver", async () => {
    /* With NO record present. If the parameter were merely ignored this would
       fail 403 for a missing grant — which passes a laxer test while leaving
       callers believing they can grant permission. It must fail 400, naming the
       parameter and saying where consent comes from. */
    const { client, double } = clientWith();
    const err = await sync.syncContact({
      client, companyId: COMPANY, gravPersonKey: PERSON, person,
      consent: { state: "opted_in", emailConsent: "opted_in", suppressed: false },
    }).catch((e) => e);

    expect(err).toMatchObject({
      status: 400, code: "MARKETING_CONSENT_CALLER_SUPPLIED", details: { field: "consent" },
    });
    expect(err.message).toContain("marketingConsent.service.js");
    expect(double.state.calls).toHaveLength(0);
    expect(await MarketingConsent.countDocuments({})).toBe(0);
  });

  test("a cross-company person cannot be projected into this company's Mautic", async () => {
    await consentService.record({
      companyId: OTHER_COMPANY, gravPersonKey: PERSON, ...EMAIL,
      state: "opted_in", capturedSource: "their form", actor: ACTOR,
    });
    const { client, double } = clientWith();
    await expect(sync.syncContact({ client, companyId: COMPANY, gravPersonKey: PERSON, person }))
      .rejects.toMatchObject({ details: expect.objectContaining({ reasonCode: "CONSENT_MISSING" }) });
    expect(double.state.calls).toHaveLength(0);
  });

  test("transactional consent alone cannot get a person into Mautic", async () => {
    await consentService.record({
      companyId: COMPANY, gravPersonKey: PERSON,
      channel: "email", purpose: "transactional",
      state: "opted_in", capturedSource: "order preferences", actor: ACTOR,
    });
    const { client, double } = clientWith();
    await expect(sync.syncContact({ client, companyId: COMPANY, gravPersonKey: PERSON, person }))
      .rejects.toMatchObject({ details: expect.objectContaining({ reasonCode: "CONSENT_MISSING" }) });
    expect(double.state.calls).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   7. THE SALES BOUNDARY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Consent touches no Sales record", () => {
  test("recording, withdrawing and projecting create no Sales lifecycle record", async () => {
    await grant();
    await consentService.withdraw({
      companyId: COMPANY, gravPersonKey: PERSON, ...EMAIL, reason: "stop", actor: ACTOR,
    });
    await grant({ capturedSource: "returned" });

    const double = createMauticDouble();
    const client = new MauticClient({
      env: { MAUTIC_BASE_URL: "http://localhost:8088", MAUTIC_AUTH_MODE: "basic", MAUTIC_BASIC_USERNAME: "u", MAUTIC_BASIC_PASSWORD: "p" },
      transport: { request: double.request },
    });
    await sync.syncContact({
      client, companyId: COMPANY, gravPersonKey: PERSON,
      person: { firstName: "Meera", workEmail: "meera@aurorahotels.in" },
    });

    expect(await Lead.countDocuments({})).toBe(0);
    expect(await Enquiry.countDocuments({})).toBe(0);
    expect(await SalesJourney.countDocuments({})).toBe(0);
    expect(await Account.countDocuments({})).toBe(0);
    expect(await Contact.countDocuments({})).toBe(0);
  });

  test("the consent service never loads a Sales model", () => {
    /* The structural half: if this fails, somebody has given the consent record
       a reason to know about a Lead, and no behavioural test would catch it. */
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "services", "marketing", "marketingConsent.service.js"), "utf8");
    expect(src).not.toMatch(/require\([^)]*Sales\//);
    expect(src).not.toMatch(/require\([^)]*lead/i);
  });

  test("the consent record holds nothing a person could be identified by", async () => {
    await grant();
    const row = await MarketingConsent.findOne({}).lean();
    /* No name, no email, no company name. Reading one requires the identity row
       that owns the key, which is what stops this becoming a second person
       master. */
    for (const forbidden of ["email", "firstName", "lastName", "name", "phone", "company"]) {
      expect(row[forbidden]).toBeUndefined();
    }
    expect(row.gravPersonKey).toBe(PERSON);
  });
});
