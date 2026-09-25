// services/sales/customerChangeRouting.service.js
//
// WHERE A CUSTOMER'S REJECTION ACTUALLY GOES.
//
// ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
// A rejected sample offered two buttons: "Send to R&D for Rework" and "Change
// Product Design". Between them they had to absorb every reason a customer
// ever says no — "the fabric feels thin", "the collar sits wrong", "the
// stitching is untidy", "this isn't the garment we asked for" — and the first
// three all became the same thing: `sample.status = "rejected"`, a note, and
// R&D asked to make another one.
//
// That is wrong work for two of them. A fabric complaint is a Merchandising
// decision about the BOM; a fit complaint is a technical revision. Sending
// either to R&D as "make it again" produces a second sample with the same
// fabric and the same pattern, and the customer rejects it again.
//
// ── THE DEPENDENCY ORDER IS THE WHOLE RULE ─────────────────────────────────
// Development is a chain. Each link is built on the one before it:
//
//     Brief → Materials/BOM → Tech Sheet → Sample Round
//
// So a change re-enters the chain at the EARLIEST link it touches, and
// everything downstream of that link has to be done again. "Change the fabric
// and fix the collar" is not two parallel jobs — the collar is patterned
// against a fabric that is about to change, so it goes to Materials first and
// reaches the tech sheet afterwards, through the ordinary flow.
//
// Choosing the latest link instead, or letting a person pick freely, is how a
// tech sheet gets revised against a BOM that is itself being replaced.
//
// ── PURE ───────────────────────────────────────────────────────────────────
// No database, no model imports, no side effects. The route applies what this
// returns; the tests read the same rules the screen previews them with.
"use strict";

/** What the customer asked to change. Stable codes — stored on the record. */
const CHANGE_CATEGORIES = Object.freeze([
  Object.freeze({
    code: "MATERIALS_BOM",
    label: "Fabric, colour, GSM, composition, trims or material selection",
    short: "Materials",
    destination: "MATERIALS_BOM",
  }),
  Object.freeze({
    code: "TECH_SHEET",
    label: "Construction, measurements, pattern, fit, technical specification or workmanship method",
    short: "Technical specification",
    destination: "TECH_SHEET",
  }),
  Object.freeze({
    code: "SAMPLE_ROUND",
    label: "Stitching quality, finishing or sample execution — another trial of the same approved specification",
    short: "Sample execution",
    destination: "SAMPLE_ROUND",
  }),
  Object.freeze({
    code: "BRIEF_NEW_VERSION",
    label: "Product concept, silhouette, branding requirement or a fundamentally different garment",
    short: "Product concept",
    destination: "BRIEF_NEW_VERSION",
  }),
]);

const CHANGE_CATEGORY_CODES = Object.freeze(CHANGE_CATEGORIES.map((c) => c.code));

/**
 * Where a change is routed, IN DEPENDENCY ORDER.
 *
 * The index is the position in the chain, and it is what `destinationFor`
 * sorts on. Earlier means more upstream, means more work invalidated.
 */
const CHANGE_DESTINATIONS = Object.freeze([
  Object.freeze({
    code: "BRIEF_NEW_VERSION",
    label: "Brief / new product version",
    owner: "sales",
    /* Not a revision of this product at all — a different product that
       replaces it. Everything about the rejected one is kept. */
    reopens: "the enquiry product brief, as a new version",
  }),
  Object.freeze({
    code: "MATERIALS_BOM",
    label: "Materials / BOM",
    owner: "merchandiser",
    reopens: "material selection and BOM approval",
  }),
  Object.freeze({
    code: "TECH_SHEET",
    label: "Tech sheet / R&D",
    owner: "research-development",
    reopens: "the technical specification, as a new revision",
  }),
  Object.freeze({
    code: "SAMPLE_ROUND",
    label: "New sample round",
    owner: "research-development",
    reopens: "sampling only — a new round against the approved specification",
  }),
]);

const CHANGE_DESTINATION_CODES = Object.freeze(CHANGE_DESTINATIONS.map((d) => d.code));
const DESTINATION_ORDER = Object.freeze(
  Object.fromEntries(CHANGE_DESTINATIONS.map((d, i) => [d.code, i])),
);
const DESTINATION = Object.freeze(Object.fromEntries(CHANGE_DESTINATIONS.map((d) => [d.code, d])));
const CATEGORY = Object.freeze(Object.fromEntries(CHANGE_CATEGORIES.map((c) => [c.code, c])));

/** The statuses a change request moves through. */
const CHANGE_REQUEST_STATUSES = Object.freeze([
  "OPEN", "IN_PROGRESS", "RESOLVED", "SUPERSEDED", "CANCELLED",
]);

/** Statuses that still block the product from moving on. */
const OPEN_STATUSES = Object.freeze(["OPEN", "IN_PROGRESS"]);

const str = (v) => String(v ?? "").trim();

