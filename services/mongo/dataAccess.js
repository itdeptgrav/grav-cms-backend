/**
 * The browser's data access, once it can no longer reach the database.
 *
 * ## Why this exists
 *
 * The Cowork frontend reads and writes Firestore DIRECTLY — 96 dynamic imports
 * of `firebase/firestore`, ~135 call sites in `lib/repositories/legacy/index.ts`
 * alone. That was acceptable because Firestore's security rules sat between the
 * browser and the data, enforced by Google on every request.
 *
 * MongoDB has no such thing. A browser must never hold a MongoDB connection, so
 * every one of those reads and writes now arrives here, over HTTP, carrying a
 * verified Firebase ID token, and THIS FILE is what stands where the rules
 * stood. The rules themselves were never in this repository — they lived only in
 * the Firebase console — so the policy below is written from what the frontend
 * actually does, collection by collection, and it is written to be read.
 *
 * ## The one rule
 *
 *   **Deny by default.** A collection with no entry in `ACCESS` is refused —
 *   read and write — and the refusal names the collection, so the first person
 *   to hit it finds out in one request rather than by a screen going quietly
 *   blank. Widening is a one-line, reviewable change; a permissive default is
 *   an unreviewable one.
 *
 * ## The three read levels and four write levels
 *
 *   read:  "employee"  any authenticated workspace employee (the directory,
 *                      settings — things every screen needs)
 *          "audience"  only people the document names, by the SAME rule that
 *                      decides who receives its realtime change (`rooms.js`),
 *                      so a person can never be told about a change to a
 *                      document they could not read. CEO reads everything, as
 *                      `mayViewTask` already allows.
 *          "deny"
 *   write: "employee" | "audience" | "owner" (document id or `employeeId` is
 *          the caller) | "deny"
 *
 * A subcollection (`cowork_tasks/{id}/chat`) takes its parent's policy, with an
 * "audience" check resolved against the PARENT document — a chat message names
 * nobody; the task it hangs off does.
 */

"use strict";

const { FieldValue, OPERATORS } = require("./firestoreCompat");
const { audienceFor, parentOf } = require("../realtime/rooms");
const { userRoom } = require("../realtime/socketIdentity");

/* ── Policy ───────────────────────────────────────────────────────────────── */

const ACCESS = {
  /* Tasks and everything that hangs off a task id. Reads by the people the
     task names; writes the same, since assignees, approvers and creators all
     patch the task from the browser today. */
  cowork_tasks: { read: "audience", write: "audience" },
  cowork_task_deadline_extensions: { read: "employee", write: "employee" },
  cowork_task_budget_extensions: { read: "employee", write: "employee" },
  cowork_task_budget_credits: { read: "employee", write: "employee" },
  cowork_task_requirement_progress: { read: "employee", write: "employee" },
  cowork_task_tab_seen: { read: "owner", write: "owner" },
  cowork_emergency_approvals: { read: "employee", write: "employee" },

  /* Time. A timer belongs to its owner; commits are read by managers. */
  cowork_task_timers: { read: "employee", write: "owner" },
  cowork_timer_events: { read: "employee", write: "owner" },
  cowork_work_commits: { read: "employee", write: "owner" },

  /* Presence is workspace-wide by design — see rooms.js. */
  cowork_duty_status: { read: "employee", write: "owner" },
  cowork_duty_history: { read: "employee", write: "owner" },

  /* One person's notifications. */
  cowork_notifications: { read: "audience", write: "audience" },
  cowork_fcm_tokens: { read: "owner", write: "owner" },

  /* Conversations: participants only. */
  cowork_direct_messages: { read: "audience", write: "audience" },
  cowork_groups: { read: "audience", write: "audience" },
  cowork_conversations: { read: "audience", write: "audience" },
  cowork_mails: { read: "audience", write: "audience" },
  cowork_mail_attachments: { read: "employee", write: "employee" },

  /* The directory and the workspace's configuration: every screen reads them.
     Writes to settings are an administrator's job and go through routes that
     check the role — the browser does not write them directly. */
  cowork_employees: { read: "employee", write: "deny" },
  cowork_settings: { read: "employee", write: "deny" },
  cowork_settings_audit: { read: "employee", write: "deny" },
  cowork_sop_settings: { read: "employee", write: "deny" },
  cowork_sop_applied: { read: "employee", write: "deny" },
  bandconfigs: { read: "employee", write: "deny" },

  /* Documents, sheets and mind maps: any employee may read; the routes that
     write them already check sharing, so direct writes are limited to owners. */
  cowork_documents: { read: "employee", write: "owner" },
  cowork_document_bodies: { read: "employee", write: "owner" },
  cowork_workbooks: { read: "employee", write: "owner" },
  cowork_workbook_bodies: { read: "employee", write: "owner" },
  cowork_workbook_versions: { read: "employee", write: "owner" },
  cowork_mindmaps: { read: "employee", write: "owner" },
  cowork_mindmap_bodies: { read: "employee", write: "owner" },

  /* Meetings. */
  cowork_scheduled_meets: { read: "employee", write: "employee" },
  /* The browser reads this one too (found by grepping the frontend for every
     collection the dry run listed); without an entry every task's Meetings tab
     would 403. */
  cowork_task_meetings: { read: "employee", write: "employee" },
  cowork_meeting_participants: { read: "employee", write: "employee" },
  meeting_sessions: { read: "employee", write: "deny" },
  meeting_summaries: { read: "employee", write: "deny" },
  meeting_verbatim_transcripts: { read: "employee", write: "deny" },
};

