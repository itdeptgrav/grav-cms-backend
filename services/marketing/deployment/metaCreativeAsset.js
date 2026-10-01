// services/marketing/deployment/metaCreativeAsset.js
//
// THE ADVERTISING IMAGE GRAV DOES NOT HAVE, AND WILL NOT PRETEND TO.
//
// ── THE BLOCKER, STATED ONCE ───────────────────────────────────────────────
// GRAV's content library holds emails, forms and landing pages. It holds no
// advertising image: nothing with a content hash, dimensions, a byte size, a
// rights state, or a readable binary Meta could upload.
//
// Meta will not create an image advertisement without a real image. So every
// Meta campaign is blocked today, and this file is what makes that refusal
// precise instead of vague.
//
// ── THE FOUR THINGS SOMEBODY WILL OFFER INSTEAD ────────────────────────────
// Each is refused, and each has a specific reason worth writing down, because
// "use the picture from the email" is an entirely reasonable thing for a
// marketer to say and the refusal has to explain itself.
//
//   An email's hero image is a URL inside an email body that the marketing
//   engine may rewrite, expire or track. Nothing guarantees it resolves
//   tomorrow, and Meta stores its own copy at upload — so the advertisement
//   would carry a picture nobody can point back at.
//
//   An arbitrary URL asks Meta to fetch something from an address GRAV does not
//   control, has never inspected, and cannot prove the company may advertise
//   with. It could be anything, including something that gets the account
//   restricted.
//
//   An attachment has no dimensions, no hash, no rights state, and no stable
//   identifier to reconcile against later.
//
//   A free-text reference — "the winter hero shot" — is an instruction to a
//   person, not an asset.
//
// ── AND WHAT IS NOT BUILT HERE ─────────────────────────────────────────────
// The asset library. This file defines the contract one would have to satisfy
// and refuses everything that does not. Building it is its own piece of work
// with its own storage, its own rights model and its own review.
"use strict";

const {
  IMAGE_ASSET_CONTRACT,
  IMAGE_ASSET_FIELDS,
  IMAGE_ASSET_BLOCKER,
  REFUSED_IMAGE_SOURCES,
  META_LIMITS,
  META_CODES: M,
} = require("../../../constants/marketingMetaDeployment");

const str = (v) => String(v ?? "").trim();
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

const SOURCE_BY_CODE = Object.fromEntries(REFUSED_IMAGE_SOURCES.map((r) => [r.code, r]));

/* ── WHICH REFUSAL APPLIES TO WHAT THE PLAN ACTUALLY CARRIES ────────────────
   The brief's image slot is a content reference: a kind, a content id and a
   captured name. Every kind the library can hold is a document of some sort,
   not an image — so the classification below is about being SPECIFIC, not about
   finding one that passes. */
