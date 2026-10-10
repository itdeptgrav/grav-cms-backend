// routes/CMS_Routes/Merchandising/developmentRoute.js
//
// PRE-ORDER DEVELOPMENT — MERCHANDISING'S SIDE.
//
// The sixth router on the Merchandising mount, and the first that is about
// work before an order exists.
//
// ── THE ROUTES THAT DO NOT EXIST ────────────────────────────────────────────
// There is no route that CREATES a development request — that is Sales', on
// Sales' own router. And there is no route that RELEASES a file to R&D:
// approving says Merchandising's selection is settled, releasing says the
// buyer relationship justifies spending the development budget, and the second
// is a commercial judgement Merchandising does not make. It arrives through
// Sales' own authorisation event.
//
// ── AUTHORITY, FROM THE EXISTING FOURTEEN ───────────────────────────────────
// No capability constant is added. Reading is `file.read`; answering Sales is
// `brief.review`, the same authority that accepts a handover; selecting is
// `selection.write`; approving is `selection.approve`; assigning is
// `file.assign`; holding and closing are `file.lifecycle`. Pre-order and
// post-order work are the same kinds of decision at different stages, so they
// are the same authorities.
"use strict";

const crypto = require("crypto");
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
const materialCatalogue = require("../../../services/merchandising/materialCatalogue.service");
const adoption = require("../../../services/merchandising/developmentAdoption.service");
const legacy = require("../../../services/merchandising/developmentLegacy.service");
const {
  MerchandisingAuditEvent,
} = require("../../../models/CMS_Models/Merchandising/MerchandisingEvent");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "Merchandising" });
const canRead = merchandisingCapability(CAPABILITY.FILE_READ);
const canReview = merchandisingCapability(CAPABILITY.BRIEF_REVIEW);
const canSelect = merchandisingCapability(CAPABILITY.SELECTION_WRITE);
const canApprove = merchandisingCapability(CAPABILITY.SELECTION_APPROVE);
const canAssign = merchandisingCapability(CAPABILITY.FILE_ASSIGN);
const canMoveLifecycle = merchandisingCapability(CAPABILITY.FILE_LIFECYCLE);

const actor = (req) => (req.user?.id
  ? { id: req.user.id, name: req.user.name || "", email: req.user.email || "" }
  : null);

const ctx = (req) => ({ ...req.merchandising, actorEmail: req.user?.email || "" });

const idempotencyKey = (req) => String(
  req.get("Idempotency-Key") || req.body?.idempotencyKey || "",
).trim();

/* ═══ STORE'S CATALOGUE, THROUGH A KEYHOLE ════════════════════════════════
   Mounted at `/catalogue/...` and not under `/development/...` for a reason
   that is not taste: `/development/:fileId` would swallow any sibling added
   beside it, and this is not a property of one file in any case.

   Behind `selection.write` rather than `file.read`. Reading a development
   file does not require a way to enumerate Store's item master, and the only
   thing this list is for is writing a selection — so the grant that opens it
   is the grant to write one. A viewer sees every row already chosen and no
   way to browse the catalogue, which is exactly their authority.

   It is NOT Store's `/api/cms/raw-items`, and the service header says why at
   length: that endpoint needs a Store grant and answers with stock balances,
   vendors and prices. */
