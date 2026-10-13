"use strict";

const receive = require("../../services/storePurchase/receiveWorkspace.service");
const assistant = require("../../services/receiveWorkspaceAssistantContext");
const registry = require("../../services/ai/toolRegistry");

const user = {
  storePurchaseAccess: {
    companyId: "company-1",
    actorId: "employee-1",
    capabilitySet: new Set(["sp.read"]),
  },
};

describe("Store receiving assistant collection queries", () => {
  afterEach(() => jest.restoreAllMocks());

  test("a month-filtered expected-arrival question queries both authoritative expected sources", async () => {
    const purchase = jest.spyOn(receive, "readExpectedPurchased").mockResolvedValue({
      rows: [{ reference: "PO-JUNE", stage: "expected", expectedDate: "2026-06-12T00:00:00.000Z" }],
      coverage: { scannedCount: 1, storedMatchCount: 1, truncated: false },
    });
    const customer = jest.spyOn(receive, "readExpectedCustomer").mockResolvedValue({
      rows: [], coverage: { scannedCount: 0, storedMatchCount: 0, truncated: false },
    });
    const recorded = jest.spyOn(receive, "readRecordedReceipts").mockResolvedValue({ rows: [], coverage: {} });

    const result = await assistant.queryReceiveWorkspace({
      user,
      args: {
        operation: "exists", stage: "expected", source: "all", dateBasis: "expected_date",
        from: "2026-06-01", to: "2026-06-30",
      },
    });

    expect(result).toMatchObject({ ok: true, matchingCount: 1, truncated: false });
    expect(purchase).toHaveBeenCalledWith(user.storePurchaseAccess, expect.objectContaining({
      dateFrom: "2026-06-01", dateTo: "2026-06-30",
    }));
    expect(customer).toHaveBeenCalledWith(expect.objectContaining({ companyId: "company-1" }), expect.objectContaining({
      dateFrom: "2026-06-01", dateTo: "2026-06-30",
    }));
    expect(recorded).not.toHaveBeenCalled();
    expect(assistant.renderReceiveQuery({ data: result })).toMatch(/^Yes\./);
  });

  test("recorded date ranges cannot be silently applied to not-yet-recorded arrivals", async () => {
    const result = await assistant.queryReceiveWorkspace({
      user,
      args: {
        operation: "count", stage: "expected", source: "purchased", dateBasis: "receipt_date",
        from: "2026-06-01", to: "2026-06-30",
      },
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toMatch(/no receipt date yet/i);
  });

  test("invalid and inverted dates fail closed instead of becoming unfiltered queries", async () => {
    const impossible = await assistant.queryReceiveWorkspace({
      user,
      args: { operation: "list", stage: "expected", source: "all", dateBasis: "expected_date", from: "2026-02-31" },
    });
    const inverted = await assistant.queryReceiveWorkspace({
      user,
      args: { operation: "list", stage: "recorded", source: "all", dateBasis: "receipt_date", from: "2026-07-01", to: "2026-06-01" },
    });
    expect(impossible).toMatchObject({ ok: false });
    expect(inverted).toMatchObject({ ok: false });
  });

  test("bounded scans are never presented as exact totals", () => {
    const answer = assistant.renderReceiveQuery({ data: {
      ok: true,
      filters: { operation: "count", stage: "expected" },
      matchingCount: 20,
      truncated: true,
      rows: [],
      unavailable: [],
    } });
    expect(answer).toMatch(/20 or more/);
    expect(answer).toMatch(/bounded inspected set/i);
  });

  test("receive source and existence intent are grounded in the question", () => {
    expect(assistant.reconcileReceiveArgs("any grn expected in june", {
      operation: "list", source: "purchased",
    })).toMatchObject({ operation: "exists", source: "all" });
    expect(assistant.reconcileReceiveArgs("how many customer-owned arrivals are expected", {
      operation: "list", source: "all",
    })).toMatchObject({ operation: "count", source: "customer_owned" });
  });

  test("the runtime tool is closed, read-only and permission gated", () => {
    if (!registry.getTool("store_receive_query")) {
      delete require.cache[require.resolve("../../services/ai/tools/storePurchaseUniversalTools")];
      require("../../services/ai/tools/storePurchaseUniversalTools");
    }
    const tool = registry.getTool("store_receive_query");
    expect(tool).toBeTruthy();
    expect(tool.application).toBe("store_purchase");
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.permission(user)).toBe(true);
    expect(tool.permission({})).toBe(false);
    expect(JSON.stringify(tool.parameters)).not.toMatch(/companyId|database|collection|recordId/i);
  });
});
