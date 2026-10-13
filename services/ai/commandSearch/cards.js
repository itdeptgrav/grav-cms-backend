"use strict";
/**
 * services/ai/commandSearch/cards.js — the record card, for every application.
 *
 * ── ONE SHAPE, ONE LOOK ───────────────────────────────────────────────────
 * A card is `{ title, status, facts: [{label, value}], lead }`: the few facts
 * that matter about ONE record, shown under its result in Cmd/Ctrl K. The
 * browser renders every application's card with the same component
 * (`RecordCard` in components/shell/CommandPalette.js) after the same
 * validation (`normaliseCard`), so a change to how cards look or what a card
 * may carry is made once and holds in Store, Accounting and every application
 * after them.
 *
 * What an application supplies is only WHICH facts, from which record — its
 * own definitions, read through its own scoped reader. Everything else —
 * formatting, the one-record rule, the lead rule, the bounds — lives here.
 *
 * No database access and no model: an application hands in `cardFor`.
 */

const MAX_FACTS = 8;
/** Cards per answer. A card costs a read; a list of ten is not ten cards. */
const MAX_CARDS = 3;

/* ── FORMATTING — the value as a person reads it, never reinterpreted ──── */
const text = (value) => {
  const out = String(value ?? "").replace(/\s+/g, " ").trim();
  return out ? out.slice(0, 120) : null;
};
const date = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
};
const number = (value) => (Number.isFinite(Number(value)) && value !== null && value !== ""
  ? Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 }) : null);
const money = (value) => (number(value) === null ? null : `₹${number(value)}`);
/** "PARTIALLY_RECEIVED" → "Partially received". A recorded value, in words. */
const words = (value) => {
  const raw = text(value);
  if (!raw) return null;
  const spaced = raw.replace(/[_-]+/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};
const count = (list) => (Array.isArray(list) ? String(list.length) : null);
const withUnit = (value, unit) => (number(value) === null ? null : `${number(value)}${text(unit) ? ` ${text(unit)}` : ""}`);

const FORMAT = Object.freeze({ text, date, number, money, words, count, withUnit });

/**
 * Build a card from an application's definition and one record.
 *
 * @param {object} definition  `{ title(r), status(r), facts(r, extra) → [[label, value], …] }`
 * @param {object} record      already read through the application's scoped reader
 * @param {object} [extra]     anything the definition computed beside the record
 */
function buildCard(definition, record, extra = {}) {
  if (!definition || !record) return null;
  const facts = definition.facts(record, extra)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .slice(0, MAX_FACTS)
    .map(([label, value]) => ({ label, value: String(value) }));
  return {
    title: text(definition.title(record)),
    status: (definition.status && definition.status(record)) || null,
    facts,
  };
}

/**
 * Turn an application's trusted record routes into a reader that tells, from
 * a link, which record it opens. Only links the application itself builds can
 * yield a card.
 *
 * @param {object} routes  `{ entity: (id) => "/path/to/<id>" }`
 */
function recordFromHrefFor(routes) {
  const patterns = Object.entries(routes || {}).map(([entity, build]) => {
    const sample = build("RECORDIDX");
    if (!sample) return null;
    const escaped = sample.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("RECORDIDX", "([A-Za-z0-9_-]{1,100})");
    return { entity, pattern: new RegExp(`^${escaped}$`) };
  }).filter(Boolean);
  return (href) => {
    const path = String(href || "").split(/[?#]/)[0];
    for (const { entity, pattern } of patterns) {
      const match = path.match(pattern);
      if (match) return { entity, recordId: match[1] };
    }
    return null;
  };
}

/**
 * Add a card to the results that are about ONE record.
 *
 * `metadata.single` is set by whoever built the row and knows it names one
 * record; a list's first link is not that record's summary. The record is
 * found from the row's own trusted link, or from `metadata.record` when the
 * row has no page to open. Bounded at MAX_CARDS, read side by side, and a
 * card that cannot be read is simply absent — never an error in the answer.
 *
 * ── DOES THE CARD LEAD, OR SIT BENEATH THE ANSWER? ──────────────────────
 * A LOOKUP — a reference, a name, one record of a list — asked for the
 * record, so the card is the answer and leads. A QUESTION about the record
 * ("where is soda ash kept", "balance of Gaurav") has its answer in the
 * sentence; a card that took the sentence's place hid the very thing asked.
 * A lookup carries no concept, or the "records themselves" one.
 *
 * @param {Array}    results
 * @param {object}   app
 * @param {Function} app.cardFor          `({ entity, recordId }) => Promise<card|null>`
 * @param {Function} [app.recordFromHref] from `recordFromHrefFor`
 */
async function withCards(results, { cardFor, recordFromHref = () => null } = {}) {
  if (!Array.isArray(results) || !results.length || typeof cardFor !== "function") return results;
  const targets = [];
  for (const [index, row] of results.entries()) {
    if (targets.length >= MAX_CARDS) break;
    if (!row?.metadata?.single || row.card) continue;
    const record = row.metadata.record || recordFromHref(row.href);
    if (record?.entity && record?.recordId) targets.push({ index, ...record });
  }
  if (!targets.length) return results;
  const cards = await Promise.all(targets.map(({ entity, recordId }) => (
    Promise.resolve().then(() => cardFor({ entity, recordId })).catch(() => null)
  )));
  const out = [...results];
  targets.forEach((target, i) => {
    if (!cards[i]) return;
    const row = out[target.index];
    const concept = row.metadata?.concept;
    out[target.index] = { ...row, card: { ...cards[i], lead: !concept || /^__/.test(concept) } };
  });
  return out;
}

module.exports = {
  MAX_FACTS, MAX_CARDS, FORMAT, buildCard, recordFromHrefFor, withCards,
};
