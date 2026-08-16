const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  capBreach,
  capRefusalBody,
  overshootLabel,
  raisedParentDueAt,
} = require("./parentDeadlineCap.service");

/**
 * The extension cap, tested as behaviour rather than as rendering.
 * OWNER DECISION, 16 Aug 2026: an extension past the project is refused, unless
 * the project's deadline moves out by the same amount.
 *
 * Owner's case: project "Task A" due 20 August 11:00; subtasks under it belong
 * to Pramod and Soumya and neither may be extended past that date.
 */

const at = (iso) => Date.parse(`${iso}+05:30`);
const PARENT_MS = at("2026-08-20T11:00:00.000");
const PARENT = {
  taskId: "T100",
  title: "Task A",
  dueAtMs: PARENT_MS,
  field: "dueDate",
};

/* ── The decision ─────────────────────────────────────────────────────────── */

test("an extension that stays inside the project is granted", () => {
  const b = capBreach({
    grantedMs: at("2026-08-19T17:00:00.000"),
    parentDueAtMs: PARENT_MS,
  });
  assert.deepEqual(b, { breached: false, overshootSecs: 0 });
});

test("an extension past the project is refused, with the overshoot", () => {
  const b = capBreach({
    grantedMs: at("2026-08-21T14:30:00.000"),
    parentDueAtMs: PARENT_MS,
  });
  assert.equal(b.breached, true);
  assert.equal(b.overshootSecs, 27 * 3600 + 30 * 60);
});

test("landing exactly on the project's deadline is not past it", () => {
  /* The rule is "not later than". A strict `<` would refuse an equal instant,
     decided by rounding rather than by anything real. Matches the frontend's
     `subtaskDeadlineCap` exactly — the two must agree or the form warns about
     something the engine allows. */
  assert.equal(capBreach({ grantedMs: PARENT_MS, parentDueAtMs: PARENT_MS }).breached, false);
});

test("one second past is past", () => {
  const b = capBreach({ grantedMs: PARENT_MS + 1000, parentDueAtMs: PARENT_MS });
  assert.equal(b.breached, true);
  assert.equal(b.overshootSecs, 1);
});

test("sub-second overshoot rounds to the nearest second, not to zero", () => {
  /* 1.6s must not report as a 2s breach on one side and 1s on the other. */
  assert.equal(
    capBreach({ grantedMs: PARENT_MS + 1600, parentDueAtMs: PARENT_MS }).overshootSecs,
    2,
  );
});

/* ── Missing data never blocks an extension ───────────────────────────────── */

test("a task with no project caps nothing", () => {
  for (const parent of [null, undefined, Number.NaN]) {
    assert.equal(
      capBreach({ grantedMs: PARENT_MS + 86400_000, parentDueAtMs: parent }).breached,
      false,
      `parentDueAtMs=${String(parent)} blocked an extension`,
    );
  }
});

test("an unreadable granted date is not treated as a breach", () => {
  /* The safe direction. Refusing on absent data would block ordinary
     extensions on ordinary tasks. */
  for (const granted of [null, undefined, Number.NaN]) {
    assert.equal(
      capBreach({ grantedMs: granted, parentDueAtMs: PARENT_MS }).breached,
      false,
      `grantedMs=${String(granted)} was refused`,
    );
  }
});

/* ── What the approver is told ────────────────────────────────────────────── */

test("the overshoot reads in the largest units that stay exact", () => {
  assert.equal(overshootLabel(0), "0m");
  assert.equal(overshootLabel(900), "15m");
  assert.equal(overshootLabel(3600), "1h");
  assert.equal(overshootLabel(86400 + 3600 + 900), "1d 1h 15m");
  assert.equal(overshootLabel(-5), "0m", "a negative never renders as a duration");
});

test("the refusal names the project, its date, the overshoot AND the way out", () => {
  /**
   * A flat "no" would be a dead end: the approver believes the time is
   * warranted, and the only remedy would be a second action on a different task
   * they may not think to take. Naming `raiseParent` is what makes it one
   * decision instead of two.
   */
  const body = capRefusalBody({ parent: PARENT, overshootSecs: 7200 });
  assert.equal(body.code, "AFTER_PARENT_DEADLINE");
  assert.match(body.error, /2h past its project “Task A”/);
  assert.match(body.error, /cannot be due after the project/);
  assert.match(body.error, /Send raiseParent/);
  /* Machine-readable too, so the UI can offer the raise without parsing prose. */
  assert.equal(body.parentTaskId, "T100");
  assert.equal(body.overshootSecs, 7200);
  assert.equal(body.parentDueAt, new Date(PARENT_MS).toISOString());
});

