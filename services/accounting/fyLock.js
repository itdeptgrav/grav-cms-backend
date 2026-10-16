"use strict";

/**
 * Locked periods — the rule and the guard (13–16 Oct 2026, owner).
 *
 * "If a year is locked they must not be able to modify it, even by mistake,
 * until it is unfrozen with a proper reason." Then: lock a month, a week, a
 * day, a range, everything up to a date; then (16 Oct 2026): lock bank
 * reconciliation and everything else that is dated, and lock or unlock
 * SPECIFIC SECTIONS of a period — and only the owner may change a lock.
 *
 * A LOCK is a run of time (a financial year, a month, or whole Indian days)
 * kept on the company record (`financialYearLocks`, `monthLocks`,
 * `periodLocks`), with the SECTIONS it closes: `sections` (empty = every
 * section) minus `openSections` (sections opened again inside it). A lock
 * whose sections are all open is not in force.
 *
 * The guard is on the MODELS, not the routes, so every write path — document
 * save, update queries, deletes, insertMany, bulkWrite — is checked and a new
 * route cannot forget:
 *   • Acc_Voucher           — by its own date and section (voucherSection)
 *   • Acc_JournalEntry      — "journal_entries"
 *   • Acc_Ledger openings   — "opening_balances", at the books' first day
 *   • bank reconciliation   — "bank_reconciliation", by the statement lines
 *                             (and vouchers) a change touches
 *   • Acc_BankTransaction   — "bank_transactions"
 *   • Acc_ProformaInvoice   — "proforma"
 *   • Acc_CashFlowAdjustment— "cash_flow", by its period
 *   • Acc_GSTR2B            — "gst", by its return month
 *   • Acc_TaxFiling         — "tax_filings", by the period it is for
 * A refusal carries `status: 423`, `code: "FY_LOCKED"` and says which period,
 * which section, who locked it, when and why.
 *
 * Bank statement lines and tax filings belong to no company in this system,
 * so they answer to the locks of EVERY company (one company in practice).
 * Cash-flow adjustments belong to an organisation and answer to its
 * companies' locks.
 *
 * Years are Indian financial years: 1 April to 31 March, IST. The start month
 * is read from the company's `financialYearStart` when it records one.
 */

const mongoose = require("mongoose");
const { AsyncLocalStorage } = require("async_hooks");

/* The request a refusal happens in (Middlewear/lockedPeriodStatus.js runs
   each accounting request inside one). A route whose own catch answers
   "Error reconciling transaction" still goes out as the lock's 423 and its
   sentence, because the refusal leaves itself here. */
const lockContext = new AsyncLocalStorage();

const IST_MS = 330 * 60 * 1000;
const CACHE_MS = 15 * 1000;
const cache = new Map(); // companyId | "*" | "org:<id>" → { at, locks }

/* ── Sections ─────────────────────────────────────────────────────────── */
/* The parts of the books a lock can close. The frontend mirrors this list
   (components/accountant/periodLocks.mjs SECTIONS); keep the two in step. */
const SECTIONS = [
  { key: "sales", label: "Sales invoices", group: "Vouchers" },
  { key: "purchase", label: "Purchase vouchers", group: "Vouchers" },
  { key: "receipt", label: "Receipts", group: "Vouchers" },
  { key: "payment", label: "Payments", group: "Vouchers" },
  { key: "contra", label: "Contra", group: "Vouchers" },
  { key: "journal", label: "Journal vouchers", group: "Vouchers" },
  { key: "credit_note", label: "Credit notes", group: "Vouchers" },
  { key: "debit_note", label: "Debit notes", group: "Vouchers" },
  { key: "expenses", label: "Expenses", group: "Vouchers" },
  { key: "payroll", label: "Payroll postings", group: "Vouchers" },
  { key: "inventory", label: "Stock & other vouchers", group: "Vouchers" },
  { key: "journal_entries", label: "Journal entries", group: "Books" },
  { key: "opening_balances", label: "Opening balances", group: "Books" },
  { key: "bank_reconciliation", label: "Bank reconciliation", group: "Bank" },
  { key: "bank_transactions", label: "Bank statement lines", group: "Bank" },
  { key: "proforma", label: "Proforma invoices", group: "Other records" },
  { key: "cash_flow", label: "Cash-flow adjustments", group: "Other records" },
  { key: "gst", label: "GSTR-2B / 2A", group: "Other records" },
  { key: "tax_filings", label: "Tax filings", group: "Other records" },
];
const SECTION_KEYS = SECTIONS.map((s) => s.key);
const sectionLabel = (key) => (SECTIONS.find((s) => s.key === key) || {}).label || key;

/* A voucher's section: its source first (an expense, a payroll posting, a
   posted journal entry), then its type. */
