/**
 * A subtask may not be due after the project it belongs to.
 * OWNER DECISION, 16 Aug 2026.
 *
 * The parent carries the commitment and the subtasks are how it gets met. A
 * part due after the whole is a promise that cannot be kept, and the project's
 * owner has no way to see it coming — the project sits there looking healthy
 * until the day it is due, with work underneath it still running.
 *
 * ## Why this is its own module
 *
 * The route that enforces it (`review-deadline-extension`) reaches Firestore at
 * require time, so nothing in it can be imported by a test. The arithmetic that
 * decides whether a grant is legal is the part worth testing hardest, so it
 * lives here, pure, with the Firestore read kept behind a lazy require exactly
 * as `officeDeadline.service.js` does.
 *
 * The frontend has the same rule in `lib/rules/tasks/subtaskDeadlineCap.ts` and
 * the two are deliberately independent: one warns before a round trip, this one
 * is the gate. They must AGREE, which is what `capBreach`'s inclusive boundary
 * and second-level rounding are for — the pair are pinned to the same cases on
 * both sides.
 */

/**
 * Whether a granted deadline breaks out of its project, and by how much.
 *
 * **Unknown is allowed**, deliberately: a missing parent deadline or an
 * unreadable grant is not evidence of a breach, and refusing on absent data
 * would block ordinary extensions. Equal instants pass — due exactly when the
 * project is due is not after it.
 */
function capBreach({ grantedMs, parentDueAtMs }) {
  if (!Number.isFinite(grantedMs) || grantedMs == null) {
    return { breached: false, overshootSecs: 0 };
  }
  if (!Number.isFinite(parentDueAtMs) || parentDueAtMs == null) {
    return { breached: false, overshootSecs: 0 };
  }
  if (grantedMs <= parentDueAtMs) return { breached: false, overshootSecs: 0 };
  return {
    breached: true,
    overshootSecs: Math.round((grantedMs - parentDueAtMs) / 1000),
  };
}

/** `2d 3h 15m`, or `15m` — the smallest reading that stays exact. */
function overshootLabel(secs) {
  const s = Math.max(0, Math.round(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || parts.length === 0) parts.push(`${m}m`);
  return parts.join(" ");
}

/**
 * The refusal, which carries its own remedy.
 *
 * A flat "no" would be a dead end: the approver believes the time is warranted,
 * and the only way to grant it would be a second action on a different task
 * they may not think to take. Naming `raiseParent` in the refusal is what makes
 * it one decision instead of two.
 */
function capRefusalBody({ parent, overshootSecs }) {
  return {
    error: `This runs ${overshootLabel(overshootSecs)} past its project “${parent.title}”, which is due ${new Date(parent.dueAtMs).toISOString()}. A subtask cannot be due after the project it belongs to. Send raiseParent to grant it and move the project out by the same amount.`,
    code: "AFTER_PARENT_DEADLINE",
    parentTaskId: parent.taskId,
    parentDueAt: new Date(parent.dueAtMs).toISOString(),
    overshootSecs,
  };
}

/**
 * Where the project's new deadline lands when the approver raises it.
 *
 * **By exactly the overshoot, not to the child's date.** The two are the same
 * instant here, and saying it this way is what keeps it true if the child's
 * grant ever stops being the thing that breached the cap — the project moves by
 * the amount it was short, which is the promise made in the refusal.
 */
function raisedParentDueAt({ parent, overshootSecs }) {
  return new Date(parent.dueAtMs + overshootSecs * 1000).toISOString();
}

/**
 * The project a task belongs to, with the deadline it may not outlive.
 *
 * Null for an ordinary task, an unreadable parent, or a parent with no deadline
 * of its own — all three mean "no ceiling", the safe direction: a missing figure
 * must never block an extension.
 *
 * `field` names WHERE the parent's deadline lives, by the same `hasTimer` rule
 * `reworkTask` uses, so a raise writes back to the field the parent is read
 * from. The READ order matches the frontend's `readDueAtMs` — reading them in a
 * different order would let the engine cap against one date while the page
 * shows another.
 */
async function readParentDeadline(task) {
  const parentId = task && task.parentTaskId ? String(task.parentTaskId) : "";
  if (!parentId) return null;
  try {
    const { db } = require("../config/firebaseAdmin");
    const { readMs } = require("./officeDeadline.service");
    const snap = await db.collection("cowork_tasks").doc(parentId).get();
    if (!snap.exists) return null;
    const p = snap.data();
    const dueAtMs =
      readMs(p.fixedDeadline) ?? readMs(p.deadline) ?? readMs(p.dueDate) ?? null;
    if (dueAtMs === null) return null;
    return {
      taskId: parentId,
      title: p.title || parentId,
      dueAtMs,
      field: p.hasTimer === false ? "fixedDeadline" : "dueDate",
    };
  } catch (e) {
    console.error("[parentCap] parent deadline unreadable:", e.message);
    return null;
  }
}

module.exports = {
  capBreach,
  overshootLabel,
  capRefusalBody,
  raisedParentDueAt,
  readParentDeadline,
};
