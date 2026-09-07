let _io = null;

/**
 * What End for everyone needs from the socket server — attached by server.js.
 *
 * Kept SEPARATE from `_io` on purpose. server.js has never called `init`: it
 * publishes the server with `app.set("io", io)` instead, so `emitTo` and
 * `emitToMany` below have been reaching nobody. Making them live is a product
 * decision with a wide blast radius — every dormant task, message and meeting
 * event would start firing at once, into clients that may or may not expect
 * them. This attaches only the meeting rooms and the live-recording registry,
 * so the one new path works, and leaves that decision where it is.
 */
let _meetIo = null;
let _activeRecordings = null;

/**
 * Meetings ended for everyone, by id, for the life of this process.
 *
 * A socket that (re)joins a finished meeting's room — a participant whose
 * connection came back after the organiser pressed End — is answered from
 * this, so it cannot sit alone in a room the meeting has left. Bounded: an
 * entry is dropped after `ENDED_TTL_MS`, and swept on each write.
 */
const endedMeetings = new Map();
const ENDED_TTL_MS = 6 * 60 * 60 * 1000;

module.exports = {
  init: (io) => { _io = io; },
  get: () => _io,
  /** Emit to a specific employee's socket room */
  emitTo: (employeeId, event, data) => {
    if (_io && employeeId) _io.to(String(employeeId)).emit(event, data);
  },
  /** Emit to multiple employees */
  emitToMany: (employeeIds, event, data) => {
    if (!_io) return;
    (employeeIds || []).forEach((id) => _io.to(String(id)).emit(event, data));
  },

  /** server.js hands over the server and its live-recording map — see above. */
  attachMeetingRooms: ({ io, activeRecordings }) => {
    _meetIo = io || null;
    _activeRecordings = activeRecordings || null;
  },
  /**
   * Emit to a Socket.IO room by name.
   *
   * `meeting_<meetId>` holds every socket in a meeting — guests included, whom
   * a list of employee ids can never reach — which is why End for everyone
   * goes through this and not `emitToMany`.
   */
  emitToRoom: (room, event, data) => {
    const io = _meetIo || _io;
    if (io && room) io.to(String(room)).emit(event, data);
  },
  /**
   * Forget a finished meeting's live recording, so a socket joining its room
   * afterwards is not replayed a `recording_started` into a meeting that is
   * over. The organiser's wrap-up panel joins that room to watch the uploads
   * land; without this it would have restarted the organiser's own recorder.
   */
  clearActiveRecording: (meetId) => {
    if (_activeRecordings && meetId) _activeRecordings.delete(meetId);
  },
  markMeetingEnded: (meetId, payload) => {
    if (!meetId) return;
    const now = Date.now();
    for (const [id, row] of endedMeetings) {
      if (now - row.at > ENDED_TTL_MS) endedMeetings.delete(id);
    }
    endedMeetings.set(String(meetId), { at: now, payload });
  },
  endedMeeting: (meetId) => {
    const row = meetId ? endedMeetings.get(String(meetId)) : null;
    if (!row) return null;
    if (Date.now() - row.at > ENDED_TTL_MS) {
      endedMeetings.delete(String(meetId));
      return null;
    }
    return row.payload;
  },
};
