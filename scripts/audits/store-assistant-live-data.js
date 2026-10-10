#!/usr/bin/env node
"use strict";

require("dotenv").config();

const mongoose = require("mongoose");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { CAPABILITIES } = require("../../services/storePurchase/capabilities");
const { ENTITY_SPECS, DEFINITIONS_BY_ENTITY } = require("../../services/storePurchaseUniversalContract");
const {
  queryCollection, RECORDS, NONE, scanCap,
} = require("../../services/storePurchaseCollectionContext");
const { scopeFor } = require("../../services/storePurchaseUniversalContext");
const { queryReceiveWorkspace } = require("../../services/receiveWorkspaceAssistantContext");

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured; refusing to guess a database.");
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 20000 });
  try {
    const membership = await SpCompanyMembership.findOne({ isActive: true }).select("companyId employeeRef").lean();
    if (!membership?.companyId) throw new Error("No active Store & Purchase company membership is available for a tenant-safe audit.");
    const user = {
      storePurchaseAccess: {
        companyId: membership.companyId,
        actorId: membership.employeeRef || membership._id,
        capabilitySet: new Set([CAPABILITIES.READ]),
        siteIds: [],
      },
    };

    const entityResults = [];
    for (const entity of ENTITY_SPECS) {
      const data = await queryCollection({
        entity: entity.id,
        user,
        message: `are there any ${entity.label} records`,
        args: {
          operation: "exists",
          metric: RECORDS,
          filterMetric: NONE,
          filterOperator: NONE,
          dateMetric: NONE,
          limit: 1,
        },
      });
      entityResults.push({ entity: entity.id, ok: data.ok, count: data.count ?? null, reason: data.ok ? null : data.reason });
    }

    const expected = await queryReceiveWorkspace({
      user,
      message: "any grn expected in june 2026",
      args: {
        operation: "exists",
        stage: "expected",
        source: "all",
        dateBasis: "expected_date",
        from: "2026-06-01",
        to: "2026-06-30",
        limit: 10,
      },
    });

    const poSpec = ENTITY_SPECS.find((item) => item.id === "purchase_order");
    const poDefinitions = DEFINITIONS_BY_ENTITY.purchase_order;
    const poField = (path) => poDefinitions.find((item) => item.path === path)?.id;
    const samplePo = await poSpec.model.findOne({
      ...scopeFor(poSpec, user),
      vendorName: { $type: "string", $ne: "" },
    }).select("vendorName").lean();
    const combined = samplePo?.vendorName ? await queryCollection({
      entity: "purchase_order",
      user,
      message: `list PO number, vendor name and total amount for purchase orders from vendor ${samplePo.vendorName}`,
      args: {
        operation: "list",
        metric: poField("poNumber"),
        outputMetric2: poField("vendorName"),
        outputMetric3: poField("totalAmount"),
        filterMetric: poField("vendorName"),
        filterOperator: "equals",
        filterMetric2: NONE,
        filterOperator2: NONE,
        filterMetric3: NONE,
        filterOperator3: NONE,
        dateMetric: NONE,
        limit: 3,
      },
    }) : { ok: true, skipped: true, count: 0 };
    const expectedVendorCount = samplePo?.vendorName
      ? await poSpec.model.countDocuments({ ...scopeFor(poSpec, user), vendorName: samplePo.vendorName })
      : 0;
    const adversarialSupplier = samplePo?.vendorName ? await queryCollection({
      entity: "purchase_order",
      user,
      message: `any po of ${samplePo.vendorName}`,
      // Reproduce the observed qwen3:32b failure. The server must recover the
      // authorised supplier identity and must not broaden this to every PO.
      args: {
        operation: "count",
        metric: RECORDS,
        outputMetric2: poField("poNumber"),
        outputMetric3: poField("poNumber"),
        filterMetric: poField("poNumber"),
        filterOperator: "equals",
        filterMetric2: poField("poNumber"),
        filterOperator2: "equals",
        filterMetric3: poField("poNumber"),
        filterOperator3: "equals",
        dateMetric: NONE,
        limit: 10,
      },
    }) : { ok: true, skipped: true, count: 0 };
    const adversarialSupplierPassed = adversarialSupplier.ok && (
      adversarialSupplier.skipped
      || (expectedVendorCount <= scanCap()
        ? adversarialSupplier.count === expectedVendorCount
        : adversarialSupplier.truncated && adversarialSupplier.count <= scanCap())
    );

    const failedEntities = entityResults.filter((item) => !item.ok);
    const result = {
      ok: failedEntities.length === 0 && expected.ok && combined.ok
        && (combined.skipped || combined.count > 0) && adversarialSupplierPassed,
      databaseConnected: true,
      tenantResolved: true,
      entityCollectionsChecked: entityResults.length,
      entityCollectionsPassed: entityResults.length - failedEntities.length,
      entityCollectionsWithRecords: entityResults.filter((item) => item.ok && item.count > 0).length,
      failedEntities,
      expectedReceivingQuery: {
        ok: expected.ok,
        matchingCount: expected.matchingCount ?? null,
        sourcesChecked: (expected.coverage || []).map((item) => item.source),
        unavailableSources: (expected.unavailable || []).map((item) => item.source),
        reason: expected.ok ? null : expected.reason,
      },
      combinedPurchaseOrderQuery: {
        ok: combined.ok,
        skippedNoSuitableDevelopmentRecord: Boolean(combined.skipped),
        matchingCount: combined.count ?? null,
        outputFields: combined.outputFieldLabels || [],
        reason: combined.ok ? null : combined.reason,
      },
      adversarialSupplierConstraint: {
        ok: adversarialSupplierPassed,
        skippedNoSuitableDevelopmentRecord: Boolean(adversarialSupplier.skipped),
        expectedCount: expectedVendorCount,
        matchingCount: adversarialSupplier.count ?? null,
        broadenedToAllRecords: adversarialSupplier.ok
          && !adversarialSupplier.skipped && adversarialSupplier.count !== expectedVendorCount,
        reason: adversarialSupplier.ok ? null : adversarialSupplier.reason,
      },
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
