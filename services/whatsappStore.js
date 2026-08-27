// services/whatsappStore.js
//
// Turns a Meta WhatsApp webhook payload into CRM rows: upserts the conversation,
// stores each inbound message (idempotently — Meta retries webhooks, so we key
// on its own message id), and applies delivery-status updates to outbound ones.
// Pure persistence: it never calls Meta back.
const WhatsAppConversation = require("../models/CMS_Models/Sales/WhatsAppConversation");
const { WhatsAppMessage } = require("../models/CMS_Models/Sales/WhatsAppMessage");

const DAY_MS = 24 * 60 * 60 * 1000;

// Digits only; compare on the last 10 so "+91 98765 43210" and "9876543210"
// and "919876543210" all reconcile.
const digits = (v) => String(v || "").replace(/\D/g, "");
const last10 = (v) => digits(v).slice(-10);

// Best-effort link a number to an existing Contact (→ its Account) or Lead.
// Guarded so a missing/edge model never breaks ingestion — linking is a bonus,
// storing the message is the job.
async function matchCrmRecords(waId) {
  const tail = last10(waId);
  const out = {};
  if (!tail) return out;
  try {
    const Contact = require("../models/CMS_Models/Sales/Contact");
    const contacts = await Contact.find({ isActive: true, phone: { $regex: `${tail}$` } }).select("_id accountId").limit(1).lean();
    if (contacts[0]) {
      out.contactId = contacts[0]._id;
      if (contacts[0].accountId) out.accountId = contacts[0].accountId;
    }
  } catch { /* no Contact match */ }
  try {
    const Lead = require("../models/CMS_Models/Sales/Lead");
    const leads = await Lead.find({ isActive: true, phone: { $regex: `${tail}$` } }).select("_id").limit(1).lean();
    if (leads[0]) out.leadId = leads[0]._id;
  } catch { /* no Lead match */ }
  return out;
}

async function upsertConversation({ waId, phone, name, at, inbound }) {
  let conv = await WhatsAppConversation.findOne({ waId });
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

module.exports = { ingestWebhook, matchCrmRecords, parseInbound, upsertConversation, findOrCreateByPhone };
