// services/sales/changeNotice.service.js
//
// SALES ISSUES A CHANGE. NOBODY ELSE CAN.
//
// The M7 producer, and deliberately the same shape as
// `merchandisingHandover.service.js`: live Sales authority, a typed payload,
// a versioned immutable record, and an audit row plus an outbox row written in
// the SAME transaction as the version — so a commercial statement and its
// announcement cannot exist without each other.
//
// ── WHAT THIS SERVICE WILL NOT CARRY ────────────────────────────────────────
// The forbidden-field check is not decoration. Merchandising executes a
// confirmed requirement; it does not need — and must never store, render or
// export — the buyer conversation that produced it, the price, the margin or
// the payment terms. `strict: true` on the schema means those cannot persist;
// this check means a caller is TOLD, naming the field and whose record it
// belongs to, rather than watching it silently vanish and believing it landed.
//
// ── AND WHY IT WRITES NO MERCHANDISING RECORD ───────────────────────────────
// Not one import from `models/CMS_Models/Merchandising/` appears here, and a
// test scans for it. Sales announces; Merchandising's own receiver applies.
// The same inversion M1 established, for the same reason: a producer that
// could reach into the receiver's tables would make the receiver's rules
// advisory.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const {
  SalesChangeNotice, NOTICE_STATE, CHANGE_KIND, FORBIDDEN_FIELDS,
} = require("../../models/CMS_Models/Sales/SalesChangeNotice");
const {
  SalesHandoverAuditEvent, SalesHandoverOutboxEvent,
} = require("../../models/CMS_Models/Sales/SalesHandoverEvent");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

/** The event kinds Sales publishes about a change. */
const CHANGE_EVENT_KINDS = Object.freeze({
  ISSUED: "sales.change_notice.issued",
  SUPERSEDED: "sales.change_notice.superseded",
  CANCELLED: "sales.change_notice.cancelled",
});

/* ── `before` IS NOT SENT, IT IS DERIVED ──────────────────────────────────
   The previous confirmed requirement is a FACT — it is whatever the current
   accepted handover version says. Letting a caller state it would let Sales
   misdescribe what Merchandising is currently executing, and the before/after
   a merchandiser compares would be two claims rather than a fact and a claim.

   So `before` is read from the handover version inside this service, and a
   caller who sends one is refused by name. */
const ISSUE_FIELDS = Object.freeze([
  "changeKind", "after", "reasonCode", "reason", "effectiveFrom",
  "expectedCurrentVersionNo", "idempotencyKey",
]);

/** The 14 fields the typed projection holds — nothing else is a safe fact. */
const PROJECTION_FIELDS = Object.freeze([
  "orderRef", "orderLineRef", "styleRef", "buyerStyleRef", "productName",
  "buyerDisplayLabel", "brandDisplayLabel", "totalQuantity", "breakdown",
  "deliveries", "allocations", "packingRequirement", "testingRequirement",
  "deliveryRequirement",
]);

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

/**
 * Refuse a forbidden field by name, and say whose it is.
 *
 * Walks the whole body, not just the top level: a buyer message nested inside
 * `after` is the same leak as one at the root, and a check that only looked at
 * the surface would be a check somebody could route around by accident.
 */
