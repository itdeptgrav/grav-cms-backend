// scripts/marketing/channels-proof.js
//
// A LIVE PROOF OF THE ADVERTISING CHANNEL CONTRACT.
//
// Nothing is mocked. Real router, real services, real adapters, real `axios`. It
// mounts the production router against an in-memory Mongo and prints the actual
// response bodies.
//
// Run it with credentials in the environment and it performs real read-only
// calls to Google Ads, Meta and GA4 — account access, campaign listing, one
// campaign performance read, one GA4 report. It creates and modifies nothing:
// the router declares GET only, the adapters export reads only, and the shared
// HTTP core refuses every write verb.
//
// Run it WITHOUT credentials, which is this deployment's current state, and it
// proves the honest unavailable path through the same public contract, and
// prints exactly which secret or external approval each channel is waiting on.
//
//   node scripts/marketing/channels-proof.js
"use strict";

const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const secrets = require("../../services/marketing/channels/channelSecrets");

/* ── EVERY OUTBOUND REQUEST IS COUNTED ──────────────────────────────────────
   "No provider was contacted" is a claim, and this measures it. The real axios
   is wrapped rather than replaced, so a call WOULD go out if the code made one —
   the proof stays unmocked, and the counter simply records what happened.

   With no credentials configured, the expected count is zero: a channel that is
   not connected is answered from configuration, not by a request that fails. */
const axios = require("axios");
const outbound = [];
const realAxios = axios.default ?? axios;
const wrapped = function countingAxios(config) {
  outbound.push({ method: String(config?.method || "GET").toUpperCase(), url: String(config?.url || "") });
  return realAxios(config);
};
Object.assign(wrapped, realAxios);
require.cache[require.resolve("axios")].exports = wrapped;

const line = (s = "") => process.stdout.write(`${s}\n`);
const show = (label, value) => line(`\n── ${label} ${"─".repeat(Math.max(0, 68 - label.length))}\n${JSON.stringify(value, null, 2)}`);

/* The external approval each channel needs beyond a secret being present. A
   variable can be set and the channel still refused, and these are the reasons
   that has nothing to do with GRAV. */
