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
/* ── ONE VOCABULARY, DEFINED IN A LEAF MODULE ───────────────────────────────
   These lived here, and the two request SCHEMAS imported this file to get the
   enum — which pulled `Acc_ItemCategoryBudget` and `Acc_Ledger` in with it.
   Registering a mongoose model builds its indexes, which creates the
   collection, and the baseline audit reads a collection's ABSENCE as "this
   feature was never deployed". Merely loading a request model had started
   manufacturing that evidence. The strings moved to a file with no requires;
   they are re-exported here so every existing caller is unaffected. */
const vocabulary = require("./budgetAllocationVocabulary");
const {
  SOURCE_ITEM, SOURCE_CATEGORY, SOURCE_SERVICE, SOURCE_MANUAL,
  SOURCE_REQUEST_HEAD, SOURCE_NONE,
  RESOLUTION_SOURCES,
  STATUS_RESOLVED, STATUS_UNRESOLVED, STATUS_MANUAL_REQUIRED, RESOLUTION_STATUSES,
} = vocabulary;

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

/* ══ SERVICES ═══════════════════════════════════════════════════════════════
 * ── WHY THIS IS NOT `headForItem` WITH A DIFFERENT ARGUMENT ─────────────────
 * An item resolves through THREE steps and a service through ONE. A service
 * has a `category` field, and it looks exactly like an item's — but the Item
 * Category mappings are a statement about what the STORE stocks, and letting
 * a service called "Consultancy" inherit the head somebody mapped for the
 * consumables category would charge professional fees to a materials budget
 * and look completely deliberate on the report.
 *
 * So this function takes NO map. Not "ignores one" — cannot receive one. The
 * rule is enforced by the signature rather than by remembering to obey it.
 *
 * Nor is anything inferred from the supplier, the SAC code or the GST rate.
 * A supplier sells more than one kind of thing (the item path learned this
 * from VRL Logistics: 83% freight, 17% labour), a SAC code is a tax
 * classification rather than a budget one, and a GST rate is a percentage.
 * None of them is evidence about which envelope the money leaves.
 */

/**
 * The head for one service.
 *
 * `service` is a Service-shaped object — needs `budgetLedgerId` and, where
 * set, `budgetLedgerName`. The result shape is identical to `headForItem`'s so
 * a caller handling both never has to branch on which it received.
 */
function headForService(service = {}) {
  const category = service.category || null;

  if (service.budgetLedgerId) {
    return {
      budgetLedgerId: service.budgetLedgerId,
      budgetLedgerName: service.budgetLedgerName || null,
      source: SOURCE_SERVICE,
      category,
      message: `Set on this service directly${
        service.budgetLedgerName ? ` — ${service.budgetLedgerName}` : ""
      }.`,
    };
  }

  /* ── AND THE CATEGORY IS NOT A SECOND CHANCE ──────────────────────────
     Named in the message so the reader can see it was considered and
     deliberately not used, rather than wondering whether it was missed. */
  return {
    budgetLedgerId: null,
    budgetLedgerName: null,
    source: SOURCE_NONE,
    category,
    message: "No budget head is set on this service."
      + (category ? ` Its category ("${category}") does not supply one.` : ""),
  };
}

/* ── DOES THE SERVICE'S DEFAULT AGREE WITH THE HEAD THE REQUEST IS ON? ──────
 * Four answers, and they are genuinely four. Collapsing "no default was ever
 * configured" into "the default disagrees" would make Finance answer for a
 * decision nobody made; collapsing "the default is not budgeted in this
 * department" into "it agrees" would let a request be approved against an
 * envelope that does not exist.
 *
 * `availableHeadIds` is the department's APPROVED BUDGET LINES — not the set
 * of mappable expense ledgers. A ledger being classifiable as spend says
 * nothing about whether this department has money on it, and calling the
 * first thing "available budget" is the misreading this argument exists to
 * prevent. Pass the ids from `budgetCommitment.approvedHeadsFor`.
 */
const AGREEMENT = Object.freeze({
  MATCHES: "default_matches_request_head",
  DIFFERENT: "different_head_selected",
  NO_DEFAULT: "service_default_unresolved",
  NOT_AVAILABLE: "default_not_available_in_department",
});

