// models/Accountant_model/Acc_SetuConsent.js
//
// Standalone model for Setu AA consent records. Lives in its own collection
// so it doesn't depend on whatever schema constraints Acc_Settings has.
// One document per bank account that has been (or is being) connected via Setu.
//
// Why separate from Acc_Settings: that singleton's schema may not
// declare a `bankConnectors` field, which would cause Mongoose to silently
// strip it on save. A dedicated collection avoids that issue and is also
// cleaner — consent state is operational data, not configuration.

const mongoose = require("mongoose");

const setuConsentSchema = new mongoose.Schema(
  {
    // Bank account number (matches what's in Acc_Settings.bankAccounts[].accountNumber)
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
  { timestamps: true, collection: "acc_setu_consents" },
);

const Acc_SetuConsent =
  mongoose.models.Acc_SetuConsent ||
  mongoose.model("Acc_SetuConsent", setuConsentSchema);

module.exports = Acc_SetuConsent;
