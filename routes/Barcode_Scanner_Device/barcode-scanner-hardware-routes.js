const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const BarcodeDevice = require('../../models/Barcode_Scanner_Device/BarcodeDevice');
const Firmware = require('../../models/Barcode_Scanner_Device/Firmware');
const Machine = require('../../models/CMS_Models/Inventory/Configurations/Machine');

// ─── Multer (memory storage → written to disk after validation) ───────────────
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (file.originalname.endsWith('.bin') || file.mimetype === 'application/octet-stream') {
      cb(null, true);
    } else {
      cb(new Error('Only .bin files are allowed'));
    }
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Validate 8-char hex device ID (generated from ESP32 MAC). */
const isValidDeviceId = (id) => /^[0-9a-fA-F]{8}$/.test(id);

/**
 * Look up Machine.name by its _id.
 * Returns the name string on success, or '' if not found / invalid id.
 * Never throws — callers can treat '' as "name unavailable".
 */
const getMachineNameById = async (machineId) => {
  if (!machineId || !mongoose.Types.ObjectId.isValid(machineId)) return '';
  try {
    const machine = await Machine.findById(machineId).select('name').lean();
    return machine?.name ?? '';
  } catch (err) {
    console.error('getMachineNameById error:', err.message);
    return '';
  }
};

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/barcode-devices/name?machineId=<mongoId>
 *
 * Called by the ESP32 firmware once after WiFi connects (and only when
 * the machine name is not already cached in device flash).
 *
 * Query param: machineId — the MongoDB _id of the Machine document.
 * Response:    { machineName: "Cutting Machine 1" }
 *
 * On invalid / unknown machineId the response is still 200 with an
 * empty machineName so the device doesn't get stuck retrying forever.
 */
router.get('/name', async (req, res) => {
  const { machineId } = req.query;

  if (!machineId) {
    return res.status(400).json({
      success: false,
      message: 'machineId query param is required'
    });
  }

  const machineName = await getMachineNameById(machineId);

  if (!machineName) {
    // Return 200 with empty name rather than 404 so the device can
    // display "Not Found" gracefully without treating it as a hard error.
    console.warn(`Machine name not found for machineId: ${machineId}`);
    return res.json({ success: true, machineName: '' });
  }

  console.log(`Machine name resolved: ${machineId} → "${machineName}"`);
  return res.json({ success: true, machineName });
});

/**
 * POST /api/barcode-devices/check-update
 *
 * Called by the device on every WiFi connect and periodically thereafter.
 * Also serves as the device heartbeat / registration endpoint.
 *
 * Body: { deviceId, machineId, currentVersion, ipAddress, wifiSSID }
 */
