"use strict";
/**
 * services/storePurchaseItemMasterAudit.test.js
 *
 * The Item Master measurements behind the Chunk 0 addendum. Every finding
 * this report can produce is pinned here against a fixture shaped like the
 * real documents.
 *
 * The rule that matters most: NOTHING here may assert that two records are
 * the same thing. Overlap and duplicate findings are candidates produced by
 * exact, stated rules — a merge is destructive, so a false positive costs
 * more than a missed one. Several tests exist specifically to prove the
 * report does NOT claim more than it knows.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeItemMasterReport,
  renderItemMasterSummary,
  classifySku,
  auditSkus,
  auditNames,
  auditDualField,
  categoryIdentities,
  auditUnitConversions,
  auditBalancesAndVariants,
  auditTypeAndLifecycle,
  auditSupplierRelationships,
  auditStockItems,
  auditBarcodeIdentity,
  auditCrossCollectionIdCollisions,
  auditReferences,
  auditBomAndBarcodes,
  auditCatalogueOverlap,
  auditBudgetAttribution,
  auditReorderFields,
  CONTROLLED_RAW_ITEM_CATEGORIES,
} = require("./storePurchaseItemMasterAudit.service");

const id = (n) => `00000000000000000000${String(n).padStart(4, "0")}`;
const item = (n, over = {}) => ({
  _id: id(n), name: `Item ${n}`, sku: `SKU-${n}`, quantity: 0,
  variants: [], stockTransactions: [], ...over,
});

// ── SKUs ────────────────────────────────────────────────────────────────────

test("a missing SKU is reported, and never treated as a duplicate of another missing one", () => {
  const r = auditSkus([item(1, { sku: "" }), item(2, { sku: "   " }), item(3, { sku: "REAL-1" })]);
  assert.equal(r.missingSku.total, 2);
  assert.equal(r.exactDuplicateSkus.total, 0);
  assert.equal(r.normalisedDuplicateSkus.total, 0);
});

test("exact duplicate SKUs are separated from ones only a case/whitespace fold reveals", () => {
  const r = auditSkus([
    item(4, { sku: "RAW-FAB-1" }),
    item(5, { sku: "RAW-FAB-1" }),   // exact — the unique index would catch it
    item(6, { sku: "raw-fab-2" }),
    item(7, { sku: "RAW-FAB-2 " }),  // normalised only — the index would NOT
  ]);
  assert.equal(r.exactDuplicateSkus.total, 1);
  assert.equal(r.exactDuplicateSkus.items[0].sku, "RAW-FAB-1");
  assert.equal(r.normalisedDuplicateSkus.total, 1);
  assert.equal(r.normalisedDuplicateSkus.items[0].normalized, "raw-fab-2");
  assert.equal(r.normalisedDuplicateSkus.items[0].exactRepeat, false);
});

test("generated SKU shapes are recognised by the route that mints them", () => {
  assert.equal(classifySku("RAW-FAB-COTTWI-042"), "RANDOM_SUFFIX_RAW");
  assert.equal(classifySku("COTT-1756704000000"), "EPOCH_SUFFIX");
  assert.equal(classifySku("RAW-FAB-COT-001-VAR"), "DEFAULT_VARIANT_VAR");
  assert.equal(classifySku("CNV-1-var-1756704000000"), "DEFAULT_VARIANT_VAR");
  assert.equal(classifySku("FABRIC/COTTON/60S"), "HUMAN_OR_UNKNOWN");
  assert.equal(classifySku(""), "MISSING");
});

test("the SKU shape tally is reported with the rule that produced it, so it can be argued with", () => {
  const r = auditSkus([item(8, { sku: "RAW-FAB-COT-001" }), item(9, { sku: "MY-OWN-CODE" })]);
  assert.equal(r.generatedSkuPatterns.RANDOM_SUFFIX_RAW, 1);
  assert.equal(r.generatedSkuPatterns.HUMAN_OR_UNKNOWN, 1);
  assert.ok(r.patternDefinitions.every((p) => p.pattern && p.source));
});

// ── Names ───────────────────────────────────────────────────────────────────

test("missing and duplicate item names are counted separately", () => {
  const r = auditNames([
    item(10, { name: "" }),
    item(11, { name: "Cotton Twill" }),
    item(12, { name: "cotton  twill" }), // same identity, different spelling
    item(13, { name: "Cotton Twill" }),  // exact repeat
    item(14, { name: "Poplin" }),
  ]);
  assert.equal(r.missingName.total, 1);
  assert.equal(r.duplicateNameGroups.total, 1);
  assert.equal(r.duplicateNameDocuments, 3);
  assert.equal(r.duplicateNameGroups.items[0].distinctSpellings, 2);
});

// ── Category / unit dual fields ─────────────────────────────────────────────

test("category vs customCategory: conflict, shadow, custom-only and neither are all distinguished", () => {
  const r = auditDualField(
    [
      item(20, { category: "Fabric", customCategory: "Trims" }),  // CONFLICT
      item(21, { category: "Fabric", customCategory: "fabric " }), // SHADOWED
      item(22, { category: "", customCategory: "Speciality Yarn" }), // CUSTOM_ONLY
      item(23, { category: "Thread", customCategory: "" }),        // PRIMARY_ONLY
      item(24, { category: "", customCategory: "" }),              // NEITHER
    ],
    "category", "customCategory",
  );
  assert.equal(r.conflict.total, 1);
  assert.equal(r.conflict.items[0].id, id(20));
  assert.equal(r.shadowed, 1);
  assert.equal(r.customOnly, 1);
  assert.equal(r.primaryOnly, 1);
  assert.equal(r.neither.total, 1);
});

test("unit vs customUnit uses the same rule, on the same shape of problem", () => {
  const r = auditDualField(
    [item(25, { unit: "Meters", customUnit: "Rolls" }), item(26, { unit: "Meters", customUnit: "" })],
    "unit", "customUnit",
  );
  assert.equal(r.conflict.total, 1);
  assert.equal(r.primaryOnly, 1);
});

test("category identities outside the route's hard-coded list are surfaced", () => {
  const r = categoryIdentities(
    [item(27, { category: "Fabric" }), item(28, { customCategory: "Speciality Yarn" }), item(29, { customCategory: "speciality yarn" })],
    CONTROLLED_RAW_ITEM_CATEGORIES,
  );
  assert.equal(r.distinctIdentities, 2);
  assert.equal(r.outsideControlledList.total, 1);
  assert.equal(r.outsideControlledList.items[0].normalized, "speciality yarn");
  assert.deepEqual(r.outsideControlledList.items[0].spellings, ["speciality yarn", "Speciality Yarn"]);
});

// ── Conversions ─────────────────────────────────────────────────────────────

const unit = (n, name, conversions = []) => ({ _id: id(n), name, conversions });

test("a conversion naming a unit that does not exist is a missing target", () => {
  const r = auditUnitConversions({
    units: [unit(30, "Meter", [{ toUnit: id(999), quantity: 100 }])],
  });
  assert.equal(r.missingTarget.total, 1);
});

test("zero, negative and non-numeric factors are invalid — and are not silently treated as 1:1", () => {
  const r = auditUnitConversions({
    units: [
      unit(31, "Meter", [{ toUnit: id(32), quantity: 0 }, { toUnit: id(32), quantity: -5 }]),
      unit(32, "Centimeter", []),
    ],
  });
  assert.equal(r.zeroOrInvalid.total, 2);
});

test("a unit converting to itself is reported as a self-conversion", () => {
  const r = auditUnitConversions({ units: [unit(33, "Meter", [{ toUnit: id(33), quantity: 1 }])] });
  assert.equal(r.selfConversions.total, 1);
});

test("reciprocal pairs are reported, and non-inverse ones are counted as inconsistent", () => {
  const r = auditUnitConversions({
    units: [
      unit(34, "Meter", [{ toUnit: id(35), quantity: 100 }]),
      unit(35, "Centimeter", [{ toUnit: id(34), quantity: 0.02 }]), // should be 0.01
    ],
  });
  assert.equal(r.reciprocalPairs.total, 1);
  assert.equal(r.inconsistentReciprocals, 1);
  assert.equal(r.reciprocalPairs.items[0].consistent, false);
});

test("an exact-inverse reciprocal pair is reported but NOT flagged inconsistent", () => {
  const r = auditUnitConversions({
    units: [
      unit(36, "Meter", [{ toUnit: id(37), quantity: 100 }]),
      unit(37, "Centimeter", [{ toUnit: id(36), quantity: 0.01 }]),
    ],
  });
  assert.equal(r.reciprocalPairs.total, 1);
  assert.equal(r.inconsistentReciprocals, 0);
});

test("the same from→to pair defined twice with different factors is ambiguous", () => {
  const r = auditUnitConversions({
    units: [unit(38, "Box", [{ toUnit: id(39), quantity: 12 }, { toUnit: id(39), quantity: 24 }]), unit(39, "Piece", [])],
  });
  assert.equal(r.ambiguous.total, 1);
  assert.deepEqual(r.ambiguous.items[0].factors, [12, 24]);
});

test("a conversion cycle through three units is detected", () => {
  const r = auditUnitConversions({
    units: [
      unit(40, "A", [{ toUnit: id(41), quantity: 2 }]),
      unit(41, "B", [{ toUnit: id(42), quantity: 3 }]),
      unit(42, "C", [{ toUnit: id(40), quantity: 5 }]),
    ],
  });
  assert.equal(r.cycles.total, 1);
});

test("an item-level factor contradicting the Unit master is ambiguous, and names both", () => {
  const r = auditUnitConversions({
    units: [unit(43, "Box", [{ toUnit: id(44), quantity: 12 }]), unit(44, "Piece", [])],
    rawItems: [item(45, {
      variants: [{ _id: id(46), unitConversions: [{ fromUnit: "Box", toUnit: "Piece", quantity: 10 }] }],
    })],
  });
  assert.equal(r.ambiguous.total, 1);
  assert.deepEqual(r.ambiguous.items[0].masterFactors, [12]);
  assert.equal(r.ambiguous.items[0].quantity, 10);
});

test("variants still on the legacy single-conversion field are counted", () => {
  const r = auditUnitConversions({
    units: [unit(47, "Piece", []), unit(48, "Kilogram", [])],
    rawItems: [item(49, { variants: [{ _id: id(50), unitConversion: { fromUnit: "Piece", toUnit: "Kilogram", quantity: 0.4 } }] })],
  });
  assert.equal(r.variantsUsingLegacySingleField, 1);
  assert.equal(r.itemLevelConversions, 1);
});

// ── Balances and variants ───────────────────────────────────────────────────

test("an item balance that disagrees with its variant total is reported with the difference", () => {
  const r = auditBalancesAndVariants([
    item(51, { quantity: 100, variants: [{ _id: id(52), quantity: 40 }, { _id: id(53), quantity: 40 }] }),
    item(54, { quantity: 80, variants: [{ _id: id(55), quantity: 80 }] }),
  ]);
  assert.equal(r.itemVsVariantBalanceMismatch.total, 1);
  assert.equal(r.itemVsVariantBalanceMismatch.items[0].difference, 20);
});

test("a balance with no movement history at all is reported; a zero balance is not", () => {
  const r = auditBalancesAndVariants([
    item(56, { quantity: 40, stockTransactions: [] }),
    item(57, { quantity: 0, stockTransactions: [] }),
  ]);
  assert.equal(r.balanceWithNoMovementHistory.total, 1);
  assert.equal(r.balanceWithNoMovementHistory.items[0].id, id(56));
});

test("two variants describing the same option combination are a duplicate", () => {
  const r = auditBalancesAndVariants([
    item(58, { variants: [
      { _id: id(59), combination: ["Blue", "XL"] },
      { _id: id(60), combination: ["blue", "xl"] }, // same thing, different case
      { _id: id(61), combination: ["Red", "XL"] },
    ]}),
  ]);
  assert.equal(r.duplicateVariantCombinations.total, 1);
  assert.equal(r.duplicateVariantCombinations.items[0].count, 2);
});

test("default '-var' SKU collisions are told apart from ones a human typed", () => {
  const r = auditBalancesAndVariants([
    item(62, { sku: "CNV-1", variants: [{ _id: id(63), sku: "CNV-1-var" }, { _id: id(64), sku: "CNV-1-var" }] }),
    item(65, { sku: "FAB-1", variants: [{ _id: id(66), sku: "SHARED" }] }),
    item(67, { sku: "FAB-2", variants: [{ _id: id(68), sku: "SHARED" }] }),
  ]);
  // The system mints the first collision; a person made the second. The fix
  // differs, so the counts are separate.
  assert.equal(r.defaultVariantSkuCollisions.total, 1);
  assert.equal(r.duplicateVariantSkus.total, 1);
  assert.equal(r.duplicateVariantSkus.items[0].sku, "shared");
});

test("variants with no SKU at all are reported", () => {
  const r = auditBalancesAndVariants([item(69, { variants: [{ _id: id(70), sku: "" }, { _id: id(71), sku: "OK" }] })]);
  assert.equal(r.missingVariantSku.total, 1);
});

// ── Type and lifecycle ──────────────────────────────────────────────────────

test("item type and lifecycle are reported as SCHEMA gaps, not as data to be filled in", () => {
  const r = auditTypeAndLifecycle({
    rawItems: [item(72), item(73)],
    stockItems: [{ _id: id(74), productType: "Goods" }, { _id: id(75), productType: "Service" }],
  });
  assert.equal(r.rawItems.withoutExplicitItemType, 2);
  assert.equal(r.rawItems.schemaDeclaresItemType, false);
  assert.equal(r.lifecycle.schemaDeclaresLifecycle, false);
  assert.equal(r.lifecycle.archiveCapability, "ABSENT");
  assert.deepEqual(r.stockItems.byProductType, { Goods: 1, Service: 1 });
  // RawItem.status is a derived STOCK state and must not be mistaken for one.
  assert.match(r.lifecycle.note, /DERIVED stock state/);
});

// ── Supplier relationships: all three layers ────────────────────────────────

const V = (n) => ({ _id: id(n) });

test("all three supplier layers are counted — primary, alternates and variant aliases", () => {
  // The correction this pins: an earlier version claimed supplier data lived
  // only on variants, so two whole layers went unmeasured.
  const r = auditSupplierRelationships({
    vendors: [V(80), V(81), V(82)],
    rawItems: [
      item(83, { primaryVendor: id(80) }),
      item(84, { alternateVendors: [id(81), id(82)] }),
      item(85, { variants: [{ _id: id(86), vendorNicknames: [{ vendor: id(80), nickname: "V-1" }] }] }),
    ],
  });
  assert.equal(r.layers.itemsWithPrimarySupplier, 1);
  assert.equal(r.layers.itemsWithAlternateSuppliers, 1);
  assert.equal(r.layers.alternateSupplierReferences, 2);
  assert.equal(r.layers.itemsWithVariantSupplierAliases, 1);
  assert.equal(r.layers.variantSupplierAliases, 1);
});

test("an item with nothing at any layer has NO CONFIGURED supplier relationship — not 'no supplier'", () => {
  const r = auditSupplierRelationships({ vendors: [V(87)], rawItems: [item(88), item(89, { primaryVendor: id(87) })] });
  assert.equal(r.itemsWithNoConfiguredSupplierRelationship.total, 1);
  assert.equal(r.itemsWithNoConfiguredSupplierRelationship.items[0].id, id(88));
  // The wording is load-bearing: PO history may still name a supplier.
  assert.match(r.limitation, /does NOT mean the item has no supplier/);
  assert.match(r.limitation, /purchase-order history/i);
});

test("an item carrying ONLY an item-level supplier is not counted as unconfigured", () => {
  // The precise bug the old wording would have caused: items with a
  // primaryVendor and no variants reading as having no supplier at all.
  const r = auditSupplierRelationships({ vendors: [V(90)], rawItems: [item(91, { primaryVendor: id(90), variants: [] })] });
  assert.equal(r.itemsWithNoConfiguredSupplierRelationship.total, 0);
  assert.equal(r.layers.itemsWithPrimarySupplier, 1);
});

test("dangling supplier references are reported per layer, not lumped together", () => {
  const r = auditSupplierRelationships({
    vendors: [V(92)],
    rawItems: [item(93, {
      primaryVendor: id(900),                 // gone
      alternateVendors: [id(92), id(901)],    // one good, one gone
      variants: [{ _id: id(94), vendorNicknames: [{ vendor: id(902), nickname: "X" }] }], // gone
    })],
  });
  assert.equal(r.danglingReferences.primaryVendor.total, 1);
  assert.equal(r.danglingReferences.alternateVendors.total, 1);
  assert.equal(r.danglingReferences.variantAliases.total, 1);
  assert.equal(r.danglingReferences.total, 3);
});

test("the same supplier configured at more than one layer is reported once, with the layers named", () => {
  const r = auditSupplierRelationships({
    vendors: [V(95)],
    rawItems: [item(96, {
      primaryVendor: id(95),
      alternateVendors: [id(95)],  // redundant with primary
      variants: [{ _id: id(97), vendorNicknames: [{ vendor: id(95), nickname: "CODE" }] }],
    })],
  });
  assert.equal(r.sameSupplierAtMultipleLayers.total, 1);
  const row = r.sameSupplierAtMultipleLayers.items[0];
  assert.deepEqual(row.layers, ["alternateVendors[]", "primaryVendor", "variants[].vendorNicknames[]"]);
  assert.match(row.note, /repeated in alternates/);
});

test("aliases missing their vendor reference or their code are both reported", () => {
  const r = auditSupplierRelationships({
    vendors: [V(98)],
    rawItems: [item(99, { variants: [{ _id: id(150), vendorNicknames: [
      { vendor: id(98), nickname: "GOOD" },
      { vendor: id(98), nickname: "" },   // no code
      { nickname: "orphan" },              // no vendor
    ]}]})],
  });
  assert.equal(r.aliasesMissingIdentity.total, 2);
});

test("one supplier holding two codes on one variant is a duplicate alias", () => {
  const r = auditSupplierRelationships({
    vendors: [V(151)],
    rawItems: [item(152, { variants: [{ _id: id(153), vendorNicknames: [
      { vendor: id(151), nickname: "CODE-A", price: 10, deliveryDays: 5 },
      { vendor: id(151), nickname: "CODE-B", price: 12 },
    ]}]})],
  });
  assert.equal(r.duplicateAliasesPerSupplierPerVariant.total, 1);
  assert.equal(r.duplicateAliasesPerSupplierPerVariant.items[0].count, 2);
  assert.equal(r.commercialDataOnAliases.aliasesCarryingPrice, 2);
  assert.equal(r.commercialDataOnAliases.aliasesCarryingLeadTime, 1);
  assert.equal(r.commercialDataOnAliases.aliasesCarryingBoth, 1);
});

test("only the variant layer can carry a supplier code, price or lead time — and the report says so", () => {
  const r = auditSupplierRelationships({ vendors: [V(154)], rawItems: [item(155, { primaryVendor: id(154) })] });
  assert.equal(r.commercialDataOnAliases.aliasesCarryingPrice, 0);
  assert.match(r.limitation, /the two item-level layers are bare references/);
});

// ── StockItem hygiene ───────────────────────────────────────────────────────

const stock = (n, over = {}) => ({
  _id: id(n), name: `Finished ${n}`, reference: `FG-${n}`, productType: "Goods",
  category: "Bags", unit: "Units", trackInventory: true, variants: [], ...over,
});

test("StockItem reference codes: missing, exact duplicates and normalised-only duplicates", () => {
  const r = auditStockItems({ stockItems: [
    stock(160, { reference: "" }),
    stock(161, { reference: "FG-A" }),
    stock(162, { reference: "FG-A" }),   // exact
    stock(163, { reference: "fg-b" }),
    stock(164, { reference: "FG-B " }),  // normalised only
  ]});
  assert.equal(r.referenceIdentity.missingReference.total, 1);
  assert.equal(r.referenceIdentity.exactDuplicates.total, 1);
  assert.equal(r.referenceIdentity.normalisedDuplicates.total, 1);
});

test("StockItem names and additionalNames share one namespace for duplicate detection", () => {
  const r = auditStockItems({ stockItems: [
    stock(165, { name: "Tote Bag" }),
    stock(166, { name: "Rucksack", additionalNames: ["tote bag"] }),
  ]});
  assert.equal(r.nameIdentity.duplicateNameGroups.total, 1);
});

test("a Service that tracks inventory, and a Goods that does not, are both contradictions", () => {
  const r = auditStockItems({ stockItems: [
    stock(167, { productType: "Service", trackInventory: true }),
    stock(168, { productType: "Goods", trackInventory: false }),
    stock(169, { productType: "Service", trackInventory: false }), // coherent
  ]});
  assert.equal(r.productTypeAndTracking.contradictions.total, 2);
});

test("a service item holding an inventory balance is reported separately from the flag contradiction", () => {
  const r = auditStockItems({ stockItems: [
    stock(170, { productType: "Service", trackInventory: false, totalQuantityOnHand: 12,
      variants: [{ sku: "SVC-1", quantityOnHand: 12 }] }),
  ]});
  assert.equal(r.productTypeAndTracking.serviceItemsCarryingInventoryBalance.total, 1);
  // The flags agree with each other; the BALANCE is the finding.
  assert.equal(r.productTypeAndTracking.contradictions.total, 0);
});

test("header totalQuantityOnHand is reconciled against the variant total", () => {
  const r = auditStockItems({ stockItems: [
    stock(171, { totalQuantityOnHand: 100, variants: [{ sku: "A", quantityOnHand: 40 }, { sku: "B", quantityOnHand: 40 }] }),
    stock(172, { totalQuantityOnHand: 50, variants: [{ sku: "C", quantityOnHand: 50 }] }),
  ]});
  assert.equal(r.balances.headerVsVariantMismatch.total, 1);
  assert.equal(r.balances.headerVsVariantMismatch.items[0].difference, 20);
});

test("every finished-goods balance is reported as unexplained — StockItem has no ledger at all", () => {
  const r = auditStockItems({ stockItems: [
    stock(173, { totalQuantityOnHand: 10, variants: [{ sku: "D", quantityOnHand: 10 }] }),
    stock(174, { totalQuantityOnHand: 0, variants: [{ sku: "E", quantityOnHand: 0 }] }),
  ]});
  assert.equal(r.balances.balancesWithNoMovementLedger.total, 1); // only the one holding stock
  assert.match(r.balances.note, /NO movement history of any kind/);
});

test("StockItem barcodes are checked for duplicates at item and variant level", () => {
  const r = auditStockItems({ stockItems: [
    stock(175, { barcode: "890123", variants: [{ sku: "V1", barcode: "V-BAR" }] }),
    stock(176, { barcode: "890123", variants: [{ sku: "V2", barcode: "V-BAR" }] }),
  ]});
  assert.equal(r.barcodes.duplicateItemBarcodes.total, 1);
  assert.equal(r.barcodes.duplicateVariantBarcodes.total, 1);
});

test("StockItem variant SKUs: missing, duplicate, normalised-only and system-shaped", () => {
  const r = auditStockItems({ stockItems: [
    stock(177, { variants: [
      { sku: "" },
      { sku: "FG-X" },
      { sku: "FG-X" },              // exact duplicate
      { sku: "fg-y" }, { sku: "FG-Y" }, // normalised only
      { sku: "FG-Z-VAR" },          // system-shaped
    ]}),
  ]});
  assert.equal(r.variantIdentity.missingVariantSku.total, 1);
  assert.equal(r.variantIdentity.exactDuplicateVariantSkus.total, 1);
  assert.equal(r.variantIdentity.normalisedDuplicateVariantSkus.total, 1);
  assert.equal(r.variantIdentity.systemShapedVariantSkus, 1);
});

test("StockItem variant max below min is an error; UoM names absent from the master are surfaced", () => {
  const r = auditStockItems({
    stockItems: [stock(178, { unit: "Dozens", variants: [{ sku: "M1", minStock: 10, maxStock: 5 }] })],
    units: [{ _id: id(179), name: "Units" }],
  });
  assert.equal(r.variantIdentity.minMaxErrors.total, 1);
  assert.equal(r.uomIdentity.unitsNotInMaster.total, 1);
  assert.equal(r.uomIdentity.unitsNotInMaster.items[0].unit, "Dozens");
});

test("HSN and tax classification are completeness counts, not violations", () => {
  const r = auditStockItems({ stockItems: [
    stock(180, { hsnCode: "6109", salesTax: "GST 5%" }),
    stock(181, { hsnCode: "", salesTax: "", purchaseTax: "" }),
  ]});
  assert.equal(r.compliance.missingHsnCode.total, 1);
  assert.equal(r.compliance.missingTaxClassification.total, 1);
  assert.match(r.compliance.note, /completeness counts, not violations/);
});

test("an ObjectId present in both rawitems and stockitems is reported for the migration", () => {
  const r = auditCrossCollectionIdCollisions({
    rawItems: [item(190), item(191)],
    stockItems: [stock(191), stock(192)], // 191 collides
  });
  assert.equal(r.collidingIds.total, 1);
  assert.equal(r.collidingIds.items[0].id, id(191));
  assert.deepEqual(r.collidingIds.items[0].presentIn, ["rawitems", "stockitems"]);
  assert.match(r.note, /unique per collection, not per database/);
});

// ── References ──────────────────────────────────────────────────────────────

test("an item referenced by any gathered document is referenced, with its sources named", () => {
  const r = auditReferences({
    rawItems: [item(91), item(92)],
    operationalPOs: [{ _id: id(93), items: [{ rawItem: id(91) }] }],
    barcodes: [{ _id: id(94), rawItem: id(91) }],
  });
  assert.equal(r.referencedItems, 1);
  assert.deepEqual(r.referencedBySource, { barcode: 1, operationalPO: 1 });
  assert.equal(r.apparentlyUnreferenced.total, 1);
  assert.equal(r.apparentlyUnreferenced.items[0].id, id(92));
});

test("unreferenced is reported as APPARENT, with the reason it cannot be certain", () => {
  const r = auditReferences({ rawItems: [item(95)] });
  assert.match(r.limitation, /free text|not gathered/i);
});

test("a BOM reference counts as a reference to the raw item", () => {
  const r = auditReferences({
    rawItems: [item(96)],
    stockItems: [{ _id: id(97), variants: [{ rawItems: [{ rawItemId: id(96) }] }] }],
  });
  assert.equal(r.referencedItems, 1);
  assert.deepEqual(r.referencedBySource, { stockItemBOM: 1 });
});

// ── BOM and barcode integrity ───────────────────────────────────────────────

test("BOM and barcode references to missing items and missing variants are reported separately", () => {
  const r = auditBomAndBarcodes({
    rawItems: [item(100, { variants: [{ _id: id(101) }] })],
    stockItems: [{ _id: id(102), reference: "FG-1", variants: [{ sku: "FG-1-A", rawItems: [
      { rawItemId: id(100), variantId: id(101) },   // good
      { rawItemId: id(100), variantId: id(999) },   // variant gone
      { rawItemId: id(998) },                        // item gone
      { rawItemId: id(100) },                        // item only — legitimate
    ]}]}],
    barcodes: [
      { _id: id(103), rawItem: id(100), variantId: id(101) },  // good
      { _id: id(104), rawItem: id(100), variantId: id(999) },  // variant gone
      { _id: id(105), rawItem: id(997) },                       // item gone
    ],
  });
  assert.equal(r.bomLines, 4);
  assert.equal(r.bomReferencesToMissingItems.total, 1);
  assert.equal(r.bomReferencesToMissingVariants.total, 1);
  assert.equal(r.barcodeReferencesToMissingItems.total, 1);
  assert.equal(r.barcodeReferencesToMissingVariants.total, 1);
});

// ── Catalogue overlap ───────────────────────────────────────────────────────

test("RawItem/StockItem overlap uses exact normalised rules and names the rule on every candidate", () => {
  const r = auditCatalogueOverlap({
    rawItems: [
      item(110, { name: "Cotton Twill", sku: "RAW-FAB-COT-001" }),
      item(111, { name: "Poplin", sku: "SHARED-CODE" }),
      item(112, { name: "Elastic Tape", sku: "RAW-TRI-ELA-002" }),
    ],
    stockItems: [
      { _id: id(113), name: "cotton  twill", reference: "FG-1" },       // name match
      { _id: id(114), name: "Shirt", reference: "shared-code" },        // code match
      { _id: id(115), name: "Trousers", reference: "FG-3", additionalNames: ["Elastic Tape"] }, // additional name
    ],
  });
  assert.equal(r.candidates.total, 3);
  for (const c of r.candidates.items) {
    assert.ok(c.rules.length >= 1);
    assert.ok(["NAME_EXACT_NORMALISED", "CODE_EXACT_NORMALISED"].includes(c.rules[0]));
  }
  assert.match(r.limitation, /CANDIDATES ONLY/);
});

test("a pair matched by BOTH rules is one candidate carrying both, not two candidates", () => {
  const r = auditCatalogueOverlap({
    rawItems: [item(116, { name: "Widget", sku: "W-1" })],
    stockItems: [{ _id: id(117), name: "widget", reference: "w-1" }],
  });
  assert.equal(r.candidates.total, 1);
  assert.deepEqual(r.candidates.items[0].rules, ["CODE_EXACT_NORMALISED", "NAME_EXACT_NORMALISED"]);
});

test("near-miss names produce NO candidate — fuzzy matching is deliberately absent", () => {
  // "Cotton Twill 60s" and "Cotton Twill" are plausibly the same thing. The
  // report must not say so: a wrong merge is destructive and unrecoverable.
  const r = auditCatalogueOverlap({
    rawItems: [item(118, { name: "Cotton Twill 60s", sku: "RAW-1" })],
    stockItems: [{ _id: id(119), name: "Cotton Twill", reference: "FG-9" }],
  });
  assert.equal(r.candidates.total, 0);
});

// ── Budget attribution and reorder ──────────────────────────────────────────

test("implementation status is classified from HEAD: the committed baseline has NO item-wise attribution", () => {
  // The correction this pins: RawItem.budgetLedgerId, Acc_ItemCategoryBudget,
  // itemBudgetHead.service.js and the request-line budgetAllocation fields
  // are none of them in HEAD. Presence in the working tree is not shipped
  // behaviour, and an earlier version of this report called the override
  // fields "COMMITTED".
  const r = auditBudgetAttribution({ rawItems: [item(200)] });
  assert.match(r.status.committedStoreBaseline, /NO item-wise budget attribution authority/);
  assert.match(r.status.committedStoreBaseline, /NOT in HEAD/);
  assert.match(r.status.pausedUncommitted, /none in HEAD/);
  assert.match(r.status.pausedUncommitted, /budgetAllocation/);
  assert.match(r.status.proposedTarget, /^Company-scoped ItemAccountingProfile/);
  // The resolver risk is recorded, not fixed.
  assert.match(r.status.discoveredRisk, /before validating that the target ledger belongs to the company/);
});

test("an absent mapping collection is a STATE, never zero coverage", () => {
  const r = auditBudgetAttribution({ rawItems: [item(201, { category: "Fabric" })] });
  assert.equal(r.mappingCollection.gathered, false);
  assert.equal(r.mappingCollection.state, "MAPPING_COLLECTION_ABSENT");
  assert.equal(r.mappingCollection.rows, null);
  assert.deepEqual(r.perCompanyCoverage, []);
  assert.match(r.limitation, /coverage is unknown rather than zero|never collapses it into one figure/);
});

test("coverage is per company — a category mapped for one company is not mapped for another", () => {
  const A = id(202);
  const B = id(203);
  const r = auditBudgetAttribution({
    rawItems: [item(204, { category: "Fabric" }), item(205, { category: "Thread" })],
    itemCategoryBudgets: [
      { companyId: A, category: "Fabric", categoryKey: "fabric", budgetLedgerId: id(206) },
      { companyId: B, category: "Thread", categoryKey: "thread", budgetLedgerId: id(207) },
    ],
  });
  const byCompany = Object.fromEntries(r.perCompanyCoverage.map((c) => [c.companyId, c]));
  assert.equal(byCompany[A].states.CATEGORY_MAPPED, 1);
  assert.equal(byCompany[A].states.CATEGORY_NEVER_REVIEWED, 1);
  assert.equal(byCompany[B].states.CATEGORY_MAPPED, 1);
  assert.equal(byCompany[B].states.CATEGORY_NEVER_REVIEWED, 1);
});

test("a mapping row with no budget head is 'reviewed but unmapped', not 'never reviewed'", () => {
  const A = id(208);
  const r = auditBudgetAttribution({
    rawItems: [item(209, { category: "Fabric" })],
    itemCategoryBudgets: [{ companyId: A, category: "Fabric", categoryKey: "fabric", budgetLedgerId: null }],
  });
  const c = r.perCompanyCoverage[0];
  assert.equal(c.states.MAPPED_WITHOUT_HEAD, 1);
  assert.equal(c.states.CATEGORY_NEVER_REVIEWED, 0);
  assert.equal(c.states.CATEGORY_MAPPED, 0);
});

// ── Company safety: the correction that matters most ────────────────────────

test("an override whose ledger belongs to THIS company is a match, and answers for it", () => {
  const A = id(210);
  const r = auditBudgetAttribution({
    rawItems: [item(211, { category: "Fabric", budgetLedgerId: id(212) })],
    ledgers: [{ _id: id(212), companyId: A }],
    itemCategoryBudgets: [{ companyId: A, category: "Fabric", categoryKey: "fabric", budgetLedgerId: id(213) }],
  });
  const c = r.perCompanyCoverage.find((x) => x.companyId === A);
  assert.equal(c.states.ITEM_OVERRIDE_COMPANY_MATCH, 1);
  // Its category is not also counted — the override answered.
  assert.equal(c.states.CATEGORY_MAPPED, 0);
});

test("an override belonging to Company A is NOT Company B's answer — B evaluates its own category coverage", () => {
  // The bug this pins: excluding every overridden item from every company's
  // category coverage would silently give B an answer from A's books.
  const A = id(214);
  const B = id(215);
  const r = auditBudgetAttribution({
    rawItems: [item(216, { category: "Fabric", budgetLedgerId: id(217) })],
    ledgers: [{ _id: id(217), companyId: A }],
    itemCategoryBudgets: [
      { companyId: A, category: "Fabric", categoryKey: "fabric", budgetLedgerId: id(218) },
      { companyId: B, category: "Fabric", categoryKey: "fabric", budgetLedgerId: id(219) },
    ],
  });
  const forA = r.perCompanyCoverage.find((x) => x.companyId === A);
  const forB = r.perCompanyCoverage.find((x) => x.companyId === B);
  assert.equal(forA.states.ITEM_OVERRIDE_COMPANY_MATCH, 1);
  assert.equal(forB.states.ITEM_OVERRIDE_COMPANY_MISMATCH, 1);
  // …and B still gets a category answer rather than being left with nothing.
  assert.equal(forB.states.CATEGORY_MAPPED, 1);
});

test("without ledger data an override's company is UNVERIFIABLE, not assumed valid", () => {
  const A = id(220);
  const r = auditBudgetAttribution({
    rawItems: [item(221, { category: "Fabric", budgetLedgerId: id(222) })],
    itemCategoryBudgets: [{ companyId: A, category: "Fabric", categoryKey: "fabric", budgetLedgerId: id(223) }],
  });
  assert.equal(r.ledgerData.gathered, false);
  assert.equal(r.itemOverrides.overridesWithUnverifiableCompany, 1);
  assert.equal(r.perCompanyCoverage[0].states.ITEM_OVERRIDE_COMPANY_UNVERIFIABLE, 1);
});

test("an override pointing at a missing ledger is reported as such, globally and per company", () => {
  const A = id(224);
  const r = auditBudgetAttribution({
    rawItems: [item(225, { budgetLedgerId: id(226) })],
    ledgers: [{ _id: id(227), companyId: A }],
    itemCategoryBudgets: [{ companyId: A, category: "Fabric", categoryKey: "fabric", budgetLedgerId: id(227) }],
  });
  assert.equal(r.itemOverrides.overridesToMissingLedger.total, 1);
  assert.equal(r.perCompanyCoverage[0].states.OVERRIDE_TO_MISSING_LEDGER, 1);
});

test("the owning company of every override target is reported", () => {
  const A = id(228);
  const B = id(229);
  const r = auditBudgetAttribution({
    rawItems: [item(230, { budgetLedgerId: id(231) }), item(232, { budgetLedgerId: id(233) })],
    ledgers: [{ _id: id(231), companyId: A }, { _id: id(233), companyId: B }],
  });
  assert.deepEqual(r.itemOverrides.targetLedgerCompanies, { [A]: 1, [B]: 1 });
});

test("every override is flagged unsafe because the ITEM itself carries no company scope", () => {
  const r = auditBudgetAttribution({
    rawItems: [item(234, { budgetLedgerId: id(235) }), item(236)],
    ledgers: [{ _id: id(235), companyId: id(237) }],
  });
  assert.equal(r.itemOverrides.unsafeBecauseItemHasNoCompanyScope.count, 1);
  assert.match(r.itemOverrides.unsafeBecauseItemHasNoCompanyScope.reason, /RawItem has no companyId/);
});

test("an item with neither a category nor an override is attributable by no route", () => {
  const A = id(238);
  const r = auditBudgetAttribution({
    rawItems: [item(239, { category: "", customCategory: "" }), item(240, { category: "Fabric" })],
    itemCategoryBudgets: [{ companyId: A, category: "Fabric", categoryKey: "fabric", budgetLedgerId: id(241) }],
  });
  assert.equal(r.itemsWithNoCategoryAndNoOverride.total, 1);
  assert.equal(r.perCompanyCoverage[0].states.NO_CATEGORY_AND_NO_OVERRIDE, 1);
});

test("a category string alone never means attributable — every coverage state is named", () => {
  const r = auditBudgetAttribution({ rawItems: [item(242, { category: "Fabric" })] });
  for (const state of [
    "MAPPING_COLLECTION_ABSENT", "CATEGORY_NEVER_REVIEWED", "MAPPED_WITHOUT_HEAD", "CATEGORY_MAPPED",
    "ITEM_OVERRIDE_COMPANY_MATCH", "ITEM_OVERRIDE_COMPANY_MISMATCH", "ITEM_OVERRIDE_COMPANY_UNVERIFIABLE",
    "OVERRIDE_TO_MISSING_LEDGER", "NO_CATEGORY_AND_NO_OVERRIDE",
  ]) {
    assert.ok(r.coverageStates[state], `${state} must be a named coverage state`);
  }
});

// ── Barcode identity across the whole future namespace ──────────────────────

test("product barcodes collide item-vs-item, variant-vs-variant and across levels", () => {
  const r = auditBarcodeIdentity({
    stockItems: [
      stock(250, { barcode: "890111", variants: [{ sku: "A", barcode: "V-1" }] }),
      stock(251, { barcode: "890111", variants: [{ sku: "B", barcode: "V-1" }] }), // both levels duplicated
      stock(252, { barcode: "V-2", variants: [{ sku: "C", barcode: "V-2" }] }),    // same string at two levels
    ],
  });
  assert.equal(r.productIdentifiers.duplicateItemVsItem.total, 1);
  assert.equal(r.productIdentifiers.duplicateVariantVsVariant.total, 1);
  assert.equal(r.productIdentifiers.duplicateItemLevelVsVariantLevel.total, 1);
  assert.equal(r.productIdentifiers.duplicateItemLevelVsVariantLevel.items[0].value, "V-2");
});

test("printed lot instances are reported separately, with why they are not comparable", () => {
  const r = auditBarcodeIdentity({
    stockItems: [stock(253, { barcode: "890222" })],
    barcodes: [{ _id: id(254) }, { _id: id(255) }],
  });
  assert.equal(r.printedLotInstances.documents, 2);
  assert.equal(r.printedLotInstances.comparable, false);
  assert.match(r.printedLotInstances.reason, /identity IS the document _id/);
  assert.match(r.printedLotInstances.reason, /shares no namespace/);
  // A plain product code is never compared against lot ids.
  assert.equal(r.printedLotInstances.productCodesMatchingLotInstanceIds.total, 0);
});

test("the ONE possible cross-concept collision — an ObjectId pasted into a barcode field — is caught", () => {
  const lotId = id(256);
  const r = auditBarcodeIdentity({
    stockItems: [stock(257, { barcode: lotId })],
    barcodes: [{ _id: lotId }],
  });
  assert.equal(r.printedLotInstances.productCodesMatchingLotInstanceIds.total, 1);
  assert.match(r.printedLotInstances.crossCheckNote, /paste error rather than a duplicate/);
});

test("RawItem has no product-barcode field at all, and the report says so", () => {
  const r = auditBarcodeIdentity({ stockItems: [], barcodes: [] });
  assert.equal(r.rawItemProductBarcodes.exists, false);
  assert.match(r.rawItemProductBarcodes.note, /never had a product code/);
});

test("reorder fields are reported as global, and a max below min is a finding", () => {
  const r = auditReorderFields([
    item(125, { minStock: 10, maxStock: 5 }),
    item(126, { minStock: 10, maxStock: 100, variants: [{ _id: id(127), minStock: 3 }] }),
  ]);
  assert.equal(r.maxBelowMin.total, 1);
  assert.equal(r.variantsWithOwnMinStock, 1);
  assert.equal(r.locationAware, false);
});

// ── The whole item-master report ────────────────────────────────────────────

test("the report is deterministic: identical inputs, identical JSON", () => {
  const fixture = () => ({
    rawItems: [
      item(130, { name: "Cotton", sku: "RAW-FAB-COT-001", quantity: 10, category: "Fabric", unit: "Meter",
        variants: [{ _id: id(131), sku: "RAW-FAB-COT-001-var", quantity: 10, combination: ["Blue"] }],
        stockTransactions: [{ type: "ADD", quantity: 10 }] }),
      item(132, { name: "cotton", sku: "raw-fab-cot-001", quantity: 5 }),
    ],
    stockItems: [{ _id: id(133), name: "Cotton", reference: "FG-1", productType: "Goods", variants: [] }],
    units: [{ _id: id(134), name: "Meter", conversions: [] }],
    vendors: [{ _id: id(135) }],
  });
  assert.equal(
    JSON.stringify(computeItemMasterReport(fixture())),
    JSON.stringify(computeItemMasterReport(fixture())),
  );
});

test("every section is present on an empty catalogue, and the summary renders", () => {
  const r = computeItemMasterReport({});
  for (const section of [
    "skuIdentity", "nameIdentity", "categoryIdentity", "unitIdentity", "unitConversions",
    "balancesAndVariants", "typeAndLifecycle", "supplierRelationships", "references",
    "bomAndBarcodes", "stockItemHygiene", "barcodeIdentity", "crossCollectionIdCollisions",
    "catalogueOverlap", "budgetAttribution", "reorderFields", "limitations",
  ]) {
    assert.ok(r[section] !== undefined, `${section} must be present`);
  }
  assert.ok(r.limitations.length >= 6);
  assert.match(renderItemMasterSummary(r), /Item master: identity/);
});

// ── The rendered summary: real values, and never the word "undefined" ───────
//
// A renderer reading a stale result shape prints "undefined" instead of
// failing, so a test that only asserts "does not throw" passes while the
// report is nonsense. These assert the actual numbers appear.

/** A fixture exercising budget attribution AND barcode identity together. */
const renderFixture = () => ({
  rawItems: [
    // Override → Company A's ledger.
    item(300, { sku: "OVR-A", category: "Fabric", budgetLedgerId: id(301), budgetLedgerName: "Consumables" }),
    // No override; category "Fabric" is mapped for B only.
    item(302, { sku: "CAT-1", category: "Fabric" }),
    // Neither.
    item(303, { sku: "NONE-1", category: "", customCategory: "" }),
  ],
  ledgers: [{ _id: id(301), companyId: id(310) }],
  itemCategoryBudgets: [
    { companyId: id(311), category: "Fabric", categoryKey: "fabric", budgetLedgerId: id(320) },
  ],
  companies: [
    { _id: id(310), companyName: "Acme" },
    { _id: id(311), companyName: "Borealis" },
    { _id: id(312), companyName: "Cerulean" }, // no mapping, no ledger
  ],
  stockItems: [
    stock(330, { barcode: "890111", variants: [{ sku: "S1", barcode: "V-DUP" }] }),
    stock(331, { barcode: "890111", variants: [{ sku: "S2", barcode: "V-DUP" }] }),
    stock(332, { barcode: "CROSS", variants: [{ sku: "S3", barcode: "CROSS" }] }),
  ],
  barcodes: [{ _id: id(340) }, { _id: id(341) }],
});

