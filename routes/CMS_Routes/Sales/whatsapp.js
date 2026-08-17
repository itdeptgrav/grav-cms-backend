// routes/CMS_Routes/Sales/whatsapp.js  →  mounted at /api/cms/crm/whatsapp
//
// The AUTHENTICATED CRM-side WhatsApp API the sales UI talks to: list
// conversations, read a thread, mark read, send a message, and find-or-start a
// chat for a customer's phone (the "Message" button on a Lead/Account). The
// public webhook Meta calls is a separate router (whatsappWebhook.js).
const express = require("express");
const router = express.Router();

const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const WhatsAppConversation = require("../../../models/CMS_Models/Sales/WhatsAppConversation");
const { WhatsAppMessage } = require("../../../models/CMS_Models/Sales/WhatsAppMessage");
const { cfg, canSend, canReceive, graphBase } = require("../../../config/whatsapp");
const { sendText, sendTemplate, WhatsAppError } = require("../../../services/whatsappSend");
const { findOrCreateByPhone } = require("../../../services/whatsappStore");

router.use(salesAuth);

const windowOpen = (c) => Boolean(c?.windowExpiresAt && new Date(c.windowExpiresAt) > new Date());
const withWindow = (c) => ({ ...c, windowOpen: windowOpen(c) });
const POP_ACCOUNT = ["accountId", "companyName accountId"];
const POP_LEAD = ["leadId", "leadId firstName lastName company"];

// GET /config — lets the UI show a "not configured yet" state instead of failing.
router.get("/config", (req, res) => res.json({ success: true, canSend: canSend() }));

// GET /status — a live readiness check the UI can show at a glance: which
// credentials are set, and whether Meta actually ACCEPTS them (returns the
// connected number + verified business name). No secret values are returned.
router.get("/status", async (req, res) => {
  const status = {
    canReceive: canReceive(),
    canSend: canSend(),
    hasVerifyToken: Boolean(cfg.verifyToken),
    hasAccessToken: Boolean(cfg.accessToken),
    hasPhoneNumberId: Boolean(cfg.phoneNumberId),
    hasWabaId: Boolean(cfg.wabaId),
    hasAppSecret: Boolean(cfg.appSecret),
    apiVersion: cfg.apiVersion,
    live: false, number: null, name: null, quality: null, error: null,
  };
  if (canSend()) {
    try {
      const r = await fetch(`${graphBase()}/${cfg.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating&access_token=${cfg.accessToken}`);
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.id) {
        status.live = true;
        status.number = d.display_phone_number;
        status.name = d.verified_name;
        status.quality = d.quality_rating;
      } else {
        status.error = d?.error?.message || `Meta rejected the credentials (HTTP ${r.status}).`;
      }
    } catch (e) {
      status.error = e.message;
    }
  }
  res.json({ success: true, status });
});

