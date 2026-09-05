"use strict";

// ── Authoritative Service-Order → supplier-bill resolver (S3 correction) ─────
//
// One resolver, used by BOTH the billable-prefill endpoint and the actual
// voucher-create route, so the two can never disagree about what a Service
// Order may be billed as. The rule that matters: provenance is derived on the
// server from the accepted order — a client cannot bypass acceptance, invent a
// service-order number, or name another request's commitment. Callers must
// treat a refusal (`ok:false`) as final and create nothing.

const mongoose = require("mongoose");
const { Acc_Company } = require("../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../models/Accountant_model/Acc_VoucherModels");
const Commitment = require("../models/Accountant_model/Acc_BudgetCommitment");

// A supplier bill "already exists" only while a voucher is live; a cancelled or
// void historical bill leaves the order billable again without confirmation.
const LIVE_VOUCHER = ["draft", "pending_approval", "posted"];

// The six provenance fields the server owns for a service-order-linked voucher.
// Nothing outside this list is provenance; nothing in it is trusted from a
// client on create, or mutable on edit.
const PROVENANCE_FIELDS = [
  "serviceOrderId",
  "serviceOrderNumber",
  "spendRequestId",
  "budgetCommitmentId",
  "sourceId",
  "sourceReference",
];

function loadServiceOrder() {
  try {
    return require("../models/CMS_Models/Inventory/Operations/ServiceOrder");
  } catch {
    return null;
  }
}

const refuse = (status, code, message, extra = {}) => ({
  ok: false,
  status,
  code,
  message,
  ...extra,
});

/**
 * Resolve what an ACCEPTED Service Order may be billed as, authoritatively.
 * @returns {Promise<{ok:true, order, provenance, commitment, commitmentStatus,
 *   vouchers, live, hasLiveVoucher} | {ok:false, status, code, message}>}
 */
async function resolveServiceOrderBilling({ serviceOrderId, companyId }) {
  if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) {
    return refuse(400, "COMPANY_REQUIRED", "companyId is required.");
  }
  if (!serviceOrderId || !mongoose.Types.ObjectId.isValid(serviceOrderId)) {
    return refuse(404, "SERVICE_ORDER_NOT_FOUND", "Service order not found.");
  }

  // Company authorization. Accounting is company-scoped by `companyId` on every
  // document; the standing convention is that a company must exist to be
  // written into. A company that does not exist is not one to bill against.
  const company = await Acc_Company.findById(companyId).select("_id").lean();
  if (!company) {
    return refuse(
      403,
      "COMPANY_NOT_AUTHORIZED",
      "This company is not available to you.",
    );
  }

  const ServiceOrder = loadServiceOrder();
  if (!ServiceOrder) {
    return refuse(
      503,
      "SERVICE_MODULE_UNAVAILABLE",
      "Service orders module not available.",
    );
  }

  // Scoped to the billing company — an order in another company reads as not
  // found, never as accessible.
  const so = await ServiceOrder.findOne({
    _id: serviceOrderId,
    companyId,
  }).lean();
  if (!so) {
    return refuse(
      404,
      "SERVICE_ORDER_NOT_FOUND",
      "Service order not found in this company.",
    );
  }

  // Billing follows department ACCEPTANCE, not supplier completion.
  if (so.status !== "ACCEPTED") {
    const why =
      so.status === "CANCELLED"
        ? "This service order was cancelled, so it cannot be billed."
        : so.status === "COMPLETION_REPORTED"
          ? "The supplier has reported completion, but the requesting department has not accepted this service yet. It can be billed once it is accepted."
          : `This service order is ${String(so.status || "")
              .toLowerCase()
              .replace(/_/g, " ")} — a supplier bill can only be raised once the department has accepted it.`;
    return refuse(409, "NOT_ACCEPTED", why, { currentStatus: so.status });
  }

  // The live commitment for the underlying request, so the voucher can carry
  // the link the existing budget machinery releases on posting. Scoped to the
  // SAME company AND this order's own spend request; defence-in-depth then
  // drops anything that somehow crosses either boundary — a commitment from
  // another company or request is never attached or released.
  let commitment = null;
  if (so.spendRequestId) {
    commitment = await Commitment.findOne({
      spendRequestId: so.spendRequestId,
      companyId,
    })
      .select("_id status spendRequestId companyId")
      .lean()
      .catch(() => null);
    if (
      commitment &&
      (String(commitment.companyId) !== String(companyId) ||
        String(commitment.spendRequestId) !== String(so.spendRequestId))
    ) {
      commitment = null;
    }
  }

  const provenance = {
    serviceOrderId: String(so._id),
    serviceOrderNumber: so.serviceOrderNumber || "",
    spendRequestId: so.spendRequestId ? String(so.spendRequestId) : null,
    spendRequestNumber: so.spendRequestNumber || "",
    budgetCommitmentId: commitment ? String(commitment._id) : null,
    sourceSystem: "auto_from_service_order",
    sourceId: String(so._id),
    sourceReference: so.serviceOrderNumber || "",
  };

  // Existing supplier bills for this order — scoped by company AND
  // voucherType:"purchase", so a same-id document of another type or company
  // can never masquerade as a bill of this one.
  const vouchers = await Acc_Voucher.find({
    companyId,
    voucherType: "purchase",
    serviceOrderId: so._id,
  })
    .select(
      "voucherNumber status grandTotal voucherDate referenceNumber referenceDate",
    )
    .sort({ createdAt: 1 })
    .lean();
  const live = vouchers.filter((v) => LIVE_VOUCHER.includes(v.status));

  return {
    ok: true,
    order: so,
    provenance,
    commitment,
    commitmentStatus: commitment ? commitment.status : null,
    vouchers,
    live,
    hasLiveVoucher: live.length > 0,
  };
}

// Summaries returned to a caller refused for a duplicate live bill.
const voucherSummary = (v) => ({
  _id: String(v._id),
  voucherNumber: v.voucherNumber,
  status: v.status,
  grandTotal: v.grandTotal || 0,
  voucherDate: v.voucherDate || null,
  referenceNumber: v.referenceNumber || "",
});

module.exports = {
  resolveServiceOrderBilling,
  voucherSummary,
  LIVE_VOUCHER,
  PROVENANCE_FIELDS,
};
