const mongoose = require("mongoose");

const employeeMpcSchema = new mongoose.Schema({
  // Customer reference
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

  department: {
    type: String,
    required: true,
    trim: true,
    set: function (value) {
      if (!value) return value;
      return value.trim().split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
    }
  },


  designation: {
    type: String,
    required: true,
    trim: true,
    set: function (value) {
      if (!value) return value;
      return value.trim().split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
    }
  },


  gender: {
    type: String,
    enum: ["Male", "Female", "MALE", "FEMALE", "male", "female"],
    required: true,
    set: function (value) {
      if (!value) return value;
      return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    }
  },


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
employeeMpcSchema.index({ customerId: 1, department: 1 });
employeeMpcSchema.index({ customerId: 1, status: 1 });
employeeMpcSchema.index({ customerId: 1, createdAt: -1 });

// Compound index for unique employee per customer
employeeMpcSchema.index({ customerId: 1, uin: 1 }, { unique: true });

module.exports = mongoose.model("EmployeeMpc", employeeMpcSchema);