test("the rendered summary contains NO literal 'undefined' on a fully-populated report", () => {
  const out = renderItemMasterSummary(computeItemMasterReport(renderFixture()));
  const offenders = out.split("\n").filter((l) => l.includes("undefined"));
  assert.deepEqual(offenders, [], `rendered summary printed undefined:\n${offenders.join("\n")}`);
});

test("the rendered summary prints the real budget status and company-universe values", () => {
  const out = renderItemMasterSummary(computeItemMasterReport(renderFixture()));
  // Implementation state, from the authoritative fields.
  assert.match(out, /committed Store baseline : NO item-wise budget attribution authority/);
  assert.match(out, /paused \/ uncommitted     : .*none in HEAD/);
  assert.match(out, /proposed target          : Company-scoped ItemAccountingProfile/);
  assert.match(out, /discovered risk          : .*before validating that the target ledger belongs/);
  // Company universe — three companies, one with no configuration at all.
  assert.match(out, /Company universe: COMPANY_MASTER/);
  assert.match(out, /companies in master: 3 · evaluated: 3 · with no budget configuration at all: 2/);
  assert.match(out, /Mapping collection: PRESENT \(1 rows\)/);
  assert.match(out, /Item overrides: 1 /);
});

test("the rendered summary shows both override and category dimensions per company, and warns against summing", () => {
  const out = renderItemMasterSummary(computeItemMasterReport(renderFixture()));
  assert.match(out, /NOT mutually exclusive and must not be summed into a percentage/);
  // Acme owns the override's ledger → a match there.
  assert.match(out, /company 0{20}0310 \(Acme\)/);
  // Borealis holds the mapping → the override is a mismatch AND its category resolves.
  assert.match(out, /company 0{20}0311 \(Borealis\)/);
  const borealis = out.split("\n").findIndex((l) => l.includes("Borealis"));
  const overrideLine = out.split("\n")[borealis + 1];
  const categoryLine = out.split("\n")[borealis + 2];
  assert.match(overrideLine, /mismatch 1/);
  assert.match(categoryLine, /mapped 2/); // the mismatched item AND the plain one
  // Cerulean has nothing configured and still appears.
  assert.match(out, /company 0{20}0312 \(Cerulean\) — 0 mapping row\(s\), no budget configuration/);
});

