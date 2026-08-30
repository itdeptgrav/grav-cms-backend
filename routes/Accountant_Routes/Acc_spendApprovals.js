// routes/Accountant_Routes/Acc_spendApprovals.js
//
// PAYABLES → SPEND APPROVALS — the operational spend waiting on finance.
//
// ── WHY THIS IS NOT IN BUDGETS ──────────────────────────────────────────────
// Budgets → Department submissions is where a department argues for its ANNUAL
// ENVELOPE: a planning conversation that happens once a year, in March, about
// money nobody has spent yet. This queue is the opposite — one purchase, priced
// by Store against a vendor, that will become a payable the moment finance
// agrees. Putting the two in one screen would mix "what should Logistics get
// next year" with "do we pay Sharma Engineering ₹2,950 for blades", and the
// person answering them is doing two different jobs.
//
// They were never actually mixed — a budget proposal is a row inside
// `Acc_Budget.budgetRequests[]` and this is a `SpendRequest`, two different
// collections that no accountant route read together. What was missing was
// anywhere in the BOOKS to answer this at all: finance could only approve from
// the Requests app, which is a CMS employee screen, not an accounting one.
//
// ── THE SAME DECISION, FROM THE OTHER SIDE ──────────────────────────────────
// Approving here is identical to approving on the Requests desk — the same
// pricing gate, the same budget commitment, the same record. That is enforced
// rather than intended: both doors call
// `services/spendFinanceDecision.service.js`, and there is no second copy of
// the rule to drift.
//
// ── WHAT THIS QUEUE IS NOT ──────────────────────────────────────────────────
// It is not the maker-checker queue in `Acc_approvals.js`. That one reviews
// changes to VOUCHERS — post this, void that — and its unit of work is an
// `Acc_ApprovalRequest` carrying a payload to execute. This one reviews a
// commercial ask before any voucher exists. Different object, different
// lifecycle, deliberately separate.

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");

const chain = require("../../services/spendApproval.service");
const fulfilment = require("../../services/storeFulfilment.service");
const financeDecision = require("../../services/spendFinanceDecision.service");
const budgetMatch = require("../../services/budgetCommitment.service");

const {
  orgAuth,
  requirePermission,
} = require("../../Middlewear/AccountantOrgAuthMiddleware");

router.use(orgAuth);

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/**
 * May this accounting user answer a spend request?
 *
 * The same question `spendApproval.isFinanceApprover` asks on the other door,
 * asked of the identity THIS door authenticates. An editor is deliberately not
 * finance: entering vouchers is not the same as agreeing to spend, and the
 * accounting module already draws that line for its own writes.
 */
const isApprover = (user) => ["owner", "approver"].includes(String(user?.role || ""));

/**
 * What a screen is allowed to see. Deliberately not the raw document — a spend
 * request carries a vendor, a quote and internal notes.
 */
const listRow = (r) => ({
  _id: String(r._id),
  requestNumber: r.requestNumber,
  /* The material request this is the balance of, when there is one. It is the
     number the store and the requester are both quoting. */
  sourceMrfNumber: r.sourceMrfNumber || null,
  title: r.title,
  requestedByName: r.requestedByName || "",
  department: r.department || "",
  vendorName: r.vendorName || null,
  requestType: r.requestType,
  requestTypeLabel: SpendRequest.REQUEST_TYPE_LABEL[r.requestType] || "Service",
  ledgerName: r.ledgerName || null,
  unbudgetedHeadRequest: Boolean(r.unbudgetedHeadRequest),
  budgetMatchStatus: r.budgetMatchStatus || "no_budget_line",
  /* ── WHETHER THE PERSON WHO ASKED HAS SEEN WHAT STORE FOUND ──────────────
     Finance approves a figure against a head; they are not equipped to notice
     that Store sourced the wrong model, and it is not their job to. So the
     confirmation is stated on the card, and the decision service refuses an
     approval without it. */
  requesterConfirmedAt: r.requesterConfirmedAt || null,
  requesterConfirmedByName: r.requesterConfirmedByName || null,
  /* Net, tax and what will actually leave the bank. All three, because the
     figure finance is agreeing to is the last one and the other two are how it
     got there. */
  totalAmount: money(r.totalAmount),
  taxAmount: money(r.taxAmount),
  grandTotal: money(r.grandTotal || r.totalAmount),
  gstPercent: r.gstPercent || 0,
  expectedDeliveryDate: r.expectedDeliveryDate || null,
  neededBy: r.neededBy || null,
  priority: r.priority || "NORMAL",
  status: r.status,
  statusLabel: chain.STAGE_LABEL[r.status] || r.status,
  /* Whether it can be approved at all, decided on the server so the list and
     the detail page cannot disagree about it. */
  priced: fulfilment.pricingGate(r).ok,
  submittedAt: r.submittedAt || r.createdAt,
  createdAt: r.createdAt,
});

