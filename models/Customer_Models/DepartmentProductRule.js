// models/Customer_Models/DepartmentProductRule.js
//
// A per-customer, per-department+designation product assignment rule.
// Sales builds one of these on the customer's "Department" tab, picking
// products (each carrying its own genderCategory from StockItem — Male /
// Female / Unisex / Kids). "Save & Assign" fans the gender-appropriate
// subset out to every EmployeeMpc row under this customer that matches the
// department+designation, keyed off each employee's own gender:
//   Male employee   -> products tagged Male or Unisex
//   Female employee -> products tagged Female or Unisex
//
// Draft rules are saved but never touch EmployeeMpc.products until assigned.

const mongoose = require("mongoose");

const ruleProductSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockItem",
      required: true,
    },
    productName: {
      type: String,
      trim: true,
      default: "",
    },
    genderCategory: {
      type: String,
      enum: ["Male", "Female", "Unisex", "Kids", ""],
      default: "",
    },
  },
  { _id: false },
);

const departmentProductRuleSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      index: true,
      required: true,
    },

    department: {
      type: String,
      trim: true,
      required: true,
    },

    designation: {
      type: String,
      trim: true,
      required: true,
    },

    products: [ruleProductSchema],

    status: {
      type: String,
      enum: ["draft", "assigned"],
      default: "draft",
    },

    lastAssignedAt: Date,
    lastAssignedCount: {
      type: Number,
      default: 0,
    },

    createdBy: mongoose.Schema.Types.ObjectId,
    createdByName: { type: String, trim: true, default: "" },
    updatedBy: mongoose.Schema.Types.ObjectId,
  },
  { timestamps: true },
);

departmentProductRuleSchema.index(
  { customerId: 1, department: 1, designation: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } },
);

module.exports = mongoose.model(
  "DepartmentProductRule",
  departmentProductRuleSchema,
);
