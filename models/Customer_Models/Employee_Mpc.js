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

  // Product assignments (replacing department/designation)
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

module.exports = mongoose.model("EmployeeMpc", employeeMpcSchema);