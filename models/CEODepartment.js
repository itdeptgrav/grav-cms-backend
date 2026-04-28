const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const CEODepartmentSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  email:      { type: String, required: true, unique: true, lowercase: true },
  password:   { type: String, required: true },
  employeeId: { type: String, required: true, unique: true }, // e.g. CEO001
  phone:      { type: String, default: "" },
  department: { type: String, default: "Executive Office" },
  role:       { type: String, default: "ceo" },
  isActive:   { type: Boolean, default: true },
  createdAt:  { type: Date, default: Date.now },
});

CEODepartmentSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

module.exports = mongoose.model("CEODepartment", CEODepartmentSchema);