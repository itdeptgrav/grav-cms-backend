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

    const doc = await CallEvent.create({
      phoneNumber: b.phoneNumber ?? null,
      contactName: b.contactName ?? null,
      direction: b.direction ?? "UNKNOWN",
      callType: b.callType ?? "UNKNOWN",
      received: !!b.received,
      durationSec: b.durationSec ?? 0,
      startTime: b.startTime,
      endTime: b.endTime ?? null,
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
