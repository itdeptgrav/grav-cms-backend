// routes/CMS_Routes/Sales/developmentRequests.js
//
// SALES ASKS MERCHANDISING TO SELECT MATERIALS, AND LATER AUTHORISES THE SPEND.
//
// The pre-order producer's door, beside its handover and change siblings: the
// same live Sales grant, the same declared payload, the same
// commit-then-announce ordering.
//
// ── WHY THIS IS ON A SALES ROUTER ───────────────────────────────────────────
// Sales owns the Journey and the buyer relationship. Putting the request on a
// Merchandising router would mean a merchandiser could raise development work
// against a buyer's opportunity without Sales asking — and the whole point of
// the request is that it is an ask, from the department that owns the
// relationship, with a version and an author.
//
// ── AND SALES NEVER TOUCHES THE DEVELOPMENT FILE ────────────────────────────
// There is no route here that reads or writes one. Sales publishes; the
// Merchandising receiver opens the file and mirrors the release. What Sales
// sees of Merchandising's work comes back through the read below, which is a
// projection of the request and its answer — never a handle on the file.
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
const requests = require("../../../services/sales/developmentRequest.service");
/* What Merchandising has chosen to say about the asks on this Journey. A
   projection of statements — no file id, no revision handle, no write. See the
   module header for why the query does not live on this side. */
const publication = require("../../../services/merchandising/developmentPublication.service");
const delivery = require("../../../services/integration/developmentRequestDelivery.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "Sales" });

/* Asking for development is the same authority as issuing a handover: both
   commit the company to work on the buyer's behalf. Reading is the inspect
   grant. */
const canInspect = salesHandoverAuthority(HANDOVER_ACTION.INSPECT);
const canIssue = salesHandoverAuthority(HANDOVER_ACTION.ISSUE);

const actor = (req) => (req.user?.id
  ? { id: req.user.id, name: req.user.name || "", email: req.user.email || "" }
  : null);

/** Carry the announcement, and report honestly whether it landed. */
async function announce(scope, correlationId) {
  const summary = await delivery.deliverPending({ companyId: scope.companyId, correlationId });
  return { delivered: summary.failed === 0, pending: summary.failed > 0 };
}

/**
 * Every development request on one Journey — the Sales Journey surface.
 *
 * Two halves, from the two departments that own them: the requests are Sales'
 * own record, and `merchandising` is what Merchandising publishes back about
 * each product line. They are returned side by side and never merged into one
 * row, so a reader of this response can always tell which department is
 * asserting which fact.
 */
router.get("/journeys/:journeyId", requireCompany, canInspect, handle(async (req, res) => {
  const out = await requests.listForJourney(req.merchandising, {
    journeyId: req.params.journeyId, limit: req.query.limit,
  });
  const answer = await publication.forJourney(req.merchandising, {
    journeyId: req.params.journeyId,
  });
  return res.json({ success: true, ...out, merchandising: answer.lines });
}));

/**
 * The Journey's product lines, by permanent reference.
 *
 * What the Sales surface offers "send to Merchandising" against. It is a read
 * of Sales' OWN record — the enquiry lines on this Journey — and carries no
 * Merchandising fact at all.
 */
router.get("/journeys/:journeyId/lines", requireCompany, canInspect, handle(async (req, res) => {
  const out = await requests.listProductLines(req.merchandising, {
    journeyId: req.params.journeyId,
  });
  return res.json({ success: true, ...out });
}));

/** One product line's request history. */
router.get("/journeys/:journeyId/lines/:productLineRef", requireCompany, canInspect,
  handle(async (req, res) => {
    const out = await requests.listForLine(req.merchandising, {
      journeyId: req.params.journeyId,
      productLineRef: req.params.productLineRef,
      limit: req.query.limit,
    });
    return res.json({ success: true, ...out });
  }));

/**
 * SEND TO MERCHANDISING.
 *
 * A second request against a line that already has an open one becomes
 * VERSION 2 — the buyer changed the brief, and a merchandiser who accepted
 * version 1 sees a revision of the thing they already looked at.
 */
router.post("/journeys/:journeyId/lines/:productLineRef", requireCompany, canIssue,
  handle(async (req, res) => {
    const out = await requests.issue(req.merchandising, {
      journeyId: req.params.journeyId,
      productLineRef: req.params.productLineRef,
      body: req.body || {},
      actor: actor(req),
    });
    const carried = await announce(req.merchandising, out.correlationId);
    return res.status(201).json({ success: true, request: out.request, downstream: carried });
  }));

router.post("/:requestRef/cancel", requireCompany, canIssue, handle(async (req, res) => {
  const out = await requests.cancel(req.merchandising, {
    requestRef: req.params.requestRef, body: req.body || {}, actor: actor(req),
  });
  const carried = await announce(req.merchandising, out.correlationId);
  return res.json({ success: true, request: out.request, downstream: carried });
}));

/**
 * AUTHORISE RELEASE TO R&D.
 *
 * The step that sends an approved selection onward, and it is deliberately
 * Sales'. Merchandising approving says the materials are settled; releasing
 * says the buyer relationship justifies spending the development budget on
 * sampling. Merchandising has no route for it.
 */
router.post("/:requestRef/authorise-release", requireCompany, canIssue, handle(async (req, res) => {
  const out = await requests.authoriseRelease(req.merchandising, {
    requestRef: req.params.requestRef, body: req.body || {}, actor: actor(req),
  });
  const carried = await announce(req.merchandising, out.correlationId);
  return res.json({ success: true, ...out, downstream: carried });
}));

module.exports = router;