// GET /templates — the WABA's APPROVED message templates, each with how many
// body variables ({{1}}…) it needs, so the UI can collect exactly that many
// values (avoids Meta error #132000 "number of parameters does not match").
router.get("/templates", async (req, res) => {
  if (!cfg.wabaId || !cfg.accessToken) return res.json({ success: true, templates: [] });
  try {
    const r = await fetch(`${graphBase()}/${cfg.wabaId}/message_templates?fields=name,language,status,category,components&limit=200&access_token=${cfg.accessToken}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ success: false, message: d?.error?.message || `Could not load templates (HTTP ${r.status}).` });
    const templates = (d.data || [])
      .filter((t) => t.status === "APPROVED")
      .map((t) => {
        const body = (t.components || []).find((c) => c.type === "BODY");
        const bodyText = body?.text || "";
        const varCount = new Set((bodyText.match(/\{\{\d+\}\}/g) || [])).size;
        return { name: t.name, language: t.language, category: t.category, bodyText, varCount };
      });
    res.json({ success: true, templates });
  } catch (e) {
    res.status(502).json({ success: false, message: e.message });
  }
});

// GET /media/:messageId — stream an inbound media file (image/document/…)
// through the backend. Meta's media URLs are short-lived AND require the access
// token, so the browser can't load them directly; we resolve the temporary URL
// for the stored media id, fetch the bytes with the token, and proxy them back.
router.get("/media/:messageId", async (req, res) => {
  try {
    const msg = await WhatsAppMessage.findById(req.params.messageId).lean();
    if (!msg || !msg.media || !msg.media.id) return res.status(404).json({ success: false, message: "No media for this message." });
    if (!cfg.accessToken) return res.status(503).json({ success: false, message: "WhatsApp sending/media isn't configured." });

    // 1) resolve the temporary download URL for the media id
    const metaRes = await fetch(`${graphBase()}/${msg.media.id}?access_token=${cfg.accessToken}`);
    const meta = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok || !meta.url) return res.status(502).json({ success: false, message: meta?.error?.message || `Could not resolve media (HTTP ${metaRes.status}).` });

    // 2) fetch the actual bytes (this URL also requires the Bearer token)
    const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${cfg.accessToken}` } });
    if (!fileRes.ok) return res.status(502).json({ success: false, message: `Media download failed (HTTP ${fileRes.status}).` });

    const contentType = fileRes.headers.get("content-type") || msg.media.mimeType || meta.mime_type || "application/octet-stream";
    const buf = Buffer.from(await fileRes.arrayBuffer());
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "private, max-age=86400");
    if (msg.media.filename) res.set("Content-Disposition", `inline; filename="${String(msg.media.filename).replace(/["\r\n]/g, "")}"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /conversations?search=&limit=
router.get("/conversations", async (req, res) => {
  try {
    const { search, limit = 50 } = req.query;
    const filter = { isActive: true };
    if (search) {
      const re = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ displayName: re }, { phone: re }, { waId: re }];
    }
    const rows = await WhatsAppConversation.find(filter)
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .limit(Math.min(Number(limit) || 50, 200))
      .populate(...POP_ACCOUNT).populate(...POP_LEAD).lean();
    res.json({ success: true, conversations: rows.map(withWindow) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /conversations/:id
router.get("/conversations/:id", async (req, res) => {
  try {
    const c = await WhatsAppConversation.findById(req.params.id).populate(...POP_ACCOUNT).populate(...POP_LEAD).lean();
    if (!c) return res.status(404).json({ success: false, message: "Conversation not found" });
    res.json({ success: true, conversation: withWindow(c) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /conversations/:id/messages?limit=
router.get("/conversations/:id/messages", async (req, res) => {
  try {
    const { limit = 100 } = req.query;
    const messages = await WhatsAppMessage.find({ conversationId: req.params.id })
      .sort({ timestamp: 1, createdAt: 1 })
      .limit(Math.min(Number(limit) || 100, 500)).lean();
    res.json({ success: true, messages });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /conversations/:id/read
router.post("/conversations/:id/read", async (req, res) => {
  try {
    await WhatsAppConversation.updateOne({ _id: req.params.id }, { $set: { unreadCount: 0 } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /conversations/:id/send  { text } | { template: { name, language, components } }
router.post("/conversations/:id/send", async (req, res) => {
  try {
    const conv = await WhatsAppConversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ success: false, message: "Conversation not found" });
    const actor = { id: req.user?.id, name: req.user?.name };
    const { text, template } = req.body || {};

    let stored;
    if (template) {
      stored = await sendTemplate(conv, template, actor);
    } else {
      const body = String(text || "").trim();
      if (!body) return res.status(400).json({ success: false, message: "Message text is required." });
      if (!windowOpen(conv)) {
        return res.status(409).json({
          success: false,
          code: "window_closed",
          message: "You're outside WhatsApp's 24-hour reply window for this customer. Send an approved template to reopen the conversation.",
        });
      }
      stored = await sendText(conv, body, actor);
    }
    res.status(201).json({ success: true, message: stored });
  } catch (err) {
    const status = err instanceof WhatsAppError ? err.status : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// POST /start  { phone, name?, accountId?, leadId?, contactId? }
// Find or create the conversation for a customer's number — the "Message"
// button. Returns the conversation to open; sends nothing.
router.post("/start", async (req, res) => {
  try {
    const conv = await findOrCreateByPhone(req.body || {});
    const populated = await WhatsAppConversation.findById(conv._id).populate(...POP_ACCOUNT).populate(...POP_LEAD).lean();
    res.json({ success: true, conversation: withWindow(populated) });
  } catch (err) {
    res.status(err.status || 400).json({ success: false, message: err.message });
  }
});

module.exports = router;
