const mongoose = require('mongoose');

const barcodeDeviceSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  // The MongoDB _id of the Machine document — set by the user during
  // device configuration and sent with every check-update call.
  machineId: {
    type: String,
    default: ''
  },
  // Cached copy of Machine.name, populated/refreshed on check-update
  // so the admin dashboard doesn't need a separate join.
  machineName: {
    type: String,
    default: ''
  },
  currentFirmwareVersion: {
    type: String,
    default: '1.0.0'
  },
  lastSeen: {
    type: Date,
    default: Date.now
  },
  lastIpAddress: String,
  wifiSSID: String,
  status: {
    type: String,
    enum: ['online', 'offline', 'configuring'],
    default: 'offline'
  },
  firstSeen: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

barcodeDeviceSchema.index({ lastSeen: -1 });
barcodeDeviceSchema.index({ status: 1 });
barcodeDeviceSchema.index({ machineId: 1 });

module.exports = mongoose.model('BarcodeDevice', barcodeDeviceSchema);