test("the rendered summary prints the global barcode-identity findings", () => {
  const out = renderItemMasterSummary(computeItemMasterReport(renderFixture()));
  assert.match(out, /item vs item collisions          : 1/);
  assert.match(out, /variant vs variant collisions    : 1/);
  assert.match(out, /item-level vs variant-level      : 1/);
  assert.match(out, /Printed lot instances: 2 document\(s\), comparable with product codes: false/);
  assert.match(out, /identity IS the document _id/);
  assert.match(out, /product codes matching a lot-instance ObjectId: 0/);
  assert.match(out, /RawItem product-barcode field exists: false/);
});

test("the rendered summary tells the truth when the optional collections are ABSENT", () => {
  const out = renderItemMasterSummary(computeItemMasterReport({
    rawItems: [item(350, { category: "Fabric", budgetLedgerId: id(351) })],
  }));
  assert.equal(out.split("\n").filter((l) => l.includes("undefined")).length, 0);
  assert.match(out, /Company universe: DERIVED_FROM_DATA_ONLY — INCOMPLETE, not every company was evaluated/);
  assert.match(out, /companies in master: not gathered/);
  assert.match(out, /Mapping collection: MAPPING_COLLECTION_ABSENT — category coverage is UNKNOWN, not zero/);
  assert.match(out, /Ledger data: NOT gathered — override company ownership is unverifiable/);
});

