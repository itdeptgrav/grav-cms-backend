// services/centralCosting/productionCloseout.service.js
//
// CLOSING A PRODUCTION RUN: WHAT WAS ACCEPTED, AND WHAT BECAME OF THE MATERIAL.
//
// ── THE AUDIT THAT DECIDED THIS DESIGN ──────────────────────────────────────
// Chunk 8B reported that no authoritative good output existed. That was right
// about the WORK ORDER's own aggregates and wrong one level down: `DefectRecord`
// is a real per-piece QC ledger — one row per barcode per checkpoint, with a
// three-way verdict where `rejected` is TERMINAL and enforced by the scan
// guard in `services/qcStages.js`.
//
// And `qcStages.buildPieceProgress` already turns those rows into the exact
// judgement this chunk needs: a piece is `complete` when it has cleared EVERY
// configured checkpoint and was never rejected anywhere. So no second QC
// workflow is built here. The pieces were always inspectable; what was missing
// was somebody saying "this run is finished, and here is what it came to".
//
// ── WHAT ACCEPTED GOOD OUTPUT MEANS, EXACTLY ────────────────────────────────
// A barcode whose `buildPieceProgress().complete` is true: every configured QC
// stage passed, no rejection at any stage or before stages existed.
//
// It is NOT the ordered quantity, the packaged quantity, the dispatched
// quantity, or `WorkOrder.qcCompletion.completedQuantity` — that last one is a
// project manager's manual mark, carried here as legacy evidence, labelled,
// and never promoted however convenient it would be.
//
// ── AND CLOSING MOVES NOTHING ───────────────────────────────────────────────
// No stock, no voucher, no payroll, no costing version. Surplus material is
// returned through the Store's own workflow; this record links to it.

"use strict";

const mongoose = require("mongoose");

const qcStages = require("../qcStages");
const { fail } = require("../storePurchase/errors");

const Closeout = () => require("../../models/CMS_Models/Manufacturing/Production/ProductionCostCloseout");
const WorkOrder = () => require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockIssuance = () => require("../../models/CMS_Models/Inventory/Operations/StockIssuance");
const DefectRecord = () => require("../../models/CMS_Models/Manufacturing/QC/DefectRecord");

const STATUS = Object.freeze({
  DRAFT: "DRAFT", READY: "READY_FOR_REVIEW", CLOSED: "CLOSED", SUPERSEDED: "SUPERSEDED",
});

/* How the accepted figure was arrived at. Stored on the record so a reader a
   year later does not have to trust that it meant what they assume. */
const EVIDENCE = Object.freeze({
  QC_PIECE_LEDGER: "Per-piece QC inspection ledger — every configured checkpoint cleared, never rejected",
  NO_STAGES: "No QC checkpoints are configured, so no piece can be proved accepted",
  NO_SCANS: "No production scans exist for this work order",
});

/* Readiness, in the words the screen shows. */
const READINESS = Object.freeze({
  NO_PRODUCTION: "Not ready — production evidence incomplete",
  NO_CLASSIFICATION: "Not ready — QC classification incomplete",
  MATERIAL_REMAINS: "Not ready — unused material remains",
  READY: "Ready to close",
  CLOSED: "Closed",
  CORRECTED: "Corrected by revision",
});

const STANDING =
  "Closing production records the evidence used for costing. It does not move "
  + "stock, post payroll or create an accounting voucher.";

const present = (v) => v !== null && v !== undefined && v !== ""
  && (typeof v !== "number" || Number.isFinite(v));
const idOf = (v) => (v === null || v === undefined ? null : String(v));
const num = (v) => (present(v) ? Number(v) : 0);
/* Quantities are compared at four decimal places so a fabric issue in metres
   reconciles without a float tail deciding whether a run may close. */
const q4 = (v) => Math.round(num(v) * 10000) / 10000;

/**
 * The accepted / rejected / open-rework split for one work order.
 *
 * ── DERIVED FROM THE PIECE LEDGER, NOT FROM A TALLY ─────────────────────────
 * Every barcode inspected against this work order is judged by
 * `buildPieceProgress`, which already encodes the rules that matter: a
 * rejection anywhere is terminal, a piece is only accepted once every
 * checkpoint is cleared, and the latest verdict at a checkpoint wins.
 *
 * Where no checkpoints are configured, `complete` can never be true — the
 * function says so itself — so this returns zero accepted with the reason,
 * rather than falling back to a count that would look like acceptance.
 */
