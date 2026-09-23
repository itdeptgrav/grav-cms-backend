// services/merchandising/development.service.js
//
// MERCHANDISING SELECTS THE MATERIALS. BEFORE THERE IS AN ORDER.
//
// The pre-order half of the application: accept what Sales asked for, choose
// the fabric, trims, labels, accessories and sample packaging, put the
// selection through maker/checker, and publish the approved revision so R&D
// can engineer consumption and Costing can price it.
//
// ── WHAT THIS SERVICE WILL NOT RECORD ───────────────────────────────────────
// No consumption, allowance or wastage — R&D engineers those for this style,
// and a figure copied here would be presented as established by a record that
// established nothing. No supplier, quotation, rate or cost — Costing and
// Supply Chain own those. No purchase order, stock, receipt, reservation or
// issue quantity — Store's. No sample construction result — R&D's again.
//
// Each of those belongs to a department that is not Merchandising, and the
// model has no field for any of them. What Merchandising states is IDENTITY:
// which material, in which colour and finish, on which part of the garment.
//
// ── AND MERCHANDISING DOES NOT RELEASE ITS OWN WORK ─────────────────────────
// Approving says the selection is settled. RELEASING says the buyer
// relationship justifies spending the development budget on sampling, and
// that is Sales' commercial judgement. There is no route here that sets
// `RELEASED_TO_RND`; it arrives through Sales' own authorisation event.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const {
  SalesDevelopmentRequest, REQUEST_STATE,
} = require("../../models/CMS_Models/Sales/DevelopmentRequest");
const {
  DevelopmentFile, DevelopmentRequestReceipt, DevelopmentBomRevision,
  RECEIPT_STATE, CLARIFICATION_CATEGORY, MIN_REASON, LIFECYCLE, BOM_STATE, ROW_CATEGORY,
} = require("../../models/CMS_Models/Merchandising/Development");
const {
  MerchandisingAuditEvent, MerchandisingOutboxEvent, MerchandisingCommandLedger, OUTBOX_KIND,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { stockItemBom } = require("../sampleStyleEmail.service");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** The register's views, and the lifecycle each shows. */
const FILE_VIEWS = Object.freeze({
  new: [LIFECYCLE.NEW],
  active: [LIFECYCLE.ACTIVE],
  "awaiting-approval": [LIFECYCLE.AWAITING_APPROVAL],
  approved: [LIFECYCLE.APPROVED],
  "released-to-rnd": [LIFECYCLE.RELEASED_TO_RND],
  closed: [LIFECYCLE.CLOSED, LIFECYCLE.CANCELLED],
  all: null,
});

const isFileView = (v) => Object.prototype.hasOwnProperty.call(FILE_VIEWS, str(v).toLowerCase());

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

async function withTxn(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } catch (err) {
    if (/Transaction numbers|replica set|transactions are not supported/i.test(str(err?.message))) {
      throw fail("MERCHANDISING_TRANSACTION_REQUIRED",
        "This deployment cannot record the decision atomically. Ask an operator — the database needs a replica set.");
    }
    throw err;
  } finally { session.endSession(); }
}

const hashRequest = (r) => crypto.createHash("sha256").update(JSON.stringify(r ?? null)).digest("hex");

async function once(ctx, { scope, idempotencyKey, request }, run) {
  const key = str(idempotencyKey);
  if (!key) {
    throw fail("IDEMPOTENCY_KEY_REQUIRED",
      "Send an idempotency key with this command, so a retry cannot take the decision twice.",
      { field: "idempotencyKey" });
  }
  const requestHash = hashRequest(request);
  const held = await MerchandisingCommandLedger.findOne({
    companyId: ctx.companyId, scope, idempotencyKey: key,
  }).lean();
  if (held) {
    if (held.requestHash !== requestHash) {
      throw fail("IDEMPOTENCY_KEY_REUSED",
        "That idempotency key was already used for a different request.", { field: "idempotencyKey" });
    }
    return { replayed: true, ...held.result };
  }
  const result = await run();
  try {
    await MerchandisingCommandLedger.create([{
      companyId: ctx.companyId, scope, idempotencyKey: key, requestHash,
      result: {
        revisionNo: result?.revisionNo ?? null,
        state: str(result?.state), note: str(result?.note),
      },
      at: new Date(),
    }]);
  } catch (err) { if (err?.code !== 11000) throw err; }
  return { replayed: false, ...result };
}

async function loadFile(ctx, fileId, session = null) {
  assertContext(ctx);
  if (!isId(fileId)) throw fail("DEVELOPMENT_FILE_NOT_FOUND", "Development file not found.");
  const q = DevelopmentFile.findOne({ _id: fileId, companyId: ctx.companyId });
  const file = session ? await q.session(session) : await q;
  if (!file) throw fail("DEVELOPMENT_FILE_NOT_FOUND", "Development file not found.");
  return file;
}

function assertExpected(doc, expected, what) {
  if (expected === undefined || expected === null || expected === "") {
    throw fail("VALIDATION", `Say which revision of the ${what} you are changing.`,
      { field: "expectedRevision" });
  }
  if (Number(expected) !== Number(doc.revision ?? 0)) {
    throw fail("REVISION_CONFLICT",
      `Somebody else changed this ${what} while you were working. Reload and try again.`,
      { expected: Number(expected), actual: Number(doc.revision ?? 0) });
  }
}

/** A file that is finished or withdrawn takes no more work. */
function assertWorkable(file) {
  if ([LIFECYCLE.CANCELLED, LIFECYCLE.CLOSED].includes(file.lifecycleStatus)) {
    throw fail("DEVELOPMENT_STATE_CONFLICT",
      `This development file is ${str(file.lifecycleStatus).toLowerCase()}.`,
      { lifecycleStatus: file.lifecycleStatus });
  }
}

const auditRow = ({ file, recordType, recordId, action, actor, at, correlationId,
  details, reason = "", previousState = "", resultingState = "" }) => ({
  companyId: file.companyId,
  recordType,
  recordId,
  developmentFileId: file._id,
  developmentNumber: str(file.developmentNumber),
  action,
  actor: actor || undefined,
  source: "merchandising",
  at: at || new Date(),
  reason: str(reason),
  correlationId,
  previousState: str(previousState),
  resultingState: str(resultingState),
  details: details || {},
});

/* ═══ VIEWS ════════════════════════════════════════════════════════════════ */

