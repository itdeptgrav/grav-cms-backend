"use strict";
// services/merchandising/customerMaterial.service.js
//
// THE CUSTOMER'S OWN MATERIALS, EXPECTED AGAINST A JOB-WORK ORDER.
//
// See the model for why this is not a purchase order and not a receipt. This
// file is about the three questions a service has to answer that a schema
// cannot: WHO may write it, WHEN it may be written, and WHAT the eligibility to
// write it at all actually rests on.
//
// ── ELIGIBILITY IS A STORED FACT, CHECKED ON THE SERVER ─────────────────────
// A customer-supplied material document may exist only for a JOB WORK order,
// and the stored source of that is one place:
//
//     ExecutionFile.currentExecutionProjection.fulfilmentModel === "JOB_WORK"
//
// read through `resolveOrderFulfilmentModel`, so a historical file that carries
// no value reads as FULL_PACKAGE — the default — rather than as an unknown that
// some caller treats as permission. Not the handover, not a screen's flag, not
// a query parameter, and never the payload: a client that says `JOB_WORK` is
// ignored, because a document whose right to exist came from the request that
// created it has no right to exist.
//
// The check is on EVERY write and on every read of a file's expectations, not
// only on the one that creates the first draft. A file whose order is converted
// to full package stops being eligible, and the next write must find that out
// rather than inherit permission from the draft it is editing.
//
// ── WHAT A MERCHANDISER STATES, AND WHAT THEY DO NOT ────────────────────────
// They state: which material (by reference to Store's catalogue), how much, in
// what unit, by when, and anything a person needs to know about the line.
//
// They do not state what it is worth, who supplies it, what tax applies, or
// whether any of it has turned up. The first three have nowhere to go — see the
// model. The last is the next phase's, and this phase says so out loud rather
// than showing an empty column that reads as "nothing yet".

const crypto = require("crypto");
const mongoose = require("mongoose");

const {
  CustomerMaterialExpectation, STATE,
} = require("../../models/CMS_Models/Merchandising/CustomerMaterialExpectation");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const { MerchandisingAuditEvent } = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const {
  resolveOrderFulfilmentModel, isJobWorkOrder,
} = require("../../constants/orderFulfilment");
const materialCatalogue = require("./materialCatalogue.service");
const customerIdentity = require("./customerIdentity.service");
/* The unit of work this module's own decisions commit in. Borrowed from the
   development service rather than re-implemented: one transaction helper per
   application, so "atomic" means the same thing everywhere in it. */
const { withTxn } = require("./development.service");
const { fail } = require("../storePurchase/errors");
const { Counter } = require("../salesJourneyRef");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const num = (v) => Number(v);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/* ── RECEIPT IS RECORDABLE NOW ───────────────────────────────────────────────
   This replaced a sentence saying it was not. The Phase 1 notice was carried on
   every response so that no screen had to invent its own wording and so it would
   disappear from all of them at once when the goods-receipt path landed — which
   is what has happened. `available: true` is what the screens read; the shape is
   kept so nothing has to change twice. */
const RECEIPT_AVAILABLE = Object.freeze({
  available: true,
  reason: "",
  message: "",
  next: "",
});

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

/* ═══ ELIGIBILITY ══════════════════════════════════════════════════════════ */

/**
 * The execution file, and what its order currently says about who buys.
 *
 * It does NOT refuse a full-package order, and that is the correction: a
 * document already issued has to stay readable if Sales later converts the
 * order. Store planned around it, the customer was told, and goods may already
 * be on a lorry — making the record unreadable at the moment it becomes
 * contentious is the opposite of what a record is for.
 *
 * A file from another company answers exactly as one that does not exist —
 * distinguishing them would turn this into a way to ask what somebody else is
 * making.
 */
async function sourceFile(ctx, fileId, session = null) {
  assertContext(ctx);
  if (!isId(fileId)) throw fail("NOT_FOUND", "That execution file was not found.");
  const file = await ExecutionFile
    .findOne({ _id: fileId, companyId: ctx.companyId })
    .session(session);
  if (!file) throw fail("NOT_FOUND", "That execution file was not found.");

  /* ── THE ONE STORED SOURCE ───────────────────────────────────────────────
     Read through the resolver, so a file predating the field reads as the
     default rather than as an unknown somebody treats as permission. */
  const model = resolveOrderFulfilmentModel(file.currentExecutionProjection?.fulfilmentModel);
  return { file, fulfilmentModel: model, jobWork: isJobWorkOrder(model) };
}

/**
 * JOB WORK is required to CREATE, EDIT or ISSUE. It is not required to READ.
 *
 * ── THE TWO REFUSALS ARE DIFFERENT FACTS ────────────────────────────────────
 * A full-package order that never had a document is being asked for something
 * that does not belong to it at all. An order that HAD one and was converted is
 * a different situation entirely: the document exists, Store is holding it, and
 * the only sensible acts left are to read it or to withdraw it. Telling both of
 * them "this is a full-package order" would leave the second person with no idea
 * why the screen they were using yesterday has stopped working.
 */
function assertComposable({ jobWork, fulfilmentModel, hadDocuments = false }) {
  if (jobWork) return;
  if (hadDocuments) {
    throw fail("LIFECYCLE_BLOCKED",
      "This order is no longer job work, so what the customer is sending cannot be changed. "
      + "The document stays readable as it was issued; withdraw it if the customer is not "
      + "sending these materials after all.",
      { reason: "SOURCE_FULFILMENT_MODEL_CHANGED", fulfilmentModel });
  }
  throw fail("LIFECYCLE_BLOCKED",
    "This order is full package, so the factory buys its materials. A customer-supplied "
    + "material document belongs only to a job-work order.",
    { reason: "NOT_A_JOB_WORK_ORDER", fulfilmentModel });
}

/** Whether this file has ever carried one — which refusal to give. */
const hasDocuments = (ctx, fileId, session = null) => CustomerMaterialExpectation
  .exists({ companyId: ctx.companyId, executionFileId: fileId }).session(session);

/**
 * The file, checked for composing. Every write path goes through this.
 *
 * Kept as one function so a new write cannot accidentally be the one that
 * forgets: there is no shorter way to load the file for a write.
 */
