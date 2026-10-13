// services/whatsappStore.js
//
// Turns a Meta WhatsApp webhook payload into CRM rows: upserts the conversation,
// stores each inbound message (idempotently — Meta retries webhooks, so we key
// on its own message id), and applies delivery-status updates to outbound ones.
// Pure persistence: it never calls Meta back.
const WhatsAppConversation = require("../models/CMS_Models/Sales/WhatsAppConversation");
const { serviceFilter } = require("./companyContext/serviceScope.service");
const { WhatsAppMessage } = require("../models/CMS_Models/Sales/WhatsAppMessage");

const DAY_MS = 24 * 60 * 60 * 1000;

// Digits only; compare on the last 10 so "+91 98765 43210" and "9876543210"
// and "919876543210" all reconcile.
const digits = (v) => String(v || "").replace(/\D/g, "");
const last10 = (v) => digits(v).slice(-10);

// Best-effort link a number to an existing Contact (→ its Account) or Lead.
// Guarded so a missing/edge model never breaks ingestion — linking is a bonus,
// storing the message is the job.

/* ── AN EXPLICIT COMPANY CONTEXT, NOT A GLOBAL READ ─────────────────────────
 * `ctx` is `{companyId, reason}` built by the trusted factory from an
 * already-authorised parent operation. No context means refusal, not a
 * lookup across every company — see services/companyContext/serviceScope.service.js. */
async function matchCrmRecords(waId, ctx) {
  const tail = last10(waId);
  const out = {};
  if (!tail) return out;
  try {
    const Contact = require("../models/CMS_Models/Sales/Contact");
    const contacts = await Contact.find(serviceFilter(ctx, { isActive: true, phone: { $regex: `${tail}$` } })).select("_id accountId").limit(1).lean();
    if (contacts[0]) {
      out.contactId = contacts[0]._id;
      if (contacts[0].accountId) out.accountId = contacts[0].accountId;
    }
  } catch { /* no Contact match */ }
  try {
    const Lead = require("../models/CMS_Models/Sales/Lead");
    const leads = await Lead.find(serviceFilter(ctx, { isActive: true, phone: { $regex: `${tail}$` } })).select("_id").limit(1).lean();
    if (leads[0]) out.leadId = leads[0]._id;
  } catch { /* no Lead match */ }
  return out;
}

async function upsertConversation({ waId, phone, name, at, inbound }) {
  let conv = await WhatsAppConversation.findOne({ waId });
  // WhatsApp's newer multi-device events may identify a chat by LID while the
  // contact itself still has a normal phone JID. Reuse an existing local or
  // country-coded conversation with the same last 10 digits, then canonicalise
  // it to the full phone id so replies do not split into a second thread.
  const tail = last10(waId);
  if (!conv && tail.length === 10) {
    conv = await WhatsAppConversation.findOne({ waId: { $regex: `${tail}$` } });
    if (conv && conv.waId !== waId) {
      conv.waId = waId;
      conv.phone = phone || `+${waId}`;
    }
  }
  if (!conv) {
    const links = await matchCrmRecords(waId);
    conv = new WhatsAppConversation({ waId, phone: phone || `+${waId}`, displayName: name, ...links });
  }
  if (name && !conv.displayName) conv.displayName = name;
  if (phone && !conv.phone) conv.phone = phone;
  if (inbound) {
    conv.windowExpiresAt = new Date((at || Date.now()) + DAY_MS);
    conv.unreadCount = (conv.unreadCount || 0) + 1;
  }
  await conv.save();
  return conv;
}

// Map a raw Meta message object to our stored shape.
//
// `contextId` (Meta's `m.context.id`) is captured for every type, not just
// button/interactive — carried through unconditionally is simpler than
// gating it per-type, and costs nothing when a caller doesn't use it.
function parseInbound(m) {
  const base = {
    waMessageId: m.id,
    type: m.type || "text",
    timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
    contextId: m.context?.id || undefined,
  };
  switch (m.type) {
    case "text":
      return { ...base, text: m.text?.body || "" };
    case "image": case "document": case "audio": case "video": case "sticker": {
      const media = m[m.type] || {};
      return { ...base, text: media.caption || "", media: { id: media.id, mimeType: media.mime_type, filename: media.filename, caption: media.caption } };
    }
    case "location":
      return { ...base, text: `📍 ${m.location?.latitude}, ${m.location?.longitude}${m.location?.name ? ` (${m.location.name})` : ""}` };
    // A tap on a TEMPLATE's quick-reply button — `m.button.text` is the
    // button's own label (what sampleWhatsapp.js's applyDecisionFromButtonReply
    // matches "approve"/"reject" against); `m.button.payload` also exists but
    // is only meaningful for buttons that declared a custom payload at
    // template-creation time, which an Approve/Reject pair doesn't need to.
    case "button":
      return { ...base, type: "interactive", text: m.button?.text || "" };
    // A tap on a FREE-STANDING interactive message's button/list (not a
    // template reply) — same shape, different Meta envelope.
    case "interactive":
      return { ...base, text: m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "" };
    case "reaction":
      return { ...base, text: m.reaction?.emoji || "" };
    default:
      return { ...base, type: "unsupported", text: `[${m.type || "unsupported"} message]` };
  }
}

