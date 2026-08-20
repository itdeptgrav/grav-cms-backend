// services/whatsappSend.js
//
// Sends messages via Meta's WhatsApp Cloud API and records the outbound row.
// The only place that ever talks OUT to Meta. The access token is read from
// config (env) and never leaves the backend.
const { cfg, canSend, messagesUrl } = require("../config/whatsapp");
const { WhatsAppMessage } = require("../models/CMS_Models/Sales/WhatsAppMessage");

class WhatsAppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "WhatsAppError";
    this.status = status;
  }
}

// POST one message to Meta, then persist it as an outgoing row with the id Meta
// hands back (so later delivery/read webhooks can find it).
async function sendMessage({ conv, payload, previewText, actor }) {
  if (!canSend()) {
    throw new WhatsAppError("WhatsApp sending isn't configured (set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID).", 503);
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
  return sendMessage({ conv, payload: { type: "text", text: { body: text } }, previewText: text, actor });
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
function sendTemplate(conv, { name, language = "en_US", components, bodyText } = {}, actor) {
  if (!name) throw new WhatsAppError("A template name is required.", 400);
  return sendMessage({
    conv,
    payload: { type: "template", template: { name, language: { code: language }, ...(components ? { components } : {}) } },
    previewText: renderTemplateText(name, bodyText, components),
    actor,
  });
}

module.exports = { sendText, sendTemplate, sendMessage, WhatsAppError };
