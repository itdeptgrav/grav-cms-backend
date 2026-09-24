// services/sales/enquiryProductReadiness.service.js
//
// IS THIS ENQUIRY READY TO BECOME DEVELOPMENT WORK? — THE ONLY ANSWER.
//
// "Start Development" hands a journey to Style & Sample, where a Merchandiser
// sources fabric and R&D builds a tech sheet and a physical sample. Neither can
// work a garment nobody can picture, and neither can embroider a logo whose
// placement nobody wrote down or whose artwork nobody attached.
//
// ── WHY THIS LIVES ON THE SERVER ──────────────────────────────────────────
// The browser computes the same verdict to grey out a button and to say what
// is missing. That is a courtesy, not a control: the PATCH that moves an
// enquiry to `development_started` is an ordinary HTTP request, and anything
// that can reach the API can send it — an old build with the previous rules, a
// second tab holding a stale copy, a script, a retry from an offline queue.
// So the route evaluates the ENQUIRY AS SAVED, after this request's own
// product changes have been applied, and refuses on the facts in the document
// rather than on a claim in the payload.
//
// ── ONE LIST OF RULES ─────────────────────────────────────────────────────
// Every backend caller reads this module. A second copy of "what counts as
// ready" — in a route, in a service, in a job — is how the gate starts
// disagreeing with the message that explains it, and a person is told to fix
// something that is already fixed. The frontend's copy
// (grav-cms/lib/sales/productBrief.js) deliberately uses THESE codes and THESE
// messages so the preview and the refusal read identically.
"use strict";

const { brandingRequirementsOf } = require("../../models/CMS_Models/Sales/enquiryBrandingRequirement");

/** Why a product cannot move. Codes are the contract; messages are wording. */
const READINESS_BLOCKER = Object.freeze({
  NO_PRODUCT_IMAGE: "no_product_image",
  TYPE: "requirement_type",
  PLACEMENT: "requirement_placement",
  ARTWORK_STATE: "requirement_artwork_state",
  ARTWORK_MISSING: "requirement_artwork_missing",
  AWAITING_ARTWORK: "requirement_awaiting_artwork",
});

const TYPE_LABEL = {
  embroidery: "Embroidery", screen_print: "Screen print", digital_print: "Digital print",
  heat_transfer: "Heat transfer", logo_badge: "Logo / badge", woven_patch: "Woven patch", other: "Other",
};

const str = (v) => String(v ?? "").trim();
const usableImage = (im) => Boolean(im && (str(im.publicId) || str(im.fileId) || str(im.url)));

/** What is missing on one branding requirement. */
function requirementBlockers(requirement, index = 0) {
  const r = requirement || {};
  const type = str(r.type);
  const label = type ? (TYPE_LABEL[type] || "Other") : `Requirement ${index + 1}`;
  const artwork = (Array.isArray(r.artwork) ? r.artwork : []).filter(usableImage);
  const ref = str(r.ref) || null;
  const out = [];

  if (!type) {
    out.push({ code: READINESS_BLOCKER.TYPE, ref, label, message: "Choose what kind of branding this is." });
  }
  if (!str(r.placement)) {
    out.push({ code: READINESS_BLOCKER.PLACEMENT, ref, label, message: "Say where it goes — e.g. left chest, back yoke." });
  }

  const state = str(r.artworkState);
  if (!state) {
    out.push({ code: READINESS_BLOCKER.ARTWORK_STATE, ref, label, message: "Say whether the customer's artwork is in hand." });
  } else if (state === "provided" && artwork.length === 0) {
    out.push({
      code: READINESS_BLOCKER.ARTWORK_MISSING, ref, label,
      message: "Marked as provided, but no artwork is attached. Attach it, or change the state.",
    });
  } else if (state === "awaiting_customer") {
    /* Not a defect — an open action on the customer. It still blocks, because
       a style that reaches R&D with "artwork to follow" is a style that waits
       at the embroidery machine. */
    out.push({
      code: READINESS_BLOCKER.AWAITING_ARTWORK, ref, label, pending: true,
      message: "Waiting on the customer to send the artwork.",
    });
  }
  return out;
}

/**
 * Everything holding one product back.
 *
 * `brandingRequirementsOf` is what makes an old record answerable: a row whose
 * branding is still the logo/embroidery/printing booleans is judged on the
 * same projection every screen shows, not skipped for having no structured
 * rows.
 */
function productReadiness(product) {
  const p = product || {};
  const images = (Array.isArray(p.images) ? p.images : []).filter(usableImage);
  const requirements = brandingRequirementsOf(p);
  const blockers = [];

  if (images.length === 0) {
    blockers.push({
      code: READINESS_BLOCKER.NO_PRODUCT_IMAGE, ref: null,
      label: "Reference image", message: "Add at least one picture of the garment.",
    });
  }
  requirements.forEach((r, i) => blockers.push(...requirementBlockers(r, i)));

  return {
    productLineRef: str(p.productLineRef) || null,
    product: str(p.product),
    blockers,
    /* Split because they read differently: one is our own work left undone,
       the other is the customer's. Both stop the hand-off. */
    missing: blockers.filter((b) => !b.pending),
    pending: blockers.filter((b) => b.pending),
    ready: blockers.length === 0,
  };
}

/** The verdict for a whole enquiry's saved product list. */
function evaluateEnquiryReadiness(products) {
  const rows = (Array.isArray(products) ? products : []).map(productReadiness);
  return {
    products: rows,
    blocked: rows.filter((r) => !r.ready),
    empty: rows.length === 0,
    ready: rows.length > 0 && rows.every((r) => r.ready),
  };
}

/**
 * The refusal body, shaped so a screen can mark the product and the
 * requirement rather than print one sentence at the top of the page.
 *
 * `products[].blockers[].ref` is the branding requirement's permanent
 * reference, so the client can highlight the exact row even after a reorder.
 */
function readinessRefusal(verdict) {
  if (verdict.empty) {
    return {
      code: "ENQUIRY_NOT_READY",
      message: "Add at least one product before starting development.",
      products: [],
    };
  }
  const n = verdict.blocked.length;
  return {
    code: "ENQUIRY_NOT_READY",
    message: `${n} product${n === 1 ? "" : "s"} still ${n === 1 ? "needs" : "need"} information before development can start.`,
    products: verdict.blocked.map((p) => ({
      productLineRef: p.productLineRef,
      product: p.product,
      blockers: p.blockers.map((b) => ({
        code: b.code, ref: b.ref, label: b.label, message: b.message, pending: Boolean(b.pending),
      })),
    })),
  };
}

module.exports = {
  READINESS_BLOCKER,
  requirementBlockers,
  productReadiness,
  evaluateEnquiryReadiness,
  readinessRefusal,
};
