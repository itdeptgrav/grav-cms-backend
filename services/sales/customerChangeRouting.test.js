// services/sales/customerChangeRouting.test.js
//
// Where a customer's rejection goes, and what that costs. The rule these
// tests exist for is the dependency chain — Brief → Materials/BOM → Tech Sheet
// → Sample Round — and the consequence of getting it wrong: a tech sheet
// revised against a BOM that is itself being replaced, or a second sample sewn
// in the same fabric the customer just rejected.
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const routing = require("./customerChangeRouting.service");

/* ── EACH CATEGORY GOES WHERE IT BELONGS ────────────────────────────────── */

test("each change category maps to its own destination", () => {
  assert.equal(routing.destinationFor(["MATERIALS_BOM"]), "MATERIALS_BOM");
  assert.equal(routing.destinationFor(["TECH_SHEET"]), "TECH_SHEET");
  assert.equal(routing.destinationFor(["SAMPLE_ROUND"]), "SAMPLE_ROUND");
  assert.equal(routing.destinationFor(["BRIEF_NEW_VERSION"]), "BRIEF_NEW_VERSION");
});

test("nothing named routes nowhere", () => {
  assert.equal(routing.destinationFor([]), null);
  assert.equal(routing.destinationFor(undefined), null);
  assert.equal(routing.destinationFor(["NOT_A_CATEGORY"]), null);
});

test("each destination names the department that owns it", () => {
  assert.equal(routing.ownerFor("MATERIALS_BOM"), "merchandiser");
  assert.equal(routing.ownerFor("TECH_SHEET"), "research-development");
  assert.equal(routing.ownerFor("SAMPLE_ROUND"), "research-development");
  assert.equal(routing.ownerFor("BRIEF_NEW_VERSION"), "sales");
});

/* ── SEVERAL CATEGORIES MEAN THE EARLIEST LINK, NOT SEVERAL JOBS ────────── */

test("a material change plus a construction change goes to materials first", () => {
  // The collar is patterned against a fabric that is about to change.
  assert.equal(routing.destinationFor(["TECH_SHEET", "MATERIALS_BOM"]), "MATERIALS_BOM");
  assert.equal(routing.destinationFor(["MATERIALS_BOM", "TECH_SHEET"]), "MATERIALS_BOM");
});

test("stitching plus construction goes to the tech sheet, not another sample", () => {
  assert.equal(routing.destinationFor(["SAMPLE_ROUND", "TECH_SHEET"]), "TECH_SHEET");
});

test("a concept change outranks everything", () => {
  assert.equal(
    routing.destinationFor(["SAMPLE_ROUND", "TECH_SHEET", "MATERIALS_BOM", "BRIEF_NEW_VERSION"]),
    "BRIEF_NEW_VERSION",
  );
});

test("the order they were ticked in does not matter", () => {
  const all = ["SAMPLE_ROUND", "MATERIALS_BOM", "TECH_SHEET"];
  const reversed = [...all].reverse();
  assert.equal(routing.destinationFor(all), routing.destinationFor(reversed));
  assert.equal(routing.destinationFor(all), "MATERIALS_BOM");
});

test("categories are stored in dependency order, de-duplicated", () => {
  assert.deepEqual(
    routing.normaliseCategories(["SAMPLE_ROUND", "MATERIALS_BOM", "SAMPLE_ROUND", "junk"]),
    ["MATERIALS_BOM", "SAMPLE_ROUND"],
  );
});

/* ── A PERSON MAY OVERRIDE UPSTREAM, NEVER DOWNSTREAM ───────────────────── */

test("the suggested destination is always accepted", () => {
  for (const cat of ["MATERIALS_BOM", "TECH_SHEET", "SAMPLE_ROUND", "BRIEF_NEW_VERSION"]) {
    const v = routing.validateDestination(routing.destinationFor([cat]), [cat]);
    assert.equal(v.ok, true, cat);
  }
});

test("routing further upstream than suggested is allowed", () => {
  // Somebody who knows the fabric is also wrong may take a fit complaint to
  // Materials. That only does MORE work, never less.
  assert.equal(routing.validateDestination("MATERIALS_BOM", ["TECH_SHEET"]).ok, true);
  assert.equal(routing.validateDestination("BRIEF_NEW_VERSION", ["SAMPLE_ROUND"]).ok, true);
});

test("routing downstream of the suggestion is refused, with the reason", () => {
  const v = routing.validateDestination("SAMPLE_ROUND", ["MATERIALS_BOM"]);
  assert.equal(v.ok, false);
  assert.equal(v.code, "DESTINATION_TOO_LATE");
  assert.equal(v.suggested, "MATERIALS_BOM");
  assert.match(v.message, /Materials \/ BOM/);
});