async function classifyOutput({ workOrderId }) {
  const stages = await qcStages.listStages().catch(() => []);
  const rows = await DefectRecord().find({ workOrderId })
    .select("barcodeId stageId status inspectedAt")
    .limit(20000)
    .lean()
    .catch(() => []);

  const barcodes = [...new Set(rows.map((r) => r.barcodeId).filter(Boolean))];
  if (!barcodes.length) {
    return {
      acceptedGoodQty: 0, rejectedQty: 0, openReworkQty: 0,
      inspectedQty: 0, basis: EVIDENCE.NO_SCANS, stagesConfigured: stages.length > 0,
    };
  }

  const byBarcode = new Map(barcodes.map((b) => [b, []]));
  for (const r of rows) byBarcode.get(r.barcodeId)?.push(r);

  let accepted = 0; let rejected = 0; let rework = 0;
  for (const [, records] of byBarcode) {
    const p = qcStages.buildPieceProgress(records, stages);
    if (p.rejected) { rejected += 1; continue; }
    if (p.complete) { accepted += 1; continue; }
    if (p.openRework.length) { rework += 1; }
  }

  return {
    acceptedGoodQty: accepted,
    rejectedQty: rejected,
    openReworkQty: rework,
    inspectedQty: barcodes.length,
    basis: stages.length ? EVIDENCE.QC_PIECE_LEDGER : EVIDENCE.NO_STAGES,
    stagesConfigured: stages.length > 0,
  };
}

/**
 * What the Store records say was issued to and returned from this order.
 *
 * ── FROM MOVEMENTS, AND NEVER FROM `MRF.consumedQty` ────────────────────────
 * That field is `issuedQty − returnedQty` computed by the MRF routes; using it
 * as independent consumption evidence would be citing this same subtraction as
 * if it were a second, corroborating source.
 */
