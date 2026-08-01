/**
 * Live document collaboration — the Yjs half.
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
 * `y-socket.io` claims `/yjs|<room>` via a dynamic namespace. Room names here
 * are the document id, so `/yjs|<documentId>`.
 */

const { YSocketIO } = require("y-socket.io/dist/server");
const Y = require("yjs");
const { admin, db } = require("../config/firebaseAdmin");

const BODY_COLLECTION = "cowork_document_bodies";
const DOC_COLLECTION = "cowork_documents";

/** How long after the last keystroke the state is written. */
const SAVE_DEBOUNCE_MS = 3000;

const pendingSaves = new Map();

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
 * The document id this namespace is for. `/yjs|<documentId>`.
 *
 * Read from the NAMESPACE, never from anything the client sends alongside it.
 * A client-supplied id could name document A while the socket joins document
 * B's room, which would authorise the wrong document entirely.
 */
function documentIdOf(namespaceName) {
  const at = String(namespaceName || "").indexOf("|");
  return at === -1 ? null : String(namespaceName).slice(at + 1);
}

/**
 * Whether this Firebase user may open this document.
 *
 * Resolved through `cowork_employees`, because `memberIds` holds employee ids
 * (`GR0067`) and a Firebase token carries a uid. The two stores are joined by
 * that lookup and by nothing else — the same seam every other Cowork read uses.
 */
async function mayOpen(decoded, documentId) {
  if (!documentId) return null;
  const snap = await db.collection(DOC_COLLECTION).doc(documentId).get();
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

/** The stored state for a document, or null. */
async function loadState(documentId) {
  const snap = await db.collection(BODY_COLLECTION).doc(documentId).get();
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
 * `merge: true` and the HTML is left alone: this server does not render prose,
 * and overwriting `html` with nothing would empty the list preview and the
 * document itself for anybody reading it without a live session.
 */
async function saveState(documentId, ydoc) {
  const state = Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64");
  await db.collection(BODY_COLLECTION).doc(documentId).set(
    {
      ydocState: state,
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );
  await db
    .collection(DOC_COLLECTION)
    .doc(documentId)
    .update({ updatedAt: new Date().toISOString() })
    .catch(() => {
      /* The record may have been deleted mid-session. The body write above is
         what matters; failing here must not lose it. */
    });
}

function scheduleSave(documentId, ydoc) {
  const existing = pendingSaves.get(documentId);
  if (existing) clearTimeout(existing);
  pendingSaves.set(
    documentId,
    setTimeout(() => {
      pendingSaves.delete(documentId);
      saveState(documentId, ydoc).catch((e) =>
        console.error("[docs] save failed", documentId, e.message),
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
  /**
   * Authentication, as our OWN namespace middleware.
   *
   * NOT `YSocketIO`'s `authenticate` option: that callback is handed only the
   * handshake, and the handshake does not carry the namespace — so there is no
   * way from inside it to learn WHICH document is being joined. The first
   * version read `handshake.query.name`, which is never set, so every
   * connection was refused and the editor silently fell back to single-writer.
   *
   * Registered before `initialize()` so it runs first, and it takes the whole
   * socket — `socket.nsp.name` is the room, from the server's own routing
   * rather than from anything the client claims.
   */
  io.of(/^\/yjs\|.*$/).use(async (socket, next) => {
    try {
      const documentId = documentIdOf(socket.nsp && socket.nsp.name);
      if (!documentId) return next(new Error("Unauthorized: no document"));

      const decoded = await identify(socket.handshake);
      if (!decoded) return next(new Error("Unauthorized: sign in again"));

      const allowed = await mayOpen(decoded, documentId);
      if (!allowed) return next(new Error("Unauthorized: not in this document"));

      /* Carried so the rest of the session knows who this is without a second
         directory lookup per event. */
      socket.data.employeeId = allowed.employeeId;
      socket.data.documentId = documentId;
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
        socket.use((packet, allow) => {
          const event = Array.isArray(packet) ? String(packet[0] || "") : "";
          if (event === "sync-update" || event === "sync-step-2") {
            return allow(new Error("You have view access to this document."));
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

  const ysocketio = new YSocketIO(io, { gcEnabled: true });

  ysocketio.initialize();

  /* Seed a freshly-opened room from Firestore. Without this the first client to
     connect after a restart starts from an EMPTY document and its first edit
     would propagate that emptiness as the new truth. */
  ysocketio.on("document-loaded", async (doc) => {
    const documentId = doc.name;
    try {
      const state = await loadState(documentId);
      if (state && state.length) Y.applyUpdate(doc, new Uint8Array(state));
      console.log(`[docs] room ready ${documentId} (${state ? "restored" : "new"})`);
    } catch (e) {
      console.error("[docs] load failed", documentId, e.message);
    }
  });

  ysocketio.on("document-update", (doc) => scheduleSave(doc.name, doc));

  /* The last person left. Saved immediately rather than on the debounce: the
     in-memory document is about to be discarded, and a pending timer would be
     racing its destruction. */
  ysocketio.on("all-document-connections-closed", async (doc) => {
    const documentId = doc.name;
    const pending = pendingSaves.get(documentId);
    if (pending) {
      clearTimeout(pending);
      pendingSaves.delete(documentId);
    }
    try {
      await saveState(documentId, doc);
      console.log(`[docs] room closed and saved ${documentId}`);
    } catch (e) {
      console.error("[docs] final save failed", documentId, e.message);
    }
  });

  console.log("✅ Document collaboration namespace ready (/yjs|<documentId>)");
  return ysocketio;
}

module.exports = { initDocumentCollaboration };
