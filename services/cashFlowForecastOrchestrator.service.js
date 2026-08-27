/**
 * GRAV-CMS-BACKEND/services/cashFlowForecastOrchestrator.service.js
 *
 * The Mongo-touching half of Chunk 1-A's Base forecast. Resolves the three
 * inputs the pure engine (cashFlowForecast.service.js) needs — opening cash,
 * dated open items, active recurring items — normalises them, and calls it.
 *
 * ── READ-ONLY, STRUCTURALLY ─────────────────────────────────────────────────
 * Every query in this file is a `find`/`aggregate`. Nothing here creates,
 * updates or deletes anything, and the models it imports are imported for
 * reading only. A forecast that wrote to the ledgers it forecasts from would
 * make two consecutive runs disagree; worse, it would put derived numbers into
 * collections that are supposed to hold stated ones.
 *
 * ── COMPANY SCOPING — FAIL CLOSED ───────────────────────────────────────────
 * A missing or malformed `companyId` produces an EMPTY forecast, never an
 * unscoped one. Same `castId`-or-nothing rule as openItems.service.js,
 * voucherDueDateDefault.service.js and billTermsBackfillOrchestrator
 * .service.js, all of which were hardened to it after the same class of gap
 * was found in each.
 */

const mongoose = require("mongoose");
const { Acc_Company, Acc_Group, Acc_Ledger } = require("../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../models/Accountant_model/Acc_VoucherModels");
const Acc_BillTerms = require("../models/Accountant_model/Acc_BillTerms");
const Acc_RecurringItem = require("../models/Accountant_model/Acc_RecurringItem");
const Acc_ForecastCashLedgerConfig = require("../models/Accountant_model/Acc_ForecastCashLedgerConfig");
const openItems = require("./openItems.service");
const backfill = require("./billTermsBackfillOrchestrator.service");
const engine = require("./cashFlowForecast.service");

/** The horizons this engine will answer for. Anything else is refused. */
const ALLOWED_HORIZONS = Object.freeze([7, 15, 30, 60, 90]);
const DEFAULT_HORIZON = 30;

/**
 * The Tally groups whose ledgers hold spendable cash.
 *
 * Same three names `Acc_books.js`'s cash-flow report already uses, quoted
 * rather than re-derived so the forecast's idea of "cash" cannot drift from
 * the report a person would check it against. "Bank OD A/c" is included and is
 * deliberately allowed to carry a credit (negative) balance — an overdraft is
 * real, spendable headroom, and excluding it would overstate how tight things
 * are.
 */
const CASH_GROUP_NAMES = Object.freeze(["Cash-in-Hand", "Bank Accounts", "Bank OD A/c"]);

/** Cast to ObjectId, or null. Never throws. Mirrors the C0 house helper. */
function castId(v) {
  if (!v) return null;
  if (v instanceof mongoose.Types.ObjectId) return v;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

/**
 * Normalise a grouping request. Returns null when the value is not allowed, so
 * the route can refuse it rather than quietly substituting a default — a
 * caller who asked for `monthly` should be told it does not exist, not handed
 * weekly rows and left to assume they got what they asked for.
 */
function parseGroupBy(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined; // use the horizon default
  if (typeof raw !== "string") return null;
  return engine.GROUPING_MODES.includes(raw) ? raw : null;
}

/** Normalise a horizon request. Returns null when the value is not allowed. */
function parseHorizon(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_HORIZON;
  if (typeof raw === "boolean") return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) return null;
  return ALLOWED_HORIZONS.includes(n) ? n : null;
}

/** Midnight UTC today, or on a supplied date. Null for an unparseable one. */
function parseAsOfDate(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return engine.startOfDayUTC(new Date());
  }
  if (typeof raw === "boolean" || typeof raw === "object") return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return engine.startOfDayUTC(d);
}

