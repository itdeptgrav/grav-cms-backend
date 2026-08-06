/**
 * Live collaboration — the Yjs half. Documents, sheets AND mindmaps.
 *
 * ## Why this exists rather than a Google Docs integration
 *
 * The Google Docs API is REST — `documents.get` and `documents.batchUpdate`. It
 * has no realtime channel, no presence and no operational transform; the API
 * that did (Google's Realtime API) was shut down in 2019. So concurrent editing
 * has to be solved here. Yjs is a CRDT: two people editing the same paragraph
 * converge without a server deciding who wins, which is what makes this
 * survivable over a flaky connection.
 *
 * ## What this server does, and deliberately does not
 *
 * `y-socket.io` relays updates between clients and holds the authoritative
 * document in memory while anybody is connected. This module adds the only two
 * things it does not do on its own:
 *
 *  1. **Authentication.** A document room is joinable by anybody who guesses
 *     its id otherwise. Every connection is checked against the Firebase ID
 *     token and against the document's own `memberIds`.
 *  2. **Persistence.** The in-memory doc dies with the last connection, so the
 *     state is written to Firestore — debounced while editing, and once more
 *     when the room empties.
 *
 * It does NOT render HTML. The Yjs state is the authority; the browser projects
 * it to HTML and writes that alongside, because the list, search and the
 * eventual Drive export all read prose rather than a CRDT.
 *
 * ## The namespace
 *
 * `y-socket.io` claims `/yjs|<room>` via a dynamic namespace, so a room name is
 * `/yjs|<room>`. A room names a RECORD, and which KIND of record is part of the
 * name — see `KINDS` below.
 */

const { YSocketIO } = require("y-socket.io/dist/server");
const Y = require("yjs");
const { admin, db } = require("../config/firebaseAdmin");

/**
 * What can be collaborated on, and where each kind lives.
 *
 * ## Why the kind is in the room name
 *
 * The room used to be the document id alone, because documents were the only
 * thing that collaborated and there was nothing else it could have meant.
 * Mindmaps are a separate collection with their own membership, so a bare id is
 * now ambiguous — and the ambiguity is a security problem rather than an
 * inconvenience: `mayOpen` decides who may join by reading the record, and
 * Firestore ids are unique per collection rather than across them. A mindmap id
 * that happened to match a document id would be authorised against THAT
 * document's member list.
 *
 * **Documents keep the bare id, deliberately.** Every document room open right
 * now is named that way; renaming them would put a client on the old name and a
 * client on the new one into two different rooms holding two divergent copies of
 * one document, with nothing to show for it because both halves would work
 * perfectly on their own. The prefix is only ever added to new kinds.
 *
 * Mirrors `lib/rules/workspace/collabRoom.ts` in the Cowork client. The two have
 * to agree on these strings or a browser opens a room this server will not
 * authorise.
 */
const KINDS = {
  document: {
    prefix: "",
    records: "cowork_documents",
    bodies: "cowork_document_bodies",
  },
  mindmap: {
    prefix: "mindmap:",
    records: "cowork_mindmaps",
    bodies: "cowork_mindmap_bodies",
  },
};

/** How long after the last keystroke the state is written. */
const SAVE_DEBOUNCE_MS = 3000;

const pendingSaves = new Map();

/**
 * Version checkpoints — a snapshot of `ydocState` a person can restore to.
 *
 * ## Why this piggybacks on `saveState` rather than running on its own timer
 *
 * `saveState` already computes `Y.encodeStateAsUpdate(ydoc)` on every debounced
 * save, which is the one expensive part of a checkpoint (walking the whole
 * CRDT). Doing it again on a separate interval would double that cost for no
 * reason; gating an EXTRA write behind the same call this file makes anyway is
 * free by comparison — one more Firestore `set`, only every so often.
 *
 * Documents and sheets share `cowork_document_bodies` (see `KINDS.document`
 * above), so both get checkpoints for free; mindmaps do not, since their body
 * collection is separate and nothing here writes into it.
 */
const CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Last checkpoint time per room, in memory only — matching `pendingSaves`
 * above. A process restart loses the clock and the next save simply
 * checkpoints again immediately, which is the safe direction to be wrong in:
 * the alternative (persisting the clock) would need its own store for a fact
 * that only ever gates a "would be nice" snapshot, never correctness.
 */
const lastCheckpointAt = new Map();

/**
 * Who is connecting, or null.
 *
 * Reads the token from `auth.token` — the handshake's own field — rather than
 * from a cookie, because a WebSocket upgrade does not reliably carry cookies
 * cross-origin and the browser cannot set headers on it.
 */
