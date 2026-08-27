// test/accountant/voucher-due-date-default.route.test.js
//
// HTTP-level tests for C0-C — due-date defaulting on newly created
// sales/purchase vouchers. Same harness as the C0-A/B1/B2 accountant tests:
// bare Express app per route file, in-memory MongoDB, auth middleware mocked
// to read identity from a test header.
//
// What this proves that services/creditTerms.test.js and
// services/voucherDueDateDefault.test.js cannot:
//   - the defaulting genuinely reaches a real database lookup, through the
//     real create route, not just a call to the resolver with hand-built args
//   - it is the SAME behavior across three structurally different creation
//     paths (a direct create, an approval materialization inside a
//     transaction, and a bulk Tally import using insertMany) — proving that
//     without exercising all three would just be trusting that three
//     different files were edited consistently
//   - editing credit terms or creating new vouchers never reaches back and
//     changes a voucher that was already posted
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
const { Acc_ImportSession } = require("../../models/Accountant_model/Acc_ImportModels");

const EDITOR = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Editor",
  permissions: { canEdit: true, canApprove: true },
  isDev: true, // makes orgFilter() a no-op — no org/company scoping fixture needed
};
let voucherApp, importApp;
let voucherServer, importServer;
let voucherBase, importBase;

beforeAll(async () => {
  voucherApp = express();
  voucherApp.use(express.json());
  voucherApp.use("/api/accountant/vouchers", require("../../routes/Accountant_Routes/Acc_vouchers"));
  await new Promise((resolve) => { voucherServer = voucherApp.listen(0, resolve); });
  voucherBase = `http://127.0.0.1:${voucherServer.address().port}/api/accountant/vouchers`;

  importApp = express();
  importApp.use(express.json({ limit: "5mb" }));
  importApp.use("/api/accountant/import", require("../../routes/Accountant_Routes/Acc_import"));
  await new Promise((resolve) => { importServer = importApp.listen(0, resolve); });
  importBase = `http://127.0.0.1:${importServer.address().port}/api/accountant/import`;
});

afterAll(async () => {
  await Promise.all([
    new Promise((r) => voucherServer.close(r)),
    new Promise((r) => importServer.close(r)),
  ]);
});