async function composableFile(ctx, fileId, session = null) {
  const out = await sourceFile(ctx, fileId, session);
  if (!out.jobWork) {
    assertComposable({ ...out, hadDocuments: Boolean(await hasDocuments(ctx, out.file._id, session)) });
  }
  return out;
}

/** Whether a file may carry one, without throwing — for a screen to ask. */
function isEligible(file) {
  return isJobWorkOrder(
    resolveOrderFulfilmentModel(file?.currentExecutionProjection?.fulfilmentModel),
  );
}

/** A file that is finished or withdrawn takes no more work. */
function assertWorkable(file) {
  if (["CANCELLED", "CLOSED"].includes(str(file.lifecycleStatus))) {
    throw fail("LIFECYCLE_BLOCKED",
      `This execution file is ${str(file.lifecycleStatus).toLowerCase()}.`,
      { lifecycleStatus: str(file.lifecycleStatus) });
  }
}

/* ═══ VIEWS ════════════════════════════════════════════════════════════════ */

/**
 * One line, as anybody may read it.
 *
 * No received quantity, no outstanding quantity, no receipt state. There is
 * nowhere for one to arrive, which is the only reliable way to keep a number
 * nobody measured off a screen.
 */
const lineView = (l) => ({
  lineRef: str(l.lineRef),
  rawItemId: str(l.rawItemId),
  variantId: l.variantId ? str(l.variantId) : null,
  rawItemName: str(l.rawItemName),
  rawItemSku: str(l.rawItemSku),
  variantCombination: (l.variantCombination || []).map(str).filter(Boolean),
  requiredQuantity: l.requiredQuantity,
  unit: str(l.unit),
  expectedArrivalDate: l.expectedArrivalDate || null,
  note: str(l.note),
});

const actorView = (a) => (a?.email || a?.name
  ? { name: str(a.name), email: str(a.email) }
  : null);

/** The whole document. The same shape for Merchandising and for Store. */
function expectationView(doc) {
  if (!doc) return null;
  const lines = (doc.lines || []).map(lineView);
  return {
    id: str(doc._id),
    documentRef: str(doc.documentRef),
    revisionNo: doc.revisionNo,
    revision: doc.revision ?? 0,
    state: str(doc.state),
    /* Why this document is allowed to exist, on the document. */
    fulfilmentModel: str(doc.fulfilmentModel),

    /* ── WHICH KIND OF WORK THIS IS FOR ──────────────────────────────────
       A confirmed order or a development sample. Carried so Store's Expected
       receipts can say which without re-deriving it from whichever id happens
       to be populated — and so a reader is never left to infer the origin from
       an absence. */
    origin: str(doc.origin) || "CONFIRMED_ORDER",
    executionFileId: doc.executionFileId ? str(doc.executionFileId) : null,
    developmentFileId: doc.developmentFileId ? str(doc.developmentFileId) : null,
    /* The approved request this came from, where one did. Lineage for a person
       asking "why is this coming?" - never the authority for whose it is. */
    sourceMrfId: doc.sourceMrfId ? str(doc.sourceMrfId) : null,
    sourceMrfNumber: str(doc.sourceMrfNumber),
    fileNumber: str(doc.fileNumber),
    orderRef: str(doc.orderRef),
    salesOrderLineRef: str(doc.salesOrderLineRef),
    /* ── THE OWNER, AS A REFERENCE AND AS A LABEL ────────────────────────
       The id is what a lot is stamped with and what anything joins on; the
       snapshot is what a screen prints. Null on a Phase 1 document, which is
       why a receipt against one is refused until it is reissued. */
    customerId: doc.customerId ? str(doc.customerId) : null,
    customer: doc.customerId ? {
      id: str(doc.customerId),
      code: str(doc.customerSnapshot?.customerCode),
      label: str(doc.customerSnapshot?.customerLabel),
      name: str(doc.customerSnapshot?.customerName),
      requestRef: str(doc.customerSnapshot?.requestRef),
    } : null,
    styleRef: str(doc.styleRef),
    buyerStyleRef: str(doc.buyerStyleRef),
    productName: str(doc.productName),
    buyerDisplayLabel: str(doc.buyerDisplayLabel),

    lines,
    lineCount: lines.length,
    instructions: str(doc.instructions),

    createdBy: actorView(doc.createdBy),
    createdAt: doc.createdAt || null,
    issuedBy: actorView(doc.issuedBy),
    issuedAt: doc.issuedAt || null,
    cancelledBy: actorView(doc.cancelledBy),
    cancelledAt: doc.cancelledAt || null,
    cancellationReason: str(doc.cancellationReason),
    revisedFromRevisionNo: doc.revisedFromRevisionNo ?? null,

    /* Receipt STANDING is not here. It is derived from goods receipts, which
       means a database read, so it is attached by the callers that need it
       (`forFile`, `register`, `storeDetail`) rather than making every view of a
       document pay for it. Keeping it off the document view is also what stops a
       received quantity from ever being STORED on the expectation. */
  };
}

/* ═══ NUMBERING AND LINE IDENTITY ══════════════════════════════════════════ */

