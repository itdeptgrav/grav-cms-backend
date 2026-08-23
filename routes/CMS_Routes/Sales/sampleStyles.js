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
const { sendCustomerEmail } = require("../../../utils/salesEmailService");
const { notifyEvent, APP_URL: DEPT_NOTIFY_APP_URL } = require("../../../services/departmentNotify.service");
const salesAuthBase = require("../../../Middlewear/SalesAuthMiddlewear");

// R&D owns the tech sheet and the sample rounds, so R&D must be able to call
// these routes — and until now could not: every one of them was guarded by the
// CRM's role list, which has no R&D entry, so the whole app/research-development
// surface 403'd. Widened here only, not in the CRM guard itself.
const salesAuth = salesAuthBase.withRoles(salesAuthBase.RND_ROLES);
const { isSalesManager, bypassesApproval } = require("../../../services/salesAccess");
const { provisionJourneyStyles } = require("../../../services/sampleStyleProvision");
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

    if (!bypassesApproval(req.user)) {
      style.materialsChangeLog = [
        ...(style.materialsChangeLog || []),
        { items, status: "pending", submittedBy: actor(req), submittedAt: new Date() },
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
    style.materials.status = items.length ? "selected" : "pending";
    style.materials.items = items;
    style.materials.selectedBy = actor(req);
    style.materials.selectedAt = new Date();
    style.updatedBy = actor(req);
    // Direct-apply path had no history entry at all until now — only the
    // staged (Merchandiser/IE) path below logged anything, so a Sales/admin
    // user setting materials directly left no trace (21 Aug 2026, explicit
    // request for "what information he changed", not just "materials set").
    logHistory(style, { kind: "materials_set", note: items.join(", ") || "cleared", from: prevItems.join(", "), to: items.join(", ") }, req);
    await style.save();
    return res.json({ success: true, sampleStyle: await withJourney(style) });
  } catch (err) {
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
      style.materials.status = entry.items.length ? "selected" : "pending";
      style.materials.items = entry.items;
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
    const backward = (STAGE_ORDER[stage] ?? 0) < (STAGE_ORDER[from] ?? 0);
    const reason = (req.body.reason || "").trim();
    if (backward && !reason) return res.status(400).json({ success: false, message: "A reason is required when sending a style back." });

    // A backward move invalidates the downstream work.
    if (backward) {
      if (stage === "materials" || stage === "brief") { resetTech(style); resetSample(style); }
      if (stage === "brief") { style.materials.status = "pending"; }
    }

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
    if (stage === "rnd" && from !== "rnd") {
      (async () => {
        const [customerName, image] = await Promise.all([customerNameFor(style), referenceImageFor(style)]);
        await notifyEvent("sample_sent_to_rnd", {
          heading: `Style sent to R&D: ${style.productName || style.styleCode || ""}`,
          bodyHtml: `<p><strong>${escapeHtml(actor(req).name || "Sales")}</strong> sent this style to R&D for tech-pack / development.</p>`,
          details: [
            ["Customer", customerName],
            ["Style", style.styleCode || style.sampleStyleId],
            ["Product", style.productName],
            ["Materials", (style.materials?.items || []).join(", ")],
          ],
          image,
          bodyText: `${actor(req).name || "Sales"} sent "${style.productName || "a style"}" (${customerName}) to R&D for tech-pack / development.`,
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
      if (style.materials.status !== "selected") return res.status(400).json({ success: false, message: "Materials must be selected before starting the tech sheet." });
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

      style.sample.consumptionRawItems = consumptionRawItems;
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
    } else if (action === "reject") {
      if (!(await canApprove(req.user))) return res.status(403).json({ success: false, message: "Only Sales can reject the sample." });
      if (!can("rejected")) return invalid("rejected");
      style.sample.status = "rejected";
      // Rejecting the style rejects the sample in front of them — the latest
      // round. Naming it turns two parallel lists into one readable ladder:
      // the revision now has a subject instead of only a timestamp.
      const latest = (style.sample.rounds || [])[style.sample.rounds.length - 1];
      const note = (req.body.note || "").trim();
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

    return res.json({ success: true, sampleStyle: await withJourney(style) });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/sample", err);
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
