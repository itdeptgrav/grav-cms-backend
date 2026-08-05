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

/** The roles the document surface recognises. `null` means "removed". */
const ROLES = ["owner", "editor", "viewer"];

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

module.exports = router;
