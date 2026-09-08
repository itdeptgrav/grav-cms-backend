// routes/CMS_Routes/Inventory/Operations/serviceOrders.js
//
// SERVICE ORDER OPERATIONS — issue, start, supplier completion, department
// acceptance or a correction. Nothing here creates a purchase order, a goods
// receipt, stock, a warehouse transaction, a barcode or any inventory
// movement: a service is accepted by the department that asked for it, not
// received onto a shelf.
//
// ── WHAT THIS FIRST VERSION IS, HONESTLY ────────────────────────────────────
// Completion and acceptance are WHOLE-ORDER. There is no milestone or partial
// acceptance, and nothing here pretends there is. Paid/billed statuses are
// Accounting's, not this document's — "report completion" says the supplier is
// done; it creates no accounting spend.
"use strict";

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const ServiceOrder = require("../../../../models/CMS_Models/Inventory/Operations/ServiceOrder");
const Employee = require("../../../../models/Employee");
const mrfApprover = require("../../../../services/mrfApprover.service");
const { resolveFulfilmentAccess } = require("../../../../services/access/fulfilmentAccess");
const { requireTenant } = require("../../../../Middlewear/storePurchaseTenant");

/* Authenticate, THEN resolve the acting company through the established
   tenant/membership contract. `requireTenant` fails closed — a missing,
   ambiguous or unauthorised company selection never reaches a handler — so
   every query below can trust `req.tenant.companyId`. It resolves a company
   for any employee with a membership (or a single-company deployment), which
   is why a requester who holds no Store capability can still reach their own
   order. */
router.use(require("../../../../Middlewear/EmployeeAuthMiddlewear"));
router.use(requireTenant);

/* ── WHO IS ACTING ──────────────────────────────────────────────────────────
   Resolved from the session the same way the spend router resolves it, so one
   person is one identity across both. */
async function actor(req) {
  const biometricId = req.user?.employeeId;
  const byId = mongoose.isValidObjectId(req.user?.id) ? { _id: req.user.id } : null;
  return Employee.findOne(
    biometricId ? { $or: [{ biometricId }, { identityId: biometricId }] } : byId,
  ).select(
    "_id firstName middleName lastName name email department biometricId identityId " +
      "accessDepartmentId additionalDepartmentIds isActive status",
  ).lean();
}

/** Whether this person may act for Store. */
async function mayFulfil(emp) {
  const a = await resolveFulfilmentAccess(emp).catch(() => ({ allowed: false }));
  return Boolean(a?.allowed);
}

/**
 * Whether this employee is the requester of an order.
 *
 * The stable Employee ObjectId is compared FIRST; only a legacy order with no
 * `requestedBy` falls back to the mutable biometric/identity string. A blank
 * string never matches a blank stored value.
 */
function isRequesterOf(emp, so) {
  if (so.requestedBy && emp?._id) return String(so.requestedBy) === String(emp._id);
  const mine = String(emp?.biometricId || emp?.identityId || "");
  return Boolean(mine) && mine === String(so.requestedById || "");
}

const NEXT_ACTION = {
  DRAFT: "Issue to the supplier",
  ISSUED: "Mark started, or record completion",
  IN_PROGRESS: "Record supplier completion",
  COMPLETION_REPORTED: "Requesting department accepts or asks for a correction",
  ACCEPTED: "Accepted — ready for supplier-bill matching",
  REWORK_REQUIRED: "Correct and record completion again",
  CANCELLED: "Cancelled",
};

const STATUS_LABEL = {
  DRAFT: "Draft", ISSUED: "Issued", IN_PROGRESS: "In progress",
  COMPLETION_REPORTED: "Completion reported", ACCEPTED: "Accepted",
  REWORK_REQUIRED: "Rework required", CANCELLED: "Cancelled",
};

/* ── THE SUPPLIER-BILLING STATE OF A SERVICE ORDER ──────────────────────────
   Billing follows department ACCEPTANCE. Live vouchers (draft/pending/posted)
   decide the visible state; cancelled/void ones never make an order read as
   "billed", so an accepted order with only cancelled bills is billable again.
   Multiple bills are legitimate (staged/recurring), so totals are kept
   distinct per status and each voucher is returned separately. */
