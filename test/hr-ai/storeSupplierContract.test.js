"use strict";

jest.mock("../../services/storeSupplierContext", () => ({
  resolveSupplier: jest.fn(),
}));

const registry = require("../../services/ai/toolRegistry");
const context = require("../../services/storeSupplierContext");

describe("Store & Purchase supplier semantic and field contract", () => {
  beforeAll(() => {
    registry._clear();
    require("../../services/ai/tools/storePurchaseTools");
  });

  beforeEach(() => context.resolveSupplier.mockReset());

  test("an explicitly typed supplier request claims one closed field while unseen paraphrases remain model-selectable", async () => {
    const tool = registry.getTool("store_supplier_metric");
    expect(tool.application).toBe("store_purchase");
    expect(tool.modelSelectable).toBe(true);
    await expect(tool.claim({
      user: {}, message: "what is Acme supplier's GSTIN?", history: [],
    })).resolves.toEqual({ metric: "supplier.gstin" });
    expect(context.resolveSupplier).not.toHaveBeenCalled();
  });

  test("Qwen eligibility still depends on a server-resolved supplier identity", async () => {
    const tool = registry.getTool("store_supplier_metric");
    const resolution = { found: true, ambiguous: false, record: { companyName: "Acme" } };
    context.resolveSupplier.mockResolvedValue(resolution);
    await expect(tool.recognizeSubject({ user: {}, message: "how can I reach Acme?" }))
      .resolves.toBe(resolution);
  });

  test("an untyped name is claimed only after a real supplier identity resolves", async () => {
    const tool = registry.getTool("store_supplier_metric");
    context.resolveSupplier.mockResolvedValueOnce({ found: true, ambiguous: false, record: { companyName: "Acme" } });
    await expect(tool.claim({ user: {}, message: "Acme phone", history: [] }))
      .resolves.toEqual({ metric: "supplier.phone" });
    context.resolveSupplier.mockResolvedValueOnce({ found: false, ambiguous: false, matches: [] });
    await expect(tool.claim({ user: {}, message: "Unknown phone", history: [] })).resolves.toBeNull();
  });

  test("the deterministic renderer returns only the requested supplier field", async () => {
    const tool = registry.getTool("store_supplier_metric");
    context.resolveSupplier.mockResolvedValue({
      found: true,
      ambiguous: false,
      record: {
        companyName: "Acme Textiles",
        email: "vendor@acme.example",
        phone: "9999999999",
        gstNumber: "29ABCDE1234F1Z5",
      },
    });
    const args = { metric: "supplier.email" };
    const data = await tool.provideContext({ user: {}, message: "Acme supplier email", args });
    const answer = tool.renderAnswer({ data, args });
    expect(answer).toBe("Acme Textiles's supplier email is vendor@acme.example.");
    expect(answer).not.toContain("9999999999");
    expect(answer).not.toContain("29ABCDE1234F1Z5");
  });

  test("ambiguous supplier identity asks for the business code", async () => {
    const tool = registry.getTool("store_supplier_metric");
    context.resolveSupplier.mockResolvedValue({
      found: false,
      ambiguous: true,
      matches: [
        { companyName: "Acme North", supplierCode: "SUP-001" },
        { companyName: "Acme South", supplierCode: "SUP-002" },
      ],
    });
    const data = await tool.provideContext({
      user: {}, message: "Acme supplier phone", args: { metric: "supplier.phone" },
    });
    expect(tool.renderAnswer({ data })).toMatch(/more than one supplier.*SUP-001.*SUP-002.*supplier code/i);
  });

  test("read permission comes only from the database-resolved Store capability", () => {
    const tool = registry.getTool("store_supplier_metric");
    expect(tool.permission({ storePurchaseAccess: { capabilitySet: new Set(["sp.read"]) } })).toBe(true);
    expect(tool.permission({ storePurchaseAccess: { capabilitySet: new Set() } })).toBe(false);
    expect(tool.permission({})).toBe(false);
  });
});
