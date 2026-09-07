"use strict";
const express = require("express");
const router = express.Router();

const FieldTrackingSession = require("../models/FieldTrackingSession");
const FieldLocationPing = require("../models/FieldLocationPing");
const FieldZone = require("../models/FieldZone");
const FieldVisit = require("../models/FieldVisit");
const CallEvent = require("../models/CallEvent");
const { SalesPerson } = require("../models/CMS_Models/Sales/SalesPerson");
const salesAuth = require("../Middlewear/SalesAuthMiddlewear");
const { reverseGeocode, searchPlace } = require("../services/reverseGeocode.service");

/** "YYYY-MM-DD" in IST for an epoch-ms value — the day a duty belongs to. */
function istDayKey(ms) {
  if (!ms) return null;
  return new Date(ms + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
/** Start/end epoch-ms of a "YYYY-MM-DD" day window in the server's zone. */
function dayWindow(dateStr) {
  const day = new Date(dateStr + "T00:00:00");
  if (isNaN(day.getTime())) return null;
  return { start: day.getTime(), end: day.getTime() + 24 * 60 * 60 * 1000 };
}
const num = (v, d = 0) => (typeof v === "number" && !isNaN(v) ? v : d);

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
          lastSpeed: newest?.speed ?? undefined,
          lastBearing: newest?.bearing ?? undefined,
          lastAccuracy: newest?.accuracy ?? undefined,
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

/** GET /sessions?employeeId=&date=YYYY-MM-DD | from=YYYY-MM-DD&to=YYYY-MM-DD &active=true&limit= */
router.get("/sessions", async (req, res) => {
  try {
    const q = {};
    if (req.query.employeeId) q.employeeId = req.query.employeeId;
    if (req.query.active === "true") q.active = true;
    if (req.query.active === "false") q.active = false;
    if (req.query.from || req.query.to) {
      // A date RANGE (6 Sep 2026) — the reports view reads a week or a month
      // at a time. Inclusive of both ends.
      const from = dayWindow(req.query.from || req.query.to);
      const to = dayWindow(req.query.to || req.query.from);
      if (from && to) q.startTime = { $gte: from.start, $lt: to.end };
    } else if (req.query.date) {
      // Interpret the calendar day in the server's local zone as a start/end
      // epoch-ms window over the device startTime.
      const w = dayWindow(req.query.date);
      if (w) q.startTime = { $gte: w.start, $lt: w.end };
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const items = await FieldTrackingSession.find(q).sort({ startTime: -1 }).limit(limit).lean();
    res.json({ success: true, count: items.length, data: items });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /live — everyone currently ON DUTY, whether or not their phone is
 * reporting.
 *
 * ── Why this no longer filters on lastPingAt (5 Sep 2026) ────────────────
 *
 * It used to return only `active: true` sessions that had pinged within the
 * last 3 minutes. That silently answered a DIFFERENT question from the one
 * the screen asks, and produced a straight contradiction in the UI:
 *
 *   Routes list  → "Aroona Panda  [live]"     (reads session.active)
 *   On duty now  → "(0) No one is tracking"   (read this endpoint)
 *
 * Both were right about their own rule and the screen was nonsense. The real
 * case behind it: her app called /session/start and then never called /ping
 * once — `pointCount: 0`, `lastPingAt: null` — so she was on duty with no
 * position ever recorded. Excluding her here made the single most important
 * fact (a rep is on duty and her phone is NOT sending location) the one thing
 * the page could not show.
 *
 * So this returns every open duty and lets the caller classify how well each
 * one is reporting; `lastPingAt: null` is the "never reported" signal and is
 * deliberately preserved rather than filtered on. `staleMinutes` is kept and
 * echoed back so the caller can use the server's notion of stale instead of
 * inventing its own.
 */
router.get("/live", async (req, res) => {
  try {
    const staleMinutes = parseInt(req.query.staleMinutes, 10) || 3;
    const items = await FieldTrackingSession.find({ active: true })
      /* Nulls sort last, which is what we want: a rep who is actually
         reporting outranks one whose phone has said nothing. */
      .sort({ lastPingAt: -1 })
      .lean();
    const cutoff = Date.now() - staleMinutes * 60 * 1000;
    const reporting = items.filter((s) => s.lastPingAt && new Date(s.lastPingAt).getTime() >= cutoff).length;
    res.json({
      success: true,
      count: items.length,
      reporting,
      awaitingFirstFix: items.filter((s) => !s.lastPingAt).length,
      staleMinutes,
      data: items,
    });
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
    // A visit tag belongs to its stop, and the stop belongs to the route —
    // an orphaned tag would keep feeding /places with a customer nobody can
    // find the evidence for any more.
    await FieldVisit.deleteMany({ sessionId });
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
    await FieldVisit.deleteMany({ employeeId });
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

/* ═══════════════════════════════════════════════════════════════════════════
   6 Sep 2026 — the field-tracking rebuild.

   Explicit request: the map "is not representing any strong thing or like any
   evidence or like proper logs which helps the owner to see / get informative
   data". Everything below exists to turn a line on a map into a day's work an
   owner can read, question and sign off: what was the day's shape, where did
   the rep actually stop and who was that, which calls were made from the road,
   how does this week compare with last, and is the tracking itself trustworthy.

   The heavy analysis (stops, trips, gaps, integrity checks, zone dwell) is
   done in the browser from the raw fixes — components/sales/field-tracking/
   fieldAnalytics.js — because the rules are judgement calls that the screen
   prints beside the numbers, and a supervisor can tune them. The server
   provides what the browser cannot: aggregates over many days, the join to
   call records, and the two things people WRITE — zones and visit tags.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * GET /summary?from=YYYY-MM-DD&to=YYYY-MM-DD[&employeeId=]
 *
 * One row per (employee, IST day) across the range, computed from the
 * sessions alone — no pings are read, so a month for a whole team is a single
 * aggregation. Powers the reports view: per-day table, leaderboard, field
 * attendance and the distance trend.
 *
 *   → { success, from, to, rows: [{ employeeId, employeeName, day, sessions,
 *        firstStart, lastEnd, dutyMs, distanceM, points, visits, calls }],
 *        roster: [{ employeeCode, name }] }
 */
router.get("/summary", async (req, res) => {
  try {
    const from = dayWindow(req.query.from);
    const to = dayWindow(req.query.to || req.query.from);
    if (!from || !to) return res.status(400).json({ success: false, message: "from and to (YYYY-MM-DD) are required" });
    const match = { startTime: { $gte: from.start, $lt: to.end } };
    if (req.query.employeeId) match.employeeId = req.query.employeeId;

    const now = Date.now();
    const sessions = await FieldTrackingSession.find(match)
      .select("sessionId employeeId employeeName startTime endTime lastPingAt active totalDistanceMeters pointCount")
      .lean();

    // Roll up in JS rather than a $group: the IST day key and the "still
    // running" end-time rule are simpler to state here than in aggregation
    // syntax, and a month of sessions is hundreds of rows, not millions.
    const byKey = new Map();
    for (const s of sessions) {
      const day = istDayKey(s.startTime);
      if (!day) continue;
      const key = `${s.employeeId || ""}|${day}`;
      const end = s.endTime || (s.lastPingAt ? new Date(s.lastPingAt).getTime() : null) || (s.active ? now : s.startTime);
      const row = byKey.get(key) || {
        employeeId: s.employeeId || "",
        employeeName: s.employeeName || "",
        day,
        sessions: 0,
        firstStart: null,
        lastEnd: null,
        dutyMs: 0,
        distanceM: 0,
        points: 0,
        visits: 0,
        calls: 0,
        openSessions: 0,
        sessionIds: [],
      };
      row.sessions += 1;
      row.sessionIds.push(s.sessionId);
      if (s.employeeName && !row.employeeName) row.employeeName = s.employeeName;
      row.firstStart = row.firstStart == null ? s.startTime : Math.min(row.firstStart, s.startTime);
      row.lastEnd = row.lastEnd == null ? end : Math.max(row.lastEnd, end);
      row.dutyMs += Math.max(0, end - s.startTime);
      row.distanceM += num(s.totalDistanceMeters);
      row.points += num(s.pointCount);
      if (s.active) row.openSessions += 1;
      byKey.set(key, row);
    }

    // Confirmed visits per session, folded onto the day rows.
    const allSessionIds = sessions.map((s) => s.sessionId);
    if (allSessionIds.length) {
      const visitCounts = await FieldVisit.aggregate([
        { $match: { sessionId: { $in: allSessionIds }, outcome: { $ne: "not_visit" } } },
        { $group: { _id: "$sessionId", n: { $sum: 1 } } },
      ]);
      const perSession = new Map(visitCounts.map((v) => [v._id, v.n]));
      for (const row of byKey.values()) row.visits = row.sessionIds.reduce((a, id) => a + (perSession.get(id) || 0), 0);
    }

    // Calls per (employee, day), through the sales roster's corporate number.
    const roster = await SalesPerson.find({}).select("employeeCode name normalizedPhone active").lean();
    const phoneToCode = new Map(roster.filter((p) => p.normalizedPhone && p.employeeCode).map((p) => [p.normalizedPhone, p.employeeCode]));
    if (phoneToCode.size) {
      const calls = await CallEvent.find({
        normalizedOwnerPhone: { $in: [...phoneToCode.keys()] },
        startTime: { $gte: from.start, $lt: to.end },
      })
        .select("normalizedOwnerPhone startTime")
        .lean();
      for (const c of calls) {
        const code = phoneToCode.get(c.normalizedOwnerPhone);
        const day = istDayKey(c.startTime);
        const row = code && day ? byKey.get(`${code}|${day}`) : null;
        if (row) row.calls += 1;
      }
    }

    // `sessionIds` stays on the row: the person's History tab opens a past
    // day by its first session, and a row that only knew the date would have
    // to search for it again.
    const rows = [...byKey.values()]
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : String(a.employeeName).localeCompare(String(b.employeeName))));

    res.json({
      success: true,
      from: req.query.from,
      to: req.query.to || req.query.from,
      rows,
      roster: roster.map((p) => ({ employeeCode: p.employeeCode, name: p.name, active: p.active !== false })),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /session/:sessionId/calls — every call made from the rep's corporate
 * phone while this duty was running.
 *
 * The join: session.employeeId → SalesPerson.employeeCode → normalizedPhone →
 * CallEvent.normalizedOwnerPhone, within [startTime, endTime || now]. This is
 * what lets the day read "11:32 — called +91 98… for 4 min, from Patia": the
 * two systems the rep's phone reports into, shown as one timeline.
 *
 * Behind salesAuth, unlike the other reads here: call records name customers.
 */
router.get("/session/:sessionId/calls", salesAuth, async (req, res) => {
  try {
    const s = await FieldTrackingSession.findOne({ sessionId: req.params.sessionId })
      .select("employeeId startTime endTime lastPingAt active")
      .lean();
    if (!s) return res.status(404).json({ success: false, message: "Not found" });
    const code = String(s.employeeId || "").trim();
    if (!code) return res.json({ success: true, attributed: false, reason: "no_employee_id", calls: [] });
    const person = await SalesPerson.findOne({ employeeCode: new RegExp(`^${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") })
      .select("name normalizedPhone workPhone")
      .lean();
    if (!person) return res.json({ success: true, attributed: false, reason: "not_on_roster", calls: [] });
    if (!person.normalizedPhone) return res.json({ success: true, attributed: false, reason: "no_work_phone", person: { name: person.name }, calls: [] });

    const end = s.endTime || (s.active ? Date.now() : new Date(s.lastPingAt || s.startTime).getTime());
    const rows = await CallEvent.find({
      normalizedOwnerPhone: person.normalizedPhone,
      startTime: { $gte: s.startTime - 5 * 60 * 1000, $lte: end + 5 * 60 * 1000 },
    })
      .sort({ startTime: 1 })
      .select("phoneNumber contactName direction callType received rejected durationSec startTime driveFileId aiSummary kind")
      .lean();

    res.json({
      success: true,
      attributed: true,
      person: { name: person.name, workPhone: person.workPhone },
      calls: rows.map((r) => ({
        _id: r._id,
        phoneNumber: r.phoneNumber,
        contactName: r.contactName,
        direction: r.direction,
        received: r.received,
        rejected: r.rejected,
        durationSec: r.durationSec || 0,
        startTime: r.startTime,
        recorded: Boolean(r.driveFileId),
        aiSummary: r.aiSummary || null,
        kind: r.kind || "call",
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** PATCH /session/:sessionId/notes  { notes, by? } — a supervisor's remark on the day. */
router.patch("/session/:sessionId/notes", async (req, res) => {
  try {
    const notes = String(req.body?.notes ?? "").slice(0, 2000);
    const doc = await FieldTrackingSession.findOneAndUpdate(
      { sessionId: req.params.sessionId },
      { $set: { notes, notesUpdatedAt: new Date(), notesUpdatedBy: String(req.body?.by || "").slice(0, 120) } },
      { new: true },
    ).lean();
    if (!doc) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, notes: doc.notes, notesUpdatedAt: doc.notesUpdatedAt, notesUpdatedBy: doc.notesUpdatedBy });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Zones (geofences) ──────────────────────────────────────────────────────

/** GET /zones — every active zone. */
router.get("/zones", async (_req, res) => {
  try {
    const zones = await FieldZone.find({ active: true }).sort({ kind: 1, name: 1 }).lean();
    res.json({ success: true, count: zones.length, data: zones });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

function zoneBody(b = {}) {
  const out = {};
  if (b.name != null) out.name = String(b.name).trim().slice(0, 120);
  if (b.kind != null) out.kind = ["office", "warehouse", "customer", "home", "other"].includes(b.kind) ? b.kind : "other";
  if (typeof b.lat === "number") out.lat = b.lat;
  if (typeof b.lng === "number") out.lng = b.lng;
  if (b.radiusM != null) out.radiusM = Math.min(5000, Math.max(20, Number(b.radiusM) || 150));
  if (b.note != null) out.note = String(b.note).slice(0, 500);
  if (b.accountId !== undefined) out.accountId = b.accountId || null;
  if (b.createdBy != null) out.createdBy = String(b.createdBy).slice(0, 120);
  return out;
}

/** POST /zones  { name, kind, lat, lng, radiusM, note?, accountId? } */
router.post("/zones", async (req, res) => {
  try {
    const body = zoneBody(req.body);
    if (!body.name || typeof body.lat !== "number" || typeof body.lng !== "number") {
      return res.status(400).json({ success: false, message: "name, lat and lng are required" });
    }
    const doc = await FieldZone.create({ radiusM: 150, kind: "other", ...body });
    res.status(201).json({ success: true, data: doc.toObject() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** PUT /zones/:id — edit any field. */
router.put("/zones/:id", async (req, res) => {
  try {
    const doc = await FieldZone.findByIdAndUpdate(req.params.id, { $set: zoneBody(req.body) }, { new: true }).lean();
    if (!doc) return res.status(404).json({ success: false, message: "Zone not found" });
    res.json({ success: true, data: doc });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** DELETE /zones/:id — soft: the zone stops applying, history that named it stays readable. */
router.delete("/zones/:id", async (req, res) => {
  try {
    const doc = await FieldZone.findByIdAndUpdate(req.params.id, { $set: { active: false } }, { new: true }).lean();
    if (!doc) return res.status(404).json({ success: false, message: "Zone not found" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Visits (a stop, confirmed as a customer visit) ────────────────────────

/** GET /visits?sessionId= | ?employeeId=&from=&to= */
router.get("/visits", async (req, res) => {
  try {
    const q = {};
    if (req.query.sessionId) q.sessionId = req.query.sessionId;
    if (req.query.employeeId) q.employeeId = req.query.employeeId;
    if (req.query.from || req.query.to) {
      const from = dayWindow(req.query.from || req.query.to);
      const to = dayWindow(req.query.to || req.query.from);
      if (from && to) q.stopFrom = { $gte: from.start, $lt: to.end };
    }
    if (!Object.keys(q).length) return res.status(400).json({ success: false, message: "sessionId, or employeeId/from/to, is required" });
    const rows = await FieldVisit.find(q).sort({ stopFrom: 1 }).limit(2000).lean();
    res.json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PUT /visits  — upsert by (sessionId, stopFrom).
 * { sessionId, stopFrom, stopTo?, lat, lng, placeName?, customerName?,
 *   accountId?, leadId?, outcome?, note?, taggedBy? }
 */
router.put("/visits", async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.sessionId || typeof b.stopFrom !== "number" || typeof b.lat !== "number" || typeof b.lng !== "number") {
      return res.status(400).json({ success: false, message: "sessionId, stopFrom, lat and lng are required" });
    }
    const session = await FieldTrackingSession.findOne({ sessionId: b.sessionId }).select("employeeId").lean();
    const set = {
      employeeId: session?.employeeId || b.employeeId || "",
      stopTo: typeof b.stopTo === "number" ? b.stopTo : null,
      lat: b.lat,
      lng: b.lng,
      placeName: String(b.placeName || "").slice(0, 300),
      customerName: String(b.customerName || "").slice(0, 200),
      accountId: b.accountId || null,
      leadId: b.leadId || null,
      outcome: ["met", "not_met", "order", "follow_up", "delivery", "collection", "not_visit", "other"].includes(b.outcome) ? b.outcome : "met",
      note: String(b.note || "").slice(0, 1000),
      taggedBy: String(b.taggedBy || "").slice(0, 120),
    };
    const doc = await FieldVisit.findOneAndUpdate(
      { sessionId: b.sessionId, stopFrom: b.stopFrom },
      { $set: set, $setOnInsert: { sessionId: b.sessionId, stopFrom: b.stopFrom } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    res.json({ success: true, data: doc });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** DELETE /visits/:id */
router.delete("/visits/:id", async (req, res) => {
  try {
    const r = await FieldVisit.deleteOne({ _id: req.params.id });
    res.json({ success: true, deleted: r.deletedCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /places — every distinct customer place the business has confirmed
 * through past visit tags: name, position, how many times, last seen.
 *
 * This is the business's own map of where its customers are. The CRM holds
 * no coordinates (0 addresses with lat/lng in the live database), so the only
 * way a stop can be recognised as "Sharma Textiles again" is that somebody
 * tagged it as Sharma Textiles before. The browser matches new stops against
 * this list by distance and offers the name back.
 */
router.get("/places", async (_req, res) => {
  try {
    const rows = await FieldVisit.aggregate([
      { $match: { customerName: { $nin: ["", null] }, outcome: { $ne: "not_visit" } } },
      {
        $group: {
          _id: { $toLower: "$customerName" },
          name: { $last: "$customerName" },
          lat: { $avg: "$lat" },
          lng: { $avg: "$lng" },
          visits: { $sum: 1 },
          lastAt: { $max: "$stopFrom" },
          accountId: { $last: "$accountId" },
        },
      },
      { $sort: { visits: -1 } },
      { $limit: 500 },
    ]);
    res.json({ success: true, count: rows.length, data: rows.map((r) => ({ name: r.name, lat: r.lat, lng: r.lng, visits: r.visits, lastAt: r.lastAt, accountId: r.accountId })) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Geocoding helpers for the CMS ─────────────────────────────────────────

/** GET /search?q=  — place name → candidate coordinates (India-biased). */
router.get("/search", async (req, res) => {
  try {
    const results = await searchPlace(String(req.query.q || ""));
    res.json({ success: true, count: results.length, data: results });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /geocode/batch  { points: [{ lat, lng }] }  (≤ 25)
 * Names for a route's stops in ONE request, resolved in order through the
 * shared 1 req/s throttle — the browser must not fire twenty lookups at the
 * geocoder at once on behalf of one screen.
 */
router.post("/geocode/batch", async (req, res) => {
  try {
    const points = (Array.isArray(req.body?.points) ? req.body.points : []).slice(0, 25);
    const names = [];
    for (const p of points) {
      if (typeof p?.lat !== "number" || typeof p?.lng !== "number") {
        names.push("");
        continue;
      }
      const g = await reverseGeocode(p.lat, p.lng);
      names.push(g?.short || "");
    }
    res.json({ success: true, data: names });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
