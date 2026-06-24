// models/HR_Models/OvertimeNotificationLog.js
//
// Persistent dedup record for "OT reminder pushed to employee X for date Y".
// Replaces the in-memory `notifiedToday` Map that gets wiped every time the
// server restarts (e.g. Render free-tier dyno cold start) and causes the same
// reminder to fire repeatedly.
//
// The unique compound index on { employeeId, dateStr } guarantees we will
// never send a second notification for the same (employee, stay-over date)
// pair, even across server restarts or concurrent cron ticks.
//
// Records older than 60 days are auto-purged by a TTL index so this
// collection stays small.
//
"use strict";

const mongoose = require("mongoose");

const overtimeNotificationLogSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    dateStr: {
      type: String,
      required: true,
    },
    sentAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

// Hard dedup — one row per (employee, stay-over date)
overtimeNotificationLogSchema.index(
  { employeeId: 1, dateStr: 1 },
  { unique: true },
);

// Auto-purge after 60 days
overtimeNotificationLogSchema.index(
  { sentAt: 1 },
  { expireAfterSeconds: 60 * 24 * 60 * 60 },
);

module.exports = mongoose.model(
  "OvertimeNotificationLog",
  overtimeNotificationLogSchema,
);
