"use strict";
/**
 * services/ai/storeCommandRouting.js — which capabilities could answer this.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * There are 117 authorised Store capabilities. Asking each one "is this
 * yours?" means 117 identity resolutions — each a database read — on every
 * keystroke. That is not a palette, it is a denial of service somebody typed
 * by accident.
 *
 * So selection happens in two stages. This module is the FIRST and it touches
 * nothing: it scores a tool's own declared `semantic` metadata against the
 * words that survived the grammar, and returns a small bounded set. Only those
 * are asked, in the second stage, to resolve identities and read data.
 *
 * ── SCORED ON WHAT THE TOOL DECLARES ABOUT ITSELF ─────────────────────────
 * `semantic.subjects` and `semantic.domains` are already on every registered
 * tool. Nothing here hardcodes a tool name, an entity or one of the ten
 * example questions: a capability registered tomorrow is routed by the same
 * rule, because the rule reads what the capability says it is about.
 */

const { INTENT, singularForms } = require("./storeCommandIntent");
const { includesTerm } = require("./semanticCatalogue");

/** No more than this many capabilities are ever asked to resolve identities. */
const MAX_CANDIDATES = 6;

/** The two internal families that make up Store & Purchase. */
const STORE_APPLICATIONS = Object.freeze(["store", "store_purchase"]);

