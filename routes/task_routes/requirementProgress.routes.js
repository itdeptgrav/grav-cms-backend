/**
 * Requirement progress — the assignee's own checklist on a task.
 *
 * Its own file, and its own collection, because it is deliberately NOT the same
 * fact as a requirement being satisfied. Satisfaction is the reviewer's
 * decision and is what lets a task be accepted; this is the person doing the
 * work saying "I have done this one" so whoever raised it can see movement
 * without asking and without waiting for review.
 *
 * Keeping them apart is the whole design. Writing a tick onto the requirement
 * itself would put a second answer beside the reviewer's on one question, and
 * the first time the two disagreed there would be no rule for which wins.
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

// ═══════════════════════════════════════════════════════════════════════════
// REQUIREMENT PROGRESS — the assignee ticking off their own checklist.
//
// **This is PROGRESS, not satisfaction, and the distinction is the whole
// point.** A task's completion requirements are the reviewer's reference during
// review: the reviewer decides which are met, and that decision is what lets a
// task be accepted. Nothing here touches that. A tick is the person doing the
// work saying "I have done this one", so their creator can see movement without
// asking and without waiting for review.
//
// Stored in its own collection rather than on the task document for exactly
// that reason. Writing it onto the requirement would put a second answer beside
// the reviewer's on one question, and the first time they disagreed there would
// be no rule for which wins.
//
// Two routes: read the marks for a task, and set one.
// ═══════════════════════════════════════════════════════════════════════════

const REQ_PROGRESS = "cowork_task_requirement_progress";

/** One doc per requirement, so a second tick overwrites rather than piles up. */
function reqProgressId(taskId, requirementId) {
  return `${taskId}__${requirementId}`;
}

/**
 * Notify one person, the same three steps `_notify` takes elsewhere in this
 * folder: a row, a socket nudge, and a push. Local for the same reason theirs
 * is — the alternative is importing a route file from a route file.
 */
async function _notifyRequirementProgress({ recipientId, title, body, data }) {
  if (!recipientId) return;
  try {
    await db
      .collection("cowork_notifications")
      .doc(uuidv4())
      .set({
        recipientEmployeeId: String(recipientId),
        type: "task_requirement_progress",
        title,
        body,
        data: data || {},
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    socket.emitToMany([String(recipientId)], "new_notification", {
      type: "task_requirement_progress",
      title,
      body,
      data,
    });
    setImmediate(() => {
      try {
        const { sendPushToEmployees } = require("../../services/fcmPush.service");
        sendPushToEmployees([String(recipientId)], title, body, {
          type: "task_requirement_progress",
          ...(data || {}),
        }).catch(() => {});
      } catch (_) {}
    });
  } catch (e) {
    /* A notification that fails must never fail the tick. The mark is the
       record; telling somebody about it is a courtesy on top of it. */
    console.error("[requirementProgress notify]", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /cowork/task/:taskId/requirement-progress
// → { success: true, marks: [{ requirementId, done, byEmployeeId, byName, at }] }
// ─────────────────────────────────────────────────────────────────────────
router.get(
  "/task/:taskId/requirement-progress",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const { taskId } = req.params;
      const snap = await db
        .collection(REQ_PROGRESS)
        .where("taskId", "==", String(taskId))
        .get();
      const marks = snap.docs.map((d) => {
        const x = d.data();
        const at = x.at?.toDate?.() ?? null;
        return {
          requirementId: String(x.requirementId ?? ""),
          done: x.done === true,
          byEmployeeId: x.byEmployeeId ? String(x.byEmployeeId) : null,
          byName: typeof x.byName === "string" ? x.byName : "",
          at: at ? at.toISOString() : "",
        };
      });
      res.json({ success: true, marks });
    } catch (e) {
      console.error("[requirementProgress] read:", e.message);
      res.status(500).json({ error: e.message });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────
// POST /cowork/task/:taskId/requirement-progress
// Body: { requirementId, done, requirementText }
// ─────────────────────────────────────────────────────────────────────────
router.post(
  "/task/:taskId/requirement-progress",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const { taskId } = req.params;
      const { requirementId, done, requirementText } = req.body || {};
      const { employeeId, name } = req.coworkUser;

      if (!taskId || !requirementId)
        return res
          .status(400)
          .json({ error: "taskId and requirementId are required" });

      const taskSnap = await db.collection("cowork_tasks").doc(String(taskId)).get();
      if (!taskSnap.exists)
        return res.status(404).json({ error: "Task not found" });
      const task = taskSnap.data();

      /**
       * **Only the two people the task is between.**
       *
       * The person carrying the work marks their own progress; whoever raised
       * it may correct a mark. Nobody else — a manager reading the task is
       * looking at somebody else's checklist, and a tick from them would say
       * the assignee had reported something they had not.
       */
      /**
       * **The real field names, which the first version of this guessed at.**
       *
       * A Cowork task does not carry `assignedTo`. It holds `assigneeIds`, an
       * ARRAY — a task can be held by more than one person — and while a
       * cross-department task waits at its gate the holder sits in
       * `pendingAssigneeId` with `assigneeIds` still empty. Reading only the
       * first would refuse the very person carrying the work at exactly the
       * moment they are most likely to be marking things off.
       *
       * `createdBy ?? assignedBy` is the same fold `lib/legacy/tasks.ts` uses
       * for `createdById`, and `assignedBy` is added separately: on a SELF task
       * the engine deliberately makes the assigner somebody else, and both of
       * them have a legitimate claim to correct a mark.
       */
      const holders = [
        ...(Array.isArray(task.assigneeIds) ? task.assigneeIds : []),
        task.pendingAssigneeId,
      ]
        .filter(Boolean)
        .map(String);
      const creator = String(task.createdBy ?? task.assignedBy ?? "");
      const assigner = String(task.assignedBy ?? task.createdBy ?? "");
      const me = String(employeeId);

      const mayMark =
        holders.includes(me) || me === creator || me === assigner;
      if (!mayMark)
        return res.status(403).json({
          error:
            "Only the person doing this task, or the person who raised it, can mark a requirement.",
        });

      const isDone = done === true || done === "true";
      await db
        .collection(REQ_PROGRESS)
        .doc(reqProgressId(taskId, requirementId))
        .set(
          {
            taskId: String(taskId),
            requirementId: String(requirementId),
            done: isDone,
            byEmployeeId: me,
            byName: name || me,
            at: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

      /* Told once, when it is marked done — and never to the person who did the
         marking, who does not need telling what they just did. Unticking is not
         announced: it is a correction, and a notification for it would read as
         work having been undone. */
      if (isDone && creator && creator !== me) {
        const short = String(requirementText ?? "").slice(0, 120);
        await _notifyRequirementProgress({
          recipientId: creator,
          title: `${name || "Someone"} marked a requirement done`,
          body: short
            ? `${short} — on “${task.title ?? taskId}”`
            : `On “${task.title ?? taskId}”`,
          data: { taskId: String(taskId), requirementId: String(requirementId) },
        });
      }

      res.json({ success: true });
    } catch (e) {
      console.error("[requirementProgress] write:", e.message);
      res.status(500).json({ error: e.message });
    }
  },
);

module.exports = router;
