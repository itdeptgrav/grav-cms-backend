// test/accountant/voucher-transaction-release.route.test.js
//
// THE COMMITMENT LIFECYCLE, UNDER A REAL TRANSACTION.
//
// ── THE DEFECT THIS SUITE EXISTS FOR ────────────────────────────────────────
// `Acc_Voucher`'s `post("save")` hook is not an after-commit hook. For
// `save({ session })` it fires while the transaction is still OPEN, and the
// reread it made used no session — so it saw the PRE-transaction voucher:
//
//   · posted → cancelled reread as `posted`, took the posted branch, did
//     nothing, and then committed. The voucher was cancelled and its
//     commitment stayed released.
//   · an aborted transaction could still have produced a release.
//   · an edited posted voucher reconciled against its OLD lines.
//
// A comment in that hook claimed the outside-session reread proved the write
// was durably committed. It did not, and it is gone.
//
// ── WHY A REPLICA SET ───────────────────────────────────────────────────────
// The shared test harness runs a standalone mongod, which silently ignores
// sessions — every transactional assertion here would pass for the wrong
// reason. This file starts its own replica set so `startTransaction`,
// `commitTransaction` and `abortTransaction` mean what they say.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const Commitment = require("../../models/Accountant_model/Acc_BudgetCommitment");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const budgetMatch = require("../../services/budgetCommitment.service");
const release = require("../../services/commitmentRelease.service");

let rs, seq = 0;

beforeAll(async () => {
  /* The shared harness connected us to a standalone; swap it for a replica
     set, because a standalone accepts a session and ignores it. */
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "txn_release" });
}, 180000);

afterAll(async () => {
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
});

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

