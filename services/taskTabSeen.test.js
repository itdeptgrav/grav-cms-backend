const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
/* Source-pinned: the route requires firebaseAdmin at load, which needs env
   the test runner does not provide. Same pattern as the sibling tests. */

/**
 * **What is new on each tab, and when this person last looked.**
 * OWNER DECISION, 17 Aug 2026 — stored on the SERVER, and generic.
 */

const src = fs.readFileSync(
  require.resolve("../routes/task_routes/taskTabSeen.routes.js"),
  "utf8",
);

test("the mark is per person, per task, per tab", () => {
  /* A shared key would let one person's reading clear everybody's badge. */
  assert.match(src, /const seenId = \(employeeId, taskId, tabId\) =>/);
  /* All three parts in the key. Drop any one of them and somebody else's
     reading clears your badge. */
  assert.match(src, /employeeId\}__\$\{taskId\}__\$\{tabId\}/);
});

test("marking twice overwrites rather than accumulating", () => {
  /* The id is deterministic and the write is a `set` — opening a tab fifty
     times must leave one document, not fifty. */
  assert.match(src, /\.doc\(seenId\(employeeId, taskId, tabId\)\)/);
  assert.match(src, /\.set\(/);
});

test("an unknown tab id is refused, not stored", () => {
  /* An unbounded key would let a typo create documents for ever. */
  assert.match(src, /KNOWN_TABS\.includes\(tabId\)/);
  const list = src.slice(src.indexOf("const KNOWN_TABS"), src.indexOf("];", src.indexOf("const KNOWN_TABS")));
  for (const t of ["chat", "review", "submission", "meetings"]) {
    assert.ok(list.includes(`"${t}"`), `${t} cannot be marked read`);
  }
});

test("the response is keyed by tab id, so a new tab needs no client change", () => {
  /* The whole point of the shape: the frontend rule names no tab, so a tab
     added later gets a badge from the engine reporting activity for it. */
  assert.match(src, /return res\.json\(\{ taskId, activity, seen \}\)/);
  assert.match(src, /out\.chat = /);
  assert.match(src, /out\.review = /);
  assert.match(src, /out\.submission = /);
  assert.match(src, /out\.meetings = /);
});

test("a viewer only ever reads their own marks", () => {
  assert.match(src, /where\("employeeId", "==", employeeId\)/);
  assert.match(src, /where\("taskId", "==", taskId\)/);
});

test("an unreadable subcollection costs one badge, never the response", () => {
  /* A chat read that throws must not blank the whole tab bar. */
  const chat = src.slice(src.indexOf("/* ── chat"), src.indexOf("/* ── submission"));
  assert.match(chat, /catch \(e\)/);
  assert.match(chat, /out\.chat = \{ lastAt: null, items: \[\] \}/);
});

test("events carry who caused them, where the engine knows", () => {
  /* The frontend excludes the viewer's own doing, and cannot without this. */
  assert.match(src, /by: m\.senderId \|\| null/);
  assert.match(src, /by: task\.completionSubmission\?\.submittedBy \|\| null/);
  assert.match(src, /by: r\.reviewedBy \|\| null/);
});

test("the viewer comes from the field the middleware actually sets", () => {
  /**
   * **Reported 17 Aug 2026: no badge ever appeared.** This read
   * `req.employee?.employeeId`, and `verifyCoworkToken` sets `req.coworkUser`
   * and nothing else — so the id was undefined on every request, marking a tab
   * read answered 401 every time, and no badge could ever clear.
   */
  assert.match(src, /req\.coworkUser\?\.employeeId/);
  assert.equal(
    /req\.employee\?\.|req\.employeeId\b/.test(src),
    false,
    "reading a field the middleware does not set — the viewer will be empty again",
  );
  /* And the helper must not call itself: a careless rewrite made it
     `const viewerOf = (req) => viewerOf(req)`, which recurses until the stack
     dies on the first request. */
  assert.equal(
    /const viewerOf = \(req\) => viewerOf\(req\)/.test(src),
    false,
    "viewerOf recurses into itself",
  );
});

test("task chat notifies everyone the task is between", () => {
  /**
   * **Reported 17 Aug 2026: no push on task chat.** The recipients were
   * `assigneeIds` minus the sender. On an ordinary one-assignee task, a
   * message FROM the assignee left that list empty — so nobody was told, and
   * the manager waiting for the reply never heard it.
   */
  const fwd = fs.readFileSync(
    require.resolve("./taskForward.service.js"),
    "utf8",
  );
  const at = fwd.indexOf('type: "task_chat"');
  assert.ok(at > 0, "the task-chat notification is gone");
  const block = fwd.slice(at - 1400, at);
  for (const who of ["assigneeIds", "assignedBy", "pendingAssigneeId"]) {
    assert.ok(block.includes(who), `${who} is no longer told about a message`);
  }
  /* The sender never gets a push for their own message. */
  assert.match(block, /id !== senderId/);
  /* Deduplicated: somebody who is both assignor and forwarder gets one push. */
  assert.match(block, /new Set\(/);
});
