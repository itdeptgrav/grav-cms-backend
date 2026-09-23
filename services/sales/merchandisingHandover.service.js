// services/sales/merchandisingHandover.service.js
//
// SALES ISSUES THE HANDOVER. This is the producer's whole logic: which order
// lines MAY cross to Merchandising, what crosses when one does, and how a
// crossed statement is superseded or cancelled.
//
// ── WHAT "CONFIRMED" MEANS HERE, EXACTLY ────────────────────────────────────
// The existing Sales process: a CustomerRequest whose `status` is
// `quotation_sales_approved` or a later genuine execution state. Customer
// approval of a quotation is NOT confirmation — `quotation_customer_approved`
// still awaits Sales' own sign-off, and issuing on it would hand Merchandising
// a promise Sales has not finished making. `on_hold`, `rejected` and
// `cancelled` are not execution states and do not qualify.
//
// ── AND WHAT MAY NEVER CROSS ────────────────────────────────────────────────
// No price, quotation, margin, payment, credit, currency amount, negotiation
// or buyer channel. The request body is checked against a named refusal list
// AND the projection is built field by field from the server's own reads, so
// a forbidden fact cannot arrive by being typed nor leave by being copied.
//
// House samples cannot produce a commercial handover: there is no buyer
// commitment behind one. Competing style variants stay upstream — only the
// Sales-chosen style crosses, which is what `variantChosen` records.
//
// ── THE LINE'S IDENTITY ─────────────────────────────────────────────────────
// The order line's own permanent `lineRef`, minted and owned by the
// CustomerRequest record. It used to be the line's selected style, for want of
// anything else stable, and that made a style identity stand in for an
// order-line identity: an order carrying one style on two commercial lines —
// two destinations, two delivery commitments, two buyer references — could not
// be handed over at all. Those are two handovers now, two files, two
// independent version histories, and nothing about them is ambiguous.
//
// A legacy line that predates the reference is not guessed at. It is reported
// as needing its permanent reference, and the Sales-owned backfill utility
// gives it one.
//
// ── WHAT THIS SERVICE MAY WRITE ─────────────────────────────────────────────
// Sales records. Only Sales records.
//
// It used to reach across and set the Merchandising Execution File to
// CANCELLED itself, and to write its issue/supersede/cancel history straight
// into the Merchandising audit collection. That worked, and it meant a
// Merchandising transaction could be rolled back by a Sales failure, that
// changing how Merchandising records a cancellation was a change to Sales
// code, and that the Merchandising audit trail held rows no Merchandising
// code had written.
//
// So: this writes the handover version, the Sales handover history and the
// Sales outbox — atomically. Merchandising's receiver reads that outbox and
// makes its own changes. Sales owns the event; Merchandising owns the
// mutation. There is a structural test that keeps it that way.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const {
  HANDOVER_EVENT_KINDS, SalesHandoverAuditEvent, SalesHandoverOutboxEvent,
} = require("../../models/CMS_Models/Sales/SalesHandoverEvent");
const contract = require("./handoverContract");
const processRequirement = require("./lineProcessRequirement");
/* Tenancy, not costing. See services/integration/styleOwnershipProof.service.js
   for why this moved out of the Central Costing module. */
const { ownershipProofFor } = require("../integration/styleOwnershipProof.service");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const model = (name, path) => (mongoose.models[name] || require(path));
const CustomerRequest = () => model("CustomerRequest", "../../models/Customer_Models/CustomerRequest");
const SampleStyle = () => model("SampleStyle", "../../models/CMS_Models/Sales/SampleStyle");

/** The Sales statuses that ARE commercial confirmation. */
const CONFIRMED_STATUSES = Object.freeze([
  "quotation_sales_approved", "production", "shipping", "delivered", "completed",
]);

/* Fields that name money, the buyer relationship, or somebody else's record.
   Named so a refusal says WHICH desk owns the field. */
