const assert = require("node:assert/strict");
const { test } = require("node:test");

const svc = require("./budgetNegotiation.service");

/**
 * Whose decision is an assignee's request for more hours?
 *
 * **Their manager's, not the sender's.** Hours are a management decision about
 * a person, so the question follows the reporting line — the rule the set-hours
 * path and the budget-extension records already applied. This loop was the last
 * place still passing the turn to `assignedBy`, which on a cross-department task
 * put it to somebody in another department with no standing to answer it.
 */

const TASK = { assignedBy: "GR0002", assigneeIds: ["GR0099"] };
const MANAGER = "GR0000";

test("the manager may act on the turn handed to them", () => {
  /**
   * **The deadlock this guards.** `roleOf` is checked before the turn is, and
   * it knew only two parties. Routing the turn to a manager without admitting
   * them here would name them on screen as the person to decide and then refuse
   * them with NOT_A_PARTY — a turn nobody in the world could clear.
   */
  assert.equal(svc.roleOf(TASK, MANAGER, MANAGER), "approver");
  assert.equal(
    svc.roleOf(TASK, MANAGER),
    null,
    "a manager is admitted without being resolved as the approver",
  );
});

test("the two original parties are unchanged", () => {
  assert.equal(svc.roleOf(TASK, "GR0099", MANAGER), "assignee");
  assert.equal(svc.roleOf(TASK, "GR0002", MANAGER), "assignor");
  assert.equal(svc.roleOf(TASK, "GR0077", MANAGER), null, "a stranger got in");
});

test("holding two roles keeps the stronger one", () => {
  /* A manager who is also doing the work is the assignee; one who also sent it
     is the assignor. Either way the approver branch must not shadow a role that
     already carries a turn of its own. */
  assert.equal(svc.roleOf(TASK, "GR0099", "GR0099"), "assignee");
  assert.equal(svc.roleOf(TASK, "GR0002", "GR0002"), "assignor");
});

test("an unreachable HR falls back to the assignor, never to nobody", async () => {
  /**
   * `resolvePrimaryManagerApprover` answers null when HR has no manager
   * recorded, when the manager has no CoWork account, and — because its require
   * sits inside its own try — when HR cannot be reached at all. This test runs
   * without credentials, so it takes that last path for real.
   *
   * The fallback is the point: a null approver would write `waitingFor: null`,
   * and a negotiation waiting on nobody is one no move can ever clear.
   */
  const approver = await svc.budgetApproverOf(TASK);
  assert.equal(approver.id, "GR0002");
  assert.equal(approver.viaManager, false);
  assert.notEqual(approver.id, null, "the turn would be owned by nobody");
});

test("a task with no assignee still resolves an owner", async () => {
  const approver = await svc.budgetApproverOf({ assignedBy: "GR0002", assigneeIds: [] });
  assert.equal(approver.id, "GR0002");
});

test("the counter passes an assignee's turn to the approver, not the assignor", () => {
  /**
   * The routing itself, pinned at the line that does it. `waitingFor` is the
   * whole permission model — the frontend reads the same field to decide who is
   * shown the buttons — so an edit here changes who decides an employee's hours
   * across the product, and should have to be deliberate.
   */
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "budgetNegotiation.service.js"),
    "utf8",
  );
  assert.match(
    src,
    /const waitingFor = role === "assignee" \? approverId : assignee;/,
    "an assignee's counter no longer waits on their manager",
  );
  assert.equal(
    /const waitingFor = role === "assignee" \? assignor : assignee;/.test(src),
    false,
    "the turn is being passed back to the sender again",
  );
});

test("the stored state literals are not renamed", () => {
  /**
   * `WAITING_FOR_ASSIGNOR` now means "waiting for the side that decides", which
   * is usually the manager rather than the assignor. The NAME stays wrong on
   * purpose: it is persisted in `budgetNegotiation.state` on every task in
   * flight, and renaming it would strand every one of them mid-negotiation.
   */
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "budgetNegotiation.service.js"),
    "utf8",
  );
  assert.match(src, /const WAITING_FOR_ASSIGNOR = "WAITING_FOR_ASSIGNOR";/);
  assert.match(src, /const WAITING_FOR_ASSIGNEE = "WAITING_FOR_ASSIGNEE";/);
});

/* ── A subtask may not outlive its project ────────────────────────────────── */

test("acceptance caps the deadline at the project's, and records that it did", () => {
  /**
   * OWNER DECISION, 16 Aug 2026. The create form warns on a PROJECTION —
   * inside a reporting line the deadline does not exist until acceptance, and
   * it is anchored to when the assignee first came online, so a budget that
   * looked safe when it was set can land past the parent by the time it is
   * taken. This is the check that actually guarantees the rule.
   *
   * Clamped rather than refused: the assignee did not choose the budget, and
   * refusing their acceptance would strand them with a task they cannot take.
   */
  const src = require("node:fs")
    .readFileSync(require.resolve("./budgetNegotiation.service.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  assert.match(src, /async function readParentDeadlineMs\(/);
  /* The parent is read BEFORE the transaction — a transaction must finish its
     reads before its first write. Scoped to `acceptBudgetProposal`, because
     other functions in this file open transactions of their own earlier. */
  const fnAt = src.indexOf("async function acceptBudgetProposal(");
  assert.ok(fnAt > 0, "acceptBudgetProposal is gone");
  const fn = src.slice(fnAt);
  const readAt = fn.indexOf("readParentDeadlineMs(preSnap.data())");
  const txAt = fn.indexOf("runTransaction");
  assert.ok(readAt > 0, "the parent deadline is never read on the accept path");
  assert.ok(
    readAt < txAt,
    "the parent is read inside the transaction — that write would fail",
  );
  assert.match(src, /Date\.parse\(earned\) > parentDueAtMs/);
  assert.match(src, /deadlineCappedToParent: cappedMs !== null/);
});

test("the parent deadline is read in the same precedence the frontend uses", () => {
  /* Reading them in a different order would let the engine cap against one
     date while the page displays another. */
  const src = require("node:fs").readFileSync(
    require.resolve("./budgetNegotiation.service.js"),
    "utf8",
  );
  assert.match(
    src,
    /readMs\(p\.fixedDeadline\) \?\? readMs\(p\.deadline\) \?\? readMs\(p\.dueDate\)/,
  );
});

test("a missing parent deadline caps nothing", () => {
  /* Null for an ordinary task, an unreadable parent, or a parent with no date.
     All three mean "no ceiling" — a missing figure must never shorten
     somebody's deadline. */
  const src = require("node:fs")
    .readFileSync(require.resolve("./budgetNegotiation.service.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(src, /if \(!parentId\) return null;/);
  assert.match(src, /parentDueAtMs !== null && Date\.parse\(earned\) > parentDueAtMs/);
});
