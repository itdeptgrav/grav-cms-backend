/**
 * GRAV-CMS-BACKEND/routes/task_routes/coworkEvents.routes.js
 *
 * One endpoint: "this happened, tell whoever should know."
 *
 * ## The problem it exists for
 *
 * A large part of the new Cowork writes browser-to-Firestore — time-budget
 * negotiation, deadline-extension records, priority, group membership, document
 * renames. That is the old app's own pattern and it is not being changed here.
 * But the old app pairs each of those writes with a call to an endpoint that
 * announces it, and the new one did not, so a whole class of event happened in
 * total silence: a manager was never told an extension was waiting on them, an
 * employee was never told their answer had come, somebody added to a group
 * found out by noticing it in a list.
 *
 * ## Why the client cannot simply write the notification
 *
 * `cowork_notifications` is one collection addressed by recipient. A browser
 * able to write it could put any text in anybody's inbox from any account —
 * a phishing surface carrying our own branding.
 *
 * So the client sends only **what happened and to which record**. It never
 * sends a title, a body, or a recipient list. This file reads the record from
 * Firestore, checks the caller's relationship to it, works out who is affected
 * and composes the words. The worst a caller can do by lying is announce a real
 * event, about a record they genuinely have standing in, to the people who were
 * genuinely going to be told about it.
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

async function _notify({ recipientIds, type, title, body, data, senderId, senderName }) {
  const ids = [...new Set((recipientIds || []).filter(Boolean))];
  if (!ids.length) return 0;
  const batch = db.batch();
  ids.forEach((id) => {
    batch.set(db.collection("cowork_notifications").doc(uuidv4()), {
      recipientEmployeeId: id,
      type, title, body,
      data: data || {},
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
  socket.emitToMany(ids, "new_notification", { type, title, body, data });
  setImmediate(() => {
    try {
      const { sendPushToEmployees } = require("../../services/fcmPush.service");
      sendPushToEmployees(ids, title, body, { type, ...(data || {}) }).catch(() => { });
    } catch (_) { }
  });
  return ids.length;
}

const fmtSecs = (s) => {
  s = Math.max(0, Math.round(Number(s) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
};

/* ── Subject loaders, each returning { record } or { error } ──────────────── */

async function loadTask(taskId, actor) {
  if (!taskId) return { error: "taskId is required for this event." };
  const snap = await db.collection("cowork_tasks").doc(String(taskId)).get();
  if (!snap.exists) return { error: "Task not found." };
  const t = snap.data();
  const involved = [
    ...(t.assigneeIds || []),
    t.pendingAssigneeId,
    t.assignedBy,
  ].filter(Boolean);
  /* Standing, not permission: the caller has to be part of this task for its
     events to be theirs to announce. Anything finer is the engine's job on the
     route that performs the action, not this one, which performs none. */
  if (!involved.includes(actor)) return { error: "Task not found." };
  return { record: t };
}

async function loadGroup(groupId, actor) {
  if (!groupId) return { error: "groupId is required for this event." };
  const snap = await db.collection("cowork_groups").doc(String(groupId)).get();
  if (!snap.exists) return { error: "Group not found." };
  const g = snap.data();
  if (!(g.memberIds || []).includes(actor) && g.createdBy !== actor) {
    return { error: "Group not found." };
  }
  return { record: g };
}

async function loadDocument(documentId, actor) {
  if (!documentId) return { error: "documentId is required for this event." };
  const snap = await db.collection("cowork_documents").doc(String(documentId)).get();
  if (!snap.exists) return { error: "Document not found." };
  const d = snap.data();
  const owners = (d.members || []).filter((m) => m && m.role === "owner").map((m) => m.employeeId);
  if (!owners.includes(actor)) return { error: "Document not found." };
  return { record: d };
}

/* ── The events ───────────────────────────────────────────────────────────── */
//
// Each returns { recipientIds, type, title, body, data }. `actor` is the
// verified caller; `p` is the request body, used ONLY for ids and figures that
// the record cannot supply (how many seconds were asked for, which member was
// added). Never for words.

