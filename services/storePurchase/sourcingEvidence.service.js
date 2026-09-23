// services/storePurchase/sourcingEvidence.service.js
//
// STORE & PURCHASE — WHERE PURCHASED GOODS COME FROM, AND HOW THEY CLASSIFY.
//
// ── THE QUESTION THIS ANSWERS, AND THE ONE IT DOES NOT ──────────────────────
// Customs duty is charged on imported goods, by origin and tariff heading.
// Nothing in this system recorded either, so Central Costing reported the
// whole `duty` family as having no source anywhere. This is the Store half of
// closing that: the FACTS. It computes no duty, holds no rate, and names no
// percentage — the table that turns a heading and an origin into a rate is the
// Board's, and it does not exist yet.
//
// So a costing consuming this learns whether the facts are complete. It does
// not learn what the duty is, and this file would be the wrong place to tell
// it.
//
// ── AND MISSING IS NEVER DUTY-FREE ──────────────────────────────────────────
// The single mistake worth designing against: an item nobody has classified
// reading as an item with nothing to pay. `DOMESTIC` is an answer somebody
// gave; absent is a question nobody has. They are different states here, they
// produce different readiness, and neither is ever a zero.
//
// ── WHAT LEAVES THIS FILE ───────────────────────────────────────────────────
// Origin, classification, completeness, and the quotation reference that
// carried the evidence. NOT the rate, the amount, the supplier's name, the
// tiers, the MOQ or the validity terms — Merchandising, R&D, Production and
// Sales may all legitimately be told whether a costing can proceed, and none
// of them may be told what the company pays.
"use strict";

