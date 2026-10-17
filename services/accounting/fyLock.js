"use strict";

/**
 * Financial-year freeze — the rule and the guard (13 Oct 2026, owner).
 *
 * "If a year is locked they must not be able to modify it, even by mistake,
 * until it is unfrozen with a proper reason. Masters like a new ledger are
 * fine; vouchers are not."
 *
 * The guard is a mongoose plugin on the models that carry figures
 * (Acc_Voucher, Acc_JournalEntry). It runs on EVERY write path —
 * document save, update queries, deletes, insertMany, bulkWrite — so the
 * forty-odd accounting routes need no change and a new one cannot forget.
 * A write is refused when any date it touches (the record's date before the
 * change AND after it) falls in a frozen year. The error carries
 * `status: 423` and `code: "FY_LOCKED"` and says which year, who froze it,
 * when and why.
 *
 * Years are Indian financial years: 1 April to 31 March, IST. The start
 * month is read from the company's `financialYearStart` when it records one.
 */

const mongoose = require("mongoose");

const IST_MS = 330 * 60 * 1000;
const CACHE_MS = 15 * 1000;
const cache = new Map(); // companyId → { at, locks }

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

async function lockedYears(companyId) {
  const key = String(companyId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.locks;
  /* Kept on the company record (financialYearLocks). */
  const Company = mongoose.models.Acc_Company;
  const co = Company ? await Company.findById(companyId).select("financialYearLocks").lean() : null;
  const locks = ((co && co.financialYearLocks) || []).filter((l) => l.locked);
  cache.set(key, { at: Date.now(), locks });
  return locks;
}

function forget(companyId) {
  if (companyId) cache.delete(String(companyId));
  else cache.clear();
}

class FyLockedError extends Error {
  constructor(lock, what) {
    const when = lock.lockedAt ? new Date(lock.lockedAt).toLocaleDateString("en-IN") : "";
    super(
      `${fyLabel(lock.fyStartYear)} is frozen${lock.lockedByName ? ` by ${lock.lockedByName}` : ""}` +
        `${when ? ` on ${when}` : ""}${lock.lockReason ? ` (“${lock.lockReason}”)` : ""}. ` +
        `Nothing in a frozen year can be created, changed or deleted (${String(what || "this change")
          .replace(/^(A|An) /, "")
          .replace(/ (dated )?in it$/, "")
          .toLowerCase()}). An owner must unfreeze it first, with a reason.`,
    );
    this.name = "FyLockedError";
    this.status = 423;
    this.statusCode = 423;
    this.code = "FY_LOCKED";
    this.fy = fyLabel(lock.fyStartYear);
  }
}

/** Throws FyLockedError when any of `dates` is in a frozen year of `companyId`. */
async function assertYearsOpen(companyId, dates, what) {
  if (!companyId) return;
  const ds = (dates || []).filter(Boolean).map((d) => new Date(d)).filter((d) => !isNaN(d));
  if (!ds.length) return;
  const locks = await lockedYears(companyId);
  if (!locks.length) return;
  for (const d of ds) {
    const hit = locks.find((l) => d >= new Date(l.from) && d <= new Date(l.to));
    if (hit) throw new FyLockedError(hit, what);
  }
}

/**
 * The plugin. `dateField` is the record's accounting date; `label` names the
 * record in the refusal ("A voucher", "A journal entry").
 */
function fyLockPlugin(schema, { dateField, label }) {
  const what = (verb) => `${label} cannot be ${verb}:`;
  const dateOf = (doc) => doc && doc[dateField];

  // ── document.save() ───────────────────────────────────────────────────────
  schema.pre("save", async function () {
    const dates = [dateOf(this)];
    if (!this.isNew) {
      /* The date it had before this edit counts too: an edit to a frozen
         year's voucher is refused even if it moves the voucher out. */
      const before = await this.constructor
        .findById(this._id)
        .select(`${dateField} companyId`)
        .lean();
      if (before) dates.push(before[dateField]);
    }
    await assertYearsOpen(this.companyId, dates, this.isNew ? `${label} dated in it` : `${label} in it`);
  });

  // ── document.deleteOne() ─────────────────────────────────────────────────
  schema.pre("deleteOne", { document: true, query: false }, async function () {
    await assertYearsOpen(this.companyId, [dateOf(this)], `${label} in it`);
  });

  // ── query updates and deletes ─────────────────────────────────────────────
  async function guardQuery(isDelete) {
    const filter = this.getFilter();
    const affected = await this.model
      .find(filter)
      .select(`${dateField} companyId`)
      .limit(5000)
      .lean();
    const update = isDelete ? null : this.getUpdate() || {};
    const newDate = update
      ? (update.$set && update.$set[dateField]) || update[dateField] || null
      : null;
    const byCompany = new Map();
    for (const d of affected) {
      const k = String(d.companyId);
      if (!byCompany.has(k)) byCompany.set(k, []);
      byCompany.get(k).push(d[dateField]);
      if (newDate) byCompany.get(k).push(newDate);
    }
    /* An upsert that creates: the filter's company and the new date. */
    if (!affected.length && update && this.getOptions().upsert) {
      const cid = filter.companyId || (update.$setOnInsert && update.$setOnInsert.companyId);
      const date = newDate || (update.$setOnInsert && update.$setOnInsert[dateField]);
      if (cid && date) byCompany.set(String(cid), [date]);
    }
    for (const [cid, dates] of byCompany) await assertYearsOpen(cid, dates, isDelete ? `${label} in it` : `${label} in it`);
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

  // ── insertMany ────────────────────────────────────────────────────────────
  /* insertMany and bulkWrite hand their arguments AFTER next, so these two
     call next themselves rather than being async. */
  schema.pre("insertMany", function (next, docs) {
    const list = Array.isArray(docs) ? docs : [docs];
    (async () => {
      for (const d of list) await assertYearsOpen(d && d.companyId, [dateOf(d)], `${label} dated in it`);
    })().then(() => next(), next);
  });

  // ── bulkWrite (raw driver ops — read what each one would touch) ───────────
  if (typeof schema.pre === "function") {
    schema.pre("bulkWrite", function (next, ops) {
      const Model = this;
      (async () => {
      for (const op of ops || []) {
        if (op.insertOne) {
          const d = op.insertOne.document;
          await assertYearsOpen(d && d.companyId, [dateOf(d)], `${label} dated in it`);
          continue;
        }
        const spec = op.updateOne || op.updateMany || op.replaceOne || op.deleteOne || op.deleteMany;
        if (!spec) continue;
        const affected = await Model.find(spec.filter || {}).select(`${dateField} companyId`).limit(5000).lean();
        const upd = spec.update || spec.replacement || {};
        const nd = (upd.$set && upd.$set[dateField]) || upd[dateField] || null;
        for (const d of affected) await assertYearsOpen(d.companyId, [d[dateField], nd], `${label} in it`);
      }
      })().then(() => next(), next);
    });
  }
}

/**
 * Ledger opening balances are figures of the year the books begin in. While
 * that year is frozen, an opening balance may not change — on save or on an
 * update query. Every other ledger field stays open.
 */
function openingBalanceGuard(schema) {
  const FIELDS = ["openingBalance", "openingBalanceType"];
  async function check(companyId) {
    if (!companyId) return;
    const Company = mongoose.models.Acc_Company;
    const co = Company ? await Company.findById(companyId).select("booksFromDate").lean() : null;
    if (!co || !co.booksFromDate) return;
    await assertYearsOpen(companyId, [co.booksFromDate], "An opening balance");
  }
  schema.pre("save", async function () {
    if (this.isNew) return; // a NEW ledger is a master, always allowed
    if (FIELDS.some((f) => this.isModified(f))) await check(this.companyId);
  });
  for (const op of ["updateOne", "updateMany", "findOneAndUpdate"]) {
    schema.pre(op, { document: false, query: true }, async function () {
      const u = this.getUpdate() || {};
      const touches = FIELDS.some((f) => (u.$set && f in u.$set) || f in u || (u.$inc && f in u.$inc));
      if (!touches) return;
      const docs = await this.model.find(this.getFilter()).select("companyId").limit(500).lean();
      for (const cid of new Set(docs.map((d) => String(d.companyId)))) await check(cid);
    });
  }
}

module.exports = {
  fyLockPlugin,
  openingBalanceGuard,
  assertYearsOpen,
  lockedYears,
  forget,
  fyStartYearOf,
  fyBounds,
  fyLabel,
  FyLockedError,
};
