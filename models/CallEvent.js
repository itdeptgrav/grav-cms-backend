"use strict";
const mongoose = require("mongoose");
const { phoneKey } = require("../services/callRecordingMatch.service");

/**
 * A single call's outcome from the PersonalCallRecorder app — logged for EVERY
 * call (answered, missed, rejected, outgoing), whether or not it was recorded.
 * Recordings (with audio) live separately in CallRecording; join by normalizedPhone.
 */
const callEventSchema = new mongoose.Schema(
  {
    phoneNumber: { type: String, default: null },
    normalizedPhone: { type: String, default: null }, // digits-only key, like CallRecording
    contactName: { type: String, default: null },
    direction: { type: String, default: "UNKNOWN" }, // INCOMING | OUTGOING | UNKNOWN
    callType: { type: String, default: "UNKNOWN" },   // INCOMING | OUTGOING | MISSED | REJECTED | BLOCKED | VOICEMAIL | ANSWERED_EXTERNALLY | UNKNOWN
    received: { type: Boolean, default: false },       // was it actually answered/connected?
    durationSec: { type: Number, default: 0 },
    startTime: { type: Number },                       // epoch millis (call-log date)
    endTime: { type: Number, default: null },
    source: { type: String, default: "personalcallrecorder" },
  },
  { timestamps: true },
);

// Keep the normalized key in step with the phone number (same helper as CallRecording).
callEventSchema.pre("save", function (next) {
  if (this.isModified("phoneNumber")) this.normalizedPhone = phoneKey(this.phoneNumber);
  next();
});

callEventSchema.index({ normalizedPhone: 1 });
callEventSchema.index({ startTime: -1 });
callEventSchema.index({ callType: 1 });
callEventSchema.index({ received: 1 });

module.exports = mongoose.model("CallEvent", callEventSchema);