const mongoose = require("mongoose");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const model = (name, path) => (mongoose.models[name] || require(path));
const SupplierOffer = () => model("SupplierOffer", "../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const RawItem = () => model("RawItem", "../../models/CMS_Models/Inventory/Products/RawItem");

/** How the goods were obtained. A stated answer, never inferred. */
const SOURCING_TYPES = Object.freeze(["DOMESTIC", "IMPORTED"]);

/* ── FIVE STATES, AND TWO OF THEM ARE ANSWERS ───────────────────────────────
 *
 * `NOT_APPLICABLE` is reachable ONLY through an explicit `DOMESTIC` decision.
 * There is no path from silence to it — that is the whole point of separating
 * it from `MISSING`, and the reason this enum is not a boolean. */
const EVIDENCE = Object.freeze({
  /* Imported, with an origin and a tariff heading. Costing can proceed as far
     as the missing duty table allows. */
  READY: "READY",
  /* Domestic, stated by Store. No customs entry, so no duty — an answer. */
  NOT_APPLICABLE: "NOT_APPLICABLE",
  /* Some of it is recorded and some is not. */
  IN_PROGRESS: "IN_PROGRESS",
  /* Store has recorded nothing about where these goods come from. */
  MISSING: "MISSING",
  /* No usable quotation to carry the evidence. Not Store failing to answer —
     nothing to answer it ON, which is a different fix. */
  NO_QUOTATION: "NO_QUOTATION",
});

const EVIDENCE_LABEL = Object.freeze({
  READY: "Recorded",
  NOT_APPLICABLE: "Domestic — no customs entry",
  IN_PROGRESS: "Partly recorded",
  MISSING: "Not recorded",
  NO_QUOTATION: "No active quotation",
});

/** The states that stop the duty family being answerable. */
const BLOCKING = Object.freeze([EVIDENCE.IN_PROGRESS, EVIDENCE.MISSING, EVIDENCE.NO_QUOTATION]);

/**
 * ONE ITEM'S SOURCING EVIDENCE, from its quotation and its classification.
 *
 * Pure and exported, so every branch is exercised without a database — a rule
 * that can only be reached through a route is a rule nobody checks.
 *
 * @param {object|null} offer  the ACTIVE quotation the costing would price
 *   from, or null where there is none.
 * @param {object|null} item   the item master, for its tariff classification.
 */
function assess(offer, item) {
  const tariffCode = str(item?.customsTariffCode).toUpperCase();
  const base = {
    itemId: str(item?._id),
    itemName: str(item?.name),
    itemSku: str(item?.sku),
    /* The classification, which belongs to the goods. */
    customsTariffCode: tariffCode,
    sourcingType: "",
    countryOfOrigin: "",
    /* Whether the quoted rate already carries the duty. Absent means nobody
       has been asked, which Costing blocks on rather than guessing either
       way — see the field's own comment on `SupplierOffer`. */
    dutyInQuotedRate: "",
    evidenceNote: "",
    /* WHICH quotation said so. A reference and a date, so the claim can be
       traced to paper — never the rate on it. */
    quotation: null,
    missing: [],
  };

  if (!offer) {
    return {
      ...base,
      state: EVIDENCE.NO_QUOTATION,
      blocking: true,
      missing: [{
        field: "quotation",
        owner: "Store",
        message: "There is no active quotation for this item to record its sourcing against.",
      }],
    };
  }

  const sourcing = offer.sourcing || {};
  const type = SOURCING_TYPES.includes(str(sourcing.type)) ? str(sourcing.type) : "";
  const origin = str(sourcing.countryOfOrigin).toUpperCase();

  const row = {
    ...base,
    sourcingType: type,
    countryOfOrigin: type === "IMPORTED" ? origin : "",
    /* Only meaningful on an import: a domestic supply has no customs entry for
       duty to be inside. */
    dutyInQuotedRate: type === "IMPORTED" ? str(sourcing.dutyInQuotedRate).toUpperCase() : "",
    evidenceNote: str(sourcing.evidenceNote),
    quotation: {
      offerId: str(offer._id),
      /* The revision, so a costing frozen against this quotation can be told
         from one frozen against a later edit of the same offer. */
      revision: offer.revision ?? null,
      reference: str(offer.quotationReference),
      quotationDate: offer.quotationDate || null,
      effectiveFrom: offer.effectiveFrom || null,
      validUntil: offer.validUntil || null,
      /* So a reader can tell a current claim from one that has aged out. The
         offer's own status is separate and is why it was chosen at all. */
      expired: Boolean(offer.validUntil && new Date(offer.validUntil) < new Date()),
    },
  };

  if (!type) {
    return {
      ...row,
      state: EVIDENCE.MISSING,
      blocking: true,
      missing: [{
        field: "sourcing.type",
        owner: "Store",
        message: "Nobody has said whether these goods are bought in India or imported. "
          + "An unanswered question is not a domestic supply.",
      }],
    };
  }

  if (type === "DOMESTIC") {
    /* ── AN ANSWER, AND THE ONLY ROUTE TO NOT-APPLICABLE ────────────────
       No customs entry means no duty and no tariff heading to look up. That
       is a decision Store made and can be traced to a quotation, which is
       exactly what distinguishes it from an item nobody has looked at. */
    return { ...row, state: EVIDENCE.NOT_APPLICABLE, blocking: false, missing: [] };
  }

  /* Imported. Both halves are needed: an origin decides WHICH duty, and a
     heading decides WHAT duty. One without the other prices nothing. */
  const missing = [];
  if (!origin) {
    missing.push({
      field: "sourcing.countryOfOrigin", owner: "Store",
      message: "Imported goods need a country of origin — duty depends on where they came from.",
    });
  }
  if (!tariffCode) {
    missing.push({
      field: "customsTariffCode", owner: "Store",
      message: `${row.itemName || "This item"} has no customs tariff classification on the item master. `
        + "The GST HSN on the quotation is a different classification and is not one.",
    });
  }
  /* ── AND WHETHER THE RATE ALREADY CARRIES THE DUTY ────────────────────
     Asked because neither guess is safe: adding duty to a landed rate charges
     it twice, and assuming it is included understates every metre. */
  if (!row.dutyInQuotedRate) {
    missing.push({
      field: "sourcing.dutyInQuotedRate", owner: "Store",
      message: "Nobody has recorded whether this supplier's quoted rate already includes customs duty. "
        + "The freight terms answer a different question.",
    });
  }

  return {
    ...row,
    state: missing.length ? EVIDENCE.IN_PROGRESS : EVIDENCE.READY,
    blocking: missing.length > 0,
    missing,
  };
}

/**
 * The ACTIVE quotation each item would be priced from.
 *
 * ── WHY `ACTIVE` AND NOT "THE LATEST" ───────────────────────────────────────
 * A `DRAFT` is not evidence — nobody has published it. A `SUPERSEDED` or
 * `WITHDRAWN` one is a record of what was true, and reading a withdrawn
 * quotation's origin as current would be citing a claim the company has
 * retracted. Expiry is deliberately NOT a filter: an expired quotation is a
 * Store decision to revise, and its origin statement is still the last thing
 * anybody said — reported with `expired: true` so a reader can weigh it.
 *
 * Where a company holds several active quotations for one item, the most
 * recently effective is read. Choosing WHICH to buy from is a commercial
 * decision the costing makes elsewhere; this is asking what any of them says
 * about origin, and the newest statement is the current one.
 */
async function activeOffersForItems(companyId, itemIds = []) {
  const ids = itemIds.filter(isId);
  if (!ids.length) return new Map();
  const rows = await SupplierOffer()
    .find({ companyId, itemId: { $in: ids }, status: "ACTIVE" })
    .select("_id itemId sourcing quotationReference quotationDate effectiveFrom validUntil")
    .sort({ effectiveFrom: -1, createdAt: -1 })
    .lean()
    .catch(() => []);
  const byItem = new Map();
  for (const r of rows) {
    const key = str(r.itemId);
    if (!byItem.has(key)) byItem.set(key, r);
  }
  return byItem;
}

/**
 * SOURCING EVIDENCE FOR A SET OF ITEMS — the projection Central Costing reads.
 *
 * Company-scoped on both reads. An item id from a Sales record can name any
 * item in the deployment, so an unscoped read here would be a lookup oracle
 * dressed as a customs check.
 *
 * @returns {{items: object[], complete: boolean, blocking: object[]}}
 */
async function evidenceForItems(ctx, { itemIds = [] } = {}) {
  if (!ctx?.companyId) {
    throw new Error("A company is required to read sourcing evidence.");
  }
  const ids = [...new Set((itemIds || []).map(str).filter(isId))];
  if (!ids.length) return { items: [], complete: true, blocking: [] };

  const [items, offers] = await Promise.all([
    RawItem().find({ companyId: ctx.companyId, _id: { $in: ids } })
      .select("_id name sku customsTariffCode").lean().catch(() => []),
    activeOffersForItems(ctx.companyId, ids),
  ]);

  const rows = items.map((item) => assess(offers.get(str(item._id)) || null, item));
  const blocking = rows.filter((r) => r.blocking);

  return {
    items: rows,
    /* Every item answered, one way or another. A `DOMESTIC` decision counts
       as answered; an unclassified item never does. */
    complete: blocking.length === 0,
    blocking: blocking.map((r) => ({
      itemId: r.itemId, itemName: r.itemName, state: r.state, missing: r.missing,
    })),
  };
}

/**
 * The whole set, rolled into one readiness state.
 *
 * Ordered by what actually blocks: nothing to record against outranks nothing
 * recorded, which outranks half recorded. `NOT_APPLICABLE` is only reached
 * when EVERY item was decided domestic — one imported item with a complete
 * classification makes the set `READY`, and the duty table is then the only
 * thing left, which is not Store's to supply.
 */
function rollUp(rows = []) {
  if (!rows.length) return { state: EVIDENCE.MISSING, blocking: true, missing: [] };
  const missing = rows.flatMap((r) => r.missing.map((m) => ({ ...m, itemName: r.itemName })));
  for (const state of [EVIDENCE.NO_QUOTATION, EVIDENCE.MISSING, EVIDENCE.IN_PROGRESS]) {
    if (rows.some((r) => r.state === state)) return { state, blocking: true, missing };
  }
  if (rows.every((r) => r.state === EVIDENCE.NOT_APPLICABLE)) {
    return { state: EVIDENCE.NOT_APPLICABLE, blocking: false, missing: [] };
  }
  return { state: EVIDENCE.READY, blocking: false, missing: [] };
}

module.exports = {
  SOURCING_TYPES, EVIDENCE, EVIDENCE_LABEL, BLOCKING,
  assess, rollUp, activeOffersForItems, evidenceForItems,
};
