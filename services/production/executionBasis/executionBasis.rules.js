// services/production/executionBasis/executionBasis.rules.js
//
// The pure half of the Production execution-basis command: eligibility, the
// frozen snapshot, the receipt key and "which basis applied at asOf". No
// database, no clock — the service loads the records and passes them in.
//
// ── ELIGIBILITY IS PROVED, NEVER ASSUMED ────────────────────────────────────
// Each check below names the record that proves it. The browser supplies only
// two selectors (publicationId, workOrderId); every identity, quantity, route
// and scope is read from the server's own records and COPIED into the basis.
// The first failed proof is returned as a stable code; nothing is guessed.
//
// ── SCOPE: A PPC PLANNING LINE ──────────────────────────────────────────────
// `PpcCapacityLine._id` is authoritative because it is a company-owned record
// (companyId immutable, unique `lineRef` per company), the ACTIVE booking the
// publication names froze its exact `lineId` and `lineRevision`, and the
// publication froze the same booking. That chain is provable end to end.
// `factoryRef` is NOT: the line model itself calls it a free string "not a
// join key" that nothing resolves, and no Establishment/site master exists. It
// is copied as `factoryRefDisplay` with `factoryRefAuthoritative: false`, and
// nothing ever filters, joins or authorises on it.
"use strict";

const mongoose = require("mongoose");
const { BASIS_STATE, BASIS_LIMITS } = require("../../../models/CMS_Models/Manufacturing/WorkOrder/productionExecutionBasis.schema");

const REQUIRED_PROCESS = "SEWING";
const QUANTITY_RULE = "work_order_quantity_equals_published_quantity_and_within_confirmed";

