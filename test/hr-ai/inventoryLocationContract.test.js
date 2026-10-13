"use strict";

jest.mock("../../services/inventoryItemContext", () => ({
  resolveInventoryItem: jest.fn(),
}));

jest.mock("../../services/inventoryLocationContext", () => ({
  buildInventoryLocationContext: jest.fn(),
}));

const registry = require("../../services/ai/toolRegistry");
const itemContext = require("../../services/inventoryItemContext");
const locationContext = require("../../services/inventoryLocationContext");
const {
  CATALOGUE,
  LOCATION_BALANCE_FIELD_CONTRACT,
  WAREHOUSE_LOCATION_FIELD_CONTRACT,
} = require("../../services/inventoryLocationContract");

describe("Inventory physical-location semantic contract", () => {
  beforeAll(() => {
    registry._clear();
    require("../../services/ai/tools/inventoryTools");
  });

  beforeEach(() => {
    itemContext.resolveInventoryItem.mockReset();
    locationContext.buildInventoryLocationContext.mockReset();
  });

  test("catalogue and both source-field contracts audit cleanly", () => {
    expect(CATALOGUE.audit()).toMatchObject({ ok: true, metricCount: 4 });
    expect(LOCATION_BALANCE_FIELD_CONTRACT.audit()).toMatchObject({ ok: true });
    expect(WAREHOUSE_LOCATION_FIELD_CONTRACT.audit()).toMatchObject({ ok: true });
  });

  test("warehouse projection retains the internal location join key without exposing it to Qwen", () => {
    expect(WAREHOUSE_LOCATION_FIELD_CONTRACT.classifiedPaths).toContain("locations._id");
    expect(WAREHOUSE_LOCATION_FIELD_CONTRACT.excluded["locations._id"]).toMatch(/internal join key/i);
    expect(WAREHOUSE_LOCATION_FIELD_CONTRACT.exposed["locations._id"]).toBeUndefined();
  });

  test("where is a named item kept claims the location capability, not stock status", async () => {
    const tool = registry.getTool("inventory_location_metric");
    itemContext.resolveInventoryItem.mockResolvedValue({
      found: true,
      ambiguous: false,
      record: { name: "SODIUM", sku: "RAW-SODIUM" },
    });
    await expect(tool.claim({ user: {}, message: "where is sodium kept?", history: [] }))
      .resolves.toEqual({ metric: "item.locations" });
  });

  test("the renderer returns every verified position and allocation fact", () => {
    const tool = registry.getTool("inventory_location_metric");
    const reply = tool.renderAnswer({
      data: {
        definition: CATALOGUE.metrics["item.locations"],
        item: { found: true, record: { name: "SODIUM" } },
        unit: "Kilogram",
        onHand: 20,
        located: 20,
        unallocated: 0,
        positions: [{ address: "Main Store › Rack R01 › Shelf Level 1 · Bay 1", variant: "", onHand: 20 }],
      },
    });
    expect(reply).toBe("SODIUM is kept at Main Store › Rack R01 › Shelf Level 1 · Bay 1: 20 Kilogram.");
    expect(reply).not.toMatch(/stock status/i);
  });

  test("an elliptical rack follow-up can reuse the prior validated item subject", async () => {
    const tool = registry.getTool("inventory_location_metric");
    const resolution = { found: true, inherited: true, record: { name: "SODIUM", sku: "RAW-SODIUM" } };
    itemContext.resolveInventoryItem.mockResolvedValue(resolution);
    const history = [{
      role: "assistant",
      content: "SODIUM is kept at Main Store.",
      contextState: { subject: { type: "inventory_item", name: "SODIUM", sku: "RAW-SODIUM" } },
    }];
    await expect(tool.recognizeSubject({ user: {}, message: "which rack?", history })).resolves.toBe(resolution);
    expect(itemContext.resolveInventoryItem).toHaveBeenCalledWith({ user: {}, message: "which rack?", history });
  });

  test("read permission still comes only from the resolved Store capability", () => {
    const tool = registry.getTool("inventory_location_metric");
    expect(tool.permission({ storePurchaseAccess: { capabilitySet: new Set(["sp.read"]) } })).toBe(true);
    expect(tool.permission({ storePurchaseAccess: { capabilitySet: new Set() } })).toBe(false);
  });
});
