// routes/CMS_Routes/Merchandising/executionRoute.js
//
// ORDER EXECUTION — Merchandising's receiver surface.
//
// The New Handovers inbox, the two decisions, the Execution File register and
// the file's own commands. Every endpoint proves the same three things in the
// same order — the session, the acting company, the live capability — and
// every response is shaped in `services/merchandising/execution.service.js`,
// field by field, so nothing about the contract is expressed here.
//
// ── WHAT THIS ROUTER DELIBERATELY DOES NOT HAVE ─────────────────────────────
//   POST /files                 a file exists only by accepting a handover
//   POST /handovers/:id/decline Merchandising cannot reject a commercial order
//   POST /files/:id/cancel      cancellation is Sales' act, mirrored here
//   POST /files/:id/rescope     scope changes are new Sales versions
//
// Their absence is asserted by test, so the next hand cannot add one quietly.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { fail, sendError, handle } = require("../../../services/storePurchase/errors");
const {
  merchandisingCompanyMiddleware,
} = require("../../../services/companyContext/merchandisingScope.service");
const {
  CAPABILITY, merchandisingCapability, liveMerchandisingRole,
} = require("../../../services/merchandising/access.service");
const execution = require("../../../services/merchandising/execution.service");
const orderDemandRelease = require("../../../services/merchandising/orderDemandRelease.service");
const fileDemandRelease = require("../../../services/merchandising/fileDemandRelease.service");
const selection = require("../../../services/merchandising/selection.service");
/* ── M5 ────────────────────────────────────────────────────────────────────
   An approval closes whatever Time & Action milestone was waiting for it.
   Carried AFTER the approval commits, never inside it: a schedule that cannot
   be settled must not be able to fail an approval. See the carrier for why
   this is not a direct call into the T&A service. */
