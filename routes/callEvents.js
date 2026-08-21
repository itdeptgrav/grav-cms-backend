"use strict";
const express = require("express");
const router = express.Router();
const CallEvent = require("../models/CallEvent");

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

/**
 * POST /api/call-events   (application/json)
 * Logs one call's outcome (received/missed/etc). No audio.
 * Idempotent on (startTime + phoneNumber) so a re-send doesn't duplicate.
 */
router.post("/", checkApiKey, async (req, res) => {
  try {
    const b = req.body || {};

    if (b.startTime) {
      const dup = await CallEvent.findOne({
        startTime: b.startTime,
        phoneNumber: b.phoneNumber ?? null,
      }).select("_id").lean();
      if (dup) return res.json({ success: true, mongoId: String(dup._id), duplicate: true });
    }

    const callType = b.callType ?? "UNKNOWN";
    const durationSec = b.durationSec ?? 0;
    const doc = await CallEvent.create({
      phoneNumber: b.phoneNumber ?? null,
      contactName: b.contactName ?? null,
      direction: b.direction ?? "UNKNOWN",
      callType,
      received: deriveReceived(callType, durationSec),
      durationSec,
      startTime: b.startTime,
      endTime: b.endTime ?? null,
      source: b.source || "personalcallrecorder",
    });

    res.json({ success: true, mongoId: doc._id.toString() });
  } catch (error) {
    console.error("[callEvents] create failed:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/call-events — recent call events (verification). */
router.get("/", checkApiKey, async (_req, res) => {
  try {
    const items = await CallEvent.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json({ success: true, count: items.length, data: items });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
