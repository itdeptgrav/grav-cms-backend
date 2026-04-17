const mongoose = require("mongoose")

const operationGroupSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Group name is required"],
      trim: true,
      unique: true,
    },
    // Letter prefix keyword — operations whose code starts with this letter
    // are automatically assigned to this group. E.g. "S" → codes like SNLS-01, SNS-02
    keyword: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },
    operations: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Operation",
      },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },
  },
  { timestamps: true }
)

module.exports = mongoose.model("OperationGroup", operationGroupSchema)