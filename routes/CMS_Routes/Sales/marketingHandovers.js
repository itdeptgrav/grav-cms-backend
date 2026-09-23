// routes/CMS_Routes/Sales/marketingHandovers.js
//   → mounted at /api/cms/sales/marketing-handovers
//
// THE SALES HANDOVER INBOX.
//
//   GET  /                        awaiting review by default
//   GET  /:handoverRef            one handover with its evidence and its
//                                 duplicate candidates
//   POST /:handoverRef/accept     take ownership; the Prospect stays a Prospect
//   POST /:handoverRef/return     send it back for nurture, with a reason
//   POST /:handoverRef/reject     dispose of it, with a reason
//   POST /:handoverRef/link-duplicate
//
// ── WHAT IS DELIBERATELY ABSENT ────────────────────────────────────────────
// No route here converts a Prospect to an Active Lead, changes a qualification
// state, or creates an Enquiry, a Journey or a quotation. Those already exist
// on the Lead routes and stay there: a marketing handover is not a second way
// to move the Sales lifecycle, and adding one here would have given the
// lifecycle a second writer.
//
// ── AUTHORISATION ──────────────────────────────────────────────────────────
// Any Sales user may answer a handover — the inbox is work, not an approval
// queue. Assigning it to SOMEBODY ELSE is a manager's act, exactly as it
// already is when a Lead is created with an owner other than the creator
// (routes/CMS_Routes/Sales/leads.js authorizeOwnerSourceChange).
"use strict";

const express = require("express");
const router = express.Router();

const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { scopeFor } = require("../../../services/companyContext/salesScope.service");
const { isSalesManager } = require("../../../services/salesAccess");
const { fail, sendError, handle } = require("../../../services/storePurchase/errors");
const { recordChange } = require("../../../services/changeLog");

const {
  MarketingHandoverReceipt,
} = require("../../../models/CMS_Models/Sales/MarketingProspectIntake");
const decisions = require("../../../services/sales/marketingHandoverDecision.service");
const outcomeDelivery = require("../../../services/integration/marketingOutcomeDelivery.service");
const acquisitionHold = require("../../../services/marketing/acquisitionHold.service");
const queue = require("../../../services/sales/handoverQueue.service");

const str = (v) => String(v ?? "").trim();
const actorOf = (req) => ({ id: req.user?.id, name: req.user?.name || "", email: req.user?.email || "" });

router.use(express.json());
router.use(salesAuth);

/**
 * GET /?state=awaiting|all|ACCEPTED|…&source=indiamart|marketing_campaign&order=newest|oldest&limit=
 *
 * The receipts as before, each with a `queue` block (source, age, owner,
 * next action, whether anyone has been contacted — never), plus `total` (all
 * matching, not the page) and `summary` (what is waiting company-wide, the
 * oldest, and the ownership rule — which is that there is none).
 */
router.get("/", handle(async (req, res) => {
  const { companyId } = await scopeFor(req, { domainLabel: "Sales" });
  const p = queue.parseQuery(req.query || {});
  const q = { companyId, ...queue.sourceFilter(p.source) };
  if (p.state === "awaiting") q.decision = { $exists: false };
  else if (p.state !== "all") q.decision = p.state;

  const nowMs = Date.now();
  const [rows, total, summary] = await Promise.all([
    MarketingHandoverReceipt.find(q)
      .sort({ receivedAt: p.order === "oldest" ? 1 : -1 })
      .limit(p.limit)
      .lean(),
    MarketingHandoverReceipt.countDocuments(q),
    queue.summary(companyId, nowMs),
  ]);

  return res.json({
    success: true,
    handovers: rows.map((r) => ({ ...r, queue: queue.queueView(r, nowMs) })),
    count: rows.length,
    total,
    summary,
    filters: { state: p.state, source: p.source, order: p.order },
  });
}));