const EXTERNAL_APPROVALS = {
  google_ads: [
    "A Google Ads developer token approved for Basic or Standard access. A test-account token reads only test accounts.",
    "OAuth consent for the https://www.googleapis.com/auth/adwords scope. The existing GOOGLE_CLIENT_* credentials in this deployment are Drive-scoped and cannot be reused.",
    "The authenticated user must have access to the customer account, or to a manager account above it.",
  ],
  meta_ads: [
    "A Meta app with ads_read granted, or a system user token from a Business Manager.",
    "App review for ads_read if the token is not a system user token.",
    "The token's identity must have a role on the ad account.",
  ],
  google_analytics: [
    "The service account or OAuth user must be granted at least Viewer on the GA4 property.",
    "The Google Analytics Data API must be enabled on the Google Cloud project.",
  ],
};

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: "grav_channel_proof" });

  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const company = await Acc_Company.create({
    companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01"),
  });
  process.env.MARKETING_COMPANY_ID = String(company._id);
  if (!secrets.campaignIdSecret()) {
    /* Proof-local only. Named so the output cannot be mistaken for a deployment
       that has one configured. */
    process.env.MARKETING_CHANNEL_ID_SECRET = "proof-only-signing-key-not-a-deployment-secret";
    line("NOTE: MARKETING_CHANNEL_ID_SECRET was unset; a proof-local key is in use for this run.");
  }

  /* ── A REAL TOKEN, THROUGH THE REAL MIDDLEWARE ─────────────────────────
     The proof authenticates the way a browser does rather than injecting
     `req.user` past the guard. A proof that skips the authentication path has
     not proved the endpoint is reachable — only that its handler runs. */
  const jwt = require("jsonwebtoken");
  const SECRET = process.env.JWT_SECRET || "proof-only-jwt-secret";
  process.env.JWT_SECRET = SECRET;
  const token = jwt.sign(
    { id: String(new mongoose.Types.ObjectId()), role: "admin", name: "Proof", email: "proof@grav.in", isAdmin: true },
    SECRET, { expiresIn: "10m" },
  );

  const app = express();
  app.use((req, res, next) => {
    /* The company the actor belongs to. Resolved from membership in production;
       injected here so the proof needs no employee fixture. Note this is the
       ONLY thing bypassed, and it is not the tenancy check — the service still
       compares it against MARKETING_COMPANY_ID. */
    req.__marketingCompanyId = company._id;
    next();
  });
  /* The production router, unmodified. */
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/advertisingChannels"));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;

  const get = async (path) => {
    const res = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: await res.json() };
  };

  line("═".repeat(74));
  line("  ADVERTISING CHANNEL PROOF — read-only, creates and modifies nothing");
  line("═".repeat(74));

  line("\nConfiguration presence, by variable name. No value is read or printed.");
  for (const channel of ["google_ads", "meta_ads", "google_analytics"]) {
    const p = secrets.presence(channel);
    line(`\n  ${channel}: ${p.configured ? "configured" : "NOT configured"}`);
    if (p.missing.length) line(`    missing: ${p.missing.join(", ")}`);
    if (p.optionalMissing.length) line(`    optional, absent: ${p.optionalMissing.join(", ")}`);
    if (!p.configured) {
      line("    external approvals this channel also requires:");
      for (const need of EXTERNAL_APPROVALS[channel]) line(`      - ${need}`);
    }
  }

  /* 1. Connection state, live. */
  const channels = await get("/channels");
  show("GET /channels", {
    status: channels.status,
    channels: channels.body.channels?.map((c) => ({
      channel: c.channel, label: c.label, role: c.role,
      configured: c.configured, available: c.available, state: c.state,
      capabilities: c.capabilities, summary: c.summary,
      diagnostics: c.diagnostics,
    })),
  });

  /* 2. Campaign inventory, both advertising channels. */
  for (const channel of ["google_ads", "meta_ads"]) {
    const list = await get(`/campaigns?channel=${channel}&limit=5`);
    show(`GET /campaigns?channel=${channel}`, {
      status: list.status,
      readState: list.body.readState,
      reasonCode: list.body.reasonCode,
      rows: list.body.rows,
      campaignCount: list.body.campaignCount,
      hasMore: list.body.hasMore,
      error: list.body.error,
    });

    /* 3. One campaign's performance, when there is a campaign to read. */
    const first = list.body.rows?.[0];
    if (first) {
      const to = new Date();
      const from = new Date(to.getTime() - 6 * 86_400_000);
      const day = (d) => d.toISOString().slice(0, 10);
      const perf = await get(`/campaigns/${encodeURIComponent(first.campaignId)}/performance?startDate=${day(from)}&endDate=${day(to)}`);
      show(`GET /campaigns/{id}/performance — ${channel}`, {
        status: perf.status,
        readState: perf.body.readState,
        dateRange: perf.body.dateRange,
        metrics: perf.body.metrics,
        conversionBasis: perf.body.conversionBasis,
        notes: perf.body.notes,
      });
    } else {
      line(`\n  No ${channel} campaign to read performance for in this run.`);
    }
  }

  /* 4. The measurement source refuses a campaign list by name. */
  const ga4List = await get("/campaigns?channel=google_analytics");
  show("GET /campaigns?channel=google_analytics — refused by design", {
    status: ga4List.status, error: ga4List.body.error,
  });

  /* 5. GA4 report. */
  const to = new Date();
  const from = new Date(to.getTime() - 6 * 86_400_000);
  const day = (d) => d.toISOString().slice(0, 10);
  const ga4 = await get(`/analytics/campaign-performance?startDate=${day(from)}&endDate=${day(to)}&limit=5`);
  show("GET /analytics/campaign-performance", {
    status: ga4.status,
    readState: ga4.body.readState,
    reasonCode: ga4.body.reasonCode,
    reportingTimeZone: ga4.body.reportingTimeZone,
    rows: ga4.body.rows,
    sampled: ga4.body.sampled,
    notes: ga4.body.notes,
    error: ga4.body.error,
  });

  /* 6. An identifier that was not issued by GRAV reaches no provider. */
  const forged = await get("/campaigns/not-a-real-identifier/performance?startDate=2026-09-01&endDate=2026-09-02");
  show("GET /campaigns/{forged}/performance — refused without an upstream call", {
    status: forged.status, error: forged.body.error,
  });

  /* 7. No mutation is reachable. */
  const router = require("../../routes/CMS_Routes/Marketing/advertisingChannels");
  const verbs = new Set();
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const [verb, used] of Object.entries(layer.route.methods)) if (used) verbs.add(verb.toUpperCase());
  }
  show("Methods declared by the router", { verbs: [...verbs].sort() });

  /* 8. What GRAV actually sent. */
  show("Outbound provider requests attempted", {
    count: outbound.length,
    requests: outbound,
    /* With no credentials, nothing should have been attempted at all. */
    noProviderContacted: outbound.length === 0,
    /* And if any WERE made, none may be a write. */
    allReads: outbound.every((r) => r.method === "GET" || r.method === "POST"),
  });

  /* 9. And the engine behind the email channel is not named anywhere. */
  const everything = JSON.stringify([channels.body, ga4.body, ga4List.body]);
  show("Provider invisibility of the internal engine", {
    mentionsEngineProduct: /mautic/i.test(everything),
    mentionsEngineVariables: /MAUTIC_/.test(everything),
  });

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongod.stop();
}

main().catch((err) => {
  console.error("proof failed:", err);
  process.exit(1);
});
