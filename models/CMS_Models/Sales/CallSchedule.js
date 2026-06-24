// models/CMS_Models/Sales/CallSchedule.js
const mongoose = require("mongoose");

const callScheduleSchema = new mongoose.Schema(
  {
    scheduleId: { type: String, unique: true },

    // Linked entity — either a Lead or a Contact
    entityType: {
      type: String,
      enum: ["lead", "contact"],
      required: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: "entityModel",
    },
    entityModel: {
      type: String,
      enum: ["Lead", "CRMContact"],
      required: true,
    },

    // Denormalized for display (so we don't always need a join)
    entityName: { type: String, trim: true },      // "Ravi Kumar"
    entityCompany: { type: String, trim: true },   // "ABC Textiles"
    entityPhone: { type: String, trim: true },
    entityEmail: { type: String, trim: true },
    entityStage: { type: String, trim: true },     // lead stage if lead

    // Schedule details
    scheduledAt: { type: Date, required: true },   // exact date+time in IST
    durationMinutes: { type: Number, default: 15 },
    callType: {
      type: String,
      enum: ["outbound", "inbound", "follow_up", "demo", "negotiation", "closing"],
      default: "outbound",
    },
    purpose: { type: String, trim: true },         // short note on agenda
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
    },

    // Status lifecycle
    status: {
      type: String,
      enum: ["scheduled", "in_progress", "completed", "missed", "rescheduled", "cancelled"],
      default: "scheduled",
    },

    // Post-call feedback (filled when status → completed / missed)
    outcome: {
      type: String,
      enum: [
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
    feedbackNotes: { type: String, trim: true },
    callDurationActual: { type: Number },          // actual minutes spent
    newLeadStage: { type: String, trim: true },    // stage to move lead to after call
    nextFollowUpAt: { type: Date },                // next follow-up date suggested

    // Rescheduling
    rescheduledTo: { type: Date },
    rescheduledReason: { type: String, trim: true },
    rescheduledCount: { type: Number, default: 0 },

    // Assignment
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
    },
    assignedToName: { type: String },

    // Reminder
    reminderSentAt: { type: Date },
    isReminderSent: { type: Boolean, default: false },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// Auto-generate scheduleId
callScheduleSchema.pre("save", async function (next) {
  if (!this.scheduleId) {
    const count = await mongoose.model("CallSchedule").countDocuments();
    this.scheduleId = `CALL-${String(count + 1).padStart(5, "0")}`;
  }
  next();
});

// Index for calendar queries
callScheduleSchema.index({ scheduledAt: 1, status: 1 });
callScheduleSchema.index({ assignedTo: 1, scheduledAt: 1 });
callScheduleSchema.index({ entityId: 1 });

module.exports = mongoose.model("CallSchedule", callScheduleSchema);