const fileView = (f) => (f ? {
  id: str(f._id),
  developmentNumber: str(f.developmentNumber),
  journeyId: str(f.journeyId),
  journeyRef: str(f.journeyRef),
  productLineRef: str(f.productLineRef),
  productName: str(f.productName),
  styleRef: str(f.styleRef),
  buyerDisplayLabel: str(f.buyerDisplayLabel),
  sampleStyleId: f.sampleStyleId ? str(f.sampleStyleId) : null,
  stockItemId: f.stockItemId ? str(f.stockItemId) : null,
  requiredByDate: f.requiredByDate || null,
  lifecycleStatus: str(f.lifecycleStatus),
  lifecycleReason: str(f.lifecycleReason),
  responsibleMerchandiser: f.responsibleMerchandiser?.email
    ? { name: str(f.responsibleMerchandiser.name), email: str(f.responsibleMerchandiser.email) }
    : null,
  currentRequestVersionNo: f.currentRequestVersionNo ?? null,
  currentBomRevisionNo: f.currentBomRevisionNo ?? null,
  releasedToRndAt: f.releasedToRndAt || null,
  releasedByName: str(f.releasedBy?.name),
  releaseReference: str(f.releaseReference),
  coordinationNote: str(f.coordinationNote),
  archived: f.archived === true,
  revision: f.revision ?? 0,
  updatedAt: f.updatedAt || null,
  createdAt: f.createdAt || null,
} : null);

const rowView = (r) => ({
  rowRef: str(r.rowRef),
  category: str(r.category),
  rawItemId: r.rawItemId ? str(r.rawItemId) : null,
  rawItemName: str(r.rawItemName),
  rawItemSku: str(r.rawItemSku),
  variantId: r.variantId ? str(r.variantId) : null,
  variantCombination: (r.variantCombination || []).map(str),
  colourOrShade: str(r.colourOrShade),
  finish: str(r.finish),
  placement: str(r.placement),
  appliesTo: str(r.appliesTo),
  selectionNote: str(r.selectionNote),
  source: r.source ? {
    kind: str(r.source.kind),
    stockItemId: r.source.stockItemId ? str(r.source.stockItemId) : null,
    reference: str(r.source.reference),
    observedAt: r.source.observedAt || null,
  } : null,
});

const bomView = (b) => (b ? {
  id: str(b._id),
  revisionNo: b.revisionNo,
  state: str(b.state),
  rows: (b.rows || []).map(rowView),
  rowCount: (b.rows || []).length,
  clonedFromRevisionNo: b.clonedFromRevisionNo ?? null,
  submittedByName: str(b.submittedBy?.name),
  submittedAt: b.submittedAt || null,
  approvedByName: str(b.approvedBy?.name),
  approvedAt: b.approvedAt || null,
  changesRequestedByName: str(b.changesRequestedBy?.name),
  changesRequestedAt: b.changesRequestedAt || null,
  changeReason: str(b.changeReason),
  supersededByRevisionNo: b.supersededByRevisionNo ?? null,
  revision: b.revision ?? 0,
} : null);

const receiptView = (r, request) => {
  if (!request) return null;
  if (!r) {
    /* PENDING computed, never stored. */
    return {
      state: "PENDING",
      sentence: "Merchandising has not answered this request yet.",
      decidedByName: "", decidedAt: null, clarification: null,
      requestVersionNo: request.versionNo,
    };
  }
  return {
    state: str(r.state),
    sentence: r.state === RECEIPT_STATE.ACCEPTED
      ? "Merchandising accepted this request."
      : r.state === RECEIPT_STATE.CLARIFICATION_REQUESTED
        ? "Merchandising has asked Sales a question."
        : r.state === RECEIPT_STATE.SUPERSEDED
          ? "A later version of the request replaced the one this answered."
          : "Sales withdrew the request.",
    decidedByName: str(r.decidedBy?.name),
    decidedAt: r.decidedAt || null,
    clarification: r.clarification?.category
      ? { category: str(r.clarification.category), reason: str(r.clarification.reason) }
      : null,
    requestVersionNo: r.requestVersionNo,
  };
};

/* ═══ READS ════════════════════════════════════════════════════════════════ */

