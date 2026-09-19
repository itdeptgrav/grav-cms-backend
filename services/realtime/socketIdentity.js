/**
 * Who a socket actually is.
 *
 * ## The hole this closes
 *
 * `server.js` joins rooms on the client's say-so:
 *
 *   socket.on("join_cowork", (employeeId) => socket.join(String(employeeId)))
 *   socket.on("join_group",  (groupId)    => socket.join(`group_${groupId}`))
 *   socket.on("join_dm",     (chatId)     => socket.join(`dm_${chatId}`))
 *
 * Nobody checks that the caller IS that employee or belongs to that thread. A
 * socket can join any room by naming it. That was survivable while those rooms
 * carried typing flags and presence pings, and while the DATA came from
 * Firestore with Google enforcing the rules on every read.
 *
 * Moving the database to MongoDB removes that enforcement. If task and message
 * documents start travelling through rooms anyone can join, the rooms become
 * the leak.
 *
 * ## The shape of the fix
 *
 * Two things, deliberately separate:
 *
 * 1. **This middleware** verifies the Firebase ID token on the handshake and
 *    records the employee it resolves to on `socket.data`. Firebase Auth is
 *    staying, so this is the same identity the HTTP routes already trust —
 *    `Middlewear/coworkAuth.js` does exactly this for requests.
 * 2. **A separate room namespace.** Authenticated delivery goes to
 *    `user:<employeeId>`, which ONLY this module joins, and only for the
 *    employee the token resolved to. The legacy bare-`<employeeId>` room is
 *    left exactly as it is, still joinable by anyone, still carrying what it
 *    carries today.
 *
 * That separation is what makes this safe to add without breaking anything: no
 * existing client changes behaviour, and no existing room gains data. A client
 * that sends no token simply never joins the new namespace, and receives none
 * of the new traffic — degraded, not broken.
 *
 * **Do not "simplify" this by emitting into the legacy room.** The legacy room
 * is a delivery address anyone can claim; `user:` is one only the server can
 * grant. Merging them re-opens the hole silently.
 */

/** The only room prefix the change broker may address. */
const USER_ROOM = "user:";

/** The room for one employee, once the server has verified they are that person. */
function userRoom(employeeId) {
  return `${USER_ROOM}${String(employeeId)}`;
}

/** Whether a room name is one this module grants, rather than one a client claimed. */
function isAuthenticatedRoom(room) {
  return typeof room === "string" && room.startsWith(USER_ROOM);
}

/**
 * Build the Socket.IO middleware.
 *
 * `verify` and `resolveEmployee` are injected rather than imported so this can
 * be tested without Firebase and without a database — the same split the rest
 * of this migration uses, and the reason every branch below is reachable in a
 * test.
 *
 * @param {object} deps
 * @param {(token: string) => Promise<{uid: string}>} deps.verifyIdToken
 * @param {(uid: string) => Promise<{employeeId: string}|null>} deps.resolveEmployee
 * @param {(msg: string, extra?: unknown) => void} [deps.log]
 */
function socketIdentity({ verifyIdToken, resolveEmployee, log = () => {} }) {
  return async function identify(socket, next) {
    /* Both places a client can put it. `auth` is the documented one; the query
       string is what an older client or a reconnecting tab may still use. */
    const token =
      socket.handshake?.auth?.token || socket.handshake?.query?.token || null;

    if (!token) {
      /**
       * **Allowed through, deliberately.**
       *
       * Refusing would disconnect every client that has not been updated yet —
       * the production socket carries presence, typing, meeting signals and
       * MRF chat, none of which is changing. An anonymous socket simply never
       * joins `user:` and so receives none of the data this migration moves.
       *
       * The security property does not depend on refusing here. It depends on
       * nothing being emitted to a room this middleware did not grant.
       */
      socket.data.employeeId = null;
      return next();
    }

    try {
      const decoded = await verifyIdToken(token);
      const employee = await resolveEmployee(decoded.uid);
      if (!employee?.employeeId) {
        /* A valid Firebase user with no workspace record. Authenticated as far
           as Firebase is concerned and nobody here — so, again, no room. */
        socket.data.employeeId = null;
        return next();
      }
      socket.data.employeeId = String(employee.employeeId);
      socket.data.authUid = decoded.uid;
      socket.join(userRoom(employee.employeeId));
      return next();
    } catch (error) {
      /**
       * A bad or expired token is not a reason to refuse the connection.
       *
       * Tokens expire on a schedule the SDK manages, and a tab that wakes from
       * sleep reconnects with a stale one before it refreshes. Dropping it
       * would take the meeting and the chat down with it. It gets no `user:`
       * room until it reconnects with a good token, which is the whole
       * consequence.
       */
      log("socket presented a token that did not verify", error?.message);
      socket.data.employeeId = null;
      return next();
    }
  };
}

module.exports = {
  USER_ROOM,
  isAuthenticatedRoom,
  socketIdentity,
  userRoom,
};
