// models/Accountant_model/AccountantOrgModels.js
// =============================================================================
// ACCOUNTANT ORG MODELS
// -----------------------------------------------------------------------------
// Adds tenant + role-based-access on top of the existing accountant module.
// Each "Owner" of the accounting workspace gets an AccountantOrganization;
// they can invite sub-account users (Approver / Editor / Viewer) who log in
// with their own email + password but are scoped to the owner's data.
//
// Entities introduced:
//
//   AccountantOrganization — the tenant boundary. Owns N TallyCompanies and
//                            N AccountantUsers.
//
//   AccountantUser         — login record. owner | approver | editor | viewer.
//                            Owner role is special: exactly one per org,
//                            cannot be demoted.
//
//   AccountantInvite       — pending invite token (email + role). Created
//                            when an owner invites a new email. The invitee
//                            uses the token to set their password.
//
//   ApprovalRequest        — generic pending-change tracker. When an Editor
//                            tries a privileged action, instead of doing it,
//                            we create an ApprovalRequest. An Owner/Approver
//                            reviews and either executes or rejects.
//
// Design notes:
//
// - Why a separate User model instead of reusing the existing Employee?
//   The Employee table is HR-centric (joining date, salary, leaves). Mixing
//   in tenant-scoped accountant access would entangle two concerns. A
//   separate AccountantUser collection keeps the accountant module
//   self-contained and avoids cascading changes through HR.
//
// - Why ApprovalRequest carries a JSON payload instead of an entity ref?
//   The change might be a *create* (no entity yet exists), an *edit* (we
//   want to capture the diff, not the final state), or a *delete*. A JSON
//   payload with { kind, action, target, payload } handles all three.
// =============================================================================

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

// ─────────────────────────────────────────────────────────────────────────────
// AccountantOrganization — the tenant
// ─────────────────────────────────────────────────────────────────────────────
const accountantOrganizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // The displayed organization name. For a single-owner setup like GRAV,
    // this is just the firm/company name. For an accountant servicing
    // multiple clients, this is the accounting firm's name.

    ownerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantUser",
    },
    // Set after the owner user is created (chicken-and-egg: org is created
    // first, then owner user, then this back-reference is filled in).

    tallyCompanyIds: [
      { type: mongoose.Schema.Types.ObjectId, ref: "TallyCompany" },
    ],
    // Which TallyCompanies this org has access to. When a request comes in,
    // the requested `companyId` must be in this array, else 403.

    settings: {
      requireApprovalForVouchers: { type: Boolean, default: true },
      requireApprovalForLedgerEdits: { type: Boolean, default: true },
      requireApprovalForCustomerEdits: { type: Boolean, default: false },
      // Owner-configurable: which kinds of changes need approval. Always
      // true for Editors; Approvers + Owners bypass these.
    },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: "accountant_organizations" },
);

// ─────────────────────────────────────────────────────────────────────────────
// AccountantUser — the login record
// ─────────────────────────────────────────────────────────────────────────────
const ROLES = ["owner", "approver", "editor", "viewer"];

const accountantUserSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantOrganization",
      required: true,
      index: true,
    },

    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },

    passwordHash: { type: String, required: true },

    role: { type: String, enum: ROLES, required: true, index: true },
    // owner    — single per org; full power; can invite/remove users
    // approver — can do anything an editor can; also approves submissions
    // editor   — can create + edit; submissions need approval to take effect
    // viewer   — read-only across the org's data

    isActive: { type: Boolean, default: true },

    lastLoginAt: { type: Date },

    // Audit
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "AccountantUser" },
  },
  { timestamps: true, collection: "accountant_users" },
);

accountantUserSchema.index({ organizationId: 1, email: 1 }, { unique: true });

