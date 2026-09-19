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
  /* THE MACHINE THIS SCANNER IS FITTED TO.

     The device sends machineId on every check-in, and the check-update route
     has always tried to store it — both on first registration and on every
     subsequent call. Neither ever worked: the fields were missing from this
     schema, so Mongoose's strict mode dropped the assignments without a word.
     Every record in production came out with no machine on it at all, while
     the code above reads as though it keeps them in sync.

     String, not ObjectId, because the route writes the raw value the device
     sent, and a scanner that has not been assigned to a machine yet sends an
     empty string — which would fail an ObjectId cast and reject the whole
     check-in, taking OTA down for that device. DeviceHeartbeat stores the
     same thing as an ObjectId because its route casts it first. */
  machineId: String,
  machineName: String,

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