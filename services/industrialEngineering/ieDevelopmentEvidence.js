// services/industrialEngineering/ieDevelopmentEvidence.js
//
// WHAT THE GARMENT LOOKS LIKE, AND WHAT WAS WRITTEN DOWN ABOUT IT.
//
// ── WHY THIS IS A PROJECTION AND NOT A FEATURE ──────────────────────────────
// An engineer planning a method reads the garment before they read a word: the
// references Sales attached, the artwork, the sample R&D actually made, and the
// technical document the approved revision froze. Every one of those is ALREADY
// STORED on records Industrial Engineering is already permitted to read — this
// adds no model, no write route, no upload, no copy of a document and no new
// collection. It reads fields that exist and publishes a narrow allowlist of
// them on the two IE Development reads.
//
// ── THE ALLOWLIST IS THE CODE ───────────────────────────────────────────────
// Nothing is spread. Each shape below is built field by field, and three things
// are deliberately NOT among them:
//
//   `storageRef`, `fileId`, `publicId`   the media store's own handles. A raw
//                                        storage path is not evidence, it is an
//                                        address into somebody else's bucket.
//   the discussion attachments           `sample.discussion[].attachment` is a
//                                        CONVERSATION between Sales and R&D. It
//                                        can carry anything, including a
//                                        commercial reply, and a conversation is
//                                        not technical evidence.
//   anything from a BOM row              supplier, rate, price and the rest.
//                                        Merchandising's revision rows are not
//                                        read here at all.
//
// No price, margin, quotation, supplier, customer contact or credential can
// leave through this file, because no field carrying one is named in it.
//
// ── AND AN ABSENCE IS AN ANSWER ─────────────────────────────────────────────
// Merchandising's development file stores NO image and NO document — it holds a
// release reference and a BOM revision number and nothing else. So there is no
// "Merchandising selection" picture to publish, and this module says so with a
// named, empty source rather than by quietly having one fewer group. A screen
// can then tell "Merchandising attached nothing" from "Merchandising has no
// field for it", which are different facts about different owners.
"use strict";

const mongoose = require("mongoose");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));

const model = (name, path) => (mongoose.models[name] || require(path));
const StockItem = () => model("StockItem", "../../models/CMS_Models/Inventory/Products/StockItem");
const SalesDevelopmentRequest = () => (mongoose.models.SalesDevelopmentRequest
  || require("../../models/CMS_Models/Sales/DevelopmentRequest").SalesDevelopmentRequest);

/* ── HOW MUCH EVIDENCE MAY LEAVE ───────────────────────────────────────────
   A style with forty sample rounds has hundreds of images, and a response that
   grew with the record would be a page nobody can load. The caps are published
   with the payload, so a screen says "showing 24 of 61" rather than presenting
   a truncation as the whole. */
const IMAGE_CAP = 24;
const DOCUMENT_CAP = 24;

/** Where a piece of evidence came from. The desk, not the collection. */
const SOURCE = Object.freeze({
  SALES: "SALES",
  MERCHANDISING: "MERCHANDISING",
  RND: "RESEARCH_DEVELOPMENT",
  PRODUCT: "PRODUCT_MASTER",
});

/** What a piece of evidence IS. Never inferred from a filename — see below. */
const IMAGE_KIND = Object.freeze({
  PRODUCT_REFERENCE: "PRODUCT_REFERENCE",
  ARTWORK: "ARTWORK",
  TRIM_REFERENCE: "TRIM_REFERENCE",
  PACKAGING_REFERENCE: "PACKAGING_REFERENCE",
  OTHER_REFERENCE: "OTHER_REFERENCE",
  SAMPLE_PHOTO: "SAMPLE_PHOTO",
  SAMPLE_ROUND: "SAMPLE_ROUND",
  PRODUCT_IMAGE: "PRODUCT_IMAGE",
});

const DOCUMENT_KIND = Object.freeze({
  TECH_PACK: "TECH_PACK",
  TECHNICAL_REVISION: "TECHNICAL_REVISION",
});

