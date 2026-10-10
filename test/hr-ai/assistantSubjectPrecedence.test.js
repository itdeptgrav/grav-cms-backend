"use strict";

jest.mock("../../services/inventoryItemContext", () => ({
  resolveInventoryItem: jest.fn(),
}));

jest.mock("../../services/ollamaClient", () => ({
  chatJson: jest.fn(),
}));

jest.mock("../../services/hrOverviewContext", () => ({
  buildHrOverviewContext: jest.fn(),
}));

jest.mock("../../services/dailyAttendanceContext", () => ({
  buildDailyAttendanceContext: jest.fn(),
}));

jest.mock("../../services/access/appAccess.service", () => ({
  resolveAppAccess: jest.fn().mockResolvedValue({
    allowed: false,
    capabilities: null,
    denialCode: "NO_ACCESS",
  }),
}));

const { CAPABILITIES } = require("../../services/storePurchase/capabilities");
const inventoryContext = require("../../services/inventoryItemContext");
const { chatJson } = require("../../services/ollamaClient");
const assistant = require("../../services/ai/gravAssistant");

const user = () => ({
  id: "assistant-subject-test",
  email: "store@example.test",
  hrAccess: { allowed: false, via: null },
  hrActor: { capabilities: new Set(), hasHrApplicationAccess: false, template: null },
  accountingAccess: { allowed: false, via: null },
  storePurchaseAccess: {
    companyId: "company-1",
    capabilities: [CAPABILITIES.READ],
    capabilitySet: new Set([CAPABILITIES.READ]),
  },
  applicationAccess: {},
});

describe("assistant exact-subject routing precedence", () => {
  beforeEach(() => {
    inventoryContext.resolveInventoryItem.mockReset();
    chatJson.mockReset();
  });

  test("a verified material containing an application word outranks the coverage fallback", async () => {
    inventoryContext.resolveInventoryItem.mockResolvedValue({
      found: true,
      ambiguous: false,
      record: { name: "1 Way Metal MCB Board", quantity: 2 },
    });
    chatJson.mockImplementation(async ({ schema }) => {
      if (schema?.properties?.choice) {
        expect(schema.properties.choice.enum).toContain("inventory_item_metric");
        return { model: "qwen-test", data: { choice: "inventory_item_metric", clarification: null } };
      }
      if (schema?.properties?.metric) {
        return { model: "qwen-test", data: { metric: "item.physical_quantity" } };
      }
      throw new Error("Unexpected model call");
    });

    const result = await assistant.chat({
      user: user(),
      message: "how much do we physically have of 1 Way Metal MCB Board?",
    });

    expect(result.reply).toBe("1 Way Metal MCB Board's physical quantity on hand is 2.");
    expect(result.toolsUsed).toEqual(["inventory_item_metric"]);
    expect(result.contextState.selection).toBe("catalogue_claim");
    expect(result.contextState.selection).not.toBe("coverage_boundary");
    expect(chatJson).not.toHaveBeenCalled();
    // Both the item-master and physical-location families explicitly recognise
    // this physical-stock wording. Unrelated record families are filtered out.
    expect(inventoryContext.resolveInventoryItem).toHaveBeenCalledTimes(2);
  });

  test("an actual uncatalogued Board-app request still stops at the coverage boundary", async () => {
    inventoryContext.resolveInventoryItem.mockResolvedValue({
      found: false,
      ambiguous: false,
      matches: [],
    });

    const result = await assistant.chat({ user: user(), message: "show the Board overview" });

    expect(result.reply).toMatch(/verified CMS data yet/i);
    expect(result.reply).toMatch(/board/i);
    expect(result.contextState.selection).toBe("coverage_boundary");
    expect(chatJson).not.toHaveBeenCalled();
    expect(inventoryContext.resolveInventoryItem).not.toHaveBeenCalled();
  });
});
