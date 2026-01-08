// models/HRDepartment.js

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const hrDepartmentSchema = new mongoose.Schema({
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
    required: true
  },
  employeeId: {
    type: String,
    required: true,
    unique: true
  },
  phone: {
    type: String,
    required: true
  },
  department: {
    type: String,
    default: "Human Resources"
  },
  role: {
    type: String,
    default: "hr_manager"
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

/* 🔐 Hash password before save */
hrDepartmentSchema.pre("save", async function () {
  if (!this.isModified("password")) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});



module.exports = mongoose.model("HRDepartment", hrDepartmentSchema);
