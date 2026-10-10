"use strict";
/**
 * test/support/storeCommandFixtures.js — a small, isolated Store to ask
 * questions of.
 *
 * ── WHY FIXTURES AND NOT THE DEV DATABASE ─────────────────────────────────
 * The ten questions the palette must answer are about real records: a
 * material, a shelf, a GRN number, a supplier. Asserting them against the
 * shared dev database would mean a test that passes until somebody renames
 * an item, and tells you nothing about why. So this writes exactly the
 * records each question is about, into the per-file in-memory replica set,
 * and `test/setup.js` clears them again between tests.
 *
 * Written through the raw collections rather than the models on purpose: a
 * goods receipt insisted on by its schema needs a purchase order, which
 * needs a supplier, a sequence and a chain of approvals, and seeding that
 * chain would be testing the chain. The readers under test all read with
 * `.find().lean()`, so what matters is the shape on disk.
 */

const mongoose = require("mongoose");

const oid = () => new mongoose.Types.ObjectId();
const d = (iso) => new Date(`${iso}T06:00:00.000Z`);

/**
 * Seed one company's Store and return the handles the assertions need.
 */
async function seedStore() {
  const db = mongoose.connection;
  const companyId = oid();

  /* ── A MATERIAL WITH AN EXACT NAME, AND ONE THAT ONLY STARTS THE SAME ──
     "macbook" names the first exactly and the second partially. A palette
     that answers the second for the first is guessing. */
  const macbook = oid();
  const macbookPro = oid();
  const sodium = oid();
  const sodaAsh = oid();
  const flexPipe = oid();
  await db.collection("rawitems").insertMany([
    {
      _id: macbook, companyId, name: "Macbook", sku: "MACBOOK",
      quantity: 4, unit: "Nos", classification: "ASSET", variants: [],
      deletedAt: null, createdAt: d("2026-01-05"), updatedAt: d("2026-01-05"),
    },
    {
      _id: macbookPro, companyId, name: "Macbook Pro 14", sku: "MACBOOK-PRO-14",
      quantity: 1, unit: "Nos", variants: [],
      deletedAt: null, createdAt: d("2026-01-06"), updatedAt: d("2026-01-06"),
    },
    {
      _id: sodium, companyId, name: "Sodium Hydroxide", sku: "SODIUM-HYD",
      quantity: 40, unit: "Kg", variants: [],
      deletedAt: null, createdAt: d("2026-01-07"), updatedAt: d("2026-01-07"),
    },
    {
      _id: sodaAsh, companyId, name: "Soda Ash", sku: "SODA-ASH",
      quantity: 25, unit: "Kg", variants: [],
      deletedAt: null, createdAt: d("2026-01-08"), updatedAt: d("2026-01-08"),
    },
    {
      _id: flexPipe, companyId, name: "16mm Flex Pipe", sku: "FLEX-16",
      /* Two metres against a minimum of ten: a shortfall of eight, which is
         a figure the record itself carries rather than one anybody derives
         from elsewhere. */
      quantity: 2, minStock: 10, unit: "Mtr", variants: [],
      deletedAt: null, createdAt: d("2026-01-09"), updatedAt: d("2026-01-09"),
    },
  ]);

  /* ── A WAREHOUSE WITH REAL SHELVES ────────────────────────────────────
     "where is sodium kept" is answered from a LocationBalance pointing at a
     location inside a warehouse, so both have to exist and agree. */
  const warehouseId = oid();
  const rack = oid();
  const level = oid();
  const binA = oid();
  const binB = oid();
  await db.collection("warehouses").insertOne({
    _id: warehouseId, companyId, name: "Main Store", shortName: "WH-MAIN",
    status: "ACTIVE", structureVersion: 1,
    floorPlan: { layoutVersion: 1, walls: [], fixtures: [] },
    locations: [
      { _id: rack, code: "R01", name: "Rack 1", kind: "RACK", type: "CONTAINER", status: "ACTIVE", parent: null, sequence: 1 },
      { _id: level, code: "R01-L01", name: "Level 1", kind: "LEVEL", type: "CONTAINER", status: "ACTIVE", parent: rack, sequence: 1 },
      { _id: binA, code: "R01-L01-B01", name: "Bin 1", kind: "BIN", type: "USABLE_STOCK", status: "ACTIVE", parent: level, sequence: 1 },
      { _id: binB, code: "R01-L01-B02", name: "Bin 2", kind: "BIN", type: "USABLE_STOCK", status: "ACTIVE", parent: level, sequence: 2 },
    ],
    createdAt: d("2026-01-01"), updatedAt: d("2026-01-01"),
  });
  await db.collection("location_balances").insertMany([
    { _id: oid(), companyId, itemId: sodium, variantId: null, warehouseId, locationId: binA, onHand: 40, createdAt: d("2026-02-01"), updatedAt: d("2026-02-01") },
    { _id: oid(), companyId, itemId: sodaAsh, variantId: null, warehouseId, locationId: binB, onHand: 25, createdAt: d("2026-02-01"), updatedAt: d("2026-02-01") },
    { _id: oid(), companyId, itemId: macbook, variantId: null, warehouseId, locationId: binA, onHand: 4, createdAt: d("2026-02-01"), updatedAt: d("2026-02-01") },
  ]);

  /* ── A SUPPLIER AND ITS ORDERS ────────────────────────────────────────── */
  const vendorId = oid();
  await db.collection("vendors").insertOne({
    _id: vendorId, companyId, companyName: "Gaurav Enterprises",
    supplierCode: "SUP-GAURAV", status: "ACTIVE", contactPerson: "G Rao",
    createdAt: d("2026-01-02"), updatedAt: d("2026-01-02"),
  });
  const poId = oid();
  await db.collection("purchaseorders").insertMany([
    {
      _id: poId, companyId, poNumber: "PO/2026-27/0101", vendorId,
      vendorName: "Gaurav Enterprises", status: "ISSUED", poStatus: "ISSUED",
      orderDate: d("2026-05-04"), grandTotal: 1200,
      items: [{ _id: oid(), rawItem: flexPipe, sku: "FLEX-16", unit: "Mtr", quantity: 50 }],
      createdAt: d("2026-05-04"), updatedAt: d("2026-05-04"),
    },
    {
      _id: oid(), companyId, poNumber: "PO/2026-27/0102", vendorName: "Other Supplies Co",
      status: "ISSUED", poStatus: "ISSUED", orderDate: d("2026-05-06"), grandTotal: 400,
      items: [], createdAt: d("2026-05-06"), updatedAt: d("2026-05-06"),
    },
  ]);

  /* ── RECEIPTS: ONE RECORDED, ONE STILL EXPECTED ────────────────────────
     The recorded one carries the GRN number a person types straight in. The
     expected one exists only as an outstanding order line, which is what
     "expected in June 2026" has to find. */
  const receiptId = oid();
  await db.collection("goodsreceipts").insertOne({
    _id: receiptId, companyId, receiptNumber: "GRN/2026-27/0004",
    sourceType: "PURCHASE_ORDER", purchaseOrderId: poId, poNumber: "PO/2026-27/0101",
    supplierName: "Gaurav Enterprises", receiptDate: d("2026-05-20"),
    status: "RECORDED", warehouseId,
    lines: [{ _id: oid(), rawItem: flexPipe, sku: "FLEX-16", unit: "Mtr", receivedQuantity: 48 }],
    createdAt: d("2026-05-20"), updatedAt: d("2026-05-20"),
  });
  const expectedPoId = oid();
  await db.collection("purchaseorders").insertOne({
    _id: expectedPoId, companyId, poNumber: "PO/2026-27/0103", vendorId,
    vendorName: "Gaurav Enterprises", status: "ISSUED", poStatus: "ISSUED",
    orderDate: d("2026-05-28"), expectedDeliveryDate: d("2026-06-15"),
    grandTotal: 900,
    items: [{
      _id: oid(), rawItem: flexPipe, sku: "FLEX-16", unit: "Mtr",
      quantity: 30, receivedQuantity: 0, expectedDeliveryDate: d("2026-06-15"),
    }],
    createdAt: d("2026-05-28"), updatedAt: d("2026-05-28"),
  });

  /* ── ONE RECEIPT INSPECTED, ONE NOT ───────────────────────────────────
     A GoodsReceiptInspection has NO status field: the record exists only
     once the decision has been made. So "pending" cannot mean an inspection
     row — it means a recorded receipt with no inspection against it, which
     is what the receiving register calls work needing action. The first
     draft of this fixture invented a `status: "PENDING"` inspection, and a
     question answered from a field the schema does not have is answered
     from nothing. */
  await db.collection("goodsreceiptinspections").insertOne({
    _id: oid(), companyId, goodsReceiptId: receiptId, receiptNumber: "GRN/2026-27/0004",
    warehouseName: "Main Store", receivingLocationCode: "R01-L01-B01",
    inspectedAt: d("2026-05-22"),
    inspectedBy: { id: null, name: "Store Keeper" },
    lines: [{
      _id: oid(), goodsReceiptLineId: oid(), sku: "FLEX-16", unit: "Mtr",
      receivedQuantity: 48, acceptedQuantity: 46, quarantinedQuantity: 0, rejectedQuantity: 2,
    }],
    createdAt: d("2026-05-22"), updatedAt: d("2026-05-22"),
  });
  const uninspectedReceiptId = oid();
  await db.collection("goodsreceipts").insertOne({
    _id: uninspectedReceiptId, companyId, receiptNumber: "GRN/2026-27/0005",
    sourceType: "PURCHASE_ORDER", purchaseOrderId: poId, poNumber: "PO/2026-27/0101",
    supplierName: "Gaurav Enterprises", receiptDate: d("2026-05-25"),
    status: "RECORDED", warehouseId,
    lines: [{ _id: oid(), rawItem: sodaAsh, sku: "SODA-ASH", unit: "Kg", receivedQuantity: 25 }],
    createdAt: d("2026-05-25"), updatedAt: d("2026-05-25"),
  });

  /* ── MATERIAL REQUESTS, FIVE OF THEM, DATED APART ──────────────────────
     "latest five" needs more than five to be a real answer. */
  const requests = [];
  for (let i = 1; i <= 7; i += 1) {
    requests.push({
      _id: oid(), companyId,
      mrfNumber: `MRF-2605-000${i}`,
      requestedForName: "Production Floor",
      requestedForDept: "sewing",
      purpose: "Line consumables",
      status: i % 2 ? "APPROVED" : "PENDING",
      items: [{ _id: oid(), rawItem: flexPipe, unit: "Mtr", requestedQty: i, issuedQty: 0 }],
      createdAt: d(`2026-05-${String(i + 9).padStart(2, "0")}`),
      updatedAt: d(`2026-05-${String(i + 9).padStart(2, "0")}`),
    });
  }
  await db.collection("mrves").insertMany(requests);

  /* ── A SHORTFALL ──────────────────────────────────────────────────────
     Two metres on hand against thirty on order and a reservation nobody
     can meet: the figure "shortfall for 16mm flex pipe" asks for. */
  await db.collection("stockreservations").insertOne({
    _id: oid(), companyId, itemId: flexPipe, rawItem: flexPipe,
    quantity: 20, unit: "Mtr", status: "ACTIVE",
    createdAt: d("2026-05-15"), updatedAt: d("2026-05-15"),
  });

  return {
    companyId,
    items: { macbook, macbookPro, sodium, sodaAsh, flexPipe },
    warehouseId,
    locations: { rack, level, binA, binB },
    vendorId,
    purchaseOrders: { issued: poId, expected: expectedPoId },
    receiptId,
    uninspectedReceiptId,
    receiptNumber: "GRN/2026-27/0004",
    requestCount: requests.length,
  };
}

/** A Store reader inside that company, with the real capability string. */
function storeReaderFor(companyId) {
  const { CAPABILITIES } = require("../../services/storePurchase/capabilities");
  return {
    id: String(oid()),
    _id: oid(),
    applicationAccess: { store: { allowed: true, capabilities: { read: true } } },
    storePurchaseAccess: {
      capabilities: [CAPABILITIES.READ],
      capabilitySet: new Set([CAPABILITIES.READ]),
      companyId,
      legacyMode: false,
    },
  };
}

module.exports = { seedStore, storeReaderFor, oid };
