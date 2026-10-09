// services/manufacturing/recordedAt.js
//
// WHEN A SCAN WAS MADE, FOR A SCAN THAT ARRIVES LATE.
//
// A device in offline mode (the CMS's lib/offline/ — the GRAV app, or a
// station that opted in) keeps scans and verdicts while the server is down and
// sends them when it is back, possibly hours later. Stamped with `new Date()`
// on arrival, every one of them would land at the moment of the sync: an
// afternoon's verdicts in one minute of the hour-wise report, on the wrong day
// if the outage crossed midnight. (The Production Supervisor's `scannedAt`
// had exactly this bug — see the CMS's CLAUDE.md.)
//
// So the device sends `recordedAt` (ISO), and this decides whether to believe
// it: never in the future beyond a small clock skew, and never older than
// MAX_AGE — a device clock that is plainly wrong falls back to "now", which is
// what the route did before this existed. Absent or unreadable → now.

const MAX_SKEW_MS = 2 * 60 * 1000;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function boundedRecordedAt(value, now = new Date()) {
  if (!value) return now;
  const t = new Date(value);
  const ms = t.getTime();
  if (!Number.isFinite(ms)) return now;
  if (ms > now.getTime() + MAX_SKEW_MS) return now;
  if (ms < now.getTime() - MAX_AGE_MS) return now;
  return t;
}

module.exports = { boundedRecordedAt, MAX_AGE_MS, MAX_SKEW_MS };
