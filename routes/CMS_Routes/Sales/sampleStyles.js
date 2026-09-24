// routes/CMS_Routes/Sales/sampleStyles.js
//
// The shared SampleStyle API — the wire between the Sales journey's "Style &
// Sample" stage and the R&D / Sampling app. Both apps hit these endpoints:
//
//   • Sales stage: GET /by-journey/:ref (get-or-create styles from the enquiry
//     products), then the two APPROVAL gates (tech-sheet approve/changes,
//     sample approve/reject).
//   • R&D app: GET / (cross-journey work queue), GET /:id, and the two
//     PRODUCTION jobs (tech-sheet start/submit, sample start/round/submit),
//     plus PATCH /:id/materials for the Merchandiser input.
//
// Mounted plainly (no salesWrites gate) like Enquiry — this is frequently-edited
// operational data; salesAuth per-endpoint authenticates, and the approval
// gates are enforced here (canApprove). Transitions are validated against the
// canonical maps in constants/crm.js.

"use strict";

const express = require("express");
const { scopedFilter: scoped } = require("../../../services/companyContext/salesScope.service");
const { scopeFor: salesScopeFor } = require("../../../services/companyContext/salesScope.service");
const { createServiceContext } = require("../../../services/companyContext/serviceScope.service");

/**
 * The trusted company context an email helper is given.
 *
 * Taken from THIS already-authorised request. An email helper that resolved
 * its own company — or worse, took it from the style it was handed — would be
 * deciding its own authorisation.
 */
const sampleEmailScope = async (req) => {
  const scope = await salesScopeFor(req);
  /* The factory decides the legacy allowance from the company master. This
     caller cannot grant it to itself. */
  return createServiceContext({
    companyId: scope.companyId,
    reason: "sample style email",
    legacyAware: true,
  });
};
const crypto = require("crypto");
const mongoose = require("mongoose");

const SampleStyle = require("../../../models/CMS_Models/Sales/SampleStyle");
const SalesJourney = require("../../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../../models/CMS_Models/Sales/Enquiry");
const CustomerChangeRequest = require("../../../models/CMS_Models/Sales/CustomerChangeRequest");
const customerChangeRouting = require("../../../services/sales/customerChangeRouting.service");
const {
  brandingRequirementsOf,
  sanitizeBrandingRequirements,
  ARTWORK_IS_CUSTOMER_REFERENCE,
} = require("../../../models/CMS_Models/Sales/enquiryBrandingRequirement");
const Account = require("../../../models/CMS_Models/Sales/Account");
const Customer = require("../../../models/Customer_Models/Customer");
const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem");
const RawItem = require("../../../models/CMS_Models/Inventory/Products/RawItem");
const Service = require("../../../models/CMS_Models/Inventory/Services/Service");
const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const Unit = require("../../../models/CMS_Models/Inventory/Configurations/Unit");
const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
const { createWorkOrdersAndProgress } = require("./quotationRoutes");
const { processVariantRawItems, updateStockItemAggregates, recomputeVariantCostsFromBom } = require("../../CMS_Routes/Inventory/Products/stockItems");
const { nextRequestId } = require("../../../services/requestId");
const { sendCustomerEmail } = require("../../../utils/salesEmailService");
const { notifyEvent, APP_URL: DEPT_NOTIFY_APP_URL } = require("../../../services/departmentNotify.service");
const { styleEmailContext, imageGalleryHtml, bomTableHtml, stockItemBom } = require("../../../services/sampleStyleEmail.service");
const { resolveRequirements } = require("../../../services/sales/sampleRequirements.service");
/* Merchandising's approved selection joined to R&D's consumption — one
   BOM → Packaging workflow over two owned records. */
const packagingBom = require("../../../services/sales/packagingBom.service");
/* The one ownership rule, reused rather than re-derived — see the service. */
const { ownershipProofFor } = require("../../../services/centralCosting/technicalSource.service");
/* Read for its charge TYPES only — the amounts never leave the costing app. */
const CostingPolicy = require("../../../models/CMS_Models/Costing/CostingPolicy");
/* The operation master the sample route is chosen from. It carries no company
   of its own — one global table — so the STYLE is what is proved here, and
   what comes back is identities and shapes, never a rate. */
const Operation = require("../../../models/CMS_Models/Inventory/Configurations/Operation");
/* R&D's structured technical record — what is complete, what may be edited,
   and what gets frozen on submission. The rules live there rather than in
   this router so the costing can ask the same questions of the same code. */
const technicalRecord = require("../../../services/centralCosting/technicalRecord.service");
/* WHICH materials R&D is expected to complete — one resolver, shared by the
   GET, the save, the seeding, return-to-materials and the completeness gate,
   reading the same finished-good BOM the visible Approved BOM panel shows. */
const { approvedShortlistFor } = require("../../../services/approvedMaterialShortlist.service");
const developmentChargePolicy = require("../../../services/centralCosting/developmentChargePolicy.service");
// THIS BACKEND's own public origin — for the BOM-approval decision links,
// which are the one thing here that must point at the API rather than at the
// CMS: the Project Manager decides from their inbox without signing in, so
// the link cannot go through a frontend route that would ask them to.
// DEPT_NOTIFY_APP_URL is the CMS (cms.grav.in); this is the API host.
// Set API_PUBLIC_URL in .env for any deploy where the two differ.
const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/+$/, "");
const salesAuthBase = require("../../../Middlewear/SalesAuthMiddlewear");

// R&D owns the tech sheet and the sample rounds, so R&D must be able to call
// these routes — and until now could not: every one of them was guarded by the
// CRM's role list, which has no R&D entry, so the whole app/research-development
// surface 403'd. Widened here only, not in the CRM guard itself.
const salesAuth = salesAuthBase.withRoles(salesAuthBase.RND_ROLES);
const { isSalesManager, bypassesApproval } = require("../../../services/salesAccess");
const { provisionJourneyStyles } = require("../../../services/sampleStyleProvision");
const { isSampleSettled } = require("../../../services/sampleReadiness");
const { createWithRef } = require("../../../services/sampleStyleRef");
const {
  variantKeyFrom,
  variantStyleCode,
  buildVariantDoc,
} = require("../../../services/sampleStyleVariant");
const {
  SAMPLE_TECHSHEET_TRANSITIONS,
  SAMPLE_SAMPLING_TRANSITIONS,
  SAMPLE_ROUND_TYPE_CODES,
  SAMPLE_STYLE_STAGE_CODES,
} = require("../../../constants/crm");

const router = express.Router();

const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "" });
/* The three-field "does this apply?" answer, shared with Production's and
   Merchandising's own services so one question has one validator. */
const styleApplicability = require("../../../services/styleApplicability");
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

// For the department-notification emails below.
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

// So every notification email can say WHICH customer this style belongs to.
// A house sample has none — "—" alone read as customer information having
// gone missing, not as "there genuinely isn't one" (1 Sept 2026 bug fix,
// same reasoning as sampleStyleEmail.service.js's styleEmailContext).
/**
 * @param {object} style  the style the email is about
 * @param {object} req    the authenticated request, for the company scope
 *
 * ── WHY THE REQUEST IS A PARAMETER ──────────────────────────────────────────
 * The account lookup is company-scoped, and `scoped()` resolves that company
 * from the request. This function did not take one: it referenced a free `req`
 * that existed nowhere in its scope, so every call reached a ReferenceError the
 * moment a journey-linked style with an account got past the two guards above.
 *
 * It went unnoticed because all six callers are fire-and-forget notification
 * blocks — `(async () => { … })().catch(() => {})` — so the throw was caught
 * and discarded, the route answered 200, and the email simply never arrived. A
 * route returning success proved nothing about this helper.
 *
 * `referenceImageFor` beside it has taken `req` since it was written, for the
 * same reason. This now matches it.
 */
async function customerNameFor(style, req) {
  if (style?.sampleType === "house") return "In-house sample — no customer";
  if (!style?.accountId) return "—";
  /* Company-scoped, deliberately: a style carrying a foreign account id would
     otherwise put that company's customer name into an email. Missing and
     foreign both fall through to the same "—" the fallback already used. */
  const acc = await Account.findOne(await scoped(req, { _id: style.accountId }))
    .select("displayName companyName").lean();
  return acc?.displayName || acc?.companyName || "—";
}

// The style's own reference image — the SAME one the Enquiry/RFQ stage
// captured for this product, since SampleStyle carries no images of its own
// until R&D submits an actual sample photo (see the `/sample` submit action,
// which DOES have its own photos — that one is used directly instead of this).
async function referenceImageFor(style, req) {
  if (!style?.enquiryId) return null;
  /* Authorisation is not `style.enquiryId`: a style carrying a foreign
     enquiry id would otherwise hand over that company's product photograph. */
  const enq = await Enquiry.findOne(await scoped(req, { _id: style.enquiryId })).select("products").lean();
  return enq?.products?.find((p) => p.product === style.productName)?.images?.[0] || null;
}

// Where Sales reads a style's Style & Sample stage from — the CTA link every
// notification email below points at. A house sample has no journeyId, so
// the journey route 404s for it; the correct landing place is the Sampling
// board, which renders the exact same stage in place (1 Sept 2026 bug fix —
// three notification emails, materials_change_requested/tech_sheet_submitted/
// sample_submitted, all built this URL assuming a journey unconditionally,
// so every one of them sent Sales a dead `/journeys/undefined/style-sample`
// link for a house sample).
const styleSampleUrl = (style) => (
  style?.sampleType === "house"
    ? `${DEPT_NOTIFY_APP_URL}/sales/dashboard/sampling`
    : `${DEPT_NOTIFY_APP_URL}/sales/dashboard/journeys/${style.journeyId}/style-sample`
);

// ─────────────────────────────────────────────────────────────────────────────
// Style hand-off emails — Merchandiser, Project Manager, R&D
//
// 28 Aug 2026, explicit request: "make sure ki properly attach the customer
// details, product details, photo's and all ok so that it can properly
// represent about the sampling". All three messages are built from ONE context
// so they can never describe the same style differently, and so a field added
// for one audience shows up for all three.
//
// styleEmailContext / imageGalleryHtml / bomTableHtml now live in
// services/sampleStyleEmail.service.js — moved there the same day, once
// routes/CMS_Routes/Sales/sampleBomApproval.js's decision PAGE needed the
// exact same context the email that linked to it used, so the two could never
// describe a style differently.
//
// The prose around this is Sales-authored (SalesSettings.samplingTemplates —
// see departmentNotify.service.js's resolveTemplate). What is built here is
// everything a template must NOT be able to get wrong: which customer, which
// product, which photos, which link.
// ─────────────────────────────────────────────────────────────────────────────

// Append one event to the style's shared timeline.
const logHistory = (style, ev, req) => {
  if (!Array.isArray(style.history)) style.history = [];
  style.history.push({ ...ev, by: actor(req), at: new Date() });
};

// Backward re-routing invalidates the downstream work — reset those phases so
// R&D redoes them on the new material/brief (the prior rounds + revisions stay
// as history).
const STAGE_ORDER = { brief: 0, materials: 1, rnd: 2 };
const resetTech = (s) => { s.techSheet.status = "pending"; s.techSheet.startedAt = null; s.techSheet.submittedAt = null; s.techSheet.approvedAt = null; s.techSheet.approvedBy = undefined; s.techSheet.file = undefined; };
const resetSample = (s) => { s.sample.status = "not_started"; s.sample.startedAt = null; s.sample.submittedAt = null; s.sample.approvedAt = null; s.sample.approvedBy = undefined; };

// A Sales-gate decision (approve/return) is Sales' to make — a plain sales
// editor running the journey stage, or any sales manager/admin.
async function canApprove(user) {
  if (!user) return false;
  if (user.role === "sales") return true;
  return isSalesManager(user);
}

async function loadJourney(req, journeyRef) {
  const query = isObjectId(journeyRef)
    ? { $or: [{ _id: journeyRef }, { journeyId: journeyRef }] }
    : { journeyId: journeyRef };
  /* `$and` through the scope helper, so this route's own `$or` cannot displace
     the tenant clause — the failure mode of merging two `$or`s into one. */
  return SalesJourney.findOne(await scoped(req, { ...query, isActive: true }));
}

async function resolveStyle(idOrRef) {
  const query = isObjectId(idOrRef)
    ? { $or: [{ _id: idOrRef }, { sampleStyleId: idOrRef }] }
    : { sampleStyleId: idOrRef };
  return SampleStyle.findOne({ ...query, isActive: true });
}

/**
 * Only the three fields the image subdocument has, and only from a real array.
 *
 * Round photos arrive from the client, so this is a whitelist rather than a
 * pass-through: without it any object posted as an image would be stored.
 */
const sanitizeImages = (v) =>
  (Array.isArray(v) ? v : [])
    .filter((i) => i && (i.url || i.fileId))
    .slice(0, 12)
    .map((i) => ({
      fileId: i.fileId ? String(i.fileId).trim() : undefined,
      name: i.name ? String(i.name).trim().slice(0, 200) : undefined,
      url: i.url ? String(i.url).trim() : undefined,
    }));

// Snapshot an enquiry product row into the style's read-only brief.
const briefFromProduct = (p) => ({
  note: p.note || "",
  quantity: p.quantity ?? null,
  gender: p.gender || undefined,
  colour: p.colour || "",
  fabricPreference: p.fabricPreference || "",
  fabricComposition: p.fabricComposition || "",
  gsm: p.gsm || "",
  fit: p.fit || "",
  sizeRange: p.sizeRange || "",
  branding: [p.logo && "Logo", p.embroidery && "Embroidery", p.printing && "Printing"].filter(Boolean).join(", "),
  brandingPlacement: p.brandingPlacement || "",
  /* ── EACH DECORATION, WITH ITS OWN ARTWORK ─────────────────────────────
     The `branding` sentence above is a summary of three booleans and cannot
     say that the chest logo is embroidered 8 cm wide in Pantone 280 C while
     the back print is something else entirely — nor carry the file the
     customer sent for either. This does.

     `brandingRequirementsOf` returns the structured rows when the enquiry has
     them, and projects the old booleans into the same shape when it does not,
     so R&D reads one shape for every record. The artwork is the BUYER'S
     reference material, never an approved production file — see the schema
     comment on SampleStyle.brief.brandingRequirements. */
  brandingRequirements: brandingRequirementsOf(p).map((r) => ({
    ref: r.ref || undefined,
    type: r.type || "",
    placement: r.placement || "",
    width: r.width ?? undefined,
    height: r.height ?? undefined,
    unit: r.unit || "",
    colourNotes: r.colourNotes || "",
    notes: r.notes || "",
    artworkState: r.artworkState || "",
    artwork: (r.artwork || []).map((i) => ({ fileId: i.fileId, publicId: i.publicId, name: i.name, url: i.url })),
    legacy: Boolean(r.legacy),
  })),
  artworkIsCustomerReference: ARTWORK_IS_CUSTOMER_REFERENCE,
  trims: p.trims || "",
  specialConstruction: p.specialConstruction || "",
  // Dropped before 19 Aug 2026: the enquiry product row always carried this
  // (what the customer currently wears), but the snapshot never copied it —
  // exactly the kind of context R&D needs and never got.
  existingUniform: p.existingUniform || "",
  // The three branding flags as flags, not only as the joined `branding`
  // string above — R&D reads "is there embroidery" as a yes/no when planning
  // the sample, and parsing it back out of a comma-joined sentence is how
  // that question gets answered wrong (24 Aug 2026, "this product entire each
  // and every details need to showcase to the r&d team").
  logo: Boolean(p.logo),
  embroidery: Boolean(p.embroidery),
  printing: Boolean(p.printing),
  // Which item-master record this product is, so R&D can open it rather than
  // matching by name.
  stockItemReference: p.stockItemReference || "",
  // Whatever the salesperson defined for THIS customer that no fixed field
  // covers — see the Enquiry model's own comment on customSpecs. Carried
  // verbatim; R&D shows every one of them.
  customSpecs: Array.isArray(p.customSpecs)
    ? p.customSpecs.filter((s) => s && s.label).map((s) => ({ label: s.label, value: s.value || "" }))
    : [],
  // `publicId` (Cloudinary) was also being dropped here, silently — the enquiry
  // product row supports both `fileId` (Drive, legacy) and `publicId`
  // (Cloudinary, current uploads); stripping the latter meant a Cloudinary
  // image survived only via its raw `url`, not through the same resolution
  // path Drive images use.
  images: Array.isArray(p.images) ? p.images.map((i) => ({ fileId: i.fileId, publicId: i.publicId, name: i.name, url: i.url })) : [],
});

const decorate = (styleDoc, journey, account, enquiry) => {
  const o = styleDoc.toObject ? styleDoc.toObject() : styleDoc;
  const enquiryProduct = enquiry && o.enquiryProductId
    ? (enquiry.products || []).find((p) => String(p?._id || "") === String(o.enquiryProductId))
    : null;
  return {
    ...o,
    /* The permanent enquiry-line identity travels with the style response so
       a customer-change request can be tied to the product line, never only
       to a renameable product name. */
    productLineRef: enquiryProduct?.productLineRef || null,
    // The BOM decision secret NEVER leaves the server (28 Aug 2026). It is
    // `select: false` on the schema, so a plain read already omits it — but
    // the request route ASSIGNS it before saving, which puts it on the
    // in-memory document that then gets serialised straight back to the
    // browser. Stripped here, in the one function every style response passes
    // through, rather than at that call site: a second route that ever touches
    // the token would otherwise have to remember this on its own.
    bomApproval: o.bomApproval ? { ...o.bomApproval, token: undefined } : o.bomApproval,
    // Same shape as Enquiry's pendingChanges: everyone sees it (Sales reviews
    // it; the Merchandiser/PM who submitted it sees it's still pending rather
    // than silently gone). Decided entries stay in the raw log but aren't
    // surfaced here — once decided they're history, not a working queue.
    pendingMaterialsChanges: (o.materialsChangeLog || [])
      .filter((c) => c.status === "pending")
      .map((c) => ({ id: String(c._id), items: c.items || [], submittedBy: c.submittedBy || null, submittedAt: c.submittedAt || null })),
    journeyRef: journey?.journeyId || null,
    journeyName: journey?.name || null,
    customerName: account ? account.displayName || account.companyName : null,
    customerCode: account?.accountId || null,
    // The Enquiry/RFQ context around this product — R&D only ever saw the
    // per-product brief snapshot, never why the customer is asking or how
    // urgent it is (19 Aug 2026, explicit request: "showcase the enquiry/RFQ
    // details... so R&D understand the product properly"). Read-only, a
    // handful of fields, not the whole document — costing/commercial detail
    // stays in Sales.
    enquiry: enquiry ? {
      reference: enquiry.enquiryId || null,
      title: enquiry.title || null,
      summary: enquiry.summary || null,
      priority: enquiry.priority || null,
      seriousness: enquiry.seriousness || null,
      enquiryDate: enquiry.enquiryDate || null,
      requirementDeadline: enquiry.requirementDeadline || null,
      expectedClosingDate: enquiry.expectedClosingDate || null,
    } : null,
  };
};

// The lowest variant sales price on a stock item — an honest "starting from"
// figure, not `salesPrice`/`averageSalesPrice` taken as-is (an average or a
// single base figure reads as a firm quote; the cheapest variant is what
// "starting from" actually promises and nothing more). Pure — the caller
// supplies the already-fetched, already-projected StockItem doc.
function cheapestVariantPrice(item) {
  if (!item) return null;
  const variantPrices = (item.variants || [])
    .map((v) => Number(v.salesPrice))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (variantPrices.length) return Math.min(...variantPrices);
  // No variant carries one yet (still being priced) — the product-level
  // figures are the next best honest answer, in order of how firm they are.
  return Number(item.baseSalesPrice) || Number(item.averageSalesPrice) || null;
}

// Which stock item a style's price is read off — the style's own registered
// product first, the already-developed source product second. The same
// fallback used at sample-approval sync time elsewhere in this file.
const priceTargetOf = (styleDoc) => styleDoc.production?.stockItemId || styleDoc.sourceStockItemId;

/**
 * `startingSalesPrice` for a batch of styles, in ONE query rather than one
 * per style — this runs on every list/board render, not just a single style
 * page, so an N+1 here would be an N+1 on every page load. Returns a
 * `Map<styleDoc, price|null>` keyed by object identity (styleDocs are always
 * freshly fetched Mongoose/lean docs here, never reused across calls, so
 * identity is a safe key and skips re-deriving each style's target id twice).
 */
async function startingSalesPricesFor(styleDocs) {
  const targets = styleDocs.map((s) => priceTargetOf(s)).filter(Boolean).map(String);
  const items = targets.length
    ? await StockItem.find({ _id: { $in: [...new Set(targets)] } })
        .select("variants.salesPrice baseSalesPrice averageSalesPrice")
        .lean()
    : [];
  const byId = new Map(items.map((it) => [String(it._id), it]));
  return new Map(styleDocs.map((s) => {
    const target = priceTargetOf(s);
    return [s, target ? cheapestVariantPrice(byId.get(String(target))) : null];
  }));
}

