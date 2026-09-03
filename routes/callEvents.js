"use strict";
const express = require("express");
const router = express.Router();
const CallEvent = require("../models/CallEvent");
const { findMatchingCallEvent } = require("../services/callEventMatch.service");

/** Optional shared-secret (same scheme as callRecordings). */
function checkApiKey(req, res, next) {
  const expected = process.env.CALL_RECORDER_API_KEY;
  if (!expected) return next();
  if (req.get("x-api-key") === expected) return next();
  return res.status(401).json({ success: false, message: "Invalid or missing API key" });
}

/**
 * Whether a call actually connected — derived server-side from `callType`
 * (read straight off the device's own system call log by the app, the one
 * value here that isn't a client guess) rather than trusting the app's own
 * `received` boolean blindly. Mirrors CallLogEntry.received in the Android
 * app's CallLogResolver.kt exactly, so the two never disagree — but this is
 * now the SOURCE OF TRUTH: a client bug that ever miscomputes `received`
 * can't silently mislabel a missed call as answered once it reaches Mongo
 * (21 Aug 2026, explicit request — "if anything missing as per the data
 * sent by the app... let's handle those in the backend").
 */
function deriveReceived(callType, durationSec) {
  const d = Number(durationSec) || 0;
  switch (callType) {
    case "MISSED":
    case "REJECTED":
    case "BLOCKED":
      return false;
    case "INCOMING":
    case "ANSWERED_EXTERNALLY":
      return true;
    default:
      return d > 0;
  }
}

/** "whether call reject or not" — explicit declines only, never a plain unanswered ring. */
function deriveRejected(callType) {
  return callType === "REJECTED";
}

/**
 * POST /api/call-events   (application/json)
 * Logs one call's outcome (received/missed/rejected/etc) — no audio here,
 * see /api/recordings for that half. Writes into the SAME CallEvent document
 * a recording upload for this call would use (matched by phone + time
 * window, see callEventMatch.service), so a call reported here first and
 * recorded a moment later ends up as ONE document, not two.
 */
router.post("/", checkApiKey, async (req, res) => {
  try {
    const b = req.body || {};
    const phoneNumber = b.phoneNumber ?? null;
    const callType = b.callType ?? "UNKNOWN";
    const durationSec = b.durationSec ?? 0;
    const received = deriveReceived(callType, durationSec);
    const rejected = deriveRejected(callType);

    // WHOSE HANDSET THIS CAME FROM. Several spellings accepted because the
    // Android app, the recording uploader and any future device integration
    // each name it differently, and a call that arrives with the field under
    // an unexpected key would silently go unattributed — the exact failure
    // this was added to fix. Optional: a device that doesn't report it still
    // logs the call, just without an owner.
    const ownerPhone = b.ownerPhone ?? b.devicePhone ?? b.deviceOwnerPhone ?? b.selfPhone ?? null;

    let existing = b.startTime ? await findMatchingCallEvent(phoneNumber, b.startTime) : null;
    // The nearest document already describes a DIFFERENT call (it has its own
    // outcome and started noticeably earlier/later) — e.g. the same contact
    // called again a minute later. Give this call its own document instead of
    // overwriting the previous one's outcome.
    if (
      existing &&
      existing.callType && existing.callType !== "UNKNOWN" &&
      typeof existing.startTime === "number" &&
      Math.abs(existing.startTime - Number(b.startTime)) > 30_000
    ) {
      existing = null;
    }
    if (existing) {
      // Already has a document (most likely the recording upload for this
      // same call arrived first) — refresh the outcome fields onto it
      // rather than creating a second one.
      existing.contactName = b.contactName ?? existing.contactName;
      existing.direction = b.direction ?? existing.direction;
      existing.callType = callType;
      existing.received = received;
      existing.rejected = rejected;
      existing.durationSec = durationSec;
      existing.endTime = b.endTime ?? existing.endTime;
      // Only ever FILLS a gap. If the recording upload already established
      // whose phone this was, a later outcome report arriving without the
      // field must not blank it back out.
      if (ownerPhone) existing.ownerPhone = ownerPhone;
      // Why there's no audio (recording not set up on the phone). Never
      // overwrite a real uploaded recording with a stale note.
      if (b.recordingNote && !existing.driveFileId) {
        existing.recordingUploadStatus = "FAILED";
        existing.recordingError = String(b.recordingNote).slice(0, 500);
        existing.recordingErrorAt = new Date();
      }
      await existing.save();
      return res.json({ success: true, mongoId: String(existing._id), duplicate: true });
    }

    const doc = await CallEvent.create({
      phoneNumber,
      contactName: b.contactName ?? null,
      direction: b.direction ?? "UNKNOWN",
      callType,
      received,
      rejected,
      durationSec,
      startTime: b.startTime,
      endTime: b.endTime ?? null,
      ownerPhone,
      ...(b.recordingNote
        ? {
            recordingUploadStatus: "FAILED",
            recordingError: String(b.recordingNote).slice(0, 500),
            recordingErrorAt: new Date(),
          }
        : {}),
      source: b.source || "personalcallrecorder",
    });

    res.json({ success: true, mongoId: doc._id.toString() });
  } catch (error) {
    console.error("[callEvents] create failed:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/call-events — recent call events (verification). Every call, recorded or not. */
router.get("/", checkApiKey, async (_req, res) => {
  try {
    const items = await CallEvent.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json({ success: true, count: items.length, data: items });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
