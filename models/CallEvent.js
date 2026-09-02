"use strict";
const mongoose = require("mongoose");
const { phoneKey } = require("../services/callRecordingMatch.service");

/**
 * ONE schema for every call the PersonalCallRecorder app sees — answered,
 * missed, rejected, outgoing, recorded or not (21 Aug 2026, explicit
 * request: "make sure to store in one schema only... make sure to track
 * each and every situation"). Previously split across two collections —
 * this one (outcome only, written on every call end) and a separate
 * CallRecording (audio metadata, written only when a recording existed) —
 * which meant an answered, recorded call left two disconnected documents in
 * two collections instead of one complete record. CallRecording's model file
 * still exists for the historical rows already in it, but nothing writes to
 * it anymore; every route now targets this schema. See
 * services/callEventMatch.service.js for how the two device-side reports
 * (call outcome, then — only if it was recorded — the audio upload) get
 * correlated onto the SAME document instead of creating two.
 */
const callEventSchema = new mongoose.Schema(
  {
    // ── Who / which call ──────────────────────────────────────────────────
    // `phoneNumber` is the OTHER party — the customer. It is NOT the phone
    // this call was made from; see `ownerPhone` below for that.
    phoneNumber: { type: String, default: null },
    normalizedPhone: { type: String, default: null }, // digits-only key, for matching against CRM records
    contactName: { type: String, default: null },
    direction: { type: String, default: "UNKNOWN" }, // INCOMING | OUTGOING | UNKNOWN

    // ── WHOSE PHONE REPORTED THIS CALL ────────────────────────────────────
    //
    // Added 30 Aug 2026. Until now this schema stored exactly one number —
    // the customer's — so the log could say a four-minute call happened and
    // never who at GRAV made it. The device now reports the handset's own
    // number alongside the call, and `normalizedOwnerPhone` (digits-only,
    // last 10) is matched against the sales roster's snapshotted corporate
    // number — see models/CMS_Models/Sales/SalesPerson.js.
    //
    // OPTIONAL, AND OLD ROWS STAY NULL. Every call recorded before this
    // existed genuinely has no owner on record, and inventing one would be
    // worse than admitting it: the read routes label those "Unattributed"
    // rather than guessing.
    ownerPhone: { type: String, default: null },
    normalizedOwnerPhone: { type: String, default: null, index: true },

    // ── Outcome — from the app's CallEventReporter, off the device's own
    //    system call log, so every call gets a row even when nothing was
    //    ever recorded. ──────────────────────────────────────────────────
    callType: { type: String, default: "UNKNOWN" },   // INCOMING | OUTGOING | MISSED | REJECTED | BLOCKED | VOICEMAIL | ANSWERED_EXTERNALLY | UNKNOWN
    received: { type: Boolean, default: false },       // did it actually connect?
    rejected: { type: Boolean, default: false },       // explicitly declined (callType === REJECTED)
    durationSec: { type: Number, default: 0 },
    startTime: { type: Number },                       // epoch millis (call-log date)
    endTime: { type: Number, default: null },

    // ── Recording — only set when the call was answered AND actually
    //    recorded (device setting + a working capture strategy both have to
    //    hold; plenty of answered calls never get audio). Absent fields
    //    here, not a wrong value, is what "not recorded" looks like. ──────
    localId: { type: Number, default: null },          // the device's own local row id, for dedup on retry
    recordingMethod: { type: String, default: null },
    transcription: { type: String, default: null },
    summary: { type: String, default: null },          // device's own summary (JSON string or plain text) — never overwritten by the AI pass below
    notes: { type: String, default: null },
    audioFileName: { type: String, default: null },
    createdAtDevice: { type: Number, default: null },

    // ── Recording upload outcome ──────────────────────────────────────────
    // Whether the audio actually made it to Drive. The device reports a
    // FAILURE (with a reason) when it couldn't upload — no network, upload
    // error, or the recorder itself failed — so a call whose audio never
    // arrived is still visible with WHY, instead of silently missing.
    recordingUploadStatus: { type: String, default: null }, // "UPLOADED" | "FAILED" | null
    recordingError: { type: String, default: null },        // human-readable failure reason
    recordingErrorAt: { type: Date, default: null },

    // "call" (from the phone's call recorder) or "manual" (recorded in-app by
    // the rep when the contact wasn't over a phone call).
    kind: { type: String, default: "call" },

    // Server-side AI summary — kept separate from `summary` for the same
    // reason CallRecording kept them separate: `summary` is whatever the
    // device shipped (often null), and overwriting it would destroy that
    // and make the two sources indistinguishable.
    aiSummary: { type: String, default: null },
    aiSummaryModel: { type: String, default: null },
    aiSummaryAt: { type: Date, default: null },

    // Google Drive (the audio file itself)
    driveFileId: { type: String, default: null },
    driveViewUrl: { type: String, default: null },
    driveDownloadUrl: { type: String, default: null },
    driveMimeType: { type: String, default: null },
    driveSize: { type: Number, default: 0 },

    source: { type: String, default: "personalcallrecorder" },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

// Keep the normalized keys in step with their phone numbers (same helper as
// CallRecording, so the customer side and the owner side normalise
// identically — a match that depended on two different normalisations would
// work in testing and fail on the first number written in another format).
callEventSchema.pre("save", function (next) {
  if (this.isModified("phoneNumber")) this.normalizedPhone = phoneKey(this.phoneNumber);
  if (this.isModified("ownerPhone")) this.normalizedOwnerPhone = phoneKey(this.ownerPhone);
  next();
});

/** "if accept then the drive audio file" — the single field a UI needs to decide whether to show a player. */
callEventSchema.virtual("hasRecording").get(function () {
  return Boolean(this.driveFileId);
});

callEventSchema.index({ normalizedPhone: 1 });
callEventSchema.index({ startTime: -1 });
callEventSchema.index({ callType: 1 });
callEventSchema.index({ received: 1 });
callEventSchema.index({ audioFileName: 1 });

module.exports = mongoose.model("CallEvent", callEventSchema);
