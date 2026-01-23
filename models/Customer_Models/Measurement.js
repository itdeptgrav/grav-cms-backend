// models/Customer_Models/Measurement.js
const mongoose = require("mongoose");

const measurementValueSchema = new mongoose.Schema({
    measurementName: {
        type: String,
        required: true,
        trim: true
    },
    value: {
        type: String,
        required: true,
        trim: true
    },
    unit: {
        type: String,
        default: "",
        trim: true
    }
}, { _id: false });

// Add this schema for attributes
const attributeSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    value: {
        type: String,
        required: true,
        trim: true
    }
}, { _id: false });

const stockItemMeasurementSchema = new mongoose.Schema({
    stockItemId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "StockItem",
        required: true
    },
    stockItemName: {
        type: String,
        required: true,
        trim: true
    },
    variantId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null
    },
    variantName: {
        type: String,
        default: "Default"
    },
    // ADD THIS: Store attributes array
    attributes: [attributeSchema],
    measurements: [measurementValueSchema],
    measuredAt: {
        type: Date,
        default: Date.now
    }
}, { _id: false });

const employeeMeasurementSchema = new mongoose.Schema({
    employeeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "EmployeeMpc",
        required: true
    },
    employeeName: {
        type: String,
        required: true,
        trim: true
    },
    employeeUIN: {
        type: String,
        required: true,
        trim: true
    },
    department: {
        type: String,
        required: true,
        trim: true
    },
    designation: {
        type: String,
        required: true,
        trim: true
    },
    stockItems: [stockItemMeasurementSchema],
    isCompleted: {
        type: Boolean,
        default: false
    },
    completedAt: {
        type: Date
    }
}, { _id: false });

const measurementSchema = new mongoose.Schema({
    // Organization reference
    organizationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Customer",
        required: true,
        index: true
    },
    organizationName: {
        type: String,
        required: true,
        trim: true
    },

    // Measurement metadata
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        trim: true
    },

    // Track which employees are registered for this measurement
    registeredEmployeeIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "EmployeeMpc"
    }],

    // Employee measurements
    employeeMeasurements: [employeeMeasurementSchema],

    // Status tracking
    totalRegisteredEmployees: {
        type: Number,
        default: 0
    },
    measuredEmployees: {
        type: Number,
        default: 0
    },
    pendingEmployees: {
        type: Number,
        default: 0
    },
    completionRate: {
        type: Number,
        default: 0
    },

    // Counts
    totalMeasurements: {
        type: Number,
        default: 0
    },
    completedMeasurements: {
        type: Number,
        default: 0
    },
    pendingMeasurements: {
        type: Number,
        default: 0
    },

    convertedToPO: {
        type: Boolean,
        default: false
    },
    poRequestId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "CustomerRequest",
        default: null
    },
    poConversionDate: {
        type: Date
    },
    convertedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ProjectManager"
    },

    // Audit fields
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ProjectManager",
        required: true
    },
    updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ProjectManager"
    }
}, {
    timestamps: true
});

// Indexes for better query performance
measurementSchema.index({ organizationId: 1, createdAt: -1 });
measurementSchema.index({ organizationId: 1, completionRate: 1 });
measurementSchema.index({ "employeeMeasurements.employeeId": 1 });
measurementSchema.index({ "employeeMeasurements.stockItems.variantId": 1 });

module.exports = mongoose.model("Measurement", measurementSchema);