/** The company's cash/bank ledgers. Company-scoped, fail-closed. */
async function resolveCashLedgers(companyId) {
  const cid = castId(companyId);
  if (!cid) return [];

  const groups = await Acc_Group.find({ companyId: cid, name: { $in: CASH_GROUP_NAMES } })
    .select("_id")
    .lean();
  if (groups.length === 0) return [];

  // `groupName` is load-bearing, not decoration: Chunk 1-D's suggestion uses
  // it to tell an overdraft account from a bank account, and without it every
  // OD ledger silently defaults to being counted as spendable cash — the exact
  // failure this chunk exists to prevent. (Caught by a route test, not by
  // inspection.)
  return Acc_Ledger.find({ companyId: cid, groupId: { $in: groups.map((g) => g._id) } })
    .select("_id name groupName openingBalance openingBalanceType")
    .lean();
}

/**
 * Posted-voucher balance per cash ledger, as a Map of ledgerId → signed
 * amount, including each ledger's own opening balance.
 *
 * One aggregation for all of them, grouped by ledger, rather than one query
 * per ledger. For a cash/bank ledger a DEBIT is money in, so the signed
 * balance is `Dr − Cr`, and the master's opening balance is signed by its
 * `openingBalanceType` exactly as `Acc_parties.js` already does it.
 *
 * `asOfDate` is optional: the config screen wants balances as of now, while
 * the forecast wants them strictly BEFORE its first day (a voucher dated on
 * day 1 belongs to day 1's movement, not to the balance day 1 starts from —
 * counting it in both would double it).
 */
async function balancesByCashLedger(companyId, ledgers, asOfDate) {
  const cid = castId(companyId);
  const out = new Map();
  if (!cid) return out;

  const cashLedgers = ledgers || (await resolveCashLedgers(cid));
  if (cashLedgers.length === 0) return out;

  const ledgerIds = cashLedgers.map((l) => l._id);
  for (const l of cashLedgers) {
    const sign = l.openingBalanceType === "Cr" ? -1 : 1;
    out.set(String(l._id), sign * Math.abs(Number(l.openingBalance) || 0));
  }

  const match = {
    companyId: cid,
    status: "posted",
    "ledgerEntries.ledgerId": { $in: ledgerIds },
  };
  if (asOfDate) match.voucherDate = { $lt: asOfDate };

  const agg = await Acc_Voucher.aggregate([
    { $match: match },
    { $unwind: "$ledgerEntries" },
    { $match: { "ledgerEntries.ledgerId": { $in: ledgerIds } } },
    {
      $group: {
        _id: "$ledgerEntries.ledgerId",
        dr: {
          $sum: {
            $cond: [{ $eq: ["$ledgerEntries.type", "Dr"] }, { $ifNull: ["$ledgerEntries.amount", 0] }, 0],
          },
        },
        cr: {
          $sum: {
            $cond: [{ $eq: ["$ledgerEntries.type", "Cr"] }, { $ifNull: ["$ledgerEntries.amount", 0] }, 0],
          },
        },
      },
    },
  ]);

  for (const row of agg) {
    const k = String(row._id);
    out.set(k, engine.round2((out.get(k) || 0) + (row.dr || 0) - (row.cr || 0)));
  }
  for (const [k, v] of out) out.set(k, engine.round2(v));
  return out;
}

/** The saved operating-cash selection for a company, or null. */
async function fetchCashLedgerConfig(companyId) {
  const cid = castId(companyId);
  if (!cid) return null;
  return Acc_ForecastCashLedgerConfig.findOne({ companyId: cid }).lean();
}

/**
 * Cash on hand at the start of `asOfDate`, from POSTED vouchers only.
 *
 * ── CHUNK 1-D — WHICH LEDGERS COUNT ─────────────────────────────────────────
 * When a company has SAVED a selection, only its `includedLedgerIds` are
 * summed. OD ledgers are reported separately and never added: an overdraft
 * balance is money owed, and folding it into "cash on hand" misstates both
 * the cash and the headroom.
 *
 * When no selection is saved, behaviour is UNCHANGED from Chunk 1-A — every
 * cash/bank/OD ledger is summed — and the response says so via
 * `openingCashConfig.status: "suggested_default"`. That is deliberate: this
 * chunk must not silently move an existing company's opening balance the
 * moment it ships. The screen prompts finance to review and save, and the
 * number changes when they decide it should, not before.
 */
