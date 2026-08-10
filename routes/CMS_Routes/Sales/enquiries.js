// routes/CMS_Routes/Sales/enquiries.js
//
// Enquiry / RFQ — the FIRST real writer for a post-Account lifecycle stage.
//
// SCOPE (Chunk 1): get-or-create the one Enquiry that belongs to a Journey, and
// edit its header (dates, source, status, title, summary). Products, indicative
// pricing and qualification are additive fields landing in later chunks; this
// file grows with them.
//
// The enquiry is created LAZILY on first GET — the moment a salesperson opens
// the Enquiry stage of a journey, its ENQ reference is minted and the record is
// seeded from what we already know (the Account is the customer, its primary
// contact is the contact, the Journey owner is the salesperson, and the
// converting Lead — found via lead.conversion.journeyId — supplies the source).
// Nothing is invented; empty fields stay empty for the user to fill.

"use strict";

const mongoose = require("mongoose");
const Enquiry = require("../../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../../models/CMS_Models/Sales/Account");
const Contact = require("../../../models/CMS_Models/Sales/Contact");
const Lead = require("../../../models/CMS_Models/Sales/Lead");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { createWithRef } = require("../../../services/enquiryRef");
const { ENQUIRY_STATUS_CODES, ENQUIRY_STATUS_TRANSITIONS, ENQUIRY_SOURCE_CODES, ENQUIRY_LOST_REASON_CODES, ENQUIRY_PRIORITY_CODES, CUSTOMER_SERIOUSNESS_CODES, ENQUIRY_REFERENCE_TYPE_CODES } = require("../../../constants/crm");

const express = require("express");
const router = express.Router();

const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "" });
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

// Map a Lead's `source` (how a prospect was found) onto an Enquiry source (how
// this enquiry came in). Most conversions are "converted lead"; a few carry
// through cleanly.
function enquirySourceFromLead(lead) {
  if (!lead) return undefined;
  const s = lead.source;
  if (s === "referral") return "referral";
  if (s === "trade_show") return "exhibition";
  if (s === "website") return "website";
  if (s === "existing_customer") return "repeat_customer";
  return "existing_lead";
}

// Seed enquiry products from the lead's structured requirement. `requirementItems`
// is the [{ product, quantity }] captured at lead stage; `productInterest` is the
// flat name list — fall back to it when items weren't structured.
function productsFromLead(lead) {
  if (!lead) return [];
  const items = Array.isArray(lead.requirementItems) ? lead.requirementItems : [];
  if (items.length) {
    return items
      .filter((it) => it && String(it.product || "").trim())
      .map((it) => ({ product: String(it.product).trim(), quantity: it.quantity != null ? Number(it.quantity) : undefined }));
  }
  const names = Array.isArray(lead.productInterest) ? lead.productInterest : [];
  return names.filter((n) => String(n || "").trim()).map((n) => ({ product: String(n).trim() }));
}

// Free-text spec fields carried through verbatim (trimmed). Kept in one list so
// adding a spec field to the model means adding it here only.
const PRODUCT_TEXT_FIELDS = [
  "note", "colour", "fabricPreference", "fabricComposition", "gsm", "fit",
  "sizeRange", "brandingPlacement", "trims", "specialConstruction", "existingUniform",
];
const GARMENT_GENDER_CODES = ["male", "female", "unisex"];

// A client-supplied products array, cleaned to what the schema accepts: drop
// blank rows, coerce quantity to a non-negative number, validate the gender
// enum, and carry the garment-spec fields through trimmed.
function sanitizeProducts(input) {
  if (!Array.isArray(input)) return undefined;
  return input
    .filter((p) => p && String(p.product || "").trim())
    .map((p) => {
      const qty = p.quantity === "" || p.quantity == null ? undefined : Number(p.quantity);
      const out = {
        product: String(p.product).trim(),
        quantity: Number.isFinite(qty) && qty >= 0 ? qty : undefined,
        gender: GARMENT_GENDER_CODES.includes(p.gender) ? p.gender : undefined,
        logo: Boolean(p.logo),
        embroidery: Boolean(p.embroidery),
        printing: Boolean(p.printing),
      };
      for (const f of PRODUCT_TEXT_FIELDS) {
        const v = p[f];
        if (v != null && String(v).trim()) out[f] = String(v).trim();
      }
      // Reference images (Drive) — keep up to 8, dropping entries with neither a
      // fileId nor a URL. Trusted shape: { fileId, name, url }.
      if (Array.isArray(p.images)) {
        const imgs = p.images
          .filter((im) => im && (String(im.fileId || "").trim() || String(im.url || "").trim()))
          .slice(0, 8)
          .map((im) => ({
            fileId: String(im.fileId || "").trim() || undefined,
            name: String(im.name || "").trim() || undefined,
            url: String(im.url || "").trim() || undefined,
          }));
        if (imgs.length) out.images = imgs;
      }
      return out;
    });
}

