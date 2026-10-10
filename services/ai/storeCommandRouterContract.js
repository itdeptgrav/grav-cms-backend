"use strict";
/**
 * services/ai/storeCommandRouterContract.js — what a router may choose, and
 * what is done with its choice. No model, no database.
 *
 * ── THE ROUTER'S ONE JOB ──────────────────────────────────────────────────
 * When the grammar cannot place somebody's words, a small model maps the
 * sentence onto a route the palette ALREADY has — a family, a concept, an
 * operation, a recorded status — and the deterministic layer answers it. The
 * model is a translator between English and the catalogue's own vocabulary.
 * It is never the source of an answer.
 *
 * This module is everything about that which can be decided without the
 * model, so it can be proved without one:
 *
 *   menuFor(tools, message)   the names the router may choose from, read from
 *                             the AUTHORISED capabilities only — never a
 *                             record, a figure, a document number or a person
 *   schemaFor(menu)           a closed JSON schema: every field an enum of
 *                             those names, or null
 *   promptFor(menu, message)  the sentence and the names. Nothing else.
 *   validate(choice, menu, message)
 *                             the choice re-checked against the menu, and the
 *                             one free-text field — a value — required to be
 *                             words the person actually typed
 *   sentenceFor(choice, menu, intent)
 *                             the choice written back as a sentence in the
 *                             catalogue's own words, which the ordinary path
 *                             then answers — with its own authorisation,
 *                             grounding and bounds, none of them skipped
 *
 * A choice that fails any check is discarded and the person gets the refusal
 * they would have had with no router at all.
 */

const { ENTITY_SPECS, DEFINITIONS_BY_ENTITY, WORKFLOW_BY_ENTITY } = require("../storePurchaseUniversalContract");
const legacy = require("../storeCollectionContext");
const { includesTerm, getSemanticCatalogue } = require("./semanticCatalogue");

const OPERATIONS = Object.freeze(["list", "count", "latest", "total", "show"]);
/** The most concept names offered at once. A small model chooses well from a short list. */
const MAX_CONCEPTS = 40;
const MAX_VALUE = 80;

const lower = (value) => String(value || "").toLowerCase().trim();
const tokens = (value) => lower(value).split(/[^a-z0-9]+/).filter((word) => word.length >= 3)
  /* Close enough to a stem for "orders"/"order", "received"/"receive". */
  .map((word) => word.slice(0, 5));

function plural(label) {
  const words = String(label).trim().split(/\s+/);
  const last = words[words.length - 1] || "";
  if (/(s|x|z|ch|sh)$/i.test(last)) return words.join(" ");
  const head = /[^aeiou]y$/i.test(last) ? last.replace(/y$/i, "ies") : `${last}s`;
  return [...words.slice(0, -1), head].join(" ");
}

/**
 * The words of a phrase, singular, with no length floor — "po" and "grn" are
 * whole names here, unlike in `tokens`, which ranks concepts and so ignores
 * short words.
 */
const STOP = new Set(["the", "of", "a", "an", "and", "or", "in", "on", "for", "to", "we", "our", "is", "are", "any", "all", "me", "show", "list", "how", "many", "much", "what", "which",
  /* "who" asks for the records themselves. "where" and "why" do not — they ask
     for a location and an explanation — and stay words a route must keep. */
  "who"]);
function words(phrase) {
  /* Filler is dropped BEFORE the plural is: "us" is not the plural of "u". */
  return new Set(lower(phrase).split(/[^a-z0-9]+/).filter((word) => word && !STOP.has(word) && !FILLER.has(word))
    .map((word) => (word.length > 3 ? word.replace(/(es|s)$/, "") : word.replace(/s$/, ""))));
}

