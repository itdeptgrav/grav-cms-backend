"use strict";
/**
 * services/itemBudgetHead.test.js
 *
 * The resolution order, and the one case that must NOT resolve.
 *
 * These are pure — no database. `categoryMap` is the only part that reads
 * Mongo, and it returns a plain Map, so every rule below is testable by
 * handing `headForItem` the map it would have built.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const svc = require("./itemBudgetHead.service");

const RAW_MATERIALS = "aaaaaaaaaaaaaaaaaaaaaaaa";
const CONSUMABLES = "bbbbbbbbbbbbbbbbbbbbbbbb";
const SAMPLING = "cccccccccccccccccccccccc";

const map = new Map([
  ["fabric", { budgetLedgerId: RAW_MATERIALS, budgetLedgerName: "PURCHASE", category: "Fabric" }],
  ["chemicals", { budgetLedgerId: CONSUMABLES, budgetLedgerName: "Consumables", category: "Chemicals" }],
]);

test("an item takes its category's head", () => {
  const r = svc.headForItem({ name: "Cotton Poplin", category: "Fabric" }, map);
  assert.equal(r.budgetLedgerId, RAW_MATERIALS);
  assert.equal(r.source, "category_mapping");
});

test("the category is matched regardless of spelling or spacing", () => {
  /* "Fabric", "fabric" and " FABRIC " are one category to everybody except a
     string comparison, and the item master contains all three shapes. */
  for (const c of ["fabric", "FABRIC", " Fabric ", "FaBrIc"]) {
    assert.equal(svc.headForItem({ category: c }, map).budgetLedgerId, RAW_MATERIALS, c);
  }
});

test("an item's own head beats its category's", () => {
  const r = svc.headForItem(
    { name: "Cotton Poplin (sampling)", category: "Fabric", budgetLedgerId: SAMPLING },
    map,
  );
  assert.equal(r.budgetLedgerId, SAMPLING);
  assert.equal(r.source, "item_override");
});

test("an unmapped category resolves to NOTHING, and says why", () => {
  /* The important one. A guessed head that fills itself in is worse than an
     empty box — nobody re-checks a field that already looks answered. */
  const r = svc.headForItem({ name: "Piping cord", category: "Piping" }, map);
  assert.equal(r.budgetLedgerId, null);
  assert.equal(r.source, "unresolved");
  assert.match(r.message, /Piping/);
});

test("an item with no category at all is a different problem, and says so", () => {
  /* Finance cannot fix this by mapping anything — it is the store's data to
     correct, and the message has to point at the right desk. */
  const r = svc.headForItem({ name: "Mystery thing" }, map);
  assert.equal(r.budgetLedgerId, null);
  assert.match(r.message, /no category/i);
});

test("a category mapped to nothing behaves as unmapped, not as a head of null", () => {
  /* `categoryMap` drops rows with no head, so "seen but not decided" reaches
     the requester as a question rather than as a silently empty budget. */
  const partial = new Map([["trims", { budgetLedgerId: null, category: "Trims" }]]);
  const r = svc.headForItem({ category: "Trims" }, partial);
  assert.equal(r.budgetLedgerId, null);
  assert.equal(r.source, "unresolved");
});

test("resolving a whole request keeps every line's own answer", () => {
  const lines = [
    { name: "Cotton", category: "Fabric" },
    { name: "Dye", category: "Chemicals" },
    { name: "Cord", category: "Piping" },
  ].map((i) => svc.headForItem(i, map));

  assert.deepEqual(
    lines.map((l) => l.source),
    ["category_mapping", "category_mapping", "unresolved"],
  );
  /* Two lines, two DIFFERENT heads on one request — the whole point of doing
     this per line rather than per request. */
  assert.notEqual(lines[0].budgetLedgerId, lines[1].budgetLedgerId);
});

test("clearing an item's override falls it back to its category", () => {
  /* Cleared means null, not "unresolved forever". An override that could not
     be undone would make the rare per-item escape hatch a one-way door. */
  const withOverride = { name: "Cotton", category: "Fabric", budgetLedgerId: SAMPLING };
  assert.equal(svc.headForItem(withOverride, map).source, "item_override");

  const cleared = { ...withOverride, budgetLedgerId: null };
  const r = svc.headForItem(cleared, map);
  assert.equal(r.source, "category_mapping");
  assert.equal(r.budgetLedgerId, RAW_MATERIALS);
});

test("an override on an item whose category is unmapped still resolves", () => {
  /* The override is checked first, so it does not depend on finance having
     mapped the category — which is the point of having it. */
  const r = svc.headForItem({ category: "Piping", budgetLedgerId: SAMPLING }, map);
  assert.equal(r.source, "item_override");
  assert.equal(r.budgetLedgerId, SAMPLING);
});

test("the result shape is the same whatever the outcome", () => {
  /* Callers store this on a request line. A key that appears only on the
     happy path becomes an `undefined` in a document. */
  const keys = (o) => Object.keys(o).sort().join(",");
  const resolved = svc.headForItem({ category: "Fabric" }, map);
  const unresolved = svc.headForItem({ category: "Nothing" }, map);
  const overridden = svc.headForItem({ category: "Fabric", budgetLedgerId: SAMPLING }, map);
  assert.equal(keys(resolved), "budgetLedgerId,budgetLedgerName,category,message,source");
  assert.equal(keys(unresolved), keys(resolved));
  assert.equal(keys(overridden), keys(resolved));
});

test("never infers from anything but the item and its category", () => {
  /* Rule 3. Vendor, free-text name and any past posting are all present on
     the object and all ignored — the only inputs are `budgetLedgerId` and
     `category`. */
  const noisy = {
    name: "VRL LOGISTICS transport charge",
    vendorName: "VRL LOGISTICS LTD",
    lastPostedLedgerId: RAW_MATERIALS,
    primaryVendor: "VRL",
    category: null,
  };
  const r = svc.headForItem(noisy, map);
  assert.equal(r.budgetLedgerId, null);
  assert.equal(r.source, "unresolved");
});

/* ── CHUNK 1.1 — ONE NORMALISATION, USED EVERYWHERE ───────────────────────── */

test("categoryKeyOf folds case, outer space and internal double-space", () => {
  const k = svc.categoryKeyOf;
  /* The three that reached the database as separate rows. */
  assert.equal(k("Fabric"), "fabric");
  assert.equal(k(" fabric "), "fabric");
  assert.equal(k("FABRIC"), "fabric");
  /* And the one nobody can see on screen. */
  assert.equal(k("Raw  Material"), "raw material");
  assert.equal(k("Raw Material"), "raw material");
  assert.equal(k("\tTrims\n"), "trims");
});

test("categoryKeyOf never throws on absent input", () => {
  /* It is called on every item in the master, including ones with no
     category at all — a throw here would take out the whole coverage read. */
  for (const v of [null, undefined, "", 0, false]) {
    assert.equal(svc.categoryKeyOf(v), "");
  }
});

test("an empty category is its own key, not a match for everything", () => {
  /* If "" collided with a real key, every uncategorised item would inherit
     whatever that category was mapped to. */
  assert.notEqual(svc.categoryKeyOf(""), svc.categoryKeyOf("Fabric"));
});
