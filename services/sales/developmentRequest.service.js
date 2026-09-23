// services/sales/developmentRequest.service.js
//
// SALES ASKS MERCHANDISING TO SELECT MATERIALS. NOBODY ELSE CAN.
//
// The pre-order producer, and deliberately the same shape as
// `merchandisingHandover.service.js`: live Sales authority, a declared
// payload, a versioned immutable record, and an audit row plus an outbox row
// written in the SAME transaction as the version.
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
// A Sales-authenticated form on the sample style that wrote
// `materials.rawItems` directly. That made material selection a side effect of
// a Sales screen — no request, no version, no acceptance, no audit of who
// asked, and no way for R&D to know whether what they were reading was what
// Sales had asked for. The legacy route still answers for the styles that
// depend on it; nothing new goes through it.
//
// ── AND WHY IT WRITES NO MERCHANDISING RECORD ───────────────────────────────
// Not one import from `models/CMS_Models/Merchandising/` appears here, and a
// test scans for it. Sales asks; Merchandising's own receiver opens the file.
// Sales cannot create or edit a Development File, which is the whole reason
// the request is a record rather than a function call.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const {
  SalesDevelopmentRequest, REQUEST_STATE, MATERIAL_CATEGORY, FORBIDDEN_FIELDS,
} = require("../../models/CMS_Models/Sales/DevelopmentRequest");
const {
  SalesHandoverAuditEvent, SalesHandoverOutboxEvent,
} = require("../../models/CMS_Models/Sales/SalesHandoverEvent");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

/** The event kinds Sales publishes about a development request. */
const DEVELOPMENT_EVENT_KINDS = Object.freeze({
  ISSUED: "sales.development_request.issued",
  SUPERSEDED: "sales.development_request.superseded",
  CANCELLED: "sales.development_request.cancelled",
  RELEASED: "sales.development_release.authorised",
});

/** Only these may be sent. Everything else is refused by name. */
const ISSUE_FIELDS = Object.freeze([
  "requirementSummary", "requestedCategories", "requiredByDate",
  "referenceImages", "styleRef", "sampleStyleId", "stockItemId",
  "expectedCurrentVersionNo", "idempotencyKey",
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
 * Refuse a forbidden field by name, and say why it stays in Sales.
 *
 * Walks the whole body: an opportunity value nested inside a reference image
 * is the same leak as one at the root.
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
      throw fail("DEVELOPMENT_FIELD_NOT_ALLOWED",
        `"${key}" cannot travel on a development request — it is ${owner}.`,
        { field: path ? `${path}.${key}` : key, belongsTo: owner });
    }
    assertNoForbiddenFields(child, path ? `${path}.${key}` : key);
  }
}

function assertShape(body) {
  const unexpected = Object.keys(body || {}).filter((k) => !ISSUE_FIELDS.includes(k));
  if (unexpected.length) {
    const owner = FORBIDDEN_FIELDS[unexpected[0]];
    throw fail("DEVELOPMENT_FIELD_NOT_ALLOWED",
      owner
        ? `"${unexpected[0]}" cannot travel on a development request — it is ${owner}.`
        : `"${unexpected[0]}" is not a field a development request carries.`,
      { field: unexpected[0], allowed: ISSUE_FIELDS });
  }
}

/**
 * The buyer's display label, from the account. A name to show, not a key.
 *
 * The account is reached THROUGH a journey that was already resolved inside a
 * company, so its own clause is stated rather than inherited — an id that came
 * from a scoped record is still an id, and reading it without saying which
 * company it belongs to is how a cross-tenant read looks the moment somebody
 * calls this with a journey from somewhere else.
 */
async function buyerLabelFor(journey) {
  if (!journey?.accountId || !journey?.companyId) return "";
  const companyClause = { companyId: journey.companyId };
  const account = await Account
    .findOne({ ...companyClause, _id: journey.accountId }).select("companyName").lean();
  return str(account?.companyName);
}

