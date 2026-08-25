const test = require("node:test");
const assert = require("node:assert/strict");
const { canonicalNextAction, nextFollowUpAt, secondaryOpenItems, openItems } = require("./leadNextAction");

let seq = 0;
const fu = (due, o = {}) => ({
  _id: o.id || `a${++seq}`, activityType: "follow_up", status: "planned", isActive: true,
  dueDate: due, createdAt: o.createdAt || "2026-01-01T00:00:00Z", ...o,
});
const task = (due, o = {}) => fu(due, { ...o, activityType: "task" });

/* ── The headline ────────────────────────────────────────────────────────── */

test("the earliest-due open follow-up is the next action", () => {
  const c = canonicalNextAction([fu("2026-09-10"), fu("2026-08-25", { id: "early" }), fu("2026-09-01")]);
  assert.equal(c._id, "early");
});

test("a tie on due date breaks on creation order, so the choice is stable", () => {
  const c = canonicalNextAction([
    fu("2026-08-25", { id: "later", createdAt: "2026-02-01" }),
    fu("2026-08-25", { id: "first", createdAt: "2026-01-01" }),
  ]);
  assert.equal(c._id, "first");
});

test("completed and cancelled items are history, never the next action", () => {
  const c = canonicalNextAction([
    fu("2026-08-01", { id: "done", status: "completed" }),
    fu("2026-08-02", { id: "gone", status: "cancelled" }),
    fu("2026-09-01", { id: "live" }),
  ]);
  assert.equal(c._id, "live");
});

test("an archived item is not open either", () => {
  assert.equal(canonicalNextAction([fu("2026-08-01", { isActive: false })]), null);
});

test("an internal task is NOT the next action — only a follow-up is a customer touch", () => {
  // Otherwise "prepare the costing sheet" would silently redefine when the
  // Leads page thinks this customer is next due.
  const c = canonicalNextAction([task("2026-08-01", { id: "internal" }), fu("2026-09-01", { id: "touch" })]);
  assert.equal(c._id, "touch");
});

test("a lead holding only internal tasks has no next action", () => {
  assert.equal(canonicalNextAction([task("2026-08-01")]), null);
});

test("nothing open at all is null, not a throw", () => {
  assert.equal(canonicalNextAction([]), null);
  assert.equal(canonicalNextAction(), null);
  assert.equal(canonicalNextAction(null), null);
});

test("an undated follow-up cannot be the next action", () => {
  // It is still a real intention and is kept (see secondaryOpenItems), but it
  // cannot answer "when".
  assert.equal(canonicalNextAction([fu(null)]), null);
  assert.equal(canonicalNextAction([fu(undefined), fu("2026-09-01", { id: "dated" })])._id, "dated");
});

test("an unparseable date is treated as undated rather than sorting first", () => {
  assert.equal(canonicalNextAction([fu("not a date"), fu("2026-09-01", { id: "real" })])._id, "real");
});

/* ── The date the Leads page bands on ────────────────────────────────────── */

test("nextFollowUpAt is the canonical item's due date", () => {
  assert.equal(nextFollowUpAt([fu("2026-09-10"), fu("2026-08-25")]).toISOString(), new Date("2026-08-25").toISOString());
});

test("nextFollowUpAt CLEARS when nothing is due — no stale date left claiming otherwise", () => {
  assert.equal(nextFollowUpAt([]), null);
  assert.equal(nextFollowUpAt([task("2026-08-01")]), null);
  assert.equal(nextFollowUpAt([fu("2026-08-01", { status: "completed" })]), null);
});

test("adding an EARLIER follow-up moves the date forward", () => {
  const before = [fu("2026-09-10")];
  const after = [...before, fu("2026-08-25")];
  assert.equal(nextFollowUpAt(after).toISOString(), new Date("2026-08-25").toISOString());
});

test("completing the canonical one falls back to the next, it does not clear", () => {
  // The old route set nextFollowUpAt to whatever was just typed. With several
  // open items that is wrong — the date has to be recomputed from what remains.
  const after = [fu("2026-08-25", { status: "completed" }), fu("2026-09-10", { id: "rest" })];
  assert.equal(nextFollowUpAt(after).toISOString(), new Date("2026-09-10").toISOString());
});

/* ── Everything that is NOT the headline still exists ────────────────────── */

test("the other open items are kept, not cancelled", () => {
  // This is the whole point: planning a second move used to destroy the first.
  const items = [fu("2026-08-25", { id: "head" }), fu("2026-09-01", { id: "second" }), task("2026-09-05", { id: "chore" })];
  const rest = secondaryOpenItems(items).map((a) => a._id);
  assert.deepEqual(rest, ["second", "chore"]);
});

test("secondary items come back in the order they should be worked", () => {
  const rest = secondaryOpenItems([fu("2026-08-25", { id: "head" }), fu("2026-10-01", { id: "c" }), fu("2026-09-01", { id: "b" })]);
  assert.deepEqual(rest.map((a) => a._id), ["b", "c"]);
});

test("an undated item is listed last but never dropped", () => {
  const rest = secondaryOpenItems([fu("2026-08-25", { id: "head" }), fu(null, { id: "someday" }), fu("2026-09-01", { id: "b" })]);
  assert.deepEqual(rest.map((a) => a._id), ["b", "someday"]);
});

test("with no canonical item every open item is secondary", () => {
  assert.equal(secondaryOpenItems([task("2026-08-01"), task("2026-08-02")]).length, 2);
});

test("openItems excludes history and sorts, so callers never re-derive it", () => {
  const o = openItems([fu("2026-09-01", { id: "b" }), fu("2026-08-01", { id: "a" }), fu("2026-07-01", { status: "completed" })]);
  assert.deepEqual(o.map((x) => x._id), ["a", "b"]);
});