router.post('/check-update', async (req, res) => {
  try {
    const { deviceId, machineId, currentVersion, ipAddress, wifiSSID } = req.body;

    if (!deviceId || !isValidDeviceId(deviceId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid device ID format'
      });
    }

    // Resolve machine name for this check-update (used to keep the
    // BarcodeDevice record in sync — does NOT change what the firmware
    // caches; that is handled by the /name endpoint above).
    const machineName = await getMachineNameById(machineId);

    // ── Upsert device record ──────────────────────────────────────────
    let device = await BarcodeDevice.findOne({ deviceId });

    if (!device) {
      device = new BarcodeDevice({
        deviceId,
        machineId:   machineId   || '',
        machineName: machineName || '',
        currentFirmwareVersion: currentVersion || '1.0.0',
        lastIpAddress: ipAddress,
        wifiSSID,
        status: 'online',
        firstSeen: new Date()
      });
    } else {
      device.lastSeen   = new Date();
      device.lastIpAddress = ipAddress;
      device.wifiSSID   = wifiSSID;
      device.status     = 'online';

      // Keep machineId / machineName current in case the user
      // reconfigured the device with a new machine assignment.
      if (machineId)   device.machineId   = machineId;
      if (machineName) device.machineName = machineName;

      if (currentVersion) device.currentFirmwareVersion = currentVersion;
    }

    await device.save();

    // ── Firmware update check ─────────────────────────────────────────
    const latestFirmware = await Firmware.findOne({ isActive: true })
      .sort({ releasedAt: -1 });

    let updateAvailable = false;
    let firmwareInfo    = null;

    if (latestFirmware) {
      const shouldUpdate =
        latestFirmware.targetDevices.includes('all') ||
        latestFirmware.targetDevices.includes(deviceId);

      if (shouldUpdate && latestFirmware.version !== device.currentFirmwareVersion) {
        updateAvailable = true;
        const baseUrl   = `https://${req.get('host')}`;
        firmwareInfo    = {
          version:     latestFirmware.version,
          url:         `${baseUrl}/api/barcode-devices/firmware/download/${latestFirmware.version}`,
          fileSize:    latestFirmware.fileSize,
          description: latestFirmware.description
        };
        console.log(`Update available for device ${deviceId}: v${latestFirmware.version}`);
      } else {
        console.log(
          `No update needed for ${deviceId}. ` +
          `Current: ${device.currentFirmwareVersion}, Latest: ${latestFirmware.version}`
        );
      }
    }

    return res.json({
      success: true,
      updateAvailable,
      currentVersion:  device.currentFirmwareVersion,
      machineName,                                       // convenience — device already has this
      ...(firmwareInfo && { firmware: firmwareInfo })
    });

  } catch (error) {
    console.error('Error in check-update:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

/**
 * GET /api/barcode-devices/firmware/download/:version
 * Stream the .bin firmware file to the device.
 */
router.get('/firmware/download/:version', (req, res) => {
  try {
    const { version }    = req.params;
    const firmwarePath   = path.join(__dirname, '../../firmware', `firmware_v${version}.bin`);

    console.log('Firmware download requested:', firmwarePath);

    if (!fs.existsSync(firmwarePath)) {
      console.error('Firmware file not found:', firmwarePath);
      return res.status(404).json({ success: false, message: 'Firmware not found' });
    }

    const stats = fs.statSync(firmwarePath);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename=firmware_v${version}.bin`);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const fileStream = fs.createReadStream(firmwarePath);
    fileStream.pipe(res);
    fileStream.on('error', (err) => {
      console.error('Error streaming firmware:', err);
      // Headers already sent — can't send JSON; just destroy the connection.
      res.destroy();
    });

  } catch (error) {
    console.error('Error in firmware download:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /api/barcode-devices
 * List all registered devices (admin dashboard).
 */
router.get('/', async (_req, res) => {
  try {
    const devices = await BarcodeDevice.find({})
      .sort({ lastSeen: -1 })
      .select('deviceId machineId machineName currentFirmwareVersion lastSeen status wifiSSID firstSeen');

    return res.json({ success: true, devices });
  } catch (error) {
    console.error('Error fetching devices:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /api/barcode-devices/:deviceId
 * Get a single device record.
 */
router.get('/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;

    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ success: false, message: 'Invalid device ID format' });
    }

    const device = await BarcodeDevice.findOne({ deviceId });
    if (!device) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }

    return res.json({ success: true, device });
  } catch (error) {
    console.error('Error fetching device:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * POST /api/barcode-devices/firmware
 * Upload a new firmware .bin file.
 */
router.post('/firmware', upload.single('firmware'), async (req, res) => {
  try {
    const { version, description, targetDevices } = req.body;
    const file = req.file;

    console.log('Firmware upload — version:', version, '| file:', file?.originalname ?? 'none');

    if (!version) {
      return res.status(400).json({ success: false, message: 'Version is required' });
    }
    if (!file) {
      return res.status(400).json({ success: false, message: 'Firmware file is required' });
    }

    // Persist .bin to disk
    const firmwareDir = path.join(__dirname, '../../firmware');
    if (!fs.existsSync(firmwareDir)) fs.mkdirSync(firmwareDir, { recursive: true });

    const filename  = `firmware_v${version}.bin`;
    const filePath  = path.join(firmwareDir, filename);
    fs.writeFileSync(filePath, file.buffer);
    console.log('Firmware saved to:', filePath);

    const baseUrl    = `https://${req.get('host')}`;
    const firmwareUrl = `${baseUrl}/api/barcode-devices/firmware/download/${version}`;

    // Deactivate any existing record with the same version
    await Firmware.updateMany({ version }, { isActive: false });

    let targetDevicesArray = ['all'];
    if (targetDevices) {
      try {
        targetDevicesArray = JSON.parse(targetDevices);
      } catch {
        targetDevicesArray = [targetDevices];
      }
    }

    const firmware = new Firmware({
      version,
      cloudinaryUrl: firmwareUrl,
      fileSize:      file.size,
      description,
      isActive:      true,
      targetDevices: targetDevicesArray,
      releasedAt:    new Date()
    });

    await firmware.save();

    return res.json({
      success: true,
      message: 'Firmware uploaded successfully',
      firmware: { version, url: firmwareUrl, fileSize: file.size, description }
    });

  } catch (error) {
    console.error('Error uploading firmware:', error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

/**
 * GET /api/barcode-devices/firmware/list
 * Return full firmware history for the admin dashboard.
 */
router.get('/firmware/list', async (_req, res) => {
  try {
    const firmwareList = await Firmware.find({})
      .sort({ releasedAt: -1 })
      .select('version cloudinaryUrl fileSize description releasedAt isActive targetDevices');

    return res.json({ success: true, firmwareList });
  } catch (error) {
    console.error('Error fetching firmware list:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;