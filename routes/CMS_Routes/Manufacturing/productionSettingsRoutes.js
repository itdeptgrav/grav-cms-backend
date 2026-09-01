// routes/CMS_Routes/Manufacturing/productionSettingsRoutes.js
//
// The Project Manager's own settings — currently the "new Manufacturing Order"
// notification: its wording, its on/off switch, and whether the order PDF
// rides along.
//
// Explicit request, 31 Aug 2026: "keep an setting page in order to keep the
// mail template ok..so that he can also change ok.., enable, disable and all".
//
// GET is open to any authenticated CMS session — the Project Manager's
// settings page reads it, and the values are not sensitive. PUT is restricted
// to the roles who actually own production planning.
"use strict";

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { readToken } = require("../../../config/jwt");

const ProductionSettings = require("../../../models/CMS_Models/Manufacturing/ProductionSettings");
const { PRODUCTION_TEMPLATE_DEFAULTS, PRODUCTION_TEMPLATE_META } = ProductionSettings;

/** Inline role gate, matching the pattern routes/CEO_Routes/overview.js uses —
 *  this repo does not centralise the department check, so each route file that
 *  needs one declares it the same way. */
function pmAuth(req, res, next) {
  try {
    const token = readToken(req);
    if (!token) return res.status(401).json({ success: false, message: "Auth required" });
    const d = jwt.verify(token, process.env.JWT_SECRET || "grav_clothing_secret_key");
    if (!["project_manager", "ceo", "admin"].includes(d.role)) {
      return res.status(403).json({ success: false, message: "Project Manager access required" });
    }
    req.pmUser = d;
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired session" });
  }
}

/** Shape one template for the wire, healing every blank from the defaults —
 *  a settings document created before a field existed still reads complete. */
function templateOut(saved, fallback) {
  return {
    enabled:  saved?.enabled ?? fallback.enabled,
    subject:  saved?.subject  || fallback.subject,
    heading:  saved?.heading  || fallback.heading,
    bodyText: saved?.bodyText || fallback.bodyText,
    ctaLabel: saved?.ctaLabel || fallback.ctaLabel,
  };
}

const shape = (doc) => ({
  // Every template, healed field-by-field from the defaults — a settings
  // document saved before a template existed still reads complete.
  templates: Object.fromEntries(
    PRODUCTION_TEMPLATE_META.map((m) => [
      m.key,
      templateOut(doc?.templates?.[m.key], PRODUCTION_TEMPLATE_DEFAULTS[m.key]),
    ]),
  ),
  disabledEvents: doc?.disabledEvents || [],
  attachOrderPdf: doc?.attachOrderPdf !== false,
  updatedByName: doc?.updatedByName || "",
  updatedAt: doc?.updatedAt || null,
});

/** GET / — current settings, plus the factory defaults so the page can offer
 *  "reset to default" without hardcoding a second copy of the wording. */
router.get("/", async (req, res) => {
  try {
    const doc = await ProductionSettings.get();
    res.json({ success: true, settings: shape(doc), defaults: PRODUCTION_TEMPLATE_DEFAULTS, templateMeta: PRODUCTION_TEMPLATE_META });
  } catch (err) {
    console.error("[productionSettings] get failed:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/** PUT / — save. Field-by-field rather than a blind `$set` of the body, so a
 *  page that posts a partial object cannot blank the rest of the document. */
router.put("/", pmAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const doc = await ProductionSettings.get();

    // Every template the caller sent, merged field-by-field over what is
    // stored. A page that posts only the one it edited leaves the rest alone.
    let touched = false;
    for (const m of PRODUCTION_TEMPLATE_META) {
      const tpl = b.templates?.[m.key];
      if (!tpl || typeof tpl !== "object") continue;
      doc.templates = doc.templates || {};
      const cur = doc.templates[m.key] || {};
      doc.templates[m.key] = {
        enabled:  tpl.enabled  !== undefined ? Boolean(tpl.enabled) : cur.enabled,
        subject:  tpl.subject  !== undefined ? String(tpl.subject).trim()  : cur.subject,
        heading:  tpl.heading  !== undefined ? String(tpl.heading).trim()  : cur.heading,
        bodyText: tpl.bodyText !== undefined ? String(tpl.bodyText).trim() : cur.bodyText,
        ctaLabel: tpl.ctaLabel !== undefined ? String(tpl.ctaLabel).trim() : cur.ctaLabel,
      };
      touched = true;
    }
    if (touched) doc.markModified("templates");

    if (b.attachOrderPdf !== undefined) doc.attachOrderPdf = Boolean(b.attachOrderPdf);
    if (Array.isArray(b.disabledEvents)) doc.disabledEvents = b.disabledEvents.map(String);

    doc.updatedByName = req.pmUser?.name || req.pmUser?.email || "";
    await doc.save();

    res.json({ success: true, settings: shape(doc), defaults: PRODUCTION_TEMPLATE_DEFAULTS });
  } catch (err) {
    console.error("[productionSettings] update failed:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PREVIEW — see exactly what a template produces, WITHOUT sending it.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────
// These templates address four departments, and the only way to check a
// wording change used to be to release a real order and read the four inboxes
// it reached. That is a bad feedback loop for editing copy, and a worse one
// for testing: emails are live in this environment, so a trial send goes to
// real colleagues about a real order (it happened — 31 Aug 2026).
//
// So the preview renders through the SAME path a real send uses — the stored
// template, the same placeholder substitution, the same PDF builder and the
// same audience cut — and stops one step short of Brevo. What you see here is
// what would arrive.
//
// `?orderId=` previews against a specific order; omitted, it picks the most
// recent one so the preview is populated with something real rather than
// lorem. `?format=pdf` returns the attachment itself.
router.get("/preview/:templateKey", pmAuth, async (req, res) => {
  try {
    const meta = PRODUCTION_TEMPLATE_META.find((m) => m.key === req.params.templateKey);
    if (!meta) return res.status(404).json({ success: false, message: "No such template." });

    const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
    const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

    const order = req.query.orderId
      ? await CustomerRequest.findById(req.query.orderId).lean()
      : await CustomerRequest.findOne({ status: "quotation_sales_approved" }).sort({ createdAt: -1 }).lean();
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "No manufacturing order exists yet to preview against. Release one first.",
      });
    }
    const workOrders = await WorkOrder.find({ customerRequestId: order._id }).lean();

    // The PDF cut this audience would actually receive.
    if (req.query.format === "pdf") {
      const { buildManufacturingOrderPdf } = require("../../../services/manufacturingOrderPdf");
      const pdf = await buildManufacturingOrderPdf(order, workOrders, { audience: meta.audience });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="preview-${meta.key}.pdf"`);
      return res.send(pdf);
    }

    // The email, rendered exactly as the sender would — stored template,
    // interpolated against this order's real values.
    const { renderEventPreview } = require("../../../services/departmentNotify.service");
    const { buildVars } = require("../../../services/manufacturingOrderNotify.service");
    const preview = await renderEventPreview(meta.event, { vars: buildVars(order, workOrders) });

    return res.json({
      success: true,
      templateKey: meta.key,
      audience: meta.label,
      previewedAgainst: { orderId: String(order._id), moNumber: `MO-${order.requestId}`, customer: order.customerInfo?.name || "—" },
      ...preview,
    });
  } catch (err) {
    console.error("[productionSettings] preview failed:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
