// models/CMS_Models/Sales/CRMSettings.js
//
// Singleton document — one settings record for the entire CRM.
// All arrays (stages, sources, etc.) are managed here so the UI never
// has hardcoded values.

const mongoose = require("mongoose");

const crmSettingsSchema = new mongoose.Schema(
  {
    // ── Lead Pipeline Stages ────────────────────────────────────────────────
    leadStages: {
      type: [
        {
          key: { type: String, trim: true },
          label: { type: String, trim: true },
          color: { type: String, default: "#6b7280" },
          order: { type: Number, default: 0 },
          isTerminal: { type: Boolean, default: false }, // won/lost
          isDefault: { type: Boolean, default: false },
        },
      ],
      default: [
        { key: "new",           label: "New",           color: "#6366f1", order: 1, isTerminal: false, isDefault: true },
        { key: "contacted",     label: "Contacted",     color: "#0ea5e9", order: 2, isTerminal: false, isDefault: false },
        { key: "qualified",     label: "Qualified",     color: "#f59e0b", order: 3, isTerminal: false, isDefault: false },
        { key: "proposal_sent", label: "Proposal Sent", color: "#8b5cf6", order: 4, isTerminal: false, isDefault: false },
        { key: "negotiation",   label: "Negotiation",   color: "#f97316", order: 5, isTerminal: false, isDefault: false },
        { key: "won",           label: "Won",           color: "#22c55e", order: 6, isTerminal: true,  isDefault: false },
        { key: "lost",          label: "Lost",          color: "#ef4444", order: 7, isTerminal: true,  isDefault: false },
      ],
    },

    // ── Lead / Contact Sources ──────────────────────────────────────────────
    leadSources: {
      type: [String],
      default: [
        "website",
        "referral",
        "cold_call",
        "trade_show",
        "social_media",
        "existing_customer",
        "advertisement",
        "walk_in",
        "other",
      ],
    },

    // ── Industries ──────────────────────────────────────────────────────────
    industries: {
      type: [String],
      default: [
        "garments",
        "retail",
        "wholesale",
        "export",
        "corporate",
        "school_uniform",
        "hospitality",
        "healthcare",
        "other",
      ],
    },

    // ── Call Outcome Options ────────────────────────────────────────────────
    callOutcomes: {
      type: [String],
      default: [
        "interested",
        "not_interested",
        "call_back_later",
        "no_answer",
        "busy",
        "wrong_number",
        "voicemail",
        "deal_closed",
        "follow_up_needed",
        "other",
      ],
    },

    // ── Call Types ──────────────────────────────────────────────────────────
    callTypes: {
      type: [String],
      default: ["outbound", "inbound", "follow_up", "demo", "negotiation", "closing"],
    },

    // ── Priority Levels ─────────────────────────────────────────────────────
    priorities: {
      type: [
        {
          key: { type: String },
          label: { type: String },
          color: { type: String },
        },
      ],
      default: [
        { key: "low",    label: "Low",    color: "#6b7280" },
        { key: "medium", label: "Medium", color: "#3b82f6" },
        { key: "high",   label: "High",   color: "#f59e0b" },
        { key: "urgent", label: "Urgent", color: "#ef4444" },
      ],
    },

    // ── Contact Types ───────────────────────────────────────────────────────
    contactTypes: {
      type: [String],
      default: ["lead", "prospect", "customer", "partner", "vendor", "other"],
    },

    // ── Account Types ───────────────────────────────────────────────────────
    accountTypes: {
      type: [String],
      default: ["prospect", "customer", "partner", "vendor", "competitor", "other"],
    },

    // ── Account Rating Labels ───────────────────────────────────────────────
    accountRatings: {
      type: [String],
      default: ["hot", "warm", "cold"],
    },

    // ── Activity Types ──────────────────────────────────────────────────────
    activityTypes: {
      type: [String],
      default: ["call", "email", "meeting", "note", "status_change", "task"],
    },

    // ── Working Hours (for calendar display) ───────────────────────────────
    workingHoursStart: { type: String, default: "09:00" }, // HH:mm
    workingHoursEnd:   { type: String, default: "18:00" },
    workingDays: {
      type: [Number],
      default: [1, 2, 3, 4, 5, 6], // Mon–Sat (0=Sun)
    },

    // ── Calendar default view ───────────────────────────────────────────────
    calendarDefaultView: {
      type: String,
      enum: ["day", "week", "month"],
      default: "week",
    },

    // ── Call reminder (minutes before) ─────────────────────────────────────
    callReminderMinutes: { type: Number, default: 15 },

    // ── Auto status to "missed" after N minutes past scheduledAt ───────────
    missedCallThresholdMinutes: { type: Number, default: 60 },

    // ── Tags pool ───────────────────────────────────────────────────────────
    tagPool: {
      type: [String],
      default: ["vip", "bulk-order", "repeat", "new", "dormant", "hot-prospect"],
    },

    // ── Lost reasons ────────────────────────────────────────────────────────
    lostReasons: {
      type: [String],
      default: [
        "Price too high",
        "Went with competitor",
        "No budget",
        "No response",
        "Project cancelled",
        "Requirement changed",
        "Other",
      ],
    },

    // ── Product / service interest options ─────────────────────────────────
    productInterestOptions: {
      type: [String],
      default: [
        "Corporate Uniforms",
        "School Uniforms",
        "Casual Wear",
        "Formal Wear",
        "Sports Wear",
        "Workwear",
        "Bulk Export",
        "Custom Embroidery",
        "Other",
      ],
    },
  },
  { timestamps: true },
);

// Singleton helper
crmSettingsSchema.statics.getSingleton = async function () {
  let settings = await this.findOne();
  if (!settings) settings = await this.create({});
  return settings;
};

module.exports = mongoose.model("CRMSettings", crmSettingsSchema);