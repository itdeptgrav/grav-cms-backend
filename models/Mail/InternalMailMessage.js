"use strict";

const mongoose = require("mongoose");

const internalMailMessageSchema = new mongoose.Schema(
  {
    threadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InternalMailThread",
      required: true,
      index: true,
    },
    senderKey: { type: String, required: true },
    senderEmployeeId: { type: String, required: true },
    senderName: { type: String, required: true },
    body: { type: String, required: true, maxlength: 100000 },
  },
  { timestamps: true },
);

internalMailMessageSchema.index({ threadId: 1, createdAt: 1 });

module.exports = mongoose.models.InternalMailMessage
  || mongoose.model("InternalMailMessage", internalMailMessageSchema);