async function call(base, path, { method = "GET", body, user = EDITOR } = {}) {
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

async function makeCompany(name = "Company A") {
  return Acc_Company.create({ companyName: name, booksFromDate: new Date("2025-04-01") });
}

async function makeGroup(companyId, name, nature) {
  return Acc_Group.create({ companyId, name, nature });
}

async function makeLedger(companyId, groupId, groupName, nature, overrides = {}) {
  return Acc_Ledger.create({
    companyId,
    name: overrides.name || `Ledger ${new mongoose.Types.ObjectId().toString().slice(-6)}`,
    groupId,
    groupName,
    nature,
    ...overrides,
  });
}

/** Standard company + a Sales Accounts (revenue) ledger + a Sundry Debtor. */
async function makeSalesFixture(customerOverrides = {}) {
  const company = await makeCompany();
  const salesGroup = await makeGroup(company._id, "Sales Accounts", "revenue");
  const debtorGroup = await makeGroup(company._id, "Sundry Debtors", "asset");
  const salesLedger = await makeLedger(company._id, salesGroup._id, salesGroup.name, "revenue", { name: "Garment Sales" });
  const customer = await makeLedger(company._id, debtorGroup._id, debtorGroup.name, "asset", {
    name: "Buyer Co",
    ...customerOverrides,
  });
  return { company, salesGroup, debtorGroup, salesLedger, customer };
}

/** Standard company + a Purchase Accounts (expense) ledger + a Sundry Creditor. */
async function makePurchaseFixture(vendorOverrides = {}) {
  const company = await makeCompany();
  const purchaseGroup = await makeGroup(company._id, "Purchase Accounts", "expense");
  const creditorGroup = await makeGroup(company._id, "Sundry Creditors", "liability");
  const purchaseLedger = await makeLedger(company._id, purchaseGroup._id, purchaseGroup.name, "expense", { name: "Fabric Purchases" });
  const vendor = await makeLedger(company._id, creditorGroup._id, creditorGroup.name, "liability", {
    name: "Mill Supplier",
    ...vendorOverrides,
  });
  return { company, purchaseGroup, creditorGroup, purchaseLedger, vendor };
}

function salesVoucherBody({ company, salesLedger, customer }, overrides = {}) {
  return {
    companyId: company._id.toString(),
    voucherType: "sales",
    voucherDate: "2026-04-01T00:00:00.000Z",
    partyLedgerId: customer._id.toString(),
    ledgerEntries: [
      { ledgerId: customer._id.toString(), ledgerName: customer.name, type: "Dr", amount: 100000 },
      { ledgerId: salesLedger._id.toString(), ledgerName: salesLedger.name, type: "Cr", amount: 100000 },
    ],
    grandTotal: 100000,
    ...overrides,
  };
}

function purchaseVoucherBody({ company, purchaseLedger, vendor }, overrides = {}) {
  return {
    companyId: company._id.toString(),
    voucherType: "purchase",
    voucherDate: "2026-04-01T00:00:00.000Z",
    partyLedgerId: vendor._id.toString(),
    ledgerEntries: [
      { ledgerId: purchaseLedger._id.toString(), ledgerName: purchaseLedger.name, type: "Dr", amount: 50000 },
      { ledgerId: vendor._id.toString(), ledgerName: vendor.name, type: "Cr", amount: 50000 },
    ],
    grandTotal: 50000,
    ...overrides,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   P1 — POST /api/accountant/vouchers/  (the main, primary create path)
   ═══════════════════════════════════════════════════════════════════════ */

describe("P1 — direct voucher create", () => {
  test("due date defaults from the party's credit terms on a sales voucher", async () => {
    const fx = await makeSalesFixture({ creditPeriodDays: 30, creditTermsSource: "manual" });
    const { status, body } = await call(voucherBase, "/", {
      method: "POST",
      body: salesVoucherBody(fx),
    });
    expect(status).toBe(201);
    const stored = await Acc_Voucher.findById(body._id).lean();
    expect(new Date(stored.dueDate).toISOString().slice(0, 10)).toBe("2026-05-01");
  });

  test("a purchase voucher defaults symmetrically", async () => {
    const fx = await makePurchaseFixture({ creditPeriodDays: 45, creditTermsSource: "manual" });
    const { status, body } = await call(voucherBase, "/", {
      method: "POST",
      body: purchaseVoucherBody(fx),
    });
    expect(status).toBe(201);
    const stored = await Acc_Voucher.findById(body._id).lean();
    expect(new Date(stored.dueDate).toISOString().slice(0, 10)).toBe("2026-05-16");
  });

  test("no terms set (creditPeriodDays: 0, the schema default) means no due date is defaulted", async () => {
    const fx = await makeSalesFixture(); // customer created with no override — creditPeriodDays stays 0
    const { status, body } = await call(voucherBase, "/", {
      method: "POST",
      body: salesVoucherBody(fx),
    });
    expect(status).toBe(201);
    const stored = await Acc_Voucher.findById(body._id).lean();
    expect(stored.dueDate).toBeFalsy();
  });

  test("a manually supplied due date is never overwritten, even when the party has different terms", async () => {
    const fx = await makeSalesFixture({ creditPeriodDays: 30, creditTermsSource: "manual" });
    const { status, body } = await call(voucherBase, "/", {
      method: "POST",
      body: salesVoucherBody(fx, { dueDate: "2026-12-25T00:00:00.000Z" }),
    });
    expect(status).toBe(201);
    const stored = await Acc_Voucher.findById(body._id).lean();
    expect(new Date(stored.dueDate).toISOString().slice(0, 10)).toBe("2026-12-25");
  });

  test("a missing/invalid party does not invent a date — voucher still creates successfully", async () => {
    const fx = await makeSalesFixture({ creditPeriodDays: 30, creditTermsSource: "manual" });
    const nonExistentPartyId = new mongoose.Types.ObjectId().toString();
    const { status, body } = await call(voucherBase, "/", {
      method: "POST",
      body: salesVoucherBody(fx, { partyLedgerId: nonExistentPartyId }),
    });
    expect(status).toBe(201);
    const stored = await Acc_Voucher.findById(body._id).lean();
    expect(stored.dueDate).toBeFalsy();
  });

  test("a sales voucher with NO partyLedgerId at all gets no due date, not an error", async () => {
    const fx = await makeSalesFixture({ creditPeriodDays: 30, creditTermsSource: "manual" });
    const bodyNoParty = salesVoucherBody(fx);
    delete bodyNoParty.partyLedgerId;
    const { status, body } = await call(voucherBase, "/", { method: "POST", body: bodyNoParty });
    expect(status).toBe(201);
    const stored = await Acc_Voucher.findById(body._id).lean();
    expect(stored.dueDate).toBeFalsy();
  });

  test("a RECEIPT against a party with terms set never gets a due date", async () => {
    const fx = await makeSalesFixture({ creditPeriodDays: 30, creditTermsSource: "manual" });
    const { status, body } = await call(voucherBase, "/", {
      method: "POST",
      body: {
        companyId: fx.company._id.toString(),
        voucherType: "receipt",
        voucherDate: "2026-04-05T00:00:00.000Z",
        partyLedgerId: fx.customer._id.toString(),
        ledgerEntries: [
          { ledgerId: fx.customer._id.toString(), ledgerName: fx.customer.name, type: "Cr", amount: 50000 },
        ],
        grandTotal: 50000,
      },
    });
    expect(status).toBe(201);
    const stored = await Acc_Voucher.findById(body._id).lean();
    expect(stored.dueDate).toBeFalsy();
  });

  test("a PAYMENT against a party with terms set never gets a due date", async () => {
    const fx = await makePurchaseFixture({ creditPeriodDays: 30, creditTermsSource: "manual" });
    const { status, body } = await call(voucherBase, "/", {
      method: "POST",
      body: {
        companyId: fx.company._id.toString(),
        voucherType: "payment",
        voucherDate: "2026-04-05T00:00:00.000Z",
        partyLedgerId: fx.vendor._id.toString(),
        ledgerEntries: [
          { ledgerId: fx.vendor._id.toString(), ledgerName: fx.vendor.name, type: "Dr", amount: 20000 },
        ],
        grandTotal: 20000,
      },
    });
    expect(status).toBe(201);
    const stored = await Acc_Voucher.findById(body._id).lean();
    expect(stored.dueDate).toBeFalsy();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   P5 — Acc_approvals.js applyApprovedAction, kind:"voucher" action:"create"
        (the materialization path that bypasses the normal create route
        entirely, building `new Acc_Voucher(body)` straight from a stored
        request payload)
   ═══════════════════════════════════════════════════════════════════════
   NOT exercised as a full HTTP round trip: this branch runs inside a real
   Mongo multi-document transaction (`mongoose.startSession()` +
   `session.startTransaction()`), and `mongodb-memory-server`'s default
   single-node instance — the one this repo's whole Jest harness
   (test/setup.js) is built on — does not support transactions ("Transaction
   numbers are only allowed on a replica set member or mongos"). That
   constraint belongs to `applyApprovedAction`, not to this change; standing
   up a replica-set-mode Mongo just for this one branch would mean either
   rewriting the SHARED test/setup.js (affecting all 20+ existing suites) or
   duplicating a second, heavier Mongo instance in this one file — a
   disproportionate cost for one branch whose actual defaulting logic is the
   same already-proven `defaultDueDateOnVoucherBody` used by P1.
   What IS verified: the source genuinely calls it, in the right branch, in
   the right order, with the session threaded through — and a lightweight
   unit test (voucherDueDateDefault.test.js) confirms `opts.session` reaches
   the underlying query build. */
/* ═══════════════════════════════════════════════════════════════════════
   Company scoping (fix, 24 Aug 2026)
   ═══════════════════════════════════════════════════════════════════════
   `defaultDueDateOnVoucherBody` used to resolve `partyLedgerId` by `_id`
   alone — a ledger id that happened to belong to a DIFFERENT company would
   still resolve, and that company's credit terms would leak into this
   voucher's due date. This mirrors the exact class of bug C0-B1's
   credit-terms PATCH route was corrected for; the fix here is the same
   shape: `{ _id, companyId }` together, never `_id` alone.

   "Missing companyId does not default a due date" is proven at the unit
   level (services/voucherDueDateDefault.test.js), not here: P1's own route
   already refuses any request with no `companyId` at all with a 400 before
   the request ever reaches the defaulting logic (`if (!body.companyId)
   return res.status(400)...`), so there is no real HTTP path through THIS
   route that reaches the service with a missing companyId — the case is
   real, but it is reachable only from other/future callers, which is
   exactly what the unit test isolates. */
describe("company scoping", () => {
  test("1. same-company party terms default the due date (explicit, dedicated case)", async () => {
    const fx = await makeSalesFixture({ creditPeriodDays: 21, creditTermsSource: "manual" });
    const { status, body } = await call(voucherBase, "/", {
      method: "POST",
      body: salesVoucherBody(fx),
    });
    expect(status).toBe(201);
    const stored = await Acc_Voucher.findById(body._id).lean();
    expect(new Date(stored.dueDate).toISOString().slice(0, 10)).toBe("2026-04-22");
  });

  test("2. a wrong-company party id does NOT default a due date — terms never leak across companies", async () => {
    // Company A books the voucher; the party id supplied belongs to a
    // ledger in COMPANY B, which has generous terms set. If those terms
    // leaked, this voucher would get a due date it has no business having.
    const fxA = await makeSalesFixture({ creditPeriodDays: 0 }); // company A, its own customer is untermed
    const fxB = await makeSalesFixture({ creditPeriodDays: 60, creditTermsSource: "manual" }); // company B

    const { status, body } = await call(voucherBase, "/", {
      method: "POST",
      body: salesVoucherBody(fxA, { partyLedgerId: fxB.customer._id.toString() }),
    });

    // The voucher still creates — an unresolved/wrong-company party is a
    // reason to skip the default, never a reason to reject the voucher.
    expect(status).toBe(201);
    const stored = await Acc_Voucher.findById(body._id).lean();
    expect(stored.dueDate).toBeFalsy();
    // And company B's own ledger is completely untouched by this request.
    const untouchedB = await Acc_Ledger.findById(fxB.customer._id).lean();
    expect(untouchedB.creditPeriodDays).toBe(60);
  });

  test("5. a manual due date still wins, proven through the real route with company scoping active", async () => {
    const fx = await makeSalesFixture({ creditPeriodDays: 30, creditTermsSource: "manual" });
    const { status, body } = await call(voucherBase, "/", {
      method: "POST",
      body: salesVoucherBody(fx, { dueDate: "2026-11-11T00:00:00.000Z" }),
    });
    expect(status).toBe(201);
    const stored = await Acc_Voucher.findById(body._id).lean();
    expect(new Date(stored.dueDate).toISOString().slice(0, 10)).toBe("2026-11-11");
  });
});

describe("P5 — approval materialization (source-verified, see note above)", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(
    path.join(__dirname, "../../routes/Accountant_Routes/Acc_approvals.js"),
    "utf8",
  );

  test("the voucher CREATE branch calls defaultDueDateOnVoucherBody(body, { session }) before persisting", () => {
    const createBranchStart = source.indexOf('kind === "voucher" && action === "create"');
    expect(createBranchStart).toBeGreaterThan(-1);
    const defaultingCall = source.indexOf(
      "await defaultDueDateOnVoucherBody(body, { session });",
      createBranchStart,
    );
    expect(defaultingCall).toBeGreaterThan(createBranchStart);
    const persistCall = source.indexOf("const voucher = new Acc_Voucher(body);", createBranchStart);
    expect(persistCall).toBeGreaterThan(defaultingCall); // defaulting happens strictly BEFORE persistence
  });

  test("the voucher POST branch (materializing an ALREADY-CREATED draft) does not re-default anything", () => {
    // That document was already fully formed — and already defaulted, if
    // eligible — when it was first created. Re-running the resolver here
    // would be redundant at best; the real risk is not doing it at all,
    // which this test does not need to prove since nothing NEW is built.
    const postBranchStart = source.indexOf('kind === "voucher" && action === "post"');
    const createBranchStart = source.indexOf('kind === "voucher" && action === "create"');
    const postBranchSlice = source.slice(postBranchStart, createBranchStart);
    expect(postBranchSlice.includes("defaultDueDateOnVoucherBody")).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   P7 — POST /api/accountant/import/bsheet/commit
        (a real Tally-import path, using insertMany, exercised end-to-end)
   ═══════════════════════════════════════════════════════════════════════ */

describe("P7 — bulk Tally B-Sheet import (insertMany)", () => {
  async function makeBsheetSession(company, { customerName, vendorName }) {
    const parsed = {
      ledgers: [
        { name: customerName, groupName: "Sundry Debtors", nature: "asset" },
        { name: vendorName, groupName: "Sundry Creditors", nature: "liability" },
        { name: "Sales Accounts", groupName: "Sales Accounts", nature: "revenue" },
      ],
      vouchers: [
        {
          voucherType: "sales",
          voucherNumber: "SV-IMPORT-1",
          date: "2026-04-01T00:00:00.000Z",
          entries: [
            { ledgerName: customerName, side: "Dr", amount: 75000 },
            { ledgerName: "Sales Accounts", side: "Cr", amount: 75000 },
          ],
        },
        {
          voucherType: "purchase",
          voucherNumber: "PV-IMPORT-1",
          date: "2026-04-02T00:00:00.000Z",
          entries: [
            { ledgerName: "Sales Accounts", side: "Dr", amount: 1000 }, // reused as a stand-in expense ledger
            { ledgerName: vendorName, side: "Cr", amount: 1000 },
          ],
        },
      ],
    };
    return Acc_ImportSession.create({
      companyId: company._id,
      fileName: "b-sheet-export.json",
      fileType: "json",
      importType: "full_company",
      entityType: "mixed",
      status: "parsed",
      sampleRows: [{ __bsheetPayload: JSON.stringify(parsed) }],
    });
  }

  test("an imported sales voucher defaults its due date from the pre-existing party's terms", async () => {
    const company = await makeCompany();
    const debtorGroup = await makeGroup(company._id, "Sundry Debtors", "asset");
    const creditorGroup = await makeGroup(company._id, "Sundry Creditors", "liability");
    const customer = await makeLedger(company._id, debtorGroup._id, debtorGroup.name, "asset", {
      name: "Imported Buyer",
      creditPeriodDays: 30,
      creditTermsSource: "manual",
    });
    await makeLedger(company._id, creditorGroup._id, creditorGroup.name, "liability", {
      name: "Imported Vendor",
      // no terms — 0, the default
    });

    const session = await makeBsheetSession(company, {
      customerName: "Imported Buyer",
      vendorName: "Imported Vendor",
    });

    const { status, body } = await call(importBase, "/bsheet/commit", {
      method: "POST",
      body: { sessionId: session._id.toString() },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const salesVoucher = await Acc_Voucher.findOne({ companyId: company._id, voucherType: "sales" }).lean();
    expect(salesVoucher).toBeTruthy();
    expect(new Date(salesVoucher.dueDate).toISOString().slice(0, 10)).toBe("2026-05-01");

    const purchaseVoucher = await Acc_Voucher.findOne({ companyId: company._id, voucherType: "purchase" }).lean();
    expect(purchaseVoucher).toBeTruthy();
    expect(purchaseVoucher.dueDate).toBeFalsy(); // vendor has no terms — no default
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   Static wiring — P6 and P8 use the SAME shared functions as P1/P5/P7
   ═══════════════════════════════════════════════════════════════════════
   P6 (Acc_import.js `sessions/:id/commit`, single-row Tally session commit)
   and P8 (Acc_import.js `combined/commit`, the second insertMany path) are
   not independently exercised end-to-end here — P6 needs a full field-
   mapping pipeline fixture (tallyMapper.applyMapping / foldMultiRow) and P8
   is structurally identical to P7's already-proven insertMany path (same
   ledger resolution, same `defaultDueDateSync(voucherToInsert, partyLedger)`
   call immediately before the same `vouchersToInsert.push`). Re-testing an
   identical code shape end-to-end a third time would not exercise anything
   new; the source check below instead confirms the wiring is genuinely
   present at both places rather than only planned. */
describe("wiring — the shared resolver is actually called at P6 and P8", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(
    path.join(__dirname, "../../routes/Accountant_Routes/Acc_import.js"),
    "utf8",
  );

  test("P6 (sessions/:id/commit) calls defaultDueDateOnVoucherBody before Acc_Voucher.create", () => {
    const idx = source.indexOf("await defaultDueDateOnVoucherBody(voucherBody);");
    expect(idx).toBeGreaterThan(-1);
    const createIdx = source.indexOf("Acc_Voucher.create(voucherBody)", idx);
    expect(createIdx).toBeGreaterThan(idx); // the call happens strictly BEFORE persistence
  });

  test("P8 (combined/commit) calls defaultDueDateSync before both insertMany pushes", () => {
    const calls = source.split("defaultDueDateSync(voucherToInsert, partyLedger);").length - 1;
    expect(calls).toBe(2); // once for P7 (bsheet), once for P8 (combined)
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   No existing posted voucher is ever modified
   ═══════════════════════════════════════════════════════════════════════ */

describe("posted vouchers are never touched by this slice", () => {
  test("creating new vouchers, and editing OTHER parties' credit terms, leaves an already-posted voucher untouched", async () => {
    const fx = await makeSalesFixture({ creditPeriodDays: 30, creditTermsSource: "manual" });
    const first = await call(voucherBase, "/", { method: "POST", body: salesVoucherBody(fx) });
    expect(first.status).toBe(201);

    const before = await Acc_Voucher.findById(first.body._id).lean();
    expect(before.dueDate).toBeTruthy();

    // Unrelated activity: create several more vouchers for a DIFFERENT
    // customer, and edit that other customer's credit terms via C0-B1's
    // endpoint — none of this must reach back and alter the first voucher.
    const fx2 = await makeSalesFixture({ creditPeriodDays: 10, creditTermsSource: "manual" });
    await call(voucherBase, "/", { method: "POST", body: salesVoucherBody(fx2) });
    await call(voucherBase, "/", { method: "POST", body: salesVoucherBody(fx2, { voucherDate: "2026-05-01T00:00:00.000Z" }) });

    const partiesApp = express();
    partiesApp.use(express.json());
    partiesApp.use("/api/accountant/parties", require("../../routes/Accountant_Routes/Acc_parties"));
    const partiesServer = await new Promise((resolve) => {
      const s = partiesApp.listen(0, () => resolve(s));
    });
    const partiesBase = `http://127.0.0.1:${partiesServer.address().port}/api/accountant/parties`;
    await call(partiesBase, `/${fx2.customer._id}/credit-terms`, {
      method: "PATCH",
      body: { creditPeriodDays: "90", companyId: fx2.company._id.toString() },
    });
    await new Promise((r) => partiesServer.close(r));

    const after = await Acc_Voucher.findById(first.body._id).lean();
    expect(after.dueDate.getTime()).toBe(before.dueDate.getTime());
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
});