function serviceHeadAgreement({ resolution, requestLedgerId, availableHeadIds = [] } = {}) {
  const defaultId = resolution?.budgetLedgerId ? String(resolution.budgetLedgerId) : null;
  const requestId = requestLedgerId ? String(requestLedgerId) : null;
  const available = new Set((availableHeadIds || []).map(String));

  if (!defaultId) {
    return {
      state: AGREEMENT.NO_DEFAULT,
      /* Not an error, and never a reason to block: a service nobody has
         classified is finance's decision to make now, not a fault. */
      adoptable: false,
      message: "This service has no budget default. Finance chooses the head.",
    };
  }

  /* Checked BEFORE the comparison. A default that this department cannot
     spend against is not "a different head" — it is not a choice at all, and
     offering it as one is how a request gets pointed at an empty envelope. */
  if (!available.has(defaultId)) {
    return {
      state: AGREEMENT.NOT_AVAILABLE,
      adoptable: false,
      message: `${resolution.budgetLedgerName || "The service default"} is not an approved budget head for this department.`,
    };
  }

  if (requestId && defaultId === requestId) {
    return {
      state: AGREEMENT.MATCHES,
      adoptable: false, // already on it
      message: `The request is on this service's default head.`,
    };
  }

  return {
    state: AGREEMENT.DIFFERENT,
    /* Offerable precisely because it IS an approved head for this department.
       Adopting is always an explicit action — nothing here rewrites the
       request's head on its own. */
    adoptable: true,
    message: `This service normally uses ${resolution.budgetLedgerName || "another head"}, and the request is on a different one.`,
  };
}

/**
 * The allocation to store on one classified SERVICE line.
 *
 * Pure. Returns the exact `budgetAllocation` subdocument shape both request
 * models declare, so the route stores what this decides rather than
 * assembling its own version beside it.
 *
 * `chosen` is the head actually in force for the line — the request-level
 * head, since B2 keeps ONE request-level commitment. Whether that counts as
 * `service_default` or `manual_selection` is decided by whether it equals the
 * service's configured default.
 */
function serviceLineAllocation({ resolution, chosenLedgerId, chosenLedgerName, actor, reason = "" } = {}) {
  const defaultId = resolution?.budgetLedgerId ? String(resolution.budgetLedgerId) : null;
  const chosenId = chosenLedgerId ? String(chosenLedgerId) : null;
  const agrees = !!defaultId && !!chosenId && defaultId === chosenId;

  /* No head in force at all: honestly unresolved. NOT "manual_selection with
     a null head", which would read as a decision somebody made. */
  if (!chosenId) {
    return {
      budgetLedgerId: null,
      budgetLedgerName: "",
      resolutionSource: SOURCE_NONE,
      resolutionCategory: resolution?.category || "",
      resolutionReason: "",
      selectedBy: null,
      selectedByName: "",
      selectedAt: null,
      status: defaultId ? STATUS_MANUAL_REQUIRED : STATUS_UNRESOLVED,
    };
  }

  return {
    budgetLedgerId: chosenId,
    budgetLedgerName: chosenLedgerName || resolution?.budgetLedgerName || "",
    resolutionSource: agrees ? SOURCE_SERVICE : SOURCE_MANUAL,
    resolutionCategory: resolution?.category || "",
    /* Recorded only where it means something: a reason on a line that simply
       took the service's own default is noise, and noise in an audit field is
       how the field stops being read. */
    resolutionReason: agrees ? "" : String(reason || "").trim().slice(0, 300),
    selectedBy: agrees ? null : (actor?.id || null),
    selectedByName: agrees ? "" : (actor?.name || ""),
    selectedAt: agrees ? null : new Date(),
    status: STATUS_RESOLVED,
  };
}

/**
 * Resolve a set of service ids — the inspection path behind the Finance API.
 *
 * One row per REQUESTED id, in three honest flavours: found and resolved,
 * found and unresolved, and not found in this company. A caller checking
 * twenty services needs to see which two are missing rather than receive
 * eighteen rows that look like a complete answer.
 *
 * ── SCOPED, UNLIKE THE ITEM PATH ────────────────────────────────────────────
 * `RawItem` carries no `companyId`, so `resolveItemIds` cannot scope and says
 * so. `Service` does, so this DOES — and another company's service comes back
 * as `found: false` carrying no name, no category and no configuration. The
 * wording is identical to a genuinely absent id on purpose: distinguishing
 * them would confirm that another company holds that record.
 */
