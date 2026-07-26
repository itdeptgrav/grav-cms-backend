// models/EmbroideryDepartment.js
//
// Login model for the Embroidery department. Mirrors models/QCDepartment.js
// exactly so routes/login.js can treat it the same way as every other
// department model (findOne by email → bcrypt.compare → sign JWT).
//
// role: "embroidery"  → routes/login.js redirects to /embroidery/dashboard/overview

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const EmbroideryDepartmentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  employeeId: { type: String, required: true, unique: true }, // e.g. EMB001
  phone: { type: String, default: "" },
  department: { type: String, default: "Embroidery" },
  role: { type: String, default: "embroidery" },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

EmbroideryDepartmentSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

module.exports = mongoose.model(
  "EmbroideryDepartment",
  EmbroideryDepartmentSchema,
);
