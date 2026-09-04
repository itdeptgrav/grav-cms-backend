// test/store-purchase/baseline-audit.integration.test.js
//
// Store & Purchase professionalisation — Chunk 0, Deliverable 2.
//
// Proves the read-only audit RUNNER against a real (in-memory) MongoDB: the
// projections in scripts/store-purchase-baseline-audit.js must hand the pure
// service every field it reconciles on, and the whole pass must write
// NOTHING — to any collection in the plan, including the ones it finds
// empty. The arithmetic itself is unit-tested in
// services/storePurchaseBaselineAudit.test.js; this file tests the seam.
"use strict";

const mongoose = require("mongoose");

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const StorePurchaseOrder = require("../../models/CMS_Models/Store/PurchaseOrder");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const Requisition = require("../../models/CMS_Models/Inventory/Operations/Requisition");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const Barcode = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");

const { gather, GATHER_PLAN, OPTIONAL_GATHER_PLAN } = require("../../scripts/store-purchase-baseline-audit");
const { computeBaselineReport, renderSummary } = require("../../services/storePurchaseBaselineAudit.service");

const NOW = "2026-09-01T00:00:00.000Z";
const oid = () => new mongoose.Types.ObjectId();

/* Snapshot helper. EVERY collection the runner may read is captured —
 * required and optional alike — whether or not anything was seeded into it.
 * An audit that quietly created an empty collection, built an index, or
 * touched a document would show up here.
 *
 * Covering only GATHER_PLAN (as an earlier version did) left the optional
 * reads — the paused category-budget mapping, ledgers and the company
 * master — outside the read-only proof, which is exactly where a stray
 * write would have been least expected and least noticed. */
const PLAN_COLLECTIONS = [...GATHER_PLAN, ...OPTIONAL_GATHER_PLAN].map(([, collection]) => collection);
const OPTIONAL_COLLECTIONS = OPTIONAL_GATHER_PLAN.map(([, collection]) => collection);

async function snapshotAll(db) {
  const snap = {};
  const names = new Set((await db.listCollections().toArray()).map((c) => c.name));
  for (const c of PLAN_COLLECTIONS) {
    snap[c] = {
      exists: names.has(c),
      docs: names.has(c)
        ? JSON.stringify(await db.collection(c).find({}).sort({ _id: 1 }).toArray())
        : null,
      indexes: names.has(c)
        ? JSON.stringify((await db.collection(c).indexes()).map((i) => i.name).sort())
        : null,
    };
  }
  return snap;
}

