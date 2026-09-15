"use strict";

/**
 * Turning a journal entry into an entry in the books.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * The journal-entries module was a filing cabinet. Creating an entry wrote a
 * row to `acc_journal_entries`; "posting" one set `status = "posted"` and
 * saved. Nothing else happened — no voucher, no ledger entries, no effect on
 * any report. Every figure in the accounting module (trial balance, ledger,
 * day book, P&L, balance sheet) is aggregated from `Acc_Voucher.ledgerEntries`
 * where `status: "posted"`, and a journal entry never became one. So an entry
 * could sit there reading "posted", with balanced debits and credits against
 * named ledgers, and move nothing.
 *
 * Two smaller faults underneath it, both of the same kind — the page was
 * sending the right data into fields that did not exist:
 *
 *   · the ledger each line hits was sent as `accountCode` (the page says so:
 *     "ledgerId stored as accountCode so downstream pages can resolve"), but
 *     the line schema had no ledger reference, so lines pointed at names; and
 *   · `companyId` was sent on every create and silently dropped, so entries
 *     belonged to no company and the list showed all of them to everyone.
 *
 * ── WHAT POSTING DOES NOW ───────────────────────────────────────────────────
 * Builds a real `journal` voucher, the same shape the voucher module writes,
 * and links it back to the entry. Reports pick it up because it is an ordinary
 * voucher — nothing had to be taught about journal entries.
 *
 * Approval is not bypassed. `journal` is one of the voucher types an editor
 * may not post directly, and that rule is applied here exactly as the voucher
 * route applies it: an editor's entry becomes a voucher awaiting approval and
 * the entry says so, rather than claiming to be posted.
 */

const mongoose = require("mongoose");
const { Acc_Voucher } = require("../models/Accountant_model/Acc_VoucherModels");
const { Acc_Ledger } = require("../models/Accountant_model/Acc_MasterModels");

const asObjectId = (v) => {
  const s = String(v || "");
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
};

/** The ledger id a line points at, wherever the page happened to put it. */
function lineLedgerId(line) {
  return asObjectId(line?.ledgerId) || asObjectId(line?.accountCode);
}

/**
 * Whoever is posting may or may not be allowed to post straight to the books.
 * Mirrors the check in routes/Accountant_Routes/Acc_vouchers.js — the two must
 * agree, or the journal page becomes a way around the approval rule.
 */
function canPostDirectly(user) {
  const role = user?.role;
  return Boolean(
    user?.permissions?.canPostDirectly ||
      role === "owner" ||
      role === "approver" ||
      role === "admin" ||
      role === "accountant",
  );
}

/**
 * Resolve every line to a real ledger in this company.
 *
 * Refused rather than guessed. A journal entry whose lines cannot be resolved
 * is the bug this whole file exists to fix; posting it to "something close" is
 * how a balance ends up in the wrong account, which is worse than an error
 * message. By id first, then by exact name within the company, because entries
 * written before the line schema had a ledger reference have only a name.
 */
async function resolveLines(entry) {
  const companyId = asObjectId(entry.companyId);
  if (!companyId) {
    return { ok: false, code: "NO_COMPANY", message: "This entry is not attached to a company, so there is nowhere to post it." };
  }

  const lines = entry.lines || [];
  if (lines.length < 2) {
    return { ok: false, code: "TOO_FEW_LINES", message: "A journal entry needs at least two lines." };
  }

  const ids = lines.map(lineLedgerId).filter(Boolean);
  const names = lines
    .filter((l) => !lineLedgerId(l))
    .map((l) => String(l.accountName || "").trim())
    .filter(Boolean);

  const found = await Acc_Ledger.find({
    companyId,
    $or: [
      ...(ids.length ? [{ _id: { $in: ids } }] : []),
      ...(names.length ? [{ name: { $in: names } }] : []),
    ],
  })
    .select("_id name groupName")
    .lean();

  const byId = new Map(found.map((l) => [String(l._id), l]));
  const byName = new Map(found.map((l) => [l.name.trim().toUpperCase(), l]));

  const entries = [];
  const unresolved = [];
  for (const [i, line] of lines.entries()) {
    const id = lineLedgerId(line);
    const ledger =
      (id && byId.get(String(id))) ||
      byName.get(String(line.accountName || "").trim().toUpperCase());
    if (!ledger) {
      unresolved.push(`line ${i + 1} (“${line.accountName || "no account"}”)`);
      continue;
    }

    const debit = Number(line.debit) || 0;
    const credit = Number(line.credit) || 0;
    /* One side per line, as a voucher records them. A line carrying both, or
       neither, is not something the books can express. */
    if (debit > 0 && credit > 0) {
      return {
        ok: false,
        code: "LINE_BOTH_SIDES",
        message: `Line ${i + 1} has both a debit and a credit. Each line is one or the other.`,
      };
    }
    if (debit <= 0 && credit <= 0) continue; // a zero line changes nothing

    entries.push({
      ledgerId: ledger._id,
      ledgerName: ledger.name,
      groupName: ledger.groupName || "",
      type: debit > 0 ? "Dr" : "Cr",
      amount: debit > 0 ? debit : credit,
      narration: line.description || undefined,
    });
  }

  if (unresolved.length) {
    return {
      ok: false,
      code: "LEDGER_NOT_FOUND",
      message: `These lines do not match a ledger in this company: ${unresolved.join(", ")}. Pick the account from the list so the entry knows where to post.`,
    };
  }
  if (entries.length < 2) {
    return { ok: false, code: "TOO_FEW_LINES", message: "A journal entry needs at least two lines carrying an amount." };
  }

  const totalDebit = entries.filter((e) => e.type === "Dr").reduce((s, e) => s + e.amount, 0);
  const totalCredit = entries.filter((e) => e.type === "Cr").reduce((s, e) => s + e.amount, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return {
      ok: false,
      code: "UNBALANCED",
      message: `Debits (${totalDebit.toFixed(2)}) and credits (${totalCredit.toFixed(2)}) do not agree.`,
    };
  }

  return { ok: true, companyId, ledgerEntries: entries, total: totalDebit };
}