router.get("/:handoverRef", handle(async (req, res) => {
  const { companyId } = await scopeFor(req, { domainLabel: "Sales" });
  const receipt = await MarketingHandoverReceipt
    .findOne({ companyId, handoverRef: str(req.params.handoverRef) }).lean();
  if (!receipt) throw fail("NOT_FOUND", "That handover was not found.");

  /* ── WHAT MARKETING HAS ACTUALLY DONE ABOUT THE ACCEPTANCE ──────────────
     A READ of a Marketing-owned record, never a write: Sales does not maintain
     Marketing's state and this route does not create, update or retry anything.
     It is here because a salesperson who accepted a Prospect needs to know
     whether the campaign has actually stopped, and until this slice they were
     simply told that it had.

     `pausedAt` is null unless Mautic confirmed it, and `label` is a sentence
     that says "pending" or "failed" in those words while it is. */
  const acquisition = await acquisitionHold.stateFor({
    companyId, handoverRef: receipt.handoverRef,
  });

  return res.json({
    success: true,
    handover: { ...receipt, queue: queue.queueView(receipt) },
    marketingAcquisition: {
      state: acquisition.state,
      label: acquisition.label,
      pausedAt: acquisition.pausedAt,
      requestedAt: acquisition.requestedAt,
      lastAttemptAt: acquisition.lastAttemptAt,
      nextAttemptAt: acquisition.nextAttemptAt,
      /* ── FOUR FACTS, NOT ONE FLAG ──────────────────────────────────────
         "Currently removed", "prevented from entering acquisition later",
         "awaiting retry" and "confirmed stopped" are different things, and a
         single paused flag conflated all of them. `retryIsAutomatic` is false
         because nothing in this deployment retries; the salesperson needs to
         know that an operator is involved. */
      currentlyRemoved: acquisition.disclosure.currentlyRemoved,
      futureEnrollmentPrevented: acquisition.disclosure.futureEnrollmentPrevented,
      awaitingRetry: acquisition.disclosure.awaitingRetry,
      retryIsAutomatic: acquisition.disclosure.retryIsAutomatic,
      confirmedStopped: acquisition.disclosure.confirmedStopped,
      /* The operator sentence and a stable code. Never a provider body, never a
         stack, and nothing about anybody else's contact. */
      failure: acquisition.failure,
      supersededBy: acquisition.supersededBy,
    },
  });
}));

/** One decision handler for all four answers — the differences are entirely in
 *  the payload each requires, and four near-identical handlers is four places
 *  for the authorisation check to drift. */
function decisionRoute(decision, readBody) {
  return handle(async (req, res) => {
    const { companyId } = await scopeFor(req, { domainLabel: "Sales" });
    const body = req.body || {};
    const args = readBody(body);

    /* Assigning a handover to somebody else is a manager's act — the same rule
       the Lead routes already apply to an owner other than the creator. */
    if (args.assignTo && str(args.assignTo) !== str(req.user?.id)) {
      if (!(await isSalesManager(req.user))) {
        throw fail("FORBIDDEN", "Only a Sales manager can assign a handover to someone else.");
      }
    }

    const result = await decisions.decide({
      companyId,
      handoverRef: str(req.params.handoverRef),
      decision,
      actor: actorOf(req),
      ...args,
    });

    await recordChange(req, {
      departmentSlug: "sales",
      entity: "marketing-handover",
      entityId: result.receipt._id,
      entityLabel: result.receipt.handoverRef,
      action: "update",
      summary: `Marketing handover ${result.receipt.handoverRef}: ${decision}`,
      after: {
        decision, reason: args.reason || "", leadRef: result.receipt.leadRef || "",
      },
    });

    /* Tell Marketing at once rather than waiting for a sweep — the feedback
       loop is the point. Never allowed to fail the decision: it is recorded
       and the outbox row stays PENDING if delivery cannot happen now. */
    const feedback = await outcomeDelivery.deliverPending({ companyId });

    return res.json({ success: true, handover: result.receipt, lead: result.lead, feedback });
  });
}

router.post("/:handoverRef/accept", decisionRoute("ACCEPTED", (b) => ({
  assignTo: b.assignTo || null,
  assignToName: str(b.assignToName),
})));

router.post("/:handoverRef/return", decisionRoute("RETURNED", (b) => ({
  reason: str(b.reason),
  nurtureTopic: str(b.nurtureTopic),
  revisitAt: b.revisitAt || null,
})));

router.post("/:handoverRef/reject", decisionRoute("REJECTED", (b) => ({
  reason: str(b.reason),
})));

router.post("/:handoverRef/link-duplicate", decisionRoute("DUPLICATE_LINKED", (b) => ({
  reason: str(b.reason),
  duplicateOfType: str(b.duplicateOfType) || "lead",
  duplicateOfId: b.duplicateOfId || null,
})));

router.use((err, req, res, _next) => sendError(res, err));

module.exports = router;