async function seed() {
  const vendor = await Vendor.create({ companyName: "Acme Mills", contactPerson: "A", phone: "9", status: "Active" });
  const missingVendor = oid();

  // One reconciled item (with a variant), one drifted, one with no history.
  const reconciled = await RawItem.create({
    name: "Canvas", sku: "CNV-1", unit: "pcs", quantity: 70,
    variants: [{ combination: ["Blue"], sku: "CNV-1-blue", quantity: 70 }],
    primaryVendor: vendor._id,
    alternateVendors: [missingVendor], // dangling — a real orphan
    stockTransactions: [
      { type: "ADD", quantity: 100, previousQuantity: 0, newQuantity: 100, reason: "Purchase Order Delivery" },
      { type: "REDUCE", quantity: 30, previousQuantity: 100, newQuantity: 70, reason: "MRF Issue — MRF-2608-0001" },
    ],
  });
  await RawItem.create({
    name: "Fabric", sku: "FAB-1", unit: "m", quantity: 55,
    stockTransactions: [{ type: "ADD", quantity: 100, previousQuantity: 0, newQuantity: 100 }],
  });
  // Opening balance with no history at all — the S12 evidence count.
  await RawItem.create({ name: "New thing", sku: "NEW-1", unit: "pcs", quantity: 9 });

  const variantId = reconciled.variants[0]._id;

  await PurchaseOrder.create({
    poNumber: "PO26080001", status: "PARTIALLY_RECEIVED", createdBy: oid(),
    vendor: vendor._id, totalReceived: 30, totalPending: 70,
    items: [{ rawItem: reconciled._id, itemName: "Canvas", variantId, quantity: 100, unitPrice: 5, receivedQuantity: 30, pendingQuantity: 70 }],
    deliveries: [{ quantityReceived: 30 }],
  });
  await PurchaseOrder.create({
    poNumber: "PO26080002", status: "ISSUED", createdBy: oid(),
    spendRequestId: oid(), // dangling — no SpendRequest with this id exists
    totalReceived: 0, totalPending: 100,
    items: [{ rawItem: reconciled._id, itemName: "Canvas", variantId: oid(), quantity: 100, unitPrice: 5, receivedQuantity: 40, pendingQuantity: 60 }],
    deliveries: [],
  });

  await StorePurchaseOrder.create({ poNumber: "PO-0001", vendorName: "Loose Vendor", status: "Draft", items: [] });

  await MRF.create({
    mrfNumber: "MRF-2608-0001", requestType: "USES_BASED", status: "ISSUED",
    requestedFor: oid(), createdByRef: oid(), createdByModel: "Employee",
    items: [{
      rawItem: reconciled._id, rawItemName: "Canvas", requestedQty: 30, unit: "pcs", baseUnit: "pcs",
      issuedQty: 30, returnedQty: 0, itemStatus: "ISSUED",
      issueHistory: [{ issuedQty: 30 }],
    }],
  });

  await Requisition.create({
    requisitionNumber: "REQ-2608-0001", status: "SUBMITTED",
    items: [{ name: "Tape", quantity: 2, unit: "pcs" }],
  });

  // A barcode with a good raw-item link and a dangling variant reference.
  await Barcode.create({ rawItem: reconciled._id, variantId: oid(), quantity: 5, unit: "pcs" });

  // A finished good whose BOM references the raw item (a good line and a
  // dangling one), and whose NAME collides with it — an overlap candidate.
  await StockItem.create({
    name: "Canvas", reference: "FG-CANVAS-1", category: "Bags", unit: "Units",
    createdBy: oid(),
    variants: [{
      sku: "FG-CANVAS-1-A", cost: 10, salesPrice: 20, quantityOnHand: 0,
      rawItems: [
        { rawItemId: reconciled._id, rawItemName: "Canvas", variantId, quantity: 2, unit: "pcs", unitCost: 5, totalCost: 10 },
        { rawItemId: oid(), rawItemName: "Ghost material", quantity: 1, unit: "pcs", unitCost: 1, totalCost: 1 },
      ],
    }],
  });

  // The one company-scoped model in the domain.
  await SpendRequest.create({
    requestNumber: "SPR-2608-0001", status: "approved", companyId: oid(),
    title: "Cutting blades", requestType: "PRODUCT",
    requestedBy: oid(), requestedByName: "Asha", department: "Tech",
    purpose: "Replace the cutting blades that failed inspection",
    items: [{
      name: "Blade", whyNeeded: "The old ones failed inspection",
      quantity: 1, unit: "pcs", rate: 100, amount: 100,
    }],
  });

  return { reconciled, vendor };
}

