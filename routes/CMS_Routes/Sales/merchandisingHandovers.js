// routes/CMS_Routes/Sales/merchandisingHandovers.js
//
// SALES ISSUES THE HANDOVER — the producer's door, and the only one.
//
// ── WHY THIS IS A SALES ROUTE ───────────────────────────────────────────────
// Handover issuance, supersession and cancellation are commercial acts: they
// state what the company has promised a buyer and when. That is Sales'
// authority, so this router sits behind `salesAuth`, resolves the Sales
// scope, and proves a LIVE Sales grant for every action — see
// `services/sales/handoverAuthority.js` for why it does not reuse
// `bypassesApproval`, which answers from a seven-day-old token and admits a
// platform administrator holding no Sales grant at all.
//
// A Merchandising grant opens NONE of it: the receiving department cannot
// author the statement it receives.
//
// ── AND THE SMALLEST POSSIBLE ONE ───────────────────────────────────────────
// Three actions on the proven, confirmed order line, and an inspection read
// so the screen can say why a line is not eligible. No new Sales navigation,
// nothing on enquiries, nothing on unconfirmed quotations, nothing on the
// Journey. Confirmation is the existing Sales status machine —
// `quotation_sales_approved` or a later execution state — never inferred
// from a customer's quotation approval alone.
//
// ── THE LINE IN THE URL ─────────────────────────────────────────────────────
// `:lineRef` is the CustomerRequest item's own permanent reference. It used to
// be the line's selected style, which meant an order carrying one style on two
// commercial lines had one address for two different commitments and could not
// be handed over at all.
//
// ── AND WHAT HAPPENS AFTER THE COMMIT ───────────────────────────────────────
// Sales writes its version, its history and its outbox atomically, then asks
// the delivery service to carry the announcement to Merchandising's receiver.
// That attempt cannot fail the request: the commercial act is committed, the
// event stays pending if the receiver is unavailable, and the response says
// so rather than pretending either way.
"use strict";

const express = require("express");

const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { scopeFor: salesScopeFor } = require("../../../services/companyContext/salesScope.service");
const {
  HANDOVER_ACTION, salesHandoverAuthority,
} = require("../../../services/sales/handoverAuthority");
const { sendError, handle } = require("../../../services/storePurchase/errors");
const producer = require("../../../services/sales/merchandisingHandover.service");
const delivery = require("../../../services/integration/salesHandoverDelivery.service");

const router = express.Router();
router.use(salesAuth);

const actor = (req) => (req.user?.id
  ? { id: req.user.id, name: req.user.name || "", email: req.user.email || "" }
  : null);

/**
 * Carry the announcement across, and report honestly whether it landed.
 *
 * Never throws: the Sales decision is already committed, and a receiver that
 * is temporarily unavailable must not turn a successful commercial act into
 * an error the salesperson has to interpret.
 */
async function announce(scope, correlationId) {
  const summary = await delivery.deliverPending({ companyId: scope.companyId, correlationId });
  return {
    delivered: summary.failed === 0,
    pending: summary.failed > 0,
  };
}

/** GET /requests/:requestId — each line, its eligibility, its current version. */
router.get("/requests/:requestId",
  salesHandoverAuthority(HANDOVER_ACTION.INSPECT),
  handle(async (req, res) => {
    const scope = await salesScopeFor(req);
    const out = await producer.inspectRequest(scope, { requestId: req.params.requestId });
    /* So the screen can hide controls it knows will be refused. The server
       remains the authority; this is courtesy, not permission. */
    return res.json({ success: true, ...out, mayIssue: req.salesHandoverRole
      ? ["approver", "owner"].includes(req.salesHandoverRole) : false });
  }));

/** POST /requests/:requestId/lines/:lineRef/issue — version 1, or the next. */
router.post("/requests/:requestId/lines/:lineRef/issue",
  salesHandoverAuthority(HANDOVER_ACTION.ISSUE),
  handle(async (req, res) => {
    const scope = await salesScopeFor(req);
    const out = await producer.issue(scope, {
      requestId: req.params.requestId,
      lineId: req.params.lineRef,
      body: req.body || {},
      actor: actor(req),
    });
    const handover = await announce(scope, out.correlationId);
    return res.status(201).json({ success: true, ...out, handover });
  }));

/** POST /requests/:requestId/lines/:lineRef/cancel — Sales withdraws it. */
router.post("/requests/:requestId/lines/:lineRef/cancel",
  salesHandoverAuthority(HANDOVER_ACTION.ISSUE),
  handle(async (req, res) => {
    const scope = await salesScopeFor(req);
    const out = await producer.cancel(scope, {
      requestId: req.params.requestId,
      lineId: req.params.lineRef,
      reason: req.body?.reason,
      actor: actor(req),
    });
    const handover = await announce(scope, out.correlationId);
    return res.json({ success: true, ...out, handover });
  }));

/**
 * POST /delivery/retry — carry anything still pending.
 *
 * The retry the outbox needs to be honest about being retryable. Same Sales
 * authority as issuing: it re-attempts commercial announcements. It reports
 * counts, and it can be run as often as anybody likes because delivery is
 * idempotent on both sides.
 */
router.post("/delivery/retry",
  salesHandoverAuthority(HANDOVER_ACTION.ISSUE),
  handle(async (req, res) => {
    const scope = await salesScopeFor(req);
    const summary = await delivery.deliverPending({ companyId: scope.companyId, limit: 200 });
    return res.json({ success: true, ...summary });
  }));

/* A refusal thrown by the scope resolver before `handle` wraps it. */
router.use((err, req, res, next) => (res.headersSent ? next(err) : sendError(res, err)));

module.exports = router;