async function resolveOpeningCash(companyId, asOfDate, ledgers, config) {
  const cid = castId(companyId);
  if (!cid) {
    return { openingCash: 0, cashLedgerCount: 0, odBalance: null, configStatus: "suggested_default", includedLedgerCount: 0, excludedLedgerCount: 0, odLedgerCount: 0 };
  }

  const cashLedgers = ledgers || (await resolveCashLedgers(cid));
  if (cashLedgers.length === 0) {
    return { openingCash: 0, cashLedgerCount: 0, odBalance: null, configStatus: config ? "saved" : "suggested_default", includedLedgerCount: 0, excludedLedgerCount: 0, odLedgerCount: 0 };
  }

  const balances = await balancesByCashLedger(cid, cashLedgers, asOfDate);
  const sumOf = (ids) => engine.round2(ids.reduce((s, id) => s + (balances.get(String(id)) || 0), 0));

  if (!config) {
    // Unchanged Chunk 1-A behaviour: every cash-shaped ledger.
    const all = cashLedgers.map((l) => String(l._id));
    return {
      openingCash: sumOf(all),
      cashLedgerCount: cashLedgers.length,
      odBalance: null,
      configStatus: "suggested_default",
      includedLedgerCount: all.length,
      excludedLedgerCount: 0,
      odLedgerCount: 0,
    };
  }

  // A saved selection is authoritative. Ids are intersected with the
  // company's real cash ledgers so a ledger deleted or re-grouped since the
  // config was saved cannot contribute a balance it no longer has.
  const eligible = new Set(cashLedgers.map((l) => String(l._id)));
  const included = (config.includedLedgerIds || []).map(String).filter((id) => eligible.has(id));
  const odIds = (config.odLedgerIds || []).map(String).filter((id) => eligible.has(id));

  return {
    openingCash: sumOf(included),
    cashLedgerCount: cashLedgers.length,
    odBalance: odIds.length > 0 ? sumOf(odIds) : null,
    configStatus: "saved",
    includedLedgerCount: included.length,
    excludedLedgerCount: (config.excludedLedgerIds || []).length,
    odLedgerCount: odIds.length,
  };
}

/**
 * Every OPEN bill that has a resolved due date, normalised for the engine.
 *
 * The due-date ladder is the one C0-F established and this function does not
 * re-invent: `billAllocations[].dueDate` → the voucher header's own `dueDate`
 * → an `Acc_BillTerms` sidecar row → undated. Undated bills are NOT dated
 * here; they are counted and reported, because Chunk 1-A has no mandate to
 * guess one.
 *
 * A bill's `remaining` is signed by openItems' own convention: positive (Dr)
 * is a receivable and becomes an inflow, negative (Cr) is a payable and
 * becomes an outflow.
 */
/**
 * Which rung of the C0-F ladder produced a bill's due date, as a source the
 * pure engine's `sourceBreakdown` buckets by.
 *
 * A sidecar row is NOT reported as a generic "sidecar": it resolves to the
 * term it was actually derived from (`company_default` / `party_terms`), or to
 * `bill_terms_manual` when a human wrote it directly. The whole point of
 * Chunk 1-B is that a finance user can see how much of a forecast rests on a
 * blanket company default, and a bucket that hides that inside "sidecar"
 * answers the wrong question.
 */
