const mongoose = require('mongoose');

const barcodeDeviceSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    unique: true,
    index: true
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

// Index for efficient queries
barcodeDeviceSchema.index({ lastSeen: -1 });
barcodeDeviceSchema.index({ status: 1 });

module.exports = mongoose.model('BarcodeDevice', barcodeDeviceSchema);