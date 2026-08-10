// models/Access/AccessDepartment.js
//
// A department, as an admin-managed row rather than a hardcoded branch.
//
// WHY THIS EXISTS
// ---------------
// Until now a "department" was a mongoose model plus a rung in the 12-deep
// if/else ladder in routes/login.js, plus a literal in a redirect map, plus a
// case in a verify switch. Adding one meant editing all four. This collection
// replaces that: a department is a row, and login resolves it by lookup.
//
// WHY IT DOES NOT REPLACE THE 12 MODELS
// -------------------------------------
// 117 ObjectId refs across the codebase point at HRDepartment, ProjectManager,
// SalesDepartment, Acc_Department and StoreDepartment — createdBy, approvedBy,
// updatedBy on payroll, vouchers, purchase orders, leave approvals. Six more
// columns store mongoose MODEL NAMES as string data inside live documents
// (MRF.refPath, WorkOrder.refPath, CustomerRequest.refPath). Deleting or
// re-keying those models would resolve every one of those to null, silently.
//
// So the legacy collections stay exactly where they are and keep their _ids.
// This collection sits beside them and holds the things that were previously
// hardcoded: the display name, the icon, the dashboard path, and — critically —
// the FROZEN legacy role strings that ~270 authorization checks still compare
// against.
//
// NOT NAMED "Department": that mongoose model name is already taken by
// models/HR_Models/Departments.js and referenced from Employee.js. Registering
// a second one throws OverwriteModelError at boot.

const mongoose = require("mongoose");

const accessDepartmentSchema = new mongoose.Schema(
  {
    // Stable machine key. Never changes, never shown to users, safe to compare
    // in code. The admin can rename `name` and re-slug freely without breaking
    // anything that keys off this.
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      immutable: true,
    },

    // URL segment and token claim: /onboarding/<slug>, deptSlug in the JWT.
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^[a-z0-9-]+$/, "Slug may contain only lowercase letters, digits and hyphens"],
    },

    // Admin-editable display name — the one thing everyone expected to be
    // editable and which was previously a string literal in a redirect map.
    name: { type: String, required: true, trim: true },

    description: { type: String, trim: true },

    // Shown as the tile on /onboarding.
    iconUrl: { type: String, trim: true },
    iconAlt: { type: String, trim: true },
    // Fallback tile styling when no icon has been uploaded yet, so a freshly
    // created department still looks deliberate rather than broken.
    accentColor: { type: String, trim: true, default: "#4F46E5" },

    // Where a successful login lands. Seeded departments keep their existing
    // bespoke dashboards; new ones default to the generic shell at /d/<slug>.
    dashboardPath: { type: String, required: true, trim: true },
    loginRedirect: { type: String, trim: true },

    // Set only on the "cowork" department. CoWork is a separate app on its own
    // origin (dev port varies, prod is cowork.grav.in), so onboarding cannot
    // route to it with a Next.js path the way every other department does —
    // it needs a real base URL to hand the browser off to after the SSO
    // bridge mints a token. Admin-editable so a dev/staging/prod URL doesn't
    // need a code change; see routes/auth/deptAuth.js's cowork-sso route.
    externalBaseUrl: { type: String, trim: true },

    // Whether the tile appears on the public onboarding page. Off for the
    // platform-admin row, and useful for staging a department before anyone
    // can see it.
    showOnOnboarding: { type: Boolean, default: true },

    sortOrder: { type: Number, default: 100 },

    // Forward-looking. The long-term replacement for role-string comparisons:
    // a route asks "does this user have capability X" rather than "is this
    // user's role literally 'hr_manager'". Empty for the seeded 12 — they are
    // still gated by legacyRole below.
    capabilities: { type: [String], default: [] },

    // True for the 12 departments that existed before this table. Protects
    // them from deletion and freezes their legacy bridge fields, because those
    // are load-bearing for authorization everywhere else.
    isSystem: { type: Boolean, default: false },

    isActive: { type: Boolean, default: true },

    /* ── LEGACY BRIDGE ────────────────────────────────────────────────────
     * These are what let this migration happen without touching ~270
     * authorization checks. The token issued for a seeded department carries
     * `legacyRole` as its `role` claim, so every existing comparison —
     * SalesAuthMiddlewear's ALLOWED_ROLES, the ten copy-pasted ceoAuth arrays,
     * the nineteen `role !== "hr_manager"` gates in payroll — keeps working
     * unchanged on day one.
     *
     * Immutable in the admin UI for isSystem rows. Editing them would silently
     * revoke access across the app with no error anywhere.
     * ------------------------------------------------------------------- */
    legacyModel: { type: String, trim: true },       // "HRDepartment" | … | "Acc_Department"
    legacyCollection: { type: String, trim: true },  // "hrdepartments" | … | "acc_departments"
    legacyRole: { type: String, trim: true },        // "hr_manager", "quality_control", …
    legacyUserType: { type: String, trim: true },    // "hr", "cutting-master", …

    // Optional soft link to the HR-managed department list used for employee
    // metadata. Deliberately NOT the same table: HR staff rename those rows
    // freely, and an HR rename must never become an authorization change.
    hrDepartmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Department" },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "DeptUser" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "DeptUser" },
  },
  { timestamps: true },
);

accessDepartmentSchema.index({ isActive: 1, showOnOnboarding: 1, sortOrder: 1 });

/** The shape the public onboarding page is allowed to see. No user data. */
accessDepartmentSchema.methods.toPublicTile = function () {
  return {
    slug: this.slug,
    name: this.name,
    description: this.description || "",
    iconUrl: this.iconUrl || "",
    iconAlt: this.iconAlt || this.name,
    accentColor: this.accentColor,
    sortOrder: this.sortOrder,
    // Where clicking this tile goes. Omitting it made the portal fall back to
    // "/d/<slug>" — the generic shell, which does not exist yet — so an already
    // signed-in user clicking their own department landed on a 404. It is not
    // sensitive: it is a route anyone can already type.
    dashboardPath: this.resolveRedirect(),
    // Set only on a department that opens an external app (CoWork today) via
    // the SSO bridge rather than a switch-department JWT re-mint. The portal
    // uses ITS PRESENCE — not the department's slug or name, which an admin
    // can freely rename ("Co-Workspace", "Team Workspace", anything) — to
    // decide whether a tile takes the SSO branch. Not sensitive: it is the
    // same login-redirect address dashboardPath already exposes for every
    // other department.
    externalBaseUrl: this.externalBaseUrl || "",
  };
};

/** Where a user of this department goes after logging in. */
accessDepartmentSchema.methods.resolveRedirect = function () {
  return this.loginRedirect || this.dashboardPath || `/d/${this.slug}`;
};

module.exports =
  mongoose.models.AccessDepartment ||
  mongoose.model("AccessDepartment", accessDepartmentSchema, "access_departments");
