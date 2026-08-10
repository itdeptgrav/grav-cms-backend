/**
 * GRAV-CMS-BACKEND/routes/task_routes/coworkDocs.routes.js
 *
 * Notifications for the Cowork document surface (`/workspace` — docs, sheets).
 *
 * ## Why this file exists at all
 *
 * `cowork_documents` is written browser-to-Firestore, deliberately: there is no
 * document engine here and adding one would invert the write path the whole
 * migration is built on. That decision is fine for the document. It is NOT fine
 * for the notification, and this is the one place the two part company.
 *
 * A notification is a row in `cowork_notifications` addressed to somebody else.
 * If the browser could write one, anybody could put any message in anybody's
 * inbox, from any account — a phishing surface with our own branding on it. So
 * the membership change stays a client write and the announcement of it comes
 * through here, where the Admin SDK can check the claim before anyone is told
 * anything.
 *
 * ## What is actually verified
 *
 * The caller must be an OWNER of the document, read from the stored record —
 * not from anything the request said. That mirrors `memberChangeRefusal` in the
 * frontend's `rules/documents/access.ts`, which is the rule that governs who
 * may change membership in the first place. The client having already written
 * the change does not make it true; this re-derives it.
 *
 * A removal is announced by an owner about somebody who is, by then, no longer
 * a member — so membership of the TARGET is deliberately not required.
 */

const express = require("express");
const admin = require("firebase-admin");
const { db } = require("../../config/firebaseAdmin");
const {
  verifyCoworkToken,
  verifyEmployeeToken,
} = require("../../Middlewear/coworkAuth");
const { v4: uuidv4 } = require("uuid");
const socket = require("../../config/socketInstance");

const router = express.Router();

const DOCUMENTS = "cowork_documents";
const DOCUMENT_BODIES = "cowork_document_bodies";
const VERSIONS = "versions";

/** The roles the document surface recognises. `null` means "removed". */
const ROLES = ["owner", "editor", "viewer"];

/**
 * This person's role in the document, tolerating the pre-roles shape.
 *
 * Mirrors `roleOf` in `services/documentCollab.service.js` and `readMembers`
 * in the frontend's `lib/rules/documents/access.ts` — all three have to agree,
 * or somebody refused here could still write through the collaboration socket,
 * or the reverse.
 */
function _roleOf(doc, employeeId) {
  if (Array.isArray(doc.members) && doc.members.length) {
    const found = doc.members.find((m) => m && m.employeeId === employeeId);
    return found ? found.role || "viewer" : null;
  }
  const ids = Array.isArray(doc.memberIds) ? doc.memberIds : [];
  if (!ids.includes(employeeId)) return null;
  return doc.createdById === employeeId ? "owner" : "editor";
}

const MAY_WRITE = new Set(["owner", "editor"]);

/**
 * Load a document and check membership (and optionally write access) in one
 * place, so every version route asks the same question the same way.
 *
 * A document that does not exist and one the caller is not a member of answer
 * identically — `{ status: 404 }` — for the same reason `getDocument` on the
 * frontend repository does: a distinguishable refusal would confirm a real
 * document id to somebody with no access to it.
 */
async function _loadDocumentForMember(documentId, employeeId, { requireWrite = false } = {}) {
  const snap = await db.collection(DOCUMENTS).doc(String(documentId)).get();
  if (!snap.exists) return { error: { status: 404, message: "Document not found." } };
  const doc = snap.data();
  if (doc.deletedAt) return { error: { status: 404, message: "Document not found." } };
  const role = _roleOf(doc, employeeId);
  if (!role) return { error: { status: 404, message: "Document not found." } };
  if (requireWrite && !MAY_WRITE.has(role)) {
    return {
      error: {
        status: 403,
        message: "You have view access to this document. Ask an owner for editing access.",
      },
    };
  }
  return { doc, role };
}

/**
 * Write the notification, emit it, push it.
 *
 * A local copy of the same three steps `_notify` takes in `taskForward.js`,
 * for the same reason that helper is local there: it is four lines of Firestore
 * and the alternative is importing a route file from a route file.
 */