/** The categories a caller actually named, de-duplicated and validated. */
function normaliseCategories(input) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(input) ? input : []) {
    const code = str(raw).toUpperCase();
    if (!CATEGORY[code] || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  /* Kept in dependency order rather than the order they were ticked, so the
     record reads the way the work will happen. */
  return out.sort((a, b) => DESTINATION_ORDER[CATEGORY[a].destination] - DESTINATION_ORDER[CATEGORY[b].destination]);
}

/**
 * THE EARLIEST AFFECTED LINK IN THE CHAIN.
 *
 * Several categories do not mean several jobs. They mean one re-entry point —
 * the most upstream one — because everything after it is rebuilt on the way
 * back down. A material change plus a construction change is a MATERIALS_BOM
 * change; the construction is re-specified against the new fabric afterwards.
 *
 * @returns {string|null} a destination code, or null when nothing was named
 */
function destinationFor(categories) {
  const codes = normaliseCategories(categories);
  if (!codes.length) return null;
  return codes
    .map((c) => CATEGORY[c].destination)
    .reduce((earliest, d) => (DESTINATION_ORDER[d] < DESTINATION_ORDER[earliest] ? d : earliest));
}

/**
 * May this destination be chosen for these categories?
 *
 * A person may override the suggestion — they know things the categories do
 * not carry — but only UPSTREAM of it. Routing a fabric complaint to "new
 * sample round" would ask R&D to sew the same rejected fabric again, and the
 * customer would reject it for the same reason.
 */
function validateDestination(destination, categories) {
  const code = str(destination).toUpperCase();
  if (!DESTINATION[code]) {
    return { ok: false, code: "DESTINATION_UNKNOWN", message: "That is not a destination this system routes to." };
  }
  const suggested = destinationFor(categories);
  if (!suggested) {
    return { ok: false, code: "CATEGORY_REQUIRED", message: "Say what the customer asked to change." };
  }
  if (DESTINATION_ORDER[code] > DESTINATION_ORDER[suggested]) {
    return {
      ok: false,
      code: "DESTINATION_TOO_LATE",
      message: `${DESTINATION[code].label} comes after ${DESTINATION[suggested].label} in development, so it cannot answer this change. `
        + `Route it to ${DESTINATION[suggested].label} or earlier.`,
      suggested,
    };
  }
  return { ok: true, destination: code, suggested };
}

/* ── WHAT EACH DESTINATION REOPENS, AND WHAT IT LEAVES ALONE ──────────────
   Stated as data so the screen can tell somebody BEFORE they confirm, and so
   the route and the explanation cannot drift apart.

   Nothing in here deletes. "Superseded" and "needs revalidation" are both
   forward-only statements: the previous approval stays on the record as what
   was true at the time. */
const INVALIDATION = Object.freeze({
  MATERIALS_BOM: Object.freeze({
    reopen: Object.freeze(["materials", "bomApproval"]),
    revalidate: Object.freeze(["techSheet", "sample", "customerApproval"]),
    preserve: Object.freeze(["the approved BOM as history", "every tech-sheet revision", "every sample round and its verdict"]),
    stage: "materials",
    summary: "Material selection and BOM approval reopen. The tech sheet and the sample "
      + "that were built on the old BOM need doing again once the new materials are approved.",
  }),
  TECH_SHEET: Object.freeze({
    reopen: Object.freeze(["techSheet"]),
    revalidate: Object.freeze(["sample", "customerApproval"]),
    preserve: Object.freeze(["the approved BOM", "every earlier technical revision", "every sample round and its verdict"]),
    stage: "rnd",
    summary: "A new tech-sheet revision opens, linked to the approved one. The BOM stays "
      + "approved. The sample and the customer's approval need doing again on the new revision.",
  }),
  SAMPLE_ROUND: Object.freeze({
    reopen: Object.freeze(["sample"]),
    revalidate: Object.freeze(["customerApproval"]),
    preserve: Object.freeze(["the approved BOM", "the approved tech sheet", "every earlier sample round and its verdict"]),
    stage: "rnd",
    summary: "A new sample round opens against the same approved specification. "
      + "Nothing about the BOM or the tech sheet changes — only the customer's approval is asked again.",
  }),
  BRIEF_NEW_VERSION: Object.freeze({
    reopen: Object.freeze(["brief"]),
    revalidate: Object.freeze([]),
    preserve: Object.freeze(["the rejected product and its whole history", "its costing and development links", "the customer's rejection"]),
    stage: "brief",
    summary: "The rejected product is kept exactly as it is, and a new version is raised "
      + "that supersedes it. Nothing on the old product is deleted or rewritten.",
  }),
});

/** What a destination will reopen, preserve and ask to be done again. */
const invalidationFor = (destination) => INVALIDATION[str(destination).toUpperCase()] || null;

/** Which department owns the change once it is routed. */
const ownerFor = (destination) => DESTINATION[str(destination).toUpperCase()]?.owner || null;

/**
 * Is this product blocked from moving on to Purchase Invoice?
 *
 * A change request that is still open means the customer asked for something
 * nobody has answered yet. The product cannot be invoiced against a sample
 * they rejected, whatever the style's own status says.
 */
const blocksCommercial = (request) => OPEN_STATUSES.includes(str(request?.status).toUpperCase());

/**
 * A one-line description of a routed change, for a timeline entry.
 * Deliberately names the destination AND the owner — "who has it now" is the
 * question a person reading a timeline is asking.
 */
function summarise(request) {
  const dest = DESTINATION[str(request?.destination).toUpperCase()];
  if (!dest) return "";
  const cats = normaliseCategories(request?.categories).map((c) => CATEGORY[c].short);
  const what = cats.length ? cats.join(", ") : "Customer changes";
  return `${what} → ${dest.label}`;
}

module.exports = {
  CHANGE_CATEGORIES,
  CHANGE_CATEGORY_CODES,
  CHANGE_DESTINATIONS,
  CHANGE_DESTINATION_CODES,
  CHANGE_REQUEST_STATUSES,
  OPEN_STATUSES,
  DESTINATION_ORDER,
  normaliseCategories,
  destinationFor,
  validateDestination,
  invalidationFor,
  ownerFor,
  blocksCommercial,
  summarise,
};
