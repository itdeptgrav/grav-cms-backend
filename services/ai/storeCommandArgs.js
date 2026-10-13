"use strict";
/**
 * services/ai/storeCommandArgs.js — a typed question, filled into a capability.
 *
 * ── THE GAP THIS CLOSES ───────────────────────────────────────────────────
 * Most Store capabilities answer one named figure and own a `claim` that
 * recognises their own words. The 55 COLLECTION capabilities do not: they
 * answer plural, counted, filtered, dated and aggregated questions, and they
 * expect their arguments — operation, concept, filters, date field, order,
 * limit — to be chosen for them. A model used to choose them.
 *
 * So four of the required questions ("goods receipts expected in June 2026",
 * "latest five material requests", "purchase orders of Gaurav Enterprises",
 * "pending goods receipt inspections") reached a capability that could answer
 * them and were dropped, because nothing filled the form in.
 *
 * ── CATALOGUE-DRIVEN, NOT PHRASE-DRIVEN ──────────────────────────────────
 * Nothing here knows those four sentences, or any entity, concept or field
 * name. It reads the capability's OWN parameter schema — the enums and the
 * `x-semanticOptions` aliases every tool already publishes for the model —
 * and fills each slot from the compiled intent. A capability registered
 * tomorrow is filled by the same code, from its own declared vocabulary.
 *
 * ── AND IT DELIBERATELY UNDER-FILLS ──────────────────────────────────────
 * `storePurchaseCollectionContext` already re-grounds every argument against
 * the words the person actually typed: it derives a filter field from the
 * message, matches a status value against the concept's own enum, infers a
 * document or supplier identity against AUTHORISED records only, and refuses
 * outright when a constraint cannot be matched to a recorded value. Guessing
 * a filter here and having that layer overrule it would put the same decision
 * in two places. So the form is filled with what the grammar KNOWS — the
 * operation, the concept, the date window, the order, the limit — and the
 * grounding layer is left to do what it already does better.
 */

const { INTENT, singularForms } = require("./storeCommandIntent");

/** The value a collection capability uses for "the records themselves". */
const RECORDS = "__records__";
/** The value every unfilled slot takes. Never left undefined: the schemas
    mark these required, and an absent slot reads as a decision not made. */
const NONE = "__none__";

const CAP = 20;

const lower = (value) => String(value ?? "").toLowerCase();

/** Does this phrase appear in the message as whole words? */
function says(message, phrase) {
  const term = lower(phrase).trim();
  if (term.length < 3) return false;
  /* A separator inside the phrase is flexible ("put-away" is "put away");
     one at the edge is a boundary and is not crossed, so a short alias
     cannot match inside a longer hyphenated word. */
  const escaped = term
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/[\s_-]+/g, "[\\s_-]+");
  return new RegExp(`(^|[^a-z0-9-])${escaped}($|[^a-z0-9-])`, "i").test(lower(message));
}

/**
 * What a capability calls one of its enum values.
 *
 * `x-semanticOptions` is the tool's own map of value → {label, aliases}; it
 * exists so a model can choose by meaning, and serves a grammar just as well.
 * A plain enum has no such map, but its values are already English with the
 * punctuation taken out — `action_required`, `expected_date` — so the value's
 * own words are the last alias. Nothing here invents a synonym a capability
 * has not published.
 */
function aliasesOf(property, value) {
  const option = property?.["x-semanticOptions"]?.[value];
  const declared = option ? [option.label, ...(option.aliases || [])] : [];
  const own = String(value ?? "").replace(/[_-]+/g, " ").trim();
  return [...declared, own].filter((alias) => String(alias || "").trim());
}

/** The value that means "no choice made here": whichever of these it has. */
const NEUTRAL = Object.freeze([NONE, "none", "all", "any"]);
const neutralOf = (property) => (property?.enum || []).find((v) => NEUTRAL.includes(v)) ?? null;

/**
 * Which enum value of this slot does the message name?
 *
 * The LONGEST matching alias wins, so "expected delivery date" is not
 * answered by "date". A tie between two different values is no answer at
 * all — that is ambiguity, and inventing a winner is how a palette says
 * something untrue with confidence.
 */
