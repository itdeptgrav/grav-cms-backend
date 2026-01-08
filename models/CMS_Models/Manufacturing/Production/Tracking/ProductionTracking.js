// models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking.js

const mongoose = require("mongoose");

const barcodeScanSchema = new mongoose.Schema({
    barcodeId: {
        type: String,
        required: true,
        trim: true
    },
    timeStamp: {
        type: Date,
        required: true
    }
}, { _id: true });

const operatorTrackingSchema = new mongoose.Schema({
    operatorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
        required: true
    },
    signInTime: {
        type: Date,
        required: true
    },
    signOutTime: {
        type: Date,
        default: null
    },
    barcodeScans: [barcodeScanSchema]
}, { _id: true });

const machineTrackingSchema = new mongoose.Schema({
    machineId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Machine",
        required: true
    },
    currentOperatorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
        default: null
    },
    operators: [operatorTrackingSchema]
}, { _id: true });

const productionTrackingSchema = new mongoose.Schema({
    date: {
        type: Date,
        required: true,
        index: true
    },
    machines: [machineTrackingSchema]
}, { 
    timestamps: true,
    // Auto-expire documents after 90 days (optional)
    // expireAfterSeconds: 7776000 
});

// Indexes for faster queries
productionTrackingSchema.index({ date: 1 });
productionTrackingSchema.index({ "machines.machineId": 1 });
productionTrackingSchema.index({ "machines.currentOperatorId": 1 });
productionTrackingSchema.index({ "machines.operators.operatorId": 1 });
productionTrackingSchema.index({ "machines.operators.barcodeScans.barcodeId": 1 });

module.exports = mongoose.model("ProductionTracking", productionTrackingSchema);