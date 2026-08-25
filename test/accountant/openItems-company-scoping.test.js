// test/accountant/openItems-company-scoping.test.js
//
// Company-scoping hardening for services/openItems.service.js (C0-D cleanup,
// 24 Aug 2026). `fetchAllocationRows` used to silently drop the `companyId`
// filter when the value was missing or malformed, running an UNSCOPED
// aggregation across every company's vouchers instead of refusing. This
// proves the fix: fail closed, never guess.
//
// A plain Jest test against the mongodb-memory-server harness (test/setup.js)
// — no Express route involved, since this is testing the service directly,
// the same way a route, a future backfill script, or the forecast engine
// would call it.
"use strict";

const mongoose = require("mongoose");
const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const openItems = require("../../services/openItems.service");

async function makeCompanyWithOpenBill(name) {
  const company = await Acc_Company.create({ companyName: name, booksFromDate: new Date("2025-04-01") });
  const debtorGroup = await Acc_Group.create({ companyId: company._id, name: "Sundry Debtors", nature: "asset" });
  const salesGroup = await Acc_Group.create({ companyId: company._id, name: "Sales Accounts", nature: "revenue" });
  const customer = await Acc_Ledger.create({
    companyId: company._id,
    name: `${name} Buyer`,
    groupId: debtorGroup._id,
    groupName: debtorGroup.name,
    nature: "asset",
  });
  const salesLedger = await Acc_Ledger.create({
    companyId: company._id,
    name: `${name} Sales`,
    groupId: salesGroup._id,
    groupName: salesGroup.name,
    nature: "revenue",
  });
  await Acc_Voucher.create({
    companyId: company._id,
    voucherType: "sales",
    voucherNumber: `SV-${name}`,
    voucherDate: new Date("2026-01-01"),
    partyLedgerId: customer._id,
    partyLedgerName: customer.name,
    status: "posted",
    grandTotal: 10000,
    ledgerEntries: [
      {
        ledgerId: customer._id,
        ledgerName: customer.name,
        type: "Dr",
        amount: 10000,
        billAllocations: [{ billName: `INV-${name}`, billType: "new_ref", amount: 10000 }],
      },
      { ledgerId: salesLedger._id, ledgerName: salesLedger.name, type: "Cr", amount: 10000 },
    ],
  });
  return { company, customer, salesLedger };
}

/** Wraps Acc_Voucher.aggregate to prove whether it was ever invoked. */
function spyOnAggregate() {
  const original = Acc_Voucher.aggregate;
  let called = false;
  Acc_Voucher.aggregate = (...args) => {
    called = true;
    return original.apply(Acc_Voucher, args);
  };
  return {
    wasCalled: () => called,
    restore: () => {
      Acc_Voucher.aggregate = original;
    },
  };
}

describe("openItemsByLedger / billsByLedger — company scoping", () => {
  test("missing companyId (null/undefined) returns no rows for either entry point, and the aggregation never runs", async () => {
    const fx = await makeCompanyWithOpenBill("A");
    const spy = spyOnAggregate();
    try {
      const summary = await openItems.openItemsByLedger(null, [fx.customer._id]);
      const bills = await openItems.billsByLedger(undefined, [fx.customer._id]);
      expect(summary.size).toBe(0);
      expect(bills.size).toBe(0);
      expect(spy.wasCalled()).toBe(false);
    } finally {
      spy.restore();
    }
  });

  test("a malformed companyId (not an ObjectId) returns no rows, and the aggregation never runs", async () => {
    const fx = await makeCompanyWithOpenBill("B");
    const spy = spyOnAggregate();
    try {
      const summary = await openItems.openItemsByLedger("not-an-object-id", [fx.customer._id]);
      expect(summary.size).toBe(0);
      expect(spy.wasCalled()).toBe(false);
    } finally {
      spy.restore();
    }
  });

  test("an empty-string companyId returns no rows, and the aggregation never runs", async () => {
    const fx = await makeCompanyWithOpenBill("C");
    const spy = spyOnAggregate();
    try {
      const bills = await openItems.billsByLedger("", [fx.customer._id]);
      expect(bills.size).toBe(0);
      expect(spy.wasCalled()).toBe(false);
    } finally {
      spy.restore();
    }
  });

  test("a WRONG (but validly-shaped) companyId cannot pull in another company's open bills — no leak", async () => {
    const fxA = await makeCompanyWithOpenBill("CrossA");
    const fxB = await makeCompanyWithOpenBill("CrossB"); // has its own real open bill

    // Ask for company A's scope, but supply company B's ledger id. Before the
    // fix, a missing/wrong companyId fell through to an UNSCOPED query keyed
    // only on ledgerId — which would have found B's bill anyway (ledgerIds
    // are globally unique, so this specific shape never actually leaked DATA
    // across companies; what it failed to do was REFUSE on a scope mismatch,
    // which is the property this test pins). With the fix, a scope that does
    // not match the ledger's real company returns nothing.
    const wrongScope = await openItems.billsByLedger(fxA.company._id, [fxB.customer._id]);
    expect(wrongScope.size).toBe(0);

    // The correct scope still finds it.
    const rightScope = await openItems.billsByLedger(fxB.company._id, [fxB.customer._id]);
    expect(rightScope.size).toBeGreaterThan(0);
  });

  test("a valid, matching companyId still returns real data — the fix does not regress the happy path", async () => {
    const fx = await makeCompanyWithOpenBill("Valid");
    const summary = await openItems.openItemsByLedger(fx.company._id, [fx.customer._id]);
    const row = summary.get(String(fx.customer._id));
    expect(row).toBeTruthy();
    expect(row.openItemCount).toBe(1);
    expect(row.receivable).toBe(10000);

    const bills = await openItems.billsByLedger(fx.company._id, [fx.customer._id]);
    expect(bills.size).toBe(1);
  });

  test("companyId supplied as a string (not an ObjectId instance) still works — the real-caller shape", async () => {
    // Acc_parties.js passes a cast ObjectId; other callers (e.g. a future
    // forecast script) may reasonably pass the string form from a query
    // param or a .toString()'d id. Both must resolve identically.
    const fx = await makeCompanyWithOpenBill("StringId");
    const summary = await openItems.openItemsByLedger(fx.company._id.toString(), [fx.customer._id]);
    expect(summary.get(String(fx.customer._id)).openItemCount).toBe(1);
  });

  test("an empty ledgerIds array short-circuits before the companyId check even matters", async () => {
    const spy = spyOnAggregate();
    try {
      const summary = await openItems.openItemsByLedger(new mongoose.Types.ObjectId(), []);
      expect(summary.size).toBe(0);
      expect(spy.wasCalled()).toBe(false);
    } finally {
      spy.restore();
    }
  });
});
