// models/Access/DeptUser.js
//
// A login account belonging to a department.
//
// THE ONE NON-NEGOTIABLE RULE
// ---------------------------
// `_id` is REUSED VERBATIM from the legacy department document it was seeded
// from. It is never regenerated.
//
// 117 ObjectId refs across the codebase point at the legacy department
// collections — createdBy on payroll runs, approvedBy on vouchers, updatedBy on
// purchase orders. Those refs resolve through mongoose `ref:` declarations that
// still name the legacy models. By keeping the same _id, a single identity is
// addressable from both sides: DeptUser.findById(token.id) and
// HRDepartment.findById(token.id) return the same person. Nothing has to be
// rewritten, and nothing silently resolves to null.
//
// NO pre("save") PASSWORD HOOK — DELIBERATELY
// -------------------------------------------
// Ten of the twelve legacy models hash in a pre-save hook; two do not, and one
// of those has been storing a plaintext password that could never authenticate.
// A hook here would re-hash the already-hashed values carried over by the
// backfill the first time any unrelated field was saved, locking everyone out.
// Hashing is therefore explicit, in the two places that actually set a
// password: admin reset and self-service change. Both go through setPassword().

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const BCRYPT_ROUNDS = 10;

const deptUserSchema = new mongoose.Schema(
  {
    // Not auto-generated on seed — see the header. Left to mongoose only for
    // genuinely new users created through the admin UI.
    _id: { type: mongoose.Schema.Types.ObjectId, auto: true },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    passwordHash: { type: String, required: true },

    name: { type: String, required: true, trim: true },

    // Sparse: MpcMeasurement rows carry no employeeId, and nine models declare
    // it required+unique independently, so collisions across collections are
    // possible and must not block the backfill.
    employeeId: { type: String, trim: true, sparse: true, index: true },

    phone: { type: String, trim: true },

    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccessDepartment",
      required: true,
      index: true,
    },

    // Optional link to the HR employee record for the same human. Kept as a
    // soft link rather than a merge: Employee has no role field, its employeeId
    // is a virtual over biometricId, and it authenticates through a separate
    // cookie and middleware. Unifying those is a separate project.
    employeeRef: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },

    // Platform administrator. Never trusted from the token alone — the
    // middleware re-reads this field from the database on every admin request.
    isAdmin: { type: Boolean, default: false },

    isActive: { type: Boolean, default: true },

    mustChangePassword: { type: Boolean, default: false },

    // Bumped to invalidate every outstanding token for this user. The token
    // carries a copy; verify compares them. This is the revocation capability
    // the system did not have — deactivating someone previously left their
    // 7-day token working until it expired.
    tokenVersion: { type: Number, default: 0 },

    lastLogin: { type: Date },
    lastLoginIp: { type: String, trim: true },

    // Failed-attempt throttling. The old login had none.
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date },

    // Department-specific extras carried over from the legacy documents that
    // had them (Sales targets and commission rates, ProductionSupervisor's
    // lastLogin). Treated as a read-only snapshot: the legacy collection
    // remains the write path for anything that still updates them, because
    // Mixed loses the validation those fields declared.
    profile: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Mirrors of the department's bridge fields, frozen per user so that
    // renaming or re-slugging a department cannot change what a token asserts.
    legacyModel: { type: String, trim: true },
    legacyRole: { type: String, trim: true },

    // Per-user deviations from the department's capability set.
    capabilityOverrides: {
      grant: { type: [String], default: [] },
      deny: { type: [String], default: [] },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "DeptUser" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "DeptUser" },
  },
  { timestamps: true },
);

/* ------------------------------------------------------------------ */
/* Passwords — explicit, never hooked                                  */
/* ------------------------------------------------------------------ */

/** Hash and set a password. The ONLY supported way to change one. */
deptUserSchema.methods.setPassword = async function (plain) {
  if (!plain || String(plain).length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  this.passwordHash = await bcrypt.hash(String(plain), BCRYPT_ROUNDS);
  this.mustChangePassword = false;
  // Every existing session for this user dies with the old password.
  this.tokenVersion += 1;
  this.failedLoginCount = 0;
  this.lockedUntil = undefined;
};

deptUserSchema.methods.verifyPassword = function (plain) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(String(plain || ""), this.passwordHash);
};

/**
 * A hash that no password can ever match.
 *
 * Used by the backfill for rows whose stored "hash" is not bcrypt — one
 * account was seeded with a plaintext password and has never been able to log
 * in. Carrying that plaintext forward would turn a broken account into a
 * credential leak, so it is replaced with random bytes and flagged for reset.
 */
deptUserSchema.statics.unusablePasswordHash = function () {
  return bcrypt.hash(crypto.randomBytes(32).toString("hex"), BCRYPT_ROUNDS);
};

/** Does a stored value look like something bcrypt.compare could ever match? */
deptUserSchema.statics.looksLikeBcrypt = function (value) {
  return typeof value === "string" && /^\$2[aby]\$\d{2}\$/.test(value);
};

/* ------------------------------------------------------------------ */
/* Lockout                                                             */
/* ------------------------------------------------------------------ */

const MAX_FAILED = 10;
const LOCK_MINUTES = 15;

deptUserSchema.methods.isLocked = function () {
  return Boolean(this.lockedUntil && this.lockedUntil > new Date());
};

deptUserSchema.methods.registerFailedLogin = async function () {
  this.failedLoginCount = (this.failedLoginCount || 0) + 1;
  if (this.failedLoginCount >= MAX_FAILED) {
    this.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
    this.failedLoginCount = 0;
  }
  await this.save();
};

deptUserSchema.methods.registerSuccessfulLogin = async function (ip) {
  this.failedLoginCount = 0;
  this.lockedUntil = undefined;
  this.lastLogin = new Date();
  if (ip) this.lastLoginIp = ip;
  await this.save();
};

/** Safe representation — never leaks the hash. */
deptUserSchema.methods.toSafeJSON = function () {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    employeeId: this.employeeId || "",
    phone: this.phone || "",
    departmentId: this.departmentId,
    isAdmin: this.isAdmin,
    isActive: this.isActive,
    mustChangePassword: this.mustChangePassword,
    lastLogin: this.lastLogin,
  };
};

module.exports =
  mongoose.models.DeptUser ||
  mongoose.model("DeptUser", deptUserSchema, "dept_users");