function classifySource(bill, sidecarRow) {
  if (bill.dueDate) return { source: engine.SOURCE.BILL_ALLOCATION_DUE_DATE, backfillRunId: null };
  if (bill.voucherDueDate) return { source: engine.SOURCE.VOUCHER_DUE_DATE, backfillRunId: null };
  if (sidecarRow && sidecarRow.dueDate) {
    const runId = sidecarRow.backfillRunId || null;
    if (sidecarRow.isManual || sidecarRow.source === "manual") {
      return { source: engine.SOURCE.BILL_TERMS_MANUAL, backfillRunId: runId };
    }
    if (sidecarRow.source === "company_default") {
      return { source: engine.SOURCE.COMPANY_DEFAULT, backfillRunId: runId };
    }
    if (sidecarRow.source === "party_terms") {
      return { source: engine.SOURCE.PARTY_TERMS, backfillRunId: runId };
    }
    // A stored source this file does not recognise is reported as the sidecar
    // row it is, rather than being guessed into a derivation bucket.
    return { source: engine.SOURCE.BILL_TERMS_MANUAL, backfillRunId: runId };
  }
  return { source: null, backfillRunId: null };
}

async function resolveDatedOpenItems(companyId) {
  const cid = castId(companyId);
  if (!cid) return { items: [], total: 0, undated: 0, undatedAmount: 0 };

  // Reused rather than re-queried, so "which ledgers are party ledgers" stays
  // one definition across the backfill and the forecast.
  const ledgers = await backfill.resolvePartyLedgers(cid);
  const ledgerIds = ledgers.map((l) => l._id);
  if (ledgerIds.length === 0) return { items: [], total: 0, undated: 0, undatedAmount: 0 };

  // Names for the drilldown and the party diagnostics. Already fetched above,
  // so this is a map build rather than a second query.
  const nameByLedgerId = new Map(ledgers.map((l) => [String(l._id), l.name]));

  const [bills, sidecar] = await Promise.all([
    openItems.billsByLedger(cid, ledgerIds),
    backfill.fetchExistingBillTerms(cid, ledgerIds),
  ]);

  const items = [];
  let total = 0;
  let undated = 0;
  let undatedAmount = 0;

  for (const bill of bills.values()) {
    if (!openItems.isOpen(bill)) continue;
    total += 1;

    const sidecarRow = sidecar.get(`${bill.ledgerId}||${bill.billName}`) || null;
    const dueDate = bill.dueDate || bill.voucherDueDate || (sidecarRow && sidecarRow.dueDate) || null;

    if (!dueDate) {
      undated += 1;
      undatedAmount += Math.abs(bill.remaining);
      continue;
    }

    const { source, backfillRunId } = classifySource(bill, sidecarRow);

    // A bill is an aggregate across however many vouchers carry its name, so
    // there can be several. Joined rather than arbitrarily picking one — the
    // drilldown's job is to let someone find the document.
    const voucherNumber =
      bill.voucherNumbers && bill.voucherNumbers.size > 0
        ? [...bill.voucherNumbers].sort().join(", ")
        : null;

    items.push({
      id: `${bill.ledgerId}||${bill.billName}`,
      dueDate,
      amount: Math.abs(bill.remaining),
      direction: bill.remaining >= 0 ? "inflow" : "outflow",
      ledgerId: bill.ledgerId,
      billName: bill.billName,
      partyOrLedgerName: nameByLedgerId.get(String(bill.ledgerId)) || null,
      voucherNumber,
      source,
      backfillRunId,
      // ── Chunk 1-C ──────────────────────────────────────────────────────
      // Passed through untouched; the engine decides whether an expectation
      // is usable (overdue bill, date not itself in the past, inside the
      // horizon). Reading it here would put that rule in two places.
      forecastExpectedDate: (sidecarRow && sidecarRow.forecastExpectedDate) || null,
      forecastExpectedDateNotes: (sidecarRow && sidecarRow.forecastExpectedDateNotes) || "",
      forecastExpectedDateUpdatedByName:
        (sidecarRow && sidecarRow.forecastExpectedDateUpdatedByName) || null,
    });
  }

  return { items, total, undated, undatedAmount };
}