const TYPE_SECTIONS = ["sales", "purchase", "receipt", "payment", "contra", "journal", "credit_note", "debit_note"];
const SOURCE_SECTIONS = { expense_module: "expenses", auto_from_payroll: "payroll", journal_entry: "journal_entries" };
function voucherSection(v) {
  if (!v) return "inventory";
  if (v.sourceSystem && SOURCE_SECTIONS[v.sourceSystem]) return SOURCE_SECTIONS[v.sourceSystem];
  return TYPE_SECTIONS.includes(v.voucherType) ? v.voucherType : "inventory";
}
/** A Mongo clause matching the vouchers of `keys`, or null when none of them is a voucher section. */
function voucherSectionClause(keys) {
  const set = new Set(keys);
  const or = [];
  const sources = Object.keys(SOURCE_SECTIONS);
  for (const [src, key] of Object.entries(SOURCE_SECTIONS)) if (set.has(key)) or.push({ sourceSystem: src });
  const types = TYPE_SECTIONS.filter((t) => set.has(t));
  if (types.length) or.push({ voucherType: { $in: types }, sourceSystem: { $nin: sources } });
  if (set.has("inventory")) or.push({ voucherType: { $nin: TYPE_SECTIONS }, sourceSystem: { $nin: sources } });
  return or.length ? { $or: or } : null;
}

/** The sections a lock entry closes: `sections` (empty = all) minus `openSections`. */
function effectiveSections(l) {
  const base = Array.isArray(l.sections) && l.sections.length ? l.sections.filter((k) => SECTION_KEYS.includes(k)) : SECTION_KEYS;
  const open = new Set(Array.isArray(l.openSections) ? l.openSections : []);
  return SECTION_KEYS.filter((k) => base.includes(k) && !open.has(k));
}

/* ── Financial years ──────────────────────────────────────────────────── */
/** The FY start year a date falls in, for a year starting in `startMonth` (1–12). */
function fyStartYearOf(date, startMonth = 4) {
  const d = new Date(new Date(date).getTime() + IST_MS); // IST wall clock
  const y = d.getUTCFullYear();
  return d.getUTCMonth() + 1 >= startMonth ? y : y - 1;
}

/** { from, to } of the FY starting in `startYear`, as instants (IST midnight). */
function fyBounds(startYear, startMonth = 4) {
  const from = new Date(Date.UTC(startYear, startMonth - 1, 1) - IST_MS);
  const to = new Date(Date.UTC(startYear + 1, startMonth - 1, 1) - IST_MS - 1);
  return { from, to };
}

const fyLabel = (startYear) => `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;

/* ── Months (15 Oct 2026, owner: "lock monthly wise") ─────────────────── */
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** { from, to } of a "YYYY-MM" month, as instants (IST midnight to the last millisecond). */
function monthBounds(month) {
  const m = MONTH_RE.exec(String(month || ""));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return { from: new Date(Date.UTC(y, mo - 1, 1) - IST_MS), to: new Date(Date.UTC(y, mo, 1) - IST_MS - 1) };
}
/** "2026-04" → "April 2026". */
function monthLabel(month) {
  const m = MONTH_RE.exec(String(month || ""));
  return m ? `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}` : String(month || "");
}
/** The "YYYY-MM" a date falls in, on the Indian calendar. */
function monthOf(date) {
  const d = new Date(new Date(date).getTime() + IST_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/* ── Days, weeks and ranges (15 Oct 2026, owner: "even day wise") ───── */
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** "YYYY-MM-DD" → the instant that Indian day starts, or null for a non-date. */
function dayStart(day) {
  const m = DAY_RE.exec(String(day || ""));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t);
  /* refuse 2026-02-30 and the like */
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() + 1 !== Number(m[2]) || d.getUTCDate() !== Number(m[3])) return null;
  return new Date(t - IST_MS);
}
/** { from, to } of the Indian days fromDay..toDay, both whole days included. */
function dayRangeBounds(fromDay, toDay) {
  const a = dayStart(fromDay);
  const b = dayStart(toDay);
  if (!a || !b || b < a) return null;
  return { from: a, to: new Date(b.getTime() + 86400000 - 1) };
}
/** The "YYYY-MM-DD" a date falls on, on the Indian calendar. */
function dayOf(date) {
  return new Date(new Date(date).getTime() + IST_MS).toISOString().slice(0, 10);
}
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayWords = (day, withYear = true) => {
  const m = DAY_RE.exec(String(day || ""));
  return m ? `${Number(m[3])} ${SHORT[Number(m[2]) - 1]}${withYear ? ` ${m[1]}` : ""}` : String(day || "");
};
/** "12 Oct 2026", "6 – 12 Oct 2026", "Week 28 Sep – 4 Oct 2026", "Everything up to 30 Sep 2026". */
function periodLabel({ kind, fromDay, toDay }) {
  if (kind === "upto") return `Everything up to ${dayWords(toDay)}`;
  if (fromDay === toDay) return dayWords(fromDay);
  const sameYear = fromDay.slice(0, 4) === toDay.slice(0, 4);
  const sameMonth = sameYear && fromDay.slice(5, 7) === toDay.slice(5, 7);
  const head = sameMonth ? String(Number(fromDay.slice(8, 10))) : dayWords(fromDay, !sameYear);
  return `${kind === "week" ? "Week " : ""}${head} – ${dayWords(toDay)}`;
}

/* ── Reading the locks ────────────────────────────────────────────────── */
/** A company record's lock entries in force, each with its kind, label and effective sections. */
function locksOf(co) {
  const shape = (l, kind, label, extra = {}) => {
    const effective = effectiveSections(l);
    return { ...l, ...extra, kind, label, effective, all: effective.length === SECTION_KEYS.length, companyId: co && co._id };
  };
  const years = ((co && co.financialYearLocks) || []).filter((l) => l.locked).map((l) => shape(l, "year", fyLabel(l.fyStartYear)));
  const months = ((co && co.monthLocks) || []).filter((l) => l.locked).map((l) => shape(l, "month", monthLabel(l.month)));
  const ranges = ((co && co.periodLocks) || []).filter((l) => l.locked).map((l) => shape(l, "period", periodLabel(l), { rangeKind: l.kind }));
  return [...years, ...months, ...ranges].filter((l) => l.effective.length > 0);
}
const LOCK_FIELDS = "financialYearLocks monthLocks periodLocks";

/** Every lock in force on a company. */
async function lockedPeriods(companyId) {
  if (!companyId) return [];
  const key = String(companyId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.locks;
  const Company = mongoose.models.Acc_Company;
  const co = Company && mongoose.Types.ObjectId.isValid(key) ? await Company.findById(key).select(LOCK_FIELDS).lean() : null;
  const locks = locksOf(co);
  cache.set(key, { at: Date.now(), locks });
  return locks;
}
/* The old name, kept for any caller that reads it. */
const lockedYears = lockedPeriods;

/** Every company's locks — for records that belong to no company (bank statement lines, tax filings). */
async function lockedPeriodsEverywhere() {
  const hit = cache.get("*");
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.locks;
  const Company = mongoose.models.Acc_Company;
  const cos = Company
    ? await Company.find({ $or: [{ "financialYearLocks.locked": true }, { "monthLocks.locked": true }, { "periodLocks.locked": true }] }).select(LOCK_FIELDS).lean()
    : [];
  const locks = cos.flatMap(locksOf);
  cache.set("*", { at: Date.now(), locks });
  return locks;
}

/** The locks of an organisation's companies — for organisation-wide records (cash-flow adjustments). */
async function lockedPeriodsForOrg(orgId) {
  if (!orgId) return lockedPeriodsEverywhere();
  const key = `org:${orgId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.locks;
  const Org = mongoose.models.Acc_Organization;
  const org = Org && mongoose.Types.ObjectId.isValid(String(orgId)) ? await Org.findById(orgId).select("tallyCompanyIds").lean() : null;
  const ids = (org && org.tallyCompanyIds) || [];
  const locks = (await Promise.all(ids.map((id) => lockedPeriods(id)))).flat();
  cache.set(key, { at: Date.now(), locks });
  return locks;
}

