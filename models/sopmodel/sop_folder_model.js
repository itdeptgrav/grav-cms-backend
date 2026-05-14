// models/sopmodel/sop_folder_model.js

const mongoose = require("mongoose");

const sopFolderSchema = new mongoose.Schema(
    {
        name: { type: String, trim: true },
        department: { type: String, trim: true },
        createdBy: { type: String }, // employeeId
        createdByName: { type: String },
        createdByRole: { type: String },
    },
    { timestamps: true }
);

sopFolderSchema.index({ department: 1 });

module.exports = mongoose.model("SopFolder", sopFolderSchema);