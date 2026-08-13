"use strict";

/**
 * services/callRecordingMatch.service.js
 *
 * Pure matching helpers that decide which synced call recordings belong to a
 * given CRM account or portal customer. No database access, no model imports —
 * `models/CallRecording.js` requires `phoneKey` from here for its pre-save
 * hook, so a require back into the models layer would be a cycle.
 *
 * ── Why matching is heuristic, and stays visible ──────────────────────────
 *
 * Nothing links a recording to a customer at capture time: the Android app only
 * knows what the dialer knew — a number, and whatever the phone's contact book
 * called it. So the join is inferred after the fact from two weak signals:
 *
 *   1. PHONE — strong. Normalized to the last 10 digits so `+91 98765 43210`,
 *      `098765-43210` and `9876543210` all collapse to the same key. India is
 *      10-digit-national; the country code and any trunk 0 are noise here.
 *   2. NAME — weak. The contact was saved as "Mayfair", the account is
 *      "Mayfair Exports Pvt Ltd". Legal suffixes are stripped from both sides
 *      and the remainder is matched as a whole-word substring either way
 *      round, which is generous enough to catch real cases and tight enough
 *      that "Mayfair" does not pull in "May".
 *
 * Because (2) can be wrong, every matched recording is returned with the
 * reason it matched. The UI shows that, rather than presenting a name guess as
 * settled fact.
 */

/** Legal/corporate noise that carries no identifying signal. */
const NAME_STOPWORDS = new Set([
  "pvt", "private", "ltd", "limited", "llp", "inc", "incorporated", "corp",
  "corporation", "co", "company", "and", "the", "&", "opc", "enterprise",
  "enterprises", "india", "intl", "international",
]);

/** Too short to be discriminating — "MB", "SK" would match half the phone book. */
const MIN_NAME_LEN = 4;

/**
 * A single leading word is only used as a match key from this length up.
 *
 * "Mayfair Exports Pvt Ltd" saved on a phone as "Mayfair Textiles" is the
 * ordinary case, and matching the full phrase alone would miss it — so the
 * brand word is a key in its own right. That is a real loosening, and 5
 * characters is where it stops being reckless: "star", "sale", "arya" would
 * collide with unrelated contacts, a 5+ letter brand word rarely does.
 */
const MIN_HEAD_TOKEN_LEN = 5;

/** Indian numbers are 10-digit national; the last 10 digits are the identity. */
const PHONE_KEY_LEN = 10;

const digitsOnly = (v) => String(v ?? "").replace(/\D/g, "");

/**
 * The comparable form of a phone number: its last 10 digits, or null when
 * there aren't enough digits to be a real number (extensions, "Unknown",
 * withheld-number placeholders).
 */
function phoneKey(value) {
  const d = digitsOnly(value);
  if (d.length < PHONE_KEY_LEN) return null;
  return d.slice(-PHONE_KEY_LEN);
}

/** Unique, non-null phone keys from a mixed list of raw numbers. */
function phoneKeys(values) {
  return [...new Set((values || []).map(phoneKey).filter(Boolean))];
}

/**
 * "Mayfair Exports Pvt. Ltd." → "mayfair exports". Lowercased, punctuation
 * flattened to single spaces, legal suffixes dropped. Returns null when
 * nothing discriminating survives.
 */
function nameKey(value) {
  const cleaned = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!cleaned) return null;
  const kept = cleaned.split(" ").filter((w) => w && !NAME_STOPWORDS.has(w));
  const out = (kept.length ? kept : cleaned.split(" ")).join(" ");
  return out.length >= MIN_NAME_LEN ? out : null;
}

/**
 * Unique name keys from a mixed list of raw names.
 *
 * `expandHead` adds each name's leading word as a key of its own — right for
 * ORGANISATION names ("Mayfair Exports Pvt Ltd" should be found by a contact
 * saved as "Mayfair Textiles"), and wrong for PEOPLE, where the leading word is
 * a first name and "Rahul" would sweep in every Rahul in the phone book. The
 * caller decides which list is which.
 */
