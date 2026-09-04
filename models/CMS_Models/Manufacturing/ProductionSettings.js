// models/CMS_Models/Manufacturing/ProductionSettings.js
//
// THE PROJECT MANAGER'S OWN SETTINGS — one document, like SalesSettings.
//
// Explicit request, 31 Aug 2026: the PM is to be notified whenever a
// Manufacturing Order is created, and "keep an setting page in order to keep
// the mail template ok..so that he can also change ok.., enable, disable and
// all ok".
//
// ── WHY A SECOND SETTINGS COLLECTION AND NOT A BLOCK ON SalesSettings ────
// Every department template today lives on `SalesSettings.samplingTemplates`,
// which is right for those: they are messages SALES sends, worded in Sales'
// voice, edited on Sales' settings page. This one is the opposite — it is the
// Project Manager's own inbound notification, edited by the Project Manager on
// the Project Manager's settings page. Parking it under Sales would mean the
// PM cannot change their own email without being given write access to Sales'
// settings, which is a permissions decision nobody asked for.
//
// The two stores are read through the same seam — see `templateStore` on the
// event registry in services/departmentNotify.service.js — so the sending code
// stays one path regardless of which department owns the copy.
"use strict";

const mongoose = require("mongoose");

// Same shape as SalesSettings' `samplingTemplateField`, so an editor written
// for one works unchanged on the other.
const templateField = (defaults) => ({
  enabled:   { type: Boolean, default: defaults.enabled !== false },
  subject:   { type: String, trim: true, default: defaults.subject },
  heading:   { type: String, trim: true, default: defaults.heading },
  bodyText:  { type: String, trim: true, default: defaults.bodyText },
  ctaLabel:  { type: String, trim: true, default: defaults.ctaLabel },
});

// ── Defaults, exported for the same three reasons SalesSettings exports its
// own: schema defaults, the sender's fallback (schema defaults only
// materialise on CREATE, so an existing singleton carries none), and the
// settings page's "Reset to defaults".
//
// Formal wording, matching the house style of the sampling templates.
// Placeholders, all supplied by services/manufacturingOrderNotify.service.js:
//   {moNumber} {orderType} {customer} {totalQty} {workOrderCount}
//   {products} {priority} {deliveryDeadline} {raisedBy}
// ── FOUR AUDIENCES, FOUR LETTERS ──────────────────────────────────────────
//
// Explicit request, 31 Aug 2026: "make sure ki whatever actions are goona
// happened upon considering an order, so make sure to notify to the sales team,
// merchantiser, project manager, r&d and all ok, everyone's make sure to notify
// ok.. and the format should be different ok as per there department wise
// responsibility ok".
//
// Each department is told what IT is accountable for, not the same letter four
// times. A merchandiser reading a work-order schedule and a project manager
// reading a material list are both reading somebody else's job — and a
// notification that mostly does not concern you is one you stop opening.
//
//   projectManager — the production plan. Quantities, work orders, deadlines.
//   researchDevelopment — "the style you developed is now being made", with the
//     sample reference. This one matters most on a SAMPLING order, where R&D
//     asked for the run in the first place and otherwise never hears it started.
//   merchandiser — the material picture: what the run consumes, what to procure.
//   sales — confirmation into production, and what can now be told to the
//     customer (deadline, quantities).
//
// Placeholders available to EVERY template (supplied by
// services/manufacturingOrderNotify.service.js):
//   {moNumber} {requestId} {orderType} {orderShape} {customer} {totalQty}
//   {workOrderCount} {productCount} {products} {priority} {deliveryDeadline}
//   {peopleCount} {sampleRef} {sampleProduct}
const PRODUCTION_TEMPLATE_DEFAULTS = {
  manufacturingOrder: {
    enabled: true,
    subject: "New Manufacturing Order {moNumber} — {orderType} ({customer})",
    heading: "Manufacturing Order {moNumber} raised",
    bodyText:
      "Dear Project Manager,\n\n" +
      "A new Manufacturing Order has been released to production. The particulars are set out below, " +
      "and a detailed order summary is attached to this message for your records.\n\n" +
      "Order type: {orderType}\n" +
      "Order shape: {orderShape}\n" +
      "Customer: {customer}\n" +
      "Total quantity: {totalQty}\n" +
      "Work orders raised: {workOrderCount}\n" +
      "Products: {products}\n\n" +
      "Kindly review the attached summary and plan the production schedule accordingly. " +
      "Please revert if any specification or quantity requires clarification before work commences.\n\n" +
      "Regards,\nGRAV Manufacturing Suite",
    ctaLabel: "Open Manufacturing Order",
  },

  researchDevelopment: {
    enabled: true,
    subject: "Production started — {sampleProduct} ({moNumber})",
    heading: "Your sample has gone into production",
    bodyText:
      "Dear R&D Team,\n\n" +
      "The style you developed has now been released to production. This is a confirmation that the work you " +
      "requested has commenced; no action is required from you unless a specification appears incorrect.\n\n" +
      "Sample reference: {sampleRef}\n" +
      "Product: {sampleProduct}\n" +
      "Manufacturing Order: {moNumber}\n" +
      "Order type: {orderType}\n" +
      "Order shape: {orderShape}\n" +
      "Total quantity: {totalQty}\n" +
      "Delivery deadline: {deliveryDeadline}\n\n" +
      "The full specification, quantities and work-order breakdown are attached. If anything differs from the " +
      "approved sample, kindly raise it with the Project Manager before production advances.\n\n" +
      "Regards,\nGRAV Manufacturing Suite",
    ctaLabel: "View the order",
  },

  merchandiser: {
    enabled: true,
    subject: "Material requirement — {moNumber} ({totalQty})",
    heading: "Materials required for {moNumber}",
    bodyText:
      "Dear Merchandising Team,\n\n" +
      "A Manufacturing Order has been released to production and the material requirement against it is now " +
      "confirmed. The consolidated consumption is attached for your reference.\n\n" +
      "Manufacturing Order: {moNumber}\n" +
      "Customer: {customer}\n" +
      "Order type: {orderType}\n" +
      "Total quantity: {totalQty}\n" +
      "Products: {products}\n" +
      "Delivery deadline: {deliveryDeadline}\n\n" +
      "Kindly verify stock availability against the attached requirement and initiate procurement for any " +
      "shortfall so that production is not held up.\n\n" +
      "Regards,\nGRAV Manufacturing Suite",
    ctaLabel: "View the order",
  },

  sales: {
    enabled: true,
    subject: "Order confirmed into production — {moNumber} ({customer})",
    heading: "{customer}'s order is now in production",
    bodyText:
      "Dear Sales Team,\n\n" +
      "The following order has been released to production. You may confirm to the customer that manufacturing " +
      "has commenced.\n\n" +
      "Manufacturing Order: {moNumber}\n" +
      "Customer: {customer}\n" +
      "Order type: {orderType}\n" +
      "Total quantity: {totalQty}\n" +
      "Products: {products}\n" +
      "Delivery deadline: {deliveryDeadline}\n\n" +
      "A summary of what is being made is attached, should the customer ask for confirmation in writing. " +
      "Any change to quantity or specification from this point must go through the Project Manager.\n\n" +
      "Regards,\nGRAV Manufacturing Suite",
    ctaLabel: "Open the order",
  },
};

