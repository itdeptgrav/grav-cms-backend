#!/usr/bin/env node
//
// scripts/marketing/mautic-round-trip.js
//
// THE CHUNK 0 PROOF.
//
//   node -r dotenv/config scripts/marketing/mautic-round-trip.js             # LIVE
//   node -r dotenv/config scripts/marketing/mautic-round-trip.js --synthetic # contract only
//   node -r dotenv/config scripts/marketing/mautic-round-trip.js --cleanup
//
// ── THE NINE STEPS ─────────────────────────────────────────────────────────
//   1  one synthetic, consented GRAV person
//   2  create-or-update the Mautic contact, idempotently
//   3  the GRAV-person ↔ Mautic-contact mapping, and grav_person_key IN Mautic
//   4  enrolment in one test segment, proved by reading membership back
//   5  one campaign email, delivered into the local mail sink and nowhere else
//   6  a REAL signed Mautic webhook, caused by opening that email
//   7  recorded exactly once in the immutable ledger
//   8  the same payload replayed, and no second row
//   9  no Active Lead, Pipeline opportunity, quotation, customer or order
//
// ── LIVE MODE NEEDS THE LISTENER ───────────────────────────────────────────
// Mautic must have somewhere to POST. `scripts/marketing/mautic-webhook-listener.js`
// mounts the real Marketing router against a disposable database and publishes
// its connection details to a handoff file; this script reads that file so both
// halves look at the same ledger. Start the listener first:
//
//   node -r dotenv/config scripts/marketing/mautic-webhook-listener.js &
//
// Steps 5 and 6 authenticate as the Mautic ADMIN, from deploy/mautic/.env,
// because sending an email is deliberately outside what GRAV's least-privilege
// integration user may do. GRAV's own steps use GRAV's own credentials.
//
// ── WHAT A SYNTHETIC RUN IS WORTH ──────────────────────────────────────────
// `--synthetic` runs against the local contract double. That proves the
// recorded contract and is NOT evidence a live Mautic works, so it exits 64
// rather than 0 and says so on every run. A green synthetic run reported as a
// live integration is the failure this script exists to prevent.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const mongoose = require("mongoose");
const os = require("os");
const path = require("path");

const { MauticClient } = require("../../services/marketing/mauticClient");
const { createMauticDouble } = require("../../services/marketing/mauticTestDouble");
const sync = require("../../services/marketing/mauticContactSync.service");
const consentService = require("../../services/marketing/marketingConsent.service");
const health = require("../../services/marketing/mauticHealth.service");
const contract = require("../../services/marketing/mauticWebhookContract");
const eventIntake = require("../../services/marketing/mauticEventIntake.service");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const { MarketingIntentEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../models/CMS_Models/Sales/Account");

const SYNTHETIC = process.argv.includes("--synthetic");
const CLEANUP = process.argv.includes("--cleanup");

const HANDOFF = path.join(os.tmpdir(), "grav-marketing-listener.json");
const MAILSINK = process.env.MAILSINK_URL || "http://127.0.0.1:8025";

/* deploy/mautic/.env, read with a compose-style parser and never by sourcing it
   in a shell: a value containing * ? [ ] ( ) { } or ! is glob-expanded there,
   and an unterminated bracket pattern swallows the rest of the file into the
   variable. That is not hypothetical — it is how this stack was first installed
   with a 205-character multi-line admin password. */
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out[t.slice(0, i).trim()] = t.slice(i + 1);
  }
  return out;
}
const stackEnv = readEnvFile(path.join(__dirname, "..", "..", "deploy", "mautic", ".env"));

const RUN = crypto.randomBytes(4).toString("hex");
const PERSON = {
  firstName: "Chunk0",
  lastName: `Probe${RUN}`,
  jobTitle: "Head of Procurement",
  /* `.invalid` is reserved by RFC 2606 and can never be delivered to. Even with
     the mail sink misconfigured, this address cannot reach a real person. */
  workEmail: `chunk0.probe.${RUN}@grav-integration-test.invalid`,
  workPhone: "9000000000",
  companyName: "GRAV Integration Test Ltd",
  website: "https://grav-integration-test.invalid",
  country: "India",
};