const REFUSED_FIELDS = Object.freeze({
  price: "a price", unitPrice: "a price", basePrice: "a price", amount: "an amount",
  finalOrderPrice: "a price", quotation: "a quotation", quotations: "a quotation",
  margin: "a margin", cost: "a cost", currency: "a currency amount",
  paymentTerms: "payment terms", payment: "payment information", credit: "credit terms",
  customer: "the customer record", customerInfo: "the customer record",
  customerId: "the customer record", contact: "a buyer contact",
  email: "a buyer contact", phone: "a buyer contact", message: "buyer communication",
  companyId: "a company stamp", actingCompanyId: "a company stamp",
  journeyId: "a journey", pipeline: "Sales pipeline state",
});

/** The only fields an issue body may carry. */
const ISSUE_FIELDS = Object.freeze([
  "expectedCurrentVersionNo", "deliveries", "breakdown", "allocations",
  "packingRequirement", "testingRequirement", "deliveryRequirement",
  /* The buyer's special-process requirement for this exact line — see
     services/sales/lineProcessRequirement.js. Optional: a version issued
     without it states nothing, which is never "not required". */
  "processRequirements",
]);

/**
 * Run `fn` inside one transaction, or refuse.
 *
 * The version, the Sales history and the outbox announcement commit together
 * or not at all. A deployment without transactions gets a 503 it can act on,
 * never a published statement whose announcement was lost.
 */
async function withTxn(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } catch (err) {
    if (/Transaction numbers|replica set|transactions are not supported/i.test(str(err?.message))) {
      throw fail("MERCHANDISING_TRANSACTION_REQUIRED",
        "This deployment cannot issue a handover atomically. Ask an operator — the database needs a replica set.");
    }
    throw err;
  } finally {
    session.endSession();
  }
}

/**
 * The confirmed order, proved to belong to this company through its lines'
 * styles — the one company chain a CustomerRequest has.
 *
 * Every line that names a style must prove the SAME company as the caller's;
 * one foreign style makes the whole request not-found, because "partly
 * yours" is not an answer a tenant boundary gives. A request whose lines name
 * no style at all proves nothing and is equally not-found here: the producer
 * exists for confirmed orders with chosen styles, and an unprovable record
 * must not be describable.
 */
async function loadOwnedRequest(scope, requestId) {
  if (!isId(requestId)) throw fail("NOT_FOUND", "Order not found.");
  const request = await CustomerRequest().findById(requestId).lean();
  if (!request) throw fail("NOT_FOUND", "Order not found.");

  const styleIds = [...new Set((request.items || [])
    .map((i) => str(i.sampleStyleId)).filter(Boolean))];
  if (!styleIds.length) throw fail("NOT_FOUND", "Order not found.");

  const styles = await SampleStyle().find({ _id: { $in: styleIds } })
    .select("sampleStyleId styleCode productName variantLabel variantKey variantChosen sampleType isActive journeyId enquiryId")
    .lean();
  const styleById = new Map(styles.map((s) => [str(s._id), s]));

  let anyProved = false;
  for (const style of styles) {
    const owned = await ownershipProofFor(style, scope.companyId);
    if (!owned) throw fail("NOT_FOUND", "Order not found.");
    anyProved = true;
  }
  if (!anyProved) throw fail("NOT_FOUND", "Order not found.");

  return { request, styleById };
}

