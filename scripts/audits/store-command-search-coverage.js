#!/usr/bin/env node
"use strict";
/**
 * scripts/audits/store-command-search-coverage.js
 *
 * AUDIT 1 OF 2 — STRUCTURAL. EVERY STORE CONCEPT IS ACCOUNTED FOR, OR THIS
 * FAILS.
 *
 * ── THE TWO AUDITS, AND WHY THEY ARE NOT ONE NUMBER ───────────────────────
 * This one asks: is every concept in every Store catalogue reachable, and by
 * a capability this person is actually allowed to use? It is a property of
 * the catalogue and the registry, and it needs no database.
 *
 * `store-command-behaviour.js` asks the different question: does a person
 * typing a real sentence get the right answer? That one seeds a Store and
 * reads the answers back.
 *
 * They were one report once, and the single number was read as both. 2,646
 * addressable concepts said nothing about the five sentences out of ten that
 * returned nothing — and the sentence count would say nothing about a
 * concept nobody has ever typed.
 *
 * ── WHY AN AUDIT AND NOT A FEW EXAMPLES ───────────────────────────────────
 * "Stock of macbook works" proves one concept. The Store catalogue has 181,
 * and the ones that quietly do not work are the ones nobody thought to type.
 * A feature claimed complete on a demo is a feature that is complete for the
 * demo.
 *
 * ── AND WHY THERE IS NO SECOND LIST ───────────────────────────────────────
 * The concepts are read from `storeSemanticContract` — the SAME catalogue the
 * assistant answers from. A hand-kept list of "what the palette supports"
 * would drift from it the first time a concept was added, and drift silently,
 * which is the failure this is supposed to catch.
 *
 * ── WHAT "COVERED" MEANS HERE, EXACTLY ───────────────────────────────────
 * ADDRESSABLE: typing a concept's own label or one of its aliases reaches it.
 * That is a real property and it is NOT the same as "the palette answers the
 * questions people ask". "store purchase order expected Date" is addressable;
 * "goods receipts expected in June 2026" is a sentence, and resolving it needs
 * an intent layer this audit deliberately does not claim.
 *
 * `REGRESSION_QUESTIONS` below is the honest companion: real phrasings,
 * reported separately, so a high coverage number can never be mistaken for a
 * product that answers them.
 *
 * Each concept is classified as exactly one of:
 *   direct     — its own words resolve to it, so typing them reaches it
 *   generic    — reached through a typed field/collection handler
 *   excluded   — deliberately out, with a durable reason
 *
 * A concept that is none of those fails the audit.
 *
 *   node scripts/audits/store-command-search-coverage.js
 *   node scripts/audits/store-command-search-coverage.js --json
 */

/* ── EVERY STORE CATALOGUE, NOT ONE OF THEM ────────────────────────────────
   The first version of this audit read `storeSemanticContract` alone and
   reported "181 of 181 covered". Store's concepts are spread across four
   catalogues and the real total is an order of magnitude larger, so that
   number was true of its own denominator and misleading about the product.
   An audit whose denominator is wrong is worse than no audit: it is a green
   light pointing the wrong way. */
const CATALOGUES = [
  ["store_records", require("../../services/storeSemanticContract")],
  ["inventory_item", require("../../services/inventoryItemContract")],
  ["inventory_location", require("../../services/inventoryLocationContract")],
  ["store_purchase_universal", require("../../services/storePurchaseUniversalContract")],
];

/* ── DELIBERATE EXCLUSIONS ─────────────────────────────────────────────────
   A concept here is reachable by the assistant but intentionally NOT offered
   as a palette answer, with the reason recorded. Keyed by concept id or by a
   `query` kind. Empty today: everything the catalogue exposes is answerable,
   because the palette runs the same capabilities. Entries are added here —
   never by deleting a concept — so an exclusion is always visible. */
const EXCLUDED = Object.freeze({});

/* ── WHICH CAPABILITY SERVES A CONCEPT, AND MAY THIS PERSON USE IT ────────
   A concept being in a catalogue does not make it answerable: something has
   to own it. Every capability publishes the concepts it answers in its own
   `metric` enum, so the map is read from the registry rather than written
   down here, and a concept owned by nothing is reported.

   The capability is then checked against the Store application floor — the
   two families the palette serves. A concept served only by, say, an HR
   capability is NOT a Store answer, however Store-shaped its words are. */
const registry = require("../../services/ai/toolRegistry");
const storeSearch = require("../../services/ai/storeCommandSearch.service");

function handlerIndex() {
  const index = new Map();
  for (const tool of registry._tools.values()) {
    const concepts = tool.parameters?.properties?.metric?.enum || [];
    for (const concept of concepts) {
      if (!index.has(concept)) index.set(concept, []);
      index.get(concept).push(tool);
    }
  }
  return index;
}

const HANDLERS = handlerIndex();
const STORE_HANDLERS = new Map([...HANDLERS].map(([concept, tools]) => [
  concept, tools.filter((tool) => storeSearch.APPLICATIONS.includes(tool.application)),
]));

/* Query kinds served by a typed handler rather than by one concept's own
   words: the person types a record identity and the handler reads the shape.
   These are "generic" rather than "direct" because the words that reach them
   are the record's, not the concept's. */
