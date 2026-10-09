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
/* Sales approves the merchandiser's selection (3 Oct 2026, owner) — through
   Merchandising's own service, with the salesperson as the checker. */
const development = require("../../../services/merchandising/development.service");
const {
  DevelopmentFile, DevelopmentBomRevision, BOM_STATE,
} = require("../../../models/CMS_Models/Merchandising/Development");
const { SalesDevelopmentRequest, REQUEST_STATE } = require("../../../models/CMS_Models/Sales/DevelopmentRequest");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

/* A JOURNEY IS NAMED BY ITS REFERENCE ON EVERY SALES SCREEN (4 Oct 2026).
   The pipeline hands this panel "SJ-2026-0011", and every route below looked
   the journey up by database id only, answering "That Sales Journey does not
   exist" — so the Development panel never loaded and the approval never
   showed. A reference is turned into the id here, once, before any handler;
   the services still scope by company, so a reference from another company
   resolves to nothing they will act on. */
router.param("journeyId", async (req, _res, next, value) => {
  try {
    const v = String(value || "").trim();
    if (v && !/^[a-f0-9]{24}$/i.test(v)) {
      const SalesJourney = require("../../../models/CMS_Models/Sales/SalesJourney");
      const j = await SalesJourney.findOne({ journeyId: v }).select("_id").lean();
      if (j) req.params.journeyId = String(j._id);
    }
    next();
  } catch (e) { next(e); }
});

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

/**
 * ASK MERCHANDISING TO CHANGE THE SELECTION.
 *
 * The same decision point as the release, answered the other way, so it sits
 * behind the same authority: whoever may commit the development budget is
 * whoever may decline to. It is not a Merchandising route — a Sales judgement
 * about whether the selection answers the customer does not belong on a
 * Merchandising screen, and Merchandising has no route that takes it.
 */
router.post("/:requestRef/request-material-changes", requireCompany, canIssue, handle(async (req, res) => {
  const out = await requests.requestMaterialChanges(req.merchandising, {
    requestRef: req.params.requestRef, body: req.body || {}, actor: actor(req),
  });
  const carried = await announce(req.merchandising, out.correlationId);
  return res.json({ success: true, ...out, downstream: carried });
}));

/* ═══ SALES APPROVES THE SELECTION (3 Oct 2026, owner) ════════════════════
   "The approval will come to the sales person." The merchandiser submits;
   the salesperson reads the rows on the pipeline and approves — which also
   releases the approved revision to R&D in the same act — or sends it back
   with a reason. Both go through Merchandising's own service so every rule
   it keeps (maker/checker, supersession, the audit row, the outbox) runs;
   the salesperson is simply the checker. */
async function submittedFor(req) {
  const request = await SalesDevelopmentRequest.findOne({
    companyId: req.merchandising.companyId, requestRef: String(req.params.requestRef || "").trim(),
    state: REQUEST_STATE.ISSUED,
  }).lean();
  if (!request) {
    const err = new Error("There is no open development request with that reference."); err.status = 404; throw err;
  }
  const file = await DevelopmentFile.findOne({
    companyId: req.merchandising.companyId, journeyId: request.journeyId, productLineRef: request.productLineRef,
  }).lean();
  if (!file) { const err = new Error("Merchandising has not opened a file for this line yet."); err.status = 404; throw err; }
  const submitted = await DevelopmentBomRevision.findOne({
    companyId: req.merchandising.companyId, developmentFileId: file._id, state: BOM_STATE.SUBMITTED,
  }).lean();
  if (!submitted) { const err = new Error("Merchandising has not submitted a selection to approve."); err.status = 409; throw err; }
  return { request, file, submitted };
}
const merchCtx = (req) => ({ ...req.merchandising, actorEmail: req.user?.email || "" });

