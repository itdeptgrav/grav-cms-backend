"use strict";
/**
 * services/orderBrief/orderBrief.service.js
 * ───────────────────────────────────────────────────────────────────────────
 * WHO MAY SEE THIS ORDER, AND WHICH RECORDS SPEAK FOR IT.
 *
 * The assembler decides what each fact says. This file decides which records
 * it is allowed to hear from, and it is where the tenancy risk lives: a
 * CustomerRequest carries no `companyId`, so "this order is ours" has to be
 * PROVED through something that does.
 *
 * ── NO NEW OWNERSHIP RULE ──────────────────────────────────────────────────
 * The order is proved by `merchandisingHandover.loadOwnedRequest`, which the
 * handover producer and both demand-release services already use, and which
 * says of itself that a second implementation would be a second tenancy
 * boundary. It proves an order through its lines' styles.
 *
 * It cannot prove an order that has no styles at all — and on this database
 * that is most real orders. For those, and ONLY those, the Sales scope's own
 * sole-company rule applies: in a deployment with exactly one company, an
 * unowned record is provably that company's (salesScope.service `scopeFor`).
 * A style proof that FAILS is final. Falling back after a failed proof would
 * turn "this order belongs to someone else" into "show it anyway".
 *
 * ── THE ENQUIRY LINK IS READ, NEVER WRITTEN, AND NEVER TRUSTED BLIND ───────
 * Lane A decides how an order gets tied to its enquiry (services/orderBookLink
 * and the PO routes). This file only reads the result. The reliable backlink
 * is `salesOrigin.enquiryId`, stamped server-side at creation. The other,
 * `Enquiry.customerRequestId`, can have been filled by a recency or name guess,
 * so before its PO, account or requirements are used it must pass
 * `closingVerdict.proveOrderLink` — the same proof the closing verdict uses.
 * An unproved link is reported, not used.
 */

const mongoose = require("mongoose");

const { fail } = require("../storePurchase/errors");
const { scopeFor, scopedFilter } = require("../companyContext/salesScope.service");
const handover = require("../sales/merchandisingHandover.service");
const { proveOrderLink } = require("../closingVerdict");
const { approvedRevisionOf } = require("../centralCosting/technicalRecord.service");
const { assembleOrderBrief } = require("./assembleOrderBrief");

/* Required on first use, as the rest of the Sales services do, so loading this
   file never registers a model a caller did not ask for. */
const CustomerRequest = () => require("../../models/Customer_Models/CustomerRequest");
const Enquiry = () => require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = () => require("../../models/CMS_Models/Sales/SalesJourney");
const Account = () => require("../../models/CMS_Models/Sales/Account");
const SampleStyle = () => require("../../models/CMS_Models/Sales/SampleStyle");
const SalesHandoverVersion = () => require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const ExecutionFile = () => require("../../models/CMS_Models/Merchandising/ExecutionFile");
const Revisions = () => require("../../models/CMS_Models/Merchandising/SelectionRevision");

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

/* The only fields the brief reads, per collection. Selected rather than whole
   documents so a field added to a model tomorrow — a margin, a contact — does
   not start flowing through here unreviewed. */
const REQUEST_FIELDS = [
  "requestId", "status", "customerId", "customerInfo.name", "customerInfo.deliveryDeadline",
  "salesOrigin.enquiryId", "createdAt", "updatedAt",
  "items.lineRef", "items.productLineRef", "items.sampleStyleId", "items.stockItemId",
  "items.stockItemName", "items.stockItemReference", "items.totalQuantity",
  "items.variants.attributes", "items.variants.quantity",
  "quotations", "quotationRevisions",
].join(" ");

const STYLE_FIELDS = "sampleStyleId styleCode productName sample.status sample.approvedAt sample.rounds customerApproval techSheet";

const ENQUIRY_FIELDS = [
  "enquiryId", "journeyId", "accountId", "customerRequestId", "companyId", "freight",
  "products.productLineRef", "products.fabricPreference", "products.fabricComposition",
  "products.gsm", "products.colour", "products.trims",
].join(" ");

/** Prove the order is the caller's. Returns the proof basis, or throws NOT_FOUND. */
async function proveOwnership(req, requestId, request, scope) {
  const hasStyles = (request.items || []).some((i) => i?.sampleStyleId);

  if (hasStyles) {
    /* The designated proof. Its refusal is the answer — see the header. */
    await handover.loadOwnedRequest({ companyId: scope.companyId }, requestId);
    return { basis: "style", note: "" };
  }

  if (scope.allowUnowned) {
    return {
      basis: "sole_company",
      note: "This order names no styles, so it cannot be proved through them; it is shown because this deployment has a single company.",
    };
  }

  throw fail("NOT_FOUND", "Order not found.");
}

/**
 * The enquiry this order belongs to, if one can be proved.
 *
 * Returns `{ enquiry, link }`. `link.basis` says how it was reached so the UI
 * can say, for example, that the PO shown came through a proved link rather
 * than the order's own origin.
 */
