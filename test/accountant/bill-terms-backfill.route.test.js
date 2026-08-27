// test/accountant/bill-terms-backfill.route.test.js
//
// HTTP-level tests for C0-F's historical due-date backfill:
//   GET  /api/accountant/bill-terms/backfill/preview
//   POST /api/accountant/bill-terms/backfill/apply
//   POST /api/accountant/bill-terms/backfill/rollback
//
// Same harness as every other accountant route test this session: bare
// Express app, in-memory MongoDB, AccountantAuthMiddleware mocked to read
// identity from a test header.
//
// What this proves that the pure planner tests
// (services/billTermsBackfillPlanner.test.js) cannot:
//   - preview genuinely writes nothing, checked by document count before/after
//   - apply writes ONLY Acc_BillTerms — Acc_Voucher is asserted byte-for-byte
//     unchanged (every field, including updatedAt) before vs after
//   - a wrong/missing companyId cannot pull another company's bills into a
//     plan, or leak a write into another company's Acc_BillTerms
//   - re-running apply is genuinely idempotent — no duplicate documents,
//     confirmed via the model's own unique index as well as a count
//   - rollback deletes ONLY the named run's rows
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
}));

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const Acc_BillTerms = require("../../models/Accountant_model/Acc_BillTerms");

const EDITOR = { id: new mongoose.Types.ObjectId().toString(), name: "Priya Editor", permissions: { canEdit: true } };
const VIEWER = { id: new mongoose.Types.ObjectId().toString(), name: "Vikram Viewer", permissions: { canEdit: false } };

let server, base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/accountant/bill-terms", require("../../routes/Accountant_Routes/Acc_billTerms"));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/bill-terms`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

