"use strict";

const mongoose = require("mongoose");

const morningBriefSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  time: { type: String, default: "09:15", match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  weekdays: { type: [Number], default: () => [1, 2, 3, 4, 5] },
  language: { type: String, enum: ["en", "hi", "or"], default: "en" },
  lastScheduledLocalDate: { type: String, default: "" },
}, { _id: false });

const schema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  employee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
  biometricId: { type: String, trim: true, required: true, index: true },
  timezone: { type: String, enum: ["Asia/Kolkata"], default: "Asia/Kolkata" },
  morningBrief: { type: morningBriefSchema, default: () => ({}) },
}, { timestamps: true, collection: "voice_automation_preferences" });

schema.index({ companyId: 1, employee: 1 }, { unique: true, name: "one_voice_preference_per_employee" });

module.exports = mongoose.models.VoiceAutomationPreference
  || mongoose.model("VoiceAutomationPreference", schema);

