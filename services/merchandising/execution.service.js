// services/merchandising/execution.service.js
//
// MERCHANDISING RECEIVES, DECIDES AND COORDINATES.
//
// The receiver's whole logic: the New Handovers inbox, the two decisions a
// merchandiser may take on a version (accept, request clarification), the
// Execution File the acceptance opens, its Execution Units, its assignment
// and its lifecycle.
//
// ── THE ONE WAY A FILE EXISTS ───────────────────────────────────────────────
// Accepting a valid, current handover version — atomically with its receipt,
// its units, its audit events and its outbox announcement. There is no create
// endpoint, no import, and no code path here that writes a file from anything
// but an accepted version. The (companyId, handoverRef, handoverLineRef)
// unique index is what makes acceptance idempotent and concurrency safe: a
// retry finds the receipt and returns the same file; a concurrent duplicate
// loses at the database and is answered with the winner's file.
//
// ── AND THERE IS NO DECLINE ─────────────────────────────────────────────────
// Not an endpoint, not a state, not a button. Merchandising accepts the
// execution brief or says precisely what stops acceptance — a categorised
// clarification request Sales resolves commercially. Rejecting the order is
// Sales' authority, expressed as supersession or cancellation.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const HandoverReceipt = require("../../models/CMS_Models/Merchandising/HandoverReceipt");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const { TnaMilestone } = require("../../models/CMS_Models/Merchandising/TnaPlan");
const tnaPortfolio = require("./tnaPortfolio.service");
const { ExecutionPack } = require("../../models/CMS_Models/Merchandising/ExecutionPack");
const { ChangeImpact } = require("../../models/CMS_Models/Merchandising/ChangeControl");
const ExecutionUnit = require("../../models/CMS_Models/Merchandising/ExecutionUnit");
const {
  MerchandisingAuditEvent, MerchandisingOutboxEvent,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const contract = require("../sales/handoverContract");
const { Counter } = require("../salesJourneyRef");
const { getRole } = require("../departmentRoles");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const model = (name, path) => (mongoose.models[name] || require(path));
const SpCompanyMembership = () => model("SpCompanyMembership", "../../models/CMS_Models/StorePurchase/SpCompanyMembership");

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** The register's file views, and the lifecycle each shows.
 *
 *  `HANDED_OVER` was, until M6, a name this map pointed at with nothing able
 *  to produce it — the view was honestly empty and said so. It is now written
 *  by PPC accepting an execution pack, so the view holds records and its count
 *  is real. Note what still cannot produce it: no Merchandising command. */
const FILE_VIEWS = Object.freeze({
  active: ["OPEN"],
  "on-hold": ["ON_HOLD"],
  "handed-over": ["HANDED_OVER"],
  closed: ["CLOSED"],
  cancelled: ["CANCELLED"],
});

/* ═══ TRANSACTIONS ═════════════════════════════════════════════════════════ */

/** One transaction or a 503 — never a half-accepted handover. */
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
  } finally {
    session.endSession();
  }
}

/* ═══ FILE NUMBER ══════════════════════════════════════════════════════════ */

/** MEF-YYYY-NNNN, from the shared CRM counter. A number burned by an aborted
 *  transaction leaves a gap in the sequence, which is honest and harmless;
 *  a duplicate would not be, and the unique index forbids it. */
