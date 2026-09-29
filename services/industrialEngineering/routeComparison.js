// services/industrialEngineering/routeComparison.js
//
// INDUSTRIAL ENGINEERING — DO THE TWO STORED ROUTES SAY THE SAME THING?
//
// ── WHY THIS IS PURE, AND ON ITS OWN ────────────────────────────────────────
// The Chunk 0 audit found two writable answers to "what operations does this
// style use and how long do they take?" — the style's technical route
// (`SampleStyle.techSheet.technical.operations[]`, written by Production's
// narrow door) and the product route (`StockItem.operations[]`, written by
// several Sales/Inventory paths). They are NOT the same array and either can
// move without the other.
//
// Chunk 1A does not choose between them. It states, in one word, whether they
// agree — and where they do not, WHICH KIND of disagreement it is, so the
// person who has to reconcile them knows whether they are looking at a
// re-timing, a re-ordering, or two different methods.
//
// Nothing here reads the database, and nothing here writes. It takes two
// already-projected row lists and returns a state. That is what makes the
// precedence below testable as arithmetic rather than as a fixture.
//
// ── THE PRECEDENCE, AND WHY IT IS THIS ORDER ────────────────────────────────
// More than one difference can be true at once: two routes can hold different
// operations AND different times AND a different order. Reporting whichever
// was noticed first would make the same pair of routes report differently
// depending on how the code was edited, so the rules are ORDERED and the
// first that fires wins. The order runs from "the comparison cannot be
// trusted" through "there is nothing to compare" to the narrowest real
// difference:
//
//   1. the product source could not be identified  → AMBIGUOUS
//   2. neither source holds a route                → NO_ROUTE
//   3. only the technical source holds one         → ONLY_TECHNICAL_ROUTE
//   4. only the product source holds one           → ONLY_PRODUCT_ROUTE
//   5. a row on either side cannot be keyed        → AMBIGUOUS
//   6. a code the routes use names two operations  → AMBIGUOUS
//   7. the operations themselves differ            → DIFFERENT_OPERATIONS
//   8. the same operations in a different order    → DIFFERENT_SEQUENCE
//   9. the same order, different standard times    → DIFFERENT_TIME
//  10. otherwise                                   → MATCHED
//
// Rules 7→9 are deliberately coarse-to-fine. A pair of routes that hold
// different operations is not usefully described as "a different time": the
// times belong to operations that are not in both lists, so the narrower
// finding would be an artefact of position rather than a fact about the work.
//
// Rule 5 is the honest refusal. A technical row carries the operation code the
// register gave it; a product row's code is optional and many legacy rows have
// none. Two lists cannot be matched by name when one side is coded and the
// other is not — guessing a pairing is exactly the "silently choose one as
// authoritative" this chunk forbids — so the comparison says so instead.
//
// ── AND RULE 6 IS THE SAME REFUSAL, ONE LEVEL UP ────────────────────────────
// The code is the key, and the operation MASTER does not guarantee it is
// unique — the Chunk 0 audit found live duplicates (TS008 among them) and this
// chunk deliberately does not reconcile them. So two routes can both say
// `TS008`, agree on order and agree on time, and still be describing two
// DIFFERENT registered operations. Reporting that as MATCHED would be the
// strongest claim this file can make, resting on a key that does not identify
// anything; it is answered as AMBIGUOUS instead, with the offending codes
// named so the reader is sent to the register rather than to the routes.
//
// It sits BELOW rule 5 because a row with no code at all is the more basic
// failure — nothing about a nameless row can be checked against the master —
// and ABOVE 7→9 because a content comparison keyed on an ambiguous code
// cannot be trusted whatever it concludes.
//
// Only codes the routes actually USE are consulted. A duplicate elsewhere in
// the register is somebody else's problem and must not colour this style: an
// ambiguity that spreads from records a style never names would make every
// style in the company ambiguous the day one duplicate was typed.
"use strict";

/** The eight answers this function may give. No ninth is invented downstream. */
const STATE = Object.freeze({
  MATCHED: "MATCHED",
  DIFFERENT_SEQUENCE: "DIFFERENT_SEQUENCE",
  DIFFERENT_TIME: "DIFFERENT_TIME",
  DIFFERENT_OPERATIONS: "DIFFERENT_OPERATIONS",
  ONLY_TECHNICAL_ROUTE: "ONLY_TECHNICAL_ROUTE",
  ONLY_PRODUCT_ROUTE: "ONLY_PRODUCT_ROUTE",
  NO_ROUTE: "NO_ROUTE",
  AMBIGUOUS: "AMBIGUOUS",
});

