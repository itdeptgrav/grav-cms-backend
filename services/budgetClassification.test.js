"use strict";
/**
 * services/budgetClassification.test.js
 *
 * WHICH LEDGERS CAN CARRY A BUDGET.
 *
 * The cases below are the ones that actually went wrong, not a tour of the
 * happy path. Two classes of mistake are pinned here because both were made:
 *
 *   1. `nature` alone is not enough. Round Off and Suspense are expenses and
 *      are not budget heads. Reading nature directly reported them
 *      "unbudgeted" on ordinary vouchers.
 *
 *   2. Mentioning a tax is not being a tax account. A first draft matched a
 *      bare /gst/ and swallowed "Freight Charges With 18% GST",
 *      "Professional Fees for GST Registration" and "Purchase Account
 *      Non-GST" — three real expense heads, silently made unbudgetable. The
 *      backfill's ambiguity report caught it before anything was written.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("./budgetClassification.service");

const classify = (name, groupName, nature) => c.classify({ name, groupName, nature });

test("tax control accounts are never budgeted", () => {
  for (const [name, group, nature] of [
    ["CGST Input", "Duties & Taxes", "asset"],
    ["SGST Output", "Duties & Taxes", "liability"],
    ["IGST Payable", "Current Liabilities", "liability"],
    ["GST Payable", "Current Liabilities", "liability"],
    ["Input CGST", "Current Assets", "asset"],
    ["TDS Payable", "Duties & Taxes", "liability"],
    ["TCS Receivable", "Current Assets", "asset"],
  ]) {
    assert.equal(classify(name, group, nature), c.NOT_BUDGETED, name);
  }
});

test("a real expense head that merely MENTIONS a tax is still budgetable", () => {
  /* The exact three the first draft got wrong. */
  assert.equal(
    classify("Freight Charges With 18% GST", "Direct Expenses", "expense"),
    c.EXPENSE_BUDGET,
  );
  assert.equal(
    classify("Professional Fees for GST Registration A/c", "Indirect Expenses", "expense"),
    c.EXPENSE_BUDGET,
  );
  assert.equal(
    classify("Purchase Account Non-GST", "Purchase Accounts", "expense"),
    c.EXPENSE_BUDGET,
  );
  assert.equal(
    classify("Audit & Tax Consultancy Fees", "Indirect Expenses", "expense"),
    c.EXPENSE_BUDGET,
  );
});

test("bank and cash are never budgeted", () => {
  assert.equal(classify("HDFC Current A/c", "Bank Accounts", "asset"), c.NOT_BUDGETED);
  assert.equal(classify("Cash", "Cash-in-Hand", "asset"), c.NOT_BUDGETED);
  assert.equal(classify("Bank OD A/c", "Bank OD A/c", "liability"), c.NOT_BUDGETED);
});

test("payables and receivables are never budgeted", () => {
  assert.equal(classify("ANANDI ENTERPRISES", "Sundry Creditors", "liability"), c.NOT_BUDGETED);
  assert.equal(classify("Taj Hotel", "Sundry Debtors", "asset"), c.NOT_BUDGETED);
});

test("rounding off is never budgeted, despite being an expense", () => {
  assert.equal(classify("Round Off", "Indirect Expenses", "expense"), c.NOT_BUDGETED);
  assert.equal(classify("ROUND OFF", "Indirect Expenses", "expense"), c.NOT_BUDGETED);
  assert.equal(classify("Rounding Off", "Indirect Expenses", "expense"), c.NOT_BUDGETED);
});

test("fixed assets and stock balances are never budgeted", () => {
  assert.equal(classify("Office Equipment", "Fixed Assets", "asset"), c.NOT_BUDGETED);
  assert.equal(classify("Closing Stock", "Stock-in-Hand", "asset"), c.NOT_BUDGETED);
  assert.equal(classify("Opening Stock", "Direct Expenses", "expense"), c.NOT_BUDGETED);
});

test("suspense and capital are never budgeted", () => {
  assert.equal(classify("Suspense A/c", "Suspense A/c", "asset"), c.NOT_BUDGETED);
  assert.equal(classify("Capital Account", "Capital Account", "equity"), c.NOT_BUDGETED);
  assert.equal(classify("Drawings", "Capital Account", "equity"), c.NOT_BUDGETED);
});