function valueFromMessage(property, message, { ignore = [] } = {}) {
  const ignored = new Set((ignore || []).map(lower));
  let best = null;
  let bestLength = 0;
  let tied = false;
  for (const value of property?.enum || []) {
    if (value === RECORDS || NEUTRAL.includes(value)) continue;
    for (const alias of aliasesOf(property, value)) {
      /* A status word names a recorded VALUE, not a field to report. A
         status concept lists its own values among its aliases, so "pending
         material requests" chose the status field as the thing to show and
         the filter was never applied — the answer listed every request with
         its status beside it, which reads as the pending ones. */
      if (ignored.has(lower(alias))) continue;
      if (!says(message, alias)) continue;
      const length = String(alias).length;
      if (length > bestLength) { bestLength = length; best = value; tied = false; }
      else if (length === bestLength && value !== best) tied = true;
    }
  }
  return tied ? null : best;
}

/** `operation`, from what the question asks for rather than what it is about. */
function operationFor(intent, property) {
  const allowed = new Set(property?.enum || []);
  const wanted = intent.intent === INTENT.COUNT ? "count"
    : intent.intent === INTENT.AGGREGATE ? "sum"
      : "list";
  if (allowed.has(wanted)) return wanted;
  return allowed.has("list") ? "list" : null;
}

/**
 * The words that are RECORDED VALUES rather than names of a field.
 *
 * "Recorded goods receipts" picked the status concept as the thing to
 * REPORT, because "recorded" is published as one of its aliases, and the
 * filter was then skipped as already placed. A value never names the column
 * to show; it names the rows to keep.
 */
function workflowValues(properties) {
  return Object.values(properties?.filterMetric?.["x-semanticValues"] || {}).flat();
}

/**
 * The question with this capability's own names taken out of it.
 *
 * `semantic.labels` is what the capability says it answers to. Removing them
 * leaves the words that are ABOUT the records rather than about which kind
 * of record is meant.
 */
function withoutLabels(tool, message) {
  let text = String(message || "");
  const labels = [...(tool?.semantic?.labels || [])]
    .map((label) => String(label || "").trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s_-]+/g, "[\\s_-]+");
    text = text.replace(new RegExp(`(^|[^a-z0-9-])${escaped}(s?)([^a-z0-9-]|$)`, "gi"), "$1 $3");
  }
  return text;
}

/** Is this filter already in place? */
function takenByFilter(args, concept, value) {
  return args.filterMetric === concept && lower(args.filterValue) === lower(value);
}

/**
 * Has a slot already been filled with the value this word names?
 *
 * `store_receive_query` has no filter concepts: its STAGES are its statuses,
 * and the slot loop chose one of them by the same aliases. Asking for a
 * filter as well would refuse the capability that can actually answer.
 */
function takenBy(properties, args, word) {
  return Object.entries(properties || {}).some(([name, property]) => (
    Array.isArray(property.enum)
      && args[name] !== undefined
      && aliasesOf(property, args[name]).some((alias) => (
        lower(alias) === lower(word)
        /* ── OR THE WORD IS PART OF THE PHRASE THAT CHOSE THE SLOT ──
             "service orders with EXPECTED completion date in June 2026"
             carries the status word "expected", but it is a word of the
             DATE CONCEPT's own name, not a status anybody asked to filter
             by. Demanding it be placed as a status refused the capability
             that had just placed it correctly as a date. */
        || says(alias, word)
      ))
  ));
}

/**
 * Which filter concept carries a status word, and as which value.
 *
 * Status concepts publish their own recorded values as aliases — a material
 * request's status lists "pending", "approved", "issued" and the rest. So the
 * word is placed by looking it up in the capability's declared vocabulary,
 * and a capability whose vocabulary does not contain it has no way to honour
 * it. Nothing here keeps a list of status words.
 */