/** Why one line cannot be handed over — empty means it can. */
async function lineBlockers(request, item, style) {
  const blockers = [];
  if (!CONFIRMED_STATUSES.includes(str(request.status))) {
    blockers.push({ code: "NOT_CONFIRMED", message: "This order is not commercially confirmed yet." });
  }
  if (str(request.orderOrigin || "customer") !== "customer") {
    blockers.push({ code: "NOT_A_CUSTOMER_ORDER", message: "Only a confirmed customer order can be handed to Merchandising." });
  }
  /* ── AN UNNAMED LINE IS NOT AN AMBIGUOUS ONE ──────────────────────────
     A line minted before permanent references existed has no identity to
     hand over WITH, and falling back to its style or its position is what
     produced the ambiguity this whole correction removes. It is named as
     the fixable condition it is; the Sales backfill utility fixes it. */
  if (!str(item.lineRef)) {
    blockers.push({
      code: "NO_LINE_REFERENCE",
      message: "This order line needs its permanent Sales line reference before it can be handed over.",
    });
  }
  if (!style) {
    blockers.push({ code: "NO_SELECTED_STYLE", message: "This line has no selected style." });
    return blockers;
  }
  if (style.isActive === false) {
    blockers.push({ code: "STYLE_INACTIVE", message: "This line's style is no longer active." });
  }
  if (str(style.sampleType) === "house") {
    blockers.push({ code: "HOUSE_SAMPLE", message: "A house sample has no buyer commitment and cannot be handed over." });
  }
  if (!(Number(item.totalQuantity) > 0)) {
    blockers.push({ code: "NO_QUANTITY", message: "This line has no positive confirmed quantity." });
  }
  /* Competing variants stay upstream until Sales chooses. */
  if (style.journeyId) {
    const siblings = await SampleStyle().countDocuments({
      journeyId: style.journeyId, productName: style.productName, isActive: true,
    });
    if (siblings > 1 && style.variantChosen !== true) {
      blockers.push({
        code: "VARIANT_UNRESOLVED",
        message: "Several style variants exist for this product and none has been chosen.",
      });
    }
  }
  return blockers;
}

/** What the producer panel shows for one line. Allowlisted. */
function lineView(item, style, currentVersion) {
  const p = currentVersion?.executionProjection || {};
  return {
    /* The line's own permanent reference — the route identity, and what the
       handover points at. Empty only on a legacy line awaiting backfill. */
    lineRef: str(item.lineRef),
    itemName: str(item.stockItemName),
    quantity: Number(item.totalQuantity) || 0,
    /* The selected style, as a REFERENCE on the line — no longer its name. */
    styleId: str(item.sampleStyleId),
    styleRef: style ? (str(style.styleCode) || str(style.sampleStyleId)) : "",
    productName: style ? str(style.productName) : str(item.stockItemName),
    variantLabel: style ? str(style.variantLabel) : "",
    currentVersion: currentVersion
      ? {
        id: str(currentVersion._id),
        versionNo: currentVersion.versionNo,
        state: currentVersion.publication?.state || "CURRENT",
        issuedAt: currentVersion.sourceRecord?.issuedAt || null,
        deliveries: (p.deliveries || []).map((d) => ({
          dropRef: str(d.dropRef),
          committedDeliveryDate: d.committedDeliveryDate,
          quantity: d.quantity,
          nominatedFactoryRef: str(d.nominatedFactoryRef),
        })),
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
        processRequirements: processRequirement.statementView(p.processRequirements),
      }
      : null,
  };
}

/* The authorities a definite process answer on THIS line may cite — the
   buyer's approved order, or, on a genuine company order, Sales' own
   authorisation. Identities only, no price. Empty when none of them names
   this line, and on a customer's order pushed through without the customer's
   approval, which can then only say UNKNOWN. */
const approvalsView = (request, item) => processRequirement.evidenceOptions(request, item).map((a) => ({
  evidenceRef: a.evidenceRef, kind: a.kind, label: processRequirement.evidenceLabel(a.kind),
  approvalRevision: a.approvalRevision,
  approvedAt: a.approvedAt || null, poNumber: a.poNumber || "", poDate: a.poDate || null,
  documentName: a.documentName || "",
  authorisedAt: a.authorisedAt || null,
  needsReason: a.kind === "INTERNAL_ORDER",
}));

