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

/** Every calendar day (IST) in the trailing `days`-day window, oldest first. */
function trailingDayKeys(days) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const keys = [];
  for (let i = days - 1; i >= 0; i--) {
    const ist = new Date(Date.now() - i * 86400000 + IST_OFFSET_MS);
    keys.push(ist.toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * GET /api/cms/crm/call-events/stats?days=14
 *
 * Department-wide call activity — every call the PersonalCallRecorder app has
 * reported, not scoped to one customer, for the Messages page's "how many
 * calls, how many received/rejected/not received, how much talk time" overview
 * (21 Aug 2026, explicit request). CallEvent carries no salesperson/device
 * owner field, so this is org-wide by design, same as the events themselves.
 *
 * "received" / "rejected" / "not received" are exactly the three outcomes
 * `deriveReceived`/`deriveRejected` (routes/callEvents.js) can produce — not
 * received is simply neither of the other two (a ring nobody answered, a
 * block, a voicemail), never inferred from duration here.
 */
router.get("/stats", salesAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90);
    const since = new Date(Date.now() - days * 86400000);

    const rows = await CallEvent.aggregate([
      {
        $addFields: {
          effectiveAt: {
            $cond: [{ $gt: ["$startTime", 0] }, { $toDate: "$startTime" }, "$createdAt"],
          },
        },
      },
      { $match: { effectiveAt: { $gte: since } } },
      {
        $addFields: {
          dateKey: { $dateToString: { format: "%Y-%m-%d", date: "$effectiveAt", timezone: "Asia/Kolkata" } },
        },
      },
      {
        $group: {
          _id: "$dateKey",
          incoming: { $sum: { $cond: [{ $eq: ["$direction", "INCOMING"] }, 1, 0] } },
          outgoing: { $sum: { $cond: [{ $eq: ["$direction", "OUTGOING"] }, 1, 0] } },
          received: { $sum: { $cond: ["$received", 1, 0] } },
          rejected: { $sum: { $cond: ["$rejected", 1, 0] } },
          missed: {
            $sum: {
              $cond: [{ $and: [{ $eq: ["$received", false] }, { $eq: ["$rejected", false] }] }, 1, 0],
            },
          },
          totalDurationSec: { $sum: "$durationSec" },
          total: { $sum: 1 },
        },
      },
    ]);

    const byDate = new Map(rows.map((r) => [r._id, r]));
    const daily = trailingDayKeys(days).map((date) => {
      const r = byDate.get(date);
      return {
        date,
        incoming: r?.incoming || 0,
        outgoing: r?.outgoing || 0,
        received: r?.received || 0,
        rejected: r?.rejected || 0,
        missed: r?.missed || 0,
        totalDurationSec: r?.totalDurationSec || 0,
        total: r?.total || 0,
      };
    });

    const totals = daily.reduce(
      (acc, d) => ({
        total: acc.total + d.total,
        incoming: acc.incoming + d.incoming,
        outgoing: acc.outgoing + d.outgoing,
        received: acc.received + d.received,
        rejected: acc.rejected + d.rejected,
        missed: acc.missed + d.missed,
        totalDurationSec: acc.totalDurationSec + d.totalDurationSec,
      }),
      { total: 0, incoming: 0, outgoing: 0, received: 0, rejected: 0, missed: 0, totalDurationSec: 0 },
    );
    totals.avgDurationSec = totals.received > 0 ? Math.round(totals.totalDurationSec / totals.received) : 0;

    return res.json({ success: true, days, daily, totals });
  } catch (error) {
    console.error("[crm/call-events] stats failed:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
