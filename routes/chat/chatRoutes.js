"use strict";

const express = require("express");
const router = express.Router();

const { authenticateCmsSession } = require("../../services/cmsSession");
const { resolveAppAccess } = require("../../services/access/appAccess.service");
const { resolveMailActor, searchDirectory } = require("../../services/mail/mailIdentity.service");
const internal = require("../../services/mail/internalMail.service");
const openwa = require("../../services/openwaClient");
const { cfg: providerCfg, isOpenWaActive } = require("../../config/whatsappProvider");
const WhatsAppConversation = require("../../models/CMS_Models/Sales/WhatsAppConversation");
const { WhatsAppMessage } = require("../../models/CMS_Models/Sales/WhatsAppMessage");
const { sendText, WhatsAppError } = require("../../services/whatsappSend");
const { findOrCreateByPhone } = require("../../services/whatsappStore");

const POP_ACCOUNT = ["accountId", "companyName accountId"];
const POP_LEAD = ["leadId", "leadId firstName lastName company"];
const configured = () => Boolean(providerCfg.openwaBaseUrl && providerCfg.openwaApiKey && providerCfg.openwaWebhookSecret);
const externalConversation = (row) => ({ ...row, channel: "whatsapp", windowOpen: true });

function fail(res, error, label) {
  const status = Number(error?.status) || 500;
  if (status >= 500) console.error(`[chat/${label}]`, error);
  return res.status(status).json({
    success: false,
    code: error?.code || (status >= 500 ? "CHAT_UNAVAILABLE" : "CHAT_REQUEST_FAILED"),
    message: status >= 500 ? "Chat is temporarily unavailable." : error.message,
  });
}

router.use(authenticateCmsSession);
router.use(async (req, res, next) => {
  try {
    const access = await resolveAppAccess(req.user, "chat");
    if (!access.allowed) {
      return res.status(access.denialCode === "UNAUTHENTICATED" ? 401 : 403).json({
        success: false,
        code: access.denialCode,
        message: "You do not have access to Chat.",
      });
    }
    req.chatAccess = access;
    return next();
  } catch (error) {
    return fail(res, error, "access");
  }
});

router.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !req.chatAccess?.capabilities?.write) {
    return res.status(403).json({ success: false, code: "CHAT_WRITE_DENIED", message: "Your Chat role is read-only." });
  }
  return next();
});

async function actorFor(req) {
  if (!req.chatActor) req.chatActor = await resolveMailActor(req.user);
  return req.chatActor;
}

router.get("/me", async (req, res) => {
  try { return res.json({ success: true, me: await actorFor(req), access: req.chatAccess }); }
  catch (error) { return fail(res, error, "me"); }
});

router.get("/internal/directory", async (req, res) => {
  try { return res.json({ success: true, people: await searchDirectory(req.query.q) }); }
  catch (error) { return fail(res, error, "internal/directory"); }
});

router.get("/internal/conversations", async (req, res) => {
  try {
    const threads = await internal.listThreads(await actorFor(req), { limit: req.query.limit, purpose: "chat" });
    return res.json({ success: true, threads });
  } catch (error) { return fail(res, error, "internal/list"); }
});

router.post("/internal/conversations", async (req, res) => {
  try {
    const thread = await internal.createMessage(await actorFor(req), req.body, { purpose: "chat" });
    return res.status(201).json({ success: true, thread });
  } catch (error) { return fail(res, error, "internal/create"); }
});

router.get("/internal/conversations/:id", async (req, res) => {
  try {
    const actor = await actorFor(req);
    const thread = await internal.threadFor(actor, req.params.id, { purpose: "chat" });
    if (!thread) return res.status(404).json({ success: false, message: "Conversation not found." });
    await internal.setThreadState(actor, req.params.id, { read: true }, { purpose: "chat" });
    return res.json({ success: true, thread: { ...thread, unread: false } });
  } catch (error) { return fail(res, error, "internal/thread"); }
});

router.post("/internal/conversations/:id/messages", async (req, res) => {
  try {
    const thread = await internal.reply(await actorFor(req), req.params.id, req.body, { purpose: "chat" });
    if (!thread) return res.status(404).json({ success: false, message: "Conversation not found." });
    return res.status(201).json({ success: true, thread });
  } catch (error) { return fail(res, error, "internal/reply"); }
});