/** The cross-file Development register. */
async function listFiles(ctx, { view = "active", q = "", assignedTo = "", includeArchived = false,
  awaitingClarification = false, cursor, limit } = {}) {
  assertContext(ctx);
  if (!isFileView(view)) {
    throw fail("VALIDATION", `"${view}" is not a Development view.`,
      { field: "view", allowed: Object.keys(FILE_VIEWS) });
  }
  const size = Math.min(Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT, MAX_LIMIT);
  const statuses = FILE_VIEWS[str(view).toLowerCase()];

  const filter = { companyId: ctx.companyId };
  if (statuses) filter.lifecycleStatus = { $in: statuses };
  if (!includeArchived) filter.archived = { $ne: true };
  if (str(assignedTo) === "me" && str(ctx.actorEmail)) {
    filter["responsibleMerchandiser.email"] = str(ctx.actorEmail).toLowerCase();
  } else if (str(assignedTo) && str(assignedTo) !== "me") {
    filter["responsibleMerchandiser.email"] = str(assignedTo).toLowerCase();
  }
  if (str(q)) {
    const rx = new RegExp(str(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { developmentNumber: rx }, { productName: rx },
      { styleRef: rx }, { buyerDisplayLabel: rx }, { journeyRef: rx },
    ];
  }
  /* ── THE OVERVIEW'S CLARIFICATION COUNT OPENS THIS ────────────────────
     Asking Sales a question does not move the file's lifecycle — it is still
     a new request, it is just one where the next move is Sales'. So the filter
     cannot be a lifecycle and has to be the RECEIPT.

     The ids are resolved BEFORE paging, not after. Filtering the page after it
     is fetched would silently return short pages and a cursor that skipped
     rows, which is the sort of paging bug nobody notices until somebody counts.
     An empty set is `$in: []`, which matches nothing — the honest answer when
     no clarification is open. */
  if (awaitingClarification === true) {
    const open = await DevelopmentRequestReceipt.find({
      companyId: ctx.companyId, state: RECEIPT_STATE.CLARIFICATION_REQUESTED,
    }).select("developmentFileId").lean();
    filter._id = { $in: open.map((r) => r.developmentFileId) };
  }

  if (str(cursor)) {
    const at = new Date(Number(cursor));
    if (Number.isNaN(at.getTime())) {
      throw fail("VALIDATION", "That page marker is not one this list issued.", { field: "cursor" });
    }
    filter.updatedAt = { $lt: at };
  }

  const files = await DevelopmentFile.find(filter)
    .sort({ updatedAt: -1, _id: -1 }).limit(size + 1).lean();
  const page = files.slice(0, size);

  /* One lookup each for the page's BOMs and receipts, not one per row. */
  const [boms, receipts] = await Promise.all([
    DevelopmentBomRevision.find({
      companyId: ctx.companyId, developmentFileId: { $in: page.map((f) => f._id) },
      state: { $in: [BOM_STATE.DRAFT, BOM_STATE.SUBMITTED, BOM_STATE.APPROVED] },
    }).select("developmentFileId revisionNo state").lean(),
    DevelopmentRequestReceipt.find({
      companyId: ctx.companyId, developmentFileId: { $in: page.map((f) => f._id) },
      state: RECEIPT_STATE.CLARIFICATION_REQUESTED,
    }).select("developmentFileId").lean(),
  ]);
  const bomByFile = new Map();
  for (const b of boms) {
    const key = str(b.developmentFileId);
    const held = bomByFile.get(key) || {};
    held[b.state] = b.revisionNo;
    bomByFile.set(key, held);
  }
  const clarifying = new Set(receipts.map((r) => str(r.developmentFileId)));

  return {
    rows: page.map((f) => ({
      ...fileView(f),
      bom: bomByFile.get(str(f._id)) || {},
      awaitingClarification: clarifying.has(str(f._id)),
    })),
    nextCursor: files.length > size
      ? String(new Date(page[page.length - 1].updatedAt).getTime()) : null,
    hasMore: files.length > size,
    views: Object.keys(FILE_VIEWS),
  };
}

/** The counts behind the Overview's Development indicators. */
async function developmentOverview(ctx) {
  assertContext(ctx);
  const [byLifecycle, clarifications] = await Promise.all([
    DevelopmentFile.aggregate([
      { $match: { companyId: ctx.companyId, archived: { $ne: true } } },
      { $group: { _id: "$lifecycleStatus", n: { $sum: 1 } } },
    ]),
    DevelopmentRequestReceipt.countDocuments({
      companyId: ctx.companyId, state: RECEIPT_STATE.CLARIFICATION_REQUESTED,
    }),
  ]);
  const by = Object.fromEntries(byLifecycle.map((r) => [str(r._id), r.n]));
  return {
    counts: {
      newDevelopmentRequests: by[LIFECYCLE.NEW] || 0,
      awaitingSelection: by[LIFECYCLE.ACTIVE] || 0,
      awaitingInternalApproval: by[LIFECYCLE.AWAITING_APPROVAL] || 0,
      developmentClarifications: clarifications,
      /* Approved and waiting on SALES to authorise the spend. */
      awaitingSalesRelease: by[LIFECYCLE.APPROVED] || 0,
    },
    generatedAt: new Date(),
  };
}

/** One file, with its request, its answer and its BOM revisions. */
async function getFile(ctx, { fileId } = {}) {
  const file = await loadFile(ctx, fileId);
  const [request, receipt, boms] = await Promise.all([
    file.currentRequestId
      ? SalesDevelopmentRequest.findOne({
        _id: file.currentRequestId, companyId: ctx.companyId,
      }).lean()
      : null,
    file.currentRequestId
      ? DevelopmentRequestReceipt.findOne({
        companyId: ctx.companyId, requestId: file.currentRequestId,
      }).lean()
      : null,
    DevelopmentBomRevision.find({ companyId: ctx.companyId, developmentFileId: file._id })
      .sort({ revisionNo: -1 }).lean(),
  ]);

  const current = boms.find((b) => b.state === BOM_STATE.DRAFT)
    || boms.find((b) => b.state === BOM_STATE.SUBMITTED)
    || boms.find((b) => b.state === BOM_STATE.APPROVED)
    || null;

  return {
    file: fileView(file),
    /* Sales' brief, read-only. Merchandising never edits it. */
    request: request ? {
      requestRef: str(request.requestRef),
      versionNo: request.versionNo,
      state: str(request.state),
      requirementSummary: str(request.requirementSummary),
      requestedCategories: (request.requestedCategories || []).map(str),
      referenceImages: (request.referenceImages || [])
        .map((i) => ({ url: str(i.url), caption: str(i.caption) })),
      requiredByDate: request.requiredByDate || null,
      requestedByName: str(request.requestedBy?.name),
      requestedAt: request.requestedAt || null,
      productName: str(request.productName),
      styleRef: str(request.styleRef),
      buyerDisplayLabel: str(request.buyerDisplayLabel),
      stockItemId: request.stockItemId ? str(request.stockItemId) : null,
    } : null,
    receipt: receiptView(receipt, request),
    currentBom: bomView(current),
    approvedBom: bomView(boms.find((b) => b.state === BOM_STATE.APPROVED) || null),
    revisions: boms.map((b) => ({ ...bomView(b), rows: undefined })),
    clarificationCategories: CLARIFICATION_CATEGORY,
    rowCategories: Object.values(ROW_CATEGORY),
  };
}

/** One file's history, newest first. */
async function fileHistory(ctx, { fileId, cursor, limit } = {}) {
  const file = await loadFile(ctx, fileId);
  const size = Math.min(Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT, MAX_LIMIT);
  const query = { companyId: ctx.companyId, developmentFileId: file._id };
  if (str(cursor)) {
    const at = new Date(Number(cursor));
    if (Number.isNaN(at.getTime())) {
      throw fail("VALIDATION", "That page marker is not one this list issued.", { field: "cursor" });
    }
    query.at = { $lt: at };
  }
  const rows = await MerchandisingAuditEvent.find(query)
    .sort({ at: -1, _id: -1 }).limit(size + 1).lean();
  const page = rows.slice(0, size);
  return {
    rows: page.map((e) => ({
      id: str(e._id), action: str(e.action), at: e.at,
      actorName: str(e.actor?.name), source: str(e.source), reason: str(e.reason),
      previousState: str(e.previousState), resultingState: str(e.resultingState),
      details: e.details && typeof e.details === "object" ? e.details : null,
    })),
    nextCursor: rows.length > size ? String(new Date(page[page.length - 1].at).getTime()) : null,
    hasMore: rows.length > size,
  };
}

/**
 * The registered product's approved BOM, as SOURCE EVIDENCE.
 *
 * Read-only, and never adopted automatically. A repeat order's materials are
 * usually right and occasionally not — the buyer changed a trim, the mill
 * discontinued a cloth — so a merchandiser looks at what the product is built
 * from and decides. Adopting is a separate, deliberate act.
 */
async function registeredProductBom(ctx, { fileId } = {}) {
  const file = await loadFile(ctx, fileId);
  if (!file.stockItemId) {
    return {
      available: false,
      /* Not a failure. A custom style has no registered product, and material
         selection does not wait for one to be created. */
      sentence: "This is a new or custom style, so there is no registered product to reuse. "
        + "Select the materials directly.",
      rows: [],
    };
  }
  const stockItem = await StockItem.findById(file.stockItemId)
    .select("name reference variants").lean().catch(() => null);
  const bom = stockItemBom(stockItem);
  if (!bom.length) {
    return {
      available: false,
      sentence: `${str(stockItem?.name) || "That registered product"} has no approved bill of `
        + "materials yet, so there is nothing to adopt.",
      rows: [],
    };
  }
  return {
    available: true,
    stockItemId: str(file.stockItemId),
    stockItemName: str(stockItem?.name),
    stockItemReference: str(stockItem?.reference),
    sentence: "This is what the registered product is built from. Adopting it starts a draft; "
      + "it does not approve anything.",
    /* IDENTITY ONLY. The product BOM carries quantity, allowance and cost;
       none of them crosses into a development selection — see the header. */
    rows: bom.map((r) => ({
      rawItemId: r.rawItemId ? str(r.rawItemId) : null,
      rawItemName: str(r.rawItemName),
      rawItemSku: str(r.rawItemSku),
      variantId: r.variantId ? str(r.variantId) : null,
      variantCombination: (r.variantCombination || []).map(str),
      appliesToVariantLabels: (r.variantLabels || []).map(str),
    })),
  };
}

/* ═══ COMMANDS — THE FILE ══════════════════════════════════════════════════ */

/** ACCEPT — Merchandising has the brief and will select against it. */
async function acceptRequest(ctx, { fileId, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);
  assertWorkable(file);
  if (!file.currentRequestId) {
    throw fail("DEVELOPMENT_REQUEST_NOT_FOUND", "This file has no live request to accept.");
  }

  return once(ctx, {
    scope: `dev:accept:${str(file.currentRequestId)}`,
    idempotencyKey,
    request: { requestId: str(file.currentRequestId) },
  }, async () => withTxn(async (session) => {
    const live = await DevelopmentFile.findById(file._id).session(session);
    const existing = await DevelopmentRequestReceipt.findOne({
      companyId: ctx.companyId, requestId: live.currentRequestId,
    }).session(session);
    if (existing) {
      throw fail("DEVELOPMENT_ALREADY_DECIDED",
        `Merchandising already answered version ${live.currentRequestVersionNo} — `
        + `${str(existing.state).toLowerCase().replace(/_/g, " ")}.`,
        { state: existing.state });
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    await DevelopmentRequestReceipt.create([{
      companyId: ctx.companyId,
      requestRef: str((await SalesDevelopmentRequest.findById(live.currentRequestId)
        .select("requestRef").session(session).lean())?.requestRef),
      requestVersionNo: live.currentRequestVersionNo,
      requestId: live.currentRequestId,
      developmentFileId: live._id,
      state: RECEIPT_STATE.ACCEPTED,
      decidedBy: actor || undefined,
      decidedAt: at,
    }], { session });

    const previous = live.lifecycleStatus;
    if (live.lifecycleStatus === LIFECYCLE.NEW) live.lifecycleStatus = LIFECYCLE.ACTIVE;
    live.revision += 1;
    live.updatedBy = actor || undefined;
    await live.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file: live, recordType: "DEVELOPMENT_REQUEST", recordId: live.currentRequestId,
      action: "DEVELOPMENT_ACCEPTED", actor, at, correlationId,
      previousState: previous, resultingState: live.lifecycleStatus,
      details: { requestVersionNo: live.currentRequestVersionNo },
    })], { session, ordered: true });

    return {
      developmentNumber: str(live.developmentNumber), state: live.lifecycleStatus,
      note: "Accepted. Select the materials next.",
    };
  }));
}

