const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

/**
 * The queue walk, actually run.
 *
 * **Everything else about this change is checked by reading the source.** That
 * catches a rule being deleted later; it says nothing about whether the walk
 * produces the right dates. `rechainQueueFor` reaches for Firestore, so it was
 * never executed by a test — which is exactly where a real defect would hide.
 *
 * So Firestore is replaced in the module cache before the service is loaded,
 * and the walk runs against tasks written by hand. The reported bug is the
 * first case below.
 */

/* ── a Firestore stand-in ───────────────────────────────────────────────── */

const IST = "+05:30";
const at = (hhmm, day = 18) => `2026-08-${day}T${hhmm}:00${IST}`;

/** 9:30–18:30 every weekday, nothing on Sunday — the office in the tests. */
const SCHEDULE = {
  sunday: { isOff: true },
  monday: { isOff: false, inTime: "09:30", outTime: "18:30" },
  tuesday: { isOff: false, inTime: "09:30", outTime: "18:30" },
  wednesday: { isOff: false, inTime: "09:30", outTime: "18:30" },
  thursday: { isOff: false, inTime: "09:30", outTime: "18:30" },
  friday: { isOff: false, inTime: "09:30", outTime: "18:30" },
  saturday: { isOff: false, inTime: "09:30", outTime: "18:30" },
};

function fakeDb(tasks) {
  /** What each task ref was asked to write, so the walk can be inspected. */
  const writes = new Map();

  const docFor = (id, data) => ({
    id,
    data: () => data,
    ref: {
      update: async (patch) => {
        writes.set(id, { ...(writes.get(id) || {}), ...patch });
      },
    },
  });

  const db = {
    collection(name) {
      if (name === "cowork_settings") {
        return {
          doc: () => ({
            get: async () => ({
              exists: true,
              data: () => ({ schedule: SCHEDULE, breaks: [] }),
            }),
          }),
        };
      }
      return {
        doc: (id) => ({
          get: async () => {
            const d = tasks[id];
            return { exists: !!d, data: () => d, id };
          },
        }),
        where: () => ({
          get: async () => ({
            forEach: (fn) =>
              Object.entries(tasks).forEach(([id, data]) => fn(docFor(id, data))),
          }),
        }),
      };
    },
  };
  return { db, writes };
}

/** Load a fresh copy of the service with Firestore stubbed out. */
function loadService(tasks) {
  const adminPath = require.resolve("../config/firebaseAdmin");
  const servicePath = require.resolve("./officeDeadline.service.js");
  const { db, writes } = fakeDb(tasks);

  require.cache[adminPath] = {
    id: adminPath,
    filename: adminPath,
    loaded: true,
    exports: { db, admin: {} },
  };
  delete require.cache[servicePath];
  const svc = require(servicePath);
  return { svc, writes };
}

const budgeted = (over) => ({
  status: "in_progress",
  hasTimer: true,
  fixedDeadline: null,
  assigneeIds: ["GR1"],
  createdAtISO: at("09:30"),
  ...over,
});

/* ── the reported bug, executed ─────────────────────────────────────────── */

/**
 * NOTE on `writes.get(id)` below.
 *
 * The walk now also records `effectivePriority` — the position a task actually
 * holds once blocked work has been dropped past, which the stored rank cannot
 * express because it is never overwritten. That means a task can be WRITTEN
 * without its deadline changing, and these tests used "was it written at all"
 * as a stand-in for "did its deadline move".
 *
 * So the guards ask about `dueDate` specifically. The guarantees are unchanged
 * — a deadline that IS written still must not be earlier, and a handed-in task
 * still must not receive one.
 */
