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
 * The existing socket rooms cannot be trusted for that job. `join_cowork` takes
 * an `employeeId` straight from the client and joins it (`server.js`), and
 * `join_group` / `join_dm` / `join_mrf` do the same with their ids — nobody
 * checks whether the caller is that person or belongs to that thread. That was
 * survivable while rooms only carried notifications and typing flags. It is not
 * survivable once task and message documents travel through them.
 *
 * So the rule here is absolute:
 *
 *   **The audience is computed from the DOCUMENT, never from what a client
 *   asked to join.**
 *
 * A socket that joined `E123` by guessing still receives nothing it is not in
 * the document for, because the emit is addressed to the ids the document
 * itself names. Room membership becomes a delivery address, not a permission.
 *
 * ## One rule, not two
 *
 * `taskAudience` is the same set `mayViewTask` uses in
 * `routes/task_routes/coworkAttachments.js`, and deliberately so. A parallel
 * visibility model would drift, and the first symptom of the drift would be a
 * task update reaching somebody who cannot open the task.
 *
 * Pure functions, no database, no sockets — so the rule can be tested directly.
 */

const { userRoom } = require("./socketIdentity");

/**
 * A per-person delivery room — the AUTHENTICATED one.
 *
 * `userRoom` yields `user:<employeeId>`, a room only `socketIdentity` joins and
 * only for the employee a verified Firebase token resolved to. It is not the
 * bare `<employeeId>` room `join_cowork` hands out on request.
 *
 * That distinction is the entire security model here and it is one character
 * away from being lost: addressing `String(id)` instead would deliver every
 * task and message to whoever asked for that room by name. The legacy room
 * keeps carrying exactly what it carries today; nothing from this migration
 * goes near it.
 */
const person = (id) => userRoom(id);

/** Everyone named on a task, by the same rule that decides who may open it. */
function taskAudience(doc) {
  if (!doc || typeof doc !== "object") return [];
  const out = new Set();
  const add = (v) => {
    const s = String(v ?? "").trim();
    if (s) out.add(person(s));
  };

  for (const id of doc.assigneeIds || []) add(id);
  add(doc.pendingAssigneeId);
  add(doc.assignedBy);
  add(doc.originalAssignedBy);
  add(doc.approverId);
  for (const a of doc.departmentApprovals || []) add(a?.approverId);
  for (const id of doc.visibleTo || []) add(id);

  return [...out];
}

/**
 * The rooms a change to each collection should reach.
 *
 * A collection with no entry here is NOT broadcast. That default is deliberate:
 * a new collection appearing in the database must be silent until somebody has
 * decided who is allowed to see it, rather than reaching everyone because
 * nobody wrote a rule yet.
 */
const AUDIENCE = {
  /* The task itself, and everything the domain hangs off a task id. */
  cowork_tasks: (doc) => taskAudience(doc),

  /* One person's notification. Nobody else, ever — not their manager, not a
     CEO. The document names its owner and that is the whole audience. */
  cowork_notifications: (doc) =>
    doc?.employeeId ? [person(doc.employeeId)] : [],

  /* A DM thread. `chatId` is `[a,b].sort().join("_")`, the same shape
     `join_dm` uses, so both participants are addressable without trusting
     either of them to say who they are. */
  cowork_direct_messages: (doc) => {
    const chatId = String(doc?.chatId ?? "").trim();
    if (!chatId) return [];
    /* Addressed to the two people the id is MADE of, not to the room — so a
       socket that joined `dm_x_y` uninvited receives nothing. */
    const parts = chatId.split("_").filter(Boolean);
    return parts.length === 2 ? parts.map(person) : [];
  },

  /* A group thread reaches its members, from the group document's own list. */
  cowork_groups: (doc) => (doc?.memberIds || []).map(person),

  /* Duty status is a presence fact. It is already broadcast to the workspace
     today (`workspace-member-status`), so this changes nothing about who can
     see it — it is listed so the default-silent rule above stays true. */
  cowork_duty_status: (doc) =>
    doc?.employeeId ? [person(doc.employeeId)] : [],

  /* A running timer belongs to one person. */
  cowork_task_timers: (doc) =>
    doc?.employeeId ? [person(doc.employeeId)] : [],
};

/** Whether this collection is broadcast at all. */
function isWatched(collection) {
  return Object.prototype.hasOwnProperty.call(AUDIENCE, collection);
}

/**
 * The delivery rooms for one change.
 *
 * Returns `[]` — meaning "tell nobody" — for an unknown collection, a missing
 * document, or a document that names no one. An empty audience is a correct
 * answer and must never be widened into a broadcast.
 */
function audienceFor(collection, doc) {
  const rule = AUDIENCE[collection];
  if (!rule) return [];
  try {
    return rule(doc) || [];
  } catch {
    /* A malformed document must not take the broker down, and must not be
       answered with "everyone" either. */
    return [];
  }
}

module.exports = {
  AUDIENCE,
  audienceFor,
  isWatched,
  taskAudience,
  watchedCollections: () => Object.keys(AUDIENCE),
};