/** Words that carry no constraint of their own. */
const FILLER = new Set([
  "do", "does", "did", "have", "has", "had", "got", "get", "give", "tell", "find", "see", "need",
  "us", "you", "i", "my", "it", "its", "this", "that", "these", "those", "there", "here",
  "still", "currently", "now", "please", "every", "some", "anything", "something", "everything",
  "be", "been", "being", "was", "were", "with", "by", "from", "at", "as", "about", "into", "up",
  "can", "could", "would", "should", "will", "use", "using", "kind", "type", "lot", "lots",
]);
/** The words an operation itself accounts for. */
const OPERATION_WORDS = Object.freeze({
  count: ["how many", "number", "count", "tally", "total number"],
  latest: ["latest", "newest", "recent", "most recent", "last"],
  total: ["total", "sum", "overall"],
  list: ["list", "all", "show", "every"],
  show: ["show", "open", "detail", "details"],
});
const stem = (word) => String(word).slice(0, 4);

/** How much of a phrase the sentence shares, 0..1. */
function overlap(sentence, phrase) {
  const have = new Set(tokens(sentence));
  const want = tokens(phrase);
  if (!want.length) return 0;
  return want.filter((word) => have.has(word)).length / want.length;
}

/**
 * The names a router may choose from, for THIS person.
 *
 * Families come from the authorised collection capabilities — a family whose
 * capability this person may not use is not on the menu, so a model cannot
 * name its way into it. Concepts are the catalogue's own phrases, narrowed to
 * the ones the sentence shares words with, because 2,600 names is not a menu.
 */
