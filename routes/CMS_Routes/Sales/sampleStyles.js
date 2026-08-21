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

    const { styles, created, renamed, backfilled } = await provisionJourneyStyles({
      SampleStyle, journey, enquiry, briefFromProduct, actor: actor(req),
    });

    return res.json({
      success: true,
      created, renamed, backfilled,
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

    style.materials.status = items.length ? "selected" : "pending";
    style.materials.items = items;
    style.materials.selectedBy = actor(req);
    style.materials.selectedAt = new Date();
    style.updatedBy = actor(req);
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
      style.materials.status = entry.items.length ? "selected" : "pending";
      style.materials.items = entry.items;
      style.materials.selectedBy = actor(req);
      style.materials.selectedAt = new Date();
      logHistory(style, { kind: "materials_set", note: "" }, req);
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
      const roundNo = (style.sample.rounds?.length || 0) + 1;
      style.sample.rounds.push({ roundNo, type, note: req.body.note || "", madeAt: new Date() });
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
    } else if (action === "reject") {
      if (!(await canApprove(req.user))) return res.status(403).json({ success: false, message: "Only Sales can reject the sample." });
      if (!can("rejected")) return invalid("rejected");
      style.sample.status = "rejected";
      style.sample.revisions.push({ note: (req.body.note || "").trim(), at: new Date(), by: actor(req) });
    } else {
      return res.status(400).json({ success: false, message: "Unknown sample action." });
    }

    const smKind = { round: "sample_round", submit: "sample_submitted", approve: "sample_approved", reject: "sample_rejected" }[action];
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

// POST /api/cms/crm/sample-styles/:id/sample/discussion — R&D ↔ Sales
// conversation about this sample, plus "attach more info" (a message can
// carry a file with no text, text with no file, or both). Both sides already
// reach this router with valid auth (Sales via the base CRM guard, R&D via
// this file's RND_ROLES widening), so no new auth surface is needed
// (20 Aug 2026, explicit request).
router.post("/:id/sample/discussion", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });

    const text = String(req.body?.text || "").trim();
    const a = req.body?.attachment;
    const attachment = a && (a.url || a.fileId) ? { name: a.name, url: a.url, fileId: a.fileId, publicId: a.publicId } : undefined;
    if (!text && !attachment) {
      return res.status(400).json({ success: false, message: "Write something or attach a file first." });
    }

    style.sample = style.sample || {};
    if (!Array.isArray(style.sample.discussion)) style.sample.discussion = [];
    style.sample.discussion.push({ text, attachment, by: actor(req), at: new Date() });
    style.updatedBy = actor(req);
    await style.save();
    return res.json({ success: true, sampleStyle: await withJourney(style) });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/sample/discussion", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTION (bulk / size-wise order) — deliberately separate from `sample`
// above; see the model's own comment on `production`. R&D drives the real
// commercial pipeline from here: Customer → Stock Item (+BOM) → Customer
// Request → (auto-approved, internal — no PI) → Work Orders. Every step is
// logged onto style.production.log so the chain reads back afterwards, not
// just the end state (19 Aug 2026, explicit request).
//
// This is a SECOND FRONT DOOR onto the exact same pipeline Sales' own "New
// Order on Behalf" flow (SizeWiseBulkOrderSlider → salesCustomers.js →
// createWorkOrdersAndProgress) already drives — not a parallel one. The
// Customer-create, assign-items and create-request logic below is a direct
// copy of salesCustomers.js's own handlers, not a reinterpretation of them;
// it has to live here rather than call that router because its auth
// (Middlewear/SalesAuthMiddlewear's base ALLOWED_ROLES) has no R&D entry, the
// same reason this file's own salesAuth is RND_ROLES-widened above.
// ─────────────────────────────────────────────────────────────────────────────

const pushProdLog = (style, kind, note, req) => {
  if (!style.production) style.production = {};
  if (!Array.isArray(style.production.log)) style.production.log = [];
  style.production.log.push({ kind, note, at: new Date(), by: actor(req) });
};

const generateTempPassword = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#";
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A SampleStyle's reference image is `{fileId, publicId, name, url}` (see
// imageSchema) — Drive-backed (`fileId`) or, for older records, Cloudinary
// (`url`/`publicId`). `StockItem.images` is just `[String]`, so this resolves
// to the one directly-renderable URL string, mirroring the frontend's own
// `imageThumbUrl()` (lib/driveImage.js) since that helper is client-only.
function resolveStyleImageUrl(img) {
  if (!img) return null;
  if (img.fileId) return `https://lh3.googleusercontent.com/d/${img.fileId}=w600`;
  return img.url || null;
}