test("gather + compute over a live database produces the reconciliations, and writes nothing", async () => {
  await seed();
  const db = mongoose.connection.db;

  /* Mongoose builds each model's declared indexes in the background the first
   * time a document is written. Those builds must FINISH before the "before"
   * snapshot, or an index landing mid-test reads as though the audit created
   * it — which is the opposite of what this test is for. `Model.init()`
   * resolves when a model's index builds are done. */
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));

  const before = await snapshotAll(db);
  // The plan deliberately covers collections this fixture never populates
  // (e.g. stockissuances, warehouses) — proving the audit does not create
  // them is part of proving it is read-only.
  const emptyBefore = PLAN_COLLECTIONS.filter((c) => !before[c].exists);
  expect(emptyBefore.length).toBeGreaterThan(0);
  // …and the optional reads are inside the proof, not outside it. In this
  // test they are all absent, so their non-existence is what is snapshotted.
  for (const c of OPTIONAL_COLLECTIONS) {
    expect(Object.prototype.hasOwnProperty.call(before, c)).toBe(true);
    expect(before[c].exists).toBe(false);
  }

  const data = await gather(db);
  const report = computeBaselineReport({ ...data, now: NOW });

  // ── Every plan key reaches the report ────────────────────────────────────
  for (const [key] of GATHER_PLAN) {
    expect(Array.isArray(data[key])).toBe(true);
  }
  /* Optional collections come back NULL when absent, not []. The difference
   * is the whole point: [] would mean "deployed and empty", which would let
   * paused, undeployed budget work read as 0% coverage. */
  for (const [key] of OPTIONAL_GATHER_PLAN) {
    expect(data[key]).toBeNull();
  }

  expect(report.collections.rawItems).toBe(3);
  expect(report.collections.operationalPurchaseOrders).toBe(2);
  expect(report.collections.worksheetPurchaseOrders).toBe(1);
  expect(report.collections.mrfs).toBe(1);
  expect(report.collections.barcodes).toBe(1);
  expect(report.collections.spendRequests).toBe(1);

  // ── Reconciliations ──────────────────────────────────────────────────────
  expect(report.rawItemReconciliation.reconciled).toBe(1);
  expect(report.rawItemReconciliation.drifted).toBe(1);
  expect(report.rawItemReconciliation.noHistory).toBe(1);
  expect(report.rawItemReconciliation.driftedItems.items[0].sku).toBe("FAB-1");

  expect(report.poReceiptReconciliation.reconciled).toBe(1);
  expect(report.poReceiptReconciliation.unreconciled.total).toBe(1);
  expect(report.poReceiptReconciliation.unreconciled.items[0].poNumber).toBe("PO26080002");

  expect(report.mrfReconciliation.internallyReconciled).toBe(1);
  expect(report.mrfReconciliation.stockCrossCheck.stockMatches).toBe(1);

  // ── Orphans: dangling refs found, null refs left alone ───────────────────
  const orphan = (needle) => report.orphanReferences.find((o) => o.refName.includes(needle));
  expect(orphan("spendRequestId → SpendRequest").orphanCount).toBe(1);
  expect(orphan("spendRequestId → SpendRequest").unlinked).toBe(1);
  expect(orphan("alternateVendors").orphanCount).toBe(1);
  expect(orphan("primaryVendor").orphanCount).toBe(0);
  expect(orphan("barcode.rawItem").orphanCount).toBe(0);

  // ── Variant references, checked against the parent item's variants ───────
  const variantRef = (needle) => report.variantOrphanReferences.find((o) => o.refName.includes(needle));
  expect(variantRef("operationalPO.items[].variantId").linked).toBe(1);
  expect(variantRef("operationalPO.items[].variantId").orphanCount).toBe(1);
  expect(variantRef("barcode.variantId").orphanCount).toBe(1);

  // ── The impossible checks are stated, not omitted ────────────────────────
  expect(report.uncheckableReferences.some((u) => /warehouse/i.test(u.reference))).toBe(true);

  // ── Write-path attribution and unmeasurable paths ────────────────────────
  const byPath = report.stockWritePaths.embeddedStockTransactions.byWritePath;
  expect(byPath.S1_PO_RECEIPT).toBe(1);
  expect(byPath.S4_MRF_ISSUE).toBe(1);
  const opening = report.stockWritePaths.unmeasurablePaths.paths.find((p) => p.path === "S12_INITIAL_BALANCE");
  expect(opening.measurable).toBe(false);
  expect(opening.itemsWithBalanceAndNoHistory).toBe(1); // NEW-1

  // ── Scope: SpendRequest is scoped, everything else is not ────────────────
  const scope = (name) => report.companyScoping.find((c) => c.collection === name);
  expect(scope("spendrequests").declaresCompanyId).toBe(true);
  expect(scope("spendrequests").withCompanyId).toBe(1);
  expect(scope("intakerequests").declaresCompanyId).toBe(false);
  expect(scope("rawitemaddrequests")).toBeTruthy();
  expect(report.scopeSummary.collectionsDeclaringSiteId).toBe(0);
  expect(report.scopeSummary.documentsWithSiteId).toBe(0);
  for (const c of report.companyScoping.filter((x) => x.collection !== "spendrequests")) {
    expect(c.withCompanyId).toBe(0);
  }

  // ── Item Master addendum ─────────────────────────────────────────────────
  const im = report.itemMaster;
  expect(report.collections.stockItems).toBe(1);
  expect(im.skuIdentity.totalItems).toBe(3);
  // Every item is untyped and unarchivable — schema gaps, not data gaps.
  expect(im.typeAndLifecycle.rawItems.withoutExplicitItemType).toBe(3);
  expect(im.typeAndLifecycle.lifecycle.archiveCapability).toBe("ABSENT");
  // NEW-1 holds 9 with no history.
  expect(im.balancesAndVariants.balanceWithNoMovementHistory.total).toBe(1);
  // The BOM's ghost line and the barcode's dangling variant.
  expect(im.bomAndBarcodes.bomReferencesToMissingItems.total).toBe(1);
  expect(im.bomAndBarcodes.barcodeReferencesToMissingVariants.total).toBe(1);
  // Supplier layers: the fixture's item carries a primary vendor and a
  // dangling alternate, and no variant alias.
  expect(im.supplierRelationships.layers.itemsWithPrimarySupplier).toBe(1);
  expect(im.supplierRelationships.layers.itemsWithAlternateSuppliers).toBe(1);
  expect(im.supplierRelationships.danglingReferences.alternateVendors.total).toBe(1);
  expect(im.supplierRelationships.danglingReferences.primaryVendor.total).toBe(0);
  // The two items with no supplier configured at ANY layer.
  expect(im.supplierRelationships.itemsWithNoConfiguredSupplierRelationship.total).toBe(2);

  // StockItem hygiene is measured, not deferred as finished-goods scope.
  expect(im.stockItemHygiene.totalStockItems).toBe(1);
  expect(im.stockItemHygiene.referenceIdentity.missingReference.total).toBe(0);
  expect(im.stockItemHygiene.compliance.missingHsnCode.total).toBe(1);
  expect(im.crossCollectionIdCollisions.collidingIds.total).toBe(0);

  // The paused, uncommitted mapping collection is absent from this database —
  // reported as a state, never as zero coverage.
  expect(im.budgetAttribution.mappingCollection.state).toBe("MAPPING_COLLECTION_ABSENT");
  expect(im.budgetAttribution.perCompanyCoverage).toEqual([]);
  expect(im.budgetAttribution.ledgerData.gathered).toBe(false);
  // The committed baseline has no item-wise attribution authority at all.
  expect(im.budgetAttribution.status.committedStoreBaseline).toMatch(/NO item-wise budget attribution authority/);
  expect(im.budgetAttribution.status.pausedUncommitted).toMatch(/none in HEAD/);

  // Barcode identity spans the whole future namespace, and keeps product
  // codes apart from printed lot instances.
  expect(im.barcodeIdentity.printedLotInstances.documents).toBe(1);
  expect(im.barcodeIdentity.printedLotInstances.comparable).toBe(false);
  expect(im.barcodeIdentity.productIdentifiers.duplicateItemVsItem.total).toBe(0);
  // "Canvas" exists in both catalogues — a candidate, never a confirmation.
  expect(im.catalogueOverlap.candidates.total).toBe(1);
  expect(im.catalogueOverlap.candidates.items[0].rules).toEqual(["NAME_EXACT_NORMALISED"]);
  expect(im.limitations.length).toBeGreaterThan(5);
  // The raw item is referenced from four different places.
  expect(Object.keys(im.references.referencedBySource).sort())
    .toEqual(["barcode", "mrf", "operationalPO", "stockItemBOM"]);

  expect(renderSummary(report)).toMatch(/Store & Purchase baseline audit/);
  expect(renderSummary(report)).toMatch(/Item master: identity/);

  // ── And nothing moved: same documents, same indexes, same absences ───────
  const after = await snapshotAll(db);
  expect(after).toEqual(before);
  for (const c of emptyBefore) {
    expect(after[c].exists).toBe(false);
  }
});