/** CLARIFY — ask Sales a question, with a category and a usable reason. */
async function clarifyRequest(ctx, { fileId, body = {}, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);
  assertWorkable(file);
  const category = str(body?.category).toUpperCase();
  const reason = str(body?.reason);
  if (!CLARIFICATION_CATEGORY.includes(category)) {
    throw fail("VALIDATION", "Say what kind of clarification this is.",
      { field: "category", allowed: CLARIFICATION_CATEGORY });
  }
  if (reason.length < MIN_REASON) {
    throw fail("VALIDATION",
      "This goes back to a salesperson who has to act on it, so say enough to act on.",
      { field: "reason", minimum: MIN_REASON });
  }

  return once(ctx, {
    scope: `dev:clarify:${str(file.currentRequestId)}`,
    idempotencyKey,
    request: { requestId: str(file.currentRequestId), category, reason },
  }, async () => withTxn(async (session) => {
    const live = await DevelopmentFile.findById(file._id).session(session);
    const existing = await DevelopmentRequestReceipt.findOne({
      companyId: ctx.companyId, requestId: live.currentRequestId,
    }).session(session);
    if (existing) {
      throw fail("DEVELOPMENT_ALREADY_DECIDED",
        `Merchandising already answered version ${live.currentRequestVersionNo}.`,
        { state: existing.state });
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    await DevelopmentRequestReceipt.create([{
      companyId: ctx.companyId,
      requestRef: str((await SalesDevelopmentRequest.findById(live.currentRequestId)
        .select("requestRef").session(session).lean())?.requestRef),
      requestVersionNo: live.currentRequestVersionNo,
      requestId: live.currentRequestId,
      developmentFileId: live._id,
      state: RECEIPT_STATE.CLARIFICATION_REQUESTED,
      clarification: { category, reason: reason.slice(0, 2000) },
      decidedBy: actor || undefined,
      decidedAt: at,
    }], { session });

    await MerchandisingAuditEvent.create([auditRow({
      file: live, recordType: "DEVELOPMENT_REQUEST", recordId: live.currentRequestId,
      action: "DEVELOPMENT_CLARIFICATION_REQUESTED", actor, at, correlationId, reason,
      details: { requestVersionNo: live.currentRequestVersionNo, category },
    })], { session, ordered: true });

    return {
      developmentNumber: str(live.developmentNumber),
      state: RECEIPT_STATE.CLARIFICATION_REQUESTED,
      note: "Sales has been asked. Selection can continue meanwhile.",
    };
  }));
}

/**
 * ASSIGN — who answers for this file.
 *
 * The assignee must hold a live Merchandising grant in this company.
 * Assignment never widens what anybody may do: the access layer does not read
 * it, and a file assigned to somebody with no grant would be a name against
 * work they cannot open.
 */
async function assignFile(ctx, { fileId, body = {}, actor = null } = {}) {
  const file = await loadFile(ctx, fileId);
  assertWorkable(file);
  const email = str(body?.email).toLowerCase();
  if (!email) throw fail("VALIDATION", "Say who is responsible.", { field: "email" });

  const { getEffectiveRole } = require("../departmentRoles");
  const role = await getEffectiveRole("merchandiser", { user: { email } });
  if (!role) {
    throw fail("VALIDATION",
      "That person does not hold a live Merchandising grant, so the file cannot be theirs.",
      { field: "email" });
  }

  return withTxn(async (session) => {
    const live = await DevelopmentFile.findById(file._id).session(session);
    assertExpected(live, body?.expectedRevision, "development file");
    const at = new Date();
    live.responsibleMerchandiser = {
      email, name: str(body?.name), assignedAt: at, assignedBy: actor || undefined,
    };
    live.revision += 1;
    await live.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file: live, recordType: "DEVELOPMENT_FILE", recordId: live._id,
      action: "DEVELOPMENT_FILE_ASSIGNED", actor, at, correlationId: crypto.randomUUID(),
      reason: str(body?.reason),
      details: { assigneeName: str(body?.name), assigneeEmail: email },
    })], { session, ordered: true });

    return { developmentNumber: str(live.developmentNumber), revision: live.revision };
  });
}