function nameKeys(values, { expandHead = false } = {}) {
  const out = new Set();
  for (const v of values || []) {
    const key = nameKey(v);
    if (!key) continue;
    out.add(key);
    if (expandHead) {
      const head = key.split(" ")[0];
      if (head && head.length >= MIN_HEAD_TOKEN_LEN) out.add(head);
    }
  }
  return [...out];
}

/**
 * The full key list for one customer: organisation names expanded to their
 * brand word, contact-person names kept as whole phrases only.
 */
function allNameKeys({ names = [], personNames = [] } = {}) {
  return [...new Set([...nameKeys(names, { expandHead: true }), ...nameKeys(personNames)])];
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does a recording's own name field correspond to `key`?
 *
 * Whole-word containment in EITHER direction: the contact book usually holds a
 * shorter name than the CRM ("Mayfair" vs "Mayfair Exports"), but occasionally
 * the reverse ("Mayfair Exports Rahul" vs "Mayfair"). Whole-word is what stops
 * "may" matching "mayfair" and vice versa.
 */
function nameMatches(recordingName, key) {
  const rec = nameKey(recordingName);
  if (!rec || !key) return false;
  const bounded = (haystack, needle) =>
    new RegExp(`(^|\\s)${escapeRegex(needle)}(\\s|$)`).test(haystack);
  return bounded(rec, key) || bounded(key, rec);
}

/**
 * The Mongo filter for "recordings that could belong to this customer".
 *
 * Deliberately a little wider than the final answer — the name clause is a
 * substring regex, so it can over-fetch — and then `annotateMatches` applies
 * the strict whole-word rule in memory. Doing the tight check in the query
 * would need `$where` or an aggregation per name; doing it after a cheap
 * indexed pre-filter is both faster and easier to read.
 *
 * Returns null when there is nothing at all to match on, which the caller must
 * treat as "no recordings" rather than "match everything".
 */
function buildRecordingFilter({ phones = [], names = [], personNames = [] } = {}) {
  const pKeys = phoneKeys(phones);
  const nKeys = allNameKeys({ names, personNames });
  const or = [];

  if (pKeys.length) {
    or.push({ normalizedPhone: { $in: pKeys } });
    /* Documents synced before `normalizedPhone` existed still have only the raw
       number, and a backfill may not have been run on this environment. An
       unanchored digit-tail regex finds them anyway — unindexed and slower, but
       correct, and it disappears from the plan once the backfill lands. */
    or.push({ phoneNumber: { $regex: pKeys.map(escapeRegex).join("|") } });
  }
  for (const n of nKeys) {
    or.push({ contactName: { $regex: escapeRegex(n), $options: "i" } });
    or.push({ audioFileName: { $regex: escapeRegex(n), $options: "i" } });
  }

  if (!or.length) return null;
  return { $or: or };
}

/**
 * Keep only the genuinely-matching recordings and stamp each with why it
 * matched: `phone` (exact number), or `name` (fuzzy, shown as such in the UI).
 * A recording that matches both is reported as `phone` — the stronger signal.
 */
function annotateMatches(recordings, { phones = [], names = [], personNames = [] } = {}) {
  const pKeys = new Set(phoneKeys(phones));
  const nKeys = allNameKeys({ names, personNames });

  const out = [];
  for (const rec of recordings || []) {
    const key = rec.normalizedPhone || phoneKey(rec.phoneNumber);
    if (key && pKeys.has(key)) {
      out.push({ ...rec, matchedBy: "phone", matchedOn: rec.phoneNumber || key });
      continue;
    }
    const hit = nKeys.find(
      (n) => nameMatches(rec.contactName, n) || nameMatches(rec.audioFileName, n),
    );
    if (hit) out.push({ ...rec, matchedBy: "name", matchedOn: rec.contactName || rec.audioFileName });
  }
  return out;
}

module.exports = {
  digitsOnly,
  phoneKey,
  phoneKeys,
  nameKey,
  nameKeys,
  allNameKeys,
  nameMatches,
  buildRecordingFilter,
  annotateMatches,
};
