// models/CMS_Models/Sales/enquiryBrandingRequirement.js
//
// BRANDING, EMBROIDERY AND PRINT ON AN ENQUIRY PRODUCT LINE — the vocabulary,
// the identity, and the sanitiser.
//
// ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
// A product line said `logo` / `embroidery` / `printing` (three booleans) and
// `brandingPlacement` (one string). Two ordinary requirements — a left-chest
// embroidered logo and a back print — collapsed into "embroidery: true,
// printing: true, placement: 'left chest, back'", and the customer's artwork
// had nowhere to live at all. Merchandising and R&D then worked from a
// checkbox, and the artwork arrived by email or not at all.
//
// The old fields are NOT removed. They are still stored, still read by the
// tech-sheet email, the costing workbook and two PDF generators, and are now
// kept in step with the structured list (see `legacyMirror`).
//
// ── IDENTITY, AND WHY IT IS MINTED HERE ────────────────────────────────────
// `sanitizeProducts` in routes/CMS_Routes/Sales/enquiries.js rebuilds every
// product row from the request body on every save, so a subdocument `_id` is
// new each time — the same defect `enquiryProductLineIdentity.js` exists to
// solve one level up. A requirement's artwork, its placement and its size have
// to survive a quantity edit on another row, so each requirement carries a
// server-minted `ref` and is matched by that alone: never by position, never by
// placement text, and never by type (one product legitimately carries two
// embroideries, on the chest and on the sleeve).
//
// A client may NAME a reference it was given. It can never invent one, and it
// can never name one belonging to a different product line — see
// `reconcileBrandingRequirements`, which is what keeps one product's artwork
// off another product.
"use strict";

const crypto = require("crypto");

/** What kind of decoration this is. The codes are the contract with the UI. */
const BRANDING_TYPES = Object.freeze([
  "embroidery", "screen_print", "digital_print", "heat_transfer",
  "logo_badge", "woven_patch", "other",
]);

/**
 * Whether the CUSTOMER's artwork is in hand.
 *
 * None of these means "approved for production". Nothing Sales captures at
 * enquiry time has been digitised, colour-separated or approved by anybody —
 * see `ARTWORK_IS_CUSTOMER_REFERENCE`, which downstream screens read so they
 * can say so beside an approved tech-sheet asset.
 */
const ARTWORK_STATES = Object.freeze(["provided", "awaiting_customer", "reference_only"]);

const SIZE_UNITS = Object.freeze(["cm", "mm", "in"]);
const DEFAULT_SIZE_UNIT = "cm";

/* Everything on a branding requirement is the buyer's own reference material.
   Stated as a constant rather than left implicit in a field name, because the
   distinction only matters at the point where a screen shows this next to an
   approved file — and that screen is written by somebody who did not write
   this. */
const ARTWORK_IS_CUSTOMER_REFERENCE = true;

/* The three old booleans, and the structured type each becomes when an old
   record is read. `printing` becomes `other`, never `screen_print`: the old
   checkbox never asked which print method, and choosing one here would invent
   a production instruction nobody gave. */
const LEGACY_BRANDING_SOURCES = Object.freeze([
  Object.freeze({ legacyKey: "embroidery", flag: "embroidery", type: "embroidery" }),
  Object.freeze({ legacyKey: "printing", flag: "printing", type: "other" }),
  Object.freeze({ legacyKey: "logo", flag: "logo", type: "logo_badge" }),
]);

const BRANDING_REF_PATTERN = /^BR-[0-9a-f]{12}$/;

const MAX_REQUIREMENTS_PER_PRODUCT = 12;
const MAX_ARTWORK_PER_REQUIREMENT = 6;

const str = (v) => String(v ?? "").trim();

class EnquiryBrandingIdentityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "EnquiryBrandingIdentityError";
    this.code = code;
  }
}

function mintBrandingRef() {
  return `BR-${crypto.randomBytes(6).toString("hex")}`;
}

