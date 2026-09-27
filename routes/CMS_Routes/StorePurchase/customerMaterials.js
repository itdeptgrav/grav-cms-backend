// routes/CMS_Routes/StorePurchase/customerMaterials.js
//
// CUSTOMER-SUPPLIED MATERIAL — STORE'S SIDE, AND IT IS A READ.
//
// On a job-work order the customer sends the fabric and the trims. Store needs
// to know what is coming and against which order, so that when a lorry arrives
// somebody can say whether it contains what was expected.
//
// ── STORE READS THE DOCUMENT AND RECORDS THE ARRIVAL ────────────────────────
// Store does not COMPOSE these documents. Merchandising states what the customer
// has undertaken to send, on Merchandising's own router, under Merchandising's
// own grants — because it is Merchandising who has the buyer relationship and
// the order in front of them.
//
// What Store does is receive. That is the act this router gained: a goods receipt
// against an issued expectation, which moves the physical balance, moves the
// warehouse location, and creates the OWNERSHIP LOT that says whose goods these
// are and which order line they were sent for.
//
// ── TWO GRANTS, NOT ONE ─────────────────────────────────────────────────────
// `sp.read` opens the register and the detail. `sp.receipt.record` — the same
// grant a purchase receipt needs — is required to record an arrival or to short
// close a line. Reading what is expected and signing for what turned up are
// different acts with different consequences, and somebody who can do the first
// is not thereby entitled to the second.
//
// ── AND IT IS THE SAME RECEIPT ENGINE ───────────────────────────────────────
// No receipt arithmetic lives here. Line validation, unit conversion,
// over-receipt refusal, the RawItem movement, the location movement and the
// numbered GoodsReceipt all come from the shared implementation a purchase
// receipt uses. What this router adds is the customer-material source and the
// ownership lots — the parts a purchase receipt has no need of.
//
// ── WHAT A DRAFT LOOKS LIKE FROM HERE ───────────────────────────────────────
// Like nothing. A draft is a document somebody is still composing, and Store
// planning around one is how a department acts on a decision nobody took. It is
// not hidden behind a permission message either: "you may not see it" would
// tell Store that one is being written, which is a fact about somebody else's
// unfinished work.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const {
  requireTenant, requireCapability, refuseLegacyWrite, withIdempotency,
} = require("../../../Middlewear/storePurchaseTenant");
const { CAPABILITIES } = require("../../../services/storePurchase/capabilities");
const { handle, fail, sendError } = require("../../../services/storePurchase/errors");
const customerMaterial = require("../../../services/merchandising/customerMaterial.service");
const receipts = require("../../../services/storePurchase/customerMaterialReceipt.service");
const movements = require("../../../services/storePurchase/customerMaterialIssue.service");
const labels = require("../../../services/storePurchase/customerMaterialLabel.service");
const unitOfWork = require("../../../services/storePurchase/unitOfWork.service");
const GoodsReceipt = require("../../../models/CMS_Models/StorePurchase/GoodsReceipt");
const { CustomerMaterialLot } = require("../../../models/CMS_Models/StorePurchase/CustomerMaterialLot");

const ENTITY = "CUSTOMER_MATERIAL_RECEIPT";
const ENTITY_ISSUE = "CUSTOMER_MATERIAL_ISSUE";
const ENTITY_RETURN = "CUSTOMER_MATERIAL_RETURN";
const ENTITY_LABEL = "CUSTOMER_MATERIAL_LABEL";

const router = express.Router();
router.use(EmployeeAuthMiddleware);
/* Tenant-resolved, so a caller whose company cannot be proved is refused here
   rather than handed another company's expectations. */
router.use(requireTenant);

/* `sp.read` — the ordinary Store read grant. Not `sp.master.maintain` and not
   `sp.receipt.record`: nothing here maintains anything and nothing here records
   a receipt, so requiring either would overstate what this door does. */
const canRead = requireCapability(CAPABILITIES.READ);
/* The SAME grant a purchase receipt needs. Signing for goods that arrived is one
   act whichever document brought them, so it is one permission — a separate
   "customer receipts" grant would be a second thing to forget to revoke. */
const canReceive = [requireCapability(CAPABILITIES.RECEIPT_RECORD), refuseLegacyWrite];
/* ── THREE PHYSICAL ACTS, THREE EXISTING GRANTS ──────────────────────────────
   Receiving, issuing and returning are three different things somebody does with
   stock, and the ladder already has a word for each. No new capability is
   invented: a `customerMaterial.*` family would be a second place to grant the
   same authority and a second place to forget to revoke it.

   `sp.stock.issue` is the grant that hands material to production — the same one
   an ordinary issue needs, because it is the same act on goods that happen to
   belong to somebody else. `sp.stock.return` sends held material back out of the
   building. Both sit with the Store editor, which is where the ladder already
   puts them. */
const canIssue = [requireCapability(CAPABILITIES.STOCK_ISSUE), refuseLegacyWrite];
const canReturn = [requireCapability(CAPABILITIES.STOCK_RETURN), refuseLegacyWrite];

/* The Merchandising service reads by company, and the tenant context is where
   this router's company comes from. `legacyMode` is deliberately not carried:
   these documents are new, so none of them predates company ownership and a
   legacy scope would select nothing while looking like it might. */
