"use strict";
// services/integration/styleOwnershipProof.service.js
//
// DOES THIS STYLE BELONG TO THIS COMPANY?
//
// A `SampleStyle` carries no `companyId` of its own. Its Sales Journey does,
// and a house sample with no journey still has an enquiry — so ownership is
// proved through whichever parent carries one. That is a TENANCY question and
// nothing else: no rate, no policy, no calculation, no commercial value.
//
// ── WHY IT LIVES HERE AND NOT WHERE IT USED TO ──────────────────────────────
// It was `ownershipProofFor` in `services/centralCosting/technicalSource.service.js`,
// and Merchandising and Sales both imported it from there. That import was the
// only reason either of them reached into Central Costing at all, and it
// dragged four Costing modules — a calculation engine among them — into the
// load graph of two services that have no business knowing costing exists.
//
// Merchandising and Sales PUBLISH approved material-selection identities for
// Costing to consume. Consumption is Costing's half, and the arrow points one
// way. A shared helper that happened to sit on Costing's side of it was
// pointing the arrow back.
//
// So the proof moved to the integration layer, which is where facts that
// several applications need but none owns already live. It reads two Sales
// models and returns a statement about ownership; every caller keeps the
// behaviour it had.
//
// ── COSTING STILL HAS ITS OWN COPY, DELIBERATELY UNTOUCHED ──────────────────
// `technicalSource.service.js` is the Central Costing lane's file and is being
// worked on. Rewriting it to import this module would be editing their work to
// suit ours. The two are byte-equivalent in behaviour, and this note is the
// pointer for whoever consolidates them: this is the copy that has no
// dependency on anything above it.

const mongoose = require("mongoose");

/* Lazy, exactly as the original was: the Sales graph is large and a caller
   that never proves a style should not pay to compile it. */
const salesJourneyModel = () => require("../../models/CMS_Models/Sales/SalesJourney");
const enquiryModel = () => require("../../models/CMS_Models/Sales/Enquiry");

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ""));
const present = (v) => v !== null && v !== undefined && v !== "";
const str = (v) => (present(v) ? String(v).trim() : "");

/**
 * Match a reference that may be an id OR a business reference.
 *
 * `journeyId` and `enquiryId` are declared as ObjectIds and normally hold one,
 * but the same fields are also written from imports and older records carrying
 * the business reference (`SJ-2026-0002`, `ENQ-2026-00014`). A lookup that only
 * ever matched `_id` refuses those silently, as a record that does not exist.
 *
 * An ObjectId tries both, because a business reference is not guaranteed to be
 * un-ObjectId-shaped forever and matching the wrong one would read as "no such
 * record".
 */
function refQuery(value, refField) {
  const raw = String(value);
  return isObjectId(value)
    ? { $or: [{ _id: value }, { [refField]: raw }] }
    : { [refField]: raw };
}

/**
 * Prove a style belongs to this company through a parent that carries one.
 *
 * @returns {Promise<{proof: "SALES_JOURNEY"|"ENQUIRY", journeyRef: string}|null>}
 *   The provenance of the proof, or `null` when no parent proves it. `null` is
 *   the ONE refusal for every reason — absent, another company's, or reachable
 *   from no proven parent — because a refusal that varies with the answer is an
 *   oracle for which style ids are real.
 */
async function ownershipProofFor(style, companyId) {
  const want = String(companyId);

  if (style.journeyId) {
    const journey = await salesJourneyModel()
      .findOne(refQuery(style.journeyId, "journeyId")).select("companyId journeyId").lean();

    /* ── A JOURNEY THAT NAMES A COMPANY IS THE ANSWER, EITHER WAY ────────
       The journey is the spine. When it resolves AND carries a company, that
       company owns the style — so a journey belonging to somebody else is a
       refusal and must NOT fall through to the enquiry. Reading ownership off
       a second parent after the authoritative one said "not yours" is a tenant
       leak, not a fallback. */
    if (journey && journey.companyId) {
      if (String(journey.companyId) !== want) return null;
      return { proof: "SALES_JOURNEY", journeyRef: str(journey.journeyId) };
    }

    /* A journey that is missing, or that carries no company at all, has proved
       NOTHING — neither ownership nor foreignness. That is the one case worth
       asking the enquiry about: it used to end the search here, so a style
       whose journey was unowned was refused even when its own enquiry proved
       the very same company. A refusal has to mean "no parent proves this",
       not "the first parent I tried did not". */
  }

  if (style.enquiryId) {
    const enquiry = await enquiryModel()
      .findOne(refQuery(style.enquiryId, "enquiryId")).select("companyId enquiryId").lean();
    if (!enquiry) return null;
    if (String(enquiry.companyId || "") !== want) return null;
    return { proof: "ENQUIRY", journeyRef: "" };
  }

  /* No proven parent at all. */
  return null;
}

module.exports = { ownershipProofFor, refQuery };
