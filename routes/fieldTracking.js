"use strict";
const express = require("express");
const router = express.Router();

const FieldTrackingSession = require("../models/FieldTrackingSession");
const FieldLocationPing = require("../models/FieldLocationPing");
const { reverseGeocode } = require("../services/reverseGeocode.service");

/**
 * Fill in a session's human place names from OpenStreetMap, without blocking the
 * device request that triggered it (fire-and-forget). Only sets startPlaceName
 * once, and refreshes lastPlaceName as the rep moves.
 */
async function enrichSessionPlaces(sessionId, startPoint, lastPoint) {
  try {
    const session = await FieldTrackingSession.findOne({ sessionId }).select(
      "startPlaceName lastPlaceName",
    );
    if (!session) return;
    const update = {};
    if (!session.startPlaceName && startPoint) {
      const g = await reverseGeocode(startPoint.lat, startPoint.lng);
      if (g && g.short) update.startPlaceName = g.short;
    }
    if (lastPoint) {
      const g = await reverseGeocode(lastPoint.lat, lastPoint.lng);
      if (g && g.short) update.lastPlaceName = g.short;
    }
    if (Object.keys(update).length) {
      await FieldTrackingSession.updateOne({ sessionId }, { $set: update });
    }
  } catch (_e) {
    /* geocoding is best-effort; never let it break tracking */
  }
}

/**
 * Employee field tracking (Grav Employee Tracker Android app → CMS).
 *
 * Base: /api/field-tracking
 *   POST /session/start        open (or re-open) a duty
 *   POST /ping                 append a batch of GPS fixes
 *   POST /session/stop         close a duty
 *   GET  /sessions             list sessions (filter by employeeId / date / active)
 *   GET  /live                 sessions active right now, with last position
 *   GET  /employees            distinct employees that have any session
 *   GET  /session/:sessionId   one session's summary
 *   GET  /session/:sessionId/points   the route (ordered fixes)
 *
 * Auth: the same optional shared secret as the call routes. If
 * CALL_RECORDER_API_KEY is set, writes must carry it as `x-api-key`. Reads used
 * by the CMS are left open (the CMS itself is already behind login).
 */
function checkApiKey(req, res, next) {
  const expected = process.env.CALL_RECORDER_API_KEY;
  if (!expected) return next();
  if (req.get("x-api-key") === expected) return next();
  return res.status(401).json({ success: false, message: "Invalid or missing API key" });
}

// ── Writes (from the device) ──────────────────────────────────────────────

