/**
 * GRAV-CMS-BACKEND/services/coworkMeetingChat.service.js
 *
 * The durable ledger under the meeting-chat data channel.
 *
 * ## What this is, and what it is NOT
 *
 * Meeting chat is delivered by LiveKit's data channel and always will be: it is
 * instant, it costs nothing to run, it works for unauthenticated guests, and it
 * reconnects on its own. None of that changes. This service is a LEDGER written
 * underneath that transport, so a message survives a refresh and somebody
 * joining late can read what was said.
 *
 * The consequence of that ordering is deliberate: if this service is down, chat
 * still works exactly as it does today. The worst failure mode is the current
 * product, not a broken room.
 *
 * ## Idempotency is the whole design, not a nicety
 *
 * The document id IS the LiveKit stream id the sender's `send()` returned, so a
 * message has one identity on both transports. Writes therefore use `.create()`
 * and treat ALREADY_EXISTS as success, returning the stored row. That is what
 * lets an offline outbox replay blindly on reconnect without re-stamping
 * `createdAt`, duplicating a row, or clobbering anything written since.
 *
 * ## Two id spaces, and the one that must never reach here
 *
 * `TaskRoom` names its LiveKit room `meet-task-<taskId>` — a DERIVED name, not a
 * `cowork_scheduled_meets` document id. Firestore will happily create a
 * subcollection under a parent document that does not exist, so a task-room
 * message keyed on that name would be written somewhere no query can see and,
 * worse, somewhere the retention sweep can never find — persisting forever in a
 * product that tells people chat expires. Any meetId shaped like a room name is
 * refused outright.
 *
 * ## Retention, and why the parent carries a field
 *
 * Each row stamps `deleteAtMs`. The parent meeting stamps
 * `chatOldestDeleteAtMs`, and the sweep finds work by querying MEETINGS on that
 * field. It must never be a `collectionGroup("messages")` query: DM and group
 * threads live in subcollections with that exact name
 * (`cowork_direct_messages/{id}/messages`, `cowork_groups/{id}/messages`), so a
 * collection-group delete on `deleteAtMs` would one day take the company's
 * private messages with it.
 */

const admin = require("firebase-admin");
const { db } = require("../config/firebaseAdmin");

const MEETS = "cowork_scheduled_meets";
const MESSAGES = "messages";

/** 90 days. Long enough that "I lost the chat" stops being a support ticket,
    short enough that it is not a permanent record of unverified guest names. */
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** A meeting that has finished, been cancelled or been archived takes no new
    messages. Reading its history is still allowed — that is the point. */
const WRITABLE_STATUSES = ["scheduled", "waiting", "live"];

/** One page, and the ceiling on what a caller may ask for. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Guardrails on what any caller may write into the durable record.
 *
 * The client normalises attachments before it sends them, but a hand-crafted
 * request does not run that code — and the guest route is reached with only a
 * guest-session id. Because a stored row is rendered to every participant
 * (employees included) and kept for 90 days, this normalises each attachment to
 * the known fields with an http(s) URL, dropping anything else, and caps the
 * text length and the attachment count. A `javascript:`/`data:` URL or an
 * arbitrarily nested object therefore never reaches the ledger.
 */
const MAX_TEXT_LEN = 8000;
const MAX_ATTACHMENTS = 20;
const ATTACHMENT_KINDS = new Set(["image", "video", "voice", "pdf", "file"]);

function sanitizeAttachments(input) {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, MAX_ATTACHMENTS)
    .map((a) => {
      const o = a && typeof a === "object" ? a : {};
      const url =
        typeof o.url === "string" && /^https?:\/\//i.test(o.url) ? o.url : "";
      const fileId =
        typeof o.fileId === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(o.fileId)
          ? o.fileId
          : null;
      return {
        url,
        kind: ATTACHMENT_KINDS.has(o.kind) ? o.kind : "file",
        name: typeof o.name === "string" ? o.name.slice(0, 300) : null,
        sizeBytes: Number.isFinite(o.sizeBytes) ? Number(o.sizeBytes) : null,
        durationSecs: Number.isFinite(o.durationSecs)
          ? Number(o.durationSecs)
          : null,
        fileId,
      };
    })
    /* Neither a usable URL nor a Drive id is nothing to render — drop it rather
       than store an empty card. */
    .filter((a) => a.url || a.fileId);
}

/**
 * A meetId that is really a LiveKit room name.
 *
 * `meet-task-<taskId>` is built by the client and is not a document id. See the
 * note at the top of this file for what happens if one is written.
 */
function isRoomName(meetId) {
  return typeof meetId === "string" && /^meet-/.test(meetId);
}

/**
 * The meeting, or null — and never a subcollection under a parent that is not
 * there.
 */
async function _readMeet(meetId) {
  if (!meetId || isRoomName(meetId)) return null;
  const snap = await db.collection(MEETS).doc(String(meetId)).get();
  return snap.exists ? snap.data() : null;
}

/**
 * May this employee read or write this meeting's chat?
 *
 * Organiser or named participant, and nothing else.
 *
 * **Deliberately narrower than the meeting read routes**, which carry only
 * `verifyCoworkToken + verifyEmployeeToken` and no membership check at all —
 * any signed-in employee can read any meeting today. That is worth fixing and
 * is NOT fixed here: copying it would spread the hole, and widening it quietly
 * inside a chat feature would be the wrong place to make that decision.
 */
function isMember(meet, employeeId) {
  if (!meet || !employeeId) return false;
  const me = String(employeeId);
  if (String(meet.createdBy ?? "") === me) return true;
  const participants = Array.isArray(meet.participants) ? meet.participants : [];
  return participants.map(String).includes(me);
}

