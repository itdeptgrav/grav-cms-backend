/**
 * GRAV-CMS-BACKEND/services/voucherDueDateDefault.service.js
 *
 * Applies `creditTerms.resolveDueDate` to a voucher-creation body BEFORE it
 * is persisted. This is the async, Mongo-touching half of that pure
 * calculation — this file decides WHICH party ledger to read and HOW to get
 * it (a fresh lookup, or one already sitting in memory); the arithmetic and
 * the "0 means unset" rule live entirely in creditTerms.service.js and are
 * not duplicated here.
 *
 * ── SCOPE (C0-C) ─────────────────────────────────────────────────────────
 * Defaults `dueDate` ONLY for the two voucher types that create a fresh
 * payable/receivable bill: "sales" and "purchase". This matches the
 * codebase's own existing design — only those two forms
 * (app/accountant/sales-vouchers/new, purchase-vouchers/new) carry a dueDate
 * field at all; receipts, payments, contra and journals settle or move money
 * without creating a new dated obligation, and credit/debit notes adjust an
 * EXISTING bill rather than opening a new one with its own due date (neither
 * of their forms has ever had a dueDate field either). Nothing here invents
 * a due-date concept for a voucher type this codebase has never given one.
 *
 * ── NEVER OVERWRITES A MANUAL VALUE ─────────────────────────────────────────
 * Both entry points check `body.dueDate` FIRST and return immediately if
 * anything is already there — a client-supplied date, an imported one, a
 * value some other step already set. Defaulting only ever fills a gap; it
 * never has an opinion about a date someone already provided.
 */

const mongoose = require("mongoose");
const { Acc_Ledger } = require("../models/Accountant_model/Acc_MasterModels");
const { resolveDueDate } = require("./creditTerms.service");

const DUE_DATE_ELIGIBLE_VOUCHER_TYPES = new Set(["sales", "purchase"]);

function isEligibleVoucherType(voucherType) {
  return DUE_DATE_ELIGIBLE_VOUCHER_TYPES.has(voucherType);
}

/** Cast to ObjectId, or null when the value isn't one. Never throws — the
 *  same tolerant-cast rule used by budgetActuals.service.js#oid, so a
 *  malformed/missing companyId reads as "can't scope this", not a crash. */
function oid(v) {
  if (!v) return null;
  if (v instanceof mongoose.Types.ObjectId) return v;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

/**
 * Default `dueDate` on ONE voucher-creation body, in place, by looking up
 * its party ledger. Mutates and returns `body` for a convenient one-liner at
 * each call site.
 *
 * ── COMPANY-SCOPED, NOT A BARE `_id` LOOKUP ─────────────────────────────────
 * `Acc_Ledger.findById(partyLedgerId)` alone would resolve a ledger id from
 * ANY company — exactly the cross-tenant leak C0-B1's credit-terms PATCH
 * route was corrected to avoid (every read route in Acc_parties.js filters
 * by `{ _id, companyId }` together, never `_id` alone). The same rule
 * applies here: a `partyLedgerId` that happens to belong to a different
 * company must never have its `creditPeriodDays` leak into this voucher's
 * due date. So the query is `{ _id: body.partyLedgerId, companyId:
 * body.companyId }`, and `body.companyId` is REQUIRED — missing or
 * unparseable, no default is computed, full stop.
 *
 * Never throws on a missing/invalid party — a party that can't be found
 * (wrong company, bad id, or genuinely absent) simply means no default can
 * be computed, exactly like an unset term does. This must never become a
 * reason to reject an otherwise-valid voucher.
 *
 * @param {object} body — the object about to become `new Acc_Voucher(body)`
 *   or `Acc_Voucher.create(body)`. Reads `voucherType`, `voucherDate`,
 *   `partyLedgerId`, `companyId`, `dueDate`.
 * @param {object} [opts]
 * @param {import("mongoose").ClientSession} [opts.session] — pass through
 *   when called inside a transaction (the approvals materialization path),
 *   so the read joins the same transaction as the rest of the work there.
 */
async function defaultDueDateOnVoucherBody(body, opts = {}) {
  if (!body || typeof body !== "object") return body;
  if (body.dueDate) return body; // manual/existing value always wins
  if (!isEligibleVoucherType(body.voucherType)) return body;
  if (!body.partyLedgerId) return body;

  const companyId = oid(body.companyId);
  if (!companyId) return body; // no verifiable company scope — never guess

  const partyId = oid(body.partyLedgerId);
  if (!partyId) return body;

  const query = Acc_Ledger.findOne({ _id: partyId, companyId }).select("creditPeriodDays");
  if (opts.session) query.session(opts.session);
  const party = await query.lean();
  if (!party) return body; // wrong company, or no such ledger — invents nothing

  const due = resolveDueDate({ voucherDate: body.voucherDate, partyLedger: party });
  if (due) body.dueDate = due;
  return body;
}

/**
 * Synchronous variant for callers that already hold the party ledger object
 * in memory — the two `insertMany` bulk-import paths, which resolve every
 * ledger once into a lookup map before building hundreds of voucher bodies.
 * Using the async variant there would mean one extra database round trip per
 * voucher inside that loop; this reuses what the caller already fetched.
 *
 * `partyLedger` must carry `creditPeriodDays`, and should carry `companyId`
 * for the defensive check below to have anything to compare — widen the
 * caller's own `.select()`/projection if it omits either.
 *
 * ── DEFENSIVE COMPANY CHECK ──────────────────────────────────────────────
 * The two callers of this function build `partyLedger` from a `ledgerByName`
 * map that is itself already scoped to one `companyId` for the whole import
 * run, so a genuine cross-company mix-up should not be reachable here today.
 * This check exists anyway, as a second line of defence rather than trusted
 * caller discipline: IF both `partyLedger.companyId` and `body.companyId`
 * are present and they disagree, nothing is defaulted. Whichever side is
 * absent, this check does not block — the async variant above is what
 * REQUIRES a company id; this one only refuses a proven mismatch.
 */
function defaultDueDateSync(body, partyLedger) {
  if (!body || typeof body !== "object") return body;
  if (body.dueDate) return body;
  if (!isEligibleVoucherType(body.voucherType)) return body;

  if (partyLedger && body.companyId && partyLedger.companyId) {
    if (String(partyLedger.companyId) !== String(body.companyId)) return body;
  }

  const due = resolveDueDate({ voucherDate: body.voucherDate, partyLedger });
  if (due) body.dueDate = due;
  return body;
}

module.exports = {
  DUE_DATE_ELIGIBLE_VOUCHER_TYPES,
  isEligibleVoucherType,
  defaultDueDateOnVoucherBody,
  defaultDueDateSync,
};