async function _notify({ recipientIds, type, title, body, data, senderId, senderName }) {
  if (!recipientIds?.length) return;
  try {
    const batch = db.batch();
    recipientIds.forEach((id) => {
      batch.set(db.collection("cowork_notifications").doc(uuidv4()), {
        recipientEmployeeId: id,
        type,
        title,
        body,
        data: data || {},
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
    socket.emitToMany(recipientIds, "new_notification", { type, title, body, data });
    setImmediate(() => {
      try {
        const { sendPushToEmployees } = require("../../services/fcmPush.service");
        sendPushToEmployees(recipientIds, title, body, { type, ...(data || {}) }).catch(() => {});
      } catch (_) {}
    });
  } catch (e) {
    console.error("[coworkDocs _notify]", e.message);
  }
}

function _ownerIds(doc) {
  return (doc.members || [])
    .filter((m) => m && m.role === "owner" && m.employeeId)
    .map((m) => m.employeeId);
}

// ── MEMBERSHIP CHANGED ───────────────────────────────────────────────────────
// POST /cowork/documents/:documentId/notify-member
// Body: { employeeId, role }   role null => removed
router.post(
  "/documents/:documentId/notify-member",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const { documentId } = req.params;
      const { employeeId: targetId, role } = req.body || {};
      const { employeeId: actor, name: actorName } = req.coworkUser;

      if (!targetId) return res.status(400).json({ error: "employeeId is required." });
      if (role !== null && role !== undefined && !ROLES.includes(role)) {
        return res.status(400).json({ error: `Unknown role. Expected one of: ${ROLES.join(", ")}, or null.` });
      }
      // Telling yourself is never useful and is the commonest accidental call:
      // the owner making the change already knows they made it.
      if (targetId === actor) return res.json({ success: true, notified: false });

      const snap = await db.collection(DOCUMENTS).doc(String(documentId)).get();
      // Not an owner and not existing answer identically. A distinguishable
      // 404 would confirm a document id to somebody with no access to it.
      if (!snap.exists) return res.status(404).json({ error: "Document not found." });
      const doc = snap.data();
      if (!_ownerIds(doc).includes(actor)) {
        return res.status(404).json({ error: "Document not found." });
      }

      const kind = doc.kind === "sheet" ? "sheet" : "document";
      const title = doc.title || `Untitled ${kind}`;

      const copy = role
        ? {
            type: "document_shared",
            heading: role === "owner" ? "📄 You now own a document" : "📄 Shared with you",
            body:
              role === "viewer"
                ? `${actorName} shared the ${kind} "${title}" with you. You can read it, and your edits are turned off.`
                : role === "owner"
                  ? `${actorName} made you an owner of the ${kind} "${title}". You can now share it and change who else may edit.`
                  : `${actorName} shared the ${kind} "${title}" with you. You can edit it.`,
          }
        : {
            type: "document_access_removed",
            heading: "📄 Access removed",
            body: `${actorName} removed your access to the ${kind} "${title}".`,
          };

      await _notify({
        recipientIds: [targetId],
        type: copy.type,
        title: copy.heading,
        body: copy.body,
        data: { documentId: String(documentId), role: role ?? null, kind },
        senderId: actor,
        senderName: actorName,
      });

      res.json({ success: true, notified: true });
    } catch (e) {
      console.error("Error in /documents/:documentId/notify-member:", e);
      res.status(500).json({ error: e.message });
    }
  },
);

// ── VERSION HISTORY ──────────────────────────────────────────────────────────
//
// A checkpoint is a snapshot of `cowork_document_bodies/{id}.ydocState` — the
// same base64 Yjs blob `documentCollab.service.js` already computes on every
// debounced save (see `maybeCheckpoint` there for the automatic side of this;
// these three routes are the manual side, plus reading and restoring).

// POST /cowork/documents/:documentId/versions — save a checkpoint now.
// Body: { label? }
router.post(
  "/documents/:documentId/versions",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const { documentId } = req.params;
      const { employeeId: actor, name: actorName } = req.coworkUser;
      const rawLabel = req.body && typeof req.body.label === "string" ? req.body.label.trim() : "";
      const label = rawLabel ? rawLabel.slice(0, 200) : null;

      const gate = await _loadDocumentForMember(documentId, actor, { requireWrite: true });
      if (gate.error) return res.status(gate.error.status).json({ error: gate.error.message });

      /* Copies whatever is currently stored rather than taking Yjs bytes from
         the request — the client has no business uploading CRDT state of its
         own, and the debounced live save already keeps this field fresh. */
      const bodySnap = await db.collection(DOCUMENT_BODIES).doc(String(documentId)).get();
      const ydocState = bodySnap.exists ? bodySnap.data().ydocState : null;
      if (typeof ydocState !== "string" || !ydocState) {
        return res.status(400).json({ error: "This document has no saved content yet to check-point." });
      }

      const ref = db.collection(DOCUMENT_BODIES).doc(String(documentId)).collection(VERSIONS).doc();
      const createdAt = new Date().toISOString();
      const authorName = actorName || "Someone";
      await ref.set({ ydocState, createdAt, authorId: actor, authorName, label });

      res.json({ version: { id: ref.id, createdAt, authorId: actor, authorName, label } });
    } catch (e) {
      console.error("Error in POST /documents/:documentId/versions:", e);
      res.status(500).json({ error: e.message });
    }
  },
);

