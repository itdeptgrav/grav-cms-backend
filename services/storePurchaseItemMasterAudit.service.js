// services/storePurchaseItemMasterAudit.service.js
//
// Store & Purchase professionalisation — Chunk 0, Item Master addendum.
//
// READ-ONLY measurements of the CURRENT item catalogue: RawItem, its
// variants, StockItem and its BOM, and everything that references them.
// Pure, like its sibling storePurchaseBaselineAudit.service.js — plain
// documents in, a plain report out, no mongoose, no clock, no network.
//
// ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
// The target model (product plan §4.1a) splits today's RawItem into Item,
// ItemVariant, ItemUomConversion, SupplierItem, InventoryPolicy,
// ReorderPolicy and ItemAccountingProfile. Before any of that can be built,
// somebody has to know how much of the present catalogue would survive the
// split unchanged and how much needs a human. That is what this counts.
//
// ── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────
// It never asserts that two records ARE the same thing. Overlap and
// duplicate findings are CANDIDATES produced by exact, documented rules
// (normalised equality only — no fuzzy matching, no edit distance, no
// token overlap), because a merge is destructive and a false positive costs
// more than a missed one. Every finding says which rule produced it so a
// reviewer can disagree with the rule rather than with a number.

"use strict";

const LIST_CAP = 50;

const capped = (list) => ({
  total: list.length,
  shown: Math.min(list.length, LIST_CAP),
  items: list.slice(0, LIST_CAP),
});

const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const EPS = 0.001;
const approxEqual = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= EPS;

/** Trim + case-fold + collapse internal whitespace. The same normalisation
 *  `services/itemBudgetHead.service.js` uses for category keys, so a category
 *  finding here and a budget-mapping finding there group identically. */
