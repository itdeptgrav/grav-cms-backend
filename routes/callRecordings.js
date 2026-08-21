"use strict";
const express = require("express");
const router = express.Router();
const multer = require("multer");

const CallRecording = require("../models/CallRecording");
const { uploadToGoogleDrive } = require("../services/mediaUpload.service");

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
    const dedupeKey = metadata.audioFileName
      ? { audioFileName: metadata.audioFileName }
      : (metadata.startTime != null
          ? { startTime: metadata.startTime, phoneNumber: metadata.phoneNumber ?? null }
          : null);
    if (dedupeKey) {
      const existing = await CallRecording.findOne(dedupeKey)
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

    const doc = await CallRecording.create({
      localId: metadata.localId,
      phoneNumber: metadata.phoneNumber ?? null,
      contactName: metadata.contactName ?? null,
      direction: metadata.direction ?? "UNKNOWN",
      startTime: metadata.startTime,
      endTime: metadata.endTime ?? null,
      durationMillis: metadata.durationMillis ?? 0,
      recordingMethod: metadata.recordingMethod ?? null,
      transcription: metadata.transcription ?? null,
      summary: metadata.summary ?? null,
      notes: metadata.notes ?? null,
      audioFileName: metadata.audioFileName ?? null,
      createdAtDevice: metadata.createdAt,
      driveFileId: drive?.fileId ?? null,
      driveViewUrl: drive?.viewUrl ?? drive?.url ?? null,
      driveDownloadUrl: drive?.downloadUrl ?? null,
      driveMimeType: drive?.mimeType ?? null,
      driveSize: drive?.size ? Number(drive.size) : 0,
    });

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

/** GET /api/recordings — recent records (handy for verifying syncs). */
router.get("/", checkApiKey, async (_req, res) => {
  try {
    const items = await CallRecording.find().sort({ createdAt: -1 }).limit(50).lean();
    res.json({ success: true, count: items.length, data: items });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
