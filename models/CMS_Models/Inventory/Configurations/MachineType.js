const mongoose = require("mongoose")

const machineTypeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Machine type name is required"],
      trim: true,
      unique: true,
    },
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

module.exports = mongoose.model("MachineType", machineTypeSchema)