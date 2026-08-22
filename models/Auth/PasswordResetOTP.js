// models/Auth/PasswordResetOTP.js
//
// One in-flight forgot-password reset per email, for the main CMS login
// (department accounts, employees, and accounting-only users — everyone
// routes/auth/deptAuth.js's /login can authenticate). Deliberately its OWN
// small collection rather than a `passwordResetOTP` subdocument bolted onto
// DeptUser/Employee/Acc_User/every legacy department model: the identity that
// requested a reset isn't known to be any ONE of those until the email is
// looked up, and a shared collection means routes/auth/passwordReset.js never
// has to touch a dozen different schemas to add this feature.
//
// TTL index on `expiresAt` — Mongo drops the document itself once the code has
// expired, so there is nothing to cron.

const mongoose = require("mongoose");

const passwordResetOTPSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    otpHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    // Which identity kind the email resolved to at request time ("dept",
    // "employee", "accountant", "legacy") plus enough to re-find it without a
    // second full resolution pass — read by reset-password so the account a
    // code was issued for is the one whose password actually changes, even if
    // something about the lookup were to change between the two requests.
    identityKind: { type: String, trim: true },
    identityId: { type: mongoose.Schema.Types.ObjectId },
    legacyUserType: { type: String, trim: true },
  },
  { timestamps: true },
);

passwordResetOTPSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports =
  mongoose.models.PasswordResetOTP ||
  mongoose.model("PasswordResetOTP", passwordResetOTPSchema, "password_reset_otps");