async function materialEvidence({ companyId, customerRequestId }) {
  if (!customerRequestId) return [];
  const issuances = await StockIssuance().find({
    companyId, manufacturingOrder: customerRequestId,
  })
    .select("_id direction items.rawItem items.variantId items.nativeQty items.nativeUnit "
      + "items.rawItemName items.rawItemSku items.variantCombination")
    .limit(1000)
    .lean()
    .catch(() => []);

  const byKey = new Map();
  for (const doc of issuances) {
    for (const line of doc.items || []) {
      if (!line.rawItem) continue;
      const key = `${line.rawItem}:${line.variantId || "none"}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          rawItemId: idOf(line.rawItem), variantId: idOf(line.variantId),
          itemName: line.rawItemName || "", sku: line.rawItemSku || "",
          variantLabel: (line.variantCombination || []).join(" / "),
          unit: line.nativeUnit || "", issuedQty: 0, returnedQty: 0,
          issuanceIds: [], unitConflict: false,
        });
      }
      const row = byKey.get(key);
      const u = line.nativeUnit || "";
      /* ── UNLIKE UNITS ARE NEVER ADDED ──────────────────────────────
         Two issues of one item in incompatible units is a data problem, and
         a sum across them is a quantity that means nothing. */
      if (row.unit && u && u.toLowerCase() !== row.unit.toLowerCase()) row.unitConflict = true;
      if (doc.direction === "credit") row.returnedQty += num(line.nativeQty);
      else row.issuedQty += num(line.nativeQty);
      row.issuanceIds.push(idOf(doc._id));
    }
  }

  return [...byKey.values()].map((r) => ({
    ...r,
    netIssuedQty: q4(r.issuedQty - r.returnedQty),
    issuedQty: q4(r.issuedQty),
    returnedQty: q4(r.returnedQty),
    issuanceIds: [...new Set(r.issuanceIds)],
  }));
}

/**
 * Everything a person needs to close this work order, re-read from source.
 *
 * This is what the screen loads and what `close` re-reads before freezing —
 * the same function, so a draft prepared an hour ago is checked against the
 * same authority it was prepared from.
 */
async function evidenceFor(ctx, { workOrderId }) {
  if (!mongoose.Types.ObjectId.isValid(String(workOrderId || ""))) {
    throw fail("VALIDATION", "That work order reference is not valid.");
  }
  const wo = await WorkOrder().findById(workOrderId)
    .select("workOrderNumber customerRequestId stockItemId variantId status quantity "
      + "productionCompletion.overallCompletedQuantity qcCompletion.completedQuantity")
    .lean();
  if (!wo) throw fail("NOT_FOUND", "That work order was not found.");

  const [output, materials] = await Promise.all([
    classifyOutput({ workOrderId: wo._id }),
    materialEvidence({ companyId: ctx.companyId, customerRequestId: wo.customerRequestId }),
  ]);

  const completedQty = num(wo.productionCompletion?.overallCompletedQuantity);
  const classified = output.acceptedGoodQty + output.rejectedQty + output.openReworkQty;

  return {
    workOrder: {
      id: idOf(wo._id), number: wo.workOrderNumber || "", status: wo.status || "",
      customerRequestId: idOf(wo.customerRequestId),
      stockItemId: idOf(wo.stockItemId), variantId: wo.variantId ?? null,
      plannedQty: num(wo.quantity),
      /* A cancelled run cannot be closed as successful production. */
      cancelled: String(wo.status || "").toLowerCase() === "cancelled",
    },
    output: {
      plannedQty: num(wo.quantity),
      completedQty,
      acceptedGoodQty: output.acceptedGoodQty,
      rejectedQty: output.rejectedQty,
      openReworkQty: output.openReworkQty,
      /* Completed pieces the QC ledger has not yet judged. Never folded into
         accepted — an unjudged piece is not a good one. */
      unclassifiedQty: Math.max(0, completedQty - classified),
      evidenceBasis: output.basis,
      stagesConfigured: output.stagesConfigured,
      /* Shown, labelled, never promoted. */
      legacyManualQcQty: present(wo.qcCompletion?.completedQuantity)
        ? num(wo.qcCompletion.completedQuantity) : null,
      legacyManualQcNote:
        "A project manager's manual mark, kept as historical evidence. It is not an inspection result.",
    },
    materials,
    standing: STANDING,
  };
}

/**
 * Does a proposed classification hold up?
 *
 * Two identities, both exact:
 *   accepted + rejected + openRework + unclassified === completed
 *   used + scrap + remaining                        === netIssued
 *
 * And a final close additionally needs `remaining === 0` and no open rework:
 * material still on the rack is not a finished run, and a piece still going
 * round is output nobody has classified yet.
 */
function validate({ evidence, output, materials, forClose }) {
  const problems = [];

  if (evidence.workOrder.cancelled) {
    problems.push({ code: "WORK_ORDER_CANCELLED", message: "A cancelled work order cannot be closed as successful production." });
  }

  const o = evidence.output;
  const classified = q4(num(output.acceptedGoodQty) + num(output.rejectedQty)
    + num(output.openReworkQty) + num(output.unclassifiedQty));
  if (classified !== q4(o.completedQty)) {
    problems.push({
      code: "OUTPUT_DOES_NOT_RECONCILE",
      message: `Accepted, rejected, rework and unclassified must add to the ${o.completedQty} pieces production completed. They add to ${classified}.`,
    });
  }
  /* Classifying more than was made is refused outright, not netted off. */
  if (q4(num(output.acceptedGoodQty) + num(output.rejectedQty) + num(output.openReworkQty)) > q4(o.completedQty)) {
    problems.push({
      code: "OVER_CLASSIFIED",
      message: "More pieces have been classified than production completed.",
    });
  }

  for (const line of materials || []) {
    const source = (evidence.materials || []).find(
      (m) => m.rawItemId === line.rawItemId && (m.variantId || null) === (line.variantId || null),
    );
    if (!source) {
      problems.push({ code: "MATERIAL_NOT_ISSUED", message: `${line.itemName || "A material"} was not issued to this order, so it cannot be reconciled here.` });
      continue;
    }
    if (source.unitConflict) {
      problems.push({ code: "MATERIAL_UNIT_CONFLICT", message: `${source.itemName || "A material"} was issued in more than one unit, so its quantities cannot be reconciled.` });
      continue;
    }
    const sum = q4(num(line.usedQty) + num(line.scrapQty) + num(line.remainingQty));
    if (sum !== q4(source.netIssuedQty)) {
      problems.push({
        code: "MATERIAL_DOES_NOT_RECONCILE",
        message: `${source.itemName || "A material"}: used, scrap and remaining must add to ${source.netIssuedQty} ${source.unit} net issued. They add to ${sum}.`,
      });
    }
  }

  if (forClose) {
    if (num(output.openReworkQty) > 0) {
      problems.push({ code: "OPEN_REWORK", message: "Pieces are still in rework, so this run is not finished." });
    }
    if (num(output.unclassifiedQty) > 0) {
      problems.push({ code: "UNCLASSIFIED_OUTPUT", message: "Some completed pieces have not been classified as accepted, rejected or rework." });
    }
    for (const line of materials || []) {
      if (num(line.remainingQty) > 0) {
        problems.push({
          code: "MATERIAL_REMAINS",
          message: `${line.itemName || "A material"} still has ${line.remainingQty} unused. Return it through the Store's return workflow, or classify it as used or scrap.`,
        });
      }
    }
    /* A closeout that could not judge a single piece has nothing to freeze. */
    if (!evidence.output.stagesConfigured) {
      problems.push({ code: "NO_QC_STAGES", message: "No QC checkpoints are configured, so no piece can be proved accepted." });
    }
  }

  return problems;
}

