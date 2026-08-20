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
const salesAuthBase = require("../../../Middlewear/SalesAuthMiddlewear");

// R&D owns the tech sheet and the sample rounds, so R&D must be able to call
// these routes — and until now could not: every one of them was guarded by the
// CRM's role list, which has no R&D entry, so the whole app/research-development
// surface 403'd. Widened here only, not in the CRM guard itself.
const salesAuth = salesAuthBase.withRoles(salesAuthBase.RND_ROLES);
const { isSalesManager } = require("../../../services/salesAccess");
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
  images: Array.isArray(p.images) ? p.images.map((i) => ({ fileId: i.fileId, name: i.name, url: i.url })) : [],
});

const decorate = (styleDoc, journey, account) => {
  const o = styleDoc.toObject ? styleDoc.toObject() : styleDoc;
  return {
    ...o,
    journeyRef: journey?.journeyId || null,
    journeyName: journey?.name || null,
    customerName: account ? account.displayName || account.companyName : null,
    customerCode: account?.accountId || null,
  };
};

// Re-decorate a saved style with its journey + customer for the response.
async function withJourney(styleDoc) {
  const [j, acc] = await Promise.all([
    SalesJourney.findById(styleDoc.journeyId).select("journeyId name").lean(),
    styleDoc.accountId ? Account.findById(styleDoc.accountId).select("accountId companyName displayName").lean() : null,
  ]);
  return decorate(styleDoc, j, acc);
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

    const sampleStyles = docs.map((d) => ({
      ...d,
      journeyId: d.journeyId?._id || d.journeyId,
      journeyRef: d.journeyId?.journeyId || null,
      journeyName: d.journeyId?.name || null,
    }));
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

// PATCH /api/cms/crm/sample-styles/:id/materials  — Merchandiser input.
router.patch("/:id/materials", salesAuth, async (req, res) => {
  try {
    const style = await resolveStyle(req.params.id);
    if (!style) return res.status(404).json({ success: false, message: "Style not found." });

    const items = Array.isArray(req.body.items)
      ? req.body.items.map((x) => String(x).trim()).filter(Boolean)
      : [];
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
    return res.json({ success: true, sampleStyle: await withJourney(style) });
  } catch (err) {
    console.error("[sampleStyles] POST /:id/sample", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
