/**
 * GRAV-CMS-BACKEND/services/budgetActuals.service.js
 *
 * What was ACTUALLY earned and spent, per ledger head, for a date window.
 *
 * ── WHY THIS REPLACED THE CATEGORY-STRING MATCH ─────────────────────────────
 * The original budget screen compared `Acc_Budget.items[].category` against
 * `Acc_Expense.category` by exact string equality, and counted expenses only.
 * That had two failure modes, both silent:
 *
 *   1. Rename a category, or leave a trailing space, and the line reads ZERO
 *      consumed forever. Nothing errors; the budget simply reports comfort.
 *   2. Purchase vouchers, payments and journal entries were invisible. For a
 *      manufacturer that is most of the spend — fabric bought on a purchase
 *      voucher never reached the budget at all.
 *
 * A budget whose actuals are wrong is worse than no budget, because people act
 * on the false comfort. So lines bind to a LEDGER ID, and actuals come from
 * posted vouchers — the same source the trial balance and P&L read, which is
 * the only way the budget can ever agree with the accounts.
 *
 * ── WHAT COUNTS ─────────────────────────────────────────────────────────────
 * `status: "posted"` only. Drafts and pending-approval vouchers are not money
 * yet, and cancelled/void ones never were. `isOptional` vouchers are Tally's
 * planning entries — explicitly not posted to the ledger, so they are excluded
 * too, or the budget would count its own forecast as achievement.
 */

const mongoose = require("mongoose");
const { Acc_Voucher } = require("../models/Accountant_model/Acc_VoucherModels");
const { Acc_Ledger, Acc_Group } = require("../models/Accountant_model/Acc_MasterModels");

