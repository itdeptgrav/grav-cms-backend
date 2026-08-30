// test/requests/commitment-release.route.test.js
//
// RELEASING A BUDGET COMMITMENT WHEN THE SPEND BECOMES REAL.
//
// A commitment blocks a budget head from the moment finance approves until the
// bill arrives. If nothing released it, both would count:
//
//     available = approved − committed − actual
//
// and a ₹12,000 repair would block ₹24,000 of the head for the rest of the
// year — the promise and the payment, forever.
//
// ── WHAT MUST NOT RELEASE ───────────────────────────────────────────────────
// A draft. A voucher awaiting approval. A cancelled one. A payment settling a
// payable the purchase voucher already posted. Anything with no explicit link.
// And nothing, ever, matched by amount and vendor: two ₹12,000 repairs from the
// same supplier in one week is an ordinary month, and releasing the wrong one
// is money the budget believes it has and does not.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { planEveryItem, PLANNED_KEY } = require("./plannedItems.helper");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const Commitment = require("../../models/Accountant_model/Acc_BudgetCommitment");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const svc = require("../../services/budgetCommitment.service");

let seq = 0;

/** A company, a head, a live ₹50,000 line, an approved request and its promise. */
async function seed({ amount = 12000, allocated = 50000, unbudgeted = false } = {}) {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `Rel Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const group = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const ledger = await Acc_Ledger.create({
    companyId: company._id, name: `Repairs ${n}`, groupId: group._id,
    groupName: group.name, nature: "expense",
  });
  const budget = await Acc_Budget.create({
    name: `Budget ${n}`, financialYear: "2026-27", period: "yearly", status: "active",
    startDate: new Date("2026-03-31T18:30:00.000Z"),
    endDate: new Date("2027-03-31T18:29:59.999Z"),
    companyId: company._id,
    items: [{ ledgerId: ledger._id, ledgerName: ledger.name, nature: "expense",
              department: "Logistics", allocatedAmount: allocated }],
  });
  /* Give every head its approved plan — a request now names a
     planned item, not just a head. See plannedItems.helper. */
  await planEveryItem(budget);
  const line = budget.items[0];

  const request = await SpendRequest.create({
    title: "Compressor repair", requestType: "SERVICE",
    requestedBy: new mongoose.Types.ObjectId(), requestedByName: "Rutu",
    requestedById: `EM${n}`, department: "Logistics",
    companyId: company._id, ledgerId: ledger._id, ledgerName: ledger.name,
    purpose: "Failed inspection",
    items: [{ name: "Visit", whyNeeded: "Failed", quantity: 1, unit: "visit", rate: amount, amount }],
    totalAmount: amount,
    status: "approved",
    budgetCycleId: unbudgeted ? undefined : budget._id,
    budgetLineId: unbudgeted ? undefined : line._id,
    budgetMatchStatus: unbudgeted ? "no_budget_line" : "matched",
  });

  const { commitment } = await svc.commit({ request, actor: { email: "fin@x", name: "Fin" } });
  await SpendRequest.updateOne({ _id: request._id }, {
    $set: { commitmentId: commitment._id, commitmentStatus: commitment.status },
  });

  return { company, ledger, budget, line, request, commitment };
}

/** A voucher of `type`, saved at `status`, optionally linked to a request. */
const voucher = ({ company, ledger, amount = 12000, type = "purchase",
                   status = "posted", link = {}, reference = "" }) =>
  Acc_Voucher.create({
    companyId: company._id,
    voucherType: type,
    voucherNumber: `V/${seq++}/${Date.now()}`,
    voucherDate: new Date("2026-08-10"),
    status,
    grandTotal: amount,
    ...(reference ? { referenceNumber: reference } : {}),
    ...link,
    ledgerEntries: [{ ledgerId: ledger._id, ledgerName: ledger.name, type: "Dr", amount }],
  });

const statusOf = (id) => Commitment.findById(id).then((c) => c.status);
const liveOnLine = (lineId) =>
  svc.committedByLine([lineId]).then((m) => m.get(String(lineId)) || 0);

/* ═══ WHAT RELEASES ═══════════════════════════════════════════════════════ */

test("a posted purchase voucher linked to the request releases the commitment", async () => {
  const { company, ledger, request, commitment } = await seed();
  const v = await voucher({ company, ledger, link: { spendRequestId: request._id } });

  const after = await Commitment.findById(commitment._id).lean();
  expect(after.status).toBe("released");
  expect(after.releaseReason).toBe("voucher_posted");
  expect(String(after.releasedByVoucherId)).toBe(String(v._id));
  expect(after.releasedByVoucherNumber).toBe(v.voucherNumber);
  expect(after.releasedAmount).toBe(12000);
  expect(after.releasedAt).toBeInstanceOf(Date);
});

test("a voucher naming the commitment outright releases it too", async () => {
  const { company, ledger, commitment } = await seed();
  await voucher({ company, ledger, link: { budgetCommitmentId: commitment._id } });
  await expect(statusOf(commitment._id)).resolves.toBe("released");
});

test("a bill quoting the order number Store raised releases it", async () => {
  /* An exact string the company generated, not a guess about which invoice
     this looks like. */
  const { company, ledger, request, commitment } = await seed();
  await SpendRequest.updateOne({ _id: request._id }, { $set: { orderReference: "WO/2608/014" } });
  await voucher({ company, ledger, reference: "WO/2608/014" });
  await expect(statusOf(commitment._id)).resolves.toBe("released");
});

test("an unbudgeted commitment can be released by its voucher", async () => {
  const { company, ledger, request, commitment } = await seed({ unbudgeted: true });
  expect(commitment.status).toBe("unbudgeted");
  await voucher({ company, ledger, link: { spendRequestId: request._id } });
  await expect(statusOf(commitment._id)).resolves.toBe("released");
});

/* ═══ WHAT MUST NOT RELEASE ═══════════════════════════════════════════════ */

test("a draft voucher releases nothing", async () => {
  const { company, ledger, request, commitment } = await seed();
  await voucher({ company, ledger, status: "draft", link: { spendRequestId: request._id } });
  await expect(statusOf(commitment._id)).resolves.toBe("committed");
});

test("a voucher awaiting approval releases nothing", async () => {
  const { company, ledger, request, commitment } = await seed();
  await voucher({ company, ledger, status: "pending_approval", link: { spendRequestId: request._id } });
  await expect(statusOf(commitment._id)).resolves.toBe("committed");
});

test("a cancelled voucher releases nothing", async () => {
  const { company, ledger, request, commitment } = await seed();
  await voucher({ company, ledger, status: "cancelled", link: { spendRequestId: request._id } });
  await expect(statusOf(commitment._id)).resolves.toBe("committed");
});

test("a payment voucher does not release — it settles what the bill already posted", async () => {
  const { company, ledger, request, commitment } = await seed();
  await voucher({ company, ledger, type: "payment", link: { spendRequestId: request._id } });
  await expect(statusOf(commitment._id)).resolves.toBe("committed");
});

test("an unrelated posted voucher on the same head releases nothing", async () => {
  const { company, ledger, commitment } = await seed();
  await voucher({ company, ledger });
  await expect(statusOf(commitment._id)).resolves.toBe("committed");
});

test("nothing is matched by amount, vendor or date", async () => {
  /* The same head, the same figure, the same week, no link — and the promise
     stays live. This is the case a fuzzy matcher would get wrong. */
  const { company, ledger, commitment } = await seed({ amount: 12000 });
  await voucher({ company, ledger, amount: 12000 });
  await voucher({ company, ledger, amount: 12000 });
  await expect(statusOf(commitment._id)).resolves.toBe("committed");
});

test("another company's voucher cannot release this company's commitment", async () => {
  const { request, commitment } = await seed();
  const other = await seed();
  await voucher({
    company: other.company, ledger: other.ledger,
    link: { spendRequestId: request._id },
  });
  await expect(statusOf(commitment._id)).resolves.toBe("committed");
});

/* ═══ RELEASING IS IDEMPOTENT, AND KEEPS THE RECORD ═══════════════════════ */

test("a second linked voucher does not release it again", async () => {
  const { company, ledger, request, commitment } = await seed();
  const first = await voucher({ company, ledger, link: { spendRequestId: request._id } });
  await voucher({ company, ledger, link: { spendRequestId: request._id } });

  const after = await Commitment.findById(commitment._id).lean();
  expect(after.status).toBe("released");
  /* Still the FIRST voucher on the record — the release happened once. */
  expect(String(after.releasedByVoucherId)).toBe(String(first._id));
});

test("re-saving the same posted voucher changes nothing", async () => {
  const { company, ledger, request, commitment } = await seed();
  const v = await voucher({ company, ledger, link: { spendRequestId: request._id } });
  const first = await Commitment.findById(commitment._id).lean();

  v.narration = "touched";
  await v.save();

  const again = await Commitment.findById(commitment._id).lean();
  expect(again.releasedAt.getTime()).toBe(first.releasedAt.getTime());
});

test("a released commitment stays readable as the promise finance made", async () => {
  /* Released, never deleted: it records a decision made on a date against
     numbers that were true then. */
  const { company, ledger, request, commitment } = await seed();
  await voucher({ company, ledger, link: { spendRequestId: request._id } });

  const after = await Commitment.findById(commitment._id).lean();
  expect(after).toBeTruthy();
  expect(after.amount).toBe(12000);
  expect(after.committedByName).toBe("Fin");
  expect(after.spendRequestNumber).toBe((await SpendRequest.findById(request._id).lean()).requestNumber);
});

/* ═══ THE BUDGET STOPS BLOCKING ═══════════════════════════════════════════ */

test("a released commitment no longer reduces what is available", async () => {
  const { company, ledger, line, request, commitment } = await seed({ amount: 12000 });
  await expect(liveOnLine(line._id)).resolves.toBe(12000);

  await voucher({ company, ledger, link: { spendRequestId: request._id } });

  await expect(liveOnLine(line._id)).resolves.toBe(0);
  await expect(statusOf(commitment._id)).resolves.toBe("released");
});

test("an unbudgeted commitment never reduced a line, released or not", async () => {
  const { line } = await seed({ unbudgeted: true });
  await expect(liveOnLine(line._id)).resolves.toBe(0);
});

/* ═══ THE VOUCHER IS CANCELLED AFTER ALL ══════════════════════════════════ */

test("cancelling the voucher that released it brings the promise back", async () => {
  /* Otherwise the money is neither committed nor actual, and the head frees up
     for spend that was never unwound. */
  const { company, ledger, line, request, commitment } = await seed();
  const v = await voucher({ company, ledger, link: { spendRequestId: request._id } });
  await expect(statusOf(commitment._id)).resolves.toBe("released");

  v.status = "cancelled";
  await v.save();

  await expect(statusOf(commitment._id)).resolves.toBe("committed");
  await expect(liveOnLine(line._id)).resolves.toBe(12000);
});

test("an unbudgeted promise comes back unbudgeted, not as a line charge", async () => {
  const { company, ledger, request, commitment } = await seed({ unbudgeted: true });
  const v = await voucher({ company, ledger, link: { spendRequestId: request._id } });
  v.status = "cancelled";
  await v.save();
  await expect(statusOf(commitment._id)).resolves.toBe("unbudgeted");
});

test("cancelling a DIFFERENT voucher does not revive a commitment somebody else's bill replaced", async () => {
  /* The spend really did happen. Reviving it would block the head against
     money already paid. */
  const { company, ledger, request, commitment } = await seed();
  await voucher({ company, ledger, link: { spendRequestId: request._id } });
  const unrelated = await voucher({ company, ledger });

  unrelated.status = "cancelled";
  await unrelated.save();

  await expect(statusOf(commitment._id)).resolves.toBe("released");
});