test("the rendered summary reports company ids that are not in the company master", () => {
  const out = renderItemMasterSummary(computeItemMasterReport({
    rawItems: [item(360, { category: "Fabric" })],
    companies: [{ _id: id(361), companyName: "Known" }],
    itemCategoryBudgets: [{ companyId: id(999), category: "Fabric", categoryKey: "fabric", budgetLedgerId: id(362) }],
  }));
  assert.match(out, /INTEGRITY — company ids not in the company master: 1 on mappings/);
  assert.match(out, /\[NOT IN COMPANY MASTER\]/);
});

// ── Company universe ────────────────────────────────────────────────────────

test("every company in the master is evaluated — A with an override, B with a mapping, C with neither", () => {
  const A = id(400);
  const B = id(401);
  const C = id(402);
  const r = auditBudgetAttribution({
    rawItems: [
      item(403, { sku: "OVR", category: "Fabric", budgetLedgerId: id(404) }), // override → A
      item(405, { sku: "CAT", category: "Fabric" }),
    ],
    ledgers: [{ _id: id(404), companyId: A }],
    itemCategoryBudgets: [{ companyId: B, category: "Fabric", categoryKey: "fabric", budgetLedgerId: id(406) }],
    companies: [{ _id: A, companyName: "A" }, { _id: B, companyName: "B" }, { _id: C, companyName: "C" }],
  });

  assert.equal(r.companyUniverse.source, "COMPANY_MASTER");
  assert.equal(r.companyUniverse.complete, true);
  assert.equal(r.companyUniverse.companiesEvaluated, 3);

  const by = Object.fromEntries(r.perCompanyCoverage.map((c) => [c.companyId, c]));
  assert.ok(by[A] && by[B] && by[C], "all three companies must appear");

  // A owns the override's ledger.
  assert.equal(by[A].states.ITEM_OVERRIDE_COMPANY_MATCH, 1);
  // …and A has no mapping, so its other item is never-reviewed there.
  assert.equal(by[A].states.CATEGORY_NEVER_REVIEWED, 1);

  // A's override is NOT B's answer: mismatch, and B's own category applies
  // to BOTH items.
  assert.equal(by[B].states.ITEM_OVERRIDE_COMPANY_MATCH, 0);
  assert.equal(by[B].states.ITEM_OVERRIDE_COMPANY_MISMATCH, 1);
  assert.equal(by[B].states.CATEGORY_MAPPED, 2);

  // C has neither: the override is not its answer either, and it has no
  // mapping — but it is still evaluated and still visible.
  assert.equal(by[C].states.ITEM_OVERRIDE_COMPANY_MISMATCH, 1);
  assert.equal(by[C].states.CATEGORY_NEVER_REVIEWED, 2);
  assert.equal(by[C].hasBudgetConfiguration, false);
  assert.equal(r.companyUniverse.companiesWithNoBudgetConfiguration, 2); // A and C
});