function assertNoForbiddenFields(value, path = "") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoForbiddenFields(v, `${path}[${i}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const owner = FORBIDDEN_FIELDS[key];
    if (owner) {
      throw fail("CHANGE_FIELD_NOT_ALLOWED",
        `"${key}" cannot travel on a change notice — it is ${owner}.`,
        { field: path ? `${path}.${key}` : key, belongsTo: owner });
    }
    assertNoForbiddenFields(child, path ? `${path}.${key}` : key);
  }
}

/**
 * Keep only the projection's own fields. Anything else was never a safe fact.
 *
 * A change carries a COMPLETE projection on each side, not a patch. Two
 * reasons. The typed schema requires the fields that make a requirement
 * executable — an order reference, a style, a product, at least one delivery
 * commitment — and a partial would have to relax those, which is exactly the
 * loosening M2.1 tightened. And a merchandiser comparing two complete
 * statements sees what the requirement now IS; a patch would have to be
 * applied in their head against a record they cannot see from here.
 */
function shapeProjection(value, side, { strict = true } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw fail("VALIDATION", `"${side}" must be an execution projection.`, { field: side });
  }
  /* Our OWN stored projection is trimmed, not refused: it may carry a
     subdocument `_id` that mongoose put there, and refusing our own record
     would make issuing a change impossible for reasons the caller cannot fix.
     A CALLER's projection is refused, because a field they meant to send and
     that silently disappeared is worse than a refusal. */
  const unexpected = Object.keys(value).filter((k) => !PROJECTION_FIELDS.includes(k));
  if (unexpected.length && strict) {
    /* Reported rather than stripped: a field somebody meant to send and that
       silently disappeared is worse than a refusal. */
    throw fail("CHANGE_FIELD_NOT_ALLOWED",
      `"${unexpected[0]}" is not part of the confirmed execution projection, so it cannot travel `
      + "on a change notice.",
      { field: `${side}.${unexpected[0]}`, allowed: PROJECTION_FIELDS });
  }
  return Object.fromEntries(PROJECTION_FIELDS
    .filter((f) => value[f] !== undefined)
    .map((f) => [f, value[f]]));
}

function assertShape(body) {
  const unexpected = Object.keys(body || {}).filter((k) => !ISSUE_FIELDS.includes(k));
  if (unexpected.length) {
    const owner = FORBIDDEN_FIELDS[unexpected[0]];
    throw fail("CHANGE_FIELD_NOT_ALLOWED",
      owner
        ? `"${unexpected[0]}" cannot travel on a change notice — it is ${owner}.`
        : `"${unexpected[0]}" is not a field a change notice carries.`,
      { field: unexpected[0], allowed: ISSUE_FIELDS });
  }
}

/* ═══ ISSUE ════════════════════════════════════════════════════════════════ */

/**
 * Issue a change against a confirmed, handed-over order line.
 *
 * A change to a line Merchandising has never seen is not a change — it is the
 * original requirement, and it goes through the handover. So this refuses
 * unless an accepted handover version exists for the line.
 */
async function issue(scope, { requestId, lineId, body = {}, actor = null } = {}) {
  if (!scope?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
  assertShape(body);
  assertNoForbiddenFields(body);

  const changeKind = str(body.changeKind).toUpperCase();
  if (!Object.values(CHANGE_KIND).includes(changeKind)) {
    throw fail("VALIDATION", "Say what kind of change this is.",
      { field: "changeKind", allowed: Object.values(CHANGE_KIND) });
  }
  const reason = str(body.reason);
  if (reason.length < 15) {
    throw fail("VALIDATION",
      "A change reaches a merchandiser who has to act on it, so say enough to act on.",
      { field: "reason", minimum: 15 });
  }

  if (!isId(requestId)) throw fail("NOT_FOUND", "That order does not exist.");
  const request = await CustomerRequest.findById(requestId).lean();
  if (!request) throw fail("NOT_FOUND", "That order does not exist.");

  const line = (request.items || []).find((i) => str(i.lineRef) === str(lineId));
  if (!line) {
    throw fail("NOT_FOUND",
      "That order line does not exist, or has no permanent line reference yet.",
      { lineId: str(lineId) });
  }

  /* The line must already be with Merchandising. */
  const handoverRef = str(request.requestId);
  const handoverLineRef = str(line.lineRef);
  const handover = await SalesChangeNoticeHandover(scope.companyId, handoverRef, handoverLineRef);
  if (!handover) {
    throw fail("CHANGE_STATE_CONFLICT",
      "This line has never been handed to Merchandising, so there is nothing to change. "
      + "Issue the handover instead.",
      { handoverRef, handoverLineRef });
  }

  /* The requirement as it stands — read, not accepted from the caller. */
  const before = handover.executionProjection
    ? shapeProjection(
      JSON.parse(JSON.stringify(handover.executionProjection)), "before", { strict: false },
    )
    : null;

  const after = shapeProjection(body.after, "after");
  if (!after) {
    throw fail("VALIDATION",
      "State the confirmed requirement as it now stands. A change carries the whole projection, "
      + "not the fields that moved — see the notice model for why.",
      { field: "after", required: PROJECTION_FIELDS });
  }

  return withTxn(async (session) => {
    /* ── VERSION NUMBERING, AND THE CHANGE'S STABLE IDENTITY ─────────────
       A change against a line that already has an open one is a NEW VERSION of
       that change, not a second change: a merchandiser who assessed version 1
       must see version 2 as a revision of the thing they already looked at. */
    const open = await SalesChangeNotice.findOne({
      companyId: scope.companyId, handoverRef, handoverLineRef, state: NOTICE_STATE.ISSUED,
    }).sort({ versionNo: -1 }).session(session);

    const changeRef = open?.changeRef || `CHG-${crypto.randomBytes(6).toString("hex")}`;

    if (body.expectedCurrentVersionNo !== undefined) {
      const expected = Number(body.expectedCurrentVersionNo);
      const actual = open?.versionNo ?? 0;
      if (expected !== actual) {
        throw fail("REVISION_CONFLICT",
          "Somebody else changed this line while you were working. Reload and try again.",
          { expected, actual });
      }
    }

    /* Counted from the highest EVER issued for this ref, so a cancelled
       version 2 leaves the next at 3 and "version 2" means one thing. */
    const highest = await SalesChangeNotice.findOne({ companyId: scope.companyId, changeRef })
      .sort({ versionNo: -1 }).select("versionNo").session(session).lean();
    const versionNo = (highest?.versionNo ?? 0) + 1;

    const at = new Date();
    const correlationId = crypto.randomUUID();
    const events = [];

    /* Step the previous version down BEFORE creating the successor: the
       partial unique index allows one ISSUED version and is checked as each
       write lands, not at commit. */
    if (open) {
      open.state = NOTICE_STATE.SUPERSEDED;
      open.supersededAt = at;
      await open.save({ session });
      events.push({
        companyId: scope.companyId,
        kind: CHANGE_EVENT_KINDS.SUPERSEDED,
        occurredAt: at,
        actor: actor || undefined,
        correlationId,
        payload: {
          changeRef, versionNo: open.versionNo,
          handoverRef, handoverLineRef,
          supersededByVersionNo: versionNo,
        },
      });
    }

    const [notice] = await SalesChangeNotice.create([{
      companyId: scope.companyId,
      changeRef,
      versionNo,
      handoverRef,
      handoverLineRef,
      state: NOTICE_STATE.ISSUED,
      changeKind,
      before,
      after,
      reasonCode: str(body.reasonCode).slice(0, 80),
      reason: reason.slice(0, 2000),
      /* Sales' own authority, stamped from the resolved actor. Never
         body-authored — the route refuses the field by name. */
      authorisedBy: actor || undefined,
      authorisedAt: at,
      effectiveFrom: str(body.effectiveFrom) || null,
      supersedesVersionId: open?._id || null,
    }], { session });

    if (open) {
      open.supersededByVersionId = notice._id;
      await open.save({ session });
    }

    events.push({
      companyId: scope.companyId,
      kind: CHANGE_EVENT_KINDS.ISSUED,
      occurredAt: at,
      actor: actor || undefined,
      correlationId,
      payload: {
        changeRef, versionNo, handoverRef, handoverLineRef,
        changeKind, noticeId: notice._id,
        ...(open ? { supersedesVersionNo: open.versionNo } : {}),
      },
    });

    await SalesHandoverAuditEvent.create([{
      companyId: scope.companyId,
      handoverRef,
      handoverLineRef,
      /* The audit row's `versionNo` is the CHANGE's version — this trail
         carries handovers and changes side by side, and each row's version is
         the version of whatever it is about. */
      versionNo,
      action: CHANGE_EVENT_KINDS.ISSUED,
      actor: actor || undefined,
      at,
      reason: reason.slice(0, 1000),
      correlationId,
      changeRef,
      noticeId: notice._id,
      changeKind,
    }], { session, ordered: true });

    await SalesHandoverOutboxEvent.create(events, { session, ordered: true });

    return { notice: noticeView(notice), correlationId };
  });
}

/** Has this line ever been handed over? A change presumes it has. */
async function SalesChangeNoticeHandover(companyId, handoverRef, handoverLineRef) {
  return SalesHandoverVersion.findOne({ companyId, handoverRef, handoverLineRef })
    .sort({ versionNo: -1 }).lean();
}

/* ═══ CANCEL ═══════════════════════════════════════════════════════════════ */

/**
 * Withdraw a change Sales no longer wants executed.
 *
 * Not a deletion: the version stays, its state moves, and Merchandising's
 * receiver mirrors it. What Merchandising already assessed against it stays
 * readable, because the assessment happened and the record of it is history.
 */
async function cancel(scope, { changeRef, body = {}, actor = null } = {}) {
  if (!scope?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
  const reason = str(body?.reason);
  if (reason.length < 10) {
    throw fail("VALIDATION", "Say why this change is being withdrawn.", { field: "reason" });
  }

  return withTxn(async (session) => {
    const notice = await SalesChangeNotice.findOne({
      companyId: scope.companyId, changeRef: str(changeRef), state: NOTICE_STATE.ISSUED,
    }).session(session);
    if (!notice) {
      throw fail("CHANGE_NOT_FOUND", "There is no open version of that change to withdraw.");
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    notice.state = NOTICE_STATE.CANCELLED;
    notice.cancelledAt = at;
    notice.cancellationReason = reason.slice(0, 2000);
    await notice.save({ session });

    await SalesHandoverAuditEvent.create([{
      companyId: scope.companyId,
      handoverRef: notice.handoverRef,
      handoverLineRef: notice.handoverLineRef,
      versionNo: notice.versionNo,
      action: CHANGE_EVENT_KINDS.CANCELLED,
      actor: actor || undefined,
      at,
      reason: reason.slice(0, 1000),
      correlationId,
      changeRef: notice.changeRef,
      noticeId: notice._id,
      changeKind: notice.changeKind,
    }], { session, ordered: true });

    await SalesHandoverOutboxEvent.create([{
      companyId: scope.companyId,
      kind: CHANGE_EVENT_KINDS.CANCELLED,
      occurredAt: at,
      actor: actor || undefined,
      correlationId,
      payload: {
        changeRef: notice.changeRef, versionNo: notice.versionNo,
        handoverRef: notice.handoverRef, handoverLineRef: notice.handoverLineRef,
        reason: reason.slice(0, 500),
      },
    }], { session, ordered: true });

    return { notice: noticeView(notice), correlationId };
  });
}

/* ═══ READS ════════════════════════════════════════════════════════════════ */

const noticeView = (n) => (n ? {
  id: str(n._id),
  changeRef: str(n.changeRef),
  versionNo: n.versionNo,
  state: str(n.state),
  changeKind: str(n.changeKind),
  handoverRef: str(n.handoverRef),
  handoverLineRef: str(n.handoverLineRef),
  before: n.before || null,
  after: n.after || null,
  reasonCode: str(n.reasonCode),
  reason: str(n.reason),
  authorisedByName: str(n.authorisedBy?.name),
  authorisedAt: n.authorisedAt || null,
  effectiveFrom: n.effectiveFrom || null,
  supersededByVersionId: n.supersededByVersionId ? str(n.supersededByVersionId) : null,
  supersededAt: n.supersededAt || null,
  cancelledAt: n.cancelledAt || null,
  cancellationReason: str(n.cancellationReason),
  createdAt: n.createdAt || null,
} : null);

async function listForLine(scope, { handoverRef, handoverLineRef, limit = 25 } = {}) {
  const rows = await SalesChangeNotice.find({
    companyId: scope.companyId, handoverRef: str(handoverRef), handoverLineRef: str(handoverLineRef),
  }).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 25, 100)).lean();
  return { rows: rows.map(noticeView) };
}

/** Pending announcements, oldest first by when Sales ACTED. */
async function pendingOutboxEvents({ companyId, limit = 100 } = {}) {
  const query = { status: "PENDING", kind: { $in: Object.values(CHANGE_EVENT_KINDS) } };
  if (companyId) query.companyId = companyId;
  return SalesHandoverOutboxEvent.find(query)
    .sort({ occurredAt: 1, _id: 1 }).limit(Math.min(Number(limit) || 100, 500)).lean();
}

module.exports = {
  CHANGE_EVENT_KINDS, ISSUE_FIELDS, PROJECTION_FIELDS,
  assertNoForbiddenFields, shapeProjection, assertShape,
  issue, cancel, noticeView, listForLine, pendingOutboxEvents,
};
