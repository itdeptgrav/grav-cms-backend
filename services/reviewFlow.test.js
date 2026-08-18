const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

/**
 * One step: the assigner of record reviews, and their approval is FINAL.
 * OWNER DECISION, 16 Aug 2026.
 *
 * The old model escalated by role string — an "employee" assigner's approval
 * was stage 1 of 2 and credited nothing, while a "tl" assigner's identical
 * approval completed the task. T053 is the reported case: approved by its
 * assigner at 15:13, scored null, because his stored role read "employee".
 *
 * Source-pinned because `taskForward.service.js` reaches Firestore at require
 * time and cannot be imported here.
 */

const src = fs
  .readFileSync(require.resolve("./taskForward.service.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

test("the flow derivation never returns the two-stage chain", () => {
  const at = src.indexOf("async function _reviewFlow(");
  assert.ok(at > 0, "_reviewFlow is gone");
  const fn = src.slice(at, src.indexOf("async function submitCompletionRequest("));
  assert.equal(
    /return "tl_then_ceo"/.test(fn),
    false,
    "the derivation produces tl_then_ceo again — an employee-role assigner's approval will stop crediting",
  );
  /* The CEO's own direct task keeps its record in `ceoReview`. */
  assert.match(fn, /return "ceo_direct"/);
  assert.match(fn, /return "tl_final"/);
});

test("a submission stamped tl_then_ceo before the change is decided as FINAL", () => {
  /* The stored flow wins at review time, so without this mapping every
     pre-change pending submission would still route into a stage nobody
     completes. */
  assert.match(
    src,
    /task\.reviewFlow === "tl_then_ceo" \? "tl_final" : task\.reviewFlow/,
  );
});

test("scoring still fires only on the final statuses", () => {
  /* Unchanged and load-bearing: with every flow now final in one step, the
     assigner's approval maps straight onto these. */
  assert.match(
    src,
    /\["tl_final_approved", "ceo_approved"\]\.includes\(c1FinalStatus\)/,
  );
});