async function identify(handshake) {
  const token =
    (handshake.auth && handshake.auth.token) ||
    (handshake.query && handshake.query.token);
  if (!token) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(String(token));
    return decoded && decoded.uid ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * The room name out of `/yjs|<room>`.
 *
 * Read from the NAMESPACE, never from anything the client sends alongside it. A
 * client-supplied id could name record A while the socket joins record B's room,
 * which would authorise the wrong record entirely.
 */
function roomNameOf(namespaceName) {
  const at = String(namespaceName || "").indexOf("|");
  return at === -1 ? null : String(namespaceName).slice(at + 1);
}

/**
 * What a room refers to, or null if it names nothing.
 *
 * Null for an empty id rather than a record with an empty id: `mindmap:` is a
 * malformed room, and `{kind: "mindmap", id: ""}` would send Firestore to look
 * up the empty document id.
 *
 * Mirrors `parseRoom` in `lib/rules/workspace/collabRoom.ts`.
 */
function parseRoom(room) {
  const name = String(room || "");
  for (const [kind, cfg] of Object.entries(KINDS)) {
    if (!cfg.prefix) continue;
    if (name.startsWith(cfg.prefix)) {
      const id = name.slice(cfg.prefix.length);
      return id ? { kind, id } : null;
    }
  }
  return name ? { kind: "document", id: name } : null;
}

/**
 * Whether this Firebase user may open this record.
 *
 * Resolved through `cowork_employees`, because `memberIds` holds employee ids
 * (`GR0067`) and a Firebase token carries a uid. The two stores are joined by
 * that lookup and by nothing else — the same seam every other Cowork read uses.
 */
async function mayOpen(decoded, room) {
  if (!room) return null;
  const cfg = KINDS[room.kind];
  if (!cfg) return null;
  const snap = await db.collection(cfg.records).doc(room.id).get();
  if (!snap.exists) return null;
  const doc = snap.data();
  if (doc.deletedAt) return null;

  const employeeId = await employeeIdOf(decoded);
  if (!employeeId) return null;
  const role = roleOf(doc, employeeId);
  return role ? { employeeId, doc, role } : null;
}

/**
 * This person's role, tolerating the pre-roles shape.
 *
 * Documents written before roles carry only `memberIds`. Those people were
 * editors when the document was written, and silently demoting them to viewer
 * on upgrade would take away access nobody chose to take away. Mirrors
 * `readMembers` in `lib/rules/documents/access.ts` — the two must agree, or the
 * screen and the socket disagree about who may type.
 */
function roleOf(doc, employeeId) {
  if (Array.isArray(doc.members) && doc.members.length) {
    const found = doc.members.find((m) => m && m.employeeId === employeeId);
    return found ? found.role || "viewer" : null;
  }
  const ids = Array.isArray(doc.memberIds) ? doc.memberIds : [];
  if (!ids.includes(employeeId)) return null;
  return doc.createdById === employeeId ? "owner" : "editor";
}

const MAY_WRITE = new Set(["owner", "editor"]);

async function employeeIdOf(decoded) {
  /* The token's own claim first — set by the engine when it mints sessions —
     then the directory, so a token issued before the claim existed still
     resolves rather than being refused. */
  if (decoded.employeeId) return String(decoded.employeeId);
  const byUid = await db
    .collection("cowork_employees")
    .where("authUid", "==", decoded.uid)
    .limit(1)
    .get();
  if (!byUid.empty) return byUid.docs[0].id;
  if (decoded.email) {
    const byEmail = await db
      .collection("cowork_employees")
      .where("email", "==", decoded.email)
      .limit(1)
      .get();
    if (!byEmail.empty) return byEmail.docs[0].id;
  }
  return null;
}

/** The stored state for a record, or null. */
async function loadState(room) {
  const cfg = KINDS[room.kind];
  if (!cfg) return null;
  const snap = await db.collection(cfg.bodies).doc(room.id).get();
  if (!snap.exists) return null;
  const raw = snap.data();
  if (typeof raw.ydocState !== "string" || !raw.ydocState) return null;
  try {
    return Buffer.from(raw.ydocState, "base64");
  } catch {
    return null;
  }
}

/**
 * Write the state.
 *
 * `merge: true`, and the PROJECTION beside it is left alone. This server does
 * not render prose and does not lay out a card tree; the browser writes those.
 * Overwriting a document's `html` with nothing would empty the list preview and
 * the document itself for anybody reading it without a live session, and
 * overwriting a mindmap's `nodes` would leave a map that draws nothing — the
 * REST read (`GET /mindmaps/:id`) returns `nodes`, not the CRDT.
 */
async function saveState(room, ydoc, roomName) {
  const cfg = KINDS[room.kind];
  if (!cfg) return;
  const state = Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64");
  await db.collection(cfg.bodies).doc(room.id).set(
    {
      ydocState: state,
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );
  await db
    .collection(cfg.records)
    .doc(room.id)
    .update({ updatedAt: new Date().toISOString() })
    .catch(() => {
      /* The record may have been deleted mid-session. The body write above is
         what matters; failing here must not lose it. */
    });

  await maybeCheckpoint(room, roomName ?? room.id, state);
}

/**
 * Write a version checkpoint, if enough time has passed since the last one
 * for THIS room.
 *
 * Documents only (`room.kind === "document"`, which — see `KINDS` above —
 * also covers sheets, sharing the same body collection). Mindmaps have no
 * version history surface and no `versions` subcollection to write into.
 *
 * Best-effort: a failed checkpoint must not be treated as a failed save. The
 * `ydocState` write above already landed; a missed snapshot is a smaller loss
 * than the caller believing the whole save failed and retrying a keystroke
 * that was, in fact, already persisted.
 */
async function maybeCheckpoint(room, roomName, ydocStateBase64) {
  if (room.kind !== "document") return;
  const now = Date.now();
  const last = lastCheckpointAt.get(roomName) ?? 0;
  if (now - last < CHECKPOINT_INTERVAL_MS) return;
  lastCheckpointAt.set(roomName, now);
  try {
    const cfg = KINDS[room.kind];
    await db
      .collection(cfg.bodies)
      .doc(room.id)
      .collection("versions")
      .add({
        ydocState: ydocStateBase64,
        createdAt: new Date().toISOString(),
        /* Nobody in particular — this is the shared room's own clock ticking,
           not one person's save. The manual "Save version now" route (see
           `coworkDocs.routes.js`) stamps the person who asked for it instead. */
        authorId: null,
        authorName: "Autosaved",
        label: null,
      });
  } catch (e) {
    console.error("[collab] checkpoint failed", roomName, e.message);
  }
}

/**
 * Debounce a save, keyed by the FULL room name rather than the bare id.
 *
 * A document and a mindmap can hold the same id — Firestore ids are unique per
 * collection, not across them — and keying on the id alone would let one room's
 * pending save cancel the other's.
 */
function scheduleSave(roomName, room, ydoc) {
  const existing = pendingSaves.get(roomName);
  if (existing) clearTimeout(existing);
  pendingSaves.set(
    roomName,
    setTimeout(() => {
      pendingSaves.delete(roomName);
      saveState(room, ydoc, roomName).catch((e) =>
        console.error("[collab] save failed", roomName, e.message),
      );
    }, SAVE_DEBOUNCE_MS),
  );
}

/**
 * Attach collaboration to the existing Socket.IO server.
 *
 * Called once from `server.js`, after `io` is created. Adds a dynamic namespace
 * and touches neither of the two existing `io.on("connection")` handlers.
 */
function initDocumentCollaboration(io) {
  /* YSocketIO owns the `/yjs|<room>` namespace and all of the Yjs sync. Create
     it FIRST, then hang our auth off ITS namespace (`ysocketio.nsp`). */
  const ysocketio = new YSocketIO(io, { gcEnabled: true });
  ysocketio.initialize();

  /**
   * Authentication, as middleware on YSocketIO's OWN namespace.
   *
   * NOT `YSocketIO`'s `authenticate` option: that callback is handed only the
   * handshake, and the handshake does not carry the namespace — so there is no
   * way from inside it to learn WHICH document is being joined. This takes the
   * whole socket — `socket.nsp.name` is the room, from the server's own routing
   * rather than from anything the client claims.
   *
   * **Why `ysocketio.nsp.use`, and NOT a second `io.of(/^\/yjs\|.*$/)`.** The
   * previous version registered auth on a separately-created parent namespace
   * with the same pattern. Socket.IO does not dedupe parent namespaces by
   * pattern — every `io.of(regex)` is a distinct one — and a connecting client
   * is routed to the FIRST parent namespace whose pattern matches (`Server.
   * _checkNamespace`, in insertion order). Registering auth before
   * `initialize()` therefore placed a namespace carrying the auth middleware but
   * NO sync handler ahead of YSocketIO's: every `/yjs|*` socket connected,
   * passed auth and reported itself "live" — then never synced, because the
   * handler that relays updates and awareness lived on the shadowed second
   * namespace and never saw the connection. Attaching to `ysocketio.nsp` puts
   * auth and sync on the one namespace the client actually reaches.
   *
   * It runs before any document bytes leave the server: state is emitted from
   * the namespace's `connection` handler (`startSynchronization`), which fires
   * only once every middleware — this one included — has called `next()`, so a
   * refused socket never receives the document.
   */
  ysocketio.nsp.use(async (socket, next) => {
    try {
      const roomName = roomNameOf(socket.nsp && socket.nsp.name);
      const room = parseRoom(roomName);
      if (!room) return next(new Error("Unauthorized: no document"));

      const decoded = await identify(socket.handshake);
      if (!decoded) return next(new Error("Unauthorized: sign in again"));

      const allowed = await mayOpen(decoded, room);
      if (!allowed)
        return next(
          new Error(
            room.kind === "mindmap"
              ? "Unauthorized: not in this mindmap"
              : "Unauthorized: not in this document",
          ),
        );

      /* Carried so the rest of the session knows who this is without a second
         directory lookup per event. */
      socket.data.employeeId = allowed.employeeId;
      socket.data.room = room;
      socket.data.documentId = room.id;
      socket.data.role = allowed.role;

      /**
       * **A viewer's edits are refused here, not hidden in the UI.**
       *
       * Disabling the toolbar is courtesy; this is the permission. Yjs updates
       * arrive as `sync-update` / `awareness-update` events, and a client that
       * simply sends them anyway would otherwise mutate the shared document.
       * Awareness is left alone deliberately — a viewer's CARET should still be
       * visible to the people writing, which is what makes "somebody is reading
       * over your shoulder" legible rather than invisible.
       */
      if (!MAY_WRITE.has(allowed.role)) {
        const refusal =
          room.kind === "mindmap"
            ? /* The engine's wording for the same refusal, matching
                 `editRefusal` in `lib/rules/mindmap/access.ts` and the REST
                 route — one rule must not be described three ways. */
              "You can view this mindmap but not change it."
            : "You have view access to this document.";
        socket.use((packet, allow) => {
          const event = Array.isArray(packet) ? String(packet[0] || "") : "";
          if (event === "sync-update" || event === "sync-step-2") {
            return allow(new Error(refusal));
          }
          return allow();
        });
      }

      return next();
    } catch (e) {
      console.error("[docs] auth error", e.message);
      return next(new Error("Unauthorized"));
    }
  });

  /* Seed a freshly-opened room from Firestore. Without this the first client to
     connect after a restart starts from an EMPTY document and its first edit
     would propagate that emptiness as the new truth. */
  ysocketio.on("document-loaded", async (doc) => {
    const roomName = doc.name;
    const room = parseRoom(roomName);
    if (!room) return;
    try {
      const state = await loadState(room);
      if (state && state.length) Y.applyUpdate(doc, new Uint8Array(state));
      console.log(`[collab] room ready ${roomName} (${state ? "restored" : "new"})`);
    } catch (e) {
      console.error("[collab] load failed", roomName, e.message);
    }
  });

  ysocketio.on("document-update", (doc) => {
    const room = parseRoom(doc.name);
    if (room) scheduleSave(doc.name, room, doc);
  });

  /* The last person left. Saved immediately rather than on the debounce: the
     in-memory document is about to be discarded, and a pending timer would be
     racing its destruction. */
  ysocketio.on("all-document-connections-closed", async (doc) => {
    const roomName = doc.name;
    const room = parseRoom(roomName);
    if (!room) return;
    const pending = pendingSaves.get(roomName);
    if (pending) {
      clearTimeout(pending);
      pendingSaves.delete(roomName);
    }
    try {
      await saveState(room, doc, roomName);
      console.log(`[collab] room closed and saved ${roomName}`);
    } catch (e) {
      console.error("[collab] final save failed", roomName, e.message);
    }
  });

  console.log(
    "✅ Collaboration namespace ready (/yjs|<documentId> and /yjs|mindmap:<id>)",
  );
  return ysocketio;
}

/* `parseRoom` and `KINDS` are exported for the parity check: they have to agree
   with `lib/rules/workspace/collabRoom.ts` in the Cowork client, and a mismatch
   is silent — the browser opens a room this server declines to authorise. */
module.exports = { initDocumentCollaboration, parseRoom, KINDS };
