"use strict";
/**
 * services/ai/storeVocabulary.js — the words GRAV people use for Store things.
 *
 * ── WHY A SEPARATE LIST ───────────────────────────────────────────────────
 * Cmd/Ctrl K understands a question when its words match a family's name or
 * one of its other names. The names in the contract are the catalogue's own;
 * the words people actually type are often not — "indent" for a material
 * request, "inward" for goods received, "godown" for a warehouse. Each was
 * met with "that wording has no exact meaning in Store".
 *
 * So the words people use live HERE, apart from the contract, each with when
 * it was added and why, and are folded into the family's names when the
 * contract is built. A word is added after somebody has typed it and been
 * refused — `scripts/reports/store-command-misses.js` lists those — and the
 * Store suites run with it, so a word that would collide with another
 * meaning fails before it ships.
 *
 * ── WHAT DOES NOT BELONG HERE ─────────────────────────────────────────────
 * A word that is not another NAME but a DECISION. "Open purchase orders" is
 * not a synonym: Store records issued and partly received, and which of
 * those "open" means is the owner's call. "Challan" could be a legacy
 * delivery or a dispatch challan; "PR" a purchase request or a purchase
 * requisition. Those wait for a decision rather than a guess.
 *
 * Keys are ENTITY_SPECS ids. No database, no model.
 */

const VOCABULARY = Object.freeze({
  material_request: [
    { word: "indent", added: "2026-10-08", why: "The usual word for a material request on the floor; refused before." },
  ],
  goods_receipt: [
    { word: "inward", added: "2026-10-08", why: "Goods received are 'inward' in the Store's own speech; refused before." },
    { word: "inward entry", added: "2026-10-08", why: "As 'inward'." },
  ],
  warehouse: [
    { word: "godown", added: "2026-10-08", why: "The common word for a warehouse; refused before." },
  ],
  purchase_order: [
    /* "po" is already a name, but a three-letter word is never stripped of
       its plural (that rule keeps "gas" from becoming "ga"), so "POs" was
       refused. The plural is named instead. */
    { word: "pos", added: "2026-10-08", why: "'POs' — the plural of an existing name too short to singularise." },
  ],
});

/** The extra words for one family. */
function vocabularyFor(entity) {
  return (VOCABULARY[entity] || []).map((entry) => entry.word);
}

module.exports = { VOCABULARY, vocabularyFor };