/** HOLD / RESUME / CLOSE. Each with a reason, each kept in history. */
async function moveLifecycle(ctx, { fileId, command, body = {}, actor = null } = {}) {
  const file = await loadFile(ctx, fileId);
  const reason = str(body?.reason);

  const MOVES = {
    hold: { from: [LIFECYCLE.NEW, LIFECYCLE.ACTIVE, LIFECYCLE.AWAITING_APPROVAL], to: LIFECYCLE.ON_HOLD, action: "DEVELOPMENT_FILE_HELD", needsReason: true },
    resume: { from: [LIFECYCLE.ON_HOLD], to: LIFECYCLE.ACTIVE, action: "DEVELOPMENT_FILE_RESUMED", needsReason: false },
    close: { from: Object.values(LIFECYCLE).filter((l) => ![LIFECYCLE.CLOSED, LIFECYCLE.CANCELLED].includes(l)), to: LIFECYCLE.CLOSED, action: "DEVELOPMENT_FILE_CLOSED", needsReason: true },
  };
  const move = MOVES[str(command)];
  if (!move) {
    throw fail("VALIDATION", `"${command}" is not a development lifecycle command.`,
      { allowed: Object.keys(MOVES) });
  }
  if (move.needsReason && reason.length < 10) {
    throw fail("VALIDATION", "Say why — it is recorded in the file's history.", { field: "reason" });
  }
  if (!move.from.includes(file.lifecycleStatus)) {
    throw fail("DEVELOPMENT_STATE_CONFLICT",
      `A ${str(file.lifecycleStatus).toLowerCase()} file cannot be ${command}d.`,
      { lifecycleStatus: file.lifecycleStatus });
  }

  return withTxn(async (session) => {
    const live = await DevelopmentFile.findById(file._id).session(session);
    assertExpected(live, body?.expectedRevision, "development file");
    const at = new Date();
    const previous = live.lifecycleStatus;
    live.lifecycleStatus = move.to;
    live.lifecycleReason = reason.slice(0, 500);
    live.revision += 1;
    await live.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file: live, recordType: "DEVELOPMENT_FILE", recordId: live._id,
      action: move.action, actor, at, correlationId: crypto.randomUUID(), reason,
      previousState: previous, resultingState: move.to,
      details: {},
    })], { session, ordered: true });

    return { developmentNumber: str(live.developmentNumber), lifecycleStatus: move.to };
  });
}

/* ═══ COMMANDS — THE BOM ═══════════════════════════════════════════════════ */

/* ── WHAT A ROW MAY STATE ─────────────────────────────────────────────────
   Declared, so an unexpected key is REFUSED rather than silently dropped.
   Somebody who sends `quantity` or `unitCost` expecting Merchandising to
   record it must be told whose fact that is, not have it vanish and believe
   it landed. */
const ROW_FIELDS = Object.freeze([
  "category", "rawItemId", "rawItemName", "rawItemSku", "variantId", "variantCombination",
  "colourOrShade", "finish", "placement", "appliesTo", "selectionNote",
]);

/** Named so a refusal can say which department owns the fact. */
const REFUSED_ROW_FIELDS = Object.freeze({
  quantity: "R&D — consumption is engineered for this style, not carried from a selection",
  consumption: "R&D — consumption is engineered for this style",
  unit: "R&D — the unit belongs with the consumption",
  allowance: "R&D — allowance is engineered with the consumption",
  allowancePercent: "R&D — allowance is engineered with the consumption",
  wastage: "R&D — wastage is engineered with the consumption",
  rate: "Costing — Merchandising selects the material, it does not price it",
  unitCost: "Costing — Merchandising selects the material, it does not price it",
  totalCost: "Costing — Merchandising selects the material, it does not price it",
  price: "Costing — Merchandising selects the material, it does not price it",
  supplier: "Supply Chain — the supplier is chosen when it is bought, not when it is specified",
  supplierId: "Supply Chain — the supplier is chosen when it is bought",
  purchaseOrder: "Store — a purchase order is raised against a confirmed need",
  stock: "Store — stock is a position, not a specification",
  reserved: "Store — a reservation is against real stock",
  issueQuantity: "Store — issuing happens against a work order",
  sampleResult: "R&D — the sample result is recorded when the sample is made",
});

function shapeRow(body, existingRef = "") {
  const unexpected = Object.keys(body || {}).filter((k) => (
    !ROW_FIELDS.includes(k) && !["rowRef", "expectedRevision", "idempotencyKey"].includes(k)
  ));
  if (unexpected.length) {
    const owner = REFUSED_ROW_FIELDS[unexpected[0]];
    throw fail("DEVELOPMENT_FIELD_NOT_ALLOWED",
      owner
        ? `"${unexpected[0]}" is not Merchandising's to state — it belongs to ${owner}.`
        : `"${unexpected[0]}" is not a field a development BOM row carries.`,
      { field: unexpected[0], allowed: ROW_FIELDS });
  }

  const category = str(body?.category).toUpperCase();
  if (!Object.values(ROW_CATEGORY).includes(category)) {
    throw fail("VALIDATION", "Say what kind of material this is.",
      { field: "category", allowed: Object.values(ROW_CATEGORY) });
  }
  const rawItemName = str(body?.rawItemName);
  if (!isId(body?.rawItemId) && !rawItemName) {
    throw fail("VALIDATION",
      "A row names a catalogue item, or at least what the material is.",
      { field: "rawItemId" });
  }

  return {
    /* Minted once. Carried when a revision is cloned — see cloneRows. */
    rowRef: str(existingRef) || `DR-${crypto.randomBytes(5).toString("hex")}`,
    category,
    rawItemId: isId(body?.rawItemId) ? body.rawItemId : null,
    rawItemName: rawItemName.slice(0, 200),
    rawItemSku: str(body?.rawItemSku),
    variantId: isId(body?.variantId) ? body.variantId : null,
    variantCombination: (Array.isArray(body?.variantCombination) ? body.variantCombination : [])
      .map(str).filter(Boolean),
    colourOrShade: str(body?.colourOrShade).slice(0, 120),
    finish: str(body?.finish).slice(0, 120),
    placement: str(body?.placement).slice(0, 200),
    appliesTo: str(body?.appliesTo).slice(0, 200),
    selectionNote: str(body?.selectionNote).slice(0, 1000),
  };
}

