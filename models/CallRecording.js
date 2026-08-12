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
    contactName: { type: String, default: null },
    direction: { type: String, default: "UNKNOWN" }, // INCOMING | OUTGOING | UNKNOWN
    startTime: { type: Number }, // epoch millis (device)
    endTime: { type: Number, default: null },
    durationMillis: { type: Number, default: 0 },
    recordingMethod: { type: String, default: null },
    transcription: { type: String, default: null },
    summary: { type: String, default: null }, // JSON string or plain text
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

callRecordingSchema.index({ phoneNumber: 1 });
callRecordingSchema.index({ startTime: -1 });
callRecordingSchema.index({ driveFileId: 1 });

module.exports = mongoose.model("CallRecording", callRecordingSchema);
