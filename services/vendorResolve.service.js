"use strict";
/**
 * services/vendorResolve.service.js
 *
 * TURN A LINE'S VENDOR INTO A REAL SUPPLIER RECORD.
 *
 * ── THE PROMISE THIS KEEPS ──────────────────────────────────────────────────
 * The vendor picker on every quote line already tells Store: "Not on the
 * books — it will be recorded as a new supplier." That sentence was written
 * and shipped before anything behind it existed — typing a name only ever
 * stored a string on the line, nothing was ever added to `vendors`. A
 * genuinely new supplier, quoted for the first time, stayed invisible to the
 * vendor picker, to the PO module's own vendor list, to every screen in the
 * app that reads the vendor master rather than a free-text field on one
 * request. This is what makes that sentence true.
 *
 * ── WHY LOOKUP-OR-CREATE, NOT ALWAYS CREATE ─────────────────────────────────
 * A picked vendor already carries a real id and is trusted as-is — no lookup
 * needed, and re-resolving it by name would risk matching a DIFFERENT vendor
 * that happens to share a name. A typed name with no id is matched
 * case-insensitively against the existing register first: "sharma systems"
 * and "Sharma Systems" typed on two different requests have to become the
 * SAME supplier, not two records that quietly diverge — one with a GSTIN, one
 * without, both meaning the company that supplied both requests.
 *
 * ── WHAT "MINIMAL" MEANS HERE ───────────────────────────────────────────────
 * `companyName` is the only field the Vendor model requires. A store person
 * mid-classification has a name and, sometimes, a GSTIN — nothing else, and
 * demanding more would defeat the whole point of letting a new supplier be
 * named inline. The full vendor record — contact, address, bank details — is
 * filled in later, through the app's own vendor-editing screen, by whoever
 * ends up dealing with them regularly.
 */
const mongoose = require("mongoose");
const Vendor = require("../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");

/**
 * @param {string|null} vendorId    an id the client posted, if a real supplier
 *                                   was picked rather than typed
 * @param {string}      vendorName  the name on the line, typed or picked
 * @param {string}      [gstin]     captured on the line, if given
 * @param {string|ObjectId} [createdBy]  the employee doing the classifying —
 *                          stamped from the session, never trusted from the
 *                          body, at the call site
 * @returns {Promise<import("mongoose").Types.ObjectId|null>}
 */
async function resolveVendor({ vendorId, vendorName, gstin, createdBy }) {
  if (vendorId && mongoose.isValidObjectId(vendorId)) {
    const picked = await Vendor.findById(vendorId).select("_id").lean();
    /* A real record — trust it as-is. An id that does not resolve to one
       (stale, or from a different environment's data) falls through to the
       name-based path rather than storing a reference to nothing. */
    if (picked) return picked._id;
  }

  const name = String(vendorName || "").trim();
  if (!name) return null;

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existing = await Vendor.findOne({
    companyName: new RegExp(`^${escaped}$`, "i"),
  }).select("_id");
  if (existing) return existing._id;

  const created = await Vendor.create({
    companyName: name,
    vendorType: "Other",
    gstNumber: String(gstin || "").trim().toUpperCase() || undefined,
    status: "Active",
    /* Named for what it is on the vendor list, without pretending to know
       anything this flow was never asked for. */
    notes: "Added automatically from a Store quote line.",
    createdBy: createdBy || undefined,
  });
  return created._id;
}

module.exports = { resolveVendor };
