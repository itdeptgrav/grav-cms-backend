/**
 * Who is allowed to see a change, derived from the document itself.
 *
 * ## Why this file is the security boundary
 *
 * Firestore's rules are enforced by Google: the browser subscribes directly and
 * the server never sees the read. Take Firestore away and that enforcement goes
 * with it — every realtime update now leaves THIS process, and whatever this
 * file says is who gets it.
 *
 * So the rule here is absolute:
 *
 *   **The audience is computed from the DOCUMENT, never from what a client
 *   asked to join.**
 *
 * `join_cowork` in `server.js` joins whatever `employeeId` a client sends, with
 * no check; `join_group`, `join_dm` and `join_mrf` do the same. Those rooms are
 * addresses anyone can claim. Everything here is addressed to `user:<id>`,
 * which only `socketIdentity` grants and only after verifying a Firebase ID
 * token — see `socketIdentity.js`. The difference is one function call wide and
 * it is the whole model.
 *
 * ## The field names are checked against the writers, not assumed
 *
 * Three of these were wrong on the first attempt and would have failed
 * silently, which is the failure mode this file exists to avoid:
 *
 * · **Notifications are keyed `recipientEmployeeId`**, not `employeeId`
 *   (`services/cowork.service.js:1346`). Reading the wrong field yields
 *   `undefined`, which yields an empty audience, which is a legal answer — so
 *   the bell would simply have stopped, with no error anywhere.
 * · **Duty status and timers are keyed by DOCUMENT ID.** Both are written as
 *   `.doc(String(employeeId))`, so the owner is the id, not a field. Duty also
 *   carries an `employeeId` field on some write paths and not others, which is
 *   exactly the sort of thing that makes a field-only rule look correct in
 *   testing.
 *
 * Every rule therefore receives `(doc, id)` and is free to use either.
 *
 * ## Subcollections
 *
 * `cowork_tasks__chat` and friends hold no audience of their own — who may read
 * a chat message is decided by the TASK it hangs off. A rule here cannot answer
 * that, because answering needs a second read. `parentOf()` names the parent so
 * the broker can do that read and apply the parent's rule; see
 * `changeStreamBroker.deliver`.
 */

const { PRESENCE_ROOM, userRoom } = require("./socketIdentity");

/** The separator `firestoreCompat` uses when it flattens a subcollection. */
const SUBCOLLECTION_SEPARATOR = "__";

/**
 * A per-person delivery room — the AUTHENTICATED one.
 *
 * `user:<employeeId>`, joined only by `socketIdentity` and only for the
 * employee a verified token resolved to. Addressing `String(id)` instead would
 * deliver every task and message to whoever asked for that room by name.
 */
const person = (id) => userRoom(id);

/** Collect ids, ignoring blanks, and turn them into rooms. */
function roomsFor(...ids) {
  const out = new Set();
  for (const id of ids.flat()) {
    const s = String(id ?? "").trim();
    if (s) out.add(person(s));
  }
  return [...out];
}

/** Everyone named on a task, by the same rule that decides who may open it. */
function taskAudience(doc) {
  if (!doc || typeof doc !== "object") return [];
  return roomsFor(
    doc.assigneeIds || [],
    doc.pendingAssigneeId,
    doc.assignedBy,
    doc.originalAssignedBy,
    doc.approverId,
    (doc.departmentApprovals || []).map((a) => a && a.approverId),
    doc.visibleTo || [],
  );
}

/**
 * The rooms a change to each collection should reach.
 *
 * Each rule takes `(doc, id)`. A collection with no entry is NOT broadcast —
 * deliberately, so a new collection is silent until somebody decides who may
 * see it, rather than reaching everyone because nobody wrote a rule yet.
 */
const AUDIENCE = {
  cowork_tasks: (doc) => taskAudience(doc),

  /* One person's notification, and nobody else's — not their manager, not a
     CEO. `recipientEmployeeId` is the field the writer uses; `employeeId` is
     accepted too because older rows and other writers use that name. */
  cowork_notifications: (doc) =>
    roomsFor(doc?.recipientEmployeeId, doc?.employeeId),

  /* A DM thread. `chatId` is `[a,b].sort().join("_")`, so both participants are
     derivable without trusting either of them to say who they are. */
  cowork_direct_messages: (doc, id) => {
    const chatId = String(doc?.chatId ?? id ?? "").trim();
    const parts = chatId.split("_").filter(Boolean);
    return parts.length === 2 ? roomsFor(parts) : [];
  },

  /* A group reaches its members, from the group's own list. */
  cowork_groups: (doc) => roomsFor(doc?.memberIds || [], doc?.members || []),

  /* A conversation's participants, however the row spells them. */
  cowork_conversations: (doc, id) => {
    const listed = roomsFor(doc?.participantIds || [], doc?.memberIds || []);
    if (listed.length) return listed;
    const parts = String(id ?? "").split("_").filter(Boolean);
    return parts.length === 2 ? roomsFor(parts) : [];
  },

  /**
   * Presence goes to the whole workspace, which is what it already does.
   *
   * Keyed by DOCUMENT ID — written `.doc(String(employeeId))` — and the
   * `employeeId` FIELD is present on some write paths and absent on others, so
   * the id leads. But the owner is not the audience: `watchDutyModes`,
   * `watchDutyRoster` and `watchPresence` all exist so somebody can see OTHER
   * people's status, and `server.js` already broadcasts exactly this to
   * everyone. Owner-only delivery would have deleted the feature silently.
   */
  cowork_duty_status: () => [PRESENCE_ROOM],

  /* A running timer belongs to one person, and is keyed by document id. */
  cowork_task_timers: (doc, id) => roomsFor(id, doc?.employeeId),

  /* A mail thread reaches its participants — the same `participantIds` the
     read and the listener filter on (`watchMail`, legacy/index.ts:16229). */
  cowork_mails: (doc) => roomsFor(doc?.participantIds || []),
};

/**
 * The parent of a flattened subcollection, or null.
 *
 * `cowork_tasks__chat` -> `{ parent: "cowork_tasks", child: "chat" }`. Split at
 * the FIRST separator, matching how `firestoreCompat` builds the name.
 */
function parentOf(collection) {
  const at = String(collection).indexOf(SUBCOLLECTION_SEPARATOR);
  if (at <= 0) return null;
  return {
    parent: collection.slice(0, at),
    child: collection.slice(at + SUBCOLLECTION_SEPARATOR.length),
  };
}

/** Whether this collection is broadcast at all, directly or through a parent. */
function isWatched(collection) {
  if (Object.prototype.hasOwnProperty.call(AUDIENCE, collection)) return true;
  const p = parentOf(collection);
  return Boolean(p && Object.prototype.hasOwnProperty.call(AUDIENCE, p.parent));
}

/**
 * The delivery rooms for one change.
 *
 * Returns `[]` — tell nobody — for an unknown collection, a missing document,
 * or a document that names no one. An empty audience is a correct answer and
 * must never be widened into a broadcast.
 */
function audienceFor(collection, doc, id = null) {
  const rule = AUDIENCE[collection];
  if (!rule) return [];
  try {
    return rule(doc, id) || [];
  } catch {
    /* A malformed document must not take the broker down, and must not be
       answered with "everyone" either. */
    return [];
  }
}

module.exports = {
  AUDIENCE,
  SUBCOLLECTION_SEPARATOR,
  audienceFor,
  isWatched,
  parentOf,
  roomsFor,
  taskAudience,
  watchedCollections: () => Object.keys(AUDIENCE),
};
