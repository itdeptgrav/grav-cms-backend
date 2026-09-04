// models/DevOps/JobHeartbeat.js
//
// A background job that is EXPECTED to run, and when it last did.
//
// The failure this catches is the silent one: a cron that stops is not an
// error anywhere — no request fails, no exception is thrown, attendance just
// quietly stops syncing until somebody notices days later. So each recurring
// job registers what it promises ("I run every N seconds") and calls beat()
// when it does; services/jobHeartbeats.checkOverdue() raises a DevAlert for
// any job whose silence has exceeded its promise, with slack for jitter.
//
// A row is created by ensureJob() in code, next to the job it describes —
// never from the UI, for the same reason SystemSetting's keys live in code:
// an expectation nobody wired to a real job would alert forever about a job
// that does not exist.

"use strict";

const mongoose = require("mongoose");

const jobHeartbeatSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    description: { type: String, default: "" },

    // The promise. Overdue means silence > expectEverySeconds * graceFactor.
    expectEverySeconds: { type: Number, required: true },
    graceFactor: { type: Number, default: 1.5 },

    // Off = the cron wrappers skip the run (services/jobRegistry.isEnabled).
    // The row, its history and its heartbeat promise all survive, so an
    // overdue alert does NOT fire for a job somebody deliberately paused —
    // checkOverdue skips disabled jobs.
    enabled: { type: Boolean, default: true },

    lastBeatAt: { type: Date },
    // The last beat that reported success — separate, so a job that runs on
    // schedule but fails every time still shows as unhealthy.
    lastOkAt: { type: Date },
    lastError: { type: String, default: "" },
    lastDurationMs: { type: Number },
    beatCount: { type: Number, default: 0 },
    failCount: { type: Number, default: 0 },

    // Set while an overdue alert is open, so the checker raises once per
    // outage rather than once per check.
    alerted: { type: Boolean, default: false },
  },
  { timestamps: true, collection: "job_heartbeats" },
);

module.exports =
  mongoose.models.JobHeartbeat ||
  mongoose.model("JobHeartbeat", jobHeartbeatSchema, "job_heartbeats");