const results = [];
const record = (step, state, detail = "") => {
  results.push({ step, state, detail });
  console.log(`  [${String(state).padEnd(6)}] ${step}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function adminApi(method, route, body) {
  const base = (process.env.MAUTIC_BASE_URL || "http://localhost:8088").replace(/\/+$/, "");
  const creds = `${stackEnv.MAUTIC_ADMIN_USERNAME}:${stackEnv.MAUTIC_ADMIN_PASSWORD}`;
  const res = await fetch(base + route, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(creds).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}

async function main() {
  console.log(`\nMautic Chunk 0 round trip — run ${RUN}`);
  console.log(SYNTHETIC
    ? "MODE: SYNTHETIC. This proves the recorded contract, NOT a live Mautic.\n"
    : "MODE: LIVE. Every step below talks to the configured Mautic instance.\n");

  /* In synthetic mode the CLIENT is real and only its transport is replaced, so
     what runs is the production request shapes, status handling, retry rule and
     error mapping — not a mock of them. */
  const env = SYNTHETIC
    ? {
      MAUTIC_BASE_URL: "http://localhost:8088",
      MAUTIC_AUTH_MODE: "basic",
      MAUTIC_BASIC_USERNAME: "synthetic",
      MAUTIC_BASIC_PASSWORD: "synthetic",
      MAUTIC_WEBHOOK_SECRET: "synthetic",
    }
    : process.env;

  let listener = null;
  let companyId;
  let mongoUri;

  if (SYNTHETIC) {
    companyId = process.env.MARKETING_COMPANY_ID;
    mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
    if (!companyId) throw new Error("MARKETING_COMPANY_ID is not set.");
  } else {
    if (!fs.existsSync(HANDOFF)) {
      throw new Error(
        "The webhook listener is not running. Mautic needs somewhere to POST.\n"
        + "  Start it first:  node -r dotenv/config scripts/marketing/mautic-webhook-listener.js",
      );
    }
    listener = JSON.parse(fs.readFileSync(HANDOFF, "utf8"));
    companyId = listener.companyId;
    mongoUri = listener.uri;
    if (!process.env.MAUTIC_WEBHOOK_SECRET) throw new Error("MAUTIC_WEBHOOK_SECRET is not set.");
    if (!stackEnv.MAUTIC_ADMIN_USERNAME) throw new Error("deploy/mautic/.env holds no admin credentials; steps 5-6 need them.");
  }

  await mongoose.connect(mongoUri, SYNTHETIC ? {} : { dbName: "marketing_live_proof" });
  const companyObjectId = new mongoose.Types.ObjectId(companyId);

  const double = SYNTHETIC ? createMauticDouble() : null;
  const client = SYNTHETIC
    ? new MauticClient({ env, transport: { request: double.request } })
    : new MauticClient({});

  if (CLEANUP) return cleanup(companyObjectId);

  /* ── 0. HEALTH ─────────────────────────────────────────────────────────── */
  const h = await health.check({ client, env });
  record("0  health", h.healthy ? "PASS" : "FAIL",
    Object.entries(h.checks).map(([k, v]) => `${k}=${v.state}`).join(" "));
  if (!h.healthy) return finish();

  /* ── 1. ONE CONSENTED SYNTHETIC PERSON ─────────────────────────────────── */
  const gravPersonKey = crypto.createHash("sha256")
    .update(`${companyId}|${PERSON.workEmail}`).digest("hex").slice(0, 24);
  /* ── CONSENT IS NOW RECORDED, NOT ASSERTED ─────────────────────────────
     Chunk 1 slice 1: this used to build a `consent` object and hand it to
     syncContact, which trusted it. There is no such path any more — the opt-in
     is written to the canonical GRAV consent record, with its capture source and
     notice version, and syncContact resolves it server-side. Passing a consent
     object now fails the request. */
  const consentWrite = await consentService.record({
    companyId: companyObjectId,
    gravPersonKey,
    ...consentService.MARKETING_EMAIL,
    state: "opted_in",
    capturedSource: "chunk-0 round trip, synthetic probe",
    capturedAt: new Date(),
    noticeVersion: "dev-notice-v1",
    evidenceRef: `round-trip:${RUN}`,
    actor: { name: "Chunk 0 round trip", kind: "system" },
    commandKey: `round-trip:${RUN}:optin`,
  });
  const verdict = await consentService.resolveEffective({
    companyId: companyObjectId, gravPersonKey, ...consentService.MARKETING_EMAIL,
  });
  record("1  consented GRAV person", verdict.eligible ? "PASS" : "FAIL",
    `key ${gravPersonKey}, consent ${verdict.state} (rev ${consentWrite.record.revision}), eligible=${verdict.eligible}`);

  /* ── 2. CONTACT, CREATED THEN UPDATED IDEMPOTENTLY ─────────────────────── */
  const first = await sync.syncContact({ client, companyId: companyObjectId, gravPersonKey, person: PERSON });
  record("2a create contact", first.created ? "PASS" : "FAIL",
    `id ${first.contactId} matchedBy=${first.matchedBy}`);

  const second = await sync.syncContact({
    client, companyId: companyObjectId, gravPersonKey,
    person: { ...PERSON, jobTitle: "Group Head of Procurement" },
  });
  const lookup = await client.findContactByEmail(PERSON.workEmail);
  record("2b idempotent update", !second.created && second.contactId === first.contactId && lookup.total === 1 ? "PASS" : "FAIL",
    `id ${second.contactId} matchedBy=${second.matchedBy}, Mautic contacts with that email: ${lookup.total}`);

  /* ── 3. THE MAPPING, BOTH SIDES ────────────────────────────────────────── */
  const identity = await MarketingIdentity.findOne({ companyId: companyObjectId, gravPersonKey }).lean();
  const mapped = (identity?.externals || []).filter((e) => e.system === "mautic");
  /* Not just GRAV's own row: the key has to be readable back OUT of Mautic, or
     the mapping cannot be rebuilt from Mautic's side after a restore. */
  const inMautic = await client.request({ method: "GET", url: `/api/contacts/${first.contactId}` });
  const keyInMautic = inMautic.data?.contact?.fields?.all?.grav_person_key;
  record("3  identity mapping", mapped.length === 1 && mapped[0].externalId === first.contactId
    && (SYNTHETIC || keyInMautic === gravPersonKey) ? "PASS" : "FAIL",
    `GRAV→${mapped.map((m) => m.externalId).join(",")}; grav_person_key in Mautic = ${JSON.stringify(keyInMautic)}`);

  /* ── 4. SEGMENT ENROLMENT, READ BACK ───────────────────────────────────── */
  const segmentName = process.env.MAUTIC_TEST_SEGMENT || stackEnv.MAUTIC_TEST_SEGMENT || "grav-integration-test";
  let segmentId = null;
  try {
    const enrolment = await sync.enrolInSegment({ client, contactId: first.contactId, segment: segmentName });
    segmentId = enrolment.segmentId;
    record("4  segment enrolment", "PASS", `segment ${segmentId}, membership read back`);
  } catch (err) {
    record("4  segment enrolment", "FAIL", err.message);
  }

  /* ── 5 & 6. A REAL SEND, AND A REAL WEBHOOK CAUSED BY OPENING IT ────────
     This is the pair the synthetic contract cannot reach: there is no mail
     transport to exercise and no Mautic to do the signing. */
  let ledgerRow = null;
  if (SYNTHETIC) {
    record("5  campaign send via mail sink", "SKIP",
      "Not applicable to the synthetic contract — there is no mail transport to exercise.");
    record("6  real signed Mautic webhook", "SKIP",
      "Not applicable — nothing can sign a delivery but Mautic itself.");

    /* The ledger is still exercised, with a locally built event, so steps 7-8
       mean something in synthetic mode. It is NOT a webhook. */
    ledgerRow = { synthetic: true };
    await eventIntake.recordEvent({
      companyId: companyObjectId,
      event: {
        source: "mautic", sourceEventId: `synthetic:chunk0-${RUN}`, kind: "form_submitted",
        email: PERSON.workEmail, externalContactId: first.contactId,
        campaignName: "Chunk 0 contract proof", occurredAt: new Date().toISOString(),
      },
    });
  } else {
    const sent = await sendProbeEmail(segmentId);
    record("5  campaign send via mail sink", sent.ok ? "PASS" : "FAIL", sent.detail);

    if (sent.ok) {
      const fired = await openAndAwaitWebhook(companyObjectId, sent.pixel, first.contactId, PERSON.workEmail);
      ledgerRow = fired.row;
      record("6  real signed Mautic webhook", fired.ok ? "PASS" : "FAIL", fired.detail);
    } else {
      record("6  real signed Mautic webhook", "FAIL", "no email was delivered to open");
    }
  }

  /* ── 7. RECORDED EXACTLY ONCE ────────────────────────────────────────────
     THIS RUN's event, not the whole ledger. A listener session that has already
     proved a delivery legitimately holds rows from it, and asserting on the
     collection total would fail for a reason that says nothing about whether
     deduplication works. The question is whether one delivery produced one row. */
  const mine = ledgerRow ? await MarketingIntentEvent.find({
    companyId: companyObjectId,
    sourceEventId: lastEventId(ledgerRow, SYNTHETIC, RUN),
  }).lean() : [];
  const ledger = mine;
  record("7  recorded exactly once", ledger.length === 1 ? "PASS" : "FAIL",
    ledger.length
      ? `1 row for this run's delivery: ${ledger[0].sourceEventId}`
      : `expected 1 row for this run's delivery, found ${ledger.length}`);

  /* ── 8. REPLAY ─────────────────────────────────────────────────────────── */
  if (!SYNTHETIC && ledgerRow && ledger.length) {
    const replay = await replayDelivery(listener, ledger[0]);
    /* Counted for THIS delivery, for the same reason step 7 is: the collection
       total moves for reasons unrelated to whether a replay deduplicated. */
    const after = await MarketingIntentEvent.countDocuments({
      companyId: companyObjectId, sourceEventId: ledger[0].sourceEventId,
    });
    record("8  replay creates no duplicate", replay.ok && after === 1 ? "PASS" : "FAIL",
      `${replay.detail}; rows for ${ledger[0].sourceEventId}: ${ledger.length}→${after}`);
  } else if (ledger.length) {
    const again = await eventIntake.recordEvent({
      companyId: companyObjectId,
      event: { source: "mautic", sourceEventId: ledger[0].sourceEventId, kind: ledger[0].kind, occurredAt: ledger[0].occurredAt, email: ledger[0].email },
    });
    const after = await MarketingIntentEvent.countDocuments({
      companyId: companyObjectId, sourceEventId: ledger[0].sourceEventId,
    });
    record("8  replay creates no duplicate", again.duplicate && after === 1 ? "PASS" : "FAIL",
      `duplicate=${again.duplicate}, rows for ${ledger[0].sourceEventId}: ${ledger.length}→${after}`);
  } else {
    record("8  replay creates no duplicate", "FAIL", "nothing was recorded to replay");
  }

  /* ── 9. NO SALES LIFECYCLE RECORD ANYWHERE ─────────────────────────────── */
  const leaked = {
    activeLeads: await Lead.countDocuments({ captureStatus: "active" }),
    anyLead: await Lead.countDocuments({}),
    enquiries: await Enquiry.countDocuments({}),
    journeys: await SalesJourney.countDocuments({}),
    accounts: await Account.countDocuments({}),
  };
  record("9  no Sales lifecycle record created",
    Object.values(leaked).every((n) => n === 0) ? "PASS" : "FAIL", JSON.stringify(leaked));

  return finish();
}