// GET /cowork/documents/:documentId/versions — list, newest first.
// Any member may look, including a viewer — reading history is not editing.
router.get(
  "/documents/:documentId/versions",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const { documentId } = req.params;
      const { employeeId: actor } = req.coworkUser;

      const gate = await _loadDocumentForMember(documentId, actor);
      if (gate.error) return res.status(gate.error.status).json({ error: gate.error.message });

      const snap = await db
        .collection(DOCUMENT_BODIES)
        .doc(String(documentId))
        .collection(VERSIONS)
        .orderBy("createdAt", "desc")
        .limit(200)
        .get();

      const versions = snap.docs.map((d) => {
        const v = d.data() || {};
        return {
          id: d.id,
          createdAt: typeof v.createdAt === "string" ? v.createdAt : null,
          authorId: typeof v.authorId === "string" ? v.authorId : null,
          authorName: typeof v.authorName === "string" ? v.authorName : "Someone",
          label: typeof v.label === "string" ? v.label : null,
        };
      });

      res.json({ versions });
    } catch (e) {
      console.error("Error in GET /documents/:documentId/versions:", e);
      res.status(500).json({ error: e.message });
    }
  },
);

// POST /cowork/documents/:documentId/versions/:versionId/restore
//
// Replaces the document, outright — not a merge. Every connected client's
// live Yjs doc picks this up the normal way it picks up any other change to
// `ydocState`: on its next fresh sync (a room already live in memory keeps
// running on what it has until everybody leaves and it reloads from
// Firestore — the same story any other out-of-band write to `ydocState`
// would have, and not something a REST route can reach into a running
// `y-socket.io` room to force).
router.post(
  "/documents/:documentId/versions/:versionId/restore",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const { documentId, versionId } = req.params;
      const { employeeId: actor } = req.coworkUser;

      const gate = await _loadDocumentForMember(documentId, actor, { requireWrite: true });
      if (gate.error) return res.status(gate.error.status).json({ error: gate.error.message });

      const versionSnap = await db
        .collection(DOCUMENT_BODIES)
        .doc(String(documentId))
        .collection(VERSIONS)
        .doc(String(versionId))
        .get();
      if (!versionSnap.exists) return res.status(404).json({ error: "That version no longer exists." });
      const version = versionSnap.data() || {};
      if (typeof version.ydocState !== "string" || !version.ydocState) {
        return res.status(400).json({ error: "That version has no content to restore." });
      }

      const now = new Date().toISOString();
      await db.collection(DOCUMENT_BODIES).doc(String(documentId)).set(
        { ydocState: version.ydocState, updatedAt: now },
        { merge: true },
      );
      await db
        .collection(DOCUMENTS)
        .doc(String(documentId))
        .update({ updatedAt: now })
        .catch(() => {
          /* The record may have been deleted mid-request. The body write above
             is what matters; failing here must not lose it. */
        });

      res.json({ success: true, restoredAt: now });
    } catch (e) {
      console.error("Error in POST /documents/:documentId/versions/:versionId/restore:", e);
      res.status(500).json({ error: e.message });
    }
  },
);

module.exports = router;
