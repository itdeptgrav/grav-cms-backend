const mongoose = require('mongoose');

const firmwareSchema = new mongoose.Schema({
  version: {
    type: String,
    required: true,
    unique: true
  },
  cloudinaryUrl: {
    type: String,
    required: true
  },
  cloudinaryPublicId: String,
  fileSize: Number,
  description: String,
  isActive: {
    type: Boolean,
    default: true
  },
  releasedAt: {
    type: Date,
    default: Date.now
  },
  targetDevices: [{
    type: String,
    default: 'all' // 'all' means all devices, otherwise specific deviceIds
  }],
  minSupportedVersion: String
}, {
  timestamps: true
});

// Index for version queries
firmwareSchema.index({ version: -1 });
firmwareSchema.index({ isActive: 1, releasedAt: -1 });

module.exports = mongoose.model('Firmware', firmwareSchema);