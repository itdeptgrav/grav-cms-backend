"use strict";
const CallEvent = require("../models/CallEvent");

// Two independent device-side reports can describe the SAME real call:
// CallEventReporter (outcome, off the system call log's own clock) and,
// only when the call was recorded, CmsSyncManager (the audio upload, off
// the app's own recording-session clock). Those two clocks rarely agree to
// the millisecond for the same call, so they're correlated by phone number
// within a time window rather than an exact `startTime` match — an exact
// match would silently create two documents for one call, exactly the
// split-record problem this consolidation exists to remove.
// 2 minutes: wide enough to absorb the ring-time / clock skew between the
// call-log date and the recording's own start, but narrow enough that the
// SAME number calling again a few minutes later gets its own document
// instead of being merged into the previous call (it used to be 5 min,
// which collapsed back-to-back calls from one contact into one record).
const DEFAULT_WINDOW_MS = 2 * 60 * 1000;

/**
 * Find the CallEvent this data belongs to, or null if none exists yet.
 * `phoneNumber` narrows the match when known; when it's null (privacy-
 * withheld number) the time window alone has to do, so callers should keep
 * the window tight for that case.
 */
async function findMatchingCallEvent(phoneNumber, nearTime, windowMs = DEFAULT_WINDOW_MS) {
  if (!nearTime) return null;
  const query = { startTime: { $gte: nearTime - windowMs, $lte: nearTime + windowMs } };
  if (phoneNumber) query.phoneNumber = phoneNumber;
  return CallEvent.findOne(query).sort({ startTime: -1 });
}

module.exports = { findMatchingCallEvent };
