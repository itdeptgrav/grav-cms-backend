// services/partyLinkSafety.js
//
// A merge must not hand one party's CRM link to another party's ledger.
//
// ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
// Merging ledger A into ledger B copied A's `linkedCustomerId` onto B whenever
// B had none. The guard that existed ("only where the destination has none")
// protects B's OWN link from being overwritten — it never asks whether A and B
// are the same party at all.
//
// So a ledger linked to the customer "MAYFAIR CORPORATE BBSR" was merged into
// "MAYFAIR World Cup Village, Rourkela", and Rourkela inherited the link. The
// customer page resolves its ledger through that field, so BBSR's page then
// showed Rourkela's invoices, receipts and balance under BBSR's name — a real
// party reading a different real party's books, with nothing on screen to
// suggest it.
//
// ── WHY A NAME TEST, AND WHY THIS ONE ───────────────────────────────────────
// The legitimate merge is a duplicate: "MAYFAIR Lake Resort Raipur" (created by
// the CRM, empty) into "Mayfair Lake Resort (Raipur)" (imported from Tally,
// holds the trade). There the link SHOULD move — that is the whole point of the
// merge. Those names differ in punctuation, case and word order but share their
// distinctive words. The mismatched pair shares none.
//
// So the test is: after dropping words that identify nobody — corporate forms,
// the group brand every ledger here carries, merge and advance markers — do the
// two names still have a word in common? Shared word: same party, inherit.
// No shared word: refuse, and say so rather than doing it quietly.
//
// This only ever DECLINES to write a link. It cannot create one, and it never
// touches a balance, a voucher or an allocation.

"use strict";

/* Words that appear across unrelated parties and so prove nothing. "mayfair"
   is in this list on purpose: it is the group name shared by two dozen
   different hotels here, so matching on it alone would call any two of them
   the same party — the exact error this module exists to stop. */
const NOISE = new Set([
  "the", "and", "for", "ltd", "ltd.", "pvt", "limited", "llp", "inc",
  "co", "company", "corp", "hotels", "resorts", "resort", "hotel",
  "mayfair", "merged", "advance", "from", "a/c", "ac", "account",
  "new", "old", "duplicate", "dup",
  /* Generic trade and banking words. "Indian Bank" and "HDFC Bank Current A/c"
     share only "bank", which makes them no more the same party than two
     unrelated firms sharing "Traders". A real party name still carries its own
     word — "Sharma Traders" and "Sharma Trading Co" match on "sharma". */
  "bank", "branch", "current", "savings", "cash", "sundry",
  "debtors", "creditors", "general", "misc", "traders", "trading",
  "enterprises", "industries", "agencies", "stores", "store",
]);

function distinctiveWords(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !NOISE.has(w));
}

/**
 * Do these two ledger names plausibly name the same party?
 *
 * Returns true when they share at least one distinctive word. Two names that
 * reduce to nothing but noise are treated as NOT proven — the caller should
 * refuse rather than guess.
 */
function sameParty(nameA, nameB) {
  const a = new Set(distinctiveWords(nameA));
  if (!a.size) return false;
  return distinctiveWords(nameB).some((w) => a.has(w));
}

/**
 * The party-link fields a merge may copy from `source` onto `dest`.
 *
 * Returns `{ $set, skipped }` — `$set` holds only the links that are safe to
 * inherit, and `skipped` describes the ones refused, so the caller can put it
 * in the response instead of leaving the person merging to find out later.
 */
function inheritablePartyLinks(source, dest) {
  const $set = {};
  const skipped = [];
  const related = sameParty(source?.name, dest?.name);

  for (const field of ["linkedCustomerId", "linkedVendorId", "linkedEmployeeId"]) {
    if (!source?.[field] || dest?.[field]) continue;
    if (related) {
      $set[field] = source[field];
    } else {
      skipped.push(
        `${field} was not carried over: "${source.name}" and "${dest.name}" ` +
          `do not appear to be the same party. Link it by hand if they are.`,
      );
    }
  }
  return { $set, skipped };
}

module.exports = { sameParty, distinctiveWords, inheritablePartyLinks };
