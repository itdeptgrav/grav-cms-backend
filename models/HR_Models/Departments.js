const mongoose = require("mongoose");

const departmentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    designations: [
      {
        name: {
          type: String,
          required: true,
          trim: true,
        },
        isActive: {
          type: Boolean,
          default: true,
        },
        // Managers for this specific designation
        managers: [
          {
            departmentId: {
              type: mongoose.Schema.Types.ObjectId,
              ref: "Department",
              required: true,
            },
            departmentName: {
              type: String,
              required: true,
            },
            designationName: {
              type: String,
              required: true,
            },
          },
        ],
      },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRDepartment",
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRDepartment",
    },
  },
  {
    timestamps: true,
  },
);

// Indexes
departmentSchema.index({ name: 1 });
departmentSchema.index({ status: 1 });
departmentSchema.index({ "designations.name": 1 });

module.exports = mongoose.model("Department", departmentSchema);