function statusFilterFor(property, statusWords) {
  for (const word of statusWords || []) {
    for (const value of property?.enum || []) {
      if (value === NONE || value === RECORDS) continue;
      const alias = aliasesOf(property, value).find((a) => lower(a) === lower(word));
      if (alias) return { concept: value, word };
    }
  }
  return null;
}

/** A slot that says which recorded date a window applies to. */
const isDateBasisSlot = (name, property) => /date/i.test(name)
  && Array.isArray(property?.enum);

/**
 * Fill a capability's form from a compiled intent.
 *
 * Every slot is filled from the capability's own declared vocabulary: the
 * value whose aliases the question names, or the slot's own neutral value
 * when the question names none. A required slot with neither is a capability
 * that cannot be filled — which is a refusal to run it, never a fallback to
 * running it unfiltered.
 *
 * Returns the arguments, or null.
 */
function compileArgs(tool, intent, message) {
  const properties = tool?.parameters?.properties;
  if (!properties) return null;
  const required = new Set(tool.parameters.required || []);
  const args = {};
  let dateBasis = null;

  for (const [name, property] of Object.entries(properties)) {
    if (name === "from" || name === "to" || name === "query") continue;
    if (name === "sort" || name === "limit") continue;

    if (name === "operation") {
      const operation = operationFor(intent, property);
      if (!operation) return null;
      args.operation = operation;
      continue;
    }
    if (!Array.isArray(property.enum)) continue;

    /* ── A SECOND OUTPUT AND A FILTER ARE NOT FREE ────────────────────
         `metric`, `outputMetric2`, `outputMetric3` and the three
         `filterMetric` slots share one enum and one vocabulary, so a
         question naming a single concept filled ALL SIX with it: three
         copies of the same column, and three filters on a field nobody
         asked to filter by. A concept the question names once is the thing
         to report, once. The extra slots stay at their neutral value
         unless the status rule below has something to place. */
    const extraSlot = /^(outputMetric\d|filterMetric\d?|filterOperator\d?)$/.test(name);
    const chosen = extraSlot ? null : valueFromMessage(property, message, {
      /* Every concept slot ignores status words. A status concept lists its
         own recorded values among its aliases, so "pending material
         requests" picked the status field as the thing to REPORT and as all
         three filter fields, and the filter itself was never applied — the
         answer listed every request with its status beside it, which reads
         as the pending ones. A status word belongs in the filter's VALUE,
         which the block below sets. */
      ignore: /^(metric|outputMetric\d?|filterMetric\d?)$/.test(name)
        ? [...(intent.status || []), ...workflowValues(properties)]
        : [],
    });
    const neutral = neutralOf(property);
    /* `metric` asking for "the records themselves" is a collection
       capability's way of saying the question is about rows, not a figure. */
    const fallback = property.enum.includes(RECORDS) ? RECORDS : neutral;
    const value = chosen ?? fallback;
    if (value === null || value === undefined) {
      if (required.has(name)) return null;
      continue;
    }
    args[name] = value;
    if (chosen && isDateBasisSlot(name, property)) dateBasis = chosen;
  }

  /* An aggregate needs a number to aggregate. Summing "the records" is not a
     question, so a capability whose figure the question never named cannot
     serve one. */
  if (["sum", "average", "minimum", "maximum"].includes(args.operation)
      && (!args.metric || args.metric === RECORDS)) return null;

  /* ── A WINDOW THIS CAPABILITY CANNOT PLACE IS A REFUSAL ───────────────
     "in June 2026" does not say received, expected, ordered or approved. A
     capability that cannot tell which of its dates the window means must
     not answer: running it with the window dropped would list every record
     it holds under a sentence the person reads as June's. That was the
     actual behaviour — "goods receipts expected in June 2026" answered with
     a receipt recorded in May — and it is the worst kind of wrong, because
     it looks like an answer. */
  if (intent.dateRange) {
    if (!dateBasis) return null;
    if (intent.dateRange.from) args.from = intent.dateRange.from;
    if (intent.dateRange.to) args.to = intent.dateRange.to;
  }

  /* ── AND SO IS A STATUS IT CANNOT PLACE ──────────────────────────────
     "pending goods receipt inspections" reached the inspection capability,
     which records no status at all — an inspection exists only once the
     decision is made — and it answered with every inspection, pending or
     not. The word is placed in whichever concept declares it as a recorded
     value, or the capability does not claim the question. */
  /* ── A RECORDED VALUE IS A FILTER, WHEREVER THE GRAMMAR'S LIST ENDS ──
     The grammar knows the common workflow words; a family's own vocabulary
     knows the rest ("recorded", "reserved", "handed over"). A capability
     that publishes its recorded values is asked about them directly, so the
     question is filtered rather than reported. */
  const declared = properties.filterMetric?.["x-semanticValues"] || {};
  /* The value is looked for OUTSIDE the family's own name: an account's
     lifecycle stage records "customer" and the family is called a "customer
     account", so "customer accounts" names what is being asked for, not a
     filter on it. The same word elsewhere in the sentence still filters. */
  const outside = withoutLabels(tool, message);
  for (const [concept, values] of Object.entries(declared)) {
    const hit = (values || []).find((value) => says(outside, value));
    if (!hit) continue;
    if (takenByFilter(args, concept, hit)) continue;
    /* ── UNLESS THE WORD BELONGS TO A SLOT ALREADY CHOSEN ──────────────
         "warehouses with ARCHIVED at in June 2026" names a date concept
         whose own name begins with a recorded value. Filtering by it as a
         status excluded every record the window should have found. */
    if (takenBy(properties, args, hit)) continue;
    args.filterMetric = concept;
    args.filterOperator = "equals";
    args.filterValue = hit;
    /* The question IS constrained, whatever the grammar made of the word. */
    args.constrained = true;
    break;
  }

  for (const word of intent.status || []) {
    /* A stage slot may already have taken it: a receiving register's stages
       ARE its statuses, and the loop above chose one by the same aliases. */
    if (takenBy(properties, args, word)) continue;
    const placed = properties.filterMetric
      ? statusFilterFor(properties.filterMetric, [word]) : null;
    if (!placed) return null;
    args.filterMetric = placed.concept;
    args.filterOperator = "equals";
    args.filterValue = placed.word;
  }

  /* "latest five" is two facts: five rows, newest first. Both are in the
     grammar, so neither is guessed here. */
  if (intent.order && properties.sort?.enum) {
    const sort = intent.order === "newest" ? "descending" : "ascending";
    if (properties.sort.enum.includes(sort)) args.sort = sort;
  }
  if (properties.limit && Number.isInteger(intent.limit) && intent.limit > 0) {
    args.limit = Math.min(CAP, intent.limit);
  }
  return args;
}