/** The four templates, in the order the settings page shows them, with the
 *  audience each one addresses. Exported so the page and the routes agree on
 *  the list without either hardcoding a second copy. */
const PRODUCTION_TEMPLATE_META = [
  { key: "manufacturingOrder", event: "manufacturing_order_created", label: "Project Manager", audience: "projectManager",
    blurb: "The production plan — quantities, work orders and deadlines." },
  { key: "researchDevelopment", event: "mo_rnd_notice", label: "R&D", audience: "rnd",
    blurb: "Confirmation that a developed style has entered production. Most useful on sampling orders." },
  { key: "merchandiser", event: "mo_merchandiser_notice", label: "Merchandiser", audience: "merchandiser",
    blurb: "The material requirement for the run, so procurement can cover any shortfall." },
  { key: "sales", event: "mo_sales_notice", label: "Sales", audience: "sales",
    blurb: "Confirmation the customer's order is being made, and what may be told to them." },
];

const productionSettingsSchema = new mongoose.Schema(
  {
    // One document. The unique index makes a second impossible at the database
    // level rather than by convention — same pattern as StoreSettings.
    key: { type: String, default: "production", unique: true, immutable: true },

    /**
     * All four order notifications, owned by the Project Manager.
     *
     * Explicit request: "each and every mail format need to keep in that
     * project manager setting so that he can change and all". So even the
     * letters addressed to Sales, R&D and Merchandising are edited HERE —
     * production owns the wording of what production announces.
     */
    templates: {
      manufacturingOrder:  templateField(PRODUCTION_TEMPLATE_DEFAULTS.manufacturingOrder),
      researchDevelopment: templateField(PRODUCTION_TEMPLATE_DEFAULTS.researchDevelopment),
      merchandiser:        templateField(PRODUCTION_TEMPLATE_DEFAULTS.merchandiser),
      sales:               templateField(PRODUCTION_TEMPLATE_DEFAULTS.sales),
    },

    /**
     * Event-level opt-out, mirroring SalesSettings.departmentNotifications.
     * Independent of the per-template `enabled` switch above: this turns the
     * whole event off, that one turns off just this wording.
     */
    disabledEvents: { type: [String], default: [] },

    /**
     * Attach the order-summary PDF. Separate from the template's own on/off
     * because "I want the email but not a PDF on every one of them" is a real
     * preference, and folding it into `enabled` would make it unexpressible.
     */
    attachOrderPdf: { type: Boolean, default: true },

    updatedByName: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

/** The document, created with defaults on first read. */
productionSettingsSchema.statics.get = async function () {
  const existing = await this.findOne({ key: "production" });
  if (existing) return existing;
  try {
    return await this.create({ key: "production" });
  } catch (err) {
    if (err?.code === 11000) return this.findOne({ key: "production" });
    throw err;
  }
};

const ProductionSettings =
  mongoose.models.ProductionSettings || mongoose.model("ProductionSettings", productionSettingsSchema);

module.exports = ProductionSettings;
module.exports.PRODUCTION_TEMPLATE_DEFAULTS = PRODUCTION_TEMPLATE_DEFAULTS;
module.exports.PRODUCTION_TEMPLATE_META = PRODUCTION_TEMPLATE_META;