const normKey = (s) =>
  (typeof s === "string" ? s : "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

const sortBy = (arr, pick) => [...arr].sort((a, b) => String(pick(a)).localeCompare(String(pick(b))));

/**
 * Group values by their normalised key, returning only groups that more than
 * one DOCUMENT contributed to. `occurrences` counts documents;
 * `distinctSpellings` counts renderings — the two are different clean-up
 * jobs and are never collapsed into one number.
 */
function groupByNormalised(entries) {
  const groups = new Map();
  for (const { value, ref } of entries) {
    const raw = String(value ?? "").trim();
    if (!raw) continue;
    const key = normKey(raw);
    if (!groups.has(key)) groups.set(key, { spellings: new Map(), refs: [] });
    const g = groups.get(key);
    g.spellings.set(raw, (g.spellings.get(raw) || 0) + 1);
    g.refs.push(ref);
  }
  const out = [];
  for (const [key, g] of groups) {
    const occurrences = g.refs.length;
    if (occurrences < 2) continue;
    out.push({
      normalized: key,
      occurrences,
      distinctSpellings: g.spellings.size,
      exactRepeat: g.spellings.size === 1,
      spellings: [...g.spellings.keys()].sort((a, b) => a.localeCompare(b)),
      refs: g.refs.slice(0, 10).sort((a, b) => String(a).localeCompare(String(b))),
    });
  }
  return out.sort((a, b) => a.normalized.localeCompare(b.normalized));
}

// ─────────────────────────────────────────────────────────────────────────────
// SKU identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SKU shapes the code is known to mint, each with the route that mints it.
 * A SKU matching one of these was GENERATED, not chosen by a human — which
 * matters because the target model wants a governed item code, and a
 * generated code carries no business meaning to preserve.
 *
 *   RAW-<CAT3>-<NAMECODES>-<NNN>   routes/.../Products/rawItems.js POST /
 *                                  — the trailing 3 digits are Math.random()
 *   <NAME4>-<13-digit epoch>       mrfRoutes register / legacy approve
 *   <NAME3>-<COMBO>                mrfRoutes variant creation
 *   <sku>-var / <sku>-var-<epoch>  purchaseOrders.js receive, when a variant
 *                                  arrives that the item does not have
 */
// Order matters: the most specific shape wins. `<sku>-var-<epoch>` is both a
// default variant SKU and an epoch-suffixed one, and it is the variant fact
// that tells a reader what to do about it.
const SKU_PATTERNS = [
  { pattern: "DEFAULT_VARIANT_VAR", source: "purchaseOrders receive (auto-created variant)", test: (s) => /-VAR(-\d{13})?$/i.test(s) },
  { pattern: "RANDOM_SUFFIX_RAW", source: "rawItems POST / (Math.random 3-digit suffix)", test: (s) => /^RAW-[A-Z0-9]{1,3}-.+-\d{3}$/.test(s) },
  { pattern: "EPOCH_SUFFIX", source: "mrfRoutes register / legacy approve (Date.now suffix)", test: (s) => /-\d{13}$/.test(s) },
];

function classifySku(sku) {
  const s = String(sku || "").trim();
  if (!s) return "MISSING";
  for (const p of SKU_PATTERNS) if (p.test(s)) return p.pattern;
  return "HUMAN_OR_UNKNOWN";
}

function auditSkus(rawItems) {
  const missing = rawItems.filter((i) => !String(i.sku || "").trim());
  const present = rawItems.filter((i) => String(i.sku || "").trim());

  // Exact duplicates are case-SENSITIVE equality — what the unique index
  // would have caught. Normalised duplicates additionally fold case and
  // whitespace, which the index does NOT catch, so "RAW-FAB-1" and
  // "raw-fab-1 " coexist happily today.
  const exact = new Map();
  for (const i of present) {
    const k = String(i.sku).trim();
    if (!exact.has(k)) exact.set(k, []);
    exact.get(k).push(String(i._id));
  }
  const exactDuplicates = [...exact.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([sku, ids]) => ({ sku, count: ids.length, items: ids.sort() }))
    .sort((a, b) => a.sku.localeCompare(b.sku));

  const normalisedGroups = groupByNormalised(present.map((i) => ({ value: i.sku, ref: String(i._id) })));
  // Groups that only a case/whitespace fold brings together — the ones the
  // unique index cannot see.
  const normalisedOnly = normalisedGroups.filter((g) => !g.exactRepeat);

  const byPattern = {};
  for (const i of present) {
    const c = classifySku(i.sku);
    byPattern[c] = (byPattern[c] || 0) + 1;
  }

  return {
    totalItems: rawItems.length,
    missingSku: capped(missing.map((i) => ({ id: String(i._id), name: i.name || "" }))),
    exactDuplicateSkus: capped(exactDuplicates),
    normalisedDuplicateSkus: capped(normalisedOnly),
    generatedSkuPatterns: Object.fromEntries(Object.keys(byPattern).sort().map((k) => [k, byPattern[k]])),
    patternDefinitions: SKU_PATTERNS.map(({ pattern, source }) => ({ pattern, source })),
  };
}

function auditNames(rawItems) {
  const missing = rawItems.filter((i) => !String(i.name || "").trim());
  const groups = groupByNormalised(rawItems.map((i) => ({ value: i.name, ref: String(i._id) })));
  return {
    missingName: capped(missing.map((i) => ({ id: String(i._id), sku: i.sku || "" }))),
    duplicateNameGroups: capped(groups),
    duplicateNameDocuments: groups.reduce((s, g) => s + g.occurrences, 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Category and unit: two fields for one identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `category` (from a hard-coded list in the route) and `customCategory`
 * (free text) both exist on every item; the code reads
 * `customCategory || category` in some places and `category` in others.
 *
 * CONFLICT      both filled with values that do not normalise equal — two
 *               different answers to "what is this?"
 * SHADOWED      both filled and equal — harmless but redundant
 * CUSTOM_ONLY   only the free-text one — outside the controlled list
 * NEITHER       uncategorised entirely
 */
function auditDualField(docs, primaryField, customField) {
  const buckets = { CONFLICT: [], SHADOWED: [], CUSTOM_ONLY: [], PRIMARY_ONLY: [], NEITHER: [] };
  for (const d of docs) {
    const p = String(d[primaryField] || "").trim();
    const c = String(d[customField] || "").trim();
    const ref = { id: String(d._id), sku: d.sku || "", [primaryField]: p, [customField]: c };
    if (p && c) buckets[normKey(p) === normKey(c) ? "SHADOWED" : "CONFLICT"].push(ref);
    else if (c) buckets.CUSTOM_ONLY.push(ref);
    else if (p) buckets.PRIMARY_ONLY.push(ref);
    else buckets.NEITHER.push(ref);
  }
  return {
    fields: `${primaryField} vs ${customField}`,
    conflict: capped(sortBy(buckets.CONFLICT, (x) => x.id)),
    shadowed: buckets.SHADOWED.length,
    customOnly: buckets.CUSTOM_ONLY.length,
    primaryOnly: buckets.PRIMARY_ONLY.length,
    neither: capped(sortBy(buckets.NEITHER, (x) => x.id)),
  };
}

/** Distinct category identities across both fields, normalised. */
function categoryIdentities(rawItems, controlledList = []) {
  const controlled = new Set(controlledList.map(normKey));
  const seen = new Map();
  for (const i of rawItems) {
    for (const v of [i.category, i.customCategory]) {
      const raw = String(v || "").trim();
      if (!raw) continue;
      const k = normKey(raw);
      if (!seen.has(k)) seen.set(k, { normalized: k, spellings: new Set(), items: 0, inControlledList: controlled.has(k) });
      seen.get(k).spellings.add(raw);
      seen.get(k).items += 1;
    }
  }
  const all = [...seen.values()]
    .map((g) => ({ ...g, spellings: [...g.spellings].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.normalized.localeCompare(b.normalized));
  return {
    distinctIdentities: all.length,
    outsideControlledList: capped(all.filter((g) => !g.inControlledList)),
    controlledListSize: controlledList.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit conversions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Conversion truth lives in three places and they do not have to agree:
 *
 *   Unit.conversions[]              {toUnit: ObjectId, quantity}
 *   RawItem.variants[].unitConversion  legacy single {fromUnit, toUnit, quantity} (strings)
 *   RawItem.variants[].unitConversions[]  the current array, same shape
 *
 * Every finding below is about ONE of those, named, because "the conversion
 * is wrong" is unactionable when three records could be the wrong one.
 *
 * MISSING_TARGET   names a unit that is not in the Unit master
 * ZERO / INVALID   factor is 0, negative, or not a number
 * SELF             from and to are the same unit (a 1:1 that says nothing)
 * RECIPROCAL       A→B and B→A both defined. Not automatically wrong, but
 *                  the route picks the direct one first and falls back to
 *                  inverting the reverse, so two definitions that are not
 *                  exact inverses give different answers depending on which
 *                  direction the caller asks in.
 * AMBIGUOUS        the same from→to pair defined more than once with
 *                  different factors
 * CYCLE            a conversion path returns to its start through 3+ units
 */
function auditUnitConversions({ units = [], rawItems = [] }) {
  const unitById = new Map(units.map((u) => [String(u._id), u]));
  const unitByName = new Map(units.map((u) => [normKey(u.name), u]));

  const findings = { missingTarget: [], zeroOrInvalid: [], self: [], reciprocal: [], ambiguous: [], cycle: [] };

  // ── Unit master edges ──────────────────────────────────────────────────
  const edges = new Map(); // "from|to" → [factors]
  const adjacency = new Map(); // fromKey → Set(toKey)
  for (const u of units) {
    const fromKey = normKey(u.name);
    for (const c of u.conversions || []) {
      const target = c.toUnit ? unitById.get(String(c.toUnit)) : null;
      const toKey = target ? normKey(target.name) : null;
      const qty = Number(c.quantity);
      const where = { unit: u.name, unitId: String(u._id), toUnitId: c.toUnit ? String(c.toUnit) : null, quantity: c.quantity };

      if (!target) { findings.missingTarget.push({ source: "Unit.conversions[]", ...where }); continue; }
      if (!Number.isFinite(qty) || qty <= 0) {
        findings.zeroOrInvalid.push({ source: "Unit.conversions[]", ...where, toUnit: target.name });
        continue;
      }
      if (fromKey === toKey) { findings.self.push({ source: "Unit.conversions[]", ...where, toUnit: target.name }); continue; }

      const k = `${fromKey}|${toKey}`;
      if (!edges.has(k)) edges.set(k, []);
      edges.get(k).push(qty);
      if (!adjacency.has(fromKey)) adjacency.set(fromKey, new Set());
      adjacency.get(fromKey).add(toKey);
    }
  }

  for (const [k, factors] of edges) {
    const [from, to] = k.split("|");
    const distinct = [...new Set(factors.map(round4))];
    if (distinct.length > 1) findings.ambiguous.push({ source: "Unit.conversions[]", from, to, factors: distinct.sort((a, b) => a - b) });
  }

  const seenPair = new Set();
  for (const [k, factors] of edges) {
    const [from, to] = k.split("|");
    const reverseKey = `${to}|${from}`;
    if (!edges.has(reverseKey)) continue;
    const pairKey = [from, to].sort().join("|");
    if (seenPair.has(pairKey)) continue;
    seenPair.add(pairKey);
    const forward = round4(factors[0]);
    const backward = round4(edges.get(reverseKey)[0]);
    findings.reciprocal.push({
      source: "Unit.conversions[]", from, to, forward, backward,
      // Exact inverses agree whichever way the route resolves them; anything
      // else answers differently depending on the direction asked.
      consistent: approxEqual(round4(forward * backward), 1),
    });
  }

  // ── Cycles of length ≥ 3 in the unit graph ─────────────────────────────
  const cycles = new Set();
  const walk = (start, node, path, depth) => {
    if (depth > 4) return;
    for (const next of adjacency.get(node) || []) {
      if (next === start && path.length >= 3) {
        cycles.add([...path].sort().join(" → "));
        continue;
      }
      if (path.includes(next)) continue;
      walk(start, next, [...path, next], depth + 1);
    }
  };
  for (const from of adjacency.keys()) walk(from, from, [from], 1);
  findings.cycle = [...cycles].sort().map((c) => ({ source: "Unit.conversions[]", units: c }));

  // ── Item-level conversions ─────────────────────────────────────────────
  let itemLevelTotal = 0;
  let legacySingleField = 0;
  for (const item of rawItems) {
    for (const v of item.variants || []) {
      const list = [
        ...(v.unitConversion ? [{ ...v.unitConversion, field: "variants[].unitConversion (legacy)" }] : []),
        ...(v.unitConversions || []).map((c) => ({ ...c, field: "variants[].unitConversions[]" })),
      ];
      if (v.unitConversion) legacySingleField += 1;
      for (const c of list) {
        itemLevelTotal += 1;
        const from = String(c.fromUnit || "").trim();
        const to = String(c.toUnit || "").trim();
        const qty = Number(c.quantity);
        const where = { source: c.field, item: String(item._id), sku: item.sku || "", variant: String(v._id), fromUnit: from, toUnit: to, quantity: c.quantity };
        if (!from || !to || !unitByName.has(normKey(from)) || !unitByName.has(normKey(to))) {
          findings.missingTarget.push(where);
          continue;
        }
        if (!Number.isFinite(qty) || qty <= 0) { findings.zeroOrInvalid.push(where); continue; }
        if (normKey(from) === normKey(to)) { findings.self.push(where); continue; }
        // Item-level factor contradicting the Unit master for the same pair.
        const masterFactors = edges.get(`${normKey(from)}|${normKey(to)}`);
        if (masterFactors && !masterFactors.some((f) => approxEqual(round4(f), round4(qty)))) {
          findings.ambiguous.push({ ...where, masterFactors: [...new Set(masterFactors.map(round4))], note: "item-level factor disagrees with the Unit master for this pair" });
        }
      }
    }
  }

  return {
    unitsInMaster: units.length,
    unitsWithNoConversions: units.filter((u) => !(u.conversions || []).length).length,
    itemLevelConversions: itemLevelTotal,
    variantsUsingLegacySingleField: legacySingleField,
    missingTarget: capped(sortBy(findings.missingTarget, (x) => `${x.source}${x.unit || x.item}`)),
    zeroOrInvalid: capped(sortBy(findings.zeroOrInvalid, (x) => `${x.source}${x.unit || x.item}`)),
    selfConversions: capped(sortBy(findings.self, (x) => `${x.source}${x.unit || x.item}`)),
    reciprocalPairs: capped(sortBy(findings.reciprocal, (x) => `${x.from}|${x.to}`)),
    inconsistentReciprocals: findings.reciprocal.filter((r) => !r.consistent).length,
    ambiguous: capped(sortBy(findings.ambiguous, (x) => `${x.from || x.fromUnit}|${x.to || x.toUnit}`)),
    cycles: capped(findings.cycle),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Balances, variants and movement history
// ─────────────────────────────────────────────────────────────────────────────

function auditBalancesAndVariants(rawItems) {
  const balanceMismatch = [];
  const noHistoryWithBalance = [];
  const duplicateCombinations = [];
  const duplicateVariantSkus = [];
  const missingVariantSku = [];
  const defaultVariantSkuCollisions = [];

  let variantTotal = 0;

  for (const item of rawItems) {
    const variants = item.variants || [];
    variantTotal += variants.length;
    const quantity = Number(item.quantity) || 0;
    const txns = item.stockTransactions || [];

    if (variants.length) {
      const sum = round4(variants.reduce((s, v) => s + (Number(v.quantity) || 0), 0));
      if (!approxEqual(quantity, sum)) {
        balanceMismatch.push({ id: String(item._id), sku: item.sku || "", quantity: round4(quantity), variantSum: sum, difference: round4(quantity - sum), variants: variants.length });
      }
    }

    if (quantity !== 0 && txns.length === 0) {
      noHistoryWithBalance.push({ id: String(item._id), sku: item.sku || "", quantity: round4(quantity) });
    }

    // Duplicate option combinations within one item — two variants that
    // describe the same physical thing.
    const comboSeen = new Map();
    for (const v of variants) {
      const combo = (v.combination || []).map((c) => normKey(c)).join(" / ");
      if (!combo) continue;
      if (!comboSeen.has(combo)) comboSeen.set(combo, []);
      comboSeen.get(combo).push(String(v._id));
    }
    for (const [combo, ids] of comboSeen) {
      if (ids.length > 1) duplicateCombinations.push({ item: String(item._id), sku: item.sku || "", combination: combo, count: ids.length, variants: ids.sort() });
    }

    for (const v of variants) {
      if (!String(v.sku || "").trim()) missingVariantSku.push({ item: String(item._id), itemSku: item.sku || "", variant: String(v._id), combination: v.combination || [] });
    }
  }

  // Variant SKU collisions across the WHOLE catalogue — variant SKUs carry no
  // unique index, so this is unenforced anywhere.
  const allVariantSkus = [];
  for (const item of rawItems) {
    for (const v of item.variants || []) {
      const sku = String(v.sku || "").trim();
      if (sku) allVariantSkus.push({ value: sku, ref: `${item._id}:${v._id}` });
    }
  }
  const variantGroups = groupByNormalised(allVariantSkus);
  for (const g of variantGroups) {
    const entry = { sku: g.normalized, occurrences: g.occurrences, distinctSpellings: g.distinctSpellings, refs: g.refs };
    // The receive route defaults an auto-created variant to `<itemSku>-var`,
    // so every no-SKU variant on one item gets the identical value. These
    // are collisions the system MINTS, told apart from collisions a human
    // typed, because the fix differs.
    if (/-var(-\d{13})?$/i.test(g.normalized)) defaultVariantSkuCollisions.push(entry);
    else duplicateVariantSkus.push(entry);
  }

  return {
    itemsWithVariants: rawItems.filter((i) => (i.variants || []).length).length,
    variantTotal,
    itemVsVariantBalanceMismatch: capped(sortBy(balanceMismatch, (x) => x.sku || x.id)),
    balanceWithNoMovementHistory: capped(sortBy(noHistoryWithBalance, (x) => x.sku || x.id)),
    duplicateVariantCombinations: capped(sortBy(duplicateCombinations, (x) => `${x.sku}${x.combination}`)),
    missingVariantSku: capped(sortBy(missingVariantSku, (x) => x.itemSku || x.item)),
    duplicateVariantSkus: capped(duplicateVariantSkus),
    defaultVariantSkuCollisions: capped(defaultVariantSkuCollisions),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Item type and lifecycle capability
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The target model requires an explicit item type (raw material,
 * consumable, packaging, spare, trading good, finished good, service, fixed
 * asset) and a lifecycle (draft/active/blocked/archived).
 *
 * Today RawItem has NEITHER field. `status` is a DERIVED stock state
 * ("In Stock"/"Low Stock"/"Out of Stock", recomputed in a pre-save hook), not
 * a lifecycle, so it cannot express "this item is retired". StockItem has
 * `productType` (Goods/Service/Combo), which is a sales classification
 * rather than the inventory type the plan needs.
 *
 * These are CAPABILITY findings: the number is the whole catalogue, and the
 * gap is in the schema, not in the data.
 */
function auditTypeAndLifecycle({ rawItems = [], stockItems = [] }) {
  const rawWithType = rawItems.filter((i) => String(i.itemType || "").trim()).length;
  const rawWithLifecycle = rawItems.filter((i) => String(i.lifecycle || i.archived || "").trim()).length;
  const stockByProductType = {};
  for (const s of stockItems) {
    const k = String(s.productType || "(none)");
    stockByProductType[k] = (stockByProductType[k] || 0) + 1;
  }
  return {
    rawItems: {
      total: rawItems.length,
      withExplicitItemType: rawWithType,
      withoutExplicitItemType: rawItems.length - rawWithType,
      schemaDeclaresItemType: false,
      note: "RawItem has no item-type field at all. Every item is untyped; nothing distinguishes a fabric from a spare part from a service.",
    },
    stockItems: {
      total: stockItems.length,
      byProductType: Object.fromEntries(Object.keys(stockByProductType).sort().map((k) => [k, stockByProductType[k]])),
      note: "StockItem.productType (Goods/Service/Combo) is a sales classification, not the inventory item type the target model needs.",
    },
    lifecycle: {
      itemsWithLifecycleState: rawWithLifecycle,
      schemaDeclaresLifecycle: false,
      archiveCapability: "ABSENT",
      note: "Neither RawItem nor StockItem has a lifecycle/archived field. RawItem.status is a DERIVED stock state (In Stock / Low Stock / Out of Stock) recomputed on every save, and cannot express retirement. The only way to remove an item today is DELETE /api/cms/raw-items/:id, which destroys the document and its entire embedded movement history (write path S11). Vendors, by contrast, DO have Active/Inactive/Blacklisted — so the absence is specific to items.",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Supplier aliases (today's SupplierItem)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The supplier relationship exists at THREE layers, not one:
 *
 *   1. `RawItem.primaryVendor`        — item-level, a single preferred supplier
 *   2. `RawItem.alternateVendors[]`   — item-level, additional suppliers
 *   3. `variants[].vendorNicknames[]` — variant-level, and the only layer
 *      that carries the supplier's own code, price and lead time
 *
 * An earlier version of this audit claimed supplier data lived only on
 * variants. That was wrong: the two item-level fields have existed all
 * along, they are what the vendor screens read, and purchasing simply does
 * not consult them. All three are measured here, and the target SupplierItem
 * has to absorb all three.
 *
 * ── WORDING THAT MATTERS ────────────────────────────────────────────────────
 * An item with none of the three has **no configured supplier relationship**.
 * That is not the same as "the item has no supplier": purchase-order history,
 * requisition lines, worksheet POs and free-text documents may all name one.
 * Absence here means nothing was configured in the master, not that nobody
 * ever supplied it.
 */
function auditSupplierRelationships({ rawItems = [], vendors = [] }) {
  const vendorIds = new Set(vendors.map((v) => String(v._id)));

  const danglingPrimary = [];
  const danglingAlternate = [];
  const danglingAlias = [];
  const aliasMissingIdentity = [];
  const duplicatePerVariant = [];
  const redundantAcrossLayers = [];
  const noConfiguredRelationship = [];

  let itemsWithPrimary = 0;
  let itemsWithAlternates = 0;
  let itemsWithVariantAliases = 0;
  let alternateTotal = 0;
  let aliasTotal = 0;
  let aliasesWithPrice = 0;
  let aliasesWithLeadTime = 0;
  let aliasesWithBoth = 0;

  for (const item of rawItems) {
    const ref = { id: String(item._id), sku: item.sku || "", name: item.name || "" };

    const primary = item.primaryVendor ? String(item.primaryVendor) : null;
    const alternates = (item.alternateVendors || []).map(String).filter(Boolean);
    const aliasVendors = [];

    if (primary) {
      itemsWithPrimary += 1;
      if (!vendorIds.has(primary)) danglingPrimary.push({ ...ref, layer: "primaryVendor", missingVendor: primary });
    }

    if (alternates.length) {
      itemsWithAlternates += 1;
      alternateTotal += alternates.length;
      for (const a of alternates) {
        if (!vendorIds.has(a)) danglingAlternate.push({ ...ref, layer: "alternateVendors[]", missingVendor: a });
      }
    }

    let itemHasAlias = false;
    for (const v of item.variants || []) {
      const perVendor = new Map();
      for (const alias of v.vendorNicknames || []) {
        aliasTotal += 1;
        itemHasAlias = true;
        const aliasRef = { ...ref, variant: String(v._id), alias: alias._id ? String(alias._id) : null };
        const vendorId = alias.vendor ? String(alias.vendor) : null;

        if (!vendorId) {
          aliasMissingIdentity.push({ ...aliasRef, layer: "variants[].vendorNicknames[]", reason: "alias carries no vendor reference" });
        } else {
          aliasVendors.push(vendorId);
          if (!vendorIds.has(vendorId)) danglingAlias.push({ ...aliasRef, layer: "variants[].vendorNicknames[]", missingVendor: vendorId });
          if (!perVendor.has(vendorId)) perVendor.set(vendorId, []);
          perVendor.get(vendorId).push(String(alias.nickname || ""));
        }

        if (!String(alias.nickname || "").trim()) {
          aliasMissingIdentity.push({ ...aliasRef, layer: "variants[].vendorNicknames[]", reason: "alias carries no supplier code/nickname" });
        }

        const hasPrice = Number(alias.price) > 0;
        const hasLead = Number(alias.deliveryDays) > 0;
        if (hasPrice) aliasesWithPrice += 1;
        if (hasLead) aliasesWithLeadTime += 1;
        if (hasPrice && hasLead) aliasesWithBoth += 1;
      }
      for (const [vendorId, codes] of perVendor) {
        if (codes.length > 1) {
          duplicatePerVariant.push({ ...ref, variant: String(v._id), vendor: vendorId, count: codes.length, codes: codes.sort() });
        }
      }
    }
    if (itemHasAlias) itemsWithVariantAliases += 1;

    // ── The same supplier configured at more than one layer ───────────────
    // Not automatically wrong — a primary supplier that also holds a variant
    // code is coherent. It is reported because the target model has ONE
    // SupplierItem per supplier per item/variant, so each of these is a
    // merge decision with a preference flag to set.
    const layersByVendor = new Map();
    const noteLayer = (vendorId, layer) => {
      if (!vendorId) return;
      if (!layersByVendor.has(vendorId)) layersByVendor.set(vendorId, new Set());
      layersByVendor.get(vendorId).add(layer);
    };
    noteLayer(primary, "primaryVendor");
    for (const a of alternates) noteLayer(a, "alternateVendors[]");
    for (const a of aliasVendors) noteLayer(a, "variants[].vendorNicknames[]");
    for (const [vendorId, layers] of layersByVendor) {
      if (layers.size > 1) {
        redundantAcrossLayers.push({ ...ref, vendor: vendorId, layers: [...layers].sort() });
      }
    }
    // A vendor listed as BOTH primary and alternate is the one case that is
    // simply redundant rather than a modelling decision, so it is called out.
    if (primary && alternates.includes(primary)) {
      redundantAcrossLayers.push({ ...ref, vendor: primary, layers: ["primaryVendor", "alternateVendors[]"], note: "primary supplier repeated in alternates" });
    }

    if (!primary && !alternates.length && !itemHasAlias) {
      noConfiguredRelationship.push(ref);
    }
  }

  // De-duplicate redundancy rows (the primary-in-alternates note can repeat a
  // pair the layer scan already found).
  const redundantSeen = new Map();
  for (const r of redundantAcrossLayers) {
    const k = `${r.id}|${r.vendor}`;
    if (!redundantSeen.has(k)) redundantSeen.set(k, r);
    else if (r.note) redundantSeen.set(k, { ...redundantSeen.get(k), note: r.note });
  }

  return {
    totalItems: rawItems.length,
    layers: {
      itemsWithPrimarySupplier: itemsWithPrimary,
      itemsWithAlternateSuppliers: itemsWithAlternates,
      alternateSupplierReferences: alternateTotal,
      itemsWithVariantSupplierAliases: itemsWithVariantAliases,
      variantSupplierAliases: aliasTotal,
    },
    // Deliberate wording: nothing is CONFIGURED in the master. History may
    // still name a supplier — see `limitation` below.
    itemsWithNoConfiguredSupplierRelationship: capped(sortBy(noConfiguredRelationship, (x) => x.sku || x.id)),
    danglingReferences: {
      primaryVendor: capped(sortBy(danglingPrimary, (x) => x.sku || x.id)),
      alternateVendors: capped(sortBy(danglingAlternate, (x) => x.sku || x.id)),
      variantAliases: capped(sortBy(danglingAlias, (x) => x.sku || x.id)),
      total: danglingPrimary.length + danglingAlternate.length + danglingAlias.length,
    },
    aliasesMissingIdentity: capped(sortBy(aliasMissingIdentity, (x) => x.sku || x.id)),
    duplicateAliasesPerSupplierPerVariant: capped(sortBy(duplicatePerVariant, (x) => x.sku || x.id)),
    sameSupplierAtMultipleLayers: capped(sortBy([...redundantSeen.values()], (x) => x.sku || x.id)),
    commercialDataOnAliases: {
      aliasesCarryingPrice: aliasesWithPrice,
      aliasesCarryingLeadTime: aliasesWithLeadTime,
      aliasesCarryingBoth: aliasesWithBoth,
      note: "Price and lead time sit on the catalogue record today. The target SupplierItem takes them as commercial data, keeping the supplier's CODE as identity and the price as a last-agreed snapshot.",
    },
    limitation:
      "'No configured supplier relationship' means none of the three master layers (primaryVendor, alternateVendors[], variants[].vendorNicknames[]) is populated. It does NOT mean the item has no supplier: purchase-order history, requisition lines, worksheet POs and free-text documents may name one, and none of those is a configured relationship this report can count. Only variant aliases carry a supplier code, price or lead time; the two item-level layers are bare references.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// StockItem hygiene — the second catalogue, audited as part of one Item Master
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The target model merges RawItem and StockItem into one governed Item, so
 * StockItem's own identity hygiene is in scope — an earlier version of this
 * audit deferred it as "finished-goods scope", which would have left half
 * the future catalogue unmeasured.
 *
 * `reference` is StockItem's item code (unique, uppercased by the schema);
 * `variants[].sku` is unique too. Both indexes are case-sensitive, so
 * normalised collisions can still exist — the same gap RawItem has.
 */
function auditStockItems({ stockItems = [], units = [] }) {
  const unitNames = new Set(units.map((u) => normKey(u.name)));

  const missingReference = [];
  const missingName = [];
  const productTypeContradictions = [];
  const serviceWithBalance = [];
  const headerVsVariantBalance = [];
  const balanceWithNoLedger = [];
  const variantMinMaxErrors = [];
  const missingVariantSku = [];
  const missingHsn = [];
  const missingTaxClass = [];

  const referenceEntries = [];
  const nameEntries = [];
  const itemBarcodeEntries = [];
  const variantBarcodeEntries = [];
  const variantSkuEntries = [];
  const unitEntries = [];
  const categoryEntries = [];

  let variantTotal = 0;
  let systemShapedVariantSkus = 0;

  for (const s of stockItems) {
    const ref = { id: String(s._id), reference: s.reference || "", name: s.name || "" };
    const reference = String(s.reference || "").trim();
    const name = String(s.name || "").trim();

    if (!reference) missingReference.push(ref);
    else referenceEntries.push({ value: reference, ref: String(s._id) });

    if (!name) missingName.push(ref);
    else nameEntries.push({ value: name, ref: String(s._id) });
    // Aliases share the name namespace — two products cannot both answer to
    // one name just because one of them answers to it as an alias.
    for (const alt of s.additionalNames || []) {
      const a = String(alt || "").trim();
      if (a) nameEntries.push({ value: a, ref: `${s._id}:alias` });
    }

    if (String(s.barcode || "").trim()) itemBarcodeEntries.push({ value: String(s.barcode).trim(), ref: String(s._id) });
    if (String(s.category || "").trim()) categoryEntries.push({ value: String(s.category).trim(), ref: String(s._id) });
    if (String(s.unit || "").trim()) unitEntries.push({ value: String(s.unit).trim(), ref: String(s._id) });

    const variants = s.variants || [];
    variantTotal += variants.length;
    const variantSum = round4(variants.reduce((sum, v) => sum + (Number(v.quantityOnHand) || 0), 0));
    const header = round4(Number(s.totalQuantityOnHand) || 0);
    const anyBalance = variantSum > EPS || header > EPS;

    // productType vs trackInventory: a Service that tracks inventory, or a
    // Goods that does not, is a contradiction the schema permits.
    const productType = String(s.productType || "");
    const tracks = s.trackInventory !== false;
    if (productType === "Service" && tracks) {
      productTypeContradictions.push({ ...ref, productType, trackInventory: true, reason: "a Service that tracks inventory" });
    }
    if (productType === "Goods" && !tracks) {
      productTypeContradictions.push({ ...ref, productType, trackInventory: false, reason: "a Goods item that does not track inventory" });
    }
    // The harder fact: a service HOLDING stock, whatever the flag says.
    if (productType === "Service" && anyBalance) {
      serviceWithBalance.push({ ...ref, headerQuantity: header, variantQuantitySum: variantSum });
    }

    if (variants.length && !approxEqual(header, variantSum)) {
      headerVsVariantBalance.push({ ...ref, totalQuantityOnHand: header, variantQuantitySum: variantSum, difference: round4(header - variantSum) });
    }

    // StockItem has NO movement ledger of any kind — not an embedded array,
    // not a collection. Any balance at all is unexplained by construction.
    if (anyBalance) balanceWithNoLedger.push({ ...ref, headerQuantity: header, variantQuantitySum: variantSum });

    if (!String(s.hsnCode || "").trim()) missingHsn.push(ref);
    if (!String(s.salesTax || "").trim() && !String(s.purchaseTax || "").trim()) missingTaxClass.push(ref);

    for (const v of variants) {
      const vRef = { ...ref, variantSku: v.sku || "" };
      const sku = String(v.sku || "").trim();
      if (!sku) missingVariantSku.push(vRef);
      else {
        variantSkuEntries.push({ value: sku, ref: `${s._id}:${sku}` });
        if (classifySku(sku) !== "HUMAN_OR_UNKNOWN") systemShapedVariantSkus += 1;
      }
      if (String(v.barcode || "").trim()) variantBarcodeEntries.push({ value: String(v.barcode).trim(), ref: `${s._id}:${sku}` });

      const min = Number(v.minStock) || 0;
      const max = Number(v.maxStock) || 0;
      if (max > 0 && max < min) variantMinMaxErrors.push({ ...vRef, minStock: min, maxStock: max });
    }
  }

  const exactDup = (entries) => {
    const counts = new Map();
    for (const e of entries) {
      const k = e.value;
      if (!counts.has(k)) counts.set(k, []);
      counts.get(k).push(e.ref);
    }
    return [...counts.entries()]
      .filter(([, refs]) => refs.length > 1)
      .map(([value, refs]) => ({ value, count: refs.length, refs: refs.sort() }))
      .sort((a, b) => a.value.localeCompare(b.value));
  };

  const refGroups = groupByNormalised(referenceEntries);
  const variantSkuGroups = groupByNormalised(variantSkuEntries);

  return {
    totalStockItems: stockItems.length,
    variantTotal,
    referenceIdentity: {
      missingReference: capped(sortBy(missingReference, (x) => x.id)),
      exactDuplicates: capped(exactDup(referenceEntries)),
      // Normalised-only groups are the ones the unique index cannot see.
      normalisedDuplicates: capped(refGroups.filter((g) => !g.exactRepeat)),
    },
    nameIdentity: {
      missingName: capped(sortBy(missingName, (x) => x.id)),
      duplicateNameGroups: capped(groupByNormalised(nameEntries)),
      note: "Names and additionalNames share one namespace; an alias colliding with another product's name is reported.",
    },
    categoryIdentity: {
      distinctIdentities: groupByNormalised(categoryEntries).length + new Set(categoryEntries.map((e) => normKey(e.value))).size - groupByNormalised(categoryEntries).length,
      spellingVariantGroups: capped(groupByNormalised(categoryEntries).filter((g) => !g.exactRepeat)),
      note: "StockItem.category is free text in a namespace entirely separate from RawItem's. The target ItemCategory is one hierarchy for both.",
    },
    uomIdentity: {
      distinctUnitNames: new Set(unitEntries.map((e) => normKey(e.value))).size,
      unitsNotInMaster: capped(
        [...new Set(unitEntries.map((e) => e.value))]
          .filter((u) => !unitNames.has(normKey(u)))
          .sort((a, b) => a.localeCompare(b))
          .map((unitName) => ({ unit: unitName })),
      ),
      note: "StockItem.unit is a name, joined to the Unit master by string like RawItem's. A name absent from the master cannot be converted.",
    },
    productTypeAndTracking: {
      contradictions: capped(sortBy(productTypeContradictions, (x) => x.reference || x.id)),
      serviceItemsCarryingInventoryBalance: capped(sortBy(serviceWithBalance, (x) => x.reference || x.id)),
      note: "productType is a sales classification and trackInventory an inventory flag; nothing enforces agreement between them, and neither prevents a Service holding a balance.",
    },
    barcodes: {
      duplicateItemBarcodes: capped(exactDup(itemBarcodeEntries)),
      duplicateVariantBarcodes: capped(exactDup(variantBarcodeEntries)),
      note: "Within-level duplicates only. Cross-level collisions and the (non-)comparability with printed lot instances are reported by `barcodeIdentity`, which covers the whole future namespace.",
    },
    variantIdentity: {
      missingVariantSku: capped(sortBy(missingVariantSku, (x) => x.reference || x.id)),
      exactDuplicateVariantSkus: capped(exactDup(variantSkuEntries)),
      normalisedDuplicateVariantSkus: capped(variantSkuGroups.filter((g) => !g.exactRepeat)),
      systemShapedVariantSkus,
      minMaxErrors: capped(sortBy(variantMinMaxErrors, (x) => x.reference || x.id)),
    },
    balances: {
      headerVsVariantMismatch: capped(sortBy(headerVsVariantBalance, (x) => x.reference || x.id)),
      balancesWithNoMovementLedger: capped(sortBy(balanceWithNoLedger, (x) => x.reference || x.id)),
      note: "StockItem has NO movement history of any kind — no embedded array, no ledger collection. Every finished-goods balance is unexplained by construction; services/changeLog.js records prose about edits, which is not a ledger.",
    },
    compliance: {
      missingHsnCode: capped(sortBy(missingHsn, (x) => x.reference || x.id)),
      missingTaxClassification: capped(sortBy(missingTaxClass, (x) => x.reference || x.id)),
      note: "Reported for every item; whether HSN/tax is REQUIRED depends on the item type and sales channel, which no field records today. These are completeness counts, not violations.",
    },
  };
}

/**
 * Barcode identity across the whole future Item Master.
 *
 * The target model has ONE barcode namespace (product plan §4.1a puts
 * `barcodes[]` on ItemVariant). Today there are two different kinds of
 * identifier, and they are NOT the same concept:
 *
 *   PRODUCT identifiers — `StockItem.barcode` and
 *     `StockItem.variants[].barcode`, free strings with no uniqueness
 *     constraint at either level. These are what a GTIN/EAN would go in:
 *     one value naming a KIND of thing.
 *
 *   PRINTED LOT-INSTANCE identifiers — the `barcodes` collection, where the
 *     QR payload IS the document's `_id`. One document per physical
 *     sticker on one lot of one raw-item variant. There is no barcode
 *     STRING field on it to collide with.
 *
 * Merging the two would be wrong: a product identifier answers "what is
 * this?", a lot-instance identifier answers "which physical roll is this?".
 * They are therefore reported SEPARATELY, with one narrow cross-check where
 * a collision is actually possible (below).
 */
function auditBarcodeIdentity({ stockItems = [], barcodes = [] }) {
  const itemLevel = [];   // {value, ref}
  const variantLevel = [];

  for (const s of stockItems) {
    const b = String(s.barcode || "").trim();
    if (b) itemLevel.push({ value: b, ref: String(s._id), reference: s.reference || "" });
    for (const v of s.variants || []) {
      const vb = String(v.barcode || "").trim();
      if (vb) variantLevel.push({ value: vb, ref: `${s._id}:${v.sku || ""}`, reference: s.reference || "" });
    }
  }

  const dupWithin = (entries) => {
    const byValue = new Map();
    for (const e of entries) {
      if (!byValue.has(e.value)) byValue.set(e.value, []);
      byValue.get(e.value).push(e.ref);
    }
    return [...byValue.entries()]
      .filter(([, refs]) => refs.length > 1)
      .map(([value, refs]) => ({ value, count: refs.length, refs: refs.sort() }))
      .sort((a, b) => a.value.localeCompare(b.value));
  };

  // Item-level vs variant-level: one string used both as a product code and
  // as a variant code. Legal today, incoherent under one namespace.
  const variantByValue = new Map();
  for (const e of variantLevel) {
    if (!variantByValue.has(e.value)) variantByValue.set(e.value, []);
    variantByValue.get(e.value).push(e.ref);
  }
  const crossLevel = [];
  for (const e of itemLevel) {
    const hits = variantByValue.get(e.value);
    if (hits) crossLevel.push({ value: e.value, itemLevel: e.ref, variantLevel: hits.slice(0, 10).sort() });
  }

  /* The one comparable case between the two concepts: a product barcode
   * string that is ALSO a printed lot-instance id. It can only happen if
   * somebody pasted an ObjectId into a barcode field, but that is exactly
   * the namespace confusion the merge has to rule out, and it is cheap to
   * check. Anything that is not ObjectId-shaped cannot collide with a lot
   * id and is not compared. */
  const OBJECT_ID = /^[0-9a-f]{24}$/i;
  const lotIds = new Set(barcodes.map((b) => String(b._id)));
  const productCodesMatchingLotIds = [...itemLevel, ...variantLevel]
    .filter((e) => OBJECT_ID.test(e.value) && lotIds.has(e.value.toLowerCase()))
    .map((e) => ({ value: e.value, holder: e.ref }))
    .sort((a, b) => a.value.localeCompare(b.value));

  return {
    productIdentifiers: {
      itemLevelValues: itemLevel.length,
      variantLevelValues: variantLevel.length,
      duplicateItemVsItem: capped(dupWithin(itemLevel)),
      duplicateVariantVsVariant: capped(dupWithin(variantLevel)),
      duplicateItemLevelVsVariantLevel: capped(crossLevel.sort((a, b) => a.value.localeCompare(b.value))),
      note: "StockItem.barcode and variants[].barcode are free strings with no uniqueness constraint at either level, and nothing stops one value being used at both levels.",
    },
    printedLotInstances: {
      documents: barcodes.length,
      comparable: false,
      reason:
        "The `barcodes` collection identifies a PRINTED LOT INSTANCE — one sticker on one physical lot of one raw-item variant — and its identity IS the document _id (the QR payload). It has no barcode-string field, so it shares no namespace with StockItem's product identifiers and cannot collide with them. Reporting them as one number would merge 'what kind of thing is this' with 'which physical roll is this'.",
      productCodesMatchingLotInstanceIds: capped(productCodesMatchingLotIds),
      crossCheckNote:
        "The only possible collision between the two concepts is a product barcode field containing an ObjectId that is also a printed lot id — a paste error rather than a duplicate. Only ObjectId-shaped values are compared; anything else is not comparable and is not counted.",
    },
    rawItemProductBarcodes: {
      exists: false,
      note: "RawItem has no product-barcode field at all. Raw materials are identified by SKU and by printed lot stickers only, so the future single namespace has to accommodate items that have never had a product code.",
    },
  };
}

/**
 * The same ObjectId existing in BOTH `rawitems` and `stockitems`.
 *
 * This matters for migration, not for hygiene: a Mongoose `ref` resolves an
 * id against a NAMED COLLECTION, so an id that exists in two collections is
 * two different documents, and any migration that reuses ids in a third
 * collection has to know whether that is already happening.
 */
function auditCrossCollectionIdCollisions({ rawItems = [], stockItems = [] }) {
  const rawIds = new Set(rawItems.map((i) => String(i._id)));
  const collisions = stockItems
    .map((s) => String(s._id))
    .filter((id) => rawIds.has(id))
    .sort();
  return {
    rawItemIds: rawIds.size,
    stockItemIds: stockItems.length,
    collidingIds: capped(collisions.map((id) => ({ id, presentIn: ["rawitems", "stockitems"] }))),
    note:
      "An ObjectId is unique per collection, not per database. A collision here means one id names two different documents, and a migration that reuses ids in a new Item collection must resolve it before, not after. Zero collisions does not make id reuse safe on its own — see the migration compatibility requirements in the product plan §4.1c.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Referencing: what points at an item
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An item is REFERENCED if any gathered document points at its ObjectId.
 * "Apparently unreferenced" is deliberately weak wording: several real
 * references are by NAME rather than id (Requisition lines, worksheet PO
 * lines, StockItem BOM name snapshots when the id is absent), and this
 * report does not gather manufacturing orders at all. An unreferenced item
 * is a CANDIDATE for archival review, never evidence that nothing uses it.
 */
function auditReferences({ rawItems = [], operationalPOs = [], mrfs = [], stockIssuances = [], stockLedgers = [], barcodes = [], stockItems = [] }) {
  const sources = new Map(); // itemId → Set(source)
  const note = (id, source) => {
    if (!id) return;
    const k = String(id);
    if (!sources.has(k)) sources.set(k, new Set());
    sources.get(k).add(source);
  };

  for (const po of operationalPOs) for (const i of po.items || []) note(i.rawItem, "operationalPO");
  for (const m of mrfs) for (const i of m.items || []) note(i.rawItem, "mrf");
  for (const s of stockIssuances) for (const i of s.items || []) note(i.rawItem, "stockIssuance");
  for (const l of stockLedgers) note(l.rawItem, "stockLedger");
  for (const b of barcodes) note(b.rawItem, "barcode");
  for (const s of stockItems) for (const v of s.variants || []) for (const r of v.rawItems || []) note(r.rawItemId, "stockItemBOM");

  const referenced = [];
  const unreferenced = [];
  for (const item of rawItems) {
    const id = String(item._id);
    const from = sources.get(id);
    const hasOwnHistory = (item.stockTransactions || []).length > 0;
    if (from) referenced.push({ id, sku: item.sku || "", sources: [...from].sort() });
    else unreferenced.push({ id, sku: item.sku || "", name: item.name || "", quantity: round4(Number(item.quantity) || 0), hasOwnMovementHistory: hasOwnHistory });
  }

  const bySource = {};
  for (const r of referenced) for (const s of r.sources) bySource[s] = (bySource[s] || 0) + 1;

  return {
    referencedItems: referenced.length,
    referencedBySource: Object.fromEntries(Object.keys(bySource).sort().map((k) => [k, bySource[k]])),
    apparentlyUnreferenced: capped(sortBy(unreferenced, (x) => x.sku || x.id)),
    limitation:
      "Reference detection is by ObjectId across the gathered collections only (operational POs, MRFs, StockIssuance, StockLedger, Barcode, StockItem BOM). Requisition and worksheet-PO lines name items as free text and cannot be matched; manufacturing orders are not gathered. 'Apparently unreferenced' therefore means 'no id reference found here', not 'unused'.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BOM and barcode integrity
// ─────────────────────────────────────────────────────────────────────────────

function auditBomAndBarcodes({ rawItems = [], stockItems = [], barcodes = [] }) {
  const itemIds = new Set(rawItems.map((i) => String(i._id)));
  const variantIndex = new Map(
    rawItems.map((i) => [String(i._id), new Set((i.variants || []).map((v) => String(v._id)))]),
  );

  const bomMissingItem = [];
  const bomMissingVariant = [];
  const bomParentMissing = [];
  let bomLines = 0;

  for (const s of stockItems) {
    for (const v of s.variants || []) {
      for (const r of v.rawItems || []) {
        bomLines += 1;
        const rawId = r.rawItemId ? String(r.rawItemId) : null;
        const ref = { stockItem: String(s._id), reference: s.reference || "", variantSku: v.sku || "", rawItemName: r.rawItemName || "" };
        if (!rawId || !itemIds.has(rawId)) { bomMissingItem.push({ ...ref, missingRawItem: rawId }); continue; }
        if (!r.variantId) continue; // a BOM line may legitimately name the item without a variant
        if (!variantIndex.get(rawId).has(String(r.variantId))) bomMissingVariant.push({ ...ref, rawItem: rawId, missingVariant: String(r.variantId) });
      }
    }
  }

  const barcodeMissingItem = [];
  const barcodeMissingVariant = [];
  for (const b of barcodes) {
    const rawId = b.rawItem ? String(b.rawItem) : null;
    const ref = { barcode: String(b._id), rawItemName: b.rawItemName || "" };
    if (!rawId || !itemIds.has(rawId)) { barcodeMissingItem.push({ ...ref, missingRawItem: rawId }); continue; }
    if (!b.variantId) continue;
    if (!variantIndex.get(rawId).has(String(b.variantId))) barcodeMissingVariant.push({ ...ref, rawItem: rawId, missingVariant: String(b.variantId) });
  }

  return {
    bomLines,
    bomReferencesToMissingItems: capped(sortBy(bomMissingItem, (x) => x.reference)),
    bomReferencesToMissingVariants: capped(sortBy(bomMissingVariant, (x) => x.reference)),
    bomParentMissing: capped(bomParentMissing),
    barcodes: barcodes.length,
    barcodeReferencesToMissingItems: capped(sortBy(barcodeMissingItem, (x) => x.barcode)),
    barcodeReferencesToMissingVariants: capped(sortBy(barcodeMissingVariant, (x) => x.barcode)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RawItem ↔ StockItem overlap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two catalogues exist: RawItem (materials) and StockItem (finished goods).
 * The target model has ONE Item master with a type, so anything appearing in
 * both is a decision somebody has to make.
 *
 * MATCHING IS CONSERVATIVE AND EXACT. Only two rules produce a candidate:
 *
 *   NAME_EXACT_NORMALISED   names equal after trim/case-fold/whitespace
 *                           collapse (including StockItem.additionalNames)
 *   CODE_EXACT_NORMALISED   RawItem.sku equals StockItem.reference under the
 *                           same normalisation
 *
 * No fuzzy matching, no substring matching, no token overlap. A candidate is
 * a prompt for a human to look, and nothing here is ever called a confirmed
 * duplicate — two records can share a name and be genuinely different things
 * (a "Cotton Twill" fabric and a "Cotton Twill" finished garment), which is
 * exactly why the rule is stated on every row.
 */
function auditCatalogueOverlap({ rawItems = [], stockItems = [] }) {
  const candidates = [];

  const rawByName = new Map();
  const rawBySku = new Map();
  for (const i of rawItems) {
    const n = normKey(i.name);
    if (n) { if (!rawByName.has(n)) rawByName.set(n, []); rawByName.get(n).push(i); }
    const s = normKey(i.sku);
    if (s) { if (!rawBySku.has(s)) rawBySku.set(s, []); rawBySku.get(s).push(i); }
  }

  for (const s of stockItems) {
    const names = [s.name, ...(s.additionalNames || [])].map(normKey).filter(Boolean);
    for (const n of new Set(names)) {
      for (const raw of rawByName.get(n) || []) {
        candidates.push({
          rule: "NAME_EXACT_NORMALISED",
          rawItem: String(raw._id), rawSku: raw.sku || "", rawName: raw.name || "",
          stockItem: String(s._id), stockReference: s.reference || "", stockName: s.name || "",
          matchedOn: n,
        });
      }
    }
    const ref = normKey(s.reference);
    for (const raw of rawBySku.get(ref) || []) {
      candidates.push({
        rule: "CODE_EXACT_NORMALISED",
        rawItem: String(raw._id), rawSku: raw.sku || "", rawName: raw.name || "",
        stockItem: String(s._id), stockReference: s.reference || "", stockName: s.name || "",
        matchedOn: ref,
      });
    }
  }

  // De-duplicate: one pair matched by both rules is one candidate carrying
  // both rules, not two candidates.
  const merged = new Map();
  for (const c of candidates) {
    const k = `${c.rawItem}|${c.stockItem}`;
    if (!merged.has(k)) merged.set(k, { ...c, rules: [c.rule] });
    else if (!merged.get(k).rules.includes(c.rule)) merged.get(k).rules.push(c.rule);
  }
  const out = [...merged.values()].map(({ rule, ...rest }) => ({ ...rest, rules: rest.rules.sort() }));

  return {
    rawItems: rawItems.length,
    stockItems: stockItems.length,
    candidates: capped(sortBy(out, (x) => `${x.rawSku}${x.stockReference}`)),
    rulesApplied: [
      { rule: "NAME_EXACT_NORMALISED", definition: "RawItem.name equals StockItem.name or one of StockItem.additionalNames after trim, case-fold and whitespace collapse." },
      { rule: "CODE_EXACT_NORMALISED", definition: "RawItem.sku equals StockItem.reference under the same normalisation." },
    ],
    limitation:
      "CANDIDATES ONLY — never confirmed duplicates. Exact normalised matching cannot find a genuine overlap recorded under two different names, and a name collision between a material and a finished good is legitimate. Every candidate needs a human decision; no fuzzy matching was used, deliberately.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Budget / accounting attribution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Budget attribution — what is COMMITTED, what is PAUSED, what is PROPOSED.
 *
 * ── IMPLEMENTATION STATE, CLASSIFIED FROM `HEAD` AND NOT FROM THE WORKTREE ──
 * A file present in the working tree is not shipped behaviour. Classified
 * against the committed tree:
 *
 *   COMMITTED Store baseline — **no item-wise budget attribution authority
 *     of any kind.** `RawItem.budgetLedgerId`, `budgetLedgerName` and the
 *     setter audit fields do NOT exist in HEAD.
 *   PAUSED / UNCOMMITTED — the whole item-wise attribution initiative: the
 *     RawItem override fields above, `Acc_ItemCategoryBudget`,
 *     `services/itemBudgetHead.service.js`, the request-line
 *     `budgetAllocation` fields on IntakeRequest/SpendRequest, and the
 *     related API and frontend work. None of it is in HEAD.
 *   PROPOSED — a company-scoped `ItemAccountingProfile` (product plan
 *     §4.1a). Nothing implements it.
 *
 * So a database may legitimately contain none of this. Every input below is
 * optional and its absence is a reported STATE, never zero coverage.
 *
 * ── WHY COVERAGE MUST BE COMPANY-SAFE ───────────────────────────────────────
 * `RawItem` carries no company at all, while `Acc_Ledger` and the category
 * mapping are both company-scoped. A single global override therefore CANNOT
 * safely answer for every company: an override pointing at Company A's
 * ledger is not Company B's answer, and treating it as one would silently
 * attribute B's spending to a head in A's books.
 *
 * This report therefore evaluates every item **per company**, and an item
 * whose override belongs to another company falls through to that company's
 * category coverage rather than being excluded from it.
 *
 * ── DISCOVERED RISK (documented, NOT fixed in Chunk 0) ──────────────────────
 * The paused resolver `services/itemBudgetHead.service.js` returns the item
 * override in `headForItem()` **before any company validation** — the
 * company-scoped `categoryMap(companyId)` is consulted only on the fallback
 * path, and `assertMappable(ledgerId, companyId)` guards the WRITE path that
 * sets a category mapping, not this read. An override set against one
 * company's ledger is therefore returned as the answer when resolving for
 * another. Recorded here as a finding for whoever resumes that work; Chunk 0
 * changes no application behaviour.
 */
const BUDGET_COVERAGE_STATES = {
  MAPPING_COLLECTION_ABSENT: "the category→head mapping collection was not present in this database, so category coverage is UNKNOWN — not zero, and never 'never reviewed'",
  CATEGORY_NEVER_REVIEWED: "no mapping row exists for this category in this company",
  MAPPED_WITHOUT_HEAD: "a mapping row exists but names no budget head — reviewed and deliberately left unmapped, or incomplete",
  CATEGORY_MAPPED: "the category resolves to a budget head for this company",
  ITEM_OVERRIDE_COMPANY_MATCH: "the item's override names a ledger belonging to the company being evaluated — a valid answer for THIS company",
  ITEM_OVERRIDE_COMPANY_MISMATCH: "the item's override names a ledger belonging to a DIFFERENT company; it is not this company's answer, so this company's category coverage is evaluated instead",
  ITEM_OVERRIDE_COMPANY_UNVERIFIABLE: "the item carries an override but ledger data was not gathered, so which company owns the target cannot be checked",
  OVERRIDE_TO_MISSING_LEDGER: "the item's override names a ledger that does not exist",
  NO_CATEGORY_AND_NO_OVERRIDE: "the item has neither a category to map nor an override",
};

const BUDGET_IMPLEMENTATION_STATUS = {
  committedStoreBaseline:
    "NO item-wise budget attribution authority. RawItem.budgetLedgerId / budgetLedgerName / setter audit fields are NOT in HEAD.",
  pausedUncommitted:
    "The item override fields, Acc_ItemCategoryBudget, services/itemBudgetHead.service.js, request-line budgetAllocation on IntakeRequest/SpendRequest, and the related API and frontend work — all present in the working tree, none in HEAD.",
  proposedTarget:
    "Company-scoped ItemAccountingProfile (product plan §4.1a). Nothing implements it.",
  discoveredRisk:
    "The paused resolver returns an item override before validating that the target ledger belongs to the company being resolved for (services/itemBudgetHead.service.js headForItem). Documented as a risk for whoever resumes that work; not fixed in Chunk 0.",
};

function auditBudgetAttribution({
  rawItems = [],
  itemCategoryBudgets = null,
  ledgers = null,
  companies = null,
} = {}) {
  const mappingAvailable = Array.isArray(itemCategoryBudgets);
  const ledgersAvailable = Array.isArray(ledgers);
  const companiesAvailable = Array.isArray(companies);
  const ledgerById = ledgersAvailable ? new Map(ledgers.map((l) => [String(l._id), l])) : null;
  const companyIds = companiesAvailable ? new Set(companies.map((c) => String(c._id))) : null;

  const overridden = rawItems.filter((i) => i.budgetLedgerId);

  // ── Override targets, independent of any one company ──────────────────
  const overrideTargets = { missingLedger: [], byLedgerCompany: {}, unverifiable: overridden.length };
  if (ledgersAvailable) {
    overrideTargets.unverifiable = 0;
    for (const i of overridden) {
      const ledger = ledgerById.get(String(i.budgetLedgerId));
      if (!ledger) {
        overrideTargets.missingLedger.push({ id: String(i._id), sku: i.sku || "", missingLedger: String(i.budgetLedgerId) });
        continue;
      }
      const company = ledger.companyId ? String(ledger.companyId) : "(ledger has no company)";
      overrideTargets.byLedgerCompany[company] = (overrideTargets.byLedgerCompany[company] || 0) + 1;
    }
  }

  const noCategoryNoOverride = rawItems.filter(
    (i) => !i.budgetLedgerId && !String(i.category || "").trim() && !String(i.customCategory || "").trim(),
  );

  // ── THE COMPANY UNIVERSE ──────────────────────────────────────────────
  // The committed company master is the authority. Deriving companies from
  // mapping rows and override targets alone — which an earlier version did —
  // makes a real company with no budget configuration DISAPPEAR from the
  // report, and a company that has configured nothing is exactly the one a
  // reader needs to see.
  const universe = new Set();
  if (companiesAvailable) for (const c of companies) universe.add(String(c._id));

  // Companies named by data but absent from the master are integrity
  // findings, not additional companies to trust. They are still evaluated —
  // silently dropping them would hide the very rows that are wrong.
  const mappingCompaniesNotInMaster = new Set();
  const ledgerCompaniesNotInMaster = new Set();

  if (mappingAvailable) {
    for (const m of itemCategoryBudgets) {
      const c = m.companyId ? String(m.companyId) : "(no company)";
      universe.add(c);
      if (companiesAvailable && !companyIds.has(c)) mappingCompaniesNotInMaster.add(c);
    }
  }
  if (ledgersAvailable) {
    for (const i of overridden) {
      const ledger = ledgerById.get(String(i.budgetLedgerId));
      if (!ledger?.companyId) continue;
      const c = String(ledger.companyId);
      universe.add(c);
      if (companiesAvailable && !companyIds.has(c)) ledgerCompaniesNotInMaster.add(c);
    }
  }

  const mappingsByCompany = new Map();
  if (mappingAvailable) {
    for (const m of itemCategoryBudgets) {
      const c = m.companyId ? String(m.companyId) : "(no company)";
      if (!mappingsByCompany.has(c)) mappingsByCompany.set(c, new Map());
      mappingsByCompany.get(c).set(normKey(m.categoryKey || m.category), m);
    }
  }

  const companyNames = companiesAvailable
    ? new Map(companies.map((c) => [String(c._id), c.companyName || ""]))
    : new Map();

  const perCompany = [];
  for (const company of [...universe].sort((a, b) => a.localeCompare(b))) {
    const rows = mappingsByCompany.get(company) || new Map();
    const tally = {
      ITEM_OVERRIDE_COMPANY_MATCH: 0,
      ITEM_OVERRIDE_COMPANY_MISMATCH: 0,
      ITEM_OVERRIDE_COMPANY_UNVERIFIABLE: 0,
      OVERRIDE_TO_MISSING_LEDGER: 0,
      CATEGORY_MAPPED: 0,
      MAPPED_WITHOUT_HEAD: 0,
      CATEGORY_NEVER_REVIEWED: 0,
      MAPPING_COLLECTION_ABSENT: 0,
      NO_CATEGORY_AND_NO_OVERRIDE: 0,
    };
    const neverReviewedCategories = new Set();

    for (const item of rawItems) {
      // 1. Does this item's own override answer for THIS company?
      if (item.budgetLedgerId) {
        if (!ledgersAvailable) { tally.ITEM_OVERRIDE_COMPANY_UNVERIFIABLE += 1; continue; }
        const ledger = ledgerById.get(String(item.budgetLedgerId));
        if (!ledger) { tally.OVERRIDE_TO_MISSING_LEDGER += 1; continue; }
        if (ledger.companyId && String(ledger.companyId) === company) {
          tally.ITEM_OVERRIDE_COMPANY_MATCH += 1;
          continue;
        }
        // Another company's head. NOT this company's answer — so the item is
        // ALSO evaluated against this company's category coverage below.
        // The two counts are different dimensions of one item, never
        // mutually exclusive buckets.
        tally.ITEM_OVERRIDE_COMPANY_MISMATCH += 1;
      }

      // 2. Category coverage for this company.
      const key = normKey(item.customCategory || item.category || "");
      if (!key) {
        if (!item.budgetLedgerId) tally.NO_CATEGORY_AND_NO_OVERRIDE += 1;
        continue;
      }
      // Absence of the mapping collection is UNKNOWN coverage. Calling it
      // "never reviewed" would blame the data for a feature that may simply
      // not be deployed.
      if (!mappingAvailable) { tally.MAPPING_COLLECTION_ABSENT += 1; continue; }
      const row = rows.get(key);
      if (!row) { tally.CATEGORY_NEVER_REVIEWED += 1; neverReviewedCategories.add(key); continue; }
      if (row.budgetLedgerId) tally.CATEGORY_MAPPED += 1;
      else tally.MAPPED_WITHOUT_HEAD += 1;
    }

    perCompany.push({
      companyId: company,
      companyName: companyNames.get(company) || "",
      inCompanyMaster: companiesAvailable ? companyIds.has(company) : null,
      hasBudgetConfiguration: rows.size > 0,
      mappingRows: rows.size,
      itemsEvaluated: rawItems.length,
      states: tally,
      categoriesNeverReviewed: capped([...neverReviewedCategories].sort().map((c) => ({ category: c }))),
    });
  }

  return {
    status: BUDGET_IMPLEMENTATION_STATUS,
    companyUniverse: {
      source: companiesAvailable ? "COMPANY_MASTER" : "DERIVED_FROM_DATA_ONLY",
      complete: companiesAvailable,
      companyMasterGathered: companiesAvailable,
      companiesInMaster: companiesAvailable ? companies.length : null,
      companiesEvaluated: perCompany.length,
      companiesWithNoBudgetConfiguration: perCompany.filter((c) => !c.hasBudgetConfiguration).length,
      mappingCompanyIdsNotInMaster: capped([...mappingCompaniesNotInMaster].sort().map((id) => ({ companyId: id }))),
      ledgerCompanyIdsNotInMaster: capped([...ledgerCompaniesNotInMaster].sort().map((id) => ({ companyId: id }))),
      note: companiesAvailable
        ? "Every company in the committed company master is evaluated, including those with no mapping rows, no override-target ledgers and no budget configuration at all. Company ids named by mappings or ledgers but absent from the master are reported as integrity findings, not treated as trustworthy companies."
        : "THE COMPANY UNIVERSE IS INCOMPLETE. The company master was not gathered, so companies were derived from mapping rows and override-target ledgers only — a real company with no budget configuration does not appear here at all, and no claim is made that every company was evaluated.",
    },
    mappingCollection: {
      gathered: mappingAvailable,
      state: mappingAvailable ? "PRESENT" : "MAPPING_COLLECTION_ABSENT",
      rows: mappingAvailable ? itemCategoryBudgets.length : null,
      companiesEvaluated: perCompany.length,
    },
    ledgerData: {
      gathered: ledgersAvailable,
      note: ledgersAvailable
        ? "Override targets and their owning company were checked."
        : "Ledgers were not gathered, so no override's target or owning company could be checked — every override is ITEM_OVERRIDE_COMPANY_UNVERIFIABLE.",
    },
    itemOverrides: {
      itemsWithOverride: overridden.length,
      overridesMissingDisplaySnapshot: overridden.filter((i) => !String(i.budgetLedgerName || "").trim()).length,
      targetLedgerCompanies: Object.fromEntries(
        Object.keys(overrideTargets.byLedgerCompany).sort().map((k) => [k, overrideTargets.byLedgerCompany[k]]),
      ),
      overridesToMissingLedger: capped(sortBy(overrideTargets.missingLedger, (x) => x.sku || x.id)),
      overridesWithUnverifiableCompany: overrideTargets.unverifiable,
      unsafeBecauseItemHasNoCompanyScope: {
        count: overridden.length,
        reason:
          "RawItem has no companyId. An override is therefore a single global value applied to every company that reads the item, while the ledger it points at belongs to exactly one company.",
      },
    },
    itemsWithNoCategoryAndNoOverride: capped(
      noCategoryNoOverride.map((i) => ({ id: String(i._id), sku: i.sku || "", name: i.name || "" })),
    ),
    perCompanyCoverage: perCompany,
    coverageStates: BUDGET_COVERAGE_STATES,
    stateSemantics:
      "The per-company state counts are NOT mutually exclusive and must never be summed into a coverage percentage. One item can be counted as ITEM_OVERRIDE_COMPANY_MISMATCH *and* under a category state for the same company: the override is not that company's answer, so its category is evaluated as well. They are two dimensions of one item.",
    limitation:
      "Attributability is company-specific and this report never collapses it into one figure. An override belonging to Company A is NOT Company B's answer: for B the item falls through to B's category coverage and is counted as ITEM_OVERRIDE_COMPANY_MISMATCH, not excluded. Where ledgers were not gathered, override ownership is unverifiable rather than assumed valid. Where the mapping collection is absent, category coverage is UNKNOWN (MAPPING_COLLECTION_ABSENT) rather than zero or 'never reviewed'. Where the company master was not gathered, the company universe is incomplete and is labelled as such. No production coverage figure may be quoted from anything but an authorised run against a real database.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reorder policy fields
// ─────────────────────────────────────────────────────────────────────────────

/**
 * min/max live on the item AND on every variant, with the variant falling
 * back to the item's value at write time in some routes and not others.
 * The target model moves them to a ReorderPolicy per location — which does
 * not exist, so nothing here is location-aware.
 */
function auditReorderFields(rawItems) {
  let itemsWithMin = 0;
  let itemsWithMax = 0;
  let variantsWithOwnMin = 0;
  const maxBelowMin = [];
  for (const i of rawItems) {
    const min = Number(i.minStock) || 0;
    const max = Number(i.maxStock) || 0;
    if (min > 0) itemsWithMin += 1;
    if (max > 0) itemsWithMax += 1;
    if (max > 0 && max < min) maxBelowMin.push({ id: String(i._id), sku: i.sku || "", minStock: min, maxStock: max });
    for (const v of i.variants || []) if (Number(v.minStock) > 0) variantsWithOwnMin += 1;
  }
  return {
    itemsWithMinStock: itemsWithMin,
    itemsWithMaxStock: itemsWithMax,
    variantsWithOwnMinStock: variantsWithOwnMin,
    maxBelowMin: capped(sortBy(maxBelowMin, (x) => x.sku || x.id)),
    locationAware: false,
    note:
      "min/max are global per item (and per variant), never per warehouse or location — no stock-bearing record carries a location at all. Safety stock, reorder point, reorder quantity, preferred supplier and lead-time assumptions have no field anywhere; the target ReorderPolicy introduces them.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The item-master report
// ─────────────────────────────────────────────────────────────────────────────

const CONTROLLED_RAW_ITEM_CATEGORIES = [
  "Fabric", "Thread", "Fasteners", "Elastic", "Interlining",
  "Trims", "Chemicals", "Patterns", "Labels", "Packaging",
  "Accessories", "Dyes", "Buttons", "Zippers", "Laces",
  "Ribbons", "Cords", "Tapes", "Piping", "Webbing",
];

function computeItemMasterReport(data = {}) {
  const {
    rawItems = [], stockItems = [], units = [], vendors = [], barcodes = [],
    operationalPOs = [], mrfs = [], stockIssuances = [], stockLedgers = [],
    // Optional and NULLABLE by design: absent means "not gathered / not
    // deployed", which is a different answer from "empty".
    itemCategoryBudgets = null, ledgers = null, companies = null,
  } = data;

  return {
    skuIdentity: auditSkus(rawItems),
    nameIdentity: auditNames(rawItems),
    categoryIdentity: {
      ...auditDualField(rawItems, "category", "customCategory"),
      ...categoryIdentities(rawItems, CONTROLLED_RAW_ITEM_CATEGORIES),
      note:
        "There is no Category collection. `category` is validated against a hard-coded list in routes/CMS_Routes/Inventory/Products/rawItems.js; `customCategory` is free text and bypasses it. Reads disagree about which wins.",
    },
    unitIdentity: {
      ...auditDualField(rawItems, "unit", "customUnit"),
      note: "Same shape as category: `customUnit || unit` in most reads, `unit` in others. Neither is an id — the Unit master is joined by NAME.",
    },
    unitConversions: auditUnitConversions({ units, rawItems }),
    balancesAndVariants: auditBalancesAndVariants(rawItems),
    typeAndLifecycle: auditTypeAndLifecycle({ rawItems, stockItems }),
    supplierRelationships: auditSupplierRelationships({ rawItems, vendors }),
    references: auditReferences({ rawItems, operationalPOs, mrfs, stockIssuances, stockLedgers, barcodes, stockItems }),
    bomAndBarcodes: auditBomAndBarcodes({ rawItems, stockItems, barcodes }),
    stockItemHygiene: auditStockItems({ stockItems, units }),
    barcodeIdentity: auditBarcodeIdentity({ stockItems, barcodes }),
    crossCollectionIdCollisions: auditCrossCollectionIdCollisions({ rawItems, stockItems }),
    catalogueOverlap: auditCatalogueOverlap({ rawItems, stockItems }),
    budgetAttribution: auditBudgetAttribution({ rawItems, itemCategoryBudgets, ledgers, companies }),
    reorderFields: auditReorderFields(rawItems),
    limitations: [
      "Both catalogues are measured: RawItem and StockItem each get their own identity, balance and reference hygiene, because the target model merges them into one governed Item.",
      "SKU pattern classification recognises the shapes the code is known to mint. A human-chosen SKU that happens to match one of them is misclassified as generated, and a generated shape this report does not know is reported as HUMAN_OR_UNKNOWN.",
      "RawItem↔StockItem overlap uses exact normalised matching only. Candidates are prompts for review; no fuzzy matching was used and nothing is called a confirmed duplicate.",
      "'Apparently unreferenced' means no ObjectId reference was found in the gathered collections. Requisition and worksheet-PO lines reference items by free text, and manufacturing orders are not gathered.",
      "Supplier relationships exist at three layers (primaryVendor, alternateVendors[], variants[].vendorNicknames[]) and all three are measured. Only the variant layer carries a supplier code, price or lead time. An item with none of the three has NO CONFIGURED SUPPLIER RELATIONSHIP — which is not the same as having no supplier, since PO history and free-text documents may name one.",
      "The COMMITTED Store baseline has NO item-wise budget attribution authority at all: the RawItem override fields, the category mapping and the request-line allocation fields are none of them in HEAD. Everything measured here belongs to paused, uncommitted work that may not be deployed.",
      "Budget attributability is company-specific and is never collapsed into one figure. RawItem carries no company while ledgers and mappings do, so a global override cannot answer for every company: an override targeting another company's ledger is reported as ITEM_OVERRIDE_COMPANY_MISMATCH and the item is evaluated against THIS company's category coverage instead of being excluded from it. Without ledger data, override ownership is unverifiable rather than assumed valid.",
      "Product barcodes (StockItem item/variant strings) and printed lot-instance identifiers (the `barcodes` collection, whose identity is the document _id) are different concepts and are reported separately. Only ObjectId-shaped product codes are cross-checked against lot ids, because nothing else can collide.",
      "StockItem has no movement ledger of any kind, so every finished-goods balance is unexplained by construction — the count is the whole populated catalogue, not a defect list.",
      "HSN and tax-classification counts are completeness figures. Whether either is REQUIRED depends on item type and sales channel, which no field records today.",
      "Item type and lifecycle are SCHEMA gaps, not data gaps: no field exists to be filled in, so the counts are the whole catalogue by construction.",
      "Conversion findings cover the Unit master and item/variant-level conversions. Whether a stated factor is physically CORRECT is unknowable from data; only absence, invalidity, self-reference, contradiction and cycles are detectable.",
      "Reorder measurements are global per item/variant. Location-aware reorder policy cannot be assessed because no record carries a location.",
    ],
  };
}

function renderItemMasterSummary(r) {
  const L = [];
  const push = (s = "") => L.push(s);
  push("── Item master: identity ──");
  push(`  Items: ${r.skuIdentity.totalItems}; missing SKU: ${r.skuIdentity.missingSku.total}; exact duplicate SKUs: ${r.skuIdentity.exactDuplicateSkus.total}; normalised-only duplicates: ${r.skuIdentity.normalisedDuplicateSkus.total}`);
  push(`  SKU shapes: ${JSON.stringify(r.skuIdentity.generatedSkuPatterns)}`);
  push(`  Missing names: ${r.nameIdentity.missingName.total}; duplicate-name groups: ${r.nameIdentity.duplicateNameGroups.total} (${r.nameIdentity.duplicateNameDocuments} items)`);
  push("");
  push("── Item master: category and unit ──");
  push(`  category vs customCategory — conflicts: ${r.categoryIdentity.conflict.total}, custom-only: ${r.categoryIdentity.customOnly}, uncategorised: ${r.categoryIdentity.neither.total}`);
  push(`  Distinct category identities: ${r.categoryIdentity.distinctIdentities}, outside the controlled list: ${r.categoryIdentity.outsideControlledList.total}`);
  push(`  unit vs customUnit — conflicts: ${r.unitIdentity.conflict.total}, custom-only: ${r.unitIdentity.customOnly}, no unit at all: ${r.unitIdentity.neither.total}`);
  push("");
  push("── Item master: conversions ──");
  const c = r.unitConversions;
  push(`  Units: ${c.unitsInMaster} (${c.unitsWithNoConversions} with no conversions); item-level conversions: ${c.itemLevelConversions} (${c.variantsUsingLegacySingleField} still on the legacy single field)`);
  push(`  missing target: ${c.missingTarget.total}; zero/invalid: ${c.zeroOrInvalid.total}; self: ${c.selfConversions.total}; reciprocal pairs: ${c.reciprocalPairs.total} (${c.inconsistentReciprocals} not exact inverses); ambiguous: ${c.ambiguous.total}; cycles: ${c.cycles.total}`);
  push("");
  push("── Item master: balances and variants ──");
  const b = r.balancesAndVariants;
  push(`  Variants: ${b.variantTotal} across ${b.itemsWithVariants} items`);
  push(`  item balance ≠ variant total: ${b.itemVsVariantBalanceMismatch.total}; balance with no movement history: ${b.balanceWithNoMovementHistory.total}`);
  push(`  duplicate variant combinations: ${b.duplicateVariantCombinations.total}; missing variant SKU: ${b.missingVariantSku.total}; duplicate variant SKUs: ${b.duplicateVariantSkus.total}; default '-var' collisions: ${b.defaultVariantSkuCollisions.total}`);
  push("");
  push("── Item master: type, lifecycle, suppliers ──");
  push(`  Items with an explicit item type: ${r.typeAndLifecycle.rawItems.withExplicitItemType} of ${r.typeAndLifecycle.rawItems.total} (schema has no such field)`);
  push(`  Archive capability: ${r.typeAndLifecycle.lifecycle.archiveCapability} — the only removal is a hard delete that destroys history`);
  const sup = r.supplierRelationships;
  push(`  Supplier layers — primary: ${sup.layers.itemsWithPrimarySupplier} items · alternates: ${sup.layers.itemsWithAlternateSuppliers} items (${sup.layers.alternateSupplierReferences} refs) · variant aliases: ${sup.layers.variantSupplierAliases} on ${sup.layers.itemsWithVariantSupplierAliases} items`);
  push(`  Items with NO CONFIGURED supplier relationship at any layer: ${sup.itemsWithNoConfiguredSupplierRelationship.total} (history may still name a supplier)`);
  push(`  Dangling supplier refs: ${sup.danglingReferences.total} (primary ${sup.danglingReferences.primaryVendor.total}, alternates ${sup.danglingReferences.alternateVendors.total}, aliases ${sup.danglingReferences.variantAliases.total})`);
  push(`  Same supplier at multiple layers: ${sup.sameSupplierAtMultipleLayers.total}; duplicate aliases per supplier+variant: ${sup.duplicateAliasesPerSupplierPerVariant.total}; aliases missing identity: ${sup.aliasesMissingIdentity.total}`);
  push(`  Aliases carrying commercials — price: ${sup.commercialDataOnAliases.aliasesCarryingPrice}, lead time: ${sup.commercialDataOnAliases.aliasesCarryingLeadTime}`);
  push("");
  push("── Item master: StockItem (the second catalogue) ──");
  const si = r.stockItemHygiene;
  push(`  Finished goods: ${si.totalStockItems} items, ${si.variantTotal} variants`);
  push(`  reference — missing: ${si.referenceIdentity.missingReference.total}, exact duplicates: ${si.referenceIdentity.exactDuplicates.total}, normalised-only: ${si.referenceIdentity.normalisedDuplicates.total}`);
  push(`  names — missing: ${si.nameIdentity.missingName.total}, duplicate groups (incl. aliases): ${si.nameIdentity.duplicateNameGroups.total}`);
  push(`  units not in the Unit master: ${si.uomIdentity.unitsNotInMaster.total} of ${si.uomIdentity.distinctUnitNames} distinct names`);
  push(`  productType/trackInventory contradictions: ${si.productTypeAndTracking.contradictions.total}; SERVICE items holding stock: ${si.productTypeAndTracking.serviceItemsCarryingInventoryBalance.total}`);
  push(`  (barcode identity is reported across the whole namespace below)`);
  push(`  variant SKUs — missing: ${si.variantIdentity.missingVariantSku.total}, exact duplicates: ${si.variantIdentity.exactDuplicateVariantSkus.total}, normalised-only: ${si.variantIdentity.normalisedDuplicateVariantSkus.total}, system-shaped: ${si.variantIdentity.systemShapedVariantSkus}; min/max errors: ${si.variantIdentity.minMaxErrors.total}`);
  push(`  totalQuantityOnHand ≠ variant total: ${si.balances.headerVsVariantMismatch.total}; balances with NO movement ledger: ${si.balances.balancesWithNoMovementLedger.total} (StockItem has none, by construction)`);
  push(`  missing HSN: ${si.compliance.missingHsnCode.total}; missing tax classification: ${si.compliance.missingTaxClassification.total}`);
  push("");
  push("── Item master: barcode identity (one future namespace) ──");
  const bc = r.barcodeIdentity;
  push(`  Product codes — item-level values: ${bc.productIdentifiers.itemLevelValues}, variant-level values: ${bc.productIdentifiers.variantLevelValues}`);
  push(`    item vs item collisions          : ${bc.productIdentifiers.duplicateItemVsItem.total}`);
  push(`    variant vs variant collisions    : ${bc.productIdentifiers.duplicateVariantVsVariant.total}`);
  push(`    item-level vs variant-level      : ${bc.productIdentifiers.duplicateItemLevelVsVariantLevel.total}`);
  push(`  Printed lot instances: ${bc.printedLotInstances.documents} document(s), comparable with product codes: ${bc.printedLotInstances.comparable}`);
  push(`    ${bc.printedLotInstances.reason}`);
  push(`    product codes matching a lot-instance ObjectId: ${bc.printedLotInstances.productCodesMatchingLotInstanceIds.total} — ${bc.printedLotInstances.crossCheckNote}`);
  push(`  RawItem product-barcode field exists: ${bc.rawItemProductBarcodes.exists} — ${bc.rawItemProductBarcodes.note}`);
  push("");
  push("── Item master: references and overlap ──");
  push(`  Referenced items: ${r.references.referencedItems} ${JSON.stringify(r.references.referencedBySource)}`);
  push(`  Apparently unreferenced (review candidates): ${r.references.apparentlyUnreferenced.total}`);
  push(`  BOM lines: ${r.bomAndBarcodes.bomLines}; to missing items: ${r.bomAndBarcodes.bomReferencesToMissingItems.total}; to missing variants: ${r.bomAndBarcodes.bomReferencesToMissingVariants.total}`);
  push(`  Barcodes: ${r.bomAndBarcodes.barcodes}; to missing items: ${r.bomAndBarcodes.barcodeReferencesToMissingItems.total}; to missing variants: ${r.bomAndBarcodes.barcodeReferencesToMissingVariants.total}`);
  push(`  RawItem↔StockItem overlap CANDIDATES (exact normalised rules only): ${r.catalogueOverlap.candidates.total}`);
  push(`  ObjectIds present in BOTH rawitems and stockitems: ${r.crossCollectionIdCollisions.collidingIds.total} — a migration reusing ids must resolve these first`);
  push("");
  push("── Item master: budget attribution ──");
  const ba = r.budgetAttribution;
  push("  Implementation state (classified from HEAD, not the working tree):");
  push(`    committed Store baseline : ${ba.status.committedStoreBaseline}`);
  push(`    paused / uncommitted     : ${ba.status.pausedUncommitted}`);
  push(`    proposed target          : ${ba.status.proposedTarget}`);
  push(`    discovered risk          : ${ba.status.discoveredRisk}`);
  const cu = ba.companyUniverse;
  push(`  Company universe: ${cu.source}${cu.complete ? "" : " — INCOMPLETE, not every company was evaluated"}`);
  push(`    companies in master: ${cu.companyMasterGathered ? cu.companiesInMaster : "not gathered"} · evaluated: ${cu.companiesEvaluated} · with no budget configuration at all: ${cu.companiesWithNoBudgetConfiguration}`);
  if (cu.mappingCompanyIdsNotInMaster.total || cu.ledgerCompanyIdsNotInMaster.total) {
    push(`    INTEGRITY — company ids not in the company master: ${cu.mappingCompanyIdsNotInMaster.total} on mappings, ${cu.ledgerCompanyIdsNotInMaster.total} on override-target ledgers`);
  }
  push(`  Mapping collection: ${ba.mappingCollection.state}${ba.mappingCollection.gathered ? ` (${ba.mappingCollection.rows} rows)` : " — category coverage is UNKNOWN, not zero"}`);
  push(`  Ledger data: ${ba.ledgerData.gathered ? "gathered" : "NOT gathered — override company ownership is unverifiable"}`);
  push(`  Item overrides: ${ba.itemOverrides.itemsWithOverride} (missing display snapshot: ${ba.itemOverrides.overridesMissingDisplaySnapshot}; to a missing ledger: ${ba.itemOverrides.overridesToMissingLedger.total}; company unverifiable: ${ba.itemOverrides.overridesWithUnverifiableCompany})`);
  push(`    target ledger companies: ${JSON.stringify(ba.itemOverrides.targetLedgerCompanies)}`);
  push(`    structurally unsafe (item has no company scope): ${ba.itemOverrides.unsafeBecauseItemHasNoCompanyScope.count}`);
  push(`  Items with neither a category nor an override: ${ba.itemsWithNoCategoryAndNoOverride.total}`);
  push("  Per-company coverage — override dimension, then category dimension.");
  push("  NOTE: these counts are NOT mutually exclusive and must not be summed into a percentage;");
  push("        a mismatched override is ALSO evaluated against that company's categories.");
  for (const c of ba.perCompanyCoverage) {
    const st = c.states;
    const label = c.companyName ? `${c.companyId} (${c.companyName})` : c.companyId;
    const master = c.inCompanyMaster === false ? " [NOT IN COMPANY MASTER]" : "";
    push(`    company ${label}${master} — ${c.mappingRows} mapping row(s)${c.hasBudgetConfiguration ? "" : ", no budget configuration"}`);
    push(`      override : match ${st.ITEM_OVERRIDE_COMPANY_MATCH} · mismatch ${st.ITEM_OVERRIDE_COMPANY_MISMATCH} · unverifiable ${st.ITEM_OVERRIDE_COMPANY_UNVERIFIABLE} · missing ledger ${st.OVERRIDE_TO_MISSING_LEDGER}`);
    push(`      category : mapped ${st.CATEGORY_MAPPED} · mapped without head ${st.MAPPED_WITHOUT_HEAD} · never reviewed ${st.CATEGORY_NEVER_REVIEWED} · unknown (mapping absent) ${st.MAPPING_COLLECTION_ABSENT} · no category and no override ${st.NO_CATEGORY_AND_NO_OVERRIDE}`);
  }
  push("");
  push("── Item master: reorder policy ──");
  push(`  min/max set on ${r.reorderFields.itemsWithMinStock}/${r.reorderFields.itemsWithMaxStock} items; max below min: ${r.reorderFields.maxBelowMin.total}; location-aware: ${r.reorderFields.locationAware}`);
  push("");
  push("── Item master limitations ──");
  for (const l of r.limitations) push(`  • ${l}`);
  return L.join("\n");
}

module.exports = {
  computeItemMasterReport,
  renderItemMasterSummary,
  // exported for focused tests
  classifySku,
  auditSkus,
  auditNames,
  auditDualField,
  categoryIdentities,
  auditUnitConversions,
  auditBalancesAndVariants,
  auditTypeAndLifecycle,
  auditSupplierRelationships,
  auditStockItems,
  auditBarcodeIdentity,
  auditCrossCollectionIdCollisions,
  auditReferences,
  auditBomAndBarcodes,
  auditCatalogueOverlap,
  auditBudgetAttribution,
  auditReorderFields,
  groupByNormalised,
  CONTROLLED_RAW_ITEM_CATEGORIES,
  SKU_PATTERNS,
  BUDGET_COVERAGE_STATES,
  BUDGET_IMPLEMENTATION_STATUS,
};