// A client-supplied references array, cleaned: drop rows that are entirely
// empty (no label/url/note), validate the type enum (default "other"), trim.
function sanitizeReferences(input) {
  if (!Array.isArray(input)) return undefined;
  return input
    .filter((r) => r && (String(r.label || "").trim() || String(r.url || "").trim() || String(r.note || "").trim()))
    .map((r) => ({
      label: r.label ? String(r.label).trim() : undefined,
      type: ENQUIRY_REFERENCE_TYPE_CODES.includes(r.type) ? r.type : "other",
      url: r.url ? String(r.url).trim() : undefined,
      note: r.note ? String(r.note).trim() : undefined,
    }));
}

/**
 * Resolve the Journey by its human reference (SJ-YYYY-NNNN) or Mongo id, and
 * return the loaded document. Throws a 404-shaped error object if absent.
 */
async function loadJourney(journeyRef) {
  const query = isObjectId(journeyRef)
    ? { $or: [{ _id: journeyRef }, { journeyId: journeyRef }] }
    : { journeyId: journeyRef };
  const journey = await SalesJourney.findOne({ ...query, isActive: true });
  return journey;
}

/** Populate the display names a client needs, without duplicating them in the DB. */
async function decorate(enquiry) {
  const obj = enquiry.toObject ? enquiry.toObject() : enquiry;
  const [account, contact, journey] = await Promise.all([
    obj.accountId ? Account.findById(obj.accountId).select("accountId companyName displayName").lean() : null,
    obj.primaryContactId ? Contact.findById(obj.primaryContactId).select("firstName lastName jobTitle email mobile whatsapp").lean() : null,
    obj.journeyId ? SalesJourney.findById(obj.journeyId).select("journeyId name").lean() : null,
  ]);
  return {
    ...obj,
    customerName: account ? account.displayName || account.companyName : null,
    customerCode: account?.accountId || null,
    contact: contact
      ? { name: `${contact.firstName || ""} ${contact.lastName || ""}`.trim(), jobTitle: contact.jobTitle, email: contact.email, mobile: contact.mobile, whatsapp: contact.whatsapp }
      : null,
    journeyRef: journey?.journeyId || null,
    journeyName: journey?.name || null,
  };
}