/* ══ THE QUEUE ══════════════════════════════════════════════════════════════
 * What is waiting on finance. Newest last, because this is a queue somebody
 * works down rather than a feed they scan.
 */
router.get("/", async (req, res) => {
  try {
    const filter = { status: chain.PENDING_FINANCE };

    /* Company scoping, when the books have more than one set. A request
       carries the company it was raised against; one that carries none is
       from before the field existed and is shown rather than hidden — hiding
       a payable is worse than showing an unscoped one. */
    if (req.query.companyId && mongoose.isValidObjectId(req.query.companyId)) {
      filter.$or = [
        { companyId: req.query.companyId },
        { companyId: { $exists: false } },
        { companyId: null },
      ];
    }
    if (req.query.department) filter.department = String(req.query.department);

    const rows = await SpendRequest.find(filter)
      .sort({ submittedAt: 1, createdAt: 1 })
      .limit(200)
      .lean();

    const requests = rows.map(listRow);
    res.json({
      success: true,
      requests,
      counts: {
        total: requests.length,
        /* Split out because they are different jobs: one is a decision, the
           other is a request to Store for a number. */
        priced: requests.filter((r) => r.priced).length,
        unpriced: requests.filter((r) => !r.priced).length,
        payable: money(requests.reduce((s, r) => s + (r.priced ? r.grandTotal : 0), 0)),
      },
      canApprove: isApprover(req.user),
    });
  } catch (e) {
    console.error("[spend-approvals] list:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ══ ONE REQUEST, IN FULL ═══════════════════════════════════════════════════
 * Three blocks, because three different people wrote them and finance is
 * weighing one against the others:
 *
 *   the ask       who needed it, why, and by when — the department's words
 *   the pricing   vendor, lines, rate, tax, delivery — Store's commercial work
 *   the position  what the head holds, LIVE, and what this would leave
 *
 * The budget position is read fresh rather than taken from the snapshot on the
 * request. The snapshot is a record of what Store was looking at when they
 * priced it; finance is deciding now, and the envelope has moved since.
 */
router.get("/:id", async (req, res) => {
  try {
    const doc = await SpendRequest.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ success: false, message: "Request not found." });

    const requester = await Employee.findById(doc.requestedBy)
      .select("firstName middleName lastName email designation department")
      .lean();

    /* ── THE HEAD, AS IT STANDS NOW ─────────────────────────────────────── */
    let position = null;
    if (doc.ledgerId && doc.companyId) {
      try {
        const { heads } = await budgetMatch.approvedHeadsFor({
          companyId: doc.companyId,
          department: doc.budgetDepartment || doc.department || "",
        });
        const head = heads.find((h) => String(h.ledgerId) === String(doc.ledgerId));
        if (head) {
          const requested = money(doc.grandTotal || doc.totalAmount);
          position = {
            ledgerName: head.name,
            financialYear: head.financialYear,
            department: head.department,
            approved: head.approved,
            actual: head.actual,
            committed: head.committed,
            availableBefore: head.available,
            requested,
            /* What approving this would leave. Negative is allowed and is not
               a refusal — finance may always say yes; it goes on the record as
               over budget, which is the distinction that matters when somebody
               later asks how the year went over. */
            availableAfter: money(head.available - requested),
            /* The overrun, named as a positive number, or zero. Derived here
               so every screen reads the same figure — and so the requester's
               "exceeds your budget by X" and finance's warning can never be
               two different numbers. */
            overrun: head.available - requested < 0 ? money(requested - head.available) : 0,
          };

          /* ── AND THE ROW OF THE PLAN, WHERE THE REQUEST NAMED ONE ────────
             The head is the accounting bucket; this is what finance actually
             agreed to inside it. A request that fits the head can still be
             three times the row it claims to be against.

             ── WHY `committed` HERE IS NOT THE HEAD'S ──────────────────────
             There is no planned-item-level actuals tracking: vouchers post to
             a LEDGER and carry no row reference, so nothing can attribute a
             payment back to "Claude" rather than to "Software Subscriptions".
             Rather than divide the head's actual by something and call it
             precision, this counts only what THIS system knows for certain —
             commitments raised by other requests naming the same row. `actual`
             is deliberately absent, not zero: absent is honest, zero is a
             claim that nothing has been spent. */
          if (doc.plannedItemKey) {
            const siblings = await SpendRequest.find({
              plannedItemKey: doc.plannedItemKey,
              budgetLineId: doc.budgetLineId,
              _id: { $ne: doc._id },
              status: { $in: ["approved", "ordered"] },
            })
              .select("grandTotal totalAmount")
              .lean()
              .catch(() => []);
            const committedElsewhere = money(
              (siblings || []).reduce(
                (t, x) => t + (Number(x.grandTotal || x.totalAmount) || 0),
                0,
              ),
            );
            const planned = money(doc.plannedItemAmount);
            position.plannedItem = {
              key: doc.plannedItemKey,
              name: doc.plannedItemName || null,
              /* What was approved for the row when the request was raised. */
              approved: planned,
              committedElsewhere,
              requested,
              remaining:
                planned === null ? null : money(planned - committedElsewhere - requested),
              /* Said out loud so the screen never presents a partial figure as
                 a complete one. */
              actualTracked: false,
            };
          }
        }
      } catch (e) {
        /* A budget read that fails must not stop finance seeing the request.
           The screen shows the ask and the pricing without the position. */
        console.error("[spend-approvals] budget position failed:", e.message);
      }
    }

    const priced = fulfilment.pricingGate(doc);

    res.json({
      success: true,
      request: {
        ...listRow(doc),
        purpose: doc.purpose,
        gstin: doc.gstin || null,
        /* ── THE DEPARTMENT'S ASK ──────────────────────────────────────── */
        ask: {
          requestedByName: doc.requestedByName || "",
          requestedByEmail: requester?.email || null,
          designation: requester?.designation || null,
          department: doc.department || "",
          purpose: doc.purpose,
          neededBy: doc.neededBy || null,
          priority: doc.priority || "NORMAL",
          sourceMrfNumber: doc.sourceMrfNumber || null,
          tlApprovedByName: doc.tlApprovedByName || null,
          tlApprovedAt: doc.tlApprovedAt || null,
        },
        /* ── WHAT STORE PRICED IT AT ───────────────────────────────────── */
        pricing: {
          vendorName: doc.vendorName || null,
          gstin: doc.gstin || null,
          gstPercent: doc.gstPercent || 0,
          subtotal: money(doc.totalAmount),
          taxAmount: money(doc.taxAmount),
          grandTotal: money(doc.grandTotal || doc.totalAmount),
          expectedDeliveryDate: doc.expectedDeliveryDate || null,
          pricedByName: doc.pricedByName || null,
          pricedAt: doc.pricedAt || null,
          lines: (doc.items || []).map((l) => ({
            _id: String(l._id),
            name: l.name,
            whyNeeded: l.whyNeeded,
            quantity: l.quantity,
            unit: l.unit,
            rate: money(l.rate),
            amount: money(l.amount),
          })),
        },
        position,
        /* Said once, on the server, so the list, the detail and the button all
           agree about whether this can be approved. */
        priced: priced.ok,
        pricingMessage: priced.ok ? null : priced.reason,
        requestedHeadName: doc.requestedHeadName || null,
        requestedHeadReason: doc.requestedHeadReason || null,
        attachments: (doc.attachments || []).map((a) => ({
          fileId: a.fileId,
          fileName: a.fileName || "attachment",
          label: a.label || "other",
        })),
        history: (doc.history || []).map((h) => ({
          at: h.at, byName: h.byName || "", action: h.action || "", note: h.note || "",
        })),
      },
      canApprove: isApprover(req.user),
    });
  } catch (e) {
    console.error("[spend-approvals] detail:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ══ THE DECISION ═══════════════════════════════════════════════════════════
 * `requirePermission("canEdit")` is the module's own write gate; the role check
 * on top of it is the money one. Both, because they answer different
 * questions: whether this session may write at all, and whether this PERSON is
 * one of the people who may agree to spend.
 */
async function answer(req, res, outcome) {
  if (!isApprover(req.user)) {
    return res.status(403).json({
      success: false,
      message: `Agreeing to spend is an owner's or an approver's call. You are: ${req.user?.role || "unknown"}.`,
    });
  }

  const doc = await SpendRequest.findById(req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Request not found." });

  /* Nobody answers their own. The two doors identify people differently — this
     one has an email and no employee record — so the match is on the address,
     which is the only thing an accounting user and a CMS employee share. */
  if (req.user?.email && doc.requestedBy) {
    const requester = await Employee.findById(doc.requestedBy).select("email").lean();
    if (
      requester?.email &&
      String(requester.email).toLowerCase() === String(req.user.email).toLowerCase()
    ) {
      return res.status(403).json({
        success: false,
        message: "You cannot approve your own request.",
      });
    }
  }

  const r = await financeDecision.decide({
    request: doc,
    actor: { id: req.user?.id, email: req.user?.email, name: req.user?.name || "Finance" },
    outcome,
    note: String(req.body?.note || "").trim().slice(0, 500),
    expectedPaymentDate: req.body?.expectedPaymentDate || null,
  });
  if (!r.ok) {
    return res.status(r.status).json({ success: false, code: r.code, message: r.message });
  }

  res.json({
    success: true,
    request: listRow(doc.toObject()),
    message:
      outcome === "rejected"
        ? `${doc.requestNumber} rejected.`
        : `${doc.requestNumber} approved — the money is committed against ${doc.ledgerName || "the head"}.`,
  });
}

/* ══ OVER BUDGET, BACK TO THE REQUESTER ═════════════════════════════════════
 * Finance's third answer, and the one the flow was missing.
 *
 * ── WHY NOT JUST REJECT IT ──────────────────────────────────────────────────
 * A rejection says no to the need. This says nothing about the need and
 * nothing about the quote — both may be perfectly good — it says the figure
 * does not fit the head it is charged to. The requester is the only person who
 * can resolve that: they can trim what they asked for, move it to another head
 * their department has budget on, ask for more budget, or decide it can wait.
 * A rejection offers none of those; it just ends the request and invites an
 * identical one next week.
 *
 * ── AND WHY STORE IS NOT IN THIS LOOP ───────────────────────────────────────
 * Store priced a quote. Whether the department can afford it is not their
 * question, and sending it back to them would ask them to trim a quote to fit
 * an envelope they cannot see and do not manage.
 *
 * Approval is never BLOCKED by an overrun. Finance may always say yes; this is
 * an alternative to approving, not a gate in front of it.
 */
router.post("/:id/budget-exception", requirePermission("canEdit"), async (req, res) => {
  try {
    if (!isApprover(req.user)) {
      return res.status(403).json({
        success: false,
        message: `Raising a budget exception is an owner's or an approver's call. You are: ${req.user?.role || "unknown"}.`,
      });
    }

    const doc = await SpendRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Request not found." });

    if (!chain.OPEN_STATUSES.includes(doc.status)) {
      return res.status(409).json({
        success: false,
        message: `This request is ${chain.STAGE_LABEL[doc.status] || doc.status}, so it cannot be sent back.`,
      });
    }

    const note = String(req.body?.note || "").trim().slice(0, 500);
    if (!note) {
      return res.status(400).json({
        success: false,
        message: "Say what the requester needs to change. They see this, and it is the whole point of sending it back rather than rejecting it.",
      });
    }

    /* The overrun as it stands NOW, recorded on the document. The head moves —
       other requests commit against it every day — and a requester opening
       this next week has to see the figure finance objected to, not what the
       arithmetic says by then. */
    const requested = money(doc.grandTotal || doc.totalAmount);
    let available = null;
    if (doc.ledgerId && doc.companyId) {
      const { heads } = await budgetMatch
        .approvedHeadsFor({
          companyId: doc.companyId,
          department: doc.budgetDepartment || doc.department || "",
        })
        .catch(() => ({ heads: [] }));
      const head = (heads || []).find((h) => String(h.ledgerId) === String(doc.ledgerId));
      if (head) available = head.available;
    }

    const now = new Date();
    doc.status = chain.BUDGET_EXCEPTION;
    doc.budgetExceptionAt = now;
    doc.budgetExceptionByName = req.user?.name || "Finance";
    doc.budgetExceptionNote = note;
    doc.budgetExceptionAvailable = available;
    doc.budgetExceptionOverrun =
      available === null ? null : Math.max(0, money(requested - available));
    doc.history.push({
      at: now,
      byName: req.user?.name || "Finance",
      action: "sent back — over budget",
      note,
    });
    await doc.save();

    res.json({
      success: true,
      request: listRow(doc.toObject()),
      message: `${doc.requestNumber} is back with ${doc.requestedByName || "the requester"} as a budget exception.`,
    });
  } catch (e) {
    console.error("[spend-approvals] budget-exception:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post("/:id/approve", requirePermission("canEdit"), async (req, res) => {
  try {
    await answer(req, res, "approved");
  } catch (e) {
    console.error("[spend-approvals] approve:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post("/:id/reject", requirePermission("canEdit"), async (req, res) => {
  try {
    await answer(req, res, "rejected");
  } catch (e) {
    console.error("[spend-approvals] reject:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
