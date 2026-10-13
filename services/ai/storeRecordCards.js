"use strict";
/**
 * services/ai/storeRecordCards.js — the few facts that matter about one record,
 * shown in Cmd/Ctrl K without opening its page.
 *
 * ── WHAT A CARD IS ────────────────────────────────────────────────────────
 * "PO/2026-27/0011" used to answer "Matching purchase orders: PO/2026-27/0011"
 * and an Open button — true, and no use to somebody who wanted to know who it
 * was ordered from and whether it has arrived. A card is that: a status and a
 * handful of labelled facts, chosen per family below, under the result.
 *
 * ── AND WHAT IT IS NOT ────────────────────────────────────────────────────
 * Not a second way to read data. The record is read by its canonical id
 * through `resolveEntity` — the same tenant scope and the same field
 * PROJECTION every Store answer uses, so a field the contract keeps out (a
 * bank detail, a credential) cannot appear here because it is never read.
 * Every fact below names a path the contract already exposes. Nothing is
 * worded by a model; values are formatted, not interpreted.
 */

const mongoose = require("mongoose");
const { resolveEntity, scopeFor } = require("../storePurchaseUniversalContext");
const { ENTITY_SPECS } = require("../storePurchaseUniversalContract");
const { STORE_RECORD_ROUTES } = require("./assistantLinks");

/* The card's shape, formatting, bounds and lead rule are SHARED — every
   application's cards look and behave the same, and change together. Store
   supplies only which facts, below. See services/ai/commandSearch/cards.js. */
const shared = require("./commandSearch/cards");

const { MAX_FACTS, MAX_CARDS } = shared;
const { text, date, number, money, words, count, withUnit } = shared.FORMAT;

const specOf = (entity) => ENTITY_SPECS.find((spec) => spec.id === entity);

/**
 * The facts each family's card shows. Only families with a page a person
 * opens — the five Store reaches for most — and only paths the universal
 * contract exposes (pinned by `storeRecordCards.test.js`).
 */
const CARDS = Object.freeze({
  purchase_order: {
    title: (r) => r.poNumber,
    status: (r) => words(r.status),
    facts: (r) => [
      ["Supplier", text(r.vendorName)],
      ["Ordered", date(r.orderDate)],
      ["Expected", date(r.expectedDeliveryDate)],
      ["Total", money(r.totalAmount)],
      ["Items", count(r.items)],
      ["Received", number(r.totalReceived) !== null || number(r.totalPending) !== null
        ? `${number(r.totalReceived) ?? 0} received · ${number(r.totalPending) ?? 0} pending` : null],
      ["Payment", words(r.paymentStatus)],
      ["From request", text(r.sourceMrfNumber)],
    ],
    paths: ["poNumber", "status", "vendorName", "orderDate", "expectedDeliveryDate", "totalAmount", "totalReceived", "totalPending", "paymentStatus", "sourceMrfNumber"],
  },
  goods_receipt: {
    title: (r) => r.receiptNumber,
    status: (r) => words(r.status),
    facts: (r) => [
      ["Source", words(r.sourceType)],
      ["Supplier", text(r.supplierName)],
      ["Purchase order", text(r.poNumber)],
      ["Source document", r.poNumber ? null : text(r.sourceDocumentNumber)],
      ["Received on", date(r.receiptDate)],
      ["Invoice", text(r.invoiceNumber)],
      ["Warehouse", text(r.warehouseName)],
      ["Lines", count(r.lines)],
    ],
    paths: ["receiptNumber", "status", "sourceType", "supplierName", "poNumber", "sourceDocumentNumber", "receiptDate", "invoiceNumber", "warehouseName"],
  },
  inventory_item_master: {
    title: (r) => r.name,
    status: (r) => words(r.status),
    facts: (r) => [
      ["SKU", text(r.sku)],
      ["Stock on hand", withUnit(r.quantity, r.unit || r.customUnit)],
      ["Category", text(r.category) || text(r.customCategory)],
      ["Type", words(r.productType)],
      ["Min stock", withUnit(r.minStock, r.unit || r.customUnit)],
      ["Max stock", withUnit(r.maxStock, r.unit || r.customUnit)],
    ],
    paths: ["name", "status", "sku", "quantity", "unit", "customUnit", "category", "customCategory", "productType", "minStock", "maxStock"],
  },
  supplier_master: {
    title: (r) => r.companyName,
    status: (r) => words(r.status),
    facts: (r, extra) => [
      ["Code", text(r.supplierCode)],
      ["Contact", text(r.contactPerson)],
      ["Phone", text(r.phone)],
      ["Email", text(r.email)],
      ["GST", text(r.gstNumber)],
      ["Open orders", extra.openOrders ?? null],
      ["Rating", number(r.rating)],
    ],
    paths: ["companyName", "status", "supplierCode", "contactPerson", "phone", "email", "gstNumber", "rating"],
    /* Issued and not yet fully received — counted under the same tenant
       scope as every other purchase-order read. */
    async extra({ user, recordId }) {
      const spec = specOf("purchase_order");
      const scope = scopeFor(spec, user);
      if (scope === null || !mongoose.Types.ObjectId.isValid(recordId)) return {};
      const open = await spec.model.countDocuments({
        $and: [scope, { vendorId: new mongoose.Types.ObjectId(recordId) }, { status: { $in: ["ISSUED", "PARTIALLY_RECEIVED"] } }],
      });
      return { openOrders: String(open) };
    },
  },
  material_request: {
    title: (r) => r.mrfNumber,
    status: (r) => words(r.status),
    facts: (r) => [
      ["Requested for", text(r.requestedForName)],
      ["Department", words(r.requestedForDept)],
      ["Raised by", text(r.createdByName)],
      ["Needed by", date(r.neededBy) || date(r.deadline)],
      ["Priority", words(r.priority)],
      ["Items", count(r.items)],
      ["Purpose", text(r.purpose)],
    ],
    paths: ["mrfNumber", "status", "requestedForName", "requestedForDept", "createdByName", "neededBy", "deadline", "priority", "purpose"],
  },
});

/** Which record a trusted Store link opens, read back from the link itself. */
const recordFromHref = shared.recordFromHrefFor(Object.fromEntries(
  Object.keys(CARDS).filter((entity) => STORE_RECORD_ROUTES[entity])
    .map((entity) => [entity, STORE_RECORD_ROUTES[entity]]),
));

/**
 * The card for one record, or null.
 *
 * Read by canonical id under the actor's own scope. A record the actor
 * cannot see resolves to nothing, and so has no card.
 */
async function cardFor({ user, entity, recordId }) {
  const card = CARDS[entity];
  if (!card || !/^[A-Za-z0-9_-]{1,100}$/.test(String(recordId || ""))) return null;
  const resolution = await resolveEntity({
    entity,
    user,
    recognizedSubject: { found: true, entity, recordId: String(recordId) },
  });
  if (!resolution?.found || !resolution.record) return null;
  const record = resolution.record;
  const extra = card.extra ? await card.extra({ user, recordId: String(recordId) }).catch(() => ({})) : {};
  return shared.buildCard(card, record, extra);
}

/** Cards for the results about one record — the shared rule, Store's facts. */
function withCards(user, results) {
  return shared.withCards(results, {
    cardFor: ({ entity, recordId }) => cardFor({ user, entity, recordId }),
    recordFromHref,
  });
}

module.exports = { CARDS, MAX_CARDS, MAX_FACTS, cardFor, withCards, recordFromHref };