// Helpers
accountantUserSchema.methods.setPassword = async function (plain) {
  if (!plain || plain.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  this.passwordHash = await bcrypt.hash(plain, 10);
};

accountantUserSchema.methods.checkPassword = function (plain) {
  return bcrypt.compare(plain || "", this.passwordHash || "");
};

// Convenience: what the user is allowed to do at the broadest level.
// Routes can then make finer-grained decisions.
accountantUserSchema.methods.permissions = function () {
  const p = {
    canView: true,
    canEdit: false,
    canPostDirectly: false, // create vouchers in 'posted' state without approval
    canApprove: false,
    canManageTeam: false,
    canManageSettings: false,
  };
  if (this.role === "owner") {
    p.canEdit =
      p.canPostDirectly =
      p.canApprove =
      p.canManageTeam =
      p.canManageSettings =
        true;
  } else if (this.role === "approver") {
    p.canEdit = p.canPostDirectly = p.canApprove = true;
  } else if (this.role === "editor") {
    p.canEdit = true;
  }
  // viewer: defaults only
  return p;
};

// ─────────────────────────────────────────────────────────────────────────────
// AccountantInvite — pending invitation token
// ─────────────────────────────────────────────────────────────────────────────
// When an owner adds an email, we create an invite. The invitee receives
// the URL `/accountant/accept-invite?token=...` and uses it to set their
// password. Token is single-use, expires in 7 days. Once accepted, an
// AccountantUser record is created and the invite is marked consumed.

const accountantInviteSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantOrganization",
      required: true,
      index: true,
    },

    email: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    role: {
      type: String,
      enum: ["approver", "editor", "viewer"],
      required: true,
    },

    token: { type: String, required: true, unique: true, index: true },
    // Random 32-byte hex. Sent in the accept-invite URL.

    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantUser",
      required: true,
    },

    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date },
    consumedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantUser",
    },

    // For the case where email-sending isn't wired up: the owner can read
    // back the URL from the team page and share it manually.
  },
  { timestamps: true, collection: "accountant_invites" },
);

// ─────────────────────────────────────────────────────────────────────────────
// ApprovalRequest — generic pending-change tracker
// ─────────────────────────────────────────────────────────────────────────────
// Captures a change that needs review before taking effect. The payload is
// a free-form object describing what should happen if approved.
//
// Shape conventions:
//
//   kind:    "voucher" | "ledger" | "customer" | "setting" | "team_action"
//   action:  "create" | "update" | "delete" | "post"
//   target:  { collection: "TallyVoucher", id: "..."}  // optional — null for creates
//   payload: { ... } — the full request body for create/update; the entity
//                       ID for delete; the new status for post
//
// On approve, the API for `kind`+`action` is invoked server-side to apply
// the change. On reject, no change happens; the ApprovalRequest is marked
// rejected with an optional reason.

const approvalRequestSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantOrganization",
      required: true,
      index: true,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TallyCompany",
      index: true,
    },

    kind: { type: String, required: true, index: true },
    action: { type: String, required: true },

    title: { type: String, required: true },
    // Short human-readable summary shown in the approvals list, e.g.
    // "Create contra voucher CN/2627/00012 ₹50,000 Cash → ICICI"

    target: {
      collection: { type: String },
      id: { type: mongoose.Schema.Types.ObjectId },
    },

    payload: { type: mongoose.Schema.Types.Mixed },
    // The body that would have been sent if the change were applied directly.

    diff: { type: mongoose.Schema.Types.Mixed },
    // Optional — for `update` actions, a {before, after, fields} snapshot
    // helps the approver see what's changing. Generated by the route that
    // intercepts the would-be edit.

    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled"],
      default: "pending",
      index: true,
    },

    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantUser",
      required: true,
    },
    requestedByName: { type: String },

    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "AccountantUser" },
    reviewedByName: { type: String },
    reviewedAt: { type: Date },
    reviewNote: { type: String, trim: true },

    appliedResultId: { type: mongoose.Schema.Types.ObjectId },
    // After approval, if the resulting entity has an ID, store it here so
    // the approver can click through to see what was created.
  },
  { timestamps: true, collection: "accountant_approval_requests" },
);

approvalRequestSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
const AccountantOrganization =
  mongoose.models.AccountantOrganization ||
  mongoose.model("AccountantOrganization", accountantOrganizationSchema);

const AccountantUser =
  mongoose.models.AccountantUser ||
  mongoose.model("AccountantUser", accountantUserSchema);

const AccountantInvite =
  mongoose.models.AccountantInvite ||
  mongoose.model("AccountantInvite", accountantInviteSchema);

const ApprovalRequest =
  mongoose.models.ApprovalRequest ||
  mongoose.model("ApprovalRequest", approvalRequestSchema);

module.exports = {
  AccountantOrganization,
  AccountantUser,
  AccountantInvite,
  ApprovalRequest,
  ROLES,
};
