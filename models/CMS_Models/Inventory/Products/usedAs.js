// models/CMS_Models/Inventory/Products/usedAs.js
//
// "USED AS" — WHAT PART A STORE RAW ITEM PLAYS, AND WHERE IT MAY BE SELECTED.
//
// Store's `category` says what an item IS ("Zippers", "MCB board"). `usedAs`
// says what it is FOR — and only Store owns and maintains it. Merchandising
// reads it to decide whether an item may appear in a product BOM picker at all,
// so it is the one field that keeps electrical goods, machine spares, dies and
// factory consumables out of a garment's Materials & Trims and out of Sample
// Packaging. The excluded values below are never reachable from any picker
// section, by construction: no section maps to them.
//
// This is the SINGLE source of truth for the vocabulary, the picker section
// allow-lists and the migration classifier, so the model, the two pickers and
// the classify script cannot drift into disagreeing about what a value means.
"use strict";

/** The stored codes. Order is the order they read on a form. */
const USED_AS = Object.freeze({
  FABRIC: "FABRIC",
  TRIM: "TRIM",
  LABEL: "LABEL",
  GARMENT_ACCESSORY: "GARMENT_ACCESSORY",
  SAMPLE_PACKAGING: "SAMPLE_PACKAGING",
  FACTORY_CONSUMABLE: "FACTORY_CONSUMABLE",
  MACHINE_SPARE: "MACHINE_SPARE",
  ELECTRICAL_ITEM: "ELECTRICAL_ITEM",
  TOOL_OR_EQUIPMENT: "TOOL_OR_EQUIPMENT",
  NOT_FOR_PRODUCT_BOM: "NOT_FOR_PRODUCT_BOM",
  NOT_CLASSIFIED: "NOT_CLASSIFIED",
});

const USED_AS_VALUES = Object.freeze(Object.values(USED_AS));

/** The words shown to a person — never the raw code. */
const USED_AS_LABELS = Object.freeze({
  FABRIC: "Fabric",
  TRIM: "Trim",
  LABEL: "Label",
  GARMENT_ACCESSORY: "Garment accessory",
  SAMPLE_PACKAGING: "Sample packaging",
  FACTORY_CONSUMABLE: "Factory consumable",
  MACHINE_SPARE: "Machine spare",
  ELECTRICAL_ITEM: "Electrical item",
  TOOL_OR_EQUIPMENT: "Tool or equipment",
  NOT_FOR_PRODUCT_BOM: "Not for product BOM",
  NOT_CLASSIFIED: "Not classified",
});

/** The default for an item nobody has classified yet. */
const DEFAULT_USED_AS = USED_AS.NOT_CLASSIFIED;

/** The only values that may EVER appear in a product BOM picker. */
const PRODUCT_BOM_USED_AS = Object.freeze([
  USED_AS.FABRIC, USED_AS.TRIM, USED_AS.LABEL, USED_AS.GARMENT_ACCESSORY, USED_AS.SAMPLE_PACKAGING,
]);

/** Everything a picker must NEVER show. Stated so a test can assert it directly. */
const EXCLUDED_FROM_BOM = Object.freeze(
  USED_AS_VALUES.filter((v) => !PRODUCT_BOM_USED_AS.includes(v)),
);

/**
 * The two picker sections and the exact `usedAs` each may show. This is the
 * hard cap: a section can only ever surface the values listed here, so no
 * client query — a forged category, a widened filter — can reveal anything else.
 */
const SECTION = Object.freeze({ MATERIALS: "MATERIALS", PACKAGING: "PACKAGING" });
const SECTION_USED_AS = Object.freeze({
  [SECTION.MATERIALS]: Object.freeze([USED_AS.FABRIC, USED_AS.TRIM, USED_AS.LABEL, USED_AS.GARMENT_ACCESSORY]),
  [SECTION.PACKAGING]: Object.freeze([USED_AS.SAMPLE_PACKAGING]),
});

/**
 * A Merchandising development category → the single `usedAs` it selects.
 * A category the picker does not know maps to nothing, so it narrows to the
 * empty set rather than widening — the safe direction.
 */