const STATES = Object.freeze(Object.values(STATE));

/**
 * The ordered rules, published so a caller (and a test) can assert the order
 * rather than infer it. Each entry is `[reason, state]`; the first rule whose
 * `when` holds decides. `AMBIGUOUS` appears three times because three
 * different facts reach it, and collapsing them would lose which one the
 * reader must fix — an unresolvable product, an uncodeable row, and a code the
 * operation master does not hold uniquely each send somebody to a different
 * screen.
 */
const PRECEDENCE = Object.freeze([
  Object.freeze({ reason: "PRODUCT_SOURCE_NOT_IDENTIFIABLE", state: STATE.AMBIGUOUS }),
  Object.freeze({ reason: "NEITHER_SOURCE_HOLDS_A_ROUTE", state: STATE.NO_ROUTE }),
  Object.freeze({ reason: "PRODUCT_SOURCE_HOLDS_NO_ROUTE", state: STATE.ONLY_TECHNICAL_ROUTE }),
  Object.freeze({ reason: "TECHNICAL_SOURCE_HOLDS_NO_ROUTE", state: STATE.ONLY_PRODUCT_ROUTE }),
  Object.freeze({ reason: "ROWS_CANNOT_BE_MATCHED", state: STATE.AMBIGUOUS }),
  Object.freeze({ reason: "OPERATION_CODE_NOT_UNIQUE", state: STATE.AMBIGUOUS }),
  Object.freeze({ reason: "OPERATIONS_DIFFER", state: STATE.DIFFERENT_OPERATIONS }),
  Object.freeze({ reason: "SEQUENCE_DIFFERS", state: STATE.DIFFERENT_SEQUENCE }),
  Object.freeze({ reason: "STANDARD_TIME_DIFFERS", state: STATE.DIFFERENT_TIME }),
  Object.freeze({ reason: "SOURCES_AGREE", state: STATE.MATCHED }),
]);

const str = (v) => String(v ?? "").trim();

/**
 * The one key two rows may be matched on.
 *
 * The operation CODE, upper-cased, and nothing else. Not the name — a name is
 * free text on the product route and a register snapshot on the technical one,
 * and "Side seam" matching "Side Seam (both)" is a pairing nobody authorised.
 * A row with no code returns `null`, which rule 5 turns into AMBIGUOUS rather
 * than into a guess.
 */
function rowKey(row) {
  const code = str(row?.operationCode).toUpperCase();
  return code || null;
}

/**
 * The standard time of a row, as a value that can be COMPARED exactly.
 *
 * A missing time is `"-"`, which is equal to another missing time and unequal
 * to every number — including zero. That is the whole point: a row nobody has
 * timed and a row timed at nothing are different facts, and this chunk must
 * not turn the first into the second.
 */
function timeKey(row) {
  const sam = row?.samMinutes;
  return sam === null || sam === undefined ? "-" : String(sam);
}

/**
 * The caller's duplicate-code list, in the same normal form `rowKey` produces.
 *
 * Normalised HERE as well as at the query that built it. The two normalisations
 * have to agree exactly or the check silently passes everything, and a check
 * that fails open is worse than no check — so this one does not trust its
 * input's casing, and accepts a Set or an array so no caller has to convert.
 */
function normaliseCodes(codes) {
  const iterable = codes instanceof Set ? codes : (Array.isArray(codes) ? codes : []);
  const out = new Set();
  for (const code of iterable) {
    const key = str(code).toUpperCase();
    if (key) out.add(key);
  }
  return out;
}

/** A multiset comparison — order-independent, duplicate-sensitive. */
function sameOperations(a, b) {
  if (a.length !== b.length) return false;
  const sorted = (keys) => [...keys].sort();
  const left = sorted(a);
  const right = sorted(b);
  return left.every((key, i) => key === right[i]);
}

