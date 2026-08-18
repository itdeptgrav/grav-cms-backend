const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

/**
 * A new task takes the NEXT slot in its assignee's queue — including when the
 * previous task is still at the department gate.
 *
 * A gated cross-department task holds its person in `pendingAssigneeId` with
 * EMPTY `assigneeIds`, so counting by `array-contains` alone cannot see it.
 * That blindness stored two live tasks at the same rank — T023 and T024 both
 * held 3 — and rank order is what the deadline chain is laid out in.
 */
test("the rank count sees gated tasks (pendingAssigneeId), not only attached ones", () => {
  const src = readFileSync(join(__dirname, "taskForward.service.js"), "utf8");
  const fn = src.slice(src.indexOf("async function nextActiveRankFor"), src.indexOf("async function assigneePrioritiesFor"));
  assert.ok(fn.length > 0, "nextActiveRankFor anchor drifted");
  assert.match(fn, /array-contains/, "the attached-tasks read is gone");
  assert.match(fn, /pendingAssigneeId/, "the gated-tasks read is gone — duplicate ranks return");
  assert.match(fn, /docs\.set\(d\.id, d\)/, "the two reads are no longer de-duplicated by id");
});
