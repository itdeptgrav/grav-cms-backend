"use strict";

jest.mock("../../services/salesCustomerContext", () => ({
  resolveCustomer: jest.fn(),
}));

const registry = require("../../services/ai/toolRegistry");
const context = require("../../services/salesCustomerContext");
const { compileFieldCoverageContract } = require("../../services/ai/fieldCoverageContract");

describe("Sales customer semantic and field contract", () => {
  beforeAll(() => {
    registry._clear();
    require("../../services/ai/tools/salesTools");
  });

  beforeEach(() => context.resolveCustomer.mockReset());

  test("an explicitly typed customer request claims one closed field without model selection", async () => {
    const tool = registry.getTool("sales_customer_metric");
    expect(tool.application).toBe("sales");
    expect(tool.modelSelectable).toBe(false);
    await expect(tool.claim({
      user: {},
      message: "what is Acme customer's email?",
      history: [],
    })).resolves.toEqual({ metric: "customer.email" });
    expect(context.resolveCustomer).not.toHaveBeenCalled();
  });

  test("an untyped name is claimed only after a real customer identity resolves", async () => {
    const tool = registry.getTool("sales_customer_metric");
    context.resolveCustomer.mockResolvedValueOnce({ found: true, ambiguous: false, record: { name: "Acme" } });
    await expect(tool.claim({ user: {}, message: "Acme email", history: [] }))
      .resolves.toEqual({ metric: "customer.email" });
    context.resolveCustomer.mockResolvedValueOnce({ found: false, ambiguous: false, matches: [] });
    await expect(tool.claim({ user: {}, message: "Arpita email", history: [] })).resolves.toBeNull();
  });

  test("the deterministic renderer returns only the requested field", async () => {
    const tool = registry.getTool("sales_customer_metric");
    context.resolveCustomer.mockResolvedValue({
      found: true,
      ambiguous: false,
      record: {
        name: "Acme Retail",
        email: "buyer@acme.example",
        phone: "9999999999",
        gstNumber: "29ABCDE1234F1Z5",
      },
    });
    const args = { metric: "customer.email" };
    const data = await tool.provideContext({ user: {}, message: "Acme customer email", args });
    const answer = tool.renderAnswer({ data, args });
    expect(answer).toBe("Acme Retail's customer email is buyer@acme.example.");
    expect(answer).not.toContain("9999999999");
    expect(answer).not.toContain("29ABCDE1234F1Z5");
  });

  test("ambiguous customer identity asks for the business ID", async () => {
    const tool = registry.getTool("sales_customer_metric");
    context.resolveCustomer.mockResolvedValue({
      found: false,
      ambiguous: true,
      matches: [
        { name: "Acme North", customerId: "CUST-001" },
        { name: "Acme South", customerId: "CUST-002" },
      ],
    });
    const data = await tool.provideContext({
      user: {}, message: "Acme customer phone", args: { metric: "customer.phone" },
    });
    expect(tool.renderAnswer({ data })).toMatch(/more than one customer.*CUST-001.*CUST-002.*customer ID/i);
  });

  test("the generic field compiler fails new unclassified paths and exposed secrets", () => {
    const contract = compileFieldCoverageContract({
      id: "test.contract",
      schemaPaths: ["name", "newField", "password"],
      exposed: [
        { id: "thing.name", label: "Name", valueType: "text", path: "name" },
        { id: "thing.password", label: "Password", valueType: "text", path: "password" },
      ],
      excluded: {},
    });
    expect(contract.audit()).toEqual(expect.objectContaining({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ type: "unclassified_source_field", path: "newField" }),
        expect.objectContaining({ type: "secret_field_exposed", path: "password" }),
      ]),
    }));
  });

  test("a projection view classifies only its declared shared-model read boundary", () => {
    const contract = compileFieldCoverageContract({
      id: "test.projection",
      coverageMode: "projection_view",
      sourceModels: ["models/Shared.js"],
      schemaPaths: ["name", "status", "unrelatedLargeSubtree.secretNote"],
      projectionPaths: ["name", "status"],
      exposed: [{ id: "thing.name", label: "Name", valueType: "text", path: "name" }],
      excluded: { status: "Not required by this read view." },
    });
    expect(contract.audit()).toEqual(expect.objectContaining({
      ok: true,
      coverageMode: "projection_view",
      schemaFieldCount: 3,
      classifiedFieldCount: 2,
      exposedFieldCount: 1,
      excludedFieldCount: 1,
    }));
  });
});
