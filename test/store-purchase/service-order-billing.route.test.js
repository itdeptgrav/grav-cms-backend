// test/store-purchase/service-order-billing.route.test.js
//
// ACCEPTED SERVICE ORDER → SUPPLIER PURCHASE VOUCHER (S3).
//
// The service counterpart of PO→voucher billing. It reuses the EXISTING
// purchase-voucher form and the EXISTING budget-commitment release; this suite
// proves the new linkage and the acceptance/company boundaries, and that
// nothing here touches stock, goods receipts or inventory.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

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
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const Commitment = require("../../models/Accountant_model/Acc_BudgetCommitment");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const ServiceOrder = require("../../models/CMS_Models/Inventory/Operations/ServiceOrder");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const { planEveryItem } = require("../requests/plannedItems.helper");
const commitments = require("../../services/budgetCommitment.service");

let server, base, seq = 0;
const USER = { id: new mongoose.Types.ObjectId().toString(), name: "Acct", isDev: true };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/accountant/vouchers", require("../../routes/Accountant_Routes/Acc_vouchers"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/vouchers`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(USER) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/* A company, a head, a live line, an approved SERVICE request, its commitment,
   and an ACCEPTED Service Order raised from it. */
async function seed({ soStatus = "ACCEPTED", amount = 12000 } = {}) {
  const n = seq++;
  const company = await Acc_Company.create({ companyName: `Bill Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const group = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const ledger = await Acc_Ledger.create({ companyId: company._id, name: `Repairs ${n}`, groupId: group._id, groupName: group.name, nature: "expense" });
  const budget = await Acc_Budget.create({
    name: `Budget ${n}`, financialYear: "2026-27", period: "yearly", status: "active",
    startDate: new Date("2026-03-31T18:30:00.000Z"), endDate: new Date("2027-03-31T18:29:59.999Z"),
    companyId: company._id,
    items: [{ ledgerId: ledger._id, ledgerName: ledger.name, nature: "expense", department: "Logistics", allocatedAmount: 50000 }],
  });
  await planEveryItem(budget);
  const line = budget.items[0];
  const vendorLedger = await Acc_Ledger.create({ companyId: company._id, name: `Fix It Co ${n}`, groupId: group._id, groupName: group.name, nature: "expense" });

  const request = await SpendRequest.create({
    title: "AMC", requestType: "SERVICE", requestedBy: new mongoose.Types.ObjectId(), requestedByName: "Rutu",
    requestedById: `EM${n}`, department: "Logistics", companyId: company._id, ledgerId: ledger._id, ledgerName: ledger.name,
    purpose: "Annual maintenance",
    items: [{ name: "Annual visit", whyNeeded: "yearly", quantity: 4, unit: "visit", rate: amount / 4, amount }],
    totalAmount: amount, status: "approved", budgetCycleId: budget._id, budgetLineId: line._id, budgetMatchStatus: "matched",
  });
  const { commitment } = await commitments.commit({ request, actor: { email: "fin@x", name: "Fin" } });
  await SpendRequest.updateOne({ _id: request._id }, { $set: { commitmentId: commitment._id } });

  const so = await ServiceOrder.create({
    companyId: company._id, serviceOrderNumber: `SVO/2026-27/${String(n).padStart(4, "0")}`,
    spendRequestId: request._id, spendRequestNumber: request.requestNumber,
    vendorName: `Fix It Co ${n}`, vendorGstin: "27ABCDE1234F1Z5", title: "AMC", department: "Logistics",
    budgetLedgerId: ledger._id, budgetLedgerName: ledger.name, commitmentId: commitment._id,
    lines: [{ service: new mongoose.Types.ObjectId(), serviceCode: "SVC-1", serviceName: "AMC",
      description: "Annual visit", billingUnit: "visit", sacCode: "9987",
      quantity: 4, rate: amount / 4, netAmount: amount, gstRate: 18, gstAmount: amount * 0.18, lineTotal: amount * 1.18 }],
    subtotal: amount, taxAmount: amount * 0.18, totalAmount: amount * 1.18, taxRate: 18, taxMode: "SINGLE_RATE",
    status: soStatus,
  });
  return { company, ledger, vendorLedger, budget, line, request, commitment, so };
}

/* A voucher created directly, exactly the way the release harness does — the
   model's post-save hook releases the commitment on `posted`. */
const voucher = ({ company, ledger, amount = 14160, status = "posted", link = {} }) =>
  Acc_Voucher.create({
    companyId: company._id, voucherType: "purchase", voucherNumber: `V/${seq++}/${Math.random().toString(36).slice(2)}`,
    voucherDate: new Date("2026-08-10"), status, grandTotal: amount, ...link,
    ledgerEntries: [{ ledgerId: ledger._id, ledgerName: ledger.name, type: "Dr", amount }],
  });

/* ═══ THE BILLABLE PREFILL ════════════════════════════════════════════════ */

describe("the accounting billable-service prefill", () => {
  test("only an ACCEPTED service order can be billed", async () => {
    const s = await seed({ soStatus: "COMPLETION_REPORTED" });
    const r = await call(`/service-order/${s.so._id}/billable?companyId=${s.company._id}`);
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("NOT_ACCEPTED");
    expect(r.body.message).toMatch(/accepted/i);
  });

  test("a cancelled order is a clear refusal, not an empty response", async () => {
    const s = await seed({ soStatus: "CANCELLED" });
    const r = await call(`/service-order/${s.so._id}/billable?companyId=${s.company._id}`);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/cancelled/i);
  });

  test("another company cannot access the order", async () => {
    const s = await seed();
    const other = await Acc_Company.create({ companyName: "Other", booksFromDate: new Date("2026-04-01") });
    const r = await call(`/service-order/${s.so._id}/billable?companyId=${other._id}`);
    expect(r.status).toBe(404);
  });

  test("prefill uses the approved order snapshots and non-stock charge lines", async () => {
    const s = await seed();
    const r = await call(`/service-order/${s.so._id}/billable?companyId=${s.company._id}`);
    expect(r.status).toBe(200);
    const p = r.body.prefill;
    expect(p.serviceOrderNumber).toBe(s.so.serviceOrderNumber);
    expect(String(p.spendRequestId)).toBe(String(s.request._id));
    expect(String(p.budgetCommitmentId)).toBe(String(s.commitment._id));
    expect(p.vendor.name).toBe(s.so.vendorName);
    expect(String(p.budgetLedgerId)).toBe(String(s.ledger._id));
    /* Approved figures, as comparison values (never called the actual cost). */
    expect(p.approved.subtotal).toBe(12000);
    expect(p.approved.totalAmount).toBe(Math.round(12000 * 1.18 * 100) / 100);
    /* Lines are non-stock expense charges — no stock item, has SAC/billing unit. */
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0].isCharge).toBe(true);
    expect(p.lines[0].stockItemId == null).toBe(true);
    expect(p.lines[0].billingUnit).toBe("visit");
    expect(p.lines[0].sacCode).toBe("9987");
    expect(p.lines[0].quantity).toBe(4);
    /* No stock/GRN/warehouse/inventory semantics anywhere in the response. */
    const asText = JSON.stringify(r.body);
    expect(asText).not.toMatch(/stockItemId":"[0-9a-f]/i);
    expect(asText).not.toMatch(/goodsReceipt|grn|warehouse|inventoryQty/i);
  });

  test("existing linked vouchers are returned separately with honest statuses", async () => {
    const s = await seed();
    await voucher({ company: s.company, ledger: s.ledger, status: "draft", link: { serviceOrderId: s.so._id } });
    const r = await call(`/service-order/${s.so._id}/billable?companyId=${s.company._id}`);
    expect(r.body.linkedVouchers).toHaveLength(1);
    expect(r.body.linkedVouchers[0].status).toBe("draft");
    expect(r.body.hasLiveVoucher).toBe(true);
  });

  test("a cancelled bill does not count as a live voucher", async () => {
    const s = await seed();
    await voucher({ company: s.company, ledger: s.ledger, status: "cancelled", link: { serviceOrderId: s.so._id } });
    const r = await call(`/service-order/${s.so._id}/billable?companyId=${s.company._id}`);
    expect(r.body.hasLiveVoucher).toBe(false);
    expect(r.body.linkedVouchers).toHaveLength(1); // shown, but not "live"
  });
});

/* ═══ THE VOUCHER LINK + BUDGET LIFECYCLE ═════════════════════════════════ */

describe("the supplier voucher carries the links and drives the commitment", () => {
  const create = (s, over = {}) => call("/", { method: "POST", body: {
    companyId: String(s.company._id), voucherType: "purchase", voucherDate: "2026-08-10",
    voucherNumber: `V/${seq++}/${Math.random().toString(36).slice(2)}`,
    serviceOrderId: String(s.so._id), serviceOrderNumber: s.so.serviceOrderNumber,
    spendRequestId: String(s.request._id), budgetCommitmentId: String(s.commitment._id),
    partyLedgerId: String(s.vendorLedger._id),
    ledgerEntries: [
      { ledgerId: String(s.ledger._id), ledgerName: s.ledger.name, type: "Dr", amount: 14160 },
      { ledgerId: String(s.vendorLedger._id), ledgerName: s.vendorLedger.name, type: "Cr", amount: 14160 },
    ],
    grandTotal: 14160, ...over,
  } });

  test("a submitted voucher stores the service-order, spend-request and commitment links", async () => {
    const s = await seed();
    const r = await create(s);
    expect([200, 201]).toContain(r.status);
    const v = await Acc_Voucher.findOne({ serviceOrderId: s.so._id }).lean();
    expect(v).toBeTruthy();
    expect(String(v.serviceOrderId)).toBe(String(s.so._id));
    expect(v.serviceOrderNumber).toBe(s.so.serviceOrderNumber);
    expect(String(v.spendRequestId)).toBe(String(s.request._id));
    expect(String(v.budgetCommitmentId)).toBe(String(s.commitment._id));
    expect(v.sourceSystem).toBe("auto_from_service_order");
    /* The service-order link is its own — never the PO field. */
    expect(v.purchaseOrderId == null).toBe(true);
  });

  test("a draft voucher leaves the commitment committed and creates no actual", async () => {
    const s = await seed();
    await create(s, { status: "draft" });
    expect((await Commitment.findById(s.commitment._id)).status).toBe("committed");
  });

  test("a pending-approval voucher leaves the commitment committed", async () => {
    const s = await seed();
    await create(s, { status: "pending_approval" });
    expect((await Commitment.findById(s.commitment._id)).status).toBe("committed");
  });

  test("posting the service-order voucher releases the commitment exactly once", async () => {
    const s = await seed();
    /* Posted directly, the way the release harness proves the mechanism. */
    const v = await voucher({ company: s.company, ledger: s.ledger, status: "posted",
      link: { serviceOrderId: s.so._id, spendRequestId: s.request._id, budgetCommitmentId: s.commitment._id } });
    const c = await Commitment.findById(s.commitment._id).lean();
    expect(c.status).toBe("released");
    expect(String(c.releasedByVoucherId)).toBe(String(v._id));
    /* Idempotent — re-saving the posted voucher does not release twice. */
    await Acc_Voucher.updateOne({ _id: v._id }, { $set: { narration: "touch" } });
    const again = await Acc_Voucher.findById(v._id);
    await again.save();
    expect((await Commitment.findById(s.commitment._id)).status).toBe("released");
  });

  test("cancelling the releasing voucher restores the commitment", async () => {
    const s = await seed();
    const v = await voucher({ company: s.company, ledger: s.ledger, status: "posted",
      link: { serviceOrderId: s.so._id, spendRequestId: s.request._id, budgetCommitmentId: s.commitment._id } });
    expect((await Commitment.findById(s.commitment._id)).status).toBe("released");
    v.status = "cancelled";
    await v.save();
    expect((await Commitment.findById(s.commitment._id)).status).toBe("committed");
  });

  test("a different-company voucher cannot release the commitment", async () => {
    const s = await seed();
    const other = await Acc_Company.create({ companyName: "Elsewhere", booksFromDate: new Date("2026-04-01") });
    const otherGroup = await Acc_Group.create({ companyId: other._id, name: "Indirect Expenses", nature: "expense" });
    const otherLedger = await Acc_Ledger.create({ companyId: other._id, name: "X", groupId: otherGroup._id, groupName: otherGroup.name, nature: "expense" });
    /* A posted voucher in ANOTHER company naming this commitment. */
    await voucher({ company: other, ledger: otherLedger, status: "posted",
      link: { budgetCommitmentId: s.commitment._id } });
    expect((await Commitment.findById(s.commitment._id)).status).toBe("committed");
  });

  test("the existing goods PO voucher flow is unchanged", async () => {
    const s = await seed();
    /* A PO-linked voucher still releases via its request link and does NOT get
       a service-order id. */
    const po = await PurchaseOrder.create({
      companyId: s.company._id, poNumber: "PO/2026-27/0001", spendRequestId: s.request._id,
      items: [{ itemName: "x", quantity: 1, unitPrice: 1, totalPrice: 1 }], subtotal: 1, totalAmount: 1,
      createdBy: new mongoose.Types.ObjectId(),
    });
    const v = await voucher({ company: s.company, ledger: s.ledger, status: "posted",
      link: { purchaseOrderId: po._id, spendRequestId: s.request._id } });
    expect(v.serviceOrderId == null).toBe(true);
    expect((await Commitment.findById(s.commitment._id)).status).toBe("released");
  });
});

/* ═══ S3 CORRECTION — THE SUPPLIER-BILL LINK IS AUTHORITATIVE ══════════════
   A direct POST must not be able to bypass acceptance, invent links, name
   another company's commitment, duplicate a live bill without confirmation, or
   mix a PO and a service link. Provenance is the server's, derived from the
   accepted order — never the client's. */
describe("S3 correction — authoritative service-order billing on create", () => {
  const post = (body) => call("/", { method: "POST", body });
  const goodEntries = (s, amount = 14160) => [
    { ledgerId: String(s.ledger._id), ledgerName: s.ledger.name, type: "Dr", amount },
    { ledgerId: String(s.vendorLedger._id), ledgerName: s.vendorLedger.name, type: "Cr", amount },
  ];
  const base = (s, over = {}) => ({
    companyId: String(s.company._id), voucherType: "purchase", voucherDate: "2026-08-10",
    voucherNumber: `V/${seq++}/${Math.random().toString(36).slice(2)}`,
    serviceOrderId: String(s.so._id),
    partyLedgerId: String(s.vendorLedger._id),
    ledgerEntries: goodEntries(s), grandTotal: 14160, ...over,
  });

  // 1 — non-ACCEPTED states cannot be billed by a direct POST.
  for (const st of ["DRAFT", "ISSUED", "COMPLETION_REPORTED", "REWORK_REQUIRED", "CANCELLED"]) {
    test(`a direct POST cannot bill a ${st} service order`, async () => {
      const s = await seed({ soStatus: st });
      const r = await post(base(s));
      expect(r.status).toBe(409);
      expect(r.body.reason).toBe("NOT_ACCEPTED");
      expect(await Acc_Voucher.countDocuments({ serviceOrderId: s.so._id })).toBe(0);
    });
  }

  // 2 — an ACCEPTED order can be billed.
  test("a direct POST can bill an ACCEPTED service order", async () => {
    const s = await seed();
    const r = await post(base(s));
    expect([200, 201]).toContain(r.status);
    expect(await Acc_Voucher.countDocuments({ serviceOrderId: s.so._id })).toBe(1);
  });

  // 3 — cross-company and unauthorized (nonexistent) company create no voucher.
  test("a service order billed under another company creates no voucher", async () => {
    const s = await seed();
    const other = await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") });
    const r = await post(base(s, { companyId: String(other._id) }));
    expect(r.status).toBe(404);
    expect(await Acc_Voucher.countDocuments({ serviceOrderId: s.so._id })).toBe(0);
  });
  test("an unauthorized (nonexistent) company creates no voucher", async () => {
    const s = await seed();
    const r = await post(base(s, { companyId: String(new mongoose.Types.ObjectId()) }));
    expect([403, 404]).toContain(r.status);
    expect(await Acc_Voucher.countDocuments({ serviceOrderId: s.so._id })).toBe(0);
  });

  // 4 + 5 — spoofed provenance is not persisted; the server stores its own.
  test("spoofed service-order number, spend-request and commitment ids are not persisted", async () => {
    const s = await seed();
    const bogusSpend = new mongoose.Types.ObjectId();
    const bogusCommit = new mongoose.Types.ObjectId();
    const r = await post(base(s, {
      serviceOrderNumber: "SVO/HACK/9999",
      spendRequestId: String(bogusSpend),
      budgetCommitmentId: String(bogusCommit),
      sourceReference: "spoofed",
    }));
    expect([200, 201]).toContain(r.status);
    const v = await Acc_Voucher.findOne({ serviceOrderId: s.so._id }).lean();
    expect(v.serviceOrderNumber).toBe(s.so.serviceOrderNumber);
    expect(String(v.spendRequestId)).toBe(String(s.request._id));
    expect(String(v.budgetCommitmentId)).toBe(String(s.commitment._id));
    expect(v.serviceOrderNumber).not.toBe("SVO/HACK/9999");
    expect(String(v.spendRequestId)).not.toBe(String(bogusSpend));
    expect(String(v.budgetCommitmentId)).not.toBe(String(bogusCommit));
    expect(v.sourceSystem).toBe("auto_from_service_order");
    expect(String(v.sourceId)).toBe(String(s.so._id));
  });

  // 6 — another company's commitment cannot be ATTACHED (a spoofed id is
  //     overwritten with the order's own) and is left untouched. The companion
  //     defence — a posted voucher naming another company's commitment cannot
  //     RELEASE it — is proven by "a different-company voucher cannot release
  //     the commitment" above.
  test("another company's commitment cannot be attached, and stays untouched", async () => {
    const s = await seed();       // company A, commitment cA
    const s2 = await seed();      // company B, commitment cB
    const r = await post(base(s, { budgetCommitmentId: String(s2.commitment._id) }));
    expect([200, 201]).toContain(r.status);
    const v = await Acc_Voucher.findOne({ serviceOrderId: s.so._id }).lean();
    expect(String(v.budgetCommitmentId)).toBe(String(s.commitment._id));   // authoritative, not cB
    expect(String(v.budgetCommitmentId)).not.toBe(String(s2.commitment._id));
    expect((await Commitment.findById(s2.commitment._id)).status).toBe("committed"); // untouched
  });

  // 7 — a service link on a non-purchase voucher is refused.
  test("a service link on a non-purchase voucher is refused", async () => {
    const s = await seed();
    const r = await post(base(s, { voucherType: "journal" }));
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("SERVICE_BILL_NOT_PURCHASE");
    expect(await Acc_Voucher.countDocuments({ serviceOrderId: s.so._id })).toBe(0);
  });

  // 8 — a voucher cannot carry both PO and service-order links.
  test("a voucher cannot carry both a PO and a service-order link", async () => {
    const s = await seed();
    const r = await post(base(s, { purchaseOrderId: String(new mongoose.Types.ObjectId()), purchaseOrderNumber: "PO/1" }));
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("SERVICE_AND_PO_CONFLICT");
    expect(await Acc_Voucher.countDocuments({ serviceOrderId: s.so._id })).toBe(0);
  });

  // 9 — a second live bill without confirmation is refused.
  test("a second live bill without confirmation returns SERVICE_ORDER_BILL_EXISTS", async () => {
    const s = await seed();
    expect([200, 201]).toContain((await post(base(s))).status);
    const r = await post(base(s));
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("SERVICE_ORDER_BILL_EXISTS");
    expect(Array.isArray(r.body.linkedVouchers)).toBe(true);
    expect(r.body.linkedVouchers.length).toBe(1);
    expect(await Acc_Voucher.countDocuments({ serviceOrderId: s.so._id })).toBe(1); // still one
  });

  // 10 — the explicit flag permits an intentional second bill.
  test("allowAdditionalServiceBill:true permits an intentional second bill", async () => {
    const s = await seed();
    expect([200, 201]).toContain((await post(base(s))).status);
    const r = await post(base(s, { allowAdditionalServiceBill: true }));
    expect([200, 201]).toContain(r.status);
    expect(await Acc_Voucher.countDocuments({ serviceOrderId: s.so._id })).toBe(2);
  });

  // 11 — the control flag is not persisted.
  test("the allowAdditionalServiceBill control flag is never persisted", async () => {
    const s = await seed();
    await post(base(s, { allowAdditionalServiceBill: true }));
    const v = await Acc_Voucher.findOne({ serviceOrderId: s.so._id }).lean();
    expect("allowAdditionalServiceBill" in v).toBe(false);
    expect(v.allowAdditionalServiceBill).toBeUndefined();
  });

  // 12 — cancelled/void historical bills do not require confirmation.
  test("a cancelled historical bill does not require additional-bill confirmation", async () => {
    const s = await seed();
    await voucher({ company: s.company, ledger: s.ledger, status: "cancelled", link: { serviceOrderId: s.so._id } });
    const r = await post(base(s)); // ordinary create, no flag
    expect([200, 201]).toContain(r.status);
    expect(await Acc_Voucher.countDocuments({ serviceOrderId: s.so._id, status: { $ne: "cancelled" } })).toBe(1);
  });

  // 13 — editing cannot replace or remove service provenance.
  test("editing cannot replace or remove service-order provenance", async () => {
    const s = await seed();
    expect([200, 201]).toContain((await post(base(s))).status);
    const v = await Acc_Voucher.findOne({ serviceOrderId: s.so._id }).lean();

    const replace = await call(`/${v._id}`, { method: "PUT", body: { serviceOrderId: String(new mongoose.Types.ObjectId()) } });
    expect(replace.status).toBe(409);
    expect(replace.body.reason).toBe("SERVICE_PROVENANCE_IMMUTABLE");

    const remove = await call(`/${v._id}`, { method: "PUT", body: { spendRequestId: null } });
    expect(remove.status).toBe(409);
    expect(remove.body.reason).toBe("SERVICE_PROVENANCE_IMMUTABLE");

    // A benign edit preserves provenance untouched.
    const ok = await call(`/${v._id}`, { method: "PUT", body: { narration: "edited" } });
    expect([200, 201]).toContain(ok.status);
    const after = await Acc_Voucher.findById(v._id).lean();
    expect(String(after.serviceOrderId)).toBe(String(s.so._id));
    expect(String(after.spendRequestId)).toBe(String(s.request._id));
    expect(String(after.budgetCommitmentId)).toBe(String(s.commitment._id));
  });

  // 14 — linked-bill queries exclude other companies and non-purchase vouchers.
  test("linked-bill queries exclude other companies and non-purchase vouchers", async () => {
    const s = await seed();
    // A genuine purchase bill for this order.
    await post(base(s));
    // A same-serviceOrderId JOURNAL voucher (wrong type) and an OTHER-company
    // purchase voucher naming this order — neither is a bill of this order.
    await Acc_Voucher.create({
      companyId: s.company._id, voucherType: "journal", voucherNumber: `J/${seq++}`,
      voucherDate: new Date("2026-08-10"), status: "posted", grandTotal: 1,
      serviceOrderId: s.so._id,
      ledgerEntries: [{ ledgerId: s.ledger._id, ledgerName: s.ledger.name, type: "Dr", amount: 1 }],
    });
    const other = await Acc_Company.create({ companyName: "Third Co", booksFromDate: new Date("2026-04-01") });
    await Acc_Voucher.create({
      companyId: other._id, voucherType: "purchase", voucherNumber: `V/${seq++}`,
      voucherDate: new Date("2026-08-10"), status: "posted", grandTotal: 1, serviceOrderId: s.so._id,
      ledgerEntries: [{ ledgerId: s.ledger._id, ledgerName: s.ledger.name, type: "Dr", amount: 1 }],
    });
    const r = await call(`/service-order/${s.so._id}/billable?companyId=${s.company._id}`);
    expect(r.status).toBe(200);
    expect(r.body.linkedVouchers.length).toBe(1); // only company-A purchase bill
  });

  // 16 — an explicit 0% GST snapshot is preserved by the prefill (no 18%).
  test("an explicit 0% GST service line stays 0% in the prefill", async () => {
    const s = await seed();
    await ServiceOrder.updateOne({ _id: s.so._id }, {
      $set: { "lines.0.gstRate": 0, "lines.0.gstAmount": 0, taxAmount: 0, taxRate: 0 },
    });
    const r = await call(`/service-order/${s.so._id}/billable?companyId=${s.company._id}`);
    expect(r.status).toBe(200);
    expect(r.body.prefill.lines[0].gstRate).toBe(0);
  });

  // 17 (backend half) — an order with no expense ledger prefills none; nothing invented.
  test("an order with no expense ledger yields an unresolved budget head in the prefill", async () => {
    const s = await seed();
    await ServiceOrder.updateOne({ _id: s.so._id }, { $unset: { budgetLedgerId: "", budgetLedgerName: "" } });
    const r = await call(`/service-order/${s.so._id}/billable?companyId=${s.company._id}`);
    expect(r.status).toBe(200);
    expect(r.body.prefill.budgetLedgerId).toBeNull();
  });
});
