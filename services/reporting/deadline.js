// services/reporting/deadline.js
//
// ONE CLOCK FOR THE WHOLE PREVIEW.
//
// A summary runs its plan's queries one after another, and each of them used
// to get the engine's full 30-second timeout of its own. Twelve queries could
// therefore occupy a request for six minutes while every individual call was
// comfortably "within timeout" — the clock restarted at each one. A user
// watching a spinner does not care which query is slow.
//
// So a deadline is created once, for the request, and handed down. Every call
// gets whatever is LEFT of it, and the plan checks it before starting the next
// query rather than after wasting one.
//
// The clock is injected. A test that proves a deadline works by sleeping for
// twenty seconds is a test nobody runs twice.
"use strict";

/**
 * @param {object} o
 * @param {number} o.ms          how long the whole request may take
 * @param {function} [o.now]     the clock, injectable
 * @param {AbortSignal} [o.signal]  the client going away
 */
function createDeadline({ ms, now = Date.now, signal = null }) {
  const startedAt = now();
  const endsAt = startedAt + ms;
  return {
    ms,
    startedAt,
    /** Milliseconds left, never negative. */
    remaining: () => Math.max(0, endsAt - now()),
    expired: () => now() >= endsAt,
    /** The browser hung up: whatever is still running is wasted work. */
    aborted: () => Boolean(signal && signal.aborted),
    elapsed: () => now() - startedAt,
    signal,
  };
}

module.exports = { createDeadline };
