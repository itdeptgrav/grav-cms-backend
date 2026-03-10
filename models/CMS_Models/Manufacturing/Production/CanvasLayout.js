// models/CMS_Models/Manufacturing/Production/CanvasLayout.js
const mongoose = require("mongoose");

const MachinePositionSchema = new mongoose.Schema({
  machineId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Machine",
    required: true,
  },
  machineName: { type: String },
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  templateId: { type: String, default: "main" }, 
  hidden: { type: Boolean, default: false },
});

const SeparatorSchema = new mongoose.Schema({
  id: { type: String, required: true },
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  templateId: { type: String, default: "main" },
});

const ChamberTemplateSchema = new mongoose.Schema({
  id: { type: String, required: true }, 
  name: { type: String, required: true },
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  width: { type: Number, default: 300 },
  height: { type: Number, default: 250 },
  color: { type: String, default: "#EFF6FF" }, 
  borderColor: { type: String, default: "#3B82F6" },
});

const CanvasLayoutSchema = new mongoose.Schema(
  {
    organizationId: {
      type: String,
      default: "default",
    },
    machinePositions: [MachinePositionSchema],
    separators: [SeparatorSchema],
    chamberTemplates: [ChamberTemplateSchema],
    canvasState: {
      zoom: { type: Number, default: 1 },
      panX: { type: Number, default: 0 },
      panY: { type: Number, default: 0 },
    },
    lastUpdatedBy: { type: String },
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CanvasLayout", CanvasLayoutSchema);