/** A company, two budget heads and an approved two-head commitment. */
async function seed() {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `TX Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const group = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const mk = (name) => Acc_Ledger.create({
    companyId: company._id, name: `${name} ${n}`, groupId: group._id,
    groupName: group.name, nature: "expense",
  });
  const raw = await mk("Raw Materials");
  const packaging = await mk("Packaging");
  const supplier = await Acc_Ledger.create({
    companyId: company._id, name: `Mill ${n}`, groupId: group._id,
    groupName: "Sundry Creditors", nature: "liability",
  });

  const budget = await Acc_Budget.create({
    name: `Budget ${n}`, financialYear: "2026-27", period: "yearly",
    status: "active", startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [raw, packaging].map((l) => ({
      ledgerId: l._id, ledgerName: l.name, nature: "expense",
      department: "Logistics", allocatedAmount: 50000,
    })),
  });

  /* A two-line request already approved across the two heads. Built directly:
     this suite is about the TRANSACTION, and the identity chain is proved
     through the real form elsewhere. */
  const request = await SpendRequest.create({
    title: "Run", requestType: "PRODUCT", purpose: "Q3", department: "Logistics",
    companyId: company._id, ledgerId: raw._id, ledgerName: raw.name,
    requestedBy: new mongoose.Types.ObjectId(), requestedById: "EMP1",
    requestedByName: "Rutu", status: "approved",
    items: [
      { name: "Fabric", whyNeeded: "x", quantity: 1, unit: "roll", rate: 6000, amount: 6000, lineTotal: 6000 },
      { name: "Cartons", whyNeeded: "x", quantity: 1, unit: "box", rate: 4000, amount: 4000, lineTotal: 4000 },
    ],
    totalAmount: 10000, grandTotal: 10000,
  });
  const lineIds = request.items.map((l) => String(l._id));
  const lineOf = (l) => budget.items.find((i) => String(i.ledgerId) === String(l._id));

  const commitment = await Commitment.create({
    spendRequestId: request._id, spendRequestNumber: "SPR-TX",
    companyId: company._id, department: "Logistics",
    amount: 10000, status: "committed",
    allocationMode: "line_wise", headCount: 2,
    allocations: [
      { spendLineId: request.items[0]._id, name: "Fabric",
        budgetId: budget._id, budgetLineId: lineOf(raw)._id,
        ledgerId: raw._id, ledgerName: raw.name,
        amount: 6000, releasedAmount: 0, remainingAmount: 6000, status: "committed" },
      { spendLineId: request.items[1]._id, name: "Cartons",
        budgetId: budget._id, budgetLineId: lineOf(packaging)._id,
        ledgerId: packaging._id, ledgerName: packaging.name,
        amount: 4000, releasedAmount: 0, remainingAmount: 4000, status: "committed" },
    ],
  });

  return { company, budget, raw, packaging, supplier, request, lineIds, commitment, lineOf };
}

const entry = (spendLineId, amount) => ({
  stockItemName: "Thing", quantity: 1, unit: "Nos",
  rate: amount, discount: 0, amount, taxRate: 0, taxAmount: 0,
  ...(spendLineId ? { spendLineId } : {}),
});

/** A draft bill linked to the request, in the stored shape. */
async function draftBill(s, entries, over = {}) {
  return Acc_Voucher.create({
    companyId: s.company._id, voucherType: "purchase",
    voucherNumber: `PUR-${++seq}`, voucherDate: new Date("2026-08-01"),
    partyLedgerId: s.supplier._id, partyLedgerName: s.supplier.name,
    status: "draft",
    spendRequestId: s.request._id,
    budgetCommitmentId: s.commitment._id,
    ledgerEntries: [
      { ledgerId: s.raw._id, ledgerName: s.raw.name, type: "Dr", amount: 0 },
      { ledgerId: s.supplier._id, ledgerName: s.supplier.name, type: "Cr", amount: 0 },
    ],
    inventoryEntries: entries,
    grandTotal: entries.reduce((t, e) => t + e.amount, 0),
    ...over,
  });
}

const liveOn = async (s, ledger) =>
  (await budgetMatch.committedByLine([s.lineOf(ledger)._id]))
    .get(String(s.lineOf(ledger)._id)) || 0;

const reconcile = (v) => release.reconcileVoucher({ voucherId: v._id, actor: { name: "Asha" } });

/** Exactly what a route does: transition inside a transaction, then reconcile. */
async function transition(v, status, { abort = false } = {}) {
  /* The routes retry a transient transaction (`inTransaction`, attempts: 3) —
     a single-node replica set hands out short-lived lock-acquisition failures
     under load, and a helper that did not retry would report them as product
     defects. Same predicate as production. */
  for (let attempt = 0; ; attempt += 1) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const live = await Acc_Voucher.findById(v._id).session(session);
    live.status = status;
    await live.save({ session });
    if (abort) {
      await session.abortTransaction();
      /* An aborted transaction reconciles NOTHING — the route's
         `reconcileAfterCommit` is only reached after a successful commit. */
      return { committed: false };
    }
    await session.commitTransaction();
  } catch (e) {
    try { await session.abortTransaction(); } catch (_) {}
    const transient = e?.errorLabels?.includes("TransientTransactionError")
      || /unable to acquire .*lock/i.test(e?.message || "");
    if (!transient || attempt >= 2) throw e;
    continue;
  } finally {
    session.endSession();
  }
  break;
  }
  await reconcile(v);
  return { committed: true };
}

/* ═══ 1–2 · POSTING ════════════════════════════════════════════════════════ */

describe("transactional posting", () => {
  test("releases only the mapped allocations, after the commit", async () => {
    const s = await seed();
    const v = await draftBill(s, [entry(s.lineIds[0], 6000)]);
    expect(await liveOn(s, s.raw)).toBe(6000);

    await transition(v, "posted");

    expect(await liveOn(s, s.raw)).toBe(0);
    /* The head nobody billed stays promised. */
    expect(await liveOn(s, s.packaging)).toBe(4000);

    const c = await Commitment.findById(s.commitment._id).lean();
    expect(c.status).toBe("partially_released");
    expect(c.allocations[0].releases).toHaveLength(1);
  });

  test("an aborted posting releases nothing", async () => {
    const s = await seed();
    const v = await draftBill(s, [entry(s.lineIds[0], 6000)]);

    const out = await transition(v, "posted", { abort: true });
    expect(out.committed).toBe(false);

    /* Both heads still promised, and the voucher is still a draft. */
    expect(await liveOn(s, s.raw)).toBe(6000);
    expect(await liveOn(s, s.packaging)).toBe(4000);
    expect((await Acc_Voucher.findById(v._id).lean()).status).toBe("draft");
    const c = await Commitment.findById(s.commitment._id).lean();
    expect(c.status).toBe("committed");
    expect(c.allocations[0].releases).toBeUndefined();
  });
});

/* ═══ 3–5 · CANCELLATION AND VOID ══════════════════════════════════════════ */

describe("transactional cancellation", () => {
  test("restores exactly this voucher's contributions", async () => {
    const s = await seed();
    const v = await draftBill(s, [entry(s.lineIds[0], 6000)]);
    await transition(v, "posted");
    expect(await liveOn(s, s.raw)).toBe(0);

    /* ── THE DEFECT, EXACTLY ──────────────────────────────────────────────
       The old hook fired mid-transaction, reread `posted` outside the
       session, took the posted branch and did nothing — leaving a cancelled
       voucher whose commitment was still released. */
    await transition(v, "cancelled");

    expect(await liveOn(s, s.raw)).toBe(6000);
    const c = await Commitment.findById(s.commitment._id).lean();
    expect(c.status).toBe("committed");
    expect(c.allocations[0].releasedAmount).toBe(0);
  });

  test("an aborted cancellation restores nothing", async () => {
    const s = await seed();
    const v = await draftBill(s, [entry(s.lineIds[0], 6000)]);
    await transition(v, "posted");

    const out = await transition(v, "cancelled", { abort: true });
    expect(out.committed).toBe(false);

    /* Still posted, still released. */
    expect((await Acc_Voucher.findById(v._id).lean()).status).toBe("posted");
    expect(await liveOn(s, s.raw)).toBe(0);
  });

  test("void restores exactly once", async () => {
    const s = await seed();
    const v = await draftBill(s, [entry(s.lineIds[0], 6000)]);
    await transition(v, "posted");

    await transition(v, "void");
    expect(await liveOn(s, s.raw)).toBe(6000);

    /* Reconciling again is a no-op, not a second restoration. */
    await reconcile(v);
    expect(await liveOn(s, s.raw)).toBe(6000);
    const c = await Commitment.findById(s.commitment._id).lean();
    expect(c.allocations[0].releasedAmount).toBe(0);
    expect(c.allocations[0].remainingAmount).toBe(6000);
  });

  test("cancelling one of two bills leaves the other's discharge standing", async () => {
    const s = await seed();
    const first = await draftBill(s, [entry(s.lineIds[0], 2000)]);
    const second = await draftBill(s, [entry(s.lineIds[0], 3000)]);
    await transition(first, "posted");
    await transition(second, "posted");
    expect(await liveOn(s, s.raw)).toBe(1000);

    await transition(first, "cancelled");

    /* Only the first's ₹2,000 comes back. */
    expect(await liveOn(s, s.raw)).toBe(3000);
    const c = await Commitment.findById(s.commitment._id).lean();
    expect(c.allocations[0].releases).toHaveLength(1);
    expect(String(c.allocations[0].releases[0].voucherId)).toBe(String(second._id));
  });
});

/* ═══ 6–7 · EDITING A POSTED VOUCHER ═══════════════════════════════════════ */

describe("editing a posted voucher", () => {
  /** Edit the lines inside a transaction, exactly as the edit executor does. */
  async function editLines(v, entries, { abort = false } = {}) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const live = await Acc_Voucher.findById(v._id).session(session);
      live.inventoryEntries = entries;
      live.grandTotal = entries.reduce((t, e) => t + e.amount, 0);
      await live.save({ session });
      if (abort) { await session.abortTransaction(); return { committed: false }; }
      await session.commitTransaction();
    } finally {
      session.endSession();
    }
    await reconcile(v);
    return { committed: true };
  }

  test("the stored release matches the NEW lines, not the old", async () => {
    const s = await seed();
    const v = await draftBill(s, [entry(s.lineIds[0], 6000)]);
    await transition(v, "posted");
    expect(await liveOn(s, s.raw)).toBe(0);
    expect(await liveOn(s, s.packaging)).toBe(4000);

    /* The bill turns out to be for the OTHER line. Calling an idempotent
       apply again would see this voucher's existing rows and do nothing,
       leaving a distribution describing a bill that no longer exists. */
    await editLines(v, [entry(s.lineIds[1], 4000)]);

    expect(await liveOn(s, s.raw)).toBe(6000);
    expect(await liveOn(s, s.packaging)).toBe(0);

    const c = await Commitment.findById(s.commitment._id).lean();
    expect(c.allocations[0].releasedAmount).toBe(0);
    expect(c.allocations[0].releases).toBeUndefined();
    expect(c.allocations[1].releasedAmount).toBe(4000);
    expect(c.allocations[1].releases).toHaveLength(1);
  });

  test("a smaller edited bill releases less, not the same", async () => {
    const s = await seed();
    const v = await draftBill(s, [entry(s.lineIds[0], 6000)]);
    await transition(v, "posted");

    await editLines(v, [entry(s.lineIds[0], 2500)]);

    expect(await liveOn(s, s.raw)).toBe(3500);
    const c = await Commitment.findById(s.commitment._id).lean();
    expect(c.allocations[0].releasedAmount).toBe(2500);
    expect(c.allocations[0].remainingAmount).toBe(3500);
  });

  test("an aborted edit preserves the old distribution", async () => {
    const s = await seed();
    const v = await draftBill(s, [entry(s.lineIds[0], 6000)]);
    await transition(v, "posted");

    const out = await editLines(v, [entry(s.lineIds[1], 4000)], { abort: true });
    expect(out.committed).toBe(false);

    /* Nothing moved. */
    expect(await liveOn(s, s.raw)).toBe(0);
    expect(await liveOn(s, s.packaging)).toBe(4000);
    const c = await Commitment.findById(s.commitment._id).lean();
    expect(c.allocations[0].releasedAmount).toBe(6000);
    expect(c.allocations[1].releasedAmount).toBe(0);
  });

  test("an edit does not consume or free another request line by accident", async () => {
    const s = await seed();
    const other = await draftBill(s, [entry(s.lineIds[1], 4000)]);
    await transition(other, "posted");
    const v = await draftBill(s, [entry(s.lineIds[0], 6000)]);
    await transition(v, "posted");
    expect(await liveOn(s, s.raw)).toBe(0);
    expect(await liveOn(s, s.packaging)).toBe(0);

    /* Editing v must not disturb the other voucher's line. */
    await editLines(v, [entry(s.lineIds[0], 1000)]);

    expect(await liveOn(s, s.raw)).toBe(5000);
    expect(await liveOn(s, s.packaging)).toBe(0);
    const c = await Commitment.findById(s.commitment._id).lean();
    expect(c.allocations[1].releasedAmount).toBe(4000);
    expect(String(c.allocations[1].releases[0].voucherId)).toBe(String(other._id));
  });
});

/* ═══ 8–10 · REPLAY, NON-TRANSACTIONAL, PERSISTENCE ════════════════════════ */

describe("retries and the non-transactional path", () => {
  test("repeated reconciliation does not duplicate release rows", async () => {
    const s = await seed();
    const v = await draftBill(s, [entry(s.lineIds[0], 2500)]);
    await transition(v, "posted");

    /* A retried request, a replayed job, a second call — all converge. */
    await reconcile(v);
    await reconcile(v);

    const c = await Commitment.findById(s.commitment._id).lean();
    expect(c.allocations[0].releases).toHaveLength(1);
    expect(c.allocations[0].releasedAmount).toBe(2500);
    expect(await liveOn(s, s.raw)).toBe(3500);
  });

  test("a non-transactional save still reconciles, exactly once", async () => {
    const s = await seed();
    const v = await draftBill(s, [entry(s.lineIds[0], 6000)]);

    /* No session: the hook is the only thing that will act, and it must. */
    const live = await Acc_Voucher.findById(v._id);
    live.status = "posted";
    await live.save();
    await new Promise((r) => setTimeout(r, 80));

    expect(await liveOn(s, s.raw)).toBe(0);
    const c = await Commitment.findById(s.commitment._id).lean();
    expect(c.allocations[0].releases).toHaveLength(1);
  });

  test("a non-transactional cancellation restores", async () => {
    const s = await seed();
    const v = await draftBill(s, [entry(s.lineIds[0], 6000)]);
    let live = await Acc_Voucher.findById(v._id);
    live.status = "posted";
    await live.save();
    await new Promise((r) => setTimeout(r, 80));

    live = await Acc_Voucher.findById(v._id);
    live.status = "cancelled";
    await live.save();
    await new Promise((r) => setTimeout(r, 80));

    expect(await liveOn(s, s.raw)).toBe(6000);
  });

  test("the hook stands aside for a transactional save", async () => {
    const s = await seed();
    const v = await draftBill(s, [entry(s.lineIds[0], 6000)]);

    /* Commit WITHOUT calling the reconciler. If the hook had acted from
       inside the transaction, the commitment would already have moved — and
       it would have moved on a pre-transaction read. */
    const session = await mongoose.startSession();
    session.startTransaction();
    const live = await Acc_Voucher.findById(v._id).session(session);
    live.status = "posted";
    await live.save({ session });
    await session.commitTransaction();
    session.endSession();
    await new Promise((r) => setTimeout(r, 80));

    expect(await liveOn(s, s.raw)).toBe(6000);

    /* And the route's after-commit call is what makes it happen. */
    await reconcile(v);
    expect(await liveOn(s, s.raw)).toBe(0);
  });

  test("the persistent reconciliation survives, and reads the same every time", async () => {
    const s = await seed();
    const v = await draftBill(s, [entry(s.lineIds[0], 6000)]);
    await transition(v, "posted");

    const fresh = await Acc_Voucher.findById(v._id).lean();
    const first = await release.reconciliationFor(fresh);
    const second = await release.reconciliationFor(fresh);

    expect(first).toBeTruthy();
    expect(first.reserved).toBe(10000);
    expect(first.releasedByThisVoucher).toBe(6000);
    expect(first.remaining).toBe(4000);
    expect(first.status).toBe("partially_released");
    expect(second).toEqual(first);
  });
});
