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
// Not one Merchandising MODEL is imported here. Sales asks; Merchandising's
// own receiver opens the file. Sales cannot create or edit a Development File,
// which is the whole reason the request is a record rather than a function
// call.
//
// The one Merchandising thing this file does reach is
// `developmentPublication.service` — Merchandising's own read-only door, the
// module whose entire purpose is to answer questions about a development file
// without letting the asker touch it. `authoriseRelease` uses it to confirm,
// at the moment of the click, that the revision Sales reviewed is still the
// approved one. Querying the Merchandising collections directly from here is
// the thing that door exists to prevent: a copied join keeps answering the old
// question long after the meaning has moved, and it does it silently, because
// a stale join returns rows rather than an error.
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
const publication = require("../merchandising/developmentPublication.service");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

/** The event kinds Sales publishes about a development request. */
const DEVELOPMENT_EVENT_KINDS = Object.freeze({
  ISSUED: "sales.development_request.issued",
  SUPERSEDED: "sales.development_request.superseded",
  CANCELLED: "sales.development_request.cancelled",
  RELEASED: "sales.development_release.authorised",
  CHANGES_REQUESTED: "sales.development_changes.requested",
});

/** The smallest reason that tells Merchandising what to do. Merchandising's
    own return uses the same floor, and the two should not disagree. */
const MIN_REASON = 15;

/** Sales decides; Sales does not author. Refused by name, at both commands. */
const MATERIAL_FIELDS = Object.freeze([
  "rows", "row", "materials", "items", "rawItems", "rawItemName", "rawItemSku",
  "category", "colourOrShade", "finish", "placement", "appliesTo", "selectionNote",
  "variantId", "variantCombination", "rowRef",
]);

/**
 * A DECISION CANNOT CARRY AN EDIT.
 *
 * Sales approves or returns Merchandising's selection; it never restates it.
 * A payload carrying material facts is refused rather than ignored, because
 * ignoring it lets somebody believe they changed something — they would send
 * a corrected fabric, see success, and never learn that nobody received it.
 */
function assertNoMaterialFields(body) {
  for (const field of MATERIAL_FIELDS) {
    if (field in (body || {})) {
      throw fail("DEVELOPMENT_MATERIALS_NOT_EDITABLE",
        `"${field}" cannot travel on a Sales decision — the selection is Merchandising's. `
        + "Say what needs changing in the reason, and they will revise it.",
        { field, belongsTo: "Merchandising" });
    }
  }
}

