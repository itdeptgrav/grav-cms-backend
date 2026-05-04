"use strict";
const mongoose = require("mongoose");

const appVersionSchema = new mongoose.Schema(
  {
    version: { type: String, required: true },
    fileName: { type: String, required: true },
    fileSize: { type: Number, default: 0 },
    driveFileId: { type: String, required: true },
    driveViewUrl: { type: String },
    driveDownloadUrl: { type: String },
    releaseNotes: { type: String, default: "" },
    isLatest: { type: Boolean, default: false },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
    uploadedByName: { type: String, default: "HR" },
    downloadCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

appVersionSchema.index({ version: 1 });
appVersionSchema.index({ isLatest: 1 });

module.exports = mongoose.model("AppVersion", appVersionSchema);