const LIVE_VOUCHER = ["draft", "pending_approval", "posted"];
function billingStateFor(so, vouchers) {
  const rows = (vouchers || []).map((v) => ({
    _id: String(v._id),
    voucherNumber: v.voucherNumber || "",
    status: v.status,
    grandTotal: v.grandTotal || 0,
    voucherDate: v.voucherDate || null,
    referenceNumber: v.referenceNumber || "",
  }));
  const live = rows.filter((v) => LIVE_VOUCHER.includes(v.status));
  const sum = (st) => Math.round(live.filter((v) => v.status === st)
    .reduce((t, v) => t + (v.grandTotal || 0), 0) * 100) / 100;
  const totals = { draft: sum("draft"), pending: sum("pending_approval"), posted: sum("posted") };

  let state;
  if (so.status !== "ACCEPTED") state = "not-ready";
  else if (live.some((v) => v.status === "posted")) state = "posted";
  else if (live.some((v) => v.status === "pending_approval")) state = "pending";
  else if (live.some((v) => v.status === "draft")) state = "drafted";
  else state = "ready";

  return {
    ready: so.status === "ACCEPTED",
    state,
    hasLiveVoucher: live.length > 0,
    totals,
    vouchers: rows,
  };
}

const publicServiceOrder = (so, { detail = false } = {}) => ({
  _id: String(so._id),
  serviceOrderNumber: so.serviceOrderNumber,
  status: so.status,
  statusLabel: STATUS_LABEL[so.status] || so.status,
  nextAction: NEXT_ACTION[so.status] || "",
  spendRequestId: so.spendRequestId ? String(so.spendRequestId) : null,
  spendRequestNumber: so.spendRequestNumber || "",
  vendorName: so.vendorName || "",
  vendorGstin: so.vendorGstin || "",
  title: so.title || "",
  department: so.department || "",
  requestedByName: so.requestedByName || "",
  requestedById: so.requestedById || "",
  subtotal: so.subtotal || 0,
  taxAmount: so.taxAmount || 0,
  totalAmount: so.totalAmount || 0,
  taxMode: so.taxMode || "SINGLE_RATE",
  taxRate: so.taxRate || 0,
  expectedCompletionDate: so.expectedCompletionDate || null,
  createdAt: so.createdAt || null,
  lineCount: (so.lines || []).length,
  ...(detail ? {
    purpose: so.purpose || "",
    budgetLedgerName: so.budgetLedgerName || "",
    budgetLedgerId: so.budgetLedgerId ? String(so.budgetLedgerId) : null,
    lines: (so.lines || []).map((l) => ({
      _id: String(l._id),
      service: l.service ? String(l.service) : null,
      serviceCode: l.serviceCode || "",
      serviceName: l.serviceName || "",
      description: l.description || "",
      specification: l.specification || "",
      billingUnit: l.billingUnit || "",
      sacCode: l.sacCode || "",
      quantity: l.quantity, rate: l.rate, netAmount: l.netAmount,
      gstRate: l.gstRate, gstAmount: l.gstAmount, lineTotal: l.lineTotal,
      quoteRef: l.quoteRef || "",
      expectedCompletionDate: l.expectedCompletionDate || null,
    })),
    issued: so.issued || null,
    completion: so.completion || null,
    acceptance: so.acceptance || null,
    rework: so.rework || null,
    cancellation: so.cancellation || null,
    history: (so.history || []).map((h) => ({
      at: h.at, byName: h.byName || "", action: h.action || "", note: h.note || "",
    })),
  } : {}),
});