const USED_AS_FOR_CATEGORY = Object.freeze({
  FABRIC: USED_AS.FABRIC,
  TRIM: USED_AS.TRIM,
  LABEL: USED_AS.LABEL,
  ACCESSORY: USED_AS.GARMENT_ACCESSORY,
  SAMPLE_PACKAGING: USED_AS.SAMPLE_PACKAGING,
});

/**
 * The allow-list of `usedAs` for a section, optionally narrowed to one
 * Merchandising category. The result is always a subset of the section's cap —
 * a category outside the section is ignored, never a way to widen.
 */
function allowedUsedAs(section, category = "") {
  const cap = SECTION_USED_AS[section] || SECTION_USED_AS[SECTION.MATERIALS];
  const c = String(category || "").trim().toUpperCase();
  if (!c) return [...cap];
  const one = USED_AS_FOR_CATEGORY[c];
  return one && cap.includes(one) ? [one] : [...cap];
}

const isUsedAs = (v) => USED_AS_VALUES.includes(String(v ?? "").trim().toUpperCase());
const usedAsLabel = (v) => USED_AS_LABELS[String(v ?? "").trim().toUpperCase()] || "";

/* ── THE MIGRATION CLASSIFIER ──────────────────────────────────────────────
   Maps a Store category (or its custom label) onto a `usedAs`, but ONLY for
   the obvious cases the task names. Anything ambiguous — a generic
   "Accessories", a bare "cable", a lone "pipe" — returns NOT_CLASSIFIED and is
   left for a person, because a wrong classification that nobody notices becomes
   a wrong picker result. Order matters: the more specific and more dangerous
   families (electrical, machine, tools) are tested BEFORE the garment ones so
   "electrical tape" never reads as a trim. */
const CLASSIFY_RULES = [
  { usedAs: USED_AS.ELECTRICAL_ITEM, words: ["electrical", "electric", "mcb", "socket", "wiring", "switchgear"] },
  { usedAs: USED_AS.MACHINE_SPARE, words: ["machine part", "machine parts", "machine spare", "spare part", "sewing machine part"] },
  { usedAs: USED_AS.TOOL_OR_EQUIPMENT, words: ["die", "dies", "drill", "drills", "tool", "tools", "equipment"] },
  { usedAs: USED_AS.FACTORY_CONSUMABLE, words: ["maintenance", "consumable", "consumables", "factory use", "housekeeping", "lubricant", "grease", "oil"] },
  { usedAs: USED_AS.SAMPLE_PACKAGING, words: ["polybag", "poly bag", "polybags", "carton", "cartons", "tissue", "wrapping", "sample box", "sample boxes", "packaging", "packing material", "packing materials"] },
  { usedAs: USED_AS.LABEL, words: ["label", "labels", "tag", "tags", "hangtag", "hangtags", "sticker", "stickers"] },
  { usedAs: USED_AS.FABRIC, words: ["fabric", "fabrics", "woven", "knit", "knitted", "lining", "interlining", "fusing", "fusible"] },
  { usedAs: USED_AS.TRIM, words: ["trim", "trims", "button", "buttons", "zipper", "zippers", "zip", "thread", "threads", "elastic", "tape", "lace", "garment cord", "drawcord", "drawstring"] },
];

/** Escape + whole-word-ish match, so "tag" does not fire inside "vintage". */
function hasWord(haystack, word) {
  const w = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z])${w}(?:[^a-z]|$)`, "i").test(haystack);
}

/**
 * Classify by the item's stored Store category (and custom label). Returns a
 * `usedAs` code, or NOT_CLASSIFIED when nothing obvious matches.
 */
function classifyByCategory(category = "", customCategory = "") {
  const text = `${String(category || "")} ${String(customCategory || "")}`.toLowerCase();
  if (!text.trim()) return USED_AS.NOT_CLASSIFIED;
  for (const rule of CLASSIFY_RULES) {
    if (rule.words.some((w) => hasWord(text, w))) return rule.usedAs;
  }
  return USED_AS.NOT_CLASSIFIED;
}

module.exports = {
  USED_AS, USED_AS_VALUES, USED_AS_LABELS, DEFAULT_USED_AS,
  PRODUCT_BOM_USED_AS, EXCLUDED_FROM_BOM,
  SECTION, SECTION_USED_AS, USED_AS_FOR_CATEGORY, allowedUsedAs,
  isUsedAs, usedAsLabel, classifyByCategory,
};
