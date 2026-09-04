// config/backgroundJobs.js
// ─────────────────────────────────────────────────────────────────────────────
// One switch for every scheduled job and every boot-time repair in this
// process.
//
// Unset, this changes nothing. Every schedule registers exactly as it always
// has, so the live instance is unaffected by the existence of this file.
// Setting BACKGROUND_JOBS=off makes the process serve HTTP and Socket.IO and
// nothing else: no eTimeOffice attendance pull, no reminder push or email, no
// Timer-SOP penalties, no C4 presence credits, no Firestore housekeeping, no
// boot-time task repair.
//
// That distinction is the whole reason it exists. A second instance pointed at
// the same MongoDB and the same Firebase project — a self-hosted box being
// rehearsed while the live one still serves users — is harmless as a reader
// and dangerous as a writer. The schedules it would start send real
// notifications to real staff and apply real payroll-adjacent penalties, and
// several of them deduplicate in memory (`_reminderSent`,
// `_timerSopLastRunDate`), which means two processes deduplicate separately
// and everyone is told twice.
//
// Deliberately read from the environment rather than from a settings
// document. The question it answers is "which of the processes sharing this
// database am I", and a shared setting cannot answer that. `services/
// jobRegistry`'s per-job toggles are the right tool for "should anyone run
// this job at all" and the wrong one for "should THIS box run it".
// ─────────────────────────────────────────────────────────────────────────────

/* Anything but an explicit off value leaves jobs on, so a typo, an empty
   string or a missing variable can never silently stop production's crons —
   the dangerous direction of a mistake here is off, not on. */
const OFF_VALUES = new Set(["off", "0", "false", "no", "disabled"]);
const RAW = String(process.env.BACKGROUND_JOBS ?? "").trim().toLowerCase();
const ENABLED = !OFF_VALUES.has(RAW);

/** True when this process is the one allowed to run scheduled work. */
function backgroundJobsEnabled() {
  return ENABLED;
}

/**
 * Guard clause for a single job registration site:
 *
 *   if (skipBackgroundJob("hourly attendance sync")) return;
 *
 * Names the job on the way past so the boot log says which schedules did not
 * start, rather than leaving a reader to infer it from a missing line.
 */
function skipBackgroundJob(label) {
  if (ENABLED) return false;
  console.log(`⏸️  Skipped (BACKGROUND_JOBS=off): ${label}`);
  return true;
}

/** One banner at boot, so the mode is never a guess. */
function announceBackgroundJobMode() {
  if (ENABLED) return;
  console.log(
    [
      "",
      "⏸️  BACKGROUND_JOBS=off — this instance runs NO scheduled work.",
      "    It serves HTTP and Socket.IO only. Every cron, sweep and boot-time",
      "    repair is skipped, so it cannot duplicate the work of another",
      "    instance pointed at the same MongoDB / Firebase project.",
      "    Remove the variable (or set it to `on`) to run them.",
      "",
    ].join("\n"),
  );
}

module.exports = {
  backgroundJobsEnabled,
  skipBackgroundJob,
  announceBackgroundJobMode,
};