/* The absent case is covered above. This is the other half: the optional
 * collections EXIST, hold documents and carry indexes. Both conditions have
 * to be proved, because "we never created it" and "we never touched it" are
 * different guarantees and only one of them is exercised by an empty
 * database. */
test("optional collections present with documents and indexes are read and left untouched", async () => {
  await seed();
  const db = mongoose.connection.db;

  // Create the optional collections directly through the driver — no
  // mongoose model exists for the company master in this domain, and using
  // the driver keeps the fixture honest about what the runner will meet.
  const companyA = oid();
  const companyB = oid();
  const ledgerA = oid();
  await db.collection("acc_companies").insertMany([
    { _id: companyA, companyName: "Acme Mills Pvt Ltd", companyCode: "ACME" },
    { _id: companyB, companyName: "Borealis Textiles", companyCode: "BOR" },
  ]);
  await db.collection("acc_ledgers").insertMany([
    { _id: ledgerA, name: "Consumables", companyId: companyA },
  ]);
  await db.collection("acc_itemcategorybudgets").insertMany([
    { _id: oid(), companyId: companyA, category: "Fabric", categoryKey: "fabric", budgetLedgerId: ledgerA },
    // Reviewed by B and deliberately left without a head — the state that
    // must not be confused with "never reviewed".
    { _id: oid(), companyId: companyB, category: "Trims", categoryKey: "trims", budgetLedgerId: null },
  ]);
  // An item in that category, so the MAPPED_WITHOUT_HEAD state has something
  // to land on. The shared fixture's items carry no category at all.
  await RawItem.create({ name: "Elastic tape", sku: "ELA-1", unit: "m", quantity: 0, category: "Trims" });
  // A real index on an optional collection, so "no index was built" is
  // actually being asserted against something.
  await db.collection("acc_itemcategorybudgets").createIndex({ companyId: 1, categoryKey: 1 }, { unique: true });

  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
  const before = await snapshotAll(db);
  for (const c of OPTIONAL_COLLECTIONS) {
    expect(before[c].exists).toBe(true);
  }

  const data = await gather(db);
  const report = computeBaselineReport({ ...data, now: NOW });

  // The optional data actually reached the report.
  for (const [key] of OPTIONAL_GATHER_PLAN) {
    expect(Array.isArray(data[key])).toBe(true);
  }
  const ba = report.itemMaster.budgetAttribution;
  expect(ba.mappingCollection.state).toBe("PRESENT");
  expect(ba.mappingCollection.rows).toBe(2);
  expect(ba.ledgerData.gathered).toBe(true);

  // The company universe is complete and covers BOTH companies, including
  // the one whose only mapping names no head.
  expect(ba.companyUniverse.source).toBe("COMPANY_MASTER");
  expect(ba.companyUniverse.complete).toBe(true);
  expect(ba.companyUniverse.companiesInMaster).toBe(2);
  expect(ba.perCompanyCoverage.map((c) => c.companyId).sort())
    .toEqual([String(companyA), String(companyB)].sort());
  const forB = ba.perCompanyCoverage.find((c) => c.companyId === String(companyB));
  // B reviewed "Trims" and named no head — distinct from never having
  // looked, and distinct again from the mapping collection being absent.
  expect(forB.states.MAPPED_WITHOUT_HEAD).toBe(1);
  const forA = ba.perCompanyCoverage.find((c) => c.companyId === String(companyA));
  // A never reviewed "Trims".
  expect(forA.states.CATEGORY_NEVER_REVIEWED).toBe(1);
  // Mapping was gathered, so nothing is UNKNOWN for either company.
  for (const c of ba.perCompanyCoverage) {
    expect(c.states.MAPPING_COLLECTION_ABSENT).toBe(0);
  }

  // The human summary is real: no stale-shape "undefined" anywhere.
  const summary = renderSummary(report);
  expect(summary.split("\n").filter((l) => l.includes("undefined"))).toEqual([]);
  expect(summary).toMatch(/Company universe: COMPANY_MASTER/);

  // …and nothing moved: same documents, same indexes, same existence.
  const after = await snapshotAll(db);
  expect(after).toEqual(before);
});