function forget(companyId) {
  /* a company's change also changes the everywhere / organisation views */
  if (companyId) {
    cache.delete(String(companyId));
    for (const k of [...cache.keys()]) if (k === "*" || k.startsWith("org:")) cache.delete(k);
  } else cache.clear();
}

const closesSection = (lock, section) => !section || lock.all || lock.effective.includes(section);
const coversDate = (lock, d) => d >= new Date(lock.from) && d <= new Date(lock.to);
const overlaps = (lock, from, to) => new Date(lock.from) <= to && new Date(lock.to) >= from;

/* ── The refusal ─────────────────────────────────────────────────────── */
class FyLockedError extends Error {
  constructor(lock, what, section) {
    const when = lock.lockedAt ? new Date(lock.lockedAt).toLocaleDateString("en-IN") : "";
    const year = lock.kind !== "month" && lock.kind !== "period";
    const label = lock.label || fyLabel(lock.fyStartYear);
    const noun = lock.kind === "month" ? "locked month" : lock.kind === "period" ? "locked period" : "frozen year";
    const verb = lock.label && /^Everything/.test(lock.label) ? "are" : "is";
    /* a lock that closes only some sections says which one stopped this */
    const forSection = lock.all === false && section ? ` for ${sectionLabel(section)}` : "";
    super(
      `${label} ${verb} ${year ? "frozen" : "locked"}${forSection}${lock.lockedByName ? ` by ${lock.lockedByName}` : ""}` +
        `${when ? ` on ${when}` : ""}${lock.lockReason ? ` (“${lock.lockReason}”)` : ""}. ` +
        `Nothing in a ${noun} can be created, changed or deleted (${String(what || "this change")
          .replace(/^(A|An) /, "")
          .replace(/ (dated )?in it$/, "")
          .toLowerCase()}). An owner must ${year ? "unfreeze" : "unlock"} it first, with a reason.`,
    );
    this.name = "FyLockedError";
    this.status = 423;
    this.statusCode = 423;
    /* One code for every kind of lock: every reader of FY_LOCKED treats them
       the same; `period` says which kind and `section` which part. */
    this.code = "FY_LOCKED";
    this.period = lock.kind === "period" ? lock.rangeKind || "range" : lock.kind === "month" ? "month" : "year";
    this.section = section || null;
    this.fy = label;
    const store = lockContext.getStore();
    if (store) store.error = this;
  }
}

/* ── Checks routes and guards call ───────────────────────────────────── */
/**
 * Throws when any of `dates` is in a lock of `companyId` that closes
 * `section` (no section = any lock at all).
 */
