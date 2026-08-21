// routes/CMS_Routes/Sales/callRecordings.js
//
// Sales-facing view of the synced phone-call recordings: which calls belong to
// a given CRM account or portal customer, the audio for one of them, and an
// on-demand AI summary.
//
// The write side of this data lives elsewhere and stays there —
// `routes/callRecordings.js` (mounted at /api/recordings) is the Android app's
// upload endpoint, gated by a shared API key. Nothing here creates or deletes a
// recording; this router only reads, plus one narrow annotation (aiSummary).
// That is why it is mounted WITHOUT the salesWrites() approval guard: holding a
// "summarise" click as a change request for an approver would be nonsense, and
// the guard exists to protect business records, which these are not.
//
// Reads CallEvent, not the old CallRecording model (21 Aug 2026 — the two
// call-tracking collections were consolidated into one; see CallEvent.js's
// own header comment). Filtered to `driveFileId` set, since this view is
// specifically "what got recorded" — every OTHER call CallEvent now also
// holds (missed/rejected/unrecorded) is out of scope for this screen.
"use strict";

const express = require("express");
const router = express.Router();

const CallRecording = require("../../../models/CallEvent");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { getDriveFileStream } = require("../../../services/mediaUpload.service");
const { buildRecordingFilter, annotateMatches } = require("../../../services/callRecordingMatch.service");
const { identityFor } = require("../../../services/customerIdentityLookup.service");
const { summariseCall } = require("../../../services/callSummary.service");

/** Hard ceiling on one customer's call history in a single response. */
const MAX_ROWS = 200;

/**
 * GET /api/cms/crm/call-recordings?accountId=… | ?customerId=… | ?leadId=…
 *
 * → { success, recordings[], identity: { label, phones, names }, counts }
 *
 * Each recording carries `matchedBy` ("phone" | "name") and `matchedOn`, so the
 * screen can show a fuzzy name match as a guess rather than as fact. Audio is
 * NOT linked directly to Drive: `audioUrl` points back at this router's own
 * proxy, so a recording is only reachable by someone already authenticated into
 * Sales.
 */
router.get("/", salesAuth, async (req, res) => {
  try {
    const { accountId, customerId, leadId } = req.query;
    if (!accountId && !customerId && !leadId) {
      return res.status(400).json({ success: false, message: "accountId, customerId or leadId is required" });
    }

    const identity = await identityFor({ accountId, customerId, leadId });
    if (!identity) return res.status(404).json({ success: false, message: leadId ? "Lead not found" : "Customer not found" });

    const filter = buildRecordingFilter(identity);
    /* No phone and no usable name means nothing to match on. Returning empty is
       the only safe answer — an unfiltered find() here would hand every call in
       the company to whoever opened a blank customer record. */
    if (!filter) {
      return res.json({
        success: true,
        recordings: [],
        identity: { label: identity.label, phones: [], names: [] },
        counts: { total: 0, byPhone: 0, byName: 0 },
      });
    }

    const rows = await CallRecording.find({ ...filter, driveFileId: { $ne: null } })
      .sort({ startTime: -1, createdAt: -1 })
      .limit(MAX_ROWS)
      .lean();

    const matched = annotateMatches(rows, identity).map((r) => ({
      _id: r._id,
      phoneNumber: r.phoneNumber,
      contactName: r.contactName,
      direction: r.direction,
      startTime: r.startTime,
      durationMillis: Math.round((r.durationSec || 0) * 1000),
      transcription: r.transcription,
      deviceSummary: r.summary,
      aiSummary: r.aiSummary,
      aiSummaryAt: r.aiSummaryAt,
      notes: r.notes,
      audioFileName: r.audioFileName,
      hasAudio: Boolean(r.driveFileId),
      audioUrl: r.driveFileId ? `/api/cms/crm/call-recordings/${r._id}/audio` : null,
      matchedBy: r.matchedBy,
      matchedOn: r.matchedOn,
      createdAt: r.createdAt,
    }));

    return res.json({
      success: true,
      recordings: matched,
      identity: {
        label: identity.label,
        phones: [...new Set(identity.phones.filter(Boolean))],
        names: [...new Set([...identity.names, ...(identity.personNames || [])].filter(Boolean))],
      },
      counts: {
        total: matched.length,
        byPhone: matched.filter((r) => r.matchedBy === "phone").length,
        byName: matched.filter((r) => r.matchedBy === "name").length,
      },
    });
  } catch (error) {
    console.error("[crm/call-recordings] list failed:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/cms/crm/call-recordings/:id/audio
 *
 * Streams the Drive file through this server. The upload path makes each file
 * "anyone with the link" readable, so a raw Drive URL would let anyone who ever
 * saw one replay a customer call forever; proxying keeps the audio behind the
 * Sales session and keeps the Drive id out of the browser.
 *
 * Range requests are not forwarded — an <audio> element handles a plain 200
 * stream fine for files this size, and half-implemented range support (a 200
 * answering a Range header) breaks seeking more thoroughly than none at all.
 */
router.get("/:id/audio", salesAuth, async (req, res) => {
  try {
    const rec = await CallRecording.findById(req.params.id).select("driveFileId driveMimeType audioFileName").lean();
    if (!rec) return res.status(404).json({ success: false, message: "Recording not found" });
    if (!rec.driveFileId) return res.status(404).json({ success: false, message: "This recording has no audio file" });

    const { data, mimeType, name } = await getDriveFileStream(rec.driveFileId);
    res.setHeader("Content-Type", rec.driveMimeType || mimeType || "audio/mpeg");
    res.setHeader("Accept-Ranges", "none");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${(rec.audioFileName || name || "recording").replace(/"/g, "")}"`,
    );
    data.on("error", (e) => {
      console.error("[crm/call-recordings] audio stream failed:", e);
      res.destroy();
    });
    data.pipe(res);
  } catch (error) {
    console.error("[crm/call-recordings] audio failed:", error);
    if (!res.headersSent) res.status(500).json({ success: false, message: "Could not load the audio file" });
  }
});

/**
 * POST /api/cms/crm/call-recordings/:id/summarize   { force?: boolean }
 *
 * Generates and stores an AI summary from the transcript. Idempotent by
 * default: an existing `aiSummary` is returned as-is unless `force` is set, so
 * a double-click costs nothing. A provider failure is a 502 with the service's
 * own message — the button says why it failed, rather than "something broke".
 */
router.post("/:id/summarize", salesAuth, async (req, res) => {
  try {
    const rec = await CallRecording.findById(req.params.id);
    if (!rec) return res.status(404).json({ success: false, message: "Recording not found" });

    if (rec.aiSummary && !req.body?.force) {
      return res.json({ success: true, cached: true, aiSummary: rec.aiSummary, aiSummaryAt: rec.aiSummaryAt });
    }

    const out = await summariseCall(rec);
    if (!out.ok) {
      const status = out.reason === "no_transcript" || out.reason === "not_configured" ? 422 : 502;
      return res.status(status).json({ success: false, reason: out.reason, message: out.message });
    }

    rec.aiSummary = out.summary;
    rec.aiSummaryModel = out.model;
    rec.aiSummaryAt = new Date();
    await rec.save();

    return res.json({ success: true, cached: false, aiSummary: rec.aiSummary, aiSummaryAt: rec.aiSummaryAt });
  } catch (error) {
    console.error("[crm/call-recordings] summarize failed:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