const ctx = (req) => ({ companyId: req.tenant?.companyId });

const str = (v) => String(v ?? "").trim();
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

/**
 * What the caller asked to move, as {lotId, quantity} — used by recovery to
 * prove that the operation posted ALL of it, not merely something.
 */
function expectedRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => ({ lotId: str(r?.lotId), quantity: r4(r?.quantity) }))
    .filter((r) => r.lotId && r.quantity > 0);
}

/** Total planned quantity, for the recovery receipt's bounded facts. */
function totalPlanned(plans) {
  return r4((plans || []).reduce((sum, p) => sum + r4(p.quantity), 0));
}

/**
 * Facts, dropped when empty.
 *
 * `buildRecoveryReceipt` rejects a fact with no value, and an absent work order
 * or customer reference is normal rather than an error, so blanks are omitted
 * instead of being sent as "".
 */
function receiptFacts(pairs) {
  const facts = pairs
    .filter(([, v]) => (typeof v === "number" ? Number.isFinite(v) : str(v) !== ""))
    .map(([key, v]) => (typeof v === "number" ? { key, num: v } : { key, value: str(v) }));
  return facts.length ? facts : undefined;
}

/**
 * ANSWER A RECOVERY BY NAMING THE OPERATION.
 *
 * ── WHAT THIS REPLACED, AND WHY IT MATTERED ─────────────────────────────────
 * Both operations used to recover by asking an existence question of the whole
 * collection — "is there a customer-owned issuance?", "does any lot carry a
 * return movement?" — which an unrelated operation from any previous day
 * answers yes to. The operator was then told their interrupted work had been
 * recorded, and a real gap in the stock ledger was closed with a false success.
 *
 * It now looks for the operation itself: this company, this operation type, this
 * exact key. It then proves COMPLETENESS against the lots and quantities the
 * request named. Three outcomes, all of them specific:
 *
 *   found and complete    → the original result, with the canonical record
 *   found but partial     → reconciliation, naming every lot and quantity
 *   not found at all      → reconciliation, saying plainly that nothing posted
 *
 * The audit row written for a recovery carries the same identity: the operation
 * key, the operation type, the document, the lots, the quantities and — for a
 * return — the effective date, taken from the record rather than from now.
 */
async function answerRecovery(req, res, {
  entityType, operationType, action, resultingState, context, expected,
  incompleteMessage, incompleteReason, describe,
}) {
  const found = await movements.findPostedOperation(context, {
    operationType, idempotencyKey: req.idempotent.key, expected,
  });
  const record = found.record;
  const posted = found.posted || [];

  await unitOfWork.recover(req.tenant, {
    entityType, entityId: req.params.docId, idempotencyKey: req.idempotent.key,
    entry: {
      documentNumber: str(record?.documentRef) || str(record?.moNumber),
      action: found.complete ? action : `${operationType}_RECONCILIATION_REQUIRED`,
      resultingState: found.complete ? resultingState : "",
      requestId: req.id || "",
      idempotencyKey: req.idempotent.key,
      /* The effective date of the original operation where it has one, so a
         repair does not backdate or forward-date the event. */
      ...(record?.effectiveAt ? { at: record.effectiveAt } : {}),
      reason: found.complete
        ? ""
        : (found.found
          ? "The record exists but does not account for every lot and quantity requested."
          : "The effect was marked but no record for this operation key was written."),
      metadata: {
        recovered: true,
        operationType,
        operationKey: req.idempotent.key,
        documentRef: str(record?.documentRef),
        recordId: record?._id ? String(record._id) : "",
        expectedLots: expected.length,
        postedLots: posted.length,
        complete: found.complete,
        ...(record?.effectiveAt
          ? { effectiveAt: new Date(record.effectiveAt).toISOString() }
          : {}),
      },
    },
  });

  if (!found.complete) {
    throw fail("LIFECYCLE_BLOCKED", incompleteMessage, {
      reason: incompleteReason,
      operationType,
      operationKey: req.idempotent.key,
      documentRef: str(record?.documentRef),
      recordId: record?._id ? String(record._id) : "",
      recordFound: found.found,
      /* Exactly which lots and quantities were asked for, and exactly what the
         record accounts for. This is the difference between an instruction
         somebody can act on and a warning they cannot. */
      requested: expected,
      posted,
      missing: expected.filter(
        (e) => !posted.some((pp) => pp.lotId === e.lotId && r4(pp.quantity) === r4(e.quantity)),
      ),
      ...(record?.effectiveAt ? { effectiveAt: record.effectiveAt } : {}),
    });
  }

  return await req.idempotent.succeed(200, {
    success: true,
    message: `This ${operationType === "ISSUE" ? "issue" : "return"} was already recorded.`,
    documentRef: str(record?.documentRef),
    ...(describe ? describe(record) : {}),
  }, { entityType, entityId: req.params.docId });
}

/**
 * THE REGISTER — issued and cancelled documents, newest issued first.
 *
 * Cancelled ones are included because a withdrawal is exactly the thing Store
 * needs to see: a delivery it was expecting is not coming. `state` narrows to
 * one or the other; a request for drafts is refused rather than silently
 * returning none, so a client asking the wrong question is told.
 */
