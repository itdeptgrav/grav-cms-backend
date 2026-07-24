// routes/Accountant_Routes/Acc_approvals.js
//
// APPROVAL QUEUE — pending changes awaiting an Approver / Owner review.
//
// Routes (all require `orgAuth`):
//   GET    /                 — list pending (filterable by kind, status, requester)
//   GET    /:id              — one with full payload
//   POST   /:id/approve      — executes the underlying action server-side
//   POST   /:id/reject       — closes with reason, no change applied
//   POST   /:id/cancel       — the requester withdraws their own request
//
// The executor (`applyApprovedAction`) knows how to do each `kind+action`:
//
//   kind="voucher" action="post" → flip Acc_Voucher.status to "posted",
//                                  apply ledger balances (same as the
//                                  manual /post route does).
//   kind="voucher" action="create" → create a new posted voucher from
//                                    the saved payload.
//
// Adding new kinds is just adding another `if` branch here — the rest of
// the workflow (queue, list, status, audit) doesn't need to change.

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const {
  Acc_ApprovalRequest,
  Acc_User,
} = require("../../models/Accountant_model/Acc_OrgModels");

const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Ledger,
  Acc_Group,
} = require("../../models/Accountant_model/Acc_MasterModels");

const {
  orgAuth,
  requireRole,
  requirePermission,
} = require("../../Middlewear/AccountantOrgAuthMiddleware");

router.use(orgAuth);