router.get("/whatsapp/status", async (req, res) => {
  if (!isOpenWaActive()) {
    return res.json({ success: true, status: { provider: providerCfg.provider, configured: false, connected: false, live: false, error: "OpenWA is not the active WhatsApp provider." } });
  }
  const ready = configured();
  const health = ready
    ? await openwa.health()
    : { live: false, connected: false, sessionReady: false, error: "OpenWA credentials are incomplete." };
  return res.json({ success: true, status: { provider: "openwa", configured: ready, ...health } });
});

// A pairing QR is a credential. It is returned only by this explicit,
// authenticated Chat endpoint, never by health/status and never persisted.
router.get("/whatsapp/qr", async (req, res) => {
  try {
    if (!req.chatAccess?.capabilities?.write) {
      return res.status(403).json({ success: false, code: "CHAT_PAIRING_DENIED", message: "A Chat editor is required to link WhatsApp." });
    }
    const health = await openwa.health();
    if (health.connected) return res.status(409).json({ success: false, code: "OPENWA_ALREADY_CONNECTED", message: "WhatsApp is already connected." });
    res.set("Cache-Control", "no-store, private");
    return res.json({ success: true, ...(await openwa.qrCode()) });
  } catch (error) { return fail(res, error, "whatsapp/qr"); }
});

router.get("/whatsapp/media/:messageId", async (req, res) => {
  try {
    const message = await WhatsAppMessage.findById(req.params.messageId).lean();
    if (!message?.media?.id) return res.status(404).json({ success: false, message: "No media for this message." });
    const file = await openwa.downloadMedia(message.media.id);
    res.set("Content-Type", message.media.mimeType || file.mimeType || "application/octet-stream");
    res.set("Cache-Control", "private, max-age=86400");
    res.set("X-Content-Type-Options", "nosniff");
    return res.send(file.buffer);
  } catch (error) { return fail(res, error, "whatsapp/media"); }
});

router.get("/whatsapp/conversations", async (req, res) => {
  try {
    const filter = { isActive: true };
    if (req.query.search) {
      const escaped = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(escaped, "i");
      filter.$or = [{ displayName: match }, { phone: match }, { waId: match }];
    }
    const rows = await WhatsAppConversation.find(filter)
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 50, 200))
      .populate(...POP_ACCOUNT).populate(...POP_LEAD).lean();
    return res.json({ success: true, conversations: rows.map(externalConversation) });
  } catch (error) { return fail(res, error, "whatsapp/list"); }
});

router.post("/whatsapp/start", async (req, res) => {
  try {
    const row = await findOrCreateByPhone(req.body || {});
    const conversation = await WhatsAppConversation.findById(row._id).populate(...POP_ACCOUNT).populate(...POP_LEAD).lean();
    return res.status(201).json({ success: true, conversation: externalConversation(conversation) });
  } catch (error) { return fail(res, error, "whatsapp/start"); }
});

router.get("/whatsapp/conversations/:id/messages", async (req, res) => {
  try {
    const exists = await WhatsAppConversation.exists({ _id: req.params.id, isActive: true });
    if (!exists) return res.status(404).json({ success: false, message: "Conversation not found." });
    const messages = await WhatsAppMessage.find({ conversationId: req.params.id })
      .sort({ timestamp: 1, createdAt: 1 })
      .limit(Math.min(Number(req.query.limit) || 200, 500)).lean();
    return res.json({ success: true, messages });
  } catch (error) { return fail(res, error, "whatsapp/messages"); }
});

router.post("/whatsapp/conversations/:id/read", async (req, res) => {
  try {
    const result = await WhatsAppConversation.updateOne({ _id: req.params.id, isActive: true }, { $set: { unreadCount: 0 } });
    if (!result.matchedCount) return res.status(404).json({ success: false, message: "Conversation not found." });
    return res.json({ success: true });
  } catch (error) { return fail(res, error, "whatsapp/read"); }
});

router.post("/whatsapp/conversations/:id/messages", async (req, res) => {
  try {
    if (!isOpenWaActive()) return res.status(409).json({ success: false, code: "OPENWA_DORMANT", message: "External Chat requires OpenWA." });
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ success: false, message: "Message text is required." });
    const conversation = await WhatsAppConversation.findOne({ _id: req.params.id, isActive: true });
    if (!conversation) return res.status(404).json({ success: false, message: "Conversation not found." });
    const message = await sendText(conversation, text, { id: req.user?.id, name: req.user?.name });
    return res.status(201).json({ success: true, message });
  } catch (error) {
    if (error instanceof WhatsAppError) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
    return fail(res, error, "whatsapp/send");
  }
});

module.exports = router;