test("without the company master the universe is labelled INCOMPLETE and claims nothing", () => {
  const r = auditBudgetAttribution({
    rawItems: [item(410, { category: "Fabric" })],
    itemCategoryBudgets: [{ companyId: id(411), category: "Fabric", categoryKey: "fabric", budgetLedgerId: id(412) }],
  });
  assert.equal(r.companyUniverse.source, "DERIVED_FROM_DATA_ONLY");
  assert.equal(r.companyUniverse.complete, false);
  assert.equal(r.companyUniverse.companiesInMaster, null);
  assert.match(r.companyUniverse.note, /THE COMPANY UNIVERSE IS INCOMPLETE/);
});

test("mapping and ledger company ids absent from the master are integrity findings, still evaluated", () => {
  const known = id(420);
  const ghost = id(421);
  const r = auditBudgetAttribution({
    rawItems: [item(422, { category: "Fabric", budgetLedgerId: id(423) })],
    ledgers: [{ _id: id(423), companyId: ghost }],
    itemCategoryBudgets: [{ companyId: ghost, category: "Fabric", categoryKey: "fabric", budgetLedgerId: id(424) }],
    companies: [{ _id: known, companyName: "Known" }],
  });
  assert.equal(r.companyUniverse.mappingCompanyIdsNotInMaster.total, 1);
  assert.equal(r.companyUniverse.ledgerCompanyIdsNotInMaster.total, 1);
  // Not silently dropped — the ghost company is evaluated so its rows are visible.
  const ghostRow = r.perCompanyCoverage.find((c) => c.companyId === ghost);
  assert.ok(ghostRow, "a company named by data must still be evaluated");
  assert.equal(ghostRow.inCompanyMaster, false);
});

