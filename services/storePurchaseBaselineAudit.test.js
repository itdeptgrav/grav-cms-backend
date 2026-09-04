"use strict";
/**
 * services/storePurchaseBaselineAudit.test.js
 *
 * The reconciliation arithmetic behind the Chunk 0 baseline audit. These are
 * CHARACTERISATION checks over fixtures shaped like the real documents; they
 * pin what the report says, not what the data ought to be.
 *
 * Two rules from the chunk brief matter enough to test directly:
 *
 *   1. "No linked record" is NOT corruption when the legacy model never
 *      stored a link — a null ref is "unlinked", only a dangling non-null
 *      ref is an orphan.
 *
 *   2. An item whose balance disagrees with its embedded history is
 *      DRIFTED, not "corrupt" — the direct-edit PUT path writes no
 *      transaction, so the data cannot say which side is wrong.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeBaselineReport,
  renderSummary,
  reconcileRawItem,
  reconcileOperationalPO,
  reconcileMrf,
  mrfStockMovementIndex,
  duplicateCandidates,
  summariseDuplicates,
  DUPLICATE_KIND,
  exactDuplicates,
  findOrphans,
  findVariantOrphans,
  buildVariantIndex,
  classifyTransactionPath,
  scopePresence,
} = require("./storePurchaseBaselineAudit.service");

const NOW = "2026-09-01T00:00:00.000Z";
const id = (n) => `00000000000000000000${String(n).padStart(4, "0")}`;

// ── Raw item balance vs embedded movements ──────────────────────────────────

test("an item whose latest snapshot matches its balance is RECONCILED", () => {
  const r = reconcileRawItem({
    _id: id(1), sku: "BLT-1", name: "Belt", quantity: 70,
    stockTransactions: [
      { type: "ADD", quantity: 100, newQuantity: 100, createdAt: "2026-01-01" },
      { type: "REDUCE", quantity: 30, newQuantity: 70, createdAt: "2026-02-01" },
    ],
  });
  assert.equal(r.status, "RECONCILED");
  assert.equal(r.signedSum, 70);
  assert.equal(r.matchesSignedSum, true);
});

test("a directly-edited balance is DRIFTED, and the signed sum shows the recorded history", () => {
  // History says 100−30=70, but somebody PUT quantity=55 with no transaction.
  const r = reconcileRawItem({
    _id: id(2), sku: "FAB-2", name: "Fabric", quantity: 55,
    stockTransactions: [
      { type: "ADD", quantity: 100, newQuantity: 100, createdAt: "2026-01-01" },
      { type: "REDUCE", quantity: 30, newQuantity: 70, createdAt: "2026-02-01" },
    ],
  });
  assert.equal(r.status, "DRIFTED");
  assert.equal(r.signedSum, 70);
  assert.equal(r.latestNewQuantity, 70);
});

test("array order is not trusted — the newest transaction wins by createdAt", () => {
  // PO receive unshifts (newest first); MRF pushes (newest last). Mixed here.
  const r = reconcileRawItem({
    _id: id(3), sku: "ZIP-3", name: "Zip", quantity: 12,
    stockTransactions: [
      { type: "ADD", quantity: 2, newQuantity: 12, createdAt: "2026-03-01" }, // newest, first
      { type: "ADD", quantity: 10, newQuantity: 10, createdAt: "2026-01-01" },
    ],
  });
  assert.equal(r.status, "RECONCILED");
});

test("no transactions means NO_HISTORY — unverifiable, not drifted", () => {
  const r = reconcileRawItem({ _id: id(4), sku: "NEW-4", name: "New", quantity: 40, stockTransactions: [] });
  assert.equal(r.status, "NO_HISTORY");
  assert.equal(r.latestNewQuantity, null);
});

test("a variant total that disagrees with the item balance is flagged", () => {
  const r = reconcileRawItem({
    _id: id(5), sku: "BTN-5", name: "Button", quantity: 100,
    variants: [{ quantity: 40 }, { quantity: 40 }],
    stockTransactions: [],
  });
  assert.equal(r.variantSumMatches, false);
  assert.equal(r.variantQuantitySum, 80);
});

test("an unknown legacy transaction type is reported, not summed blindly", () => {
  const r = reconcileRawItem({
    _id: id(6), sku: "LEG-6", name: "Legacy", quantity: 5,
    stockTransactions: [{ type: "MYSTERY", quantity: 5, newQuantity: 5, createdAt: "2026-01-01" }],
  });
  assert.deepEqual(r.unknownTransactionTypes, ["MYSTERY"]);
  assert.equal(r.signedSum, 0);
});

// ── Operational PO receipts ─────────────────────────────────────────────────

test("a cleanly received PO reconciles on all three counts", () => {
  const r = reconcileOperationalPO({
    _id: id(10), poNumber: "PO26010001", status: "PARTIALLY_RECEIVED",
    totalReceived: 30, totalPending: 70,
    items: [{ quantity: 100, receivedQuantity: 30, pendingQuantity: 70 }],
    deliveries: [{ quantityReceived: 30 }],
  });
  assert.equal(r.reconciled, true);
});

test("header/lines disagreement — the shape an interrupted receive leaves — is caught", () => {
  // The /receive handler saves each RawItem, then the PO. A crash in between
  // leaves stock moved and the PO not knowing it. Simulated: lines updated,
  // header totals not.
  const r = reconcileOperationalPO({
    _id: id(11), poNumber: "PO26010002", status: "ISSUED",
    totalReceived: 0, totalPending: 100,
    items: [{ quantity: 100, receivedQuantity: 40, pendingQuantity: 60 }],
    deliveries: [],
  });
  assert.equal(r.headerMatchesLines, false);
  assert.equal(r.statusConsistent, false); // ISSUED but lines show receipts
  assert.equal(r.reconciled, false);
});

test("COMPLETED with pending quantity is status-inconsistent", () => {
  const r = reconcileOperationalPO({
    _id: id(12), poNumber: "PO26010003", status: "COMPLETED",
    totalReceived: 50, totalPending: 50,
    items: [{ quantity: 100, receivedQuantity: 50, pendingQuantity: 50 }],
    deliveries: [{ quantityReceived: 50 }],
  });
  assert.equal(r.statusConsistent, false);
});

// ── MRF ─────────────────────────────────────────────────────────────────────

test("an MRF line reconciles against its own issue/return history", () => {
  const r = reconcileMrf({
    _id: id(20), mrfNumber: "MRF-2601-0001", status: "PARTIALLY_RETURNED",
    items: [{
      _id: id(21), rawItemName: "Blade", unit: "pcs", baseUnit: "pcs",
      requestedQty: 10, issuedQty: 8, returnedQty: 3,
      issueHistory: [{ issuedQty: 5 }, { issuedQty: 3 }],
      returnHistory: [{ returnedQty: 3 }],
    }],
  });
  assert.equal(r.reconciled, true);
  assert.equal(r.hasLegacyHistoryGaps, false);
});

test("a legacy MRF with issuedQty but no history rows is a gap, not a mismatch", () => {
  const r = reconcileMrf({
    _id: id(22), mrfNumber: "MRF-2501-0001", status: "ISSUED",
    items: [{ _id: id(23), rawItemName: "Old", unit: "pcs", baseUnit: "pcs",
      requestedQty: 5, issuedQty: 5, returnedQty: 0, issueHistory: [], returnHistory: [] }],
  });
  assert.equal(r.reconciled, true);
  assert.equal(r.hasLegacyHistoryGaps, true);
});

test("returned exceeding issued is always a finding", () => {
  const r = reconcileMrf({
    _id: id(24), mrfNumber: "MRF-2601-0002", status: "COMPLETED",
    items: [{ _id: id(25), rawItemName: "X", unit: "pcs", baseUnit: "pcs",
      requestedQty: 5, issuedQty: 2, returnedQty: 4,
      issueHistory: [{ issuedQty: 2 }], returnHistory: [{ returnedQty: 4 }] }],
  });
  assert.equal(r.lines[0].returnExceedsIssue, true);
  assert.equal(r.reconciled, false);
});

test("MRF stock movements are found by their reason tags in embedded histories", () => {
  const idx = mrfStockMovementIndex([
    { stockTransactions: [
      { reason: "MRF Issue — MRF-2601-0001", quantity: 8 },
      { reason: "MRF Return — MRF-2601-0001", quantity: 3 },
      { reason: "Purchase Order Delivery", quantity: 100 },
    ]},
  ]);
  assert.deepEqual(idx.get("MRF-2601-0001"), { issued: 8, returned: 3 });
  assert.equal(idx.size, 1);
});

test("a line issued in a non-base unit is marked not comparable rather than judged", () => {
  const report = computeBaselineReport({
    now: NOW,
    mrfs: [{
      _id: id(26), mrfNumber: "MRF-2601-0003", status: "ISSUED",
      items: [{ _id: id(27), rawItemName: "Thread", unit: "box", baseUnit: "pcs",
        requestedQty: 2, issuedQty: 2, returnedQty: 0, issueHistory: [{ issuedQty: 2 }], returnHistory: [] }],
    }],
    rawItems: [{ _id: id(28), sku: "T", name: "Thread", quantity: 0,
      stockTransactions: [{ type: "REDUCE", quantity: 24, newQuantity: 0, reason: "MRF Issue — MRF-2601-0003", createdAt: "2026-01-01" }] }],
  });
  assert.equal(report.mrfReconciliation.stockCrossCheck.unitNotComparable, 1);
  assert.equal(report.mrfReconciliation.stockCrossCheck.mismatches.total, 0);
});

// ── Orphans: the null-link rule ─────────────────────────────────────────────

test("null refs are unlinked legacy state; only dangling non-null refs are orphans", () => {
  const r = findOrphans({
    refName: "po.spendRequestId → SpendRequest",
    docs: [
      { _id: id(30), spendRequestId: null },      // legacy, never linked
      { _id: id(31) },                            // legacy, field absent
      { _id: id(32), spendRequestId: id(90) },   // linked, target exists
      { _id: id(33), spendRequestId: id(91) },   // dangling
    ],
    targets: new Set([id(90)]),
    pick: (po) => [{ id: po.spendRequestId, where: "spendRequestId" }],
  });
  assert.equal(r.unlinked, 2);
  assert.equal(r.linked, 1);
  assert.equal(r.orphanCount, 1);
  assert.equal(r.orphans[0].missing, id(91));
});

// ── Duplicates ──────────────────────────────────────────────────────────────

test("duplicate candidates collide on trim/case/whitespace, never on distinct names", () => {
  const d = duplicateCandidates(["Meters", "meters", " METERS ", "Pieces", "Kg"]);
  assert.equal(d.length, 1);
  assert.equal(d[0].normalized, "meters");
  assert.deepEqual(d[0].variants, ["meters", "Meters", "METERS"]);
  assert.equal(d[0].kind, DUPLICATE_KIND.SPELLING_VARIANTS);
  assert.equal(d[0].distinctSpellings, 3);
  assert.equal(d[0].occurrences, 3);
});

test("IDENTICAL repeated values are duplicates too — one spelling, several documents", () => {
  // The bug this pins: filtering on the number of distinct SPELLINGS dropped
  // every exact repeat, so two items both spelled "Meters" — the commonest
  // duplicate there is — reported clean.
  const d = duplicateCandidates(["Meters", "Meters", "Pieces"]);
  assert.equal(d.length, 1);
  assert.equal(d[0].normalized, "meters");
  assert.equal(d[0].occurrences, 2);
  assert.equal(d[0].distinctSpellings, 1);
  assert.equal(d[0].kind, DUPLICATE_KIND.REPEATED_VALUE);
  assert.deepEqual(d[0].variants, ["Meters"]);
});

test("occurrences count documents and distinctSpellings count renderings — they are not the same number", () => {
  // Four documents, two spellings: both counts must be reported, because
  // "how many records to merge" and "how many names to reconcile" are
  // different clean-up jobs.
  const d = duplicateCandidates(["Kg", "kg", "Kg", "kg"]);
  assert.equal(d.length, 1);
  assert.equal(d[0].occurrences, 4);
  assert.equal(d[0].distinctSpellings, 2);
  assert.equal(d[0].kind, DUPLICATE_KIND.SPELLING_VARIANTS);
});

test("a value used exactly once is never a duplicate candidate", () => {
  assert.deepEqual(duplicateCandidates(["Meters", "Pieces", "Kg", "", null, "   "]), []);
});

test("the duplicate summary separates exact repeats from spelling variants", () => {
  const g = summariseDuplicates(duplicateCandidates(["Kg", "Kg", "Meters", "meters", "Pieces"]));
  assert.equal(g.groups, 2);
  assert.equal(g.repeatedValueGroups, 1);   // Kg × 2
  assert.equal(g.spellingVariantGroups, 1); // Meters / meters
  assert.equal(g.totalOccurrences, 4);
});

test("a raw item repeated SKU shows up in the report (regression: exact repeats were invisible)", () => {
  const item = (id, sku) => ({ _id: id, sku, name: sku, quantity: 0, stockTransactions: [] });
  const report = computeBaselineReport({
    now: NOW,
    rawItems: [item(id(80), "DUP-1"), item(id(81), "DUP-1"), item(id(82), "UNIQ-1")],
  });
  assert.equal(report.duplicates.rawItemSkus.groups, 1);
  assert.equal(report.duplicates.rawItemSkus.repeatedValueGroups, 1);
  assert.equal(report.duplicates.rawItemSkus.totalOccurrences, 2);
});

test("variant SKUs colliding on the default '-var' suffix are reported", () => {
  const report = computeBaselineReport({
    now: NOW,
    rawItems: [{
      _id: id(83), sku: "CNV-1", name: "Canvas", quantity: 0, stockTransactions: [],
      variants: [{ _id: id(84), sku: "CNV-1-var" }, { _id: id(85), sku: "CNV-1-var" }],
    }],
  });
  assert.equal(report.duplicates.variantSkus.groups, 1);
  assert.equal(report.duplicates.variantSkus.candidates[0].occurrences, 2);
});

test("exact duplicates catch a repeated PO number", () => {
  const d = exactDuplicates(
    [{ poNumber: "PO26010009" }, { poNumber: "PO26010009" }, { poNumber: "PO26010010" }],
    (po) => po.poNumber,
  );
  assert.deepEqual(d, [{ value: "PO26010009", count: 2 }]);
});

// ── The whole report ────────────────────────────────────────────────────────

test("the report is deterministic: identical inputs, identical JSON", () => {
  const fixture = () => ({
    now: NOW,
    rawItems: [
      { _id: id(40), sku: "A-1", name: "A", quantity: 10, createdAt: "2026-08-20",
        stockTransactions: [{ type: "ADD", quantity: 10, newQuantity: 10, createdAt: "2026-08-20" }] },
      { _id: id(41), sku: "B-1", name: "B", quantity: 3, createdAt: "2025-01-01", stockTransactions: [] },
    ],
    operationalPOs: [{ _id: id(42), poNumber: "PO26080001", status: "DRAFT", createdAt: "2026-08-25",
      totalReceived: 0, totalPending: 5, items: [{ quantity: 5, receivedQuantity: 0, pendingQuantity: 5 }], deliveries: [] }],
    storePOs: [{ _id: id(43), poNumber: "PO-0001", status: "Draft", createdAt: "2026-05-01" }],
    vendors: [{ _id: id(44), companyName: "Acme Textiles" }],
  });
  const a = JSON.stringify(computeBaselineReport(fixture()));
  const b = JSON.stringify(computeBaselineReport(fixture()));
  assert.equal(a, b);
});

test("an IntakeRequest and a Requisition sharing one REQ number is surfaced", () => {
  const report = computeBaselineReport({
    now: NOW,
    intakeRequests: [{ _id: id(70), requestNumber: "REQ-2608-0001", status: "classified" }],
    requisitions: [
      { _id: id(71), requisitionNumber: "REQ-2608-0001", status: "SUBMITTED" },
      { _id: id(72), requisitionNumber: "REQ-2608-0002", status: "SUBMITTED" },
    ],
  });
  assert.deepEqual(report.purchaseOrders.reqNumberCollisions, ["REQ-2608-0001"]);
});

test("recency buckets come from the injected clock, not the wall clock", () => {
  const report = computeBaselineReport({
    now: NOW,
    operationalPOs: [
      { _id: id(50), poNumber: "P1", status: "DRAFT", createdAt: "2026-08-25", items: [], deliveries: [] }, // 7d before NOW
      { _id: id(51), poNumber: "P2", status: "DRAFT", createdAt: "2026-01-01", items: [], deliveries: [] },
    ],
  });
  assert.equal(report.purchaseOrders.operational.createdLast30Days, 1);
  assert.equal(report.purchaseOrders.operational.createdLast90Days, 1);
  assert.equal(report.purchaseOrders.operational.count, 2);
});

// ── Company / site scope ────────────────────────────────────────────────────

test("scope reporting distinguishes 'the schema has no such field' from 'no document filled it in'", () => {
  const docs = [{ _id: id(60) }, { _id: id(61), companyId: id(62) }];
  const declared = scopePresence("spendrequests", docs, { declaresCompanyId: true });
  assert.deepEqual(declared, {
    collection: "spendrequests", documents: 2,
    declaresCompanyId: true, declaresSiteId: false,
    withCompanyId: 1, withSiteId: 0,
  });
  const undeclared = scopePresence("rawitems", [{ _id: id(63) }]);
  assert.equal(undeclared.declaresCompanyId, false);
  assert.equal(undeclared.withCompanyId, 0);
});

test("companyId and siteId are counted separately, never as one 'scoped' number", () => {
  const r = scopePresence("x", [
    { _id: id(64), companyId: id(65) },
    { _id: id(66), siteId: id(67) },
    { _id: id(68), companyId: id(65), siteId: id(67) },
  ]);
  assert.equal(r.withCompanyId, 2);
  assert.equal(r.withSiteId, 2);
});

test("every gathered collection is scope-reported, including the three request doors", () => {
  const report = computeBaselineReport({
    now: NOW,
    rawItems: [{ _id: id(69), sku: "S", name: "S", quantity: 0, stockTransactions: [] }],
    spendRequests: [{ _id: id(70), status: "approved", companyId: id(71) }],
    intakeRequests: [{ _id: id(72), status: "closed" }],
    rawItemAddRequests: [{ _id: id(73), approvalStatus: "TL_APPROVED" }],
  });
  const named = report.companyScoping.map((c) => c.collection);
  for (const expected of ["intakerequests", "spendrequests", "rawitemaddrequests", "barcodes"]) {
    assert.ok(named.includes(expected), `${expected} must be scope-reported`);
  }
  // SpendRequest is the ONE company-scoped model in this domain — the first
  // version of this report claimed nothing here carried companyId at all.
  const spend = report.companyScoping.find((c) => c.collection === "spendrequests");
  assert.equal(spend.declaresCompanyId, true);
  assert.equal(spend.withCompanyId, 1);
  const intake = report.companyScoping.find((c) => c.collection === "intakerequests");
  assert.equal(intake.declaresCompanyId, false);
  assert.equal(report.scopeSummary.collectionsDeclaringCompanyId, 1);
  assert.equal(report.scopeSummary.collectionsDeclaringSiteId, 0);
  assert.equal(report.scopeSummary.documentsWithSiteId, 0);
});

// ── Variant references ──────────────────────────────────────────────────────

test("a variant id absent from its parent item is an orphan; a missing parent is unverifiable instead", () => {
  const variantIndex = buildVariantIndex([
    { _id: id(74), variants: [{ _id: id(75) }] },
  ]);
  const r = findVariantOrphans({
    refName: "po.items[].variantId",
    variantIndex,
    docs: [
      { _id: id(76), items: [{ rawItem: id(74), variantId: id(75) }] },  // linked
      { _id: id(77), items: [{ rawItem: id(74), variantId: id(78) }] },  // orphan
      { _id: id(79), items: [{ rawItem: id(74), variantId: null }] },    // no variant named
      { _id: id(86), items: [{ rawItem: id(87), variantId: id(75) }] },  // parent gone
    ],
    pick: (d) => (d.items || []).map((i) => ({ rawItemId: i.rawItem, variantId: i.variantId, where: "items[].variantId" })),
  });
  assert.equal(r.linked, 1);
  assert.equal(r.orphanCount, 1);
  assert.equal(r.unlinked, 1);
  assert.equal(r.parentMissing, 1);
  assert.equal(r.orphans[0].missing, id(78));
});

test("variant references are checked across POs, MRFs, issuances, ledger, barcodes and the item's own history", () => {
  const report = computeBaselineReport({
    now: NOW,
    rawItems: [{
      _id: id(88), sku: "V-1", name: "V", quantity: 0,
      variants: [{ _id: id(89), sku: "V-1-a" }],
      // Its own movement points at a variant that no longer exists.
      stockTransactions: [{ type: "ADD", quantity: 1, newQuantity: 1, variantId: id(90), createdAt: "2026-01-01" }],
    }],
    operationalPOs: [{ _id: id(91), poNumber: "P", status: "DRAFT", items: [{ rawItem: id(88), variantId: id(90), quantity: 1 }], deliveries: [] }],
    mrfs: [{ _id: id(92), mrfNumber: "M", status: "ISSUED", items: [{ _id: id(93), rawItem: id(88), variantId: id(89), unit: "pcs", baseUnit: "pcs", requestedQty: 1 }] }],
    stockIssuances: [{ _id: id(94), direction: "debit", items: [{ rawItem: id(88), variantId: id(90) }] }],
    stockLedgers: [{ _id: id(95), txnType: "COMPENSATING", rawItem: id(88), variantId: id(89) }],
    barcodes: [{ _id: id(96), rawItem: id(88), variantId: id(90) }],
  });
  const named = report.variantOrphanReferences.map((r) => r.refName);
  assert.equal(named.length, 6);
  const byName = (needle) => report.variantOrphanReferences.find((r) => r.refName.includes(needle));
  assert.equal(byName("operationalPO.items[].variantId").orphanCount, 1);
  assert.equal(byName("mrf.items[].variantId").orphanCount, 0);
  assert.equal(byName("stockIssuance.items[].variantId").orphanCount, 1);
  assert.equal(byName("stockLedger.variantId").orphanCount, 0);
  assert.equal(byName("barcode.variantId").orphanCount, 1);
  assert.equal(byName("stockTransactions[].variantId").orphanCount, 1);
});

test("supplier references include alternates, variant aliases and movement suppliers", () => {
  const report = computeBaselineReport({
    now: NOW,
    vendors: [{ _id: id(97), companyName: "Real Vendor" }],
    rawItems: [{
      _id: id(98), sku: "S-1", name: "S", quantity: 0,
      primaryVendor: id(97),
      alternateVendors: [id(97), id(99)],                       // one dangling
      variants: [{ _id: id(100), vendorNicknames: [{ vendor: id(99) }] }], // dangling
      stockTransactions: [{ type: "ADD", quantity: 1, newQuantity: 1, supplierId: id(99), createdAt: "2026-01-01" }],
    }],
  });
  const find = (needle) => report.orphanReferences.find((r) => r.refName.includes(needle));
  assert.equal(find("alternateVendors").orphanCount, 1);
  assert.equal(find("alternateVendors").linked, 1);
  assert.equal(find("vendorNicknames[].vendor").orphanCount, 1);
  assert.equal(find("stockTransactions[].supplierId").orphanCount, 1);
  assert.equal(find("primaryVendor").orphanCount, 0);
});

test("warehouse/location orphan checking is reported as IMPOSSIBLE, not silently omitted", () => {
  const report = computeBaselineReport({ now: NOW, warehouses: [{ _id: id(101), name: "Main" }] });
  const wh = report.uncheckableReferences.find((u) => /warehouse/i.test(u.reference));
  assert.ok(wh, "warehouse must appear in uncheckableReferences");
  assert.match(wh.reason, /IMPOSSIBLE/);
  assert.equal(wh.warehousesConfigured, 1);
  // And it must NOT appear as a clean orphan check, which would read as "fine".
  assert.equal(report.orphanReferences.some((r) => /warehouse/i.test(r.refName)), false);
});

// ── Stock write-path attribution ────────────────────────────────────────────

test("movements are attributed to their write path by reason signature", () => {
  assert.equal(classifyTransactionPath({ reason: "Purchase Order Delivery" }), "S1_PO_RECEIPT");
  assert.equal(classifyTransactionPath({ reason: "Return request — damaged/faulty (PO: PO1)" }), "S2_VENDOR_RETURN_DEDUCT");
  assert.equal(classifyTransactionPath({ reason: "Return receipt from vendor (PO: PO1)" }), "S3_VENDOR_REPLACEMENT_RECEIPT");
  assert.equal(classifyTransactionPath({ reason: "MRF Issue — MRF-2601-0001" }), "S4_MRF_ISSUE");
  assert.equal(classifyTransactionPath({ reason: "MRF Return — MRF-2601-0001" }), "S5_MRF_RETURN");
  assert.equal(classifyTransactionPath({ reason: "Stock Addition from Purchase" }), "S8_VARIANT_ADD_STOCK_DEFAULT");
  assert.equal(classifyTransactionPath({ reason: "Stock Consumption" }), "S9_VARIANT_REDUCE_STOCK_DEFAULT");
  assert.equal(classifyTransactionPath({ reason: "Stock Debit" }), "S10_MANUFACTURING_ISSUANCE_DEFAULT");
});

test("a user-typed reason is UNCLASSIFIED rather than guessed at", () => {
  // Two paths let the operator type the reason, so this is expected data,
  // not a fault — and must not be silently folded into a known path.
  assert.equal(classifyTransactionPath({ reason: "took some for the sample room" }), "UNCLASSIFIED_WITH_REASON");
  assert.equal(classifyTransactionPath({}), "UNCLASSIFIED_NO_REASON");
});

test("a PO id outweighs the reason string when attributing a receipt", () => {
  assert.equal(classifyTransactionPath({ purchaseOrderId: id(102), reason: "" }), "S1_PO_RECEIPT");
  // …except for returns, whose rows also carry the PO id.
  assert.equal(
    classifyTransactionPath({ purchaseOrderId: id(102), reason: "Return request — damaged/faulty (PO: PO1)" }),
    "S2_VENDOR_RETURN_DEDUCT",
  );
});

test("direct edits, opening balances and hard deletes are declared UNMEASURABLE, never counted as zero", () => {
  const report = computeBaselineReport({
    now: NOW,
    rawItems: [
      // A balance that can only have arrived without a movement.
      { _id: id(103), sku: "OPEN-1", name: "Opening", quantity: 40, stockTransactions: [] },
      { _id: id(104), sku: "ZERO-1", name: "Zero", quantity: 0, stockTransactions: [] },
    ],
  });
  const paths = report.stockWritePaths.unmeasurablePaths.paths;
  const byPath = (p) => paths.find((x) => x.path === p);
  assert.equal(byPath("S7_DIRECT_QUANTITY_EDIT").measurable, false);
  assert.equal(byPath("S11_HARD_DELETE").measurable, false);
  const opening = byPath("S12_INITIAL_BALANCE");
  assert.equal(opening.measurable, false);
  // Only the item actually holding stock counts as evidence.
  assert.equal(opening.itemsWithBalanceAndNoHistory, 1);
  // The ledger-correction path IS measurable and says so.
  assert.equal(byPath("S6_LEDGER_CORRECTION_REWRITE").measurable, true);
});

test("the report breaks embedded movements down by write path", () => {
  const report = computeBaselineReport({
    now: NOW,
    rawItems: [{
      _id: id(105), sku: "W-1", name: "W", quantity: 0,
      stockTransactions: [
        { type: "ADD", quantity: 10, newQuantity: 10, reason: "Purchase Order Delivery", createdAt: "2026-01-01" },
        { type: "REDUCE", quantity: 4, newQuantity: 6, reason: "MRF Issue — MRF-1", createdAt: "2026-01-02" },
        { type: "REDUCE", quantity: 6, newQuantity: 0, reason: "spare parts for the line", createdAt: "2026-01-03" },
      ],
    }],
  });
  const byPath = report.stockWritePaths.embeddedStockTransactions.byWritePath;
  assert.equal(byPath.S1_PO_RECEIPT, 1);
  assert.equal(byPath.S4_MRF_ISSUE, 1);
  assert.equal(byPath.UNCLASSIFIED_WITH_REASON, 1);
});

test("the summary renders every section without throwing on an empty database", () => {
  const text = renderSummary(computeBaselineReport({ now: NOW }));
  assert.match(text, /READ-ONLY report/);
  assert.match(text, /Limitations/);
});