/* ── The raise ────────────────────────────────────────────────────────────── */

test("raising moves the project by exactly the overshoot", () => {
  assert.equal(
    raisedParentDueAt({ parent: PARENT, overshootSecs: 7200 }),
    new Date(PARENT_MS + 7200_000).toISOString(),
  );
});

test("after a raise the child no longer breaches", () => {
  /**
   * The property that matters: granting and raising together must LEAVE the
   * rule satisfied. A raise that landed a second short would re-breach the cap
   * the moment anything re-checked it.
   */
  const grantedMs = at("2026-08-21T14:30:00.000");
  const { overshootSecs } = capBreach({ grantedMs, parentDueAtMs: PARENT_MS });
  const raisedMs = Date.parse(raisedParentDueAt({ parent: PARENT, overshootSecs }));
  assert.equal(
    capBreach({ grantedMs, parentDueAtMs: raisedMs }).breached,
    false,
    "the child still breaches its project after the raise",
  );
});

test("a second extension is judged against the RAISED project deadline", () => {
  /* Not against the original — otherwise every later extension would be
     measured against a date that no longer exists. */
  const first = at("2026-08-21T11:00:00.000");
  const raisedMs = Date.parse(
    raisedParentDueAt({
      parent: PARENT,
      overshootSecs: capBreach({ grantedMs: first, parentDueAtMs: PARENT_MS }).overshootSecs,
    }),
  );
  /* Now due 21 Aug 11:00. An extension to 21 Aug 10:00 fits; to 22 Aug does not. */
  assert.equal(
    capBreach({ grantedMs: at("2026-08-21T10:00:00.000"), parentDueAtMs: raisedMs }).breached,
    false,
  );
  assert.equal(
    capBreach({ grantedMs: at("2026-08-22T10:00:00.000"), parentDueAtMs: raisedMs }).breached,
    true,
  );
});

/* ── The route applies it, and applies it atomically ──────────────────────── */

test("the extension route refuses a breach and raises only on request", () => {
  const src = fs
    .readFileSync(require.resolve("../routes/task_routes/taskForward.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const at0 = src.indexOf('router.post("/task/:taskId/review-deadline-extension"');
  assert.ok(at0 > 0, "the review-deadline-extension route is gone");
  const fn = src.slice(at0, src.indexOf("router.", at0 + 50));

  assert.match(fn, /capBreach\(\{/);
  assert.match(fn, /if \(!req\.body\.raiseParent\)/);
  assert.match(fn, /capRefusalBody\(\{ parent: parentInfo, overshootSecs \}\)/);
  assert.match(fn, /status\(409\)/);
});

test("a rejection is never blocked by the cap", () => {
  /* Refusing an extension cannot breach a deadline, and a cap that blocked a
     rejection would trap a subtask nobody could say no to. */
  const src = fs
    .readFileSync(require.resolve("../routes/task_routes/taskForward.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(
    src,
    /const granted = action === "approve" \|\| action === "counter";/,
  );
  assert.match(src, /granted \? await readParentDeadline\(task\) : null/);
});

test("the child and the project move in ONE batch", () => {
  /**
   * Writing the child first and failing on the project would leave exactly the
   * state this rule forbids — a subtask due after its project — with nothing on
   * screen to say it had happened.
   */
  const src = fs
    .readFileSync(require.resolve("../routes/task_routes/taskForward.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const at0 = src.indexOf("if (breach.breached)");
  const fn = src.slice(at0, at0 + 1400);
  assert.match(fn, /const batch = db\.batch\(\)/);
  assert.match(fn, /batch\.update\(taskRef, update\)/);
  assert.match(fn, /batch\.update\(db\.collection\("cowork_tasks"\)\.doc\(parentInfo\.taskId\)/);
  assert.match(fn, /await batch\.commit\(\)/);
  assert.equal(
    /await taskRef\.update\(update\);[\s\S]{0,120}batch/.test(fn),
    false,
    "the child is written before the batch — a partial failure would break the cap",
  );
});

test("the raise writes to the field the parent is actually read from", () => {
  /* `hasTimer === false` puts a parent's deadline in `fixedDeadline`; writing
     `dueDate` there would raise a field nothing reads and leave the cap in
     place. */
  const src = fs.readFileSync(
    require.resolve("./parentDeadlineCap.service.js"),
    "utf8",
  );
  assert.match(src, /field: p\.hasTimer === false \? "fixedDeadline" : "dueDate"/);
  assert.match(
    src,
    /readMs\(p\.fixedDeadline\) \?\? readMs\(p\.deadline\) \?\? readMs\(p\.dueDate\)/,
  );
});
