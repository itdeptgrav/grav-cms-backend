"use strict";

const mongoose = require("mongoose");

const encryptedValueSchema = new mongoose.Schema(
  {
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    keyVersion: { type: Number, required: true, default: 1 },
  },
  { _id: false },
);

const mailConnectionSchema = new mongoose.Schema(
  {
    actorKey: { type: String, required: true },
    provider: { type: String, enum: ["google"], default: "google" },
    email: { type: String, required: true, lowercase: true, trim: true },
    displayName: { type: String, default: "" },
    refreshToken: { type: encryptedValueSchema, required: true, select: false },
    scopes: { type: [String], default: [] },
    connectedAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
  },
  { timestamps: true },
);

mailConnectionSchema.index({ actorKey: 1, provider: 1 }, { unique: true });

module.exports = mongoose.models.MailConnection
  || mongoose.model("MailConnection", mailConnectionSchema);