/** Only these may be sent. Everything else is refused by name. */
const ISSUE_FIELDS = Object.freeze([
  "requirementSummary", "requestedCategories", "requiredByDate",
  "referenceImages", "styleRef", "sampleStyleId", "stockItemId", "targetPriceCeiling",
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

  let targetPriceCeiling;
  if (body.targetPriceCeiling !== undefined && body.targetPriceCeiling !== null) {
    const amount = Number(body.targetPriceCeiling?.amount);
    const currency = str(body.targetPriceCeiling?.currency).toUpperCase();
    const basis = str(body.targetPriceCeiling?.basis).toUpperCase();
    if (!Number.isFinite(amount) || amount < 0 || !currency || basis !== "PER_PIECE") {
      throw fail("VALIDATION",
        "A target-price ceiling needs a non-negative amount, currency and PER_PIECE basis.",
        { field: "targetPriceCeiling" });
    }
    targetPriceCeiling = { amount, currency: currency.slice(0, 8), basis };
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
      targetPriceCeiling,
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
 *
 * ── AND IT RELEASES ONE EXACT REVISION ──────────────────────────────────────
 * `expectedBomRevisionNo` is the approved revision number the panel showed the
 * person who clicked. It is an ASSERTION about what they read, and the only
 * thing done with it is a comparison: if Merchandising approved a newer
 * revision while the panel was open, the release is refused and nothing is
 * written. Everything else about the binding — which company, which file,
 * which journey, which line — is resolved from records the server already
 * trusts, never from the body.
 *
 * What gets recorded is `{companyId, developmentFileId, revisionNo}`, on the
 * request version and in the event. Before this, the release named a journey
 * and a product line, which identify a FILE; R&D's intake then read whatever
 * revision that file currently pointed at. Between the click and the delivery
 * that could become a revision nobody in Sales had ever seen.
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

  assertNoMaterialFields(body);
  const expected = Number(body?.expectedBomRevisionNo);
  if (!Number.isInteger(expected) || expected < 1) {
    throw fail("DEVELOPMENT_BOM_REVISION_REQUIRED",
      "A release has to name the approved revision it is releasing. Reload the development panel and try again.",
      { expectedBomRevisionNo: body?.expectedBomRevisionNo ?? null });
  }
  const idempotencyKey = str(body?.idempotencyKey);

  /* Lost to the other answer: this revision has already been sent back. */
  if (Number(request.materialChangeRequest?.bomRevisionNo) === expected) {
    throw fail("DEVELOPMENT_CHANGES_ALREADY_REQUESTED",
      `Revision ${expected} was already sent back to Merchandising for changes. `
      + "It cannot also be released.",
      { bomRevisionNo: expected, reason: str(request.materialChangeRequest?.reason) });
  }

  /* ── ALREADY RELEASED IS AN ANSWER, AND WHICH ANSWER DEPENDS ON THE
        REVISION ──────────────────────────────────────────────────────────
     Asked before the binding is resolved, because once a file is released it
     is no longer APPROVED and the binding would refuse with "not waiting for
     a Sales release" — true, but not the thing this caller needs to hear. */
  const settled = replayOrRefuse(request, expected, idempotencyKey);
  if (settled) return settled;

  /* Merchandising's own door answers this, against its own records, now. */
  const bound = await publication.resolveReleaseBinding(scope, {
    journeyId: request.journeyId,
    productLineRef: request.productLineRef,
    expectedBomRevisionNo: expected,
  });

  const at = new Date();
  const correlationId = crypto.randomUUID();
  const releaseReference = `REL-${crypto.randomBytes(5).toString("hex")}`;
  /* Null on a first release; the revision this one replaces on any later
     one, so the history reads as a chain rather than a pile. */
  const previouslyReleased = request.release?.authorisedAt
    ? Number(request.release.bomRevisionNo) : null;

  return withTxn(async (session) => {
    /* ── ONE RELEASE PER REQUEST VERSION, DECIDED BY THE DATABASE ────────
       A compare-and-set on "nothing has been authorised yet". Two clicks that
       both got past the read above arrive here together; exactly one matches
       the filter and writes, and the other falls through to the same
       replay-or-refuse reading as a retry. Without it both would mint a
       reference and both would publish an event. */
    const claimed = await SalesDevelopmentRequest.findOneAndUpdate(
      {
        _id: request._id,
        companyId: scope.companyId,
        state: REQUEST_STATE.ISSUED,
        /* ── ONE RELEASE PER REVISION, NOT ONE PER REQUEST ───────────────
           This used to be `"release.authorisedAt": null`, which made a
           release a once-in-a-lifetime act. It is not: the customer changes
           their mind, Merchandising approves a successor, and Sales releases
           THAT. The claim is therefore per revision — a second release of the
           SAME revision loses and replays, a release of a newer one proceeds. */
        "release.bomRevisionNo": { $ne: expected },
        /* ── THE TWO ANSWERS ARE MUTUALLY EXCLUSIVE ──────────────────────
           Approve-and-release and request-changes answer the SAME revision,
           and they contradict each other. Both commands compare-and-set on
           this document, and each filter names the other's mark, so the
           first to land wins and the second is refused. Without this they
           write different fields and both succeed: R&D receives a selection
           that Sales also asked to have changed. */
        "materialChangeRequest.bomRevisionNo": { $ne: expected },
      },
      {
        /* `release` is the CURRENT one and is replaced; `releases` is the
           series and is only ever appended to. The earlier decision keeps its
           own actor, time and revision, because that is what a later question
           about what R&D built against is answered from. */
        $set: {
          release: {
            releaseReference,
            developmentFileId: bound.developmentFileId,
            bomRevisionNo: bound.bomRevisionNo,
            authorisedAt: at,
            authorisedBy: actor || undefined,
            idempotencyKey,
            correlationId,
          },
        },
        $push: {
          releases: {
            releaseReference,
            developmentFileId: bound.developmentFileId,
            bomRevisionNo: bound.bomRevisionNo,
            authorisedAt: at,
            authorisedBy: actor || undefined,
            idempotencyKey,
            correlationId,
            supersedesBomRevisionNo: previouslyReleased,
          },
        },
      },
      { new: true, session },
    ).lean();

    if (!claimed) {
      const current = await SalesDevelopmentRequest.findById(request._id).session(session).lean();
      const replay = current && replayOrRefuse(current, expected, idempotencyKey);
      if (replay) return replay;
      throw fail("CONFLICT",
        "This request moved while the release was being recorded. Nothing was released — reload and try again.");
    }

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
        /* ── THE BINDING TRAVELS WITH THE EVENT ─────────────────────────
           Carried, not re-derived. An intake that looks the revision up for
           itself is an intake that can substitute a newer one. */
        developmentFileId: bound.developmentFileId,
        bomRevisionNo: bound.bomRevisionNo,
        releaseReference,
        reason: str(body?.note).slice(0, 500),
      },
    }], { session, ordered: true });

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
    }], { session, ordered: true });

    return {
      requestRef: request.requestRef,
      releaseReference,
      correlationId,
      developmentFileId: bound.developmentFileId,
      bomRevisionNo: bound.bomRevisionNo,
      replayed: false,
    };
  });
}

