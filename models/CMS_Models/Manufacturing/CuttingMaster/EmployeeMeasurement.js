const mongoose = require("mongoose");

const employeeMeasurementSchema = new mongoose.Schema({
    employeeId: { type: String, required: true },
    workOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder", required: true },
    measurements: [{
        measurementName: { type: String, required: true },
        value: { type: Number, required: true },
        unit: { type: String, default: "inches" }
    }],
    designatedGroup: { type: String, default: "chest" }, // Which measurement determines size selection
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

employeeMeasurementSchema.index({ employeeId: 1, workOrderId: 1 }, { unique: true });

module.exports = mongoose.model("EmployeeMeasurement", employeeMeasurementSchema);