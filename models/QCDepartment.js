const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const QCDepartmentSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  email:      { type: String, required: true, unique: true, lowercase: true },
  password:   { type: String, required: true },
  employeeId: { type: String, required: true, unique: true }, // e.g. QC001
  phone:      { type: String, default: "" },
  department: { type: String, default: "Quality Control" },
  role:       { type: String, default: "quality_control" },
  isActive:   { type: Boolean, default: true },
  createdAt:  { type: Date, default: Date.now },
});

QCDepartmentSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

module.exports = mongoose.model("QCDepartment", QCDepartmentSchema);