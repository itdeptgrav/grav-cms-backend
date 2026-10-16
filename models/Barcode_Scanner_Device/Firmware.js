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

  /* WHERE THE SCANNERS ACTUALLY FETCH THE BINARY FROM.
   *
   * cloudinaryUrl above points back at whichever of our servers took the
   * upload, which is only reachable if the device happens to be talking to
   * that one - and behind the Cloudflare Tunnel it arrives chunked, with no
   * Content-Length, which the scanner cannot install from at all.
   *
   * This is an object-storage URL: a plain GET, 200, real Content-Length, no
   * redirect, and the same answer no matter which server the device checked
   * in with. Optional, so every record written before this existed still
   * loads and still works off the old path.
   */
  storageUrl: String,
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
  minSupportedVersion: String,

  /* WHICH KIND OF DEVICE THIS BUILD IS FOR (15 Oct 2026).
   *
   * Two firmwares now share the OTA store: the sewing-machine scanner
   * ("machine", the original) and the remote finishing station ("station" —
   * a scanner paired to the Ironing / Trimming dashboard). The same ESP32
   * board runs either, so a build offered to "all" devices would re-flash a
   * station as a machine scanner, or the reverse. check-update offers a
   * build only to devices reporting the same product; records written before
   * this field existed are machine builds. */
  product: {
    type: String,
    enum: ['machine', 'station'],
    default: 'machine'
  }
}, {
  timestamps: true
});

// Index for version queries
firmwareSchema.index({ version: -1 });
firmwareSchema.index({ isActive: 1, releasedAt: -1 });

module.exports = mongoose.model('Firmware', firmwareSchema);