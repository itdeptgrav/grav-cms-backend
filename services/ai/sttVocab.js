"use strict";
/**
 * services/ai/sttVocab.js — domain vocabulary for the local speech-to-text.
 *
 * Whisper transcribes far better when told the proper nouns it's about to hear.
 * Chrome's Web Speech turned "ledger balance of Mayfair" into "leatherbalance of
 * maker Hotel Run"; feeding Whisper the REAL party / customer / employee names as
 * a bias list ("hotwords") fixes those at the source.
 *
 * The list is capped and cached: Whisper's prompt window is small (~a couple
 * hundred tokens), so we send the most useful proper nouns, not the whole DB.
 */

const mongoose = require("mongoose");

const col = (name) => mongoose.connection.db.collection(name);

// Refresh at most this often — names don't change minute to minute, and this
// runs on the hot path (once per spoken command).
const TTL_MS = 5 * 60 * 1000;
const MAX_PER_SOURCE = 40; // names taken from each collection
const MAX_TOTAL_CHARS = 800; // keep the whole hint inside Whisper's prompt budget

let cache = { at: 0, hotwords: "" };

function cleanName(v) {
  return String(v || "")
    .replace(/\s+/g, " ")
    .replace(/[^\w &.'-]/g, "") // keep letters/numbers/space and a few name chars
    .trim();
}

async function names(collection, filter, project, map, cap = MAX_PER_SOURCE) {
  try {
    const rows = await col(collection).find(filter).project(project).limit(400).toArray();
    const out = [];
    for (const r of rows) {
      const n = cleanName(map(r));
      // Skip empties and single-token generic words — proper nouns (2+ words) or
      // clearly non-dictionary tokens are what Whisper needs help with.
      if (n && n.length >= 3) out.push(n);
      if (out.length >= cap) break;
    }
    return out;
  } catch {
    return [];
  }
}

async function build() {
  const debtorCreditor = { groupName: /debtor|creditor/i };
  const crmName = (r) => r.displayName || r.companyName || r.legalName;

  const [parties, accounts, employees, otherLedgers] = await Promise.all([
    // Party ledgers (Sundry Debtors/Creditors) — the customer/supplier names
    // people actually ask balances for. Highest value for STT.
    names("acc_ledgers", debtorCreditor, { name: 1 }, (r) => r.name, 60),
    // CRM customer accounts — display/legal name (NOT a `name` field).
    names(
      "crmaccounts",
      {},
      { displayName: 1, companyName: 1, legalName: 1 },
      crmName,
      30,
    ),
    names("employees", {}, { firstName: 1, lastName: 1 }, (r) =>
      [r.firstName, r.lastName].filter(Boolean).join(" "),
    ),
    // Remaining named ledgers (banks etc.) fill any leftover budget — lower
    // priority than the proper-noun parties above.
    names(
      "acc_ledgers",
      { groupName: { $not: /debtor|creditor/i } },
      { name: 1 },
      (r) => r.name,
      30,
    ),
  ]);

  // Interleave the sources round-robin so BOTH accounting names (parties,
  // customers) and HR names (employees) survive the char cap — a plain
  // concatenation let 60 party ledgers eat the whole budget and starve
  // employees, breaking "was <employee> present" style queries.
  const sources = [parties, accounts, employees, otherLedgers];
  const seen = new Set();
  const uniq = [];
  const maxLen = Math.max(...sources.map((s) => s.length));
  for (let i = 0; i < maxLen; i++) {
    for (const src of sources) {
      if (i >= src.length) continue;
      const n = src[i];
      const k = n.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(n);
    }
  }

  let hot = "";
  for (const n of uniq) {
    const next = hot ? `${hot}, ${n}` : n;
    if (next.length > MAX_TOTAL_CHARS) break;
    hot = next;
  }
  return hot;
}

/**
 * Returns a comma-separated hotwords string of real domain proper nouns, cached
 * for TTL_MS. Never throws — returns "" if the DB is unreachable.
 */
async function getHotwords() {
  const now = Date.now();
  if (cache.hotwords && now - cache.at < TTL_MS) return cache.hotwords;
  try {
    const hotwords = await build();
    cache = { at: now, hotwords };
    return hotwords;
  } catch {
    return cache.hotwords || "";
  }
}

module.exports = { getHotwords };
