"use strict";

const mongoose = require("mongoose");

const participantSchema = new mongoose.Schema(
  {
    actorKey: { type: String, required: true },
    employeeId: { type: String, required: true },
    name: { type: String, required: true },
    email: { type: String, default: "" },
  },
  { _id: false },
);

const internalMailThreadSchema = new mongoose.Schema(
  {
    // Missing means `mail` for rows created before Chat existed. Keeping both
    // purposes in this collection avoids another Atlas collection while every
    // read still applies an explicit purpose boundary.
    purpose: { type: String, enum: ["mail", "chat"], default: "mail", index: true },
    subject: { type: String, required: true, trim: true, maxlength: 180 },
    participants: { type: [participantSchema], required: true },
    participantKeys: { type: [String], required: true, index: true },
    lastMessageAt: { type: Date, required: true, default: Date.now, index: true },
    lastMessagePreview: { type: String, default: "", maxlength: 240 },
    unreadFor: { type: [String], default: [] },
    archivedFor: { type: [String], default: [] },
    deletedFor: { type: [String], default: [] },
  },
  { timestamps: true },
);

internalMailThreadSchema.index({ participantKeys: 1, lastMessageAt: -1 });
internalMailThreadSchema.index({ purpose: 1, participantKeys: 1, lastMessageAt: -1 });

module.exports = mongoose.models.InternalMailThread
  || mongoose.model("InternalMailThread", internalMailThreadSchema);
