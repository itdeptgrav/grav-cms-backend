// /models/CuttingMasterDepartment.js

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const cuttingMasterSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    password: {
      type: String,
      required: true,
    },

    name: {
      type: String,
      required: true,
    },

    employeeId: {
      type: String,
      required: true,
      unique: true,
    },

    phone: {
      type: String,
      required: true,
    },

    department: {
      type: String,
      default: "Cutting",
    },

    role: {
      type: String,
      default: "cutting_master",
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

/* 🔐 Hash password before save */
cuttingMasterSchema.pre("save", async function () {
  if (!this.isModified("password")) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

module.exports = mongoose.model("CuttingMasterDepartment", cuttingMasterSchema);