test("B chains from A's 1pm handover, not from A's 2pm deadline", async () => {
  /**
   * The case that started this. A is due 2pm and was handed in at 1pm; B is
   * two hours. The old reading made B due 4pm — A's DEADLINE plus B's budget,
   * as though the person sat idle for the hour they had already finished.
   */
  const { svc, writes } = loadService({
    A: budgeted({
      priority: 1,
      completionStatus: "submitted",
      completionSubmission: { submittedAt: at("13:00") },
      dueDate: at("14:00"),
      clockStartsAtMs: Date.parse(at("11:00")),
      deadlineWindowSecs: 3 * 3600,
    }),
    B: budgeted({
      priority: 2,
      /* Not started yet — its anchor is early, so the queue decides. */
      clockStartsAtMs: Date.parse(at("09:30")),
      deadlineWindowSecs: 2 * 3600,
      dueDate: null,
      createdAtISO: at("09:35"),
    }),
  });

  await svc.rechainQueueFor("GR1");

  const b = writes.get("B");
  assert.ok(b, "B was never given a deadline");
  assert.equal(
    new Date(b.dueDate).toISOString(),
    new Date(at("15:00")).toISOString(),
    `B should be due 3pm, got ${b.dueDate}`,
  );
  assert.equal(b.clockStartsAtSource, "after_priority_work");
});

test("submitted LATE, B chains from the late handover", async () => {
  /* The half nobody notices: handed in at 2:30 for a 2pm deadline, the old
     reading still started B at 2pm — before the person was free. */
  const { svc, writes } = loadService({
    A: budgeted({
      priority: 1,
      completionStatus: "submitted",
      completionSubmission: { submittedAt: at("14:30") },
      dueDate: at("14:00"),
      clockStartsAtMs: Date.parse(at("11:00")),
      deadlineWindowSecs: 3 * 3600,
    }),
    B: budgeted({
      priority: 2,
      clockStartsAtMs: Date.parse(at("09:30")),
      deadlineWindowSecs: 2 * 3600,
      dueDate: null,
      createdAtISO: at("09:35"),
    }),
  });

  await svc.rechainQueueFor("GR1");
  assert.equal(
    new Date(writes.get("B").dueDate).toISOString(),
    new Date(at("16:30")).toISOString(),
  );
});

test("A still in progress: B chains from A's DEADLINE, as before", async () => {
  /* The regression guard. Nothing about unsubmitted work changed. */
  const { svc, writes } = loadService({
    A: budgeted({
      priority: 1,
      dueDate: at("14:00"),
      clockStartsAtMs: Date.parse(at("11:00")),
      deadlineWindowSecs: 3 * 3600,
    }),
    B: budgeted({
      priority: 2,
      clockStartsAtMs: Date.parse(at("09:30")),
      deadlineWindowSecs: 2 * 3600,
      dueDate: null,
      createdAtISO: at("09:35"),
    }),
  });

  await svc.rechainQueueFor("GR1");
  assert.equal(
    new Date(writes.get("B").dueDate).toISOString(),
    new Date(at("16:00")).toISOString(),
  );
});

/* ── the protections ────────────────────────────────────────────────────── */

test("a task already handed in is never given a new deadline", async () => {
  /**
   * This is what protects the leftover rule. That rule measures unused time as
   * `deadline − submittedAt`, so pushing a submitted task's deadline later
   * would silently hand the rework time nobody earned.
   */
  const { svc, writes } = loadService({
    A: budgeted({
      priority: 2,
      completionStatus: "submitted",
      completionSubmission: { submittedAt: at("13:00") },
      dueDate: at("14:00"),
      clockStartsAtMs: Date.parse(at("11:00")),
      deadlineWindowSecs: 3 * 3600,
    }),
    BIG: budgeted({
      priority: 1,
      clockStartsAtMs: Date.parse(at("10:00")),
      deadlineWindowSecs: 6 * 3600,
      dueDate: at("17:00"),
      createdAtISO: at("09:00"),
    }),
  });

  await svc.rechainQueueFor("GR1");
  /* Its DEADLINE, specifically — the walk may still record the position it
     holds, which is not a claim about its date. */
  assert.equal(
    writes.get("A")?.dueDate,
    undefined,
    "the submitted task's deadline was rewritten — the leftover hour is now wrong",
  );
});

