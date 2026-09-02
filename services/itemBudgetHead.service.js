"use strict";
/**
 * services/itemBudgetHead.service.js
 *
 * WHICH BUDGET HEAD AN ITEM COMES OUT OF.
 *
 * One question, asked in three places — the request form filling a line in,
 * the approver checking it, and the budget check when the bill lands — so it
 * is answered here once. Three copies of this rule would drift, and the shape
 * of the drift would be a request approved against one head and charged to
 * another, which is the exact failure this whole layer exists to prevent.
 *
 * ── THE ORDER, AND WHY ──────────────────────────────────────────────────────
 *   1. the item's own override   — someone decided THIS item is different
 *   2. its category's mapping    — the ordinary answer, set once by finance
 *   3. nothing                   — and nothing is a real answer, not a bug
 *
 * Step 3 matters. An unmapped category returns null and the form asks the
 * requester to pick, rather than guessing. A wrong head that filled itself in
 * is worse than an empty box: nobody re-checks a field that looks answered.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 * It does not decide where a voucher POSTS. Bookkeeping is untouched: fabric
 * still debits stock, stationery still debits its expense head. This only says
 * which budget the spend is counted against, and those two answers are
 * legitimately different for anything that capitalises.
 */

const CategoryBudget = require("../models/Accountant_model/Acc_ItemCategoryBudget");
const { Acc_Ledger } = require("../models/Accountant_model/Acc_MasterModels");
const classification = require("./budgetClassification.service");

/* ── ONE VOCABULARY ─────────────────────────────────────────────────────────
   These strings travel from this service through the Finance APIs into
   `budgetAllocation.resolutionSource` on a request line, and eventually into
   whatever reads that line. Renaming one of them later means rewriting stored
   documents, so they are named once, here, and re-used rather than retyped. */
const SOURCE_ITEM = "item_override";
const SOURCE_CATEGORY = "category_mapping";
const SOURCE_NONE = "unresolved";

/* ── ONE NORMALISATION, USED EVERYWHERE ─────────────────────────────────────
 * "Fabric", "fabric" and " Fabric " are one category to everyone except a
 * string comparison. They reached the database as three rows, so a mapping set
 * on one spelling silently failed to apply to items carrying another.
 *
 * `categoryKeyOf` is the single definition. Writes store its output in
 * `categoryKey`, the unique index is on it, reads look up by it, and coverage
 * groups by it. A second normalisation anywhere — even an equivalent one —
 * would be a rule that can drift, and the drift would look like a mapping that
 * exists and does not work.
 *
 * Internal whitespace is collapsed too: "Raw  Material" and "Raw Material"
 * differ by a character nobody can see on screen. */