/** This run's own sourceEventId.
 *
 *  ── SIMPLIFIED IN CHUNK 2 ──────────────────────────────────────────────────
 *  This used to re-derive the id by re-translating the provider item stored on
 *  the ledger row. That row no longer keeps the provider's whole item — it was
 *  an unbounded copy of personal data — so the id is read from the row, which
 *  is where the derivation already put it. */
function lastEventId(ledgerRow, synthetic, run) {
  if (synthetic) return `synthetic:chunk0-${run}`;
  return ledgerRow?.sourceEventId || "";
}

/* ── STEP 5: SEND, AND PROVE IT WENT ONLY TO THE SINK ────────────────────── */
async function sendProbeEmail(segmentId) {
  if (!segmentId) return { ok: false, detail: "no segment to send to" };

  const before = await mailpitCount();
  const name = `GRAV Chunk 0 probe ${RUN}`;
  const created = await adminApi("POST", "/api/emails/new", {
    name,
    subject: `GRAV integration probe ${RUN} — not a real campaign`,
    fromAddress: "marketing@grav-integration-test.invalid",
    fromName: "GRAV Marketing Dev",
    customHtml: "<p>This message exists only to prove that GRAV's development Mautic delivers into a local mail sink. Synthetic recipients on a reserved .invalid domain only.</p>",
    emailType: "list",
    isPublished: true,
    lists: [Number(segmentId)],
  });
  if (created.status !== 200 && created.status !== 201) {
    return { ok: false, detail: `email create failed (${created.status}) ${JSON.stringify(created.data).slice(0, 200)}` };
  }
  const emailId = created.data?.email?.id;

  const sent = await adminApi("POST", `/api/emails/${emailId}/send`);
  if (sent.status !== 200 || !sent.data?.sentCount) {
    return { ok: false, detail: `send failed (${sent.status}) ${JSON.stringify(sent.data).slice(0, 200)}` };
  }

  /* Read it back OUT of the sink. A send API that answers "1 sent" has told us
     what Mautic attempted, not what arrived, and the whole point of this step is
     that the message went to the sink and nowhere else. */
  /* Matched on the subject AND on THIS run's recipient. The segment accumulates
     probe contacts across runs, so one send produces several messages; opening
     somebody else's would attribute this run's webhook to a different person and
     the proof would quietly stop being about the person it created. */
  let msg = null;
  for (let i = 0; i < 20 && !msg; i++) {
    await sleep(500);
    msg = await mailpitFind(`probe ${RUN}`, PERSON.workEmail);
  }
  if (!msg) return { ok: false, detail: `sent ${sent.data.sentCount}, but nothing arrived in the mail sink` };

  const recipients = (msg.To || []).map((t) => t.Address);
  const external = recipients.filter((a) => !/\.invalid$/i.test(a));
  if (external.length) {
    return { ok: false, detail: `a recipient was NOT on a reserved .invalid domain: ${external.join(", ")}` };
  }

  const full = await (await fetch(`${MAILSINK}/api/v1/message/${msg.ID}`)).json();
  const pixel = (String(full.HTML || "").match(/https?:\/\/[^"'<>\s]+\.gif[^"'<>\s]*/) || [])[0] || null;
  const after = await mailpitCount();

  return {
    ok: Boolean(pixel),
    pixel,
    detail: `sentCount=${sent.data.sentCount}, failed=${sent.data.failedRecipients}, sink ${before}→${after}, to ${recipients.join(",")}${pixel ? "" : ", but no tracking pixel found"}`,
  };
}

const mailpitCount = async () => {
  try {
    const r = await fetch(`${MAILSINK}/api/v1/messages?limit=1`);
    return (await r.json()).total;
  } catch { return null; }
};

async function mailpitFind(subjectFragment, recipient = null) {
  const r = await fetch(`${MAILSINK}/api/v1/messages?limit=200`);
  const d = await r.json();
  return (d.messages || []).find((m) => {
    if (!String(m.Subject || "").includes(subjectFragment)) return false;
    if (!recipient) return true;
    return (m.To || []).some((t) => String(t.Address || "").toLowerCase() === recipient.toLowerCase());
  }) || null;
}

/* ── STEP 6: OPEN THE EMAIL, AND WAIT FOR MAUTIC TO SIGN AND POST ────────── */
async function openAndAwaitWebhook(companyObjectId, pixelUrl, expectContactId, expectEmail) {
  const before = await MarketingIntentEvent.countDocuments({ companyId: companyObjectId });

  const res = await fetch(pixelUrl, { headers: { "User-Agent": "Mozilla/5.0 Chunk0Probe" } });
  if (!res.ok) return { ok: false, detail: `tracking pixel returned ${res.status}` };

  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const rows = await MarketingIntentEvent.find({ companyId: companyObjectId }).lean();
    if (rows.length > before) {
      const row = rows[rows.length - 1];
      /* The email has to have survived translation. A row attributed only by
         contact id is a row a handover could not write to. */
      const attributed = String(row.externalContactId) === String(expectContactId)
        && String(row.email).toLowerCase() === String(expectEmail).toLowerCase();
      const ok = Boolean(row.email) && Boolean(row.externalContactId) && attributed;
      return {
        ok,
        row,
        detail: `${row.sourceEventId} kind=${row.kind} email=${row.email || "(EMPTY — translator did not find it)"} contact=${row.externalContactId} asset=${row.assetName}`
          + (attributed ? "" : ` — ATTRIBUTED TO THE WRONG PERSON (expected contact ${expectContactId}, ${expectEmail})`),
      };
    }
  }
  return { ok: false, detail: "Mautic did not deliver a webhook within 15s (is queue_mode immediate_process, and is the listener reachable at host.docker.internal?)" };
}

/* ── STEP 8: REPLAY THE SAME DELIVERY, CORRECTLY SIGNED ─────────────────── */
async function replayDelivery(listener, row) {
  const envelope = {};
  /* ── REBUILT FROM THE BOUNDED EVIDENCE, IN CHUNK 2 ──────────────────────
     The ledger no longer stores the provider's whole item, so the envelope is
     reconstructed from the facts the derivation actually uses. That makes this
     a STRONGER replay test than re-posting a stored copy: if the id derivation
     depended on anything beyond those facts, the rebuilt request would produce
     a different key and be recorded as new. */
  const type = String(row.sourceEventId).split(":")[0];
  envelope[type] = [{
    stat: {
      id: Number(row.evidence?.providerRecordId),
      emailAddress: row.email,
      dateRead: row.occurredAt,
      email: { id: Number(row.evidence?.emailId) || undefined, name: row.assetName },
      lead: { id: Number(row.externalContactId), fields: { core: { email: { value: row.email } } } },
    },
    timestamp: row.evidence?.providerTimestamp,
  }];
  const body = JSON.stringify(envelope);
  const signature = crypto.createHmac("sha256", process.env.MAUTIC_WEBHOOK_SECRET)
    .update(Buffer.from(body, "utf8")).digest("base64");

  const res = await fetch(`http://127.0.0.1:${listener.port}/api/cms/marketing/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Webhook-Signature": signature, "User-Agent": "Webhook" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  return {
    ok: res.status === 200 && data.duplicates === 1 && data.recorded === 0,
    detail: `status ${res.status}, recorded ${data.recorded}, duplicates ${data.duplicates}`,
  };
}

async function cleanup(companyObjectId) {
  const r1 = await MarketingIdentity.deleteMany({ email: /@grav-integration-test\.invalid$/ });
  const r2 = await MarketingIntentEvent.deleteMany({ email: /@grav-integration-test\.invalid$/ });
  console.log(`  removed ${r1.deletedCount} identity row(s), ${r2.deletedCount} ledger row(s).`);
  console.log("  Mautic contacts and emails are NOT removed — Mautic owns them.");
  await mongoose.disconnect();
  process.exit(0);
}

async function finish() {
  const pass = results.filter((r) => r.state === "PASS").length;
  const failed = results.filter((r) => r.state === "FAIL").length;
  const skipped = results.filter((r) => r.state === "SKIP").length;

  console.log(`\n  ${pass} passed, ${failed} failed${skipped ? `, ${skipped} not applicable` : ""}.`);
  if (SYNTHETIC) {
    console.log("\n  SYNTHETIC RUN. Proof of the recorded contract only.");
    console.log("  It is NOT proof that a live Mautic instance works and must not be");
    console.log("  reported as one. Re-run without --synthetic against the deployed stack.");
  } else if (!failed) {
    console.log("\n  LIVE ROUND TRIP COMPLETE. Every step above ran against the deployed");
    console.log("  Mautic 7.2.0 instance, including a delivery Mautic itself signed.");
  }
  await mongoose.disconnect();
  /* Success is 0 only for a LIVE run with nothing failed. A synthetic pass exits
     64 so no CI job can mistake a contract proof for a live integration. */
  process.exit(failed ? 1 : (SYNTHETIC ? 64 : 0));
}

main().catch(async (err) => {
  console.error("\n  ABORTED:", err?.message || err);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