/**
 * A REQUEST THAT HAS ALREADY BEEN RELEASED, READ HONESTLY.
 *
 * Three different situations wear the same shape, and a caller has to be able
 * to tell them apart:
 *
 *   · the same revision — a double click, a retried request, a lost response.
 *     The act already happened and happened as asked, so the original result
 *     is returned. Nothing new is minted and no second event is published.
 *   · a different revision, same idempotency key — the key has been reused to
 *     mean something it did not mean the first time. Refused by name.
 *   · a different revision, different key — a genuine second release attempt
 *     against a line Sales has already released.
 *
 * @returns the original result for a replay, or null when nothing was released
 */
function replayOrRefuse(request, expected, idempotencyKey) {
  const rel = request?.release;
  if (!rel?.authorisedAt) return null;

  /* ── A KEY NAMES ONE ACT, WHICHEVER DIRECTION IT IS REUSED IN ──────────
     Asked FIRST, and against every release this request has made rather than
     only the latest. A key that released revision 1 and is presented again
     for revision 2 is being reused to mean something it did not mean, and
     that is true whether revision 2 is newer or older. Checking only the most
     recent release would let a key be reused the moment a third release
     pushed the second out of `release`. */
  const usedBefore = [...(request.releases || []), rel]
    .find((r) => idempotencyKey && str(r?.idempotencyKey) === idempotencyKey);
  if (usedBefore && Number(usedBefore.bomRevisionNo) !== expected) {
    throw fail("IDEMPOTENCY_KEY_REUSED",
      `That key already released revision ${usedBefore.bomRevisionNo}. It cannot be reused to release revision ${expected}.`,
      { releasedBomRevisionNo: Number(usedBefore.bomRevisionNo), expectedBomRevisionNo: expected });
  }

  /* ── RELEASING A NEWER REVISION IS NOT A SECOND ANSWER ─────────────────
     It is the answer to a different question. Revision 1 was released, the
     materials were reopened and revision 2 approved; releasing revision 2 is
     the whole point of the staleness policy, so it falls through to the
     ordinary path and appends to the history. The binding still has to pass,
     so a revision Merchandising has not approved gets no further than this.

     Going BACKWARDS is refused. A release of a revision older than the one
     already released could only come from a screen that has been open since
     before the reopen, and honouring it would hand R&D a selection that has
     already been superseded. */
  if (expected > Number(rel.bomRevisionNo)) return null;

  if (Number(rel.bomRevisionNo) === expected) {
    return {
      requestRef: str(request.requestRef),
      releaseReference: str(rel.releaseReference),
      correlationId: str(rel.correlationId),
      developmentFileId: rel.developmentFileId ? str(rel.developmentFileId) : null,
      bomRevisionNo: Number(rel.bomRevisionNo),
      replayed: true,
    };
  }

  throw fail("DEVELOPMENT_ALREADY_RELEASED",
    `Revision ${rel.bomRevisionNo} has already been released to R&D. Revision ${expected} is older `
    + "than that, so releasing it now would send R&D a selection that has since been replaced.",
    {
      releasedBomRevisionNo: Number(rel.bomRevisionNo),
      releaseReference: str(rel.releaseReference),
      expectedBomRevisionNo: expected,
    });
}

/* ═══ THE OTHER ANSWER ═════════════════════════════════════════════════════ */

/**
 * SALES ASKS MERCHANDISING TO CHANGE THE SELECTION.
 *
 * The counterpart of `authoriseRelease`, and deliberately the same shape: it
 * answers ONE exact approved revision, it is verified against Merchandising's
 * own records at the moment of the click, and it writes nothing in
 * Merchandising — it publishes, and Merchandising's receiver decides what the
 * decision means for Merchandising's records.
 *
 * ── WHAT SALES IS ACTUALLY SAYING ───────────────────────────────────────────
 * Not "this fabric is wrong" as a technical judgement — that is not Sales'
 * competence and not their record. It is "this does not answer what the
 * customer asked for", with the reason attached, and the reason is mandatory
 * because a merchandiser cannot act on a refusal that does not say what it
 * refuses.
 *
 * ── AND WHAT IT IS NOT ──────────────────────────────────────────────────────
 * It is not an edit. Sales never restates a row; a payload carrying material
 * facts is refused by name. The approved revision is not modified either —
 * R&D and Costing may already have read it, and history that changes is not
 * history. Merchandising gets a NEW working revision cloned from it.
 */
