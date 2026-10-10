"use strict";

const mongoose = require("mongoose");
const contract = require("../../services/storePurchaseUniversalContract");
const context = require("../../services/storePurchaseCollectionContext");

const PurchaseOrder = contract.ENTITY_SPECS.find((entry) => entry.id === "purchase_order").model;

const entity = "purchase_order";
const definitions = contract.DEFINITIONS_BY_ENTITY[entity];
const field = (path) => definitions.find((definition) => definition.path === path);
const recordWith = (path, value) => {
  const record = {};
  const parts = path.split(".");
  let target = record;
  for (const part of parts.slice(0, -1)) {
    target[part] = {};
    target = target[part];
  }
  target[parts.at(-1)] = value;
  return record;
};

describe("schema-driven Store & Purchase collection queries", () => {
  test("all 28 entities receive one closed collection-query capability", () => {
    const registry = require("../../services/ai/toolRegistry");
    if (!registry.getTool("store_collection_purchase_order_query")) {
      delete require.cache[require.resolve("../../services/ai/tools/storePurchaseCollectionTools")];
      require("../../services/ai/tools/storePurchaseCollectionTools");
    }
    for (const spec of contract.ENTITY_SPECS) {
      const tool = registry.getTool(`store_collection_${spec.id}_query`);
      expect(tool).toBeTruthy();
      expect(tool.application).toBe("store_purchase");
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(JSON.stringify(tool.parameters)).not.toMatch(/companyId|database|collectionName|physicalPath|recordId/i);
    }
  });

  test("numeric calculations are accepted only for catalogued numeric concepts", () => {
    const numeric = definitions.find((definition) => definition.valueType === "number");
    const textual = definitions.find((definition) => definition.valueType === "text");
    expect(context.validate({ entity, args: {
      operation: "sum", metric: numeric.id, filterMetric: context.NONE,
      filterOperator: context.NONE, dateMetric: context.NONE,
    } }).error).toBeUndefined();
    expect(context.validate({ entity, args: {
      operation: "sum", metric: textual.id, filterMetric: context.NONE,
      filterOperator: context.NONE, dateMetric: context.NONE,
    } }).error).toMatch(/numeric field/i);
  });

  test("filters never cross entity boundaries", () => {
    const foreign = contract.DEFINITIONS_BY_ENTITY.goods_receipt[0];
    const selected = definitions[0];
    expect(context.validate({ entity, args: {
      operation: "count", metric: context.RECORDS, filterMetric: foreign.id,
      filterOperator: "equals", filterValue: "x", dateMetric: context.NONE,
    } }).error).toMatch(/outside.*catalogue/i);
    expect(context.validate({ entity, args: {
      operation: "list", metric: selected.id, filterMetric: context.NONE,
      filterOperator: context.NONE, dateMetric: context.NONE,
    } }).error).toBeUndefined();
  });

  test("date ranges accept only catalogued date concepts", () => {
    const date = definitions.find((definition) => definition.valueType === "date_time");
    const textual = definitions.find((definition) => definition.valueType === "text");
    expect(context.validate({ entity, args: {
      operation: "count", metric: context.RECORDS, filterMetric: context.NONE,
      filterOperator: context.NONE, dateMetric: date.id, from: "2026-06-01", to: "2026-06-30",
    } }).error).toBeUndefined();
    expect(context.validate({ entity, args: {
      operation: "count", metric: context.RECORDS, filterMetric: context.NONE,
      filterOperator: context.NONE, dateMetric: textual.id, from: "2026-06-01",
    } }).error).toMatch(/date field/i);
  });

  test("the filter engine handles numbers, text, missing values and arrays deterministically", () => {
    const numeric = { path: "lines.quantity", valueType: "number" };
    const textual = { path: "status", valueType: "text" };
    const record = { status: "PARTIALLY_RECEIVED", lines: [{ quantity: 4 }, { quantity: 12 }] };
    expect(context.filterMatches(record, numeric, "at_least", "10")).toBe(true);
    expect(context.filterMatches(record, numeric, "less_than", "4")).toBe(false);
    expect(context.filterMatches(record, textual, "contains", "received")).toBe(true);
    expect(context.filterMatches(record, { path: "missing", valueType: "text" }, "is_missing", "")).toBe(true);
  });

  test("server reconciliation derives root workflow status from the schema enum and removes model noise", () => {
    const reconciled = context.reconcileArgs(entity, {
      operation: "count",
      metric: field("totalReceived").id,
      filterMetric: field("totalReceived").id,
      filterOperator: "greater_than",
      dateMetric: definitions.find((definition) => definition.valueType === "date_time").id,
    }, "how many purchase orders are partially received?");
    expect(reconciled.metric).toBe(context.RECORDS);
    expect(reconciled.filterMetric).toBe(field("status").id);
    expect(reconciled.filterOperator).toBe("equals");
    expect(reconciled.filterValue).toBe("PARTIALLY_RECEIVED");
    expect(reconciled.dateMetric).toBe(context.NONE);
  });

  test("a plain record list needs no invented output or filter field", () => {
    const reconciled = context.reconcileArgs(entity, {
      operation: "list",
      metric: field("recordedBy.name")?.id || definitions[0].id,
      filterMetric: definitions[0].id,
      filterOperator: "is_missing",
      dateMetric: context.NONE,
    }, "list purchase orders");
    expect(reconciled.metric).toBe(context.RECORDS);
    expect(reconciled.filterMetric).toBe(context.NONE);
    expect(reconciled.filterOperator).toBe(context.NONE);
    expect(context.validate({ entity, args: reconciled }).error).toBeUndefined();
  });

  test("combined questions retain up to three grounded outputs and filters", () => {
    const vendor = field("vendorName");
    const total = field("totalAmount");
    const reconciled = context.reconcileArgs(entity, {
      operation: "list",
      metric: field("poNumber").id,
      outputMetric2: vendor.id,
      outputMetric3: total.id,
      filterMetric: field("status").id,
      filterOperator: "equals",
      filterValue: "partially received",
      filterMetric2: vendor.id,
      filterOperator2: "contains",
      filterValue2: "Acme",
      filterMetric3: context.NONE,
      filterOperator3: context.NONE,
      dateMetric: context.NONE,
    }, "list PO number, vendor name and total amount for partially received purchase orders from vendor Acme");
    expect(reconciled).toEqual(expect.objectContaining({
      metric: field("poNumber").id,
      outputMetric2: vendor.id,
      outputMetric3: total.id,
      filterMetric: field("status").id,
      filterValue: "PARTIALLY_RECEIVED",
      filterMetric2: vendor.id,
      filterValue2: "Acme",
    }));
    const checked = context.validate({ entity, args: reconciled });
    expect(checked.error).toBeUndefined();
    expect(checked.outputDefinitions).toHaveLength(2);
    expect(checked.filters).toHaveLength(2);
  });

  test("missing text values are resolved from authorised records instead of invented", () => {
    const vendor = field("vendorName");
    const reconciled = context.reconcileArgs(entity, {
      operation: "list",
      metric: field("poNumber").id,
      outputMetric2: vendor.id,
      outputMetric3: field("totalAmount").id,
      filterMetric: vendor.id,
      filterOperator: "equals",
      filterMetric2: context.NONE,
      filterOperator2: context.NONE,
      filterMetric3: context.NONE,
      filterOperator3: context.NONE,
      dateMetric: context.NONE,
    }, "list PO number, vendor name and total amount for purchase orders from vendor Acme Textiles");
    expect(reconciled.metric).toBe(field("poNumber").id);
    expect(reconciled.outputMetric2).toBe(vendor.id);
    expect(reconciled.outputMetric3).toBe(field("totalAmount").id);
    expect(reconciled.filterMetric).toBe(vendor.id);
    expect(reconciled.filterValue).toBe(context.RESOLVE_FROM_RECORDS);
  });

  test("authorised identities resolve conservatively across harmless plural differences", () => {
    const spec = contract.ENTITY_SPECS.find((entry) => entry.id === entity);
    const result = context.inferIdentityConstraint({
      spec,
      definitions,
      records: [
        { poNumber: "PO-1", vendorName: "Gaurav Enterprises" },
        { poNumber: "PO-2", vendorName: "Another Supplier" },
      ],
      message: "any PO of gaurav enterprise?",
    });
    expect(result).toEqual(expect.objectContaining({
      found: true,
      ambiguous: false,
      value: "Gaurav Enterprises",
      definition: expect.objectContaining({ path: "vendorName" }),
    }));
  });

  test("identity inference is generated for every catalogued Store & Purchase identity field", () => {
    let checked = 0;
    for (const spec of contract.ENTITY_SPECS) {
      const ownDefinitions = contract.DEFINITIONS_BY_ENTITY[spec.id] || [];
      for (const path of spec.identityPaths) {
        const definition = ownDefinitions.find((candidate) => (
          candidate.path === path && candidate.valueType === "text"
        ));
        if (!definition) continue;
        const storedValue = `Example ${spec.id} Partners`;
        const askedValue = `Example ${spec.id} Partner`;
        const result = context.inferIdentityConstraint({
          spec,
          definitions: ownDefinitions,
          records: [recordWith(path, storedValue)],
          message: `show ${spec.label} for ${askedValue}`,
        });
        expect(result).toEqual(expect.objectContaining({
          found: true,
          ambiguous: false,
          value: storedValue,
          definition: expect.objectContaining({ id: definition.id }),
        }));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("every generated Store field is addressable through its declared output vocabulary", () => {
    let checked = 0;
    for (const spec of contract.ENTITY_SPECS) {
      for (const definition of contract.DEFINITIONS_BY_ENTITY[spec.id] || []) {
        const phrase = definition.aliases[0];
        const outputs = context.explicitOutputDefinitions(spec.id, `show ${phrase}`);
        expect(outputs.map((candidate) => candidate.id)).toContain(definition.id);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  test("every exposed enum accepts its natural spaced wording", () => {
    let checked = 0;
    for (const spec of contract.ENTITY_SPECS) {
      for (const definition of contract.DEFINITIONS_BY_ENTITY[spec.id] || []) {
        const values = (spec.model.schema.path(definition.path)?.enumValues || [])
          .filter((value) => value !== null && value !== undefined && String(value).trim());
        for (const value of values) {
          const natural = String(value).replace(/[_-]+/g, " ").toLowerCase();
          expect(context.filterMatches(
            recordWith(definition.path, value), definition, "equals", natural,
          )).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("every exposed enum overrides a wrong Qwen filter with the schema field and canonical value", () => {
    let checked = 0;
    for (const spec of contract.ENTITY_SPECS) {
      const ownDefinitions = contract.DEFINITIONS_BY_ENTITY[spec.id] || [];
      const wrong = ownDefinitions.find((definition) => definition.valueType === "text");
      if (!wrong) continue;
      for (const definition of ownDefinitions) {
        const values = (spec.model.schema.path(definition.path)?.enumValues || [])
          .filter((value) => value !== null && value !== undefined && String(value).trim());
        if (!values.length || definition.id === wrong.id) continue;
        const value = values[0];
        const natural = String(value).replace(/[_-]+/g, " ").toLowerCase();
        const message = `how many ${spec.label} with ${definition.aliases[0]} ${natural}`;
        const reconciled = context.reconcileArgs(spec.id, {
          operation: "count", metric: context.RECORDS,
          outputMetric2: context.NONE, outputMetric3: context.NONE,
          filterMetric: wrong.id, filterOperator: "equals",
          filterMetric2: context.NONE, filterOperator2: context.NONE,
          filterMetric3: context.NONE, filterOperator3: context.NONE,
          dateMetric: context.NONE,
        }, message);
        expect(reconciled.filterMetric).toBe(definition.id);
        expect(reconciled.filterValue).toBe(value);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  test("an explicit numeric field repairs a wrong Qwen filter and derives its grounded value", () => {
    const reconciled = context.reconcileArgs(entity, {
      operation: "count", metric: context.RECORDS,
      outputMetric2: context.NONE, outputMetric3: context.NONE,
      filterMetric: field("poNumber").id, filterOperator: "greater_than",
      filterMetric2: context.NONE, filterOperator2: context.NONE,
      filterMetric3: context.NONE, filterOperator3: context.NONE,
      dateMetric: context.NONE,
    }, "how many purchase orders with total amount over 10,000");
    expect(reconciled.filterMetric).toBe(field("totalAmount").id);
    expect(reconciled.filterOperator).toBe("greater_than");
    expect(reconciled.filterValue).toBe("10000");
  });

  test("every generated date field overrides a wrong Qwen date slot when explicitly named", () => {
    let checked = 0;
    for (const spec of contract.ENTITY_SPECS) {
      const dates = (contract.DEFINITIONS_BY_ENTITY[spec.id] || [])
        .filter((definition) => definition.valueType === "date_time");
      if (!dates.length) continue;
      for (const definition of dates) {
        const wrong = dates.find((candidate) => candidate.id !== definition.id)?.id || context.NONE;
        const message = `list ${spec.label} by ${definition.aliases[0]} in June 2026`;
        const reconciled = context.reconcileArgs(spec.id, {
          operation: "list", metric: context.RECORDS,
          outputMetric2: context.NONE, outputMetric3: context.NONE,
          filterMetric: context.NONE, filterOperator: context.NONE,
          filterMetric2: context.NONE, filterOperator2: context.NONE,
          filterMetric3: context.NONE, filterOperator3: context.NONE,
          dateMetric: wrong, from: "2026-06-01", to: "2026-06-30",
        }, message);
        expect(reconciled.dateMetric).toBe(definition.id);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("an ambiguous date range fails closed instead of trusting Qwen's date field", () => {
    const reconciled = context.reconcileArgs(entity, {
      operation: "count", metric: context.RECORDS,
      outputMetric2: context.NONE, outputMetric3: context.NONE,
      filterMetric: context.NONE, filterOperator: context.NONE,
      filterMetric2: context.NONE, filterOperator2: context.NONE,
      filterMetric3: context.NONE, filterOperator3: context.NONE,
      dateMetric: definitions.find((definition) => definition.valueType === "date_time").id,
      from: "2026-06-01", to: "2026-06-30",
    }, "how many purchase orders in June 2026");
    expect(reconciled.dateMetric).toBe(context.NONE);
    expect(context.validate({ entity, args: reconciled }).error).toMatch(/without a date field/i);
  });

  test("goods-receipt recorded wording uses the catalogued receipt business date", () => {
    const receiptDefinitions = contract.DEFINITIONS_BY_ENTITY.goods_receipt;
    const receiptDate = receiptDefinitions.find((definition) => definition.path === "receiptDate");
    const otherDate = receiptDefinitions.find((definition) => (
      definition.valueType === "date_time" && definition.id !== receiptDate.id
    ));
    expect(receiptDate.dateAliases).toContain("recorded");

    const reconciled = context.reconcileArgs("goods_receipt", {
      operation: "list", metric: context.RECORDS,
      outputMetric2: context.NONE, outputMetric3: context.NONE,
      filterMetric: context.NONE, filterOperator: context.NONE,
      filterMetric2: context.NONE, filterOperator2: context.NONE,
      filterMetric3: context.NONE, filterOperator3: context.NONE,
      dateMetric: otherDate.id,
      from: "2026-09-01", to: "2026-09-30",
    }, "list goods receipts recorded in september 2026");

    expect(reconciled.dateMetric).toBe(receiptDate.id);
    expect(context.validate({ entity: "goods_receipt", args: reconciled }).error).toBeUndefined();
  });

  test("equally strong authorised identity matches require clarification", () => {
    const spec = contract.ENTITY_SPECS.find((entry) => entry.id === entity);
    const result = context.inferIdentityConstraint({
      spec,
      definitions,
      records: [
        { poNumber: "PO-A", vendorName: "North Star Partners" },
        { poNumber: "PO-B", vendorName: "North Star Partner" },
      ],
      message: "any PO of North Star Partner?",
    });
    expect(result).toEqual(expect.objectContaining({ found: false, ambiguous: true }));
  });

  test("a wrong Qwen filter cannot broaden a supplier question to every purchase order", async () => {
    const companyId = new mongoose.Types.ObjectId();
    const createdBy = new mongoose.Types.ObjectId();
    await PurchaseOrder.create([
      { companyId, createdBy, poNumber: "PO-GAURAV-1", vendorName: "Gaurav Enterprises" },
      { companyId, createdBy, poNumber: "PO-GAURAV-2", vendorName: "Gaurav Enterprises" },
      { companyId, createdBy, poNumber: "PO-OTHER-1", vendorName: "Another Supplier" },
    ]);
    const poNumber = field("poNumber").id;
    const data = await context.queryCollection({
      entity,
      user: { storePurchaseAccess: { companyId, legacyMode: false } },
      message: "any po of gaurav enterprise?",
      // This reproduces the bad qwen3:32b plan: it selected PO number for
      // unrelated filters and supplied no grounded value.
      args: {
        operation: "count", metric: context.RECORDS,
        outputMetric2: poNumber, outputMetric3: poNumber,
        filterMetric: poNumber, filterOperator: "equals",
        filterMetric2: poNumber, filterOperator2: "equals",
        filterMetric3: poNumber, filterOperator3: "equals",
        dateMetric: context.NONE,
      },
    });
    expect(data).toEqual(expect.objectContaining({ ok: true, count: 2 }));
    expect(data.navigation.map((item) => item.label).sort()).toEqual(["PO-GAURAV-1", "PO-GAURAV-2"]);
  });

  test("an unresolved relational phrase fails closed instead of returning an unfiltered count", async () => {
    const companyId = new mongoose.Types.ObjectId();
    await PurchaseOrder.create({
      companyId, createdBy: new mongoose.Types.ObjectId(),
      poNumber: "PO-REAL-1", vendorName: "Recorded Supplier",
    });
    const data = await context.queryCollection({
      entity,
      user: { storePurchaseAccess: { companyId, legacyMode: false } },
      message: "any purchase order of made up supplier?",
      args: {
        operation: "count", metric: context.RECORDS,
        outputMetric2: context.NONE, outputMetric3: context.NONE,
        filterMetric: context.NONE, filterOperator: context.NONE,
        filterMetric2: context.NONE, filterOperator2: context.NONE,
        filterMetric3: context.NONE, filterOperator3: context.NONE,
        dateMetric: context.NONE,
      },
    });
    expect(data.ok).toBe(false);
    expect(data.reason).toMatch(/couldn't safely match/i);
    expect(data.count).toBeUndefined();
  });

  test("rendering reports bounded results as non-exact", () => {
    expect(context.renderCollectionQuery({ data: {
      ok: true, operation: "count", entityLabel: "purchase order", count: 2000, truncated: true,
    } })).toMatch(/2000 or more.*bounded inspected set/i);
  });
});
