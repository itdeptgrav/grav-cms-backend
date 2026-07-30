// models/CMS_Models/Inventory/Operations/StoreSettings.js
//
// The address and contact block printed on a module's PDFs.
//
// One document per module (`key`): "store" for purchase orders, requisitions
// and work orders; "sales" for quotations, measurement POs and work-order
// progress sheets. They are independent records — the sales team changing
// their address must not touch the store letterhead.
//
// ── Why a singleton ───────────────────────────────────────────────────────
// There is one store, so there is one letterhead. Modelling this as a normal
// collection would allow two rows to exist and leave every PDF asking "which
// one?". A fixed `key` with a unique index makes a second document impossible
// at the database level rather than by convention.
//
// Brand name and logo are deliberately NOT here. Those are group-wide identity,
// shared with modules this collection has no business reaching into; only the
// store's own address and contact details are configurable.

const mongoose = require("mongoose");

const storeSettingsSchema = new mongoose.Schema(
  {
    // The module this letterhead belongs to — "store", "sales", … One document
    // per scope, and never set by callers, so a store person editing their own
    // address cannot reach the sales one. The unique index is what makes a
    // duplicate impossible at the database level rather than by convention.
    key: { type: String, default: "store", unique: true, immutable: true },

    // Printed as separate lines, in this order. Kept as discrete lines rather
    // than one free-text blob so a PDF can lay them out and a blank line can
    // collapse instead of printing an empty row.
    addressLine1: { type: String, trim: true, default: "" },
    addressLine2: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "" },
    pincode: { type: String, trim: true, default: "" },

    phone: { type: String, trim: true, default: "" },
    altPhone: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },

    gstin: { type: String, trim: true, default: "" },

    // Suggested additions — all optional, all print only when filled.
    // Vendors ask for these constantly and they currently live nowhere.
    website: { type: String, trim: true, default: "" },
    contactPerson: { type: String, trim: true, default: "" },
    storeName: { type: String, trim: true, default: "" },   // e.g. "Central Store"

    // Free line under the address, for anything the fixed fields miss —
    // a landmark, a gate number, delivery timings.
    extraLine: { type: String, trim: true, default: "" },

    updatedByRef: { type: mongoose.Schema.Types.ObjectId, default: null },
    updatedByName: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

/**
 * The document for one scope, created empty on first read.
 *
 * Empty rather than pre-filled with the old hardcoded address: the PDFs carry
 * that as their fallback, so an untouched install prints exactly what it
 * printed before, and a field left blank here is a deliberate "use the
 * default" rather than a value someone has to keep in sync in two places.
 *
 * Scopes are separate documents, so the store and sales letterheads are
 * independent — editing one cannot affect the other.
 */
storeSettingsSchema.statics.get = async function (scope = "store") {
  const key = String(scope || "store");
  const existing = await this.findOne({ key });
  if (existing) return existing;
  try {
    return await this.create({ key });
  } catch (err) {
    // Two concurrent first-reads race; the unique index rejects the loser,
    // whose document is now guaranteed to exist.
    if (err?.code === 11000) return this.findOne({ key });
    throw err;
  }
};

module.exports =
  mongoose.models.StoreSettings ||
  mongoose.model("StoreSettings", storeSettingsSchema);
