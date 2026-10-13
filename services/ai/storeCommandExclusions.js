"use strict";
/**
 * services/ai/storeCommandExclusions.js — what Store search does NOT answer,
 * and why.
 *
 * ── WHY THIS IS A MODULE AND NOT A TEST FIXTURE ───────────────────────────
 * An exclusion recorded only in a test is an excuse: it reads as something
 * that failed and was forgiven. These are product decisions — shapes of
 * question the palette will not answer because answering them would be
 * guessing — and they belong where the product can state them, so the audit,
 * the suite and anybody reading the service find the same list with the same
 * reason.
 *
 * Each entry is a KIND of question against a FAMILY, with the reason it is
 * refused and the thing that answers instead. Nothing here is a bug waiting
 * to be fixed; a bug waiting to be fixed is a gap, and gaps live in the
 * matrix suite where they fail the build.
 */

const { ENTITY_SPECS } = require("../storePurchaseUniversalContract");

/** Question shapes, named as the matrix names them. */
const KIND = Object.freeze({
  EXACT_IDENTITY: "exact identity",
  PARTIAL_IDENTITY: "partial identity",
});

/**
 * A singleton settings document.
 *
 * Re-read 8 Oct 2026: kept. On the live database "store settings",
 * "production settings" and "sales settings" each answer by name.
 *
 * There is exactly one of each, and it carries no business reference — no
 * number, no code, nothing anybody could type. It is reached by its NAME
 * ("store settings"), which is answered, and that is the only address it has.
 */
const SINGLETON_IDENTITY = {
  kinds: [KIND.EXACT_IDENTITY, KIND.PARTIAL_IDENTITY],
  applies: (spec) => Boolean(spec.singleton),
  reason: "A settings document is one row with no business reference — there is "
    + "nothing to type. It is addressed by its name.",
  instead: "Ask for it by name, for example \"store settings\".",
};

/**
 * A family whose business identity is a bare integer.
 *
 * A number is not a document reference. Treating one as an identity would
 * match any record that happens to hold that figure in any field — a
 * quantity, a price, a year — so a question that is only a number is refused
 * rather than answered about whichever record was found first.
 *
 * ── RE-READ 8 OCT 2026: AND WITH THE FAMILY NAMED FIRST? ────────────────
 * "development BOM revision 101" is a different shape from a bare "101", so
 * it was asked again rather than assumed. It is still not an identity:
 *   - on the live database all eight revisions are numbered 1 — a revision
 *     number is unique only WITHIN a development file, so the family named
 *     and the number together still name eight records;
 *   - the field reader took "revision" out of the family's own name as the
 *     concept asked for, and answered "101's revision is not recorded" about
 *     the record whose revision number is 101;
 *   - the collection reader cannot place a bare number as an identity, so
 *     the plural ("development BOM revisions 101") is refused.
 * The identity a person can actually type is the development file's number
 * with the revision; until that composite is the family's identity, both
 * shapes stay excluded.
 */
const NUMERIC_IDENTITY = {
  kinds: [KIND.EXACT_IDENTITY, KIND.PARTIAL_IDENTITY],
  applies: (spec, { identity } = {}) => /^\d+$/.test(String(identity ?? "")),
  reason: "Its business identity is a bare integer, and a number is not a document "
    + "reference: treating one as an identity would match any record holding that "
    + "figure in any field.",
  instead: "Name the family and filter it — \"development BOM revisions\" and the "
    + "status, date or field you mean.",
};

/**
 * A family with no business identity at all.
 *
 * `storage_position` is a LocationBalance: the quantity of one item at one
 * shelf. Its catalogue entry declares identity fields the model does not have
 * (`warehouseName`, `locationCode`, `rawItemSku` are denormalised names the
 * balance never stores), so there is nothing to match a question against and
 * nothing to print in an answer. The thing people actually ask — where an
 * item is kept — is answered by `inventory_location_metric`, which reads the
 * same balances and resolves the ITEM by name.
 *
 * Re-read 8 Oct 2026: kept. The family is still reachable as a collection
 * ("storage positions", "how many storage positions" answer), and "where is
 * <item> kept" answers through the location reader, proven by the
 * integration suite ("where is soda ash kept" → Bin 2) and on live data.
 * The live collection holds no balances yet, so every live answer today is
 * honestly "no recorded position".
 */
const UNIDENTIFIABLE_FAMILIES = Object.freeze({
  storage_position: {
    reason: "A location balance is the quantity of one item at one shelf; it carries "
      + "no identity of its own, and its catalogue entry names fields the model "
      + "does not store.",
    instead: "`inventory_location_metric` answers \"where is <item> kept\" from the "
      + "same balances, resolving the item by name.",
  },
});