/** The one-line readiness the screen shows. */
function readinessOf({ evidence, closeout }) {
  if (closeout?.status === STATUS.SUPERSEDED) return READINESS.CORRECTED;
  if (closeout?.status === STATUS.CLOSED) return READINESS.CLOSED;
  if (!evidence.output.completedQty) return READINESS.NO_PRODUCTION;
  if (evidence.output.unclassifiedQty > 0 || evidence.output.openReworkQty > 0) return READINESS.NO_CLASSIFICATION;
  if ((closeout?.materials || []).some((m) => num(m.remainingQty) > 0)) return READINESS.MATERIAL_REMAINS;
  return READINESS.READY;
}

/** The live closeout for a work order, if there is one. */
async function liveFor(ctx, workOrderId) {
  return Closeout().findOne({
    companyId: ctx.companyId, workOrderId,
    status: { $in: [STATUS.DRAFT, STATUS.READY, STATUS.CLOSED] },
  }).lean();
}

/** Everything ever closed or drafted for this work order, newest first. */
async function historyFor(ctx, workOrderId) {
  return Closeout().find({ companyId: ctx.companyId, workOrderId })
    .sort({ revision: -1 })
    .limit(50)
    .lean();
}

/**
 * Save a draft.
 *
 * The classification is the person's; every FIGURE it is checked against is
 * re-read from source. A draft that no longer reconciles is refused with the
 * refreshed evidence attached, so the screen can show what moved.
 */
async function saveDraft(ctx, { workOrderId, output = {}, materials = [], actor = {} }) {
  const evidence = await evidenceFor(ctx, { workOrderId });
  const problems = validate({ evidence, output, materials, forClose: false });
  if (problems.length) {
    throw fail("VALIDATION", problems[0].message, { problems, evidence });
  }

  const existing = await liveFor(ctx, workOrderId);
  if (existing?.status === STATUS.CLOSED) {
    throw fail("CONFLICT", "This work order is already closed. Create a correction instead.", { closeoutId: idOf(existing._id) });
  }

  const doc = {
    companyId: ctx.companyId,
    workOrderId: evidence.workOrder.id,
    workOrderNumber: evidence.workOrder.number,
    customerRequestId: evidence.workOrder.customerRequestId,
    stockItemId: evidence.workOrder.stockItemId,
    variantId: evidence.workOrder.variantId,
    status: STATUS.DRAFT,
    output: {
      plannedQty: evidence.output.plannedQty,
      completedQty: evidence.output.completedQty,
      acceptedGoodQty: num(output.acceptedGoodQty),
      rejectedQty: num(output.rejectedQty),
      openReworkQty: num(output.openReworkQty),
      unclassifiedQty: num(output.unclassifiedQty),
      evidenceBasis: evidence.output.evidenceBasis,
      legacyManualQcQty: evidence.output.legacyManualQcQty,
    },
    /* Server-derived quantities, the person's classification. */
    materials: (materials || []).map((line) => {
      const src = evidence.materials.find(
        (m) => m.rawItemId === line.rawItemId && (m.variantId || null) === (line.variantId || null),
      );
      return {
        rawItemId: src.rawItemId, variantId: src.variantId,
        itemName: src.itemName, sku: src.sku, variantLabel: src.variantLabel, unit: src.unit,
        issuedQty: src.issuedQty, returnedQty: src.returnedQty, netIssuedQty: src.netIssuedQty,
        usedQty: num(line.usedQty), scrapQty: num(line.scrapQty), remainingQty: num(line.remainingQty),
        issuanceIds: src.issuanceIds,
        note: String(line.note || "").slice(0, 500),
      };
    }),
    preparedByActorId: String(actor.id || ""),
    preparedByName: String(actor.name || ""),
  };

  if (existing) {
    await Closeout().updateOne({ _id: existing._id }, { $set: doc });
    return { closeout: await Closeout().findById(existing._id).lean(), evidence, created: false };
  }
  const created = await Closeout().create(doc);
  return { closeout: created.toObject(), evidence, created: true };
}

/**
 * Close it.
 *
 * ── EVERY FIGURE IS RE-READ FIRST ───────────────────────────────────────────
 * Between preparing a draft and closing it, pieces get inspected and material
 * gets returned. Freezing the draft's copy would freeze what was true an hour
 * ago under a label that says "the evidence used". So the source is read
 * again, and a draft that no longer matches is refused with the refreshed
 * evidence rather than quietly adjusted.
 */
