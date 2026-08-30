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
const crypto = require("crypto");
const mongoose = require("mongoose");

const SampleStyle = require("../../../models/CMS_Models/Sales/SampleStyle");
const SalesJourney = require("../../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../../models/CMS_Models/Sales/Account");
const Customer = require("../../../models/Customer_Models/Customer");
const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem");
const RawItem = require("../../../models/CMS_Models/Inventory/Products/RawItem");
const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const Unit = require("../../../models/CMS_Models/Inventory/Configurations/Unit");
const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
const { createWorkOrdersAndProgress } = require("./quotationRoutes");
const { processVariantRawItems, updateStockItemAggregates, recomputeVariantCostsFromBom } = require("../../CMS_Routes/Inventory/Products/stockItems");
const { nextRequestId } = require("../../../services/requestId");
const { sendCustomerEmail } = require("../../../utils/salesEmailService");
const { notifyEvent, APP_URL: DEPT_NOTIFY_APP_URL } = require("../../../services/departmentNotify.service");
const { styleEmailContext, imageGalleryHtml, bomTableHtml, stockItemBom } = require("../../../services/sampleStyleEmail.service");
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
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

// For the department-notification emails below.
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

// So every notification email can say WHICH customer this style belongs to.
async function customerNameFor(style) {
  if (!style?.accountId) return "—";
  const acc = await Account.findById(style.accountId).select("displayName companyName").lean();
  return acc?.displayName || acc?.companyName || "—";
}

// The style's own reference image — the SAME one the Enquiry/RFQ stage
// captured for this product, since SampleStyle carries no images of its own
// until R&D submits an actual sample photo (see the `/sample` submit action,
// which DOES have its own photos — that one is used directly instead of this).
async function referenceImageFor(style) {
  if (!style?.enquiryId) return null;
  const enq = await Enquiry.findById(style.enquiryId).select("products").lean();
  return enq?.products?.find((p) => p.product === style.productName)?.images?.[0] || null;
}

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