router.get("/catalogue/materials", requireCompany, canSelect, handle(async (req, res) => {
  const out = await materialCatalogue.search(ctx(req), {
    q: req.query.q, category: req.query.category, section: req.query.section,
    cursor: req.query.cursor, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

/** What the registration drawer's form may offer: Store's shelves, this
    company's units, and the classifications a garment BOM uses. Behind the
    same grant as the search, because it is only ever read to fill that form. */
router.get("/catalogue/registration-options", requireCompany, canSelect,
  handle(async (req, res) => {
    const out = await materialCatalogue.registrationOptions(ctx(req));
    return res.json({ success: true, ...out });
  }));

/* ── REGISTERING A MATERIAL STORE DOES NOT HAVE YET ────────────────────────
   Behind `selection.write` — the SAME grant as browsing the catalogue, and
   deliberately not Store's `sp.master.maintain`. The authority to choose
   materials for a style is the authority to name one that is missing; the
   service header states at length what this does NOT thereby grant, and the
   shared creation service enforces it by section rather than by trust.

   `fileId` is required, and not for authorisation — the grant is the caller's,
   not the file's. It is required so the audit row can say WHY the item exists:
   a Store catalogue with items appearing in it and no reason attached is how
   nobody can later answer "who added this and what for". The file is loaded
   through Merchandising's own scoped loader, so a file from another company
   answers as one that does not exist.

   ── ONE OPERATION, NOT TWO ────────────────────────────────────────────────
   The item and the audit row that explains it are written in ONE transaction,
   with the idempotency ledger row in the same commit. Three things follow, and
   each one was wrong before:

     · an audit write that fails cannot leave an item registered with no record
       of who registered it or why — the item is rolled back with it;
     · a retry of a request that already succeeded gets the FIRST answer back
       verbatim, rather than a duplicate-material conflict for the item it
       itself created a moment ago;
     · two requests arriving together produce one item, because the loser meets
       either the ledger's unique index or the catalogue's — never a second row.

   The key comes from the `Idempotency-Key` header, as every other command on
   this router takes it. */
router.post("/catalogue/materials", requireCompany, canSelect, handle(async (req, res) => {
  const context = ctx(req);
  const who = actor(req);

  const out = await development.onceAtomically(context, {
    scope: `dev:material:register:${String(req.body?.fileId || "")}`,
    idempotencyKey: idempotencyKey(req),
    /* What "the same request" means. A different material under the same key is
       a client bug and is refused rather than answered with the first one. */
    request: {
      fileId: String(req.body?.fileId || ""),
      name: String(req.body?.name || "").trim(),
      category: String(req.body?.category || ""),
      unit: String(req.body?.unit || ""),
      usedAs: String(req.body?.usedAs || ""),
    },
  }, async (session) => {
    /* Loaded inside the transaction, so a file cancelled while this was in
       flight is not written against. */
    const file = await development.loadFile(context, req.body?.fileId, session);

    /* The body goes through WHOLE, deliberately. Hand-picking the fields this
       door accepts would DROP everything else on the way in — so a caller who
       sent a purchase price would get a 201 and believe it was recorded. The
       service decides what is permitted and refuses the rest by name. */
    const made = await materialCatalogue.register(context, req.body, req.user?.id, session);

    /* Recorded in MERCHANDISING's history, sourced to Merchandising, naming the
       Store item in `details`. The item's own creation is Store's record; this
       is the statement of why it was created and by whom, against the file that
       needed it. In the same transaction, so neither can exist without the
       other. */
    await MerchandisingAuditEvent.create([development.auditRow({
      file,
      recordType: "DEVELOPMENT_FILE",
      recordId: file._id,
      action: "DEVELOPMENT_MATERIAL_REGISTERED",
      actor: who,
      at: new Date(),
      correlationId: idempotencyKey(req) || crypto.randomUUID(),
      details: {
        rawItemId: made.item.rawItemId,
        rawItemName: made.item.name,
        rawItemSku: made.item.sku,
        category: made.item.category,
        unit: made.item.unit,
        usedAs: made.item.usedAs,
        sourceDepartment: "merchandising",
        sourceScreen: "DEVELOPMENT_BOM",
      },
    })], { session, ordered: true });

    return made;
  });

  /* A replay is the same answer, and says so, rather than pretending a second
     item was created. */
  return res.status(out.replayed ? 200 : 201).json({ success: true, ...out });
}));

/* ═══ THE REGISTER ═════════════════════════════════════════════════════════
   Before the `/:fileId` patterns, so `overview` is never read as a file id. */

router.get("/development/overview", requireCompany, canRead, handle(async (req, res) => {
  const out = await development.developmentOverview(ctx(req));
  return res.json({ success: true, ...out });
}));

router.get("/development", requireCompany, canRead, handle(async (req, res) => {
  const out = await development.listFiles(ctx(req), {
    view: req.query.view, q: req.query.q, assignedTo: req.query.assignedTo,
    includeArchived: req.query.includeArchived === "true",
    /* What the Overview's clarification count opens. Asking Sales a question
       does not move the lifecycle, so this is a filter on the receipt rather
       than a view. */
    awaitingClarification: req.query.awaitingClarification === "true",
    cursor: req.query.cursor, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

/* ═══ ONE DEVELOPMENT FILE ═════════════════════════════════════════════════ */

router.get("/development/:fileId", requireCompany, canRead, handle(async (req, res) => {
  const out = await development.getFile(ctx(req), { fileId: req.params.fileId });
  return res.json({ success: true, ...out });
}));

router.get("/development/:fileId/history", requireCompany, canRead, handle(async (req, res) => {
  const out = await development.fileHistory(ctx(req), {
    fileId: req.params.fileId, cursor: req.query.cursor, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

/** The registered product's approved BOM, as read-only source evidence. */
router.get("/development/:fileId/registered-product-bom", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await development.registeredProductBom(ctx(req), { fileId: req.params.fileId });
    return res.json({ success: true, ...out });
  }));

/* ── ANSWERING SALES ─────────────────────────────────────────────────────
   `brief.review` — the same authority that accepts a Sales handover, because
   it is the same kind of act one stage earlier. */

router.post("/development/:fileId/accept", requireCompany, canReview, handle(async (req, res) => {
  const out = await development.acceptRequest(ctx(req), {
    fileId: req.params.fileId, actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.json({ success: true, ...out });
}));

router.post("/development/:fileId/clarify", requireCompany, canReview, handle(async (req, res) => {
  const out = await development.clarifyRequest(ctx(req), {
    fileId: req.params.fileId, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.json({ success: true, ...out });
}));

router.post("/development/:fileId/assignments", requireCompany, canAssign, handle(async (req, res) => {
  const out = await development.assignFile(ctx(req), {
    fileId: req.params.fileId, body: req.body || {}, actor: actor(req),
  });
  return res.json({ success: true, ...out });
}));

router.post("/development/:fileId/lifecycle/:command", requireCompany, canMoveLifecycle,
  handle(async (req, res) => {
    const out = await development.moveLifecycle(ctx(req), {
      fileId: req.params.fileId, command: req.params.command,
      body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* ═══ THE SELECTION ════════════════════════════════════════════════════════
   Writing and DECIDING are different authorities, as everywhere else in this
   module: `selection.write` composes a draft, `selection.approve` settles it,
   and the approver may not be its author. */

router.post("/development/:fileId/bom", requireCompany, canSelect, handle(async (req, res) => {
  const out = await development.createDraft(ctx(req), {
    fileId: req.params.fileId, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.status(201).json({ success: true, ...out });
}));

/** Bring the registered product's identities across. Approves nothing. */
router.post("/development/:fileId/bom/adopt-product", requireCompany, canSelect,
  handle(async (req, res) => {
    const out = await development.adoptRegisteredProductBom(ctx(req), {
      fileId: req.params.fileId, body: req.body || {},
      actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

router.post("/development/:fileId/bom/rows", requireCompany, canSelect, handle(async (req, res) => {
  const out = await development.addRow(ctx(req), {
    fileId: req.params.fileId, body: req.body || {}, actor: actor(req),
  });
  return res.status(201).json({ success: true, ...out });
}));

router.patch("/development/:fileId/bom/rows/:rowRef", requireCompany, canSelect,
  handle(async (req, res) => {
    const out = await development.updateRow(ctx(req), {
      fileId: req.params.fileId, rowRef: req.params.rowRef,
      body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

router.delete("/development/:fileId/bom/rows/:rowRef", requireCompany, canSelect,
  handle(async (req, res) => {
    const out = await development.removeRow(ctx(req), {
      fileId: req.params.fileId, rowRef: req.params.rowRef,
      body: { ...(req.body || {}), expectedRevision: req.body?.expectedRevision ?? req.query.expectedRevision },
      actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* Submitting sits with the WRITER: advancing your own draft for somebody else
   to read is not an approval, and requiring the approver capability would mean
   an editor could never move their own work at all. The separation the process
   needs is enforced in `approve`. */
router.post("/development/:fileId/bom/submit", requireCompany, canSelect, handle(async (req, res) => {
  const out = await development.submitBom(ctx(req), {
    fileId: req.params.fileId, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  /* Sales is told, with the full material table (4 Oct 2026) — best effort */
  require("../../../services/merchandising/developmentNotify.service")
    .notifyDevelopmentBom("submitted", { companyId: req.merchandising.companyId, fileId: req.params.fileId, revisionNo: out?.revisionNo ?? null, actor: actor(req) })
    .catch((e) => console.error("[developmentRoute] submit mail:", e?.message || e));
  return res.json({ success: true, ...out });
}));

router.post("/development/:fileId/bom/approve", requireCompany, canApprove, handle(async (req, res) => {
  const out = await development.approveBom(ctx(req), {
    fileId: req.params.fileId, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.json({ success: true, ...out });
}));

router.post("/development/:fileId/bom/request-changes", requireCompany, canApprove,
  handle(async (req, res) => {
    const out = await development.requestChanges(ctx(req), {
      fileId: req.params.fileId, body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* ═══ LEGACY MIGRATION ═════════════════════════════════════════════════════
   Preview then adopt, never automatically, and the legacy record is only ever
   read — see the service for why an unreviewed selection must not become an
   approved one by being moved. */

router.get("/development/:fileId/legacy/preview", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await legacy.preview(ctx(req), { fileId: req.params.fileId });
    return res.json({ success: true, ...out });
  }));

router.post("/development/:fileId/legacy/adopt", requireCompany, canSelect,
  handle(async (req, res) => {
    const out = await legacy.adopt(ctx(req), {
      fileId: req.params.fileId, body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* ═══ CONFIRMED-ORDER ADOPTION ═════════════════════════════════════════════
   On the EXECUTION file, because that is the record being adopted into. */

router.get("/files/:id/development-bom-adoption/preview", requireCompany, canRead,
  handle(async (req, res) => {
    const out = await adoption.preview(req.merchandising, { fileId: req.params.id });
    return res.json({ success: true, ...out });
  }));

router.post("/files/:id/development-bom-adoption/adopt", requireCompany, canSelect,
  handle(async (req, res) => {
    const out = await adoption.adopt(req.merchandising, {
      fileId: req.params.id, actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

module.exports = router;