/**
 * Post an entry to the books, once.
 *
 * Idempotent on purpose. It is called from the post route, from creation when
 * an entry is created already posted, and from the repair path for entries
 * posted under the old behaviour — and "post this thing that may already be
 * posted" must never produce a second voucher and double the balances.
 */
async function postJournalEntry(entry, user) {
  if (entry.voucherId) {
    const existing = await Acc_Voucher.findById(entry.voucherId)
      .select("_id voucherNumber status")
      .lean();
    /* A voucher that was cancelled or voided is not an entry in the books any
       more, so the link is stale and the entry may be posted again. */
    if (existing && !["cancelled", "void"].includes(existing.status)) {
      return { ok: true, alreadyPosted: true, voucher: existing };
    }
  }

  const resolved = await resolveLines(entry);
  if (!resolved.ok) return resolved;

  const voucherDate = entry.entryDate || new Date();
  const voucherNumber = await Acc_Voucher.nextVoucherNumber(
    resolved.companyId,
    "journal",
  );

  const direct = canPostDirectly(user);
  const voucher = new Acc_Voucher({
    companyId: resolved.companyId,
    voucherType: "journal",
    voucherTypeName: "Journal",
    voucherNumber,
    voucherDate,
    ledgerEntries: resolved.ledgerEntries,
    grandTotal: resolved.total,
    narration: entry.narration || "",
    /* Where this came from, so the day book and the audit trail can say so
       and so the repair script can find its own work again. */
    sourceSystem: "journal_entry",
    sourceId: entry._id,
    sourceReference: entry.entryNumber || "",
    createdBy: user?.id || entry.createdBy || undefined,
    status: direct ? "posted" : "pending_approval",
  });

  if (!direct) {
    voucher.submittedBy = user?.id;
    voucher.submittedByName = user?.name || "";
    voucher.submittedAt = new Date();
  }

  await voucher.save();

  entry.voucherId = voucher._id;
  entry.voucherNumber = voucher.voucherNumber;
  entry.status = direct ? "posted" : "draft";
  if (direct) {
    entry.postedBy = user?.id || entry.postedBy;
    entry.postedAt = new Date();
  }
  await entry.save();

  return {
    ok: true,
    alreadyPosted: false,
    awaitingApproval: !direct,
    voucher: {
      _id: voucher._id,
      voucherNumber: voucher.voucherNumber,
      status: voucher.status,
    },
  };
}

/** Take an entry back out of the books. The voucher is voided, not deleted, so
 *  the day book still shows that it existed and was reversed. */
async function voidJournalEntry(entry) {
  if (!entry.voucherId) return { ok: true, voidedVoucher: false };
  const voucher = await Acc_Voucher.findById(entry.voucherId);
  if (!voucher) return { ok: true, voidedVoucher: false };
  if (["cancelled", "void"].includes(voucher.status))
    return { ok: true, voidedVoucher: false };
  voucher.status = "void";
  await voucher.save(); // pre-save clears isLive, freeing the voucher number
  return { ok: true, voidedVoucher: true, voucherNumber: voucher.voucherNumber };
}

module.exports = {
  lineLedgerId,
  canPostDirectly,
  resolveLines,
  postJournalEntry,
  voidJournalEntry,
};
