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

/* ══ A CATEGORY SOMEBODY TYPED IS STILL A CATEGORY ═══════════════════════════
 *
 * The Item Master stores a category in two fields: pick one from the list and
 * it lands in `category`; type your own and it lands in `customCategory` with
 * `category` set to the empty string.
 *
 * `headForItem` read only `category`. So the Add-item form — which previews
 * the typed value — showed a confidently mapped head, and the moment the item
 * was saved the same item resolved to "no category, so no budget head can be
 * derived". Nothing on either screen explained the change, and the head it had
 * promised was never the one used.
 */

const custom = new Map([
  ...map,
  ["specialty weave", { budgetLedgerId: RAW_MATERIALS, budgetLedgerName: "PURCHASE", category: "Specialty Weave" }],
]);

test("a custom category resolves exactly as the preview promised", () => {
  /* What the form previews before saving… */
  const preview = svc.headForItem({ customCategory: "Specialty Weave" }, custom);
  /* …and what the item looks like on disk once it is saved. */
  const saved = svc.headForItem(
    { name: "Handloom", category: "", customCategory: "Specialty Weave" },
    custom,
  );

  assert.equal(preview.budgetLedgerId, RAW_MATERIALS);
  assert.equal(saved.budgetLedgerId, RAW_MATERIALS);
  assert.equal(saved.source, "category_mapping");
  /* The whole point: one answer, not two. */
  assert.deepEqual(
    { id: saved.budgetLedgerId, source: saved.source, category: saved.category },
    { id: preview.budgetLedgerId, source: preview.source, category: preview.category },
  );
});

test("an unmapped custom category stays unresolved on both sides of a save", () => {
  const preview = svc.headForItem({ customCategory: "Handloom Silk" }, custom);
  const saved = svc.headForItem({ category: "", customCategory: "Handloom Silk" }, custom);

  for (const r of [preview, saved]) {
    assert.equal(r.budgetLedgerId, null);
    assert.equal(r.source, "unresolved");
    /* And it names the category, rather than claiming the item has none —
       which is a different problem, pointing at a different desk. */
    assert.match(r.message, /No budget head mapped for category "Handloom Silk"/);
  }
});

test("an item override still beats a custom category's default", () => {
  const r = svc.headForItem(
    { category: "", customCategory: "Specialty Weave", budgetLedgerId: SAMPLING },
    custom,
  );
  assert.equal(r.budgetLedgerId, SAMPLING);
  assert.equal(r.source, "item_override");
});

test("a standard category is unaffected, and wins nothing it did not before", () => {
  const r = svc.headForItem({ category: "Fabric" }, custom);
  assert.equal(r.budgetLedgerId, RAW_MATERIALS);
  assert.equal(r.source, "category_mapping");
  /* A blank custom field must not shadow a real category. Both the empty
     string and an absent field are "no custom category". */
  for (const item of [
    { category: "Fabric", customCategory: "" },
    { category: "Fabric", customCategory: null },
    { category: "Fabric", customCategory: undefined },
  ]) {
    assert.equal(svc.headForItem(item, custom).budgetLedgerId, RAW_MATERIALS);
  }
  /* And an item with neither still honestly has no category. */
  const none = svc.headForItem({ name: "Mystery", category: "", customCategory: "" }, custom);
  assert.equal(none.source, "unresolved");
  assert.match(none.message, /no category/i);
});

test("the custom form is normalised by the same rule as the standard one", () => {
  /* Spelling, spacing and case are `categoryKeyOf`'s business and are
     deliberately untouched by this fix — a typed "  specialty   weave  "
     matches a mapping stored as "Specialty Weave", exactly as a picked
     category would. */
  for (const typed of ["specialty weave", "SPECIALTY WEAVE", "  Specialty   Weave  "]) {
    assert.equal(
      svc.headForItem({ customCategory: typed }, custom).budgetLedgerId,
      RAW_MATERIALS, typed,
    );
  }
});

test("the effective category is one exported rule, not a rule per caller", () => {
  /* Exported so the two routes select and report by the same rule instead of
     each deciding for itself — which is how the preview and the saved answer
     came apart in the first place. */
  assert.equal(typeof svc.effectiveCategoryOf, "function");
  assert.equal(svc.effectiveCategoryOf({ customCategory: "Typed", category: "Picked" }), "Typed");
  assert.equal(svc.effectiveCategoryOf({ customCategory: "", category: "Picked" }), "Picked");
  assert.equal(svc.effectiveCategoryOf({ category: "" }), null);
  assert.equal(svc.effectiveCategoryOf({}), null);
  /* And the resolution REPORTS the effective category, so a row naming it
     names the one the head beside it was decided by. */
  assert.equal(
    svc.headForItem({ category: "", customCategory: "Specialty Weave" }, custom).category,
    "Specialty Weave",
  );
});

test("every query that feeds the resolver loads the field it reads", () => {
  /* ── WHY THIS IS STRUCTURAL ─────────────────────────────────────────────
     A projection that omits `customCategory` does not fail loudly: the field
     is simply absent, absent is indistinguishable from blank once it reaches
     the rule, and every custom-category item silently resolves as though it
     had no category. The symptom appears on a screen, days later, as a
     budget head that quietly went missing.

     So the four callers are checked here rather than each remembering. A
     fifth one added without the field fails this test instead of shipping. */
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..");
  const callers = [
    "services/itemBudgetHead.service.js",
    "services/spendFinanceDecision.service.js",
    "routes/Accountant_Routes/Acc_chartOfAccounts.js",
    "routes/CMS_Routes/Inventory/Products/rawItems.js",
  ];

  let checked = 0;
  for (const rel of callers) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    /* An ITEM projection names `category` beside `budgetLedgerId`. The
       CATEGORY MAPPING's own projection does too — it is a row about a
       category — so it is excluded by `categoryKey`, which only the mapping
       carries. A mapping has no items and nothing to resolve. */
    for (const m of src.matchAll(/\.select\(\s*"([^"]*category[^"]*budgetLedgerId[^"]*)"/gi)) {
      /* And a SERVICE projection is excluded by `serviceCode`. A service has
         one category field and no custom form — `headForService` does not
         read a category at all, deliberately. */
      if (/categoryKey|serviceCode/.test(m[1])) continue;
      checked += 1;
      assert.ok(
        /customCategory/.test(m[1]),
        `${rel} resolves from a projection without customCategory: "${m[1]}"`,
      );
    }
  }
  /* The item projections, not the service ones — a service has one category
     field and no custom form. */
  assert.ok(checked >= 3, `expected the item projections to be found, saw ${checked}`);
});