async function nextFileNumber(year = new Date().getFullYear()) {
  const doc = await Counter.findOneAndUpdate(
    { key: `merchandisingExecutionFile:${year}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return `MEF-${year}-${String(doc.seq).padStart(4, "0")}`;
}

/* ═══ CURSORS ══════════════════════════════════════════════════════════════ */

function encodeCursor(row, field = "updatedAt") {
  const at = row?.[field] ? new Date(row[field]).getTime() : 0;
  return Buffer.from(`${at}.${str(row?._id)}`, "utf8").toString("base64url");
}

function decodeCursor(raw) {
  const value = str(raw);
  if (!value) return null;
  let decoded = "";
  try { decoded = Buffer.from(value, "base64url").toString("utf8"); } catch { decoded = ""; }
  const [at, id] = decoded.split(".");
  const millis = Number(at);
  if (!Number.isFinite(millis) || millis < 0 || !isId(id)) {
    throw fail("VALIDATION", "That page marker is not one this list issued.", { field: "cursor" });
  }
  return { at: new Date(millis), id: new mongoose.Types.ObjectId(id) };
}

function boundedLimit(limit) {
  const asked = limit === undefined || limit === null || limit === "" ? DEFAULT_LIMIT : Number(limit);
  if (!Number.isInteger(asked) || asked < 1) {
    throw fail("VALIDATION", "Ask for a whole number of rows.", { field: "limit" });
  }
  return Math.min(asked, MAX_LIMIT);
}

const escapeRx = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

/* ═══ ALLOWLISTED VIEWS ════════════════════════════════════════════════════ */

/** What Merchandising may be told about one handover version. */
function handoverView(version, receipt) {
  const p = version.executionProjection || {};
  const deliveries = (p.deliveries || []).map((d) => ({
    dropRef: str(d.dropRef),
    committedDeliveryDate: d.committedDeliveryDate,
    quantity: d.quantity,
    nominatedFactoryRef: str(d.nominatedFactoryRef),
    targetExFactoryDate: d.targetExFactoryDate || null,
  }));
  return {
    id: str(version._id),
    handoverRef: str(version.handoverRef),
    handoverLineRef: str(version.handoverLineRef),
    versionNo: version.versionNo,
    publicationState: version.publication?.state || "CURRENT",
    issuedAt: version.sourceRecord?.issuedAt || null,
    source: {
      app: "sales",
      recordType: str(version.sourceRecord?.recordType),
      sourceVersion: str(version.sourceRecord?.sourceVersion),
    },
    orderRef: str(p.orderRef),
    orderLineRef: str(p.orderLineRef),
    styleRef: str(p.styleRef),
    buyerStyleRef: str(p.buyerStyleRef),
    productName: str(p.productName),
    buyerDisplayLabel: str(p.buyerDisplayLabel),
    brandDisplayLabel: str(p.brandDisplayLabel),
    totalQuantity: p.totalQuantity,
    breakdown: (p.breakdown || []).map((b) => ({
      lineSplitRef: str(b.lineSplitRef),
      attributes: (b.attributes || []).map((a) => ({ name: str(a.name), value: str(a.value) })),
      sizeRange: str(b.sizeRange),
      quantity: b.quantity,
    })),
    deliveries,
    /* The split × drop mapping, when the line has two axes. Present exactly
       when Sales had to state it, absent when there was only one reading. */
    allocations: (p.allocations || []).map((a) => ({
      allocationRef: str(a.allocationRef),
      lineSplitRef: str(a.lineSplitRef),
      dropRef: str(a.dropRef),
      quantity: a.quantity,
    })),
    packingRequirement: str(p.packingRequirement),
    testingRequirement: str(p.testingRequirement),
    deliveryRequirement: str(p.deliveryRequirement),
    receiptState: computeReceiptState(version, receipt),
    clarification: receipt?.state === "CLARIFICATION_REQUESTED"
      ? {
        category: str(receipt.clarification?.category),
        reason: str(receipt.clarification?.reason),
        requestedBy: str(receipt.decidedBy?.name),
        requestedAt: receipt.decidedAt || null,
      }
      : null,
    executionFileId: receipt?.executionFileId ? str(receipt.executionFileId) : null,
  };
}

/**
 * The version's standing from Merchandising's side of the table.
 *
 * A version nobody has decided on has no receipt — absence IS pending. A
 * clarification against a version Sales has since replaced or withdrawn is
 * settled by that very act, and reads as the publication says.
 */
function computeReceiptState(version, receipt) {
  if (receipt?.state === "ACCEPTED") return "ACCEPTED";
  const pub = version.publication?.state || "CURRENT";
  if (pub === "SUPERSEDED") return "SUPERSEDED";
  if (pub === "CANCELLED") return "CANCELLED_BY_SALES";
  return receipt?.state === "CLARIFICATION_REQUESTED" ? "CLARIFICATION_REQUESTED" : "PENDING";
}

/** What Merchandising may be told about one Execution File. */
function fileView(file, { units = null } = {}) {
  const p = file.currentExecutionProjection || {};
  const deliveries = (p.deliveries || []).map((d) => ({
    dropRef: str(d.dropRef),
    committedDeliveryDate: d.committedDeliveryDate,
    quantity: d.quantity,
    nominatedFactoryRef: str(d.nominatedFactoryRef),
    targetExFactoryDate: d.targetExFactoryDate || null,
  }));
  return {
    id: str(file._id),
    fileNumber: str(file.fileNumber),
    handoverRef: str(file.handoverRef),
    handoverLineRef: str(file.handoverLineRef),
    orderRef: str(p.orderRef),
    styleRef: str(p.styleRef),
    buyerStyleRef: str(p.buyerStyleRef),
    productName: str(p.productName),
    buyerDisplayLabel: str(p.buyerDisplayLabel),
    totalQuantity: p.totalQuantity,
    deliveries,
    breakdown: (p.breakdown || []).map((b) => ({
      lineSplitRef: str(b.lineSplitRef),
      attributes: (b.attributes || []).map((a) => ({ name: str(a.name), value: str(a.value) })),
      sizeRange: str(b.sizeRange),
      quantity: b.quantity,
    })),
    allocations: (p.allocations || []).map((a) => ({
      allocationRef: str(a.allocationRef),
      lineSplitRef: str(a.lineSplitRef),
      dropRef: str(a.dropRef),
      quantity: a.quantity,
    })),
    packingRequirement: str(p.packingRequirement),
    testingRequirement: str(p.testingRequirement),
    deliveryRequirement: str(p.deliveryRequirement),
    lifecycleStatus: str(file.lifecycleStatus),
    lifecycleReason: str(file.lifecycleReason),
    executionPhase: str(file.executionPhase),
    responsibleMerchandiser: file.responsibleMerchandiser?.email
      ? {
        email: str(file.responsibleMerchandiser.email),
        name: str(file.responsibleMerchandiser.name),
        assignedAt: file.responsibleMerchandiser.assignedAt || null,
      }
      : null,
    tags: (file.tags || []).map(str),
    coordinationNote: str(file.coordinationNote),
    currentVersion: {
      id: str(file.currentHandoverVersionId),
      versionNo: file.sourceVersionHistory?.length
        ? file.sourceVersionHistory[file.sourceVersionHistory.length - 1].versionNo
        : null,
    },
    sourceVersionHistory: (file.sourceVersionHistory || []).map((h) => ({
      versionId: str(h.versionId), versionNo: h.versionNo, event: str(h.event),
      at: h.at, byName: str(h.by?.name),
    })),
    cancellation: file.cancellation?.at
      ? { at: file.cancellation.at, reason: str(file.cancellation.reason) }
      : null,
    revision: file.revision,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    ...(units ? { units: units.map(unitView) } : {}),
  };
}

function unitView(unit) {
  return {
    id: str(unit._id),
    unitDiscriminator: str(unit.unitDiscriminator),
    lineSplitRef: str(unit.lineSplitRef),
    allocationRef: str(unit.allocationRef),
    attributes: (unit.attributes || []).map((a) => ({ name: str(a.name), value: str(a.value) })),
    sizeRange: str(unit.sizeRange),
    dropRef: str(unit.dropRef),
    committedDeliveryDate: unit.committedDeliveryDate || null,
    nominatedFactoryRef: str(unit.nominatedFactoryRef),
    quantity: unit.quantity,
    sourceVersionNo: unit.sourceVersionNo,
    active: unit.active !== false,
  };
}

/* ═══ EXECUTION UNITS — DERIVATION ═════════════════════════════════════════ */

/**
 * The Execution Units one accepted projection produces.
 *
 * ── WHY THIS IS ONE LINE ────────────────────────────────────────────────────
 * It used to be forty, and they were forty lines of a rule Sales also owned a
 * copy of. The two copies disagreed: the producer reconciled the confirmed
 * splits and the delivery drops as two independent axes, and this derived a
 * unit for every row of BOTH — so a line confirmed in three colourways across
 * two deliveries stored six units totalling twice the order, with nothing to
 * say which colourway travelled in which drop. Every number came from Sales
 * and the total was still wrong.
 *
 * The rule now lives once, in the contract both applications import, and the
 * multi-axis case is answered by an explicit Sales-authored allocation rather
 * than by either side guessing. See `services/sales/handoverContract.js`.
 */
function deriveUnits(projection) {
  return contract.deriveUnitPlan(projection || {});
}

/** Bring a file's units in line with a newly accepted projection, in-session. */
async function syncUnits({ file, version, session }) {
  const desired = deriveUnits(version.executionProjection || {});
  const existing = await ExecutionUnit.find({ fileId: file._id }).session(session);
  const byKey = new Map(existing.map((u) => [u.unitDiscriminator, u]));
  const seen = new Set();

  for (const raw of desired) {
    /* Defaulted rather than left absent: a unit re-derived from a projection
       that no longer maps through an allocation must not keep the reference
       from the one that did. */
    const want = { allocationRef: "", lineSplitRef: "", ...raw };
    seen.add(want.unitDiscriminator);
    const have = byKey.get(want.unitDiscriminator);
    if (have) {
      have.set({
        ...want,
        sourceVersionId: version._id,
        sourceVersionNo: version.versionNo,
        active: true,
      });
      await have.save({ session });
    } else {
      await ExecutionUnit.create([{
        fileId: file._id,
        companyId: file.companyId,
        ...want,
        sourceVersionId: version._id,
        sourceVersionNo: version.versionNo,
        active: true,
      }], { session });
    }
  }
  /* A tuple the new version no longer confirms is withdrawn, not erased. */
  for (const have of existing) {
    if (!seen.has(have.unitDiscriminator) && have.active !== false) {
      have.active = false;
      have.sourceVersionId = version._id;
      have.sourceVersionNo = version.versionNo;
      await have.save({ session });
    }
  }
}

/* ═══ THE INBOX ════════════════════════════════════════════════════════════ */

/**
 * New Handovers: every CURRENT version this company holds that Merchandising
 * has not yet accepted. A clarified version stays here — it is still the
 * latest statement, still awaiting either acceptance or a Sales move.
 */
async function listHandovers(ctx, { q = "", cursor, limit } = {}) {
  assertContext(ctx);
  const size = boundedLimit(limit);
  const after = decodeCursor(cursor);

  const filter = { companyId: ctx.companyId, "publication.state": "CURRENT" };
  const term = str(q);
  if (term) {
    const rx = new RegExp(escapeRx(term), "i");
    filter.$and = [{
      $or: [
        { "executionProjection.orderRef": rx },
        { "executionProjection.styleRef": rx },
        { "executionProjection.productName": rx },
        { "executionProjection.buyerDisplayLabel": rx },
      ],
    }];
  }
  if (after) {
    (filter.$and = filter.$and || []).push({
      $or: [
        { createdAt: { $lt: after.at } },
        { createdAt: after.at, _id: { $lt: after.id } },
      ],
    });
  }

  const versions = await SalesHandoverVersion.find(filter)
    .sort({ createdAt: -1, _id: -1 }).limit(size + 1).lean();
  const page = versions.slice(0, size);

  const receipts = await HandoverReceipt.find({
    companyId: ctx.companyId,
    handoverVersionId: { $in: page.map((v) => v._id) },
  }).lean();
  const receiptByVersion = new Map(receipts.map((r) => [str(r.handoverVersionId), r]));

  /* Accepted versions have become files; the inbox is what still needs a
     decision. Filtered after the page read because acceptance is the rare
     state here — an accepted version's receipt points at its file and the
     row simply drops out. */
  const rows = page
    .map((v) => handoverView(v, receiptByVersion.get(str(v._id))))
    .filter((v) => v.receiptState !== "ACCEPTED")
    .map((v) => ({ rowType: "HANDOVER", ...v }));

  return {
    rows,
    limit: size,
    hasMore: versions.length > size,
    nextCursor: versions.length > size ? encodeCursor(page[page.length - 1], "createdAt") : null,
  };
}

/** The count the Overview shows for New Handovers — same rules, no page. */
async function countPendingHandovers(ctx) {
  assertContext(ctx);
  const versions = await SalesHandoverVersion.find({
    companyId: ctx.companyId, "publication.state": "CURRENT",
  }).select("_id").lean();
  if (!versions.length) return 0;
  const accepted = await HandoverReceipt.countDocuments({
    companyId: ctx.companyId,
    handoverVersionId: { $in: versions.map((v) => v._id) },
    state: "ACCEPTED",
  });
  return versions.length - accepted;
}

/** One version, with its receipt and the full lineage of its line. */
async function getHandover(ctx, { id } = {}) {
  assertContext(ctx);
  if (!isId(id)) throw fail("NOT_FOUND", "Handover not found.");
  const version = await SalesHandoverVersion.findOne({ _id: id, companyId: ctx.companyId }).lean();
  if (!version) throw fail("NOT_FOUND", "Handover not found.");

  const [receipt, lineage, lineReceipts] = await Promise.all([
    HandoverReceipt.findOne({ companyId: ctx.companyId, handoverVersionId: version._id }).lean(),
    SalesHandoverVersion.find({
      companyId: ctx.companyId,
      handoverRef: version.handoverRef,
      handoverLineRef: version.handoverLineRef,
    }).sort({ versionNo: 1 }).lean(),
    HandoverReceipt.find({
      companyId: ctx.companyId,
      handoverRef: version.handoverRef,
      handoverLineRef: version.handoverLineRef,
    }).lean(),
  ]);
  const receiptByVersion = new Map(lineReceipts.map((r) => [str(r.handoverVersionId), r]));

  return {
    handover: handoverView(version, receipt),
    lineage: lineage.map((v) => {
      const r = receiptByVersion.get(str(v._id));
      return {
        id: str(v._id),
        versionNo: v.versionNo,
        publicationState: v.publication?.state || "CURRENT",
        issuedAt: v.sourceRecord?.issuedAt || null,
        receiptState: computeReceiptState(v, r),
        clarification: r?.state === "CLARIFICATION_REQUESTED"
          ? { category: str(r.clarification?.category), reason: str(r.clarification?.reason) }
          : null,
      };
    }),
  };
}

/* ═══ THE TWO DECISIONS ════════════════════════════════════════════════════ */

/** Load a version for a decision. Foreign and missing are one answer. */
async function loadDecidableVersion(ctx, id, session) {
  if (!isId(id)) throw fail("NOT_FOUND", "Handover not found.");
  const version = await SalesHandoverVersion.findOne({ _id: id, companyId: ctx.companyId }).session(session);
  if (!version) throw fail("NOT_FOUND", "Handover not found.");
  return version;
}

/**
 * ACCEPT — open (or update) the Execution File from this version.
 *
 * Idempotent by construction: an existing ACCEPTED receipt for the version
 * short-circuits to the same file; a concurrent duplicate loses at the
 * receipt's unique index, and the loser re-reads and answers with the
 * winner's file.
 */
async function acceptHandover(ctx, { id, actor = null } = {}) {
  assertContext(ctx);
  const correlationId = crypto.randomUUID();
  const now = new Date();

  const run = () => withTxn(async (session) => {
    const version = await loadDecidableVersion(ctx, id, session);

    const existing = await HandoverReceipt.findOne({
      companyId: ctx.companyId, handoverVersionId: version._id,
    }).session(session);
    if (existing?.state === "ACCEPTED") {
      const file = await ExecutionFile.findById(existing.executionFileId).session(session);
      return { file: fileView(file), alreadyAccepted: true };
    }

    const pub = version.publication?.state || "CURRENT";
    if (pub !== "CURRENT") {
      throw fail("HANDOVER_STATE_CONFLICT",
        pub === "SUPERSEDED"
          ? "A newer version of this handover has been issued. Open the latest version and decide on that."
          : "Sales has cancelled this handover. There is nothing to accept.",
        { publicationState: pub });
    }

    /* One file per line, found or created. */
    let file = await ExecutionFile.findOne({
      companyId: ctx.companyId,
      handoverRef: version.handoverRef,
      handoverLineRef: version.handoverLineRef,
    }).session(session);

    const audits = [];
    if (!file) {
      const fileNumber = await nextFileNumber();
      [file] = await ExecutionFile.create([{
        fileNumber,
        companyId: ctx.companyId,
        handoverRef: version.handoverRef,
        handoverLineRef: version.handoverLineRef,
        currentHandoverVersionId: version._id,
        sourceVersionHistory: [{
          versionId: version._id, versionNo: version.versionNo,
          event: "ACCEPTED", at: now, by: actor || undefined,
        }],
        currentExecutionProjection: version.executionProjection,
        lifecycleStatus: "OPEN",
        createdBy: actor || undefined,
        updatedBy: actor || undefined,
      }], { session });
      audits.push({
        companyId: ctx.companyId, recordType: "EXECUTION_FILE",
        recordId: file._id, recordRevision: 0,
        action: "FILE_CREATED", actor: actor || undefined, source: "merchandising",
        at: now, correlationId, resultingState: "OPEN",
        details: { fileNumber, versionNo: version.versionNo },
      });
    } else {
      if (file.lifecycleStatus === "CANCELLED") {
        throw fail("HANDOVER_STATE_CONFLICT",
          "This line's execution file was cancelled by Sales and cannot take a new acceptance.");
      }
      file.currentHandoverVersionId = version._id;
      file.currentExecutionProjection = version.executionProjection;
      file.sourceVersionHistory.push({
        versionId: version._id, versionNo: version.versionNo,
        event: "ACCEPTED", at: now, by: actor || undefined,
      });
      file.revision += 1;
      file.updatedBy = actor || undefined;
      await file.save({ session });
      audits.push({
        companyId: ctx.companyId, recordType: "EXECUTION_FILE",
        recordId: file._id, recordRevision: file.revision,
        action: "FILE_UPDATED", actor: actor || undefined, source: "merchandising",
        at: now, correlationId,
        resultingState: file.lifecycleStatus,
        details: { versionNo: version.versionNo, change: "accepted a newer handover version" },
      });
    }

    await syncUnits({ file, version, session });

    /* The decision itself — created, or moved from a clarification the
       merchandiser has since had answered outside the record. */
    let receipt = existing;
    if (receipt) {
      receipt.state = "ACCEPTED";
      receipt.executionFileId = file._id;
      receipt.decidedBy = actor || undefined;
      receipt.decidedAt = now;
      receipt.correlationId = correlationId;
      await receipt.save({ session });
    } else {
      [receipt] = await HandoverReceipt.create([{
        companyId: ctx.companyId,
        handoverVersionId: version._id,
        handoverRef: version.handoverRef,
        handoverLineRef: version.handoverLineRef,
        sourceVersionNo: version.versionNo,
        state: "ACCEPTED",
        executionFileId: file._id,
        decidedBy: actor || undefined,
        decidedAt: now,
        correlationId,
      }], { session });
    }

    audits.push({
      companyId: ctx.companyId, recordType: "HANDOVER_RECEIPT",
      recordId: receipt._id, recordRevision: version.versionNo,
      action: "HANDOVER_ACCEPTED", actor: actor || undefined, source: "merchandising",
      at: now, correlationId,
      resultingState: "ACCEPTED",
      details: { handoverRef: version.handoverRef, versionNo: version.versionNo, fileNumber: file.fileNumber },
    });
    await MerchandisingAuditEvent.create(audits, { session, ordered: true });
    await MerchandisingOutboxEvent.create([{
      companyId: ctx.companyId,
      kind: "HANDOVER_ACCEPTED",
      payload: {
        handoverVersionId: version._id,
        handoverRef: version.handoverRef,
        handoverLineRef: version.handoverLineRef,
        sourceVersionNo: version.versionNo,
        executionFileId: file._id,
      },
      correlationId,
    }], { session });

    return { file: fileView(file), alreadyAccepted: false };
  });

  try {
    return await run();
  } catch (err) {
    /* The concurrent duplicate: somebody else's acceptance committed between
       our read and our write. Their decision stands; answer with their file. */
    if (err?.code === 11000) {
      const receipt = await HandoverReceipt.findOne({
        companyId: ctx.companyId, handoverVersionId: id,
      }).lean();
      if (receipt?.state === "ACCEPTED" && receipt.executionFileId) {
        const file = await ExecutionFile.findOne({
          _id: receipt.executionFileId, companyId: ctx.companyId,
        }).lean();
        if (file) return { file: fileView(file), alreadyAccepted: true };
      }
    }
    throw err;
  }
}

/**
 * REQUEST CLARIFICATION — the structured "this stops me accepting".
 *
 * Creates no file, and never will: a clarification is a question to Sales,
 * not a state of execution.
 */
async function requestClarification(ctx, { id, category, reason, actor = null } = {}) {
  assertContext(ctx);
  const cat = str(category).toUpperCase();
  if (!HandoverReceipt.CLARIFICATION_CATEGORIES.includes(cat)) {
    throw fail("VALIDATION", "Choose what kind of clarification this is.", {
      field: "category", allowed: HandoverReceipt.CLARIFICATION_CATEGORIES,
    });
  }
  const text = str(reason);
  if (!text) {
    throw fail("VALIDATION", "Say what needs clarifying — Sales cannot act on a category alone.", { field: "reason" });
  }

  const correlationId = crypto.randomUUID();
  const now = new Date();

  return withTxn(async (session) => {
    const version = await loadDecidableVersion(ctx, id, session);
    const pub = version.publication?.state || "CURRENT";
    if (pub !== "CURRENT") {
      throw fail("HANDOVER_STATE_CONFLICT",
        "This is no longer the current version. Open the latest one and decide on that.",
        { publicationState: pub });
    }
    const existing = await HandoverReceipt.findOne({
      companyId: ctx.companyId, handoverVersionId: version._id,
    }).session(session);
    if (existing?.state === "ACCEPTED") {
      throw fail("HANDOVER_STATE_CONFLICT", "This version has already been accepted.");
    }
    if (existing?.state === "CLARIFICATION_REQUESTED") {
      throw fail("HANDOVER_STATE_CONFLICT",
        "A clarification has already been requested on this version. Sales answers it with a revised version.");
    }

    const [receipt] = await HandoverReceipt.create([{
      companyId: ctx.companyId,
      handoverVersionId: version._id,
      handoverRef: version.handoverRef,
      handoverLineRef: version.handoverLineRef,
      sourceVersionNo: version.versionNo,
      state: "CLARIFICATION_REQUESTED",
      clarification: { category: cat, reason: text.slice(0, 2000) },
      decidedBy: actor || undefined,
      decidedAt: now,
      correlationId,
    }], { session });

    await MerchandisingAuditEvent.create([{
      companyId: ctx.companyId, recordType: "HANDOVER_RECEIPT",
      recordId: receipt._id, recordRevision: version.versionNo,
      action: "CLARIFICATION_REQUESTED", actor: actor || undefined, source: "merchandising",
      at: now, reason: text.slice(0, 2000), correlationId,
      resultingState: "CLARIFICATION_REQUESTED",
      details: { handoverRef: version.handoverRef, versionNo: version.versionNo, category: cat },
    }], { session, ordered: true });
    await MerchandisingOutboxEvent.create([{
      companyId: ctx.companyId,
      kind: "CLARIFICATION_REQUESTED",
      payload: {
        handoverVersionId: version._id,
        handoverRef: version.handoverRef,
        handoverLineRef: version.handoverLineRef,
        sourceVersionNo: version.versionNo,
        clarificationCategory: cat,
      },
      correlationId,
    }], { session });

    return { receipt: { id: str(receipt._id), state: "CLARIFICATION_REQUESTED", category: cat } };
  });
}

/* ═══ THE REGISTER ═════════════════════════════════════════════════════════ */

async function listFiles(ctx, {
  view = "active", q = "", lifecycle = "", responsible = "", assignedTo = "",
  includeArchived = false, cursor, limit,
} = {}) {
  assertContext(ctx);
  const size = boundedLimit(limit);
  const after = decodeCursor(cursor);

  const wantedView = str(view).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(FILE_VIEWS, wantedView)) {
    throw fail("VALIDATION", "That is not a register view.", { field: "view", allowed: Object.keys(FILE_VIEWS) });
  }
  let statuses = FILE_VIEWS[wantedView];
  const wantedLifecycle = str(lifecycle).toUpperCase();
  if (wantedLifecycle) {
    if (!statuses.includes(wantedLifecycle)) {
      return { rows: [], limit: size, hasMore: false, nextCursor: null };
    }
    statuses = [wantedLifecycle];
  }

  const filter = { companyId: ctx.companyId, lifecycleStatus: { $in: statuses } };
  /* ── M7: ARCHIVED IS OUT OF THE DEFAULT REGISTER ──────────────────────
     Hidden, never deleted. The row is untouched and opens by direct
     reference; `includeArchived` brings it back into the list for somebody
     who is deliberately looking through finished history. */
  if (!includeArchived) filter.archived = { $ne: true };
  const and = [];
  const term = str(q);
  if (term) {
    const rx = new RegExp(escapeRx(term), "i");
    and.push({
      $or: [
        { fileNumber: rx },
        { handoverRef: rx },
        { "currentExecutionProjection.orderRef": rx },
        { "currentExecutionProjection.styleRef": rx },
        { "currentExecutionProjection.productName": rx },
      ],
    });
  }
  const who = str(assignedTo || responsible).toLowerCase();
  if (who) filter["responsibleMerchandiser.email"] = who;
  if (after) {
    and.push({
      $or: [
        { updatedAt: { $lt: after.at } },
        { updatedAt: after.at, _id: { $lt: after.id } },
      ],
    });
  }
  if (and.length) filter.$and = and;

  const files = await ExecutionFile.find(filter)
    .sort({ updatedAt: -1, _id: -1 }).limit(size + 1).lean();
  const page = files.slice(0, size);

  /* ── M5: WHAT EACH FILE IS WAITING ON NEXT ────────────────────────────
     One batched aggregation for the whole page, not one read per row —
     twenty-five separate lookups to fill one column is how a register
     becomes slow, and the column is not worth that.

     A file with no plan simply has no next milestone, and the register shows
     nothing rather than a dash pretending to be a date. */
  const nextByFile = await tnaPortfolio.nextMilestoneFor(ctx, page.map((f) => f._id));

  /* ── M7: OPEN CHANGES PER FILE ────────────────────────────────────────
     One batched query for the page, not one per row. A file with an open
     change is a file where the confirmed requirement has moved and somebody
     has to look — which is exactly the thing a dense register should surface
     and nothing else about change control belongs here. */
  const openChangeCounts = await countOpenChangesFor(ctx, page);

  return {
    rows: page.map((f) => ({
      rowType: "FILE",
      ...fileView(f),
      nextMilestone: nextByFile[str(f._id)] || null,
      /* ── M6: WHERE THE HANDOVER STANDS ────────────────────────────────
         Mirrored fields, read straight off the file so a page of rows costs
         no extra queries. Both are labelled on screen as PPC's statement —
         the authoritative answers are the pack and PPC's own receipt. */
      handover: {
        packVersionNo: f.currentPackVersionNo ?? null,
        receiptState: str(f.downstreamReceiptState) || (f.currentPackVersionNo ? "PENDING" : null),
        executionPhase: str(f.executionPhase),
      },
      openChanges: openChangeCounts[str(f._id)] || 0,
      archived: f.archived === true,
    })),
    limit: size,
    hasMore: files.length > size,
    nextCursor: files.length > size ? encodeCursor(page[page.length - 1]) : null,
  };
}

/**
 * How many live changes each file on this page carries.
 *
 * A change is OPEN while its notice is issued and its impact is not closed —
 * which includes the case with no impact record at all, because a change
 * nobody has assessed is the most open a change can be.
 */
async function countOpenChangesFor(ctx, files) {
  if (!files.length) return {};
  const { SalesChangeNotice } = require("../../models/CMS_Models/Sales/SalesChangeNotice");
  const keys = files.map((f) => ({ handoverRef: f.handoverRef, handoverLineRef: f.handoverLineRef }));

  const notices = await SalesChangeNotice.find({
    companyId: ctx.companyId,
    state: "ISSUED",
    $or: keys.map((k) => ({ handoverRef: k.handoverRef, handoverLineRef: k.handoverLineRef })),
  }).select("changeRef versionNo handoverRef handoverLineRef").lean();
  if (!notices.length) return {};

  const closed = await ChangeImpact.find({
    companyId: ctx.companyId,
    changeRef: { $in: notices.map((n) => n.changeRef) },
    state: "CLOSED",
  }).select("changeRef changeVersionNo").lean();
  const isClosed = new Set(closed.map((i) => `${i.changeRef}:${i.changeVersionNo}`));

  const byLine = new Map();
  for (const n of notices) {
    if (isClosed.has(`${n.changeRef}:${n.versionNo}`)) continue;
    const key = `${n.handoverRef}::${n.handoverLineRef}`;
    byLine.set(key, (byLine.get(key) || 0) + 1);
  }
  return Object.fromEntries(files.map((f) => [
    str(f._id), byLine.get(`${f.handoverRef}::${f.handoverLineRef}`) || 0,
  ]));
}

async function getFile(ctx, { id } = {}) {
  assertContext(ctx);
  if (!isId(id)) throw fail("NOT_FOUND", "Execution file not found.");
  const file = await ExecutionFile.findOne({ _id: id, companyId: ctx.companyId }).lean();
  if (!file) throw fail("NOT_FOUND", "Execution file not found.");
  const units = await ExecutionUnit.find({ fileId: file._id }).sort({ unitDiscriminator: 1 }).lean();
  return { file: fileView(file, { units }) };
}

/* ═══ FILE COMMANDS ════════════════════════════════════════════════════════ */

/** Load a file for a command, holding its revision against the caller's. */
async function loadFileForCommand(ctx, id, expectedRevision, session) {
  if (!isId(id)) throw fail("NOT_FOUND", "Execution file not found.");
  const file = await ExecutionFile.findOne({ _id: id, companyId: ctx.companyId }).session(session);
  if (!file) throw fail("NOT_FOUND", "Execution file not found.");
  const expected = Number(expectedRevision);
  if (!Number.isInteger(expected)) {
    throw fail("VALIDATION", "Send the revision you read, so a concurrent change is a conflict rather than an overwrite.", { field: "expectedRevision" });
  }
  if (file.revision !== expected) {
    throw fail("FILE_REVISION_CONFLICT",
      "This file changed while you were working. Re-read it and decide again.",
      { currentRevision: file.revision });
  }
  return file;
}

/** The only fields a PATCH may carry. Everything server-owned is refused by name. */
const PATCH_FIELDS = Object.freeze(["expectedRevision", "coordinationNote", "tags"]);
const PATCH_REFUSED = Object.freeze({
  lifecycleStatus: "the lifecycle — use its own commands",
  executionPhase: "the execution phase",
  companyId: "a company stamp",
  fileNumber: "the file number",
  handoverRef: "the handover identity",
  handoverLineRef: "the handover identity",
  currentExecutionProjection: "the commercial projection — Sales issues a new version",
  currentHandoverVersionId: "the source version",
  responsibleMerchandiser: "the assignment — use the assignment command",
  revision: "the revision counter",
  cancellation: "a cancellation — that is Sales' act",
  quantity: "a confirmed quantity", deliveries: "a delivery commitment",
});

async function patchFile(ctx, { id, body = {}, actor = null } = {}) {
  assertContext(ctx);
  for (const key of Object.keys(body)) {
    const refused = PATCH_REFUSED[key];
    if (refused) throw fail("FIELD_NOT_ACCEPTED", `This edits Merchandising's own notes. It cannot carry ${refused}.`, { field: key });
    if (!PATCH_FIELDS.includes(key)) throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of an execution file edit.`, { field: key });
  }
  const correlationId = crypto.randomUUID();
  const now = new Date();

  return withTxn(async (session) => {
    const file = await loadFileForCommand(ctx, id, body.expectedRevision, session);
    if (file.lifecycleStatus === "CANCELLED") {
      throw fail("INVALID_TRANSITION", "A cancelled file is read-only.");
    }
    if (body.coordinationNote !== undefined) file.coordinationNote = str(body.coordinationNote).slice(0, 4000);
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags)) throw fail("VALIDATION", "Tags are a list.", { field: "tags" });
      file.tags = [...new Set(body.tags.map((t) => str(t)).filter(Boolean))].slice(0, 20);
    }
    file.revision += 1;
    file.updatedBy = actor || undefined;
    await file.save({ session });

    await MerchandisingAuditEvent.create([{
      companyId: ctx.companyId, recordType: "EXECUTION_FILE",
      recordId: file._id, recordRevision: file.revision,
      action: "FILE_UPDATED", actor: actor || undefined, source: "merchandising",
      at: now, correlationId,
      resultingState: file.lifecycleStatus,
      details: { change: "coordination note or tags" },
    }], { session, ordered: true });

    return { file: fileView(file) };
  });
}

/**
 * ASSIGN — who answers for this file.
 *
 * The assignee must be a live Merchandising person in the acting company:
 * an active `merchandiser` grant AND an active membership here. Assignment
 * never widens what anybody may do — the access layer does not read it.
 */
async function assignFile(ctx, { id, body = {}, actor = null } = {}) {
  assertContext(ctx);
  const email = str(body.email).toLowerCase();
  if (!email) throw fail("VALIDATION", "Name who is responsible, by their email.", { field: "email" });

  const [role, membership] = await Promise.all([
    getRole("merchandiser", email),
    SpCompanyMembership().findOne({ companyId: ctx.companyId, email, isActive: true }).lean(),
  ]);
  if (!role) {
    throw fail("VALIDATION", "That person holds no active Merchandising role.", { field: "email" });
  }
  if (!membership) {
    throw fail("VALIDATION", "That person is not a member of this company.", { field: "email" });
  }

  const correlationId = crypto.randomUUID();
  const now = new Date();

  return withTxn(async (session) => {
    const file = await loadFileForCommand(ctx, id, body.expectedRevision, session);
    if (file.lifecycleStatus === "CANCELLED") {
      throw fail("INVALID_TRANSITION", "A cancelled file is read-only.");
    }

    const previous = str(file.responsibleMerchandiser?.email);
    const reason = str(body.reason);
    if (previous && previous !== email && !reason) {
      throw fail("VALIDATION", "Say why responsibility is moving — the person losing it will read this.", { field: "reason" });
    }

    const name = str(body.name) || str(membership.personName) || email;
    file.responsibleMerchandiser = {
      email, name, assignedAt: now, assignedBy: actor || undefined,
    };
    file.assignmentHistory.push({ email, name, reason, at: now, by: actor || undefined });
    file.revision += 1;
    file.updatedBy = actor || undefined;
    await file.save({ session });

    await MerchandisingAuditEvent.create([{
      companyId: ctx.companyId, recordType: "EXECUTION_FILE",
      recordId: file._id, recordRevision: file.revision,
      action: "FILE_ASSIGNED", actor: actor || undefined, source: "merchandising",
      at: now, reason, correlationId,
      previousState: previous, resultingState: email,
      details: { assigneeName: name },
    }], { session, ordered: true });

    return { file: fileView(file) };
  });
}

/* The lifecycle matrix — exactly the four Merchandising transitions. */
const LIFECYCLE_COMMANDS = Object.freeze({
  hold: { from: ["OPEN"], to: "ON_HOLD", action: "FILE_HELD", reasonRequired: true },
  resume: { from: ["ON_HOLD"], to: "OPEN", action: "FILE_RESUMED", reasonRequired: false },
  close: { from: ["OPEN"], to: "CLOSED", action: "FILE_CLOSED", reasonRequired: false },
  reopen: { from: ["CLOSED"], to: "OPEN", action: "FILE_REOPENED", reasonRequired: true },
});

async function moveLifecycle(ctx, { id, command, body = {}, actor = null } = {}) {
  assertContext(ctx);
  const spec = LIFECYCLE_COMMANDS[str(command)];
  if (!spec) throw fail("VALIDATION", "That is not a lifecycle command.", { field: "command" });
  const reason = str(body.reason);
  if (spec.reasonRequired && !reason) {
    throw fail("VALIDATION",
      command === "hold"
        ? "Say why this file is being put on hold."
        : "Say why this file is being reopened.",
      { field: "reason" });
  }

  const correlationId = crypto.randomUUID();
  const now = new Date();

  return withTxn(async (session) => {
    const file = await loadFileForCommand(ctx, id, body.expectedRevision, session);
    if (!spec.from.includes(file.lifecycleStatus)) {
      throw fail("INVALID_TRANSITION",
        file.lifecycleStatus === "CANCELLED"
          ? "Sales cancelled this file, and Merchandising cannot move it."
          : `A file cannot go from ${file.lifecycleStatus.toLowerCase().replace("_", " ")} to ${spec.to.toLowerCase().replace("_", " ")}.`,
        { from: file.lifecycleStatus, to: spec.to });
    }
    const previous = file.lifecycleStatus;
    file.lifecycleStatus = spec.to;
    file.lifecycleReason = reason;
    file.revision += 1;
    file.updatedBy = actor || undefined;
    await file.save({ session });

    await MerchandisingAuditEvent.create([{
      companyId: ctx.companyId, recordType: "EXECUTION_FILE",
      recordId: file._id, recordRevision: file.revision,
      action: spec.action, actor: actor || undefined, source: "merchandising",
      at: now, reason, correlationId,
      previousState: previous, resultingState: spec.to,
    }], { session, ordered: true });

    return { file: fileView(file) };
  });
}

/* ═══ HISTORY ══════════════════════════════════════════════════════════════ */

/**
 * Changes & History: the file's own append-only events, plus its source
 * lineage — every version Sales has issued for this line and what became of
 * each. Two lists, because they are two different kinds of truth.
 */
async function fileHistory(ctx, { id } = {}) {
  assertContext(ctx);
  if (!isId(id)) throw fail("NOT_FOUND", "Execution file not found.");
  const file = await ExecutionFile.findOne({ _id: id, companyId: ctx.companyId }).lean();
  if (!file) throw fail("NOT_FOUND", "Execution file not found.");

  const [versions, receipts] = await Promise.all([
    SalesHandoverVersion.find({
      companyId: ctx.companyId, handoverRef: file.handoverRef, handoverLineRef: file.handoverLineRef,
    }).sort({ versionNo: 1 }).lean(),
    HandoverReceipt.find({
      companyId: ctx.companyId, handoverRef: file.handoverRef, handoverLineRef: file.handoverLineRef,
    }).lean(),
  ]);

  /* ── SALES' ACTS BELONG IN THIS HISTORY TOO ─────────────────────────────
     Issuing and superseding happen on the VERSION, not on the file, and the
     rows recording them are written by Merchandising's own receiver when the
     Sales event is delivered — never by Sales reaching in here. Reading them
     alongside the file's own events is what makes the tab a full account of
     how this file came to say what it says. */
  const lineageIds = [file._id, ...versions.map((v) => v._id), ...receipts.map((r) => r._id)];
  /* ── AND SO DO THIS FILE'S OWN LATER ACTS ───────────────────────────────
     Selections, T&A, the execution pack, department status and change
     control all record `fileId` — their `recordId` is the revision, plan,
     pack or impact, none of which is in the handover lineage above. Matching
     on either is what makes this tab the full account it claims to be; before
     this it showed the handover story and nothing after it. */
  const events = await MerchandisingAuditEvent
    .find({
      companyId: ctx.companyId,
      $or: [{ recordId: { $in: lineageIds } }, { fileId: file._id }],
    })
    .sort({ at: 1, _id: 1 }).limit(500).lean();
  const receiptByVersion = new Map(receipts.map((r) => [str(r.handoverVersionId), r]));

  return {
    events: events.map((e) => ({
      id: str(e._id),
      action: str(e.action),
      at: e.at,
      actorName: str(e.actor?.name),
      source: str(e.source),
      reason: str(e.reason),
      previousState: str(e.previousState),
      resultingState: str(e.resultingState),
      details: e.details && typeof e.details === "object"
        ? {
          versionNo: e.details.versionNo, fileNumber: str(e.details.fileNumber),
          assigneeName: str(e.details.assigneeName), change: str(e.details.change),
        }
        : null,
    })),
    sourceVersions: versions.map((v) => {
      const r = receiptByVersion.get(str(v._id));
      return {
        id: str(v._id),
        versionNo: v.versionNo,
        issuedAt: v.sourceRecord?.issuedAt || null,
        issuedByName: str(v.issuedBy?.name),
        publicationState: v.publication?.state || "CURRENT",
        receiptState: computeReceiptState(v, r),
        decidedByName: str(r?.decidedBy?.name),
        decidedAt: r?.decidedAt || null,
        clarification: r?.state === "CLARIFICATION_REQUESTED"
          ? { category: str(r.clarification?.category), reason: str(r.clarification?.reason) }
          : null,
      };
    }),
  };
}

/* ═══ THE OVERVIEW ═════════════════════════════════════════════════════════ */

/**
 * Every figure a count of records the register returns under the same rules —
 * the parity test drives both and asserts they agree.
 */
/**
 * Live changes nobody has assessed.
 *
 * Counted from the notice side: a change that arrived an hour ago and that
 * nobody has opened has NO impact record, so counting impacts in DRAFT would
 * report zero for precisely the state that needs attention. The list behind
 * this figure is the same query.
 */
async function countChangesAwaitingImpact(ctx) {
  const { SalesChangeNotice } = require("../../models/CMS_Models/Sales/SalesChangeNotice");
  const notices = await SalesChangeNotice.find({
    companyId: ctx.companyId, state: "ISSUED",
  }).select("changeRef versionNo").lean();
  if (!notices.length) return 0;

  const assessed = await ChangeImpact.find({
    companyId: ctx.companyId,
    changeRef: { $in: notices.map((n) => n.changeRef) },
    state: { $ne: "DRAFT" },
  }).select("changeRef changeVersionNo").lean();
  const done = new Set(assessed.map((i) => `${i.changeRef}:${i.changeVersionNo}`));
  return notices.filter((n) => !done.has(`${n.changeRef}:${n.versionNo}`)).length;
}

async function executionOverview(ctx) {
  assertContext(ctx);
  const generatedAt = new Date();
  const [
    newHandovers, activeFiles, onHoldFiles, closedFiles, deliveryAtRisk,
    awaitingPpcDecision, handedOverFiles,
    changesAwaitingImpact, acknowledgementsOutstanding,
  ] = await Promise.all([
    countPendingHandovers(ctx),
    ExecutionFile.countDocuments({ companyId: ctx.companyId, lifecycleStatus: "OPEN" }),
    ExecutionFile.countDocuments({ companyId: ctx.companyId, lifecycleStatus: "ON_HOLD" }),
    ExecutionFile.countDocuments({ companyId: ctx.companyId, lifecycleStatus: "CLOSED" }),
    /* ── M5 ────────────────────────────────────────────────────────────
       Milestones whose forecast has passed, or has moved beyond what was
       committed. The one figure on this page that is about TIME rather than
       about a queue, and the reason it belongs here: a merchandiser opening
       the application should learn that four dates are in trouble without
       having to go looking.

       Counted on the SAME indexed status field the register filters on, and
       it opens the same two views — a figure whose list you cannot open is a
       figure nobody can act on. A plan-less company simply counts zero. */
    TnaMilestone.countDocuments({
      companyId: ctx.companyId,
      status: { $in: ["OVERDUE", "FORECAST_LATE"] },
    }),
    /* ── M6 ────────────────────────────────────────────────────────────
       Packs sent downstream and not yet decided on. Counted from the PACK,
       which is the authoritative record, rather than from the file's mirrored
       field — a mirror that had drifted would produce a figure nobody could
       reconcile against the list behind it.

       `handedOverFiles` makes the register's fifth tab a real count for the
       first time. */
    ExecutionPack.countDocuments({ companyId: ctx.companyId, state: "SUBMITTED" }),
    ExecutionFile.countDocuments({ companyId: ctx.companyId, lifecycleStatus: "HANDED_OVER" }),
    /* ── M7 ────────────────────────────────────────────────────────────
       Changes that have arrived and nobody has assessed, and changes that
       were announced and are still waiting to be acknowledged.

       The first is counted from NOTICES with no impact rather than from
       impacts in DRAFT — a change nobody has touched has no impact record at
       all, and counting impacts would report zero for exactly the state that
       most needs attention. */
    countChangesAwaitingImpact(ctx),
    ChangeImpact.countDocuments({ companyId: ctx.companyId, state: "COORDINATED" }),
  ]);
  return {
    generatedAt,
    counts: {
      newHandovers, activeFiles, onHoldFiles, closedFiles, deliveryAtRisk,
      awaitingPpcDecision, handedOverFiles,
      changesAwaitingImpact, acknowledgementsOutstanding,
    },
  };
}

/* ═══ COMPANIES ════════════════════════════════════════════════════════════ */

/**
 * The actor's own memberships, with names — the smallest projection a company
 * selector needs, membership-bound so nobody browses the company master.
 *
 * The rule itself moved to `companyContext/companyMembership.service.js` when
 * Industrial Engineering needed the same answer: importing a Merchandising
 * service into IE would have been the wrong dependency, and a second copy would
 * have drifted. The shape returned here is unchanged.
 */
function listCompaniesFor(user) {
  return require("../companyContext/companyMembership.service").listMembershipCompanies(user);
}

module.exports = {
  DEFAULT_LIMIT, MAX_LIMIT, FILE_VIEWS, LIFECYCLE_COMMANDS,
  computeReceiptState, deriveUnits, handoverView, fileView,
  listHandovers, countPendingHandovers, getHandover,
  acceptHandover, requestClarification,
  listFiles, getFile, patchFile, assignFile, moveLifecycle,
  fileHistory, executionOverview, listCompaniesFor,
};
