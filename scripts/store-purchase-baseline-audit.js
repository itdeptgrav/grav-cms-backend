#!/usr/bin/env node
// scripts/store-purchase-baseline-audit.js
//
// Store & Purchase professionalisation — Chunk 0, Deliverable 2.
//
// READ-ONLY usage and data baseline for the Store/Purchase domain.
//
// ── WHY THIS CANNOT WRITE ────────────────────────────────────────────────────
// It uses the native MongoDB driver directly — NOT mongoose models — so no
// schema is registered, no index build is triggered, and no middleware runs.
// The only driver call in this file is find(...) with explicit projections
// (see gather() below). There is no update/insert/delete anywhere, and the
// reconciliation arithmetic lives in a pure service
// (services/storePurchaseBaselineAudit.service.js) that receives plain
// objects and cannot reach the database at all.
//
// ── HOW TO RUN ───────────────────────────────────────────────────────────────
//   node -r dotenv/config scripts/store-purchase-baseline-audit.js
//   node -r dotenv/config scripts/store-purchase-baseline-audit.js --json out.json
//
// It reads MONGODB_URI from the environment (the same variable server.js
// uses; defaults to mongodb://localhost:27017/grav_clothing). Point it at
// whichever environment you are auditing. Because it is read-only it is safe
// against production, but run it there only with the owner's knowledge —
// large collections cost real read bandwidth.
//
// Output:
//   stdout        — human-readable summary
//   --json <path> — full machine-readable report (deterministic: stable key
//                   order, sorted lists, quantities rounded to 4dp). Two runs
//                   against unchanged data produce identical JSON except for
//                   `generatedAt`; pass --now <ISO> to pin that too.
//
// Document lists inside the report are capped at 50 entries per finding
// (counts are always complete) and carry ids/SKUs/numbers only — no payment
// details, no prices, no free-text notes.

"use strict";

const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const {
  computeBaselineReport,
  renderSummary,
} = require("../services/storePurchaseBaselineAudit.service");

// Projections keep the read narrow: only the fields the service reconciles.
// stockTransactions is the one heavy field genuinely needed (it IS the
// movement history being reconciled).
const GATHER_PLAN = [
  ["rawItems", "rawitems", {
    sku: 1, name: 1, quantity: 1, category: 1, customCategory: 1, unit: 1,
    customUnit: 1, primaryVendor: 1, alternateVendors: 1, companyId: 1, siteId: 1,
    minStock: 1, maxStock: 1, budgetLedgerId: 1, budgetLedgerName: 1,
    "variants._id": 1, "variants.sku": 1, "variants.quantity": 1,
    "variants.combination": 1, "variants.minStock": 1, "variants.maxStock": 1,
    "variants.unitConversion": 1, "variants.unitConversions": 1,
    "variants.vendorNicknames._id": 1, "variants.vendorNicknames.vendor": 1,
    "variants.vendorNicknames.nickname": 1, "variants.vendorNicknames.price": 1,
    "variants.vendorNicknames.deliveryDays": 1,
    "stockTransactions.type": 1, "stockTransactions.quantity": 1,
    "stockTransactions.newQuantity": 1, "stockTransactions.reason": 1,
    "stockTransactions.purchaseOrderId": 1, "stockTransactions.supplierId": 1,
    "stockTransactions.variantId": 1, "stockTransactions.performedBy": 1,
    "stockTransactions.createdAt": 1,
  }],
  ["operationalPOs", "purchaseorders", {
    poNumber: 1, status: 1, paymentStatus: 1, vendor: 1, spendRequestId: 1,
    isEmergencyOrder: 1, totalReceived: 1, totalPending: 1, createdAt: 1,
    companyId: 1, siteId: 1,
    "payments._id": 1,
    "items._id": 1, "items.rawItem": 1, "items.variantId": 1, "items.quantity": 1,
    "items.receivedQuantity": 1, "items.pendingQuantity": 1,
    "deliveries.quantityReceived": 1,
  }],
  ["storePOs", "storepurchaseorders", { poNumber: 1, status: 1, createdAt: 1, companyId: 1, siteId: 1 }],
  // NB: mongoose pluralises the "MRF" model name to "mrves" (f→ves), not
  // "mrfs" — verified via test/store-purchase/baseline-audit.integration.test.js.
  ["mrfs", "mrves", {
    mrfNumber: 1, status: 1, creationMode: 1, intakeRequestId: 1,
    spendRequestId: 1, createdAt: 1, companyId: 1, siteId: 1,
    "items._id": 1, "items.rawItem": 1, "items.variantId": 1, "items.rawItemName": 1, "items.unit": 1,
    "items.baseUnit": 1, "items.requestedQty": 1, "items.issuedQty": 1,
    "items.returnedQty": 1, "items.purchaseFormRaised": 1,
    "items.issueHistory.issuedQty": 1, "items.returnHistory.returnedQty": 1,
  }],
  ["requisitions", "requisitions", {
    requisitionNumber: 1, status: 1, purchaseOrder: 1, sourceMrfId: 1,
    createdAt: 1, companyId: 1, siteId: 1,
  }],
  ["stockIssuances", "stockissuances", {
    direction: 1, manufacturingOrder: 1, createdAt: 1, companyId: 1, siteId: 1,
    "items.rawItem": 1, "items.variantId": 1,
  }],
  ["stockLedgers", "stockledger", {
    txnType: 1, rawItem: 1, variantId: 1, mrfId: 1, purchaseOrderId: 1,
    vendorId: 1, isVoided: 1, isEdited: 1, createdAt: 1, companyId: 1, siteId: 1,
  }],
  ["intakeRequests", "intakerequests", {
    requestNumber: 1, status: 1, mrfId: 1, spendRequestId: 1, createdAt: 1,
    companyId: 1, siteId: 1,
  }],
  // The one model in this domain that declares companyId.
  ["spendRequests", "spendrequests", {
    requestNumber: 1, status: 1, purchaseOrderId: 1, sourceMrfId: 1,
    intakeRequestId: 1, createdAt: 1, companyId: 1, siteId: 1,
  }],
  ["rawItemAddRequests", "rawitemaddrequests", {
    approvalStatus: 1, status: 1, createdAt: 1, companyId: 1, siteId: 1,
  }],
  ["barcodes", "barcodes", {
    rawItem: 1, variantId: 1, purchaseOrder: 1, purchaseOrderItemId: 1,
    vendor: 1, quantity: 1, unit: 1, createdAt: 1, companyId: 1, siteId: 1,
  }],
  // Finished-goods catalogue — gathered for the Item Master addendum:
  // BOM integrity, product type, and RawItem overlap candidates.
  ["stockItems", "stockitems", {
    name: 1, additionalNames: 1, reference: 1, productType: 1, category: 1,
    unit: 1, trackInventory: 1, createdAt: 1, companyId: 1, siteId: 1,
    "variants.sku": 1, "variants.quantityOnHand": 1, "variants.barcode": 1,
    "variants.rawItems.rawItemId": 1, "variants.rawItems.rawItemName": 1,
    "variants.rawItems.variantId": 1, "variants.rawItems.quantity": 1,
    "variants.rawItems.unit": 1, "variants.rawItems.baseUnit": 1,
  }],
  ["vendors", "vendors", { companyName: 1, gstNumber: 1, status: 1, companyId: 1, siteId: 1 }],
  ["warehouses", "warehouses", { name: 1, shortName: 1, companyId: 1, siteId: 1 }],
  ["units", "units", { name: 1, status: 1, conversions: 1, companyId: 1, siteId: 1 }],
];