router.get("/", canRead, handle(async (req, res) => {
  const out = await customerMaterial.register(ctx(req), {
    q: req.query.q, state: req.query.state,
    page: req.query.page, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

/** ONE DOCUMENT. A draft answers as one that does not exist — see the header. */
router.get("/:docId", canRead, handle(async (req, res) => {
  const out = await customerMaterial.storeDetail(ctx(req), { docId: req.params.docId });
  return res.json({ success: true, ...out });
}));

/**
 * THE OWNERSHIP LOTS this document's receipts created.
 *
 * Read-only, and read separately from the document because they answer a
 * different question: not "what is expected" but "what are we actually holding,
 * and whose is it". A stock-take reconciles against these.
 */
router.get("/:docId/lots", canRead, handle(async (req, res) => {
  const { expectation } = await customerMaterial.storeDetail(ctx(req), { docId: req.params.docId });
  const lots = await CustomerMaterialLot.find({
    companyId: req.tenant.companyId, documentRef: expectation.documentRef,
  }).sort({ receivedAt: -1 }).lean();

  return res.json({
    success: true,
    documentRef: expectation.documentRef,
    lots: lots.map((l) => ({
      id: String(l._id),
      customer: { id: String(l.customerId), label: l.customerLabel, code: l.customerCode },
      orderRef: l.orderRef,
      orderLineRef: l.orderLineRef,
      expectationLineRef: l.expectationLineRef,
      againstRevisionNo: l.expectationRevisionNo,
      material: { rawItemId: String(l.rawItemId), name: l.itemName, sku: l.sku, variantId: l.variantId ? String(l.variantId) : null },
      receipt: { id: String(l.goodsReceiptId), number: l.goodsReceiptNumber, at: l.receivedAt },
      where: { warehouseName: l.warehouseName, locationCode: l.locationCode },
      received: { quantity: l.receiptQuantity, unit: l.receiptUnit },
      base: { quantity: l.baseQuantity, unit: l.baseUnit },
      availableQuantity: l.availableQuantity,
      issuedQuantity: l.issuedQuantity,
      returnedQuantity: l.returnedQuantity,
      status: l.status,
    })),
  });
}));

/**
 * WHERE THIS DOCUMENT'S MATERIAL MAY GO.
 *
 * The production order, and the work orders that can be PROVED to be making its
 * sales line. Derived on the server from the same stored references the issue is
 * checked against, so the issue screen can only offer destinations that will be
 * accepted — and can say why there are none rather than offering a plausible
 * wrong one.
 */
router.get("/:docId/production-targets", canRead, handle(async (req, res) => {
  const out = await movements.productionTargets(ctx(req), { expectationId: req.params.docId });
  return res.json({ success: true, ...out });
}));

/* ═══ RECORDING WHAT ARRIVED ═══════════════════════════════════════════════ */

/**
 * RECORD A RECEIPT against an issued expectation.
 *
 * Multi-line and partial by design: a lorry rarely brings a whole document, and
 * forcing a receipt to be complete would mean either waiting or lying.
 *
 * ── ONE TRANSACTION, OR NOTHING ──────────────────────────────────────────────
 * The idempotency claim, the GRN, its lines, the RawItem movement, the variant
 * movement, the warehouse/location movement, the ownership lots and the action
 * history all commit together. A lot without its receipt would be stock nobody
 * can trace; a receipt without its lot would be a customer's goods on our shelf
 * owned by nobody. Neither is a state worth being able to reach.
 *
 * ── AND A REPLAY RETURNS THE FIRST RECEIPT ───────────────────────────────────
 * Not a second one, and not a conflict. A dropped connection on a receipt is
 * common, and the honest answer to "did that land?" is the receipt it landed as.
 */
router.post("/:docId/receipts", ...canReceive,
  withIdempotency("CUSTOMER_MATERIAL_RECEIVE", { target: (req) => req.params.docId }),
  async (req, res) => {
    try {
      const context = ctx(req);

      /* ── REPLAY: THE SAME GRN, NEVER A SECOND MOVEMENT ────────────────── */
      if (req.idempotent?.recovering) {
        const existing = await GoodsReceipt.findOne({
          companyId: req.tenant.companyId,
          sourceType: "CUSTOMER_MATERIAL",
          idempotencyKey: req.idempotent.key,
        });
        await unitOfWork.recover(req.tenant, {
          entityType: ENTITY, entityId: req.params.docId, idempotencyKey: req.idempotent.key,
          entry: {
            documentNumber: existing?.sourceDocumentNumber || "",
            action: existing ? "RECEIVED" : "RECEIPT_RECONCILIATION_REQUIRED",
            resultingState: "RECORDED", requestId: req.id || "",
            idempotencyKey: req.idempotent.key,
            reason: existing ? "" : "Stock effect marked but no goods receipt was written.",
            metadata: { recovered: true, goodsReceiptNumber: existing?.receiptNumber || null },
          },
        });
        if (!existing) {
          /* The one outcome worse than a failed receipt: a marked effect with no
             document. Say so plainly and refuse to record it again — a second
             receipt would double a customer's stock. */
          throw fail("LIFECYCLE_BLOCKED",
            "This receipt was interrupted after the stock effect was marked but before the goods "
            + "receipt was written. Check the material's stock and reconcile — do not record it again.",
            { reason: "PARTIAL_RECEIPT_NEEDS_RECONCILIATION" });
        }
        return await req.idempotent.succeed(200, {
          success: true, message: "This receipt was already recorded.", goodsReceipt: existing,
        }, { entityType: ENTITY, entityId: req.params.docId });
      }

      /* ── EVERYTHING VALIDATED BEFORE ANY WRITE ────────────────────────── */
      const doc = await receipts.receivableExpectation(context, { expectationId: req.params.docId });
      const { warehouse, location } = await receipts.resolveDestination(context, {
        warehouseId: req.body?.warehouseId, locationId: req.body?.locationId,
      });
      const { plans } = await receipts.validateReceiptLines(context, {
        doc, items: req.body?.items,
      });

      /* ── THE MARKER IS THE TRANSACTION'S, NOT THE ROUTE'S ───────────────
         This used to mark the effect here, before `run()`. Everything above is
         validation, so the common case was already safe — but the marker was
         written OUTSIDE the transaction, so a receipt that rolled back left one
         behind, and the retry was refused as a partially applied operation that
         had in fact applied nothing. `unitOfWork.run` writes the marker inside
         the same transaction as the receipt, from the validated receipt below. */
      let created = null;
      let lotCount = 0;
      await unitOfWork.run(req.tenant, {
        idempotencyRecord: req.idempotent?.record,
        /* The entity is named by `mutate`'s return below, which is where this
           route's document is resolved. */
        recoveryReceipt: {
          action: "RECEIVED",
          entityType: ENTITY, entityId: doc._id,
          documentNumber: str(doc.documentRef),
          occurredAt: new Date(),
          previousState: "ISSUED", resultingState: "RECORDED",
          subjectType: "warehouse_location",
          subjectId: location._id,
          subjectCode: str(location.code),
          facts: receiptFacts([
            ["operationType", "RECEIPT"],
            ["operationKey", str(req.idempotent?.key)],
            ["customerReference", str(req.body?.customerReference)],
            ["lineCount", plans.length],
            ["againstRevisionNo", Number(doc.revisionNo)],
          ]),
        },
        mutate: async (session) => {
          const out = await receipts.applyReceipt({
            session, tenant: req.tenant, ctx: context, doc, plans,
            header: {
              warehouse,
              location,
              receiptDate: req.body?.receiptDate,
              notes: req.body?.notes,
              /* The CUSTOMER's challan. Not an invoice — the factory bought
                 nothing and the GoodsReceipt validator refuses an invoice
                 number on this source type. */
              customerReference: req.body?.customerReference,
            },
            actor: { id: req.user.id, name: req.user.name },
            idempotencyKey: req.idempotent?.key || "",
          });
          created = out.goodsReceipt;
          lotCount = (out.lots || []).length;
          return {
            entityType: ENTITY, entityId: doc._id, result: true,
            entry: {
              entityType: ENTITY, entityId: doc._id,
              documentNumber: String(doc.documentRef),
              action: "RECEIVED", previousState: "ISSUED", resultingState: "RECORDED",
              requestId: req.id || "", idempotencyKey: req.idempotent?.key || "",
              metadata: {
                goodsReceiptNumber: created.receiptNumber,
                lineCount: plans.length,
                lotCount,
                againstRevisionNo: doc.revisionNo,
                customerReference: String(req.body?.customerReference || ""),
              },
            },
          };
        },
      });

      /* The updated standing comes back with the receipt, so the screen does not
         have to ask a second time and cannot show a stale figure beside a fresh
         receipt. */
      const fresh = await receipts.receivableExpectation(context, { expectationId: req.params.docId })
        .catch(() => doc);
      const standing = await receipts.standingFor(context, fresh);

      const body = {
        success: true,
        message: `Goods receipt ${created.receiptNumber} recorded.`,
        goodsReceipt: created,
        lotCount,
        standing,
      };
      return req.idempotent
        ? await req.idempotent.succeed(201, body, { entityType: ENTITY, entityId: doc._id })
        : res.status(201).json(body);
    } catch (err) {
      if (err?.name === "StorePurchaseError") return sendError(res, err);
      console.error("[customer-material-receipt] error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

/* ═══ SHORT CLOSURE ════════════════════════════════════════════════════════ */

/**
 * SHORT CLOSE a line — "no more of this is coming".
 *
 * Store's decision and Store's authority, because Store is the department that
 * knows the lorry has stopped arriving.
 *
 * ── IT MANUFACTURES NOTHING ──────────────────────────────────────────────────
 * It does not change the received quantity, does not create stock, and does not
 * pretend the missing quantity arrived. What it does is stop the line expecting
 * more, so the outstanding figure stops being chased — and it records who
 * decided that and why, because a quantity that never arrived is a conversation
 * with a customer and somebody will have to have it.
 */
router.post("/:docId/lines/:lineRef/short-close", ...canReceive, handle(async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) {
    throw fail("VALIDATION",
      "Say why no more is expected. Somebody will have to raise the shortfall with the customer.",
      { field: "reason" });
  }
  const out = await customerMaterial.shortCloseLine(ctx(req), {
    docId: req.params.docId, lineRef: req.params.lineRef, reason,
    actor: { id: req.user.id, name: req.user.name, email: req.user.email || "" },
  });
  return res.json({ success: true, ...out });
}));

/**
 * REOPEN a short-closed line — the customer is sending more after all.
 *
 * Explicit and audited, which is the whole reason a receipt cannot do it
 * implicitly: somebody decided nothing more was coming, and reversing that is a
 * second decision rather than a side effect of a delivery turning up.
 */
router.post("/:docId/lines/:lineRef/reopen", ...canReceive, handle(async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) {
    throw fail("VALIDATION", "Say why it is expected again.", { field: "reason" });
  }
  const out = await customerMaterial.reopenLine(ctx(req), {
    docId: req.params.docId, lineRef: req.params.lineRef, reason,
    actor: { id: req.user.id, name: req.user.name, email: req.user.email || "" },
  });
  return res.json({ success: true, ...out });
}));

/* ═══ ISSUING TO PRODUCTION ════════════════════════════════════════════════ */

/**
 * Hand customer material to a production order.
 *
 * ── EVERY IDENTITY IS RESOLVED ON THE SERVER ─────────────────────────────────
 * The caller supplies the lots, the quantities and the destination order. The
 * customer, the sales order, the permanent order line, the execution file, the
 * material, the variant, the document and the location are all READ from the lot
 * — and where the caller also sent them, a disagreement is refused rather than
 * ignored, because ignoring it returns a success for an operation nobody asked
 * for.
 *
 * ── AND THERE IS NO AUTOMATIC SUBSTITUTION ───────────────────────────────────
 * If a lot is short, the shortfall is reported with the quantity actually held.
 * The caller may then name another lot explicitly. Nothing here reaches for a
 * different lot on its own, not even one of the same material for the same order
 * line — a substitution nobody chose is discovered when the garment is wrong.
 */
router.post("/:docId/issues", ...canIssue,
  withIdempotency("CUSTOMER_MATERIAL_ISSUE", { target: (req) => req.params.docId }),
  async (req, res) => {
    try {
      const context = ctx(req);
      const expected = expectedRows(req.body?.lots);

      /* ── RECOVERY ANSWERS ABOUT THIS OPERATION, NOT ABOUT THE COLLECTION ──
         Named by company, operation type and this exact key, and only reported
         as done when every lot and quantity the caller asked for is present in
         the canonical record. */
      if (req.idempotent?.recovering) {
        return await answerRecovery(req, res, {
          entityType: ENTITY_ISSUE, operationType: "ISSUE",
          action: "STOCK_ISSUED", resultingState: "ISSUED",
          context, expected,
          incompleteMessage:
            "This issue was interrupted: the effect was marked but the issue record it should "
            + "have written is missing or incomplete. Check the lots named below and reconcile — "
            + "do not issue them again.",
          incompleteReason: "PARTIAL_ISSUE_NEEDS_RECONCILIATION",
          describe: (record) => ({ issuance: record }),
        });
      }

      /* ── PLANNING FIRST, AND IT WRITES NOTHING ────────────────────────────
         The document in the URL, the lots, the production target, the
         quantities and the locations are all resolved and checked here. A
         request refused at this point has left no trace, so the operator may
         correct the form and retry with the same key — which is what they will
         do, and which used to route them into reconciliation for an operation
         that had never happened. */
      const plan = await movements.planIssue(context, {
        docId: req.params.docId,
        rows: req.body?.lots,
        manufacturingOrderId: req.body?.manufacturingOrderId,
        workOrderId: req.body?.workOrderId,
        /* What the caller believed. Compared, never trusted. */
        claimed: req.body?.claimed || {},
      });

      const docId = plan.doc._id;
      const occurredAt = new Date();

      let out = null;
      await unitOfWork.run(req.tenant, {
        idempotencyRecord: req.idempotent?.record,
        /* ── NAMED UP FRONT, FOR THE NO-TRANSACTION CASE ────────────────────
           With transactions the unit of work marks the effect INSIDE the
           transaction, so a rollback takes the marker with it. Without them
           (a standalone mongod) it marks before the mutation when — and only
           when — the caller names the entity here. Both operations write to
           several collections, so a half-completed one must route the retry into
           reconciliation rather than repeat the part that landed. */
        entityType: ENTITY_ISSUE, entityId: docId,
        /* Built from the PLAN, validated before the mutation, and written by the
           unit of work inside the same transaction as the mutation itself. */
        recoveryReceipt: {
          action: "STOCK_ISSUED",
          entityType: ENTITY_ISSUE, entityId: docId,
          documentNumber: str(plan.doc.documentRef),
          occurredAt,
          previousState: "HELD", resultingState: "ISSUED",
          subjectType: "manufacturing_order",
          subjectId: plan.target.order.id,
          subjectCode: str(plan.target.order.number),
          facts: receiptFacts([
            ["operationType", "ISSUE"],
            ["operationKey", str(req.idempotent?.key)],
            ["workOrder", str(plan.target.workOrder?.number)],
            ["lotCount", plan.plans.length],
            ["quantity", totalPlanned(plan.plans)],
          ]),
        },
        mutate: async (session) => {
          out = await movements.postIssue(context, {
            tenant: req.tenant, session,
            doc: plan.doc, target: plan.target, plans: plan.plans,
            note: req.body?.note,
            actor: { id: req.user.id, name: req.user.name },
            idempotencyKey: req.idempotent?.key || "",
          });
          return {
            entityType: ENTITY_ISSUE, entityId: docId, result: true,
            entry: {
              entityType: ENTITY_ISSUE, entityId: docId,
              documentNumber: out.documentRef,
              action: "STOCK_ISSUED", previousState: "HELD", resultingState: "ISSUED",
              requestId: req.id || "", idempotencyKey: req.idempotent?.key || "",
              metadata: {
                manufacturingOrder: out.target.order.number,
                workOrder: out.target.workOrder?.number || "",
                lotCount: out.lots.length,
                ownership: "CUSTOMER_OWNED",
                /* The same document the URL addressed, the lots belong to and
                   the movements name. One identity, said once. */
                documentRef: out.documentRef,
              },
            },
          };
        },
      });

      const doc = await receipts.receivableExpectation(context, { expectationId: docId })
        .catch(() => null);
      const standing = doc ? await receipts.standingFor(context, doc) : null;
      const body = {
        success: true,
        message: `Issued to ${out.target.order.number}`
          + `${out.target.workOrder ? ` / ${out.target.workOrder.number}` : ""}.`,
        documentRef: out.documentRef,
        issuance: out.issuance,
        standing,
      };
      return req.idempotent
        ? await req.idempotent.succeed(201, body, { entityType: ENTITY_ISSUE, entityId: docId })
        : res.status(201).json(body);
    } catch (err) {
      if (err?.name === "StorePurchaseError") return sendError(res, err);
      console.error("[customer-material-issue] error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

/* ═══ RETURNING IT TO THE CUSTOMER ═════════════════════════════════════════ */

/**
 * Unused material leaves the factory and goes back to its owner.
 *
 * Not a supplier return: nothing was bought, so there is no purchase order to
 * credit and nothing payable to reverse. Only from quantity still HELD —
 * material already with production is on a cutting table and is not Store's to
 * give back.
 */
router.post("/:docId/customer-returns", ...canReturn,
  withIdempotency("CUSTOMER_MATERIAL_RETURN", { target: (req) => req.params.docId }),
  async (req, res) => {
    try {
      const context = ctx(req);
      const expected = expectedRows(req.body?.lots);

      /* ── RECOVERY NAMES THE OPERATION ─────────────────────────────────────
         This used to ask whether ANY lot in the company carried ANY
         RETURNED_TO_CUSTOMER movement. An unrelated return from last month
         answered yes, so a failed return reported success and the operator was
         told their work had landed when nothing had moved. A return now writes a
         canonical record of its own, keyed by this operation. */
      if (req.idempotent?.recovering) {
        return await answerRecovery(req, res, {
          entityType: ENTITY_RETURN, operationType: "RETURN_TO_CUSTOMER",
          action: "STOCK_RETURNED_TO_CUSTOMER", resultingState: "RETURNED",
          context, expected,
          incompleteMessage:
            "This return was interrupted: the effect was marked but the return record it should "
            + "have written is missing or incomplete. Check the lots named below and reconcile — "
            + "do not return them again.",
          incompleteReason: "PARTIAL_RETURN_NEEDS_RECONCILIATION",
          describe: (record) => ({
            customerReturn: record,
            returnedAt: record?.effectiveAt || null,
            effectiveAt: record?.effectiveAt || null,
            recordedAt: record?.recordedAt || null,
          }),
        });
      }

      const plan = await movements.planReturn(context, {
        docId: req.params.docId,
        rows: req.body?.lots,
        reason: req.body?.reason,
        returnedOn: req.body?.returnedOn,
        claimed: req.body?.claimed || {},
      });

      const docId = plan.doc._id;

      let out = null;
      await unitOfWork.run(req.tenant, {
        idempotencyRecord: req.idempotent?.record,
        /* ── NAMED UP FRONT, FOR THE NO-TRANSACTION CASE ────────────────────
           With transactions the unit of work marks the effect INSIDE the
           transaction, so a rollback takes the marker with it. Without them
           (a standalone mongod) it marks before the mutation when — and only
           when — the caller names the entity here. Both operations write to
           several collections, so a half-completed one must route the retry into
           reconciliation rather than repeat the part that landed. */
        entityType: ENTITY_RETURN, entityId: docId,
        recoveryReceipt: {
          action: "STOCK_RETURNED_TO_CUSTOMER",
          entityType: ENTITY_RETURN, entityId: docId,
          documentNumber: str(plan.doc.documentRef),
          /* ── THE DATE THE OPERATOR ENTERED, NOT THE MOMENT OF WRITING ────
             So a recovery long afterwards restores the event on the day it
             happened. */
          occurredAt: plan.effectiveAt,
          previousState: "HELD", resultingState: "RETURNED",
          reason: plan.reason,
          facts: receiptFacts([
            ["operationType", "RETURN_TO_CUSTOMER"],
            ["operationKey", str(req.idempotent?.key)],
            ["customerReference", str(req.body?.customerReference)],
            ["lotCount", plan.plans.length],
            ["quantity", totalPlanned(plan.plans)],
          ]),
        },
        mutate: async (session) => {
          out = await movements.postReturn(context, {
            tenant: req.tenant, session,
            doc: plan.doc, plans: plan.plans,
            reason: plan.reason, effectiveAt: plan.effectiveAt,
            customerReference: req.body?.customerReference,
            actor: { id: req.user.id, name: req.user.name },
            idempotencyKey: req.idempotent?.key || "",
          });
          return {
            entityType: ENTITY_RETURN, entityId: docId, result: true,
            entry: {
              entityType: ENTITY_RETURN, entityId: docId,
              documentNumber: out.documentRef,
              action: "STOCK_RETURNED_TO_CUSTOMER",
              previousState: "HELD", resultingState: "RETURNED",
              requestId: req.id || "", idempotencyKey: req.idempotent?.key || "",
              reason: out.reason,
              /* The effective business date on the audit row too, so the trail
                 and the stock ledger say the same day. */
              at: out.effectiveAt,
              metadata: {
                lotCount: out.lots.length,
                customerReference: out.customerReference,
                ownership: "CUSTOMER_OWNED",
                documentRef: out.documentRef,
                /* ── ISO STRINGS, BECAUSE THE SANITISER KEEPS ONLY SCALARS ──
                   `metadata` accepts strings, numbers and booleans and silently
                   DROPS anything else — a `Date` here simply vanished, which is
                   how an audit row came to have no effective date at all while
                   looking complete. The row's own `at` above carries the real
                   Date; these two are for a reader of the metadata. */
                effectiveAt: out.effectiveAt.toISOString(),
                recordedAt: out.recordedAt.toISOString(),
                returnId: String(out.record._id),
                /* Said explicitly on the audit row: this is not a vendor
                   return and produced no purchasing record. */
                vendorReturn: false,
              },
            },
          };
        },
      });

      const doc = await receipts.receivableExpectation(context, { expectationId: docId })
        .catch(() => null);
      const body = {
        success: true,
        message: "Recorded as returned to the customer.",
        documentRef: out.documentRef,
        /* `returnedAt` is kept for the existing screen; both dates are stated
           because they are two different facts. */
        returnedAt: out.effectiveAt,
        effectiveAt: out.effectiveAt,
        recordedAt: out.recordedAt,
        customerReturn: {
          id: String(out.record._id),
          reason: out.reason,
          customerReference: out.customerReference,
          effectiveAt: out.effectiveAt,
          recordedAt: out.recordedAt,
          lines: out.record.lines.map((l) => ({
            lotId: String(l.lotId),
            goodsReceiptNumber: l.goodsReceiptNumber,
            itemName: l.itemName,
            quantity: l.quantity,
            baseUnit: l.baseUnit,
            locationCode: l.locationCode,
          })),
        },
        standing: doc ? await receipts.standingFor(context, doc) : null,
      };
      return req.idempotent
        ? await req.idempotent.succeed(201, body, { entityType: ENTITY_RETURN, entityId: docId })
        : res.status(201).json(body);
    } catch (err) {
      if (err?.name === "StorePurchaseError") return sendError(res, err);
      console.error("[customer-material-return] error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

/* ═══ OWNERSHIP LABELS ═════════════════════════════════════════════════════ */

/**
 * PRINT the ownership label for a lot.
 *
 * Creates a Barcode document in the existing collection — the same one product
 * marking and purchase receipts write — so a scanner needs no second system and
 * a warehouse report sees one set of labels. What makes it different is what it
 * says: whose material this is, which single order line it may be used for, and
 * no vendor, price or purchase reference, because nothing was bought.
 *
 * Behind the receipt grant: labelling a delivery is part of receiving it, which
 * is the same reason the purchase receipt path produces stickers.
 */
router.post("/:docId/lots/:lotId/labels", ...canReceive,
  /* ── A KEY IS REQUIRED, AND THAT IS THE POINT ─────────────────────────────
     `withIdempotency` refuses a request with no `Idempotency-Key` before anything
     is read, let alone written. Printing used to accept an OPTIONAL key, so the
     ordinary retry — the printer jammed, the operator pressed Print again —
     arrived with no key at all and allocated a second slice of the same lot. One
     roll, two stickers, two different quantities, both believable.

     The key also covers the payload and the target, so the same key with a
     different quantity, lot or document is a 409 rather than a silent second
     allocation. */
  withIdempotency("CUSTOMER_MATERIAL_LABEL", {
    target: (req) => `${req.params.docId}:${req.params.lotId}`,
  }),
  async (req, res) => {
    try {
      const context = ctx(req);
      const printKey = req.idempotent?.key || "";

      /* ── RECOVERY: THREE STATES, TOLD APART ─────────────────────────────
         The marker says an allocation was begun. What happened next is read from
         the Barcode, which is the canonical evidence and carries the key:

           Barcode present  → allocation and label both landed. Return it.
           Barcode missing  → the allocation may have been taken with no label to
                              show for it. That is a leaked claim on the lot, and
                              it is reported with the exact quantity rather than
                              quietly re-allocated.

         Only reachable without transactions; with them the allocation and the
         Barcode commit or roll back together. */
      if (req.idempotent?.recovering) {
        const existing = await labels.labelForKey(context, {
          docId: req.params.docId, lotId: req.params.lotId, printKey,
        });
        await unitOfWork.recover(req.tenant, {
          entityType: ENTITY_LABEL, entityId: req.params.docId,
          idempotencyKey: printKey,
          entry: {
            documentNumber: str(existing?.label?.documentRef),
            action: existing ? "LABEL_PRINTED" : "LABEL_RECONCILIATION_REQUIRED",
            resultingState: existing ? "PRINTED" : "",
            requestId: req.id || "", idempotencyKey: printKey,
            reason: existing
              ? ""
              : "The allocation was marked but no label for this key was written.",
            metadata: {
              recovered: true, operationType: "LABEL", operationKey: printKey,
              lotId: str(req.params.lotId), complete: Boolean(existing),
            },
          },
        });
        if (!existing) {
          throw fail("LIFECYCLE_BLOCKED",
            "This label was interrupted after the lot's labelled quantity was claimed but before "
            + "the label itself was written. The claim may be holding quantity that has no sticker "
            + "— check the lot's labelled figure and reconcile it. Do not simply print again.",
            {
              reason: "PARTIAL_LABEL_NEEDS_RECONCILIATION",
              operationType: "LABEL", operationKey: printKey,
              lotId: str(req.params.lotId), documentRef: "",
            });
        }
        return await req.idempotent.succeed(200, {
          success: true, message: "This label was already printed.", ...existing,
        }, { entityType: ENTITY_LABEL, entityId: req.params.docId });
      }

      /* Read-only: the document, the lot, the binding and the arithmetic. */
      const plan = await labels.planLabel(context, {
        docId: req.params.docId, lotId: req.params.lotId,
        quantity: req.body?.quantity, printKey,
      });

      /* An exact replay that never reached EFFECT_APPLIED — the label is already
         there, so nothing is allocated and nothing is written. */
      if (plan.replay) {
        const body = { success: true, message: "This label was already printed.", ...plan.result };
        return await req.idempotent.succeed(200, body, {
          entityType: ENTITY_LABEL, entityId: plan.doc._id,
        });
      }

      let out = null;
      await unitOfWork.run(req.tenant, {
        idempotencyRecord: req.idempotent?.record,
        entityType: ENTITY_LABEL, entityId: plan.doc._id,
        recoveryReceipt: {
          action: "LABEL_PRINTED",
          entityType: ENTITY_LABEL, entityId: plan.doc._id,
          documentNumber: str(plan.doc.documentRef),
          occurredAt: new Date(),
          resultingState: "PRINTED",
          subjectType: "customer_material_lot",
          subjectId: plan.lot._id,
          subjectCode: str(plan.lot.goodsReceiptNumber),
          facts: receiptFacts([
            ["operationType", "LABEL"],
            ["operationKey", printKey],
            ["quantity", plan.quantity],
          ]),
        },
        /* ── ONE TRANSACTION, SO THERE IS NO WINDOW ───────────────────────
           The claim on the lot and the Barcode commit together. Before this the
           two were separate writes with a `catch` between them, which handles a
           thrown error and does nothing at all about the process being killed in
           the gap — and the gap was where the lot lost quantity that no sticker
           ever accounted for. */
        mutate: async (session) => {
          out = await labels.postLabel(context, {
            ...plan, actor: { id: req.user.id, name: req.user.name },
            printKey, session,
          });
          return {
            entityType: ENTITY_LABEL, entityId: plan.doc._id, result: true,
            entry: {
              entityType: ENTITY_LABEL, entityId: plan.doc._id,
              documentNumber: str(plan.doc.documentRef),
              action: "LABEL_PRINTED", resultingState: "PRINTED",
              requestId: req.id || "", idempotencyKey: printKey,
              metadata: {
                lotId: str(plan.lot._id),
                goodsReceiptNumber: str(plan.lot.goodsReceiptNumber),
                quantity: out.allocation.quantity,
                allocationRef: out.allocation.ref,
                ownership: "CUSTOMER_OWNED",
              },
            },
          };
        },
      });

      const body = { success: true, ...out };
      return await req.idempotent.succeed(201, body, {
        entityType: ENTITY_LABEL, entityId: plan.doc._id,
      });
    } catch (err) {
      if (err?.name === "StorePurchaseError") return sendError(res, err);
      console.error("[customer-material-label] error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

/**
 * REPRINT — fetch what already exists.
 *
 * A read, deliberately, and a read is all it is: reprinting a sticker that fell
 * off a roll must not create stock, a receipt, a lot or a balance change, and the
 * surest way to guarantee that is for the operation to write nothing at all. The
 * label's own print count is left alone too — the same label printed twice is one
 * label.
 */
router.get("/:docId/lots/:lotId/labels", canRead, handle(async (req, res) => {
  const out = await labels.labelsFor(ctx(req), {
    docId: req.params.docId, lotId: req.params.lotId,
  });
  return res.json({ success: true, ...out });
}));

/** One lot's movement history — every arrival, issue and return, in order. */
router.get("/:docId/lots/:lotId/movements", canRead, handle(async (req, res) => {
  const out = await labels.movementsFor(ctx(req), {
    docId: req.params.docId, lotId: req.params.lotId,
  });
  return res.json({ success: true, ...out });
}));

module.exports = router;
