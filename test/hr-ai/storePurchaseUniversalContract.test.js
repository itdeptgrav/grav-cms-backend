"use strict";

const contract = require("../../services/storePurchaseUniversalContract");
const {
  valuesAtPath, scopeFor, isImplicitlyRecognisable,
} = require("../../services/storePurchaseUniversalContext");
const registry = require("../../services/ai/toolRegistry");

require("../../services/ai/tools/storePurchaseUniversalTools");

describe("schema-driven Store & Purchase assistant contract", () => {
  test("every source entity has a non-empty, fully classified field contract", () => {
    // The assertion follows the generated source list so adding a Store UI
    // source cannot be hidden behind a stale magic count.
    expect(contract.ENTITY_SPECS.length).toBeGreaterThanOrEqual(53);
    expect(contract.CONTRACTS).toHaveLength(contract.ENTITY_SPECS.length);
    for (const fieldContract of contract.CONTRACTS) {
      const report = fieldContract.audit();
      expect(report.schemaFieldCount).toBeGreaterThan(0);
      expect(report.classifiedFieldCount).toBe(report.schemaFieldCount);
      expect(report.exposedFieldCount + report.excludedFieldCount).toBe(report.schemaFieldCount);
      expect(report).toMatchObject({ ok: true, issues: [] });
    }
  });

  test("every exposed field has a typed semantic concept and an entity tool", () => {
    expect(contract.CATALOGUE.audit()).toMatchObject({ ok: true, issues: [] });
    expect(contract.DEFINITIONS.length).toBeGreaterThan(1200);
    for (const entity of contract.ENTITY_SPECS) {
      const definitions = contract.DEFINITIONS_BY_ENTITY[entity.id];
      expect(definitions.length).toBeGreaterThan(0);
      if (entity.collectionOnly) expect(registry.getTool(`store_record_${entity.id}_field`)).toBeFalsy();
      else expect(registry.getTool(`store_record_${entity.id}_field`)).toBeTruthy();
      for (const definition of definitions) {
        expect(contract.metric(definition.id)).toEqual(definition);
        expect(definition).toEqual(expect.objectContaining({
          path: expect.any(String),
          label: expect.any(String),
          valueType: expect.any(String),
          entity: entity.id,
          domain: entity.id,
        }));
      }
    }
  });

  test("security, tenancy, internal ids and unbounded payloads are never exposed", () => {
    const forbidden = /(^|\.)(_id|__v|companyId|siteId|password|secret|token|idempotencyKey|operationKey|requestHash|payload|metadata)(\.|$)/i;
    for (const fieldContract of contract.CONTRACTS) {
      for (const path of Object.keys(fieldContract.exposed)) expect(path).not.toMatch(forbidden);
      for (const [path, reason] of Object.entries(fieldContract.excluded)) {
        expect(reason).toEqual(expect.any(String));
        expect(reason.length).toBeGreaterThan(8);
        expect(fieldContract.exposed[path]).toBeUndefined();
      }
    }
  });

  test("nested and array values are projected without giving Qwen a raw document", () => {
    const record = {
      lines: [
        { item: { name: "Cotton", quantity: 4 } },
        { item: { name: "Linen", quantity: 2 } },
      ],
    };
    expect(valuesAtPath(record, "lines.item.name")).toEqual(["Cotton", "Linen"]);
    expect(valuesAtPath(record, "lines.item.quantity")).toEqual([4, 2]);
    expect(valuesAtPath(record, "lines.missing")).toEqual([]);
  });

  test("company-owned models fail closed without a proven Store tenant", () => {
    const purchaseOrder = contract.ENTITY_SPECS.find((entry) => entry.id === "purchase_order");
    const settings = contract.ENTITY_SPECS.find((entry) => entry.id === "sales_settings");
    expect(scopeFor(purchaseOrder, {})).toBeNull();
    expect(scopeFor(settings, {})).toEqual({});
  });

  test("singleton settings never masquerade as an implicitly named record", () => {
    const singletonSpecs = contract.ENTITY_SPECS.filter((entry) => entry.singleton);
    expect(singletonSpecs.length).toBeGreaterThan(0);
    expect(singletonSpecs.every((entry) => isImplicitlyRecognisable(entry) === false)).toBe(true);
    expect(isImplicitlyRecognisable({ id: "purchase_order", singleton: false })).toBe(true);
  });

  test("history categorical fields are queryable but never record identities", () => {
    const history = contract.ENTITY_SPECS.find((entry) => entry.id === "store_action_history");
    expect(history.identityPaths).toEqual(["documentNumber"]);
    const exposedPaths = Object.keys(contract.CONTRACTS
      .find((entry) => entry.id === "store_purchase.schema.store_action_history").exposed);
    expect(exposedPaths).toEqual(expect.arrayContaining(["entityType", "action", "actorName"]));
  });

  test("plural entity wording is generated for every schema entity", () => {
    const purchaseOrder = contract.ENTITY_SPECS.find((entry) => entry.id === "purchase_order");
    const history = contract.ENTITY_SPECS.find((entry) => entry.id === "store_action_history");
    expect(purchaseOrder.aliases).toContain("purchase orders");
    expect(history.aliases).toContain("Store action histories");
  });
});
