// routes/CMS_Routes/Sales/whatsappWebhook.js  →  mounted at /api/whatsapp/webhook
//
// The PUBLIC endpoint Meta calls — no auth (Meta can't send our session). Two
// jobs:
//   GET  — the one-time subscription handshake. Meta sends hub.mode +
//          hub.verify_token + hub.challenge; we echo the challenge back only
//          when the token matches WHATSAPP_VERIFY_TOKEN. This is the "Verify
//          token" you type into Meta's webhook config.
//   POST — every event (inbound messages + delivery statuses). We check Meta's
//          signature (if an app secret is configured), store the payload, and
//          ALWAYS answer 200 fast so Meta doesn't retry-storm us.
const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const { cfg, verifySignature } = require("../../../config/whatsapp");
const { cfg: providerCfg, isMetaActive, isOpenWaActive } = require("../../../config/whatsappProvider");
const { ingestWebhook, ingestOpenWaWebhook } = require("../../../services/whatsappStore");
const { ingestOpenWaCallWebhook } = require("../../../services/openwaCallStore");

const sameSecret = (received, expected) => {
  if (!received || !expected) return false;
  const a = Buffer.from(String(received));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// GET /api/whatsapp/webhook  — subscription verification.
router.get("/", (req, res) => {
  if (!isMetaActive()) {
    return res.status(503).json({ success: false, code: "provider_dormant", message: "The official Meta webhook is dormant." });
  }
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token && token === cfg.verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST /api/whatsapp/webhook — inbound messages + statuses.
router.post("/", async (req, res) => {
  if (!isMetaActive()) {
    return res.status(503).json({ success: false, code: "provider_dormant", message: "The official Meta webhook is dormant." });
  }
  // Signature check (skipped when no app secret is set).
  if (!verifySignature(req.rawBody, req.get("x-hub-signature-256"))) {
    return res.sendStatus(401);
  }
  // Acknowledge immediately; process after. Meta only needs a prompt 200, and a
  // retried event is idempotent (messages upsert on Meta's own id).
  res.sendStatus(200);
  try {
    await ingestWebhook(req.body);
  } catch (err) {
    console.error("[whatsapp] webhook ingest failed:", err.message);
  }
});

// POST /api/whatsapp/webhook/openwa — OpenWA v5 webhook integration (and the
// compatible v4 event envelope). The runtime must attach the same secret in
// X-Webhook-Secret. As with Meta, respond quickly and ingest idempotently.
router.post("/openwa", async (req, res) => {
  if (!isOpenWaActive()) {
    return res.status(503).json({ success: false, code: "provider_dormant", message: "OpenWA is dormant." });
  }
  if (!providerCfg.openwaWebhookSecret) {
    return res.status(503).json({ success: false, code: "webhook_not_configured", message: "OpenWA webhook verification is not configured." });
  }
  if (!sameSecret(req.get("x-webhook-secret"), providerCfg.openwaWebhookSecret)) {
    return res.sendStatus(401);
  }
  res.sendStatus(204);
  try {
    const event = String(req.body?.event || req.body?.eventName || "").toLowerCase();
    if (["call.state", "call.state.changed", "oncallstate", "call"].includes(event)) {
      await ingestOpenWaCallWebhook(req.body);
    } else {
      await ingestOpenWaWebhook(req.body);
    }
  } catch (err) {
    console.error("[whatsapp/openwa] webhook ingest failed:", err.message);
  }
});

module.exports = router;