/** CSM-YYYY-NNNN. A gap from an aborted transaction is honest; a repeat is not. */
async function nextDocumentRef(year = new Date().getFullYear()) {
  const doc = await Counter.findOneAndUpdate(
    { key: `merchandisingCustomerMaterial:${year}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return `CSM-${year}-${String(doc.seq).padStart(4, "0")}`;
}

/** A line's permanent name. Not its position — see the model. */
const newLineRef = () => `CML-${crypto.randomBytes(5).toString("hex")}`;

async function nextRevisionNo(ctx, fileId, session) {
  const highest = await CustomerMaterialExpectation
    .findOne({ companyId: ctx.companyId, executionFileId: fileId })
    .sort({ revisionNo: -1 }).select("revisionNo").session(session).lean();
  return (highest?.revisionNo ?? 0) + 1;
}

/* ═══ LOADING ══════════════════════════════════════════════════════════════ */

async function loadDoc(ctx, id, session = null) {
  assertContext(ctx);
  if (!isId(id)) throw fail("NOT_FOUND", "That document was not found.");
  const doc = await CustomerMaterialExpectation
    .findOne({ _id: id, companyId: ctx.companyId }).session(session);
  if (!doc) throw fail("NOT_FOUND", "That document was not found.");
  return doc;
}

/** The open draft for a file, or null. */
const openDraft = (ctx, fileId, session = null) => CustomerMaterialExpectation
  .findOne({ companyId: ctx.companyId, executionFileId: fileId, state: STATE.DRAFT })
  .session(session);

function assertEditable(doc) {
  if (str(doc.state) !== STATE.DRAFT) {
    throw fail("INVALID_TRANSITION",
      str(doc.state) === STATE.ISSUED
        ? "This document has been issued. Open a new revision to change what is expected — "
          + "what was issued stays readable as it was issued."
        : "This document was cancelled and is read-only.",
      { state: str(doc.state) });
  }
}

function assertExpected(doc, expected) {
  if (expected === undefined || expected === null || expected === "") {
    throw fail("VALIDATION", "Say which revision of the document you are changing.",
      { field: "expectedRevision" });
  }
  if (num(expected) !== num(doc.revision ?? 0)) {
    /* `CONFLICT`, which is 409, and not the `REVISION_CONFLICT` spelling used
       elsewhere in Merchandising: that key is not in the error table, so it
       falls back to VALIDATION and answers 400 — telling somebody who lost a
       race that their input is wrong, which is unfixable advice. Nothing about
       the request is malformed; the record moved. */
    throw fail("CONFLICT",
      "Somebody else changed this document while you were working. Reload and try again.",
      { expected: num(expected), actual: num(doc.revision ?? 0) });
  }
}

/* ═══ AUDIT ════════════════════════════════════════════════════════════════ */

const auditRow = ({
  ctx, doc, file, action, actor, at, correlationId,
  details, reason = "", previousState = "", resultingState = "",
}) => ({
  companyId: ctx.companyId,
  recordType: "CUSTOMER_MATERIAL_EXPECTATION",
  recordId: doc._id,
  recordRevision: doc.revision ?? 0,
  /* The EXECUTION file, so this act appears in that file's own history rather
     than only in a register nobody opens. */
  fileId: file?._id || doc.executionFileId,
  fileNumber: str(file?.fileNumber || doc.fileNumber),
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

/* ═══ CREATING A DRAFT ═════════════════════════════════════════════════════ */

/**
 * Open a draft for this execution file.
 *
 * Idempotent by the caller's key — handled by the router's unit of work, which
 * commits the draft, its audit row and the key together. What THIS function
 * guarantees is that a second attempt for a file that already has an open draft
 * returns that draft rather than a second one: two open drafts would give Store
 * two answers to "what is coming", and issuing one would leave the other
 * silently stale. The model's partial unique index is what makes that hold
 * under concurrency; this is the read that makes it a kind answer rather than a
 * database error.
 *
 * `fromRevisionNo` opens a REVISION: the lines of an issued revision are carried
 * forward with their line references intact, so "the interlining line" is the
 * same line across revisions.
 */
async function createDraft(ctx, { fileId, fromRevisionNo = null, actor = null } = {}, session = null) {
  const { file, fulfilmentModel } = await composableFile(ctx, fileId, session);
  assertWorkable(file);

  const existing = await openDraft(ctx, file._id, session);
  if (existing) {
    /* Not an error. Somebody — possibly this same person on another tab — has
       one open, and handing it back is what they wanted. */
    return { expectation: expectationView(existing), created: false };
  }

  const revisionNo = await nextRevisionNo(ctx, file._id, session);

  /* ── CARRYING A REVISION FORWARD ────────────────────────────────────────
     Only from an ISSUED revision. Cloning a cancelled one would resurrect a
     withdrawal, and there is never another draft to clone from. */
  let carried = [];
  let source = null;
  if (fromRevisionNo !== null && fromRevisionNo !== undefined && str(fromRevisionNo) !== "") {
    source = await CustomerMaterialExpectation.findOne({
      companyId: ctx.companyId, executionFileId: file._id,
      revisionNo: num(fromRevisionNo), state: STATE.ISSUED,
    }).session(session).lean();
    if (!source) {
      throw fail("NOT_FOUND",
        `Revision ${str(fromRevisionNo)} of this document is not an issued revision to revise.`,
        { field: "fromRevisionNo" });
    }
    carried = (source.lines || []).map((l) => ({
      /* The reference is CARRIED, not minted. That is what makes a revision a
         revision rather than a new document that happens to look similar. */
      lineRef: str(l.lineRef),
      rawItemId: l.rawItemId,
      variantId: l.variantId || null,
      rawItemName: str(l.rawItemName),
      rawItemSku: str(l.rawItemSku),
      variantCombination: (l.variantCombination || []).map(str),
      requiredQuantity: l.requiredQuantity,
      unit: str(l.unit),
      expectedArrivalDate: l.expectedArrivalDate || null,
      note: str(l.note),
      addedAt: l.addedAt || new Date(),
    }));
  }

  const p = file.currentExecutionProjection || {};
  /* The document reference is stable across revisions — revision 2 of CSM-4 is
     the same document, and two unrelated codes would hide that it changed. */
  const documentRef = source ? str(source.documentRef) : await nextDocumentRef();

  /* ── WHOSE GOODS THESE WILL BE ──────────────────────────────────────────
     Resolved by walking the handover chain on the SERVER, and stamped now so
     the document carries a provable owner from the moment it exists. A broken
     chain does NOT stop a draft — the merchandiser may legitimately be ahead of
     Sales attaching the customer — but it does stop issuing, because an issued
     document is what a receipt is recorded against and a lot with no provable
     owner is the one record in this design that must not exist. */
  const identity = await customerIdentity.resolveFromFile(ctx, file, session);

  const [doc] = await CustomerMaterialExpectation.create([{
    /* Ownership from the resolved context only. */
    companyId: ctx.companyId,
    ...(identity.ok ? {
      customerId: identity.customerId,
      customerRequestId: identity.customerRequestId,
      customerSnapshot: identity.snapshot,
    } : {}),
    ...(file.siteId ? { siteId: file.siteId } : {}),
    executionFileId: file._id,
    fileNumber: str(file.fileNumber),
    orderRef: str(p.orderRef),
    /* The permanent Sales line, from the file's own projection. It is what a
       WorkOrder's `salesLineLink.lineRef` carries, and therefore the only way an
       issue can later prove that a production order and this document are about
       the same commercial line. */
    salesOrderLineRef: str(p.orderLineRef),
    handoverRef: str(file.handoverRef),
    handoverLineRef: str(file.handoverLineRef),
    /* The eligibility that permitted this, stamped so the document can say why
       it exists without re-deriving it from a projection that may have moved. */
    fulfilmentModel,
    styleRef: str(p.styleRef),
    buyerStyleRef: str(p.buyerStyleRef),
    productName: str(p.productName),
    buyerDisplayLabel: str(p.buyerDisplayLabel),
    documentRef,
    revisionNo,
    state: STATE.DRAFT,
    revision: 0,
    lines: carried,
    instructions: source ? str(source.instructions) : "",
    createdBy: actor || undefined,
    createdAt: new Date(),
    revisedFromRevisionNo: source ? source.revisionNo : null,
  }], { session, ordered: true });

  await MerchandisingAuditEvent.create([auditRow({
    ctx, doc, file,
    action: source ? "CUSTOMER_MATERIAL_REVISED" : "CUSTOMER_MATERIAL_DRAFTED",
    actor, at: new Date(), correlationId: crypto.randomUUID(),
    resultingState: STATE.DRAFT,
    details: {
      documentRef, revisionNo,
      ...(source ? { revisedFromRevisionNo: source.revisionNo, carriedLines: carried.length } : {}),
    },
  })], { session, ordered: true });

  return { expectation: expectationView(doc), created: true };
}

/* ═══ LINES ════════════════════════════════════════════════════════════════ */

/** The unit this company actually has. A unit it has not got is not invented. */
async function acceptUnit(ctx, wanted, session = null) {
  const name = str(wanted);
  if (!name) throw fail("VALIDATION", "Say which unit the quantity is in.", { field: "unit" });
  /* The tenant FILTER, not a strict companyId (30 Sep 2026): every unit in
     this register — Pcs, Mtr, Kilogram — predates company stamping and
     carries none, so a strict match refused every line a merchandiser typed.
     The Store's own reads admit those legacy rows while
     STORE_PURCHASE_STRICT_TENANCY is unset; this is the same rule. */
  const known = await Unit.findOne({
    ...require("../storePurchase/tenantContext.service").tenantFilter(ctx),
    status: "Active",
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  }).select("name").session(session).lean();
  if (!known) {
    throw fail("VALIDATION",
      `"${name}" is not a unit this company has. Choose one of its units, or ask Store to add it.`,
      { field: "unit", reason: "UNIT_NOT_IN_COMPANY" });
  }
  /* Store's own spelling, not the caller's casing. */
  return str(known.name);
}

function acceptQuantity(value) {
  const q = num(value);
  if (!Number.isFinite(q) || q <= 0) {
    throw fail("VALIDATION",
      "A line expects a quantity greater than zero. Remove the line if nothing is expected — "
      + "a zero would be read as cancelled by one person and as unknown by another.",
      { field: "requiredQuantity" });
  }
  return q;
}

function acceptDate(value, field = "expectedArrivalDate") {
  if (value === undefined || value === null || str(value) === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw fail("VALIDATION", "That is not a date.", { field });
  }
  return d;
}

/**
 * Add a line.
 *
 * The material's IDENTITY is read from Store's catalogue through the same
 * keyhole the picker uses — so a client that sends a name is not refused, its
 * name is simply not used. The catalogue is the authority on what its items are
 * called, and a stored line that disagreed with it would be a second, quieter
 * master.
 */
async function addLine(ctx, { docId, body = {}, actor = null } = {}, session = null) {
  const doc = await loadDoc(ctx, docId, session);
  assertEditable(doc);
  assertExpected(doc, body?.expectedRevision);
  /* Re-checked here, not inherited from the draft: an order converted to full
     package stops being eligible, and the next write must find that out. */
  const { file } = await composableFile(ctx, doc.executionFileId, session);
  assertWorkable(file);

  const identity = await materialCatalogue.resolve(ctx, {
    rawItemId: body?.rawItemId, variantId: body?.variantId,
  }, session);

  /* ── ONE MATERIAL, ONE LINE ─────────────────────────────────────────────
     The same item and variant twice on one document is two answers to "how much
     is coming", and Store would have to add them up and hope. A quantity
     change belongs on the line that is already there. */
  const clash = (doc.lines || []).find((l) => str(l.rawItemId) === str(identity.rawItemId)
    && str(l.variantId || "") === str(identity.variantId || ""));
  if (clash) {
    throw fail("CONFLICT",
      `${identity.rawItemName} is already on this document. Change the quantity on that line instead.`,
      { reason: "MATERIAL_ALREADY_ON_DOCUMENT", lineRef: str(clash.lineRef) });
  }

  const line = {
    lineRef: newLineRef(),
    rawItemId: identity.rawItemId,
    variantId: identity.variantId || null,
    rawItemName: identity.rawItemName,
    rawItemSku: identity.rawItemSku,
    variantCombination: identity.variantCombination,
    requiredQuantity: acceptQuantity(body?.requiredQuantity),
    unit: await acceptUnit(ctx, body?.unit, session),
    expectedArrivalDate: acceptDate(body?.expectedArrivalDate),
    note: str(body?.note).slice(0, 1000),
    addedAt: new Date(),
  };

  doc.lines.push(line);
  doc.revision += 1;
  doc.updatedBy = actor || undefined;
  await doc.save({ session });

  await MerchandisingAuditEvent.create([auditRow({
    ctx, doc, file, action: "CUSTOMER_MATERIAL_LINE_ADDED",
    actor, at: new Date(), correlationId: crypto.randomUUID(),
    resultingState: doc.state,
    details: {
      lineRef: line.lineRef, rawItemId: str(line.rawItemId),
      material: line.rawItemName, requiredQuantity: line.requiredQuantity, unit: line.unit,
    },
  })], { session, ordered: true });

  return { expectation: expectationView(doc), lineRef: line.lineRef };
}

/** Change a line's quantity, unit, date or note. Never which material it is. */
async function updateLine(ctx, { docId, lineRef, body = {}, actor = null } = {}, session = null) {
  const doc = await loadDoc(ctx, docId, session);
  assertEditable(doc);
  assertExpected(doc, body?.expectedRevision);
  const { file } = await composableFile(ctx, doc.executionFileId, session);
  assertWorkable(file);

  const line = (doc.lines || []).find((l) => str(l.lineRef) === str(lineRef));
  if (!line) throw fail("NOT_FOUND", "That line is not on this document.", { field: "lineRef" });

  /* ── THE IDENTITY IS NOT EDITABLE ───────────────────────────────────────
     Swapping one material for another inside an edit would leave the history
     saying a fabric's quantity changed when what actually happened is that a
     different fabric was expected. Remove the line and add the other one; that
     says it plainly. */
  for (const forbidden of ["rawItemId", "variantId", "rawItemName", "rawItemSku"]) {
    if (body?.[forbidden] !== undefined && str(body[forbidden]) !== str(line[forbidden] ?? "")) {
      throw fail("VALIDATION",
        "Which material a line is for comes from Store's catalogue and is not edited here. "
        + "Remove the line and add the other material.",
        { reason: "LINE_IDENTITY_NOT_EDITABLE", field: forbidden, lineRef: str(lineRef) });
    }
  }

  const before = {
    requiredQuantity: line.requiredQuantity, unit: str(line.unit),
    expectedArrivalDate: line.expectedArrivalDate || null,
  };
  if (body?.requiredQuantity !== undefined) line.requiredQuantity = acceptQuantity(body.requiredQuantity);
  if (body?.unit !== undefined) line.unit = await acceptUnit(ctx, body.unit, session);
  if (body?.expectedArrivalDate !== undefined) {
    line.expectedArrivalDate = acceptDate(body.expectedArrivalDate);
  }
  if (body?.note !== undefined) line.note = str(body.note).slice(0, 1000);

  doc.revision += 1;
  doc.updatedBy = actor || undefined;
  await doc.save({ session });

  await MerchandisingAuditEvent.create([auditRow({
    ctx, doc, file, action: "CUSTOMER_MATERIAL_LINE_UPDATED",
    actor, at: new Date(), correlationId: crypto.randomUUID(),
    resultingState: doc.state,
    details: {
      lineRef: str(lineRef), material: str(line.rawItemName),
      from: before,
      to: {
        requiredQuantity: line.requiredQuantity, unit: str(line.unit),
        expectedArrivalDate: line.expectedArrivalDate || null,
      },
    },
  })], { session, ordered: true });

  return { expectation: expectationView(doc) };
}

/** Remove a line from the draft. Issued revisions keep theirs for ever. */
async function removeLine(ctx, { docId, lineRef, body = {}, actor = null } = {}, session = null) {
  const doc = await loadDoc(ctx, docId, session);
  assertEditable(doc);
  assertExpected(doc, body?.expectedRevision);
  const { file } = await composableFile(ctx, doc.executionFileId, session);
  assertWorkable(file);

  const line = (doc.lines || []).find((l) => str(l.lineRef) === str(lineRef));
  if (!line) throw fail("NOT_FOUND", "That line is not on this document.", { field: "lineRef" });

  /* ── A RECEIVED LINE CANNOT BE REMOVED ────────────────────────────────────
     Refused here as well as at issue, so somebody is told at the moment they try
     rather than after composing a whole revision around it. The goods are on the
     shelf and an ownership lot names this line; dropping it would leave customer
     stock pointing at nothing. */
  const receipts = require("../storePurchase/customerMaterialReceipt.service");
  const got = (await receipts.receivedByLine(ctx, doc.documentRef, session)).get(str(lineRef));
  if (got && got.received > 0) {
    throw fail("LIFECYCLE_BLOCKED",
      `${got.received} ${str(line.unit)} of "${str(line.rawItemName)}" has already been received, `
      + "so this line cannot be removed. Short close it if no more is coming.",
      {
        reason: "RECEIVED_LINE_REMOVED", lineRef: str(lineRef),
        receivedQuantity: got.received,
      });
  }

  doc.lines = (doc.lines || []).filter((l) => str(l.lineRef) !== str(lineRef));
  doc.revision += 1;
  doc.updatedBy = actor || undefined;
  await doc.save({ session });

  await MerchandisingAuditEvent.create([auditRow({
    ctx, doc, file, action: "CUSTOMER_MATERIAL_LINE_REMOVED",
    actor, at: new Date(), correlationId: crypto.randomUUID(),
    resultingState: doc.state,
    details: {
      lineRef: str(lineRef), material: str(line.rawItemName),
      requiredQuantity: line.requiredQuantity, unit: str(line.unit),
      remaining: doc.lines.length,
    },
  })], { session, ordered: true });

  return { expectation: expectationView(doc) };
}

/** The standing instructions on the draft. */
async function updateInstructions(ctx, { docId, body = {}, actor = null } = {}, session = null) {
  const doc = await loadDoc(ctx, docId, session);
  assertEditable(doc);
  assertExpected(doc, body?.expectedRevision);
  const { file } = await composableFile(ctx, doc.executionFileId, session);
  assertWorkable(file);

  doc.instructions = str(body?.instructions).slice(0, 4000);
  doc.revision += 1;
  doc.updatedBy = actor || undefined;
  await doc.save({ session });

  await MerchandisingAuditEvent.create([auditRow({
    ctx, doc, file, action: "CUSTOMER_MATERIAL_INSTRUCTIONS_UPDATED",
    actor, at: new Date(), correlationId: crypto.randomUUID(),
    resultingState: doc.state,
    details: { length: doc.instructions.length },
  })], { session, ordered: true });

  return { expectation: expectationView(doc) };
}

/* ═══ ISSUING ══════════════════════════════════════════════════════════════ */

/**
 * ISSUE — state it to Store and to the customer.
 *
 * Freezes the revision. Everything written on it stays exactly as issued,
 * because Store will plan around it and the customer will be told it: a
 * document that could be edited after it was sent is one nobody can quote.
 *
 * An empty document cannot be issued. "The customer is sending nothing" is not
 * an expectation, and Store reading an issued document with no lines would have
 * to guess whether it means nothing is coming or somebody forgot.
 */
async function issue(ctx, { docId, body = {}, actor = null } = {}, session = null) {
  const doc = await loadDoc(ctx, docId, session);
  assertEditable(doc);
  assertExpected(doc, body?.expectedRevision);
  const { file } = await composableFile(ctx, doc.executionFileId, session);
  assertWorkable(file);

  if (!(doc.lines || []).length) {
    throw fail("LIFECYCLE_BLOCKED",
      "An empty document tells Store nothing. Add the materials the customer is sending.",
      { reason: "NO_LINES" });
  }

  /* ── AN ISSUED DOCUMENT MUST NAME A PROVABLE OWNER ──────────────────────
     Re-resolved at issue rather than trusted from the draft, for two reasons:
     a Phase 1 draft carries no identity at all and must be repaired before it
     can ever be received against, and a chain that was broken when the draft
     opened may have been fixed since — Sales attaching the customer is exactly
     the repair. Re-walking it turns that into the document simply working,
     instead of somebody having to know to delete the draft and start again.

     `customerId` is never read from the payload here or anywhere else. */
  const identity = await customerIdentity.resolveFromFile(ctx, file, session);
  if (!identity.ok) {
    throw fail("LIFECYCLE_BLOCKED",
      `${identity.message} Nothing the customer sends can be received against this order until `
      + "that is put right, because stock with no provable owner cannot be held.",
      { reason: "CUSTOMER_IDENTITY_UNPROVEN", cause: identity.reason });
  }
  doc.customerId = identity.customerId;
  doc.customerRequestId = identity.customerRequestId;
  doc.customerSnapshot = identity.snapshot;

  /* ── WHAT ALREADY ARRIVED CONSTRAINS WHAT A REVISION MAY SAY ─────────────
     Checked at ISSUE and not while drafting: a draft is where somebody works
     things out, and refusing a keystroke because of a receipt would make the
     document unusable. Issuing is the moment the statement becomes one Store
     acts on, and that is the moment it has to be consistent with what is
     already on the shelf. */
  await assertConsistentWithReceipts(ctx, doc, session);

  const at = new Date();
  const previous = str(doc.state);
  doc.state = STATE.ISSUED;
  doc.issuedBy = actor || undefined;
  doc.issuedAt = at;
  doc.revision += 1;
  await doc.save({ session });

  await MerchandisingAuditEvent.create([auditRow({
    ctx, doc, file, action: "CUSTOMER_MATERIAL_ISSUED",
    actor, at, correlationId: crypto.randomUUID(),
    previousState: previous, resultingState: STATE.ISSUED,
    details: {
      documentRef: str(doc.documentRef), revisionNo: doc.revisionNo,
      lineCount: doc.lines.length,
    },
  })], { session, ordered: true });

  return { expectation: expectationView(doc) };
}

/**
 * CANCEL — withdraw it, with a reason.
 *
 * A draft or an issued revision may both be cancelled; the lines stay for the
 * record, because what was expected is part of the order's history even when it
 * stopped being expected. The reason is required: Store reading a withdrawn
 * document with no explanation cannot tell whether to stand the lorry down.
 */
async function cancel(ctx, { docId, body = {}, actor = null } = {}, session = null) {
  const doc = await loadDoc(ctx, docId, session);
  assertExpected(doc, body?.expectedRevision);
  if (str(doc.state) === STATE.CANCELLED) {
    throw fail("INVALID_TRANSITION", "This document was already cancelled.", { state: doc.state });
  }
  const reason = str(body?.reason);
  if (!reason) {
    throw fail("VALIDATION",
      "Say why it is withdrawn. Store is planning around it and needs to know whether to "
      + "expect the delivery.",
      { field: "reason" });
  }
  /* ── WITHDRAWAL IS NEVER BLOCKED BY THE SOURCE MOVING ─────────────────
     Deliberately NOT checking job work, and deliberately NOT requiring a
     provable customer. An order converted to full package is one of the main
     reasons somebody would withdraw this, and a Phase 1 draft with no customer
     attached is another — refusing either would strand the document in ISSUED
     for ever with Store still planning around it. Cancelling is always
     available on a company's own file, with a reason. */
  const file = await ExecutionFile
    .findOne({ _id: doc.executionFileId, companyId: ctx.companyId }).session(session);

  const at = new Date();
  const previous = str(doc.state);
  doc.state = STATE.CANCELLED;
  doc.cancelledBy = actor || undefined;
  doc.cancelledAt = at;
  doc.cancellationReason = reason.slice(0, 1000);
  doc.revision += 1;
  await doc.save({ session });

  await MerchandisingAuditEvent.create([auditRow({
    ctx, doc, file, action: "CUSTOMER_MATERIAL_CANCELLED",
    actor, at, correlationId: crypto.randomUUID(),
    reason: doc.cancellationReason,
    previousState: previous, resultingState: STATE.CANCELLED,
    details: { documentRef: str(doc.documentRef), revisionNo: doc.revisionNo, wasState: previous },
  })], { session, ordered: true });

  return { expectation: expectationView(doc) };
}

/* ═══ A REVISION MEETS WHAT HAS ALREADY ARRIVED ════════════════════════════ */

/**
 * Refuse a revision that contradicts goods already received.
 *
 * ── THE IDENTITY THAT MAKES THIS POSSIBLE ───────────────────────────────────
 * `documentRef + lineRef`. A revision is a new document with new subdocument
 * ids, so an ObjectId would make every earlier receipt orphaned the moment
 * revision 2 was issued. The stable `lineRef` is carried forward instead, which
 * is why a receipt recorded against revision 1 still counts against revision 2's
 * line — and why each receipt records the revision it was measured against, so
 * the provenance stays exact even as the requirement moves.
 *
 * ── THREE THINGS A REVISION MAY NOT DO ──────────────────────────────────────
 *   · Require LESS than has already been received. The goods are on the shelf;
 *     a requirement below the received quantity would make a line permanently
 *     over-received, and every receipt figure derived from it nonsense.
 *   · REMOVE a line that has receipts. The arrival happened and the lot that
 *     owns it names that line; dropping the line would leave customer-owned
 *     stock pointing at a requirement that no longer exists.
 *   · REPLACE the material on a line that has receipts. Identity changes are
 *     remove-and-add by design, and a received line cannot be removed — so a
 *     received line's material is settled. Changing it would mean the lot on the
 *     shelf and the line describing it disagree about what the material IS.
 *
 * Increasing a requirement is always allowed: it simply increases what is still
 * pending, which is the ordinary case of a customer agreeing to send more.
 */
async function assertConsistentWithReceipts(ctx, doc, session = null) {
  const receipts = require("../storePurchase/customerMaterialReceipt.service");
  const byLine = await receipts.receivedByLine(ctx, doc.documentRef, session);
  if (!byLine.size) return;

  const lines = new Map((doc.lines || []).map((l) => [str(l.lineRef), l]));

  for (const [lineRef, got] of byLine) {
    const received = Number(got.received) || 0;
    if (received <= 0) continue;
    const line = lines.get(lineRef);

    if (!line) {
      /* Which material it WAS, from the receipt itself, so the refusal names
         something a person recognises rather than an opaque reference. */
      const was = got.receipts[0];
      throw fail("LIFECYCLE_BLOCKED",
        `${received} has already been received against a line this revision removes. A line with `
        + "receipts cannot be dropped — the goods are on the shelf and a stock lot names that line. "
        + "Short close it instead if no more is coming.",
        {
          reason: "RECEIVED_LINE_REMOVED",
          lineRef, receivedQuantity: received,
          receiptNumber: was?.receiptNumber || "",
        });
    }

    const required = Number(line.requiredQuantity) || 0;
    if (required < received) {
      throw fail("LIFECYCLE_BLOCKED",
        `"${str(line.rawItemName)}" already has ${received} ${str(line.unit)} received, so this `
        + `revision cannot ask for only ${required} ${str(line.unit)}. Short close the line if no `
        + "more is coming.",
        {
          reason: "REQUIREMENT_BELOW_RECEIVED",
          lineRef, requiredQuantity: required, receivedQuantity: received, unit: str(line.unit),
        });
    }
  }
}

/* ═══ SHORT CLOSURE — STORE'S DECISION ON ONE LINE ═════════════════════════ */

/**
 * "No more of this is coming."
 *
 * Recorded on the line, with a reason and an actor, because it is a DECISION and
 * a derived status cannot hold either. It changes no quantity: what was received
 * is whatever the goods receipts say, and the shortfall stays visible as a
 * shortfall — short closing does not make the missing metres stop having been
 * missing, it stops them being chased.
 *
 * Note what this does NOT touch: the document stays ISSUED. Authoring state and
 * receipt standing are separate, and a Store decision about one line has no
 * business rewriting Merchandising's statement about the document.
 */
async function shortCloseLine(ctx, { docId, lineRef, reason, actor = null } = {}) {
  assertContext(ctx);
  return withTxn(async (session) => {
    const doc = await loadDoc(ctx, docId, session);
    if (str(doc.state) !== STATE.ISSUED) {
      throw fail("INVALID_TRANSITION",
        "Only a document that has been stated to Store can have a line short closed.",
        { state: str(doc.state) });
    }
    const line = (doc.lines || []).find((l) => str(l.lineRef) === str(lineRef));
    if (!line) throw fail("NOT_FOUND", "That line is not on this document.", { field: "lineRef" });
    if (line.shortClosedAt) {
      throw fail("INVALID_TRANSITION", `"${str(line.rawItemName)}" is already short closed.`,
        { reason: "ALREADY_SHORT_CLOSED", lineRef: str(lineRef) });
    }

    const at = new Date();
    line.shortClosedAt = at;
    line.shortClosedBy = actor || undefined;
    line.shortCloseReason = str(reason).slice(0, 1000);
    doc.revision += 1;
    await doc.save({ session });

    const file = await ExecutionFile
      .findOne({ _id: doc.executionFileId, companyId: ctx.companyId }).session(session);
    await MerchandisingAuditEvent.create([auditRow({
      ctx, doc, file, action: "CUSTOMER_MATERIAL_LINE_SHORT_CLOSED",
      actor, at, correlationId: crypto.randomUUID(), reason: line.shortCloseReason,
      resultingState: doc.state,
      details: {
        lineRef: str(lineRef), material: str(line.rawItemName),
        requiredQuantity: line.requiredQuantity, unit: str(line.unit),
      },
    })], { session, ordered: true });

    return { expectation: expectationView(doc), lineRef: str(lineRef) };
  });
}

/** The customer is sending more after all. Explicit, audited, and reversible. */
async function reopenLine(ctx, { docId, lineRef, reason, actor = null } = {}) {
  assertContext(ctx);
  return withTxn(async (session) => {
    const doc = await loadDoc(ctx, docId, session);
    const line = (doc.lines || []).find((l) => str(l.lineRef) === str(lineRef));
    if (!line) throw fail("NOT_FOUND", "That line is not on this document.", { field: "lineRef" });
    if (!line.shortClosedAt) {
      throw fail("INVALID_TRANSITION", `"${str(line.rawItemName)}" is not short closed.`,
        { reason: "NOT_SHORT_CLOSED", lineRef: str(lineRef) });
    }

    const at = new Date();
    /* Cleared, not flagged as "reopened". The line is simply expecting again, and
       the history below is where the round trip is readable — a third state
       would have to be interpreted by every reader for ever. */
    line.shortClosedAt = null;
    line.shortClosedBy = undefined;
    line.shortCloseReason = "";
    doc.revision += 1;
    await doc.save({ session });

    const file = await ExecutionFile
      .findOne({ _id: doc.executionFileId, companyId: ctx.companyId }).session(session);
    await MerchandisingAuditEvent.create([auditRow({
      ctx, doc, file, action: "CUSTOMER_MATERIAL_LINE_REOPENED",
      actor, at, correlationId: crypto.randomUUID(), reason: str(reason).slice(0, 1000),
      resultingState: doc.state,
      details: { lineRef: str(lineRef), material: str(line.rawItemName) },
    })], { session, ordered: true });

    return { expectation: expectationView(doc), lineRef: str(lineRef) };
  });
}

/* ═══ READS ════════════════════════════════════════════════════════════════ */

/**
 * Everything on one execution file: the current draft, the current issued
 * revision, and the whole history.
 *
 * "Current issued" is DERIVED as the highest-numbered issued revision rather
 * than stored. A stored flag is a second source of truth that goes stale
 * exactly when two revisions are issued close together.
 */
async function forFile(ctx, { fileId } = {}) {
  assertContext(ctx);
  /* ── THE READ DOES NOT GATE ON THE MODEL ────────────────────────────────
     It used to, and that was wrong. An issued document that Sales later
     converted to full package became unreadable at the exact moment it became
     contentious: Store was still holding it, the customer had still been told,
     and the screen that explained all that simply refused. The model now
     decides what may be WRITTEN, and the record stays readable either way. */
  const { file, fulfilmentModel, jobWork } = await sourceFile(ctx, fileId);

  const all = await CustomerMaterialExpectation
    .find({ companyId: ctx.companyId, executionFileId: file._id })
    .sort({ revisionNo: -1 }).lean();

  const draft = all.find((d) => d.state === STATE.DRAFT) || null;
  const issued = all.find((d) => d.state === STATE.ISSUED) || null;

  /* Whether the ownership chain can be proven, said on the read so a screen can
     explain that a Phase 1 draft needs repairing before it can be issued —
     rather than letting somebody discover it at the moment they press Issue. */
  const identity = jobWork ? await customerIdentity.resolveFromFile(ctx, file) : null;

  /* ── PROGRESS, DERIVED FROM THE AUTHORITATIVE RECEIPTS ────────────────────
     Never stored on the expectation. A counter written back here would be a
     second source of truth that drifts the first time a receipt is voided or a
     transaction half-commits — and drifts silently, because nothing recomputes
     it to notice. Attached to the ISSUED revision, which is the only one Store
     receives against. */
  const receipts = require("../storePurchase/customerMaterialReceipt.service");
  const standing = issued ? await receipts.standingFor(ctx, issued) : null;

  return {
    /* Is this order still one that may carry such a document? */
    jobWork,
    fulfilmentModel,
    /* ── THE SOURCE MOVED UNDER AN EXISTING DOCUMENT ──────────────────────
       Reported rather than inferred from `jobWork` alone, because "full package
       and never had one" and "had one and was converted" want completely
       different sentences on screen. */
    sourceChanged: !jobWork && all.length > 0,
    canCompose: jobWork && !["CANCELLED", "CLOSED"].includes(str(file.lifecycleStatus)),
    customerProven: identity ? identity.ok : null,
    customerUnproven: identity && !identity.ok
      ? { reason: identity.reason, message: identity.message }
      : null,
    fileId: str(file._id),
    fileNumber: str(file.fileNumber),
    draft: expectationView(draft),
    current: expectationView(issued),
    history: all.map(expectationView),
    /* Receipt STANDING, beside the document rather than folded into it: what
       Merchandising STATED and what has physically ARRIVED are different facts
       with different owners, and a single field would lose the distinction. */
    standing,
    receipt: RECEIPT_AVAILABLE,
  };
}

/**
 * STORE'S REGISTER — the issued documents, newest first.
 *
 * Issued only by default, because Store has no business reading somebody's
 * unfinished draft: a draft is a document being composed, and planning around
 * one is how a department ends up acting on a decision nobody took. Cancelled
 * documents are included on request, because a withdrawal is exactly the thing
 * Store needs to see.
 */
async function register(ctx, { q = "", state = "", page = 1, limit } = {}) {
  assertContext(ctx);
  const size = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const at = Math.max(Number(page) || 1, 1);

  const wanted = str(state).toUpperCase();
  if (wanted && ![STATE.ISSUED, STATE.CANCELLED].includes(wanted)) {
    throw fail("VALIDATION",
      "Store's register reads issued and cancelled documents. A draft is not a statement.",
      { field: "state", allowed: [STATE.ISSUED, STATE.CANCELLED] });
  }

  const where = {
    companyId: ctx.companyId,
    state: wanted || { $in: [STATE.ISSUED, STATE.CANCELLED] },
  };
  if (str(q)) {
    const rx = new RegExp(str(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    where.$or = [
      { documentRef: rx }, { orderRef: rx }, { fileNumber: rx },
      { styleRef: rx }, { buyerStyleRef: rx }, { productName: rx },
      { buyerDisplayLabel: rx },
    ];
  }

  const [rows, total] = await Promise.all([
    CustomerMaterialExpectation.find(where)
      .sort({ issuedAt: -1, updatedAt: -1 })
      .skip((at - 1) * size).limit(size).lean(),
    CustomerMaterialExpectation.countDocuments(where),
  ]);

  const receipts = require("../storePurchase/customerMaterialReceipt.service");
  /* One standing per row. Sequential rather than parallel on purpose: a register
     page is twenty rows, and twenty concurrent aggregate reads inside one request
     is how a list view becomes the slowest thing in the application. */
  const standings = [];
  for (const row of rows) standings.push(await receipts.standingFor(ctx, row));

  return {
    rows: rows.map((r, i) => ({ ...expectationView(r), standing: standings[i] })),
    total,
    page: at,
    limit: size,
    hasMore: at * size < total,
    receipt: RECEIPT_AVAILABLE,
  };
}

/**
 * STORE'S DETAIL VIEW — one issued or cancelled document.
 *
 * A draft answers as one that does not exist. Not hidden behind a permission
 * message: from Store's side there IS no document yet, and saying "you may not
 * see it" would tell them one is being written, which is a fact about somebody
 * else's unfinished work.
 */
async function storeDetail(ctx, { docId } = {}) {
  assertContext(ctx);
  if (!isId(docId)) throw fail("NOT_FOUND", "That document was not found.");
  const doc = await CustomerMaterialExpectation.findOne({
    _id: docId, companyId: ctx.companyId,
    state: { $in: [STATE.ISSUED, STATE.CANCELLED] },
  }).lean();
  if (!doc) throw fail("NOT_FOUND", "That document was not found.");
  const receipts = require("../storePurchase/customerMaterialReceipt.service");
  return {
    expectation: expectationView(doc),
    standing: await receipts.standingFor(ctx, doc),
    receipt: RECEIPT_AVAILABLE,
  };
}

module.exports = {
  /* Exported so the customer-supplied routing service numbers its documents and
     names its lines through Merchandising's OWN minters rather than inventing a
     second series. A development-sample document and an order document are the
     same kind of document and must be numbered from one sequence — a person
     reading "CSM-2026-0041" should not have to know which path produced it. */
  nextDocumentRef,
  newLineRef,
  STATE,
  RECEIPT_AVAILABLE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  sourceFile,
  composableFile,
  assertComposable,
  isEligible,
  expectationView,
  lineView,
  loadDoc,
  openDraft,
  createDraft,
  addLine,
  updateLine,
  removeLine,
  updateInstructions,
  issue,
  cancel,
  shortCloseLine,
  reopenLine,
  assertConsistentWithReceipts,
  forFile,
  register,
  storeDetail,
};
