// test/merchandising/demo-sales-consistency.test.js
//
// THE SHOWCASE ORDER MUST BE AN ORDER THAT MAKES SENSE.
//
// The complete-order demo used to state printing as NOT_REQUIRED and carry a PRINT
// development row anyway, with a note explaining that it had been kept deliberately
// despite Sales saying no. That note described the test setup, not a business
// reason — and a showcase order whose two records contradict each other teaches
// whoever reads it that the contradiction is normal.
//
// The garment story is unambiguous ("no print on this style; the care instruction is
// woven, not printed"), so the row is gone rather than excused. Conflict handling is
// proved in `sales-process-intake.route.test.js`, where a test can set up the
// conflict on purpose and nobody mistakes it for the happy path.
//
// ── WHY THIS SUITE READS SOURCE AND TOUCHES NO DATABASE ─────────────────────
// `demo-complete-file.test.js` runs the whole seed and asserts on the result, which
// is the stronger proof and the right home for it — it holds two runtime checks of
// exactly this (the Sales-sourced rows, and `reconcile()` returning no conflict).
// But the seed also depends on the Time & Action milestone library and template
// contract, which Lane A is actively changing; while that is in flight the seed
// cannot complete, and this claim should not be unprovable in the meantime.
"use strict";

const fs = require("fs");
const path = require("path");

const SEED = path.join(__dirname, "..", "..", "scripts", "demo", "merchandising-demo-complete-file.js");
const src = fs.readFileSync(SEED, "utf8");

/* Comments explain the reasoning at length, so they are stripped before any sweep —
   a test that searched them would fail on its own explanation. */
const bare = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

test("Sales states printing as not required on this garment", () => {
  expect(bare).toMatch(/process: "PRINTING", otherLabel: "", requirement: "NOT_REQUIRED"/);
  expect(bare).toMatch(/care instruction is woven, not printed/);
});

test("and the order therefore contains no print work at all", () => {
  /* The contradiction, by name. */
  expect(bare).not.toMatch(/requirementType: "PRINT"/);
  expect(bare).not.toMatch(/PRN-01/);
});

test("no row explains away a disagreement with Sales", () => {
  /* The note that used to make the seed pass. It described the test setup rather
     than a business reason, which is the thing a demo must never do. */
  for (const excuse of [
    /kept deliberately/i,
    /despite Sales/i,
    /against Sales'/i,
    /not required on this style/i,
  ]) {
    expect(bare).not.toMatch(excuse);
  }
});

test("the buyer's REQUIRED processes come through the real proposal and adoption flow", () => {
  /* Not typed as rows. The seed asks the server what this order's accepted Sales
     version implies, then adopts the suggestions with a responsible team and a due
     date — the two answers nothing invents. So the rows carry a genuine Sales
     source reference, which a hand-typed row could never have. */
  expect(bare).toMatch(/salesProcessIntake\.service/);
  expect(bare).toMatch(/intake\.suggest\(ctx, \{ fileId \}\)/);
  expect(bare).toMatch(/intake\.adopt\(ctx, \{/);
  expect(bare).toMatch(/suggestionRef: embroidery\.suggestionRef/);
  expect(bare).toMatch(/suggestionRef: wash\.suggestionRef/);

  /* Both decisions supply what the server refuses to guess. */
  const adoption = bare.slice(bare.indexOf("intake.adopt(ctx, {"), bare.indexOf("if (adopted.added.length"));
  expect((adoption.match(/responsibleApplication:/g) || []).length).toBe(2);
  expect((adoption.match(/requiredByDate:/g) || []).length).toBe(2);
});

test("and it fails loudly rather than falling back to typing them", () => {
  /* If the proposal stops working the demo must break on it. A silent fallback to
     hand-written rows is how the demo came to look complete while the workflow
     underneath it could not produce the same state. */
  expect(bare).toMatch(/did not produce the expected embroidery and wash suggestions/);
  expect(bare).toMatch(/adoption added \$\{adopted\.added\.length\} of the 2/);
});

test("the rows that remain are the ones Sales does not imply", () => {
  /* Merchandising's own judgement about what this order needs: the PP sample, the
     artwork approval, the test package. They are typed, and they show as "Added by
     Merchandising" on the screen for exactly that reason. */
  for (const own of ["PRE_PRODUCTION_SAMPLE", "ARTWORK", "OTHER"]) {
    expect(bare).toMatch(new RegExp(`requirementType: "${own}"`));
  }
  /* And neither of the two that Sales DOES imply is typed as a row. */
  const typedRows = bare.slice(bare.indexOf('await addRows("DEVELOPMENT"'));
  expect(typedRows).not.toMatch(/requirementType: "EMBROIDERY"/);
  expect(typedRows).not.toMatch(/requirementType: "WASH"/);
});

test("the seed still reports any step that did not complete", () => {
  /* The property that surfaced all of this: a step that fails records a note, and
     the demo test refuses a seed that produced one. Without it the demo swallowed a
     failed pack submission and presented the file as complete. */
  expect(bare).toMatch(/notes/);
});