/**
 * Compare the two stored route sources for one style.
 *
 * @param {object} input
 * @param {object[]} input.technicalRows  projected rows from
 *   `SampleStyle.techSheet.technical.operations[]`, in stored order.
 * @param {object[]} input.productRows    projected rows from the connected
 *   `StockItem.operations[]`, in stored order.
 * @param {boolean} [input.productSourceIdentifiable=true]  whether the style's
 *   product could be resolved to exactly one existing record. `false` means
 *   "we do not know whether a product route exists", which is not the same as
 *   "there is none".
 * @param {Set<string>|string[]} [input.duplicatedMasterCodes]  operation codes
 *   the master holds MORE THAN ONE record for, upper-cased. Only codes these
 *   two routes actually use are consulted, so a duplicate elsewhere in the
 *   register cannot make this style ambiguous. Normalised here as well as by
 *   the caller, so a lower-cased entry cannot slip past the check.
 * @returns {{state: string, reason: string, ruleIndex: number, details: object}}
 */
function compareRoutes({
  technicalRows = [],
  productRows = [],
  productSourceIdentifiable = true,
  duplicatedMasterCodes = null,
} = {}) {
  const technical = Array.isArray(technicalRows) ? technicalRows : [];
  const product = Array.isArray(productRows) ? productRows : [];

  const decide = (reason, details = {}) => {
    const ruleIndex = PRECEDENCE.findIndex((rule) => rule.reason === reason);
    return { state: PRECEDENCE[ruleIndex].state, reason, ruleIndex, details };
  };

  /* 1 — the source itself is in doubt. This outranks "no route": a style whose
     product cannot be identified has not been shown to lack a product route. */
  if (!productSourceIdentifiable) return decide("PRODUCT_SOURCE_NOT_IDENTIFIABLE");

  /* 2–4 — presence, before any content is looked at. */
  if (!technical.length && !product.length) return decide("NEITHER_SOURCE_HOLDS_A_ROUTE");
  if (!product.length) return decide("PRODUCT_SOURCE_HOLDS_NO_ROUTE");
  if (!technical.length) return decide("TECHNICAL_SOURCE_HOLDS_NO_ROUTE");

  /* 5 — both hold rows, and at least one of them cannot be keyed. */
  const technicalKeys = technical.map(rowKey);
  const productKeys = product.map(rowKey);
  const unkeyedTechnical = technicalKeys.filter((k) => k === null).length;
  const unkeyedProduct = productKeys.filter((k) => k === null).length;
  if (unkeyedTechnical || unkeyedProduct) {
    return decide("ROWS_CANNOT_BE_MATCHED", {
      uncodedTechnicalRows: unkeyedTechnical,
      uncodedProductRows: unkeyedProduct,
    });
  }

  /* 6 — every row is keyed, and at least one of those keys names more than one
     registered operation. The two routes may well agree letter for letter and
     still be describing different work, so nothing narrower than "ambiguous"
     can honestly be said about them.

     Intersected with the keys THESE routes use, never applied wholesale: a
     duplicate the style does not name is not this style's ambiguity. */
  const duplicated = normaliseCodes(duplicatedMasterCodes);
  if (duplicated.size) {
    const used = [...new Set([...technicalKeys, ...productKeys])]
      .filter((key) => duplicated.has(key))
      /* Sorted so the same pair of routes reports the same list every time —
         a set's iteration order is insertion order, which is the row order. */
      .sort();
    if (used.length) return decide("OPERATION_CODE_NOT_UNIQUE", { duplicatedCodes: used });
  }

  /* 7 — the same work, or not. Checked as a multiset so a route that merely
     moved an operation is not reported as holding different operations. */
  if (!sameOperations(technicalKeys, productKeys)) return decide("OPERATIONS_DIFFER");

  /* 8 — the same work in a different order. */
  if (technicalKeys.some((key, i) => key !== productKeys[i])) return decide("SEQUENCE_DIFFERS");

  /* 9 — the same work, in order, timed differently. */
  const technicalTimes = technical.map(timeKey);
  const productTimes = product.map(timeKey);
  if (technicalTimes.some((t, i) => t !== productTimes[i])) return decide("STANDARD_TIME_DIFFERS");

  return decide("SOURCES_AGREE");
}

module.exports = { STATE, STATES, PRECEDENCE, compareRoutes, rowKey, timeKey, normaliseCodes };
