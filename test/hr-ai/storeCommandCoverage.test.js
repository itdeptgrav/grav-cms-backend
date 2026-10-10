// test/hr-ai/storeCommandCoverage.test.js
//
// THE COVERAGE GATE, RUN AS A TEST.
//
// The audit is useful on a terminal and worthless if nobody runs it. Here it
// fails the suite instead: a Store concept added to the catalogue without a
// way to reach it from Cmd/Ctrl K stops the build rather than quietly
// becoming a question the palette cannot answer.
"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const {
  classify, EXCLUDED, HANDLERS, STORE_HANDLERS,
} = require("../../scripts/audits/store-command-search-coverage");

describe("every Store concept is reachable from the command palette", () => {
  const out = classify();

  test("every Store catalogue is counted, not just one of them", () => {
    /* ── THE DENOMINATOR IS THE AUDIT ──────────────────────────────────
       The first version read `storeSemanticContract` alone and reported
       "181 of 181". Store's concepts live in four catalogues and the real
       total is an order of magnitude larger, so that green light pointed
       at 7% of the application. */
    expect(out.total).toBeGreaterThan(2000);
    expect(Object.keys(out.byCatalogue).sort()).toEqual([
      "inventory_item", "inventory_location", "store_purchase_universal", "store_records",
    ]);
    for (const n of Object.values(out.byCatalogue)) expect(n).toBeGreaterThan(0);
  });

  test("no concept is unexplained", () => {
    expect(out.unexplained.map((r) => r.id)).toEqual([]);
  });

  test("every concept is classified exactly once", () => {
    const counted = out.direct.length + out.generic.length
      + out.excluded.length + out.unexplained.length;
    expect(counted).toBe(out.total);
  });

  test("an exclusion always carries a reason", () => {
    /* An exclusion with no reason is a concept somebody dropped. */
    for (const [key, reason] of Object.entries(EXCLUDED)) {
      expect(typeof reason).toBe("string");
      expect(reason.length).toBeGreaterThan(10);
      expect(key).toBeTruthy();
    }
  });

  test("the coverage is read from the catalogue, not a second list", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "scripts", "audits", "store-command-search-coverage.js"),
      "utf8",
    );
    expect(src).toMatch(/require\("\.\.\/\.\.\/services\/storeSemanticContract"\)/);
    /* No hand-kept inventory of "what the palette supports". */
    expect(src).not.toMatch(/const SUPPORTED = \[/);
  });
});

/* ══ AND SOMETHING OWNS EACH OF THEM ═════════════════════════════════════ */

describe("every concept is owned by a capability this person may use", () => {
  const out = classify();

  test("no concept is owned by nothing", () => {
    /* A concept in a catalogue with no capability publishing it is a word
       with no reader: the palette would resolve it and then have nowhere to
       send it. */
    expect(out.unowned.map((r) => r.id)).toEqual([]);
  });

  test("no concept is owned only outside Store & Purchase", () => {
    /* A Store-shaped concept served only by, say, an HR capability is NOT a
       Store answer, however Store-shaped its words are. */
    expect(out.foreignOnly.map((r) => r.id)).toEqual([]);
  });

  test("the owner map is read from the registry, not written down", () => {
    expect(HANDLERS.size).toBeGreaterThan(2000);
    expect(STORE_HANDLERS.size).toBe(HANDLERS.size);
    for (const row of out.rows.slice(0, 50)) {
      expect(Array.isArray(row.handlers)).toBe(true);
    }
  });
});

/* ══ WHAT SOMEBODY ACTUALLY TYPES IS A DIFFERENT AUDIT ═══════════════════ */

describe("the behavioural audit is separate, and is the one about sentences", () => {
  test("it exists, seeds records and asserts the words of the answer", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "scripts", "audits", "store-command-behaviour.js"),
      "utf8",
    );
    /* ── WHY THE OLD GATE WAS REMOVED FROM HERE ────────────────────────
         It asked whether a sentence CONTAINED a concept's alias, and read
         the answer as coverage. That can be wrong in both directions at
         once: "pending goods receipt inspections" contained one and was
         answered with every inspection, while "GRN/2026-27/0004" contained
         none and is answered correctly. Sentences are now audited by
         asking them of a seeded Store and reading the answer back, in
         `store-command-behaviour.js` and in
         `storeCommandSearch.integration.test.js`. */
    expect(src).toMatch(/seedStore/);
    expect(src).toMatch(/service\.search/);
    /* Every kind of question the brief names has a case. */
    for (const kind of [
      "exact identity", "partial identity", "a field of a named record",
      "a filter by a recorded status", "top-N", "a count", "an aggregate",
      "a relationship", "a physical location", "ambiguity",
      "permission", "cross-tenant denial",
    ]) {
      expect(src).toContain(kind);
    }
  });
});
