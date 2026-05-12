// models/Accountant_model/SetuConsent.js
//
// Standalone model for Setu AA consent records. Lives in its own collection
// so it doesn't depend on whatever schema constraints AccountantSettings has.
// One document per bank account that has been (or is being) connected via Setu.
//
// Why separate from AccountantSettings: that singleton's schema may not
// declare a `bankConnectors` field, which would cause Mongoose to silently
// strip it on save. A dedicated collection avoids that issue and is also
// cleaner — consent state is operational data, not configuration.

const mongoose = require("mongoose");

const setuConsentSchema = new mongoose.Schema(
  {
    // Bank account number (matches what's in AccountantSettings.bankAccounts[].accountNumber)
    bankAccount: { type: String, required: true, index: true, unique: true },

    // Setu's consent ID — unique handle returned by /v2/consents
    consentId: { type: String, required: true, index: true },

    // Setu URL where the user goes to approve the consent
    consentUrl: { type: String, required: true },

    // Customer's mobile (used by Setu for AA handle discovery)
    customerMobile: { type: String },

    // High-level status: consent_pending | active | revoked | error
    status: { type: String, default: "consent_pending" },

    // Most recent FI session details (set after a sync runs)
    lastSyncAt: { type: Date },
    lastReadyAt: { type: Date },
    pendingSessionId: { type: String },

    // Free-form bag for anything else we want to record
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

const SetuConsent =
  mongoose.models.SetuConsent ||
  mongoose.model("SetuConsent", setuConsentSchema);

module.exports = SetuConsent;
