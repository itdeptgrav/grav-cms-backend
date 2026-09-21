/**
 * The indexes MongoDB needs to serve Cowork's queries.
 *
 * ## Why this file has to exist
 *
 * Firestore indexes single fields automatically and refuses a compound query
 * it has no index for. MongoDB does neither: it will happily run any query as
 * a full collection scan, sort the result in memory, and only complain when
 * the sort passes 32 MB. So on cutover day every query in this backend works,
 * and every one of them gets slower as the data grows — including
 * `Middlewear/coworkAuth.js:47`, which runs `where("authUid","==")` on
 * `cowork_employees` for EVERY authenticated request.
 *
 * ## Where the shapes come from
 *
 * From the queries themselves: every `.where(...)`/`.orderBy(...)` chain on a
 * `cowork_*` collection in routes/ and services/, plus the ones the browser
 * makes through `POST /cowork/db`. Field order follows the standard rule —
 * equality fields first, then the sort field, then range fields — so one
 * compound index serves both the filter and the order.
 *
 * `array-contains` on `assigneeIds` / `participantIds` / `visibleTo` is a
 * plain equality match against an array in MongoDB, which a normal index on
 * that field serves as a multikey index. No special index type is needed.
 *
 * ## Idempotent
 *
 * `createIndex` is a no-op when an identical index exists, so `ensureIndexes`
 * is safe to run on every boot — and it does, so a new collection appearing
 * with no index never sits unindexed until somebody remembers.
 */

"use strict";

/** `[collection, keys, options?]` — the same arguments `createIndex` takes. */
const INDEXES = [
  /* The hottest path in the product: one lookup per authenticated request. */
  ["cowork_employees", { authUid: 1 }],
  ["cowork_employees", { email: 1 }],
  ["cowork_employees", { employeeId: 1 }],
  ["cowork_employees", { role: 1 }],

  /* Tasks: every list view is one of these. */
  ["cowork_tasks", { assigneeIds: 1, updatedAt: -1 }],
  ["cowork_tasks", { assignedBy: 1, updatedAt: -1 }],
  ["cowork_tasks", { pendingAssigneeId: 1 }],
  ["cowork_tasks", { approverId: 1 }],
  ["cowork_tasks", { createdBy: 1 }],
  ["cowork_tasks", { visibleTo: 1 }],
  ["cowork_tasks", { parentId: 1 }],
  ["cowork_tasks", { department: 1 }],
  ["cowork_tasks", { isSelfAssigned: 1 }],
  ["cowork_tasks", { hasOutputs: 1 }],
  ["cowork_tasks", { status: 1, updatedAt: -1 }],
  ["cowork_tasks", { type: 1 }],

  /* Subcollections: every read is scoped by the parent first. */
  ["cowork_tasks__chat", { _parentId: 1, createdAt: 1 }],
  ["cowork_tasks__draft_chat", { _parentId: 1 }],
  ["cowork_tasks__dailyReports", { _parentId: 1, date: -1 }],
  ["cowork_tasks__reports", { _parentId: 1 }],
  ["cowork_groups__messages", { _parentId: 1, createdAt: 1 }],
  ["cowork_direct_messages__messages", { _parentId: 1, createdAt: 1 }],
  ["cowork_conversations__messages", { _parentId: 1, createdAt: 1 }],
  ["cowork_work_commits__logs", { _parentId: 1, at: -1 }],
  ["cowork_timer_events__logs", { _parentId: 1, at: -1 }],
  ["cowork_task_timers__sessions", { _parentId: 1 }],
  ["cowork_scheduled_meets__events", { _parentId: 1, at: 1 }],

  /* Conversations and mail. */
  ["cowork_direct_messages", { participantIds: 1, updatedAt: -1 }],
  ["cowork_groups", { memberIds: 1 }],
  ["cowork_groups", { deleted: 1 }],
  ["cowork_conversations", { participantIds: 1, updatedAt: -1 }],
  ["cowork_mails", { participantIds: 1, createdAt: -1 }],

  /* Notifications: one person's, newest first, unread count. */
  ["cowork_notifications", { recipientEmployeeId: 1, createdAt: -1 }],
  ["cowork_notifications", { recipientEmployeeId: 1, read: 1 }],

  /* Meetings. */
  ["cowork_scheduled_meets", { participants: 1, startAt: 1 }],
  ["cowork_scheduled_meets", { createdBy: 1 }],
  ["cowork_scheduled_meets", { taskId: 1 }],
  ["cowork_meeting_participants", { meetId: 1 }],
  ["meeting_sessions", { meetId: 1 }],

  /* Time and presence. */
  ["cowork_work_commits", { employeeId: 1, date: -1 }],
  ["cowork_duty_history", { employeeId: 1, date: -1 }],
  ["cowork_task_deadline_extensions", { taskId: 1 }],
  ["cowork_task_budget_extensions", { taskId: 1 }],
  ["cowork_task_budget_credits", { taskId: 1 }],
  ["cowork_emergency_approvals", { status: 1 }],
  ["cowork_task_requirement_progress", { taskId: 1 }],

  /* Documents and sharing. */
  ["cowork_documents", { ownerId: 1, updatedAt: -1 }],
  ["cowork_workbooks", { ownerId: 1, updatedAt: -1 }],
  ["cowork_mindmaps", { ownerId: 1, updatedAt: -1 }],
  ["cowork_share_invites", { targetId: 1 }],
  ["cowork_share_guests", { email: 1 }],
];

/**
 * Create every index that is missing. Never drops one.
 *
 * Returns what it did, so the boot log can say "38 indexes ensured, 3 created"
 * rather than nothing — a silent index step is one nobody notices failing.
 */
async function ensureIndexes(db, { log = () => {} } = {}) {
  let created = 0;
  const failures = [];
  for (const [collection, keys, options] of INDEXES) {
    try {
      const before = new Set(
        (await db.collection(collection).indexes().catch(() => [])).map((i) => i.name),
      );
      const name = await db.collection(collection).createIndex(keys, options ?? {});
      if (!before.has(name)) created += 1;
    } catch (e) {
      /* One bad index must not stop the rest — but it must be SAID. */
      failures.push({ collection, keys, error: e.message });
    }
  }
  log(`indexes: ${INDEXES.length} ensured, ${created} created${failures.length ? `, ${failures.length} FAILED` : ""}`);
  for (const f of failures) log(`  index failed on ${f.collection} ${JSON.stringify(f.keys)}: ${f.error}`);
  return { ensured: INDEXES.length, created, failures };
}

module.exports = { INDEXES, ensureIndexes };