test("a REAL anchor is never pulled earlier", async () => {
  /**
   * The protection that survives. `first_online` says the person could not
   * have started before that moment — a fact about them, not about the queue —
   * so the queue never argues with it.
   */
  const { svc, writes } = loadService({
    A: budgeted({
      priority: 1,
      completionStatus: "submitted",
      completionSubmission: { submittedAt: at("10:00") },
      dueDate: at("14:00"),
      clockStartsAtMs: Date.parse(at("09:30")),
      clockStartsAtSource: "first_online",
      deadlineWindowSecs: 4 * 3600,
    }),
    B: budgeted({
      priority: 2,
      clockStartsAtMs: Date.parse(at("14:00")),
      clockStartsAtSource: "first_online",
      deadlineWindowSecs: 2 * 3600,
      dueDate: at("16:00"),
      createdAtISO: at("09:35"),
    }),
  });

  await svc.rechainQueueFor("GR1");
  const b = writes.get("B");
  if (b && b.dueDate !== undefined) {
    assert.ok(
      Date.parse(b.dueDate) >= Date.parse(at("16:00")),
      `a real anchor was pulled earlier, to ${b.dueDate}`,
    );
  }
});

test("T069/T070: a stale queue anchor corrects itself downward", async () => {
  /**
   * The reported case, with the real shape. T069 (P3, 31 min) is due 17:21
   * and was handed in at 17:02:44. T070 (P4, 30 min) sits at 17:51 — which is
   * T069's DEADLINE plus 30 minutes, written by a previous run of this walk.
   *
   * The handover was already being read correctly; what blocked the correction
   * was `Math.max` defending that stale 17:21 anchor against the new 17:02:44
   * answer. A value this walk wrote is not a promise the task can claim.
   */
  const { svc, writes } = loadService({
    T069: budgeted({
      priority: 3,
      status: "confirmed",
      completionStatus: "submitted",
      completionSubmission: { submittedAt: at("17:02") },
      dueDate: at("17:21"),
      clockStartsAtMs: Date.parse(at("16:50")),
      clockStartsAtSource: "first_online",
      deadlineWindowSecs: 1860,
      createdAtISO: at("16:50"),
    }),
    T070: budgeted({
      priority: 4,
      status: "confirmed",
      /* Both written by the previous chain, from T069's old deadline. */
      clockStartsAtMs: Date.parse(at("17:21")),
      clockStartsAtSource: "after_priority_work",
      dueDate: at("17:51"),
      deadlineWindowSecs: 1800,
      createdAtISO: at("16:54"),
    }),
  });

  await svc.rechainQueueFor("GR1");

  const t070 = writes.get("T070");
  assert.ok(t070, "T070 was not corrected at all");
  assert.equal(
    new Date(t070.dueDate).toISOString(),
    new Date(at("17:32")).toISOString(),
    `T070 should be 17:32 (17:02 handover + 30 min), got ${t070.dueDate}`,
  );
  /* Already epoch ms on the record, not an ISO string. */
  assert.equal(t070.clockStartsAtMs, Date.parse(at("17:02")));
  assert.equal(t070.clockStartsAtSource, "after_priority_work");

  /* And T069, which is submitted, is still not re-dated — the leftover rule
     depends on its deadline staying put. It may still be given the position it
     holds; that is not a claim about its date. */
  assert.equal(writes.get("T069")?.dueDate, undefined);
});

