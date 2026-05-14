// models/sopmodel/sop_model.js

const mongoose = require("mongoose");

const sopSchema = new mongoose.Schema(
    {
        name: { type: String, trim: true },
        points: { type: Number, min: 0.5 },
        description: { type: String, trim: true },
        department: { type: String, trim: true },

        // Who created
        createdBy: { type: String }, // employeeId e.g. GR001
        createdByName: { type: String },
        createdByRole: { type: String },

        // Folder grouping
        folderId: { type: mongoose.Schema.Types.ObjectId, ref: "SopFolder", default: null },
        folderName: { type: String, default: "Uncategorized" },

        // Approval
        status: {
            type: String,
            enum: ["approved", "pending", "rejected"],
            default: "pending",
        },
        approvedBy: { type: String, default: null },
        approvedByName: { type: String, default: null },
        approvedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

sopSchema.index({ department: 1, status: 1 });
sopSchema.index({ createdBy: 1 });

module.exports = mongoose.model("Sop", sopSchema);