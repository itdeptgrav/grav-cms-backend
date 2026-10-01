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
});