// GET /api/cms/crm/enquiries/by-journey/:journeyRef
// Get-or-create the enquiry for a journey, seeded from account/contact/lead.
router.get("/by-journey/:journeyRef", salesAuth, async (req, res) => {
  try {
    const journey = await loadJourney(req.params.journeyRef);
    if (!journey) return res.status(404).json({ success: false, message: "Journey not found." });

    let enquiry = await Enquiry.findOne({ journeyId: journey._id, isActive: true });

    if (!enquiry) {
      // Seed from the source Lead (the one whose conversion points at this
      // journey), if any — it carries the source, the summary and the
      // product-wise requirement captured at lead stage.
      const lead = await Lead.findOne({ "conversion.journeyId": journey._id })
        .select("source company firstName lastName requirements requirementItems productInterest estimatedUnitPrice")
        .lean();
      const primaryContact = journey.primaryContactId
        ? journey.primaryContactId
        : (await Contact.findOne({ accountId: journey.accountId, isActive: true, isPrimary: true }).select("_id").lean())?._id
          || (await Contact.findOne({ accountId: journey.accountId, isActive: true }).select("_id").lean())?._id;

      enquiry = await createWithRef(Enquiry, {
        journeyId: journey._id,
        accountId: journey.accountId,
        primaryContactId: primaryContact || undefined,
        ownerId: journey.ownerId,
        ownerName: journey.ownerName,
        sourceLeadId: lead?._id || undefined,
        title: journey.name,
        source: enquirySourceFromLead(lead),
        summary: lead?.requirements || undefined,
        products: productsFromLead(lead),
        // Seed our indicative estimate from the lead's researched unit price —
        // a starting point the salesperson refines. The customer's target is
        // left blank for them to capture.
        estimatedPriceMin: lead?.estimatedUnitPrice || undefined,
        estimatedPriceMax: lead?.estimatedUnitPrice || undefined,
        // Smart start: an enquiry converted FROM a lead has already been
        // contacted and had its requirement gathered (that's what let the lead
        // convert), so it opens at "qualified" rather than re-walking the funnel.
        // A direct RFQ (no lead) starts at "new" and runs the full funnel.
        status: lead ? "qualified" : "new",
        createdBy: actor(req),
        updatedBy: actor(req),
      });
    }

    return res.json({ success: true, enquiry: await decorate(enquiry) });
  } catch (err) {
    console.error("[enquiries] GET /by-journey", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Fields a client may set on the header (Chunk 1). Everything else is derived
// or server-owned (enquiryId, accountId, ownerId, references).
const EDITABLE = [
  "title", "enquiryDate", "source", "expectedClosingDate", "requirementDeadline", "summary",
  "status", "lostReason", "lostReasonNote",
  // Pricing + qualification (Chunk 4)
  "pricingCurrency", "targetPrice", "estimatedPriceMin", "estimatedPriceMax", "pricingNote",
  "opportunitySize", "winProbability", "priority", "seriousness", "expectedOrderDate",
];

// PATCH /api/cms/crm/enquiries/:id — update header fields.
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne({ _id: req.params.id, isActive: true });
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const body = req.body || {};

    // Enforce the status machine: a status change must be a legal transition.
    // A no-op (same status, e.g. saving other fields) always passes.
    if (typeof body.status === "string" && ENQUIRY_STATUS_CODES.includes(body.status) && body.status !== enquiry.status) {
      const allowed = ENQUIRY_STATUS_TRANSITIONS[enquiry.status] || [];
      if (!allowed.includes(body.status)) {
        return res.status(400).json({ success: false, message: `Can't move an enquiry from "${enquiry.status}" to "${body.status}".` });
      }
    }

    for (const key of EDITABLE) {
      if (!(key in body)) continue;
      if (key === "source" && body.source && !ENQUIRY_SOURCE_CODES.includes(body.source)) continue;
      if (key === "status" && body.status && !ENQUIRY_STATUS_CODES.includes(body.status)) continue;
      if (key === "lostReason" && body.lostReason && !ENQUIRY_LOST_REASON_CODES.includes(body.lostReason)) continue;
      if (key === "priority" && body.priority && !ENQUIRY_PRIORITY_CODES.includes(body.priority)) continue;
      if (key === "seriousness" && body.seriousness && !CUSTOMER_SERIOUSNESS_CODES.includes(body.seriousness)) continue;
      enquiry[key] = body[key] === "" ? undefined : body[key];
    }
    // Products is an array — sanitize rather than trust the raw body.
    if ("products" in body) {
      enquiry.products = sanitizeProducts(body.products) || [];
    }
    // References likewise.
    if ("references" in body) {
      enquiry.references = sanitizeReferences(body.references) || [];
    }

    // Losing an enquiry needs a reason — that's the whole point of recording it.
    if (enquiry.status === "lost" && !enquiry.lostReason) {
      return res.status(400).json({ success: false, message: "A lost enquiry needs a reason." });
    }
    // Clear the lost reason if the enquiry is no longer lost.
    if (enquiry.status !== "lost") {
      enquiry.lostReason = undefined;
      enquiry.lostReasonNote = undefined;
    }

    enquiry.updatedBy = actor(req);
    await enquiry.save();

    // Stage-progressive deal value: the enquiry's opportunity size is the
    // INDICATIVE value at this stage, so mirror it onto the journey's
    // expectedValue with confirmed=false (the header/board reads one number,
    // labelled "estimated"). A firmer number from Cost & Quote later sets
    // confirmed=true and outranks this — so we never overwrite a confirmed value.
    if ("opportunitySize" in body) {
      const journey = await SalesJourney.findById(enquiry.journeyId).select("expectedValue");
      if (journey && !journey.expectedValue?.confirmed) {
        journey.expectedValue = {
          amount: enquiry.opportunitySize,
          currency: (enquiry.pricingCurrency || "INR").toUpperCase(),
          confirmed: false,
        };
        await journey.save();
      }
    }

    return res.json({ success: true, enquiry: await decorate(enquiry) });
  } catch (err) {
    console.error("[enquiries] PATCH /:id", err);
    return res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