/**
 * Resolve the product line a request is about.
 *
 * By its PERMANENT reference, never by position or product name — see
 * `enquiryProductLineIdentity.js` for why. A line with no reference yet is
 * given one by the enquiry's own pre-validate hook the next time it saves,
 * so this refuses rather than inventing one here.
 */
/**
 * Every product line on a Journey, by its PERMANENT reference.
 *
 * The Sales surface needs this to offer "send to Merchandising" against a line
 * nobody has asked about yet, and it must offer them by reference rather than
 * by name: two enquiries on one Journey can both carry a line called "Oxford
 * shirt", and a name is edited by the person who typed it. A line with no
 * reference yet is returned with an empty one and the caller offers no button
 * for it, which is honest — there is nothing stable to send.
 */
async function listProductLines(scope, { journeyId } = {}) {
  if (!scope?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
  if (!isId(journeyId)) throw fail("NOT_FOUND", "That Sales Journey does not exist.");
  const companyClause = { companyId: scope.companyId };
  const journey = await SalesJourney.findOne({ ...companyClause, _id: journeyId }).lean();
  if (!journey) throw fail("NOT_FOUND", "That Sales Journey does not exist.");

  const enquiries = await Enquiry.find({ ...companyClause, journeyId: journey._id })
    .sort({ createdAt: 1 }).lean();

  const lines = [];
  for (const enquiry of enquiries) {
    for (const p of enquiry.products || []) {
      lines.push({
        /* `product` is the enquiry's own field name and is required there, so
           a line always has something to call it. `issue` copies the same
           field onto the request — one name for one fact. */
        productLineRef: str(p.productLineRef),
        productName: str(p.product) || "Unnamed product",
        styleRef: str(p.styleCode) || str(p.styleReference),
        enquiryRef: str(enquiry.enquiryId),
        referenceImageCount: Array.isArray(p.images) ? p.images.length : 0,
      });
    }
  }
  return { journeyRef: str(journey.journeyId), lines };
}

async function resolveProductLine(companyId, { journeyId, productLineRef }) {
  if (!isId(journeyId)) throw fail("NOT_FOUND", "That Sales Journey does not exist.");
  const companyClause = { companyId };
  const journey = await SalesJourney.findOne({ ...companyClause, _id: journeyId }).lean();
  if (!journey) throw fail("NOT_FOUND", "That Sales Journey does not exist.");

  const enquiries = await Enquiry.find({ ...companyClause, journeyId: journey._id }).lean();
  for (const enquiry of enquiries) {
    const line = (enquiry.products || []).find((p) => str(p.productLineRef) === str(productLineRef));
    if (line) return { journey, enquiry, line };
  }
  throw fail("PRODUCT_LINE_NOT_FOUND",
    "That product line is not on this Journey, or has no permanent reference yet.",
    { productLineRef: str(productLineRef) });
}

/* ═══ ISSUE ════════════════════════════════════════════════════════════════ */

/**
 * Ask Merchandising to select materials for one Journey product line.
 *
 * A second request against a line that already has an open one is a NEW
 * VERSION of that request — the buyer changed the brief, and a merchandiser
 * who accepted version 1 must see version 2 as a revision of the thing they
 * already looked at.
 */
async function issue(scope, { journeyId, productLineRef, body = {}, actor = null } = {}) {
  if (!scope?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
  assertShape(body);
  assertNoForbiddenFields(body);

  const summary = str(body.requirementSummary);
  if (summary.length < 15) {
    throw fail("VALIDATION",
      "A merchandiser has to select materials from this, so say what is wanted.",
      { field: "requirementSummary", minimum: 15 });
  }

  const categories = (Array.isArray(body.requestedCategories) ? body.requestedCategories : [])
    .map((c) => str(c).toUpperCase());
  if (!categories.length) {
    throw fail("VALIDATION", "Say which materials Merchandising should select.",
      { field: "requestedCategories", allowed: Object.values(MATERIAL_CATEGORY) });
  }
  const badCategory = categories.find((c) => !Object.values(MATERIAL_CATEGORY).includes(c));
  if (badCategory) {
    throw fail("VALIDATION", `"${badCategory}" is not a material category.`,
      { field: "requestedCategories", allowed: Object.values(MATERIAL_CATEGORY) });
  }

  const { journey, enquiry, line } = await resolveProductLine(scope.companyId, {
    journeyId, productLineRef,
  });
  const buyerDisplayLabel = await buyerLabelFor(journey);

  /* A named sample style must belong to this journey — a request pointing at
     somebody else's style would open a Development File on the wrong work. */
  let sampleStyle = null;
  if (isId(body.sampleStyleId)) {
    sampleStyle = await SampleStyle.findById(body.sampleStyleId).select("journeyId styleCode").lean();
    if (!sampleStyle || str(sampleStyle.journeyId) !== str(journey._id)) {
      throw fail("NOT_FOUND", "That sample style is not on this Journey.", { field: "sampleStyleId" });
    }
  }

  return withTxn(async (session) => {
    const open = await SalesDevelopmentRequest.findOne({
      companyId: scope.companyId,
      journeyId: journey._id,
      productLineRef: str(productLineRef),
      state: REQUEST_STATE.ISSUED,
    }).session(session);

    const requestRef = open?.requestRef || `DRQ-${crypto.randomBytes(6).toString("hex")}`;

    if (body.expectedCurrentVersionNo !== undefined) {
      const expected = Number(body.expectedCurrentVersionNo);
      const actual = open?.versionNo ?? 0;
      if (expected !== actual) {
        throw fail("REVISION_CONFLICT",
          "Somebody else changed this request while you were working. Reload and try again.",
          { expected, actual });
      }
    }

    /* Counted from the highest EVER issued, so a cancelled version 2 leaves
       the next at 3 and "version 2" means one thing for ever. */
    const highest = await SalesDevelopmentRequest
      .findOne({ companyId: scope.companyId, requestRef })
      .sort({ versionNo: -1 }).select("versionNo").session(session).lean();
    const versionNo = (highest?.versionNo ?? 0) + 1;

    const at = new Date();
    const correlationId = crypto.randomUUID();
    const events = [];

    /* Step the previous version down BEFORE creating the successor: the
       partial unique indexes are checked as each write lands. */
    if (open) {
      open.state = REQUEST_STATE.SUPERSEDED;
      open.supersededAt = at;
      await open.save({ session });
      events.push({
        companyId: scope.companyId,
        kind: DEVELOPMENT_EVENT_KINDS.SUPERSEDED,
        occurredAt: at,
        actor: actor || undefined,
        correlationId,
        payload: {
          requestRef, requestVersionNo: open.versionNo,
          journeyId: journey._id, productLineRef: str(productLineRef),
          supersededByVersionNo: versionNo,
        },
      });
    }

    const [request] = await SalesDevelopmentRequest.create([{
      companyId: scope.companyId,
      requestRef,
      versionNo,
      journeyId: journey._id,
      journeyRef: str(journey.journeyId),
      enquiryId: enquiry._id,
      productLineRef: str(productLineRef),
      state: REQUEST_STATE.ISSUED,
      buyerDisplayLabel,
      accountRef: str(journey.accountId),
      productName: str(line.product) || "Unnamed product",
      styleRef: str(body.styleRef) || str(sampleStyle?.styleCode),
      sampleStyleId: sampleStyle?._id || null,
      stockItemId: isId(body.stockItemId) ? body.stockItemId : (line.stockItemId || null),
      referenceImages: (Array.isArray(body.referenceImages) ? body.referenceImages : [])
        .slice(0, 20)
        .map((i) => ({ url: str(i?.url), caption: str(i?.caption).slice(0, 200) }))
        .filter((i) => i.url),
      requirementSummary: summary.slice(0, 4000),
      requestedCategories: [...new Set(categories)],
      requiredByDate: str(body.requiredByDate) || null,
      /* Sales' own authority, stamped from the resolved actor. Never
         body-authored — the field is not in ISSUE_FIELDS. */
      requestedBy: actor || undefined,
      requestedAt: at,
      supersedesVersionId: open?._id || null,
    }], { session });

    if (open) {
      open.supersededByVersionId = request._id;
      await open.save({ session });
    }

    events.push({
      companyId: scope.companyId,
      kind: DEVELOPMENT_EVENT_KINDS.ISSUED,
      occurredAt: at,
      actor: actor || undefined,
      correlationId,
      payload: {
        requestRef, requestVersionNo: versionNo,
        journeyId: journey._id, productLineRef: str(productLineRef),
        requestId: request._id,
        ...(open ? { supersedesVersionNo: open.versionNo } : {}),
      },
    });

    await SalesHandoverAuditEvent.create([{
      companyId: scope.companyId,
      handoverRef: str(journey.journeyId) || str(journey._id),
      handoverLineRef: str(productLineRef),
      versionNo,
      action: DEVELOPMENT_EVENT_KINDS.ISSUED,
      actor: actor || undefined,
      at,
      reason: summary.slice(0, 1000),
      correlationId,
      changeRef: requestRef,
      noticeId: request._id,
    }], { session, ordered: true });

    await SalesHandoverOutboxEvent.create(events, { session, ordered: true });

    return { request: requestView(request), correlationId };
  });
}

/* ═══ CANCEL ═══════════════════════════════════════════════════════════════ */

/** Withdraw the request. The version stays; Merchandising's receiver mirrors it. */
async function cancel(scope, { requestRef, body = {}, actor = null } = {}) {
  if (!scope?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
  const reason = str(body?.reason);
  if (reason.length < 10) {
    throw fail("VALIDATION", "Say why this request is being withdrawn.", { field: "reason" });
  }

  return withTxn(async (session) => {
    const request = await SalesDevelopmentRequest.findOne({
      companyId: scope.companyId, requestRef: str(requestRef), state: REQUEST_STATE.ISSUED,
    }).session(session);
    if (!request) {
      throw fail("DEVELOPMENT_REQUEST_NOT_FOUND",
        "There is no open version of that development request to withdraw.");
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    request.state = REQUEST_STATE.CANCELLED;
    request.cancelledAt = at;
    request.cancellationReason = reason.slice(0, 2000);
    await request.save({ session });

    await SalesHandoverAuditEvent.create([{
      companyId: scope.companyId,
      handoverRef: str(request.journeyRef) || str(request.journeyId),
      handoverLineRef: str(request.productLineRef),
      versionNo: request.versionNo,
      action: DEVELOPMENT_EVENT_KINDS.CANCELLED,
      actor: actor || undefined,
      at,
      reason: reason.slice(0, 1000),
      correlationId,
      changeRef: request.requestRef,
      noticeId: request._id,
    }], { session, ordered: true });

    await SalesHandoverOutboxEvent.create([{
      companyId: scope.companyId,
      kind: DEVELOPMENT_EVENT_KINDS.CANCELLED,
      occurredAt: at,
      actor: actor || undefined,
      correlationId,
      payload: {
        requestRef: request.requestRef, requestVersionNo: request.versionNo,
        journeyId: request.journeyId, productLineRef: request.productLineRef,
        reason: reason.slice(0, 500),
      },
    }], { session, ordered: true });

    return { request: requestView(request), correlationId };
  });
}

/* ═══ RELEASE ══════════════════════════════════════════════════════════════ */

/**
 * SALES AUTHORISES ONWARD DEVELOPMENT.
 *
 * The step that sends an approved selection to R&D, and it is deliberately
 * Sales'. Merchandising approving the selection says the materials are
 * settled; releasing says the buyer relationship justifies spending the
 * development budget on sampling — and that is a commercial judgement
 * Merchandising does not make.
 *
 * Sales does not touch the Development File to do it. It publishes, and
 * Merchandising's own receiver mirrors the release onto the file.
 */
async function authoriseRelease(scope, { requestRef, body = {}, actor = null } = {}) {
  if (!scope?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
  const request = await SalesDevelopmentRequest.findOne({
    companyId: scope.companyId, requestRef: str(requestRef), state: REQUEST_STATE.ISSUED,
  }).lean();
  if (!request) {
    throw fail("DEVELOPMENT_REQUEST_NOT_FOUND", "There is no open development request with that reference.");
  }

  const at = new Date();
  const correlationId = crypto.randomUUID();
  const releaseReference = `REL-${crypto.randomBytes(5).toString("hex")}`;

  await SalesHandoverOutboxEvent.create([{
    companyId: scope.companyId,
    kind: DEVELOPMENT_EVENT_KINDS.RELEASED,
    occurredAt: at,
    actor: actor || undefined,
    correlationId,
    payload: {
      requestRef: request.requestRef,
      requestVersionNo: request.versionNo,
      journeyId: request.journeyId,
      productLineRef: request.productLineRef,
      releaseReference,
      reason: str(body?.note).slice(0, 500),
    },
  }]);

  await SalesHandoverAuditEvent.create([{
    companyId: scope.companyId,
    handoverRef: str(request.journeyRef) || str(request.journeyId),
    handoverLineRef: str(request.productLineRef),
    versionNo: request.versionNo,
    action: DEVELOPMENT_EVENT_KINDS.RELEASED,
    actor: actor || undefined,
    at,
    reason: str(body?.note).slice(0, 1000),
    correlationId,
    changeRef: request.requestRef,
  }]);

  return { requestRef: request.requestRef, releaseReference, correlationId };
}

/* ═══ READS ════════════════════════════════════════════════════════════════ */

const requestView = (r) => (r ? {
  id: str(r._id),
  requestRef: str(r.requestRef),
  versionNo: r.versionNo,
  state: str(r.state),
  journeyId: str(r.journeyId),
  journeyRef: str(r.journeyRef),
  productLineRef: str(r.productLineRef),
  buyerDisplayLabel: str(r.buyerDisplayLabel),
  productName: str(r.productName),
  styleRef: str(r.styleRef),
  sampleStyleId: r.sampleStyleId ? str(r.sampleStyleId) : null,
  stockItemId: r.stockItemId ? str(r.stockItemId) : null,
  referenceImages: (r.referenceImages || []).map((i) => ({ url: str(i.url), caption: str(i.caption) })),
  requirementSummary: str(r.requirementSummary),
  requestedCategories: (r.requestedCategories || []).map(str),
  requiredByDate: r.requiredByDate || null,
  requestedByName: str(r.requestedBy?.name),
  requestedAt: r.requestedAt || null,
  supersededAt: r.supersededAt || null,
  cancelledAt: r.cancelledAt || null,
  cancellationReason: str(r.cancellationReason),
  createdAt: r.createdAt || null,
} : null);

/** Every request on one Journey product line, newest first. */
async function listForLine(scope, { journeyId, productLineRef, limit = 25 } = {}) {
  const rows = await SalesDevelopmentRequest.find({
    companyId: scope.companyId, journeyId, productLineRef: str(productLineRef),
  }).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 25, 100)).lean();
  return { rows: rows.map(requestView) };
}

/** Every request on one Journey, for the Sales Journey surface. */
async function listForJourney(scope, { journeyId, limit = 50 } = {}) {
  const rows = await SalesDevelopmentRequest.find({
    companyId: scope.companyId, journeyId,
  }).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 50, 200)).lean();
  return { rows: rows.map(requestView) };
}

module.exports = {
  DEVELOPMENT_EVENT_KINDS, ISSUE_FIELDS,
  assertNoForbiddenFields, assertShape, resolveProductLine,
  issue, cancel, authoriseRelease, requestView, listForLine, listForJourney,
  listProductLines,
};