async function close(ctx, { workOrderId, reason = "", actor = {}, idempotencyKey = "" }) {
  const existing = await liveFor(ctx, workOrderId);
  if (existing?.status === STATUS.CLOSED) {
    /* An identical retry resolves to the same closeout rather than a second
       one — the same answer the unique index would force anyway. */
    if (idempotencyKey && existing.idempotencyKey === String(idempotencyKey)) {
      return { closeout: existing, mode: "RECOVERED" };
    }
    throw fail("CONFLICT", "This work order is already closed. Create a correction instead.", { closeoutId: idOf(existing._id) });
  }
  if (!existing) throw fail("NOT_FOUND", "There is no prepared closeout for this work order.");

  const evidence = await evidenceFor(ctx, { workOrderId });
  const problems = validate({
    evidence, output: existing.output, materials: existing.materials, forClose: true,
  });
  if (problems.length) {
    throw fail("VALIDATION", problems[0].message, { problems, evidence });
  }
  /* ── AND THE SOURCE MUST NOT HAVE MOVED ──────────────────────────────
     A changed completed count or a new return means the draft describes a
     run that no longer exists. */
  if (q4(existing.output.completedQty) !== q4(evidence.output.completedQty)) {
    throw fail("CONFLICT",
      "Production has moved since this closeout was prepared. Review the refreshed evidence and save again.",
      { problems: [{ code: "EVIDENCE_CHANGED" }], evidence });
  }
  for (const line of existing.materials || []) {
    const src = evidence.materials.find(
      (m) => m.rawItemId === String(line.rawItemId) && (m.variantId || null) === (idOf(line.variantId) || null),
    );
    if (!src || q4(src.netIssuedQty) !== q4(line.netIssuedQty)) {
      throw fail("CONFLICT",
        "Material issues or returns have changed since this closeout was prepared. Review the refreshed evidence and save again.",
        { problems: [{ code: "EVIDENCE_CHANGED" }], evidence });
    }
  }

  await Closeout().updateOne({ _id: existing._id }, {
    $set: {
      status: STATUS.CLOSED,
      closedByActorId: String(actor.id || ""),
      closedByName: String(actor.name || ""),
      closedAt: new Date(),
      reason: String(reason || "").slice(0, 1000),
      idempotencyKey: String(idempotencyKey || ""),
    },
  });
  return { closeout: await Closeout().findById(existing._id).lean(), mode: "CLOSED" };
}

/**
 * Correct a closed run.
 *
 * ── A NEW REVISION, NEVER AN EDIT ───────────────────────────────────────────
 * The closed one is marked SUPERSEDED and keeps every figure it was closed
 * with. What was reported in March still reads as it did in March; the
 * correction says what changed and why, and takes over as the live revision.
 */
async function correct(ctx, { workOrderId, reason = "", actor = {} }) {
  if (!String(reason || "").trim()) {
    throw fail("VALIDATION", "Say why this closed production result is being corrected.");
  }
  const existing = await liveFor(ctx, workOrderId);
  if (!existing || existing.status !== STATUS.CLOSED) {
    throw fail("CONFLICT", "There is no closed production result to correct.");
  }

  const evidence = await evidenceFor(ctx, { workOrderId });
  /* Superseded first, so the unique live index is free for the new one. */
  await Closeout().updateOne({ _id: existing._id }, { $set: { status: STATUS.SUPERSEDED } });
  const next = await Closeout().create({
    ...existing,
    _id: undefined,
    status: STATUS.DRAFT,
    revision: num(existing.revision) + 1,
    supersedes: existing._id,
    supersededBy: null,
    closedByActorId: "", closedByName: "", closedAt: null,
    idempotencyKey: "",
    reason: String(reason).slice(0, 1000),
    preparedByActorId: String(actor.id || ""),
    preparedByName: String(actor.name || ""),
    /* Re-read, because a correction that carried the old figures forward
       would correct nothing. */
    output: { ...existing.output, completedQty: evidence.output.completedQty },
  });
  await Closeout().updateOne({ _id: existing._id }, { $set: { supersededBy: next._id } });
  return { closeout: next.toObject(), superseded: idOf(existing._id) };
}

module.exports = {
  liveFor, historyFor, saveDraft, close, correct,
  STATUS, EVIDENCE, READINESS, STANDING,
  classifyOutput, materialEvidence, evidenceFor, validate, readinessOf,
  Closeout, WorkOrder, StockIssuance, DefectRecord,
  present, idOf, num, q4,
};
