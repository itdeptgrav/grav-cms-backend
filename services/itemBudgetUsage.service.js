"use strict";
/**
 * services/itemBudgetUsage.service.js
 *
 * WHICH ITEMS AND SERVICES ARE CONSUMING EACH BUDGET HEAD.
 *
 * Finance can already see that a head has ₹8.4 lakh committed against it. What
 * they could not see is WHAT — which items, which services, out of which
 * requests, how much of it has been billed and how much is still reserved.
 * That answer already exists, one row at a time, inside
 * `Acc_BudgetCommitment.allocations`. This file reads it; it decides nothing.
 *
 * ── NO SECOND ALLOCATION ENGINE ─────────────────────────────────────────────
 * Not one figure here is derived from a request, a purchase order, a voucher
 * or the Item Master. Every number is a field already stored on an allocation,
 * because a report that recomputed the split would eventually disagree with
 * the commitment that governs the budget — and the report is the thing people
 * would believe.
 *
 * ── THE THREE FIGURES, AND WHAT THEY ARE NOT ────────────────────────────────
 *   approved  `amount`           what finance agreed. Never rewritten.
 *   billed    `releasedAmount`   bills MATCHED TO THIS COMMITMENT.
 *   reserved  `remainingAmount`  still promised, still blocking the head.
 *
 * `billed` is emphatically NOT "the accounting actuals for this head". It
 * counts only vouchers that were matched to these commitments. A voucher
 * posted straight to the ledger, or one whose lines carried no request-line
 * identity, is a real actual and is invisible here. Saying otherwise would
 * make this screen look like a general ledger it is not, and the difference
 * would be read as missing money. The wording that says so is in the
 * presentation layer, and a test pins it.
 *
 * ── AND WHAT IS DELIBERATELY NOT ATTRIBUTED ─────────────────────────────────
 * Legacy commitments — written before line-wise allocation existed — carry no
 * `allocations` at all. Their value is real and their composition is unknown.
 * They are reported as a separate count and total, never split across items on
 * a guess. An allocation with no `itemId` and no `serviceId` is "Unidentified"
 * and is never merged with another row by NAME: two requests that both said
 * "bearings" are not evidence of one item.
 */

/* `blank is not zero`. `Number(null)` is 0 and IS finite, so a missing
   `remainingAmount` would otherwise read as a legitimately exhausted one —
   and every older row would report nothing reserved. */
const present = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const num = (v) => (present(v) ? Number(v) : 0);

/* ── THE ARITHMETIC, ONCE ────────────────────────────────────────────────────
 * `remainingAmount` is stored, and is authoritative when it is there — the
 * release path maintains it. The fallback exists for rows written before it
 * did, and is clamped at zero: a row billed slightly over its commitment is a
 * real and separate problem, and reporting negative reserved money would make
 * every total that contains it quietly wrong. */
function figuresOf(allocation = {}) {
  const approved = num(allocation.amount);
  const billed = num(allocation.releasedAmount);
  const reserved = present(allocation.remainingAmount)
    ? Math.max(num(allocation.remainingAmount), 0)
    : Math.max(approved - billed, 0);
  return { approved, billed, reserved };
}

const STATUS = Object.freeze({
  COMMITTED: "committed",
  PARTIAL: "partially_billed",
  FULLY: "fully_billed",
  UNBUDGETED: "unbudgeted",
});

const STATUS_LABEL = Object.freeze({
  [STATUS.COMMITTED]: "Committed",
  [STATUS.PARTIAL]: "Partially billed",
  [STATUS.FULLY]: "Fully billed",
  [STATUS.UNBUDGETED]: "Unbudgeted",
});

/* Unbudgeted is checked FIRST and is not a billing state. An unbudgeted
   promise has no head to consume, so calling it "committed" would invite it
   into a head total it must never join. */
function statusOf({ approved, billed, reserved, unbudgeted }) {
  if (unbudgeted) return STATUS.UNBUDGETED;
  if (billed <= 0) return STATUS.COMMITTED;
  if (reserved > 0) return STATUS.PARTIAL;
  return STATUS.FULLY;
}

const KIND = Object.freeze({ ITEM: "item", SERVICE: "service", UNIDENTIFIED: "unidentified" });