/** POST /session/start — idempotent by sessionId. */
router.post("/session/start", checkApiKey, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.sessionId) {
      return res.status(400).json({ success: false, message: "sessionId is required" });
    }
    const doc = await FieldTrackingSession.findOneAndUpdate(
      { sessionId: b.sessionId },
      {
        $setOnInsert: {
          sessionId: b.sessionId,
          startTime: b.startTime ?? Date.now(),
        },
        $set: {
          employeeId: b.employeeId ?? "",
          employeeName: b.employeeName ?? "",
          deviceId: b.deviceId ?? "",
          active: true,
          source: b.source || "gravemployeetracker",
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    const io = req.app.get("io");
    if (io) io.emit("field_tracking:start", { sessionId: doc.sessionId, employeeId: doc.employeeId, employeeName: doc.employeeName });
    res.json({ success: true, sessionId: doc.sessionId, mongoId: String(doc._id) });
  } catch (error) {
    console.error("[fieldTracking] session/start failed:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

/** POST /ping — a batch of fixes for one session. */
router.post("/ping", checkApiKey, async (req, res) => {
  try {
    const b = req.body || {};
    const sessionId = b.sessionId;
    const points = Array.isArray(b.points) ? b.points : [];
    if (!sessionId || points.length === 0) {
      return res.status(400).json({ success: false, message: "sessionId and points[] are required" });
    }

    const employeeId = b.employeeId ?? "";
    const placeName = typeof b.placeName === "string" ? b.placeName.trim() : "";
    const docs = points
      .filter((p) => p && typeof p.lat === "number" && typeof p.lng === "number")
      .map((p) => ({
        sessionId,
        employeeId,
        lat: p.lat,
        lng: p.lng,
        accuracy: p.accuracy ?? 0,
        speed: p.speed ?? 0,
        bearing: p.bearing ?? 0,
        timestamp: p.timestamp ?? Date.now(),
        cumulativeDistance: p.cumulativeDistance ?? 0,
        source: b.source || "gravemployeetracker",
      }));

    let inserted = 0;
    if (docs.length) {
      try {
        // ordered:false → a duplicate (re-sent) fix is skipped, the rest insert.
        const r = await FieldLocationPing.insertMany(docs, { ordered: false });
        inserted = r.length;
      } catch (e) {
        // Duplicate-key errors are expected on re-send; count what did insert.
        inserted = e.result?.nInserted ?? e.insertedDocs?.length ?? 0;
        if (e.code !== 11000 && !e.writeErrors) throw e;
      }
    }

    // Update the session's denormalised aggregates from the newest point.
    const newest = docs.reduce((a, c) => (c.timestamp > (a?.timestamp ?? -1) ? c : a), null);
    const earliest = docs.reduce((a, c) => (c.timestamp < (a?.timestamp ?? Infinity) ? c : a), null);
    const maxDistance = docs.reduce((m, c) => Math.max(m, c.cumulativeDistance || 0), 0);
    const totalPoints = await FieldLocationPing.countDocuments({ sessionId });

    await FieldTrackingSession.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          active: true,
          pointCount: totalPoints,
          lastLat: newest?.lat ?? undefined,
          lastLng: newest?.lng ?? undefined,
          lastPingAt: new Date(),
          ...(employeeId ? { employeeId } : {}),
        },
        $max: { totalDistanceMeters: maxDistance },
        $setOnInsert: { sessionId, startTime: newest?.timestamp ?? Date.now() },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );

    // Place names: PREFER the name the phone already resolved on-device (it
    // matches what the rep sees and is usually more precise). Fall back to the
    // free server-side geocoder only when the app didn't send one.
    if (placeName) {
      await FieldTrackingSession.updateOne({ sessionId }, { $set: { lastPlaceName: placeName } });
      await FieldTrackingSession.updateOne(
        { sessionId, $or: [{ startPlaceName: "" }, { startPlaceName: null }] },
        { $set: { startPlaceName: placeName } },
      );
    } else if (newest) {
      enrichSessionPlaces(sessionId, earliest, newest);
    }

    // Real-time push to any CMS map open right now (Socket.IO).
    const io = req.app.get("io");
    if (io && newest) {
      io.emit("field_tracking:update", {
        sessionId,
        employeeId,
        employeeName: b.employeeName || "",
        lat: newest.lat,
        lng: newest.lng,
        speed: newest.speed || 0,
        bearing: newest.bearing || 0,
        accuracy: newest.accuracy || 0,
        totalDistanceMeters: maxDistance,
        pointCount: totalPoints,
        lastPlaceName: placeName || undefined,
        active: true,
        lastPingAt: Date.now(),
      });
    }

    res.json({ success: true, inserted, totalPoints });
  } catch (error) {
    console.error("[fieldTracking] ping failed:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

/** POST /session/stop — close a duty. */
router.post("/session/stop", checkApiKey, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.sessionId) {
      return res.status(400).json({ success: false, message: "sessionId is required" });
    }
    const update = {
      $set: {
        active: false,
        endTime: b.endTime ?? Date.now(),
      },
    };
    if (typeof b.totalDistanceMeters === "number") {
      update.$max = { totalDistanceMeters: b.totalDistanceMeters };
    }
    const doc = await FieldTrackingSession.findOneAndUpdate({ sessionId: b.sessionId }, update, { new: true });
    if (!doc) return res.status(404).json({ success: false, message: "Unknown sessionId" });
    // Final place name from the last known position.
    if (typeof doc.lastLat === "number" && typeof doc.lastLng === "number") {
      enrichSessionPlaces(doc.sessionId, null, { lat: doc.lastLat, lng: doc.lastLng });
    }
    const io = req.app.get("io");
    if (io) io.emit("field_tracking:stop", { sessionId: doc.sessionId, totalDistanceMeters: doc.totalDistanceMeters });
    res.json({ success: true, sessionId: doc.sessionId, totalDistanceMeters: doc.totalDistanceMeters });
  } catch (error) {
    console.error("[fieldTracking] session/stop failed:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Reads (for the CMS) ────────────────────────────────────────────────────

/** GET /sessions?employeeId=&date=YYYY-MM-DD&active=true&limit= */
router.get("/sessions", async (req, res) => {
  try {
    const q = {};
    if (req.query.employeeId) q.employeeId = req.query.employeeId;
    if (req.query.active === "true") q.active = true;
    if (req.query.active === "false") q.active = false;
    if (req.query.date) {
      // Interpret the calendar day in the server's local zone as a start/end
      // epoch-ms window over the device startTime.
      const day = new Date(req.query.date + "T00:00:00");
      if (!isNaN(day.getTime())) {
        const start = day.getTime();
        const end = start + 24 * 60 * 60 * 1000;
        q.startTime = { $gte: start, $lt: end };
      }
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const items = await FieldTrackingSession.find(q).sort({ startTime: -1 }).limit(limit).lean();
    res.json({ success: true, count: items.length, data: items });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /live — sessions that pinged recently and are still marked active. */
router.get("/live", async (req, res) => {
  try {
    const staleMs = (parseInt(req.query.staleMinutes, 10) || 3) * 60 * 1000;
    const cutoff = new Date(Date.now() - staleMs);
    const items = await FieldTrackingSession.find({
      active: true,
      lastPingAt: { $gte: cutoff },
    })
      .sort({ lastPingAt: -1 })
      .lean();
    res.json({ success: true, count: items.length, data: items });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /employees — distinct employees that have any session. */
router.get("/employees", async (_req, res) => {
  try {
    const rows = await FieldTrackingSession.aggregate([
      {
        $group: {
          _id: "$employeeId",
          employeeName: { $last: "$employeeName" },
          sessions: { $sum: 1 },
          lastPingAt: { $max: "$lastPingAt" },
        },
      },
      { $sort: { lastPingAt: -1 } },
    ]);
    const data = rows.map((r) => ({
      employeeId: r._id || "",
      employeeName: r.employeeName || "",
      sessions: r.sessions,
      lastPingAt: r.lastPingAt,
    }));
    res.json({ success: true, count: data.length, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /geocode?lat=&lng= — free reverse geocode proxy (cached), for the CMS. */
router.get("/geocode", async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ success: false, message: "lat and lng are required" });
    }
    const g = await reverseGeocode(lat, lng);
    res.json({ success: true, data: g || { displayName: "", short: "" } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** DELETE /session/:sessionId — remove a session and all its points. */
router.delete("/session/:sessionId", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    await FieldLocationPing.deleteMany({ sessionId });
    const r = await FieldTrackingSession.deleteOne({ sessionId });
    const io = req.app.get("io");
    if (io) io.emit("field_tracking:delete", { sessionId });
    res.json({ success: true, deleted: r.deletedCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** DELETE /employee/:employeeId — remove ALL sessions + points for an employee. */
router.delete("/employee/:employeeId", async (req, res) => {
  try {
    const employeeId = req.params.employeeId;
    await FieldLocationPing.deleteMany({ employeeId });
    const r = await FieldTrackingSession.deleteMany({ employeeId });
    const io = req.app.get("io");
    if (io) io.emit("field_tracking:delete", { employeeId });
    res.json({ success: true, deleted: r.deletedCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /session/:sessionId — one session summary. */
router.get("/session/:sessionId", async (req, res) => {
  try {
    const doc = await FieldTrackingSession.findOne({ sessionId: req.params.sessionId }).lean();
    if (!doc) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, data: doc });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /session/:sessionId/points — the ordered route. */
router.get("/session/:sessionId/points", async (req, res) => {
  try {
    const points = await FieldLocationPing.find({ sessionId: req.params.sessionId })
      .sort({ timestamp: 1 })
      .select("lat lng accuracy speed bearing timestamp cumulativeDistance -_id")
      .lean();
    res.json({ success: true, count: points.length, data: points });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
