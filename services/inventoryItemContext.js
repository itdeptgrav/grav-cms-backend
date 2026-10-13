"use strict";

const RawItem = require("../models/CMS_Models/Inventory/Products/RawItem");
const { includesTerm } = require("./ai/semanticCatalogue");
const { FIELD_CONTRACT, DEFINITIONS } = require("./inventoryItemContract");
const tenantContext = require("./storePurchase/tenantContext.service");

const IDENTITY_PROJECTION = "name sku";

const QUESTION_WORDS = new Set([
  "a", "an", "and", "are", "can", "do", "does", "for", "give", "has", "have",
  "how", "i", "in", "is", "it", "kept", "located", "location", "me", "much", "of",
  "please", "rack", "shelf", "show", "stored", "storage", "tell", "that", "the",
  "this", "to", "what", "where", "which", "with", "bin",
]);
const METRIC_WORDS = new Set(DEFINITIONS.flatMap((definition) => (
  [definition.label, ...(definition.aliases || [])]
    .flatMap((value) => String(value || "").toLowerCase().match(/[a-z0-9]+/g) || [])
)));

function suggestionTokens(value) {
  return [...new Set((String(value || "").toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((token) => token.length >= 3 && !QUESTION_WORDS.has(token) && !METRIC_WORDS.has(token)))];
}

function identityTokenSet(item) {
  return new Set(identityTerms(item)
    .flatMap((value) => String(value || "").toLowerCase().match(/[a-z0-9]+/g) || []));
}

function identityTerms(item) {
  return [item.sku, item.name].filter((value) => String(value || "").trim());
}

const FOLLOW_UP = /^\s*(which|where|what about|how about|and|there|that|same)\b/i;

function priorSubject(history) {
  const turns = Array.isArray(history) ? history : [];
  const previous = [...turns].reverse().find((turn) => (
    turn?.role === "assistant" && turn?.contextState?.subject?.type === "inventory_item"
  ));
  return previous?.contextState?.subject || null;
}

/**
 * Find the item somebody means.
 *
 * ── BY ITS OWN ID, WHEN THERE IS ONE ──────────────────────────────────────
 * Normally that means matching what they typed against every authorised
 * item's name and SKU. But when an earlier answer offered a choice between
 * two items and the person PICKED one, there is nothing left to match: the
 * canonical id of the record they chose is the whole question. Searching the
 * label again would be a second guess at the same ambiguous words, and an
 * item whose name is contained in another's could never be picked at all.
 *
 * The read is scoped by the same tenant filter as every other path here, so
 * an id from outside the company resolves to nothing.
 */
async function resolveInventoryItem({ user, message, history = [], recordId = null }) {
  const ctx = user?.storePurchaseAccess;
  if (!ctx?.companyId) return { found: false, ambiguous: false, matches: [] };
  const filter = tenantContext.tenantFilter(ctx);
  if (recordId) {
    if (!/^[a-f\d]{24}$/i.test(String(recordId))) return { found: false, ambiguous: false, matches: [] };
    const chosen = await RawItem.findOne({ $and: [filter, { _id: recordId }] })
      .select(FIELD_CONTRACT.projection())
      .lean();
    return chosen
      ? { found: true, ambiguous: false, record: chosen, chosen: true }
      : { found: false, ambiguous: false, matches: [] };
  }
  const winners = [];
  const suggestions = [];
  const requestedTokens = suggestionTokens(message);
  let longest = 0;
  const cursor = RawItem.find(filter).select(IDENTITY_PROJECTION).lean().cursor();
  for await (const item of cursor) {
    if (requestedTokens.length) {
      const identityTokens = identityTokenSet(item);
      if (requestedTokens.every((token) => identityTokens.has(token))) suggestions.push(item);
    }
    const matches = identityTerms(item).filter((term) => includesTerm(message, term));
    if (!matches.length) continue;
    const length = Math.max(...matches.map((term) => String(term).length));
    if (length > longest) {
      longest = length;
      winners.length = 0;
      winners.push(item);
    } else if (length === longest) {
      winners.push(item);
    }
  }
  /* ── A WHOLE NAME INSIDE THE WORDS IS NOT ALWAYS THE ONE MEANT ────────
       "stock of feed of the arm folder" contains the whole name "Folder", so
       that item won — while "Feed of the Arm folder 1/4", which every word
       said belongs to, lost for want of the "1/4" nobody says aloud (found by
       voice, 9 Oct 2026). When the whole-name winners cover only some of the
       words and other items cover all of them, those are what was meant: one
       is the answer, several are a choice. "stock of folder" still finds
       Folder — its one word is covered. */
  if (winners.length && suggestions.length && requestedTokens.length > 1) {
    const coversAll = (item) => {
      const tokens = identityTokenSet(item);
      return requestedTokens.every((token) => tokens.has(token));
    };
    if (!winners.some(coversAll)) {
      winners.length = 0;
      if (suggestions.length === 1) winners.push(suggestions[0]);
    }
  }
  if (!winners.length && FOLLOW_UP.test(String(message || ""))) {
    const prior = priorSubject(history);
    if (prior?.sku || prior?.name) {
      const identity = prior.sku ? { sku: prior.sku } : { name: prior.name };
      const priorRecord = await RawItem.findOne({ $and: [filter, identity] })
        .select(FIELD_CONTRACT.projection())
        .lean();
      if (priorRecord) return { found: true, ambiguous: false, record: priorRecord, inherited: true };
    }
  }
  if (!winners.length && suggestions.length) {
    const matches = suggestions
      .sort((left, right) => String(left.name || left.sku || "")
        .localeCompare(String(right.name || right.sku || "")))
      .slice(0, 8)
      .map((row) => ({ _id: row._id, name: row.name, sku: row.sku }));
    return { found: false, ambiguous: true, suggested: true, matches };
  }
  if (!winners.length) return { found: false, ambiguous: false, matches: [] };
  if (winners.length !== 1) {
    return {
      found: false,
      ambiguous: true,
      matches: winners.slice(0, 8).map((row) => ({ _id: row._id, name: row.name, sku: row.sku })),
    };
  }
  const record = await RawItem.findOne({ $and: [filter, { _id: winners[0]._id }] })
    .select(FIELD_CONTRACT.projection())
    .lean();
  if (!record) return { found: false, ambiguous: false, matches: [] };
  return { found: true, ambiguous: false, record };
}

module.exports = { resolveInventoryItem, suggestionTokens };