const previewOf = (parsed) => parsed.text || (parsed.media ? `[${parsed.type}]` : `[${parsed.type}]`);

// The one entry point. Returns a small summary for logging/tests.
async function ingestWebhook(body) {
  const result = { messages: 0, statuses: 0 };
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contact = (value.contacts || [])[0];
      const profileName = contact?.profile?.name;
      const displayPhone = value.metadata?.display_phone_number;

      // Inbound messages.
      for (const m of value.messages || []) {
        const waId = m.from || contact?.wa_id;
        if (!waId) continue;
        const parsed = parseInbound(m);
        const conv = await upsertConversation({ waId, phone: `+${waId}`, name: profileName, at: parsed.timestamp.getTime(), inbound: true });
        // Idempotent on Meta's message id — a retried webhook updates in place.
        await WhatsAppMessage.updateOne(
          { waMessageId: parsed.waMessageId },
          { $setOnInsert: { conversationId: conv._id, waId, direction: "incoming", ...parsed, status: "received" } },
          { upsert: true },
        );
        conv.lastMessageAt = parsed.timestamp;
        conv.lastMessagePreview = previewOf(parsed);
        conv.lastDirection = "incoming";
        await conv.save();
        result.messages += 1;

        // A button tap replying to a message we sent — see if it's a
        // sample-approval request waiting on exactly this reply. Guarded so
        // a business-feature bug can never take down webhook ingestion for
        // every other inbound message in the same batch (this loop still
        // has more messages/entries to process after it).
        if (parsed.type === "interactive" && parsed.contextId) {
          try {
            await require("./sampleWhatsapp").applyDecisionFromButtonReply({
              contextMessageId: parsed.contextId,
              buttonText: parsed.text,
            });
          } catch (err) {
            console.error("[whatsapp] sample-approval button match failed:", err.message);
          }
        }
      }

      // Outbound delivery/read/failed status updates.
      for (const s of value.statuses || []) {
        const set = { status: s.status };
        if (s.errors?.length) set.error = s.errors[0]?.title || s.errors[0]?.message || "failed";
        await WhatsAppMessage.updateOne({ waMessageId: s.id }, { $set: set });
        result.statuses += 1;
      }
      void displayPhone;
    }
  }
  return result;
}

// OpenWA v5 emits { event, sessionId, payload: { message } }; stable v4
// installations commonly emit { event, data }. Accept both so the CMS-side
// contract does not force an unsafe runtime upgrade. Groups and messages sent
// by the linked account are ignored here: outbound CMS sends are already
// stored synchronously by whatsappSend.js.
const openWaMessage = (body) => body?.payload?.message || body?.data?.message || body?.data || body?.message;
const openWaEvent = (body) => String(body?.event || body?.eventName || "").toLowerCase();
const waIdFromChat = (value) => String(value || "").split("@")[0].replace(/\D/g, "");