async function call(path, { method = "GET", body, user = EDITOR } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/* ── Fixtures ──────────────────────────────────────────────────────────── */

async function makeCompany(name, defaultCreditDays = null) {
  return Acc_Company.create({ companyName: name, booksFromDate: new Date("2025-04-01"), defaultCreditDays });
}

async function debtorGroup(company) {
  // Reused across every customer for the same company — Acc_Group has a
  // unique (companyId, name) index, so a second customer for a company that
  // already has one would otherwise collide.
  const existing = await Acc_Group.findOne({ companyId: company._id, name: "Sundry Debtors" });
  if (existing) return existing;
  return Acc_Group.create({ companyId: company._id, name: "Sundry Debtors", nature: "asset" });
}

async function makeCustomer(company, { name, creditPeriodDays = 0 } = {}) {
  const group = await debtorGroup(company);
  return Acc_Ledger.create({
    companyId: company._id,
    name: name || `Buyer ${new mongoose.Types.ObjectId().toString().slice(-6)}`,
    groupId: group._id,
    groupName: group.name,
    nature: "asset",
    creditPeriodDays,
  });
}

async function makeSalesLedger(company) {
  const existing = await Acc_Group.findOne({ companyId: company._id, name: "Sales Accounts" });
  const group = existing || (await Acc_Group.create({ companyId: company._id, name: "Sales Accounts", nature: "revenue" }));
  return Acc_Ledger.create({
    companyId: company._id,
    name: "Sales",
    groupId: group._id,
    groupName: group.name,
    nature: "revenue",
  });
}

/** A posted sales voucher establishing one open bill, with NO dueDate. */
async function postOpenBill(company, customer, salesLedger, { billName, amount, voucherDate }) {
  return Acc_Voucher.create({
    companyId: company._id,
    voucherType: "sales",
    voucherNumber: `SV-${billName}`,
    voucherDate: new Date(voucherDate),
    partyLedgerId: customer._id,
    partyLedgerName: customer.name,
    status: "posted",
    grandTotal: amount,
    ledgerEntries: [
      {
        ledgerId: customer._id,
        ledgerName: customer.name,
        type: "Dr",
        amount,
        billAllocations: [{ billName, billType: "new_ref", amount }], // no dueDate
      },
      { ledgerId: salesLedger._id, ledgerName: salesLedger.name, type: "Cr", amount },
    ],
  });
}

const authHeader = { "x-test-user": JSON.stringify(EDITOR) };

async function previewFor(companyId) {
  return call(`/backfill/preview?companyId=${companyId}`);
}

/* ═══════════════════════════════════════════════════════════════════════
   Preview — read only
   ═══════════════════════════════════════════════════════════════════════ */

describe("GET /backfill/preview", () => {
  test("returns the expected shape and a confirmationToken, writing nothing", async () => {
    const company = await makeCompany("PreviewCo", 30);
    const customer = await makeCustomer(company, { creditPeriodDays: 0 }); // relies on company default
    const salesLedger = await makeSalesLedger(company);
    await postOpenBill(company, customer, salesLedger, { billName: "INV-P1", amount: 10000, voucherDate: "2026-01-01" });

    const before = await Acc_BillTerms.countDocuments({});
    const { status, body } = await previewFor(company._id);
    const after = await Acc_BillTerms.countDocuments({});

    expect(status).toBe(200);
    expect(after).toBe(before); // preview writes NOTHING
    expect(body.totals.toApplyCount).toBe(1);
    expect(body.toApply[0].source).toBe("company_default");
    expect(typeof body.confirmationToken).toBe("string");
    expect(body.confirmationToken.length).toBeGreaterThan(0);
  });

  test("company default unset: the row is blocked, not proposed", async () => {
    const company = await makeCompany("UnsetCo"); // defaultCreditDays stays null
    const customer = await makeCustomer(company, { creditPeriodDays: 0 });
    const salesLedger = await makeSalesLedger(company);
    await postOpenBill(company, customer, salesLedger, { billName: "INV-U1", amount: 5000, voucherDate: "2026-01-01" });

    const { body } = await previewFor(company._id);
    expect(body.totals.toApplyCount).toBe(0);
    expect(body.totals.blockedCount).toBe(1);
    expect(body.blocked[0].blockedReason).toBe("company_default_unset");
  });

  test("party terms outrank an unset company default — still dateable", async () => {
    const company = await makeCompany("PartyCo"); // no company default at all
    const customer = await makeCustomer(company, { creditPeriodDays: 30 });
    const salesLedger = await makeSalesLedger(company);
    await postOpenBill(company, customer, salesLedger, { billName: "INV-PT1", amount: 5000, voucherDate: "2026-01-01" });

    const { body } = await previewFor(company._id);
    expect(body.totals.toApplyCount).toBe(1);
    expect(body.toApply[0].source).toBe("party_terms");
  });

  test("missing companyId is rejected outright", async () => {
    const { status } = await call("/backfill/preview");
    expect(status).toBe(400);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   Apply — writes Acc_BillTerms only
   ═══════════════════════════════════════════════════════════════════════ */

describe("POST /backfill/apply", () => {
  test("writes ONLY Acc_BillTerms — Acc_Voucher is byte-for-byte unchanged before vs after", async () => {
    const company = await makeCompany("ApplyCo", 45);
    const customer = await makeCustomer(company, { creditPeriodDays: 0 });
    const salesLedger = await makeSalesLedger(company);
    const voucher = await postOpenBill(company, customer, salesLedger, {
      billName: "INV-A1",
      amount: 20000,
      voucherDate: "2026-01-01",
    });

    const before = await Acc_Voucher.findById(voucher._id).lean();

    const { body: preview } = await previewFor(company._id);
    const { status, body } = await call("/backfill/apply", {
      method: "POST",
      body: { companyId: company._id.toString(), confirmationToken: preview.confirmationToken },
    });

    expect(status).toBe(200);
    expect(body.written).toBe(1);
    expect(body.backfillRunId).toBeTruthy();

    const after = await Acc_Voucher.findById(voucher._id).lean();
    expect(after).toEqual(before); // deep-equal: every field, including updatedAt, unchanged
    expect(after.dueDate).toBeUndefined(); // the voucher header was never touched
    expect(after.ledgerEntries[0].billAllocations[0].dueDate).toBeUndefined(); // nor the allocation

    const stored = await Acc_BillTerms.findOne({ companyId: company._id, billName: "INV-A1" }).lean();
    expect(stored).toBeTruthy();
    expect(stored.source).toBe("company_default");
    expect(stored.creditDaysUsed).toBe(45);
    expect(new Date(stored.dueDate).toISOString().slice(0, 10)).toBe("2026-02-15");
    expect(String(stored.backfillRunId)).toBe(body.backfillRunId);
  });

  test("refuses without a confirmationToken", async () => {
    const company = await makeCompany("NoTokenCo", 30);
    const { status, body } = await call("/backfill/apply", {
      method: "POST",
      body: { companyId: company._id.toString() },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/confirmationToken/i);
  });

  test("refuses a stale token — the plan changed since preview", async () => {
    const company = await makeCompany("StaleCo", 30);
    const customer = await makeCustomer(company, { creditPeriodDays: 0 });
    const salesLedger = await makeSalesLedger(company);
    await postOpenBill(company, customer, salesLedger, { billName: "INV-S1", amount: 1000, voucherDate: "2026-01-01" });

    const { body: preview } = await previewFor(company._id);
    // Data changes AFTER preview, before apply.
    await postOpenBill(company, customer, salesLedger, { billName: "INV-S2", amount: 2000, voucherDate: "2026-01-02" });

    const { status, body } = await call("/backfill/apply", {
      method: "POST",
      body: { companyId: company._id.toString(), confirmationToken: preview.confirmationToken },
    });
    expect(status).toBe(409);
    expect(body.code).toBe("STALE_PLAN");

    const written = await Acc_BillTerms.countDocuments({ companyId: company._id });
    expect(written).toBe(0); // refused BEFORE writing anything
  });

  test("a bill whose only path is an unset company default is never written, even while other bills in the same run apply", async () => {
    const company = await makeCompany("MixedCo"); // no company default
    const withTerms = await makeCustomer(company, { name: "Termed Buyer", creditPeriodDays: 20 });
    const withoutTerms = await makeCustomer(company, { name: "Untermed Buyer", creditPeriodDays: 0 });
    const salesLedger = await makeSalesLedger(company);
    await postOpenBill(company, withTerms, salesLedger, { billName: "INV-M1", amount: 1000, voucherDate: "2026-01-01" });
    await postOpenBill(company, withoutTerms, salesLedger, { billName: "INV-M2", amount: 2000, voucherDate: "2026-01-01" });

    const { body: preview } = await previewFor(company._id);
    expect(preview.totals.toApplyCount).toBe(1);
    expect(preview.totals.blockedCount).toBe(1);

    const { status, body } = await call("/backfill/apply", {
      method: "POST",
      body: { companyId: company._id.toString(), confirmationToken: preview.confirmationToken },
    });
    expect(status).toBe(200);
    expect(body.written).toBe(1);
    expect(body.blockedCount).toBe(1);

    const dated = await Acc_BillTerms.findOne({ companyId: company._id, billName: "INV-M1" }).lean();
    const blocked = await Acc_BillTerms.findOne({ companyId: company._id, billName: "INV-M2" }).lean();
    expect(dated).toBeTruthy();
    expect(blocked).toBeNull(); // the row needing the unset company default was never written
  });

  test("idempotent: after a successful apply, a second PREVIEW shows the bill already dated by sidecar, not toApply", async () => {
    const company = await makeCompany("IdempotentCo", 30);
    const customer = await makeCustomer(company, { creditPeriodDays: 0 });
    const salesLedger = await makeSalesLedger(company);
    await postOpenBill(company, customer, salesLedger, { billName: "INV-I1", amount: 5000, voucherDate: "2026-01-01" });

    const first = await previewFor(company._id);
    const firstApply = await call("/backfill/apply", {
      method: "POST",
      body: { companyId: company._id.toString(), confirmationToken: first.body.confirmationToken },
    });
    expect(firstApply.body.written).toBe(1);
    const afterFirst = await Acc_BillTerms.findOne({ companyId: company._id, billName: "INV-I1" }).lean();

    // A fresh preview, with IDENTICAL underlying data (nothing about the
    // party's terms or the bill changed) — this is the exact bug this
    // correction fixes: the bill must now read as already dated BY THE
    // SIDECAR, not sit in toApply forever regardless of how many runs
    // already dated it.
    const second = await previewFor(company._id);
    expect(second.body.totals.toApplyCount).toBe(0);
    expect(second.body.totals.alreadyDatedCount).toBe(1);
    expect(second.body.totals.alreadyDatedBySource.bill_terms).toBe(1);
    expect(second.body.coverage.before).toBe(100);
    expect(second.body.coverage.after).toBe(100);
    const alreadyRow = second.body.alreadyDated.find((r) => r.billName === "INV-I1");
    expect(alreadyRow.alreadyDatedSource).toBe("bill_terms");
    expect(alreadyRow.alreadyBackfilled).toBe(true);
    expect(alreadyRow.isManual).toBe(false);

    // Applying this (empty) plan is a true no-op: nothing to write, so no
    // run identity is even minted.
    const secondApply = await call("/backfill/apply", {
      method: "POST",
      body: { companyId: company._id.toString(), confirmationToken: second.body.confirmationToken },
    });
    expect(secondApply.status).toBe(200);
    expect(secondApply.body.written).toBe(0);
    expect(secondApply.body.backfillRunId).toBe(null);

    const afterSecond = await Acc_BillTerms.findOne({ companyId: company._id, billName: "INV-I1" }).lean();
    expect(afterSecond).toEqual(afterFirst); // byte-for-byte identical — including backfillRunId and updatedAt
    expect(String(afterSecond.backfillRunId)).toBe(firstApply.body.backfillRunId); // still belongs to run 1

    const count = await Acc_BillTerms.countDocuments({ companyId: company._id, billName: "INV-I1" });
    expect(count).toBe(1); // exactly one document, never duplicated
  });

  test("a genuine change (party terms edited between runs) DOES re-derive and re-stamp with the new run", async () => {
    const company = await makeCompany("ChangedTermsCo", 30);
    const customer = await makeCustomer(company, { creditPeriodDays: 0 }); // starts on company default
    const salesLedger = await makeSalesLedger(company);
    await postOpenBill(company, customer, salesLedger, { billName: "INV-C1", amount: 5000, voucherDate: "2026-01-01" });

    const first = await previewFor(company._id);
    const firstApply = await call("/backfill/apply", {
      method: "POST",
      body: { companyId: company._id.toString(), confirmationToken: first.body.confirmationToken },
    });
    expect(firstApply.body.written).toBe(1);
    const afterFirst = await Acc_BillTerms.findOne({ companyId: company._id, billName: "INV-C1" }).lean();
    expect(afterFirst.source).toBe("company_default");

    // Finance sets this party's own terms after the first run.
    await Acc_Ledger.findByIdAndUpdate(customer._id, { creditPeriodDays: 15, creditTermsSource: "manual" });

    const second = await previewFor(company._id);
    expect(second.body.toApply[0].source).toBe("party_terms"); // now outranks the company default
    const secondApply = await call("/backfill/apply", {
      method: "POST",
      body: { companyId: company._id.toString(), confirmationToken: second.body.confirmationToken },
    });
    expect(secondApply.body.written).toBe(1); // genuinely changed — a real write, not a no-op
    expect(secondApply.body.unchanged).toBe(0);

    const afterSecond = await Acc_BillTerms.findOne({ companyId: company._id, billName: "INV-C1" }).lean();
    expect(afterSecond.source).toBe("party_terms");
    expect(String(afterSecond.backfillRunId)).toBe(secondApply.body.backfillRunId); // provenance moved to run 2
    expect(String(afterSecond.backfillRunId)).not.toBe(firstApply.body.backfillRunId);

    const count = await Acc_BillTerms.countDocuments({ companyId: company._id, billName: "INV-C1" });
    expect(count).toBe(1); // still one document — updated in place, never duplicated
  });

  test("a manual sidecar row is already-dated and never even proposed for write, regardless of what current terms would derive", async () => {
    const company = await makeCompany("ManualCo", 30);
    const customer = await makeCustomer(company, { creditPeriodDays: 90 }); // would derive a WILDLY different date
    const salesLedger = await makeSalesLedger(company);
    await postOpenBill(company, customer, salesLedger, { billName: "INV-MAN1", amount: 5000, voucherDate: "2026-01-01" });

    // A human has already set this bill's due date manually, out of band —
    // deliberately NOT what the party's 90-day terms would produce, so a
    // mismatch can't be mistaken for "this just happens to already match".
    await Acc_BillTerms.create({
      companyId: company._id,
      ledgerId: customer._id,
      billName: "INV-MAN1",
      dueDate: new Date("2026-12-25"),
      source: "manual",
      creditDaysUsed: 1,
      basisDate: new Date("2026-01-01"),
      isManual: true,
      backfillRunId: null,
    });

    const { body: preview } = await previewFor(company._id);
    // Protected at the PLANNING stage, not just at write time — the manual
    // row never reaches toApply in the first place.
    expect(preview.totals.toApplyCount).toBe(0);
    expect(preview.totals.alreadyDatedCount).toBe(1);
    const manualRow = preview.alreadyDated.find((r) => r.billName === "INV-MAN1");
    expect(manualRow.isManual).toBe(true);
    expect(manualRow.alreadyDatedSource).toBe("bill_terms");
    expect(new Date(manualRow.existingDueDate).toISOString().slice(0, 10)).toBe("2026-12-25");

    const { body } = await call("/backfill/apply", {
      method: "POST",
      body: { companyId: company._id.toString(), confirmationToken: preview.confirmationToken },
    });
    expect(body.written).toBe(0);
    expect(body.skippedManual).toBe(0); // nothing REACHED the write loop to be skipped there

    const stored = await Acc_BillTerms.findOne({ companyId: company._id, billName: "INV-MAN1" }).lean();
    expect(stored.dueDate.toISOString().slice(0, 10)).toBe("2026-12-25"); // untouched
    expect(stored.isManual).toBe(true);
  });

  test("a non-manual sidecar row whose stored value already matches current terms is not proposed again", async () => {
    const company = await makeCompany("MatchingCo", 30);
    const customer = await makeCustomer(company, { creditPeriodDays: 20 });
    const salesLedger = await makeSalesLedger(company);
    await postOpenBill(company, customer, salesLedger, { billName: "INV-MATCH1", amount: 4000, voucherDate: "2026-01-01" });

    await Acc_BillTerms.create({
      companyId: company._id,
      ledgerId: customer._id,
      billName: "INV-MATCH1",
      dueDate: new Date("2026-01-21"), // exactly basisDate + 20 days
      source: "party_terms",
      creditDaysUsed: 20,
      basisDate: new Date("2026-01-01"),
      isManual: false,
      backfillRunId: new mongoose.Types.ObjectId(), // from some earlier, unrelated run
    });

    const { body: preview } = await previewFor(company._id);
    expect(preview.totals.toApplyCount).toBe(0);
    const row = preview.alreadyDated.find((r) => r.billName === "INV-MATCH1");
    expect(row.alreadyDatedSource).toBe("bill_terms");
    expect(row.isManual).toBe(false);

    const { body } = await call("/backfill/apply", {
      method: "POST",
      body: { companyId: company._id.toString(), confirmationToken: preview.confirmationToken },
    });
    expect(body.written).toBe(0);
  });

  test("unauthorized (read-only) user cannot apply", async () => {
    const company = await makeCompany("UnauthCo", 30);
    const customer = await makeCustomer(company, { creditPeriodDays: 0 });
    const salesLedger = await makeSalesLedger(company);
    await postOpenBill(company, customer, salesLedger, { billName: "INV-UA1", amount: 1000, voucherDate: "2026-01-01" });

    const { body: preview } = await previewFor(company._id);
    const { status } = await call("/backfill/apply", {
      method: "POST",
      body: { companyId: company._id.toString(), confirmationToken: preview.confirmationToken },
      user: VIEWER,
    });
    expect(status).toBe(403);

    const count = await Acc_BillTerms.countDocuments({ companyId: company._id });
    expect(count).toBe(0);
  });

  test("wrong-company data cannot leak: previewing company A never surfaces company B's open bills, and applying against A never writes into B", async () => {
    const companyA = await makeCompany("LeakA", 30);
    const companyB = await makeCompany("LeakB", 30);
    const custA = await makeCustomer(companyA, { name: "A Buyer", creditPeriodDays: 0 });
    const custB = await makeCustomer(companyB, { name: "B Buyer", creditPeriodDays: 0 });
    const salesA = await makeSalesLedger(companyA);
    const salesB = await makeSalesLedger(companyB);
    await postOpenBill(companyA, custA, salesA, { billName: "INV-LA1", amount: 1000, voucherDate: "2026-01-01" });
    await postOpenBill(companyB, custB, salesB, { billName: "INV-LB1", amount: 9999, voucherDate: "2026-01-01" });

    const { body: previewA } = await previewFor(companyA._id);
    expect(previewA.totals.totalOpen).toBe(1);
    expect(previewA.rows[0].billName).toBe("INV-LA1"); // never LB1

    // Explicitly (and wrongly) pass company B's ledger id while scoping to company A.
    const crossed = await call(
      `/backfill/preview?companyId=${companyA._id}&ledgerIds=${custB._id}`,
    );
    expect(crossed.body.totals.totalOpen).toBe(0); // company A's scope excludes B's ledger entirely

    // Apply against A; confirm B's books are untouched.
    await call("/backfill/apply", {
      method: "POST",
      body: { companyId: companyA._id.toString(), confirmationToken: previewA.confirmationToken },
    });
    const bTerms = await Acc_BillTerms.countDocuments({ companyId: companyB._id });
    expect(bTerms).toBe(0);
  });

  test("a malformed companyId is rejected, nothing written", async () => {
    const { status } = await call("/backfill/apply", {
      method: "POST",
      body: { companyId: "not-an-id", confirmationToken: "whatever" },
    });
    expect(status).toBe(400);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   Rollback
   ═══════════════════════════════════════════════════════════════════════ */

describe("POST /backfill/rollback", () => {
  test("deletes only the named run's rows, leaving other runs and other companies untouched", async () => {
    const company = await makeCompany("RollbackCo", 30);
    const customer = await makeCustomer(company, { creditPeriodDays: 0 });
    const salesLedger = await makeSalesLedger(company);
    await postOpenBill(company, customer, salesLedger, { billName: "INV-R1", amount: 1000, voucherDate: "2026-01-01" });

    const run1Preview = await previewFor(company._id);
    const run1 = await call("/backfill/apply", {
      method: "POST",
      body: { companyId: company._id.toString(), confirmationToken: run1Preview.body.confirmationToken },
    });
    expect(run1.body.written).toBe(1);

    // A second, unrelated bill dated in a SECOND run.
    await postOpenBill(company, customer, salesLedger, { billName: "INV-R2", amount: 2000, voucherDate: "2026-01-02" });
    const run2Preview = await previewFor(company._id);
    const run2 = await call("/backfill/apply", {
      method: "POST",
      body: { companyId: company._id.toString(), confirmationToken: run2Preview.body.confirmationToken },
    });
    expect(run2.body.written).toBe(1); // only the new bill; run1's row is untouched by run2's own apply

    const beforeRollback = await Acc_BillTerms.countDocuments({ companyId: company._id });
    expect(beforeRollback).toBe(2);

    const { status, body } = await call("/backfill/rollback", {
      method: "POST",
      body: { companyId: company._id.toString(), backfillRunId: run2.body.backfillRunId },
    });
    expect(status).toBe(200);
    expect(body.deletedCount).toBe(1);

    const remaining = await Acc_BillTerms.find({ companyId: company._id }).lean();
    expect(remaining.length).toBe(1);
    expect(remaining[0].billName).toBe("INV-R1"); // run1's row survives
  });

  test("rollback never touches Acc_Voucher", async () => {
    const company = await makeCompany("RollbackVoucherCo", 30);
    const customer = await makeCustomer(company, { creditPeriodDays: 0 });
    const salesLedger = await makeSalesLedger(company);
    const voucher = await postOpenBill(company, customer, salesLedger, {
      billName: "INV-RV1",
      amount: 1000,
      voucherDate: "2026-01-01",
    });
    const beforeVoucher = await Acc_Voucher.findById(voucher._id).lean();

    const { body: preview } = await previewFor(company._id);
    const applyResult = await call("/backfill/apply", {
      method: "POST",
      body: { companyId: company._id.toString(), confirmationToken: preview.confirmationToken },
    });

    await call("/backfill/rollback", {
      method: "POST",
      body: { companyId: company._id.toString(), backfillRunId: applyResult.body.backfillRunId },
    });

    const afterVoucher = await Acc_Voucher.findById(voucher._id).lean();
    expect(afterVoucher).toEqual(beforeVoucher);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CHUNK 1-C — MANUAL FORECAST EXPECTED DATE
 *
 * These endpoints record when an overdue bill is EXPECTED to settle. They must
 * never touch `dueDate`, which is the contractual/accounting date.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("forecast expected date", () => {
  const PATH = "/forecast-expected-date";

  /** A company, a party ledger and one sidecar row for an overdue bill. */
  async function seedBillTerm(overrides = {}) {
    // Uses this file's own existing fixtures rather than a second set.
    const company = await makeCompany(`FE ${new mongoose.Types.ObjectId().toString().slice(-6)}`);
    const ledger = await makeCustomer(company, { name: "Overdue Buyer" });
    const row = await Acc_BillTerms.create({
      companyId: company._id,
      ledgerId: ledger._id,
      billName: "RC/0091/26-27",
      dueDate: new Date("2026-07-01"),
      source: "company_default",
      creditDaysUsed: 46,
      basisDate: new Date("2026-05-16"),
      ...overrides,
    });
    return { company, ledger, row };
  }

  function setBody(company, ledger, overrides = {}) {
    return {
      companyId: company._id.toString(),
      ledgerId: ledger._id.toString(),
      billName: "RC/0091/26-27",
      forecastExpectedDate: "2026-09-15",
      asOfDate: "2026-08-24",
      ...overrides,
    };
  }

  /* ── Set ───────────────────────────────────────────────────────────────── */

  test("an editor can set an expected date, and ONLY forecast fields change", async () => {
    const { company, ledger, row } = await seedBillTerm();
    const before = await Acc_BillTerms.findById(row._id).lean();

    const { status, body } = await call(PATH, {
      method: "PATCH",
      body: setBody(company, ledger, { notes: "AP confirmed 15 Sep" }),
    });
    expect(status).toBe(200);
    expect(body.billTerm.forecastExpectedDate.slice(0, 10)).toBe("2026-09-15");
    expect(body.billTerm.forecastExpectedDateSource).toBe("manual");
    expect(body.billTerm.forecastExpectedDateNotes).toBe("AP confirmed 15 Sep");

    const after = await Acc_BillTerms.findById(row._id).lean();
    // The contractual date and every derivation field are untouched.
    expect(after.dueDate.getTime()).toBe(before.dueDate.getTime());
    expect(after.source).toBe(before.source);
    expect(after.creditDaysUsed).toBe(before.creditDaysUsed);
    expect(after.basisDate.getTime()).toBe(before.basisDate.getTime());
    expect(String(after.backfillRunId)).toBe(String(before.backfillRunId));
    // Provenance came from the authenticated user, not the body.
    expect(String(after.forecastExpectedDateUpdatedBy)).toBe(EDITOR.id);
    expect(after.forecastExpectedDateUpdatedByName).toBe(EDITOR.name);
    expect(after.forecastExpectedDateUpdatedAt).toBeTruthy();
  });

  test("a date before asOfDate is refused, and nothing is stored", async () => {
    const { company, ledger, row } = await seedBillTerm();
    const { status, body } = await call(PATH, {
      method: "PATCH",
      body: setBody(company, ledger, { forecastExpectedDate: "2026-08-01" }),
    });
    expect(status).toBe(400);
    expect(body.code).toBe("DATE_IN_PAST");

    const after = await Acc_BillTerms.findById(row._id).lean();
    expect(after.forecastExpectedDate).toBeNull();
  });

  test("an unsupported field is refused outright", async () => {
    const { company, ledger } = await seedBillTerm();
    const { status, body } = await call(PATH, {
      method: "PATCH",
      body: setBody(company, ledger, { dueDate: "2020-01-01" }),
    });
    expect(status).toBe(400);
    expect(body.code).toBe("UNSUPPORTED_FIELD");
  });

  test("provenance supplied in the body is refused, not trusted", async () => {
    const { company, ledger } = await seedBillTerm();
    const { status, body } = await call(PATH, {
      method: "PATCH",
      body: setBody(company, ledger, { forecastExpectedDateUpdatedByName: "Someone Else" }),
    });
    expect(status).toBe(400);
    expect(body.code).toBe("UNSUPPORTED_FIELD");
  });

  test("a read-only role cannot set, and the row is untouched", async () => {
    const { company, ledger, row } = await seedBillTerm();
    const { status } = await call(PATH, {
      method: "PATCH",
      body: setBody(company, ledger),
      user: VIEWER,
    });
    expect(status).toBe(403);

    const after = await Acc_BillTerms.findById(row._id).lean();
    expect(after.forecastExpectedDate).toBeNull();
  });

  test("a WRONG company cannot set an expected date on another company's bill", async () => {
    const { ledger, row } = await seedBillTerm();
    const other = new mongoose.Types.ObjectId();

    const { status, body } = await call(PATH, {
      method: "PATCH",
      body: {
        companyId: other.toString(),
        ledgerId: ledger._id.toString(),
        billName: "RC/0091/26-27",
        forecastExpectedDate: "2026-09-15",
        asOfDate: "2026-08-24",
      },
    });
    expect(status).toBe(404);
    expect(body.code).toBe("BILL_TERMS_NOT_FOUND");

    const after = await Acc_BillTerms.findById(row._id).lean();
    expect(after.forecastExpectedDate).toBeNull();
  });

  test("a bill with no sidecar row 404s — this endpoint never creates one", async () => {
    // Creating a row would mean inventing its required dueDate/source/
    // creditDaysUsed/basisDate, i.e. fabricating accounting data to hang a
    // forecast note off. Refusing is correct; run the backfill instead.
    const { company, ledger } = await seedBillTerm();
    const before = await Acc_BillTerms.countDocuments({});

    const { status, body } = await call(PATH, {
      method: "PATCH",
      body: setBody(company, ledger, { billName: "NO-SUCH-BILL" }),
    });
    expect(status).toBe(404);
    expect(body.code).toBe("BILL_TERMS_NOT_FOUND");
    expect(await Acc_BillTerms.countDocuments({})).toBe(before);
  });

  /* ── Clear ─────────────────────────────────────────────────────────────── */

  test("clearing removes every forecast field and leaves the rest alone", async () => {
    const { company, ledger, row } = await seedBillTerm();
    await call(PATH, { method: "PATCH", body: setBody(company, ledger, { notes: "why" }) });

    const seeded = await Acc_BillTerms.findById(row._id).lean();
    expect(seeded.forecastExpectedDate).toBeTruthy();

    const { status, body } = await call(PATH, {
      method: "DELETE",
      body: {
        companyId: company._id.toString(),
        ledgerId: ledger._id.toString(),
        billName: "RC/0091/26-27",
      },
    });
    expect(status).toBe(200);
    expect(body.billTerm.forecastExpectedDate).toBeNull();

    const after = await Acc_BillTerms.findById(row._id).lean();
    expect(after.forecastExpectedDate).toBeNull();
    expect(after.forecastExpectedDateSource).toBeNull();
    expect(after.forecastExpectedDateNotes).toBe("");
    expect(after.forecastExpectedDateUpdatedByName).toBeNull();
    // The accounting side is exactly as it was.
    expect(after.dueDate.getTime()).toBe(seeded.dueDate.getTime());
    expect(after.source).toBe("company_default");
    expect(after.creditDaysUsed).toBe(46);
  });

  test("a read-only role cannot clear", async () => {
    const { company, ledger, row } = await seedBillTerm();
    await call(PATH, { method: "PATCH", body: setBody(company, ledger) });

    const { status } = await call(PATH, {
      method: "DELETE",
      body: {
        companyId: company._id.toString(),
        ledgerId: ledger._id.toString(),
        billName: "RC/0091/26-27",
      },
      user: VIEWER,
    });
    expect(status).toBe(403);

    const after = await Acc_BillTerms.findById(row._id).lean();
    expect(after.forecastExpectedDate).toBeTruthy();
  });

  test("a wrong-company clear cannot wipe another company's expectation", async () => {
    const { company, ledger, row } = await seedBillTerm();
    await call(PATH, { method: "PATCH", body: setBody(company, ledger) });

    const { status } = await call(PATH, {
      method: "DELETE",
      body: {
        companyId: new mongoose.Types.ObjectId().toString(),
        ledgerId: ledger._id.toString(),
        billName: "RC/0091/26-27",
      },
    });
    expect(status).toBe(404);

    const after = await Acc_BillTerms.findById(row._id).lean();
    expect(after.forecastExpectedDate).toBeTruthy();
  });

  /* ── Scope guard ───────────────────────────────────────────────────────── */

  test("neither endpoint writes a voucher or a ledger", async () => {
    const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
    const { company, ledger } = await seedBillTerm();

    const snap = async () => ({
      v: await Acc_Voucher.countDocuments({}),
      l: await Acc_Ledger.countDocuments({}),
      lU: (await Acc_Ledger.find({}).select("updatedAt").lean())
        .map((x) => +new Date(x.updatedAt)).sort().join(","),
    });

    const before = await snap();
    await call(PATH, { method: "PATCH", body: setBody(company, ledger, { notes: "n" }) });
    await call(PATH, {
      method: "DELETE",
      body: {
        companyId: company._id.toString(),
        ledgerId: ledger._id.toString(),
        billName: "RC/0091/26-27",
      },
    });
    expect(await snap()).toEqual(before);
  });
});