async function assertYearsOpen(companyId, dates, what, section) {
  if (!companyId) return;
  const ds = (dates || []).filter(Boolean).map((d) => new Date(d)).filter((d) => !isNaN(d));
  if (!ds.length) return;
  const locks = await lockedPeriods(companyId);
  if (!locks.length) return;
  for (const d of ds) {
    const hit = locks.find((l) => coversDate(l, d) && closesSection(l, section));
    if (hit) throw new FyLockedError(hit, what, section);
  }
}

/** The same, against a list of locks already read (the everywhere / organisation scopes). */
function assertDatesAgainst(locks, dates, what, section) {
  for (const d of (dates || []).filter(Boolean).map((x) => new Date(x)).filter((x) => !isNaN(x))) {
    const hit = locks.find((l) => coversDate(l, d) && closesSection(l, section));
    if (hit) throw new FyLockedError(hit, what, section);
  }
}
/** Throws when a lock closing `section` overlaps from..to. */
function assertRangeAgainst(locks, from, to, what, section) {
  const a = from ? new Date(from) : null;
  const b = to ? new Date(to) : null;
  if (!a && !b) return;
  const lo = a || b;
  const hi = b || a;
  const hit = locks.find((l) => overlaps(l, lo, hi) && closesSection(l, section));
  if (hit) throw new FyLockedError(hit, what, section);
}
async function assertRangeOpen(companyId, from, to, what, section) {
  assertRangeAgainst(await lockedPeriods(companyId), from, to, what, section);
}

/** A voucher (document or plain object) and the dates a change touches. */
async function assertVoucherOpen(voucher, dates, what = "A voucher in it") {
  if (!voucher) return;
  await assertYearsOpen(voucher.companyId, dates && dates.length ? dates : [voucher.voucherDate], what, voucherSection(voucher));
}

/** The first lock covering `date` (for `section`, or any), or null. */
async function lockAt(companyId, date, section) {
  if (!companyId || !date) return null;
  const d = new Date(date);
  if (isNaN(d)) return null;
  const locks = await lockedPeriods(companyId);
  return locks.find((l) => coversDate(l, d) && closesSection(l, section)) || null;
}

/**
 * Bank statement lines arriving in bulk (an import, a bank feed): the lines
 * dated in a period locked for bank statement lines are left out, the rest
 * go in. A statement often runs across a month end; refusing all of it
 * would block the open days too. → { open, locked }
 */
async function splitBankLines(lines) {
  const locks = (await lockedPeriodsEverywhere()).filter((l) => closesSection(l, "bank_transactions"));
  if (!locks.length) return { open: lines, locked: [] };
  const open = [];
  const locked = [];
  for (const t of lines) {
    const d = new Date(t && t.transactionDate);
    (!isNaN(d) && locks.some((l) => coversDate(l, d)) ? locked : open).push(t);
  }
  return { open, locked };
}
const lockedLinesNote = (n) => (n ? ` ${n} line${n === 1 ? " is" : "s are"} in a locked period and ${n === 1 ? "was" : "were"} left out.` : "");

/* ── What a write touches ────────────────────────────────────────────── */
/* Fields a locked record may still have written, because they are not
   figures and change no report of the period: a payment reminder logged on
   an old unpaid invoice, its e-way bill details, the boot-time `isLive`
   index field, the timestamp, a line's denormalised NAME. Everything else —
   amounts, ledgers, date, status, allocations, narration — stays refused. */
const HARMLESS = ["reminderLog", "eWayBillDetails", "isLive", "updatedAt"];
const NAME_ON_LINE = /^(ledgerEntries|inventoryEntries)\.[^.]+\.(ledgerName|stockItemName)$/;
const harmlessFor = (extra = []) => (path) =>
  NAME_ON_LINE.test(path) || [...HARMLESS, ...extra].some((h) => path === h || path.startsWith(`${h}.`));
/** The fields an update document writes, operators unwrapped. A pipeline update is never harmless. */
function updatedFields(update) {
  if (!update || Array.isArray(update)) return null;
  const out = [];
  for (const [k, v] of Object.entries(update)) {
    if (k.startsWith("$")) {
      if (v && typeof v === "object") out.push(...Object.keys(v));
      else return null;
    } else out.push(k);
  }
  return out;
}
const newDateIn = (update, dateField) =>
  update ? (update.$set && update.$set[dateField]) || update[dateField] || (update.$setOnInsert && update.$setOnInsert[dateField]) || null : null;

/**
 * Refuses when any record matching `filter` sits in a lock closing its
 * section — or when `newDate` lands in one. Asks the database for ONE
 * offending record per lock, exact however many records the filter matches.
 *
 * `spec`: { dateField, section (fixed) | sectionClause(keys) + sectionsOf(),
 *           scope: "company" (default) | "everywhere" }
 */
