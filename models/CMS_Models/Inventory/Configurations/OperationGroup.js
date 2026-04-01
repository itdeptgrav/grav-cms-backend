const mongoose = require("mongoose")

const operationGroupSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Group name is required"],
      trim: true,
      unique: true,
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