/** Which prefixes may be addressed at all, whatever the table says. */
const ALLOWED_PREFIXES = ["cowork_", "meeting_", "bandconfigs"];

/* ── Errors the caller can act on ─────────────────────────────────────────── */

class AccessError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = "AccessError";
  }
}

/* ── Paths ────────────────────────────────────────────────────────────────── */

/**
 * `["cowork_tasks", "T1", "chat", "m1"]` → the facade reference for it.
 *
 * Segments alternate collection / document, exactly as a Firestore path does.
 * An odd count is a collection reference, an even count a document reference.
 * Every collection segment is checked against the allowed prefixes AND must not
 * contain the flattening separator — a client that names `cowork_tasks__chat`
 * directly would be reaching around the parent-scoped read.
 */
function refFromPath(db, path) {
  if (!Array.isArray(path) || path.length === 0)
    throw new AccessError(400, "A path is required.");
  for (const [i, seg] of path.entries()) {
    if (typeof seg !== "string" || seg.length === 0 || seg.length > 512)
      throw new AccessError(400, `Path segment ${i} is not a valid id.`);
    if (i % 2 === 0) {
      if (seg.includes("__"))
        throw new AccessError(400, `"${seg}" is not an addressable collection.`);
      /* Only the ROOT carries the product prefix. A subcollection segment is
         a plain name — `chat`, `messages`, `sessions` — and is scoped by the
         document above it, not by a prefix. */
      if (i === 0 && !ALLOWED_PREFIXES.some((p) => seg === p || seg.startsWith(p)))
        throw new AccessError(403, `"${seg}" is not a Cowork collection.`);
    }
  }
  let ref = db.collection(path[0]);
  for (let i = 1; i < path.length; i += 1) {
    ref = i % 2 === 1 ? ref.doc(path[i]) : ref.collection(path[i]);
  }
  return ref;
}

const isDocPath = (path) => path.length % 2 === 0;
const topCollectionOf = (path) => path[0];
const parentPathOf = (path) => (path.length >= 3 ? path.slice(0, 2) : null);

/* ── The check ────────────────────────────────────────────────────────────── */

function policyFor(collection) {
  const p = ACCESS[collection];
  if (!p)
    throw new AccessError(
      403,
      `No access policy for "${collection}". Add it to services/mongo/dataAccess.js.`,
    );
  return p;
}

function inAudience(collection, doc, id, caller) {
  if (caller.role === "ceo") return true;
  return audienceFor(collection, doc, id).includes(userRoom(caller.employeeId));
}

