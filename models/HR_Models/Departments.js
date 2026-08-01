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
    // Department-level people-in-charge. Assigning these propagates to every
    // employee of the department (their primaryManager/secondaryManager), and
    // new employees created under this department inherit them automatically.
    primaryManager: {
      managerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
        default: null,
      },
      managerName: { type: String, default: "" },
      designation: { type: String, default: "" },
    },
    secondaryManager: {
      managerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
        default: null,
      },
      managerName: { type: String, default: "" },
      designation: { type: String, default: "" },
    },
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
