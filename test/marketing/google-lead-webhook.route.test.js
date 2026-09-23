// test/marketing/google-lead-webhook.route.test.js
//
// THE ONE DOOR A STRANGER MAY KNOCK ON.
//
// ── WHY THIS FILE IS MOSTLY ABOUT THE TRUST ORDER ──────────────────────────
// Every other Marketing route knows who is calling before it does anything.
// This one cannot: Google holds no session and has never heard of a GRAV
// company. So the trust is assembled from the request, in a fixed order, and
// almost every test below is about something that must not happen before the
// step that earns it.
//
// The failure that matters most is not a forged lead — it is a lead landing in
// the wrong company. `campaign_id` and `form_id` are values a sender chooses.
// If either could select a tenant, anybody who guessed a campaign number could
// post enquiries into that company's Marketing records, and the records would
// look entirely ordinary.
"use strict";

const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const {
  MarketingLeadDeliveryBinding,
} = require("../../models/CMS_Models/Marketing/MarketingLeadDeliveryBinding");
const {
  MarketingAdvertisingLead,
  MarketingAdvertisingLeadTest,
} = require("../../models/CMS_Models/Marketing/MarketingAdvertisingLead");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const MarketingEventReceipt = require("../../models/CMS_Models/Marketing/MarketingEventReceipt");
const ProspectHandover = require("../../models/CMS_Models/Marketing/ProspectHandover");

const bindings = require("../../services/marketing/leads/leadDeliveryBinding.service");
const tokens = require("../../services/marketing/leads/deliveryToken");
const keys = require("../../services/marketing/leads/leadWebhookKey");

const MASTER = crypto.randomBytes(32).toString("hex");
const ENV_KEYS = ["MARKETING_CHANNEL_ID_SECRET", "MARKETING_GOOGLE_LEAD_WEBHOOK_MASTER_SECRET_V1"];
const saved = {};

let app; let server; let base; let A; let B;
let seq = 0;
const fresh = (p) => `${p}-${Date.now()}-${(seq += 1)}`;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  app = express();
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/googleLeadWebhook"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  A = (await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") }))._id;
  B = (await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") }))._id;
  process.env.MARKETING_CHANNEL_ID_SECRET = "a-deployment-secret-long-enough";
  process.env.MARKETING_GOOGLE_LEAD_WEBHOOK_MASTER_SECRET_V1 = MASTER;
});

const plan = (companyId) => ({
  _id: new mongoose.Types.ObjectId(),
  draftRef: fresh("MCP"),
  revision: 3,
  companyId,
});

async function prepareBinding(companyId, over = {}) {
  const p = plan(companyId);
  const view = await bindings.prepare({
    companyId, plan: p, idempotencyKey: fresh("idem"),
    actor: { id: new mongoose.Types.ObjectId(), name: "Ada" }, ...over,
  });
  const row = await MarketingLeadDeliveryBinding
    .findOne({ companyId, bindingRef: view.__bindingRef }).select("+providerFormId");
  return { view, row, plan: p };
}

const keyFor = (row) => keys.deriveWebhookKey({
  companyId: String(row.companyId), bindingId: row.bindingRef, version: row.secretVersion,
});

/* Google's official production sample, with the secret and ids substituted. */
const sample = (secret, over = {}) => ({
  lead_id: over.lead_id || fresh("Cj0KCQ"),
  campaign_id: 123456,
  gcl_id: "Cj0KCQjwit_8BRCoARIsAIx3Rj7g-AeL",
  user_column_data: [
    { column_name: "Full Name", string_value: "John Doe", column_id: "FULL_NAME" },
    { column_name: "User Phone", string_value: "+11234567890", column_id: "PHONE_NUMBER" },
  ],
  api_version: "1.0",
  form_id: 1234,
  google_key: secret,
  ...over,
});

