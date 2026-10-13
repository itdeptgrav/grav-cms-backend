"use strict";
/**
 * services/ai/storeCommandIntent.js — what a typed Store question MEANS.
 *
 * ── A GRAMMAR, NOT A LIST OF PHRASES ──────────────────────────────────────
 * Ten example questions were asked for. Ten `if` statements would pass them
 * and answer nothing else, so what is here instead is the shape those ten
 * happen to be made of: a quantity word, an ordering word, a month, a status,
 * a name after "of"/"for", a reference that looks like a document number. Any
 * question built from those parts compiles, whether or not anybody thought of
 * it.
 *
 * ── PURE, AND DELIBERATELY IGNORANT ───────────────────────────────────────
 * This module reads no database, holds no catalogue and knows no entity. It
 * turns words into a typed request and says what it could not interpret. What
 * those words REFER to — which record, which field, whether this person may
 * see it — is decided afterwards, by the catalogue and the tools, against the
 * database. Mixing the two is how a parser starts inventing fields.
 *
 * ── AND IT FAILS CLOSED ───────────────────────────────────────────────────
 * Every constraint it extracts is reported. A caller that cannot honour one
 * must refuse the whole request: dropping "in June 2026" and running the rest
 * returns a confident answer to a question nobody asked. `unresolved` carries
 * what was recognised but not usable, so the refusal can say which part.
 */

/** What the person is asking for. */
const INTENT = Object.freeze({
  RECORD: "record",         // one identified record, or its field
  LIST: "list",             // several records matching constraints
  COUNT: "count",           // how many
  AGGREGATE: "aggregate",   // a total/sum/average over them
  LOCATION: "location",     // where something is kept
  SHORTFALL: "shortfall",   // what is missing against a requirement
  DISCOVERY: "discovery",   // a bare name: which records are these?
});

const ORDER = Object.freeze({ NEWEST: "newest", OLDEST: "oldest" });

const MONTHS = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
});

const NUMBER_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, twenty: 20, fifty: 50,
});

/** Words that mean "the most recent", and their direction. */
const ORDER_WORDS = Object.freeze({
  latest: ORDER.NEWEST, newest: ORDER.NEWEST, recent: ORDER.NEWEST,
  last: ORDER.NEWEST, current: ORDER.NEWEST,
  oldest: ORDER.OLDEST, earliest: ORDER.OLDEST, first: ORDER.OLDEST,
});

/** Status words the Store domain actually uses. Matched, never invented. */
const STATUS_WORDS = Object.freeze([
  "pending", "approved", "rejected", "draft", "issued", "cancelled", "closed",
  "open", "completed", "received", "partially received", "awaiting", "overdue",
  "in progress", "on hold", "expected", "verified", "unverified",
]);

const COUNT_WORDS = /\b(how many|number of|count of|count)\b/i;
const AGGREGATE_WORDS = /\b(total|sum|average|avg|value of|worth)\b/i;
const LOCATION_WORDS = /\b(where|which (?:rack|shelf|bin|bay|warehouse|location)|located|kept|stored)\b/i;
const SHORTFALL_WORDS = /\b(shortfall|short|shortage|missing|deficit|outstanding requirement)\b/i;
const LIST_WORDS = /\b(list|all|show|every|which)\b/i;

/* A document reference: letters, then separators, then digits — GRN/2026-27/0004,
   PO-2026-0007, MRF 2609 0006. Recognised by SHAPE, never by a hardcoded
   prefix, so a numbering series this file has never heard of still matches.

   ── WHY THE SEGMENTS ARE NOT SHORT ────────────────────────────────────────
   They were bounded at nine characters, which fits the document numbers and
   nothing else. Store's own SKUs do not look like that —
   `RAW-LAP-APPMACAIR2022A2681` is a real one — so typing an item's code
   reached no capability at all. Twenty-four is long enough for every
   identity in the register; the SHAPE still does the work, because an
   ordinary phrase has no uppercase run joined by a slash or a hyphen. */