const categoryKeyOf = (s) =>
  /* Strings only. `category` is a String on both the item master and the
     mapping, so anything else is not a category — and coercing it would turn
     `0` into the key "0" and `false` into "false", inventing categories out of
     values that never were any. */
  (typeof s === "string" ? s : "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

/* Kept as the short internal name the rest of this file already reads by. */
const key = categoryKeyOf;

/**
 * Every category mapping for a company, as a Map keyed by the normalised
 * category. Loaded once per request rather than per line — a 20-line request
 * would otherwise be 20 identical queries.
 */
async function categoryMap(companyId) {
  if (!companyId) return new Map();
  const rows = await CategoryBudget.find({ companyId })
    .select("category categoryKey budgetLedgerId budgetLedgerName")
    .lean();

  const map = new Map();
  const conflicts = new Map();

  for (const r of rows) {
    if (!r.budgetLedgerId) continue; // "seen, not decided" is not an answer
    /* Fall back to normalising the stored spelling for any row written before
       `categoryKey` existed, so a legacy row still participates rather than
       vanishing from the map. */
    const k = r.categoryKey || key(r.category);
    const seen = map.get(k);
    if (seen && String(seen.budgetLedgerId) !== String(r.budgetLedgerId)) {
      /* ── DO NOT GUESS ────────────────────────────────────────────────
         Two spellings of one category pointing at DIFFERENT heads is a
         setup fault, and picking either would charge real spend to a head
         nobody chose — silently, and differently depending on which row
         the database happened to return first. Recorded and surfaced. */
      const list = conflicts.get(k) || [seen];
      list.push(r);
      conflicts.set(k, list);
      continue;
    }
    if (!seen) map.set(k, r);
  }

  /* Carried on the Map rather than thrown: a conflict on "Fabric" must not
     stop "Packaging" resolving. Callers that can report it, do. */
  map.conflicts = conflicts;
  return map;
}

/**
 * The head for one item.
 *
 * `item` is a RawItem-shaped object — needs `category` and, where set,
 * `budgetLedgerId`. Pass the map from `categoryMap()` when resolving several.
 */
function headForItem(item = {}, map = new Map()) {
  const category = item.category || null;

  if (item.budgetLedgerId) {
    return {
      budgetLedgerId: item.budgetLedgerId,
      budgetLedgerName: item.budgetLedgerName || null,
      source: SOURCE_ITEM,
      category,
      message: `Set on this item directly${
        item.budgetLedgerName ? ` — ${item.budgetLedgerName}` : ""
      }.`,
    };
  }

  /* `hit.budgetLedgerId` is re-checked rather than assumed. `categoryMap`
     already drops headless rows, but a caller building its own map (or a
     future one loading rows differently) would otherwise get back a confident
     `category_mapping` carrying a null head — an answer shaped like a
     decision with no decision in it. */
  const hit = map.get(key(category));
  if (hit && hit.budgetLedgerId) {
    return {
      budgetLedgerId: hit.budgetLedgerId,
      budgetLedgerName: hit.budgetLedgerName || null,
      source: SOURCE_CATEGORY,
      category,
      message: `From the "${category}" category mapping${
        hit.budgetLedgerName ? ` — ${hit.budgetLedgerName}` : ""
      }.`,
    };
  }

  /* ── UNRESOLVED IS AN ANSWER ──────────────────────────────────────────
     Not an error, and never a default. A guessed head that fills itself in
     is worse than an empty field, because nobody re-checks something that
     already looks answered. The two messages point at different desks:
     an unmapped category is finance's decision, an uncategorised item is
     the store's data. */
  return {
    budgetLedgerId: null,
    budgetLedgerName: null,
    source: SOURCE_NONE,
    category,
    message: category
      ? `No budget head mapped for category "${category}".`
      : "This item has no category, so no budget head can be derived.",
  };
}

/** The same, for a list — one query for the whole set. */
async function headsForItems(items = [], companyId) {
  const map = await categoryMap(companyId);
  return items.map((it) => headForItem(it, map));
}

/**
 * Resolve a set of item ids — the inspection path behind the Finance API.
 *
 * Returns one row per REQUESTED id, including ids that matched nothing. A
 * caller checking 20 items needs to know which of them do not exist, and
 * silently returning 18 rows makes that look like a resolution result.
 */
async function resolveItemIds({ itemIds = [], companyId, RawItem }) {
  const ids = [...new Set(itemIds.map(String).filter(Boolean))];
  if (!ids.length) return [];

  const found = await RawItem.find({ _id: { $in: ids } })
    .select("_id name sku category budgetLedgerId budgetLedgerName")
    .lean();
  const byId = new Map(found.map((i) => [String(i._id), i]));

  const map = await categoryMap(companyId);

  return ids.map((id) => {
    const item = byId.get(id);
    if (!item) {
      return {
        itemId: id,
        found: false,
        budgetLedgerId: null,
        budgetLedgerName: null,
        source: SOURCE_NONE,
        category: null,
        message: "No item with this id.",
      };
    }
    return {
      itemId: id,
      found: true,
      itemName: item.name,
      sku: item.sku || null,
      ...headForItem(item, map),
    };
  });
}

/**
 * Which categories are mapped, which are not, and how many items each covers.
 *
 * Coverage is reported in ITEMS rather than categories, because "13 of 15
 * categories mapped" reads as nearly done when the two missing ones might be
 * Fabric and Accessories — half the master.
 */
async function coverage({ companyId, RawItem }) {
  const counts = await RawItem.aggregate([
    { $group: { _id: "$category", items: { $sum: 1 } } },
    { $sort: { items: -1 } },
  ]);
  const map = await categoryMap(companyId);

  /* ── GROUPED BY THE SAME KEY THE MAPPING USES ─────────────────────────────
     Mongo groups on the raw string, so "Fabric" and "fabric" arrive as two
     buckets. Collapsing them here rather than showing both is what makes the
     screen's item counts match what a mapping will actually cover — two rows
     for one category would report the mapped half as covered and the other
     half as outstanding work that no amount of mapping could ever close.

     Whitespace collapsing cannot be expressed in the aggregation without a
     version-dependent `$replaceAll`, and splitting the rule across two places
     is precisely what `categoryKeyOf` exists to prevent. */
  const buckets = new Map();
  for (const c of counts) {
    const raw = c._id || "";
    const k = key(raw);
    const b = buckets.get(k) || { key: k, items: 0, spellings: [] };
    b.items += c.items;
    if (raw) b.spellings.push({ label: raw, items: c.items });
    buckets.set(k, b);
  }

  const rows = [...buckets.values()]
    .sort((a, b) => b.items - a.items)
    .map((b) => {
      const hit = map.get(b.key);
      /* The label finance sees: the spelling MOST items actually use, ties
         broken alphabetically so the same data always renders the same way. */
      const label =
        [...b.spellings].sort(
          (x, y) => y.items - x.items || x.label.localeCompare(y.label),
        )[0]?.label || "";
      return {
        category: label,
        categoryKey: b.key,
        items: b.items,
        mapped: !!hit,
        budgetLedgerId: hit?.budgetLedgerId || null,
        budgetLedgerName: hit?.budgetLedgerName || null,
        /* Surfaced so finance can see WHY one row covers more items than the
           spelling in front of them suggests. */
        spellings: b.spellings.length > 1 ? b.spellings.map((x) => x.label) : [],
        /* An item with no category cannot inherit anything, and no amount of
           mapping fixes it — it is the store's data to correct, not finance's
           decision to make. */
        uncategorised: !b.key,
      };
    });

  const itemsTotal = rows.reduce((t, r) => t + r.items, 0);
  const itemsMapped = rows.filter((r) => r.mapped).reduce((t, r) => t + r.items, 0);
  const itemsUncategorised = rows.filter((r) => r.uncategorised).reduce((t, r) => t + r.items, 0);

  /* A setup fault, reported rather than resolved. See `categoryMap`. */
  const conflicts = [...(map.conflicts || new Map()).entries()].map(([k, rowsForKey]) => ({
    categoryKey: k,
    mappings: rowsForKey.map((r) => ({
      category: r.category,
      budgetLedgerId: r.budgetLedgerId,
      budgetLedgerName: r.budgetLedgerName,
    })),
  }));

  return {
    rows,
    itemsTotal,
    itemsMapped,
    itemsUncategorised,
    itemsUnmapped: itemsTotal - itemsMapped - itemsUncategorised,
    pctMapped: itemsTotal ? Math.round((itemsMapped / itemsTotal) * 100) : 0,
    conflicts,
  };
}

/**
 * May this ledger be mapped to at all?
 *
 * Three separate refusals, and they are different questions:
 *
 *   1. Does it exist? A client-supplied id is never taken on trust.
 *   2. Is it THIS company's? A budget-eligible head belonging to another
 *      company is still another company's head. Without this check the only
 *      thing standing between two companies' charts was that nobody had tried
 *      pasting an id — and cross-company reads are exactly what an id-shaped
 *      parameter invites.
 *   3. Is it an EXPENSE budget? Not merely "budgeted".
 *
 * ── WHY REVENUE TARGETS ARE REFUSED HERE ────────────────────────────────────
 * This mapping decides where PURCHASE AND SERVICE SPEND is charged. A revenue
 * target is a figure to hit, not an envelope to spend from, so mapping a
 * purchasable item to one is meaningless in a way that would only show up as a
 * sales target quietly consumed by procurement. `budgetControlOf` allows both
 * budgetable classes because the budget PICKERS legitimately need both; this
 * gate is narrower on purpose, and the difference is the point.
 */
async function assertMappable(ledgerId, companyId) {
  const ledger = await Acc_Ledger.findById(ledgerId)
    .select("_id name companyId groupId groupName budgetControl")
    .lean();
  if (!ledger) return { ok: false, message: "That head does not exist." };

  /* Deliberately the same wording as a missing ledger. Telling a caller that
     an id exists but belongs elsewhere confirms the existence of another
     company's records, which is the thing being prevented. */
  if (companyId && ledger.companyId && String(ledger.companyId) !== String(companyId)) {
    return { ok: false, message: "That head does not exist." };
  }

  const { Acc_Group } = require("../models/Accountant_model/Acc_MasterModels");
  const group = ledger.groupId
    ? await Acc_Group.findById(ledger.groupId).select("nature name").lean()
    : null;

  const control = classification.budgetControlOf({
    budgetControl: ledger.budgetControl,
    name: ledger.name,
    groupName: ledger.groupName || group?.name || "",
    nature: group?.nature || null,
  });

  if (control === classification.REVENUE_TARGET) {
    return {
      ok: false,
      message: `${ledger.name} is a revenue target, not a spending budget — an item cannot be charged to it.`,
    };
  }
  if (control !== classification.EXPENSE_BUDGET) {
    return {
      ok: false,
      message: `${ledger.name} is not a budget head, so a category cannot be mapped to it.`,
    };
  }
  return { ok: true, ledger, budgetControl: control };
}

module.exports = {
  categoryKeyOf,
  SOURCE_ITEM,
  SOURCE_CATEGORY,
  SOURCE_NONE,
  categoryMap,
  headForItem,
  headsForItems,
  coverage,
  resolveItemIds,
  assertMappable,
};
