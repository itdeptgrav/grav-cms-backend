// models/sopmodel/sop_folder_model.js

const mongoose = require("mongoose");

const sopFolderSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        department: { type: String, required: true, trim: true },
        createdBy: { type: String, required: true }, // employeeId
        createdByName: { type: String, required: true },
        createdByRole: { type: String, enum: ["ceo", "tl"], required: true },
    },
    { timestamps: true }
);

sopFolderSchema.index({ department: 1 });

module.exports = mongoose.model("SopFolder", sopFolderSchema);