test("sales and income heads are revenue targets", () => {
  assert.equal(classify("Sales Account", "Sales Accounts", "revenue"), c.REVENUE_TARGET);
  assert.equal(classify("Export Sales", "Direct Incomes", "revenue"), c.REVENUE_TARGET);
  assert.equal(classify("Job Work Income", "Indirect Incomes", "revenue"), c.REVENUE_TARGET);
});

test("controllable spend of every kind is one expense budget, not a special type", () => {
  /* The spec's whole list, deliberately: raw material, consumables, job work,
     freight and packing are all `expense_budget`. There is no
     `procurement_budget` — splitting them would multiply the pickers without
     changing a single rule about who approves what. */
  for (const [name, group] of [
    ["Raw Material Purchase", "Purchase Accounts"],
    ["Purchase — Local", "Purchase Accounts"],
    ["Packing Material", "Direct Expenses"],
    ["Consumables", "Direct Expenses"],
    ["Job Work Charges", "Direct Expenses"],
    ["Cartage Exp", "Direct Expenses"],
    ["Repairs & Maintenance (Plant)", "Indirect Expenses"],
    ["Software Subscription Expenses", "Indirect Expenses"],
    ["Staff Welfare", "Indirect Expenses"],
    ["Advertisement & Marketing", "Indirect Expenses"],
  ]) {
    assert.equal(classify(name, group, "expense"), c.EXPENSE_BUDGET, name);
  }
});

test("an unresolved nature drops OUT of budget control, not into it", () => {
  /* Failing open. The cost of guessing "this is spend" is refusing a
     legitimate posting; the cost of guessing the other way is a head that
     shows its overspend on the budget screens afterwards. */
  assert.equal(classify("Mystery Ledger", "", null), c.NOT_BUDGETED);
  assert.equal(classify("Mystery Ledger", "Some Group", undefined), c.NOT_BUDGETED);
});

test("finance's stored decision beats the derivation, in both directions", () => {
  /* A head finance ruled out stays out even though it looks like spend… */
  assert.equal(
    c.budgetControlOf({
      budgetControl: c.NOT_BUDGETED,
      name: "Software Subscription Expenses",
      groupName: "Indirect Expenses",
      nature: "expense",
    }),
    c.NOT_BUDGETED,
  );
  /* …and a head finance ruled IN is budgetable even though the derivation
     would have excluded it. This is the escape hatch for a chart that does
     not fit the rules. */
  assert.equal(
    c.budgetControlOf({
      budgetControl: c.EXPENSE_BUDGET,
      name: "Round Off",
      groupName: "Indirect Expenses",
      nature: "expense",
    }),
    c.EXPENSE_BUDGET,
  );
});

test("a ledger with no stored value is classified on read", () => {
  /* The property that makes the backfill an optimisation rather than a
     precondition: the system is correct before it ever runs. */
  assert.equal(
    c.budgetControlOf({ name: "Cartage Exp", groupName: "Direct Expenses", nature: "expense" }),
    c.EXPENSE_BUDGET,
  );
  assert.equal(
    c.budgetControlOf({ name: "CGST Input", groupName: "Duties & Taxes", nature: "asset" }),
    c.NOT_BUDGETED,
  );
});

test("a garbage stored value is ignored rather than trusted", () => {
  assert.equal(
    c.budgetControlOf({
      budgetControl: "procurement_budget",
      name: "Cartage Exp",
      groupName: "Direct Expenses",
      nature: "expense",
    }),
    c.EXPENSE_BUDGET,
  );
});

test("ambiguity is reported where the two sources genuinely disagree", () => {
  /* Round Off: expense by nature, excluded by rule. Worth a human look. */
  assert.equal(
    c.isAmbiguous({ name: "Round Off", groupName: "Indirect Expenses", nature: "expense" }),
    true,
  );
  /* An ordinary expense head is not ambiguous. */
  assert.equal(
    c.isAmbiguous({ name: "Staff Welfare", groupName: "Indirect Expenses", nature: "expense" }),
    false,
  );
  /* Neither is an ordinary bank account — nature and rule agree. */
  assert.equal(
    c.isAmbiguous({ name: "HDFC Current", groupName: "Bank Accounts", nature: "asset" }),
    false,
  );
});

test("the three values are the only ones, and procurement_budget is not among them", () => {
  assert.deepEqual(c.VALUES, ["expense_budget", "revenue_target", "not_budgeted"]);
  assert.equal(c.VALUES.includes("procurement_budget"), false);
});