const words = (value) => String(value ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * How well a tool's declared subject matter matches these words.
 *
 * A subject is worth more than a domain: "inventory_item" naming itself is a
 * stronger signal than belonging to the "item_master" area. Both are the
 * tool's own words, not ours.
 */
function scoreTool(tool, terms) {
  if (!terms.length) return 0;
  const semantic = tool.semantic || {};
  const subjectWords = new Set((semantic.subjects || []).flatMap(words));
  const domainWords = new Set((semantic.domains || []).flatMap(words));
  const nameWords = new Set(words(tool.name));

  let score = 0;
  for (const term of terms) {
    const t = term.toLowerCase();
    if (subjectWords.has(t)) score += 3;
    else if (domainWords.has(t)) score += 2;
    else if (nameWords.has(t)) score += 1;
    /* A partial subject match — "receipt" against "goods_receipt" — is worth
       something, because people drop the qualifier. */
    else if ([...subjectWords].some((s) => s.startsWith(t) || t.startsWith(s))) score += 1;
  }
  return score;
}

/**
 * The intents a tool can serve, from the shape of what it declares.
 *
 * A tool whose subject ends in `_collection` answers plural questions; one
 * that does not answers about a single identified record. Read from the
 * declaration rather than configured per tool, so this needs no maintenance
 * as capabilities are added.
 */
function servesIntent(tool, intent) {
  const subjects = (tool.semantic?.subjects || []).join(" ").toLowerCase();
  const name = String(tool.name || "").toLowerCase();
  const plural = /collection|_query|list|workspace|desk/.test(`${subjects} ${name}`);

  switch (intent) {
    case INTENT.LIST:
    case INTENT.COUNT:
    case INTENT.AGGREGATE:
      return plural;
    case INTENT.RECORD:
      /* A record question may still be served by a collection capability
         when it carries an exact reference — that is how a document number
         is looked up. The caller decides; routing does not exclude it. */
      return true;
    default:
      return true;
  }
}

/* ── WHAT A KIND OF QUESTION IS ABOUT ─────────────────────────────────────
   Some questions name no subject at all. "where is sodium kept" is about a
   LOCATION, and "sodium" is the record, not the area; a bare "macbook" names
   only a record. Matching the words alone finds nothing in both cases.

   So an intent carries an affinity for the declared domains that answer that
   KIND of question. Matched against what each tool says it covers — never
   against a tool name — so a capability added later is routed by the same
   rule. */
const INTENT_AFFINITY = Object.freeze({
  [INTENT.LOCATION]: /location|rack|bin|shelf|bay|warehouse|putaway|movement/i,
  /* A shortfall is about an ITEM: what is held against what is needed. The
     item master declares `item_master` and `inventory_item`, neither of
     which contains the word "shortfall". */
  [INTENT.SHORTFALL]: /shortfall|requirement|material|item|issuance|reservation|stock/i,
  [INTENT.AGGREGATE]: /valuation|ledger|stock|cost/i,
});

/**
 * A tool that can turn a NAME into a record.
 *
 * `recognizeSubject` is the registry's own declaration that a capability can
 * identify a real record from what somebody typed. It is what makes a bare
 * product name, or a document reference nothing else claims, answerable at
 * all — and it is already permission-scoped, because it is only ever called
 * on an authorised tool.
 */
const identifies = (tool) => typeof tool.recognizeSubject === "function";

/**
 * Does the capability itself say these words name it?
 *
 * `matches` is a tool's own alias test — the entity's label and the names
 * people actually use for it ("grn" for a goods receipt, "po" for a purchase
 * order, "mrf" for a material request). It is pure: a regular expression or
 * an alias comparison, never a read. That makes it the strongest signal
 * available before anything is read, and it is the capability's own
 * vocabulary rather than ours, so a capability added later is routed by what
 * it declares about itself.
 */
function recognises(tool, message) {
  if (typeof tool.matches !== "function") return false;
  try {
    /* Asked in the plural the person typed, and then in the singular its
       aliases are written in. `includesTerm` matches neither against the
       other, so a question about "warehouses" named no capability at all. */
    return singularForms(message).some((form) => Boolean(tool.matches(form)));
  } catch {
    return false;
  }
}

/**
 * How SPECIFICALLY the question names this capability's family.
 *
 * ── WHY LENGTH ────────────────────────────────────────────────────────────
 * One family's name can contain another's. "Goods receipt put-aways" names
 * the put-away family and, as a substring, the goods-receipt family too —
 * and the shorter name used to win, so the question was answered about the
 * wrong records. The longest name a question contains is the family it is
 * about; a capability that declares no names is simply not more specific
 * than one that does.
 */
function recognisedLength(tool, message) {
  const labels = tool.semantic?.labels;
  if (!Array.isArray(labels) || !labels.length) return recognises(tool, message) ? 1 : 0;
  const forms = singularForms(message);
  let best = 0;
  for (const label of labels) {
    const text = String(label || "").trim();
    if (text.length <= best) continue;
    if (forms.some((form) => includesTerm(form, text))) best = text.length;
  }
  return best;
}

/**
 * Stage one: a bounded candidate set, chosen without reading anything.
 *
 * @param {Array}  tools   the AUTHORISED tools — permission is decided before
 *                         this is called, never here.
 * @param {object} intent  from `compileIntent`
 */
function selectCandidates(tools, intent, { max = MAX_CANDIDATES } = {}) {
  if (!Array.isArray(tools) || !intent?.ok) return [];
  const terms = [...(intent.terms || [])];
  /* An exact reference is a term too — a numbering capability declares the
     series it issues, and that is how a reference finds its home. */
  if (intent.reference) terms.push(...words(intent.reference).filter((w) => /[a-z]/.test(w)));

  const affinity = INTENT_AFFINITY[intent.intent] || null;
  /* A bare name, or a reference no subject claims, is answered by whichever
     capabilities can identify a record from text. */
  /* ── AND ONLY WHEN THERE IS SOMETHING TO IDENTIFY ──────────────────
     Without this guard a query of nothing but stop words still scored every
     identity-resolving capability one point, and six of them would each
     have gone to the database looking for a record named "". */
  const identityOnly = [
    INTENT.DISCOVERY, INTENT.RECORD, INTENT.LOCATION, INTENT.SHORTFALL,
  ].includes(intent.intent) && (terms.length > 0 || Boolean(intent.reference));

  const scored = tools
    .filter((tool) => servesIntent(tool, intent.intent))
    .map((tool) => {
      let score = scoreTool(tool, terms);
      /* The capability's own aliases outrank a word-for-word match on its
         id, because "grn" and "mrf" are what people type and neither
         appears in `goods_receipt` or `material_request`. And the LONGER
         the name it recognised, the more specifically this question is
         about it: "goods receipt put-aways" names two families and means
         one. */
      const named = recognisedLength(tool, intent.raw);
      if (named) score += 4 + Math.min(Math.floor(named / 6), 4);
      if (affinity) {
        const declares = [...(tool.semantic?.domains || []), ...(tool.semantic?.subjects || [])].join(" ");
        if (affinity.test(declares)) score += 3;
      }
      /* ── AND A CAPABILITY THAT CAN TURN A NAME INTO A RECORD ──────
         A bare product name matches no declared subject anywhere: "stock
         of macbook" names a figure every stock capability has in its id,
         and the one capability that can find the MATERIAL called macbook
         declares neither word. Worth more than a word-for-word hit on an
         id, and less than the capability's own aliases. */
      if (identityOnly && identifies(tool)) score += 2;
      return { tool, score };
    })
    .filter((row) => row.score > 0)
    /* ── A TIE IS BROKEN BY NAME, NOT BY WHO LOADED FIRST ──────────────
       This kept REGISTRATION order, which is the same within one process
       and different between two. The test suites load the Store modules
       only; the server loads every application's through the assistant —
       so a bare material name scored every identity-resolving capability
       equally and the six that got asked were a different six in each.
       On the server they were a supplier reader, a unit reader and a
       warehouse reader, and a material sitting in the catalogue came back
       "no authorised Store record matches that".

       Sorting ties by name is arbitrary in WHICH capability wins, and that
       is fine — what matters is that it is the same one everywhere. */
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));

  return scored.slice(0, max).map((row) => row.tool);
}

/**
 * Candidates grouped by the subject they would resolve.
 *
 * Several capabilities share one subject — the universal field reader and the
 * collection reader both resolve a purchase order. Resolving it twice is two
 * identical database reads for one question, so the caller resolves once per
 * subject and hands the result to each.
 */
function groupBySubject(candidates) {
  const groups = new Map();
  for (const tool of candidates) {
    const key = (tool.semantic?.subjects || []).slice().sort().join(",") || tool.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tool);
  }
  return [...groups.entries()].map(([subject, tools]) => ({ subject, tools }));
}

module.exports = {
  MAX_CANDIDATES, STORE_APPLICATIONS, INTENT_AFFINITY, identifies, recognises, recognisedLength,
  scoreTool, servesIntent, selectCandidates, groupBySubject,
};
