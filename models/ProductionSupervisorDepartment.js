// models/ProductionSupervisorDepartment.js

const mongoose = require("mongoose");

const productionSupervisorDepartmentSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true },
    email:       { type: String, required: true, unique: true, lowercase: true, trim: true },
    password:    { type: String, required: true },
    employeeId:  { type: String, required: true, unique: true, trim: true },
    phone:       { type: String, trim: true, default: "" },
    role:        { type: String, default: "production_supervisor" },
    department:  { type: String, default: "Production Supervisor" },
    isActive:    { type: Boolean, default: true },
    lastLogin:   { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ProductionSupervisorDepartment", productionSupervisorDepartmentSchema);