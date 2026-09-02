// services/jobHeartbeats.js
//
// "Is the thing that runs on a schedule actually running?"
//
//   ensureJob("meeting-reminders", "15-min meeting reminder emails", 300);
//   ... inside the job, every run:
//   beat("meeting-reminders");                      // it ran and worked
//   beat("meeting-reminders", { error: e.message }) // it ran and failed
//
// checkOverdue() runs on its own interval (registered in server.js), compares
// each job's silence against its promise, and raises ONE DevAlert per outage
// — the `alerted` flag on the row is what stops a 5-minute checker filing the
// same missing cron every 5 minutes. Recovery clears the flag and resolves the
// alert, so the feed shows an outage as one row with a start and an end.
//
// beat() is fire-and-forget by design: a heartbeat that could throw into the
// job it measures would be the monitoring taking the system down.

"use strict";

const JobHeartbeat = require("../models/DevOps/JobHeartbeat");

/** Register (or update the description/promise of) an expected job. */
async function ensureJob(name, description, expectEverySeconds, graceFactor = 1.5) {
  try {
    await JobHeartbeat.findOneAndUpdate(
      { name },
      { $set: { description, expectEverySeconds, graceFactor } },
      { upsert: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    console.warn(`[heartbeats] could not register "${name}":`, err.message);
  }
}

/** Record a run. Never throws. */
function beat(name, { error, durationMs } = {}) {
  const now = new Date();
  JobHeartbeat.updateOne(
    { name },
    {
      $set: {
        lastBeatAt: now,
        lastError: error ? String(error).slice(0, 500) : "",
        ...(error ? {} : { lastOkAt: now }),
        ...(Number.isFinite(durationMs) ? { lastDurationMs: Math.round(durationMs) } : {}),
      },
      $inc: { beatCount: 1, ...(error ? { failCount: 1 } : {}) },
    },
  ).catch((err) => console.warn(`[heartbeats] beat "${name}" failed:`, err.message));
}

/**
 * Raise an alert for every job past its promise; resolve on recovery.
 * @returns {{overdue: string[], recovered: string[]}}
 */
async function checkOverdue() {
  const { getSetting } = require("./devConfig");
  const { upsertAlert, resolveByFingerprint } = require("./anomalyScan");

  const overdue = [];
  const recovered = [];
  if (!(await getSetting("jobs.checkEnabled"))) return { overdue, recovered };

  const jobs = await JobHeartbeat.find({}).lean();
  const now = Date.now();

  for (const job of jobs) {
    // Deliberately paused is not broken — see the `enabled` field's comment.
    if (job.enabled === false) continue;
    // A job that has never beaten is measured from its registration, so a cron
    // that never started at all is caught too — that is the likeliest failure
    // after a deploy.
    const reference = job.lastBeatAt || job.createdAt;
    const silenceMs = now - new Date(reference).getTime();
    const allowedMs = job.expectEverySeconds * 1000 * (job.graceFactor || 1.5);
    const isOverdue = silenceMs > allowedMs;

    const fingerprint = `job-overdue:${job.name}`;

    if (isOverdue && !job.alerted) {
      overdue.push(job.name);
      await JobHeartbeat.updateOne({ _id: job._id }, { $set: { alerted: true } });
      await upsertAlert({
        kind: "job-overdue",
        fingerprint,
        severity: "critical",
        title: `Background job "${job.name}" has stopped`,
        detail:
          `${job.description || job.name} promises to run every ` +
          `${job.expectEverySeconds}s but has been silent for ` +
          `${Math.round(silenceMs / 60000)} minutes` +
          `${job.lastError ? `. Its last run reported: ${job.lastError}` : "."}`,
        evidence: [
          { lastBeatAt: job.lastBeatAt, lastOkAt: job.lastOkAt, expectEverySeconds: job.expectEverySeconds },
        ],
      });
    } else if (!isOverdue && job.alerted) {
      recovered.push(job.name);
      await JobHeartbeat.updateOne({ _id: job._id }, { $set: { alerted: false } });
      await resolveByFingerprint(fingerprint, "Recovered — the job is beating again.");
    }
  }
  return { overdue, recovered };
}

module.exports = { ensureJob, beat, checkOverdue };
