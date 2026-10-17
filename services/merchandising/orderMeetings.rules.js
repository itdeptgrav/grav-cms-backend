// services/merchandising/orderMeetings.rules.js
//
// The pure half of orderMeetings.service.js: what a PPM meeting request must
// say, and how a CoWork meet's stored fields read as one state. No Firestore,
// no Mongo, so `orderMeetings.rules.test.js` runs under `npm test`.
"use strict";

const str = (v) => (v === null || v === undefined ? "" : String(v));
const lower = (v) => str(v).trim().toLowerCase();

const MIN_MINUTES = 15;
const MAX_MINUTES = 8 * 60;
const DEFAULT_MINUTES = 60;
/* A meeting may start "now" (CoWork's instant meeting does); anything already
   more than this far in the past is a typing mistake, not a plan. */
const PAST_GRACE_MS = 10 * 60 * 1000;
const MAX_TITLE = 160;
const MAX_DESCRIPTION = 2000;
const MAX_AGENDA_ITEMS = 25;

/* The state words CoWork's own reader derives (workMap.readMeetingStatus):
   cancelled wins, "ended" is the legacy spelling of completed, anything
   unknown is scheduled. The server stores no derived state. */
const KNOWN_STATES = ["scheduled", "waiting", "live", "completed", "cancelled", "archived"];
function meetingState(meet) {
  if (meet?.isCancelled === true) return "cancelled";
  const s = lower(meet?.status);
  if (s === "ended") return "completed";
  return KNOWN_STATES.includes(s) ? s : "scheduled";
}

/**
 * Validate the form the way CoWork's own client does before `createMeet`
 * (a title, a start, an end after the start) plus what a PPM needs here.
 * @returns {{ ok, errors, value: { title, description, participants, agenda, dateTime, endsAt, durationMinutes } | null }}
 */
function normaliseMeeting(body = {}, { now = Date.now(), orderRef = "" } = {}) {
  const errors = {};
  const title = str(body.title).trim() || (orderRef ? `PPM · ${orderRef}` : "");
  if (!title) errors.title = "Give the meeting a title.";
  else if (title.length > MAX_TITLE) errors.title = `Keep the title under ${MAX_TITLE} characters.`;

  const description = str(body.description).trim();
  if (description.length > MAX_DESCRIPTION) errors.description = `Keep the note under ${MAX_DESCRIPTION} characters.`;

  const start = body.startsAt ? new Date(body.startsAt) : null;
  if (!start || Number.isNaN(start.getTime())) errors.startsAt = "Say when the meeting starts.";
  else if (start.getTime() < now - PAST_GRACE_MS) errors.startsAt = "The start is in the past. Pick a time from now on.";

  let minutes = body.durationMinutes === undefined || body.durationMinutes === null || body.durationMinutes === ""
    ? DEFAULT_MINUTES : Number(body.durationMinutes);
  if (!Number.isFinite(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    errors.durationMinutes = `The meeting lasts between ${MIN_MINUTES} minutes and ${MAX_MINUTES / 60} hours.`;
    minutes = DEFAULT_MINUTES;
  }

  const participants = [...new Set((Array.isArray(body.participants) ? body.participants : []).map(str).map((s) => s.trim()).filter(Boolean))];
  const agenda = (Array.isArray(body.agenda) ? body.agenda : [])
    .map((a) => str(a).trim()).filter(Boolean).slice(0, MAX_AGENDA_ITEMS);

  const ok = Object.keys(errors).length === 0;
  return {
    ok, errors,
    value: ok ? {
      title, description, participants, agenda,
      dateTime: start.toISOString(),
      endsAt: new Date(start.getTime() + minutes * 60 * 1000).toISOString(),
      durationMinutes: minutes,
    } : null,
  };
}

module.exports = {
  MIN_MINUTES, MAX_MINUTES, DEFAULT_MINUTES, PAST_GRACE_MS, MAX_TITLE, MAX_DESCRIPTION, MAX_AGENDA_ITEMS,
  KNOWN_STATES, meetingState, normaliseMeeting,
};
