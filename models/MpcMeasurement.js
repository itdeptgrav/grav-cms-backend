// models/MpcMeasurement.js

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const mpcMeasurementSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    password: {
      type: String,
      required: true
    },
    name: {
      type: String,
      default: "MPC Measurement"
    },
    role: {
      type: String,
      default: "mpc-measurement"
    },
    department: {
      type: String,
      default: "MPC Measurement"
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

/* 🔐 Hash password before save */
mpcMeasurementSchema.pre("save", async function () {
  if (!this.isModified("password")) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

module.exports = mongoose.model("MpcMeasurement", mpcMeasurementSchema);