const GENERIC_QUERIES = new Set([
  "request_work_orders", "request_verification", "request_materials",
  "request_shortfalls", "request_issuance",
  "work_order_materials", "work_order_shortfalls",
]);

function classify() {
  const rows = [];
  for (const [catalogueId, contract] of CATALOGUES) {
    for (const definition of Object.values(contract.DEFINITIONS || {})) {
      rows.push(classifyOne(catalogueId, contract, definition));
    }
  }
  const by = (name) => rows.filter((r) => r.coverage === name);
  return {
    total: rows.length,
    unowned: rows.filter((r) => r.coverage !== "excluded" && !r.handlers.length && !r.foreignOnly),
    foreignOnly: rows.filter((r) => r.foreignOnly),
    byCatalogue: Object.fromEntries(CATALOGUES.map(([id]) => [
      id, rows.filter((r) => r.catalogue === id).length,
    ])),
    direct: by("direct"),
    generic: by("generic"),
    excluded: by("excluded"),
    unexplained: by("unexplained"),
    rows,
  };
}

function classifyOne(catalogueId, contract, definition) {
  const served = STORE_HANDLERS.get(definition.id) || [];
  const anyHandler = HANDLERS.get(definition.id) || [];
  const tag = (coverage, reason = null) => ({
    id: definition.id, query: definition.query, entity: definition.entity,
    catalogue: catalogueId, coverage, reason,
    handlers: served.map((tool) => tool.name),
    /* A concept whose only owner is outside Store & Purchase is reachable in
       the assistant and NOT an answer the palette may give. */
    foreignOnly: anyHandler.length > 0 && served.length === 0,
  });
  {
    const reason = EXCLUDED[definition.id] || EXCLUDED[definition.query] || null;
    if (reason) return tag("excluded", reason);

    /* Direct: the concept's own label resolves back to the concept, scoped to
       its entity — which is exactly what the palette does with what somebody
       typed. */
    const fromText = typeof contract.metricFromText === "function"
      ? contract.metricFromText
      : (text, opts) => contract.CATALOGUE?.resolveMetric?.(text, opts) || null;

    const resolved = fromText(definition.label, { entity: definition.entity });
    if (resolved && resolved.id === definition.id) return tag("direct");

    const byAlias = (definition.aliases || []).some((alias) => {
      const hit = fromText(alias, { entity: definition.entity });
      return hit && hit.id === definition.id;
    });
    if (byAlias) return tag("direct");

    if (GENERIC_QUERIES.has(definition.query)) {
      return tag("generic", `served by the ${definition.query} handler`);
    }
    return tag("unexplained");
  }
}


/* The behavioural half of this audit — real sentences, real records, real
   answers — is `store-command-behaviour.js`. It used to live here as a list
   of phrasings checked against the catalogue, which measured whether a
   sentence contained a concept's alias and NOT whether it was answered. Two
   of the ten it reported as resolving were answered with the wrong records,
   and three it reported as unresolved are answered correctly today. A
   measurement that can be wrong in both directions at once belongs nowhere
   near a coverage number. */

function main() {
  const out = classify();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({
      total: out.total,
      direct: out.direct.length,
      generic: out.generic.length,
      excluded: out.excluded.length,
      unexplained: out.unexplained.map((r) => r.id),
    }, null, 2)}\n`);
  } else {
    const line = (s = "") => process.stdout.write(`${s}\n`);
    const say = (k, v) => line(`   ${String(k).padEnd(40)} ${v}`);
    line();
    line("Store command-search coverage");
    say("concepts across every Store catalogue", out.total);
    for (const [id, n] of Object.entries(out.byCatalogue)) say(`  ${id}`, n);
    say("reachable by their own words", out.direct.length);
    say("served by a typed handler", out.generic.length);
    say("deliberately excluded", out.excluded.length);
    say("UNEXPLAINED", out.unexplained.length);
    say("served by an authorised Store capability", out.total - out.unowned.length - out.foreignOnly.length);
    say("owned by no capability at all", out.unowned.length);
    say("owned only OUTSIDE Store & Purchase", out.foreignOnly.length);
    line();
    for (const row of out.excluded) line(`   excluded  ${row.id} — ${row.reason}`);
    for (const row of out.unexplained) line(`   UNEXPLAINED  ${row.id} (${row.query})`);
    for (const row of out.foreignOnly.slice(0, 20)) {
      line(`   OUTSIDE STORE  ${row.id} — served only by ${(HANDLERS.get(row.id) || []).map((t) => t.name).join(", ")}`);
    }
    line();
    line(out.unexplained.length
      ? "   FAILED: a Store concept is addressable by the assistant and not by Cmd/Ctrl K."
      : "   Every Store concept is ADDRESSABLE by its own label or an alias.");
    line("   Real sentences are audited separately:");
    line("     node scripts/audits/store-command-behaviour.js");
    line();
  }
  process.exitCode = (out.unexplained.length || out.foreignOnly.length) ? 1 : 0;
}

if (require.main === module) main();

module.exports = {
  classify, EXCLUDED, GENERIC_QUERIES, CATALOGUES,
  handlerIndex, HANDLERS, STORE_HANDLERS,
};