/** The producer panel: each line, its eligibility, its publication state. */
async function inspectRequest(scope, { requestId } = {}) {
  const { request, styleById } = await loadOwnedRequest(scope, requestId);

  const versions = await SalesHandoverVersion.find({
    companyId: scope.companyId,
    handoverRef: str(request.requestId),
    "publication.state": "CURRENT",
  }).lean();
  const currentByLine = new Map(versions.map((v) => [v.handoverLineRef, v]));

  const lines = [];
  for (const item of request.items || []) {
    const style = styleById.get(str(item.sampleStyleId)) || null;
    const blockers = await lineBlockers(request, item, style);
    lines.push({
      ...lineView(item, style, str(item.lineRef) ? currentByLine.get(str(item.lineRef)) : null),
      buyerApprovals: approvalsView(request, item),
      eligible: blockers.length === 0,
      blockers,
    });
  }

  return {
    order: {
      id: str(request._id),
      orderRef: str(request.requestId),
      status: str(request.status),
      confirmed: CONFIRMED_STATUSES.includes(str(request.status)),
    },
    lines,
  };
}

/** Refuse any body field this door does not accept, by name. */
function assertIssueBodyShape(body) {
  const nested = [
    ["deliveries", contract.DELIVERY_FIELDS, "a delivery commitment"],
    ["breakdown", contract.BREAKDOWN_FIELDS, "a breakdown split"],
    ["allocations", contract.ALLOCATION_FIELDS, "an allocation"],
  ];
  for (const key of Object.keys(body || {})) {
    const refused = REFUSED_FIELDS[key];
    if (refused) {
      throw fail("FIELD_NOT_ACCEPTED",
        `A handover states what Merchandising executes. It cannot carry ${refused}.`, { field: key });
    }
    if (!ISSUE_FIELDS.includes(key)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of a handover.`, { field: key });
    }
  }
  /* The process statement's own rows are checked field by field in
     lineProcessRequirement; a refused money or buyer field is named here first. */
  for (const [i, row] of (Array.isArray(body?.processRequirements?.processes) ? body.processRequirements.processes : []).entries()) {
    for (const key of Object.keys(row || {})) {
      const refused = REFUSED_FIELDS[key];
      if (refused) throw fail("FIELD_NOT_ACCEPTED", `A process requirement cannot carry ${refused}.`, { field: key, index: i });
    }
  }
  for (const [arrayKey, allowed, label] of nested) {
    for (const [i, row] of (body?.[arrayKey] || []).entries()) {
      for (const key of Object.keys(row || {})) {
        const refused = REFUSED_FIELDS[key];
        if (refused) throw fail("FIELD_NOT_ACCEPTED", `${label[0].toUpperCase()}${label.slice(1)} cannot carry ${refused}.`, { field: key, index: i });
        if (!allowed.includes(key)) throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of ${label}.`, { field: key, index: i });
      }
    }
  }
}

/** The order line this reference names, or a refusal. */
function findLine(request, lineRef) {
  const wanted = str(lineRef);
  if (!wanted) throw fail("NOT_FOUND", "Order line not found.");
  const matches = (request.items || []).filter((i) => str(i.lineRef) === wanted);
  if (matches.length !== 1) throw fail("NOT_FOUND", "Order line not found.");
  return matches[0];
}

/**
 * ISSUE — version 1, or the next version superseding the current one.
 *
 * `expectedCurrentVersionNo` is the issuer's statement of what they believe is
 * in force (0 for a first issue). A mismatch is a 409, not a silent v3: two
 * salespeople issuing at once must not both succeed.
 */