async function requestMaterialChanges(scope, { requestRef, body = {}, actor = null } = {}) {
  if (!scope?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
  assertNoMaterialFields(body);

  const request = await SalesDevelopmentRequest.findOne({
    companyId: scope.companyId, requestRef: str(requestRef), state: REQUEST_STATE.ISSUED,
  }).lean();
  if (!request) {
    throw fail("DEVELOPMENT_REQUEST_NOT_FOUND", "There is no open development request with that reference.");
  }

  const expected = Number(body?.expectedBomRevisionNo);
  if (!Number.isInteger(expected) || expected < 1) {
    throw fail("DEVELOPMENT_BOM_REVISION_REQUIRED",
      "Say which approved revision you are sending back. Reload the development panel and try again.",
      { expectedBomRevisionNo: body?.expectedBomRevisionNo ?? null });
  }

  const reason = str(body?.reason);
  if (reason.length < MIN_REASON) {
    throw fail("VALIDATION",
      "Say what needs changing — Merchandising works from this reason, and a revision cannot be "
      + "corrected against a sentence that does not say what is wrong.",
      { field: "reason", minimum: MIN_REASON });
  }
  const idempotencyKey = str(body?.idempotencyKey);

  /* ── ALREADY ANSWERED, AND WHICH WAY ──────────────────────────────────
     Asked before the binding is resolved: once either answer lands the file
     leaves APPROVED, and the binding would refuse with "not waiting for a
     Sales release" — true, but not what this caller needs to hear. */
  const priorChange = request.materialChangeRequest;
  if (Number(priorChange?.bomRevisionNo) === expected && priorChange?.requestedAt) {
    /* The same revision sent back again: a double click, or a retry after a
       lost response. The act already happened, so its result is returned and
       no second successor revision is opened. */
    return {
      requestRef: str(request.requestRef),
      bomRevisionNo: expected,
      developmentFileId: priorChange.developmentFileId ? str(priorChange.developmentFileId) : null,
      reason: str(priorChange.reason),
      correlationId: str(priorChange.correlationId),
      replayed: true,
    };
  }
  /* ── REOPENING WHAT WAS ALREADY RELEASED IS A DIFFERENT ACT ───────────
     Chunk B refused this outright, because at that point nothing downstream
     could represent "released, and since superseded" and a pretend rewind
     would have been the only alternative. The derived staleness in this chunk
     is what makes it representable, so the act exists — but it is not the
     same act as reviewing an approved revision, and it does not get to happen
     by accident.

     The caller must say so explicitly. Reopening after release invalidates
     work R&D has already started against these materials, and a screen that
     did it silently because the button happened to be in the same place is
     how a week of sampling disappears without anyone deciding it should. */
  const releasedNow = Number(request.release?.bomRevisionNo) === expected
    && Boolean(request.release?.authorisedAt);
  const reopening = Boolean(body?.reopenReleased);

  if (releasedNow && !reopening) {
    throw fail("DEVELOPMENT_ALREADY_RELEASED",
      `Revision ${expected} was approved and released to R&D. R&D is working against it. `
      + "Reopening it because the customer has changed their mind is a different decision, and "
      + "it has to be taken as one.",
      {
        releasedBomRevisionNo: Number(request.release.bomRevisionNo),
        releaseReference: str(request.release.releaseReference),
        reopenWith: "reopenReleased",
      },
    );
  }
  if (reopening && !releasedNow) {
    throw fail("DEVELOPMENT_NOT_RELEASED",
      `Revision ${expected} has not been released to R&D, so there is nothing to reopen. `
      + "Send it back with the ordinary review decision instead.",
      { expectedBomRevisionNo: expected });
  }

  /* Merchandising's own door confirms the state and resolves the file id. Two
     bindings, because the two acts require opposite states: a review needs the
     revision to be the approved one AWAITING Sales, a reopen needs it to be
     the one already RELEASED. */
  const bound = reopening
    ? await publication.resolveReopenBinding(scope, {
      journeyId: request.journeyId,
      productLineRef: request.productLineRef,
      expectedBomRevisionNo: expected,
    })
    : await publication.resolveReleaseBinding(scope, {
      journeyId: request.journeyId,
      productLineRef: request.productLineRef,
      expectedBomRevisionNo: expected,
    });

  const at = new Date();
  const correlationId = crypto.randomUUID();

  return withTxn(async (session) => {
    /* Compare-and-set, naming the release's mark as well as its own: two
       clicks, or a click racing an approval, resolve to exactly one answer. */
    const claimed = await SalesDevelopmentRequest.findOneAndUpdate(
      {
        _id: request._id,
        companyId: scope.companyId,
        state: REQUEST_STATE.ISSUED,
        /* ── PER REVISION, NOT PER REQUEST ──────────────────────────────
           A review decision claimed "nothing has ever been released", which
           was true while a line could only be released once. It cannot:
           revision 1 is released, the customer changes their mind, revision 2
           is approved, and sending THAT back is an ordinary review decision
           on a revision nobody has released. What must not have happened is a
           release of THIS revision.

           A reopen is the exception, and the only one: it is ABOUT the
           released revision, so requiring that revision not to be released
           would refuse every reopen there could ever be. */
        ...(reopening ? {} : { "release.bomRevisionNo": { $ne: expected } }),
        "materialChangeRequest.bomRevisionNo": { $ne: expected },
      },
      {
        $set: {
          materialChangeRequest: {
            developmentFileId: bound.developmentFileId,
            bomRevisionNo: bound.bomRevisionNo,
            reason: reason.slice(0, 2000),
            requestedAt: at,
            requestedBy: actor || undefined,
            idempotencyKey,
            correlationId,
          },
        },
      },
      { new: true, session },
    ).lean();

    if (!claimed) {
      const current = await SalesDevelopmentRequest.findById(request._id).session(session).lean();
      if (!reopening && Number(current?.release?.bomRevisionNo) === expected
        && current?.release?.authorisedAt) {
        throw fail("DEVELOPMENT_ALREADY_RELEASED",
          `Revision ${current.release.bomRevisionNo} was released to R&D while this was being recorded. `
          + "Nothing was sent back.",
          { releasedBomRevisionNo: Number(current.release.bomRevisionNo) });
      }
      if (Number(current?.materialChangeRequest?.bomRevisionNo) === expected) {
        return {
          requestRef: str(request.requestRef),
          bomRevisionNo: expected,
          developmentFileId: bound.developmentFileId,
          reason: str(current.materialChangeRequest.reason),
          correlationId: str(current.materialChangeRequest.correlationId),
          replayed: true,
        };
      }
      throw fail("CONFLICT",
        "This request moved while the decision was being recorded. Nothing was sent back — reload and try again.");
    }

    await SalesHandoverOutboxEvent.create([{
      companyId: scope.companyId,
      kind: DEVELOPMENT_EVENT_KINDS.CHANGES_REQUESTED,
      occurredAt: at,
      actor: actor || undefined,
      correlationId,
      payload: {
        requestRef: request.requestRef,
        requestVersionNo: request.versionNo,
        journeyId: request.journeyId,
        productLineRef: request.productLineRef,
        developmentFileId: bound.developmentFileId,
        bomRevisionNo: bound.bomRevisionNo,
        reason: reason.slice(0, 500),
        /* The receiver needs to know this was a reopen: the file is in a state
           its ordinary handler refuses, and it refuses it for good reasons. */
        reopenReleased: reopening,
      },
    }], { session, ordered: true });

    await SalesHandoverAuditEvent.create([{
      companyId: scope.companyId,
      handoverRef: str(request.journeyRef) || str(request.journeyId),
      handoverLineRef: str(request.productLineRef),
      versionNo: request.versionNo,
      action: DEVELOPMENT_EVENT_KINDS.CHANGES_REQUESTED,
      actor: actor || undefined,
      at,
      reason: reason.slice(0, 1000),
      correlationId,
      changeRef: request.requestRef,
    }], { session, ordered: true });

    return {
      requestRef: request.requestRef,
      bomRevisionNo: bound.bomRevisionNo,
      developmentFileId: bound.developmentFileId,
      reason: reason.slice(0, 2000),
      correlationId,
      reopenedRelease: reopening,
      replayed: false,
    };
  });
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
  targetPriceCeiling: Number.isFinite(r.targetPriceCeiling?.amount)
    ? {
      amount: r.targetPriceCeiling.amount,
      currency: str(r.targetPriceCeiling.currency),
      basis: str(r.targetPriceCeiling.basis),
    }
    : null,
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
  issue, cancel, authoriseRelease, requestMaterialChanges,
  MIN_REASON, MATERIAL_FIELDS, assertNoMaterialFields,
  requestView, listForLine, listForJourney,
  listProductLines,
};