const tnaDelivery = require("../../../services/integration/tnaSourceDelivery.service");
const adoption = require("../../../services/merchandising/packagingAdoption.service");
const approvals = require("../../../services/merchandising/approvalRegister.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "Merchandising" });
const canRead = merchandisingCapability(CAPABILITY.FILE_READ);
const canReview = merchandisingCapability(CAPABILITY.BRIEF_REVIEW);
const canManage = merchandisingCapability(CAPABILITY.FILE_MANAGE);
const canAssign = merchandisingCapability(CAPABILITY.FILE_ASSIGN);
const canMoveLifecycle = merchandisingCapability(CAPABILITY.FILE_LIFECYCLE);
/* ── M3 ────────────────────────────────────────────────────────────────────
   Writing a selection and DECIDING on one are different authorities, and the
   capability vocabulary already separates them.

   `submit` sits with the writer rather than the approver: advancing your own
   draft for somebody else to read is not an approval, and putting it behind
   `selection.approve` would mean an editor could never move their own work at
   all and every file would need two approvers before anything could happen —
   which a ten-person manufacturer does not have. The separation the process
   actually needs is enforced where it belongs, in `approve`: the approver may
   not be the person who wrote or submitted the revision, and an owner is not
   an exception to that. */
const canWriteSelection = merchandisingCapability(CAPABILITY.SELECTION_WRITE);
const canApproveSelection = merchandisingCapability(CAPABILITY.SELECTION_APPROVE);
/* Releasing demand is a commitment to spend, so it sits at `approver` — see
   the capability's own note in `access.service.js`. */
const canReleaseDemand = merchandisingCapability(CAPABILITY.PROCUREMENT_RELEASE);

const actor = (req) => (req.user?.id
  ? { id: req.user.id, name: req.user.name || "", email: req.user.email || "" }
  : null);

/* A retry-sensitive command carries its key in a header or in the body. The
   header is the convention; the body is accepted because a form post that
   cannot set headers is still a client that must not act twice. */
const idempotencyKey = (req) => String(
  req.get("Idempotency-Key") || req.body?.idempotencyKey || "",
).trim();

/* ── COMPANIES — the selector's projection, deliberately BEFORE the company
   middleware: it is the read a person needs in order to choose one. Names
   come only from the actor's own live memberships. */
router.get("/companies", canRead, handle(async (req, res) => {
  const out = await execution.listCompaniesFor(req.user);
  return res.json({ success: true, ...out });
}));

/* ═══════════════════════════════════════════════════════════════════════════
   RELEASING APPROVED DEMAND INTO PROCUREMENT
   ═══════════════════════════════════════════════════════════════════════════
   An explicit command, deliberately: accepting a handover does not release
   demand, approving a costing does not, and a customer approving a quotation
   does not. Merchandising decides when its approved requirement becomes
   something Store may go and buy.

   It produces DRAFT spend requests and nothing else — no purchase order, no
   supplier, no reservation. Every quantity is regenerated server-side from the
   frozen approved costing; nothing in the request body describes one.
════════════════════════════════════════════════════════════════════════════ */

/** The context the release service reads: company, actor, and the live role. */
const releaseCtx = async (req) => ({
  companyId: req.merchandising.companyId,
  role: await liveMerchandisingRole(req),
});

router.get("/demand-release", requireCompany, canRead, handle(async (req, res) => {
  const out = await orderDemandRelease.stateFor(await releaseCtx(req), {
    orderId: String(req.query.orderId || "").trim(),
    lineRef: String(req.query.lineRef || "").trim(),
    costingVersionId: String(req.query.costingVersionId || "").trim(),
  });
  return res.json({ success: true, ...out });
}));

router.post("/demand-release", requireCompany, canReleaseDemand, handle(async (req, res) => {
  const body = req.body || {};
  const out = await orderDemandRelease.release(await releaseCtx(req), {
    /* The three identities the command must name. A release that guessed any
       of them would commit money against a record nobody chose. */
    orderId: String(body.orderId || "").trim(),
    lineRef: String(body.lineRef || "").trim(),
    costingVersionId: String(body.costingVersionId || "").trim(),
    actor: actor(req),
  });
  return res.json({ success: true, ...out });
}));

/* ── THE SAME COMMAND, ADDRESSED BY THE FILE SOMEBODY IS LOOKING AT ───────
   The pair above is the identity-addressed contract, kept working and not
   removed. It is not, however, something a screen can call: the Execution
   File has a file id, a handover reference and a Sales version, and the only
   ways a browser could produce an order id and an exact costing version would
   be to guess, to search, or to have a person type an internal identity in.

   These two resolve all of that server-side, from records the file already
   points at, and hand the SAME authority the same three identities. The GET
   returns an opaque handle for the resolution it read; the POST must echo it,
   so a line repriced onto another approved costing is a conflict the person
   sees rather than a substitution nobody notices. */

router.get("/files/:fileId/demand-release", requireCompany, canRead, handle(async (req, res) => {
  const out = await fileDemandRelease.stateForFile(await releaseCtx(req), {
    fileId: String(req.params.fileId || "").trim(),
  });
  return res.json({ success: true, ...out });
}));

router.post("/files/:fileId/demand-release", requireCompany, canReleaseDemand,
  handle(async (req, res) => {
    const out = await fileDemandRelease.releaseFromFile(await releaseCtx(req), {
      fileId: String(req.params.fileId || "").trim(),
      /* The handle the GET produced. Nothing else about the command is
         body-authored — no order, no line, no version, no quantity. */
      expectedVersion: String(req.body?.expectedVersion || "").trim(),
      actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* ── THE INBOX ─────────────────────────────────────────────────────────── */

router.get("/handovers", requireCompany, canRead, handle(async (req, res) => {
  const out = await execution.listHandovers(req.merchandising, {
    q: req.query.q, cursor: req.query.cursor, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

router.get("/handovers/:id", requireCompany, canRead, handle(async (req, res) => {
  const out = await execution.getHandover(req.merchandising, { id: req.params.id });
  return res.json({ success: true, ...out });
}));

/* The two decisions. `brief.review` for both: accepting the brief and asking
   Sales to clarify it are the same authority exercised two ways. */
router.post("/handovers/:id/accept", requireCompany, canReview, handle(async (req, res) => {
  const out = await execution.acceptHandover(req.merchandising, {
    id: req.params.id, actor: actor(req),
  });
  return res.status(out.alreadyAccepted ? 200 : 201).json({ success: true, ...out });
}));

router.post("/handovers/:id/clarify", requireCompany, canReview, handle(async (req, res) => {
  const out = await execution.requestClarification(req.merchandising, {
    id: req.params.id,
    category: req.body?.category,
    reason: req.body?.reason,
    actor: actor(req),
  });
  return res.status(201).json({ success: true, ...out });
}));

/* ── THE REGISTER ──────────────────────────────────────────────────────── */

router.get("/files", requireCompany, canRead, handle(async (req, res) => {
  const out = await execution.listFiles(req.merchandising, {
    view: req.query.view,
    q: req.query.q,
    lifecycle: req.query.lifecycle,
    responsible: req.query.responsible,
    assignedTo: req.query.assignedTo,
    cursor: req.query.cursor,
    limit: req.query.limit,
      includeArchived: req.query.includeArchived === "true",
  });
  return res.json({ success: true, ...out });
}));

router.get("/files/:id", requireCompany, canRead, handle(async (req, res) => {
  const out = await execution.getFile(req.merchandising, { id: req.params.id });
  return res.json({ success: true, ...out });
}));

router.get("/files/:id/history", requireCompany, canRead, handle(async (req, res) => {
  const out = await execution.fileHistory(req.merchandising, { id: req.params.id });
  return res.json({ success: true, ...out });
}));

/* Merchandising's own notes and tags — never the projection, never the
   lifecycle. The service refuses server-owned fields by name. */
router.patch("/files/:id", requireCompany, canManage, handle(async (req, res) => {
  const out = await execution.patchFile(req.merchandising, {
    id: req.params.id, body: req.body || {}, actor: actor(req),
  });
  return res.json({ success: true, ...out });
}));

router.post("/files/:id/assignments", requireCompany, canAssign, handle(async (req, res) => {
  const out = await execution.assignFile(req.merchandising, {
    id: req.params.id, body: req.body || {}, actor: actor(req),
  });
  return res.status(201).json({ success: true, ...out });
}));

/* The lifecycle, one command per transition — a state is never a field. */
for (const command of ["hold", "resume", "close", "reopen"]) {
  router.post(`/files/:id/lifecycle/${command}`, requireCompany, canMoveLifecycle,
    handle(async (req, res) => {
      const out = await execution.moveLifecycle(req.merchandising, {
        id: req.params.id, command, body: req.body || {}, actor: actor(req),
      });
      return res.json({ success: true, ...out });
    }));
}

/* ══ M3 — MATERIALS & TRIMS, AND PACKAGING ════════════════════════════════
   Child resources of the Execution File, under its own id, because that is
   what they are: a selection has no life outside the file it is executed
   for. `:family` is MATERIAL_TRIM or PACKAGING and is resolved by the
   service, which 404s anything else rather than guessing.

   The permanent endpoints are HERE and not on the Sales or R&D routers. The
   transitional packaging screen still writes to `sample-styles`, and it keeps
   working; nothing permanent depends on it. */

/* ── Reads ─────────────────────────────────────────────────────────────── */

/* Both families at once — what the file's Summary needs in one call. */
router.get("/files/:id/selections", requireCompany, canRead, handle(async (req, res) => {
  const out = await selection.fileSelectionStatus(req.merchandising, { fileId: req.params.id });
  return res.json({ success: true, ...out });
}));

router.get("/files/:id/selections/:family", requireCompany, canRead, handle(async (req, res) => {
  const out = await selection.getCurrent(req.merchandising, {
    fileId: req.params.id, family: req.params.family,
  });
  return res.json({ success: true, ...out });
}));

router.get("/files/:id/selections/:family/revisions", requireCompany, canRead, handle(async (req, res) => {
  const out = await selection.listRevisions(req.merchandising, {
    fileId: req.params.id, family: req.params.family,
    cursor: req.query.cursor, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

router.get("/files/:id/selections/:family/revisions/:revisionNo", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await selection.getRevision(req.merchandising, {
      fileId: req.params.id, family: req.params.family, revisionNo: req.params.revisionNo,
    });
    return res.json({ success: true, ...out });
  }));

/* The frozen card, as a document. Authenticated like everything else — a
   printable revision is not a public record and does not become one by being
   printable. Only an approved or superseded revision resolves here. */
router.get("/files/:id/selections/:family/revisions/:revisionNo/printable",
  requireCompany, canRead, handle(async (req, res) => {
    const out = await selection.printableRevision(req.merchandising, {
      fileId: req.params.id, family: req.params.family, revisionNo: req.params.revisionNo,
    });
    return res.json({ success: true, ...out });
  }));

/* ── Draft authorship ──────────────────────────────────────────────────── */

router.post("/files/:id/selections/:family/revisions", requireCompany, canWriteSelection,
  handle(async (req, res) => {
    const out = await selection.createDraft(req.merchandising, {
      fileId: req.params.id, family: req.params.family,
      body: req.body || {}, actor: actor(req),
      idempotencyKey: idempotencyKey(req),
    });
    return res.status(out.replayed ? 200 : 201).json({ success: true, ...out });
  }));

router.post("/files/:id/selections/:family/rows", requireCompany, canWriteSelection,
  handle(async (req, res) => {
    const out = await selection.addRow(req.merchandising, {
      fileId: req.params.id, family: req.params.family,
      body: req.body || {}, actor: actor(req),
    });
    return res.status(201).json({ success: true, ...out });
  }));

router.patch("/files/:id/selections/:family/rows/:rowRef", requireCompany, canWriteSelection,
  handle(async (req, res) => {
    const out = await selection.updateRow(req.merchandising, {
      fileId: req.params.id, family: req.params.family, rowRef: req.params.rowRef,
      body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* Withdraw, not DELETE: the row leaves the draft and every revision it was
   approved in still carries it. A verb that says "gone" would be a lie. */
router.post("/files/:id/selections/:family/rows/:rowRef/withdraw", requireCompany, canWriteSelection,
  handle(async (req, res) => {
    const out = await selection.removeRow(req.merchandising, {
      fileId: req.params.id, family: req.params.family, rowRef: req.params.rowRef,
      body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

router.put("/files/:id/selections/:family/instructions", requireCompany, canWriteSelection,
  handle(async (req, res) => {
    const out = await selection.updateInstructions(req.merchandising, {
      fileId: req.params.id, family: req.params.family,
      body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

router.post("/files/:id/selections/:family/submit", requireCompany, canWriteSelection,
  handle(async (req, res) => {
    const out = await selection.submit(req.merchandising, {
      fileId: req.params.id, family: req.params.family,
      body: req.body || {}, actor: actor(req),
      idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

/* ── The decision ──────────────────────────────────────────────────────── */

router.post("/files/:id/selections/:family/approve", requireCompany, canApproveSelection,
  handle(async (req, res) => {
    const out = await selection.approve(req.merchandising, {
      fileId: req.params.id, family: req.params.family,
      body: req.body || {}, actor: actor(req),
      idempotencyKey: idempotencyKey(req),
    });
    /* The approval is already committed and is the answer regardless of what
       follows. `deliverPending` never throws; a sweep that could not run
       leaves the event to the next one. */
    const carried = await tnaDelivery.deliverPending({ companyId: req.merchandising.companyId, limit: 50 });
    return res.json({
      success: true,
      ...out,
      /* Stated rather than assumed: a client that shows "milestone closed"
         should show it because a milestone closed. */
      timeAndAction: { milestonesClosed: carried.applied, pending: carried.failures.length > 0 },
    });
  }));

router.post("/files/:id/selections/:family/request-changes", requireCompany, canApproveSelection,
  handle(async (req, res) => {
    const out = await selection.requestChanges(req.merchandising, {
      fileId: req.params.id, family: req.params.family,
      body: req.body || {}, actor: actor(req),
      idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

/* ── Transitional packaging, adopted ───────────────────────────────────── */

router.get("/files/:id/packaging-adoption/preview", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await adoption.previewLegacyPackaging(req.merchandising, { fileId: req.params.id });
    return res.json({ success: true, ...out });
  }));

router.post("/files/:id/packaging-adoption/adopt", requireCompany, canWriteSelection,
  handle(async (req, res) => {
    const out = await adoption.adoptLegacyPackaging(req.merchandising, {
      fileId: req.params.id, actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.status(out.replayed ? 200 : 201).json({ success: true, ...out });
  }));

/* ── Transitional development requirements, adopted ────────────────────── */

router.get("/files/:id/development-adoption/preview", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await adoption.previewLegacyDevelopment(req.merchandising, { fileId: req.params.id });
    return res.json({ success: true, ...out });
  }));

router.post("/files/:id/development-adoption/adopt", requireCompany, canWriteSelection,
  handle(async (req, res) => {
    const out = await adoption.adoptLegacyDevelopment(req.merchandising, {
      fileId: req.params.id, actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.status(out.replayed ? 200 : 201).json({ success: true, ...out });
  }));

/* ══ M4 — THE APPROVAL REGISTER ═══════════════════════════════════════════
   What this order is waiting to be approved, and by whom.

   ── THERE IS NO ENDPOINT THAT COMPLETES SOMEBODY ELSE'S APPROVAL ─────────
   Not one. `POST /approvals` and `PATCH /approvals/:ref` write the
   REQUIREMENT — category, applicability, required-by date, source reference
   — and the service refuses every decision field by name. `POST /observe`
   READS the source records and records what they said, taking no status from
   the caller. A Merchandising-owned row is not stored at all: it resolves
   live from Merchandising's own approved revisions.

   Their absence is asserted by test, so the next hand cannot add one. */

router.get("/files/:id/approvals", requireCompany, canRead, handle(async (req, res) => {
  const out = await approvals.readRegister(req.merchandising, { fileId: req.params.id });
  return res.json({ success: true, ...out });
}));

router.get("/files/:id/approvals/summary", requireCompany, canRead, handle(async (req, res) => {
  const out = await approvals.approvalSummary(req.merchandising, { fileId: req.params.id });
  return res.json({ success: true, ...out });
}));

router.get("/files/:id/approvals/:ref", requireCompany, canRead, handle(async (req, res) => {
  const out = await approvals.readDecision(req.merchandising, {
    fileId: req.params.id, approvalRequirementRef: req.params.ref,
  });
  return res.json({ success: true, ...out });
}));

/* Stating that an approval is REQUIRED is authoring, so it sits with the
   writer — the same authority that drafts a selection. */
router.post("/files/:id/approvals", requireCompany, canWriteSelection, handle(async (req, res) => {
  const out = await approvals.addRequirement(req.merchandising, {
    fileId: req.params.id, body: req.body || {}, actor: actor(req),
  });
  return res.status(201).json({ success: true, ...out });
}));

router.patch("/files/:id/approvals/:ref", requireCompany, canWriteSelection,
  handle(async (req, res) => {
    const out = await approvals.updateRequirement(req.merchandising, {
      fileId: req.params.id, approvalRequirementRef: req.params.ref,
      body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* Re-read the source records. A read of somebody else's fact, recorded with
   the moment it was taken — never a decision made here. */
router.post("/files/:id/approvals/observe", requireCompany, canWriteSelection,
  handle(async (req, res) => {
    const out = await approvals.observe(req.merchandising, {
      fileId: req.params.id, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* ── THE OVERVIEW ──────────────────────────────────────────────────────── */

router.get("/execution/overview", requireCompany, canRead, handle(async (req, res) => {
  const out = await execution.executionOverview(req.merchandising);
  return res.json({ success: true, ...out });
}));

module.exports = router;