/** The draft in force, or a refusal saying why there is none. */
async function loadDraft(ctx, file, session) {
  const draft = await DevelopmentBomRevision.findOne({
    companyId: ctx.companyId, developmentFileId: file._id, state: BOM_STATE.DRAFT,
  }).session(session);
  if (!draft) {
    throw fail("DEVELOPMENT_BOM_NOT_FOUND",
      "There is no draft selection on this file. Start one before adding materials.");
  }
  return draft;
}

/** Counted from the highest EVER issued, so a number means one thing for ever. */
async function nextRevisionNo(ctx, fileId, session) {
  const highest = await DevelopmentBomRevision
    .findOne({ companyId: ctx.companyId, developmentFileId: fileId })
    .sort({ revisionNo: -1 }).select("revisionNo").session(session).lean();
  return (highest?.revisionNo ?? 0) + 1;
}

/**
 * CREATE A DRAFT — empty, or cloned from an existing revision.
 *
 * Cloning CARRIES every row's permanent reference forward, which is what
 * makes "this label changed at revision 4" a sentence somebody can write, and
 * what lets a confirmed order trace a selection back to the development row
 * it came from.
 */
async function createDraft(ctx, { fileId, body = {}, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);
  assertWorkable(file);

  return once(ctx, {
    scope: `dev:bom:draft:${str(file._id)}`,
    idempotencyKey,
    request: { fileId: str(file._id), fromRevisionNo: body?.fromRevisionNo ?? null },
  }, async () => withTxn(async (session) => {
    const live = await DevelopmentFile.findById(file._id).session(session);

    const existing = await DevelopmentBomRevision.findOne({
      companyId: ctx.companyId, developmentFileId: live._id, state: BOM_STATE.DRAFT,
    }).session(session);
    if (existing) {
      throw fail("DEVELOPMENT_BOM_EXISTS",
        `Revision ${existing.revisionNo} is already a draft on this file. `
        + "Two drafts of one selection is two answers to one question.",
        { revisionNo: existing.revisionNo });
    }
    const submitted = await DevelopmentBomRevision.findOne({
      companyId: ctx.companyId, developmentFileId: live._id, state: BOM_STATE.SUBMITTED,
    }).session(session);
    if (submitted) {
      throw fail("DEVELOPMENT_BOM_EXISTS",
        `Revision ${submitted.revisionNo} is submitted and awaiting a decision.`,
        { revisionNo: submitted.revisionNo });
    }

    let rows = [];
    let clonedFrom = null;
    const from = body?.fromRevisionNo;
    if (from !== undefined && from !== null && from !== "") {
      const source = await DevelopmentBomRevision.findOne({
        companyId: ctx.companyId, developmentFileId: live._id, revisionNo: Number(from),
      }).session(session).lean();
      if (!source) throw fail("DEVELOPMENT_BOM_NOT_FOUND", "That revision does not exist.");
      /* Row references carried, deliberately. */
      rows = (source.rows || []).map((r) => ({ ...r }));
      clonedFrom = source.revisionNo;
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    const revisionNo = await nextRevisionNo(ctx, live._id, session);
    const [draft] = await DevelopmentBomRevision.create([{
      companyId: ctx.companyId,
      developmentFileId: live._id,
      revisionNo,
      state: BOM_STATE.DRAFT,
      rows,
      clonedFromRevisionNo: clonedFrom,
      createdBy: actor || undefined,
    }], { session });

    if (live.lifecycleStatus === LIFECYCLE.NEW) {
      live.lifecycleStatus = LIFECYCLE.ACTIVE;
      live.revision += 1;
      await live.save({ session });
    }

    await MerchandisingAuditEvent.create([auditRow({
      file: live, recordType: "DEVELOPMENT_BOM", recordId: draft._id,
      action: "DEVELOPMENT_BOM_DRAFTED", actor, at, correlationId,
      details: { revisionNo, clonedFromRevisionNo: clonedFrom, rowCount: rows.length },
    })], { session, ordered: true });

    return { revisionNo, state: BOM_STATE.DRAFT, rowCount: rows.length };
  }));
}

/**
 * ADOPT THE REGISTERED PRODUCT'S BOM into the draft.
 *
 * Explicit and idempotent. It brings IDENTITY only — the product BOM's
 * quantity, allowance and cost stay where they are, because a previous
 * product's consumption is not this style's engineered consumption.
 *
 * It never approves. The draft is a draft: a merchandiser reviews what came
 * across, changes what the buyer changed, and puts it through maker/checker
 * like any other selection.
 */
async function adoptRegisteredProductBom(ctx, { fileId, body = {}, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);
  assertWorkable(file);
  const source = await registeredProductBom(ctx, { fileId });
  if (!source.available) {
    throw fail("DEVELOPMENT_BOM_EMPTY", source.sentence, { stockItemId: str(file.stockItemId) });
  }

  return once(ctx, {
    scope: `dev:bom:adopt:${str(file._id)}`,
    idempotencyKey,
    request: { fileId: str(file._id), stockItemId: str(file.stockItemId) },
  }, async () => withTxn(async (session) => {
    const live = await DevelopmentFile.findById(file._id).session(session);
    const draft = await loadDraft(ctx, live, session);
    assertExpected(draft, body?.expectedRevision, "draft selection");

    const at = new Date();
    const correlationId = crypto.randomUUID();
    /* Already-adopted identities are skipped, so running it twice adds
       nothing — the same catalogue item and variant is the same selection. */
    const held = new Set((draft.rows || []).map(
      (r) => `${str(r.rawItemId)}::${str(r.variantId)}`,
    ));
    let added = 0;
    for (const r of source.rows) {
      const key = `${str(r.rawItemId)}::${str(r.variantId)}`;
      if (held.has(key)) continue;
      held.add(key);
      draft.rows.push({
        rowRef: `DR-${crypto.randomBytes(5).toString("hex")}`,
        /* Adopted rows land as FABRIC unless the caller says otherwise: the
           product BOM does not carry Merchandising's category, and guessing
           one per row would be inventing a fact. A merchandiser sets it. */
        category: ROW_CATEGORY.FABRIC,
        rawItemId: r.rawItemId || null,
        rawItemName: str(r.rawItemName),
        rawItemSku: str(r.rawItemSku),
        variantId: r.variantId || null,
        variantCombination: (r.variantCombination || []).map(str),
        appliesTo: (r.appliesToVariantLabels || []).join(", ").slice(0, 200),
        source: {
          kind: "REGISTERED_PRODUCT_BOM",
          stockItemId: live.stockItemId,
          reference: str(source.stockItemReference) || str(source.stockItemName),
          observedAt: at,
        },
      });
      added += 1;
    }

    draft.revision += 1;
    await draft.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file: live, recordType: "DEVELOPMENT_BOM", recordId: draft._id,
      action: "DEVELOPMENT_BOM_ADOPTED", actor, at, correlationId,
      details: {
        revisionNo: draft.revisionNo, adoptedCount: added,
        stockItemId: str(live.stockItemId), rowCount: draft.rows.length,
      },
    })], { session, ordered: true });

    return {
      revisionNo: draft.revisionNo, adopted: added, rowCount: draft.rows.length,
      note: added
        ? `${added} material identity(ies) adopted into the draft. Nothing is approved.`
        : "Every identity on that product is already in this draft.",
    };
  }));
}