// The REAL customer this style's order belongs to — never a per-order pick,
// but also never R&D's own placeholder (19 Aug 2026, explicit correction: an
// R&D-wide fixed account was wrong; orders must be placed under the style's
// actual customer). Resolved from style.accountId (set at provisioning time
// from the journey, see sampleStyleProvision.js) → CRMAccount →
// account.linkedCustomer, the portal Customer already linked to that account.
// Returns {account, customer} — customer is null when the account has no
// linked portal Customer yet, so the caller can offer a create form prefilled
// from the ACCOUNT's own contact details rather than a blank search.
async function resolveStyleCustomer(style) {
  if (!style.accountId) return { account: null, customer: null };
  const account = await Account.findById(style.accountId).select("accountId companyName displayName primaryEmail primaryPhone linkedCustomer");
  if (!account) return { account: null, customer: null };
  if (account.linkedCustomer) {
    const customer = await Customer.findById(account.linkedCustomer).select("_id");
    if (customer) return { account, customer };
  }
  return { account, customer: null };
}

// GET /api/cms/crm/sample-styles/:id/production
router.get("/:id/production", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });

    const { account, customer: resolvedCustomer } = await resolveStyleCustomer(style);
    if (resolvedCustomer && String(style.production?.customerId || "") !== String(resolvedCustomer._id)) {
      style.production = style.production || {};
      style.production.customerId = resolvedCustomer._id;
      if (!style.production.status || style.production.status === "not_started") style.production.status = "customer_linked";
      pushProdLog(style, "customer_linked", `Linked to this style's customer.`, req);
    }
    if (style.isModified()) { style.updatedBy = actor(req); await style.save(); }

    const p = style.production || {};
    const [customer, stockItem, request, workOrders] = await Promise.all([
      p.customerId ? Customer.findById(p.customerId).select("name email phone customerId").lean() : null,
      p.stockItemId ? StockItem.findById(p.stockItemId).select("name reference variants").lean() : null,
      p.customerRequestId ? CustomerRequest.findById(p.customerRequestId).select("requestId status").lean() : null,
      // Live status pulled from the Production side — this is what "in
      // progress" / "completed" actually reflects, not something tracked
      // separately here (19 Aug 2026, explicit request: R&D needs to see the
      // real work-order status, not just "work orders were created").
      p.workOrderIds?.length
        ? WorkOrder.find({ _id: { $in: p.workOrderIds } }).select("workOrderNumber status quantity completedQuantity variantAttributes").lean()
        : [],
    ]);

    return res.json({
      success: true,
      production: {
        status: p.status || "not_started",
        log: p.log || [],
        // No linked portal Customer for this style's account yet — the
        // wizard should offer to create one, prefilled from the account.
        accountPrefill: !p.customerId && account ? { name: account.displayName || account.companyName || "", email: account.primaryEmail || "", phone: account.primaryPhone || "" } : null,
        customer: customer ? { id: String(customer._id), name: customer.name, email: customer.email, phone: customer.phone, customerId: customer.customerId } : null,
        stockItem: stockItem ? {
          id: String(stockItem._id), name: stockItem.name, reference: stockItem.reference,
          variants: (stockItem.variants || []).map((v) => ({ id: String(v._id), sku: v.sku, attributes: v.attributes || [], rawItems: v.rawItems || [] })),
        } : null,
        customerRequest: request ? { id: String(request._id), requestId: request.requestId, status: request.status } : null,
        workOrderIds: (p.workOrderIds || []).map(String),
        workOrders: workOrders.map((w) => ({
          id: String(w._id), workOrderNumber: w.workOrderNumber || null, status: w.status,
          quantity: w.quantity || 0, completedQuantity: w.completedQuantity || 0,
          attributes: w.variantAttributes || [],
        })),
      },
    });
  } catch (err) {
    console.error("[sampleStyles] GET /:id/production", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/sample-styles/:id/production/reset — the "start over"
// button: clears the registered stock item and any raised request/work
// orders from this STYLE's production tracking, so R&D can register the
// product and quantities again from scratch (19 Aug 2026, explicit request).
// The resolved customer stays attached — it's this style's real customer,
// re-derived from the CRM account, not something the reset should undo.
// Deliberately does NOT touch the actual StockItem, CustomerRequest or
// WorkOrder documents already created — this only clears what THIS style
// points at; anything already sent to production stays live there and is
// untouched.
router.post("/:id/production/reset", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });

    const hadWorkOrders = (style.production?.workOrderIds || []).length > 0;
    const customerId = style.production?.customerId || null;
    style.production = {
      status: customerId ? "customer_linked" : "not_started",
      customerId,
      stockItemId: null,
      customerRequestId: null,
      workOrderIds: [],
      log: style.production?.log || [],
    };
    pushProdLog(
      style, "reset",
      hadWorkOrders
        ? "Production reset by R&D — the product, quantities and raised request were cleared here. Work orders already created remain untouched in Production."
        : "Production reset by R&D — the registered product and quantities were cleared so the process can start over.",
      req,
    );
    style.updatedBy = actor(req);
    await style.save();

    return res.json({ success: true, production: { status: style.production.status, log: style.production.log } });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/production/reset", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/sample-styles/:id/production/customers/search?q=
router.get("/:id/production/customers/search", salesAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, customers: [] });
    const rx = new RegExp(escapeRegExp(q), "i");
    const customers = await Customer.find({ $or: [{ name: rx }, { email: rx }, { phone: rx }] })
      .select("name email phone customerId").limit(10).lean();
    return res.json({ success: true, customers: customers.map((c) => ({ id: String(c._id), name: c.name, email: c.email, phone: c.phone, customerId: c.customerId })) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/sample-styles/:id/production/customer
// { customerId } to link an existing one, or { create: { name, email, phone } }
// to raise a brand new portal Customer on the spot when none exists yet.
router.post("/:id/production/customer", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });

    let customer;
    if (req.body?.customerId) {
      customer = await Customer.findById(req.body.customerId);
      if (!customer) return res.status(404).json({ success: false, message: "Customer not found." });
      pushProdLog(style, "customer_linked", `Linked to existing customer: ${customer.name}`, req);
    } else if (req.body?.create) {
      const name = String(req.body.create.name || "").trim();
      const email = String(req.body.create.email || "").trim().toLowerCase();
      const phone = String(req.body.create.phone || "").trim();
      if (!name || !email || !phone) {
        return res.status(400).json({ success: false, message: "Name, email and phone are required." });
      }
      if (await Customer.findOne({ email }).select("_id").lean()) {
        return res.status(409).json({ success: false, message: "A customer with this email address already exists." });
      }
      if (await Customer.findOne({ phone }).select("_id").lean()) {
        return res.status(409).json({ success: false, message: "A customer with this phone number already exists." });
      }
      const tempPassword = generateTempPassword();
      customer = await Customer.create({
        name, email, phone, password: tempPassword,
        isActive: true, isEmailVerified: true,
        createdBySales: true, salesAssignedBy: req.user?.id, salesAssignedByName: req.user?.name || "R&D",
      });
      sendCustomerEmail("welcome", customer.email, {
        name: customer.name, customerId: customer.customerId, email: customer.email, password: tempPassword,
        salesRepName: req.user?.name, portalUrl: process.env.CUSTOMER_PORTAL_URL || "https://portal.gravclothing.com",
      }).catch(() => {});
      pushProdLog(style, "customer_created", `Customer account created: ${customer.name} (${customer.email})`, req);
    } else {
      return res.status(400).json({ success: false, message: "Pass either customerId or create." });
    }

    style.production = style.production || {};
    style.production.customerId = customer._id;
    if (!style.production.status || style.production.status === "not_started") style.production.status = "customer_linked";
    style.updatedBy = actor(req);
    await style.save();

    // Link back onto the CRM account so every OTHER style raised for the same
    // customer auto-resolves too, instead of asking again each time.
    if (style.accountId) {
      await Account.findByIdAndUpdate(style.accountId, { linkedCustomer: customer._id }).catch(() => {});
    }

    return res.json({ success: true, customer: { id: String(customer._id), name: customer.name, email: customer.email, phone: customer.phone } });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/production/customer", err);
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue || {})[0] || "field";
      return res.status(409).json({ success: false, message: `A customer with this ${field} already exists.` });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/sample-styles/:id/production/stock-items/search?q=