async function issue(scope, { requestId, lineId, body = {}, actor = null } = {}) {
  assertIssueBodyShape(body);
  const { request, styleById } = await loadOwnedRequest(scope, requestId);
  const item = findLine(request, lineId);

  const style = styleById.get(str(item.sampleStyleId)) || null;
  const blockers = await lineBlockers(request, item, style);
  if (blockers.length) {
    throw fail("HANDOVER_NOT_ELIGIBLE", blockers[0].message, { blockers });
  }

  const totalQuantity = Number(item.totalQuantity);
  const deliveries = contract.normaliseDeliveries(body.deliveries, totalQuantity);
  const breakdown = contract.normaliseBreakdown(body.breakdown, totalQuantity);
  /* The split × drop mapping — required only when the line genuinely has two
     axes, refused when it has one, and reconciled on both when it has two. */
  const allocations = contract.normaliseAllocations(body.allocations, breakdown, deliveries, totalQuantity);

  const handoverRef = str(request.requestId);
  const handoverLineRef = str(item.lineRef);
  const expected = Number(body.expectedCurrentVersionNo);
  if (!Number.isInteger(expected) || expected < 0) {
    throw fail("VALIDATION", "Say which version you believe is current (0 for a first issue).", { field: "expectedCurrentVersionNo" });
  }
  /* Resolved against THIS order's stored buyer approvals, stamped with the
     issuer. A buyer change is a new issue — the successor version — and the
     version it supersedes keeps its own statement untouched. */
  const processRequirements = processRequirement.normaliseStatement(body.processRequirements, request, { item, actor });

  const executionProjection = {
    orderRef: handoverRef,
    orderLineRef: handoverLineRef,
    styleRef: str(style.styleCode) || str(style.sampleStyleId),
    /* The stable identity behind that display code. See the projection. */
    ...(style?._id ? { sampleStyleId: style._id } : {}),
    productName: str(style.productName) || str(item.stockItemName),
    /* A sourced display label — a name to print, never a CRM record. */
    ...(str(request.customerInfo?.name) ? { buyerDisplayLabel: str(request.customerInfo.name) } : {}),
    totalQuantity,
    breakdown,
    deliveries,
    allocations,
    ...(str(body.packingRequirement) ? { packingRequirement: str(body.packingRequirement).slice(0, 2000) } : {}),
    ...(str(body.testingRequirement) ? { testingRequirement: str(body.testingRequirement).slice(0, 2000) } : {}),
    ...(str(body.deliveryRequirement) ? { deliveryRequirement: str(body.deliveryRequirement).slice(0, 2000) } : {}),
    ...(processRequirements ? { processRequirements } : {}),
  };
  /* Derived here purely to prove the projection resolves to a coherent set of
     units before it is published. Merchandising derives its own from the
     stored version at acceptance, through this same function. */
  contract.deriveUnitPlan(executionProjection);

  const correlationId = crypto.randomUUID();
  const now = new Date();

  return withTxn(async (session) => {
    const current = await SalesHandoverVersion.findOne({
      companyId: scope.companyId, handoverRef, handoverLineRef, "publication.state": "CURRENT",
    }).session(session);

    /* ── THE NEXT NUMBER IS THE NEXT NUMBER, NOT THE NEXT AFTER CURRENT ──
       A cancelled line has no CURRENT version, so numbering from the current
       one would mint a second version 1 and collide with the per-line unique
       index — a 500 on a legitimate act. Version numbers count what has ever
       been said on this line; `expectedCurrentVersionNo` is a separate
       question about what is in force. */
    const [highest] = await SalesHandoverVersion.find({
      companyId: scope.companyId, handoverRef, handoverLineRef,
    }).sort({ versionNo: -1 }).limit(1).session(session);
    const highestNo = highest ? highest.versionNo : 0;

    const currentNo = current ? current.versionNo : 0;
    if (currentNo !== expected) {
      throw fail("HANDOVER_VERSION_CONFLICT",
        current
          ? `Version ${current.versionNo} is already current for this line. Re-read it and issue against it.`
          : "No version is current for this line any more. Re-read before issuing.",
        { currentVersionNo: currentNo });
    }

    /* A successor never drops a stated requirement by omission: a date change
       that forgot the processes would read, downstream, as "not stated" and
       lose an approved fact without a word. Sales restates it (the form
       carries it forward); the server never copies it silently. */
    if (current?.executionProjection?.processRequirements?.processes?.length && !processRequirements) {
      throw fail("PROCESS_REQUIREMENT_RESTATE_REQUIRED",
        `Version ${current.versionNo} states this line's buyer-approved processes. Restate them on the new version — `
        + "they are not carried forward silently.",
        { field: "processRequirements", currentVersionNo: current.versionNo });
    }

    /* ── RETIRE FIRST, THEN ISSUE ─────────────────────────────────────
       The one-CURRENT-per-line partial unique index is checked as each write
       lands, not at commit — so the successor can only be created once its
       predecessor has stepped down. Both happen or neither: this is one
       transaction. */
    if (current) {
      current.publication.state = "SUPERSEDED";
      current.publication.supersededAt = now;
      await current.save({ session });
    }

    const [version] = await SalesHandoverVersion.create([{
      companyId: scope.companyId,
      handoverRef,
      handoverLineRef,
      versionNo: highestNo + 1,
      supersedesVersionId: current ? current._id : null,
      sourceRecord: {
        app: "sales",
        recordType: "customer_request",
        recordId: request._id,
        /* The source's own state marker at issue — CustomerRequest carries no
           version number, so its updatedAt is the honest one. */
        sourceVersion: new Date(request.updatedAt || now).toISOString(),
        issuedAt: now,
      },
      executionProjection,
      publication: { state: "CURRENT" },
      issuedBy: actor || undefined,
    }], { session });

    const stamp = { companyId: scope.companyId, handoverRef, handoverLineRef, correlationId, at: now };
    const audits = [{
      ...stamp,
      handoverVersionId: version._id,
      versionNo: version.versionNo,
      action: HANDOVER_EVENT_KINDS.ISSUED,
      actor: actor || undefined,
      resultingState: "CURRENT",
    }];
    const outbox = [{
      companyId: scope.companyId,
      kind: HANDOVER_EVENT_KINDS.ISSUED,
      payload: {
        handoverVersionId: version._id, handoverRef, handoverLineRef,
        versionNo: version.versionNo,
      },
      occurredAt: now,
      actor: actor || undefined,
      correlationId,
    }];

    if (current) {
      current.publication.supersededByVersionId = version._id;
      await current.save({ session });
      audits.push({
        ...stamp,
        handoverVersionId: current._id,
        versionNo: current.versionNo,
        action: HANDOVER_EVENT_KINDS.SUPERSEDED,
        actor: actor || undefined,
        previousState: "CURRENT",
        resultingState: "SUPERSEDED",
      });
      outbox.push({
        companyId: scope.companyId,
        kind: HANDOVER_EVENT_KINDS.SUPERSEDED,
        payload: {
          handoverVersionId: current._id, handoverRef, handoverLineRef,
          versionNo: current.versionNo,
          supersededByVersionId: version._id,
          supersededByVersionNo: version.versionNo,
        },
        occurredAt: now,
        actor: actor || undefined,
        correlationId,
      });
    }

    await SalesHandoverAuditEvent.create(audits, { session, ordered: true });
    await SalesHandoverOutboxEvent.create(outbox, { session, ordered: true });
    return { version: version.toObject(), correlationId };
  });
}