/**
 * The Sales reference types, as Sales stores them, mapped to this vocabulary.
 *
 * A type Sales adds later that nobody has mapped falls to `OTHER_REFERENCE`
 * rather than to `PRODUCT_REFERENCE` — an unmapped thing is not a product shot,
 * and calling it one is the guess this whole module exists to avoid.
 */
const REFERENCE_KIND = Object.freeze({
  PRODUCT: IMAGE_KIND.PRODUCT_REFERENCE,
  ARTWORK: IMAGE_KIND.ARTWORK,
  TRIM: IMAGE_KIND.TRIM_REFERENCE,
  PACKAGING: IMAGE_KIND.PACKAGING_REFERENCE,
  OTHER: IMAGE_KIND.OTHER_REFERENCE,
});

/**
 * A URL a browser may actually open.
 *
 * Only absolute http(s). A bare storage key, a `file://`, a relative path or a
 * `javascript:` is not a link — it is something that would either do nothing or
 * do something unexpected, and offering it as "Open" teaches people the button
 * lies. Anything rejected here still appears as EVIDENCE; it simply carries no
 * address, and the screen draws no action for it.
 */
function safeUrl(value) {
  const raw = str(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The file's TYPE, from its own extension.
 *
 * Read off the stored name or the URL's path, which is a fact about the file
 * rather than a claim about its contents. Deliberately NOT used to decide the
 * evidence's KIND: "measurements.pdf" is a PDF, and whether it is a measurement
 * chart is something only the record that stored it can say. Inferring a tech
 * pack from a filename is exactly the guess a person would then act on.
 */
function fileType(name, url) {
  const from = str(name) || str(url).split("?")[0];
  const match = /\.([a-z0-9]{1,6})$/i.exec(from);
  return match ? match[1].toUpperCase() : "";
}

/* ══ IMAGES ═══════════════════════════════════════════════════════════════ */

const image = ({ key, url, caption, kind, source, at = null, note = "" }) => {
  const href = safeUrl(url);
  return {
    key,
    /* `null` rather than the unusable string. A screen that renders an <img>
       from an absent url draws a broken frame; one that is told there is no
       address draws the fallback it has. */
    url: href,
    caption: str(caption),
    kind,
    source,
    at: at ? new Date(at).toISOString() : null,
    note: str(note),
  };
};

/**
 * Every image this style can prove, in the order an engineer wants them.
 *
 * Sales' references first (what was asked for), then the artwork, then R&D's
 * sample photographs and rounds (what was actually made), then the product
 * master's own pictures last — those are the least specific, because a product
 * image is about the product and not about this style's development.
 */
function imagesFor({ style, request, product }) {
  const out = [];
  const push = (spec) => { if (out.length < IMAGE_CAP) out.push(image(spec)); };

  /* ── SALES ─────────────────────────────────────────────────────────────── */
  (request?.referenceImages || []).forEach((ref, i) => push({
    key: `req-${i}`,
    url: ref.url,
    caption: ref.caption,
    kind: REFERENCE_KIND[str(ref.referenceType)] || IMAGE_KIND.OTHER_REFERENCE,
    source: SOURCE.SALES,
  }));

  (style?.brief?.images || []).forEach((img, i) => push({
    key: `brief-${i}`,
    url: img.url,
    caption: img.name,
    kind: IMAGE_KIND.PRODUCT_REFERENCE,
    source: SOURCE.SALES,
  }));

  const artwork = style?.brief?.brandingRequirements?.artwork;
  if (artwork?.url) {
    push({
      key: "artwork",
      url: artwork.url,
      caption: artwork.name,
      kind: IMAGE_KIND.ARTWORK,
      source: SOURCE.SALES,
      /* The state Sales recorded for it — "supplied", "awaited". Published as
         the note it is, not folded into the caption. */
      note: str(style.brief.brandingRequirements.artworkState),
    });
  }

  /* ── R&D ───────────────────────────────────────────────────────────────── */
  (style?.sample?.photos || []).forEach((img, i) => push({
    key: `sample-${i}`,
    url: img.url,
    caption: img.name,
    kind: IMAGE_KIND.SAMPLE_PHOTO,
    source: SOURCE.RND,
  }));

  /* ── AND A ROUND'S PICTURES CARRY THEIR ROUND ──────────────────────────
     Round 2 was rejected and round 3 approved, and merging them into one
     unlabelled strip is how somebody plans a method from the garment that was
     sent back. The round number, its type and its verdict travel with each
     image as the note. */
  (style?.sample?.rounds || []).forEach((round, r) => {
    const label = [
      round.roundNo ? `Round ${round.roundNo}` : "",
      str(round.type),
      str(round.outcome),
    ].filter(Boolean).join(" · ");
    (round.images || []).forEach((img, i) => push({
      key: `round-${r}-${i}`,
      url: img.url,
      caption: img.name,
      kind: IMAGE_KIND.SAMPLE_ROUND,
      source: SOURCE.RND,
      at: round.madeAt || null,
      note: label,
    }));
  });

  /* ── THE PRODUCT MASTER ────────────────────────────────────────────────── */
  (product?.images || []).forEach((url, i) => push({
    key: `product-${i}`,
    url,
    caption: "",
    kind: IMAGE_KIND.PRODUCT_IMAGE,
    source: SOURCE.PRODUCT,
  }));

  return out;
}

/* ══ DOCUMENTS ════════════════════════════════════════════════════════════ */

const document = ({ key, name, url, kind, source, revision = null, at = null, note = "" }) => {
  const href = safeUrl(url);
  return {
    key,
    name: str(name) || "Untitled document",
    url: href,
    /* Said rather than implied by a null url, because a screen deciding whether
       to draw an action should read one field and not infer from another. */
    openable: Boolean(href),
    fileType: fileType(name, url),
    kind,
    source,
    revision,
    at: at ? new Date(at).toISOString() : null,
    note: str(note),
  };
};

/**
 * The technical documents this style can prove.
 *
 * Both come from R&D's own record. The current tech sheet is the working
 * document; each frozen revision carries the file that was submitted WITH it,
 * which is the pair that proves anything at all — a revision number with no
 * document, or a document with no revision, proves nothing on its own.
 */
function documentsFor({ style }) {
  const out = [];
  const push = (spec) => { if (out.length < DOCUMENT_CAP) out.push(document(spec)); };

  const sheet = style?.techSheet?.file;
  if (sheet?.url || sheet?.name) {
    push({
      key: "techsheet",
      name: sheet.name,
      url: sheet.url,
      kind: DOCUMENT_KIND.TECH_PACK,
      source: SOURCE.RND,
      at: sheet.uploadedAt || null,
      note: "The working technical document on the style",
    });
  }

  /* Newest revision first: the one in force is the one an engineer opens. */
  const revisions = [...(style?.techSheet?.technicalRevisions || [])]
    .sort((a, b) => Number(b.revision ?? 0) - Number(a.revision ?? 0));
  revisions.forEach((rev, i) => {
    if (!rev?.file?.url && !rev?.file?.name) return;
    push({
      key: `rev-${rev.revision ?? i}`,
      name: rev.file.name,
      url: rev.file.url,
      kind: DOCUMENT_KIND.TECHNICAL_REVISION,
      source: SOURCE.RND,
      revision: Number.isFinite(Number(rev.revision)) ? Number(rev.revision) : null,
      at: rev.file.uploadedAt || rev.submittedAt || null,
      /* The verdict the revision carries. A returned revision's document is
         still evidence, and reading it as the approved one is the mistake this
         note exists to prevent. */
      note: str(rev.outcome),
    });
  });

  return out;
}

/* ══ WHAT NOBODY STORES ═══════════════════════════════════════════════════
 *
 * Published as part of the answer, so a screen states the gap and names its
 * OWNER rather than leaving a blank where a document would be. Each entry is a
 * fact about a schema, checked against the models on 30 Sep 2026.
 */
const UNAVAILABLE = Object.freeze([
  {
    kind: "MERCHANDISING_EVIDENCE",
    owner: SOURCE.MERCHANDISING,
    message: "Merchandising's development file stores no image and no document — it carries a release "
      + "reference and a BOM revision number. There is no material or trim picture to show from it.",
  },
  {
    kind: "MEASUREMENT_CHART",
    owner: SOURCE.RND,
    message: "No measurement or specification file is stored separately. Measurements live inside the "
      + "technical document, and nothing records one as its own attachment.",
  },
  {
    kind: "CONSTRUCTION_DRAWING",
    owner: SOURCE.RND,
    message: "No construction drawing is stored as its own record. A construction sketch reaches IE "
      + "inside the technical document or as a sample photograph.",
  },
]);

/* ══ THE ONE READ ═════════════════════════════════════════════════════════ */

/**
 * Every piece of evidence one development style can prove.
 *
 * Two extra queries at most, both bounded to this one style: the product the
 * style names, and the Sales request the Merchandising file names. Neither is
 * issued when the reference is absent.
 *
 * @param {object} input.style    the lean SampleStyle, already company-proved
 *   by the caller. This module proves nothing and must never be handed a style
 *   whose company has not been established.
 * @param {object|null} input.development  the Merchandising development file,
 *   for its `currentRequestId` and nothing else.
 */
async function evidenceFor({ style, development = null } = {}) {
  const productId = style?.sourceStockItemId || style?.production?.stockItemId || null;
  const requestId = development?.currentRequestId || null;

  const [product, request] = await Promise.all([
    isId(productId)
      ? StockItem().findById(oid(productId)).select("images").lean()
      : null,
    isId(requestId)
      ? SalesDevelopmentRequest().findById(oid(requestId)).select("referenceImages").lean()
      : null,
  ]);

  const images = imagesFor({ style, request, product });
  const documents = documentsFor({ style });

  return {
    images,
    documents,
    /* The bounds, published. A screen showing 24 of 61 says so. */
    imageCap: IMAGE_CAP,
    documentCap: DOCUMENT_CAP,
    imagesCapped: images.length >= IMAGE_CAP,
    documentsCapped: documents.length >= DOCUMENT_CAP,
    /* And what no record stores, with the desk that would have to store it. */
    unavailable: UNAVAILABLE.map((u) => ({ ...u })),
  };
}

/**
 * ONE image for a register row, or none.
 *
 * Taken from the style's OWN document, which the list has already read — a
 * thumbnail may not cost a query per row, and a register that issued one would
 * be slower for a picture than for everything else on the page put together.
 * Sales' brief image first, then the artwork; a style with neither gets `null`
 * and the row draws its placeholder.
 */
function thumbnailFor(style) {
  const first = (style?.brief?.images || []).find((img) => safeUrl(img?.url));
  if (first) {
    return {
      url: safeUrl(first.url),
      caption: str(first.name),
      kind: IMAGE_KIND.PRODUCT_REFERENCE,
      source: SOURCE.SALES,
    };
  }
  const artwork = style?.brief?.brandingRequirements?.artwork;
  if (safeUrl(artwork?.url)) {
    return {
      url: safeUrl(artwork.url),
      caption: str(artwork.name),
      kind: IMAGE_KIND.ARTWORK,
      source: SOURCE.SALES,
    };
  }
  return null;
}

/** The fields the list and the detail must select for the two functions above. */
const EVIDENCE_LIST_PROJECTION = [
  "brief.images", "brief.brandingRequirements.artwork",
].join(" ");

const EVIDENCE_DETAIL_PROJECTION = [
  "brief.images",
  "brief.brandingRequirements.artwork", "brief.brandingRequirements.artworkState",
  "sample.photos", "sample.rounds",
  "techSheet.file",
  "techSheet.technicalRevisions.file",
  "sourceStockItemId", "production.stockItemId",
].join(" ");

module.exports = {
  SOURCE, IMAGE_KIND, DOCUMENT_KIND, REFERENCE_KIND, UNAVAILABLE,
  IMAGE_CAP, DOCUMENT_CAP,
  EVIDENCE_LIST_PROJECTION, EVIDENCE_DETAIL_PROJECTION,
  safeUrl, fileType, imagesFor, documentsFor, thumbnailFor, evidenceFor,
};
