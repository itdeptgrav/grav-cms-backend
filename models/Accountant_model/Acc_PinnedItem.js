// models/Accountant_model/Acc_PinnedItem.js
//
// Generic per-user "pin to top" registry.
//
// Used by every list page in the accountant module — Payables Aging,
// Receivables Aging, Ledgers, Vendors, Customers, etc. One schema, one
// set of routes, every page benefits.
//
// Why a separate collection instead of an array on Acc_User?
//   - Pins are unbounded (could be thousands per user across many pages)
//   - Querying "give me my pins for page X" is one indexed query here,
//     vs. fetching the whole user document + filtering in app
//   - DELETE / upsert semantics are cleaner with their own collection
//
// Key dimensions:
//   userId      → who pinned it (per-user; my pins follow me to every device)
//   entityType  → which page / kind of thing ("payable", "ledger",
//                 "vendor", "customer", "invoice"…)
//   entityId    → the row's stable identifier (Mongo _id OR a business
//                 identifier like PO number — either works, stored as String)
//   pinnedAt    → when the user pinned it; pin list sorts by this DESC
//   label       → human-readable name cached at pin time, so if the
//                 underlying entity is deleted we can still show a tomb-
//                 stone instead of "Unknown #abc123"
//
// Unique index on (userId, entityType, entityId) so re-pinning is an
// idempotent "refresh pinnedAt" rather than a duplicate row.

const mongoose = require("mongoose");

const pinnedItemSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_User",
      required: true,
      index: true,
    },
    // The org is denormalized so we can scope queries / cleanup by org
    // if we ever need to. Not strictly required for read paths since
    // userId already gates everything, but cheap to store.
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Organization",
      index: true,
    },

    entityType: {
      type: String,
      required: true,
      // Free-form so new pages don't need a schema migration. Suggested
      // values (kept consistent across the codebase):
      //   "payable"    → Payables Aging row (PO number)
      //   "receivable" → Receivables Aging row (invoice number)
      //   "ledger"     → Acc_Ledger (Mongo _id)
      //   "vendor"     → Vendor (Mongo _id)
      //   "customer"   → Customer (Mongo _id)
      //   "invoice"    → Acc_Invoice (Mongo _id)
      //   "voucher"    → Voucher (Mongo _id)
    },
    entityId: {
      type: String, // String so it can hold Mongo ObjectId hex OR
      // a business identifier like "PO26052782"
      required: true,
      trim: true,
    },

    pinnedAt: { type: Date, default: Date.now },

    // Display cache — what to show in the UI without re-querying the
    // entity. Updated whenever the entity is re-pinned (POST upsert).
    label: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "acc_pinned_items" },
);

// Composite uniqueness: a user can pin a given entity-id under a given
// entity-type AT MOST once. Re-pinning refreshes pinnedAt instead of
// creating a duplicate.
pinnedItemSchema.index(
  { userId: 1, entityType: 1, entityId: 1 },
  { unique: true },
);

// Common read path: "give me this user's pins for this page", sorted
// most-recently-pinned-first.
pinnedItemSchema.index({ userId: 1, entityType: 1, pinnedAt: -1 });

const Acc_PinnedItem =
  mongoose.models.Acc_PinnedItem || mongoose.model("Acc_PinnedItem", pinnedItemSchema);

module.exports = Acc_PinnedItem;
