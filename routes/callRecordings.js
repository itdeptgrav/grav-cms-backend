"use strict";
const express = require("express");
const router = express.Router();
const multer = require("multer");

const CallEvent = require("../models/CallEvent");
const { uploadToGoogleDrive } = require("../services/mediaUpload.service");
const { findMatchingCallEvent } = require("../services/callEventMatch.service");

// Keep the file in memory, then stream to Drive. Cap at 100 MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

/**
 * Optional shared-secret. If CALL_RECORDER_API_KEY is set in .env, requests must
 * send it as the `x-api-key` header. If it's not set, the endpoint is open
 * (fine for first testing; set the key before exposing publicly).
 */
function checkApiKey(req, res, next) {
  const expected = process.env.CALL_RECORDER_API_KEY;
  if (!expected) return next();
  if (req.get("x-api-key") === expected) return next();
  return res.status(401).json({ success: false, message: "Invalid or missing API key" });
}

/**
 * POST /api/recordings   (multipart/form-data)
 *   metadata : JSON string (CallSyncPayload)
 *   audio    : the recording file
 * → { success, mongoId, driveFileId, driveViewUrl }
 *
 * ONE SCHEMA (21 Aug 2026, explicit request): this used to create its own
 * CallRecording document in a second collection. It now attaches the
 * recording onto the SAME CallEvent document /api/call-events wrote for
 * this call (matched by phone + time window — see
 * services/callEventMatch.service.js) — an answered, recorded call is one
 * document with both the outcome and the audio, not two documents in two
 * collections. If no matching event exists yet (call-event reporting
 * disabled, or this report arrived first), a CallEvent is created here
 * instead — still the one schema, just created from the recording side.
 */
router.post("/", checkApiKey, upload.single("audio"), async (req, res) => {
  try {
    let metadata = {};
    if (req.body && req.body.metadata) {
      try {
        metadata = JSON.parse(req.body.metadata);
      } catch (e) {
        return res.status(400).json({ success: false, message: "metadata is not valid JSON" });
      }
    }

    // Idempotency: if this exact recording was already stored (e.g. the app
    // retried after a lost response), return the existing doc instead of
    // re-uploading to Drive + duplicating in Mongo.
    if (metadata.audioFileName) {
      const existing = await CallEvent.findOne({ audioFileName: metadata.audioFileName, driveFileId: { $ne: null } })
        .select("_id driveFileId driveViewUrl")
        .lean();
      if (existing) {
        return res.json({
          success: true,
          mongoId: String(existing._id),
          driveFileId: existing.driveFileId,
          driveViewUrl: existing.driveViewUrl,
          duplicate: true,
        });
      }
    }

    let drive = null;
    if (req.file) {
      drive = await uploadToGoogleDrive(req.file.buffer, {
        fileName: req.file.originalname || metadata.audioFileName || `recording-${Date.now()}.wav`,
        mimeType: req.file.mimetype || "audio/wav",
      });
    }

    const recordingFields = {
      localId: metadata.localId ?? null,
      recordingMethod: metadata.recordingMethod ?? null,
      transcription: metadata.transcription ?? null,
      summary: metadata.summary ?? null,
      notes: metadata.notes ?? null,
      audioFileName: metadata.audioFileName ?? null,
      createdAtDevice: metadata.createdAt ?? null,
      driveFileId: drive?.fileId ?? null,
      driveViewUrl: drive?.viewUrl ?? drive?.url ?? null,
      driveDownloadUrl: drive?.downloadUrl ?? null,
      driveMimeType: drive?.mimeType ?? null,
      driveSize: drive?.size ? Number(drive.size) : 0,
      kind: metadata.kind || "call",
      // Audio arrived — clear any earlier "failed to upload" marker.
      recordingUploadStatus: drive ? "UPLOADED" : undefined,
      recordingError: drive ? null : undefined,
      recordingErrorAt: drive ? null : undefined,
    };

    let doc = await findMatchingCallEvent(metadata.phoneNumber ?? null, metadata.startTime);
    // If the nearest document ALREADY holds a (different) recording, this is a
    // separate call from the same number — give it its own document rather
    // than overwriting the earlier call's audio. (The idempotency check above
    // already handled the "same file re-sent" case.)
    if (doc && doc.driveFileId) doc = null;
    if (doc) {
      Object.assign(doc, recordingFields);
      // A recording only ever exists for a call that connected — fill this
      // in for the (rare) case the outcome report never arrives, without
      // ever downgrading a status the outcome report already set correctly.
      if (!doc.received) doc.received = true;
      await doc.save();
    } else {
      doc = await CallEvent.create({
        phoneNumber: metadata.phoneNumber ?? null,
        contactName: metadata.contactName ?? null,
        direction: metadata.direction ?? "UNKNOWN",
        callType: "UNKNOWN", // no call-log outcome reached us for this one — the recording is the only evidence
        received: true,
        rejected: false,
        durationSec: Math.round((metadata.durationMillis ?? 0) / 1000),
        startTime: metadata.startTime,
        endTime: metadata.endTime ?? null,
        ...recordingFields,
      });
    }

    // The app reads mongoId + driveFileId from the top level.
    return res.json({
      success: true,
      mongoId: doc._id.toString(),
      driveFileId: doc.driveFileId,
      driveViewUrl: doc.driveViewUrl,
    });
  } catch (error) {
    console.error("[callRecordings] upload failed:", error);
    return res.status(500).json({ success: false, message: "Upload failed", error: error.message });
  }
});

/**
 * POST /api/recordings/failure   (application/json)
 * Reports that a call happened but its audio could NOT be uploaded (no network,
 * upload error, or the recorder failed). Records the number, duration and the
 * REASON onto the same CallEvent, so the CMS shows the contact + why the audio
 * is missing instead of losing it silently. Never carries audio.
 */
router.post("/failure", checkApiKey, async (req, res) => {
  try {
    const b = req.body || {};
    const fields = {
      recordingUploadStatus: "FAILED",
      recordingError: (b.error || "Upload failed").toString().slice(0, 500),
      recordingErrorAt: new Date(),
      recordingMethod: b.recordingMethod ?? undefined,
      audioFileName: b.audioFileName ?? undefined,
      localId: b.localId ?? undefined,
      kind: b.kind || "call",
    };

    // Attach to the existing CallEvent for this call if we can find it; else
    // create one so the failed-to-send call is still recorded.
    let doc = b.startTime ? await findMatchingCallEvent(b.phoneNumber ?? null, b.startTime) : null;
    if (doc) {
      // Don't overwrite a real successful upload with a stale failure report.
      if (!doc.driveFileId) Object.assign(doc, fields);
      else return res.json({ success: true, mongoId: String(doc._id), note: "already uploaded; ignored" });
      await doc.save();
    } else {
      doc = await CallEvent.create({
        phoneNumber: b.phoneNumber ?? null,
        contactName: b.contactName ?? null,
        direction: b.direction ?? "UNKNOWN",
        callType: b.callType ?? "UNKNOWN",
        received: b.received ?? true,
        durationSec: b.durationSec ?? (b.durationMillis ? Math.round(b.durationMillis / 1000) : 0),
        startTime: b.startTime,
        endTime: b.endTime ?? null,
        source: b.source || "gravemployeetracker",
        ...fields,
      });
    }
    res.json({ success: true, mongoId: String(doc._id) });
  } catch (error) {
    console.error("[callRecordings] failure report error:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/recordings — recent recorded calls (handy for verifying syncs). */
router.get("/", checkApiKey, async (_req, res) => {
  try {
    const items = await CallEvent.find({ driveFileId: { $ne: null } }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ success: true, count: items.length, data: items });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