/** ADD a row to the draft. */
async function addRow(ctx, { fileId, body = {}, actor = null } = {}) {
  const file = await loadFile(ctx, fileId);
  assertWorkable(file);
  const row = shapeRow(body);

  return withTxn(async (session) => {
    const draft = await loadDraft(ctx, file, session);
    assertExpected(draft, body?.expectedRevision, "draft selection");
    draft.rows.push({ ...row, source: { kind: "MERCHANDISING_SELECTION", observedAt: new Date() } });
    draft.revision += 1;
    await draft.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file, recordType: "DEVELOPMENT_BOM", recordId: draft._id,
      action: "DEVELOPMENT_BOM_ROW_ADDED", actor, at: new Date(),
      correlationId: crypto.randomUUID(),
      details: {
        revisionNo: draft.revisionNo, rowRef: row.rowRef,
        materialName: row.rawItemName, category: row.category,
      },
    })], { session, ordered: true });

    return { revisionNo: draft.revisionNo, rowRef: row.rowRef, revision: draft.revision };
  });
}

/** UPDATE a row, by its permanent reference. */
async function updateRow(ctx, { fileId, rowRef, body = {}, actor = null } = {}) {
  const file = await loadFile(ctx, fileId);
  assertWorkable(file);
  const shaped = shapeRow(body, str(rowRef));

  return withTxn(async (session) => {
    const draft = await loadDraft(ctx, file, session);
    assertExpected(draft, body?.expectedRevision, "draft selection");
    const row = (draft.rows || []).find((r) => str(r.rowRef) === str(rowRef));
    if (!row) throw fail("NOT_FOUND", "That material is not in this draft.");

    for (const f of ROW_FIELDS) row[f] = shaped[f];
    draft.revision += 1;
    await draft.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file, recordType: "DEVELOPMENT_BOM", recordId: draft._id,
      action: "DEVELOPMENT_BOM_ROW_UPDATED", actor, at: new Date(),
      correlationId: crypto.randomUUID(),
      details: {
        revisionNo: draft.revisionNo, rowRef: str(rowRef), materialName: shaped.rawItemName,
      },
    })], { session, ordered: true });

    return { revisionNo: draft.revisionNo, rowRef: str(rowRef), revision: draft.revision };
  });
}

/** REMOVE a row from the draft. Earlier revisions keep it for ever. */
async function removeRow(ctx, { fileId, rowRef, body = {}, actor = null } = {}) {
  const file = await loadFile(ctx, fileId);
  assertWorkable(file);

  return withTxn(async (session) => {
    const draft = await loadDraft(ctx, file, session);
    assertExpected(draft, body?.expectedRevision, "draft selection");
    const before = draft.rows.length;
    const removed = (draft.rows || []).find((r) => str(r.rowRef) === str(rowRef));
    if (!removed) throw fail("NOT_FOUND", "That material is not in this draft.");
    draft.rows = draft.rows.filter((r) => str(r.rowRef) !== str(rowRef));
    draft.revision += 1;
    await draft.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file, recordType: "DEVELOPMENT_BOM", recordId: draft._id,
      action: "DEVELOPMENT_BOM_ROW_REMOVED", actor, at: new Date(),
      correlationId: crypto.randomUUID(),
      details: {
        revisionNo: draft.revisionNo, rowRef: str(rowRef),
        materialName: str(removed.rawItemName), removedFrom: before,
      },
    })], { session, ordered: true });

    return { revisionNo: draft.revisionNo, rowCount: draft.rows.length, revision: draft.revision };
  });
}

/** SUBMIT the draft for approval. */
async function submitBom(ctx, { fileId, body = {}, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);
  assertWorkable(file);

  return once(ctx, {
    scope: `dev:bom:submit:${str(file._id)}`,
    idempotencyKey,
    request: { fileId: str(file._id), expectedRevision: body?.expectedRevision },
  }, async () => withTxn(async (session) => {
    const live = await DevelopmentFile.findById(file._id).session(session);
    const draft = await loadDraft(ctx, live, session);
    assertExpected(draft, body?.expectedRevision, "draft selection");

    if (!(draft.rows || []).length) {
      throw fail("DEVELOPMENT_BOM_EMPTY",
        "An empty selection tells R&D nothing. Add the materials before submitting.");
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    draft.state = BOM_STATE.SUBMITTED;
    draft.submittedBy = actor || undefined;
    draft.submittedAt = at;
    draft.revision += 1;
    await draft.save({ session });

    const previous = live.lifecycleStatus;
    live.lifecycleStatus = LIFECYCLE.AWAITING_APPROVAL;
    live.revision += 1;
    await live.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file: live, recordType: "DEVELOPMENT_BOM", recordId: draft._id,
      action: "DEVELOPMENT_BOM_SUBMITTED", actor, at, correlationId,
      previousState: previous, resultingState: live.lifecycleStatus,
      details: { revisionNo: draft.revisionNo, rowCount: draft.rows.length },
    })], { session, ordered: true });

    return {
      revisionNo: draft.revisionNo, state: BOM_STATE.SUBMITTED,
      note: "Submitted. Somebody other than you approves it.",
    };
  }));
}

/**
 * APPROVE — maker/checker, and no exemption for anybody.
 *
 * The approver may not be the person who authored or submitted the revision,
 * and an OWNER is not an exception: the rung that would be exempt is the rung
 * the separation exists to constrain. R&D engineers consumption against this
 * and Costing prices it, so one person deciding alone is one person able to
 * commit the company's development budget on their own judgement.
 */