// ── Mapping absence is UNKNOWN, not "never reviewed" ────────────────────────

test("with no mapping collection, a category is UNKNOWN — never CATEGORY_NEVER_REVIEWED", () => {
  // A known company, an item whose override belongs to a DIFFERENT company,
  // and no mapping collection at all. The result must record the mismatch
  // and the mapping absence — not blame the data for an undeployed feature.
  const A = id(430); // owns the override's ledger
  const B = id(431); // the company being evaluated
  const r = auditBudgetAttribution({
    rawItems: [item(432, { category: "Fabric", budgetLedgerId: id(433) })],
    ledgers: [{ _id: id(433), companyId: A }],
    companies: [{ _id: A, companyName: "A" }, { _id: B, companyName: "B" }],
    // itemCategoryBudgets deliberately absent
  });
  const forB = r.perCompanyCoverage.find((c) => c.companyId === B);
  assert.equal(forB.states.ITEM_OVERRIDE_COMPANY_MISMATCH, 1);
  assert.equal(forB.states.MAPPING_COLLECTION_ABSENT, 1);
  assert.equal(forB.states.CATEGORY_NEVER_REVIEWED, 0);
  assert.equal(forB.states.CATEGORY_MAPPED, 0);
  assert.match(r.coverageStates.MAPPING_COLLECTION_ABSENT, /UNKNOWN — not zero, and never 'never reviewed'/);
});

test("state counts are documented as non-exclusive so nobody sums them into a percentage", () => {
  const r = auditBudgetAttribution({ rawItems: [item(440)] });
  assert.match(r.stateSemantics, /NOT mutually exclusive/);
  assert.match(r.stateSemantics, /two dimensions of one item/);
});

test("no overlap finding is ever marked confirmed — the shape offers no way to say it", () => {
  const r = computeItemMasterReport({
    rawItems: [item(140, { name: "X", sku: "X-1" })],
    stockItems: [{ _id: id(141), name: "x", reference: "X-1" }],
  });
  const candidate = r.catalogueOverlap.candidates.items[0];
  // A candidate carries the rules that produced it and the ids to look at —
  // and no verdict field of any kind for something to set to "confirmed".
  assert.deepEqual(
    Object.keys(candidate).sort(),
    ["matchedOn", "rawItem", "rawName", "rawSku", "rules", "stockItem", "stockName", "stockReference"],
  );
  assert.equal("confirmed" in candidate, false);
  assert.match(r.catalogueOverlap.limitation, /CANDIDATES ONLY — never confirmed duplicates/);
});
