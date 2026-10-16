"use strict";

/**
 * Every voucher waiting for approval has an approval request (13 Oct 2026).
 *
 * The Approvals page lists Acc_ApprovalRequest documents. The voucher route
 * files one when an editor's voucher is held; journal-entry posting
 * (services/journalEntryPosting.service.js) held the voucher —
 * status "pending_approval", the voucher page reading "Pending approval —
 * review in Approvals" — and filed NOTHING, so the owner had no way to approve
 * it, and the only way forward looked like posting it again (JV/2627/00143,
 * from JE-MV6KS5I9).
 *
 *   ensureVoucherApprovalRequest — file the request for one held voucher,
 *     in exactly the shape the voucher route uses (kind "voucher", action
 *     "post", target the voucher), once: an existing pending request for the
 *     same voucher is returned, never a second one.
 *   backfillOrganization — find this organisation's held vouchers that have
 *     no pending request and file theirs. Run when the Approvals page loads,
 *     at most once a minute per organisation, so a voucher held before this
 *     fix appears without anyone re-posting it.
 *
 * Approving the request posts THE EXISTING voucher (Acc_approvals.js,
 * kind "voucher" / action "post"); nothing is posted twice.
 */

const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { Acc_ApprovalRequest, Acc_Organization } = require("../../models/Accountant_model/Acc_OrgModels");

const titleOf = (v) =>
  `Post ${v.voucherType} ${v.voucherNumber} · ${v.partyLedgerName || "—"} · ₹${Number(v.grandTotal || 0).toLocaleString("en-IN")}`;

async function ensureVoucherApprovalRequest({ voucher, organizationId, requestedBy, requestedByName }) {
  if (!voucher || !organizationId || voucher.status !== "pending_approval") return null;
  const existing = await Acc_ApprovalRequest.findOne({
    kind: "voucher",
    action: "post",
    status: "pending",
    "target.id": voucher._id,
  }).lean();
  if (existing) return existing;
  return Acc_ApprovalRequest.create({
    organizationId,
    companyId: voucher.companyId,
    kind: "voucher",
    action: "post",
    title: titleOf(voucher),
    target: { collection: "Acc_Voucher", id: voucher._id },
    payload: { voucherId: voucher._id },
    requestedBy: requestedBy || voucher.submittedBy || voucher.createdBy || undefined,
    requestedByName: requestedByName || voucher.submittedByName || "",
    status: "pending",
  });
}

const lastRun = new Map();
const EVERY_MS = 60 * 1000;

/** File the missing request for every held voucher of this organisation. */
async function backfillOrganization(organizationId, { force = false } = {}) {
  if (!organizationId) return 0;
  const key = String(organizationId);
  if (!force && lastRun.has(key) && Date.now() - lastRun.get(key) < EVERY_MS) return 0;
  lastRun.set(key, Date.now());
  const org = await Acc_Organization.findById(organizationId).select("tallyCompanyIds").lean();
  const companyIds = (org && org.tallyCompanyIds) || [];
  if (!companyIds.length) return 0;
  const held = await Acc_Voucher.find({ companyId: { $in: companyIds }, status: "pending_approval" })
    .select("_id companyId voucherType voucherNumber partyLedgerName grandTotal status submittedBy submittedByName createdBy")
    .limit(500)
    .lean();
  if (!held.length) return 0;
  const covered = new Set(
    (
      await Acc_ApprovalRequest.find({
        kind: "voucher",
        status: "pending",
        "target.id": { $in: held.map((v) => v._id) },
      })
        .select("target.id")
        .lean()
    ).map((r) => String(r.target.id)),
  );
  let filed = 0;
  for (const v of held) {
    if (covered.has(String(v._id))) continue;
    await ensureVoucherApprovalRequest({ voucher: v, organizationId });
    filed += 1;
  }
  if (filed) console.log(`[approvals] filed ${filed} missing request(s) for held vouchers (org ${key})`);
  return filed;
}

module.exports = { ensureVoucherApprovalRequest, backfillOrganization };