/**
 * CANCEL — Sales withdraws the commercial requirement.
 *
 * The version's publication becomes CANCELLED and the outbox says so. The
 * Execution File opened from this line is mirrored to CANCELLED by the
 * MERCHANDISING receiver reading that event — not here. Sales states the
 * commercial fact; Merchandising records what that means for its own record.
 */
async function cancel(scope, { requestId, lineId, reason = "", actor = null } = {}) {
  const { request } = await loadOwnedRequest(scope, requestId);
  const item = findLine(request, lineId);
  if (!str(reason)) {
    throw fail("VALIDATION", "Say why this handover is being cancelled.", { field: "reason" });
  }

  const handoverRef = str(request.requestId);
  const handoverLineRef = str(item.lineRef);
  const correlationId = crypto.randomUUID();
  const now = new Date();
  const why = str(reason).slice(0, 1000);

  return withTxn(async (session) => {
    const current = await SalesHandoverVersion.findOne({
      companyId: scope.companyId, handoverRef, handoverLineRef, "publication.state": "CURRENT",
    }).session(session);
    if (!current) {
      throw fail("HANDOVER_STATE_CONFLICT", "No current handover exists for this line.");
    }

    current.publication.state = "CANCELLED";
    current.publication.cancelledAt = now;
    current.publication.cancelReason = why;
    await current.save({ session });

    await SalesHandoverAuditEvent.create([{
      companyId: scope.companyId,
      handoverVersionId: current._id,
      handoverRef,
      handoverLineRef,
      versionNo: current.versionNo,
      action: HANDOVER_EVENT_KINDS.CANCELLED,
      actor: actor || undefined,
      at: now,
      reason: why,
      correlationId,
      previousState: "CURRENT",
      resultingState: "CANCELLED",
    }], { session });

    await SalesHandoverOutboxEvent.create([{
      companyId: scope.companyId,
      kind: HANDOVER_EVENT_KINDS.CANCELLED,
      payload: {
        handoverVersionId: current._id, handoverRef, handoverLineRef,
        versionNo: current.versionNo, reason: why,
      },
      occurredAt: now,
      actor: actor || undefined,
      correlationId,
    }], { session });

    return { version: current.toObject(), correlationId };
  });
}

