// node --test services/merchandising/orderMeetings.rules.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normaliseMeeting, meetingState, DEFAULT_MINUTES, MIN_MINUTES } = require("./orderMeetings.rules");

const NOW = Date.parse("2026-10-11T06:00:00.000Z");

test("a PPM request needs a start; the title defaults to the order; the end is start + duration", () => {
  const out = normaliseMeeting({ startsAt: "2026-10-12T05:00:00.000Z", participants: ["GR0045", "GR0045", " GR0108 "], agenda: ["Fabric", "", "  Trims "] }, { now: NOW, orderRef: "REQ-2026-0041" });
  assert.equal(out.ok, true);
  assert.equal(out.value.title, "PPM · REQ-2026-0041");
  assert.equal(out.value.dateTime, "2026-10-12T05:00:00.000Z", "stored as a UTC ISO string — the reminder sweep compares strings");
  assert.equal(out.value.endsAt, "2026-10-12T06:00:00.000Z");
  assert.equal(out.value.durationMinutes, DEFAULT_MINUTES);
  assert.deepEqual(out.value.participants, ["GR0045", "GR0108"], "deduplicated and trimmed");
  assert.deepEqual(out.value.agenda, ["Fabric", "Trims"]);
});

test("a start in the past, a bad duration or no title at all are refused in words", () => {
  const past = normaliseMeeting({ title: "x", startsAt: "2026-10-11T05:00:00.000Z" }, { now: NOW });
  assert.equal(past.ok, false);
  assert.match(past.errors.startsAt, /in the past/);
  const grace = normaliseMeeting({ title: "x", startsAt: new Date(NOW - 5 * 60 * 1000).toISOString() }, { now: NOW });
  assert.equal(grace.ok, true, "a meeting starting a few minutes ago is 'now'");
  const dur = normaliseMeeting({ title: "x", startsAt: "2026-10-12T05:00:00.000Z", durationMinutes: 5 }, { now: NOW });
  assert.equal(dur.ok, false);
  assert.match(dur.errors.durationMinutes, new RegExp(`${MIN_MINUTES} minutes`));
  const none = normaliseMeeting({ startsAt: "2026-10-12T05:00:00.000Z" }, { now: NOW });
  assert.equal(none.ok, false);
  assert.match(none.errors.title, /title/);
  const when = normaliseMeeting({ title: "x", startsAt: "not a date" }, { now: NOW });
  assert.match(when.errors.startsAt, /when the meeting starts/);
});

test("the state reads the stored fields the way CoWork does", () => {
  assert.equal(meetingState({ status: "live", isCancelled: false }), "live");
  assert.equal(meetingState({ status: "live", isCancelled: true }), "cancelled", "cancelled wins");
  assert.equal(meetingState({ status: "ended" }), "completed", "the legacy spelling");
  assert.equal(meetingState({ status: "whatever" }), "scheduled");
  assert.equal(meetingState({}), "scheduled");
});