async function enquiryFor(req, request) {
  const scoped = (selector) => scopedFilter(req, selector);

  const originId = request.salesOrigin?.enquiryId;
  if (originId) {
    const enquiry = await Enquiry().findOne(await scoped({ _id: originId })).select(ENQUIRY_FIELDS).lean();
    return enquiry
      ? { enquiry, link: { basis: "origin", note: "" } }
      : {
          enquiry: null,
          link: { basis: "unavailable", note: "The enquiry this order was raised from is not visible to your company." },
        };
  }

  /* `customerRequestId` is not unique across enquiries. Two enquiries both
     claiming this order is an ambiguity, and choosing one would be a guess
     about which buyer's PO to show. */
  const linked = await Enquiry().find(await scoped({ customerRequestId: request._id }))
    .select(ENQUIRY_FIELDS).limit(2).lean();
  if (!linked.length) return { enquiry: null, link: { basis: "none", note: "No enquiry is linked to this order." } };
  if (linked.length > 1) {
    return {
      enquiry: null,
      link: { basis: "ambiguous", note: "More than one enquiry points at this order, so none of them is used." },
    };
  }

  const proof = await proveOrderLink({ enquiry: linked[0], scope: scoped });
  if (!proof.ok) {
    return {
      enquiry: null,
      link: {
        basis: "unproved",
        note: "An enquiry points at this order, but the link could not be proved, so its PO, buyer account and requirements are not used.",
      },
    };
  }
  return { enquiry: linked[0], link: { basis: `linked_${proof.basis}`, note: "" } };
}

/**
 * Build the brief for one order.
 *
 * @param {object} req        the Express request (auth + company scope)
 * @param {string} requestId  a CustomerRequest _id. How it was established is
 *                            Lane A's concern; this only reads it.
 */
async function buildOrderBrief(req, requestId, { now = new Date() } = {}) {
  if (!isId(requestId)) throw fail("NOT_FOUND", "Order not found.");

  const scope = await scopeFor(req);
  const request = await CustomerRequest().findById(requestId).select(REQUEST_FIELDS).lean();
  if (!request) throw fail("NOT_FOUND", "Order not found.");

  const ownership = await proveOwnership(req, requestId, request, scope);
  const { enquiry, link } = await enquiryFor(req, request);

  const scoped = (selector) => scopedFilter(req, selector);

  const journey = enquiry?.journeyId
    ? await SalesJourney().findOne(await scoped({ _id: enquiry.journeyId })).select("journeyId po accountId").lean()
    : null;

  const accountId = enquiry?.accountId || journey?.accountId || null;
  const account = accountId
    ? await Account().findOne(await scoped({ _id: accountId }))
      .select("accountId companyName garmentSalesProfile freightArrangement defaultIncoterm")
      .lean()
    : null;

  /* Styles were proved with the order (or there are none). */
  const styleIds = [...new Set((request.items || []).map((i) => str(i.sampleStyleId)).filter(Boolean))];
  const styles = styleIds.length
    ? await SampleStyle().find({ _id: { $in: styleIds } }).select(STYLE_FIELDS).lean()
    : [];

  /* Every handover version of this order, by the order's _id — not by the
     human `requestId`, which is indexed but not unique. */
  const handoverVersions = await SalesHandoverVersion()
    .find({ companyId: scope.companyId, "sourceRecord.recordId": request._id })
    .select("handoverRef handoverLineRef versionNo sourceRecord publication issuedBy executionProjection createdAt")
    .lean();

  const lineRefs = (request.items || []).map((i) => str(i.lineRef)).filter(Boolean);
  const executionFiles = lineRefs.length && str(request.requestId)
    ? await ExecutionFile()
      .find({ companyId: scope.companyId, handoverRef: str(request.requestId), handoverLineRef: { $in: lineRefs } })
      .select("fileNumber handoverLineRef currentHandoverVersionId")
      .lean()
    : [];

  const fileIds = executionFiles.map((f) => f._id);
  let trimRevisions = [];
  let packagingRevisions = [];
  if (fileIds.length) {
    const { MaterialTrimRevision, PackagingRevision, REVISION_STATE } = Revisions();
    const live = { $in: [REVISION_STATE.DRAFT, REVISION_STATE.SUBMITTED, REVISION_STATE.APPROVED] };
    const q = { companyId: scope.companyId, fileId: { $in: fileIds }, state: live };
    const fields = "fileId revisionNo state rows createdBy submittedBy submittedAt approvedBy approvedAt createdAt updatedAt";
    [trimRevisions, packagingRevisions] = await Promise.all([
      MaterialTrimRevision.find(q).select(fields).lean(),
      PackagingRevision.find(q).select(`${fields} instructions`).lean(),
    ]);
  }

  return assembleOrderBrief({
    request,
    enquiry,
    journey,
    account,
    stylesById: new Map(styles.map((s) => [String(s._id), s])),
    handoverVersions,
    executionFiles,
    trimRevisions,
    packagingRevisions,
    link,
    ownership,
    techApprovedOf: approvedRevisionOf,
    now,
  });
}

module.exports = { buildOrderBrief, REQUEST_FIELDS };
