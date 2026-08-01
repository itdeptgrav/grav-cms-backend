/**
 * GRAV-CMS-BACKEND/services/activePriority.js
 *
 * The one definition of "this task counts as active work".
 *
 * Every workload, capacity and priority figure must agree, and they cannot if
 * each caller writes its own status list. The frontend has the matching rule in
 * `lib/rules/tasks/activeQueue.ts`; this is its counterpart, and the two are
 * kept deliberately parallel so a number computed here and a number computed
 * there describe the same set of tasks.
 *
 * **Two conditions, both required.**
 *
 * 1. The status allows work. `pending_deadline_approval` is already excluded by
 *    most queries; `open` is not, and `open` is exactly the status a task sits
 *    at while its time budget is still being agreed.
 *
 * 2. The time budget is settled. A task nobody has agreed the hours for is real
 *    work that has not been committed to — counting it shows an employee's
 *    capacity as blocked by something neither side has accepted, and inflates
 *    every total built on it.
 *
 * **This is not a visibility rule.** A task in negotiation must still appear in
 * pending approvals and waiting-action lists — it is waiting on somebody, and
 * that is the whole point of those surfaces. It simply does not COUNT as active
 * work while the hours are unsettled.
 */

/** Legacy statuses in which somebody can actually get on with the work. */
const WORKABLE_STATUSES = new Set(["open", "in_progress", "confirmed"]);

/** Review outcomes that mean the task is finished. */
const FINISHED_REVIEW = new Set([
  "tl_final_approved",
  "ceo_approved",
  "completed",
  "approved",
]);

/**
 * Is the time budget agreed?
 *
 * Absent means there is nothing to agree — a fixed-deadline task is ready the
 * moment it is assigned. Only a task that HAS a negotiation must finish it.
 */
function isBudgetSettled(task) {
  const state = task && task.budgetNegotiation && task.budgetNegotiation.state;
  if (!state) return true;
  return state === "ACCEPTED";
}

/** The predicate. Use this rather than a status list. */
function isActivePriorityTask(task) {
  if (!task || task.isDeleted) return false;
  if (!WORKABLE_STATUSES.has(task.status)) return false;
  if (FINISHED_REVIEW.has(task.completionStatus)) return false;
  return isBudgetSettled(task);
}

/**
 * Is this task waiting on a person rather than being worked on?
 *
 * The complement that keeps negotiation VISIBLE: these belong in pending
 * approvals and waiting lists even though they count as no workload.
 */
function isAwaitingDecision(task) {
  if (!task || task.isDeleted) return false;
  if (task.status === "pending_deadline_approval") return true;
  if (task.status === "pending_department_approval") return true;
  if (task.status === "pending_tl_hours") return true;
  return WORKABLE_STATUSES.has(task.status) && !isBudgetSettled(task);
}

module.exports = {
  isActivePriorityTask,
  isAwaitingDecision,
  isBudgetSettled,
  WORKABLE_STATUSES,
};