function isOwner(doc, id, caller) {
  const me = String(caller.employeeId);
  if (String(id) === me) return true;
  if (doc && typeof doc === "object") {
    for (const f of ["employeeId", "ownerId", "createdBy", "recipientEmployeeId"])
      if (String(doc[f] ?? "") === me) return true;
    if (Array.isArray(doc.participantIds) && doc.participantIds.map(String).includes(me))
      return true;
  }
  return false;
}

/**
 * May this caller read this document? `doc` may be null (not found), in which
 * case the answer is yes — nothing is revealed by a miss.
 *
 * For a subcollection document the parent document decides, so the caller
 * passes `parentDoc` when it has it.
 */
function mayRead(path, doc, caller, parentDoc = null) {
  const top = topCollectionOf(path);
  const level = policyFor(top).read;
  if (level === "deny") return false;
  if (level === "employee") return true;
  if (doc == null) return true;
  const target = path.length > 2 ? parentDoc : doc;
  const targetId = path.length > 2 ? path[1] : path[1];
  if (level === "owner") return isOwner(target, targetId, caller);
  return inAudience(top, target, targetId, caller);
}

function mayWrite(path, existing, caller, parentDoc = null) {
  const top = topCollectionOf(path);
  const level = policyFor(top).write;
  if (level === "deny") return false;
  if (level === "employee") return true;
  const target = path.length > 2 ? parentDoc : existing;
  const targetId = path[1];
  if (level === "owner") {
    /* Creating a document you will own is allowed; a subcollection write is
       judged by the parent's owner. */
    if (target == null) return path.length <= 2 || caller.role === "ceo";
    return isOwner(target, targetId, caller);
  }
  if (target == null) return true; // creating; the audience does not exist yet
  return inAudience(top, target, targetId, caller);
}

/* ── Wire values ──────────────────────────────────────────────────────────── */

/**
 * The browser cannot send a `FieldValue` — it is a symbol-tagged object on the
 * server and nothing on the wire. It sends `{__fv: kind, ...}` and this turns
 * it back into the real thing. Timestamps arrive as `{__ts: {seconds,
 * nanoseconds}}` and become Dates.
 */
function decodeValue(v, depth = 0) {
  if (depth > 64) throw new AccessError(400, "Value nested too deeply.");
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => decodeValue(x, depth + 1));
  if (typeof v.__fv === "string") {
    switch (v.__fv) {
      case "serverTimestamp":
        return FieldValue.serverTimestamp();
      case "delete":
        return FieldValue.delete();
      case "increment":
        return FieldValue.increment(Number(v.by) || 0);
      case "arrayUnion":
        return FieldValue.arrayUnion(...(Array.isArray(v.values) ? v.values : []));
      case "arrayRemove":
        return FieldValue.arrayRemove(...(Array.isArray(v.values) ? v.values : []));
      default:
        throw new AccessError(400, `Unknown field value "${v.__fv}".`);
    }
  }
  if (v.__ts && typeof v.__ts.seconds === "number") {
    return new Date(
      v.__ts.seconds * 1000 + Math.floor((v.__ts.nanoseconds || 0) / 1e6),
    );
  }
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (k.startsWith("$"))
      throw new AccessError(400, `Field name "${k}" is not allowed.`);
    out[k] = decodeValue(x, depth + 1);
  }
  return out;
}

/** `__name__` is how the client SDK spells "the document id". */
const fieldName = (f) => (f === "__name__" ? "_id" : String(f));

/* ── Operations ───────────────────────────────────────────────────────────── */

async function readParent(db, path) {
  const pp = parentPathOf(path);
  if (!pp) return null;
  const snap = await refFromPath(db, pp).get();
  return snap.exists ? snap.data() : null;
}

const encodeSnap = (snap) => ({
  id: snap.id,
  exists: snap.exists,
  data: snap.exists ? snap.data() : null,
});

