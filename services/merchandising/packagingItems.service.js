// services/merchandising/packagingItems.service.js
//
// MERCHANDISING'S OWN PACKAGING-COMPONENT LOOKUP.
//
// ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
// The packaging picker reached for `GET /sample-styles/:id/production/raw-items
// /search`, which is R&D's. That endpoint's own header says so: it is "the
// search behind the (unrelated) Raw materials consumed picker further up the
// same R&D page". Merchandising borrowed it because it was there.
//
// Two things were wrong with that, and only one of them was about permissions.
//
// The permission half: the shared endpoint is gated on a Sales session alone,
// so it could not be given a Merchandising grant requirement without refusing
// the R&D caller it was written for. It stayed the one Merchandising-facing
// read with no Merchandising authorisation on it.
//
// The BOUNDARY half is the worse one. That endpoint answers R&D's question, so
// it returns what R&D needs: on-hand `quantity`, every variant, each variant's
// own stock, its `unitConversions`, and a `price` averaged from the vendor
// nicknames on it. A merchandiser choosing a poly bag was being handed the
// company's supplier pricing and its stock position to do it — two facts that
// belong to Supply Chain and Store, published to a desk that owns neither,
// through a picker whose whole design principle is that Merchandising selects
// identity and never a rate.
//
// ── SO THIS ANSWERS MERCHANDISING'S QUESTION INSTEAD ────────────────────────
// "Which component in this company's item master do I mean?" Three fields —
// the identity and the two references a person recognises it by. No price, no
// supplier, no vendor, no stock, no unit, no variant, no conversion, no
// costing. The picker renders exactly `name` and `sku` and stores the `id`;
// everything else was being sent for nobody to read.
//
// ── AND IT IS A SPLIT, NOT A FORK ───────────────────────────────────────────
// No record is copied and no second master is created. `RawItem` remains the
// one item master, company-scoped as it always was. What is new is a door onto
// it that states who may knock and what may come back.
"use strict";

const mongoose = require("mongoose");

/* Tenancy, not costing. See services/integration/styleOwnershipProof.service.js. */
const { ownershipProofFor } = require("../integration/styleOwnershipProof.service");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const model = (name, path) => (mongoose.models[name] || require(path));
const SampleStyle = () => model("SampleStyle", "../../models/CMS_Models/Sales/SampleStyle");
const RawItem = () => model("RawItem", "../../models/CMS_Models/Inventory/Products/RawItem");

/** Short enough that a stray keystroke is not a scan; the R&D picker uses the same. */
const MIN_TERM = 2;

/** A picker offers a shortlist, not a report. */
const MAX_RESULTS = 10;

/**
 * WHAT MAY LEAVE THIS LOOKUP FOR ONE ITEM.
 *
 * An allowlist, built field by field. A `.select()` narrowed to these three
 * would already be enough today; building the row explicitly is what stops the
 * next field added to `RawItem` from arriving here by accident.
 */
const itemView = (row) => ({
  id: str(row._id),
  name: str(row.name),
  sku: str(row.sku),
});

/**
 * The component candidates for one style's packaging selection.
 *
 * The STYLE is scoped first and answers missing and foreign alike, so this
 * cannot be used to ask whether a style id exists in another company's books.
 * The ITEMS are then read from this company's own master — never the
 * deployment's.
 */
async function searchPackagingItems(ctx, { styleId, q } = {}) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
  if (!isId(styleId)) throw fail("NOT_FOUND", "Style not found.");

  const style = await SampleStyle().findById(styleId)
    /* Only what proves ownership. The technical record, the sample and the
       materials are not read to answer "which poly bag". */
    .select("_id journeyId enquiryId").lean();
  if (!style) throw fail("NOT_FOUND", "Style not found.");
  if (!(await ownershipProofFor(style, ctx.companyId))) {
    /* Missing and foreign are one answer, exactly as every other Merchandising
       style door answers them. */
    throw fail("NOT_FOUND", "Style not found.");
  }

  const term = str(q);
  /* Not an error: a picker asks on every keystroke, and one letter is not yet
     a question. An empty list is the truthful answer to it. */
  if (term.length < MIN_TERM) return { items: [] };

  /* Escaped before it becomes a regular expression: an unescaped `(` is a
     syntax error the caller can trigger, and an unescaped `.*` is a scan
     somebody else pays for. */
  const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const rows = await RawItem()
    .find({ companyId: ctx.companyId, $or: [{ name: rx }, { sku: rx }] })
    .select("_id name sku")
    .sort({ name: 1 })
    .limit(MAX_RESULTS)
    .lean();

  return { items: rows.map(itemView) };
}

module.exports = { MIN_TERM, MAX_RESULTS, itemView, searchPackagingItems };
