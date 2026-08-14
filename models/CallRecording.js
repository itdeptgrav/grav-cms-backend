"use strict";
const mongoose = require("mongoose");

/**
 * A call recording synced from the PersonalCallRecorder Android app.
 * Metadata lives here in MongoDB; the audio file lives in Google Drive
 * (driveFileId), uploaded via services/mediaUpload.service.uploadToGoogleDrive.
 */
const callRecordingSchema = new mongoose.Schema(
  {
    // Device-side identifiers / metadata (from the app's CallSyncPayload)
    localId: { type: Number },
    phoneNumber: { type: String, default: null },
    /**
     * Digits-only tail of `phoneNumber`, maintained by the pre-save hook below.
     *
     * The device reports the number however the dialer had it — `+91 98765
     * 43210`, `098765-43210`, `9876543210` — while the CRM stores whatever a
     * salesperson typed. Neither side is canonical, so matching a recording to
     * a customer has to happen on a normalized key. Same idea (and the same
     * helper shape) as `Lead.normalizedPhone`.
     */
    normalizedPhone: { type: String, default: null },
    contactName: { type: String, default: null },
    direction: { type: String, default: "UNKNOWN" }, // INCOMING | OUTGOING | UNKNOWN
    startTime: { type: Number }, // epoch millis (device)
    endTime: { type: Number, default: null },
    durationMillis: { type: Number, default: 0 },
    recordingMethod: { type: String, default: null },
    transcription: { type: String, default: null },
    summary: { type: String, default: null }, // JSON string or plain text

    /**
     * Server-side AI summary, kept SEPARATE from `summary`.
     *
     * `summary` is whatever the Android app shipped — sometimes a JSON blob,
     * sometimes plain text, often null. Overwriting it would destroy the
     * device's own record and make the two sources indistinguishable, so the
     * Gemini pass writes here instead and the UI prefers this when present.
     */
    aiSummary: { type: String, default: null },
    aiSummaryModel: { type: String, default: null },
    aiSummaryAt: { type: Date, default: null },
    notes: { type: String, default: null },
    audioFileName: { type: String, default: null },
    createdAtDevice: { type: Number },

    // Google Drive (audio file)
    driveFileId: { type: String, default: null },
    driveViewUrl: { type: String, default: null },
    driveDownloadUrl: { type: String, default: null },
    driveMimeType: { type: String, default: null },
    driveSize: { type: Number, default: 0 },

    source: { type: String, default: "personalcallrecorder" },
  },
  { timestamps: true },
);

// Keep the normalized key in step with whatever the device sent. Defined here
// rather than in the route so a backfill script or any other writer gets it too.
const { phoneKey } = require("../services/callRecordingMatch.service");
callRecordingSchema.pre("save", function (next) {
  if (this.isModified("phoneNumber")) this.normalizedPhone = phoneKey(this.phoneNumber);
  next();
});

callRecordingSchema.index({ phoneNumber: 1 });
callRecordingSchema.index({ normalizedPhone: 1 });
callRecordingSchema.index({ startTime: -1 });
callRecordingSchema.index({ driveFileId: 1 });

module.exports = mongoose.model("CallRecording", callRecordingSchema);