const REFERENCE = /\b([A-Z][A-Z0-9]{1,23}(?:[/-][A-Z0-9]{1,23}){1,4})\b/;

const LIMIT_CAP = 50;
const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

/* Does this phrase name several things? A plural noun that is not one of the
   words that merely LOOK plural. Deliberately crude: it decides list-versus-
   record, and the catalogue decides everything that matters after that. */
const NOT_PLURAL = new Set(["address", "status", "progress", "this", "its", "gas", "class", "stock"]);
function isPlural(phrase) {
  return clean(phrase).toLowerCase().split(/\s+/)
    .some((w) => w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !NOT_PLURAL.has(w));
}

/** The last day of a month, so a range never runs past it. */
const endOfMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * A month-and-year, a bare year, or nothing.
 *
 * Returns an explicit start and end — never a "month" a reader has to turn
 * into dates themselves, because the two would disagree about whether the end
 * is inclusive.
 */
function dateRangeFrom(text) {
  /* ── A DAY IS A DAY ──────────────────────────────────────────────────────
     "on 3 Oct 2026" was read as the month-and-year inside it — all of
     October, broader than asked. A named day is matched first, in the ways
     people here write one: 3 Oct 2026, 3rd October 2026, Oct 3 2026,
     2026-10-03, 03/10/2026 (day first, as in India). */
  const monthNames = Object.keys(MONTHS).join("|");
  const day = (y, m, d, source) => (m >= 1 && m <= 12 && d >= 1 && d <= endOfMonth(y, m)
    ? { from: iso(y, m, d), to: iso(y, m, d), source } : null);
  let hit = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthNames}),?\\s+(\\d{4})\\b`, "i"));
  if (hit) return day(Number(hit[3]), MONTHS[hit[2].toLowerCase()], Number(hit[1]), hit[0]);
  hit = text.match(new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i"));
  if (hit) return day(Number(hit[3]), MONTHS[hit[1].toLowerCase()], Number(hit[2]), hit[0]);
  hit = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (hit) return day(Number(hit[1]), Number(hit[2]), Number(hit[3]), hit[0]);
  hit = text.match(/\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/);
  if (hit) return day(Number(hit[3]), Number(hit[2]), Number(hit[1]), hit[0]);

  const monthYear = text.match(
    new RegExp(`\\b(${Object.keys(MONTHS).join("|")})\\s+(\\d{4})\\b`, "i"),
  );
  if (monthYear) {
    const month = MONTHS[monthYear[1].toLowerCase()];
    const year = Number(monthYear[2]);
    return {
      from: iso(year, month, 1),
      to: iso(year, month, endOfMonth(year, month)),
      source: `${monthYear[1]} ${monthYear[2]}`,
    };
  }
  const bareYear = text.match(/\b(?:in|during|for)\s+(20\d{2})\b/i);
  if (bareYear) {
    const year = Number(bareYear[1]);
    return { from: iso(year, 1, 1), to: iso(year, 12, 31), source: bareYear[1] };
  }
  return null;
}

/**
 * How many, and which end.
 *
 * "latest five" is two facts — an ordering and a limit — and both are needed:
 * five of something unordered is an arbitrary five.
 */
function limitFrom(text) {
  /* Up to six digits, and then capped. A three-digit bound meant "latest
     5000 material requests" carried NO limit at all and quietly fell back to
     the default ten — the number the person typed simply vanished. */
  const digits = text.match(/\b(?:latest|last|newest|recent|top|first|oldest|earliest)\s+(\d{1,6})\b/i)
    || text.match(/\b(\d{1,6})\s+(?:latest|newest|most recent|oldest)\b/i);
  if (digits) return Math.min(Number(digits[1]), LIMIT_CAP);

  const words = text.match(
    new RegExp(`\\b(?:latest|last|newest|recent|top|first|oldest|earliest)\\s+(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "i"),
  );
  if (words) return Math.min(NUMBER_WORDS[words[1].toLowerCase()], LIMIT_CAP);
  return null;
}