async function assertMatchingOpen(Model, filter, spec, newDate, what) {
  const { dateField } = spec;
  const scopes =
    spec.scope === "everywhere"
      ? [{ cid: null, locks: await lockedPeriodsEverywhere() }]
      : await Promise.all((await Model.distinct("companyId", filter || {})).filter(Boolean).map(async (cid) => ({ cid, locks: await lockedPeriods(cid) })));
  for (const { cid, locks } of scopes) {
    if (!locks.length) continue;
    for (const l of locks) {
      let sectionClause = {};
      if (spec.section) {
        if (!closesSection(l, spec.section)) continue;
      } else if (!l.all && spec.sectionClause) {
        sectionClause = spec.sectionClause(l.effective);
        if (!sectionClause) continue;
      }
      const hit = await Model.findOne({
        $and: [filter || {}, cid ? { companyId: cid } : {}, { [dateField]: { $gte: new Date(l.from), $lte: new Date(l.to) } }, sectionClause],
      })
        .select(`${dateField} companyId voucherType sourceSystem`)
        .lean();
      if (hit) throw new FyLockedError(l, what, spec.section || (spec.sectionOf ? spec.sectionOf(hit) : undefined));
    }
    if (newDate) {
      const d = new Date(newDate);
      if (spec.section || !spec.sectionsOf) assertDatesAgainst(locks, [d], what, spec.section);
      else {
        const sections = await spec.sectionsOf(Model, { $and: [filter || {}, cid ? { companyId: cid } : {}] });
        for (const s of sections) assertDatesAgainst(locks, [d], what, s);
      }
    }
  }
}

/** For a route about to change several vouchers in steps: refuse BEFORE the first step. */
async function assertVouchersOpen(filter, what = "A voucher in it") {
  const Voucher = mongoose.models.Acc_Voucher;
  if (Voucher) await assertMatchingOpen(Voucher, filter, VOUCHER_SPEC, null, what);
}

/** Before a merge or a re-pointing: refuse when a voucher naming one of `ledgerIds` is locked. */
async function assertLedgersOpen(ledgerIds, what = "A voucher of that ledger in it") {
  const ids = (ledgerIds || []).filter(Boolean);
  if (!ids.length) return;
  await assertVouchersOpen(
    { $or: [{ "ledgerEntries.ledgerId": { $in: ids } }, { partyLedgerId: { $in: ids } }, { bankLedgerId: { $in: ids } }] },
    what,
  );
}

/** Opening balances belong to the books' first day: refuse while it is locked for them. */
async function assertOpeningOpen(companyId) {
  const Company = mongoose.models.Acc_Company;
  const co = Company && companyId ? await Company.findById(companyId).select("booksFromDate").lean() : null;
  if (co && co.booksFromDate) await assertYearsOpen(companyId, [co.booksFromDate], "An opening balance", "opening_balances");
}

/* ── The point-dated plugin ──────────────────────────────────────────── */
async function voucherSectionsOf(Model, filter) {
  const rows = await Model.aggregate([{ $match: filter || {} }, { $group: { _id: { t: "$voucherType", s: "$sourceSystem" } } }]);
  return [...new Set(rows.map((r) => voucherSection({ voucherType: r._id.t, sourceSystem: r._id.s })))];
}
const VOUCHER_SPEC = { dateField: "voucherDate", sectionOf: voucherSection, sectionClause: voucherSectionClause, sectionsOf: voucherSectionsOf };

/**
 * The guard for a record with one accounting date. `section` is fixed, or
 * `sectionOf(doc)` + `sectionClause(keys)` + `sectionsOf(Model, filter)` for a
 * model holding several sections (vouchers). `scope: "everywhere"` for a
 * record that belongs to no company. `harmless` names extra fields that may
 * be written on a locked record.
 */