/* ══ REGISTER ═══════════════════════════════════════════════════════════════ */
router.get("/", async (req, res) => {
  try {
    const emp = await actor(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });
    if (!(await mayFulfil(emp))) {
      return res.status(403).json({ success: false, message: "Only Store & Purchase can view service orders." });
    }
    /* Scoped to the resolved tenant — never an unscoped `{}` that would expose
       every company's orders. */
    const filter = { companyId: req.tenant.companyId };

    const status = String(req.query.status || "").trim().toUpperCase();
    if (status && ServiceOrder.STATUSES.includes(status)) filter.status = status;

    const supplier = String(req.query.supplier || "").trim();
    if (supplier) filter.vendorName = { $regex: supplier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };

    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from && !Number.isNaN(new Date(req.query.from).getTime())) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to && !Number.isNaN(new Date(req.query.to).getTime())) filter.createdAt.$lte = new Date(req.query.to);
    }

    const search = String(req.query.search || "").trim();
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { serviceOrderNumber: rx }, { spendRequestNumber: rx }, { vendorName: rx },
        { title: rx }, { department: rx }, { requestedByName: rx },
      ];
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const [total, rows] = await Promise.all([
      ServiceOrder.countDocuments(filter),
      ServiceOrder.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);

    res.json({
      success: true,
      serviceOrders: rows.map((r) => publicServiceOrder(r)),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (e) {
    console.error("[service-order] list:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ══ DETAIL ═════════════════════════════════════════════════════════════════ */
router.get("/:id", async (req, res) => {
  try {
    const emp = await actor(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Service order not found." });
    }
    const so = await ServiceOrder.findOne({ _id: req.params.id, companyId: req.tenant.companyId }).lean();
    if (!so) return res.status(404).json({ success: false, message: "Service order not found." });
    const canFulfil = await mayFulfil(emp);
    const isRequester = isRequesterOf(emp, so);
    /* Store may view any; the requester may view their own. */
    if (!canFulfil && !isRequester) {
      return res.status(403).json({ success: false, message: "This service order is not yours to view." });
    }
    /* Supplier bills raised against this order, so the detail page can show
       its billing state and link to the real vouchers. Scoped by company AND
       voucherType:"purchase" — never a same-id document of another company or
       type. If Accounting genuinely cannot be read, we say so honestly: an
       "unavailable" state suppresses the Create-bill action and asks for a
       retry, rather than silently reading as "ready / no bills" and inviting a
       duplicate. */
    let billing;
    try {
      const Acc_Voucher = require("../../../../models/Accountant_model/Acc_VoucherModels").Acc_Voucher;
      const vouchers = await Acc_Voucher.find({
        companyId: so.companyId,
        voucherType: "purchase",
        serviceOrderId: so._id,
      })
        .select("voucherNumber status grandTotal voucherDate referenceNumber")
        .sort({ createdAt: 1 }).lean();
      billing = billingStateFor(so, vouchers);
    } catch (err) {
      billing = {
        ready: false,
        state: "unavailable",
        hasLiveVoucher: false,
        totals: { draft: 0, pending: 0, posted: 0 },
        vouchers: [],
        message: "Billing status is temporarily unavailable. Please retry.",
      };
    }

    res.json({
      success: true,
      serviceOrder: publicServiceOrder(so, { detail: true }),
      /* So the screen offers exactly the lifecycle actions this person may
         take — Store's, the requester's, or none — without re-deriving the
         rule the server already enforces. */
      viewer: { canFulfil, isRequester },
      billing,
    });
  } catch (e) {
    console.error("[service-order] detail:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ── ONE TRANSITION, ONE SHAPE — RACE-SAFE ──────────────────────────────────
   Load the order company-scoped, check authority, then apply the change with a
   SINGLE conditional atomic write keyed on the allowed current status. If two
   users act from the same status, exactly one write matches and succeeds; the
   other matches nothing, so it reloads and returns a clean current-state
   conflict — never a version error, never a duplicate history entry. */
async function transition(req, res, {
  from, to, action, actionKey, requireRequester = false, requireReason = false, reasonMessage, verb,
}) {
  try {
    const emp = await actor(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Service order not found." });
    }
    /* Company-scoped from the first read: a cross-company order is not found. */
    const so = await ServiceOrder.findOne({ _id: req.params.id, companyId: req.tenant.companyId }).lean();
    if (!so) return res.status(404).json({ success: false, message: "Service order not found." });

    if (requireRequester) {
      /* Requester acceptance/correction needs no Store capability — only that
         this is their order, in their resolved company. */
      if (!isRequesterOf(emp, so)) {
        return res.status(403).json({
          success: false,
          message: "Only the department that requested this service can accept it or ask for a correction.",
        });
      }
    } else if (!(await mayFulfil(emp))) {
      return res.status(403).json({ success: false, message: "Only Store & Purchase can do that on a service order." });
    }

    const fromStates = Array.isArray(from) ? from : [from];
    const note = String(req.body?.note || req.body?.reason || "").trim();
    if (requireReason && !note) {
      return res.status(400).json({
        success: false, reason: "REASON_REQUIRED",
        message: reasonMessage || "A reason is required.",
      });
    }

    const now = new Date();
    const who = mrfApprover.buildFullName(emp);
    const audit = { at: now, by: emp._id, byName: who, note };

    /* THE conditional atomic transition — only while the status is still one
       the action is allowed from, and only within this company. */
    const updated = await ServiceOrder.findOneAndUpdate(
      { _id: so._id, companyId: req.tenant.companyId, status: { $in: fromStates } },
      {
        $set: { status: to, ...(actionKey ? { [actionKey]: audit } : {}) },
        $push: { history: { at: now, by: emp._id, byName: who, action, note } },
      },
      { new: true },
    );

    if (!updated) {
      /* Somebody else moved it first (or it was never in an allowed state).
         Reload company-scoped and return the current state — cleanly. */
      const fresh = await ServiceOrder.findOne({ _id: so._id, companyId: req.tenant.companyId }).lean();
      return res.status(409).json({
        success: false,
        reason: "INVALID_TRANSITION",
        message: `A ${STATUS_LABEL[fresh?.status || so.status] || fresh?.status || so.status} service order cannot ${verb}.`,
        currentStatus: fresh?.status || so.status,
        ...(fresh ? { serviceOrder: publicServiceOrder(fresh, { detail: true }) } : {}),
      });
    }

    res.json({ success: true, serviceOrder: publicServiceOrder(updated.toObject(), { detail: true }) });
  } catch (e) {
    console.error(`[service-order] ${action}:`, e);
    res.status(500).json({ success: false, message: e.message });
  }
}

/* Store issues, starts, records completion, cancels — before acceptance. */
/* Store issues, starts, records completion, cancels — before acceptance. */
router.patch("/:id/issue", (req, res) =>
  transition(req, res, { from: "DRAFT", to: "ISSUED", action: "issued", actionKey: "issued", verb: "be issued" }));

router.patch("/:id/start", (req, res) =>
  transition(req, res, { from: ["ISSUED", "REWORK_REQUIRED"], to: "IN_PROGRESS", action: "started", verb: "be started" }));

router.patch("/:id/report-completion", (req, res) =>
  transition(req, res, {
    from: "IN_PROGRESS", to: "COMPLETION_REPORTED", action: "completion reported", actionKey: "completion",
    verb: "have completion reported",
  }));

router.patch("/:id/cancel", (req, res) =>
  transition(req, res, {
    from: ["DRAFT", "ISSUED", "IN_PROGRESS", "REWORK_REQUIRED", "COMPLETION_REPORTED"],
    to: "CANCELLED", action: "cancelled", actionKey: "cancellation", verb: "be cancelled",
    /* A cancellation must say why; the reason is kept in the history. */
    requireReason: true, reasonMessage: "Say why this service order is being cancelled.",
  }));

/* Only the requesting department accepts, or asks for a correction — and only
   once completion has been reported. */
router.patch("/:id/accept", (req, res) =>
  transition(req, res, {
    from: "COMPLETION_REPORTED", to: "ACCEPTED", action: "accepted", actionKey: "acceptance",
    requireRequester: true, verb: "be accepted before completion is reported",
  }));

router.patch("/:id/request-correction", (req, res) =>
  transition(req, res, {
    from: "COMPLETION_REPORTED", to: "REWORK_REQUIRED", action: "correction requested", actionKey: "rework",
    requireRequester: true, requireReason: true, verb: "have a correction requested",
    reasonMessage: "Say what needs correcting.",
  }));

module.exports = router;
