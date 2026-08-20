// models/CMS_Models/Sales/WhatsAppMessage.js
//
// One WhatsApp message — inbound (from the customer) or outbound (from the CRM).
// Kept in its own collection, not embedded on the conversation, so history
// scales freely. `waMessageId` is Meta's own id and is unique, so a webhook
// that Meta retries can never create a duplicate row (upsert on it).
const mongoose = require("mongoose");

const MESSAGE_TYPES = ["text", "image", "document", "audio", "video", "sticker", "location", "contacts", "template", "interactive", "reaction", "unsupported"];
// Outbound lifecycle: accepted → sent → delivered → read (or failed). Inbound
// messages are simply "received".
const MESSAGE_STATUSES = ["received", "accepted", "sent", "delivered", "read", "failed"];

const whatsAppMessageSchema = new mongoose.Schema(
  {
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "WhatsAppConversation", index: true, required: true },
    waId: { type: String, index: true },              // denormalized customer id
    waMessageId: { type: String, index: true },       // Meta's message id (wamid.*)

    direction: { type: String, enum: ["incoming", "outgoing"], required: true },
    type: { type: String, enum: MESSAGE_TYPES, default: "text" },

    text: { type: String, trim: true },               // body / caption
    media: {
      id: { type: String },                           // Meta media id (download via Graph)
      mimeType: { type: String },
      filename: { type: String },
      url: { type: String },                          // once fetched + re-hosted
      caption: { type: String },
    },

    timestamp: { type: Date, index: true },
    status: { type: String, enum: MESSAGE_STATUSES, default: "received" },
    error: { type: String },                          // failure reason from Meta

    // Who sent an outbound message from the CRM.
    sentBy: {
      id: { type: mongoose.Schema.Types.ObjectId, ref: "SalesDepartment" },
      name: { type: String },
    },
  },
  { timestamps: true },
);

// Fast conversation history, newest last.
whatsAppMessageSchema.index({ conversationId: 1, timestamp: 1 });

module.exports = {
  WhatsAppMessage:
    mongoose.models.WhatsAppMessage || mongoose.model("WhatsAppMessage", whatsAppMessageSchema),
  MESSAGE_TYPES,
  MESSAGE_STATUSES,
};