function classifySource(image) {
  const kind = str(image?.kind);
  const contentId = str(image?.contentId);
  const capturedName = str(image?.capturedName);

  if (!kind && !contentId && !capturedName) return null;

  if (kind === "email") return "email_content";
  if (kind === "landing_page" || kind === "form") return "landing_page_content";
  /* A content id GRAV cannot place in any known kind. */
  if (contentId && !kind) return "attachment";
  if (/^https?:\/\//i.test(capturedName) || /^https?:\/\//i.test(contentId)) return "arbitrary_url";
  if (capturedName && !contentId) return "free_text";
  return "attachment";
}

/**
 * Is there an advertising image this plan can be created with?
 *
 * Today the answer is always no, and the interesting part is HOW it says so.
 *
 * @param {object}  args
 * @param {object}  args.brief   the plan's Meta deployment brief
 * @param {object} [args.asset]  a future asset record, when one exists
 * @returns {{ready:boolean, blocker:object, problems:object[], asset:object|null}}
 */
function evaluate({ brief, asset = null }) {
  const image = brief?.metaSingleImage?.image || null;
  const problems = [];

  /* ── WHEN AN ASSET LIBRARY EXISTS, THIS IS THE GATE IT PASSES ───────────
     Written now, exercised when there is something to exercise it with. It is
     here rather than in a future branch because the contract is the deliverable
     of this slice: whoever builds the library builds it against this. */
  if (asset) {
    const missing = IMAGE_ASSET_FIELDS.filter((f) => {
      const v = asset[f];
      return v === undefined || v === null || v === "";
    });
    if (missing.length) {
      problems.push({
        code: M.IMAGE_ASSET_MISSING,
        field: "metaSingleImage.image",
        message: "The advertising image record is incomplete.",
        missing,
      });
    }

    if (!missing.includes("mimeType") && !META_LIMITS.IMAGE_MIME_TYPES.includes(str(asset.mimeType))) {
      problems.push({
        code: M.IMAGE_ASSET_MISSING,
        field: "metaSingleImage.image",
        message: "That image file type cannot be used in an advertisement.",
      });
    }
    if (isNum(asset.width) && isNum(asset.height)
      && (asset.width < META_LIMITS.IMAGE_MIN_WIDTH || asset.height < META_LIMITS.IMAGE_MIN_HEIGHT)) {
      problems.push({
        code: M.IMAGE_ASSET_MISSING,
        field: "metaSingleImage.image",
        message: "That image is smaller than the advertising channel accepts.",
      });
    }
    if (isNum(asset.byteSize) && asset.byteSize > META_LIMITS.IMAGE_MAX_BYTES) {
      problems.push({
        code: M.IMAGE_ASSET_MISSING,
        field: "metaSingleImage.image",
        message: "That image file is larger than the advertising channel accepts.",
      });
    }
    /* ── RIGHTS AND USABILITY ARE NOT FORMALITIES ────────────────────────
       A campaign is a public, paid use of a picture. Somebody has to have said
       this company may make it. */
    if (asset.rightsState !== "approved_for_paid_advertising") {
      problems.push({
        code: M.IMAGE_ASSET_MISSING,
        field: "metaSingleImage.image",
        message: "Nobody has recorded that this image may be used in paid advertising.",
      });
    }
    if (asset.usable !== true) {
      problems.push({
        code: M.IMAGE_ASSET_MISSING,
        field: "metaSingleImage.image",
        message: "That advertising image is not currently usable.",
      });
    }

    return {
      ready: problems.length === 0,
      blocker: problems.length ? IMAGE_ASSET_BLOCKER : null,
      problems,
      asset: problems.length ? null : {
        assetId: str(asset.assetId),
        mimeType: str(asset.mimeType),
        width: asset.width,
        height: asset.height,
        contentHash: str(asset.contentHash),
      },
    };
  }

  /* ── NO ASSET. WHICH IS EVERY PLAN, TODAY. ──────────────────────────────
     The refusal names what the plan actually offered, so a marketer who pointed
     at an email image is told why that one cannot be used rather than being
     told, generically, that something is missing. */
  const source = classifySource(image);
  if (source) {
    const spec = SOURCE_BY_CODE[source];
    problems.push({
      code: M.IMAGE_SOURCE_REFUSED,
      field: "metaSingleImage.image",
      /* Internal precision; the public sentence is the blocker's. */
      message: `${spec.label} cannot be used as an advertising image. ${spec.why}`,
      source,
    });
  } else {
    problems.push({
      code: M.IMAGE_ASSET_MISSING,
      field: "metaSingleImage.image",
      message: "The plan names no image for the advertisement.",
    });
  }

  return { ready: false, blocker: IMAGE_ASSET_BLOCKER, problems, asset: null };
}

/* ── WHAT A MARKETER READS ──────────────────────────────────────────────────
   One calm sentence about GRAV's own limitation, plus what would fix it. No
   hashes, no byte sizes, no mention of a content-library kind somebody would
   then try to create. And the contract itself, for the operator or engineer who
   wants to know exactly what is required — named fields, no values. */
const publicBlocker = () => ({
  code: IMAGE_ASSET_BLOCKER.code,
  label: IMAGE_ASSET_BLOCKER.label,
  means: IMAGE_ASSET_BLOCKER.means,
  whatWouldFixIt: IMAGE_ASSET_BLOCKER.whatWouldFixIt,
  requiredOfAnyFutureAsset: IMAGE_ASSET_CONTRACT.map((f) => ({
    field: f.code, label: f.label, means: f.means,
  })),
});

module.exports = { evaluate, publicBlocker, classifySource, IMAGE_ASSET_FIELDS };