/** Active recurring items only. Paused and ended schedules move no cash. */
async function resolveActiveRecurring(companyId) {
  const cid = castId(companyId);
  if (!cid) return [];
  return Acc_RecurringItem.find({ companyId: cid, status: "active" })
    .select("name direction amount frequency dayOfMonth dayOfWeek nextDueDate startDate endDate type")
    .lean();
}

/**
 * Build the Base forecast for one company. Read-only, end to end.
 *
 * @param {object} opts
 * @param {*} opts.companyId — required; missing/malformed yields an empty,
 *   zero-cash forecast rather than an unscoped one
 * @param {number} [opts.horizon] — one of ALLOWED_HORIZONS; defaults to 30
 * @param {string|Date} [opts.asOfDate] — day 1; defaults to today (UTC)
 */
async function buildForecast({ companyId, horizon, asOfDate, groupBy } = {}) {
  const cid = castId(companyId);
  const horizonDays = parseHorizon(horizon);
  const asOf = parseAsOfDate(asOfDate);
  const grouping = parseGroupBy(groupBy);

  if (horizonDays === null) {
    return {
      ok: false,
      code: "INVALID_HORIZON",
      message: `horizon must be one of: ${ALLOWED_HORIZONS.join(", ")}.`,
    };
  }
  if (asOf === null) {
    return { ok: false, code: "INVALID_AS_OF_DATE", message: "asOfDate is not a valid date." };
  }
  if (grouping === null) {
    return {
      ok: false,
      code: "INVALID_GROUPING",
      message: `groupBy must be one of: ${engine.GROUPING_MODES.join(", ")}.`,
    };
  }
  if (!cid) {
    return { ok: false, code: "INVALID_COMPANY", message: "companyId required." };
  }

  const company = await Acc_Company.findById(cid).select("companyName").lean();
  if (!company) {
    return { ok: false, code: "COMPANY_NOT_FOUND", message: "Company not found." };
  }

  const [cashLedgers, cashConfig] = await Promise.all([
    resolveCashLedgers(cid),
    fetchCashLedgerConfig(cid),
  ]);
  const [cash, open, recurringItems] = await Promise.all([
    resolveOpeningCash(cid, asOf, cashLedgers, cashConfig),
    resolveDatedOpenItems(cid),
    resolveActiveRecurring(cid),
  ]);
  const { openingCash, cashLedgerCount } = cash;

  const forecast = engine.buildForecast({
    companyId: String(cid),
    asOfDate: asOf,
    horizonDays,
    openingCash,
    openItems: open.items,
    recurringItems,
    groupBy: grouping,
    counts: {
      openItemsTotal: open.total,
      openItemsUndated: open.undated,
      openItemsUndatedAmount: open.undatedAmount,
      recurringItemsActive: recurringItems.length,
    },
  });

  return {
    ok: true,
    ...forecast,
    companyName: company.companyName || null,
    cashLedgerCount,
    // ── Chunk 1-D ──────────────────────────────────────────────────────────
    // Says whether the opening figure rests on a decision finance actually
    // made, or on the default that sweeps in every cash-shaped ledger. The
    // screen uses this to prompt a review; it never blocks the forecast.
    openingCashConfig: {
      status: cash.configStatus,
      includedLedgerCount: cash.includedLedgerCount,
      excludedLedgerCount: cash.excludedLedgerCount,
      odLedgerCount: cash.odLedgerCount,
    },
    // Reported beside cash, never inside it.
    odBalance: cash.odBalance,
  };
}

module.exports = {
  ALLOWED_HORIZONS,
  DEFAULT_HORIZON,
  CASH_GROUP_NAMES,
  castId,
  parseHorizon,
  parseGroupBy,
  parseAsOfDate,
  resolveCashLedgers,
  balancesByCashLedger,
  fetchCashLedgerConfig,
  resolveOpeningCash,
  classifySource,
  resolveDatedOpenItems,
  resolveActiveRecurring,
  buildForecast,
};