router.post("/:requestRef/approve-selection", requireCompany, canIssue, handle(async (req, res) => {
  const { request, file, submitted } = await submittedFor(req);
  const expected = Number(req.body?.expectedBomRevisionNo);
  if (Number.isInteger(expected) && expected !== submitted.revisionNo) {
    return res.status(409).json({ success: false, message: `Merchandising has since submitted revision ${submitted.revisionNo}. Reload and read it before approving.` });
  }
  const approved = await development.approveBom(merchCtx(req), {
    fileId: String(file._id), body: { expectedRevision: submitted.revision, salesChecker: true }, actor: actor(req),
    idempotencyKey: String(req.body?.idempotencyKey || "") || require("crypto").randomUUID(),
  });
  /* the same act releases it to R&D; if the release is refused, the approval
     stands and the panel offers the release button as before */
  let release = null, releaseError = "";
  try {
    release = await requests.authoriseRelease(req.merchandising, {
      requestRef: request.requestRef,
      body: { expectedBomRevisionNo: approved.revisionNo, note: String(req.body?.note || ""), idempotencyKey: `rel-${String(req.body?.idempotencyKey || approved.revisionNo)}` },
      actor: actor(req),
    });
    await announce(req.merchandising, release.correlationId);
  } catch (e) { releaseError = e?.message || "The release was not recorded."; }
  /* Merchandising is told the selection was approved (4 Oct 2026) — best effort */
  require("../../../services/merchandising/developmentNotify.service")
    .notifyDevelopmentBom("approved", { companyId: req.merchandising.companyId, fileId: file._id, revisionNo: approved.revisionNo, actor: actor(req) })
    .catch((e) => console.error("[developmentRequests] approved mail:", e?.message || e));
  /* the sample style on the pipeline moves to R&D with the approved rows on it */
  let styleMoved = false;
  try {
    if (request.sampleStyleId) {
      const SampleStyle = require("../../../models/CMS_Models/Sales/SampleStyle");
      const { approveMaterialsAndSendToRnd } = require("./sampleStyles");
      const style = await SampleStyle.findById(request.sampleStyleId);
      const approvedRows = (await DevelopmentBomRevision.findOne({ companyId: req.merchandising.companyId, developmentFileId: file._id, revisionNo: approved.revisionNo }).lean())?.rows || [];
      await approveMaterialsAndSendToRnd(style, approvedRows, req);
      styleMoved = Boolean(style);
    }
  } catch (e) { console.error("[developmentRequests] style move:", e?.message || e); }
  return res.json({ success: true, approved, release, releaseError, styleMoved });
}));

router.post("/:requestRef/return-selection", requireCompany, canIssue, handle(async (req, res) => {
  const { file, submitted } = await submittedFor(req);
  const out = await development.requestChanges(merchCtx(req), {
    fileId: String(file._id), body: { reason: String(req.body?.reason || ""), expectedRevision: submitted.revision }, actor: actor(req),
  });
  /* Merchandising is told, with the reason (4 Oct 2026) — best effort */
  require("../../../services/merchandising/developmentNotify.service")
    .notifyDevelopmentBom("returned", { companyId: req.merchandising.companyId, fileId: file._id, revisionNo: submitted.revisionNo, actor: actor(req), reason: String(req.body?.reason || "") })
    .catch((e) => console.error("[developmentRequests] returned mail:", e?.message || e));
  return res.json({ success: true, ...out });
}));

/* ═══ SEND AN APPROVED SELECTION TO R&D (4 Oct 2026, owner) ══════════════
   "Sales person approved the BOM means the next step will be send to R&D."
   Normally approve-selection does both in one act. This route covers the
   style whose selection is ALREADY approved while the style itself still
   sits at Materials — the pipeline was reset and the style re-sent to the
   merchandiser, whose file was already approved and released. No Project
   Manager is asked; the salesperson sends it on. */
router.post("/:requestRef/send-to-rnd", requireCompany, canIssue, handle(async (req, res) => {
  const request = await SalesDevelopmentRequest.findOne({
    companyId: req.merchandising.companyId, requestRef: String(req.params.requestRef || "").trim(),
    state: REQUEST_STATE.ISSUED,
  }).lean();
  if (!request) return res.status(404).json({ success: false, message: "There is no open development request with that reference." });
  if (!request.sampleStyleId) return res.status(409).json({ success: false, message: "This request is not linked to a style on the pipeline." });
  const file = await DevelopmentFile.findOne({
    companyId: req.merchandising.companyId, journeyId: request.journeyId, productLineRef: request.productLineRef,
  }).lean();
  if (!file) return res.status(404).json({ success: false, message: "Merchandising has not opened a file for this line yet." });
  const approved = await DevelopmentBomRevision.findOne({
    companyId: req.merchandising.companyId, developmentFileId: file._id, state: BOM_STATE.APPROVED,
  }).sort({ revisionNo: -1 }).lean();
  if (!approved) return res.status(409).json({ success: false, message: "No approved selection exists yet — approve Merchandising's submission first." });
  const SampleStyle = require("../../../models/CMS_Models/Sales/SampleStyle");
  const { approveMaterialsAndSendToRnd } = require("./sampleStyles");
  const style = await SampleStyle.findById(request.sampleStyleId);
  if (!style) return res.status(404).json({ success: false, message: "The style on the pipeline could not be found." });
  if (style.stage !== "materials") {
    return res.status(409).json({ success: false, message: `This style is already past Materials (${style.stage}).` });
  }
  await approveMaterialsAndSendToRnd(style, approved.rows || [], req);
  return res.json({ success: true, styleMoved: true, revisionNo: approved.revisionNo, stage: style.stage });
}));

module.exports = router;