const RULES = Object.freeze([SINGLETON_IDENTITY, NUMERIC_IDENTITY]);

/**
 * Store-owned COLLECTIONS search deliberately does not read.
 *
 * `scripts/audits/store-collection-coverage.js` classifies every collection a
 * Store model writes, and a Store collection that is neither catalogued, nor
 * served by the legacy `store` family, nor listed here fails it. So this is
 * the complete list of Store data the palette leaves alone, each with why and
 * with what answers instead — decided 8 Oct 2026 against the live database,
 * with the row counts it held that day.
 */
const EXCLUDED_COLLECTIONS = Object.freeze({
  mrfchatmessages: {
    reason: "A conversation, not a record: the messages a requester and the Store "
      + "exchanged about one MRF, written as people talk. A search that quoted "
      + "them back would be quoting people, not reporting Store data. (87 rows.)",
    instead: "The material request itself — its number, status, lines and "
      + "who raised it — is catalogued as `material_request`.",
  },
  locationreservations: {
    reason: "A concurrency projection: the reserved quantity per item and shelf, "
      + "kept only so two people cannot reserve the same last unit. It is "
      + "rebuildable from the reservations and is not an authority. (0 rows.)",
    instead: "`stock_reservation` holds the reservations themselves.",
  },
  rawitemaddrequests: {
    reason: "Superseded and read-only: product requests now live on the material "
      + "request, and the old number-less records carry no company, so they "
      + "cannot be scoped to one. (0 rows.)",
    instead: "Product requests on a material request, through `material_request`.",
  },
  sp_idempotency_records: {
    reason: "A stored HTTP response kept so a double-clicked action has one "
      + "effect. A technical replay record; nobody asks about one. (147 rows.)",
    instead: "The document the action created — a goods receipt, a purchase order.",
  },
  sp_company_memberships: {
    reason: "Who belongs to which company: access control, decided by an "
      + "administrator, not Store data a Store reader is entitled to list. (15 rows.)",
    instead: "Company membership is managed in the access-control screens.",
  },
  sp_approval_policies: {
    reason: "Who may approve what, up to how much: authority configuration read "
      + "by the approval resolver. Listing authority limits is not something "
      + "the Store read capability grants. (0 rows.)",
    instead: "A purchase order's own approval state, through `purchase_order`.",
  },
  Mrves: {
    /* No model writes it: only the live database holds it. */
    unmodelled: true,
    reason: "A stale case-variant copy of `mrves` with no model behind it: all four "
      + "of its records are also in `mrves`, under the same MRF numbers. (4 rows.)",
    instead: "`material_request`, which reads `mrves`.",
  },
  productchangerequests: {
    /* No model writes it: only the live database holds it. */
    unmodelled: true,
    reason: "Orphaned: the approval queue for stock-item edits, whose model was "
      + "removed when edits moved to the change log. No code reads or writes it. "
      + "(7 rows, the newest 28 Aug 2026.)",
    instead: "A stock item's own history page, which reads the change log.",
  },
  storedepartments: {
    reason: "The Store department's sign-in accounts, with password hashes. "
      + "Credentials are never searchable. (0 rows.)",
    instead: "Nothing — sign-in accounts are not Store data.",
  },
});

/** Why Store search leaves this collection alone, or null. */
function excludedCollection(name) {
  const entry = EXCLUDED_COLLECTIONS[name];
  return entry ? { collection: name, ...entry } : null;
}

/**
 * Why this question shape is excluded for this family, or null.
 *
 * @param {object} spec  an ENTITY_SPEC
 * @param {string} kind  a question kind, as the matrix names it
 * @param {object} [facts]  what the asker knows — `{ identity }`
 */
function exclusionFor(spec, kind, facts = {}) {
  if (!spec) return null;
  const family = UNIDENTIFIABLE_FAMILIES[spec.id];
  if (family) return { ...family, scope: "family" };
  for (const rule of RULES) {
    if (!rule.kinds.includes(kind)) continue;
    if (!rule.applies(spec, facts)) continue;
    return { reason: rule.reason, instead: rule.instead, scope: "kind" };
  }
  return null;
}

/** Every family this excludes entirely, with its reason. */
function excludedFamilies() {
  return Object.entries(UNIDENTIFIABLE_FAMILIES).map(([id, entry]) => ({
    entity: id,
    exists: ENTITY_SPECS.some((spec) => spec.id === id),
    ...entry,
  }));
}

module.exports = {
  KIND, RULES, UNIDENTIFIABLE_FAMILIES, EXCLUDED_COLLECTIONS,
  exclusionFor, excludedFamilies, excludedCollection,
};