/** A positive measurement, or null. Zero and negatives are not sizes. */
function size(v) {
  if (v === "" || v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined;
}

/** One image, in the shape the enquiry already stores its reference pictures. */
function image(im) {
  return {
    publicId: str(im.publicId) || undefined,
    fileId: str(im.fileId) || undefined,
    name: str(im.name).slice(0, 200) || undefined,
    url: str(im.url) || undefined,
  };
}

const usableImage = (im) => Boolean(im && (str(im.publicId) || str(im.fileId) || str(im.url)));

/**
 * One client-supplied requirement, cleaned to what the schema accepts.
 * Returns null for a row with nothing in it — an editor that always shows a
 * blank row would otherwise save an empty requirement on every edit.
 */
function sanitizeBrandingRequirement(r) {
  if (!r || typeof r !== "object") return null;

  const type = BRANDING_TYPES.includes(str(r.type)) ? str(r.type) : undefined;
  const placement = str(r.placement).slice(0, 120);
  const colourNotes = str(r.colourNotes).slice(0, 200);
  const notes = str(r.notes).slice(0, 500);
  const artworkState = ARTWORK_STATES.includes(str(r.artworkState)) ? str(r.artworkState) : undefined;
  /* `artwork`, not `images`: a requirement holds the customer's logo file, a
     product holds photographs of the garment, and one word for both is how
     they end up in one gallery. `images` is still read so an older client
     payload is not silently dropped. */
  const artwork = (Array.isArray(r.artwork) ? r.artwork : Array.isArray(r.images) ? r.images : [])
    .filter(usableImage)
    .slice(0, MAX_ARTWORK_PER_REQUIREMENT)
    .map(image);

  const width = size(r.width);
  const height = size(r.height);
  const empty = !type && !placement && !colourNotes && !notes && !artworkState && !artwork.length && !width && !height;
  if (empty) return null;

  return {
    /* Carried through UNTRUSTED, exactly like productLineRef one level up:
       `reconcileBrandingRequirements` accepts it only if this product line
       already holds it. */
    ref: str(r.ref) || undefined,
    type,
    placement: placement || undefined,
    width,
    height,
    unit: SIZE_UNITS.includes(str(r.unit)) ? str(r.unit) : DEFAULT_SIZE_UNIT,
    colourNotes: colourNotes || undefined,
    notes: notes || undefined,
    artworkState,
    artwork: artwork.length ? artwork : undefined,
    /* Set on a row that came from the old booleans. It is what stops one old
       record becoming two requirements when it is edited twice. */
    legacyKey: LEGACY_BRANDING_SOURCES.some((s) => s.legacyKey === str(r.legacyKey)) ? str(r.legacyKey) : undefined,
  };
}

/** The whole list for one product row, capped and de-duplicated by legacy key. */
function sanitizeBrandingRequirements(input) {
  if (!Array.isArray(input)) return undefined;
  const seenLegacy = new Set();
  const out = [];
  for (const raw of input) {
    const row = sanitizeBrandingRequirement(raw);
    if (!row) continue;
    if (row.legacyKey) {
      /* One requirement per old boolean, however many times a stale screen
         sends the projection back. */
      if (seenLegacy.has(row.legacyKey)) continue;
      seenLegacy.add(row.legacyKey);
    }
    out.push(row);
    if (out.length >= MAX_REQUIREMENTS_PER_PRODUCT) break;
  }
  return out;
}

/**
 * Give every requirement on every product line a reference, and make sure no
 * two share one ACROSS THE WHOLE ENQUIRY.
 *
 * Enquiry-wide rather than per-line on purpose: a reference is how a screen,
 * a handover or a downstream file points at one requirement, and two lines
 * holding "BR-abc" is exactly the ambiguity that lets one product's artwork be
 * shown against another's.
 */
function ensureBrandingRequirementIdentities(products) {
  const rows = Array.isArray(products) ? products : [];
  const seen = new Set();

  for (const product of rows) {
    for (const req of Array.isArray(product?.brandingRequirements) ? product.brandingRequirements : []) {
      const held = str(req?.ref);
      if (!held) continue;
      if (!BRANDING_REF_PATTERN.test(held)) {
        throw new EnquiryBrandingIdentityError(
          `"${held}" is not a branding requirement reference this system issued.`,
          "BRANDING_REF_MALFORMED",
        );
      }
      if (seen.has(held)) {
        throw new EnquiryBrandingIdentityError(
          `Two branding requirements carry the reference ${held}.`,
          "BRANDING_REF_DUPLICATE",
        );
      }
      seen.add(held);
    }
  }

  for (const product of rows) {
    for (const req of Array.isArray(product?.brandingRequirements) ? product.brandingRequirements : []) {
      if (str(req?.ref)) continue;
      let minted = mintBrandingRef();
      while (seen.has(minted)) minted = mintBrandingRef();
      seen.add(minted);
      /* Through the subdocument so mongoose marks it modified. */
      if (typeof req?.set === "function") req.set("ref", minted);
      else req.ref = minted;
    }
  }
  return rows;
}

/**
 * Carry forward the branding of a line that did not mention it.
 *
 * ── OMITTED IS NOT EMPTY ──────────────────────────────────────────────────
 * Two different statements arrive as almost the same payload:
 *
 *   · the field is ABSENT — this client did not edit branding on this row.
 *     An older build that predates structured branding sends every row this
 *     way, and the current one sends untouched rows this way. Its branding
 *     must survive untouched: both the stored rows AND the legacy booleans.
 *   · the field is an EMPTY ARRAY — a person opened this product and removed
 *     every requirement. That is a deliberate clear, and it has to stick:
 *     the rows go, and the old logo/embroidery/printing/brandingPlacement
 *     mirrors are reset with them, or the next read projects the booleans
 *     straight back and the deleted requirement reappears.
 *
 * Without this, an absent field silently DELETED the stored rows, because
 * sanitizeProducts rebuilds each row from scratch and assigns the whole array.
 * One quantity edit from an old tab would have taken every decoration and
 * every piece of customer artwork on the enquiry with it.
 */
function carryForwardOmittedBranding(existing, incoming) {
  const held = new Map();
  for (const line of Array.isArray(existing) ? existing : []) {
    const ref = str(line?.productLineRef);
    if (!ref) continue;
    const rows = Array.isArray(line?.brandingRequirements) ? line.brandingRequirements : [];
    /* Plain objects, so a mongoose subdocument is not re-parented into
       another array — and with their references, which is what makes this a
       carry-forward rather than a re-mint. */
    held.set(ref, rows.map((r) => (typeof r?.toObject === "function" ? r.toObject() : { ...r })));
  }

  for (const line of Array.isArray(incoming) ? incoming : []) {
    if ("brandingRequirements" in line) continue; // said something — respect it
    const ref = str(line?.productLineRef);
    const kept = ref ? held.get(ref) : null;
    if (!kept || !kept.length) continue;
    line.brandingRequirements = kept;
    /* The restored rows are the truth about this product's branding, so the
       old booleans are re-derived from them. Without this the row goes back
       with whatever mirrors the client happened to send — a pre-branding
       build sends its own stale pair — and the record ends up saying
       "embroidery: false" while holding an embroidery requirement. The mirror
       is never null here (the list is non-empty), so this can only correct
       them, never clear them. */
    const mirror = legacyMirror(kept);
    if (mirror) {
      line.logo = mirror.logo;
      line.embroidery = mirror.embroidery;
      line.printing = mirror.printing;
      if (mirror.brandingPlacement) line.brandingPlacement = mirror.brandingPlacement;
    }
  }
  return incoming;
}

/**
 * Decide, for each incoming requirement, which stored one it IS.
 *
 * Called after product lines have been reconciled, so every incoming row that
 * claims to be an existing line already carries a verified `productLineRef`.
 *
 * The one rule worth stating out loud: A REFERENCE BELONGS TO ITS PRODUCT
 * LINE. Naming a requirement that another line holds is refused rather than
 * honoured, because honouring it is how a customer's back-print artwork ends
 * up attached to the cap instead of the shirt — and because a client with a
 * reason to move artwork between products can simply attach it to the other
 * product, which produces a new requirement and leaves the original alone.
 *
 * Deleting a requirement is NOT declared, unlike removing a product line. A
 * product row is edited and saved as a whole, so its requirement list is a
 * complete statement about that row; there is no "absent means unknown" case
 * to distinguish. Two people editing the SAME product at once is the existing
 * last-writer-wins behaviour of every other field on the row (colour, images,
 * quantity), and this does not change it.
 *
 * @param {object[]} existing  the enquiry's stored product rows
 * @param {object[]} incoming  sanitised rows, each with a settled productLineRef
 * @returns {{ok: true} | {ok: false, code: string, message: string, details: object}}
 */
function reconcileBrandingRequirements(existing, incoming) {
  const refuse = (code, message, details = {}) => ({ ok: false, code, message, details });

  /* Every reference this enquiry holds, and the line that holds it. */
  const owner = new Map();
  for (const line of Array.isArray(existing) ? existing : []) {
    const lineRef = str(line?.productLineRef);
    for (const req of Array.isArray(line?.brandingRequirements) ? line.brandingRequirements : []) {
      const ref = str(req?.ref);
      if (ref) owner.set(ref, lineRef);
    }
  }

  const named = new Set();
  for (const line of Array.isArray(incoming) ? incoming : []) {
    const lineRef = str(line?.productLineRef);
    for (const req of Array.isArray(line?.brandingRequirements) ? line.brandingRequirements : []) {
      const ref = str(req?.ref);
      if (!ref) { if (req) delete req.ref; continue; }

      if (!BRANDING_REF_PATTERN.test(ref)) {
        return refuse("BRANDING_REF_MALFORMED",
          `"${ref}" is not a branding requirement reference this system issued.`, { ref });
      }
      if (!owner.has(ref)) {
        /* Forged, from another enquiry, or already deleted — one answer for
           all three, so the response confirms nothing about another record. */
        return refuse("BRANDING_REF_UNKNOWN",
          "A branding requirement in this save is not on this enquiry. Reload the enquiry and save again.",
          { ref });
      }
      if (owner.get(ref) !== lineRef) {
        return refuse("BRANDING_REF_FOREIGN",
          "A branding requirement in this save belongs to a different product. "
          + "Add it to this product instead — its artwork stays with the product it was captured on.",
          { ref, belongsTo: owner.get(ref) || null, claimedBy: lineRef || null });
      }
      if (named.has(ref)) {
        return refuse("BRANDING_REF_DUPLICATE",
          "Two branding requirements in this save claim the same reference.", { ref });
      }
      named.add(ref);
      req.ref = ref;
    }
  }
  return { ok: true };
}

/**
 * The old booleans, recomputed from the structured requirements.
 *
 * Written on every save that carries requirements, so the screens still
 * reading `embroidery` or `brandingPlacement` — the R&D brief email, the
 * costing workbook, two PDF generators — keep telling the truth about a
 * product captured the new way. Nothing reads them back the other way.
 *
 * Returns null when there is nothing to mirror: an empty list is not a
 * statement that a product has no branding, it is usually an old row nobody
 * opened, and overwriting its booleans would erase its only branding.
 */
function legacyMirror(requirements) {
  const rows = Array.isArray(requirements) ? requirements : [];
  if (!rows.length) return null;
  const has = (...types) => rows.some((r) => types.includes(str(r?.type)));
  const placements = rows.map((r) => str(r?.placement)).filter(Boolean);
  return {
    embroidery: has("embroidery"),
    printing: has("screen_print", "digital_print", "heat_transfer"),
    logo: has("logo_badge", "woven_patch"),
    brandingPlacement: [...new Set(placements)].join(", ") || undefined,
  };
}

/**
 * How an OLD record reads: the booleans projected into requirements.
 *
 * Only ever used when a row has no structured requirements of its own. Once it
 * has them, the booleans are a mirror OF them and projecting would show
 * everything twice.
 */
function legacyRequirements(product) {
  const placement = str(product?.brandingPlacement);
  return LEGACY_BRANDING_SOURCES
    .filter((s) => Boolean(product?.[s.flag]))
    .map((s) => ({
      ref: null, // a projection is not stored, so it has no reference
      legacyKey: s.legacyKey,
      type: s.type,
      placement: placement || "",
      width: null,
      height: null,
      unit: DEFAULT_SIZE_UNIT,
      colourNotes: "",
      notes: s.legacyKey === "printing"
        ? "Recorded as “Printing” before print methods were captured separately."
        : "",
      /* Not "provided": nothing could be attached when this was recorded, so
         claiming the artwork is in hand would be a false confirmation. */
      artworkState: "reference_only",
      artwork: [],
      legacy: true,
    }));
}

/** Every branding requirement on a product row — stored, or projected. */
function brandingRequirementsOf(product) {
  const stored = Array.isArray(product?.brandingRequirements) ? product.brandingRequirements : [];
  if (stored.length) {
    return stored.map((r) => ({
      ref: str(r?.ref) || null,
      legacyKey: str(r?.legacyKey) || null,
      type: str(r?.type) || "",
      placement: str(r?.placement) || "",
      width: r?.width ?? null,
      height: r?.height ?? null,
      unit: str(r?.unit) || DEFAULT_SIZE_UNIT,
      colourNotes: str(r?.colourNotes) || "",
      notes: str(r?.notes) || "",
      artworkState: str(r?.artworkState) || "",
      artwork: (Array.isArray(r?.artwork) ? r.artwork : []).map(image),
      legacy: false,
    }));
  }
  return legacyRequirements(product);
}

module.exports = {
  BRANDING_TYPES,
  ARTWORK_STATES,
  SIZE_UNITS,
  DEFAULT_SIZE_UNIT,
  ARTWORK_IS_CUSTOMER_REFERENCE,
  LEGACY_BRANDING_SOURCES,
  BRANDING_REF_PATTERN,
  MAX_REQUIREMENTS_PER_PRODUCT,
  MAX_ARTWORK_PER_REQUIREMENT,
  EnquiryBrandingIdentityError,
  mintBrandingRef,
  sanitizeBrandingRequirement,
  sanitizeBrandingRequirements,
  ensureBrandingRequirementIdentities,
  reconcileBrandingRequirements,
  carryForwardOmittedBranding,
  legacyMirror,
  legacyRequirements,
  brandingRequirementsOf,
};
