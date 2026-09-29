// routes/CMS_Routes/Merchandising/customerMaterialRoute.js
//
// CUSTOMER-SUPPLIED MATERIAL — THE DOOR, FOR MERCHANDISING.
//
// Its own router rather than more handlers on `executionRoute.js`, which is
// already the widest surface in Merchandising. Sibling file, same mount prefix,
// same middleware — nothing about the contract changes.
//
// ── AUTHORITY, FROM THE EXISTING FOURTEEN ───────────────────────────────────
// No capability constant is added, for the reason `developmentRoute.js` states:
// pre-order and post-order work are the same kinds of decision at different
// stages, so they are the same authorities.
//
//   READING is `file.read`. A document only Merchandising can see cannot
//   coordinate anything — and Store reads it through Store's own router, under
//   Store's own grant.
//
//   DRAFTING and EDITING LINES is `requirement.write`. Stating what is required
//   for a style is exactly what that grant is for, and this is that: which
//   materials are needed, how much, in what unit, by when. The editor rung.
//
//   ISSUING and CANCELLING is `handover.submit`. Issuing is not another edit —
//   it is an outward statement that Store plans around and the customer is
//   told, and withdrawing it is the same kind of act in reverse. So it sits with
//   the rung that already makes outward statements, which is the approver's,
//   and not with the rung that drafts them. Somebody who could draft and issue
//   without noticing would erase the difference between composing a document and
//   committing to it, and that difference is the only thing that makes the
//   frozen revision worth having.
//
// ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
// No endpoint records a receipt, a short shipment or a stock movement, and none
// will be added here when they exist — receiving customer-owned goods is Store's
// act on Store's router, against ownership lots this phase does not have. There
// is no door for it, which is the only reliable way to keep somebody from
// signing for goods they never saw.
//
// And no endpoint sets a price, a vendor, a tax treatment or a value. There is
// nowhere on the record for one to land; see the model.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { handle } = require("../../../services/storePurchase/errors");
const {
  CAPABILITY, merchandisingCapability,
} = require("../../../services/merchandising/access.service");
const {
  merchandisingCompanyMiddleware,
} = require("../../../services/companyContext/merchandisingScope.service");
const development = require("../../../services/merchandising/development.service");
const customerMaterial = require("../../../services/merchandising/customerMaterial.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "Merchandising" });
const canRead = merchandisingCapability(CAPABILITY.FILE_READ);
const canState = merchandisingCapability(CAPABILITY.REQUIREMENT_WRITE);
const canIssue = merchandisingCapability(CAPABILITY.HANDOVER_SUBMIT);

const actor = (req) => (req.user?.id
  ? { id: req.user.id, name: req.user.name || "", email: req.user.email || "" }
  : null);

const ctx = (req) => ({ ...req.merchandising, actorEmail: req.user?.email || "" });

const idempotencyKey = (req) => String(
  req.get("Idempotency-Key") || req.body?.idempotencyKey || "",
).trim();

/* Every write here is one unit of work: the change and the audit row that
   explains it commit together, with the idempotency key in the same commit, so
   a retry replays the first answer rather than acting twice. `withTxn` alone
   would give the first two of those and not the third. */
const atomically = (req, scope, request, run) => development.onceAtomically(ctx(req), {
  scope, idempotencyKey: idempotencyKey(req), request,
}, run);

/* ═══ READS ════════════════════════════════════════════════════════════════ */

/**
 * Everything on one execution file: the open draft, the current issued
 * revision, and the history.
 *
 * ── ELIGIBILITY IS ENFORCED HERE, NOT IN A COMPONENT ─────────────────────
 * A full-package file is REFUSED, not answered with an empty list. Rendering
 * the section conditionally is presentation; a client that asks anyway must get
 * the same answer as one that does not, or the boundary is a suggestion. The
 * refusal names the model, so a screen can say why rather than showing a
 * failure.
 */
router.get("/files/:fileId/customer-materials", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await customerMaterial.forFile(ctx(req), { fileId: req.params.fileId });
    return res.json({ success: true, ...out });
  }));

/** One document, by id, for Merchandising — including a draft. */
router.get("/customer-materials/:docId", requireCompany, canRead, handle(async (req, res) => {
  const doc = await customerMaterial.loadDoc(ctx(req), req.params.docId);
  /* Deliberately NOT re-asserting job work. A document that exists stays
     readable even if Sales later converted the order — see the service. What
     the model gates is writing, and every write path proves it for itself. */
  const { fulfilmentModel, jobWork } = await customerMaterial.sourceFile(ctx(req), doc.executionFileId);
  return res.json({
    success: true,
    expectation: customerMaterial.expectationView(doc),
    fulfilmentModel,
    jobWork,
    sourceChanged: !jobWork,
  });
}));

