// models/CMS_Models/Sales/AccountRelationship.js
//
// CRMAccountRelationship — a typed, directional edge between two accounts. This
// is how the buying-house ↔ brand ↔ billing-party ↔ agent graph is modelled
// instead of free-text fields: each party is its own Account, connected here by
// stable IDs. relationshipType is stored as the FORWARD code; the inverse label
// is rendered per-perspective (see constants/crm relationshipLabelFrom).
const mongoose = require("mongoose");
const { RELATIONSHIP_TYPE_CODES } = require("../../../constants/crm");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
});

const relationshipSchema = new mongoose.Schema(
  {
    relationshipId: { type: String, unique: true },
    fromAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", required: true, index: true },
    toAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", required: true, index: true },
    relationshipType: { type: String, enum: RELATIONSHIP_TYPE_CODES, required: true },

    startDate: { type: Date },
    endDate: { type: Date }, // set => the relationship has ended (kept in history)
    isPrimary: { type: Boolean, default: false },
    notes: { type: String, trim: true },

    createdBy: actorRef(),
    updatedBy: actorRef(),
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// Prevent an exact ACTIVE duplicate of the same directed, typed edge.
relationshipSchema.index(
  { fromAccountId: 1, toAccountId: 1, relationshipType: 1, isActive: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);

// A relationship must connect two DIFFERENT accounts.
relationshipSchema.pre("validate", function (next) {
  if (this.fromAccountId && this.toAccountId && String(this.fromAccountId) === String(this.toAccountId)) {
    this.invalidate("toAccountId", "A relationship cannot connect an account to itself.");
  }
  next();
});

relationshipSchema.pre("save", async function (next) {
  if (!this.relationshipId) {
    const count = await mongoose.model("CRMAccountRelationship").countDocuments();
    this.relationshipId = `REL-${String(count + 1).padStart(4, "0")}`;
  }
  next();
});

module.exports = mongoose.model("CRMAccountRelationship", relationshipSchema);
