// services/whatsappSend.js
//
// Sends messages through the explicitly selected WhatsApp provider and records
// the outbound row. OpenWA is the default; Meta is retained as a dormant
// adapter and is never used as an automatic fallback.
const crypto = require("crypto");
const { cfg, canSend, messagesUrl } = require("../config/whatsapp");
const { cfg: providerCfg, isOpenWaActive, isMetaActive } = require("../config/whatsappProvider");
const openwa = require("./openwaClient");
const { WhatsAppMessage } = require("../models/CMS_Models/Sales/WhatsAppMessage");

class WhatsAppError extends Error {
  constructor(message, status = 400, code = "whatsapp_error") {
    super(message);
    this.name = "WhatsAppError";
    this.status = status;
    this.code = code;
  }
}

// POST one message to Meta, then persist it as an outgoing row with the id Meta
// hands back (so later delivery/read webhooks can find it).
async function sendMessage({ conv, payload, previewText, actor }) {
  if (!isMetaActive()) {
    throw new WhatsAppError("The official WhatsApp API is dormant. OpenWA only supports this action as plain text.", 409, "provider_capability_unavailable");
  }
  if (!canSend()) {
    throw new WhatsAppError("The official WhatsApp API is selected but not configured.", 503, "provider_not_configured");
  }
  const res = await fetch(messagesUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: conv.waId, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new WhatsAppError(data?.error?.message || `WhatsApp send failed (${res.status}).`, res.status === 401 ? 502 : 502);
  }

  const stored = await WhatsAppMessage.create({
    conversationId: conv._id,
    waId: conv.waId,
    waMessageId: data?.messages?.[0]?.id,
    provider: "meta",
    direction: "outgoing",
    type: payload.type || "text",
    text: previewText,
    timestamp: new Date(),
    status: "sent",
    sentBy: actor?.id ? { id: actor.id, name: actor.name } : undefined,
  });

  conv.lastMessageAt = new Date();
  conv.lastMessagePreview = previewText;
  conv.lastDirection = "outgoing";
  await conv.save();
  return stored;
}

// Free-form text — only valid inside the 24-hour customer-service window (the
// route enforces that and returns a clear 409 otherwise).
function sendText(conv, text, actor) {
  if (isOpenWaActive()) return sendOpenWaText(conv, text, actor);
  return sendMessage({ conv, payload: { type: "text", text: { body: text } }, previewText: text, actor });
}

async function sendOpenWaText(conv, text, actor) {
  const result = await openwa.sendText(conv.waId, text);
  const providerId = typeof result === "string"
    ? result
    : result?._serialized || result?.id?._serialized || result?.id;
  const stored = await WhatsAppMessage.create({
    conversationId: conv._id,
    waId: conv.waId,
    waMessageId: providerId || `openwa:${providerCfg.openwaSessionId}:${crypto.randomUUID()}`,
    provider: "openwa",
    providerSessionId: providerCfg.openwaSessionId,
    direction: "outgoing",
    type: "text",
    text,
    timestamp: new Date(),
    status: "sent",
    sentBy: actor?.id ? { id: actor.id, name: actor.name } : undefined,
  });
  conv.lastMessageAt = stored.timestamp;
  conv.lastMessagePreview = text;
  conv.lastDirection = "outgoing";
  await conv.save();
  return stored;
}

// Render an approved template's body into the actual text that was sent, by
// substituting the {{1}}, {{2}}… placeholders with the body parameters. Falls
// back to a readable label if we don't have the body text. This is what we
// store/show in the chat bubble — not the raw "[template: name]".
function renderTemplateText(name, bodyText, components) {
  if (!bodyText) return `[template: ${name}]`;
  const body = (components || []).find((c) => String(c.type || "").toLowerCase() === "body");
  const params = body?.parameters || [];
  return bodyText.replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const p = params[Number(n) - 1];
    return p && p.text != null ? p.text : `{{${n}}}`;
  });
}

// An approved template — the way to (re)start a conversation outside the window.
// `bodyText` (the template's body with {{n}} placeholders) is passed from the UI
// so we can store the fully-rendered message in the chat, not a raw label.
//
// When the caller does NOT pass it, the body is looked up from the WABA's own
// template list (services/whatsappTemplates.js, cached) before falling back to
// the `[template: name]` placeholder. That fallback is what produced the rows
// the chat showed as "Sent the "Test" template." — a description of a message
// in place of the message — and this is the send-side half of making sure no
// new row is ever written that way. The read side is `withReadableText()`.
async function sendTemplate(conv, { name, language = "en_US", components, bodyText } = {}, actor) {
  if (isOpenWaActive()) {
    throw new WhatsAppError(
      "Approved Meta templates are unavailable while OpenWA is active. Send a normal message instead.",
      409,
      "templates_unavailable",
    );
  }
  if (!name) throw new WhatsAppError("A template name is required.", 400);
  const body = bodyText || (await require("./whatsappTemplates").resolveBody(name));
  return sendMessage({
    conv,
    payload: { type: "template", template: { name, language: { code: language }, ...(components ? { components } : {}) } },
    previewText: renderTemplateText(name, body, components),
    actor,
  });
}

module.exports = { sendText, sendTemplate, sendMessage, sendOpenWaText, WhatsAppError };