/**
 * OPTIONAL collections — gathered only if they exist.
 *
 * `acc_itemcategorybudgets` belongs to PAUSED, UNCOMMITTED budget-attribution
 * work; it is not established Store production behaviour and may not be
 * deployed at all. Its absence is a reported STATE
 * (MAPPING_COLLECTION_ABSENT), never zero coverage — see
 * services/storePurchaseItemMasterAudit.service.js. `acc_ledgers` is
 * gathered only so an item's budget-head override can be checked for a
 * missing target; without it that check reports itself unverifiable rather
 * than passing silently.
 */
const OPTIONAL_GATHER_PLAN = [
  ["itemCategoryBudgets", "acc_itemcategorybudgets", {
    companyId: 1, category: 1, categoryKey: 1, budgetLedgerId: 1,
    budgetLedgerName: 1, setAt: 1,
  }],
  ["ledgers", "acc_ledgers", { name: 1, companyId: 1 }],
  /* The COMMITTED company master. It establishes the company universe the
   * budget audit evaluates: without it, a real company that has configured
   * no budget mapping and owns no override-target ledger would not appear in
   * the report at all. Optional only because deployment varies — its absence
   * makes the universe INCOMPLETE, and the report says so rather than
   * claiming every company was evaluated. */
  ["companies", "acc_companies", { companyName: 1, companyCode: 1 }],
];

/**
 * Read every collection in the plan. Exposed for the integration test, which
 * hands in a db connected to mongodb-memory-server.
 */
async function gather(db) {
  const data = {};
  for (const [key, collection, projection] of GATHER_PLAN) {
    data[key] = await db
      .collection(collection)
      .find({}, { projection })
      .sort({ _id: 1 }) // deterministic order regardless of insertion history
      .toArray();
  }

  /* Optional collections stay NULL when absent. null and [] mean different
   * things downstream: null is "not deployed / not gathered", [] is
   * "deployed and empty", and conflating them would let an undeployed
   * feature read as 0% coverage. */
  const present = new Set((await db.listCollections().toArray()).map((c) => c.name));
  for (const [key, collection, projection] of OPTIONAL_GATHER_PLAN) {
    data[key] = present.has(collection)
      ? await db.collection(collection).find({}, { projection }).sort({ _id: 1 }).toArray()
      : null;
  }
  return data;
}

function parseArgs(argv) {
  const args = { json: null, now: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--json") args.json = argv[++i];
    else if (argv[i] === "--now") args.now = argv[++i];
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      console.error("Usage: node -r dotenv/config scripts/store-purchase-baseline-audit.js [--json out.json] [--now ISO-date]");
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  // server.js reads MONGODB_URI; the root reconcile scripts read MONGO_URI —
  // honour both, preferring the one the server itself uses.
  const uri =
    process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://localhost:27017/grav_clothing";

  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(); // db from the URI
    console.error(`Reading (read-only) from database "${db.databaseName}" …`);
    const data = await gather(db);
    const report = computeBaselineReport({ ...data, now: args.now || new Date() });

    console.log(renderSummary(report));

    if (args.json) {
      const out = path.resolve(args.json);
      fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
      console.error(`\nFull JSON report written to ${out}`);
    }
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Audit failed:", err);
    process.exit(1);
  });
}

module.exports = { gather, GATHER_PLAN, OPTIONAL_GATHER_PLAN };