const post = async (token, body, { raw = null, contentType = "application/json" } = {}) => {
  const res = await fetch(`${base}/google-leads/${token}`, {
    method: "POST",
    headers: contentType ? { "Content-Type": contentType } : {},
    body: raw !== null ? raw : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
};

/* ═══════════════════════════════════════════════════════════════════════════
   1. THE BINDING
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the delivery binding", () => {
  test("1. preparing is idempotent, and a changed command under one key conflicts", async () => {
    const p = plan(A);
    const key = fresh("idem");

    const first = await bindings.prepare({ companyId: A, plan: p, idempotencyKey: key });
    const again = await bindings.prepare({ companyId: A, plan: p, idempotencyKey: key });

    /* ── A RETRY IS SAFE ─────────────────────────────────────────────────
       A second address for one form would mean Google posting to one while
       GRAV waited on the other. */
    expect(again.deliveryToken).toBe(first.deliveryToken);
    expect(await MarketingLeadDeliveryBinding.countDocuments({ companyId: A })).toBe(1);

    /* ── AND A DIFFERENT REQUEST UNDER THE SAME KEY IS NOT A RETRY ───────
       Answering with the first binding would hand back an address for a
       different revision than the caller named, invisibly. */
    await expect(bindings.prepare({
      companyId: A, plan: { ...p, revision: 4 }, idempotencyKey: key,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("2. the token resolves to exactly one binding and names nothing", async () => {
    const { view, row } = await prepareBinding(A);

    const resolved = await bindings.resolveForDelivery(view.deliveryToken);
    expect(String(resolved._id)).toBe(String(row._id));
    expect(String(resolved.companyId)).toBe(String(A));

    /* ── THE TOKEN IS AN ADDRESS, NOT A DISCLOSURE ───────────────────────
       It sits in Google's form configuration, visible to anybody who can open
       that advertising account. It must not also tell them the company's
       database id or a campaign number. */
    const decoded = Buffer.from(view.deliveryToken.split(".")[1], "base64url").toString("utf8");
    expect(decoded).not.toContain(String(row._id));
    expect(decoded).not.toContain("1234");
    expect(view.deliveryToken).not.toContain(String(row._id));
  });

  test("3. a forged, malformed or foreign token resolves to nothing", async () => {
    const { view } = await prepareBinding(A);
    const good = view.deliveryToken;

    const forged = `gld1.${Buffer.from(JSON.stringify({ c: String(B), b: "anything" })).toString("base64url")}.${good.split(".")[2]}`;

    for (const token of [
      `${good.slice(0, -1)}X`,        // tampered signature
      good.replace("gld1", "gld9"),   // wrong version
      forged,                          // another company spliced in
      "nonsense", "", "a.b.c",
    ]) {
      expect(await bindings.resolveForDelivery(token)).toBeNull();
    }
  });

  test("4. a binding stores no secret, and provider ids are strings", async () => {
    const { row } = await prepareBinding(A);
    await bindings.attachProviderIdentity({
      companyId: A, bindingRef: row.bindingRef,
      providerFormId: "22300000000000000001", providerCampaignId: "998877665544332211",
    });

    const stored = await MarketingLeadDeliveryBinding
      .findOne({ companyId: A }).select("+providerFormId +providerCampaignId").lean();

    /* ── INT64 KEPT ITS DIGITS ───────────────────────────────────────────
       A Mongo Number is a double; an id this size would come back altered. */
    expect(typeof stored.providerFormId).toBe("string");
    expect(stored.providerFormId).toBe("22300000000000000001");
    expect(stored.providerCampaignId).toBe("998877665544332211");

    /* And nothing secret is on the row. */
    const flat = JSON.stringify(stored);
    expect(flat).not.toContain(MASTER);
    expect(flat).not.toContain(keyFor(row));
    expect(stored).not.toHaveProperty("webhookKey");
    expect(stored).not.toHaveProperty("deliveryToken");
    expect(stored.secretVersion).toBe(1);
  });

  test("5. the public view carries no provider identifier", async () => {
    const { row, view } = await prepareBinding(A);
    await bindings.attachProviderIdentity({
      companyId: A, bindingRef: row.bindingRef, providerFormId: "1234", providerCampaignId: "123456",
    });

    const refreshed = await MarketingLeadDeliveryBinding
      .findOne({ companyId: A }).select("+providerFormId +providerCampaignId");
    const publicView = refreshed.publicView(view.deliveryToken);

    /* The FACT that correlation is confirmed, never the identifiers. */
    expect(publicView.correlationConfirmed).toBe(true);
    const flat = JSON.stringify(publicView);
    expect(flat).not.toContain("1234");
    expect(flat).not.toContain("123456");
    expect(flat).not.toMatch(/"_id"|providerFormId|providerCampaignId/);
  });

  test("6. another company's binding cannot be reached or rebound", async () => {
    const { row } = await prepareBinding(A);

    await expect(bindings.attachProviderIdentity({
      companyId: B, bindingRef: row.bindingRef, providerFormId: "1234",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(bindings.disable({
      companyId: B, bindingRef: row.bindingRef, reason: "not mine",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    /* And a form already bound cannot be silently repointed — two forms on one
       address means leads from both arrive as one campaign's. */
    await bindings.attachProviderIdentity({ companyId: A, bindingRef: row.bindingRef, providerFormId: "1234" });
    await expect(bindings.attachProviderIdentity({
      companyId: A, bindingRef: row.bindingRef, providerFormId: "9999",
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("7. disabling keeps the evidence", async () => {
    const { row } = await prepareBinding(A);
    await bindings.disable({ companyId: A, bindingRef: row.bindingRef, reason: "Campaign finished." });

    const after = await MarketingLeadDeliveryBinding.findOne({ companyId: A });
    expect(after.state).toBe("disabled");
    expect(after.disabledReason).toBe("Campaign finished.");
    expect(await MarketingLeadDeliveryBinding.countDocuments({ companyId: A })).toBe(1);

    /* A reason is required — "disabled by somebody, at some point" is not
       evidence about the leads that arrived through it. */
    const { row: other } = await prepareBinding(A);
    await expect(bindings.disable({ companyId: A, bindingRef: other.bindingRef, reason: "" }))
      .rejects.toMatchObject({ code: "VALIDATION" });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. THE TRUST ORDER
   ═══════════════════════════════════════════════════════════════════════════ */

describe("what the webhook believes, and when", () => {
  test("8. an official production sample is accepted and recorded once", async () => {
    const { view, row, plan: p } = await prepareBinding(A);
    const res = await post(view.deliveryToken, sample(keyFor(row)));

    /* Google's documented success: 200 with an empty object. Not
       `{success:true}` — its table says `{}`. */
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});

    const lead = await MarketingAdvertisingLead
      .findOne({ companyId: A }).select("+providerSubmissionId +providerCampaignId +providerFormId").lean();

    expect(lead).toBeTruthy();
    expect(lead.classification).toBe("production");
    expect(lead.ingestionOrigin).toBe("delivery");
    expect(lead.contact.fullName).toBe("John Doe");
    expect(lead.contact.phone).toBe("+11234567890");
    expect(lead.draftRef).toBe(p.draftRef);
    expect(lead.approvedRevision).toBe(3);
    expect(String(lead.bindingId)).toBe(String(row._id));
    expect(lead.submissionRef).toMatch(/^MLS-/);
  });

  test("9. a forged or unknown token is refused before anything is read", async () => {
    const { row } = await prepareBinding(A);
    const good = keyFor(row);

    for (const token of ["nonsense", "gld1.x.y", ""]) {
      const res = await post(token || "-", sample(good));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(await MarketingAdvertisingLead.countDocuments({})).toBe(0);
  });

  test("10. a wrong, missing or conflicting key is refused permanently", async () => {
    const { view, row } = await prepareBinding(A);
    const good = keyFor(row);

    const wrong = await post(view.deliveryToken, sample("not-the-key"));
    expect(wrong.status).toBe(403);
    expect(wrong.body.message).toBeTruthy();

    const missing = await post(view.deliveryToken, { ...sample(good), google_key: undefined });
    expect(missing.status).toBe(403);

    /* ── BOTH SPELLINGS, DIFFERENT VALUES ────────────────────────────────
       Not something Google sends. It is somebody trying one of each to
       discover which one GRAV checks. */
    const conflicting = await post(view.deliveryToken, { ...sample(good), Google_key: "something-else" });
    expect(conflicting.status).toBeGreaterThanOrEqual(400);
    expect(conflicting.status).toBeLessThan(500);

    /* 4XX throughout: a wrong key will not become right on a retry, and
       telling Google to keep trying would have it redeliver for days. */
    expect(await MarketingAdvertisingLead.countDocuments({})).toBe(0);

    /* The same spelling twice with the SAME value is fine. */
    const sameBoth = await post(view.deliveryToken, { ...sample(good), Google_key: good });
    expect(sameBoth.status).toBe(200);
  });

  test("11. Google's own capitalised spelling is accepted", async () => {
    const { view, row } = await prepareBinding(A);
    const payload = sample(keyFor(row));
    delete payload.google_key;
    payload.Google_key = keyFor(row);

    /* Every official TEST sample spells it this way while the production one
       is lowercase. Refusing it would refuse Google's own documentation. */
    const res = await post(view.deliveryToken, payload);
    expect(res.status).toBe(200);
  });

  test("12. a payload cannot choose its company", async () => {
    const { view: viewA, row: rowA } = await prepareBinding(A);
    const { row: rowB } = await prepareBinding(B);
    await bindings.attachProviderIdentity({ companyId: B, bindingRef: rowB.bindingRef, providerFormId: "777777" });

    /* ── THE FAILURE THAT MATTERS MOST ───────────────────────────────────
       A delivery to A's address, correctly signed for A, naming B's form and
       campaign. If a payload value could select a tenant, anybody who guessed
       a campaign number could post enquiries into that company. */
    const res = await post(viewA.deliveryToken, sample(keyFor(rowA), {
      form_id: 777777, campaign_id: 999999, companyId: String(B),
    }));
    expect(res.status).toBe(200);

    expect(await MarketingAdvertisingLead.countDocuments({ companyId: B })).toBe(0);
    const lead = await MarketingAdvertisingLead.findOne({ companyId: A }).lean();
    expect(lead).toBeTruthy();
    expect(String(lead.companyId)).toBe(String(A));

    /* And B's key does not open A's address. */
    const cross = await post(viewA.deliveryToken, sample(keyFor(rowB)));
    expect(cross.status).toBe(403);
  });

  test("13. a delivery for a different form than this address is refused", async () => {
    const { view, row } = await prepareBinding(A);
    await bindings.attachProviderIdentity({ companyId: A, bindingRef: row.bindingRef, providerFormId: "1234" });
    const bound = await MarketingLeadDeliveryBinding.findOne({ companyId: A }).select("+providerFormId");

    const res = await post(view.deliveryToken, sample(keyFor(bound), { form_id: 5678 }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await MarketingAdvertisingLead.countDocuments({})).toBe(0);

    /* The correct form is accepted. */
    expect((await post(view.deliveryToken, sample(keyFor(bound), { form_id: 1234 }))).status).toBe(200);
  });

  test("14. a disabled binding refuses permanently", async () => {
    const { view, row } = await prepareBinding(A);
    await bindings.disable({ companyId: A, bindingRef: row.bindingRef, reason: "Finished." });

    const res = await post(view.deliveryToken, sample(keyFor(row)));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await MarketingAdvertisingLead.countDocuments({})).toBe(0);
  });

  test("15. a non-JSON or oversized body is refused", async () => {
    const { view, row } = await prepareBinding(A);

    expect((await post(view.deliveryToken, null, { raw: "not json" })).status).toBe(400);
    expect((await post(view.deliveryToken, null, { raw: "[]" })).status).toBe(400);
    expect((await post(view.deliveryToken, sample(keyFor(row)), { contentType: "text/plain" })).status).toBe(400);

    /* A body far past the limit is refused rather than parsed into memory. */
    const huge = JSON.stringify({ ...sample(keyFor(row)), padding: "x".repeat(200000) });
    const res = await post(view.deliveryToken, null, { raw: huge });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await MarketingAdvertisingLead.countDocuments({})).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. THE RECORD
   ═══════════════════════════════════════════════════════════════════════════ */

describe("what is written", () => {
  test("16. an int64 identifier above JavaScript's safe range keeps every digit", async () => {
    const { view, row } = await prepareBinding(A);
    const big = "22300000000000000001";

    /* ── THE SILENT ONE ──────────────────────────────────────────────────
       An ordinary parse turns this into a nearby number without complaining,
       and the correlation it exists for then matches nothing. */
    expect(String(Number(big))).not.toBe(big);

    const raw = JSON.stringify(sample(keyFor(row))).replace('"campaign_id":123456', `"campaign_id":${big}`);
    expect(raw).toContain(big);

    const res = await post(view.deliveryToken, null, { raw });
    expect(res.status).toBe(200);

    const lead = await MarketingAdvertisingLead.findOne({ companyId: A }).select("+providerCampaignId").lean();
    expect(lead.providerCampaignId).toBe(big);
  });

  test("17. the deprecated label is ignored and unknown columns are kept uninterpreted", async () => {
    const { view, row } = await prepareBinding(A);

    await post(view.deliveryToken, sample(keyFor(row), {
      user_column_data: [
        /* A label that lies, and a column with no label at all. */
        { column_name: "Postal Code", string_value: "mo@grav.in", column_id: "EMAIL" },
        { string_value: "Acme Ltd", column_id: "COMPANY_NAME" },
        { column_id: "JOB_ROLE", string_value: "Buyer" },
        { column_id: "PREFERRED_DEALERSHIP", column_name: "Select your preferred dealership", string_value: "North" },
      ],
      /* Google's own instruction: ignore properties you do not recognise. */
      lead_quality_score: 0.9,
      some_future_thing: { nested: true },
    }));

    const lead = await MarketingAdvertisingLead.findOne({ companyId: A }).lean();

    expect(lead.contact.email).toBe("mo@grav.in");
    expect(lead.contact.companyName).toBe("Acme Ltd");
    expect(lead.contact.postalCode).toBe("");

    /* An answer carries the question Google showed, and stays self-reported. */
    expect(lead.answers).toHaveLength(1);
    expect(lead.answers[0]).toMatchObject({
      code: "JOB_ROLE", question: "What is your job role?", answer: "Buyer", selfReported: true,
    });

    /* Unknown: kept, flagged, never mapped onto a GRAV field. */
    expect(lead.unmapped).toHaveLength(1);
    expect(lead.unmapped[0]).toMatchObject({ code: "PREFERRED_DEALERSHIP", needsReview: true });

    /* The deprecated label and the unknown top-level fields are not stored. */
    const flat = JSON.stringify(lead);
    expect(flat).not.toMatch(/column_name|Select your preferred dealership/);
    expect(flat).not.toMatch(/lead_quality_score|some_future_thing/);
  });

  test("18. no raw payload, secret, token or header is stored", async () => {
    const { view, row } = await prepareBinding(A);
    const secret = keyFor(row);
    await post(view.deliveryToken, sample(secret));

    const lead = await MarketingAdvertisingLead
      .findOne({ companyId: A }).select("+providerSubmissionId +providerCampaignId +providerFormId").lean();
    const flat = JSON.stringify(lead);

    expect(flat).not.toContain(secret);
    expect(flat).not.toContain(MASTER);
    expect(flat).not.toContain(view.deliveryToken);
    expect(flat).not.toMatch(/google_key|Google_key/i);
    expect(lead).not.toHaveProperty("rawPayload");
    expect(lead).not.toHaveProperty("headers");

    /* The provider ids are present as backend evidence and are `select:false`,
       so an ordinary read does not carry them anywhere. */
    const casual = await MarketingAdvertisingLead.findOne({ companyId: A }).lean();
    expect(casual).not.toHaveProperty("providerSubmissionId");
    expect(casual).not.toHaveProperty("providerCampaignId");
  });

  test("19. the record cannot be edited or deleted, including in bulk", async () => {
    const { view, row } = await prepareBinding(A);
    await post(view.deliveryToken, sample(keyFor(row)));
    const lead = await MarketingAdvertisingLead.findOne({ companyId: A });

    /* ── EVIDENCE THAT CAN BE EDITED IS NOT EVIDENCE ─────────────────────
       A `pre("save")` hook alone leaves every query path open, and a bulk
       operation is how a well-meaning migration edits a million rows. */
    await expect(MarketingAdvertisingLead.updateOne({ _id: lead._id }, { $set: { "contact.email": "x@y.z" } }))
      .rejects.toThrow(/append-only/i);
    await expect(MarketingAdvertisingLead.deleteOne({ _id: lead._id })).rejects.toThrow(/append-only/i);
    await expect(MarketingAdvertisingLead.findOneAndUpdate({ _id: lead._id }, { $set: { leadStage: "x" } }))
      .rejects.toThrow(/append-only/i);
    await expect(MarketingAdvertisingLead.updateMany({}, { $set: { leadStage: "x" } }))
      .rejects.toThrow(/append-only/i);

    await expect(MarketingAdvertisingLead.bulkWrite([
      { updateOne: { filter: { _id: lead._id }, update: { $set: { leadStage: "x" } } } },
    ])).rejects.toThrow(/append-only/i);
    await expect(MarketingAdvertisingLead.bulkWrite([
      { deleteOne: { filter: { _id: lead._id } } },
    ])).rejects.toThrow(/append-only/i);

    lead.leadStage = "changed";
    await expect(lead.save()).rejects.toThrow(/append-only/i);

    const unchanged = await MarketingAdvertisingLead.findOne({ companyId: A }).lean();
    expect(unchanged.contact.email).toBe("");
    expect(unchanged.leadStage).toBe("");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. DUPLICATES AND TESTS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("duplicates and test deliveries", () => {
  test("20. a repeated delivery answers 200, creates nothing, and changes nothing", async () => {
    const { view, row } = await prepareBinding(A);
    const payload = sample(keyFor(row));

    expect((await post(view.deliveryToken, payload)).status).toBe(200);
    const first = await MarketingAdvertisingLead.findOne({ companyId: A }).lean();

    for (let i = 0; i < 3; i += 1) {
      const again = await post(view.deliveryToken, payload);
      /* ── 200, OR GOOGLE KEEPS REDELIVERING ──────────────────────────────
         Delivery is at-least-once by design; a duplicate is ordinary, not an
         error, and answering anything else asks for it again. */
      expect(again.status).toBe(200);
      expect(again.body).toEqual({});
    }

    expect(await MarketingAdvertisingLead.countDocuments({ companyId: A })).toBe(1);

    const after = await MarketingAdvertisingLead.findOne({ companyId: A }).lean();
    /* No timestamp moved — a replay must not even look like activity. */
    expect(after.receivedAt).toEqual(first.receivedAt);
    expect(after.updatedAt).toEqual(first.updatedAt);
    expect(after.submissionRef).toBe(first.submissionRef);
  });

  test("21. a changed payload under an existing lead id cannot rewrite the evidence", async () => {
    const { view, row } = await prepareBinding(A);
    const secret = keyFor(row);
    const leadId = fresh("Cj0KCQ");

    await post(view.deliveryToken, sample(secret, { lead_id: leadId }));

    /* ── A REPLAY WITH EDITS IS NOT A CORRECTION ─────────────────────────
       Anybody who has seen one body holds a replayable one, because the
       verification is a shared secret rather than a signature. If a second
       delivery could overwrite the first, they could rewrite what somebody
       typed. */
    const tampered = await post(view.deliveryToken, sample(secret, {
      lead_id: leadId,
      user_column_data: [{ column_id: "EMAIL", string_value: "attacker@example.com" }],
    }));
    expect(tampered.status).toBe(200);

    const lead = await MarketingAdvertisingLead.findOne({ companyId: A }).lean();
    expect(lead.contact.email).toBe("");
    expect(lead.contact.fullName).toBe("John Doe");
    expect(await MarketingAdvertisingLead.countDocuments({ companyId: A })).toBe(1);
  });

  test("22. the same lead id in two companies makes two independent records", async () => {
    const { view: viewA, row: rowA } = await prepareBinding(A);
    const { view: viewB, row: rowB } = await prepareBinding(B);
    const sharedId = fresh("Cj0KCQ");

    expect((await post(viewA.deliveryToken, sample(keyFor(rowA), { lead_id: sharedId }))).status).toBe(200);
    expect((await post(viewB.deliveryToken, sample(keyFor(rowB), { lead_id: sharedId }))).status).toBe(200);

    /* The deduplication fence is company-first, so one company's id cannot
       block another's. */
    expect(await MarketingAdvertisingLead.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingAdvertisingLead.countDocuments({ companyId: B })).toBe(1);

    const a = await MarketingAdvertisingLead.findOne({ companyId: A }).lean();
    const b = await MarketingAdvertisingLead.findOne({ companyId: B }).lean();
    expect(a.submissionRef).not.toBe(b.submissionRef);
  });

  test("23. an official test delivery is noted, with no person in it", async () => {
    const { view, row } = await prepareBinding(A);
    const secret = keyFor(row);

    /* Google's official test sample: `Google_key`, capital G, plus is_test. */
    const testPayload = sample(secret, { is_test: true });
    delete testPayload.google_key;
    testPayload.Google_key = secret;

    const res = await post(view.deliveryToken, testPayload);
    expect(res.status).toBe(200);

    /* ── NOT ONE PRODUCTION ROW ──────────────────────────────────────────
       Somebody in Sales must never end up ringing "John Doe". */
    expect(await MarketingAdvertisingLead.countDocuments({})).toBe(0);

    const noted = await MarketingAdvertisingLeadTest
      .findOne({ companyId: A }).select("+providerSubmissionId").lean();
    expect(noted).toBeTruthy();
    expect(noted.verified).toBe(true);
    expect(noted.classification).toBe("test");
    expect(String(noted.bindingId)).toBe(String(row._id));
    expect(noted.apiVersion).toBe("1.0");

    /* ── FOUR FACTS AND NO PERSON ────────────────────────────────────────
       The sample name and phone are dropped before the write, not stored and
       filtered later — a filter is something a future query can forget. */
    const flat = JSON.stringify(noted);
    expect(flat).not.toMatch(/John Doe|11234567890|@/);
    expect(noted).not.toHaveProperty("contact");
    expect(noted).not.toHaveProperty("answers");

    /* A repeated test press is idempotent too. */
    await post(view.deliveryToken, testPayload);
    expect(await MarketingAdvertisingLeadTest.countDocuments({ companyId: A })).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. WHERE THIS CHUNK STOPS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the boundary of this chunk", () => {
  test("24. the webhook itself reaches nothing downstream, and never Sales", async () => {
    const Lead = require("../../models/CMS_Models/Sales/Lead");
    const Activity = require("../../models/CMS_Models/Sales/Activity");

    const before = await Promise.all([
      ProspectHandover.countDocuments({}), Lead.countDocuments({}), Activity.countDocuments({}),
    ]);

    const { view, row } = await prepareBinding(A);
    await post(view.deliveryToken, sample(keyFor(row)));
    expect(await MarketingAdvertisingLead.countDocuments({ companyId: A })).toBe(1);

    const after = await Promise.all([
      ProspectHandover.countDocuments({}), Lead.countDocuments({}), Activity.countDocuments({}),
    ]);

    /* ── THE BOUNDARY THAT SURVIVES CHUNK 3B ─────────────────────────────
       Identity and engagement ARE created now — by the deferred processor, on
       its own schedule — so counting them here would be a race rather than an
       assertion. What must never happen, at any point, is a Sales record or a
       handover: those belong to the existing qualification contract, and
       nothing in the lead path may reach them.

       The identity and engagement guarantees are proved properly in
       `google-lead-processing.test.js`, where the processor is run
       deliberately rather than raced. */
    expect(after).toEqual(before);
  });

  test("25. the ingestion path imports nothing downstream", () => {
    const fs = require("fs");
    const path = require("path");
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    for (const rel of [
      "services/marketing/leads/leadIngestion.service.js",
      "routes/CMS_Routes/Marketing/googleLeadWebhook.js",
    ]) {
      const src = strip(fs.readFileSync(path.join(__dirname, "../..", rel), "utf8"));
      /* The route may hand a recorded submission to the processor; neither
         may reach a handover or anything in Sales. */
      expect({ rel, m: /prospectHandover|handoverReadModel|salesOutcomeIntake/.test(src) })
        .toEqual({ rel, m: false });
      expect({ rel, m: /require\(["'].*(Sales\/|\/Lead|\/Enquiry)/.test(src) }).toEqual({ rel, m: false });
      expect({ rel, m: /googleAdsClient|AdsWriteClient|pausedCreation/.test(src) }).toEqual({ rel, m: false });
    }

    const ingestion = require("../../services/marketing/leads/leadIngestion.service");
    expect(ingestion.NOT_IN_THIS_CHUNK).toEqual(expect.arrayContaining([
      "identity_resolution", "engagement", "consent", "prospect_handover",
      "sales_record", "api_reconciliation", "campaign_creation",
    ]));
  });

  test("26. google_lead_form is still not deployable, and Meta's never was", () => {
    const caps = require("../../constants/marketingCampaignCapabilities");
    expect(caps.DEPLOYABLE_CAMPAIGN_TYPES).toEqual(["google_search", "meta_traffic_single_image"]);
    expect(caps.CAMPAIGN_TYPE_BY_CODE.google_lead_form.deployable).toBe(false);
    expect(caps.CAMPAIGN_TYPE_BY_CODE.meta_lead_form.deployable).toBe(false);
  });

  test("27. a GRAV fault is retryable and says nothing about itself", async () => {
    const { view, row } = await prepareBinding(A);

    /* A database that is briefly unavailable must not lose a real enquiry, so
       Google is told to try again — and told nothing else. */
    const spy = jest.spyOn(MarketingAdvertisingLead, "create")
      .mockRejectedValue(new Error("E11000-ish driver detail: marketing_advertising_leads index foo"));

    const res = await post(view.deliveryToken, sample(keyFor(row)));
    expect(res.status).toBeGreaterThanOrEqual(500);

    const flat = JSON.stringify(res.body);
    expect(flat).not.toMatch(/marketing_advertising_leads|E11000|index|driver/i);
    expect(flat).not.toContain(MASTER);
    expect(res.body.message).toBeTruthy();

    spy.mockRestore();
  });
});
