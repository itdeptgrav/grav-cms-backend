/**
 * services/budgetCommitment.service.js
 *
 * THE THIRD FIGURE: what a head has already promised.
 *
 * A budget head has an envelope (approved), what has been posted against it
 * (actual), and — from this chunk — what has been agreed to but not yet paid.
 * Available is what is left after both:
 *
 *     available = approved − committed − actual
 *
 * ── WHERE THE MATCH COMES FROM ──────────────────────────────────────────────
 * Not from here. `budgetControl.checkBudgetAvailability` already answers "which
 * budget line does this company / department / account head / date belong to",
 * for every voucher gate in the app, and re-deriving it in a second place is
 * how two screens end up disagreeing about which line a spend belongs to. This
 * service adds the commitment figure to that answer and nothing else.
 *
 * ── A COMMITMENT IS NOT AN ACTUAL ───────────────────────────────────────────
 * It never touches `actual`, which comes from posted vouchers alone. A promise
 * reduces what is left to promise NEXT; it is not spend. When the invoice is
 * finally posted, the voucher becomes the actual and this commitment should
 * stop counting — that release is deliberately not built here, so a head with
 * a paid commitment currently reads as though both the promise and the payment
 * are outstanding. See the risk note in the report.
 */

"use strict";

const Commitment = require("../models/Accountant_model/Acc_BudgetCommitment");
const control = require("./budgetControl.service");

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/** What is live against a set of budget lines, keyed by line id. */
async function committedByLine(lineIds = []) {
  const ids = lineIds.filter(Boolean);
  if (!ids.length) return new Map();
  const rows = await Commitment.aggregate([
    { $match: { budgetLineId: { $in: ids }, status: "committed" } },
    { $group: { _id: "$budgetLineId", total: { $sum: "$amount" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), money(r.total)]));
}

/**
 * Which budget line a spend request belongs to, and what is left on it.
 *
 * Returns the four statuses the app distinguishes:
 *
 *   matched         a live line for this department and head
 *   wrong_department a line exists for the head, but under another department
 *   inactive_cycle  a line exists, in a cycle that is not in force yet
 *   no_budget_line  nothing anywhere
 *
 * The last three are not refusals. A request against an unbudgeted head is a
 * real request that finance has to see — hiding it, or blocking it, is how
 * spending moves to a channel nobody is measuring.
 */
async function matchFor({ companyId, department, ledgerId, ledgerName, amount, when = new Date() }) {
  const empty = {
    status: "no_budget_line",
    budgetId: null,
    budgetLineId: null,
    financialYear: null,
    department: department || null,
    snapshot: null,
  };
  if (!companyId || !ledgerId) return empty;

  /* The same call every voucher gate makes, asked with this request's own
     figure so `remainingAfter` is the projection for THIS spend. */
  const check = await control.checkBudgetAvailability({
    companyId,
    voucherDate: when,
    ledgerEntries: [{ ledgerId, type: "Dr", amount: money(amount) }],
    department: department || null,
  });

  const line = (check.results || []).find((r) => String(r.ledgerId) === String(ledgerId));
  const match = line?.budgets?.[0] || null;

  if (!match) {
    /* Nothing live. Distinguish "no line at all" from "a line that is not in
       force yet" — the second is a timing problem finance can fix by
       activating the round, and telling somebody there is no budget when
       there is one waiting to start would send them to raise another. */
    const dormant = await dormantLineFor({ companyId, department, ledgerId });
    if (dormant) {
      return { ...empty, status: dormant.status, budgetId: dormant.budgetId,
               budgetLineId: dormant.budgetLineId, financialYear: dormant.financialYear };
    }
    return empty;
  }

  const committedBefore = (await committedByLine([match.itemId])).get(String(match.itemId)) || 0;
  const approved = money(line.allocated);
  const actual = money(line.actual);
  const availableBefore = money(approved - committedBefore - actual);

  return {
    status: "matched",
    budgetId: match._id,
    budgetLineId: match.itemId,
    financialYear: check.financialYear || match.financialYear || null,
    department: match.department || department || null,
    ledgerName: ledgerName || line.ledgerName || null,
    snapshot: {
      approved,
      committedBefore,
      actual,
      availableBefore,
      requested: money(amount),
      availableAfter: money(availableBefore - money(amount)),
    },
  };
}

/**
 * A line that exists but is not in force.
 *
 * Read directly rather than through the control, because the control only ever
 * looks at cycles that ARE in force — that is its job. This is the "why not"
 * for the answer it gave.
 */
async function dormantLineFor({ companyId, department, ledgerId }) {
  const { Acc_Budget } = require("../models/Accountant_model/Acc_OperationalModels");
  const departments = require("./budgetDepartment.service");
  const actuals = require("./budgetActuals.service");

  const cid = actuals.oid(companyId);
  if (!cid) return null;

  const budgets = await Acc_Budget.find({
    $or: [{ companyId: cid }, { companyId: { $exists: false } }, { companyId: null }],
    status: { $nin: ["active", "exceeded"] },
  })
    .select("_id financialYear status items")
    .lean();

  const wanted = departments.slugify(department);
  for (const b of budgets) {
    for (const item of b.items || []) {
      if (String(item.ledgerId) !== String(ledgerId)) continue;
      const itemSlug = departments.slugify(item.department);
      /* A line for this head under ANOTHER department is a different answer
         from no line at all: the money exists, it is simply not this
         department's to spend. */
      if (wanted && itemSlug && itemSlug !== wanted) {
        return { status: "wrong_department", budgetId: b._id, budgetLineId: item._id, financialYear: b.financialYear };
      }
      return { status: "inactive_cycle", budgetId: b._id, budgetLineId: item._id, financialYear: b.financialYear };
    }
  }
  return null;
}

/**
 * Turn an approved request into a promise — exactly once.
 *
 * Idempotent by the unique index on `spendRequestId`, not by a read-then-write:
 * two approvals arriving together would both find nothing and both insert.
 * `upsert` with that index is the one thing that cannot double-count.
 */
async function commit({ request, actor, expectedPaymentDate = null }) {
  const existing = await Commitment.findOne({ spendRequestId: request._id }).lean();
  if (existing) return { commitment: existing, created: false };

  const matched = request.budgetMatchStatus === "matched" && request.budgetLineId;
  const doc = {
    spendRequestId: request._id,
    spendRequestNumber: request.requestNumber,
    companyId: request.companyId,
    budgetId: matched ? request.budgetCycleId : undefined,
    budgetLineId: matched ? request.budgetLineId : undefined,
    financialYear: request.budgetFinancialYear || undefined,
    department: request.budgetDepartment || request.department,
    ledgerId: request.ledgerId,
    ledgerName: request.ledgerName,
    /* ── THE FIGURE THAT WILL ACTUALLY LEAVE THE BANK ────────────────────
       `totalAmount` is the SUBTOTAL. Committing that under-reserved the head
       by the tax on every request that carried any — a ₹1,416 purchase
       reserved ₹1,200, and the ₹216 only appeared when the voucher posted and
       the head was suddenly over by an amount nobody had promised.

       `grandTotal` is absent on every request raised before tax was captured,
       and falls back to the subtotal there — which is what those requests have
       always committed, so nothing restates itself. */
    amount: money(
      typeof request.grandTotal === "number" && request.grandTotal > 0
        ? request.grandTotal
        : request.totalAmount,
    ),
    /* An unbudgeted promise is still a promise. It has no line to reduce,
       which is precisely why finance has to be able to total them. */
    status: matched ? "committed" : "unbudgeted",
    /* ── WHEN THE MONEY IS EXPECTED TO LEAVE ────────────────────────────
       Cash timing, and NOT the request's `neededBy`. One is when the
       department needs the thing; this is when the company expects to pay.
       A compressor needed on the 1st on thirty-day terms is an outflow on the
       31st, and treating the two as one would put every commitment a month
       early in the forecast.

       Optional: finance may not know the terms at approval, and a required
       date would only be guessed. Undated commitments are simply not in the
       forecast, and the forecast reports how many rather than leaving the
       money silently out. */
    expectedPaymentDate: expectedPaymentDate || undefined,
    committedBy: actor?.email || "",
    committedByName: actor?.name || "",
    committedAt: new Date(),
    snapshot: request.budgetSnapshot
      ? {
          approved: request.budgetSnapshot.approved,
          committedBefore: request.budgetSnapshot.committedBefore,
          actual: request.budgetSnapshot.actual,
          availableBefore: request.budgetSnapshot.availableBefore,
          availableAfter: request.budgetSnapshot.availableAfter,
        }
      : undefined,
  };

  try {
    const created = await Commitment.create(doc);
    return { commitment: created.toObject(), created: true };
  } catch (e) {
    /* The unique index fired — another approval got there first. Its
       commitment is the one that counts. */
    if (e?.code === 11000) {
      const found = await Commitment.findOne({ spendRequestId: request._id }).lean();
      return { commitment: found, created: false };
    }
    throw e;
  }
}

/**
 * THE HEADS A DEPARTMENT MAY ACTUALLY SPEND AGAINST.
 *
 * ── WHY THIS IS NOT THE CHART OF ACCOUNTS ───────────────────────────────────
 * The form used to offer every expense ledger in the books — four hundred and
 * forty of them, most belonging to other departments, some to no department at
 * all. Picking from that list is guessing: a department head has no way to know
 * which of six similarly-named repair heads is the one finance budgeted for
 * them, and the wrong choice does not fail — it files spend against a head
 * nobody is watching.
 *
 * What a department may spend against is what finance already approved FOR
 * THEM, in the period that is running. That is a budget line, not a ledger, and
 * it is a much shorter list: usually two or three.
 *
 * Everything else is excluded on purpose — revenue targets (a floor to reach,
 * not an envelope to spend), other departments' lines (not theirs to spend),
 * and cycles that are not in force (money that has not started).
 */
async function approvedHeadsFor({ companyId, department }) {
  const { Acc_Budget } = require("../models/Accountant_model/Acc_OperationalModels");
  const departments = require("./budgetDepartment.service");
  const actuals = require("./budgetActuals.service");
  const variance = require("./budgetVariance.service");
  const plannedItems = require("./budgetPlannedItems.service");

  const cid = actuals.oid(companyId);
  const wanted = departments.slugify(department);
  if (!cid || !wanted) return { heads: [], reason: cid ? "no_department" : "no_company" };

  const when = new Date();
  const budgets = await Acc_Budget.find({
    status: { $in: control.CONTROLLING_STATUSES },
    startDate: { $lte: when },
    endDate: { $gte: when },
    $or: [{ companyId: cid }, { companyId: { $exists: false } }, { companyId: null }],
  })
    /* `budgetRequests` because the PLANNED ITEMS live there, not on the
       approved line — see budgetPlannedItems.service for the chain. */
    .select("_id name financialYear startDate endDate items budgetRequests")
    .lean();

  /* One department's expense lines, across whatever cycles are running. */
  const lines = [];
  for (const b of budgets) {
    for (const item of b.items || []) {
      if (!item?.ledgerId) continue;
      if (departments.slugify(item.department) !== wanted) continue;
      lines.push({ budget: b, item });
    }
  }
  if (!lines.length) return { heads: [], reason: "no_lines" };

  /* Nature from the GROUP, like every other budget figure in this module —
     a revenue target is not an envelope to spend out of. */
  const natures = await actuals.natureByLedger(lines.map((l) => l.item.ledgerId));
  const expense = lines.filter((l) => {
    const n = natures.get(String(l.item.ledgerId));
    const kind = typeof n === "string" ? n : n?.nature;
    return kind !== "revenue";
  });
  if (!expense.length) return { heads: [], reason: "no_expense_lines" };

  const [hydrated, committed] = await Promise.all([
    actuals.hydrateLines({
      companyId: cid,
      lines: expense.map((l) => ({
        ledgerId: l.item.ledgerId,
        costCentreId: l.item.costCentreId || null,
      })),
      from: expense[0].budget.startDate,
      to: expense[0].budget.endDate,
    }),
    committedByLine(expense.map((l) => l.item._id)),
  ]);

  const heads = expense.map((l, i) => {
    const approved = money(l.item.allocatedAmount);
    const actual = money(hydrated[i]?.actual);
    const comm = committed.get(String(l.item._id)) || 0;
    const line = variance.evaluateLine({
      allocated: approved,
      actual,
      committed: comm,
      nature: "expense",
    });
    return {
      ledgerId: String(l.item.ledgerId),
      name: l.item.ledgerName || "Unnamed head",
      budgetId: String(l.budget._id),
      budgetLineId: String(l.item._id),
      financialYear: l.budget.financialYear || null,
      department: l.item.department || department,
      /* ── WHAT FINANCE ACTUALLY AGREED TO INSIDE THIS HEAD ──────────────
         The head is the bucket; these are the rows. Spending against the
         bucket alone lets somebody buy the thing finance refused out of the
         money finance approved for something else. */
      plannedItems: plannedItems.plannedItemsFor(l.budget, l.item),
      approved,
      committed: comm,
      actual,
      /* What is left to spend, after what has been paid and what has been
         promised — the figure the picker shows and the one a new request is
         measured against. */
      available: money(line.remaining),
    };
  });

  heads.sort((a, b) => a.name.localeCompare(b.name));
  return { heads, reason: null };
}

/* ── WHICH VOUCHERS ARE THE ACTUAL FOR A SPEND ──────────────────────────────
 * A purchase bill, a journal that books the expense, a debit note that adjusts
 * it — these are the expense hitting the books, and they replace the promise.
 *
 * A PAYMENT is deliberately not here. It settles a payable the purchase
 * voucher already posted; the expense was recognised then, and releasing again
 * when the money physically leaves would release on the strength of a document
 * that is not the spend. Same for receipts, contras and anything on the sales
 * side. */
const RELEASING_TYPES = ["purchase", "journal", "debit_note"];

/**
 * The commitment a voucher is the actual for — by explicit link only.
 *
 * ── WHY THERE IS NO FUZZY MATCH ─────────────────────────────────────────────
 * Amount, vendor and date would eventually release the wrong commitment. Two
 * ₹12,000 repairs from the same vendor in the same week is not an unusual
 * month, and a wrongly released commitment is money the budget believes it has
 * and does not. So: the link the voucher carries, or the order number the
 * request recorded, or nothing.
 */
async function commitmentForVoucher(voucher) {
  if (!voucher) return null;
  if (!RELEASING_TYPES.includes(String(voucher.voucherType || ""))) return null;

  /* 1 · the commitment named outright. */
  if (voucher.budgetCommitmentId) {
    return Commitment.findById(voucher.budgetCommitmentId);
  }

  /* 2 · the request named outright. */
  if (voucher.spendRequestId) {
    return Commitment.findOne({ spendRequestId: voucher.spendRequestId });
  }

  /* 3 · the order Store raised against the request, quoted on the bill. An
     exact string the company itself generated — not a guess about which
     invoice this looks like. */
  const ref = String(voucher.referenceNumber || "").trim();
  if (!ref) return null;
  const SpendRequest = require("../models/CMS_Models/Requests/SpendRequest");
  const request = await SpendRequest.findOne({ orderReference: ref })
    .select("_id")
    .lean();
  return request ? Commitment.findOne({ spendRequestId: request._id }) : null;
}

/**
 * The promise has become real spend — stop counting it.
 *
 * Never deletes. The row stays exactly as written, because it records a
 * decision made on a date against numbers that were true then, and the invoice
 * arriving does not make that untrue.
 *
 * Idempotent: a commitment that is already released is left alone, so a retried
 * post, a re-save or a second linked voucher cannot release it twice.
 */
async function releaseForVoucher({ commitment, voucher, actor, reason = "voucher_posted" }) {
  if (!commitment) return { released: false, why: "no_commitment" };
  if (commitment.status === "released") return { released: false, why: "already_released" };

  /* One company's voucher must never touch another's commitment. */
  if (
    commitment.companyId &&
    voucher?.companyId &&
    String(commitment.companyId) !== String(voucher.companyId)
  ) {
    return { released: false, why: "different_company" };
  }

  commitment.status = "released";
  commitment.releasedAt = new Date();
  commitment.releasedBy = actor?.email || actor?.id || "";
  commitment.releasedByName = actor?.name || "";
  commitment.releaseReason = reason;
  commitment.releasedByVoucherId = voucher?._id;
  commitment.releasedByVoucherNumber = voucher?.voucherNumber || "";
  commitment.releasedAmount = money(voucher?.grandTotal ?? commitment.amount);
  await commitment.save();
  return { released: true, commitment };
}

/**
 * The voucher that replaced a promise has been cancelled — the promise is live
 * again.
 *
 * Only when THIS voucher is the one that released it. A commitment released by
 * a different, still-posted voucher must stay released: the spend really did
 * happen, and reviving it would block the head against money already paid.
 *
 * It returns to what it was, which the presence of a budget line decides — an
 * unbudgeted promise was never reducing a line and must not start.
 */
async function restoreForVoucher({ voucher }) {
  if (!voucher?._id) return { restored: false };
  const commitment = await Commitment.findOne({
    releasedByVoucherId: voucher._id,
    status: "released",
  });
  if (!commitment) return { restored: false };

  commitment.status = commitment.budgetLineId ? "committed" : "unbudgeted";
  commitment.releasedAt = undefined;
  commitment.releasedBy = undefined;
  commitment.releasedByName = undefined;
  commitment.releaseReason = undefined;
  commitment.releasedByVoucherId = undefined;
  commitment.releasedByVoucherNumber = undefined;
  commitment.releasedAmount = undefined;
  await commitment.save();
  return { restored: true, commitment };
}

module.exports = {
  approvedHeadsFor,
  committedByLine,
  matchFor,
  commit,
  money,
  RELEASING_TYPES,
  commitmentForVoucher,
  releaseForVoucher,
  restoreForVoucher,
};
