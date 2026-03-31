// models/Customer_Models/Employee_Mpc.js

const mongoose = require("mongoose");

const productAssignmentSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "StockItem",
    required: true
  },
  variantId: {
    type: mongoose.Schema.Types.ObjectId
  },
  quantity: {
    type: Number,
    required: true,
    min: 1,
    default: 1
  },
  // ── NEW: persist the display name at assignment time ──────────────────────
  // Stores whichever name was shown in the popup when the product was assigned —
  // this is either an additionalName (if the user searched/selected via an alias)
  // or the product's canonical name.  Storing it here means the list view never
  // needs to re-resolve names from the StockItem collection on every page load.
  productName: {
    type: String,
    trim: true,
    default: ""
  }
}, { _id: false });

const employeeMpcSchema = new mongoose.Schema({
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Customer",
    required: true,
    index: true
  },

  name: {
    type: String,
    required: true,
    trim: true
  },

  uin: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true,
    index: true
  },

  gender: {
    type: String,
    enum: ["Male", "Female"],
    required: true,
    set: function (value) {
      if (!value) return value;
      return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    }
  },

  department: {
    type: String,
    trim: true,
    default: ""
  },

  designation: {
    type: String,
    trim: true,
    default: ""
  },

  // Product assignments
  products: [productAssignmentSchema],

  status: {
    type: String,
    enum: ["active", "inactive"],
    default: "active"
  },

  notes: {
    type: String,
    trim: true
  },

  // Audit fields
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Customer"
  },

  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Customer"
  }
}, {
  timestamps: true
});

// Index for better query performance
employeeMpcSchema.index({ customerId: 1, status: 1 });
employeeMpcSchema.index({ customerId: 1, createdAt: -1 });
employeeMpcSchema.index({ customerId: 1, "products.productId": 1 });
employeeMpcSchema.index({ customerId: 1, uin: 1 }, { unique: true });
employeeMpcSchema.index({ customerId: 1, department: 1, designation: 1 });

module.exports = mongoose.model("EmployeeMpc", employeeMpcSchema);