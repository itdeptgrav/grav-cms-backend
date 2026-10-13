"use strict";

const mongoose = require("mongoose");

const mailOAuthAttemptSchema = new mongoose.Schema(
  {
    stateHash: { type: String, required: true, unique: true },
    actorKey: { type: String, required: true },
    returnPath: { type: String, default: "/mail/settings" },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.models.MailOAuthAttempt
  || mongoose.model("MailOAuthAttempt", mailOAuthAttemptSchema);
