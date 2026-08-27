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
  costCentreId = null,
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

  /* ── WHEN THE LINE TARGETS A COST CENTRE ────────────────────────────────
   * The drilldown has to explain the SAME number the line reports. A bound
   * line's actual counts only allocations tagged to its cost centre, so the
   * list behind it must too — otherwise a user told the actual is 6,00,000
   * counts 52,00,000 on screen and stops trusting the budget, which is the
   * precise failure this function's header exists to prevent.
   *
   * The unwind changes what a "row" is: the amount becomes the ALLOCATION's,
   * not the entry's. Everything downstream still groups per voucher. */
  const cc = oid(costCentreId);
  const scopeToCostCentre = cc
    ? [
        { $unwind: "$ledgerEntries.costCentreAllocations" },
        { $match: { "ledgerEntries.costCentreAllocations.costCentreId": cc } },
        {
          $addFields: {
            "ledgerEntries.amount": {
              $ifNull: ["$ledgerEntries.costCentreAllocations.amount", 0],
            },
          },
        },
      ]
    : [];

  /* Everything up to and including the per-voucher $group is shared, so the
   * page of rows and the window totals cannot be computed from different
   * sets of vouchers. */
  const base = [
    { $match: match },
    { $unwind: "$ledgerEntries" },
    { $match: { "ledgerEntries.ledgerId": id } },
    ...scopeToCostCentre,
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
 * Posted movement per (ledger, COST CENTRE) — what a project actually spent.
 *
 * ── WHY A BUDGET LINE CANNOT JUST MATCH ON THE LEDGER ───────────────────────
 * movementByLedger answers "how much moved on this head, company-wide". For a
 * company or department budget that is the right question. For a PROJECT it is
 * catastrophically wrong: a budget named after one project would claim every
 * rupee spent on that head across every project, and report an actual several
 * times its real one. A number that looks like a control and is not one is
 * worse than no number, which is why project budgets were held back until this
 * existed.
 *
 * ── THE ALLOCATION IS PER AMOUNT, NOT PER ENTRY ─────────────────────────────
 * `ledgerEntries[].costCentreAllocations[]` carries its own `amount`, so one
 * 1,00,000 purchase entry can be 60,000 to a project and 40,000 elsewhere.
 * This sums the ALLOCATIONS, never the entry, or a split voucher would credit
 * each project with the whole thing.
 *
 * The Dr/Cr direction comes from the parent ENTRY: an allocation has a
 * magnitude, not a side. Reading a sign off the allocation would make every
 * credit note add to project spend.
 *
 * Every other filter is byte-for-byte movementByLedger's — same `posted`, same
 * `isOptional` exclusion, same company clause, same inclusive date bounds — so
 * a project line and a company line on the same head are answering the same
 * question about the same set of vouchers.
 *
 * Returns a Map keyed `${ledgerId}::${costCentreId}`.
 */
async function movementByLedgerCostCentre({
  companyId,
  pairs = [],
  from,
  to,
  excludeVoucherId = null,
}) {
  /* [{ ledgerId, costCentreId }] — only the combinations actually budgeted,
   * so a company with a hundred cost centres does not aggregate all of them
   * to answer a question about two. */
  const wanted = pairs
    .map((p) => ({ ledgerId: oid(p.ledgerId), costCentreId: oid(p.costCentreId) }))
    .filter((p) => p.ledgerId && p.costCentreId);
  if (!wanted.length) return new Map();

  const ledgerIds = [...new Set(wanted.map((p) => String(p.ledgerId)))].map(oid).filter(Boolean);
  const costCentreIds = [...new Set(wanted.map((p) => String(p.costCentreId)))].map(oid).filter(Boolean);

  const match = {
    status: "posted",
    isOptional: { $ne: true },
    "ledgerEntries.ledgerId": { $in: ledgerIds },
  };
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
    { $match: { "ledgerEntries.ledgerId": { $in: ledgerIds } } },
    { $unwind: "$ledgerEntries.costCentreAllocations" },
    { $match: { "ledgerEntries.costCentreAllocations.costCentreId": { $in: costCentreIds } } },
    {
      $group: {
        _id: {
          ledgerId: "$ledgerEntries.ledgerId",
          costCentreId: "$ledgerEntries.costCentreAllocations.costCentreId",
        },
        /* The ENTRY decides the side; the allocation only says how much. */
        debit: {
          $sum: {
            $cond: [
              { $eq: ["$ledgerEntries.type", "Dr"] },
              { $ifNull: ["$ledgerEntries.costCentreAllocations.amount", 0] },
              0,
            ],
          },
        },
        credit: {
          $sum: {
            $cond: [
              { $eq: ["$ledgerEntries.type", "Cr"] },
              { $ifNull: ["$ledgerEntries.costCentreAllocations.amount", 0] },
              0,
            ],
          },
        },
        vouchers: { $addToSet: "$_id" },
      },
    },
  ]);

  return new Map(
    rows.map((r) => [
      `${r._id.ledgerId}::${r._id.costCentreId}`,
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
        /* Kept per entry so the Dr/Cr side stays attached to its allocations:
         * an allocation carries a magnitude, never a side. */
        entries: {
          $push: {
            type: "$ledgerEntries.type",
            amount: "$ledgerEntries.amount",
            allocations: "$ledgerEntries.costCentreAllocations",
          },
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

  /* ── ONE ROW PER (HEAD, VOUCHER, COST-CENTRE SCOPE) ────────────────────────
   * A voucher entry can be part-attributed: 60,000 of a 1,00,000 purchase to a
   * project, 40,000 to nothing in particular. Those two halves belong to
   * DIFFERENT budgets — the project's line owns the first, and only a line
   * that does not care about projects can own the second.
   *
   * Splitting here means the assignment downstream never has to know about
   * allocations; it just sees movements that happen to carry a cost centre.
   * A voucher that tags nothing yields exactly one untagged row, which is
   * precisely what this function returned before cost centres existed.
   */
  const out = [];
  for (const r of rows.slice(0, cap)) {
    const base = {
      ledgerId: String(r._id.ledgerId),
      voucherId: String(r._id.voucherId),
      voucherDate: r.voucherDate || null,
    };
    const byScope = new Map();
    const bucket = (costCentreId) => {
      const key = costCentreId || "";
      if (!byScope.has(key)) byScope.set(key, { ...base, costCentreId: costCentreId || null, debit: 0, credit: 0 });
      return byScope.get(key);
    };

    for (const e of r.entries || []) {
      const side = e.type === "Cr" ? "credit" : "debit";
      const amount = Number(e.amount) || 0;
      let tagged = 0;
      for (const a of e.allocations || []) {
        if (!a || !a.costCentreId) continue;
        const amt = Number(a.amount) || 0;
        if (!(amt > 0)) continue;
        tagged += amt;
        bucket(String(a.costCentreId))[side] += amt;
      }
      /* Clamped: an over-allocated entry is refused at write time, but a row
       * written before that validation existed must not produce negative
       * untagged spend. */
      const untagged = Math.max(0, amount - tagged);
      if (untagged > 0 || !(e.allocations || []).length) bucket(null)[side] += untagged;
    }

    for (const m of byScope.values()) {
      /* A scope that nets to nothing contributes nothing and would only add
       * noise to the contested counts. */
      if (m.debit === 0 && m.credit === 0) continue;
      out.push({ ...m, signed: m.debit - m.credit });
    }
  }

  return { rows: out, truncated };
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

  /* Only the lines that actually target a cost centre need the second, more
   * expensive aggregation. A company or department budget costs exactly what
   * it always did. */
  const pairs = lines
    .filter((l) => l && l.ledgerId && l.costCentreId)
    .map((l) => ({ ledgerId: l.ledgerId, costCentreId: l.costCentreId }));

  const [natures, movements, ccMovements] = await Promise.all([
    natureByLedger(ledgerIds),
    movementByLedger({ companyId, ledgerIds, from, to }),
    pairs.length
      ? movementByLedgerCostCentre({ companyId, pairs, from, to })
      : Promise.resolve(new Map()),
  ]);

  return lines.map((line) => {
    if (!line) return line;
    const key = line.ledgerId ? String(line.ledgerId) : null;
    if (!key) {
      return { ...line, actual: 0, unbound: true, voucherCount: 0 };
    }
    const meta = natures.get(key) || {};
    /* Ledger tree wins over the snapshot on the row — see natureByLedger. */
    const nature = meta.nature || line.nature || "expense";

    const headMovement = movements.get(key) || null;
    const costCentreId = line.costCentreId ? String(line.costCentreId) : null;

    if (!costCentreId) {
      return {
        ...line,
        nature,
        ledgerName: meta.ledgerName || line.ledgerName || null,
        groupName: meta.groupName || line.groupName || null,
        actual: actualFrom(headMovement, nature),
        debit: headMovement ? headMovement.debit : 0,
        credit: headMovement ? headMovement.credit : 0,
        voucherCount: headMovement ? headMovement.voucherCount : 0,
        unbound: false,
        costCentreBound: false,
      };
    }

    /* ── A COST-CENTRE-BOUND LINE ──────────────────────────────────────────
     * Counts ONLY what was tagged to its cost centre. It must never fall back
     * to the head's total when nothing is tagged: that fallback is exactly the
     * "project budget claims all spend on the head" failure this binding
     * exists to prevent, and it would be invisible.
     *
     * A zero here therefore means "nothing was attributed to this project",
     * which is a different and much more useful statement than "nothing was
     * spent". `headActual` carries what DID move on the head so a caller can
     * say which of the two it is — a bound line reading 0 beside a head that
     * moved 52,00,000 is a data-entry problem, not an underspend. */
    const movement = ccMovements.get(`${key}::${costCentreId}`) || null;
    const headActual = actualFrom(headMovement, nature);
    const actual = actualFrom(movement, nature);

    return {
      ...line,
      nature,
      ledgerName: meta.ledgerName || line.ledgerName || null,
      groupName: meta.groupName || line.groupName || null,
      actual,
      debit: movement ? movement.debit : 0,
      credit: movement ? movement.credit : 0,
      voucherCount: movement ? movement.voucherCount : 0,
      unbound: false,
      costCentreBound: true,
      /* What moved on the head in total, attributed or not. */
      headActual,
      /* Spend on this head that carries no tag for this cost centre. Named so
       * the UI can explain a zero rather than presenting it as achievement. */
      unattributed: headActual - actual,
    };
  });
}

module.exports = {
  oid,
  natureByLedger,
  movementByLedger,
  movementByLedgerCostCentre,
  monthlyMovement,
  voucherMovementsForLedger,
  voucherMovementsByLedgers,
  actualFrom,
  hydrateLines,
};