/** Cast to ObjectId, or null when the value cannot be one. Never throws. */
function oid(v) {
  if (!v) return null;
  if (v instanceof mongoose.Types.ObjectId) return v;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

/**
 * Ledger id → accounting nature, resolved through the ledger's group.
 *
 * The budget line stores its own nature as a snapshot, but the ledger tree is
 * the authority: if a head is re-parented from an expense group to a revenue
 * one, the actuals must follow the accounts rather than the stale copy on the
 * budget row.
 */
async function natureByLedger(ledgerIds = []) {
  const ids = ledgerIds.map(oid).filter(Boolean);
  if (ids.length === 0) return new Map();

  const ledgers = await Acc_Ledger.find({ _id: { $in: ids } })
    .select("_id name groupId groupName")
    .lean();

  const groupIds = [...new Set(ledgers.map((l) => String(l.groupId)).filter(Boolean))]
    .map(oid)
    .filter(Boolean);

  const groups = await Acc_Group.find({ _id: { $in: groupIds } })
    .select("_id nature name")
    .lean();

  const groupNature = new Map(groups.map((g) => [String(g._id), g.nature]));

  return new Map(
    ledgers.map((l) => [
      String(l._id),
      {
        ledgerName: l.name,
        groupName: l.groupName || null,
        nature: groupNature.get(String(l.groupId)) || null,
      },
    ]),
  );
}

/**
 * Sum posted movement per ledger for a window.
 *
 * Returns a Map of ledgerId → { debit, credit, signed }. The caller turns that
 * into an "actual" using the line's nature, because the sign convention is a
 * budgeting decision rather than a ledger fact:
 *
 *     expense actual =  debit - credit  ( = signed )
 *     revenue actual =  credit - debit  ( = -signed )
 *
 * Both are returned so a caller can also show the gross two-sided movement,
 * which is what an accountant checking a surprising figure asks for first.
 */
async function movementByLedger({ companyId, ledgerIds = [], from, to, excludeVoucherId = null }) {
  const ids = ledgerIds.map(oid).filter(Boolean);
  if (ids.length === 0) return new Map();

  const match = {
    status: "posted",
    isOptional: { $ne: true },
    "ledgerEntries.ledgerId": { $in: ids },
  };
  /* Used when re-checking a voucher that is ALREADY posted: without this its
   * own movement is in the actual, and a caller adding the proposal on top
   * reports double what the voucher really does. Off by default — every
   * ordinary read wants every posted voucher. */
  const excl = oid(excludeVoucherId);
  if (excl) match._id = { $ne: excl };
  const cid = oid(companyId);
  if (cid) match.companyId = cid;

  const fromT = from ? new Date(from) : null;
  const toT = to ? new Date(to) : null;
  if (fromT && !Number.isNaN(fromT.getTime())) match.voucherDate = { $gte: fromT };
  if (toT && !Number.isNaN(toT.getTime())) {
    match.voucherDate = { ...(match.voucherDate || {}), $lte: toT };
  }

  const rows = await Acc_Voucher.aggregate([
    { $match: match },
    { $unwind: "$ledgerEntries" },
    { $match: { "ledgerEntries.ledgerId": { $in: ids } } },
    {
      $group: {
        _id: "$ledgerEntries.ledgerId",
        debit: {
          $sum: { $cond: [{ $eq: ["$ledgerEntries.type", "Dr"] }, "$ledgerEntries.amount", 0] },
        },
        credit: {
          $sum: { $cond: [{ $eq: ["$ledgerEntries.type", "Cr"] }, "$ledgerEntries.amount", 0] },
        },
        vouchers: { $addToSet: "$_id" },
      },
    },
  ]);

  return new Map(
    rows.map((r) => [
      String(r._id),
      {
        debit: r.debit || 0,
        credit: r.credit || 0,
        signed: (r.debit || 0) - (r.credit || 0),
        voucherCount: Array.isArray(r.vouchers) ? r.vouchers.length : 0,
      },
    ]),
  );
}

/**
 * The SAME movement, voucher by voucher, so an actual can be explained.
 *
 * ── WHY THIS SITS BESIDE movementByLedger RATHER THAN INSIDE THE ROUTE ──────
 * Every filter here has to be byte-for-byte the one above — same `posted`,
 * same `isOptional` exclusion, same company clause, same date bounds, same
 * Dr/Cr arithmetic. If the two ever diverge, the drilldown shows a list of
 * vouchers that does not add up to the number it is explaining, and a user
 * who has been told the actual is ₹8,20,000 counts ₹7,90,000 on screen and
 * stops trusting the budget. Keeping them adjacent is the cheapest way to
 * keep them honest; the route test asserts the two agree.
 *
 * One row per VOUCHER, not per ledger entry: a voucher may touch the same
 * head twice (a split allocation), and movementByLedger counts it once via
 * $addToSet. Rows are grouped the same way so voucherCount matches too.
 *
 * `page` is 1-based. The totals returned are for the WHOLE window, not the
 * page — a page-local total under a paginated list is a number that answers
 * no question anyone asked.
 */
async function voucherMovementsForLedger({
  companyId,
  ledgerId,
  from,
  to,
  page = 1,
  limit = 50,
}) {
  const id = oid(ledgerId);
  if (!id) return { rows: [], totals: { debit: 0, credit: 0, signed: 0, voucherCount: 0 }, page: 1, limit, pageCount: 0 };

  const match = {
    status: "posted",
    isOptional: { $ne: true },
    "ledgerEntries.ledgerId": id,
  };
  const cid = oid(companyId);
  if (cid) match.companyId = cid;

  const fromT = from ? new Date(from) : null;
  const toT = to ? new Date(to) : null;
  if (fromT && !Number.isNaN(fromT.getTime())) match.voucherDate = { $gte: fromT };
  if (toT && !Number.isNaN(toT.getTime())) {
    match.voucherDate = { ...(match.voucherDate || {}), $lte: toT };
  }

  /* Everything up to and including the per-voucher $group is shared, so the
   * page of rows and the window totals cannot be computed from different
   * sets of vouchers. */
  const base = [
    { $match: match },
    { $unwind: "$ledgerEntries" },
    { $match: { "ledgerEntries.ledgerId": id } },
    {
      $group: {
        _id: "$_id",
        voucherNumber: { $first: "$voucherNumber" },
        referenceNumber: { $first: "$referenceNumber" },
        voucherType: { $first: "$voucherType" },
        voucherTypeName: { $first: "$voucherTypeName" },
        voucherDate: { $first: "$voucherDate" },
        partyLedgerId: { $first: "$partyLedgerId" },
        partyLedgerName: { $first: "$partyLedgerName" },
        narration: { $first: "$narration" },
        status: { $first: "$status" },
        debit: {
          $sum: { $cond: [{ $eq: ["$ledgerEntries.type", "Dr"] }, "$ledgerEntries.amount", 0] },
        },
        credit: {
          $sum: { $cond: [{ $eq: ["$ledgerEntries.type", "Cr"] }, "$ledgerEntries.amount", 0] },
        },
        /* The entry's own narration is usually the more specific one — the
         * voucher-level note describes the whole document. Prefer it when it
         * is there, fall back to the header. */
        entryNarration: { $first: "$ledgerEntries.narration" },
      },
    },
  ];

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);

  const [out] = await Acc_Voucher.aggregate([
    ...base,
    {
      $facet: {
        rows: [
          { $sort: { voucherDate: 1, voucherNumber: 1 } },
          { $skip: (safePage - 1) * safeLimit },
          { $limit: safeLimit },
        ],
        totals: [
          {
            $group: {
              _id: null,
              debit: { $sum: "$debit" },
              credit: { $sum: "$credit" },
              voucherCount: { $sum: 1 },
            },
          },
        ],
      },
    },
  ]);

  const t = (out && out.totals && out.totals[0]) || { debit: 0, credit: 0, voucherCount: 0 };
  const rows = (out && out.rows) || [];

  return {
    rows: rows.map((r) => ({
      voucherId: r._id,
      voucherNumber: r.voucherNumber || null,
      referenceNumber: r.referenceNumber || null,
      voucherType: r.voucherType || null,
      voucherTypeName: r.voucherTypeName || null,
      voucherDate: r.voucherDate || null,
      partyLedgerId: r.partyLedgerId || null,
      partyLedgerName: r.partyLedgerName || null,
      narration: r.entryNarration || r.narration || null,
      status: r.status,
      debit: r.debit || 0,
      credit: r.credit || 0,
      signed: (r.debit || 0) - (r.credit || 0),
    })),
    totals: {
      debit: t.debit || 0,
      credit: t.credit || 0,
      signed: (t.debit || 0) - (t.credit || 0),
      voucherCount: t.voucherCount || 0,
    },
    page: safePage,
    limit: safeLimit,
    pageCount: Math.ceil((t.voucherCount || 0) / safeLimit),
  };
}