/* ═══ COMPOSING ════════════════════════════════════════════════════════════ */

/**
 * Open a draft — a first one, or a revision of an issued one.
 *
 * Idempotent twice over, deliberately. The key makes a retry replay; and a
 * second attempt with a DIFFERENT key for a file that already has an open draft
 * returns that draft rather than a second one, because two open drafts would
 * give Store two answers to "what is coming".
 */
router.post("/files/:fileId/customer-materials", requireCompany, canState,
  handle(async (req, res) => {
    const out = await atomically(req,
      `cme:draft:${req.params.fileId}`,
      { fileId: req.params.fileId, fromRevisionNo: req.body?.fromRevisionNo ?? null },
      (session) => customerMaterial.createDraft(ctx(req), {
        fileId: req.params.fileId,
        fromRevisionNo: req.body?.fromRevisionNo ?? null,
        actor: actor(req),
      }, session));
    return res.status(out.created ? 201 : 200).json({ success: true, ...out });
  }));

/** Add an expected material. Identity comes from Store's catalogue. */
router.post("/customer-materials/:docId/lines", requireCompany, canState,
  handle(async (req, res) => {
    const out = await atomically(req,
      `cme:line:add:${req.params.docId}`,
      {
        docId: req.params.docId,
        rawItemId: String(req.body?.rawItemId || ""),
        variantId: String(req.body?.variantId || ""),
        requiredQuantity: req.body?.requiredQuantity ?? null,
        unit: String(req.body?.unit || ""),
      },
      (session) => customerMaterial.addLine(ctx(req), {
        docId: req.params.docId, body: req.body, actor: actor(req),
      }, session));
    return res.status(201).json({ success: true, ...out });
  }));

/** Change how much, in what unit, by when. Never which material. */
router.put("/customer-materials/:docId/lines/:lineRef", requireCompany, canState,
  handle(async (req, res) => {
    const out = await atomically(req,
      `cme:line:update:${req.params.docId}:${req.params.lineRef}`,
      {
        docId: req.params.docId, lineRef: req.params.lineRef,
        requiredQuantity: req.body?.requiredQuantity ?? null,
        unit: String(req.body?.unit || ""),
        expectedArrivalDate: String(req.body?.expectedArrivalDate || ""),
        note: String(req.body?.note || ""),
      },
      (session) => customerMaterial.updateLine(ctx(req), {
        docId: req.params.docId, lineRef: req.params.lineRef,
        body: req.body, actor: actor(req),
      }, session));
    return res.json({ success: true, ...out });
  }));

router.delete("/customer-materials/:docId/lines/:lineRef", requireCompany, canState,
  handle(async (req, res) => {
    const out = await atomically(req,
      `cme:line:remove:${req.params.docId}:${req.params.lineRef}`,
      { docId: req.params.docId, lineRef: req.params.lineRef },
      (session) => customerMaterial.removeLine(ctx(req), {
        docId: req.params.docId, lineRef: req.params.lineRef,
        body: req.body, actor: actor(req),
      }, session));
    return res.json({ success: true, ...out });
  }));

router.put("/customer-materials/:docId/instructions", requireCompany, canState,
  handle(async (req, res) => {
    const out = await atomically(req,
      `cme:instructions:${req.params.docId}`,
      { docId: req.params.docId, instructions: String(req.body?.instructions || "") },
      (session) => customerMaterial.updateInstructions(ctx(req), {
        docId: req.params.docId, body: req.body, actor: actor(req),
      }, session));
    return res.json({ success: true, ...out });
  }));

/* ═══ COMMITTING ═══════════════════════════════════════════════════════════ */

/**
 * ISSUE — the approver rung, because this is the outward statement.
 *
 * After this the revision is frozen. A change is a new revision, so what Store
 * was told stays readable exactly as it was told.
 */
router.post("/customer-materials/:docId/issue", requireCompany, canIssue,
  handle(async (req, res) => {
    const out = await atomically(req,
      `cme:issue:${req.params.docId}`,
      { docId: req.params.docId, expectedRevision: req.body?.expectedRevision ?? null },
      (session) => customerMaterial.issue(ctx(req), {
        docId: req.params.docId, body: req.body, actor: actor(req),
      }, session));
    return res.json({ success: true, ...out });
  }));

/** CANCEL — the same rung, with a reason Store can act on. */
router.post("/customer-materials/:docId/cancel", requireCompany, canIssue,
  handle(async (req, res) => {
    const out = await atomically(req,
      `cme:cancel:${req.params.docId}`,
      { docId: req.params.docId, reason: String(req.body?.reason || "") },
      (session) => customerMaterial.cancel(ctx(req), {
        docId: req.params.docId, body: req.body, actor: actor(req),
      }, session));
    return res.json({ success: true, ...out });
  }));

module.exports = router;
