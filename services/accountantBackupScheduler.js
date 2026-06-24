// services/accountantBackupScheduler.js
//
// Best-effort in-process scheduler for automatic backups.
//
// HOW IT WORKS
//   On start() it sets an hourly interval. Each tick reads the singleton
//   config and, if a backup is "due" for the chosen frequency, runs one.
//
// IMPORTANT LIMITATION
//   This only fires while the Node process is awake. On hosting tiers that
//   sleep the server when idle (common on free plans), a scheduled tick can
//   be missed. For guaranteed scheduling, point an external cron service
//   (cron-job.org, GitHub Actions, your host's cron) at:
//
//     POST /api/accountant/backup/cron?secret=YOUR_BACKUP_CRON_SECRET
//
//   That endpoint runs the same "is it due?" check, so you can call it
//   hourly without creating duplicate backups.

const {
  Acc_BackupConfig,
} = require("../models/Accountant_model/Acc_BackupModels");
const backupService = require("./accountantBackup.service");

let _started = false;
let _timer = null;
let _running = false;

// Slightly-under thresholds so clock drift / tick timing never SKIPS a day.
const DAILY_MS = 23 * 60 * 60 * 1000; // ~23h
const WEEKLY_MS = 6.9 * 24 * 60 * 60 * 1000; // ~6.9d
const TICK_MS = 60 * 60 * 1000; // hourly

function isDue(frequency, lastRunAt) {
  if (frequency === "off") return false;
  if (!lastRunAt) return true;
  const elapsed = Date.now() - new Date(lastRunAt).getTime();
  if (frequency === "daily") return elapsed >= DAILY_MS;
  if (frequency === "weekly") return elapsed >= WEEKLY_MS;
  return false;
}

// Runs a backup if one is due. `force` ignores the schedule (used by a manual
// cron ping that wants a guaranteed run). Returns a small status object.
async function checkAndRun({ force = false, trigger = "scheduled" } = {}) {
  if (_running) return { ran: false, reason: "already-running" };
  _running = true;
  try {
    const cfg = await Acc_BackupConfig.getSingleton();
    if (!force && !isDue(cfg.frequency, cfg.lastRunAt)) {
      return { ran: false, reason: "not-due", frequency: cfg.frequency };
    }
    if (!force && cfg.frequency === "off") {
      return { ran: false, reason: "disabled" };
    }
    const record = await backupService.runBackup({ trigger });
    return { ran: true, recordId: record?._id, fileId: record?.fileId };
  } catch (e) {
    console.error("[backup-scheduler] run failed:", e.message);
    return { ran: false, reason: "error", error: e.message };
  } finally {
    _running = false;
  }
}

function start() {
  if (_started) return;
  _started = true;

  // Kick a check shortly after boot (lets the DB connection settle), then
  // hourly thereafter.
  setTimeout(() => {
    checkAndRun().catch(() => {});
  }, 30 * 1000);

  _timer = setInterval(() => {
    checkAndRun().catch(() => {});
  }, TICK_MS);

  // Don't keep the process alive just for this timer.
  if (_timer && typeof _timer.unref === "function") _timer.unref();

  console.log("✓ [backup-scheduler] started (hourly check)");
}

module.exports = { start, checkAndRun, isDue };
