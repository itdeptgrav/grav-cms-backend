"use strict";

const mongoose = require("mongoose");

const transcriptSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  speaker: { type: String, enum: ["WORKFLOW", "APPROVER", "QWEN"], required: true },
  text: { type: String, trim: true, maxlength: 2000, required: true },
  intent: { type: String, trim: true, maxlength: 40, default: "" },
  confidence: { type: Number, min: 0, max: 1, default: null },
}, { _id: false });

const schema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  /* Kept in the established collection while delivery is generalised. MRF
     remains the default; read-only workflows leave `mrf` empty and carry an
     occurrence key plus bounded snapshot instead. */
  workflowKey: { type: String, enum: ["mrf_approval", "morning_brief"], default: "mrf_approval", index: true },
  occurrenceKey: { type: String, trim: true, default: "" },
  mrf: { type: mongoose.Schema.Types.ObjectId, ref: "MRF", default: null, index: true },
  mrfNumber: { type: String, trim: true, default: "" },
  subjectLabel: { type: String, trim: true, maxlength: 160, default: "" },
  workflowTitle: { type: String, trim: true, maxlength: 160, default: "" },
  workflowSummary: { type: String, trim: true, maxlength: 1800, default: "" },
  workflowSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  approverEmployee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
  approverBiometricId: { type: String, trim: true, required: true, index: true },
  approverName: { type: String, trim: true, default: "" },
  requestedForName: { type: String, trim: true, default: "" },
  requestedForDept: { type: String, trim: true, default: "" },
  itemSummary: { type: String, trim: true, maxlength: 500, default: "" },
  // IT's voice lab uses the same media and dialog pipeline without attaching
  // the conversation to a real material request or granting approval power.
  isTest: { type: Boolean, default: false, index: true },
  // Test-only steering for the private dialogue model. Production MRF creation
  // never sets this field and it cannot expand the worker's authority.
  qwenLabInstruction: { type: String, trim: true, maxlength: 1200, default: "" },
  language: { type: String, enum: ["en", "hi", "or"], default: "en" },
  status: {
    type: String,
    enum: [
      "QUEUED", "RINGING", "CONNECTED", "AWAITING_INTENT",
      "AWAITING_CONFIRMATION", "DECISION_READY", "APPROVED", "REJECTED", "DEFERRED",
      "COMPLETED", "NO_ANSWER", "CANCELLED", "STALE", "FAILED",
    ],
    default: "QUEUED",
    index: true,
  },
  roomName: { type: String, trim: true, default: "" },
  dispatchId: { type: String, trim: true, default: "" },
  pendingIntent: { type: String, enum: ["", "APPROVE", "REJECT"], default: "" },
  rejectionReason: { type: String, trim: true, maxlength: 500, default: "" },
  transcript: { type: [transcriptSchema], default: [] },
  ringingAt: { type: Date, default: null },
  answeredAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
  failureCode: { type: String, trim: true, default: "" },
  failureMessage: { type: String, trim: true, maxlength: 500, default: "" },
}, { timestamps: true, optimisticConcurrency: true });

schema.index(
  { companyId: 1, mrf: 1, approverBiometricId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["QUEUED", "RINGING", "CONNECTED", "AWAITING_INTENT", "AWAITING_CONFIRMATION"] },
    },
    name: "one_active_mrf_voice_approval",
  },
);
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60, name: "expire_voice_approval_audit" });
schema.index(
  { occurrenceKey: 1 },
  { unique: true, partialFilterExpression: { occurrenceKey: { $type: "string", $gt: "" } }, name: "one_voice_workflow_occurrence" },
);

module.exports = mongoose.models.MrfVoiceApprovalSession
  || mongoose.model("MrfVoiceApprovalSession", schema);
