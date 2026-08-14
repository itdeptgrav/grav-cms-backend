/**
 * Who is the HEAD of a task — the person entitled to review it.
 *
 * ## Why this exists
 *
 * The route gates used to ask `["ceo","tl"].includes(role)`, or bluntly
 * `role === "employee"` → refuse. That is a question about a ROLE STRING, and
 * in this deployment a manager is not a role string: `cowork_employees.role`
 * holds only `ceo`, `tl` or `employee`, while the reporting line lives in
 * `primaryManager`. An ordinary primary manager carries `role: "employee"`, so
 * they were refused on tasks THEY had created and assigned — able to approve a
 * submission but not to send it back, which is not a coherent permission.
 *
 * The right question is about the task, not the person: did you assign this?
 *
 * ## `confirmedBy` is NOT a head
 *
 * It looks like one and it is not. It is written as
 * `confirmedBy: arrayUnion(task.assigneeIds[0])` — the ASSIGNEE acknowledging
 * receipt. Treating it as a head would let the person doing the work approve
 * and credit their own submission. The engine's own notification code makes
 * exactly this mistake (`headIds = [assignedBy, ...confirmedBy]`); it is
 * harmless for addressing an email and would not be harmless here.
 *
 * `originalAssignedBy` IS counted: a forwarded task keeps the first assigner
 * there, and they do not stop being the head because it moved once.
 */

/** True when this person may review this task. Reads the task; never throws. */
async function isTaskHead(taskId, employeeId, role) {
  if (["ceo", "tl"].includes(role)) return true;
  if (!taskId || !employeeId) return false;
  try {
    const { db } = require("../../config/firebaseAdmin");
    const snap = await db.collection("cowork_tasks").doc(String(taskId)).get();
    if (!snap.exists) return false;
    const t = snap.data();
    return t.assignedBy === employeeId || t.originalAssignedBy === employeeId;
  } catch {
    /* Unreadable task means the claim cannot be established. Refusing is the
       safe direction — the caller turns this into a 403, not a 500. */
    return false;
  }
}

module.exports = { isTaskHead };