function fyLockPlugin(schema, opts) {
  const spec = opts.voucher ? { ...VOUCHER_SPEC, dateField: opts.dateField || "voucherDate" } : { ...opts };
  const { dateField, label } = { ...opts, dateField: spec.dateField };
  const harmless = harmlessFor(opts.harmless);
  const sectionOfDoc = (doc) => spec.section || (spec.sectionOf ? spec.sectionOf(doc) : undefined);
  const check = async (doc, dates, what) => {
    const section = sectionOfDoc(doc);
    if (spec.scope === "everywhere") assertDatesAgainst(await lockedPeriodsEverywhere(), dates, what, section);
    else await assertYearsOpen(doc && doc.companyId, dates, what, section);
  };

  // ── document.save() ───────────────────────────────────────────────────
  schema.pre("save", async function () {
    let before = null;
    if (!this.isNew) {
      /* Nothing but harmless fields changed (a reminder, e-way details). */
      const mods = this.modifiedPaths();
      if (mods.length && mods.every(harmless)) return;
      /* An internal step that only adds a bill reference to an old invoice
         (billMatching.ensureBillReference) marks the document so: receiving
         money against an invoice of a locked period must keep working. */
      if (this.$locals && this.$locals.periodLockExempt && !this.isModified(dateField)) return;
      before = await this.constructor.findById(this._id).select(`${dateField} companyId voucherType sourceSystem`).lean();
    }
    /* The date it had before this edit counts too — under the section it had
       then: an edit is refused even if it moves the record out. */
    await check(this, [this[dateField]], this.isNew ? `${label} dated in it` : `${label} in it`);
    if (before) await check(before, [before[dateField]], `${label} in it`);
  });

  // ── document.deleteOne() ──────────────────────────────────────────────
  schema.pre("deleteOne", { document: true, query: false }, async function () {
    await check(this, [this[dateField]], `${label} in it`);
  });

  // ── query updates and deletes ─────────────────────────────────────────
  async function guardQuery(isDelete) {
    const filter = this.getFilter();
    const update = isDelete ? null : this.getUpdate() || {};
    if (update) {
      const fields = updatedFields(update);
      if (fields && fields.length && fields.every(harmless)) return;
    }
    const newDate = newDateIn(update, dateField);
    await assertMatchingOpen(this.model, filter, spec, newDate, `${label} in it`);
    /* An upsert that creates: the filter's company and the new date. */
    if (update && this.getOptions().upsert && !(await this.model.exists(filter))) {
      const doc = { ...(filter || {}), ...(update.$setOnInsert || {}), ...(update.$set || {}) };
      if (newDate) await check(doc, [newDate], `${label} dated in it`);
    }
  }
  for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne"]) {
    schema.pre(op, { document: false, query: true }, async function () {
      await guardQuery.call(this, false);
    });
  }
  for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"]) {
    schema.pre(op, { document: false, query: true }, async function () {
      await guardQuery.call(this, true);
    });
  }

  // ── insertMany ────────────────────────────────────────────────────────
  /* insertMany and bulkWrite hand their arguments AFTER next, so these two
     call next themselves rather than being async. */
  schema.pre("insertMany", function (next, docs) {
    const list = Array.isArray(docs) ? docs : [docs];
    (async () => {
      for (const d of list) await check(d, [d && d[dateField]], `${label} dated in it`);
    })().then(() => next(), next);
  });

  // ── bulkWrite (raw driver ops — read what each one would touch) ───────
  schema.pre("bulkWrite", function (next, ops) {
    const Model = this;
    (async () => {
      for (const op of ops || []) {
        if (op.insertOne) {
          const d = op.insertOne.document;
          await check(d, [d && d[dateField]], `${label} dated in it`);
          continue;
        }
        const s = op.updateOne || op.updateMany || op.replaceOne || op.deleteOne || op.deleteMany;
        if (!s) continue;
        const fields = s.update ? updatedFields(s.update) : null;
        if (fields && fields.length && fields.every(harmless)) continue;
        await assertMatchingOpen(Model, s.filter || {}, spec, newDateIn(s.update || s.replacement, dateField), `${label} in it`);
      }
    })().then(() => next(), next);
  });
}

/* ── The range-dated plugin ──────────────────────────────────────────── */
/**
 * The guard for a record that stands for a PERIOD (a GST return month, a
 * cash-flow adjustment, a tax filing): refused when that period overlaps a
 * lock closing `section`. `rangeOf(doc)` → { from, to } or null (no period,
 * not locked). `locksFor(doc)` → the locks that apply to it.
 */
function rangeLockPlugin(schema, { label, section, rangeOf, locksFor, harmless: extra }) {
  const harmless = harmlessFor(extra);
  const check = async (doc, what) => {
    const r = doc && rangeOf(doc);
    if (!r) return;
    assertRangeAgainst(await locksFor(doc), r.from, r.to, what, section);
  };
  schema.pre("save", async function () {
    if (!this.isNew) {
      const mods = this.modifiedPaths();
      if (mods.length && mods.every(harmless)) return;
      const before = await this.constructor.findById(this._id).lean();
      if (before) await check(before, `${label} in it`);
    }
    await check(this, this.isNew ? `${label} dated in it` : `${label} in it`);
  });
  schema.pre("deleteOne", { document: true, query: false }, async function () {
    await check(this, `${label} in it`);
  });
  async function guardQuery(isDelete) {
    const update = isDelete ? null : this.getUpdate() || {};
    if (update) {
      const fields = updatedFields(update);
      if (fields && fields.length && fields.every(harmless)) return;
    }
    const docs = await this.model.find(this.getFilter()).lean();
    for (const d of docs) {
      await check(d, `${label} in it`);
      /* the period after the change counts too */
      if (update) await check({ ...d, ...(update.$set || {}), ...Object.fromEntries(Object.entries(update).filter(([k]) => !k.startsWith("$"))) }, `${label} in it`);
    }
    if (update && !docs.length && this.getOptions().upsert) await check({ ...(this.getFilter() || {}), ...(update.$setOnInsert || {}), ...(update.$set || {}) }, `${label} dated in it`);
  }
  for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne"]) {
    schema.pre(op, { document: false, query: true }, async function () {
      await guardQuery.call(this, false);
    });
  }
  for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"]) {
    schema.pre(op, { document: false, query: true }, async function () {
      await guardQuery.call(this, true);
    });
  }
  schema.pre("insertMany", function (next, docs) {
    (async () => {
      for (const d of Array.isArray(docs) ? docs : [docs]) await check(d, `${label} dated in it`);
    })().then(() => next(), next);
  });
}

/* ── Opening balances ────────────────────────────────────────────────── */
/**
 * Ledger opening balances are figures of the books' first day. While that
 * day is locked for opening balances, one may not change — on save, on an
 * update query, or by a NEW ledger that brings one. Every other ledger field
 * stays open.
 */