function parseOpenWaInbound(body) {
  const message = openWaMessage(body);
  if (!message || typeof message !== "object") return null;
  const event = openWaEvent(body);
  if (event && !["message.received", "message.any", "onmessage", "message"].includes(event)) return null;
  if (message.fromMe === true || message.id?.fromMe === true || message.isGroupMsg === true) return null;

  const rawFrom = typeof message.from === "string"
    ? message.from
    : message.from?._serialized || message.chatId || message.author;
  const phoneJid = [
    message.sender?.phoneNumber,
    message.chat?.contact?.phoneNumber,
    message.chat?.historyChatId,
    message.sender?.id,
  ].find((value) => String(value || "").endsWith("@c.us"));
  // `@lid` is a private WhatsApp multi-device routing id, not a phone number.
  // Prefer the sender/contact phone JID included in the same OpenWA event.
  const from = String(rawFrom || "").endsWith("@lid") && phoneJid ? phoneJid : rawFrom;
  if (String(from || "").endsWith("@g.us")) return null;
  const waId = waIdFromChat(from);
  if (!waId) return null;

  const rawId = typeof message.id === "string"
    ? message.id
    : message.id?._serialized || message._serialized;
  const timestampValue = Number(message.timestamp || body?.timestamp || Date.now());
  const timestamp = new Date(timestampValue < 1e12 ? timestampValue * 1000 : timestampValue);
  const rawType = String(message.type || "chat").toLowerCase();
  const typeMap = { chat: "text", ptt: "audio", vcard: "contacts", multi_vcard: "contacts" };
  const type = typeMap[rawType] || (rawType === "text" ? "text" : rawType);
  const supported = ["text", "image", "document", "audio", "video", "sticker", "location", "contacts", "reaction"];
  const safeType = supported.includes(type) ? type : "unsupported";
  const isMedia = message.isMedia || ["image", "document", "audio", "video", "sticker"].includes(safeType);
  // OpenWA's `body` means two different things: chat text for a normal message,
  // but a base64 thumbnail for media. Never persist that thumbnail as message
  // copy (it produced enormous `/9j/...` strings in Contact Logs). Media bytes
  // are decrypted on demand through the protected OpenWA media endpoint.
  const text = isMedia
    ? (message.caption || "")
    : (message.text || message.body || (safeType === "unsupported" ? `[${rawType} message]` : ""));
  const media = isMedia
    ? {
        id: rawId,
        mimeType: message.mimetype || message.mimeType,
        filename: message.filename,
        caption: message.caption,
      }
    : undefined;

  return {
    waId,
    name: message.sender?.formattedName || message.sender?.name || message.sender?.pushname || message.notifyName || message.senderName,
    sessionId: body?.sessionId,
    parsed: {
      waMessageId: rawId || `openwa:${body?.sessionId || "sales"}:${waId}:${timestamp.getTime()}`,
      type: safeType,
      timestamp,
      contextId: message.quotedMsgId || message.quotedStanzaID || undefined,
      text,
      ...(media ? { media } : {}),
    },
  };
}

async function ingestOpenWaWebhook(body) {
  const result = { messages: 0, statuses: 0, ignored: 0 };
  const normalised = parseOpenWaInbound(body);
  if (!normalised) {
    result.ignored += 1;
    return result;
  }

  const { waId, name, sessionId, parsed } = normalised;
  // Webhook delivery is at-least-once. Check before incrementing the
  // conversation's unread count so a retry is truly idempotent in the inbox,
  // not merely idempotent in the message collection.
  if (await WhatsAppMessage.exists({ waMessageId: parsed.waMessageId })) {
    result.ignored += 1;
    return result;
  }

  const conv = await upsertConversation({
    waId,
    phone: `+${waId}`,
    name,
    at: parsed.timestamp.getTime(),
    inbound: true,
  });
  await WhatsAppMessage.create({
    conversationId: conv._id,
    waId,
    direction: "incoming",
    ...parsed,
    provider: "openwa",
    providerSessionId: sessionId,
    status: "received",
  });
  conv.lastMessageAt = parsed.timestamp;
  conv.lastMessagePreview = previewOf(parsed);
  conv.lastDirection = "incoming";
  await conv.save();
  result.messages = 1;
  return result;
}

// Find (or create) the conversation for a phone number — powers the "Message"
// button on a Lead/Account: given a customer's phone (and optionally the record
// to link), return the conversation to open. No message is sent here.
async function findOrCreateByPhone({ phone, accountId, leadId, contactId, name } = {}) {
  const waId = digits(phone);
  const tail = last10(phone);
  if (waId.length < 8) {
    const e = new Error("A valid phone number is required to start a WhatsApp chat.");
    e.status = 400;
    throw e;
  }
  // Match on the last 10 digits so the same number in any format (local vs.
  // country-coded) reuses one conversation instead of spawning a duplicate.
  let conv = await WhatsAppConversation.findOne({ waId: { $regex: `${tail}$` } });
  if (!conv) {
    const links = await matchCrmRecords(waId);
    conv = new WhatsAppConversation({ waId, phone: phone.trim(), displayName: name, ...links });
  }
  // Explicit links from the caller win over the fuzzy phone match.
  if (accountId) conv.accountId = accountId;
  if (leadId) conv.leadId = leadId;
  if (contactId) conv.contactId = contactId;
  if (name && !conv.displayName) conv.displayName = name;
  await conv.save();
  return conv;
}

module.exports = {
  ingestWebhook,
  ingestOpenWaWebhook,
  parseOpenWaInbound,
  matchCrmRecords,
  parseInbound,
  upsertConversation,
  findOrCreateByPhone,
};