test("an unknown destination is refused", () => {
  assert.equal(routing.validateDestination("SOMEWHERE_ELSE", ["TECH_SHEET"]).code, "DESTINATION_UNKNOWN");
});

test("a destination with no category named is refused", () => {
  assert.equal(routing.validateDestination("TECH_SHEET", []).code, "CATEGORY_REQUIRED");
});

/* ── WHAT EACH ROUTE REOPENS, AND WHAT IT KEEPS ─────────────────────────── */

test("materials reopens the BOM and asks everything downstream again", () => {
  const plan = routing.invalidationFor("MATERIALS_BOM");
  assert.deepEqual(plan.reopen, ["materials", "bomApproval"]);
  assert.deepEqual(plan.revalidate, ["techSheet", "sample", "customerApproval"]);
  assert.equal(plan.stage, "materials");
});

test("a tech-sheet change keeps the approved BOM", () => {
  const plan = routing.invalidationFor("TECH_SHEET");
  assert.deepEqual(plan.reopen, ["techSheet"]);
  assert.equal(plan.revalidate.includes("sample"), true);
  assert.equal(plan.reopen.includes("materials"), false, "the BOM stays approved");
  assert.match(plan.preserve.join(" "), /approved BOM/);
});

test("a new sample round keeps the BOM and the tech sheet", () => {
  const plan = routing.invalidationFor("SAMPLE_ROUND");
  assert.deepEqual(plan.reopen, ["sample"]);
  // Only the customer's approval is asked again.
  assert.deepEqual(plan.revalidate, ["customerApproval"]);
  assert.match(plan.preserve.join(" "), /approved tech sheet/);
});

test("a new product version invalidates nothing on the rejected one", () => {
  const plan = routing.invalidationFor("BRIEF_NEW_VERSION");
  assert.deepEqual(plan.revalidate, []);
  assert.match(plan.preserve.join(" "), /whole history/);
});

test("every route states what it keeps, and keeps the customer's own record", () => {
  /* The property that matters is not the absence of a word — the Brief route's
     summary says "nothing is deleted", which is the promise, not a violation.
     It is that each route names preserved history, and that no route reopens
     the append-only records a decision was made on. */
  const APPEND_ONLY = ["history", "customerApproval.log", "rounds"];
  for (const code of routing.CHANGE_DESTINATION_CODES) {
    const plan = routing.invalidationFor(code);
    assert.ok(plan.preserve.length > 0, `${code} must say what it keeps`);
    for (const untouchable of APPEND_ONLY) {
      assert.equal(plan.reopen.includes(untouchable), false, `${code} must not reopen ${untouchable}`);
    }
  }
  // And the one route that replaces a product keeps the rejected one whole.
  assert.match(routing.invalidationFor("BRIEF_NEW_VERSION").preserve.join(" "), /rejected product and its whole history/);
});

/* ── AN OPEN CHANGE BLOCKS THE COMMERCIAL STAGE ─────────────────────────── */

test("an open or in-progress change blocks the product", () => {
  assert.equal(routing.blocksCommercial({ status: "OPEN" }), true);
  assert.equal(routing.blocksCommercial({ status: "IN_PROGRESS" }), true);
});

test("a settled change stops blocking", () => {
  for (const status of ["RESOLVED", "SUPERSEDED", "CANCELLED"]) {
    assert.equal(routing.blocksCommercial({ status }), false, status);
  }
  assert.equal(routing.blocksCommercial(null), false);
});

/* ── THE TIMELINE LINE ───────────────────────────────────────────────────── */

test("a routed change reads as what changed and who has it", () => {
  const line = routing.summarise({
    categories: ["MATERIALS_BOM", "TECH_SHEET"],
    destination: "MATERIALS_BOM",
  });
  assert.equal(line, "Materials, Technical specification → Materials / BOM");
});

test("the vocabulary is the contract", () => {
  assert.deepEqual(routing.CHANGE_CATEGORY_CODES, [
    "MATERIALS_BOM", "TECH_SHEET", "SAMPLE_ROUND", "BRIEF_NEW_VERSION",
  ]);
  // Destinations are declared in dependency order — that order IS the rule.
  assert.deepEqual(routing.CHANGE_DESTINATION_CODES, [
    "BRIEF_NEW_VERSION", "MATERIALS_BOM", "TECH_SHEET", "SAMPLE_ROUND",
  ]);
  assert.deepEqual(routing.CHANGE_REQUEST_STATUSES, [
    "OPEN", "IN_PROGRESS", "RESOLVED", "SUPERSEDED", "CANCELLED",
  ]);
});