function menuFor(tools, message) {
  const authorised = new Set((tools || []).map((tool) => tool.name));
  const families = [];
  for (const spec of ENTITY_SPECS) {
    if (!authorised.has(`store_collection_${spec.id}_query`)) continue;
    const workflow = WORKFLOW_BY_ENTITY[spec.id];
    families.push({
      id: spec.id,
      label: spec.label,
      aliases: [...(spec.aliases || [])],
      plural: plural(spec.label),
      statuses: [...new Set((workflow?.fields || []).flatMap((field) => field.recorded || [])
        .map((value) => lower(String(value).replace(/[_-]+/g, " "))).filter(Boolean))],
      concepts: (DEFINITIONS_BY_ENTITY[spec.id] || []).map((d) => ({ phrase: d.aliases?.[0] || d.label })),
    });
  }
  for (const spec of legacy.ENTITY_SPECS) {
    if (!authorised.has(`store_legacy_collection_${spec.id}_query`)) continue;
    if (families.some((family) => family.label === spec.label)) continue;
    families.push({
      id: `legacy:${spec.id}`,
      label: spec.label,
      aliases: [],
      plural: plural(spec.label),
      statuses: [],
      concepts: (legacy.DEFINITIONS_BY_ENTITY[spec.id] || []).map((d) => ({ phrase: d.aliases?.[0] || d.label })),
    });
  }

  /* Concepts a capability answers about ONE named thing — "stock", "next po
     number" — from the catalogues the authorised claiming capabilities
     declare. They belong to no listable family. */
  const loose = [];
  const seenCatalogues = new Set();
  for (const tool of tools || []) {
    const id = tool.semantic?.catalogue;
    if (typeof tool.claim !== "function" || !id || seenCatalogues.has(id)) continue;
    seenCatalogues.add(id);
    for (const metric of Object.values(getSemanticCatalogue(id)?.metrics || {})) {
      loose.push({ phrase: metric.aliases?.[0] || metric.label, family: null });
    }
  }

  const keyed = new Map();
  const offer = (phrase, family) => {
    const key = family ? `${phrase} (${family.label})` : phrase;
    if (!keyed.has(key)) keyed.set(key, { key, phrase, family: family ? family.id : null });
  };
  for (const family of families) for (const concept of family.concepts) offer(concept.phrase, family);
  for (const concept of loose) offer(concept.phrase, null);
  const concepts = [...keyed.values()]
    .map((entry) => ({ ...entry, score: overlap(message, entry.phrase) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.key.length - b.key.length)
    .slice(0, MAX_CONCEPTS)
    .map(({ score: _score, ...entry }) => entry);

  return {
    families: families.map(({ concepts: _c, ...family }) => family),
    concepts,
    statuses: [...new Set(families.flatMap((family) => family.statuses))].sort(),
    operations: OPERATIONS,
  };
}

/** A closed schema: nothing the router returns can be anything but a name it was given. */
function schemaFor(menu) {
  const oneOf = (values) => ({ type: ["string", "null"], enum: [...values, null] });
  return {
    type: "object",
    properties: {
      family: oneOf(menu.families.map((family) => family.label)),
      concept: oneOf(menu.concepts.map((concept) => concept.key)),
      operation: { type: "string", enum: [...menu.operations] },
      status: oneOf(menu.statuses),
      value: { type: ["string", "null"], maxLength: MAX_VALUE },
    },
    required: ["family", "concept", "operation", "status", "value"],
    additionalProperties: false,
  };
}

const SYSTEM = [
  "You translate one search typed into a Store application into a route.",
  "Choose ONLY from the names you are given. Never invent a name.",
  "family: the kind of record the person is asking about, or null.",
  "concept: the field or figure they want, or null.",
  "operation: list (several records), count (how many), latest (the newest few),",
  "  total (sum of a figure), show (one named record, or a figure about it).",
  "status: a recorded status the person named, or null.",
  "value: ONE specific name or document reference the person typed — a supplier, a material,",
  "  a document number — copied EXACTLY from their words. Never the kind of record, a status,",
  "  a figure's name or a phrase like \"we received\". Usually null.",
  "If nothing fits, return family null and concept null.",
].join("\n");

/* The stable names first and the sentence LAST: the families, statuses and
   operations are the same for every keystroke, so a server that caches the
   prompt prefix reuses them, and only the tail is new. */
function promptFor(menu, message) {
  return [
    `Families: ${menu.families.map((family) => family.label).join("; ")}`,
    `Statuses: ${menu.statuses.join("; ")}`,
    `Operations: ${menu.operations.join("; ")}`,
    `Concepts: ${menu.concepts.map((concept) => concept.key).join("; ") || "(none share words with the search)"}`,
    "",
    `Search: ${JSON.stringify(String(message))}`,
  ].join("\n");
}

/**
 * The choice, re-checked. Returns a normalised choice, or null.
 *
 * Structured output constrains the model to the schema; this does not trust
 * that it did. Each field is looked up in the menu again, the status must be
 * one THIS family records, and the value must be words the person typed —
 * a router that supplies a value of its own is a router that answers a
 * question nobody asked.
 */
function validate(choice, menu, message) {
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return null;
  const allowed = new Set(["family", "concept", "operation", "status", "value"]);
  if (Object.keys(choice).some((key) => !allowed.has(key))) return null;

  const family = choice.family == null ? null
    : menu.families.find((entry) => entry.label === choice.family) || false;
  const concept = choice.concept == null ? null
    : menu.concepts.find((entry) => entry.key === choice.concept) || false;
  if (family === false || concept === false) return null;
  if (!family && !concept) return null;
  if (!menu.operations.includes(choice.operation)) return null;
  /* A concept of one family chosen for another is two routes, not one. */
  if (family && concept?.family && concept.family !== family.id) return null;

  /* ── ANCHORED IN THE PERSON'S OWN WORDS ─────────────────────────────
       A choice that is valid but wrong is the one failure a closed schema
       cannot catch: a real family name that has nothing to do with the
       question would be answered, confidently, about the wrong records. So
       the family or the concept chosen must share a word with what was
       typed — "goods we received" anchors "goods receipt", "POs" anchors a
       purchase order by its alias "po". The router may rephrase the
       person's words; it may not substitute its own. */
  const said = new Set([...words(message)].map(stem));
  const anchors = (phrases) => phrases.some((phrase) => [...words(phrase)].some((word) => said.has(stem(word))));
  if (!anchors([family?.label, ...(family?.aliases || []), concept?.phrase].filter(Boolean))) return null;

  let status = null;
  if (choice.status != null) {
    if (!family || !family.statuses.includes(lower(choice.status))) return null;
    status = lower(choice.status);
  }

  let value = null;
  const rawValue = choice.value != null ? String(choice.value).trim() : "";
  if (rawValue) {
    value = rawValue;
    if (value.length > MAX_VALUE || !includesTerm(message, value)) return null;
    /* ── A VALUE IS A NAME, NOT THE ROUTE'S OWN WORDS ─────────────────
         "how many POs are still issued" came back with the value "POs" —
         the family's own name — and "goods we received" with the whole
         phrase. Both are words the person typed; neither names a record.
         A value made ENTIRELY of the route's own words is the route
         restated: it constrains nothing, so it is set aside, and the
         dropped-word rule below still proves nothing the person typed was
         lost. A value with any word of its own stays a filter. */
    const own = new Set([...words([
      family?.label, ...(family?.aliases || []), family?.plural, concept?.phrase, choice.status,
    ].filter(Boolean).join(" "))].map(stem));
    const content = [...words(value)].filter((word) => !FILLER.has(word));
    if (content.every((word) => own.has(stem(word)))) value = null;
  }
  /* ── AND NEVER DROP A WORD THE PERSON TYPED ─────────────────────────
       The converse of the value rule, and the one the provisional corpus
       found: "requisitions pending" was routed to "store requisitions" —
       every requisition, under a question about the pending ones — and "why
       is our fabric stock wrong" to "stock items". A router that leaves a
       word out has widened the question. So every content word of what was
       typed must be accounted for by the route — its family, concept,
       status, value or operation — or the route is refused. Words are
       compared on their first four letters, so "received" is accounted for
       by "receipt" and "reserved" by "reservation". */
  /* Counted from the sentence the route actually BECOMES, not from every
     field of the choice: "requisitions pending" came back with the concept
     "lines pending after", which a list does not use — so "pending" looked
     accounted for and the answer was every requisition. */
  const candidate = { family, concept, operation: choice.operation, status, value };
  const sentence = sentenceFor(candidate, {});
  if (!sentence) return null;
  const covered = new Set([...words([
    sentence, ...(family?.aliases || []), ...(OPERATION_WORDS[choice.operation] || []),
  ].filter(Boolean).join(" "))].map(stem));
  const dropped = [...words(message)].filter((word) => !FILLER.has(word) && !covered.has(stem(word)));
  if (dropped.length) return null;

  return candidate;
}

/**
 * The choice as a sentence in the catalogue's own words.
 *
 * The ordinary path then answers it, so every guarantee that path holds —
 * authorisation, grounding, the narrowed-nothing refusal, the bounds — holds
 * for a routed question too. Returns null for a choice that names no
 * answerable shape.
 */
function sentenceFor(choice, intent = {}) {
  if (!choice) return null;
  const { family, concept, operation, status, value } = choice;
  const filtered = family ? `${status ? `${status} ` : ""}${family.plural}` : null;
  let sentence = null;
  if (operation === "count" && filtered) sentence = `how many ${filtered}${value ? ` of ${value}` : ""}`;
  else if (operation === "latest" && filtered) sentence = `latest ${Number.isInteger(intent.limit) ? intent.limit : 5} ${filtered}`;
  else if (operation === "total" && concept && filtered) sentence = `total ${concept.phrase} of ${filtered}`;
  else if (operation === "list" && filtered) sentence = `${filtered}${value ? ` of ${value}` : ""}`;
  else if (operation === "show" && concept && value) sentence = `${concept.phrase} of ${value}`;
  else if (operation === "show" && family && value) sentence = `${family.label} ${value}`;
  else if (operation === "show" && concept && !family && !value) sentence = concept.phrase;
  if (!sentence) return null;
  /* A window is the person's own words, carried across unchanged. */
  if (intent.dateRange?.source) sentence = `${sentence} ${intent.dateRange.source}`;
  return sentence.replace(/\s+/g, " ").trim();
}

module.exports = {
  OPERATIONS, MAX_CONCEPTS, SYSTEM,
  menuFor, schemaFor, promptFor, validate, sentenceFor,
};