/**
 * What this allocation is a promise to buy.
 *
 * ── IDENTITY IS AN ID, NOT A NAME ───────────────────────────────────────────
 * An allocation with a stored `itemId` is that item; one with a `serviceId` is
 * that service. An allocation with neither is UNIDENTIFIED, and it is given a
 * key unique to its own request line so that two lines which happen to share a
 * name are never merged into one row. Merging them would manufacture an item
 * that does not exist and attribute real money to it.
 *
 * The SKU is accepted as identity only when there is no id — a stored SKU was
 * a real catalogue code at the time, which is more than a typed name is.
 */
function identityOf(allocation = {}, commitment = {}) {
  const name = String(allocation.name || "").trim();

  if (allocation.itemId) {
    return { kind: KIND.ITEM, key: `item:${allocation.itemId}`, name, itemId: String(allocation.itemId), sku: allocation.itemSku || null };
  }
  if (allocation.serviceId) {
    return { kind: KIND.SERVICE, key: `service:${allocation.serviceId}`, name, serviceId: String(allocation.serviceId), serviceCode: allocation.serviceCode || null };
  }
  if (allocation.itemSku) {
    return { kind: KIND.ITEM, key: `sku:${String(allocation.itemSku).trim().toLowerCase()}`, name, itemId: null, sku: allocation.itemSku };
  }
  if (allocation.serviceCode) {
    return { kind: KIND.SERVICE, key: `svc:${String(allocation.serviceCode).trim().toLowerCase()}`, name, serviceId: null, serviceCode: allocation.serviceCode };
  }
  /* Keyed by the LINE, not the name. See above. */
  return {
    kind: KIND.UNIDENTIFIED,
    key: `line:${commitment._id || ""}:${allocation.spendLineId || ""}`,
    name, itemId: null, serviceId: null, sku: null, serviceCode: null,
  };
}