/**
 * Does this capability recognise the question, and can its form be filled?
 *
 * Only for capabilities with no `claim` of their own. One WITH a claim has
 * already said what it needs, and second-guessing it here would be a second
 * opinion nobody asked for.
 */
function claimFromIntent(tool, intent, message, { identified = false } = {}) {
  if (typeof tool?.claim === "function") return null;
  if (typeof tool?.matches !== "function") return null;
  /* ── A RESOLVED REFERENCE HAS ALREADY ANSWERED `matches` ───────────────
     `matches` asks "do these words name this kind of document?" — the right
     question for "pending purchase orders", and the wrong one for
     "PO/2026-27/0101", where the words name a RECORD and never say its
     kind. When the catalogue has already resolved that reference to this
     capability's own family, against this actor's authorised records, the
     kind is settled and asking the words again only loses it. */
  let recognised = identified;
  if (!recognised) {
    try {
      /* The plural somebody typed, then the singular the aliases are in. */
      recognised = singularForms(message).some((form) => Boolean(tool.matches(form)));
    } catch {
      return null;
    }
  }
  if (!recognised) return null;
  return compileArgs(tool, intent, message);
}

module.exports = {
  RECORDS, NONE, CAP,
  NEUTRAL, says, aliasesOf, neutralOf, valueFromMessage, operationFor,
  statusFilterFor, takenBy,
  compileArgs, claimFromIntent,
};