async function approveBom(ctx, { fileId, body = {}, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);
  assertWorkable(file);

  return once(ctx, {
    scope: `dev:bom:approve:${str(file._id)}`,
    idempotencyKey,
    request: { fileId: str(file._id) },
  }, async () => withTxn(async (session) => {
    const live = await DevelopmentFile.findById(file._id).session(session);
    const submitted = await DevelopmentBomRevision.findOne({
      companyId: ctx.companyId, developmentFileId: live._id, state: BOM_STATE.SUBMITTED,
    }).session(session);
    if (!submitted) {
      throw fail("DEVELOPMENT_BOM_NOT_FOUND", "There is no submitted selection to approve.");
    }
    assertExpected(submitted, body?.expectedRevision, "submitted selection");

    /* ── MAKER AND CHECKER ────────────────────────────────────────────── */
    const same = (who) => Boolean(
      (str(actor?.email) && str(who?.email).toLowerCase() === str(actor?.email).toLowerCase())
      || (str(actor?.id) && str(who?.id) === str(actor?.id)),
    );
    if (same(submitted.submittedBy) || same(submitted.createdBy)) {
      throw fail("DEVELOPMENT_SELF_APPROVAL",
        "This selection is approved by somebody other than the person who made it. "
        + "R&D and Costing both work from it, so it is not one person's decision alone.",
        { revisionNo: submitted.revisionNo });
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    const outbox = [];

    /* ── SUPERSEDE THE PREVIOUS APPROVED REVISION FIRST ─────────────────
       The partial unique index allows one APPROVED revision and is checked as
       each write lands, not at commit — the same ordering every other
       supersession in this module follows. */
    const previousApproved = await DevelopmentBomRevision.findOne({
      companyId: ctx.companyId, developmentFileId: live._id, state: BOM_STATE.APPROVED,
    }).session(session);
    if (previousApproved) {
      previousApproved.state = BOM_STATE.SUPERSEDED;
      previousApproved.supersededByRevisionNo = submitted.revisionNo;
      previousApproved.supersededAt = at;
      previousApproved.revision += 1;
      await previousApproved.save({ session });

      outbox.push({
        companyId: ctx.companyId,
        kind: OUTBOX_KIND.DEVELOPMENT_BOM_SUPERSEDED,
        payload: {
          developmentFileId: live._id,
          developmentNumber: str(live.developmentNumber),
          bomRevisionNo: previousApproved.revisionNo,
        },
        correlationId,
      });
    }

    submitted.state = BOM_STATE.APPROVED;
    submitted.approvedBy = actor || undefined;
    submitted.approvedAt = at;
    submitted.revision += 1;
    await submitted.save({ session });

    const previous = live.lifecycleStatus;
    live.lifecycleStatus = LIFECYCLE.APPROVED;
    live.currentBomRevisionNo = submitted.revisionNo;
    live.revision += 1;
    await live.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file: live, recordType: "DEVELOPMENT_BOM", recordId: submitted._id,
      action: "DEVELOPMENT_BOM_APPROVED", actor, at, correlationId,
      previousState: previous, resultingState: live.lifecycleStatus,
      details: {
        revisionNo: submitted.revisionNo,
        rowCount: submitted.rows.length,
        supersededRevisionNo: previousApproved?.revisionNo ?? null,
      },
    })], { session, ordered: true });

    /* ── PUBLISHED, SO R&D AND COSTING CAN READ IT ────────────────────── */
    outbox.push({
      companyId: ctx.companyId,
      kind: OUTBOX_KIND.DEVELOPMENT_BOM_APPROVED,
      payload: {
        developmentFileId: live._id,
        developmentNumber: str(live.developmentNumber),
        bomRevisionNo: submitted.revisionNo,
        productLineRef: str(live.productLineRef),
        rowCount: submitted.rows.length,
      },
      correlationId,
    });
    await MerchandisingOutboxEvent.create(outbox, { session, ordered: true });

    return {
      revisionNo: submitted.revisionNo, state: BOM_STATE.APPROVED,
      supersededRevisionNo: previousApproved?.revisionNo ?? null,
      note: "Approved. Sales authorises release to R&D — that spend is their decision.",
    };
  }));
}

/** ASK FOR CHANGES — back to draft, with a reason, keeping the number. */
async function requestChanges(ctx, { fileId, body = {}, actor = null } = {}) {
  const file = await loadFile(ctx, fileId);
  const reason = str(body?.reason);
  if (reason.length < MIN_REASON) {
    throw fail("VALIDATION",
      "Say what needs changing — the person who made the selection has to act on it.",
      { field: "reason", minimum: MIN_REASON });
  }

  return withTxn(async (session) => {
    const live = await DevelopmentFile.findById(file._id).session(session);
    const submitted = await DevelopmentBomRevision.findOne({
      companyId: ctx.companyId, developmentFileId: live._id, state: BOM_STATE.SUBMITTED,
    }).session(session);
    if (!submitted) {
      throw fail("DEVELOPMENT_BOM_NOT_FOUND", "There is no submitted selection to send back.");
    }
    assertExpected(submitted, body?.expectedRevision, "submitted selection");

    const at = new Date();
    /* Back to DRAFT, keeping its number: it is the same selection being
       corrected, not a new one, and burning a revision number for a round
       trip would make the history harder to read. */
    submitted.state = BOM_STATE.DRAFT;
    submitted.changesRequestedBy = actor || undefined;
    submitted.changesRequestedAt = at;
    submitted.changeReason = reason.slice(0, 2000);
    submitted.submittedBy = undefined;
    submitted.submittedAt = null;
    submitted.revision += 1;
    await submitted.save({ session });

    const previous = live.lifecycleStatus;
    live.lifecycleStatus = LIFECYCLE.ACTIVE;
    live.revision += 1;
    await live.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file: live, recordType: "DEVELOPMENT_BOM", recordId: submitted._id,
      action: "DEVELOPMENT_BOM_CHANGES_REQUESTED", actor, at,
      correlationId: crypto.randomUUID(), reason,
      previousState: previous, resultingState: live.lifecycleStatus,
      details: { revisionNo: submitted.revisionNo },
    })], { session, ordered: true });

    return { revisionNo: submitted.revisionNo, state: BOM_STATE.DRAFT };
  });
}

module.exports = {
  DEFAULT_LIMIT, MAX_LIMIT, FILE_VIEWS, isFileView,
  assertContext, withTxn, once, loadFile, assertExpected, assertWorkable, auditRow,
  fileView, rowView, bomView, receiptView,
  listFiles, developmentOverview, getFile, fileHistory, registeredProductBom,
  acceptRequest, clarifyRequest, assignFile, moveLifecycle,
  ROW_FIELDS, REFUSED_ROW_FIELDS, shapeRow, loadDraft, nextRevisionNo,
  createDraft, adoptRegisteredProductBom, addRow, updateRow, removeRow,
  submitBom, approveBom, requestChanges,
};
