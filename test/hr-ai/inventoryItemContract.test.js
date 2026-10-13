"use strict";

jest.mock("../../services/inventoryItemContext", () => ({
  resolveInventoryItem: jest.fn(),
}));
jest.mock("../../services/inventoryLocationContext", () => ({
  buildInventoryLocationContext: jest.fn(),
}));

const registry = require("../../services/ai/toolRegistry");
const context = require("../../services/inventoryItemContext");
const locationContext = require("../../services/inventoryLocationContext");

describe("Inventory raw-item semantic and field contract", () => {
  beforeAll(() => {
    registry._clear();
    require("../../services/ai/tools/inventoryTools");
  });

  beforeEach(() => {
    context.resolveInventoryItem.mockReset();
    locationContext.buildInventoryLocationContext.mockReset();
    locationContext.buildInventoryLocationContext.mockImplementation(async ({ recognizedSubject }) => ({
      located: Number(recognizedSubject?.record?.quantity || 0),
      unit: recognizedSubject?.record?.customUnit || recognizedSubject?.record?.unit || "",
    }));
  });

  test("an explicitly typed item request claims one closed field without model selection", async () => {
    const tool = registry.getTool("inventory_item_metric");
    expect(tool.application).toBe("store_purchase");
    expect(tool.modelSelectable).toBe(true);
    await expect(tool.claim({
      user: {}, message: "what is this raw item's quantity on hand?", history: [],
    })).resolves.toEqual({ metric: "item.physical_quantity" });
    expect(context.resolveInventoryItem).not.toHaveBeenCalled();
  });

  test("an exact item identity is recognised before application-name fallbacks", async () => {
    const tool = registry.getTool("inventory_item_metric");
    const resolution = {
      found: true,
      ambiguous: false,
      record: { name: "1 Way Metal MCB Board", quantity: 2 },
    };
    context.resolveInventoryItem.mockResolvedValueOnce(resolution);
    await expect(tool.recognizeSubject({
      user: {}, message: "how much do we physically have of 1 Way Metal MCB Board?",
    })).resolves.toEqual(resolution);
  });

  test("a recognised item resolution is reused and not exposed to model planning", async () => {
    const tool = registry.getTool("inventory_item_metric");
    const recognizedSubject = {
      found: true,
      ambiguous: false,
      record: { name: "1 Way Metal MCB Board", quantity: 2 },
    };
    const data = await tool.provideContext({
      user: {},
      message: "stock of 1 Way Metal MCB Board",
      args: { metric: "item.physical_quantity" },
      recognizedSubject,
    });
    expect(data.item).toBe(recognizedSubject);
    expect(context.resolveInventoryItem).not.toHaveBeenCalled();
    expect(tool.renderAnswer({ data })).toBe("1 Way Metal MCB Board's physical quantity on hand is 2.");
  });

  test("an untyped name is claimed only after a real item identity resolves", async () => {
    const tool = registry.getTool("inventory_item_metric");
    context.resolveInventoryItem.mockResolvedValueOnce({ found: true, ambiguous: false, record: { name: "Cotton" } });
    await expect(tool.claim({ user: {}, message: "Cotton quantity", history: [] }))
      .resolves.toEqual({ metric: "item.physical_quantity" });
    context.resolveInventoryItem.mockResolvedValueOnce({ found: false, ambiguous: false, matches: [] });
    await expect(tool.claim({ user: {}, message: "Unknown quantity", history: [] })).resolves.toBeNull();
  });

  test("the canonical stock wording resolves to physical quantity for a named item", async () => {
    const tool = registry.getTool("inventory_item_metric");
    context.resolveInventoryItem.mockResolvedValueOnce({
      found: true,
      ambiguous: false,
      record: { name: "1 Way Metal MCB Board", quantity: 2 },
    });
    await expect(tool.claim({
      user: {}, message: "stock of 1 Way Metal MCB Board", history: [],
    })).resolves.toEqual({ metric: "item.physical_quantity" });
  });

  test("the deterministic renderer returns only the requested item field", async () => {
    const tool = registry.getTool("inventory_item_metric");
    context.resolveInventoryItem.mockResolvedValue({
      found: true,
      ambiguous: false,
      record: {
        name: "Cotton Fabric",
        sku: "RAW-COT-001",
        quantity: 125,
        minStock: 20,
        notes: "Restricted operational note",
      },
    });
    const args = { metric: "item.physical_quantity" };
    const data = await tool.provideContext({ user: {}, message: "Cotton Fabric quantity", args });
    const answer = tool.renderAnswer({ data, args });
    expect(answer).toBe("Cotton Fabric's physical quantity on hand is 125.");
    expect(answer).not.toContain("RAW-COT-001");
    expect(answer).not.toContain("20");
    expect(answer).not.toContain("Restricted");
  });

  test("stock answers expose a master-to-location conflict instead of choosing a false value", async () => {
    const tool = registry.getTool("inventory_item_metric");
    const recognizedSubject = {
      found: true,
      ambiguous: false,
      record: { name: "Apple MacBook Air", quantity: 0, unit: "Pcs" },
    };
    locationContext.buildInventoryLocationContext.mockResolvedValueOnce({ located: 45, unit: "Pcs" });
    const data = await tool.provideContext({
      user: {},
      message: "stock of Apple MacBook Air",
      args: { metric: "item.physical_quantity" },
      recognizedSubject,
    });
    expect(tool.renderAnswer({ data })).toBe(
      "Apple MacBook Air's item master records 0 Pcs on hand, while its physical locations record 45 Pcs. The stock records conflict and need reconciliation.",
    );
  });

  test("ambiguous item identity asks for the SKU", async () => {
    const tool = registry.getTool("inventory_item_metric");
    context.resolveInventoryItem.mockResolvedValue({
      found: false,
      ambiguous: true,
      matches: [
        { name: "Cotton", sku: "RAW-001" },
        { name: "Cotton", sku: "RAW-002" },
      ],
    });
    const data = await tool.provideContext({
      user: {}, message: "Cotton quantity", args: { metric: "item.physical_quantity" },
    });
    expect(tool.renderAnswer({ data })).toMatch(/more than one inventory item.*RAW-001.*RAW-002.*choose/i);
  });

  test("a partial-name suggestion asks the user to choose", async () => {
    const tool = registry.getTool("inventory_item_metric");
    context.resolveInventoryItem.mockResolvedValue({
      found: false,
      ambiguous: true,
      suggested: true,
      matches: [{
        _id: "507f1f77bcf86cd799439011",
        name: "Apple MacBook Air 2022 A2681 (8GB 256 GB)",
        sku: "RAW-LAP-APPMACAIR2022A2681",
      }],
    });
    const data = await tool.provideContext({
      user: {}, message: "stock of macbook?", args: { metric: "item.physical_quantity" },
    });
    expect(tool.renderAnswer({ data })).toMatch(/couldn't match one.*choose the intended item below.*MacBook/i);
    expect(tool.buildChoices({ data })).toEqual([{
      label: "Apple MacBook Air 2022 A2681 (8GB 256 GB) (RAW-LAP-APPMACAIR2022A2681)",
      prompt: "stock of Apple MacBook Air 2022 A2681 (8GB 256 GB)",
      /* ── AND THE RECORD'S CANONICAL ID ─────────────────────────────
           `prompt` is how the CHAT follows up: it asks the question again
           with the item named, which works in a conversation read by the
           same resolver. The command palette cannot work that way —
           re-searching a longer phrase is a second guess at the same
           ambiguous words, and an item whose name is contained in
           another's could never be picked. So a choice also carries the id
           of the record it stands for, and the palette resolves BY that. */
      recordId: "507f1f77bcf86cd799439011",
      kind: "prompt",
    }]);
    expect(tool.buildLinks({ data })).toEqual([]);
  });

  test("read permission comes only from the database-resolved Store capability", () => {
    const tool = registry.getTool("inventory_item_metric");
    expect(tool.permission({ storePurchaseAccess: { capabilitySet: new Set(["sp.read"]) } })).toBe(true);
    expect(tool.permission({ storePurchaseAccess: { capabilitySet: new Set() } })).toBe(false);
    expect(tool.permission({})).toBe(false);
  });
});
