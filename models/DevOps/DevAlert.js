// models/DevOps/DevAlert.js
//
// Something the developer side thinks a human should look at.
//
// Raised by services/anomalyScan.js (patterns in the change log: a date of
// joining flip-flopping, a delete spree, an after-hours edit run), by
// Middlewear/errorWatch.js (5xx responses), and by services/jobHeartbeats.js
// (a cron that missed its window). Read at /developer/alerts.
//
// FINGERPRINTED, NOT APPENDED
// ---------------------------
// The same condition observed twice is ONE alert seen twice, not two alerts.
// Every raiser computes a stable `fingerprint` (kind + the identifying facts,
// never the timestamp) and upserts: a repeat bumps `count` and `lastSeenAt` on
// the existing row. Without this, a route that 500s on every request buries
// the one alert that matters under ten thousand copies of itself within the
// hour — an alert feed that scrolls is an alert feed nobody reads.
//
// Alerts are also the NOTIFICATION dedupe: developers are pushed to only when
// a fingerprint is first created, never on repeats. Re-opening after `resolved`
// notifies again — the condition came back, which is news.

"use strict";

const mongoose = require("mongoose");

const devAlertSchema = new mongoose.Schema(
  {
    // What class of problem this is. Stable keys, used for filtering and for
    // the per-kind mute switch in settings: "field-flipflop", "delete-spree",
    // "write-burst", "after-hours", "sensitive-change", "server-error",
    // "job-overdue".
    kind: { type: String, required: true, index: true },

    fingerprint: { type: String, required: true, unique: true },

    severity: {
      type: String,
      enum: ["info", "warn", "critical"],
      default: "warn",
      index: true,
    },

    // One line a developer can act on without opening the row.
    title: { type: String, required: true },
    detail: { type: String, default: "" },

    // Where it happened, when known — lets the alert link into the history.
    departmentSlug: { type: String, default: "", lowercase: true, index: true },
    entity: { type: String, default: "" },
    entityId: { type: String, default: "" },
    entityLabel: { type: String, default: "" },
    actorEmail: { type: String, default: "", lowercase: true },
    actorName: { type: String, default: "" },

    // The facts behind the claim — change-log ids, the sequence of values, the
    // route and status. Capped by the raiser, never unbounded: evidence is for
    // reading, the full record is in change_logs.
    evidence: { type: [mongoose.Schema.Types.Mixed], default: [] },

    status: {
      type: String,
      enum: ["open", "acked", "resolved"],
      default: "open",
      index: true,
    },
    ackedByEmail: { type: String, default: "" },
    ackedByName: { type: String, default: "" },
    ackedAt: { type: Date },
    resolvedAt: { type: Date },
    resolutionNote: { type: String, default: "" },

    // How many times the condition has been observed, and when last.
    count: { type: Number, default: 1 },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now, index: true },

    notifiedAt: { type: Date },
  },
  { timestamps: true, collection: "dev_alerts" },
);

// The feed: open things, worst and newest first.
devAlertSchema.index({ status: 1, severity: 1, lastSeenAt: -1 });

module.exports =
  mongoose.models.DevAlert || mongoose.model("DevAlert", devAlertSchema, "dev_alerts");
