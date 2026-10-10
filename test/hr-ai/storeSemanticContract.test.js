"use strict";

jest.mock("../../services/storeAssistantContext", () => ({
  hintedEntity: jest.fn(),
  resolveRecord: jest.fn(),
  resolveAnyRecord: jest.fn(),
  resolveIssuance: jest.fn(),
  loadSettings: jest.fn(),
  nextNumber: jest.fn(),
  loadPurchaseOrders: jest.fn(),
  loadWorkerWorkOrders: jest.fn(),
  loadOrderRequests: jest.fn(),
  statusStats: jest.fn(),
  pathValues: jest.requireActual("../../services/storeAssistantContext").pathValues,
  workOrdersForRequest: jest.fn(),
  materialRequirements: jest.fn(),
  issuanceProgress: jest.fn(),
  loadVendors: jest.fn(),
  loadWorkers: jest.fn(),
  resolveParty: jest.fn(),
}));

const registry = require("../../services/ai/toolRegistry");
const context = require("../../services/storeAssistantContext");
const { CATALOGUE } = require("../../services/storeSemanticContract");
const { CONTRACTS } = require("../../services/storeApplicationFieldContracts");

describe("Store entity-first semantic contract", () => {
  beforeAll(() => {
    registry._clear();
    require("../../services/ai/tools/storeTools");
  });

  beforeEach(() => jest.clearAllMocks());

  test("all 154 exposed Store paths have an addressable semantic concept", () => {
    const exposed = CONTRACTS.flatMap((contract) => Object.values(contract.exposed));
    expect(exposed).toHaveLength(154);
    for (const field of exposed) expect(CATALOGUE.metrics[field.id]).toBeDefined();
    expect(CATALOGUE.audit()).toEqual(expect.objectContaining({ ok: true, issues: [] }));
  });

  test("the same phrase resolves only after the record entity is known", async () => {
    const tool = registry.getTool("store_metric");
    context.hintedEntity.mockReturnValue(null);
    context.resolveAnyRecord
      .mockResolvedValueOnce({ entity: "purchase_order", resolution: { found: true, identity: "PO-100" } })
      .mockResolvedValueOnce({ entity: "worker_work_order", resolution: { found: true, identity: "WO-9" } });

    await expect(tool.claim({ message: "status of PO-100" }))
      .resolves.toEqual({ metric: "store.purchase_order.status" });
    await expect(tool.claim({ message: "status of WO-9" }))
      .resolves.toEqual({ metric: "store.worker_work_order.status" });
  });

  test("specific PO concepts route without exposing a physical field parameter to Qwen", async () => {
    const tool = registry.getTool("store_metric");
    expect(tool.modelSelectable).toBe(true);
    expect(Object.keys(tool.parameters.properties)).toEqual(["metric"]);
    expect(tool.parameters.properties.metric.enum).toContain("store.purchase_order.vendorPhone");
    expect(JSON.stringify(tool.parameters)).not.toMatch(/vendorPhone.*path|database|collection/i);
    context.hintedEntity.mockReturnValue("purchase_order");
    context.resolveAnyRecord.mockResolvedValue({
      entity: "purchase_order", resolution: { found: true, identity: "PO-100" },
    });
    await expect(tool.claim({ message: "vendor phone for PO-100" }))
      .resolves.toEqual({ metric: "store.purchase_order.vendorPhone" });
    await expect(tool.claim({ message: "total amount of PO-100" }))
      .resolves.toEqual({ metric: "store.purchase_order.grandTotal" });
  });

  test("a model-selected concept cannot cross the independently resolved entity boundary", async () => {
    const tool = registry.getTool("store_metric");
    context.resolveAnyRecord.mockResolvedValue({
      entity: "worker_work_order", resolution: { found: true, identity: "WO-9" },
    });
    const data = await tool.provideContext({
      message: "how far along is WO-9?",
      args: { metric: "store.purchase_order.status" },
    });
    expect(data.resolution).toEqual({ found: false });
    expect(context.resolveRecord).not.toHaveBeenCalled();
  });

  test("derived Store operations are typed concepts, not model arithmetic", async () => {
    const tool = registry.getTool("store_metric");
    context.hintedEntity.mockReturnValue("order_request");
    context.resolveAnyRecord.mockResolvedValue({
      entity: "order_request", resolution: { found: true, identity: "CR-1" },
    });
    await expect(tool.claim({ message: "raw material shortfalls for order request CR-1" }))
      .resolves.toEqual({ metric: "store.order_request_material_shortfalls" });
    await expect(tool.claim({ message: "issuance progress for order request CR-1" }))
      .resolves.toEqual({ metric: "store.order_request_issuance_progress" });
  });

  test("the renderer returns only the requested field", async () => {
    const tool = registry.getTool("store_metric");
    context.resolveAnyRecord.mockResolvedValue({
      entity: "purchase_order", resolution: { found: true, identity: "PO-100" },
    });
    context.resolveRecord.mockResolvedValue({
      found: true,
      identity: "PO-100",
      record: { poNumber: "PO-100", vendorPhone: "9999999999", vendorAddress: "Hidden address", grandTotal: 12500 },
    });
    const args = { metric: "store.purchase_order.vendorPhone" };
    const data = await tool.provideContext({ message: "vendor phone PO-100", args });
    const answer = tool.renderAnswer({ data });
    expect(answer).toContain("9999999999");
    expect(answer).not.toContain("Hidden address");
    expect(answer).not.toContain("12,500");
  });

  test("sensitive worker payment identifiers cannot be selected", () => {
    const workerMetricIds = Object.keys(CATALOGUE.metrics).filter((id) => id.startsWith("store.worker_work_order."));
    expect(workerMetricIds.join(" ")).not.toMatch(/paymentUpiId|paymentAccountNumber|paymentIfscCode|paymentChequeNumber|documents_url/i);
  });

  test("missing and ambiguous identities fail closed", async () => {
    const tool = registry.getTool("store_metric");
    context.hintedEntity.mockReturnValue(null);
    context.resolveAnyRecord.mockResolvedValueOnce({ found: false });
    await expect(tool.claim({ message: "status of unknown order" })).resolves.toBeNull();
    context.resolveAnyRecord.mockResolvedValueOnce({ ambiguous: true, matches: ["purchase_order:X", "worker_work_order:X"] });
    await expect(tool.claim({ message: "status of X" })).resolves.toBeNull();
  });

  test("Store reads require the database-verified Store application grant", () => {
    const tool = registry.getTool("store_metric");
    expect(tool.application).toBe("store");
    expect(tool.permission({
      id: "employee",
      applicationAccess: { store: { allowed: true, capabilities: { read: true } } },
    })).toBe(true);
    expect(tool.permission({
      id: "employee",
      applicationAccess: { store: { allowed: true, capabilities: { read: false } } },
    })).toBe(false);
    expect(tool.permission({ id: "employee", applicationAccess: { store: { allowed: false } } })).toBe(false);
    expect(tool.permission({ id: "employee" })).toBe(false);
    expect(tool.permission({})).toBe(false);
  });
});