async function loadJourney(journeyRef) {
  const query = isObjectId(journeyRef)
    ? { $or: [{ _id: journeyRef }, { journeyId: journeyRef }] }
    : { journeyId: journeyRef };
  return SalesJourney.findOne({ ...query, isActive: true });
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
  return {
    ...o,
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

// Re-decorate a saved style with its journey + customer + enquiry for the response.
async function withJourney(styleDoc) {
  const [j, acc, enquiry] = await Promise.all([
    SalesJourney.findById(styleDoc.journeyId).select("journeyId name").lean(),
    styleDoc.accountId ? Account.findById(styleDoc.accountId).select("accountId companyName displayName").lean() : null,
    styleDoc.enquiryId
      ? Enquiry.findById(styleDoc.enquiryId)
        .select("enquiryId title summary priority seriousness enquiryDate requirementDeadline expectedClosingDate")
        .lean()
      : null,
  ]);
  return decorate(styleDoc, j, acc, enquiry);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cms/crm/sample-styles/by-journey/:journeyRef
// Get-or-create one SampleStyle per enquiry product, refreshing the brief.
// POST /by-journey/:journeyRef/provision — raise a style per enquiry product.
// Idempotent, and the only place that creates styles besides the journey's own
// stage transition. Sales calls it when handing the journey to R&D.
router.post("/by-journey/:journeyRef/provision", salesAuth, async (req, res) => {
  try {
    const journey = await loadJourney(req.params.journeyRef);
    if (!journey) return res.status(404).json({ success: false, message: "Journey not found." });

    const [enquiry, account] = await Promise.all([
      Enquiry.findOne({ journeyId: journey._id, isActive: true }).select("products").lean(),
      journey.accountId ? Account.findById(journey.accountId).select("accountId companyName displayName").lean() : null,
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

    return res.json({
      success: true,
      created, renamed, backfilled, waived,
      sampleStyles: styles.map((s) => decorate(s, journey, account)),
    });
  } catch (err) {
    console.error("[sampleStyles] POST /by-journey/:journeyRef/provision", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/by-journey/:journeyRef", salesAuth, async (req, res) => {
  try {
    const journey = await loadJourney(req.params.journeyRef);
    if (!journey) return res.status(404).json({ success: false, message: "Journey not found." });

    // READ ONLY. Provisioning lives in POST /by-journey/:journeyRef/provision
    // and in the journey's own stage transition — a GET that creates records
    // meant a style existed only once someone opened the journey, and any
    // prefetch or double-render wrote to the database.
    const [styles, account] = await Promise.all([
      SampleStyle.find({ journeyId: journey._id, isActive: true }).sort({ createdAt: 1 }),
      journey.accountId ? Account.findById(journey.accountId).select("accountId companyName displayName").lean() : null,
    ]);

    return res.json({ success: true, sampleStyles: styles.map((s) => decorate(s, journey, account)) });
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
      ? await Account.find({ _id: { $in: accountIds } }).select("accountId companyName displayName").lean()
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
    return res.json({ success: true, sampleStyle: await withJourney(style) });
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
function sanitizeMaterialsRawItems(input) {
  if (!Array.isArray(input)) return [];
  const rows = input.filter((r) => r && isObjectId(r.rawItemId));
  const missingQty = rows.find((r) => r.quantity == null || r.quantity === "" || Number(r.quantity) <= 0);
  if (missingQty) {
    const err = new Error(`Quantity is required for "${missingQty.rawItemName || "a raw item"}".`);
    err.status = 400;
    throw err;
  }
  return rows.map((r) => ({
    rawItemId: r.rawItemId,
    rawItemName: String(r.rawItemName || "").trim(),
    rawItemSku: String(r.rawItemSku || "").trim(),
    variantId: isObjectId(r.variantId) ? r.variantId : undefined,
    variantCombination: Array.isArray(r.variantCombination) ? r.variantCombination.filter(Boolean) : [],
    productVariantId: isObjectId(r.productVariantId) ? r.productVariantId : undefined,
    productVariantLabel: String(r.productVariantLabel || "").trim(),
    quantity: Number(r.quantity),
    unit: String(r.unit || "").trim(),
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
        const [customerName, image] = await Promise.all([customerNameFor(style), referenceImageFor(style)]);
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
          ctaUrl: `${DEPT_NOTIFY_APP_URL}/sales/dashboard/journeys/${style.journeyId}/style-sample`,
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
    return res.json({ success: true, sampleStyle: await withJourney(style) });
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
    return res.json({ success: true, status: entry.status, sampleStyle: await withJourney(style) });
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
        const c = await styleEmailContext(style);
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
        const c = await styleEmailContext(style);
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

    return res.json({ success: true, sampleStyle: await withJourney(style) });
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

    return res.json({ success: true, sampleStyle: await withJourney(style) });
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

    const c = await styleEmailContext(style);
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

    return res.json({ success: true, sentTo: result.sent, sampleStyle: await withJourney(style) });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/bom-approval/request", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/sample-styles/:id/tech-sheet  { action, note?, file? }
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
    } else if (action === "submit") {
      if (!can("submitted")) return invalid("submitted");
      style.techSheet.status = "submitted";
      style.techSheet.submittedAt = new Date();
      if (req.body.file && (req.body.file.url || req.body.file.name)) {
        style.techSheet.file = { name: req.body.file.name, url: req.body.file.url, uploadedAt: new Date() };
      }
    } else if (action === "approve") {
      if (!(await canApprove(req.user))) return res.status(403).json({ success: false, message: "Only Sales can approve the tech sheet." });
      if (!can("approved")) return invalid("approved");
      style.techSheet.status = "approved";
      style.techSheet.approvedAt = new Date();
      style.techSheet.approvedBy = actor(req);
    } else if (action === "changes") {
      if (!(await canApprove(req.user))) return res.status(403).json({ success: false, message: "Only Sales can request changes." });
      if (!can("changes")) return invalid("changes");
      style.techSheet.status = "changes";
      style.techSheet.revisions.push({ note: (req.body.note || "").trim(), at: new Date(), by: actor(req) });
    } else {
      return res.status(400).json({ success: false, message: "Unknown tech-sheet action." });
    }

    const tsKind = { submit: "tech_submitted", approve: "tech_approved", changes: "tech_changes" }[action];
    if (tsKind) logHistory(style, { kind: tsKind, note: req.body.note || "" }, req);
    style.updatedBy = actor(req);
    await style.save();

    if (action === "submit") {
      (async () => {
        const [customerName, image] = await Promise.all([customerNameFor(style), referenceImageFor(style)]);
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
          ctaUrl: `${DEPT_NOTIFY_APP_URL}/sales/dashboard/journeys/${style.journeyId}/style-sample`,
        });
      })().catch(() => {});
    } else if (action === "approve" || action === "changes") {
      (async () => {
        const [customerName, image] = await Promise.all([customerNameFor(style), referenceImageFor(style)]);
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

    return res.json({ success: true, sampleStyle: await withJourney(style) });
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

      // Operations R&D actually ran making this sample — optional, unlike the
      // raw items/photo above (24 Aug 2026, explicit request: "don't make it
      // mandatory"). Blank rows (no type) are dropped rather than rejected.
      const operationsInput = Array.isArray(req.body.operations) ? req.body.operations : [];
      const operations = operationsInput
        .filter((o) => o && String(o.type || "").trim())
        .map((o) => {
          const minutes = Number(o.minutes) || 0;
          const seconds = Number(o.seconds) || 0;
          return {
            type: String(o.type).trim(),
            operationCode: String(o.operationCode || "").trim(),
            machine: String(o.machine || "").trim(),
            machineType: String(o.machineType || "").trim(),
            minutes, seconds,
            totalSeconds: o.totalSeconds != null ? Number(o.totalSeconds) || 0 : minutes * 60 + seconds,
          };
        });

      style.sample.consumptionRawItems = consumptionRawItems;
      style.sample.operations = operations;
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
              stockItem.operations = style.sample.operations.map((o) => ({
                type: o.type, operationCode: o.operationCode, machine: o.machine, machineType: o.machineType,
                minutes: o.minutes, seconds: o.seconds, totalSeconds: o.totalSeconds,
              }));
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
        const customerName = await customerNameFor(style);
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
          ctaUrl: `${DEPT_NOTIFY_APP_URL}/sales/dashboard/journeys/${style.journeyId}/style-sample`,
        });
      })().catch(() => {});
    } else if (action === "approve" || action === "reject") {
      (async () => {
        const customerName = await customerNameFor(style);
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

    // Auto-send the WhatsApp approval request the moment Sales approves the
    // sample internally (26 Aug 2026, explicit request: "this approval
    // request need to auto sent to that customer ok in whatsapp... so that
    // will auto trigger here in our website"). Fire-and-forget, same as the
    // notification block above — a WhatsApp outage or missing template
    // config must never fail the approval action itself; the result is only
    // ever visible via style.customerApproval.whatsapp on the next read.
    if (action === "approve") {
      (async () => {
        const [customerName, j] = await Promise.all([
          customerNameFor(style),
          SalesJourney.findById(style.journeyId).select("journeyId").lean(),
        ]);
        const { sendApprovalRequest } = require("../../../services/sampleWhatsapp");
        const result = await sendApprovalRequest(style, { customerName, enquiryRef: j?.journeyId, preparedBy: actor(req).name });
        if (!result.sent) console.warn(`[sampleStyles] WhatsApp approval request not sent for ${style.sampleStyleId || style._id}: ${result.reason}`);
      })().catch((err) => console.error("[sampleStyles] WhatsApp auto-send failed:", err.message));
    }

    return res.json({ success: true, sampleStyle: await withJourney(style) });
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

    return res.json({ success: true, sampleStyle: await withJourney(style) });
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
      customerNameFor(style),
      SalesJourney.findById(style.journeyId).select("journeyId").lean(),
    ]);
    const { sendApprovalRequest } = require("../../../services/sampleWhatsapp");
    const result = await sendApprovalRequest(style, { customerName, enquiryRef: j?.journeyId, preparedBy: actor(req).name });
    if (!result.sent) return res.status(502).json({ success: false, message: result.reason });
    return res.json({ success: true, sampleStyle: await withJourney(style) });
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
router.post("/:id/sample/customer-decision", salesAuth, async (req, res) => {
  try {
    if (!(await canApprove(req.user))) return res.status(403).json({ success: false, message: "Only Sales can record the customer's decision." });
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });

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

    return res.json({ success: true, sampleStyle: await withJourney(style) });
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
      const account = await Account.findById(style.accountId).select("companyName displayName primaryEmail primaryPhone linkedCustomer");
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
    }

    let workOrders = [];
    if (style.production.workOrderIds?.length) {
      const rows = await WorkOrder.find({ _id: { $in: style.production.workOrderIds } })
        .select("workOrderNumber status quantity completedQuantity variantAttributes").lean();
      workOrders = rows.map((w) => ({ id: w._id, workOrderNumber: w.workOrderNumber, status: w.status, quantity: w.quantity, completedQuantity: w.completedQuantity || 0, attributes: w.variantAttributes }));
    }

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
      const account = await Account.findById(style.accountId).select("linkedCustomer");
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
    const rows = await StockItem.find({ $or: [{ name: re }, { reference: re }] })
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
router.get("/:id/production/raw-items/search", salesAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, rawItems: [] });
    const re = new RegExp(escapeRegex(q), "i");
    const rows = await RawItem.find({ $or: [{ name: re }, { sku: re }] })
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

    return res.json({ success: true, sampleStyle: await withJourney(style) });
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
    if (!style.production?.customerId) return res.status(400).json({ success: false, message: "Link a customer first." });
    if (!style.production?.stockItemId) return res.status(400).json({ success: false, message: "Register the product first." });
    if (style.production.status === "submitted") return res.status(400).json({ success: false, message: "Already sent to production." });

    const stockItem = await StockItem.findById(style.production.stockItemId).select("name reference variants").lean();
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
      return res.status(400).json({ success: false, message: "Sales hasn't set the order quantities for this style yet." });
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
        description: `Sampling production run for "${style.productName}" (${style.sampleStyleId}).`,
        deliveryDeadline,
        preferredContactMethod: "phone",
      },
      items: [{ stockItemId: stockItem._id, stockItemName: stockItem.name, stockItemReference: stockItem.reference, variants, totalQuantity, totalEstimatedPrice: variants.reduce((s, v) => s + v.estimatedPrice, 0) }],
      status: "pending",
      priority,
      createdBySales: true,
      createdBySalesId: req.user?.id,
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

    const { createdWorkOrders } = await createWorkOrdersAndProgress(request, req.user?.id);

    style.production.customerRequestId = request._id;
    style.production.workOrderIds = createdWorkOrders.map((w) => w._id);
    style.production.status = "submitted";
    style.production.log = style.production.log || [];
    // Kept separate from the push above so the response can hand back
    // exactly the entries THIS call added — the R&D page replays them one
    // at a time as "what just happened", not the style's whole history.
    const newEntries = [
      { kind: "request_created", note: request.requestId, by: actor(req), at: new Date() },
      { kind: "sales_approved", note: "Internal order — auto-approved.", by: actor(req), at: new Date() },
      { kind: "work_orders_created", note: `${createdWorkOrders.length} work order(s).`, by: actor(req), at: new Date() },
    ];
    style.production.log.push(...newEntries);
    style.updatedBy = actor(req);
    await style.save();

    return res.json({ success: true, workOrderIds: style.production.workOrderIds, customerRequestId: request._id, log: newEntries });
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
      ? await SalesJourney.find({ _id: { $in: journeyIds } }).select("journeyId").lean()
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

    return res.status(201).json({ success: true, sampleStyle: await withJourney(style) });
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

    return res.json({ success: true, sampleStyle: await withJourney(style) });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/choose", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
