"use strict";

jest.mock("../../services/accountingContext", () => ({
  buildCompanyInfo: jest.fn(),
  buildFinancials: jest.fn(),
  buildLedgerLookup: jest.fn(),
  buildVouchers: jest.fn(),
}));

const accounting = require("../../services/accountingContext");
const registry = require("../../services/ai/toolRegistry");

describe("accounting entity-first catalogue claims", () => {
  beforeAll(() => {
    registry._clear();
    require("../../services/ai/tools/accountingTools");
  });

  test("a verified unique ledger entity outranks overlapping HR vocabulary", async () => {
    accounting.buildLedgerLookup.mockResolvedValue({
      found: true,
      fuzzy: false,
      totalMatched: 1,
      exactNamedMatch: true,
      uniqueNamedMatch: true,
      matches: [{ name: "Salary Payable" }],
    });

    await expect(registry.getTool("acc_ledger_balance").claim({
      message: "balance of salary payable",
      history: [],
    })).resolves.toEqual({ account: "Salary Payable" });
  });

  test.each([
    [{ found: false }, "balance of anything"],
    [{ found: true, fuzzy: true, totalMatched: 1, matches: [{ name: "Maybe" }] }, "balance of maybe"],
    [{ found: true, fuzzy: false, totalMatched: 2, uniqueNamedMatch: false, matches: [] }, "cash balance"],
  ])("never claims missing, fuzzy or ambiguous ledger entities", async (resolved, message) => {
    accounting.buildLedgerLookup.mockResolvedValue(resolved);
    await expect(registry.getTool("acc_ledger_balance").claim({ message, history: [] }))
      .resolves.toBeNull();
  });

  test("does not search ledgers for a person compensation request", async () => {
    accounting.buildLedgerLookup.mockClear();
    await expect(registry.getTool("acc_ledger_balance").claim({
      message: "what is Arpita's gross salary",
      history: [],
    })).resolves.toBeNull();
    expect(accounting.buildLedgerLookup).not.toHaveBeenCalled();
  });

  test("a structurally incomplete single ledger is refused deterministically", async () => {
    const tool = registry.getTool("acc_ledger_balance");
    accounting.buildLedgerLookup.mockResolvedValue({
      found: true,
      fuzzy: false,
      totalMatched: 1,
      matches: [{
        name: "Salary Payable",
        group: "Provisions",
        balance: 2821068,
        drCr: "Dr",
        reconciliation: { status: "source_incomplete" },
      }],
    });
    accounting.buildCompanyInfo.mockResolvedValue({ available: true, baseCurrency: "INR" });
    const data = await tool.provideContext({ message: "balance of salary payable", args: { account: "Salary Payable" } });
    const reply = tool.renderAnswer({ data, args: { account: "Salary Payable" }, message: "balance of salary payable" });
    expect(reply).toMatch(/cannot be reported reliably/i);
    expect(reply).toMatch(/missing opening\/accrual/i);
    expect(reply).not.toMatch(/28,21,068|37,822/);
  });

  test("a complete single ledger is rendered exactly without another model pass", async () => {
    const tool = registry.getTool("acc_ledger_balance");
    accounting.buildLedgerLookup.mockResolvedValue({
      found: true,
      fuzzy: false,
      totalMatched: 1,
      matches: [{
        name: "Debidutt Mangilall",
        group: "Sundry Creditors",
        balance: 1899243,
        drCr: "Cr",
        reconciliation: { status: "cache_stale" },
      }],
    });
    accounting.buildCompanyInfo.mockResolvedValue({ available: true, baseCurrency: "INR" });
    const data = await tool.provideContext({ message: "balance of Debidutt Mangilall", args: { account: "Debidutt Mangilall" } });
    expect(tool.renderAnswer({ data })).toMatch(/^Debidutt Mangilall \(Sundry Creditors\): ₹18,99,243\.00 Cr,/);
  });

  test.each([
    ["expenses for this yr", "expenses", "Total expenses for FY 2026-27: ₹6,14,204.00."],
    ["what is our gross profit?", "gross_profit", "Gross profit for FY 2026-27: ₹58,01,101.00."],
    ["what is the gross margin", "gross_profit_margin", "Gross profit margin for FY 2026-27: 91.47%."],
  ])("claims and renders one exact financial concept: %s", async (message, metric, expected) => {
    const tool = registry.getTool("acc_financials");
    expect(tool.modelSelectable).toBe(false);
    expect(await tool.claim({ message, history: [] })).toEqual({ metric });
    accounting.buildFinancials.mockResolvedValue({
      baseCurrency: "INR",
      financialYear: "2026-27",
      profitAndLoss: {
        totalRevenue: 6538193,
        totalExpenses: 614204,
        directRevenue: 6342120,
        directExpenses: 541019,
        grossProfit: 5801101,
        grossProfitMargin: 91.47,
        netProfit: 5923989,
        netProfitMargin: 90.61,
      },
      balanceSheet: { totalAssets: 21567511, totalLiabilities: 4301502, equity: 0 },
      readable: "full summary",
    });
    const args = await tool.claim({ message, history: [] });
    const data = await tool.provideContext({ message, args });
    expect(tool.renderAnswer({ data, args, message })).toBe(expected);
  });

  test("returns the full packet only for an explicit financial-summary concept", async () => {
    const tool = registry.getTool("acc_financials");
    expect(await tool.claim({ message: "show the p&l", history: [] })).toEqual({ metric: "summary" });
    accounting.buildFinancials.mockResolvedValue({ readable: "Verified P&L and balance sheet summary." });
    const args = { metric: "summary" };
    const data = await tool.provideContext({ message: "show the p&l", args });
    expect(tool.renderAnswer({ data, args })).toBe("Verified P&L and balance sheet summary.");
  });

  test("does not claim unrelated accounting or HR questions", async () => {
    const tool = registry.getTool("acc_financials");
    expect(await tool.claim({ message: "balance of Salary Payable", history: [] })).toBeNull();
    expect(await tool.claim({ message: "what is Arpita's salary", history: [] })).toBeNull();
  });
});
