"use strict";
/**
 * test/support/storeQuestionMatrix.js — the questions, generated from what the
 * capabilities declare.
 *
 * ── WHY GENERATED AND NOT WRITTEN ─────────────────────────────────────────
 * A hand-written list of questions tests the questions somebody thought of.
 * The ones that quietly do not work are the ones nobody typed — and with 53
 * Store & Purchase entity families and 2,647 concepts, that is most of them.
 *
 * So every case here is derived from the registry and the catalogue: an
 * entity's own label and aliases, a concept's own aliases, a status concept's
 * own recorded values, a date concept's own name. Nothing is hardcoded about
 * purchase orders, goods receipts or anything else, so a family registered
 * tomorrow is questioned by the same rules.
 *
 * ── AND WHY EACH CASE CARRIES WHAT MUST *NOT* BE SAID ─────────────────────
 * "It answered" is a weak assertion: an answer listing every record is also
 * an answer. Every filtered case therefore names a seeded record that fails
 * the filter, and fails if that record appears. That is how an unfiltered or
 * broader result is caught, which is the failure mode this whole layer exists
 * to prevent.
 */

const {
  ENTITY_SPECS, DEFINITIONS_BY_ENTITY,
} = require("../../services/storePurchaseUniversalContract");
const { exclusionFor } = require("../../services/ai/storeCommandExclusions");

/**
 * The plural somebody would type.
 *
 * English, not an appended "s": a question about "sales enquirys" is not a
 * question anybody asks, and generating one tests the generator. The head
 * noun is the last word, which is where a label's plural lives.
 */
function plural(label) {
  const words = String(label).trim().split(/\s+/);
  const last = words[words.length - 1] || "";
  if (/(s|x|z|ch|sh)$/i.test(last)) return words.join(" ");
  const head = /[^aeiou]y$/i.test(last)
    ? last.replace(/y$/i, "ies")
    : `${last}s`;
  return [...words.slice(0, -1), head].join(" ");
}

/** A concept of this entity whose words name it, by what it is. */
function conceptsOf(entityId) {
  return (DEFINITIONS_BY_ENTITY[entityId] || []).filter((d) => (d.aliases || []).length);
}

const isTopLevel = (definition) => !String(definition.path || "").includes(".");

/** The first concept matching a predicate, preferring an unambiguous alias. */
function pick(definitions, predicate) {
  const hits = definitions.filter(predicate).filter(isTopLevel);
  /* A longer alias is less likely to collide with another concept's, and an
     ambiguous alias makes a case that tests the catalogue's tie-breaking
     rather than the question. */
  hits.sort((a, b) => (b.aliases[0] || "").length - (a.aliases[0] || "").length);
  return hits[0] || null;
}

/**
 * The status concept a question would actually be grounded against.
 *
 * The ROOT one first — `path === "status"` — because that is the one the
 * collection layer grounds and the one people mean. Picking the longest-named
 * status concept instead generated questions about `items.itemStatus`, which
 * is a status of a LINE, and then failed the capability for not filtering a
 * record by it.
 */
const hasEnum = (spec, d) => (spec.model.schema.path(d.path)?.enumValues || []).length > 1;

/**
 * The status concept a question would actually be grounded against.
 *
 * Found the way the CATALOGUE finds it, not by a second guess: the contract
 * publishes a family's workflow values as aliases of exactly one concept, so
 * the concept whose aliases contain its own recorded values IS that concept.
 * Picking a different status-shaped field generated questions about a value
 * nothing grounds, and then failed the capability for not filtering by it.
 */
const statusConcept = (definitions, spec) => definitions.find((d) => {
  if (d.path.includes(".") || !hasEnum(spec, d)) return false;
  const values = (spec.model.schema.path(d.path).enumValues || [])
    .filter(Boolean).map((v) => String(v).replace(/[_-]+/g, " ").toLowerCase());
  const aliases = new Set((d.aliases || []).map((a) => String(a).toLowerCase()));
  return values.some((value) => aliases.has(value));
});
const dateConcept = (definitions) => pick(definitions, (d) => (
  d.valueType === "date_time" && !/^created|updated/i.test(d.label)
)) || pick(definitions, (d) => d.valueType === "date_time");
const numberConcept = (definitions) => pick(definitions, (d) => d.valueType === "number");
/* A workflow field is never "a text field to fill in": writing a sentence
   into `applicationState` left the status question filtering against prose. */
const isWorkflow = (spec, d) => (spec.model.schema.path(d.path)?.enumValues || []).length > 1;
const textConcept = (definitions, spec) => pick(definitions, (d) => (
  d.valueType === "text"
    && !/status$/i.test(d.id)
    && !isWorkflow(spec, d)
    && !(spec.identityPaths || []).includes(d.path)
));

/**
 * Every case for one entity family.
 *
 * `seed` says what the fixture must write for the case to mean anything;
 * `says` and `never` are what the answer must and must not contain.
 */
/**
 * Why a family cannot be asked a question of a given kind, if it cannot.
 *
 * Read from `services/ai/storeCommandExclusions` — the PRODUCT's own list,
 * not a second one kept here. An exclusion recorded only in a test is an
 * excuse; recorded in the product it is a decision, with the reason and the
 * thing that answers instead beside it.
 */