/* ═══ THE OUTBOX, AS SALES' OWN BOOKKEEPING ════════════════════════════════ */

/**
 * Undelivered announcements, oldest first.
 *
 * Ordering by when Sales ACTED, not by when the row was written, so a retry
 * that catches up on three events applies them in the order they happened —
 * which is what stops a delayed supersession landing after the cancellation
 * that followed it.
 */
async function pendingOutboxEvents({ companyId = null, correlationId = "", limit = 50 } = {}) {
  const query = { status: "PENDING" };
  if (companyId) query.companyId = companyId;
  if (str(correlationId)) query.correlationId = str(correlationId);
  return SalesHandoverOutboxEvent.find(query)
    .sort({ occurredAt: 1, _id: 1 })
    .limit(Math.min(Number(limit) || 50, 200))
    .lean();
}

/** The receiver has applied this event. Sales records that it is done with. */
async function markOutboxDelivered(eventId) {
  await SalesHandoverOutboxEvent.updateOne(
    { _id: eventId, status: "PENDING" },
    { $set: { status: "DELIVERED", deliveredAt: new Date() }, $inc: { attempts: 1 } },
  );
}

/**
 * A delivery attempt failed. The row stays PENDING — deliberately: an event
 * that was not applied has not been delivered, whatever the attempt count
 * says, and marking it otherwise would lose a commercial statement quietly.
 */
async function markOutboxAttemptFailed(eventId, err) {
  await SalesHandoverOutboxEvent.updateOne(
    { _id: eventId },
    {
      $set: { lastAttemptAt: new Date(), lastError: str(err?.message).slice(0, 500) },
      $inc: { attempts: 1 },
    },
  );
}

module.exports = {
  CONFIRMED_STATUSES, REFUSED_FIELDS, ISSUE_FIELDS,
  /* ── EXPOSED SO OWNERSHIP IS PROVED IN ONE PLACE ───────────────────────
     A CustomerRequest carries no `companyId`; its company is proved through
     its lines' styles, and getting that wrong is a tenancy leak rather than a
     bug. `orderDemandRelease` needs exactly this proof before it may say
     anything about an order — including "not confirmed" or "no such line",
     both of which confirm the order exists to somebody who may not see it.

     Read-only, and it writes nothing. A second implementation of this rule
     would be a second tenancy boundary, and the day they disagreed the
     weaker one would be the one that answered. */
  loadOwnedRequest,
  lineBlockers, inspectRequest, issue, cancel,
  pendingOutboxEvents, markOutboxDelivered, markOutboxAttemptFailed,
};
