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

// Pre-save middleware to calculate stats
measurementSchema.pre("save", function (next) {
    // Calculate employee stats
    const uniqueEmployeeIds = new Set();
    this.employeeMeasurements.forEach(emp => {
        uniqueEmployeeIds.add(emp.employeeId.toString());
    });
    
    this.totalRegisteredEmployees = this.registeredEmployeeIds.length;
    this.measuredEmployees = uniqueEmployeeIds.size;
    this.pendingEmployees = this.totalRegisteredEmployees - this.measuredEmployees;

    // Calculate measurement completion
    let totalMeasurementFields = 0;
    let completedMeasurementFields = 0;

    this.employeeMeasurements.forEach(emp => {
        emp.stockItems.forEach(stockItem => {
            const itemFields = stockItem.measurements.length;
            totalMeasurementFields += itemFields;
            
            const completedFields = stockItem.measurements.filter(m => 
                m.value && m.value.trim() !== ""
            ).length;
            completedMeasurementFields += completedFields;
        });
    });

    this.totalMeasurements = totalMeasurementFields;
    this.completedMeasurements = completedMeasurementFields;
    this.pendingMeasurements = totalMeasurementFields - completedMeasurementFields;

    // Calculate completion rates
    if (this.totalRegisteredEmployees > 0) {
        const employeeCompletionRate = Math.round((this.measuredEmployees / this.totalRegisteredEmployees) * 100);
        const measurementCompletionRate = totalMeasurementFields > 0 
            ? Math.round((completedMeasurementFields / totalMeasurementFields) * 100) 
            : 0;
        
        this.completionRate = Math.round((employeeCompletionRate + measurementCompletionRate) / 2);
    }

});

module.exports = mongoose.model("Measurement", measurementSchema);