// routes/CMS_Routes/Sales/callEvents.js
//
// Sales-facing view of EVERY call the PersonalCallRecorder app has seen for a
// customer/lead — answered, missed, rejected, recorded or not. Sibling to
// callRecordings.js (which only shows the subset that got recorded); this one
// exists specifically to power the Active Lead workspace's "log this call as
// your outreach attempt" suggestion (21 Aug 2026, explicit request — "use
// this callevents logs to automate this active leads part... make sure to
// use this data efficiency"), which needs to know about a genuine outreach
// attempt whether or not it happened to get recorded — most calls on a
// personal phone never do (mic-only capture, OEM dependency; see the
// Android app's own README on "the honest Android limitation").
//
// Same read-only, no-approval-guard shape as callRecordings.js, same reason:
// nothing here creates or deletes a business record.
"use strict";

const express = require("express");
const router = express.Router();

const CallEvent = require("../../../models/CallEvent");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { buildRecordingFilter, annotateMatches } = require("../../../services/callRecordingMatch.service");
const { identityFor } = require("../../../services/customerIdentityLookup.service");

/** Hard ceiling on one customer's call history in a single response. */
const MAX_ROWS = 200;

/**
 * GET /api/cms/crm/call-events?accountId=… | ?customerId=… | ?leadId=…
 *
 * → { success, events[], identity: { label, phones, names }, counts }
 *
 * Each event carries `matchedBy`/`matchedOn` (same fuzzy-match labelling as
 * call-recordings), plus `received`/`rejected`/`callType`/`hasRecording` so
 * the caller can tell a genuine two-way contact apart from a ring nobody
 * answered without guessing from duration.
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
    if (!filter) {
      return res.json({
        success: true,
        events: [],
        identity: { label: identity.label, phones: [], names: [] },
        counts: { total: 0, byPhone: 0, byName: 0, received: 0 },
      });
    }

    const rows = await CallEvent.find(filter)
      .sort({ startTime: -1, createdAt: -1 })
      .limit(MAX_ROWS)
      .lean();

    const matched = annotateMatches(rows, identity).map((r) => ({
      _id: r._id,
      phoneNumber: r.phoneNumber,
      contactName: r.contactName,
      direction: r.direction,
      callType: r.callType,
      received: r.received,
      rejected: r.rejected,
      startTime: r.startTime,
      durationMillis: Math.round((r.durationSec || 0) * 1000),
      hasRecording: Boolean(r.driveFileId),
      audioUrl: r.driveFileId ? `/api/cms/crm/call-recordings/${r._id}/audio` : null,
      matchedBy: r.matchedBy,
      matchedOn: r.matchedOn,
      createdAt: r.createdAt,
    }));

    return res.json({
      success: true,
      events: matched,
      identity: {
        label: identity.label,
        phones: [...new Set(identity.phones.filter(Boolean))],
        names: [...new Set([...identity.names, ...(identity.personNames || [])].filter(Boolean))],
      },
      counts: {
        total: matched.length,
        byPhone: matched.filter((r) => r.matchedBy === "phone").length,
        byName: matched.filter((r) => r.matchedBy === "name").length,
        received: matched.filter((r) => r.received).length,
      },
    });
  } catch (error) {
    console.error("[crm/call-events] list failed:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