/**
 * Posted movement per (ledger, voucher) across MANY heads at once.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * movementByLedger answers "how much moved on this head", which is all a
 * single budget needs. The dashboard needs a harder question: when two budgets
 * both cover a head over overlapping dates, WHICH voucher belongs to which
 * budget, so the roll-up counts each payment once instead of once per budget.
 * That cannot be answered from a per-head sum — it needs the vouchers
 * themselves, for every contested head, in one round trip.
 *
 * Every filter here is byte-for-byte movementByLedger's: same `posted`, same
 * `isOptional` exclusion, same company clause, same inclusive date bounds,
 * same Dr/Cr arithmetic. If they diverge the dashboard dedupes a set of
 * vouchers that is not the set it is correcting, and the headline moves for a
 * reason nobody can trace.
 *
 * One row per (ledger, voucher) pair, not per ledger entry — a voucher that
 * touches the same head twice is ONE voucher, which is how movementByLedger
 * counts it via $addToSet. A voucher touching two different contested heads
 * yields two rows, correctly: those are two separate movements to assign.
 *
 * `limit` caps the rows returned. The caller MUST check `truncated` and skip
 * deduplication rather than publish a half-deduplicated total, which would be
 * wrong in a new and less obvious way than the double-count it replaces.
 */
async function voucherMovementsByLedgers({
  companyId,
  ledgerIds = [],
  from,
  to,
  limit = 20000,
}) {
  const ids = ledgerIds.map(oid).filter(Boolean);
  if (ids.length === 0) return { rows: [], truncated: false };

  const match = {
    status: "posted",
    isOptional: { $ne: true },
    "ledgerEntries.ledgerId": { $in: ids },
  };
  const cid = oid(companyId);
  if (cid) match.companyId = cid;

  const fromT = from ? new Date(from) : null;
  const toT = to ? new Date(to) : null;
  if (fromT && !Number.isNaN(fromT.getTime())) match.voucherDate = { $gte: fromT };
  if (toT && !Number.isNaN(toT.getTime())) {
    match.voucherDate = { ...(match.voucherDate || {}), $lte: toT };
  }

  const cap = Math.max(1, Number(limit) || 20000);

  const rows = await Acc_Voucher.aggregate([
    { $match: match },
    { $unwind: "$ledgerEntries" },
    { $match: { "ledgerEntries.ledgerId": { $in: ids } } },
    {
      $group: {
        _id: { ledgerId: "$ledgerEntries.ledgerId", voucherId: "$_id" },
        voucherDate: { $first: "$voucherDate" },
        debit: {
          $sum: { $cond: [{ $eq: ["$ledgerEntries.type", "Dr"] }, "$ledgerEntries.amount", 0] },
        },
        credit: {
          $sum: { $cond: [{ $eq: ["$ledgerEntries.type", "Cr"] }, "$ledgerEntries.amount", 0] },
        },
      },
    },
    /* Sorted so the assignment below is reproducible run to run: an unsorted
     * aggregate may return rows in any order, and an ambiguity broken by
     * arrival order would make the same data total differently on a retry. */
    { $sort: { "_id.voucherId": 1, "_id.ledgerId": 1 } },
    { $limit: cap + 1 },
  ]);

  const truncated = rows.length > cap;

  return {
    rows: rows.slice(0, cap).map((r) => ({
      ledgerId: String(r._id.ledgerId),
      voucherId: String(r._id.voucherId),
      voucherDate: r.voucherDate || null,
      debit: r.debit || 0,
      credit: r.credit || 0,
      signed: (r.debit || 0) - (r.credit || 0),
    })),
    truncated,
  };
}