function openingBalanceGuard(schema) {
  const FIELDS = ["openingBalance", "openingBalanceType"];
  schema.pre("save", async function () {
    if (this.isNew) {
      if (Number(this.openingBalance) !== 0 && this.openingBalance != null) await assertOpeningOpen(this.companyId);
      return;
    }
    if (FIELDS.some((f) => this.isModified(f))) await assertOpeningOpen(this.companyId);
  });
  for (const op of ["updateOne", "updateMany", "findOneAndUpdate"]) {
    schema.pre(op, { document: false, query: true }, async function () {
      const u = this.getUpdate() || {};
      const touches = FIELDS.some((f) => (u.$set && f in u.$set) || f in u || (u.$inc && f in u.$inc));
      if (!touches) return;
      const cids = (await this.model.distinct("companyId", this.getFilter())).filter(Boolean);
      for (const cid of cids) await assertOpeningOpen(cid);
    });
  }
  schema.pre("insertMany", function (next, docs) {
    (async () => {
      for (const d of Array.isArray(docs) ? docs : [docs])
        if (d && Number(d.openingBalance || 0) !== 0) await assertOpeningOpen(d.companyId);
    })().then(() => next(), next);
  });
}

/* ── Bank reconciliation ─────────────────────────────────────────────── */
/**
 * A reconciliation session is one bank account's statement for one month.
 * A change is checked against what it TOUCHES, so locking 10 May does not
 * stop work on a line of 20 May:
 *   • a statement line added, removed, matched, unmatched, reconciled or
 *     noted → that line's date (before and after);
 *   • a voucher cleared without a bank line → that voucher's date;
 *   • the session itself (its status, balances, bank, period) → its period;
 *   • a new session → every line on it; deleting one → its period.
 */
const TXN_FIELDS = ["valueDate", "postDate", "description", "chequeNo", "debit", "credit", "balance", "matched", "matchedVoucherId", "allocations", "reconciled", "note"];
const SESSION_FIELDS = ["status", "openingBalance", "closingBalance", "bankLedgerId", "periodFrom", "periodTo", "periodMonth", "periodYear", "accountNumber"];
const txnDate = (t) => t && (t.valueDate || t.postDate);
const txnKey = (t) => JSON.stringify(TXN_FIELDS.map((f) => (t && t[f] !== undefined ? t[f] : null)));
function bankReconGuard(schema) {
  const SECTION = "bank_reconciliation";
  const what = "A bank reconciliation entry in it";
  schema.pre("save", async function () {
    const locks = await lockedPeriods(this.companyId);
    if (!locks.length) return;
    const now = this.toObject({ depopulate: true });
    if (this.isNew) {
      const dates = (now.transactions || []).map(txnDate).filter(Boolean);
      if (dates.length) assertDatesAgainst(locks, dates, what, SECTION);
      else assertRangeAgainst(locks, now.periodFrom, now.periodTo, what, SECTION);
      return;
    }
    const before = await this.constructor.findById(this._id).lean();
    if (!before) return;
    /* the statement lines that changed */
    const oldById = new Map((before.transactions || []).map((t) => [String(t._id), t]));
    const newById = new Map((now.transactions || []).map((t) => [String(t._id), t]));
    const dates = [];
    for (const [id, t] of newById) {
      const o = oldById.get(id);
      if (!o || txnKey(o) !== txnKey(t)) dates.push(txnDate(t), o && txnDate(o));
    }
    for (const [id, o] of oldById) if (!newById.has(id)) dates.push(txnDate(o));
    assertDatesAgainst(locks, dates, what, SECTION);
    /* vouchers cleared without a bank line */
    const clearKey = (c) => `${c.voucherId}|${c.amount}|${c.note || ""}`;
    const oldClears = new Set((before.manualClears || []).map(clearKey));
    const newClears = new Set((now.manualClears || []).map(clearKey));
    const changed = [...(now.manualClears || []).filter((c) => !oldClears.has(clearKey(c))), ...(before.manualClears || []).filter((c) => !newClears.has(clearKey(c)))];
    if (changed.length) {
      const Voucher = mongoose.models.Acc_Voucher;
      const vs = Voucher ? await Voucher.find({ _id: { $in: changed.map((c) => c.voucherId) } }).select("voucherDate").lean() : [];
      assertDatesAgainst(locks, vs.map((v) => v.voucherDate), what, SECTION);
    }
    /* the session itself */
    if (SESSION_FIELDS.some((f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(now[f] ?? null)))
      assertRangeAgainst(locks, now.periodFrom || before.periodFrom, now.periodTo || before.periodTo, what, SECTION);
  });
  const guardDelete = async function () {
    const docs = await this.model.find(this.getFilter()).select("companyId periodFrom periodTo transactions.valueDate transactions.postDate").lean();
    for (const d of docs) {
      const locks = await lockedPeriods(d.companyId);
      if (d.periodFrom || d.periodTo) assertRangeAgainst(locks, d.periodFrom, d.periodTo, what, SECTION);
      else assertDatesAgainst(locks, (d.transactions || []).map(txnDate), what, SECTION);
    }
  };
  for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"]) schema.pre(op, { document: false, query: true }, guardDelete);
  schema.pre("deleteOne", { document: true, query: false }, async function () {
    assertRangeAgainst(await lockedPeriods(this.companyId), this.periodFrom, this.periodTo, what, SECTION);
  });
  /* the routes write sessions by save / create / delete only; an update
     query on one is refused while any lock overlaps its period */
  for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne"]) {
    schema.pre(op, { document: false, query: true }, async function () {
      const docs = await this.model.find(this.getFilter()).select("companyId periodFrom periodTo").lean();
      for (const d of docs) assertRangeAgainst(await lockedPeriods(d.companyId), d.periodFrom, d.periodTo, what, SECTION);
    });
  }
}

