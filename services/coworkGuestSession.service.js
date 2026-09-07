/**
 * GRAV-CMS-BACKEND/services/coworkGuestSession.service.js
 *
 * Shared guest-session validation for the unauthenticated guest routes.
 *
 * A guest joins a meeting through a share link, not a Firebase login, so the
 * guest-facing routes cannot lean on `verifyCoworkToken + verifyEmployeeToken`.
 * Instead the browser carries a `guestSessionId`, and every guest route proves
 * it against `cowork_guest_sessions/{guestSessionId}` before doing any work: the
 * session must exist, still be `active`, and belong to the meeting whose id is
 * on the request.
 *
 * This is the exact check the guest AUDIO routes already run inline in
 * audioRecording.routes.js — lifted into one place so the meeting-chat and
 * Drive-upload guest routes validate identically instead of each keeping their
 * own copy.
 *
 * Returns the session data ({ guestId, guestName, ... }) on success, or null —
 * callers turn null into a 403.
 */

const { db } = require("../config/firebaseAdmin");

/**
 * The guest session, or null when it is missing, inactive, or tied to a
 * different meeting than the one on the request.
 */
async function validateGuestSession(meetId, guestSessionId) {
  if (!meetId || !guestSessionId) return null;
  const doc = await db
    .collection("cowork_guest_sessions")
    .doc(guestSessionId)
    .get();
  if (!doc.exists) return null;
  const session = doc.data();
  if (session.meetId !== String(meetId) || session.active !== true) return null;
  return session;
}

module.exports = { validateGuestSession };
