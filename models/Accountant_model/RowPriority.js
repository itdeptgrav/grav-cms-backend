// models/Accountant_model/RowPriority.js
//
// Per-user manual sort order for list-page rows.
//
// Distinct from PinnedItem in intent:
//   - PinnedItem  → "float this row to the top in an explicit Pinned section"
//   - RowPriority → "within this bucket, this row should sit at this position"
//
// Both collections coexist on the same list pages. A row can be pinned
// AND priority-ranked; pinning floats it to the Pinned section, where
// pinnedAt drives ordering. Priority kicks in only for the non-pinned
// rows inside their natural bucket.
//
// Storage model:
//   userId      — whose ordering this is (per-user, follows across devices)
//   organizationId — denormalized for org-scoped cleanup if ever needed
//   entityType  — which page (same vocabulary as PinnedItem)
//   entityId    — row's stable id (string, holds Mongo _id or business id)
//   bucket      — optional grouping key (e.g. "days_1_30") so priorities
//                 are scoped to a section. Lets us guarantee dragging
//                 within "1-30 Days" doesn't conflict with priorities in
//                 "31-60 Days".
//   rank        — integer; LOWER = HIGHER in the list. Stored sparse
//                 (e.g. 100, 200, 300) so inserting between two existing
//                 ranks rarely requires renumbering.
//
// Sort behavior in the UI:
//   items in a bucket are sorted by:
//     1. rank ASC if the row has a RowPriority entry
//     2. natural order from the API response otherwise
//   Tiebreak: priority-ranked rows always come BEFORE non-ranked rows.

const mongoose = require("mongoose");

const rowPrioritySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantUser",
      required: true,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantOrganization",
      index: true,
    },
    entityType: { type: String, required: true, trim: true },
    entityId: { type: String, required: true, trim: true },
    bucket: { type: String, default: "", trim: true },

    // Lower = higher in list. We use sparse integers so most reorders
    // require only one document update (give the new row a rank between
    // the two it landed between).
    rank: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, collection: "accountant_row_priorities" },
);

// One row → one priority per user / entityType. Re-ranking is an update,
// not an insert.
rowPrioritySchema.index(
  { userId: 1, entityType: 1, entityId: 1 },
  { unique: true },
);

// Hot read path: "give me this user's priorities for this page", sorted
// by rank ascending so the UI can apply them in order.
rowPrioritySchema.index({ userId: 1, entityType: 1, rank: 1 });

const RowPriority =
  mongoose.models.RowPriority ||
  mongoose.model("RowPriority", rowPrioritySchema);

module.exports = RowPriority;