/**
 * Run one operation from the browser.
 *
 * @param {object} db      the Firestore-compatible facade
 * @param {object} caller  `{ employeeId, role }` from the verified token
 * @param {object} op      the request body
 */
async function execute(db, caller, op) {
  if (!op || typeof op !== "object") throw new AccessError(400, "Bad request.");
  const path = op.path;

  switch (op.op) {
    /**
     * Several INDEPENDENT operations in one request.
     *
     * Not a batch: nothing here is atomic, and one failure does not touch the
     * others. This exists because of how the browser reaches a database now.
     * Firestore multiplexed every read over a single connection; a request per
     * read is limited by the browser to six at a time to one origin, so the
     * fourteen unread counts one conversation list asks for arrive in three
     * waves instead of one. That queueing is what a reader feels as lag.
     *
     * Each operation still goes through `execute` on its own, with the same
     * caller and the same policy, so nothing here can be read or written that
     * could not be one request at a time. A failure is reported in that
     * operation's own slot and the rest still answer.
     */
    case "multi": {
      const many = Array.isArray(op.ops) ? op.ops : [];
      if (many.length === 0) return { results: [] };
      if (many.length > 50)
        throw new AccessError(400, "A multi request may hold at most 50 operations.");
      if (many.some((o) => o && o.op === "multi"))
        throw new AccessError(400, "A multi request cannot contain another.");
      const results = await Promise.all(
        many.map(async (one) => {
          try {
            return { ok: true, data: await execute(db, caller, one) };
          } catch (e) {
            if (e instanceof AccessError)
              return { ok: false, status: e.status, error: e.message };
            if (e && e.code === 5) return { ok: false, status: 404, error: e.message };
            /* An unexpected failure is reported as one, without leaking its
               internals — the same thing the route does for a single op. */
            return { ok: false, status: 500, error: "The request could not be completed." };
          }
        }),
      );
      return { results };
    }

    case "get": {
      if (!isDocPath(path)) throw new AccessError(400, "get needs a document path.");
      const parent = path.length > 2 ? await readParent(db, path) : null;
      const snap = await refFromPath(db, path).get();
      if (!mayRead(path, snap.exists ? snap.data() : null, caller, parent))
        throw new AccessError(403, "You do not have access to this record.");
      return { doc: encodeSnap(snap) };
    }

    case "query": {
      if (isDocPath(path)) throw new AccessError(400, "query needs a collection path.");
      /* The path is validated BEFORE the policy is consulted, so a malformed
         or flattened name is a 400 about the path, not a 403 about a policy
         that was never meant to exist for it. */
      let q = refFromPath(db, path);
      const top = topCollectionOf(path);
      const level = policyFor(top).read;
      if (level === "deny") throw new AccessError(403, `Reads of "${top}" are not allowed.`);

      for (const w of op.where || []) {
        if (!OPERATORS[w.op]) throw new AccessError(400, `Unsupported operator "${w.op}".`);
        q = q.where(fieldName(w.field), w.op, decodeValue(w.value));
      }
      for (const o of op.orderBy || []) q = q.orderBy(fieldName(o.field), o.dir === "desc" ? "desc" : "asc");
      if (op.startAt !== undefined) q = q.startAt(decodeValue(op.startAt));
      if (op.startAfter !== undefined) q = q.startAfter(decodeValue(op.startAfter));
      if (op.limit != null) q = q.limit(Math.min(Math.max(1, Number(op.limit) || 1), 1000));

      const snap = await q.get();
      const parent = path.length > 2 ? await readParent(db, path) : null;
      /* Filtered SERVER-side, per document, so a query can never return a row
         the caller could not have fetched by id. */
      const docs = snap.docs
        .filter((d) => mayRead([...path, d.id], d.data(), caller, parent))
        .map(encodeSnap);
      return { docs };
    }

    case "set":
    case "update": {
      if (!isDocPath(path)) throw new AccessError(400, `${op.op} needs a document path.`);
      const ref = refFromPath(db, path);
      const parent = path.length > 2 ? await readParent(db, path) : null;
      const existing = await ref.get();
      if (!mayWrite(path, existing.exists ? existing.data() : null, caller, parent))
        throw new AccessError(403, "You do not have access to change this record.");
      const data = decodeValue(op.data ?? {});
      if (op.op === "set") await ref.set(data, { merge: op.merge === true });
      else await ref.update(data);
      return { ok: true };
    }

    case "add": {
      if (isDocPath(path)) throw new AccessError(400, "add needs a collection path.");
      const parent = path.length > 2 ? await readParent(db, path) : null;
      if (!mayWrite([...path, "new"], null, caller, parent))
        throw new AccessError(403, "You do not have access to add here.");
      const ref = await refFromPath(db, path).add(decodeValue(op.data ?? {}));
      return { id: ref.id };
    }

    case "delete": {
      if (!isDocPath(path)) throw new AccessError(400, "delete needs a document path.");
      const ref = refFromPath(db, path);
      const parent = path.length > 2 ? await readParent(db, path) : null;
      const existing = await ref.get();
      if (!existing.exists) return { ok: true };
      if (!mayWrite(path, existing.data(), caller, parent))
        throw new AccessError(403, "You do not have access to delete this record.");
      await ref.delete();
      return { ok: true };
    }

    case "batch": {
      const ops = Array.isArray(op.ops) ? op.ops : [];
      if (ops.length > 500) throw new AccessError(400, "A batch may hold at most 500 writes.");
      /* Every permission is checked BEFORE anything is written, so a batch is
         refused whole rather than half-applied. */
      /**
       * The permission reads happen ALL AT ONCE, and each parent is read once.
       *
       * This loop used to be sequential and to re-read the parent for every
       * write: two round trips per operation, one after the other. Marking a
       * conversation read is one write per unread message, so opening a thread
       * with forty unread messages spent about eighty round trips — measured at
       * 3.9 seconds — before a single tick turned blue. Every one of those
       * reads is independent of the others, and a chat batch shares ONE parent
       * between all of its writes.
       *
       * Order is still preserved where it is observable: paths are validated
       * in order first, and the permission decisions are taken in order after
       * the reads land, so the same batch is refused with the same message as
       * before. Only the waiting is gone.
       */
      for (const w of ops)
        if (!isDocPath(w.path)) throw new AccessError(400, "Batch writes need document paths.");

      const refs = ops.map((w) => refFromPath(db, w.path));

      const parentPaths = new Map();
      for (const w of ops) {
        const pp = parentPathOf(w.path);
        if (pp) parentPaths.set(pp.join("/"), pp);
      }
      const parents = new Map(
        await Promise.all(
          [...parentPaths].map(async ([key, pp]) => {
            const snap = await refFromPath(db, pp).get();
            return [key, snap.exists ? snap.data() : null];
          }),
        ),
      );

      const existing = await Promise.all(refs.map((ref) => ref.get()));

      const checked = [];
      for (let i = 0; i < ops.length; i += 1) {
        const w = ops[i];
        const pp = parentPathOf(w.path);
        const parent = pp ? parents.get(pp.join("/")) ?? null : null;
        if (!mayWrite(w.path, existing[i].exists ? existing[i].data() : null, caller, parent))
          throw new AccessError(403, `You do not have access to change ${w.path.join("/")}.`);
        checked.push({ ref: refs[i], w });
      }
      const batch = db.batch();
      for (const { ref, w } of checked) {
        if (w.kind === "set") batch.set(ref, decodeValue(w.data ?? {}), { merge: w.merge === true });
        else if (w.kind === "update") batch.update(ref, decodeValue(w.data ?? {}));
        else if (w.kind === "delete") batch.delete(ref);
        else throw new AccessError(400, `Unknown batch write "${w.kind}".`);
      }
      await batch.commit();
      return { ok: true, count: checked.length };
    }

    default:
      throw new AccessError(400, `Unknown operation "${String(op.op)}".`);
  }
}

module.exports = {
  ACCESS,
  AccessError,
  decodeValue,
  execute,
  mayRead,
  mayWrite,
  refFromPath,
};