router.get("/:id/production/stock-items/search", salesAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, stockItems: [] });
    const rx = new RegExp(escapeRegExp(q), "i");
    const items = await StockItem.find({ name: rx }).select("name reference variants").limit(10).lean();
    return res.json({
      success: true,
      stockItems: items.map((s) => ({ id: String(s._id), name: s.name, reference: s.reference, variantCount: (s.variants || []).length })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Unit-name → its convertible units, WITH the reverse direction too — the
// exact logic routes/CMS_Routes/Inventory/Products/stockItems.js's own
// buildUnitConversionsMap uses (duplicated locally, same convention as the
// rest of this file). A raw item registered in "Packet" but consumed in
// "Pc" needs this to offer that swap (20 Aug 2026, explicit request — "refer
// that stock item form completely in order to know how that work").
async function buildUnitConversionsMap() {
  try {
    const units = await Unit.find({ status: "Active" }).populate("conversions.toUnit", "name");
    const map = {};
    units.forEach((u) => {
      if (!map[u.name]) map[u.name] = { baseUnit: u.name, conversions: [] };
      (u.conversions || []).forEach((c) => {
        const toUnitName = c.toUnit?.name || c.toUnit;
        if (!toUnitName) return;
        map[u.name].conversions.push({ toUnit: toUnitName, factor: c.quantity });
      });
    });
    units.forEach((u) => {
      (u.conversions || []).forEach((c) => {
        const toUnitName = c.toUnit?.name || c.toUnit;
        if (!toUnitName || !c.quantity) return;
        if (!map[toUnitName]) map[toUnitName] = { baseUnit: toUnitName, conversions: [] };
        const alreadyHas = map[toUnitName].conversions.some((x) => x.toUnit === u.name);
        if (!alreadyHas) map[toUnitName].conversions.push({ toUnit: u.name, factor: 1 / c.quantity });
      });
    });
    return map;
  } catch (err) {
    console.error("[sampleStyles] buildUnitConversionsMap", err);
    return {};
  }
}

// GET /api/cms/crm/sample-styles/:id/production/raw-items/search?q=
// The item master search (Store's RawItem collection) — for both auto-matching
// Style & Sample's already-picked materials and R&D adding more by hand.
router.get("/:id/production/raw-items/search", salesAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, rawItems: [] });
    const rx = new RegExp(escapeRegExp(q), "i");
    const [items, unitConversionsMap] = await Promise.all([
      RawItem.find({ name: rx }).select("name sku unit customUnit category quantity variants").limit(10).lean(),
      buildUnitConversionsMap(),
    ]);
    return res.json({
      success: true,
      rawItems: items.map((r) => {
        const baseUnit = r.customUnit || r.unit || "Unit";
        return {
          id: String(r._id), name: r.name, sku: r.sku, unit: baseUnit, category: r.category,
          quantity: r.quantity || 0,
          // Which other units this can be recorded in, and the factor to
          // convert — e.g. registered in "Packet", consumed in "Pc"
          // (20 Aug 2026, explicit request).
          unitConversions: unitConversionsMap[baseUnit]?.conversions || [],
          // A raw item with variants (e.g. a fabric's colourways) needs the
          // specific variant picked, same as the real Stock Item form's BOM
          // picker — not just the item itself (19 Aug 2026, explicit correction).
          // `quantity`/`price` here are for R&D to see availability/cost while
          // picking — same info the real form's picker shows.
          variants: (r.variants || []).map((v) => ({
            id: String(v._id), combination: v.combination || [], sku: v.sku,
            quantity: v.quantity || 0,
            price: v.vendorNicknames?.[0]?.price || null,
            // Variant-level conversions, same {fromUnit,toUnit,quantity}
            // shape the RawItem schema already stores them in.
            unitConversions: (v.unitConversions || []).filter((c) => c.fromUnit && c.toUnit && c.quantity),
          })),
        };
      }),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// {name, values:[...]}[] → one variant per combination — the same cartesian
// expansion the real Stock Item form does client-side (attributes.js in
// grav-clothing), done here instead since this route builds variants itself.
function cartesianAttributes(attributes) {
  return attributes
    .reduce((acc, attr) => acc.flatMap((combo) => attr.values.map((val) => [...combo, { name: attr.name, value: val }])), [[]])
    .map((attrs) => ({ attributes: attrs }));
}

// Minimal raw-item resolution for a variant's BOM — same required/allowance-%
// math routes/CMS_Routes/Inventory/Products/stockItems.js's own
// processVariantRawItems uses. Costing is deliberately left at 0 here: R&D's
// form hides pricing entirely (19 Aug 2026, explicit request — only name,
// variant, qty and allowance are asked for), so there is nothing to derive a
// unit cost from; Store/Sales still price the stock item separately.
// `r.variantId`, when present, is one of the raw item's OWN variants (e.g. a
// fabric colourway) — resolved here so the BOM row records exactly which one,
// same as the real Stock Item form's raw-item picker.
async function resolveProductionRawItems(rawItemsInput) {
  const valid = (Array.isArray(rawItemsInput) ? rawItemsInput : []).filter((r) => r.rawItemId && Number(r.requiredQuantity) > 0);
  if (!valid.length) return [];
  const ids = [...new Set(valid.map((r) => String(r.rawItemId)))].filter(isObjectId);
  const docs = await RawItem.find({ _id: { $in: ids } }).select("name sku unit customUnit variants").lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const out = [];
  for (const r of valid) {
    const doc = byId.get(String(r.rawItemId));
    if (!doc) continue;
    const variant = r.variantId ? (doc.variants || []).find((v) => String(v._id) === String(r.variantId)) : null;
    const requiredQuantity = Number(r.requiredQuantity);
    const allowancePercent = Number(r.allowancePercent) || 0;
    const quantity = Math.round(requiredQuantity * (1 + allowancePercent / 100) * 10000) / 10000;
    const registeredUnit = doc.customUnit || doc.unit || "Unit";
    // `r.unit` is whatever unit R&D picked for this row (e.g. the item is
    // registered in "Packet" but the BOM needs "Pc") — respect it rather
    // than silently forcing the item's own registered unit onto the BOM
    // (20 Aug 2026, explicit bug fix). `baseUnit` stays the true registered
    // unit regardless, same as the real Stock Item form, for stock deduction.
    const chosenUnit = String(r.unit || "").trim() || registeredUnit;
    out.push({
      rawItemId: doc._id, rawItemName: doc.name, rawItemSku: variant?.sku || doc.sku,
      variantId: variant?._id || doc._id, variantCombination: variant?.combination || [],
      requiredQuantity, allowancePercent, quantity,
      unit: chosenUnit, baseUnit: registeredUnit,
      unitCost: 0, totalCost: 0,
    });
  }
  return out;
}

// POST /api/cms/crm/sample-styles/:id/production/stock-item
// { stockItemId } to link an already-registered Stock Item, or
// { create: { category, attributes, cost, salesPrice, rawItems } } to
// register this style's product as a NEW Stock Item right here — category,
// attributes (→ variants, cartesian-expanded), and the BOM, all filled inline
// rather than sending R&D to the separate form (19 Aug 2026, revised: an
// earlier pass linked out to that form; explicit follow-up asked for this to
// happen in place instead, with raw items auto-filled from what Style &
// Sample already picked, plus manual additions).
router.post("/:id/production/stock-item", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });

    let stockItem;
    if (req.body?.stockItemId) {
      stockItem = await StockItem.findById(req.body.stockItemId).select("name reference variants");
      if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found." });
      pushProdLog(style, "stock_item_linked", `Linked to existing stock item: ${stockItem.name}`, req);
    } else if (req.body?.create) {
      const { category, attributes, cost, salesPrice, rawItems } = req.body.create;
      // Prefilled from the style but editable — R&D may want to adjust it
      // (e.g. append a colourway) before registering (19 Aug 2026).
      const name = String(req.body.create.name || style.productName || "").trim();
      if (!name) return res.status(400).json({ success: false, message: "Product name is required." });
      if (!category || !String(category).trim()) return res.status(400).json({ success: false, message: "Category is required." });

      const cleanAttributes = (Array.isArray(attributes) ? attributes : [])
        .filter((a) => a.name?.trim() && Array.isArray(a.values) && a.values.filter((v) => v?.trim()).length)
        .map((a) => ({ name: a.name.trim(), values: a.values.filter((v) => v?.trim()).map((v) => v.trim()) }));
      if (!cleanAttributes.length) return res.status(400).json({ success: false, message: "At least one attribute (with values) is required." });

      const nameCode = name.split(" ").map((w) => w.slice(0, 3).toUpperCase()).join("");
      const categoryCode = String(category).trim().slice(0, 3).toUpperCase();
      const randomNum = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
      const reference = `PROD-${categoryCode}-${nameCode}-${randomNum}`.toUpperCase();
      const barcodeBase = "89" + String(Math.floor(Math.random() * 10000000000)).padStart(10, "0");

      const resolvedRawItems = await resolveProductionRawItems(rawItems);
      const baseCost = Number(cost) || 0;
      const baseSalesPrice = Number(salesPrice) || 0;

      // The style's own reference picture — auto-carried onto both the stock
      // item and every one of its variants, since nothing else fills this in
      // for a product registered from here and downstream views (e.g. the
      // work order) show a variant's photo, not the style's (19 Aug 2026,
      // bug fix: this was hardcoded to `images: []`, so nothing ever showed).
      const referenceImageUrl = resolveStyleImageUrl(style.brief?.images?.[0]);

      const variantCombos = cartesianAttributes(cleanAttributes);
      const variants = variantCombos.map((v, i) => ({
        sku: `${reference}-V${String(i + 1).padStart(3, "0")}`,
        attributes: v.attributes,
        quantityOnHand: 0, minStock: 10, maxStock: 100,
        cost: baseCost, salesPrice: baseSalesPrice,
        barcode: `${barcodeBase}-${String(i + 1).padStart(3, "0")}`,
        images: referenceImageUrl ? [referenceImageUrl] : [], rawItems: resolvedRawItems,
      }));

      stockItem = new StockItem({
        name, reference, productType: "Goods", category: String(category).trim(),
        unit: "Units", baseSalesPrice, baseCost,
        images: referenceImageUrl ? [referenceImageUrl] : [],
        attributes: cleanAttributes, variants, createdBy: req.user?.id,
      });
      await stockItem.save();
      pushProdLog(
        style, "stock_item_created",
        `Product registered as a stock item: ${stockItem.name} (${variants.length} variant${variants.length === 1 ? "" : "s"}, ${resolvedRawItems.length} raw item${resolvedRawItems.length === 1 ? "" : "s"}).`,
        req,
      );
    } else {
      return res.status(400).json({ success: false, message: "Pass either stockItemId or create." });
    }

    style.production = style.production || {};
    style.production.stockItemId = stockItem._id;

    if (style.production.customerId) {
      const customer = await Customer.findById(style.production.customerId);
      if (customer) {
        const already = (customer.assignedStockItems || []).some((a) => String(a.stockItemId) === String(stockItem._id));
        if (!already) {
          customer.assignedStockItems.push({
            stockItemId: stockItem._id, stockItemName: stockItem.name, stockItemReference: stockItem.reference,
            assignedAt: new Date(), assignedBy: req.user?.id, assignedByName: req.user?.name || "R&D",
          });
          await customer.save();
        }
        pushProdLog(style, "product_assigned", `Product assigned to ${customer.name}.`, req);
      }
    }

    style.production.status = "stock_item_linked";
    style.updatedBy = actor(req);
    await style.save();

    return res.json({
      success: true,
      stockItem: {
        id: String(stockItem._id), name: stockItem.name, reference: stockItem.reference,
        variants: (stockItem.variants || []).map((v) => ({ id: String(v._id), sku: v.sku, attributes: v.attributes || [], rawItems: v.rawItems || [] })),
      },
    });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/production/stock-item", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/sample-styles/:id/production/submit — "Sent to Production".
// Requires a linked customer + stock item already on style.production.
// Creates a CustomerRequest, immediately marks it an internal order (no PI,
// auto-approved — same shortcut Sales' own "mark as internal order" uses),
// and runs the SAME createWorkOrdersAndProgress() Sales' pipeline uses.
router.post("/:id/production/submit", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });

    const p = style.production || {};
    if (!p.customerId) return res.status(400).json({ success: false, message: "Link this style's customer first." });
    if (!p.stockItemId) return res.status(400).json({ success: false, message: "Register the product first." });

    const [customer, stockItem] = await Promise.all([
      Customer.findById(p.customerId).select("name email phone profile customerId").lean(),
      StockItem.findById(p.stockItemId).select("name reference baseSalesPrice variants").lean(),
    ]);
    if (!customer) return res.status(404).json({ success: false, message: "Linked customer no longer exists." });
    if (!stockItem) return res.status(404).json({ success: false, message: "Linked stock item no longer exists." });

    const rawVariants = Array.isArray(req.body?.variants) ? req.body.variants : [];
    const validatedVariants = [];
    for (const v of rawVariants) {
      const qty = Number(v.quantity) || 0;
      if (qty <= 0) continue;
      const matched = (stockItem.variants || []).find((sv) => String(sv._id) === String(v.variantId));
      const unitPrice = matched?.salesPrice || stockItem.baseSalesPrice || 0;
      validatedVariants.push({
        variantId: v.variantId || null,
        attributes: matched?.attributes || v.attributes || [],
        quantity: qty,
        specialInstructions: [],
        estimatedPrice: unitPrice * qty,
      });
    }
    if (!validatedVariants.length) {
      return res.status(400).json({ success: false, message: "Set a quantity greater than zero for at least one variant." });
    }

    const totalQuantity = validatedVariants.reduce((s, v) => s + v.quantity, 0);
    const count = await CustomerRequest.countDocuments();
    const requestId = `REQ-${new Date().getFullYear()}-${String(count + 1).padStart(4, "0")}`;

    const request = new CustomerRequest({
      requestId,
      customerId: customer._id,
      requestType: "customer_request",
      customerInfo: {
        name: customer.name, email: customer.email, phone: customer.phone,
        address: customer.profile?.address?.street || "",
        city: customer.profile?.address?.city || "",
        postalCode: customer.profile?.address?.pincode || "",
        description: `Bulk order raised from R&D — style ${style.styleCode || style.sampleStyleId} (${style.productName}).`,
        deliveryDeadline: req.body?.deliveryDeadline ? new Date(req.body.deliveryDeadline) : null,
        preferredContactMethod: "phone",
      },
      items: [{
        stockItemId: stockItem._id,
        stockItemName: stockItem.name,
        stockItemReference: stockItem.reference,
        variants: validatedVariants,
        totalQuantity,
        totalEstimatedPrice: validatedVariants.reduce((s, v) => s + v.estimatedPrice, 0),
      }],
      status: "pending",
      priority: req.body?.priority || "medium",
      createdBySales: true,
      createdBySalesId: req.user?.id,
    });
    await request.save();
    pushProdLog(style, "request_created", `Order request raised: ${requestId} (${totalQuantity} pcs).`, req);

    request.isInternalOrder = true;
    request.internalOrderMarkedAt = new Date();
    request.quotations = [{
      date: new Date(),
      validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      items: [], subtotalBeforeGST: 0, totalDiscount: 0, totalGST: 0, shippingCharges: 0, grandTotal: 0,
      status: "sales_approved",
      notes: "Internal / Company Order — raised from R&D, no PI or payment required.",
      customerApproval: { approved: true, approvedAt: new Date() },
      salesApproval: { approved: true, approvedAt: new Date(), approvedBy: req.user?.id },
    }];
    request.status = "quotation_sales_approved";
    request.finalOrderPrice = 0;
    pushProdLog(style, "sales_approved", "Approved as an internal order — no PI required.", req);

    const { createdWorkOrders, skippedVariants } = await createWorkOrdersAndProgress(request, req.user?.id);
    request.notes = request.notes || [];
    request.notes.push({
      text: `Marked as Internal Order from R&D. ${createdWorkOrders.length} work order(s) created directly for production.`,
      addedBy: req.user?.id, addedByModel: "SalesDepartment", createdAt: new Date(),
    });
    await request.save();

    style.production.customerRequestId = request._id;
    style.production.workOrderIds = createdWorkOrders.map((w) => w._id);
    style.production.status = "submitted";
    pushProdLog(
      style,
      "work_orders_created",
      `${createdWorkOrders.length} work order${createdWorkOrders.length === 1 ? "" : "s"} sent to production${
        createdWorkOrders.length ? ` (${createdWorkOrders.map((w) => w.workOrderNumber || w._id).join(", ")})` : ""
      }.${skippedVariants?.length ? ` ${skippedVariants.length} variant(s) skipped.` : ""}`,
      req,
    );
    style.updatedBy = actor(req);
    await style.save();

    return res.json({
      success: true,
      requestId,
      customerRequestId: String(request._id),
      workOrders: createdWorkOrders.map((w) => ({ id: String(w._id), workOrderNumber: w.workOrderNumber || null, quantity: w.quantity })),
      skippedVariants: skippedVariants?.length ? skippedVariants : undefined,
      log: style.production.log,
    });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/production/submit", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
