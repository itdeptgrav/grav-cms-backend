// models/CMS_Models/Sales/Department.js
//
// CRMDepartment — a unit within an account or one of its sites (Procurement,
// HR/Admin, Accounts, Housekeeping, Security, Kitchen…). Later modules attach
// uniform wearer categories, budgets, approvals, and deliveries to this record,
// so it is a first-class entity now rather than a free-text field on a contact.
const mongoose = require("mongoose");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
});

const departmentSchema = new mongoose.Schema(
  {
    departmentId: { type: String, unique: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", required: true, index: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMSite" },
    parentDepartmentId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMDepartment" },

    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true },
    status: { type: String, enum: ["active", "inactive", "archived"], default: "active" },
    costCenter: { type: String, trim: true },
    externalReference: { type: String, trim: true },

    createdBy: actorRef(),
    updatedBy: actorRef(),
    archivedAt: { type: Date },
    archivedBy: actorRef(),
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

departmentSchema.index({ accountId: 1, isActive: 1 });

departmentSchema.pre("save", async function (next) {
  if (!this.departmentId) {
    const count = await mongoose.model("CRMDepartment").countDocuments();
    this.departmentId = `DEPT-${String(count + 1).padStart(4, "0")}`;
  }
  next();
});

module.exports = mongoose.model("CRMDepartment", departmentSchema);