test("a deadline set by something else is left alone", async () => {
  /**
   * Found on live data before this was written. T066 carried a queue anchor of
   * 10:05 and a 195-minute budget — which computes to 13:21 — but a stored
   * deadline of 15:30, put there by an extension or a negotiated budget.
   *
   * The task above it had NOT been handed over, so its anchor was still
   * correct and nothing should have moved. An earlier version of this fix
   * rewrote 15:30 to 13:21, a time already two hours in the past, sending the
   * task instantly overdue for a reason nobody could explain.
   */
  const { svc, writes } = loadService({
    /* Settled: its own anchor plus its own budget already equals its stored
       deadline, so it does not move and the queue point below it is exactly
       10:05 — isolating what this test is actually about. */
    AHEAD: budgeted({
      priority: 1,
      dueDate: at("10:05"),
      clockStartsAtMs: Date.parse(at("09:30")),
      clockStartsAtSource: "first_online",
      deadlineWindowSecs: 35 * 60,
      createdAtISO: at("09:00"),
    }),
    EXTENDED: budgeted({
      priority: 2,
      /* Anchor agrees with the queue; the deadline does not agree with the
         anchor, because somebody granted more time. */
      clockStartsAtMs: Date.parse(at("10:05")),
      clockStartsAtSource: "after_priority_work",
      dueDate: at("15:30"),
      deadlineWindowSecs: 195 * 60,
      createdAtISO: at("09:00"),
    }),
  });

  await svc.rechainQueueFor("GR1");
  /* Its DEADLINE, specifically — the walk may still record the position it
     holds, which is not a claim about its date. */
  assert.equal(
    writes.get("EXTENDED")?.dueDate,
    undefined,
    "a deadline granted elsewhere was overwritten by the queue walk",
  );
});

test("a corrected deadline does not push the task after it back out", async () => {
  /* The subtle half: if the walk kept the OLD later value as the chain point,
     the row below would be pushed out again and the correction would only
     travel one task deep. */
  const { svc, writes } = loadService({
    A: budgeted({
      priority: 1,
      completionStatus: "submitted",
      completionSubmission: { submittedAt: at("13:00") },
      dueDate: at("14:00"),
      clockStartsAtMs: Date.parse(at("11:00")),
      clockStartsAtSource: "first_online",
      deadlineWindowSecs: 3 * 3600,
    }),
    B: budgeted({
      priority: 2,
      clockStartsAtMs: Date.parse(at("14:00")),
      clockStartsAtSource: "after_priority_work",
      dueDate: at("15:00"),
      deadlineWindowSecs: 3600,
      createdAtISO: at("09:35"),
    }),
    C: budgeted({
      priority: 3,
      clockStartsAtMs: Date.parse(at("15:00")),
      clockStartsAtSource: "after_priority_work",
      dueDate: at("16:00"),
      deadlineWindowSecs: 3600,
      createdAtISO: at("09:40"),
    }),
  });

  await svc.rechainQueueFor("GR1");

  /* A frees the queue at 13:00 → B due 14:00 → C due 15:00. */
  assert.equal(
    new Date(writes.get("B").dueDate).toISOString(),
    new Date(at("14:00")).toISOString(),
  );
  assert.equal(
    new Date(writes.get("C").dueDate).toISOString(),
    new Date(at("15:00")).toISOString(),
    "the correction did not travel past the first task",
  );
});

test("a fixed-date task occupies nobody's queue", async () => {
  const { svc, writes } = loadService({
    FIXED: budgeted({
      priority: 1,
      hasTimer: false,
      fixedDeadline: at("18:00", 25),
      dueDate: at("18:00", 25),
      clockStartsAtMs: Date.parse(at("09:30")),
      deadlineWindowSecs: 0,
    }),
    B: budgeted({
      priority: 2,
      clockStartsAtMs: Date.parse(at("13:00")),
      deadlineWindowSecs: 2 * 3600,
      dueDate: null,
      createdAtISO: at("09:35"),
    }),
  });

  await svc.rechainQueueFor("GR1");
  const b = writes.get("B");
  if (b && b.dueDate !== undefined) {
    assert.ok(
      Date.parse(b.dueDate) < Date.parse(at("00:00", 25)),
      `B was pushed to next week by a fixed-date task: ${b.dueDate}`,
    );
  }
});

