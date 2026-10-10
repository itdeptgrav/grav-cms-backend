"use strict";

const mongoose = require("mongoose");
const { phoneKey } = require("../services/callRecordingMatch.service");

// A deliberately small phonebook owned by GRAV Voice. This is not CRM data:
// it has no account, lead, consent, journey or sales ownership relationship.
const voiceContactSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Acc_Company",
    required: true,
    immutable: true,
    index: true,
  },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  company: { type: String, default: "", trim: true, maxlength: 120 },
  phoneNumber: { type: String, required: true, trim: true },
  normalizedPhone: { type: String, required: true, trim: true },
  isActive: { type: Boolean, default: true },
  createdBy: {
    userId: { type: String, default: null, trim: true },
    employeeId: { type: String, default: null, trim: true },
  },
}, { timestamps: true });

voiceContactSchema.pre("validate", function setNormalizedPhone(next) {
  this.normalizedPhone = phoneKey(this.phoneNumber);
  next();
});

voiceContactSchema.pre("findOneAndUpdate", function normalizeUpdatedPhone(next) {
  const update = this.getUpdate() || {};
  const phoneNumber = update.$set?.phoneNumber ?? update.phoneNumber;
  if (phoneNumber != null) {
    update.$set = { ...(update.$set || {}), normalizedPhone: phoneKey(phoneNumber) };
    delete update.phoneNumber;
  }
  this.setUpdate(update);
  next();
});

voiceContactSchema.index(
  { companyId: 1, normalizedPhone: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);
voiceContactSchema.index({ companyId: 1, isActive: 1, name: 1 });

module.exports = mongoose.model("VoiceContact", voiceContactSchema);
