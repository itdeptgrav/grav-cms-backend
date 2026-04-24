// models/PackagingDispatchDepartment.js

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const packagingDispatchSchema = new mongoose.Schema(
  {
    email:      { type: String, required: true, unique: true, lowercase: true, trim: true },
    password:   { type: String, required: true },
    name:       { type: String, required: true },
    employeeId: { type: String, required: true, unique: true },
    phone:      { type: String, required: true },
    department: { type: String, default: "Packaging & Dispatch" },
    role:       { type: String, default: "packaging_dispatch" },
    isActive:   { type: Boolean, default: true },
  },
  { timestamps: true }
);
module.exports = mongoose.model("PackagingDispatchDepartment", packagingDispatchSchema);