// models/CMS_Models/Sales/AccountTeam.js
//
// CRMAccountTeam — the internal employees responsible for an account (sales
// owner, account manager, merchandiser, uniform program coordinator, service
// owner, finance owner, executive sponsor). Separate from the account's legacy
// single `assignedTo` so an account can carry a full team, with at most one
// primary per role (enforced in the route via services/crmPrimary).
const mongoose = require("mongoose");
const { TEAM_ROLE_CODES } = require("../../../constants/crm");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
});

const teamSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesDepartment", required: true },
    userName: { type: String, trim: true },
    teamRole: { type: String, enum: TEAM_ROLE_CODES, required: true },
    isPrimary: { type: Boolean, default: false },
    startDate: { type: Date, default: Date.now },
    endDate: { type: Date },

    createdBy: actorRef(),
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

teamSchema.index({ accountId: 1, isActive: 1 });
// The same user cannot hold the same role on the same account twice (while active).
teamSchema.index(
  { accountId: 1, userId: 1, teamRole: 1, isActive: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);

module.exports = mongoose.model("CRMAccountTeam", teamSchema);
