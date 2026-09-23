#!/usr/bin/env node
//
// scripts/marketing/mautic-webhook-listener.js
//
// GRAV'S MARKETING WEBHOOK ENDPOINT, ON ITS OWN, FOR THE CHUNK 0 PROOF.
//
//   node -r dotenv/config scripts/marketing/mautic-webhook-listener.js
//
// ── WHY NOT JUST RUN server.js ─────────────────────────────────────────────
// Because proving one webhook should not start the whole platform. `server.js`
// connects to the live development MongoDB and Firestore, seeds department
// users, registers two crons, opens Socket.IO, and reads the entire
// `cowork_tasks` collection on boot to backfill it. None of that is needed to
// prove that Mautic can sign a delivery and GRAV can verify and record it, and
// all of it writes to shared data.
//
// So this mounts EXACTLY the real router — routes/CMS_Routes/Marketing/
// marketingHandovers.js, with the production signature check, the production
// envelope translation and the production intake ledger — behind the same
// global `express.json({ verify })` that server.js installs at line 156, so the
// raw-body path under test is the one that runs in production.
//
// ── AND ITS DATABASE IS DISPOSABLE ─────────────────────────────────────────
// An in-memory MongoDB, started here and thrown away on exit. The ledger rows
// this proof creates are real rows written by real code; they simply are not
// written into the shared development database. The URI is published to a file
// so the round-trip script can read the same ledger.
//
// Nothing about the webhook path is stubbed. If this accepts a delivery, so
// will the real backend.
"use strict";

const express = require("express");
const mongoose = require("mongoose");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.MARKETING_LISTENER_PORT || 5055);
const HANDOFF = path.join(os.tmpdir(), "grav-marketing-listener.json");

(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri, { dbName: "marketing_live_proof" });

  /* A company id for this run. One Mautic instance serves one GRAV
     organisation (ADR-004), and the webhook route reads it from the
     environment rather than from the payload — a sender may not assert it. */
  const companyId = process.env.MARKETING_COMPANY_ID
    || new mongoose.Types.ObjectId().toString();
  process.env.MARKETING_COMPANY_ID = companyId;

  const app = express();
  /* The same global parser server.js installs, including the `verify` hook that
     stashes the raw bytes. The signature is over those exact bytes. */
  app.use(express.json({ limit: "50mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

  /* Log every delivery BEFORE the router sees it, so a rejected one is still
     visible. Headers only — the body is personal data. */
  app.use("/api/cms/marketing/events", (req, _res, next) => {
    console.log(`  → ${req.method} ${req.path}  sig-header=${
      ["webhook-signature", "x-mautic-signature", "x-hub-signature-256"]
        .find((h) => req.get(h)) || "NONE"
    }  ua=${req.get("user-agent") || "-"}  bytes=${req.get("content-length") || "?"}`);
    next();
  });

  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/marketingHandovers"));

  /* A tiny read-only window onto the ledger, so the round trip can assert on it
     over HTTP rather than needing the same process. */
  app.get("/_proof/ledger", async (req, res) => {
    const { MarketingIntentEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
    const rows = await MarketingIntentEvent.find({ companyId })
      .sort({ receivedAt: -1 }).limit(50).lean();
    res.json({
      count: rows.length,
      events: rows.map((r) => ({
        sourceEventId: r.sourceEventId, kind: r.kind, email: r.email,
        externalContactId: r.externalContactId, occurredAt: r.occurredAt,
        receivedAt: r.receivedAt, assetName: r.assetName,
        rawKeys: Object.keys(r.raw || {}),
      })),
    });
  });

  app.get("/_proof/health", (_req, res) => res.json({ ok: true, companyId, uri }));

  /* Chunk 2: what processing did about each observation, and what reached the
     Sales timeline. Read-only, and only over this proof's own disposable
     database. */
  app.get("/_proof/receipts", async (_req, res) => {
    const Receipt = require("../../models/CMS_Models/Marketing/MarketingEventReceipt");
    const rows = await Receipt.find({ companyId }).sort({ occurredAt: 1 }).lean();
    res.json({
      count: rows.length,
      receipts: rows.map((r) => ({
        sourceEventId: r.sourceEventId, kind: r.kind, state: r.state,
        gravPersonKey: r.gravPersonKey || null, resolvedBy: r.resolvedBy || null,
        suppression: r.suppression?.state || "", activity: r.activity?.state || "",
        activityId: r.activity?.activityId || null,
      })),
    });
  });

  app.get("/_proof/sales", async (_req, res) => {
    const Activity = require("../../models/CMS_Models/Sales/Activity");
    const Lead = require("../../models/CMS_Models/Sales/Lead");
    const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
    const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
    const acts = await Activity.find({}).lean();
    res.json({
      activities: acts.map((a) => ({
        id: String(a._id), type: a.activityType, subject: a.subject,
        marketingSourceEventId: a.marketingSourceEventId || null,
        activityDate: a.activityDate, leadId: a.leadId ? String(a.leadId) : null,
      })),
      leads: await Lead.countDocuments({}),
      enquiries: await Enquiry.countDocuments({}),
      journeys: await SalesJourney.countDocuments({}),
    });
  });

  const server = app.listen(PORT, "127.0.0.1", () => {
    fs.writeFileSync(HANDOFF, JSON.stringify({ uri, companyId, port: PORT }, null, 2));
    console.log(`\nGRAV Marketing webhook listener`);
    console.log(`  listening   http://127.0.0.1:${PORT}/api/cms/marketing/events`);
    console.log(`  companyId   ${companyId}`);
    console.log(`  mongo       ${uri}`);
    console.log(`  handoff     ${HANDOFF}`);
    console.log(`  secret      ${process.env.MAUTIC_WEBHOOK_SECRET ? "configured" : "MISSING — every delivery will be rejected"}\n`);
  });

  const shutdown = async () => {
    console.log("\n  shutting down");
    server.close();
    await mongoose.disconnect().catch(() => {});
    await mongod.stop().catch(() => {});
    try { fs.unlinkSync(HANDOFF); } catch { /* already gone */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
})().catch((err) => {
  console.error("listener failed:", err?.message || err);
  process.exit(1);
});