/**
 * The same posted movement, bucketed by CALENDAR MONTH.
 *
 * For the budget page's one large graphic. Everything about what counts is
 * identical to movementByLedger — posted only, optional excluded, same company
 * clause, same date bounds — because a chart that disagreed with the totals
 * printed beside it would be worse than no chart.
 *
 * Bucketed in IST, not UTC. `$month` on a UTC date puts a 1-April IST voucher
 * (which is 31-March 18:30 UTC) in March, so the first month of every Indian
 * financial year would silently under-report.
 *
 * Returns [{ key: "2026-04", revenue, expense }] ascending. The caller decides
 * the sign convention; both natures are returned raw as debit/credit sums per
 * bucket so `actualFrom` stays the one place the rule lives.
 */
async function monthlyMovement({ companyId, ledgerIds = [], from, to }) {
  const ids = ledgerIds.map(oid).filter(Boolean);
  if (ids.length === 0) return [];

  const match = {
    status: "posted",
    isOptional: { $ne: true },
    "ledgerEntries.ledgerId": { $in: ids },
  };
  const cid = oid(companyId);
  if (cid) match.companyId = cid;

  const fromT = from ? new Date(from) : null;
  const toT = to ? new Date(to) : null;
  if (fromT && !Number.isNaN(fromT.getTime())) match.voucherDate = { $gte: fromT };
  if (toT && !Number.isNaN(toT.getTime())) {
    match.voucherDate = { ...(match.voucherDate || {}), $lte: toT };
  }

  const rows = await Acc_Voucher.aggregate([
    { $match: match },
    { $unwind: "$ledgerEntries" },
    { $match: { "ledgerEntries.ledgerId": { $in: ids } } },
    {
      $group: {
        _id: {
          /* IST, explicitly — see the header. */
          month: { $dateToString: { date: "$voucherDate", format: "%Y-%m", timezone: "Asia/Kolkata" } },
          ledgerId: "$ledgerEntries.ledgerId",
        },
        debit: {
          $sum: { $cond: [{ $eq: ["$ledgerEntries.type", "Dr"] }, "$ledgerEntries.amount", 0] },
        },
        credit: {
          $sum: { $cond: [{ $eq: ["$ledgerEntries.type", "Cr"] }, "$ledgerEntries.amount", 0] },
        },
      },
    },
  ]);

  return rows.map((r) => ({
    key: r._id.month,
    ledgerId: r._id.ledgerId,
    debit: r.debit || 0,
    credit: r.credit || 0,
    signed: (r.debit || 0) - (r.credit || 0),
  }));
}

/** Turn raw movement into a budget "actual", given the line's nature. */
function actualFrom(movement, nature) {
  if (!movement) return 0;
  return nature === "revenue" ? -movement.signed : movement.signed;
}

/**
 * The one call a route needs: hydrate every line of a budget with its actual.
 *
 * Lines that carry no `ledgerId` are returned with `actual: 0` and
 * `unbound: true` rather than being dropped — a legacy row that predates ledger
 * binding must stay visible and must say why it reads zero, instead of quietly
 * looking like a line nobody spent against.
 */
async function hydrateLines({ companyId, lines = [], from, to }) {
  const ledgerIds = lines.map((l) => l && l.ledgerId).filter(Boolean);
  const [natures, movements] = await Promise.all([
    natureByLedger(ledgerIds),
    movementByLedger({ companyId, ledgerIds, from, to }),
  ]);

  return lines.map((line) => {
    if (!line) return line;
    const key = line.ledgerId ? String(line.ledgerId) : null;
    if (!key) {
      return { ...line, actual: 0, unbound: true, voucherCount: 0 };
    }
    const meta = natures.get(key) || {};
    const movement = movements.get(key) || null;
    /* Ledger tree wins over the snapshot on the row — see natureByLedger. */
    const nature = meta.nature || line.nature || "expense";
    return {
      ...line,
      nature,
      ledgerName: meta.ledgerName || line.ledgerName || null,
      groupName: meta.groupName || line.groupName || null,
      actual: actualFrom(movement, nature),
      debit: movement ? movement.debit : 0,
      credit: movement ? movement.credit : 0,
      voucherCount: movement ? movement.voucherCount : 0,
      unbound: false,
    };
  });
}

module.exports = {
  oid,
  natureByLedger,
  movementByLedger,
  monthlyMovement,
  voucherMovementsForLedger,
  voucherMovementsByLedgers,
  actualFrom,
  hydrateLines,
};