function statusOf(meet) {
  return meet.isCancelled === true ? "cancelled" : meet.status || "scheduled";
}

/**
 * Store one message, or report the one already stored under that id.
 *
 * `messageId` is the sender's LiveKit stream id. Passing the same one twice is
 * expected — that is a retry or an outbox replay — and answers with the stored
 * row rather than a second document or an error.
 */
async function appendMeetingMessage({
  meetId,
  messageId,
  senderId,
  senderName,
  senderKind,
  text,
  attachments,
  nowMs,
}) {
  if (!meetId || isRoomName(meetId)) {
    const err = new Error("This meeting cannot carry a saved chat.");
    err.code = "BAD_MEETING";
    throw err;
  }
  if (!messageId) {
    const err = new Error("messageId is required.");
    err.code = "BAD_REQUEST";
    throw err;
  }

  const body = String(text ?? "").slice(0, MAX_TEXT_LEN);
  const files = sanitizeAttachments(attachments);
  if (!body.trim() && files.length === 0) {
    const err = new Error("An empty message is not stored.");
    err.code = "BAD_REQUEST";
    throw err;
  }

  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const deleteAtMs = now + RETENTION_MS;

  const ref = db
    .collection(MEETS)
    .doc(String(meetId))
    .collection(MESSAGES)
    .doc(String(messageId));

  const row = {
    messageId: String(messageId),
    meetId: String(meetId),
    senderId: String(senderId ?? ""),
    senderName: String(senderName ?? ""),
    /* "employee" or "guest". Stored rather than inferred, because a guest's
       display name is self-typed and unverified — the bubble has to be able to
       say so, and a reader cannot tell from the name alone. */
    senderKind: senderKind === "guest" ? "guest" : "employee",
    text: body,
    attachments: files,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    /* The sender's own clock, kept ALONGSIDE the server stamp rather than
       instead of it. Ordering uses the server's; this is only for telling how
       far a client's clock was off when something looks wrong. */
    clientCreatedAtMs: now,
    deleteAtMs,
  };

  try {
    await ref.create(row);
  } catch (e) {
    /* ALREADY_EXISTS is the success path for a replay, not an error. Firestore
       reports it as gRPC code 6. */
    if (e && (e.code === 6 || /already exists/i.test(e.message || ""))) {
      const existing = await ref.get();
      return { stored: existing.exists ? existing.data() : row, duplicate: true };
    }
    throw e;
  }

  /* The parent learns the OLDEST expiry it holds, which is what the sweep
     queries on. `.update()` and never `.set()`: this document is mirrored
     wholesale into Realtime Database and is read by the live legacy app, so a
     whole-document write here would clobber concurrent edits. */
  try {
    const meetRef = db.collection(MEETS).doc(String(meetId));
    const snap = await meetRef.get();
    const current = Number(snap.exists ? snap.data().chatOldestDeleteAtMs : 0);
    if (!current || deleteAtMs < current) {
      await meetRef.update({ chatOldestDeleteAtMs: deleteAtMs });
    }
  } catch (e) {
    /* A stamp that fails must never fail the message. The sweep would miss this
       meeting until the next message lands, which is a retention delay rather
       than a lost message. */
    console.error("[meeting-chat] retention stamp:", e.message);
  }

  const saved = await ref.get();
  return { stored: saved.exists ? saved.data() : row, duplicate: false };
}

/**
 * A page of history, oldest-last, with an inclusive cursor.
 *
 * **Inclusive on purpose.** `serverTimestamp()` is not unique — two messages a
 * few milliseconds apart can share one — so an exclusive cursor silently drops
 * every row that shares the boundary instant. The caller de-duplicates by
 * `messageId`, which it must do anyway because the same message arrives on the
 * data channel.
 */
async function listMeetingMessages({ meetId, beforeMs, afterMs, limit }) {
  if (!meetId || isRoomName(meetId)) return { messages: [], hasMore: false };

  const size = Math.min(
    Math.max(Number(limit) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  let q = db
    .collection(MEETS)
    .doc(String(meetId))
    .collection(MESSAGES)
    .orderBy("createdAt", "desc");

  if (Number.isFinite(Number(beforeMs)) && Number(beforeMs) > 0) {
    q = q.where("createdAt", "<=", new Date(Number(beforeMs)));
  }
  if (Number.isFinite(Number(afterMs)) && Number(afterMs) > 0) {
    q = q.where("createdAt", ">=", new Date(Number(afterMs)));
  }

  /* One more than asked for, so "is there another page" is answered without a
     second query and without a count. */
  const snap = await q.limit(size + 1).get();
  const rows = snap.docs.slice(0, size).map((d) => {
    const x = d.data();
    const at = x.createdAt && x.createdAt.toDate ? x.createdAt.toDate() : null;
    return {
      messageId: String(x.messageId || d.id),
      senderId: String(x.senderId || ""),
      senderName: String(x.senderName || ""),
      senderKind: x.senderKind === "guest" ? "guest" : "employee",
      text: String(x.text || ""),
      attachments: Array.isArray(x.attachments) ? x.attachments : [],
      createdAt: at ? at.toISOString() : "",
      createdAtMs: at ? at.getTime() : 0,
    };
  });

  /* Oldest first, which is the order a thread renders in. The query runs
     descending so that a page taken WITHOUT a cursor is the most recent one. */
  rows.reverse();
  return { messages: rows, hasMore: snap.docs.length > size };
}

module.exports = {
  RETENTION_MS,
  WRITABLE_STATUSES,
  isRoomName,
  isMember,
  statusOf,
  appendMeetingMessage,
  listMeetingMessages,
  _readMeet,
};