// ─────────────────────────────────────────────────────────────────────────
// GET /list — unified feed for the Approvals page (history, not just pending)
// ─────────────────────────────────────────────────────────────────────────
// ?scope=org|mine  &status=pending|approved|rejected|cancelled|all
//   scope=org  → approver/owner org-wide view (canApprove required), limited
//                to editor-originated requests (the only ones that ever
//                needed approval).
//   scope=mine → the caller's OWN requests in any status, so an editor can
//                see whether what they submitted was approved or rejected.
router.get("/list", async (req, res) => {
  try {
    if (!requireOrg(req, res)) return;
    const scope = req.query.scope === "org" ? "org" : "mine";
    if (scope === "org" && !requireCanApprove(req, res)) return;

    const q = { organizationId: req.user.organizationId };
    if (scope === "mine") q.createdBy = req.user.id;
    else q.createdByRole = "editor";
    if (req.query.companyId) q.companyId = req.query.companyId;

    const statusMap = {
      pending: "pending_approval",
      approved: "approved",
      rejected: "rejected",
      cancelled: "void",
    };
    const s = req.query.status;
    if (s && s !== "all" && statusMap[s]) q.status = statusMap[s];

    const rows = await Acc_LedgerReclassRequest.find(q)
      .sort({ createdAt: -1 })
      .limit(300)
      .lean();
    res.json({ success: true, requests: rows });
  } catch (e) {
    console.error("[ledger-reclass/list]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
function orgFilter(req) {
  if (req.user.isLegacy || req.user.isDev) return {};
  return { organizationId: req.user.organizationId };
}

// Re-implements the voucher balance application from tallyVouchers.js so we
// don't depend on its internals. direction = +1 for posting, -1 for unposting.
//
// Note: we read entry.ledgerId OR entry.ledger because older drafts (saved
// before the schema rename) still carry `ledger` instead of `ledgerId`.
// Without this fallback, approving an older draft silently fails to apply
// the balance update — voucher posts but ledger balances don't move.
async function applyLedgerBalances(voucher, direction, session) {
  const ops = [];
  for (const entry of voucher.ledgerEntries) {
    const lid = entry.ledgerId || entry.ledger;
    if (!lid) continue;
    const delta = (entry.signedAmount || 0) * direction;
    ops.push({
      updateOne: {
        filter: { _id: lid },
        update: { $inc: { currentBalance: delta } },
      },
    });
  }
  if (ops.length) await Acc_Ledger.bulkWrite(ops, { session });
  for (const entry of voucher.ledgerEntries) {
    const lid = entry.ledgerId || entry.ledger;
    if (!lid) continue;
    const led = await Acc_Ledger.findById(lid).session(session);
    if (led) {
      led.balanceType = led.currentBalance >= 0 ? "Dr" : "Cr";
      await led.save({ session });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// The executor — turns an approved Acc_ApprovalRequest into a real change
// ─────────────────────────────────────────────────────────────────────────
async function applyApprovedAction(reqDoc, approver) {
  const { kind, action, payload, target } = reqDoc;

  // VOUCHER  ── post an existing draft
  if (kind === "voucher" && action === "post") {
    if (!target?.id) throw new Error("voucher post: target.id missing");
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const voucher = await Acc_Voucher.findById(target.id).session(session);
      if (!voucher) throw new Error("Voucher not found");
      if (voucher.status === "posted") {
        await session.commitTransaction();
        return { entityId: voucher._id, note: "Already posted" };
      }
      if (voucher.status !== "draft" && voucher.status !== "pending_approval") {
        throw new Error(`Cannot post voucher in '${voucher.status}' status`);
      }
      if (!voucher.isBalanced)
        throw new Error("Voucher Dr/Cr totals do not balance");
      voucher.status = "posted";
      voucher.updatedBy = approver.id;
      await voucher.save({ session });
      await applyLedgerBalances(voucher, +1, session);
      await session.commitTransaction();
      return { entityId: voucher._id };
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  }

  // VOUCHER ── create a new posted voucher from payload
  if (kind === "voucher" && action === "create") {
    if (!payload) throw new Error("voucher create: payload missing");
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const body = { ...payload };
      body.status = "posted";
      body.updatedBy = approver.id;
      // Number if missing
      if (!body.voucherNumber) {
        body.voucherNumber = await Acc_Voucher.nextVoucherNumber(
          body.companyId,
          body.voucherType,
          body.numberingPrefix,
        );
      }
      const voucher = new Acc_Voucher(body);
      await voucher.save({ session });
      await applyLedgerBalances(voucher, +1, session);
      await session.commitTransaction();
      return { entityId: voucher._id };
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  }

  // VOUCHER ── cancel a posted voucher
  if (kind === "voucher" && action === "cancel") {
    if (!target?.id) throw new Error("voucher cancel: target.id missing");
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const voucher = await Acc_Voucher.findById(target.id).session(session);
      if (!voucher) throw new Error("Voucher not found");
      if (voucher.status === "posted") {
        await applyLedgerBalances(voucher, -1, session);
      }
      voucher.status = "cancelled";
      voucher.updatedBy = approver.id;
      await voucher.save({ session });
      await session.commitTransaction();
      return { entityId: voucher._id };
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  }

  // VOUCHER ── void a voucher (mirror of cancel; status becomes "void")
  if (kind === "voucher" && action === "void") {
    if (!target?.id) throw new Error("voucher void: target.id missing");
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const voucher = await Acc_Voucher.findById(target.id).session(session);
      if (!voucher) throw new Error("Voucher not found");
      if (voucher.status === "posted") {
        await applyLedgerBalances(voucher, -1, session);
      }
      voucher.status = "void";
      voucher.updatedBy = approver.id;
      await voucher.save({ session });
      await session.commitTransaction();
      return { entityId: voucher._id };
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  }

  // VOUCHER ── apply a held edit to an existing voucher
  if (kind === "voucher" && action === "update") {
    if (!target?.id) throw new Error("voucher update: target.id missing");
    if (!payload) throw new Error("voucher update: payload missing");
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const voucher = await Acc_Voucher.findById(target.id).session(session);
      if (!voucher) throw new Error("Voucher not found");
      if (["cancelled", "void"].includes(voucher.status)) {
        throw new Error(`Cannot edit a ${voucher.status} voucher`);
      }
      const wasPosted = voucher.status === "posted";

      // Reverse the old balances first (mirror of the direct edit path).
      if (wasPosted) {
        await applyLedgerBalances(voucher, -1, session);
      }

      // Apply the proposed changes. These were canonicalised when the edit was
      // submitted; re-strip the protected fields defensively.
      const body = { ...payload };
      delete body._id;
      delete body.companyId;
      delete body.voucherType;
      delete body.status;
      delete body.autoPost;
      delete body.createdBy;
      delete body.createdAt;
      body.updatedBy = approver.id;

      Object.assign(voucher, body);
      await voucher.save({ session });

      // Re-apply balances if it remains posted.
      if (wasPosted) {
        await applyLedgerBalances(voucher, +1, session);
      }

      await session.commitTransaction();
      return { entityId: voucher._id };
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  }

  // LEDGER ── create a new ledger from payload (mirrors POST /ledgers)
  if (kind === "ledger" && action === "create") {
    if (!payload) throw new Error("ledger create: payload missing");
    const body = payload;
    if (!body.companyId || !body.name || !body.groupId)
      throw new Error("ledger create: companyId, name, groupId required");
    const group = await Acc_Group.findById(body.groupId);
    if (!group) throw new Error("Group not found");
    const signedOpen =
      (body.openingBalanceType === "Cr" ? -1 : 1) *
      Math.abs(parseFloat(body.openingBalance) || 0);
    const ledger = await Acc_Ledger.create({
      ...body,
      groupName: group.name,
      nature: body.nature || group.nature,
      openingBalance: signedOpen,
      currentBalance: signedOpen,
      currentBalanceType: body.openingBalanceType || "Dr",
      createdBy: approver.id,
    });
    return { entityId: ledger._id };
  }

  // LEDGER ── update an existing ledger (mirrors PUT /ledgers/:id)
  if (kind === "ledger" && action === "update") {
    if (!target?.id) throw new Error("ledger update: target.id missing");
    const updates = { ...(payload || {}) };
    delete updates._id;
    delete updates.companyId;
    if (updates.openingBalanceType) {
      const sign = updates.openingBalanceType === "Cr" ? -1 : 1;
      updates.openingBalance =
        sign * Math.abs(parseFloat(updates.openingBalance) || 0);
    }
    updates.updatedBy = approver.id;
    const ledger = await Acc_Ledger.findByIdAndUpdate(target.id, updates, {
      new: true,
    });
    if (!ledger) throw new Error("Ledger not found");
    return { entityId: ledger._id };
  }

  // VOUCHER ── link/unlink a purchase voucher to a PO (mirrors /:id/link-po)
  if (kind === "voucher" && action === "link_po") {
    const v = await Acc_Voucher.findById(target.id);
    if (!v) throw new Error("Voucher not found");
    if (payload?.unlink) {
      v.purchaseOrderId = undefined;
      v.purchaseOrderNumber = "";
    } else {
      if (!payload?.purchaseOrderId)
        throw new Error("link_po: purchaseOrderId missing");
      v.purchaseOrderId = payload.purchaseOrderId;
      v.purchaseOrderNumber = payload.purchaseOrderNumber || "";
      v.sourceSystem = v.sourceSystem || "auto_from_po";
      v.sourceId = payload.purchaseOrderId;
      v.sourceReference =
        v.sourceReference || payload.purchaseOrderNumber || "";
    }
    v.updatedBy = approver.id;
    await v.save();
    return { entityId: v._id };
  }

  // LEDGER ── merge one ledger into another (mirrors POST /ledgers/:id/merge)  //
  // Repoints every voucher reference from source to destination, folds the
  // balances, and empties the source. Deliberately NOT handled by the generic
  // "update" executor above — that would $set the request body onto the
  // source ledger and move nothing.
  if (kind === "ledger" && action === "merge") {
    if (!target?.id) throw new Error("ledger merge: target.id missing");
    const destId = payload?.destinationLedgerId;
    if (!destId) throw new Error("ledger merge: destinationLedgerId missing");

    const source = await Acc_Ledger.findById(target.id);
    if (!source) throw new Error("Source ledger not found");
    const dest = await Acc_Ledger.findById(destId);
    if (!dest || dest.isActive === false)
      throw new Error("Destination ledger not found");
    if (String(source._id) === String(dest._id))
      throw new Error("Source and destination cannot be the same ledger");
    if (String(source.companyId) !== String(dest.companyId))
      throw new Error("Source and destination must belong to the same company");
    if (source.nature && dest.nature && source.nature !== dest.nature)
      throw new Error(
        `Cannot merge a ${source.nature} ledger into a ${dest.nature} ledger`,
      );

    const counts = { ledgerEntries: 0, partyVouchers: 0, bankVouchers: 0 };

    const leRes = await Acc_Voucher.updateMany(
      { "ledgerEntries.ledgerId": source._id },
      {
        $set: {
          "ledgerEntries.$[elem].ledgerId": dest._id,
          "ledgerEntries.$[elem].ledgerName": dest.name,
          "ledgerEntries.$[elem].groupName": dest.groupName,
        },
      },
      { arrayFilters: [{ "elem.ledgerId": source._id }] },
    );
    counts.ledgerEntries = leRes.modifiedCount || 0;

    const partyRes = await Acc_Voucher.updateMany(
      { partyLedgerId: source._id },
      { $set: { partyLedgerId: dest._id, partyLedgerName: dest.name } },
    );
    counts.partyVouchers = partyRes.modifiedCount || 0;

    const bankRes = await Acc_Voucher.updateMany(
      { bankLedgerId: source._id },
      { $set: { bankLedgerId: dest._id } },
    );
    counts.bankVouchers = bankRes.modifiedCount || 0;

    // Signed balances: +ve = Dr, −ve = Cr.
    const signed = (val, type) => {
      const v = Number(val) || 0;
      if (v < 0) return v;
      return (type === "Cr" ? -1 : 1) * v;
    };
    const newOpening =
      signed(dest.openingBalance, dest.openingBalanceType) +
      signed(source.openingBalance, source.openingBalanceType);
    const newCurrent =
      signed(dest.currentBalance, dest.currentBalanceType) +
      signed(source.currentBalance, source.currentBalanceType);

    await Acc_Ledger.updateOne(
      { _id: dest._id },
      {
        $set: {
          openingBalance: newOpening,
          openingBalanceType: newOpening < 0 ? "Cr" : "Dr",
          currentBalance: newCurrent,
          currentBalanceType: newCurrent < 0 ? "Cr" : "Dr",
          ...(dest.balanceFromTrialBalance || source.balanceFromTrialBalance
            ? { balanceFromTrialBalance: true }
            : {}),
          ...(source.linkedVendorId && !dest.linkedVendorId
            ? { linkedVendorId: source.linkedVendorId }
            : {}),
          ...(source.linkedCustomerId && !dest.linkedCustomerId
            ? { linkedCustomerId: source.linkedCustomerId }
            : {}),
          ...(source.linkedEmployeeId && !dest.linkedEmployeeId
            ? { linkedEmployeeId: source.linkedEmployeeId }
            : {}),
        },
      },
    );

    const sourceUpdate = {
      openingBalance: 0,
      openingBalanceType: "Dr",
      currentBalance: 0,
      currentBalanceType: "Dr",
      balanceFromTrialBalance: false,
      linkedVendorId: null,
      linkedCustomerId: null,
      linkedEmployeeId: null,
      mergedIntoLedgerId: dest._id,
      mergedAt: new Date(),
      updatedBy: approver.id,
    };
    if (payload?.deactivateSource !== false) {
      sourceUpdate.isActive = false;
      sourceUpdate.deletedAt = new Date();
      if (!/^\[MERGED\]/.test(source.name || ""))
        sourceUpdate.name = `[MERGED] ${source.name}`;
    }
    await Acc_Ledger.updateOne(
      { _id: source._id },
      { $set: sourceUpdate },
      { strict: false },
    );

    return { entityId: dest._id, counts };
  }

  // LEDGER ── soft-delete an unused ledger (mirrors DELETE /ledgers/:id, clean case)
  if (kind === "ledger" && action === "delete") {
    if (!target?.id) throw new Error("ledger delete: target.id missing");
    const ledger = await Acc_Ledger.findById(target.id);
    if (!ledger) throw new Error("Ledger not found");
    const txnCount = await Acc_Voucher.countDocuments({
      "ledgerEntries.ledgerId": ledger._id,
      status: "posted",
    });
    const partyCount = await Acc_Voucher.countDocuments({
      partyLedgerId: ledger._id,
    });
    if (txnCount + partyCount > 0)
      throw new Error(
        `Ledger is now used in ${txnCount + partyCount} place(s); cannot delete.`,
      );
    ledger.isActive = false;
    ledger.updatedBy = approver.id;
    await ledger.save();
    return { entityId: ledger._id };
  }

  // GROUP ── create a new group from payload (mirrors POST /groups)
  if (kind === "group" && action === "create") {
    if (!payload) throw new Error("group create: payload missing");
    const body = payload;
    if (!body.companyId || !body.name || !body.nature)
      throw new Error("group create: companyId, name, nature required");
    let parentDoc = null;
    if (body.parent) {
      parentDoc = await Acc_Group.findById(body.parent);
      if (!parentDoc) throw new Error("Parent group not found");
    }
    const group = await Acc_Group.create({
      companyId: body.companyId,
      name: body.name,
      nature: body.nature,
      description: body.description,
      parent: parentDoc?._id || null,
      parentName: parentDoc?.name || null,
      level: parentDoc ? (parentDoc.level || 1) + 1 : 1,
      fullPath: parentDoc ? `${parentDoc.fullPath} > ${body.name}` : body.name,
      isReserved: false,
      createdBy: approver.id,
    });
    return { entityId: group._id };
  }

  // GROUP ── update an existing group (mirrors PUT /groups/:id)
  if (kind === "group" && action === "update") {
    if (!target?.id) throw new Error("group update: target.id missing");
    const grp = await Acc_Group.findById(target.id);
    if (!grp) throw new Error("Group not found");
    const body = payload || {};
    if (grp.isReserved && body.name && body.name !== grp.name)
      throw new Error("Cannot rename a reserved Tally group");
    Object.assign(grp, body);
    grp.updatedBy = approver.id;
    await grp.save();
    return { entityId: grp._id };
  }

  // GROUP ── soft-delete an empty group (mirrors DELETE /groups/:id)
  if (kind === "group" && action === "delete") {
    if (!target?.id) throw new Error("group delete: target.id missing");
    const grp = await Acc_Group.findById(target.id);
    if (!grp) throw new Error("Group not found");
    if (grp.isReserved) throw new Error("Cannot delete a reserved group");
    const childCount = await Acc_Group.countDocuments({
      parent: grp._id,
      isActive: true,
    });
    const ledgerCount = await Acc_Ledger.countDocuments({
      groupId: grp._id,
      isActive: true,
    });
    if (childCount > 0 || ledgerCount > 0)
      throw new Error(
        `Group has ${childCount} sub-group(s) and ${ledgerCount} ledger(s). Move or delete them first.`,
      );
    grp.isActive = false;
    grp.updatedBy = approver.id;
    await grp.save();
    return { entityId: grp._id };
  }

  // PAYROLL ── post a payroll run (replays the chart-of-accounts posting)
  if (kind === "payroll_post" && action === "post") {
    if (!target?.id) throw new Error("payroll post: target.id (runId) missing");
    const companyId = payload?.companyId;
    if (!companyId) throw new Error("payroll post: companyId missing");
    const coa = require("./Acc_chartOfAccounts");
    if (typeof coa.postPayrollRunById !== "function")
      throw new Error("payroll posting function unavailable");
    await coa.postPayrollRunById(companyId, target.id, {
      bankLedgerId: payload?.bankLedgerId || undefined,
    });
    return { entityId: target.id };
  }

  // Add more kinds here as you migrate modules to the approval flow.
  // NOTE: cashflow-adjustments and ledger-reclass have their own
  // approve/reject endpoints under /cashflow-adjustments/:id/approve
  // and /ledger-reclass/:id/approve respectively. They are NOT queued
  // through this unified Acc_ApprovalRequest collection — they live in
  // their own collections and use orgAuth + role checks directly.
  // If you want a single unified queue UI later, the simplest path is
  // to write a thin "show me everything pending" endpoint that fans
  // out reads to all three collections; the writes stay specialised.
  //
  //   if (kind === "ledger" && action === "update") {
  //     await Acc_Ledger.findByIdAndUpdate(target.id, payload);
  //     return { entityId: target.id };
  //   }
  //
  //   if (kind === "customer" && action === "delete") { … }
  //
  //   if (kind === "setting" && action === "update") { … }

  throw new Error(`No executor for kind=${kind} action=${action}`);
}

// ─────────────────────────────────────────────────────────────────────────
// GET / — list (with filters)
// ─────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const {
      status = "pending",
      kind,
      requestedBy,
      limit = 50,
      page = 1,
    } = req.query;
    const filter = { ...orgFilter(req) };
    if (status && status !== "all") filter.status = status;
    if (kind) filter.kind = kind;
    if (requestedBy) filter.requestedBy = requestedBy;

    const skip = (Number(page) - 1) * Number(limit);
    const [items, total, pendingCount] = await Promise.all([
      Acc_ApprovalRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Acc_ApprovalRequest.countDocuments(filter),
      Acc_ApprovalRequest.countDocuments({
        ...orgFilter(req),
        status: "pending",
      }),
    ]);

    res.json({
      success: true,
      items,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / limit) || 1,
      },
      pendingCount,
    });
  } catch (e) {
    console.error("[approvals] list:", e);
    res
      .status(500)
      .json({ success: false, message: "Failed to list approvals" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /:id — full detail
// ─────────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const item = await Acc_ApprovalRequest.findOne({
      _id: req.params.id,
      ...orgFilter(req),
    }).lean();
    if (!item)
      return res
        .status(404)
        .json({ success: false, message: "Approval request not found" });
    res.json({ success: true, item });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/approve  — approve and execute (approver/owner only)
// ─────────────────────────────────────────────────────────────────────────
router.post(
  "/:id/approve",
  requirePermission("canApprove"),
  async (req, res) => {
    try {
      const item = await Acc_ApprovalRequest.findOne({
        _id: req.params.id,
        ...orgFilter(req),
      });
      if (!item)
        return res
          .status(404)
          .json({ success: false, message: "Approval request not found" });
      if (item.status !== "pending") {
        return res
          .status(400)
          .json({ success: false, message: `Already ${item.status}` });
      }

      // Prevent approving your own request — basic 4-eyes rule. Owner exempt
      // (only one owner in the org, so 4-eyes would deadlock).
      if (
        req.user.role !== "owner" &&
        String(item.requestedBy) === String(req.user.id)
      ) {
        return res.status(403).json({
          success: false,
          message:
            "You cannot approve your own request. Ask another approver or the owner.",
        });
      }

      // Execute
      let result;
      try {
        result = await applyApprovedAction(item, req.user);
      } catch (e) {
        console.error("[approvals] execution failed:", e);
        return res
          .status(400)
          .json({ success: false, message: `Execution failed: ${e.message}` });
      }

      item.status = "approved";
      item.reviewedBy = req.user.id;
      item.reviewedByName = req.user.name;
      item.reviewedAt = new Date();
      item.reviewNote = req.body?.note || "";
      if (result?.entityId) item.appliedResultId = result.entityId;
      await item.save();

      res.json({ success: true, item, result });
    } catch (e) {
      console.error("[approvals] approve:", e);
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/reject — reject with reason
// ─────────────────────────────────────────────────────────────────────────
router.post(
  "/:id/reject",
  requirePermission("canApprove"),
  async (req, res) => {
    try {
      const item = await Acc_ApprovalRequest.findOne({
        _id: req.params.id,
        ...orgFilter(req),
      });
      if (!item)
        return res
          .status(404)
          .json({ success: false, message: "Approval request not found" });
      if (item.status !== "pending")
        return res
          .status(400)
          .json({ success: false, message: `Already ${item.status}` });

      item.status = "rejected";
      item.reviewedBy = req.user.id;
      item.reviewedByName = req.user.name;
      item.reviewedAt = new Date();
      item.reviewNote = req.body?.note || "";
      await item.save();

      // If the rejected request was a "voucher post" on a draft voucher, leave
      // the draft as-is (the editor can fix and resubmit). If it was a
      // "voucher create" with the entity already saved as pending_approval,
      // mark it cancelled.
      if (item.kind === "voucher" && item.target?.id) {
        const v = await Acc_Voucher.findById(item.target.id);
        if (v && v.status === "pending_approval") {
          v.status = "cancelled";
          await v.save();
        }
      }

      res.json({ success: true, item });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/cancel — requester withdraws their own request
// ─────────────────────────────────────────────────────────────────────────
router.post("/:id/cancel", async (req, res) => {
  try {
    const item = await Acc_ApprovalRequest.findOne({
      _id: req.params.id,
      ...orgFilter(req),
    });
    if (!item)
      return res
        .status(404)
        .json({ success: false, message: "Approval request not found" });
    if (item.status !== "pending")
      return res
        .status(400)
        .json({ success: false, message: `Already ${item.status}` });
    if (
      String(item.requestedBy) !== String(req.user.id) &&
      req.user.role !== "owner"
    ) {
      return res.status(403).json({
        success: false,
        message: "Only the requester or the owner can cancel",
      });
    }
    item.status = "cancelled";
    item.reviewedAt = new Date();
    await item.save();

    // Mirror cleanup if applicable
    if (item.kind === "voucher" && item.target?.id) {
      const v = await Acc_Voucher.findById(item.target.id);
      if (v && v.status === "pending_approval") {
        v.status = "cancelled";
        await v.save();
      }
    }
    res.json({ success: true, item });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Helper exported for use by routes that submit-for-approval. Routes call
// this instead of doing the action directly when the user lacks the
// privilege. Returns the created Acc_ApprovalRequest.
// ─────────────────────────────────────────────────────────────────────────
async function createApprovalRequest({
  req,
  kind,
  action,
  title,
  target,
  payload,
  diff,
  companyId,
}) {
  if (req.user.isLegacy || req.user.isDev) {
    throw new Error("Cannot create approval requests in legacy/dev sessions");
  }
  return Acc_ApprovalRequest.create({
    organizationId: req.user.organizationId,
    companyId,
    kind,
    action,
    title,
    target,
    payload,
    diff,
    requestedBy: req.user.id,
    requestedByName: req.user.name,
    status: "pending",
  });
}

module.exports = router;
module.exports.createApprovalRequest = createApprovalRequest;
