// routes/CMS_Routes/Sales/changeNotices.js
//
// SALES ISSUES A CHANGE TO A HANDED-OVER LINE.
//
// The producer's door, and the sibling of `merchandisingHandovers.js`: the
// same live Sales grant, the same typed payload, the same
// commit-then-announce ordering.
//
// ── WHY THIS IS ON A SALES ROUTER ───────────────────────────────────────────
// Because Sales owns and authorises commercial change. Putting it on a
// Merchandising router behind a Merchandising capability — even a strict one —
// would mean a merchandiser could author a change to the buyer's own order,
// and the entire M7 boundary would be a naming convention. A Merchandising
// grant of any level opens nothing here.
//
// ── AND THE ACTOR IS NEVER BODY-AUTHORED ────────────────────────────────────
// `authorisedBy` is stamped from the resolved session inside the service. The
// field is not in `ISSUE_FIELDS`, so a caller who sends one is refused by name
// rather than having it silently ignored — a signature nobody made is worse
// than no signature.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { handle } = require("../../../services/storePurchase/errors");
const {
  HANDOVER_ACTION, salesHandoverAuthority,
} = require("../../../services/sales/handoverAuthority");
const {
  merchandisingCompanyMiddleware,
} = require("../../../services/companyContext/merchandisingScope.service");
const changes = require("../../../services/sales/changeNotice.service");
const delivery = require("../../../services/integration/salesChangeDelivery.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

/* The acting company, from the same shared resolver every router uses — it
   answers which of the actor's OWN memberships they are acting in, which has
   nothing to do with department authority. */
const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "Sales" });

/* Issuing a change is the same authority as issuing a handover: both commit
   the company to a confirmed requirement. Reading is the inspect grant. */
const canInspect = salesHandoverAuthority(HANDOVER_ACTION.INSPECT);
const canIssue = salesHandoverAuthority(HANDOVER_ACTION.ISSUE);

const actor = (req) => (req.user?.id
  ? { id: req.user.id, name: req.user.name || "", email: req.user.email || "" }
  : null);

/**
 * Carry the announcement, and report honestly whether it landed.
 *
 * Never throws: the change is already committed, and a receiver that is
 * momentarily unavailable must not turn a successful commercial act into an
 * error the salesperson has to interpret.
 */
async function announce(scope, correlationId) {
  const summary = await delivery.deliverPending({ companyId: scope.companyId, correlationId });
  return { delivered: summary.failed === 0, pending: summary.failed > 0 };
}

/** GET /lines/:handoverRef/:handoverLineRef — every change on one order line. */
router.get("/lines/:handoverRef/:handoverLineRef", requireCompany, canInspect,
  handle(async (req, res) => {
    const out = await changes.listForLine(req.merchandising, {
      handoverRef: req.params.handoverRef,
      handoverLineRef: req.params.handoverLineRef,
      limit: req.query.limit,
    });
    return res.json({ success: true, ...out });
  }));

/**
 * POST /requests/:requestId/lines/:lineId — issue a change.
 *
 * A second change on a line that already has an open one becomes VERSION 2 of
 * that change, not a new change: a merchandiser who assessed version 1 sees a
 * revision of the thing they already looked at.
 */
router.post("/requests/:requestId/lines/:lineId", requireCompany, canIssue,
  handle(async (req, res) => {
    const out = await changes.issue(req.merchandising, {
      requestId: req.params.requestId,
      lineId: req.params.lineId,
      body: req.body || {},
      actor: actor(req),
    });
    const carried = await announce(req.merchandising, out.correlationId);
    return res.status(201).json({ success: true, notice: out.notice, downstream: carried });
  }));

/**
 * POST /:changeRef/cancel — Sales withdraws the change.
 *
 * Not a deletion. The version stays, Merchandising's receiver mirrors the
 * withdrawal, and whatever Merchandising already assessed against it stays
 * readable — that work happened, and the history has to show it.
 */
router.post("/:changeRef/cancel", requireCompany, canIssue, handle(async (req, res) => {
  const out = await changes.cancel(req.merchandising, {
    changeRef: req.params.changeRef,
    body: req.body || {},
    actor: actor(req),
  });
  const carried = await announce(req.merchandising, out.correlationId);
  return res.json({ success: true, notice: out.notice, downstream: carried });
}));

module.exports = router;