// Re-decorate a saved style with its journey + customer + enquiry for the response.
async function withJourney(styleDoc, req) {
  const [j, acc, enquiry, prices] = await Promise.all([
    SalesJourney.findOne(await scoped(req, { _id: styleDoc.journeyId })).select("journeyId name").lean(),
    styleDoc.accountId ? Account.findOne(await scoped(req, { _id: styleDoc.accountId })).select("accountId companyName displayName").lean() : null,
    styleDoc.enquiryId
      ? Enquiry.findOne(await scoped(req, { _id: styleDoc.enquiryId }))
        .select("enquiryId title summary priority seriousness enquiryDate requirementDeadline expectedClosingDate products._id products.productLineRef")
        .lean()
      : null,
    startingSalesPricesFor([styleDoc]),
  ]);
  return { ...decorate(styleDoc, j, acc, enquiry), startingSalesPrice: prices.get(styleDoc) ?? null };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cms/crm/sample-styles/house — raise an IN-HOUSE sample.
//
// The customer-less door into the exact same pipeline. Explicit request,
// 31 Aug 2026: "without any customer reference we are gonna make the sample...
// most of the time it happen ki some samples are needed to make even though
// none of any customer make the order... so that we can treat them as an
// register product once after the sample get approve by the sales person".
//
// ── WHY THIS IS A SECOND CREATE ROUTE, NOT A FLAG ON THE FIRST ─────────────
// `/by-journey/:ref/provision` is a SYNC, not a create: it reads an enquiry's
// product rows and reconciles one style per row, idempotently. There are no
// rows to read here — a salesperson is naming a garment they want sampled — so
// there is nothing for that route's matching logic to match against. Sharing
// it would mean threading "…unless there is no journey, in which case ignore
// almost all of this" through every branch.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
// It does not skip a single step of the pipeline. The style starts at
// `stage: "brief"` with `materials.status: "pending"`, exactly like a
// journey-raised one, and has to travel Merchandiser -> BOM approval -> R&D ->
// tech sheet -> sample -> Sales approval to finish. The request was explicit
// that the flow stays identical; the only thing missing is the customer.
router.post("/house", salesAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const productName = String(b.productName || "").trim();
    if (!productName) {
      return res.status(400).json({ success: false, message: "Give the sample a product name." });
    }

    // Same brief shape the enquiry path builds, from a form instead of a row —
    // so R&D reads an in-house sample exactly as it reads a customer's.
    const brief = briefFromProduct({
      note: b.note,
      quantity: b.quantity,
      gender: b.gender,
      colour: b.colour,
      fabricPreference: b.fabricPreference,
      fabricComposition: b.fabricComposition,
      gsm: b.gsm,
      fit: b.fit,
      sizeRange: b.sizeRange,
      logo: b.logo,
      embroidery: b.embroidery,
      printing: b.printing,
      brandingPlacement: b.brandingPlacement,
      /* The house form shares the Enquiry product form, so it sends the same
         structured rows. Sanitised here rather than trusted: this is a request
         body, and the brief is a snapshot — it has no identity of its own to
         reconcile, so the references it carries are simply dropped. */
      brandingRequirements: (sanitizeBrandingRequirements(b.brandingRequirements) || [])
        .map(({ ref, ...rest }) => rest),
      trims: b.trims,
      specialConstruction: b.specialConstruction,
      existingUniform: b.existingUniform,
      customSpecs: b.customSpecs,
      images: b.images,
      stockItemReference: b.stockItemReference,
    });

    const who = actor(req);
    const style = await createWithRef(SampleStyle, {
      sampleType: "house",
      // No journeyId, no enquiryId, no accountId — that is the whole point.
      // The partial unique index (see the model) is what makes this safe.
      productName,
      // Human code that says at a glance this was not raised off a journey.
      // Uniqueness is carried by `sampleStyleId`; this is a label.
      styleCode: `SC-HOUSE-${String(Date.now()).slice(-6)}`,
      ownerId: who.id,
      ownerName: who.name,
      brief,
      // An in-house sample may still be PROVING an existing register item
      // (a re-development, a fabric swap). Optional, same meaning as always.
      sourceStockItemId: b.sourceStockItemId || undefined,
      sourceStockItemReference: b.sourceStockItemReference || undefined,
      // `by: who`, matching actorRef() — not `byName`, which the schema does
      // not declare and Mongoose silently drops (1 Sept 2026 bug fix: the
      // very first event on a house sample's own timeline was recording no
      // actor at all).
      history: [{
        kind: "house_sample_raised",
        at: new Date(),
        by: who,
        note: `In-house sample raised for "${productName}" — no customer.`,
      }],
      createdBy: who.id,
    });

    return res.json({ success: true, sampleStyle: await withJourney(style, req) });
  } catch (err) {
    console.error("[sampleStyles] POST /house", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/cms/crm/sample-styles/:id/pictures — add reference pictures to
// an IN-HOUSE sample's own brief.
//
// A journey-raised style's pictures live on the ENQUIRY's product row — this
// stage only displays them, and its "Add picture" button routes back to
// Enquiry to add more (see the `pictures()` helper client-side). A house
// sample has no enquiry to route back to, so it needs a door of its own —
// this is that door (1 Sept 2026 bug fix: the button was sending house
// samples to `/sales/dashboard/sampling/null/enquiry`, `null` being the
// journeyId a house sample does not have).
//
// Scoped to house samples for the same reason POST /house is a separate
// create route rather than a flag: a journey style's pictures are owned by
// its enquiry, and letting them be edited from two places would let the two
// disagree about what the customer actually sent.
router.patch("/:id/pictures", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Sample not found." });
    if (style.sampleType !== "house") {
      return res.status(400).json({ success: false, message: "This style's reference pictures come from its Enquiry." });
    }
    const incoming = sanitizeImages(req.body?.images);
    if (!incoming.length) return res.status(400).json({ success: false, message: "No images given." });

    const existing = Array.isArray(style.brief?.images) ? style.brief.images : [];
    style.brief.images = [...existing, ...incoming].slice(0, 12);
    logHistory(style, { kind: "reference_picture_added", note: `${incoming.length} reference picture${incoming.length === 1 ? "" : "s"} added.` }, req);
    await style.save();

    return res.json({ success: true, sampleStyle: await withJourney(style, req) });
  } catch (err) {
    console.error("[sampleStyles] PATCH /:id/pictures", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cms/crm/sample-styles/:id/remove — remove an in-house sample.
//
// A reason is required — this is a destructive, audit-relevant act, and "who
// removed what and why" is exactly the trail the rest of this file already
// keeps for every hop and bounce (see logHistory).
//
// Soft delete (isActive: false), matching every other query in this file
// (resolveStyle, the by-journey and list routes) — the record and its full
// history stay, just filtered out of the boards. Hard-deleting it would throw
// away the very audit trail this action is required to explain.
//
// Cascades to the StockItem this sample registered. Since 1 Sept 2026 every
// house sample registers its product atomically as part of being raised (see
// RaiseHouseSample.js) — the two always travel together, so removing the
// sample without removing the product it exists to develop would leave an
// orphaned, unsampled item sitting in the register. StockItem has no soft-
// delete flag of its own (see routes/CMS_Routes/Inventory/Products/
// stockItems.js DELETE /:id), so this mirrors that route's hard delete.
//
// Scoped to house samples: a customer journey's style is never removed this
// way — the enquiry that raised it is the one place its product row (and the
// style it provisions) is managed.
router.post("/:id/remove", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Sample not found." });
    if (style.sampleType !== "house") {
      return res.status(400).json({ success: false, message: "Only in-house samples can be removed here." });
    }
    if (!bypassesApproval(req.user)) {
      return res.status(403).json({ success: false, message: "Only Sales, an admin or the CEO can remove this sample." });
    }
    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ success: false, message: "Give a reason for removing this sample." });

    if (style.sourceStockItemId) {
      try {
        const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem");
        await StockItem.deleteOne({ _id: style.sourceStockItemId });
      } catch (cleanupErr) {
        // Best-effort, same posture as stockItems.js's own delete route: the
        // sample removal is the request that was made, and failing it here
        // would report a product cleanup issue as if the sample survived.
        console.error("[sampleStyles] POST /:id/remove stock item cleanup failed:", cleanupErr.message);
      }
    }

    logHistory(style, { kind: "house_sample_removed", note: reason }, req);
    style.isActive = false;
    await style.save();

    return res.json({ success: true });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/remove", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cms/crm/sample-styles/by-journey/:journeyRef
// Get-or-create one SampleStyle per enquiry product, refreshing the brief.
// POST /by-journey/:journeyRef/provision — raise a style per enquiry product.
// Idempotent, and the only place that creates styles besides the journey's own
// stage transition. Sales calls it when handing the journey to R&D.
router.post("/by-journey/:journeyRef/provision", salesAuth, async (req, res) => {
  try {
    const journey = await loadJourney(req, req.params.journeyRef);
    if (!journey) return res.status(404).json({ success: false, message: "Journey not found." });

    const [enquiry, account] = await Promise.all([
      Enquiry.findOne(await scoped(req, { journeyId: journey._id, isActive: true })).select("products").lean(),
      journey.accountId ? Account.findOne(await scoped(req, { _id: journey.accountId })).select("accountId companyName displayName").lean() : null,
    ]);

    const { styles, created, renamed, backfilled, waived } = await provisionJourneyStyles({
      SampleStyle, journey, enquiry, briefFromProduct, actor: actor(req),
      // Has this garment actually been made before? Only a prior approved
      // sample or a measured SAM says yes — see services/developmentRecord.js.
      // Cached per stock item because a journey routinely repeats a product
      // across rows, and each check is two reads.
      assessDevelopment: (() => {
        const seen = new Map();
        return async (product) => {
          const key = String(product.stockItemId || "");
          if (!key) return { proven: false };
          if (seen.has(key)) return seen.get(key);
          const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem");
          const [stockItem, priorStyles] = await Promise.all([
            StockItem.findById(key).select("name reference category operations variants.rawItems measurements images").lean(),
            SampleStyle.find({ sourceStockItemId: key, isActive: true }).select("sample.status sample.approvedAt").lean(),
          ]);
          const record = buildDevelopmentRecord({ stockItem, priorStyles });
          seen.set(key, record);
          return record;
        };
      })(),
    });

    /* Complete the second half of BRIEF_NEW_VERSION. Removing the rejected
       enquiry row moves its change request to IN_PROGRESS; provisioning the
       replacement now links the request to the new permanent line and style.
       It remains open until the customer approves that replacement. */
    const scope = await salesScopeFor(req);
    const replacementCandidates = await CustomerChangeRequest.find({
      companyId: scope.companyId,
      enquiryId: enquiry?._id,
      destination: "BRIEF_NEW_VERSION",
      status: "IN_PROGRESS",
      "result.replacementSampleStyleId": { $exists: false },
    });
    for (const request of replacementCandidates) {
      const replacement = styles.find((s) => s.isActive !== false && s.productName === request.productName
        && String(s._id) !== String(request.sampleStyleId));
      if (!replacement) continue;
      const row = (enquiry?.products || []).find(
        (p) => String(p?._id || "") === String(replacement.enquiryProductId || ""),
      );
      request.result = request.result || {};
      request.result.replacementSampleStyleId = replacement._id;
      request.result.replacementProductLineRef = row?.productLineRef || undefined;
      await request.save();
    }

    const prices = await startingSalesPricesFor(styles);
    return res.json({
      success: true,
      created, renamed, backfilled, waived,
      sampleStyles: styles.map((s) => ({ ...decorate(s, journey, account, enquiry), startingSalesPrice: prices.get(s) ?? null })),
    });
  } catch (err) {
    console.error("[sampleStyles] POST /by-journey/:journeyRef/provision", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /for-request/:requestId — which style each line of a customer request is.
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 * The quotation editor builds its lines from `request.items[].stockItemId` —
 * an ITEM MASTER product. An approved costing price is published against a
 * SampleStyle. Nothing in the quotation payload joined the two, so the editor
 * had no way to ask "is there an approved price for this line" without
 * matching on the product NAME, which a rename or a coincidence of wording
 * silently repoints.
 *
 * ── AND IT IS NOT A NEW MAPPING ─────────────────────────────────────────────
 * SampleStyle already stores both halves itself, and has since production
 * linking was built: `production.customerRequestId` is the request the style
 * became an order for, and `production.stockItemId` is the item-master
 * product it became after development. This reads THOSE. No second table, no
 * inference, and nothing here writes.
 *
 * Returned as a list of stored id pairs — the smallest identity the handoff
 * needs. Deliberately no price, no cost, no margin and no supplier: a Sales
 * reader gets the SUBJECT of the costing, and asks the costing service itself
 * for anything commercial, where the capability is checked.
 */
router.get("/for-request/:requestId", salesAuth, async (req, res) => {
  try {
    const { requestId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ success: false, message: "That request reference is not valid." });
    }
    /* Scoped exactly like every other read in this file — a style belonging to
       another company's journey is not visible here either. */
    const styles = await SampleStyle.find(await scoped(req, {
      "production.customerRequestId": requestId,
      isActive: true,
    }))
      .select("_id styleCode productName production.stockItemId enquiryId")
      .lean();

    /* ── AND WHICH COMMERCIAL LINE, WHERE THERE IS NO DOUBT ────────────
       A quotation line's quantity comes from the confirmed commercial line,
       keyed by the permanent product-line reference AND the style — one
       enquiry can carry the same garment twice in two colourways. Where a
       style has exactly ONE confirmed line the reference is not a choice,
       so it is handed over and the editor never has to ask.

       Where it has two, NOTHING is sent. Picking one here would be picking
       a colourway on the company's behalf; the pricing command refuses an
       ambiguous style by name and says what to do about it. */
    const refByStyle = new Map();
    const enquiryIds = [...new Set(styles.map((s) => String(s.enquiryId || "")).filter(Boolean))];
    if (enquiryIds.length) {
      const enquiries = await Enquiry.find(await scoped(req, { _id: { $in: enquiryIds } }))
        .select("commercialLines").lean();
      for (const e of enquiries) {
        const byStyle = new Map();
        for (const l of e.commercialLines || []) {
          const k = String(l.sampleStyleId || "");
          if (!k) continue;
          byStyle.set(k, byStyle.has(k) ? null : String(l.productLineRef || ""));
        }
        for (const [k, ref] of byStyle) if (ref) refByStyle.set(k, ref);
      }
    }

    return res.json({
      success: true,
      /* One entry per style that names a product. A style with no
         `stockItemId` cannot be matched to a quotation line and is omitted
         rather than returned with a null the caller would have to guard. */
      links: styles
        .filter((s) => s.production?.stockItemId)
        .map((s) => ({
          sampleStyleId: String(s._id),
          stockItemId: String(s.production.stockItemId),
          styleCode: s.styleCode || "",
          productName: s.productName || "",
          /* Absent where the style has no confirmed line, or more than one. */
          ...(refByStyle.has(String(s._id))
            ? { productLineRef: refByStyle.get(String(s._id)) }
            : {}),
        })),
    });
  } catch (err) {
    console.error("[sampleStyles] GET /for-request/:requestId", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/by-journey/:journeyRef", salesAuth, async (req, res) => {
  try {
    const journey = await loadJourney(req, req.params.journeyRef);
    if (!journey) return res.status(404).json({ success: false, message: "Journey not found." });

    // READ ONLY. Provisioning lives in POST /by-journey/:journeyRef/provision
    // and in the journey's own stage transition — a GET that creates records
    // meant a style existed only once someone opened the journey, and any
    // prefetch or double-render wrote to the database.
    const [styles, account, enquiry] = await Promise.all([
      SampleStyle.find({ journeyId: journey._id, isActive: true }).sort({ createdAt: 1 }),
      journey.accountId ? Account.findOne(await scoped(req, { _id: journey.accountId })).select("accountId companyName displayName").lean() : null,
      Enquiry.findOne(await scoped(req, { journeyId: journey._id, isActive: true }))
        .select("enquiryId title summary priority seriousness enquiryDate requirementDeadline expectedClosingDate products._id products.productLineRef")
        .lean(),
    ]);

    const prices = await startingSalesPricesFor(styles);
    return res.json({
      success: true,
      sampleStyles: styles.map((s) => ({ ...decorate(s, journey, account, enquiry), startingSalesPrice: prices.get(s) ?? null })),
    });
  } catch (err) {
    console.error("[sampleStyles] GET /by-journey", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/sample-styles  — cross-journey list (R&D board).
router.get("/", salesAuth, async (req, res) => {
  try {
    const q = { isActive: true };
    if (req.query.journeyRef) {
      const j = await loadJourney(req.query.journeyRef);
      if (!j) return res.json({ success: true, sampleStyles: [] });
      q.journeyId = j._id;
    }
    if (req.query.status) q.status = req.query.status;
    if (req.query.stage) {
      const list = String(req.query.stage).split(",").map((s) => s.trim()).filter(Boolean);
      q.stage = list.length > 1 ? { $in: list } : list[0];
    }
    // `sampleType=house` is what the Sales -> Sampling board asks for. Legacy
    // rows predate the field and have no value at all, so "journey" has to
    // match those too — filtering on the bare string would hide every style
    // raised before 31 Aug 2026.
    if (req.query.sampleType === "house") {
      q.sampleType = "house";
    } else if (req.query.sampleType === "journey") {
      q.sampleType = { $ne: "house" };
    }

    const docs = await SampleStyle.find(q)
      .sort({ updatedAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 500, 1000))
      .populate("journeyId", "journeyId name")
      .lean();

    // Bug fix (19 Aug 2026): this list never resolved the customer at all —
    // GET /:id and GET /by-journey/:journeyRef both look it up via decorate(),
    // this cross-journey list (the R&D board/overview) just never did, so
    // every card read "—" for the customer regardless of what was on record.
    // Batched, not per-row: R&D's board can show hundreds of styles across a
    // handful of accounts.
    const accountIds = [...new Set(docs.map((d) => d.accountId).filter(Boolean).map(String))];
    const accounts = accountIds.length
      ? await Account.find(await scoped(req, { _id: { $in: accountIds } })).select("accountId companyName displayName").lean()
      : [];
    const accountById = new Map(accounts.map((a) => [String(a._id), a]));

    const sampleStyles = docs.map((d) => {
      const account = d.accountId ? accountById.get(String(d.accountId)) : null;
      return {
        ...d,
        journeyId: d.journeyId?._id || d.journeyId,
        journeyRef: d.journeyId?.journeyId || null,
        journeyName: d.journeyId?.name || null,
        customerName: account ? account.displayName || account.companyName : null,
        customerCode: account?.accountId || null,
      };
    });
    return res.json({ success: true, sampleStyles });
  } catch (err) {
    console.error("[sampleStyles] GET /", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/sample-styles/:id
router.get("/:id", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    return res.json({ success: true, sampleStyle: await withJourney(style, req) });
  } catch (err) {
    console.error("[sampleStyles] GET /:id", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// A client-supplied materials.rawItems array, cleaned to what the schema
// accepts. quantity is genuinely optional here — the Merchandiser is often
// picking WHAT'S needed before anyone has measured HOW MUCH — so unlike
// consumptionRawItems' submit sanitizer, this does not filter rows out for
// lacking one.
// Quantity is REQUIRED here (24 Aug 2026, explicit reversal of an earlier
// "optional" call — "don't keep it optional"). The frontend table already
// blocks Save until every row has one; this is the backend's own copy of
// that same rule, thrown as a real error rather than silently dropping a
// row someone typed, in case anything ever calls this route directly.
/**
 * The Merchandiser's materials pick — A SHORTLIST, NOT A BILL OF MATERIALS.
 *
 * ── THE OWNERSHIP THIS CORRECTS ─────────────────────────────────────────────
 * This used to REFUSE a row without a quantity, so Merchandising had to type
 * one for every material they selected. That figure was then read downstream
 * as the final per-garment consumption and displayed as an established fact —
 * "0.2625 kg + 5%" — when nobody had measured the garment. Merchandising
 * selects WHICH materials; R&D establishes WHAT EACH ONE CONSUMES, in the
 * structured technical record, and that is the only place consumption and
 * allowance are now recorded.
 *
 * So a quantity is neither required nor stored on a new pick. Rows already in
 * the database keep theirs untouched — this is the write path, not a
 * migration, and rewriting history to match a corrected process would destroy
 * the record of what was actually done.
 */
/**
 * What leaves the server for one packaging selection.
 *
 * An allowlist rather than the stored row: this record must never carry a
 * quantity, a rate or a supplier, and publishing it wholesale would make that
 * a convention instead of a fact.
 */
function publicPackagingSelection(r) {
  return {
    rowId: String(r.rowId || ""),
    rawItemId: String(r.rawItemId || ""),
    rawItemName: r.rawItemName || "",
    rawItemSku: r.rawItemSku || "",
    specification: r.specification || "",
    status: r.status || "proposed",
    selectedByName: r.selectedBy?.name || "",
    selectedAt: r.selectedAt || null,
    withdrawnReason: r.withdrawnReason || "",
    withdrawnAt: r.withdrawnAt || null,
  };
}

function sanitizeMaterialsRawItems(input) {
  if (!Array.isArray(input)) return [];
  const rows = input.filter((r) => r && isObjectId(r.rawItemId));
  return rows.map((r) => ({
    rawItemId: r.rawItemId,
    rawItemName: String(r.rawItemName || "").trim(),
    rawItemSku: String(r.rawItemSku || "").trim(),
    variantId: isObjectId(r.variantId) ? r.variantId : undefined,
    variantCombination: Array.isArray(r.variantCombination) ? r.variantCombination.filter(Boolean) : [],
    productVariantId: isObjectId(r.productVariantId) ? r.productVariantId : undefined,
    productVariantLabel: String(r.productVariantLabel || "").trim(),
    /* Deliberately NOT carried: `quantity` and `unit` are R&D's to establish.
       A value sent here is dropped rather than refused, so an older client
       still saves its selection instead of failing on a field it should not
       have been collecting. */
  }));
}

// Apply the Merchandiser's variant-wise picks onto the linked stock item's
// BOM — the same "corresponding product" the sample-approval sync (see the
// `approve` action on POST /:id/sample) targets, so the two never disagree
// about which product this style is developing into. A row with no
// productVariantId applies to every variant (a trim like a button usually
// doesn't vary by size); one WITH it replaces only that variant's rawItems.
//
// PRICING GOES THROUGH processVariantRawItems, the Inventory module's own
// resolver, not a local copy (24 Aug 2026 bug fix — "the pricing or like
// some data are not gonna put properly in the stock item hence it is showing
// 0 rupees"). The local copy this replaced only looked at a variant's vendor
// alias prices and then sellingPrice, skipping the stock-transaction
// fallbacks (last priced ADD / PURCHASE_ORDER, variant-scoped then
// item-wide) that the real resolver walks — so an item priced only by its
// purchase history resolved to ₹0 here while the Stock Item page priced it
// correctly. One resolver means the two can no longer disagree. Safe to
// call now that quantity is mandatory on every materials pick
// (sanitizeMaterialsRawItems throws without one), which is the only reason
// the local copy existed: processVariantRawItems drops rows with no
// positive quantity.
// `stockItemBom` (a StockItem's bill of materials, flattened and de-duped
// across variants) moved to services/sampleStyleEmail.service.js on 28 Aug
// 2026 and is imported from there now — the BOM-approval email and decision
// page needed the EXACT SAME computation this route's own GET /:id/production
// already used, and a second copy is how the two silently drifted the first
// time (the email was built against `style.materials.rawItems`, a dead field,
// while this route was already reading the real thing from the stock item).

async function syncMaterialsRawItems(style, picks) {
  if (!Array.isArray(picks) || !picks.length) return;
  const targetStockItemId = style.production?.stockItemId || style.sourceStockItemId;
  if (!targetStockItemId) return;
  try {
    const stockItem = await StockItem.findById(targetStockItemId);
    if (!stockItem) return;
    const forAll = picks.filter((r) => !r.productVariantId);
    const byVariant = new Map();
    for (const r of picks) {
      if (!r.productVariantId) continue;
      const key = String(r.productVariantId);
      if (!byVariant.has(key)) byVariant.set(key, []);
      byVariant.get(key).push(r);
    }
    for (const v of stockItem.variants) {
      const rows = [...forAll, ...(byVariant.get(String(v._id)) || [])];
      if (!rows.length) continue;
      v.rawItems = await processVariantRawItems(rows.map((r) => ({
        rawItemId: r.rawItemId, variantId: r.variantId,
        variantCombination: r.variantCombination, unit: r.unit,
        // No allowance on a materials pick — the Merchandiser types the
        // quantity actually needed, and processVariantRawItems would
        // otherwise inflate it by an allowance nobody entered.
        requiredQuantity: r.quantity, allowancePercent: 0,
      })));
    }
    // Cost follows the BOM — without this the rows land priced but the
    // variant keeps reporting ₹0. See recomputeVariantCostsFromBom.
    recomputeVariantCostsFromBom(stockItem);
    updateStockItemAggregates(stockItem);
    await stockItem.save();
  } catch (syncErr) {
    console.error("[sampleStyles] materials → stock item sync failed:", syncErr);
  }
}

// PATCH /api/cms/crm/sample-styles/:id/materials  — Merchandiser/PM input.
//
// TWO PATHS (19 Aug 2026, same rule as costing — "anyone can fill anything",
// approval moved to a log):
//   Sales / admin / CEO   → applies immediately, straight onto `materials`.
//   Merchandiser / IE/PM  → never writes `materials` directly. The submission
//                           is appended to `materialsChangeLog` as a
//                           `status: "pending"` entry instead; Sales decides
//                           below. This was the actual bug report: this route
//                           used to apply EVERY caller's edit immediately, so
//                           Style & Sample had no approval step at all even
//                           though Enquiry/RFQ's costing already did.
router.patch("/:id/materials", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    /* ── THE COMPANY, PROVED BEFORE ANYTHING IS WRITTEN ──────────────────
       This route had no company check at all: `resolveStyle` matches by id
       alone, so a style id from another company's books resolved and was then
       mutated.

       ── AND THIS IS LEGACY SALES COMPATIBILITY, NOT A MERCHANDISING DOOR ─
       Material and trim selection IS a Merchandising-owned fact. This route is
       not a Merchandising endpoint: it is authorised by `salesAuth`, its
       direct-apply path is open to whoever `bypassesApproval` admits — Sales,
       an admin, the CEO — and everybody else's write is staged for a SALES
       decision. That is the pre-existing arrangement, and it is unchanged.

       Nothing under `app/merchandiser/**` calls it; the Merchandising client
       cannot reach it at all. It is kept for the Sales Style & Sample stage
       that does, and the legacy Sales authority over a Merchandising-owned
       fact is recorded as migration debt rather than described as closed.
       Adding a Merchandising grant here would break that Sales screen, which
       is a migration and not this correction's to make.

       What was added is a tenancy proof and nothing else — the same authority,
       the same callers, their own company. */
    const scope = await salesScopeFor(req);
    if (!(await ownershipProofFor(style, scope.companyId))) {
      return res.status(404).json({ success: false, message: "Style not found." });
    }

    const items = Array.isArray(req.body.items)
      ? req.body.items.map((x) => String(x).trim()).filter(Boolean)
      : [];
    const rawItems = sanitizeMaterialsRawItems(req.body.rawItems);
    // No raw items required (26 Aug 2026, explicit request: "don't make the
    // restriction for filling the raw items over here... the sales person
    // can also skip this part") — an explicit skip resolves materials as
    // done-with-nothing-picked, distinct from a form nobody has touched.
    const skip = req.body.skip === true;

    if (!bypassesApproval(req.user)) {
      style.materialsChangeLog = [
        ...(style.materialsChangeLog || []),
        { items, rawItems, skip, status: "pending", submittedBy: actor(req), submittedAt: new Date() },
      ];
      await style.save();

      (async () => {
        const [customerName, image] = await Promise.all([customerNameFor(style, req), referenceImageFor(style, req)]);
        await notifyEvent("materials_change_requested", {
          heading: `Materials change requested: ${style.productName || style.styleCode || ""}`,
          bodyHtml: `<p><strong>${escapeHtml(actor(req).name || "Merchandising")}</strong> proposed a materials change for this style, needing your review.</p>`,
          details: [
            ["Customer", customerName],
            ["Style", style.styleCode || style.sampleStyleId],
            ["Product", style.productName],
            ["Proposed materials", items.join(", ")],
          ],
          image,
          bodyText: `${actor(req).name || "Merchandising"} proposed a materials change for "${style.productName || "a style"}" (${customerName}): ${items.join(", ")}.`,
          ctaLabel: "Review change",
          ctaUrl: styleSampleUrl(style),
        });
      })().catch(() => {});

      return res.status(202).json({
        success: true,
        pending: true,
        message: "Submitted for approval — your sales contact will review it.",
      });
    }

    const prevItems = style.materials.items || [];
    style.materials.status = (items.length || skip) ? "selected" : "pending";
    style.materials.items = items;
    style.materials.rawItems = rawItems;
    style.materials.selectedBy = actor(req);
    style.materials.selectedAt = new Date();
    style.updatedBy = actor(req);
    // Direct-apply path had no history entry at all until now — only the
    // staged (Merchandiser/IE) path below logged anything, so a Sales/admin
    // user setting materials directly left no trace (21 Aug 2026, explicit
    // request for "what information he changed", not just "materials set").
    logHistory(style, { kind: "materials_set", note: items.join(", ") || "cleared", from: prevItems.join(", "), to: items.join(", ") }, req);
    await style.save();
    await syncMaterialsRawItems(style, rawItems);
    return res.json({ success: true, sampleStyle: await withJourney(style, req) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error("[sampleStyles] PATCH /:id/materials", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/sample-styles/:id/materials/change/:changeId/decide
// Sales/admin/CEO approves or rejects one pending materialsChangeLog entry.
// Approve copies the submitted items onto the live `materials`; reject just
// marks it decided and changes nothing live.
router.post("/:id/materials/change/:changeId/decide", salesAuth, async (req, res) => {
  try {
    if (!bypassesApproval(req.user)) {
      return res.status(403).json({ success: false, message: "Only Sales, an admin or the CEO can decide a submitted change." });
    }
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    /* ── AND THE DECISION IS SCOPED TOO ──────────────────────────────────
       The same gap as the two routes above, on the route that APPROVES what
       they staged: a Sales, admin or CEO caller could decide a materials
       change on a style in another company's books. The authority is
       unchanged and still Sales' — only the books it reaches are. */
    const scope = await salesScopeFor(req);
    if (!(await ownershipProofFor(style, scope.companyId))) {
      return res.status(404).json({ success: false, message: "Style not found." });
    }

    const decision = String(req.body?.decision || "").trim();
    if (!["approve", "reject"].includes(decision)) {
      return res.status(400).json({ success: false, message: 'decision must be "approve" or "reject".' });
    }

    const entry = (style.materialsChangeLog || []).id(req.params.changeId);
    if (!entry) return res.status(404).json({ success: false, message: "That submitted change could not be found." });
    if (entry.status !== "pending") return res.status(400).json({ success: false, message: `This change was already ${entry.status}.` });

    if (decision === "approve") {
      const prevItems = style.materials.items || [];
      style.materials.status = (entry.items.length || entry.skip) ? "selected" : "pending";
      style.materials.items = entry.items;
      style.materials.rawItems = entry.rawItems || [];
      style.materials.selectedBy = actor(req);
      style.materials.selectedAt = new Date();
      logHistory(style, { kind: "materials_set", note: entry.items.join(", ") || "cleared", from: prevItems.join(", "), to: entry.items.join(", ") }, req);
    } else {
      logHistory(style, { kind: "materials_change_rejected", note: entry.items.join(", ") }, req);
    }

    entry.status = decision === "approve" ? "approved" : "rejected";
    entry.decidedBy = actor(req);
    entry.decidedAt = new Date();
    style.updatedBy = actor(req);
    await style.save();
    if (decision === "approve") await syncMaterialsRawItems(style, entry.rawItems || []);
    return res.json({ success: true, status: entry.status, sampleStyle: await withJourney(style, req) });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/materials/change/:changeId/decide", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/sample-styles/:id/stage  { stage } — route the style
// across the kanban (brief → merchandiser → rnd). Sending to R&D is what makes
// it appear in the R&D app; entering products alone does not.
router.patch("/:id/stage", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    /* ── THE COMPANY, PROVED BEFORE ANYTHING IS WRITTEN ──────────────────
       This route had no company check at all: `resolveStyle` matches by id
       alone, so a style id from another company's books resolved and was then
       mutated.

       ── AND IT IS STILL SALES' ROUTE ───────────────────────────────────
       Routing a style — sending it to the Merchandiser, sending it on to R&D,
       pulling it back to the brief — is Sales' act, and the handler below says
       so itself: `materials → rnd` is refused to anybody but Sales, an admin
       or the CEO. That the result HANDS WORK TO Merchandising does not make it
       a Merchandising mutation, and it deliberately does NOT require a
       Merchandising grant. What was added here is a tenancy proof and nothing
       else: the same authority acts on the same styles, in their own company.

       Scoped through `salesScopeFor`, the resolution every other route in this
       file already uses, so a genuine same-company Sales caller is unaffected.
       Foreign and missing stay one answer. */
    const scope = await salesScopeFor(req);
    if (!(await ownershipProofFor(style, scope.companyId))) {
      return res.status(404).json({ success: false, message: "Style not found." });
    }
    const { stage } = req.body;
    if (!SAMPLE_STYLE_STAGE_CODES.includes(stage)) return res.status(400).json({ success: false, message: "Invalid stage." });

    const from = style.stage;
    // "materials" → "rnd" ("Send to R&D") is routing, Sales' call — the
    // Merchandiser's job in this stage is filling materials, not sending the
    // style on (19 Aug 2026, bug fix: the button was hidden from their
    // dashboard, but nothing here stopped the same request being made
    // directly, which the UI-only fix wouldn't have actually closed).
    if (from === "materials" && stage === "rnd" && !bypassesApproval(req.user)) {
      return res.status(403).json({ success: false, message: "Only Sales, an admin or the CEO can send a style to R&D." });
    }
    // The Project Manager's BOM sign-off gates R&D (28 Aug 2026, explicit
    // request: "once approved, then only the next step means the send to R&D
    // button will goona enable"). Enforced here and not only by the disabled
    // button, for the same reason the Sales-only check above is: the UI gate
    // and the request are two different things, and only one of them is
    // something a caller can't skip.
    if (from === "materials" && stage === "rnd" && style.bomApproval?.status !== "approved") {
      return res.status(400).json({
        success: false,
        message: style.bomApproval?.status === "pending"
          ? "The Project Manager hasn't decided on the BOM yet."
          : style.bomApproval?.status === "rejected"
            ? "The Project Manager rejected this BOM — send the approval request again once it's revised."
            : "Get the Project Manager's BOM approval before sending this style to R&D.",
      });
    }
    const backward = (STAGE_ORDER[stage] ?? 0) < (STAGE_ORDER[from] ?? 0);
    const reason = (req.body.reason || "").trim();
    if (backward && !reason) return res.status(400).json({ success: false, message: "A reason is required when sending a style back." });

    // Optional target date for the Merchandiser to fill the BOM by (28 Aug
    // 2026, explicit request: "an input need to ask for the sales while
    // click for the sent to merchantiser... do u want to set deadline... this
    // is optional"). Only meaningful on the actual Send-to-Merchandiser
    // transition below — parsed here so a bad value 400s before anything is
    // written.
    let deadline;
    if (req.body?.deadline) {
      const d = new Date(req.body.deadline);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ success: false, message: "Invalid deadline." });
      deadline = d;
    }

    // A backward move invalidates the downstream work.
    if (backward) {
      if (stage === "materials" || stage === "brief") { resetTech(style); resetSample(style); }
      if (stage === "brief") { style.materials.status = "pending"; style.materials.deadline = undefined; }
      // Pulled back to the Brief, the BOM sign-off is void too: it approved a
      // materials picture that is about to be rebuilt from a re-sent brief.
      // Rotating the token kills any decision link still sitting in the
      // Project Manager's inbox.
      if (stage === "brief" && style.bomApproval) {
        style.bomApproval.status = "none";
        style.bomApproval.token = undefined;
        style.bomApproval.decidedAt = null;
        style.bomApproval.note = "";
        style.bomApproval.deadline = undefined;
      }
    }

    if (stage === "materials" && from === "brief") style.materials.deadline = deadline;

    style.stage = stage;
    logHistory(style, { kind: backward ? "send_back" : "route", from, to: stage, note: reason }, req);
    style.updatedBy = actor(req);
    await style.save();

    // "Sending to R&D is what makes it appear in the R&D app" (see this
    // route's own header comment) — R&D otherwise has no way to know a style
    // is waiting for them short of opening the app and checking. Only on the
    // actual transition INTO rnd, never a redundant re-save at the same
    // stage. Best-effort, never awaited: an email failing must not affect
    // the routing that just succeeded.
    // Step 1 — "Send to Merchandiser" (brief → materials). Until 28 Aug 2026
    // this hand-off notified nobody at all: Sales pressed the button and the
    // Merchandiser found out by opening the app and noticing. Now it carries
    // the actual ask — fill the BOM against this product — with the customer,
    // the full spec, the reference photos and a View button straight onto the
    // finished good.
    if (stage === "materials" && from === "brief") {
      (async () => {
        const c = await styleEmailContext(style, await sampleEmailScope(req));
        const salesPerson = actor(req).name || "Sales";
        await notifyEvent("sample_sent_to_merchandiser", {
          vars: { product: style.productName || "", customer: c.customerName, salesPerson, styleCode: style.styleCode || style.sampleStyleId || "" },
          heading: `Sampling request: ${style.productName || style.styleCode || ""}`,
          bodyHtml: `<p><strong>${escapeHtml(salesPerson)}</strong> raised a sampling request for this product. Please fill in the BOM / raw materials against it.</p>`,
          details: [
            ...c.details,
            ["BOM needed by", style.materials?.deadline ? new Date(style.materials.deadline).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : undefined],
          ],
          image: c.images[0],
          extraHtml: imageGalleryHtml(c.images),
          bodyText: `${salesPerson} raised a sampling request for "${style.productName || "a style"}" (${c.customerName}). Please fill in the BOM / raw materials against this product.`,
          ctaLabel: "View Product",
          ctaUrl: c.viewUrl || `${DEPT_NOTIFY_APP_URL}/merchandiser/dashboard`,
        });
      })().catch(() => {});
    }

    // Step 3 — "Send to R&D" (materials → rnd), now only reachable once the
    // Project Manager has approved the BOM above.
    if (stage === "rnd" && from !== "rnd") {
      (async () => {
        const c = await styleEmailContext(style, await sampleEmailScope(req));
        const salesPerson = actor(req).name || "Sales";
        const approver = style.bomApproval?.decidedByName || style.bomApproval?.decidedByEmail || "";
        await notifyEvent("sample_sent_to_rnd", {
          vars: {
            product: style.productName || "", customer: c.customerName, salesPerson,
            styleCode: style.styleCode || style.sampleStyleId || "",
            approvedBy: approver ? ` (${approver})` : "",
          },
          heading: `Style sent to R&D: ${style.productName || style.styleCode || ""}`,
          bodyHtml: `<p><strong>${escapeHtml(salesPerson)}</strong> sent this style to R&D for tech-pack / development.</p>`,
          details: [
            ...c.details,
            ["Materials", (style.materials?.items || []).join(", ") || undefined],
            ["BOM approved by", approver || undefined],
          ],
          image: c.images[0],
          extraHtml: imageGalleryHtml(c.images),
          bodyText: `${salesPerson} sent "${style.productName || "a style"}" (${c.customerName}) to R&D for tech-pack / development.`,
          ctaLabel: "Open in R&D",
          ctaUrl: `${DEPT_NOTIFY_APP_URL}/research-development/dashboard`,
        });
      })().catch(() => {});
    }

    return res.json({ success: true, sampleStyle: await withJourney(style, req) });
  } catch (err) {
    console.error("[sampleStyles] PATCH /:id/stage", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/sample-styles/:id/reset — "Reset Process" (28 Aug 2026,
// explicit request: "keep an button for Reset Process, so that that product
// all steps will goona reset and will goona start form step 1").
//
// Distinct from an ordinary backward move to Brief (PATCH /:id/stage above,
// which the reject/send-back flows already use) in two ways:
//   • it ALSO clears the Sales-side customer-approval decision (step 5) —
//     a backward move to Brief never touched that, and "all steps" means the
//     whole five-step process, not just steps 2 through 4.
//   • it is logged under its own history kind, "reset_process", not
//     "send_back" — the audit trail should say a deliberate full reset
//     happened, not read like a routine correction.
//
// EVIDENCE IS NEVER DELETED. Same principle every other reset in this file
// already follows (resetTech/resetSample, the backward-move block above):
// only the STATUS fields that gate what happens next go back to their
// starting value. Sample rounds, tech-sheet revisions, the BOM approval's own
// history entries and customerApproval.log all stay exactly as they were —
// what a "reset" clears is what to do next, not what already happened.
router.post("/:id/reset", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    // Same authority as every other routing act in this file — resetting
    // someone else's in-progress work is not a call a Merchandiser, R&D, or a
    // plain sales editor watching the journey should be able to make alone.
    if (!bypassesApproval(req.user)) {
      return res.status(403).json({ success: false, message: "Only Sales, an admin or the CEO can reset this style." });
    }

    const from = style.stage;
    resetTech(style);
    resetSample(style);
    style.materials.status = "pending";
    if (style.bomApproval) {
      style.bomApproval.status = "none";
      style.bomApproval.token = undefined;
      style.bomApproval.round = 0;
      style.bomApproval.requestedAt = null;
      style.bomApproval.requestedTo = [];
      style.bomApproval.decidedAt = null;
      style.bomApproval.decidedByName = "";
      style.bomApproval.decidedByEmail = "";
      style.bomApproval.note = "";
    }
    // Step 5's own decision, cleared the same way — `log` (the append-only
    // history the chat UI reads) is left untouched.
    if (style.customerApproval) {
      style.customerApproval.approved = null;
      style.customerApproval.decidedAt = null;
      style.customerApproval.note = "";
    }
    style.customerRejected = false;
    style.stage = "brief";

    logHistory(style, { kind: "reset_process", from, to: "brief", note: (req.body?.reason || "").trim() }, req);
    style.updatedBy = actor(req);
    await style.save();

    return res.json({ success: true, sampleStyle: await withJourney(style, req) });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/reset", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/sample-styles/:id/bom-approval/request
//
// Step 2 of Style & Sample — "Send Request for BOM Approval" (28 Aug 2026).
// Emails the Project Manager the full style with Approve / Reject controls
// they act on FROM the email; the decision lands back here through
// routes/CMS_Routes/Sales/sampleBomApproval.js and flips the gate on its own,
// which is why this stage has no manual "mark approved" button anywhere ("if
// approve then it will goona auto trigger here... don't keep manual button
// here for production manager approval").
//
// Re-sendable: after a rejection the stage offers "Send Approval Again", and
// that is this same route. Each send mints a NEW token, which is what makes
// the previous round's emailed links stop working.
router.post("/:id/bom-approval/request", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    // Same authority as sending to R&D — this is the step immediately before
    // it, and asking for sign-off on someone else's behalf is a routing act.
    if (!bypassesApproval(req.user)) {
      return res.status(403).json({ success: false, message: "Only Sales, an admin or the CEO can request BOM approval." });
    }
    if (style.stage !== "materials") {
      return res.status(400).json({ success: false, message: "Send the style to the Merchandiser first." });
    }
    if (style.bomApproval?.status === "approved") {
      return res.status(400).json({ success: false, message: "The BOM is already approved for this style." });
    }

    // Optional target date for the Project Manager's decision (28 Aug 2026,
    // explicit request: "an input need to ask for the sales while click...
    // for sent request for BOM approval... do u want to set deadline... this
    // is optional"). Informational only — nothing here enforces it.
    let deadline;
    if (req.body?.deadline) {
      const d = new Date(req.body.deadline);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ success: false, message: "Invalid deadline." });
      deadline = d;
    }

    const token = crypto.randomBytes(24).toString("hex");
    const prevRound = style.bomApproval?.round || 0;
    style.bomApproval = {
      status: "pending",
      token,
      round: prevRound + 1,
      requestedAt: new Date(),
      requestedBy: actor(req),
      requestedTo: [],
      decidedAt: null,
      decidedByName: "",
      decidedByEmail: "",
      note: "",
      deadline,
    };

    const c = await styleEmailContext(style, await sampleEmailScope(req));
    const salesPerson = actor(req).name || "Sales";
    const decideBase = `${API_PUBLIC_URL}/api/public/bom-approval/${style._id}/${token}`;

    // Awaited, unlike the fire-and-forget notifications elsewhere in this file:
    // the whole point of the button is that the request went out, so "sent to
    // 2 people" vs "nobody holds Project Manager as their primary department"
    // has to reach the salesperson who pressed it, not just the server log.
    const result = await notifyEvent("sample_bom_approval_requested", {
      vars: {
        product: style.productName || "", customer: c.customerName, salesPerson,
        styleCode: style.styleCode || style.sampleStyleId || "",
      },
      heading: `BOM approval required: ${style.productName || style.styleCode || ""}`,
      bodyHtml: `<p><strong>${escapeHtml(salesPerson)}</strong> requests your approval of the Bill of Materials for this product.</p>`,
      details: [
        ...c.details,
        ["Requested by", salesPerson],
        ["Decision needed by", deadline ? deadline.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : undefined],
      ],
      image: c.images[0],
      // The decision pair sits ABOVE the View button on purpose: the action
      // this email is asking for is the decision, not a visit to the CMS.
      // The BOM table itself (28 Aug 2026, explicit request — this used to ask
      // for a sign-off on a Bill of Materials without showing one) sits ABOVE
      // the decision pair: read what you're deciding, then decide.
      extraHtml: `${imageGalleryHtml(c.images)}
${bomTableHtml(c.bom, c.variantTotal)}
<p style="margin:20px 0 8px;font-size:13.5px;color:#0f172a"><strong>Please record your decision:</strong></p>
<p style="margin:0 0 4px">
  <a href="${decideBase}?d=approve" style="display:inline-block;background:#15803d;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;margin-right:8px">Approve BOM</a>
  <a href="${decideBase}?d=reject" style="display:inline-block;background:#b91c1c;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600">Reject BOM</a>
</p>
<p style="font-size:12px;color:#888;margin:6px 0 0">You'll be asked to confirm on the next screen — nothing is recorded by opening this link.</p>`,
      bodyText: `${salesPerson} requests your approval of the BOM for "${style.productName || "a style"}" (${c.customerName}). Approve: ${decideBase}?d=approve — Reject: ${decideBase}?d=reject`,
      ctaLabel: "View Product",
      // Falls back to the Project Manager's OWN dashboard, not Merchandising's
      // — this recipient has no reason to land on a dashboard that isn't theirs
      // just because the style has no linked stock item yet.
      ctaUrl: c.viewUrl || `${DEPT_NOTIFY_APP_URL}/project-manager/dashboard`,
    });

    // Nobody to ask means nothing is pending — leaving the style parked on
    // "waiting for the Project Manager" when no email was sent is exactly
    // the dead end this whole gate would otherwise create.
    if (!result?.sent) {
      style.bomApproval.status = "none";
      style.bomApproval.token = undefined;
      await style.save();
      const why = result?.skipped === "no-recipients"
        ? "Nobody has Project Manager as their primary department in Access Control, so there's no one to ask."
        : result?.skipped === "disabled" || result?.skipped === "template-disabled"
          ? "BOM approval emails are switched off in Sales Settings → Sampling Messages."
          : "The approval email could not be sent.";
      return res.status(400).json({ success: false, message: why });
    }

    logHistory(style, { kind: "bom_approval_requested", from: "materials", to: "materials", note: `Round ${style.bomApproval.round}` }, req);
    style.updatedBy = actor(req);
    await style.save();

    return res.json({ success: true, sentTo: result.sent, sampleStyle: await withJourney(style, req) });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/bom-approval/request", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/sample-styles/:id/tech-sheet  { action, note?, file? }

/* ═══════════════════════════════════════════════════════════════════════════
   R&D'S STRUCTURED TECHNICAL RECORD
   ═══════════════════════════════════════════════════════════════════════════
   Read, saved and sent back through here. Every route proves the company
   through the style's parent before it answers, exactly as the operation
   picker does — a style id from a browser is not authorisation.
════════════════════════════════════════════════════════════════════════════ */

/** GET /:id/technical — the record, what is missing, and the approved list. */
router.get("/:id/technical", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    const scope = await salesScopeFor(req);
    if (!(await ownershipProofFor(style, scope.companyId))) {
      /* Missing and foreign are one answer. */
      return res.status(404).json({ success: false, message: "Style not found." });
    }

    const technical = style.techSheet?.technical || {};
    const shortlist = await approvedShortlistFor(style);
    const approved = shortlist.rows;
    /* Same gap, on the read side: a sheet opened before this record existed
       has no seeded rows, so the screen would show an empty form for a style
       with an approved shortlist. Seeded for DISPLAY only — nothing is
       written until R&D actually saves.

       Re-merged even when rows DO exist, so a material added to the finished
       good after the record was seeded appears rather than being invisible
       until somebody restarts the sheet. R&D's saved facts survive the merge
       — `mergeOntoApproved` matches them on by identity. */
    const sheetOpen = ["in_progress", "changes"].includes(style.techSheet?.status);
    const displayMaterials = sheetOpen || !(technical.materials || []).length
      ? technicalRecord.mergeOntoApproved(approved, technical.materials || []).rows
      : (technical.materials || []);
    const gate = technicalRecord.completeness(
      { ...technical, materials: displayMaterials },
      { file: style.techSheet?.file, approvedMaterialCount: approved.length, shortlistBlocker: shortlist.blocker },
    );

    return res.json({
      success: true,
      technical: {
        status: technical.status || technicalRecord.STATUS.NOT_STARTED,
        revision: technical.revision || 0,
        editable: technicalRecord.EDITABLE.includes(technical.status)
          || ((!technical.status || technical.status === technicalRecord.STATUS.NOT_STARTED) && sheetOpen),
        materials: displayMaterials,
        operations: technical.operations || [],
        requirements: technical.requirements || [],
      },
      /* The shortlist, as identity only — so the screen can show what
         Merchandising selected without implying a consumption. */
      approvedMaterials: approved.map((r) => ({
        rawItemId: String(r.rawItemId || ""),
        rawItemName: r.rawItemName || "",
        rawItemSku: r.rawItemSku || "",
        variantId: r.variantId ? String(r.variantId) : null,
        variantCombination: r.variantCombination || [],
        appliesToVariantLabels: r.appliesToVariantLabels || [],
      })),
      /* Named, so a reader can tell an authoritative BOM from a legacy pick
         without guessing — and so a style with neither says whose step is
         outstanding instead of blaming R&D for an empty form. */
      shortlistSource: shortlist.source,
      shortlistBlocker: shortlist.blocker,
      techSheet: {
        status: style.techSheet?.status || "pending",
        file: style.techSheet?.file || null,
      },
      completeness: gate,
      /* Frozen history, without the snapshots — a list of what happened, not
         a payload nobody asked for. */
      revisions: (style.techSheet?.technicalRevisions || []).map((r) => ({
        revision: r.revision, submittedAt: r.submittedAt,
        submittedBy: r.submittedBy?.name || "", outcome: r.outcome,
        decidedAt: r.decidedAt || null, decidedBy: r.decidedBy?.name || "",
        decisionNote: r.decisionNote || "",
      })),
      families: technicalRecord.REQUIREMENT_FAMILIES,
    });
  } catch (err) {
    console.error("[sampleStyles] GET /:id/technical", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PUT /:id/technical — save the draft.
 *
 * ── WHAT THE BODY MAY AND MAY NOT DECIDE ────────────────────────────────────
 * It may carry R&D's own facts. It may NOT carry a material identity: the rows
 * are rebuilt from the approved shortlist and the submission is matched onto
 * them, so a body naming a raw item the BOM does not hold contributes nothing
 * and is reported back as rejected. That is the substitution this refuses —
 * silently accepting it would let R&D swap the material with no trace.
 */
router.put("/:id/technical", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    const scope = await salesScopeFor(req);
    if (!(await ownershipProofFor(style, scope.companyId))) {
      return res.status(404).json({ success: false, message: "Style not found." });
    }

    style.techSheet = style.techSheet || {};
    style.techSheet.technical = style.techSheet.technical || {};
    const t = style.techSheet.technical;

    /* ── A SHEET ALREADY OPEN WHEN THIS RECORD DID NOT EXIST ──────────
       Starting the tech sheet is what seeds the record, so every style whose
       sheet was already in progress before this feature shipped has an
       open sheet and a `not_started` record — and no way to reach one,
       because `start` only fires from `pending`. Seeded here instead, the
       first time R&D saves, from the approved shortlist exactly as `start`
       would have. Only while the SHEET is genuinely open: this is a gap
       being closed, not a way to reopen a submitted or approved record. */
    const sheetOpen = ["in_progress", "changes"].includes(style.techSheet.status);
    if ((!t.status || t.status === technicalRecord.STATUS.NOT_STARTED) && sheetOpen) {
      t.status = technicalRecord.STATUS.DRAFT;
      t.startedAt = t.startedAt || new Date();
      t.startedBy = t.startedBy || actor(req);
      t.revision = t.revision || 0;
      t.operations = t.operations || [];
      t.requirements = t.requirements || [];
    }

    /* Only R&D's own in-progress or returned record is writable. A submitted
       one is with Sales and an approved one is what a costing may have read;
       both are refused rather than quietly reopened. */
    if (!technicalRecord.EDITABLE.includes(t.status)) {
      return res.status(409).json({
        success: false,
        code: "TECHNICAL_RECORD_NOT_EDITABLE",
        message: t.status === technicalRecord.STATUS.SUBMITTED
          ? "This technical record is with Sales. It can be edited again if they send it back."
          : t.status === technicalRecord.STATUS.APPROVED
            ? "This technical record is approved. Sales must return it before it can be changed."
            : "Start the tech sheet before recording technical facts.",
        status: t.status || technicalRecord.STATUS.NOT_STARTED,
      });
    }

    /* ── IDENTITY COMES FROM THE APPROVED BOM, NOT THE BODY ─────────────
       The SAME resolver the GET and the screen read, so what R&D is asked to
       complete and what a save will accept can never differ. */
    const shortlist = await approvedShortlistFor(style);
    const { rows, rejected } = technicalRecord.mergeOntoApproved(
      shortlist.rows,
      Array.isArray(req.body?.materials) ? req.body.materials : [],
    );
    /* A send-back already recorded on a stored row survives a save — it is
       its own action, with its own actor and reason. */
    const storedByKey = new Map((t.materials || []).map((m) => [technicalRecord.identityKey(m), m]));
    t.materials = rows.map((r) => {
      const prior = storedByKey.get(technicalRecord.identityKey(r));
      return prior?.returnedToMaterials?.reason
        ? { ...r, returnedToMaterials: prior.returnedToMaterials }
        : r;
    });

    /* ── THE ROUTE IS NOT WRITTEN HERE ANY MORE ────────────────────────
       Which operations a garment goes through, in what order, and how long
       each takes is Production's, and it has its own door:
       PUT /api/cms/production/style-route/styles/:styleId/route.

       `t.operations` is left EXACTLY as it stands — not cleared, not rebuilt
       from the body, not defaulted to empty. A save from R&D's form must not
       wipe a route somebody else recorded, and rebuilding it from a body that
       no longer owns it would do precisely that.

       An `operations` key in the body is IGNORED rather than refused. R&D's
       own screen still renders the route (read-only, as technical context)
       and its payload still echoes what it was given; refusing that would
       break every legitimate save over a field nobody was trying to change.
       What matters is that nothing here writes it, which the route test
       proves by sending a changed route and reading the stored one back. */

    /* ── REQUIREMENTS MAP TO EXISTING COSTING FAMILIES ─────────────────── */
    t.requirements = (Array.isArray(req.body?.requirements) ? req.body.requirements : [])
      .filter((r) => r && technicalRecord.REQUIREMENT_FAMILIES.includes(r.family) && String(r.name || "").trim())
      .map((r) => ({
        family: r.family,
        name: String(r.name).trim().slice(0, 200),
        specification: String(r.specification || "").trim().slice(0, 2000),
        quantity: Number(r.quantity) > 0 ? Number(r.quantity) : undefined,
        basis: String(r.basis || "").trim(),
        unit: String(r.unit || "").trim(),
        rationale: String(r.rationale || "").trim().slice(0, 1000),
      }));

    style.updatedBy = actor(req);
    await style.save();

    const gate = technicalRecord.completeness(t, {
      file: style.techSheet.file,
      approvedMaterialCount: shortlist.rows.length,
      shortlistBlocker: shortlist.blocker,
    });
    return res.json({
      success: true,
      shortlistSource: shortlist.source,
      shortlistBlocker: shortlist.blocker,
      technical: {
        status: t.status, revision: t.revision || 0, editable: true,
        materials: t.materials, operations: t.operations, requirements: t.requirements,
      },
      completeness: gate,
      /* Said out loud rather than dropped in silence. */
      rejectedMaterials: rejected,
    });
  } catch (err) {
    console.error("[sampleStyles] PUT /:id/technical", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /:id/technical/materials/return — send one material back to Materials.
 *
 * The correction R&D is allowed to make when the wrong item was selected. It
 * is an ACTION with an author and a reason, not an edit: the row stays, so the
 * record shows what was questioned and by whom, and Merchandising re-selects.
 */
router.post("/:id/technical/materials/return", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    const scope = await salesScopeFor(req);
    if (!(await ownershipProofFor(style, scope.companyId))) {
      return res.status(404).json({ success: false, message: "Style not found." });
    }

    const reason = String(req.body?.reason || "").trim();
    if (!reason) {
      /* Without one, Merchandising is told a material is wrong and not what
         is wrong with it — which is a round trip that changes nothing. */
      return res.status(400).json({
        success: false, code: "RETURN_REASON_REQUIRED",
        message: "Say what is wrong with this material before sending it back to Materials.",
      });
    }

    const t = style.techSheet?.technical;
    if (!t || !technicalRecord.EDITABLE.includes(t.status)) {
      return res.status(409).json({
        success: false, code: "TECHNICAL_RECORD_NOT_EDITABLE",
        message: "This technical record is not open for editing.",
      });
    }

    /* Validated against the SAME shortlist: a material can only be sent back
       if it is one R&D was actually asked to complete. A record seeded before
       the resolver existed may not hold the row yet, so the shortlist is what
       decides — and the row is created if the record is behind it. */
    const rawItemId = String(req.body?.rawItemId || "");
    const shortlist = await approvedShortlistFor(style);
    if (!shortlist.rows.some((r) => String(r.rawItemId) === rawItemId)) {
      return res.status(404).json({ success: false, message: "That material is not on this style's approved bill of materials." });
    }
    t.materials = technicalRecord.mergeOntoApproved(shortlist.rows, t.materials || []).rows;
    const row = (t.materials || []).find((m) => String(m.rawItemId) === rawItemId);
    if (!row) return res.status(404).json({ success: false, message: "That material is not on this record." });

    row.returnedToMaterials = { at: new Date(), by: actor(req), reason };
    logHistory(style, {
      kind: "material_returned",
      note: `${row.rawItemName || "A material"} sent back to Materials: ${reason}`,
    }, req);
    style.updatedBy = actor(req);
    await style.save();

    return res.json({
      success: true,
      message: `${row.rawItemName || "The material"} was sent back to Materials.`,
      material: { rawItemId, returnedToMaterials: row.returnedToMaterials },
    });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/technical/materials/return", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/:id/tech-sheet", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });

    const { action } = req.body;
    const cur = style.techSheet.status;
    const can = (next) => (SAMPLE_TECHSHEET_TRANSITIONS[cur] || []).includes(next);
    const invalid = (next) => res.status(400).json({ success: false, message: `Can't move the tech sheet from "${cur}" to "${next}".` });

    if (action === "start") {
      // The "materials must be selected first" precondition is GONE (26 Aug
      // 2026). It guarded a step that no longer exists: raw items used to be
      // picked in Sales' Style & Sample stage, and that form was removed when
      // raw items became read-only there, maintained on the finished good
      // instead. Leaving the check in place would have stranded every style
      // permanently — `materials.status` can no longer reach "selected" from
      // the pipeline, so the tech sheet could never start and nothing could
      // move past it. The bill of materials is R&D's to read off the stock
      // item now, not a gate Sales has to clear on their behalf.
      if (!can("in_progress")) return invalid("in_progress");
      style.techSheet.status = "in_progress";
      if (!style.techSheet.startedAt) style.techSheet.startedAt = new Date();

      /* ── STARTING THE SHEET STARTS THE RECORD ────────────────────────
         Seeded from the APPROVED shortlist, one row per material, carrying
         identity only — R&D fills the facts. Seeding here rather than on
         first save means the screen opens with the real material list
         instead of an empty form somebody has to populate by hand.

         A record already in progress is left exactly as it is: starting a
         sheet twice must not discard work. */
      style.techSheet.technical = style.techSheet.technical || {};
      const t = style.techSheet.technical;
      if (t.status === technicalRecord.STATUS.NOT_STARTED || !t.status) {
        t.status = technicalRecord.STATUS.DRAFT;
        t.startedAt = new Date();
        t.startedBy = actor(req);
        t.revision = t.revision || 0;
        const seed = await approvedShortlistFor(style);
        t.materials = technicalRecord.mergeOntoApproved(seed.rows, []).rows;
        t.operations = t.operations || [];
        t.requirements = t.requirements || [];
      }
    } else if (action === "submit") {
      if (!can("submitted")) return invalid("submitted");

      /* The file first, because the completeness check requires it — the
         record and its evidence are submitted together or not at all. */
      if (req.body.file && (req.body.file.url || req.body.file.name)) {
        style.techSheet.file = { name: req.body.file.name, url: req.body.file.url, uploadedAt: new Date() };
      }

      /* ── THE STRUCTURED RECORD IS THE SUBMISSION ─────────────────────
         The sheet used to be a status flip plus an upload, so a costing
         downstream had a PDF and no facts. What Sales approves now is the
         technical record; the drawing is its evidence.

         Refused rather than warned, and refused BY FIELD AND OWNER — "R&D
         still needs consumption for Shell fabric" is actionable in a way
         that "incomplete" is not. */
      const submitShortlist = await approvedShortlistFor(style);
      const gate = technicalRecord.completeness(style.techSheet.technical || {}, {
        file: style.techSheet.file,
        approvedMaterialCount: submitShortlist.rows.length,
        shortlistBlocker: submitShortlist.blocker,
      });
      if (!gate.complete) {
        return res.status(400).json({
          success: false,
          code: "TECHNICAL_RECORD_INCOMPLETE",
          message: "The technical record is not complete yet.",
          gaps: gate.gaps,
          byOwner: gate.byOwner,
        });
      }

      style.techSheet.status = "submitted";
      style.techSheet.submittedAt = new Date();

      /* ── FROZEN, WITH ITS FILE ───────────────────────────────────────
         A snapshot taken now is what Sales decided on. R&D editing a later
         revision must not be able to change what was approved in September,
         so the copy is plain data and is never written to again. */
      const technical = style.techSheet.technical;
      technical.revision = (technical.revision || 0) + 1;
      technical.status = technicalRecord.STATUS.SUBMITTED;
      technical.submittedAt = new Date();
      technical.submittedBy = actor(req);
      style.techSheet.technicalRevisions = [
        ...(style.techSheet.technicalRevisions || []),
        {
          revision: technical.revision,
          submittedAt: technical.submittedAt,
          submittedBy: actor(req),
          file: style.techSheet.file,
          /* The sample record too: the outside-service and development rows
             Central Costing reads live on `sample.serviceRequirements`, and a
             revision that froze only `techSheet.technical` left every one of
             them outside the frozen basis. */
          snapshot: technicalRecord.snapshotOf(technical, style.techSheet.file, style.sample),
          outcome: "submitted",
        },
      ];
    } else if (action === "approve") {
      if (!(await canApprove(req.user))) return res.status(403).json({ success: false, message: "Only Sales can approve the tech sheet." });
      if (!can("approved")) return invalid("approved");
      style.techSheet.status = "approved";
      style.techSheet.approvedAt = new Date();
      style.techSheet.approvedBy = actor(req);

      /* ── SALES DECIDES; SALES DOES NOT EDIT ──────────────────────────
         The decision is recorded ON the frozen revision. Not one technical
         value is read from the request body here — an approver approves what
         was submitted, and a body that carried a different consumption would
         otherwise rewrite the fact it was approving. */
      if (style.techSheet.technical) {
        style.techSheet.technical.status = technicalRecord.STATUS.APPROVED;
        style.techSheet.technical.approvedAt = new Date();
        style.techSheet.technical.approvedBy = actor(req);
      }
      const latest = (style.techSheet.technicalRevisions || [])
        .filter((r) => r.outcome === "submitted")
        .reduce((best, r) => (r.revision > (best?.revision ?? -1) ? r : best), null);
      if (latest) {
        latest.outcome = "approved";
        latest.decidedAt = new Date();
        latest.decidedBy = actor(req);
        latest.decisionNote = (req.body.note || "").trim();
      }
      // The approved technical sequence becomes the normal, scan-ready
      // production route before R&D can release the sample MO/WO.  The work
      // order later freezes this route in the established Production flow.
      await syncApprovedTechnicalRoute(style, req.user?.id);
    } else if (action === "revise") {
      /* ══ OPENING A SECOND TECHNICAL REVISION ═══════════════════════════
       *
       * ── WHAT WAS MISSING ──────────────────────────────────────────────
       * `approved` was a terminal tech-sheet state, and the technical record
       * is only editable in DRAFT or REWORK. So once Sales approved revision
       * 1 there was no mounted route — none — by which R&D could record that
       * the garment had changed. Everything downstream inherited that dead
       * end: Industrial Engineering could not re-base onto a revision nobody
       * could create, and Central Costing's IE_TECHNICAL_APPROVAL_STALE named
       * a state with no way out of it.
       *
       * ── IT IS A DECISION, NOT AN EDIT ─────────────────────────────────
       * The approved record is what a costing may already have been built on,
       * so reopening it is Sales' call and it costs a reason — the same
       * authority and the same price as sending a submitted record back. R&D
       * then edits, submits and is approved again through the paths that
       * already exist; this adds no second way to approve anything.
       *
       * ── AND NOTHING FROZEN IS TOUCHED ─────────────────────────────────
       * `technicalRevisions[]` is append-only and every earlier entry keeps
       * its outcome, its snapshot, its decision and its decider. Revision 1
       * still says it was approved, because it was. What changes is only
       * which record is CURRENT. */
      if (!(await canApprove(req.user))) {
        return res.status(403).json({ success: false, message: "Only Sales can reopen an approved tech sheet." });
      }
      /* Company ownership, proved through the style's own Sales parents —
         the same proof the technical PUT makes before it writes a fact. */
      const reviseScope = await salesScopeFor(req);
      if (!(await ownershipProofFor(style, reviseScope.companyId))) {
        return res.status(404).json({ success: false, message: "Style not found." });
      }
      if (cur !== "approved" || style.techSheet.technical?.status !== technicalRecord.STATUS.APPROVED) {
        return res.status(409).json({
          success: false,
          code: "TECHNICAL_RECORD_NOT_APPROVED",
          message: "Only an approved technical record is reopened for a new revision.",
          status: String(style.techSheet.technical?.status || "") || technicalRecord.STATUS.NOT_STARTED,
          techSheetStatus: cur,
        });
      }
      const reviseReason = String(req.body.note || req.body.reason || "").trim();
      if (!reviseReason) {
        return res.status(400).json({
          success: false,
          code: "TECHNICAL_REVISION_REASON_REQUIRED",
          message: "Say why this approved technical record is being reopened.",
          field: "note",
        });
      }

      style.techSheet.status = "in_progress";
      style.techSheet.revisions.push({ note: reviseReason, at: new Date(), by: actor(req) });
      /* REWORK, which is what the record's own editable set already names.
         The revision NUMBER is not touched here: submitting is what mints the
         next one, so a reopened record that is never resubmitted does not
         leave a number nobody used. */
      style.techSheet.technical.status = technicalRecord.STATUS.REWORK;
      style.techSheet.technical.reopenedAt = new Date();
      style.techSheet.technical.reopenedBy = actor(req);
      style.techSheet.technical.reopenReason = reviseReason;
    } else if (action === "changes") {
      if (!(await canApprove(req.user))) return res.status(403).json({ success: false, message: "Only Sales can request changes." });
      if (!can("changes")) return invalid("changes");
      style.techSheet.status = "changes";
      style.techSheet.revisions.push({ note: (req.body.note || "").trim(), at: new Date(), by: actor(req) });

      /* Back to R&D for a NEW revision. The returned one keeps its snapshot
         and its outcome, so the history says what was sent back and why. */
      if (style.techSheet.technical) {
        style.techSheet.technical.status = technicalRecord.STATUS.REWORK;
      }
      const returned = (style.techSheet.technicalRevisions || [])
        .filter((r) => r.outcome === "submitted")
        .reduce((best, r) => (r.revision > (best?.revision ?? -1) ? r : best), null);
      if (returned) {
        returned.outcome = "returned";
        returned.decidedAt = new Date();
        returned.decidedBy = actor(req);
        returned.decisionNote = (req.body.note || "").trim();
      }
    } else {
      return res.status(400).json({ success: false, message: "Unknown tech-sheet action." });
    }

    const tsKind = {
      submit: "tech_submitted", approve: "tech_approved", changes: "tech_changes",
      revise: "tech_reopened",
    }[action];
    if (tsKind) logHistory(style, { kind: tsKind, note: req.body.note || "" }, req);
    style.updatedBy = actor(req);
    await style.save();

    if (action === "submit") {
      (async () => {
        const [customerName, image] = await Promise.all([customerNameFor(style, req), referenceImageFor(style, req)]);
        await notifyEvent("tech_sheet_submitted", {
          heading: `Tech sheet submitted: ${style.productName || style.styleCode || ""}`,
          bodyHtml: `<p><strong>${escapeHtml(actor(req).name || "R&D")}</strong> submitted the tech sheet for your review.</p>`,
          details: [
            ["Customer", customerName],
            ["Style", style.styleCode || style.sampleStyleId],
            ["Product", style.productName],
            ["File", style.techSheet.file?.name],
          ],
          image,
          bodyText: `${actor(req).name || "R&D"} submitted the tech sheet for "${style.productName || "a style"}" (${customerName}) for review.`,
          ctaLabel: "Review tech sheet",
          ctaUrl: styleSampleUrl(style),
        });
      })().catch(() => {});
    } else if (action === "approve" || action === "changes") {
      (async () => {
        const [customerName, image] = await Promise.all([customerNameFor(style, req), referenceImageFor(style, req)]);
        const note = req.body.note || "";
        await notifyEvent("tech_sheet_decision", {
          heading: `Tech sheet ${action === "approve" ? "approved" : "changes requested"}: ${style.productName || style.styleCode || ""}`,
          bodyHtml: `<p><strong>${escapeHtml(actor(req).name || "Sales")}</strong> ${action === "approve" ? "approved the tech sheet" : "requested changes to the tech sheet"}.</p>${note ? `<p style="margin:10px 0 0;color:#475569">${escapeHtml(note)}</p>` : ""}`,
          details: [
            ["Customer", customerName],
            ["Style", style.styleCode || style.sampleStyleId],
            ["Product", style.productName],
          ],
          image,
          bodyText: `${actor(req).name || "Sales"} ${action === "approve" ? "approved" : "requested changes to"} the tech sheet for "${style.productName || "a style"}" (${customerName}).${note ? ` Note: ${note}` : ""}`,
          ctaLabel: "Open in R&D",
          ctaUrl: `${DEPT_NOTIFY_APP_URL}/research-development/dashboard`,
        });
      })().catch(() => {});
    }

    return res.json({ success: true, sampleStyle: await withJourney(style, req) });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/tech-sheet", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/sample-styles/:id/sample  { action, type?, note? }
router.post("/:id/sample", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });

    const { action } = req.body;
    const cur = style.sample.status;
    const can = (next) => (SAMPLE_SAMPLING_TRANSITIONS[cur] || []).includes(next);
    const invalid = (next) => res.status(400).json({ success: false, message: `Can't move sampling from "${cur}" to "${next}".` });

    if (action === "start") {
      if (style.techSheet.status !== "approved") return res.status(400).json({ success: false, message: "The tech sheet must be approved before sampling starts." });
      if (!can("in_progress")) return invalid("in_progress");
      style.sample.status = "in_progress";
      if (!style.sample.startedAt) style.sample.startedAt = new Date();
    } else if (action === "round") {
      if (style.sample.status !== "in_progress") return res.status(400).json({ success: false, message: "Start sampling before adding a round." });
      const type = req.body.type;
      if (!SAMPLE_ROUND_TYPE_CODES.includes(type)) return res.status(400).json({ success: false, message: "Invalid round type." });

      // Anything still awaiting a verdict when the next sample is made was, in
      // fact, overtaken. Recording that is the difference between "nobody ruled
      // on round 2" and "round 2 is still open", and only one of those is true.
      (style.sample.rounds || []).forEach((r) => { if (r.outcome === "pending") r.outcome = "superseded"; });

      const roundNo = (style.sample.rounds?.length || 0) + 1;
      style.sample.rounds.push({
        roundNo,
        type,
        note: req.body.note || "",
        // What was actually made. The one thing a round could never say before.
        images: sanitizeImages(req.body.images),
        outcome: "pending",
        madeAt: new Date(),
      });
    } else if (action === "judge") {
      // A verdict on ONE round, separate from the style's own status.
      //
      // Sampling status answers "where is this style"; a round's outcome
      // answers "what happened to that sample", and they are not the same
      // question — round 2 stays rejected forever after round 3 is approved.
      // Kept apart so the ladder reads as a history instead of being rewritten
      // by the latest state.
      if (!(await canApprove(req.user))) return res.status(403).json({ success: false, message: "Only Sales can judge a round." });
      const round = (style.sample.rounds || []).id(req.body.roundId);
      if (!round) return res.status(404).json({ success: false, message: "That round is not on this style." });
      const outcome = req.body.outcome;
      if (!["accepted", "rejected"].includes(outcome)) return res.status(400).json({ success: false, message: "A round is judged accepted or rejected." });
      round.outcome = outcome;
      round.feedback = (req.body.feedback || "").trim();
      round.judgedAt = new Date();
      round.judgedBy = actor(req);
    } else if (action === "submit") {
      if (!can("submitted")) return invalid("submitted");
      // The actual submission — raw materials consumed making this sample,
      // plus at least one photo of it — not just a bare status flip, so Sales
      // has something real to approve/reject against (20 Aug 2026, explicit
      // request).
      const rawItemsInput = Array.isArray(req.body.consumptionRawItems) ? req.body.consumptionRawItems : [];
      const consumptionRawItems = rawItemsInput
        .filter((r) => r && r.rawItemName && Number(r.quantity) > 0)
        .map((r) => ({
          rawItemId: isObjectId(r.rawItemId) ? r.rawItemId : undefined,
          rawItemName: String(r.rawItemName).trim(),
          variantId: isObjectId(r.variantId) ? r.variantId : undefined,
          variantCombination: Array.isArray(r.variantCombination) ? r.variantCombination.filter(Boolean) : [],
          quantity: Number(r.quantity),
          unit: String(r.unit || "").trim(),
          allowancePercent: Number(r.allowancePercent) || 0,
          notes: String(r.notes || "").trim(),
        }));

      const photosInput = Array.isArray(req.body.photos) ? req.body.photos : [];
      const photos = photosInput
        .filter((p) => p && (p.url || p.fileId))
        .map((p) => ({ fileId: p.fileId, publicId: p.publicId, name: p.name, url: p.url }));
      if (!photos.length) {
        return res.status(400).json({ success: false, message: "Attach at least one photo of the sample before submitting." });
      }

      // Operations R&D actually ran making this sample. NOW MANDATORY
      // (2 Sept 2026, explicit request: "this operation addition is
      // mandatory ok as it is the proof of the production ki which operation
      // are exactly made against this product") — this reverses the 24 Aug
      // 2026 decision to keep it optional. It is also no longer only a
      // record: on approval these overwrite the product's own operations and
      // its operation-wise cost, so submitting none would wipe the product's
      // costing rather than merely leave a gap.
      //
      // Blank rows (no type) are still dropped rather than rejected — a half
      // typed row is a typo, not a refusal to answer.
      const operationsInput = Array.isArray(req.body.operations) ? req.body.operations : [];
      const cleanedOperations = operationsInput
        .filter((o) => o && String(o.type || "").trim())
        .map((o) => {
          const minutes = Number(o.minutes) || 0;
          const seconds = Number(o.seconds) || 0;
          return {
            type: String(o.type).trim(),
            operationCode: String(o.operationCode || "").trim(),
            machine: String(o.machine || "").trim(),
            machineType: String(o.machineType || "").trim(),
            salaryDept: String(o.salaryDept || "").trim(),
            salaryDesig: String(o.salaryDesig || "").trim(),
            minutes, seconds,
            totalSeconds: o.totalSeconds != null ? Number(o.totalSeconds) || 0 : minutes * 60 + seconds,
          };
        });
      if (!cleanedOperations.length) {
        return res.status(400).json({
          success: false,
          message: "Record at least one operation you ran making this sample before submitting.",
        });
      }
      // Costed here, at submit, rather than at approval — so the Sales
      // reviewer sees what each operation costs on the screen where they
      // decide, instead of a figure that only materialises afterwards.
      const { costOperations } = require("../../../services/operationCosting");
      const operations = await costOperations(cleanedOperations);

      /* ── WHAT THE GARMENT IS PACKED IN, AND WHAT IS SENT OUTSIDE ─────────
         Both optional, unlike the operations above: plenty of styles are
         packed to a standing company spec and plenty need nothing sent out,
         and demanding a row for either would teach people to invent one.

         Neither carries a rate. R&D says WHICH and HOW MUCH; the Store
         quotation registers say what it costs, and a price typed here would
         be a second, undated answer to a question the register already
         answers with a reference and a validity.

         ── AND A STARTED ROW IS NEVER DROPPED ─────────────────────────────
         The first cut FILTERED incomplete rows out. Somebody who chose a
         carton and moved on before typing the quantity got a green tick and
         a sample submitted without it — and the costing they saw a fortnight
         later was short a cost with nothing anywhere saying so. An untouched
         row is still omitted; a started one is refused by name, with every
         field it owes, so the browser can mark it.

         Every identity is re-read company-scoped and every snapshot comes
         from what came back — see the service for why a snapshot a caller can
         dictate is not evidence. */
      let requirements;
      try {
        /* The company from the already-authorised request, never from the
           style — a record cannot nominate the scope it is checked against. */
        const scope = await salesScopeFor(req);
        requirements = await resolveRequirements(style, req.body, { companyId: scope.companyId });
      } catch (e) {
        if (e?.code === "SAMPLE_REQUIREMENT_INCOMPLETE") {
          return res.status(400).json({
            success: false, message: e.message,
            code: e.code,
            /* Which row, and which field of it. The browser keeps the row and
               marks it rather than the person hunting for what went wrong. */
            rows: e.rows,
          });
        }
        throw e;
      }
      const { packagingRequirements, serviceRequirements } = requirements;

      /* ── WHAT THE FINISHED GARMENT SHIPS AS ─────────────────────────
         Freight is quoted per kilogram or per carton, and until this existed
         neither could be answered anywhere in the system — so a freight rate
         could be configured, be applicable, and still produce nothing.

         Both are optional: plenty of orders are collected by the customer and
         need neither. What is not optional is the costing being honest when
         one is needed and absent, which it is — it blocks and names R&D. */
      const shipmentIn = req.body.shipment || {};
      const shipment = {};
      const weight = Number(shipmentIn.packedWeightGrams);
      if (shipmentIn.packedWeightGrams !== undefined && shipmentIn.packedWeightGrams !== null && shipmentIn.packedWeightGrams !== "") {
        if (!Number.isFinite(weight) || weight <= 0) {
          return res.status(400).json({ success: false, message: "A packed weight is a positive number of grams. A garment of no weight would ship for nothing." });
        }
        shipment.packedWeightGrams = weight;
      }
      const perCarton = Number(shipmentIn.garmentsPerCarton);
      if (shipmentIn.garmentsPerCarton !== undefined && shipmentIn.garmentsPerCarton !== null && shipmentIn.garmentsPerCarton !== "") {
        if (!Number.isInteger(perCarton) || perCarton < 1) {
          return res.status(400).json({ success: false, message: "Garments per carton is a whole number, at least one." });
        }
        shipment.garmentsPerCarton = perCarton;
      }
      if (String(shipmentIn.notes || "").trim()) shipment.notes = String(shipmentIn.notes).trim().slice(0, 500);
      if (Object.keys(shipment).length) style.sample.shipment = shipment;

      style.sample.consumptionRawItems = consumptionRawItems;
      style.sample.operations = operations;
      /* ── IDENTITY FROM THE APPROVED SELECTION, ALWAYS ────────────────
         R&D fills consumption, unit, basis, evidence and the include/exclude
         decision. The item and its approved specification come from
         Merchandising's row and are rebuilt here, so a submitted `rawItemId`
         naming a different component contributes nothing and the swap cannot
         happen silently.

         Also seeds: a component approved while R&D was working appears
         without anybody re-triggering anything. The merge is idempotent, so
         submitting twice does not produce two rows. */
      style.sample.packagingRequirements = packagingBom.mergePackaging(
        style.materials?.packagingSelections || [],
        packagingRequirements,
      ).requirements;
      /* ── R&D NO LONGER WRITES EITHER HALF OF THIS ARRAY ──────────────
         Outside processes are Production's, on the Route & SAM tab.
         Development and tooling are Merchandising's, on the Style BOM. Both
         live in `sample.serviceRequirements[]`, and this older all-in-one
         submit endpoint happens to save that array — so it must leave it
         exactly as it found it.

         Kept as an explicit statement rather than by simply not assigning:
         the array is rebuilt from `requirements` a few lines above for
         packaging, and somebody adding a line here needs to see that this
         one is deliberately carried through untouched.

         `serviceRequirements` is still RESOLVED above, because a malformed
         body should be refused the same way it always was rather than
         silently ignored — it is validated and then not applied. */
      style.sample.serviceRequirements = style.sample.serviceRequirements || [];
      style.sample.photos = photos;
      style.sample.status = "submitted";
      style.sample.submittedAt = new Date();
    } else if (action === "approve") {
      if (!(await canApprove(req.user))) return res.status(403).json({ success: false, message: "Only Sales can approve the sample." });
      if (!can("approved")) return invalid("approved");
      style.sample.status = "approved";
      style.sample.approvedAt = new Date();
      style.sample.approvedBy = actor(req);
      style.status = "completed";
      // Approving the style accepts the sample they approved it on.
      const passed = (style.sample.rounds || [])[style.sample.rounds.length - 1];
      if (passed) {
        passed.outcome = "accepted";
        passed.feedback = (req.body.note || "").trim() || passed.feedback;
        passed.judgedAt = new Date();
        passed.judgedBy = actor(req);
      }

      // Sales approving the sample is what makes R&D's submitted raw-item
      // consumption and operations REAL — so this is where they land on the
      // actual product, not at submit time (24 Aug 2026, explicit request:
      // "at the time of approval by the sales team... the raw item and
      // there consumption will be goona change in the corresponding
      // product stock item"). Whichever stock item this style is FOR —
      // the one registered through this same style's own Production step
      // takes priority since it's the freshest; sourceStockItemId (the
      // already-developed product this style started from) is the fallback.
      const targetStockItemId = style.production?.stockItemId || style.sourceStockItemId;
      if (targetStockItemId && (style.sample.consumptionRawItems?.length || style.sample.operations?.length)) {
        try {
          const stockItem = await StockItem.findById(targetStockItemId);
          if (stockItem) {
            if (style.sample.consumptionRawItems?.length) {
              // `r.quantity` on a sample is already the EFFECTIVE amount R&D
              // measured consuming it (the "Consumed" field they typed), not
              // a pre-allowance base — so it's passed as requiredQuantity
              // with allowancePercent left at 0 rather than r.allowancePercent,
              // which would otherwise multiply it a second time and inflate
              // every future work order's BOM off this product.
              const processedRawItems = await processVariantRawItems(
                style.sample.consumptionRawItems.map((r) => ({
                  rawItemId: r.rawItemId, variantId: r.variantId, variantCombination: r.variantCombination,
                  requiredQuantity: r.quantity, unit: r.unit,
                })),
              );
              if (processedRawItems.length) {
                // Every variant shares one BOM on this model (see the R&D
                // page's own "all variants share the same BOM" comment) —
                // so the approved consumption replaces it on every variant,
                // not just the first.
                for (const v of stockItem.variants) v.rawItems = processedRawItems;
              }
            }
            if (style.sample.operations?.length) {
              // Carried across WITH their costing (2 Sept 2026): the salary
              // basis and per-piece operator cost were resolved when R&D
              // submitted (services/operationCosting.js), so the product
              // inherits a priced operation list rather than a bare one that
              // would silently zero out its operations cost. Re-costed here
              // rather than trusted blindly, so a sample submitted before a
              // salary revision is priced at today's rates on approval.
              const { costOperations } = require("../../../services/operationCosting");
              const priced = await costOperations(
                style.sample.operations.map((o) => ({
                  type: o.type, operationCode: o.operationCode, machine: o.machine,
                  machineType: o.machineType, minutes: o.minutes, seconds: o.seconds,
                  totalSeconds: o.totalSeconds, salaryDept: o.salaryDept, salaryDesig: o.salaryDesig,
                })),
                // Inherit the salary basis this product already had for the
                // same operation, where nothing more specific supplies one.
                // Without this the overwrite would blank a basis that is
                // filled in on products but (today) on no registered
                // operation — see the service's own note.
                { fallbackFrom: stockItem.operations || [] },
              );
              stockItem.operations = priced;
              // The sample keeps the figures it was actually approved on, so
              // the record and the product agree about what was decided.
              style.sample.operations = priced;
            }
            recomputeVariantCostsFromBom(stockItem);
            updateStockItemAggregates(stockItem);
            await stockItem.save();
          }
        } catch (syncErr) {
          // Non-fatal — the sample approval itself (the record of what R&D
          // made and Sales accepted) must not be lost because the product
          // sync had a problem; it's logged so it can be redone by hand.
          console.error("[sampleStyles] approve → stock item sync failed:", syncErr);
        }
      }
    } else if (action === "reject") {
      if (!(await canApprove(req.user))) return res.status(403).json({ success: false, message: "Only Sales can reject the sample." });
      if (!can("rejected")) return invalid("rejected");
      // Reason required server-side, not just client-side (26 Aug 2026,
      // explicit request: "make sure to ask for the reason" — this is
      // "serious/sensitive data" and the rework log downstream is only as
      // good as the reasons actually captured here).
      const note = (req.body.note || "").trim();
      if (!note) return res.status(400).json({ success: false, message: "A rejection reason is required." });
      style.sample.status = "rejected";
      // Rejecting the style rejects the sample in front of them — the latest
      // round. Naming it turns two parallel lists into one readable ladder:
      // the revision now has a subject instead of only a timestamp.
      const latest = (style.sample.rounds || [])[style.sample.rounds.length - 1];
      if (latest) {
        latest.outcome = "rejected";
        latest.feedback = note;
        latest.judgedAt = new Date();
        latest.judgedBy = actor(req);
      }
      style.sample.revisions.push({ note, roundId: latest?._id, at: new Date(), by: actor(req) });
    } else {
      return res.status(400).json({ success: false, message: "Unknown sample action." });
    }

    const smKind = { round: "sample_round", judge: `round_${req.body?.outcome}`, submit: "sample_submitted", approve: "sample_approved", reject: "sample_rejected" }[action];
    if (smKind) logHistory(style, { kind: smKind, note: action === "round" ? req.body.type : (req.body.note || "") }, req);
    style.updatedBy = actor(req);
    await style.save();

    if (action === "submit") {
      // The sample's OWN photo, not the enquiry reference image — this is
      // what was actually made, so it's the more useful picture to include.
      (async () => {
        const customerName = await customerNameFor(style, req);
        await notifyEvent("sample_submitted", {
          heading: `Sample submitted for approval: ${style.productName || style.styleCode || ""}`,
          bodyHtml: `<p><strong>${escapeHtml(actor(req).name || "R&D")}</strong> submitted a physical sample for your approval.</p>`,
          details: [
            ["Customer", customerName],
            ["Style", style.styleCode || style.sampleStyleId],
            ["Product", style.productName],
            ["Round", `#${style.sample.rounds?.length || ""}`],
          ],
          image: style.sample.photos?.[0],
          bodyText: `${actor(req).name || "R&D"} submitted a sample of "${style.productName || "a style"}" (${customerName}) for approval.`,
          ctaLabel: "Review sample",
          ctaUrl: styleSampleUrl(style),
        });
      })().catch(() => {});
    } else if (action === "approve" || action === "reject") {
      (async () => {
        const customerName = await customerNameFor(style, req);
        const note = req.body.note || "";
        await notifyEvent("sample_decision", {
          heading: `Sample ${action === "approve" ? "approved" : "rejected"}: ${style.productName || style.styleCode || ""}`,
          bodyHtml: `<p><strong>${escapeHtml(actor(req).name || "Sales")}</strong> ${action === "approve" ? "approved" : "rejected"} the submitted sample.</p>${note ? `<p style="margin:10px 0 0;color:#475569">${escapeHtml(note)}</p>` : ""}`,
          details: [
            ["Customer", customerName],
            ["Style", style.styleCode || style.sampleStyleId],
            ["Product", style.productName],
          ],
          image: style.sample.photos?.[0],
          bodyText: `${actor(req).name || "Sales"} ${action === "approve" ? "approved" : "rejected"} the sample of "${style.productName || "a style"}" (${customerName}).${note ? ` Note: ${note}` : ""}`,
          ctaLabel: "Open in R&D",
          ctaUrl: `${DEPT_NOTIFY_APP_URL}/research-development/dashboard`,
        });
      })().catch(() => {});
    }

    // NO AUTO-SEND TO THE CUSTOMER (2 Sept 2026, explicit request: "once the
    // sales approved the sample product then currently it is auto sent for
    // customer approval but this is bad... it is needed to keep the button
    // like for now it's ur turn in order to sent this sample product to the
    // customer"). This reverses the 26 Aug 2026 auto-trigger.
    //
    // Approving internally and putting the sample in front of the customer
    // are two decisions, and firing the second off the first took the
    // salesperson's own judgement out of it — there was no moment to attach
    // context, check the photos, or hold the send while a conversation was
    // still open. The manual send lives at POST /:id/sample/send-whatsapp-
    // approval, which this route deliberately no longer calls.

    return res.json({ success: true, sampleStyle: await withJourney(style, req) });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/sample", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/sample-styles/:id/sample/discussion
//
// R&D ↔ Sales conversation about ONE sample submission — see
// components/sales/crm/journey/stages/SampleDiscussion.js on the frontend,
// which has called this exact path since 20 Aug 2026 with no route ever
// answering it (24 Aug 2026 bug fix: 404 in both apps that mount it).
router.post("/:id/sample/discussion", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });

    const text = String(req.body?.text || "").trim();
    const attachment = req.body?.attachment;
    const hasAttachment = Boolean(attachment && (attachment.url || attachment.fileId));
    if (!text && !hasAttachment) {
      return res.status(400).json({ success: false, message: "Write a message or attach a file." });
    }

    if (!Array.isArray(style.sample.discussion)) style.sample.discussion = [];
    style.sample.discussion.push({
      text,
      attachment: hasAttachment
        ? { name: attachment.name, url: attachment.url, fileId: attachment.fileId, publicId: attachment.publicId }
        : undefined,
      by: actor(req),
      at: new Date(),
    });
    style.updatedBy = actor(req);
    await style.save();

    return res.json({ success: true, sampleStyle: await withJourney(style, req) });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/sample/discussion", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/sample-styles/:id/sample/send-whatsapp-approval
//
// Manual (re)send — the same call the "approve" action already fires
// automatically (26 Aug 2026), exposed here for when that auto-send failed
// (no phone on file yet at approval time, WhatsApp briefly down, template
// not configured yet when this style was first approved) and Sales needs a
// retry button rather than re-approving the sample just to trigger it again.
router.post("/:id/sample/send-whatsapp-approval", salesAuth, async (req, res) => {
  try {
    if (!(await canApprove(req.user))) return res.status(403).json({ success: false, message: "Only Sales can send the approval request." });
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    if (!isSampleSettled(style)) {
      return res.status(400).json({ success: false, message: "Sales must approve the sample internally first." });
    }
    const [customerName, j] = await Promise.all([
      customerNameFor(style, req),
      SalesJourney.findOne(await scoped(req, { _id: style.journeyId })).select("journeyId").lean(),
    ]);
    const { sendApprovalRequest } = require("../../../services/sampleWhatsapp");
    const result = await sendApprovalRequest(style, { customerName, enquiryRef: j?.journeyId, preparedBy: actor(req).name });
    if (!result.sent) return res.status(502).json({ success: false, message: result.reason });
    return res.json({ success: true, sampleStyle: await withJourney(style, req) });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/sample/send-whatsapp-approval", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/sample-styles/:id/sample/customer-decision
// Body: { approved: boolean, note?: string }
//
// The customer's verdict on the finished sample (26 Aug 2026 — replaces the
// old Cost & Invoicing customer-approval step, moved here since the decision
// belongs with the sample, before any pricing happens: "once after sample
// approval from the sales team, then next step will be that sent to
// customer for Sample approval"). Sales records the customer's answer —
// there is no customer login here to do it themselves, same as
// costingLifecycle's customerApprovalLog did. Only meaningful once Sales has
// already approved the sample internally; APPENDS to `log`, never
// overwrites, same append-only discipline as every other decision log in
// this codebase.
/* ─────────────────────────────────────────────────────────────────────────
   ROUTE CUSTOMER CHANGES — what happens after the customer says no.

   POST /api/cms/crm/sample-styles/:id/customer-changes
   GET  /api/cms/crm/sample-styles/:id/customer-changes

   ── WHY THE SERVER DECIDES ──────────────────────────────────────────────
   The old recovery was two buttons, and one of them ("Change Product Design")
   did nothing at all on the server — it navigated. So what a rejection MEANT
   was decided by whichever button somebody pressed, and the invalidation that
   should follow it happened, or did not, depending on the screen.

   Routing is a decision about work that other departments will do, against
   approvals this system granted. It is applied here: the categories are
   checked, the destination is checked against the dependency chain, the
   reopening is performed, and the record is written in one place.

   ── WHAT IT REFUSES ─────────────────────────────────────────────────────
   · a style whose parent belongs to another company (SampleStyle carries no
     companyId of its own — ownership is proved through journey/enquiry, and
     the customer-decision handler beside this one has never done it)
   · a product the customer has not rejected
   · a decision that has moved since the screen loaded
   · a destination downstream of what the categories require
   · a retry of a request already made (idempotency key)
   ───────────────────────────────────────────────────────────────────────── */
router.post("/:id/customer-changes", salesAuth, async (req, res) => {
  try {
    if (!(await canApprove(req.user))) {
      return res.status(403).json({ success: false, message: "Only Sales can route a customer's changes." });
    }
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });

    const scope = await salesScopeFor(req);
    const proof = await ownershipProofFor(style, scope.companyId);
    if (!proof) return res.status(404).json({ success: false, message: "Style not found." });

    /* Only a rejection is routed. Routing an approved sample would reopen work
       nobody asked to have redone. */
    const approval = style.customerApproval || {};
    if (approval.approved !== false) {
      return res.status(400).json({
        success: false,
        code: "NOT_REJECTED",
        message: "This product has not been rejected by the customer, so there are no changes to route.",
      });
    }

    /* ── STALENESS ────────────────────────────────────────────────────
       The screen states which decision it is answering. If the customer has
       since changed their mind, or a later rejection replaced this one, the
       person is looking at something that is no longer true. */
    const expected = String(req.body?.expectedDecisionAt || "").trim();
    const actualAt = approval.decidedAt ? new Date(approval.decidedAt).toISOString() : "";
    if (expected && expected !== actualAt) {
      return res.status(409).json({
        success: false,
        code: "DECISION_CHANGED",
        message: "The customer's decision has changed since this screen loaded. Reload and look again.",
      });
    }

    const categories = customerChangeRouting.normaliseCategories(req.body?.categories);
    if (!categories.length) {
      return res.status(400).json({
        success: false, code: "CATEGORY_REQUIRED",
        message: "Say what the customer asked to change.",
      });
    }
    const feedback = String(req.body?.customerFeedback || "").trim();
    if (!feedback) {
      return res.status(400).json({
        success: false, code: "FEEDBACK_REQUIRED",
        message: "Record the customer's own words — they are what the department has to work from.",
      });
    }

    const suggested = customerChangeRouting.destinationFor(categories);
    const chosen = String(req.body?.destination || suggested || "").toUpperCase();
    const verdict = customerChangeRouting.validateDestination(chosen, categories);
    if (!verdict.ok) {
      return res.status(400).json({ success: false, code: verdict.code, message: verdict.message, suggested: verdict.suggested });
    }
    const destination = verdict.destination;
    const plan = customerChangeRouting.invalidationFor(destination);

    /* ── IDEMPOTENCY ──────────────────────────────────────────────────
       Checked before anything is applied, so a retry cannot open a second
       sample round on its way to discovering it was a retry. The unique index
       is the real guard; this is the friendly path. */
    const idempotencyKey = String(req.body?.idempotencyKey || "").trim() || undefined;
    if (idempotencyKey) {
      const already = await CustomerChangeRequest.findOne({ companyId: scope.companyId, idempotencyKey }).lean();
      if (already) {
        return res.json({ success: true, changeRequest: already, replayed: true, sampleStyle: await withJourney(style, req) });
      }
    }

    const who = actor(req);
    const now = new Date();
    /* Captured BEFORE anything is reopened — every branch below moves the
       stage, and reading it afterwards would record where the product went
       rather than where it came from. */
    const previousStage = style.stage || "";
    const previousState = {
      materialsStatus: style.materials?.status || "",
      bomApprovalStatus: style.bomApproval?.status || "",
      techSheetStatus: style.techSheet?.status || "",
      sampleStatus: style.sample?.status || "",
      sampleRounds: (style.sample?.rounds || []).length,
    };

    /* ── APPLY THE INVALIDATION ───────────────────────────────────────
       Forward-only in every branch: a previous approval stays on the record as
       what was true at the time, and no round, revision or log entry is ever
       removed. */
    const result = {};
    if (destination === "MATERIALS_BOM") {
      /* The approved BOM stays readable as history — `bomApproval` keeps its
         round number and its decision, and the round is incremented when the
         next approval is requested, exactly as it always was. What reopens is
         the selection and the approval state. */
      style.materials = style.materials || {};
      style.materials.status = "pending";
      if (style.bomApproval) {
        style.bomApproval.status = "none";
        style.bomApproval.token = undefined;
      }
      style.stage = "materials";
      /* Downstream needs doing again on the new materials. Statuses move back
         to their "not done yet" values; the revisions and rounds that produced
         them are untouched. */
      if (style.techSheet) style.techSheet.status = "pending";
      if (style.sample) style.sample.status = "not_started";
      result.bomApprovalRound = (style.bomApproval?.round || 0) + 1;
    } else if (destination === "TECH_SHEET") {
      /* The BOM stays approved. A returned technical revision is how R&D is
         told to open the next one — the same mechanism the tech-sheet
         "changes" action uses, so there is one way to reopen a tech sheet. */
      if (style.techSheet) {
        style.techSheet.status = "changes";
        style.techSheet.revisions = style.techSheet.revisions || [];
        style.techSheet.revisions.push({ note: feedback, at: now, by: who });
        if (style.techSheet.technical) style.techSheet.technical.status = "rework";
        const open = (style.techSheet.technicalRevisions || [])
          .filter((r) => r.outcome === "submitted")
          .reduce((best, r) => (r.revision > (best?.revision ?? -1) ? r : best), null);
        if (open) {
          open.outcome = "returned";
          open.decidedAt = now;
          open.decidedBy = who;
          open.decisionNote = feedback;
        }
        result.techSheetRevision = (style.techSheet.technical?.revision || 0) + 1;
      }
      if (style.sample) style.sample.status = "not_started";
      style.stage = "rnd";
    } else if (destination === "SAMPLE_ROUND") {
      /* The BOM and the tech sheet are both untouched. The existing "reject"
         action already numbers and supersedes rounds correctly, so this uses
         the same shape rather than a second numbering scheme. */
      style.sample = style.sample || {};
      style.sample.rounds = style.sample.rounds || [];
      style.sample.revisions = style.sample.revisions || [];
      const latest = style.sample.rounds[style.sample.rounds.length - 1];
      if (latest && latest.outcome === "pending") {
        latest.outcome = "rejected";
        latest.feedback = feedback;
        latest.judgedAt = now;
        latest.judgedBy = who;
      }
      style.sample.status = "rejected";
      style.sample.revisions.push({ note: feedback, roundId: latest?._id, at: now, by: who });
      style.stage = "rnd";
      /* The NEXT round's number, which R&D will raise. Not created here: a
         round is a thing somebody made, and inventing an empty one would put a
         sample on the record that nobody has sewn. */
      result.sampleRoundNo = style.sample.rounds.length + 1;
    } else if (destination === "BRIEF_NEW_VERSION") {
      /* Nothing on this style is reopened. The rejected product is kept whole
         and a replacement is raised on the Enquiry — Sales does that with the
         product editor, which already prefills from the removed row. This
         request is what links the two. */
      style.status = "completed";
    }

    /* The style is no longer waiting on the customer — it is waiting on
       whoever this was routed to. The verdict itself stays on the record. */
    style.updatedBy = who;
    logHistory(style, {
      kind: "customer_changes_routed",
      from: previousState.sampleStatus,
      to: destination,
      note: customerChangeRouting.summarise({ categories, destination }),
    }, req);
    await style.save();

    let changeRequest;
    try {
      changeRequest = await CustomerChangeRequest.create({
        companyId: scope.companyId,
        journeyId: style.journeyId,
        /* `ownershipProofFor` answers WHETHER this company owns the style, not
           which enquiry it belongs to — the style carries that itself. */
        enquiryId: style.enquiryId,
        productLineRef: String(req.body?.productLineRef || "").trim() || undefined,
        productName: style.productName,
        sampleStyleId: style._id,
        sourceDecision: {
          approved: false,
          decidedAt: approval.decidedAt || null,
          decidedBy: approval.decidedBy || null,
          note: approval.note || "",
        },
        categories,
        customerFeedback: feedback,
        internalInstructions: String(req.body?.internalInstructions || "").trim(),
        attachments: sanitizeImages(req.body?.attachments),
        suggestedDestination: suggested,
        destination,
        owner: customerChangeRouting.ownerFor(destination),
        previousStage,
        previousState,
        status: "OPEN",
        result,
        idempotencyKey,
        createdBy: who,
        routedAt: now,
        routedBy: who,
      });
    } catch (err) {
      /* Two retries racing: the unique index caught the second. Answer with
         the one that won rather than with a duplicate-key error. */
      if (err?.code === 11000 && idempotencyKey) {
        const winner = await CustomerChangeRequest.findOne({ companyId: scope.companyId, idempotencyKey }).lean();
        if (winner) {
          return res.json({ success: true, changeRequest: winner, replayed: true, sampleStyle: await withJourney(style, req) });
        }
      }
      throw err;
    }

    /* ── TELL WHOEVER HAS IT NOW ──────────────────────────────────────
       Fire-and-forget, like every other notification in this file: the routing
       is committed, and a mail server being down must not undo it. */
    (async () => {
      const EVENT_BY_DESTINATION = {
        MATERIALS_BOM: "customer_changes_to_materials",
        TECH_SHEET: "customer_changes_to_rnd",
        SAMPLE_ROUND: "customer_changes_to_rnd",
        BRIEF_NEW_VERSION: "customer_changes_to_sales",
      };
      const key = EVENT_BY_DESTINATION[destination];
      if (!key) return;
      /* ── THE CONTEXT IS A GARNISH, NOT A PRECONDITION ─────────────────
         `styleEmailContext` reads the account, the customer and the style's
         photos to make the mail readable. If any of that is unavailable the
         DEPARTMENT STILL HAS TO BE TOLD — a missing customer name is not a
         reason for Merchandising never to learn the BOM reopened. Caught
         separately so the outer catch only ever sees a genuine send failure. */
      let c = {};
      try {
        c = await styleEmailContext(style, await sampleEmailScope(req)) || {};
      } catch {
        c = {};
      }
      await notifyEvent(key, {
        vars: {
          product: style.productName || "",
          customer: c.customerName || "",
          salesPerson: who.name || "Sales",
          destination: (customerChangeRouting.CHANGE_DESTINATIONS.find((d) => d.code === destination) || {}).label || destination,
          feedback,
        },
        heading: `Customer changes on ${style.productName || "a product"}`,
        ctaUrl: c.viewUrl || `${DEPT_NOTIFY_APP_URL}/sales/dashboard/journeys/${style.journeyId}/style-sample`,
        ctaLabel: "Open the style",
      });
    })().catch(() => {});

    return res.status(201).json({
      success: true,
      changeRequest: changeRequest.toObject(),
      explanation: plan,
      sampleStyle: await withJourney(style, req),
    });
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error("[sampleStyles] POST /:id/customer-changes", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/** Every customer change routed on this product, newest first. */
router.get("/:id/customer-changes", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    const scope = await salesScopeFor(req);
    if (!(await ownershipProofFor(style, scope.companyId))) {
      return res.status(404).json({ success: false, message: "Style not found." });
    }
    const changeRequests = await CustomerChangeRequest
      .find({
        companyId: scope.companyId,
        $or: [
          { sampleStyleId: style._id },
          { "result.replacementSampleStyleId": style._id },
        ],
      })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, changeRequests });
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error("[sampleStyles] GET /:id/customer-changes", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* Explicit repair/admin door for a request that has genuinely completed.
   Normal same-style rework closes automatically when the customer approves
   the revised sample below. This endpoint exists so a lost client response or
   an imported decision cannot strand the commercial hold forever. */
router.post("/:id/customer-changes/:changeRef/resolve", salesAuth, async (req, res) => {
  try {
    if (!(await canApprove(req.user))) {
      return res.status(403).json({ success: false, message: "Only Sales can resolve customer changes." });
    }
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    const scope = await salesScopeFor(req);
    if (!(await ownershipProofFor(style, scope.companyId))) {
      return res.status(404).json({ success: false, message: "Style not found." });
    }
    const request = await CustomerChangeRequest.findOne({
      companyId: scope.companyId,
      changeRef: String(req.params.changeRef || "").trim(),
      sampleStyleId: style._id,
    });
    if (!request) return res.status(404).json({ success: false, message: "Customer change request not found." });
    if (!["OPEN", "IN_PROGRESS"].includes(request.status)) {
      return res.json({ success: true, changeRequest: request.toObject(), replayed: true });
    }
    const decidedAt = style.customerApproval?.decidedAt
      ? new Date(style.customerApproval.decidedAt).getTime() : 0;
    const sourceAt = request.sourceDecision?.decidedAt
      ? new Date(request.sourceDecision.decidedAt).getTime() : 0;
    if (style.customerApproval?.approved !== true || decidedAt <= sourceAt) {
      return res.status(409).json({
        success: false,
        code: "REVISED_SAMPLE_NOT_APPROVED",
        message: "The revised product must be approved by the customer before this change can be resolved.",
      });
    }
    request.status = "RESOLVED";
    request.resolvedAt = new Date();
    request.resolvedBy = actor(req);
    request.resolutionNote = String(req.body?.note || "Customer approved the revised product.").trim();
    await request.save();
    return res.json({ success: true, changeRequest: request.toObject() });
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error("[sampleStyles] POST /:id/customer-changes/:changeRef/resolve", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/:id/sample/customer-decision", salesAuth, async (req, res) => {
  try {
    if (!(await canApprove(req.user))) return res.status(403).json({ success: false, message: "Only Sales can record the customer's decision." });
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });

    const scope = await salesScopeFor(req);
    if (!(await ownershipProofFor(style, scope.companyId))) {
      return res.status(404).json({ success: false, message: "Style not found." });
    }

    if (!isSampleSettled(style)) {
      return res.status(400).json({ success: false, message: "Sales must approve the sample internally before asking the customer." });
    }
    if (typeof req.body?.approved !== "boolean") {
      return res.status(400).json({ success: false, message: "approved (true/false) is required." });
    }
    const approved = req.body.approved;
    const note = String(req.body?.note || "").trim();
    if (!approved && !note) {
      return res.status(400).json({ success: false, message: "A reason is required when the customer rejects the sample." });
    }

    const who = actor(req);
    const now = new Date();
    style.customerApproval = style.customerApproval || {};
    style.customerApproval.log = style.customerApproval.log || [];
    style.customerApproval.log.push({ approved, decidedAt: now, decidedBy: who, note });
    style.customerApproval.approved = approved;
    style.customerApproval.decidedAt = now;
    style.customerApproval.decidedBy = who;
    style.customerApproval.note = note;
    style.customerRejected = !approved;

    logHistory(style, { kind: approved ? "customer_sample_approved" : "customer_sample_rejected", note }, req);
    style.updatedBy = who;
    await style.save();

    /* A routed change remains a hard Purchase Invoice hold until the customer
       accepts a later result. Close every open request on this style in the
       same command that records that acceptance; rejecting again leaves the
       existing request open and can be routed as a new append-only request. */
    if (approved) {
      await CustomerChangeRequest.updateMany(
        {
          companyId: scope.companyId,
          $or: [
            { sampleStyleId: style._id },
            { "result.replacementSampleStyleId": style._id },
          ],
          status: { $in: ["OPEN", "IN_PROGRESS"] },
          "sourceDecision.decidedAt": { $lt: now },
        },
        {
          $set: {
            status: "RESOLVED",
            resolvedAt: now,
            resolvedBy: who,
            resolutionNote: note || "Customer approved the revised product.",
          },
        },
      );
    }

    return res.json({ success: true, sampleStyle: await withJourney(style, req) });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/sample/customer-decision", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PRODUCTION (bulk / size-wise order) — see the `production` field's own
// comment on models/CMS_Models/Sales/SampleStyle.js for the full pipeline:
// Customer → Stock Item (finished good + BOM) → Customer Request → (internal,
// auto-approved) quotation → Work Orders. Driven from R&D
// (app/research-development, ProductionPanel) because R&D is the one who now
// knows the real product/BOM; reuses createWorkOrdersAndProgress, the SAME
// WO-creation logic Sales' own "New Order on Behalf"
// (salesCustomers.js) and "mark as internal order" (quotationRoutes.js) use —
// this is a second front door onto that pipeline, not a parallel one.
//
// Every import this section needs (Account, Customer, StockItem, RawItem,
// WorkOrder, CustomerRequest, createWorkOrdersAndProgress) was already sitting
// at the top of this file, unused — the route bodies were the missing piece
// (24 Aug 2026 bug fix: this whole subtree 404'd, which is what surfaced as
// "asks to create a customer that already exists" — GET /:id/production
// never having existed meant `data` stayed null and the wizard fell back to
// step 1 no matter what).
// ═════════════════════════════════════════════════════════════════════════════

const escapeRegex = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* Older StockItem routes stored the operation code/name snapshot but not the
   master _id.  The route editor still saves by identity, so hydrate that
   identity at the API boundary instead of making the browser guess it. */
const hydrateOperationIds = async (operations) => {
  const rows = Array.isArray(operations) ? operations : [];
  const codes = [...new Set(rows.map((o) => String(o?.operationCode || "").trim()).filter(Boolean))];
  const names = [...new Set(rows.map((o) => String(o?.type || o?.name || "").trim()).filter(Boolean))];
  if (!codes.length && !names.length) return rows;

  const masters = await Operation.find({
    $or: [
      ...(codes.length ? [{ operationCode: { $in: codes } }] : []),
      ...(names.length ? [{ name: { $in: names } }] : []),
    ],
  }).select("name operationCode totalSam machineType").lean();
  const byCode = new Map(masters.filter((o) => o.operationCode).map((o) => [String(o.operationCode), o]));
  const byName = new Map(masters.map((o) => [String(o.name), o]));

  return rows.map((row) => {
    if (row?.operationId || row?.id || row?._id) return row;
    const master = byCode.get(String(row?.operationCode || "").trim())
      || byName.get(String(row?.type || row?.name || "").trim());
    return master ? { ...row, operationId: String(master._id) } : row;
  });
};

/* The approved technical route is the source of truth for a sample's first
   production release.  Production still receives an ordinary StockItem route
   and therefore keeps its normal work-order, scan and QC protocol; this only
   removes the duplicate R&D data entry that used to sit between approval and
   release. */
const syncApprovedTechnicalRoute = async (style, userId) => {
  const stockItemId = style.production?.stockItemId || style.sourceStockItemId;
  const technicalRows = style.techSheet?.technical?.operations || [];
  if (style.techSheet?.technical?.status !== technicalRecord.STATUS.APPROVED || !stockItemId || !technicalRows.length) return false;

  const ids = technicalRows.map((row) => String(row.operationId || "")).filter(isObjectId);
  if (ids.length !== technicalRows.length) {
    const err = new Error("The approved technical route contains an invalid operation. Return it to R&D to correct the technical record.");
    err.status = 400;
    throw err;
  }
  const masters = await Operation.find({ _id: { $in: ids } })
    .select("name operationCode totalSam machineType").lean();
  const byId = new Map(masters.map((row) => [String(row._id), row]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    const err = new Error("An operation in the approved technical route no longer exists. Return it to R&D to choose a current operation.");
    err.status = 400;
    throw err;
  }

  const stockItem = await StockItem.findById(stockItemId);
  if (!stockItem) {
    const err = new Error("The product linked to this style no longer exists.");
    err.status = 404;
    throw err;
  }
  stockItem.operations = ids.map((id, index) => {
    const master = byId.get(id);
    const technical = technicalRows[index];
    const totalSeconds = Math.max(0, (Number(technical.minutes) || 0) * 60 + (Number(technical.seconds) || 0));
    return {
      type: master.name || "",
      operationCode: master.operationCode || "",
      machine: master.machineType || "",
      machineType: master.machineType || "",
      totalSeconds,
      minutes: Math.floor(totalSeconds / 60),
      seconds: totalSeconds % 60,
      operatorSalary: 0,
      operatorCost: 0,
    };
  });
  stockItem.updatedBy = userId;
  await stockItem.save();
  return true;
};

// GET /api/cms/crm/sample-styles/:id/production
router.get("/:id/production", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    if (!style.production) style.production = {};

    let customer = null;
    let accountPrefill = null;

    if (style.production.customerId) {
      customer = await Customer.findById(style.production.customerId).select("name email phone customerId").lean();
    } else if (style.accountId) {
      const account = await Account.findOne(await scoped(req, { _id: style.accountId })).select("companyName displayName primaryEmail primaryPhone linkedCustomer");
      if (account?.linkedCustomer) {
        customer = await Customer.findById(account.linkedCustomer).select("name email phone customerId").lean();
        // Resolved silently, server-side — the whole point of this step
        // (24 Aug 2026, explicit request: "we are creating the corresponding
        // customer account before switch to the pipeline... it should auto
        // select the customer"). Persisted so it reads back the same way
        // without re-walking the account on every load, and so the rest of
        // this pipeline (stock-item, submit) has somewhere to read it from.
        if (customer) {
          style.production.customerId = customer._id;
          if (style.production.status === "not_started") style.production.status = "customer_linked";
          style.production.log = style.production.log || [];
          style.production.log.push({ kind: "customer_linked", note: "Resolved from the account's linked portal customer.", by: { name: "System" }, at: new Date() });
          await style.save();
        }
      } else if (account) {
        accountPrefill = { name: account.companyName || account.displayName || "", email: account.primaryEmail || "", phone: account.primaryPhone || "" };
      } else {
        // `style.accountId` points at nothing — the Account was deleted
        // after the journey was created (the same dangling-reference case
        // sampleStyleEmail.service.js's styleEmailContext already works
        // around for the email/BOM-approval side). There is genuinely no
        // account left to read a name, email or phone off of; the journey's
        // own `name` is the one surviving piece of who this is (1 Sept 2026
        // bug fix: this fell all the way through to a bare, unprefilled
        // "search or create" form with nothing to search for — R&D had no
        // way to tell the style even HAD a customer on record, let alone
        // find or recreate it, without leaving this page to go read the
        // Enquiry).
        const journey = await SalesJourney.findOne(await scoped(req, { _id: style.journeyId })).select("name").lean();
        if (journey?.name) accountPrefill = { name: journey.name, email: "", phone: "" };
      }
    }

    // `sourceStockItemId` is the FALLBACK, not an alternative — same order
    // syncMaterialsRawItems and the sample-approval sync already use
    // (`production?.stockItemId || sourceStockItemId`), and this route was the
    // one place that didn't (26 Aug 2026 bug fix). `sourceStockItemId` is set
    // once at style creation and never backfilled, while
    // `production.stockItemId` is set later and is cleared outright by
    // POST /:id/production/reset — so consulting only the latter left styles
    // whose product IS registered reporting no stock item at all: an empty
    // product-variant dropdown, and no bill of materials to show.
    const linkedStockItemId = style.production.stockItemId || style.sourceStockItemId;
    let stockItem = null;
    if (linkedStockItemId) {
      stockItem = await StockItem.findById(linkedStockItemId).select("name reference category variants operations").lean();
      if (stockItem) stockItem.operations = await hydrateOperationIds(stockItem.operations);
    }

    let workOrders = [];
    if (style.production.workOrderIds?.length) {
      /* `cancellation` comes back too. A cancelled attempt is part of this
         style's history and R&D has to be able to see WHY it was cancelled
         while they are redefining the route — a status chip alone sends them
         to another screen to find out. */
      const rows = await WorkOrder.find({ _id: { $in: style.production.workOrderIds } })
        .select("workOrderNumber status quantity completedQuantity variantAttributes operations cancellation").lean();
      workOrders = rows.map((w) => ({
        id: w._id, workOrderNumber: w.workOrderNumber, status: w.status,
        quantity: w.quantity, completedQuantity: w.completedQuantity || 0,
        attributes: w.variantAttributes,
        operationCount: (w.operations || []).length,
        cancellation: w.cancellation
          ? {
            at: w.cancellation.at || null,
            by: w.cancellation.byName || "",
            reason: w.cancellation.reason || "",
            cuttingRecorded: Boolean(w.cancellation.cuttingRecorded),
          }
          : null,
      }));
    }
    /* What is still RUNNING, as opposed to what has ever existed. The page
       needs both: the history includes cancelled attempts, the "sent to
       production" state must not. */
    const liveWorkOrders = workOrders.filter((w) => w.status !== "cancelled");

    let customerRequest = null;
    if (style.production.customerRequestId) {
      const r = await CustomerRequest.findById(style.production.customerRequestId).select("requestId status").lean();
      if (r) customerRequest = { id: r._id, requestId: r.requestId, status: r.status };
    }

    return res.json({
      success: true,
      production: {
        status: style.production.status || "not_started",
        customer: customer ? { id: customer._id, name: customer.name, email: customer.email, phone: customer.phone } : null,
        accountPrefill,
        // `.lean()` returns raw `_id`, but the R&D page's Quantities step
        // keys everything off `v.id` (24 Aug 2026 bug fix: a quantity typed
        // against `undefined` never matched a real variant server-side, so
        // "Set a quantity for at least one variant" fired even with one set).
        stockItem: stockItem ? { id: stockItem._id, name: stockItem.name, reference: stockItem.reference, category: stockItem.category, variants: (stockItem.variants || []).map((v) => ({ ...v, id: v._id })), operations: stockItem.operations } : null,
        // The bill of materials, already de-duped across variants and ready
        // to render (26 Aug 2026, explicit request: the Sales pipeline shows
        // "whatever the raw items defined on that corresponding stock item"
        // and no longer defines its own). Rolled up HERE rather than in the
        // browser because a StockItem has no top-level `rawItems` — the BOM
        // hangs off each variant and has to be walked and merged, which is
        // exactly the step every previous consumer got wrong or skipped.
        bom: stockItemBom(stockItem),
        // Set by Sales, read-only to R&D (26 Aug 2026) — see the
        // order-quantities route.
        orderVariants: (style.production.orderVariants || []).map((v) => ({
          variantId: String(v.variantId), variantLabel: v.variantLabel, sku: v.sku, quantity: v.quantity,
        })),
        orderVariantsSetAt: style.production.orderVariantsSetAt || null,
        orderVariantsSetBy: style.production.orderVariantsSetBy || null,
        customerRequest,
        workOrderIds: style.production.workOrderIds || [],
        workOrders,
        /* Derived here rather than in the browser, because "may R&D edit the
           route again" is the same question the submit route answers and the
           two must not be able to disagree. */
        liveWorkOrderCount: liveWorkOrders.length,
        cancelledWorkOrders: workOrders.filter((w) => w.status === "cancelled"),
        routeEditingOpen: style.production.status !== "submitted",
        log: style.production.log || [],
      },
    });
  } catch (err) {
    console.error("[sampleStyles] GET /:id/production", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /:id/production/customers/search?q=
router.get("/:id/production/customers/search", salesAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, customers: [] });
    const re = new RegExp(escapeRegex(q), "i");
    const rows = await Customer.find({ $or: [{ name: re }, { email: re }, { phone: re }] })
      .select("name email phone").limit(10).lean();
    return res.json({ success: true, customers: rows.map((c) => ({ id: c._id, name: c.name, email: c.email, phone: c.phone })) });
  } catch (err) {
    console.error("[sampleStyles] GET /:id/production/customers/search", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /:id/production/customer  { customerId } | { create: { name, email, phone } }
router.post("/:id/production/customer", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    if (!style.production) style.production = {};

    let customer;
    let logKind;
    if (req.body?.customerId) {
      if (!isObjectId(req.body.customerId)) return res.status(400).json({ success: false, message: "Invalid customer." });
      customer = await Customer.findById(req.body.customerId).select("name email phone");
      if (!customer) return res.status(404).json({ success: false, message: "Customer not found." });
      logKind = "customer_linked";
    } else if (req.body?.create) {
      const { name, email, phone } = req.body.create || {};
      if (!String(name || "").trim() || !String(email || "").trim() || !String(phone || "").trim()) {
        return res.status(400).json({ success: false, message: "Name, email and phone are required." });
      }
      const existing = await Customer.findOne({ email: String(email).trim().toLowerCase() });
      if (existing) {
        customer = existing;
        logKind = "customer_linked";
      } else {
        customer = await Customer.create({
          name: String(name).trim(), email: String(email).trim().toLowerCase(), phone: String(phone).trim(),
          createdBySales: true, salesAssignedBy: req.user?.id, salesAssignedByName: req.user?.name,
          leadSource: "sales_created",
        });
        logKind = "customer_created";
      }
    } else {
      return res.status(400).json({ success: false, message: "customerId or create is required." });
    }

    style.production.customerId = customer._id;
    if (style.production.status === "not_started") style.production.status = "customer_linked";
    style.production.log = style.production.log || [];
    style.production.log.push({ kind: logKind, note: customer.name, by: actor(req), at: new Date() });

    // Reused for every OTHER style raised for the same account (per the
    // frontend's own design note: "It'll be reused automatically for every
    // other style raised for the same customer").
    if (style.accountId) {
      const account = await Account.findOne(await scoped(req, { _id: style.accountId })).select("linkedCustomer");
      if (account && !account.linkedCustomer) {
        account.linkedCustomer = customer._id;
        await account.save();
      }
    }

    style.updatedBy = actor(req);
    await style.save();
    return res.json({ success: true, customer: { id: customer._id, name: customer.name, email: customer.email, phone: customer.phone } });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/production/customer", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /:id/production/stock-items/search?q=
router.get("/:id/production/stock-items/search", salesAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, stockItems: [] });
    const re = new RegExp(escapeRegex(q), "i");
    const rows = await StockItem.find({ isActive: { $ne: false }, $or: [{ name: re }, { reference: re }] })
      .select("name reference category variants").limit(10).lean();
    return res.json({ success: true, stockItems: rows.map((s) => ({ id: s._id, name: s.name, reference: s.reference, category: s.category, variantCount: s.variants?.length || 0 })) });
  } catch (err) {
    console.error("[sampleStyles] GET /:id/production/stock-items/search", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /:id/production/raw-items/search?q= — also the search behind the
// (unrelated) "Raw materials consumed" picker further up the same R&D page,
// which has used this exact endpoint since it was written.
//
// ── AND IT IS R&D'S ALONE AGAIN ────────────────────────────────────────────
// The Merchandising packaging picker borrowed this because it was here. It no
// longer does: it has its own door at
// `GET /api/cms/merchandising/styles/:styleId/packaging-items`, gated on a
// live Merchandising grant and returning identity only. This endpoint is
// therefore back to one audience and is left exactly as it was — a Sales
// session, this company's item master, and the variant, stock and averaged
// vendor price its own caller needs.
router.get("/:id/production/raw-items/search", salesAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, rawItems: [] });
    /* -- THIS COMPANY'S ITEM MASTER, NOT THE DEPLOYMENT'S ----------------
       The search ran unscoped: any R&D user could see, and pick, an item
       belonging to another company. It went unnoticed because the picker
       only ever wrote a NAME -- nothing downstream resolved the id, so a
       foreign pick produced a plausible-looking row and no error.

       The packaging picker resolves the id, and the server refuses one that
       is not this company's. An unscoped search would therefore offer items
       it then rejects, so it is scoped here by the same company the write
       path uses. */
    const scope = await salesScopeFor(req);
    const re = new RegExp(escapeRegex(q), "i");
    const rows = await RawItem.find({
      companyId: scope.companyId,
      $or: [{ name: re }, { sku: re }],
    })
      .select("name sku unit customUnit category quantity variants").limit(10).lean();
    const rawItems = rows.map((r) => {
      const unit = r.customUnit || r.unit || "Unit";
      const variants = (r.variants || []).map((v) => {
        const prices = (v.vendorNicknames || []).map((vn) => vn.price || 0).filter((p) => p > 0);
        const price = prices.length ? prices.reduce((s, p) => s + p, 0) / prices.length : null;
        return { id: v._id, sku: v.sku, combination: v.combination || [], quantity: v.quantity || 0, price, unitConversions: v.unitConversions || [] };
      });
      return { id: r._id, name: r.name, sku: r.sku, category: r.category, unit, quantity: r.quantity || 0, variants };
    });
    return res.json({ success: true, rawItems });
  } catch (err) {
    console.error("[sampleStyles] GET /:id/production/raw-items/search", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /:id/requirements/resolve  { rawItemIds: [], serviceIds: [] }
 *
 * ARE THE RECORDS THESE SAVED ROWS NAME STILL THERE, AND WHAT DO THEY SAY NOW?
 *
 * -- WHY THIS IS NOT A SEARCH ------------------------------------------------
 * The first cut answered this by searching each row's SAVED NAME and seeing
 * whether anything came back. That is not identity verification, and it was
 * wrong in four separate ways:
 *
 *   1. A renamed item no longer matches its own snapshot, so a perfectly
 *      valid record was marked unavailable and somebody was told to choose it
 *      again -- the one thing a rename must never cause.
 *   2. A name under two characters was never searched at all, so those rows
 *      were silently never checked.
 *   3. The search caps its results, so a common name could push the very
 *      record being looked for off the end of the list.
 *   4. Two names that happen to match one search term made the answer depend
 *      on which rows were on the style.
 *
 * So it resolves by ID. The id is what the row actually stores and what the
 * write path actually refuses, which makes this the same question the save
 * asks -- and the same answer.
 *
 * -- AND MISSING STAYS INDISTINGUISHABLE FROM FOREIGN ------------------------
 * Both answer `available: false` with no name. Saying which would confirm
 * that a record the caller cannot see exists.
 */
router.post("/:id/requirements/resolve", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    /* The style must be the caller's company's before anything is resolved
       against it -- the same proof the write path takes, from the same
       already-authorised request. */
    const scope = await salesScopeFor(req);
    const owned = await ownershipProofFor(style, scope.companyId);
    if (!owned) return res.status(404).json({ success: false, message: "Style not found." });

    const ids = (list) => [...new Set(
      (Array.isArray(list) ? list : []).map((v) => String(v || "")).filter(isObjectId),
    )];
    const rawItemIds = ids(req.body?.rawItemIds);
    const serviceIds = ids(req.body?.serviceIds);

    const items = {};
    if (rawItemIds.length) {
      const docs = await RawItem.find({ companyId: scope.companyId, _id: { $in: rawItemIds } })
        .select("name sku unit customUnit variants._id variants.combination variants.sku").lean();
      const byId = new Map(docs.map((d) => [String(d._id), d]));
      for (const id of rawItemIds) {
        const d = byId.get(id);
        items[id] = d
          ? {
            available: true,
            name: d.name || "",
            sku: d.sku || "",
            /* What the register calls its unit today. Offered as CONTEXT
               beside the unit R&D recorded, never substituted for it. */
            registeredUnit: d.customUnit || d.unit || "",
            variants: (d.variants || []).map((v) => ({
              id: String(v._id),
              label: (v.combination || []).join(" / ") || v.sku || "",
              sku: v.sku || "",
            })),
          }
          /* -- EXISTENCE AND OWNERSHIP ONLY ------------------------------
             `RawItem` has no lifecycle flag: its `status` is derived from
             quantity against reorder levels, which is a stock fact and not a
             statement that the company has stopped buying the thing. Judging
             availability by it would mark an item unavailable for being out
             of stock. Until the master has a real lifecycle, being this
             company's and being there is the whole test. */
          : { available: false };
      }
    }

    const services = {};
    if (serviceIds.length) {
      const docs = await Service.find({ companyId: scope.companyId, _id: { $in: serviceIds } })
        .select("name serviceCode billingUnit sacCode status").lean();
      const byId = new Map(docs.map((d) => [String(d._id), d]));
      for (const id of serviceIds) {
        const d = byId.get(id);
        const active = d && String(d.status || "").toUpperCase() === "ACTIVE";
        /* Unlike RawItem, the Service master HAS a lifecycle -- and the write
           path refuses an inactive one, so this must too or the form would
           pass a row the save then rejects. An INACTIVE service is reported
           as unavailable WITH its name: it is this company's record and the
           caller may already see it, so naming it says what to do rather
           than leaving somebody hunting. */
        services[id] = d
          ? {
            available: Boolean(active),
            name: d.name || "",
            serviceCode: d.serviceCode || "",
            billingUnit: d.billingUnit || "",
            sacCode: d.sacCode || "",
            status: d.status || "",
          }
          : { available: false };
      }
    }

    return res.json({ success: true, items, services });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/requirements/resolve", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /:id/services/search?q= -- the Service Master, for the outside-process
 * picker on the sampling form.
 *
 * -- ACTIVE ONLY, AND THIS COMPANY'S -----------------------------------------
 * A requirement recorded against a service nobody buys any more is a costing
 * that cannot be priced, and the write path refuses one -- so the picker does
 * not offer it either. `defaultRate` is deliberately not in the projection:
 * it is planning guidance by the master's own account, and a field the screen
 * cannot see is a field nobody can mistake for a quoted rate.
 */
router.get("/:id/services/search", salesAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, services: [] });
    const scope = await salesScopeFor(req);
    const re = new RegExp(escapeRegex(q), "i");
    const rows = await Service.find({
      companyId: scope.companyId,
      status: "ACTIVE",
      $or: [{ name: re }, { serviceCode: re }],
    })
      .select("name serviceCode billingUnit sacCode category").limit(10).lean();
    return res.json({
      success: true,
      services: rows.map((r) => ({
        id: r._id, name: r.name, serviceCode: r.serviceCode,
        billingUnit: r.billingUnit || "", sacCode: r.sacCode || "",
        category: r.category || "",
      })),
    });
  } catch (err) {
    console.error("[sampleStyles] GET /:id/services/search", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /:id/development-charges -- the charge TYPES this company has configured
 * for development, pattern and tooling work it performs itself.
 *
 * -- WHY R&D READS THIS AND NOT THE COSTING POLICY ---------------------------
 * The screen first asked `/api/costings/policy/current`, which needs a costing
 * capability -- so an R&D person without one got nothing back and could not
 * classify their own requirement.
 *
 * -- AND WHY NO AMOUNT COMES BACK -------------------------------------------
 * R&D says WHAT work was done; Finance says what the company charges for it.
 * Only the key, the label, the arithmetic and the unit cross this line, so
 * nobody here can read the money, quote it, or be tempted to reconcile it
 * against a figure of their own. The costing reads the amount from the policy
 * itself, at ITS OWN date.
 *
 * -- WHICH IS ALSO WHY A RATE PERIOD IS NOT A FILTER ------------------------
 * A definition is a charge TYPE and the requirement is recorded against the
 * type; which RATE applies is a question with the COSTING's date on it. A
 * style being developed for a season whose rate starts next month would
 * otherwise find the charge missing from its own form.
 *
 * The CATALOGUE, though, is resolved at today. It is a Board policy now, and a
 * catalogue approved to take effect next month is not yet what the company
 * publishes -- offering from it would let a requirement point at a charge that
 * does not exist. The two dating layers do different work, and only the inner
 * one is deliberately ignored here.
 */
router.get("/:id/development-charges", salesAuth, async (req, res) => {
  try {
    const scope = await salesScopeFor(req);
    /* ── ONE ALLOWLIST, NOT A SECOND COPY OF IT ───────────────────────
       The projection that decides what may cross this boundary lives with the
       policy, beside the resolution. A second `.map()` here would be a second
       place for it to widen, and the field that got added would be a rate. */
    const resolved = await developmentChargePolicy
      .resolveFor({ companyId: scope.companyId }).catch(() => null);
    const charges = [...developmentChargePolicy.catalogueForMerchandising(resolved).values()];
    return res.json({ success: true, charges });
  } catch (err) {
    console.error("[sampleStyles] GET /:id/development-charges", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /:id/operations/search?q= — the operation master, for the routing picker.
 *
 * ── WHAT IS AND IS NOT SCOPED HERE ──────────────────────────────────────────
 * The style is proved to this company before anything is read. The OPERATION
 * MASTER itself carries no company — it is one global table of 259 rows, which
 * is the same fact that let QC show all of them for an unrouted piece. Adding
 * tenancy to it is a migration of its own and is not invented here; what this
 * route does is refuse to answer at all unless the caller's style is proved,
 * and return identities rather than free text so nothing downstream matches on
 * a name.
 *
 * No rate of any kind comes back. R&D says WHICH operations and in what order;
 * the labour rate is the company policy's at costing time.
 */
router.get("/:id/operations/search", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    const scope = await salesScopeFor(req);
    if (!(await ownershipProofFor(style, scope.companyId))) {
      return res.status(404).json({ success: false, message: "Style not found." });
    }

    const q = String(req.query.q || "").trim();
    const re = q ? new RegExp(escapeRegex(q), "i") : null;
    const rows = await Operation.find(re ? { $or: [{ name: re }, { operationCode: re }] } : {})
      .select("name operationCode totalSam machineType")
      .sort({ name: 1 })
      .limit(25)
      .lean();

    return res.json({
      success: true,
      operations: rows.map((o) => ({
        id: String(o._id),
        name: o.name || "",
        operationCode: o.operationCode || "",
        /* Standard Allowed Minutes, as the master records it. Shown so the
           person routing can see the shape of the job — never as money. */
        totalSam: o.totalSam ?? null,
        machineType: o.machineType || "",
      })),
    });
  } catch (err) {
    console.error("[sampleStyles] GET /:id/operations/search", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PUT /:id/operations/route — the sample's draft operation route.
 *
 * ── WHY THE WHOLE LIST, IN ORDER ────────────────────────────────────────────
 * A route is a sequence: collar before side seam before hem. Appending one
 * operation at a time cannot express a reorder, and the existing per-operation
 * endpoint took free-text `type` and `machineType`, which is a route matched
 * on spelling. This replaces the list, by identity, in the order given.
 *
 * ── AND IT NEVER TOUCHES A FROZEN ROUTE ─────────────────────────────────────
 * It writes the PRODUCT's route, which is where a new work order reads its
 * own from. Work orders already released carry their own frozen copy and are
 * not reached from here — re-routing a product must never change what a
 * garment already in production was routed through.
 */
router.put("/:id/operations/route", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    const scope = await salesScopeFor(req);
    if (!(await ownershipProofFor(style, scope.companyId))) {
      return res.status(404).json({ success: false, message: "Style not found." });
    }
    const stockItemId = style.production?.stockItemId;
    if (!stockItemId) {
      return res.status(400).json({
        success: false,
        code: "PRODUCT_NOT_REGISTERED",
        message: "Register this style as a product before defining its operation route.",
      });
    }

    const wanted = Array.isArray(req.body?.operationIds) ? req.body.operationIds : [];
    if (!wanted.length) {
      /* Saving an empty route would recreate exactly the state that produced
         a work order with nothing to progress through. */
      return res.status(400).json({
        success: false,
        code: "ROUTE_EMPTY",
        message: "A sample route needs at least one operation. A garment routed through nothing cannot be produced or inspected.",
      });
    }
    const ids = wanted.map(String).filter((x) => isObjectId(x));
    if (ids.length !== wanted.length) {
      return res.status(400).json({ success: false, message: "One of the chosen operations is not a valid record." });
    }

    /* ── RE-READ EVERY OPERATION, AND KEEP THE ORDER ASKED FOR ────────
       The browser sends identities and a sequence. Every name, code, SAM
       and machine type is taken from what came back, never from the
       request: a snapshot a caller can dictate is not a snapshot. */
    const found = await Operation.find({ _id: { $in: ids } })
      .select("name operationCode totalSam machineType").lean();
    const byId = new Map(found.map((o) => [String(o._id), o]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: "One of the chosen operations is no longer in the operation master. Choose it again.",
      });
    }

    const stockItem = await StockItem.findById(stockItemId);
    if (!stockItem) return res.status(404).json({ success: false, message: "Product not found." });

    stockItem.operations = ids.map((id) => {
      const o = byId.get(id);
      const seconds = Number.isFinite(Number(o.totalSam)) ? Math.round(Number(o.totalSam) * 60) : 0;
      return {
        /* The master's own name is the operation's `type` on the product —
           the field the work order reads to build its route. */
        type: o.name || "",
        operationCode: o.operationCode || "",
        machine: o.machineType || "",
        machineType: o.machineType || "",
        totalSeconds: seconds,
        minutes: Math.floor(seconds / 60),
        seconds: seconds % 60,
        /* ── NO RATE IS WRITTEN HERE ──────────────────────────────────
           R&D says which operations and in what order. What an operator
           minute costs is the company's own assumption, read by the costing
           engine from policy at calculation time — a figure typed here
           would be a second, undated answer. */
        operatorSalary: 0,
        operatorCost: 0,
      };
    });
    stockItem.updatedBy = req.user?.id;
    await stockItem.save();

    return res.json({
      success: true,
      message: `Sample route saved: ${ids.length} operation${ids.length === 1 ? "" : "s"}.`,
      operations: stockItem.operations.map((o, i) => ({
        position: i + 1,
        name: o.type,
        operationCode: o.operationCode || "",
        machineType: o.machineType || "",
        totalSam: o.totalSeconds ? Math.round((o.totalSeconds / 60) * 100) / 100 : null,
      })),
    });
  } catch (err) {
    console.error("[sampleStyles] PUT /:id/operations/route", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /:id/production/stock-item  { stockItemId } | { create: { category, attributes, cost, salesPrice, rawItems, operations } }
router.post("/:id/production/stock-item", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    if (!style.production?.customerId) return res.status(400).json({ success: false, message: "Link a customer before registering the product." });

    let stockItem;
    let logKind;
    if (req.body?.stockItemId) {
      if (!isObjectId(req.body.stockItemId)) return res.status(400).json({ success: false, message: "Invalid product." });
      stockItem = await StockItem.findById(req.body.stockItemId);
      if (!stockItem) return res.status(404).json({ success: false, message: "Product not found." });
      logKind = "stock_item_linked";
    } else if (req.body?.create) {
      const { name: nameInput, category, attributes, cost, salesPrice, rawItems, operations } = req.body.create || {};
      // The R&D page's own product-name field is editable (e.g. appending a
      // colourway) before registering — it's what's actually sent here, and
      // falling back to style.productName silently discarded that edit.
      const name = String(nameInput || style.productName || "Product").trim();
      if (!String(category || "").trim()) return res.status(400).json({ success: false, message: "Category is required." });

      const processedAttributes = (Array.isArray(attributes) ? attributes : [])
        .filter((a) => a?.name?.trim() && Array.isArray(a.values) && a.values.length)
        .map((a) => ({ name: a.name.trim(), values: a.values.filter((v) => v?.trim()).map((v) => v.trim()) }));
      if (!processedAttributes.length) return res.status(400).json({ success: false, message: "Add at least one attribute with values." });

      const nameCode = name.split(" ").map((w) => w.substring(0, 3).toUpperCase()).join("");
      const categoryCode = String(category).substring(0, 3).toUpperCase();
      const randomNum = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
      const reference = `PROD-${categoryCode}-${nameCode}-${randomNum}`.toUpperCase();
      const barcode = "89" + Math.floor(Math.random() * 10000000000).toString().padStart(10, "0");

      const processedRawItems = await processVariantRawItems(rawItems);

      // Cartesian expansion of the attribute values — the same one the R&D
      // page's own live preview shows before this call is made.
      const combos = processedAttributes.reduce(
        (acc, a) => acc.flatMap((combo) => a.values.map((v) => [...combo, { name: a.name, value: v }])),
        [[]],
      );
      const variants = combos.map((combo, i) => ({
        sku: `${reference}-V${String(i + 1).padStart(3, "0")}`,
        attributes: combo,
        quantityOnHand: 0, minStock: 10, maxStock: 100,
        cost: Number(cost) || 0, salesPrice: Number(salesPrice) || 0,
        barcode: `${barcode}-${String(i + 1).padStart(3, "0")}`,
        rawItems: processedRawItems,
      }));

      const processedOperations = (Array.isArray(operations) ? operations : []).map((op) => {
        const minutes = Number(op.minutes) || 0, seconds = Number(op.seconds) || 0;
        return { type: op.type || "", operationCode: op.operationCode || "", machine: op.machine || "", machineType: op.machineType || "", minutes, seconds, totalSeconds: minutes * 60 + seconds };
      });

      stockItem = new StockItem({ name, reference, category: String(category).trim(), attributes: processedAttributes, variants, operations: processedOperations, createdBy: req.user?.id });
      recomputeVariantCostsFromBom(stockItem);
      updateStockItemAggregates(stockItem);
      await stockItem.save();
      logKind = "stock_item_created";
    } else {
      return res.status(400).json({ success: false, message: "stockItemId or create is required." });
    }

    style.production.stockItemId = stockItem._id;
    if (["not_started", "customer_linked"].includes(style.production.status)) style.production.status = "stock_item_linked";
    style.production.log = style.production.log || [];
    style.production.log.push({ kind: logKind, note: stockItem.name, by: actor(req), at: new Date() });
    style.updatedBy = actor(req);
    await style.save();

    // "we are storing the product id in the customer schema" (24 Aug 2026,
    // explicit request) — the same field Sales' own product-assignment
    // screen already writes (Customer.assignedStockItems), so this shows up
    // wherever that does, not a second parallel list.
    try {
      const customer = await Customer.findById(style.production.customerId);
      if (customer && !(customer.assignedStockItems || []).some((a) => String(a.stockItemId) === String(stockItem._id))) {
        customer.assignedStockItems.push({ stockItemId: stockItem._id, stockItemName: stockItem.name, stockItemReference: stockItem.reference, assignedBy: req.user?.id, assignedByName: req.user?.name });
        await customer.save();
        style.production.log.push({ kind: "product_assigned", note: `${stockItem.name} → ${customer.name}`, by: actor(req), at: new Date() });
        await style.save();
      }
    } catch (linkErr) {
      console.error("[sampleStyles] product→customer link failed:", linkErr);
    }

    const full = await StockItem.findById(stockItem._id).select("name reference category variants operations").lean();
    return res.json({
      success: true,
      stockItem: full ? { id: full._id, name: full.name, reference: full.reference, category: full.category, variants: (full.variants || []).map((v) => ({ ...v, id: v._id })), operations: full.operations } : null,
    });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/production/stock-item", err);
    if (err.code === 11000) return res.status(400).json({ success: false, message: "A product with a similar reference already exists — try again." });
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/sample-styles/:id/production/order-quantities
// Body: { variants: [{ variantId, quantity }] }
//
// SALES sets how many of each variant to make; R&D only reads it back (26 Aug
// 2026, explicit request: "Sales person will set the qty of the corresponding
// product-variant wise... so that the r&d team can't set the qty as per there
// own ok, only they can see the qty").
//
// Gated on `canApprove` — the SAME gate as the tech-sheet and customer
// decisions, not the wide `salesAuth` the rest of this production section
// uses (that one is deliberately widened to include R&D so they can drive
// their own wizard). Order quantity is a commercial decision, so it takes the
// commercial gate.
//
// Gated on the tech sheet being settled, too: before that the spec can still
// change, and a quantity typed against a variant list that may not survive
// review is a number nobody should rely on. `notApplicable` counts as settled
// — a style raised from a registered product never gets a tech sheet at all,
// and waiting for one would mean its quantities could never be set.
router.post("/:id/production/order-quantities", salesAuth, async (req, res) => {
  try {
    if (!(await canApprove(req.user))) {
      return res.status(403).json({ success: false, message: "Only Sales can set order quantities." });
    }
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });

    const techStatus = style.techSheet?.status;
    if (techStatus !== "approved" && techStatus !== "notApplicable") {
      return res.status(400).json({ success: false, message: "Approve the tech sheet before setting order quantities." });
    }
    if (style.production?.status === "submitted") {
      return res.status(400).json({ success: false, message: "This style has already been sent to production." });
    }

    const stockItemId = style.production?.stockItemId || style.sourceStockItemId;
    if (!stockItemId) return res.status(400).json({ success: false, message: "Register the product before setting quantities." });
    const stockItem = await StockItem.findById(stockItemId).select("variants").lean();
    if (!stockItem) return res.status(404).json({ success: false, message: "The linked product no longer exists." });

    // Resolve every row against the REAL variant list rather than trusting the
    // body — the same discipline /production/submit already applies, and the
    // reason its own quantities were reliable even though nothing persisted
    // them.
    const byId = new Map((stockItem.variants || []).map((v) => [String(v._id), v]));
    const rows = Array.isArray(req.body?.variants) ? req.body.variants : [];
    const orderVariants = [];
    for (const row of rows) {
      const v = row?.variantId ? byId.get(String(row.variantId)) : null;
      const qty = Number(row?.quantity);
      if (!v || !Number.isFinite(qty) || qty <= 0) continue; // a zero/blank row means "not ordering this variant"
      orderVariants.push({
        variantId: v._id,
        variantLabel: (v.attributes || []).map((a) => a?.value).filter(Boolean).join(" / "),
        sku: v.sku || "",
        quantity: qty,
      });
    }
    if (!orderVariants.length) {
      return res.status(400).json({ success: false, message: "Set a quantity against at least one variant." });
    }

    const who = actor(req);
    const total = orderVariants.reduce((n, v) => n + v.quantity, 0);
    if (!style.production) style.production = {};
    style.production.orderVariants = orderVariants;
    style.production.orderVariantsSetAt = new Date();
    style.production.orderVariantsSetBy = who;
    style.production.log = style.production.log || [];
    style.production.log.push({
      kind: "order_quantities_set",
      note: `${orderVariants.length} variant(s), ${total} pcs total.`,
      by: who,
      at: new Date(),
    });
    logHistory(style, { kind: "order_quantities_set", note: `${total} pcs across ${orderVariants.length} variant(s).` }, req);
    style.updatedBy = who;
    await style.save();

    return res.json({ success: true, sampleStyle: await withJourney(style, req) });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/production/order-quantities", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /:id/production/submit  { variants: [{variantId, quantity}], priority?, deliveryDeadline? }
//
// `variants` is an ARRAY keyed by variantId, not a map — and the caller
// (the R&D page's own `submit()`) already filters out zero/unchecked rows
// before sending, so an empty array here means exactly what it says: no
// variant had a quantity set (24 Aug 2026 bug fix — this route used to
// expect `{ quantities: {...} }`, a shape nothing ever sent, so a real
// quantity that WAS entered still came back as "set a quantity for at
// least one variant").
router.post("/:id/production/submit", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });

    // ── AN IN-HOUSE SAMPLE HAS NO CUSTOMER TO LINK ────────────────────────
    // Every other style reaches here with `production.customerId` already set
    // by R&D's own Step 1. A house sample has nobody to put there, so it
    // borrows the standing "Grav Sampling Order" account instead — created on
    // first use, renameable from Sales Settings. See
    // services/houseSamplingCustomer.service.js for why one shared account
    // rather than a throwaway customer per sample.
    //
    // Done HERE rather than at creation because the account is only needed at
    // the moment an order is actually raised — a sample that never reaches
    // production should not conjure a customer record as a side effect.
    if (style.sampleType === "house" && !style.production?.customerId) {
      const { resolveHouseSamplingCustomer } = require("../../../services/houseSamplingCustomer.service");
      const house = await resolveHouseSamplingCustomer();
      style.production = style.production || {};
      style.production.customerId = house._id;
      if (style.production.status === "not_started") style.production.status = "customer_linked";
      style.production.log = style.production.log || [];
      style.production.log.push({
        kind: "customer_linked",
        at: new Date(),
        byName: actor(req).name,
        note: `In-house sample — billed to the house account "${house.name}".`,
      });
    }

    if (!style.production?.customerId) return res.status(400).json({ success: false, message: "Link a customer first." });
    // `sourceStockItemId` is the FALLBACK, not an alternative — see GET
    // /:id/production's own comment. `production.stockItemId` is only set by
    // walking this wizard's own Product step; a style whose product was
    // already registered when it was raised (every house sample, since
    // 1 Sept 2026 — see RaiseHouseSample.js) never sets it, and reported
    // "Register the product first" at the very last step even though the
    // product plainly existed the whole time and Sales had already set
    // quantities against its variants (1 Sept 2026 bug fix — this was the
    // one place left still checking only `production.stockItemId`).
    const targetStockItemId = style.production?.stockItemId || style.sourceStockItemId;
    if (!targetStockItemId) return res.status(400).json({ success: false, message: "Register the product first." });
    if (style.production.status === "submitted") return res.status(400).json({ success: false, message: "Already sent to production." });

    // Freeze the Sales-approved technical route onto the product immediately
    // before the sample MO/WO is created. Production therefore receives its
    // ordinary route, scanning and QC protocol without a second R&D entry.
    await syncApprovedTechnicalRoute(style, req.user?.id);

    const stockItem = await StockItem.findById(targetStockItemId).select("name reference variants").lean();
    if (!stockItem) return res.status(404).json({ success: false, message: "The registered product could not be found." });
    const customer = await Customer.findById(style.production.customerId).select("name email phone profile").lean();
    if (!customer) return res.status(404).json({ success: false, message: "The linked customer could not be found." });

    // QUANTITIES COME FROM WHAT SALES SET, NOT FROM THE REQUEST BODY (26 Aug
    // 2026). This route is reachable by R&D — `salesAuth` here is deliberately
    // widened to the R&D roles so they can drive their own production wizard —
    // so honouring `req.body.variants` let R&D send any quantity it liked,
    // which is exactly what the request to move this decision to Sales was
    // about. The body is now ignored for quantities; the persisted
    // `production.orderVariants` is the only source.
    const variantsById = new Map((stockItem.variants || []).map((v) => [String(v._id), v]));
    const ordered = style.production?.orderVariants || [];
    if (!ordered.length) {
      return res.status(400).json({ success: false, message: "Sales hasn't set the sample quantities for this style yet." });
    }
    const variants = [];
    for (const row of ordered) {
      const qty = Number(row?.quantity) || 0;
      const v = row?.variantId ? variantsById.get(String(row.variantId)) : null;
      // A variant deleted from the register after Sales set its quantity is
      // skipped rather than failing the whole submission — the remaining
      // lines are still a valid order.
      if (qty <= 0 || !v) continue;
      variants.push({ variantId: String(v._id), attributes: v.attributes || [], quantity: qty, specialInstructions: [], estimatedPrice: (v.salesPrice || 0) * qty });
    }
    if (!variants.length) return res.status(400).json({ success: false, message: "None of the ordered variants still exist on the product — ask Sales to set the quantities again." });
    const totalQuantity = variants.reduce((s, v) => s + v.quantity, 0);

    const priority = ["low", "medium", "high", "urgent"].includes(req.body?.priority) ? req.body.priority : "medium";
    const deliveryDeadline = req.body?.deliveryDeadline ? new Date(req.body.deliveryDeadline) : null;

    const requestId = await nextRequestId(CustomerRequest);
    const request = new CustomerRequest({
      requestId,
      customerId: customer._id,
      customerInfo: {
        name: customer.name, email: customer.email, phone: customer.phone,
        address: customer.profile?.address?.street || "", city: customer.profile?.address?.city || "",
        postalCode: customer.profile?.address?.pincode || "",
        description: style.sampleType === "house"
          ? `In-house sampling run for "${style.productName}" (${style.sampleStyleId}) — no customer order behind it.`
          : `Sampling production run for "${style.productName}" (${style.sampleStyleId}).`,
        deliveryDeadline,
        preferredContactMethod: "phone",
      },
      items: [{ stockItemId: stockItem._id, stockItemName: stockItem.name, stockItemReference: stockItem.reference, variants, totalQuantity, totalEstimatedPrice: variants.reduce((s, v) => s + v.estimatedPrice, 0) }],
      status: "pending",
      priority,
      createdBySales: true,
      createdBySalesId: req.user?.id,
      // WHAT KIND OF ORDER THIS IS, stated once and read everywhere — the MO
      // badge, the Project Manager's email and the order PDF all take it from
      // here rather than each re-deriving it from `isInternalOrder` (which is
      // also set by a salesperson marking a real customer's order as
      // company-funded, and so cannot tell the two apart). Every style that
      // reaches this route is a sampling run; `house` vs journey-linked only
      // changes whose name is on it, not what it is.
      orderOrigin: "sampling",
      sampleStyleId: style._id,
      // Internal / company order — R&D's own sample run, not a real customer
      // order, so it bypasses PI/payment exactly like Sales' own "mark as
      // internal order" (quotationRoutes.js).
      isInternalOrder: true,
      internalOrderMarkedAt: new Date(),
      quotations: [{
        date: new Date(), validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        items: [], subtotalBeforeGST: 0, totalDiscount: 0, totalGST: 0, shippingCharges: 0, grandTotal: 0,
        status: "sales_approved",
        notes: "Internal / Company Order — sampling production run, no PI or payment required.",
        customerApproval: { approved: true, approvedAt: new Date() },
        salesApproval: { approved: true, approvedAt: new Date(), approvedBy: req.user?.id },
      }],
      finalOrderPrice: 0,
      salesPersonAssigned: req.user?.id,
    });
    request.status = "quotation_sales_approved";
    await request.save();

    const { createdWorkOrders, unroutedProducts } = await createWorkOrdersAndProgress(request, req.user?.id);

    /* A production release without a work order is not a release.  The
       previous path saved the internal request and advanced the style even
       when the factory returned an empty list, leaving R&D waiting forever
       for work that did not exist.  Roll back this just-created request (and
       any partial work orders) before reporting the route problem. */
    if (unroutedProducts.length || !createdWorkOrders.length) {
      if (createdWorkOrders.length) {
        await WorkOrder.deleteMany({ _id: { $in: createdWorkOrders.map((wo) => wo._id) } });
      }
      await CustomerRequest.deleteOne({ _id: request._id });
      return res.status(409).json({
        success: false,
        code: "SAMPLE_WORK_ORDERS_NOT_CREATED",
        message: unroutedProducts.length
          ? "The approved production route could not be turned into work orders. Return the technical record to R&D to correct the route."
          : "No sample work orders were created. The sample has not been released to Production.",
        products: unroutedProducts,
      });
    }

    /* ── EVERY ATTEMPT'S WORK ORDERS ARE KEPT, NOT REPLACED ───────────────
       This used to assign, which was correct while a style could only ever be
       sent to production once. A style whose first attempt was cancelled and
       returned to R&D can be sent again, and assigning would drop the
       cancelled order out of the style's own record — the readback, the R&D
       page's history and the "is anything still governing this style" check
       all read this list. The work order itself would survive in its own
       collection, but nothing would point at it any more.

       Appending is identical to assigning on a first submission, where the
       list is empty. */
    const previousWorkOrderIds = (style.production.workOrderIds || []).map(String);
    const previousRequestId = style.production.customerRequestId || null;
    style.production.customerRequestId = request._id;
    style.production.workOrderIds = [
      ...(style.production.workOrderIds || []),
      ...createdWorkOrders.map((w) => w._id),
    ];
    style.production.status = "submitted";
    style.production.log = style.production.log || [];
    // Kept separate from the push above so the response can hand back
    // exactly the entries THIS call added — the R&D page replays them one
    // at a time as "what just happened", not the style's whole history.
    const newEntries = [
      /* A resubmission supersedes the previous request as the CURRENT one.
         Said in the log, because `customerRequestId` now points somewhere
         else and the earlier request is otherwise reachable only through the
         cancelled work order. Nothing is deleted. */
      ...(previousWorkOrderIds.length
        ? [{
          kind: "attempt_replaced",
          note: `Replacement attempt. The previous attempt's ${previousWorkOrderIds.length} work order(s)${previousRequestId ? " and its request" : ""} stay on record.`,
          by: actor(req), at: new Date(),
        }]
        : []),
      { kind: "request_created", note: request.requestId, by: actor(req), at: new Date() },
      { kind: "sales_approved", note: "Internal order — auto-approved.", by: actor(req), at: new Date() },
      { kind: "work_orders_created", note: `${createdWorkOrders.length} work order(s).`, by: actor(req), at: new Date() },
    ];
    style.production.log.push(...newEntries);
    style.updatedBy = actor(req);
    await style.save();

    return res.json({
      success: true,
      /* THIS call's work orders, not the style's cumulative list. The list is
         now kept across attempts, and "3 work orders created" has to mean the
         three that were just created — the readback is where the whole
         history is asked for. */
      workOrderIds: createdWorkOrders.map((w) => w._id),
      allWorkOrderIds: style.production.workOrderIds,
      customerRequestId: request._id,
      log: newEntries,
    });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/production/submit", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /:id/production/reset — clears the wizard so R&D can run it again.
// Never touches anything already sent to production (customerRequestId /
// workOrderIds stay put — blocked outright once status is "submitted").
router.post("/:id/production/reset", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });
    if (style.production?.status === "submitted") {
      return res.status(400).json({ success: false, message: "This has already been sent to production — nothing to reset." });
    }
    style.production.customerId = undefined;
    style.production.stockItemId = undefined;
    // The order quantities go too: they are variant ids belonging to the
    // stock item just unlinked, so keeping them would leave figures pointing
    // at variants this style no longer has (26 Aug 2026). Sales sets them
    // again once the product is re-registered.
    style.production.orderVariants = [];
    style.production.orderVariantsSetAt = null;
    style.production.orderVariantsSetBy = undefined;
    style.production.status = "not_started";
    style.production.log = style.production.log || [];
    style.production.log.push({ kind: "reset", note: "", by: actor(req), at: new Date() });
    style.updatedBy = actor(req);
    await style.save();
    return res.json({ success: true, production: { status: style.production.status, customer: null, accountPrefill: null, stockItem: null, customerRequest: null, workOrderIds: [], workOrders: [], log: style.production.log } });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/production/reset", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/sample-styles/:id/development-record
//
// The evidence behind "this style needs no development".
//
// A style raised from a registered product skips the tech sheet and the sample.
// This is what the stage shows in their place — and it is deliberately capable
// of saying the evidence is THIN, because a registered product is not
// automatically a developed one. A stock item created five minutes ago with a
// name and nothing else would otherwise wave a style straight past R&D.
const { buildDevelopmentRecord } = require("../../../services/developmentRecord");

router.get("/:id/development-record", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });

    if (!style.sourceStockItemId) {
      return res.json({ success: true, record: buildDevelopmentRecord({}) });
    }

    const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem");
    const [stockItem, priorRaw] = await Promise.all([
      StockItem.findById(style.sourceStockItemId)
        .select("name reference category operations variants.rawItems measurements images").lean(),
      // Earlier styles for the SAME product, on any other journey. The strongest
      // evidence there is: a sample this factory actually made and Sales signed.
      SampleStyle.find({
        sourceStockItemId: style.sourceStockItemId,
        _id: { $ne: style._id },
        isActive: true,
      }).select("journeyId sample.status sample.approvedAt sample.rounds").limit(20).lean(),
    ]);

    // Decorate each prior style with its journey reference, so the record can
    // name where it was approved rather than showing a raw id.
    const journeyIds = [...new Set(priorRaw.map((p) => String(p.journeyId)).filter(Boolean))];
    const journeys = journeyIds.length
      ? await SalesJourney.find(await scoped(req, { _id: { $in: journeyIds } })).select("journeyId").lean()
      : [];
    const refById = Object.fromEntries(journeys.map((j) => [String(j._id), j.journeyId]));
    const priorStyles = priorRaw.map((p) => ({ ...p, journeyRef: refById[String(p.journeyId)] || null }));

    return res.json({ success: true, record: buildDevelopmentRecord({ stockItem, priorStyles }) });
  } catch (err) {
    console.error("[sampleStyles] GET /:id/development-record", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// VARIANTS — one enquiry product, several styles developed side by side
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/cms/crm/sample-styles/:id/variants
// Branch this style into a sibling: same product, different execution.
//
// A variant is a full style — its own tech sheet, its own sample ladder, its
// own two gates — because that is what it is in the building. What it inherits
// is the brief, so raising "the same polo in white PC" is one field and not a
// retyped requirement. What it never inherits is a phase: see buildVariantDoc.
router.post("/:id/variants", salesAuth, async (req, res) => {
  try {
    const parent = await resolveStyle(req.params.id);
    if (!parent) return res.status(404).json({ success: false, message: "Style not found." });

    const label = String(req.body?.label || "").trim();
    if (!label) return res.status(400).json({ success: false, message: "Give the variant a name — what makes it different?" });

    const variantKey = variantKeyFrom(label);
    // "" is the base variant's key, so a label that slugs to nothing would
    // collide with the style this was branched from rather than sit beside it.
    if (!variantKey) return res.status(400).json({ success: false, message: "That name has no letters or numbers in it — try something like “White PC”." });

    const family = await SampleStyle.find({
      journeyId: parent.journeyId,
      productName: parent.productName,
      isActive: true,
    }).select("variantKey variantLabel styleCode").lean();

    if (family.some((f) => (f.variantKey || "") === variantKey)) {
      return res.status(409).json({ success: false, message: `“${label}” already exists for this product.` });
    }

    const base = family.find((f) => !f.variantKey) || parent;
    const doc = buildVariantDoc(parent, {
      label,
      note: req.body?.note,
      brief: req.body?.brief,
      styleCode: variantStyleCode(base.styleCode, family.filter((f) => f.variantKey).length),
      actor: actor(req),
    });

    const style = await createWithRef(SampleStyle, doc);
    logHistory(style, { kind: "variant_raised", note: `${label}${req.body?.note ? ` — ${req.body.note}` : ""}` }, req);
    await style.save();

    return res.status(201).json({ success: true, sampleStyle: await withJourney(style, req) });
  } catch (err) {
    // The compound unique is the real guard; the check above is only the good
    // error message. A race lands here.
    if (err?.code === 11000) return res.status(409).json({ success: false, message: "That variant already exists for this product." });
    console.error("[sampleStyles] POST /:id/variants", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/sample-styles/:id/choose
// The customer picked this one. Clears the flag on its siblings in the same
// pass, so "chosen" can never be true twice for a product.
//
// Deliberately NOT a status: a style can be approved and still not be the one
// chosen, and the ones not chosen stay exactly as they are — they are the
// record of what was offered.
router.post("/:id/choose", salesAuth, async (req, res) => {
  try {
    if (!(await canApprove(req.user))) return res.status(403).json({ success: false, message: "Only Sales can choose the variant." });
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });

    await SampleStyle.updateMany(
      { journeyId: style.journeyId, productName: style.productName, _id: { $ne: style._id } },
      { $set: { variantChosen: false } },
    );
    style.variantChosen = true;
    logHistory(style, { kind: "variant_chosen", note: (req.body?.note || "").trim() }, req);
    style.updatedBy = actor(req);
    await style.save();

    return res.json({ success: true, sampleStyle: await withJourney(style, req) });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/choose", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