test("work left after closing carries to the next working morning", async () => {
  /* The office arithmetic, on the real walk: 45 minutes left at 17:45 does
     not finish at 18:45 with nobody at a desk. */
  const { svc, writes } = loadService({
    A: budgeted({
      priority: 1,
      completionStatus: "submitted",
      completionSubmission: { submittedAt: at("17:45") },
      dueDate: at("18:00"),
      clockStartsAtMs: Date.parse(at("15:00")),
      deadlineWindowSecs: 3 * 3600,
    }),
    B: budgeted({
      priority: 2,
      clockStartsAtMs: Date.parse(at("09:30")),
      deadlineWindowSecs: 2 * 3600,
      dueDate: null,
      createdAtISO: at("09:35"),
    }),
  });

  await svc.rechainQueueFor("GR1");
  const due = new Date(writes.get("B").dueDate);
  assert.equal(due.getDate(), 19, `expected the next day, got ${due.toISOString()}`);
});

/* ── the preview ────────────────────────────────────────────────────────── */

test("a simulation reports every row and writes nothing", async () => {
  const { svc, writes } = loadService({
    A: budgeted({
      priority: 3,
      completionStatus: "submitted",
      completionSubmission: { submittedAt: at("13:00") },
      dueDate: at("14:00"),
      clockStartsAtMs: Date.parse(at("11:00")),
      deadlineWindowSecs: 3 * 3600,
    }),
    B: budgeted({
      priority: 2,
      clockStartsAtMs: Date.parse(at("13:00")),
      deadlineWindowSecs: 2 * 3600,
      dueDate: at("15:00"),
      createdAtISO: at("09:35"),
    }),
  });

  const rows = await svc.rechainQueueFor("GR1", {
    dryRun: true,
    reportAll: true,
    simulate: {
      taskId: "A",
      rank: 1,
      secs: 3600,
      startMs: Date.parse(at("14:00")),
    },
  });

  assert.equal(writes.size, 0, "a preview wrote to the database");
  assert.equal(rows.length, 2, `expected both tasks reported, got ${rows.length}`);

  const rework = rows.find((r) => r.isRework);
  assert.ok(rework, "the task being sent back was not in the preview");
  assert.equal(rework.taskId, "A");
  /* One hour from 2pm, at the top of the queue. */
  assert.equal(
    new Date(rework.to).toISOString(),
    new Date(at("15:00")).toISOString(),
  );

  /* And B, which the rework now sits above, is pushed out by that hour. */
  const b = rows.find((r) => r.taskId === "B");
  assert.ok(Date.parse(b.to) > Date.parse(b.from), "B should have been pushed");
});

test("the same simulation at a LOW priority leaves the others alone", async () => {
  /* The other half of what the reviewer is choosing between. */
  const { svc } = loadService({
    A: budgeted({
      priority: 3,
      completionStatus: "submitted",
      completionSubmission: { submittedAt: at("13:00") },
      dueDate: at("14:00"),
      clockStartsAtMs: Date.parse(at("11:00")),
      deadlineWindowSecs: 3 * 3600,
    }),
    B: budgeted({
      priority: 2,
      clockStartsAtMs: Date.parse(at("13:00")),
      deadlineWindowSecs: 2 * 3600,
      dueDate: at("15:00"),
      createdAtISO: at("09:35"),
    }),
  });

  const rows = await svc.rechainQueueFor("GR1", {
    dryRun: true,
    reportAll: true,
    simulate: {
      taskId: "A",
      rank: 5,
      secs: 3600,
      startMs: Date.parse(at("14:00")),
    },
  });

  const b = rows.find((r) => r.taskId === "B");
  assert.equal(b.from, b.to, `B moved when it should not have: ${b.from} → ${b.to}`);
});

test("a simulation without dryRun is refused rather than writing", async () => {
  const { svc, writes } = loadService({
    A: budgeted({ priority: 1, dueDate: at("14:00"), clockStartsAtMs: Date.parse(at("11:00")), deadlineWindowSecs: 3600 }),
  });
  await assert.rejects(
    () => svc.rechainQueueFor("GR1", { simulate: { taskId: "A", rank: 1, secs: 600, startMs: Date.now() } }),
    /simulate requires dryRun/,
  );
  assert.equal(writes.size, 0);
});
