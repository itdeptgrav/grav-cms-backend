// models/CMS_Models/Sales/WhatsAppConversation.js
//
// One WhatsApp conversation with a customer (keyed by their WhatsApp id / phone).
// The message BODIES live in a separate collection (WhatsAppMessage) so a busy
// conversation never grows the doc unbounded — this header just carries the
// summary the inbox list needs, plus the links to the CRM records this number
// belongs to (matched by phone on first inbound, or set by hand later).
const mongoose = require("mongoose");

const whatsAppConversationSchema = new mongoose.Schema(
  {
    // The customer's WhatsApp id — digits only, international format, no "+"
    // (exactly what Meta sends as `wa_id`). Unique: one conversation per number.
    waId: { type: String, required: true, unique: true, index: true },
    phone: { type: String, trim: true },              // display form, may carry "+"
    displayName: { type: String, trim: true },        // WhatsApp profile name

    // CRM links — best-effort matched from the phone on first contact; any can
    // be set/corrected from the UI later. None is required (a brand-new number
    // is a valid conversation before it's tied to anyone).
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", index: true },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", index: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMContact" },

    // Inbox summary.
    lastMessageAt: { type: Date, index: true },
    lastMessagePreview: { type: String, trim: true },
    lastDirection: { type: String, enum: ["incoming", "outgoing"] },
    unreadCount: { type: Number, default: 0 },

    // WhatsApp's 24-hour customer-service window: you can send free-form replies
    // until this time; after it you need an approved template. Set to the last
    // INBOUND message time + 24h.
    windowExpiresAt: { type: Date },

    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "SalesDepartment" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

whatsAppConversationSchema.index({ isActive: 1, lastMessageAt: -1 });

module.exports =
  mongoose.models.WhatsAppConversation ||
  mongoose.model("WhatsAppConversation", whatsAppConversationSchema);
