"use strict";
/**
 * test/support/accountingCommandFixtures.js — two companies' books, small and
 * deliberately alike.
 *
 * Company B carries a ledger with the SAME name as company A's customer, a
 * voucher with the SAME number as A's invoice, and a stock item with the SAME
 * name — so a search that forgot `companyId` anywhere answers with B's figure
 * and the test sees it. Company A also has a DRAFT invoice beside a posted
 * one, so a total that forgot "posted" is caught.
 *
 * Written through the raw collections, as the readers read them with lean().
 */

const mongoose = require("mongoose");

const oid = () => new mongoose.Types.ObjectId();
const d = (iso) => new Date(`${iso}T06:00:00.000Z`);

async function seedBooks() {
  const db = mongoose.connection;
  const A = oid();
  const B = oid();

  const groups = (companyId) => ({
    debtors: { _id: oid(), companyId, name: "Sundry Debtors", nature: "asset", isActive: true },
    creditors: { _id: oid(), companyId, name: "Sundry Creditors", nature: "liability", isActive: true },
    bank: { _id: oid(), companyId, name: "Bank Accounts", nature: "asset", isActive: true },
    sales: { _id: oid(), companyId, name: "Sales Accounts", nature: "revenue", isActive: true },
  });
  const gA = groups(A);
  const gB = groups(B);
  await db.collection("acc_groups").insertMany([...Object.values(gA), ...Object.values(gB)]);

  const ledger = (companyId, group, name, extra = {}) => ({
    _id: oid(), companyId, name, groupId: group._id, groupName: group.name, nature: group.nature,
    openingBalance: 0, isActive: true, ...extra,
  });
  const gaurav = ledger(A, gA.debtors, "Gaurav Enterprises", {
    gstin: "24AAACG1234F1Z5",
    contactDetails: { city: "Surat", phone: "9876543210", email: "gaurav@example.com" },
    bankDetails: { accountNumber: "999988887777", ifscCode: "HDFC0001234" },
  });
  const padma = ledger(A, gA.creditors, "Padma Traders");
  const bank = ledger(A, gA.bank, "Bank of Baroda");
  const salesA = ledger(A, gA.sales, "Sales");
  const gauravB = ledger(B, gB.debtors, "Gaurav Enterprises");
  const salesB = ledger(B, gB.sales, "Sales");
  await db.collection("acc_ledgers").insertMany([gaurav, padma, bank, salesA, gauravB, salesB]);

  const entry = (l, type, amount) => ({ ledgerId: l._id, ledgerName: l.name, type, amount, signedAmount: type === "Dr" ? amount : -amount });
  const voucher = (companyId, fields) => ({ _id: oid(), companyId, isLive: true, isOptional: false, ...fields });
  const vouchers = {
    invoice: voucher(A, {
      voucherNumber: "INV/0012", voucherType: "sales", status: "posted", voucherDate: d("2026-06-12"),
      partyLedgerId: gaurav._id, partyLedgerName: gaurav.name, grandTotal: 1200, narration: "Fabric supply",
      inventoryEntries: [{ stockItemName: "Cotton Fabric" }],
      ledgerEntries: [entry(gaurav, "Dr", 1200), entry(salesA, "Cr", 1200)],
    }),
    draftInvoice: voucher(A, {
      voucherNumber: "INV/0013", voucherType: "sales", status: "draft", voucherDate: d("2026-06-20"),
      partyLedgerId: gaurav._id, partyLedgerName: gaurav.name, grandTotal: 5000,
      ledgerEntries: [entry(gaurav, "Dr", 5000), entry(salesA, "Cr", 5000)],
    }),
    receipt: voucher(A, {
      voucherNumber: "RCT/0001", voucherType: "receipt", status: "posted", voucherDate: d("2026-06-25"),
      partyLedgerId: gaurav._id, partyLedgerName: gaurav.name, grandTotal: 500,
      ledgerEntries: [entry(bank, "Dr", 500), entry(gaurav, "Cr", 500)],
    }),
    payment: voucher(A, {
      voucherNumber: "PAY/0001", voucherType: "payment", status: "posted", voucherDate: d("2026-09-10"),
      partyLedgerId: padma._id, partyLedgerName: padma.name, grandTotal: 300,
      ledgerEntries: [entry(padma, "Dr", 300), entry(bank, "Cr", 300)],
    }),
    journal: voucher(A, {
      voucherNumber: "JV/0001", voucherType: "journal", status: "pending_approval", voucherDate: d("2026-10-02"),
      grandTotal: 50, ledgerEntries: [],
    }),
    otherCompanyInvoice: voucher(B, {
      voucherNumber: "INV/0012", voucherType: "sales", status: "posted", voucherDate: d("2026-06-12"),
      partyLedgerId: gauravB._id, partyLedgerName: gauravB.name, grandTotal: 9999,
      ledgerEntries: [entry(gauravB, "Dr", 9999), entry(salesB, "Cr", 9999)],
    }),
  };
  await db.collection("acc_vouchers").insertMany(Object.values(vouchers));

  await db.collection("acc_stock_items").insertMany([
    { _id: oid(), companyId: A, name: "Cotton Fabric", hsnCode: "5208", baseUnit: "Mtr", closingQuantity: 120, closingValue: 24000, stockGroupName: "Fabric", taxRate: 5, isActive: true },
    { _id: oid(), companyId: B, name: "Cotton Fabric", hsnCode: "5208", baseUnit: "Mtr", closingQuantity: 1, closingValue: 200, stockGroupName: "Fabric", isActive: true },
  ]);
  await db.collection("acc_proforma_invoices").insertOne({
    _id: oid(), companyId: A, voucherNumber: "PI/0001", status: "sent", voucherDate: d("2026-07-01"),
    validTill: d("2026-07-31"), grandTotal: 2500, buyer: { name: "Gaurav Enterprises" },
  });

  return { A, B, ledgers: { gaurav, padma, bank, gauravB }, vouchers, groups: { A: gA, B: gB } };
}

module.exports = { seedBooks, oid };
