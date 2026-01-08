// models/SalesDepartment.js

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const salesDepartmentSchema = new mongoose.Schema({
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
    default: "Sales"
  },
  role: {
    type: String,
    default: "sales"
  },
  isActive: {
    type: Boolean,
    default: true
  },
  salesTarget: {
    type: Number,
    default: 0
  },
  commissionRate: {
    type: Number,
    default: 5, // percentage
    min: 0,
    max: 100
  },
  salesRegion: {
    type: String,
    default: "General"
  },
  performanceMetrics: {
    totalSales: {
      type: Number,
      default: 0
    },
    completedOrders: {
      type: Number,
      default: 0
    },
    pendingOrders: {
      type: Number,
      default: 0
    },
    customerSatisfaction: {
      type: Number,
      default: 0,
      min: 0,
      max: 5
    }
  }
}, { timestamps: true });

/* 🔐 Hash password before save */
salesDepartmentSchema.pre("save", async function () {
  if (!this.isModified("password")) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

module.exports = mongoose.model("SalesDepartment", salesDepartmentSchema);