class ExecutionBasisError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  toResponse() {
    return { success: false, code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

const fail = (status, code, message, details) => { throw new ExecutionBasisError(status, code, message, details); };
const idOf = (v) => (v == null ? null : String(v));
const same = (a, b) => a != null && b != null && idOf(a) === idOf(b);
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const isObjectId = (v) => /^[0-9a-f]{24}$/i.test(String(v || ""));
const codeKey = (c) => String(c ?? "").trim().toLowerCase();

/** Deterministic: one company, one WorkOrder, one PPC publication version. */
function receiptKeyOf(companyId, workOrderId, publicationId) {
  return `${idOf(companyId)}:${idOf(workOrderId)}:${idOf(publicationId)}`;
}

/** A frozen IE route Production can execute and scans can be attributed to. */
function routeProblems(rows) {
  const problems = [];
  if (!Array.isArray(rows) || rows.length === 0) return ["route_has_no_operations"];
  const rowIds = new Set();
  const sequences = new Set();
  const codes = new Set();
  for (const r of rows) {
    const rowId = String(r?.rowId ?? "").trim();
    if (!rowId) problems.push("row_without_id");
    else if (rowIds.has(rowId)) problems.push(`row_id_duplicated:${rowId}`);
    rowIds.add(rowId);
    const seq = Number(r?.sequence);
    if (!Number.isInteger(seq) || seq < 1) problems.push(`sequence_invalid:${rowId}`);
    else if (sequences.has(seq)) problems.push(`sequence_duplicated:${seq}`);
    sequences.add(seq);
    if (!isObjectId(r?.ieOperationId)) problems.push(`ie_operation_missing:${rowId}`);
    if (!(Number(r?.ieOperationRevision) >= 1)) problems.push(`ie_operation_revision_missing:${rowId}`);
    const code = codeKey(r?.operationCode);
    if (!code) problems.push(`operation_code_missing:${rowId}`);
    else if (codes.has(code)) problems.push(`operation_code_duplicated:${code}`);
    codes.add(code);
    if (!Number.isFinite(Number(r?.standardTimeMinutes)) || Number(r.standardTimeMinutes) < 0) {
      problems.push(`standard_time_missing:${rowId}`);
    }
  }
  return problems;
}

/**
 * Throws the first failed proof; returns the facts the basis is built from.
 * Every record passed in was already loaded company-scoped; each is checked
 * against the company again here so a loader bug cannot widen the scope.
 */
function assertEligible({ companyId, workOrder, publication, release, booking, line }) {
  const company = idOf(companyId);

  if (!workOrder || !same(workOrder.salesLineLink?.companyId, company)) {
    fail(404, "WORK_ORDER_NOT_FOUND", "No work order of your company has that id.");
  }
  if (workOrder.status === "cancelled") fail(409, "WORK_ORDER_CANCELLED", "A cancelled work order cannot receive an execution basis.");

  if (!publication || !same(publication.companyId, company)) {
    fail(404, "PUBLICATION_NOT_FOUND", "No PPC publication of your company has that id.");
  }
  if (publication.process !== REQUIRED_PROCESS) {
    fail(422, "PUBLICATION_NOT_SEWING", `Only a ${REQUIRED_PROCESS} publication can become a Production execution basis.`);
  }
  if (publication.isCurrent !== true || publication.state === "SUPERSEDED") {
    fail(409, "PUBLICATION_NOT_CURRENT", "This PPC publication has been superseded by a later version.");
  }
  if (publication.state === "REFUSED" || publication.response?.state === "REFUSED") {
    fail(409, "PUBLICATION_REFUSED", "The receiving department refused this publication.");
  }
  if (publication.state !== "ACCEPTED" || publication.response?.state !== "ACCEPTED") {
    fail(409, "PUBLICATION_NOT_ACCEPTED", "The receiving department has not accepted this publication.");
  }

  const published = (publication.workOrders || []).find((w) => same(w?.workOrderId, workOrder._id));
  if (!published) fail(422, "PUBLICATION_WORK_ORDER_MISMATCH", "This publication does not name that work order.");

  const woLine = String(workOrder.salesLineLink?.lineRef ?? "");
  if (!woLine || woLine !== String(publication.orderLineRef ?? "") || String(published.lineRef ?? "") !== woLine) {
    fail(422, "SALES_LINE_MISMATCH", "The work order's permanent Sales line is not the line this publication was planned for.");
  }

  if (!publication.ieReleaseId || publication.ieReleaseVersionNo == null || !publication.ieReleaseRef) {
    fail(422, "IE_RELEASE_REFERENCE_INCOMPLETE", "The publication does not carry a complete frozen IE release reference.");
  }
  if (!release || !same(release.companyId, company) || !same(release._id, publication.ieReleaseId)) {
    fail(422, "IE_RELEASE_NOT_FOUND", "The IE release this publication names does not exist for your company.");
  }
  if (Number(release.versionNo) !== Number(publication.ieReleaseVersionNo) || release.releaseRef !== publication.ieReleaseRef) {
    fail(422, "IE_RELEASE_MISMATCH", "The IE release does not match the version the publication froze.");
  }
  if (release.state === "WITHDRAWN") fail(409, "IE_RELEASE_WITHDRAWN", "The IE release this publication names was withdrawn.");
  const problems = routeProblems(release.source?.rows);
  if (problems.length) fail(422, "FROZEN_ROUTE_UNUSABLE", "The IE release carries no usable frozen operation route.", { problems });

  const pubBooking = publication.capacityBooking;
  if (!pubBooking?.bookingId) fail(422, "CAPACITY_BOOKING_MISSING", "The publication names no capacity booking.");
  if (!booking || !same(booking.companyId, company) || !same(booking._id, pubBooking.bookingId)) {
    fail(422, "CAPACITY_BOOKING_NOT_FOUND", "The capacity booking the publication names does not exist for your company.");
  }
  if (booking.state !== "ACTIVE") fail(409, "CAPACITY_BOOKING_INACTIVE", "The capacity booking is no longer active.");
  if (Number(booking.generation) !== Number(pubBooking.generation) || booking.bookingRef !== pubBooking.bookingRef) {
    fail(409, "CAPACITY_BOOKING_STALE", "The capacity booking is not the generation the publication froze.");
  }
  if (!same(booking.planningFileId, publication.planningFileId)
    || String(booking.orderLineRef ?? "") !== String(publication.orderLineRef ?? "")
    || !same(booking.basis?.ieReleaseId, publication.ieReleaseId)) {
    fail(422, "CAPACITY_BOOKING_MISMATCH", "The capacity booking was made for a different plan, Sales line or IE release.");
  }
  if (!same(booking.lineId, pubBooking.lineId) || booking.lineRef !== pubBooking.lineRef) {
    fail(422, "CAPACITY_BOOKING_LINE_MISMATCH", "The capacity booking is for a different planning line than the publication.");
  }

  if (!line || !same(line.companyId, company) || !same(line._id, booking.lineId)) {
    fail(422, "CAPACITY_LINE_NOT_FOUND", "The planning line the booking names does not exist for your company.");
  }
  if (line.lineRef !== booking.lineRef) fail(422, "CAPACITY_BOOKING_LINE_MISMATCH", "The planning line reference does not match the booking.");
  if (line.status === "RETIRED") fail(409, "CAPACITY_LINE_RETIRED", "The planning line has been retired.");
  if (Number(line.revision) !== Number(booking.lineRevision)) {
    fail(409, "CAPACITY_LINE_REVISION_MISMATCH", "The planning line changed after the booking froze it; PPC must re-book.");
  }

  const publishedQty = Number(published.quantity);
  if (!Number.isInteger(publishedQty) || publishedQty < 1) {
    fail(422, "QUANTITY_UNPROVABLE", "The publication froze no quantity for this work order.");
  }
  const woQty = Number(workOrder.quantity);
  if (woQty !== publishedQty || woQty > Number(publication.confirmedQuantity)) {
    fail(422, "QUANTITY_INCOMPATIBLE", "The work order quantity differs from the quantity PPC published for it.", {
      workOrderQuantity: woQty, publishedQuantity: publishedQty, confirmedQuantity: publication.confirmedQuantity, rule: QUANTITY_RULE,
    });
  }

  return { published, executionQuantity: woQty };
}

/** The self-contained frozen snapshot. Every value copied, none referenced. */
function buildBasis({ companyId, workOrder, publication, release, booking, line, published, executionQuantity,
  versionNo, basisId, receiptKey, actor, now, supersedesBasisId = null, reasonNormalized = "" }) {
  const id = basisId instanceof mongoose.Types.ObjectId ? basisId : oid(basisId);
  const at = new Date(now);
  const who = { id: actor?.id && isObjectId(actor.id) ? oid(actor.id) : null, name: String(actor?.name ?? "").trim() };
  return {
    basisId: id,
    basisRef: `PEB-${idOf(workOrder._id).slice(-8)}-V${versionNo}`,
    versionNo,
    receiptKey,
    companyId: oid(companyId),
    workOrderId: oid(workOrder._id),
    workOrderNumber: String(workOrder.workOrderNumber ?? ""),
    customerRequestId: workOrder.customerRequestId ? oid(workOrder.customerRequestId) : null,
    orderLineRef: String(publication.orderLineRef),
    executionQuantity,
    quantityRule: QUANTITY_RULE,
    publication: {
      publicationId: oid(publication._id),
      publicationVersionNo: Number(publication.publicationVersionNo),
      publishedAt: new Date(publication.publishedAt),
      process: publication.process,
      stageId: String(publication.stageId),
      stageLabel: String(publication.stageLabel ?? ""),
      acceptedAt: publication.response?.at ? new Date(publication.response.at) : null,
      confirmedQuantity: Number(publication.confirmedQuantity),
      publishedWorkOrderQuantity: Number(published.quantity),
    },
    planning: {
      planningFileId: oid(publication.planningFileId),
      planningFileRef: String(publication.planningFileRef ?? ""),
      planningGeneration: publication.planningGeneration ?? null,
      scheduleVersionNo: Number(publication.scheduleVersionNo),
    },
    capacityBooking: {
      bookingId: oid(booking._id),
      bookingRef: String(booking.bookingRef),
      generation: Number(booking.generation),
      calendarVersionNo: booking.calendarVersionNo ?? null,
      windowStart: String(booking.windowStart),
      windowEnd: String(booking.windowEnd),
    },
    planningLine: {
      capacityLineId: oid(line._id),
      lineRef: String(line.lineRef),
      lineRevision: Number(booking.lineRevision),
      lineName: String(line.name ?? ""),
      factoryRefDisplay: String(line.factoryRef ?? ""),
      factoryRefAuthoritative: false,
    },
    ieRelease: {
      ieReleaseId: oid(release._id),
      releaseRef: String(release.releaseRef),
      versionNo: Number(release.versionNo),
      aggregateFingerprint: String(release.aggregateFingerprint ?? ""),
      sourceFingerprint: String(release.source?.sourceFingerprint ?? ""),
      bulletinVersionId: release.source?.bulletinVersionId ? oid(release.source.bulletinVersionId) : null,
      bulletinVersionNo: release.source?.bulletinVersionNo ?? null,
    },
    route: [...release.source.rows]
      .sort((a, b) => Number(a.sequence) - Number(b.sequence))
      .map((r) => ({
        rowId: String(r.rowId).trim(),
        sequence: Number(r.sequence),
        ieOperationId: oid(r.ieOperationId),
        ieOperationRevision: Number(r.ieOperationRevision),
        operationCode: String(r.operationCode).trim(),
        operationName: String(r.operationName ?? "").trim(),
        machineType: String(r.machineType ?? "").trim(),
        standardTimeMinutes: Number(r.standardTimeMinutes),
        standardTimeSource: String(r.standardTimeSource ?? "").trim(),
      })),
    plannedWindow: { start: String(publication.plannedStart), end: String(publication.plannedEnd) },
    receivedAt: at,
    receivedBy: who,
    supersedesBasisId: supersedesBasisId ? oid(supersedesBasisId) : null,
    receiptCommand: {
      kind: supersedesBasisId ? "supersede" : "receive",
      supersedesBasisId: supersedesBasisId ? oid(supersedesBasisId) : null,
      reasonNormalized: supersedesBasisId ? reasonNormalized : "",
    },
    state: BASIS_STATE.ACTIVE,
    effectiveFrom: at,
    effectiveUntil: null,
    supersededByBasisId: null,
    supersededAt: null,
    supersedeReason: "",
    history: [{ type: "RECEIVED", at, actor: who, note: supersedesBasisId ? `Successor of ${idOf(supersedesBasisId)}` : "" }],
  };
}

const timeOf = (v) => (v == null ? NaN : new Date(v).getTime());

/** The basis that was in force at `asOf`: effectiveFrom ≤ asOf < effectiveUntil. */
function basisAt(bases, asOf) {
  const t = timeOf(asOf);
  if (!Number.isFinite(t)) return null;
  const hits = (bases || []).filter((b) => timeOf(b.effectiveFrom) <= t && (b.effectiveUntil == null || t < timeOf(b.effectiveUntil)));
  if (hits.length !== 1) return null; // none, or an impossible overlap: never pick one
  return hits[0];
}

const activeBasisOf = (bases) => (bases || []).find((b) => b.state === BASIS_STATE.ACTIVE) || null;

/** A successor must continue the SAME PPC chain with a later version. */
function assertSuccessorOf(active, publication) {
  if (!same(active.planning?.planningFileId, publication.planningFileId)
    || String(active.publication?.stageId) !== String(publication.stageId)
    || !(Number(publication.publicationVersionNo) > Number(active.publication?.publicationVersionNo))) {
    fail(409, "EXECUTION_BASIS_SUCCESSOR_INVALID",
      "A successor must be a later version of the same PPC stage publication the active basis was received from.");
  }
}

/** Trim and collapse internal whitespace: "a  b\n c " and "a b c" are one reason. */
const normalizeReason = (reason) => String(reason ?? "").trim().replace(/\s+/g, " ");

/**
 * Is this request the SAME command that created `basis`? Company, WorkOrder
 * and publication are already equal — they make up the receipt key. What is
 * left is the command itself: receive vs supersede, the predecessor named and
 * the normalised reason. The actor may differ (a delivery retry).
 */
function sameCommand(basis, { kind, supersedesBasisId = null, reasonNormalized = "" }) {
  const stored = basis.receiptCommand || {
    kind: basis.supersedesBasisId ? "supersede" : "receive",
    supersedesBasisId: basis.supersedesBasisId ?? null,
    reasonNormalized: null, // pre-dates the record: cannot be proved equal
  };
  if (stored.kind !== kind) return false;
  if (kind === "receive") return true;
  return idOf(stored.supersedesBasisId) === idOf(supersedesBasisId)
    && stored.reasonNormalized === reasonNormalized;
}

/** What an API response carries: never the whole frozen route. */
function summarise(basis, { reused = false } = {}) {
  return {
    executionBasisId: idOf(basis.basisId),
    basisRef: basis.basisRef,
    versionNo: basis.versionNo,
    state: basis.state,
    reused,
    workOrder: { workOrderId: idOf(basis.workOrderId), workOrderNumber: basis.workOrderNumber, orderLineRef: basis.orderLineRef },
    companyId: idOf(basis.companyId),
    planningLineScope: {
      capacityLineId: idOf(basis.planningLine.capacityLineId),
      lineRef: basis.planningLine.lineRef,
      revision: basis.planningLine.lineRevision,
      factoryRefDisplay: basis.planningLine.factoryRefDisplay,
      factoryRefAuthoritative: false,
    },
    siteScope: { status: "not_modelled" },
    physicalLineMapping: { status: "unavailable" },
    sources: {
      publication: { publicationId: idOf(basis.publication.publicationId), versionNo: basis.publication.publicationVersionNo },
      planning: { planningFileId: idOf(basis.planning.planningFileId), generation: basis.planning.planningGeneration, scheduleVersionNo: basis.planning.scheduleVersionNo },
      capacityBooking: { bookingId: idOf(basis.capacityBooking.bookingId), bookingRef: basis.capacityBooking.bookingRef, generation: basis.capacityBooking.generation },
      ieRelease: { ieReleaseId: idOf(basis.ieRelease.ieReleaseId), releaseRef: basis.ieRelease.releaseRef, versionNo: basis.ieRelease.versionNo, aggregateFingerprint: basis.ieRelease.aggregateFingerprint },
    },
    executionQuantity: basis.executionQuantity,
    plannedWindow: basis.plannedWindow,
    operationCount: (basis.route || []).length,
    receivedAt: new Date(basis.receivedAt).toISOString(),
    effectiveFrom: new Date(basis.effectiveFrom).toISOString(),
    effectiveUntil: basis.effectiveUntil ? new Date(basis.effectiveUntil).toISOString() : null,
    supersedesBasisId: idOf(basis.supersedesBasisId),
    supersededByBasisId: idOf(basis.supersededByBasisId),
  };
}

module.exports = {
  REQUIRED_PROCESS,
  QUANTITY_RULE,
  BASIS_LIMITS,
  ExecutionBasisError,
  receiptKeyOf,
  routeProblems,
  assertEligible,
  assertSuccessorOf,
  buildBasis,
  basisAt,
  activeBasisOf,
  summarise,
  normalizeReason,
  sameCommand,
  isObjectId,
};