/** The name after "of" or "for" — a supplier, a material, a person. */
function constraintFrom(text) {
  const match = text.match(/\b(?:of|for|from|by|at)\s+(.{2,80}?)\s*$/i);
  if (!match) return null;
  const value = clean(match[1]).replace(/[?.!,]+$/, "");
  /* A trailing preposition picks up noise as often as a name. Anything that
     is only a stop word is not a constraint. */
  if (!value || /^(the|a|an|it|them|this|that|me|us)$/i.test(value)) return null;
  return value;
}

/**
 * Compile one typed request.
 *
 * Returns everything recognised. Nothing is executed, nothing is looked up,
 * and nothing recognised is silently dropped.
 */
function compileIntent(query) {
  const raw = clean(query);
  const text = raw.toLowerCase();
  if (!raw) return { ok: false, reason: "empty", intent: null, terms: [], unresolved: [] };

  const reference = (raw.match(REFERENCE) || [])[1] || null;
  const dateRange = dateRangeFrom(raw);
  const limit = limitFrom(raw);
  /* The word that carried the limit, so "five" does not survive into the
     terms and get searched for as if it were part of a name. */
  const limitWord = (raw.match(
    new RegExp(`\\b(\\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")})\\b`, "i"),
  ) || [])[1] || null;
  const orderWord = Object.keys(ORDER_WORDS).find((w) => new RegExp(`\\b${w}\\b`, "i").test(text));
  const order = orderWord ? ORDER_WORDS[orderWord] : (limit ? ORDER.NEWEST : null);
  /* ── A STATUS WORD, NOT A WORD CONTAINING ONE ─────────────────────────
     `\b` treats a hyphen as a boundary, so "half-approved" matched
     "approved" and a question about something Store has never heard of was
     answered with the approved records. A status word has to stand alone:
     no letter, digit or hyphen either side of it. */
  const status = STATUS_WORDS.filter((s) => (
    new RegExp(`(^|[^a-z0-9-])${s.replace(/\s+/g, "\\s+")}($|[^a-z0-9-])`, "i").test(text)
  ));
  const constraint = constraintFrom(raw);

  /* ── WHICH QUESTION IS IT ──────────────────────────────────────────────
     Ordered by how specific the evidence is. A reference names one record and
     outranks everything; a location or shortfall word names a kind of answer;
     a counting word outranks a list; a list word or a limit means several; a
     bare name with no verb is discovery. */
  let intent;
  if (reference) intent = INTENT.RECORD;
  else if (SHORTFALL_WORDS.test(text)) intent = INTENT.SHORTFALL;
  else if (LOCATION_WORDS.test(text)) intent = INTENT.LOCATION;
  else if (COUNT_WORDS.test(text)) intent = INTENT.COUNT;
  else if (AGGREGATE_WORDS.test(text)) intent = INTENT.AGGREGATE;
  else if (limit || dateRange || status.length || LIST_WORDS.test(text)) intent = INTENT.LIST;
  /* ── PLURAL MEANS SEVERAL ──────────────────────────────────────────
     "purchase orders of X" asks for every order; "purchase order PO-7"
     asks for one. The difference is the plural, and reading it as one
     record would answer with an arbitrary member of the set. Checked on
     the words BEFORE the constraint, so a supplier whose name ends in s
     does not make its own question plural. */
  else if (constraint && isPlural(raw.slice(0, raw.toLowerCase().lastIndexOf(constraint.toLowerCase())))) {
    intent = INTENT.LIST;
  } else if (constraint) intent = INTENT.RECORD;
  /* ── A BARE PLURAL IS STILL SEVERAL ────────────────────────────────
     "units", "warehouses", "material requests" — a noun with no verb and
     no constraint. Read as discovery, these were routed to the
     capabilities that turn a NAME into one record, which crowded out the
     one that lists them: "units" was answered "no authorised Store record
     matches that" while two sat in the database. */
  else if (looksPlural(raw)) intent = INTENT.LIST;
  else intent = INTENT.DISCOVERY;

  /* The words left once the grammar has taken its parts — what the catalogue
     and the identity resolver have to work with. */
  let remainder = raw;
  for (const part of [
    reference, dateRange?.source, orderWord,
    ...(limit ? [String(limit), limitWord] : []),
    ...status,
  ].filter(Boolean)) {
    remainder = remainder.replace(new RegExp(String(part).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
  }
  const terms = clean(remainder)
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^(of|for|the|and|in|on|at|is|are|was|has|have|show|list|all|every|which|what|where|me|my|do|we)$/i.test(w));

  return {
    ok: true,
    intent,
    raw,
    reference,
    /* A date range is only usable once somebody says WHICH date it applies
       to. The compiler never guesses that — see `unresolved`. */
    dateRange,
    limit,
    order,
    status,
    constraint,
    terms,
    /* Recognised, and not yet honourable by anything here. A caller that
       cannot satisfy one of these must refuse rather than answer without it. */
    unresolved: dateRange && !/(expected|received|created|ordered|due|raised|issued)/i.test(text)
      ? [{ part: "dateRange", why: "no business date was named for this range" }]
      : [],
  };
}

/**
 * Is the phrase's head noun plural, as far as spelling can say?
 *
 * `isPlural` is the loose test used where a constraint already says the
 * question is about several. Here it decides the whole intent of a bare noun
 * phrase, so it is narrower: a word ending in "ss", "us", "is" or "as" is
 * singular — "canvas", "status", "gas", "bias" — and reading "duck canvas
 * 12oz" as a list question would turn a material's name into a collection
 * query.
 */
function looksPlural(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const last = words[words.length - 1] || "";
  if (!/s$/i.test(last) || /(ss|us|is|as)$/i.test(last)) return false;
  return last.length > 3;
}

/**
 * The singular forms a plural word might have.
 *
 * Several, not one, because English does not decide: "warehouses" loses an
 * "s" and "addresses" loses an "es", and nothing in the spelling says which.
 * Both are offered and whichever a capability's own alias matches is the
 * right one — a guess is only ever confirmed by the vocabulary, never used
 * on its own.
 */
function singularWord(word) {
  const out = [];
  if (/ies$/i.test(word) && word.length > 4) out.push(word.replace(/ies$/i, "y"));
  if (/es$/i.test(word) && word.length > 4) out.push(word.replace(/es$/i, ""));
  if (/s$/i.test(word) && word.length > 3) out.push(word.replace(/s$/i, ""));
  return out.length ? [...new Set(out)] : [word];
}

/**
 * The forms of a question a capability's own aliases might match.
 *
 * ── WHY THIS IS NEEDED AT ALL ─────────────────────────────────────────────
 * `includesTerm` does not match "purchase orders" against the term "purchase
 * order": a capability's aliases are singular, and some families happen to
 * list a plural among them while most do not. So "development files" named
 * its capability and "warehouses" did not, for no reason anybody chose.
 *
 * What was typed comes first, so a genuine singular alias always wins. Then
 * the LAST word singular, which is where an entity's head noun is ("goods
 * receipts" → "goods receipt", keeping the "goods"), then every word.
 */
function singularForms(text) {
  const raw = String(text || "");
  const parts = raw.split(/(\s+)/);
  const wordAt = parts.map((w, i) => (/\S/.test(w) ? i : -1)).filter((i) => i >= 0);
  const last = wordAt[wordAt.length - 1];
  const forms = [raw];

  if (last !== undefined) {
    for (const candidate of singularWord(parts[last])) {
      forms.push(parts.map((w, i) => (i === last ? candidate : w)).join(""));
    }
  }
  forms.push(parts.map((w) => (/\S/.test(w) ? singularWord(w)[0] : w)).join(""));
  return [...new Set(forms)];
}

module.exports = {
  INTENT, ORDER, LIMIT_CAP, STATUS_WORDS, isPlural, looksPlural, singularWord, singularForms,
  compileIntent, dateRangeFrom, limitFrom, constraintFrom,
};