const EVENTS = {
  budget_extension_requested: {
    subject: "task",
    build: (t, p, actor, name) => ({
      recipientIds: [t.assignedBy],
      type: "budget_extension_requested",
      title: "⏳ More time requested",
      body: `${name} asked for ${fmtSecs(p.seconds)} more on "${t.title}".${p.reason ? ` Reason: ${p.reason}` : ""} It is waiting on your decision.`,
      data: { taskId: p.taskId, seconds: Number(p.seconds) || 0 },
    }),
  },
  budget_extension_decided: {
    subject: "task",
    build: (t, p, actor, name) => ({
      recipientIds: (t.assigneeIds || []),
      type: "budget_extension_decided",
      title: p.approved ? "✅ More time granted" : "❌ More time refused",
      body: p.approved
        ? `${name} granted ${fmtSecs(p.seconds)} more on "${t.title}".`
        : `${name} refused more time on "${t.title}".${p.reason ? ` Reason: ${p.reason}` : ""}`,
      data: { taskId: p.taskId, approved: !!p.approved },
    }),
  },
  deadline_extension_requested: {
    subject: "task",
    build: (t, p, actor, name) => ({
      recipientIds: [t.assignedBy],
      type: "deadline_extension_requested",
      title: "⏳ Deadline extension requested",
      body: `${name} asked to extend "${t.title}" by ${fmtSecs(p.seconds)}.${p.reason ? ` Reason: ${p.reason}` : ""} It is waiting on your decision.`,
      data: { taskId: p.taskId, seconds: Number(p.seconds) || 0 },
    }),
  },
  deadline_extension_decided: {
    subject: "task",
    build: (t, p, actor, name) => ({
      recipientIds: (t.assigneeIds || []),
      type: "deadline_extension_decided",
      title: p.approved ? "✅ Deadline extended" : "❌ Extension refused",
      body: p.approved
        ? `${name} extended "${t.title}" by ${fmtSecs(p.seconds)}.`
        : `${name} refused the extension on "${t.title}".${p.reason ? ` Reason: ${p.reason}` : ""}`,
      data: { taskId: p.taskId, approved: !!p.approved },
    }),
  },
  task_priority_changed: {
    subject: "task",
    build: (t, p, actor, name) => ({
      /* The person whose queue moved — never the manager who moved it. */
      recipientIds: (t.assigneeIds || []).filter((id) => id !== actor),
      type: "task_priority_changed",
      title: "🔀 Your priority changed",
      body: `${name} set "${t.title}" to P${p.rank} in your queue.${p.reason ? ` Reason: ${p.reason}` : ""}`,
      data: { taskId: p.taskId, rank: Number(p.rank) || null },
    }),
  },

  group_member_added: {
    subject: "group",
    build: (g, p, actor, name) => ({
      recipientIds: [p.targetEmployeeId],
      type: "group_added",
      title: `➕ Added to ${g.name}`,
      body: `${name} added you to the group "${g.name}".`,
      data: { groupId: p.groupId, groupName: g.name },
    }),
  },
  group_member_removed: {
    subject: "group",
    build: (g, p, actor, name) => ({
      recipientIds: [p.targetEmployeeId],
      type: "group_removed",
      title: `➖ Removed from ${g.name}`,
      body: `${name} removed you from the group "${g.name}".`,
      data: { groupId: p.groupId, groupName: g.name },
    }),
  },
  group_renamed: {
    subject: "group",
    build: (g, p, actor, name) => ({
      recipientIds: (g.memberIds || []).filter((id) => id !== actor),
      type: "group_renamed",
      title: `✏️ Group renamed · ${g.name}`,
      body: `${name} renamed a group you are in to "${g.name}".`,
      data: { groupId: p.groupId, groupName: g.name },
    }),
  },
  group_admin_changed: {
    subject: "group",
    build: (g, p, actor, name) => ({
      recipientIds: [p.targetEmployeeId],
      type: "group_admin_changed",
      title: `👑 Group role changed · ${g.name}`,
      body: p.isAdmin
        ? `${name} made you an admin of "${g.name}".`
        : `${name} removed your admin role in "${g.name}".`,
      data: { groupId: p.groupId, groupName: g.name, isAdmin: !!p.isAdmin },
    }),
  },

  document_renamed: {
    subject: "document",
    build: (d, p, actor, name) => ({
      recipientIds: (d.memberIds || []).filter((id) => id !== actor),
      type: "document_renamed",
      title: "📄 Document renamed",
      body: `${name} renamed a ${d.kind === "sheet" ? "sheet" : "document"} you share to "${d.title}".`,
      data: { documentId: p.documentId },
    }),
  },
  document_deleted: {
    subject: "document",
    build: (d, p, actor, name) => ({
      recipientIds: (d.memberIds || []).filter((id) => id !== actor),
      type: "document_deleted",
      title: "🗑️ Document deleted",
      body: `${name} deleted the ${d.kind === "sheet" ? "sheet" : "document"} "${d.title}".`,
      data: { documentId: p.documentId },
    }),
  },
};

const LOADERS = { task: loadTask, group: loadGroup, document: loadDocument };

router.post("/notify-event", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { employeeId: actor, name: actorName } = req.coworkUser;
    const p = req.body || {};
    const spec = EVENTS[p.kind];
    if (!spec) {
      return res.status(400).json({ success: false, error: `Unknown event kind.` });
    }

    const subjectId =
      spec.subject === "task" ? p.taskId
        : spec.subject === "group" ? p.groupId
          : p.documentId;
    const loaded = await LOADERS[spec.subject](subjectId, actor);
    if (loaded.error) return res.status(404).json({ success: false, error: loaded.error });

    const built = spec.build(loaded.record, p, actor, actorName || "Somebody");
    const sent = await _notify({
      ...built,
      recipientIds: (built.recipientIds || []).filter((id) => id && id !== actor),
      senderId: actor,
      senderName: actorName,
    });

    res.json({ success: true, notified: sent });
  } catch (e) {
    console.error("Error in /notify-event:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