async function resolveServiceIds({ serviceIds = [], companyId, Service }) {
  const ids = [...new Set(serviceIds.map(String).filter(Boolean))];
  if (!ids.length) return [];
  if (!companyId) throw new Error("resolveServiceIds needs a company.");

  /* Ids arrive from a client, so anything that is not an ObjectId would throw
     a CastError for the WHOLE query and lose the valid ids with it. Filtered
     here; they still get a row below, as not found. */
  const mongoose = require("mongoose");
  const queryable = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));

  const found = queryable.length
    ? await Service.find({ companyId, _id: { $in: queryable } })
      .select("_id serviceCode name category billingUnit status budgetLedgerId budgetLedgerName")
      .lean()
    : [];
  const byId = new Map(found.map((s) => [String(s._id), s]));

  return ids.map((id) => {
    const service = byId.get(id);
    if (!service) {
      return {
        serviceId: id,
        found: false,
        budgetLedgerId: null,
        budgetLedgerName: null,
        source: SOURCE_NONE,
        category: null,
        message: "No service with this id in this company.",
      };
    }
    return {
      serviceId: id,
      found: true,
      serviceCode: service.serviceCode || null,
      serviceName: service.name,
      billingUnit: service.billingUnit || null,
      /* Carried because Finance may legitimately inspect a retired service —
         a classification made last year has to stay understandable — and a
         row that does not say so reads as one still in use. */
      status: service.status || "ACTIVE",
      ...headForService(service),
    };
  });
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
async function assertMappable(ledgerId, companyId, opts = {}) {
  /* The noun in the refusal. The GATE is identical for an item category and a
     service — one classification contract, no second opinion — but "a category
     cannot be mapped to it" is nonsense on a service screen, and a message a
     reader cannot act on is a message they raise a ticket about. */
  const subject = opts.subject || "a category";

  /* An id that is not an ObjectId throws a CastError out of `findById` and
     surfaces as a 500. It is a refusal, not a server fault. */
  const mongooseLib = require("mongoose");
  if (!ledgerId || !mongooseLib.Types.ObjectId.isValid(String(ledgerId))) {
    return { ok: false, message: "That head does not exist." };
  }

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

  /* ── A HEAD WITH NO NATURE IS REFUSED, NOT ASSUMED ────────────────────────
     Derived from the GROUP's nature, exactly as before — the item path relies
     on this and B1 does not renegotiate it. When the group has none, nothing
     is derivable and `classify` lands on `not_budgeted`, so such a head is
     already refused; the refusal below now SAYS which of the two reasons it
     was, because "not a budget head" reads as a policy decision while a blank
     nature is a gap in the chart somebody can go and fix.

     (The ledger's own `nature` is deliberately NOT consulted. Preferring it
     would accept heads this gate refuses today — a behaviour change to the
     item path, which is out of scope here. Worth revisiting on its own.) */
  const nature = group?.nature || null;

  const control = classification.budgetControlOf({
    budgetControl: ledger.budgetControl,
    name: ledger.name,
    groupName: ledger.groupName || group?.name || "",
    nature,
  });

  if (control === classification.REVENUE_TARGET) {
    return {
      ok: false,
      message: `${ledger.name} is a revenue target, not a spending budget — spend cannot be charged to it.`,
    };
  }
  if (control !== classification.EXPENSE_BUDGET) {
    return {
      ok: false,
      message: nature
        ? `${ledger.name} is not a budget head, so ${subject} cannot be mapped to it.`
        /* Named separately: "not a budget head" reads as a policy decision,
           and this one is a gap in the chart that somebody can go and fix. */
        : `${ledger.name} has no recorded nature, so it cannot be confirmed as a budget head.`,
    };
  }
  return { ok: true, ledger, budgetControl: control };
}

module.exports = {
  categoryKeyOf,
  SOURCE_ITEM,
  SOURCE_CATEGORY,
  SOURCE_SERVICE,
  SOURCE_MANUAL,
  SOURCE_REQUEST_HEAD,
  SOURCE_NONE,
  RESOLUTION_SOURCES,
  STATUS_RESOLVED,
  STATUS_UNRESOLVED,
  STATUS_MANUAL_REQUIRED,
  RESOLUTION_STATUSES,
  AGREEMENT,
  serviceHeadAgreement,
  serviceLineAllocation,
  categoryMap,
  headForItem,
  headsForItems,
  coverage,
  resolveItemIds,
  headForService,
  resolveServiceIds,
  assertMappable,
};