function cannotAsk(spec, kind, plan) {
  const excluded = exclusionFor(spec, kind, { identity: plan.identity });
  return excluded ? `${excluded.reason} Instead: ${excluded.instead}` : null;
}

function casesFor(spec, plan) {
  const { identity, token, otherToken, statusValue, otherStatusValue, dateInWindow } = plan;
  const definitions = conceptsOf(spec.id);
  const label = spec.label;
  const many = plural(label);
  const cases = [];

  const add = (kind, query, expect) => cases.push({
    entity: spec.id, kind, query, ...expect,
    /* An unasked question carries its reason, and is reported. */
    unsupported: cannotAsk(spec, kind, plan),
  });

  /* ── IDENTITY ───────────────────────────────────────────────────────── */
  add("exact identity", identity, { says: [token], never: [otherToken] });
  /* The family named and then the record: ONE record, so its pair must not
     be in the answer either. */
  add("partial identity", `${label} ${identity}`, { says: [token], never: [otherToken] });

  /* ── A REFERENCE THAT NAMES NO RECORD ─────────────────────────────────
     The family named, then a number shaped like this family's own
     references that no record carries. Every other identity case types a
     reference the fixture seeded, so none of them could see "PO/2026-27/9999"
     answered with every purchase order. Nothing may be named in reply. */
  /* A numeric identity gets a number nothing holds, not one with the
     seeded number inside it. */
  const unknown = /^\d+$/.test(String(token)) ? "909" : `${String(token).replace(/7731$/, "0000")}-9`;
  add("unknown reference", `${label} ${unknown}`, {
    states: ["no_match", "unsupported", "needs_clarification"],
    never: [token, otherToken],
  });

  /* ── A COLLECTION-ONLY RECORD, BY NAME ───────────────────────────────
     A supplier or a material is typed as words, not as a reference, and its
     family is the one the catalogue-wide pass leaves out. The fixture
     writes the same name on a record of another family, so this fails if
     that neighbour is allowed to stand in for the record itself. */
  if (spec.collectionOnly && plan.name) {
    add("by name", plan.name, { says: [plan.name], opens: plan.nameId });
  }

  /* ── A FIELD OF ONE RECORD ──────────────────────────────────────────── */
  const field = textConcept(definitions, spec);
  if (field) {
    add("a field of a named record", `${field.aliases[0]} of ${identity}`, {
      says: [], softly: true,
    });
  }

  /* ── THE SINGLETON'S OWN QUESTION ───────────────────────────────────
     A settings document has no identity anybody types and there is only
     ever one of it, so the question is its NAME. It is the only question
     that family has, which makes it the only evidence that the family is
     reachable at all. */
  if (spec.singleton) {
    add("singleton lookup", label, { softly: true });
  }

  /* ── PLURAL, COUNT ──────────────────────────────────────────────────── */
  if (!spec.singleton) {
    add("list", many, { says: [token, otherToken] });
    add("count", `how many ${many}`, { says: [], softly: true });
  }

  /* ── A STATUS FILTER ────────────────────────────────────────────────── */
  if (statusValue && otherStatusValue && !spec.singleton) {
    add("status filter", `${String(statusValue).replace(/_/g, " ").toLowerCase()} ${many}`, {
      says: [token],
      /* THE ASSERTION THAT MATTERS: the record that fails the filter must
         not be in the answer. An answer listing both is an unfiltered
         answer wearing a filtered sentence. */
      never: [otherToken],
    });
  }

  /* ── A DATE WINDOW THE QUESTION NAMES ───────────────────────────────── */
  const date = dateConcept(definitions);
  if (date && dateInWindow && !spec.singleton) {
    add("date filter", `${many} with ${date.aliases[0]} in June 2026`, {
      says: [token], never: [otherToken],
    });
    /* ── AND ONE IT DOES NOT ────────────────────────────────────────
       The same window with no date named must be refused, never applied
       to whichever date the capability happens to hold first. */
    add("unplaced date window", `${many} in June 2026`, {
      states: ["needs_clarification", "unsupported", "no_match"],
      never: [token, otherToken],
    });
  }

  /* ── AN AGGREGATE ───────────────────────────────────────────────────── */
  const number = numberConcept(definitions);
  if (number && !spec.singleton) {
    add("aggregate", `total ${number.aliases[0]} of ${many}`, { says: [], softly: true });
  }

  return cases;
}

/** Every case for every family. */
function matrix(seeded) {
  return ENTITY_SPECS.flatMap((spec) => {
    const plan = seeded[spec.id];
    return plan ? casesFor(spec, plan) : [];
  });
}

/**
 * Does this answer NAME that record?
 *
 * Whole-token, never a substring: a revision numbered 202 is "named" by the
 * string "202" inside the date "12/6/2026" only to a substring test, and a
 * leak reported that way is a leak that is not there.
 */
function names(text, token) {
  const term = String(token || "");
  if (!term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`).test(String(text));
}

module.exports = {
  matrix, casesFor, cannotAsk, names, conceptsOf, plural,
  statusConcept, dateConcept, numberConcept, textConcept,
};