/* ── Requests queued for an approver ─────────────────────────────────── */
/**
 * An editor's edit, cancel or void of a voucher is queued for an approver
 * rather than written. A request about a voucher in a locked period is
 * refused when it is RAISED — it could never be applied, and an approver
 * should not be handed one (16 Oct 2026).
 */
function approvalRequestGuard(schema) {
  schema.pre("save", async function () {
    if (!this.isNew || this.kind !== "voucher" || !this.target || !this.target.id) return;
    const Voucher = mongoose.models.Acc_Voucher;
    const v = Voucher ? await Voucher.findById(this.target.id).select("companyId voucherDate voucherType sourceSystem").lean() : null;
    if (!v) return;
    const moveTo = this.payload && this.payload.voucherDate;
    await assertVoucherOpen(v, [v.voucherDate, moveTo], "A voucher in it");
  });
}

/* ── Periods of the range-dated records ──────────────────────────────── */
/** GSTR-2B / 2A "MMYYYY" → that Indian month. */
function returnPeriodRange(doc) {
  const s = String((doc && doc.returnPeriod) || "").trim();
  if (!/^\d{6}$/.test(s)) return null;
  return monthBounds(`${s.slice(2)}-${s.slice(0, 2)}`);
}
/** A cash-flow adjustment's own period; open-ended at one side → that side; none → not tied to a period. */
function cashFlowRange(doc) {
  if (!doc || (!doc.periodStart && !doc.periodEnd)) return null;
  return { from: doc.periodStart || doc.periodEnd, to: doc.periodEnd || doc.periodStart };
}
/**
 * The period a tax filing is FOR, from its label: "October 2026",
 * "Q1 (Apr-Jun) 2026-27", "FY 2026-27", "Instalment 2 · FY 2026-27".
 * Unreadable → its due date.
 */
function taxFilingRange(doc) {
  if (!doc) return null;
  const p = String(doc.period || doc.filingPeriod || "").trim();
  const fyM = /(\d{4})-(\d{2})\s*$/.exec(p) || /(\d{4})-(\d{2})/.exec(String(doc.financialYear || ""));
  const mon = /^([A-Za-z]+)\s+(\d{4})$/.exec(p);
  if (mon) {
    const i = MONTH_NAMES.findIndex((n) => n.toLowerCase().startsWith(mon[1].toLowerCase().slice(0, 3)));
    if (i >= 0) return monthBounds(`${mon[2]}-${String(i + 1).padStart(2, "0")}`);
  }
  const q = /^Q([1-4])\b/i.exec(p);
  if (q && fyM) {
    const fy = Number(fyM[1]);
    const startMonth = 4 + (Number(q[1]) - 1) * 3; // Apr, Jul, Oct, Jan
    const y = startMonth > 12 ? fy + 1 : fy;
    const m = ((startMonth - 1) % 12) + 1;
    const from = monthBounds(`${y}-${String(m).padStart(2, "0")}`).from;
    const endM = m + 2;
    const to = monthBounds(`${y}-${String(endM).padStart(2, "0")}`).to;
    return { from, to };
  }
  if (/FY/i.test(p) && fyM) return fyBounds(Number(fyM[1]));
  return doc.dueDate ? { from: doc.dueDate, to: doc.dueDate } : null;
}

module.exports = {
  lockContext,
  SECTIONS,
  SECTION_KEYS,
  sectionLabel,
  voucherSection,
  voucherSectionClause,
  effectiveSections,
  fyLockPlugin,
  rangeLockPlugin,
  openingBalanceGuard,
  bankReconGuard,
  approvalRequestGuard,
  assertYearsOpen,
  assertRangeOpen,
  assertVoucherOpen,
  assertDatesAgainst,
  assertRangeAgainst,
  lockedYears,
  lockedPeriods,
  lockedPeriodsEverywhere,
  lockedPeriodsForOrg,
  forget,
  monthBounds,
  monthLabel,
  monthOf,
  dayStart,
  dayRangeBounds,
  dayOf,
  periodLabel,
  lockAt,
  assertVouchersOpen,
  splitBankLines,
  lockedLinesNote,
  assertLedgersOpen,
  assertOpeningOpen,
  returnPeriodRange,
  cashFlowRange,
  taxFilingRange,
  fyStartYearOf,
  fyBounds,
  fyLabel,
  FyLockedError,
};