/** The most recent thing that happened to this promise. */
function latestActivity(allocation = {}, commitment = {}) {
  const dates = [commitment.committedAt, ...(allocation.releases || []).map((r) => r.at)]
    .map((d) => (d ? new Date(d) : null))
    .filter((d) => d && !Number.isNaN(d.getTime()));
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

/**
 * One flat row per allocation — the atom every grouping and total is built
 * from. Snapshots are used exactly as stored: the ledger name, the SKU and
 * the item name are what they were WHEN THE PROMISE WAS MADE, and replacing
 * them with today's Item Master values would rewrite the history the
 * commitment exists to preserve.
 */
function rowsFor(commitment = {}) {
  const allocations = Array.isArray(commitment.allocations) ? commitment.allocations : null;
  if (!allocations || !allocations.length) return [];

  return allocations.map((a) => {
    const figures = figuresOf(a);
    const unbudgeted = a.status === "unbudgeted" || !a.ledgerId;
    const identity = identityOf(a, commitment);
    return {
      ...identity,
      ...figures,
      unbudgeted,
      status: statusOf({ ...figures, unbudgeted }),

      /* The head, as snapshotted. Absent on an unbudgeted row, honestly. */
      ledgerId: a.ledgerId ? String(a.ledgerId) : null,
      ledgerName: a.ledgerName || null,
      budgetId: a.budgetId ? String(a.budgetId) : null,
      financialYear: a.financialYear || commitment.financialYear || null,
      department: commitment.department || null,

      /* Where it came from, so a row can be opened and checked. */
      commitmentId: String(commitment._id || ""),
      spendRequestId: commitment.spendRequestId ? String(commitment.spendRequestId) : null,
      spendRequestNumber: commitment.spendRequestNumber || null,
      spendLineId: a.spendLineId ? String(a.spendLineId) : null,
      committedAt: commitment.committedAt || null,
      committedByName: commitment.committedByName || null,

      /* Why this head, in the vocabulary the allocation itself stored. */
      resolutionSource: a.resolutionSource || null,
      resolutionReason: a.resolutionReason || "",
      selectedByName: a.selectedByName || "",

      /* ── THE BILLS, EACH COUNTED ONCE ────────────────────────────────────
         `releases` is append-only and one row per voucher line that
         discharged part of this allocation. Several rows can name the SAME
         voucher — two deliveries of one fabric on one invoice — so the
         voucher list is de-duplicated for display while the AMOUNT is the
         sum of every row. Summing per unique voucher would drop the second
         contribution; listing per row would show one bill twice. */
      releases: (a.releases || []).map((r) => ({
        voucherId: r.voucherId ? String(r.voucherId) : null,
        voucherNumber: r.voucherNumber || null,
        amount: num(r.amount),
        at: r.at || null,
        byName: r.byName || null,
      })),
      vouchers: [...new Map((a.releases || [])
        .filter((r) => r.voucherId)
        .map((r) => [String(r.voucherId), { voucherId: String(r.voucherId), voucherNumber: r.voucherNumber || null }]))
        .values()],

      latestActivityAt: latestActivity(a, commitment),
      reconciliationWarning: commitment.reconciliationWarning || null,
    };
  });
}

/** A commitment that predates line-wise allocation, reported as itself. */
function legacyRowFor(commitment = {}) {
  const approved = num(commitment.amount);
  const billed = num(commitment.releasedAmount);
  return {
    commitmentId: String(commitment._id || ""),
    spendRequestId: commitment.spendRequestId ? String(commitment.spendRequestId) : null,
    spendRequestNumber: commitment.spendRequestNumber || null,
    department: commitment.department || null,
    ledgerId: commitment.ledgerId ? String(commitment.ledgerId) : null,
    ledgerName: commitment.ledgerName || null,
    financialYear: commitment.financialYear || null,
    approved,
    billed,
    reserved: Math.max(approved - billed, 0),
    status: commitment.status || null,
    committedAt: commitment.committedAt || null,
  };
}

/* ── THE FILTERS, APPLIED TO ROWS ────────────────────────────────────────────
 * Applied here rather than in the query because a commitment is matched by
 * what its ALLOCATIONS say — a request with a Packaging line and a Raw
 * Materials line matches a Packaging filter, and only that line should. A
 * `$match` on the document would return both lines or neither. */
function matchesRow(row, f = {}) {
  if (f.financialYear && row.financialYear !== f.financialYear) return false;
  if (f.department && String(row.department || "").toLowerCase() !== String(f.department).toLowerCase()) return false;
  if (f.ledgerId && String(row.ledgerId || "") !== String(f.ledgerId)) return false;
  if (f.kind && row.kind !== f.kind) return false;
  if (f.status && row.status !== f.status) return false;
  if (f.search) {
    const q = String(f.search).trim().toLowerCase();
    const hay = [row.name, row.sku, row.serviceCode, row.spendRequestNumber, row.ledgerName]
      .filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/**
 * Rows folded into the register's groups: one per identity PER BUDGET HEAD.
 *
 * The head is part of the key on purpose. One item bought out of two heads is
 * two facts, and merging them would produce a single figure that belongs to
 * no budget line and cannot be checked against one.
 */
/* One department, spelled several ways, is one department to everybody except
   a string comparison. Normalised for the KEY so "Logistics" and "logistics"
   do not fragment a total; the label shown is chosen deterministically below,
   never "whichever row arrived first". */
const departmentKeyOf = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();

/* The spelling most rows actually use, ties broken alphabetically so the same
   data always renders the same way. */
function commonestLabel(values = []) {
  const counts = new Map();
  for (const v of values) {
    const label = String(v || "").trim();
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

function groupRows(rows = []) {
  const groups = new Map();

  for (const row of rows) {
    /* ── EVERY LABEL ON A GROUP MUST BE TRUE OF ALL OF IT ─────────────────
       The key was identity + head, while `department` and `financialYear`
       were copied from the first row into the group. So the same item on the
       same head, bought by two departments or in two years, became ONE total
       wearing one of their labels — and the other department's money was
       reported as the first one's. A figure that is wrong about who spent it
       is worse than no figure, because it reconciles against nothing and
       nobody can tell by looking.

       Both are now part of the key. Two departments are two rows, two years
       are two rows, and every label on a row is true of every rupee in it. */
    const key = [
      row.key,
      row.ledgerId || "none",
      departmentKeyOf(row.department) || "none",
      row.financialYear || "none",
    ].join("|");
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        identityKey: row.key,
        kind: row.kind,
        name: row.name,
        sku: row.sku || null,
        serviceCode: row.serviceCode || null,
        itemId: row.itemId || null,
        serviceId: row.serviceId || null,
        ledgerId: row.ledgerId,
        ledgerName: row.ledgerName,
        departmentKey: departmentKeyOf(row.department) || null,
        department: null,
        financialYear: row.financialYear || null,
        unbudgeted: row.unbudgeted,
        approved: 0, billed: 0, reserved: 0,
        latestActivityAt: null,
        lines: [],
      };
      groups.set(key, g);
    }
    g.approved += row.approved;
    g.billed += row.billed;
    g.reserved += row.reserved;
    g.lines.push(row);
    if (row.latestActivityAt && (!g.latestActivityAt || row.latestActivityAt > g.latestActivityAt)) {
      g.latestActivityAt = row.latestActivityAt;
    }
    /* A group is unbudgeted only if every row in it is. A mixed key cannot
       occur — the head is part of the key — but stating it keeps the flag
       true to its meaning rather than to the first row seen. */
    g.unbudgeted = g.unbudgeted && row.unbudgeted;
  }

  for (const g of groups.values()) {
    g.status = statusOf({ approved: g.approved, billed: g.billed, reserved: g.reserved, unbudgeted: g.unbudgeted });
    /* Every row in the group shares one normalised department, so the label
       is a choice between SPELLINGS of the same word — not between different
       departments. Chosen deterministically rather than taken from whichever
       row happened to be first. */
    g.department = commonestLabel(g.lines.map((l) => l.department));
    g.lines.sort((a, b) => String(a.spendRequestNumber || "").localeCompare(String(b.spendRequestNumber || "")));
  }

  return [...groups.values()];
}

/**
 * Budget heads, folded from the COMPLETE matched population.
 *
 * ── WHY THIS IS NOT A CLIENT-SIDE REGROUP ───────────────────────────────────
 * It was one. The page received a paginated page of item groups and folded
 * THOSE by head — so with more than one page, "By budget head" showed the
 * total of whatever items happened to be on page 1 while looking like the
 * head's total. A partial figure that announces itself as a total is worse
 * than an error: nobody re-checks a number that looks finished.
 *
 * So the fold happens here, over every row that matched the filters, and the
 * HEAD is what gets paginated afterwards. A head's three figures are always
 * complete. Its drill-down list of items is capped for payload sanity and
 * SAYS so — a capped list that stayed silent would be the same lie one level
 * down.
 */
function groupHeads(rows = [], { itemsPerHead = 50 } = {}) {
  const heads = new Map();

  for (const row of rows) {
    /* Unbudgeted rows consume no head, so they fold into their own bucket
       rather than into a real head's total. */
    const key = row.unbudgeted ? "unbudgeted" : (row.ledgerId || "none");
    let h = heads.get(key);
    if (!h) {
      h = {
        key,
        ledgerId: row.unbudgeted ? null : (row.ledgerId || null),
        ledgerName: row.unbudgeted ? null : (row.ledgerName || null),
        unbudgeted: !!row.unbudgeted,
        approved: 0, billed: 0, reserved: 0,
        rowsForItems: [],
      };
      heads.set(key, h);
    }
    h.approved += row.approved;
    h.billed += row.billed;
    h.reserved += row.reserved;
    h.rowsForItems.push(row);
  }

  return [...heads.values()]
    .map((h) => {
      /* The item breakdown under this head, built from the same rows the
         head total came from — so a reader who expands it is looking at the
         same money, not a second calculation. */
      const items = groupRows(h.rowsForItems)
        .sort((a, b) => b.approved - a.approved || String(a.name).localeCompare(String(b.name)));
      const { rowsForItems, ...rest } = h;
      return {
        ...rest,
        status: statusOf({ approved: h.approved, billed: h.billed, reserved: h.reserved, unbudgeted: h.unbudgeted }),
        itemsTotal: items.length,
        itemsCapped: items.length > itemsPerHead,
        rows: items.slice(0, itemsPerHead),
      };
    })
    .sort((a, b) => b.approved - a.approved);
}

/**
 * The totals.
 *
 * ── WHY UNBUDGETED IS NOT IN THEM ───────────────────────────────────────────
 * An unbudgeted promise consumes no head. Adding it to "approved commitments"
 * would produce a figure that can never be reconciled against any budget line,
 * and the discrepancy would be blamed on the budget rather than on the fact
 * that the money was never budgeted. It gets its own count and total, beside
 * them rather than inside them.
 */
function summarise(rows = []) {
  const budgeted = rows.filter((r) => !r.unbudgeted);
  const unbudgeted = rows.filter((r) => r.unbudgeted);
  const sum = (list, field) => list.reduce((t, r) => t + r[field], 0);

  return {
    approved: sum(budgeted, "approved"),
    billed: sum(budgeted, "billed"),
    reserved: sum(budgeted, "reserved"),
    allocationCount: budgeted.length,
    requestCount: new Set(budgeted.map((r) => r.spendRequestId).filter(Boolean)).size,
    unbudgetedCount: unbudgeted.length,
    unbudgetedValue: sum(unbudgeted, "approved"),
  };
}

/** What the filter controls may offer, drawn from what is actually there. */
function availableFilters(rows = [], legacy = []) {
  const years = new Set();
  const departments = new Set();
  const heads = new Map();
  for (const r of [...rows, ...legacy]) {
    if (r.financialYear) years.add(r.financialYear);
    if (r.department) departments.add(r.department);
    if (r.ledgerId) heads.set(r.ledgerId, r.ledgerName || r.ledgerId);
  }
  return {
    financialYears: [...years].sort(),
    departments: [...departments].sort(),
    heads: [...heads.entries()].map(([id, name]) => ({ ledgerId: id, ledgerName: name }))
      .sort((a, b) => String(a.ledgerName).localeCompare(String(b.ledgerName))),
    kinds: [
      { key: KIND.ITEM, label: "Item" },
      { key: KIND.SERVICE, label: "Service" },
      { key: KIND.UNIDENTIFIED, label: "Unidentified" },
    ],
    statuses: Object.values(STATUS).map((k) => ({ key: k, label: STATUS_LABEL[k] })),
  };
}

/**
 * The whole report, from commitments already loaded.
 *
 * Pure: the caller does the query, so every rule below is testable without a
 * database and the route stays a projection plus a scope.
 */
function buildReport({ commitments = [], filters = {}, page = 1, limit = 50, groupBy = "item" } = {}) {
  const itemised = [];
  const legacy = [];

  for (const c of commitments) {
    const rows = rowsFor(c);
    if (rows.length) itemised.push(...rows);
    else legacy.push(legacyRowFor(c));
  }

  /* The filter lists describe EVERYTHING in scope, not what survived the
     current filter — a department that vanishes from its own dropdown the
     moment it is selected cannot be deselected. */
  const filterOptions = availableFilters(itemised, legacy);

  const matched = itemised.filter((r) => matchesRow(r, filters));
  const matchedLegacy = legacy.filter((r) => {
    if (filters.financialYear && r.financialYear !== filters.financialYear) return false;
    if (filters.department && String(r.department || "").toLowerCase() !== String(filters.department).toLowerCase()) return false;
    if (filters.ledgerId && String(r.ledgerId || "") !== String(filters.ledgerId)) return false;
    /* Legacy rows have no item identity and no per-line billing state, so a
       kind or status filter cannot describe them. They are withheld rather
       than guessed into a bucket. */
    if (filters.kind || filters.status) return false;
    if (filters.search) {
      const q = String(filters.search).trim().toLowerCase();
      const hay = [r.spendRequestNumber, r.ledgerName].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const perPage = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const start = (pageNum - 1) * perPage;

  /* ── GROUPING IS A SERVER QUESTION, NOT A VIEW ────────────────────────────
     Both foldings are built from the SAME complete `matched` population, and
     whichever the caller asked for is what gets paginated. Paginating item
     groups and then folding them by head — which is what the page used to do
     — produces head totals that are true only of the current page. */
  const wantHeads = String(groupBy) === "head";

  const groups = wantHeads ? [] : groupRows(matched)
    .sort((a, b) => b.approved - a.approved || String(a.name).localeCompare(String(b.name)));
  const heads = wantHeads ? groupHeads(matched, { itemsPerHead: perPage }) : [];
  const paged = wantHeads ? heads : groups;

  return {
    /* Over everything matched, not just the visible page — a total that
       counted page one would be quietly wrong. */
    summary: {
      ...summarise(matched),
      legacyCount: matchedLegacy.length,
      legacyValue: matchedLegacy.reduce((t, r) => t + r.approved, 0),
    },
    groupBy: wantHeads ? "head" : "item",
    groups: wantHeads ? [] : groups.slice(start, start + perPage),
    heads: wantHeads ? heads.slice(start, start + perPage) : [],
    legacy: {
      count: matchedLegacy.length,
      value: matchedLegacy.reduce((t, r) => t + r.approved, 0),
      rows: matchedLegacy.slice(0, 50),
    },
    filters: filterOptions,
    pagination: {
      /* Counts whichever grouping was asked for — the thing being paged. */
      total: paged.length,
      page: pageNum,
      limit: perPage,
      totalPages: Math.max(1, Math.ceil(paged.length / perPage)),
    },
  };
}

module.exports = {
  STATUS, STATUS_LABEL, KIND,
  present, figuresOf, statusOf, identityOf, latestActivity,
  rowsFor, legacyRowFor, matchesRow, groupRows, groupHeads, summarise, availableFilters,
  departmentKeyOf, commonestLabel,
  buildReport,
};
