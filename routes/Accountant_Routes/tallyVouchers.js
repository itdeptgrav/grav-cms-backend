/**
 * Tally Voucher Routes
 * Handles all voucher types (sales, purchase, receipt, payment, contra, journal, credit_note, debit_note, etc.)
 * - Auto-numbering per FY per voucher type
 * - Status transitions: draft → posted → cancelled/void
 * - Updates ledger balances atomically on post
 * - Filtering by type, party, date range, status
 */

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const {
  TallyVoucher,
} = require("../../models/Accountant_model/TallyVoucherModels");
const {
  TallyLedger,
} = require("../../models/Accountant_model/TallyMasterModels");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const {
  orgAuth,
  requirePermission,
} = require("../../Middlewear/AccountantOrgAuthMiddleware");
const { createApprovalRequest } = require("./approvalRoutes");

// Use orgAuth — it gracefully handles legacy tokens too (sees them as
// owner-equivalent with isLegacy=true and skips role enforcement).
const auth = orgAuth;

const VOUCHER_TYPES = [
  "sales",
  "purchase",
  "receipt",
  "payment",
  "contra",
  "journal",
  "credit_note",
  "debit_note",
  "stock_journal",
  "delivery_note",
  "receipt_note",
  "rejection_in",
  "rejection_out",
  "memo",
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function computeFY(dateInput) {
  const d = new Date(dateInput);
  const m = d.getMonth();
  const y = d.getFullYear();
  // India FY April-March
  return m >= 3
    ? `${y}-${String((y + 1) % 100).padStart(2, "0")}`
    : `${y - 1}-${String(y % 100).padStart(2, "0")}`;
}

/**
 * Apply ledger balance updates from a voucher's ledger entries.
 * direction = +1 for posting, -1 for cancelling/voiding
 */
async function applyLedgerBalances(voucher, direction = 1, session = null) {
  const ops = [];
  for (const entry of voucher.ledgerEntries) {
    const delta = (entry.signedAmount || 0) * direction;
    ops.push({
      updateOne: {
        filter: { _id: entry.ledgerId },
        update: { $inc: { currentBalance: delta } },
      },
    });
  }
  if (ops.length) {
    await TallyLedger.bulkWrite(ops, { session });
  }
  // Refresh currentBalanceType per ledger touched
  for (const entry of voucher.ledgerEntries) {
    const led = await TallyLedger.findById(entry.ledgerId).session(session);
    if (led) {
      led.currentBalanceType = led.currentBalance >= 0 ? "Dr" : "Cr";
      await led.save({ session });
    }
  }
}

/* ------------------------------------------------------------------ */
/* List & filter                                                       */
/* ------------------------------------------------------------------ */

router.get("/", auth, async (req, res) => {
  try {
    const {
      companyId,
      voucherType,
      party,
      status,
      dateFrom,
      dateTo,
      q,
      page = 1,
      limit = 50,
      sort = "-voucherDate",
    } = req.query;

    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    const filter = { companyId };
    if (voucherType) filter.voucherType = voucherType;
    if (status) filter.status = status;
    if (party) filter.partyLedgerId = party;
    if (dateFrom || dateTo) {
      filter.voucherDate = {};
      if (dateFrom) filter.voucherDate.$gte = new Date(dateFrom);
      if (dateTo) filter.voucherDate.$lte = new Date(dateTo);
    }
    if (q) {
      filter.$or = [
        { voucherNumber: new RegExp(q, "i") },
        { narration: new RegExp(q, "i") },
        { partyLedgerName: new RegExp(q, "i") },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [items, total] = await Promise.all([
      TallyVoucher.find(filter)
        .populate("partyLedgerId", "name groupName")
        .sort(sort)
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      TallyVoucher.countDocuments(filter),
    ]);

    res.json({
      items,
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / Number(limit)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Cash & bank ledgers for a company (used by the Contra voucher form)  */
/* ------------------------------------------------------------------ */
// Returns ledgers belonging to Cash-in-Hand, Bank Accounts, or Bank OD A/c
// — i.e. the only valid endpoints for a contra voucher.
//
// Resolution strategy (robust to sub-grouping):
//   1. Find the three reserved groups by name for this company.
//   2. Walk their descendant tree (sub-groups, sub-sub-groups, …) so that
//      user-created groups like "Petty Cash" (under Cash-in-Hand) or
//      "HDFC Current" (under Bank Accounts) are picked up too.
//   3. Pull all ledgers whose groupId is in that descendant set.
//   4. As a backup, also include any ledger whose denormalised groupName
//      exactly matches one of the three names — covers edge cases where
//      a ledger was imported with a groupName that doesn't resolve via
//      the group hierarchy (rare but happens with Tally XML imports).

const {
  TallyGroup,
} = require("../../models/Accountant_model/TallyMasterModels");

router.get("/cash-bank-ledgers", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    const ROOT_NAMES = ["Cash-in-Hand", "Bank Accounts", "Bank OD A/c"];

    // 1. Find the root groups for this company
    const roots = await TallyGroup.find({
      companyId,
      name: { $in: ROOT_NAMES },
    })
      .select("_id name")
      .lean();

    // 2. Walk down the tree to collect all descendant group IDs
    const allGroupIds = new Set(roots.map((g) => String(g._id)));
    let frontier = roots.map((g) => g._id);
    let safety = 10; // hierarchy guard against accidental cycles
    while (frontier.length > 0 && safety-- > 0) {
      const children = await TallyGroup.find({
        companyId,
        parent: { $in: frontier },
      })
        .select("_id")
        .lean();
      if (children.length === 0) break;
      frontier = [];
      for (const c of children) {
        const id = String(c._id);
        if (!allGroupIds.has(id)) {
          allGroupIds.add(id);
          frontier.push(c._id);
        }
      }
    }

    // 3. Find ledgers under any of those groups OR with the exact groupName
    //    (the OR-fallback covers imported ledgers whose groupName denormalised
    //    string matches even if the groupId resolution path is broken)
    const groupIdArr = Array.from(allGroupIds).map(
      (id) => new mongoose.Types.ObjectId(id),
    );

    const ledgers = await TallyLedger.find({
      companyId,
      isActive: true,
      $or: [
        { groupId: { $in: groupIdArr } },
        { groupName: { $in: ROOT_NAMES } },
      ],
    })
      .select(
        "name groupName groupId currentBalance currentBalanceType openingBalance nature",
      )
      .sort({ groupName: 1, name: 1 })
      .lean();

    // Diagnostic in server logs when nothing's found — helps trace setup issues
    if (ledgers.length === 0) {
      console.warn(
        `[contra/cash-bank-ledgers] No ledgers for company ${companyId}. ` +
          `Roots found: ${roots.length} (${roots.map((r) => r.name).join(", ") || "none"}). ` +
          `Descendant groups: ${allGroupIds.size}. ` +
          `Likely cause: ledgers exist but their groupName/groupId doesn't point to a cash/bank group.`,
      );
    }

    res.json({
      success: true,
      ledgers,
      // Diagnostic block — frontend can show this when empty for easier debugging
      _diagnostic: {
        companyId,
        rootGroupsFound: roots.map((r) => ({ id: r._id, name: r.name })),
        descendantGroupCount: allGroupIds.size,
        ledgerCount: ledgers.length,
      },
    });
  } catch (e) {
    console.error("Error in /cash-bank-ledgers:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Get next voucher number (used by frontend on form open)             */
/* ------------------------------------------------------------------ */
// IMPORTANT: declared BEFORE `/:id` so the path "next-number/..." isn't
// captured by the id-route's CastError.

router.get("/next-number/:companyId/:voucherType", auth, async (req, res) => {
  try {
    const { companyId, voucherType } = req.params;
    const { prefix } = req.query;
    const number = await TallyVoucher.nextVoucherNumber(
      companyId,
      voucherType,
      prefix,
    );
    res.json({ voucherNumber: number });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Get one                                                             */
/* ------------------------------------------------------------------ */

router.get("/:id", auth, async (req, res) => {
  try {
    const voucher = await TallyVoucher.findById(req.params.id)
      .populate("partyLedgerId", "name groupName gstin")
      .populate("ledgerEntries.ledgerId", "name groupName")
      .populate("inventoryEntries.stockItemId", "name unit hsnCode")
      .lean();
    if (!voucher) return res.status(404).json({ error: "Voucher not found" });
    res.json(voucher);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* (moved above /:id — see comment there)                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */
// Approval routing:
//   - Owner / Approver / legacy / dev users:
//     If autoPost=true and balanced → post directly (existing behaviour).
//     Else → save as draft.
//   - Editor users (org.settings.requireApprovalForVouchers=true):
//     If autoPost=true:
//       → save voucher as `pending_approval`
//       → create ApprovalRequest (kind="voucher", action="post")
//       → return the voucher + the approval request so the UI can show
//         "awaiting approval" instead of "posted".
//     If autoPost=false → save as draft (same as everyone else).
//   - Viewer users: 403 (cannot create at all).

router.post("/", auth, async (req, res) => {
  try {
    if (req.user?.permissions && !req.user.permissions.canEdit) {
      return res
        .status(403)
        .json({ error: "Your role does not allow creating vouchers" });
    }

    const body = req.body || {};
    if (!body.companyId)
      return res.status(400).json({ error: "companyId required" });
    if (!body.voucherType || !VOUCHER_TYPES.includes(body.voucherType))
      return res.status(400).json({ error: "Valid voucherType required" });
    if (!body.voucherDate)
      return res.status(400).json({ error: "voucherDate required" });
    if (!Array.isArray(body.ledgerEntries) || body.ledgerEntries.length === 0)
      return res
        .status(400)
        .json({ error: "At least one ledger entry required" });

    // Auto-number if not provided
    if (!body.voucherNumber) {
      body.voucherNumber = await TallyVoucher.nextVoucherNumber(
        body.companyId,
        body.voucherType,
        body.prefix,
      );
    }

    body.financialYear = computeFY(body.voucherDate);
    body.createdBy = req.user?.id;

    // Resolve partyLedgerName if missing
    if (body.partyLedgerId && !body.partyLedgerName) {
      const led = await TallyLedger.findById(body.partyLedgerId).select("name");
      if (led) body.partyLedgerName = led.name;
    }

    // Resolve ledger names
    for (const entry of body.ledgerEntries) {
      if (entry.ledgerId && !entry.ledgerName) {
        const led = await TallyLedger.findById(entry.ledgerId).select("name");
        if (led) entry.ledgerName = led.name;
      }
    }

    // Decide the path: direct-post / pending-approval / draft
    const wantsPost = !!body.autoPost;
    const needsApproval =
      wantsPost &&
      req.user?.permissions &&
      !req.user.permissions.canPostDirectly &&
      req.organization?.settings?.requireApprovalForVouchers !== false;

    // Save the voucher (status depends on path)
    const voucher = new TallyVoucher({
      ...body,
      status: needsApproval ? "pending_approval" : "draft",
    });
    await voucher.save();

    // Path A — direct post
    if (wantsPost && !needsApproval && voucher.isBalanced) {
      voucher.status = "posted";
      await voucher.save();
      await applyLedgerBalances(voucher, +1);
      return res.status(201).json(voucher);
    }

    // Path B — needs approval (Editor + autoPost)
    if (needsApproval) {
      let approvalRequest = null;
      try {
        approvalRequest = await createApprovalRequest({
          req,
          kind: "voucher",
          action: "post",
          title: `Post ${body.voucherType} voucher ${voucher.voucherNumber} · ${formatGrand(voucher)}`,
          target: { collection: "TallyVoucher", id: voucher._id },
          payload: null,
          companyId: voucher.companyId,
        });
      } catch (e) {
        // If approval-request creation fails (e.g. legacy session), fall
        // back to leaving the voucher as a draft so nothing is lost.
        console.warn("[vouchers] couldn't create approval request:", e.message);
        voucher.status = "draft";
        await voucher.save();
      }
      return res.status(201).json({
        ...voucher.toObject(),
        approvalRequestId: approvalRequest?._id,
        _meta: { needsApproval: true, message: "Submitted for approval" },
      });
    }

    // Path C — plain draft
    res.status(201).json(voucher);
  } catch (e) {
    console.error("[vouchers] create error:", e);
    res.status(400).json({ error: e.message });
  }
});

// Helper for the approval title — robust to missing fields
function formatGrand(voucher) {
  const v = Number(voucher.grandTotal || voucher.totalDebit || 0);
  if (!v) return "(unbalanced)";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(v);
}

/* ------------------------------------------------------------------ */
/* Update (only if draft)                                              */
/* ------------------------------------------------------------------ */

router.put("/:id", auth, async (req, res) => {
  try {
    const existing = await TallyVoucher.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Voucher not found" });
    if (existing.status !== "draft")
      return res.status(400).json({
        error: `Cannot edit voucher in '${existing.status}' status. Cancel and create new.`,
      });

    const body = req.body || {};
    body.updatedBy = req.user?.id;
    if (body.voucherDate) body.financialYear = computeFY(body.voucherDate);

    Object.assign(existing, body);
    await existing.save();
    res.json(existing);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Status transitions                                                  */
/* ------------------------------------------------------------------ */

router.post("/:id/post", auth, async (req, res) => {
  // Editor without canPostDirectly → submit for approval, don't post
  if (
    req.user?.permissions &&
    !req.user.permissions.canPostDirectly &&
    req.organization?.settings?.requireApprovalForVouchers !== false
  ) {
    try {
      const voucher = await TallyVoucher.findById(req.params.id);
      if (!voucher) return res.status(404).json({ error: "Voucher not found" });
      if (voucher.status !== "draft") {
        return res.status(400).json({
          error: `Voucher is ${voucher.status} — cannot submit for approval`,
        });
      }
      if (!voucher.isBalanced) {
        return res.status(400).json({
          error: "Dr/Cr totals don't balance — fix before submitting",
        });
      }
      voucher.status = "pending_approval";
      voucher.updatedBy = req.user.id;
      await voucher.save();
      const ar = await createApprovalRequest({
        req,
        kind: "voucher",
        action: "post",
        title: `Post ${voucher.voucherType} voucher ${voucher.voucherNumber} · ${formatGrand(voucher)}`,
        target: { collection: "TallyVoucher", id: voucher._id },
        companyId: voucher.companyId,
      });
      return res.json({
        ...voucher.toObject(),
        approvalRequestId: ar._id,
        _meta: { needsApproval: true, message: "Submitted for approval" },
      });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  // Owner / Approver / legacy → direct post
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const voucher = await TallyVoucher.findById(req.params.id).session(session);
    if (!voucher) throw new Error("Voucher not found");
    if (voucher.status !== "draft")
      throw new Error(`Voucher already ${voucher.status}`);
    if (!voucher.isBalanced)
      throw new Error("Voucher Dr/Cr totals do not balance — cannot post");

    voucher.status = "posted";
    voucher.updatedBy = req.user?.id;
    await voucher.save({ session });
    await applyLedgerBalances(voucher, +1, session);

    await session.commitTransaction();
    res.json(voucher);
  } catch (e) {
    await session.abortTransaction();
    res.status(400).json({ error: e.message });
  } finally {
    session.endSession();
  }
});

router.post("/:id/cancel", auth, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const voucher = await TallyVoucher.findById(req.params.id).session(session);
    if (!voucher) throw new Error("Voucher not found");
    if (!["posted", "draft"].includes(voucher.status))
      throw new Error(`Cannot cancel voucher in '${voucher.status}' status`);

    if (voucher.status === "posted") {
      await applyLedgerBalances(voucher, -1, session);
    }
    voucher.status = "cancelled";
    voucher.updatedBy = req.user?.id;
    await voucher.save({ session });

    await session.commitTransaction();
    res.json(voucher);
  } catch (e) {
    await session.abortTransaction();
    res.status(400).json({ error: e.message });
  } finally {
    session.endSession();
  }
});

router.post("/:id/void", auth, async (req, res) => {
  try {
    const voucher = await TallyVoucher.findById(req.params.id);
    if (!voucher) return res.status(404).json({ error: "Voucher not found" });
    if (voucher.status === "posted") {
      await applyLedgerBalances(voucher, -1);
    }
    voucher.status = "void";
    voucher.updatedBy = req.user?.id;
    await voucher.save();
    res.json(voucher);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Delete (only drafts can be hard-deleted)                            */
/* ------------------------------------------------------------------ */

router.delete("/:id", auth, async (req, res) => {
  try {
    const voucher = await TallyVoucher.findById(req.params.id);
    if (!voucher) return res.status(404).json({ error: "Voucher not found" });
    if (voucher.status !== "draft")
      return res.status(400).json({
        error:
          "Only draft vouchers can be deleted. Use cancel/void for posted.",
      });
    await voucher.deleteOne();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Bulk summary by type for a date range — for dashboards              */
/* ------------------------------------------------------------------ */

router.get("/summary/by-type", auth, async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    const match = {
      companyId: new mongoose.Types.ObjectId(companyId),
      status: "posted",
    };
    if (dateFrom || dateTo) {
      match.voucherDate = {};
      if (dateFrom) match.voucherDate.$gte = new Date(dateFrom);
      if (dateTo) match.voucherDate.$lte = new Date(dateTo);
    }

    const summary = await TallyVoucher.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$voucherType",
          count: { $sum: 1 },
          totalDebit: { $sum: "$totalDebit" },
          totalCredit: { $sum: "$totalCredit" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({ summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
